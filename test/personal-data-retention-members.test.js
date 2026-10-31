/*
 * オプション注文・会員系シートの個人情報の180日経過後消去（Issue #680 PR-3。admin/PersonalDataRetention.gs）の
 * テスト。Sheets・Lock・Propertiesはすべてスタブで、本番へは一切アクセスしない。実際に配布するBooking Adminの
 * ファイルセットだけをvmへ読み込む。
 *
 * - OptionOrders: 顧客メール・不承認理由・Checkout要求・復旧理由。終端日時はapprovedAt/declinedAt/paidAtの最も遅い日時
 * - MemberStatusTokens: 有効期限の経過後180日でメールとハッシュ（ハッシュは最後に消す）
 * - MemberCheckouts: EXPIRED／放棄されたPENDINGはpendingUntil、COMPLETEDは会員の終了から180日
 * - Members: 退会かつ、退会日時・期間終了・支払済みPeriod・旧MemberMonthsの最も遅い日時から180日。将来予約があれば消さない
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
var VERSION = '2026-10-31.3';

var EMAIL = 'pii-member@example.com';

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function ago(ms) { return new Date(NOW.getTime() - ms); }

var OPTION_HEADERS = ['optionOrderId', 'bookingId', 'brand', 'category', 'source', 'itemsJson', 'amountJpy', 'currency', 'approvalStatus', 'paymentStatus', 'status', 'customerEmail', 'createdAt', 'updatedAt', 'approvedAt', 'declinedAt', 'declineReason', 'paymentAttemptId', 'checkoutRequestJson', 'stripeCheckoutSessionId', 'stripePaymentIntentId', 'stripeAmount', 'stripeCurrency', 'paidAt', 'lastStripeEventId', 'decisionMailSentAt', 'confirmedMailSentAt', 'paymentRecoveryRequiredAt', 'paymentRecoveryReason'];
var TOKEN_HEADERS = ['tokenHash', 'email', 'expiresAt', 'usedAt', 'createdAt'];
var MEMBER_HEADERS = ['memberId', 'email', 'stripeCustomerId', 'stripeSubscriptionId', 'status', 'currentPeriodStart', 'currentPeriodEnd', 'canceledAt', 'cancelAtPeriodEnd', 'latestInvoiceId', 'latestEventId', 'latestEventCreated', 'createdAt', 'updatedAt'];
var CHECKOUT_HEADERS = ['memberId', 'email', 'checkoutSessionId', 'pendingUntil', 'state', 'createdAt', 'updatedAt'];
var PERIOD_HEADERS = ['memberId', 'subscriptionId', 'periodStart', 'periodEnd', 'sourceType', 'sourceId', 'amount', 'paidAt', 'eventId', 'recordedAt'];
var MONTH_HEADERS = ['memberId', 'month', 'sourceType', 'sourceId', 'amount', 'paidAt', 'eventId', 'recordedAt'];

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

var optSeq = 0;
function addOption(ctx, bookingId, overrides) {
  optSeq += 1;
  var values = Object.assign({
    optionOrderId: 'OPT-' + optSeq, bookingId: bookingId, status: 'CONFIRMED', customerEmail: EMAIL, createdAt: ago(RETENTION + 40 * DAY),
    paidAt: ago(RETENTION + 35 * DAY), approvedAt: ago(RETENTION + 36 * DAY), declineReason: '不承認の理由メモ',
    checkoutRequestJson: '{"amountJpy":1000,"successUrl":"https://example.com/ok"}', paymentRecoveryReason: '復旧理由メモ',
    itemsJson: '["EQ:COB:1"]', amountJpy: 1000, stripeAmount: 1000, stripeCurrency: 'jpy', paymentStatus: 'paid'
  }, overrides || {});
  append(ctx, 'OptionOrders', OPTION_HEADERS, values);
  return values.optionOrderId;
}

var tokSeq = 0;
function addToken(ctx, overrides) {
  tokSeq += 1;
  var values = Object.assign({
    tokenHash: 'hash-' + tokSeq, email: EMAIL, expiresAt: ago(RETENTION + DAY), usedAt: '', createdAt: ago(RETENTION + 2 * DAY)
  }, overrides || {});
  append(ctx, 'MemberStatusTokens', TOKEN_HEADERS, values);
  return values.tokenHash;
}

var memSeq = 0;
function addMember(ctx, overrides) {
  memSeq += 1;
  var values = Object.assign({
    memberId: 'mem-' + memSeq, email: EMAIL, stripeCustomerId: 'cus_' + memSeq, stripeSubscriptionId: 'sub_' + memSeq, status: 'canceled',
    currentPeriodStart: ago(RETENTION + 90 * DAY), currentPeriodEnd: ago(RETENTION + 60 * DAY), canceledAt: ago(RETENTION + 61 * DAY),
    latestInvoiceId: 'in_' + memSeq, createdAt: ago(RETENTION + 200 * DAY), updatedAt: ago(RETENTION + 61 * DAY)
  }, overrides || {});
  append(ctx, 'Members', MEMBER_HEADERS, values);
  return values;
}

function addPeriod(ctx, memberId, subscriptionId, periodEnd) {
  return append(ctx, 'MemberPeriods', PERIOD_HEADERS, { memberId: memberId, subscriptionId: subscriptionId, periodEnd: periodEnd, sourceType: 'invoice', sourceId: 'in_' + Math.random() });
}

function addMonth(ctx, memberId, month) {
  return append(ctx, 'MemberMonths', MONTH_HEADERS, { memberId: memberId, month: month, sourceType: 'invoice', sourceId: 'in_m' });
}

function addCheckout(ctx, memberId, overrides) {
  return append(ctx, 'MemberCheckouts', CHECKOUT_HEADERS, Object.assign({
    memberId: memberId, email: EMAIL, checkoutSessionId: 'cs_' + Math.random(), pendingUntil: ago(RETENTION + 10 * DAY), state: 'EXPIRED',
    createdAt: ago(RETENTION + 11 * DAY), updatedAt: ago(RETENTION + 10 * DAY)
  }, overrides || {}));
}

function col(headers, name) { return headers.indexOf(name); }
function find(ctx, name, headers, keyColumn, key) {
  var sheet = ctx.tables[name];
  for (var i = 1; i < sheet._rows.length; i++) if (sheet._rows[i][col(headers, keyColumn)] === key) return sheet._rows[i];
  throw new Error('row not found: ' + key);
}
function value(ctx, name, headers, keyColumn, key, column) {
  return find(ctx, name, headers, keyColumn, key)[col(headers, column)];
}

function enable(ctx) {
  ctx.sandbox.dryRunPersonalDataRetention(NOW);
  ctx.sandbox.enablePersonalDataRetention();
}

function run(ctx, now, options) {
  return plain(ctx.sandbox.purgeExpiredPersonalData(now || NOW, options));
}

// ============================================================================
// OptionOrders
// ============================================================================

test('OptionOrders: 確定済みの注文の顧客メール・不承認理由・Checkout要求・復旧理由だけを消し、金額・状態・日時は残す', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var id = addOption(ctx, bookingId);
  var before = find(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', id).slice();
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.status, 'OK');
  assert.strictEqual(result.children.OptionOrders.erasedRows, 1);
  assert.strictEqual(result.children.OptionOrders.cellsCleared, 4);
  var after = find(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', id);
  var erased = ['customerEmail', 'declineReason', 'checkoutRequestJson', 'paymentRecoveryReason'];
  OPTION_HEADERS.forEach(function (column, c) {
    if (erased.indexOf(column) !== -1) assert.strictEqual(after[c], '', column);
    else assert.strictEqual(String(after[c]), String(before[c]), column + 'が変更されている');
  });
});

test('OptionOrders: 終端日時はapprovedAt・declinedAt・paidAtの最も遅い日時。作成時に確定した無料注文は作成日時', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx, { endAt: ago(RETENTION + 200 * DAY) });
  var recentPaid = addOption(ctx, bookingId, { paidAt: ago(10 * DAY) });
  var declined = addOption(ctx, bookingId, { status: 'DECLINED', approvedAt: '', paidAt: '', declinedAt: ago(RETENTION + 20 * DAY) });
  var freeOld = addOption(ctx, bookingId, { approvedAt: '', paidAt: '', createdAt: ago(RETENTION + 20 * DAY) });
  var freeRecent = addOption(ctx, bookingId, { approvedAt: '', paidAt: '', createdAt: ago(5 * DAY) });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.OptionOrders.erasedRows, 2);
  assert.strictEqual(result.children.OptionOrders.notDue, 2);
  assert.strictEqual(value(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', declined, 'customerEmail'), '');
  assert.strictEqual(value(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', freeOld, 'customerEmail'), '');
  assert.strictEqual(value(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', recentPaid, 'customerEmail'), EMAIL);
  assert.strictEqual(value(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', freeRecent, 'customerEmail'), EMAIL);
});

test('OptionOrders: 未完了・復旧要・CANCELLED・状態不明・日時不正・DECLINEDで日時なしは消さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var other = addBooking(ctx);
  var statuses = ['PENDING_APPROVAL', 'AWAITING_PAYMENT', 'PAYMENT_PENDING'].map(function (state) {
    return addOption(ctx, bookingId, { status: state });
  });
  var recovery = addOption(ctx, other, { paymentRecoveryRequiredAt: ago(DAY) });
  var cancelled = addOption(ctx, bookingId, { status: 'CANCELLED' });
  var unknown = addOption(ctx, bookingId, { status: 'WEIRD' });
  var badDate = addOption(ctx, bookingId, { paidAt: '2026-02-30T00:00:00Z' });
  var declinedNoDate = addOption(ctx, bookingId, { status: 'DECLINED', approvedAt: '', paidAt: '', declinedAt: '' });
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.OptionOrders;
  assert.strictEqual(counts.erasedRows, 0);
  assert.deepStrictEqual(counts.review, { OWN_DATE_MISSING: 2, ORDER_STATUS_UNKNOWN: 1, OWN_DATE_INVALID: 1 });
  statuses.concat([recovery, cancelled, unknown, badDate, declinedNoDate]).forEach(function (id) {
    assert.strictEqual(value(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', id, 'customerEmail'), EMAIL, id);
  });
});

test('OptionOrders: 親が未終了・保留中・紐付けなしなら消さない', function () {
  var ctx = setup();
  var pending = addBooking(ctx, { status: 'PENDING' });
  var unpaid = addBooking(ctx, { paymentStatus: 'checkout_pending' });
  [pending, unpaid, '', 'snb-missing'].forEach(function (id) { addOption(ctx, id); });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.OptionOrders.erasedRows, 0);
  assert.deepStrictEqual(result.children.OptionOrders.held, { PARENT_NOT_ENDED: 1, PAYMENT_UNRESOLVED: 1 });
  assert.deepStrictEqual(result.children.OptionOrders.review, { NO_BOOKING_LINK: 1, PARENT_NOT_FOUND: 1 });
});

// ============================================================================
// MemberStatusTokens
// ============================================================================

test('MemberStatusTokens: 有効期限から180日ちょうどでメールとハッシュを消し、境界の1ミリ秒前は消さない', function () {
  var ctx = setup();
  addToken(ctx, { expiresAt: new Date(NOW.getTime() - RETENTION) });
  var justBefore = addToken(ctx, { expiresAt: new Date(NOW.getTime() - RETENTION + 1) });
  var notExpired = addToken(ctx, { expiresAt: new Date(NOW.getTime() + DAY) });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.MemberStatusTokens.erasedRows, 1);
  assert.strictEqual(result.children.MemberStatusTokens.notDue, 2);
  var sheet = ctx.tables.MemberStatusTokens;
  assert.deepStrictEqual(sheet._rows[1].slice(0, 2), ['', '']);
  assert.strictEqual(find(ctx, 'MemberStatusTokens', TOKEN_HEADERS, 'tokenHash', justBefore)[1], EMAIL);
  assert.strictEqual(find(ctx, 'MemberStatusTokens', TOKEN_HEADERS, 'tokenHash', notExpired)[1], EMAIL);
});

test('MemberStatusTokens: 識別子のハッシュは最後に消す。途中失敗しても次回の実行で同じ行を完了できる', function () {
  var ctx = setup();
  var hash = addToken(ctx);
  enable(ctx);
  var sheet = ctx.tables.MemberStatusTokens;
  var original = sheet.getRange;
  var writes = 0;
  sheet.getRange = function () {
    var range = original.apply(sheet, arguments);
    var setValue = range.setValue;
    range.setValue = function (v) {
      writes++;
      if (writes === 2) throw new Error('書き込み失敗');
      return setValue.call(range, v);
    };
    return range;
  };
  assert.throws(function () { ctx.sandbox.purgeExpiredPersonalData(NOW); }, /PARTIAL_FAILURE/);
  assert.strictEqual(sheet._rows[1][col(TOKEN_HEADERS, 'email')], '');
  assert.strictEqual(sheet._rows[1][col(TOKEN_HEADERS, 'tokenHash')], hash);
  sheet.getRange = original;
  var retry = run(ctx);
  assert.strictEqual(retry.status, 'OK');
  assert.deepStrictEqual(sheet._rows[1].slice(0, 2), ['', '']);
  assert.deepStrictEqual(sheet._setValuesCalls.map(function (c) { return c.col; }), [col(TOKEN_HEADERS, 'email') + 1, col(TOKEN_HEADERS, 'tokenHash') + 1]);
});

test('MemberStatusTokens: 消去済みの行は要確認にならず、有効期限が空・不正・重複は消さない', function () {
  var ctx = setup();
  addToken(ctx, { tokenHash: '', email: '' });
  var missing = addToken(ctx, { expiresAt: '' });
  var invalid = addToken(ctx, { expiresAt: 'broken' });
  addToken(ctx, { tokenHash: 'dup' });
  addToken(ctx, { tokenHash: 'dup' });
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.MemberStatusTokens;
  assert.strictEqual(counts.alreadyClear, 1);
  assert.deepStrictEqual(counts.review, { BASIS_MISSING: 1, BASIS_INVALID: 1, DUPLICATE_KEY: 2 });
  assert.strictEqual(counts.erasedRows, 0);
  assert.strictEqual(find(ctx, 'MemberStatusTokens', TOKEN_HEADERS, 'tokenHash', missing)[1], EMAIL);
  assert.strictEqual(find(ctx, 'MemberStatusTokens', TOKEN_HEADERS, 'tokenHash', invalid)[1], EMAIL);
});

// ============================================================================
// Members
// ============================================================================

test('Members: 退会から180日経過した会員のメールだけを消し、Stripe ID・状態・期間は残す', function () {
  var ctx = setup();
  var member = addMember(ctx);
  var before = find(ctx, 'Members', MEMBER_HEADERS, 'memberId', member.memberId).slice();
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.Members.erasedRows, 1);
  var after = find(ctx, 'Members', MEMBER_HEADERS, 'memberId', member.memberId);
  MEMBER_HEADERS.forEach(function (column, c) {
    if (column === 'email') assert.strictEqual(after[c], '');
    else assert.strictEqual(String(after[c]), String(before[c]), column);
  });
  assert.deepStrictEqual(plain(ctx.tables.Members._setValuesCalls).map(function (c) { return c.col; }), [col(MEMBER_HEADERS, 'email') + 1]);
});

test('Members: 有効・支払い遅延・未完了は消さず、状態不明と退会日時の欠落・不正は要確認', function () {
  var ctx = setup();
  ['active', 'past_due', 'incomplete'].forEach(function (status) { addMember(ctx, { status: status }); });
  addMember(ctx, { status: 'weird' });
  addMember(ctx, { canceledAt: '' });
  addMember(ctx, { canceledAt: '2026-02-30T00:00:00Z' });
  addMember(ctx, { currentPeriodEnd: 'broken' });
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.Members;
  assert.strictEqual(counts.erasedRows, 0);
  assert.deepStrictEqual(counts.held, { MEMBER_NOT_ENDED: 3 });
  assert.deepStrictEqual(counts.review, { MEMBER_STATUS_UNKNOWN: 1, MEMBER_CANCELED_AT_INVALID: 2, MEMBER_PERIOD_INVALID: 1 });
});

test('Members: 資格の最終終了は退会日時・期間終了・支払済みPeriod（会員ID／Subscription ID）・旧MemberMonths（JSTの月末）の最も遅い日時', function () {
  var ctx = setup();
  var base = addMember(ctx);
  var byPeriodMember = addMember(ctx);
  var byPeriodSubscription = addMember(ctx);
  var byMonth = addMember(ctx);
  var byCurrentPeriod = addMember(ctx, { currentPeriodEnd: ago(10 * DAY) });
  addPeriod(ctx, byPeriodMember.memberId, '', ago(10 * DAY));
  addPeriod(ctx, '', byPeriodSubscription.stripeSubscriptionId, ago(10 * DAY));
  addMonth(ctx, byMonth.memberId, 202612);
  addPeriod(ctx, base.memberId, base.stripeSubscriptionId, ago(RETENTION + 61 * DAY));
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.Members.erasedRows, 1);
  assert.strictEqual(result.children.Members.notDue, 4);
  assert.strictEqual(value(ctx, 'Members', MEMBER_HEADERS, 'memberId', base.memberId, 'email'), '');
  [byPeriodMember, byPeriodSubscription, byMonth, byCurrentPeriod].forEach(function (m) {
    assert.strictEqual(value(ctx, 'Members', MEMBER_HEADERS, 'memberId', m.memberId, 'email'), EMAIL, m.memberId);
  });
});

test('Members: 旧MemberMonthsの月はJSTの月末（翌月1日0時）から180日', function () {
  var ctx = setup();
  var member = addMember(ctx, { canceledAt: ago(RETENTION + 400 * DAY), currentPeriodEnd: '' });
  addMonth(ctx, member.memberId, 202606);
  var monthEnd = Date.UTC(2026, 6, 1) - 9 * 60 * 60 * 1000;
  enable(ctx);
  assert.strictEqual(run(ctx, new Date(monthEnd + RETENTION - 1)).children.Members.erasedRows, 0);
  assert.strictEqual(run(ctx, new Date(monthEnd + RETENTION)).children.Members.erasedRows, 1);
});

test('Members: Periodの終了日時やMemberMonthsの月が不正なら要確認で、消さない', function () {
  var ctx = setup();
  var badPeriod = addMember(ctx);
  var badMonth = addMember(ctx);
  addPeriod(ctx, badPeriod.memberId, '', 'broken');
  addMonth(ctx, badMonth.memberId, 202613);
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.Members.review, { MEMBER_PERIOD_INVALID: 1, MEMBER_MONTH_INVALID: 1 });
  assert.strictEqual(result.children.Members.erasedRows, 0);
});

test('Members: 同じメールの将来予約・未終了の予約があれば消さず、終了済みの予約だけなら消す（メールは大小文字を区別しない）', function () {
  var ctx = setup();
  var withFuture = addMember(ctx, { email: 'future@example.com' });
  var withPending = addMember(ctx, { email: 'pending@example.com' });
  var withBroken = addMember(ctx, { email: 'broken@example.com' });
  var withPast = addMember(ctx, { email: 'past@example.com' });
  addBooking(ctx, { email: 'FUTURE@example.com', endAt: new Date(NOW.getTime() + 5 * DAY) });
  addBooking(ctx, { email: 'pending@example.com', status: 'PENDING', endAt: '' });
  addBooking(ctx, { email: 'broken@example.com', endAt: 'broken' });
  addBooking(ctx, { email: 'past@example.com', endAt: ago(RETENTION + 100 * DAY) });
  addBooking(ctx, { email: 'past@example.com', status: 'CANCELLED', cancelledAt: ago(RETENTION + 100 * DAY) });
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.Members.held, { ACTIVE_BOOKING_EXISTS: 3 });
  assert.strictEqual(result.children.Members.erasedRows, 1);
  assert.strictEqual(value(ctx, 'Members', MEMBER_HEADERS, 'memberId', withPast.memberId, 'email'), '');
  [withFuture, withPending, withBroken].forEach(function (m) {
    assert.notStrictEqual(value(ctx, 'Members', MEMBER_HEADERS, 'memberId', m.memberId, 'email'), '');
  });
});

test('Members: 会員IDが重複・空欄の行は要確認で、消去済みの行は何も起きない', function () {
  var ctx = setup();
  addMember(ctx, { memberId: 'dup' });
  addMember(ctx, { memberId: 'dup' });
  addMember(ctx, { memberId: '' });
  addMember(ctx, { email: '' });
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.Members.review, { DUPLICATE_KEY: 2, INVALID_KEY: 1 });
  assert.strictEqual(result.children.Members.alreadyClear, 1);
  assert.strictEqual(result.children.Members.erasedRows, 0);
});

test('Members: 消去後にStripeイベントの再処理でメールが補完されない（canceledは終端）', function () {
  var ctx = setup();
  var member = addMember(ctx);
  enable(ctx);
  run(ctx);
  assert.strictEqual(value(ctx, 'Members', MEMBER_HEADERS, 'memberId', member.memberId, 'email'), '');

  var repo = ctx.sandbox.MemberRepository;
  var result = plain(repo.upsertMember(
    { memberId: member.memberId },
    { subscriptionId: member.stripeSubscriptionId, customerId: member.stripeCustomerId, state: { status: 'active', email: EMAIL, currentPeriodEnd: new Date(NOW) } },
    { id: 'evt_replay', created: Math.floor(NOW.getTime() / 1000) + 100000 },
    { create: false },
    NOW
  ));
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.stateApplied, false);
  assert.strictEqual(value(ctx, 'Members', MEMBER_HEADERS, 'memberId', member.memberId, 'email'), '');
});

// ============================================================================
// MemberCheckouts
// ============================================================================

test('MemberCheckouts: EXPIREDはpendingUntilから180日でメールを消し、他の列は残す', function () {
  var ctx = setup();
  addCheckout(ctx, 'mem-x1');
  addCheckout(ctx, 'mem-x2', { pendingUntil: ago(10 * DAY) });
  var before = ctx.tables.MemberCheckouts._rows[1].slice();
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.children.MemberCheckouts.erasedRows, 1);
  assert.strictEqual(result.children.MemberCheckouts.notDue, 1);
  var after = ctx.tables.MemberCheckouts._rows[1];
  CHECKOUT_HEADERS.forEach(function (column, c) {
    if (column === 'email') assert.strictEqual(after[c], '');
    else assert.strictEqual(String(after[c]), String(before[c]), column);
  });
  assert.strictEqual(ctx.tables.MemberCheckouts._rows[2][1], EMAIL);
});

test('MemberCheckouts: PENDINGは、有効期限内は保留、期限後で会員行がなければ放棄としてpendingUntilから180日、会員行があれば会員の終了から180日', function () {
  var ctx = setup();
  var active = addMember(ctx, { status: 'active', canceledAt: '' });
  var ended = addMember(ctx);
  addCheckout(ctx, 'mem-future', { state: 'PENDING', pendingUntil: new Date(NOW.getTime() + 60 * 1000) });
  addCheckout(ctx, 'mem-abandoned', { state: 'PENDING' });
  addCheckout(ctx, active.memberId, { state: 'PENDING' });
  addCheckout(ctx, ended.memberId, { state: 'PENDING' });
  addCheckout(ctx, 'mem-invalid', { state: 'PENDING', pendingUntil: 'broken' });
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.MemberCheckouts;
  assert.deepStrictEqual(counts.held, { CHECKOUT_PENDING: 1, MEMBER_NOT_ENDED: 1 });
  assert.deepStrictEqual(counts.review, { BASIS_INVALID: 1 });
  assert.strictEqual(counts.erasedRows, 2);
  var rows = ctx.tables.MemberCheckouts._rows;
  assert.strictEqual(rows[1][1], EMAIL);
  assert.strictEqual(rows[2][1], '');
  assert.strictEqual(rows[3][1], EMAIL);
  assert.strictEqual(rows[4][1], '');
  assert.strictEqual(rows[5][1], EMAIL);
});

test('MemberCheckouts: COMPLETEDは会員の終了から180日。会員行がなければ要確認、会員が有効なら保留', function () {
  var ctx = setup();
  var ended = addMember(ctx);
  var recentEnd = addMember(ctx, { canceledAt: ago(10 * DAY), currentPeriodEnd: ago(10 * DAY) });
  var active = addMember(ctx, { status: 'active', canceledAt: '' });
  addCheckout(ctx, ended.memberId, { state: 'COMPLETED' });
  addCheckout(ctx, recentEnd.memberId, { state: 'COMPLETED' });
  addCheckout(ctx, active.memberId, { state: 'COMPLETED' });
  addCheckout(ctx, 'mem-missing', { state: 'COMPLETED' });
  addCheckout(ctx, 'mem-unknown', { state: 'WEIRD' });
  enable(ctx);
  var result = run(ctx);
  var counts = result.children.MemberCheckouts;
  assert.strictEqual(counts.erasedRows, 1);
  assert.strictEqual(counts.notDue, 1);
  assert.deepStrictEqual(counts.held, { MEMBER_NOT_ENDED: 1 });
  assert.deepStrictEqual(counts.review, { MEMBER_NOT_FOUND: 1, CHECKOUT_STATE_UNKNOWN: 1 });
  assert.strictEqual(ctx.tables.MemberCheckouts._rows[1][1], '');
});

test('MemberCheckouts: 会員が重複していれば要確認で消さない', function () {
  var ctx = setup();
  addMember(ctx, { memberId: 'mem-dup' });
  addMember(ctx, { memberId: 'mem-dup' });
  addCheckout(ctx, 'mem-dup', { state: 'COMPLETED' });
  enable(ctx);
  var result = run(ctx);
  assert.deepStrictEqual(result.children.MemberCheckouts.review, { MEMBER_AMBIGUOUS: 1 });
  assert.strictEqual(ctx.tables.MemberCheckouts._rows[1][1], EMAIL);
});

// ============================================================================
// 共通
// ============================================================================

test('会員系・オプション注文の書き込みはすべて1セルで、対象列以外へは書かない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  addOption(ctx, bookingId);
  addToken(ctx);
  var member = addMember(ctx);
  addCheckout(ctx, member.memberId, { state: 'COMPLETED' });
  enable(ctx);
  run(ctx);
  var allowed = {
    OptionOrders: ['customerEmail', 'declineReason', 'checkoutRequestJson', 'paymentRecoveryReason'],
    MemberStatusTokens: ['email', 'tokenHash'], Members: ['email'], MemberCheckouts: ['email']
  };
  var headers = { OptionOrders: OPTION_HEADERS, MemberStatusTokens: TOKEN_HEADERS, Members: MEMBER_HEADERS, MemberCheckouts: CHECKOUT_HEADERS };
  Object.keys(allowed).forEach(function (name) {
    var calls = ctx.tables[name]._setValuesCalls;
    assert.ok(calls.length > 0, name);
    calls.forEach(function (call) {
      assert.strictEqual(call.numRows, 1);
      assert.strictEqual(call.numCols, 1);
      assert.ok(allowed[name].indexOf(headers[name][call.col - 1]) !== -1, name + '.' + headers[name][call.col - 1]);
    });
  });
});

test('dry-runは会員系・オプション注文も無変更で、メール・ID・トークンのハッシュを出さない', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  var optionId = addOption(ctx, bookingId);
  var hash = addToken(ctx);
  var member = addMember(ctx);
  addCheckout(ctx, member.memberId, { state: 'COMPLETED' });
  var snapshot = JSON.stringify(Object.keys(ctx.tables).map(function (n) { return ctx.tables[n]._rows; }));
  var result = plain(ctx.sandbox.dryRunPersonalDataRetention(NOW));
  assert.strictEqual(result.status, 'DRY_RUN');
  assert.strictEqual(result.children.OptionOrders.eligible, 1);
  assert.strictEqual(result.children.MemberStatusTokens.eligible, 1);
  assert.strictEqual(result.children.Members.eligible, 1);
  assert.strictEqual(result.children.MemberCheckouts.eligible, 1);
  assert.strictEqual(JSON.stringify(Object.keys(ctx.tables).map(function (n) { return ctx.tables[n]._rows; })), snapshot);
  Object.keys(ctx.tables).forEach(function (n) { assert.strictEqual(ctx.tables[n]._setValuesCalls.length, 0, n); });
  var output = JSON.stringify(result) + ctx.logger._logs.join('\n');
  [EMAIL, hash, optionId, member.memberId, member.stripeSubscriptionId, bookingId].forEach(function (secret) {
    assert.strictEqual(output.indexOf(secret), -1, secret);
  });
});

test('会員系の参照シート（MemberPeriods / MemberMonths）や対象シートの必須列が欠ければ、何も消さず全体を停止する', function () {
  [['MemberPeriods', ['memberId', 'subscriptionId']], ['MemberMonths', ['memberId']], ['Members', ['memberId', 'email']],
    ['MemberCheckouts', ['memberId', 'email']], ['MemberStatusTokens', ['tokenHash']], ['OptionOrders', ['optionOrderId', 'bookingId']]
  ].forEach(function (c) {
    var ctx = setup();
    var bookingId = addBooking(ctx, { name: 'テスト太郎' });
    var sheet = ctx.book.insertSheet(c[0]);
    sheet.appendRow(c[1]);
    var props = ctx.sandbox.PropertiesService.getScriptProperties();
    props.setProperty('PERSONAL_DATA_RETENTION_ENABLED', 'true');
    props.setProperty('PERSONAL_DATA_RETENTION_POLICY_VERSION', VERSION);
    props.setProperty('PERSONAL_DATA_RETENTION_DRY_RUN_VERSION', VERSION);
    var result = plain(ctx.sandbox.PersonalDataRetention.run(NOW));
    assert.strictEqual(result.status, 'SHEET_INVALID', c[0]);
    assert.ok(['MEMBER_SHEET_INVALID', 'CHILD_SHEET_INVALID', 'RELATED_SHEET_INVALID'].indexOf(result.code) !== -1, c[0] + ':' + result.code);
    assert.strictEqual(ctx.bookings._setValuesCalls.length, 0);
    assert.ok(bookingId);
  });
});

test('これらのシートが存在しなくても、Bookingsだけ処理する', function () {
  var ctx = setup();
  addBooking(ctx, { name: 'テスト太郎', endAt: ago(RETENTION + DAY) });
  enable(ctx);
  var result = run(ctx);
  assert.strictEqual(result.status, 'OK');
  assert.strictEqual(result.erasedRows, 1);
  assert.strictEqual(result.children.Members.scanned, 0);
});

test('上限は全シート合計で適用され、Members系は子シートの後に持ち越す', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx, { name: 'テスト太郎' });
  addOption(ctx, bookingId);
  addToken(ctx);
  enable(ctx);
  var first = run(ctx, NOW, { maxRows: 2 });
  assert.strictEqual(first.status, 'TRUNCATED');
  assert.strictEqual(first.erasedRows, 1);
  assert.strictEqual(first.children.OptionOrders.erasedRows, 1);
  assert.strictEqual(first.children.MemberStatusTokens.erasedRows, 0);
  var second = run(ctx);
  assert.strictEqual(second.status, 'OK');
  assert.strictEqual(second.children.MemberStatusTokens.erasedRows, 1);
});
