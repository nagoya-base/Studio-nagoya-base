/*
 * handler.js — Stripe Webhook中継の中核ロジック（Issue #341 PR-C）。
 *
 * 責務はStripeの署名検証と、GAS（Booking Adminプロジェクト）への認証付き転送のみ。
 * 予約・決済の業務ロジック（金額照合・冪等性・予約自動確定等）は一切持たない
 * （それらはすべてGAS側のStripeWebhookHandler.gs等に一元化する）。
 *
 * - Stripeの署名検証は`stripe`公式SDKの`stripe.webhooks.constructEvent`のみを使う
 *   （Stripe公式の推奨どおり、自前でHMAC検証を実装しない）。検証は生のリクエスト本文
 *   （Buffer）に対して行う必要があるため、呼び出し元（index.js）はJSON.parse前の
 *   生バイト列をそのまま渡すこと。
 * - GASへの転送は、Stripeから受け取った生の本文（文字列化したもの）そのものに対する
 *   HMAC-SHA256（`GAS_WEBHOOK_RELAY_SECRET`）を計算し、タイムスタンプとともにJSON化した
 *   ボディとして送る。ヘッダーではなく本文に含めるのは、GASの`doPost(e)`がリクエスト
 *   ヘッダーを読めない制約に合わせるため（gas/booking/shared/StripeWebhookAuth.gs参照）。
 * - GASへの転送・応答はいずれも例外を投げずに`{ stripeStatus, reason, ... }`へ正規化する。
 *   `stripeStatus`は呼び出し元がStripeへ返すべきHTTPステータス
 *   （200=成功として扱ってよい、それ以外=Stripeの自動再送を促す）。
 */
'use strict';

const crypto = require('crypto');

function computeRelaySignature(secret, timestampSeconds, rawBodyString) {
  return crypto.createHmac('sha256', secret).update(`${timestampSeconds}.${rawBodyString}`).digest('hex');
}

/*
 * deps:
 *   rawBody: Buffer（Stripeから受信した生のリクエスト本文。JSON.parse前）
 *   signatureHeader: string | undefined（Stripe-Signatureヘッダーの値）
 *   config: { webhookSecret, relaySharedSecret, gasWebhookUrl }
 *   stripeClient: 署名検証専用（{ webhooks: { constructEvent(rawBody, sig, secret) } }）。
 *     実際のStripe API呼び出しは行わない（署名検証はネットワークを使わないローカル演算）。
 *   forwardToGas: (url, payload) => Promise<{ success: boolean, code?: string, message?: string }>
 *     実際のHTTP POSTを行う関数（index.jsではfetchを使う実装を注入する。テストではモックを注入する）。
 *   now: () => number（ミリ秒epoch。テストからの固定時刻注入用）
 *
 * 戻り値: { stripeStatus, reason, eventId? }
 */
async function handleWebhookRequest({ rawBody, signatureHeader, config, stripeClient, forwardToGas, now }) {
  const effectiveNow = typeof now === 'function' ? now : () => Date.now();

  if (!config || !config.webhookSecret) {
    return { stripeStatus: 500, reason: 'WEBHOOK_SECRET_NOT_CONFIGURED' };
  }
  if (!config.relaySharedSecret) {
    return { stripeStatus: 500, reason: 'RELAY_SECRET_NOT_CONFIGURED' };
  }
  if (!config.gasWebhookUrl) {
    return { stripeStatus: 500, reason: 'GAS_WEBHOOK_URL_NOT_CONFIGURED' };
  }
  if (!signatureHeader) {
    return { stripeStatus: 400, reason: 'MISSING_SIGNATURE' };
  }
  if (!Buffer.isBuffer(rawBody)) {
    return { stripeStatus: 400, reason: 'INVALID_BODY' };
  }

  let event;
  try {
    /*
     * Stripe公式SDKが署名不正・欠落・許容時刻外（既定300秒）のいずれも検出して例外を
     * 投げる（Issue #341本文「署名が不正、欠落、許容時刻外の場合はイベントを処理しない」）。
     * ここで独自の追加チェックは行わない（SDKの実装を信頼する。Stripe公式の推奨）。
     */
    event = stripeClient.webhooks.constructEvent(rawBody, signatureHeader, config.webhookSecret);
  } catch (verificationError) {
    return { stripeStatus: 400, reason: 'SIGNATURE_VERIFICATION_FAILED', error: verificationError.message };
  }

  const rawBodyString = rawBody.toString('utf8');
  const timestampSeconds = Math.floor(effectiveNow() / 1000);
  const signature = computeRelaySignature(config.relaySharedSecret, timestampSeconds, rawBodyString);

  var gasResponse;
  try {
    gasResponse = await forwardToGas(config.gasWebhookUrl, {
      timestamp: timestampSeconds,
      signature: signature,
      body: rawBodyString
    });
  } catch (forwardError) {
    /* GASへの到達自体に失敗（ネットワークエラー・タイムアウト等）。イベントの中身は
       Stripe側の署名検証を通過済みで正当だが、GAS側で永続化できたかどうか不明なため、
       Stripeの自動再送に委ねる（未払いと決めつけない、と同じ「不明な場合は再試行可能な
       状態にする」方針をここでも適用する）。 */
    return { stripeStatus: 502, reason: 'GAS_FORWARD_FAILED', eventId: event.id, error: forwardError.message };
  }

  if (!gasResponse || gasResponse.success !== true) {
    /*
     * GAS側が明示的にsuccess:falseを返した（イベント処理結果を永続化できなかった、
     * 認証に失敗した等）。GAS/StripeWebhookHandler.gsの設計上、success:trueは
     * イベント処理結果の永続化まで完了した場合にのみ返るため、それ以外は無条件に
     * Stripeへ5xxを返して自動再送を促す（Issue #341本文「永続化できていないイベントを
     * 成功扱いにしない」をこの層でも一貫させる）。
     */
    return {
      stripeStatus: 500,
      reason: 'GAS_REPORTED_FAILURE',
      eventId: event.id,
      gasCode: gasResponse && (gasResponse.code || (gasResponse.error && gasResponse.error.code))
    };
  }

  return { stripeStatus: 200, reason: 'OK', eventId: event.id, gasCode: gasResponse.code };
}

module.exports = { handleWebhookRequest, computeRelaySignature };
