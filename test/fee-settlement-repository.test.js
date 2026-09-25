'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

function setup() {
  var sheets = {};
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: 'ss1' }),
    SpreadsheetApp: stubs.createSpreadsheetAppStub({ ss1: sheets })
  };
  var sandbox = loadBookingSandbox(['Config.gs', 'FeeSettlementRepository.gs'], globals);
  return { sandbox: sandbox, sheets: sheets };
}

test('findBySettlementId returns null when the sheet is empty or the id is unknown', function () {
  var f = setup().sandbox;
  assert.equal(f.FeeSettlementRepository.findBySettlementId('unknown'), null);
});

test('appendPending records a PENDING_APPLY row that findBySettlementId can retrieve', function () {
  var f = setup().sandbox;
  var rowNumber = f.FeeSettlementRepository.appendPending({
    settlementId: 'settle-1', bookingId: 'SNB-TEST-1', changeId: 'change-1',
    settlementState: 'PENDING_REFUND', paidDelta: 0, refundedDelta: 1000, note: 'PayPayで返金'
  });
  assert.equal(rowNumber, 2);
  var found = f.FeeSettlementRepository.findBySettlementId('settle-1');
  assert.equal(found.rowNumber, 2);
  assert.equal(found.record.bookingId, 'SNB-TEST-1');
  assert.equal(found.record.changeId, 'change-1');
  assert.equal(found.record.paidDelta, 0);
  assert.equal(found.record.refundedDelta, 1000);
  assert.equal(found.record.applyStatus, 'PENDING_APPLY');
  assert.equal(found.record.appliedAt, '');
});

test('markApplied updates applyStatus/appliedAt/result amounts without touching the request fields', function () {
  var f = setup().sandbox;
  f.FeeSettlementRepository.appendPending({
    settlementId: 'settle-2', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 500, refundedDelta: 0, note: ''
  });
  f.FeeSettlementRepository.markApplied(2, 500, 0);
  var found = f.FeeSettlementRepository.findBySettlementId('settle-2');
  assert.equal(found.record.applyStatus, 'APPLIED');
  assert.notEqual(found.record.appliedAt, '');
  assert.equal(found.record.resultPaidAmount, 500);
  assert.equal(found.record.resultRefundedAmount, 0);
  assert.equal(found.record.paidDelta, 500); // 元のリクエスト内容は変わらない
});

test('markFailedNeedsRecovery leaves result amounts empty (Bookings-side reflection unconfirmed)', function () {
  var f = setup().sandbox;
  f.FeeSettlementRepository.appendPending({
    settlementId: 'settle-3', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'PENDING_REFUND', paidDelta: 0, refundedDelta: 2000, note: ''
  });
  f.FeeSettlementRepository.markFailedNeedsRecovery(2);
  var found = f.FeeSettlementRepository.findBySettlementId('settle-3');
  assert.equal(found.record.applyStatus, 'FAILED_NEEDS_RECOVERY');
  assert.equal(found.record.resultPaidAmount, '');
  assert.equal(found.record.resultRefundedAmount, '');
});

test('multiple settlement ids coexist independently', function () {
  var f = setup().sandbox;
  f.FeeSettlementRepository.appendPending({ settlementId: 'a', bookingId: 'B1', changeId: '', settlementState: 'SETTLED', paidDelta: 100, refundedDelta: 0, note: '' });
  f.FeeSettlementRepository.appendPending({ settlementId: 'b', bookingId: 'B2', changeId: '', settlementState: 'SETTLED', paidDelta: 200, refundedDelta: 0, note: '' });
  assert.equal(f.FeeSettlementRepository.findBySettlementId('a').record.bookingId, 'B1');
  assert.equal(f.FeeSettlementRepository.findBySettlementId('b').record.bookingId, 'B2');
});
