/*
 * Issue #341 PR-D: 管理者の取消・返金（BookingRefund.gs）・決済Recoveryの解消の統合テスト。
 * Booking Adminプロジェクトの配布ファイル一式（BOOKING_ADMIN_FILES）をvmで実行し、
 * Stripe（UrlFetchApp）・Calendar・Sheets・メールはすべてスタブを使う（本番の返金は行わない）。
 *
 * 受入条件との対応:
 * - 入金済み予約の正常な取消・返金
 * - 同一返金操作の二重クリック・並行実行・再送で二重返金しない
 * - Stripe API応答不明時は新しい返金IDを発行せず、照会・同一Idempotency-Keyでの再送のみ
 * - Stripe返金成功後にBookings更新が失敗した場合のRecovery
 * - 返金未完了時に返金完了メールを送信しない
 * - Recovery未解消予約に対する管理操作の制限と、Stripeとの整合確認後の解消
 * - 現地払い・旧Payment Link予約の既存キャンセルへの回帰がない
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');

var SPREADSHEET_ID = 'ss1';
var CALENDAR_ID = 'cal1';
var BOOKING_ID = 'SX-20261010-AAAAAAAA';
var PAYMENT_INTENT_ID = 'pi_test_0001';
var NOW = new Date('2026-10-01T12:00:00+09:00');

var PROPERTIES = {
  SPREADSHEET_ID: SPREADSHEET_ID,
  CALENDAR_ID: CALENDAR_ID,
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
  BOOKING_ADMIN_URL: 'https://script.google.com/macros/s/admin/exec',
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

function paidRecord(overrides) {
  return Object.assign({
    bookingId: BOOKING_ID,
    createdAt: new Date('2026-09-20T10:00:00+09:00'),
    date: '2026-10-10',
    startAt: new Date('2026-10-10T10:00:00+09:00'),
    endAt: new Date('2026-10-10T12:00:00+09:00'),
    brand: 'studio_x',
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '090-0000-0000',
    people: '2名',
    purpose: '撮影',
    paymentMethod: 'オンラインクレジットカード',
    status: 'CONFIRMED',
    calendarEventId: 'event-1',
    source: 'test',
    note: '',
    confirmedAt: new Date('2026-09-20T10:10:00+09:00'),
    customerType: 'returning',
    confirmedMailSentAt: new Date('2026-09-20T10:10:00+09:00'),
    paymentStatus: 'paid',
    priceAmount: 8000,
    paymentAttemptId: 'PAY-' + BOOKING_ID + '-ABCDEF012345',
    paymentAttemptResolvedAt: new Date('2026-09-20T10:05:00+09:00'),
    stripeCheckoutSessionId: 'cs_test_0001',
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    stripeAmount: 8000,
    stripeCurrency: 'JPY',
    paymentConfirmedAt: new Date('2026-09-20T10:10:00+09:00'),
    lastStripeEventId: 'evt_0001'
  }, overrides || {});
}

function parseForm(payload) {
  var out = {};
  String(payload || '').split('&').forEach(function (pair) {
    if (!pair) return;
    var idx = pair.indexOf('=');
    out[decodeURIComponent(pair.slice(0, idx))] = decodeURIComponent(pair.slice(idx + 1));
  });
  return out;
}

/*
 * Stripeの最小限のモック。PaymentIntentの取得・返金の作成（Idempotency-Keyごとに1件だけ作る
 * Stripeの冪等性を再現）・返金の取得・PaymentIntent単位の返金一覧を扱う。
 * stripe.postBehaviors: 返金作成の各呼び出しの振る舞いを順に指定する
 *   'ok'（既定）| 'network'（返金を作らずに通信例外）| 'network_after_create'（返金を作った
 *   後に通信例外＝応答不明）| 'http500_after_create' | 'reject'（invalid_request_errorで拒否）
 */
function createStripe(options) {
  var opts = options || {};
  var stripe = {
    refunds: (opts.existingRefunds || []).slice(),
    posts: [],
    postBehaviors: (opts.postBehaviors || []).slice(),
    refundStatus: opts.refundStatus || 'succeeded',
    piStatus: opts.piStatus || 'succeeded',
    amountReceived: opts.amountReceived === undefined ? 8000 : opts.amountReceived,
    onPost: null,
    onListRefunds: null,
    counter: 0
  };
  function refundBody(refund) {
    return {
      id: refund.id, status: refund.status, amount: refund.amount, currency: 'jpy',
      payment_intent: refund.paymentIntent, metadata: refund.metadata
    };
  }
  stripe.responder = function (url, options) {
    var method = (options && options.method) || 'get';
    if (url.indexOf('/payment_intents/') !== -1) {
      return { responseCode: 200, body: { id: PAYMENT_INTENT_ID, status: stripe.piStatus, amount_received: stripe.amountReceived, currency: 'jpy' } };
    }
    if (url.indexOf('/refunds?payment_intent=') !== -1) {
      if (typeof stripe.onListRefunds === 'function') stripe.onListRefunds();
      return { responseCode: 200, body: { data: stripe.refunds.map(refundBody), has_more: false } };
    }
    if (method === 'post' && /\/refunds$/.test(url)) {
      var key = options.headers['Idempotency-Key'];
      var form = parseForm(options.payload);
      stripe.posts.push({ key: key, form: form });
      if (typeof stripe.onPost === 'function') {
        var hook = stripe.onPost;
        stripe.onPost = null;
        hook();
      }
      var behavior = stripe.postBehaviors.shift() || 'ok';
      if (behavior === 'network') return { thrown: new Error('Timeout') };
      if (behavior === 'reject') {
        return { responseCode: 400, body: { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Charge has already been refunded.' } } };
      }
      var existing = stripe.refunds.filter(function (r) { return r.idempotencyKey === key; })[0];
      if (!existing) {
        stripe.counter++;
        existing = {
          id: 're_test_' + stripe.counter,
          idempotencyKey: key,
          status: stripe.refundStatus,
          amount: Number(form.amount),
          paymentIntent: form.payment_intent,
          metadata: { bookingId: form['metadata[bookingId]'], refundAttemptId: form['metadata[refundAttemptId]'] }
        };
        stripe.refunds.push(existing);
      }
      if (behavior === 'network_after_create') return { thrown: new Error('Timeout') };
      if (behavior === 'http500_after_create') return { responseCode: 500, body: { error: { type: 'api_error', message: 'internal' } } };
      return { responseCode: 200, body: refundBody(existing) };
    }
    var match = /\/refunds\/([^/?]+)$/.exec(url);
    if (match) {
      var found = stripe.refunds.filter(function (r) { return r.id === decodeURIComponent(match[1]); })[0];
      if (!found) return { responseCode: 404, body: { error: { type: 'invalid_request_error', message: 'No such refund' } } };
      return { responseCode: 200, body: refundBody(found) };
    }
    throw new Error('未対応のURL: ' + method + ' ' + url);
  };
  return stripe;
}

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var stripe = createStripe(opts.stripe);
  var mailApp = opts.mailApp || stubs.createMailAppStub();
  var events = [];
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(Object.assign({}, PROPERTIES, opts.properties || {})),
    LockService: stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: events } }),
    UrlFetchApp: stubs.createUrlFetchAppStub(stripe.responder),
    Utilities: stubs.createUtilitiesStub(),
    MailApp: mailApp,
    ScriptApp: stubs.createScriptAppStub(),
    Logger: stubs.createLoggerStub()
  };
  var sandbox = loadBookingSandbox(manifest.BOOKING_ADMIN_FILES, globals);
  var ctx = { sandbox: sandbox, stripe: stripe, mailApp: mailApp, events: events };
  if (opts.record !== null) {
    var record = paidRecord(opts.record);
    sandbox.SpreadsheetRepository.appendBooking(record);
    if (record.status === 'CONFIRMED' || record.status === 'PENDING') {
      var event = stubs.createEventStub({ id: record.calendarEventId, title: 'CONFIRMED', start: record.startAt, end: record.endAt });
      event.setTag('bookingId', record.bookingId);
      events.push(event);
    }
  }
  return ctx;
}

function rec(ctx) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(BOOKING_ID).record;
}

function mailsTo(ctx, address) {
  return ctx.mailApp._sentEmails.filter(function (m) { return m.to === address; });
}

function recoveryTypes(ctx) {
  return ctx.sandbox.RecoveryRepository.listAll().map(function (r) { return r.failureType; });
}

function liveEvents(ctx) {
  return ctx.events.filter(function (e) { return !e.isDeleted(); });
}

/* ========================================================================== */
/* 正常系                                                                      */
/* ========================================================================== */

test('cancelWithRefund: 入金済みCONFIRMED予約を全額返金で取り消す（取消→返金→refunded→取消メール・返金完了メール）', function () {
  var ctx = setup();

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: '運営都合（設備不具合）' });

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.refundResult, 'REFUNDED');
  assert.strictEqual(result.cancelled, true);
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED');
  assert.strictEqual(r.paymentStatus, 'refunded');
  assert.strictEqual(r.stripeRefundId, 're_test_1');
  assert.ok(r.refundedAt, '返金完了日時を記録する');
  assert.ok(r.refundRequestedAt);
  assert.strictEqual(r.refundAttemptState, 'SUBMITTED');
  assert.strictEqual(r.refundDecision, 'FULL');
  assert.strictEqual(Number(r.refundAmount), 8000);
  assert.strictEqual(r.refundReason, '運営都合（設備不具合）');
  assert.ok(/^RFD-SX-20261010-AAAAAAAA-[0-9A-Z]+$/.test(r.refundAttemptId), r.refundAttemptId);
  assert.strictEqual(liveEvents(ctx).length, 0, 'Calendarの予約枠を削除する');

  assert.strictEqual(ctx.stripe.posts.length, 1);
  assert.strictEqual(ctx.stripe.posts[0].key, r.refundAttemptId, 'Idempotency-Keyは台帳に保存した返金試行ID');
  assert.strictEqual(ctx.stripe.posts[0].form.amount, '8000');
  assert.strictEqual(ctx.stripe.posts[0].form.payment_intent, PAYMENT_INTENT_ID);

  var customerMails = mailsTo(ctx, 'taro@example.com');
  assert.strictEqual(customerMails.length, 2);
  assert.ok(/キャンセル/.test(customerMails[0].subject));
  assert.ok(/返金手続きを開始しました/.test(customerMails[0].body));
  assert.ok(!/返金.*完了しました/.test(customerMails[0].body), '取消メールでは返金完了と案内しない');
  assert.ok(customerMails[0].body.indexOf('運営都合') === -1, '管理者の理由は利用者へ送らない');
  assert.ok(/返金手続き完了/.test(customerMails[1].subject));
  assert.ok(/8,000円/.test(customerMails[1].body));
  assert.ok(r.refundMailSentAt);
});

test('cancelWithRefund: 一部返金がpendingの間はrefund_pendingのまま完了メールを送らず、照会でsucceededを確認してから1回だけ送る', function () {
  var ctx = setup({ stripe: { refundStatus: 'pending' } });

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'PARTIAL', amountJpy: 4000, reason: '前日キャンセル（50%）' });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.refundResult, 'REFUND_PENDING');
  assert.strictEqual(rec(ctx).paymentStatus, 'refund_pending');
  assert.strictEqual(ctx.stripe.posts[0].form.amount, '4000');
  var customerMails = mailsTo(ctx, 'taro@example.com');
  assert.strictEqual(customerMails.length, 1, '返金未完了の間は取消メールのみ');
  assert.ok(/4,000円/.test(customerMails[0].body));
  assert.ok(!/完了しました/.test(customerMails[0].body));

  /* pendingのまま照会しても完了メールは送らない。 */
  var stillPending = ctx.sandbox.reconcileBookingRefund(BOOKING_ID);
  assert.strictEqual(stillPending.refundResult, 'REFUND_PENDING');
  assert.strictEqual(mailsTo(ctx, 'taro@example.com').length, 1);

  ctx.stripe.refunds[0].status = 'succeeded';
  var reconciled = ctx.sandbox.reconcileBookingRefund(BOOKING_ID);
  assert.strictEqual(reconciled.success, true);
  assert.strictEqual(reconciled.refundResult, 'REFUNDED');
  assert.strictEqual(rec(ctx).paymentStatus, 'refunded');
  assert.strictEqual(mailsTo(ctx, 'taro@example.com').length, 2);

  var again = ctx.sandbox.reconcileBookingRefund(BOOKING_ID);
  assert.strictEqual(again.success, true);
  assert.strictEqual(mailsTo(ctx, 'taro@example.com').length, 2, '照会の再実行で完了メールを重複送信しない');
  assert.strictEqual(ctx.stripe.posts.length, 1, '照会では新しい返金を作らない');
});

test('cancelWithRefund: 「返金なし」は取消と判断の記録だけを行い、Stripeへ返金しない', function () {
  var ctx = setup();
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '当日キャンセル（100%）' });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED');
  assert.strictEqual(r.paymentStatus, 'paid', '入金の事実は消さない');
  assert.strictEqual(r.refundDecision, 'NONE');
  assert.strictEqual(r.refundAttemptId, '');
  assert.strictEqual(ctx.stripe.posts.length, 0);
  var mails = mailsTo(ctx, 'taro@example.com');
  assert.strictEqual(mails.length, 1);
  assert.ok(/返金はございません/.test(mails[0].body));
});

test('cancelWithRefund: 入力・金額の検証（理由なし・請求額超過）ではStripeも台帳も変更しない', function () {
  var ctx = setup();
  assert.strictEqual(ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: '  ' }).error.code, 'INVALID_REASON');
  assert.strictEqual(ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'PARTIAL', amountJpy: 8001, reason: 'x' }).error.code, 'INVALID_REFUND_AMOUNT');
  assert.strictEqual(ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'PARTIAL', amountJpy: 10.5, reason: 'x' }).error.code, 'INVALID_REFUND_AMOUNT');
  assert.strictEqual(ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'HALF', reason: 'x' }).error.code, 'INVALID_REFUND_DECISION');
  assert.strictEqual(ctx.stripe.posts.length, 0);
  assert.strictEqual(rec(ctx).status, 'CONFIRMED');
});

test('cancelBookingAdmin（通常のキャンセル）: Stripeで入金済みの予約は返金の判断なしに取り消せない。現金予約は従来どおり', function () {
  var ctx = setup();
  var result = ctx.sandbox.cancelBookingAdmin(BOOKING_ID);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REFUND_DECISION_REQUIRED');
  assert.strictEqual(rec(ctx).status, 'CONFIRMED');
  assert.strictEqual(liveEvents(ctx).length, 1, 'Calendarにも触れない');

  var cashCtx = setup({
    record: {
      paymentMethod: '現金', paymentStatus: 'unpaid', paymentAttemptId: '', paymentAttemptResolvedAt: '',
      stripeCheckoutSessionId: '', stripePaymentIntentId: '', stripeAmount: '', stripeCurrency: ''
    }
  });
  var cashResult = cashCtx.sandbox.cancelBookingAdmin(BOOKING_ID);
  assert.strictEqual(cashResult.success, true);
  assert.strictEqual(rec(cashCtx).status, 'CANCELLED');
  assert.strictEqual(cashCtx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' }).error.code, 'NOT_STRIPE_BOOKING');
});

test('cancelBookingAdmin: 旧Payment Link方式のカード予約（Stripe Checkoutの記録なし）は従来どおりキャンセルできる', function () {
  var ctx = setup({
    record: {
      paymentStatus: 'unpaid', paymentAttemptId: '', paymentAttemptResolvedAt: '', stripeCheckoutSessionId: '',
      stripePaymentIntentId: '', stripeAmount: '', stripeCurrency: '', paymentConfirmedAt: '', lastStripeEventId: '',
      stripePaymentLinkUrl: 'https://buy.stripe.com/test_abc'
    }
  });
  var result = ctx.sandbox.cancelBookingAdmin(BOOKING_ID);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(rec(ctx).status, 'CANCELLED');
  assert.strictEqual(ctx.stripe.posts.length, 0);
});

/* ========================================================================== */
/* 二重クリック・並行実行・再送                                                    */
/* ========================================================================== */

test('二重クリック（完了後の再送信）: 2回目は返金済みとして拒否し、Stripeへ再度返金しない', function () {
  var ctx = setup();
  ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  var second = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.error.code, 'REFUND_ALREADY_REQUESTED');
  assert.strictEqual(ctx.stripe.posts.length, 1);
  assert.strictEqual(mailsTo(ctx, 'taro@example.com').length, 2, 'メールも重複しない');
});

test('並行実行: Stripe応答待ちの間に届いた2回目の操作は、Stripeを呼ばずにREFUND_IN_PROGRESSで止まる（Script LockはStripe呼び出し中に保持しない）', function () {
  var ctx = setup();
  var inner = null;
  ctx.stripe.onPost = function () {
    inner = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  };
  var outer = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.ok(inner, 'Stripe呼び出し中にLockが解放されており、2回目の呼び出し自体は処理される');
  assert.strictEqual(inner.success, false);
  assert.strictEqual(inner.error.code, 'REFUND_IN_PROGRESS');
  assert.strictEqual(outer.success, true, JSON.stringify(outer));
  assert.strictEqual(ctx.stripe.posts.length, 1);
  assert.strictEqual(rec(ctx).paymentStatus, 'refunded');
});

test('並行実行: 事前照会の直後に別の操作が先に返金を完了させた場合、後発はCONCURRENT_MODIFICATIONで止まり二重返金しない', function () {
  var ctx = setup();
  var inner = null;
  var listCalls = 0;
  ctx.stripe.onListRefunds = function () {
    listCalls++;
    if (listCalls === 1) {
      ctx.stripe.onListRefunds = null;
      inner = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
    }
  };
  var outer = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(inner.success, true, JSON.stringify(inner));
  assert.strictEqual(outer.success, false);
  assert.strictEqual(outer.error.code, 'CONCURRENT_MODIFICATION');
  assert.strictEqual(ctx.stripe.posts.length, 1);
});

/* ========================================================================== */
/* Stripe API応答不明                                                          */
/* ========================================================================== */

test('応答不明（通信例外）: 未返金と決めつけず、照会で見つからなければUNKNOWNで止める。再操作でも新しい返金は出さず、照会で同じIdempotency-Keyのみで再送する', function () {
  var ctx = setup({ stripe: { postBehaviors: ['network'] } });

  var first = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(first.success, false);
  assert.strictEqual(first.error.code, 'REFUND_RESULT_UNKNOWN');
  assert.strictEqual(first.cancelled, true, '予約の取消（枠の解放）は返金の成功を待たずに完了する');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED');
  assert.strictEqual(r.paymentStatus, 'paid', '返金を確認できるまでpaidのまま');
  assert.strictEqual(r.refundAttemptState, 'UNKNOWN');
  assert.ok(recoveryTypes(ctx).indexOf('REFUND_RESULT_UNKNOWN') !== -1);
  var customerMails = mailsTo(ctx, 'taro@example.com');
  assert.strictEqual(customerMails.length, 1);
  assert.ok(/改めてご連絡/.test(customerMails[0].body), '返金を約束・完了案内しない');
  assert.ok(!/返金手続きを開始しました/.test(customerMails[0].body));

  var retryClick = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(retryClick.error.code, 'REFUND_IN_PROGRESS');
  assert.strictEqual(ctx.stripe.posts.length, 1, '「取消・返金」の再実行ではStripeを呼ばない');

  var reconciled = ctx.sandbox.reconcileBookingRefund(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(reconciled.refundResult, 'REFUNDED');
  assert.strictEqual(ctx.stripe.posts.length, 2);
  assert.strictEqual(ctx.stripe.posts[1].key, ctx.stripe.posts[0].key, '再送は同じIdempotency-Key（新しい返金IDを発行しない）');
  assert.strictEqual(ctx.stripe.posts[1].form.amount, ctx.stripe.posts[0].form.amount);
  assert.strictEqual(ctx.stripe.refunds.length, 1);
  assert.strictEqual(rec(ctx).paymentStatus, 'refunded');
});

test('応答不明（返金は作られたが5xx）: 直後の照会で同じ返金試行IDの返金を見つけて採用し、再送しない', function () {
  var ctx = setup({ stripe: { postBehaviors: ['http500_after_create'] } });
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.refundResult, 'REFUNDED');
  assert.strictEqual(ctx.stripe.posts.length, 1);
  assert.strictEqual(rec(ctx).stripeRefundId, 're_test_1');
});

test('応答不明のままRESERVEDで残った試行（実行が途中で停止）: 最大実行時間を過ぎるまでは照会のみで再送しない', function () {
  var ctx = setup({
    record: {
      status: 'CANCELLED', cancelledAt: new Date('2026-10-01T11:59:00+09:00'),
      refundAttemptId: 'RFD-' + BOOKING_ID + '-000000000001', refundAttemptState: 'RESERVED', refundDecision: 'FULL',
      refundAmount: 8000, refundReason: 'x', refundDecidedAt: new Date(Date.now() - 60 * 1000)
    }
  });
  var early = ctx.sandbox.reconcileBookingRefund(BOOKING_ID);
  assert.strictEqual(early.success, false);
  assert.strictEqual(early.error.code, 'REFUND_IN_PROGRESS');
  assert.strictEqual(ctx.stripe.posts.length, 0);

  ctx.sandbox.SpreadsheetRepository.updateBookingRefundStateAtomic(BOOKING_ID, { refundDecidedAt: new Date(Date.now() - 8 * 60 * 1000) });
  var late = ctx.sandbox.reconcileBookingRefund(BOOKING_ID);
  assert.strictEqual(late.success, true, JSON.stringify(late));
  assert.strictEqual(ctx.stripe.posts.length, 1);
  assert.strictEqual(ctx.stripe.posts[0].key, 'RFD-' + BOOKING_ID + '-000000000001');
});

/* ========================================================================== */
/* 返金成功後の台帳更新失敗・Stripeの拒否・既存返金                                 */
/* ========================================================================== */

test('Stripe返金成功後にBookings更新が失敗: 返金IDをRecoveryへ記録して要対応にし、完了メールは送らない。台帳の回復後の照会で記録し、整合確認の上で解消できる', function () {
  var ctx = setup();
  var repo = ctx.sandbox.SpreadsheetRepository;
  var original = repo.updateBookingPaymentStateAtomic;
  repo.updateBookingPaymentStateAtomic = function (bookingId, fields) {
    if (fields && fields.stripeRefundId) throw new Error('Sheets write failed');
    return original.apply(this, arguments);
  };

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REFUND_LEDGER_UPDATE_FAILED');
  assert.strictEqual(result.stripeRefundId, 're_test_1');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED');
  assert.strictEqual(r.paymentStatus, 'paid');
  assert.ok(r.paymentRecoveryRequiredAt, '要復旧ゲートを立てる');
  var recovery = ctx.sandbox.RecoveryRepository.listAll().filter(function (row) { return row.failureType === 'REFUND_SUCCEEDED_LEDGER_UPDATE_FAILED'; });
  assert.strictEqual(recovery.length, 1);
  assert.ok(recovery[0].errorMessage.indexOf('re_test_1') !== -1, 'Stripeの返金IDを証跡として残す');
  assert.ok(!mailsTo(ctx, 'taro@example.com').some(function (m) { return /返金手続き完了/.test(m.subject); }), '完了メールを送らない');
  assert.ok(mailsTo(ctx, 'admin@example.com').length >= 1, '管理者へ要対応を通知する');

  /* 要対応のままでは新しい返金を出さない。 */
  assert.strictEqual(ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' }).error.code, 'REFUND_IN_PROGRESS');
  /* 返金の記録が完了するまで要対応は解消できない。 */
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'REFUND_IN_PROGRESS');

  repo.updateBookingPaymentStateAtomic = original;
  var reconciled = ctx.sandbox.reconcileBookingRefund(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(rec(ctx).paymentStatus, 'refunded');
  assert.strictEqual(ctx.stripe.posts.length, 1, '照会は同じ返金を採用するだけで再送しない');
  assert.ok(mailsTo(ctx, 'taro@example.com').some(function (m) { return /返金手続き完了/.test(m.subject); }));

  var resolved = ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, 'Stripe管理画面で返金re_test_1を確認');
  assert.strictEqual(resolved.success, true, JSON.stringify(resolved));
  assert.strictEqual(rec(ctx).paymentRecoveryRequiredAt, '');
  var openPayment = ctx.sandbox.RecoveryRepository.listAll().filter(function (row) {
    return row.recoveryState === 'OPEN' && ctx.sandbox.RecoveryRepository.isPaymentFailureType(row.failureType);
  });
  assert.strictEqual(openPayment.length, 0);
});

test('Stripeが返金を拒否: 返金失敗として要対応にし、返金完了とは案内しない', function () {
  var ctx = setup({ stripe: { postBehaviors: ['reject'] } });
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REFUND_REJECTED');
  var r = rec(ctx);
  assert.strictEqual(r.refundAttemptState, 'FAILED');
  assert.strictEqual(r.paymentStatus, 'paid');
  assert.ok(r.paymentRecoveryRequiredAt);
  assert.ok(!mailsTo(ctx, 'taro@example.com').some(function (m) { return /返金手続き/.test(m.body); }));
  assert.ok(mailsTo(ctx, 'admin@example.com').some(function (m) { return /返金処理の確認が必要/.test(m.subject); }));
});

test('返金の事前照会: Stripe上に台帳にない有効な返金がある場合は新しい返金を出さず、予約も取り消さない', function () {
  var ctx = setup({
    stripe: { existingRefunds: [{ id: 're_dashboard', status: 'succeeded', amount: 8000, paymentIntent: PAYMENT_INTENT_ID, metadata: {} }] }
  });
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(result.error.code, 'REFUND_EXTERNAL_DETECTED');
  assert.strictEqual(ctx.stripe.posts.length, 0);
  assert.strictEqual(rec(ctx).status, 'CONFIRMED');
  assert.ok(rec(ctx).paymentRecoveryRequiredAt);
});

test('返金の事前照会: PaymentIntentの入金額が台帳と一致しない場合は返金しない', function () {
  var ctx = setup({ stripe: { amountReceived: 7000 } });
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' });
  assert.strictEqual(result.error.code, 'REFUND_PRECHECK_MISMATCH');
  assert.strictEqual(ctx.stripe.posts.length, 0);
  assert.strictEqual(rec(ctx).status, 'CONFIRMED');
});

test('未入金（checkout_pending）の予約: 返金は拒否し、「返金なし」なら取消のみ行う', function () {
  var ctx = setup({ record: { status: 'PENDING', paymentStatus: 'checkout_pending', stripePaymentIntentId: '' } });
  assert.strictEqual(ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' }).error.code, 'NOT_PAID');
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: 'x' });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(rec(ctx).status, 'CANCELLED');
  assert.strictEqual(ctx.stripe.posts.length, 0);
});

/* ========================================================================== */
/* Recovery（PR-Cで記録された「入金済みだが自動確定できなかった」案件）              */
/* ========================================================================== */

test('Recovery案件の一覧: 表示するだけでは返金・確定・ゲート解除を行わない', function () {
  var ctx = setup({
    record: {
      status: 'EXPIRED', expiredAt: new Date('2026-09-20T11:00:00+09:00'), confirmedAt: '',
      paymentRecoveryRequiredAt: new Date('2026-09-20T11:05:00+09:00'),
      paymentRecoveryReason: '決済は完了しましたが、予約の自動確定ができませんでした（INVALID_TRANSITION）。'
    }
  });
  ctx.sandbox.RecoveryRepository.recordFailure({
    bookingId: BOOKING_ID, failureType: 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED', occurredAt: new Date('2026-09-20T11:05:00+09:00'),
    calendarEventId: '', status: 'EXPIRED', errorMessage: '枠を確保できません', recoveryState: 'OPEN', resolvedAt: ''
  });

  var list = ctx.sandbox.getAdminPaymentRecoveries();
  assert.strictEqual(list.success, true);
  assert.strictEqual(list.items.length, 1);
  var item = list.items[0];
  assert.strictEqual(item.bookingId, BOOKING_ID);
  assert.strictEqual(item.status, 'EXPIRED');
  assert.strictEqual(item.paymentStatus, 'paid');
  assert.strictEqual(item.stripePaymentIntentId, PAYMENT_INTENT_ID);
  assert.strictEqual(item.stripeCheckoutSessionId, 'cs_test_0001');
  assert.ok(item.paymentRecoveryRequiredAt);
  assert.strictEqual(item.openRecoveryRows[0].failureType, 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(item, 'email'), false, '一覧に連絡先を含めない');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(item, 'name'), false);

  assert.strictEqual(ctx.stripe.posts.length, 0);
  assert.strictEqual(rec(ctx).status, 'EXPIRED');
  assert.ok(rec(ctx).paymentRecoveryRequiredAt);
});

test('Recovery案件（入金済み・失効）: 返金方法が決まるまで解消できず、Stripe照合付きの返金後に解消できる', function () {
  var ctx = setup({
    record: {
      status: 'EXPIRED', expiredAt: new Date('2026-09-20T11:00:00+09:00'), confirmedAt: '',
      paymentRecoveryRequiredAt: new Date('2026-09-20T11:05:00+09:00'), paymentRecoveryReason: 'confirm blocked'
    }
  });
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'RECOVERY_REFUND_DECISION_REQUIRED');

  var refund = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: '枠を確保できなかったため全額返金' });
  assert.strictEqual(refund.success, true, JSON.stringify(refund));
  assert.strictEqual(refund.cancelled, false, '失効済みの予約は取消処理を行わない');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'EXPIRED');
  assert.strictEqual(r.paymentStatus, 'refunded', '要対応中でもStripeで確認した返金の事実は記録する');
  assert.ok(r.paymentRecoveryRequiredAt, '返金しただけでは要対応を自動解除しない');
  var customerMails = mailsTo(ctx, 'taro@example.com');
  assert.strictEqual(customerMails.length, 1, '失効済み予約には取消メールを送らず、返金完了メールのみ');
  assert.ok(/返金手続き完了/.test(customerMails[0].subject));

  var resolved = ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '返金完了をStripeで確認');
  assert.strictEqual(resolved.success, true, JSON.stringify(resolved));
  assert.strictEqual(rec(ctx).paymentRecoveryRequiredAt, '');
  assert.ok(recoveryTypes(ctx).indexOf('PAYMENT_RECOVERY_RESOLVED') !== -1);
});

test('Recoveryの解消: Stripeの状態と台帳が一致しない場合（入金額の不一致・Stripe照会失敗）は解消しない', function () {
  var ctx = setup({
    record: { paymentRecoveryRequiredAt: new Date('2026-09-20T11:05:00+09:00'), paymentRecoveryReason: 'x' },
    stripe: { amountReceived: 5000 }
  });
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'RECOVERY_VERIFICATION_FAILED');
  assert.ok(rec(ctx).paymentRecoveryRequiredAt);
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '').error.code, 'INVALID_NOTE');

  var okCtx = setup({ record: { paymentRecoveryRequiredAt: new Date('2026-09-20T11:05:00+09:00'), paymentRecoveryReason: 'x' } });
  var resolved = okCtx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, 'CONFIRMEDと入金の整合を確認');
  assert.strictEqual(resolved.success, true, JSON.stringify(resolved));
});

test('getAdminBookingDetail: 決済・返金・Recoveryの表示項目を返し、Stripe管理画面へのリンクはテストモードの画面を指す', function () {
  var ctx = setup();
  ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'PARTIAL', amountJpy: 3000, reason: '理由' });
  var detail = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  assert.strictEqual(detail.isStripeCheckout, true);
  assert.strictEqual(detail.paymentStatus, 'refunded');
  assert.strictEqual(detail.stripePaymentIntentId, PAYMENT_INTENT_ID);
  assert.strictEqual(detail.stripeRefundId, 're_test_1');
  assert.strictEqual(detail.refundAmount, 3000);
  assert.strictEqual(detail.refundDecision, 'PARTIAL');
  assert.strictEqual(detail.refundInFlight, false);
  assert.strictEqual(detail.stripeDashboardUrl, 'https://dashboard.stripe.com/test/payments/' + PAYMENT_INTENT_ID);
  assert.strictEqual(typeof detail.refundedAt, 'string');
  var serialized = JSON.stringify(detail);
  assert.ok(serialized.indexOf('sk_test_dummy') === -1, '秘密鍵を返さない');
});
