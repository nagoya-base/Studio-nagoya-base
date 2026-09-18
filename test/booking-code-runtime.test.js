/*
 * gas/booking/ 全ファイル（Config.gs / CalendarRepository.gs / Availability.gs / Code.gs）を
 * まとめてvm実行し、doGetによるgetAvailability全体の配線がReferenceErrorなく動作すること、
 * また実際のCalendar/Script Propertiesアクセス部分をスタブに差し替えても
 * 期待通りの応答になることを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Code.gs'];

function loadCode(properties, calendarsById) {
  return loadBookingSandbox(FILES, {
    PropertiesService: stubs.createPropertiesServiceStub(properties || {}),
    CalendarApp: stubs.createCalendarAppStub(calendarsById || {}),
    Utilities: stubs.createUtilitiesStub(),
    ContentService: stubs.createContentServiceStub()
  });
}

function callDoGet(sandbox, params) {
  var output = sandbox.doGet({ parameter: params || {} });
  return JSON.parse(output.text);
}

test('doGet: 正常なリクエストでbookableStartTimesを返す（既存予約を正しく塞ぐ）', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-01T10:00:00+09:00'),
    end: new Date('2026-10-01T12:00:00+09:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [event] } });
  var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120', brand: 'studio_x' });

  assert.strictEqual(body.success, true);
  assert.strictEqual(body.brand, 'studio_x');
  assert.strictEqual(body.bookableStartTimes.indexOf('12:00'), -1);
  assert.ok(body.bookableStartTimes.indexOf('12:15') !== -1);
  /* 08:00開始・120分だと終了10:00で既存予約(10:00-12:00)と間隔0分になるため不可であるべき */
  assert.strictEqual(body.bookableStartTimes.indexOf('08:00'), -1);
});

test('doGet: 管理者が手入力したイベントも同様に塞ぐ（同じCalendar上の予定を種別で区別しない）', function () {
  var adminBlock = stubs.createEventStub({
    start: new Date('2026-10-01T13:00:00+09:00'),
    end: new Date('2026-10-01T15:00:00+09:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [adminBlock] } });
  var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120', brand: 'mens' });
  assert.strictEqual(body.bookableStartTimes.indexOf('13:00'), -1);
  assert.strictEqual(body.bookableStartTimes.indexOf('12:00'), -1, '12:00-14:00は13:00開始の予定と重なる');
});

test('doGet: SNB / mens / Studio Xで同じCalendarを参照するため空き結果が一致する', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-01T10:00:00+09:00'),
    end: new Date('2026-10-01T12:00:00+09:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [event] } });
  var snb = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120', brand: 'snb' });
  var mens = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120', brand: 'mens' });
  var studioX = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120', brand: 'studio_x' });
  assert.deepStrictEqual(snb.bookableStartTimes, mens.bookableStartTimes);
  assert.deepStrictEqual(mens.bookableStartTimes, studioX.bookableStartTimes);
});

test('doGet: 終日イベントのみの日は空き枠を占有しない', function () {
  var allDayEvent = stubs.createEventStub({
    start: new Date('2026-10-01T00:00:00+09:00'),
    end: new Date('2026-10-02T00:00:00+09:00'),
    isAllDay: true
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [allDayEvent] } });
  var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120', brand: 'studio_x' });
  assert.ok(body.bookableStartTimes.indexOf('08:00') !== -1);
  assert.ok(body.bookableStartTimes.indexOf('21:00') !== -1);
});

test('doGet: 無効な日付はバリデーションエラーを返し、Calendarへは問い合わせない', function () {
  var calendarQueried = false;
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, {
    cal1: {
      get events() {
        calendarQueried = true;
        return [];
      }
    }
  });
  var body = callDoGet(sandbox, { date: 'invalid-date', durationMinutes: '120' });
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'INVALID_DATE');
  assert.strictEqual(calendarQueried, false, '入力検証エラー時はCalendar APIを呼ばない');
});

test('doGet: 120分未満はバリデーションエラーを返す', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '60' });
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'DURATION_TOO_SHORT');
});

test('doGet: durationMinutesが未指定・数値以外でもエラーになり例外を投げない', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var body1 = callDoGet(sandbox, { date: '2026-10-01' });
  assert.strictEqual(body1.success, false);
  assert.strictEqual(body1.error.code, 'INVALID_DURATION');

  var body2 = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: 'abc' });
  assert.strictEqual(body2.success, false);
  assert.strictEqual(body2.error.code, 'INVALID_DURATION');
});

test('doGet: レスポンスはJSON MIMEタイプで返す', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var output = sandbox.doGet({ parameter: { date: '2026-10-01', durationMinutes: '120' } });
  assert.strictEqual(output.mimeType, 'JSON');
});

test('doGet: レスポンスにイベント詳細やPIIを含む余分なキーがない', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-01T10:00:00+09:00'),
    end: new Date('2026-10-01T12:00:00+09:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [event] } });
  var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120', brand: 'studio_x' });
  var allowedKeys = ['success', 'date', 'durationMinutes', 'brand', 'bookableStartTimes'];
  Object.keys(body).forEach(function (key) {
    assert.ok(allowedKeys.indexOf(key) !== -1, '想定外のキーが含まれている: ' + key);
  });
});

test('doGet: 既存フォーム(studio-x/reservation)には触れない静的な配線であることの確認（doPostは実装しない）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  assert.strictEqual(sandbox.doPost, undefined, 'Issue #266では予約作成(createBooking)を実装しない');
});
