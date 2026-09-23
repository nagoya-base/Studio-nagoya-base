/*
 * gas/booking/shared/CalendarRepository.gs のテスト。CalendarApp / Utilitiesはスタブする
 * （実際のGoogle Calendarにはアクセスしない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

function loadRepository(calendarsById) {
  var sandbox = loadBookingSandbox(['CalendarRepository.gs'], {
    CalendarApp: stubs.createCalendarAppStub(calendarsById || {}),
    Utilities: stubs.createUtilitiesStub()
  });
  return sandbox.CalendarRepository;
}

test('時間指定イベントは当日00:00からの経過分に変換される', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-01T10:00:00+09:00'),
    end: new Date('2026-10-01T12:00:00+09:00'),
    isAllDay: false
  });
  var CalendarRepository = loadRepository({ cal1: { events: [event] } });
  var result = CalendarRepository.getBusyIntervalsForDate('cal1', '2026-10-01', 'Asia/Tokyo');
  /* vmサンドボックス（別realm）で生成された配列・オブジェクトのため、非strict deepEqualで比較する。 */
  assert.deepEqual(result, [{ startMinutes: 600, endMinutes: 720, isAllDay: false }]);
});

test('終日イベントはisAllDay:trueとして返し、開始・終了分は判定に使わない値にする', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-01T00:00:00+09:00'),
    end: new Date('2026-10-02T00:00:00+09:00'),
    isAllDay: true
  });
  var CalendarRepository = loadRepository({ cal1: { events: [event] } });
  var result = CalendarRepository.getBusyIntervalsForDate('cal1', '2026-10-01', 'Asia/Tokyo');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].isAllDay, true);
});

test('前日から続く時間指定イベントは対象日の0分にクランプする', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-09-30T22:00:00+09:00'),
    end: new Date('2026-10-01T02:00:00+09:00'),
    isAllDay: false
  });
  var CalendarRepository = loadRepository({ cal1: { events: [event] } });
  var result = CalendarRepository.getBusyIntervalsForDate('cal1', '2026-10-01', 'Asia/Tokyo');
  assert.strictEqual(result[0].startMinutes, 0);
  assert.strictEqual(result[0].endMinutes, 120);
});

test('翌日へまたぐ時間指定イベントは対象日の1440分にクランプする', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-01T22:00:00+09:00'),
    end: new Date('2026-10-02T02:00:00+09:00'),
    isAllDay: false
  });
  var CalendarRepository = loadRepository({ cal1: { events: [event] } });
  var result = CalendarRepository.getBusyIntervalsForDate('cal1', '2026-10-01', 'Asia/Tokyo');
  assert.strictEqual(result[0].startMinutes, 22 * 60);
  assert.strictEqual(result[0].endMinutes, 24 * 60);
});

test('存在しないCalendar IDに対してはエラーを投げる', function () {
  var CalendarRepository = loadRepository({});
  assert.throws(function () {
    CalendarRepository.getBusyIntervalsForDate('missing-cal', '2026-10-01', 'Asia/Tokyo');
  });
});

/*
 * getBusyIntervalsForRange（Issue #318: 月間空き状況）。calendar.getEvents()の呼び出しが
 * 区間全体で1回だけになること、日ごとの振り分けがgetBusyIntervalsForDateと同じ規則
 * （時間指定イベントの分換算・対象日クランプ・終日イベントの扱い）になることを検証する。
 */
test('getBusyIntervalsForRange: calendar.getEvents()の呼び出しは区間全体で1回だけ（1日ごとに呼ばない）', function () {
  var callCount = 0;
  var calendarsById = {
    cal1: {
      get events() {
        callCount += 1;
        return [];
      }
    }
  };
  var CalendarRepository = loadRepository(calendarsById);
  CalendarRepository.getBusyIntervalsForRange('cal1', '2026-10-01', '2026-10-31', 'Asia/Tokyo');
  assert.strictEqual(callCount, 1, '月内でgetEvents()は1回だけ呼ばれるべき');
});

test('getBusyIntervalsForRange: 区間内の全日付ぶんのキーを返す（イベントが無い日も空配列で含む）', function () {
  var CalendarRepository = loadRepository({ cal1: { events: [] } });
  var result = CalendarRepository.getBusyIntervalsForRange('cal1', '2026-10-01', '2026-10-31', 'Asia/Tokyo');
  assert.strictEqual(Object.keys(result).length, 31);
  assert.deepEqual(result['2026-10-01'], []);
  assert.deepEqual(result['2026-10-31'], []);
});

test('getBusyIntervalsForRange: 時間指定イベントは該当日のbusyIntervalsへ、当日00:00からの経過分で振り分けられる', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-05T10:00:00+09:00'),
    end: new Date('2026-10-05T12:00:00+09:00'),
    isAllDay: false
  });
  var CalendarRepository = loadRepository({ cal1: { events: [event] } });
  var result = CalendarRepository.getBusyIntervalsForRange('cal1', '2026-10-01', '2026-10-31', 'Asia/Tokyo');
  assert.deepEqual(result['2026-10-05'], [{ startMinutes: 600, endMinutes: 720, isAllDay: false }]);
  assert.deepEqual(result['2026-10-04'], []);
  assert.deepEqual(result['2026-10-06'], []);
});

test('getBusyIntervalsForRange: 日をまたぐ時間指定イベントは前日側・当日側の両方へ、対象日の範囲へクランプして現れる', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-05T22:00:00+09:00'),
    end: new Date('2026-10-06T02:00:00+09:00'),
    isAllDay: false
  });
  var CalendarRepository = loadRepository({ cal1: { events: [event] } });
  var result = CalendarRepository.getBusyIntervalsForRange('cal1', '2026-10-01', '2026-10-31', 'Asia/Tokyo');
  assert.deepEqual(result['2026-10-05'], [{ startMinutes: 22 * 60, endMinutes: 24 * 60, isAllDay: false }]);
  assert.deepEqual(result['2026-10-06'], [{ startMinutes: 0, endMinutes: 120, isAllDay: false }]);
});

test('getBusyIntervalsForRange: 終日イベントは対象の各日でisAllDay:trueとして現れる', function () {
  var event = stubs.createEventStub({
    start: new Date('2026-10-05T00:00:00+09:00'),
    end: new Date('2026-10-07T00:00:00+09:00'),
    isAllDay: true
  });
  var CalendarRepository = loadRepository({ cal1: { events: [event] } });
  var result = CalendarRepository.getBusyIntervalsForRange('cal1', '2026-10-01', '2026-10-31', 'Asia/Tokyo');
  assert.strictEqual(result['2026-10-05'].length, 1);
  assert.strictEqual(result['2026-10-05'][0].isAllDay, true);
  assert.strictEqual(result['2026-10-06'].length, 1);
  assert.strictEqual(result['2026-10-06'][0].isAllDay, true);
  assert.deepEqual(result['2026-10-07'], [], '終日イベントの終了日（排他的境界）は含まれないべき');
  assert.deepEqual(result['2026-10-04'], []);
});

test('getBusyIntervalsForRange: 存在しないCalendar IDに対してはエラーを投げる', function () {
  var CalendarRepository = loadRepository({});
  assert.throws(function () {
    CalendarRepository.getBusyIntervalsForRange('missing-cal', '2026-10-01', '2026-10-31', 'Asia/Tokyo');
  });
});

test('管理者手入力イベント・スペースマーケット由来イベントも通常イベントと同じ扱いになる（タイトルを見ない）', function () {
  var events = [
    stubs.createEventStub({ start: new Date('2026-10-01T09:00:00+09:00'), end: new Date('2026-10-01T10:00:00+09:00'), isAllDay: false }),
    stubs.createEventStub({ start: new Date('2026-10-01T14:00:00+09:00'), end: new Date('2026-10-01T15:00:00+09:00'), isAllDay: false })
  ];
  var CalendarRepository = loadRepository({ cal1: { events: events } });
  var result = CalendarRepository.getBusyIntervalsForDate('cal1', '2026-10-01', 'Asia/Tokyo');
  assert.strictEqual(result.length, 2);
  result.forEach(function (interval) {
    assert.strictEqual(interval.isAllDay, false);
    assert.ok(!('title' in interval) && !('description' in interval), 'PIIやタイトルを含めてはいけない');
  });
});
