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

test('数値項目は文字列全体が厳密な整数のときだけ数値化し、末尾・先頭に余計な文字があればNaNにする（"15abc"を15として通さない）', function () {
  var invalidValues = ['15abc', '120foo', '15xyz', '15.5', ' 15', '15 ', '1e3', '0x0F', '十五', ''];
  invalidValues.forEach(function (rawValue) {
    var BookingConfig = loadConfig({
      MIN_BOOKING_MINUTES: rawValue,
      BUFFER_MINUTES: rawValue,
      SLOT_STEP_MINUTES: rawValue
    });
    var config = BookingConfig.getAvailabilityConfig();
    if (rawValue === '') {
      // 空文字はプロパティ未設定と同じ扱いでデフォルト値になる（readProperty_の既存仕様）。
      assert.strictEqual(config.minBookingMinutes, 120, JSON.stringify(rawValue));
      assert.strictEqual(config.bufferMinutes, 15, JSON.stringify(rawValue));
      assert.strictEqual(config.slotStepMinutes, 15, JSON.stringify(rawValue));
      return;
    }
    assert.ok(isNaN(config.minBookingMinutes), 'MIN_BOOKING_MINUTES=' + JSON.stringify(rawValue) + ' はNaNになるべき');
    assert.ok(isNaN(config.bufferMinutes), 'BUFFER_MINUTES=' + JSON.stringify(rawValue) + ' はNaNになるべき');
    assert.ok(isNaN(config.slotStepMinutes), 'SLOT_STEP_MINUTES=' + JSON.stringify(rawValue) + ' はNaNになるべき');
  });
});

test('数値項目は先頭0を持たない/持つ通常の整数文字列なら正しく数値化する', function () {
  var BookingConfig = loadConfig({ MIN_BOOKING_MINUTES: '90', BUFFER_MINUTES: '0', SLOT_STEP_MINUTES: '30' });
  var config = BookingConfig.getAvailabilityConfig();
  assert.strictEqual(config.minBookingMinutes, 90);
  assert.strictEqual(config.bufferMinutes, 0);
  assert.strictEqual(config.slotStepMinutes, 30);
});

test('getTtlConfig: Script Propertiesが空でも固定仕様のデフォルト値が使われる（Issue #270でminHoldHours/timezoneを追加）', function () {
  var BookingConfig = loadConfig({});
  var config = BookingConfig.getTtlConfig();
  assert.deepEqual(config, {
    ttlHours: 24,
    minHoursBeforeStart: 2,
    minHoldHours: 2,
    timezone: 'Asia/Tokyo'
  });
});

test('getTtlConfig: PENDING_TTL_MIN_HOLD_HOURSはScript Propertiesで変更でき、誤設定（数値以外・0以下）は例外にせずデフォルトへフォールバックする（Issue #270）', function () {
  var overridden = loadConfig({ PENDING_TTL_MIN_HOLD_HOURS: '3' }).getTtlConfig();
  assert.strictEqual(overridden.minHoldHours, 3);

  ['abc', '0', '-1', ''].forEach(function (rawValue) {
    var config = loadConfig({ PENDING_TTL_MIN_HOLD_HOURS: rawValue }).getTtlConfig();
    assert.strictEqual(config.minHoldHours, 2, JSON.stringify(rawValue) + ' はデフォルト値(2)へフォールバックするべき');
  });
});

test('getTtlConfig: timezoneはTIMEZONEプロパティと共有される（expirePendingBookingsの当日判定に使う）', function () {
  var BookingConfig = loadConfig({ TIMEZONE: 'Asia/Tokyo' });
  assert.strictEqual(BookingConfig.getTtlConfig().timezone, 'Asia/Tokyo');
  assert.strictEqual(BookingConfig.getAvailabilityConfig().timezone, 'Asia/Tokyo');
});
