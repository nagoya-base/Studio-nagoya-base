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

test('computeBookingPrice: studio_xはV1一般（GENERAL）料金表と一致する（平日2h/3h/4h・延長）', function () {
  var Pricing = loadPricing();
  var cases = [
    { minutes: 60, amount: 2000 },
    { minutes: 120, amount: 4000 },
    { minutes: 180, amount: 6000 },
    { minutes: 240, amount: 8000 },
    { minutes: 300, amount: 10000 },
    { minutes: 360, amount: 12000 }
  ];
  cases.forEach(function (c) {
    var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: c.minutes, isMember: false, generation: 'V1' });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.price.amount, c.amount, c.minutes + '分の平日料金');
    assert.strictEqual(result.price.tier, 'GENERAL');
    assert.strictEqual(result.price.dayType, 'WEEKDAY');
  });
});

test('computeBookingPrice: studio_xのV1土日祝一般料金（2h/3h/4h・延長）', function () {
  var Pricing = loadPricing();
  var cases = [
    { minutes: 60, amount: 2500 },
    { minutes: 120, amount: 5000 },
    { minutes: 180, amount: 7500 },
    { minutes: 240, amount: 10000 },
    { minutes: 300, amount: 12500 }
  ];
  [SATURDAY_DATE, SUNDAY_DATE].forEach(function (date) {
    cases.forEach(function (c) {
      var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: date, durationMinutes: c.minutes, isMember: false, generation: 'V1' });
      assert.strictEqual(result.price.amount, c.amount, date + ' ' + c.minutes + '分');
      assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
    });
  });
});

test('computeBookingPrice: studio_xはV1で従来会員料金、V2で現行MEMBER料金を新GENERALへスライドする（Issue #470）', function () {
  var Pricing = loadPricing();
  var v1 = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 180, isMember: true, generation: 'V1' });
  assert.strictEqual(v1.price.tier, 'MEMBER');
  assert.strictEqual(v1.price.amount, 5500);
  var unset = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 180, isMember: true });
  assert.strictEqual(unset.price.tier, 'MEMBER', '世代未指定は旧世代V1');
  var v1General = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 180, isMember: false, generation: 'V1' });
  assert.strictEqual(v1General.price.amount, 6000);

  [true, false].forEach(function (isMember) {
    var v2 = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 180, isMember: isMember, generation: 'V2' });
    assert.strictEqual(v2.price.tier, 'GENERAL');
    assert.strictEqual(v2.price.isMember, false);
    assert.strictEqual(v2.price.amount, 5500, 'V2は現行MEMBER料金を新GENERALへスライドする');
  });
});

test('computeBookingPrice: studio_x V2の全時間帯は現行MEMBER料金と一致する', function () {
  var Pricing = loadPricing();
  var cases = [
    [WEEKDAY_DATE, 60, 2000], [WEEKDAY_DATE, 120, 4000], [WEEKDAY_DATE, 180, 5500], [WEEKDAY_DATE, 240, 7000], [WEEKDAY_DATE, 300, 8500],
    [SATURDAY_DATE, 60, 2500], [SATURDAY_DATE, 120, 5000], [SATURDAY_DATE, 180, 7000], [SATURDAY_DATE, 240, 9000], [SATURDAY_DATE, 300, 11000]
  ];
  cases.forEach(function (c) {
    var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: c[0], durationMinutes: c[1], generation: 'V2', isMember: false });
    assert.strictEqual(result.price.tier, 'GENERAL');
    assert.strictEqual(result.price.amount, c[2], c[0] + ' ' + c[1]);
  });
});

test('computeBookingPrice: SNB一般料金はV2で新料金、V1は旧料金（Issue #470）', function () {
  var Pricing = loadPricing();
  var cases = [
    { date: WEEKDAY_DATE, minutes: 60, v1: 2000, v2: 2500 },
    { date: WEEKDAY_DATE, minutes: 120, v1: 4000, v2: 5000 },
    { date: WEEKDAY_DATE, minutes: 180, v1: 6000, v2: 7500 },
    { date: WEEKDAY_DATE, minutes: 240, v1: 8000, v2: 10000 },
    { date: WEEKDAY_DATE, minutes: 300, v1: 10000, v2: 12500 },
    { date: SATURDAY_DATE, minutes: 60, v1: 2500, v2: 3000 },
    { date: SATURDAY_DATE, minutes: 120, v1: 5000, v2: 6000 },
    { date: SATURDAY_DATE, minutes: 180, v1: 7500, v2: 9000 },
    { date: SATURDAY_DATE, minutes: 240, v1: 10000, v2: 12000 },
    { date: SATURDAY_DATE, minutes: 300, v1: 12500, v2: 15000 }
  ];
  cases.forEach(function (c) {
    var r1 = Pricing.computeBookingPrice({ brand: 'snb', date: c.date, durationMinutes: c.minutes, generation: 'V1' });
    var r2 = Pricing.computeBookingPrice({ brand: 'snb', date: c.date, durationMinutes: c.minutes, generation: 'V2' });
    assert.strictEqual(r1.price.amount, c.v1, 'V1 ' + c.date + ' ' + c.minutes);
    assert.strictEqual(r2.price.amount, c.v2, 'V2 ' + c.date + ' ' + c.minutes);
    assert.strictEqual(r2.price.generation, 'V2');
  });
});

test('computeBookingPrice: SNB MEMBER料金は全世代で現行会員料金のまま。mensは世代・isMember入力に関係なくMEMBER', function () {
  var Pricing = loadPricing();
  ['V1', 'V2'].forEach(function (generation) {
    [[WEEKDAY_DATE, 60, 2000], [WEEKDAY_DATE, 180, 5500], [WEEKDAY_DATE, 300, 8500], [SATURDAY_DATE, 240, 9000], [SATURDAY_DATE, 300, 11000]].forEach(function (c) {
      var snb = Pricing.computeBookingPrice({ brand: 'snb', date: c[0], durationMinutes: c[1], isMember: true, generation: generation });
      assert.strictEqual(snb.price.amount, c[2], generation + ' snb member ' + c[1]);
      var mens = Pricing.computeBookingPrice({ brand: 'mens', date: c[0], durationMinutes: c[1], isMember: false, generation: generation });
      assert.strictEqual(mens.price.tier, 'MEMBER');
      assert.strictEqual(mens.price.amount, c[2]);
    });
  });
});

test('generationAt/normalizeGeneration: 2026/12/1 0:00 JSTで切り替わり、空・不正値は旧世代V1', function () {
  var Pricing = loadPricing();
  assert.strictEqual(Pricing.generationAt(new Date('2026-11-30T23:59:59+09:00')), 'V1');
  assert.strictEqual(Pricing.generationAt(new Date('2026-12-01T00:00:00+09:00')), 'V2');
  assert.strictEqual(Pricing.generationAt(undefined), 'V1');
  assert.strictEqual(Pricing.normalizeGeneration(''), 'V1');
  assert.strictEqual(Pricing.normalizeGeneration('V2'), 'V2');
  assert.strictEqual(Pricing.normalizeGeneration('V9'), 'V1');
});

test('computeBookingPrice: studio_xのisMember未指定・不正値はfail-closedでGENERAL（V1）', function () {
  var Pricing = loadPricing();
  [undefined, null, 'true', 1, {}].forEach(function (rawIsMember) {
    var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 180, isMember: rawIsMember, generation: 'V1' });
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
    { minutes: 60, amount: 2000 },
    { minutes: 120, amount: 4000 },
    { minutes: 180, amount: 5500 },
    { minutes: 240, amount: 7000 },
    { minutes: 300, amount: 8500 }
  ];
  weekdayCases.forEach(function (c) {
    var result = Pricing.computeBookingPrice({ brand: 'mens', date: WEEKDAY_DATE, durationMinutes: c.minutes });
    assert.strictEqual(result.price.amount, c.amount, '平日 ' + c.minutes + '分');
  });

  var weekendCases = [
    { minutes: 60, amount: 2500 },
    { minutes: 120, amount: 5000 },
    { minutes: 180, amount: 7000 },
    { minutes: 240, amount: 9000 },
    { minutes: 300, amount: 11000 }
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

test('computeBookingPrice: 1時間未満のdurationMinutesは1時間の料金へ切り上げる（料金表に無い時間帯を参照しない）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 30, generation: 'V1' });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.amount, 2000);
  assert.strictEqual(result.price.billableHours, 1);
});

test('computeBookingPrice: 1時間料金は全ブランド・全区分で延長+1時間料金と同額（V1）', function () {
  var Pricing = loadPricing();
  ['snb', 'studio_x'].forEach(function (brand) {
    var weekday = Pricing.computeBookingPrice({ brand: brand, date: WEEKDAY_DATE, durationMinutes: 60, isMember: false, generation: 'V1' });
    var weekdayTwo = Pricing.computeBookingPrice({ brand: brand, date: WEEKDAY_DATE, durationMinutes: 120, isMember: false, generation: 'V1' });
    var weekdayFive = Pricing.computeBookingPrice({ brand: brand, date: WEEKDAY_DATE, durationMinutes: 300, isMember: false, generation: 'V1' });
    var weekdayFour = Pricing.computeBookingPrice({ brand: brand, date: WEEKDAY_DATE, durationMinutes: 240, isMember: false, generation: 'V1' });
    assert.strictEqual(weekday.price.amount, 2000, brand + ' 平日1h');
    assert.strictEqual(weekdayTwo.price.amount, weekday.price.amount * 2, brand + ' 平日2h=1h×2');
    assert.strictEqual(weekdayFive.price.amount - weekdayFour.price.amount, weekday.price.amount, brand + ' 平日 延長1h=1h料金');

    var weekend = Pricing.computeBookingPrice({ brand: brand, date: SATURDAY_DATE, durationMinutes: 60, isMember: false, generation: 'V1' });
    var weekendFour = Pricing.computeBookingPrice({ brand: brand, date: SATURDAY_DATE, durationMinutes: 240, isMember: false, generation: 'V1' });
    var weekendFive = Pricing.computeBookingPrice({ brand: brand, date: SATURDAY_DATE, durationMinutes: 300, isMember: false, generation: 'V1' });
    assert.strictEqual(weekend.price.amount, 2500, brand + ' 土日祝1h');
    assert.strictEqual(weekendFive.price.amount - weekendFour.price.amount, weekend.price.amount, brand + ' 土日祝 延長1h=1h料金');
    assert.strictEqual(weekend.price.billableHours, 1);
  });
});

test('computeBookingPrice: 時間の端数（例: 150分=2.5h）は切り上げて課金する（V1）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: WEEKDAY_DATE, durationMinutes: 150, generation: 'V1' });
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
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: ANOTHER_WEEKDAY_DATE, durationMinutes: 120, generation: 'V1' });
  assert.strictEqual(result.price.dayType, 'WEEKDAY');
  assert.strictEqual(result.price.amount, 4000);
});

test('computeBookingPrice: 平日に当たる国民の祝日は土日祝（WEEKEND_HOLIDAY）料金になる（Issue #346）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2026-11-23', durationMinutes: 120, generation: 'V1' });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
  assert.strictEqual(result.price.amount, 5000, '祝日は土日祝料金になるべき');
});

test('computeBookingPrice: 振替休日も土日祝（WEEKEND_HOLIDAY）料金になる（Issue #346）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2024-08-12', durationMinutes: 120, generation: 'V1' });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
  assert.strictEqual(result.price.amount, 5000);
});

test('computeBookingPrice: 国民の休日も土日祝（WEEKEND_HOLIDAY）料金になる（Issue #346）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2026-09-22', durationMinutes: 120, generation: 'V1' });
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
  assert.strictEqual(result.price.amount, 5000);
});

test('computeBookingPrice: 春分の日・秋分の日も土日祝（WEEKEND_HOLIDAY）料金になる（Issue #346）', function () {
  var Pricing = loadPricing();
  ['2026-03-20', '2026-09-23'].forEach(function (date) {
    var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: date, durationMinutes: 120, generation: 'V1' });
    assert.strictEqual(result.valid, true, date);
    assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY', date);
  });
});

test('computeBookingPrice: 祝日の前日・翌日（平日）は引き続き平日（WEEKDAY）料金のまま（Issue #346）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2026-09-24', durationMinutes: 120, generation: 'V1' });
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

test('computeBookingPrice: 対応年範囲外は土曜・日曜であってもfail-closedでエラーになる（PR #347レビュー対応）', function () {
  var Pricing = loadPricing();
  var result = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2019-12-28', durationMinutes: 120 });
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'HOLIDAY_YEAR_UNSUPPORTED');
});

test('computeBookingPrice: 年またぎ（大晦日→元日）でも正しく判定する（Issue #346）', function () {
  var Pricing = loadPricing();
  var beforeNewYear = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2025-12-31', durationMinutes: 120, generation: 'V1' });
  assert.strictEqual(beforeNewYear.price.dayType, 'WEEKDAY');

  var newYear = Pricing.computeBookingPrice({ brand: 'studio_x', date: '2026-01-01', durationMinutes: 120, generation: 'V1' });
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
