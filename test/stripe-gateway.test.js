/*
 * gas/booking/shared/StripeGateway.gs（Issue #341 PR-B）のテスト。実際のStripe APIには
 * 一切接続せず、UrlFetchAppをスタブして応答パターンごとの分類（NOT_CONFIGURED/NETWORK/
 * STRIPE_ERROR/AMBIGUOUS）と、リクエストの組み立て（Idempotency-Keyヘッダ・
 * Authorizationヘッダ・form-urlencoded payload）を検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

function loadStripeGateway(urlFetchAppStub) {
  var sandbox = loadBookingSandbox(['StripeGateway.gs'], {
    UrlFetchApp: urlFetchAppStub
  });
  return sandbox;
}

var STRIPE_CONFIG = {
  secretKey: 'sk_test_dummy',
  successUrl: 'https://example.com/success',
  cancelUrl: 'https://example.com/cancel'
};

function parseFormPayload(payload) {
  var out = {};
  String(payload || '').split('&').forEach(function (pair) {
    if (!pair) return;
    var idx = pair.indexOf('=');
    var key = decodeURIComponent(pair.slice(0, idx));
    var value = decodeURIComponent(pair.slice(idx + 1));
    out[key] = value;
  });
  return out;
}

test('createCheckoutSession: secretKey未設定はStripeへ到達せずNOT_CONFIGUREDを返す', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    throw new Error('呼ばれてはいけない');
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession({ secretKey: '' }, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'SX-20261001-AAAAAAAA', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1234567890, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorType, 'NOT_CONFIGURED');
  assert.strictEqual(urlFetchApp._calls.length, 0);
});

test('createCheckoutSession: 正常系はAuthorization/Idempotency-Keyヘッダと正しい金額・通貨・metadataを送る', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return {
      responseCode: 200,
      body: {
        id: 'cs_test_123', url: 'https://checkout.stripe.com/pay/cs_test_123',
        status: 'open', payment_status: 'unpaid', expires_at: 1999999999
      }
    };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000,
    currency: 'JPY',
    bookingId: 'SX-20261001-AAAAAAAA',
    brand: 'studio_x',
    paymentAttemptId: 'PAY-1',
    expiresAtSeconds: 1999999999,
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel'
  }, 'PAY-1');

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.session.id, 'cs_test_123');
  assert.strictEqual(result.session.url, 'https://checkout.stripe.com/pay/cs_test_123');
  assert.strictEqual(result.session.status, 'open');
  assert.strictEqual(result.session.paymentStatus, 'unpaid');
  assert.strictEqual(result.session.expiresAtSeconds, 1999999999);

  assert.strictEqual(urlFetchApp._calls.length, 1);
  var call = urlFetchApp._calls[0];
  assert.strictEqual(call.options.headers.Authorization, 'Bearer sk_test_dummy');
  assert.strictEqual(call.options.headers['Idempotency-Key'], 'PAY-1');
  assert.strictEqual(call.options.muteHttpExceptions, true);

  var form = parseFormPayload(call.options.payload);
  assert.strictEqual(form.mode, 'payment');
  assert.strictEqual(form['line_items[0][price_data][currency]'], 'jpy');
  assert.strictEqual(form['line_items[0][price_data][unit_amount]'], '8000');
  assert.strictEqual(form['metadata[bookingId]'], 'SX-20261001-AAAAAAAA');
  assert.strictEqual(form['metadata[paymentAttemptId]'], 'PAY-1');
});

test('createCheckoutSession: UrlFetchApp.fetchが例外を投げた場合はNETWORKを返す（Stripe側の処理結果は不明のまま）', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { thrown: new Error('DNS error') };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'b1', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorType, 'NETWORK');
});

test('createCheckoutSession: Stripeがinvalid_request_errorを明確に返した場合はSTRIPE_ERROR（この回のリクエストは処理されていないと確定できる）', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 400, body: { error: { type: 'invalid_request_error', code: 'parameter_invalid_integer', message: 'Invalid amount' } } };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'b1', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorType, 'STRIPE_ERROR');
  assert.strictEqual(result.stripeErrorCode, 'parameter_invalid_integer');
});

test('createCheckoutSession: Stripeがauthentication_errorを返した場合もSTRIPE_ERROR', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 401, body: { error: { type: 'authentication_error', message: 'Invalid API key' } } };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'b1', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.errorType, 'STRIPE_ERROR');
});

test('createCheckoutSession: 400でもerror.typeを読み取れない場合（未知の4xx）はSTRIPE_ERRORへ丸めずAMBIGUOUS扱いにする（PR #354レビュー対応・2回目）', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 400, body: { error: { message: 'something went wrong' } } };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'b1', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.errorType, 'AMBIGUOUS', '種別を確認できない4xxを確定的な失敗と決めつけない');
});

test('createCheckoutSession: idempotency_errorはIDEMPOTENCY_CONFLICTに分類し、STRIPE_ERROR/AMBIGUOUSのいずれとも異なる扱いにする（PR #354レビュー対応・2回目）', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return {
      responseCode: 400,
      body: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters they were first used with' } }
    };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'b1', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorType, 'IDEMPOTENCY_CONFLICT');
});

test('createCheckoutSession: 409（同一キーの別リクエストが処理中）はAMBIGUOUS扱いで、新しい決済試行IDを発行させない', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 409, body: { error: { message: 'A request outputting a resource with that same idempotency key is currently in progress' } } };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'b1', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.errorType, 'AMBIGUOUS');
});

test('createCheckoutSession: Stripeが5xxを返した場合はAMBIGUOUS（処理された可能性を否定できない）', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 503, body: { error: { message: 'Service unavailable' } } };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'b1', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorType, 'AMBIGUOUS');
});

test('createCheckoutSession: レート制限(429)もAMBIGUOUS扱い（新しい決済試行IDを発行させない）', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 429, body: { error: { message: 'Too many requests' } } };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.createCheckoutSession(STRIPE_CONFIG, {
    amountJpy: 8000, currency: 'JPY', bookingId: 'b1', brand: 'studio_x',
    paymentAttemptId: 'PAY-1', expiresAtSeconds: 1, successUrl: 'https://x', cancelUrl: 'https://y'
  }, 'PAY-1');
  assert.strictEqual(result.errorType, 'AMBIGUOUS');
});

test('retrieveCheckoutSession: sessionId未指定はStripeへ到達せずINVALID_REQUEST', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    throw new Error('呼ばれてはいけない');
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.retrieveCheckoutSession(STRIPE_CONFIG, '');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.errorType, 'INVALID_REQUEST');
  assert.strictEqual(urlFetchApp._calls.length, 0);
});

test('retrieveCheckoutSession: GETでsessionIdをURLへ含め、Idempotency-Keyは付与しない', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 200, body: { id: 'cs_1', status: 'expired', payment_status: 'unpaid', expires_at: 1 } };
  });
  var sandbox = loadStripeGateway(urlFetchApp);
  var result = sandbox.StripeGateway.retrieveCheckoutSession(STRIPE_CONFIG, 'cs_1');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.session.status, 'expired');
  assert.strictEqual(result.session.paymentStatus, 'unpaid');

  var call = urlFetchApp._calls[0];
  assert.ok(call.url.indexOf('/checkout/sessions/cs_1') !== -1);
  assert.strictEqual(call.options.method, 'get');
  assert.strictEqual(call.options.headers['Idempotency-Key'], undefined);
});
