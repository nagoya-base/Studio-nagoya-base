/*
 * gas/booking/Availability.gs（getAvailabilityの空き判定ロジック本体）のテスト。
 * Issue #266の受入条件・テスト観点を1:1でカバーする。
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

function busy(startMinutes, endMinutes) {
  return { startMinutes: startMinutes, endMinutes: endMinutes, isAllDay: false };
}

function allDay() {
  return { startMinutes: 0, endMinutes: 0, isAllDay: true };
}

function loadAvailability() {
  return loadBookingSandbox(['Availability.gs'], {}).BookingAvailability;
}

test('完全空き日: 08:00から23:00-durationまで15分刻みで全て予約可能', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.computeBookableStartTimes(120, [], DEFAULT_CONFIG);
  assert.strictEqual(result[0], '08:00');
  assert.strictEqual(result[result.length - 1], '21:00');
  assert.strictEqual(result.length, (21 * 60 + 0 - 8 * 60) / 15 + 1);
  result.forEach(function (t, i) {
    if (i === 0) return;
    var prevMinutes = timeToMinutes(result[i - 1]);
    assert.strictEqual(timeToMinutes(t) - prevMinutes, 15, '15分刻みであること');
  });
});

test('08:00開始の予約が可能（前マージン不要）', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.computeBookableStartTimes(120, [], DEFAULT_CONFIG);
  assert.ok(result.indexOf('08:00') !== -1);
});

test('23:00終了の予約が可能（後マージン不要）。23:00を超える枠は返さない', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.computeBookableStartTimes(120, [], DEFAULT_CONFIG);
  assert.ok(result.indexOf('21:00') !== -1, '21:00開始・120分で23:00終了が可能であること');
  result.forEach(function (t) {
    assert.ok(timeToMinutes(t) + 120 <= 23 * 60, t + ' 開始だと23:00を超えてしまう');
  });
});

test('既存予約直前14分の間隔は不可（14分ギャップは予約不可）', function () {
  var BookingAvailability = loadAvailability();
  // 10:00-12:00が占有済み。08:00開始・106分だと終了09:46で、10:00まで14分しかない。
  var result = BookingAvailability.computeBookableStartTimes(106, [busy(600, 720)], DEFAULT_CONFIG);
  assert.strictEqual(result.indexOf('08:00'), -1);
});

test('既存予約直前15分の間隔は可（15分ギャップなら予約可能）', function () {
  var BookingAvailability = loadAvailability();
  // 08:00開始・105分だと終了09:45で、10:00まで15分。
  var result = BookingAvailability.computeBookableStartTimes(105, [busy(600, 720)], DEFAULT_CONFIG);
  assert.ok(result.indexOf('08:00') !== -1);
});

test('既存予約直後14分の間隔は不可（14分ギャップは予約不可）', function () {
  var BookingAvailability = loadAvailability();
  // 10:00-11:46が占有済み。12:00開始だと11:46から14分しか空いていない。
  var result = BookingAvailability.computeBookableStartTimes(60, [busy(600, 706)], DEFAULT_CONFIG);
  assert.strictEqual(result.indexOf('12:00'), -1);
});

test('既存予約直後15分の間隔は可（15分ギャップなら予約可能）', function () {
  var BookingAvailability = loadAvailability();
  // 10:00-11:45が占有済み。12:00開始だと11:45から15分空いている。
  var result = BookingAvailability.computeBookableStartTimes(60, [busy(600, 705)], DEFAULT_CONFIG);
  assert.ok(result.indexOf('12:00') !== -1);
});

test('Issue記載の具体例: 10:00〜12:00予約済みなら次は12:15から予約可能', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.computeBookableStartTimes(120, [busy(600, 720)], DEFAULT_CONFIG);
  assert.strictEqual(result.indexOf('12:00'), -1, '12:00開始は既存予約と重なるため不可');
  assert.strictEqual(result.indexOf('12:14'), -1, '15分刻みの候補にそもそも含まれない');
  assert.ok(result.indexOf('12:15') !== -1, '12:15開始は予約可能');
});

test('終日イベントのみの日は空き枠を占有しない（完全空き日と同じ結果）', function () {
  var BookingAvailability = loadAvailability();
  var withAllDay = BookingAvailability.computeBookableStartTimes(120, [allDay()], DEFAULT_CONFIG);
  var withoutAny = BookingAvailability.computeBookableStartTimes(120, [], DEFAULT_CONFIG);
  assert.deepStrictEqual(withAllDay, withoutAny);
});

test('重複イベントがあっても誤って空きと判定しない', function () {
  var BookingAvailability = loadAvailability();
  // 10:00-12:00と11:00-13:00が重複。占有域は実質10:00-13:00(+前後バッファ)。
  var result = BookingAvailability.computeBookableStartTimes(60, [busy(600, 720), busy(660, 780)], DEFAULT_CONFIG);
  assert.strictEqual(result.indexOf('11:00'), -1);
  assert.strictEqual(result.indexOf('12:00'), -1);
  assert.strictEqual(result.indexOf('12:15'), -1, '重複区間の後ろ側(13:00)+バッファまでは不可であること');
  assert.ok(result.indexOf('13:15') !== -1, '13:00+15分バッファ後の13:15は予約可能');
});

test('複数（非重複）イベントがある日、それぞれの間に正しく空きが出る', function () {
  var BookingAvailability = loadAvailability();
  var events = [busy(9 * 60, 10 * 60), busy(15 * 60, 16 * 60)];
  var result = BookingAvailability.computeBookableStartTimes(120, events, DEFAULT_CONFIG);
  // 09:00-10:00の前後バッファで08:45-10:15が占有 → 08:00開始(終了10:00)は不可
  assert.strictEqual(result.indexOf('08:00'), -1);
  // 10:15開始(終了12:15)は可能
  assert.ok(result.indexOf('10:15') !== -1);
  // 15:00-16:00の前後バッファで14:45-16:15が占有 → 13:00開始(終了15:00)は不可
  assert.strictEqual(result.indexOf('13:00'), -1);
  // 16:15開始(終了18:15)は可能
  assert.ok(result.indexOf('16:15') !== -1);
});

test('brand違いでも空き判定結果は分岐しない（同一室のため）', function () {
  var BookingAvailability = loadAvailability();
  var events = [busy(600, 720)];
  var request = { date: '2026-10-01', durationMinutes: 120, brand: null };
  var forSnb = BookingAvailability.getAvailability(Object.assign({}, request, { brand: 'snb' }), events, DEFAULT_CONFIG);
  var forMens = BookingAvailability.getAvailability(Object.assign({}, request, { brand: 'mens' }), events, DEFAULT_CONFIG);
  var forStudioX = BookingAvailability.getAvailability(Object.assign({}, request, { brand: 'studio_x' }), events, DEFAULT_CONFIG);
  assert.deepStrictEqual(forSnb.bookableStartTimes, forMens.bookableStartTimes);
  assert.deepStrictEqual(forMens.bookableStartTimes, forStudioX.bookableStartTimes);
  assert.strictEqual(forSnb.brand, 'snb');
  assert.strictEqual(forMens.brand, 'mens');
  assert.strictEqual(forStudioX.brand, 'studio_x');
});

test('無効な日付はエラーになる', function () {
  var BookingAvailability = loadAvailability();
  ['2026-13-01', '2026-02-30', 'not-a-date', '2026/10/01', '', null, undefined, 20261001].forEach(function (invalidDate) {
    var result = BookingAvailability.getAvailability({ date: invalidDate, durationMinutes: 120 }, [], DEFAULT_CONFIG);
    assert.strictEqual(result.success, false, JSON.stringify(invalidDate) + ' は無効な日付として扱われるべき');
    assert.strictEqual(result.error.code, 'INVALID_DATE');
  });
});

test('120分未満（最低利用時間未満）はエラーになる', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.getAvailability({ date: '2026-10-01', durationMinutes: 60 }, [], DEFAULT_CONFIG);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'DURATION_TOO_SHORT');
});

test('durationMinutesが非数値・非整数・0以下の場合はINVALID_DURATIONになる', function () {
  var BookingAvailability = loadAvailability();
  [NaN, '120', 120.9, 0, -120, undefined, null, {}, []].forEach(function (invalidDuration) {
    var result = BookingAvailability.getAvailability({ date: '2026-10-01', durationMinutes: invalidDuration }, [], DEFAULT_CONFIG);
    assert.strictEqual(result.success, false, JSON.stringify(invalidDuration) + ' は無効な利用時間として扱われるべき');
    assert.strictEqual(result.error.code, 'INVALID_DURATION');
  });
});

test('Script Propertiesの誤設定はfail-closedにINVALID_CONFIGを返す（既存予約を空き扱いしない）', function () {
  var BookingAvailability = loadAvailability();

  var invalidConfigs = [
    Object.assign({}, DEFAULT_CONFIG, { bufferMinutes: NaN }),
    Object.assign({}, DEFAULT_CONFIG, { bufferMinutes: 'abc' }),
    Object.assign({}, DEFAULT_CONFIG, { bufferMinutes: -1 }),
    Object.assign({}, DEFAULT_CONFIG, { slotStepMinutes: 0 }),
    Object.assign({}, DEFAULT_CONFIG, { slotStepMinutes: -15 }),
    Object.assign({}, DEFAULT_CONFIG, { slotStepMinutes: NaN }),
    Object.assign({}, DEFAULT_CONFIG, { minBookingMinutes: 0 }),
    Object.assign({}, DEFAULT_CONFIG, { minBookingMinutes: -120 }),
    Object.assign({}, DEFAULT_CONFIG, { minBookingMinutes: NaN }),
    Object.assign({}, DEFAULT_CONFIG, { openTime: '23:00', closeTime: '08:00' }),
    Object.assign({}, DEFAULT_CONFIG, { openTime: '10:00', closeTime: '10:00' }),
    Object.assign({}, DEFAULT_CONFIG, { openTime: 'invalid' }),
    Object.assign({}, DEFAULT_CONFIG, { closeTime: undefined })
  ];

  invalidConfigs.forEach(function (config) {
    var result = BookingAvailability.getAvailability({ date: '2026-10-01', durationMinutes: 120 }, [], config);
    assert.strictEqual(result.success, false, JSON.stringify(config) + ' はINVALID_CONFIGとして拒否されるべき');
    assert.strictEqual(result.error.code, 'INVALID_CONFIG');
  });
});

test('BUFFER_MINUTES:0 / SLOT_STEP_MINUTES最小値等、正常な境界値のconfigは拒否しない', function () {
  var BookingAvailability = loadAvailability();
  var config = Object.assign({}, DEFAULT_CONFIG, { bufferMinutes: 0, slotStepMinutes: 1, minBookingMinutes: 1 });
  var result = BookingAvailability.getAvailability({ date: '2026-10-01', durationMinutes: 120 }, [], config);
  assert.strictEqual(result.success, true);
});

test('23:00を超える利用時間は、エラーにはせず空き枠0件を返す', function () {
  var BookingAvailability = loadAvailability();
  // 営業時間(08:00-23:00=900分)を超える901分では、どの開始時刻でも23:00に収まらない。
  var result = BookingAvailability.getAvailability({ date: '2026-10-01', durationMinutes: 901 }, [], DEFAULT_CONFIG);
  assert.strictEqual(result.success, true);
  /* result はvmサンドボックス（別realm）で生成された配列のため、reference-equalまで見る
     deepStrictEqualではなく内容ベースの非strict deepEqualで比較する。 */
  assert.deepEqual(result.bookableStartTimes, []);
});

test('getAvailabilityのレスポンスにPIIやイベント詳細を一切含めない', function () {
  var BookingAvailability = loadAvailability();
  var result = BookingAvailability.getAvailability({ date: '2026-10-01', durationMinutes: 120, brand: 'studio_x' }, [busy(600, 720)], DEFAULT_CONFIG);
  var allowedKeys = ['success', 'date', 'durationMinutes', 'brand', 'bookableStartTimes'];
  Object.keys(result).forEach(function (key) {
    assert.ok(allowedKeys.indexOf(key) !== -1, '想定外のキーが含まれている: ' + key);
  });
});

function timeToMinutes(hhmm) {
  var parts = hhmm.split(':');
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}
