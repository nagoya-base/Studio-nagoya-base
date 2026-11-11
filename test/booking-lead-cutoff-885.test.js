/*
 * Issue #885: 新規予約の確定締切（利用開始30分前）。
 * - サーバー時刻が正本（createBooking / getAvailability の両方で同じ下限を使う）
 * - 30:00ちょうどは可、29:59は不可（秒境界）
 * - 施行日時ゲート BOOKING_LEAD_2026_EFFECTIVE_AT（未設定・不正は従来ルール。#758の施行日とは連動しない）
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var LEAD_KEY = 'BOOKING_LEAD_2026_EFFECTIVE_AT';
var RULES_KEY = 'BOOKING_RULES_2026_11_EFFECTIVE_AT';
var EFFECTIVE = '2026-11-25T00:00:00+09:00';
var EFFECTIVE_MS = Date.parse(EFFECTIVE);

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'BookingWindow.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs',
  'BookingPricing.gs', 'RateLimiter.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'BookingMemberVerification.gs',
  'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'AdminNotifier.gs', 'BookingMailTemplates.gs',
  'BookingMailer.gs', 'BookingRepository.gs', 'Code.gs'
];

function setup(extraProps) {
  var calendarsById = { cal1: { events: [] } };
  var spreadsheetsById = { ss1: {} };
  var props = Object.assign({ CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1' }, extraProps || {});
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(props),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: stubs.createMailAppStub(),
    Logger: stubs.createLoggerStub(),
    ContentService: stubs.createContentServiceStub()
  };
  return { sandbox: loadBookingSandbox(FILES, globals), calendarsById: calendarsById };
}

function props(extra) {
  var o = {};
  o[LEAD_KEY] = EFFECTIVE;
  return Object.assign(o, extra || {});
}

function payload(overrides) {
  return Object.assign({
    brand: 'snb', customerType: 'returning', date: '2026-12-01', startTime: '13:00', durationMinutes: 120,
    name: '山田太郎', email: 'taro@example.com', phone: '090-1234-5678', people: '2名', purpose: '練習',
    paymentMethod: '現金', note: '', source: 'test'
  }, overrides || {});
}

/* 受付時刻 = 2026-12-01 JST 12:30:00 + offsetSec。開始13:00までの残りは 30:00 - offsetSec。 */
function at(offsetSec) { return new Date(Date.parse('2026-12-01T12:30:00+09:00') + offsetSec * 1000); }

test('施行後: 開始の30:00前は可、29:59前は不可（BOOKING_LEAD_TIME_PASSED）', function () {
  var ok = setup(props()).sandbox.BookingRepository.createBooking(payload(), at(0));
  assert.strictEqual(ok.success, true, JSON.stringify(ok.error));

  var ctx = setup(props());
  var ng = ctx.sandbox.BookingRepository.createBooking(payload(), at(1));
  assert.strictEqual(ng.success, false);
  assert.strictEqual(ng.error.code, 'BOOKING_LEAD_TIME_PASSED');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0, 'Calendarに何も作らない');
});

test('施行後: 秒・ミリ秒の端数でも29:59.xxxは不可、30:00.000は可', function () {
  var base = Date.parse('2026-12-01T12:30:00+09:00');
  var ng = setup(props()).sandbox.BookingRepository.createBooking(payload(), new Date(base + 1));
  assert.strictEqual(ng.error.code, 'BOOKING_LEAD_TIME_PASSED');
  var ok = setup(props()).sandbox.BookingRepository.createBooking(payload(), new Date(base - 59000));
  assert.strictEqual(ok.success, true);
});

test('3ブランド（snb / mens / studio_x）で同じ締切が効く', function () {
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var ng = setup(props()).sandbox.BookingRepository.createBooking(payload({ brand: brand }), at(1));
    assert.strictEqual(ng.error && ng.error.code, 'BOOKING_LEAD_TIME_PASSED', brand);
    var ok = setup(props()).sandbox.BookingRepository.createBooking(payload({ brand: brand }), at(0));
    assert.strictEqual(ok.success, true, brand);
  });
});

test('施行前・未設定・不正値は従来ルール（開始が現在より後なら可。29分前でも受理）', function () {
  var cases = [{}, (function () { var o = {}; o[LEAD_KEY] = 'abc'; return o; })(), (function () { var o = {}; o[LEAD_KEY] = '2026-12-31T00:00:00'; return o; })()];
  cases.forEach(function (p, i) {
    var r = setup(p).sandbox.BookingRepository.createBooking(payload(), at(60));
    assert.strictEqual(r.success, true, 'case ' + i);
  });
  var pre = setup(props()).sandbox.BookingRepository.createBooking(payload({ date: '2026-11-20', startTime: '13:00' }), new Date(Date.parse('2026-11-20T12:45:00+09:00')));
  assert.strictEqual(pre.success, true, '施行日時より前は従来ルール');
});

test('施行前の「開始が過去」は従来のSAME_DAY_START_TIME_PASSEDのまま', function () {
  var r = setup({}).sandbox.BookingRepository.createBooking(payload(), at(31 * 60));
  assert.strictEqual(r.error.code, 'SAME_DAY_START_TIME_PASSED');
});

test('施行日時ちょうどから有効（1ミリ秒前は無効）', function () {
  var c = setup(props()).sandbox.BookingConfig;
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS - 1)).leadCutoffMinutes, 0);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS)).leadCutoffMinutes, 30);
  assert.strictEqual(c.getLeadCutoffStatus(new Date(EFFECTIVE_MS - 1)).state, 'PENDING');
  assert.strictEqual(c.getLeadCutoffStatus(new Date(EFFECTIVE_MS)).state, 'EFFECTIVE');
});

test('#758の施行日（BOOKING_RULES_2026_11_EFFECTIVE_AT）が過ぎても、本ゲート未設定なら締切は効かない（自動連動しない）', function () {
  var p = {}; p[RULES_KEY] = '2026-11-19T00:00:00+09:00';
  var c = setup(p).sandbox.BookingConfig;
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS)).leadCutoffMinutes, 0);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS)).bufferMinutes, 30);
});

test('getMinimumStartMinutes: lead=0は従来の現在分、lead>0は秒境界を切り上げる', function () {
  var A = setup({}).sandbox.BookingAvailability;
  var t = new Date('2026-12-01T12:30:00+09:00'); // 750分
  assert.strictEqual(A.getMinimumStartMinutes(t, 'Asia/Tokyo', 0), 750);
  assert.strictEqual(A.getMinimumStartMinutes(t, 'Asia/Tokyo', 30), 779); // 780(13:00)は可
  assert.strictEqual(A.getMinimumStartMinutes(new Date(t.getTime() + 1000), 'Asia/Tokyo', 30), 780); // 13:00は不可
  assert.strictEqual(A.getMinimumStartMinutes(t, 'Invalid/Zone', 30), null);
});

test('空き候補: 施行後の当日は開始30分以内の候補を出さない（UIに依存せずAPIも同じ判定）', function () {
  var sb = setup(props()).sandbox;
  var cfg = sb.BookingConfig.getAvailabilityConfig(at(0));
  var res = sb.BookingAvailability.getAvailability({ date: '2026-12-01', durationMinutes: 60, brand: 'snb' }, [], cfg, at(0));
  assert.strictEqual(res.success, true);
  assert.ok(res.bookableStartTimes.indexOf('13:00') !== -1, '30:00ちょうどは候補に残る');
  assert.ok(res.bookableStartTimes.every(function (s) { return s >= '13:00'; }));
  var res2 = sb.BookingAvailability.getAvailability({ date: '2026-12-01', durationMinutes: 60, brand: 'snb' }, [], cfg, at(1));
  assert.ok(res2.bookableStartTimes.indexOf('13:00') === -1, '29:59前は候補から外れる');
  assert.ok(res2.bookableStartTimes.indexOf('13:30') !== -1);
});

test('管理者tier（認証済みBooking Admin経路）は30分締切の対象外。開始が過去なら従来どおり拒否', function () {
  var sb = setup(props()).sandbox;
  var cfg = sb.BookingConfig.getAvailabilityConfig(at(0));
  var ok = sb.Booking.validateCreateBookingInput(payload(), cfg, at(15 * 60), sb.BookingWindow.TIER.ADMIN);
  assert.strictEqual(ok.valid, true, '13:00開始を12:45に管理者が作成できる');
  var ng = sb.Booking.validateCreateBookingInput(payload(), cfg, at(31 * 60), sb.BookingWindow.TIER.ADMIN);
  assert.strictEqual(ng.error.code, 'SAME_DAY_START_TIME_PASSED');
  var pub = sb.Booking.validateCreateBookingInput(payload(), cfg, at(15 * 60), sb.BookingWindow.TIER.GENERAL);
  assert.strictEqual(pub.error.code, 'BOOKING_LEAD_TIME_PASSED');
});

test('フロント: BOOKING_LEAD_TIME_PASSED は開始時刻の選び直し（reselect-time）へ誘導し、日英の文言を持つ', function () {
  var logic = require('../scripts/booking-logic.js');
  assert.strictEqual(logic.recoveryActionForErrorCode('BOOKING_LEAD_TIME_PASSED'), 'reselect-time');
});
