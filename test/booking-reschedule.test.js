'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs',
  'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'BookingReschedule.gs'
];

function futureDateJst_(daysAhead) {
  var d = new Date(Date.now() + daysAhead * 86400000);
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  var out = {};
  parts.forEach(function (p) { if (p.type !== 'literal') out[p.type] = p.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

function setup(mailOptions) {
  var sheets = {};
  var calendars = { cal1: { events: [] } };
  var mail = stubs.createMailAppStub(mailOptions || {});
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
  var date = futureDateJst_(35);
  var start = sandbox.CalendarRepository.parseDateTime(date, '10:00', 'Asia/Tokyo');
  var end = sandbox.CalendarRepository.parseDateTime(date, '12:00', 'Asia/Tokyo');
  var event = globals.CalendarApp.getCalendarById('cal1').createEvent('booking', start, end);
  event.setTag('bookingId', 'SNB-TEST-1');
  event.setTag('status', 'CONFIRMED');
  event.setTag('brand', 'snb');
  sandbox.SpreadsheetRepository.appendBooking({
    bookingId: 'SNB-TEST-1', date: date, startAt: start, endAt: end,
    status: 'CONFIRMED', brand: 'snb', calendarEventId: event.getId(),
    name: '予約者', email: 'customer@example.com', paymentMethod: 'PayPay',
    paymentStatus: 'PAID', confirmedMailSentAt: new Date()
  });
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

test('commit retains booking ID/payment state, moves existing event and sends one change mail', function () {
  var f = setup();
  var oldEventId = f.event.getId();
  var version = f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '利用者希望', '差額なし');
  assert.equal(result.success, true);
  assert.equal(result.mailSent, true);
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.calendarEventId, oldEventId);
  assert.equal(record.status, 'CONFIRMED');
  assert.equal(record.paymentStatus, 'PAID');
  assert.equal(f.sandbox.BookingAvailability.formatTimeInTimezone(record.startAt, 'Asia/Tokyo'), '13:00');
  assert.equal(f.event.getStartTime().getTime(), record.startAt.getTime());
  assert.equal(f.mail._sentEmails.length, 1);
  assert.match(f.mail._sentEmails[0].body, /差額なし/);
  assert.equal(f.sandbox.adminGetBookingChanges('SNB-TEST-1')[0].mailState, 'SENT');
  var stale = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version, '', '差額なし');
  assert.equal(stale.success, false);
  assert.equal(stale.error.code, 'STALE_BOOKING');
});

test('definite mail failure leaves the schedule changed and supports explicit retry', function () {
  var mailOptions = { throwError: new Error('test mail failure') };
  var f = setup(mailOptions);
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
