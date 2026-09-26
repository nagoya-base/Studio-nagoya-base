/*
 * StripeEventRepositoryのテスト（Issue #341 PR-C「6. イベントの冪等性」）。
 * - 同一イベントの再送（既にCOMPLETED/IGNORED/REJECTED）は再処理せず同じ結果を返す。
 * - 同一イベントが同時に2件届いても（RECEIVEDのまま新しい）二重処理されない。
 * - 処理途中で失敗したイベント（RECEIVEDのまま古い）は安全に再claimできる。
 *
 * 【レビュー対応・4回目で追加】このファイルはBooking Webhook（新規イベントの受信・
 * rawBody永続化）とBooking Admin（未処理イベントの取り出し・claim経由の二重処理防止）の
 * 両方から共有される（gas/booking/webhook/からgas/booking/shared/へ移動。
 * StripeEventRepository.gs冒頭コメント参照）。storeRawBody/listPendingWithBodyは
 * このレビュー対応で新設した。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'StripeEventRepository.gs'];
var SPREADSHEET_ID = 'ss1';

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: SPREADSHEET_ID }),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById)
  };
  return loadBookingSandbox(FILES, globals);
}

test('claim: 新規イベントはRECEIVEDとして記録され、CLAIMEDを返す', function () {
  var sandbox = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var result = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', now);
  assert.strictEqual(result.outcome, 'CLAIMED');
  assert.strictEqual(result.isRetry, false);
  assert.strictEqual(result.record.processingState, 'RECEIVED');

  var found = sandbox.StripeEventRepository.findByEventId('evt_1');
  assert.ok(found);
  assert.strictEqual(found.record.processingState, 'RECEIVED');
});

test('claim + finalize: COMPLETED済みのイベントの再送はALREADY_TERMINALを返し再処理しない', function () {
  var sandbox = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', now);
  sandbox.StripeEventRepository.finalize(first.rowNumber, {
    processingState: 'COMPLETED', bookingId: 'SX-20261001-AAAAAAAA', outcomeCode: 'CONFIRMED', outcomeMessage: 'ok'
  }, now);

  var second = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', new Date(now.getTime() + 60000));
  assert.strictEqual(second.outcome, 'ALREADY_TERMINAL');
  assert.strictEqual(second.record.processingState, 'COMPLETED');
  assert.strictEqual(second.record.bookingId, 'SX-20261001-AAAAAAAA');

  /* 台帳には1行だけ（重複追加されていない）。 */
  var sheet = sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StripeEvents');
  assert.strictEqual(sheet.getLastRow(), 2); /* ヘッダー + 1行 */
});

test('claim: IGNORED/REJECTEDも同様に再送でALREADY_TERMINALを返す', function () {
  var sandbox = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var ignoredClaim = sandbox.StripeEventRepository.claim('evt_ignored', 'ping', now);
  sandbox.StripeEventRepository.finalize(ignoredClaim.rowNumber, { processingState: 'IGNORED', outcomeCode: 'UNHANDLED_EVENT_TYPE', outcomeMessage: '' }, now);
  var ignoredRetry = sandbox.StripeEventRepository.claim('evt_ignored', 'ping', now);
  assert.strictEqual(ignoredRetry.outcome, 'ALREADY_TERMINAL');
  assert.strictEqual(ignoredRetry.record.processingState, 'IGNORED');

  var rejectedClaim = sandbox.StripeEventRepository.claim('evt_rejected', 'checkout.session.completed', now);
  sandbox.StripeEventRepository.finalize(rejectedClaim.rowNumber, { processingState: 'REJECTED', bookingId: 'X', outcomeCode: 'BOOKING_NOT_FOUND', outcomeMessage: '' }, now);
  var rejectedRetry = sandbox.StripeEventRepository.claim('evt_rejected', 'checkout.session.completed', now);
  assert.strictEqual(rejectedRetry.outcome, 'ALREADY_TERMINAL');
  assert.strictEqual(rejectedRetry.record.processingState, 'REJECTED');
});

test('claim: 直近でRECEIVEDのまま（処理中の疑い）の場合はIN_PROGRESSを返し再claimしない', function () {
  var sandbox = setup();
  var claimedAt = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', claimedAt);

  /* まだ1分しか経っていない（既定のstaleAfterMs=5分未満）。同時到達の並行配信を想定。 */
  var soonAfter = new Date(claimedAt.getTime() + 60000);
  var concurrent = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', soonAfter);
  assert.strictEqual(concurrent.outcome, 'IN_PROGRESS');

  /* claimCountは増えていない（再claimしていない）。 */
  var found = sandbox.StripeEventRepository.findByEventId('evt_1');
  assert.strictEqual(Number(found.record.claimCount), 1);
});

test('claim: 十分に古いRECEIVED行は再claimされ、安全に再開できる（処理途中で失敗したイベントの再試行）', function () {
  var sandbox = setup();
  var claimedAt = new Date('2026-10-01T10:00:00+09:00');
  var first = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', claimedAt);
  assert.strictEqual(first.isRetry, false);

  /* 6分後（既定staleAfterMs=5分を超える）。前回の実行がクラッシュ/タイムアウトしたとみなす。 */
  var muchLater = new Date(claimedAt.getTime() + 6 * 60000);
  var retry = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', muchLater);
  assert.strictEqual(retry.outcome, 'CLAIMED');
  assert.strictEqual(retry.isRetry, true);

  var found = sandbox.StripeEventRepository.findByEventId('evt_1');
  assert.strictEqual(Number(found.record.claimCount), 2);
  assert.strictEqual(found.record.processingState, 'RECEIVED');
});

test('claim: カスタムstaleAfterMsを指定できる', function () {
  var sandbox = setup();
  var claimedAt = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', claimedAt);

  var tenSecondsLater = new Date(claimedAt.getTime() + 10000);
  var withShortStale = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', tenSecondsLater, 5000);
  assert.strictEqual(withShortStale.outcome, 'CLAIMED');
  assert.strictEqual(withShortStale.isRetry, true);
});

test('claim: Lock取得に失敗した場合はLOCK_TIMEOUTを返す', function () {
  var lockService = stubs.createLockServiceStub({ forceTryLockFail: true });
  var sandbox = setup({ lockService: lockService });
  var result = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', new Date());
  assert.strictEqual(result.outcome, 'LOCK_TIMEOUT');
});

test('finalize: processingStateにCLAIMED等の非終端値を渡すと例外を投げる', function () {
  var sandbox = setup();
  var claimResult = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', new Date());
  assert.throws(function () {
    sandbox.StripeEventRepository.finalize(claimResult.rowNumber, { processingState: 'RECEIVED' }, new Date());
  });
});

/*
 * ============================================================================
 * storeRawBody / listPendingWithBody（レビュー対応・4回目で新設）
 * ============================================================================
 */

test('storeRawBody: claimされた行にrawBodyを保存でき、findByEventIdで読み取れる', function () {
  var sandbox = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var claimResult = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', now);
  var rawBody = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });

  sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, rawBody, now);

  var found = sandbox.StripeEventRepository.findByEventId('evt_1');
  assert.strictEqual(found.record.rawBody, rawBody);
});

test('listPendingWithBody: processingState=RECEIVEDかつrawBody保存済みの行だけを返す', function () {
  var sandbox = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');

  /* 1) 正常系: 受信・永続化まで完了した行。 */
  var claim1 = sandbox.StripeEventRepository.claim('evt_stored', 'checkout.session.completed', now);
  sandbox.StripeEventRepository.storeRawBody(claim1.rowNumber, JSON.stringify({ id: 'evt_stored' }), now);

  /* 2) Webhook側がclaim直後・storeRawBody前にクラッシュした行（取りこぼしを疑うべき行）。
     rawBodyが空のため処理候補に含めてはならない（イベントの中身を復元できないため）。 */
  sandbox.StripeEventRepository.claim('evt_crashed_before_store', 'checkout.session.completed', now);

  /* 3) 既に終端状態まで到達した行。候補に含めてはならない。 */
  var claim3 = sandbox.StripeEventRepository.claim('evt_done', 'checkout.session.completed', now);
  sandbox.StripeEventRepository.storeRawBody(claim3.rowNumber, JSON.stringify({ id: 'evt_done' }), now);
  sandbox.StripeEventRepository.finalize(claim3.rowNumber, { processingState: 'COMPLETED', outcomeCode: 'CONFIRMED', outcomeMessage: '' }, now);

  var pending = sandbox.StripeEventRepository.listPendingWithBody();
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].record.eventId, 'evt_stored');
});

test('claim: rawBody保存済みでRECEIVEDのまま停止した行は、再claim（staleAfterMs経過後）してもrawBodyを保持したまま返す', function () {
  var sandbox = setup();
  var claimedAt = new Date('2026-10-01T10:00:00+09:00');
  var claim1 = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', claimedAt);
  var rawBody = JSON.stringify({ id: 'evt_1' });
  sandbox.StripeEventRepository.storeRawBody(claim1.rowNumber, rawBody, claimedAt);

  /* Admin側の処理が例外で中断し、RECEIVEDのまま放置された想定（Admin側のstaleAfterMsは
     StripeWebhookProcessor.ADMIN_CLAIM_STALE_AFTER_MS_=2分。ここでは直接staleAfterMsを
     指定して同じ挙動を検証する）。 */
  var muchLater = new Date(claimedAt.getTime() + 3 * 60000);
  var retry = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', muchLater, 2 * 60000);
  assert.strictEqual(retry.outcome, 'CLAIMED');
  assert.strictEqual(retry.isRetry, true);
  assert.strictEqual(retry.record.rawBody, rawBody, 'rawBodyは再claimしても保持されたままであるべき');
});
