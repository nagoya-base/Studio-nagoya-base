/*
 * Bookings台帳の個人情報の180日経過後消去（Issue #680 PR-1。admin/PersonalDataRetention.gs）のテスト。
 * Sheets・Lock・Properties・ScriptAppはすべてスタブで、本番へは一切アクセスしない。実際に配布する
 * Booking Adminのファイルセット（BOOKING_ADMIN_FILES）だけをvmへ読み込む。
 *
 * - 判定: 起算点・180日の境界・状態別・厳格な日時・決済／返金／精算の未解決・保留・ヘッダー検証
 * - 初期無効: 未設定・不正値・方針不一致・dry-run未確認では消さず、成功日時も更新しない
 * - dry-run: 何も書かない・個人情報とIDを出さない
 * - 消去: 対象列だけを1セルずつ・他の列と他プロセスの更新を巻き戻さない・冪等・分割・中断・再確認
 * - トリガー補助・保留・状態確認・配布境界
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
var VERSION = '2026-10-31.2';

var PII = {
  name: 'テスト太郎', email: 'pii-test@example.com', phone: '090-0000-0000', purpose: '撮影の相談メモ', note: '備考の自由記述'
};

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function ago(ms) { return new Date(NOW.getTime() - ms); }

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = Object.assign({ CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID }, opts.properties || {});
  var propertiesService = stubs.createPropertiesServiceStub(properties);
  var scriptApp = stubs.createScriptAppStub();
  var logger = stubs.createLoggerStub();
  var globals = {
    PropertiesService: propertiesService,
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: stubs.createMailAppStub(),
    ScriptApp: scriptApp,
    Logger: logger
  };
  var sandbox = loadBookingSandbox(manifest.BOOKING_ADMIN_FILES, globals);
  var book = sandbox.SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = book.insertSheet('Bookings');
  sheet.appendRow(sandbox.BookingsSchema.HEADERS.slice());
  return {
    sandbox: sandbox, sheet: sheet, book: book, sheets: spreadsheetsById[SPREADSHEET_ID],
    store: propertiesService._store, logger: logger, scriptApp: scriptApp, headers: sandbox.BookingsSchema.HEADERS.slice()
  };
}

var seq = 0;
/* overrides: { 列名: 値 }。指定のない列は空欄。bookingIdは自動採番。 */
function rowOf(ctx, overrides) {
  seq += 1;
  var base = Object.assign({
    bookingId: 'snb-20250101-' + ('0000' + seq).slice(-4) + 'abcd', status: 'CONFIRMED', endAt: ago(RETENTION + DAY),
    brand: 'snb', paymentMethod: 'cash', priceAmount: 6000, stripeCurrency: ''
  }, PII, overrides || {});
  return ctx.headers.map(function (header) { return base[header] === undefined ? '' : base[header]; });
}

function addRow(ctx, overrides) {
  var row = rowOf(ctx, overrides);
  ctx.sheet.appendRow(row);
  return row[0];
}

function cell(ctx, bookingId, column) {
  var index = ctx.headers.indexOf(column);
  for (var i = 1; i < ctx.sheet._rows.length; i++) {
    if (ctx.sheet._rows[i][0] === bookingId) return ctx.sheet._rows[i][index];
  }
  throw new Error('row not found');
}

function enable(ctx) {
  ctx.sandbox.dryRunPersonalDataRetention(NOW);
  ctx.sandbox.enablePersonalDataRetention();
}

function recordOf(ctx, overrides) {
  var record = {};
  var row = rowOf(ctx, overrides);
  ctx.headers.forEach(function (header, index) { record[header] = row[index]; });
  return record;
}

function classify(ctx, overrides, holds, nowMs) {
  return plain(ctx.sandbox.PersonalDataRetention.classifyBookingRecord(recordOf(ctx, overrides), {
    nowMs: nowMs === undefined ? NOW.getTime() : nowMs, holdsByBookingId: holds || {}, duplicateIds: {}
  }));
}

// ============================================================================
// 判定: 起算点・境界・状態
// ============================================================================

test('CONFIRMEDは最新のendAtから180×24時間ちょうどで対象、1ミリ秒前は対象外', function () {
  var ctx = setup();
  assert.strictEqual(classify(ctx, { endAt: new Date(NOW.getTime() - RETENTION) }).verdict, 'ELIGIBLE');
  assert.strictEqual(classify(ctx, { endAt: new Date(NOW.getTime() - RETENTION + 1) }).verdict, 'NOT_DUE');
  assert.strictEqual(classify(ctx, { endAt: new Date(NOW.getTime() + DAY) }).verdict, 'NOT_DUE');
});

test('CANCELLEDはcancelledAt、EXPIREDはexpiredAtを起算点にする（endAtでは判定しない）', function () {
  var ctx = setup();
  assert.strictEqual(classify(ctx, { status: 'CANCELLED', endAt: ago(RETENTION + DAY), cancelledAt: ago(10 * DAY) }).verdict, 'NOT_DUE');
  assert.strictEqual(classify(ctx, { status: 'CANCELLED', endAt: ago(DAY), cancelledAt: ago(RETENTION) }).verdict, 'ELIGIBLE');
  assert.strictEqual(classify(ctx, { status: 'EXPIRED', endAt: ago(RETENTION + DAY), expiredAt: ago(10 * DAY) }).verdict, 'NOT_DUE');
  assert.strictEqual(classify(ctx, { status: 'EXPIRED', endAt: ago(DAY), expiredAt: ago(RETENTION + DAY) }).verdict, 'ELIGIBLE');
});

test('復活してCONFIRMEDに戻った予約は、古いexpiredAtではなくendAtで判定する', function () {
  var ctx = setup();
  var outcome = classify(ctx, { status: 'CONFIRMED', endAt: new Date(NOW.getTime() + 5 * DAY), expiredAt: ago(RETENTION + 30 * DAY) });
  assert.strictEqual(outcome.verdict, 'NOT_DUE');
});

test('PENDINGは対象外、未知のstatusは要確認（消さない）', function () {
  var ctx = setup();
  assert.deepStrictEqual(classify(ctx, { status: 'PENDING' }), { verdict: 'PENDING', reason: 'PENDING_STATUS' });
  assert.strictEqual(classify(ctx, { status: 'DONE' }).reason, 'UNKNOWN_STATUS');
  assert.strictEqual(classify(ctx, { status: '' }).reason, 'UNKNOWN_STATUS');
});

test('起算日時が空欄・不正・タイムゾーン不明の文字列・数値のときは要確認で、updatedAt等で代用しない', function () {
  var ctx = setup();
  var old = ago(RETENTION + 30 * DAY);
  assert.strictEqual(classify(ctx, { endAt: '', updatedAt: old, createdAt: old }).reason, 'BASIS_MISSING');
  assert.strictEqual(classify(ctx, { endAt: 'not-a-date', updatedAt: old }).reason, 'BASIS_INVALID');
  assert.strictEqual(classify(ctx, { endAt: '2025-01-01 10:00', updatedAt: old }).reason, 'BASIS_INVALID');
  assert.strictEqual(classify(ctx, { endAt: '2025-01-01T10:00:00', updatedAt: old }).reason, 'BASIS_INVALID');
  assert.strictEqual(classify(ctx, { endAt: 1700000000, updatedAt: old }).reason, 'BASIS_INVALID');
  assert.strictEqual(classify(ctx, { endAt: new Date('invalid'), updatedAt: old }).reason, 'BASIS_INVALID');
  assert.strictEqual(classify(ctx, { status: 'CANCELLED', cancelledAt: '', updatedAt: old }).reason, 'BASIS_MISSING');
});

test('タイムゾーン明示のISO文字列は受け付ける', function () {
  var ctx = setup();
  assert.strictEqual(classify(ctx, { endAt: '2025-01-01T10:00:00+09:00' }).verdict, 'ELIGIBLE');
  assert.strictEqual(classify(ctx, { endAt: '2025-01-01T01:00:00Z' }).verdict, 'ELIGIBLE');
});

test('存在しない暦日・範囲外の時刻・オフセットは補正せず要確認にする', function () {
  var ctx = setup();
  var invalid = [
    '2025-02-30T00:00:00Z', '2025-02-29T00:00:00Z', '2023-02-29T10:00:00+09:00', '2025-04-31T00:00:00Z',
    '2025-06-31T00:00:00Z', '2025-09-31T00:00:00Z', '2025-11-31T00:00:00Z', '2025-00-10T00:00:00Z',
    '2025-13-10T00:00:00Z', '2025-01-00T00:00:00Z', '2025-01-32T00:00:00Z', '2025-01-10T24:00:00Z',
    '2025-01-10T23:60:00Z', '2025-01-10T23:59:60Z', '2025-01-10T10:00:00+24:00', '2025-01-10T10:00:00+09:60',
    '1900-02-29T00:00:00Z'
  ];
  invalid.forEach(function (text) {
    var outcome = classify(ctx, { endAt: text });
    assert.strictEqual(outcome.reason, 'BASIS_INVALID', text);
  });
});

test('正常な閏日・月末・オフセット付き日時は受け付ける', function () {
  var ctx = setup();
  ['2024-02-29T10:00:00+09:00', '2000-02-29T00:00:00Z', '2025-04-30T23:59:59Z', '2025-01-31T00:00:00-05:00',
    '2025-12-31T23:59:59.999+14:00', '2025-01-10T10:00:00Z', '2025-01-10T10:00Z'].forEach(function (text) {
    assert.strictEqual(classify(ctx, { endAt: text }).verdict, 'ELIGIBLE', text);
  });
});

test('保留の解決日時が存在しない暦日なら有効な保留として扱い、消さない', function () {
  var ctx = setup();
  var id = addRow(ctx);
  ctx.book.insertSheet('RetentionHolds');
  var holds = ctx.sheets.RetentionHolds;
  holds.appendRow(ctx.sandbox.PersonalDataRetention.HOLDS_HEADERS);
  holds.appendRow([id, 'DISPUTE', '運営', ago(DAY), '2027-01-31T00:00:00+09:00', '2026-02-30T00:00:00Z']);
  var result = plain(ctx.sandbox.dryRunPersonalDataRetention(NOW));
  assert.deepStrictEqual(result.held, { HOLD_RECORD_INVALID: 1 });
  assert.strictEqual(result.eligible, 0);
});

test('個人情報の列がすべて空なら対象外（ALREADY_CLEAR）', function () {
  var ctx = setup();
  var clear = { name: '', email: '', phone: '', purpose: '', note: '' };
  assert.strictEqual(classify(ctx, clear).verdict, 'ALREADY_CLEAR');
  assert.strictEqual(classify(ctx, Object.assign({}, clear, { note: '   ' })).verdict, 'ALREADY_CLEAR');
});

test('予約IDが空欄の行は要確認', function () {
  var ctx = setup();
  assert.strictEqual(classify(ctx, { bookingId: '' }).reason, 'INVALID_BOOKING_ID');
});

// ============================================================================
// 判定: 未解決の決済・返金・精算・復旧は期限を過ぎても消さない
// ============================================================================

test('期限後でも、未解決の決済・返金・精算・復旧がある予約は消さない', function () {
  var ctx = setup();
  var cases = [
    [{ paymentStatus: 'checkout_pending' }, 'PAYMENT_UNRESOLVED'],
    [{ paymentStatus: 'refund_pending' }, 'PAYMENT_UNRESOLVED'],
    [{ paymentAttemptId: 'PAY-1', paymentAttemptResolvedAt: '' }, 'PAYMENT_ATTEMPT_UNRESOLVED'],
    [{ paymentRecoveryRequiredAt: ago(DAY) }, 'PAYMENT_RECOVERY_OPEN'],
    [{ feeRecoveryRequiredAt: ago(DAY) }, 'FEE_RECOVERY_OPEN'],
    [{ paymentLinkSendUnconfirmedAt: ago(DAY) }, 'PAYMENT_LINK_INCONSISTENT'],
    [{ paymentLinkMetadataInconsistentAt: ago(DAY) }, 'PAYMENT_LINK_INCONSISTENT'],
    [{ feeSettlementState: 'PENDING_CHARGE' }, 'FEE_SETTLEMENT_PENDING'],
    [{ feeSettlementState: 'PENDING_REFUND' }, 'FEE_SETTLEMENT_PENDING'],
    [{ feeSettlementState: 'PENDING_DECISION' }, 'FEE_SETTLEMENT_PENDING'],
    [{ checkoutCancelState: 'EXPIRE_REQUESTED' }, 'CHECKOUT_CANCEL_UNRESOLVED'],
    [{ checkoutCancelState: 'UNKNOWN' }, 'CHECKOUT_CANCEL_UNRESOLVED'],
    [{ checkoutCancelState: 'PAYMENT_RECEIVED' }, 'CHECKOUT_CANCEL_UNRESOLVED'],
    [{ refundAttemptState: 'RESERVED' }, 'REFUND_UNRESOLVED'],
    [{ refundAttemptState: 'UNKNOWN' }, 'REFUND_UNRESOLVED'],
    [{ refundAttemptState: 'FAILED' }, 'REFUND_UNRESOLVED'],
    [{ refundAttemptState: 'SUBMITTED', refundedAt: '' }, 'REFUND_UNRESOLVED'],
    [{ refundDecision: 'FULL', refundAttemptState: '', refundedAt: '' }, 'REFUND_UNRESOLVED'],
    [{ refundDecision: 'PARTIAL', refundAttemptState: '', refundedAt: '' }, 'REFUND_UNRESOLVED']
  ];
  cases.forEach(function (c) {
    var outcome = classify(ctx, c[0]);
    assert.strictEqual(outcome.verdict, 'HELD', JSON.stringify(c[0]));
    assert.strictEqual(outcome.reason, c[1], JSON.stringify(c[0]));
  });
});

test('未知の決済状態・精算状態・Checkout取消状態は要確認（消さない）', function () {
  var ctx = setup();
  assert.strictEqual(classify(ctx, { paymentStatus: 'weird' }).reason, 'PAYMENT_STATUS_UNKNOWN');
  assert.strictEqual(classify(ctx, { feeSettlementState: 'weird' }).reason, 'FEE_SETTLEMENT_STATE_UNKNOWN');
  assert.strictEqual(classify(ctx, { checkoutCancelState: 'weird' }).reason, 'CHECKOUT_CANCEL_STATE_UNKNOWN');
});

test('解決済みの決済・返金・精算は対象になる', function () {
  var ctx = setup();
  var resolved = [
    { paymentStatus: 'paid', paymentAttemptId: 'PAY-1', paymentAttemptResolvedAt: ago(RETENTION + DAY) },
    { paymentStatus: 'refunded', refundAttemptState: 'SUBMITTED', refundedAt: ago(RETENTION + DAY), refundDecision: 'FULL' },
    { paymentStatus: 'failed', paymentAttemptId: 'PAY-2', paymentAttemptResolvedAt: ago(RETENTION + DAY) },
    { feeSettlementState: 'SETTLED' },
    { checkoutCancelState: 'EXPIRED' },
    { checkoutCancelState: 'NO_SESSION' },
    { refundDecision: 'NONE' }
  ];
  resolved.forEach(function (overrides) {
    assert.strictEqual(classify(ctx, overrides).verdict, 'ELIGIBLE', JSON.stringify(overrides));
  });
});

test('期限前なら未解決の依存があってもNOT_DUE（理由は期限前のみ）', function () {
  var ctx = setup();
  assert.strictEqual(classify(ctx, { endAt: ago(DAY), paymentStatus: 'checkout_pending' }).verdict, 'NOT_DUE');
});

// ============================================================================
// 判定: 保留
// ============================================================================

test('有効な保留は期限後でも消さず、不正な解決日時は有効扱いにする', function () {
  var ctx = setup();
  var id = 'snb-hold-0001';
  var held = classify(ctx, { bookingId: id }, plain({ 'snb-hold-0001': { active: true, invalid: false, latestResolvedMs: NaN } }));
  assert.deepStrictEqual(held, { verdict: 'HELD', reason: 'HOLD_ACTIVE' });
  var invalid = classify(ctx, { bookingId: id }, plain({ 'snb-hold-0001': { active: true, invalid: true, latestResolvedMs: NaN } }));
  assert.strictEqual(invalid.reason, 'HOLD_RECORD_INVALID');
});

test('保留の解決日時から180日までは、通常の期限を過ぎていても消さない（遅い方）', function () {
  var ctx = setup();
  var holds = { 'snb-hold-0002': { active: false, invalid: false, latestResolvedMs: NOW.getTime() - 10 * DAY } };
  assert.strictEqual(classify(ctx, { bookingId: 'snb-hold-0002' }, holds).verdict, 'NOT_DUE');
  holds['snb-hold-0002'].latestResolvedMs = NOW.getTime() - RETENTION;
  assert.strictEqual(classify(ctx, { bookingId: 'snb-hold-0002' }, holds).verdict, 'ELIGIBLE');
  /* 保留の解決が通常の期限より前なら、通常の期限が優先される。 */
  holds['snb-hold-0002'].latestResolvedMs = NOW.getTime() - RETENTION - 100 * DAY;
  assert.strictEqual(classify(ctx, { bookingId: 'snb-hold-0002', endAt: ago(RETENTION + DAY) }, holds).verdict, 'ELIGIBLE');
});

// ============================================================================
// ヘッダー検証
// ============================================================================

test('ヘッダー検証: 正本の先頭一致は可、途中の欠落・順序違い・正本より長い・対象列の欠落は停止', function () {
  var ctx = setup();
  var check = function (header) { return plain(ctx.sandbox.PersonalDataRetention.checkBookingsHeader(header)); };
  var headers = ctx.headers;
  assert.strictEqual(check(headers).ok, true);
  assert.strictEqual(check(headers.slice(0, headers.length - 3)).ok, true);

  var missingMiddle = headers.slice(); missingMiddle.splice(10, 1);
  assert.deepStrictEqual(check(missingMiddle), { ok: false, code: 'HEADER_MISMATCH' });
  var swapped = headers.slice(); var tmp = swapped[6]; swapped[6] = swapped[7]; swapped[7] = tmp;
  assert.strictEqual(check(swapped).code, 'HEADER_MISMATCH');
  assert.deepStrictEqual(check(headers.concat(['unknownColumn'])), { ok: false, code: 'HEADER_UNKNOWN_COLUMNS' });
  assert.strictEqual(check(headers.slice(0, 10)).code, 'HEADER_MISSING_TARGET');
  assert.strictEqual(check([]).ok, false);
});

// ============================================================================
// 初期無効・設定
// ============================================================================

test('初期状態（未設定）では消さず、DISABLEDを記録するが成功日時は更新しない', function () {
  var ctx = setup();
  var id = addRow(ctx);
  var outcome = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(outcome.status, 'DISABLED');
  assert.strictEqual(cell(ctx, id, 'name'), PII.name);
  assert.strictEqual(ctx.sheet._setValuesCalls.length, 0);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT, undefined);
  assert.strictEqual(JSON.parse(ctx.store.PERSONAL_DATA_RETENTION_LAST_RUN).status, 'DISABLED');
});

test('フラグがfalse・不正値・方針バージョン不一致・dry-run未確認・dry-run版不一致では消さない', function () {
  var V = VERSION;
  var cases = [
    [{ PERSONAL_DATA_RETENTION_ENABLED: 'false', PERSONAL_DATA_RETENTION_POLICY_VERSION: V, PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: V }, 'DISABLED'],
    [{ PERSONAL_DATA_RETENTION_ENABLED: 'yes', PERSONAL_DATA_RETENTION_POLICY_VERSION: V, PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: V }, 'CONFIG_INVALID'],
    [{ PERSONAL_DATA_RETENTION_ENABLED: 'TRUE', PERSONAL_DATA_RETENTION_POLICY_VERSION: V, PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: V }, 'CONFIG_INVALID'],
    [{ PERSONAL_DATA_RETENTION_ENABLED: 'true', PERSONAL_DATA_RETENTION_POLICY_VERSION: 'old', PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: V }, 'CONFIG_INVALID'],
    [{ PERSONAL_DATA_RETENTION_ENABLED: 'true', PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: V }, 'CONFIG_INVALID'],
    [{ PERSONAL_DATA_RETENTION_ENABLED: 'true', PERSONAL_DATA_RETENTION_POLICY_VERSION: V }, 'CONFIG_INVALID'],
    [{ PERSONAL_DATA_RETENTION_ENABLED: 'true', PERSONAL_DATA_RETENTION_POLICY_VERSION: V, PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: 'old' }, 'CONFIG_INVALID']
  ];
  cases.forEach(function (c) {
    var ctx = setup({ properties: c[0] });
    var id = addRow(ctx);
    var outcome = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
    assert.strictEqual(outcome.status, c[1], JSON.stringify(c[0]));
    assert.strictEqual(cell(ctx, id, 'email'), PII.email);
    assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT, undefined);
  });
});

test('dry-run未実施のenableは失敗し、設定も変わらない', function () {
  var ctx = setup();
  assert.throws(function () { ctx.sandbox.enablePersonalDataRetention(); }, /DRY_RUN_REQUIRED/);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_ENABLED, undefined);
});

test('dry-run後にenableでき、disableで止まり（トリガーは触らない）、再度enableで再開できる', function () {
  var ctx = setup();
  var id = addRow(ctx);
  enable(ctx);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_ENABLED, 'true');
  assert.strictEqual(ctx.sandbox.disablePersonalDataRetention().enabled, false);
  assert.strictEqual(plain(ctx.sandbox.purgeExpiredPersonalData(NOW)).status, 'DISABLED');
  assert.strictEqual(cell(ctx, id, 'name'), PII.name);
  ctx.sandbox.enablePersonalDataRetention();
  assert.strictEqual(plain(ctx.sandbox.purgeExpiredPersonalData(NOW)).status, 'OK');
  assert.strictEqual(cell(ctx, id, 'name'), '');
  assert.strictEqual(ctx.scriptApp.getProjectTriggers().length, 0);
});

// ============================================================================
// dry-run
// ============================================================================

test('dry-runは何も書かず、保留シートも作らず、個人情報・予約ID・行番号を返さない', function () {
  var ctx = setup();
  var eligibleId = addRow(ctx);
  addRow(ctx, { endAt: ago(DAY) });
  addRow(ctx, { status: 'PENDING' });
  addRow(ctx, { paymentStatus: 'checkout_pending' });
  addRow(ctx, { status: 'DONE' });
  var before = JSON.stringify(ctx.sheet._rows);
  var result = plain(ctx.sandbox.dryRunPersonalDataRetention(NOW));
  assert.strictEqual(result.status, 'DRY_RUN');
  assert.strictEqual(result.scanned, 5);
  assert.strictEqual(result.eligible, 1);
  assert.strictEqual(result.notDue, 1);
  assert.strictEqual(result.pending, 1);
  assert.deepStrictEqual(result.held, { PAYMENT_UNRESOLVED: 1 });
  assert.deepStrictEqual(result.review, { UNKNOWN_STATUS: 1 });
  assert.strictEqual(result.erasedRows, 0);
  assert.strictEqual(JSON.stringify(ctx.sheet._rows), before);
  assert.strictEqual(ctx.sheet._setValuesCalls.length, 0);
  assert.strictEqual(ctx.sheets.RetentionHolds, undefined);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_ENABLED, undefined);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_DRY_RUN_VERSION, VERSION);

  var output = JSON.stringify(result) + ctx.logger._logs.join('\n');
  [PII.name, PII.email, PII.phone, PII.purpose, PII.note, eligibleId].forEach(function (secret) {
    assert.strictEqual(output.indexOf(secret), -1, secret + 'が出力に含まれている');
  });
});

test('dry-runはヘッダー不一致のシートでは方針バージョンを記録せず、SHEET_INVALIDを返す', function () {
  var ctx = setup();
  ctx.sheet._rows[0].splice(8, 1);
  var result = plain(ctx.sandbox.dryRunPersonalDataRetention(NOW));
  assert.strictEqual(result.status, 'SHEET_INVALID');
  assert.strictEqual(result.code, 'HEADER_MISMATCH');
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_DRY_RUN_VERSION, undefined);
});

// ============================================================================
// 実行（消去）
// ============================================================================

test('対象列だけを1セルずつ空にし、他の列（予約ID・日時・金額・状態・決済ID）は残す', function () {
  var ctx = setup();
  var id = addRow(ctx, {
    paymentLinkSentTo: 'sent@example.com', lastMailErrorMessage: 'メール失敗', paymentLinkLastErrorMessage: 'x',
    feeSettlementNote: '精算メモ', feeRecoveryReason: 'r1', paymentLastErrorMessage: 'e', paymentRecoveryReason: 'r2',
    refundReason: '返金理由', stripeCheckoutRequestSnapshot: '{"customerEmail":"pii-test@example.com"}',
    stripePaymentIntentId: 'pi_test_1', stripeAmount: 6000, stripeCurrency: 'jpy', paymentStatus: 'paid',
    paymentAttemptId: 'PAY-1', paymentAttemptResolvedAt: ago(RETENTION + 2 * DAY), checkoutAccessToken: 'tok_keep'
  });
  var original = ctx.sheet._rows[1].slice();
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.status, 'OK');
  assert.strictEqual(result.erasedRows, 1);
  assert.strictEqual(result.cellsCleared, 14);
  var erase = ctx.sandbox.PersonalDataRetention.BOOKINGS_ERASE_COLUMNS;
  ctx.headers.forEach(function (header, index) {
    var after = ctx.sheet._rows[1][index];
    if (erase.indexOf(header) !== -1) assert.strictEqual(after, '', header + 'が消えていない');
    else assert.strictEqual(after, original[index], header + 'が変更されている');
  });
  assert.strictEqual(cell(ctx, id, 'checkoutAccessToken'), 'tok_keep');
  /* 書き込みはすべて1セル。連続範囲・行全体を書き戻していない。 */
  assert.ok(ctx.sheet._setValuesCalls.length > 0);
  ctx.sheet._setValuesCalls.forEach(function (call) {
    assert.strictEqual(call.numRows, 1);
    assert.strictEqual(call.numCols, 1);
    assert.ok(call.row >= 2);
  });
  assert.ok(ctx.store.PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT);
});

test('期限前・PENDING・保留中・未解決の予約は消さず、対象だけを消す', function () {
  var ctx = setup();
  var due = addRow(ctx);
  var notDue = addRow(ctx, { endAt: ago(179 * DAY) });
  var pending = addRow(ctx, { status: 'PENDING' });
  var held = addRow(ctx, { feeSettlementState: 'PENDING_CHARGE' });
  var review = addRow(ctx, { endAt: 'broken' });
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.erasedRows, 1);
  assert.strictEqual(cell(ctx, due, 'name'), '');
  [notDue, pending, held, review].forEach(function (id) { assert.strictEqual(cell(ctx, id, 'name'), PII.name); });
});

test('再実行は冪等で、2回目は何も書かない', function () {
  var ctx = setup();
  addRow(ctx); addRow(ctx);
  enable(ctx);
  assert.strictEqual(plain(ctx.sandbox.purgeExpiredPersonalData(NOW)).erasedRows, 2);
  var writes = ctx.sheet._setValuesCalls.length;
  var second = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(second.status, 'OK');
  assert.strictEqual(second.erasedRows, 0);
  assert.strictEqual(second.alreadyClear, 2);
  assert.strictEqual(ctx.sheet._setValuesCalls.length, writes);
});

test('実行漏れがあっても、後日の実行で期限超過分をまとめて処理する', function () {
  var ctx = setup();
  var id = addRow(ctx, { endAt: ago(RETENTION + 40 * DAY) });
  enable(ctx);
  var later = new Date(NOW.getTime() + 30 * DAY);
  assert.strictEqual(plain(ctx.sandbox.purgeExpiredPersonalData(later)).erasedRows, 1);
  assert.strictEqual(cell(ctx, id, 'email'), '');
});

test('実行ログと記録に個人情報・予約ID・行内容が含まれない', function () {
  var ctx = setup();
  var id = addRow(ctx);
  enable(ctx);
  var result = ctx.sandbox.purgeExpiredPersonalData(NOW);
  var output = JSON.stringify(result) + ctx.logger._logs.join('\n') + JSON.stringify(ctx.store);
  [PII.name, PII.email, PII.phone, PII.purpose, PII.note, id].forEach(function (secret) {
    assert.strictEqual(output.indexOf(secret), -1, secret + 'が出力に含まれている');
  });
});

test('ヘッダー不一致のシートでは何も消さず、ハンドラは例外で終了する', function () {
  var ctx = setup();
  addRow(ctx);
  enable(ctx);
  ctx.sheet._rows[0].splice(3, 1);
  assert.throws(function () { ctx.sandbox.purgeExpiredPersonalData(NOW); }, /SHEET_INVALID/);
  assert.strictEqual(ctx.sheet._setValuesCalls.length, 0);
  assert.strictEqual(JSON.parse(ctx.store.PERSONAL_DATA_RETENTION_LAST_RUN).status, 'SHEET_INVALID');
});

test('同じ予約IDの行が複数ある場合は全て要確認で消さない', function () {
  var ctx = setup();
  var id = addRow(ctx);
  ctx.sheet.appendRow(rowOf(ctx, { bookingId: id }));
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.erasedRows, 0);
  assert.deepStrictEqual(result.review, { DUPLICATE_BOOKING_ID: 2 });
});

test('Bookingsシートが無い場合は何も作らず停止する', function () {
  var ctx = setup();
  delete ctx.sheets.Bookings;
  enable_ignoring_dry_run(ctx);
  var result = plain(ctx.sandbox.PersonalDataRetention.run(NOW));
  assert.strictEqual(result.status, 'SHEET_INVALID');
  assert.strictEqual(result.code, 'BOOKINGS_SHEET_MISSING');
  assert.strictEqual(ctx.sheets.Bookings, undefined);
});

function enable_ignoring_dry_run(ctx) {
  var props = ctx.sandbox.PropertiesService.getScriptProperties();
  props.setProperty('PERSONAL_DATA_RETENTION_ENABLED', 'true');
  props.setProperty('PERSONAL_DATA_RETENTION_POLICY_VERSION', VERSION);
  props.setProperty('PERSONAL_DATA_RETENTION_DRY_RUN_VERSION', VERSION);
}

// ============================================================================
// 分割・打ち切り・中断・競合
// ============================================================================

test('maxRowsで打ち切り（TRUNCATED）、次回の実行で残りを処理する', function () {
  var ctx = setup();
  for (var i = 0; i < 25; i++) addRow(ctx);
  enable(ctx);
  var first = plain(ctx.sandbox.purgeExpiredPersonalData(NOW, { maxRows: 10 }));
  assert.strictEqual(first.status, 'TRUNCATED');
  assert.strictEqual(first.erasedRows, 10);
  assert.ok(ctx.store.PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT);
  var second = plain(ctx.sandbox.purgeExpiredPersonalData(NOW, { maxRows: 100 }));
  assert.strictEqual(second.status, 'OK');
  assert.strictEqual(second.erasedRows, 15);
});

test('時間予算を超えたらバッチの途中で打ち切る（20行単位）', function () {
  var ctx = setup();
  for (var i = 0; i < 25; i++) addRow(ctx);
  enable(ctx);
  var ticks = [0, 0, 5000];
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW, {
    timeBudgetMs: 1000, clock: function () { return ticks.length > 1 ? ticks.shift() : ticks[0]; }
  }));
  assert.strictEqual(result.status, 'TRUNCATED');
  assert.strictEqual(result.erasedRows, 20);
});

function stopDuringLockTest(stopAtLockCall, expectedErased) {
  var props;
  var lockCalls = 0;
  var lockService = {
    getScriptLock: function () {
      return {
        tryLock: function () {
          lockCalls++;
          if (lockCalls === stopAtLockCall) props.setProperty('PERSONAL_DATA_RETENTION_ENABLED', 'false');
          return true;
        },
        releaseLock: function () {}
      };
    }
  };
  var ctx = setup({ lockService: lockService });
  props = ctx.sandbox.PropertiesService.getScriptProperties();
  for (var i = 0; i < 25; i++) addRow(ctx);
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.status, 'STOPPED');
  assert.strictEqual(result.erasedRows, expectedErased);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT, undefined);
  assert.strictEqual(plain(ctx.sandbox.getPersonalDataRetentionStatus(NOW)).gate, 'DISABLED');
}

test('ロック待ち中に停止された場合、ロック取得後に再確認して1行も書かない（STOPPED）', function () {
  stopDuringLockTest(1, 0);
});

test('実行中に停止フラグが立てられたら、次のバッチを開始しない（STOPPED）', function () {
  stopDuringLockTest(2, 20);
});

test('ロック取得後に方針バージョンが変えられた場合も書かずに止まる', function () {
  var props;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { props.setProperty('PERSONAL_DATA_RETENTION_POLICY_VERSION', 'other'); return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  props = ctx.sandbox.PropertiesService.getScriptProperties();
  var id = addRow(ctx);
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.status, 'STOPPED');
  assert.strictEqual(cell(ctx, id, 'name'), PII.name);
});

test('ロックを取れなければ消さずLOCK_TIMEOUTを記録する', function () {
  var ctx = setup({ lockService: stubs.createLockServiceStub({ forceTryLockFail: true }) });
  var id = addRow(ctx);
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.status, 'LOCK_TIMEOUT');
  assert.strictEqual(cell(ctx, id, 'name'), PII.name);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT, undefined);
});

test('対象判定後〜ロック取得後に返金が始まった行は、読み直しで除外して消さない', function () {
  var mutate = null;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { if (mutate) { mutate(); mutate = null; } return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  var raced = addRow(ctx);
  var other = addRow(ctx);
  var refundColumn = ctx.headers.indexOf('refundAttemptState');
  mutate = function () { ctx.sheet._rows[1][refundColumn] = 'RESERVED'; };
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.erasedRows, 1);
  assert.strictEqual(result.recheckSkipped, 1);
  assert.strictEqual(cell(ctx, raced, 'name'), PII.name);
  assert.strictEqual(cell(ctx, other, 'name'), '');
});

test('読み直し後に行が移動・削除されても、予約IDで引き直し、別の行を消さない', function () {
  var mutate = null;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { if (mutate) { mutate(); mutate = null; } return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  var first = addRow(ctx);
  var second = addRow(ctx);
  mutate = function () { ctx.sheet._rows.splice(1, 1); };
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.erasedRows, 1);
  assert.strictEqual(result.recheckSkipped, 1);
  assert.strictEqual(cell(ctx, second, 'name'), '');
  void first;
});

test('消去中に他プロセスが更新した非対象列（決済リンク送信回数等）を巻き戻さない', function () {
  var mutate = null;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { if (mutate) { mutate(); mutate = null; } return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  var id = addRow(ctx, { paymentLinkSendCount: 1 });
  var countColumn = ctx.headers.indexOf('paymentLinkSendCount');
  mutate = function () { ctx.sheet._rows[1][countColumn] = 5; };
  enable(ctx);
  ctx.sandbox.purgeExpiredPersonalData(NOW);
  assert.strictEqual(cell(ctx, id, 'paymentLinkSendCount'), 5);
  assert.strictEqual(cell(ctx, id, 'name'), '');
});

test('書き込み失敗でPARTIAL_FAILURE（ハンドラは例外）、成功日時は更新せず、次回は残りの列から完了する', function () {
  var ctx = setup();
  var id = addRow(ctx);
  enable(ctx);
  var originalGetRange = ctx.sheet.getRange;
  var writes = 0;
  ctx.sheet.getRange = function () {
    var range = originalGetRange.apply(ctx.sheet, arguments);
    var originalSetValue = range.setValue;
    range.setValue = function (value) {
      writes++;
      if (writes === 3) throw new Error('書き込み失敗: ' + PII.email);
      return originalSetValue.call(range, value);
    };
    return range;
  };
  assert.throws(function () { ctx.sandbox.purgeExpiredPersonalData(NOW); }, /PARTIAL_FAILURE/);
  assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT, undefined);
  assert.strictEqual(JSON.parse(ctx.store.PERSONAL_DATA_RETENTION_LAST_RUN).status, 'PARTIAL_FAILURE');
  assert.strictEqual(ctx.logger._logs.join('\n').indexOf(PII.email), -1);
  assert.notStrictEqual(cell(ctx, id, 'note') + cell(ctx, id, 'phone') + cell(ctx, id, 'email') + cell(ctx, id, 'name'), '');

  ctx.sheet.getRange = originalGetRange;
  var retry = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(retry.status, 'OK');
  ['name', 'email', 'phone', 'purpose', 'note'].forEach(function (column) { assert.strictEqual(cell(ctx, id, column), ''); });
});

// ============================================================================
// 別シートの未解決記録（Recovery / FeeSettlements / BookingChanges / OptionOrders）
// ============================================================================

function addSheet(ctx, name, headers, rows) {
  var sheet = ctx.book.insertSheet(name);
  sheet.appendRow(headers);
  (rows || []).forEach(function (row) { sheet.appendRow(row); });
  return sheet;
}

var RECOVERY_HEADERS = ['bookingId', 'failureType', 'occurredAt', 'calendarEventId', 'status', 'errorMessage', 'recoveryState', 'resolvedAt'];
var SETTLEMENT_HEADERS = ['settlementId', 'bookingId', 'changeId', 'settlementState', 'paidDelta', 'refundedDelta', 'note', 'requestedAt', 'applyStatus', 'appliedAt', 'resultPaidAmount', 'resultRefundedAmount'];
var CHANGE_HEADERS = ['changeId', 'bookingId', 'changedAt', 'oldDate', 'oldStartAt', 'oldEndAt', 'newDate', 'newStartAt', 'newEndAt', 'reason', 'feeNote', 'mailState', 'mailAt', 'mailError', 'oldFeeAmount', 'newFeeAmount', 'feeDifference', 'cancellationPolicyCategory', 'refundStatus', 'refundCandidateAmount', 'refundApprovedAmount', 'refundApprovedAt', 'refundPendingReason', 'settlementStateAtChange', 'feeDetailsJson'];
var OPTION_HEADERS = ['optionOrderId', 'bookingId', 'brand', 'category', 'source', 'itemsJson', 'amountJpy', 'currency', 'approvalStatus', 'paymentStatus', 'status', 'customerEmail', 'createdAt', 'updatedAt', 'approvedAt', 'declinedAt', 'declineReason', 'paymentAttemptId', 'checkoutRequestJson', 'stripeCheckoutSessionId', 'stripePaymentIntentId', 'stripeAmount', 'stripeCurrency', 'paidAt', 'lastStripeEventId', 'decisionMailSentAt', 'confirmedMailSentAt', 'paymentRecoveryRequiredAt', 'paymentRecoveryReason'];

function recoveryRow(bookingId, state) {
  return [bookingId, 'BASELINE_WRITE_UNCERTAIN', ago(DAY), '', 'CONFIRMED', 'メッセージ', state, ''];
}
function settlementRow(bookingId, applyStatus) {
  return ['S-1', bookingId, '', 'SETTLED', 0, 0, '', ago(DAY), applyStatus, '', '', ''];
}
function changeRow(bookingId, mailState) {
  return ['C-1', bookingId, ago(DAY), '', '', '', '', '', '', '', '', mailState];
}
function optionRow(bookingId, status, recoveryAt) {
  var row = OPTION_HEADERS.map(function () { return ''; });
  row[1] = bookingId; row[10] = status; row[11] = 'opt@example.com';
  row[OPTION_HEADERS.indexOf('paymentRecoveryRequiredAt')] = recoveryAt || '';
  return row;
}

test('Bookings側のフラグが空でも、RecoveryにOPENの記録がある予約は消さない（回帰）', function () {
  var ctx = setup();
  var open = addRow(ctx);
  var resolved = addRow(ctx);
  var unrelated = addRow(ctx);
  addSheet(ctx, 'Recovery', RECOVERY_HEADERS, [recoveryRow(open, 'OPEN'), recoveryRow(resolved, 'RESOLVED'), recoveryRow('other-id', 'OPEN')]);
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.erasedRows, 2);
  assert.deepStrictEqual(result.held, { RELATED_RECOVERY_OPEN: 1 });
  assert.strictEqual(cell(ctx, open, 'name'), PII.name);
  assert.strictEqual(cell(ctx, resolved, 'name'), '');
  assert.strictEqual(cell(ctx, unrelated, 'name'), '');
});

test('Recoveryの状態が空欄・未知の記録も未解決として扱う（RESOLVEDだけが解決済み）', function () {
  var ctx = setup();
  var blank = addRow(ctx);
  var unknown = addRow(ctx);
  addSheet(ctx, 'Recovery', RECOVERY_HEADERS, [recoveryRow(blank, ''), recoveryRow(unknown, 'WHATEVER')]);
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.erasedRows, 0);
  assert.deepStrictEqual(result.held, { RELATED_RECOVERY_OPEN: 2 });
});

test('FeeSettlements・BookingChanges・OptionOrdersに未解決の記録がある予約は消さない', function () {
  var ctx = setup();
  var pendingApply = addRow(ctx);
  var failedSettlement = addRow(ctx);
  var applied = addRow(ctx);
  var abandoned = addRow(ctx);
  var prepared = addRow(ctx);
  var recoveryRequired = addRow(ctx);
  var rolledBack = addRow(ctx);
  var optionPending = addRow(ctx);
  var optionRecovery = addRow(ctx);
  var optionConfirmed = addRow(ctx);
  var optionUnknown = addRow(ctx);
  addSheet(ctx, 'FeeSettlements', SETTLEMENT_HEADERS, [
    settlementRow(pendingApply, 'PENDING_APPLY'), settlementRow(failedSettlement, 'FAILED_NEEDS_RECOVERY'),
    settlementRow(applied, 'APPLIED'), settlementRow(abandoned, 'ABANDONED')
  ]);
  addSheet(ctx, 'BookingChanges', CHANGE_HEADERS, [
    changeRow(prepared, 'PREPARED'), changeRow(recoveryRequired, 'RECOVERY_REQUIRED'), changeRow(rolledBack, 'ROLLED_BACK')
  ]);
  addSheet(ctx, 'OptionOrders', OPTION_HEADERS, [
    optionRow(optionPending, 'AWAITING_PAYMENT'), optionRow(optionRecovery, 'CONFIRMED', ago(DAY)),
    optionRow(optionConfirmed, 'CONFIRMED'), optionRow(optionUnknown, '')
  ]);
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.deepStrictEqual(result.held, {
    RELATED_SETTLEMENT_UNRESOLVED: 2, RELATED_RESCHEDULE_UNRESOLVED: 2, RELATED_OPTION_ORDER_UNRESOLVED: 3
  });
  assert.strictEqual(result.erasedRows, 4);
  [applied, abandoned, rolledBack, optionConfirmed].forEach(function (id) { assert.strictEqual(cell(ctx, id, 'name'), ''); });
  [pendingApply, failedSettlement, prepared, recoveryRequired, optionPending, optionRecovery, optionUnknown].forEach(function (id) {
    assert.strictEqual(cell(ctx, id, 'name'), PII.name);
  });
});

test('対象判定後〜ロック取得後にRecoveryがOPENになった予約は、再判定で除外して消さない', function () {
  var mutate = null;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { if (mutate) { mutate(); mutate = null; } return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  var raced = addRow(ctx);
  var other = addRow(ctx);
  var recovery = addSheet(ctx, 'Recovery', RECOVERY_HEADERS, []);
  mutate = function () { recovery.appendRow(recoveryRow(raced, 'OPEN')); };
  enable(ctx);
  var result = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(result.erasedRows, 1);
  assert.strictEqual(result.recheckSkipped, 1);
  assert.strictEqual(cell(ctx, raced, 'name'), PII.name);
  assert.strictEqual(cell(ctx, other, 'name'), '');
});

test('関連シートの必須列が欠けていれば判定できないため、何も消さずSHEET_INVALIDで止まる', function () {
  ['Recovery', 'FeeSettlements', 'BookingChanges', 'OptionOrders'].forEach(function (name) {
    var ctx = setup();
    var id = addRow(ctx);
    addSheet(ctx, name, ['bookingId', 'unexpected'], []);
    enable_ignoring_dry_run(ctx);
    var result = plain(ctx.sandbox.PersonalDataRetention.run(NOW));
    assert.strictEqual(result.status, 'SHEET_INVALID', name);
    assert.strictEqual(result.code, 'RELATED_SHEET_INVALID', name);
    assert.strictEqual(cell(ctx, id, 'name'), PII.name);
    assert.strictEqual(plain(ctx.sandbox.dryRunPersonalDataRetention(NOW)).status, 'SHEET_INVALID', name);
    assert.strictEqual(ctx.store.PERSONAL_DATA_RETENTION_DRY_RUN_VERSION, VERSION);
  });
});

test('ロック取得後の再読込で関連シートが読めなくなったら、書かずに止まる', function () {
  var mutate = null;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { if (mutate) { mutate(); mutate = null; } return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  var id = addRow(ctx);
  var recovery = addSheet(ctx, 'Recovery', RECOVERY_HEADERS, []);
  mutate = function () { recovery._rows[0][6] = 'renamed'; };
  enable(ctx);
  var result = plain(ctx.sandbox.PersonalDataRetention.run(NOW));
  assert.strictEqual(result.status, 'SHEET_INVALID');
  assert.strictEqual(result.stopCode, 'RELATED_SHEET_INVALID');
  assert.strictEqual(cell(ctx, id, 'name'), PII.name);
});

// ============================================================================
// 保留
// ============================================================================

test('保留を追加すると期限後でも消えず、解決後は解決日時から180日まで消えない', function () {
  var ctx = setup();
  var id = addRow(ctx);
  enable(ctx);
  var added = plain(ctx.sandbox.addPersonalDataRetentionHold(id, 'DISPUTE', '運営A', '2027-01-31T00:00:00+09:00', NOW));
  assert.deepStrictEqual(added, { added: true, alreadyHeld: false });
  assert.deepStrictEqual(plain(ctx.sandbox.addPersonalDataRetentionHold(id, 'DISPUTE', '運営A', '2027-01-31T00:00:00+09:00', NOW)), { added: false, alreadyHeld: true });
  assert.strictEqual(ctx.sheets.RetentionHolds._rows.length, 2);

  var held = plain(ctx.sandbox.purgeExpiredPersonalData(NOW));
  assert.strictEqual(held.erasedRows, 0);
  assert.deepStrictEqual(held.held, { HOLD_ACTIVE: 1 });
  assert.strictEqual(cell(ctx, id, 'name'), PII.name);

  assert.strictEqual(plain(ctx.sandbox.resolvePersonalDataRetentionHold(id, NOW)).resolved, 1);
  var afterResolve = plain(ctx.sandbox.purgeExpiredPersonalData(new Date(NOW.getTime() + 179 * DAY)));
  assert.strictEqual(afterResolve.erasedRows, 0);
  assert.strictEqual(afterResolve.notDue, 1);
  assert.strictEqual(cell(ctx, id, 'name'), PII.name);

  var afterRetention = plain(ctx.sandbox.purgeExpiredPersonalData(new Date(NOW.getTime() + 180 * DAY)));
  assert.strictEqual(afterRetention.erasedRows, 1);
  assert.strictEqual(cell(ctx, id, 'name'), '');
});

test('保留の見直し期限を過ぎても自動解除せず、超過件数で知らせる', function () {
  var ctx = setup();
  var id = addRow(ctx);
  ctx.sandbox.addPersonalDataRetentionHold(id, 'REFUND', '運営B', '2026-12-20T00:00:00+09:00', NOW);
  var later = new Date(NOW.getTime() + 60 * DAY);
  var result = plain(ctx.sandbox.dryRunPersonalDataRetention(later));
  assert.strictEqual(result.holdReviewOverdue, 1);
  assert.deepStrictEqual(result.held, { HOLD_ACTIVE: 1 });
  assert.strictEqual(result.eligible, 0);
});

test('保留の追加は入力を検証する（予約ID・理由区分・担当・見直し期限・存在確認）', function () {
  var ctx = setup();
  var id = addRow(ctx);
  var add = function (a, b, c, d) { return function () { ctx.sandbox.addPersonalDataRetentionHold(a, b, c, d, NOW); }; };
  var future = '2027-01-31T00:00:00+09:00';
  assert.throws(add('', 'DISPUTE', '運営', future), /INVALID_BOOKING_ID/);
  assert.throws(add(id, 'free text', '運営', future), /INVALID_REASON/);
  assert.throws(add(id, 'DISPUTE', '  ', future), /OWNER_REQUIRED/);
  assert.throws(add(id, 'DISPUTE', '運営', ''), /REVIEW_BY_INVALID/);
  assert.throws(add(id, 'DISPUTE', '運営', '2027-01-31'), /REVIEW_BY_INVALID/);
  assert.throws(add(id, 'DISPUTE', '運営', '2026-12-01T00:00:00+09:00'), /REVIEW_BY_INVALID/);
  assert.throws(add('snb-missing', 'DISPUTE', '運営', future), /BOOKING_NOT_FOUND/);
  assert.strictEqual(ctx.sheets.RetentionHolds, undefined);
});

test('担当の先頭が数式記号なら文字列として保存する', function () {
  var ctx = setup();
  var id = addRow(ctx);
  ctx.sandbox.addPersonalDataRetentionHold(id, 'OTHER', '=cmd', '2027-01-31T00:00:00+09:00', NOW);
  assert.strictEqual(ctx.sheets.RetentionHolds._rows[1][2], "'=cmd");
});

test('保留シートのヘッダーが想定と異なれば、実行を停止して何も消さない', function () {
  var ctx = setup();
  var id = addRow(ctx);
  var holds = ctx.book.insertSheet('RetentionHolds');
  holds.appendRow(['bookingId', 'wrong']);
  enable_ignoring_dry_run(ctx);
  var result = plain(ctx.sandbox.PersonalDataRetention.run(NOW));
  assert.strictEqual(result.status, 'SHEET_INVALID');
  assert.strictEqual(result.code, 'HOLDS_SHEET_INVALID');
  assert.strictEqual(cell(ctx, id, 'name'), PII.name);
});

// ============================================================================
// トリガー補助・状態確認
// ============================================================================

test('日次トリガーは1本だけ作られ（毎日4時・Asia/Tokyo）、再実行しても重複しない', function () {
  var ctx = setup();
  var first = ctx.sandbox.createPersonalDataRetentionTrigger();
  ctx.sandbox.createPersonalDataRetentionTrigger();
  var triggers = ctx.scriptApp.getProjectTriggers();
  assert.strictEqual(triggers.length, 1);
  assert.strictEqual(first.getHandlerFunction(), 'purgeExpiredPersonalData');
  assert.deepStrictEqual(plain(triggers[0]._spec), { everyDays: 1, atHour: 4, timezone: 'Asia/Tokyo' });
  assert.deepStrictEqual(plain(ctx.sandbox.removePersonalDataRetentionTriggers()), { removed: 1 });
  assert.strictEqual(ctx.scriptApp.getProjectTriggers().length, 0);
});

test('状態確認: 初期は無効・トリガーなし・未実行で、有効化後に件数と成功日時が見え、個人情報を含まない', function () {
  var ctx = setup();
  var id = addRow(ctx);
  var initial = plain(ctx.sandbox.getPersonalDataRetentionStatus(NOW));
  assert.strictEqual(initial.gate, 'DISABLED');
  assert.strictEqual(initial.enabled, false);
  assert.ok(initial.attention.indexOf('NO_TRIGGER') !== -1);
  assert.strictEqual(initial.attention.indexOf('NEVER_RUN'), -1);

  ctx.sandbox.createPersonalDataRetentionTrigger();
  enable(ctx);
  var enabledNever = plain(ctx.sandbox.getPersonalDataRetentionStatus(NOW));
  assert.strictEqual(enabledNever.gate, 'OK');
  assert.ok(enabledNever.attention.indexOf('NEVER_RUN') !== -1);

  ctx.sandbox.purgeExpiredPersonalData(NOW);
  var ran = plain(ctx.sandbox.getPersonalDataRetentionStatus(NOW));
  assert.strictEqual(ran.triggerCount, 1);
  assert.strictEqual(ran.lastRun.status, 'OK');
  assert.strictEqual(ran.lastRun.erasedRows, 1);
  assert.strictEqual(ran.lastSuccessAt, NOW.toISOString());
  assert.deepStrictEqual(ran.attention, []);

  var stale = plain(ctx.sandbox.getPersonalDataRetentionStatus(new Date(NOW.getTime() + 37 * 60 * 60 * 1000)));
  assert.ok(stale.attention.indexOf('STALE_RUN') !== -1);

  var output = JSON.stringify([initial, ran, stale]);
  [PII.name, PII.email, id].forEach(function (secret) { assert.strictEqual(output.indexOf(secret), -1); });
});

test('状態確認: 重複トリガー・要確認行・方針バージョン不一致を知らせる', function () {
  var ctx = setup();
  addRow(ctx, { status: 'DONE' });
  ctx.scriptApp.newTrigger('purgeExpiredPersonalData').timeBased().everyDays(1).create();
  ctx.scriptApp.newTrigger('purgeExpiredPersonalData').timeBased().everyDays(1).create();
  enable(ctx);
  ctx.sandbox.purgeExpiredPersonalData(NOW);
  var status = plain(ctx.sandbox.getPersonalDataRetentionStatus(NOW));
  assert.ok(status.attention.indexOf('MULTIPLE_TRIGGERS') !== -1);
  assert.ok(status.attention.indexOf('REVIEW_ROWS_EXIST') !== -1);

  ctx.store.PERSONAL_DATA_RETENTION_POLICY_VERSION = 'old';
  assert.ok(plain(ctx.sandbox.getPersonalDataRetentionStatus(NOW)).attention.indexOf('CONFIG_INVALID') !== -1);
});

// ============================================================================
// 配布境界
// ============================================================================

test('PersonalDataRetention.gsはBooking Adminにだけ配布し、公開Web App・Webhookには含めない', function () {
  assert.ok(manifest.BOOKING_ADMIN_FILES.indexOf('PersonalDataRetention.gs') !== -1);
  assert.strictEqual(manifest.BOOKING_WEB_APP_FILES.indexOf('PersonalDataRetention.gs'), -1);
  assert.strictEqual(manifest.BOOKING_WEBHOOK_FILES.indexOf('PersonalDataRetention.gs'), -1);
});

test('公開Web App・Webhookのファイルセットには、消去APIもトリガー作成も存在しない', function () {
  var fs = require('fs');
  var path = require('path');
  var dir = path.join(__dirname, '..', 'gas', 'booking');
  var names = ['purgeExpiredPersonalData', 'PersonalDataRetention', 'dryRunPersonalDataRetention', 'enablePersonalDataRetention'];
  ['public', 'webhook', 'shared'].forEach(function (sub) {
    fs.readdirSync(path.join(dir, sub)).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (file) {
      var text = fs.readFileSync(path.join(dir, sub, file), 'utf8');
      names.forEach(function (name) {
        assert.strictEqual(text.indexOf(name), -1, sub + '/' + file + 'に' + name + 'がある');
      });
    });
  });
});

test('Booking Adminの管理画面（BookingAdminWeb.gs / Page.html）には消去関数を配線していない', function () {
  var fs = require('fs');
  var path = require('path');
  var dir = path.join(__dirname, '..', 'gas', 'booking', 'admin');
  ['BookingAdminWeb.gs', 'BookingAdminPage.html', 'BookingAdmin.gs'].forEach(function (file) {
    var text = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.strictEqual(/PersonalDataRetention|purgeExpiredPersonalData/.test(text), false, file);
  });
});
