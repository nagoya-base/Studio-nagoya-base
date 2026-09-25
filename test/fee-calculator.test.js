'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var FILES = ['JapaneseHolidays.gs', 'BookingPricing.gs', 'FeeCalculator.gs'];

function setup() {
  return loadBookingSandbox(FILES, {});
}

test('quoteFee delegates whole-hour durations to BookingPricing (single source of truth)', function () {
  var f = setup();
  var weekday = f.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', durationMinutes: 120, dateString: '2026-09-25' });
  assert.equal(weekday.supported, true);
  assert.equal(weekday.dayType, 'WEEKDAY');
  assert.equal(weekday.amount, 4000);

  var weekend = f.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', durationMinutes: 180, dateString: '2026-09-26' });
  assert.equal(weekend.dayType, 'WEEKEND_HOLIDAY');
  assert.equal(weekend.amount, 7500);

  var holiday = f.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', durationMinutes: 240, dateString: '2026-01-01' });
  assert.equal(holiday.dayType, 'WEEKEND_HOLIDAY');
  assert.equal(holiday.amount, 10000);

  var extension = f.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', durationMinutes: 300, dateString: '2026-09-25' });
  assert.equal(extension.amount, 8000 + 2000); // 4h + 1h延長
});

test('quoteFee rounds a duration with a sub-30-minute remainder up before pricing', function () {
  var f = setup();
  var q125 = f.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', durationMinutes: 125, dateString: '2026-09-25' });
  assert.equal(q125.roundedMinutes, 150);
});

test('quoteFee refuses to auto-price a half-hour (non-whole-hour) rounded duration (unapproved interpolation)', function () {
  var f = setup();
  var half = f.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', durationMinutes: 150, dateString: '2026-09-25' });
  assert.equal(half.supported, false);
  assert.equal(half.reason, 'HALF_HOUR_RATE_UNCONFIRMED');
  assert.equal(half.roundedMinutes, 150);
  assert.equal(half.dayType, 'WEEKDAY');

  var half35 = f.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', durationMinutes: 210, dateString: '2026-09-25' });
  assert.equal(half35.supported, false);
  assert.equal(half35.reason, 'HALF_HOUR_RATE_UNCONFIRMED');
});

test('quoteFee propagates BookingPricing/JapaneseHolidays fail-closed errors (invalid brand, unsupported holiday year)', function () {
  var f = setup();
  var invalidBrand = f.FeeCalculator.quoteFee({ brand: 'unknown', priceTier: 'GENERAL', durationMinutes: 120, dateString: '2026-09-25' });
  assert.equal(invalidBrand.supported, false);
  // dayType判定（JapaneseHolidays）は日付が有効なら先に成功するため、brand不正の場合は
  // BookingPricing.computeBookingPriceのINVALID_BRANDが返る。
  assert.equal(invalidBrand.reason, 'INVALID_BRAND');

  var yearOutOfRange = f.FeeCalculator.quoteFee({ brand: 'snb', priceTier: 'GENERAL', durationMinutes: 120, dateString: '2101-01-10' });
  assert.equal(yearOutOfRange.supported, false);
  assert.equal(yearOutOfRange.reason, 'HOLIDAY_YEAR_UNSUPPORTED');
});

test('classifyCancellationPolicy maps day differences to the existing cancellation policy boundaries', function () {
  var f = setup();
  assert.equal(f.FeeCalculator.classifyCancellationPolicy('2026-10-05', '2026-10-01'), 'TWO_DAYS_PLUS');
  assert.equal(f.FeeCalculator.classifyCancellationPolicy('2026-10-05', '2026-10-04'), 'DAY_BEFORE');
  assert.equal(f.FeeCalculator.classifyCancellationPolicy('2026-10-05', '2026-10-05'), 'SAME_DAY');
  assert.equal(f.FeeCalculator.classifyCancellationPolicy('2026-10-05', '2026-10-06'), 'PAST');
});

test('assessScheduleChangeFee: price increase is always a plain additional charge, cancellation policy irrelevant', function () {
  var f = setup();
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 4000, newAmount: 6000, unrefundedPaidAmount: 4000,
    scheduleChangeCount: 3, cancellationPolicyCategory: 'SAME_DAY'
  });
  assert.equal(result.feeDifference, 2000);
  assert.equal(result.refundStatus, 'ADDITIONAL_CHARGE_REQUIRED');
  assert.equal(result.refundCandidateAmount, 0);
});

test('assessScheduleChangeFee: first-ever change before the day of use is a fee-free refund candidate', function () {
  var f = setup();
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 8000, newAmount: 4000, unrefundedPaidAmount: 8000,
    scheduleChangeCount: 0, cancellationPolicyCategory: 'DAY_BEFORE'
  });
  assert.equal(result.feeDifference, -4000);
  assert.equal(result.refundStatus, 'CANDIDATE');
  assert.equal(result.refundCandidateAmount, 4000);
});

test('assessScheduleChangeFee: refund candidate never exceeds the unrefunded paid amount', function () {
  var f = setup();
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 8000, newAmount: 4000, unrefundedPaidAmount: 1000,
    scheduleChangeCount: 0, cancellationPolicyCategory: 'TWO_DAYS_PLUS'
  });
  assert.equal(result.refundCandidateAmount, 1000);
});

test('assessScheduleChangeFee: second change or same-day reduction is left as a policy decision (no auto-refund amount)', function () {
  var f = setup();
  var secondChange = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 8000, newAmount: 4000, unrefundedPaidAmount: 8000,
    scheduleChangeCount: 1, cancellationPolicyCategory: 'TWO_DAYS_PLUS'
  });
  assert.equal(secondChange.refundStatus, 'PENDING_POLICY_DECISION');
  assert.equal(secondChange.refundCandidateAmount, null);
  assert.match(secondChange.pendingReason, /2回目以降/);

  var sameDay = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 8000, newAmount: 4000, unrefundedPaidAmount: 8000,
    scheduleChangeCount: 0, cancellationPolicyCategory: 'SAME_DAY'
  });
  assert.equal(sameDay.refundStatus, 'PENDING_POLICY_DECISION');
  assert.equal(sameDay.refundCandidateAmount, null);
  assert.match(sameDay.pendingReason, /当日/);
});

test('assessScheduleChangeFee: never invents a refund amount for pending-decision cases regardless of extra flags', function () {
  var f = setup();
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 8000, newAmount: 4000, unrefundedPaidAmount: 8000,
    scheduleChangeCount: 2, cancellationPolicyCategory: 'SAME_DAY'
  });
  assert.equal(result.refundStatus, 'PENDING_POLICY_DECISION');
  assert.equal(result.refundCandidateAmount, null);
});

test('assessScheduleChangeFee: no amount change requires no billing action', function () {
  var f = setup();
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 6000, newAmount: 6000, unrefundedPaidAmount: 6000,
    scheduleChangeCount: 0, cancellationPolicyCategory: 'TWO_DAYS_PLUS'
  });
  assert.equal(result.refundStatus, 'NONE');
  assert.equal(result.feeDifference, 0);
});
