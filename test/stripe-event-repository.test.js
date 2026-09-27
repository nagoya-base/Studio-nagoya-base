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

  /* RECEIVEDのまま放置された行を、Webhook側のclaim()がstaleAfterMs経過後に再claimする
     （ここでは直接staleAfterMsを指定して検証する）。 */
  var muchLater = new Date(claimedAt.getTime() + 3 * 60000);
  var retry = sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', muchLater, 2 * 60000);
  assert.strictEqual(retry.outcome, 'CLAIMED');
  assert.strictEqual(retry.isRetry, true);
  assert.strictEqual(retry.record.rawBody, rawBody, 'rawBodyは再claimしても保持されたままであるべき');
});

/*
 * ============================================================================
 * 処理権の世代管理・有効期限（レビュー対応・5回目で新設、7回目で再設計）
 *
 * 5〜6回目は「最後のハートビートから2分」で処理権の再取得を許していたが、Stripe APIの
 * 応答待ち中はハートビートを更新できないため、応答待ちが2分を超えた正常な実行から
 * 処理権を奪い得た。7回目では、再取得の判定をprocessingLeaseExpiresAt（呼び出し元が
 * Apps Scriptの最大実行時間から決める有効期限）だけで行い、ハートビート
 * （confirmProcessingClaim）は有効期限を延長しない生存記録と世代確認に役割を変えた。
 * ============================================================================
 */

var MINUTE = 60000;
var LEASE_MS = 7 * MINUTE;

function claimProcessingAt(sandbox, eventId, claimedAt) {
  return sandbox.StripeEventRepository.claimForProcessing(
    eventId, 'checkout.session.completed', claimedAt, new Date(claimedAt.getTime() + LEASE_MS));
}

test('claimForProcessing: 着手時刻と有効期限を記録し、有効期限内は（ハートビートの新旧に関係なく）再取得させない', function () {
  var sandbox = setup();
  var t0 = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', t0);
  var claimed = claimProcessingAt(sandbox, 'evt_1', t0);
  assert.strictEqual(claimed.outcome, 'CLAIMED');
  var stored = sandbox.StripeEventRepository.findByEventId('evt_1').record;
  assert.strictEqual(stored.processingClaimedAt.getTime(), t0.getTime());
  assert.strictEqual(stored.processingLeaseExpiresAt.getTime(), t0.getTime() + LEASE_MS);
  assert.strictEqual(Number(stored.processingClaimCount), 1);

  /* ハートビートを一度も更新しないまま（Stripe APIの応答待ちを想定）、5分後に別の実行が
     到達しても、有効期限（7分）内のため再取得できない。 */
  var competing = claimProcessingAt(sandbox, 'evt_1', new Date(t0.getTime() + 5 * MINUTE));
  assert.strictEqual(competing.outcome, 'IN_PROGRESS');
  assert.strictEqual(Number(sandbox.StripeEventRepository.findByEventId('evt_1').record.processingClaimCount), 1);
});

test('confirmProcessingClaim: 生存記録だけを更新し、着手時刻・有効期限は変えない（有効期限を延長しない）', function () {
  var sandbox = setup();
  var t0 = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', t0);
  var claimed = claimProcessingAt(sandbox, 'evt_1', t0);
  var generation = claimed.record.processingClaimCount;

  var heartbeatAt = new Date(t0.getTime() + 6 * MINUTE);
  var confirmation = sandbox.StripeEventRepository.confirmProcessingClaim(claimed.rowNumber, generation, heartbeatAt);
  assert.strictEqual(confirmation.confirmed, true);
  var stored = sandbox.StripeEventRepository.findByEventId('evt_1').record;
  assert.strictEqual(stored.processingHeartbeatAt.getTime(), heartbeatAt.getTime());
  assert.strictEqual(stored.processingClaimedAt.getTime(), t0.getTime(), '着手時刻はハートビートで上書きしない');
  assert.strictEqual(stored.processingLeaseExpiresAt.getTime(), t0.getTime() + LEASE_MS, 'ハートビートで有効期限を延長しない');

  /* 直前にハートビートがあっても、有効期限を過ぎれば再取得される（有効期限を過ぎた実行は
     Apps Scriptの最大実行時間により既に終了している前提）。 */
  var reclaimed = claimProcessingAt(sandbox, 'evt_1', new Date(t0.getTime() + LEASE_MS + 1000));
  assert.strictEqual(reclaimed.outcome, 'CLAIMED');
  assert.strictEqual(Number(reclaimed.record.processingClaimCount), Number(generation) + 1);
});

test('claimForProcessing: 有効期限を過ぎた処理権は再取得でき世代が進み、古い世代の確認は拒否される（実行停止後の再試行）', function () {
  var sandbox = setup();
  var t0 = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', t0);
  var claimed = claimProcessingAt(sandbox, 'evt_1', t0);
  var generation = claimed.record.processingClaimCount;

  var laterAttemptAt = new Date(t0.getTime() + 8 * MINUTE);
  var reclaimed = claimProcessingAt(sandbox, 'evt_1', laterAttemptAt);
  assert.strictEqual(reclaimed.outcome, 'CLAIMED');
  assert.strictEqual(reclaimed.isRetry, true);
  assert.strictEqual(Number(reclaimed.record.processingClaimCount), generation + 1, '再claimにより世代が進むべき');
  assert.strictEqual(reclaimed.record.processingClaimedAt.getTime(), laterAttemptAt.getTime(), '着手時刻は新しい世代の着手時刻');

  var staleConfirmation = sandbox.StripeEventRepository.confirmProcessingClaim(claimed.rowNumber, generation, laterAttemptAt);
  assert.strictEqual(staleConfirmation.confirmed, false);
  assert.strictEqual(staleConfirmation.reason, 'STALE_GENERATION');
});

test('claimForProcessing: 着手時刻・有効期限が無い、または有効期限が着手時刻以前なら例外を投げる', function () {
  var sandbox = setup();
  var t0 = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', t0);
  assert.throws(function () { sandbox.StripeEventRepository.claimForProcessing('evt_1', 'checkout.session.completed', t0, 2 * MINUTE); });
  assert.throws(function () { sandbox.StripeEventRepository.claimForProcessing('evt_1', 'checkout.session.completed', t0, t0); });
  assert.throws(function () { sandbox.StripeEventRepository.claimForProcessing('evt_1', 'checkout.session.completed', undefined, new Date(t0.getTime() + LEASE_MS)); });
});

test('releaseProcessingClaim: 現在の世代だけが処理権を手放せ、手放した後は有効期限を待たずに再取得できる', function () {
  var sandbox = setup();
  var t0 = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', t0);
  var claimed = claimProcessingAt(sandbox, 'evt_1', t0);
  var generation = claimed.record.processingClaimCount;

  assert.strictEqual(sandbox.StripeEventRepository.releaseProcessingClaim(claimed.rowNumber, generation + 1, t0).released, false, '別の世代は手放せない');
  assert.strictEqual(claimProcessingAt(sandbox, 'evt_1', new Date(t0.getTime() + MINUTE)).outcome, 'IN_PROGRESS');

  var releaseAt = new Date(t0.getTime() + 30000);
  assert.strictEqual(sandbox.StripeEventRepository.releaseProcessingClaim(claimed.rowNumber, generation, releaseAt).released, true);
  var retried = claimProcessingAt(sandbox, 'evt_1', new Date(t0.getTime() + MINUTE));
  assert.strictEqual(retried.outcome, 'CLAIMED');
  assert.strictEqual(Number(retried.record.processingClaimCount), generation + 1);
});

test('isProcessingClaimCurrentLocked: 世代が一致し終端状態でない場合だけtrue（Lockを取得しない）', function () {
  var lockService = stubs.createLockServiceStub();
  var sandbox = setup({ lockService: lockService });
  var t0 = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', t0);
  var claimed = claimProcessingAt(sandbox, 'evt_1', t0);
  var generation = claimed.record.processingClaimCount;

  /* 呼び出し元（BookingRepository等）が既にLockを保持している状況で呼べること。 */
  var outerLock = lockService.getScriptLock();
  assert.strictEqual(outerLock.tryLock(1000), true);
  try {
    assert.strictEqual(sandbox.StripeEventRepository.isProcessingClaimCurrentLocked(claimed.rowNumber, generation), true);
    assert.strictEqual(sandbox.StripeEventRepository.isProcessingClaimCurrentLocked(claimed.rowNumber, generation - 1), false);
  } finally {
    outerLock.releaseLock();
  }

  sandbox.StripeEventRepository.finalizeForProcessing(claimed.rowNumber, generation, {
    processingState: 'COMPLETED', outcomeCode: 'CONFIRMED', outcomeMessage: ''
  }, t0);
  assert.strictEqual(sandbox.StripeEventRepository.isProcessingClaimCurrentLocked(claimed.rowNumber, generation), false, '終端状態ではfalse');
});

test('finalizeForProcessing: 世代が一致する場合のみ書き込み、既に進んだ古い世代からの書き込みは拒否する（古い実行の遅延応答による上書き防止）', function () {
  var sandbox = setup();
  var t0 = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', t0);
  var claimedByA = claimProcessingAt(sandbox, 'evt_1', t0);
  var generationA = claimedByA.record.processingClaimCount;

  /* 実行Aの有効期限が過ぎた後に、実行Bが再claimして世代を進める。 */
  var reclaimedByB = claimProcessingAt(sandbox, 'evt_1', new Date(t0.getTime() + 8 * MINUTE));
  var generationB = reclaimedByB.record.processingClaimCount;
  assert.notStrictEqual(generationA, generationB);

  /* 実行Aの遅延した応答が、Bがまだ結果を確定する前の時点で戻ってきたとしても、
     世代が既に進んでいるため拒否される（B自身がまだfinalizeしていない＝終端状態
     ではない段階でも、世代の不一致だけで正しく弾かれることを確認する）。 */
  var writtenByA = sandbox.StripeEventRepository.finalizeForProcessing(claimedByA.rowNumber, generationA, {
    processingState: 'REJECTED', bookingId: 'SX-A', outcomeCode: 'STALE_A', outcomeMessage: 'Aの遅延応答'
  }, new Date(t0.getTime() + 9 * MINUTE));
  assert.strictEqual(writtenByA.written, false);
  assert.strictEqual(writtenByA.reason, 'STALE_GENERATION');

  /* 実行Bが自分の結果を確定する。Aの拒否された書き込みの影響を受けない。 */
  var writtenByB = sandbox.StripeEventRepository.finalizeForProcessing(reclaimedByB.rowNumber, generationB, {
    processingState: 'COMPLETED', bookingId: 'SX-B', outcomeCode: 'CONFIRMED', outcomeMessage: 'Bが確定'
  }, new Date(t0.getTime() + 10 * MINUTE));
  assert.strictEqual(writtenByB.written, true);

  var finalRecord = sandbox.StripeEventRepository.findByEventId('evt_1').record;
  assert.strictEqual(finalRecord.processingState, 'COMPLETED');
  assert.strictEqual(finalRecord.bookingId, 'SX-B', 'Bの結果が保持されているべき（Aの遅延した書き込みで上書きされてはならない）');
  assert.strictEqual(finalRecord.outcomeCode, 'CONFIRMED');
});

test('finalizeForProcessing: 既に終端状態の行への書き込みは世代が一致していても拒否する', function () {
  var sandbox = setup();
  var t0 = new Date('2026-10-01T10:00:00+09:00');
  sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', t0);
  var claimed = claimProcessingAt(sandbox, 'evt_1', t0);
  var generation = claimed.record.processingClaimCount;

  var first = sandbox.StripeEventRepository.finalizeForProcessing(claimed.rowNumber, generation, {
    processingState: 'COMPLETED', outcomeCode: 'CONFIRMED', outcomeMessage: ''
  }, t0);
  assert.strictEqual(first.written, true);

  var second = sandbox.StripeEventRepository.finalizeForProcessing(claimed.rowNumber, generation, {
    processingState: 'REJECTED', outcomeCode: 'SHOULD_NOT_APPLY', outcomeMessage: ''
  }, t0);
  assert.strictEqual(second.written, false);
  assert.strictEqual(second.reason, 'ALREADY_TERMINAL');
});
