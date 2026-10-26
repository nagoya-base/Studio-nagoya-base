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
 *   { ok: false, errorType, message, httpStatus?, stripeErrorCode?, stripeErrorParam? } の形。errorTypeは
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
      'metadata[paymentAttemptId]': params.paymentAttemptId,
      /* Issue #516: Checkout Studio固定値（fixed_by_ui）。mode=paymentのためpayment_method_collectionは付けない。 */
      'ui_mode': 'hosted',
      'billing_address_collection': 'auto',
      'phone_number_collection[enabled]': 'false',
      'automatic_tax[enabled]': 'false',
      'allow_promotion_codes': 'false',
      'submit_type': 'auto',
      'name_collection[individual][enabled]': 'true',
      'name_collection[individual][optional]': 'true',
      'integration_identifier': 'hosted_web_0001',
      'origin_context': 'web'
    };
    if (params.customerEmail) {
      payload.customer_email = params.customerEmail;
    }
    /* Issue #423: 追加オプション決済用。client_reference_idと追加metadata（orderType・
       optionOrderId）で「どの予約のどの追加注文か」をWebhookで一意に復元する。
       未指定の既存呼び出し（部屋予約のCheckout）ではペイロードは1バイトも変わらない。 */
    if (params.clientReferenceId) {
      payload.client_reference_id = params.clientReferenceId;
    }
    if (params.extraMetadata) {
      Object.keys(params.extraMetadata).forEach(function (key) {
        payload['metadata[' + key + ']'] = params.extraMetadata[key];
      });
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
      stripeErrorParam: (parsed && parsed.error && parsed.error.param) || '',
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
      metadata: raw.metadata || {},
      clientReferenceId: raw.client_reference_id || '',
      /* Issue #471（SNB MEMBER入会）。既存の部屋予約・オプション決済は参照しない。 */
      mode: raw.mode || '',
      customerId: typeof raw.customer === 'string' ? raw.customer : ((raw.customer && raw.customer.id) || ''),
      customerEmail: String(raw.customer_email || (raw.customer_details && raw.customer_details.email) || ''),
      /* Issue #532: mode=subscriptionの入会Checkoutが作ったSubscription / 初回invoice。 */
      subscriptionId: typeof raw.subscription === 'string' ? raw.subscription : ((raw.subscription && raw.subscription.id) || ''),
      invoiceId: typeof raw.invoice === 'string' ? raw.invoice : ((raw.invoice && raw.invoice.id) || '')
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
      currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : '',
      /* Issue #471: 入会時に保存した決済手段（setup_future_usage=off_session）。 */
      paymentMethodId: typeof raw.payment_method === 'string' ? raw.payment_method : ((raw.payment_method && raw.payment_method.id) || '')
    };
  }

  /*
   * Chargeの正規化（Issue #517）。返金状態（amountRefunded）の正本として、Webhook本文ではなく
   * Stripe APIから再取得した値を使う。
   */
  function normalizeCharge_(raw) {
    return {
      id: raw.id,
      paymentIntentId: typeof raw.payment_intent === 'string' ? raw.payment_intent : ((raw.payment_intent && raw.payment_intent.id) || ''),
      amount: raw.amount,
      amountRefunded: Number(raw.amount_refunded) || 0,
      currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : '',
      /* 2025-03-31.basil より前のAPI versionのみChargeがinvoiceを持つ（以降は削除。retrieveInvoiceIdForPaymentIntentで引く）。 */
      invoiceId: typeof raw.invoice === 'string' ? raw.invoice : ((raw.invoice && raw.invoice.id) || '')
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

  /* Chargeの再取得（Issue #517。SNB MEMBER初回決済の返金検知）。 */
  function retrieveCharge(stripeConfig, chargeId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!chargeId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripeChargeIdが指定されていません。' };
    }
    var result = performRequest_('get', API_BASE_ + '/charges/' + encodeURIComponent(chargeId), stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    return { ok: true, charge: normalizeCharge_(result.raw) };
  }

  /* PaymentIntentから、それを作ったCheckout Sessionを引く（Issue #517。返金された決済が入会Checkoutか判定する）。 */
  function listCheckoutSessionsForPaymentIntent(stripeConfig, paymentIntentId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!paymentIntentId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripePaymentIntentIdが指定されていません。' };
    }
    var url = API_BASE_ + '/checkout/sessions?payment_intent=' + encodeURIComponent(paymentIntentId) + '&limit=10';
    var result = performRequest_('get', url, stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    if (!result.raw || !Array.isArray(result.raw.data)) {
      return { ok: false, errorType: 'AMBIGUOUS', message: 'Stripeからの応答を解析できませんでした。' };
    }
    return { ok: true, sessions: result.raw.data.map(normalizeSession_) };
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

  /*
   * 返金（Issue #341 PR-D）。status: 'pending' | 'requires_action' | 'succeeded' |
   * 'failed' | 'canceled'。metadata.refundAttemptIdは、GAS側が返金試行ごとに発行・
   * 永続化するIdempotency-Keyそのもの（BookingRefund.gs参照）。応答不明後の照会
   * （listRefundsForPaymentIntent）で「自分の返金試行が実際に作られたか」を判別する
   * ために使う。
   */
  function normalizeRefund_(raw) {
    return {
      id: raw.id,
      status: raw.status || '',
      amount: raw.amount,
      currency: typeof raw.currency === 'string' ? raw.currency.toUpperCase() : '',
      paymentIntentId: typeof raw.payment_intent === 'string' ? raw.payment_intent : ((raw.payment_intent && raw.payment_intent.id) || ''),
      metadata: raw.metadata || {},
      failureReason: raw.failure_reason || ''
    };
  }

  /*
   * params: { paymentIntentId, amountJpy, bookingId, refundAttemptId }
   * idempotencyKey: refundAttemptId（BookingRefund.gsが返金APIを呼ぶ前に台帳へ永続化した値）。
   * 同一キー・同一パラメータでの再送はStripe側で重複作成されず、最初に作成した返金が
   * そのまま返る。呼び出し元は再送時も必ず同じparamsを渡すこと（台帳に保存済みの
   * refundAmount等から組み立て直す）。
   */
  function createRefund(stripeConfig, params, idempotencyKey) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!params || !params.paymentIntentId || !params.refundAttemptId || !idempotencyKey) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: '返金に必要な識別子が指定されていません。' };
    }
    var payload = {
      'payment_intent': params.paymentIntentId,
      'amount': String(params.amountJpy),
      'metadata[bookingId]': params.bookingId,
      'metadata[refundAttemptId]': params.refundAttemptId
    };
    var result = performRequest_('post', API_BASE_ + '/refunds', stripeConfig.secretKey, encodeFormPayload_(payload), idempotencyKey);
    if (!result.ok) return result;
    return { ok: true, refund: normalizeRefund_(result.raw) };
  }

  function retrieveRefund(stripeConfig, refundId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!refundId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripeRefundIdが指定されていません。' };
    }
    var result = performRequest_('get', API_BASE_ + '/refunds/' + encodeURIComponent(refundId), stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    return { ok: true, refund: normalizeRefund_(result.raw) };
  }

  /*
   * PaymentIntentに紐づく返金の一覧（最大100件。予約1件あたりの返金は通常1件のため
   * ページングはしない。has_moreがtrueの場合は全件を確認できないためAMBIGUOUSとして
   * 扱い、呼び出し元に「照会できなかった」と判断させる）。
   */
  function listRefundsForPaymentIntent(stripeConfig, paymentIntentId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!paymentIntentId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripePaymentIntentIdが指定されていません。' };
    }
    var url = API_BASE_ + '/refunds?payment_intent=' + encodeURIComponent(paymentIntentId) + '&limit=100';
    var result = performRequest_('get', url, stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    if (!Array.isArray(result.raw.data) || result.raw.has_more) {
      return { ok: false, errorType: 'AMBIGUOUS', message: 'Stripeの返金一覧を完全には取得できませんでした。' };
    }
    return { ok: true, refunds: result.raw.data.map(normalizeRefund_) };
  }

  /*
   * Checkout Sessionの失効（Issue #341 PR-Dレビュー対応・1回目）。未決済（status=open）の
   * Sessionだけが失効でき、既に完了・失効済みのSessionにはStripeがエラーを返す。呼び出し元
   * （BookingRefund.gs）は、失敗・応答不明のいずれの場合も「未決済・失効済み」と断定せず、
   * retrieveCheckoutSessionで実際の状態を確認すること。Idempotency-Keyは同一Sessionの
   * 失効リクエストの再送を同じ応答へ収束させるためだけに付ける（資金移動は伴わない）。
   */
  function expireCheckoutSession(stripeConfig, sessionId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!sessionId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripeCheckoutSessionIdが指定されていません。' };
    }
    var url = API_BASE_ + '/checkout/sessions/' + encodeURIComponent(sessionId) + '/expire';
    var result = performRequest_('post', url, stripeConfig.secretKey, '', 'expire-' + sessionId);
    if (!result.ok) return result;
    return { ok: true, session: normalizeSession_(result.raw) };
  }

  /*
   * SNB MEMBER入会のCheckout Session（Issue #532）。mode=subscriptionで、入会日に初回500円を請求し、以後は
   * 入会日基準で毎月自動更新する（billing_cycle_anchorは指定しない）。3Dセキュア/SCAはStripe Checkoutの
   * Subscriptionフローに委ねる。メールアドレスは入力値をcustomer_emailで固定する（予約メールとの照合を安定させるため）。
   * Subscription作成時のmetadataはCheckout側のmetadataとは別に subscription_data[metadata] で明示的に設定する
   * （invoice.paid等が invoice.parent.subscription_details.metadata から会員を識別できるようにするため）。
   * 価格は params.priceId（既存のRecurring Price）があればそれを使い、無ければ params.productId（既存Product）に対する
   * 月額のprice_dataを使う。ID類はコードへ直書きしない（Script Properties / 台帳から渡す）。
   * params: { amountJpy, email, memberId, successUrl, cancelUrl, priceId?, productId?, expiresAtSeconds? }
   */
  function createMembershipCheckoutSession(stripeConfig, params, idempotencyKey) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!params || (!params.priceId && !params.productId)) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: '月会費のPriceまたはProductが指定されていません。' };
    }
    var payload = {
      'mode': 'subscription',
      'success_url': params.successUrl,
      'cancel_url': params.cancelUrl,
      'customer_email': params.email,
      'line_items[0][quantity]': '1',
      'metadata[orderType]': 'membership',
      'metadata[memberId]': params.memberId,
      'subscription_data[metadata][orderType]': 'membership',
      'subscription_data[metadata][memberId]': params.memberId,
      'client_reference_id': params.memberId,
      /* Issue #516: Checkout Studio固定値（fixed_by_ui）。submit_typeはmode=paymentのみのため付けない。 */
      'ui_mode': 'hosted',
      'billing_address_collection': 'auto',
      'phone_number_collection[enabled]': 'false',
      'automatic_tax[enabled]': 'false',
      'allow_promotion_codes': 'false',
      'payment_method_collection': 'always',
      'name_collection[individual][enabled]': 'true',
      'name_collection[individual][optional]': 'true',
      'integration_identifier': 'hosted_web_0001',
      'origin_context': 'web'
    };
    if (params.priceId) {
      payload['line_items[0][price]'] = params.priceId;
    } else {
      payload['line_items[0][price_data][currency]'] = 'jpy';
      payload['line_items[0][price_data][unit_amount]'] = String(params.amountJpy);
      payload['line_items[0][price_data][recurring][interval]'] = 'month';
      payload['line_items[0][price_data][product]'] = params.productId;
    }
    if (params.expiresAtSeconds) payload.expires_at = String(params.expiresAtSeconds);
    var result = performRequest_('post', API_BASE_ + '/checkout/sessions', stripeConfig.secretKey, encodeFormPayload_(payload), idempotencyKey);
    if (!result.ok) return result;
    return { ok: true, session: normalizeSession_(result.raw) };
  }

  /*
   * Subscriptionの再取得（Issue #532。入会Checkout完了時にstatus・現在期間・解約予約を台帳へ写すために使う）。
   * 戻り値: { ok: true, subscription: { id, status, raw } }
   */
  function retrieveSubscription(stripeConfig, subscriptionId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!subscriptionId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripeSubscriptionIdが指定されていません。' };
    }
    var result = performRequest_('get', API_BASE_ + '/subscriptions/' + encodeURIComponent(subscriptionId), stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    return { ok: true, subscription: { id: result.raw.id, status: result.raw.status || '', raw: result.raw } };
  }

  /*
   * Subscriptionの即時キャンセル（Issue #532。二重加入が判明した新しいSubscriptionを止める）。
   * 以後の請求を作らない。返金はしない（要復旧として運営が判断する）。同じ指定の再送は同じ結果へ収束するため
   * Idempotency-Keyは付けない（既にキャンセル済みの場合はStripeがエラーを返すので、呼び出し側が照会で確認する）。
   */
  function cancelSubscriptionImmediately(stripeConfig, subscriptionId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!subscriptionId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripeSubscriptionIdが指定されていません。' };
    }
    var result = performRequest_('delete', API_BASE_ + '/subscriptions/' + encodeURIComponent(subscriptionId), stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    return { ok: true, subscription: { id: result.raw.id, status: result.raw.status || '' } };
  }

  /*
   * invoiceの再取得（Issue #532。返金されたChargeが会費invoiceか確認する）。
   * 戻り値: { ok: true, invoice: raw } （billing_reason・metadata・lines等はraw本文を読む）
   */
  function retrieveInvoice(stripeConfig, invoiceId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!invoiceId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripeInvoiceIdが指定されていません。' };
    }
    var result = performRequest_('get', API_BASE_ + '/invoices/' + encodeURIComponent(invoiceId), stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    return { ok: true, invoice: result.raw };
  }

  /*
   * PaymentIntentが支払ったinvoiceのIDを引く（Issue #532。Subscription更新invoiceの返金を特定する）。
   * Stripe公式仕様（2025-03-31.basil 以降）: ChargeとPaymentIntentからinvoiceフィールドが削除され、
   * Invoice Payments API（GET /v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=pi_...）で
   * 引く。それより前のAPI versionではCharge.invoiceを使う（呼び出し側でcharge.invoiceIdを先に見る）。
   * 戻り値: { ok: true, invoiceId: '' | 'in_...' }（invoiceに紐づかない決済は空文字）。一覧を完全に取得できない場合はAMBIGUOUS。
   */
  function retrieveInvoiceIdForPaymentIntent(stripeConfig, paymentIntentId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!paymentIntentId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripePaymentIntentIdが指定されていません。' };
    }
    var url = API_BASE_ + '/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=' + encodeURIComponent(paymentIntentId) + '&limit=10';
    var result = performRequest_('get', url, stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    if (!result.raw || !Array.isArray(result.raw.data) || result.raw.has_more) {
      return { ok: false, errorType: 'AMBIGUOUS', message: 'Stripeからの応答を解析できませんでした。' };
    }
    var invoiceId = '';
    result.raw.data.forEach(function (item) {
      if (invoiceId || !item) return;
      invoiceId = typeof item.invoice === 'string' ? item.invoice : ((item.invoice && item.invoice.id) || '');
    });
    return { ok: true, invoiceId: invoiceId };
  }

  /*
   * SNB MEMBERの月額Productを用意する（Issue #528）。POST /v1/subscriptionsのitems[].price_dataは
   * product_data（その場限りの商品名）を受け付けず、既存のProduct IDを要求する（Checkout Sessionの
   * line_items[].price_dataとは仕様が異なる）。Dashboardでの事前作成を不要にするため、固定IDの
   * Productを取得し、無ければ作成する。同時実行で作成が競合した場合（resource_already_exists）は
   * 取得し直す。allowCreate=falseなら取得のみ（運営が指定した既存Productは作らない）。戻り値: { ok: true, productId } またはperformRequest_のエラー形式。
   */
  function ensureMembershipProduct(stripeConfig, productId, productName, allowCreate) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!productId || !productName) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'Productの指定が不足しています。' };
    }
    var url = API_BASE_ + '/products/' + encodeURIComponent(productId);
    var found = performRequest_('get', url, stripeConfig.secretKey, null, null);
    if (found.ok) return { ok: true, productId: found.raw.id || productId };
    if (found.stripeErrorCode !== 'resource_missing' || allowCreate === false) return found;

    var created = performRequest_('post', API_BASE_ + '/products', stripeConfig.secretKey,
      encodeFormPayload_({ 'id': productId, 'name': productName, 'metadata[orderType]': 'membership' }), null);
    if (created.ok) return { ok: true, productId: created.raw.id || productId };
    if (created.stripeErrorCode !== 'resource_already_exists') return created;

    var again = performRequest_('get', url, stripeConfig.secretKey, null, null);
    if (!again.ok) return again;
    return { ok: true, productId: again.raw.id || productId };
  }

  /*
   * 同じ会員のsubscriptionがStripe上に既にあるかを確認する（Issue #528）。ペイロード変更後も
   * Idempotency-Key（保持24時間）に頼らず二重作成を防ぐため、作成前に必ず呼ぶ。
   * Customerのsubscriptionをmetadata.memberIdで絞り、キャンセル済み・期限切れ以外の1件を返す。
   * 一覧を完全に取得できない場合はAMBIGUOUS（作成してはならない）。
   * 戻り値: { ok: true, subscription: {id,status,raw} | null }
   */
  function findMembershipSubscription(stripeConfig, customerId, memberId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!customerId || !memberId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'customerIdまたはmemberIdが指定されていません。' };
    }
    var url = API_BASE_ + '/subscriptions?customer=' + encodeURIComponent(customerId) + '&status=all&limit=100';
    var result = performRequest_('get', url, stripeConfig.secretKey, null, null);
    if (!result.ok) return result;
    if (!Array.isArray(result.raw.data) || result.raw.has_more) {
      return { ok: false, errorType: 'AMBIGUOUS', message: 'Stripeのsubscription一覧を完全には取得できませんでした。' };
    }
    var match = null;
    result.raw.data.forEach(function (item) {
      if (match || !item || !item.metadata || item.metadata.memberId !== memberId) return;
      if (item.status === 'canceled' || item.status === 'incomplete_expired') return;
      match = { id: item.id, status: item.status || '', raw: item };
    });
    return { ok: true, subscription: match };
  }

  /*
   * SNB MEMBERの月額subscription作成（Issue #471）。billing_cycle_anchorは入会月に応じた1日
   * 00:00 UTC（プレスタートは12/1）、proration_behavior=none（入会月は既にCheckoutで満額決済済みの
   * ため、入会月ぶんの請求を作らない）。以後は毎月1日（UTC）に500円が自動請求される。
   * 価格はprice_dataで渡すが、subscriptionではproduct_dataが使えないため、
   * ensureMembershipProductで用意したProduct IDを渡す（Issue #528）。
   * params: { customerId, paymentMethodId, amountJpy, productId, anchorSeconds, memberId }
   * idempotencyKey: 入会Checkout Session IDから導出した固定値（同じ入会で二重作成しない）。
   */
  function createMembershipSubscription(stripeConfig, params, idempotencyKey) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!params || !params.customerId || !params.paymentMethodId || !params.productId || !params.anchorSeconds || !idempotencyKey) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'subscription作成に必要な情報が不足しています。' };
    }
    var payload = {
      'customer': params.customerId,
      'default_payment_method': params.paymentMethodId,
      'billing_cycle_anchor': String(params.anchorSeconds),
      'proration_behavior': 'none',
      'items[0][quantity]': '1',
      'items[0][price_data][currency]': 'jpy',
      'items[0][price_data][unit_amount]': String(params.amountJpy),
      'items[0][price_data][recurring][interval]': 'month',
      'items[0][price_data][product]': params.productId,
      'metadata[orderType]': 'membership',
      'metadata[memberId]': params.memberId
    };
    var result = performRequest_('post', API_BASE_ + '/subscriptions', stripeConfig.secretKey, encodeFormPayload_(payload), idempotencyKey);
    if (!result.ok) return result;
    var raw = result.raw;
    return {
      ok: true,
      subscription: {
        id: raw.id,
        status: raw.status || '',
        raw: raw
      }
    };
  }

  /*
   * SNB MEMBERの次回更新停止（Issue #506）。subscriptionを即時キャンセルせず、現在の請求期間の末日で
   * 終わる設定（cancel_at_period_end=true）にする。支払い済み期間は維持され、以降の自動請求だけが止まる。
   * 同じ指定の再送は同じ結果になる（冪等）ため、Idempotency-Keyは付けない（応答不明後の再試行で
   * 古い応答が返らないようにする）。会員台帳への反映はcustomer.subscription.updated Webhookが正本。
   * 戻り値のsubscriptionにはcancelAtPeriodEnd・statusだけを持たせ、IDは呼び出し元の外へ出さない。
   */
  function setSubscriptionCancelAtPeriodEnd(stripeConfig, subscriptionId) {
    if (!stripeConfig || !stripeConfig.secretKey) {
      return { ok: false, errorType: 'NOT_CONFIGURED', message: 'Stripeの秘密鍵が設定されていません。' };
    }
    if (!subscriptionId) {
      return { ok: false, errorType: 'INVALID_REQUEST', message: 'stripeSubscriptionIdが指定されていません。' };
    }
    var url = API_BASE_ + '/subscriptions/' + encodeURIComponent(subscriptionId);
    var result = performRequest_('post', url, stripeConfig.secretKey, encodeFormPayload_({ 'cancel_at_period_end': 'true' }), null);
    if (!result.ok) return result;
    return {
      ok: true,
      subscription: {
        status: result.raw.status || '',
        cancelAtPeriodEnd: result.raw.cancel_at_period_end === true || !!result.raw.cancel_at
      }
    };
  }

  return {
    setSubscriptionCancelAtPeriodEnd: setSubscriptionCancelAtPeriodEnd,
    createMembershipCheckoutSession: createMembershipCheckoutSession,
    retrieveSubscription: retrieveSubscription,
    cancelSubscriptionImmediately: cancelSubscriptionImmediately,
    retrieveInvoice: retrieveInvoice,
    retrieveInvoiceIdForPaymentIntent: retrieveInvoiceIdForPaymentIntent,
    ensureMembershipProduct: ensureMembershipProduct,
    findMembershipSubscription: findMembershipSubscription,
    createMembershipSubscription: createMembershipSubscription,
    createCheckoutSession: createCheckoutSession,
    retrieveCheckoutSession: retrieveCheckoutSession,
    expireCheckoutSession: expireCheckoutSession,
    retrievePaymentIntent: retrievePaymentIntent,
    retrieveCharge: retrieveCharge,
    listCheckoutSessionsForPaymentIntent: listCheckoutSessionsForPaymentIntent,
    createRefund: createRefund,
    retrieveRefund: retrieveRefund,
    listRefundsForPaymentIntent: listRefundsForPaymentIntent
  };
})();
