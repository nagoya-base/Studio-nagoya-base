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
    counter: 0,
    /* PR-Dレビュー対応・1回目: Checkout Session（決済URL）の状態と、失効・取得の振る舞い。
       expireBehaviors: 'ok'（open→expired）| 'network'（何もせず通信例外）|
       'network_after_expire'（失効した後に通信例外）| 'paid_before_expire'（直前に決済が
       成立しcomplete/paidになった→Stripeは失効を拒否）。retrieveBehaviors: 'ok' | 'network'。 */
    session: Object.assign({
      id: 'cs_test_0001', status: 'open', paymentStatus: 'unpaid', paymentIntent: null
    }, opts.session || {}),
    expires: [],
    expireBehaviors: (opts.expireBehaviors || []).slice(),
    retrieveBehaviors: (opts.retrieveBehaviors || []).slice()
  };
  /* PR-Dレビュー対応・2回目: 複数のCheckout Session（取消と交差して発行された新しいSession等）。
     stripe.sessionは従来どおり'cs_test_0001'を指す。 */
  stripe.sessions = {};
  stripe.sessions[stripe.session.id] = stripe.session;
  stripe.creates = [];
  stripe.onExpire = null;
  stripe.onCreateSession = null;
  stripe.addSession = function (fields) {
    var session = Object.assign({ status: 'open', paymentStatus: 'unpaid', paymentIntent: null, paymentAttemptId: 'PAY-' + BOOKING_ID + '-ABCDEF012345' }, fields);
    stripe.sessions[session.id] = session;
    return session;
  };
  function sessionBody(session) {
    session = session || stripe.session;
    return {
      id: session.id, status: session.status, payment_status: session.paymentStatus,
      amount_total: 8000, currency: 'jpy', payment_intent: session.paymentIntent,
      url: 'https://checkout.stripe.com/c/pay/' + session.id,
      expires_at: Math.floor(Date.now() / 1000) + 35 * 60,
      metadata: { bookingId: BOOKING_ID, brand: 'studio_x', paymentAttemptId: session.paymentAttemptId || 'PAY-' + BOOKING_ID + '-ABCDEF012345' }
    };
  }
  stripe.markPaid = function (sessionId) {
    var session = sessionId ? stripe.sessions[sessionId] : stripe.session;
    session.status = 'complete';
    session.paymentStatus = 'paid';
    session.paymentIntent = PAYMENT_INTENT_ID;
  };
  function refundBody(refund) {
    return {
      id: refund.id, status: refund.status, amount: refund.amount, currency: 'jpy',
      payment_intent: refund.paymentIntent, metadata: refund.metadata
    };
  }
  stripe.responder = function (url, options) {
    var method = (options && options.method) || 'get';
    var expireMatch = /\/checkout\/sessions\/([^/]+)\/expire$/.exec(url);
    if (method === 'post' && expireMatch) {
      var target = stripe.sessions[decodeURIComponent(expireMatch[1])];
      stripe.expires.push({ url: url, key: options.headers['Idempotency-Key'], sessionId: decodeURIComponent(expireMatch[1]) });
      if (typeof stripe.onExpire === 'function') {
        var expireHook = stripe.onExpire;
        stripe.onExpire = null;
        expireHook(decodeURIComponent(expireMatch[1]));
      }
      var expireBehavior = stripe.expireBehaviors.shift() || 'ok';
      if (expireBehavior === 'network') return { thrown: new Error('Timeout') };
      if (!target) return { responseCode: 404, body: { error: { type: 'invalid_request_error', message: 'No such checkout.session' } } };
      if (expireBehavior === 'paid_before_expire') stripe.markPaid(target.id);
      if (target.status !== 'open') {
        return { responseCode: 400, body: { error: { type: 'invalid_request_error', message: 'Only Checkout Sessions with a status in open can be expired.' } } };
      }
      target.status = 'expired';
      if (expireBehavior === 'network_after_expire') return { thrown: new Error('Timeout') };
      return { responseCode: 200, body: sessionBody(target) };
    }
    var getMatch = /\/checkout\/sessions\/([^/]+)$/.exec(url);
    if (method === 'get' && getMatch) {
      var retrieveBehavior = stripe.retrieveBehaviors.shift() || 'ok';
      if (retrieveBehavior === 'network') return { thrown: new Error('Timeout') };
      var found = stripe.sessions[decodeURIComponent(getMatch[1])];
      if (!found) return { responseCode: 404, body: { error: { type: 'invalid_request_error', message: 'No such checkout.session' } } };
      return { responseCode: 200, body: sessionBody(found) };
    }
    if (method === 'post' && /\/checkout\/sessions$/.test(url)) {
      /* Booking Web App（beginCardCheckout）の新しいCheckout Session発行。 */
      var form = parseForm(options.payload);
      var created = stripe.addSession({ id: 'cs_test_new_' + (stripe.creates.length + 1), paymentAttemptId: form['metadata[paymentAttemptId]'] });
      stripe.creates.push({ key: options.headers['Idempotency-Key'], sessionId: created.id });
      if (typeof stripe.onCreateSession === 'function') {
        var createHook = stripe.onCreateSession;
        stripe.onCreateSession = null;
        createHook(created.id);
      }
      return { responseCode: 200, body: sessionBody(created) };
    }
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
    LockService: opts.lockService || stubs.createLockServiceStub(),
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

/* ========================================================================== */
/* PR-Dレビュー対応・1回目: 未入金のStripe Checkout予約の取消と決済URLの失効         */
/* ========================================================================== */

var UNPAID_OVERRIDES = {
  status: 'PENDING', paymentStatus: 'checkout_pending', stripePaymentIntentId: '', paymentConfirmedAt: '',
  lastStripeEventId: '', confirmedAt: '', confirmedMailSentAt: '',
  paymentHoldExpiresAt: new Date('2026-10-01T12:30:00+09:00')
};

function unpaidSetup(options) {
  return setup(Object.assign({ record: Object.assign({}, UNPAID_OVERRIDES, (options && options.record) || {}) }, options || {}, {
    record: Object.assign({}, UNPAID_OVERRIDES, (options && options.record) || {})
  }));
}

/* Booking Webhookが署名検証済みイベントを永続化した状態を再現し、Booking Adminの
   時間主導トリガー（StripeWebhookProcessor）を1回実行する（PR-Cの処理をそのまま使う）。 */
function deliverPaidWebhook(ctx, eventId, now, sessionId) {
  var body = JSON.stringify({ id: eventId, type: 'checkout.session.completed', data: { object: { id: sessionId || 'cs_test_0001' } } });
  var claim = ctx.sandbox.StripeEventRepository.claim(eventId, 'checkout.session.completed', now);
  ctx.sandbox.StripeEventRepository.storeRawBody(claim.rowNumber, body, now);
  var run = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  return run.results.filter(function (r) { return r.eventId === eventId; })[0];
}

function openRecoveryTypes(ctx) {
  return Array.from(ctx.sandbox.RecoveryRepository.listAll(), function (r) { return r; })
    .filter(function (r) { return r.recoveryState === 'OPEN'; })
    .map(function (r) { return r.failureType; });
}

test('未入金（取消前に未決済）: 返金は拒否し、「返金なし」は取消→決済URLをStripe側で失効→失効を確認して記録する', function () {
  var ctx = unpaidSetup();
  assert.strictEqual(ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: 'x' }).error.code, 'NOT_PAID');

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '利用者からの取消依頼' });

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.checkoutExpireState, 'EXPIRED');
  assert.strictEqual(result.warning, undefined);
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED');
  assert.strictEqual(r.checkoutCancelState, 'EXPIRED');
  assert.ok(r.checkoutCancelCheckedAt);
  assert.strictEqual(r.refundDecision, '', '入金前の取消は「返金なし」の判断として記録しない');
  assert.strictEqual(r.paymentRecoveryRequiredAt, '');
  assert.strictEqual(liveEvents(ctx).length, 0);
  assert.strictEqual(ctx.stripe.session.status, 'expired');
  assert.strictEqual(ctx.stripe.expires.length, 1);
  assert.ok(/\/checkout\/sessions\/cs_test_0001\/expire$/.test(ctx.stripe.expires[0].url));
  assert.strictEqual(ctx.stripe.posts.length, 0, '返金APIは呼ばない');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
  var mails = mailsTo(ctx, 'taro@example.com');
  assert.strictEqual(mails.length, 1);
  assert.ok(/お支払い用のページは無効になりました/.test(mails[0].body));
});

test('未入金: 通常の「キャンセル」は決済URLを失効させないため拒否する（「取消・返金」へ誘導）', function () {
  var ctx = unpaidSetup();
  var result = ctx.sandbox.cancelBookingAdmin(BOOKING_ID);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REFUND_DECISION_REQUIRED');
  assert.strictEqual(rec(ctx).status, 'PENDING');
  assert.strictEqual(ctx.stripe.expires.length, 0);
  var list = ctx.sandbox.getAdminBookings().bookings;
  assert.strictEqual(list[0].refundDecisionRequired, true, '一覧でも「取消・返金」を出す');
});

test('未入金: 決済開始の結果が未確定（試行IDのみでSession未記録）なら、失効対象を特定できないため取り消さない', function () {
  var ctx = unpaidSetup({ record: { paymentStatus: 'not_started', paymentAttemptResolvedAt: '', stripeCheckoutSessionId: '' } });
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: 'x' });
  assert.strictEqual(result.error.code, 'CHECKOUT_ATTEMPT_UNRESOLVED');
  assert.strictEqual(rec(ctx).status, 'PENDING');
  assert.strictEqual(ctx.stripe.expires.length, 0);
});

test('未入金: Checkout Sessionの発行自体がStripeに拒否され（failed）決済URLが無い予約は、Stripeを呼ばずに取り消す', function () {
  var ctx = unpaidSetup({ record: { paymentStatus: 'failed', stripeCheckoutSessionId: '' } });
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: 'x' });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.checkoutExpireState, 'NO_SESSION');
  assert.strictEqual(rec(ctx).status, 'CANCELLED');
  assert.strictEqual(ctx.stripe.expires.length, 0);
});

test('失効APIの応答不明（Sessionも確認できない）: 未決済・失効済みと断定せずUNKNOWNとRecoveryで管理し、要復旧ゲートは立てない。再確認で失効を確認できたら記録を閉じる', function () {
  var ctx = unpaidSetup({ stripe: { expireBehaviors: ['network'], retrieveBehaviors: ['network'] } });

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: 'x' });

  assert.strictEqual(result.success, true, '予約の取消（枠の解放）は完了している');
  assert.strictEqual(result.checkoutExpireState, 'UNKNOWN');
  assert.strictEqual(result.warning.code, 'CHECKOUT_EXPIRE_UNKNOWN');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED');
  assert.strictEqual(r.checkoutCancelState, 'UNKNOWN');
  assert.strictEqual(r.paymentStatus, 'checkout_pending', '決済状態をfailed等へ進めない（未決済と断定しない）');
  assert.strictEqual(r.paymentRecoveryRequiredAt, '', '遅延入金をWebhookで記録できるよう要復旧ゲートは立てない');
  assert.ok(openRecoveryTypes(ctx).indexOf('PAYMENT_CHECKOUT_EXPIRE_UNKNOWN') !== -1);
  assert.ok(mailsTo(ctx, 'admin@example.com').length >= 1);
  var mail = mailsTo(ctx, 'taro@example.com')[0];
  assert.ok(/お支払いにならないよう/.test(mail.body));
  assert.ok(!/無効になりました/.test(mail.body), '失効を確認できない間は「無効になった」と案内しない');
  var recoveries = ctx.sandbox.getAdminPaymentRecoveries().items;
  assert.strictEqual(recoveries.length, 1);
  assert.strictEqual(recoveries[0].checkoutCancelState, 'UNKNOWN');

  /* 失効を確認できるまで要対応は解消できない。 */
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'CHECKOUT_EXPIRE_UNCONFIRMED');

  var reconciled = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.strictEqual(ctx.stripe.expires.length, 2);
  assert.strictEqual(ctx.stripe.expires[1].key, ctx.stripe.expires[0].key, '失効の再依頼は同じIdempotency-Key');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

test('失効APIの応答不明でも、再取得したSessionがexpiredなら失効済みとして記録する', function () {
  var ctx = unpaidSetup({ stripe: { expireBehaviors: ['network_after_expire'] } });
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: 'x' });
  assert.strictEqual(result.checkoutExpireState, 'EXPIRED');
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

test('失効と決済成功の競合: 実際の入金を記録し、予約は復活させずRecoveryで管理する。「返金なし」の判断は入金確認後に改めて行う必要がある', function () {
  var ctx = unpaidSetup({ stripe: { expireBehaviors: ['paid_before_expire'] } });

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '利用者からの取消依頼' });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(result.checkoutExpireState, 'PAYMENT_RECEIVED');
  assert.strictEqual(result.warning.code, 'CHECKOUT_EXPIRE_PAYMENT_RECEIVED');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED');
  assert.strictEqual(r.checkoutCancelState, 'PAYMENT_RECEIVED');
  assert.strictEqual(r.paymentRecoveryRequiredAt, '', 'Webhookが入金を記録できるようゲートは立てない');
  assert.ok(openRecoveryTypes(ctx).indexOf('PAYMENT_RECEIVED_AFTER_CANCEL') !== -1);
  var cancelMail = mailsTo(ctx, 'taro@example.com')[0];
  assert.ok(/改めてご連絡/.test(cancelMail.body));
  assert.ok(!/返金はございません/.test(cancelMail.body), '入金前の取消の判断で「返金なし」と案内しない');

  /* 決済成功のWebhook（PR-Cの処理）: 入金を記録し、取消済みの予約は自動確定しない。 */
  var webhookAt = new Date('2026-10-01T12:05:00+09:00');
  var processed = deliverPaidWebhook(ctx, 'evt_race_1', webhookAt);
  assert.strictEqual(processed.code, 'PAID_CONFIRM_BLOCKED', JSON.stringify(processed));
  r = rec(ctx);
  assert.strictEqual(r.paymentStatus, 'paid', '実際の入金を記録する');
  assert.strictEqual(r.stripePaymentIntentId, PAYMENT_INTENT_ID);
  assert.strictEqual(r.status, 'CANCELLED', '予約を勝手に復活させない');
  assert.strictEqual(liveEvents(ctx).length, 0, 'Calendarの枠も復活させない');
  assert.ok(r.paymentRecoveryRequiredAt);
  assert.ok(mailsTo(ctx, 'admin@example.com').some(function (m) { return /入金済みですが予約を確定できませんでした/.test(m.subject); }));
  assert.ok(!mailsTo(ctx, 'taro@example.com').some(function (m) { return /予約が確定しました/.test(m.subject); }), '確定メールを送らない');

  /* 取消時の「返金なし」相当の操作だけでは解消できない。 */
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'RECOVERY_REFUND_DECISION_REQUIRED');

  /* 管理者が入金を認識したうえで返金方針を判断すれば解消できる（ここでは全額返金）。 */
  var refund = ctx.sandbox.BookingRefund.cancelWithRefund(BOOKING_ID, { decision: 'FULL', reason: '取消後の入金のため全額返金' }, new Date('2026-10-01T12:10:00+09:00'));
  assert.strictEqual(refund.success, true, JSON.stringify(refund));
  assert.strictEqual(rec(ctx).paymentStatus, 'refunded');
  var resolved = ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '取消後の入金を全額返金したことをStripeで確認');
  assert.strictEqual(resolved.success, true, JSON.stringify(resolved));
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

test('取消後の遅延Webhook（失効の応答不明のまま入金成立）: 入金を記録し予約は復活させない。入金前に記録された「返金なし」では解消できず、入金確認後の判断が必要', function () {
  var ctx = unpaidSetup({ stripe: { expireBehaviors: ['network'], retrieveBehaviors: ['network'] } });
  ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: 'x' });
  assert.strictEqual(rec(ctx).checkoutCancelState, 'UNKNOWN');

  /* 入金前に「返金なし」の判断が台帳にあった場合（例: 過去の操作・手動記録）を再現する。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingRefundStateAtomic(BOOKING_ID, {
    refundDecision: 'NONE', refundAmount: 0, refundDecidedAt: new Date('2026-10-01T12:01:00+09:00')
  });

  /* 失効が効いていなかった決済URLから、取消後に利用者が支払った。 */
  ctx.stripe.markPaid();
  var webhookAt = new Date('2026-10-01T13:00:00+09:00');
  var processed = deliverPaidWebhook(ctx, 'evt_late_1', webhookAt);
  assert.strictEqual(processed.code, 'PAID_CONFIRM_BLOCKED', JSON.stringify(processed));
  var r = rec(ctx);
  assert.strictEqual(r.paymentStatus, 'paid', '要復旧ゲートを立てていないため遅延入金が記録される');
  assert.strictEqual(r.status, 'CANCELLED');
  assert.ok(r.paymentRecoveryRequiredAt);

  /* 決済URLの状態を再確認すると「決済成立」として記録される。 */
  var recheck = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(recheck.success, false);
  assert.strictEqual(recheck.checkoutExpireState, 'PAYMENT_RECEIVED');
  assert.strictEqual(rec(ctx).checkoutCancelState, 'PAYMENT_RECEIVED');

  /* 入金前の「返金なし」では解消できない。 */
  var refused = ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認');
  assert.strictEqual(refused.error.code, 'RECOVERY_REFUND_DECISION_REQUIRED');
  assert.ok(/入金の確認/.test(refused.error.message));
  assert.ok(rec(ctx).paymentRecoveryRequiredAt);

  /* 入金確認後に管理者が改めて「返金なし」を判断した場合は解消できる。 */
  var decided = ctx.sandbox.BookingRefund.cancelWithRefund(BOOKING_ID, { decision: 'NONE', reason: '当日キャンセル料100%に充当' }, new Date('2026-10-01T14:00:00+09:00'));
  assert.strictEqual(decided.success, true, JSON.stringify(decided));
  assert.strictEqual(ctx.stripe.posts.length, 0);
  var resolved = ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '入金を確認し、返金しない判断を記録');
  assert.strictEqual(resolved.success, true, JSON.stringify(resolved));
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

/* ========================================================================== */
/* PR-Dレビュー対応・2回目: 取消と新しい決済試行（Booking Web App）の競合            */
/* ========================================================================== */

/*
 * Booking Web AppとBooking AdminはScript Lockを共有しない。同じサンドボックス内で両方の
 * コードを動かすため、ここでは排他を行わないLockのスタブを使い（別プロジェクトのLockを表す）、
 * onFirstTryLockで「Adminが最初にLockを取った瞬間」に割り込む操作を差し込めるようにする。
 */
function separateProjectLockService(onFirstTryLock) {
  var hook = onFirstTryLock || null;
  return {
    getScriptLock: function () {
      return {
        tryLock: function () {
          if (hook) {
            var h = hook;
            hook = null;
            h();
          }
          return true;
        },
        releaseLock: function () {}
      };
    }
  };
}

var NEW_ATTEMPT_ID = 'PAY-' + BOOKING_ID + '-NEW000000001';
var CHECKOUT_PROPERTIES = {
  STRIPE_CHECKOUT_ENABLED: 'true',
  STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.com/booking/success',
  STRIPE_CHECKOUT_CANCEL_URL: 'https://example.com/booking/cancel'
};

/* 前回のSession Aは失効済みで決済状態はfailed（利用者が決済をやり直せる状態）。 */
var FAILED_PREVIOUS_ATTEMPT = {
  paymentStatus: 'failed', checkoutAccessToken: 'token-0001',
  paymentAttemptResolvedAt: new Date('2026-10-01T11:40:00+09:00')
};

function trackedRows(ctx, failureType) {
  return Array.from(ctx.sandbox.RecoveryRepository.listAll(), function (r) { return r; })
    .filter(function (r) { return r.failureType === failureType; });
}

function expiredSessionIds(ctx) {
  return ctx.stripe.expires.map(function (e) { return e.sessionId; });
}

test('競合: 事前読込の後にSession IDが変わった場合、古いSessionを失効させて取消成功とせず、最新の決済試行を読み直して新しいSessionを失効させる', function () {
  var ctx;
  ctx = unpaidSetup({
    lockService: separateProjectLockService(function () {
      /* Adminの事前読込（Phase 0）の後、Web Appが前のSession Aを失効扱いにして新しいSession Bを記録した。 */
      ctx.stripe.session.status = 'expired';
      ctx.stripe.addSession({ id: 'cs_test_B', paymentAttemptId: NEW_ATTEMPT_ID });
      ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, {
        paymentAttemptId: NEW_ATTEMPT_ID, paymentAttemptResolvedAt: new Date('2026-10-01T12:00:30+09:00'), stripeCheckoutSessionId: 'cs_test_B'
      });
    })
  });

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.checkoutExpireState, 'EXPIRED');
  assert.deepStrictEqual(expiredSessionIds(ctx), ['cs_test_B'], '最新のSession Bを失効させる（古いSession Aだけで成功としない）');
  assert.strictEqual(ctx.stripe.sessions.cs_test_B.status, 'expired');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED');
  assert.strictEqual(r.stripeCheckoutSessionId, 'cs_test_B');
  assert.strictEqual(r.checkoutCancelState, 'EXPIRED');
});

test('競合: checkout_pendingのまま決済試行IDだけが変わった（新しい試行が未解決）場合、失効対象を特定できないため取り消さない', function () {
  var ctx;
  ctx = unpaidSetup({
    lockService: separateProjectLockService(function () {
      /* Web Appが新しい決済試行を予約し、Stripeへ発行を依頼している最中（Session未記録）。 */
      ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, {
        paymentAttemptId: NEW_ATTEMPT_ID, paymentAttemptResolvedAt: ''
      });
    })
  });

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CHECKOUT_ATTEMPT_UNRESOLVED');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'PENDING', '取り消さない');
  assert.strictEqual(r.paymentStatus, 'checkout_pending');
  assert.strictEqual(r.checkoutCancelState, '');
  assert.strictEqual(ctx.stripe.expires.length, 0, '古いSession Aを失効させて成功扱いにしない');
  assert.strictEqual(liveEvents(ctx).length, 1);
});

test('競合: 事前読込時点で決済試行が未解決（前のSession IDが残っている）なら取り消さない', function () {
  var ctx = unpaidSetup({ record: { paymentAttemptId: NEW_ATTEMPT_ID, paymentAttemptResolvedAt: '' } });
  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: 'x' });
  assert.strictEqual(result.error.code, 'CHECKOUT_ATTEMPT_UNRESOLVED');
  assert.strictEqual(ctx.stripe.expires.length, 0);
});

test('交差: 取消の最中にWeb Appが（取消前にPENDINGを確認して）新しいSessionを発行した場合、取消後の記録時に検知して新しいSessionも失効させる', function () {
  var ctx = setup({
    record: Object.assign({}, UNPAID_OVERRIDES, FAILED_PREVIOUS_ATTEMPT),
    properties: CHECKOUT_PROPERTIES,
    lockService: separateProjectLockService()
  });
  ctx.stripe.session.status = 'expired';
  var repo = ctx.sandbox.SpreadsheetRepository;
  var originalCancelWrite = repo.updateBookingCancellationStateAtomic;
  var webResult = null;
  repo.updateBookingCancellationStateAtomic = function () {
    /* AdminがPhase 1で最新行を確認した後、CANCELLEDを書き込む直前に、Web App（別のLock）が
       決済開始を完了させる（Web AppからはまだPENDINGに見えている）。 */
    repo.updateBookingCancellationStateAtomic = originalCancelWrite;
    webResult = ctx.sandbox.BookingRepository.beginCardCheckout(BOOKING_ID, 'token-0001', new Date('2026-10-01T12:00:10+09:00'));
    return originalCancelWrite.apply(this, arguments);
  };

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.ok(webResult && webResult.success, 'Web Appは取消前の状態を見て決済URLを発行した: ' + JSON.stringify(webResult));
  var newSessionId = ctx.stripe.creates[0].sessionId;
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.checkoutExpireState, 'EXPIRED');
  assert.ok(expiredSessionIds(ctx).indexOf(newSessionId) !== -1, '取消後に記録された新しいSessionも失効させる');
  assert.strictEqual(ctx.stripe.sessions[newSessionId].status, 'expired');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED', '予約は取消済み');
  assert.strictEqual(r.stripeCheckoutSessionId, newSessionId, '新しい決済URLの存在は台帳で追跡できる');
  assert.strictEqual(r.checkoutCancelState, 'EXPIRED');
  var afterCancel = trackedRows(ctx, 'PAYMENT_CHECKOUT_AFTER_CANCEL');
  assert.strictEqual(afterCancel.length, 1, '取消後に発行された決済URLを記録する');
  assert.ok(afterCancel[0].errorMessage.indexOf('sessionId=' + newSessionId) !== -1);
  assert.strictEqual(afterCancel[0].recoveryState, 'RESOLVED', '失効を確認できたので閉じる');
});

test('交差: 取消後の記録時に新しい決済試行がまだ未解決なら、未決済・失効済みと断定せずUNKNOWNで追跡し、試行の確定後に再確認で失効させる', function () {
  var ctx = setup({
    record: Object.assign({}, UNPAID_OVERRIDES, FAILED_PREVIOUS_ATTEMPT),
    properties: CHECKOUT_PROPERTIES,
    lockService: separateProjectLockService()
  });
  ctx.stripe.session.status = 'expired';
  ctx.stripe.onExpire = function () {
    /* Adminが古いSession Aを失効させている間に、Web Appが新しい決済試行を予約した（Stripe呼び出し中）。 */
    ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, { paymentAttemptId: NEW_ATTEMPT_ID, paymentAttemptResolvedAt: '' });
  };

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.success, true, '取消（枠の解放）は完了している');
  assert.strictEqual(result.checkoutExpireState, 'UNKNOWN', '古いSession Aの失効だけで成功としない');
  assert.strictEqual(result.warning.code, 'CHECKOUT_EXPIRE_UNKNOWN');
  var r = rec(ctx);
  assert.strictEqual(r.checkoutCancelState, 'UNKNOWN');
  assert.strictEqual(r.paymentRecoveryRequiredAt, '', '遅延入金を記録できるようゲートは立てない');
  assert.ok(trackedRows(ctx, 'PAYMENT_CHECKOUT_AFTER_CANCEL').some(function (row) {
    return row.recoveryState === 'OPEN' && row.errorMessage.indexOf('paymentAttemptId=' + NEW_ATTEMPT_ID) !== -1;
  }));
  assert.ok(mailsTo(ctx, 'admin@example.com').length >= 1);
  assert.ok(/お支払いにならないよう/.test(mailsTo(ctx, 'taro@example.com')[0].body));
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'CHECKOUT_EXPIRE_UNCONFIRMED');

  /* 最新の試行がまだ未解決の間の再確認でも断定しない。 */
  var early = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(early.success, false);
  assert.strictEqual(early.checkoutExpireState, 'UNKNOWN');

  /* Web AppのSession発行が確定し、台帳にSession Bが記録された。 */
  ctx.stripe.addSession({ id: 'cs_test_B', paymentAttemptId: NEW_ATTEMPT_ID });
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, {
    paymentAttemptResolvedAt: new Date('2026-10-01T12:01:00+09:00'), stripeCheckoutSessionId: 'cs_test_B'
  });
  var reconciled = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(ctx.stripe.sessions.cs_test_B.status, 'expired');
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

test('交差（Web App側）: Session発行の間に予約が取り消されていたら、利用者へ決済URLを返さず失効を試み、管理者が追跡できるよう記録する', function () {
  var ctx = setup({
    record: Object.assign({}, UNPAID_OVERRIDES, FAILED_PREVIOUS_ATTEMPT),
    properties: CHECKOUT_PROPERTIES,
    lockService: separateProjectLockService()
  });
  ctx.stripe.session.status = 'expired';
  ctx.stripe.onCreateSession = function () {
    /* Web AppのStripe呼び出し中に、Booking Admin（別のLock）で取消が確定した。 */
    ctx.sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic(BOOKING_ID, {
      status: 'CANCELLED', cancelledAt: new Date('2026-10-01T12:00:05+09:00'), updatedAt: new Date('2026-10-01T12:00:05+09:00')
    });
  };

  var web = ctx.sandbox.BookingRepository.beginCardCheckout(BOOKING_ID, 'token-0001', new Date('2026-10-01T12:00:00+09:00'));

  assert.strictEqual(web.success, false);
  assert.strictEqual(web.error.code, 'BOOKING_NOT_PENDING');
  assert.strictEqual(web.checkoutUrl, undefined, '取消済みの予約の決済URLを利用者へ返さない');
  var newSessionId = ctx.stripe.creates[0].sessionId;
  assert.strictEqual(ctx.stripe.sessions[newSessionId].status, 'expired', 'Web App側でも失効を試みる');
  var r = rec(ctx);
  assert.strictEqual(r.status, 'CANCELLED', '予約を復活させない');
  assert.strictEqual(r.stripeCheckoutSessionId, newSessionId, '発行された決済URLは台帳で追跡する');
  assert.strictEqual(r.checkoutCancelState, 'UNKNOWN', 'Web App側の失効結果では断定せず、管理者の再確認対象にする');
  var rows = trackedRows(ctx, 'PAYMENT_CHECKOUT_AFTER_CANCEL');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].recoveryState, 'OPEN');

  var reconciled = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

test('交差（Web App側）: 取消後に発行されたSessionで入金が成立していた場合、入金を記録し予約は復活させずRecoveryで管理する', function () {
  var ctx = setup({
    record: Object.assign({}, UNPAID_OVERRIDES, FAILED_PREVIOUS_ATTEMPT),
    properties: CHECKOUT_PROPERTIES,
    lockService: separateProjectLockService()
  });
  ctx.stripe.session.status = 'expired';
  ctx.stripe.onCreateSession = function (sessionId) {
    ctx.sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic(BOOKING_ID, {
      status: 'CANCELLED', cancelledAt: new Date('2026-10-01T12:00:05+09:00'), updatedAt: new Date('2026-10-01T12:00:05+09:00')
    });
    /* URLは利用者へ返らないが、失効の前に何らかの経路で決済が成立した最悪のケースを再現する。 */
    ctx.stripe.markPaid(sessionId);
  };
  ctx.sandbox.BookingRepository.beginCardCheckout(BOOKING_ID, 'token-0001', new Date('2026-10-01T12:00:00+09:00'));
  var newSessionId = ctx.stripe.creates[0].sessionId;

  var recheck = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(recheck.checkoutExpireState, 'PAYMENT_RECEIVED');
  assert.ok(trackedRows(ctx, 'PAYMENT_RECEIVED_AFTER_CANCEL').some(function (row) {
    return row.recoveryState === 'OPEN' && row.errorMessage.indexOf('sessionId=' + newSessionId) !== -1;
  }));

  var processed = deliverPaidWebhook(ctx, 'evt_after_cancel_1', new Date('2026-10-01T12:10:00+09:00'), newSessionId);
  assert.strictEqual(processed.code, 'PAID_CONFIRM_BLOCKED', JSON.stringify(processed));
  var r = rec(ctx);
  assert.strictEqual(r.paymentStatus, 'paid', '実際の入金を記録する');
  assert.strictEqual(r.status, 'CANCELLED', '予約は復活させない');
  assert.ok(r.paymentRecoveryRequiredAt);
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'RECOVERY_REFUND_DECISION_REQUIRED');
});

/* ========================================================================== */
/* PR-Dレビュー対応・3回目: 最新試行の確認と最終結果の書き込みの間の競合             */
/* ========================================================================== */

/*
 * checkoutCancelStateへEXPIRED/NO_SESSIONを書き込もうとする瞬間（最新試行の確認の直後、
 * 最終結果の書き込みの直前）に、Booking Web App（Script Lockを共有しない）の書き込みを
 * 割り込ませる。hookは割り込ませる回数だけ呼ばれ、書き込まれた状態の履歴を返す。
 */
/* 履歴の先頭は取消時（Phase 1）のEXPIRE_REQUESTED。 */
function interceptFinalStateWrite(ctx, hook, times) {
  var repo = ctx.sandbox.SpreadsheetRepository;
  var original = repo.updateBookingFields;
  var remaining = times || 1;
  var history = [];
  history.stop = function () { remaining = 0; };
  repo.updateBookingFields = function (bookingId, fields) {
    if (fields && Object.prototype.hasOwnProperty.call(fields, 'checkoutCancelState')) {
      if (remaining > 0 && (fields.checkoutCancelState === 'EXPIRED' || fields.checkoutCancelState === 'NO_SESSION')) {
        remaining--;
        hook(history.length);
      }
      history.push(fields.checkoutCancelState);
    }
    return original.apply(this, arguments);
  };
  return history;
}

function webAppCommitsNewSession(ctx, sessionId, attemptId) {
  ctx.stripe.addSession({ id: sessionId, paymentAttemptId: attemptId });
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, {
    paymentAttemptId: attemptId, paymentAttemptResolvedAt: new Date('2026-10-01T12:00:30+09:00'), stripeCheckoutSessionId: sessionId
  });
}

test('3回目: 最新試行の確認直後・最終結果の書き込み直前にSession Bが発行された場合、EXPIREDを残さずBの失効・確認へ戻り、確認後にEXPIREDとする', function () {
  var ctx = unpaidSetup();
  var history = interceptFinalStateWrite(ctx, function () {
    webAppCommitsNewSession(ctx, 'cs_test_B', NEW_ATTEMPT_ID);
  });

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.deepStrictEqual(expiredSessionIds(ctx), ['cs_test_0001', 'cs_test_B'], 'Session Bも失効させる');
  assert.strictEqual(ctx.stripe.sessions.cs_test_B.status, 'expired');
  assert.deepStrictEqual(Array.from(history).slice(1), ['EXPIRED', 'UNKNOWN', 'EXPIRED'],
    'Bの発行を検知した時点でUNKNOWNへ戻し、Bの失効を確認してからEXPIREDとする');
  assert.strictEqual(result.checkoutExpireState, 'EXPIRED');
  var r = rec(ctx);
  assert.strictEqual(r.checkoutCancelState, 'EXPIRED');
  assert.strictEqual(r.stripeCheckoutSessionId, 'cs_test_B');
  var rows = trackedRows(ctx, 'PAYMENT_CHECKOUT_AFTER_CANCEL');
  assert.strictEqual(rows.length, 1, '取消後に発行されたSessionを記録する');
  assert.ok(rows[0].errorMessage.indexOf('sessionId=cs_test_B') !== -1);
  assert.strictEqual(rows[0].recoveryState, 'RESOLVED');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

test('3回目: 同じタイミングでSession ID未確定の新しい試行が始まった場合、EXPIREDを残さずUNKNOWNとしてRecoveryに残し、結果表示・再確認ボタンも未解決として扱う', function () {
  var ctx = unpaidSetup();
  var history = interceptFinalStateWrite(ctx, function () {
    /* Web Appが新しい決済試行を予約した（Stripeへ発行を依頼中。Session IDはまだ無い）。 */
    ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, { paymentAttemptId: NEW_ATTEMPT_ID, paymentAttemptResolvedAt: '' });
  });

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.success, true, '取消（枠の解放）自体は完了している');
  assert.strictEqual(result.checkoutExpireState, 'UNKNOWN', '結果表示も未解決');
  assert.strictEqual(result.warning.code, 'CHECKOUT_EXPIRE_UNKNOWN');
  assert.ok(/確認できませんでした/.test(result.message));
  assert.deepStrictEqual(Array.from(history).slice(1), ['EXPIRED', 'UNKNOWN'], '書き込み直後の再確認でUNKNOWNへ戻す');
  var r = rec(ctx);
  assert.strictEqual(r.checkoutCancelState, 'UNKNOWN');
  assert.strictEqual(r.paymentRecoveryRequiredAt, '', '遅延入金を記録できるようゲートは立てない');
  assert.ok(trackedRows(ctx, 'PAYMENT_CHECKOUT_EXPIRE_UNKNOWN').some(function (row) {
    return row.recoveryState === 'OPEN' && row.errorMessage.indexOf('paymentAttemptId=' + NEW_ATTEMPT_ID) !== -1;
  }), 'Session未確定の試行をRecoveryに残す');
  assert.ok(mailsTo(ctx, 'admin@example.com').length >= 1, '管理者へ通知する');

  /* 管理画面: 詳細・一覧・再確認ボタンの表示条件も未解決として揃う。 */
  var detail = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  assert.strictEqual(detail.checkoutCancelState, 'UNKNOWN');
  var recoveries = ctx.sandbox.getAdminPaymentRecoveries().items;
  assert.strictEqual(recoveries.length, 1);
  assert.strictEqual(recoveries[0].checkoutCancelState, 'UNKNOWN');
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'CHECKOUT_EXPIRE_UNCONFIRMED');

  /* 試行が未解決の間の再確認でも断定しない。 */
  var early = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(early.success, false);
  assert.strictEqual(early.checkoutExpireState, 'UNKNOWN');
  assert.strictEqual(rec(ctx).checkoutCancelState, 'UNKNOWN');

  /* Web AppのSession発行が確定した後の再確認で、Bを失効させて記録を閉じる。 */
  ctx.stripe.addSession({ id: 'cs_test_B', paymentAttemptId: NEW_ATTEMPT_ID });
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, {
    paymentAttemptResolvedAt: new Date('2026-10-01T12:01:00+09:00'), stripeCheckoutSessionId: 'cs_test_B'
  });
  var reconciled = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(ctx.stripe.sessions.cs_test_B.status, 'expired');
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

test('3回目: 確認中に新しい試行・Sessionが何度も発生する場合、上限回数で安全側のUNKNOWNとして止め、最新のSessionを再確認の対象に残す', function () {
  var ctx = unpaidSetup();
  var counter = 0;
  var history = interceptFinalStateWrite(ctx, function () {
    counter++;
    webAppCommitsNewSession(ctx, 'cs_test_R' + counter, 'PAY-' + BOOKING_ID + '-RPT00000000' + counter);
  }, 10);

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.checkoutExpireState, 'UNKNOWN');
  assert.ok(counter <= 3, '巡回回数に上限がある: ' + counter);
  var r = rec(ctx);
  assert.strictEqual(r.checkoutCancelState, 'UNKNOWN', '最後に書き込まれた状態はUNKNOWN');
  assert.strictEqual(history[history.length - 1], 'UNKNOWN');
  var latestSession = r.stripeCheckoutSessionId;
  var tracked = Array.from(ctx.sandbox.RecoveryRepository.listAll(), function (row) { return row; }).filter(function (row) {
    return row.recoveryState === 'OPEN' && row.errorMessage.indexOf('sessionId=' + latestSession) !== -1;
  });
  assert.ok(tracked.length >= 1, '最新のSessionを「決済URLの失効を再確認」の対象として残す');
  assert.ok(ctx.stripe.sessions[latestSession].status === 'open', '上限に達した時点の最新Sessionは未確認のまま（UNKNOWNで止めた）');
  history.stop();

  /* 試行が落ち着いた後の再確認で、残っていたSessionを失効させて閉じられる。 */
  var reconciled = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(ctx.stripe.sessions[latestSession].status, 'expired');
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

/* ========================================================================== */
/* PR-Dレビュー対応・4回目: checkoutCancelStateの保存失敗                          */
/* ========================================================================== */

/*
 * checkoutCancelStateの保存を失敗させる。mode: 'throw'（Sheetsの例外）|'silent'（例外は出ないが
 * 実際には保存されない＝読み戻し不一致）。targetState の保存を times 回だけ失敗させる。
 */
function failStateWrite(ctx, targetState, mode, times) {
  var repo = ctx.sandbox.SpreadsheetRepository;
  var original = repo.updateBookingFields;
  var remaining = times || 1;
  repo.updateBookingFields = function (bookingId, fields) {
    if (remaining > 0 && fields && fields.checkoutCancelState === targetState) {
      remaining--;
      if (mode === 'throw') throw new Error('Service Spreadsheets failed while accessing document');
      return 0;
    }
    return original.apply(this, arguments);
  };
}

function openRows(ctx, failureType) {
  return trackedRows(ctx, failureType).filter(function (row) { return row.recoveryState === 'OPEN'; });
}

test('4回目: EXPIRED保存時にSheetsの例外が起きた場合、保存成功を報告せず、Stripeで確認した事実と台帳への記録が未完了であることを分けて記録し、再確認で記録し直せる', function () {
  var ctx = unpaidSetup();
  failStateWrite(ctx, 'EXPIRED', 'throw');

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.success, true, '予約の取消自体は完了している');
  assert.strictEqual(result.checkoutExpireState, 'UNKNOWN', 'EXPIREDの保存成功を報告しない');
  assert.strictEqual(result.checkoutObservedState, 'EXPIRED', 'Stripeで確認できた事実は別に返す');
  assert.strictEqual(result.warning.code, 'CHECKOUT_STATE_NOT_RECORDED');
  assert.ok(/Stripe上では決済URLの失効を確認しましたが、予約台帳（Bookingsシート）への記録が完了していません/.test(result.message));
  assert.ok(!/失効させました/.test(result.message));
  assert.strictEqual(ctx.stripe.session.status, 'expired', 'Stripe上の失効自体は行われている');
  var r = rec(ctx);
  assert.strictEqual(r.checkoutCancelState, 'UNKNOWN', 'UNKNOWNへ差し戻して保存する');
  var rows = openRows(ctx, 'PAYMENT_CHECKOUT_STATE_NOT_RECORDED');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].errorMessage.indexOf('【Stripe上で確認できた事実】Stripe上で決済URL（sessionId=cs_test_0001）の失効を確認しました。') !== -1);
  assert.ok(rows[0].errorMessage.indexOf('【Bookingsシートへの記録】未完了') !== -1);
  assert.ok(rows[0].errorMessage.indexOf('UNKNOWNへの差し戻し: 成功') !== -1);
  assert.ok(mailsTo(ctx, 'admin@example.com').some(function (m) { return m.body.indexOf('CHECKOUT_STATE_NOT_RECORDED') !== -1; }), '管理者へ通知する');
  assert.ok(!/無効になりました/.test(mailsTo(ctx, 'taro@example.com')[0].body), '取消メールでも失効済みとは案内しない');
  var detail = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  assert.strictEqual(detail.checkoutRecheckRequired, true, '再確認ボタンを出す');
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'CHECKOUT_EXPIRE_UNCONFIRMED');

  var reconciled = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.strictEqual(openRows(ctx, 'PAYMENT_CHECKOUT_STATE_NOT_RECORDED').length, 0, '記録し直せたら閉じる');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
  assert.strictEqual(ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking.checkoutRecheckRequired, false);
});

test('4回目: EXPIREDの保存後に読み戻した値が一致しない（例外なしで保存されていない）場合も、保存成功を報告せずRecoveryへ記録する', function () {
  var ctx = unpaidSetup();
  failStateWrite(ctx, 'EXPIRED', 'silent');

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.checkoutExpireState, 'UNKNOWN');
  assert.strictEqual(result.warning.code, 'CHECKOUT_STATE_NOT_RECORDED');
  var rows = openRows(ctx, 'PAYMENT_CHECKOUT_STATE_NOT_RECORDED');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].errorMessage.indexOf('読み戻した値が一致しません（期待: EXPIRED、実際: EXPIRE_REQUESTED）') !== -1);
  assert.strictEqual(rec(ctx).checkoutCancelState, 'UNKNOWN');

  var reconciled = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});

test('4回目: 書き込み直後の再確認で新しい試行を検知したがUNKNOWNへの差し戻し保存に失敗した場合、台帳にEXPIREDが残っていても成功と報告せず、再確認で安全に記録し直せる', function () {
  var ctx = unpaidSetup();
  interceptFinalStateWrite(ctx, function () {
    /* EXPIREDを書き込む直前に、Web Appが新しい決済試行を始めた（Session IDは未確定）。 */
    ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, { paymentAttemptId: NEW_ATTEMPT_ID, paymentAttemptResolvedAt: '' });
  });
  failStateWrite(ctx, 'UNKNOWN', 'throw');

  var result = ctx.sandbox.cancelBookingWithRefund(BOOKING_ID, { decision: 'NONE', reason: '取消依頼' });

  assert.strictEqual(result.checkoutExpireState, 'UNKNOWN', '成功（EXPIRED）と報告しない');
  assert.strictEqual(result.warning.code, 'CHECKOUT_STATE_NOT_RECORDED');
  var r = rec(ctx);
  assert.strictEqual(r.checkoutCancelState, 'EXPIRED', '差し戻しに失敗したため台帳には古い値が残っている（この状態を検知できることを確認する）');
  var rows = openRows(ctx, 'PAYMENT_CHECKOUT_STATE_NOT_RECORDED');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].errorMessage.indexOf('UNKNOWNへの差し戻し: 失敗') !== -1);
  assert.ok(openRows(ctx, 'PAYMENT_CHECKOUT_EXPIRE_UNKNOWN').some(function (row) {
    return row.errorMessage.indexOf('paymentAttemptId=' + NEW_ATTEMPT_ID) !== -1;
  }), '結果未確定の新しい試行も追跡する');
  assert.ok(mailsTo(ctx, 'admin@example.com').length >= 1);

  /* 管理画面: 台帳の値はEXPIREDでも、要再確認として扱う。 */
  var detail = ctx.sandbox.getAdminBookingDetail(BOOKING_ID).booking;
  assert.strictEqual(detail.checkoutCancelState, 'EXPIRED');
  assert.strictEqual(detail.checkoutRecheckRequired, true);
  assert.strictEqual(ctx.sandbox.getAdminPaymentRecoveries().items.length, 1);
  assert.strictEqual(ctx.sandbox.resolveBookingPaymentRecovery(BOOKING_ID, '確認').error.code, 'CHECKOUT_EXPIRE_UNCONFIRMED');

  /* 再確認（台帳がEXPIREDでも実行できる）: 試行がまだ未解決なので、UNKNOWNとして記録し直す。 */
  var recheck = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(recheck.success, false);
  assert.strictEqual(recheck.checkoutExpireState, 'UNKNOWN');
  assert.strictEqual(rec(ctx).checkoutCancelState, 'UNKNOWN', '正しい状態（UNKNOWN）を記録し直した');
  assert.strictEqual(openRows(ctx, 'PAYMENT_CHECKOUT_STATE_NOT_RECORDED').length, 0);

  /* 試行の確定後の再確認で、Session Bを失効させてEXPIREDを記録する。 */
  ctx.stripe.addSession({ id: 'cs_test_B', paymentAttemptId: NEW_ATTEMPT_ID });
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic(BOOKING_ID, {
    paymentAttemptResolvedAt: new Date('2026-10-01T12:01:00+09:00'), stripeCheckoutSessionId: 'cs_test_B'
  });
  var reconciled = ctx.sandbox.reconcileBookingCheckoutExpiry(BOOKING_ID);
  assert.strictEqual(reconciled.success, true, JSON.stringify(reconciled));
  assert.strictEqual(ctx.stripe.sessions.cs_test_B.status, 'expired');
  assert.strictEqual(rec(ctx).checkoutCancelState, 'EXPIRED');
  assert.deepStrictEqual(openRecoveryTypes(ctx), []);
});
