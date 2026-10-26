/*
 * SNB MEMBER初回入会決済の全額返金と会員資格（Issue #517）のテスト。Stripe API・Sheetsはすべてスタブ。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'CardPayment.gs',
  'JapaneseHolidays.gs', 'BookingPricing.gs', 'RateLimiter.gs', 'StripeGateway.gs',
  'StripeEventRepository.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'MembershipService.gs',
  'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'AdminNotifier.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'BookingRepository.gs',
  'StripeWebhookProcessor.gs', 'BookingAdminAlerts.gs', 'Code.gs'
];

var SPREADSHEET_ID = 'ss1';
var JOIN_SESSION_ID = 'cs_test_join_0001';
var MEMBER_ID = 'MBR-test-0001';
var CUSTOMER_ID = 'cus_test_0001';
var SUBSCRIPTION_ID = 'sub_test_0001';
var MEMBER_EMAIL = 'taro@example.com';

function sec(iso) { return Math.floor(Date.parse(iso) / 1000); }

var JOIN_AT = '2026-12-15T12:00:00+09:00';
var PRESTART_JOIN_AT = '2026-10-27T12:00:00+09:00';
var JAN_RENEWAL_AT = '2027-01-01T00:00:00Z';
var REFUND_AT = '2026-12-16T12:00:00+09:00';

function makeStripeResponder(state) {
  return function (url, options) {
    if (url.indexOf('/checkout/sessions?payment_intent=') !== -1) {
      if (state.sessionsListFails) return { responseCode: 500, body: { error: { type: 'api_error' } } };
      return { responseCode: 200, body: { data: state.sessionsForIntent } };
    }
    if (url.indexOf('/charges/') !== -1) {
      if (state.chargeFails) return { responseCode: 500, body: { error: { type: 'api_error' } } };
      return { responseCode: 200, body: {
        id: 'ch_join', payment_intent: state.chargeIntent, amount: state.chargeAmount,
        amount_refunded: state.amountRefunded, currency: 'jpy'
      } };
    }
    if (url.indexOf('/checkout/sessions/' + JOIN_SESSION_ID) !== -1) {
      return { responseCode: 200, body: joinSessionBody() };
    }
    if (url.indexOf('/payment_intents/pi_join') !== -1) {
      return { responseCode: 200, body: { id: 'pi_join', status: 'succeeded', amount_received: 500, currency: 'jpy', payment_method: 'pm_saved_1' } };
    }
    if (url.indexOf('/subscriptions') !== -1 && options.method === 'post') {
      return { responseCode: 200, body: {
        id: SUBSCRIPTION_ID, status: 'active', customer: CUSTOMER_ID,
        items: { data: [{ current_period_start: sec(JOIN_AT), current_period_end: sec(JAN_RENEWAL_AT) }] }
      } };
    }
    throw new Error('未対応のURL: ' + url);
  };
}

function joinSessionBody() {
  return {
    id: JOIN_SESSION_ID, mode: 'payment', status: 'complete', payment_status: 'paid',
    amount_total: 500, currency: 'jpy', payment_intent: 'pi_join', customer: CUSTOMER_ID,
    customer_email: MEMBER_EMAIL, metadata: { orderType: 'membership', memberId: MEMBER_ID }
  };
}

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var stripeCalls = [];
  var stripeState = {
    chargeIntent: 'pi_join', chargeAmount: 500, amountRefunded: 500,
    sessionsForIntent: [joinSessionBody()], chargeFails: false, sessionsListFails: false
  };
  var responder = makeStripeResponder(stripeState);
  var clock = stubs.createControllableClock(opts.clockAt || JOIN_AT);
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: SPREADSHEET_ID, CALENDAR_ID: 'cal1', STRIPE_SECRET_KEY: 'sk_test_dummy_value' }),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(function (url, o) { stripeCalls.push(url); return responder(url, o); }),
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

function joinEvent(id, at) {
  return { id: id || 'evt_join_1', type: 'checkout.session.completed', created: sec(at || JOIN_AT), data: { object: { id: JOIN_SESSION_ID } } };
}

function refundEvent(id) {
  return { id: id, type: 'charge.refunded', created: sec(REFUND_AT), data: { object: { id: 'ch_join', object: 'charge' } } };
}

function isMember(ctx, month) { return ctx.sandbox.MemberRepository.isMemberForMonth(MEMBER_EMAIL, month); }
function rowsOf(ctx, name) { return ctx.sheets[name] ? ctx.sheets[name]._rows.slice(1) : []; }

function joined(ctx, at) {
  var result = receiveAndProcess(ctx, joinEvent('evt_join_1', at));
  assert.strictEqual(result.code, 'MEMBERSHIP_JOINED');
}

test('全額返金: 初回決済を全額返金すると会員資格が無効になり、台帳の履歴は残る', function () {
  var ctx = setup();
  joined(ctx);
  assert.strictEqual(isMember(ctx, '2026-12'), true);

  var result = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(result.finalized, true);
  /* subscriptionは存在するため運営への通知つき（REJECTED）で確定するが、入会分の資格は無効になる。 */
  assert.strictEqual(result.code, 'MEMBERSHIP_REFUNDED_SUBSCRIPTION_ACTIVE');
  assert.strictEqual(isMember(ctx, '2026-12'), false);
  assert.strictEqual(rowsOf(ctx, 'MemberMonths').length, 1, 'MemberMonthsの行は削除・改変しない');
  assert.strictEqual(rowsOf(ctx, 'MemberRefunds').length, 1);

  /* 会員資格確認・二重加入判定も同じ結果を使う。 */
  assert.deepStrictEqual(Array.from(ctx.sandbox.MemberRepository.statusFactsForEmail(MEMBER_EMAIL).paidMonths), []);
  assert.strictEqual(ctx.sandbox.MembershipRules.verifyActualMembership(MEMBER_EMAIL, '2026-12-20').ok, false);
  assert.strictEqual(ctx.sandbox.MembershipRules.verifyAdvanceBookingMembership(MEMBER_EMAIL, '2026-12-16').ok, false);
  var view = ctx.sandbox.MembershipRules.describeMembershipStatus(MEMBER_EMAIL,
    ctx.sandbox.MemberRepository.statusFactsForEmail(MEMBER_EMAIL), { nowMs: Date.parse('2026-12-16T12:00:00+09:00') });
  assert.strictEqual(view.active, false);
});

test('全額返金: subscriptionが無い（作成失敗）場合も資格は残らず、通知なしで完了する', function () {
  var ctx = setup();
  /* subscription作成前の状態を再現: 会員行と支払い事実だけを台帳に置く。 */
  ctx.sandbox.MemberRepository.upsertMember({ memberId: MEMBER_ID }, { memberId: MEMBER_ID, email: MEMBER_EMAIL, customerId: CUSTOMER_ID }, null, { create: true }, new Date());
  ctx.sandbox.MemberRepository.recordPaidMonth({ memberId: MEMBER_ID, month: '2026-12', sourceType: 'checkout_session', sourceId: JOIN_SESSION_ID, amount: 500 }, new Date());
  assert.strictEqual(isMember(ctx, '2026-12'), true);

  var result = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(result.code, 'MEMBERSHIP_REFUND_APPLIED');
  assert.strictEqual(isMember(ctx, '2026-12'), false);
});

test('冪等: 別イベントIDで同じ返金が再送されても二重に記録しない', function () {
  var ctx = setup();
  joined(ctx);
  receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  var again = receiveAndProcess(ctx, refundEvent('evt_refund_2'));
  assert.strictEqual(again.code, 'MEMBERSHIP_REFUND_ALREADY_APPLIED');
  assert.strictEqual(receiveAndProcess(ctx, refundEvent('evt_refund_2')).code, 'NOT_PROCESSED', '同一イベントIDは受信側で弾かれる');
  assert.strictEqual(rowsOf(ctx, 'MemberRefunds').length, 1);
  assert.strictEqual(isMember(ctx, '2026-12'), false);
});

test('順序逆転: 返金イベントが入会イベントより先に処理されても、最終的に資格なし・subscription未作成に収束する', function () {
  var ctx = setup();
  var refund = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(refund.code, 'MEMBERSHIP_REFUND_APPLIED');

  var join = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(join.code, 'MEMBERSHIP_JOIN_REFUNDED');
  assert.strictEqual(isMember(ctx, '2026-12'), false);
  assert.strictEqual(ctx.stripeCalls.filter(function (u) { return u.indexOf('/subscriptions') !== -1; }).length, 0, '返金済みならsubscriptionを作らない');
});

test('プレスタート: 10月入会の初回500円を全額返金すると、10月・11月の資格がどちらも無効になる', function () {
  var ctx = setup({ clockAt: PRESTART_JOIN_AT });
  joined(ctx, PRESTART_JOIN_AT);
  assert.strictEqual(isMember(ctx, '2026-10'), true);
  assert.strictEqual(isMember(ctx, '2026-11'), true);

  receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(isMember(ctx, '2026-10'), false);
  assert.strictEqual(isMember(ctx, '2026-11'), false);
  assert.strictEqual(rowsOf(ctx, 'MemberMonths').length, 2);
});

test('一部返金: 全額返金と同じ扱いにせず、資格は変えない', function () {
  var ctx = setup();
  joined(ctx);
  ctx.stripeState.amountRefunded = 200;
  var result = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(result.code, 'MEMBERSHIP_PARTIAL_REFUND_NO_CHANGE');
  assert.strictEqual(isMember(ctx, '2026-12'), true);
  assert.strictEqual(rowsOf(ctx, 'MemberRefunds').length, 0);

  /* 後から残りも返金されて全額になれば、その時点で無効になる。 */
  ctx.stripeState.amountRefunded = 500;
  receiveAndProcess(ctx, refundEvent('evt_refund_2'));
  assert.strictEqual(isMember(ctx, '2026-12'), false);
});

test('継続課金: 初回決済だけ返金しても、その後の月次更新の支払い事実は有効になる', function () {
  var ctx = setup();
  joined(ctx);
  receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  var invoice = {
    id: 'in_jan', object: 'invoice', billing_reason: 'subscription_cycle', status: 'paid',
    amount_paid: 500, currency: 'jpy', customer: CUSTOMER_ID,
    parent: { subscription_details: { subscription: SUBSCRIPTION_ID, metadata: { orderType: 'membership', memberId: MEMBER_ID } } },
    lines: { data: [{ amount: 500, period: { start: sec(JAN_RENEWAL_AT), end: sec(JAN_RENEWAL_AT) + 86400 * 30 } }] },
    status_transitions: { paid_at: sec(JAN_RENEWAL_AT) + 5 }
  };
  receiveAndProcess(ctx, { id: 'evt_inv', type: 'invoice.paid', created: sec(JAN_RENEWAL_AT) + 10, data: { object: invoice } });
  assert.strictEqual(isMember(ctx, '2026-12'), false);
  assert.strictEqual(isMember(ctx, '2027-01'), true);
});

test('対象外: 入会Checkout以外の決済の返金は何もしない（既存の予約返金に影響しない）', function () {
  var ctx = setup();
  joined(ctx);
  ctx.stripeState.sessionsForIntent = [{ id: 'cs_room', payment_status: 'paid', payment_intent: 'pi_join', metadata: { bookingId: 'B1' } }];
  var result = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(result.code, 'NOT_MEMBERSHIP_JOIN_PAYMENT');
  assert.strictEqual(isMember(ctx, '2026-12'), true);

  ctx.stripeState.sessionsForIntent = [];
  ctx.stripeState.chargeAmount = 3000;
  assert.strictEqual(receiveAndProcess(ctx, refundEvent('evt_refund_2')).code, 'NOT_MEMBERSHIP_JOIN_PAYMENT');
});

test('Stripe照会失敗: 確定させず再試行できる（資格は変えない）', function () {
  var ctx = setup();
  joined(ctx);
  ctx.stripeState.chargeFails = true;
  var result = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(result.finalized, false);
  assert.strictEqual(result.code, 'STRIPE_LOOKUP_FAILED');
  assert.strictEqual(isMember(ctx, '2026-12'), true);

  ctx.stripeState.chargeFails = false;
  ctx.stripeState.sessionsListFails = true;
  assert.strictEqual(receiveAndProcess(ctx, refundEvent('evt_refund_1')).finalized, false);
  assert.strictEqual(isMember(ctx, '2026-12'), true);
});

test('ログ: 返金処理でStripe ID・メールアドレス・秘密鍵をLoggerへ出さない', function () {
  var ctx = setup();
  joined(ctx);
  ctx.stripeState.chargeFails = true;
  receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  var logged = ctx.globals.Logger._logs.join('\n');
  assert.ok(logged.indexOf('Charge再取得に失敗') !== -1, '失敗ログ自体は出る');
  ['ch_join', 'pi_join', CUSTOMER_ID, MEMBER_EMAIL, 'sk_test_dummy_value'].forEach(function (secret) {
    assert.strictEqual(logged.indexOf(secret), -1);
  });
});
