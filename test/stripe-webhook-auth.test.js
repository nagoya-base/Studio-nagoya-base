/*
 * StripeWebhookAuth.verifyRelayRequestのテスト（Issue #341 PR-C「10. 必須テスト」）。
 * - 正しい署名のイベントのみ受け付ける。
 * - 不正署名、期限外署名、改ざんされた本文を拒否する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('crypto');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'StripeWebhookAuth.gs'];
var SECRET = 'relay-shared-secret-test-0001';

function setup(propertyOverrides) {
  var properties = Object.assign(
    { STRIPE_WEBHOOK_RELAY_SECRET: SECRET },
    propertyOverrides || {}
  );
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    Utilities: stubs.createUtilitiesStub()
  };
  return loadBookingSandbox(FILES, globals);
}

function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
}

test('verifyRelayRequest: 正しい署名・時刻内のリクエストのみ受け付ける', function () {
  var sandbox = setup();
  var body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var nowMillis = 1893456000000; /* 固定時刻 */
  var timestampSeconds = Math.floor(nowMillis / 1000);
  var signature = sign(SECRET, timestampSeconds, body);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, timestampSeconds, body, signature, nowMillis);
  assert.strictEqual(result.valid, true);
});

test('verifyRelayRequest: 署名が不正な場合は拒否する', function () {
  var sandbox = setup();
  var body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var nowMillis = 1893456000000;
  var timestampSeconds = Math.floor(nowMillis / 1000);
  var wrongSignature = sign('completely-different-secret', timestampSeconds, body);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, timestampSeconds, body, wrongSignature, nowMillis);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'SIGNATURE_MISMATCH');
});

test('verifyRelayRequest: 改ざんされた本文は署名不一致として拒否する', function () {
  var sandbox = setup();
  var originalBody = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var tamperedBody = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', amount: 999999 });
  var nowMillis = 1893456000000;
  var timestampSeconds = Math.floor(nowMillis / 1000);
  var signature = sign(SECRET, timestampSeconds, originalBody);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, timestampSeconds, tamperedBody, signature, nowMillis);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'SIGNATURE_MISMATCH');
});

test('verifyRelayRequest: 署名が欠落している場合は拒否する', function () {
  var sandbox = setup();
  var body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var nowMillis = 1893456000000;
  var timestampSeconds = Math.floor(nowMillis / 1000);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, timestampSeconds, body, '', nowMillis);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'MISSING_SIGNATURE');
});

test('verifyRelayRequest: タイムスタンプが許容範囲外の場合は署名が正しくても拒否する', function () {
  var sandbox = setup();
  var body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var nowMillis = 1893456000000;
  var oldTimestampSeconds = Math.floor(nowMillis / 1000) - 3600; /* 1時間前 */
  var signature = sign(SECRET, oldTimestampSeconds, body);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, oldTimestampSeconds, body, signature, nowMillis);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'TIMESTAMP_OUT_OF_TOLERANCE');
});

test('verifyRelayRequest: タイムスタンプが未来方向に許容範囲外の場合も拒否する', function () {
  var sandbox = setup();
  var body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var nowMillis = 1893456000000;
  var futureTimestampSeconds = Math.floor(nowMillis / 1000) + 3600;
  var signature = sign(SECRET, futureTimestampSeconds, body);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, futureTimestampSeconds, body, signature, nowMillis);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'TIMESTAMP_OUT_OF_TOLERANCE');
});

test('verifyRelayRequest: 共有シークレット未設定の場合は常に拒否する（fail-closed）', function () {
  var sandbox = setup({ STRIPE_WEBHOOK_RELAY_SECRET: '' });
  var body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var nowMillis = 1893456000000;
  var timestampSeconds = Math.floor(nowMillis / 1000);
  var signature = sign('', timestampSeconds, body);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, timestampSeconds, body, signature, nowMillis);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'RELAY_SECRET_NOT_CONFIGURED');
});

test('verifyRelayRequest: 空文字の署名同士でも一致させない', function () {
  var sandbox = setup();
  var body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var nowMillis = 1893456000000;
  var timestampSeconds = Math.floor(nowMillis / 1000);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, timestampSeconds, '', '', nowMillis);
  assert.strictEqual(result.valid, false);
});

test('verifyRelayRequest: Script Propertiesで許容秒数をカスタマイズできる', function () {
  var sandbox = setup({ STRIPE_WEBHOOK_RELAY_TOLERANCE_SECONDS: '60' });
  var body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' });
  var nowMillis = 1893456000000;
  var timestampSeconds = Math.floor(nowMillis / 1000) - 120; /* 120秒前。既定300秒なら許容だが60秒設定では拒否されるはず */
  var signature = sign(SECRET, timestampSeconds, body);

  var webhookConfig = sandbox.BookingConfig.getStripeWebhookConfig();
  assert.strictEqual(webhookConfig.replayToleranceSeconds, 60);
  var result = sandbox.StripeWebhookAuth.verifyRelayRequest(webhookConfig, timestampSeconds, body, signature, nowMillis);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'TIMESTAMP_OUT_OF_TOLERANCE');
});
