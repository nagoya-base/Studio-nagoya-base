/*
 * gas/booking/shared/BookingPricing.gs（Issue #342: 予約料金の自動計算）のテスト。
 * GAS実行環境のAPIに依存しない純粋関数のみで構成されるため、他の依存ファイルなしで
 * 単独でvm実行できる（Availability.gs/Booking.gsの一部関数と同方針）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

function loadPricing() {
  return loadBookingSandbox(['BookingPricing.gs'], {}).BookingPricing;
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

test('computeBookingPrice: 戻り値にcurrency/durationMinutes/billableHoursを含む', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'snb', date: WEEKDAY_DATE, durationMinutes: 180, isMember: true });
  assert.strictEqual(result.price.currency, 'JPY');
  assert.strictEqual(result.price.durationMinutes, 180);
  assert.strictEqual(result.price.billableHours, 3);
  assert.strictEqual(result.price.brand, 'snb');
});
