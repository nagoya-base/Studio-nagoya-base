/*
 * Issue #341 PR-D: 鍵承認ゲート（Booking.evaluateAccessGate / BookingAccessApproval.gs）・
 * 前日リマインドの送信ゲート・管理者の「来場案内を再送」の統合テスト。
 * Booking Adminの配布ファイル一式をvmで実行し、Sheets・メール・Stripeはスタブを使う。
 *
 * 受入条件との対応:
 * - 鍵承認前に鍵情報（キーボックス番号・解錠コード）を送らない（自動送信・再送とも）
 * - 鍵承認はメールを送らず、承認日時は冪等に保存される
 * - 鍵承認後の前日リマインドと来場案内の再送
 * - 送信直前に予約が取消・返金・Recoveryへ移った場合は送信しない
 * - メール送信失敗時に予約・決済・鍵承認を巻き戻さず、再実行で重複送信しない
 * - 現地払い・旧Payment Link・当日予約はゲートの対象外（従来どおり）
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
/* ゲート対象の判定                                                            */
/* ========================================================================== */

test('Booking.requiresAccessApproval: Stripeカード決済（当日以外）のみ対象。現地払い・旧Payment Link・当日予約は対象外', function () {
  var ctx = setup();
  var B = ctx.sandbox.Booking;
  assert.strictEqual(B.requiresAccessApproval(stripeRecord(), 'Asia/Tokyo'), true);
  assert.strictEqual(B.requiresAccessApproval(stripeRecord(CASH_OVERRIDES), 'Asia/Tokyo'), false);
  assert.strictEqual(B.requiresAccessApproval(stripeRecord(Object.assign({}, CASH_OVERRIDES, {
    paymentMethod: 'オンラインクレジットカード', stripePaymentLinkUrl: 'https://buy.stripe.com/test_abc'
  })), 'Asia/Tokyo'), false, '旧Payment Link方式は対象外');
  assert.strictEqual(B.requiresAccessApproval(stripeRecord({ createdAt: new Date('2026-10-02T08:00:00+09:00') }), 'Asia/Tokyo'), false, '当日予約は対象外');
  assert.strictEqual(B.requiresAccessApproval(stripeRecord({ paymentStatus: '???' }), 'Asia/Tokyo'), true, '決済状態が不明な値ならfail-closedで対象');
  assert.strictEqual(B.requiresAccessApproval(stripeRecord({ createdAt: '' }), 'Asia/Tokyo'), true, '受付日時が不明ならfail-closedで対象');
});

/* ========================================================================== */
/* 前日リマインドの自動送信                                                      */
/* ========================================================================== */

test('sendNextDayReminders: 鍵承認前のStripeカード予約には送らず（鍵情報を出さない）、管理者へ「明日利用・鍵未承認」を通知する。現地払いは従来どおり送る', function () {
  var ctx = setup({
    records: [
      stripeRecord(),
      stripeRecord(Object.assign({}, CASH_OVERRIDES, { bookingId: 'SX-20261002-CASH0001', email: 'cash@example.com' }))
    ]
  });

  var summary = ctx.sandbox.sendNextDayReminders(NOW);

  assert.strictEqual(summary.processedCount, 2);
  assert.strictEqual(summary.sentCount, 1);
  assert.strictEqual(summary.failedCount, 0, 'ゲートによる停止はメール障害として数えない');
  assert.strictEqual(summary.accessGateSkippedCount, 1);
  assert.strictEqual(customerMails(ctx).length, 0);
  assert.strictEqual(rec(ctx).reminderSentAt, '');
  assert.strictEqual(rec(ctx).lastMailErrorAt, '', 'メール障害として記録しない');

  var cashMail = ctx.mailApp._sentEmails.filter(function (m) { return m.to === 'cash@example.com'; });
  assert.strictEqual(cashMail.length, 1);
  assert.ok(cashMail[0].body.indexOf(KEYBOX) !== -1, '現地払いは従来どおり鍵情報を含む来場案内を送る');

  var alerts = adminMails(ctx);
  assert.strictEqual(alerts.length, 1);
  assert.ok(/鍵未承認/.test(alerts[0].subject));
  assert.ok(alerts[0].body.indexOf(BOOKING_ID) !== -1);
  assert.ok(alerts[0].body.indexOf(KEYBOX) === -1 && alerts[0].body.indexOf('taro@example.com') === -1, '管理者通知にも鍵情報・連絡先を含めない');
});

test('鍵承認: メールを送らずaccessApprovedAtだけを記録し、二重クリックでは承認日時を変えない。承認後の前日リマインドは鍵情報を含めて送る', function () {
  var ctx = setup();
  var first = ctx.sandbox.approveBookingAccess(BOOKING_ID);
  assert.strictEqual(first.success, true, JSON.stringify(first));
  var approvedAt = rec(ctx).accessApprovedAt;
  assert.ok(approvedAt);
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0, '鍵承認はメール送信をトリガーしない');

  var second = ctx.sandbox.approveBookingAccess(BOOKING_ID);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.alreadyApproved, true);
  assert.strictEqual(rec(ctx).accessApprovedAt.getTime(), approvedAt.getTime(), '承認日時を上書きしない');

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.sentCount, 1);
  var mails = customerMails(ctx);
  assert.strictEqual(mails.length, 1);
  assert.ok(mails[0].body.indexOf(KEYBOX) !== -1 && mails[0].body.indexOf(UNLOCK) !== -1);
  assert.strictEqual(adminMails(ctx).length, 0);
});

test('鍵承認の制限: 対象外（現地払い）・未確定・未入金・返金手続き中・Recovery未解消の予約は承認できない', function () {
  var cases = [
    { overrides: CASH_OVERRIDES, code: 'ACCESS_APPROVAL_NOT_REQUIRED' },
    { overrides: { status: 'PENDING', paymentStatus: 'checkout_pending' }, code: 'INVALID_STATUS' },
    { overrides: { status: 'CANCELLED' }, code: 'INVALID_STATUS' },
    { overrides: { status: 'EXPIRED' }, code: 'INVALID_STATUS' },
    { overrides: { paymentStatus: 'refund_pending', stripeRefundId: 're_1' }, code: 'PAYMENT_NOT_SETTLED' },
    { overrides: { refundDecision: 'NONE' }, code: 'PAYMENT_NOT_SETTLED' },
    { overrides: { paymentRecoveryRequiredAt: new Date('2026-09-21T00:00:00+09:00'), paymentRecoveryReason: 'x' }, code: 'PAYMENT_RECOVERY_REQUIRED' }
  ];
  cases.forEach(function (c) {
    var ctx = setup({ record: c.overrides });
    var result = ctx.sandbox.approveBookingAccess(BOOKING_ID);
    assert.strictEqual(result.success, false, JSON.stringify(c.overrides));
    assert.strictEqual(result.error.code, c.code, JSON.stringify(c.overrides));
    assert.strictEqual(rec(ctx).accessApprovedAt, '');
    assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
  });
});

test('Recovery未解消: 鍵承認済みでも前日リマインド・再送は送らない', function () {
  var ctx = setup({
    record: {
      accessApprovedAt: new Date('2026-09-25T10:00:00+09:00'),
      paymentRecoveryRequiredAt: new Date('2026-09-26T10:00:00+09:00'), paymentRecoveryReason: 'x'
    }
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

test('来場案内を再送: 鍵承認前はスキップ理由を返して送らない。承認後は送信し、二重クリック（古い送信履歴）では重複送信しない', function () {
  var ctx = setup();
  var before = ctx.sandbox.adminResendReminderMail(BOOKING_ID, 0);
  assert.strictEqual(before.success, false);
  assert.strictEqual(before.skipped, true);
  assert.strictEqual(before.error.code, 'ACCESS_NOT_APPROVED');
  assert.ok(/鍵承認/.test(before.error.message));
  assert.strictEqual(customerMails(ctx).length, 0);

  ctx.sandbox.approveBookingAccess(BOOKING_ID);
  var detail = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  assert.strictEqual(detail.reminderSentAtVersion, 0);
  assert.strictEqual(detail.accessApprovalRequired, true);
  assert.ok(detail.accessApprovedAt);

  var sent = ctx.sandbox.adminResendReminderMail(BOOKING_ID, detail.reminderSentAtVersion);
  assert.strictEqual(sent.success, true, JSON.stringify(sent));
  assert.strictEqual(typeof sent.sentAt, 'string', 'google.script.run越しにDateを返さない');
  assert.strictEqual(customerMails(ctx).length, 1);

  /* 同じ画面（古いreminderSentAtVersion）からの2回目のクリック。 */
  var doubleClick = ctx.sandbox.adminResendReminderMail(BOOKING_ID, detail.reminderSentAtVersion);
  assert.strictEqual(doubleClick.skipped, true);
  assert.strictEqual(doubleClick.error.code, 'SEND_HISTORY_CONFLICT');
  assert.strictEqual(customerMails(ctx).length, 1);

  /* 画面を更新した後の明示的な再送は送れる。 */
  var refreshed = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  var resend = ctx.sandbox.adminResendReminderMail(BOOKING_ID, refreshed.reminderSentAtVersion);
  assert.strictEqual(resend.success, true);
  assert.strictEqual(customerMails(ctx).length, 2);
});

test('来場案内を再送: 画面表示時は承認済みでも、送信直前に取消・返金済みへ変わっていれば送らない', function () {
  var ctx = setup({ record: { accessApprovedAt: new Date('2026-09-25T10:00:00+09:00') } });
  var detail = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  assert.strictEqual(detail.accessApprovalPending, false);

  /* 画面表示後に別操作で返金手続きへ進んだ（予約はCONFIRMEDのまま・決済はrefund_pending）。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(BOOKING_ID, { paymentStatus: 'refund_pending', stripeRefundId: 're_1' });
  var refunding = ctx.sandbox.adminResendReminderMail(BOOKING_ID, detail.reminderSentAtVersion);
  assert.strictEqual(refunding.skipped, true);
  assert.strictEqual(refunding.error.code, 'PAYMENT_NOT_SETTLED');

  /* さらに取消済みへ。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(BOOKING_ID, { status: 'CANCELLED' });
  var cancelled = ctx.sandbox.adminResendReminderMail(BOOKING_ID, detail.reminderSentAtVersion);
  assert.strictEqual(cancelled.skipped, true);
  assert.strictEqual(cancelled.error.code, 'INVALID_STATUS');

  assert.strictEqual(customerMails(ctx).length, 0);
  assertNoSecretsSent(ctx);
});

test('来場案内を再送: メール送信失敗では予約・決済・鍵承認を巻き戻さず、送信履歴も進めない。復旧後の再実行で1通だけ送る', function () {
  var failingMail = stubs.createMailAppStub({ throwError: new Error('Service invoked too many times: taro@example.com') });
  var ctx = setup({ record: { accessApprovedAt: new Date('2026-09-25T10:00:00+09:00') }, mailApp: failingMail });

  var failed = ctx.sandbox.adminResendReminderMail(BOOKING_ID, 0);
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.error.code, 'MAIL_SEND_FAILED');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CONFIRMED');
  assert.strictEqual(r.paymentStatus, 'paid');
  assert.ok(r.accessApprovedAt, '鍵承認を巻き戻さない');
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

test('来場案内を再送: ゲート対象外（現地払い・旧Payment Link・当日予約）は鍵承認なしで従来どおり送れる', function () {
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
/* 確定メール・管理者通知の文言                                                   */
/* ========================================================================== */

test('確定メール: 鍵承認前のStripeカード予約には「前日に必ずキーボックス案内が届く」とは書かない。現地払いは従来の文言', function () {
  var ctx = setup();
  var T = ctx.sandbox.BookingMailTemplates;
  var config = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };
  var gated = T.buildConfirmedMail(stripeRecord(), config).body;
  assert.ok(/運営での確認が完了した後/.test(gated));
  assert.ok(gated.indexOf('キーボックス等の詳細案内は、利用日前日に別途') === -1);
  var cash = T.buildConfirmedMail(stripeRecord(CASH_OVERRIDES), config).body;
  assert.ok(/来場方法・キーボックス等の詳細案内は、利用日前日に別途メールでお送りします。/.test(cash));
});

test('管理者通知: Stripe決済で自動確定した鍵承認対象の予約は「鍵承認待ち」を通知し、対象外は通知しない', function () {
  var ctx = setup();
  var sent = ctx.sandbox.BookingAdminAlerts.notifyAccessApprovalPending(stripeRecord());
  assert.strictEqual(sent.sent, true);
  var alerts = adminMails(ctx);
  assert.ok(/鍵承認待ち/.test(alerts[0].subject));
  assert.ok(alerts[0].body.indexOf('https://script.google.com/macros/s/admin/exec') !== -1, 'Booking Adminへの直リンクを含める');
  assert.ok(alerts[0].body.indexOf('taro@example.com') === -1);
  var notRequired = ctx.sandbox.BookingAdminAlerts.notifyAccessApprovalPending(stripeRecord(CASH_OVERRIDES));
  assert.strictEqual(notRequired.sent, false);
});

test('BookingReminderDiagnostics: 診断も同じゲート判定を使い、鍵未承認を理由コードとして返す', function () {
  var ctx = setup();
  var evaluation = ctx.sandbox.BookingMailer.evaluateReminderEligibility(rec(ctx), { targetDateString: '2026-10-02' });
  assert.strictEqual(evaluation.eligible, false);
  assert.strictEqual(evaluation.reasonCode, 'ACCESS_NOT_APPROVED');
});
