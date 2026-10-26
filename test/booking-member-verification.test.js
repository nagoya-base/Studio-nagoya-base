/*
 * V2予約の会員確認（Issue #548）のテスト。Stripe・Sheets・Calendar・MailAppはすべてスタブで、本番へは一切アクセスしない。
 *
 * - 6桁OTP: 会員・非会員で同一の処理/応答、平文保存なし、60分、1回利用、試行回数、再送/送信回数制限、MailApp枠の確保
 * - 確認済み証明: メール・用途拘束、60分、改ざん/期限切れ/他メール/他用途は会員情報を返さない
 * - 用途分離: booking_membership と membership_status（会員状態ページ）を相互に通さない
 * - createBooking: V1（従来仕様）とV2（証明必須）の分岐。V1/V2はサーバー時刻の正本で、クライアント指定では切り替わらない
 * - 会員利用中に証明が切れたら黙って一般料金へ降格せず再確認を要求
 *
 * 会員台帳は MemberRepository.isMemberOnDate のスタブ（月単位）で制御する。
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
  'BookingAdminAlerts.gs', 'MembershipService.gs', 'BookingMemberVerification.gs', 'Code.gs'
];

var SPREADSHEET_ID = 'ss1';
var MEMBER = 'member@example.com';
var STRANGER = 'stranger@example.com';
var MINUTE = 60000;

/* V1（〜2026/11/30）とV2（2026/12/1 0:00 JST〜）。 */
var V1_NOW = new Date('2026-11-30T23:59:59+09:00');
var V2_NOW = new Date('2026-12-05T12:00:00+09:00');
/* 2026-12-14=月曜（平日）。V2_NOWから31日以上先（先行予約枠）は2027-01-12（火）。 */
var NEAR_DATE = '2026-12-14';
var ADVANCE_DATE = '2027-01-12';

function plain(v) { return JSON.parse(JSON.stringify(v)); }
function minutes(n) { return n * MINUTE; }
function at(base, offsetMinutes) { return new Date(base.getTime() + minutes(offsetMinutes)); }

/* opts.members: { 'メール': ['YYYY-MM', ...] }。opts.mail: createMailAppStubのオプション。 */
function setup(opts) {
  var o = opts || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = {
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID,
    BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000',
    MEMBERSHIP_STATUS_URL: 'https://example.com/membership/status/'
  };
  var mailApp = stubs.createMailAppStub(o.mail);
  var logger = stubs.createLoggerStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp, UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripeは呼ばない'); }),
    Logger: logger, ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  var ctx = { sandbox: sandbox, mailApp: mailApp, logger: logger, sheets: spreadsheetsById[SPREADSHEET_ID], members: o.members || {}, lookups: [], proofs: {} };
  sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    ctx.lookups.push({ email: email, date: date });
    return (ctx.members[String(email).toLowerCase()] || []).indexOf(String(date).substring(0, 7)) !== -1;
  };
  return ctx;
}

function payload(overrides) {
  return Object.assign({
    brand: 'snb', customerType: 'returning', date: NEAR_DATE, startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: MEMBER, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', isMember: false
  }, overrides || {});
}

function book(ctx, overrides, now) {
  return plain(ctx.sandbox.BookingRepository.createBooking(payload(overrides), now || V2_NOW));
}

function issue(ctx, email, now) {
  return proofHelper.issueProof(ctx.sandbox, ctx.mailApp, email, now || V2_NOW);
}

function record(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

function bookingRows(ctx) {
  return ctx.sheets.Bookings ? ctx.sheets.Bookings._rows.length - 1 : 0;
}

function post(ctx, action, body) {
  var out = ctx.sandbox.doPost({ parameter: { action: action }, postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.text);
}

// ============================================================================
// 確認コードの送信（requestCode）
// ============================================================================

test('確認コード送信: 会員・非会員で同一の応答・同種のメール送信。会員台帳は一切参照しない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var a = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, V2_NOW);
  var b = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, STRANGER, V2_NOW);
  assert.strictEqual(a.result.success, true);
  assert.deepStrictEqual(a.result, b.result, '応答は会員・非会員で同一');
  assert.ok(/^\d{6}$/.test(a.code) && /^\d{6}$/.test(b.code), 'どちらにも6桁コードのメールを送る');
  assert.strictEqual(a.mail.subject, b.mail.subject);
  assert.strictEqual(ctx.lookups.length, 0, '送信要求は会員台帳を参照しない');
  assert.ok(JSON.stringify(a.result).indexOf('会員登録') === -1);
});

test('確認コード送信: 形式不正のメールは送らない。メール本文以外（応答・Logger）にコードを出さない', function () {
  var ctx = setup();
  var bad = plain(ctx.sandbox.BookingMemberVerification.requestCode({ email: 'not-an-email' }, V2_NOW));
  assert.strictEqual(bad.success, false);
  assert.strictEqual(bad.error.code, 'INVALID_EMAIL');
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);

  var sent = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, V2_NOW);
  assert.ok(sent.code);
  assert.strictEqual(JSON.stringify(sent.result).indexOf(sent.code), -1, '応答にコードを含めない');
  assert.strictEqual(JSON.stringify(ctx.logger._messages || []).indexOf(sent.code), -1);
});

test('OTPは平文保存しない（ハッシュのみ・メールと用途に拘束）。有効期限は60分', function () {
  var ctx = setup();
  var sent = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, V2_NOW);
  var rows = ctx.sheets.BookingMemberVerifications._rows;
  assert.deepStrictEqual(plain(rows[0]), ['kind', 'secretHash', 'email', 'purpose', 'expiresAt', 'usedAt', 'attempts', 'createdAt']);
  var row = rows[1];
  assert.strictEqual(row[0], 'otp');
  assert.strictEqual(row[3], 'booking_membership');
  assert.strictEqual(String(row[1]).indexOf(sent.code), -1);
  assert.ok(/^[0-9a-f]{64}$/.test(row[1]), 'HMAC-SHA256の16進');
  assert.strictEqual(new Date(row[4]).getTime() - V2_NOW.getTime(), minutes(60));
  assert.strictEqual(JSON.stringify(rows).indexOf(sent.code + '"'), -1);
});

test('確認コード送信の制限: 再送間隔（1分）・メール単位（60分5通）・全体。制限は会員の有無に依らない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  assert.strictEqual(plain(ctx.sandbox.BookingMemberVerification.requestCode({ email: MEMBER }, V2_NOW)).success, true);
  var resend = plain(ctx.sandbox.BookingMemberVerification.requestCode({ email: MEMBER }, at(V2_NOW, 0)));
  assert.strictEqual(resend.error.code, 'RATE_LIMITED', '1分以内の再送は不可');

  var codes = [];
  for (var i = 1; i <= 6; i++) {
    codes.push(plain(ctx.sandbox.BookingMemberVerification.requestCode({ email: MEMBER }, at(V2_NOW, i * 2))).success);
  }
  assert.deepStrictEqual(codes, [true, true, true, true, false, false], '60分で5通まで');

  /* 非会員のメールでも同じ上限。 */
  var s = setup();
  var results = [];
  for (var j = 0; j < 6; j++) results.push(plain(s.sandbox.BookingMemberVerification.requestCode({ email: STRANGER }, at(V2_NOW, j * 2))).success);
  assert.deepStrictEqual(results, [true, true, true, true, true, false], '非会員のメールにも同じ上限');

  /* 全体: 異なるメールでも60分40通まで。 */
  var g = setup();
  var sentCount = 0;
  for (var k = 0; k < 45; k++) {
    if (plain(g.sandbox.BookingMemberVerification.requestCode({ email: 'u' + k + '@example.com' }, at(V2_NOW, 0))).success) sentCount++;
  }
  assert.strictEqual(sentCount, 40);
});

test('MailAppの日次送信枠を使い切らない: 残りが予約用の確保枠（50通）以下なら確認コードは送らない', function () {
  var low = setup({ mail: { remainingQuota: 50 } });
  var denied = plain(low.sandbox.BookingMemberVerification.requestCode({ email: MEMBER }, V2_NOW));
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, 'VERIFICATION_UNAVAILABLE');
  assert.strictEqual(low.mailApp._sentEmails.length, 0);

  var ok = setup({ mail: { remainingQuota: 51 } });
  assert.strictEqual(plain(ok.sandbox.BookingMemberVerification.requestCode({ email: MEMBER }, V2_NOW)).success, true);

  /* 枠を読めない場合もfail-closed。 */
  var broken = setup();
  broken.sandbox.MailApp.getRemainingDailyQuota = function () { throw new Error('quota'); };
  assert.strictEqual(plain(broken.sandbox.BookingMemberVerification.requestCode({ email: MEMBER }, V2_NOW)).error.code, 'VERIFICATION_UNAVAILABLE');
});

test('メール送信に失敗しても例外を外へ出さず汎用エラー（コードは使えない）', function () {
  var ctx = setup({ mail: { throwError: new Error('mail down') } });
  var r = plain(ctx.sandbox.BookingMemberVerification.requestCode({ email: MEMBER }, V2_NOW));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'VERIFICATION_UNAVAILABLE');
});

// ============================================================================
// 確認コードの検証（verifyCode）
// ============================================================================

test('確認コード検証: 正しいコードで確認済み証明を発行。1回使用したコードは再利用不可', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var sent = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, V2_NOW);
  var ok = proofHelper.verify(ctx.sandbox, MEMBER, sent.code, at(V2_NOW, 5));
  assert.strictEqual(ok.success, true);
  assert.ok(/^[A-Za-z0-9]{32,128}$/.test(ok.proof));
  assert.strictEqual(ok.expiresInMinutes, 60);
  assert.strictEqual(ok.advanceEligible, true, '今日（12月）に会員資格があれば先行予約枠を開放');
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, sent.code, at(V2_NOW, 6)).error.code, 'INVALID_CODE', '再利用不可');

  /* 証明そのものは平文保存しない。 */
  assert.strictEqual(JSON.stringify(ctx.sheets.BookingMemberVerifications._rows).indexOf(ok.proof), -1);
});

test('確認コード検証: 非会員も確認はできるが、先行予約資格はfalse', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var sent = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, STRANGER, V2_NOW);
  var ok = proofHelper.verify(ctx.sandbox, STRANGER, sent.code, V2_NOW);
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.advanceEligible, false);
});

test('確認コード検証: 60分を過ぎたコード・別メールのコード・形式不正は同一エラー', function () {
  var ctx = setup();
  var sent = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, V2_NOW);
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, sent.code, at(V2_NOW, 61)).error.code, 'INVALID_CODE', '61分後は無効');
  assert.strictEqual(proofHelper.verify(ctx.sandbox, STRANGER, sent.code, at(V2_NOW, 1)).error.code, 'INVALID_CODE', '他メールでは通らない');
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, '12345', at(V2_NOW, 1)).error.code, 'INVALID_CODE');
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, 'abcdef', at(V2_NOW, 1)).error.code, 'INVALID_CODE');
  /* 期限内なら通る（上の失敗でコードは消費されていない）。 */
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, sent.code, at(V2_NOW, 59)).success, true);
});

test('確認コード検証: 試行回数の上限（5回）。上限後は正しいコードでも通らず、再送が必要', function () {
  var ctx = setup();
  var sent = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, V2_NOW);
  var wrong = sent.code === '000000' ? '111111' : '000000';
  for (var i = 0; i < 5; i++) {
    assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, wrong, at(V2_NOW, 1 + i)).error.code, 'INVALID_CODE');
  }
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, sent.code, at(V2_NOW, 7)).error.code, 'INVALID_CODE', '上限後は正解でも失効');
  /* 再送した新しいコードは使える。 */
  var again = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, at(V2_NOW, 10));
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, again.code, at(V2_NOW, 11)).success, true);
});

test('再送すると古いコードは使えず、最新のコードだけが有効', function () {
  var ctx = setup();
  var first = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, V2_NOW);
  var second = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, at(V2_NOW, 2));
  if (first.code !== second.code) {
    assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, first.code, at(V2_NOW, 3)).error.code, 'INVALID_CODE');
  }
  assert.strictEqual(proofHelper.verify(ctx.sandbox, MEMBER, second.code, at(V2_NOW, 3)).success, true);
});

// ============================================================================
// 確認済み証明（checkProof）と用途分離
// ============================================================================

test('確認済み証明: 有効・60分で期限切れ・他メール・改ざん・未指定', function () {
  var ctx = setup();
  var V = ctx.sandbox.BookingMemberVerification;
  var proof = issue(ctx, MEMBER);
  assert.deepStrictEqual(plain(V.checkProof(MEMBER, proof, at(V2_NOW, 59))), { ok: true });
  assert.deepStrictEqual(plain(V.checkProof(' MEMBER@Example.com ', proof, at(V2_NOW, 1))), { ok: true }, 'メールは正規化して照合');
  assert.deepStrictEqual(plain(V.checkProof(MEMBER, proof, at(V2_NOW, 61))), { ok: false, reason: 'EXPIRED' });
  assert.deepStrictEqual(plain(V.checkProof(STRANGER, proof, at(V2_NOW, 1))), { ok: false, reason: 'INVALID' }, '他メールには通らない');
  assert.deepStrictEqual(plain(V.checkProof(MEMBER, proof.slice(0, -1) + (proof.slice(-1) === 'a' ? 'b' : 'a'), at(V2_NOW, 1))), { ok: false, reason: 'INVALID' });
  assert.deepStrictEqual(plain(V.checkProof(MEMBER, 'verified', at(V2_NOW, 1))), { ok: false, reason: 'INVALID' });
  assert.deepStrictEqual(plain(V.checkProof(MEMBER, '', at(V2_NOW, 1))), { ok: false, reason: 'MISSING' });
  assert.deepStrictEqual(plain(V.checkProof(MEMBER, undefined, at(V2_NOW, 1))), { ok: false, reason: 'MISSING' });
  assert.deepStrictEqual(plain(V.checkProof(MEMBER, true, at(V2_NOW, 1))), { ok: false, reason: 'MISSING' }, 'verified=true等のクライアント値は証明にならない');
});

test('用途分離: 会員状態ページ（membership_status）のトークンは予約会員確認を通さず、予約用の証明は会員状態ページを通さない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var V = ctx.sandbox.BookingMemberVerification;
  /* 会員状態ページ用の本人確認リンクを発行し、トークンを取り出す。 */
  assert.strictEqual(plain(ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER })).success, true);
  var statusMail = ctx.mailApp._sentEmails[ctx.mailApp._sentEmails.length - 1];
  var statusToken = /#t=([A-Za-z0-9]+)/.exec(statusMail.body)[1];
  assert.deepStrictEqual(plain(V.checkProof(MEMBER, statusToken, V2_NOW)), { ok: false, reason: 'INVALID' });
  var viaBooking = book(ctx, { memberProof: statusToken, date: NEAR_DATE });
  assert.strictEqual(viaBooking.success, false);
  assert.strictEqual(viaBooking.error.code, 'MEMBER_REVERIFY_REQUIRED');

  /* 予約用の確認済み証明・OTPは、会員状態ページに通らない。 */
  var proof = issue(ctx, MEMBER);
  var otp = proofHelper.requestCode(ctx.sandbox, ctx.mailApp, MEMBER, at(V2_NOW, 3));
  assert.strictEqual(plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: proof })).error.code, 'INVALID_TOKEN');
  assert.strictEqual(plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: otp.code + otp.code + otp.code })).error.code, 'INVALID_TOKEN');
  /* 用途の異なる行（purpose不一致）は、トークンが正しくても証明として扱わない。 */
  var repo = ctx.sandbox.MemberRepository;
  var fake = 'Z'.repeat(40);
  repo.addBookingVerification({ kind: 'proof', secretHash: 'x', email: MEMBER, purpose: 'membership_status', expiresAt: at(V2_NOW, 60) }, V2_NOW);
  assert.strictEqual(plain(V.checkProof(MEMBER, fake, V2_NOW)).ok, false);
});

// ============================================================================
// createBooking: V2（確認済み証明が必須）
// ============================================================================

test('V2: 通常予約は確認なしでも一般扱いで進められる（会員メールでも会員料金にならない・台帳を参照しない）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var r = book(ctx, { email: MEMBER, isMember: true });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.price.tier, 'GENERAL');
  assert.strictEqual(r.price.amount, 6000);
  assert.strictEqual(record(ctx, r.bookingId).membershipStatus, 'UNVERIFIED');
  assert.strictEqual(record(ctx, r.bookingId).priceIsMember, false);
  assert.strictEqual(ctx.lookups.length, 0, '未確認は会員台帳を参照しない（メール一致だけで昇格しない）');
});

test('V2: 確認済み証明 + 利用日にactual membership → 会員料金。期間外の利用日は確認済みでも一般料金', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var proof = issue(ctx, MEMBER);
  var member = book(ctx, { memberProof: proof, date: NEAR_DATE });
  assert.strictEqual(member.success, true, JSON.stringify(member));
  assert.strictEqual(member.price.tier, 'MEMBER');
  assert.strictEqual(member.price.amount, 5500);
  assert.strictEqual(record(ctx, member.bookingId).membershipStatus, 'ACTIVE');

  var outside = book(ctx, { memberProof: proof, date: '2027-01-12', startTime: '10:00' }, at(V2_NOW, 1));
  /* 2027-01-12は先行予約枠。今日（12月）は会員なので受け付けるが、利用日（1月）は会員期間外のため一般料金。 */
  assert.strictEqual(outside.success, true, JSON.stringify(outside));
  assert.strictEqual(outside.price.tier, 'GENERAL', '利用日が期間外なら確認済みでも一般料金');
  assert.strictEqual(record(ctx, outside.bookingId).membershipStatus, 'INACTIVE');
});

test('V2: 非会員が確認済みでも会員料金にならない（INACTIVE）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var proof = issue(ctx, STRANGER);
  var r = book(ctx, { email: STRANGER, memberProof: proof });
  assert.strictEqual(r.price.tier, 'GENERAL');
  assert.strictEqual(record(ctx, r.bookingId).membershipStatus, 'INACTIVE');
});

test('V2: クライアントのverified/isMember/世代の指定では会員扱い・V1扱いにならない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var r = book(ctx, {
    isMember: true, verified: true, memberVerified: true, priceGeneration: 'V1', generation: 'V1', membershipStatus: 'ACTIVE',
    memberProof: 'verified'
  });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'MEMBER_REVERIFY_REQUIRED', '証明らしくない値は再確認要求');
  assert.strictEqual(bookingRows(ctx), 0);

  var withoutProof = book(ctx, { isMember: true, verified: true, priceGeneration: 'V1', generation: 'V1' });
  assert.strictEqual(withoutProof.success, true);
  assert.strictEqual(withoutProof.price.tier, 'GENERAL');
  assert.strictEqual(record(ctx, withoutProof.bookingId).priceGeneration, 'V2', '世代はサーバー時刻で決まる');
  assert.strictEqual(record(ctx, withoutProof.bookingId).membershipStatus, 'UNVERIFIED');
});

test('V2: 会員利用中に証明の期限が切れたら黙って一般料金で確定せず再確認を要求（予約を作らない）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var proof = issue(ctx, MEMBER);
  var expired = book(ctx, { memberProof: proof }, at(V2_NOW, 61));
  assert.strictEqual(expired.success, false);
  assert.strictEqual(expired.error.code, 'MEMBER_REVERIFY_REQUIRED');
  assert.ok(expired.error.message.indexOf('確認コードを再送') !== -1);
  assert.strictEqual(bookingRows(ctx), 0);

  /* 31〜90日先を選択済みで期限切れ: 一般予約として確定させない。 */
  var advance = book(ctx, { memberProof: proof, date: ADVANCE_DATE }, at(V2_NOW, 61));
  assert.strictEqual(advance.error.code, 'MEMBER_REVERIFY_REQUIRED');

  /* ペアパック・シャワーも同様。 */
  var pair = book(ctx, { memberProof: proof, brand: 'mens', plan: 'member_pair_3h' }, at(V2_NOW, 61));
  assert.strictEqual(pair.error.code, 'MEMBER_REVERIFY_REQUIRED');
  assert.strictEqual(bookingRows(ctx), 0);

  /* 利用者が明示的に証明を外して一般予約へ戻した場合は、一般料金で進められる。 */
  var general = book(ctx, {}, at(V2_NOW, 61));
  assert.strictEqual(general.success, true);
  assert.strictEqual(general.price.tier, 'GENERAL');
});

test('V2: 他人のメールで取得した証明は予約メールが違えば使えない（再確認要求・予約を作らない）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var strangerProof = issue(ctx, STRANGER);
  var r = book(ctx, { email: MEMBER, memberProof: strangerProof });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'MEMBER_REVERIFY_REQUIRED');
  assert.strictEqual(bookingRows(ctx), 0);
});

test('V2: 31〜90日先の先行予約は確認済み証明 + 今日の会員資格が必要。日付選択後に初めて一般として扱わない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12', '2027-01'] } });
  var none = book(ctx, { date: ADVANCE_DATE });
  assert.strictEqual(none.success, false);
  assert.strictEqual(none.error.code, 'MEMBER_VERIFICATION_REQUIRED', '未確認は会員台帳を見ずに確認を要求');
  assert.strictEqual(ctx.lookups.length, 0);

  var proof = issue(ctx, MEMBER);
  ctx.lookups.length = 0;
  var ok = book(ctx, { date: ADVANCE_DATE, memberProof: proof, startTime: '13:00' });
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.price.tier, 'MEMBER');

  /* 確認済みでも今日の会員資格が無ければ先行予約不可（従来のエラー）。 */
  var s = setup({ members: { [MEMBER]: ['2027-01'] } });
  var sProof = issue(s, MEMBER);
  var denied = book(s, { date: ADVANCE_DATE, memberProof: sProof });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');

  /* 30日以内は未確認でも受け付ける。 */
  assert.strictEqual(book(ctx, { date: NEAR_DATE }).success, true);
});

test('V2: ペアパック・会員限定シャワーは確認済み証明が無ければ会員台帳を見ずに確認を要求（予約を作らない）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var pair = book(ctx, { brand: 'mens', plan: 'member_pair_3h' });
  assert.strictEqual(pair.success, false);
  assert.strictEqual(pair.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  var shower = book(ctx, { options: { shower: true } });
  assert.strictEqual(shower.success, false);
  assert.strictEqual(shower.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  assert.strictEqual(bookingRows(ctx), 0);
  assert.strictEqual(ctx.lookups.length, 0);

  var proof = issue(ctx, MEMBER);
  var ok = book(ctx, { brand: 'mens', plan: 'member_pair_3h', memberProof: proof });
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.price.amount, 5000);
  var withShower = book(ctx, { options: { shower: true }, memberProof: proof, startTime: '15:00' });
  assert.strictEqual(withShower.success, true, JSON.stringify(withShower));
  assert.strictEqual(withShower.options.orders[0].category, 'MEMBER_SERVICE');
});

test('V2: mensの部屋料金優遇は確認なしでも従来どおり（会員資格とは別概念）。確認済み+会員のときだけmembershipStatus=ACTIVE', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var plainMens = book(ctx, { brand: 'mens' });
  assert.strictEqual(plainMens.success, true);
  assert.strictEqual(plainMens.price.tier, 'MEMBER');
  assert.strictEqual(record(ctx, plainMens.bookingId).membershipStatus, 'NOT_CHECKED');
  var proof = issue(ctx, MEMBER);
  var verified = book(ctx, { brand: 'mens', memberProof: proof, startTime: '15:00' });
  assert.strictEqual(record(ctx, verified.bookingId).membershipStatus, 'ACTIVE');
});

test('V2: Studio Xは対象外（証明を求めず、証明が付いていても無視）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var r = book(ctx, { brand: 'studio_x', date: NEAR_DATE, memberProof: 'verified' });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(record(ctx, r.bookingId).membershipStatus, 'NOT_CHECKED');
});

test('V2: 後付けのシャワー申込は、予約作成時にメールOTP確認済みで会員資格があった予約だけ（未確認のV2予約には付けられない）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var unverified = book(ctx, { startTime: '10:00' });
  var denied = plain(ctx.sandbox.OptionOrderService.submitAddonOptions(unverified.bookingId, MEMBER, { shower: true }, V2_NOW));
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, 'MEMBER_BENEFIT_NOT_AVAILABLE');

  var proof = issue(ctx, MEMBER);
  var verified = book(ctx, { memberProof: proof, startTime: '15:00' });
  var ok = plain(ctx.sandbox.OptionOrderService.submitAddonOptions(verified.bookingId, MEMBER, { shower: true }, V2_NOW));
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
});

// ============================================================================
// createBooking: V1（従来仕様を維持。OTPを要求しない）
// ============================================================================

test('V1（〜2026/11/30作成）: 従来どおり自己申告で会員料金・会員台帳を参照せず、OTP証明を要求しない', function () {
  var ctx = setup();
  var r = book(ctx, { email: STRANGER, isMember: true, date: '2026-12-14' }, V1_NOW);
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.price.tier, 'MEMBER');
  assert.strictEqual(record(ctx, r.bookingId).priceGeneration, 'V1');
  assert.strictEqual(record(ctx, r.bookingId).membershipStatus, 'NOT_CHECKED');
  assert.strictEqual(ctx.lookups.length, 0);
});

test('V1: ペアパック・先行予約も従来どおり（証明なしで会員メールの実会員資格を判定）。証明が付いていても無視', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var pair = book(ctx, { brand: 'mens', plan: 'member_pair_3h', date: '2026-12-14' }, V1_NOW);
  assert.strictEqual(pair.success, true, JSON.stringify(pair));
  var advance = book(ctx, { date: '2027-02-02', startTime: '15:00', memberProof: 'garbage' }, new Date('2026-11-10T12:00:00+09:00'));
  /* 2027-02-02は2026-11-10から84日先（先行予約枠）。11月の会員資格が無いためV1の従来エラー（証明の有無は無関係）。 */
  assert.strictEqual(advance.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
  var nonMember = book(ctx, { email: STRANGER, brand: 'mens', plan: 'member_pair_3h', date: '2026-12-14' }, V1_NOW);
  assert.strictEqual(nonMember.error.code, 'MEMBER_BENEFIT_NOT_AVAILABLE');
});

test('V1/V2の境界はサーバー時刻（2026/12/1 0:00 JST）で決まる', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var v1 = book(ctx, { email: STRANGER, isMember: true }, new Date('2026-11-30T23:59:59+09:00'));
  assert.strictEqual(record(ctx, v1.bookingId).priceGeneration, 'V1');
  assert.strictEqual(v1.price.tier, 'MEMBER');
  var v2 = book(ctx, { email: STRANGER, isMember: true, startTime: '15:00' }, new Date('2026-12-01T00:00:00+09:00'));
  assert.strictEqual(record(ctx, v2.bookingId).priceGeneration, 'V2');
  assert.strictEqual(v2.price.tier, 'GENERAL');
});

// ============================================================================
// Web App（Code.gs）: 確認コードの送信・検証・会員結果の再取得
// ============================================================================

/* Code.gsは現在時刻（new Date()）で世代を判定するため、実行環境の日時に依存しないよう世代判定だけを固定する。 */
function pinGeneration(ctx, now) {
  ctx.realGenerationAt = ctx.realGenerationAt || ctx.sandbox.BookingPricing.generationAt;
  var real = ctx.realGenerationAt;
  ctx.sandbox.BookingPricing.generationAt = function (createdAt, brand) { return real(now, brand); };
}

test('Web App: requestBookingMemberCode / verifyBookingMemberCode / bookingMemberStatus（POST）でV2の会員結果と会員料金の見積りを返す', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  pinGeneration(ctx, V2_NOW);
  var requested = post(ctx, 'requestBookingMemberCode', { email: MEMBER });
  assert.strictEqual(requested.success, true);
  var code = /確認コード：(\d{6})/.exec(ctx.mailApp._sentEmails[0].body)[1];
  var verified = post(ctx, 'verifyBookingMemberCode', { email: MEMBER, code: code });
  assert.strictEqual(verified.success, true, JSON.stringify(verified));
  assert.ok(verified.proof);

  var status = post(ctx, 'bookingMemberStatus', { brand: 'snb', email: MEMBER, proof: verified.proof, date: NEAR_DATE, durationMinutes: 180 });
  assert.strictEqual(status.success, true, JSON.stringify(status));
  assert.strictEqual(status.verified, true);
  assert.strictEqual(status.memberOnDate, true);
  assert.strictEqual(status.price.tier, 'MEMBER');
  assert.strictEqual(status.price.amount, 5500);

  var outside = post(ctx, 'bookingMemberStatus', { brand: 'snb', email: MEMBER, proof: verified.proof, date: '2027-02-02', durationMinutes: 180 });
  assert.strictEqual(outside.memberOnDate, false);
  assert.strictEqual(outside.price.tier, 'GENERAL', '利用日が期間外なら確認済みでも一般料金の見積り');

  var pairOutside = post(ctx, 'bookingMemberStatus', { brand: 'mens', email: MEMBER, proof: verified.proof, date: '2027-02-02', durationMinutes: 180, plan: 'member_pair_3h' });
  assert.strictEqual(pairOutside.success, false);
  assert.strictEqual(pairOutside.error.code, 'MEMBER_BENEFIT_NOT_AVAILABLE');

  var noProof = post(ctx, 'bookingMemberStatus', { brand: 'snb', email: MEMBER, date: NEAR_DATE, durationMinutes: 180 });
  assert.strictEqual(noProof.success, false);
  assert.strictEqual(noProof.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  assert.strictEqual(post(ctx, 'bookingMemberStatus', { brand: 'studio_x', email: MEMBER, proof: verified.proof }).error.code, 'INVALID_BRAND');
});

test('Web App: V1の間は会員確認を使わない（bookingMemberStatusはMEMBER_VERIFICATION_NOT_REQUIRED。会員情報を返さない）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  pinGeneration(ctx, V1_NOW);
  var proof = issue(ctx, MEMBER);
  var r = post(ctx, 'bookingMemberStatus', { brand: 'snb', email: MEMBER, proof: proof, date: NEAR_DATE });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'MEMBER_VERIFICATION_NOT_REQUIRED');
  assert.strictEqual('memberOnDate' in r, false);
});

test('bookingMemberStatus: 証明なし・他メール・改ざん・期限切れでは会員情報（advanceEligible/memberOnDate/price）を返さない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var V = ctx.sandbox.BookingMemberVerification;
  var proof = issue(ctx, MEMBER);
  [
    { email: MEMBER },
    { email: MEMBER, proof: 'x'.repeat(40) },
    { email: STRANGER, proof: proof },
    { email: MEMBER, proof: proof.slice(0, -2) }
  ].forEach(function (input) {
    var r = plain(V.memberStatus(Object.assign({ date: NEAR_DATE }, input), at(V2_NOW, 1)));
    assert.strictEqual(r.success, false);
    assert.ok(['MEMBER_VERIFICATION_REQUIRED', 'MEMBER_REVERIFY_REQUIRED'].indexOf(r.error.code) !== -1);
    ['advanceEligible', 'memberOnDate', 'verified', 'price'].forEach(function (key) { assert.strictEqual(key in r, false); });
  });
  assert.strictEqual(plain(V.memberStatus({ email: MEMBER, proof: proof, date: NEAR_DATE }, at(V2_NOW, 61))).error.code, 'MEMBER_REVERIFY_REQUIRED');
  assert.strictEqual(ctx.lookups.length, 1 + 0, '台帳照会は証明の発行時の先行予約資格確認1回だけ');

  var ok = plain(V.memberStatus({ email: MEMBER, proof: proof, date: NEAR_DATE }, at(V2_NOW, 1)));
  assert.deepStrictEqual({ success: ok.success, verified: ok.verified, advanceEligible: ok.advanceEligible, memberOnDate: ok.memberOnDate },
    { success: true, verified: true, advanceEligible: true, memberOnDate: true });
  var feb = plain(V.memberStatus({ email: MEMBER, proof: proof, date: '2027-02-02' }, at(V2_NOW, 1)));
  assert.strictEqual(feb.memberOnDate, false, '利用日が期間外');
});

test('見積りGET: V2のSNBはクライアントのisMemberを無視して一般料金（会員料金の見積りは証明つきPOSTのみ）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  /* 現在時刻（実行環境）に依存しないよう、世代判定をV2に固定して呼ぶ。 */
  pinGeneration(ctx, V2_NOW);
  var body = JSON.parse(ctx.sandbox.doGet({ parameter: { action: 'estimatePrice', brand: 'snb', date: NEAR_DATE, durationMinutes: '180', isMember: '1' } }).text);
  assert.strictEqual(body.price.tier, 'GENERAL');
  pinGeneration(ctx, V1_NOW);
  var v1 = JSON.parse(ctx.sandbox.doGet({ parameter: { action: 'estimatePrice', brand: 'snb', date: NEAR_DATE, durationMinutes: '180', isMember: '1' } }).text);
  assert.strictEqual(v1.price.tier, 'MEMBER', 'V1は従来どおり自己申告');
});
