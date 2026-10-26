/*
 * MembershipService の Stripe 失敗ログ（Issue #524）のテスト。
 * httpStatus / stripeErrorCode / stripeErrorType / message だけが記録され、秘密情報・body全文が出ないことを確認する。
 * Stripe・Sheets・Calendarはすべてスタブで、本番Stripeへは一切アクセスしない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'CardPayment.gs',
  'JapaneseHolidays.gs', 'BookingPricing.gs', 'RateLimiter.gs', 'StripeGateway.gs',
  'StripeEventRepository.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'MembershipService.gs',
  'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'AdminNotifier.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'BookingRepository.gs',
  'StripeWebhookProcessor.gs', 'BookingAdminAlerts.gs', 'Code.gs'
];

var SECRET_KEY = 'sk_test_dummy_value';

function setup(stripeResponse) {
  var spreadsheetsById = { ss1: {} };
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: 'ss1', CALENDAR_ID: 'cal1', STRIPE_SECRET_KEY: SECRET_KEY,
      STRIPE_CHECKOUT_ENABLED: 'true', STRIPE_MEMBER_PRODUCT_ID: 'prod_fixture_member', STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/ok', STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/ng' }),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { return stripeResponse; }),
    Utilities: stubs.createUtilitiesStub(),
    MailApp: stubs.createMailAppStub(),
    ContentService: stubs.createContentServiceStub(),
    Logger: stubs.createLoggerStub(),
    Date: stubs.createControllableClock('2026-12-15T12:00:00+09:00').Date
  };
  return { sandbox: loadBookingSandbox(FILES, globals), globals: globals };
}

function failingJoin(stripeResponse) {
  var ctx = setup(stripeResponse);
  var result = ctx.sandbox.MembershipService.startCheckout({ email: 'taro@example.com' });
  var logs = ctx.globals.Logger._logs.map(String).filter(function (l) { return l.indexOf('入会Checkout Sessionを作成できませんでした') !== -1; });
  return { result: result, logs: logs, all: JSON.stringify(ctx.globals.Logger._logs) };
}

test('Stripe標準エラー: 4項目がログに記録される', function () {
  var out = failingJoin({ responseCode: 400, body: { error: { code: 'resource_missing', message: 'No such customer', type: 'invalid_request_error' } } });
  assert.strictEqual(out.result.error.code, 'CHECKOUT_UNAVAILABLE', '成否判定は変わらない');
  assert.strictEqual(out.logs.length, 1);
  assert.ok(out.logs[0].indexOf('httpStatus=400') !== -1);
  assert.ok(out.logs[0].indexOf('stripeErrorCode=resource_missing') !== -1);
  assert.ok(out.logs[0].indexOf('stripeErrorType=invalid_request_error') !== -1);
  assert.ok(out.logs[0].indexOf('message=No such customer') !== -1);
});

test('codeのないStripeエラー: 例外にならず取得できる項目だけ記録される', function () {
  var out = failingJoin({ responseCode: 402, body: { error: { type: 'invalid_request_error', message: 'Bad request' } } });
  assert.strictEqual(out.result.error.code, 'CHECKOUT_UNAVAILABLE');
  assert.ok(out.logs[0].indexOf('httpStatus=402') !== -1);
  assert.ok(out.logs[0].indexOf('stripeErrorCode= ') !== -1, 'codeは空');
  assert.ok(out.logs[0].indexOf('stripeErrorType=invalid_request_error') !== -1);
});

test('非JSONレスポンス: ログ処理で本来のエラーが上書きされない', function () {
  var out = failingJoin({ responseCode: 502, contentText: '<html>Bad Gateway</html>' });
  assert.strictEqual(out.result.error.code, 'CHECKOUT_UNAVAILABLE');
  assert.ok(out.logs[0].indexOf('httpStatus=502') !== -1);
  assert.strictEqual(out.all.indexOf('<html>'), -1, 'response body全文は出さない');
});

test('秘密情報: message内の鍵・Bearer・token・client_secret・URLは伏せられ、body全文も出ない', function () {
  var out = failingJoin({ responseCode: 401, body: {
    error: {
      code: 'api_key_invalid', type: 'authentication_error',
      message: 'Invalid API Key provided: sk_live_abcd1234 Authorization: Bearer abc.def.ghi access_token=tok_999 client_secret=cs_test_a1_secret_zzz see https://checkout.stripe.com/c/pay/cs_test_x'
    },
    client_secret: 'pi_1_secret_LEAKME', url: 'https://checkout.stripe.com/c/pay/LEAKURL'
  } });
  assert.ok(out.logs[0].indexOf('httpStatus=401') !== -1);
  assert.ok(out.logs[0].indexOf('stripeErrorCode=api_key_invalid') !== -1);
  ['sk_live_abcd1234', SECRET_KEY, 'Bearer abc', 'abc.def.ghi', 'tok_999', 'cs_test_a1_secret_zzz', 'cs_test_x', 'LEAKME', 'LEAKURL', 'checkout.stripe.com', 'Authorization: Bearer']
    .forEach(function (secret) {
      assert.strictEqual(out.all.indexOf(secret), -1, 'ログに出てはいけない: ' + secret);
    });
});

test('長いmessageは切り詰められる', function () {
  var out = failingJoin({ responseCode: 400, body: { error: { type: 'invalid_request_error', message: 'x'.repeat(5000) } } });
  assert.ok(out.logs[0].length < 600);
});
