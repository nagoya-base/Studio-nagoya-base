/*
 * Booking Admin の利用後アンケート案内メール（gas/booking/admin/FeedbackInvites.gs。Issue #834 第3段階）。
 * Spreadsheet・Lock・Mail・Properties はすべてスタブ。実予約・実メールには触れない。
 *
 * 受入テスト1（2時間後まで送らない・延長／変更／取消／未決済で誤送信しない）、
 * 2（3ブランドの件名・リンク・期限・旧surveyへ飛ばない）、3（自動メールは1予約1回・並列／重複／失敗）、
 * 6（DRY_RUN・初期OFF・過去予約へ遡及しない・メール失敗時に予約を変えない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('crypto');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var TokenCore = require('../scripts/feedback-token-core.js');

var FILES = ['Config.gs', 'Availability.gs', 'Booking.gs', 'SpreadsheetRepository.gs', 'FeedbackTokenCore.gs', 'FeedbackInvites.gs'];
var SPREADSHEET_ID = 'ss-booking';
var SECRET = 'feedback-secret-0123456789abcdefghijklmnop';
var HOUR = 3600 * 1000;

var END = new Date('2026-12-05T15:00:00+09:00');
var AFTER_2H = new Date(END.getTime() + 2 * HOUR);
var START_AT = '2026-12-01T00:00:00+09:00';

var ON = {
  FEEDBACK_INVITE_MODE: 'on',
  FEEDBACK_INVITE_START_AT: START_AT,
  FEEDBACK_TOKEN_SECRET: SECRET,
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

function hmacHex(key, message) { return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex'); }
function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(options) {
  var opts = options || {};
  var sheets = {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = sheets;
  var properties = Object.assign({ SPREADSHEET_ID: SPREADSHEET_ID }, opts.properties === undefined ? ON : opts.properties);
  var logger = stubs.createLoggerStub();
  var mailApp = stubs.createMailAppStub({ throwError: opts.mailError, remainingQuota: opts.remainingQuota });
  var lockService = stubs.createLockServiceStub({ forceTryLockFail: !!opts.lockFails });
  if (opts.onLock) {
    var base = lockService.getScriptLock;
    lockService.getScriptLock = function () {
      var lock = base();
      var tryLock = lock.tryLock;
      lock.tryLock = function () { var ok = tryLock(); if (ok) opts.onLock(); return ok; };
      return lock;
    };
  }
  var sandbox = loadBookingSandbox(FILES, {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    LockService: lockService,
    MailApp: mailApp,
    ScriptApp: stubs.createScriptAppStub(),
    Utilities: stubs.createUtilitiesStub(),
    Logger: logger
  });
  var ctx = { sandbox: sandbox, sheets: sheets, mails: mailApp._sentEmails, logs: logger._logs, properties: properties };
  if (opts.setupSheet !== false) sandbox.setupFeedbackInvites();
  return ctx;
}

var seq = 0;
function seed(ctx, overrides) {
  seq++;
  var record = Object.assign({
    bookingId: 'SNB-TEST-' + seq,
    createdAt: new Date('2026-11-20T10:00:00+09:00'),
    date: '2026-12-05',
    startAt: new Date(END.getTime() - 3 * HOUR),
    endAt: END,
    brand: 'snb',
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '090-0000-0000',
    people: '2',
    purpose: '緊縛の自主練習',
    paymentMethod: '現金',
    status: 'CONFIRMED',
    source: 'snb-booking-app',
    confirmedAt: new Date('2026-11-20T11:00:00+09:00'),
    paymentStatus: 'not_started',
    revision: 1
  }, overrides || {});
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);
  return record.bookingId;
}

function invites(ctx) {
  var sheet = ctx.sheets.FeedbackInvites;
  var header = sheet._rows[0];
  return sheet._rows.slice(1).map(function (r) {
    var o = {};
    header.forEach(function (h, i) { o[h] = r[i]; });
    return o;
  });
}

function bookingsSnapshot(ctx) {
  return JSON.stringify(ctx.sheets.Bookings._rows);
}

function tokenFromMail(mail) {
  var m = /\/feedback\/([a-z-]+)\/#t=([0-9a-z]+)/.exec(mail.body);
  return m ? { brand: m[1], token: m[2] } : null;
}

// ============================================================================
// 初期OFF・DRY_RUN・設定不足
// ============================================================================

test('初期OFF: FEEDBACK_INVITE_MODE 未設定なら、対象の予約があっても何も読まず・送らず・書かない', function () {
  var props = Object.assign({}, ON);
  delete props.FEEDBACK_INVITE_MODE;
  var ctx = setup({ properties: props });
  seed(ctx);
  var before = bookingsSnapshot(ctx);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  assert.strictEqual(summary.status, 'OFF');
  assert.strictEqual(summary.scanned, 0);
  assert.strictEqual(ctx.mails.length, 0);
  assert.strictEqual(invites(ctx).length, 0);
  assert.strictEqual(bookingsSnapshot(ctx), before);
});

test('初期OFF: on 以外の値（true / yes / enabled 等）はOFF扱い', function () {
  ['true', 'yes', 'enabled', '1', 'off'].forEach(function (value) {
    var ctx = setup({ properties: Object.assign({}, ON, { FEEDBACK_INVITE_MODE: value }) });
    seed(ctx);
    assert.strictEqual(plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H)).status, 'OFF', value);
    assert.strictEqual(ctx.mails.length, 0);
  });
});

test('DRY_RUN: dryRunFeedbackInvites と MODE=dry_run は、件数・除外理由・送信予定IDだけを返し、メールもシートも変えない', function () {
  [{ props: Object.assign({}, ON, { FEEDBACK_INVITE_MODE: '' }), fn: 'dryRunFeedbackInvites' },
    { props: Object.assign({}, ON, { FEEDBACK_INVITE_MODE: 'dry_run' }), fn: 'sendFeedbackInvites' }].forEach(function (c) {
    var ctx = setup({ properties: c.props });
    var target = seed(ctx);
    seed(ctx, { status: 'CANCELLED' });
    seed(ctx, { source: 'spacemarket' });
    seed(ctx, { endAt: new Date(AFTER_2H.getTime() - HOUR), startAt: new Date(AFTER_2H.getTime() - 3 * HOUR) });
    var before = bookingsSnapshot(ctx);
    var summary = plain(ctx.sandbox[c.fn](AFTER_2H));
    assert.strictEqual(summary.dryRun, true);
    assert.strictEqual(summary.scanned, 4);
    assert.strictEqual(summary.eligible, 1);
    assert.deepStrictEqual(summary.wouldSend, [target]);
    assert.deepStrictEqual(summary.reasons, { NOT_CONFIRMED: 1, NOT_DIRECT_BOOKING: 1, NOT_YET: 1 });
    assert.strictEqual(ctx.mails.length, 0);
    assert.strictEqual(invites(ctx).length, 0);
    assert.strictEqual(bookingsSnapshot(ctx), before);
    var log = ctx.logs.join('\n');
    assert.ok(log.indexOf('taro@example.com') === -1 && log.indexOf(SECRET) === -1, 'ログにメール・秘密鍵を出さない');
  });
});

test('DRY_RUN: 設定不足（開始日時・秘密鍵・メール設定・シート未作成）を値なしで報告する', function () {
  var ctx = setup({ properties: { FEEDBACK_INVITE_MODE: 'dry_run' }, setupSheet: false });
  seed(ctx);
  var summary = plain(ctx.sandbox.dryRunFeedbackInvites(AFTER_2H));
  assert.deepStrictEqual(summary.problems, ['START_AT_NOT_SET', 'TOKEN_SECRET_NOT_SET', 'MAIL_CONFIG_INCOMPLETE', 'FEEDBACK_INVITES_NOT_INITIALIZED']);
  assert.deepStrictEqual(summary.reasons, { START_AT_NOT_SET: 1 });
  assert.strictEqual(ctx.mails.length, 0);
});

test('ON でも設定不足なら1通も送らない（CONFIG_INCOMPLETE）', function () {
  [{ FEEDBACK_INVITE_START_AT: '' }, { FEEDBACK_INVITE_START_AT: '2026-12-01 00:00' }, { FEEDBACK_TOKEN_SECRET: 'short' }, { BOOKING_CONTACT_EMAIL: '' }].forEach(function (override) {
    var ctx = setup({ properties: Object.assign({}, ON, override) });
    seed(ctx);
    var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
    assert.strictEqual(summary.status, 'CONFIG_INCOMPLETE', JSON.stringify(override));
    assert.strictEqual(ctx.mails.length, 0);
  });
  var noSheet = setup({ setupSheet: false });
  seed(noSheet);
  assert.strictEqual(plain(noSheet.sandbox.sendFeedbackInvites(AFTER_2H)).status, 'CONFIG_INCOMPLETE');
  assert.strictEqual(noSheet.mails.length, 0);
});

// ============================================================================
// 受入1: 送信タイミング・変更・延長・取消・未決済
// ============================================================================

test('受入1: 最終終了時刻の2時間後より前は送らず、2時間後ちょうどから送る', function () {
  var ctx = setup();
  var id = seed(ctx);
  ctx.sandbox.sendFeedbackInvites(new Date(AFTER_2H.getTime() - 60 * 1000));
  assert.strictEqual(ctx.mails.length, 0);
  assert.strictEqual(invites(ctx).length, 0);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  assert.strictEqual(summary.sent, 1);
  assert.strictEqual(ctx.mails.length, 1);
  var row = invites(ctx)[0];
  assert.strictEqual(row.bookingId, id);
  assert.strictEqual(row.state, 'SENT');
  assert.strictEqual(new Date(row.endAt).getTime(), END.getTime());
  assert.strictEqual(new Date(row.expiresAt).getTime(), END.getTime() + 14 * 24 * HOUR);
});

test('受入1: 延長・日時変更後は最新の終了時刻で判定する（旧終了時刻の2時間後には送らない）', function () {
  var ctx = setup();
  var extendedEnd = new Date(END.getTime() + 2 * HOUR);
  seed(ctx, { endAt: extendedEnd });
  ctx.sandbox.sendFeedbackInvites(AFTER_2H);
  assert.strictEqual(ctx.mails.length, 0, '延長後の終了＋2時間まで待つ');
  ctx.sandbox.sendFeedbackInvites(new Date(extendedEnd.getTime() + 2 * HOUR));
  assert.strictEqual(ctx.mails.length, 1);
  assert.strictEqual(new Date(invites(ctx)[0].endAt).getTime(), extendedEnd.getTime());
});

test('受入1: 抽出後・送信直前に延長／取消／未決済へ変わった予約は、ロック内の再読込で止める', function () {
  [
    { name: '延長', change: { endAt: new Date(END.getTime() + 3 * HOUR) }, reason: 'NOT_YET' },
    { name: '取消', change: { status: 'CANCELLED', cancelledAt: new Date() }, reason: 'NOT_CONFIRMED' },
    { name: '延長料金の未入金', change: { feeSettlementState: 'PENDING_CHARGE' }, reason: 'EXTENSION_CHARGE_PENDING' },
    { name: '返金', change: { refundDecision: 'FULL' }, reason: 'REFUND_STARTED' }
  ].forEach(function (c) {
    var ctx;
    var id;
    ctx = setup({
      onLock: function () {
        var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(id);
        if (found) ctx.sandbox.SpreadsheetRepository.updateBookingFields(id, c.change);
      }
    });
    id = seed(ctx);
    var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
    assert.strictEqual(ctx.mails.length, 0, c.name);
    assert.strictEqual(summary.reasons[c.reason], 1, c.name + ' ' + JSON.stringify(summary.reasons));
    assert.strictEqual(invites(ctx).length, 0, c.name + ': 行を作らない（後で条件を満たせば送れる）');
  });
});

test('受入1: 除外・保留の条件（取消・失効・仮予約・外部予約・未決済・要復旧・返金・メール不正・ブランド外）', function () {
  var ctx = setup();
  var cases = {
    NOT_CONFIRMED: [{ status: 'CANCELLED' }, { status: 'EXPIRED' }, { status: 'PENDING' }],
    NOT_DIRECT_BOOKING: [{ source: 'spacemarket' }, { source: 'unknown' }, { source: 'mens-booking-app' }, { source: '' }],
    BRAND_NOT_TARGET: [{ brand: 'other' }, { brand: '' }],
    PAYMENT_UNVERIFIED: [{ confirmedAt: '' }],
    PAYMENT_NOT_SETTLED: [
      { paymentMethod: 'カード', paymentStatus: 'checkout_pending', stripeCheckoutSessionId: 'cs_1' },
      { paymentMethod: 'カード', paymentStatus: 'failed', stripeCheckoutSessionId: 'cs_2' }
    ],
    REFUND_STARTED: [{ refundRequestedAt: new Date() }, { refundedAt: new Date() }],
    EXTENSION_CHARGE_PENDING: [{ feeSettlementState: 'PENDING_CHARGE' }, { feeSettlementState: 'PENDING_DECISION' }],
    RECOVERY_REQUIRED: [{ feeRecoveryRequiredAt: new Date() }, { paymentRecoveryRequiredAt: new Date() }],
    EMAIL_MISSING: [{ email: '' }, { email: 'not-an-email' }],
    END_INVALID: [{ endAt: '' }, { startAt: END }]
  };
  var expected = {};
  Object.keys(cases).forEach(function (reason) {
    cases[reason].forEach(function (override) { seed(ctx, override); });
    expected[reason] = cases[reason].length;
  });
  var paid = seed(ctx, { paymentMethod: 'カード', paymentStatus: 'paid', stripeCheckoutSessionId: 'cs_ok', paymentConfirmedAt: new Date() });
  var before = bookingsSnapshot(ctx);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  assert.deepStrictEqual(summary.reasons, expected);
  assert.strictEqual(summary.sent, 1);
  assert.deepStrictEqual(invites(ctx).map(function (r) { return r.bookingId; }), [paid], '入金済みのカード予約だけに送る');
  assert.strictEqual(bookingsSnapshot(ctx), before, '予約台帳は変えない');
});

// ============================================================================
// 受入6: 過去予約へ遡及しない・送信期限の窓
// ============================================================================

test('受入6: FEEDBACK_INVITE_START_AT より前に終了した予約へは送らない（ONにした瞬間の遡及一斉送信なし）', function () {
  var ctx = setup({ properties: Object.assign({}, ON, { FEEDBACK_INVITE_START_AT: '2026-12-05T15:00:01+09:00' }) });
  seed(ctx);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  assert.deepStrictEqual(summary.reasons, { BEFORE_START_AT: 1 });
  assert.strictEqual(ctx.mails.length, 0);
});

test('受入6: 終了2時間後から48時間を過ぎた予約へは自動送信しない（トリガー停止明けの一斉送信なし）', function () {
  var ctx = setup();
  seed(ctx);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(new Date(AFTER_2H.getTime() + 48 * HOUR + 1000)));
  assert.deepStrictEqual(summary.reasons, { TOO_LATE: 1 });
  assert.strictEqual(ctx.mails.length, 0);
});

// ============================================================================
// 受入2: 3ブランドの件名・本文・リンク
// ============================================================================

test('受入2: 3ブランドの件名・送信先フォーム・14日期限。件名と本文冒頭に利用目的・予約情報・トークンを出さない', function () {
  var ctx = setup();
  var expected = {
    snb: { subject: '【SNB】ご利用ありがとうございました（アンケートのお願い）', form: 'snb', source: 'snb-booking-app', signature: 'Studio Nagoya Base' },
    mens: { subject: '【SNB mens】ご利用ありがとうございました（アンケートのお願い）', form: 'mens', source: 'mens-booking-app', signature: 'SNB mens（Studio Nagoya Base）' },
    studio_x: { subject: '【Studio X】ご利用ありがとうございました（アンケートのお願い）', form: 'studio-x', source: 'studio-x-booking-app', signature: 'Studio X' }
  };
  var ids = {};
  Object.keys(expected).forEach(function (brand) {
    ids[brand] = seed(ctx, { brand: brand, source: expected[brand].source, email: brand + '@example.com' });
  });
  ctx.sandbox.sendFeedbackInvites(AFTER_2H);
  assert.strictEqual(ctx.mails.length, 3);
  Object.keys(expected).forEach(function (brand) {
    var mail = ctx.mails.filter(function (m) { return m.to === brand + '@example.com'; })[0];
    var e = expected[brand];
    assert.strictEqual(mail.subject, e.subject);
    assert.strictEqual(mail.name, 'Studio Nagoya Base');
    assert.strictEqual(mail.replyTo, 'noreply@example.com');
    var link = tokenFromMail(mail);
    assert.strictEqual(link.brand, e.form);
    assert.ok(mail.body.indexOf('https://nagoya-base.github.io/Studio-nagoya-base/feedback/' + e.form + '/#t=') !== -1);
    assert.ok(!/\/survey\//.test(mail.body), '既存の市場調査アンケートへ送らない');
    assert.ok(!/[?&]t=|token=/.test(mail.body), 'トークンをクエリに載せない');
    var checked = TokenCore.check(link.token, e.form, AFTER_2H.getTime(), SECRET, hmacHex);
    assert.strictEqual(checked.ok, true);
    assert.strictEqual(checked.expiresAtMs, END.getTime() + 14 * 24 * HOUR);
    assert.strictEqual(checked.tokenId, TokenCore.tokenIdFor(ids[brand], SECRET, hmacHex));
    /* 件名・プレビュー（本文冒頭）・本文全体に出さないもの */
    var preview = mail.body.slice(0, 120);
    [link.token, ids[brand], '緊縛', '山田', '2026', '12/5', '090-', 'taro@'].forEach(function (secretish) {
      assert.ok(mail.subject.indexOf(secretish) === -1, brand + ' subject: ' + secretish);
      assert.ok(preview.indexOf(secretish) === -1, brand + ' preview: ' + secretish);
    });
    ['緊縛', '山田', ids[brand], '090-'].forEach(function (word) { assert.ok(mail.body.indexOf(word) === -1, brand + ' body: ' + word); });
    assert.ok(mail.body.indexOf('任意') !== -1 && mail.body.indexOf('約2〜3分') !== -1 && mail.body.indexOf('影響することはありません') !== -1);
    assert.ok(mail.body.indexOf('14日間') !== -1);
    assert.ok(mail.body.indexOf(e.signature) !== -1);
  });
  var studioX = ctx.mails.filter(function (m) { return m.to === 'studio_x@example.com'; })[0];
  assert.ok(!/SNB|Nagoya Base|緊縛/.test(studioX.subject + studioX.body.replace(/https:\/\/nagoya-base\.github\.io\/Studio-nagoya-base\//g, '')), 'Studio Xの文面にSNBの表現を含めない');
});

// ============================================================================
// 受入3: 1予約1回・並列・重複・失敗
// ============================================================================

test('受入3: 同じ予約への自動メールは1回だけ（再実行・連続実行）', function () {
  var ctx = setup();
  seed(ctx);
  ctx.sandbox.sendFeedbackInvites(AFTER_2H);
  ctx.sandbox.sendFeedbackInvites(new Date(AFTER_2H.getTime() + 15 * 60 * 1000));
  ctx.sandbox.sendFeedbackInvites(new Date(AFTER_2H.getTime() + 60 * 60 * 1000));
  assert.strictEqual(ctx.mails.length, 1);
  assert.strictEqual(invites(ctx).length, 1);
  assert.strictEqual(plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H)).alreadyHandled, 1);
});

test('受入3: 並列トリガー（別の実行がロック中）では送らず行も作らない。次の実行で1回だけ送る', function () {
  var ctx = setup({ lockFails: true });
  seed(ctx);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  assert.deepStrictEqual(summary.reasons, { LOCK_TIMEOUT: 1 });
  assert.strictEqual(ctx.mails.length, 0);
  assert.strictEqual(invites(ctx).length, 0);
});

test('受入3: 抽出後に別の実行が先に送信行を作っていたら、ロック内の再確認で送らない', function () {
  var ctx;
  var id;
  ctx = setup({
    onLock: function () {
      var sheet = ctx.sheets.FeedbackInvites;
      if (sheet._rows.length === 1) sheet.appendRow([id, 'snb', 'SENDING', END, new Date(), new Date(), '', '', new Date()]);
    }
  });
  id = seed(ctx);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  assert.deepStrictEqual(summary.reasons, { ALREADY_ATTEMPTED: 1 });
  assert.strictEqual(ctx.mails.length, 0);
  assert.strictEqual(invites(ctx).length, 1);
});

test('受入3/6: メール送信失敗は FAILED を残し、予約・決済・鍵の台帳を変えず、自動では再送しない', function () {
  var ctx = setup({ mailError: new Error('Service invoked too many times for one day: email. to taro@example.com') });
  seed(ctx);
  var before = bookingsSnapshot(ctx);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  assert.strictEqual(summary.failed, 1);
  assert.deepStrictEqual(summary.reasons, { MAIL_SEND_FAILED: 1 });
  assert.strictEqual(invites(ctx)[0].state, 'FAILED');
  assert.strictEqual(invites(ctx)[0].errorCode, 'MAIL_SEND_FAILED');
  assert.strictEqual(bookingsSnapshot(ctx), before, 'Bookings（status・paymentStatus・revision 等）は不変');
  assert.strictEqual(Object.keys(ctx.sheets).sort().join(','), 'Bookings,FeedbackInvites', '他のシート（Recovery 等）を作らない');
  assert.ok(ctx.logs.join('\n').indexOf('taro@example.com') === -1, 'ログに宛先を出さない');
  assert.strictEqual(plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H)).alreadyHandled, 1);
});

test('受入3: 送信後の状態更新に失敗したら SENDING（結果不明）のまま残し、自動では再送しない', function () {
  var ctx = setup();
  seed(ctx);
  var sheet = ctx.sheets.FeedbackInvites;
  var originalGetRange = sheet.getRange;
  var writes = 0;
  sheet.getRange = function (row, col, numRows, numCols) {
    var range = originalGetRange(row, col, numRows, numCols);
    var setValues = range.setValues;
    range.setValues = function (values) {
      writes++;
      throw new Error('Service Spreadsheets failed');
    };
    return range;
  };
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  sheet.getRange = originalGetRange;
  assert.strictEqual(ctx.mails.length, 1);
  assert.strictEqual(summary.sentUnrecorded, 1);
  assert.strictEqual(invites(ctx)[0].state, 'SENDING');
  ctx.sandbox.sendFeedbackInvites(new Date(AFTER_2H.getTime() + HOUR));
  assert.strictEqual(ctx.mails.length, 1, '結果不明のまま無条件に再送しない');
  assert.ok(writes >= 1);
});

test('受入3: 1回の実行で送るのは最大20件。MailAppの残り枠が50通以下なら送らない', function () {
  var ctx = setup();
  for (var i = 0; i < 23; i++) seed(ctx, { email: 'u' + i + '@example.com' });
  var summary = plain(ctx.sandbox.sendFeedbackInvites(AFTER_2H));
  assert.strictEqual(summary.sent, 20);
  assert.strictEqual(summary.status, 'TRUNCATED');
  ctx.sandbox.sendFeedbackInvites(new Date(AFTER_2H.getTime() + 15 * 60 * 1000));
  assert.strictEqual(ctx.mails.length, 23, '残りは次の実行で送る（重複なし）');

  var low = setup({ remainingQuota: 50 });
  seed(low);
  assert.strictEqual(plain(low.sandbox.sendFeedbackInvites(AFTER_2H)).status, 'MAIL_QUOTA_RESERVED');
  assert.strictEqual(low.mails.length, 0);
});

// ============================================================================
// 手動送信（実予約のE2E確認・失敗からの復旧）
// ============================================================================

test('手動送信: モードOFFでも1件送れる。開始日時・送信期限の窓は見ないが、終了2時間後と取消等の条件は守る', function () {
  var props = Object.assign({}, ON, { FEEDBACK_INVITE_MODE: 'off', FEEDBACK_INVITE_START_AT: '' });
  var ctx = setup({ properties: props });
  var id = seed(ctx);
  var cancelled = seed(ctx, { status: 'CANCELLED' });
  var early = plain(ctx.sandbox.FeedbackInvites.sendManually(id, { now: new Date(AFTER_2H.getTime() - 1000) }));
  assert.deepStrictEqual(early, { outcome: 'SKIPPED', reason: 'NOT_YET' });
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(cancelled, { now: AFTER_2H })), { outcome: 'SKIPPED', reason: 'NOT_CONFIRMED' });
  var late = new Date(AFTER_2H.getTime() + 5 * 24 * HOUR);
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(id, { now: late })), { outcome: 'SENT' });
  assert.strictEqual(ctx.mails.length, 1);
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(id, { now: late, confirmNotDelivered: true })), { outcome: 'SKIPPED', reason: 'ALREADY_SENT' });
  assert.strictEqual(ctx.mails.length, 1, '送信済みには手動でも送らない');
  var expired = new Date(END.getTime() + 14 * 24 * HOUR);
  var other = seed(ctx);
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(other, { now: expired })), { outcome: 'SKIPPED', reason: 'LINK_EXPIRED' });
});

test('手動復旧: FAILED / SENDING は「届いていない確認」付きのときだけ再送し、同じリンク（同じトークン）を送る', function () {
  var ctx = setup({ mailError: new Error('temporary') });
  var id = seed(ctx);
  ctx.sandbox.sendFeedbackInvites(AFTER_2H);
  assert.strictEqual(invites(ctx)[0].state, 'FAILED');
  ctx.sandbox.MailApp = stubs.createMailAppStub();
  var mails = ctx.sandbox.MailApp._sentEmails;
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(id, { now: AFTER_2H })), { outcome: 'SKIPPED', reason: 'ALREADY_ATTEMPTED' });
  assert.strictEqual(mails.length, 0);
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(id, { now: AFTER_2H, confirmNotDelivered: true })), { outcome: 'SENT' });
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(invites(ctx).length, 1);
  assert.strictEqual(invites(ctx)[0].state, 'SENT');
  var token = tokenFromMail(mails[0]).token;
  assert.strictEqual(TokenCore.check(token, 'snb', AFTER_2H.getTime(), SECRET, hmacHex).tokenId, TokenCore.tokenIdFor(id, SECRET, hmacHex));
});

test('手動送信の入口: Script Properties から予約IDを読み、実行後は結果にかかわらずプロパティを消す', function () {
  var ctx = setup({ properties: Object.assign({}, ON, { FEEDBACK_INVITE_MODE: 'off' }) });
  var id = seed(ctx);
  ctx.sandbox.PropertiesService.getScriptProperties().setProperty('FEEDBACK_INVITE_MANUAL_BOOKING_ID', id);
  var realNow = Date;
  /* 実行時刻は new Date()。終了が十分過去になるよう、予約側を過去へ寄せる */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(id, { startAt: new Date(realNow.now() - 6 * HOUR), endAt: new Date(realNow.now() - 3 * HOUR) });
  var result = plain(ctx.sandbox.sendFeedbackInviteFromProperty());
  assert.deepStrictEqual(result, { outcome: 'SENT' });
  var props = ctx.sandbox.PropertiesService.getScriptProperties();
  assert.strictEqual(props.getProperty('FEEDBACK_INVITE_MANUAL_BOOKING_ID'), null);
  assert.strictEqual(props.getProperty('FEEDBACK_INVITE_MANUAL_CONFIRM_NOT_DELIVERED'), null);
  props.setProperty('FEEDBACK_INVITE_MANUAL_BOOKING_ID', id);
  var state = plain(ctx.sandbox.getFeedbackInviteStateFromProperty());
  assert.strictEqual(state.state, 'SENT');
  assert.ok(!('email' in state) && JSON.stringify(state).indexOf('@') === -1, '状態に個人情報を含めない');
});

// ============================================================================
// シート・トリガー
// ============================================================================

test('FeedbackInvites: setup は冪等。見出しが違うシートには書かない。列に個人情報・トークンを持たない', function () {
  var ctx = setup();
  assert.strictEqual(ctx.sandbox.setupFeedbackInvites(), 'FEEDBACK_INVITES_ALREADY_READY');
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.HEADERS), ['bookingId', 'brand', 'state', 'endAt', 'expiresAt', 'claimedAt', 'sentAt', 'errorCode', 'updatedAt']);
  seed(ctx);
  ctx.sandbox.sendFeedbackInvites(AFTER_2H);
  var token = tokenFromMail(ctx.mails[0]).token;
  var flat = JSON.stringify(ctx.sheets.FeedbackInvites._rows);
  assert.ok(flat.indexOf('@') === -1 && flat.indexOf(token) === -1 && flat.indexOf('山田') === -1);

  var bad = setup({ setupSheet: false });
  bad.sheets.FeedbackInvites = stubs.createSheetStub('FeedbackInvites');
  bad.sheets.FeedbackInvites.appendRow(['bookingId', 'email']);
  assert.throws(function () { bad.sandbox.setupFeedbackInvites(); }, /SCHEMA_MISMATCH/);
  seed(bad);
  assert.strictEqual(plain(bad.sandbox.sendFeedbackInvites(AFTER_2H)).status, 'CONFIG_INCOMPLETE');
  assert.strictEqual(bad.mails.length, 0);
});

test('トリガー: createFeedbackInviteTrigger は15分おきの送信と毎日4時台の180日削除を1本ずつ作る（重複作成しない）', function () {
  var ctx = setup();
  ctx.sandbox.createFeedbackInvitePurgeTrigger();
  ctx.sandbox.createFeedbackInviteTrigger();
  ctx.sandbox.createFeedbackInviteTrigger();
  var triggers = ctx.sandbox.ScriptApp.getProjectTriggers();
  assert.deepStrictEqual(triggers.map(function (t) { return t.getHandlerFunction(); }), ['purgeExpiredFeedbackInvites', 'sendFeedbackInvites']);
  assert.deepStrictEqual(plain(triggers[0]._spec), { everyDays: 1, atHour: 4 });
  assert.deepStrictEqual(plain(triggers[1]._spec), { everyMinutes: 15 });
});

// ============================================================================
// 送信履歴の180日削除（オーナーレビュー P2）
// ============================================================================

var DAY = 24 * HOUR;

function addInviteRow(ctx, bookingId, state, endAt, extra) {
  var e = extra || {};
  ctx.sheets.FeedbackInvites.appendRow([bookingId, 'snb', state, endAt, e.expiresAt || new Date(new Date(endAt).getTime() + 14 * DAY),
    e.claimedAt === undefined ? endAt : e.claimedAt, e.sentAt === undefined ? '' : e.sentAt, e.errorCode || '', e.updatedAt === undefined ? endAt : e.updatedAt]);
}

test('180日削除: 起算点（endAt・claimedAt・sentAt・updatedAt の最も遅い日時）から180日以上の行だけを削除し、予約台帳は変えない', function () {
  var ctx = setup();
  seed(ctx);
  var now = new Date('2027-07-01T00:00:00+09:00');
  var old = new Date(now.getTime() - 181 * DAY);
  addInviteRow(ctx, 'OLD-SENT', 'SENT', old, { sentAt: new Date(old.getTime() + 2 * HOUR) });
  addInviteRow(ctx, 'EXACT-180', 'SENT', new Date(now.getTime() - 180 * DAY), { claimedAt: '', updatedAt: '' });
  addInviteRow(ctx, 'RECENT', 'SENT', new Date(now.getTime() - 30 * DAY));
  addInviteRow(ctx, 'OLD-END-LATE-UPDATE', 'FAILED', old, { updatedAt: new Date(now.getTime() - 10 * DAY) });
  addInviteRow(ctx, 'OLD-SENDING', 'SENDING', old);
  addInviteRow(ctx, 'UNREADABLE', 'SENT', 'not-a-date');
  var before = bookingsSnapshot(ctx);
  var result = plain(ctx.sandbox.purgeExpiredFeedbackInvites(now));
  assert.deepStrictEqual(result, { status: 'OK', dryRun: false, scanned: 6, expired: 3, deleted: 3, retained: 2, undecidable: 1, truncated: false });
  assert.deepStrictEqual(invites(ctx).map(function (r) { return r.bookingId; }), ['RECENT', 'OLD-END-LATE-UPDATE', 'UNREADABLE']);
  assert.strictEqual(bookingsSnapshot(ctx), before);
  assert.strictEqual(ctx.sheets.FeedbackInvites._rows[0].join(','), plain(ctx.sandbox.FeedbackInvites.HEADERS).join(','), '見出し行は残す');
  var log = ctx.logs.join('\n');
  assert.ok(log.indexOf('OLD-SENT') === -1 && log.indexOf('RECENT') === -1, 'ログに予約IDを出さない');
});

test('180日削除: dry-run は件数だけで削除しない。モードがOFFでも削除は動く', function () {
  var props = Object.assign({}, ON);
  delete props.FEEDBACK_INVITE_MODE;
  var ctx = setup({ properties: props });
  var now = new Date('2027-07-01T00:00:00+09:00');
  addInviteRow(ctx, 'OLD', 'SENT', new Date(now.getTime() - 200 * DAY));
  addInviteRow(ctx, 'NEW', 'SENT', new Date(now.getTime() - 1 * DAY));
  var dry = plain(ctx.sandbox.dryRunFeedbackInvitePurge(now));
  assert.strictEqual(dry.dryRun, true);
  assert.strictEqual(dry.expired, 1);
  assert.strictEqual(dry.deleted, 0);
  assert.strictEqual(invites(ctx).length, 2);
  assert.strictEqual(plain(ctx.sandbox.purgeExpiredFeedbackInvites(now)).deleted, 1);
  assert.deepStrictEqual(invites(ctx).map(function (r) { return r.bookingId; }), ['NEW']);
});

test('180日削除: 履歴を消した後も、その予約へ自動・手動とも再送しない（リンク期限切れ・開始日時・48時間窓）', function () {
  var ctx = setup();
  var id = seed(ctx);
  ctx.sandbox.sendFeedbackInvites(AFTER_2H);
  assert.strictEqual(ctx.mails.length, 1);
  var later = new Date(AFTER_2H.getTime() + 181 * DAY);
  assert.strictEqual(plain(ctx.sandbox.purgeExpiredFeedbackInvites(later)).deleted, 1);
  assert.strictEqual(invites(ctx).length, 0);
  var summary = plain(ctx.sandbox.sendFeedbackInvites(later));
  assert.deepStrictEqual(summary.reasons, { LINK_EXPIRED: 1 });
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(id, { now: later, confirmNotDelivered: true })), { outcome: 'SKIPPED', reason: 'LINK_EXPIRED' });
  assert.strictEqual(ctx.mails.length, 1, '再送しない');
  /* START_AT を後から動かしても、終了から14日を過ぎた予約はリンク期限で止まる */
  var moved = setup({ properties: Object.assign({}, ON, { FEEDBACK_INVITE_START_AT: '2020-01-01T00:00:00Z' }) });
  seed(moved);
  assert.deepStrictEqual(plain(moved.sandbox.sendFeedbackInvites(new Date(END.getTime() + 15 * DAY))).reasons, { LINK_EXPIRED: 1 });
  assert.strictEqual(moved.mails.length, 0);
});

test('180日削除: 送信と同じロックを使う（送信中は削除しない・削除中は送らない）。削除で行がずれても、後の更新は正しい行に入る', function () {
  var busy = setup({ lockFails: true });
  addInviteRow(busy, 'OLD', 'SENT', new Date(AFTER_2H.getTime() - 300 * DAY));
  assert.throws(function () { busy.sandbox.purgeExpiredFeedbackInvites(AFTER_2H); }, /LOCK_TIMEOUT/);
  assert.strictEqual(invites(busy).length, 1, 'ロックを取れなければ何も消さない');

  var ctx = setup({ mailError: new Error('temporary') });
  addInviteRow(ctx, 'OLD-1', 'SENT', new Date(AFTER_2H.getTime() - 300 * DAY));
  addInviteRow(ctx, 'OLD-2', 'SENT', new Date(AFTER_2H.getTime() - 200 * DAY));
  var id = seed(ctx);
  ctx.sandbox.sendFeedbackInvites(AFTER_2H);
  assert.deepStrictEqual(invites(ctx).map(function (r) { return [r.bookingId, r.state]; }), [['OLD-1', 'SENT'], ['OLD-2', 'SENT'], [id, 'FAILED']]);
  ctx.sandbox.purgeExpiredFeedbackInvites(AFTER_2H);
  assert.deepStrictEqual(invites(ctx).map(function (r) { return r.bookingId; }), [id]);
  ctx.sandbox.MailApp = stubs.createMailAppStub();
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(id, { now: AFTER_2H, confirmNotDelivered: true })), { outcome: 'SENT' });
  assert.deepStrictEqual(invites(ctx).map(function (r) { return [r.bookingId, r.state]; }), [[id, 'SENT']]);
});

test('180日削除: シート未作成は何もしない。見出しが違うシートは削除せず失敗として記録する', function () {
  var none = setup({ setupSheet: false });
  assert.strictEqual(plain(none.sandbox.purgeExpiredFeedbackInvites(AFTER_2H)).status, 'FEEDBACK_INVITES_NOT_INITIALIZED');
  var bad = setup({ setupSheet: false });
  bad.sheets.FeedbackInvites = stubs.createSheetStub('FeedbackInvites');
  bad.sheets.FeedbackInvites.appendRow(['bookingId', 'email']);
  bad.sheets.FeedbackInvites.appendRow(['X', 'x@example.com']);
  assert.throws(function () { bad.sandbox.purgeExpiredFeedbackInvites(AFTER_2H); }, /SCHEMA_MISMATCH/);
  assert.strictEqual(bad.sheets.FeedbackInvites._rows.length, 2);
});

// ============================================================================
// Issue #834 追加改善（2026-11-10）: HTML＋プレーンテキストのマルチパート
// ============================================================================

function htmlText(html) {
  return String(html).replace(/<[^>]*>/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function hrefsOf(html) {
  var out = [];
  var re = /<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  var m;
  while ((m = re.exec(html))) out.push({ href: m[1].replace(/&amp;/g, '&'), text: m[2] });
  return out;
}

test('#834 HTML: 3ブランドとも「アンケートに回答する」のリンク文言で、ブランド別フォームのトークン付きURLへ飛ぶ。長いURLは表示しない', function () {
  var ctx = setup();
  var forms = { snb: 'snb', mens: 'mens', studio_x: 'studio-x' };
  var sources = { snb: 'snb-booking-app', mens: 'mens-booking-app', studio_x: 'studio-x-booking-app' };
  Object.keys(forms).forEach(function (brand) { seed(ctx, { brand: brand, source: sources[brand], email: brand + '@example.com' }); });
  ctx.sandbox.sendFeedbackInvites(AFTER_2H);
  assert.strictEqual(ctx.mails.length, 3);
  Object.keys(forms).forEach(function (brand) {
    var mail = ctx.mails.filter(function (m) { return m.to === brand + '@example.com'; })[0];
    assert.ok(typeof mail.htmlBody === 'string' && mail.htmlBody.length > 0, brand + ': htmlBody を送る');
    var textLink = tokenFromMail(mail);
    var fullUrl = 'https://nagoya-base.github.io/Studio-nagoya-base/feedback/' + forms[brand] + '/#t=' + textLink.token;
    assert.ok(mail.body.indexOf(fullUrl) !== -1, brand + ': テキスト本文には完全なURLを維持');
    var links = hrefsOf(mail.htmlBody);
    assert.strictEqual(links.length, 1, brand + ': HTMLのリンクは回答リンク1つだけ');
    assert.strictEqual(links[0].text, 'アンケートに回答する');
    assert.strictEqual(links[0].href, fullUrl, brand + ': テキスト本文と同じトークン付きURL（短縮・リダイレクトなし）');
    var checked = TokenCore.check(textLink.token, forms[brand], AFTER_2H.getTime(), SECRET, hmacHex);
    assert.strictEqual(checked.ok, true);
    assert.strictEqual(TokenCore.check(textLink.token, brand === 'snb' ? 'mens' : 'snb', AFTER_2H.getTime(), SECRET, hmacHex).ok, false, 'ブランド違いは不一致のまま');
    var visible = htmlText(mail.htmlBody);
    assert.ok(visible.indexOf('#t=') === -1 && visible.indexOf(textLink.token) === -1, brand + ': HTMLの表示テキストにトークン付きURLを出さない');
    assert.ok(!/\/survey\//.test(mail.htmlBody), brand + ': 旧surveyへ飛ばない');
    /* 案内情報の欠落なし */
    ['任意', '約2〜3分', '影響することはありません', 'お名前やメールアドレスの入力は不要', '14日間有効', '専用リンク', '回答は1回まで', 'お問い合わせ: contact@example.com'].forEach(function (word) {
      assert.ok(visible.indexOf(word) !== -1, brand + ' html: ' + word);
    });
    /* プレビュー（HTMLの表示テキスト冒頭）・本文に予約情報を出さない */
    var preview = visible.replace(/\s+/g, ' ').trim().slice(0, 120);
    ['緊縛', '山田', '2026', '12/5', '090-', 'taro@'].forEach(function (w) { assert.ok(preview.indexOf(w) === -1, brand + ' html preview: ' + w); });
    ['緊縛', '山田', '090-'].forEach(function (w) { assert.ok(mail.htmlBody.indexOf(w) === -1, brand + ' html: ' + w); });
    /* 外部画像・トラッキングピクセル・外部CSS・スクリプトなし */
    assert.ok(!/<img|<link|<script|<iframe|<style|\bsrc=|url\(|@import/i.test(mail.htmlBody), brand + ': 外部リソースを読み込まない');
  });
  var studioX = ctx.mails.filter(function (m) { return m.to === 'studio_x@example.com'; })[0];
  assert.ok(!/SNB|Nagoya Base|緊縛/.test(htmlText(studioX.htmlBody)), 'Studio XのHTMLにSNBの表現を含めない');
});

test('#834 HTML: 差し込む値はHTMLエスケープし、https 以外のURLはリンクにしない', function () {
  var ctx = setup();
  var fi = ctx.sandbox.FeedbackInvites;
  assert.strictEqual(fi.escapeHtml('<a href="x">\'&'), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  var record = { brand: 'snb' };
  var evil = fi.buildMail(record, 'https://nagoya-base.github.io/Studio-nagoya-base/feedback/snb/#t=abc', { contactEmail: '"><script>alert(1)</script>@example.com' });
  assert.ok(evil.htmlBody.indexOf('<script') === -1, '問い合わせ先をエスケープ');
  assert.ok(evil.htmlBody.indexOf('&quot;&gt;&lt;script&gt;') !== -1);
  ['javascript:alert(1)', 'https://example.com/" onclick="x', 'http://example.com/', ''].forEach(function (bad) {
    var mail = fi.buildMail(record, bad, { contactEmail: 'contact@example.com' });
    assert.strictEqual(hrefsOf(mail.htmlBody).length, 0, '不正なURLはhrefにしない: ' + bad);
    assert.ok(!/onclick=|javascript:/i.test(mail.htmlBody));
  });
  var amp = fi.buildMail(record, 'https://example.com/a?x=1&y=2', { contactEmail: 'c@example.com' });
  assert.ok(amp.htmlBody.indexOf('href="https://example.com/a?x=1&amp;y=2"') !== -1, '属性値の & をエスケープ');
});

test('#834 HTML: 手動送信（sendManually）もHTML＋テキストで送る。送信失敗時の扱いは従来どおり', function () {
  var ctx = setup({ properties: Object.assign({}, ON, { FEEDBACK_INVITE_MODE: 'off' }) });
  var id = seed(ctx);
  assert.deepStrictEqual(plain(ctx.sandbox.FeedbackInvites.sendManually(id, { now: AFTER_2H })), { outcome: 'SENT' });
  assert.strictEqual(ctx.mails.length, 1);
  assert.strictEqual(hrefsOf(ctx.mails[0].htmlBody)[0].text, 'アンケートに回答する');
  assert.ok(tokenFromMail(ctx.mails[0]));

  var failing = setup({ mailError: new Error('boom') });
  var fid = seed(failing);
  var before = bookingsSnapshot(failing);
  failing.sandbox.sendFeedbackInvites(AFTER_2H);
  assert.deepStrictEqual(invites(failing).map(function (r) { return [r.bookingId, r.state, r.errorCode]; }), [[fid, 'FAILED', 'MAIL_SEND_FAILED']]);
  assert.strictEqual(bookingsSnapshot(failing), before, 'メール失敗時も予約台帳は変えない');
});
