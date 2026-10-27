/*
 * SNB mens限定「土日祝4時間シャワーパック 6,500円」（Issue #586）のテスト。
 *
 * - 料金正本（BookingPricing.gs）: mens・土日祝・4時間ちょうど・2026/12/1以降の組み合わせだけ6,500円の固定価格
 * - 既存料金（通常4時間9,000円・ペアパック・単体シャワー1,000円）は変更しない
 * - 予約作成: 明示選択・actual membership必須・シャワー申込必須・ペアパック自動適用で上書きしない
 * - シャワー二重加算なし: パック予約のシャワー注文は0円（承認で支払いなし確定）。単体シャワーの重複・Checkoutを防ぐ
 * - フロント（booking-logic.js）の表示制御と、サーバー正本との値の一致
 *
 * Stripe・Sheets・Calendarはすべてスタブ/fixtureで、本番へは一切アクセスしない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var memberProof = require('./helpers/booking-member-proof');
var Logic = require('../scripts/booking-logic.js');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs',
  'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'EquipmentCatalog.gs',
  'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs',
  'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs', 'BookingMailTemplates.gs',
  'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs', 'BookingRepository.gs', 'AdminNotifier.gs',
  'BookingAdminAlerts.gs', 'BookingReschedule.gs', 'BookingMemberVerification.gs', 'Code.gs'
];

var EMAIL = 'taro@example.com';
var DENIED_CODE = 'MEMBER_BENEFIT_NOT_AVAILABLE';
var PACK = 'mens_weekend_shower_4h';
var NOW_DEC = new Date('2026-12-05T12:00:00+09:00');

/* 2026-12-07(月)=平日、2026-12-12(土)・2026-12-13(日)=土日、2027-01-11(月)=成人の日（祝日）、2026-11-28(土)=提供開始前。 */
var WEEKDAY = '2026-12-07';
var SATURDAY = '2026-12-12';
var SUNDAY = '2026-12-13';
var HOLIDAY_MONDAY = '2027-01-11';
var BEFORE_START_SATURDAY = '2026-11-28';

function loadPricing() {
  return loadBookingSandbox(['JapaneseHolidays.gs', 'BookingPricing.gs', 'BookingOptions.gs', 'MembershipRules.gs', 'Config.gs'], {}).BookingPricing;
}

function priceOf(P, extra) {
  return P.computeBookingPrice(Object.assign({ brand: 'mens', date: SATURDAY, durationMinutes: 240, generation: 'V2', plan: PACK }, extra || {}));
}

// ============================================================================
// 料金正本
// ============================================================================

test('シャワーパック料金: mens・土日祝・4時間・パック指定は6,500円（税込の固定価格）。祝日の月曜も土日祝扱い', function () {
  var P = loadPricing();
  [SATURDAY, SUNDAY, HOLIDAY_MONDAY].forEach(function (date) {
    var r = priceOf(P, { date: date });
    assert.strictEqual(r.valid, true, date + ' ' + JSON.stringify(r));
    assert.strictEqual(r.price.amount, 6500, date);
    assert.strictEqual(r.price.plan, PACK);
    assert.strictEqual(r.price.tier, 'MEMBER');
    assert.strictEqual(r.price.dayType, 'WEEKEND_HOLIDAY');
  });
  assert.strictEqual(P.SHOWER_PACK_PRICE, 6500);
  assert.strictEqual(P.isShowerPack(PACK), true);
  assert.strictEqual(P.isMemberPlan(PACK), true);
  assert.strictEqual(P.planLabel(PACK), 'SNB mens 土日祝4時間シャワーパック');
});

test('シャワーパック料金: 通常料金・ペアパック・単体シャワー1,000円の金額は変更しない（パックの6,500円は別商品）', function () {
  var P = loadPricing();
  var normal = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 240, generation: 'V2' });
  assert.strictEqual(normal.price.amount, 9000, 'mensの通常4時間（土日祝・MEMBER料金）');
  assert.strictEqual(normal.price.plan, '');
  var weekday = P.computeBookingPrice({ brand: 'mens', date: WEEKDAY, durationMinutes: 240, generation: 'V2' });
  assert.strictEqual(weekday.price.amount, 7000);
  var snb = P.computeBookingPrice({ brand: 'snb', date: SATURDAY, durationMinutes: 240, generation: 'V2', isMember: false });
  assert.strictEqual(snb.price.amount, 10000, '通常SNBの一般4時間');
  var pair = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 180, generation: 'V2', plan: 'member_pair_3h' });
  assert.strictEqual(pair.price.amount, 6000);
  var pairWeekday = P.computeBookingPrice({ brand: 'mens', date: WEEKDAY, durationMinutes: 180, generation: 'V2', plan: 'member_pair_3h' });
  assert.strictEqual(pairWeekday.price.amount, 5000);
  var BO = loadBookingSandbox(['BookingOptions.gs', 'MembershipRules.gs', 'Config.gs', 'EquipmentCatalog.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs'], {}).BookingOptions;
  assert.strictEqual(BO.SHOWER_PRICE_JPY, 1000, '単体シャワー');
});

test('シャワーパック料金: 平日は成立しない（6,500円にならない）', function () {
  var P = loadPricing();
  var r = priceOf(P, { date: WEEKDAY });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.error.code, 'PLAN_DAY_INVALID');
});

test('シャワーパック料金: 4時間ちょうど以外（1〜3時間・5時間以上・端数）は適用しない', function () {
  var P = loadPricing();
  [60, 120, 180, 210, 270, 300, 360].forEach(function (minutes) {
    var r = priceOf(P, { durationMinutes: minutes });
    assert.strictEqual(r.valid, false, String(minutes));
    assert.strictEqual(r.error.code, 'PLAN_DURATION_INVALID', String(minutes));
  });
});

test('シャワーパック料金: 通常SNB・Studio Xでは適用しない（通常料金へ黙って倒さない）', function () {
  var P = loadPricing();
  ['snb', 'studio_x'].forEach(function (brand) {
    var r = priceOf(P, { brand: brand });
    assert.strictEqual(r.valid, false, brand);
    assert.strictEqual(r.error.code, 'PLAN_NOT_AVAILABLE', brand);
  });
});

test('シャワーパック料金: 提供開始は利用日が2026/12/1以降（シャワーと同じ。12/1は可・11/30以前は不可）。料金世代は問わない', function () {
  var P = loadPricing();
  assert.strictEqual(priceOf(P, { date: BEFORE_START_SATURDAY }).error.code, 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(priceOf(P, { date: '2026-12-05', generation: 'V1' }).price.amount, 6500);
  assert.strictEqual(P.isShowerPackAvailableOnDate('2026-12-01'), true);
  assert.strictEqual(P.isShowerPackAvailableOnDate('2026-11-30'), false);
  assert.strictEqual(P.isShowerPackAvailableOnDate('2026/12/05'), false);
  assert.strictEqual(P.isShowerPackAvailableOnDate(undefined), false);
});

test('シャワーパック料金: isMember・価格overrideの入力に左右されない。未知のプラン名は拒否', function () {
  var P = loadPricing();
  assert.strictEqual(priceOf(P, { isMember: false }).price.amount, 6500);
  assert.strictEqual(priceOf(P, { isMember: true }).price.amount, 6500);
  assert.strictEqual(priceOf(P, { plan: 'mens_weekend_shower_5h' }).error.code, 'INVALID_PLAN');
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
  var ctx = { sandbox: sandbox, mailApp: mailApp, stripeCalls: stripeCalls, sheets: spreadsheetsById.ss1, members: o.members || {}, lookups: [], proofs: {} };
  sandbox.MemberRepository.isMemberForMonth = function (email, month) {
    ctx.lookups.push({ email: email, month: month });
    return (ctx.members[String(email).toLowerCase()] || []).indexOf(month) !== -1;
  };
  sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    return sandbox.MemberRepository.isMemberForMonth(email, String(date).substring(0, 7));
  };
  return ctx;
}

var SHOWER_OPTIONS = { shower: true, showerScheduleConfirmed: true };

function packPayload(overrides) {
  return Object.assign({
    brand: 'mens', customerType: 'returning', date: SATURDAY, startTime: '10:00', durationMinutes: 240,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', isMember: false, plan: PACK, options: SHOWER_OPTIONS
  }, overrides || {});
}

function book(ctx, overrides, now) {
  var at = now || NOW_DEC;
  var payload = packPayload(overrides);
  if (payload.memberProof === null) delete payload.memberProof;
  else if (payload.memberProof === undefined) payload.memberProof = memberProof.proofFor(ctx.proofs, ctx.sandbox, ctx.mailApp, payload.email, at);
  return ctx.sandbox.BookingRepository.createBooking(payload, at);
}

function bookingRecord(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

function showerOrders(ctx, bookingId) {
  return ctx.sandbox.OptionOrderRepository.listByBookingId(bookingId).map(function (row) { return row.record; });
}

var MEMBER = { [EMAIL]: ['2026-12'] };

test('予約作成: actual membership＋シャワー申込で土日祝4時間パックを6,500円で予約でき、プラン識別子を保存する', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.price.amount, 6500);
  assert.strictEqual(r.price.plan, PACK);
  var rec = bookingRecord(ctx, r.bookingId);
  assert.strictEqual(rec.planCode, PACK);
  assert.strictEqual(rec.priceAmount, 6500);
  assert.strictEqual(rec.membershipStatus, 'ACTIVE');
  assert.strictEqual(rec.priceDayType, 'WEEKEND_HOLIDAY');
});

test('予約作成: パック予約のシャワー注文は0円（1,000円を二重加算しない）で、事前確認（承認待ち）から始まる', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  assert.strictEqual(r.success, true, JSON.stringify(r));
  var orders = showerOrders(ctx, r.bookingId);
  assert.strictEqual(orders.length, 1);
  assert.deepStrictEqual(Array.from(orders[0].items), ['SHOWER']);
  assert.strictEqual(orders[0].category, 'MEMBER_SERVICE');
  assert.strictEqual(orders[0].amountJpy, 0, 'シャワー分は6,500円に含まれる');
  assert.strictEqual(orders[0].status, 'PENDING_APPROVAL', '事前確認は省略しない');
  assert.strictEqual(orders[0].approvalStatus, 'PENDING_APPROVAL');
  /* 部屋料金とシャワー注文の請求額の合計が6,500円（シャワー分の追加請求なし）。 */
  assert.strictEqual(bookingRecord(ctx, r.bookingId).priceAmount + orders[0].amountJpy, 6500);
});

test('予約作成: 通常のシャワー付き予約（パックなし）は従来どおり部屋料金＋シャワー1,000円の別建て', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { plan: '', durationMinutes: 240 });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.price.amount, 9000);
  var orders = showerOrders(ctx, r.bookingId);
  assert.strictEqual(orders.length, 1);
  assert.strictEqual(orders[0].amountJpy, 1000);
});

test('予約作成: actual membershipが無ければ拒否（mensの部屋料金優遇＝priceIsMemberでは代用できない）。予約は作られない', function () {
  var ctx = setup({ members: {} });
  var r = book(ctx, { isMember: true });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, DENIED_CODE);
  assert.ok(ctx.sheets.Bookings === undefined || ctx.sheets.Bookings._rows.length <= 1, '予約行を作らない');
});

test('予約作成: 利用月に会員資格が無い（翌月分が未払い）場合も拒否', function () {
  var ctx = setup({ members: { [EMAIL]: ['2026-12'] } });
  var r = book(ctx, { date: HOLIDAY_MONDAY });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, DENIED_CODE);
});

test('予約作成: メールOTPの確認済み証明が無ければ、会員台帳を見ずに確認を要求する（V2）', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { memberProof: null });
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  assert.strictEqual(ctx.lookups.length, 0);
});

test('予約作成: 平日・4時間以外・通常SNB・Studio X・提供開始前は拒否（通常料金へ倒さない）', function () {
  var ctx = setup({ members: MEMBER });
  assert.strictEqual(book(ctx, { date: WEEKDAY }).error.code, 'PLAN_DAY_INVALID');
  assert.strictEqual(book(ctx, { durationMinutes: 180 }).error.code, 'PLAN_DURATION_INVALID');
  assert.strictEqual(book(ctx, { durationMinutes: 300 }).error.code, 'PLAN_DURATION_INVALID');
  assert.strictEqual(book(ctx, { brand: 'snb' }).error.code, 'PLAN_NOT_AVAILABLE');
  assert.strictEqual(book(ctx, { brand: 'studio_x' }).success, false);
  assert.strictEqual(book(ctx, { date: BEFORE_START_SATURDAY }, new Date('2026-11-20T12:00:00+09:00')).error.code, 'PLAN_NOT_AVAILABLE');
  assert.ok(ctx.sheets.Bookings === undefined || ctx.sheets.Bookings._rows.length <= 1, '拒否した申込は予約行を作らない');
});

test('予約作成: シャワーの申込が無い（options省略・シャワー未選択・日程調整の確認なし）パック予約は作らない', function () {
  var ctx = setup({ members: MEMBER });
  var none = book(ctx, { options: undefined });
  assert.strictEqual(none.success, false);
  assert.strictEqual(none.error.code, 'SHOWER_PACK_SHOWER_REQUIRED');
  var off = book(ctx, { options: { shower: false } });
  assert.strictEqual(off.error.code, 'SHOWER_PACK_SHOWER_REQUIRED');
  var unconfirmed = book(ctx, { options: { shower: true, showerScheduleConfirmed: false } });
  assert.strictEqual(unconfirmed.success, false);
  assert.strictEqual(unconfirmed.error.code, 'SHOWER_SCHEDULE_CONFIRMATION_REQUIRED');
  assert.ok(ctx.sheets.Bookings === undefined || ctx.sheets.Bookings._rows.length <= 1);
});

test('予約作成: パックを明示選択した予約は、ペアパックの自動適用（autoPairPack）で上書きされない', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { autoPairPack: true, people: '2名', durationMinutes: 240 });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.price.plan, PACK);
  assert.strictEqual(r.price.amount, 6500);
});

test('予約作成: パックは1〜2名限定。1名・2名は成立し、3名以上・形式不正は拒否（予約は作られない）', function () {
  var ctx = setup({ members: MEMBER });
  ['1名', '2名'].forEach(function (people) {
    var ok = book(ctx, { people: people, startTime: people === '1名' ? '10:00' : '16:00' });
    assert.strictEqual(ok.success, true, people + JSON.stringify(ok));
    assert.strictEqual(ok.price.amount, 6500);
  });
  var before = ctx.sheets.Bookings._rows.length;
  ['3名', '4名', '5名以上・要相談', '', '二人'].forEach(function (people) {
    var r = book(ctx, { people: people, date: SUNDAY });
    assert.strictEqual(r.success, false, people);
    assert.ok(r.error.code === 'SHOWER_PACK_PEOPLE_EXCEEDED' || r.error.code === 'INVALID_PEOPLE', people + ' ' + r.error.code);
  });
  assert.strictEqual(book(ctx, { people: '3名', date: SUNDAY }).error.code, 'SHOWER_PACK_PEOPLE_EXCEEDED');
  assert.strictEqual(ctx.sheets.Bookings._rows.length, before, '拒否した申込は予約行を作らない');
  assert.strictEqual(ctx.sandbox.BookingPricing.isShowerPackPeople('2名'), true);
  assert.strictEqual(ctx.sandbox.BookingPricing.isShowerPackPeople('3名'), false);
  /* パックを使わない通常予約は3名以上でも従来どおり。 */
  var normal = book(ctx, { people: '3名', plan: '', options: undefined, date: SUNDAY });
  assert.strictEqual(normal.success, true, JSON.stringify(normal));
});

// ============================================================================
// シャワー注文: 承認・重複・二重決済の防止
// ============================================================================

test('パック予約のシャワー: 承認すると支払いなしで確定（AWAITING_PAYMENT/Checkoutを経由しない）。承認時も会員資格を再確認する', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  var order = showerOrders(ctx, r.bookingId)[0];
  var OOS = ctx.sandbox.OptionOrderService;

  ctx.members = {};
  var denied = OOS.approveOrder(order.optionOrderId, NOW_DEC);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);

  ctx.members = MEMBER;
  var approved = OOS.approveOrder(order.optionOrderId, NOW_DEC);
  assert.strictEqual(approved.success, true, JSON.stringify(approved));
  assert.strictEqual(approved.order.status, 'CONFIRMED');
  assert.strictEqual(approved.order.approvalStatus, 'APPROVED');
  assert.strictEqual(approved.order.paymentStatus, 'NOT_REQUIRED');
  assert.strictEqual(showerOrders(ctx, r.bookingId)[0].amountJpy, 0);
});

test('パック予約のシャワー: Checkoutは開始できず（0円）、Stripeは呼ばれない。承認前も同様', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  var order = showerOrders(ctx, r.bookingId)[0];
  var OOS = ctx.sandbox.OptionOrderService;
  var early = OOS.startOptionCheckout(r.bookingId, EMAIL, order.optionOrderId, NOW_DEC);
  assert.strictEqual(early.success, false);
  OOS.approveOrder(order.optionOrderId, NOW_DEC);
  var after = OOS.startOptionCheckout(r.bookingId, EMAIL, order.optionOrderId, NOW_DEC);
  assert.strictEqual(after.success, false);
  assert.strictEqual(ctx.stripeCalls.length, 0);
});

test('パック予約のシャワー: 単体シャワーの重複申込は拒否（有効な注文がある間）。再申込しても1,000円にならない', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  var OOS = ctx.sandbox.OptionOrderService;
  var dup = OOS.submitAddonOptions(r.bookingId, EMAIL, SHOWER_OPTIONS, NOW_DEC);
  assert.strictEqual(dup.success, false);
  assert.strictEqual(dup.error.code, 'DUPLICATE_OPTION');

  /* 運営が対応不可として不承認にした後に再申込しても、パック予約のシャワーは0円のまま（1,000円の請求にならない）。 */
  var order = showerOrders(ctx, r.bookingId)[0];
  assert.strictEqual(OOS.declineOrder(order.optionOrderId, '対応不可', NOW_DEC).success, true);
  var again = OOS.submitAddonOptions(r.bookingId, EMAIL, SHOWER_OPTIONS, NOW_DEC);
  assert.strictEqual(again.success, true, JSON.stringify(again));
  assert.strictEqual(again.orders[0].amountJpy, 0);
});

test('パックなしの通常予約への単体シャワー後付けは従来どおり1,000円', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, { plan: '', options: undefined, durationMinutes: 240 });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  var add = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, SHOWER_OPTIONS, NOW_DEC);
  assert.strictEqual(add.success, true, JSON.stringify(add));
  assert.strictEqual(add.orders[0].amountJpy, 1000);
});

test('承認メール: パックのシャワーは「追加のお支払い不要」と案内し、決済ページを案内しない', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  var order = showerOrders(ctx, r.bookingId)[0];
  var before = ctx.mailApp._sentEmails.length;
  ctx.sandbox.OptionOrderService.approveOrder(order.optionOrderId, NOW_DEC);
  var mail = ctx.mailApp._sentEmails.slice(before).filter(function (m) { return m.to === EMAIL; })[0];
  assert.ok(mail, '承認メールを送る');
  assert.ok(/追加のお支払いは不要/.test(mail.body));
  assert.ok(!/お支払いはこちら/.test(mail.body));
  assert.ok(!/1,000円/.test(mail.body));
});

// ============================================================================
// 管理者操作・見積り
// ============================================================================

test('管理者手動確定: パック予約は actual membership を再確認する。Stripe決済済みのWebhook確定は覆さない', function () {
  var ctx = setup({ members: MEMBER });
  var r = book(ctx, {});
  assert.strictEqual(r.success, true, JSON.stringify(r));
  ctx.members = {};
  var denied = ctx.sandbox.BookingRepository.confirmBooking(r.bookingId);
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, DENIED_CODE);
  assert.strictEqual(bookingRecord(ctx, r.bookingId).status, 'PENDING');
  var viaWebhook = ctx.sandbox.BookingRepository.confirmBooking(r.bookingId, { writeGuard: function () { return true; } });
  assert.strictEqual(viaWebhook.success, true, JSON.stringify(viaWebhook));
});

test('見積りAPI: パックの見積りは会員台帳を照会しない。通常SNB・平日・3時間はエラー', function () {
  var ctx = setup({ members: MEMBER });
  function est(params) {
    return JSON.parse(ctx.sandbox.doGet({ parameter: Object.assign({ action: 'estimatePrice', brand: 'mens', date: SATURDAY, durationMinutes: '240', plan: PACK }, params) }).text);
  }
  var ok = est({});
  /* 実行時刻が12/1より前でも、パックは利用日基準のため料金世代に依らず見積もれる。 */
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.price.amount, 6500);
  assert.strictEqual(ok.price.plan, PACK);
  assert.strictEqual(est({ date: WEEKDAY }).success, false);
  assert.strictEqual(est({ durationMinutes: '180' }).success, false);
  assert.strictEqual(est({ brand: 'snb' }).success, false);
  assert.strictEqual(ctx.lookups.length, 0);
});

// ============================================================================
// フロント（表示制御）とサーバー正本の一致
// ============================================================================

test('フロント: シャワーパックはmensかつ利用日が2026/12/1以降・4時間ちょうどのときだけ選べる。通常SNB・Studio Xには出さない', function () {
  assert.strictEqual(Logic.showerPackAvailableOnDate('mens', '2026-12-01'), true);
  assert.strictEqual(Logic.showerPackAvailableOnDate('mens', '2026-11-30'), false);
  assert.strictEqual(Logic.showerPackAvailableOnDate('mens', ''), false);
  assert.strictEqual(Logic.showerPackAvailableOnDate('mens', '2026/12/05'), false);
  assert.strictEqual(Logic.showerPackAvailableOnDate('snb', '2026-12-12'), false);
  assert.strictEqual(Logic.showerPackAvailableOnDate('studio_x', '2026-12-12'), false);
  assert.strictEqual(Logic.showerPackPeopleAllowed('1名'), true);
  assert.strictEqual(Logic.showerPackPeopleAllowed('2名'), true);
  assert.strictEqual(Logic.showerPackPeopleAllowed(''), true, '未選択は人数の必須チェックに任せる');
  ['3名', '4名', '5名以上・要相談'].forEach(function (p) { assert.strictEqual(Logic.showerPackPeopleAllowed(p), false, p); });
  assert.strictEqual(Logic.showerPackDurationAllowed(240), true);
  [60, 120, 180, 300, 360, 0, NaN].forEach(function (m) { assert.strictEqual(Logic.showerPackDurationAllowed(m), false, String(m)); });
});

test('フロント: プラン識別子・時間・提供開始日はサーバー正本（BookingPricing.gs）と一致する', function () {
  var P = loadPricing();
  assert.strictEqual(Logic.SHOWER_PACK_PLAN_CODE, P.PLAN.MENS_WEEKEND_SHOWER_4H);
  assert.strictEqual(Logic.SHOWER_PACK_DURATION_MINUTES, P.SHOWER_PACK_HOURS * 60);
  assert.strictEqual(P.SHOWER_PACK_START_DATE, '2026-12-01');
  assert.strictEqual(Logic.showerPackAvailableOnDate('mens', P.SHOWER_PACK_START_DATE), true);
  assert.strictEqual(Logic.showerPackAvailableOnDate('mens', '2026-11-30'), false);
});

test('フロント: 予約ペイロードはパック選択時のみplanを送る。金額・会員資格は送らない', function () {
  var base = {
    brand: 'mens', customerType: 'returning', date: SATURDAY, startTime: '10:00', durationMinutes: 240, name: 'a', email: EMAIL,
    phone: '090', people: '2名', purpose: 'x', paymentMethod: '現金', note: '', isMember: false
  };
  var withPack = Logic.buildCreateBookingPayload(Object.assign({ plan: PACK, shower: true, showerScheduleConfirmed: true }, base));
  assert.strictEqual(withPack.plan, PACK);
  assert.deepStrictEqual(withPack.options, { shower: true, showerScheduleConfirmed: true });
  assert.strictEqual('priceAmount' in withPack, false);
  assert.strictEqual('amount' in withPack, false);
  var without = Logic.buildCreateBookingPayload(Object.assign({ plan: '' }, base));
  assert.strictEqual('plan' in without, false);
});

test('フロント: 料金サマリーはパック名を示し、シャワーは「パック料金に含まれる」として別の1,000円行を出さない', function () {
  var info = Logic.appliedRateInfo({ plan: PACK, tier: 'MEMBER', brand: 'mens' }, 'ja');
  assert.strictEqual(info.kind, 'plan');
  assert.ok(/シャワーパック/.test(info.value) && /SNB MEMBER限定/.test(info.value));
  var included = Logic.showerExtraInfo(1000, 'ja', true);
  assert.ok(/含まれ/.test(included.value));
  assert.ok(!/1,000/.test(included.text) && !/¥1,000/.test(included.text), 'シャワー1,000円を別行に出さない');
  assert.ok(included.notes.join('').indexOf('別途のお支払いはありません') !== -1);
  var normal = Logic.showerExtraInfo(1000, 'ja');
  assert.ok(/1,000/.test(normal.value), '通常のシャワーは従来どおり1,000円');
});

test('フロント: パックのエラーコードは利用者向け文言に変換され、選択を直せば解消するエラーとして扱う', function () {
  ['PLAN_DAY_INVALID', 'SHOWER_PACK_SHOWER_REQUIRED', 'SHOWER_PACK_PEOPLE_EXCEEDED'].forEach(function (code) {
    ['ja', 'en'].forEach(function (locale) {
      var text = Logic.messageForErrorCode(code, locale, 'mens');
      assert.ok(text && text.indexOf(code) === -1, code + ' ' + locale);
    });
  });
});

test('公開コピー: 新パックの説明（予約フォーム・会員特典・mens料金案内）に「1〜2名限定」を明示し、予約フォーム・会員特典にはシャワー2名までも明示する', function () {
  var fs = require('node:fs');
  var path = require('node:path');
  function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }
  var form = read('_includes/booking_app_ja.html');
  var packLabel = form.slice(form.indexOf('id="ba-plan-shower-pack"'));
  packLabel = packLabel.slice(0, packLabel.indexOf('</label>'));
  assert.ok(packLabel.indexOf('1〜2名限定') !== -1 && packLabel.indexOf('同一予約で2名まで') !== -1, '予約フォーム');
  var benefits = read('_includes/membership_benefits_ja.html');
  var card = benefits.slice(benefits.indexOf('id="shower-pack"'), benefits.indexOf('id="shower"'));
  assert.ok(card.indexOf('1〜2名') !== -1 && card.indexOf('同一予約で2名まで') !== -1, '会員特典');
  assert.ok(card.indexOf('3名以上でもパック料金は変わりません') === -1, '3名以上でも成立するとは書かない');
  var mens = read('mens/index.html');
  var para = mens.slice(mens.indexOf('土日祝4時間シャワーパック'));
  para = para.slice(0, para.indexOf('</p>'));
  assert.ok(para.indexOf('1〜2名限定') !== -1, 'mens料金案内');
});
