/*
 * StripeWebhookProcessor.processPendingStripeWebhookEventsの統合テスト
 * （Issue #341 PR-C「10. 必須テスト」。レビュー対応・4回目で新設。旧
 * test/stripe-webhook-handler.test.jsの決済照合・予約自動確定に関する部分を、
 * アーキテクチャ変更（Booking Adminプロジェクトの時間主導トリガーへ集約）に合わせて
 * 移動・再設計した）。Stripe API・Calendar・Sheets・メールはすべてスタブを使う。
 *
 * 受入条件との対応:
 * - 同一イベントの重複配信と並行配信で二重確定・二重メールが起きない（重複処理）。
 * - イベント処理途中の失敗後、安全に再試行できる。
 * - 未払いのSession完了イベントでは予約確定しない。
 * - 金額・通貨・予約ID・Session ID・決済試行IDの不一致を拒否する。
 * - 決済成功と仮押さえ失効が競合しても、枠の解放と予約確定が二重に成立しない
 *   （レビュー対応・4回目: 独自の分散ロックではなく、両者が同じBooking Admin
 *   プロジェクト・同じLockService.getScriptLock()を共有することで実現）。
 * - 失効済み・キャンセル済み・枠を失った予約への遅延決済をRecoveryへ送る。
 * - 決済状態の保存後に予約確定が失敗しても、入金済みの記録を保持する。
 * - Webhook再送で確認メールを二重送信しない。
 * - Stripeへの受付応答（Booking Webhook）から実際の確定（Booking Admin）までの間、
 *   予約は未確定のまま安全に待機する（処理遅延）。
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
  'StripeWebhookProcessor.gs'
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

function buildEvent(id, type, sessionOverrides) {
  return JSON.stringify({
    id: id || ('evt_' + Math.random().toString(36).slice(2)),
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
  /* レビュー対応・6回目: renewOrSupersededOutcome_内部の`new Date()`（ハートビート用の
     実時間）を決定的に制御したいテストのみ、controllable clockをDateグローバルとして
     注入する（stubs.createControllableClock参照）。通常のテストでは注入せず、
     サンドボックス自身の（本物の）Dateをそのまま使う。 */
  if (opts.clock) {
    globals.Date = opts.clock.Date;
  }
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
 * Booking Webhookが既に永続化した（rawBody保存済みRECEIVED行を作った）状態を再現した上で、
 * StripeWebhookProcessor.processPendingStripeWebhookEventsを1回実行し、対象イベントの
 * 処理結果を返す。旧StripeWebhookHandler.processEvent(eventBody, now)相当の呼び出し口。
 *
 * 戻り値のfinalizedは、旧processEventのackSuccessに相当する（このイベントが今回の実行で
 * 終端状態（COMPLETED/IGNORED/REJECTED）まで到達したか。falseの場合は次回のトリガー実行で
 * 安全に再試行される）。
 */
function receiveAndProcess(ctx, eventBody, now) {
  var parsed = JSON.parse(eventBody);
  var claimResult = ctx.sandbox.StripeEventRepository.claim(parsed.id, parsed.type, now);
  if (claimResult.outcome === 'CLAIMED') {
    ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, eventBody, now);
  }
  var runResult = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  var match = runResult.results.filter(function (r) { return r.eventId === parsed.id; })[0];
  return match || { finalized: false, code: 'SKIPPED_NOT_CANDIDATE', message: '', skipped: true };
}

/*
 * ============================================================================
 * 正常系: 決済成功 → 予約自動確定 → 確認メール送信
 * ============================================================================
 */

test('processPendingStripeWebhookEvents: 決済成功イベントを受けて予約を自動確定し確認メールを送る', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date('2026-09-20T10:10:00+09:00'));

  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'CONFIRMED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(record.stripePaymentIntentId, PAYMENT_INTENT_ID);
  assert.ok(record.confirmedMailSentAt);

  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
  assert.strictEqual(ctx.mailApp._sentEmails[0].to, 'taro@example.com');
});

test('processPendingStripeWebhookEvents: async_payment_succeededでも同様に確定する', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.async_payment_succeeded');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'CONFIRMED');
});

/*
 * ============================================================================
 * 処理遅延: Webhookが受け付けてからBooking Adminのトリガーが処理するまでの間、
 * 予約は未確定のまま安全に待機する（Issue #341 PR-Cレビュー対応・4回目で必須化）
 * ============================================================================
 */

test('処理遅延: Webhookが受け付けた直後（トリガー未実行）は予約が未確定のまま安全に待機する', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent('evt_delay_0001', 'checkout.session.completed');
  var now = new Date('2026-09-20T10:10:00+09:00');

  /* Booking Webhook側の受信・永続化だけを行い、Booking Admin側のトリガー
     （processPendingStripeWebhookEvents）はまだ実行しない。 */
  var claimResult = ctx.sandbox.StripeEventRepository.claim(JSON.parse(event).id, JSON.parse(event).type, now);
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, event, now);

  /* この時点では予約は一切変更されていない（決済照合・自動確定はまだ行われていない）。 */
  var beforeTrigger = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(beforeTrigger.status, 'PENDING');
  assert.strictEqual(beforeTrigger.paymentStatus, 'checkout_pending');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
  assert.strictEqual(ctx.sandbox.StripeEventRepository.listPendingWithBody().length, 1, 'トリガーの次回実行を待つ候補として残っているべき');

  /* Booking Adminの時間主導トリガーが実行されて初めて確定する。 */
  var runResult = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  assert.strictEqual(runResult.processedCount, 1);

  var afterTrigger = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(afterTrigger.status, 'CONFIRMED');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
});

/*
 * ============================================================================
 * 重複処理の防止: 同一イベントの重複配信・トリガーの重複実行
 * ============================================================================
 */

test('重複処理: 同一イベントの再送は二重確定・二重メール送信を起こさない', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_dup_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');

  var first = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(first.finalized, true);
  assert.strictEqual(first.code, 'CONFIRMED');

  /* Stripeが同じイベントを再送し、Webhook側が再度受け付ける（ALREADY_TERMINALのため
     rawBodyの重複保存は起きない。test/booking-webhook-endpoint.test.js参照）。
     Booking Admin側のlistPendingWithBodyにはもう候補として現れない。 */
  var second = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(second.skipped, true, '既に終端状態のためトリガーの処理対象にすらならない');

  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
});

test('重複処理: Booking Adminのトリガー実行が重複しても（前回実行がまだ処理中）二重処理しない', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_concurrent_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');
  var now = new Date('2026-09-20T10:10:00+09:00');

  /* Webhook側が既に受信・永続化済み。 */
  var claimResult = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', now);
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, event, now);

  /* 1つ目のトリガー実行が既にこのイベントをclaimForProcessing済み（処理中）という状況を
     直接再現する（StripeWebhookProcessor.ADMIN_CLAIM_STALE_AFTER_MS_=2分未満）。 */
  ctx.sandbox.StripeEventRepository.claimForProcessing(eventId, 'checkout.session.completed', now, 2 * 60000);

  /* ほぼ同時に2つ目のトリガー実行（例: 前回の実行がStripe APIの応答待ちで長引いている間に
     次のトリガーが起動した）が走っても、この候補を二重にclaimできず処理をスキップする。 */
  var secondRunNow = new Date(now.getTime() + 1000);
  var secondRun = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(secondRunNow);
  assert.strictEqual(secondRun.processedCount, 0);
  assert.strictEqual(secondRun.skippedCount, 1);

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

test('processPendingStripeWebhookEvents: 同じ決済（同じPaymentIntent/Session/決済試行ID）に対する異なるイベントIDの通知は、lastStripeEventIdの不一致だけで要復旧にせず1回だけ確定・メール送信する', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var firstEvent = buildEvent('evt_first_0001', 'checkout.session.completed');
  var firstResult = receiveAndProcess(ctx, firstEvent, new Date('2026-09-20T10:10:00+09:00'));
  assert.strictEqual(firstResult.finalized, true);
  assert.strictEqual(firstResult.code, 'CONFIRMED');

  /* 同一のCheckout Session・PaymentIntent・決済試行IDについて、Stripeが別のイベントID
     （例: checkout.session.async_payment_succeeded、または重複配信）で通知した状況を
     再現する。eventId自体は異なるため、StripeEventRepositoryの台帳では新規行として
     claimされる（同一イベントの再送とは別の経路）。 */
  var secondEvent = buildEvent('evt_second_0002', 'checkout.session.async_payment_succeeded');
  var secondResult = receiveAndProcess(ctx, secondEvent, new Date('2026-09-20T10:11:00+09:00'));

  /* lastStripeEventIdが食い違うだけでPAYMENT_IDENTITY_MISMATCH（恒久の要復旧ゲート）に
     してはならない（レビュー指摘の中心）。PaymentIntent/Session/決済試行IDが同じである
     以上、同一決済の重複通知として安全に成功扱いにする。 */
  assert.strictEqual(secondResult.finalized, true);
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

test('processPendingStripeWebhookEvents: 決済試行ID・Session IDが本当に異なる別決済は、依然としてIDENTITY_MISMATCHとして要復旧にする（回帰確認）', function () {
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

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(otherSessionCtx, event, new Date());

  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'IDENTITY_MISMATCH');

  var record = otherSessionCtx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
  assert.ok(record.paymentRecoveryRequiredAt, '本当に異なる決済の疑いがある場合は引き続き恒久ゲートを立てる');
});

test('処理途中で停止したイベント（RECEIVEDのまま古い）は安全に再試行できる', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_stalled_0001';
  var claimedAt = new Date('2026-09-20T10:00:00+09:00');
  /* 前回のトリガー実行がクラッシュし、RECEIVEDのまま放置されていた状況を再現する。 */
  var event = buildEvent(eventId, 'checkout.session.completed');
  var initialClaim = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', claimedAt);
  ctx.sandbox.StripeEventRepository.storeRawBody(initialClaim.rowNumber, event, claimedAt);

  /* 3分後（既定ADMIN_CLAIM_STALE_AFTER_MS_=2分超）にトリガーが再実行された想定。 */
  var retryNow = new Date(claimedAt.getTime() + 3 * 60000);
  var runResult = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(retryNow);
  assert.strictEqual(runResult.processedCount, 1);

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
});

test('イベント結果の永続化自体が失敗した場合は完了扱いにせず、再試行で完了できる', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_ledger_fail_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');
  var now = new Date('2026-09-20T10:10:00+09:00');
  var claimResult = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', now);
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, event, now);

  /* StripeEventsシートへの最終書き込み（finalizeForProcessing）だけを1回失敗させる。
     決済確認・予約確定自体は既に成功済みの状態を作り、「永続化できていないイベントを
     完了扱いにしない」ことを検証する。 */
  var originalFinalizeForProcessing = ctx.sandbox.StripeEventRepository.finalizeForProcessing;
  ctx.sandbox.StripeEventRepository.finalizeForProcessing = function () {
    throw new Error('injected StripeEvents write failure');
  };

  var runResult;
  try {
    runResult = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  } finally {
    ctx.sandbox.StripeEventRepository.finalizeForProcessing = originalFinalizeForProcessing;
  }
  var firstAttempt = runResult.results.filter(function (r) { return r.eventId === eventId; })[0];
  assert.strictEqual(firstAttempt.finalized, false);
  assert.strictEqual(firstAttempt.code, 'LEDGER_WRITE_FAILED');

  /* 決済・予約確定自体は既に成功している(入金の事実・確定状態は保持される)。 */
  var recordAfterFirst = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(recordAfterFirst.status, 'CONFIRMED');
  assert.strictEqual(recordAfterFirst.paymentStatus, 'paid');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);

  /* 行はRECEIVEDのまま残っているため、次回のトリガー実行（staleAfterMs経過後）で
     安全に再claimして完了できる。予約は既にCONFIRMED・メール送信済みのため二重実行しない。
     レビュー対応・6回目でハートビート（renewProcessingLease）が実際の実時間
     （new Date()）を書き込むようになったため、1回目の試行で複数回成功した
     ハートビートにより`processingClaimedAt`は実時間で更新済みである。再試行時刻は
     そのビジネス上の`now`（2026-09-20の固定日時）からの相対時刻ではなく、実際に
     記録されている`processingClaimedAt`からの経過時間として構成する必要がある。 */
  var claimedAtAfterFirst = ctx.sandbox.StripeEventRepository.findByEventId(eventId).record.processingClaimedAt;
  var retryNow = new Date(claimedAtAfterFirst.getTime() + 3 * 60000);
  var retryRun = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(retryNow);
  var retryResult = retryRun.results.filter(function (r) { return r.eventId === eventId; })[0];
  assert.strictEqual(retryResult.finalized, true);
  assert.strictEqual(retryResult.code, 'CONFIRMED');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
});

/*
 * ============================================================================
 * 未払い・支払い未確定のイベントでは確定しない
 * ============================================================================
 */

test('processPendingStripeWebhookEvents: payment_statusがpaidでないcheckout.session.completedでは確定しない', function () {
  var ctx = setup({ stripeState: { paymentStatus: 'unpaid', sessionStatus: 'open' } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'PAYMENT_NOT_YET_COMPLETE');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
});

test('processPendingStripeWebhookEvents: PaymentIntentのstatusがsucceededでない場合はSession完了と同一視せず確定しない', function () {
  var ctx = setup({ stripeState: { paymentIntentStatus: 'processing' } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
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

test('processPendingStripeWebhookEvents: 決済試行IDが台帳と一致しない場合は自動確定せずRecoveryへ記録する', function () {
  var ctx = setup({ stripeState: { metadata: { bookingId: BOOKING_ID, brand: 'studio_x', paymentAttemptId: 'PAY-OLD-ATTEMPT' } } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'IDENTITY_MISMATCH');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
  assert.ok(record.paymentRecoveryRequiredAt);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'STRIPE_WEBHOOK_IDENTITY_MISMATCH');
});

test('processPendingStripeWebhookEvents: 金額が台帳のスナップショットと一致しない場合はRecoveryへ記録する', function () {
  var ctx = setup({ stripeState: { amountReceived: 999999 } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'AMOUNT_MISMATCH');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.paymentStatus, 'checkout_pending');
  assert.ok(record.paymentRecoveryRequiredAt);
});

test('processPendingStripeWebhookEvents: 通貨が台帳のスナップショットと一致しない場合はRecoveryへ記録する', function () {
  var ctx = setup({ stripeState: { currency: 'usd' } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'CURRENCY_MISMATCH');
});

test('processPendingStripeWebhookEvents: 予約IDがBookings台帳に見つからない場合はRecoveryへ記録する', function () {
  var ctx = setup({ stripeState: { metadata: { bookingId: 'UNKNOWN-BOOKING', brand: 'studio_x', paymentAttemptId: PAYMENT_ATTEMPT_ID } } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'BOOKING_NOT_FOUND');

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].bookingId, 'UNKNOWN-BOOKING');
});

/*
 * ============================================================================
 * 失効処理（expirePendingBookings）との競合
 * （Issue #341 PR-Cレビュー対応・1〜3回目は、Booking WebhookとBooking Adminが別々の
 * LockService.getScriptLock()を持つ独立したプロジェクトだったため、予約単位の
 * 分散ロック（BookingLockRepository）を作り込んでいた。しかし「ロックの有効性確認から
 * 実際の書き込みまでの間に競合が起こり得る（TOCTOU）」という指摘を受け、4回目で
 * Webhook由来の決済照合・予約自動確定をこのファイル（Booking Adminプロジェクト内）へ
 * 集約した。これにより、以下のテストはすべて**同一サンドボックス・同一LockService**で
 * 実行される（別プロジェクトを模した2つのサンドボックスは不要になった）。
 * ============================================================================
 */

test('Webhookが先に確定した場合、失効処理は枠を解放しない', function () {
  var ctx = setup();
  createBookingRow(ctx, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEvent(ctx);

  var confirmEvent = buildEvent(null, 'checkout.session.completed');
  var confirmResult = receiveAndProcess(ctx, confirmEvent, new Date('2026-09-20T10:10:00+09:00'));
  assert.strictEqual(confirmResult.code, 'CONFIRMED');

  /* グレース期間（CardPayment.WEBHOOK_RACE_GRACE_MINUTES=10分）を超えた時刻で実行する。 */
  var expireResult = ctx.sandbox.BookingRepository.expirePendingBookings(new Date('2026-09-20T11:00:00+09:00'));
  assert.strictEqual(expireResult.expiredCount, 0);

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(ctx.events[0].isDeleted(), false);
});

test('失効処理が先に完了していた場合、遅延した決済成功はRecoveryへ送られ入金は保持される', function () {
  var ctx = setup({
    /* expirePendingBookingsが仮押さえ失効確認で問い合わせた時点で、Stripeは確実に
       期限切れ・未払いと報告する。この直後に実際には決済が完了していたという遅延
       Webhookイベントが届く（同じUrlFetchAppスタブは1回目の問い合わせにしか使わない
       ため、決済成功イベント処理時は既定の「決済成功」応答をそのまま使う）。 */
  });
  createBookingRow(ctx, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEvent(ctx);

  ctx.urlFetchApp = stubs.createUrlFetchAppStub(function (url) {
    if (url.indexOf('/checkout/sessions/') !== -1) {
      return { responseCode: 200, body: { id: SESSION_ID, status: 'expired', payment_status: 'unpaid' } };
    }
    throw new Error('未対応のURL: ' + url);
  });
  ctx.sandbox.UrlFetchApp.fetch = ctx.urlFetchApp.fetch;

  var expireResult = ctx.sandbox.BookingRepository.expirePendingBookings(new Date('2026-09-20T11:00:00+09:00'));
  assert.strictEqual(expireResult.expiredCount, 1);

  var afterExpire = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(afterExpire.status, 'EXPIRED');
  assert.strictEqual(afterExpire.paymentStatus, 'failed');

  /* 決済成功へ応答を戻す（実際には決済が完了していたという遅延Webhookイベントの処理）。 */
  ctx.sandbox.UrlFetchApp.fetch = stubs.createUrlFetchAppStub(makeStripeResponder()).fetch;

  var lateEvent = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, lateEvent, new Date('2026-09-20T11:05:00+09:00'));
  assert.strictEqual(result.finalized, true);
  /*
   * 決済試行ID・Session IDは一致する（expirePendingBookingsはpaymentAttemptIdを変更
   * しない）ため、Booking.PAYMENT_STATUS_TRANSITIONS_のFAILED→PAID許可（レビュー対応・
   * 1回目）により、入金の事実（paymentStatus:paid）は正しく記録される。一方status
   * （EXPIRED）はapplyPaymentStateUpdateの対象外のため変更されず、confirmBookingが
   * EXPIREDを理由に自動確定を拒否する（PAID_CONFIRM_BLOCKED）。
   */
  assert.strictEqual(result.code, 'PAID_CONFIRM_BLOCKED');

  var finalRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(finalRecord.status, 'EXPIRED');
  assert.strictEqual(finalRecord.paymentStatus, 'paid');
  assert.strictEqual(finalRecord.stripePaymentIntentId, PAYMENT_INTENT_ID);
  assert.ok(finalRecord.paymentRecoveryRequiredAt);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) { return r.bookingId === BOOKING_ID && r.failureType === 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED'; }));

  assert.strictEqual(ctx.mailApp._sentEmails.length, 1, 'EXPIRED通知メールのみ送信される');
  assert.ok(
    ctx.mailApp._sentEmails[0].subject.indexOf('確定') === -1,
    '送信されたメールが確定（CONFIRMED）メールであってはならない'
  );
});

/*
 * ============================================================================
 * レビュー対応・4回目の核心: 同一LockServiceを共有することで、独自の分散ロックなしに
 * 「枠解放と予約確定が両方成功する」状態が起こらないことを、実際にトリガー実行の
 * 「入れ替わり」を再現して検証する。
 *
 * 3回目まで問題になっていたTOCTOUは、「ロックの有効性を確認した後、実際に書き込むまでの
 * 間に別の実行が割り込む」というタイミングだった。ここでは、StripeWebhookProcessorが
 * Stripe API照会（Lockの外）を終えた直後・Bookings/Calendarへの書き込み（Lockの中）を
 * 始める直前に、"別のトリガー実行"としてexpirePendingBookingsが完全に割り込む状況を
 * 再現する（StripeGateway.retrievePaymentIntentの呼び出しを横取りし、その中で直接
 * expirePendingBookingsを実行させることで、2つの実行が同じ予約に対して同じ瞬間に
 * 迫っている状況を確定的に作る）。
 *
 * 割り込んだexpirePendingBookings自身も、Stripeの同じCheckout Sessionへ問い合わせる
 * （verifyCheckoutHoldSafeToExpire_）。ここではStripeが一貫して「決済済み」を報告する
 * ため、expirePendingBookings自身が「決済済みの疑いがある枠を解放してはならない」という
 * 既存の安全策（Issue #341 PR-Cレビュー対応・1回目）に従って枠解放を見送り、代わりに
 * 恒久の要復旧ゲートを立てる。その直後にLockを取得するapplyPaymentStateUpdateは、この
 * ゲートを検知してPAYMENT_RECOVERY_REQUIREDとして安全に停止する。つまりここでは
 * 「Stripeの状態自体が一貫している」ことと「LockServiceを共有していること」の両方が
 * 効いて、二重成功はもちろん、不要な枠解放（EXPIRED誤判定）すら起こらない。
 * ============================================================================
 */

test('Stripe照会直後・Bookings書き込み直前に別のトリガー実行が割り込んでも、両方が成功した状態にはならない', function () {
  var ctx = setup();
  createBookingRow(ctx, { paymentHoldExpiresAt: new Date('2026-09-20T10:05:00+09:00') });
  createCalendarEvent(ctx);

  var raceInstant = new Date('2026-09-20T11:00:00+09:00');
  var expireCalled = false;
  var expireResultHolder = {};
  var originalRetrievePaymentIntent = ctx.sandbox.StripeGateway.retrievePaymentIntent;
  ctx.sandbox.StripeGateway.retrievePaymentIntent = function () {
    if (!expireCalled) {
      expireCalled = true;
      /*
       * "別のトリガー実行"としてexpirePendingBookings全体（Lock取得〜解放まで）を
       * ここで完了させる。実際のGASでは2つの独立した実行として起こり得るが、この
       * サンドボックスは単一のLockServiceスタブを共有しているため、単に順番に
       * 呼び出すだけで「先に完了する」状況を正確に再現できる
       * （LockService.getScriptLock()自体は排他を提供するプリミティブであり、
       * ここでテストしたいのはそのLockを実際に共有していること・その上に乗っている
       * 既存の安全策が正しく機能することである）。
       */
      expireResultHolder.result = ctx.sandbox.BookingRepository.expirePendingBookings(raceInstant);
    }
    return originalRetrievePaymentIntent.apply(null, arguments);
  };

  var event = buildEvent(null, 'checkout.session.completed');
  var result;
  try {
    result = receiveAndProcess(ctx, event, raceInstant);
  } finally {
    ctx.sandbox.StripeGateway.retrievePaymentIntent = originalRetrievePaymentIntent;
  }

  assert.strictEqual(expireCalled, true, '割り込みが実際に発生したことを確認する');
  /* 割り込んだexpirePendingBookings自身も、Stripeが「決済済み」を報告するCheckout
     Sessionの枠を解放してはならないという既存の安全策により、この回は解放しない
     （安全側に倒れて要復旧ゲートを立てるだけ）。 */
  assert.strictEqual(expireResultHolder.result.expiredCount, 0);
  assert.strictEqual(expireResultHolder.result.skippedCount, 1);

  /* 割り込みによって既に恒久の要復旧ゲートが立っているため、processSingleEvent_の
     applyPaymentStateUpdateはPAYMENT_RECOVERY_REQUIREDとして安全に停止する
     （二重に確定・二重にRecovery記録することはない）。 */
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'PAYMENT_RECOVERY_REQUIRED');

  var finalRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  /* 枠解放（expirePendingBookings）と予約確定（processSingleEvent_）の両方が
     「成功した」と判断される状態は決して生じない: 予約はPENDING・checkout_pendingの
     まま変更されず、Calendarイベントも削除されない。入金自体は正しく完了しているにも
     関わらず、システムはどちらの操作も実行せず安全に停止し、運営者の確認を待つ。 */
  assert.strictEqual(finalRecord.status, 'PENDING');
  assert.strictEqual(finalRecord.paymentStatus, 'checkout_pending');
  assert.ok(finalRecord.paymentRecoveryRequiredAt);
  assert.strictEqual(ctx.events[0].isDeleted(), false);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) { return r.bookingId === BOOKING_ID && r.failureType === 'CHECKOUT_HOLD_EXPIRY_PAYMENT_MAYBE_SUCCEEDED'; }));
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0, '確定メール・EXPIRED通知メールのいずれも送られない（どちらの操作も実行されていない）');
});

/*
 * ============================================================================
 * キャンセル済み・Calendarイベント消失への遅延決済
 * ============================================================================
 */

test('processPendingStripeWebhookEvents: 決済状態の保存後に予約確定が失敗しても、入金済みの記録を保持する（Calendarイベント消失）', function () {
  var ctx = setup();
  createBookingRow(ctx);
  /* Calendarイベントを作らない＝confirmBookingがCALENDAR_EVENT_MISSINGで失敗する状況。 */

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'PAID_CONFIRM_BLOCKED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  /* 決済状態は保持される（勝手に未払いへ戻さない）。 */
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(record.status, 'PENDING');
  assert.ok(record.paymentRecoveryRequiredAt);

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.ok(recovery.some(function (r) { return r.failureType === 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED'; }));
});

test('processPendingStripeWebhookEvents: キャンセル済みの予約への遅延決済はRecoveryへ送られ、確定しない', function () {
  var ctx = setup();
  createBookingRow(ctx, { status: 'CANCELLED' });
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
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

test('processPendingStripeWebhookEvents: 対象外のイベント種別は何もせずIGNOREDとして完了扱いにする', function () {
  var ctx = setup();
  createBookingRow(ctx);

  var event = JSON.stringify({ id: 'evt_other', type: 'invoice.paid', data: { object: { id: 'in_1' } } });
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'IGNORED_EVENT_TYPE');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
});

test('processPendingStripeWebhookEvents: checkout.session.async_payment_failedは現在の決済試行をfailedへ進める', function () {
  var ctx = setup({ stripeState: { paymentStatus: 'unpaid', sessionStatus: 'open' } });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var event = buildEvent(null, 'checkout.session.async_payment_failed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'MARKED_FAILED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.paymentStatus, 'failed');
  assert.strictEqual(record.status, 'PENDING');
});

test('processPendingStripeWebhookEvents: async_payment_failedが既存の成功を巻き戻さない', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  /* 決済は既に成功済み。 */
  var successEvent = buildEvent(null, 'checkout.session.completed');
  receiveAndProcess(ctx, successEvent, new Date('2026-09-20T10:10:00+09:00'));

  /* 順序逆転で失敗イベントが後から届く（Stripe側は既にpaid）。 */
  var failedEvent = buildEvent(null, 'checkout.session.async_payment_failed');
  var result = receiveAndProcess(ctx, failedEvent, new Date('2026-09-20T10:11:00+09:00'));
  assert.strictEqual(result.finalized, true);
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

test('processPendingStripeWebhookEvents: Checkout Session再取得が失敗した場合は未払いと決めつけず再試行させる', function () {
  var ctx = setup({
    urlFetchApp: stubs.createUrlFetchAppStub(function () {
      throw new Error('network down');
    })
  });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_lookup_fail_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');
  var result = receiveAndProcess(ctx, event, new Date());
  assert.strictEqual(result.finalized, false);
  assert.strictEqual(result.code, 'STRIPE_LOOKUP_FAILED');

  /* この配信では確定しないままRECEIVEDとして残る（次回のトリガー実行で再試行できる）。 */
  var found = ctx.sandbox.StripeEventRepository.findByEventId(eventId);
  assert.strictEqual(found.record.processingState, 'RECEIVED');
});

/*
 * ============================================================================
 * 処理権の世代管理・ハートビート（レビュー対応・5回目）
 *
 * 4回目までのclaimForProcessing()はstaleAfterMs（既定2分）だけで処理中かどうかを
 * 判定しており、1件のイベント処理がstaleAfterMsを超えて実行中なだけでも、別の
 * トリガー実行に処理権を奪われる恐れがあった。renewProcessingLease（ハートビート）と
 * finalizeForProcessing（世代のfencing）で、次の3ケースを検証する:
 * 1. 最初の実行が2分を超えてなお処理中のケース（ハートビートにより処理権を奪われない）。
 * 2. 実行停止後の再試行（クラッシュからの復帰。世代が進み安全に再処理できる）。
 * 3. 再試行後に古い実行が遅れて戻るケース（古い世代からの書き込みは拒否され、
 *    新しい実行の結果を上書きしない）。
 * ============================================================================
 */

test('処理権の世代管理: 処理中はStripe再照会後・Bookings書き込み前にハートビートを更新し、処理権を保持し続ける', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_heartbeat_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');
  var now = new Date('2026-09-20T10:10:00+09:00');
  var claimResult = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', now);
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, event, now);

  var renewCalls = [];
  var originalRenew = ctx.sandbox.StripeEventRepository.renewProcessingLease;
  ctx.sandbox.StripeEventRepository.renewProcessingLease = function (rowNumber, generation, renewNow) {
    renewCalls.push({ rowNumber: rowNumber, generation: generation });
    return originalRenew.apply(null, arguments);
  };

  var runResult;
  try {
    runResult = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  } finally {
    ctx.sandbox.StripeEventRepository.renewProcessingLease = originalRenew;
  }

  /* Checkout Session再取得後・PaymentIntent再取得後の2箇所で、正しい世代番号に対して
     ハートビートが更新されているべき（Bookings書き込みの直前まで処理権を保持し
     続けたことの証跡）。 */
  assert.ok(renewCalls.length >= 2, 'ハートビートが処理中に複数回更新されるべき');
  var candidate = ctx.sandbox.StripeEventRepository.findByEventId(eventId);
  var claimedGeneration = Number(candidate.record.processingClaimCount);
  renewCalls.forEach(function (call) {
    assert.strictEqual(call.rowNumber, claimResult.rowNumber);
    assert.strictEqual(call.generation, claimedGeneration, 'ハートビートは処理開始時にclaimForProcessingが払い出した世代番号のまま更新されるべき');
  });

  var result = runResult.results.filter(function (r) { return r.eventId === eventId; })[0];
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'CONFIRMED');
});

test('処理権の世代管理: 実行Aがハートビートを更新し続けている間は、別のトリガー実行（実行B）が同じイベントを二重処理しない（最初の実行が2分を超えてなお処理中のケース）', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_still_running_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');
  var t0 = new Date('2026-09-20T10:00:00+09:00');
  var claimResult = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', t0);
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, event, t0);

  /* 実行Aが処理に着手し（世代1）、Stripe再照会に時間がかかっているが、
     1分50秒後にハートビートは正常に更新できている状態を再現する。 */
  var claimedByA = ctx.sandbox.StripeEventRepository.claimForProcessing(eventId, 'checkout.session.completed', t0, 2 * 60000);
  assert.strictEqual(claimedByA.outcome, 'CLAIMED');
  var generationA = claimedByA.record.processingClaimCount;
  var heartbeatAt = new Date(t0.getTime() + 110000);
  var renewal = ctx.sandbox.StripeEventRepository.renewProcessingLease(claimedByA.rowNumber, generationA, heartbeatAt);
  assert.strictEqual(renewal.renewed, true);

  /* 最初のclaimから3分後（staleAfterMs=2分を超えている）に、別のトリガー実行
     （実行B）が起動しても、直近のハートビートからはまだ70秒しか経っていないため、
     このイベントには着手できずスキップする。 */
  var triggerBNow = new Date(t0.getTime() + 180000);
  var runResultB = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(triggerBNow);
  assert.strictEqual(runResultB.processedCount, 0);
  assert.strictEqual(runResultB.skippedCount, 1);

  /* 予約は未確定のまま、メールも送られていない（実行Bが二重に処理していない）。 */
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'PENDING');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('処理権の世代管理: ハートビートが更新されないまま停止した処理は、次のトリガー実行が世代を進めて安全に再試行できる（実行停止後の再試行）', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_crashed_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');
  var t0 = new Date('2026-09-20T10:00:00+09:00');
  var claimResult = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', t0);
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, event, t0);

  /* 実行Aが着手した直後にクラッシュし（世代1）、以後ハートビートを一切更新しない。 */
  var claimedByA = ctx.sandbox.StripeEventRepository.claimForProcessing(eventId, 'checkout.session.completed', t0, 2 * 60000);
  var generationA = claimedByA.record.processingClaimCount;

  /* 3分後（staleAfterMs=2分超）にトリガーが再実行され、世代を進めて安全に最初から
     処理をやり直す。 */
  var retryNow = new Date(t0.getTime() + 180000);
  var runResult = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(retryNow);
  assert.strictEqual(runResult.processedCount, 1);

  var afterRow = ctx.sandbox.StripeEventRepository.findByEventId(eventId);
  assert.strictEqual(afterRow.record.processingState, 'COMPLETED');
  assert.notStrictEqual(Number(afterRow.record.processingClaimCount), generationA, '再試行により世代が進んでいるべき');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.strictEqual(record.paymentStatus, 'paid');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
});

test('処理権の世代管理: 再試行が完了した後に古い実行の遅延応答が戻っても、新しい実行の処理結果を上書きしない（再試行後に古い実行が遅れて戻るケース）', function () {
  var ctx = setup();
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_delayed_response_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');
  var t0 = new Date('2026-09-20T10:00:00+09:00');
  var claimResult = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', t0);
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, event, t0);

  /* 実行Aが着手した直後に応答が極端に遅延し（世代1）、ハートビートを更新できないまま
     長時間経過する。 */
  var claimedByA = ctx.sandbox.StripeEventRepository.claimForProcessing(eventId, 'checkout.session.completed', t0, 2 * 60000);
  var generationA = claimedByA.record.processingClaimCount;

  /* 3分後、次のトリガー実行（実行B）が世代を進めて実際に処理を完了させる
     （決済確認・予約自動確定・確認メール送信まで完了）。 */
  var retryNow = new Date(t0.getTime() + 180000);
  var runResultB = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(retryNow);
  assert.strictEqual(runResultB.processedCount, 1);
  var recordAfterB = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(recordAfterB.status, 'CONFIRMED');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);

  /*
   * さらに後になって、実行Aの極端に遅延したStripe応答がようやく戻ってきて、
   * 実行Aが（既に失っている）古い世代のまま自分の処理結果を書き込もうとする。
   * これは拒否され、実行Bが既に確定させた結果を一切変更しない
   * （StripeEvents台帳・Bookings・送信済みメールのいずれも）。
   */
  var staleWrite = ctx.sandbox.StripeEventRepository.finalizeForProcessing(claimedByA.rowNumber, generationA, {
    processingState: 'REJECTED', bookingId: BOOKING_ID, outcomeCode: 'STALE_A_LATE_RESPONSE',
    outcomeMessage: '実行Aの極端に遅延した応答'
  }, new Date(t0.getTime() + 300000));
  assert.strictEqual(staleWrite.written, false);
  /* 実行Bは既にfinalizeForProcessingまで完了させている（世代も進み、終端状態にも
     到達済み）ため、fencingはALREADY_TERMINALとして拒否する
     （STALE_GENERATIONは、世代だけが進み相手がまだfinalizeしていない段階で発生する。
     test/stripe-event-repository.test.jsで別途検証済み）。いずれの理由であっても、
     実行Aの書き込みは拒否され上書きは起こらない。 */
  assert.strictEqual(staleWrite.reason, 'ALREADY_TERMINAL');

  var finalLedgerRow = ctx.sandbox.StripeEventRepository.findByEventId(eventId);
  assert.strictEqual(finalLedgerRow.record.processingState, 'COMPLETED', '実行Bの結果が保持されているべき');
  assert.strictEqual(finalLedgerRow.record.outcomeCode, 'CONFIRMED');

  var finalRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(finalRecord.status, 'CONFIRMED', '実行Aの遅延書き込みでBookingsの状態が変化してはならない');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1, '実行Aの遅延応答によってメールが再送されてはならない');
});

/*
 * ============================================================================
 * ハートビートの時刻管理（レビュー対応・6回目）
 *
 * 5回目の実装は、renewOrSupersededOutcome_（ひいてはStripeEventRepository.
 * renewProcessingLease）に`processSingleEvent_`冒頭で1度だけ確定した`effectiveNow`
 * （イベント処理開始時刻。監査ログ・テストの固定日時と共用）をそのまま渡していた。
 * このため、実際には外部Stripe API呼び出しで real 90秒経過していても、書き込まれる
 * `processingClaimedAt`は常に処理開始時刻のままで、ハートビートが実質的に機能して
 * いなかった（正常に実行中でも2分経過時点で別のトリガーに処理権を奪われる不具合が
 * 残っていた）。
 *
 * この節のテストは、`test/helpers/gas-stubs.js`の`createControllableClock`で
 * サンドボックスの`Date`グローバル自体を差し替え、`StripeWebhookProcessor.
 * processSingleEvent_`が内部で呼ぶ`new Date()`（ハートビートに使う実時間）を
 * 実際に本番コード経路（`processPendingStripeWebhookEvents`）を通して決定的に
 * 進めながら検証する。テストの固定日時（`now`引数。ここでは使わない）とは完全に
 * 独立している。
 * ============================================================================
 */

test('ハートビートの時刻管理: 処理開始から90秒後にハートビートを更新し、2分を超えた時点で別のトリガーが到達しても元の実行が処理権を保持する', function () {
  var t0 = new Date('2026-09-20T10:00:00+09:00');
  var clock = stubs.createControllableClock(t0);
  var ctx = setup({ clock: clock });
  createBookingRow(ctx);
  createCalendarEvent(ctx);

  var eventId = 'evt_heartbeat_real_time_0001';
  var event = buildEvent(eventId, 'checkout.session.completed');
  var claimResult = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', t0);
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, event, t0);

  var nestedTriggerBResult = null;
  var bookingStatusDuringTriggerB = null;
  var retrieveCheckoutSessionCallCount = 0;
  var retrievePaymentIntentCallCount = 0;

  var originalRetrieveCheckoutSession = ctx.sandbox.StripeGateway.retrieveCheckoutSession;
  ctx.sandbox.StripeGateway.retrieveCheckoutSession = function () {
    retrieveCheckoutSessionCallCount++;
    var result = originalRetrieveCheckoutSession.apply(null, arguments);
    /* 実行A（このテストの主体）のCheckout Session再取得が、実際には90秒かかった
       ことを再現する（呼び出しが返った直後に実時間を90秒進める。この直後に
       processSingleEvent_が1回目のハートビートを更新する）。 */
    clock.advanceByMillis(90 * 1000);
    return result;
  };

  /* 修正前のコード（ハートビートが機能しない）で本テストを実行すると、実行Bも
     このPaymentIntent再取得直前まで同じ処理経路をたどり、この差し替え済み
     retrievePaymentIntentへ再入してしまう。実行Bのさらに先（実行C、実行D…）まで
     再帰的に連鎖するのを防ぎ、「実行Bを1回だけ起動する」というテストの意図を
     壊さないよう、triggerBInvoked_で1回限りに制限する（修正前のコードでも、
     無限再帰のRangeErrorではなく後続のassertが明確にfailするようにするための
     テスト側のガード）。 */
  var triggerBInvoked_ = false;
  var originalRetrievePaymentIntent = ctx.sandbox.StripeGateway.retrievePaymentIntent;
  ctx.sandbox.StripeGateway.retrievePaymentIntent = function () {
    retrievePaymentIntentCallCount++;
    if (!triggerBInvoked_) {
      triggerBInvoked_ = true;
      /* 実行AがPaymentIntent再取得へ進もうとしている時点（＝claimから90秒後に
         ハートビートを更新済み）で、さらに40秒が経過し、claimから合計130秒
         （staleAfterMs=2分を超えている）の時点で別のトリガー実行（実行B）が
         到達した状況を再現する。 */
      clock.advanceByMillis(40 * 1000);
      nestedTriggerBResult = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents();
      /* 実行Bが返った直後（＝実行Aがまだpaid更新・confirmBookingへ進む前）の予約状態を
         記録する。この時点で確定していれば、実行Bが二重に処理してしまったことになる。 */
      bookingStatusDuringTriggerB = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record.status;
    }
    return originalRetrievePaymentIntent.apply(null, arguments);
  };

  var runResultA;
  try {
    runResultA = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents();
  } finally {
    ctx.sandbox.StripeGateway.retrieveCheckoutSession = originalRetrieveCheckoutSession;
    ctx.sandbox.StripeGateway.retrievePaymentIntent = originalRetrievePaymentIntent;
  }

  assert.strictEqual(retrieveCheckoutSessionCallCount, 1);
  assert.strictEqual(retrievePaymentIntentCallCount, 1, '実行Bはこのイベントに着手できずスキップするため、Stripeへは一切問い合わせないはず');

  /*
   * 実行Bは、claimから130秒後に到達しているが（staleAfterMsの2分を超えている）、
   * 実行Aが90秒後に更新したハートビートにより、直近の更新からはまだ40秒しか
   * 経っていないため「処理中」と正しく判定され、この候補には一切着手できない
   * （claimForProcessingでIN_PROGRESSとなりStripeへの問い合わせにも進まない）。
   */
  assert.ok(nestedTriggerBResult, '実行Bが実際に実行されているべき');
  assert.strictEqual(nestedTriggerBResult.processedCount, 0);
  assert.strictEqual(nestedTriggerBResult.skippedCount, 1);
  assert.strictEqual(bookingStatusDuringTriggerB, 'PENDING', '実行Bが二重に処理していないこと（実行Bの時点ではまだ実行Aも確定させていない）');

  /* 実行Aはハートビートを保ち続けたため処理権を奪われず、最後まで正常に完了する。 */
  assert.strictEqual(runResultA.processedCount, 1);
  var resultA = runResultA.results.filter(function (r) { return r.eventId === eventId; })[0];
  assert.strictEqual(resultA.finalized, true);
  assert.strictEqual(resultA.code, 'CONFIRMED');

  var finalRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
  assert.strictEqual(finalRecord.status, 'CONFIRMED');
  assert.strictEqual(finalRecord.paymentStatus, 'paid');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);

  var finalLedgerRow = ctx.sandbox.StripeEventRepository.findByEventId(eventId);
  assert.strictEqual(Number(finalLedgerRow.record.processingClaimCount), 1, '実行Bに処理権を奪われていない（世代が進んでいない）');
});
