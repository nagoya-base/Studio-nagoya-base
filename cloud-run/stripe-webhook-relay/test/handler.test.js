/*
 * handler.handleWebhookRequestのテスト（Issue #341 PR-C「10. 必須テスト」）。
 * - 正しい署名のイベントのみ受け付ける。
 * - 不正署名、期限外署名、改ざんされた本文を拒否する。
 * - GASへの転送・応答の成否に応じて正しいstripeStatusを返す
 *   （success:false・GAS到達失敗のいずれもStripeへ5xx系を返し自動再送を促す）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const Stripe = require('stripe');
const { handleWebhookRequest, computeRelaySignature } = require('../src/handler');

const WEBHOOK_SECRET = 'whsec_test_0001';
const RELAY_SECRET = 'relay-shared-secret-test-0001';
const GAS_URL = 'https://example.com/exec';

const stripeClient = Stripe('sk_test_dummy_not_used_for_verification');

function buildConfig(overrides) {
  return Object.assign(
    { webhookSecret: WEBHOOK_SECRET, relaySharedSecret: RELAY_SECRET, gasWebhookUrl: GAS_URL },
    overrides || {}
  );
}

function signedRequest(payloadObject, secret, timestampSeconds) {
  const payload = JSON.stringify(payloadObject);
  const header = stripeClient.webhooks.generateTestHeaderString({
    payload: payload,
    secret: secret,
    timestamp: timestampSeconds
  });
  return { rawBody: Buffer.from(payload, 'utf8'), signatureHeader: header };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

test('handleWebhookRequest: 正しい署名のイベントはGASへ転送され、成功応答を返す', async () => {
  const { rawBody, signatureHeader } = signedRequest({ id: 'evt_1', type: 'checkout.session.completed' }, WEBHOOK_SECRET, nowSeconds());
  let forwardedUrl = null;
  let forwardedPayload = null;
  const forwardToGas = async (url, payload) => {
    forwardedUrl = url;
    forwardedPayload = payload;
    return { success: true, code: 'CONFIRMED' };
  };

  const result = await handleWebhookRequest({
    rawBody, signatureHeader, config: buildConfig(), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 200);
  assert.strictEqual(result.eventId, 'evt_1');
  assert.strictEqual(forwardedUrl, GAS_URL);
  assert.strictEqual(forwardedPayload.body, rawBody.toString('utf8'));

  /* GASへ送るHMACは、実際にGAS側（StripeWebhookAuth）が期待する式と一致する。 */
  const expectedSignature = computeRelaySignature(RELAY_SECRET, forwardedPayload.timestamp, forwardedPayload.body);
  assert.strictEqual(forwardedPayload.signature, expectedSignature);
});

test('handleWebhookRequest: 署名ヘッダーが無い場合は転送せず拒否する', async () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var forwarded = false;
  const forwardToGas = async () => { forwarded = true; return { success: true }; };

  const result = await handleWebhookRequest({
    rawBody: Buffer.from(payload), signatureHeader: undefined, config: buildConfig(), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 400);
  assert.strictEqual(result.reason, 'MISSING_SIGNATURE');
  assert.strictEqual(forwarded, false);
});

test('handleWebhookRequest: 署名が不正な場合は転送せず拒否する', async () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var forwarded = false;
  const forwardToGas = async () => { forwarded = true; return { success: true }; };

  const result = await handleWebhookRequest({
    rawBody: Buffer.from(payload),
    signatureHeader: 't=' + nowSeconds() + ',v1=' + 'a'.repeat(64),
    config: buildConfig(),
    stripeClient,
    forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 400);
  assert.strictEqual(result.reason, 'SIGNATURE_VERIFICATION_FAILED');
  assert.strictEqual(forwarded, false);
});

test('handleWebhookRequest: 署名の対象と異なる本文（改ざん）は拒否する', async () => {
  const originalPayload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const header = stripeClient.webhooks.generateTestHeaderString({ payload: originalPayload, secret: WEBHOOK_SECRET, timestamp: nowSeconds() });
  const tamperedBody = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', amount: 999999 }));

  var forwarded = false;
  const forwardToGas = async () => { forwarded = true; return { success: true }; };

  const result = await handleWebhookRequest({
    rawBody: tamperedBody, signatureHeader: header, config: buildConfig(), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 400);
  assert.strictEqual(result.reason, 'SIGNATURE_VERIFICATION_FAILED');
  assert.strictEqual(forwarded, false);
});

test('handleWebhookRequest: タイムスタンプが許容範囲外（期限外署名）は拒否する', async () => {
  const payload = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  const oldTimestamp = nowSeconds() - 3600; /* 1時間前。stripe SDK既定の許容誤差(300秒)を超える */
  const header = stripeClient.webhooks.generateTestHeaderString({ payload: payload, secret: WEBHOOK_SECRET, timestamp: oldTimestamp });

  var forwarded = false;
  const forwardToGas = async () => { forwarded = true; return { success: true }; };

  const result = await handleWebhookRequest({
    rawBody: Buffer.from(payload), signatureHeader: header, config: buildConfig(), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 400);
  assert.strictEqual(result.reason, 'SIGNATURE_VERIFICATION_FAILED');
  assert.strictEqual(forwarded, false);
});

test('handleWebhookRequest: 誤ったWebhook Secretで署名されたリクエストは拒否する', async () => {
  const { rawBody, signatureHeader } = signedRequest({ id: 'evt_1', type: 'checkout.session.completed' }, 'whsec_completely_different', nowSeconds());
  var forwarded = false;
  const forwardToGas = async () => { forwarded = true; return { success: true }; };

  const result = await handleWebhookRequest({
    rawBody, signatureHeader, config: buildConfig(), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 400);
  assert.strictEqual(forwarded, false);
});

test('handleWebhookRequest: GASがsuccess:falseを返した場合はStripeへ5xxを返す（自動再送を促す）', async () => {
  const { rawBody, signatureHeader } = signedRequest({ id: 'evt_1', type: 'checkout.session.completed' }, WEBHOOK_SECRET, nowSeconds());
  const forwardToGas = async () => ({ success: false, code: 'PAYMENT_RECOVERY_REQUIRED' });

  const result = await handleWebhookRequest({
    rawBody, signatureHeader, config: buildConfig(), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 500);
  assert.strictEqual(result.reason, 'GAS_REPORTED_FAILURE');
});

test('handleWebhookRequest: GASへの到達自体が失敗した場合は未払いと決めつけずStripeへ再送を促す', async () => {
  const { rawBody, signatureHeader } = signedRequest({ id: 'evt_1', type: 'checkout.session.completed' }, WEBHOOK_SECRET, nowSeconds());
  const forwardToGas = async () => { throw new Error('network unreachable'); };

  const result = await handleWebhookRequest({
    rawBody, signatureHeader, config: buildConfig(), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 502);
  assert.strictEqual(result.reason, 'GAS_FORWARD_FAILED');
});

test('handleWebhookRequest: Webhook Secret未設定の場合はfail-closedに拒否する', async () => {
  const { rawBody, signatureHeader } = signedRequest({ id: 'evt_1', type: 'checkout.session.completed' }, WEBHOOK_SECRET, nowSeconds());
  const forwardToGas = async () => ({ success: true });

  const result = await handleWebhookRequest({
    rawBody, signatureHeader, config: buildConfig({ webhookSecret: '' }), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 500);
  assert.strictEqual(result.reason, 'WEBHOOK_SECRET_NOT_CONFIGURED');
});

test('handleWebhookRequest: 中継用共有シークレット未設定の場合はfail-closedに拒否する', async () => {
  const { rawBody, signatureHeader } = signedRequest({ id: 'evt_1', type: 'checkout.session.completed' }, WEBHOOK_SECRET, nowSeconds());
  const forwardToGas = async () => ({ success: true });

  const result = await handleWebhookRequest({
    rawBody, signatureHeader, config: buildConfig({ relaySharedSecret: '' }), stripeClient, forwardToGas
  });

  assert.strictEqual(result.stripeStatus, 500);
  assert.strictEqual(result.reason, 'RELAY_SECRET_NOT_CONFIGURED');
});

test('computeRelaySignature: GAS側（StripeWebhookAuth.gs）と同一の16進文字列を計算する', () => {
  const secret = 'shared-secret';
  const timestamp = 1893456000;
  const body = '{"id":"evt_1"}';
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  assert.strictEqual(computeRelaySignature(secret, timestamp, body), expected);
});
