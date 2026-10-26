/*
 * SNB MEMBER初回入会決済の全額返金と会員資格（Issue #517）のテスト。Stripe API・Sheetsはすべてスタブ。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var membershipLookupResponse = require('./helpers/stripe-membership-mock').membershipLookupResponse;

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
/* 入会Checkoutを実際に発行したテストでは、保留中台帳の会員IDへ差し替える。 */
var joinMemberId = MEMBER_ID;

function sec(iso) { return Math.floor(Date.parse(iso) / 1000); }

var JOIN_AT = '2026-12-15T12:00:00+09:00';
var PRESTART_JOIN_AT = '2026-10-27T12:00:00+09:00';
var JAN_RENEWAL_AT = '2027-01-01T00:00:00Z';
var REFUND_AT = '2026-12-16T12:00:00+09:00';

function makeStripeResponder(state) {
  return function (url, options) {
    /* Issue #532: PaymentIntent→invoice。旧mode=payment入会Checkoutはinvoiceに紐づかない（空）。 */
    if (url.indexOf('/invoice_payments?') !== -1) {
      if (state.invoicePaymentsFails) return { responseCode: 500, body: { error: { type: 'api_error' } } };
      return { responseCode: 200, body: { object: 'list', has_more: false, data: state.invoicePayments || [] } };
    }
    if (url.indexOf('/invoices/') !== -1) {
      return { responseCode: 200, body: state.invoices[decodeURIComponent(url.split('/invoices/')[1])] };
    }
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
      if (state.subscriptionFails) return { responseCode: 400, body: { error: { type: 'invalid_request_error' } } };
      return { responseCode: 200, body: {
        id: SUBSCRIPTION_ID, status: 'active', customer: CUSTOMER_ID,
        items: { data: [{ current_period_start: sec(JOIN_AT), current_period_end: sec(JAN_RENEWAL_AT) }] }
      } };
    }
    if (url.indexOf('/checkout/sessions') !== -1 && options.method === 'post') {
      return { responseCode: 200, body: { id: 'cs_new_' + (++state.newCheckouts), url: 'https://checkout.stripe.com/c/pay/cs_new_' + state.newCheckouts, metadata: {} } };
    }
    var lookup = membershipLookupResponse(url, options, state);
    if (lookup) return lookup;
    throw new Error('未対応のURL: ' + url);
  };
}

function joinSessionBody() {
  return {
    id: JOIN_SESSION_ID, mode: 'payment', status: 'complete', payment_status: 'paid',
    amount_total: 500, currency: 'jpy', payment_intent: 'pi_join', customer: CUSTOMER_ID,
    customer_email: MEMBER_EMAIL, metadata: { orderType: 'membership', memberId: joinMemberId }
  };
}

function setup(options) {
  var opts = options || {};
  joinMemberId = MEMBER_ID;
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var stripeCalls = [];
  var stripeState = {
    chargeIntent: 'pi_join', chargeAmount: 500, amountRefunded: 500,
    sessionsForIntent: [joinSessionBody()], chargeFails: false, sessionsListFails: false, newCheckouts: 0
  };
  var responder = makeStripeResponder(stripeState);
  var clock = stubs.createControllableClock(opts.clockAt || JOIN_AT);
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ SPREADSHEET_ID: SPREADSHEET_ID, CALENDAR_ID: 'cal1', STRIPE_SECRET_KEY: 'sk_test_dummy_value',
      STRIPE_CHECKOUT_ENABLED: 'true', STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/ok', STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/ng' }),
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

/* 資格は日付（JST）で判定する（Issue #532）。月単位の既存シナリオは、その月の末日が有効かで確認する。 */
function isMember(ctx, month) {
  return ctx.sandbox.MemberRepository.isMemberOnDate(MEMBER_EMAIL, ctx.sandbox.MembershipRules.lastDateOfMonth(month));
}
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
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1, 'MemberPeriodsの行は削除・改変しない');
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
  assert.strictEqual(ctx.stripeCalls.filter(function (u) { return u.indexOf('/subscriptions') !== -1 && u.indexOf('/subscriptions?') === -1; }).length, 0, '返金済みならsubscriptionを作らない');
});

test('プレスタート: 10月入会の初回500円を全額返金すると、10月・11月の資格がどちらも無効になる', function () {
  var ctx = setup({ clockAt: PRESTART_JOIN_AT });
  joined(ctx, PRESTART_JOIN_AT);
  assert.strictEqual(isMember(ctx, '2026-10'), true);
  assert.strictEqual(isMember(ctx, '2026-11'), true);

  receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(isMember(ctx, '2026-10'), false);
  assert.strictEqual(isMember(ctx, '2026-11'), false);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1, '旧プレスタートの入会は1行のPeriod（入会日〜11/30）で、1つの返金で全体が無効になる');
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
    lines: { data: [{ amount: 500, period: { start: sec(JAN_RENEWAL_AT), end: sec(JAN_RENEWAL_AT) + 86400 * 31 } }] },
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

/* ===== 返金済み会員の再入会（Issue #522） ===== */

function checkoutPosts(ctx) {
  return ctx.stripeCalls.filter(function (u) { return u.indexOf('/checkout/sessions') !== -1 && u.indexOf(JOIN_SESSION_ID) === -1 && u.indexOf('payment_intent=') === -1; });
}

/* 入会Checkoutを発行→決済完了Webhook（subscription作成は確定失敗）→全額返金の順に実フローで進め、subscriptionなしの返金済み会員にする。 */
function refundedWithoutSubscription(ctx) {
  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true);
  joinMemberId = rowsOf(ctx, 'MemberCheckouts')[0][0];
  ctx.stripeState.subscriptionFails = true;
  var join = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(join.code, 'MEMBERSHIP_SUBSCRIPTION_CREATE_FAILED');
  var refund = receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(refund.code, 'MEMBERSHIP_REFUND_APPLIED');
  assert.strictEqual(isMember(ctx, '2026-12'), false);
}

test('再入会: 全額返金で資格が無効になりsubscriptionも無い会員は、同じメールで新しい入会Checkoutを開始できる', function () {
  var ctx = setup();
  refundedWithoutSubscription(ctx);
  var before = checkoutPosts(ctx).length;
  ctx.globals.MailApp._sentEmails.length = 0;

  var result = ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL });
  assert.strictEqual(result.success, true);
  assert.strictEqual(checkoutPosts(ctx).length, before + 1, '再入会のCheckoutが新しく発行される');
  var mails = ctx.globals.MailApp._sentEmails;
  assert.strictEqual(mails.length, 1);
  assert.ok(mails[0].body.indexOf('checkout.stripe.com') !== -1);
  assert.ok(mails[0].body.indexOf('登録済み') === -1);
  assert.strictEqual(rowsOf(ctx, 'MemberRefunds').length, 1, '履歴は削除しない');
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
});

test('再入会: 新しい入会決済は旧返金済みの支払いに引きずられず、新しい会員資格として反映される', function () {
  var ctx = setup();
  refundedWithoutSubscription(ctx);
  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true);
  var oldMemberId = joinMemberId;
  var pending = rowsOf(ctx, 'MemberCheckouts');
  assert.strictEqual(pending.length, 2);
  var newMemberId = pending[1][0];
  assert.notStrictEqual(newMemberId, oldMemberId, '旧memberIdを再利用しない');
  assert.notStrictEqual(pending[1][2], JOIN_SESSION_ID, '旧Checkout Sessionを再利用しない');

  /* 再入会の決済完了（新しいSession・新しいmemberId）。 */
  var NEW_SESSION_ID = 'cs_test_rejoin_0002';
  ctx.stripeState.subscriptionFails = false;
  var original = ctx.globals.UrlFetchApp.fetch;
  ctx.globals.UrlFetchApp.fetch = function (url, o) {
    if (url.indexOf('/checkout/sessions/' + NEW_SESSION_ID) !== -1) {
      return { getResponseCode: function () { return 200; }, getContentText: function () {
        return JSON.stringify({ id: NEW_SESSION_ID, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 500, currency: 'jpy',
          payment_intent: 'pi_join', customer: 'cus_test_0002', customer_email: MEMBER_EMAIL, metadata: { orderType: 'membership', memberId: newMemberId } });
      }, getHeaders: function () { return {}; } };
    }
    return original.call(this, url, o);
  };
  var rejoin = receiveAndProcess(ctx, { id: 'evt_rejoin_1', type: 'checkout.session.completed', created: sec(JOIN_AT) + 3600, data: { object: { id: NEW_SESSION_ID } } });
  assert.strictEqual(rejoin.code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(isMember(ctx, '2026-12'), true, '新しい支払いで資格が有効になる');
  var months = rowsOf(ctx, 'MemberPeriods');
  assert.strictEqual(months.length, 2, '旧履歴は残し、新しい行が追加される');
  assert.strictEqual(months[0][5], JOIN_SESSION_ID, '旧行は改変しない');
  assert.strictEqual(months[1][5], NEW_SESSION_ID);
  assert.strictEqual(rowsOf(ctx, 'MemberRefunds').length, 1, '旧返金履歴は残る');
});

test('二重加入防止: 再入会後に有効になった会員は、同じメールで再度入会できない', function () {
  var ctx = setup();
  joined(ctx);
  var before = checkoutPosts(ctx).length;
  ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL });
  assert.strictEqual(checkoutPosts(ctx).length, before, '有効なSubscription・当月支払いがあればCheckoutを発行しない');
});

test('二重加入防止: 全額返金済みでもsubscriptionが残る会員は再入会できない（運営が解約するまで）', function () {
  var ctx = setup();
  joined(ctx);
  receiveAndProcess(ctx, refundEvent('evt_refund_1'));
  assert.strictEqual(isMember(ctx, '2026-12'), false);
  var before = checkoutPosts(ctx).length;
  var result = ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL });
  assert.strictEqual(result.success, true, '外部応答は新規と同一');
  assert.strictEqual(checkoutPosts(ctx).length, before);
});

test('二重加入防止: 返金済み会員でも有効な保留中Checkoutがあれば二重に開始しない', function () {
  var ctx = setup();
  refundedWithoutSubscription(ctx);
  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true);
  var after = checkoutPosts(ctx).length;
  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true);
  assert.strictEqual(checkoutPosts(ctx).length, after, '保留中のうちは2本目を発行しない');
});
