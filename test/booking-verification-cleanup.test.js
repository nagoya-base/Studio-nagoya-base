/*
 * 期限切れOTP・会員確認証明の定期削除（Issue #557）のテスト。Sheets・Lock・Mailはすべてスタブで、本番へは一切アクセスしない。
 *
 * - 削除対象: BookingMemberVerificationsの期限切れ（保持猶予24h経過）のotp/proofだけ。境界時刻・有効行・他kind/purpose・不正日付・他シートは保持
 * - 安全策: ロック競合、ヘッダー不整合、大量データの打ち切りと再実行、途中失敗と再実行、読み直し再判定
 * - ログ: 件数などの非機密メタデータのみ
 * - 既存機能: 清掃後もrequestCode/verifyCode/checkProof/createBookingが従来どおり動く
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var proofHelper = require('./helpers/booking-member-proof');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs',
  'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'EquipmentCatalog.gs',
  'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs',
  'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs', 'BookingMailTemplates.gs',
  'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs', 'BookingRepository.gs', 'AdminNotifier.gs',
  'BookingAdminAlerts.gs', 'MembershipService.gs', 'BookingMemberVerification.gs', 'BookingVerificationCleanup.gs', 'Code.gs'
];

var SHEET = 'BookingMemberVerifications';
var HEADERS = ['kind', 'secretHash', 'email', 'purpose', 'expiresAt', 'usedAt', 'attempts', 'createdAt'];
var HOUR = 3600000;
var NOW = new Date('2026-12-10T12:00:00+09:00');
var MEMBER = 'member@example.com';
var GRACE = 24 * HOUR;

function plain(v) { return JSON.parse(JSON.stringify(v)); }
function ago(ms) { return new Date(NOW.getTime() - ms); }

function setup(opts) {
  var o = opts || {};
  var spreadsheetsById = { ss1: {} };
  var properties = {
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1', BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
    BOOKING_CONTACT_EMAIL: 'contact@example.com', ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000', MEMBERSHIP_STATUS_URL: 'https://example.com/membership/status/'
  };
  var mailApp = stubs.createMailAppStub();
  var logger = stubs.createLoggerStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(o.lock),
    CacheService: stubs.createCacheServiceStub(), SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp, UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripeは呼ばない'); }),
    Logger: logger, ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, mailApp: mailApp, logger: logger, sheets: spreadsheetsById.ss1, lock: globals.LockService };
}

/* 認証台帳シートを作り、rows（[kind, hash, email, purpose, expiresAt]の配列）を直接積む。 */
function seed(ctx, rows, headers) {
  var sheet = ctx.sandbox.SpreadsheetApp.openById('ss1').insertSheet(SHEET);
  sheet.appendRow(headers || HEADERS);
  rows.forEach(function (r) {
    sheet.appendRow([r[0], r[1], r[2] || 'x@example.com', r[3] === undefined ? 'booking_membership' : r[3], r[4], '', 0, ago(100 * HOUR)]);
  });
  return sheet;
}

function expired(kind, hash) { return [kind, hash, 'x@example.com', 'booking_membership', ago(GRACE + HOUR)]; }
function valid(kind, hash) { return [kind, hash, 'x@example.com', 'booking_membership', new Date(NOW.getTime() + HOUR)]; }
function hashes(sheet) { return sheet._rows.slice(1).map(function (r) { return r[1]; }); }
function purge(ctx, options) { return plain(ctx.sandbox.cleanupExpiredBookingVerifications(NOW, options)); }

// ============================================================================
// 削除対象の判定
// ============================================================================

test('期限切れのotp/proofだけが削除され、有効行・他kind/purpose・不正日付・空欄は保持される', function () {
  var ctx = setup();
  var sheet = seed(ctx, [
    expired('otp', 'e-otp'), expired('proof', 'e-proof'),
    valid('otp', 'v-otp'), valid('proof', 'v-proof'),
    ['other', 'k-other', 'x@example.com', 'booking_membership', ago(GRACE + HOUR)],
    ['otp', 'p-other', 'x@example.com', 'membership_status', ago(GRACE + HOUR)],
    ['otp', 'bad-date', 'x@example.com', 'booking_membership', 'not-a-date'],
    ['proof', 'str-date', 'x@example.com', 'booking_membership', '2020-01-01'],
    ['proof', 'blank', 'x@example.com', 'booking_membership', ''],
    ['', 'blank-kind', 'x@example.com', 'booking_membership', ago(GRACE + HOUR)]
  ]);
  var result = purge(ctx);
  assert.strictEqual(result.status, 'OK');
  assert.strictEqual(result.deleted, 2);
  assert.deepStrictEqual(hashes(sheet), ['v-otp', 'v-proof', 'k-other', 'p-other', 'bad-date', 'str-date', 'blank', 'blank-kind']);
  assert.deepStrictEqual(sheet._rows[0], HEADERS, 'ヘッダー行は消えない');
  assert.strictEqual(result.skippedUndecidable, 6);
  assert.strictEqual(result.retained, 2);
});

test('境界時刻: 期限切れから保持猶予ちょうどで削除、1ms手前は保持。期限切れ直後・期限ちょうどは保持', function () {
  var ctx = setup();
  var sheet = seed(ctx, [
    ['otp', 'at-grace', 'x@example.com', 'booking_membership', ago(GRACE)],
    ['otp', 'just-inside', 'x@example.com', 'booking_membership', ago(GRACE - 1)],
    ['proof', 'just-expired', 'x@example.com', 'booking_membership', ago(1)],
    ['proof', 'expires-now', 'x@example.com', 'booking_membership', NOW],
    ['proof', 'future', 'x@example.com', 'booking_membership', new Date(NOW.getTime() + 1)]
  ]);
  purge(ctx);
  assert.deepStrictEqual(hashes(sheet), ['just-inside', 'just-expired', 'expires-now', 'future']);
});

test('連続する期限切れ行・先頭/末尾/散在のいずれも行番号ずれなく削除される', function () {
  var ctx = setup();
  var sheet = seed(ctx, [
    expired('otp', 'a1'), expired('otp', 'a2'), expired('proof', 'a3'),
    valid('otp', 'k1'),
    expired('otp', 'b1'),
    valid('proof', 'k2'), valid('proof', 'k3'),
    expired('proof', 'c1'), expired('proof', 'c2')
  ]);
  var result = purge(ctx);
  assert.strictEqual(result.deleted, 6);
  assert.deepStrictEqual(hashes(sheet), ['k1', 'k2', 'k3']);
});

test('0件（対象なし・ヘッダーのみ・シート無し）は何も削除せず正常終了。シートも作らない', function () {
  var ctx = setup();
  assert.strictEqual(purge(ctx).deleted, 0);
  assert.strictEqual(ctx.sheets[SHEET], undefined, '台帳が無くても新規作成しない');
  var sheet = seed(ctx, []);
  assert.strictEqual(purge(ctx).deleted, 0);
  sheet.appendRow(valid('otp', 'k').concat(['', 0, NOW]));
  assert.strictEqual(purge(ctx).deleted, 0);
  assert.strictEqual(sheet._rows.length, 2);
});

test('他シートの行は期限切れ風でも一切変更されない', function () {
  var ctx = setup();
  seed(ctx, [expired('otp', 'e')]);
  var tokens = ctx.sandbox.SpreadsheetApp.openById('ss1').insertSheet('MemberStatusTokens');
  tokens.appendRow(['tokenHash', 'email', 'expiresAt', 'usedAt', 'createdAt']);
  tokens.appendRow(['t', 'x@example.com', ago(100 * HOUR), '', ago(200 * HOUR)]);
  var members = ctx.sandbox.SpreadsheetApp.openById('ss1').insertSheet('Members');
  members.appendRow(['memberId']);
  members.appendRow(['m1']);
  var tokenBefore = JSON.stringify(tokens._rows);
  var memberBefore = JSON.stringify(members._rows);
  purge(ctx);
  assert.strictEqual(JSON.stringify(tokens._rows), tokenBefore);
  assert.strictEqual(JSON.stringify(members._rows), memberBefore);
});

test('ヘッダーが想定と異なる場合は何も削除せずエラー', function () {
  var ctx = setup();
  var broken = HEADERS.slice(); broken[4] = 'expires';
  var sheet = seed(ctx, [expired('otp', 'e')], broken);
  assert.throws(function () { ctx.sandbox.cleanupExpiredBookingVerifications(NOW); });
  assert.strictEqual(sheet._rows.length, 2);
  assert.ok(ctx.logger._logs.some(function (l) { return /ERROR/.test(l); }));
});

// ============================================================================
// 排他・大量データ・途中失敗・再実行
// ============================================================================

test('ロック取得失敗時は削除せず、LOCK_TIMEOUTを記録して終了する', function () {
  var ctx = setup({ lock: { forceTryLockFail: true } });
  var sheet = seed(ctx, [expired('otp', 'e')]);
  var result = purge(ctx);
  assert.strictEqual(result.status, 'LOCK_TIMEOUT');
  assert.strictEqual(sheet._rows.length, 2);
  assert.ok(ctx.logger._logs.some(function (l) { return /LOCK_TIMEOUT/.test(l); }));
});

test('他の処理がロック保持中は削除せず、実行後にロックを解放している', function () {
  var ctx = setup();
  var sheet = seed(ctx, [expired('otp', 'e')]);
  var other = ctx.sandbox.LockService.getScriptLock();
  assert.strictEqual(other.tryLock(1), true);
  assert.strictEqual(purge(ctx).status, 'LOCK_TIMEOUT');
  assert.strictEqual(sheet._rows.length, 2);
  other.releaseLock();
  assert.strictEqual(purge(ctx).deleted, 1);
  assert.strictEqual(ctx.lock._isHeld(), false, '実行後はロックを解放する');
});

test('数千件規模: 上限で打ち切りTRUNCATED、再実行を重ねると収束し有効行は全て残る（冪等）', function () {
  var ctx = setup();
  var rows = [];
  for (var i = 0; i < 5000; i++) rows.push(i % 7 === 0 ? valid('proof', 'v' + i) : expired(i % 2 ? 'otp' : 'proof', 'e' + i));
  var sheet = seed(ctx, rows);
  var validCount = rows.filter(function (r) { return r[1].charAt(0) === 'v'; }).length;
  var first = purge(ctx);
  assert.strictEqual(first.status, 'TRUNCATED');
  assert.strictEqual(first.deleted, 2000);
  var runs = 1;
  var last = first;
  while (last.status === 'TRUNCATED' && runs < 10) { last = purge(ctx); runs++; }
  assert.strictEqual(last.status, 'OK');
  assert.strictEqual(runs, 3);
  assert.strictEqual(sheet._rows.length - 1, validCount);
  assert.ok(hashes(sheet).every(function (h) { return h.charAt(0) === 'v'; }));
  assert.strictEqual(purge(ctx).deleted, 0, '収束後の再実行は何も消さない');
});

test('時間予算を超えたらTRUNCATEDで安全に打ち切り、再実行で残りを削除する', function () {
  var ctx = setup();
  var rows = [];
  for (var i = 0; i < 10; i++) { rows.push(expired('otp', 'e' + i)); rows.push(valid('otp', 'v' + i)); }
  var sheet = seed(ctx, rows);
  var tick = 0;
  var result = purge(ctx, { timeBudgetMs: 2, clock: function () { return tick++; } });
  assert.strictEqual(result.status, 'TRUNCATED');
  assert.ok(result.deleted > 0 && result.deleted < 10);
  assert.strictEqual(purge(ctx).status, 'OK');
  assert.strictEqual(sheet._rows.length - 1, 10);
});

test('途中失敗: PARTIAL_FAILUREで終了し、削除済みは戻らず未削除分は再実行で消える。有効行は無傷', function () {
  var ctx = setup();
  var sheet = seed(ctx, [
    expired('otp', 'a'), valid('otp', 'k1'), expired('otp', 'b'), valid('otp', 'k2'), expired('otp', 'c')
  ]);
  var calls = 0;
  sheet._hooks.beforeDeleteRows = function () { calls++; if (calls === 2) throw new Error('Service error'); };
  assert.throws(function () { ctx.sandbox.cleanupExpiredBookingVerifications(NOW); });
  assert.ok(ctx.logger._logs.some(function (l) { return /PARTIAL_FAILURE/.test(l); }));
  assert.deepStrictEqual(hashes(sheet), ['a', 'k1', 'b', 'k2'], '下のブロックから削除され、失敗時点で止まる');
  sheet._hooks.beforeDeleteRows = null;
  var rerun = purge(ctx);
  assert.strictEqual(rerun.status, 'OK');
  assert.deepStrictEqual(hashes(sheet), ['k1', 'k2']);
  assert.strictEqual(purge(ctx).deleted, 0);
  assert.strictEqual(ctx.lock._isHeld(), false, '失敗時もロックを解放する');
});

test('削除直前に行が変わっていた（有効行になった/ずれた）ブロックは削除しない', function () {
  var ctx = setup();
  var sheet = seed(ctx, [expired('otp', 'a'), expired('otp', 'b')]);
  var original = sheet.getRange.bind(sheet);
  sheet.getRange = function (row, col, numRows, numCols) {
    var range = original(row, col, numRows, numCols);
    var getValues = range.getValues;
    range.getValues = function () {
      /* 読み直しの直前に、人手で期限が延長された状況を再現する。 */
      sheet._rows[1][4] = new Date(NOW.getTime() + HOUR);
      return getValues.call(range);
    };
    return range;
  };
  var result = purge(ctx);
  assert.strictEqual(result.deleted, 0);
  assert.strictEqual(sheet._rows.length, 3);
});

test('ログは件数などの非機密メタデータのみ（メール・ハッシュ・行内容を含まない）', function () {
  var ctx = setup();
  seed(ctx, [
    ['otp', 'SECRETHASH123', 'private.person@example.com', 'booking_membership', ago(GRACE + HOUR)],
    ['proof', 'ANOTHERHASH456', 'private.person@example.com', 'booking_membership', new Date(NOW.getTime() + HOUR)]
  ]);
  purge(ctx);
  var text = ctx.logger._logs.join('\n');
  assert.ok(/"deleted":1/.test(text) && /"retained":1/.test(text));
  ['SECRETHASH123', 'ANOTHERHASH456', 'private.person', 'example.com', 'booking_membership'].forEach(function (s) {
    assert.strictEqual(text.indexOf(s), -1, 'ログに ' + s + ' を含めない');
  });
});

// ============================================================================
// 既存機能への影響なし
// ============================================================================

test('清掃後も確認コード送信・検証・証明検査が従来どおり動く。期限切れ証明は引き続き拒否される', function () {
  var ctx = setup();
  var t0 = new Date('2026-12-05T12:00:00+09:00');
  var issued = proofHelper.issueProof(ctx.sandbox, ctx.mailApp, MEMBER, t0);
  var pending = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, 'other@example.com', t0);
  assert.strictEqual(pending.result.success, true);

  /* 発行から1時間+猶予24h以上後: 古い証明は期限切れ（削除前後とも利用不可）。 */
  var later = new Date(t0.getTime() + 30 * HOUR);
  assert.strictEqual(plain(ctx.sandbox.BookingMemberVerification.checkProof(MEMBER, issued, later)).ok, false);
  var result = plain(ctx.sandbox.cleanupExpiredBookingVerifications(later));
  assert.strictEqual(result.deleted, 3, "MEMBERのOTPと証明、別メールのOTP");
  var after = plain(ctx.sandbox.BookingMemberVerification.checkProof(MEMBER, issued, later));
  assert.strictEqual(after.ok, false);
  assert.ok(after.reason === 'EXPIRED' || after.reason === 'INVALID');

  /* 清掃後に新規発行→検証→証明検査が通る。 */
  var fresh = proofHelper.issueProof(ctx.sandbox, ctx.mailApp, MEMBER, later);
  assert.strictEqual(plain(ctx.sandbox.BookingMemberVerification.checkProof(MEMBER, fresh, later)).ok, true);
});

test('有効期限内のOTP・証明は清掃で削除されず、清掃後も検証・利用できる', function () {
  var ctx = setup();
  var t0 = new Date('2026-12-05T12:00:00+09:00');
  var issued = proofHelper.issueProof(ctx.sandbox, ctx.mailApp, MEMBER, t0);
  var requested = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, 'new@example.com', t0);
  var soon = new Date(t0.getTime() + 10 * 60000);
  assert.strictEqual(plain(ctx.sandbox.cleanupExpiredBookingVerifications(soon)).deleted, 0);
  assert.strictEqual(plain(ctx.sandbox.BookingMemberVerification.checkProof(MEMBER, issued, soon)).ok, true);
  var verified = proofHelper.verify(ctx.sandbox, 'new@example.com', requested.code, soon);
  assert.strictEqual(verified.success, true);
});

test('清掃後の期限切れOTPの検証は従来どおり失敗し、createBookingも有効な証明で成立する', function () {
  var ctx = setup();
  var t0 = new Date('2026-12-05T12:00:00+09:00');
  var req = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, t0);
  var later = new Date(t0.getTime() + 30 * HOUR);
  ctx.sandbox.cleanupExpiredBookingVerifications(later);
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, req.code, later).success, false);

  var issued = proofHelper.issueProof(ctx.sandbox, ctx.mailApp, MEMBER, later);
  ctx.sandbox.cleanupExpiredBookingVerifications(new Date(later.getTime() + 60000));
  var booking = plain(ctx.sandbox.BookingRepository.createBooking({
    brand: 'snb', customerType: 'returning', date: '2026-12-31', startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: MEMBER, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', memberProof: issued
  }, new Date(later.getTime() + 120000)));
  assert.strictEqual(booking.success, true, JSON.stringify(booking));
});

test('配布: 清掃ファイルはBooking Web Appだけに含まれ、AdminとWebhookには含まれない', function () {
  var manifest = require('./helpers/booking-deployment-manifest');
  assert.ok(manifest.BOOKING_WEB_APP_FILES.indexOf('BookingVerificationCleanup.gs') !== -1);
  assert.strictEqual(manifest.BOOKING_ADMIN_FILES.indexOf('BookingVerificationCleanup.gs'), -1);
  assert.strictEqual(manifest.BOOKING_WEBHOOK_FILES.indexOf('BookingVerificationCleanup.gs'), -1);
  assert.ok(manifest.BOOKING_WEB_APP_FILES.indexOf('MemberRepository.gs') < manifest.BOOKING_WEB_APP_FILES.indexOf('BookingVerificationCleanup.gs'));
});
