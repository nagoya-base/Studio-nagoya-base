/*
 * StripeWebhookAuth.gs — 中継基盤（Cloud Run等）からGAS Webhookエンドポイントへの呼び出しを
 * 認証する（Issue #341 PR-C「3. Webhook受信と署名検証」）。
 *
 * GASの`doPost(e)`はリクエストヘッダーを取得できない（README/Issue #341本文の既知の制約）
 * ため、StripeのWebhook署名（Stripe-Signature）検証そのものはこのファイルの責務ではない。
 * その検証は中継基盤（cloud-run/stripe-webhook-relay/）側で、Stripe公式SDKの
 * `stripe.webhooks.constructEvent`を使って行う（署名不正・欠落・許容時刻外はそこで拒否され、
 * このGASエンドポイントへは一切転送されない）。
 *
 * このファイルが担うのは、その「中継基盤からGASへの呼び出し」自体の認証と、
 * 転送されてきたイベント本文（rawBody）が中継基盤とGASの間で改ざん・差し替えされていない
 * ことの検証（Issue #341本文「中継基盤からGASへの呼び出しも、署名・認証トークン等で保護する」
 * 「中継側で検証したイベントID・本文が、GASへ渡る途中で差し替えられない設計にする」）。
 *
 * 設計:
 * - 中継基盤とGASの間だけで共有する秘密鍵（BookingConfig.getStripeWebhookConfig().
 *   relaySharedSecret。Stripeの署名シークレットとは別物で、GASにもCloud Runにも
 *   個別に設定する）を使い、`timestamp + '.' + rawBody`に対するHMAC-SHA256を
 *   中継基盤側が計算してリクエストボディへ同梱する（ヘッダーではなくボディに含める。
 *   GASがヘッダーを読めないため）。
 * - GAS側はUtilities.computeHmacSha256Signatureで同じ値を計算し、定数時間比較で一致を
 *   確認する。rawBodyから直接HMACを計算するため、eventId/eventTypeを別フィールドとして
 *   信用する必要がない（呼び出し元はrawBodyをJSON.parseして中身からeventId等を取り出す。
 *   「本文とは別の主張フィールド」を作らないことで、本文とID/種別が食い違う余地を
 *   構造的に無くす）。
 * - timestampはGAS側の現在時刻との差が許容範囲（既定300秒。Stripe公式SDKの既定
 *   タイムスタンプ許容誤差と合わせる）を超える場合は、HMACが正しくても拒否する
 *   （キャプチャ済みリクエストの無期限な再送に対する多層防御。同一イベントの正当な
 *   再送自体はStripeEventRepository.gsの冪等性台帳が別途安全に処理するため、この
 *   許容窓は「認証の鮮度」のみを扱う）。
 * - relaySharedSecret未設定の場合はfail-closedに常に拒否する（BookingRepository.
 *   tokensMatch_と同じく、空文字同士を一致させて偽装を許可しない）。
 */
'use strict';

var StripeWebhookAuth = (function () {
  /* GAS/Node双方のHMAC実装差異を吸収するため、常に小文字16進文字列で比較する。
     Utilities.computeHmacSha256Signatureは符号付きバイト配列（-128〜127）を返すため、
     0〜255の範囲へ正規化してから16進変換する。 */
  function bytesToHex_(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) {
      var unsigned = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
      var part = unsigned.toString(16);
      hex += part.length < 2 ? '0' + part : part;
    }
    return hex;
  }

  function computeSignatureHex_(secret, message) {
    var bytes = Utilities.computeHmacSha256Signature(message, secret);
    return bytesToHex_(bytes);
  }

  /* 定数時間比較（BookingRepository.tokensMatch_と同じ方針をこのファイル内に複製する。
     GASの各.gsファイルはIIFEで閉じているため、非公開ヘルパーを直接共有できない
     ―CardPayment.gs冒頭コメントのisFinitePositiveInteger_と同じ既存の複製方針）。
     空文字同士は絶対に一致させない。 */
  function timingSafeEqualHex_(claimedHex, expectedHex) {
    if (typeof claimedHex !== 'string' || typeof expectedHex !== 'string') return false;
    if (claimedHex.length === 0 || expectedHex.length === 0) return false;
    if (claimedHex.length !== expectedHex.length) return false;
    var diff = 0;
    for (var i = 0; i < claimedHex.length; i++) {
      diff |= claimedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
    }
    return diff === 0;
  }

  function isFiniteNumber_(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  function err_(code, message) {
    return { valid: false, error: { code: code, message: message } };
  }

  /*
   * webhookConfig: BookingConfig.getStripeWebhookConfig()の戻り値
   *   （{ relaySharedSecret, replayToleranceSeconds }）。
   * relayTimestampSeconds: 中継基盤がこのリクエストに署名した時刻（Unix秒。数値）。
   * rawBody: 中継基盤がStripeから受け取った生の本文をそのまま転送した文字列
   *   （StripeGatewayの他の関数と異なり、ここではJSON.parse前の文字列そのものを扱う）。
   * providedSignatureHex: 中継基盤が計算したHMAC-SHA256の16進文字列。
   * nowMillis: GAS側の現在時刻（テストからの固定注入用。省略時は呼び出し元がnew Date()
   *   を渡すこと）。
   *
   * 戻り値: { valid: true } または { valid: false, error: { code, message } }。
   * codeはRecovery記録・監査ログ向けの識別子であり、Stripeへ内部詳細を一切返さない
   * （呼び出し元のBookingWebhookエンドポイントは、valid:falseの理由を問わず一律
   * FORBIDDEN相当の応答にとどめる）。
   */
  function verifyRelayRequest(webhookConfig, relayTimestampSeconds, rawBody, providedSignatureHex, nowMillis) {
    var secret = webhookConfig && webhookConfig.relaySharedSecret;
    if (!secret) {
      return err_('RELAY_SECRET_NOT_CONFIGURED', '中継基盤との共有シークレットが設定されていません。');
    }
    if (typeof rawBody !== 'string' || !rawBody) {
      return err_('INVALID_BODY', 'リクエスト本文が空です。');
    }
    if (typeof providedSignatureHex !== 'string' || !providedSignatureHex) {
      return err_('MISSING_SIGNATURE', '署名が指定されていません。');
    }
    if (!isFiniteNumber_(relayTimestampSeconds)) {
      return err_('MISSING_TIMESTAMP', 'タイムスタンプが指定されていません。');
    }

    var toleranceSeconds = isFiniteNumber_(webhookConfig.replayToleranceSeconds) && webhookConfig.replayToleranceSeconds > 0
      ? webhookConfig.replayToleranceSeconds
      : 300;
    var nowSeconds = (isFiniteNumber_(nowMillis) ? nowMillis : new Date().getTime()) / 1000;
    if (Math.abs(nowSeconds - relayTimestampSeconds) > toleranceSeconds) {
      return err_('TIMESTAMP_OUT_OF_TOLERANCE', 'タイムスタンプが許容範囲外です。');
    }

    var expectedHex = computeSignatureHex_(secret, relayTimestampSeconds + '.' + rawBody);
    if (!timingSafeEqualHex_(String(providedSignatureHex).toLowerCase(), expectedHex)) {
      return err_('SIGNATURE_MISMATCH', '署名が一致しません。');
    }

    return { valid: true };
  }

  return {
    verifyRelayRequest: verifyRelayRequest
  };
})();
