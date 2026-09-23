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
