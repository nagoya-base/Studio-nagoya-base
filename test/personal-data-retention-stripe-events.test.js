/*
 * Stripe Webhook受信台帳（StripeEvents）の個人情報の180日経過後消去（Issue #680 PR-4。
 * admin/PersonalDataRetention.gs）のテスト。Sheets・Lock・Propertiesはすべてスタブで、本番へは一切
 * アクセスしない。実際に配布するBooking Adminのファイルセットだけをvmへ読み込む。
 *
 * - 消す列: rawBody（イベント本文）・outcomeMessage。eventId・状態・予約ID・決済ID・結果コード・日時は残す
 * - 終端日時はupdatedAt。終端の行は再受信されても書き換わらないこと（前提）を回帰テストで確認する
 * - 予約IDがあれば親Bookings、なければ本文から特定した会員に結び付ける。結び付かないものは要確認
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
var VERSION = '2026-10-31.4';

var EMAIL = 'pii-event@example.com';
var NAME_IN_BODY = 'イベント本文の氏名';

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function ago(ms) { return new Date(NOW.getTime() - ms); }

var EVENT_HEADERS = ['eventId', 'eventType', 'receivedAt', 'claimedAt', 'claimCount', 'processingState', 'bookingId', 'paymentAttemptId', 'stripePaymentIntentId', 'outcomeCode', 'outcomeMessage', 'updatedAt', 'rawBody', 'processingClaimedAt', 'processingClaimCount', 'processingHeartbeatAt', 'processingLeaseExpiresAt'];
var MEMBER_HEADERS = ['memberId', 'email', 'stripeCustomerId', 'stripeSubscriptionId', 'status', 'currentPeriodStart', 'currentPeriodEnd', 'canceledAt', 'cancelAtPeriodEnd', 'latestInvoiceId', 'latestEventId', 'latestEventCreated', 'createdAt', 'updatedAt'];

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
    store: propertiesService._store, logger: logger, headers: sandbox.BookingsSchema.HEADERS.slice(), tables: {}
  };
}

var seq = 0;
function addBooking(ctx, overrides) {
  seq += 1;
  var base = Object.assign({
    bookingId: 'snb-20250101-' + ('0000' + seq).slice(-4) + 'abcd', status: 'CONFIRMED', endAt: ago(RETENTION + 30 * DAY)
  }, overrides || {});
  ctx.bookings.appendRow(ctx.headers.map(function (h) { return base[h] === undefined ? '' : base[h]; }));
  return base.bookingId;
}

function table(ctx, name, headers) {
  if (!ctx.tables[name]) {
    ctx.tables[name] = ctx.book.insertSheet(name);
    ctx.tables[name].appendRow(headers);
  }
  return ctx.tables[name];
}

function append(ctx, name, headers, values) {
  table(ctx, name, headers).appendRow(headers.map(function (h) { return values[h] === undefined ? '' : values[h]; }));
  return values;
}

var memSeq = 0;
function addMember(ctx, overrides) {
  memSeq += 1;
  return append(ctx, 'Members', MEMBER_HEADERS, Object.assign({
    memberId: 'mem-' + memSeq, email: EMAIL, stripeCustomerId: 'cus_' + memSeq, stripeSubscriptionId: 'sub_' + memSeq, status: 'canceled',
    currentPeriodEnd: ago(RETENTION + 60 * DAY), canceledAt: ago(RETENTION + 61 * DAY)
  }, overrides || {}));
}

function bodyOf(object, type) {
  return JSON.stringify({ id: 'evt_body', type: type || 'invoice.paid', data: { object: Object.assign({ customer_email: EMAIL, customer_name: NAME_IN_BODY }, object) } });
}

var evSeq = 0;
function addEvent(ctx, overrides) {
  evSeq += 1;
  var values = Object.assign({
    eventId: 'evt_' + evSeq, eventType: 'checkout.session.completed', receivedAt: ago(RETENTION + 40 * DAY), claimedAt: ago(RETENTION + 40 * DAY), claimCount: 1,
    processingState: 'COMPLETED', bookingId: '', paymentAttemptId: 'PAY-' + evSeq, stripePaymentIntentId: 'pi_' + evSeq, outcomeCode: 'OK',
    outcomeMessage: '結果メッセージ（個人情報が入り得る）', updatedAt: ago(RETENTION + 39 * DAY), rawBody: bodyOf({}),
    processingClaimedAt: ago(RETENTION + 39 * DAY), processingClaimCount: 1
  }, overrides || {});
  append(ctx, 'StripeEvents', EVENT_HEADERS, values);
  return values.eventId;
}

function col(name) { return EVENT_HEADERS.indexOf(name); }
function eventRow(ctx, id) {
  var sheet = ctx.tables.StripeEvents;
  for (var i = 1; i < sheet._rows.length; i++) if (sheet._rows[i][0] === id) return sheet._rows[i];
  throw new Error('event not found: ' + id);
}
function erased(ctx, id) {
  var row = eventRow(ctx, id);
  return row[col('rawBody')] === '' && row[col('outcomeMessage')] === '';
}

function enable(ctx) {
  ctx.sandbox.dryRunPersonalDataRetention(NOW);
  ctx.sandbox.enablePersonalDataRetention();
}

function run(ctx, now, options) {
  return plain(ctx.sandbox.purgeExpiredPersonalData(now || NOW, options));
}

// ============================================================================
// 予約に結び付くイベント
// ============================================================================

test('StripeEvents: 予約に結び付く終端のイベントのrawBodyとoutcomeMessageだけを消し、ID・状態・結果コード・日時は残す', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var id = addEvent(ctx, { bookingId: bookingId });
  var before = eventRow(ctx, id).slice();
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.status, 'OK');
  assert.strictEqual(result.children.StripeEvents.erasedRows, 1);
  assert.strictEqual(result.children.StripeEvents.cellsCleared, 2);
  var after = eventRow(ctx, id);
  EVENT_HEADERS.forEach(function (column, c) {
    if (column === 'rawBody' || column === 'outcomeMessage') assert.strictEqual(after[c], '', column);
    else assert.strictEqual(String(after[c]), String(before[c]), column + 'が変更されている');
  });
  ctx.tables.StripeEvents._setValuesCalls.forEach(function (call) {
    assert.strictEqual(call.numRows, 1);
    assert.strictEqual(call.numCols, 1);
    assert.ok(call.col === col('rawBody') + 1 || call.col === col('outcomeMessage') + 1);
  });
});

test('StripeEvents: COMPLETED / IGNORED / REJECTEDはどれも終端として扱う', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var ids = ['COMPLETED', 'IGNORED', 'REJECTED'].map(function (state) { return addEvent(ctx, { bookingId: bookingId, processingState: state }); });
  enable(ctx);
  assert.strictEqual(run(ctx).children.StripeEvents.erasedRows, 3);
  ids.forEach(function (id) { assert.ok(erased(ctx, id), id); });
});

test('StripeEvents: 終端日時はupdatedAt。親が古くても自身が新しければ待ち、180日ちょうどで消す', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx, { endAt: ago(RETENTION + 300 * DAY) });
  var recent = addEvent(ctx, { bookingId: bookingId, updatedAt: ago(10 * DAY) });
  var boundary = addEvent(ctx, { bookingId: bookingId, updatedAt: new Date(NOW.getTime() - RETENTION) });
  var justBefore = addEvent(ctx, { bookingId: bookingId, updatedAt: new Date(NOW.getTime() - RETENTION + 1) });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.StripeEvents.erasedRows, 1);
  assert.strictEqual(result.children.StripeEvents.notDue, 2);
  assert.ok(erased(ctx, boundary));
  assert.ok(!erased(ctx, recent));
  assert.ok(!erased(ctx, justBefore));
});

test('StripeEvents: 未処理(RECEIVED)は古くても消さず、状態不明・updatedAtの欠落／不正は要確認', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var received = addEvent(ctx, { bookingId: bookingId, processingState: 'RECEIVED' });
  var unknown = addEvent(ctx, { bookingId: bookingId, processingState: 'WEIRD' });
  var missing = addEvent(ctx, { bookingId: bookingId, updatedAt: '' });
  var invalid = addEvent(ctx, { bookingId: bookingId, updatedAt: '2026-02-30T00:00:00Z' });
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.StripeEvents;
  assert.strictEqual(counts.erasedRows, 0);
  assert.deepStrictEqual(counts.held, { EVENT_UNPROCESSED: 1 });
  assert.deepStrictEqual(counts.review, { EVENT_STATE_UNKNOWN: 1, OWN_DATE_MISSING: 1, OWN_DATE_INVALID: 1 });
  [received, unknown, missing, invalid].forEach(function (id) { assert.ok(!erased(ctx, id), id); });
});

test('StripeEvents: 親が未終了・保留中・依存未解決・見つからない場合は消さない', function () {
  var ctx = setup();
  var pending = addBooking(ctx, { status: 'PENDING' });
  var unpaid = addBooking(ctx, { paymentStatus: 'refund_pending' });
  var held = addBooking(ctx);
  ctx.sandbox.addPersonalDataRetentionHold(held, 'DISPUTE', '運営A', '2027-06-30T00:00:00+09:00', NOW);
  var heldId = addEvent(ctx, { bookingId: held });
  [pending, unpaid].forEach(function (id) { addEvent(ctx, { bookingId: id }); });
  addEvent(ctx, { bookingId: 'snb-missing' });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.StripeEvents.erasedRows, 0);
  assert.deepStrictEqual(result.children.StripeEvents.held, { PARENT_NOT_ENDED: 1, PAYMENT_UNRESOLVED: 1, HOLD_ACTIVE: 1 });
  assert.deepStrictEqual(result.children.StripeEvents.review, { PARENT_NOT_FOUND: 1 });
  assert.ok(!erased(ctx, heldId));
});

test('StripeEvents: 同じ予約にRecoveryのOPENがあれば、解決済みのイベントも消さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var id = addEvent(ctx, { bookingId: bookingId });
  append(ctx, 'Recovery', ['bookingId', 'failureType', 'occurredAt', 'calendarEventId', 'status', 'errorMessage', 'recoveryState', 'resolvedAt'],
    { bookingId: bookingId, failureType: 'X', occurredAt: ago(DAY), recoveryState: 'OPEN' });
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.StripeEvents.held, { RELATED_RECOVERY_OPEN: 1 });
  assert.ok(!erased(ctx, id));
});

// ============================================================================
// 会員に結び付くイベント（予約IDの列が空）
// ============================================================================

test('StripeEvents: 予約IDが空のイベントは、本文のcustomer／subscription／metadata.memberIdから会員に結び付ける', function () {
  var ctx = setup();
  var a = addMember(ctx);
  var b = addMember(ctx);
  var c = addMember(ctx);
  var d = addMember(ctx);
  var byCustomer = addEvent(ctx, { rawBody: bodyOf({ customer: a.stripeCustomerId }) });
  var bySubscription = addEvent(ctx, { rawBody: bodyOf({ subscription: b.stripeSubscriptionId }) });
  var byMetadata = addEvent(ctx, { rawBody: bodyOf({ metadata: { memberId: c.memberId } }) });
  var bySubscriptionObject = addEvent(ctx, { rawBody: bodyOf({ object: 'subscription', id: d.stripeSubscriptionId }, 'customer.subscription.deleted') });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.StripeEvents.erasedRows, 4);
  [byCustomer, bySubscription, byMetadata, bySubscriptionObject].forEach(function (id) { assert.ok(erased(ctx, id), id); });
});

test('StripeEvents: 会員が有効・未完了なら保留、退会後も会員側の終了から180日待つ', function () {
  var ctx = setup();
  var active = addMember(ctx, { status: 'active', canceledAt: '' });
  var recentEnd = addMember(ctx, { canceledAt: ago(10 * DAY), currentPeriodEnd: ago(10 * DAY) });
  var ended = addMember(ctx);
  var e1 = addEvent(ctx, { rawBody: bodyOf({ customer: active.stripeCustomerId }) });
  var e2 = addEvent(ctx, { rawBody: bodyOf({ customer: recentEnd.stripeCustomerId }) });
  var e3 = addEvent(ctx, { rawBody: bodyOf({ customer: ended.stripeCustomerId }) });
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.StripeEvents.held, { MEMBER_NOT_ENDED: 1 });
  assert.strictEqual(result.children.StripeEvents.notDue, 1);
  assert.strictEqual(result.children.StripeEvents.erasedRows, 1);
  assert.ok(!erased(ctx, e1));
  assert.ok(!erased(ctx, e2));
  assert.ok(erased(ctx, e3));
});

test('StripeEvents: 会員に結び付かない・複数に結び付く・本文が解析できないイベントは要確認で消さない', function () {
  var ctx = setup();
  var a = addMember(ctx);
  var b = addMember(ctx);
  addMember(ctx, { memberId: 'mem-dup', stripeCustomerId: 'cus_dup', stripeSubscriptionId: 'sub_dup1' });
  addMember(ctx, { memberId: 'mem-dup', stripeCustomerId: 'cus_dup2', stripeSubscriptionId: 'sub_dup2' });
  var none = addEvent(ctx, { rawBody: bodyOf({ customer: 'cus_unknown' }) });
  var noObject = addEvent(ctx, { rawBody: JSON.stringify({ id: 'x', type: 'ping' }) });
  var ambiguous = addEvent(ctx, { rawBody: bodyOf({ customer: a.stripeCustomerId, subscription: b.stripeSubscriptionId }) });
  var broken = addEvent(ctx, { rawBody: '{not json' });
  var dup = addEvent(ctx, { rawBody: bodyOf({ metadata: { memberId: 'mem-dup' } }) });
  var emptyBody = addEvent(ctx, { rawBody: '', outcomeMessage: 'メッセージだけ残っている' });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.StripeEvents.erasedRows, 0);
  assert.deepStrictEqual(result.children.StripeEvents.review, {
    NO_LINK: 2 + 1, LINK_AMBIGUOUS: 1, RAW_BODY_UNPARSEABLE: 1, MEMBER_AMBIGUOUS: 1
  });
  [none, noObject, ambiguous, broken, dup, emptyBody].forEach(function (id) { assert.ok(!erased(ctx, id), id); });
});

test('StripeEvents: 会員単位の保留は会員に結び付くイベントにも効き、解決後は解決日時から180日まで消さない', function () {
  var ctx = setup();
  var member = addMember(ctx);
  var id = addEvent(ctx, { rawBody: bodyOf({ customer: member.stripeCustomerId }) });
  ctx.sandbox.addPersonalDataRetentionMemberHold(member.memberId, 'DISPUTE', '運営A', '2027-06-30T00:00:00+09:00', NOW);
  enable(ctx);
  assert.deepStrictEqual(run(ctx).children.StripeEvents.held, { HOLD_ACTIVE: 1 });
  ctx.sandbox.resolvePersonalDataRetentionMemberHold(member.memberId, NOW);
  assert.strictEqual(run(ctx, new Date(NOW.getTime() + 179 * DAY)).children.StripeEvents.erasedRows, 0);
  assert.strictEqual(run(ctx, new Date(NOW.getTime() + 180 * DAY)).children.StripeEvents.erasedRows, 1);
  assert.ok(erased(ctx, id));
});

// ============================================================================
// 冪等性・再処理への影響
// ============================================================================

test('StripeEvents: 消去後に同じイベントが再受信されても、claim()はALREADY_TERMINALを返し、本文もupdatedAtも変えない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var id = addEvent(ctx, { bookingId: bookingId });
  enable(ctx);
  run(ctx);
  assert.ok(erased(ctx, id));
  var before = JSON.stringify(eventRow(ctx, id));
  var claim = plain(ctx.sandbox.StripeEventRepository.claim(id, 'checkout.session.completed', NOW));
  assert.strictEqual(claim.outcome, 'ALREADY_TERMINAL');
  assert.strictEqual(JSON.stringify(eventRow(ctx, id)), before);
});

test('StripeEvents: 終端の行は再処理の対象にならず、finalizeForProcessingでも書き換わらない（updatedAtを終端日時に使える前提）', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var id = addEvent(ctx, { bookingId: bookingId });
  addEvent(ctx, { processingState: 'RECEIVED', rawBody: bodyOf({}) });
  enable(ctx);
  run(ctx);
  var pending = plain(ctx.sandbox.StripeEventRepository.listPendingWithBody());
  assert.strictEqual(pending.length, 1);
  assert.notStrictEqual(pending[0].record.eventId, id);

  var row = eventRow(ctx, id);
  var rowNumber = ctx.tables.StripeEvents._rows.indexOf(row) + 1;
  var before = JSON.stringify(row);
  var result = plain(ctx.sandbox.StripeEventRepository.finalizeForProcessing(rowNumber, 1, { processingState: 'COMPLETED' }, NOW));
  assert.deepStrictEqual(result, { written: false, reason: 'ALREADY_TERMINAL' });
  assert.strictEqual(JSON.stringify(eventRow(ctx, id)), before);
});

test('StripeEvents: 再実行は冪等で、2回目は何も書かない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  addEvent(ctx, { bookingId: bookingId });
  addEvent(ctx, { bookingId: bookingId });
  enable(ctx);
  assert.strictEqual(run(ctx).children.StripeEvents.erasedRows, 2);
  var writes = ctx.tables.StripeEvents._setValuesCalls.length;
  var second = run(ctx);
  assert.strictEqual(second.children.StripeEvents.erasedRows, 0);
  assert.strictEqual(second.children.StripeEvents.alreadyClear, 2);
  assert.strictEqual(ctx.tables.StripeEvents._setValuesCalls.length, writes);
});

test('StripeEvents: 本文が空でoutcomeMessageだけが残る予約IDつきの行も、outcomeMessageを消す', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var id = addEvent(ctx, { bookingId: bookingId, rawBody: '', outcomeMessage: '残ったメッセージ' });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.StripeEvents.cellsCleared, 1);
  assert.ok(erased(ctx, id));
});

test('StripeEvents: ロック取得後に未処理へ戻った行は、再判定で除外して消さない', function () {
  var mutate = null;
  var lockService = {
    getScriptLock: function () {
      return { tryLock: function () { if (mutate) { mutate(); mutate = null; } return true; }, releaseLock: function () {} };
    }
  };
  var ctx = setup({ lockService: lockService });
  var bookingId = addBooking(ctx);
  var raced = addEvent(ctx, { bookingId: bookingId });
  var other = addEvent(ctx, { bookingId: bookingId });
  enable(ctx);
  var calls = 0;
  var original = lockService.getScriptLock;
  lockService.getScriptLock = function () {
    var lock = original();
    var tryLock = lock.tryLock;
    lock.tryLock = function () {
      calls += 1;
      /* Bookingsは消去済みで対象なし。最初のバッチ（StripeEvents）のロック取得時に状態を変える。 */
      if (calls === 1) ctx.tables.StripeEvents._rows[1][col('processingState')] = 'RECEIVED';
      return tryLock();
    };
    return lock;
  };
  var result = run(ctx);
  assert.strictEqual(result.children.StripeEvents.erasedRows, 1);
  assert.strictEqual(result.children.StripeEvents.recheckSkipped, 1);
  assert.ok(!erased(ctx, raced));
  assert.ok(erased(ctx, other));
});

// ============================================================================
// 共通
// ============================================================================

test('dry-runはStripeEventsも無変更で、メール・氏名・イベントID・決済IDを出さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var id = addEvent(ctx, { bookingId: bookingId });
  var snapshot = JSON.stringify(ctx.tables.StripeEvents._rows);
  var result = plain(ctx.sandbox.dryRunPersonalDataRetention(NOW));
  assert.strictEqual(result.children.StripeEvents.eligible, 1);
  assert.strictEqual(JSON.stringify(ctx.tables.StripeEvents._rows), snapshot);
  assert.strictEqual(ctx.tables.StripeEvents._setValuesCalls.length, 0);
  var output = JSON.stringify(result) + ctx.logger._logs.join('\n');
  [EMAIL, NAME_IN_BODY, id, bookingId, 'pi_', 'PAY-'].forEach(function (secret) {
    assert.strictEqual(output.indexOf(secret), -1, secret);
  });
});

test('StripeEventsの必須列が欠ければ、何も消さず全体を停止する。シートが無ければ記録なし', function () {
  var ctx = setup();
  addBooking(ctx, { name: 'テスト太郎' });
  var sheet = ctx.book.insertSheet('StripeEvents');
  sheet.appendRow(['eventId', 'processingState']);
  var props = ctx.sandbox.PropertiesService.getScriptProperties();
  props.setProperty('PERSONAL_DATA_RETENTION_ENABLED', 'true');
  props.setProperty('PERSONAL_DATA_RETENTION_POLICY_VERSION', VERSION);
  props.setProperty('PERSONAL_DATA_RETENTION_DRY_RUN_VERSION', VERSION);
  var result = plain(ctx.sandbox.PersonalDataRetention.run(NOW));
  assert.strictEqual(result.status, 'SHEET_INVALID');
  assert.strictEqual(result.code, 'CHILD_SHEET_INVALID');
  assert.strictEqual(ctx.bookings._setValuesCalls.length, 0);

  var empty = setup();
  addBooking(empty, { name: 'テスト太郎', endAt: ago(RETENTION + DAY) });
  enable(empty);
  var ok = run(empty);
  assert.strictEqual(ok.status, 'OK');
  assert.strictEqual(ok.children.StripeEvents.scanned, 0);
});

test('eventIdが空・重複する行は要確認で消さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  addEvent(ctx, { eventId: '', bookingId: bookingId });
  addEvent(ctx, { eventId: 'evt_dup', bookingId: bookingId });
  addEvent(ctx, { eventId: 'evt_dup', bookingId: bookingId });
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.StripeEvents.review, { INVALID_KEY: 1, DUPLICATE_KEY: 2 });
  assert.strictEqual(result.children.StripeEvents.erasedRows, 0);
});
