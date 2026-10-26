/*
 * 6時間貸切ベースプラン（Issue #488 / #492。常設）のテスト。Stripe・Sheets・Calendarはすべて
 * スタブで、本番へは一切アクセスしない。
 *
 * - 料金（純粋ロジック）: 6時間6,000円固定・Studio Xのみ・日付の制限なし・通常料金表は不変
 * - createBooking: 任意の日に選べる・人数/時間/ブランド・通常予約との二重販売防止・識別（planCode）
 * - 見積りAPI（estimatePrice）。対象日API（eventPlan）・EventPlanDatesは廃止
 * - 日程変更: 6時間を外れる変更は拒否、任意の予約可能日への変更は6,000円を保持
 * - メール・管理者通知・Booking Adminでのプラン識別
 * - 公式サイト/予約フォームの掲載内容（誤認防止表現・禁止表現）
 */
'use strict';

var fs = require('node:fs');
var path = require('node:path');
var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var futureDate = require('./helpers/future-date');
var manifest = require('./helpers/booking-deployment-manifest');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var PLAN = 'osu_cosplay_base_6h';
var PLAN_LABEL = 'Studio X｜6時間貸切ベースプラン';
var SPREADSHEET_ID = 'ss1';
var EMAIL = 'taro@example.com';

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs',
  'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'EquipmentCatalog.gs',
  'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs',
  'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs',
  'BookingRepository.gs', 'AdminNotifier.gs', 'BookingAdminAlerts.gs', 'BookingReschedule.gs', 'BookingRefund.gs',
  'BookingAdmin.gs', 'BookingAdminWeb.gs', 'Code.gs'
];

/* 実行日から独立した未来日（JST）。公開経路は30日先まで（Issue #480）のため30日以内に置く。常設プランのため、どの日でも選べる。 */
var EVENT_DAY = futureDate.futureJstDate(20);
var EVENT_DAY_2 = futureDate.futureJstDate(27);
var OTHER_DAY = futureDate.futureJstDate(21);

function setup() {
  var calendarsById = { cal1: { events: [] } };
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = {
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID,
    BOOKING_MAIL_DISPLAY_NAME: 'Studio X', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000'
  };
  var mailApp = stubs.createMailAppStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp,
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('このテストではStripeを呼ばない'); }),
    Logger: stubs.createLoggerStub(), ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, mailApp: mailApp, calendarsById: calendarsById, spreadsheet: sandbox.SpreadsheetApp.openById(SPREADSHEET_ID) };
}

function payload(overrides) {
  return Object.assign({
    brand: 'studio_x', customerType: 'returning', date: EVENT_DAY, startTime: '10:00', durationMinutes: 360,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '4名', purpose: 'コスプレ撮影',
    paymentMethod: '現金', note: '', source: 'test', isMember: false, plan: PLAN
  }, overrides || {});
}

function book(ctx, overrides) {
  return ctx.sandbox.BookingRepository.createBooking(payload(overrides));
}

function record(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

function calendarEventCount(ctx) {
  return ctx.sandbox.CalendarApp.getCalendarById('cal1').getEvents(new Date('2000-01-01'), new Date('2100-01-01')).length;
}

// ============================================================================
// 料金（純粋ロジック）
// ============================================================================

test('料金: 6時間はStudio Xで日付に関わらず6,000円固定。会員区分・料金世代・曜日区分に依存せず、会員特典扱いにもならない', function () {
  var P = setup().sandbox.BookingPricing;
  ['V1', 'V2'].forEach(function (generation) {
    [true, false].forEach(function (isMember) {
      [EVENT_DAY, EVENT_DAY_2].forEach(function (date) {
        var r = P.computeBookingPrice({ brand: 'studio_x', date: date, durationMinutes: 360, generation: generation, isMember: isMember, plan: PLAN });
        assert.strictEqual(r.valid, true, JSON.stringify(r));
        assert.strictEqual(r.price.amount, 6000);
        assert.strictEqual(r.price.plan, PLAN);
        assert.strictEqual(r.price.tier, 'GENERAL', '会員料金（MEMBER）ではない');
        assert.strictEqual(r.price.isMember, false, '会員特典ではない');
      });
    });
  });
  assert.strictEqual(P.planLabel(PLAN), PLAN_LABEL);
  assert.strictEqual(P.isEventPlan(PLAN), true);
  assert.strictEqual(P.isEventPlan('member_pair_3h'), false);
});

test('料金: 日付の制限は無く（対象日の指定不要）、Studio X以外・6時間以外は通常料金へ倒さず拒否する', function () {
  var P = setup().sandbox.BookingPricing;
  function price(over) {
    return P.computeBookingPrice(Object.assign({ brand: 'studio_x', date: EVENT_DAY, durationMinutes: 360, generation: 'V2', plan: PLAN }, over));
  }
  [EVENT_DAY, OTHER_DAY, EVENT_DAY_2].forEach(function (date) {
    var r = price({ date: date });
    assert.strictEqual(r.valid, true, date + ' ' + JSON.stringify(r));
    assert.strictEqual(r.price.amount, 6000);
  });
  assert.strictEqual(price({ generation: 'V1' }).price.amount, 6000, '料金世代に依存しない');
  ['snb', 'mens'].forEach(function (brand) {
    assert.strictEqual(price({ brand: brand }).error.code, 'PLAN_NOT_AVAILABLE');
  });
  [60, 180, 300, 420, 480].forEach(function (minutes) {
    assert.strictEqual(price({ durationMinutes: minutes }).error.code, 'PLAN_DURATION_INVALID', minutes + '分');
  });
  assert.strictEqual(P.normalizePlan('osu_cosplay_base_6h'), PLAN);
  assert.strictEqual(P.normalizePlan('osu_cosplay_base_7h'), null, '未知のプランは拒否（通常料金へ倒さない）');
});

test('通常のStudio X料金は変更されない（プラン指定なしの料金表・6時間料金・人数追加なし）', function () {
  var P = setup().sandbox.BookingPricing;
  function amount(date, minutes, generation, isMember) {
    return P.computeBookingPrice({ brand: 'studio_x', date: date, durationMinutes: minutes, generation: generation, isMember: isMember }).price.amount;
  }
  var cases = [EVENT_DAY, OTHER_DAY, EVENT_DAY_2];
  cases.forEach(function (date) {
    var r4 = amount(date, 240, 'V2', false);
    var r6 = amount(date, 360, 'V2', false);
    assert.ok(r6 > 6000, '通常の6時間料金は6,000円ではない: ' + date + ' ' + r6);
    assert.ok(r6 === r4 + 2 * 1200 || r6 === r4 + 2 * 1500, '通常の延長料金のまま');
  });
  var computed = P.computeBookingPrice({ brand: 'studio_x', date: EVENT_DAY, durationMinutes: 360, generation: 'V2' });
  assert.strictEqual(computed.price.plan, '', '通常予約にプランは付かない');
});

// ============================================================================
// createBooking: 対象日の強制・人数・時間・ブランド・識別
// ============================================================================

test('createBooking: 貸切ベースプランを選ぶと6時間6,000円で保存され、planCode・Calendarタグで識別できる', function () {
  var ctx = setup();
  var result = book(ctx);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.price.amount, 6000);
  assert.strictEqual(result.price.plan, PLAN);
  assert.strictEqual(result.durationMinutes, 360);
  var rec = record(ctx, result.bookingId);
  assert.strictEqual(rec.planCode, PLAN);
  assert.strictEqual(rec.priceAmount, 6000);
  assert.strictEqual(rec.priceTier, 'GENERAL');
  assert.strictEqual(rec.priceIsMember, false);
  assert.strictEqual(rec.endAt.getTime() - rec.startAt.getTime(), 6 * 3600000);
  var event = ctx.sandbox.CalendarApp.getCalendarById('cal1').getEventById(rec.calendarEventId);
  assert.strictEqual(event.getTag('planCode'), PLAN);
});

test('createBooking: 最大4名まで同一料金（1〜4名すべて6,000円）。5名以上は拒否', function () {
  ['1名', '2名', '3名', '4名'].forEach(function (people, i) {
    var ctx = setup();
    var r = book(ctx, { people: people, email: 'p' + i + '@example.com' });
    assert.strictEqual(r.success, true, people + ' ' + JSON.stringify(r));
    assert.strictEqual(r.price.amount, 6000);
  });
  var ctx2 = setup();
  var over = book(ctx2, { people: '5名以上・要相談' });
  assert.strictEqual(over.success, false);
  assert.strictEqual(over.error.code, 'EVENT_PLAN_PEOPLE_EXCEEDED');
  assert.strictEqual(calendarEventCount(ctx2), 0, '拒否時はCalendarへ何も作らない');
});

test('createBooking: 対象日の登録なしで、どの日でも貸切ベースプランを選べる（EventPlanDatesに依存しない）', function () {
  var ctx = setup();
  assert.strictEqual(ctx.sandbox.EventPlanRepository, undefined, 'EventPlanRepositoryは廃止');
  [EVENT_DAY, OTHER_DAY, EVENT_DAY_2].forEach(function (date, i) {
    var r = book(ctx, { date: date, email: 'd' + i + '@example.com' });
    assert.strictEqual(r.success, true, date + ' ' + JSON.stringify(r));
    assert.strictEqual(r.price.amount, 6000);
    assert.strictEqual(record(ctx, r.bookingId).planCode, PLAN);
  });
  assert.strictEqual(ctx.spreadsheet.getSheetByName('EventPlanDates'), null, '対象日シートを作らない');
});

test('createBooking: 6時間以外・Studio X以外は拒否。会員自己申告（isMember）は料金に影響しない', function () {
  var ctx = setup();
  assert.strictEqual(book(ctx, { durationMinutes: 180 }).error.code, 'PLAN_DURATION_INVALID');
  assert.strictEqual(book(ctx, { durationMinutes: 420 }).error.code, 'PLAN_DURATION_INVALID');
  ['snb', 'mens'].forEach(function (brand) {
    assert.strictEqual(book(ctx, { brand: brand }).error.code, 'PLAN_NOT_AVAILABLE', brand);
  });
  assert.strictEqual(book(ctx, { plan: 'osu_cosplay_base_8h' }).error.code, 'INVALID_PLAN');
  assert.strictEqual(calendarEventCount(ctx), 0);
  var ok = book(ctx, { isMember: true });
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.price.amount, 6000);
});

test('createBooking: プラン指定なしの通常予約は、通常料金で保存され6,000円は自動適用されない', function () {
  var ctx = setup();
  var r = book(ctx, { plan: undefined, durationMinutes: 360, isMember: false });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.notStrictEqual(r.price.amount, 6000);
  assert.strictEqual(r.price.plan, '');
  assert.strictEqual(record(ctx, r.bookingId).planCode, '');
  var event = ctx.sandbox.CalendarApp.getCalendarById('cal1').getEventById(record(ctx, r.bookingId).calendarEventId);
  assert.strictEqual(event.getTag('planCode'), null, '通常予約のCalendarにplanCodeタグは付けない');
});

// ============================================================================
// 二重販売防止
// ============================================================================

test('二重販売防止: 貸切ベースプランの6時間帯に、通常予約・別の貸切ベースプラン予約は入らない（同一Calendar・Lock内で判定）', function () {
  var ctx = setup();
  assert.strictEqual(book(ctx, { startTime: '10:00' }).success, true);
  /* 重なる通常予約（12:00開始・2時間） */
  var normal = book(ctx, { plan: undefined, startTime: '12:00', durationMinutes: 120, email: 'n@example.com' });
  assert.strictEqual(normal.success, false);
  assert.strictEqual(normal.error.code, 'SLOT_CONFLICT');
  /* 重なる別の貸切ベースプラン */
  var other = book(ctx, { startTime: '14:00', email: 'o@example.com' });
  assert.strictEqual(other.success, false);
  assert.strictEqual(other.error.code, 'SLOT_CONFLICT');
  assert.strictEqual(calendarEventCount(ctx), 1);
});

test('二重販売防止: 先に通常予約が入っている時間帯には貸切ベースプランを入れられない', function () {
  var ctx = setup();
  assert.strictEqual(book(ctx, { plan: undefined, startTime: '13:00', durationMinutes: 120 }).success, true);
  var plan = book(ctx, { startTime: '10:00', email: 'p@example.com' });
  assert.strictEqual(plan.success, false);
  assert.strictEqual(plan.error.code, 'SLOT_CONFLICT');
  assert.strictEqual(calendarEventCount(ctx), 1);
});

// ============================================================================
// 見積りAPI・案内API
// ============================================================================

function doGet(ctx, params) {
  return JSON.parse(ctx.sandbox.doGet({ parameter: params }).text);
}

test('estimatePrice: 任意の日で6,000円。6時間以外・Studio X以外は料金を返さない', function () {
  var ctx = setup();
  var base = { action: 'estimatePrice', brand: 'studio_x', date: EVENT_DAY, durationMinutes: '360', plan: PLAN };
  var ok = doGet(ctx, base);
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.price.amount, 6000);
  assert.strictEqual(ok.price.plan, PLAN);
  assert.strictEqual(doGet(ctx, Object.assign({}, base, { date: OTHER_DAY })).price.amount, 6000, '日付を問わない');
  assert.strictEqual(doGet(ctx, Object.assign({}, base, { durationMinutes: '180' })).error.code, 'PLAN_DURATION_INVALID');
  assert.strictEqual(doGet(ctx, Object.assign({}, base, { brand: 'snb' })).error.code, 'PLAN_NOT_AVAILABLE');
});

// ============================================================================
// Issue #496: 貸切ベースプランと追加オプションの併用不可（サーバー側）
// ============================================================================

var OPTIONS_SELECTION = { equipment: { STAND_260: 1 }, layouts: [], setupService: 'SELF', cleanupService: 'SELF', emailSupport: true };

test('Issue #496 createBooking: 貸切ベースプラン＋オプションは明示エラーで拒否し、Calendar/Sheetsへ何も書かない', function () {
  var ctx = setup();
  var rejected = book(ctx, { options: OPTIONS_SELECTION });
  assert.strictEqual(rejected.success, false);
  assert.strictEqual(rejected.error.code, 'EVENT_PLAN_OPTIONS_NOT_ALLOWED');
  assert.strictEqual(calendarEventCount(ctx), 0);
  var shower = book(ctx, { options: { shower: true } });
  assert.strictEqual(shower.error.code, 'EVENT_PLAN_OPTIONS_NOT_ALLOWED', '形式を問わずオプション指定は併用不可');
  assert.strictEqual(calendarEventCount(ctx), 0);
});

test('Issue #496 createBooking: オプション指定なし（未指定・null・空オブジェクト）の貸切ベースプランは従来どおり6,000円で成立する', function () {
  [undefined, null, {}].forEach(function (options, i) {
    var ctx = setup();
    var overrides = i === 0 ? {} : { options: options };
    var ok = book(ctx, overrides);
    assert.strictEqual(ok.success, true, JSON.stringify(ok));
    assert.strictEqual(ok.price.amount, 6000);
    assert.strictEqual(ok.options, undefined);
  });
});

test('Issue #496 createBooking: 通常のStudio X予約はオプションを従来どおり検証し、この併用不可の拒否にはならない', function () {
  var ctx = setup();
  var r = book(ctx, { plan: '', durationMinutes: 180, options: OPTIONS_SELECTION });
  assert.ok(!r.error || r.error.code !== 'EVENT_PLAN_OPTIONS_NOT_ALLOWED', JSON.stringify(r));
});

test('Issue #496 estimatePrice: オプション付きの貸切ベースプラン見積りは正常な見積りを返さない。オプション無しは6,000円のまま', function () {
  var ctx = setup();
  var base = { action: 'estimatePrice', brand: 'studio_x', date: EVENT_DAY, durationMinutes: '360', plan: PLAN };
  var rejected = doGet(ctx, Object.assign({}, base, { options: 'STAND_260' }));
  assert.strictEqual(rejected.success, false);
  assert.strictEqual(rejected.error.code, 'EVENT_PLAN_OPTIONS_NOT_ALLOWED');
  assert.strictEqual(doGet(ctx, base).price.amount, 6000);
  assert.strictEqual(doGet(ctx, Object.assign({}, base, { options: '' })).price.amount, 6000);
});

test('Issue #496 後付け申込: 貸切ベースプランの予約へは本人確認後でもオプションを追加できず、案内ページも受付不可にする', function () {
  var ctx = setup();
  var ok = book(ctx, {});
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  var addon = ctx.sandbox.OptionOrderService.submitAddonOptions(ok.bookingId, EMAIL, { emailSupport: true });
  assert.strictEqual(addon.success, false);
  assert.strictEqual(addon.error.code, 'EVENT_PLAN_OPTIONS_NOT_ALLOWED');
  var summary = ctx.sandbox.OptionOrderService.getCustomerSummary(ok.bookingId, EMAIL);
  assert.strictEqual(summary.acceptsOptions, false);
  assert.strictEqual(summary.acceptsOptionsReason, 'EVENT_PLAN_OPTIONS_NOT_ALLOWED');
});

test('対象日API（action=eventPlan）は廃止され、通常の空き状況応答にフォールバックする', function () {
  var ctx = setup();
  var body = doGet(ctx, { action: 'eventPlan', brand: 'studio_x' });
  assert.ok(!('plan' in body), '対象日・プラン情報を返さない');
  assert.strictEqual(ctx.sandbox.handleEventPlan_, undefined);
});

// ============================================================================
// メール・管理者通知・Booking Admin での識別
// ============================================================================

test('メール・管理者通知: プラン名と6,000円、有人クロークではない旨が出る。通常予約の本文には出ない', function () {
  var ctx = setup();
  var r = book(ctx);
  assert.strictEqual(r.success, true);
  var sent = ctx.mailApp._sentEmails;
  var texts = sent.map(function (m) { return m.subject + '\n' + (m.body || m.message || ''); });
  var customer = texts.filter(function (t) { return t.indexOf(EMAIL) !== -1 || t.indexOf('山田太郎') !== -1; })[0];
  assert.ok(customer, '利用者向けメールが送られる');
  assert.ok(customer.indexOf('ご利用プラン: ' + PLAN_LABEL) !== -1);
  assert.ok(customer.indexOf('利用料金: 6,000円（税込）') !== -1);
  assert.ok(customer.indexOf('有人クロークではありません') !== -1);
  var admin = texts.filter(function (t) { return t.indexOf('仮予約を受け付けました: ' + r.bookingId) !== -1; })[0];
  assert.ok(admin && admin.indexOf('プラン: ' + PLAN_LABEL) !== -1 && admin.indexOf('6,000円') !== -1);

  var ctx2 = setup();
  var n = book(ctx2, { plan: undefined, durationMinutes: 120, startTime: '10:00' });
  assert.strictEqual(n.success, true);
  var all2 = (ctx2.mailApp._sentEmails).map(function (m) { return m.subject + (m.body || m.message || ''); }).join('\n');
  assert.ok(all2.indexOf(PLAN_LABEL) === -1 && all2.indexOf('有人クローク') === -1, '通常予約のメールは変わらない');
});

test('Booking Admin: 一覧・詳細にプラン名が付き、通常予約にはplanキーが付かない', function () {
  var ctx = setup();
  var planned = book(ctx);
  var normal = book(ctx, { plan: undefined, startTime: '18:00', durationMinutes: 60, email: 'n@example.com' });
  assert.strictEqual(planned.success, true, JSON.stringify(planned));
  assert.strictEqual(normal.success, true, JSON.stringify(normal));
  var list = ctx.sandbox.getAdminBookings().bookings;
  var plannedItem = list.filter(function (b) { return b.bookingId === planned.bookingId; })[0];
  var normalItem = list.filter(function (b) { return b.bookingId === normal.bookingId; })[0];
  assert.strictEqual(plannedItem.planLabel, PLAN_LABEL);
  assert.strictEqual(plannedItem.planCode, PLAN);
  assert.strictEqual(plannedItem.effectivePriceAmount, 6000);
  assert.ok(!('planLabel' in normalItem) && !('planCode' in normalItem));
  var detail = ctx.sandbox.getAdminBookingDetail(planned.bookingId).booking;
  assert.strictEqual(detail.planLabel, PLAN_LABEL);
  assert.strictEqual(detail.effectivePriceAmount, 6000);
  assert.ok(!('planLabel' in ctx.sandbox.getAdminBookingDetail(normal.bookingId).booking));
});

// ============================================================================
// 日程変更
// ============================================================================

function rescheduleFixture() {
  var ctx = setup();
  var sb = ctx.sandbox;
  var start = sb.CalendarRepository.parseDateTime(EVENT_DAY, '10:00', 'Asia/Tokyo');
  var end = sb.CalendarRepository.parseDateTime(EVENT_DAY, '16:00', 'Asia/Tokyo');
  var event = sb.CalendarApp.getCalendarById('cal1').createEvent('booking', start, end);
  event.setTag('bookingId', 'SX-EVENT-1');
  event.setTag('status', 'CONFIRMED');
  event.setTag('brand', 'studio_x');
  sb.SpreadsheetRepository.appendBooking({
    bookingId: 'SX-EVENT-1', date: EVENT_DAY, startAt: start, endAt: end, status: 'CONFIRMED', brand: 'studio_x',
    calendarEventId: event.getId(), name: '予約者', email: EMAIL, paymentMethod: '現金', paymentStatus: 'NOT_STARTED',
    confirmedMailSentAt: new Date(), priceAmount: 6000, priceTier: 'GENERAL', priceDayType: 'WEEKEND_HOLIDAY',
    priceIsMember: false, priceComputedAt: new Date(), priceGeneration: 'V2', feePaidAmount: 0, planCode: PLAN
  });
  return { ctx: ctx, sb: sb, version: event.getStartTime().getTime() + ':' + event.getEndTime().getTime() };
}

test('日程変更: 6時間固定を外す変更は拒否（通常料金へ化けさせない）。管理者はFEE手入力でも回避できない。日付の条件は無い', function () {
  var f = rescheduleFixture();
  var preview = f.sb.adminPreviewBookingReschedule('SX-EVENT-1', { date: OTHER_DAY, startTime: '10:00', endTime: '16:00' }, f.version);
  assert.strictEqual(preview.success, true, 'イベント日でない日にも変更できる: ' + JSON.stringify(preview));
  assert.strictEqual(preview.newFeeAmount, 6000);
  var shorter = { date: OTHER_DAY, startTime: '10:00', endTime: '14:00' };
  var direct = f.sb.adminRescheduleBooking('SX-EVENT-1', shorter, f.version, '', '手入力', { manualNewFeeAmount: 9000, manualNewFeeNote: '手動' });
  assert.strictEqual(direct.success, false);
  assert.strictEqual(direct.error.code, 'PLAN_DURATION_INVALID');
  assert.strictEqual(record(f.ctx, 'SX-EVENT-1').priceAmount, 6000, '台帳は変わらない');
  assert.strictEqual(f.sb.Booking.getEffectivePriceAmount(record(f.ctx, 'SX-EVENT-1')), 6000);
});

test('日程変更: 6時間以外への変更は拒否。別の日への変更は6,000円・プランを保持', function () {
  var f = rescheduleFixture();
  var shorter = f.sb.adminPreviewBookingReschedule('SX-EVENT-1', { date: EVENT_DAY, startTime: '10:00', endTime: '14:00' }, f.version);
  assert.strictEqual(shorter.success, false);
  assert.strictEqual(shorter.error.code, 'PLAN_DURATION_INVALID');
  var input = { date: EVENT_DAY_2, startTime: '11:00', endTime: '17:00' };
  var preview = f.sb.adminPreviewBookingReschedule('SX-EVENT-1', input, f.version);
  assert.strictEqual(preview.success, true, JSON.stringify(preview));
  assert.strictEqual(preview.oldFeeAmount, 6000);
  assert.strictEqual(preview.newFeeAmount, 6000, '別の日への変更も6,000円のまま');
  assert.strictEqual(preview.feeDifference, 0);
  var done = f.sb.adminRescheduleBooking('SX-EVENT-1', input, f.version, '', '', undefined, preview.feeQuoteToken);
  assert.strictEqual(done.success, true, JSON.stringify(done));
  var rec = record(f.ctx, 'SX-EVENT-1');
  assert.strictEqual(rec.planCode, PLAN);
  assert.strictEqual(f.sb.Booking.getEffectivePriceAmount(rec), 6000);
});

// ============================================================================
// 通常予約の日程変更は影響を受けない
// ============================================================================

test('日程変更: プランを持たない通常予約は従来どおり変更できる', function () {
  var ctx = setup();
  var sb = ctx.sandbox;
  var start = sb.CalendarRepository.parseDateTime(EVENT_DAY, '10:00', 'Asia/Tokyo');
  var end = sb.CalendarRepository.parseDateTime(EVENT_DAY, '13:00', 'Asia/Tokyo');
  var event = sb.CalendarApp.getCalendarById('cal1').createEvent('booking', start, end);
  event.setTag('bookingId', 'SX-NORMAL-1');
  event.setTag('status', 'CONFIRMED');
  event.setTag('brand', 'studio_x');
  var quote = sb.BookingPricing.computeBookingPrice({ brand: 'studio_x', date: EVENT_DAY, durationMinutes: 180, generation: 'V2' });
  sb.SpreadsheetRepository.appendBooking({
    bookingId: 'SX-NORMAL-1', date: EVENT_DAY, startAt: start, endAt: end, status: 'CONFIRMED', brand: 'studio_x',
    calendarEventId: event.getId(), name: '予約者', email: EMAIL, paymentMethod: '現金', paymentStatus: 'NOT_STARTED',
    confirmedMailSentAt: new Date(), priceAmount: quote.price.amount, priceTier: 'GENERAL', priceDayType: quote.price.dayType,
    priceIsMember: false, priceComputedAt: new Date(), priceGeneration: 'V2', feePaidAmount: 0, planCode: ''
  });
  var version = event.getStartTime().getTime() + ':' + event.getEndTime().getTime();
  var preview = sb.adminPreviewBookingReschedule('SX-NORMAL-1', { date: OTHER_DAY, startTime: '10:00', endTime: '13:00' }, version);
  assert.strictEqual(preview.success, true, JSON.stringify(preview));
});

// ============================================================================
// フロントエンド（ロジック・掲載内容）
// ============================================================================

test('予約UIのロジック: プランをpayloadへ載せ、人数の早期ガード・プラン名・エラー文言を持つ（対象日の判定は持たない）', function () {
  var sandbox = { window: {} };
  new Function('window', read('scripts/booking-logic.js'))(sandbox.window);
  var Logic = sandbox.window.BookingLogic;
  assert.strictEqual(Logic.EVENT_BASE_PLAN_CODE, PLAN);
  assert.strictEqual(Logic.EVENT_BASE_PLAN_HOURS, 6);
  var p = Logic.buildCreateBookingPayload({ brand: 'studio_x', plan: PLAN, date: EVENT_DAY, startTime: '10:00', durationMinutes: 360, name: 'a', email: 'a@example.com', people: '4名', purpose: 'コスプレ撮影', paymentMethod: '現金' });
  assert.strictEqual(p.plan, PLAN);
  assert.ok(!('amount' in p) && !('price' in p), '金額は送らない');
  assert.strictEqual('plan' in Logic.buildCreateBookingPayload({ brand: 'studio_x', date: EVENT_DAY, startTime: '10:00', durationMinutes: 120 }), false, '未選択ならキー自体を付けない');
  assert.strictEqual(Logic.isEventPlanPeopleValue('4名'), true);
  assert.strictEqual(Logic.isEventPlanPeopleValue('5名以上・要相談'), false);
  assert.strictEqual(Logic.EVENT_BASE_PLAN_LABEL, 'Studio X｜6時間貸切ベースプラン（6,000円）');
  assert.strictEqual(Logic.isEventPlanDate, undefined, '対象日判定は廃止');
  assert.strictEqual(Logic.formatEventPlanDate, undefined);
  assert.strictEqual(Logic.messageForErrorCode('EVENT_PLAN_DATE_NOT_ELIGIBLE', 'ja'), Logic.messageForErrorCode('UNKNOWN_CODE_FOR_TEST', 'ja'), '対象日エラーの専用文言は持たない');
  assert.ok(Logic.messageForErrorCode('EVENT_PLAN_PEOPLE_EXCEEDED', 'ja').indexOf('1〜4名') !== -1);
});

test('予約フォーム: Studio Xのみに貸切ベースプラン欄（常時表示・チェックで6時間固定）があり、SNB / mensには出ない', function () {
  var html = read('_includes/booking_app_ja.html');
  var m = /\{% if include\.brand == "studio_x" %\}\s*<!--[\s\S]*?<fieldset class="ba-fieldset" id="ba-event-plan-field">[\s\S]*?<\/fieldset>\s*\{% endif %\}/.exec(html);
  assert.ok(m, 'studio_x限定の{% if %}内にある');
  assert.ok(m[0].indexOf('id="ba-plan-event"') !== -1 && m[0].indexOf('value="osu_cosplay_base_6h"') !== -1);
  assert.ok(m[0].indexOf('有人クロークではありません') !== -1);
  assert.ok(m[0].indexOf('6,000円') !== -1 && m[0].indexOf('最大4名') !== -1);
  assert.ok(m[0].indexOf('再入室') !== -1 && m[0].indexOf('荷物・貴重品') !== -1);
  assert.ok(m[0].indexOf('hidden') === -1, '常時表示（初期非表示にしない）');
  assert.ok(!/イベント開催日|対象日|大須コスプレ/.test(m[0]), 'イベント日限定の表現を残さない');
  var app = read('scripts/booking-app.js');
  assert.ok(app.indexOf('action=eventPlan') === -1 && app.indexOf('loadEventPlan_') === -1, '対象日APIを呼ばない');
  assert.ok(app.indexOf('els.duration.disabled = true') !== -1);
  var booking = read('studio-x/booking/index.html');
  assert.ok(booking.indexOf('../#osu-base-plan') !== -1, '予約ページからプラン説明への導線');
  ['booking/index.html', 'mens/booking/index.html'].forEach(function (rel) {
    if (fs.existsSync(path.join(ROOT, rel))) assert.ok(read(rel).indexOf('ba-plan-event') === -1);
  });
});

test('公式サイト /studio-x/: プラン名・6時間6,000円・最大4名・4名で1人1,500円・再入室・責任範囲の表記があり、誤認表現・禁止表現がない', function () {
  var html = read('studio-x/index.html');
  var start = html.indexOf('id="osu-base-plan"');
  assert.ok(start !== -1);
  var section = html.slice(start, html.indexOf('id="access"', start));
  var text = section.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  ['6時間貸切', 'ベースプラン', '6,000', '6時間', '最大4名', '1名あたり1,500円', '着替え', '荷物置き', '休憩',
    '再入室', '大型ミラー', '有人クロークではありません', '荷物は貸切中のお部屋内で各自管理', '貴重品の管理は利用者ご自身',
    'スタッフは常駐しません', 'シャワー利用は含まれません', '共用部や建物内に荷物を放置しない', '他の利用者とお部屋を共用することはありません',
    '原状復帰', '利用規約の責任範囲'].forEach(function (needle) {
    assert.ok(text.indexOf(needle) !== -1, '掲載する: ' + needle);
  });
  /* 誤認表現: 「預かります」「クローク」を肯定的に使わない（「有人クロークではありません」の否定のみ）。 */
  assert.ok(!/荷物を?お預かりします|預かりサービスです|クロークです|クロークをご利用/.test(text));
  assert.ok(text.replace(/有人クローク(ではありません|ではなく)/g, '').indexOf('クローク') === -1);
  assert.ok(!/スペースマーケット|スペマ/.test(html.slice(start, html.indexOf('id="access"', start))), '公式サイト向け。スペースマーケット表記を入れない');
  /* 通常料金は不変（既存の料金カードのまま）。 */
  assert.ok(html.indexOf('1,200<small>円〜 / 1時間</small>') !== -1 && html.indexOf('1,500<small>円〜 / 1時間</small>') !== -1);
  /* 常設プラン: イベント日限定の表現を残さない。日付もハードコードしない。 */
  assert.ok(!/開催日限定|対象イベント日|対象日|大須コスプレイベント/.test(text), text);
  assert.ok(!/20\d\d-\d\d-\d\d/.test(section));
  assert.ok(!/イベント開催日限定|対象のイベント開催日|大須周辺で大型コスプレイベントが開催される日のみ/.test(html), 'FAQ / JSON-LD / SEOメタにも残さない');
  /* 構造化データ（Offer + FAQPage）。JSONとして妥当で、金額・通貨が正しい。 */
  var ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(ld, 'JSON-LDがある');
  var data = JSON.parse(ld[1]);
  var offer = data['@graph'].filter(function (n) { return n['@type'] === 'Offer'; })[0];
  assert.strictEqual(offer.price, '6000');
  assert.strictEqual(offer.priceCurrency, 'JPY');
  assert.ok(data['@graph'].some(function (n) { return n['@type'] === 'FAQPage' && n.mainEntity.length === 3; }));
});

test('通常のStudio X料金表示（/studio-x/ の料金カード・最低利用・追加料金なし）は変更されていない', function () {
  var html = read('studio-x/index.html');
  var price = html.slice(html.indexOf('id="price"'), html.indexOf('id="osu-base-plan"'));
  /* #486で改定された現行の通常料金（平日1,200円/時・土日祝1,500円/時）のまま。 */
  assert.ok(price.indexOf('1,200<small>円〜 / 1時間</small>') !== -1);
  assert.ok(price.indexOf('2時間 2,400円 / 延長1時間 1,200円') !== -1);
  assert.ok(price.indexOf('2時間 3,000円 / 延長1時間 1,500円') !== -1);
  assert.ok(price.indexOf('人数追加料金なし（最大4名）') !== -1);
  assert.ok(price.indexOf('貸切ベース') === -1 && price.indexOf('開催日限定') === -1, '通常料金のエリアにイベント限定プランを混ぜない');
});

// ============================================================================
// 配布・SNB / mens への影響なし
// ============================================================================

test('配布ファイル: EventPlanRepository.gsは廃止され、どの配布対象にも含まれない', function () {
  [manifest.BOOKING_WEB_APP_FILES, manifest.BOOKING_ADMIN_FILES, manifest.BOOKING_WEBHOOK_FILES].forEach(function (files) {
    assert.ok(files.indexOf('EventPlanRepository.gs') === -1);
  });
  assert.ok(!fs.existsSync(path.join(ROOT, 'gas/booking/shared/EventPlanRepository.gs')));
});

test('SNB / mens: 料金表・プラン処理は変わらない（ペアパックは従来どおり、貸切ベースプランは両ブランドで拒否）', function () {
  var P = setup().sandbox.BookingPricing;
  assert.strictEqual(P.computeBookingPrice({ brand: 'snb', date: EVENT_DAY, durationMinutes: 360, generation: 'V2', plan: PLAN }).valid, false);
  assert.strictEqual(P.computeBookingPrice({ brand: 'mens', date: EVENT_DAY, durationMinutes: 360, generation: 'V2', plan: PLAN }).valid, false);
  var snb = P.computeBookingPrice({ brand: 'snb', date: EVENT_DAY, durationMinutes: 180, generation: 'V2', isMember: false });
  assert.strictEqual(snb.valid, true);
  assert.strictEqual(snb.price.plan, '');
  var pair = P.computeBookingPrice({ brand: 'snb', date: EVENT_DAY, durationMinutes: 180, generation: 'V2', plan: 'member_pair_3h' });
  assert.strictEqual(pair.valid, true);
  assert.ok(pair.price.amount === 5000 || pair.price.amount === 6000);
});
