/*
 * SNB mens通常料金の5〜7名拡張（Issue #668）のテスト。
 *
 * - 料金正本（BookingPricing.gs）: 1〜4名は現行どおり、5人目以降＋1,000円／予約（予約全体で1回）、上限7名、独立プランと併用不可、提供開始の利用日条件
 * - 予約作成: 予約代表者のSNB MEMBER資格（OTP＋利用日の実会員資格）・カード決済のみ・全件承認待ち・枠の仮押さえ・8名以上と他ブランドの扱い
 * - 承認／不承認／支払期限（承認から24時間）／決済ゲート／確定ゲート／失効
 * - 利用者向けの照会（予約ID＋メールで本人確認）
 * - 共通部品のブランド分岐（mensだけ5〜7名の選択肢。SNB一般・Studio Xは不変）と、告知文面（上限7名・「SNB mensに限る」）
 *
 * Stripe・Sheets・Calendarはすべてスタブ/fixtureで、本番へは一切アクセスしない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var memberProof = require('./helpers/booking-member-proof');
var Logic = require('../scripts/booking-logic.js');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs',
  'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'EquipmentCatalog.gs',
  'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs',
  'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs', 'BookingMailTemplates.gs',
  'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs', 'BookingRepository.gs', 'AdminNotifier.gs',
  'BookingAdminAlerts.gs', 'BookingReschedule.gs', 'BookingMemberVerification.gs', 'Code.gs'
];

var EMAIL = 'taro@example.com';
var CARD = 'オンラインクレジットカード';
var NOW = new Date('2026-12-05T12:00:00+09:00');
/* 2026-12-07(月)=平日、2026-12-12(土)=土日、2026-11-28(土)=効力発生前。 */
var WEEKDAY = '2026-12-07';
var SATURDAY = '2026-12-12';
var BEFORE_START_SATURDAY = '2026-11-28';
var MEMBER = { [EMAIL]: ['2026-12'] };

function loadPricing() {
  return loadBookingSandbox(['JapaneseHolidays.gs', 'BookingPricing.gs', 'BookingOptions.gs', 'MembershipRules.gs', 'Config.gs'], {}).BookingPricing;
}

function price(P, extra) {
  return P.computeBookingPrice(Object.assign({ brand: 'mens', date: WEEKDAY, durationMinutes: 240, generation: 'V2' }, extra || {}));
}

// ============================================================================
// 料金正本
// ============================================================================

test('料金: 1〜4名は現行どおり（人数加算0円）。人数未指定・数値以外でも加算しない', function () {
  var P = loadPricing();
  ['1名', '2名', '3名', '4名', undefined].forEach(function (people) {
    var r = price(P, { people: people });
    assert.strictEqual(r.valid, true);
    assert.strictEqual(r.price.amount, 7000, String(people));
    assert.strictEqual(r.price.partySurcharge, 0);
    assert.strictEqual(r.price.largeParty, false);
  });
  assert.strictEqual(price(P, { date: SATURDAY, people: '4名' }).price.amount, 9000);
});

test('料金: 5名+1,000円・6名+2,000円・7名+3,000円（4時間・平日／土日祝）', function () {
  var P = loadPricing();
  [['5名', 8000, 10000, 1000], ['6名', 9000, 11000, 2000], ['7名', 10000, 12000, 3000]].forEach(function (c) {
    var wk = price(P, { people: c[0], date: WEEKDAY });
    var we = price(P, { people: c[0], date: SATURDAY });
    assert.strictEqual(wk.price.amount, c[1], c[0] + ' 平日');
    assert.strictEqual(we.price.amount, c[2], c[0] + ' 土日祝');
    assert.strictEqual(wk.price.partySurcharge, c[3]);
    assert.strictEqual(wk.price.baseAmount, 7000);
    assert.strictEqual(wk.price.largeParty, true);
  });
});

test('料金: 5時間の例（平日 9,500／10,500／11,500、土日祝 12,000／13,000／14,000）', function () {
  var P = loadPricing();
  [['5名', 9500, 12000], ['6名', 10500, 13000], ['7名', 11500, 14000]].forEach(function (c) {
    assert.strictEqual(price(P, { people: c[0], durationMinutes: 300, date: WEEKDAY }).price.amount, c[1]);
    assert.strictEqual(price(P, { people: c[0], durationMinutes: 300, date: SATURDAY }).price.amount, c[2]);
  });
});

test('料金: 人数加算は予約1件につき1回（利用時間が増えても重複加算しない）', function () {
  var P = loadPricing();
  [60, 120, 180, 240, 300, 480, 600].forEach(function (minutes) {
    var base = price(P, { people: '4名', durationMinutes: minutes, date: WEEKDAY }).price.amount;
    assert.strictEqual(price(P, { people: '7名', durationMinutes: minutes, date: WEEKDAY }).price.amount, base + 3000, minutes + '分');
  });
});

test('料金: 8名以上・上限超過は料金計算でも拒否（上限7名）', function () {
  var P = loadPricing();
  ['8名', '9名', '10名', '99名'].forEach(function (people) {
    var r = price(P, { people: people });
    assert.strictEqual(r.valid, false, people);
    assert.strictEqual(r.error.code, 'PARTY_SIZE_EXCEEDED');
  });
  assert.strictEqual(P.LARGE_PARTY_MAX_PEOPLE, 7);
  assert.strictEqual(P.isMensPartySizeAllowed('7名'), true);
  assert.strictEqual(P.isMensPartySizeAllowed('8名'), false);
  assert.strictEqual(P.isMensPartySizeAllowed('5名以上・要相談'), false);
});

test('料金: SNB一般・Studio Xは人数を見ない（5〜7名でも料金不変）', function () {
  var P = loadPricing();
  var snbBase = P.computeBookingPrice({ brand: 'snb', date: WEEKDAY, durationMinutes: 240, generation: 'V2', isMember: false });
  var snb7 = P.computeBookingPrice({ brand: 'snb', date: WEEKDAY, durationMinutes: 240, generation: 'V2', isMember: false, people: '7名' });
  assert.strictEqual(snb7.price.amount, snbBase.price.amount);
  assert.strictEqual(snb7.price.partySurcharge, 0);
  var sxBase = P.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY, durationMinutes: 240, generation: 'V2' });
  var sx6 = P.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY, durationMinutes: 240, generation: 'V2', people: '6名' });
  assert.strictEqual(sx6.price.amount, sxBase.price.amount);
  var sxPlan = P.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY, durationMinutes: 360, generation: 'V2', plan: 'osu_cosplay_base_6h', people: '6名' });
  assert.strictEqual(sxPlan.price.amount, 6000, 'Studio X貸切ベースプランの「6名まで追加料金なし」は不変');
});

test('料金: 提供開始は利用日が2026/12/1以降。効力発生前の利用日では5〜7名を適用できない（4名以下は影響なし）', function () {
  var P = loadPricing();
  var before = price(P, { people: '5名', date: BEFORE_START_SATURDAY });
  assert.strictEqual(before.valid, false);
  assert.strictEqual(before.error.code, 'LARGE_PARTY_NOT_AVAILABLE');
  assert.strictEqual(price(P, { people: '5名', date: '2026-12-01' }).valid, true);
  assert.strictEqual(price(P, { people: '4名', date: BEFORE_START_SATURDAY }).price.amount, 9000);
  assert.strictEqual(P.isLargePartyAvailableOnDate('2026-11-30'), false);
  assert.strictEqual(P.isLargePartyAvailableOnDate('2026-12-01'), true);
});

test('料金: 独立プラン（ペアパック・シャワーパック）とは併用できない（人数加算を重ねない）', function () {
  var P = loadPricing();
  ['member_pair_3h', 'mens_weekend_shower_4h'].forEach(function (plan) {
    var r = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: plan === 'member_pair_3h' ? 180 : 240, generation: 'V2', plan: plan, people: '5名' });
    assert.strictEqual(r.valid, false, plan);
    assert.strictEqual(r.error.code, 'LARGE_PARTY_PLAN_NOT_COMBINABLE');
  });
});

// ============================================================================
// 予約作成（サーバー）
// ============================================================================

function setup(opts) {
  var o = opts || {};
  var calendarsById = { cal1: { events: [] } };
  var spreadsheetsById = { ss1: {} };
  var properties = {
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1',
    BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000',
    STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_CHECKOUT_ENABLED: 'true',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/payment-complete.html?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/'
  };
  var stripeCalls = [];
  var mailApp = stubs.createMailAppStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp,
    UrlFetchApp: stubs.createUrlFetchAppStub(function (url) { stripeCalls.push(url); throw new Error('Stripeは呼ばれない想定: ' + url); }),
    Logger: stubs.createLoggerStub(), ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  var ctx = { sandbox: sandbox, mailApp: mailApp, stripeCalls: stripeCalls, sheets: spreadsheetsById.ss1, members: o.members || {}, calendars: calendarsById, proofs: {} };
  sandbox.MemberRepository.isMemberForMonth = function (email, month) {
    return (ctx.members[String(email).toLowerCase()] || []).indexOf(month) !== -1;
  };
  sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    return sandbox.MemberRepository.isMemberForMonth(email, String(date).substring(0, 7));
  };
  return ctx;
}

function payload(overrides) {
  return Object.assign({
    brand: 'mens', customerType: 'returning', date: SATURDAY, startTime: '10:00', durationMinutes: 240,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '5名', purpose: '緊縛の自主練習',
    paymentMethod: CARD, note: '', source: 'test', isMember: false
  }, overrides || {});
}

function book(ctx, overrides, now) {
  var at = now || NOW;
  var p = payload(overrides);
  if (p.memberProof === null) delete p.memberProof;
  else if (p.memberProof === undefined) p.memberProof = memberProof.proofFor(ctx.proofs, ctx.sandbox, ctx.mailApp, p.email, at);
  return ctx.sandbox.BookingRepository.createBooking(p, at);
}

function rec(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

function rows(ctx) {
  return ctx.sheets.Bookings ? ctx.sheets.Bookings._rows.length - 1 : 0;
}

function mailsTo(ctx, to) {
  return ctx.mailApp._sentEmails.filter(function (m) { return m.to === to; });
}

test('予約作成: 5名はMEMBER代表者なら承認待ちで受け付け、枠を仮押さえし、人数・加算・承認状態を保存する（決済には進まない）', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.status, 'PENDING');
  assert.strictEqual(r.approvalRequired, true);
  assert.strictEqual(r.approvalStatus, 'PENDING_APPROVAL');
  assert.strictEqual(r.checkoutAccessToken, '', '決済開始トークンを返さない（承認前に決済へ進ませない）');
  assert.strictEqual(r.price.amount, 10000);
  assert.strictEqual(r.price.baseAmount, 9000);
  assert.strictEqual(r.price.partySurcharge, 1000);
  var row = rec(ctx, r.bookingId);
  assert.strictEqual(row.people, '5名');
  assert.strictEqual(row.largeParty, true);
  assert.strictEqual(row.partySurcharge, 1000);
  assert.strictEqual(row.largePartyApprovalStatus, 'PENDING_APPROVAL');
  assert.strictEqual(row.membershipStatus, 'ACTIVE');
  assert.strictEqual(row.status, 'PENDING');
  assert.strictEqual(row.priceAmount, 10000);
  assert.strictEqual(ctx.stripeCalls.length, 0, '承認前にStripeを呼ばない');
  assert.strictEqual(ctx.calendars.cal1.events.length, 1, 'Calendarに仮押さえ');
});

test('予約作成: 6名・7名の人数加算を保存する。申込メールは基本部屋料金と人数加算を区別し、承認待ち・支払い未発生を明記する', function () {
  var ctx = setup({ members: MEMBER });
  var r6 = book(ctx, { people: '6名', startTime: '10:00' });
  var r7 = book(ctx, { people: '7名', startTime: '16:00' });
  assert.strictEqual(r6.price.amount, 11000);
  assert.strictEqual(r7.price.amount, 12000);
  assert.strictEqual(rec(ctx, r6.bookingId).partySurcharge, 2000);
  assert.strictEqual(rec(ctx, r7.bookingId).partySurcharge, 3000);
  var mail = mailsTo(ctx, EMAIL).filter(function (m) { return m.body.indexOf(r7.bookingId) !== -1; })[0];
  assert.ok(mail, '申込メール');
  assert.ok(/承認待ち/.test(mail.subject) && /お支払いも不要/.test(mail.body));
  assert.ok(/基本部屋料金: 9,000円/.test(mail.body) && /人数加算[^\n]*3,000円/.test(mail.body) && /利用料金（合計）: 12,000円/.test(mail.body));
  assert.ok(/24時間以内/.test(mail.body));
});

test('予約作成: 1〜4名は従来どおり（承認不要・加算なし・largePartyなし）', function () {
  var ctx = setup({ members: {} });
  var r = book(ctx, { people: '4名', paymentMethod: '現金' });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.approvalRequired, undefined);
  assert.strictEqual(r.price.amount, 9000);
  var row = rec(ctx, r.bookingId);
  assert.ok(row.largeParty === '' || row.largeParty === undefined);
  assert.strictEqual(row.partySurcharge === '' || row.partySurcharge === undefined, true);
});

test('予約作成: 8名以上・「5名以上・要相談」はmensでは受け付けない（予約行を作らない）', function () {
  var ctx = setup({ members: MEMBER });
  ['8名', '9名', '10名', '5名以上・要相談'].forEach(function (people) {
    var r = book(ctx, { people: people });
    assert.strictEqual(r.success, false, people);
    assert.strictEqual(r.error.code, 'PARTY_SIZE_EXCEEDED', people);
  });
  assert.strictEqual(rows(ctx), 0);
});

test('予約作成: 予約代表者にMEMBER資格が無ければ拒否（同一メッセージ。mensの会員料金優遇では代用できない）', function () {
  var ctx = setup({ members: {} });
  var r = book(ctx, { isMember: true });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'LARGE_PARTY_MEMBER_ONLY');
  assert.strictEqual(rows(ctx), 0);
  var ctx2 = setup({ members: { [EMAIL]: ['2027-01'] } });
  assert.strictEqual(book(ctx2, {}).error.code, 'LARGE_PARTY_MEMBER_ONLY', '利用日の月に資格が無い');
});

test('予約作成: メールOTPの確認済み証明が無ければ確認を要求する', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { memberProof: null });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'MEMBER_VERIFICATION_REQUIRED');
});

test('予約作成: 同行者の会員資格は問わない（代表者のメールだけで判定）', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { people: '7名', note: '同行者は非会員です' });
  assert.strictEqual(r.success, true, JSON.stringify(r));
});

test('予約作成: 5〜7名はオンラインクレジットカードのみ（現金・PayPay・未定は不可）。即時決済せず承認待ちへ送る', function () {
  var ctx = setup({ members: MEMBER });
  ['現金', 'PayPay', '未定'].forEach(function (method) {
    var r = book(ctx, { paymentMethod: method });
    assert.strictEqual(r.success, false, method);
    assert.strictEqual(r.error.code, 'LARGE_PARTY_CARD_REQUIRED', method);
  });
});

test('予約作成: 効力発生前の利用日では5〜7名を受け付けない。独立プランとも併用できない', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-11', '2026-12'] } });
  assert.strictEqual(book(ctx, { date: BEFORE_START_SATURDAY }, new Date('2026-11-20T12:00:00+09:00')).error.code, 'LARGE_PARTY_NOT_AVAILABLE');
  var combo = book(ctx, { plan: 'member_pair_3h', durationMinutes: 180 });
  assert.strictEqual(combo.success, false);
  assert.ok(['PAIR_PACK_PEOPLE_EXCEEDED', 'LARGE_PARTY_PLAN_NOT_COMBINABLE'].indexOf(combo.error.code) !== -1);
});

test('予約作成: SNB一般・Studio Xの人数の扱いは不変（5名以上・要相談の文字列をそのまま保存）', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { brand: 'snb', people: '5名以上・要相談', paymentMethod: '現金', memberProof: null });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(rec(ctx, r.bookingId).people, '5名以上・要相談');
  var r2 = book(ctx, { brand: 'studio_x', people: '5名以上・要相談', paymentMethod: '現金', memberProof: null, startTime: '16:00' });
  assert.strictEqual(r2.success !== undefined, true);
  assert.notStrictEqual(r2.error && r2.error.code, 'PARTY_SIZE_EXCEEDED');
});

test('仮押さえ: 申込済みの枠には競合する予約を受け付けない。不承認で枠が解放される', function () {
  var ctx = setup({ members: MEMBER });
  var first = book(ctx, {});
  assert.strictEqual(first.success, true);
  var clash = book(ctx, { people: '2名', paymentMethod: '現金', email: 'other@example.com', memberProof: null });
  assert.strictEqual(clash.success, false);
  assert.strictEqual(clash.error.code, 'SLOT_CONFLICT');
  var rejected = ctx.sandbox.BookingRepository.rejectLargeParty(first.bookingId, NOW);
  assert.strictEqual(rejected.success, true, JSON.stringify(rejected));
  assert.strictEqual(rec(ctx, first.bookingId).status, 'CANCELLED');
  assert.strictEqual(rec(ctx, first.bookingId).largePartyApprovalStatus, 'REJECTED');
  var again = book(ctx, { people: '2名', paymentMethod: '現金', email: 'another@example.com', name: '鈴木次郎', memberProof: null });
  assert.strictEqual(again.success, true, '枠が解放されている ' + JSON.stringify(again));
  var notice = mailsTo(ctx, EMAIL).filter(function (m) { return /承認できませんでした/.test(m.subject); });
  assert.strictEqual(notice.length, 1, '不承認の案内メール');
  assert.ok(/4名扱い/.test(notice[0].body));
});

// ============================================================================
// 承認・支払期限・決済／確定ゲート・失効
// ============================================================================

test('決済ゲート: 承認前はCheckoutを始められない（トークンを持っていても拒否）。確定もできない', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  var token = rec(ctx, r.bookingId).checkoutAccessToken;
  var pay = ctx.sandbox.BookingRepository.beginCardCheckout(r.bookingId, token, NOW);
  assert.strictEqual(pay.success, false);
  assert.strictEqual(pay.error.code, 'LARGE_PARTY_NOT_APPROVED');
  assert.strictEqual(ctx.stripeCalls.length, 0);
  var confirm = ctx.sandbox.BookingRepository.confirmBooking(r.bookingId);
  assert.strictEqual(confirm.success, false);
  assert.strictEqual(confirm.error.code, 'LARGE_PARTY_APPROVAL_REQUIRED');
});

test('承認: 支払期限は承認の24時間後。承認メールに確定料金（基本＋人数加算）と期限・支払いページを載せる', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { people: '6名' });
  var at = new Date('2026-12-06T10:00:00+09:00');
  var ok = ctx.sandbox.BookingRepository.approveLargeParty(r.bookingId, at);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  var row = rec(ctx, r.bookingId);
  assert.strictEqual(row.largePartyApprovalStatus, 'APPROVED');
  assert.strictEqual(new Date(row.largePartyApprovedAt).getTime(), at.getTime());
  assert.strictEqual(new Date(row.largePartyPaymentDueAt).getTime(), at.getTime() + 24 * 3600 * 1000);
  assert.strictEqual(row.status, 'PENDING', '支払い完了まで確定しない');
  var mail = mailsTo(ctx, EMAIL).filter(function (m) { return /承認しました/.test(m.subject); })[0];
  assert.ok(mail, '承認メール');
  assert.ok(/基本部屋料金: 9,000円/.test(mail.body) && /人数加算[^\n]*2,000円/.test(mail.body) && /利用料金（合計）: 11,000円/.test(mail.body));
  assert.ok(/2026\/12\/07 10:00/.test(mail.subject + mail.body), '期限の日時');
  assert.ok(mail.body.indexOf('/mens/booking/party/?bookingId=' + r.bookingId) !== -1, '支払いページ');
  assert.ok(/24時間以内/.test(mail.body));
});

test('承認: 承認時にも代表者の会員資格を再確認する（失効していれば承認しない）。二重承認・通常予約の承認は不可', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  ctx.members = {};
  var denied = ctx.sandbox.BookingRepository.approveLargeParty(r.bookingId, NOW);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, 'LARGE_PARTY_MEMBER_ONLY');
  ctx.members = MEMBER;
  assert.strictEqual(ctx.sandbox.BookingRepository.approveLargeParty(r.bookingId, NOW).success, true);
  assert.strictEqual(ctx.sandbox.BookingRepository.approveLargeParty(r.bookingId, NOW).error.code, 'ALREADY_DECIDED');
  assert.strictEqual(ctx.sandbox.BookingRepository.rejectLargeParty(r.bookingId, NOW).error.code, 'ALREADY_DECIDED');
  var normal = book(ctx, { people: '2名', paymentMethod: '現金', startTime: '16:00', memberProof: null });
  assert.strictEqual(ctx.sandbox.BookingRepository.approveLargeParty(normal.bookingId, NOW).error.code, 'NOT_LARGE_PARTY');
});

test('支払期限: 承認から24時間を過ぎるとCheckoutを始められない。過ぎた未払いは失効（不成立）し、枠が解放される', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  var at = new Date('2026-12-06T10:00:00+09:00');
  ctx.sandbox.BookingRepository.approveLargeParty(r.bookingId, at);
  var token = rec(ctx, r.bookingId).checkoutAccessToken;
  var late = new Date(at.getTime() + 24 * 3600 * 1000);
  var pay = ctx.sandbox.BookingRepository.beginCardCheckout(r.bookingId, token, late);
  assert.strictEqual(pay.error.code, 'LARGE_PARTY_PAYMENT_EXPIRED');
  /* 期限内（23時間59分）は失効しない。 */
  ctx.sandbox.BookingRepository.expirePendingBookings(new Date(late.getTime() - 60000));
  assert.strictEqual(rec(ctx, r.bookingId).status, 'PENDING');
  /* 期限ちょうど以降は失効する。 */
  ctx.sandbox.BookingRepository.expirePendingBookings(late);
  assert.strictEqual(rec(ctx, r.bookingId).status, 'EXPIRED');
  var again = book(ctx, { people: '2名', paymentMethod: '現金', email: 'other@example.com', memberProof: null }, late);
  assert.strictEqual(again.success, true, '枠が解放されている');
});

test('失効: 承認待ちの仮押さえにはIssueにない自動TTLを置かない（72時間後も保持）。利用開始を過ぎた未判断のものだけ失効', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { date: '2026-12-20' }, new Date('2026-12-05T12:00:00+09:00'));
  assert.strictEqual(r.success, true, JSON.stringify(r));
  ctx.sandbox.BookingRepository.expirePendingBookings(new Date('2026-12-09T12:00:00+09:00'));
  assert.strictEqual(rec(ctx, r.bookingId).status, 'PENDING', '4日後もまだ承認待ち');
  ctx.sandbox.BookingRepository.expirePendingBookings(new Date('2026-12-20T09:59:00+09:00'));
  assert.strictEqual(rec(ctx, r.bookingId).status, 'PENDING');
  ctx.sandbox.BookingRepository.expirePendingBookings(new Date('2026-12-20T10:00:00+09:00'));
  assert.strictEqual(rec(ctx, r.bookingId).status, 'EXPIRED');
});

// ============================================================================
// 利用者向けの照会
// ============================================================================

test('照会: 予約ID＋登録メールの一致が必要。不一致・通常予約は同一のFORBIDDEN。承認前は支払い不可、承認後は支払い可', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  var R = ctx.sandbox.BookingRepository;
  assert.strictEqual(R.getLargePartySummary(r.bookingId, 'x@example.com', NOW).error.code, 'FORBIDDEN');
  assert.strictEqual(R.getLargePartySummary('NOPE', EMAIL, NOW).error.code, 'FORBIDDEN');
  assert.strictEqual(R.startLargePartyCheckout(r.bookingId, 'x@example.com', NOW).error.code, 'FORBIDDEN');
  var before = R.getLargePartySummary(r.bookingId, EMAIL.toUpperCase(), NOW);
  assert.strictEqual(before.success, true);
  assert.strictEqual(before.payable, false);
  assert.strictEqual(before.payableReason, 'LARGE_PARTY_NOT_APPROVED');
  assert.strictEqual(before.booking.baseAmount, 9000);
  assert.strictEqual(before.booking.partySurcharge, 1000);
  assert.strictEqual(before.booking.amount, 10000);
  assert.strictEqual(R.startLargePartyCheckout(r.bookingId, EMAIL, NOW).error.code, 'LARGE_PARTY_NOT_APPROVED');
  R.approveLargeParty(r.bookingId, NOW);
  var after = R.getLargePartySummary(r.bookingId, EMAIL, NOW);
  assert.strictEqual(after.payable, true);
  assert.strictEqual(after.booking.approvalStatus, 'APPROVED');
});

// ============================================================================
// フロント（共通予約部品のブランド分岐）・告知文面
// ============================================================================

test('フロント: 人数欄はmensだけ5名・6名・7名（8名以上なし・「5名以上・要相談」は置き換え）。SNB一般・Studio Xは不変', function () {
  var html = read('_includes/booking_app_ja.html');
  var sel = /<select id="ba-people"[\s\S]*?<\/select>/.exec(html)[0];
  var mens = /\{% if include\.brand == "mens" %\}([\s\S]*?)\{% else %\}([\s\S]*?)\{% endif %\}\s*(?=<\/select>)/.exec(sel);
  assert.ok(mens, 'mens分岐');
  ['5名', '6名', '7名'].forEach(function (v) { assert.ok(mens[1].indexOf('value="' + v + '"') !== -1, v); });
  var mensOptions = mens[1].replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/value="(?:8|9|10)名"/.test(mensOptions) && mensOptions.indexOf('要相談') === -1);
  assert.ok(mens[2].indexOf('<option value="5名以上・要相談">5名以上・要相談</option>') !== -1, '他ブランドは従来どおり');
  assert.ok(sel.indexOf('data-event-plan-only="1" disabled hidden>5名') !== -1, 'Studio X貸切ベースプランの5〜6名は不変');
  var app = read('scripts/booking-app.js');
  assert.ok(app.indexOf("brand === 'mens' && Logic.isLargePartyPeopleValue") !== -1 || /brand === 'mens' && !!els\.people && Logic\.isLargePartyPeopleValue/.test(app));
});

test('フロント: 大人数の判定・加算・提供開始日はサーバーと同じ値', function () {
  assert.strictEqual(Logic.LARGE_PARTY_MAX_PEOPLE, 7);
  assert.strictEqual(Logic.isLargePartyPeopleValue('4名'), false);
  ['5名', '6名', '7名'].forEach(function (v) { assert.strictEqual(Logic.isLargePartyPeopleValue(v), true, v); });
  assert.strictEqual(Logic.isLargePartyPeopleValue('8名'), false);
  assert.strictEqual(Logic.isLargePartyPeopleValue('5名以上・要相談'), false);
  assert.deepStrictEqual([5, 6, 7].map(function (n) { return Logic.largePartySurcharge(n + '名'); }), [1000, 2000, 3000]);
  assert.strictEqual(Logic.largePartySurcharge('4名'), 0);
  var P = loadPricing();
  assert.strictEqual(Logic.LARGE_PARTY_START_DATE, P.LARGE_PARTY_START_DATE);
  assert.strictEqual(Logic.isLargePartyDateAllowed('2026-11-30'), false);
  assert.strictEqual(Logic.isLargePartyDateAllowed('2026-12-01'), true);
  ['PARTY_SIZE_EXCEEDED', 'LARGE_PARTY_NOT_AVAILABLE', 'LARGE_PARTY_MEMBER_ONLY', 'LARGE_PARTY_CARD_REQUIRED'].forEach(function (code) {
    assert.notStrictEqual(Logic.messageForErrorCode(code, 'ja'), 'エラーが発生しました。しばらくしてから再度お試しください。', code);
    assert.strictEqual(Logic.recoveryActionForErrorCode(code), 'edit-details', code);
  });
});

test('告知: 規約は「SNB mensに限る」・上限7名・2日前までの人数変更・承認後24時間決済を明記し、特商法・FAQ・料金表示・会員ページと整合する', function () {
  var legal = read('_includes/legal_ja.html');
  var terms = /id="party-terms">[\s\S]*?<\/ul>/.exec(legal)[0];
  assert.ok(/SNB mensに限る/.test(terms));
  ['上限は<strong>7名</strong>', '5人目以降1名につき1,000円', '予約1件につき1回', '2026年12月1日以降', '承認から24時間以内', '利用日の2日前まで', '前日・当日の減員', '返金しません', '同行者全員の入会は不要'].forEach(function (k) {
    if (k === '同行者全員の入会は不要') assert.ok(/同行者全員の入会は不要/.test(terms) || /同行者全員の入会は不要/.test(read('mens/index.html')));
    else assert.ok(terms.indexOf(k) !== -1, k);
  });
  assert.ok(/SNB mensに限り/.test(legal), '利用ルールの人数項目にSNB mens限定の例外を明記');
  var law = /特定商取引法に基づく表記[\s\S]*$/.exec(legal)[0];
  assert.ok(/5〜7名/.test(law) && /上限7名/.test(law) && /承認後24時間以内/.test(law));
  var mens = read('mens/index.html');
  ['5〜7名', '上限7名', '＋1,000円'].forEach(function (k) { assert.ok(mens.indexOf(k) !== -1, 'mens/index.html: ' + k); });
  assert.ok(mens.indexOf('id="party-pricing"') !== -1 && /5人目以降/.test(mens));
  var membership = read('mens/membership/index.html');
  assert.ok(/id="party-membership"/.test(membership) && /割引特典ではなく/.test(membership) && /上限|7名/.test(membership));
  [legal, mens, membership].forEach(function (src) {
    assert.ok(!/8名まで|最大8名|上限8名/.test(src), '上限は7名で統一');
  });
});

test('告知: 告知日（2026/10/30）から効力発生日（2026/12/1）まで30日以上。効力発生前の利用日には適用しない', function () {
  var announce = Date.UTC(2026, 9, 30);
  var effective = Date.UTC(2026, 11, 1);
  assert.ok((effective - announce) / 86400000 >= 30);
  var P = loadPricing();
  assert.strictEqual(P.LARGE_PARTY_START_DATE, '2026-12-01');
});

test('支払いページ: 予約IDだけでは操作できず、サーバー判定の結果を表示するだけ（金額・状態をクライアントで決めない）', function () {
  var js = read('scripts/booking-party.js');
  assert.ok(js.indexOf("post('partySummary'") !== -1 && js.indexOf("post('startPartyCheckout'") !== -1);
  assert.ok(js.indexOf('checkout.stripe.com') !== -1);
  assert.ok(!/localStorage|sessionStorage/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')), 'メールを保存しない');
  var code = read('gas/booking/public/Code.gs');
  assert.ok(/params\.action === 'partySummary' \|\| params\.action === 'startPartyCheckout'/.test(code));
});

test('日程変更: 5〜7名の再見積りも人数加算を保持する（加算が消えて過少請求にならない）。4名以下・他ブランドは不変', function () {
  var sb = loadBookingSandbox(['JapaneseHolidays.gs', 'BookingPricing.gs', 'FeeCalculator.gs', 'BookingOptions.gs', 'MembershipRules.gs', 'Config.gs'], {});
  var q = function (extra) {
    return sb.FeeCalculator.quoteFee(Object.assign({ brand: 'mens', priceTier: 'MEMBER', generation: 'V2', durationMinutes: 240, dateString: WEEKDAY }, extra));
  };
  assert.strictEqual(q({ people: '7名' }).amount, 10000);
  assert.strictEqual(q({ people: '4名' }).amount, 7000);
  assert.strictEqual(q({}).amount, 7000);
  assert.strictEqual(q({ people: '5名', dateString: SATURDAY }).amount, 10000);
  var snb = sb.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', generation: 'V2', durationMinutes: 240, dateString: WEEKDAY, people: '7名' });
  assert.strictEqual(snb.amount, 8000);
  assert.ok(/people: record\.people/.test(read('gas/booking/admin/BookingReschedule.gs')), '日程変更は保存済みの人数を渡す');
});

// ============================================================================
// 人数変更（利用日の2日前まで再計算。前日・当日の減員は返金なし）
// ============================================================================

test('人数変更: 2日前まで増員は人数・加算・料金を再計算し、減員も再計算する。メールは基本料金と加算を区別する', function () {
  var ctx = setup({ members: MEMBER });
  var R = ctx.sandbox.BookingRepository;
  var r = book(ctx, { people: '5名' });
  R.approveLargeParty(r.bookingId, NOW);
  var up = R.changeBookingPeople(r.bookingId, '7名', NOW);
  assert.strictEqual(up.success, true, JSON.stringify(up));
  var row = rec(ctx, r.bookingId);
  assert.strictEqual(row.people, '7名');
  assert.strictEqual(row.partySurcharge, 3000);
  assert.strictEqual(row.priceAmount, 12000);
  assert.strictEqual(row.largePartyApprovalStatus, 'APPROVED', '承認済みの増員で承認は維持（管理者の変更が承認）');
  var down = R.changeBookingPeople(r.bookingId, '6名', NOW);
  assert.strictEqual(down.success, true);
  assert.strictEqual(rec(ctx, r.bookingId).priceAmount, 11000);
  var mail = mailsTo(ctx, EMAIL).filter(function (m) { return /利用人数を変更/.test(m.subject); }).pop();
  assert.ok(mail && /5名 → 7名|7名 → 6名/.test(mail.body) && /人数加算/.test(mail.body));
});

test('人数変更: 4名以下へ変更すると通常料金へ再計算し、大人数の承認条件を解除する', function () {
  var ctx = setup({ members: MEMBER });
  var R = ctx.sandbox.BookingRepository;
  var r = book(ctx, { people: '6名' });
  var res = R.changeBookingPeople(r.bookingId, '4名', NOW);
  assert.strictEqual(res.success, true, JSON.stringify(res));
  var row = rec(ctx, r.bookingId);
  assert.strictEqual(row.priceAmount, 9000);
  assert.ok(row.largeParty === '' && row.partySurcharge === '' && row.largePartyApprovalStatus === '');
});

test('人数変更: 8名以上・同数・mens以外・金額修正済み・決済処理中は拒否する', function () {
  var ctx = setup({ members: MEMBER });
  var R = ctx.sandbox.BookingRepository;
  var r = book(ctx, { people: '5名' });
  assert.strictEqual(R.changeBookingPeople(r.bookingId, '8名', NOW).error.code, 'PARTY_SIZE_EXCEEDED');
  assert.strictEqual(R.changeBookingPeople(r.bookingId, '5名', NOW).error.code, 'NO_CHANGE');
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(r.bookingId, { paymentStatus: 'checkout_pending' });
  assert.strictEqual(R.changeBookingPeople(r.bookingId, '6名', NOW).error.code, 'PAYMENT_IN_PROGRESS');
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(r.bookingId, { paymentStatus: 'not_started', priceOverrideAt: NOW, priceOverrideAmount: 1 });
  assert.strictEqual(R.changeBookingPeople(r.bookingId, '6名', NOW).error.code, 'PRICE_OVERRIDDEN');
  var snb = book(ctx, { brand: 'snb', people: '2名', paymentMethod: '現金', memberProof: null, date: '2026-12-20' });
  assert.strictEqual(R.changeBookingPeople(snb.bookingId, '3名', NOW).error.code, 'NOT_MENS');
});

test('人数変更: 前日・当日は増員不可。減員は人数のみ更新し、人数加算分を含め値下げ・返金しない', function () {
  var ctx = setup({ members: MEMBER });
  var R = ctx.sandbox.BookingRepository;
  var r = book(ctx, { people: '6名', date: '2026-12-12' }, new Date('2026-12-05T12:00:00+09:00'));
  var dayBefore = new Date('2026-12-11T12:00:00+09:00');
  assert.strictEqual(R.changeBookingPeople(r.bookingId, '7名', dayBefore).error.code, 'PEOPLE_CHANGE_DEADLINE_PASSED');
  var cut = R.changeBookingPeople(r.bookingId, '5名', dayBefore);
  assert.strictEqual(cut.success, true, JSON.stringify(cut));
  assert.strictEqual(cut.change.noRefund, true);
  var row = rec(ctx, r.bookingId);
  assert.strictEqual(row.people, '5名');
  assert.strictEqual(row.priceAmount, 11000, '値下げしない');
  assert.strictEqual(row.partySurcharge, 2000);
  var twoDays = book(ctx, { people: '5名', date: '2026-12-19', startTime: '10:00' }, new Date('2026-12-05T12:00:00+09:00'));
  assert.strictEqual(R.changeBookingPeople(twoDays.bookingId, '6名', new Date('2026-12-17T23:00:00+09:00')).success, true, '2日前の暦日までは再計算');
  assert.strictEqual(R.changeBookingPeople(twoDays.bookingId, '7名', new Date('2026-12-18T00:30:00+09:00')).error.code, 'PEOPLE_CHANGE_DEADLINE_PASSED', '前日は不可');
});

test('人数変更: 入金済みは差額（追加請求・返金候補）を返し、4名以下から5〜7名へはPENDINGのみ・会員資格を再確認して承認待ちにする', function () {
  var ctx = setup({ members: MEMBER });
  var R = ctx.sandbox.BookingRepository;
  var r = book(ctx, { people: '5名' });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(r.bookingId, { paymentStatus: 'paid' });
  var up = R.changeBookingPeople(r.bookingId, '7名', NOW);
  assert.strictEqual(up.change.additionalChargeDue, 2000);
  var down = R.changeBookingPeople(r.bookingId, '5名', NOW);
  assert.strictEqual(down.change.refundDue, 2000);

  var small = book(ctx, { people: '3名', paymentMethod: CARD, date: '2026-12-26', startTime: '10:00', memberProof: null });
  assert.strictEqual(small.success, true, JSON.stringify(small));
  ctx.members = {};
  assert.strictEqual(R.changeBookingPeople(small.bookingId, '5名', NOW).error.code, 'LARGE_PARTY_MEMBER_ONLY');
  ctx.members = { [EMAIL]: ['2026-12'] };
  var ok = R.changeBookingPeople(small.bookingId, '5名', NOW);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.change.needsApproval, true);
  var row = rec(ctx, small.bookingId);
  assert.strictEqual(row.largePartyApprovalStatus, 'PENDING_APPROVAL');
  assert.strictEqual(row.largeParty, true);
  var cash = book(ctx, { people: '3名', paymentMethod: '現金', date: '2026-12-27', startTime: '10:00', memberProof: null });
  assert.strictEqual(R.changeBookingPeople(cash.bookingId, '5名', NOW).error.code, 'LARGE_PARTY_CARD_REQUIRED');
});

test('GA4: 既存イベントにparty_size_tierを付けて大人数選択を識別する（新しい成果イベントは作らない）', function () {
  var an = read('scripts/analytics.js');
  assert.ok(/setEventContext/.test(an) && /eventContext/.test(an));
  assert.ok(!/EVENTS\s*=\s*\{[^}]*large_party/i.test(an), '新規イベント名を足さない');
  var app = read('scripts/booking-app.js');
  assert.ok(/setEventContext\('party_size_tier', large \? 'large_5_7' : ''\)/.test(app));
});
