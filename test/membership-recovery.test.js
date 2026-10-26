/*
 * 処理済み初回Subscription決済の初回Period復旧（Issue #537。MembershipRecovery.gs）のテスト。
 * Stripe API・Sheets・Calendarはすべてスタブ/fixtureで、本番Stripeへは一切アクセスしない。実在のIDは使わない。
 *
 * 前提の再現: PR #536 より前に入会が処理済みで、会員行はあるが初回Period（MemberPeriods）が無い状態を
 * MemberRepository.upsertMember で直接作る（StripeEvents には一切触れない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var BOOKING_ADMIN_FILES = require('./helpers/booking-deployment-manifest').BOOKING_ADMIN_FILES;

var SPREADSHEET_ID = 'ss1';
var SESSION_ID = 'cs_test_recover_0001';
var MEMBER_ID = 'MBR-test-recover-0001';
var CUSTOMER_ID = 'cus_test_recover_0001';
var SUBSCRIPTION_ID = 'sub_test_recover_0001';
var FIRST_INVOICE_ID = 'in_test_recover_first';
var MEMBER_EMAIL = 'taro@example.com';

function sec(iso) { return Math.floor(Date.parse(iso) / 1000); }
function plain(v) { return JSON.parse(JSON.stringify(v)); }
var JOIN_AT = '2026-10-26T22:40:00+09:00';
var RENEW_AT = '2026-11-26T22:40:00+09:00';
var NOW = '2026-11-01T10:00:00+09:00';

function invoice(overrides) {
  return Object.assign({
    id: FIRST_INVOICE_ID, object: 'invoice', billing_reason: 'subscription_create', status: 'paid',
    amount_paid: 500, currency: 'jpy', customer: CUSTOMER_ID,
    parent: { subscription_details: { subscription: SUBSCRIPTION_ID, metadata: { orderType: 'membership', memberId: MEMBER_ID } } },
    lines: { data: [{ amount: 500, period: { start: sec(JOIN_AT), end: sec(RENEW_AT) } }] },
    status_transitions: { paid_at: sec(JOIN_AT) + 5 }
  }, overrides || {});
}

function responder(state, calls) {
  return function (url) {
    calls.push(url);
    if (url.indexOf('/checkout/sessions/' + SESSION_ID) !== -1) {
      return { responseCode: 200, body: Object.assign({
        id: SESSION_ID, mode: 'subscription', status: 'complete', payment_status: 'paid', amount_total: 500, currency: 'jpy',
        customer: CUSTOMER_ID, customer_email: MEMBER_EMAIL, subscription: SUBSCRIPTION_ID, invoice: FIRST_INVOICE_ID,
        metadata: { orderType: 'membership', memberId: MEMBER_ID }
      }, state.session || {}) };
    }
    if (url.indexOf('/v1/subscriptions/' + SUBSCRIPTION_ID) !== -1) {
      return { responseCode: 200, body: Object.assign({
        id: SUBSCRIPTION_ID, status: 'active', customer: CUSTOMER_ID, latest_invoice: FIRST_INVOICE_ID,
        metadata: { orderType: 'membership', memberId: MEMBER_ID }
      }, state.subscription || {}) };
    }
    if (url.indexOf('/invoices/') !== -1) {
      var id = decodeURIComponent(url.split('/invoices/')[1]);
      if (state.invoiceNetworkFailure) return { thrown: new Error('network down') };
      if (state.noInvoice || id !== FIRST_INVOICE_ID) {
        return { responseCode: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such invoice' } } };
      }
      return { responseCode: 200, body: state.invoice || invoice() };
    }
    throw new Error('未対応のURL: ' + url);
  };
}

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var state = Object.assign({}, opts.state || {});
  var calls = [];
  var clock = stubs.createControllableClock(NOW);
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: SPREADSHEET_ID, STRIPE_SECRET_KEY: 'sk_test_dummy_value' }),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(responder(state, calls)),
    Utilities: stubs.createUtilitiesStub(),
    MailApp: stubs.createMailAppStub(),
    ContentService: stubs.createContentServiceStub(),
    Logger: stubs.createLoggerStub(),
    Date: clock.Date
  };
  var sandbox = loadBookingSandbox(BOOKING_ADMIN_FILES, globals);
  var ctx = { sandbox: sandbox, globals: globals, state: state, calls: calls, sheets: spreadsheetsById[SPREADSHEET_ID], clock: clock };
  if (opts.member !== false) {
    /* PR #536前に処理済み: 会員行はあるが、初回Periodが無い。 */
    sandbox.MemberRepository.upsertMember({ memberId: MEMBER_ID, customerId: CUSTOMER_ID }, {
      memberId: MEMBER_ID, email: MEMBER_EMAIL, customerId: CUSTOMER_ID, subscriptionId: SUBSCRIPTION_ID,
      state: { status: 'active', currentPeriodStart: new Date(sec(JOIN_AT) * 1000), currentPeriodEnd: new Date(sec(RENEW_AT) * 1000), cancelAtPeriodEnd: false }
    }, { id: 'evt_old_join', created: sec(JOIN_AT) }, { create: true }, clock.currentDate());
  }
  return ctx;
}

function rowsOf(ctx, name) { return ctx.sheets[name] ? ctx.sheets[name]._rows.slice(1) : []; }
function isMember(ctx, date) { return ctx.sandbox.MemberRepository.isMemberOnDate(MEMBER_EMAIL, date) === true; }
function recover(ctx, target) { return plain(ctx.sandbox.recoverInitialMembershipPeriod(target)); }

test('dry-run: 復旧可否だけ返し、MemberPeriodsへ書かない', function () {
  var ctx = setup();
  var r = recover(ctx, { checkoutSessionId: SESSION_ID });
  assert.strictEqual(r.code, 'DRY_RUN_RECOVERABLE');
  assert.strictEqual(r.executed, false);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 0);
  assert.strictEqual(isMember(ctx, '2026-11-01'), false);
});

test('execute: 初回Periodを1行記録し、資格が有効になる。StripeEventsには触れない', function () {
  var ctx = setup();
  var r = recover(ctx, { checkoutSessionId: SESSION_ID, execute: true });
  assert.strictEqual(r.code, 'RECOVERED');
  assert.strictEqual(r.recorded, true);
  assert.strictEqual(r.eligibleNow, true);
  var rows = rowsOf(ctx, 'MemberPeriods');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual([rows[0][0], rows[0][1], rows[0][4], rows[0][5], rows[0][6]], [MEMBER_ID, SUBSCRIPTION_ID, 'invoice', FIRST_INVOICE_ID, 500]);
  assert.deepStrictEqual([isMember(ctx, '2026-10-25'), isMember(ctx, '2026-10-26'), isMember(ctx, '2026-11-25'), isMember(ctx, '2026-11-26')], [false, true, true, false]);
  assert.strictEqual(ctx.sheets.StripeEvents, undefined, 'StripeEvents台帳を作成・変更しない');
  assert.strictEqual(rowsOf(ctx, 'MemberMonths').length, 0);
});

test('冪等: 2回実行してもPeriodは1行。通常処理で記録済みの対象にも影響しない', function () {
  var ctx = setup();
  recover(ctx, { checkoutSessionId: SESSION_ID, execute: true });
  var again = recover(ctx, { checkoutSessionId: SESSION_ID, execute: true });
  assert.strictEqual(again.code, 'ALREADY_RECORDED');
  assert.strictEqual(again.success, true);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);

  var normal = setup();
  normal.sandbox.MemberRepository.recordPeriod({
    memberId: MEMBER_ID, subscriptionId: SUBSCRIPTION_ID, periodStartSeconds: sec(JOIN_AT), periodEndSeconds: sec(RENEW_AT),
    sourceType: 'invoice', sourceId: FIRST_INVOICE_ID, amount: 500, eventId: 'evt_normal'
  }, normal.clock.currentDate());
  var r = recover(normal, { checkoutSessionId: SESSION_ID, execute: true });
  assert.strictEqual(r.code, 'ALREADY_RECORDED');
  assert.strictEqual(rowsOf(normal, 'MemberPeriods').length, 1);
  assert.strictEqual(rowsOf(normal, 'MemberPeriods')[0][8], 'evt_normal', '既存行を書き換えない');
});

test('Subscription ID指定でも、最新invoiceが初回invoiceなら復旧できる', function () {
  var ctx = setup();
  var r = recover(ctx, { subscriptionId: SUBSCRIPTION_ID, execute: true });
  assert.strictEqual(r.code, 'RECOVERED');
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
});

[
  ['未払い（status=open）', { invoice: invoice({ status: 'open' }) }, 'NOT_PAID'],
  ['金額不一致', { invoice: invoice({ amount_paid: 1000, lines: { data: [{ amount: 1000, period: { start: sec(JOIN_AT), end: sec(RENEW_AT) } }] } }) }, 'UNEXPECTED_AMOUNT'],
  ['通貨不一致', { invoice: invoice({ currency: 'usd' }) }, 'UNEXPECTED_AMOUNT'],
  ['別Subscriptionのinvoice', { invoice: invoice({ parent: { subscription_details: { subscription: 'sub_other', metadata: {} } } }) }, 'SUBSCRIPTION_MISMATCH'],
  ['更新invoice（subscription_cycle）', { invoice: invoice({ billing_reason: 'subscription_cycle' }) }, 'NOT_INITIAL_INVOICE'],
  ['Subscriptionがincomplete', { subscription: { status: 'incomplete' } }, 'SUBSCRIPTION_INCOMPLETE'],
  ['Subscriptionがincomplete_expired', { subscription: { status: 'incomplete_expired' } }, 'SUBSCRIPTION_INCOMPLETE'],
  ['期間が不正', { invoice: invoice({ lines: { data: [{ amount: 500, period: { start: sec(RENEW_AT), end: sec(JOIN_AT) } }] } }) }, null],
  ['存在しないinvoice', { noInvoice: true }, null]
].forEach(function (c) {
  test('未確認はPeriodを作らない: ' + c[0], function () {
    var ctx = setup({ state: c[1] });
    var r = recover(ctx, { checkoutSessionId: SESSION_ID, execute: true });
    assert.strictEqual(r.success, false);
    assert.ok(['INITIAL_PERIOD_NOT_CONFIRMED', 'STRIPE_OBJECT_NOT_FOUND'].indexOf(r.code) !== -1, r.code);
    if (c[2]) assert.strictEqual(r.reason, c[2]);
    assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 0);
    assert.strictEqual(isMember(ctx, '2026-11-01'), false);
  });
});

test('未確認はPeriodを作らない: Checkoutが未払い・金額不一致・別memberId・Stripe一時障害・会員行なし', function () {
  var cases = [
    [{ state: { session: { payment_status: 'unpaid' } } }, 'CHECKOUT_NOT_PAID'],
    [{ state: { session: { amount_total: 1000 } } }, 'CHECKOUT_AMOUNT_MISMATCH'],
    [{ state: { session: { mode: 'payment' } } }, 'NOT_MEMBERSHIP_SUBSCRIPTION_CHECKOUT'],
    [{ state: { subscription: { metadata: { orderType: 'membership', memberId: 'MBR-other' } } } }, 'SUBSCRIPTION_MISMATCH'],
    [{ state: { invoiceNetworkFailure: true } }, 'STRIPE_LOOKUP_FAILED'],
    [{ member: false }, 'MEMBER_NOT_FOUND']
  ];
  cases.forEach(function (c) {
    var ctx = setup(c[0]);
    var r = recover(ctx, { checkoutSessionId: SESSION_ID, execute: true });
    assert.strictEqual(r.code, c[1]);
    assert.strictEqual(r.success, false);
    assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 0, c[1]);
  });
});

test('会員行のSubscriptionが対象と異なるときは記録しない', function () {
  var ctx = setup({ state: { subscription: { id: SUBSCRIPTION_ID } } });
  /* 会員行側のSubscription IDを別の値にしておく（Membersの4列目）。 */
  ctx.sheets.Members._rows[1][3] = 'sub_other';
  var r = recover(ctx, { checkoutSessionId: SESSION_ID, execute: true });
  assert.strictEqual(r.code, 'MEMBER_SUBSCRIPTION_MISMATCH');
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 0);
});

test('全額返金済みは記録せず、資格を有効化しない', function () {
  var ctx = setup();
  ctx.sandbox.MemberRepository.recordRefundedSource({ sourceType: 'invoice', sourceId: FIRST_INVOICE_ID, memberId: MEMBER_ID, amount: 500, refundedAmount: 500 }, ctx.clock.currentDate());
  var r = recover(ctx, { checkoutSessionId: SESSION_ID, execute: true });
  assert.strictEqual(r.code, 'REFUNDED_NO_CHANGE');
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 0);
  assert.strictEqual(isMember(ctx, '2026-11-01'), false);
});

test('入力検証: どちらか一方のID・形式のみ受け付け、Stripeへ問い合わせない', function () {
  var ctx = setup();
  [undefined, {}, { checkoutSessionId: SESSION_ID, subscriptionId: SUBSCRIPTION_ID }, { checkoutSessionId: 'in_x' }, { subscriptionId: 'cs_x' }, { checkoutSessionId: 'cs_a/../b' }].forEach(function (t) {
    assert.strictEqual(recover(ctx, t).code, 'INVALID_TARGET');
  });
  assert.strictEqual(ctx.calls.length, 0);
});

test('execute以外の値（"true"文字列等）ではdry-runのまま', function () {
  var ctx = setup();
  var r = recover(ctx, { checkoutSessionId: SESSION_ID, execute: 'true' });
  assert.strictEqual(r.code, 'DRY_RUN_RECOVERABLE');
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 0);
});

test('ログ・戻り値に秘密情報・メール・完全なStripe IDを出さない', function () {
  var ctx = setup();
  var ok = recover(ctx, { checkoutSessionId: SESSION_ID, execute: true });
  var rejected = setup({ state: { invoice: invoice({ status: 'open' }) } });
  var ng = recover(rejected, { checkoutSessionId: SESSION_ID, execute: true });
  var text = JSON.stringify([ok, ng, ctx.globals.Logger._logs, rejected.globals.Logger._logs]);
  [SESSION_ID, CUSTOMER_ID, SUBSCRIPTION_ID, FIRST_INVOICE_ID, MEMBER_EMAIL, MEMBER_ID, 'sk_test_dummy_value'].forEach(function (secret) {
    assert.strictEqual(text.indexOf(secret), -1, secret + 'が出力に含まれる');
  });
  assert.ok(ok.plan.invoice.indexOf('…') !== -1);
  assert.ok(ctx.globals.Logger._logs.length > 0, 'ログ自体は出ている');
});

test('adminRecoverInitialMembershipPeriod: 管理者認証できなければ実行しない', function () {
  var ctx = setup();
  ctx.sandbox.Session = { getActiveUser: function () { return { getEmail: function () { return ''; } }; } };
  var r = plain(ctx.sandbox.adminRecoverInitialMembershipPeriod({ checkoutSessionId: SESSION_ID, execute: true }));
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error.code, 'FORBIDDEN');
  assert.strictEqual(ctx.calls.length, 0);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 0);
});
