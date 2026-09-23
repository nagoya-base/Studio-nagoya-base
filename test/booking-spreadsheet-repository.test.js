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
  return loadBookingSandbox(['Config.gs', 'SpreadsheetRepository.gs', 'RecoveryRepository.gs'], {
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
