/*
 * StripeGateway.gs — Stripe REST API（Checkout Session・PaymentIntent）へのUrlFetchApp
 * 呼び出しだけを責務とする薄いラッパー（Issue #341 PR-B。PR-CでretrievePaymentIntentを追加）。
 * 金額の正当性検証・冪等性の判断・台帳更新は一切行わない（それぞれCardPayment.gs /
 * BookingRepository.gs / StripeWebhookHandler.gsの責務）。
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
 *   - 'STRIPE_ERROR': Stripeが`invalid_request_error`/`authentication_error`/
 *     `permission_error`のいずれかを、明確な4xx（409を除く）で返した場合のみ
 *     （CONFIRMED_FAILURE_ERROR_TYPES_参照）。この回のリクエストがStripe側で一切処理
 *     されなかったと確信できるケースに限定する（PR #354レビュー対応・2回目「Stripeの
 *     4xxエラー分類」。4xxを一律に確定的な失敗と扱わない）。
 *   - 'IDEMPOTENCY_CONFLICT': Stripeがidempotency_errorを返した。同一Idempotency-Keyに
 *     対して、Stripe側に既に記録済みのリクエストと異なる内容を送ったことを意味する。
 *     呼び出し元の保存内容が信頼できない可能性がある異常事態であり、新しい決済試行を
 *     発行してはならない（呼び出し元は要復旧として扱う）。
 *   - 'AMBIGUOUS': 上記のいずれにも該当しない4xx（409＝同一キーの別リクエストが処理中等、
 *     型が未知の4xxを含む）・5xx・レート制限(429)・解析不能な応答。処理された可能性を
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

  /*
   * PR #354レビュー対応・2回目「Stripeの4xxエラー分類」。4xxを一律に「確定的な失敗
   * （＝このIdempotency-Keyでのリクエストは処理されていない）」と扱わない。デフォルトは
   * 常にAMBIGUOUS（安全側）であり、Stripeのエラー種別を積極的に確認できた場合にのみ
   * STRIPE_ERROR（確定的な失敗）またはIDEMPOTENCY_CONFLICT（要復旧）へ分類する
   * （許可リスト方式。ブロックリスト方式―既知の「安全な」コード以外はすべてSTRIPE_ERROR
   * 扱い―だと、未知の4xxを誤って確定的な失敗として扱ってしまう恐れがあるため）。
   */
  var CONFIRMED_FAILURE_ERROR_TYPES_ = ['invalid_request_error', 'authentication_error', 'permission_error'];

  function classifyHttpError_(responseCode, parsedBody) {
    var stripeError = parsedBody && parsedBody.error;
    var errorType = stripeError && stripeError.type;

    /* idempotency_error: 同一Idempotency-Keyに対し、Stripe側に記録済みの内容と異なる
       パラメータを送ったことをStripeが検知した。呼び出し元の保存内容自体が信頼できない
       可能性がある異常事態であり、409やその他の不明なエラーよりもさらに踏み込んで
       「新しい決済試行IDの発行を禁止するだけでなく要復旧として停止する」判断材料になる。
       ここでは種別だけを返し、実際に要復旧ゲートを立てるかどうかはBookingRepository.gs
       （呼び出し元）の責務とする。 */
    if (errorType === 'idempotency_error') return 'IDEMPOTENCY_CONFLICT';

    /* 409: 同一Idempotency-Keyへの別リクエストが処理中（後で再試行すれば解決し得る）。
       5xx・429（レート制限）も同様に、この回のリクエストが実際に処理されたかどうかを
       否定できない。 */
    if (responseCode === 409 || responseCode >= 500 || responseCode === 429) return 'AMBIGUOUS';

    if (responseCode >= 400 && responseCode < 500 && CONFIRMED_FAILURE_ERROR_TYPES_.indexOf(errorType) !== -1) {
      return 'STRIPE_ERROR';
    }

    /* 上記いずれにも該当しない4xx（Stripeのエラー種別を読み取れない・想定外の種別）は
       安全側に倒し、確定的な失敗と決めつけない。 */
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
      errorType: classifyHttpError_(code, parsed),
      httpStatus: code,
      stripeErrorCode: (parsed && parsed.error && parsed.error.code) || '',
      stripeErrorType: (parsed && parsed.error && parsed.error.type) || '',
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
      amountTotal: raw.amount_total,
      currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : '',
      expiresAtSeconds: raw.expires_at,
      /* Issue #341 PR-C: StripeWebhookHandler.gsが、Webhookイベント本文のmetadataではなく
         Stripe APIから改めて取得したこの値（bookingId/brand/paymentAttemptId）を正として
         使う（イベント本文だけで完結させない。ファイル冒頭コメント参照）。 */
      metadata: raw.metadata || {}
    };
  }

  /*
   * PaymentIntentの正規化（Issue #341 PR-C）。「Session完了」と「入金完了」を同一視しない
   * ため、Webhook側（StripeWebhookHandler.gs）はCheckout Session（payment_status）だけでなく、
   * このPaymentIntentのstatus==='succeeded'も併せて確認する。amountReceived/currencyは
   * CardPayment.verifyPaymentAgainstSnapshotでの金額照合にも使う。
   */
  function normalizePaymentIntent_(raw) {
    return {
      id: raw.id,
      status: raw.status || '',
      amountReceived: raw.amount_received,
      currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : ''
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

  /*
   * PaymentIntentの再取得（Issue #341 PR-C）。Webhookのイベント本文（Checkout Session）
   * だけで完結させず、Stripe APIから改めて取得した最新のPaymentIntent状態と突き合わせる
   * ことで、「Session完了の事実」と「実際の入金完了（PaymentIntent.status==='succeeded'）」を
   * 混同しない（README「Issue #341 PR-C」節参照）。
   */
  function retrievePaymentIntent(stripeConfig, paymentIntentId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!paymentIntentId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripePaymentIntentIdが指定されていません。' };
    }
    var url = API_BASE_ + '/payment_intents/' + encodeURIComponent(paymentIntentId);
    var result = performRequest_('get', url, stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    return { ok: true, paymentIntent: normalizePaymentIntent_(result.raw) };
  }

  return {
    createCheckoutSession: createCheckoutSession,
    retrieveCheckoutSession: retrieveCheckoutSession,
    retrievePaymentIntent: retrievePaymentIntent
  };
})();
