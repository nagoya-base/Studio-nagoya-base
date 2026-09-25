/*
 * gas/booking/shared/BookingPricing.gs（Issue #342: 予約料金の自動計算。Issue #346で
 * 日本の祝日・振替休日・国民の休日の判定を追加）のテスト。GAS実行環境のAPIに依存しない
 * 純粋関数のみで構成されるため、依存する JapaneseHolidays.gs 以外のファイルなしで
 * vm実行できる（Availability.gs/Booking.gsの一部関数と同方針）。
 *
 * 祝日判定アルゴリズム自体（振替休日・国民の休日のカスケード等）の網羅的な検証は
 * test/japanese-holidays.test.jsで行う。ここではBookingPricing.computeBookingPriceが
 * その判定結果をWEEKEND_HOLIDAY/WEEKDAYへ正しく反映すること、および祝日判定が
 * 確定できない場合にfail-closedでエラーを返すことのみを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

function loadPricing() {
  return loadBookingSandbox(['JapaneseHolidays.gs', 'BookingPricing.gs'], {}).BookingPricing;
}

/* 2026-10-05は月曜（平日）、2026-10-03は土曜、2026-10-04は日曜（いずれも土日祝）、
   2026-10-01は木曜（平日）。date -d で確認済み。 */
var WEEKDAY_DATE = '2026-10-05';
var SATURDAY_DATE = '2026-10-03';
var SUNDAY_DATE = '2026-10-04';
var ANOTHER_WEEKDAY_DATE = '2026-10-01';

test('computeBookingPrice: studio_xは一般（GENERAL）料金表と一致する（平日2h/3h/4h・延長）', function () {
  var Pricing = loadPricing();
  var cases = [
    { minutes: 120, amount: 4000 },
    { minutes: 180, amount: 6000 },
    { minutes: 240, amount: 8000 },
    { minutes: 300, amount: 10000 }, // 4h(8000) + 1h延長(2000)
    { minutes: 360, amount: 12000 }  // 4h(8000) + 2h延長(2000*2)
  ];
  cases.forEach(function (c) {
    var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: c.minutes, isMember: false });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.price.amount, c.amount, c.minutes + '分の平日料金');
    assert.strictEqual(result.price.tier, 'GENERAL');
    assert.strictEqual(result.price.dayType, 'WEEKDAY');
  });
});

test('computeBookingPrice: studio_xの土日祝料金（2h/3h/4h・延長）', function () {
  var Pricing = loadPricing();
  var cases = [
    { minutes: 120, amount: 5000 },
    { minutes: 180, amount: 7500 },
    { minutes: 240, amount: 10000 },
    { minutes: 300, amount: 12500 } // 4h(10000) + 1h延長(2500)
  ];
  [SATURDAY_DATE, SUNDAY_DATE].forEach(function (date) {
    cases.forEach(function (c) {
      var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: date, durationMinutes: c.minutes, isMember: false });
      assert.strictEqual(result.price.amount, c.amount, date + ' ' + c.minutes + '分');
      assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
    });
  });
});

test('computeBookingPrice: studio_xはisMember:trueを送ると会員料金になる（PR #343レビュー対応: ブランド分離基準書v1.1によりSNB共通の会員基準を適用）', function () {
  var Pricing = loadPricing();
  var member = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 180, isMember: true });
  assert.strictEqual(member.price.tier, 'MEMBER');
  assert.strictEqual(member.price.isMember, true);
  assert.strictEqual(member.price.amount, 5500, '会員料金（一般料金6,000ではない）になる');

  var general = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 180, isMember: false });
  assert.strictEqual(general.price.tier, 'GENERAL');
  assert.strictEqual(general.price.amount, 6000);
});

test('computeBookingPrice: studio_xのisMember未指定・不正値はfail-closedでGENERAL（会員割引を誤って適用しない）', function () {
  var Pricing = loadPricing();
  [undefined, null, 'true', 1, {}].forEach(function (rawIsMember) {
    var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 180, isMember: rawIsMember });
    assert.strictEqual(result.price.tier, 'GENERAL', JSON.stringify(rawIsMember) + ' はGENERALへfail-closedされるべき');
  });
});

test('computeBookingPrice: mensはisMember:falseを送っても常に会員（MEMBER）料金になる', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'mens', date: WEEKDAY_DATE, durationMinutes: 180, isMember: false });
  assert.strictEqual(result.price.tier, 'MEMBER');
  assert.strictEqual(result.price.isMember, true);
  assert.strictEqual(result.price.amount, 5500, '会員料金（一般料金6,000ではない）になる');
});

test('computeBookingPrice: mensの会員料金表（平日/土日祝の2h/3h/4h・延長）', function () {
  var Pricing = loadPricing();
  var weekdayCases = [
    { minutes: 120, amount: 4000 },
    { minutes: 180, amount: 5500 },
    { minutes: 240, amount: 7000 },
    { minutes: 300, amount: 8500 } // 4h(7000) + 1h延長(1500)
  ];
  weekdayCases.forEach(function (c) {
    var result = Pricing.computeBookingPrice({ brand: 'mens', date: WEEKDAY_DATE, durationMinutes: c.minutes });
    assert.strictEqual(result.price.amount, c.amount, '平日 ' + c.minutes + '分');
  });

  var weekendCases = [
    { minutes: 120, amount: 5000 },
    { minutes: 180, amount: 7000 },
    { minutes: 240, amount: 9000 },
    { minutes: 300, amount: 11000 } // 4h(9000) + 1h延長(2000)
  ];
  weekendCases.forEach(function (c) {
    var result = Pricing.computeBookingPrice({ brand: 'mens', date: SATURDAY_DATE, durationMinutes: c.minutes });
    assert.strictEqual(result.price.amount, c.amount, '土日祝 ' + c.minutes + '分');
  });
});

test('computeBookingPrice: snbはisMember入力でGENERAL/MEMBERが切り替わる', function () {
  var Pricing = loadPricing();
  var general = Pricing.computeBookingPrice({ brand: 'snb', date: WEEKDAY_DATE, durationMinutes: 180, isMember: false });
  var member = Pricing.computeBookingPrice({ brand: 'snb', date: WEEKDAY_DATE, durationMinutes: 180, isMember: true });
  assert.strictEqual(general.price.tier, 'GENERAL');
  assert.strictEqual(general.price.amount, 6000);
  assert.strictEqual(member.price.tier, 'MEMBER');
  assert.strictEqual(member.price.amount, 5500);
});

test('computeBookingPrice: snbのisMember未指定・不正値はfail-closedでGENERAL（会員割引を誤って適用しない）', function () {
  var Pricing = loadPricing();
  [undefined, null, 'true', 1, {}].forEach(function (rawIsMember) {
    var result = Pricing.computeBookingPrice({ brand: 'snb', date: WEEKDAY_DATE, durationMinutes: 180, isMember: rawIsMember });
    assert.strictEqual(result.price.tier, 'GENERAL', JSON.stringify(rawIsMember) + ' はGENERALへfail-closedされるべき');
  });
});

test('computeBookingPrice: 2時間未満のdurationMinutesは2時間の料金へ切り上げる（料金表に無い時間帯を参照しない）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 60 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.amount, 4000);
  assert.strictEqual(result.price.billableHours, 2);
});

test('computeBookingPrice: 時間の端数（例: 150分=2.5h）は切り上げて課金する（過小請求にならない方向）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 150 });
  assert.strictEqual(result.price.billableHours, 3);
  assert.strictEqual(result.price.amount, 6000);
});

test('computeBookingPrice: 不正なbrand/date/durationMinutesはfail-closedにvalid:falseを返す（例外を投げない）', function () {
  var Pricing = loadPricing();

  var invalidBrand = Pricing.computeBookingPrice({ brand: 'unknown', date: WEEKDAY_DATE, durationMinutes: 120 });
  assert.strictEqual(invalidBrand.valid, false);
  assert.strictEqual(invalidBrand.error.code, 'INVALID_BRAND');

  var invalidDate = Pricing.computeBookingPrice({ brand: 'snb', date: '2026/10/05', durationMinutes: 120 });
  assert.strictEqual(invalidDate.valid, false);
  assert.strictEqual(invalidDate.error.code, 'INVALID_DATE');

  var invalidDuration1 = Pricing.computeBookingPrice({ brand: 'snb', date: WEEKDAY_DATE, durationMinutes: 0 });
  assert.strictEqual(invalidDuration1.valid, false);
  assert.strictEqual(invalidDuration1.error.code, 'INVALID_DURATION');

  var invalidDuration2 = Pricing.computeBookingPrice({ brand: 'snb', date: WEEKDAY_DATE, durationMinutes: 'abc' });
  assert.strictEqual(invalidDuration2.valid, false);
  assert.strictEqual(invalidDuration2.error.code, 'INVALID_DURATION');

  var missingInput = Pricing.computeBookingPrice();
  assert.strictEqual(missingInput.valid, false);
});

test('computeBookingPrice: 木曜（別の平日）でも平日料金になる（土日判定が特定の1日だけに依存していない）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: ANOTHER_WEEKDAY_DATE, durationMinutes: 120 });
  assert.strictEqual(result.price.dayType, 'WEEKDAY');
  assert.strictEqual(result.price.amount, 4000);
});

test('computeBookingPrice: 平日に当たる国民の祝日は土日祝（WEEKEND_HOLIDAY）料金になる（Issue #346）', function () {
  var Pricing = loadPricing();
  /* 2026-11-23（勤労感謝の日）は月曜（date -d で確認済み）。 */
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2026-11-23', durationMinutes: 120 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
  assert.strictEqual(result.price.amount, 5000, '祝日は土日祝料金（4000ではない）になるべき');
});

test('computeBookingPrice: 振替休日も土日祝（WEEKEND_HOLIDAY）料金になる（Issue #346）', function () {
  var Pricing = loadPricing();
  /* 2024-08-11（山の日）は日曜のため、2024-08-12（月曜）が振替休日になる。 */
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2024-08-12', durationMinutes: 120 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
  assert.strictEqual(result.price.amount, 5000);
});

test('computeBookingPrice: 国民の休日も土日祝（WEEKEND_HOLIDAY）料金になる（Issue #346）', function () {
  var Pricing = loadPricing();
  /* 2026-09-22（火）は敬老の日(9/21)と秋分の日(9/23)に挟まれた国民の休日。 */
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2026-09-22', durationMinutes: 120 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
  assert.strictEqual(result.price.amount, 5000);
});

test('computeBookingPrice: 春分の日・秋分の日も土日祝（WEEKEND_HOLIDAY）料金になる（Issue #346）', function () {
  var Pricing = loadPricing();
  ['2026-03-20', '2026-09-23'].forEach(function (date) {
    var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: date, durationMinutes: 120 });
    assert.strictEqual(result.valid, true, date);
    assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY', date);
  });
});

test('computeBookingPrice: 祝日の前日・翌日（平日）は引き続き平日（WEEKDAY）料金のまま（Issue #346）', function () {
  var Pricing = loadPricing();
  /* 2026-11-23（勤労感謝の日、月曜）の前日2026-11-22（日曜）を挟まない平日の例として、
     祝日ではない通常の平日が引き続きWEEKDAYのままであることを別日で確認する
     （ANOTHER_WEEKDAY_DATE=2026-10-01は他のテストで既に検証済みのため、ここでは
     祝日隣接日を確認する）。2026-09-24（木）は国民の休日(9/22)・秋分の日(9/23)の
     翌日で祝日ではない。 */
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2026-09-24', durationMinutes: 120 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.dayType, 'WEEKDAY');
  assert.strictEqual(result.price.amount, 4000);
});

test('computeBookingPrice: 祝日判定に対応していない年（対応範囲外）は、黙って平日料金にせず明示的にfail-closedへ倒す（Issue #346）', function () {
  var Pricing = loadPricing();
  var tooOld = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2019-12-25', durationMinutes: 120 });
  assert.strictEqual(tooOld.valid, false);
  assert.strictEqual(tooOld.error.code, 'HOLIDAY_YEAR_UNSUPPORTED');
  assert.strictEqual(typeof tooOld.error.message, 'string');
  assert.ok(tooOld.error.message.length > 0);

  var tooFar = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2100-01-04', durationMinutes: 120 });
  assert.strictEqual(tooFar.valid, false);
  assert.strictEqual(tooFar.error.code, 'HOLIDAY_YEAR_UNSUPPORTED');
});

test('computeBookingPrice: 対応年範囲外でも土曜・日曜は祝日判定を経由せずWEEKEND_HOLIDAYになる（Issue #346）', function () {
  var Pricing = loadPricing();
  /* 2019-12-28は土曜（date -d で確認済み）。祝日判定に到達する前に土日判定で
     WEEKEND_HOLIDAYが確定するため、対応年範囲外でもエラーにならない。 */
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2019-12-28', durationMinutes: 120 });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
});

test('computeBookingPrice: 年またぎ（大晦日→元日）でも正しく判定する（Issue #346）', function () {
  var Pricing = loadPricing();
  /* 2025-12-31（水）は平日。2026-01-01（木）は元日。 */
  var beforeNewYear = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2025-12-31', durationMinutes: 120 });
  assert.strictEqual(beforeNewYear.price.dayType, 'WEEKDAY');

  var newYear = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2026-01-01', durationMinutes: 120 });
  assert.strictEqual(newYear.price.dayType, 'WEEKEND_HOLIDAY');
});

test('computeBookingPrice: 戻り値にcurrency/durationMinutes/billableHoursを含む', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'snb', date: WEEKDAY_DATE, durationMinutes: 180, isMember: true });
  assert.strictEqual(result.price.currency, 'JPY');
  assert.strictEqual(result.price.durationMinutes, 180);
  assert.strictEqual(result.price.billableHours, 3);
  assert.strictEqual(result.price.brand, 'snb');
});
