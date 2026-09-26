/*
 * StripeWebhookHandler.processEventの統合テスト（Issue #341 PR-C「10. 必須テスト」）。
 * Stripe API・Calendar・Sheets・メールはすべてスタブを使う。
 *
 * 受入条件との対応:
 * - 同一イベントの重複配信と並行配信で二重確定・二重メールが起きない。
 * - イベント処理途中の失敗後、安全に再試行できる。
 * - 未払いのSession完了イベントでは予約確定しない。
 * - 金額・通貨・予約ID・Session ID・決済試行IDの不一致を拒否する。
 * - 決済成功と仮押さえ失効が競合しても、枠の解放と予約確定が二重に成立しない。
 * - 失効済み・キャンセル済み・枠を失った予約への遅延決済をRecoveryへ送る。
 * - 決済状態の保存後に予約確定が失敗しても、入金済みの記録を保持する。
 * - Webhook再送で確認メールを二重送信しない。
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
  'StripeEventRepository.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'BookingRepository.gs',
  'StripeWebhookHandler.gs'
];

var SPREADSHEET_ID = 'ss1';
var CALENDAR_ID = 'cal1';
var SESSION_ID = 'cs_test_0001';
var PAYMENT_INTENT_ID = 'pi_test_0001';
var BOOKING_ID = 'SX-20261001-AAAAAAAA';
var PAYMENT_ATTEMPT_ID = 'PAY-' + BOOKING_ID + '-ABCDEF012345';

var MAIL_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

function sampleRecord(overrides) {
  return Object.assign(
    {
      bookingId: BOOKING_ID,
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
      paymentStatus: 'checkout_pending',
      priceAmount: 8000,
      priceOverrideAmount: '',
      priceOverrideAt: '',
      checkoutAccessToken: 'token-0001',
      paymentAttemptId: PAYMENT_ATTEMPT_ID,
      paymentAttemptResolvedAt: new Date('2026-09-20T10:05:00+09:00'),
      stripeCheckoutSessionId: SESSION_ID,
      stripeAmount: 8000,
      stripeCurrency: 'JPY',
      paymentHoldExpiresAt: new Date('2026-09-20T10:35:00+09:00')
    },
    overrides || {}
  );
}

function buildEvent(type, sessionOverrides) {
  return JSON.stringify({
    id: 'evt_' + Math.random().toString(36).slice(2),
    type: type,
    data: {
      object: Object.assign({ id: SESSION_ID }, sessionOverrides || {})
    }
  });
}

/* 事前定義済みのCheckout Session / PaymentIntentの状態を、UrlFetchAppスタブ経由で
   返すデフォルトのStripeレスポンダ。amountTotal/paymentStatus等はoptsで上書きできる。 */
function makeStripeResponder(opts) {
  var state = Object.assign(
    {
      sessionStatus: 'complete',
      paymentStatus: 'paid',
      amountTotal: 8000,
      currency: 'jpy',
      paymentIntentId: PAYMENT_INTENT_ID,
      metadata: { bookingId: BOOKING_ID, brand: 'studio_x', paymentAttemptId: PAYMENT_ATTEMPT_ID },
      paymentIntentStatus: 'succeeded',
      amountReceived: 8000
    },
    opts || {}
  );
  return function (url, options) {
    if (url.indexOf('/checkout/sessions/') !== -1) {
      return {
        responseCode: 200,
        body: {
          id: SESSION_ID,
          status: state.sessionStatus,
          payment_status: state.paymentStatus,
          amount_total: state.amountTotal,
          currency: state.currency,
          payment_intent: state.paymentIntentId,
          metadata: state.metadata
        }
      };
    }
    if (url.indexOf('/payment_intents/') !== -1) {
      return {
        responseCode: 200,
        body: {
          id: state.paymentIntentId,
          status: state.paymentIntentStatus,
          amount_received: state.amountReceived,
          currency: state.currency
        }
      };
    }
    throw new Error('未対応のURL: ' + url);
  };
}

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign(
    { SPREADSHEET_ID: SPREADSHEET_ID, CALENDAR_ID: CALENDAR_ID, STRIPE_SECRET_KEY: 'sk_test_dummy' },
    MAIL_PROPERTIES,
    opts.properties || {}
  );
  var urlFetchApp = opts.urlFetchApp || stubs.createUrlFetchAppStub(makeStripeResponder(opts.stripeState));
  var mailApp = opts.mailApp || stubs.createMailAppStub();
  var events = opts.events || [];
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: opts.calendarApp || stubs.createCalendarAppStub({ cal1: { events: events } }),
    UrlFetchApp: urlFetchApp,
    Utilities: stubs.createUtilitiesStub(),
    MailApp: mailApp,
    Logger: stubs.createLoggerStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, mailApp: mailApp, urlFetchApp: urlFetchApp, events: events };
}

function createBookingRow(ctx, overrides) {
  var record = sampleRecord(overrides);
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);
  return record.bookingId;
}

/* sampleRecord()のcalendarEventId（固定'event-1'）と必ず一致させる。
   CalendarApp stub.createEvent()はランダムなidを発行するため、confirmBookingが
   record.calendarEventIdで検索したときに見つからず誤ってCALENDAR_EVENT_MISSINGになるのを
   防ぐには、id固定でイベントスタブを直接events配列へ追加する必要がある。 */
function createCalendarEvent(ctx) {
  var start = new Date('2026-10-01T10:00:00+09:00');
  var end = new Date('2026-10-01T12:00:00+09:00');
  var event = stubs.createEventStub({ id: 'event-1', title: 'PENDING studio_x', start: start, end: end, isAllDay: false });
  event.setTag('bookingId', BOOKING_ID);
  ctx.events.push(event);
  return event;
}

/*
 * ============================================================================
 * 正常系: 決済成功 → 予約自動確定 → 確認メール送信
 * ============================================================================
 */

test('processEvent: 決済成功イベントを受けて予約を自動確定し確認メールを送る', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date('2026-09-20T10:10:00+09:00'));

  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'CONFIRMED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(record.stripePaymentIntentId, PAYMENT_INTENT_ID);
  assert.ok(record.confirmedMailSentAt);

  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
  assert.strictEqual(ctx.mailApp._sentEmails[0].to, 'taro@example.com');
});

test('processEvent: async_payment_succeededでも同様に確定する', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.async_payment_succeeded', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'CONFIRMED');
});

/*
 * ============================================================================
 * 冪等性: 同一イベントの重複配信・並行配信
 * ============================================================================
 */

test('processEvent: 同一イベントの再送は二重確定・二重メール送信を起こさない', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_dup_0001';
  var event = JSON.stringify({
    id: eventId, type: 'checkout.session.completed', data: { object: { id: SESSION_ID } }
  });

  var first = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(first.ackSuccess, true);
  assert.strictEqual(first.code, 'CONFIRMED');

  var second = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(second.ackSuccess, true);
  assert.strictEqual(second.code, 'ALREADY_COMPLETED');

  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
});

test('processEvent: 同一イベントの並行配信は二重処理せず一方をIN_PROGRESSで待たせる', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_concurrent_0001';
  var now = new Date('2026-09-20T10:10:00+09:00');
  /* 1つ目のリクエストが既にclaim済み（処理中）という状況を直接再現する。 */
  ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', now);

  var event = JSON.stringify({
    id: eventId, type: 'checkout.session.completed', data: { object: { id: SESSION_ID } }
  });
  var secondRequest = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date(now.getTime() + 1000));
  assert.strictEqual(secondRequest.ackSuccess, false);
  assert.strictEqual(secondRequest.code, 'IN_PROGRESS');

  /* 二重に確定処理が実行されていない（予約はまだPENDINGのまま）。 */
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('processEvent: 処理途中で停止したイベント（RECEIVEDのまま古い）は安全に再試行できる', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_stalled_0001';
  var claimedAt = new Date('2026-09-20T10:00:00+09:00');
  /* 前回の実行がクラッシュし、RECEIVEDのまま放置されていた状況を再現する。 */
  ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', claimedAt);

  var event = JSON.stringify({
    id: eventId, type: 'checkout.session.completed', data: { object: { id: SESSION_ID } }
  });
  /* 6分後（既定staleAfterMs=5分超）に再送された想定。 */
  var retryNow = new Date(claimedAt.getTime() + 6 * 60000);
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, retryNow);

  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'CONFIRMED');
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
});

test('processEvent: イベント結果の永続化自体が失敗した場合は成功扱いにせず、再試行で完了できる', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  /* StripeEventsシートへの最終書き込み（finalize内のgetRange().setValues()）だけを
     1回失敗させる。予約確定・メール送信自体は既に成功済みの状態を作り、
     「永続化できていないイベントを成功扱いにしない」ことを検証する。 */
  var originalGetSheetByName = null;
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = Object.assign(
    { SPREADSHEET_ID: SPREADSHEET_ID, CALENDAR_ID: CALENDAR_ID, STRIPE_SECRET_KEY: 'sk_test_dummy' },
    MAIL_PROPERTIES
  );
  var events = [];
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: events } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(makeStripeResponder()),
    Utilities: stubs.createUtilitiesStub(),
    MailApp: stubs.createMailAppStub(),
    Logger: stubs.createLoggerStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());
  var event = stubs.createEventStub({
    id: 'event-1', title: 'PENDING studio_x',
    start: new Date('2026-10-01T10:00:00+09:00'), end: new Date('2026-10-01T12:00:00+09:00'), isAllDay: false
  });
  event.setTag('bookingId', BOOKING_ID);
  events.push(event);

  var failNext = { value: false };
  /* StripeEvents行のfinalize呼び出し（processingState列へのgetRange）だけを失敗させる
     ため、getDataRange/appendRowは素通しし、getRangeのみ横取りする薄いラッパーにする。 */
  var wrapSheetForFailure = function () {
    var realSheet = null;
    return {
      getName: function () { return realSheet.getName(); },
      appendRow: function (row) {
        if (!realSheet) {
          var sheet = stubs.createSheetStub('StripeEvents');
          realSheet = sheet;
        }
        return realSheet.appendRow(row);
      },
      getLastRow: function () { return realSheet ? realSheet.getLastRow() : 0; },
      getDataRange: function () { return realSheet.getDataRange(); },
      getRange: function () {
        if (failNext.value) {
          throw new Error('injected StripeEvents write failure');
        }
        return realSheet.getRange.apply(realSheet, arguments);
      }
    };
  };
  spreadsheetsById[SPREADSHEET_ID].StripeEvents = wrapSheetForFailure();

  var eventBody = JSON.stringify({
    id: 'evt_ledger_fail_0001', type: 'checkout.session.completed', data: { object: { id: SESSION_ID } }
  });

  failNext.value = true;
  var firstAttempt = sandbox.StripeWebhookHandler.processEvent(eventBody, new Date('2026-09-20T10:10:00+09:00'));
  assert.strictEqual(firstAttempt.ackSuccess, false);
  assert.strictEqual(firstAttempt.code, 'LEDGER_WRITE_FAILED');

  /* 決済・予約確定自体は既に成功している（入金の事実・確定状態は保持される）。 */
  var recordAfterFirst = sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(recordAfterFirst.status, 'CONFIRMED');
  assert.strictEqual(recordAfterFirst.paymentStatus, 'paid');
  assert.strictEqual(sandbox.MailApp = globals.MailApp, globals.MailApp);
  assert.strictEqual(globals.MailApp._sentEmails.length, 1);

  /* 再試行（StripeEvents書き込みは今度は成功する）。行はRECEIVEDのまま残っているため
     再claimして安全に完了できる。予約は既にCONFIRMED・メール送信済みのため二重実行しない。 */
  failNext.value = false;
  var retry = sandbox.StripeWebhookHandler.processEvent(eventBody, new Date('2026-09-20T10:16:00+09:00'));
  assert.strictEqual(retry.ackSuccess, true);
  assert.strictEqual(retry.code, 'CONFIRMED');
  assert.strictEqual(globals.MailApp._sentEmails.length, 1);
});

/*
 * ============================================================================
 * 未払い・支払い未確定のイベントでは確定しない
 * ============================================================================
 */

test('processEvent: payment_statusがpaidでないcheckout.session.completedでは確定しない', function () {
  var ctx = setup({ stripeState: { paymentStatus: 'unpaid', sessionStatus: 'open' } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'PAYMENT_NOT_YET_COMPLETE');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
});

test('processEvent: PaymentIntentのstatusがsucceededでない場合はSession完了と同一視せず確定しない', function () {
  var ctx = setup({ stripeState: { paymentIntentStatus: 'processing' } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'PAYMENT_INTENT_STATUS_MISMATCH');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
  assert.ok(record.paymentRecoveryRequiredAt);
});

/*
 * ============================================================================
 * 識別子・金額の不一致
 * ============================================================================
 */

test('processEvent: 決済試行IDが台帳と一致しない場合は自動確定せずRecoveryへ記録する', function () {
  var ctx = setup({ stripeState: { metadata: { bookingId: BOOKING_ID, brand: 'studio_x', paymentAttemptId: 'PAY-OLD-ATTEMPT' } } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'IDENTITY_MISMATCH');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
  assert.ok(record.paymentRecoveryRequiredAt);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'STRIPE_WEBHOOK_IDENTITY_MISMATCH');
});

test('processEvent: 金額が台帳のスナップショットと一致しない場合はRecoveryへ記録する', function () {
  var ctx = setup({ stripeState: { amountReceived: 999999 } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'AMOUNT_MISMATCH');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
  assert.ok(record.paymentRecoveryRequiredAt);
});

test('processEvent: 通貨が台帳のスナップショットと一致しない場合はRecoveryへ記録する', function () {
  var ctx = setup({ stripeState: { currency: 'usd' } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'CURRENCY_MISMATCH');
});

test('processEvent: 予約IDがBookings台帳に見つからない場合はRecoveryへ記録する', function () {
  var ctx = setup({ stripeState: { metadata: { bookingId: 'UNKNOWN-BOOKING', brand: 'studio_x', paymentAttemptId: PAYMENT_ATTEMPT_ID } } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'BOOKING_NOT_FOUND');

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].bookingId, 'UNKNOWN-BOOKING');
});

/*
 * ============================================================================
 * 失効処理（expirePendingBookings）との競合
 * ============================================================================
 */

test('processEvent → expirePendingBookings: Webhookが先に確定した場合、失効処理は枠を解放しない', function () {
  var ctx = setup();
  createBookingRow(ctx, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEvent(ctx);

  var confirmResult = ctx.sandbox.StripeWebhookHandler.processEvent(buildEvent('checkout.session.completed', {}), new Date('2026-09-20T10:10:00+09:00'));
  assert.strictEqual(confirmResult.code, 'CONFIRMED');

  /* Stripe側は「安全に失効させてよい」と報告する設定のまま、expirePendingBookingsを
     同じLockServiceで実行する。既にCONFIRMED済みのため、Lock保護された再確認で
     スキップされ、Calendarイベントは削除されない。 */
  var expireStripeResponder = function (url) {
    if (url.indexOf('/checkout/sessions/') !== -1) {
      return { responseCode: 200, body: { id: SESSION_ID, status: 'expired', payment_status: 'unpaid' } };
    }
    throw new Error('未対応のURL: ' + url);
  };
  ctx.urlFetchApp._calls.length = 0;
  var previousFetch = ctx.sandbox.UrlFetchApp.fetch;
  ctx.sandbox.UrlFetchApp.fetch = function (url, options) {
    var result = expireStripeResponder(url);
    return {
      getResponseCode: function () { return result.responseCode; },
      getContentText: function () { return JSON.stringify(result.body); }
    };
  };

  var expireResult = ctx.sandbox.BookingRepository.expirePendingBookings(new Date('2026-09-20T11:00:00+09:00'));
  assert.strictEqual(expireResult.expiredCount, 0);

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(record.paymentStatus, 'paid');

  var calendarEvent = ctx.sandbox.CalendarApp.getCalendarById(CALENDAR_ID).getEventById('event-1') || ctx.sandbox.CalendarApp.getCalendarById(CALENDAR_ID).getEvents()[0];
  assert.ok(calendarEvent);
  assert.strictEqual(calendarEvent.isDeleted(), false);
});

test('processEvent: 失効処理が先に完了していた場合、遅延した決済成功はRecoveryへ送られ入金は保持される', function () {
  var ctx = setup();
  createBookingRow(ctx, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEvent(ctx);

  /* Stripe側は既に失効・未払いと確認できる状態。expirePendingBookingsが先に枠を解放する。 */
  var expireResponder = function (url) {
    if (url.indexOf('/checkout/sessions/') !== -1) {
      return { responseCode: 200, body: { id: SESSION_ID, status: 'expired', payment_status: 'unpaid' } };
    }
    throw new Error('未対応のURL: ' + url);
  };
  ctx.sandbox.UrlFetchApp.fetch = function (url) {
    var result = expireResponder(url);
    return { getResponseCode: function () { return result.responseCode; }, getContentText: function () { return JSON.stringify(result.body); } };
  };
  var expireResult = ctx.sandbox.BookingRepository.expirePendingBookings(new Date('2026-09-20T11:00:00+09:00'));
  assert.strictEqual(expireResult.expiredCount, 1);

  var afterExpire = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(afterExpire.status, 'EXPIRED');
  assert.strictEqual(afterExpire.paymentStatus, 'failed');

  /* その直後、実際には決済が完了していたという遅延Webhookが届く（Stripe側の実際の
     応答を成功状態に差し替える）。 */
  ctx.sandbox.UrlFetchApp.fetch = function (url, options) {
    var responder = makeStripeResponder();
    var result = responder(url, options);
    return { getResponseCode: function () { return result.responseCode; }, getContentText: function () { return JSON.stringify(result.body); } };
  };

  var lateEvent = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(lateEvent, new Date('2026-09-20T11:05:00+09:00'));
  assert.strictEqual(result.ackSuccess, true);
  /* 決済試行ID・Session IDは一致する（expirePendingBookingsはpaymentAttemptIdを変更
     しない）が、paymentStatusは既に'failed'へ進んでいるため'paid'への遷移自体が
     許可されない（Booking.PAYMENT_STATUS_TRANSITIONS_）。Stripe側は入金完了と報告して
     いるため、これを黙って無視せずRecoveryへ記録する（StripeWebhookHandler.gsの
     SELF_RECORDING_PAYMENT_UPDATE_ERROR_CODES_に含まれないコードの扱い）。 */
  assert.strictEqual(result.code, 'INVALID_PAYMENT_TRANSITION');

  /* 入金の事実は消さない: EXPIRED状態のまま予約を勝手にCONFIRMEDへ戻さないが、
     要復旧としてRecoveryへ記録される。 */
  var finalRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(finalRecord.status, 'EXPIRED');
  assert.strictEqual(finalRecord.paymentStatus, 'failed');
  assert.ok(finalRecord.paymentRecoveryRequiredAt);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) { return r.bookingId === BOOKING_ID && r.failureType === 'STRIPE_WEBHOOK_PAYMENT_UPDATE_REJECTED'; }));
});

/*
 * ============================================================================
 * キャンセル済み・Calendarイベント消失への遅延決済
 * ============================================================================
 */

test('processEvent: 決済状態の保存後に予約確定が失敗しても、入金済みの記録を保持する（Calendarイベント消失）', function () {
  var ctx = setup();
  createBookingRow(ctx);
  /* Calendarイベントを作らない＝confirmBookingがCALENDAR_EVENT_MISSINGで失敗する状況。 */

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'PAID_CONFIRM_BLOCKED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  /* 決済状態は保持される（勝手に未払いへ戻さない）。 */
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(record.status, 'PENDING');
  assert.ok(record.paymentRecoveryRequiredAt);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) { return r.failureType === 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED'; }));
});

test('processEvent: キャンセル済みの予約への遅延決済はRecoveryへ送られ、確定しない', function () {
  var ctx = setup();
  createBookingRow(ctx, { status: 'CANCELLED' });
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'PAID_CONFIRM_BLOCKED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CANCELLED');
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.ok(record.paymentRecoveryRequiredAt);
});

/*
 * ============================================================================
 * 対象外イベント種別・非同期決済失敗
 * ============================================================================
 */

test('processEvent: 対象外のイベント種別は何もせずIGNOREDとして成功扱いにする', function () {
  var ctx = setup();
  createBookingRow(ctx);

  var event = JSON.stringify({ id: 'evt_other', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'IGNORED_EVENT_TYPE');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
});

test('processEvent: checkout.session.async_payment_failedは現在の決済試行をfailedへ進める', function () {
  var ctx = setup({ stripeState: { paymentStatus: 'unpaid', sessionStatus: 'open' } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.async_payment_failed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'MARKED_FAILED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.paymentStatus, 'failed');
  assert.strictEqual(record.status, 'PENDING');
});

test('processEvent: async_payment_failedが既存の成功を巻き戻さない', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  /* 決済は既に成功済み。 */
  var successEvent = buildEvent('checkout.session.completed', {});
  ctx.sandbox.StripeWebhookHandler.processEvent(successEvent, new Date('2026-09-20T10:10:00+09:00'));

  /* 順序逆転で失敗イベントが後から届く（Stripe側は既にpaid）。 */
  var failedEvent = buildEvent('checkout.session.async_payment_failed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(failedEvent, new Date('2026-09-20T10:11:00+09:00'));
  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'SUPERSEDED_BY_SUCCESS');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(record.status, 'CONFIRMED');
});

/*
 * ============================================================================
 * Stripeへの照会失敗は未払いと決めつけず再試行可能な状態にする
 * ============================================================================
 */

test('processEvent: Checkout Session再取得が失敗した場合は未払いと決めつけず再試行させる', function () {
  var ctx = setup({
    urlFetchApp: stubs.createUrlFetchAppStub(function () {
      throw new Error('network down');
    })
  });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('checkout.session.completed', {});
  var result = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date());
  assert.strictEqual(result.ackSuccess, false);
  assert.strictEqual(result.code, 'STRIPE_LOOKUP_FAILED');

  /* この配信では確定しないままRECEIVEDとして残る（次回の再送で再試行できる）。 */
  var found = ctx.sandbox.StripeEventRepository.findByEventId(JSON.parse(event).id);
  assert.strictEqual(found.record.processingState, 'RECEIVED');
});
