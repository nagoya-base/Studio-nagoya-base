/*
 * BookingWebhookEndpoint（Booking Webhookプロジェクトの唯一のエントリポイント）のテスト
 * （Issue #341 PR-Cレビュー対応・4回目で新設）。
 *
 * 1〜3回目まではこのプロジェクトが決済照合・予約自動確定まで行っており、そのテストは
 * test/stripe-webhook-handler.test.js にあった。4回目でこのプロジェクトの責務が
 * 「署名検証済みイベントをStripeEventRepositoryへ安全に永続化するだけ」に縮小されたため
 * （BookingWebhookEndpoint.gs冒頭コメント参照）、決済照合・予約自動確定のテストは
 * test/stripe-webhook-processor.test.js へ移した。このファイルは、受信・永続化の
 * 契約だけを検証する:
 * - 新規イベントは永続化されて初めて成功応答を返す（success:trueの条件）。
 * - 永続化が完了する前に失敗した場合は成功を返さず、Stripeの自動再送に委ねる
 *   （取りこぼし防止）。
 * - 同一イベントの再送・並行受信は重複行を作らない（重複処理の入口での防止）。
 * - 認証（署名検証）に失敗したリクエストの中身は一切解釈しない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('crypto');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'StripeWebhookAuth.gs', 'StripeEventRepository.gs', 'BookingWebhookEndpoint.gs'];
var SPREADSHEET_ID = 'ss1';
var RELAY_SECRET = 'relay-shared-secret-test-0001';

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign(
    { SPREADSHEET_ID: SPREADSHEET_ID, STRIPE_WEBHOOK_RELAY_SECRET: RELAY_SECRET },
    opts.properties || {}
  );
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    Utilities: stubs.createUtilitiesStub(),
    Logger: stubs.createLoggerStub(),
    ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox };
}

function sign(secret, timestampSeconds, body) {
  return crypto.createHmac('sha256', secret).update(timestampSeconds + '.' + body).digest('hex');
}

function buildRequest(body, timestampSeconds, secret) {
  var ts = typeof timestampSeconds === 'number' ? timestampSeconds : Math.floor(Date.now() / 1000);
  var signature = sign(typeof secret === 'string' ? secret : RELAY_SECRET, ts, body);
  return {
    postData: { contents: JSON.stringify({ timestamp: ts, signature: signature, body: body }) }
  };
}

function buildEventBody(id, type) {
  return JSON.stringify({ id: id, type: type, data: { object: { id: 'cs_test_0001' } } });
}

function post(ctx, body, timestampSeconds, secret) {
  var output = ctx.sandbox.doPost(buildRequest(body, timestampSeconds, secret));
  return JSON.parse(output.text);
}

/*
 * ============================================================================
 * 正常系: 新規イベントの受信・永続化
 * ============================================================================
 */

test('doPost: 新規イベントは永続化されて初めて成功応答を返す', function () {
  var ctx = setup();
  var body = buildEventBody('evt_1', 'checkout.session.completed');

  var response = post(ctx, body);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.code, 'RECEIVED');

  var found = ctx.sandbox.StripeEventRepository.findByEventId('evt_1');
  assert.ok(found);
  assert.strictEqual(found.record.processingState, 'RECEIVED');
  assert.strictEqual(found.record.rawBody, body, 'rawBodyがそのまま永続化されているべき');
});

/*
 * ============================================================================
 * 取りこぼし防止: 永続化自体が失敗した場合は成功を返さない
 * ============================================================================
 */

test('doPost: rawBodyの永続化に失敗した場合は成功を返さず、Stripeの自動再送に委ねる（取りこぼし防止）', function () {
  var ctx = setup();
  var body = buildEventBody('evt_1', 'checkout.session.completed');

  var originalStoreRawBody = ctx.sandbox.StripeEventRepository.storeRawBody;
  ctx.sandbox.StripeEventRepository.storeRawBody = function () {
    throw new Error('injected Sheets write failure');
  };

  var response;
  try {
    response = post(ctx, body);
  } finally {
    ctx.sandbox.StripeEventRepository.storeRawBody = originalStoreRawBody;
  }
  assert.strictEqual(response.success, false);
  assert.strictEqual(response.code, 'LEDGER_WRITE_FAILED');

  /* claim()自体は成功しているため行は既に存在するが、rawBodyはまだ空
     （Booking Admin側のlistPendingWithBodyはこの行を処理対象に含めない）。行自体は
     決して失われていない（取りこぼしとは「二度と回収できないこと」ではなく、
     「この行に気づけないままStripeへ誤って成功を返すこと」を指す。ここではそれが
     起きていないことを検証する）。 */
  var found = ctx.sandbox.StripeEventRepository.findByEventId('evt_1');
  assert.ok(found);
  assert.strictEqual(found.record.processingState, 'RECEIVED');
  assert.strictEqual(found.record.rawBody, '');
  assert.strictEqual(ctx.sandbox.StripeEventRepository.listPendingWithBody().length, 0);

  /* Stripeがすぐに自動再送してきても（claimedAtからstaleAfterMs未満）、直前の試行が
     本当にクラッシュしたのか単なる並行受信なのか区別できないため、正直に
     IN_PROGRESS_NOT_YET_STOREDとして再試行を促す（決して誤ってrawBody無しのまま
     成功を返さない）。 */
  var immediateRetry = post(ctx, body);
  assert.strictEqual(immediateRetry.success, false);
  assert.strictEqual(immediateRetry.code, 'IN_PROGRESS_NOT_YET_STORED');

  var sheet = ctx.sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StripeEvents');
  assert.strictEqual(sheet.getLastRow(), 2, 'この間も重複行は作られない');

  /* 十分な時間が経過した後（既定staleAfterMs=5分超）の再送では、安全に再claimして
     永続化を完了できる。claimedAtを直接過去へ書き換えて時間経過を模擬する
     （StripeEventRepository.HEADERS_の4列目=claimedAt）。 */
  sheet.getRange(2, 4, 1, 1).setValue(new Date(Date.now() - 6 * 60000));
  var laterRetryResponse = post(ctx, body);
  assert.strictEqual(laterRetryResponse.success, true);
  assert.strictEqual(laterRetryResponse.code, 'RETRY_STORED');

  var foundAfterRetry = ctx.sandbox.StripeEventRepository.findByEventId('evt_1');
  assert.strictEqual(foundAfterRetry.record.rawBody, body);
  assert.strictEqual(ctx.sandbox.StripeEventRepository.listPendingWithBody().length, 1);
});

/*
 * ============================================================================
 * 重複処理の入口での防止: 同一イベントの再送・並行受信
 * ============================================================================
 */

test('doPost: 既にBooking Admin側が処理完了済みのイベントの再送は、重複行を作らず成功を返す', function () {
  var ctx = setup();
  var body = buildEventBody('evt_1', 'checkout.session.completed');

  var claimResult = ctx.sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', new Date());
  ctx.sandbox.StripeEventRepository.storeRawBody(claimResult.rowNumber, body, new Date());
  /* Booking Admin側のprocessPendingStripeWebhookEventsが既に処理を完了させた状況を再現。 */
  ctx.sandbox.StripeEventRepository.finalize(claimResult.rowNumber, {
    processingState: 'COMPLETED', bookingId: 'SX-20261001-AAAAAAAA', outcomeCode: 'CONFIRMED', outcomeMessage: 'ok'
  }, new Date());

  var response = post(ctx, body);
  assert.strictEqual(response.success, true);
  assert.strictEqual(response.code, 'ALREADY_COMPLETED');

  var sheet = ctx.sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StripeEvents');
  assert.strictEqual(sheet.getLastRow(), 2, 'ヘッダー+1行のまま。重複行が追加されてはならない');
});

test('doPost: 同一イベントの並行受信は重複行を作らない。先着がrawBodyを保存済みなら両方成功、未保存なら後着は再試行させる', function () {
  var ctx = setup();
  var body = buildEventBody('evt_1', 'checkout.session.completed');

  /* 1件目のリクエストがclaim済みだが、まだstoreRawBody前（同時到達）という状況。 */
  ctx.sandbox.StripeEventRepository.claim('evt_1', 'checkout.session.completed', new Date());

  var duringStore = post(ctx, body);
  assert.strictEqual(duringStore.success, false);
  assert.strictEqual(duringStore.code, 'IN_PROGRESS_NOT_YET_STORED');

  var sheet = ctx.sandbox.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('StripeEvents');
  assert.strictEqual(sheet.getLastRow(), 2, '並行受信でも重複行が追加されてはならない');

  /* 1件目が実際にstoreRawBodyまで完了した後の並行受信は、既に永続化済みとして成功を返す。 */
  var claimed = ctx.sandbox.StripeEventRepository.findByEventId('evt_1');
  ctx.sandbox.StripeEventRepository.storeRawBody(claimed.rowNumber, body, new Date());

  var afterStore = post(ctx, body);
  assert.strictEqual(afterStore.success, true);
  assert.strictEqual(afterStore.code, 'ALREADY_RECEIVED');
  assert.strictEqual(sheet.getLastRow(), 2);
});

/*
 * ============================================================================
 * 不正なリクエストの拒否
 * ============================================================================
 */

test('doPost: 認証（署名検証）に失敗したリクエストの中身は一切解釈しない', function () {
  var ctx = setup();
  var body = buildEventBody('evt_1', 'checkout.session.completed');
  var response = post(ctx, body, undefined, 'wrong-secret');
  assert.strictEqual(response.success, false);
  assert.strictEqual(response.error.code, 'FORBIDDEN');

  assert.strictEqual(ctx.sandbox.StripeEventRepository.findByEventId('evt_1'), null, '認証失敗時は台帳へ一切記録してはならない');
});

test('doPost: JSONとして解析できない本文はINVALID_EVENT_JSONとして拒否する', function () {
  var ctx = setup();
  var response = post(ctx, 'not-json{{{');
  assert.strictEqual(response.success, false);
  assert.strictEqual(response.code, 'INVALID_EVENT_JSON');
});

test('doPost: id/typeが欠落したイベントはINVALID_EVENT_SHAPEとして拒否する', function () {
  var ctx = setup();
  var response = post(ctx, JSON.stringify({ data: { object: { id: 'cs_1' } } }));
  assert.strictEqual(response.success, false);
  assert.strictEqual(response.code, 'INVALID_EVENT_SHAPE');
});

test('doPost: 台帳への読み書きロック取得に失敗した場合はLOCK_TIMEOUTとして再試行させる', function () {
  var lockService = stubs.createLockServiceStub({ forceTryLockFail: true });
  var ctx = setup({ lockService: lockService });
  var response = post(ctx, buildEventBody('evt_1', 'checkout.session.completed'));
  assert.strictEqual(response.success, false);
  assert.strictEqual(response.code, 'LOCK_TIMEOUT');
});
