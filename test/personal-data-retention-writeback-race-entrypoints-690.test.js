/*
 * Issue #690 §2（続き）: 実入口の交差テスト。test/personal-data-retention-writeback-race-690.test.js が「未作成」としていた4経路
 * （Stripe受信処理・決済リンク送信・オプション注文の承認／否認・日程変更／料金復旧）を、実入口から呼んで検証する。
 *
 * 方法: 消去対象（終端・180日経過）の古い予約へ実入口を呼び、外部呼び出し（Stripe・メール・カレンダー）の各時点で
 * Adminの消去を1回だけ挟む。外部呼び出しの間は書き手がロックを持たない（段階の間）。終了後に監査する:
 *   (a) 消去が消した個人情報が、消去前の値に戻っていない（今回の入力＝新しい値は許す）
 *   (b) Bookings／OptionOrdersへの書き込みが、常にスクリプトロック保持中
 * 合成データのみ。実Spreadsheet・実Stripe・実メールには触れない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');
var membershipLookupResponse = require('./helpers/stripe-membership-mock').membershipLookupResponse;

var H = require('./helpers/retention-race-harness');
var DAY = H.DAY;
var RETENTION = H.RETENTION;
var VERSION = H.VERSION;
var SPREADSHEET_ID = H.SPREADSHEET_ID;
var EMAIL = H.EMAIL;
var BOOKING_ID = H.BOOKING_ID;
var SESSION_ID = H.SESSION_ID;
var PI_ID = H.PI_ID;
var ATTEMPT_ID = H.ATTEMPT_ID;
var plain = H.plain;
var PII_COLUMNS = H.PII_COLUMNS;
var SEEDED = H.SEEDED;
var OPTION_HEADERS = H.OPTION_HEADERS;
var OPTION_PII = H.OPTION_PII;
var realNow = H.realNow;
var agoReal = H.agoReal;
var flowSetup = H.flowSetup;
var bookingRow = H.bookingRow;
var piiOf = H.piiOf;
var addOldBooking = H.addOldBooking;
var interleaveAll = H.interleaveAll;

// ============================================================================
// 1. Stripe受信処理（StripeWebhookProcessor.processPendingStripeWebhookEvents）
// ============================================================================

function stripeResponder(state) {
  return function (url) {
    if (url.indexOf('/checkout/sessions/') !== -1) {
      return { responseCode: 200, body: { id: SESSION_ID, status: state.sessionStatus || 'complete', payment_status: 'paid', amount_total: 8000, currency: 'jpy', payment_intent: PI_ID,
        metadata: { bookingId: BOOKING_ID, brand: 'studio_x', paymentAttemptId: ATTEMPT_ID } } };
    }
    if (url.indexOf('/payment_intents/') !== -1) return { responseCode: 200, body: { id: PI_ID, status: 'succeeded', amount_received: 8000, currency: 'jpy' } };
    throw new Error('未対応のURL: ' + url);
  };
}

[
  { status: 'CONFIRMED', paymentStatus: 'paid', label: '確定済み・入金済みの予約へ、重複／遅延した決済完了イベント' },
  { status: 'CANCELLED', paymentStatus: 'refunded', label: '取消・返金済みの予約へ、遅延した決済完了イベント' }
].forEach(function (scenario) {
  test('実入口（Stripe受信処理）: ' + scenario.label + ' — 各外部呼び出しの間に消去を挟んでも個人情報は戻らず、書き込みはロック保持中', function () {
    function build() {
      var ctx = flowSetup({ responder: stripeResponder({}) });
      var basis = scenario.status === 'CANCELLED' ? { cancelledAt: agoReal(RETENTION + 30 * DAY) } : {};
      addOldBooking(ctx, Object.assign({ status: scenario.status, paymentStatus: scenario.paymentStatus }, basis));
      return ctx;
    }
    var summary = interleaveAll(build, function (ctx) {
      var now = realNow();
      var body = JSON.stringify({ id: 'evt_synthetic_' + scenario.status, type: 'checkout.session.completed', data: { object: { id: SESSION_ID } } });
      var claim = ctx.admin.StripeEventRepository.claim('evt_synthetic_' + scenario.status, 'checkout.session.completed', now);
      ctx.admin.StripeEventRepository.storeRawBody(claim.rowNumber, body, now);
      ctx.resetWriteAudit();
      ctx.admin.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
    });
    assert.ok(summary.stages >= 1, '外部呼び出し（Stripe）が実際に起きる: ' + summary.stages);
    assert.ok(summary.openGaps >= 1, 'ロックが外れた外部呼び出し（段階の間）で消去を挟んだ回がある: ' + JSON.stringify(summary));
    assert.ok(summary.cleared >= 1, '消去が実際に個人情報を消した回がある（空振りでない）: ' + JSON.stringify(summary));
  });
});

// ============================================================================
// 2. 決済リンクの手動送信（BookingMailer.sendPaymentLinkMailForBooking）
// ============================================================================

test('実入口（決済リンク送信）: 古い期限切れ（EXPIRED）のカード予約へは、利用開始後のため送信を拒否し、Bookingsへ何も書かない', function () {
  function build() {
    var ctx = flowSetup();
    addOldBooking(ctx, { status: 'EXPIRED', paymentStatus: 'not_started', paymentAttemptId: '', paymentAttemptResolvedAt: '', stripeCheckoutSessionId: '', stripePaymentIntentId: '', stripeAmount: '', stripeCurrency: '', paymentConfirmedAt: '', lastStripeEventId: '', expiredAt: agoReal(RETENTION + 30 * DAY), createdAt: agoReal(RETENTION + 33 * DAY) });
    return ctx;
  }
  var writes = 0;
  var summary = interleaveAll(build, function (ctx) {
    var before = ctx.bookings._setValuesCalls.length;
    var result = plain(ctx.admin.BookingMailer.sendPaymentLinkMailForBooking(BOOKING_ID, 'https://buy.stripe.com/test_synthetic_link'));
    assert.strictEqual(result.success, false, JSON.stringify(result));
    assert.ok(['START_PASSED', 'EMAIL_MISSING'].indexOf(result.error.code) !== -1, '利用開始後は拒否（状態EXPIREDは許可されるが、180日経過した予約は必ず開始後）。消去後はメール空欄でも拒否: ' + JSON.stringify(result));
    writes += ctx.bookings._setValuesCalls.length - before;
    assert.strictEqual(ctx.mail._sentEmails.length, 0, 'メールを送らない');
  });
  assert.strictEqual(summary.stages, 0, '拒否されるため外部呼び出しに至らない');
  assert.ok(summary.cleared >= 1);
  assert.strictEqual(writes, 0, 'Bookingsへ書き込まない（消去を除く）');
});

// ============================================================================
// 3. オプション注文の承認／否認（OptionOrderService.approveOrder / declineOrder）
// ============================================================================

function addOldOption(ctx, status, extra) {
  var sheet = ctx.sheets.OptionOrders || (ctx.sheets.OptionOrders = ctx.book.insertSheet('OptionOrders'));
  if (sheet._rows.length === 0) sheet.appendRow(OPTION_HEADERS);
  var values = Object.assign({
    optionOrderId: 'OPT-ENTRY-1', bookingId: BOOKING_ID, brand: 'studio_x', category: 'EQUIPMENT', status: status, customerEmail: EMAIL,
    createdAt: agoReal(RETENTION + 40 * DAY), paidAt: agoReal(RETENTION + 35 * DAY), approvedAt: agoReal(RETENTION + 36 * DAY), declinedAt: status === 'DECLINED' ? agoReal(RETENTION + 36 * DAY) : '',
    declineReason: '旧い不承認理由', checkoutRequestJson: '{"amountJpy":1000}', paymentRecoveryReason: '旧い復旧理由', itemsJson: '["EQ:COB:1"]', amountJpy: 1000,
    paymentStatus: 'paid', approvalStatus: status === 'DECLINED' ? 'DECLINED' : 'APPROVED'
  }, extra || {});
  sheet.appendRow(OPTION_HEADERS.map(function (h) { return values[h] === undefined ? '' : values[h]; }));
  ctx.watch(sheet);
}

function optionCell(ctx, column) { return ctx.sheets.OptionOrders._rows[1][OPTION_HEADERS.indexOf(column)]; }

['CONFIRMED', 'DECLINED'].forEach(function (status) {
  ['approveOrder', 'declineOrder'].forEach(function (operation) {
    test('実入口（オプション承認／否認）: 終端（' + status + '）の注文への ' + operation + ' は、消去済みの個人情報を戻さず、書き込みもしない', function () {
      /* 操作の前に消去が済んでいる／操作と同じ瞬間（ロックの外）に消去が入る、の両方を、書き込み回数と値で確認する。 */
      var ctx = flowSetup();
      addOldBooking(ctx, {});
      addOldOption(ctx, status);
      ctx.admin.purgeExpiredPersonalData(realNow());
      OPTION_PII.forEach(function (c) { assert.strictEqual(optionCell(ctx, c), '', c + ' は消去済み'); });
      var writesBefore = ctx.sheets.OptionOrders._setValuesCalls.length;
      var result = plain(operation === 'approveOrder'
        ? ctx.admin.OptionOrderService.approveOrder('OPT-ENTRY-1', realNow())
        : ctx.admin.OptionOrderService.declineOrder('OPT-ENTRY-1', '新しい不承認理由', realNow()));
      assert.strictEqual(ctx.sheets.OptionOrders._setValuesCalls.length, writesBefore, '終端の注文へは書き込まない: ' + JSON.stringify(result).slice(0, 200));
      OPTION_PII.forEach(function (c) { assert.strictEqual(optionCell(ctx, c), '', c + ' は消去済みのまま'); });
      assert.strictEqual(ctx.unlockedWrites, 0);
    });
  });
});

// ============================================================================
// 4. 日程変更・料金復旧（BookingReschedule: adminRescheduleBooking / 復旧フラグ）
// ============================================================================

function jstDate(date) {
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  var out = {};
  parts.forEach(function (p) { if (p.type !== 'literal') out[p.type] = p.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

/* 消去対象の古い入金済み予約（SNB・PayPay）。基準料金の列も揃え、日程変更が最後まで進むようにする。 */
function buildOldRescheduleCtx(extra) {
  var ctx = flowSetup();
  var end = agoReal(RETENTION + 30 * DAY);
  var start = new Date(end.getTime() - 2 * 60 * 60 * 1000);
  var date0 = jstDate(start);
  var quote = ctx.admin.BookingPricing.computeBookingPrice({ brand: 'snb', date: date0, durationMinutes: 120, isMember: false });
  addOldBooking(ctx, Object.assign({
    brand: 'snb', date: date0, paymentMethod: 'PayPay', paymentStatus: 'not_started', paymentAttemptId: '', paymentAttemptResolvedAt: '', stripeCheckoutSessionId: '', stripePaymentIntentId: '',
    stripeAmount: '', stripeCurrency: '', paymentConfirmedAt: '', lastStripeEventId: '', startAt: start, endAt: end,
    priceAmount: quote.price.amount, priceTier: 'GENERAL', priceDayType: quote.price.dayType, priceIsMember: false, priceComputedAt: agoReal(RETENTION + 60 * DAY), feePaidAmount: quote.price.amount
  }, extra || {}));
  ctx.__amount = quote.price.amount;
  return ctx;
}

/* 同じ料金になる未来の日（返金・追加請求の判断が要らない日程変更にする）。 */
function equalPriceFutureDate(ctx) {
  for (var i = 35; i < 90; i++) {
    var d = jstDate(new Date(Date.now() + i * DAY));
    if (!ctx.admin.JapaneseHolidays.classify(d).ok) continue;
    var q = ctx.admin.BookingPricing.computeBookingPrice({ brand: 'snb', date: d, durationMinutes: 120, isMember: false });
    if (q.valid && q.price.amount === ctx.__amount) return d;
  }
  throw new Error('同額の日が見つからない');
}

test('実入口（日程変更）: 消去対象の古い予約を未来へ移す adminRescheduleBooking は、各外部呼び出しの間に消去を挟んでも個人情報を戻さず、書き込みはロック保持中', function () {
  var summary = interleaveAll(buildOldRescheduleCtx, function (ctx) {
    var event = ctx.events[0];
    var version = event.getStartTime().getTime() + ':' + event.getEndTime().getTime();
    var input = { date: equalPriceFutureDate(ctx), startTime: '13:00', endTime: '15:00' };
    var preview = ctx.admin.adminPreviewBookingReschedule(BOOKING_ID, input, version);
    assert.strictEqual(preview.success, true, JSON.stringify(preview).slice(0, 200));
    var result = plain(ctx.admin.adminRescheduleBooking(BOOKING_ID, input, version, '日程変更理由', '', '', preview.feeQuoteToken));
    assert.strictEqual(result.success, true, JSON.stringify(result).slice(0, 300));
  });
  assert.ok(summary.stages >= 3, '外部呼び出し（カレンダー・メール）が実際に起きる: ' + summary.stages);
  assert.ok(summary.openGaps >= 1, 'ロックが外れた外部呼び出しで消去を挟んだ回がある: ' + JSON.stringify(summary));
  assert.ok(summary.serialized >= 1, '書き手がロックを持つ外部呼び出しでは、消去が待たされて何も消さない（直列化）: ' + JSON.stringify(summary));
  assert.ok(summary.cleared >= 3, '消去が実際に個人情報を消した回がある（空振りでない）: ' + JSON.stringify(summary));
});

test('実入口（料金復旧）: 料金の復旧が必要な古い予約（feeRecoveryRequiredAt）は、消去が保留として何も消さない', function () {
  var ctx = buildOldRescheduleCtx({ feeRecoveryRequiredAt: agoReal(RETENTION + 40 * DAY), feeRecoveryReason: '精算の復旧が必要' });
  var before = piiOf(ctx, BOOKING_ID);
  var result = plain(ctx.admin.purgeExpiredPersonalData(realNow()));
  assert.strictEqual(result.status, 'OK');
  assert.deepStrictEqual(piiOf(ctx, BOOKING_ID), before, '要復旧の間は個人情報を消さない（利用中の情報）');
  assert.ok(Object.keys(result.held).length >= 1, '保留として数えられる: ' + JSON.stringify(result.held));
});

// ============================================================================
// 5. 会員系のStripeイベント（customer.subscription.* / invoice.* / charge.refunded / 入会checkout.session.completed）
// ============================================================================

var MEMBER_ID = 'MBR-synthetic-0001';
var CUSTOMER_ID = 'cus_synthetic_0001';
var SUBSCRIPTION_ID = 'sub_synthetic_0001';
var MEMBER_SESSION_ID = 'cs_synthetic_member';
var MEMBER_FIRST_INVOICE = 'in_synthetic_first';
var MEMBER_EMAIL = 'pii-member-entry@example.com';
var MEMBER_HEADERS = ['memberId', 'email', 'stripeCustomerId', 'stripeSubscriptionId', 'status', 'currentPeriodStart', 'currentPeriodEnd', 'canceledAt', 'cancelAtPeriodEnd', 'latestInvoiceId', 'latestEventId', 'latestEventCreated', 'createdAt', 'updatedAt'];
var CHECKOUT_HEADERS = ['memberId', 'email', 'checkoutSessionId', 'pendingUntil', 'state', 'createdAt', 'updatedAt'];
var PERIOD_HEADERS = ['memberId', 'subscriptionId', 'periodStart', 'periodEnd', 'sourceType', 'sourceId', 'amount', 'paidAt', 'eventId', 'recordedAt'];
var MEMBER_PII = ['memberEmail', 'checkoutEmail'];
var MEMBER_SEEDED = { memberEmail: MEMBER_EMAIL, checkoutEmail: MEMBER_EMAIL };

function epoch(date) { return Math.floor(date.getTime() / 1000); }

function memberInvoice(id, periodStart) {
  var periodEnd = new Date(periodStart.getTime() + 30 * DAY);
  return {
    id: id, object: 'invoice', billing_reason: 'subscription_cycle', status: 'paid', amount_paid: 500, currency: 'jpy', customer: CUSTOMER_ID,
    parent: { subscription_details: { subscription: SUBSCRIPTION_ID, metadata: { orderType: 'membership', memberId: MEMBER_ID } } },
    lines: { data: [{ amount: 500, period: { start: epoch(periodStart), end: epoch(periodEnd) } }] },
    status_transitions: { paid_at: epoch(periodStart) + 5 }
  };
}

function memberResponder() {
  var periodStart = agoReal(30 * DAY);
  return function (url, options) {
    var method = String((options && options.method) || 'get').toLowerCase();
    if (url.indexOf('/checkout/sessions/' + MEMBER_SESSION_ID) !== -1) {
      return { responseCode: 200, body: {
        id: MEMBER_SESSION_ID, mode: 'subscription', status: 'complete', payment_status: 'paid', amount_total: 500, currency: 'jpy', customer: CUSTOMER_ID,
        customer_email: MEMBER_EMAIL, subscription: SUBSCRIPTION_ID, invoice: MEMBER_FIRST_INVOICE, payment_intent: null,
        metadata: { orderType: 'membership', memberId: MEMBER_ID }
      } };
    }
    if (url.indexOf('/v1/subscriptions/' + SUBSCRIPTION_ID) !== -1 && method !== 'delete') {
      return { responseCode: 200, body: { id: SUBSCRIPTION_ID, status: 'active', customer: CUSTOMER_ID, cancel_at_period_end: false,
        metadata: { orderType: 'membership', memberId: MEMBER_ID }, items: { data: [{ current_period_start: epoch(periodStart), current_period_end: epoch(new Date(periodStart.getTime() + 30 * DAY)) }] } } };
    }
    if (url.indexOf('/invoice_payments?') !== -1) return { responseCode: 200, body: { object: 'list', has_more: false, data: [{ invoice: 'in_synthetic_refund' }] } };
    if (url.indexOf('/invoices/') !== -1) {
      var invoiceId = decodeURIComponent(url.split('/invoices/')[1]);
      return { responseCode: 200, body: memberInvoice(invoiceId, invoiceId === MEMBER_FIRST_INVOICE ? agoReal(60 * DAY) : periodStart) };
    }
    if (url.indexOf('/charges/') !== -1) return { responseCode: 200, body: { id: 'ch_synthetic', payment_intent: 'pi_synthetic', amount: 500, amount_refunded: 500, currency: 'jpy' } };
    var lookup = membershipLookupResponse(url, options, {});
    if (lookup) return lookup;
    throw new Error('未対応のURL: ' + url);
  };
}

/* 解約から180日以上が経った会員（解約・期間終了・支払期間の最も遅い日時から180日超）と、完了済みの入会Checkout。 */
function buildOldMemberCtx() {
  var ctx = flowSetup({ responder: memberResponder() });
  var canceledAt = agoReal(RETENTION + 90 * DAY), periodEnd = agoReal(RETENTION + 85 * DAY);
  var members = table(ctx, 'Members', MEMBER_HEADERS);
  members.appendRow(MEMBER_HEADERS.map(function (h) {
    return ({ memberId: MEMBER_ID, email: MEMBER_EMAIL, stripeCustomerId: CUSTOMER_ID, stripeSubscriptionId: SUBSCRIPTION_ID, status: 'canceled', currentPeriodStart: agoReal(RETENTION + 120 * DAY),
      currentPeriodEnd: periodEnd, canceledAt: canceledAt, latestInvoiceId: 'in_synthetic_old', latestEventCreated: epoch(agoReal(RETENTION + 90 * DAY)), createdAt: agoReal(RETENTION + 200 * DAY), updatedAt: canceledAt })[h] || '';
  }));
  table(ctx, 'MemberCheckouts', CHECKOUT_HEADERS).appendRow(CHECKOUT_HEADERS.map(function (h) {
    return ({ memberId: MEMBER_ID, email: MEMBER_EMAIL, checkoutSessionId: MEMBER_SESSION_ID, pendingUntil: agoReal(RETENTION + 199 * DAY), state: 'COMPLETED', createdAt: agoReal(RETENTION + 200 * DAY), updatedAt: agoReal(RETENTION + 199 * DAY) })[h] || '';
  }));
  table(ctx, 'MemberPeriods', PERIOD_HEADERS).appendRow(PERIOD_HEADERS.map(function (h) {
    return ({ memberId: MEMBER_ID, subscriptionId: SUBSCRIPTION_ID, periodStart: agoReal(RETENTION + 120 * DAY), periodEnd: periodEnd, sourceType: 'invoice', sourceId: 'in_synthetic_old', amount: 500, paidAt: agoReal(RETENTION + 120 * DAY), eventId: 'evt_synthetic_old', recordedAt: agoReal(RETENTION + 120 * DAY) })[h] || '';
  }));
  ctx.watch(members);
  ctx.watch(ctx.sheets.MemberCheckouts);
  return ctx;
}

function table(ctx, name, headers) {
  if (!ctx.sheets[name]) { ctx.sheets[name] = ctx.book.insertSheet(name); ctx.sheets[name].appendRow(headers); }
  return ctx.sheets[name];
}

var memberAudit = {
  columns: MEMBER_PII, seeded: MEMBER_SEEDED,
  read: function (ctx) {
    return { memberEmail: ctx.sheets.Members._rows[1][MEMBER_HEADERS.indexOf('email')], checkoutEmail: ctx.sheets.MemberCheckouts._rows[1][CHECKOUT_HEADERS.indexOf('email')] };
  }
};

function receiveMemberEvent(ctx, event) {
  var now = realNow();
  var claim = ctx.admin.StripeEventRepository.claim(event.id, event.type, now);
  if (claim.outcome === 'CLAIMED') ctx.admin.StripeEventRepository.storeRawBody(claim.rowNumber, JSON.stringify(event), now);
  ctx.resetWriteAudit();
  var run = ctx.admin.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  return run.results.filter(function (r) { return r.eventId === event.id; })[0] || { finalized: false, code: 'NOT_PROCESSED' };
}

var nowSec = function () { return Math.floor(Date.now() / 1000); };
[
  { label: '入会checkout.session.completed（重複／遅延）', code: 'MEMBERSHIP_JOIN_INITIAL_PERIOD_UNCONFIRMED', stages: 3, event: function () { return { id: 'evt_m_join', type: 'checkout.session.completed', created: nowSec(), data: { object: { id: MEMBER_SESSION_ID } } }; } },
  { label: 'customer.subscription.updated（再有効化を装う遅延イベント）', code: 'MEMBERSHIP_STATE_STALE', stages: 0, event: function () { return { id: 'evt_m_sub', type: 'customer.subscription.updated', created: nowSec(), data: { object: {
    id: SUBSCRIPTION_ID, status: 'active', customer: CUSTOMER_ID, cancel_at_period_end: false, metadata: { orderType: 'membership', memberId: MEMBER_ID },
    items: { data: [{ current_period_start: epoch(agoReal(30 * DAY)), current_period_end: epoch(new Date(Date.now() + 0)) }] } } } }; } },
  { label: 'invoice.paid（遅延）', code: 'MEMBERSHIP_PERIOD_PAID', stages: 0, event: function () { return { id: 'evt_m_inv', type: 'invoice.paid', created: nowSec(), data: { object: memberInvoice('in_synthetic_late', agoReal(30 * DAY)) } }; } },
  { label: 'charge.refunded（遅延）', code: 'MEMBERSHIP_REFUND_APPLIED', stages: 3, event: function () { return { id: 'evt_m_ref', type: 'charge.refunded', created: nowSec(), data: { object: { id: 'ch_synthetic', object: 'charge' } } }; } }
].forEach(function (scenario) {
  test('実入口（会員系Stripeイベント）: 解約から180日超の会員へ ' + scenario.label + ' — 消去を挟んでも会員メールは戻らず、書き込みはロック保持中', function () {
    var codes = [];
    var summary = interleaveAll(buildOldMemberCtx, function (ctx) {
      var result = receiveMemberEvent(ctx, scenario.event());
      codes.push(result.code);
    }, null, memberAudit);
    assert.ok(codes.every(function (c) { return c !== 'NOT_PROCESSED'; }), 'イベントが処理される（空振りでない）: ' + codes.join(','));
    assert.ok(codes.every(function (c) { return c === scenario.code; }), '期待する処理結果: ' + scenario.code + ' / 実際: ' + codes.join(','));
    assert.strictEqual(summary.stages, scenario.stages, 'Stripe呼び出しの回数（段階の間）。変わったらこのテストの前提を見直す');
    assert.ok(summary.cleared >= 1, '消去が実際に会員メールを消した回がある（空振りでない）: ' + JSON.stringify(summary));
    if (scenario.stages > 0) assert.ok(summary.openGaps >= 1, 'ロックが外れた外部呼び出しで消去を挟んだ回がある: ' + JSON.stringify(summary));
  });
});


// ============================================================================
// 6. 料金復旧の確定（adminResolveFeeRecovery）
// ============================================================================

test('実入口（料金復旧の確定）: adminResolveFeeRecovery の書き込みの直前に消去を試みても、保留中の行は何も消されず、確定後に消去対象へ戻る（復活しない）', function () {
  var ctx = buildOldRescheduleCtx({ feeRecoveryRequiredAt: agoReal(RETENTION + 40 * DAY), feeRecoveryReason: '精算の復旧が必要', feeSettlementNote: '旧い精算メモ', note: '旧い備考' });
  var heldBefore = piiOf(ctx, BOOKING_ID);
  assert.strictEqual(plain(ctx.admin.purgeExpiredPersonalData(realNow())).status, 'OK');
  assert.deepStrictEqual(piiOf(ctx, BOOKING_ID), heldBefore, '復旧が必要な間は消去が保留する');

  /* 復旧の確定中（書き込みの直前）に消去を試みる。この時点の行は復旧フラグで保留中のため、消去は何も消さない（消す対象がないのでロックも取らない）。
     保留を外す書き込み自体が、消去対象へ戻る前の最後の変更になる。 */
  var attempts = [];
  var original = ctx.bookings.getRange.bind(ctx.bookings);
  var fired = false;
  ctx.bookings.getRange = function (r, c, nr, nc) {
    var range = original(r, c, nr, nc);
    var setValues = range.setValues;
    range.setValues = function () {
      if (!fired) { fired = true; attempts.push(plain(ctx.admin.purgeExpiredPersonalData(realNow())).status); }
      return setValues.apply(range, arguments);
    };
    return range;
  };
  var amount = ctx.__amount;
  var result = plain(ctx.admin.adminResolveFeeRecovery(BOOKING_ID, { priceOverrideAmount: amount, scheduleChangeCount: 0, feeSettlementState: '' }));
  assert.strictEqual(result.success, true, JSON.stringify(result).slice(0, 300));
  assert.deepStrictEqual(attempts, ['OK'], '書き込みの直前の消去は、保留中の行を消さずに終わる');
  ctx.bookings.getRange = original;
  var afterResolve = piiOf(ctx, BOOKING_ID);
  assert.strictEqual(afterResolve.feeSettlementNote, '旧い精算メモ', '復旧の確定は精算メモを書き換えない（読み直した値のまま）');
  assert.strictEqual(afterResolve.note, '旧い備考', '書き込みの直前の消去は保留中の行を消していない');
  assert.strictEqual(ctx.unlockedWrites, 0, 'ロック外の書き込みなし');
  /* 復旧が確定したので、翌日の実行で対象に戻り消える */
  assert.strictEqual(plain(ctx.admin.purgeExpiredPersonalData(new Date(Date.now() + DAY))).status, 'OK');
  ['name', 'email', 'note', 'feeSettlementNote'].forEach(function (c) { assert.strictEqual(piiOf(ctx, BOOKING_ID)[c], '', c + ' が翌日に消える'); });
});

// ============================================================================
// 7. 決済リンクの送信が成功する経路（開始前の予約のみ。消去対象の行には届かない）
// ============================================================================

test('実入口（決済リンク送信が成功する経路）: 開始前の PENDING 予約への送信は成功し、書き込みはロック保持中。送信後も PENDING なので消去の対象外', function () {
  var ctx = flowSetup();
  var start = new Date(Date.now() + 10 * DAY);
  addOldBooking(ctx, {
    status: 'PENDING', paymentStatus: 'not_started', paymentAttemptId: '', paymentAttemptResolvedAt: '', stripeCheckoutSessionId: '', stripePaymentIntentId: '', stripeAmount: '', stripeCurrency: '',
    paymentConfirmedAt: '', lastStripeEventId: '', confirmedAt: '', confirmedMailSentAt: '', createdAt: new Date(Date.now() - DAY), date: jstDate(start), startAt: start, endAt: new Date(start.getTime() + 2 * 60 * 60 * 1000),
    paymentLinkSentTo: '', lastMailErrorMessage: '', paymentLinkLastErrorMessage: ''
  });
  var result = plain(ctx.admin.BookingMailer.sendPaymentLinkMailForBooking(BOOKING_ID, 'https://buy.stripe.com/test_synthetic_link'));
  assert.strictEqual(result.success, true, JSON.stringify(result).slice(0, 300));
  assert.strictEqual(ctx.unlockedWrites, 0, 'ロック外の書き込みなし');
  assert.strictEqual(piiOf(ctx, BOOKING_ID).paymentLinkSentTo, EMAIL, '送信先（読み直した現在のメール）が記録される');
  var purge = plain(ctx.admin.purgeExpiredPersonalData(new Date(Date.now() + 400 * DAY)));
  assert.strictEqual(purge.status, 'OK');
  assert.strictEqual(piiOf(ctx, BOOKING_ID).email, EMAIL, 'PENDING の間は消去の対象外（利用開始前）');
});
