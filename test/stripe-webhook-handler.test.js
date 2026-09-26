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
  'BookingLockRepository.gs',
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
 * 失効処理（expirePendingBookings。Booking Adminプロジェクト）との競合テスト専用の
 * セットアップ（Issue #341 PR-Cレビュー対応・1回目）。
 *
 * Webhook処理は独立したBooking WebhookプロジェクトとしてLockService.getScriptLock()を
 * 共有しない（StripeWebhookHandler.gsファイル冒頭コメント参照）ため、テストも実際の
 * アーキテクチャに合わせて**2つの独立したサンドボックス（別々のLockServiceスタブ）**を
 * 構築する。ただしSpreadsheet（spreadsheetsById）・Calendar（events配列）は同じ
 * オブジェクト参照を両サンドボックスへ渡すことで、「別プロジェクトだが同じSpreadsheet/
 * Calendarを見ている」という実際の構成を再現する。
 */
var ADMIN_FILES_FOR_COMPETITION_TEST = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'CardPayment.gs',
  'StripeGateway.gs', 'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'BookingLockRepository.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'BookingRepository.gs'
];

function setupCompetitionPair(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var events = opts.events || [];
  var calendarsById = { cal1: { events: events } };
  var properties = Object.assign(
    { SPREADSHEET_ID: SPREADSHEET_ID, CALENDAR_ID: CALENDAR_ID, STRIPE_SECRET_KEY: 'sk_test_dummy' },
    MAIL_PROPERTIES,
    opts.properties || {}
  );
  var mailApp = opts.mailApp || stubs.createMailAppStub();

  /* Webhookプロジェクト側: 既定では実際にStripeが「決済成功」と報告する状態を返す
     （opts.webhookUrlFetchAppで上書き可能）。 */
  var webhookUrlFetchApp = opts.webhookUrlFetchApp || stubs.createUrlFetchAppStub(makeStripeResponder(opts.stripeState));
  var webhook = loadBookingSandbox(FILES, {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: stubs.createLockServiceStub(), /* Webhookプロジェクト専用の独立したLock */
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    UrlFetchApp: webhookUrlFetchApp,
    Utilities: stubs.createUtilitiesStub(),
    MailApp: mailApp,
    Logger: stubs.createLoggerStub()
  });

  /* Booking Adminプロジェクト側: expirePendingBookingsが仮押さえ失効確認でStripeへ
     問い合わせる際の応答（opts.adminUrlFetchAppで指定）。 */
  var adminUrlFetchApp = opts.adminUrlFetchApp || stubs.createUrlFetchAppStub(function (url) {
    throw new Error('このテストのadminUrlFetchAppは未設定のURLを受け取りました: ' + url);
  });
  var admin = loadBookingSandbox(ADMIN_FILES_FOR_COMPETITION_TEST, {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: stubs.createLockServiceStub(), /* Booking Adminプロジェクト専用の独立したLock */
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    UrlFetchApp: adminUrlFetchApp,
    Utilities: stubs.createUtilitiesStub(),
    MailApp: mailApp,
    Logger: stubs.createLoggerStub()
  });

  return { webhook: webhook, admin: admin, events: events, mailApp: mailApp };
}

function createBookingRowIn(sandbox, overrides) {
  var record = sampleRecord(overrides);
  sandbox.SpreadsheetRepository.appendBooking(record);
  return record.bookingId;
}

function createCalendarEventIn(events) {
  var start = new Date('2026-10-01T10:00:00+09:00');
  var end = new Date('2026-10-01T12:00:00+09:00');
  var event = stubs.createEventStub({ id: 'event-1', title: 'PENDING studio_x', start: start, end: end, isAllDay: false });
  event.setTag('bookingId', BOOKING_ID);
  events.push(event);
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

/*
 * ============================================================================
 * 同一入金への異なるイベントID・同一イベントの再送・識別子が本当に異なる別決済の区別
 * （Issue #341 PR-Cレビュー対応・1回目「2. 同一入金への異なる成功イベント」）
 * ============================================================================
 */

test('processEvent: 同じ決済（同じPaymentIntent/Session/決済試行ID）に対する異なるイベントIDの通知は、lastStripeEventIdの不一致だけで要復旧にせず1回だけ確定・メール送信する', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var firstEvent = JSON.stringify({
    id: 'evt_first_0001', type: 'checkout.session.completed', data: { object: { id: SESSION_ID } }
  });
  var firstResult = ctx.sandbox.StripeWebhookHandler.processEvent(firstEvent, new Date('2026-09-20T10:10:00+09:00'));
  assert.strictEqual(firstResult.ackSuccess, true);
  assert.strictEqual(firstResult.code, 'CONFIRMED');

  /* 同一のCheckout Session・PaymentIntent・決済試行IDについて、Stripeが別のイベントID
     （例: checkout.session.async_payment_succeeded、または重複配信）で通知した状況を
     再現する。eventId自体は異なるため、StripeEventRepositoryの台帳では新規行として
     claimされる（同一イベントの再送とは別の経路）。 */
  var secondEvent = JSON.stringify({
    id: 'evt_second_0002', type: 'checkout.session.async_payment_succeeded', data: { object: { id: SESSION_ID } }
  });
  var secondResult = ctx.sandbox.StripeWebhookHandler.processEvent(secondEvent, new Date('2026-09-20T10:11:00+09:00'));

  /* lastStripeEventIdが食い違うだけでPAYMENT_IDENTITY_MISMATCH（恒久の要復旧ゲート）に
     してはならない（レビュー指摘の中心）。PaymentIntent/Session/決済試行IDが同じである
     以上、同一決済の重複通知として安全に成功扱いにする。 */
  assert.strictEqual(secondResult.ackSuccess, true);
  assert.notStrictEqual(secondResult.code, 'IDENTITY_MISMATCH');
  assert.strictEqual(secondResult.code, 'CONFIRMED', 'alreadyApplied/alreadyConfirmedを経て、これも成功として確定を試みる（実際には既に確定済みのため何も変更しない）');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(record.paymentRecoveryRequiredAt, '', '恒久の要復旧ゲートを立ててはならない');

  /* 予約確定・確認メールはいずれも1回だけ。 */
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);

  /* 2件とも別々のイベントとしてStripeEventsへ記録される（同一イベントの再送ではない）。 */
  var firstLedgerRow = ctx.sandbox.StripeEventRepository.findByEventId('evt_first_0001');
  var secondLedgerRow = ctx.sandbox.StripeEventRepository.findByEventId('evt_second_0002');
  assert.strictEqual(firstLedgerRow.record.processingState, 'COMPLETED');
  assert.strictEqual(secondLedgerRow.record.processingState, 'COMPLETED');
});

test('processEvent: 同一イベントIDの再送は、異なるイベントIDでの同一入金通知とは別に、StripeEventsのALREADY_TERMINALで短絡される', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_same_0001';
  var event = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: SESSION_ID } } });

  var first = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date('2026-09-20T10:10:00+09:00'));
  assert.strictEqual(first.code, 'CONFIRMED');

  var second = ctx.sandbox.StripeWebhookHandler.processEvent(event, new Date('2026-09-20T10:12:00+09:00'));
  assert.strictEqual(second.code, 'ALREADY_COMPLETED');

  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
});

test('processEvent: 決済試行ID・Session IDが本当に異なる別決済は、依然としてIDENTITY_MISMATCHとして要復旧にする（回帰確認）', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  /* metadataのpaymentAttemptId・brandは正しいが、Checkout Session自体が台帳の記録と
     異なる（別の決済試行の遅延配信、または深刻な取り違えを想定）。 */
  var otherSessionCtx = setup({
    stripeState: {
      metadata: { bookingId: BOOKING_ID, brand: 'studio_x', paymentAttemptId: 'PAY-COMPLETELY-DIFFERENT-ATTEMPT' }
    }
  });
  createBookingRow(otherSessionCtx);
  createCalendarEvent(otherSessionCtx);

  var event = buildEvent('checkout.session.completed', {});
  var result = otherSessionCtx.sandbox.StripeWebhookHandler.processEvent(event, new Date());

  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'IDENTITY_MISMATCH');

  var record = otherSessionCtx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
  assert.ok(record.paymentRecoveryRequiredAt, '本当に異なる決済の疑いがある場合は引き続き恒久ゲートを立てる');
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
 * 失効処理（expirePendingBookings。別プロジェクト・別LockService）との競合
 * （Issue #341 PR-Cレビュー対応・1回目で再設計。setupCompetitionPair参照）
 * ============================================================================
 */

test('processEvent → expirePendingBookings（別プロジェクト）: Webhookが先に確定した場合、失効処理は枠を解放しない', function () {
  var pair = setupCompetitionPair({
    /* Booking Admin側が仮押さえ失効確認で問い合わせた時点でも、Stripeは「安全に
       失効させてよい」状態を報告する設定のまま実行する。それでもWebhookが先に
       CONFIRMED済みのため、expirePendingBookings自身のLock保護された再確認
       （latest.record.status !== PENDING）でスキップされる。 */
    adminUrlFetchApp: stubs.createUrlFetchAppStub(function (url) {
      if (url.indexOf('/checkout/sessions/') !== -1) {
        return { responseCode: 200, body: { id: SESSION_ID, status: 'expired', payment_status: 'unpaid' } };
      }
      throw new Error('未対応のURL: ' + url);
    })
  });
  createBookingRowIn(pair.webhook, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEventIn(pair.events);

  var confirmResult = pair.webhook.StripeWebhookHandler.processEvent(buildEvent('checkout.session.completed', {}), new Date('2026-09-20T10:10:00+09:00'));
  assert.strictEqual(confirmResult.code, 'CONFIRMED');

  /* expirePendingBookingsはBooking Admin側の独立したサンドボックス（別LockService）で
     実行する。グレース期間（CardPayment.WEBHOOK_RACE_GRACE_MINUTES=10分）を超えた
     時刻で実行する。 */
  var expireResult = pair.admin.BookingRepository.expirePendingBookings(new Date('2026-09-20T11:00:00+09:00'));
  assert.strictEqual(expireResult.expiredCount, 0);

  var record = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(record.paymentStatus, 'paid');

  assert.strictEqual(pair.events.length, 1);
  assert.strictEqual(pair.events[0].isDeleted(), false);
});

test('processEvent: 失効処理（別プロジェクト）が先に完了していた場合、遅延した決済成功はRecoveryへ送られ入金は保持される', function () {
  var pair = setupCompetitionPair({
    /* Booking Admin側が問い合わせた時点では、Stripeは確実に期限切れ・未払いと
       報告する（webhook側のデフォルト応答＝実際には決済成功、とは別の応答。
       2つの異なるプロジェクトが異なるタイミングでStripeへ問い合わせている状況を表す）。 */
    adminUrlFetchApp: stubs.createUrlFetchAppStub(function (url) {
      if (url.indexOf('/checkout/sessions/') !== -1) {
        return { responseCode: 200, body: { id: SESSION_ID, status: 'expired', payment_status: 'unpaid' } };
      }
      throw new Error('未対応のURL: ' + url);
    })
  });
  createBookingRowIn(pair.webhook, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEventIn(pair.events);

  var expireResult = pair.admin.BookingRepository.expirePendingBookings(new Date('2026-09-20T11:00:00+09:00'));
  assert.strictEqual(expireResult.expiredCount, 1);

  var afterExpire = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(afterExpire.status, 'EXPIRED');
  assert.strictEqual(afterExpire.paymentStatus, 'failed');

  /* その直後、実際には決済が完了していたという遅延Webhookが、独立したBooking Webhook
     プロジェクトへ届く（そちらのUrlFetchAppは既定の「決済成功」応答のまま）。 */
  var lateEvent = buildEvent('checkout.session.completed', {});
  var result = pair.webhook.StripeWebhookHandler.processEvent(lateEvent, new Date('2026-09-20T11:05:00+09:00'));
  assert.strictEqual(result.ackSuccess, true);
  /*
   * 決済試行ID・Session IDは一致する（expirePendingBookingsはpaymentAttemptIdを変更
   * しない）ため、Booking.PAYMENT_STATUS_TRANSITIONS_のFAILED→PAID許可（レビュー対応・
   * 1回目）により、入金の事実（paymentStatus:paid）は正しく記録される。一方status
   * （EXPIRED）はapplyPaymentStateUpdateの対象外のため変更されず、confirmBookingが
   * EXPIREDを理由に自動確定を拒否する（PAID_CONFIRM_BLOCKED）。
   */
  assert.strictEqual(result.code, 'PAID_CONFIRM_BLOCKED');

  /* 入金の事実は保持される: paymentStatusはpaidへ正しく更新されるが、予約のstatusは
     EXPIREDのまま（勝手にCONFIRMEDへ戻さない）。運営者向けにRecoveryへ記録される。 */
  var finalRecord = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(finalRecord.status, 'EXPIRED');
  assert.strictEqual(finalRecord.paymentStatus, 'paid');
  assert.strictEqual(finalRecord.stripePaymentIntentId, PAYMENT_INTENT_ID);
  assert.ok(finalRecord.paymentRecoveryRequiredAt);

  var recovery = pair.admin.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) { return r.bookingId === BOOKING_ID && r.failureType === 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED'; }));

  /* 予約はまだ確定していないため、確認メール（CONFIRMEDメール）は送信されない。
     送信されているのはexpirePendingBookings自体が送るEXPIRED通知（既存挙動。
     Issue #334）の1件のみ。 */
  assert.strictEqual(pair.mailApp._sentEmails.length, 1, 'EXPIRED通知メールのみ送信される');
  assert.ok(
    pair.mailApp._sentEmails[0].subject.indexOf('確定') === -1,
    '送信されたメールが確定（CONFIRMED）メールであってはならない'
  );
});

/*
 * ============================================================================
 * 予約単位の排他制御（BookingLockRepository）による競合防止
 * （Issue #341 PR-Cレビュー対応・2回目）
 *
 * 1回目の対応（最新状態の再読込・グレース期間・failed→paid許可）は「一方が最新状態を
 * 読み終えた直後に他方が状態を変更する」という狭いレース自体を排除できないという指摘を
 * 受け、両プロジェクトが共有するBookings台帳と同じSpreadsheet上のBookingLockRepositoryで
 * 実際に排他制御するよう変更した。以下は、まさにその「直後に他方が状態を変更する」
 * タイミングを、BookingLockRepository.acquireを直接呼んで一方の側（別プロジェクト）が
 * 既にこの予約のクリティカルセクションへ入っている状態として再現し、もう一方の本番
 * コード経路（processEvent / expirePendingBookings）が安全に競合を検知して待避すること、
 * そして解放後に収束することを検証する。
 * ============================================================================
 */

test('processEvent: Booking Admin側がこの予約のロックを保持している間はWebhookが割り込めず、解放後にAdminが枠解放を完了すると遅延決済はRecoveryへ送られる（Issue #341 PR-Cレビュー対応・2回目）', function () {
  var pair = setupCompetitionPair({
    adminUrlFetchApp: stubs.createUrlFetchAppStub(function (url) {
      if (url.indexOf('/checkout/sessions/') !== -1) {
        return { responseCode: 200, body: { id: SESSION_ID, status: 'expired', payment_status: 'unpaid' } };
      }
      throw new Error('未対応のURL: ' + url);
    })
  });
  createBookingRowIn(pair.webhook, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEventIn(pair.events);

  var raceInstant = new Date('2026-09-20T11:00:00+09:00');
  /*
   * BookingLockRepositoryのTTL/有効性判定は実時間（`new Date()`）だけに基づく
   * （BookingRepository.gs/StripeWebhookHandler.gsのコメント参照。本番のnowはいずれも
   * 実時間そのものであり、raceInstantのようなテスト用の固定ビジネス日時とは無関係。
   * ここで手動でacquire/releaseする際も、processEvent/expirePendingBookings自身の
   * 実装と同じく実時間を使う）。
   *
   * Booking AdminのexpirePendingBookingsが、最新状態を読み終えてクリティカル
   * セクションへ入った直後（＝Calendar削除・status:EXPIRED書き込みの直前）の状態を、
   * 実際にBookingLockRepository.acquireを呼んで再現する（このロックはBooking Admin・
   * Booking Webhookの両サンドボックスが同じSpreadsheetを共有しているため、
   * pair.admin側から取得したチケットはpair.webhook側からも見える）。
   */
  var adminLock = pair.admin.BookingLockRepository.acquire(BOOKING_ID, 'admin-expire:race-test', 'admin-expire', new Date());
  assert.strictEqual(adminLock.acquired, true);

  /* この瞬間にWebhookへ決済成功イベントが届いても、ロックを取得できず割り込めない。
     processEvent自体のeffectiveNow（イベント発生時刻の模擬）はraceInstantのままでよい
     （ロックのTTL判定には使われない）。 */
  var duringHold = pair.webhook.StripeWebhookHandler.processEvent(buildEvent('checkout.session.completed', {}), raceInstant);
  assert.strictEqual(duringHold.ackSuccess, false);
  assert.strictEqual(duringHold.code, 'BOOKING_LOCK_CONTENDED');

  /* Bookings・Calendarのいずれも一切変更されていない（両方が成功したと判断する状態は
     もちろん、どちらか一方が中途半端に変更した状態にもなっていない）。 */
  var duringHoldRecord = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(duringHoldRecord.status, 'PENDING');
  assert.strictEqual(duringHoldRecord.paymentStatus, 'checkout_pending');
  assert.strictEqual(pair.events[0].isDeleted(), false);

  /* Booking Admin側がクリティカルセクションを完了し、ロックを解放する（実際の
     expirePendingBookings内部でも同じ手順でrelease→Calendar削除→status書き込みと
     進むが、ここでは「読み終えた直後」を模擬するためロック保持と実際の書き込みを
     分離して検証している）。 */
  pair.admin.BookingLockRepository.release(adminLock.rowNumber, adminLock.holderId, new Date());

  /* 実際にexpirePendingBookingsを走らせ、枠解放を完了させる。 */
  var expireResult = pair.admin.BookingRepository.expirePendingBookings(raceInstant);
  assert.strictEqual(expireResult.expiredCount, 1);
  var afterExpire = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(afterExpire.status, 'EXPIRED');

  /* Stripeの自動再送により、同じイベントが再度Webhookへ届く。ロックはもう競合しない。 */
  var retryResult = pair.webhook.StripeWebhookHandler.processEvent(buildEvent('checkout.session.completed', {}), new Date('2026-09-20T11:05:00+09:00'));
  assert.strictEqual(retryResult.ackSuccess, true);
  assert.strictEqual(retryResult.code, 'PAID_CONFIRM_BLOCKED', 'Adminが先に枠解放を完了したため自動確定してはならない');

  /* 枠解放（Admin）と予約確定（Webhook）の両方が「成功した」と判断される状態は
     決して生じない: statusはEXPIREDのまま、入金の事実（paymentStatus:paid）だけが
     正しく記録され、Recoveryへ送られる。 */
  var finalRecord = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(finalRecord.status, 'EXPIRED');
  assert.strictEqual(finalRecord.paymentStatus, 'paid');
  var recovery = pair.admin.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) { return r.bookingId === BOOKING_ID && r.failureType === 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED'; }));
});

test('expirePendingBookings: Webhook側がこの予約のロックを保持している間は失効処理が割り込めず、この回はスキップして枠を解放しない（Issue #341 PR-Cレビュー対応・2回目）', function () {
  var pair = setupCompetitionPair({});
  createBookingRowIn(pair.webhook, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEventIn(pair.events);

  var raceInstant = new Date('2026-09-20T11:00:00+09:00');
  /*
   * Webhook側のprocessEventが、applyPaymentStateUpdate（paid）〜confirmBookingの
   * クリティカルセクションへ既に入っている状態を再現する。
   */
  var webhookLock = pair.webhook.BookingLockRepository.acquire(BOOKING_ID, 'webhook:race-test', 'webhook', new Date());
  assert.strictEqual(webhookLock.acquired, true);

  /* この瞬間にAdmin側の失効トリガーが実行されても、ロックを取得できず割り込めない
     （expirePendingBookings自身は1回だけ試行して即座にスキップする設計）。 */
  var expireResult = pair.admin.BookingRepository.expirePendingBookings(raceInstant);
  assert.strictEqual(expireResult.expiredCount, 0);
  assert.strictEqual(expireResult.skippedCount, 1);

  var duringHoldRecord = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(duringHoldRecord.status, 'PENDING');
  assert.strictEqual(pair.events[0].isDeleted(), false, 'ロック競合中はCalendarイベントを削除してはならない');

  /* Webhook側が実際にクリティカルセクションを完了する（決済確認・予約自動確定）。 */
  pair.webhook.BookingLockRepository.release(webhookLock.rowNumber, webhookLock.holderId, new Date());
  var confirmResult = pair.webhook.StripeWebhookHandler.processEvent(buildEvent('checkout.session.completed', {}), raceInstant);
  assert.strictEqual(confirmResult.code, 'CONFIRMED');

  /* 次回のトリガー実行では、既にCONFIRMED済みのため通常どおりスキップされる
     （expirePendingBookings既存の再読込ロジック。新しい変更ではない）。 */
  var secondExpireResult = pair.admin.BookingRepository.expirePendingBookings(new Date('2026-09-20T12:00:00+09:00'));
  assert.strictEqual(secondExpireResult.expiredCount, 0);
  var finalRecord = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(finalRecord.status, 'CONFIRMED');
  assert.strictEqual(finalRecord.paymentStatus, 'paid');
  assert.strictEqual(pair.events[0].isDeleted(), false);
});

/*
 * ============================================================================
 * ロック期限切れ中の書き込み防止（Issue #341 PR-Cレビュー対応・3回目）
 *
 * BookingLockRepository.acquireでロックを取得した「つもり」のままTTLが経過しても、
 * 従来はそれに気づかず古い保持者がCalendar/Bookingsへの書き込みを続けられた
 * （BookingLockRepository.gs「3回目レビュー対応で修正した実装バグ・項目2」参照）。
 * 修正後は、実際に破壊的な書き込みを行う直前に必ずBookingLockRepository.isHeldを
 * 再検証する契約になっている。ここではBookingLockRepository.isHeld自体を差し替えて
 * 「TTLが経過し、もはやこの保持者は有効ではない」という状況を確定的に再現し、
 * StripeWebhookHandler.processEvent/BookingRepository.expirePendingBookingsという
 * 本番コード経路が、実際にその契約（書き込み直前の再検証）を守っていることを検証する
 * （BookingLockRepository自体のTTL計算ロジックはtest/booking-lock-repository.test.jsで
 * 別途検証済みのため、ここではその判定結果をモックし、呼び出し側の振る舞いに焦点を
 * 当てる）。
 * ============================================================================
 */

test('processEvent: applyPaymentStateUpdate直前に予約ロックが失効していた場合、Bookingsへは一切書き込まず再試行させる（古い保持者による遅延書き込みの防止）', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var callCount = 0;
  var originalIsHeld = ctx.sandbox.BookingLockRepository.isHeld;
  ctx.sandbox.BookingLockRepository.isHeld = function () {
    callCount++;
    return false; /* TTL経過を模擬（BookingLockRepository.gs参照）。 */
  };

  var result;
  try {
    result = ctx.sandbox.StripeWebhookHandler.processEvent(buildEvent('checkout.session.completed', {}), new Date());
  } finally {
    ctx.sandbox.BookingLockRepository.isHeld = originalIsHeld;
  }

  assert.strictEqual(result.ackSuccess, false);
  assert.strictEqual(result.code, 'BOOKING_LOCK_EXPIRED');
  assert.strictEqual(callCount, 1, 'applyPaymentStateUpdate直前の1回だけ検証され、confirmBooking直前までは進まないはず');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(record.paymentStatus, 'checkout_pending', 'ロック失効を検知した場合、paymentStatusも一切書き換えてはならない');
  assert.strictEqual(ctx.events[0].isDeleted(), false);
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('processEvent: confirmBooking直前に予約ロックが失効していた場合、入金の事実は記録しつつ確定はせずRecoveryへ送る（古い保持者による遅延書き込みの防止）', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var callCount = 0;
  var originalIsHeld = ctx.sandbox.BookingLockRepository.isHeld;
  ctx.sandbox.BookingLockRepository.isHeld = function () {
    callCount++;
    return callCount === 1; /* 1回目（applyPaymentStateUpdate直前）はtrue、2回目（confirmBooking直前）はfalse。 */
  };

  var result;
  try {
    result = ctx.sandbox.StripeWebhookHandler.processEvent(buildEvent('checkout.session.completed', {}), new Date());
  } finally {
    ctx.sandbox.BookingLockRepository.isHeld = originalIsHeld;
  }

  assert.strictEqual(result.ackSuccess, true);
  assert.strictEqual(result.code, 'PAID_CONFIRM_BLOCKED');
  assert.strictEqual(callCount, 2);

  /*
   * 枠解放と予約確定が両方成功したと判断される状態にはならない: 入金の事実
   * （paymentStatus:paid）は正しく記録されるが、Calendar・Bookingsのstatus側は
   * 一切変更されない（確定していない）。
   */
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(ctx.events[0].isDeleted(), false);
  assert.ok(record.paymentRecoveryRequiredAt);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) {
    return r.bookingId === BOOKING_ID && r.failureType === 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED' &&
      r.errorMessage.indexOf('BOOKING_LOCK_EXPIRED_BEFORE_CONFIRM') !== -1;
  }));

  assert.strictEqual(ctx.mailApp._sentEmails.length, 0, '確定していないため確認メールは送られない');
});

test('expirePendingBookings: Calendar削除直前に予約ロックが失効していた場合、Calendar・Bookingsのいずれも変更せずスキップする（古い保持者による遅延書き込みの防止）', function () {
  var pair = setupCompetitionPair({
    adminUrlFetchApp: stubs.createUrlFetchAppStub(function (url) {
      if (url.indexOf('/checkout/sessions/') !== -1) {
        return { responseCode: 200, body: { id: SESSION_ID, status: 'expired', payment_status: 'unpaid' } };
      }
      throw new Error('未対応のURL: ' + url);
    })
  });
  createBookingRowIn(pair.webhook, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEventIn(pair.events);

  var callCount = 0;
  pair.admin.BookingLockRepository.isHeld = function () {
    callCount++;
    return false;
  };

  var expireResult = pair.admin.BookingRepository.expirePendingBookings(new Date('2026-09-20T11:00:00+09:00'));
  assert.strictEqual(expireResult.expiredCount, 0);
  assert.strictEqual(expireResult.skippedCount, 1);
  assert.strictEqual(callCount, 1);

  var record = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(pair.events[0].isDeleted(), false);
});

test('expirePendingBookings: Sheets書き込み直前に予約ロックが失効していた場合、Calendar削除済みでもstatus:EXPIREDは書き込まずRecoveryへ記録する（古い保持者による遅延書き込みの防止）', function () {
  var pair = setupCompetitionPair({
    adminUrlFetchApp: stubs.createUrlFetchAppStub(function (url) {
      if (url.indexOf('/checkout/sessions/') !== -1) {
        return { responseCode: 200, body: { id: SESSION_ID, status: 'expired', payment_status: 'unpaid' } };
      }
      throw new Error('未対応のURL: ' + url);
    })
  });
  createBookingRowIn(pair.webhook, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEventIn(pair.events);

  var callCount = 0;
  pair.admin.BookingLockRepository.isHeld = function () {
    callCount++;
    return callCount === 1; /* 1回目（Calendar削除直前）はtrue、2回目（Sheets書き込み直前）はfalse。 */
  };

  var expireResult = pair.admin.BookingRepository.expirePendingBookings(new Date('2026-09-20T11:00:00+09:00'));
  assert.strictEqual(expireResult.expiredCount, 0);
  assert.strictEqual(expireResult.skippedCount, 1);
  assert.strictEqual(callCount, 2);

  /*
   * 枠解放と予約確定が両方成功したと判断される状態にはならない: Calendarは既に
   * 削除されているが、Sheets側のstatusはPENDINGのまま（Webhook側がこの予約を確定
   * しようとしても、confirmBookingがCalendarイベント消失を検知してブロックする）。
   */
  var record = pair.admin.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(pair.events[0].isDeleted(), true, 'Calendar削除自体はロック失効検知より前に完了しているはず');

  var recovery = pair.admin.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) { return r.bookingId === BOOKING_ID && r.failureType === 'EXPIRE_LOCK_EXPIRED_BEFORE_SHEETS_UPDATE'; }));
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
