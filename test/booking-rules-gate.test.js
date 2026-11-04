/*
 * Issue #758: 予約ルール施行日時ゲート（予約間バッファー30分）の Config.gs テスト。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var KEY = 'BOOKING_RULES_2026_11_EFFECTIVE_AT';
var EFFECTIVE = '2026-11-19T00:00:00+09:00';
var EFFECTIVE_MS = Date.parse(EFFECTIVE);

function load(props) {
  return loadBookingSandbox(['Config.gs'], { PropertiesService: stubs.createPropertiesServiceStub(props || {}) }).BookingConfig;
}

test('施行日時未設定: 従来ルール（既定15）のまま。施行後の時刻でも30分にならない', function () {
  var c = load({});
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS + 86400000)).bufferMinutes, 15);
  assert.strictEqual(c.isBookingRulesEffective(new Date(EFFECTIVE_MS + 86400000)), false);
  assert.strictEqual(c.getBookingRulesStatus(new Date()).state, 'UNSET');
});

test('施行日時が不正（オフセットなし・日付のみ・文字列・存在しない日時）: 従来ルールのまま、状態はINVALID', function () {
  ['2026-11-19T00:00:00', '2026-11-19', 'abc', '2026-13-40T00:00:00+09:00', ' 2026-11-19T00:00:00+09:00'].forEach(function (v) {
    var c = load((function () { var o = {}; o[KEY] = v; return o; })());
    var now = new Date(EFFECTIVE_MS + 86400000);
    assert.strictEqual(c.getAvailabilityConfig(now).bufferMinutes, 15, v);
    assert.strictEqual(c.getBookingRulesStatus(now).state, 'INVALID', v);
  });
});

test('施行前の既存BUFFER_MINUTES実値（20）は維持され、施行後は実値に関わらず30', function () {
  var props = { BUFFER_MINUTES: '20' };
  props[KEY] = EFFECTIVE;
  var c = load(props);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS - 1000)).bufferMinutes, 20);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS)).bufferMinutes, 30);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS + 1000)).bufferMinutes, 30);
});

test('施行日時の1秒前/ちょうど/1秒後で切り替わる（既定15→30）。BUFFER_MINUTES既定値は15のまま', function () {
  var props = {};
  props[KEY] = EFFECTIVE;
  var c = load(props);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS - 1000)).bufferMinutes, 15);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS)).bufferMinutes, 30);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS + 1000)).bufferMinutes, 30);
  assert.strictEqual(c.getBookingRulesStatus(new Date(EFFECTIVE_MS - 1000)).state, 'PENDING');
  assert.strictEqual(c.getBookingRulesStatus(new Date(EFFECTIVE_MS)).state, 'EFFECTIVE');
  assert.strictEqual(load({}).getAvailabilityConfig().bufferMinutes, 15);
});

test('BUFFER_MINUTES不正値でも施行前は従来どおりNaN（fail-closed）、施行後は30固定', function () {
  var props = { BUFFER_MINUTES: 'abc' };
  props[KEY] = EFFECTIVE;
  var c = load(props);
  assert.ok(isNaN(c.getAvailabilityConfig(new Date(EFFECTIVE_MS - 1000)).bufferMinutes));
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS)).bufferMinutes, 30);
});

test('空き判定: 施行後は30分ちょうどが可、29分59秒（分単位の判定では29分）は不可', function () {
  var sb = loadBookingSandbox(['BookingWindow.gs', 'Availability.gs', 'Config.gs'], {
    PropertiesService: stubs.createPropertiesServiceStub((function () { var o = {}; o[KEY] = EFFECTIVE; return o; })())
  });
  var busy = [{ startMinutes: 600, endMinutes: 720, allDay: false }];
  var after = sb.BookingConfig.getAvailabilityConfig(new Date(EFFECTIVE_MS)).bufferMinutes;
  var before = sb.BookingConfig.getAvailabilityConfig(new Date(EFFECTIVE_MS - 1000)).bufferMinutes;
  assert.strictEqual(sb.BookingAvailability.isStartTimeBookable(750, 60, busy, after), true, '12:30開始=終了12:00+30分ちょうど');
  assert.strictEqual(sb.BookingAvailability.isStartTimeBookable(749, 60, busy, after), false, '29分後は不可');
  assert.strictEqual(sb.BookingAvailability.isStartTimeBookable(735, 60, busy, before), true, '施行前は15分後で可');
});

test('存在しない暦日（11/31・2/30・非閏年2/29）や範囲外の時刻はINVALIDで従来ルール維持、閏日・Z・オフセット付きは受理する', function () {
  var later = new Date(Date.parse('2030-12-05T00:00:00+09:00'));
  ['2026-11-31T00:00:00+09:00', '2026-02-30T00:00:00+09:00', '2027-02-29T00:00:00+09:00', '2026-00-10T00:00:00+09:00',
    '2026-11-19T24:00:00+09:00', '2026-11-19T00:60:00+09:00', '2026-11-19T00:00:60+09:00', '2026-11-19T00:00:00+24:00'].forEach(function (v) {
    var props = {}; props[KEY] = v;
    var c = load(props);
    assert.strictEqual(c.getBookingRulesStatus(later).state, 'INVALID', v);
    assert.strictEqual(c.getAvailabilityConfig(later).bufferMinutes, 15, v);
  });
  ['2028-02-29T00:00:00+09:00', '2026-11-19T00:00:00Z', '2026-11-19T00:00:00+09:00', '2026-11-19T00:00:00-05:30'].forEach(function (v) {
    var props = {}; props[KEY] = v;
    assert.strictEqual(load(props).getBookingRulesStatus(new Date(Date.parse(v) + 1000)).state, 'EFFECTIVE', v);
  });
});

var SLOT_KEY = 'BOOKING_SLOT_STEP_2026_11_EFFECTIVE_AT';

test('開始候補の刻み: 未設定・不正は従来のSLOT_STEP_MINUTES（既定15）。既定値は変更しない', function () {
  assert.strictEqual(load({}).getAvailabilityConfig(new Date(EFFECTIVE_MS + 86400000)).slotStepMinutes, 15);
  var props = {}; props[SLOT_KEY] = '2026-11-31T00:00:00+09:00';
  var c = load(props);
  assert.strictEqual(c.getAvailabilityConfig(new Date('2030-01-01T00:00:00Z')).slotStepMinutes, 15);
  assert.strictEqual(c.getSlotStepRulesStatus(new Date()).state, 'INVALID');
});

test('開始候補の刻み: 施行日時の1秒前/ちょうど/1秒後で15→30分に切り替わり、SLOT_STEP_MINUTESの値に関わらず30固定', function () {
  var props = { SLOT_STEP_MINUTES: '10' }; props[SLOT_KEY] = EFFECTIVE;
  var c = load(props);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS - 1000)).slotStepMinutes, 10);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS)).slotStepMinutes, 30);
  assert.strictEqual(c.getAvailabilityConfig(new Date(EFFECTIVE_MS + 1000)).slotStepMinutes, 30);
});

test('開始候補の刻みと予約間隔の施行日時は独立（片方だけ施行できる）', function () {
  var onlyBuffer = {}; onlyBuffer[KEY] = EFFECTIVE;
  var cb = load(onlyBuffer), t = new Date(EFFECTIVE_MS + 1000);
  assert.strictEqual(cb.getAvailabilityConfig(t).bufferMinutes, 30);
  assert.strictEqual(cb.getAvailabilityConfig(t).slotStepMinutes, 15);
  var onlySlot = {}; onlySlot[SLOT_KEY] = EFFECTIVE;
  var cs = load(onlySlot);
  assert.strictEqual(cs.getAvailabilityConfig(t).bufferMinutes, 15);
  assert.strictEqual(cs.getAvailabilityConfig(t).slotStepMinutes, 30);
});

test('候補生成: 施行後は00分/30分の開始のみ。10:30開始・2時間→12:30終了→次は13:00開始可、12:30開始不可（刻みとバッファーは別々）', function () {
  var props = {}; props[KEY] = EFFECTIVE; props[SLOT_KEY] = EFFECTIVE;
  var sb = loadBookingSandbox(['BookingWindow.gs', 'Availability.gs', 'Config.gs'], { PropertiesService: stubs.createPropertiesServiceStub(props) });
  var cfg = sb.BookingConfig.getAvailabilityConfig(new Date(EFFECTIVE_MS + 1000));
  var busy = [{ startMinutes: 630, endMinutes: 750, allDay: false }]; /* 10:30-12:30 */
  var times = sb.BookingAvailability.computeBookableStartTimes(60, busy, cfg);
  assert.ok(times.every(function (t) { return /:(00|30)$/.test(t); }), times.join(','));
  assert.ok(times.indexOf('13:00') !== -1, '30分バッファーちょうどの13:00は可');
  assert.ok(times.indexOf('12:30') === -1 && times.indexOf('12:45') === -1);
  assert.ok(times.indexOf('08:00') !== -1 && times.indexOf('22:00') !== -1, '営業時間端');
  var before = sb.BookingConfig.getAvailabilityConfig(new Date(EFFECTIVE_MS - 1000));
  var legacy = sb.BookingAvailability.computeBookableStartTimes(60, [], before);
  assert.ok(legacy.indexOf('08:15') !== -1 && legacy.indexOf('08:45') !== -1, '施行前は15分刻み');
});
