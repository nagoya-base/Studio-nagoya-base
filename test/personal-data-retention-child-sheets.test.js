/*
 * Bookings台帳と予約IDで結び付く子シート（FeeSettlements / BookingChanges / Recovery）の個人情報の
 * 180日経過後消去（Issue #680 PR-2。admin/PersonalDataRetention.gs）のテスト。Sheets・Lock・Propertiesは
 * すべてスタブで、本番へは一切アクセスしない。実際に配布するBooking Adminのファイルセットだけをvmへ読み込む。
 *
 * - 対象列: FeeSettlements.note / BookingChanges.reason・feeNote・mailError・refundPendingReason と
 *   feeDetailsJsonの限定投影 / Recovery.errorMessage。ID・状態・金額・日時は残す
 * - 起算点: 親Bookingsの起算日時と自身の終端日時の遅い方
 * - 消さない条件: 自身が未完了・親が未終了／保留中／依存が未解決・紐付けなし／曖昧／終端日時の欠落
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');

var DAY = 24 * 60 * 60 * 1000;
var RETENTION = 180 * DAY;
var NOW = new Date('2026-12-10T12:00:00+09:00');
var SPREADSHEET_ID = 'ss1';

var NOTE = '精算メモの自由記述（個人名が入り得る）';

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function ago(ms) { return new Date(NOW.getTime() - ms); }

var SETTLEMENT_HEADERS = ['settlementId', 'bookingId', 'changeId', 'settlementState', 'paidDelta', 'refundedDelta', 'note', 'requestedAt', 'applyStatus', 'appliedAt', 'resultPaidAmount', 'resultRefundedAmount'];
var CHANGE_HEADERS = ['changeId', 'bookingId', 'changedAt', 'oldDate', 'oldStartAt', 'oldEndAt', 'newDate', 'newStartAt', 'newEndAt', 'reason', 'feeNote', 'mailState', 'mailAt', 'mailError', 'oldFeeAmount', 'newFeeAmount', 'feeDifference', 'cancellationPolicyCategory', 'refundStatus', 'refundCandidateAmount', 'refundApprovedAmount', 'refundApprovedAt', 'refundPendingReason', 'settlementStateAtChange', 'feeDetailsJson'];
var RECOVERY_HEADERS = ['bookingId', 'failureType', 'occurredAt', 'calendarEventId', 'status', 'errorMessage', 'recoveryState', 'resolvedAt'];

var DETAILS_FULL = JSON.stringify({
  priceTier: 'MEMBER', brand: 'snb', dayType: 'WEEKDAY', roundedMinutes: 180, manual: true,
  manualNote: '手入力メモ', pendingReason: '理由メモ', feeConfirmed: true, extra: 'unknown'
});
var DETAILS_PROJECTED = JSON.stringify({ priceTier: 'MEMBER', brand: 'snb', dayType: 'WEEKDAY', roundedMinutes: 180, manual: true, feeConfirmed: true });

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var propertiesService = stubs.createPropertiesServiceStub({ CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID });
  var logger = stubs.createLoggerStub();
  var globals = {
    PropertiesService: propertiesService,
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: stubs.createMailAppStub(),
    ScriptApp: stubs.createScriptAppStub(),
    Logger: logger
  };
  var sandbox = loadBookingSandbox(manifest.BOOKING_ADMIN_FILES, globals);
  var book = sandbox.SpreadsheetApp.openById(SPREADSHEET_ID);
  var bookings = book.insertSheet('Bookings');
  bookings.appendRow(sandbox.BookingsSchema.HEADERS.slice());
  return {
    sandbox: sandbox, book: book, bookings: bookings, sheets: spreadsheetsById[SPREADSHEET_ID],
    store: propertiesService._store, logger: logger, headers: sandbox.BookingsSchema.HEADERS.slice(), children: {}
  };
}

var seq = 0;
function addBooking(ctx, overrides) {
  seq += 1;
  var base = Object.assign({
    bookingId: 'snb-20250101-' + ('0000' + seq).slice(-4) + 'abcd', status: 'CONFIRMED', endAt: ago(RETENTION + 30 * DAY),
    name: 'テスト太郎', email: 'pii-test@example.com', phone: '090-0000-0000'
  }, overrides || {});
  ctx.bookings.appendRow(ctx.headers.map(function (h) { return base[h] === undefined ? '' : base[h]; }));
  return base.bookingId;
}

function childSheet(ctx, name, headers) {
  if (!ctx.children[name]) {
    ctx.children[name] = ctx.book.insertSheet(name);
    ctx.children[name].appendRow(headers);
  }
  return ctx.children[name];
}

function appendRow(ctx, name, headers, values) {
  var sheet = childSheet(ctx, name, headers);
  sheet.appendRow(headers.map(function (h) { return values[h] === undefined ? '' : values[h]; }));
  return sheet;
}

var settleSeq = 0;
function addSettlement(ctx, bookingId, overrides) {
  settleSeq += 1;
  var values = Object.assign({
    settlementId: 'S-' + settleSeq, bookingId: bookingId, changeId: 'C-x', settlementState: 'SETTLED', paidDelta: 1000, refundedDelta: 0,
    note: NOTE, requestedAt: ago(RETENTION + 20 * DAY), applyStatus: 'APPLIED', appliedAt: ago(RETENTION + 20 * DAY), resultPaidAmount: 7000, resultRefundedAmount: 0
  }, overrides || {});
  appendRow(ctx, 'FeeSettlements', SETTLEMENT_HEADERS, values);
  return values.settlementId;
}

var changeSeq = 0;
function addChange(ctx, bookingId, overrides) {
  changeSeq += 1;
  var values = Object.assign({
    changeId: 'CH-' + changeSeq, bookingId: bookingId, changedAt: ago(RETENTION + 20 * DAY), reason: '変更理由の自由記述', feeNote: '料金メモ',
    mailState: 'SENT', mailAt: ago(RETENTION + 19 * DAY), mailError: 'エラー文', oldFeeAmount: 6000, newFeeAmount: 7000, feeDifference: 1000,
    refundStatus: 'NONE', refundPendingReason: '保留理由メモ', feeDetailsJson: DETAILS_FULL
  }, overrides || {});
  appendRow(ctx, 'BookingChanges', CHANGE_HEADERS, values);
  return values.changeId;
}

var recSeq = 0;
function addRecovery(ctx, bookingId, overrides) {
  recSeq += 1;
  var values = Object.assign({
    bookingId: bookingId, failureType: 'TYPE_' + recSeq, occurredAt: ago(RETENTION + 20 * DAY), calendarEventId: 'evt-' + recSeq, status: 'CONFIRMED',
    errorMessage: 'エラーメッセージ（個人情報が入り得る）', recoveryState: 'RESOLVED', resolvedAt: ago(RETENTION + 19 * DAY)
  }, overrides || {});
  appendRow(ctx, 'Recovery', RECOVERY_HEADERS, values);
  return values;
}

function colOf(headers, name) { return headers.indexOf(name); }
function rowByKey(sheet, headers, keyColumn, key) {
  var index = colOf(headers, keyColumn);
  for (var i = 1; i < sheet._rows.length; i++) if (sheet._rows[i][index] === key) return sheet._rows[i];
  throw new Error('row not found: ' + key);
}
function cellOf(sheet, headers, keyColumn, key, column) {
  return rowByKey(sheet, headers, keyColumn, key)[colOf(headers, column)];
}

function enable(ctx) {
  ctx.sandbox.dryRunPersonalDataRetention(NOW);
  ctx.sandbox.enablePersonalDataRetention();
}

function run(ctx, now, options) {
  return plain(ctx.sandbox.purgeExpiredPersonalData(now || NOW, options));
}

// ============================================================================
// FeeSettlements
// ============================================================================

test('FeeSettlements: 終端の精算のnoteだけを消し、ID・金額・状態・日時は残す', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var applied = addSettlement(ctx, bookingId);
  var abandoned = addSettlement(ctx, bookingId, { applyStatus: 'ABANDONED', resultPaidAmount: '', resultRefundedAmount: '' });
  var sheet = ctx.children.FeeSettlements;
  var before = sheet._rows.map(function (r) { return r.slice(); });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.status, 'OK');
  assert.strictEqual(result.children.FeeSettlements.erasedRows, 2);
  assert.strictEqual(result.children.FeeSettlements.cellsCleared, 2);
  var noteIndex = colOf(SETTLEMENT_HEADERS, 'note');
  [applied, abandoned].forEach(function (id) { assert.strictEqual(cellOf(sheet, SETTLEMENT_HEADERS, 'settlementId', id, 'note'), ''); });
  sheet._rows.forEach(function (row, r) {
    row.forEach(function (value, c) {
      if (r > 0 && c === noteIndex) return;
      assert.strictEqual(String(value), String(before[r][c]), '列' + SETTLEMENT_HEADERS[c] + 'が変更されている');
    });
  });
});

test('FeeSettlements: 未完了・状態不明・終端日時の欠落・紐付けなしは消さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var pending = addSettlement(ctx, bookingId, { applyStatus: 'PENDING_APPLY', appliedAt: '' });
  var failed = addSettlement(ctx, bookingId, { applyStatus: 'FAILED_NEEDS_RECOVERY', appliedAt: '' });
  var unknown = addSettlement(ctx, bookingId, { applyStatus: 'WEIRD' });
  var noDate = addSettlement(ctx, bookingId, { appliedAt: '' });
  var badDate = addSettlement(ctx, bookingId, { appliedAt: '2026-02-30T00:00:00Z' });
  var noLink = addSettlement(ctx, '');
  var orphan = addSettlement(ctx, 'snb-not-exists');
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.FeeSettlements;
  assert.strictEqual(counts.erasedRows, 0);
  assert.deepStrictEqual(counts.held, { SETTLEMENT_UNRESOLVED: 2 });
  [pending, failed, unknown, noDate, badDate, noLink, orphan].forEach(function (id) {
    assert.strictEqual(cellOf(ctx.children.FeeSettlements, SETTLEMENT_HEADERS, 'settlementId', id, 'note'), NOTE, id);
  });
  assert.deepStrictEqual(counts.review, { APPLY_STATUS_UNKNOWN: 1, OWN_DATE_INVALID: 2, NO_BOOKING_LINK: 1, PARENT_NOT_FOUND: 1 });
});

test('FeeSettlements: 親の起算点と自身の終端日時の遅い方から180日（自身が新しければ親が古くても待つ）', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx, { endAt: ago(RETENTION + 100 * DAY) });
  var recent = addSettlement(ctx, bookingId, { appliedAt: ago(10 * DAY) });
  var boundary = addSettlement(ctx, bookingId, { appliedAt: ago(RETENTION) });
  var justBefore = addSettlement(ctx, bookingId, { appliedAt: new Date(NOW.getTime() - RETENTION + 1) });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.FeeSettlements.erasedRows, 1);
  assert.strictEqual(result.children.FeeSettlements.notDue, 2);
  var sheet = ctx.children.FeeSettlements;
  assert.strictEqual(cellOf(sheet, SETTLEMENT_HEADERS, 'settlementId', boundary, 'note'), '');
  assert.strictEqual(cellOf(sheet, SETTLEMENT_HEADERS, 'settlementId', recent, 'note'), NOTE);
  assert.strictEqual(cellOf(sheet, SETTLEMENT_HEADERS, 'settlementId', justBefore, 'note'), NOTE);
});

// ============================================================================
// BookingChanges
// ============================================================================

test('BookingChanges: 自由記述4列を消し、feeDetailsJsonは構造化された項目だけに投影する', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var id = addChange(ctx, bookingId);
  var sheet = ctx.children.BookingChanges;
  var before = rowByKey(sheet, CHANGE_HEADERS, 'changeId', id).slice();
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.BookingChanges.erasedRows, 1);
  assert.strictEqual(result.children.BookingChanges.cellsCleared, 5);
  var after = rowByKey(sheet, CHANGE_HEADERS, 'changeId', id);
  ['reason', 'feeNote', 'mailError', 'refundPendingReason'].forEach(function (column) {
    assert.strictEqual(after[colOf(CHANGE_HEADERS, column)], '', column);
  });
  assert.strictEqual(after[colOf(CHANGE_HEADERS, 'feeDetailsJson')], DETAILS_PROJECTED);
  var kept = JSON.parse(after[colOf(CHANGE_HEADERS, 'feeDetailsJson')]);
  assert.strictEqual(kept.manualNote, undefined);
  assert.strictEqual(kept.pendingReason, undefined);
  assert.strictEqual(kept.extra, undefined);
  CHANGE_HEADERS.forEach(function (column, c) {
    if (['reason', 'feeNote', 'mailError', 'refundPendingReason', 'feeDetailsJson'].indexOf(column) !== -1) return;
    assert.strictEqual(String(after[c]), String(before[c]), column + 'が変更されている');
  });
});

test('BookingChanges: 投影は冪等で、2回目は何も書かない。値の形が不正なキーは落とす', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var weird = JSON.stringify({ priceTier: 'VIP', brand: 'a b c', dayType: 'lower', roundedMinutes: 'x', manual: 'yes', feeConfirmed: false });
  var id = addChange(ctx, bookingId, { reason: '', feeNote: '', mailError: '', refundPendingReason: '', feeDetailsJson: weird });
  enable(ctx);
  assert.strictEqual(run(ctx).children.BookingChanges.erasedRows, 1);
  assert.strictEqual(cellOf(ctx.children.BookingChanges, CHANGE_HEADERS, 'changeId', id, 'feeDetailsJson'), JSON.stringify({ feeConfirmed: false }));
  var second = run(ctx);
  assert.strictEqual(second.children.BookingChanges.erasedRows, 0);
  assert.strictEqual(second.children.BookingChanges.alreadyClear, 1);
});

test('BookingChanges: 解析できないfeeDetailsJsonは触らず要確認、空欄は問題なし', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var broken = addChange(ctx, bookingId, { feeDetailsJson: '{not json' });
  var array = addChange(ctx, bookingId, { feeDetailsJson: '[1,2]' });
  var empty = addChange(ctx, bookingId, { feeDetailsJson: '' });
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.BookingChanges.review, { FEE_DETAILS_UNPARSEABLE: 2 });
  assert.strictEqual(result.children.BookingChanges.erasedRows, 1);
  var sheet = ctx.children.BookingChanges;
  assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', broken, 'feeDetailsJson'), '{not json');
  assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', broken, 'reason'), '変更理由の自由記述');
  assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', array, 'feeDetailsJson'), '[1,2]');
  assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', empty, 'reason'), '');
});

test('BookingChanges: 確定前・要復旧・状態不明・日時不正は消さず、終端（SENT/ROLLED_BACK/CHANGE_FAILED）は消す', function () {
  var ctx = setup();
  var clean = addBooking(ctx);
  var withOpen = addBooking(ctx);
  var terminal = ['SENT', 'ROLLED_BACK', 'CHANGE_FAILED'].map(function (state) { return addChange(ctx, clean, { mailState: state }); });
  var prepared = addChange(ctx, withOpen, { mailState: 'PREPARED' });
  var recovery = addChange(ctx, withOpen, { mailState: 'RECOVERY_REQUIRED' });
  var unknown = addChange(ctx, clean, { mailState: 'WEIRD' });
  var badChangedAt = addChange(ctx, clean, { changedAt: 'broken' });
  var badMailAt = addChange(ctx, clean, { mailAt: '2026-04-31T00:00:00Z' });
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.BookingChanges;
  assert.strictEqual(counts.erasedRows, 3);
  assert.deepStrictEqual(counts.review, { MAIL_STATE_UNKNOWN: 1, OWN_DATE_INVALID: 2 });
  assert.deepStrictEqual(counts.held, { RESCHEDULE_UNRESOLVED: 2 });
  var sheet = ctx.children.BookingChanges;
  terminal.forEach(function (id) { assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', id, 'reason'), ''); });
  [prepared, recovery, unknown, badChangedAt, badMailAt].forEach(function (id) {
    assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', id, 'reason'), '変更理由の自由記述', id);
  });
});

test('BookingChanges: 同じ予約に未完了の変更があれば、終端の変更の記録も消さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var done = addChange(ctx, bookingId, { mailState: 'SENT' });
  addChange(ctx, bookingId, { mailState: 'PREPARED' });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.BookingChanges.erasedRows, 0);
  assert.deepStrictEqual(result.children.BookingChanges.held, { RELATED_RESCHEDULE_UNRESOLVED: 1, RESCHEDULE_UNRESOLVED: 1 });
  assert.strictEqual(cellOf(ctx.children.BookingChanges, CHANGE_HEADERS, 'changeId', done, 'reason'), '変更理由の自由記述');
});

test('BookingChanges: 起算点はchangedAt・mailAt・refundApprovedAtの最も遅い日時', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx, { endAt: ago(RETENTION + 100 * DAY) });
  var byMail = addChange(ctx, bookingId, { changedAt: ago(RETENTION + 50 * DAY), mailAt: ago(10 * DAY) });
  var byRefund = addChange(ctx, bookingId, { changedAt: ago(RETENTION + 50 * DAY), mailAt: ago(RETENTION + 49 * DAY), refundApprovedAt: ago(5 * DAY) });
  var old = addChange(ctx, bookingId, { changedAt: ago(RETENTION + 50 * DAY), mailAt: ago(RETENTION + 49 * DAY) });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.BookingChanges.erasedRows, 1);
  assert.strictEqual(result.children.BookingChanges.notDue, 2);
  var sheet = ctx.children.BookingChanges;
  assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', old, 'reason'), '');
  assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', byMail, 'reason'), '変更理由の自由記述');
  assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', byRefund, 'reason'), '変更理由の自由記述');
});

// ============================================================================
// Recovery
// ============================================================================

test('Recovery: 解決済みのerrorMessageだけを消し、予約ID・種別・日時・CalendarイベントID・状態は残す', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var values = addRecovery(ctx, bookingId);
  var sheet = ctx.children.Recovery;
  var before = sheet._rows[1].slice();
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.Recovery.erasedRows, 1);
  var after = sheet._rows[1];
  RECOVERY_HEADERS.forEach(function (column, c) {
    if (column === 'errorMessage') assert.strictEqual(after[c], '');
    else assert.strictEqual(String(after[c]), String(before[c]), column);
  });
  assert.strictEqual(values.calendarEventId, after[colOf(RECOVERY_HEADERS, 'calendarEventId')]);
});

test('Recovery: OPEN・状態不明は消さず、RESOLVEDでも解決日時が空欄・不正なら要確認', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  addRecovery(ctx, bookingId, { recoveryState: 'OPEN', resolvedAt: '' });
  addRecovery(ctx, bookingId, { recoveryState: '', resolvedAt: '' });
  addRecovery(ctx, bookingId, { resolvedAt: '' });
  addRecovery(ctx, bookingId, { resolvedAt: '2025-02-29T00:00:00Z' });
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.Recovery;
  assert.strictEqual(counts.erasedRows, 0);
  assert.deepStrictEqual(counts.review, { OWN_DATE_MISSING: 1, OWN_DATE_INVALID: 1 });
  ctx.children.Recovery._rows.slice(1).forEach(function (row) {
    assert.notStrictEqual(row[colOf(RECOVERY_HEADERS, 'errorMessage')], '');
  });
});

test('Recovery: 予約と結び付かない・予約が見つからない・識別できない行は消さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  addRecovery(ctx, '');
  addRecovery(ctx, 'snb-never-saved');
  addRecovery(ctx, bookingId, { failureType: '', occurredAt: '' });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.Recovery.erasedRows, 0);
  assert.deepStrictEqual(result.children.Recovery.review, { NO_BOOKING_LINK: 1, PARENT_NOT_FOUND: 1, INVALID_KEY: 1 });
});

test('Recovery: 識別子の組が重複する行は全て要確認', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var first = addRecovery(ctx, bookingId, { failureType: 'DUP', calendarEventId: 'e1' });
  addRecovery(ctx, bookingId, { failureType: 'DUP', calendarEventId: 'e1', occurredAt: first.occurredAt });
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.Recovery.review, { DUPLICATE_KEY: 2 });
  assert.strictEqual(result.children.Recovery.erasedRows, 0);
});

test('Recovery: 同じ予約に未解決のRecoveryが1件でもあれば、解決済みの行も消さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var otherBooking = addBooking(ctx);
  addRecovery(ctx, bookingId);
  addRecovery(ctx, bookingId, { recoveryState: 'OPEN', resolvedAt: '' });
  addRecovery(ctx, otherBooking);
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.Recovery.erasedRows, 1);
  assert.deepStrictEqual(result.children.Recovery.held, { RELATED_RECOVERY_OPEN: 1, RECOVERY_OPEN: 1 });
  assert.notStrictEqual(ctx.children.Recovery._rows[1][colOf(RECOVERY_HEADERS, 'errorMessage')], '');
  assert.strictEqual(ctx.children.Recovery._rows[3][colOf(RECOVERY_HEADERS, 'errorMessage')], '');
});

// ============================================================================
// 親の状態・保留・依存
// ============================================================================

test('親が未終了（PENDING）・状態不明・起算日時不正なら子の記録は消さない', function () {
  var ctx = setup();
  var pending = addBooking(ctx, { status: 'PENDING' });
  var unknown = addBooking(ctx, { status: 'DONE' });
  var broken = addBooking(ctx, { endAt: 'broken' });
  [pending, unknown, broken].forEach(function (id) { addSettlement(ctx, id); });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.FeeSettlements.erasedRows, 0);
  assert.deepStrictEqual(result.children.FeeSettlements.held, { PARENT_NOT_ENDED: 1 });
  assert.deepStrictEqual(result.children.FeeSettlements.review, { PARENT_STATUS_UNKNOWN: 1, PARENT_BASIS_INVALID: 1 });
});

test('親がCANCELLED/EXPIREDなら、それぞれcancelledAt/expiredAtを起算点にする', function () {
  var ctx = setup();
  var cancelled = addBooking(ctx, { status: 'CANCELLED', endAt: ago(RETENTION + 90 * DAY), cancelledAt: ago(10 * DAY) });
  var expired = addBooking(ctx, { status: 'EXPIRED', endAt: ago(10 * DAY), expiredAt: ago(RETENTION + 90 * DAY) });
  var s1 = addSettlement(ctx, cancelled);
  var s2 = addSettlement(ctx, expired);
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.FeeSettlements.erasedRows, 1);
  var sheet = ctx.children.FeeSettlements;
  assert.strictEqual(cellOf(sheet, SETTLEMENT_HEADERS, 'settlementId', s1, 'note'), NOTE);
  assert.strictEqual(cellOf(sheet, SETTLEMENT_HEADERS, 'settlementId', s2, 'note'), '');
});

test('親に未解決の決済・精算・返金があれば、子の記録も消さない', function () {
  var ctx = setup();
  var unpaid = addBooking(ctx, { paymentStatus: 'checkout_pending' });
  var charge = addBooking(ctx, { feeSettlementState: 'PENDING_CHARGE' });
  var refund = addBooking(ctx, { refundAttemptState: 'UNKNOWN' });
  [unpaid, charge, refund].forEach(function (id) { addRecovery(ctx, id); addChange(ctx, id); });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.Recovery.erasedRows, 0);
  assert.strictEqual(result.children.BookingChanges.erasedRows, 0);
  assert.deepStrictEqual(result.children.Recovery.held, { PAYMENT_UNRESOLVED: 1, FEE_SETTLEMENT_PENDING: 1, REFUND_UNRESOLVED: 1 });
});

test('有効な保留は子の記録も止め、解決後は解決日時から180日まで消さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  addSettlement(ctx, bookingId);
  ctx.sandbox.addPersonalDataRetentionHold(bookingId, 'DISPUTE', '運営A', '2027-01-31T00:00:00+09:00', NOW);
  enable(ctx);
  var held = run(ctx);
  assert.strictEqual(held.children.FeeSettlements.erasedRows, 0);
  assert.deepStrictEqual(held.children.FeeSettlements.held, { HOLD_ACTIVE: 1 });

  ctx.sandbox.resolvePersonalDataRetentionHold(bookingId, NOW);
  assert.strictEqual(run(ctx, new Date(NOW.getTime() + 179 * DAY)).children.FeeSettlements.erasedRows, 0);
  assert.strictEqual(run(ctx, new Date(NOW.getTime() + 180 * DAY)).children.FeeSettlements.erasedRows, 1);
});

// ============================================================================
// 実行の共通動作
// ============================================================================

test('全シート合計でmaxRowsまでを処理し、Bookings→子シートの順に次回へ持ち越す', function () {
  var ctx = setup();
  var b1 = addBooking(ctx);
  var b2 = addBooking(ctx);
  addSettlement(ctx, b1);
  addSettlement(ctx, b2);
  addRecovery(ctx, b1);
  enable(ctx);
  var first = run(ctx, NOW, { maxRows: 3 });
  assert.strictEqual(first.status, 'TRUNCATED');
  assert.strictEqual(first.erasedRows, 2);
  assert.strictEqual(first.children.FeeSettlements.erasedRows, 1);
  assert.strictEqual(first.children.Recovery.erasedRows, 0);
  var second = run(ctx, NOW, { maxRows: 10 });
  assert.strictEqual(second.status, 'OK');
  assert.strictEqual(second.children.FeeSettlements.erasedRows, 1);
  assert.strictEqual(second.children.Recovery.erasedRows, 1);
  var third = run(ctx);
  assert.strictEqual(third.erasedRows + third.children.FeeSettlements.erasedRows + third.children.Recovery.erasedRows, 0);
});

test('子シートの書き込みもすべて1セルで、対象列以外のセルへは書かない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  addSettlement(ctx, bookingId);
  addChange(ctx, bookingId);
  addRecovery(ctx, bookingId);
  enable(ctx);
  run(ctx);
  var allowed = {
    FeeSettlements: ['note'], BookingChanges: ['reason', 'feeNote', 'mailError', 'refundPendingReason', 'feeDetailsJson'], Recovery: ['errorMessage']
  };
  var headersBySheet = { FeeSettlements: SETTLEMENT_HEADERS, BookingChanges: CHANGE_HEADERS, Recovery: RECOVERY_HEADERS };
  Object.keys(allowed).forEach(function (name) {
    var calls = ctx.children[name]._setValuesCalls;
    assert.ok(calls.length > 0, name);
    calls.forEach(function (call) {
      assert.strictEqual(call.numRows, 1);
      assert.strictEqual(call.numCols, 1);
      assert.ok(allowed[name].indexOf(headersBySheet[name][call.col - 1]) !== -1, name + '.' + headersBySheet[name][call.col - 1]);
    });
  });
});

test('ロック取得後の再判定: 親が保留・未解決になった／子が未完了に戻った場合は書かない', function () {
  var mutate = null;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { if (mutate) { mutate(); mutate = null; } return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  var bookingId = addBooking(ctx);
  var settlementId = addSettlement(ctx, bookingId);
  var changeId = addChange(ctx, bookingId);
  enable(ctx);
  /* Bookings(1行)のバッチが最初のロック。その次の子シートのロックで親を未解決にする。 */
  var calls = 0;
  var original = lockService.getScriptLock;
  lockService.getScriptLock = function () {
    var lock = original();
    var tryLock = lock.tryLock;
    lock.tryLock = function () {
      calls += 1;
      if (calls === 2) {
        ctx.bookings._rows[1][colOf(ctx.headers, 'feeSettlementState')] = 'PENDING_CHARGE';
      }
      return tryLock();
    };
    return lock;
  };
  var result = run(ctx);
  assert.strictEqual(result.children.FeeSettlements.erasedRows, 0);
  assert.strictEqual(result.children.FeeSettlements.recheckSkipped, 1);
  assert.strictEqual(result.children.BookingChanges.recheckSkipped, 1);
  assert.strictEqual(cellOf(ctx.children.FeeSettlements, SETTLEMENT_HEADERS, 'settlementId', settlementId, 'note'), NOTE);
  assert.strictEqual(cellOf(ctx.children.BookingChanges, CHANGE_HEADERS, 'changeId', changeId, 'reason'), '変更理由の自由記述');
});

test('消去中に他プロセスが更新した子シートの非対象列を巻き戻さない', function () {
  var mutate = null;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { if (mutate) { mutate(); mutate = null; } return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  var bookingId = addBooking(ctx, { name: '', email: '', phone: '' });
  var settlementId = addSettlement(ctx, bookingId);
  enable(ctx);
  var sheet = ctx.children.FeeSettlements;
  mutate = function () { sheet._rows[1][colOf(SETTLEMENT_HEADERS, 'resultPaidAmount')] = 9999; };
  run(ctx);
  assert.strictEqual(cellOf(sheet, SETTLEMENT_HEADERS, 'settlementId', settlementId, 'resultPaidAmount'), 9999);
  assert.strictEqual(cellOf(sheet, SETTLEMENT_HEADERS, 'settlementId', settlementId, 'note'), '');
});

test('子シートの書き込み失敗でPARTIAL_FAILURE。次回の実行で完了する', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx, { name: '', email: '', phone: '' });
  addChange(ctx, bookingId);
  enable(ctx);
  var sheet = ctx.children.BookingChanges;
  var original = sheet.getRange;
  var writes = 0;
  sheet.getRange = function () {
    var range = original.apply(sheet, arguments);
    var setValue = range.setValue;
    range.setValue = function (value) {
      writes++;
      if (writes === 2) throw new Error('書き込み失敗');
      return setValue.call(range, value);
    };
    return range;
  };
  assert.throws(function () { ctx.sandbox.purgeExpiredPersonalData(NOW); }, /PARTIAL_FAILURE/);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT, undefined);
  sheet.getRange = original;
  var retry = run(ctx);
  assert.strictEqual(retry.status, 'OK');
  assert.strictEqual(retry.children.BookingChanges.erasedRows, 1);
  assert.strictEqual(cellOf(sheet, CHANGE_HEADERS, 'changeId', 'CH-' + changeSeq, 'reason'), '');
});

// ============================================================================
// dry-run・ヘッダー・状態確認
// ============================================================================

test('dry-runは子シートも無変更で、件数と区分だけを返し個人情報・IDを出さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var settlementId = addSettlement(ctx, bookingId);
  addSettlement(ctx, bookingId, { applyStatus: 'PENDING_APPLY', appliedAt: '' });
  addChange(ctx, bookingId);
  addRecovery(ctx, addBooking(ctx));
  var snapshot = JSON.stringify(Object.keys(ctx.children).map(function (name) { return ctx.children[name]._rows; }));
  var result = plain(ctx.sandbox.dryRunPersonalDataRetention(NOW));
  assert.strictEqual(result.status, 'DRY_RUN');
  assert.strictEqual(result.children.FeeSettlements.scanned, 2);
  assert.strictEqual(result.children.FeeSettlements.eligible, 0);
  assert.deepStrictEqual(result.children.FeeSettlements.held, { RELATED_SETTLEMENT_UNRESOLVED: 1, SETTLEMENT_UNRESOLVED: 1 });
  assert.strictEqual(result.children.Recovery.eligible, 1);
  assert.strictEqual(JSON.stringify(Object.keys(ctx.children).map(function (name) { return ctx.children[name]._rows; })), snapshot);
  Object.keys(ctx.children).forEach(function (name) { assert.strictEqual(ctx.children[name]._setValuesCalls.length, 0); });
  var output = JSON.stringify(result) + ctx.logger._logs.join('\n');
  [NOTE, 'エラーメッセージ', '変更理由', bookingId, settlementId, 'evt-'].forEach(function (secret) {
    assert.strictEqual(output.indexOf(secret), -1, secret);
  });
});

test('子シートの必須列が欠けていれば、Bookingsも含めて何も消さずSHEET_INVALIDで止まる', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var headers = SETTLEMENT_HEADERS.filter(function (h) { return h !== 'appliedAt'; });
  var settlements = ctx.book.insertSheet('FeeSettlements');
  settlements.appendRow(headers);
  settlements.appendRow(headers.map(function (h) { return h === 'bookingId' ? bookingId : h === 'note' ? NOTE : 'x'; }));
  var props = ctx.sandbox.PropertiesService.getScriptProperties();
  props.setProperty('PERSONAL_DATA_RETENTION_ENABLED', 'true');
  props.setProperty('PERSONAL_DATA_RETENTION_POLICY_VERSION', '2026-10-31.4');
  props.setProperty('PERSONAL_DATA_RETENTION_DRY_RUN_VERSION', '2026-10-31.4');
  var result = plain(ctx.sandbox.PersonalDataRetention.run(NOW));
  assert.strictEqual(result.status, 'SHEET_INVALID');
  assert.strictEqual(result.code, 'CHILD_SHEET_INVALID');
  assert.strictEqual(ctx.bookings._rows[1][colOf(ctx.headers, 'name')], 'テスト太郎');
  assert.strictEqual(ctx.bookings._setValuesCalls.length, 0);
  assert.strictEqual(plain(ctx.sandbox.dryRunPersonalDataRetention(NOW)).code, 'CHILD_SHEET_INVALID');
});

test('子シートが存在しなければ記録なしとして扱い、Bookingsだけ処理する', function () {
  var ctx = setup();
  var id = addBooking(ctx);
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.status, 'OK');
  assert.strictEqual(result.erasedRows, 1);
  assert.strictEqual(ctx.bookings._rows[1][0], id);
  assert.strictEqual(result.children.FeeSettlements.scanned, 0);
  assert.strictEqual(ctx.sheets.FeeSettlements, undefined);
});

test('状態確認: 子シートの要確認件数もREVIEW_ROWS_EXISTで知らせる', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx, { name: '', email: '', phone: '' });
  addRecovery(ctx, bookingId, { resolvedAt: '' });
  enable(ctx);
  run(ctx);
  var status = plain(ctx.sandbox.getPersonalDataRetentionStatus(NOW));
  assert.ok(status.attention.indexOf('REVIEW_ROWS_EXIST') !== -1);
  assert.strictEqual(status.codePolicyVersion, '2026-10-31.4');
});

test('方針バージョンが変わると、PR-1時点のdry-run確認では有効化・実行できない', function () {
  var ctx = setup();
  addBooking(ctx);
  ctx.store.PERSONAL_DATA_RETENTION_DRY_RUN_VERSION = '2026-10-31.1';
  assert.throws(function () { ctx.sandbox.enablePersonalDataRetention(); }, /DRY_RUN_REQUIRED/);
  ctx.store.PERSONAL_DATA_RETENTION_ENABLED = 'true';
  ctx.store.PERSONAL_DATA_RETENTION_POLICY_VERSION = '2026-10-31.1';
  assert.strictEqual(run(ctx).status, 'CONFIG_INVALID');
  assert.strictEqual(ctx.bookings._rows[1][colOf(ctx.headers, 'name')], 'テスト太郎');
});
