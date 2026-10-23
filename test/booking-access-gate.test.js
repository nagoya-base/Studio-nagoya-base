/*
 * Issue #341 PR-D / Issue #414: 来場案内の決済ゲート（Booking.evaluateAccessGate。鍵承認は廃止）・
 * 前日リマインドの送信ゲート・管理者の「来場案内を再送」の統合テスト。
 * Booking Adminの配布ファイル一式をvmで実行し、Sheets・メール・Stripeはスタブを使う。
 *
 * 受入条件との対応:
 * - Stripe決済済み + CONFIRMED + Recovery正常 → 鍵承認（accessApprovedAt）なしで送信する
 * - PAYMENT_NOT_SETTLED / PAYMENT_RECOVERY_REQUIRED → 送信しない（鍵情報を出さない。自動送信・再送とも）
 * - 二重送信防止（reminderSentAt）と管理者の明示再送の維持
 * - 送信直前に予約が取消・返金・Recoveryへ移った場合は送信しない
 * - メール送信失敗時に予約・決済を巻き戻さず、再実行で重複送信しない
 * - 現地払い・旧Payment Linkは従来どおり
 * - 鍵承認の関数・UI・通知・旧文言が残っていない
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');

var SPREADSHEET_ID = 'ss1';
var BOOKING_ID = 'SX-20261002-AAAAAAAA';
/* JST 2026-10-01 18:00に前日リマインドを実行 → 翌日は2026-10-02。 */
var NOW = new Date('2026-10-01T18:00:00+09:00');
var KEYBOX = 'TEST-KEYBOX-9876';
var UNLOCK = 'TEST-UNLOCK-5432';

var PROPERTIES = {
  SPREADSHEET_ID: SPREADSHEET_ID,
  CALENDAR_ID: 'cal1',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
  BOOKING_ADMIN_URL: 'https://script.google.com/macros/s/admin/exec',
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com',
  ACCESS_GUIDE_ADDRESS: '愛知県名古屋市...',
  ACCESS_GUIDE_BUILDING: 'テストビル',
  ACCESS_GUIDE_ROOM: '101',
  ACCESS_GUIDE_ENTRANCE: '正面入口から左手',
  ACCESS_GUIDE_KEYBOX_LOCATION: '玄関脇',
  ACCESS_GUIDE_ENTRY_METHOD: '暗証番号で解錠',
  ACCESS_GUIDE_KEYBOX_NUMBER: KEYBOX,
  ACCESS_GUIDE_UNLOCK_CODE: UNLOCK,
  ACCESS_GUIDE_URL: 'https://example.com/how-to'
};

function stripeRecord(overrides) {
  return Object.assign({
    bookingId: BOOKING_ID,
    createdAt: new Date('2026-09-20T10:00:00+09:00'),
    date: '2026-10-02',
    startAt: new Date('2026-10-02T10:00:00+09:00'),
    endAt: new Date('2026-10-02T12:00:00+09:00'),
    brand: 'studio_x',
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '090-0000-0000',
    people: '2名',
    purpose: '撮影',
    paymentMethod: 'オンラインクレジットカード',
    status: 'CONFIRMED',
    calendarEventId: 'event-1',
    source: 'test',
    note: '',
    confirmedAt: new Date('2026-09-20T10:10:00+09:00'),
    customerType: 'returning',
    confirmedMailSentAt: new Date('2026-09-20T10:10:00+09:00'),
    paymentStatus: 'paid',
    paymentAttemptId: 'PAY-' + BOOKING_ID + '-ABCDEF012345',
    stripeCheckoutSessionId: 'cs_test_0001',
    stripePaymentIntentId: 'pi_test_0001',
    stripeAmount: 8000,
    stripeCurrency: 'JPY',
    paymentConfirmedAt: new Date('2026-09-20T10:10:00+09:00'),
    lastStripeEventId: 'evt_0001'
  }, overrides || {});
}

var CASH_OVERRIDES = {
  paymentMethod: '現金', paymentStatus: 'unpaid', paymentAttemptId: '', stripeCheckoutSessionId: '',
  stripePaymentIntentId: '', stripeAmount: '', stripeCurrency: '', paymentConfirmedAt: '', lastStripeEventId: ''
};

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var mailApp = opts.mailApp || stubs.createMailAppStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(Object.assign({}, PROPERTIES, opts.properties || {})),
    LockService: stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripeは呼ばない'); }),
    Utilities: stubs.createUtilitiesStub(),
    MailApp: mailApp,
    ScriptApp: stubs.createScriptAppStub(),
    Logger: stubs.createLoggerStub()
  };
  var sandbox = loadBookingSandbox(manifest.BOOKING_ADMIN_FILES, globals);
  (opts.records || [stripeRecord(opts.record)]).forEach(function (record) {
    sandbox.SpreadsheetRepository.appendBooking(record);
  });
  return { sandbox: sandbox, mailApp: mailApp };
}

function rec(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId || BOOKING_ID).record;
}

function customerMails(ctx) {
  return ctx.mailApp._sentEmails.filter(function (m) { return m.to === 'taro@example.com'; });
}

function adminMails(ctx) {
  return ctx.mailApp._sentEmails.filter(function (m) { return m.to === 'admin@example.com'; });
}

function assertNoSecretsSent(ctx) {
  ctx.mailApp._sentEmails.forEach(function (m) {
    assert.ok(String(m.body).indexOf(KEYBOX) === -1 && String(m.body).indexOf(UNLOCK) === -1, '鍵情報を含むメールを送ってはいけない: ' + m.subject);
  });
}


/* ========================================================================== */
/* ゲート判定                                                                   */
/* ========================================================================== */

test('Booking.evaluateAccessGate: Stripe Checkout予約は決済済み・Recovery正常ならaccessApprovedAtなしでok。現地払い・旧Payment Linkは対象外', function () {
  var ctx = setup();
  var B = ctx.sandbox.Booking;
  assert.strictEqual(typeof B.requiresAccessApproval, 'undefined', '鍵承認の判定関数は廃止');
  assert.strictEqual(B.ACCESS_GATE_REASON_CODES.ACCESS_NOT_APPROVED, undefined);
  var paid = B.evaluateAccessGate(stripeRecord());
  assert.strictEqual(paid.required, true);
  assert.strictEqual(paid.ok, true, '鍵承認なしでも通る');
  assert.strictEqual(B.evaluateAccessGate(stripeRecord({ createdAt: new Date('2026-10-02T08:00:00+09:00') })).ok, true, '当日予約も同じ判定');
  assert.strictEqual(B.evaluateAccessGate(stripeRecord(CASH_OVERRIDES)).required, false);
  assert.strictEqual(B.evaluateAccessGate(stripeRecord(Object.assign({}, CASH_OVERRIDES, {
    paymentMethod: 'オンラインクレジットカード', stripePaymentLinkUrl: 'https://buy.stripe.com/test_abc'
  }))).required, false, '旧Payment Link方式は対象外');
  assert.strictEqual(B.evaluateAccessGate(stripeRecord({ paymentStatus: 'checkout_pending' })).reasonCode, 'PAYMENT_NOT_SETTLED');
  assert.strictEqual(B.evaluateAccessGate(stripeRecord({ paymentStatus: '???' })).reasonCode, 'PAYMENT_NOT_SETTLED', '不明な決済状態はfail-closed');
  assert.strictEqual(B.evaluateAccessGate(stripeRecord({ refundDecision: 'NONE' })).reasonCode, 'PAYMENT_NOT_SETTLED');
  assert.strictEqual(B.evaluateAccessGate(stripeRecord({ paymentRecoveryRequiredAt: new Date('2026-09-21T00:00:00+09:00') })).reasonCode, 'PAYMENT_RECOVERY_REQUIRED');
});

test('鍵承認の関数・UI用フラグ・管理者通知は廃止されている', function () {
  var ctx = setup();
  var s = ctx.sandbox;
  assert.strictEqual(typeof s.approveBookingAccess, 'undefined');
  assert.strictEqual(typeof s.adminApproveAccess, 'undefined');
  assert.strictEqual(typeof s.BookingAccessApproval, 'undefined');
  assert.strictEqual(typeof s.BookingAdminAlerts.notifyAccessApprovalPending, 'undefined');
  var detail = s.getAdminBookingDetail(BOOKING_ID).booking;
  ['accessApprovalRequired', 'accessApprovalPending', 'accessApprovedAt'].forEach(function (key) {
    assert.strictEqual(key in detail, false, key + 'は詳細に含めない');
  });
  var list = s.getAdminBookings().bookings[0];
  assert.strictEqual('accessApprovalPending' in list, false);
});

/* ========================================================================== */
/* 前日リマインドの自動送信                                                      */
/* ========================================================================== */

test('sendNextDayReminders: 決済済みのStripe予約は鍵承認なしで鍵情報を含む来場案内を送り、管理者通知は出さない', function () {
  var ctx = setup({
    records: [
      stripeRecord(),
      stripeRecord(Object.assign({}, CASH_OVERRIDES, { bookingId: 'SX-20261002-CASH0001', email: 'cash@example.com' }))
    ]
  });
  assert.strictEqual(rec(ctx).accessApprovedAt, '');

  var summary = ctx.sandbox.sendNextDayReminders(NOW);

  assert.strictEqual(summary.processedCount, 2);
  assert.strictEqual(summary.sentCount, 2);
  assert.strictEqual(summary.failedCount, 0);
  assert.ok(!summary.accessGateSkippedCount);
  var mails = customerMails(ctx);
  assert.strictEqual(mails.length, 1);
  assert.ok(mails[0].body.indexOf(KEYBOX) !== -1 && mails[0].body.indexOf(UNLOCK) !== -1);
  assert.ok(rec(ctx).reminderSentAt, '二重送信防止の送信日時を記録する');
  assert.strictEqual(adminMails(ctx).length, 0);

  /* 2回目の実行は送らない（reminderSentAtによる二重送信防止）。 */
  ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(customerMails(ctx).length, 1);
});

test('sendNextDayReminders: 未入金・Recovery未解消のStripe予約は鍵情報を出さず、メール障害にも数えず、管理者へ通知する', function () {
  var ctx = setup({
    records: [
      stripeRecord({ bookingId: 'SX-20261002-UNPAID01', paymentStatus: 'checkout_pending' }),
      stripeRecord({ bookingId: 'SX-20261002-RECOV001', paymentRecoveryRequiredAt: new Date('2026-09-26T10:00:00+09:00'), paymentRecoveryReason: 'x' })
    ]
  });
  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.sentCount, 0);
  assert.strictEqual(summary.failedCount, 0);
  assert.strictEqual(summary.accessGateSkippedCount, 2);
  assert.strictEqual(customerMails(ctx).length, 0);
  assertNoSecretsSent(ctx);
  assert.strictEqual(rec(ctx, 'SX-20261002-UNPAID01').lastMailErrorAt, '');
  var alerts = adminMails(ctx);
  assert.strictEqual(alerts.length, 1);
  assert.ok(/来場案内を送信できなかった/.test(alerts[0].subject));
  assert.ok(alerts[0].body.indexOf('SX-20261002-UNPAID01') !== -1);
  assert.ok(alerts[0].body.indexOf('鍵承認') === -1, '旧文言を出さない');
  assert.ok(alerts[0].body.indexOf('taro@example.com') === -1);
});

test('メールアドレス欠落・来場案内の設定不足のStripe予約は決済済みでもfail-closedで送らない', function () {
  var noEmail = setup({ record: { email: '' } });
  noEmail.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(noEmail.mailApp._sentEmails.filter(function (m) { return m.body.indexOf(KEYBOX) !== -1; }).length, 0);
  assert.strictEqual(
    noEmail.sandbox.BookingMailer.evaluateReminderEligibility(rec(noEmail), { targetDateString: '2026-10-02' }).reasonCode, 'EMAIL_MISSING');

  var noConfig = setup({ properties: { ACCESS_GUIDE_UNLOCK_CODE: '' } });
  assert.strictEqual(
    noConfig.sandbox.BookingMailer.evaluateReminderEligibility(rec(noConfig), { targetDateString: '2026-10-02' }).reasonCode, 'MAIL_NOT_READY');
  noConfig.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(customerMails(noConfig).length, 0);
  assert.strictEqual(rec(noConfig).status, 'CONFIRMED', '送信失敗でも予約のCONFIRMEDを壊さない');
});

test('Recovery未解消: 前日リマインド・再送は送らない', function () {
  var ctx = setup({
    record: { paymentRecoveryRequiredAt: new Date('2026-09-26T10:00:00+09:00'), paymentRecoveryReason: 'x' }
  });
  ctx.sandbox.sendNextDayReminders(NOW);
  var resend = ctx.sandbox.adminResendReminderMail(BOOKING_ID, 0);
  assert.strictEqual(resend.skipped, true);
  assert.strictEqual(resend.error.code, 'PAYMENT_RECOVERY_REQUIRED');
  assert.strictEqual(customerMails(ctx).length, 0);
  assertNoSecretsSent(ctx);
});

/* ========================================================================== */
/* 来場案内の再送                                                               */
/* ========================================================================== */

test('来場案内を再送: 決済済みなら鍵承認なしで送信でき、二重クリック（古い送信履歴）では重複送信しない。画面更新後の明示再送は送れる', function () {
  var ctx = setup();
  var detail = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  assert.strictEqual(detail.reminderSentAtVersion, 0);

  var sent = ctx.sandbox.adminResendReminderMail(BOOKING_ID, detail.reminderSentAtVersion);
  assert.strictEqual(sent.success, true, JSON.stringify(sent));
  assert.strictEqual(typeof sent.sentAt, 'string', 'google.script.run越しにDateを返さない');
  assert.strictEqual(customerMails(ctx).length, 1);

  var doubleClick = ctx.sandbox.adminResendReminderMail(BOOKING_ID, detail.reminderSentAtVersion);
  assert.strictEqual(doubleClick.skipped, true);
  assert.strictEqual(doubleClick.error.code, 'SEND_HISTORY_CONFLICT');
  assert.strictEqual(customerMails(ctx).length, 1);

  var refreshed = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  var resend = ctx.sandbox.adminResendReminderMail(BOOKING_ID, refreshed.reminderSentAtVersion);
  assert.strictEqual(resend.success, true);
  assert.strictEqual(customerMails(ctx).length, 2);
});

test('来場案内を再送: 画面表示後に返金手続き・取消済みへ変わっていれば送信直前に止まる', function () {
  var ctx = setup();
  var detail = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;

  ctx.sandbox.SpreadsheetRepository.updateBookingFields(BOOKING_ID, { paymentStatus: 'refund_pending', stripeRefundId: 're_1' });
  var refunding = ctx.sandbox.adminResendReminderMail(BOOKING_ID, detail.reminderSentAtVersion);
  assert.strictEqual(refunding.skipped, true);
  assert.strictEqual(refunding.error.code, 'PAYMENT_NOT_SETTLED');

  ctx.sandbox.SpreadsheetRepository.updateBookingFields(BOOKING_ID, { status: 'CANCELLED' });
  var cancelled = ctx.sandbox.adminResendReminderMail(BOOKING_ID, detail.reminderSentAtVersion);
  assert.strictEqual(cancelled.skipped, true);
  assert.strictEqual(cancelled.error.code, 'INVALID_STATUS');

  assert.strictEqual(customerMails(ctx).length, 0);
  assertNoSecretsSent(ctx);
});

test('来場案内を再送: メール送信失敗では予約・決済を巻き戻さず、送信履歴も進めない。復旧後の再実行で1通だけ送る', function () {
  var failingMail = stubs.createMailAppStub({ throwError: new Error('Service invoked too many times: taro@example.com') });
  var ctx = setup({ mailApp: failingMail });

  var failed = ctx.sandbox.adminResendReminderMail(BOOKING_ID, 0);
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.error.code, 'MAIL_SEND_FAILED');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CONFIRMED');
  assert.strictEqual(r.paymentStatus, 'paid');
  assert.strictEqual(r.reminderSentAt, '', '送信履歴を進めない');
  assert.ok(r.lastMailErrorAt, '再送可能な証跡を残す');
  assert.ok(String(r.lastMailErrorMessage).indexOf('taro@example.com') === -1, 'エラー記録から連絡先をマスクする');
  assert.ok(String(r.lastMailErrorMessage).indexOf(KEYBOX) === -1);

  var okMail = stubs.createMailAppStub();
  ctx.sandbox.MailApp = okMail;
  var retried = ctx.sandbox.adminResendReminderMail(BOOKING_ID, 0);
  assert.strictEqual(retried.success, true, JSON.stringify(retried));
  assert.strictEqual(okMail._sentEmails.length, 1);
  var again = ctx.sandbox.adminResendReminderMail(BOOKING_ID, 0);
  assert.strictEqual(again.error.code, 'SEND_HISTORY_CONFLICT');
  assert.strictEqual(okMail._sentEmails.length, 1);
});

test('来場案内を再送: 現地払い・旧Payment Link・当日予約も従来どおり送れる', function () {
  var ctx = setup({
    records: [
      stripeRecord(CASH_OVERRIDES),
      stripeRecord(Object.assign({}, CASH_OVERRIDES, {
        bookingId: 'SX-20261002-LINK0001', paymentMethod: 'オンラインクレジットカード', stripePaymentLinkUrl: 'https://buy.stripe.com/test_abc'
      })),
      stripeRecord({ bookingId: 'SX-20261002-SAME0001', createdAt: new Date('2026-10-02T07:00:00+09:00') })
    ]
  });
  [BOOKING_ID, 'SX-20261002-LINK0001', 'SX-20261002-SAME0001'].forEach(function (id) {
    var result = ctx.sandbox.adminResendReminderMail(id, 0);
    assert.strictEqual(result.success, true, id + ' ' + JSON.stringify(result));
  });
  assert.strictEqual(customerMails(ctx).length, 3);
});

/* ========================================================================== */
/* 確定メール・診断                                                              */
/* ========================================================================== */

test('確定メール: Stripe予約も現地払いも同じ来場案内の文言で、旧「運営での確認が完了した後」を含まない。当日予約は即時送信の文言', function () {
  var ctx = setup();
  var T = ctx.sandbox.BookingMailTemplates;
  var config = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };
  var stripe = T.buildConfirmedMail(stripeRecord(), config).body;
  var cash = T.buildConfirmedMail(stripeRecord(CASH_OVERRIDES), config).body;
  [stripe, cash].forEach(function (body) {
    assert.ok(/来場方法・キーボックス等の詳細案内は、利用日前日に別途メールでお送りします。/.test(body));
    assert.ok(body.indexOf('運営での確認') === -1 && body.indexOf('鍵承認') === -1);
  });
});

test('BookingReminderDiagnostics: 診断も同じ決済ゲートを使い、決済済みならELIGIBLE、未入金・Recoveryは理由コードを返す', function () {
  var ctx = setup();
  var M = ctx.sandbox.BookingMailer;
  assert.strictEqual(M.evaluateReminderEligibility(rec(ctx), { targetDateString: '2026-10-02' }).reasonCode, 'ELIGIBLE');
  assert.strictEqual(M.REMINDER_REASON_CODES && M.REMINDER_REASON_CODES.ACCESS_NOT_APPROVED, undefined);
  var unpaid = Object.assign({}, rec(ctx), { paymentStatus: 'checkout_pending' });
  assert.strictEqual(M.evaluateReminderEligibility(unpaid, { targetDateString: '2026-10-02' }).reasonCode, 'PAYMENT_NOT_SETTLED');
  var recovery = Object.assign({}, rec(ctx), { paymentRecoveryRequiredAt: new Date('2026-09-26T10:00:00+09:00') });
  assert.strictEqual(M.evaluateReminderEligibility(recovery, { targetDateString: '2026-10-02' }).reasonCode, 'PAYMENT_RECOVERY_REQUIRED');
});
