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

test('authorizeBookingWebAppScopes: 実メールを送信せずMailApp scopeを要求し、固定のOKログだけを出す', function () {
  var spreadsheetIds = [];
  var calendarIds = [];
  var quotaCalls = 0;
  var sendEmailCalls = 0;
  var logger = stubs.createLoggerStub();
  var sandbox = loadBookingSandbox(['Code.gs'], {
    PropertiesService: stubs.createPropertiesServiceStub({
      SPREADSHEET_ID: 'spreadsheet-id-for-test',
      CALENDAR_ID: 'calendar-id-for-test'
    }),
    SpreadsheetApp: {
      openById: function (id) {
        spreadsheetIds.push(id);
        return { getId: function () { return id; } };
      }
    },
    CalendarApp: {
      getCalendarById: function (id) {
        calendarIds.push(id);
        return { getId: function () { return id; } };
      }
    },
    MailApp: {
      getRemainingDailyQuota: function () {
        quotaCalls += 1;
        return 100;
      },
      sendEmail: function () { sendEmailCalls += 1; }
    },
    Logger: logger
  });

  sandbox.authorizeBookingWebAppScopes();

  assert.deepStrictEqual(spreadsheetIds, ['spreadsheet-id-for-test']);
  assert.deepStrictEqual(calendarIds, ['calendar-id-for-test']);
  assert.strictEqual(quotaCalls, 1);
  assert.strictEqual(sendEmailCalls, 0);
  assert.deepStrictEqual(logger._logs, ['Booking Web App authorization check: OK']);
});

/* dateをAsia/Tokyo基準の'YYYY-MM-DD'へ変換する（テスト専用。本番Code.gs/Availability.gsの
   formatDateInTimezoneとは独立した実装だが、同じ変換規則を使う）。 */
function formatJstDate_(date) {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  var out = {};
  parts.forEach(function (part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

/*
 * doGet（Code.gs handleGetAvailability_）はnowを注入できず、実行時の実時刻(new Date())を
 * 基準に過去日拒否を行う（Issue #270 2回目レビュー対応）。そのため、正常系テストで
 * 利用日を固定文字列（例: '2026-10-01'）にすると、実行日がその日付を過ぎた時点で
 * 一斉にINVALID_DATEへ変わり自然故障する。実行時刻から動的に30日後を算出した
 * FUTURE_DATE（Asia/Tokyo基準）を利用日として使い、実行日から独立させる
 * （Issue #270 3回目レビュー指摘対応）。FUTURE_DATE_NEXTはその翌日
 * （終日イベントが日をまたぐテスト用）。 */
var FUTURE_BASE_MILLIS = Date.now() + 30 * 24 * 3600000;
var FUTURE_DATE = formatJstDate_(new Date(FUTURE_BASE_MILLIS));
var FUTURE_DATE_NEXT = formatJstDate_(new Date(FUTURE_BASE_MILLIS + 24 * 3600000));

/* FUTURE_DATE上の'HH:mm'をJSTのDateへ変換する（Calendarイベントのstart/end用）。 */
function atFutureTime_(hhmm) {
  return new Date(FUTURE_DATE + 'T' + hhmm + ':00+09:00');
}

test('doGet: 正常なリクエストでbookableStartTimesを返す（既存予約を正しく塞ぐ）', function () {
  var event = stubs.createEventStub({
    start: atFutureTime_('10:00'),
    end: atFutureTime_('12:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [event] } });
  var body = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120', brand: 'studio_x' });

  assert.strictEqual(body.success, true);
  assert.strictEqual(body.brand, 'studio_x');
  assert.strictEqual(body.bookableStartTimes.indexOf('12:00'), -1);
  assert.ok(body.bookableStartTimes.indexOf('12:15') !== -1);
  /* 08:00開始・120分だと終了10:00で既存予約(10:00-12:00)と間隔0分になるため不可であるべき */
  assert.strictEqual(body.bookableStartTimes.indexOf('08:00'), -1);
});

test('doGet: 管理者が手入力したイベントも同様に塞ぐ（同じCalendar上の予定を種別で区別しない）', function () {
  var adminBlock = stubs.createEventStub({
    start: atFutureTime_('13:00'),
    end: atFutureTime_('15:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [adminBlock] } });
  var body = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120', brand: 'mens' });
  assert.strictEqual(body.bookableStartTimes.indexOf('13:00'), -1);
  assert.strictEqual(body.bookableStartTimes.indexOf('12:00'), -1, '12:00-14:00は13:00開始の予定と重なる');
});

test('doGet: SNB / mens / Studio Xで同じCalendarを参照するため空き結果が一致する', function () {
  var event = stubs.createEventStub({
    start: atFutureTime_('10:00'),
    end: atFutureTime_('12:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [event] } });
  var snb = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120', brand: 'snb' });
  var mens = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120', brand: 'mens' });
  var studioX = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120', brand: 'studio_x' });
  assert.deepStrictEqual(snb.bookableStartTimes, mens.bookableStartTimes);
  assert.deepStrictEqual(mens.bookableStartTimes, studioX.bookableStartTimes);
});

test('doGet: 終日イベントのみの日は空き枠を占有しない', function () {
  var allDayEvent = stubs.createEventStub({
    start: atFutureTime_('00:00'),
    end: new Date(FUTURE_DATE_NEXT + 'T00:00:00+09:00'),
    isAllDay: true
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [allDayEvent] } });
  var body = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120', brand: 'studio_x' });
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
    start: atFutureTime_('10:00'),
    end: atFutureTime_('12:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [event] } });
  var body = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120', brand: 'studio_x' });
  var allowedKeys = ['success', 'date', 'durationMinutes', 'brand', 'bookableStartTimes'];
  Object.keys(body).forEach(function (key) {
    assert.ok(allowedKeys.indexOf(key) !== -1, '想定外のキーが含まれている: ' + key);
  });
});

test('doGet: getAvailabilityの配線はIssue #268実装後も変化しない（既存フォーム・既存挙動を壊さない）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var body = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120', brand: 'studio_x' });
  assert.strictEqual(body.success, true);
});

/*
 * doGet: action=monthly（Issue #318 getMonthlyAvailability）の配線テスト。
 * 日ごとのステータス判定自体はtest/booking-monthly-availability.test.jsで検証済みのため、
 * ここではCode.gsの配線（action分岐・calendar.getEvents()が月内で1回だけ・
 * バリデーション・JSON出力）だけを確認する。
 */
test('doGet: action=monthlyでgetMonthlyAvailabilityへ配線される。calendar.getEvents()は月内で1回だけ', function () {
  var getEventsCallCount = 0;
  var calendarsById = {
    cal1: {
      get events() {
        getEventsCallCount += 1;
        return [];
      }
    }
  };
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, calendarsById);
  var body = callDoGet(sandbox, { action: 'monthly', year: '2026', month: '10', durationMinutes: '120', brand: 'studio_x' });

  assert.strictEqual(body.success, true);
  assert.strictEqual(body.month, '2026-10');
  assert.strictEqual(body.brand, 'studio_x');
  assert.strictEqual(Object.keys(body.days).length, 31);
  assert.strictEqual(getEventsCallCount, 1, '月間取得でCalendar.getEvents()は1回だけ呼ばれるべき（31回連続アクセス禁止）');
});

test('doGet: action=monthlyは無効な年月・利用時間をバリデーションエラーとして返し、Calendarへ問い合わせない', function () {
  var calendarQueried = false;
  var calendarsById = {
    cal1: {
      get events() {
        calendarQueried = true;
        return [];
      }
    }
  };
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, calendarsById);

  var badMonth = callDoGet(sandbox, { action: 'monthly', year: '2026', month: '13', durationMinutes: '120' });
  assert.strictEqual(badMonth.success, false);
  assert.strictEqual(badMonth.error.code, 'INVALID_MONTH');

  var badDuration = callDoGet(sandbox, { action: 'monthly', year: '2026', month: '10', durationMinutes: '60' });
  assert.strictEqual(badDuration.success, false);
  assert.strictEqual(badDuration.error.code, 'DURATION_TOO_SHORT');

  assert.strictEqual(calendarQueried, false, 'バリデーションエラー時はCalendar APIを呼ばない');
});

test('doGet: action=monthlyは既存の空きを正しく塞ぐ（単日getAvailabilityと同じCalendarデータを参照する）', function () {
  var event = stubs.createEventStub({
    start: atFutureTime_('10:00'),
    end: atFutureTime_('12:00'),
    isAllDay: false
  });
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [event] } });
  var parts = FUTURE_DATE.split('-');
  var body = callDoGet(sandbox, {
    action: 'monthly', year: parts[0], month: String(parseInt(parts[1], 10)), durationMinutes: '120', brand: 'snb'
  });
  assert.strictEqual(body.success, true);
  assert.ok(body.days[FUTURE_DATE].availableStartTimes < 53, '既存予約があるため完全空き日より件数が減るべき');
});

test('doGet: レスポンスはJSON MIMEタイプで返す（action=monthly）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var output = sandbox.doGet({ parameter: { action: 'monthly', year: '2026', month: '10', durationMinutes: '120' } });
  assert.strictEqual(output.mimeType, 'JSON');
});

/*
 * doGet: action=monthlyのtimeBandパラメータ配線テスト（Issue #324）。
 * timeBandの絞り込みロジック自体はtest/booking-monthly-availability.test.jsで
 * 検証済みのため、ここではparams.timeBandがhandleGetMonthlyAvailability_を経由して
 * 実際にBookingAvailability.getMonthlyAvailabilityへ渡ることだけを確認する。
 */
test('doGet: action=monthlyはtimeBandクエリパラメータをgetMonthlyAvailabilityへ渡す（6時間利用+eveningは0件でFULL）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var body = callDoGet(sandbox, {
    action: 'monthly', year: '2026', month: '10', durationMinutes: '360', brand: 'studio_x', timeBand: 'evening'
  });
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.days['2026-10-01'].status, 'FULL');
  assert.strictEqual(body.days['2026-10-01'].availableStartTimes, 0);
});

test('doGet: action=monthlyはtimeBand未指定・不正値をallへフォールバックする（デプロイ過渡期の旧フロント互換）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var withoutTimeBand = callDoGet(sandbox, { action: 'monthly', year: '2026', month: '10', durationMinutes: '120' });
  var withExplicitAll = callDoGet(sandbox, { action: 'monthly', year: '2026', month: '10', durationMinutes: '120', timeBand: 'all' });
  var withInvalidTimeBand = callDoGet(sandbox, { action: 'monthly', year: '2026', month: '10', durationMinutes: '120', timeBand: 'bogus' });

  assert.strictEqual(withoutTimeBand.success, true);
  assert.deepStrictEqual(withoutTimeBand.days, withExplicitAll.days);
  assert.deepStrictEqual(withInvalidTimeBand.days, withExplicitAll.days);
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

/*
 * doGet（getAvailability）は本番実行時、内部でnow省略時デフォルト（現在時刻）を使う
 * ため、固定nowを直接注入するテストはBookingAvailability.getAvailability自体に対して
 * test/booking-availability.test.jsで行う。ここでは、doGetの配線自体が壊れていないこと
 * （実行時点から十分未来の日付では当日フィルタが働かず、従来どおり08:00から候補が
 * 出ること）だけを確認する（Issue #270レビュー対応。日付はFUTURE_DATEで動的に算出し、
 * 実行日から独立させる。3回目レビュー指摘対応）。
 */
test('doGet: 実行時点から十分未来の日付を指定した場合は、当日フィルタが働かず従来どおり08:00から候補が出る', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, { cal1: { events: [] } });
  var body = callDoGet(sandbox, { date: FUTURE_DATE, durationMinutes: '120' });
  assert.strictEqual(body.success, true);
  assert.ok(body.bookableStartTimes.indexOf('08:00') !== -1);
});

/*
 * 過去日はINVALID_DATEで拒否し、bookableStartTimesを返さない（2回目レビュー指摘対応）。
 * doGet（Code.gs）はnowを注入できないため、実行時の実時刻を基準に「確実に過去」と
 * 言える日付（2020-01-01固定）を使う。handleGetAvailability_がCalendarを取得する前に
 * 拒否することも、Calendar呼び出し有無を検知するスタブで併せて確認する。
 */
test('doGet: 過去日はINVALID_DATEで拒否し、bookableStartTimesを返さない。Calendar取得前に拒否する（handleGetAvailability_のCalendar呼び出し前チェック）', function () {
  var calendarQueried = false;
  var calendarsById = {
    cal1: {
      get events() {
        calendarQueried = true;
        return [];
      }
    }
  };
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' }, calendarsById);
  var body = callDoGet(sandbox, { date: '2020-01-01', durationMinutes: '120', brand: 'snb' });

  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'INVALID_DATE');
  assert.strictEqual(body.bookableStartTimes, undefined);
  assert.strictEqual(calendarQueried, false, '過去日はCalendarへ問い合わせる前に拒否するべき');
});
