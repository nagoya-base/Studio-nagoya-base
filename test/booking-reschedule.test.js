'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs', 'FeeCalculator.gs',
  'CalendarRepository.gs', 'Availability.gs', 'Booking.gs',
  'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'FeeSettlementRepository.gs',
  'BookingReschedule.gs'
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

/* wantWeekendHoliday: true→土日祝, false→平日の直近の日付を探す（テストの決定性のため、
   実行日に依存せず「平日/土日祝」を明示的に選べるようにする）。 */
function findDateOfDayType_(sandbox, startDaysAhead, wantWeekendHoliday) {
  for (var i = startDaysAhead; i < startDaysAhead + 21; i++) {
    var d = dateStringForOffset_(i);
    var classified = sandbox.JapaneseHolidays.classify(d);
    if (!classified.ok) continue;
    var weekday = new Date(d + 'T00:00:00Z').getUTCDay();
    var isWeekendOrHoliday = weekday === 0 || weekday === 6 || classified.isHoliday;
    if (isWeekendOrHoliday === wantWeekendHoliday) return d;
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
  var date = findDateOfDayType_(sandbox, 35, false); // 平日固定（既存テストの決定性を保つ）
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
  if (options.withPrice !== false) {
    var priceTier = options.priceTier || 'GENERAL';
    var quote = sandbox.BookingPricing.computeBookingPrice({
      brand: brand, date: date, durationMinutes: 120, isMember: priceTier === 'MEMBER'
    });
    record.priceAmount = options.priceAmount !== undefined ? options.priceAmount : quote.price.amount;
    record.priceTier = priceTier;
    record.priceDayType = quote.price.dayType;
    record.priceIsMember = priceTier === 'MEMBER';
    record.priceComputedAt = new Date();
    if (options.feePaidAmount !== undefined) record.feePaidAmount = options.feePaidAmount;
    else record.feePaidAmount = record.priceAmount;
    if (options.feeRefundedAmount !== undefined) record.feeRefundedAmount = options.feeRefundedAmount;
    if (options.scheduleChangeCount !== undefined) record.scheduleChangeCount = options.scheduleChangeCount;
  }
  sandbox.SpreadsheetRepository.appendBooking(record);
  return { sandbox: sandbox, date: date, event: event, mail: mail, globals: globals, sheets: sheets };
}

function version_(f) {
  return f.event.getStartTime().getTime() + ':' + f.event.getEndTime().getTime();
}

test('preview excludes own event but detects a different booking and buffer', function () {
  var f = setup();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  assert.equal(f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version_(f)).success, true);
  var otherStart = f.sandbox.CalendarRepository.parseDateTime(f.date, '15:10', 'Asia/Tokyo');
  var otherEnd = f.sandbox.CalendarRepository.parseDateTime(f.date, '17:10', 'Asia/Tokyo');
  f.globals.CalendarApp.getCalendarById('cal1').createEvent('other booking', otherStart, otherEnd);
  var conflict = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version_(f));
  assert.equal(conflict.success, false);
  assert.equal(conflict.error.code, 'SLOT_CONFLICT');
});

test('preview reports the fee comparison (same duration/day-type ⇒ no difference)', function () {
  var f = setup();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version_(f));
  assert.equal(preview.feeReady, true);
  assert.equal(preview.oldFeeAmount, preview.newFeeAmount);
  assert.equal(preview.feeDifference, 0);
  assert.equal(preview.refundStatus, 'NONE');
  assert.equal(preview.requiresManualRefundDecision, false);
});

test('commit retains booking ID/payment state, moves existing event, updates the effective price and sends one change mail', function () {
  var f = setup();
  var oldEventId = f.event.getId();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var originalVersion = version_(f);
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, originalVersion, '利用者希望', '差額なし');
  assert.equal(result.success, true);
  assert.equal(result.mailSent, true);
  assert.equal(result.refundStatus, 'NONE');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.calendarEventId, oldEventId);
  assert.equal(record.status, 'CONFIRMED');
  assert.equal(record.paymentStatus, 'PAID');
  assert.equal(record.scheduleChangeCount, 1);
  assert.equal(f.sandbox.Booking.getEffectivePriceAmount(record), result.newFeeAmount);
  assert.equal(f.sandbox.BookingAvailability.formatTimeInTimezone(record.startAt, 'Asia/Tokyo'), '13:00');
  assert.equal(f.event.getStartTime().getTime(), record.startAt.getTime());
  assert.equal(f.mail._sentEmails.length, 1);
  assert.match(f.mail._sentEmails[0].body, /差額なし/);
  assert.match(f.mail._sentEmails[0].body, /元料金/);
  assert.equal(f.sandbox.adminGetBookingChanges('SNB-TEST-1')[0].mailState, 'SENT');
  var stale = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, originalVersion, '', '差額なし');
  assert.equal(stale.success, false);
  assert.equal(stale.error.code, 'STALE_BOOKING');
});

test('definite mail failure leaves the schedule changed and supports explicit retry', function () {
  var mailOptions = { throwError: new Error('test mail failure') };
  var f = setup({ mailOptions: mailOptions });
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
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
  var oldStart = f.event.getStartTime();
  var oldEnd = f.event.getEndTime();
  var originalSetTime = f.event.setTime;
  f.event.setTime = function () { throw new Error('Calendar API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CALENDAR_UPDATE_FAILED');
  f.event.setTime = originalSetTime;
  assert.equal(f.event.getStartTime().getTime(), oldStart.getTime());
  assert.equal(f.event.getEndTime().getTime(), oldEnd.getTime());
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.startAt.getTime(), oldStart.getTime());
  assert.equal(record.endAt.getTime(), oldEnd.getTime());
  assert.equal(record.scheduleChangeCount || 0, 0);
  assert.equal(f.mail._sentEmails.length, 0);
});

test('Calendar update failure with a failed rollback still returns without exception and does not send mail', function () {
  var f = setup();
  f.event.setTime = function () { throw new Error('Calendar API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'CALENDAR_UPDATE_FAILED');
  assert.match(result.error.message, /不明/);
  assert.equal(f.mail._sentEmails.length, 0);
});

test('Sheets update failure rolls the Calendar event back to the original time', function () {
  var f = setup();
  var oldStart = f.event.getStartTime();
  var oldEnd = f.event.getEndTime();
  var originalUpdate = f.sandbox.SpreadsheetRepository.updateBookingScheduleAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingScheduleAtomic = function () { throw new Error('Sheets API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  f.sandbox.SpreadsheetRepository.updateBookingScheduleAtomic = originalUpdate;
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'SHEETS_UPDATE_FAILED');
  assert.equal(f.event.getStartTime().getTime(), oldStart.getTime());
  assert.equal(f.event.getEndTime().getTime(), oldEnd.getTime());
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.startAt.getTime(), oldStart.getTime());
  assert.equal(f.mail._sentEmails.length, 0);
});

/* ---- 日時・料金更新の一貫性（PR #345レビュー必須修正1） ---- */

test('date/Calendar update succeeds but the fee atomic update fails: commit reports failure, does not silently succeed, and locks the booking into recovery', function () {
  var f = setup();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var original = f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = function () { throw new Error('Sheets API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '別途精算');
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = original;

  // 日時変更自体は完了しているが、successはtrueにならない（成功扱いで握りつぶさない）。
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_UPDATE_FAILED_RECOVERY_REQUIRED');
  assert.equal(f.event.getStartTime().getTime(), f.sandbox.CalendarRepository.parseDateTime(f.date, '13:00', 'Asia/Tokyo').getTime());

  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  // 変更回数・現在の確定金額は「両方とも」更新前の値のまま（一部だけ更新された中途半端な
  // 状態にならない。1回のatomic writeが丸ごと失敗したため）。
  assert.equal(record.scheduleChangeCount || 0, 0);
  assert.equal(f.sandbox.Booking.getEffectivePriceAmount(record), record.priceAmount);
  assert.ok(record.feeRecoveryRequiredAt);
  assert.ok(record.feeRecoveryReason);

  // 復旧が必要な予約は、次の日時変更・精算操作を停止する。
  var blockedReschedule = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '16:00', endTime: '18:00' },
    record.startAt.getTime() + ':' + record.endAt.getTime(), '', '別途精算');
  assert.equal(blockedReschedule.success, false);
  assert.equal(blockedReschedule.error.code, 'FEE_RECOVERY_REQUIRED');

  var blockedSettlement = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 'settle-x', 'SETTLED', 0, 0, '');
  assert.equal(blockedSettlement.success, false);
  assert.equal(blockedSettlement.error.code, 'FEE_RECOVERY_REQUIRED');

  var blockedPreview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1',
    { date: f.date, startTime: '16:00', endTime: '18:00' }, record.startAt.getTime() + ':' + record.endAt.getTime());
  assert.equal(blockedPreview.success, false);
  assert.equal(blockedPreview.error.code, 'FEE_RECOVERY_REQUIRED');

  // resolveFeeRecoveryで管理者が確認した値を入力すれば復旧し、次回変更は「2回目」と正しく扱われる。
  var resolved = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {
    priceOverrideAmount: record.priceAmount, scheduleChangeCount: 1, feeSettlementState: ''
  });
  assert.equal(resolved.success, true);
  var afterResolve = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(afterResolve.feeRecoveryRequiredAt, '');
  assert.equal(afterResolve.scheduleChangeCount, 1);

  var afterResult = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '16:00', endTime: '18:00' },
    afterResolve.startAt.getTime() + ':' + afterResolve.endAt.getTime(), '', '別途精算');
  assert.equal(afterResult.success, true);
  var finalRecord = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(finalRecord.scheduleChangeCount, 2); // 1（復旧確認済み）→2（今回）で「初回」に戻っていない
});

test('resolveFeeRecovery refuses when the booking is not actually in a recovery state', function () {
  var f = setup();
  var result = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', { scheduleChangeCount: 5 });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'NOT_IN_RECOVERY');
});

/* ---- PR #345再レビュー対応（精算冪等性の複合障害・復旧・メール抑制） ---- */

test('recordFeeSettlement refuses to retry a settlement stuck in PENDING_APPLY instead of silently re-applying it (複合障害でBookingsへの反映結果が確定できない場合)', function () {
  var f = setup();
  var before = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;
  // 前回、Bookingsへの反映結果自体を記録する処理が中断し、PENDING_APPLYのまま残った状態を再現する。
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-stuck-1', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });

  var result = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-stuck-1', 'SETTLED', 1000, 0, '');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'SETTLEMENT_RECOVERY_REQUIRED');

  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  // 反映されたかどうか確定できない以上、二重加算を避けるため今回は一切反映しない。
  assert.equal(record.feePaidAmount, before);
  assert.ok(record.feeRecoveryRequiredAt);
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-stuck-1').record.applyStatus, 'FAILED_NEEDS_RECOVERY');

  // 復旧前にもう一度同じIDで再送しても、やはり反映しない（自動リトライしない）。
  // 予約自体が既にfeeRecoveryRequiredAtで止まっているため、settlementの状態を見るより先に
  // FEE_RECOVERY_REQUIREDでブロックされる（resolveFeeRecoveryを経ない限り抜けられない）。
  var retryBeforeRecovery = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-stuck-1', 'SETTLED', 1000, 0, '');
  assert.equal(retryBeforeRecovery.success, false);
  assert.equal(retryBeforeRecovery.error.code, 'FEE_RECOVERY_REQUIRED');
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, before);
});

test('resolveFeeRecovery(CONFIRMED_NOT_APPLIED) unlocks a stuck settlement so the same settlementId can be applied exactly once, not twice', function () {
  var f = setup();
  var before = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-stuck-2', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });
  f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-stuck-2', 'SETTLED', 1000, 0, '');
  assert.ok(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt);

  // 管理者が実際の入出金を確認した結果「未反映だった」と確定する。
  var resolved = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-stuck-2', outcome: 'CONFIRMED_NOT_APPLIED' });
  assert.equal(resolved.success, true);
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-stuck-2').record.applyStatus, 'ABANDONED');
  var afterResolve = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(afterResolve.feeRecoveryRequiredAt, '');
  assert.equal(afterResolve.feePaidAmount, before); // 未反映確定なので金額はまだ動かさない

  // 未反映と確定済みなので、同じIDでの再送は初めての適用として反映してよい。
  var applied = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-stuck-2', 'SETTLED', 1000, 0, '');
  assert.equal(applied.success, true);
  assert.equal(applied.resultPaidAmount, before + 1000);
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, before + 1000);

  // さらに同じIDで再送しても安全な再送（replay）として扱われ、二重加算しない。
  var replay = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-stuck-2', 'SETTLED', 1000, 0, '');
  assert.equal(replay.success, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.resultPaidAmount, before + 1000);
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, before + 1000);
});

test('resolveFeeRecovery(CONFIRMED_APPLIED) reconciles a settlement that actually reached Bookings before the ledger update failed, without double-counting on resubmission', function () {
  var f = setup();
  var originalPaid = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-stuck-3', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });
  // Bookingsへの反映自体は実際に成功していたが、その直後に状態遷移の記録が失敗した状況を再現する。
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic('SNB-TEST-1', {
    feePaidAmount: originalPaid + 1000, feeRefundedAmount: 0,
    feeSettlementState: 'SETTLED', feeSettlementNote: '', feeSettlementUpdatedAt: new Date()
  });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: '複合障害テスト'
  });

  // 管理者が実際の入出金・Bookingsの累計額を確認し「反映済みだった」と確定する。
  var resolved = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1',
    { feePaidAmount: originalPaid + 1000, feeRefundedAmount: 0 },
    { settlementId: 's-stuck-3', outcome: 'CONFIRMED_APPLIED' });
  assert.equal(resolved.success, true);
  var ledger = f.sandbox.FeeSettlementRepository.findBySettlementId('s-stuck-3').record;
  assert.equal(ledger.applyStatus, 'APPLIED');
  assert.equal(Number(ledger.resultPaidAmount), originalPaid + 1000);
  assert.equal(Number(ledger.resultRefundedAmount), 0);
  var afterResolve = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(afterResolve.feeRecoveryRequiredAt, '');
  assert.equal(afterResolve.feePaidAmount, originalPaid + 1000);

  // 反映済みと確定済みのため、同じIDでの再送はreplayとして扱われ、二重加算しない。
  var replay = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-stuck-3', 'SETTLED', 1000, 0, '');
  assert.equal(replay.success, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.resultPaidAmount, originalPaid + 1000);
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, originalPaid + 1000);
});

test('resolveFeeRecovery validates settlementResolution input before touching any ledger or booking state', function () {
  var f = setup();
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'バリデーションテスト'
  });

  var missingId = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { outcome: 'CONFIRMED_APPLIED' });
  assert.equal(missingId.success, false);
  assert.equal(missingId.error.code, 'SETTLEMENT_ID_REQUIRED');

  var invalidOutcome = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-x', outcome: 'BOGUS' });
  assert.equal(invalidOutcome.success, false);
  assert.equal(invalidOutcome.error.code, 'INVALID_SETTLEMENT_OUTCOME');

  var notFound = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 'does-not-exist', outcome: 'CONFIRMED_APPLIED' });
  assert.equal(notFound.success, false);
  assert.equal(notFound.error.code, 'SETTLEMENT_NOT_FOUND');

  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-needs-amount', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 500, refundedDelta: 0, note: ''
  });
  var missingAmount = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-needs-amount', outcome: 'CONFIRMED_APPLIED' });
  assert.equal(missingAmount.success, false);
  assert.equal(missingAmount.error.code, 'INVALID_AMOUNT');

  // どのバリデーションエラーもBookings側の復旧状態を変えていない。
  assert.ok(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt);
});

test('a reschedule that fails to record the new fee sends a mail that hides the (unconfirmed) fee amounts', function () {
  var f = setup();
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var original = f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = function () { throw new Error('Sheets API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '別途精算');
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = original;

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_UPDATE_FAILED_RECOVERY_REQUIRED');
  assert.equal(result.mailSent, true);
  assert.equal(f.mail._sentEmails.length, 1);
  var body = f.mail._sentEmails[0].body;
  assert.ok(body.indexOf('料金の確定処理は現在確認中です') !== -1);
  assert.equal(body.indexOf('元料金'), -1);
  assert.equal(body.indexOf('新料金'), -1);
  assert.equal(body.indexOf('差額'), -1);
});

test('a reschedule where the fee update AND the notification mail both fail still locks the booking into recovery and reports the mail failure', function () {
  var f = setup({ mailOptions: { throwError: new Error('mail down') } });
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var original = f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = function () { throw new Error('Sheets API error'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '別途精算');
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = original;

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_UPDATE_FAILED_RECOVERY_REQUIRED');
  assert.equal(result.mailSent, false);
  assert.ok(result.warning);
  assert.equal(f.mail._sentEmails.length, 0);

  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.ok(record.feeRecoveryRequiredAt);
  var changes = f.sandbox.adminGetBookingChanges('SNB-TEST-1');
  assert.equal(changes[0].mailState, 'FAILED');
});

/* ---- PR #345再レビュー対応（2回目）: 復旧処理自体の整合性・返金上限の再検証 ---- */

test('resolveFeeRecovery does not clear the recovery flag if Bookings fails right after the settlement ledger was confirmed, and a same-content retry safely finishes the job', function () {
  var f = setup();
  var originalPaid = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-half-1', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: '複合障害テスト'
  });

  var originalAtomic = f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = function () { throw new Error('Sheets API error'); };
  var corrections = { feePaidAmount: originalPaid + 1000, feeRefundedAmount: 0 };
  var resolution = { settlementId: 's-half-1', outcome: 'CONFIRMED_APPLIED' };
  var failed = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', corrections, resolution);
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = originalAtomic;

  assert.equal(failed.success, false);
  assert.equal(failed.error.code, 'UPDATE_FAILED');
  // 精算履歴側は既に確定しているが、Bookings側が終わるまで予約はブロックされたまま。
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-half-1').record.applyStatus, 'APPLIED');
  var stillRecovering = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.ok(stillRecovering.feeRecoveryRequiredAt);
  assert.equal(stillRecovering.feePaidAmount, originalPaid); // Bookings側はまだ一切変わっていない

  // 同一settlementId・同一内容で再送すれば、精算履歴側は冪等に上書きされるだけで、
  // 今度はBookings側も正しく反映されて復旧が完了する。
  var retried = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', corrections, resolution);
  assert.equal(retried.success, true);
  var afterRetry = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(afterRetry.feeRecoveryRequiredAt, '');
  assert.equal(afterRetry.feePaidAmount, originalPaid + 1000);
  assert.equal(Number(f.sandbox.FeeSettlementRepository.findBySettlementId('s-half-1').record.resultPaidAmount), originalPaid + 1000);
});

test('resolveFeeRecovery refuses to clear the recovery flag while another settlement on the same booking is still unresolved, but lets each be confirmed one at a time', function () {
  var f = setup();
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-multi-a', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 500, refundedDelta: 0, note: ''
  });
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-multi-b', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 300, refundedDelta: 0, note: ''
  });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: '複数精算が未確定'
  });

  // 1件目を確定しても、2件目がまだ残っているのでBookingsの復旧（フラグ解除）は完了しない。
  var first = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-multi-a', outcome: 'CONFIRMED_NOT_APPLIED' });
  assert.equal(first.success, false);
  assert.equal(first.error.code, 'OTHER_SETTLEMENT_UNRESOLVED');
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-multi-a').record.applyStatus, 'ABANDONED');
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-multi-b').record.applyStatus, 'PENDING_APPLY');
  assert.ok(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt);

  // 残りの1件を確定すれば、今度こそ復旧が完了する。
  var second = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-multi-b', outcome: 'CONFIRMED_NOT_APPLIED' });
  assert.equal(second.success, true);
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-multi-b').record.applyStatus, 'ABANDONED');
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt, '');
});

test('recordFeeSettlement re-validates the refund cap against the current balance when replaying an ABANDONED settlement, not just at first submission', function () {
  var f = setup();
  var before = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  var fullPaid = before.feePaidAmount;

  // s-refund-1は「未反映」と確定済み（ABANDONED）で、次の再送で初めて適用されるはずだった。
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-refund-1', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 0, refundedDelta: fullPaid, note: ''
  });
  var abandonRow = f.sandbox.FeeSettlementRepository.findBySettlementId('s-refund-1').rowNumber;
  f.sandbox.FeeSettlementRepository.markAbandoned(abandonRow);

  // ところが実際にはその間に、別の精算で既にfullPaid分の返金が記録済みだったとする
  // （復旧確認から今回の再送までの間に残高が変わったケース）。
  var settled = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-refund-2', 'SETTLED', 0, fullPaid, '');
  assert.equal(settled.success, true);
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRefundedAmount, fullPaid);

  // この状態でs-refund-1（返金額=fullPaid）を再送すると、未返金額は既に0のため拒否されるべき
  // （ABANDONEDからの再適用でも、新規精算と同じ返金上限チェックを必ず通す）。
  var retried = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-refund-1', 'SETTLED', 0, fullPaid, '');
  assert.equal(retried.success, false);
  assert.equal(retried.error.code, 'REFUND_EXCEEDS_UNREFUNDED');
  // 拒否された以上、返金額が二重に積み増されていないこと。
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRefundedAmount, fullPaid);
});

/* ---- PR #345再レビュー対応（3回目）: ABANDONED再適用の複合障害・孤立した未確定精算 ---- */

test('a compound failure right after the Bookings write on an ABANDONED replay (history + recovery flag both fail to save) is caught by resetting to PENDING_APPLY first, so a retry cannot double count', function () {
  var f = setup();
  var originalPaid = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-abandon-compound', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });
  var row = f.sandbox.FeeSettlementRepository.findBySettlementId('s-abandon-compound').rowNumber;
  f.sandbox.FeeSettlementRepository.markAbandoned(row);

  // Bookingsへの加算自体は成功するが、精算履歴をAPPLIEDにする処理と、復旧フラグを
  // 立てるフォールバックの両方が失敗する複合障害を再現する。
  var originalMarkApplied = f.sandbox.FeeSettlementRepository.markApplied;
  var originalUpdateBookingFields = f.sandbox.SpreadsheetRepository.updateBookingFields;
  f.sandbox.FeeSettlementRepository.markApplied = function () { throw new Error('markApplied failed'); };
  f.sandbox.SpreadsheetRepository.updateBookingFields = function () { throw new Error('flag save failed'); };
  var first = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-abandon-compound', 'SETTLED', 1000, 0, '');
  f.sandbox.FeeSettlementRepository.markApplied = originalMarkApplied;
  f.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdateBookingFields;

  assert.equal(first.success, false);
  assert.equal(first.error.code, 'SETTLEMENT_STATE_UNKNOWN');
  // ABANDONEDのまま残らず、適用を試みる前にPENDING_APPLYへ戻してあるため、
  // 状態遷移が両方失敗してもこの行はPENDING_APPLYのまま（「未反映」を騙らない）。
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-abandon-compound').record.applyStatus, 'PENDING_APPLY');
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, originalPaid + 1000);

  // 同じsettlementIdを再送しても、PENDING_APPLYの安全策（絶対に自動再試行しない）が
  // 効くため、二重加算されない。
  var retried = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-abandon-compound', 'SETTLED', 1000, 0, '');
  assert.equal(retried.success, false);
  assert.equal(retried.error.code, 'SETTLEMENT_RECOVERY_REQUIRED');
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, originalPaid + 1000);
  assert.ok(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt);
});

test('commit refuses to reschedule when an unresolved settlement is left dangling even though feeRecoveryRequiredAt itself failed to save', function () {
  var f = setup();
  var recordBefore = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  // 複合障害の再現: 精算行はPENDING_APPLYのまま残っているが、復旧フラグの保存自体は
  // 失敗した状態（feeRecoveryRequiredAtは立っていない）。
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-orphan-commit', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 500, refundedDelta: 0, note: ''
  });
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt, '');

  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '別途精算');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_RECOVERY_REQUIRED');
  // 日時・料金など何も変わっていないこと。
  assert.equal(f.event.getStartTime().getTime(), recordBefore.startAt.getTime());
  var recordAfter = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(recordAfter.scheduleChangeCount || 0, recordBefore.scheduleChangeCount || 0);
});

test('recordFeeSettlement refuses a different settlementId while another settlement on the same booking is unresolved, even without feeRecoveryRequiredAt, but still lets the stuck id itself resubmit through its normal handling', function () {
  var f = setup();
  var originalPaid = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-orphan-settlement', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 500, refundedDelta: 0, note: ''
  });
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt, '');

  // 別のsettlementIdによる新規精算は、復旧フラグが立っていなくても拒否される。
  var blockedDifferent = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-brand-new', 'SETTLED', 100, 0, '');
  assert.equal(blockedDifferent.success, false);
  assert.equal(blockedDifferent.error.code, 'FEE_RECOVERY_REQUIRED');
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, originalPaid);

  // 一方、当の未確定settlementId自身の再送は、この新しいチェックで弾かれず、
  // 既存のPENDING_APPLY処理（要復旧へ倒す）にそのまま進む。
  var sameId = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-orphan-settlement', 'SETTLED', 500, 0, '');
  assert.equal(sameId.success, false);
  assert.equal(sameId.error.code, 'SETTLEMENT_RECOVERY_REQUIRED');
  assert.ok(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt);
});

/* ---- PR #345再レビュー対応（4回目）: 復旧フラグ未設定でもresolveFeeRecoveryで復旧できること ---- */

test('resolveFeeRecovery can resolve a dangling unresolved settlement even when feeRecoveryRequiredAt itself never got saved, without allowing the settlementId to double count afterwards', function () {
  var f = setup();
  var originalPaid = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;
  // 復旧フラグの保存自体が失敗する複合障害を再現する: FeeSettlementsには未確定行が
  // 残っているが、feeRecoveryRequiredAtは立っていない。
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-flagless', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt, '');

  // commit・別settlementIdでのrecordFeeSettlementはどちらも拒否される（フラグが
  // 立っていなくても、hasUnresolvedSettlementにより拒否される）。
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var blockedCommit = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '別途精算');
  assert.equal(blockedCommit.success, false);
  assert.equal(blockedCommit.error.code, 'FEE_RECOVERY_REQUIRED');
  var blockedSettlement = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-brand-new-2', 'SETTLED', 100, 0, '');
  assert.equal(blockedSettlement.success, false);
  assert.equal(blockedSettlement.error.code, 'FEE_RECOVERY_REQUIRED');

  // フラグが立っていなくても、管理画面（resolveFeeRecovery）からは復旧できる
  // （NOT_IN_RECOVERYで弾かれてしまうと誰も復旧できなくなるデッドロックになる）。
  var resolved = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-flagless', outcome: 'CONFIRMED_NOT_APPLIED' });
  assert.equal(resolved.success, true);
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-flagless').record.applyStatus, 'ABANDONED');
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt, '');

  // 復旧後は通常どおり操作でき、同一settlementIdの再送も二重加算しない。
  var applied = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-flagless', 'SETTLED', 1000, 0, '');
  assert.equal(applied.success, true);
  assert.equal(applied.resultPaidAmount, originalPaid + 1000);
  var replay = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-flagless', 'SETTLED', 1000, 0, '');
  assert.equal(replay.success, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.resultPaidAmount, originalPaid + 1000);
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, originalPaid + 1000);
});

/* ---- PR #345再レビュー対応（5回目）: 確定済み精算をsettlementResolutionで反対の結果に書き換えられない ---- */

test('resolveFeeRecovery refuses to flip an already-APPLIED settlement to CONFIRMED_NOT_APPLIED, even while the booking is separately in recovery for an unrelated settlement', function () {
  var f = setup();
  // 精算Aが正常にAPPLIED済みの状態を作る。
  var applyResult = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-already-applied', 'SETTLED', 1000, 0, '');
  assert.equal(applyResult.success, true);
  var paidAfterApply = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;

  // 別の精算Bが未確定のまま残り、予約全体が要復旧になる（精算Aとは無関係の原因）。
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-unrelated-pending', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 300, refundedDelta: 0, note: ''
  });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: '別の精算Bが未確定'
  });

  // 復旧操作で、既にAPPLIED済みの精算Aを「未反映」に書き換えようとしても拒否される
  // （書き換えを許すと、その後の精算Aの再送がABANDONED分岐から二重加算しかねない）。
  var flipped = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-already-applied', outcome: 'CONFIRMED_NOT_APPLIED' });
  assert.equal(flipped.success, false);
  assert.equal(flipped.error.code, 'SETTLEMENT_STATE_MISMATCH');
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-already-applied').record.applyStatus, 'APPLIED');
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, paidAfterApply);
  assert.ok(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt);

  // 本来の原因である精算Bを正しく解決すれば、復旧は完了する。精算Aの状態は変わらない。
  var resolvedB = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-unrelated-pending', outcome: 'CONFIRMED_NOT_APPLIED' });
  assert.equal(resolvedB.success, true);
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt, '');
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-already-applied').record.applyStatus, 'APPLIED');

  // 復旧完了後、精算Aを再送しても安全な再送（replay）として扱われ、二重加算しない。
  var replay = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-already-applied', 'SETTLED', 1000, 0, '');
  assert.equal(replay.success, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.resultPaidAmount, paidAfterApply);
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, paidAfterApply);
});

test('resolveFeeRecovery refuses to flip an already-ABANDONED settlement to CONFIRMED_APPLIED', function () {
  var f = setup();
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-already-abandoned', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'テスト'
  });
  var resolved = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', {}, { settlementId: 's-already-abandoned', outcome: 'CONFIRMED_NOT_APPLIED' });
  assert.equal(resolved.success, true);
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-already-abandoned').record.applyStatus, 'ABANDONED');

  // 別原因で再び要復旧状態にする。
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: '別原因のテスト2'
  });
  var originalPaid = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;

  var flipped = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1',
    { feePaidAmount: originalPaid + 1000, feeRefundedAmount: 0 },
    { settlementId: 's-already-abandoned', outcome: 'CONFIRMED_APPLIED' });
  assert.equal(flipped.success, false);
  assert.equal(flipped.error.code, 'SETTLEMENT_STATE_MISMATCH');
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-already-abandoned').record.applyStatus, 'ABANDONED');
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, originalPaid);
});

test('resolveFeeRecovery still allows a same-content CONFIRMED_APPLIED idempotent retry against an already-APPLIED row (the legitimate "ledger confirmed, Bookings failed" recovery path)', function () {
  var f = setup();
  var originalPaid = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-idempotent-retry', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'テスト'
  });

  var corrections = { feePaidAmount: originalPaid + 1000, feeRefundedAmount: 0 };
  var resolution = { settlementId: 's-idempotent-retry', outcome: 'CONFIRMED_APPLIED' };
  var originalAtomic = f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = function () { throw new Error('Sheets API error'); };
  var first = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', corrections, resolution);
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = originalAtomic;
  assert.equal(first.success, false);
  assert.equal(first.error.code, 'UPDATE_FAILED');
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-idempotent-retry').record.applyStatus, 'APPLIED');

  // 精算履歴は既にAPPLIEDだが、同一内容（同じoutcome・同じ確定金額）の再送は
  // SETTLEMENT_STATE_MISMATCHにせず、既存の複合障害リカバリ経路として許可する。
  var retried = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', corrections, resolution);
  assert.equal(retried.success, true);
  var afterRetry = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(afterRetry.feeRecoveryRequiredAt, '');
  assert.equal(afterRetry.feePaidAmount, originalPaid + 1000);
});

/* ---- PR #345再レビュー対応（6回目）: 復旧時に返金済み額が支払済み額を超える不整合を防ぐ ---- */

test('resolveFeeRecovery rejects corrections where feeRefundedAmount exceeds feePaidAmount, leaving Bookings and FeeSettlements untouched', function () {
  var f = setup();
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'テスト'
  });
  var before = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;

  var result = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', { feePaidAmount: 1000, feeRefundedAmount: 2000 });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'REFUND_EXCEEDS_PAID');

  var after = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(after.feePaidAmount, before.feePaidAmount, 'Bookingsは変更されていないこと');
  assert.equal(after.feeRefundedAmount, before.feeRefundedAmount, 'Bookingsは変更されていないこと');
  assert.ok(after.feeRecoveryRequiredAt, '検証失敗時は要復旧状態を維持すること');
});

test('resolveFeeRecovery rejects when only one of feePaidAmount/feeRefundedAmount is corrected and the resulting combination (with the other falling back to the current Bookings value) would violate refunded<=paid', function () {
  var f = setup({ feePaidAmount: 1000, feeRefundedAmount: 1000 });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'テスト'
  });

  // feeRefundedAmountを補正せず、feePaidAmountだけを現在の返金済み額未満に下げようとすると、
  // 最終的な組み合わせ（新feePaidAmount, 現在のfeeRefundedAmount=1000）が不整合になる。
  var result = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', { feePaidAmount: 500 });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'REFUND_EXCEEDS_PAID');
  var after = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(after.feePaidAmount, 1000, 'Bookingsは変更されていないこと');
});

test('resolveFeeRecovery rejects non-integer feePaidAmount/feeRefundedAmount corrections', function () {
  var f = setup();
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'テスト'
  });

  var badPaid = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', { feePaidAmount: 1000.5 });
  assert.equal(badPaid.success, false);
  assert.equal(badPaid.error.code, 'INVALID_AMOUNT');

  var badRefunded = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', { feeRefundedAmount: 500.5 });
  assert.equal(badRefunded.success, false);
  assert.equal(badRefunded.error.code, 'INVALID_AMOUNT');
});

test('resolveFeeRecovery(CONFIRMED_APPLIED) rejects a settlement resolution whose result amounts would make feeRefundedAmount exceed feePaidAmount, without touching FeeSettlements', function () {
  var f = setup();
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-inconsistent-applied', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0, note: ''
  });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'テスト'
  });

  var result = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1',
    { feePaidAmount: 1000, feeRefundedAmount: 2000 },
    { settlementId: 's-inconsistent-applied', outcome: 'CONFIRMED_APPLIED' });
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'REFUND_EXCEEDS_PAID');

  // FeeSettlements側もBookings側も一切書き換えられていないこと（要復旧状態も維持）。
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-inconsistent-applied').record.applyStatus, 'PENDING_APPLY');
  assert.ok(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt);
});

test('resolveFeeRecovery accepts a valid feePaidAmount/feeRefundedAmount combination and a same-content retry after that still succeeds', function () {
  var f = setup();
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: 'テスト'
  });

  var corrections = { feePaidAmount: 2000, feeRefundedAmount: 1000 };
  var resolved = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', corrections);
  assert.equal(resolved.success, true);
  var after = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(after.feePaidAmount, 2000);
  assert.equal(after.feeRefundedAmount, 1000);
  assert.equal(after.feeRecoveryRequiredAt, '');

  // 復旧完了後にBookingsのatomic更新が失敗した場合でも、同一内容のリトライは
  // 引き続き成功する（既存のロジックに新しい検証を追加しただけであることの確認）。
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', {
    feeRecoveryRequiredAt: new Date(), feeRecoveryReason: '別原因のテスト'
  });
  var retried = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', corrections);
  assert.equal(retried.success, true);
});

/* ---- 基準料金（既存予約の遡及登録） ---- */

test('commit is blocked until the original confirmed price has been backfilled via backfillOriginalPrice', function () {
  var f = setup({ withPrice: false });
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '別途精算');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_BASELINE_REQUIRED');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.startAt.getTime(), f.event.getStartTime().getTime());

  var backfill = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '過去の請求メールで確認');
  assert.equal(backfill.success, true);
  var afterBackfill = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(afterBackfill.priceAmount, 4000);
  assert.equal(afterBackfill.priceTier, 'GENERAL');
  assert.ok(afterBackfill.priceDayType);

  var afterBackfillResult = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '別途精算');
  assert.equal(afterBackfillResult.success, true);
});

test('backfillOriginalPrice validates its inputs (tier, amount, basis note)', function () {
  var f = setup({ withPrice: false });
  assert.equal(f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'vip', 4000, '根拠').error.code, 'INVALID_PRICE_TIER');
  assert.equal(f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', -1, '根拠').error.code, 'INVALID_AMOUNT');
  assert.equal(f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '  ').error.code, 'BASIS_REQUIRED');
  assert.equal(f.sandbox.adminBackfillOriginalPrice('UNKNOWN', 'GENERAL', 4000, '根拠').error.code, 'NOT_FOUND');
});

/* ---- PR #345再レビュー対応（7回目）: backfillOriginalPriceのLock・atomic書込み・検証 ---- */

test('backfillOriginalPrice refuses when an unresolved settlement is left dangling even though feeRecoveryRequiredAt itself is not set', function () {
  var f = setup({ withPrice: false });
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-baseline-orphan', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 500, refundedDelta: 0, note: ''
  });
  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feeRecoveryRequiredAt, '');

  var result = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_RECOVERY_REQUIRED');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.ok(!record.priceAmount, '基準料金は書き込まれていないこと');
});

test('backfillOriginalPrice returns LOCK_TIMEOUT when the script lock is already held (e.g. a concurrent commit)', function () {
  var f = setup({ withPrice: false });
  var externalLock = f.sandbox.LockService.getScriptLock();
  assert.equal(externalLock.tryLock(), true);
  var result = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');
  externalLock.releaseLock();
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'LOCK_TIMEOUT');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.ok(!record.priceAmount);
});

test('backfillOriginalPrice re-reads the booking after acquiring the lock, seeing a status change made just before the call', function () {
  var f = setup({ withPrice: false });
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', { status: 'CANCELLED' });
  var result = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'INVALID_STATUS');
});

test('backfillOriginalPrice sets feeRecoveryRequiredAt and does not silently succeed when the price-baseline write fails and the old values are confirmed still in place', function () {
  var f = setup({ withPrice: false });
  var original = f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = function () { throw new Error('Sheets API error'); };
  var result = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = original;

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'BASELINE_RECOVERY_REQUIRED');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.ok(!record.priceAmount, '書込みは実際に行われていない（半端な状態にもなっていない）');
  assert.ok(record.feeRecoveryRequiredAt, '結果不明のため要復旧にする（best effort）');
  assert.ok(f.sandbox.RecoveryRepository.hasOpenBaselineRecovery('SNB-TEST-1'), 'Recoveryへ永続的な停止条件が記録されていること');

  var blockedReschedule = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  assert.equal(blockedReschedule.success, false);
  assert.equal(blockedReschedule.error.code, 'FEE_RECOVERY_REQUIRED');
});

test('backfillOriginalPrice treats the write as successful when verification shows all 5 baseline columns already match, even though the write call itself threw afterward', function () {
  var f = setup({ withPrice: false });
  var original = f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = function (bid, fields) {
    original(bid, fields); // 実際の書込みは成功させる
    throw new Error('confirmation lost after a successful write (e.g. request timeout)');
  };
  var result = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = original;

  assert.equal(result.success, true);
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.priceAmount, 4000);
  assert.equal(record.priceTier, 'GENERAL');
  assert.equal(record.feeRecoveryRequiredAt, '', '実際には書き込めていたので要復旧にしない');
});

/* ---- PR #345再レビュー対応（8回目）: 基準料金更新と復旧フラグ保存が両方失敗する複合障害 ---- */

test('a compound failure (baseline write unconfirmed AND feeRecoveryRequiredAt save also fails) still blocks the next backfillOriginalPrice/commit/recordFeeSettlement via the independent Recovery marker, and the admin can resolve it', function () {
  var f = setup({ withPrice: false });
  var originalAtomic = f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic;
  var originalUpdateFields = f.sandbox.SpreadsheetRepository.updateBookingFields;
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = function () { throw new Error('Sheets API error'); };
  f.sandbox.SpreadsheetRepository.updateBookingFields = function () { throw new Error('flag save failed'); };
  var result = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = originalAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdateFields;

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'BASELINE_RECOVERY_REQUIRED');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.feeRecoveryRequiredAt, '', 'フラグの保存自体は失敗しているので立っていない');
  assert.ok(f.sandbox.RecoveryRepository.hasOpenBaselineRecovery('SNB-TEST-1'), 'Recoveryには独立した停止条件が残っている');

  // フラグが立っていなくても、Recoveryが残っているため次の別リクエストはすべて拒否される。
  var blockedBackfill = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 5000, '別の根拠');
  assert.equal(blockedBackfill.success, false);
  assert.equal(blockedBackfill.error.code, 'FEE_RECOVERY_REQUIRED');

  var blockedCommit = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  assert.equal(blockedCommit.success, false);
  assert.equal(blockedCommit.error.code, 'FEE_RECOVERY_REQUIRED');

  var blockedSettlement = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-x', 'SETTLED', 100, 0, '');
  assert.equal(blockedSettlement.success, false);
  assert.equal(blockedSettlement.error.code, 'FEE_RECOVERY_REQUIRED');

  // resolveFeeRecoveryはフラグが立っていなくても受け付けるが、基準料金5列は
  // corrections（priceOverrideAmount等）では代用できないため復旧完了にはならない。
  var wrongPath = f.sandbox.adminResolveFeeRecovery('SNB-TEST-1', { scheduleChangeCount: 0 });
  assert.equal(wrongPath.success, false);
  assert.equal(wrongPath.error.code, 'OTHER_SETTLEMENT_UNRESOLVED');
  assert.ok(f.sandbox.RecoveryRepository.hasOpenBaselineRecovery('SNB-TEST-1'), '誤った経路では解消されない');

  // 基準料金専用の復旧パスを使えば安全に復旧できる。
  var resolved = f.sandbox.adminResolveBaselinePriceRecovery('SNB-TEST-1', 'GENERAL', 4500);
  assert.equal(resolved.success, true);
  assert.equal(f.sandbox.RecoveryRepository.hasOpenBaselineRecovery('SNB-TEST-1'), false);
  var afterResolve = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(afterResolve.priceAmount, 4500);
  assert.equal(afterResolve.priceTier, 'GENERAL');

  // 復旧後は通常どおり操作できる。
  var afterResult = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  assert.equal(afterResult.success, true);
});

test('when RecoveryRepository.recordFailure also fails, the independent Script Properties marker still blocks the next requests, and resolving via resolveBaselinePriceRecovery clears it', function () {
  var f = setup({ withPrice: false });
  var originalAtomic = f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic;
  var originalRecordFailure = f.sandbox.RecoveryRepository.recordFailure;
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = function () { throw new Error('Sheets API error'); };
  f.sandbox.RecoveryRepository.recordFailure = function () { throw new Error('Recovery sheet write failed'); };
  var result = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = originalAtomic;
  f.sandbox.RecoveryRepository.recordFailure = originalRecordFailure;

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'BASELINE_RECOVERY_REQUIRED');
  assert.equal(f.sandbox.RecoveryRepository.hasOpenBaselineRecovery('SNB-TEST-1'), false, 'Recoveryへの記録自体は失敗している');

  var blocked = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  assert.equal(blocked.success, false);
  assert.equal(blocked.error.code, 'FEE_RECOVERY_REQUIRED');

  var resolved = f.sandbox.adminResolveBaselinePriceRecovery('SNB-TEST-1', 'GENERAL', 4200);
  assert.equal(resolved.success, true);
  var afterResult = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  assert.equal(afterResult.success, true);
});

test('when both RecoveryRepository and the Script Properties marker fail to persist, backfillOriginalPrice returns a distinct RECOVERY_PERSISTENCE_UNKNOWN error rather than claiming a safe block', function () {
  var f = setup({ withPrice: false });
  var originalAtomic = f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic;
  var originalRecordFailure = f.sandbox.RecoveryRepository.recordFailure;
  var originalProperties = f.sandbox.PropertiesService;
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = function () { throw new Error('Sheets API error'); };
  f.sandbox.RecoveryRepository.recordFailure = function () { throw new Error('Recovery sheet write failed'); };
  f.sandbox.PropertiesService = stubs.createPropertiesServiceStub({
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1',
    BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'reply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com'
  }, { setPropertyError: new Error('Properties write failed') });

  var result = f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');

  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = originalAtomic;
  f.sandbox.RecoveryRepository.recordFailure = originalRecordFailure;
  f.sandbox.PropertiesService = originalProperties;

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'RECOVERY_PERSISTENCE_UNKNOWN');
});

test('isBlockedForFeeRecovery_ fails closed (blocks) when reading the Recovery sheet itself throws', function () {
  var f = setup();
  var original = f.sandbox.RecoveryRepository.hasOpenBaselineRecovery;
  f.sandbox.RecoveryRepository.hasOpenBaselineRecovery = function () { throw new Error('Recovery sheet read failed'); };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '別途精算');
  f.sandbox.RecoveryRepository.hasOpenBaselineRecovery = original;

  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_RECOVERY_REQUIRED');
});

test('resolveBaselinePriceRecovery refuses when there is no open baseline recovery', function () {
  var f = setup();
  var result = f.sandbox.adminResolveBaselinePriceRecovery('SNB-TEST-1', 'GENERAL', 4000);
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'NOT_IN_RECOVERY');
});

test('resolveBaselinePriceRecovery validates its inputs (tier, amount)', function () {
  var f = setup({ withPrice: false });
  var original = f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = function () { throw new Error('x'); };
  f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = original;

  assert.equal(f.sandbox.adminResolveBaselinePriceRecovery('SNB-TEST-1', 'vip', 4000).error.code, 'INVALID_PRICE_TIER');
  assert.equal(f.sandbox.adminResolveBaselinePriceRecovery('SNB-TEST-1', 'GENERAL', -1).error.code, 'INVALID_AMOUNT');
});

test('resolveBaselinePriceRecovery keeps the recovery open and reports UPDATE_FAILED when its own write fails, allowing a same-content retry to succeed', function () {
  var f = setup({ withPrice: false });
  var originalAtomic = f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = function () { throw new Error('x'); };
  f.sandbox.adminBackfillOriginalPrice('SNB-TEST-1', 'GENERAL', 4000, '根拠');

  var failedResolve = f.sandbox.adminResolveBaselinePriceRecovery('SNB-TEST-1', 'GENERAL', 4200);
  assert.equal(failedResolve.success, false);
  assert.equal(failedResolve.error.code, 'UPDATE_FAILED');
  assert.ok(f.sandbox.RecoveryRepository.hasOpenBaselineRecovery('SNB-TEST-1'), '失敗時はOPENのまま維持する');

  f.sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic = originalAtomic;
  var resolved = f.sandbox.adminResolveBaselinePriceRecovery('SNB-TEST-1', 'GENERAL', 4200);
  assert.equal(resolved.success, true);
  assert.equal(f.sandbox.RecoveryRepository.hasOpenBaselineRecovery('SNB-TEST-1'), false);
});

/* ---- PR #345再レビュー対応（7回目）: recordFeeSettlementの円単位整数検証・既存累計額の破損検知 ---- */

test('recordFeeSettlement rejects non-integer paidAmountDelta/refundedAmountDelta (fractional yen), without creating a FeeSettlements row', function () {
  var f = setup();
  var before = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount;

  var badPaid = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-frac-1', 'SETTLED', 1000.5, 0, '');
  assert.equal(badPaid.success, false);
  assert.equal(badPaid.error.code, 'INVALID_AMOUNT');

  var badRefund = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-frac-2', 'SETTLED', 0, 0.5, '');
  assert.equal(badRefund.success, false);
  assert.equal(badRefund.error.code, 'INVALID_AMOUNT');

  assert.equal(f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record.feePaidAmount, before);
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-frac-1'), null);
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-frac-2'), null);
});

test('recordFeeSettlement refuses a brand-new settlement when the booking existing cumulative amounts are already corrupt, instead of silently treating them as zero', function () {
  var f = setup();
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', { feePaidAmount: 1000.5 });

  var result = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-corrupt-1', 'SETTLED', 100, 0, '');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_RECOVERY_REQUIRED');
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-corrupt-1'), null, '検証前に台帳へ行を作らない');
});

test('recordFeeSettlement refuses an ABANDONED reapply too when the current cumulative amounts are corrupt (refunded > paid)', function () {
  var f = setup();
  f.sandbox.FeeSettlementRepository.appendPending({
    settlementId: 's-corrupt-2', bookingId: 'SNB-TEST-1', changeId: '',
    settlementState: 'SETTLED', paidDelta: 500, refundedDelta: 0, note: ''
  });
  f.sandbox.FeeSettlementRepository.markAbandoned(f.sandbox.FeeSettlementRepository.findBySettlementId('s-corrupt-2').rowNumber);
  f.sandbox.SpreadsheetRepository.updateBookingFields('SNB-TEST-1', { feeRefundedAmount: 999999999 });

  var result = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 's-corrupt-2', 'SETTLED', 500, 0, '');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'FEE_RECOVERY_REQUIRED');
  assert.equal(f.sandbox.FeeSettlementRepository.findBySettlementId('s-corrupt-2').record.applyStatus, 'ABANDONED', 'PENDING_APPLYへ戻していない（検証で弾かれたため）');
});

/* ---- 料金差額の判定（増額・初回減額・2回目以降・端数） ---- */

test('a same-duration reschedule to a different day-type (weekday→weekend) charges the additional amount, no ambiguity', function () {
  var f = setup(); // 平日2h、priceAmount=平日料金で登録済み
  var weekendDate = findDateOfDayType_(f.sandbox, 40, true);
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1',
    { date: weekendDate, startTime: '10:00', endTime: '12:00' }, version_(f));
  assert.equal(preview.feeReady, true);
  assert.equal(preview.dayType, 'WEEKEND_HOLIDAY');
  assert.ok(preview.feeDifference > 0);
  assert.equal(preview.refundStatus, 'ADDITIONAL_CHARGE_REQUIRED');

  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: weekendDate, startTime: '10:00', endTime: '12:00' }, version_(f), '', '差額は別途請求');
  assert.equal(result.success, true);
  assert.equal(result.refundStatus, 'ADDITIONAL_CHARGE_REQUIRED');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(f.sandbox.Booking.getEffectivePriceAmount(record), preview.newFeeAmount);
  assert.equal(record.feeSettlementState, 'PENDING_CHARGE');
});

test('a first, before-the-day-before shortening auto-refunds up to the paid amount with no cancellation fee', function () {
  var f = setup({ priceAmount: 8000, feePaidAmount: 8000 }); // 4hぶん支払済みとして登録
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' }; // 同日2hへ短縮
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version_(f));
  assert.equal(preview.refundStatus, 'CANDIDATE');
  assert.equal(preview.refundCandidateAmount, 8000 - preview.newFeeAmount);

  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '返金予定');
  assert.equal(result.success, true);
  assert.equal(result.refundStatus, 'CANDIDATE');
  assert.equal(result.refundAmount, 8000 - result.newFeeAmount);
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.feeSettlementState, 'PENDING_REFUND');
});

test('a second schedule change that reduces the fee is blocked until the admin enters an explicit refund decision', function () {
  var f = setup({ priceAmount: 8000, feePaidAmount: 8000, scheduleChangeCount: 1 });
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version_(f));
  assert.equal(preview.refundStatus, 'PENDING_POLICY_DECISION');
  assert.equal(preview.requiresManualRefundDecision, true);

  var blocked = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '要確認');
  assert.equal(blocked.success, false);
  assert.equal(blocked.error.code, 'FEE_REFUND_DECISION_REQUIRED');
  var stillOld = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(stillOld.startAt.getTime(), f.event.getStartTime().getTime());

  var decided = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '要確認', {
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
  var f = setup({ priceAmount: 8000, feePaidAmount: 8000, scheduleChangeCount: 1 });
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var overshoot = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '要確認', {
    manualRefundDecision: { approvedAmount: 999999, note: '上限超え' }
  });
  assert.equal(overshoot.success, false);
  assert.equal(overshoot.error.code, 'FEE_REFUND_DECISION_REQUIRED');
});

test('a half-hour (non-whole-hour) rounded duration is not auto-priced (unapproved 30-minute interpolation) and requires a manual fee entry', function () {
  var f = setup();
  var input = { date: f.date, startTime: '13:00', endTime: '15:20' }; // 140分 -> 30分丸めで150分(2.5h)
  var preview = f.sandbox.adminPreviewBookingReschedule('SNB-TEST-1', input, version_(f));
  assert.equal(preview.feeReady, false);
  assert.equal(preview.feeStatus, 'HALF_HOUR_RATE_UNCONFIRMED');
  assert.equal(preview.requiresManualNewFee, true);

  var blocked = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '要確認');
  assert.equal(blocked.success, false);
  assert.equal(blocked.error.code, 'FEE_NOT_AVAILABLE');

  var manual = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '要確認', {
    manualNewFeeAmount: 5000, manualNewFeeNote: '2.5h相当として運営確認済み'
  });
  assert.equal(manual.success, true);
  assert.equal(manual.newFeeAmount, 5000);
  assert.equal(manual.refundStatus, 'ADDITIONAL_CHARGE_REQUIRED');
});

/* ---- 精算の冪等性（PR #345レビュー必須修正2） ---- */

test('recordFeeSettlement records actual money movement without touching the fee amount itself', function () {
  var f = setup({ priceAmount: 8000, feePaidAmount: 8000 });
  var input = { date: f.date, startTime: '13:00', endTime: '15:00' };
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1', input, version_(f), '', '返金予定');
  assert.equal(result.success, true);
  var settlement = f.sandbox.adminRecordRescheduleFeeSettlement(
    'SNB-TEST-1', result.changeId, 'settle-1', 'SETTLED', 0, result.refundAmount, 'PayPayで返金済み'
  );
  assert.equal(settlement.success, true);
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.feeRefundedAmount, result.refundAmount);
  assert.equal(record.feeSettlementState, 'SETTLED');
  assert.equal(f.sandbox.Booking.getEffectivePriceAmount(record), result.newFeeAmount);
});

test('resubmitting the exact same settlementId is a safe no-op (no double counting)', function () {
  var f = setup({ priceAmount: 8000, feePaidAmount: 8000 });
  f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '返金予定');
  var first = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 'settle-dup', 'PENDING_REFUND', 0, 1000, '一部返金');
  assert.equal(first.success, true);
  var second = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 'settle-dup', 'PENDING_REFUND', 0, 1000, '一部返金');
  assert.equal(second.success, true);
  assert.equal(second.replay, true);
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.feeRefundedAmount, 1000); // 2000ではない（二重加算していない）
});

test('reusing a settlementId with different content is rejected', function () {
  var f = setup({ priceAmount: 8000, feePaidAmount: 8000 });
  f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '返金予定');
  f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 'settle-conflict', 'PENDING_REFUND', 0, 1000, 'メモA');
  var conflict = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 'settle-conflict', 'PENDING_REFUND', 0, 2000, 'メモB');
  assert.equal(conflict.success, false);
  assert.equal(conflict.error.code, 'SETTLEMENT_ID_CONFLICT');
  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.equal(record.feeRefundedAmount, 1000); // 拒否されたリクエストは反映されない
});

test('a changeId that belongs to a different booking is rejected', function () {
  var f = setup({ priceAmount: 8000, feePaidAmount: 8000 });
  var result = f.sandbox.adminRescheduleBooking('SNB-TEST-1',
    { date: f.date, startTime: '13:00', endTime: '15:00' }, version_(f), '', '返金予定');
  var other = f.sandbox.adminRecordRescheduleFeeSettlement('OTHER-BOOKING-ID', result.changeId, 'settle-x2', 'SETTLED', 0, 0, '');
  assert.equal(other.success, false);
  assert.equal(other.error.code, 'NOT_FOUND'); // OTHER-BOOKING-ID自体が存在しない
});

test('a refund exceeding the unrefunded paid amount is rejected', function () {
  var f = setup({ priceAmount: 8000, feePaidAmount: 1000 });
  var result = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 'settle-over', 'PENDING_REFUND', 0, 2000, '');
  assert.equal(result.success, false);
  assert.equal(result.error.code, 'REFUND_EXCEEDS_UNREFUNDED');
});

test('a Bookings-side apply failure after the settlement ledger row is recorded locks the booking for recovery instead of double counting on retry', function () {
  var f = setup({ priceAmount: 8000, feePaidAmount: 8000 });
  var original = f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic;
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = function () { throw new Error('Sheets API error'); };
  var failed = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 'settle-fail', 'PENDING_REFUND', 0, 500, '');
  f.sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic = original;
  assert.equal(failed.success, false);
  assert.equal(failed.error.code, 'SETTLEMENT_APPLY_FAILED');

  var record = f.sandbox.SpreadsheetRepository.findRowByBookingId('SNB-TEST-1').record;
  assert.ok(record.feeRecoveryRequiredAt);

  // 復旧するまでは同じIDでの再送も拒否される。
  var retry = f.sandbox.adminRecordRescheduleFeeSettlement('SNB-TEST-1', null, 'settle-fail', 'PENDING_REFUND', 0, 500, '');
  assert.equal(retry.success, false);
  assert.equal(retry.error.code, 'FEE_RECOVERY_REQUIRED');
});
