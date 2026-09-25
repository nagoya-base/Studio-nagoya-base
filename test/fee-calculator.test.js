'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'JapanHolidays.gs', 'FeeMasterRepository.gs', 'FeeCalculator.gs'];

function setup() {
  var sheets = {};
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: 'ss1' }),
    SpreadsheetApp: stubs.createSpreadsheetAppStub({ ss1: sheets })
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, sheets: sheets };
}

test('quoteFee returns the published base amounts for 2/3/4h and 1h extension (SNB general)', function () {
  var f = setup().sandbox;
  var weekday = f.FeeCalculator.quoteFee({ brand: 'snb', priceCategory: 'general', durationMinutes: 120, dateString: '2026-09-25', asOfDateString: '2026-09-25' });
  assert.equal(weekday.supported, true);
  assert.equal(weekday.dayType, 'weekday');
  assert.equal(weekday.amount, 4000);

  var weekend = f.FeeCalculator.quoteFee({ brand: 'snb', priceCategory: 'general', durationMinutes: 180, dateString: '2026-09-26', asOfDateString: '2026-09-26' });
  assert.equal(weekend.dayType, 'weekend_holiday');
  assert.equal(weekend.amount, 7500);

  var holiday = f.FeeCalculator.quoteFee({ brand: 'snb', priceCategory: 'general', durationMinutes: 240, dateString: '2026-01-01', asOfDateString: '2026-01-01' });
  assert.equal(holiday.dayType, 'weekend_holiday');
  assert.equal(holiday.amount, 10000);
});

test('quoteFee interpolates 30-minute increments and extends beyond 4h at half the extension rate', function () {
  var f = setup().sandbox;
  var q = function (minutes) {
    return f.FeeCalculator.quoteFee({ brand: 'snb', priceCategory: 'general', durationMinutes: minutes, dateString: '2026-09-25', asOfDateString: '2026-09-25' }).amount;
  };
  assert.equal(q(120), 4000);
  assert.equal(q(150), 5000); // (4000+6000)/2
  assert.equal(q(180), 6000);
  assert.equal(q(210), 7000); // (6000+8000)/2
  assert.equal(q(240), 8000);
  assert.equal(q(270), 9000); // 8000 + 2000/2
  assert.equal(q(300), 10000); // 8000 + 2000/2*2
});

test('quoteFee rounds a duration with a sub-30-minute remainder up before pricing', function () {
  var f = setup().sandbox;
  var q135 = f.FeeCalculator.quoteFee({ brand: 'snb', priceCategory: 'general', durationMinutes: 135, dateString: '2026-09-25', asOfDateString: '2026-09-25' });
  assert.equal(q135.roundedMinutes, 150);
  assert.equal(q135.amount, 5000);
});

test('quoteFee is fail-closed for combinations without a published price table', function () {
  var f = setup().sandbox;
  var mensGeneral = f.FeeCalculator.quoteFee({ brand: 'mens', priceCategory: 'general', durationMinutes: 120, dateString: '2026-09-25', asOfDateString: '2026-09-25' });
  assert.equal(mensGeneral.supported, false);
  assert.equal(mensGeneral.reason, 'NO_PRICE_DATA');

  var studioXMember = f.FeeCalculator.quoteFee({ brand: 'studio_x', priceCategory: 'member', durationMinutes: 120, dateString: '2026-09-25', asOfDateString: '2026-09-25' });
  assert.equal(studioXMember.supported, false);
  assert.equal(studioXMember.reason, 'NO_PRICE_DATA');
});

test('classifyCancellationPolicy maps day differences to the existing cancellation policy boundaries', function () {
  var f = setup().sandbox;
  assert.equal(f.FeeCalculator.classifyCancellationPolicy('2026-10-05', '2026-10-01'), 'TWO_DAYS_PLUS');
  assert.equal(f.FeeCalculator.classifyCancellationPolicy('2026-10-05', '2026-10-04'), 'DAY_BEFORE');
  assert.equal(f.FeeCalculator.classifyCancellationPolicy('2026-10-05', '2026-10-05'), 'SAME_DAY');
  assert.equal(f.FeeCalculator.classifyCancellationPolicy('2026-10-05', '2026-10-06'), 'PAST');
});

test('assessScheduleChangeFee: price increase is always a plain additional charge, cancellation policy irrelevant', function () {
  var f = setup().sandbox;
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 4000, newAmount: 6000, unrefundedPaidAmount: 4000,
    scheduleChangeCount: 3, cancellationPolicyCategory: 'SAME_DAY'
  });
  assert.equal(result.feeDifference, 2000);
  assert.equal(result.refundStatus, 'ADDITIONAL_CHARGE_REQUIRED');
  assert.equal(result.refundCandidateAmount, 0);
});

test('assessScheduleChangeFee: first-ever change before the day of use is a fee-free refund candidate', function () {
  var f = setup().sandbox;
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 8000, newAmount: 4000, unrefundedPaidAmount: 8000,
    scheduleChangeCount: 0, cancellationPolicyCategory: 'DAY_BEFORE'
  });
  assert.equal(result.feeDifference, -4000);
  assert.equal(result.refundStatus, 'CANDIDATE');
  assert.equal(result.refundCandidateAmount, 4000);
});

test('assessScheduleChangeFee: refund candidate never exceeds the unrefunded paid amount', function () {
  var f = setup().sandbox;
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 8000, newAmount: 4000, unrefundedPaidAmount: 1000,
    scheduleChangeCount: 0, cancellationPolicyCategory: 'TWO_DAYS_PLUS'
  });
  assert.equal(result.refundCandidateAmount, 1000);
});

test('assessScheduleChangeFee: second change or same-day reduction is left as a policy decision (no auto-refund amount)', function () {
  var f = setup().sandbox;
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
  var f = setup().sandbox;
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 8000, newAmount: 4000, unrefundedPaidAmount: 8000,
    scheduleChangeCount: 2, cancellationPolicyCategory: 'SAME_DAY'
  });
  assert.equal(result.refundStatus, 'PENDING_POLICY_DECISION');
  assert.equal(result.refundCandidateAmount, null);
});

test('assessScheduleChangeFee: no amount change requires no billing action', function () {
  var f = setup().sandbox;
  var result = f.FeeCalculator.assessScheduleChangeFee({
    oldAmount: 6000, newAmount: 6000, unrefundedPaidAmount: 6000,
    scheduleChangeCount: 0, cancellationPolicyCategory: 'TWO_DAYS_PLUS'
  });
  assert.equal(result.refundStatus, 'NONE');
  assert.equal(result.feeDifference, 0);
});
