/*
 * gas/booking/shared/Availability.gs の getMonthlyAvailability（Issue #318: 月間空き状況）の
 * テスト。日ごとのステータスは既存のcomputeBookableStartTimesの結果件数を閾値で
 * バケット分けするだけであることを検証する（スロット生成ロジック自体は
 * test/booking-availability.test.jsで別途検証済みのため、ここでは再検証しない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var DEFAULT_CONFIG = {
  timezone: 'Asia/Tokyo',
  openTime: '08:00',
  closeTime: '23:00',
  minBookingMinutes: 120,
  bufferMinutes: 15,
  slotStepMinutes: 15
};

/* このファイルの日付リテラルは実行時の実時刻に依存しない固定の未来月を使う
   （test/booking-availability.test.jsのGENERIC_NOWと同じ方針）。 */
var NOW = new Date('2026-01-01T00:00:00+09:00');

function busy(startMinutes, endMinutes) {
  return { startMinutes: startMinutes, endMinutes: endMinutes, isAllDay: false };
}

function loadAvailability() {
  return loadBookingSandbox(['Availability.gs'], {}).BookingAvailability;
}

/* classifyDayStatus_相当の期待値をテスト側でも独立に計算する（Availability.gs本体の
   閾値定義コメントと同じ式: ratio<=1/3→LIMITED, ratio>=2/3→AVAILABLE_HIGH, それ以外→AVAILABLE）。 */
function expectedStatus(BookingAvailability, durationMinutes, busyIntervals, config, minimumStartMinutes) {
  var count = BookingAvailability.computeBookableStartTimes(durationMinutes, busyIntervals, config, minimumStartMinutes).length;
  var maxPossible = BookingAvailability.computeBookableStartTimes(durationMinutes, [], config, minimumStartMinutes).length;
  if (count <= 0 || maxPossible <= 0) return BookingAvailability.DAY_STATUS.FULL;
  var ratio = count / maxPossible;
  if (ratio <= 1 / 3) return BookingAvailability.DAY_STATUS.LIMITED;
  if (ratio >= 2 / 3) return BookingAvailability.DAY_STATUS.AVAILABLE_HIGH;
  return BookingAvailability.DAY_STATUS.AVAILABLE;
}

test('DAY_STATUSは5値のenumとして公開される', function () {
  var BookingAvailability = loadAvailability();
  assert.deepStrictEqual(Object.keys(BookingAvailability.DAY_STATUS).sort(), [
    'AVAILABLE', 'AVAILABLE_HIGH', 'FULL', 'LIMITED', 'OUT_OF_RANGE'
  ]);
});

test('全く空きが無い日はFULL、既存予約が一切ない日はAVAILABLE_HIGHになる', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120 },
    { '2026-10-01': [busy(480, 1380)], '2026-10-02': [] },
    DEFAULT_CONFIG,
    NOW
  );
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.days['2026-10-01'].status, 'FULL');
  assert.strictEqual(result.days['2026-10-01'].availableStartTimes, 0);
  assert.strictEqual(result.days['2026-10-02'].status, 'AVAILABLE_HIGH');
  assert.strictEqual(result.days['2026-10-02'].availableStartTimes, 53);
});

test('残り枠が少ない日はLIMITED、中間程度の日はAVAILABLEになる（閾値どおりに分類される）', function () {
  var BookingAvailability = loadAvailability();
  var busyLimited = [busy(8 * 60, 20 * 60)]; /* 08:00-20:00埋まっている想定 */
  var busyMid = [busy(8 * 60, 14 * 60)]; /* 08:00-14:00埋まっている想定 */

  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120 },
    { '2026-10-01': busyLimited, '2026-10-02': busyMid },
    DEFAULT_CONFIG,
    NOW
  );

  assert.strictEqual(
    result.days['2026-10-01'].status,
    expectedStatus(BookingAvailability, 120, busyLimited, DEFAULT_CONFIG, null)
  );
  assert.strictEqual(
    result.days['2026-10-02'].status,
    expectedStatus(BookingAvailability, 120, busyMid, DEFAULT_CONFIG, null)
  );
});

test('過去日はOUT_OF_RANGEになり、availableStartTimesは0', function () {
  var BookingAvailability = loadAvailability();
  var now = new Date('2026-10-15T10:00:00+09:00');
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120 },
    {},
    DEFAULT_CONFIG,
    now
  );
  assert.strictEqual(result.days['2026-10-01'].status, 'OUT_OF_RANGE');
  assert.strictEqual(result.days['2026-10-14'].status, 'OUT_OF_RANGE');
  assert.notStrictEqual(result.days['2026-10-15'].status, 'OUT_OF_RANGE', '当日はOUT_OF_RANGEではない');
});

test('当日は現在時刻より後の候補だけで判定する（getAvailabilityと同じminimumStartMinutes規則）', function () {
  var BookingAvailability = loadAvailability();
  var now = new Date('2026-10-15T21:00:00+09:00'); /* 21:00時点。120分利用だと21:00以降しか候補が無い */
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120 },
    {},
    DEFAULT_CONFIG,
    now
  );
  var minimumStartMinutes = BookingAvailability.getCurrentMinutesInTimezone(now, 'Asia/Tokyo');
  var expectedCount = BookingAvailability.computeBookableStartTimes(120, [], DEFAULT_CONFIG, minimumStartMinutes).length;
  assert.strictEqual(result.days['2026-10-15'].availableStartTimes, expectedCount);
  assert.notStrictEqual(expectedCount, 53, '当日は現在時刻フィルタにより完全空き日より件数が減るべき');
});

test('全31日ぶんのキーを返す（10月）。28/29/30/31日の月も日数どおりのキー数になる', function () {
  var BookingAvailability = loadAvailability();
  var oct = BookingAvailability.getMonthlyAvailability({ year: 2026, month: 10, durationMinutes: 120 }, {}, DEFAULT_CONFIG, NOW);
  assert.strictEqual(Object.keys(oct.days).length, 31);
  assert.strictEqual(oct.month, '2026-10');

  var apr = BookingAvailability.getMonthlyAvailability({ year: 2026, month: 4, durationMinutes: 120 }, {}, DEFAULT_CONFIG, NOW);
  assert.strictEqual(Object.keys(apr.days).length, 30);

  var feb2026 = BookingAvailability.getMonthlyAvailability({ year: 2026, month: 2, durationMinutes: 120 }, {}, DEFAULT_CONFIG, NOW);
  assert.strictEqual(Object.keys(feb2026.days).length, 28, '2026年は閏年ではない');

  var feb2028 = BookingAvailability.getMonthlyAvailability({ year: 2028, month: 2, durationMinutes: 120 }, {}, DEFAULT_CONFIG, NOW);
  assert.strictEqual(Object.keys(feb2028.days).length, 29, '2028年は閏年');
});

test('年跨ぎ（12月→1月）でも正しい日数・月文字列になる', function () {
  var BookingAvailability = loadAvailability();
  var dec = BookingAvailability.getMonthlyAvailability({ year: 2026, month: 12, durationMinutes: 120 }, {}, DEFAULT_CONFIG, NOW);
  assert.strictEqual(dec.month, '2026-12');
  assert.strictEqual(Object.keys(dec.days).length, 31);

  var jan = BookingAvailability.getMonthlyAvailability({ year: 2027, month: 1, durationMinutes: 120 }, {}, DEFAULT_CONFIG, NOW);
  assert.strictEqual(jan.month, '2027-01');
  assert.strictEqual(Object.keys(jan.days).length, 31);
});

test('brandはそのままエコーバックされる（空き判定には使わない）', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, brand: 'studio_x' },
    {},
    DEFAULT_CONFIG,
    NOW
  );
  assert.strictEqual(result.brand, 'studio_x');
});

test('不正な年月はINVALID_MONTHで拒否する', function () {
  var BookingAvailability = loadAvailability();
  [
    { year: 2026, month: 0 },
    { year: 2026, month: 13 },
    { year: 2026, month: '10' },
    { year: NaN, month: 10 },
    { year: 2026, month: NaN },
    { year: undefined, month: undefined }
  ].forEach(function (req) {
    var result = BookingAvailability.getMonthlyAvailability(
      { year: req.year, month: req.month, durationMinutes: 120 }, {}, DEFAULT_CONFIG, NOW
    );
    assert.strictEqual(result.success, false, JSON.stringify(req) + ' はINVALID_MONTHとして拒否されるべき');
    assert.strictEqual(result.error.code, 'INVALID_MONTH');
  });
});

test('durationMinutesが不正な場合はgetAvailabilityと同じerror.codeになる', function () {
  var BookingAvailability = loadAvailability();
  var invalidDuration = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 0 }, {}, DEFAULT_CONFIG, NOW
  );
  assert.strictEqual(invalidDuration.success, false);
  assert.strictEqual(invalidDuration.error.code, 'INVALID_DURATION');

  var tooShort = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 60 }, {}, DEFAULT_CONFIG, NOW
  );
  assert.strictEqual(tooShort.success, false);
  assert.strictEqual(tooShort.error.code, 'DURATION_TOO_SHORT');
});

test('Script Propertiesの誤設定はfail-closedにINVALID_CONFIGを返す', function () {
  var BookingAvailability = loadAvailability();
  var badConfig = Object.assign({}, DEFAULT_CONFIG, { bufferMinutes: NaN });
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120 }, {}, badConfig, NOW
  );
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_CONFIG');
});

test('getMonthlyAvailabilityのレスポンスにPIIやイベント詳細を一切含めない（日次オブジェクトもstatus/availableStartTimesのみ）', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, brand: 'snb' },
    { '2026-10-05': [busy(600, 720)] },
    DEFAULT_CONFIG,
    NOW
  );
  var allowedTopKeys = ['success', 'month', 'durationMinutes', 'brand', 'days'];
  Object.keys(result).forEach(function (key) {
    assert.ok(allowedTopKeys.indexOf(key) !== -1, '想定外のトップレベルキー: ' + key);
  });
  Object.keys(result.days).forEach(function (dateString) {
    var allowedDayKeys = ['status', 'availableStartTimes'];
    Object.keys(result.days[dateString]).forEach(function (key) {
      assert.ok(allowedDayKeys.indexOf(key) !== -1, dateString + ' に想定外のキー: ' + key);
    });
  });
});

/*
 * ── 希望時間帯フィルタ（Issue #324） ──
 * DEFAULT_CONFIG（08:00〜23:00, 15分刻み）でduration=120分の場合、全く空きが無い日
 * （busyIntervals=[]）の候補数は既存テストのとおり53件。境界値（開始時刻基準）で
 * 手計算した内訳は以下（いずれも15分刻みで両端含む）:
 *   morning  08:00〜11:45 → (705-480)/15+1 = 16件
 *   daytime  12:00〜17:45 → (1065-720)/15+1 = 24件
 *   evening  18:00〜      → (1260-1080)/15+1 = 13件（21:00開始が最後の候補）
 *   16+24+13 = 53（allの総数と一致）
 */
var MORNING_FREE_DAY_COUNT = 16;
var DAYTIME_FREE_DAY_COUNT = 24;
var EVENING_FREE_DAY_COUNT = 13;

test('timeBand=allは現在の月間判定（timeBand未指定）と完全に一致する（後方互換）', function () {
  var BookingAvailability = loadAvailability();
  var busyIntervalsByDate = { '2026-10-01': [busy(480, 1380)], '2026-10-02': [busy(600, 720)] };

  var withoutTimeBand = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120 }, busyIntervalsByDate, DEFAULT_CONFIG, NOW
  );
  var withAll = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'all' }, busyIntervalsByDate, DEFAULT_CONFIG, NOW
  );

  assert.deepStrictEqual(withAll.days, withoutTimeBand.days);
});

test('timeBand未指定・不正値はallへフォールバックする（デプロイ過渡期の旧フロント互換）', function () {
  var BookingAvailability = loadAvailability();
  var withAll = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'all' }, {}, DEFAULT_CONFIG, NOW
  );
  [undefined, null, '', 'bogus', 'MORNING', 'Morning'].forEach(function (value) {
    var result = BookingAvailability.getMonthlyAvailability(
      { year: 2026, month: 10, durationMinutes: 120, timeBand: value }, {}, DEFAULT_CONFIG, NOW
    );
    assert.strictEqual(result.success, true, 'timeBand=' + JSON.stringify(value) + ' はエラーにならないべき');
    assert.deepStrictEqual(result.days, withAll.days, 'timeBand=' + JSON.stringify(value) + ' はallと同じ結果になるべき');
  });
});

test('timeBand=morningは午前(08:00〜11:45開始)の候補のみで日別ステータスを判定する', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'morning' }, { '2026-10-01': [] }, DEFAULT_CONFIG, NOW
  );
  assert.strictEqual(result.days['2026-10-01'].availableStartTimes, MORNING_FREE_DAY_COUNT);
  assert.strictEqual(result.days['2026-10-01'].status, 'AVAILABLE_HIGH');
});

test('timeBand=daytimeは昼(12:00〜17:45開始)の候補のみで日別ステータスを判定する', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'daytime' }, { '2026-10-01': [] }, DEFAULT_CONFIG, NOW
  );
  assert.strictEqual(result.days['2026-10-01'].availableStartTimes, DAYTIME_FREE_DAY_COUNT);
  assert.strictEqual(result.days['2026-10-01'].status, 'AVAILABLE_HIGH');
});

test('timeBand=eveningは夜(18:00以降開始)の候補のみで日別ステータスを判定する', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'evening' }, { '2026-10-01': [] }, DEFAULT_CONFIG, NOW
  );
  assert.strictEqual(result.days['2026-10-01'].availableStartTimes, EVENING_FREE_DAY_COUNT);
  assert.strictEqual(result.days['2026-10-01'].status, 'AVAILABLE_HIGH');
});

test('maxPossible（分母）も同じtimeBandで絞り込まれる。band対象外の時間帯だけを埋めても、band内が全て空きならAVAILABLE_HIGHのまま', function () {
  /* もしmaxPossibleを絞らず1日分（53件）のままにすると、16/53≈0.30でLIMITEDに
     誤判定される（Issue #324本文レビュー追記1が指摘する不具合）。正しくは
     分母も同じmorning内（16件）に絞るため、16/16=1でAVAILABLE_HIGHになるべき。 */
  var BookingAvailability = loadAvailability();
  /* 14:00〜23:00を埋める（bufferMinutes=15を差し引いても午前の最終候補11:45の占有区間
     [11:45,13:45)より後ろにするため、午前枠には一切影響しない）。 */
  var busyOutsideMorning = [busy(14 * 60, 23 * 60)];
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'morning' },
    { '2026-10-01': busyOutsideMorning },
    DEFAULT_CONFIG,
    NOW
  );
  assert.strictEqual(result.days['2026-10-01'].availableStartTimes, MORNING_FREE_DAY_COUNT, '午前枠はまったく埋まっていないため件数は変わらない');
  assert.strictEqual(result.days['2026-10-01'].status, 'AVAILABLE_HIGH', '分母も午前だけに絞られていればAVAILABLE_HIGHになるべき');
});

test('境界値: 11:45開始は午前、12:00開始は昼として扱われる（開始時刻の総数で検証）', function () {
  var BookingAvailability = loadAvailability();
  var morning = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'morning' }, { '2026-10-01': [] }, DEFAULT_CONFIG, NOW
  );
  var daytime = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'daytime' }, { '2026-10-01': [] }, DEFAULT_CONFIG, NOW
  );
  /* 11:45（705分）を含めば16件、12:00（720分）を含めなければ16件のまま。
     逆にdaytimeが12:00を含み11:45を含まなければ24件になる。手計算値との一致で
     境界を間接検証する（直接の時刻文字列はfilterStartTimesByTimeBandの
     単体テストで検証する）。 */
  assert.strictEqual(morning.days['2026-10-01'].availableStartTimes, 16);
  assert.strictEqual(daytime.days['2026-10-01'].availableStartTimes, 24);
});

test('境界値: 17:45開始は昼、18:00開始は夜として扱われる（開始時刻の総数で検証）', function () {
  var BookingAvailability = loadAvailability();
  var daytime = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'daytime' }, { '2026-10-01': [] }, DEFAULT_CONFIG, NOW
  );
  var evening = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'evening' }, { '2026-10-01': [] }, DEFAULT_CONFIG, NOW
  );
  assert.strictEqual(daytime.days['2026-10-01'].availableStartTimes, 24);
  assert.strictEqual(evening.days['2026-10-01'].availableStartTimes, 13);
});

test('長時間利用でband内の候補が0件ならFULLになる（Issue本文の例: 6時間利用+夜）', function () {
  var BookingAvailability = loadAvailability();
  /* 6時間(360分)利用の全日最終開始は17:00（1020分）。evening(18:00〜)には
     1件も収まらない。 */
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 360, timeBand: 'evening' }, { '2026-10-01': [] }, DEFAULT_CONFIG, NOW
  );
  assert.strictEqual(result.days['2026-10-01'].availableStartTimes, 0);
  assert.strictEqual(result.days['2026-10-01'].status, 'FULL');
});

test('当日かつ選択中の時間帯がすでに過ぎている場合、count・maxPossibleの双方が0件でFULLになる（14:00にmorningを選択）', function () {
  var BookingAvailability = loadAvailability();
  var now = new Date('2026-10-15T14:00:00+09:00');
  var result = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120, timeBand: 'morning' }, {}, DEFAULT_CONFIG, now
  );
  assert.strictEqual(result.days['2026-10-15'].availableStartTimes, 0);
  assert.strictEqual(result.days['2026-10-15'].status, 'FULL');
});

test('filterStartTimesByTimeBand/normalizeTimeBandが公開されている（フロント側と同じ4値）', function () {
  var BookingAvailability = loadAvailability();
  assert.deepStrictEqual(Object.keys(BookingAvailability.TIME_BANDS).sort(), ['ALL', 'DAYTIME', 'EVENING', 'MORNING']);
  assert.strictEqual(BookingAvailability.TIME_BANDS.ALL, 'all');
  assert.strictEqual(BookingAvailability.TIME_BANDS.MORNING, 'morning');
  assert.strictEqual(BookingAvailability.TIME_BANDS.DAYTIME, 'daytime');
  assert.strictEqual(BookingAvailability.TIME_BANDS.EVENING, 'evening');
  assert.strictEqual(BookingAvailability.normalizeTimeBand('bogus'), 'all');
  assert.strictEqual(BookingAvailability.normalizeTimeBand('evening'), 'evening');
  assert.deepStrictEqual(
    BookingAvailability.filterStartTimesByTimeBand(['08:00', '11:45', '12:00', '17:45', '18:00'], 'morning'),
    ['08:00', '11:45']
  );
  assert.deepStrictEqual(
    BookingAvailability.filterStartTimesByTimeBand(['08:00', '11:45', '12:00', '17:45', '18:00'], 'daytime'),
    ['12:00', '17:45']
  );
  assert.deepStrictEqual(
    BookingAvailability.filterStartTimesByTimeBand(['08:00', '11:45', '12:00', '17:45', '18:00'], 'evening'),
    ['18:00']
  );
  assert.deepStrictEqual(
    BookingAvailability.filterStartTimesByTimeBand(['08:00', '11:45', '12:00', '17:45', '18:00'], 'all'),
    ['08:00', '11:45', '12:00', '17:45', '18:00']
  );
});

test('日ごとの空き判定は、月間表示でも単日getAvailabilityと一致する（不整合を作らない）', function () {
  var BookingAvailability = loadAvailability();
  var busyIntervalsByDate = {
    '2026-10-05': [busy(600, 720)],
    '2026-10-06': []
  };
  var monthly = BookingAvailability.getMonthlyAvailability(
    { year: 2026, month: 10, durationMinutes: 120 }, busyIntervalsByDate, DEFAULT_CONFIG, NOW
  );

  var singleDay05 = BookingAvailability.getAvailability(
    { date: '2026-10-05', durationMinutes: 120 }, busyIntervalsByDate['2026-10-05'], DEFAULT_CONFIG, NOW
  );
  var singleDay06 = BookingAvailability.getAvailability(
    { date: '2026-10-06', durationMinutes: 120 }, busyIntervalsByDate['2026-10-06'], DEFAULT_CONFIG, NOW
  );

  assert.strictEqual(monthly.days['2026-10-05'].availableStartTimes, singleDay05.bookableStartTimes.length);
  assert.strictEqual(monthly.days['2026-10-06'].availableStartTimes, singleDay06.bookableStartTimes.length);
});
