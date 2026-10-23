/*
 * Issue #412: 当日予約がCONFIRMEDになった時点の来場案内即時送信
 * （BookingMailer.sendImmediateAccessGuideForBooking / BookingRepository.confirmBookingへの配線）。
 * Booking Adminの配布ファイル一式をvmで実行し、Sheets・メール・Calendarはスタブを使う。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');

var SPREADSHEET_ID = 'ss1';
var BOOKING_ID = 'SX-20261002-AAAAAAAA';
/* JST 2026-10-02 9:00。この日が「当日」。 */
var NOW = new Date('2026-10-02T09:00:00+09:00');
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

/* 現地払い・当日受付の確定済み予約（決済ゲート対象外）。 */
function cashRecord(overrides) {
  return Object.assign({
    bookingId: BOOKING_ID,
    createdAt: new Date('2026-10-02T08:00:00+09:00'),
    date: '2026-10-02',
    startAt: new Date('2026-10-02T13:00:00+09:00'),
    endAt: new Date('2026-10-02T15:00:00+09:00'),
    brand: 'studio_x',
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '090-0000-0000',
    people: '2名',
    purpose: '撮影',
    paymentMethod: '現金',
    status: 'CONFIRMED',
    calendarEventId: 'event-1',
    source: 'test',
    note: '',
    confirmedAt: new Date('2026-10-02T08:30:00+09:00'),
    customerType: 'returning',
    confirmedMailSentAt: new Date('2026-10-02T08:30:00+09:00'),
    reminderSentAt: '',
    accessGuideSentAt: ''
  }, overrides || {});
}

/* Stripeカード決済・事前受付（決済ゲート対象）。 */
function cardRecord(overrides) {
  return cashRecord(Object.assign({
    createdAt: new Date('2026-09-20T10:00:00+09:00'),
    paymentMethod: 'オンラインクレジットカード',
    paymentStatus: 'paid',
    paymentAttemptId: 'PAY-' + BOOKING_ID + '-ABCDEF012345',
    stripeCheckoutSessionId: 'cs_test_0001',
    stripePaymentIntentId: 'pi_test_0001',
    stripeAmount: 8000,
    stripeCurrency: 'JPY',
    paymentConfirmedAt: new Date('2026-09-20T10:10:00+09:00'),
    lastStripeEventId: 'evt_0001'
  }, overrides || {}));
}

function setup(record, options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var mailApp = opts.mailApp || stubs.createMailAppStub();
  var logger = stubs.createLoggerStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(Object.assign({}, PROPERTIES, opts.properties || {})),
    LockService: stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub(opts.calendarsById || { cal1: { events: [] } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripeは呼ばない'); }),
    Utilities: stubs.createUtilitiesStub(),
    CacheService: stubs.createCacheServiceStub(),
    MailApp: mailApp,
    ScriptApp: opts.scriptApp || stubs.createScriptAppStub(),
    Logger: logger
  };
  if (opts.clock) globals.Date = opts.clock.Date;
  var files = manifest.BOOKING_ADMIN_FILES.concat(opts.extraFiles || []);
  var sandbox = loadBookingSandbox(files, globals);
  if (record) sandbox.SpreadsheetRepository.appendBooking(record);
  return { sandbox: sandbox, mailApp: mailApp, logger: logger };
}

function rec(ctx) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
}

function guideMails(ctx) {
  return ctx.mailApp._sentEmails.filter(function (m) { return String(m.body).indexOf(KEYBOX) !== -1; });
}

function sendSameDay(ctx, now) {
  return ctx.sandbox.BookingMailer.sendImmediateAccessGuideForBooking(BOOKING_ID, { now: now || NOW });
}

test('当日送信の来場案内メールは「本日のご利用案内」になる（Issue #420）', function () {
  var ctx = setup(cashRecord());
  sendSameDay(ctx);
  assert.strictEqual(guideMails(ctx).length, 1);
  assert.match(guideMails(ctx)[0].subject, /本日のご利用案内/);
  assert.match(guideMails(ctx)[0].body, /本日のご予約について/);
  assert.strictEqual(guideMails(ctx)[0].body.indexOf('明日'), -1);
});

test('当日 + CONFIRMED + 全ゲートOK → 来場案内を即時送信し、reminderSentAt/accessGuideSentAtを更新する', function () {
  var ctx = setup(cashRecord());
  var result = sendSameDay(ctx);
  assert.strictEqual(result.success, true);
  assert.ok(!result.skipped);
  assert.strictEqual(guideMails(ctx).length, 1);
  assert.strictEqual(ctx.mailApp._sentEmails[0].to, 'taro@example.com');
  assert.ok(stubs.isDateLike(rec(ctx).reminderSentAt));
  assert.ok(stubs.isDateLike(rec(ctx).accessGuideSentAt));
});

test('同一ルールがSNB / SNB mens / Studio Xの直接予約すべてに適用される', function () {
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var ctx = setup(cashRecord({ brand: brand }));
    assert.strictEqual(sendSameDay(ctx).success, true, brand);
    assert.strictEqual(guideMails(ctx).length, 1, brand);
  });
});

test('当日 + 送信済み → スキップ（二重送信しない）', function () {
  var sent = new Date('2026-10-02T08:40:00+09:00');
  var ctx = setup(cashRecord({ reminderSentAt: sent, accessGuideSentAt: sent }));
  var result = sendSameDay(ctx);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('当日即時送信後に通常送信関数（前日トリガー・targetDateString指定）を再実行しても二重送信しない', function () {
  var ctx = setup(cashRecord());
  sendSameDay(ctx);
  assert.strictEqual(guideMails(ctx).length, 1);
  sendSameDay(ctx);
  var again = ctx.sandbox.BookingMailer.sendReminderMailForBooking(BOOKING_ID, { targetDateString: '2026-10-02' });
  assert.strictEqual(again.skipped, true);
  assert.strictEqual(again.reason, 'ALREADY_SENT');
  assert.strictEqual(guideMails(ctx).length, 1);
});

test('force:true の管理者明示再送は従来どおり可能', function () {
  var ctx = setup(cashRecord());
  sendSameDay(ctx);
  var forced = ctx.sandbox.BookingMailer.sendReminderMailForBooking(BOOKING_ID, { force: true });
  assert.strictEqual(forced.success, true);
  assert.strictEqual(guideMails(ctx).length, 2);
});

test('当日 + 入金済みのカード事前受付 → 鍵承認なしでも送信する（Issue #414の方針）', function () {
  var ctx = setup(cardRecord());
  assert.strictEqual(sendSameDay(ctx).success, true);
  assert.strictEqual(guideMails(ctx).length, 1);
});

test('当日受付のStripe予約: 入金済み・Recovery正常なら鍵承認なしで即時送信する（Issue #414の方針）', function () {
  var ctx = setup(cardRecord({ createdAt: new Date('2026-10-02T08:00:00+09:00') }));
  assert.strictEqual(sendSameDay(ctx).success, true);
  assert.strictEqual(guideMails(ctx).length, 1);
});

test('当日受付のStripe予約: 未入金・Recovery未解消は送信しない', function () {
  var approvedAt = new Date('2026-10-02T08:50:00+09:00');
  var created = new Date('2026-10-02T08:00:00+09:00');
  var unpaid = setup(cardRecord({ createdAt: created, paymentStatus: 'checkout_pending', accessApprovedAt: approvedAt }));
  assert.strictEqual(sendSameDay(unpaid).error.code, 'PAYMENT_NOT_SETTLED');
  var recovery = setup(cardRecord({ createdAt: created, paymentRecoveryRequiredAt: approvedAt, accessApprovedAt: approvedAt }));
  assert.strictEqual(sendSameDay(recovery).error.code, 'PAYMENT_RECOVERY_REQUIRED');
  assert.strictEqual(unpaid.mailApp._sentEmails.length + recovery.mailApp._sentEmails.length, 0);
});

test('当日受付のStripe予約でも、管理者の通常再送（従来ゲート）は従来どおり可能', function () {
  var ctx = setup(cardRecord({ createdAt: new Date('2026-10-02T08:00:00+09:00') }));
  var forced = ctx.sandbox.BookingMailer.sendReminderMailForBooking(BOOKING_ID, { force: true });
  assert.strictEqual(forced.success, true);
});

test('確定メール: 利用日が当日なら「利用日前日に別途送る」と書かず、即時送信と矛盾しない文言にする', function () {
  var clock = stubs.createControllableClock(NOW);
  var ctx = setup(null, { clock: clock });
  var T = ctx.sandbox.BookingMailTemplates;
  var config = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };

  var cash = T.buildConfirmedMail(cashRecord(), config).body;
  assert.ok(/このあと、来場方法・キーボックス等の詳細案内を別途メールでお送りします。/.test(cash));
  assert.ok(cash.indexOf('利用日前日') === -1);

  var card = T.buildConfirmedMail(cardRecord({ createdAt: new Date('2026-10-02T08:00:00+09:00') }), config).body;
  assert.ok(/このあと、来場方法・キーボックス等の詳細案内を別途メールでお送りします。/.test(card));
  assert.ok(card.indexOf('利用日前日') === -1 && card.indexOf('運営での確認') === -1);

  var tomorrow = T.buildConfirmedMail(cashRecord({ date: '2026-10-03' }), config).body;
  assert.ok(/利用日前日に別途メールでお送りします。/.test(tomorrow), '翌日以降は従来の文言');
});

test('当日 + PAYMENT_NOT_SETTLED → スキップ', function () {
  var ctx = setup(cardRecord({ paymentStatus: 'checkout_pending', accessApprovedAt: new Date('2026-10-02T08:50:00+09:00') }));
  var result = sendSameDay(ctx);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.error.code, 'PAYMENT_NOT_SETTLED');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('当日 + PAYMENT_RECOVERY_REQUIRED → スキップ', function () {
  var ctx = setup(cardRecord({
    paymentRecoveryRequiredAt: new Date('2026-10-02T08:45:00+09:00'),
    accessApprovedAt: new Date('2026-10-02T08:50:00+09:00')
  }));
  var result = sendSameDay(ctx);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.error.code, 'PAYMENT_RECOVERY_REQUIRED');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('当日 + メールアドレスなし → 送信せず、SentAtを更新しない', function () {
  var ctx = setup(cashRecord({ email: '' }));
  var result = sendSameDay(ctx);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'EMAIL_MISSING');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
  assert.ok(!rec(ctx).reminderSentAt);
});

test('当日 + 来場案内Script Properties不足 → fail-closed（送信せず、予約はCONFIRMEDのまま）', function () {
  var ctx = setup(cashRecord(), { properties: { ACCESS_GUIDE_UNLOCK_CODE: '' } });
  var result = sendSameDay(ctx);
  assert.strictEqual(result.success, false);
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
  assert.strictEqual(rec(ctx).status, 'CONFIRMED');
  assert.ok(!rec(ctx).reminderSentAt);
});

test('翌日予約（19時前の確定）・2日以上先の予約は即時送信しない', function () {
  [['2026-10-03', 'NEXT_DAY_BEFORE_IMMEDIATE_WINDOW'], ['2026-10-04', 'NOT_SAME_DAY'], ['2026-11-15', 'NOT_SAME_DAY']].forEach(function (c) {
    var ctx = setup(cashRecord({ date: c[0] }));
    var result = sendSameDay(ctx);
    assert.strictEqual(result.skipped, true, c[0]);
    assert.strictEqual(result.reason, c[1], c[0]);
    assert.strictEqual(ctx.mailApp._sentEmails.length, 0, c[0]);
  });
});

test('翌日予約は従来どおり sendNextDayReminders（前日18時台）の対象のまま', function () {
  var ctx = setup(cashRecord({ date: '2026-10-03' }));
  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.sentCount, 1);
  assert.strictEqual(guideMails(ctx).length, 1);
});

test('PENDING等CONFIRMED以外は即時送信しない', function () {
  var ctx = setup(cashRecord({ status: 'PENDING' }));
  var result = sendSameDay(ctx);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.reason, 'INVALID_STATUS');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('timezone基準の当日判定: UTCでは前日でもJSTで当日なら送信する', function () {
  var ctx = setup(cashRecord());
  /* 2026-10-01T20:00Z = JST 2026-10-02 05:00 */
  assert.strictEqual(sendSameDay(ctx, new Date('2026-10-01T20:00:00Z')).success, true);
  assert.strictEqual(guideMails(ctx).length, 1);
});

test('メール送信失敗は予約のCONFIRMED状態を壊さず、失敗を記録し、ログに秘密情報を残さない', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('quota taro@example.com ' + UNLOCK) });
  var ctx = setup(cashRecord(), { mailApp: mailApp });
  var result = sendSameDay(ctx);
  assert.strictEqual(result.success, false);
  var record = rec(ctx);
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.ok(!record.reminderSentAt);
  assert.ok(record.lastMailErrorAt, 'lastMailError*へ記録する');
  assert.ok(String(record.lastMailErrorMessage).indexOf(UNLOCK) === -1);
  assert.ok(String(record.lastMailErrorMessage).indexOf('taro@example.com') === -1);
});

/* createBookingの入力検証・レート制限・料金計算に必要な公開側ファイルを足し、実時刻をNOWへ固定する。 */
function pendingTodayCtx(options) {
  var o = options || {};
  var clock = stubs.createControllableClock(NOW);
  var ctx = setup(null, {
    clock: clock,
    extraFiles: ['JapaneseHolidays.gs', 'BookingPricing.gs', 'RateLimiter.gs'].filter(function (f) {
      return manifest.BOOKING_ADMIN_FILES.indexOf(f) === -1;
    })
  });
  var created = ctx.sandbox.BookingRepository.createBooking({
    brand: 'studio_x',
    date: o.date || '2026-10-02',
    startTime: '13:00',
    durationMinutes: 120,
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '090-1234-5678',
    people: '2名',
    purpose: '撮影',
    paymentMethod: '現金',
    customerType: 'returning',
    note: '',
    source: 'test'
  }, NOW);
  assert.strictEqual(created.success, true, JSON.stringify(created));
  if (o.now) clock.advanceByMillis(o.now.getTime() - NOW.getTime());
  return { ctx: ctx, bookingId: created.bookingId };
}

test('confirmBooking: 当日予約を確定すると確定メールに続き来場案内が即時送信される', function () {
  var p = pendingTodayCtx();
  var result = p.ctx.sandbox.confirmBooking(p.bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.accessGuideSent, true);
  assert.strictEqual(guideMails(p.ctx).length, 1);
  var found = p.ctx.sandbox.SpreadsheetRepository.findRowByBookingId(p.bookingId).record;
  assert.strictEqual(found.status, 'CONFIRMED');
  assert.ok(stubs.isDateLike(found.accessGuideSentAt));
});

test('confirmBooking: 来場案内の送信が例外でも確定は成功のままで、ログに秘密情報を残さない', function () {
  var p = pendingTodayCtx();
  p.ctx.sandbox.BookingMailer.sendImmediateAccessGuideForBooking = function () { throw new Error('boom ' + UNLOCK + ' taro@example.com'); };
  var result = p.ctx.sandbox.confirmBooking(p.bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.accessGuideSent, false);
  var logs = p.ctx.logger._logs.join('\n');
  assert.ok(logs.indexOf('taro@example.com') === -1, 'メールアドレスをログに残さない');
});

/* ---- Issue #416: 前日19時以降の翌日予約の即時送信と21時catch-up ---- */

var NEXT_DAY = '2026-10-03';
function at(time) { return new Date('2026-10-02T' + time + '+09:00'); }

test('翌日予約: 18:59確定は即時送信しない / 19:00・23:59確定は即時送信する', function () {
  var early = setup(cashRecord({ date: NEXT_DAY }));
  var r = sendSameDay(early, at('18:59:59'));
  assert.strictEqual(r.reason, 'NEXT_DAY_BEFORE_IMMEDIATE_WINDOW');
  assert.strictEqual(early.mailApp._sentEmails.length, 0);

  ['19:00:00', '23:59:59'].forEach(function (time) {
    var ctx = setup(cashRecord({ date: NEXT_DAY }));
    assert.strictEqual(sendSameDay(ctx, at(time)).success, true, time);
    assert.strictEqual(guideMails(ctx).length, 1, time);
    assert.ok(stubs.isDateLike(rec(ctx).accessGuideSentAt), time);
  });
});

test('翌々日予約は19時以降でも即時送信しない', function () {
  var ctx = setup(cashRecord({ date: '2026-10-04' }));
  var r = sendSameDay(ctx, at('19:00:00'));
  assert.strictEqual(r.reason, 'NOT_SAME_DAY');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('JST日付境界: UTCでは同日でもJSTで翌日0時以降なら、その日の「今日」基準で判定する', function () {
  /* 2026-10-02T15:30Z = JST 10-03 00:30。10-03の予約は当日扱い、10-04の予約は翌日だが0時台なので対象外。 */
  var nowUtc = new Date('2026-10-02T15:30:00Z');
  var today = setup(cashRecord({ date: '2026-10-03' }));
  assert.strictEqual(sendSameDay(today, nowUtc).success, true);
  assert.strictEqual(guideMails(today).length, 1);
  var tomorrow = setup(cashRecord({ date: '2026-10-04' }));
  assert.strictEqual(sendSameDay(tomorrow, nowUtc).reason, 'NEXT_DAY_BEFORE_IMMEDIATE_WINDOW');
});

test('翌日19時以降: 現金・PayPay・カード入金済みは送信し、未入金・Recovery未解消は送信しない', function () {
  ['現金', 'PayPay'].forEach(function (method) {
    var ctx = setup(cashRecord({ date: NEXT_DAY, paymentMethod: method }));
    assert.strictEqual(sendSameDay(ctx, at('20:00:00')).success, true, method);
    assert.strictEqual(guideMails(ctx).length, 1, method);
  });
  assert.strictEqual(sendSameDay(setup(cardRecord({ date: NEXT_DAY })), at('20:00:00')).success, true);
  var unpaid = setup(cardRecord({ date: NEXT_DAY, paymentStatus: 'unpaid', paymentConfirmedAt: '' }));
  assert.strictEqual(sendSameDay(unpaid, at('20:00:00')).error.code, 'PAYMENT_NOT_SETTLED');
  var recovery = setup(cardRecord({ date: NEXT_DAY, paymentRecoveryRequiredAt: new Date('2026-10-02T12:00:00+09:00') }));
  assert.strictEqual(sendSameDay(recovery, at('20:00:00')).error.code, 'PAYMENT_RECOVERY_REQUIRED');
  assert.strictEqual(recovery.mailApp._sentEmails.length, 0);
});

test('翌日19時以降: メール欠落・Script Properties不足はfail-closed', function () {
  var noEmail = setup(cashRecord({ date: NEXT_DAY, email: '' }));
  assert.strictEqual(sendSameDay(noEmail, at('20:00:00')).success, false);
  assert.strictEqual(noEmail.mailApp._sentEmails.length, 0);
  var noConfig = setup(cashRecord({ date: NEXT_DAY }), { properties: { ACCESS_GUIDE_UNLOCK_CODE: '' } });
  assert.strictEqual(sendSameDay(noConfig, at('20:00:00')).success, false);
  assert.strictEqual(noConfig.mailApp._sentEmails.length, 0);
  assert.strictEqual(rec(noConfig).status, 'CONFIRMED');
});

test('文言(Issue #420): 19時以降の即時送信・21時catch-up・18時台通常便は「明日」、当日即時送信は「本日」', function () {
  var immediate = setup(cashRecord({ date: NEXT_DAY }));
  sendSameDay(immediate, at('19:00:00'));
  assert.match(guideMails(immediate)[0].subject, /明日のご利用案内/);
  assert.match(guideMails(immediate)[0].body, /明日のご予約について/);

  var catchUp = setup(cashRecord({ date: NEXT_DAY }));
  catchUp.sandbox.sendNextDayReminderCatchUp(at('21:10:00'));
  assert.match(guideMails(catchUp)[0].subject, /明日のご利用案内/);

  var regular = setup(cashRecord({ date: NEXT_DAY }));
  regular.sandbox.sendNextDayReminders(at('18:00:00'));
  assert.match(guideMails(regular)[0].subject, /明日のご利用案内/);

  var sameDay = setup(cashRecord({ date: '2026-10-02' }));
  sendSameDay(sameDay, at('19:30:00'));
  assert.match(guideMails(sameDay)[0].subject, /本日のご利用案内/);
});

test('21時catch-up: 18時台通常便の後に確定した翌日予約（未送信）を送る', function () {
  var ctx = setup(cashRecord({ date: NEXT_DAY }));
  var summary = ctx.sandbox.sendNextDayReminderCatchUp(at('21:10:00'));
  assert.strictEqual(summary.sentCount, 1);
  assert.strictEqual(guideMails(ctx).length, 1);
});

test('21時catch-up: 19時以降の即時送信済み・18時台通常便送信済みの予約は二重送信しない', function () {
  var immediate = setup(cashRecord({ date: NEXT_DAY }));
  sendSameDay(immediate, at('19:30:00'));
  var s1 = immediate.sandbox.sendNextDayReminderCatchUp(at('21:10:00'));
  assert.strictEqual(s1.sentCount, 0);
  assert.strictEqual(s1.skippedCount, 1);
  assert.strictEqual(guideMails(immediate).length, 1);

  var regular = setup(cashRecord({ date: NEXT_DAY }));
  regular.sandbox.sendNextDayReminders(at('18:20:00'));
  var s2 = regular.sandbox.sendNextDayReminderCatchUp(at('21:10:00'));
  assert.strictEqual(s2.sentCount, 0);
  assert.strictEqual(guideMails(regular).length, 1);
});

test('21時catch-up: Stripe未入金・Recovery未解消は送らず、forceもしない', function () {
  var unpaid = setup(cardRecord({ date: NEXT_DAY, paymentStatus: 'unpaid', paymentConfirmedAt: '' }));
  var s1 = unpaid.sandbox.sendNextDayReminderCatchUp(at('21:10:00'));
  assert.strictEqual(s1.sentCount, 0);
  assert.strictEqual(s1.accessGateSkippedCount, 1);
  assert.strictEqual(unpaid.mailApp._sentEmails.filter(function (m) { return String(m.body).indexOf(KEYBOX) !== -1; }).length, 0);

  var recovery = setup(cardRecord({ date: NEXT_DAY, paymentRecoveryRequiredAt: new Date('2026-10-02T12:00:00+09:00') }));
  var s2 = recovery.sandbox.sendNextDayReminderCatchUp(at('21:10:00'));
  assert.strictEqual(s2.sentCount, 0);
  assert.strictEqual(guideMails(recovery).length, 0);
});

test('21時catch-up: 翌日以外・CONFIRMED以外は対象外。現金・PayPayは対象', function () {
  var today = setup(cashRecord({ date: '2026-10-02' }));
  assert.strictEqual(today.sandbox.sendNextDayReminderCatchUp(at('21:10:00')).processedCount, 0);
  var pending = setup(cashRecord({ date: NEXT_DAY, status: 'PENDING' }));
  assert.strictEqual(pending.sandbox.sendNextDayReminderCatchUp(at('21:10:00')).processedCount, 0);
  var paypay = setup(cashRecord({ date: NEXT_DAY, paymentMethod: 'PayPay' }));
  assert.strictEqual(paypay.sandbox.sendNextDayReminderCatchUp(at('21:10:00')).sentCount, 1);
});

test('createNextDayReminderCatchUpTrigger: 21時台のトリガーを二重作成せず、18時台のトリガーとは別', function () {
  var scriptApp = stubs.createScriptAppStub();
  var ctx = setup(null, { scriptApp: scriptApp });
  ctx.sandbox.createNextDayReminderCatchUpTrigger();
  ctx.sandbox.createNextDayReminderCatchUpTrigger();
  ctx.sandbox.createNextDayReminderTrigger();
  var handlers = scriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); }).sort();
  assert.deepStrictEqual(handlers, ['sendNextDayReminderCatchUp', 'sendNextDayReminders']);
});

test('confirmBooking: 翌日予約を19時以降に確定すると来場案内が即時送信され、18時台は送信されない', function () {
  var late = pendingTodayCtx({ date: NEXT_DAY, now: at('19:00:00') });
  var r = late.ctx.sandbox.confirmBooking(late.bookingId);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.accessGuideSent, true);
  assert.strictEqual(guideMails(late.ctx).length, 1);
});
