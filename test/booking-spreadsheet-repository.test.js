/*
 * gas/booking/shared/SpreadsheetRepository.gs / RecoveryRepository.gs のテスト。
 * SpreadsheetAppはメモリ上のシートスタブに差し替える。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var SPREADSHEET_ID = 'ss1';

function loadRepos(sheetsByName) {
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = sheetsByName || {};
  return loadBookingSandbox(['Config.gs', 'Availability.gs', 'SpreadsheetRepository.gs', 'RecoveryRepository.gs'], {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: SPREADSHEET_ID }),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById)
  });
}

function sampleRecord(overrides) {
  return Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      createdAt: new Date('2026-09-30T10:00:00+09:00'),
      date: '2026-10-01',
      startAt: new Date('2026-10-01T10:00:00+09:00'),
      endAt: new Date('2026-10-01T12:00:00+09:00'),
      brand: 'studio_x',
      name: '山田太郎',
      email: 'taro@example.com',
      phone: '090-0000-0000',
      people: '2名',
      purpose: '緊縛の自主練習',
      paymentMethod: '現金',
      status: 'PENDING',
      calendarEventId: 'event-1',
      source: 'test',
      note: ''
    },
    overrides || {}
  );
}

test('appendBooking: シートが存在しない場合は自動作成し、ヘッダー行を書く', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.ok(found, 'appendしたbookingIdが見つかるべき');
  assert.strictEqual(found.record.status, 'PENDING');
  assert.strictEqual(found.record.brand, 'studio_x');
  assert.strictEqual(found.record.email, 'taro@example.com');
});

test('findRowByBookingId: 存在しないbookingIdはnullを返す', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());
  assert.strictEqual(sandbox.SpreadsheetRepository.findRowByBookingId('NOT-EXIST'), null);
});

test('updateBookingFields: statusとconfirmedAt等の指定フィールドのみ更新する', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());

  var confirmedAt = new Date('2026-10-01T09:00:00+09:00');
  sandbox.SpreadsheetRepository.updateBookingFields('SX-20261001-AAAAAAAA', {
    status: 'CONFIRMED',
    confirmedAt: confirmedAt,
    updatedAt: confirmedAt
  });

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.status, 'CONFIRMED');
  assert.strictEqual(found.record.confirmedAt.getTime(), confirmedAt.getTime());
  assert.strictEqual(found.record.name, '山田太郎', '更新対象外のフィールドは変化しない');
});

test('updateBookingFields: 存在しないbookingIdは例外を投げる', function () {
  var sandbox = loadRepos();
  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingFields('NOT-EXIST', { status: 'CONFIRMED' });
  });
});

test('updateBookingFields: 未知のフィールド名は例外を投げる（statusセルへの想定外書き込みを防ぐ）', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());
  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingFields('SX-20261001-AAAAAAAA', { unknownField: 'x' });
  });
});

/*
 * updateBookingCancellationStateAtomic（Issue #272 PRレビュー2回目対応）:
 * status/cancelledAt/updatedAtの3項目だけを、HEADERS_上で連続する'status'（13列目）〜
 * 'updatedAt'（20列目）の範囲に対する1回のsetValuesで更新する。cancelBookingAdmin専用の
 * 用途に限定し、mail SentAt・lastMailError*・customerType（21列目以降）へは
 * 一切書き込まない（別GASプロジェクトであるBooking Web App側の更新を巻き戻さないため。
 * 初回対応のupdateBookingFieldsAtomicはBookings行全29列を丸ごと書き戻していたため
 * この競合リスクがあり、2回目レビューで指摘され撤回した）。
 */
test('updateBookingCancellationStateAtomic: status/cancelledAt/updatedAtの3列だけを1回の書き込みで更新し、範囲内の他フィールド・mail列・customerTypeは変化しない', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());

  var pendingMailSentAt = new Date('2026-10-01T08:00:00+09:00');
  var confirmedMailSentAt = new Date('2026-10-01T08:30:00+09:00');
  sandbox.SpreadsheetRepository.updateBookingFields('SX-20261001-AAAAAAAA', {
    pendingMailSentAt: pendingMailSentAt,
    confirmedMailSentAt: confirmedMailSentAt,
    lastMailErrorType: 'TEST',
    customerType: 'returning'
  });

  var cancelledAt = new Date('2026-10-01T09:00:00+09:00');
  sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic('SX-20261001-AAAAAAAA', {
    status: 'CANCELLED',
    cancelledAt: cancelledAt,
    updatedAt: cancelledAt
  });

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.strictEqual(found.record.cancelledAt.getTime(), cancelledAt.getTime());
  assert.strictEqual(found.record.updatedAt.getTime(), cancelledAt.getTime());
  assert.strictEqual(found.record.name, '山田太郎', '範囲外（1〜12列目）のフィールドは変化しない');
  assert.strictEqual(found.record.calendarEventId, 'event-1', '範囲内（14〜18列目）だが指定していないフィールドは元値のまま維持される');
  assert.strictEqual(found.record.pendingMailSentAt.getTime(), pendingMailSentAt.getTime(), 'mail SentAt列（21列目以降）は書き換えない');
  assert.strictEqual(found.record.confirmedMailSentAt.getTime(), confirmedMailSentAt.getTime());
  assert.strictEqual(found.record.lastMailErrorType, 'TEST');
  assert.strictEqual(found.record.customerType, 'returning');

  var sheet = sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  var lastCall = sheet._setValuesCalls[sheet._setValuesCalls.length - 1];
  assert.strictEqual(lastCall.col, 13, 'statusは13列目から始まる（HEADERS_の並び順どおり）');
  assert.strictEqual(lastCall.numCols, 8, 'status(13)〜updatedAt(20)の8列だけを1回で書く');
  assert.strictEqual(lastCall.numRows, 1);
});

test('updateBookingCancellationStateAtomic: 存在しないbookingIdは例外を投げる（書き込み自体を行わない）', function () {
  var sandbox = loadRepos();
  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic('NOT-EXIST', { status: 'CANCELLED' });
  });
});

test('updateBookingCancellationStateAtomic: status/cancelledAt/updatedAt以外のフィールドは例外を投げ、行自体を書き換えない（mail列等への誤用を防ぐ）', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());

  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic('SX-20261001-AAAAAAAA', { pendingMailSentAt: new Date() });
  });

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.status, 'PENDING', '例外発生時は行を書き換えない（範囲書き込み前にフィールド名を検証するため）');
});

/*
 * updateBookingPriceBaselineAtomic（PR #345再レビュー対応・7回目。BookingReschedule.
 * backfillOriginalPrice専用）: priceAmount〜priceComputedAtの5列だけを、HEADERS_上で
 * 連続する範囲に対する1回のsetValuesで更新する。updateBookingCancellationStateAtomicと
 * 同じ設計で、範囲外（priceOverrideAmount等の日程変更専用フィールドや精算累計額）へは
 * 一切書き込まない。
 */
test('updateBookingPriceBaselineAtomic: priceAmount〜priceComputedAtの5列だけを1回の書き込みで更新し、範囲外のpriceOverrideAmount等は変化しない', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({ status: 'CONFIRMED' }));
  sandbox.SpreadsheetRepository.updateBookingRescheduleFeeAtomic('SX-20261001-AAAAAAAA', {
    priceOverrideAmount: 9999, priceOverrideAt: new Date('2026-09-20T00:00:00+09:00'),
    scheduleChangeCount: 1, feePaidAmount: 5000
  });

  var computedAt = new Date('2026-10-01T09:00:00+09:00');
  sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic('SX-20261001-AAAAAAAA', {
    priceAmount: 8000, priceTier: 'MEMBER', priceDayType: 'WEEKEND_HOLIDAY',
    priceIsMember: true, priceComputedAt: computedAt
  });

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.priceAmount, 8000);
  assert.strictEqual(found.record.priceTier, 'MEMBER');
  assert.strictEqual(found.record.priceDayType, 'WEEKEND_HOLIDAY');
  assert.strictEqual(found.record.priceIsMember, true);
  assert.strictEqual(found.record.priceComputedAt.getTime(), computedAt.getTime());
  // 範囲外（priceOverrideAmount以降）は変化しない。
  assert.strictEqual(found.record.priceOverrideAmount, 9999);
  assert.strictEqual(found.record.scheduleChangeCount, 1);
  assert.strictEqual(found.record.feePaidAmount, 5000);

  var sheet = sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  var lastCall = sheet._setValuesCalls[sheet._setValuesCalls.length - 1];
  assert.strictEqual(lastCall.col, sandbox.SpreadsheetRepository.HEADERS.indexOf('priceAmount') + 1);
  assert.strictEqual(lastCall.numCols, 5, 'priceAmount〜priceComputedAtの5列だけを1回で書く');
  assert.strictEqual(lastCall.numRows, 1);
});

test('updateBookingPriceBaselineAtomic: 指定しなかった列は既存値のまま維持される', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({
    status: 'CONFIRMED', priceAmount: 6000, priceTier: 'GENERAL',
    priceDayType: 'WEEKDAY', priceIsMember: false, priceComputedAt: new Date('2026-09-01T00:00:00+09:00')
  }));

  sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic('SX-20261001-AAAAAAAA', { priceAmount: 7000 });

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.priceAmount, 7000);
  assert.strictEqual(found.record.priceTier, 'GENERAL', '指定していないフィールドは元値のまま維持される');
  assert.strictEqual(found.record.priceDayType, 'WEEKDAY');
  assert.strictEqual(found.record.priceIsMember, false);
});

test('updateBookingPriceBaselineAtomic: 存在しないbookingIdは例外を投げる（書き込み自体を行わない）', function () {
  var sandbox = loadRepos();
  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic('NOT-EXIST', { priceAmount: 1000 });
  });
});

test('updateBookingPriceBaselineAtomic: priceAmount〜priceComputedAt以外のフィールドは例外を投げ、行自体を書き換えない', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({ status: 'CONFIRMED', priceAmount: 6000 }));

  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingPriceBaselineAtomic('SX-20261001-AAAAAAAA', { priceOverrideAmount: 1000 });
  });

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.priceAmount, 6000, '例外発生時は行を書き換えない（範囲書き込み前にフィールド名を検証するため）');
});

test('getAllPendingBookings: PENDINGの行のみ抽出する', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({ bookingId: 'SX-1', status: 'PENDING' }));
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({ bookingId: 'SX-2', status: 'CONFIRMED' }));
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({ bookingId: 'SX-3', status: 'PENDING' }));

  var pending = sandbox.SpreadsheetRepository.getAllPendingBookings();
  /* pendingはvmサンドボックス（別realm）内で生成された配列のため、非strict deepEqualで比較する
     （test/booking-config.test.jsと同じ理由）。 */
  var ids = [];
  pending.forEach(function (item) { ids.push(item.record.bookingId); });
  assert.deepEqual(ids.sort(), ['SX-1', 'SX-3']);
});

/*
 * getConfirmedBookingsForDate（Issue #349）: record.dateがSheets由来のDate値の場合に
 * 文字列dateStringとの`===`比較が型の違いだけで常に不一致になり、CONFIRMED予約が
 * 0件と誤検知されていた不具合（前日リマインド未送信）の回帰テスト。
 */
test('getConfirmedBookingsForDate: Date型の利用日を持つCONFIRMED予約をtimezone基準で正規化して取得する（2件）', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(
    sampleRecord({ bookingId: 'DATE-1', status: 'CONFIRMED', date: new Date('2026-09-26T00:00:00+09:00') })
  );
  sandbox.SpreadsheetRepository.appendBooking(
    sampleRecord({ bookingId: 'DATE-2', status: 'CONFIRMED', date: new Date('2026-09-26T10:00:00+09:00') })
  );

  var result = sandbox.SpreadsheetRepository.getConfirmedBookingsForDate('2026-09-26');
  var ids = [];
  result.forEach(function (item) { ids.push(item.record.bookingId); });
  assert.deepEqual(ids.sort(), ['DATE-1', 'DATE-2']);
});

test('getConfirmedBookingsForDate: 文字列型（yyyy-MM-dd）の利用日も引き続き取得できる', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({ bookingId: 'STRING-DATE', status: 'CONFIRMED', date: '2026-09-26' }));

  var result = sandbox.SpreadsheetRepository.getConfirmedBookingsForDate('2026-09-26');
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].record.bookingId, 'STRING-DATE');
});

test('getConfirmedBookingsForDate: 別日・未確定（CONFIRMED以外）・無効な日付・空欄は対象外', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(
    sampleRecord({ bookingId: 'OTHER-DATE', status: 'CONFIRMED', date: new Date('2026-09-27T00:00:00+09:00') })
  );
  sandbox.SpreadsheetRepository.appendBooking(
    sampleRecord({ bookingId: 'NOT-CONFIRMED', status: 'PENDING', date: new Date('2026-09-26T00:00:00+09:00') })
  );
  sandbox.SpreadsheetRepository.appendBooking(
    sampleRecord({ bookingId: 'INVALID-DATE', status: 'CONFIRMED', date: new Date('invalid-date') })
  );
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({ bookingId: 'EMPTY-DATE', status: 'CONFIRMED', date: '' }));

  var result = sandbox.SpreadsheetRepository.getConfirmedBookingsForDate('2026-09-26');
  assert.strictEqual(result.length, 0);
});

test('getConfirmedBookingsForDate: 日本時間の日付境界をUTC基準ではなくJST基準で判定する', function () {
  var sandbox = loadRepos();
  /* 2026-09-25T15:30:00Z はJST（+09:00）では2026-09-26T00:30:00。UTC日付のまま比較すると
     2026-09-25と誤判定してしまうため、JST基準で2026-09-26として取得できることを確認する。 */
  sandbox.SpreadsheetRepository.appendBooking(
    sampleRecord({ bookingId: 'JST-BOUNDARY', status: 'CONFIRMED', date: new Date('2026-09-25T15:30:00Z') })
  );

  var matchingNextDay = sandbox.SpreadsheetRepository.getConfirmedBookingsForDate('2026-09-26');
  assert.strictEqual(matchingNextDay.length, 1);
  assert.strictEqual(matchingNextDay[0].record.bookingId, 'JST-BOUNDARY');

  var matchingUtcDate = sandbox.SpreadsheetRepository.getConfirmedBookingsForDate('2026-09-25');
  assert.strictEqual(matchingUtcDate.length, 0, 'UTC日付ではなくJST日付で一致するべき');
});

test('RecoveryRepository.recordFailure: Recoveryシートへ部分失敗を記録できる', function () {
  var sandbox = loadRepos();
  sandbox.RecoveryRepository.recordFailure({
    bookingId: 'SX-20261001-AAAAAAAA',
    failureType: 'SHEETS_FAILURE_CALENDAR_ORPHANED',
    occurredAt: new Date('2026-10-01T09:00:00+09:00'),
    calendarEventId: 'event-1',
    status: 'NEEDS_MANUAL_RECOVERY',
    errorMessage: 'sheets write failed',
    recoveryState: 'OPEN',
    resolvedAt: ''
  });

  var all = sandbox.RecoveryRepository.listAll();
  assert.strictEqual(all.length, 1);
  assert.strictEqual(all[0].bookingId, 'SX-20261001-AAAAAAAA');
  assert.strictEqual(all[0].failureType, 'SHEETS_FAILURE_CALENDAR_ORPHANED');
});

/*
 * hasOpenBaselineRecovery/resolveBaselineRecovery（PR #345再レビュー対応・8回目。
 * BookingReschedule.backfillOriginalPriceが基準料金5列の書込み結果を確認できなかった
 * 場合の、予約別の永続的な停止条件）。
 */
test('hasOpenBaselineRecovery: BASELINE_WRITE_UNCERTAINかつOPENの行があればtrue、他の予約・他のfailureType・RESOLVEDは対象外', function () {
  var sandbox = loadRepos();
  assert.strictEqual(sandbox.RecoveryRepository.hasOpenBaselineRecovery('SX-1'), false);

  sandbox.RecoveryRepository.recordFailure({
    bookingId: 'SX-1', failureType: sandbox.RecoveryRepository.BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE,
    occurredAt: new Date(), calendarEventId: '', status: 'CONFIRMED',
    errorMessage: 'uncertain', recoveryState: 'OPEN', resolvedAt: ''
  });
  assert.strictEqual(sandbox.RecoveryRepository.hasOpenBaselineRecovery('SX-1'), true);
  assert.strictEqual(sandbox.RecoveryRepository.hasOpenBaselineRecovery('SX-2'), false, '別の予約は無関係');

  sandbox.RecoveryRepository.recordFailure({
    bookingId: 'SX-3', failureType: 'ADMIN_NOTIFICATION_FAILED',
    occurredAt: new Date(), calendarEventId: '', status: 'CONFIRMED',
    errorMessage: 'x', recoveryState: 'OPEN', resolvedAt: ''
  });
  assert.strictEqual(sandbox.RecoveryRepository.hasOpenBaselineRecovery('SX-3'), false, '別のfailureTypeは対象外');
});

test('resolveBaselineRecovery: この予約のOPENなBASELINE_WRITE_UNCERTAIN行だけをRESOLVEDにし、他の予約・他のfailureTypeには触れない', function () {
  var sandbox = loadRepos();
  sandbox.RecoveryRepository.recordFailure({
    bookingId: 'SX-1', failureType: sandbox.RecoveryRepository.BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE,
    occurredAt: new Date(), calendarEventId: '', status: 'CONFIRMED',
    errorMessage: 'uncertain 1', recoveryState: 'OPEN', resolvedAt: ''
  });
  sandbox.RecoveryRepository.recordFailure({
    bookingId: 'SX-1', failureType: sandbox.RecoveryRepository.BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE,
    occurredAt: new Date(), calendarEventId: '', status: 'CONFIRMED',
    errorMessage: 'uncertain 2（複合障害で2回目が起きたケース）', recoveryState: 'OPEN', resolvedAt: ''
  });
  sandbox.RecoveryRepository.recordFailure({
    bookingId: 'SX-2', failureType: sandbox.RecoveryRepository.BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE,
    occurredAt: new Date(), calendarEventId: '', status: 'CONFIRMED',
    errorMessage: '別予約', recoveryState: 'OPEN', resolvedAt: ''
  });
  sandbox.RecoveryRepository.recordFailure({
    bookingId: 'SX-1', failureType: 'ADMIN_NOTIFICATION_FAILED',
    occurredAt: new Date(), calendarEventId: '', status: 'CONFIRMED',
    errorMessage: '別種別', recoveryState: 'OPEN', resolvedAt: ''
  });

  sandbox.RecoveryRepository.resolveBaselineRecovery('SX-1');

  assert.strictEqual(sandbox.RecoveryRepository.hasOpenBaselineRecovery('SX-1'), false, 'SX-1のBASELINE_WRITE_UNCERTAINは全てRESOLVEDになる');
  assert.strictEqual(sandbox.RecoveryRepository.hasOpenBaselineRecovery('SX-2'), true, '別の予約のOPENは影響を受けない');

  var all = sandbox.RecoveryRepository.listAll();
  var sx1Baseline = all.filter(function (r) { return r.bookingId === 'SX-1' && r.failureType === sandbox.RecoveryRepository.BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE; });
  assert.strictEqual(sx1Baseline.length, 2);
  sx1Baseline.forEach(function (r) {
    assert.strictEqual(r.recoveryState, 'RESOLVED');
    assert.ok(r.resolvedAt);
  });
  var sx1Other = all.filter(function (r) { return r.bookingId === 'SX-1' && r.failureType === 'ADMIN_NOTIFICATION_FAILED'; });
  assert.strictEqual(sx1Other.length, 1);
  assert.strictEqual(sx1Other[0].recoveryState, 'OPEN', '別のfailureTypeは解消しない');
});

test('BookingsシートとRecoveryシートは独立している（同じSpreadsheet内の別シート）', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());
  sandbox.RecoveryRepository.recordFailure({
    bookingId: 'SX-20261001-AAAAAAAA',
    failureType: 'ADMIN_NOTIFICATION_FAILED',
    occurredAt: new Date(),
    calendarEventId: 'event-1',
    status: 'PENDING',
    errorMessage: 'mail failed',
    recoveryState: 'INFO',
    resolvedAt: ''
  });

  assert.strictEqual(sandbox.SpreadsheetRepository.getAllPendingBookings().length, 1);
  assert.strictEqual(sandbox.RecoveryRepository.listAll().length, 1);
});

/*
 * updateBookingPaymentStateAtomic（Issue #341 PR-A）: 'paymentAttemptId'〜
 * 'paymentRecoveryReason'の末尾16列だけを1回のsetValuesで更新する。updateBooking
 * CancellationStateAtomic/updateBookingPriceBaselineAtomicと同じ設計で、'paymentStatus'
 * （30列目。この16列とHEADERS_上で連続していない）や間に挟まる決済リンク送信・料金・
 * 日程変更精算関連の既存列は一切書き込まない。
 */
test('updateBookingPaymentStateAtomic: paymentAttemptId〜paymentRecoveryReasonの16列だけを1回の書き込みで更新し、paymentStatusと中間の既存列は変化しない', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord({
    paymentMethod: 'オンラインクレジットカード',
    paymentStatus: 'not_started',
    priceOverrideAmount: 9999,
    stripePaymentLinkUrl: 'https://buy.stripe.com/test_existing'
  }));

  var holdExpiresAt = new Date('2026-10-01T08:30:00+09:00');
  sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic('SX-20261001-AAAAAAAA', {
    paymentAttemptId: 'PAY-SX-20261001-AAAAAAAA-ABC123',
    stripeCheckoutSessionId: 'cs_test_1',
    paymentHoldExpiresAt: holdExpiresAt
  });

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-SX-20261001-AAAAAAAA-ABC123');
  assert.strictEqual(found.record.stripeCheckoutSessionId, 'cs_test_1');
  assert.strictEqual(found.record.paymentHoldExpiresAt.getTime(), holdExpiresAt.getTime());
  assert.strictEqual(found.record.stripePaymentIntentId, '', '範囲内だが指定していないフィールドは空のまま維持される');
  // 範囲外（'paymentStatus'・その間の決済リンク送信・料金関連の既存列）は変化しない。
  assert.strictEqual(found.record.paymentStatus, 'not_started', 'paymentStatusはこの関数の対象外');
  assert.strictEqual(found.record.priceOverrideAmount, 9999);
  assert.strictEqual(found.record.stripePaymentLinkUrl, 'https://buy.stripe.com/test_existing');

  var sheet = sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  var lastCall = sheet._setValuesCalls[sheet._setValuesCalls.length - 1];
  assert.strictEqual(lastCall.col, sandbox.SpreadsheetRepository.HEADERS.indexOf('paymentAttemptId') + 1);
  assert.strictEqual(lastCall.numCols, 16, 'paymentAttemptId〜paymentRecoveryReasonの16列だけを1回で書く（PR #354レビュー対応・2回目でstripeCheckoutRequestSnapshotを追加）');
  assert.strictEqual(lastCall.numRows, 1);
});

test('updateBookingPaymentStateAtomic: 指定しなかった列は既存値のまま維持される', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());
  sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic('SX-20261001-AAAAAAAA', {
    paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1'
  });

  sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic('SX-20261001-AAAAAAAA', {
    stripePaymentIntentId: 'pi_1'
  });

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-1', '前回書き込んだ値が維持される');
  assert.strictEqual(found.record.stripeCheckoutSessionId, 'cs_1');
  assert.strictEqual(found.record.stripePaymentIntentId, 'pi_1');
});

test('updateBookingPaymentStateAtomic: 存在しないbookingIdは例外を投げる（書き込み自体を行わない）', function () {
  var sandbox = loadRepos();
  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic('NOT-EXIST', { paymentAttemptId: 'PAY-1' });
  });
});

test('updateBookingPaymentStateAtomic: 許可されていないフィールド（paymentStatus等）は例外を投げ、行自体を書き換えない', function () {
  var sandbox = loadRepos();
  sandbox.SpreadsheetRepository.appendBooking(sampleRecord());

  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic('SX-20261001-AAAAAAAA', { paymentStatus: 'paid' });
  });
  assert.throws(function () {
    sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic('SX-20261001-AAAAAAAA', { accessApprovedAt: new Date() });
  }, '鍵承認(accessApprovedAt)はこのatomic更新の対象外（Issue #341本文「鍵承認は予約確定とは独立させる」）');

  var found = sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.paymentAttemptId, '', '例外発生時は行を書き換えない（範囲書き込み前にフィールド名を検証するため）');
});
