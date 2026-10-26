/*
 * SNB MEMBERプレスタート（Issue #490。2026/10/26〜11/30）のテスト。Stripe・Sheets・Calendarはスタブで、本番へは一切アクセスしない。
 * 入会・決済・Webhookのセットアップは test/membership.test.js（#471）と同じ。
 */
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
var JOIN_AT = '2026-10-26T10:00:00+09:00';
var JAN_RENEWAL_AT = '2026-12-01T00:00:00Z';
var FEB_RENEWAL_AT = '2027-01-01T00:00:00Z';

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

function renewalInvoice(id, periodStartIso, overrides) {
  return Object.assign({
    id: id, object: 'invoice', billing_reason: 'subscription_cycle', status: 'paid',
    amount_paid: 500, currency: 'jpy', customer: CUSTOMER_ID,
    parent: { subscription_details: { subscription: SUBSCRIPTION_ID, metadata: { orderType: 'membership', memberId: MEMBER_ID } } },
    lines: { data: [{ amount: 500, period: { start: sec(periodStartIso), end: sec(periodStartIso) + 86400 * 30 } }] },
    status_transitions: { paid_at: sec(periodStartIso) + 5 }
  }, overrides || {});
}

function invoiceEvent(id, type, created, invoice) {
  return { id: id, type: type, created: created, data: { object: invoice } };
}

function isMember(ctx, email, month) {
  return ctx.sandbox.MemberRepository.isMemberForMonth(email, month);
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

function joinAt(ctxOptions, iso) {
  var ctx = setup(Object.assign({ clockAt: iso }, ctxOptions || {}));
  var event = joinEvent();
  event.created = sec(iso);
  var result = receiveAndProcess(ctx, event);
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'MEMBERSHIP_JOINED');
  return ctx;
}

function subscriptionBody(ctx) {
  var post = ctx.stripeCalls.filter(function (c) { return c.url.indexOf('/subscriptions') !== -1 && c.url.indexOf('/subscriptions?') === -1; });
  assert.strictEqual(post.length, 1);
  return decodeURIComponent(post[0].options.payload);
}

function monthRows(ctx) {
  return ctx.sheets.MemberMonths._rows.slice(1);
}

test('MembershipRules: プレスタート期間の入会は11月までをカバーし、アンカーは12/1 00:00 UTC。期間外は入会月のみ', function () {
  var R = setup().sandbox.MembershipRules;
  var cov = function (iso) { return JSON.parse(JSON.stringify(R.coveredMonthsForJoin(sec(iso)))); };
  assert.deepStrictEqual(cov('2026-10-26T00:00:00+09:00'), ['2026-10', '2026-11']);
  assert.deepStrictEqual(cov('2026-10-31T23:59:59+09:00'), ['2026-10', '2026-11']);
  assert.deepStrictEqual(cov('2026-11-01T00:00:00+09:00'), ['2026-11']);
  assert.deepStrictEqual(cov('2026-11-30T23:59:59+09:00'), ['2026-11']);
  assert.deepStrictEqual(cov('2026-12-01T00:00:00+09:00'), ['2026-12']);
  assert.deepStrictEqual(cov('2026-10-25T23:59:59+09:00'), ['2026-10'], 'プレスタート前は従来どおり入会月のみ');
  assert.strictEqual(R.isPrestartJoin(sec('2026-10-26T00:00:00+09:00')), true);
  assert.strictEqual(R.isPrestartJoin(sec('2026-11-30T23:59:59+09:00')), true);
  assert.strictEqual(R.isPrestartJoin(sec('2026-12-01T00:00:00+09:00')), false);
  assert.strictEqual(R.isPrestartJoin(sec('2026-10-25T23:59:59+09:00')), false);
  var dec1 = sec('2026-12-01T00:00:00Z');
  assert.strictEqual(R.renewalAnchorSecondsForJoin(sec('2026-10-26T10:00:00+09:00')), dec1);
  assert.strictEqual(R.renewalAnchorSecondsForJoin(sec('2026-11-15T10:00:00+09:00')), dec1);
  assert.strictEqual(R.renewalAnchorSecondsForJoin(sec('2026-12-15T10:00:00+09:00')), sec('2027-01-01T00:00:00Z'));
});

test('プレスタート: 10/26入会は初回500円で10月・11月が有効、12月はまだ無効。subscriptionは12/1アンカー（11/1に課金しない）', function () {
  var ctx = joinAt({}, '2026-10-26T10:00:00+09:00');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-10'), true);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-11'), true);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), false, '12月分は12/1の更新成功まで有効にならない');
  var rows = monthRows(ctx);
  assert.strictEqual(rows.length, 2);
  var total = rows.reduce(function (sum, r) { return sum + Number(r[4]); }, 0);
  assert.strictEqual(total, 500, '課金は初回500円のみ（11月分の行は0円）');
  var body = subscriptionBody(ctx);
  assert.ok(body.indexOf('billing_cycle_anchor=' + sec('2026-12-01T00:00:00Z')) !== -1);
  assert.ok(body.indexOf('proration_behavior=none') !== -1);
  assert.ok(body.indexOf('items[0][price_data][unit_amount]=500') !== -1);
});

test('プレスタート: 11月入会は従来どおり入会月（11月）のみ、アンカーは12/1', function () {
  var ctx = joinAt({}, '2026-11-20T10:00:00+09:00');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-11'), true);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-10'), false);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), false);
  assert.strictEqual(monthRows(ctx).length, 1);
  assert.ok(subscriptionBody(ctx).indexOf('billing_cycle_anchor=' + sec('2026-12-01T00:00:00Z')) !== -1);
});

test('プレスタート: 12/1以降の入会は従来どおり（入会月のみ・翌月1日アンカー）', function () {
  var ctx = joinAt({}, '2026-12-15T12:00:00+09:00');
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), false);
  assert.strictEqual(monthRows(ctx).length, 1);
  assert.ok(subscriptionBody(ctx).indexOf('billing_cycle_anchor=' + sec('2027-01-01T00:00:00Z')) !== -1);
});

test('プレスタート: 10月入会の再送でも支払い事実は重複せず、12/1の更新で12月が有効になる', function () {
  var ctx = joinAt({}, '2026-10-26T10:00:00+09:00');
  var again = joinEvent('evt_join_2');
  again.created = sec('2026-10-26T10:00:00+09:00');
  receiveAndProcess(ctx, again);
  assert.strictEqual(monthRows(ctx).length, 2);
  var res = receiveAndProcess(ctx, invoiceEvent('evt_inv_dec', 'invoice.paid', sec('2026-12-01T00:00:00Z') + 10, renewalInvoice('in_dec', '2026-12-01T00:00:00Z')));
  assert.strictEqual(res.finalized, true);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2026-12'), true);
  assert.strictEqual(isMember(ctx, MEMBER_EMAIL, '2027-01'), false);
});

test('プレスタート: 入会Checkoutメールにプレスタート条件（11/30まで・次回12/1・特典は12/1開始）を案内する', function () {
  var ctx = setup({ clockAt: '2026-10-26T10:00:00+09:00', properties: {
    STRIPE_CHECKOUT_ENABLED: 'true', STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/membership/complete.html', STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/membership/',
    BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com'
  } });
  var sent = [];
  ctx.sandbox.MailApp = { sendEmail: function (m) { sent.push(m); } };
  var r = ctx.sandbox.MembershipService.startCheckout({ email: 'new@example.com' });
  assert.strictEqual(r.success, true);
  assert.ok(sent.length >= 1);
  var body = sent[0].body;
  assert.ok(body.indexOf('11月30日まで有効') !== -1);
  assert.ok(body.indexOf('2026年12月1日') !== -1);
});

/* ===== Web表示 ===== */

var fs = require('node:fs');
var path = require('node:path');
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

test('Web（Issue #532）: 会員案内3ページ・会員条件・特商法・FAQは新規加入を入会日基準で案内し、プレスタートは既存会員向けの例外としてだけ残す', function () {
  var prestart = read('_includes/membership_prestart_ja.html');
  ['月額500円', '90日先行予約', '入会日から1か月有効', '入会日を基準に毎月自動更新', '12月1日から開始'].forEach(function (s) {
    assert.ok(prestart.indexOf(s) !== -1, s);
  });
  assert.ok(prestart.indexOf('プレスタート中') === -1, '新規加入向けの「プレスタート中」告知は終了');
  assert.ok(prestart.indexOf('初回500円で11月30日まで有効') === -1);
  ['membership/index.html', 'mens/membership/index.html', 'studio-x/membership/index.html'].forEach(function (f) {
    var html = read(f);
    assert.ok(html.indexOf('membership_prestart_ja.html') !== -1, f);
    assert.ok(html.indexOf('12月1日') !== -1, f);
    assert.ok(html.indexOf('プレスタート中') === -1, f + ' に新規向けの「プレスタート中」が残っている');
    assert.ok(html.indexOf('入会日から1か月有効') !== -1, f);
  });
  var terms = read('_includes/membership_terms_ja.html');
  assert.ok(terms.indexOf('既にプレスタートでご加入済みの会員') !== -1 && terms.indexOf('課金日は変更しません') !== -1);
  assert.ok(terms.indexOf('2026年11月30日まで有効で、2026年12月1日に更新され、以降は毎月1日に500円で更新されます') !== -1);
  assert.ok(terms.indexOf('プレスタートの新規受付は終了しました') !== -1);
  assert.ok(read('_includes/legal_ja.html').indexOf('既にプレスタートでご加入済みの会員') !== -1);
  assert.ok(read('legal/index.html').indexOf('SNB MEMBERの加入と有効期間について') !== -1);
  ['membership/complete.html', 'mens/membership/complete.html', 'studio-x/membership/complete.html'].forEach(function (f) {
    var html = read(f);
    assert.ok(html.indexOf('入会日から1か月有効です') !== -1 && html.indexOf('入会日を基準に毎月自動更新されます') !== -1, f);
    assert.ok(html.indexOf('既にプレスタートでご加入済みの会員の更新日は、従来どおり毎月1日です') !== -1, f);
    assert.ok(html.indexOf('当月末まで有効') === -1, f + ' に旧仕様');
  });
});

test('会員限定特典の開始は2026/12/1のまま（プレスタートで前倒ししない）', function () {
  var R = setup().sandbox.MembershipRules;
  assert.strictEqual(R.BENEFITS_START_MS, Date.parse('2026-12-01T00:00:00+09:00'));
  assert.strictEqual(R.isBenefitsRuleActive(Date.parse('2026-11-30T23:59:59+09:00')), false);
  assert.strictEqual(R.isBenefitsRuleActive(Date.parse('2026-12-01T00:00:00+09:00')), true);
});

/* ===== 会員資格確認UI（/membership/status/。Issue #490） ===== */

var STATUS_PROPS = {
  STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/Studio-nagoya-base/membership/complete.html',
  STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/Studio-nagoya-base/membership/',
  BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
  PERMANENT_MEMBER_EMAILS: 'forever@example.com'
};

function statusCtx(extra) {
  var ctx = setup(Object.assign({ clockAt: '2026-10-27T10:00:00+09:00', properties: Object.assign({}, STATUS_PROPS, (extra && extra.properties) || {}) }, extra && extra.options));
  var sent = [];
  ctx.sandbox.MailApp = { sendEmail: function (m) { sent.push(m); } };
  ctx.sent = sent;
  return ctx;
}

function tokenOf(mail) {
  var m = /#t=([A-Za-z0-9]+)/.exec(mail.body);
  assert.ok(m, 'メールにワンタイムリンクがある');
  return m[1];
}

function plain(x) { return JSON.parse(JSON.stringify(x)); }

test('会員資格確認: 会員でも非会員でも、確認要求への外部応答は同一でリンクメールが送られる（会員列挙の防止）', function () {
  var ctx = joinAt({ properties: STATUS_PROPS }, '2026-10-26T10:00:00+09:00');
  var sent = [];
  ctx.sandbox.MailApp = { sendEmail: function (m) { sent.push(m); } };
  var member = plain(ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER_EMAIL }));
  var stranger = plain(ctx.sandbox.MembershipService.requestStatusLink({ email: 'nobody@example.com' }));
  assert.strictEqual(member.success, true);
  assert.deepStrictEqual(member, stranger);
  assert.strictEqual(sent.length, 2);
  assert.ok(sent[0].body.indexOf('https://example.com/Studio-nagoya-base/membership/status/#t=') !== -1);
  assert.strictEqual(plain(ctx.sandbox.MembershipService.requestStatusLink({ email: 'bad' })).error.code, 'INVALID_EMAIL');
});

test('会員資格確認: 要求の応答にも台帳にもトークン本体は含まれず（ハッシュのみ保存）、ログにも出さない', function () {
  var ctx = joinAt({ properties: STATUS_PROPS }, '2026-10-26T10:00:00+09:00');
  var sent = [];
  ctx.sandbox.MailApp = { sendEmail: function (m) { sent.push(m); } };
  var res = ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER_EMAIL });
  var token = tokenOf(sent[0]);
  assert.strictEqual(JSON.stringify(res).indexOf(token), -1);
  var rows = ctx.sheets.MemberStatusTokens._rows;
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(JSON.stringify(rows).indexOf(token), -1, 'トークン本体は保存しない');
});

test('会員資格確認: プレスタート加入者はリンクを開いた本人にだけ状態を表示（有効・11/30まで・次回12/1・500円・マスク・特典の出し分け）', function () {
  var ctx = joinAt({ properties: STATUS_PROPS }, '2026-10-26T10:00:00+09:00');
  var sent = [];
  ctx.sandbox.MailApp = { sendEmail: function (m) { sent.push(m); } };
  ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER_EMAIL });
  var out = plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: tokenOf(sent[0]) }));
  assert.strictEqual(out.success, true);
  var st = out.status;
  assert.strictEqual(st.active, true);
  assert.strictEqual(st.validUntil, '2026-11-30');
  assert.strictEqual(st.nextRenewalDate, '2026-12-01');
  assert.strictEqual(st.monthlyFeeJpy, 500);
  assert.strictEqual(st.maskedEmail, 't***@e***.com');
  var by = {};
  st.benefits.forEach(function (b) { by[b.key] = b; });
  assert.strictEqual(by.advance_booking_90.available, true);
  ['pair_pack', 'shower', 'studio_x_options'].forEach(function (k) {
    assert.strictEqual(by[k].available, false, k);
    assert.strictEqual(by[k].startsOn, '2026-12-01', k);
  });
  assert.strictEqual(by.paid_equipment, undefined);
  var json = JSON.stringify(out);
  ['MBR-', CUSTOMER_ID, SUBSCRIPTION_ID, MEMBER_EMAIL, 'cus_', 'sub_'].forEach(function (s) { assert.strictEqual(json.indexOf(s), -1, s); });
});

test('会員資格確認: トークンは1回限り（使用後は無効）。期限切れ・不正・未発行も同一の汎用エラー', function () {
  var ctx = joinAt({ properties: STATUS_PROPS }, '2026-10-26T10:00:00+09:00');
  var sent = [];
  ctx.sandbox.MailApp = { sendEmail: function (m) { sent.push(m); } };
  ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER_EMAIL });
  var token = tokenOf(sent[0]);
  assert.strictEqual(plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: token })).success, true);
  var again = plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: token }));
  assert.strictEqual(again.success, false);
  assert.strictEqual(again.error.code, 'INVALID_TOKEN');
  assert.strictEqual(plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: 'x'.repeat(40) })).error.code, 'INVALID_TOKEN');
  assert.strictEqual(plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: '' })).error.code, 'INVALID_TOKEN');
  assert.strictEqual(plain(ctx.sandbox.MembershipService.verifyStatusLink({})).error.code, 'INVALID_TOKEN');

  /* 期限（30分）切れ */
  ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER_EMAIL });
  var expired = tokenOf(sent[1]);
  ctx.clock.advanceByMillis(60 * 60 * 1000);
  assert.strictEqual(plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: expired })).error.code, 'INVALID_TOKEN');
});

test('会員資格確認: 非会員は「無効」と表示される（本人確認後のみ）。有効期間・特典は返さない', function () {
  var ctx = statusCtx();
  ctx.sandbox.MembershipService.requestStatusLink({ email: 'nobody@example.com' });
  var out = plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: tokenOf(ctx.sent[0]) }));
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.status.active, false);
  assert.strictEqual(out.status.validUntil, null);
  assert.strictEqual(out.status.nextRenewalDate, null);
  assert.deepStrictEqual(out.status.benefits, []);
});

test('会員資格確認: 永久会員は通常の有効会員と同じ形で表示され、永久会員であることは返さない', function () {
  var ctx = statusCtx();
  ctx.sandbox.MembershipService.requestStatusLink({ email: 'forever@example.com' });
  var out = plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: tokenOf(ctx.sent[0]) }));
  assert.strictEqual(out.status.active, true);
  assert.strictEqual(out.status.validUntil, '2026-10-31');
  assert.strictEqual(out.status.nextRenewalDate, '2026-11-01');
  assert.ok(JSON.stringify(out).toLowerCase().indexOf('permanent') === -1);
  assert.ok(JSON.stringify(out).indexOf('永久') === -1);
});

test('会員資格確認: 台帳エラー時はfail-closed（汎用エラー・内部詳細なし・トークン未消費）', function () {
  var ctx = statusCtx();
  ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER_EMAIL });
  var token = tokenOf(ctx.sent[0]);
  var original = ctx.sandbox.MemberRepository.statusFactsForEmail;
  ctx.sandbox.MemberRepository.statusFactsForEmail = function () { throw new Error('boom: ledger broken'); };
  var out = plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: token }));
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.error.code, 'STATUS_UNAVAILABLE');
  assert.strictEqual(JSON.stringify(out).indexOf('boom'), -1);
  ctx.sandbox.MemberRepository.statusFactsForEmail = original;
  assert.strictEqual(plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: token })).success, true, '読めなかった回はトークンを消費しない');
});

test('会員資格確認: 解約済み（自動更新なし）は次回更新日なし。12/1以降は本特典が利用可になる', function () {
  var R = setup().sandbox.MembershipRules;
  var nowDec = Date.parse('2026-12-02T10:00:00+09:00');
  var s = plain(R.describeMembershipStatus('a@b.co', { paidMonths: ['2026-12'], autoRenew: false }, { nowMs: nowDec }));
  assert.strictEqual(s.active, true);
  assert.strictEqual(s.validUntil, '2026-12-31');
  assert.strictEqual(s.nextRenewalDate, null);
  assert.strictEqual(s.autoRenew, false);
  assert.ok(s.benefits.every(function (b) { return b.available === true; }));
  assert.strictEqual(R.maskEmail('taro@example.com'), 't***@e***.com');
  assert.strictEqual(R.maskEmail('bad'), '');
  assert.strictEqual(R.lastDateOfMonth('2028-02'), '2028-02-29');
});

test('会員資格確認: 要求のrate limit（同一メール10分3件）を超えると拒否する', function () {
  var ctx = statusCtx();
  var codes = [];
  for (var i = 0; i < 4; i++) codes.push(plain(ctx.sandbox.MembershipService.requestStatusLink({ email: 'rate@example.com' })));
  assert.strictEqual(codes[2].success, true);
  assert.strictEqual(codes[3].success, false);
  assert.strictEqual(codes[3].error.code, 'RATE_LIMITED');
});

test('会員資格確認: Web Appのaction経路（requestMembershipStatus / membershipStatus）がPOSTで動く', function () {
  var ctx = statusCtx();
  var res = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'requestMembershipStatus' }, postData: { contents: JSON.stringify({ email: MEMBER_EMAIL }) } }).text);
  assert.strictEqual(res.success, true);
  var out = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'membershipStatus' }, postData: { contents: JSON.stringify({ token: tokenOf(ctx.sent[0]) }) } }).text);
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.status.active, false);
});

test('Web: /membership/status/ ページとスクリプト（noindex・フラグメントのトークンを読んで即URLから消す・textContentで描画）', function () {
  var html = read('membership/status/index.html');
  assert.ok(html.indexOf('noindex') !== -1);
  assert.ok(html.indexOf('membership-status.js') !== -1);
  assert.ok(html.indexOf('membership_prestart_ja.html') !== -1);
  var js = read('scripts/membership-status.js');
  assert.ok(js.indexOf('requestMembershipStatus') !== -1 && js.indexOf("'membershipStatus'") !== -1);
  assert.ok(js.indexOf('replaceState') !== -1);
  assert.strictEqual(/innerHTML/.test(js), false);
  assert.ok(read('_includes/membership_prestart_ja.html').indexOf('/membership/status/') !== -1);
  assert.ok(read('_includes/membership_terms_ja.html').indexOf('会員資格の確認') !== -1);
});
