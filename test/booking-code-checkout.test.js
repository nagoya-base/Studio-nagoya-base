/*
 * gas/booking/public/Code.gsのdoPost振り分け（Issue #341 PR-B: action=startCardCheckout）
 * のテスト。BookingRepository.beginCardCheckoutそのものの実装はtest/booking-card-checkout.
 * test.jsで検証済みのため、ここではCode.gs側の配線（action判定・bookingId以外の入力を
 * 無視すること・createBookingの既存動作を壊さないこと）のみを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs',
  'CalendarRepository.gs',
  'Availability.gs',
  'Booking.gs',
  'CardPayment.gs',
  'StripeGateway.gs',
  'JapaneseHolidays.gs',
  'BookingPricing.gs',
  'RateLimiter.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingRepository.gs',
  'AdminNotifier.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'Code.gs'
];

var SPREADSHEET_ID = 'ss1';
var CALENDAR_ID = 'cal1';

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign(
    {
      SPREADSHEET_ID: SPREADSHEET_ID,
      CALENDAR_ID: CALENDAR_ID,
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_CHECKOUT_ENABLED: 'true',
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.com/success',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://example.com/cancel',
      BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
      BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
      BOOKING_CONTACT_EMAIL: 'contact@example.com'
    },
    opts.properties || {}
  );

  var urlFetchApp = opts.urlFetchApp || stubs.createUrlFetchAppStub(function (url, options2) {
    var idKey = options2.headers['Idempotency-Key'];
    return {
      responseCode: 200,
      body: { id: 'cs_' + idKey, url: 'https://checkout.stripe.com/pay/cs_' + idKey, status: 'open', payment_status: 'unpaid', expires_at: 1999999999 }
    };
  });

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    UrlFetchApp: urlFetchApp,
    Utilities: stubs.createUtilitiesStub(),
    MailApp: stubs.createMailAppStub(),
    ContentService: stubs.createContentServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, globals: globals, urlFetchApp: urlFetchApp };
}

function sampleRecord(overrides) {
  return Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      createdAt: new Date('2026-09-20T10:00:00+09:00'),
      date: '2026-10-01',
      startAt: new Date('2026-10-01T10:00:00+09:00'),
      endAt: new Date('2026-10-01T12:00:00+09:00'),
      brand: 'studio_x',
      name: '山田太郎',
      email: 'taro@example.com',
      phone: '090-0000-0000',
      people: '2名',
      purpose: '緊縛の自主練習',
      paymentMethod: 'オンラインクレジットカード',
      status: 'PENDING',
      calendarEventId: 'event-1',
      source: 'test',
      note: '',
      paymentStatus: 'not_started',
      priceAmount: 8000,
      priceOverrideAmount: '',
      priceOverrideAt: ''
    },
    overrides || {}
  );
}

function createBookingRow(ctx, overrides) {
  var record = sampleRecord(overrides);
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);
  return record.bookingId;
}

function postJson(sandbox, action, body) {
  var e = {
    parameter: action ? { action: action } : {},
    postData: { contents: JSON.stringify(body || {}) }
  };
  var output = sandbox.doPost(e);
  return JSON.parse(output.text);
}

test('doPost action=startCardCheckout: bookingIdだけを渡した正常系はCheckout URLを返す', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var result = postJson(ctx.sandbox, 'startCardCheckout', { bookingId: bookingId });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.ok(result.checkoutUrl.indexOf('checkout.stripe.com') !== -1);
  assert.ok(result.requestId);
});

test('doPost action=startCardCheckout: bookingId以外にamount/currencyを送っても無視され、サーバー計算額のみが使われる（クライアント改ざん耐性）', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { priceAmount: 9500 });

  var result = postJson(ctx.sandbox, 'startCardCheckout', { bookingId: bookingId, amountJpy: 1, currency: 'USD' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.amount, 9500, 'クライアントが送ったamountJpy(1)は一切使われない');
  assert.strictEqual(result.currency, 'JPY', 'クライアントが送ったcurrency(USD)は一切使われない');
});

test('doPost action=startCardCheckout: bookingId未指定はINVALID_BOOKING_IDを返し、BookingRepositoryを一切呼ばない', function () {
  var ctx = setup();
  var result = postJson(ctx.sandbox, 'startCardCheckout', {});
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_BOOKING_ID');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('doPost action=startCardCheckout: 不正なJSON本文はINVALID_JSONを返す', function () {
  var ctx = setup();
  var e = { parameter: { action: 'startCardCheckout' }, postData: { contents: '{invalid' } };
  var output = ctx.sandbox.doPost(e);
  var result = JSON.parse(output.text);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_JSON');
});

test('doPost action未指定は従来どおりcreateBookingへ振り分ける（既存動作の回帰確認）', function () {
  var ctx = setup();
  var e = {
    parameter: {},
    postData: {
      contents: JSON.stringify({
        brand: 'studio_x', customerType: 'returning', date: '2026-10-05', startTime: '10:00',
        durationMinutes: 120, name: 'テスト太郎', email: 'test@example.com', phone: '',
        people: '2名', purpose: '練習', paymentMethod: '現金'
      })
    }
  };
  var result = JSON.parse(ctx.sandbox.doPost(e).text);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.status, 'PENDING');
});
