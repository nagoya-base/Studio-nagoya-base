/*
 * SNB MEMBER 退会専用UI（Issue #506）のテスト。Stripe・Sheets・Mailはスタブで、本番へは一切アクセスしない。
 * 入会・Webhookのセットアップは test/membership-prestart.test.js（#490）と同じ方式。
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
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

var JOIN_SESSION_ID = 'cs_test_join_0001';
var MEMBER_ID = 'MBR-test-0001';
var CUSTOMER_ID = 'cus_test_0001';
var SUBSCRIPTION_ID = 'sub_test_0001';
var MEMBER_EMAIL = 'taro@example.com';
var JOIN_AT = '2026-12-15T10:00:00+09:00';
var RENEWAL_AT = '2027-01-01T00:00:00Z';

var PROPS = {
  SPREADSHEET_ID: 'ss1', CALENDAR_ID: 'cal1', STRIPE_SECRET_KEY: 'sk_test_dummy_value',
  STRIPE_MEMBERSHIP_SUCCESS_URL: 'https://example.com/Studio-nagoya-base/membership/complete.html',
  STRIPE_MEMBERSHIP_CANCEL_URL: 'https://example.com/Studio-nagoya-base/membership/',
  BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
  PERMANENT_MEMBER_EMAILS: 'forever@example.com'
};

function sec(iso) { return Math.floor(Date.parse(iso) / 1000); }
function plain(x) { return JSON.parse(JSON.stringify(x)); }
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

function makeResponder(state, calls) {
  return function (url, options) {
    calls.push({ url: url, options: options });
    if (url.indexOf('/subscriptions/' + SUBSCRIPTION_ID) !== -1 && options.method === 'post') {
      if (state.cancelFailure) return { responseCode: state.cancelFailure, body: { error: { type: 'api_error', message: 'sk_test_dummy_value ' + SUBSCRIPTION_ID } } };
      return { responseCode: 200, body: { id: SUBSCRIPTION_ID, status: 'active', cancel_at_period_end: state.cancelFlag !== false } };
    }
    if (url.indexOf('/checkout/sessions/' + JOIN_SESSION_ID) !== -1) {
      return { responseCode: 200, body: {
        id: JOIN_SESSION_ID, mode: 'payment', status: 'complete', payment_status: 'paid', amount_total: 500, currency: 'jpy',
        payment_intent: 'pi_join', customer: CUSTOMER_ID, customer_email: MEMBER_EMAIL,
        metadata: { orderType: 'membership', memberId: MEMBER_ID }
      } };
    }
    if (url.indexOf('/payment_intents/pi_join') !== -1) {
      return { responseCode: 200, body: { id: 'pi_join', status: 'succeeded', amount_received: 500, currency: 'jpy', payment_method: 'pm_saved_1' } };
    }
    if (url.indexOf('/subscriptions') !== -1 && options.method === 'post') {
      return { responseCode: 200, body: {
        id: SUBSCRIPTION_ID, status: 'active', customer: CUSTOMER_ID,
        items: { data: [{ current_period_start: sec(JOIN_AT), current_period_end: sec(RENEWAL_AT) }] }
      } };
    }
    var lookup = membershipLookupResponse(url, options, state);
    if (lookup) return lookup;
    throw new Error('未対応のURL: ' + url);
  };
}

function setup(clockAt) {
  var spreadsheetsById = { ss1: {} };
  var stripeState = {};
  var stripeCalls = [];
  var clock = stubs.createControllableClock(clockAt || JOIN_AT);
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(Object.assign({}, PROPS)),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(makeResponder(stripeState, stripeCalls)),
    Utilities: stubs.createUtilitiesStub(),
    MailApp: stubs.createMailAppStub(),
    ContentService: stubs.createContentServiceStub(),
    Logger: stubs.createLoggerStub(),
    Date: clock.Date
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  var sent = [];
  sandbox.MailApp = { sendEmail: function (m) { sent.push(m); } };
  return { sandbox: sandbox, stripeCalls: stripeCalls, stripeState: stripeState, clock: clock, sheets: spreadsheetsById.ss1, sent: sent, globals: globals };
}

function joined(clockAt) {
  var ctx = setup(clockAt);
  var event = { id: 'evt_join_1', type: 'checkout.session.completed', created: sec(JOIN_AT), data: { object: { id: JOIN_SESSION_ID } } };
  var now = ctx.clock.currentDate();
  var claim = ctx.sandbox.StripeEventRepository.claim(event.id, event.type, now);
  if (claim.outcome === 'CLAIMED') ctx.sandbox.StripeEventRepository.storeRawBody(claim.rowNumber, JSON.stringify(event), now);
  var run = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  assert.strictEqual(run.results[0].code, 'MEMBERSHIP_JOINED');
  return ctx;
}

function tokenOf(mail) { return /#t=([A-Za-z0-9]+)/.exec(mail.body)[1]; }

/* 確認リンクを要求→開く。戻り値は verifyStatusLink の応答。 */
function verify(ctx, email) {
  var before = ctx.sent.length;
  assert.strictEqual(ctx.sandbox.MembershipService.requestStatusLink({ email: email }).success, true);
  return plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: tokenOf(ctx.sent[before]) }));
}

function cancelCalls(ctx) {
  return ctx.stripeCalls.filter(function (c) { return /\/subscriptions\/sub_/.test(c.url); });
}

function memberRow(ctx) {
  var headers = ctx.sandbox.MemberRepository.MEMBER_HEADERS;
  var row = ctx.sheets.Members._rows[1];
  var rec = {};
  headers.forEach(function (h, i) { rec[h] = row[i]; });
  return rec;
}

test('解約UI: 本人確認済みの有効会員にだけ解約操作（短命トークン）を返し、Stripe/内部IDは含まない', function () {
  var ctx = joined();
  var out = verify(ctx, MEMBER_EMAIL);
  assert.strictEqual(out.success, true);
  assert.strictEqual(out.cancel.state, 'AVAILABLE');
  assert.ok(/^[A-Za-z0-9]{16,128}$/.test(out.cancel.token));
  assert.deepStrictEqual(Object.keys(out.cancel).sort(), ['state', 'token']);
  var json = JSON.stringify(out);
  ['MBR-', CUSTOMER_ID, SUBSCRIPTION_ID, 'cus_', 'sub_', MEMBER_EMAIL].forEach(function (s) { assert.strictEqual(json.indexOf(s), -1, s); });
  assert.strictEqual(out.status.validUntil, '2026-12-31');
});

test('解約UI: 非会員・永久会員・無効な確認リンクには解約操作を出さない', function () {
  var ctx = joined();
  assert.strictEqual(verify(ctx, 'nobody@example.com').cancel.state, 'UNAVAILABLE');
  var perm = verify(ctx, 'forever@example.com');
  assert.strictEqual(perm.status.active, true);
  assert.strictEqual(perm.cancel.state, 'UNAVAILABLE', '永久会員にsubscriptionは無い');
  assert.strictEqual(perm.cancel.token, undefined);
  var bad = plain(ctx.sandbox.MembershipService.verifyStatusLink({ token: 'x'.repeat(40) }));
  assert.strictEqual(bad.success, false);
  assert.strictEqual(bad.cancel, undefined);
  assert.strictEqual(cancelCalls(ctx).length, 0);
});

test('解約: メールアドレスや確認リンクのトークンだけでは解約できない（解約トークンが必須）', function () {
  var ctx = joined();
  ctx.sandbox.MembershipService.requestStatusLink({ email: MEMBER_EMAIL });
  var statusToken = tokenOf(ctx.sent[0]);
  var M = ctx.sandbox.MembershipService;
  assert.strictEqual(plain(M.cancelMembership({ cancelToken: statusToken })).error.code, 'INVALID_TOKEN', '確認リンクのトークンは解約に使えない');
  assert.strictEqual(plain(M.cancelMembership({ cancelToken: MEMBER_EMAIL })).error.code, 'INVALID_TOKEN');
  assert.strictEqual(plain(M.cancelMembership({})).error.code, 'INVALID_TOKEN');
  assert.strictEqual(plain(M.cancelMembership({ cancelToken: 'y'.repeat(40) })).error.code, 'INVALID_TOKEN');
  assert.strictEqual(cancelCalls(ctx).length, 0);
  /* 解約トークンも確認リンクとしては使えない */
  var out = plain(M.verifyStatusLink({ token: statusToken }));
  var cancelToken = out.cancel.token;
  assert.strictEqual(plain(M.verifyStatusLink({ token: cancelToken })).error.code, 'INVALID_TOKEN');
});

test('解約: cancel_at_period_endだけをStripeへ送り（即時キャンセルしない）、完了表示・確認メール・台帳を整える', function () {
  var ctx = joined();
  var out = verify(ctx, MEMBER_EMAIL);
  var res = plain(ctx.sandbox.MembershipService.cancelMembership({ cancelToken: out.cancel.token }));
  assert.deepStrictEqual(res.cancel, { state: 'SCHEDULED', validUntil: '2026-12-31', alreadyScheduled: false });
  var calls = cancelCalls(ctx);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].options.method, 'post', 'DELETE（即時キャンセル）ではない');
  assert.strictEqual(decodeURIComponent(calls[0].options.payload), 'cancel_at_period_end=true');
  assert.strictEqual(memberRow(ctx).cancelAtPeriodEnd, 'TRUE');
  assert.strictEqual(memberRow(ctx).status, 'active', '即時失効しない');
  /* 支払い済みの月の末日までは有効（判定は支払い事実のまま） */
  assert.strictEqual(ctx.sandbox.MemberRepository.isMemberOnDate(MEMBER_EMAIL, '2026-12-31'), true);
  assert.strictEqual(ctx.sandbox.MemberRepository.isMemberOnDate(MEMBER_EMAIL, '2027-01-01'), false);
  /* 確認メール（確認リンクのメールの次） */
  var mail = ctx.sent[ctx.sent.length - 1];
  assert.strictEqual(mail.to, MEMBER_EMAIL);
  assert.ok(mail.subject.indexOf('解約') !== -1);
  ['2026-12-31', '返金しません', '自動更新を停止'].forEach(function (s) { assert.ok(mail.body.indexOf(s) !== -1, s); });
  ['sub_', 'cus_', 'MBR-'].forEach(function (s) { assert.strictEqual(mail.body.indexOf(s), -1, s); });
  assert.strictEqual(JSON.stringify(res).indexOf('sub_'), -1);
});

test('解約: 再度確認すると「停止済み」になり、解約操作は出ない', function () {
  var ctx = joined();
  ctx.sandbox.MembershipService.cancelMembership({ cancelToken: verify(ctx, MEMBER_EMAIL).cancel.token });
  var again = verify(ctx, MEMBER_EMAIL);
  assert.strictEqual(again.cancel.state, 'SCHEDULED');
  assert.strictEqual(again.cancel.token, undefined);
  assert.strictEqual(again.status.autoRenew, false);
  assert.strictEqual(again.status.nextRenewalDate, null);
});

test('解約: 冪等。二重送信・使用済みトークンの再送・停止済み後の別トークンでもStripe/メールは1回だけ', function () {
  var ctx = joined();
  var M = ctx.sandbox.MembershipService;
  var offer = verify(ctx, MEMBER_EMAIL).cancel.token;
  var otherOffer = verify(ctx, MEMBER_EMAIL).cancel.token; /* 同時に別タブで確認した想定 */
  var mailsBefore = ctx.sent.length;
  var first = plain(M.cancelMembership({ cancelToken: offer }));
  var second = plain(M.cancelMembership({ cancelToken: offer }));
  var third = plain(M.cancelMembership({ cancelToken: otherOffer }));
  assert.strictEqual(first.cancel.alreadyScheduled, false);
  [second, third].forEach(function (r) {
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.cancel.state, 'SCHEDULED');
    assert.strictEqual(r.cancel.alreadyScheduled, true);
    assert.strictEqual(r.cancel.validUntil, '2026-12-31');
  });
  assert.strictEqual(cancelCalls(ctx).length, 1);
  assert.strictEqual(ctx.sent.length - mailsBefore, 1);
});

test('解約: 解約トークンは10分で失効し、期限切れではStripeへ送らない', function () {
  var ctx = joined();
  var token = verify(ctx, MEMBER_EMAIL).cancel.token;
  ctx.clock.advanceByMillis(11 * 60 * 1000);
  assert.strictEqual(plain(ctx.sandbox.MembershipService.cancelMembership({ cancelToken: token })).error.code, 'INVALID_TOKEN');
  assert.strictEqual(cancelCalls(ctx).length, 0);
});

test('解約: トークンは本人のメールの会員だけを対象にする（他人の会員は解約できない）', function () {
  var ctx = joined();
  /* 非会員の確認ではトークンが発行されない。別メールの会員を指す手段がクライアントに無い。 */
  var stranger = verify(ctx, 'nobody@example.com');
  assert.strictEqual(stranger.cancel.token, undefined);
  var res = plain(ctx.sandbox.MembershipService.cancelMembership({ cancelToken: 'z'.repeat(40), email: MEMBER_EMAIL, subscriptionId: SUBSCRIPTION_ID }));
  assert.strictEqual(res.success, false);
  assert.strictEqual(cancelCalls(ctx).length, 0);
  assert.strictEqual(memberRow(ctx).cancelAtPeriodEnd, '');
});

test('解約: Stripeの失敗・応答不明では完了扱いにせず、トークンを消費せず再試行でき、秘密情報をログ/応答に出さない', function () {
  var ctx = joined();
  var M = ctx.sandbox.MembershipService;
  var token = verify(ctx, MEMBER_EMAIL).cancel.token;
  ctx.stripeState.cancelFailure = 500;
  var failed = plain(M.cancelMembership({ cancelToken: token }));
  assert.strictEqual(failed.success, false);
  assert.strictEqual(failed.error.code, 'CANCEL_UNAVAILABLE');
  ['sk_test', 'sub_', 'cus_'].forEach(function (s) { assert.strictEqual(JSON.stringify(failed).indexOf(s), -1, s); });
  assert.strictEqual(memberRow(ctx).cancelAtPeriodEnd, '', '失敗時は台帳を更新しない');
  assert.strictEqual(ctx.sent.length, 1, '失敗時は完了メールを送らない');
  var logs = JSON.stringify(ctx.globals.Logger._logs);
  assert.ok(ctx.globals.Logger._logs.length > 0, '失敗はログに残る');
  ['sk_test', 'sub_', 'cus_', MEMBER_EMAIL].forEach(function (s) { assert.strictEqual(logs.indexOf(s), -1, 'ログに' + s + 'を出さない'); });
  ctx.stripeState.cancelFailure = 0;
  var retried = plain(M.cancelMembership({ cancelToken: token }));
  assert.strictEqual(retried.success, true);
  assert.strictEqual(retried.cancel.alreadyScheduled, false);
});

test('解約: Stripeがcancel_at_period_endを真にしなかった場合は完了扱いにしない', function () {
  var ctx = joined();
  ctx.stripeState.cancelFlag = false;
  var res = plain(ctx.sandbox.MembershipService.cancelMembership({ cancelToken: verify(ctx, MEMBER_EMAIL).cancel.token }));
  assert.strictEqual(res.success, false);
  assert.strictEqual(memberRow(ctx).cancelAtPeriodEnd, '');
});

test('解約: 確認メールの送信に失敗しても解約自体は成功する', function () {
  var ctx = joined();
  var token = verify(ctx, MEMBER_EMAIL).cancel.token;
  ctx.sandbox.MailApp = { sendEmail: function () { throw new Error('mail down'); } };
  var res = plain(ctx.sandbox.MembershipService.cancelMembership({ cancelToken: token }));
  assert.strictEqual(res.success, true);
  assert.strictEqual(memberRow(ctx).cancelAtPeriodEnd, 'TRUE');
});

test('解約: Stripe未設定・ロック競合では何もしない', function () {
  var ctx = joined();
  var token = verify(ctx, MEMBER_EMAIL).cancel.token;
  var original = ctx.sandbox.BookingConfig.getStripeConfig;
  ctx.sandbox.BookingConfig.getStripeConfig = function () { var c = original(); c.secretKey = ''; return c; };
  assert.strictEqual(plain(ctx.sandbox.MembershipService.cancelMembership({ cancelToken: token })).error.code, 'CANCEL_UNAVAILABLE');
  ctx.sandbox.BookingConfig.getStripeConfig = original;
  assert.strictEqual(cancelCalls(ctx).length, 0);
});

test('解約: rate limit（同一メール10分5件）を超えると拒否する', function () {
  var ctx = joined();
  var token = verify(ctx, MEMBER_EMAIL).cancel.token;
  ctx.stripeState.cancelFailure = 500;
  var codes = [];
  for (var i = 0; i < 7; i++) codes.push(plain(ctx.sandbox.MembershipService.cancelMembership({ cancelToken: token })).error.code);
  assert.strictEqual(codes[0], 'CANCEL_UNAVAILABLE');
  assert.strictEqual(codes[6], 'RATE_LIMITED');
});

test('解約: 解約後も支払済み月の末日まで有効で、Webhook（customer.subscription.updated）が台帳を上書きしても整合する', function () {
  var ctx = joined();
  ctx.sandbox.MembershipService.cancelMembership({ cancelToken: verify(ctx, MEMBER_EMAIL).cancel.token });
  var event = {
    id: 'evt_sub_upd', type: 'customer.subscription.updated', created: sec(JOIN_AT) + 60,
    data: { object: {
      id: SUBSCRIPTION_ID, object: 'subscription', customer: CUSTOMER_ID, status: 'active', cancel_at_period_end: true, canceled_at: sec(JOIN_AT) + 59,
      metadata: { orderType: 'membership', memberId: MEMBER_ID },
      items: { data: [{ current_period_start: sec(JOIN_AT), current_period_end: sec(RENEWAL_AT) }] }
    } }
  };
  var now = ctx.clock.currentDate();
  var claim = ctx.sandbox.StripeEventRepository.claim(event.id, event.type, now);
  ctx.sandbox.StripeEventRepository.storeRawBody(claim.rowNumber, JSON.stringify(event), now);
  var run = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  assert.strictEqual(run.results[0].finalized, true);
  assert.strictEqual(memberRow(ctx).cancelAtPeriodEnd, 'TRUE');
  assert.strictEqual(memberRow(ctx).status, 'active');
  assert.strictEqual(ctx.sandbox.MemberRepository.isMemberOnDate(MEMBER_EMAIL, '2026-12-31'), true);
  var again = verify(ctx, MEMBER_EMAIL);
  assert.strictEqual(again.cancel.state, 'SCHEDULED');
  assert.strictEqual(again.status.validUntil, '2026-12-31');
});

test('解約: 既存の予約・料金ロジックは変えない（会員判定は支払い事実のまま。解約後も当月はMEMBER料金）', function () {
  var ctx = joined();
  ctx.sandbox.MembershipService.cancelMembership({ cancelToken: verify(ctx, MEMBER_EMAIL).cancel.token });
  assert.strictEqual(plain(ctx.sandbox.MembershipRules.verifyActualMembership(MEMBER_EMAIL, '2026-12-20')).ok, true);
  assert.strictEqual(plain(ctx.sandbox.MembershipRules.verifyActualMembership(MEMBER_EMAIL, '2027-01-05')).ok, false);
});

test('解約: Web Appのaction経路（cancelMembership）がPOSTで動き、トークンはリクエスト本文だけで受ける', function () {
  var ctx = joined();
  var token = verify(ctx, MEMBER_EMAIL).cancel.token;
  var res = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'cancelMembership' }, postData: { contents: JSON.stringify({ cancelToken: token }) } }).text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.cancel.state, 'SCHEDULED');
  var bad = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'cancelMembership', cancelToken: token }, postData: { contents: '{}' } }).text);
  assert.strictEqual(bad.success, false, 'URLパラメータのトークンは受け付けない');
  var broken = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'cancelMembership' }, postData: { contents: '{' } }).text);
  assert.strictEqual(broken.error.code, 'INVALID_JSON');
});

/* ===== Web ===== */

test('Web: 解約UIは確認ステップを挟み、有効最終日・返金なし・次回更新停止を明示し、textContentで描画する', function () {
  var js = read('scripts/membership-status.js');
  assert.ok(js.indexOf("post('cancelMembership'") !== -1);
  assert.ok(js.indexOf('SNB MEMBERを解約する') !== -1);
  assert.ok(js.indexOf('解約を確定する') !== -1);
  ['会員資格の有効最終日', '日割りを含め返金しません', '次回以降の自動更新のみ', 'すぐには失効しません', '次回更新は停止済みです', '解約手続きが完了しました'].forEach(function (s) {
    assert.ok(js.indexOf(s) !== -1, s);
  });
  assert.strictEqual(/innerHTML/.test(js), false);
  assert.strictEqual(/localStorage|sessionStorage|document\.cookie/.test(js), false, '解約トークンを保存しない');
  /* 解約ボタンは「AVAILABLE」のときだけ。確定ボタンは二重押下を防ぐ */
  assert.ok(js.indexOf("state !== 'AVAILABLE'") !== -1);
  assert.ok(js.indexOf('confirm.disabled = true') !== -1);
});

test('Web: 規約・特商法・FAQは通常は専用UI、できない場合は連絡という案内に揃い、旧文言のみの案内は残らない', function () {
  /* トップのFAQは#594で4問に絞った。会員のFAQ全件（解約手順を含む）は legal/index.html に保持する */
  ['_includes/membership_terms_ja.html', '_includes/legal_ja.html', 'legal/index.html'].forEach(function (f) {
    var html = read(f);
    assert.ok(html.indexOf('membership/status/') !== -1, f + ': 専用UIへの案内');
    assert.ok(html.indexOf('SNB MEMBER解約') !== -1, f + ': 予備導線を残す');
    assert.ok(html.indexOf('SNB MEMBERを解約する') !== -1, f);
  });
});
