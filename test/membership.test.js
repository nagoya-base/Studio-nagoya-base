/*
 * SNB MEMBER（月額会員。Issue #471）のテスト。Stripe API・Sheets・Calendarはすべてスタブ/fixtureで、
 * 本番Stripeへは一切アクセスしない。
 *
 * 必須テスト（Issue #471）との対応:
 *  1. 月途中の新規入会（満額1,000円・入会日〜当月末active）
 *  2. 翌月1日の更新成功
 *  3. 更新失敗（猶予なし）
 *  4. cancel_at_period_end
 *  5. Webhook再送
 *  6. Webhook順序逆転
 *  7. mens予約（MEMBER価格でも実会員資格は付かない）
 *  8. 非会員メール（一般料金・外部APIから会員の存在を推測できない）
 *  9. 未来月予約
 * 10. 既存Booking Checkout（既存テスト群が維持されること。本ファイルでは回帰の一部のみ確認）
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

function sec(iso) { return Math.floor(Date.parse(iso) / 1000); }

/* 入会（2026/12/15 JST）。入会月=2026-12、翌月1日 00:00 UTC=2027-01-01T00:00:00Z が更新アンカー。 */
var JOIN_AT = '2026-12-15T12:00:00+09:00';
var JAN_RENEWAL_AT = '2027-01-01T00:00:00Z';
var FEB_RENEWAL_AT = '2027-02-01T00:00:00Z';

function makeStripeResponder(state, calls) {
  return function (url, options) {
    calls.push({ url: url, options: options });
    if (url.indexOf('/checkout/sessions/' + JOIN_SESSION_ID) !== -1) {
      return { responseCode: 200, body: {
        id: JOIN_SESSION_ID, mode: 'payment', status: 'complete', payment_status: state.paymentStatus,
        amount_total: state.amountTotal, currency: 'jpy', payment_intent: 'pi_join', customer: CUSTOMER_ID,
        customer_email: ' Taro@Example.com ',
        metadata: { orderType: 'membership', memberId: MEMBER_ID }
      } };
    }
    if (url.indexOf('/payment_intents/pi_join') !== -1) {
      return { responseCode: 200, body: { id: 'pi_join', status: 'succeeded', amount_received: 500, currency: 'jpy', payment_method: 'pm_saved_1' } };
    }
    if (url.indexOf('/subscriptions') !== -1 && options.method === 'post') {
      if (state.subscriptionError) return state.subscriptionError;
      if (state.subscriptionFailures > 0) {
        state.subscriptionFailures--;
        return { responseCode: 500, body: { error: { type: 'api_error' } } };
      }
      return { responseCode: 200, body: {
        id: SUBSCRIPTION_ID, status: 'active', customer: CUSTOMER_ID,
        items: { data: [{ current_period_start: sec(JOIN_AT), current_period_end: sec(JAN_RENEWAL_AT) }] }
      } };
    }
    if (url.indexOf('/checkout/sessions') !== -1 && options.method === 'post') {
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
  var stripeState = Object.assign({ paymentStatus: 'paid', amountTotal: 500, subscriptionFailures: 0 }, opts.stripeState || {});
  var stripeCalls = [];
  var clock = stubs.createControllableClock(opts.clockAt || JOIN_AT);
  var properties = Object.assign({
    SPREADSHEET_ID: SPREADSHEET_ID, CALENDAR_ID: 'cal1', STRIPE_SECRET_KEY: 'sk_test_dummy_value'
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

/* StripeEventsへ受信・永続化した状態にしてから、Booking Adminのトリガー処理を1回実行する。 */
function receiveAndProcess(ctx, event) {
  var body = JSON.stringify(event);
  var now = ctx.clock.currentDate();
  var claim = ctx.sandbox.StripeEventRepository.claim(event.id, event.type, now);
  if (claim.outcome === 'CLAIMED') ctx.sandbox.StripeEventRepository.storeRawBody(claim.rowNumber, body, now);
  var run = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  var match = run.results.filter(function (r) { return r.eventId === event.id; })[0];
  return match || { finalized: false, code: 'NOT_PROCESSED' };
}

function joinEvent(id) {
  return { id: id || 'evt_join_1', type: 'checkout.session.completed', created: sec(JOIN_AT), data: { object: { id: JOIN_SESSION_ID } } };
}

function subscriptionObject(overrides) {
  return Object.assign({
    id: SUBSCRIPTION_ID, object: 'subscription', customer: CUSTOMER_ID, status: 'active',
    cancel_at_period_end: false, canceled_at: null,
    metadata: { orderType: 'membership', memberId: MEMBER_ID },
    items: { data: [{ current_period_start: sec(JOIN_AT), current_period_end: sec(JAN_RENEWAL_AT) }] }
  }, overrides || {});
}

function subscriptionEvent(id, type, created, overrides) {
  return { id: id, type: type, created: created, data: { object: subscriptionObject(overrides) } };
}

function oneMonthLater(iso) {
  var d = new Date(Date.parse(iso));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

function renewalInvoice(id, periodStartIso, overrides) {
  return Object.assign({
    id: id, object: 'invoice', billing_reason: 'subscription_cycle', status: 'paid',
    amount_paid: 500, currency: 'jpy', customer: CUSTOMER_ID,
    parent: { subscription_details: { subscription: SUBSCRIPTION_ID, metadata: { orderType: 'membership', memberId: MEMBER_ID } } },
    lines: { data: [{ amount: 500, period: { start: sec(periodStartIso), end: sec(oneMonthLater(periodStartIso)) } }] },
    status_transitions: { paid_at: sec(periodStartIso) + 5 }
  }, overrides || {});
}

function invoiceEvent(id, type, created, invoice) {
  return { id: id, type: type, created: created, data: { object: invoice } };
}

/* 資格は日付（JST）で判定する（Issue #532）。月単位の既存シナリオは、その月の末日が有効かで確認する。 */
function isMember(ctx, email, month) {
  return ctx.sandbox.MemberRepository.isMemberOnDate(email, ctx.sandbox.MembershipRules.lastDateOfMonth(month));
}

function isMemberOn(ctx, email, date) {
  return ctx.sandbox.MemberRepository.isMemberOnDate(email, date);
}

function rowsOf(ctx, sheetName) {
  var sheet = ctx.sheets[sheetName];
  return sheet ? sheet._rows.slice(1) : [];
}

function joined(ctx) {
  var result = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'MEMBERSHIP_JOINED');
  return result;
}

/* ===== 純粋ロジック ===== */

test('MembershipRules: メール正規化・利用月・JST月境界・翌月1日UTCアンカー', function () {
  var R = setup().sandbox.MembershipRules;
  assert.strictEqual(R.normalizeEmail('  Taro@Example.COM '), 'taro@example.com');
  assert.strictEqual(R.normalizeEmail(null), '');
  assert.strictEqual(R.isValidEmail('a@b.co'), true);
  assert.strictEqual(R.isValidEmail('not-an-email'), false);
  assert.strictEqual(R.monthKeyOfDateString('2027-01-12'), '2027-01');
  assert.strictEqual(R.monthKeyOfDateString('2027/01/12'), '');
  /* 12/31 23:59 JSTは12月、1/1 00:00 JSTは1月。 */
  assert.strictEqual(R.jstMonthKeyOfEpochSeconds(sec('2026-12-31T23:59:59+09:00')), '2026-12');
  assert.strictEqual(R.jstMonthKeyOfEpochSeconds(sec('2027-01-01T00:00:00+09:00')), '2027-01');
  assert.strictEqual(R.nextMonthKey('2026-12'), '2027-01');
  assert.strictEqual(R.renewalAnchorSecondsAfterMonth('2026-12'), sec('2027-01-01T00:00:00Z'));
  assert.strictEqual(R.renewalAnchorSecondsAfterMonth('2027-01'), sec('2027-02-01T00:00:00Z'));
});

test('MembershipRules: 会費invoiceの有効期間はline itemのperiod.start〜endから決め（JSTの日付範囲）、想定外はfail-closed', function () {
  var R = setup().sandbox.MembershipRules;
  function plain(v) { return JSON.parse(JSON.stringify(v)); }
  /* 更新invoice: 1/1 00:00 UTC（=1/1 09:00 JST）〜2/1 00:00 UTC → 有効日は1/1〜1/31。 */
  var jan = R.resolvePaidPeriodOfInvoice(renewalInvoice('in_1', JAN_RENEWAL_AT));
  assert.strictEqual(jan.ok, true);
  assert.deepStrictEqual(plain(jan.range), { startDate: '2027-01-01', endDate: '2027-01-31' });
  /* 旧API versionのinvoice.period_start/endは「直前の期間」を指し得るため使わない。 */
  var old = renewalInvoice('in_2', FEB_RENEWAL_AT, { period_start: sec(JAN_RENEWAL_AT), period_end: sec(FEB_RENEWAL_AT) });
  assert.strictEqual(R.resolvePaidPeriodOfInvoice(old).range.startDate, '2027-02-01');
  /* 新規加入（subscription_create・500円）も同じ形で期間になる。入会日基準（10/26 22:40 JST〜11/26 22:40 JST → 10/26〜11/25）。 */
  var created = R.resolvePaidPeriodOfInvoice(renewalInvoice('in_c', '2026-10-26T22:40:00+09:00', { billing_reason: 'subscription_create' }));
  assert.strictEqual(created.ok, true);
  assert.deepStrictEqual(plain(created.range), { startDate: '2026-10-26', endDate: '2026-11-25' });
  assert.strictEqual(R.resolvePaidPeriodOfInvoice(renewalInvoice('in_3', JAN_RENEWAL_AT, { amount_paid: 0 })).ok, false);
  assert.strictEqual(R.resolvePaidPeriodOfInvoice(renewalInvoice('in_4', JAN_RENEWAL_AT, { status: 'open' })).ok, false);
  assert.strictEqual(R.resolvePaidPeriodOfInvoice(renewalInvoice('in_4b', JAN_RENEWAL_AT, { currency: 'usd' })).code, 'UNEXPECTED_AMOUNT');
  var noEnd = renewalInvoice('in_5', JAN_RENEWAL_AT);
  noEnd.lines.data[0].period.end = noEnd.lines.data[0].period.start;
  assert.strictEqual(R.resolvePaidPeriodOfInvoice(noEnd).code, 'NO_MONTHLY_LINE');
  /* 旧方式（プレスタート会員）のsubscription作成時の$0 invoiceと、他のbilling_reasonは無視（エラーにしない）。 */
  var zeroCreate = R.resolvePaidPeriodOfInvoice(renewalInvoice('in_6', JAN_RENEWAL_AT, { billing_reason: 'subscription_create', amount_paid: 0 }));
  assert.strictEqual(zeroCreate.ok, false);
  assert.strictEqual(zeroCreate.ignorable, true);
  assert.strictEqual(R.resolvePaidPeriodOfInvoice(renewalInvoice('in_7', JAN_RENEWAL_AT, { billing_reason: 'manual' })).ignorable, true);
});

test('MembershipRules: JST日付ヘルパー（月末・2/29・年またぎ）と有効日範囲の連続判定', function () {
  var R = setup().sandbox.MembershipRules;
  function plain(v) { return JSON.parse(JSON.stringify(v)); }
  assert.strictEqual(R.jstDateStringOfEpochSeconds(sec('2026-12-31T23:59:59+09:00')), '2026-12-31');
  assert.strictEqual(R.jstDateStringOfEpochSeconds(sec('2026-12-31T15:00:00Z')), '2027-01-01');
  assert.strictEqual(R.addDaysToDateString('2027-02-28', 1), '2027-03-01');
  assert.strictEqual(R.addDaysToDateString('2028-02-28', 1), '2028-02-29');
  assert.strictEqual(R.addDaysToDateString('2028-03-01', -1), '2028-02-29');
  assert.strictEqual(R.addDaysToDateString('bad', 1), '');
  assert.strictEqual(R.isDateString('2027-02-29'), false, '存在しない日付は不正');
  assert.strictEqual(R.isDateString('2028-02-29'), true);
  /* 1/31入会: 期間 1/31〜2/28（Stripeは月末に丸める）→ 有効日1/31〜2/27、更新後 2/28〜3/28 → 2/28〜3/27。切れ目なし。 */
  assert.deepStrictEqual(plain(R.periodToValidDateRange(sec('2027-01-31T10:00:00+09:00'), sec('2027-02-28T10:00:00+09:00'))), { startDate: '2027-01-31', endDate: '2027-02-27' });
  assert.deepStrictEqual(plain(R.periodToValidDateRange(sec('2027-02-28T10:00:00+09:00'), sec('2027-03-28T10:00:00+09:00'))), { startDate: '2027-02-28', endDate: '2027-03-27' });
  /* うるう年: 2/29入会 → 3/29更新。 */
  assert.deepStrictEqual(plain(R.periodToValidDateRange(sec('2028-02-29T10:00:00+09:00'), sec('2028-03-29T10:00:00+09:00'))), { startDate: '2028-02-29', endDate: '2028-03-28' });
  assert.strictEqual(R.periodToValidDateRange(0, 1), null);
  var ranges = [{ startDate: '2027-01-31', endDate: '2027-02-27' }, { startDate: '2027-02-28', endDate: '2027-03-27' }];
  assert.strictEqual(R.validUntilOfRanges(ranges, '2027-02-10'), '2027-03-27', '切れ目なく更新された期間は連続として最新の末日まで');
  assert.strictEqual(R.validUntilOfRanges(ranges, '2027-03-28'), '', '範囲外は空');
  assert.strictEqual(R.validUntilOfRanges([{ startDate: '2027-01-31', endDate: '2027-02-27' }, { startDate: '2027-03-05', endDate: '2027-04-04' }], '2027-02-10'), '2027-02-27', '空白がある場合は延長しない');
});

test('MembershipRules: API version差（basil以降のitems.data[]直下のperiodとparent.subscription_details）を読める', function () {
  var R = setup().sandbox.MembershipRules;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(R.readSubscriptionPeriod({ items: { data: [{ current_period_start: 10, current_period_end: 20 }] } }))), { start: 10, end: 20 });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(R.readSubscriptionPeriod({ current_period_start: 1, current_period_end: 2 }))), { start: 1, end: 2 });
  assert.strictEqual(R.readInvoiceSubscription({ subscription: 'sub_old' }).subscriptionId, 'sub_old');
  assert.strictEqual(R.readInvoiceSubscription({ parent: { subscription_details: { subscription: 'sub_new' } } }).subscriptionId, 'sub_new');
});

/* ===== 1. 月途中の新規入会 ===== */

test('入会: 月途中の入会は満額1,000円。日割りせず、入会日〜当月末が有効で翌月はまだ無効', function () {
  var ctx = setup();
  joined(ctx);

  var members = rowsOf(ctx, 'Members');
  assert.strictEqual(members.length, 1);
  var m = ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record;
  assert.strictEqual(m.email, MEMBER_EMAIL, 'メールは正規化して保存する');
  assert.strictEqual(m.stripeCustomerId, CUSTOMER_ID);
  assert.strictEqual(m.stripeSubscriptionId, SUBSCRIPTION_ID);
  assert.strictEqual(m.status, 'active');

  /* 旧mode=paymentのCheckoutの完了もMemberPeriodsへ記録する（MemberMonthsへは追記しない＝凍結。Issue #532）。 */
  assert.strictEqual(rowsOf(ctx, 'MemberMonths').length, 0);
  var periods = rowsOf(ctx, 'MemberPeriods');
  assert.strictEqual(periods.length, 1);
  assert.strictEqual(periods[0][4], 'checkout_session');
  assert.strictEqual(periods[0][6], 500, '入会月は満額500円');

  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true, '入会月は有効');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), false, '翌月分は更新の課金成功まで有効にならない');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-11'), false);
  /* 入会日（12/15 JST）から当月末まで有効。入会日より前は無効。 */
  assert.strictEqual(isMemberOn(ctx, MEMBER_EMAIL, '2026-12-14'), false);
  assert.strictEqual(isMemberOn(ctx, MEMBER_EMAIL, '2026-12-15'), true);
  assert.strictEqual(isMemberOn(ctx, MEMBER_EMAIL, '2026-12-31'), true);
  assert.strictEqual(isMemberOn(ctx, MEMBER_EMAIL, '2027-01-01'), false);

  /* subscriptionは翌月1日00:00 UTCアンカー・日割りなし・月額500円で作成する。 */
  var post = ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/subscriptions') !== -1 && c.url.indexOf('/subscriptions?') === -1; });
  assert.strictEqual(post.length, 1);
  var body = decodeURIComponent(post[0].options.payload);
  assert.ok(body.indexOf('billing_cycle_anchor=' + sec(JAN_RENEWAL_AT)) !== -1);
  assert.ok(body.indexOf('proration_behavior=none') !== -1);
  assert.ok(body.indexOf('items[0][price_data][unit_amount]=500') !== -1);
  assert.ok(body.indexOf('items[0][price_data][recurring][interval]=month') !== -1);
  assert.ok(body.indexOf('default_payment_method=pm_saved_1') !== -1);
  assert.strictEqual(post[0].options.headers['Idempotency-Key'], 'snb-membership-sub-v2-' + JOIN_SESSION_ID);
});

test('入会: 入会が月末日のJSTでも、その月が入会月になり翌月1日が更新アンカーになる', function () {
  var ctx = setup({ clockAt: '2026-12-31T23:30:00+09:00' });
  var event = joinEvent();
  event.created = sec('2026-12-31T23:30:00+09:00');
  var result = receiveAndProcess(ctx, event);
  assert.strictEqual(result.code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), false);
});

test('入会: 未決済・金額不一致は会員を作らない', function () {
  var unpaid = setup({ stripeState: { paymentStatus: 'unpaid' } });
  assert.strictEqual(receiveAndProcess(unpaid, joinEvent()).code, 'PAYMENT_NOT_YET_COMPLETE');
  assert.strictEqual(rowsOf(unpaid, 'Members').length, 0);

  var wrong = setup({ stripeState: { amountTotal: 1000 } });
  var result = receiveAndProcess(wrong, joinEvent());
  assert.strictEqual(result.code, 'MEMBERSHIP_JOIN_AMOUNT_MISMATCH');
  assert.strictEqual(rowsOf(wrong, 'Members').length, 0);
  assert.strictEqual(isMember(wrong, MEMBER_EMAIL, '2026-12'), false);
});

test('入会: subscription作成が一時失敗しても会員・入会月は重複せず、再試行で自動更新が設定される', function () {
  var ctx = setup({ stripeState: { subscriptionFailures: 1 } });
  var first = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(first.finalized, false);
  assert.strictEqual(first.code, 'SUBSCRIPTION_CREATE_RETRY');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true, '入金済みの入会月は失われない');

  var second = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(second.finalized, true);
  assert.strictEqual(second.code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(rowsOf(ctx, 'Members').length, 1);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
  assert.strictEqual(ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record.stripeSubscriptionId, SUBSCRIPTION_ID);
});

test('入会: 入会月を過ぎて処理された場合はsubscriptionを作らず要復旧にするが、入会月の資格は失われない', function () {
  var ctx = setup({ clockAt: '2027-01-02T00:00:00+09:00' });
  var result = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(result.code, 'MEMBERSHIP_JOIN_MONTH_ELAPSED');
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/subscriptions') !== -1 && c.url.indexOf('/subscriptions?') === -1; }).length, 0);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true);
});

/* ===== 2. 更新成功 ===== */

test('更新: 翌月1日の課金成功で翌月分が有効になる。翌々月はまだ無効', function () {
  var ctx = setup();
  joined(ctx);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), false);

  var paid = receiveAndProcess(ctx, invoiceEvent('evt_inv_jan', 'invoice.paid', sec(JAN_RENEWAL_AT) + 10, renewalInvoice('in_jan', JAN_RENEWAL_AT)));
  assert.strictEqual(paid.code, 'MEMBERSHIP_PERIOD_PAID');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), true);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true, '入会月の資格は維持');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-02'), false);
});

test('更新: 入会時の$0 invoice（billing_reason=subscription_create）や他商品のinvoiceは資格を作らない', function () {
  var ctx = setup();
  joined(ctx);
  var zero = renewalInvoice('in_zero', JAN_RENEWAL_AT, { billing_reason: 'subscription_create', amount_paid: 0 });
  assert.strictEqual(receiveAndProcess(ctx, invoiceEvent('evt_zero', 'invoice.paid', sec(JOIN_AT), zero)).code, 'NOT_MEMBERSHIP_PERIOD');
  var other = { id: 'in_other', billing_reason: 'subscription_cycle', status: 'paid', amount_paid: 3000, currency: 'jpy',
    parent: { subscription_details: { subscription: 'sub_other', metadata: {} } }, lines: { data: [] } };
  assert.strictEqual(receiveAndProcess(ctx, invoiceEvent('evt_other', 'invoice.paid', sec(JAN_RENEWAL_AT), other)).code, 'NOT_MEMBERSHIP');
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
});

/* ===== 3. 更新失敗 ===== */

test('更新失敗: 猶予期間なしで翌月はinactive。支払済みの当月は影響を受けない', function () {
  var ctx = setup();
  joined(ctx);
  receiveAndProcess(ctx, invoiceEvent('evt_inv_jan', 'invoice.paid', sec(JAN_RENEWAL_AT) + 10, renewalInvoice('in_jan', JAN_RENEWAL_AT)));

  var failedInvoice = renewalInvoice('in_feb_fail', FEB_RENEWAL_AT, { status: 'open', amount_paid: 0 });
  var failed = receiveAndProcess(ctx, invoiceEvent('evt_inv_feb_fail', 'invoice.payment_failed', sec(FEB_RENEWAL_AT) + 20, failedInvoice));
  assert.strictEqual(failed.code, 'MEMBERSHIP_STATE_APPLIED');

  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-02'), false, '更新失敗の月は猶予なしでinactive');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), true, '支払済みの月は有効のまま');
  var m = ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record;
  assert.strictEqual(m.status, 'past_due');
  assert.strictEqual(m.latestInvoiceId, 'in_feb_fail');
});

/* ===== 4. cancel_at_period_end ===== */

test('解約: cancel_at_period_endでも支払済みの当月末まではactive、翌月以降はinactive', function () {
  var ctx = setup();
  joined(ctx);
  receiveAndProcess(ctx, invoiceEvent('evt_inv_jan', 'invoice.paid', sec(JAN_RENEWAL_AT) + 10, renewalInvoice('in_jan', JAN_RENEWAL_AT)));

  var cancelAt = sec('2027-01-20T10:00:00+09:00');
  receiveAndProcess(ctx, subscriptionEvent('evt_sub_cancel_req', 'customer.subscription.updated', cancelAt, {
    cancel_at_period_end: true, canceled_at: cancelAt,
    items: { data: [{ current_period_start: sec(JAN_RENEWAL_AT), current_period_end: sec(FEB_RENEWAL_AT) }] }
  }));
  var requested = ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record;
  assert.strictEqual(requested.cancelAtPeriodEnd, 'TRUE');
  assert.ok(requested.canceledAt);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), true, '支払済みの当月（1月）末まではactive');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-02'), false, '翌月以降はinactive（更新の請求が作られない）');

  /* 期間末に実際に解約されたイベント。 */
  var endAt = sec(FEB_RENEWAL_AT);
  receiveAndProcess(ctx, subscriptionEvent('evt_sub_deleted', 'customer.subscription.deleted', endAt, { status: 'canceled', canceled_at: cancelAt }));
  var m = ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record;
  assert.strictEqual(m.status, 'canceled');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), true, '解約後も支払済み月は有効（日割り返金なし）');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-02'), false);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-03'), false);
});

/* ===== 5. Webhook再送 ===== */

test('再送: 同一イベントを複数回受けても会員・支払い事実・subscriptionは1回だけ', function () {
  var ctx = setup();
  var event = joinEvent('evt_join_dup');
  var first = receiveAndProcess(ctx, event);
  assert.strictEqual(first.code, 'MEMBERSHIP_JOINED');
  /* 受信（Booking Webhook）側の再送は台帳で弾かれ、処理対象にも再度ならない。 */
  var again = receiveAndProcess(ctx, event);
  assert.strictEqual(again.code, 'NOT_PROCESSED');
  assert.strictEqual(rowsOf(ctx, 'Members').length, 1);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);

  var inv = invoiceEvent('evt_inv_dup', 'invoice.paid', sec(JAN_RENEWAL_AT) + 10, renewalInvoice('in_jan', JAN_RENEWAL_AT));
  receiveAndProcess(ctx, inv);
  receiveAndProcess(ctx, inv);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 2);
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/subscriptions') !== -1 && c.url.indexOf('/subscriptions?') === -1; }).length, 1);
});

test('再送: イベントIDが異なっても同じ入会・同じ請求なら二重に記録しない', function () {
  var ctx = setup();
  joined(ctx);
  var secondJoin = receiveAndProcess(ctx, joinEvent('evt_join_other_id'));
  assert.strictEqual(secondJoin.code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(rowsOf(ctx, 'Members').length, 1);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/subscriptions') !== -1 && c.url.indexOf('/subscriptions?') === -1; }).length, 1, 'subscriptionを二重作成しない');

  receiveAndProcess(ctx, invoiceEvent('evt_inv_a', 'invoice.paid', sec(JAN_RENEWAL_AT) + 10, renewalInvoice('in_jan', JAN_RENEWAL_AT)));
  receiveAndProcess(ctx, invoiceEvent('evt_inv_b', 'invoice.paid', sec(JAN_RENEWAL_AT) + 11, renewalInvoice('in_jan', JAN_RENEWAL_AT)));
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 2);
});

/* ===== 6. Webhook順序逆転 ===== */

test('順序逆転: 古いイベントが後から届いても、新しい状態を巻き戻さない', function () {
  var ctx = setup();
  joined(ctx);
  var t = sec(FEB_RENEWAL_AT);
  /* 新しいpast_dueが先に処理され、古いactiveが後から届く。 */
  receiveAndProcess(ctx, subscriptionEvent('evt_new', 'customer.subscription.updated', t + 200, { status: 'past_due' }));
  var stale = receiveAndProcess(ctx, subscriptionEvent('evt_old', 'customer.subscription.updated', t + 100, { status: 'active' }));
  assert.strictEqual(stale.code, 'MEMBERSHIP_STATE_STALE');
  assert.strictEqual(ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record.status, 'past_due');
});

test('順序逆転: 解約済み（canceled）は終端で、古い/後着のactiveで復活しない。支払い事実は順序に依存しない', function () {
  var ctx = setup();
  joined(ctx);
  var t = sec(FEB_RENEWAL_AT);
  receiveAndProcess(ctx, subscriptionEvent('evt_del', 'customer.subscription.deleted', t, { status: 'canceled', canceled_at: t }));
  receiveAndProcess(ctx, subscriptionEvent('evt_late_active', 'customer.subscription.updated', t + 50, { status: 'active' }));
  assert.strictEqual(ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record.status, 'canceled');

  /* 更新失敗→再試行成功のinvoice.paidが、失敗イベントより先に処理されても月の資格は成立する。 */
  var ctx2 = setup();
  joined(ctx2);
  receiveAndProcess(ctx2, invoiceEvent('evt_paid_first', 'invoice.paid', sec(JAN_RENEWAL_AT) + 7200, renewalInvoice('in_jan', JAN_RENEWAL_AT)));
  receiveAndProcess(ctx2, invoiceEvent('evt_fail_later', 'invoice.payment_failed', sec(JAN_RENEWAL_AT) + 20, renewalInvoice('in_jan', JAN_RENEWAL_AT, { status: 'open', amount_paid: 0 })));
  assert.strictEqual(isMember(ctx2, MEMBER_EMAIL, '2027-01'), true);
});

/* ===== 7〜9. 予約作成での資格判定 ===== */

var FIXED_NOW = new Date('2026-12-20T12:00:00+09:00');

function bookingPayload(overrides) {
  return Object.assign({
    brand: 'snb', customerType: 'returning', date: '2026-12-28', startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: MEMBER_EMAIL, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', isMember: true
  }, overrides || {});
}

function book(ctx, overrides, now) {
  return ctx.sandbox.BookingRepository.createBooking(bookingPayload(overrides), now || FIXED_NOW);
}

test('予約: 利用月の資格がある会員はMEMBER料金。予約メールは正規化して照合し、membershipStatus=ACTIVE', function () {
  var ctx = setup();
  joined(ctx);
  var result = book(ctx, { email: 'TARO@Example.com', isMember: false });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.price.tier, 'MEMBER');
  assert.strictEqual(result.price.amount, 5500);
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record;
  assert.strictEqual(record.membershipStatus, 'ACTIVE');
  assert.strictEqual(record.priceGeneration, 'V2');
});

test('予約: 非会員メールは自己申告（isMember:true）しても一般料金。membershipStatus=INACTIVE', function () {
  var ctx = setup();
  joined(ctx);
  var result = book(ctx, { email: 'stranger@example.com', isMember: true });
  assert.strictEqual(result.price.tier, 'GENERAL');
  assert.strictEqual(result.price.amount, 6000);
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record;
  assert.strictEqual(record.membershipStatus, 'INACTIVE');
  assert.strictEqual(record.priceIsMember, false);
});

test('予約: 台帳が空・読めない場合もfail-closedで一般料金', function () {
  var ctx = setup();
  var empty = book(ctx, { isMember: true });
  assert.strictEqual(empty.price.tier, 'GENERAL');

  var broken = setup();
  broken.sandbox.MemberRepository.isMemberOnDate = function () { throw new Error('Sheets error'); };
  var result = book(broken, { isMember: true });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.price.tier, 'GENERAL');
});

test('未来月: 現在月がactiveでも、利用日の属する月の支払いが無ければMEMBER扱いにしない（予約作成月ではなく利用月で判定）', function () {
  var ctx = setup();
  joined(ctx); /* 12月分のみ支払済み。subscriptionはactive。 */

  var december = book(ctx, { date: '2026-12-28' });
  assert.strictEqual(december.price.tier, 'MEMBER', '12月利用は12月分が支払済み');

  var january = book(ctx, { date: '2027-01-12', startTime: '13:00' }, new Date('2026-12-21T12:00:00+09:00'));
  assert.strictEqual(january.price.tier, 'GENERAL', '12月中に予約した1月利用は、1月分の課金成功まで非会員扱い');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(january.bookingId).record.membershipStatus, 'INACTIVE');

  /* 1月分の課金が成功した後に作った1月利用の予約はMEMBER。 */
  receiveAndProcess(ctx, invoiceEvent('evt_inv_jan', 'invoice.paid', sec(JAN_RENEWAL_AT) + 10, renewalInvoice('in_jan', JAN_RENEWAL_AT)));
  var afterRenewal = book(ctx, { date: '2027-01-26', startTime: '10:00' }, new Date('2027-01-05T12:00:00+09:00'));
  assert.strictEqual(afterRenewal.price.tier, 'MEMBER');
});

test('mens: MEMBER料金でも実会員資格は付かない（会員台帳へ何も作らず、membershipStatusはACTIVEにならない）', function () {
  var ctx = setup();
  var result = book(ctx, { brand: 'mens', isMember: false, email: 'mens-user@example.com' });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.price.tier, 'MEMBER', 'mens導線は常にMEMBER料金');
  assert.strictEqual(result.price.amount, 5500);
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record;
  assert.strictEqual(record.priceIsMember, true, '価格優遇フラグ');
  assert.strictEqual(record.membershipStatus, 'NOT_CHECKED', '実会員資格は付与も確認もしない');
  assert.strictEqual(rowsOf(ctx, 'Members').length, 0);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 0);
  assert.strictEqual(isMember(ctx, 'mens-user@example.com', '2026-12'), false);

  /* mens予約を重ねても、SNBの会員資格には影響しない。 */
  var snb = book(ctx, { brand: 'snb', email: 'mens-user@example.com', isMember: true, startTime: '15:00' });
  assert.strictEqual(snb.price.tier, 'GENERAL');
});

test('Studio X V2は会員資格に関係なく共通料金（会員台帳を参照しない）', function () {
  var ctx = setup();
  joined(ctx);
  var result = book(ctx, { brand: 'studio_x', isMember: true });
  assert.strictEqual(result.price.tier, 'GENERAL');
  assert.strictEqual(result.price.amount, 3600, 'Issue #486: セルフ利用基本料金（平日3h）');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record.membershipStatus, 'NOT_CHECKED');
});

test('V1（〜2026/11/30作成）は従来どおり自己申告で、会員台帳を参照しない', function () {
  var ctx = setup();
  var result = book(ctx, { email: 'anyone@example.com', isMember: true, date: '2026-12-28' }, new Date('2026-11-30T12:00:00+09:00'));
  assert.strictEqual(result.price.tier, 'MEMBER');
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record;
  assert.strictEqual(record.priceGeneration, 'V1');
  assert.strictEqual(record.membershipStatus, 'NOT_CHECKED');
});

/* ===== 8. 見積りAPIから会員の存在を推測できない ===== */

test('見積りAPI: メールアドレスを受け取らず、会員・非会員で応答が変わらない（会員台帳を一切参照しない）', function () {
  var ctx = setup();
  joined(ctx);
  var run = function (extra) {
    var params = Object.assign({ action: 'estimatePrice', brand: 'snb', date: '2027-02-02', durationMinutes: '180', isMember: '1' }, extra || {});
    return ctx.sandbox.doGet({ parameter: params }).text;
  };
  var base = run();
  assert.strictEqual(run({ email: MEMBER_EMAIL }), base);
  assert.strictEqual(run({ email: 'stranger@example.com' }), base);
  assert.strictEqual(JSON.parse(base).price.tier, 'MEMBER', '見積りは自己申告の区分の料金を表示するだけ');

  /* 見積り処理の実装が会員台帳・会員リポジトリに触れていないこと。 */
  var fs = require('fs');
  var path = require('path');
  var code = fs.readFileSync(path.join(__dirname, '..', 'gas', 'booking', 'public', 'Code.gs'), 'utf8');
  var estimateBody = code.substring(code.indexOf('function handleEstimatePrice_'), code.indexOf('function parseBooleanParam_'));
  assert.ok(estimateBody.indexOf('MemberRepository') === -1 && estimateBody.indexOf('email') === -1);
});

/* ===== 入会Checkout開始 ===== */

test('入会Checkout: STRIPE_CHECKOUT_ENABLEDが有効でない限り発行しない（キルスイッチ）', function () {
  var ctx = setup({ properties: { STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/ok', STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/ng' } });
  var result = ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CHECKOUT_DISABLED');
  assert.strictEqual(ctx.stripeCalls.length, 0);
});

var CHECKOUT_PROPERTIES = {
  STRIPE_CHECKOUT_ENABLED: 'true', STRIPE_MEMBER_PRODUCT_ID: 'prod_fixture_member', STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/ok', STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/ng'
};

function checkoutPosts(ctx) {
  return ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/checkout/sessions') !== -1 && c.options.method === 'post'; });
}

test('入会受付: 金額はサーバー固定の500円・メール固定でmode=subscriptionのCheckoutを発行し、決済URLはメールでだけ伝える（Issue #532）', function () {
  var ctx = setup({ properties: CHECKOUT_PROPERTIES });
  var result = ctx.sandbox.MembershipService.startCheckout({ email: ' Taro@Example.com ', amount: 1 });
  assert.strictEqual(result.success, true);
  assert.deepStrictEqual(Object.keys(result).sort(), ['message', 'success']);
  assert.ok(JSON.stringify(result).indexOf('checkout.stripe.com') === -1, '応答に決済URLを含めない');

  var body = decodeURIComponent(checkoutPosts(ctx)[0].options.payload);
  assert.ok(body.indexOf('mode=subscription') !== -1);
  assert.ok(body.indexOf('mode=payment') === -1);
  assert.ok(body.indexOf('line_items[0][price_data][unit_amount]=500') !== -1);
  assert.ok(body.indexOf('line_items[0][price_data][recurring][interval]=month') !== -1);
  assert.ok(body.indexOf('line_items[0][price_data][product]=prod_fixture_member') !== -1, 'Script Propertiesで指定したProductに対する月額price_data（IDをコードに固定しない）');
  assert.ok(body.indexOf('customer_email=taro@example.com') !== -1);
  assert.ok(body.indexOf('metadata[orderType]=membership') !== -1);
  assert.ok(body.indexOf('expires_at=') !== -1, 'Checkoutは短時間で失効させる');
  /* Subscriptionへ明示的にmetadataを設定する（invoice.paid等が会員を識別できるように）。 */
  assert.ok(body.indexOf('subscription_data[metadata][orderType]=membership') !== -1);
  assert.ok(/subscription_data\[metadata\]\[memberId\]=MBR-/.test(body));
  /* 旧二段階方式・毎月1日固定anchorは新規加入では使わない。 */
  assert.ok(body.indexOf('setup_future_usage') === -1);
  assert.ok(body.indexOf('customer_creation') === -1);
  assert.ok(body.indexOf('billing_cycle_anchor') === -1);
  assert.ok(body.indexOf('payment_method_collection=always') !== -1);
  assert.ok(body.indexOf('submit_type') === -1, 'submit_typeはmode=paymentのみ');

  var mails = ctx.globals.MailApp._sentEmails;
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].to, 'taro@example.com');
  assert.ok(mails[0].body.indexOf('https://checkout.stripe.com/c/pay/cs_new') !== -1);
  assert.ok(mails[0].body.indexOf('入会日から1か月有効') !== -1);
  assert.ok(mails[0].body.indexOf('プレスタート') === -1, 'プレスタートの案内は新規加入に出さない');

  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: 'bad' }).error.code, 'INVALID_EMAIL');
});

test('入会受付: STRIPE_MEMBER_PRICE_ID（既存Recurring Price）があればそのPriceを使いprice_dataを送らない', function () {
  var ctx = setup({ properties: Object.assign({}, CHECKOUT_PROPERTIES, { STRIPE_MEMBER_PRICE_ID: 'price_fixture_member' }) });
  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true);
  var body = decodeURIComponent(checkoutPosts(ctx)[0].options.payload);
  assert.ok(body.indexOf('line_items[0][price]=price_fixture_member') !== -1);
  assert.ok(body.indexOf('price_data') === -1);
  assert.ok(body.indexOf('mode=subscription') !== -1);
});

test('入会受付: Price IDもProduct IDも未設定なら設定不足として安全に失敗する（固定IDにフォールバックしない。Stripeを呼ばない）', function () {
  var props = Object.assign({}, CHECKOUT_PROPERTIES);
  delete props.STRIPE_MEMBER_PRODUCT_ID;
  var ctx = setup({ properties: props });
  var res = JSON.parse(JSON.stringify(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL })));
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error.code, 'STRIPE_NOT_CONFIGURED');
  assert.strictEqual(ctx.stripeCalls.length, 0);
  assert.ok(!/snb_member_monthly/.test(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'gas/booking/shared/MembershipService.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')), '新規加入経路にProduct IDの固定値が無い');
});

test('入会受付: STRIPE_MEMBER_PRODUCT_ID指定時はその既存Productを使い、Productを新規作成しない', function () {
  var ctx = setup({ properties: Object.assign({}, CHECKOUT_PROPERTIES, { STRIPE_MEMBER_PRODUCT_ID: 'prod_fixture_member2' }) });
  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL }).success, true);
  var body = decodeURIComponent(checkoutPosts(ctx)[0].options.payload);
  assert.ok(body.indexOf('line_items[0][price_data][product]=prod_fixture_member2') !== -1);
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return /\/v1\/products$/.test(c.url); }).length, 0);
});

/* ===== 入会元ブランド別の戻り先（Issue #504） ===== */

var BRAND_PROPERTIES = {
  STRIPE_CHECKOUT_ENABLED: 'true', STRIPE_MEMBER_PRODUCT_ID: 'prod_fixture_member',
  STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/Studio-nagoya-base/membership/complete.html',
  STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/Studio-nagoya-base/membership/'
};

function checkoutReturnUrls(ctx) {
  var body = decodeURIComponent(checkoutPosts(ctx)[0].options.payload);
  return {
    success: (/success_url=([^&]*)/.exec(body) || [])[1],
    cancel: (/cancel_url=([^&]*)/.exec(body) || [])[1]
  };
}

test('入会戻り先: brand未指定・snbは既存のSNB用URLのまま（後方互換）', function () {
  ['', 'snb'].forEach(function (brand) {
    var ctx = setup({ properties: BRAND_PROPERTIES });
    var input = { email: MEMBER_EMAIL };
    if (brand) input.brand = brand;
    assert.strictEqual(ctx.sandbox.MembershipService.startCheckout(input).success, true);
    var urls = checkoutReturnUrls(ctx);
    assert.strictEqual(urls.success, 'https://example.com/Studio-nagoya-base/membership/complete.html');
    assert.strictEqual(urls.cancel, 'https://example.com/Studio-nagoya-base/membership/');
  });
});

test('入会戻り先: mens / studio_x はサーバー側でブランド別パスへ解決する', function () {
  [['mens', '/mens'], ['studio_x', '/studio-x']].forEach(function (pair) {
    var ctx = setup({ properties: BRAND_PROPERTIES });
    assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL, brand: pair[0] }).success, true);
    var urls = checkoutReturnUrls(ctx);
    assert.strictEqual(urls.success, 'https://example.com/Studio-nagoya-base' + pair[1] + '/membership/complete.html');
    assert.strictEqual(urls.cancel, 'https://example.com/Studio-nagoya-base' + pair[1] + '/membership/');
  });
});

test('入会戻り先: ブランド別Script Propertyがあれば優先し、導出できないときはSNBへ黙ってフォールバックしない', function () {
  var ctx = setup({ properties: Object.assign({}, BRAND_PROPERTIES, {
    STRIPE_MEMBERSHIP_SUCCESS_URL_MENS: 'https://example.com/m/ok', STRIPE_MEMBERSHIP_CANCEL_URL_MENS: 'https://example.com/m/ng'
  }) });
  assert.strictEqual(ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL, brand: 'mens' }).success, true);
  assert.deepStrictEqual(checkoutReturnUrls(ctx), { success: 'https://example.com/m/ok', cancel: 'https://example.com/m/ng' });

  var bad = setup({ properties: CHECKOUT_PROPERTIES });
  var result = bad.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL, brand: 'studio_x' });
  assert.strictEqual(result.error.code, 'STRIPE_NOT_CONFIGURED');
  assert.strictEqual(checkoutPosts(bad).length, 0);
});

test('入会戻り先: 許可外のbrand（URL等の任意文字列）は拒否し、Stripeへ渡さない', function () {
  ['https://evil.example/', 'MENS', 'constructor', '__proto__', 'toString', 5, {}].forEach(function (brand) {
    var ctx = setup({ properties: BRAND_PROPERTIES });
    var result = ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL, brand: brand, successUrl: 'https://evil.example/' });
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.code, 'INVALID_BRAND');
    assert.strictEqual(ctx.stripeCalls.length, 0);
  });
});

test('入会戻り先: doPostはbrandだけを渡し、クライアント指定のURLは使わない', function () {
  var ctx = setup({ properties: BRAND_PROPERTIES });
  var res = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'startMembershipCheckout' }, postData: { contents: JSON.stringify({
    email: MEMBER_EMAIL, brand: 'mens', successUrl: 'https://evil.example/ok', cancelUrl: 'https://evil.example/ng'
  }) } }).text);
  assert.strictEqual(res.success, true);
  var urls = checkoutReturnUrls(ctx);
  assert.ok(urls.success.indexOf('evil.example') === -1 && urls.cancel.indexOf('evil.example') === -1);
  assert.strictEqual(urls.success, 'https://example.com/Studio-nagoya-base/mens/membership/complete.html');
});

test('二重加入防止: 既存会員（当月支払済み/subscription有効）にはCheckoutを発行せず、応答は新規と同一でメールだけが異なる', function () {
  var ctx = setup({ properties: CHECKOUT_PROPERTIES });
  joined(ctx);
  var before = checkoutPosts(ctx).length;

  var existing = ctx.sandbox.MembershipService.startCheckout({ email: 'TARO@example.com' });
  var fresh = ctx.sandbox.MembershipService.startCheckout({ email: 'newcomer@example.com' });
  assert.strictEqual(JSON.stringify(existing), JSON.stringify(fresh), '外部応答から既存会員か判別できない');

  assert.strictEqual(checkoutPosts(ctx).length, before + 1, '新しいCheckoutは新規メールの1件だけ');
  var mails = ctx.globals.MailApp._sentEmails;
  assert.strictEqual(mails.length, 2);
  assert.strictEqual(mails[0].to, 'taro@example.com');
  assert.ok(mails[0].body.indexOf('checkout.stripe.com') === -1);
  assert.ok(mails[0].body.indexOf('登録済み') !== -1);
  assert.ok(mails[1].body.indexOf('checkout.stripe.com') !== -1);
});

test('二重加入防止: 当月の支払い事実だけがある（subscription未作成）会員も再入会できない', function () {
  var ctx = setup({ properties: CHECKOUT_PROPERTIES, stripeState: { subscriptionFailures: 5 } });
  receiveAndProcess(ctx, joinEvent()); /* subscription作成は失敗中だが入会月は支払済み。 */
  ctx.sandbox.MembershipService.startCheckout({ email: MEMBER_EMAIL });
  assert.strictEqual(checkoutPosts(ctx).length, 0);
});

test('二重加入防止: 同一メールの連続・並行入会でも発行するCheckoutは1件だけ（保留中マーク）', function () {
  var ctx = setup({ properties: CHECKOUT_PROPERTIES });
  var first = ctx.sandbox.MembershipService.startCheckout({ email: 'dup@example.com' });
  var second = ctx.sandbox.MembershipService.startCheckout({ email: 'DUP@example.com' });
  assert.strictEqual(JSON.stringify(first), JSON.stringify(second));
  assert.strictEqual(checkoutPosts(ctx).length, 1);
  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 1);
});

test('二重課金防止: CacheServiceが消えても、永続台帳（MemberCheckouts）の保留中があれば2本目のCheckoutを発行しない', function () {
  var ctx = setup({ properties: CHECKOUT_PROPERTIES });
  ctx.sandbox.MembershipService.startCheckout({ email: 'cache@example.com' });
  assert.strictEqual(checkoutPosts(ctx).length, 1);
  var pendingRows = ctx.sheets.MemberCheckouts._rows;
  assert.strictEqual(pendingRows.length, 2, 'ヘッダー＋保留中1行');
  assert.strictEqual(pendingRows[1][1], 'cache@example.com');
  assert.strictEqual(pendingRows[1][2], 'cs_new', 'checkoutSessionIdを記録');
  assert.strictEqual(pendingRows[1][4], 'PENDING');

  /* CacheService（レート制限含む）の全消失を再現する。 */
  ctx.sandbox.CacheService = stubs.createCacheServiceStub();
  var again = ctx.sandbox.MembershipService.startCheckout({ email: 'cache@example.com' });
  assert.strictEqual(again.success, true);
  assert.strictEqual(checkoutPosts(ctx).length, 1, 'キャッシュが消えても2本目を発行しない');
});

test('二重課金防止: 保留中はCheckout失効＋Webhook猶予（45分）を過ぎると解除され、再発行できる', function () {
  var ctx = setup({ properties: CHECKOUT_PROPERTIES });
  ctx.sandbox.MembershipService.startCheckout({ email: 'late@example.com' });
  ctx.clock.advanceByMillis(44 * 60 * 1000);
  ctx.sandbox.CacheService = stubs.createCacheServiceStub();
  ctx.sandbox.MembershipService.startCheckout({ email: 'late@example.com' });
  assert.strictEqual(checkoutPosts(ctx).length, 1);
  ctx.clock.advanceByMillis(2 * 60 * 1000);
  ctx.sandbox.CacheService = stubs.createCacheServiceStub();
  ctx.sandbox.MembershipService.startCheckout({ email: 'late@example.com' });
  assert.strictEqual(checkoutPosts(ctx).length, 2);
});

test('二重課金防止: 決済完了Webhookで保留中は完了扱いになる。Stripeの確定的な失敗では解放し、応答不明では解放しない', function () {
  var ctx = setup({ properties: CHECKOUT_PROPERTIES });
  /* 入会Checkoutと同じmemberIdで保留中を作ってから、決済完了を処理する。 */
  ctx.sandbox.MemberRepository.addPending({ memberId: MEMBER_ID, email: MEMBER_EMAIL, pendingUntil: new Date(Date.parse(JOIN_AT) + 3600000) }, new Date());
  joined(ctx);
  assert.strictEqual(ctx.sheets.MemberCheckouts._rows[1][4], 'COMPLETED');

  var failing = setup({ properties: CHECKOUT_PROPERTIES });
  var original = failing.sandbox.UrlFetchApp.fetch;
  var mode = { code: 400, type: 'invalid_request_error' };
  failing.sandbox.UrlFetchApp.fetch = function (url, options) {
    if (url.indexOf('/checkout/sessions') !== -1 && options.method === 'post') {
      return { getResponseCode: function () { return mode.code; }, getContentText: function () { return JSON.stringify({ error: { type: mode.type } }); } };
    }
    return original(url, options);
  };
  assert.strictEqual(failing.sandbox.MembershipService.startCheckout({ email: 'err@example.com' }).success, false);
  assert.strictEqual(failing.sheets.MemberCheckouts._rows[1][4], 'EXPIRED', '確定的な失敗は解放');

  mode = { code: 500, type: 'api_error' };
  failing.sandbox.MembershipService.startCheckout({ email: 'amb@example.com' });
  assert.strictEqual(failing.sheets.MemberCheckouts._rows[2][4], 'PENDING', '応答不明は決済可能なSessionが残る恐れがあり解放しない');
});

test('二重加入防止: ロックを取れない並行リクエストはCheckoutを発行しない', function () {
  var ctx = setup({ properties: CHECKOUT_PROPERTIES });
  /* 別実行がロック保持中を再現する。 */
  var holder = ctx.globals.LockService.getScriptLock();
  assert.strictEqual(holder.tryLock(1), true);
  var result = ctx.sandbox.MembershipService.startCheckout({ email: 'race@example.com' });
  assert.strictEqual(result.success, false);
  assert.strictEqual(checkoutPosts(ctx).length, 0);
  holder.releaseLock();
});

test('二重加入防止（Webhook最終防御）: 同一メール・同一月の二重決済は会員もsubscriptionも作らず要復旧にする', function () {
  var ctx = setup();
  joined(ctx);
  var subCalls = function () { return ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/subscriptions') !== -1 && c.url.indexOf('/subscriptions?') === -1; }).length; };
  assert.strictEqual(subCalls(), 1);

  /* 別の入会Checkout（別memberId・別Session）が同じメールで決済された。 */
  var responder = ctx.sandbox.UrlFetchApp.fetch;
  ctx.sandbox.UrlFetchApp.fetch = function (url, options) {
    if (url.indexOf('/checkout/sessions/cs_second') !== -1) {
      return { getResponseCode: function () { return 200; }, getContentText: function () {
        return JSON.stringify({ id: 'cs_second', mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 500, currency: 'jpy',
          payment_intent: 'pi_join', customer: 'cus_second', customer_email: 'taro@example.com', metadata: { orderType: 'membership', memberId: 'MBR-second' } });
      } };
    }
    return responder(url, options);
  };
  var result = receiveAndProcess(ctx, { id: 'evt_second', type: 'checkout.session.completed', created: sec(JOIN_AT) + 60, data: { object: { id: 'cs_second' } } });
  assert.strictEqual(result.code, 'MEMBERSHIP_DUPLICATE_JOIN');
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(rowsOf(ctx, 'Members').length, 1);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
  assert.strictEqual(subCalls(), 1, '二重にsubscriptionを作らない');
  var recorded = Object.keys(ctx.sheets).some(function (name) {
    return ctx.sheets[name]._rows.some(function (row) { return row.indexOf('STRIPE_WEBHOOK_MEMBERSHIP_DUPLICATE_JOIN') !== -1; });
  });
  assert.ok(recorded, '返金確認のためRecoveryへ記録');
});

test('二重加入防止（Webhook最終防御）: 自分自身の入会イベントの再送・再試行は重複扱いにしない', function () {
  var ctx = setup({ stripeState: { subscriptionFailures: 1 } });
  assert.strictEqual(receiveAndProcess(ctx, joinEvent()).code, 'SUBSCRIPTION_CREATE_RETRY');
  assert.strictEqual(receiveAndProcess(ctx, joinEvent()).code, 'MEMBERSHIP_JOINED');
});

/* ===== ログ・既存経路 ===== */

test('ログ: 会員処理でメールアドレス・Stripe ID・秘密鍵をLoggerへ出さない', function () {
  var ctx = setup({ stripeState: { subscriptionFailures: 1 } });
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, invoiceEvent('evt_x', 'invoice.paid', sec(JAN_RENEWAL_AT) + 10, renewalInvoice('in_x', JAN_RENEWAL_AT, { amount_paid: 1 })));
  var logs = ctx.globals.Logger._logs.join('\n');
  assert.ok(logs.indexOf('taro@example.com') === -1);
  assert.ok(logs.indexOf('sk_test') === -1);
  assert.ok(logs.indexOf(CUSTOMER_ID) === -1);
});

test('既存: 部屋予約のCheckout完了イベントは会員経路に入らない（metadata.orderTypeが無ければ従来の照合）', function () {
  var ctx = setup();
  var original = ctx.globals.UrlFetchApp;
  assert.ok(original);
  var event = { id: 'evt_booking', type: 'checkout.session.completed', created: sec(JOIN_AT), data: { object: { id: 'cs_booking' } } };
  var customFetch = ctx.sandbox.UrlFetchApp.fetch;
  ctx.sandbox.UrlFetchApp.fetch = function (url, options) {
    if (url.indexOf('/checkout/sessions/cs_booking') !== -1) {
      return { getResponseCode: function () { return 200; }, getContentText: function () {
        return JSON.stringify({ id: 'cs_booking', status: 'complete', payment_status: 'paid', amount_total: 8000, currency: 'jpy', payment_intent: 'pi_b', metadata: {} });
      } };
    }
    return customFetch(url, options);
  };
  var result = receiveAndProcess(ctx, event);
  assert.notStrictEqual(result.code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(rowsOf(ctx, 'Members').length, 0);
});

/* ===== Issue #528: Subscription作成のリクエスト構造・既存確認・診断 ===== */

function subscriptionPosts(ctx) {
  return ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/subscriptions') !== -1 && c.url.indexOf('/subscriptions?') === -1; });
}

test('#528 リクエスト構造: subscriptionのprice_dataはproduct_dataではなくProduct IDを渡す（subscriptions APIはproduct_data非対応）', function () {
  var ctx = setup();
  assert.strictEqual(receiveAndProcess(ctx, joinEvent()).code, 'MEMBERSHIP_JOINED');
  var posts = subscriptionPosts(ctx);
  assert.strictEqual(posts.length, 1);
  var body = decodeURIComponent(posts[0].options.payload);
  assert.ok(body.indexOf('items[0][price_data][product]=snb_member_monthly') !== -1);
  assert.strictEqual(body.indexOf('product_data'), -1, 'subscriptionではproduct_dataを送らない');
  assert.ok(body.indexOf('metadata[memberId]=' + MEMBER_ID) !== -1);
});

test('#528 Product未作成なら固定IDで作成してからsubscriptionを作る。作成済みなら再作成しない', function () {
  var ctx = setup({ stripeState: { productMissing: true } });
  assert.strictEqual(receiveAndProcess(ctx, joinEvent()).code, 'MEMBERSHIP_JOINED');
  var productPosts = ctx.stripeCalls.filter(function (c) { return /\/v1\/products$/.test(c.url) && c.options.method === 'post'; });
  assert.strictEqual(productPosts.length, 1);
  var productBody = decodeURIComponent(productPosts[0].options.payload);
  assert.ok(productBody.indexOf('id=snb_member_monthly') !== -1);
  assert.strictEqual(subscriptionPosts(ctx).length, 1);

  var again = setup();
  receiveAndProcess(again, joinEvent());
  assert.strictEqual(again.stripeCalls.filter(function (c) { return /\/v1\/products$/.test(c.url); }).length, 0);
});

function existingSubscription(overrides) {
  return Object.assign({
    id: SUBSCRIPTION_ID, status: 'active', metadata: { orderType: 'membership', memberId: MEMBER_ID },
    cancel_at_period_end: false, cancel_at: null, pause_collection: null, collection_method: 'charge_automatically',
    items: { data: [{ quantity: 1,
      price: { unit_amount: 500, currency: 'jpy', product: 'snb_member_monthly', recurring: { interval: 'month', interval_count: 1 } },
      current_period_start: sec(JOIN_AT), current_period_end: sec(JAN_RENEWAL_AT) }] }
  }, overrides || {});
}

test('#528 Stripeに同じ会員のsubscriptionが既にあれば作成せず台帳へ紐付ける（保存失敗後の再処理・二重作成防止）', function () {
  var ctx = setup({ stripeState: { existingSubscriptions: [existingSubscription()] } });
  var result = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(result.code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(subscriptionPosts(ctx).length, 0, '既存があれば作成しない');
  assert.strictEqual(ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record.stripeSubscriptionId, SUBSCRIPTION_ID);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
});

test('#528 既存subscriptionが自動更新の条件を満たさなければ新規作成も採用もせず要復旧にする', function () {
  var price = function (o) { return { items: { data: [{ quantity: 1,
    price: Object.assign({ unit_amount: 500, currency: 'jpy', product: 'snb_member_monthly', recurring: { interval: 'month', interval_count: 1 } }, o),
    current_period_end: sec(JAN_RENEWAL_AT) }] } }; };
  var periodEnd = function (iso) { var o = existingSubscription(); o.items.data[0].current_period_end = sec(iso); return { items: o.items }; };
  var cases = {
    incomplete: { status: 'incomplete' },
    paused: { pause_collection: { behavior: 'void' } },
    cancelAtPeriodEnd: { cancel_at_period_end: true },
    otherOrderType: { metadata: { orderType: 'other', memberId: MEMBER_ID } },
    annual1000: price({ unit_amount: 1000, recurring: { interval: 'year', interval_count: 1 } }),
    otherProduct: price({ product: 'prod_other' }),
    sendInvoice: { collection_method: 'send_invoice' },
    wrongAnchorNov15: periodEnd('2026-11-15T00:00:00Z'),
    noNextBilling: { items: { data: [{ quantity: 1, price: { unit_amount: 500, currency: 'jpy', product: 'snb_member_monthly', recurring: { interval: 'month' } } }] } }
  };
  Object.keys(cases).forEach(function (name) {
    var ctx = setup({ stripeState: { existingSubscriptions: [existingSubscription(cases[name])] } });
    var result = receiveAndProcess(ctx, joinEvent());
    assert.strictEqual(result.code, 'MEMBERSHIP_EXISTING_SUBSCRIPTION_INVALID', name);
    assert.strictEqual(subscriptionPosts(ctx).length, 0, name + ': 新規作成しない');
    assert.strictEqual(ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record.stripeSubscriptionId || '', '', name + ': 台帳に紐付けない');
    assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true, name + ': 初回分の資格は維持');
  });
});

test('#528 STRIPE_MEMBER_PRODUCT_ID指定時はその既存Productで作成し、Productを新規作成しない。存在しなければ要復旧', function () {
  var ctx = setup({ properties: { STRIPE_MEMBER_PRODUCT_ID: 'prod_existing1' } });
  assert.strictEqual(receiveAndProcess(ctx, joinEvent()).code, 'MEMBERSHIP_JOINED');
  var body = decodeURIComponent(subscriptionPosts(ctx)[0].options.payload);
  assert.ok(body.indexOf('items[0][price_data][product]=prod_existing1') !== -1);
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return /\/v1\/products$/.test(c.url); }).length, 0);

  var missing = setup({ properties: { STRIPE_MEMBER_PRODUCT_ID: 'prod_existing1' }, stripeState: { productMissing: true } });
  assert.strictEqual(receiveAndProcess(missing, joinEvent()).code, 'MEMBERSHIP_SUBSCRIPTION_CREATE_FAILED');
  assert.strictEqual(missing.stripeCalls.filter(function (c) { return /\/v1\/products$/.test(c.url); }).length, 0, '指定Productは自動作成しない');
  assert.strictEqual(subscriptionPosts(missing).length, 0);
});

test('#528 キャンセル済みや別会員のsubscriptionは既存扱いにせず、新規作成する', function () {
  var ctx = setup({ stripeState: { existingSubscriptions: [
    { id: 'sub_old', status: 'canceled', metadata: { memberId: MEMBER_ID } },
    { id: 'sub_other', status: 'active', metadata: { memberId: 'MBR-other' } }
  ] } });
  assert.strictEqual(receiveAndProcess(ctx, joinEvent()).code, 'MEMBERSHIP_JOINED');
  assert.strictEqual(subscriptionPosts(ctx).length, 1);
  assert.strictEqual(ctx.sandbox.MemberRepository.findMember({ memberId: MEMBER_ID }).record.stripeSubscriptionId, SUBSCRIPTION_ID);
});

test('#528 既存subscriptionの照会に失敗（応答不明）したら作成せず再試行する。初回分の資格は維持される', function () {
  var ctx = setup();
  var base = ctx.globals.UrlFetchApp.fetch;
  ctx.globals.UrlFetchApp.fetch = function (url, o) {
    if (url.indexOf('/v1/subscriptions?') !== -1) return { getResponseCode: function () { return 503; }, getContentText: function () { return '{}'; } };
    return base(url, o);
  };
  var result = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(result.finalized, false);
  assert.strictEqual(result.code, 'SUBSCRIPTION_CREATE_RETRY');
  assert.strictEqual(subscriptionPosts(ctx).length, 0);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true);
});

test('#528 subscription作成の確定的な失敗: 初回分の資格は維持し要復旧にする。ログはstatus/type/code/paramのみでID・秘密鍵を出さない', function () {
  var ctx = setup({ stripeState: { subscriptionError: { responseCode: 400, body: { error: {
    type: 'invalid_request_error', code: 'parameter_unknown', param: 'items[0][price_data][product_data]',
    message: 'Received unknown parameter for cus_secretid123 sk_test_dummy_value' } } } } });
  var result = receiveAndProcess(ctx, joinEvent());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'MEMBERSHIP_SUBSCRIPTION_CREATE_FAILED');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true, '初回支払済みの資格は取り消さない');
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
  var logs = ctx.globals.Logger._logs.map(String).filter(function (l) { return l.indexOf('subscription作成に失敗') !== -1; });
  assert.strictEqual(logs.length, 1);
  assert.ok(logs[0].indexOf('httpStatus=400') !== -1);
  assert.ok(logs[0].indexOf('stripeErrorType=invalid_request_error') !== -1);
  assert.ok(logs[0].indexOf('stripeErrorCode=parameter_unknown') !== -1);
  assert.ok(logs[0].indexOf('stripeErrorParam=items[0][price_data][product_data]') !== -1);
  assert.strictEqual(logs[0].indexOf('cus_secretid123'), -1);
  assert.strictEqual(logs[0].indexOf('sk_test_dummy_value'), -1);
});

test('#528 再送: 同じ入会イベントを再処理してもsubscription・会員月は重複せず、初回の再課金も発生しない', function () {
  var ctx = setup();
  receiveAndProcess(ctx, joinEvent());
  receiveAndProcess(ctx, joinEvent('evt_join_dup'));
  assert.strictEqual(subscriptionPosts(ctx).length, 1);
  assert.strictEqual(rowsOf(ctx, 'MemberPeriods').length, 1);
  assert.strictEqual(ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/checkout/sessions') !== -1 && c.options.method === 'post'; }).length, 0);
});

test('#528 既存subscriptionの請求日: プレスタート入会は12/1のみ可（11/15は不可）。アンカー経過後の復旧はその時点の次の月初', function () {
  var R = setup().sandbox.MembershipRules;
  var sub = function (endIso, overrides) {
    var o = existingSubscription(Object.assign({ metadata: { orderType: 'membership', memberId: MEMBER_ID } }, overrides || {}));
    o.items.data[0].current_period_end = sec(endIso);
    return JSON.parse(JSON.stringify(o));
  };
  var problems = function (obj, nowIso, joinIso) {
    return Array.from(R.existingSubscriptionProblems(obj, 'snb_member_monthly', sec(nowIso), sec(joinIso)));
  };
  var OCT = '2026-10-26T10:00:00+09:00';
  assert.deepStrictEqual(problems(sub('2026-12-01T00:00:00Z'), OCT, OCT), []);
  assert.deepStrictEqual(problems(sub('2026-11-15T00:00:00Z'), OCT, OCT), ['billing_anchor']);
  assert.deepStrictEqual(problems(sub('2026-11-01T00:00:00Z'), OCT, OCT), ['billing_anchor'], '11/1追加課金は不可');
  assert.deepStrictEqual(problems(sub('2026-12-01T00:00:00Z', { collection_method: 'send_invoice' }), OCT, OCT), ['collection_method']);
  /* 12/1以降に復旧する場合は、その時点の次の月初（1/1）が正しい。 */
  assert.deepStrictEqual(problems(sub('2027-01-01T00:00:00Z'), '2026-12-10T10:00:00+09:00', OCT), []);
  assert.deepStrictEqual(problems(sub('2027-01-15T00:00:00Z'), '2026-12-10T10:00:00+09:00', OCT), ['billing_anchor']);
});
