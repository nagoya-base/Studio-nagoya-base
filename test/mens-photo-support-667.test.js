/*
 * SNB mens限定「作品撮りサポートプラン」（Issue #667）のテスト。
 *
 * - 料金正本（BookingPricing.gs）: 部屋料金 平日1,200円/h・土日祝1,500円/h ＋ スタッフ対応 3,000 / 3,000 / 5,000円（いずれか必須）
 * - 対象: mens・SNB MEMBER（実会員資格）・1〜4名・利用日の7日前まで・効力発生日（利用日2026/12/1以降）
 * - 流れ: 申込で仮押さえ（PENDING）→ 承認前は決済不可 → 承認（支払い期限＝承認+24時間）→ 支払い完了で確定／期限切れは不成立・枠解放
 * - 他商品との非併用、通常料金・ペアパック・シャワーパックの不変、フロント定数とサーバー正本の一致
 *
 * Stripe・Sheets・Calendarはすべてスタブ/fixtureで、本番へは一切アクセスしない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var memberProof = require('./helpers/booking-member-proof');
var Logic = require('../scripts/booking-logic.js');
var SupportPayment = require('../scripts/booking-support-payment.js');

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

var PLAN = 'mens_photo_support';
var CARD = 'オンラインクレジットカード';
var EMAIL = 'taro@example.com';
var DENIED_CODE = 'MEMBER_BENEFIT_NOT_AVAILABLE';
/* 申込日（2026/12/5 12:00 JST）。利用日は7日後以降（12/12土）。 */
var NOW = new Date('2026-12-05T12:00:00+09:00');
var WEEKDAY = '2026-12-14';        /* 月 */
var SATURDAY = '2026-12-12';       /* 申込日からちょうど7日後 */
var SIX_DAYS = '2026-12-11';       /* 6日後（締切後） */
var HOLIDAY_MONDAY = '2027-01-11'; /* 成人の日 */
var MEMBER = { [EMAIL]: ['2026-12', '2027-01'] };

function loadPricing() {
  return loadBookingSandbox(['JapaneseHolidays.gs', 'BookingPricing.gs', 'BookingOptions.gs', 'MembershipRules.gs', 'Config.gs'], {}).BookingPricing;
}

function priceOf(P, extra) {
  return P.computeBookingPrice(Object.assign({ brand: 'mens', date: SATURDAY, durationMinutes: 120, generation: 'V2', plan: PLAN, supportServices: 'SETUP' }, extra || {}));
}

// ============================================================================
// 料金正本
// ============================================================================

test('料金: 部屋料金は平日1,200円/h・土日祝1,500円/h（祝日の月曜も土日祝）で、Studio Xの現行直接予約セルフ料金と同額', function () {
  var P = loadPricing();
  [[WEEKDAY, 1, 1200], [WEEKDAY, 3, 3600], [WEEKDAY, 6, 7200], [SATURDAY, 1, 1500], [SATURDAY, 4, 6000], [HOLIDAY_MONDAY, 2, 3000]].forEach(function (c) {
    var r = priceOf(P, { date: c[0], durationMinutes: c[1] * 60 });
    assert.strictEqual(r.valid, true, JSON.stringify(c) + JSON.stringify(r));
    assert.strictEqual(r.price.roomAmount, c[2], JSON.stringify(c));
    var sx = P.computeBookingPrice({ brand: 'studio_x', date: c[0], durationMinutes: c[1] * 60, generation: 'V2' });
    assert.strictEqual(r.price.roomAmount, sx.price.amount, 'Studio X V2 セルフ料金と同額: ' + JSON.stringify(c));
  });
});

test('料金: スタッフ対応は事前設営3,000円・片付け3,000円・セット5,000円を部屋料金へ加算する（合計＝amount）', function () {
  var P = loadPricing();
  [['SETUP', 3000], ['CLEANUP', 3000], ['BOTH', 5000]].forEach(function (c) {
    var r = priceOf(P, { date: WEEKDAY, durationMinutes: 180, supportServices: c[0] });
    assert.strictEqual(r.price.staffAmount, c[1], c[0]);
    assert.strictEqual(r.price.roomAmount, 3600);
    assert.strictEqual(r.price.amount, 3600 + c[1], c[0]);
    assert.strictEqual(r.price.supportServices, c[0]);
    assert.strictEqual(r.price.plan, PLAN);
    assert.strictEqual(r.price.currency, 'JPY');
  });
  assert.strictEqual(priceOf(P, { date: SATURDAY, durationMinutes: 120, supportServices: 'BOTH' }).price.amount, 3000 + 5000);
});

test('料金: スタッフ対応が未選択・不正値なら成立しない（スタッフ対応なしでは利用できない。通常料金へ倒さない）', function () {
  var P = loadPricing();
  [undefined, null, '', 'NONE', 'SELF', 'setup', 'BOTH2'].forEach(function (v) {
    var r = priceOf(P, { supportServices: v });
    assert.strictEqual(r.valid, false, String(v));
    assert.strictEqual(r.error.code, 'PHOTO_SUPPORT_SERVICE_REQUIRED', String(v));
  });
});

test('料金: mens以外・効力発生日（利用日2026/12/1）より前は成立しない。緊縛の有無・会員自己申告は料金に影響しない', function () {
  var P = loadPricing();
  ['snb', 'studio_x'].forEach(function (brand) {
    assert.strictEqual(priceOf(P, { brand: brand }).error.code, 'PLAN_NOT_AVAILABLE', brand);
  });
  assert.strictEqual(priceOf(P, { date: '2026-11-30' }).error.code, 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(priceOf(P, { date: '2026-12-01' }).valid, true, '効力発生日当日の利用日は可');
  assert.strictEqual(P.isPhotoSupportAvailableOnDate('2026-12-01'), true);
  assert.strictEqual(P.isPhotoSupportAvailableOnDate('2026-11-30'), false);
  assert.strictEqual(P.isPhotoSupportAvailableOnDate('2026/12/05'), false);
  assert.strictEqual(priceOf(P, { isMember: true }).price.amount, priceOf(P, { isMember: false }).price.amount);
});

test('料金: 人数は1〜4名のみ（5名以上・要相談・数値以外は不可）。申込は利用日の7日前まで（6日前は不可・ちょうど7日前は可）', function () {
  var P = loadPricing();
  ['1名', '2名', '3名', '4名'].forEach(function (p) { assert.strictEqual(P.isPhotoSupportPeople(p), true, p); });
  ['5名', '8名', '5名以上・要相談', '', 'abc', undefined, '0名'].forEach(function (p) { assert.strictEqual(P.isPhotoSupportPeople(p), false, String(p)); });
  assert.strictEqual(P.isPhotoSupportApplyOpen('2026-12-12', '2026-12-05'), true);
  assert.strictEqual(P.isPhotoSupportApplyOpen('2026-12-11', '2026-12-05'), false);
  assert.strictEqual(P.isPhotoSupportApplyOpen('2026-12-19', '2026-12-05'), true);
  assert.strictEqual(P.isPhotoSupportApplyOpen('2026-12-05', '2026-12-05'), false);
  assert.strictEqual(P.isPhotoSupportApplyOpen('bad', '2026-12-05'), false);
  assert.strictEqual(P.PHOTO_SUPPORT_MAX_PEOPLE, 4);
  assert.strictEqual(P.PHOTO_SUPPORT_APPLY_DAYS_BEFORE, 7);
  assert.strictEqual(P.PHOTO_SUPPORT_PAYMENT_DUE_HOURS, 24);
});

test('料金: 通常のmens料金・ペアパック・シャワーパック・Studio X・SNBの金額は変更しない', function () {
  var P = loadPricing();
  assert.strictEqual(P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 240, generation: 'V2' }).price.amount, 9000);
  assert.strictEqual(P.computeBookingPrice({ brand: 'mens', date: WEEKDAY, durationMinutes: 180, generation: 'V2' }).price.amount, 5500);
  assert.strictEqual(P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 180, generation: 'V2', plan: 'member_pair_3h' }).price.amount, 6000);
  assert.strictEqual(P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 240, generation: 'V2', plan: 'mens_weekend_shower_4h' }).price.amount, 6500);
  assert.strictEqual(P.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY, durationMinutes: 120, generation: 'V2' }).price.amount, 2400);
  assert.strictEqual(P.computeBookingPrice({ brand: 'snb', date: WEEKDAY, durationMinutes: 180, generation: 'V2', isMember: false }).price.amount, 6000);
  /* 通常料金の応答に作品撮りサポートの内訳キーを付けない。 */
  assert.strictEqual('roomAmount' in P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 240, generation: 'V2' }).price, false);
  assert.strictEqual(P.planLabel(PLAN), 'SNB mens 作品撮りサポートプラン');
  assert.strictEqual(P.isMemberPlan(PLAN), true, '実会員資格の確認対象（確定・承認時の再確認）');
  assert.strictEqual(P.isPhotoSupport(PLAN), true);
});

// ============================================================================
// 段階・決済ゲート・失効時刻（Booking.gs の純粋ロジック）
// ============================================================================

function loadBooking() {
  return loadBookingSandbox(['Availability.gs', 'Booking.gs'], {}).Booking;
}

test('段階: 承認前＝承認待ち、承認後＝支払い待ち、確定・キャンセル・失効は状態どおり。他のプランは空', function () {
  var B = loadBooking();
  var base = { planCode: PLAN, status: 'PENDING', supportApprovedAt: '' };
  assert.strictEqual(B.photoSupportStage(base), 'AWAITING_APPROVAL');
  assert.strictEqual(B.photoSupportStage(Object.assign({}, base, { supportApprovedAt: new Date() })), 'AWAITING_PAYMENT');
  assert.strictEqual(B.photoSupportStage(Object.assign({}, base, { status: 'CONFIRMED' })), 'CONFIRMED');
  assert.strictEqual(B.photoSupportStage(Object.assign({}, base, { status: 'CANCELLED' })), 'CANCELLED');
  assert.strictEqual(B.photoSupportStage(Object.assign({}, base, { status: 'EXPIRED' })), 'EXPIRED');
  assert.strictEqual(B.photoSupportStage({ planCode: '', status: 'PENDING' }), '');
  assert.strictEqual(B.photoSupportStage({ planCode: 'member_pair_3h', status: 'PENDING' }), '');
  assert.strictEqual(B.photoSupportStage(null), '');
});

test('決済ゲート: 承認前は決済不可、承認後24時間のあいだだけ可、期限後は不可。作品撮りサポート以外には何もしない', function () {
  var B = loadBooking();
  var approvedAt = new Date('2026-12-05T12:00:00+09:00');
  var due = new Date(approvedAt.getTime() + 24 * 3600000);
  var rec = { planCode: PLAN, status: 'PENDING', supportApprovedAt: '', supportPaymentDueAt: '' };
  assert.strictEqual(B.photoSupportPaymentGate(rec, approvedAt.getTime()).code, 'SUPPORT_NOT_APPROVED');
  var approved = Object.assign({}, rec, { supportApprovedAt: approvedAt, supportPaymentDueAt: due });
  assert.strictEqual(B.photoSupportPaymentGate(approved, approvedAt.getTime() + 1000), null);
  assert.strictEqual(B.photoSupportPaymentGate(approved, due.getTime() - 1), null, '期限の直前は可');
  assert.strictEqual(B.photoSupportPaymentGate(approved, due.getTime()).code, 'SUPPORT_PAYMENT_EXPIRED', '24時間ちょうどで不可');
  assert.strictEqual(B.photoSupportPaymentGate({ planCode: '', status: 'PENDING' }, 0), null);
  assert.strictEqual(B.photoSupportPaymentGate(Object.assign({}, approved, { status: 'EXPIRED' }), approvedAt.getTime()).code, 'BOOKING_NOT_PENDING');
});

test('失効時刻: 承認後は支払い期限（承認+24時間）、承認前は24h/72hのTTLを使わず利用開始の2時間前が上限', function () {
  var B = loadBooking();
  var start = new Date('2026-12-20T10:00:00+09:00').getTime();
  var approvedAt = new Date('2026-12-05T12:00:00+09:00');
  var due = new Date(approvedAt.getTime() + 24 * 3600000);
  assert.strictEqual(B.computePhotoSupportExpiryMillis({ supportApprovedAt: approvedAt, supportPaymentDueAt: due }, start, 2), due.getTime());
  assert.strictEqual(B.computePhotoSupportExpiryMillis({ supportApprovedAt: '', supportPaymentDueAt: '' }, start, 2), start - 2 * 3600000);
  /* 承認済みでも期限が不正なら、枠を即時解放せず承認前と同じ上限で扱う。 */
  assert.strictEqual(B.computePhotoSupportExpiryMillis({ supportApprovedAt: approvedAt, supportPaymentDueAt: '' }, start, 2), start - 2 * 3600000);
});

// ============================================================================
// 予約作成・承認・決済・失効（サーバー）
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
  var ctx = { sandbox: sandbox, mailApp: mailApp, stripeCalls: stripeCalls, calendars: calendarsById, sheets: spreadsheetsById.ss1, members: JSON.parse(JSON.stringify(o.members || {})), lookups: [], proofs: {} };
  sandbox.MemberRepository.isMemberForMonth = function (email, month) {
    ctx.lookups.push({ email: email, month: month });
    return (ctx.members[String(email).toLowerCase()] || []).indexOf(month) !== -1;
  };
  sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    return sandbox.MemberRepository.isMemberForMonth(email, String(date).substring(0, 7));
  };
  return ctx;
}

function payload(overrides) {
  return Object.assign({
    brand: 'mens', customerType: 'returning', date: SATURDAY, startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '2名', purpose: '作品撮り',
    paymentMethod: CARD, note: '', source: 'test', isMember: false, plan: PLAN, supportServices: 'BOTH'
  }, overrides || {});
}

function book(ctx, overrides, now) {
  var at = now || NOW;
  var p = payload(overrides);
  if (p.memberProof === null) delete p.memberProof;
  else if (p.memberProof === undefined) p.memberProof = memberProof.proofFor(ctx.proofs, ctx.sandbox, ctx.mailApp, p.email, at);
  return ctx.sandbox.BookingRepository.createBooking(p, at);
}

function record(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

/* 解放済み（削除済み）を除いた、枠を押さえているCalendarイベント数。 */
function heldEvents(ctx) {
  return ctx.calendars.cal1.events.filter(function (e) { return !e.isDeleted(); }).length;
}

function sentSubjects(ctx) {
  return ctx.mailApp._sentEmails.map(function (m) { return m.subject; });
}

function lastMail(ctx) {
  return ctx.mailApp._sentEmails[ctx.mailApp._sentEmails.length - 1];
}

function applied(ctx) {
  var r = book(ctx, {});
  assert.strictEqual(r.success, true, JSON.stringify(r));
  return r;
}

test('申込: 会員・1〜4名・7日前・スタッフ対応選択で成立し、PENDINGで仮押さえ（承認待ち）。決済には進まない', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  assert.strictEqual(r.status, 'PENDING');
  assert.strictEqual(r.supportStage, 'AWAITING_APPROVAL');
  assert.strictEqual(r.price.plan, PLAN);
  assert.strictEqual(r.price.amount, 3 * 1500 + 5000, '土日祝3時間＋セット5,000円');
  assert.strictEqual(r.price.roomAmount, 4500);
  assert.strictEqual(r.price.staffAmount, 5000);
  var rec = record(ctx, r.bookingId);
  assert.strictEqual(rec.planCode, PLAN);
  assert.strictEqual(rec.status, 'PENDING');
  assert.strictEqual(rec.supportServices, 'BOTH');
  assert.strictEqual(rec.supportRoomAmount, 4500);
  assert.strictEqual(rec.supportStaffAmount, 5000);
  assert.strictEqual(rec.priceAmount, 9500);
  assert.strictEqual(rec.supportApprovedAt, '');
  assert.strictEqual(rec.membershipStatus, 'ACTIVE');
  assert.strictEqual(rec.paymentStatus, 'not_started');
  assert.deepStrictEqual(ctx.stripeCalls, [], '申込でStripeを呼ばない');
  assert.strictEqual(heldEvents(ctx), 1, '対象時間帯を仮押さえ（Calendarイベント）');
});

test('申込: 受付メールは「承認待ち・未確定・承認前は支払い不可・承認後24時間・不成立なら通常料金へ自動変換しない」を明記し、内訳と注意を示す', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  var mail = ctx.mailApp._sentEmails.filter(function (m) { return m.to === EMAIL && m.subject.indexOf('承認待ち') !== -1; })[0];
  assert.ok(mail, '利用者へ送信: ' + sentSubjects(ctx).join(' / '));
  assert.ok(mail.subject.indexOf('承認待ち') !== -1 && mail.subject.indexOf('未確定') !== -1, mail.subject);
  ['承認前はお支払いできません', '承認後24時間', '通常のSNB mens料金へは自動で切り替えません', 'スタッフ対応: 事前設営＋片付け', '部屋料金: 4,500円', 'スタッフ対応料金: 5,000円', 'お支払い合計: 9,500円', '有料機材は別料金', '常駐するサービスではなく、当日のご依頼はできません', r.bookingId].forEach(function (t) {
    assert.ok(mail.body.indexOf(t) !== -1, t + '\n' + mail.body);
  });
  assert.ok(mail.body.indexOf('決済ページ') === -1 && mail.body.indexOf('stripe') === -1, '申込時点で決済ページを案内しない');
});

test('申込: 仮押さえ中は通常予約が同じ時間帯を取れない（二重受付防止）。別時間帯は取れる', function () {
  var ctx = setup({ members: MEMBER });
  applied(ctx);
  var conflict = book(ctx, { plan: '', supportServices: undefined, paymentMethod: '現金', startTime: '11:00', durationMinutes: 60 });
  assert.strictEqual(conflict.success, false);
  assert.strictEqual(conflict.error.code, 'SLOT_CONFLICT');
  var other = book(ctx, { plan: '', supportServices: undefined, paymentMethod: '現金', startTime: '18:00', durationMinutes: 60 });
  assert.strictEqual(other.success, true, JSON.stringify(other));
});

test('申込: 利用日の7日前を過ぎると拒否（6日前は不可・ちょうど7日前は可）。予約は作られない', function () {
  var ctx = setup({ members: MEMBER });
  var late = book(ctx, { date: SIX_DAYS });
  assert.strictEqual(late.success, false);
  assert.strictEqual(late.error.code, 'PHOTO_SUPPORT_DEADLINE_PASSED');
  assert.strictEqual(heldEvents(ctx), 0);
  assert.strictEqual(book(ctx, { date: SATURDAY }).success, true);
});

test('申込: 5名以上（要相談を含む）は拒否。1〜4名は可', function () {
  var ctx = setup({ members: MEMBER });
  ['5名', '5名以上・要相談', '8名'].forEach(function (people) {
    var r = book(ctx, { people: people });
    assert.strictEqual(r.success, false, people);
    assert.strictEqual(r.error.code, 'PHOTO_SUPPORT_PEOPLE_EXCEEDED', people);
  });
  assert.strictEqual(book(ctx, { people: '4名', startTime: '08:00', durationMinutes: 60 }).success, true);
});

test('申込: スタッフ対応なし・不正値は拒否（スタッフ対応なしでは本プランを利用できない）', function () {
  var ctx = setup({ members: MEMBER });
  [undefined, '', 'NONE', 'SELF'].forEach(function (v) {
    var r = book(ctx, { supportServices: v });
    assert.strictEqual(r.success, false, String(v));
    assert.strictEqual(r.error.code, 'PHOTO_SUPPORT_SERVICE_REQUIRED', String(v));
  });
  assert.strictEqual(heldEvents(ctx), 0);
});

test('申込: 支払方法はオンラインカードのみ。現金・PayPay・未定は拒否', function () {
  var ctx = setup({ members: MEMBER });
  ['現金', 'PayPay', '未定'].forEach(function (pm) {
    var r = book(ctx, { paymentMethod: pm });
    assert.strictEqual(r.success, false, pm);
    assert.strictEqual(r.error.code, 'PHOTO_SUPPORT_CARD_ONLY', pm);
  });
});

test('申込: 実会員資格が無ければ拒否（mensの部屋料金優遇では代用できない）。OTP確認済み証明が無ければ確認を要求する', function () {
  var ctx = setup({ members: {} });
  var denied = book(ctx, { isMember: true });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  var ctx2 = setup({ members: MEMBER });
  var noProof = book(ctx2, { memberProof: null });
  assert.strictEqual(noProof.success, false);
  assert.strictEqual(noProof.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  assert.strictEqual(ctx2.lookups.length, 0, '証明が無ければ会員台帳を見ない');
});

test('申込: 効力発生日（利用日2026/12/1）より前・mens以外では選べない', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-11', '2026-12'] } });
  var early = book(ctx, { date: '2026-11-28' }, new Date('2026-11-10T12:00:00+09:00'));
  assert.strictEqual(early.success, false);
  assert.strictEqual(early.error.code, 'PLAN_NOT_AVAILABLE');
  ['snb', 'studio_x'].forEach(function (brand) {
    var r = book(ctx, { brand: brand });
    assert.strictEqual(r.success, false, brand);
  });
});

test('申込: 同時オプション（シャワー等）は併用不可。部屋料金を置き換える他のプランとも併用しない（plan指定は1つ）', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { options: { shower: true, showerScheduleConfirmed: true } });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'PHOTO_SUPPORT_OPTIONS_NOT_ALLOWED');
  assert.strictEqual(heldEvents(ctx), 0);
  /* ペアパックの自動適用要求（autoPairPack）を付けても、作品撮りサポートのまま（ペアパックに置き換わらない）。 */
  var auto = book(ctx, { autoPairPack: true, people: '2名' });
  assert.strictEqual(auto.success, true, JSON.stringify(auto));
  assert.strictEqual(auto.price.plan, PLAN);
});

test('決済: 承認前は決済を開始できない（Stripeを呼ばない）', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  var res = ctx.sandbox.BookingRepository.beginCardCheckout(r.bookingId, r.checkoutAccessToken, NOW);
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error.code, 'SUPPORT_NOT_APPROVED');
  assert.deepStrictEqual(ctx.stripeCalls, []);
  assert.strictEqual(record(ctx, r.bookingId).paymentStatus, 'not_started');
});

test('確定: 承認前・承認後でも未払いのままでは確定できない（管理画面・メニューの手動確定も同じ）', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  var before = ctx.sandbox.BookingRepository.confirmBooking(r.bookingId);
  assert.strictEqual(before.success, false);
  assert.strictEqual(before.error.code, 'SUPPORT_NOT_APPROVED');
  var approved = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, NOW);
  assert.strictEqual(approved.success, true, JSON.stringify(approved));
  var unpaid = ctx.sandbox.BookingRepository.confirmBooking(r.bookingId);
  assert.strictEqual(unpaid.success, false);
  assert.strictEqual(unpaid.error.code, 'SUPPORT_PAYMENT_REQUIRED');
  assert.strictEqual(record(ctx, r.bookingId).status, 'PENDING');
});

test('承認: supportApprovedAtを記録し、支払い期限＝承認から24時間。お支払いページ入りの承認メールを送る（URLのトークンはフラグメント）', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  var at = new Date('2026-12-06T09:00:00+09:00');
  var res = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, at);
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.strictEqual(res.supportStage, 'AWAITING_PAYMENT');
  assert.strictEqual(res.mailSent, true, JSON.stringify(res));
  var rec = record(ctx, r.bookingId);
  assert.strictEqual(rec.supportApprovedAt.getTime(), at.getTime());
  assert.strictEqual(rec.supportPaymentDueAt.getTime(), at.getTime() + 24 * 3600000);
  assert.ok(rec.supportApprovalMailSentAt, '承認メールの送信を記録');
  var mail = lastMail(ctx);
  assert.strictEqual(mail.to, EMAIL);
  assert.ok(mail.subject.indexOf('承認しました') !== -1 && mail.subject.indexOf('2026/12/07 09:00') !== -1, mail.subject);
  ['お支払い期限: 2026/12/07 09:00', 'お支払いが完了するまで予約は確定していません', '部屋料金: 4,500円', 'スタッフ対応料金: 5,000円', 'お支払い合計: 9,500円', '既存のキャンセル規定', '通常のSNB mens料金へは自動で切り替わりません'].forEach(function (t) {
    assert.ok(mail.body.indexOf(t) !== -1, t + '\n' + mail.body);
  });
  var url = /お支払いページ: (\S+)/.exec(mail.body)[1];
  assert.ok(url.indexOf('/mens/booking/support-payment/?b=' + r.bookingId + '#t=') !== -1, url);
  assert.strictEqual(SupportPayment.parseBookingId(url.slice(url.indexOf('?'))), r.bookingId);
  assert.strictEqual(SupportPayment.parseToken(url.slice(url.indexOf('#'))), rec.checkoutAccessToken);
  assert.strictEqual(url.indexOf('?t='), -1, 'トークンはクエリ（サーバーログ）に載せない');
});

test('承認: 二重承認は冪等（支払い期限を延長しない・メールを二重送信しない）', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  var at = new Date('2026-12-06T09:00:00+09:00');
  ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, at);
  var mailsBefore = ctx.mailApp._sentEmails.length;
  var again = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date(at.getTime() + 3600000));
  assert.strictEqual(again.success, true);
  assert.strictEqual(again.alreadyApproved, true);
  assert.strictEqual(record(ctx, r.bookingId).supportPaymentDueAt.getTime(), at.getTime() + 24 * 3600000);
  assert.strictEqual(ctx.mailApp._sentEmails.length, mailsBefore);
});

test('承認: 作品撮りサポート以外・存在しない予約・承認時点で会員資格を失った予約は承認できない', function () {
  var ctx = setup({ members: MEMBER });
  assert.strictEqual(ctx.sandbox.BookingRepository.approvePhotoSupport('NOPE', NOW).error.code, 'NOT_FOUND');
  var normal = book(ctx, { plan: '', supportServices: undefined, paymentMethod: '現金', startTime: '18:00', durationMinutes: 60 });
  assert.strictEqual(ctx.sandbox.BookingRepository.approvePhotoSupport(normal.bookingId, NOW).error.code, 'NOT_PHOTO_SUPPORT');
  var r = applied(ctx);
  ctx.members[EMAIL] = [];
  var lost = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, NOW);
  assert.strictEqual(lost.success, false);
  assert.strictEqual(lost.error.code, DENIED_CODE);
  assert.strictEqual(record(ctx, r.bookingId).supportApprovedAt, '', '承認を記録しない');
});

test('決済: 承認後24時間以内は決済を開始できる（Stripe Checkout作成へ進む）。期限後は開始できない', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  var at = new Date('2026-12-06T09:00:00+09:00');
  ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, at);
  var late = ctx.sandbox.BookingRepository.beginCardCheckout(r.bookingId, r.checkoutAccessToken, new Date(at.getTime() + 24 * 3600000));
  assert.strictEqual(late.success, false);
  assert.strictEqual(late.error.code, 'SUPPORT_PAYMENT_EXPIRED');
  assert.deepStrictEqual(ctx.stripeCalls, [], '期限後はStripeを呼ばない');
  /* 期限内はゲートを通過してStripe呼び出しに進む（スタブはStripe呼び出しで例外を投げるため、呼び出しの有無で判定する）。 */
  var inTime = ctx.sandbox.BookingRepository.beginCardCheckout(r.bookingId, r.checkoutAccessToken, new Date(at.getTime() + 3600000));
  assert.notStrictEqual(inTime.error && inTime.error.code, 'SUPPORT_NOT_APPROVED');
  assert.notStrictEqual(inTime.error && inTime.error.code, 'SUPPORT_PAYMENT_EXPIRED');
  assert.ok(ctx.stripeCalls.length >= 1, '承認後はStripe Checkout作成に進む');
});

test('失効: 承認後24時間以内に未払いなら不成立（EXPIRED）で枠を解放し、不成立メールを送る。24時間より前は失効しない', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  var at = new Date('2026-12-06T09:00:00+09:00');
  ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, at);
  var before = ctx.sandbox.BookingRepository.expirePendingBookings(new Date(at.getTime() + 24 * 3600000 - 60000));
  assert.strictEqual(record(ctx, r.bookingId).status, 'PENDING', '期限の1分前は仮押さえ継続');
  assert.strictEqual(heldEvents(ctx), 1);
  var after = ctx.sandbox.BookingRepository.expirePendingBookings(new Date(at.getTime() + 24 * 3600000 + 60000));
  assert.ok(after && after.expiredCount >= 1, JSON.stringify(after));
  assert.strictEqual(record(ctx, r.bookingId).status, 'EXPIRED');
  assert.strictEqual(heldEvents(ctx), 0, '枠を解放（Calendarイベント削除）');
  var mail = lastMail(ctx);
  assert.ok(mail.subject.indexOf('不成立') !== -1, mail.subject);
  assert.ok(mail.body.indexOf('通常のSNB mens料金へは自動で切り替わりません') !== -1);
  /* 解放後は通常予約が同じ時間帯を取れる。 */
  var reuse = book(ctx, { plan: '', supportServices: undefined, paymentMethod: '現金', startTime: '10:00', durationMinutes: 60 }, new Date(at.getTime() + 25 * 3600000));
  assert.strictEqual(reuse.success, true, JSON.stringify(reuse));
});

test('失効: 承認前の申込は24時間・72時間のTTLでは失効しない（運営の確認を待つ）。利用開始の2時間前を過ぎると解放する', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  ctx.sandbox.BookingRepository.expirePendingBookings(new Date(NOW.getTime() + 100 * 3600000));
  assert.strictEqual(record(ctx, r.bookingId).status, 'PENDING', '申込から100時間経過しても承認待ちのまま');
  ctx.sandbox.BookingRepository.expirePendingBookings(new Date('2026-12-12T08:30:00+09:00'));
  assert.strictEqual(record(ctx, r.bookingId).status, 'EXPIRED');
});

test('不承認: 承認前のキャンセルで仮押さえを解除し、「承認できませんでした・通常料金へ自動で切り替わらない」メールを送る', function () {
  var ctx = setup({ members: MEMBER });
  var r = applied(ctx);
  var res = ctx.sandbox.BookingRepository.cancelBookingAdmin(r.bookingId);
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.strictEqual(record(ctx, r.bookingId).status, 'CANCELLED');
  assert.strictEqual(heldEvents(ctx), 0);
  var mail = ctx.mailApp._sentEmails.filter(function (m) { return m.subject.indexOf('承認できませんでした') !== -1; })[0];
  assert.ok(mail, sentSubjects(ctx).join('\n'));
  assert.ok(mail.body.indexOf('通常のSNB mens料金へは自動で切り替わりません') !== -1);
});

// ============================================================================
// 見積り・会員確認API（Code.gs）
// ============================================================================

test('見積りAPI: 作品撮りサポートの見積りはスタッフ対応の種別で金額が決まり、未選択は成立しない', function () {
  var ctx = setup({ members: MEMBER });
  var ok = ctx.sandbox.handleEstimatePrice_({ brand: 'mens', date: WEEKDAY, durationMinutes: '180', plan: PLAN, supportServices: 'CLEANUP', isMember: '1' }, undefined);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.price.amount, 3600 + 3000);
  assert.strictEqual(ok.price.roomAmount, 3600);
  var missing = ctx.sandbox.handleEstimatePrice_({ brand: 'mens', date: WEEKDAY, durationMinutes: '180', plan: PLAN }, undefined);
  assert.strictEqual(missing.success, false);
  assert.strictEqual(missing.error.code, 'PHOTO_SUPPORT_SERVICE_REQUIRED');
  var snb = ctx.sandbox.handleEstimatePrice_({ brand: 'snb', date: WEEKDAY, durationMinutes: '180', plan: PLAN, supportServices: 'SETUP' }, undefined);
  assert.strictEqual(snb.success, false);
});

// ============================================================================
// 日程変更・管理画面
// ============================================================================

test('管理画面: 商品種別・状態（承認待ち／支払い待ち／確定）・スタッフ対応・金額内訳・支払い期限を出し、承認できるのは承認待ちだけ。通常予約にはキーを付けない', function () {
  var ctx = setup({ members: MEMBER });
  var sandbox = loadBookingSandbox(FILES.concat(['BookingAdminWeb.gs']), {
    PropertiesService: stubs.createPropertiesServiceStub({ CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1' }),
    Logger: stubs.createLoggerStub(), Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(), MailApp: stubs.createMailAppStub(),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }), SpreadsheetApp: stubs.createSpreadsheetAppStub({ ss1: {} }),
    ContentService: stubs.createContentServiceStub(), UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('no'); })
  });
  var base = { planCode: PLAN, status: 'PENDING', supportServices: 'BOTH', supportRoomAmount: 4500, supportStaffAmount: 5000, supportApprovedAt: '', supportPaymentDueAt: '', supportApprovalMailSentAt: '', membershipStatus: 'ACTIVE' };
  var waiting = sandbox.buildAdminPhotoSupportFields_(base, 'Asia/Tokyo');
  assert.strictEqual(waiting.supportStage, 'AWAITING_APPROVAL');
  assert.ok(waiting.supportStageLabel.indexOf('承認待ち') !== -1 && waiting.supportStageLabel.indexOf('決済不可') !== -1);
  assert.strictEqual(waiting.supportServicesLabel, '事前設営＋片付け');
  assert.strictEqual(waiting.supportRoomAmount, 4500);
  assert.strictEqual(waiting.supportStaffAmount, 5000);
  assert.strictEqual(waiting.canApproveSupport, true);
  assert.strictEqual(waiting.membershipStatus, 'ACTIVE');
  var approvedAt = new Date('2026-12-06T09:00:00+09:00');
  var due = new Date(approvedAt.getTime() + 24 * 3600000);
  var paying = sandbox.buildAdminPhotoSupportFields_(Object.assign({}, base, { supportApprovedAt: approvedAt, supportPaymentDueAt: due }), 'Asia/Tokyo');
  assert.strictEqual(paying.supportStage, 'AWAITING_PAYMENT');
  assert.ok(paying.supportStageLabel.indexOf('支払い待ち') !== -1);
  assert.strictEqual(paying.canApproveSupport, false);
  assert.strictEqual(paying.canResendSupportApproval, true, '承認メール未送信なら再送できる');
  assert.ok(paying.supportPaymentDueAt.indexOf('2026-12-07') === 0 || paying.supportPaymentDueAt.indexOf('12') !== -1, paying.supportPaymentDueAt);
  var confirmed = sandbox.buildAdminPhotoSupportFields_(Object.assign({}, base, { status: 'CONFIRMED', supportApprovedAt: approvedAt, supportPaymentDueAt: due, supportApprovalMailSentAt: approvedAt }), 'Asia/Tokyo');
  assert.strictEqual(confirmed.supportStage, 'CONFIRMED');
  assert.strictEqual(confirmed.canApproveSupport, false);
  assert.strictEqual(confirmed.canResendSupportApproval, false);
  assert.strictEqual(sandbox.buildAdminPhotoSupportFields_({ planCode: '', status: 'PENDING' }, 'Asia/Tokyo'), null, '通常予約にはキーを付けない');
  assert.strictEqual(ctx.sandbox.BookingPricing.planLabel(PLAN), 'SNB mens 作品撮りサポートプラン');
  /* 管理画面のクライアントは、承認待ちに「承認」を出し、通常の「確定」を出さない。 */
  var admin = read('admin/booking/booking-admin.js');
  assert.ok(admin.indexOf("data-action=\"approve-support\"") !== -1 && admin.indexOf('adminApprovePhotoSupport') !== -1);
  assert.ok(admin.indexOf("if (supportAwaitingApproval || supportAwaitingPayment) canConfirm = false;") !== -1);
});

test('日程変更: 作品撮りサポートプランは対象外（通常料金へ黙って切り替えず、取り消して申し込み直す）', function () {
  var src = read('gas/booking/admin/BookingReschedule.gs');
  assert.ok(src.indexOf('PHOTO_SUPPORT_RESCHEDULE_NOT_SUPPORTED') !== -1 && src.indexOf('BookingPricing.isPhotoSupport(record.planCode)') !== -1);
});

// ============================================================================
// フロント（booking-logic.js / booking-app.js / 公開ページ）と正本の一致
// ============================================================================

test('フロント定数はサーバー正本と一致する（プラン識別子・効力発生日・上限・7日前）', function () {
  var P = loadPricing();
  assert.strictEqual(Logic.PHOTO_SUPPORT_PLAN_CODE, PLAN);
  assert.strictEqual(Logic.PHOTO_SUPPORT_START_DATE, P.PHOTO_SUPPORT_START_DATE);
  assert.strictEqual(Logic.PHOTO_SUPPORT_MAX_PEOPLE, P.PHOTO_SUPPORT_MAX_PEOPLE);
  assert.strictEqual(Logic.PHOTO_SUPPORT_APPLY_DAYS_BEFORE, P.PHOTO_SUPPORT_APPLY_DAYS_BEFORE);
  assert.strictEqual(loadBooking().PHOTO_SUPPORT_PLAN_CODE, PLAN);
});

test('フロント: 5名以上は選べず、効力発生日前・mens以外は選べず、7日前の判定はJST', function () {
  assert.strictEqual(Logic.photoSupportPeopleAllowed('4名'), true);
  assert.strictEqual(Logic.photoSupportPeopleAllowed('5名以上・要相談'), false);
  assert.strictEqual(Logic.photoSupportPeopleAllowed(''), true, '未選択は判定しない（必須チェックは別）');
  assert.strictEqual(Logic.photoSupportAvailableOnDate('mens', '2026-12-01'), true);
  assert.strictEqual(Logic.photoSupportAvailableOnDate('mens', '2026-11-30'), false);
  assert.strictEqual(Logic.photoSupportAvailableOnDate('snb', '2026-12-12'), false);
  assert.strictEqual(Logic.photoSupportAvailableOnDate('studio_x', '2026-12-12'), false);
  assert.strictEqual(Logic.photoSupportApplyOpen('2026-12-12', '2026-12-05'), true);
  assert.strictEqual(Logic.photoSupportApplyOpen('2026-12-11', '2026-12-05'), false);
  assert.strictEqual(Logic.todayJstString(Date.UTC(2026, 11, 4, 16, 0)), '2026-12-05', 'UTC 16:00 はJSTで翌日');
  assert.strictEqual(Logic.photoSupportServicesValid('BOTH'), true);
  assert.strictEqual(Logic.photoSupportServicesValid('NONE'), false);
});

test('フロント: 送信ペイロードはプランとスタッフ対応の種別だけを送る（金額・承認状態は送らない）。未選択なら従来のペイロードのまま', function () {
  var base = { brand: 'mens', customerType: 'returning', date: SATURDAY, startTime: '10:00', durationMinutes: 180, name: 'a', email: EMAIL, people: '2名', purpose: 'x', paymentMethod: CARD };
  var withPlan = Logic.buildCreateBookingPayload(Object.assign({}, base, { plan: PLAN, supportServices: 'SETUP' }));
  assert.strictEqual(withPlan.plan, PLAN);
  assert.strictEqual(withPlan.supportServices, 'SETUP');
  ['price', 'amount', 'priceAmount', 'supportApprovedAt', 'status'].forEach(function (k) { assert.strictEqual(k in withPlan, false, k); });
  var normal = Logic.buildCreateBookingPayload(base);
  assert.strictEqual('plan' in normal, false);
  assert.strictEqual('supportServices' in normal, false);
});

test('フロント: 承認制の文言（承認待ち・承認前は決済不可・承認後24時間・自動で通常料金へ切り替えない）と、エラー文言・適用プラン表示', function () {
  var copy = Logic.photoSupportFlowCopy('ja');
  assert.ok(copy.banner.body.indexOf('承認前はお支払いできず') !== -1 && copy.banner.body.indexOf('承認後24時間') !== -1);
  assert.ok(copy.consent.indexOf('通常のSNB mens料金へは自動で切り替わらない') !== -1);
  assert.strictEqual(copy.submitLabel, '承認待ちで申し込む');
  var lines = Logic.photoSupportReceivedNoticeLines('ja').join('\n');
  assert.ok(lines.indexOf('お支払いはまだできません') !== -1 && lines.indexOf('承認後24時間') !== -1);
  assert.ok(Logic.photoSupportReceivedNoticeLines('en').join(' ').indexOf('24 hours') !== -1);
  ['PHOTO_SUPPORT_PEOPLE_EXCEEDED', 'PHOTO_SUPPORT_SERVICE_REQUIRED', 'PHOTO_SUPPORT_DEADLINE_PASSED', 'PHOTO_SUPPORT_CARD_ONLY', 'SUPPORT_NOT_APPROVED', 'SUPPORT_PAYMENT_EXPIRED'].forEach(function (code) {
    assert.ok(Logic.messageForErrorCode(code, 'ja', 'mens').length > 10, code);
    assert.ok(Logic.messageForErrorCode(code, 'en', 'mens').length > 10, code + ' en');
  });
  assert.strictEqual(Logic.appliedRateInfo({ brand: 'mens', tier: 'MEMBER', plan: PLAN }, 'ja').text, '適用プラン：SNB mens 作品撮りサポートプラン（SNB MEMBER限定）');
});

test('お支払いページ: 予約IDはクエリ、トークンはフラグメントから読み、https以外のStripe遷移先は使わない。承認前・期限後の文言を持つ', function () {
  assert.strictEqual(SupportPayment.parseBookingId('?b=MENS-20261212-ABCD1234'), 'MENS-20261212-ABCD1234');
  assert.strictEqual(SupportPayment.parseBookingId('?x=1'), '');
  assert.strictEqual(SupportPayment.parseToken('#t=abc-123'), 'abc-123');
  assert.strictEqual(SupportPayment.parseToken(''), '');
  assert.strictEqual(SupportPayment.isSafeCheckoutUrl('https://checkout.stripe.com/c/pay/x'), true);
  assert.strictEqual(SupportPayment.isSafeCheckoutUrl('http://example.com'), false);
  assert.strictEqual(SupportPayment.isSafeCheckoutUrl('javascript:alert(1)'), false);
  assert.ok(SupportPayment.messageForCode('SUPPORT_NOT_APPROVED').indexOf('承認') !== -1);
  assert.ok(SupportPayment.messageForCode('SUPPORT_PAYMENT_EXPIRED').indexOf('24時間') !== -1);
  assert.ok(SupportPayment.messageForCode('SOMETHING_ELSE').indexOf('二重') !== -1, '不明なエラーは二重決済を避ける案内');
  var html = read('mens/booking/support-payment/index.html');
  assert.ok(html.indexOf('name="robots" content="noindex, nofollow"') !== -1 && html.indexOf('name="referrer" content="no-referrer"') !== -1);
  assert.ok(html.indexOf('booking-support-payment.js') !== -1 && html.indexOf('booking-config.js') !== -1);
});

test('予約フォーム（mens）: 通常予約とは別に明示選択でき、スタッフ対応3択・1〜4名・7日前・承認制・24時間・有料機材別・併用不可を表示する。他ブランドには出さない', function () {
  var inc = read('_includes/booking_app_ja.html');
  var block = inc.slice(inc.indexOf('{% if include.brand == "mens" %}\n    <!-- Issue #667'), inc.indexOf('id="ba-photo-support-terms"'));
  assert.ok(block.length > 100, 'mens限定ブロックがある');
  ['id="ba-plan-photo-support"', 'value="mens_photo_support"', 'name="supportServices" value="SETUP"', 'name="supportServices" value="CLEANUP"', 'name="supportServices" value="BOTH"',
    '平日1,200円/h・土日祝1,500円/h', '事前設営　3,000円', '片付け　3,000円', '事前設営＋片付け　5,000円', 'いずれか1つ必須'].forEach(function (t) {
    assert.ok(block.indexOf(t) !== -1, t);
  });
  assert.ok(block.indexOf('checked') === -1, '初期は未選択（利用者が明示的に選ぶ）');
  var terms = inc.slice(inc.indexOf('id="ba-photo-support-terms"'), inc.indexOf('</ul>', inc.indexOf('id="ba-photo-support-terms"')));
  ['1〜4名限定', '5名以上は選べません', '無料サービスではありません', '利用日の7日前まで', '仮押さえ', '承認前はお支払いできません', '承認後24時間以内', '自動で切り替わりません', '常駐', '当日のご依頼はできません', '有料機材は別料金', '併用できません', 'キャンセル規定'].forEach(function (t) {
    assert.ok(terms.indexOf(t) !== -1, t);
  });
  assert.strictEqual(inc.split('id="ba-plan-photo-support"').length - 1, 1, 'mens以外のブランドには出さない（1か所だけ・mens条件内）');
  assert.ok(read('mens/booking/index.html').indexOf('brand="mens"') !== -1);
});

test('/mens/membership/ に仕様・料金・期限・承認条件が表示される（必須表示）', function () {
  var page = read('mens/membership/index.html');
  assert.ok(page.indexOf('{% include mens_photo_support_ja.html %}') !== -1);
  var text = read('_includes/mens_photo_support_ja.html').replace(/<[^>]+>/g, '');
  ['1,200円/h', '1,500円/h', '事前設営 3,000円', '片付け 3,000円', '5,000円', '最低1つ', '1〜4名限定', '7日前まで', '承認後24時間以内', '有料機材は別料金', '併用できません', '通常のSNB mens料金を変更する商品ではなく',
    '無料サービスではありません', '常駐', '当日のご依頼はできません', '2026年12月1日以降の利用日', 'キャンセル規定', '含まない', '撮影代行', '吊り設備の組み替え', '緊縛の施術・指導'].forEach(function (t) {
    assert.ok(text.indexOf(t) !== -1, t);
  });
  assert.ok(read('_includes/mens_photo_support_ja.html').indexOf('id="photo-support"') !== -1);
});

test('/mens/ トップ: 「設営をサポート」の近傍から詳細へ誘導し、無料・常駐・当日対応と誤認させない注記を置く', function () {
  var top = read('mens/index.html');
  var i = top.indexOf('本格的な照明機材も、設営をサポート。');
  var near = top.slice(i, i + 900);
  ['SNB MEMBER限定', '有料サービス', '無料ではなく', '常駐せず', '当日のご依頼はできません', '7日前まで', '運営の承認', '#photo-support'].forEach(function (t) {
    assert.ok(near.indexOf(t) !== -1, t);
  });
  assert.ok(top.indexOf('作品撮りサポートプラン') !== -1);
});

test('規約・特商法・FAQ: 同じ効力発生日（2026年12月1日）で、料金・7日前・承認後24時間・1〜4名・併用不可・キャンセル・SNB mens限定を整合させる', function () {
  var legal = read('_includes/legal_ja.html');
  var terms = legal.slice(legal.indexOf('id="photo-support-terms"'), legal.indexOf('<h3>8. 予約と支払</h3>')).replace(/<[^>]+>/g, '');
  ['SNB mens限定', '効力発生日：2026年12月1日', '本項はSNB mensのご予約に限り', '平日1時間1,200円・土日祝1時間1,500円', '事前設営3,000円・片付け3,000円・事前設営＋片付け5,000円', 'いずれか1つ以上の選択が必須', '有料機材は別料金', '1〜4名', '利用日の7日前まで', '仮押さえ', '承認前はお支払いできません', '24時間以内', '併用できません', '既存のキャンセルポリシー', '照明配置と白／黒背景', '吊り設備の組み替え', '撮影代行', '常駐'].forEach(function (t) {
    assert.ok(terms.indexOf(t) !== -1, t);
  });
  var tokushoho = legal.slice(legal.indexOf('<th scope="row">価格</th>'), legal.indexOf('<th scope="row">支払方法</th>')).replace(/<[^>]+>/g, '');
  ['作品撮りサポートプラン', '1,200円', '1,500円', '3,000円', '5,000円', '有料機材は別料金'].forEach(function (t) { assert.ok(tokushoho.indexOf(t) !== -1, t); });
  var timing = legal.slice(legal.indexOf('<th scope="row">支払時期</th>'), legal.indexOf('<th scope="row">SNB MEMBER（月額会員）</th>')).replace(/<[^>]+>/g, '');
  ['7日前まで', '承認後24時間以内', '承認前はお支払いできません'].forEach(function (t) { assert.ok(timing.indexOf(t) !== -1, t); });
  assert.ok(legal.indexOf('効力発生日は2026年12月1日です') !== -1 && legal.indexOf('30日以上経過した日') !== -1, '告知日と効力発生日を区別');
  var faq = read('mens/how-to/index.html');
  assert.ok(faq.indexOf('作品撮りサポートプランとは何ですか？') !== -1);
  ['承認後24時間以内', '1〜4名限定', '7日前まで'].forEach(function (t) { assert.ok(faq.indexOf(t) !== -1, t); });
});

test('GAS配布: 追加ファイルは無く、列追加の手順（README）と既存の配布マニフェストに差分が無い', function () {
  var readme = read('gas/booking/README.md');
  assert.ok(readme.indexOf('Issue #667') !== -1 && readme.indexOf('supportApprovalMailSentAt') !== -1);
  var headers = loadBookingSandbox(['SpreadsheetRepository.gs', 'Config.gs'], {}).SpreadsheetRepository;
  assert.ok(headers);
});

// ============================================================================
// 有料機材（共通機材カタログを正本に、同じ承認・同じお支払いへ含める）
// ============================================================================

var CATALOG_JSON = JSON.parse(read('_data/studio_x_equipment.json'));
function rentalOf(code) { return CATALOG_JSON.rental.filter(function (r) { return r.code === code; })[0]; }

test('有料機材: 共通カタログの単価で計算し、部屋料金＋スタッフ対応料金＋機材料金の合計になる（mens用に単価を複製しない）', function () {
  var P = loadBookingSandbox(['JapaneseHolidays.gs', 'EquipmentCatalog.gs', 'BookingPricing.gs', 'BookingOptions.gs', 'MembershipRules.gs', 'Config.gs'], {}).BookingPricing;
  var paid = CATALOG_JSON.rental.filter(function (r) { return r.unitPriceJpy > 0 && !r.freeWhenWith && r.stock >= 2; })[0];
  assert.ok(paid, 'セット無料条件の無い、在庫2点以上の有料機材がカタログにある');
  var base = priceOf(P, { date: WEEKDAY, durationMinutes: 120, supportServices: 'SETUP' });
  var eq = {}; eq[paid.code] = 2;
  var withEq = priceOf(P, { date: WEEKDAY, durationMinutes: 120, supportServices: 'SETUP', supportEquipment: eq });
  assert.strictEqual(withEq.valid, true, JSON.stringify(withEq));
  assert.strictEqual(withEq.price.equipmentAmount, paid.unitPriceJpy * 2, 'カタログ単価×数量');
  assert.strictEqual(withEq.price.amount, base.price.amount + paid.unitPriceJpy * 2);
  assert.strictEqual(withEq.price.roomAmount, base.price.roomAmount);
  assert.strictEqual(withEq.price.staffAmount, base.price.staffAmount);
  assert.strictEqual(base.price.equipmentAmount, 0, '機材なしは0円');
  assert.deepStrictEqual(Array.from(withEq.price.equipmentItems), ['EQ:' + paid.code + ':2']);
});

test('有料機材: セット無料条件（freeWhenWith）を共通カタログどおり適用し、未知の機材・小数・負数・在庫超過は拒否する', function () {
  var P = loadBookingSandbox(['JapaneseHolidays.gs', 'EquipmentCatalog.gs', 'BookingPricing.gs', 'BookingOptions.gs', 'MembershipRules.gs', 'Config.gs'], {}).BookingPricing;
  var bundled = CATALOG_JSON.rental.filter(function (r) { return r.freeWhenWith; })[0];
  assert.ok(bundled);
  var companionCode = bundled.freeWhenWith.codes[0];
  var eq = {}; eq[bundled.code] = 1; eq[companionCode] = 1;
  var r = priceOf(P, { supportEquipment: eq });
  assert.strictEqual(r.valid, true, JSON.stringify(r));
  var line = r.price.equipmentLines.filter(function (l) { return l.code === bundled.code; })[0];
  assert.strictEqual(line.freeQuantity, 1, 'セット無料');
  assert.strictEqual(line.amountJpy, 0);
  var companion = rentalOf(companionCode);
  assert.strictEqual(r.price.equipmentAmount, companion.unitPriceJpy);
  assert.strictEqual(priceOf(P, { supportEquipment: { NOPE_CODE: 1 } }).error.code, 'UNKNOWN_OPTION');
  var any = {}; any[companionCode] = 1.5;
  assert.strictEqual(priceOf(P, { supportEquipment: any }).error.code, 'INVALID_OPTIONS');
  any[companionCode] = -1;
  assert.strictEqual(priceOf(P, { supportEquipment: any }).error.code, 'INVALID_OPTIONS');
  any[companionCode] = companion.stock + 1;
  assert.strictEqual(priceOf(P, { supportEquipment: any }).error.code, 'STOCK_EXCEEDED');
});

test('有料機材: 無料の常設備品・無料備品を有料化しない（無料のセルフ備品は0円のまま）', function () {
  var P = loadBookingSandbox(['JapaneseHolidays.gs', 'EquipmentCatalog.gs', 'BookingPricing.gs', 'BookingOptions.gs', 'MembershipRules.gs', 'Config.gs'], {}).BookingPricing;
  var free = CATALOG_JSON.freeSelf.filter(function (f) { return f.selectable === true; })[0];
  if (!free) return;
  var eq = {}; eq[free.code] = 1;
  var r = priceOf(P, { supportEquipment: eq });
  assert.strictEqual(r.valid, true, JSON.stringify(r));
  assert.strictEqual(r.price.equipmentAmount, 0);
  assert.strictEqual(r.price.amount, priceOf(P, {}).price.amount);
});

test('有料機材: 申込に保存され（明細・金額）、承認メール・申込メールに内訳が出て、お支払い額（priceAmount）に含まれる。通常予約には付けられない', function () {
  var ctx = setup({ members: MEMBER });
  var paid = CATALOG_JSON.rental.filter(function (r) { return r.unitPriceJpy > 0 && !r.freeWhenWith; })[0];
  var eq = {}; eq[paid.code] = 1;
  var r = book(ctx, { supportEquipment: eq });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.price.equipmentAmount, paid.unitPriceJpy);
  var rec = record(ctx, r.bookingId);
  assert.strictEqual(rec.supportEquipment, 'EQ:' + paid.code + ':1');
  assert.strictEqual(rec.supportEquipmentAmount, paid.unitPriceJpy);
  assert.strictEqual(rec.priceAmount, rec.supportRoomAmount + rec.supportStaffAmount + paid.unitPriceJpy, '1回のお支払い額に機材料金を含む');
  var received = ctx.mailApp._sentEmails.filter(function (m) { return m.subject.indexOf('承認待ち') !== -1; })[0];
  assert.ok(received.body.indexOf('有料機材: ' + paid.label) !== -1 && received.body.indexOf('有料機材料金: ') !== -1, received.body);
  ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date('2026-12-06T09:00:00+09:00'));
  var approved = ctx.mailApp._sentEmails[ctx.mailApp._sentEmails.length - 1];
  assert.ok(approved.body.indexOf('部屋料金・スタッフ対応料金・有料機材料金の合計') !== -1);
  var normal = book(ctx, { plan: '', supportServices: undefined, paymentMethod: '現金', startTime: '18:00', durationMinutes: 60, supportEquipment: eq });
  assert.strictEqual(normal.success, false);
  assert.strictEqual(normal.error.code, 'OPTIONS_NOT_AVAILABLE');
  var bad = book(ctx, { supportEquipment: { NOPE_CODE: 1 }, startTime: '15:00' });
  assert.strictEqual(bad.success, false);
});

test('有料機材: 見積りAPIは機材パラメータ（CODE:数量,...）を共通カタログで計算し、カタログAPI（mens）が機材一覧を返す。不正な形式は拒否', function () {
  var ctx = setup({ members: MEMBER });
  var paid = CATALOG_JSON.rental.filter(function (r) { return r.unitPriceJpy > 0 && !r.freeWhenWith && r.stock >= 2; })[0];
  var ok = ctx.sandbox.handleEstimatePrice_({ brand: 'mens', date: WEEKDAY, durationMinutes: '120', plan: PLAN, supportServices: 'SETUP', supportEquipment: paid.code + ':2' }, undefined);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.price.equipmentAmount, paid.unitPriceJpy * 2);
  assert.strictEqual(ok.price.amount, 2400 + 3000 + paid.unitPriceJpy * 2);
  var bad = ctx.sandbox.handleEstimatePrice_({ brand: 'mens', date: WEEKDAY, durationMinutes: '120', plan: PLAN, supportServices: 'SETUP', supportEquipment: 'x;y' }, undefined);
  assert.strictEqual(bad.success, false);
  var catalog = ctx.sandbox.BookingOptions.buildCatalog('mens', ctx.sandbox.BookingConfig.getOptionsConfig());
  assert.ok(Array.isArray(catalog.supportEquipment) && catalog.supportEquipment.length === CATALOG_JSON.rental.length + CATALOG_JSON.freeSelf.filter(function (f) { return f.selectable === true; }).length);
  var item = catalog.supportEquipment.filter(function (e) { return e.code === paid.code; })[0];
  assert.strictEqual(item.unitPriceJpy, paid.unitPriceJpy, 'カタログと同額（複製しない）');
  assert.strictEqual(item.stock, paid.stock);
  assert.strictEqual(ctx.sandbox.BookingOptions.buildCatalog('snb', ctx.sandbox.BookingConfig.getOptionsConfig()).supportEquipment, undefined, 'SNBには出さない');
});

test('有料機材: フロントは数量だけを送り（金額は送らない）、機材を付けないときはキー自体を付けない。予約フォームに機材欄がある', function () {
  var base = { brand: 'mens', customerType: 'returning', date: SATURDAY, startTime: '10:00', durationMinutes: 180, name: 'a', email: EMAIL, people: '2名', purpose: 'x', paymentMethod: CARD, plan: PLAN, supportServices: 'SETUP' };
  assert.deepStrictEqual(Logic.buildCreateBookingPayload(Object.assign({}, base, { supportEquipment: { COB_BICOLOR: 2 } })).supportEquipment, { COB_BICOLOR: 2 });
  assert.strictEqual('supportEquipment' in Logic.buildCreateBookingPayload(Object.assign({}, base, { supportEquipment: {} })), false);
  var inc = read('_includes/booking_app_ja.html');
  assert.ok(inc.indexOf('id="ba-photo-support-equipment"') !== -1 && inc.indexOf('共通の機材カタログ') !== -1);
});
