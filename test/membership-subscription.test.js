/*
 * SNB MEMBER 入会日基準の月額Subscription（Issue #532）のテスト。Stripe API・Sheets・Calendarはすべてスタブ/fixtureで、
 * 本番Stripeへは一切アクセスしない。実在のID・Price・Productは使わない。
 *
 * 対応する受入条件・追加テスト（Issue #532 §13 / §14）:
 *  - invoice.paid と checkout.session.completed の到着順に依存しない（両順序）
 *  - 初回・更新の支払済み期間をMemberPeriodsへ記録、MemberMonthsへは追記しない
 *  - 有効日の境界（入会日〜更新日の前日・JST）、1/31入会・2月末・3月、2/29を含む年
 *  - 更新完了前は未来Periodを会員扱いしない
 *  - 旧MemberMonths・永久会員との合算、プレスタート会員の12/1更新
 *  - 更新invoiceの全額返金 / 一部返金
 *  - status表示（新規・プレスタート・解約予約済み）
 *  - 二重加入（受付時・Webhookで判明）
 *  - MEMBERSHIP_JOIN_PAUSED
 *  - 60〜90日先の先行予約は作れるが、利用日が未決済の期間なら一般料金
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var membershipLookupResponse = require('./helpers/stripe-membership-mock').membershipLookupResponse;

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'CardPayment.gs',
  'JapaneseHolidays.gs', 'BookingPricing.gs', 'BookingWindow.gs', 'RateLimiter.gs', 'StripeGateway.gs',
  'StripeEventRepository.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'MembershipService.gs',
  'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'AdminNotifier.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'BookingRepository.gs',
  'StripeWebhookProcessor.gs', 'BookingAdminAlerts.gs', 'Code.gs'
];

var SPREADSHEET_ID = 'ss1';
var SESSION_ID = 'cs_test_sub_0001';
var MEMBER_ID = 'MBR-test-0001';
var CUSTOMER_ID = 'cus_test_0001';
var SUBSCRIPTION_ID = 'sub_test_0001';
var FIRST_INVOICE_ID = 'in_test_first';
var MEMBER_EMAIL = 'taro@example.com';

function sec(iso) { return Math.floor(Date.parse(iso) / 1000); }
function plain(v) { return JSON.parse(JSON.stringify(v)); }
function oneMonthLater(iso) {
  var d = new Date(Date.parse(iso));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

/* 10/26 22:40 JST 入会 → 有効日 10/26〜11/25、11/26 22:40 JST に更新。 */
var JOIN_AT = '2026-10-26T22:40:00+09:00';
var RENEW1_AT = '2026-11-26T22:40:00+09:00';
var RENEW2_AT = '2026-12-26T22:40:00+09:00';

function makeStripeResponder(state, calls) {
  return function (url, options) {
    var method = String((options && options.method) || 'get').toLowerCase();
    calls.push({ url: url, options: options });
    if (url.indexOf('/checkout/sessions/' + SESSION_ID) !== -1) {
      return { responseCode: 200, body: state.session || {
        id: SESSION_ID, mode: 'subscription', status: 'complete', payment_status: 'paid',
        amount_total: 500, currency: 'jpy', customer: CUSTOMER_ID, customer_email: ' Taro@Example.com ',
        subscription: SUBSCRIPTION_ID, invoice: FIRST_INVOICE_ID, payment_intent: null,
        metadata: { orderType: 'membership', memberId: state.sessionMemberId || MEMBER_ID }
      } };
    }
    if (url.indexOf('/v1/subscriptions/' + SUBSCRIPTION_ID) !== -1) {
      if (method === 'delete') { state.canceled = true; return { responseCode: 200, body: { id: SUBSCRIPTION_ID, status: 'canceled' } }; }
      return { responseCode: 200, body: state.subscription || {
        id: SUBSCRIPTION_ID, status: state.canceled ? 'canceled' : 'active', customer: CUSTOMER_ID, cancel_at_period_end: false,
        metadata: { orderType: 'membership', memberId: state.sessionMemberId || MEMBER_ID },
        items: { data: [{ current_period_start: sec(JOIN_AT), current_period_end: sec(RENEW1_AT) }] }
      } };
    }
    if (url.indexOf('/invoice_payments?') !== -1) {
      return { responseCode: 200, body: { object: 'list', has_more: false, data: state.invoicePayments || [] } };
    }
    if (url.indexOf('/invoices/') !== -1) {
      return { responseCode: 200, body: state.invoices[decodeURIComponent(url.split('/invoices/')[1])] };
    }
    if (url.indexOf('/charges/') !== -1) {
      return { responseCode: 200, body: state.charge };
    }
    if (url.indexOf('/checkout/sessions') !== -1 && method === 'post') {
      return { responseCode: 200, body: { id: 'cs_new', url: 'https://checkout.stripe.com/c/pay/cs_new', metadata: {} } };
    }
    var lookup = membershipLookupResponse(url, options, state);
    if (lookup) return lookup;
    throw new Error('未対応のURL: ' + url);
  };
}

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var stripeState = Object.assign({}, opts.stripeState || {});
  var stripeCalls = [];
  var clock = stubs.createControllableClock(opts.clockAt || RENEW1_AT);
  var properties = Object.assign({
    SPREADSHEET_ID: SPREADSHEET_ID, CALENDAR_ID: 'cal1', STRIPE_SECRET_KEY: 'sk_test_dummy_value',
    STRIPE_CHECKOUT_ENABLED: 'true',
    STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/Studio-nagoya-base/membership/complete.html',
    STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/Studio-nagoya-base/membership/'
  }, opts.properties || {});
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(makeStripeResponder(stripeState, stripeCalls)),
    Utilities: stubs.createUtilitiesStub(),
    MailApp: stubs.createMailAppStub(),
    ContentService: stubs.createContentServiceStub(),
    Logger: stubs.createLoggerStub(),
    Date: clock.Date
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, globals: globals, stripeCalls: stripeCalls, stripeState: stripeState, clock: clock, sheets: spreadsheetsById[SPREADSHEET_ID] };
}

function receiveAndProcess(ctx, event) {
  var now = ctx.clock.currentDate();
  var claim = ctx.sandbox.StripeEventRepository.claim(event.id, event.type, now);
  if (claim.outcome === 'CLAIMED') ctx.sandbox.StripeEventRepository.storeRawBody(claim.rowNumber, JSON.stringify(event), now);
  var run = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  return run.results.filter(function (r) { return r.eventId === event.id; })[0] || { finalized: false, code: 'NOT_PROCESSED' };
}

function joinEvent(id) {
  return { id: id || 'evt_join_1', type: 'checkout.session.completed', created: sec(JOIN_AT) + 2, data: { object: { id: SESSION_ID } } };
}

/* 新方式のinvoice.paid（subscription_create / subscription_cycle）。periodStartIsoから1か月が期間。 */
function feeInvoice(id, periodStartIso, reason, overrides) {
  return Object.assign({
    id: id, object: 'invoice', billing_reason: reason || 'subscription_cycle', status: 'paid',
    amount_paid: 500, currency: 'jpy', customer: CUSTOMER_ID,
    parent: { subscription_details: { subscription: SUBSCRIPTION_ID, metadata: { orderType: 'membership', memberId: MEMBER_ID } } },
    lines: { data: [{ amount: 500, period: { start: sec(periodStartIso), end: sec(oneMonthLater(periodStartIso)) } }] },
    status_transitions: { paid_at: sec(periodStartIso) + 5 }
  }, overrides || {});
}

function invoiceEvent(id, created, invoice) {
  return { id: id, type: 'invoice.paid', created: created, data: { object: invoice } };
}

function firstInvoiceEvent() {
  return invoiceEvent('evt_inv_first', sec(JOIN_AT) + 1, feeInvoice(FIRST_INVOICE_ID, JOIN_AT, 'subscription_create'));
}

function rowsOf(ctx, name) { return ctx.sheets[name] ? ctx.sheets[name]._rows.slice(1) : []; }
function memberOn(ctx, date, email) { return ctx.sandbox.MemberRepository.isMemberOnDate(email || MEMBER_EMAIL, date) === true; }

/* ===== 到着順に依存しない ===== */

function finalState(ctx) {
  var member = ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID });
  return plain({
    member: member && { email: member.record.email, sub: member.record.stripeSubscriptionId, cust: member.record.stripeCustomerId, status: member.record.status },
    periods: rowsOf(ctx, 'MemberPeriods').map(function (r) { return [r[0], r[1], r[4], r[5], r[6]]; }),
    months: rowsOf(ctx, 'MemberMonths').length,
    membership: ['2026-10-25', '2026-10-26', '2026-11-25', '2026-11-26'].map(function (d) { return memberOn(ctx, d); })
  });
}

test('順序: checkout.session.completed → invoice.paid（会員行が先）で、入会日〜更新日の前日が有効になる', function () {
  var ctx = setup();
  var join = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(join.code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(memberOn(ctx, '2026-10-26'), false, 'invoice.paid前はPeriodが無いので未確定');
  var paid = receiveAndProcess(ctx, firstInvoiceEvent());
  assert.strictEqual(paid.code, 'MEMBERSHIP_PERIOD_PAID');
  assert.deepStrictEqual(finalState(ctx).membership, [false, true, true, false]);
});

test('順序: invoice.paid → checkout.session.completed（invoiceが先・会員行なし）でもPeriodを失わず、同じ最終結果になる', function () {
  var a = setup();
  receiveAndProcess(a, joinEvent());
  receiveAndProcess(a, firstInvoiceEvent());

  var b = setup();
  var paid = receiveAndProcess(b, firstInvoiceEvent());
  assert.strictEqual(paid.finalized, true);
  assert.strictEqual(paid.code, 'MEMBERSHIP_PERIOD_PAID', '会員行が無いことを理由にMEMBERSHIP_MEMBER_NOT_FOUNDで確定しない');
  assert.strictEqual(rowsOf(b, 'MemberPeriods').length, 1);
  assert.strictEqual(memberOn(b, '2026-10-26'), false, '会員行（メール）がまだ無いので誰にも結び付かない');
  var join = receiveAndProcess(b, joinEvent());
  assert.strictEqual(join.code, 'MEMBERSHIP_JOINED');

  assert.deepStrictEqual(finalState(b), finalState(a), 'どちらの順序でも最終結果は同じ');
  assert.deepStrictEqual(finalState(b).membership, [false, true, true, false]);
  assert.strictEqual(finalState(b).months, 0, 'MemberMonthsには追記しない');
});

test('順序: 会員行が無い間のsubscription系イベントは入会Checkout完了前なら対象外にし、Checkout完了時の最新状態で記録される', function () {
  var ctx = setup();
  /* 入会受付（保留中の記録）を済ませてから、Checkout完了より先にsubscription.createdが届く。 */
  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true);
  var pendingMemberId = rowsOf(ctx, 'MemberCheckouts')[0][0];
  ctx.stripeState.sessionMemberId = pendingMemberId;
  var created = receiveAndProcess(ctx, { id: 'evt_sub_created', type: 'customer.subscription.created', created: sec(JOIN_AT),
    data: { object: { id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'active', metadata: { orderType: 'membership', memberId: pendingMemberId } } } });
  assert.strictEqual(created.finalized, true);
  assert.strictEqual(created.code, 'MEMBERSHIP_MEMBER_NOT_YET_RECORDED');
  assert.strictEqual(receiveAndProcess(ctx, joinEvent()).code, 'MEMBERSHIP_JOINED');
  var found = ctx.sandbox.MemberRepository.findMember({ memberId: pendingMemberId }).record;
  assert.strictEqual(found.status, 'active');
  assert.strictEqual(found.stripeSubscriptionId, SUBSCRIPTION_ID);
});

test('入会: 同じイベントの再送・別イベントIDでの再送でも会員行・Periodは1つ', function () {
  var ctx = setup();
  receiveAndProcess(ctx, joinEvent('evt_a'));
  receiveAndProcess(ctx, joinEvent('evt_b'));
  receiveAndProcess(ctx, firstInvoiceEvent());
  var again = firstInvoiceEvent();
  again.id = 'evt_inv_again';
  receiveAndProcess(ctx, again);
  assert.strictEqual(rowsOf(ctx, 'Members').length, 1);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
});

test('入会: 未決済・金額不一致・Subscriptionのmetadata不一致は会員を作らない', function () {
  var unpaid = setup({ stripeState: { session: { id: SESSION_ID, mode: 'subscription', payment_status: 'unpaid', amount_total: 500, currency: 'jpy', customer: CUSTOMER_ID, customer_email: MEMBER_EMAIL, subscription: SUBSCRIPTION_ID, metadata: { orderType: 'membership', memberId: MEMBER_ID } } } });
  assert.strictEqual(receiveAndProcess(unpaid, joinEvent()).code, 'PAYMENT_NOT_YET_COMPLETE');
  assert.strictEqual(rowsOf(unpaid, 'Members').length, 0);

  var wrong = setup({ stripeState: { session: { id: SESSION_ID, mode: 'subscription', payment_status: 'paid', amount_total: 1000, currency: 'jpy', customer: CUSTOMER_ID, customer_email: MEMBER_EMAIL, subscription: SUBSCRIPTION_ID, metadata: { orderType: 'membership', memberId: MEMBER_ID } } } });
  assert.strictEqual(receiveAndProcess(wrong, joinEvent()).code, 'MEMBERSHIP_JOIN_AMOUNT_MISMATCH');

  var mismatch = setup({ stripeState: { subscription: { id: SUBSCRIPTION_ID, status: 'active', metadata: { orderType: 'membership', memberId: 'MBR-other' }, items: { data: [] } } } });
  assert.strictEqual(receiveAndProcess(mismatch, joinEvent()).code, 'MEMBERSHIP_JOIN_SUBSCRIPTION_MISMATCH');
  assert.strictEqual(rowsOf(mismatch, 'Members').length, 0);
});

/* ===== 有効日の境界・更新 ===== */

test('有効日: 10/26 22:40 JST入会 → 10/26〜11/25が有効、更新完了前の11/26は未来Periodを会員扱いしない', function () {
  var ctx = setup();
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, firstInvoiceEvent());
  assert.strictEqual(memberOn(ctx, '2026-10-25'), false);
  assert.strictEqual(memberOn(ctx, '2026-10-26'), true);
  assert.strictEqual(memberOn(ctx, '2026-11-25'), true);
  assert.strictEqual(memberOn(ctx, '2026-11-26'), false, '更新日当日は、更新の課金成功（invoice.paid）が記録されるまで会員扱いしない');
  assert.strictEqual(memberOn(ctx, '2026-12-10'), false);

  /* 11/26 22:40の更新が成功したら、11/26〜12/25が有効になる。 */
  var renew = receiveAndProcess(ctx, invoiceEvent('evt_inv_r1', sec(RENEW1_AT) + 3, feeInvoice('in_test_r1', RENEW1_AT, 'subscription_cycle')));
  assert.strictEqual(renew.code, 'MEMBERSHIP_PERIOD_PAID');
  assert.strictEqual(memberOn(ctx, '2026-11-26'), true);
  assert.strictEqual(memberOn(ctx, '2026-12-25'), true);
  assert.strictEqual(memberOn(ctx, '2026-12-26'), false);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 2);
  assert.strictEqual(rowsOf(ctx, 'MemberMonths').length, 0, 'MemberMonthsは凍結（新しい支払行を追記しない）');
});

test('有効日: 更新が成功しなければ（失敗・解約）その先は無効。猶予期間は無い', function () {
  var ctx = setup();
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, firstInvoiceEvent());
  var failed = feeInvoice('in_test_fail', RENEW1_AT, 'subscription_cycle', { status: 'open', amount_paid: 0 });
  receiveAndProcess(ctx, { id: 'evt_fail', type: 'invoice.payment_failed', created: sec(RENEW1_AT) + 3, data: { object: failed } });
  assert.strictEqual(memberOn(ctx, '2026-11-25'), true, '支払済みの期間は影響を受けない');
  assert.strictEqual(memberOn(ctx, '2026-11-26'), false);
  assert.strictEqual(ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record.status, 'past_due');
});

test('有効日: 1/31入会 → 2月末・3月の更新境界が切れ目なく続く（Stripeは月末に丸める）', function () {
  var ctx = setup();
  receiveAndProcess(ctx, joinEvent());
  var jan31 = '2027-01-31T10:00:00+09:00';
  var feb28 = '2027-02-28T10:00:00+09:00';
  var mar28 = '2027-03-28T10:00:00+09:00';
  function inv(id, created, start, end, reason) {
    return invoiceEvent(id, sec(created) + 1, feeInvoice('in_' + id, start, reason, { lines: { data: [{ amount: 500, period: { start: sec(start), end: sec(end) } }] } }));
  }
  receiveAndProcess(ctx, inv('e1', jan31, jan31, feb28, 'subscription_create'));
  receiveAndProcess(ctx, inv('e2', feb28, feb28, mar28, 'subscription_cycle'));
  assert.strictEqual(memberOn(ctx, '2027-01-30'), false);
  assert.strictEqual(memberOn(ctx, '2027-01-31'), true);
  assert.strictEqual(memberOn(ctx, '2027-02-27'), true);
  assert.strictEqual(memberOn(ctx, '2027-02-28'), true, '2/28は更新Periodの開始日');
  assert.strictEqual(memberOn(ctx, '2027-03-27'), true);
  assert.strictEqual(memberOn(ctx, '2027-03-28'), false);
  var view = ctx.sandbox.MembershipRules.describeMembershipStatus(MEMBER_EMAIL,
    ctx.sandbox.MemberRepository.statusFactsForEmail(MEMBER_EMAIL), { nowMs: Date.parse('2027-02-10T12:00:00+09:00') });
  assert.strictEqual(view.validUntil, '2027-03-27', '切れ目なく更新された最新Periodのperiod.endの前日');
});

test('有効日: 2/29を含む年（2028年）の入会と更新', function () {
  var ctx = setup();
  receiveAndProcess(ctx, joinEvent());
  var feb29 = '2028-02-29T10:00:00+09:00';
  var mar29 = '2028-03-29T10:00:00+09:00';
  receiveAndProcess(ctx, invoiceEvent('e29', sec(feb29) + 1, feeInvoice('in_29', feb29, 'subscription_create', { lines: { data: [{ amount: 500, period: { start: sec(feb29), end: sec(mar29) } }] } })));
  assert.strictEqual(memberOn(ctx, '2028-02-28'), false);
  assert.strictEqual(memberOn(ctx, '2028-02-29'), true);
  assert.strictEqual(memberOn(ctx, '2028-03-28'), true);
  assert.strictEqual(memberOn(ctx, '2028-03-29'), false);
});

/* ===== 旧MemberMonths・永久会員・プレスタート ===== */

test('合算: 旧MemberMonthsの既存支払行は削除せず、暦月まるごと資格判定へ合算する。新しい支払行は追記しない', function () {
  var ctx = setup();
  ctx.sandbox.MemberRepository.upsertMember({ memberId: 'MBR-legacy' }, { memberId: 'MBR-legacy', email: 'legacy@example.com', customerId: 'cus_legacy' }, null, { create: true }, new Date());
  ctx.sandbox.MemberRepository.recordPaidMonth({ memberId: 'MBR-legacy', month: '2026-10', sourceType: 'checkout_session', sourceId: 'cs_legacy', amount: 500 }, new Date());
  ctx.sandbox.MemberRepository.recordPaidMonth({ memberId: 'MBR-legacy', month: '2026-11', sourceType: 'checkout_session', sourceId: 'cs_legacy', amount: 0 }, new Date());
  assert.strictEqual(memberOn(ctx, '2026-10-26', 'legacy@example.com'), true);
  assert.strictEqual(memberOn(ctx, '2026-10-01', 'legacy@example.com'), true, '旧方式は暦月まるごと');
  assert.strictEqual(memberOn(ctx, '2026-11-30', 'legacy@example.com'), true);
  assert.strictEqual(memberOn(ctx, '2026-12-01', 'legacy@example.com'), false);
  assert.strictEqual(rowsOf(ctx, 'MemberMonths').length, 2, '既存行は残る');
});

test('プレスタート会員: 課金日を変えず、12/1（毎月1日anchor）の更新invoiceはMemberPeriodsに記録され、MemberMonthsには追記しない', function () {
  var ctx = setup({ clockAt: '2026-12-01T09:00:00+09:00' });
  ctx.sandbox.MemberRepository.upsertMember({ memberId: 'MBR-pre' }, { memberId: 'MBR-pre', email: 'pre@example.com', customerId: 'cus_pre', subscriptionId: 'sub_pre' }, null, { create: true }, new Date());
  ctx.sandbox.MemberRepository.recordPaidMonth({ memberId: 'MBR-pre', month: '2026-11', sourceType: 'checkout_session', sourceId: 'cs_pre', amount: 500 }, new Date());
  var invoice = {
    id: 'in_pre_dec', billing_reason: 'subscription_cycle', status: 'paid', amount_paid: 500, currency: 'jpy', customer: 'cus_pre',
    parent: { subscription_details: { subscription: 'sub_pre', metadata: { orderType: 'membership', memberId: 'MBR-pre' } } },
    lines: { data: [{ amount: 500, period: { start: sec('2026-12-01T00:00:00Z'), end: sec('2027-01-01T00:00:00Z') } }] }
  };
  var res = receiveAndProcess(ctx, invoiceEvent('evt_pre_dec', sec('2026-12-01T00:00:10Z'), invoice));
  assert.strictEqual(res.code, 'MEMBERSHIP_PERIOD_PAID');
  assert.strictEqual(memberOn(ctx, '2026-11-30', 'pre@example.com'), true, '旧MemberMonthsの11月');
  assert.strictEqual(memberOn(ctx, '2026-12-01', 'pre@example.com'), true);
  assert.strictEqual(memberOn(ctx, '2026-12-31', 'pre@example.com'), true);
  assert.strictEqual(memberOn(ctx, '2027-01-01', 'pre@example.com'), false);
  assert.strictEqual(rowsOf(ctx, 'MemberMonths').length, 1);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
  /* 既存subscriptionを作り直さない・anchorを変えない・追加請求をしない（Stripeへの書き込みなし）。 */
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return String((c.options && c.options.method) || 'get').toLowerCase() !== 'get'; }).length, 0);
  /* 次回更新日は毎月1日のまま（旧anchor）。 */
  var view = ctx.sandbox.MembershipRules.describeMembershipStatus('pre@example.com',
    Object.assign(plain(ctx.sandbox.MemberRepository.statusFactsForEmail('pre@example.com')), { autoRenew: true }), { nowMs: Date.parse('2026-12-10T12:00:00+09:00') });
  assert.strictEqual(view.validUntil, '2026-12-31');
  assert.strictEqual(view.nextRenewalDate, '2027-01-01');
});

test('合算: 永久会員は支払いが無くてもどの日でも会員（台帳は書き込まない）', function () {
  var ctx = setup();
  assert.strictEqual(memberOn(ctx, '2030-05-05', 'koishi.s@gmail.com'), true);
  assert.strictEqual(memberOn(ctx, 'bad-date', 'koishi.s@gmail.com'), false);
  assert.deepStrictEqual(Object.keys(ctx.sheets), [], '永久会員の判定は台帳へ書き込まない・台帳を作らない');
  assert.strictEqual(memberOn(ctx, '2030-05-05', 'someone@example.com'), false);
});

/* ===== 返金 ===== */

function refundSetup(chargeInvoiceField) {
  var ctx = setup();
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, firstInvoiceEvent());
  receiveAndProcess(ctx, invoiceEvent('evt_inv_r1', sec(RENEW1_AT) + 3, feeInvoice('in_test_r1', RENEW1_AT, 'subscription_cycle')));
  ctx.stripeState.invoices = {
    in_test_r1: feeInvoice('in_test_r1', RENEW1_AT, 'subscription_cycle'),
    in_test_first: feeInvoice(FIRST_INVOICE_ID, JOIN_AT, 'subscription_create')
  };
  ctx.stripeState.invoicePayments = [{ invoice: 'in_test_r1' }];
  ctx.stripeState.charge = Object.assign({ id: 'ch_r1', payment_intent: 'pi_r1', amount: 500, amount_refunded: 500, currency: 'jpy' }, chargeInvoiceField || {});
  return ctx;
}

function refundEvent(id) {
  return { id: id, type: 'charge.refunded', created: sec(RENEW1_AT) + 100, data: { object: { id: 'ch_r1', object: 'charge' } } };
}

test('返金: 更新invoiceの全額返金で、その更新Periodだけが資格判定から外れる（初回Periodは残る）', function () {
  var ctx = refundSetup();
  assert.strictEqual(memberOn(ctx, '2026-12-01'), true);
  var res = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  /* subscriptionが有効なため、運営への通知つき（REJECTED）で確定する。 */
  assert.strictEqual(res.code, 'MEMBERSHIP_REFUNDED_SUBSCRIPTION_ACTIVE');
  assert.strictEqual(memberOn(ctx, '2026-12-01'), false, '返金された更新Periodは無効');
  assert.strictEqual(memberOn(ctx, '2026-11-25'), true, '初回Periodは影響しない');
  var refunds = rowsOf(ctx, 'MemberRefunds');
  assert.strictEqual(refunds.length, 1);
  assert.strictEqual(refunds[0][0], 'invoice');
  assert.strictEqual(refunds[0][1], 'in_test_r1');
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 2, '履歴は物理削除しない');
  /* 冪等。 */
  assert.strictEqual(receiveAndProcess(ctx, refundEvent('evt_refund_2')).code, 'MEMBERSHIP_REFUND_ALREADY_APPLIED');
  assert.strictEqual(rowsOf(ctx, 'MemberRefunds').length, 1);
});

test('返金: 旧API version（Charge.invoiceを持つ）でもinvoiceを特定できる。Invoice Payments APIは呼ばない', function () {
  var ctx = refundSetup({ invoice: 'in_test_r1' });
  ctx.stripeState.invoicePayments = [];
  receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(memberOn(ctx, '2026-12-01'), false);
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/invoice_payments') !== -1; }).length, 0);
});

test('返金: 一部返金では資格Periodを除外しない', function () {
  var ctx = refundSetup();
  ctx.stripeState.charge.amount_refunded = 200;
  var res = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(res.code, 'MEMBERSHIP_PARTIAL_REFUND_NO_CHANGE');
  assert.strictEqual(memberOn(ctx, '2026-12-01'), true);
  assert.strictEqual(rowsOf(ctx, 'MemberRefunds').length, 0);
});

test('返金: 初回invoiceの全額返金（初回Period除外）／返金が支払いより先に処理されても到着順に依存せず収束する', function () {
  var ctx = refundSetup();
  ctx.stripeState.invoicePayments = [{ invoice: 'in_test_first' }];
  receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(memberOn(ctx, '2026-11-01'), false, '初回Periodが無効');
  assert.strictEqual(memberOn(ctx, '2026-12-01'), true, '更新Periodは有効');

  /* 返金済みinvoiceのinvoice.paidが後から記録されても、そのPeriodは無効のまま。 */
  var late = setup();
  late.stripeState.invoices = { in_test_first: feeInvoice(FIRST_INVOICE_ID, JOIN_AT, 'subscription_create') };
  late.stripeState.invoicePayments = [{ invoice: 'in_test_first' }];
  late.stripeState.charge = { id: 'ch_r1', payment_intent: 'pi_r1', amount: 500, amount_refunded: 500, currency: 'jpy' };
  receiveAndProcess(late, joinEvent());
  receiveAndProcess(late, refundEvent('evt_refund_early'));
  receiveAndProcess(late, firstInvoiceEvent());
  assert.strictEqual(memberOn(late, '2026-11-01'), false);
});

test('返金: 会費invoiceでない500円の決済（部屋予約等）の返金は何もしない', function () {
  var ctx = refundSetup();
  ctx.stripeState.invoicePayments = [];
  ctx.stripeState.sessionsForIntent = [];
  var original = ctx.globals.UrlFetchApp.fetch;
  ctx.globals.UrlFetchApp.fetch = function (url, o) {
    if (url.indexOf('/checkout/sessions?payment_intent=') !== -1) {
      return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify({ data: [] }); }, getHeaders: function () { return {}; } };
    }
    return original.call(this, url, o);
  };
  assert.strictEqual(receiveAndProcess(ctx, refundEvent('evt_refund_x')).code, 'NOT_MEMBERSHIP_JOIN_PAYMENT');
  assert.strictEqual(rowsOf(ctx, 'MemberRefunds').length, 0);
});

/* ===== status表示 ===== */

test('status: 新規は有効期限＝最新Periodのperiod.endの前日、次回更新日＝period.endの日付。解約予約済みは次回更新なし', function () {
  var ctx = setup();
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, firstInvoiceEvent());
  var facts = plain(ctx.sandbox.MemberRepository.statusFactsForEmail(MEMBER_EMAIL));
  assert.strictEqual(facts.autoRenew, true);
  var nowMs = Date.parse('2026-11-01T12:00:00+09:00');
  var view = plain(ctx.sandbox.MembershipRules.describeMembershipStatus(MEMBER_EMAIL, facts, { nowMs: nowMs }));
  assert.strictEqual(view.active, true);
  assert.strictEqual(view.validUntil, '2026-11-25');
  assert.strictEqual(view.nextRenewalDate, '2026-11-26');
  assert.strictEqual(view.autoRenew, true);
  assert.strictEqual(JSON.stringify(view).indexOf('sub_'), -1);

  /* 解約予約（cancel_at_period_end）: 支払済み期間末までは有効だが、次回更新なし。 */
  receiveAndProcess(ctx, { id: 'evt_sub_upd', type: 'customer.subscription.updated', created: sec(JOIN_AT) + 600,
    data: { object: { id: SUBSCRIPTION_ID, customer: CUSTOMER_ID, status: 'active', cancel_at_period_end: true, canceled_at: sec(JOIN_AT) + 599,
      metadata: { orderType: 'membership', memberId: MEMBER_ID }, items: { data: [{ current_period_start: sec(JOIN_AT), current_period_end: sec(RENEW1_AT) }] } } } });
  var canceled = plain(ctx.sandbox.MembershipRules.describeMembershipStatus(MEMBER_EMAIL, plain(ctx.sandbox.MemberRepository.statusFactsForEmail(MEMBER_EMAIL)), { nowMs: nowMs }));
  assert.strictEqual(canceled.active, true);
  assert.strictEqual(canceled.validUntil, '2026-11-25');
  assert.strictEqual(canceled.autoRenew, false);
  assert.strictEqual(canceled.nextRenewalDate, null);

  /* 期間を過ぎたら無効。 */
  var after = plain(ctx.sandbox.MembershipRules.describeMembershipStatus(MEMBER_EMAIL, facts, { nowMs: Date.parse('2026-11-26T12:00:00+09:00') }));
  assert.strictEqual(after.active, false);
});

test('status: 旧MemberMonthsのみの会員は有効期限＝その月の末日、プレスタートは11/30・次回更新日12/1', function () {
  var R = setup().sandbox.MembershipRules;
  var view = plain(R.describeMembershipStatus('a@example.com', { paidMonths: ['2026-10', '2026-11'], periods: [], autoRenew: true }, { nowMs: Date.parse('2026-11-10T12:00:00+09:00') }));
  assert.strictEqual(view.active, true);
  assert.strictEqual(view.validUntil, '2026-11-30');
  assert.strictEqual(view.nextRenewalDate, '2026-12-01');
  var single = plain(R.describeMembershipStatus('a@example.com', { paidMonths: ['2026-12'], periods: [], autoRenew: false }, { nowMs: Date.parse('2026-12-10T12:00:00+09:00') }));
  assert.strictEqual(single.validUntil, '2026-12-31');
  assert.strictEqual(single.nextRenewalDate, null);
  /* 永久会員は支払いが無くても有効（当月末まで・自動更新の形）。 */
  var perm = plain(R.describeMembershipStatus('p@example.com', { paidMonths: [], periods: [], autoRenew: false }, { permanent: true, nowMs: Date.parse('2026-12-10T12:00:00+09:00') }));
  assert.strictEqual(perm.active, true);
  assert.strictEqual(perm.validUntil, '2026-12-31');
});

/* ===== 二重加入 ===== */

test('二重加入（受付時）: MemberPeriodsだけを持つ新方式の会員が同じメールで再入会しようとすると、Checkoutは発行されず既存会員向けのメールになる', function () {
  var ctx = setup({ clockAt: '2026-11-10T12:00:00+09:00' });
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, firstInvoiceEvent());
  /* subscriptionの状態に依らず、支払済みPeriodだけで既存会員と判定される（Members.statusをactive以外にして確認）。 */
  var m = ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID });
  ctx.sheets.Members._rows[m.rowNumber - 1][ctx.sandbox.MemberRepository.MEMBER_HEADERS.indexOf('status')] = 'past_due';
  var before = ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/checkout/sessions') !== -1 && c.options.method === 'post'; }).length;
  var res = ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL });
  assert.strictEqual(res.success, true, '応答は新規と同じ形（会員の有無を漏らさない）');
  var after = ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/checkout/sessions') !== -1 && c.options.method === 'post'; }).length;
  assert.strictEqual(after, before, 'Checkoutを発行しない');
  var mails = ctx.globals.MailApp._sentEmails;
  assert.ok(mails[mails.length - 1].body.indexOf('既にSNB MEMBERとしてご登録済み') !== -1);
});

test('二重加入（Webhook）: 同じメールの有効な別会員が判明したら、新しいSubscriptionを即時キャンセルし、要復旧として通知する（自動返金しない）', function () {
  var ctx = setup({ clockAt: '2026-11-10T12:00:00+09:00' });
  /* 既存の有効会員。 */
  ctx.sandbox.MemberRepository.upsertMember({ memberId: 'MBR-existing' }, { memberId: 'MBR-existing', email: MEMBER_EMAIL, customerId: 'cus_existing', subscriptionId: 'sub_existing' }, null, { create: true }, new Date());
  ctx.sandbox.MemberRepository.recordPeriod({ memberId: 'MBR-existing', subscriptionId: 'sub_existing', periodStartSeconds: sec('2026-11-01T10:00:00+09:00'), periodEndSeconds: sec('2026-12-01T10:00:00+09:00'), sourceType: 'invoice', sourceId: 'in_existing', amount: 500 }, new Date());

  var res = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(res.code, 'MEMBERSHIP_DUPLICATE_JOIN');
  assert.strictEqual(rowsOf(ctx, 'Members').length, 1, '会員行を作らない');
  assert.strictEqual(ctx.stripeState.canceled, true, '新しいSubscriptionを即時キャンセル');
  var cancelCall = ctx.stripeCalls.filter(function (c) { return String(c.options.method).toLowerCase() === 'delete'; })[0];
  assert.ok(cancelCall.url.indexOf('/subscriptions/' + SUBSCRIPTION_ID) !== -1);
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/refunds') !== -1; }).length, 0, '自動返金はしない');
  assert.ok(rowsOf(ctx, 'Recovery').length >= 1 || Object.keys(ctx.sheets).some(function (n) { return /Recovery/i.test(n); }), '要復旧として記録');
});

test('二重加入（Webhook）: 自分自身の再送は重複扱いにしない', function () {
  var ctx = setup();
  assert.strictEqual(receiveAndProcess(ctx, joinEvent('evt_a')).code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(receiveAndProcess(ctx, joinEvent('evt_b')).code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(ctx.stripeState.canceled, undefined);
});

/* ===== 入会受付の一時停止 ===== */

test('MEMBERSHIP_JOIN_PAUSED=true: 新しい入会Checkoutを発行せず、CHECKOUT_DISABLEDと同じ応答形で案内する。メールも送らない', function () {
  var ctx = setup({ properties: { MEMBERSHIP_JOIN_PAUSED: 'true' } });
  var res = plain(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }));
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error.code, 'MEMBERSHIP_JOIN_PAUSED');
  assert.strictEqual(res.error.message, '現在、入会受付を一時停止しています。しばらくしてから再度お試しください。');
  assert.deepStrictEqual(Object.keys(res.error).sort(), ['code', 'message']);
  assert.strictEqual(ctx.stripeCalls.length, 0);
  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 0);
  assert.strictEqual(rowsOf(ctx, 'MemberCheckouts').length, 0, '保留中も作らない');
});

test('MEMBERSHIP_JOIN_PAUSED: \'true\'以外（未設定・false・空）は従来どおり受け付け、STRIPE_CHECKOUT_ENABLEDとは独立', function () {
  ['', 'false', 'TRUE', '1'].forEach(function (value) {
    var ctx = setup({ properties: { MEMBERSHIP_JOIN_PAUSED: value } });
    assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true, 'paused=' + value);
  });
  var unset = setup();
  assert.strictEqual(unset.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true);
  /* 一時停止中でもSTRIPE_CHECKOUT_ENABLEDの値は変わらない（部屋予約・オプション決済のキルスイッチを巻き込まない）。 */
  var paused = setup({ properties: { MEMBERSHIP_JOIN_PAUSED: 'true' } });
  var config = paused.sandbox.BookingConfig.getStripeConfig();
  assert.strictEqual(config.checkoutEnabled, true);
  assert.strictEqual(config.membershipJoinPaused, true);
  /* STRIPE_CHECKOUT_ENABLED=falseでも、一時停止の有無とは別に入会はCHECKOUT_DISABLED。 */
  var disabled = setup({ properties: { STRIPE_CHECKOUT_ENABLED: 'false' } });
  assert.strictEqual(plain(disabled.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL })).error.code, 'CHECKOUT_DISABLED');
});

test('MEMBERSHIP_JOIN_PAUSED: 本人確認リンク・Webhook処理・解約は止めない', function () {
  var ctx = setup({ properties: { MEMBERSHIP_JOIN_PAUSED: 'true', MEMBERSHIP_STATUS_URL: 'https://example.com/membership/status/' } });
  assert.strictEqual(receiveAndProcess(ctx, joinEvent()).code, 'MEMBERSHIP_JOINED', '入会Checkout完了のWebhookは処理する');
  assert.strictEqual(receiveAndProcess(ctx, firstInvoiceEvent()).code, 'MEMBERSHIP_PERIOD_PAID');
  assert.strictEqual(ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER_EMAIL }).success, true);
});

test('MEMBERSHIP_JOIN_PAUSED: 入会受付以外のコードはこのスイッチを参照しない（部屋予約・オプション決済・本人確認・解約・Webhook）', function () {
  var fs = require('node:fs');
  var path = require('node:path');
  var root = path.join(__dirname, '..', 'gas', 'booking');
  var hits = [];
  ['shared', 'public', 'admin', 'webhook'].forEach(function (dir) {
    fs.readdirSync(path.join(root, dir)).forEach(function (file) {
      if (!/\.gs$/.test(file)) return;
      var text = fs.readFileSync(path.join(root, dir, file), 'utf8');
      /* コメントを除いたコードだけを見る。 */
      var code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/MEMBERSHIP_JOIN_PAUSED|membershipJoinPaused/.test(code)) hits.push(dir + '/' + file);
    });
  });
  assert.deepStrictEqual(hits.sort(), ['shared/Config.gs', 'shared/MembershipService.gs']);
  var service = fs.readFileSync(path.join(root, 'shared', 'MembershipService.gs'), 'utf8');
  var startCheckout = service.slice(service.indexOf('function startCheckout('), service.indexOf('function requestStatusLink('));
  assert.ok(/membershipJoinPaused/.test(startCheckout));
  assert.ok(!/membershipJoinPaused/.test(service.slice(service.indexOf('function requestStatusLink('))), '本人確認・解約は止めない');
});

/* ===== 予約での資格判定（利用日・予約作成日） ===== */

var ADVANCE_NOW = new Date('2026-12-20T12:00:00+09:00');

function bookingPayload(overrides) {
  return Object.assign({
    brand: 'snb', customerType: 'returning', date: '2026-12-28', startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: MEMBER_EMAIL, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', isMember: false
  }, overrides || {});
}

function book(ctx, overrides, now) {
  return ctx.sandbox.BookingRepository.createBooking(bookingPayload(overrides), now || ADVANCE_NOW);
}

/* 12/15 12:00 JST入会 → 有効日 12/15〜1/14。 */
function joinedDec(ctx) {
  var at = '2026-12-15T12:00:00+09:00';
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, invoiceEvent('evt_inv_dec', sec(at), feeInvoice('in_dec', at, 'subscription_create')));
}

test('予約（V2）: 会員料金・特典は利用日が支払済み期間内の場合のみ。期間外の利用日は予約作成日が会員でも一般料金', function () {
  var ctx = setup({ clockAt: ADVANCE_NOW.toISOString() });
  joinedDec(ctx);
  var inside = book(ctx, { date: '2026-12-28' });
  assert.strictEqual(inside.price.tier, 'MEMBER');
  assert.strictEqual(inside.price.amount, 5500);
  var lastDay = book(ctx, { date: '2027-01-14', startTime: '13:00' });
  assert.strictEqual(lastDay.price.tier, 'MEMBER', '期間の最終日（更新日の前日）まで有効');
  var renewalDay = book(ctx, { date: '2027-01-15', startTime: '10:00' });
  assert.strictEqual(renewalDay.price.tier, 'GENERAL', '更新日（未決済の未来Period）は一般料金');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(renewalDay.bookingId).record.membershipStatus, 'INACTIVE');
});

test('予約（V2）: 先行予約（31〜90日先）は予約作成日が支払済み期間内なら許可。利用日が未決済の期間なら一般料金で確定し、更新後に自動再計算しない', function () {
  var ctx = setup({ clockAt: ADVANCE_NOW.toISOString() });
  joinedDec(ctx);
  var farDate = '2027-02-25';
  var result = book(ctx, { date: farDate, startTime: '10:00' });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.price.tier, 'GENERAL', '利用日は未決済の期間なので一般料金');
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record;
  assert.strictEqual(record.priceAmount, 6000);
  /* 以後の更新成功でも、確定済みの予約料金は再計算しない。 */
  receiveAndProcess(ctx, invoiceEvent('evt_renew_jan', sec('2027-01-15T12:00:00+09:00'), feeInvoice('in_jan', '2027-01-15T12:00:00+09:00', 'subscription_cycle')));
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record.priceAmount, 6000);

  /* 非会員は先行予約できない。 */
  var stranger = book(ctx, { date: farDate, startTime: '15:00', email: 'stranger@example.com' });
  assert.strictEqual(stranger.success, false);
  assert.strictEqual(stranger.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
  /* 予約作成日が期間外（失効済み）の会員も先行予約できない。 */
  var expired = book(ctx, { date: '2027-03-10', startTime: '10:00' }, new Date('2027-02-20T12:00:00+09:00'));
  assert.strictEqual(expired.success, true, '2/20時点は1/15更新分（〜2/14）の外だが30日以内');
  var tooFar = book(ctx, { date: '2027-05-10', startTime: '10:00' }, new Date('2027-02-20T12:00:00+09:00'));
  assert.strictEqual(tooFar.success, false, '期間が切れた会員は30日を超える先行予約はできない');
});

test('予約: 見積りAPIは会員台帳を参照しない（送信前の会員照会APIを作らない）', function () {
  var ctx = setup({ clockAt: ADVANCE_NOW.toISOString() });
  joinedDec(ctx);
  ['isMemberOnDate', 'isMemberForMonth', 'statusFactsForEmail', 'findLiveMemberByEmail'].forEach(function (name) {
    ctx.sandbox.MemberRepository[name] = function () { throw new Error('見積りで台帳を参照してはならない'); };
  });
  var run = function (extra) {
    var params = Object.assign({ action: 'estimatePrice', brand: 'snb', date: '2026-12-28', durationMinutes: '180' }, extra || {});
    return JSON.parse(ctx.sandbox.doGet({ parameter: params }).text);
  };
  var member = run({ email: MEMBER_EMAIL });
  var stranger = run({ email: 'stranger@example.com' });
  assert.deepStrictEqual(member, stranger, 'メールの有無・会員か否かで応答が変わらない');
  assert.strictEqual(member.price.tier, 'GENERAL', '見積りは一般料金で表示する');
});

test('GET応答: 月間空き状況にもサーバー時刻基準の料金世代（priceGeneration）を載せる。会員情報は含めない（Issue #532）', function () {
  var ctx = setup({ clockAt: '2026-11-20T12:00:00+09:00' });
  var res = JSON.parse(ctx.sandbox.doGet({ parameter: { action: 'monthly', year: '2026', month: '12', durationMinutes: '120', brand: 'snb', email: MEMBER_EMAIL } }).text);
  assert.strictEqual(res.success, true, JSON.stringify(res));
  assert.strictEqual(res.priceGeneration, 'V1', '2026/11/30までに作成される予約はV1');
  assert.strictEqual(JSON.stringify(res).indexOf(MEMBER_EMAIL), -1);
  var v2 = setup({ clockAt: '2026-12-01T00:00:00+09:00' });
  assert.strictEqual(JSON.parse(v2.sandbox.doGet({ parameter: { action: 'monthly', year: '2026', month: '12', durationMinutes: '120', brand: 'snb' } }).text).priceGeneration, 'V2');
});
