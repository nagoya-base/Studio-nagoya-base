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

test('doGet: durationMinutesは文字列全体が正の整数のときだけ受理する（"120abc"や"120.9"は120として通さない）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  ['120abc', '120.9', '0', '-5', ' 120', '120 ', '007', ''].forEach(function (rawValue) {
    var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: rawValue });
    assert.strictEqual(body.success, false, JSON.stringify(rawValue) + ' は正の整数として拒否されるべき');
    assert.strictEqual(body.error.code, 'INVALID_DURATION');
  });
});

test('doGet: Script Propertiesの数値項目が不正な場合はfail-closedにINVALID_CONFIGを返し、Calendarへ問い合わせない（BUFFER_MINUTES誤設定で既存予約を空き扱いする事故を防ぐ）', function () {
  var calendarQueried = false;
  var calendarsById = {
    cal1: {
      get events() {
        calendarQueried = true;
        return [];
      }
    }
  };

  var body1 = callDoGet(
    loadCode({ CALENDAR_ID: 'cal1', BUFFER_MINUTES: 'abc' }, calendarsById),
    { date: '2026-10-01', durationMinutes: '120' }
  );
  assert.strictEqual(body1.success, false);
  assert.strictEqual(body1.error.code, 'INVALID_CONFIG');
  assert.strictEqual(calendarQueried, false, 'BUFFER_MINUTES=abc(NaN)のままCalendarを問い合わせてはいけない');
});

test('doGet: SLOT_STEP_MINUTES=0はINVALID_CONFIGで拒否し、無限ループ相当のタイムアウトを起こさない', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1', SLOT_STEP_MINUTES: '0' }, { cal1: { events: [] } });
  var start = Date.now();
  var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120' });
  assert.ok(Date.now() - start < 1000, 'SLOT_STEP_MINUTES=0でハングしてはいけない');
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'INVALID_CONFIG');
});

test('doGet: OPEN_TIME >= CLOSE_TIMEの誤設定はINVALID_CONFIGになる', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1', OPEN_TIME: '23:00', CLOSE_TIME: '08:00' }, { cal1: { events: [] } });
  var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120' });
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'INVALID_CONFIG');
});

test('doGet: Script Propertiesの数値項目が"15abc"のような部分一致混じりでもINVALID_CONFIGになり、Calendarへ問い合わせない', function () {
  var calendarQueried = false;
  var calendarsById = {
    cal1: {
      get events() {
        calendarQueried = true;
        return [];
      }
    }
  };

  [
    { MIN_BOOKING_MINUTES: '120foo' },
    { BUFFER_MINUTES: '15abc' },
    { SLOT_STEP_MINUTES: '15xyz' },
    { BUFFER_MINUTES: '15.5' }
  ].forEach(function (badProperty) {
    var properties = Object.assign({ CALENDAR_ID: 'cal1' }, badProperty);
    var body = callDoGet(loadCode(properties, calendarsById), { date: '2026-10-01', durationMinutes: '120' });
    assert.strictEqual(body.success, false, JSON.stringify(badProperty) + ' はINVALID_CONFIGとして拒否されるべき');
    assert.strictEqual(body.error.code, 'INVALID_CONFIG');
  });
  assert.strictEqual(calendarQueried, false);
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

test('doGet: getAvailabilityの配線はIssue #268実装後も変化しない（既存フォーム・既存挙動を壊さない）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var body = callDoGet(sandbox, { date: '2026-10-01', durationMinutes: '120', brand: 'studio_x' });
  assert.strictEqual(body.success, true);
});

/* doPost(createBooking)自体の配線・部分失敗補償・rate limit等はBooking関連の
   全ファイルを読み込むtest/booking-create-booking.test.js側で検証する。
   このファイル（Config/CalendarRepository/Availability/Codeのみ読み込み）では、
   doPostがCode.gsに存在すること自体だけを確認する（Issue #266時点ではdoPost自体が
   存在しなかったが、#268で追加された）。 */
test('doPost: Issue #268でcreateBooking用のdoPostが追加されている', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  assert.strictEqual(typeof sandbox.doPost, 'function');
});
