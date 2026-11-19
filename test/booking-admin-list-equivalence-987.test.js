/*
 * Issue #987（PR #988 オーナーレビュー対応）: getAdminBookings() の統合出力同値テスト。
 *
 * Availability.gs のFormatter再利用（getFormatter_のキャッシュ）の有無だけを変えた2つのVMに、
 * 同一の固定時計・同一の架空データ（実予約・本番Spreadsheetは使わない）を与え、
 * serverTimingのみ除外した戻り値全体（todayJst / nowJst / bookings の並び順と全フィールド）が
 * deepStrictEqual で一致することを検証する。
 *
 * 比較対象:
 * - cached  : 現在の Availability.gs（キャッシュあり）
 * - uncached: 同じソースの getFormatter_ だけを「毎回コンストラクタを呼ぶ」に差し替えたもの
 *             （変更前の new Intl.DateTimeFormat 毎回生成と同じ呼び出し。変更前コードそのものとの
 *             一致は test/booking-availability-formatter-cache-987.test.js の4関数単体比較で確認）
 * 許容する差異は serverTiming キーのみ（他キーは無条件に増やさない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs',
  'BookingPricing.gs', 'CardPayment.gs', 'MembershipRules.gs', 'EquipmentCatalog.gs', 'BookingOptions.gs', 'StripeGateway.gs',
  'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs', 'RecoveryRepository.gs',
  'FeeCalculator.gs', 'FeeSettlementRepository.gs', 'BookingReschedule.gs', 'StripeEventRepository.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs',
  'BookingRepository.gs', 'AdminNotifier.gs', 'BookingAdminAlerts.gs', 'BookingRefund.gs',
  'BookingAdmin.gs', 'BookingAdminWeb.gs'
];

/* 固定時計: 2026-11-20 00:30 JST（JSTの日付境界の直後）。new Date() / Date.now() をこの値に固定する。 */
var FIXED_NOW_MILLIS = Date.parse('2026-11-19T15:30:00Z');
var RealDate = Date;
function FixedDate() {
  if (!(this instanceof FixedDate)) return new RealDate(FIXED_NOW_MILLIS).toString();
  if (arguments.length === 0) return new RealDate(FIXED_NOW_MILLIS);
  return new (Function.prototype.bind.apply(RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
}
FixedDate.prototype = RealDate.prototype;
FixedDate.now = function () { return FIXED_NOW_MILLIS; };
FixedDate.UTC = RealDate.UTC;
FixedDate.parse = RealDate.parse;

/* 同一ソースのキャッシュ参照だけを無効化する（getFormatter_が毎回Formatterを生成する＝変更前と同じ呼び出し）。 */
function disableFormatterCache(source) {
  var marker = 'var cached = formatterCache_.get(key);';
  assert.strictEqual(source.split(marker).length, 2, 'キャッシュ参照の差し替え対象が1か所だけ存在するべき');
  return source.replace(marker, 'var cached = null;');
}

function record(overrides) {
  return Object.assign({
    bookingId: 'X', createdAt: new Date('2026-11-10T09:00:00+09:00'),
    date: '2026-12-01', startAt: new Date('2026-12-01T10:00:00+09:00'), endAt: new Date('2026-12-01T12:00:00+09:00'),
    brand: 'studio_x', name: '架空 太郎', email: 'dummy@example.com', phone: '000-0000-0000',
    people: '2名', purpose: 'テスト', paymentMethod: '現金', status: 'PENDING', calendarEventId: 'ev-x',
    source: 'test', note: '', customerType: 'returning'
  }, overrides);
}

var FIXTURE_BOOKINGS = [
  record({ bookingId: 'SX-20261201-AAAAAAA1' }),
  /* カード予約（Date型のcreatedAt/startAt/endAt。支払期限の計算を通る） */
  record({
    bookingId: 'SX-20261205-AAAAAAA2', paymentMethod: 'オンラインクレジットカード',
    createdAt: new Date('2026-11-18T23:59:59.999+09:00'), date: new Date('2026-12-05T00:00:00+09:00'),
    startAt: new Date('2026-12-05T23:00:00+09:00'), endAt: new Date('2026-12-06T00:00:00+09:00')
  }),
  /* 日付境界: 00:00開始・23:59終了、年越し */
  record({
    bookingId: 'SX-20261231-AAAAAAA3', date: '2026-12-31', status: 'CONFIRMED',
    startAt: new Date('2026-12-31T00:00:00+09:00'), endAt: new Date('2026-12-31T23:59:00+09:00'), confirmedMailSentAt: new Date('2026-11-12T10:00:00+09:00')
  }),
  record({
    bookingId: 'SX-20270101-AAAAAAA4', date: '2027-01-01',
    startAt: new Date('2027-01-01T00:00:00+09:00'), endAt: new Date('2027-01-01T03:00:00+09:00')
  }),
  /* うるう日ではないが月末境界、brandがSNB／SNB mens */
  record({
    bookingId: 'SN-20261130-AAAAAAA5', brand: 'snb', date: '2026-11-30',
    startAt: new Date('2026-11-30T20:00:00+09:00'), endAt: new Date('2026-11-30T23:00:00+09:00')
  }),
  record({
    bookingId: 'SM-20261220-AAAAAAA6', brand: 'mens', date: '2026-12-20', customerType: 'first',
    startAt: new Date('2026-12-20T13:00:00+09:00'), endAt: new Date('2026-12-20T16:30:00+09:00')
  }),
  /* createdAtが文字列（ISO／整形済み／解釈不能） */
  record({ bookingId: 'SX-20261202-AAAAAAA7', createdAt: '2026-11-10T00:30:00.000Z', date: '2026-12-02' }),
  record({ bookingId: 'SX-20261203-AAAAAAA8', createdAt: '2026-11-10 09:30', date: '2026-12-03' }),
  record({ bookingId: 'SX-20261204-AAAAAAA9', createdAt: 'not-a-date', date: '2026-12-04' }),
  /* 終了済み（通常一覧から外れる判定のnowJst比較を通る） */
  record({
    bookingId: 'SX-20261119-AAAAAA10', date: '2026-11-19',
    startAt: new Date('2026-11-19T10:00:00+09:00'), endAt: new Date('2026-11-19T12:00:00+09:00')
  }),
  record({
    bookingId: 'SX-20261120-AAAAAA11', date: '2026-11-20', status: 'CONFIRMED',
    startAt: new Date('2026-11-20T00:30:00+09:00'), endAt: new Date('2026-11-20T02:30:00+09:00')
  }),
  record({ bookingId: 'SX-20261206-AAAAAA12', date: '2026-12-06', status: 'CANCELLED' })
];

var FIXTURE_OPTION_ORDERS = [
  { bookingId: 'SX-20261201-AAAAAAA1', optionOrderId: 'OPT-FIXED0001', items: ['STAFF_PRE_SETUP:EQUIPMENT', 'STAFF_CLEANUP:EQUIPMENT'], category: 'STAFF_SERVICE', amountJpy: 2000, approvalStatus: 'PENDING_APPROVAL', paymentStatus: 'NOT_STARTED', status: 'PENDING_APPROVAL' },
  { bookingId: 'SX-20261205-AAAAAAA2', optionOrderId: 'OPT-FIXED0002', items: ['EQ:COB_BICOLOR:4'], category: 'EQUIPMENT', amountJpy: 3200, approvalStatus: 'APPROVED', paymentStatus: 'NOT_STARTED', status: 'AWAITING_PAYMENT' },
  { bookingId: 'SX-20261231-AAAAAAA3', optionOrderId: 'OPT-FIXED0003', items: ['STAFF_PRE_SETUP:EQUIPMENT'], category: 'STAFF_SERVICE', amountJpy: 2000, approvalStatus: 'APPROVED', paymentStatus: 'PAID', status: 'CONFIRMED' }
];

function run(sourceTransforms) {
  var spreadsheetsById = { ss1: {} };
  var globals = {
    Date: FixedDate,
    PropertiesService: stubs.createPropertiesServiceStub({
      CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1', BOOKING_MAIL_DISPLAY_NAME: 'Studio X',
      BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com'
    }),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: stubs.createMailAppStub(),
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripe呼び出しは想定外'); }),
    Logger: stubs.createLoggerStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals, sourceTransforms);
  FIXTURE_BOOKINGS.forEach(function (r) { sandbox.SpreadsheetRepository.appendBooking(Object.assign({}, r)); });
  sandbox.OptionOrderRepository.appendOrders(FIXTURE_OPTION_ORDERS.map(function (o) {
    return Object.assign({
      brand: 'studio_x', source: 'WITH_BOOKING', currency: 'JPY', customerEmail: 'dummy@example.com',
      createdAt: new Date('2026-11-11T09:00:00+09:00'), updatedAt: new Date('2026-11-11T09:00:00+09:00')
    }, o);
  }));
  return sandbox.getAdminBookings();
}

/* serverTimingだけを除き、JSON往復でVM realmの違い（Array/Object prototype）を除去する。 */
function normalize(result) {
  var copy = JSON.parse(JSON.stringify(result));
  assert.ok(copy.serverTiming && typeof copy.serverTiming === 'object', 'serverTimingは存在し、比較対象から除外するキーはこれだけ');
  delete copy.serverTiming;
  return copy;
}

test('getAdminBookings: Formatterキャッシュあり／なしでserverTiming以外の戻り値全体が完全一致する', function () {
  var cached = normalize(run());
  var uncached = normalize(run({ 'Availability.gs': disableFormatterCache }));

  assert.deepStrictEqual(Object.keys(cached).sort(), ['bookings', 'nowJst', 'todayJst']);
  assert.strictEqual(cached.todayJst, '2026-11-20');
  assert.strictEqual(cached.nowJst, '2026-11-20 00:30');
  assert.ok(cached.bookings.length >= 8, '架空の複数予約が一覧に含まれている: ' + cached.bookings.length);
  assert.deepStrictEqual(cached, uncached);
});

test('getAdminBookings: 同値比較の前提（カード期限・Studio Xオプション・Date型・文字列createdAtが実際に出力へ現れる）', function () {
  var result = normalize(run());
  var byId = {};
  result.bookings.forEach(function (b) { byId[b.bookingId] = b; });

  var card = byId['SX-20261205-AAAAAAA2'];
  assert.ok(card, 'カード予約が一覧にある');
  assert.match(card.cardPaymentDueAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'カード支払期限が計算されている');
  assert.strictEqual(card.createdAt, '2026-11-18 23:59');
  assert.strictEqual(card.date, '2026-12-05');
  assert.strictEqual(card.startAt, '23:00');

  assert.strictEqual(byId['SX-20261201-AAAAAAA1'].optionSummary.state, 'PENDING_APPROVAL');
  assert.strictEqual(byId['SX-20261205-AAAAAAA2'].optionSummary.state, 'AWAITING_PAYMENT');
  assert.strictEqual(byId['SX-20261231-AAAAAAA3'].optionSummary.state, 'CONFIRMED');
  assert.strictEqual(byId['SX-20261231-AAAAAAA3'].startAt, '00:00');
  assert.strictEqual(byId['SX-20261231-AAAAAAA3'].endAt, '23:59');
  assert.strictEqual(byId['SX-20270101-AAAAAAA4'].date, '2027-01-01');
  assert.strictEqual(byId['SN-20261130-AAAAAAA5'].optionSummary, undefined, 'SNBにはoptionSummaryを付けない');

  assert.strictEqual(byId['SX-20261202-AAAAAAA7'].createdAt, '2026-11-10 09:30', 'ISO文字列のcreatedAtはJST整形');
  assert.strictEqual(byId['SX-20261203-AAAAAAA8'].createdAt, '2026-11-10 09:30');
  assert.strictEqual(byId['SX-20261204-AAAAAAA9'].createdAt, '', '解釈不能なcreatedAtは空文字');
});
