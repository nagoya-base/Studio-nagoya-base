'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs', 'JapanHolidays.gs', 'FeeMasterRepository.gs', 'FeeCalculator.gs',
  'CalendarRepository.gs', 'Availability.gs', 'Booking.gs',
  'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'BookingReschedule.gs'
];

function dateStringForOffset_(daysAhead) {
  var d = new Date(Date.now() + daysAhead * 86400000);
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  var out = {};
  parts.forEach(function (p) { if (p.type !== 'literal') out[p.type] = p.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

function futureDateJst_(daysAhead) {
  return dateStringForOffset_(daysAhead);
}

/* wantWeekendHoliday: true→土日祝, false→平日の直近の日付を探す（テストの決定性のため、
   実行日に依存せず「平日/土日祝」を明示的に選べるようにする）。 */
function findDateOfDayType_(japanHolidays, startDaysAhead, wantWeekendHoliday) {
  for (var i = startDaysAhead; i < startDaysAhead + 21; i++) {
    var d = dateStringForOffset_(i);
    if (japanHolidays.isWeekendOrHoliday(d) === wantWeekendHoliday) return d;
  }
  throw new Error('条件に合う日付が見つかりません');
}

function setup(options) {
  options = options || {};
  var sheets = {};
  var calendars = { cal1: { events: [] } };
  var mail = stubs.createMailAppStub(options.mailOptions || {});
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({
      CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1',
      BOOKING_MAIL_DISPLAY_NAME: 'SNB',
      BOOKING_MAIL_REPLY_TO: 'reply@example.com',
      BOOKING_CONTACT_EMAIL: 'contact@example.com'
    }),
    SpreadsheetApp: stubs.createSpreadsheetAppStub({ ss1: sheets }),
    CalendarApp: stubs.createCalendarAppStub(calendars),
    Utilities: stubs.createUtilitiesStub(),
    LockService: stubs.createLockServiceStub(),
    Logger: stubs.createLoggerStub(),
    MailApp: mail
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  var date = findDateOfDayType_(sandbox.JapanHolidays, 35, false); // 平日固定（既存テストの決定性を保つ）
  var start = sandbox.CalendarRepository.parseDateTime(date, '10:00', 'Asia/Tokyo');
  var end = sandbox.CalendarRepository.parseDateTime(date, '12:00', 'Asia/Tokyo');
  var event = globals.CalendarApp.getCalendarById('cal1').createEvent('booking', start, end);
  event.setTag('bookingId', 'SNB-TEST-1');
  event.setTag('status', 'CONFIRMED');
  event.setTag('brand', 'snb');
  var brand = options.brand || 'snb';
  var record = {
    bookingId: 'SNB-TEST-1', date: date, startAt: start, endAt: end,
    status: 'CONFIRMED', brand: brand, calendarEventId: event.getId(),
    name: '予約者', email: 'customer@example.com', paymentMethod: 'PayPay',
    paymentStatus: 'PAID', confirmedMailSentAt: new Date()
  };
  if (options.withFeeBaseline !== false) {
    var priceCategory = options.priceCategory || 'general';
    var quote = sandbox.FeeCalculator.quoteFee({
      brand: brand, priceCategory: priceCategory, durationMinutes: 120, dateString: date, asOfDateString: date
    });
    record.priceCategory = priceCategory;
    record.confirmedFeeAmount = options.confirmedFeeAmount !== undefined ? options.confirmedFeeAmount : quote.amount;
    record.feePaidAmount = options.feePaidAmount !== undefined ? options.feePaidAmount : record.confirmedFeeAmount;
    record.feeRefundedAmount = options.feeRefundedAmount || 0;
    record.feeMasterVersion = quote.version;
    record.feeInitializedAt = new Date();
    record.scheduleChangeCount = options.scheduleChangeCount || 0;
  }
  sandbox.SpreadsheetRepository.appendBooking(record);
  return { sandbox: sandbox, date: date, event: event, mail: mail, globals: globals, sheets: sheets };
}

test('preview excludes own event but detects a different booking and buffer', function () {
  var f = setup();
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  assert.equal(f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version).success, true);
  var otherStart = f.sandbox.CalendarRepository.parseDateTime(f.date, '15:10', 'Asia/Tokyo');
  var otherEnd = f.sandbox.CalendarRepository.parseDateTime(f.date, '17:10', 'Asia/Tokyo');
  f.globals.CalendarApp.getCalendarById('cal1').createEvent('other booking', otherStart, otherEnd);
  var conflict = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version);
  assert.equal(conflict.success, false);
  assert.equal(conflict.error.code, 'SLOT_CONFLICT');
});

test('preview reports the fee comparison (same duration/day-type ⇒ no difference)', function () {
  var f = setup();
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version);
  assert.equal(preview.feeReady, true);
  assert.equal(preview.oldFeeAmount, preview.newFeeAmount);
  assert.equal(preview.feeDifference, 0);
  assert.equal(preview.refundStatus, 'NONE');
  assert.equal(preview.requiresManualRefundDecision, false);
});

test('commit retains booking ID/payment state, moves existing event and sends one change mail', function () {
  var f = setup();
  var oldEventId = f.event.getId();
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '利用者希望', '差額なし');
  assert.equal(result.success, true);
  assert.equal(result.mailSent, true);
  assert.equal(result.refundStatus, 'NONE');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.calendarEventId, oldEventId);
  assert.equal(record.status, 'CONFIRMED');
  assert.equal(record.paymentStatus, 'PAID');
  assert.equal(record.scheduleChangeCount, 1);
  assert.equal(f.sandbox.BookingAvailability.formatTimeInTimezone(record.startAt, 'Asia/Tokyo'), '13:00');
  assert.equal(f.event.getStartTime().getTime(), record.startAt.getTime());
  assert.equal(f.mail._sentEmails.length, 1);
  assert.match(f.mail._sentEmails[0].body, /差額なし/);
  assert.match(f.mail._sentEmails[0].body, /元料金/);
  assert.equal(f.sandbox.adminGetBookingChanges('SNB-TEST-1')[0].mailState, 'SENT');
  var stale = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '差額なし');
  assert.equal(stale.success, false);
  assert.equal(stale.error.code, 'STALE_BOOKING');
});

test('definite mail failure leaves the schedule changed and supports explicit retry', function () {
  var mailOptions = { throwError: new Error('test mail failure') };
  var f = setup({ mailOptions: mailOptions });
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version, '', '別途精算');
  assert.equal(result.success, true);
  assert.equal(result.mailSent, false);
  assert.equal(f.sandbox.adminGetBookingChanges('SNB-TEST-1')[0].mailState, 'FAILED');
  mailOptions.throwError = null;
  assert.equal(f.sandbox.adminResendRescheduleMail(result.changeId).success, true);
  assert.equal(f.mail._sentEmails.length, 1);
  assert.equal(f.sandbox.adminResendRescheduleMail(result.changeId).success, false);
});

test('Calendar update failure rolls the event back and leaves booking/booking sheet untouched', function () {
  var f = setup();
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var oldStart = f.event.getStartTime();
  var oldEnd = f.event.getEndTime();
  var originalSetTime = f.event.setTime;
  f.event.setTime = function () { throw new Error('Calendar API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version, '', '別途精算');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CALENDAR_UPDATE_FAILED');
  f.event.setTime = originalSetTime;
  assert.equal(f.event.getStartTime().getTime(), oldStart.getTime());
  assert.equal(f.event.getEndTime().getTime(), oldEnd.getTime());
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.startAt.getTime(), oldStart.getTime());
  assert.equal(record.endAt.getTime(), oldEnd.getTime());
  assert.equal(f.mail._sentEmails.length, 0);
});

test('Calendar update failure with a failed rollback still returns without exception and does not send mail', function () {
  var f = setup();
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  f.event.setTime = function () { throw new Error('Calendar API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version, '', '別途精算');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CALENDAR_UPDATE_FAILED');
  assert.match(result.error.message, /不明/);
  assert.equal(f.mail._sentEmails.length, 0);
});

test('Sheets update failure rolls the Calendar event back to the original time', function () {
  var f = setup();
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var oldStart = f.event.getStartTime();
  var oldEnd = f.event.getEndTime();
  var originalUpdate = f.sandbox.SpreadsheetRepository.updateBookingScheduleAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingScheduleAtomic = function () { throw new Error('Sheets API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version, '', '別途精算');
  f.sandbox.SpreadsheetRepository.updateBookingScheduleAtomic = originalUpdate;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'SHEETS_UPDATE_FAILED');
  assert.equal(f.event.getStartTime().getTime(), oldStart.getTime());
  assert.equal(f.event.getEndTime().getTime(), oldEnd.getTime());
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.startAt.getTime(), oldStart.getTime());
  assert.equal(f.mail._sentEmails.length, 0);
});

/* ---- Issue #344追記: 料金差額の自動計算 ---- */

test('commit is blocked until the original confirmed fee has been backfilled via setFeeBaseline', function () {
  var f = setup({ withFeeBaseline: false });
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version, '', '別途精算');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_BASELINE_REQUIRED');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.startAt.getTime(), f.event.getStartTime().getTime());

  var baseline = f.sandbox.adminSetBookingFeeBaseline('SNB-TEST-1', 'general', 4000, 4000, '過去の請求メールで確認');
  assert.equal(baseline.success, true);
  var afterBaseline = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version, '', '別途精算');
  assert.equal(afterBaseline.success, true);
});

test('setFeeBaseline validates its inputs (category, amount, basis note)', function () {
  var f = setup({ withFeeBaseline: false });
  assert.equal(f.sandbox.adminSetBookingFeeBaseline('SNB-TEST-1', 'vip', 4000, 4000, '根拠').error.code, 'INVALID_PRICE_CATEGORY');
  assert.equal(f.sandbox.adminSetBookingFeeBaseline('SNB-TEST-1', 'general', -1, 0, '根拠').error.code, 'INVALID_AMOUNT');
  assert.equal(f.sandbox.adminSetBookingFeeBaseline('SNB-TEST-1', 'general', 4000, 4000, '  ').error.code, 'BASIS_REQUIRED');
  assert.equal(f.sandbox.adminSetBookingFeeBaseline('UNKNOWN', 'general', 4000, 4000, '根拠').error.code, 'NOT_FOUND');
});

test('a same-duration reschedule to a different day-type (weekday→weekend) charges the additional amount, no ambiguity', function () {
  var f = setup(); // 平日2h、confirmedFeeAmount=平日料金で登録済み
  var weekendDate = findDateOfDayType_(f.sandbox.JapanHolidays, 40, true);
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1',
    { date: weekendDate, startTime: '10:00', endTime: '12:00' }, version);
  assert.equal(preview.feeReady, true);
  assert.equal(preview.dayType, 'weekend_holiday');
  assert.ok(preview.feeDifference > 0);
  assert.equal(preview.refundStatus, 'ADDITIONAL_CHARGE_REQUIRED');

  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: weekendDate, startTime: '10:00', endTime: '12:00' }, version, '', '差額は別途請求');
  assert.equal(result.success, true);
  assert.equal(result.refundStatus, 'ADDITIONAL_CHARGE_REQUIRED');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.confirmedFeeAmount, preview.newFeeAmount);
  assert.equal(record.feeSettlementState, 'PENDING_CHARGE');
});

test('a first, before-the-day-before shortening auto-refunds up to the paid amount with no cancellation fee', function () {
  var f = setup({ confirmedFeeAmount: 8000, feePaidAmount: 8000 }); // 4hぶん支払済みとして登録
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' }; // 同日2hへ短縮
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version);
  assert.equal(preview.refundStatus, 'CANDIDATE');
  assert.equal(preview.refundCandidateAmount, 8000 - preview.newFeeAmount);

  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '返金予定');
  assert.equal(result.success, true);
  assert.equal(result.refundStatus, 'CANDIDATE');
  assert.equal(result.refundAmount, 8000 - result.newFeeAmount);
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.feeSettlementState, 'PENDING_REFUND');
});

test('a second schedule change that reduces the fee is blocked until the admin enters an explicit refund decision', function () {
  var f = setup({ confirmedFeeAmount: 8000, feePaidAmount: 8000, scheduleChangeCount: 1 });
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version);
  assert.equal(preview.refundStatus, 'PENDING_POLICY_DECISION');
  assert.equal(preview.requiresManualRefundDecision, true);

  var blocked = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '要確認');
  assert.equal(blocked.success, false);
  assert.equal(blocked.error.code, 'FEE_REFUND_DECISION_REQUIRED');
  var stillOld = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(stillOld.startAt.getTime(), f.event.getStartTime().getTime());

  var decided = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '要確認', {
    manualRefundDecision: { approvedAmount: 1000, note: '規約解釈に基づき運営判断で一部返金' }
  });
  assert.equal(decided.success, true);
  assert.equal(decided.refundStatus, 'APPROVED');
  assert.equal(decided.refundAmount, 1000);
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.feeSettlementState, 'PENDING_REFUND');
  assert.equal(record.scheduleChangeCount, 2);
});

test('a manual refund decision above the unrefunded/difference cap is rejected', function () {
  var f = setup({ confirmedFeeAmount: 8000, feePaidAmount: 8000, scheduleChangeCount: 1 });
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var overshoot = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '要確認', {
    manualRefundDecision: { approvedAmount: 999999, note: '上限超え' }
  });
  assert.equal(overshoot.success, false);
  assert.equal(overshoot.error.code, 'FEE_REFUND_DECISION_REQUIRED');
});

test('commit rejects a stale fee master version captured at preview time', function () {
  var f = setup();
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var mismatch = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '差額なし', {
    expectedFeeMasterVersion: 999
  });
  assert.equal(mismatch.success, false);
  assert.equal(mismatch.error.code, 'FEE_VERSION_MISMATCH');
});

test('a brand/price-category combination without a published table requires a manual fee entry', function () {
  var f = setup({ brand: 'mens', priceCategory: 'member' });
  // mens×generalへ後から取り違えて設定された想定（料金表未定義の組み合わせ）。
  f.sandbox.adminSetBookingFeeBaseline('SNB-TEST-1', 'general', 5000, 5000, 'テスト用の想定外区分');
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version);
  assert.equal(preview.feeReady, false);
  assert.equal(preview.feeStatus, 'NO_PRICE_DATA');
  assert.equal(preview.requiresManualNewFee, true);

  var blocked = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '要確認');
  assert.equal(blocked.success, false);
  assert.equal(blocked.error.code, 'FEE_NOT_AVAILABLE');

  var manual = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '要確認', {
    manualNewFeeAmount: 5000, manualNewFeeNote: '据え置きで運営確認済み'
  });
  assert.equal(manual.success, true);
  assert.equal(manual.newFeeAmount, 5000);
  assert.equal(manual.refundStatus, 'NONE');
});

test('recordFeeSettlement records actual money movement without touching the fee amount itself', function () {
  var f = setup({ confirmedFeeAmount: 8000, feePaidAmount: 8000 });
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '返金予定');
  assert.equal(result.success, true);
  var settlement = f.sandbox.adminRecordRescheduleFeeSettlement(
    'SNB-TEST-1', result.changeId, 'SETTLED', 0, result.refundAmount, 'PayPayで返金済み'
  );
  assert.equal(settlement.success, true);
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.feeRefundedAmount, result.refundAmount);
  assert.equal(record.feeSettlementState, 'SETTLED');
  assert.equal(record.confirmedFeeAmount, result.newFeeAmount);
});
