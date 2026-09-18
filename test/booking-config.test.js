/*
 * gas/booking/Config.gs のテスト。PropertiesServiceはスタブする。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

function loadConfig(properties) {
  var sandbox = loadBookingSandbox(['Config.gs'], {
    PropertiesService: stubs.createPropertiesServiceStub(properties || {})
  });
  return sandbox.BookingConfig;
}

test('Script Propertiesが空でも固定仕様のデフォルト値が使われる', function () {
  var BookingConfig = loadConfig({});
  var config = BookingConfig.getAvailabilityConfig();
  /* config はvmサンドボックス（別realm）で生成されたオブジェクトのため、非strict deepEqualで比較する。 */
  assert.deepEqual(config, {
    timezone: 'Asia/Tokyo',
    openTime: '08:00',
    closeTime: '23:00',
    minBookingMinutes: 120,
    bufferMinutes: 15,
    slotStepMinutes: 15
  });
});

test('Script Propertiesの値がデフォルトより優先される', function () {
  var BookingConfig = loadConfig({ OPEN_TIME: '09:00', BUFFER_MINUTES: '20' });
  var config = BookingConfig.getAvailabilityConfig();
  assert.strictEqual(config.openTime, '09:00');
  assert.strictEqual(config.bufferMinutes, 20);
  assert.strictEqual(config.closeTime, '23:00', '未設定の項目はデフォルトのまま');
});

test('CALENDAR_IDが未設定の場合はエラーを投げる', function () {
  var BookingConfig = loadConfig({});
  assert.throws(function () {
    BookingConfig.getCalendarId();
  });
});

test('CALENDAR_IDが設定されていれば取得できる', function () {
  var BookingConfig = loadConfig({ CALENDAR_ID: 'test-calendar-id@group.calendar.google.com' });
  assert.strictEqual(BookingConfig.getCalendarId(), 'test-calendar-id@group.calendar.google.com');
});

test('数値項目の誤設定はConfig.gs自体では例外にせずNaNとして返す（fail-closed判定はAvailability.gs側のvalidateInputが担う）', function () {
  var BookingConfig = loadConfig({ BUFFER_MINUTES: 'abc', SLOT_STEP_MINUTES: '0' });
  var config = BookingConfig.getAvailabilityConfig();
  assert.ok(isNaN(config.bufferMinutes));
  assert.strictEqual(config.slotStepMinutes, 0);
});
