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
