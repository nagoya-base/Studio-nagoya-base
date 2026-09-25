/*
 * StripeGateway.gs — Stripe REST API（Checkout Session）へのUrlFetchApp呼び出しだけを
 * 責務とする薄いラッパー（Issue #341 PR-B）。金額の正当性検証・冪等性の判断・台帳更新は
 * 一切行わない（それぞれCardPayment.gs / BookingRepository.gsの責務）。
 *
 * - APIキー（stripeConfig.secretKey）はここでもLogger.log等へ絶対に出力しない。
 * - すべての呼び出しはmuteHttpExceptions:trueで行い、Stripe側の4xx/5xxをUrlFetchAppの例外
 *   ではなくレスポンスとして受け取り、呼び出し元が状況を判別できるようにする。
 * - 戻り値は常に { ok: true, session: {...} } または
 *   { ok: false, errorType, message, httpStatus?, stripeErrorCode? } の形。errorTypeは
 *   呼び出し元（BookingRepository.gs）が「新しいSessionを発行してよいか」を判断するために
 *   使う一次分類であり、Stripe側のエラーコードそのものではない:
 *   - 'NOT_CONFIGURED': secretKey未設定。Stripeへは到達していない。
 *   - 'INVALID_REQUEST': そもそも呼び出し側の指定が不正（sessionId未指定等）。Stripeへは
 *     到達していない。
 *   - 'NETWORK': UrlFetchApp.fetch自体が例外を投げた（タイムアウト・DNS等）。Stripe側で
 *     実際に処理が行われたかどうかは不明（Idempotency-Keyでの安全な再試行が前提）。
 *   - 'STRIPE_ERROR': Stripeが4xxの応答を明確に返した（リクエスト自体が拒否された）。
 *     この回のリクエストが処理されていないことが確定しているケース。
 *   - 'AMBIGUOUS': Stripeが5xx・レート制限・解析不能な応答を返した。処理された可能性を
 *     否定できないため、呼び出し元は無条件に新しい決済試行を発行してはならない。
 */
'use strict';

var StripeGateway = (function () {
  var API_BASE_ = 'https://api.stripe.com/v1';

  function encodeFormPayload_(payload) {
    return Object.keys(payload)
      .filter(function (key) {
        var value = payload[key];
        return value !== undefined && value !== null && value !== '';
      })
      .map(function (key) {
        return encodeURIComponent(key) + '=' + encodeURIComponent(String(payload[key]));
      })
      .join('&');
  }

  /*
   * 予約1件・カード決済1回ぶんのCheckout Session作成に必要な最小限のline_itemのみを送る
   * （複数商品・数量変更等は本Issueの対象外）。line_items[0][price_data]でその場限りの
   * 商品情報を渡す方式（事前にStripe Dashboard側でProduct/Priceを作成しない）を採用する。
   */
  function buildCreateSessionPayload_(params) {
    var payload = {
      'mode': 'payment',
      'success_url': params.successUrl,
      'cancel_url': params.cancelUrl,
      'expires_at': String(params.expiresAtSeconds),
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': String(params.currency).toLowerCase(),
      'line_items[0][price_data][unit_amount]': String(params.amountJpy),
      'line_items[0][price_data][product_data][name]': params.lineItemName || ('予約 ' + params.bookingId),
      'metadata[bookingId]': params.bookingId,
      'metadata[brand]': params.brand,
      'metadata[paymentAttemptId]': params.paymentAttemptId
    };
    if (params.customerEmail) {
      payload.customer_email = params.customerEmail;
    }
    return payload;
  }

  function classifyHttpError_(responseCode) {
    if (responseCode >= 500 || responseCode === 429) return 'AMBIGUOUS';
    if (responseCode >= 400) return 'STRIPE_ERROR';
    return 'AMBIGUOUS';
  }

  function performRequest_(method, url, secretKey, formPayload, idempotencyKey) {
    var headers = { Authorization: 'Bearer ' + secretKey };
    if (idempotencyKey) {
      headers['Idempotency-Key'] = idempotencyKey;
    }
    var options = {
      method: method,
      headers: headers,
      muteHttpExceptions: true
    };
    if (formPayload !== null && formPayload !== undefined) {
      options.contentType = 'application/x-www-form-urlencoded';
      options.payload = formPayload;
    }

    var response;
    try {
      response = UrlFetchApp.fetch(url, options);
    } catch (networkError) {
      return {
        ok: false,
        errorType: 'NETWORK',
        message: 'Stripe APIへの接続に失敗しました。'
      };
    }

    var code = response.getResponseCode();
    var text = response.getContentText();
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (parseError) {
      parsed = null;
    }

    if (code >= 200 && code < 300) {
      if (!parsed) {
        return { ok: false, errorType: 'AMBIGUOUS', httpStatus: code, message: 'Stripeからの応答を解析できませんでした。' };
      }
      return { ok: true, raw: parsed };
    }

    return {
      ok: false,
      errorType: classifyHttpError_(code),
      httpStatus: code,
      stripeErrorCode: (parsed && parsed.error && parsed.error.code) || '',
      message: (parsed && parsed.error && parsed.error.message) || 'Stripe APIがエラーを返しました。'
    };
  }

  function normalizeSession_(raw) {
    return {
      id: raw.id,
      url: raw.url || '',
      status: raw.status || '',
      paymentStatus: raw.payment_status || '',
      paymentIntentId: typeof raw.payment_intent === 'string' ? raw.payment_intent : ((raw.payment_intent && raw.payment_intent.id) || ''),
      expiresAtSeconds: raw.expires_at
    };
  }

  /*
   * params: { amountJpy, currency, bookingId, brand, paymentAttemptId, expiresAtSeconds,
   *   successUrl, cancelUrl, customerEmail?, lineItemName? }
   * idempotencyKey: 呼び出し元（BookingRepository.reservePaymentAttempt_で発行・永続化済みの
   *   paymentAttemptId）をそのまま渡す。同一キー・同一パラメータでの再試行はStripe側で
   *   重複作成されず、最初に作成したSessionがそのまま返る（Stripeの冪等性保証）。
   */
  function createCheckoutSession(stripeConfig, params, idempotencyKey) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    var payload = buildCreateSessionPayload_(params);
    var result = performRequest_('post', API_BASE_ + '/checkout/sessions', stripeConfig.secretKey, encodeFormPayload_(payload), idempotencyKey);
    if (!result.ok) return result;
    return { ok: true, session: normalizeSession_(result.raw) };
  }

  function retrieveCheckoutSession(stripeConfig, sessionId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!sessionId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripeCheckoutSessionIdが指定されていません。' };
    }
    var url = API_BASE_ + '/checkout/sessions/' + encodeURIComponent(sessionId);
    var result = performRequest_('get', url, stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    return { ok: true, session: normalizeSession_(result.raw) };
  }

  return {
    createCheckoutSession: createCheckoutSession,
    retrieveCheckoutSession: retrieveCheckoutSession
  };
})();
