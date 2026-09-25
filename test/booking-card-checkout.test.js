/*
 * BookingRepository.beginCardCheckout / expirePendingBookingsのcheckout_pending仮押さえ
 * 失効分岐（Issue #341 PR-B）のテスト。実際のStripe APIは呼ばず、UrlFetchAppをスタブする。
 *
 * 受入条件（PRチェックリスト）との対応:
 * - 正しいサーバー計算額・通貨でSessionが生成される
 * - 二重クリック・並行申込で二重Session生成が起きない（Idempotency-Keyの再利用）
 * - Stripe生成成功後にGAS保存が失敗しても、再試行で新しいSessionを無条件に生成しない
 * - タイムアウト・中断・期限切れ・失効確認失敗を安全に扱える
 * - Stripe側の有効期限とGAS側の仮押さえ期限が整合する
 * - 旧Payment Link方式（CARD_TTL_HOURS）の予約・現地払い予約を壊さない
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs',
  'CalendarRepository.gs',
  'Availability.gs',
  'Booking.gs',
  'CardPayment.gs',
  'StripeGateway.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'BookingRepository.gs'
];

/* expirePendingBookings（カード予約の失効）はLock解放後にBookingMailer経由で失効通知メールを
   best effort送信する（既存挙動。Issue #334）。このファイルはメール送信自体の検証対象ではない
   ため、既定で送信成功させる設定値を渡す（test/booking-confirm-expire.test.jsと同じ方針）。 */
var DEFAULT_MAIL_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

var SPREADSHEET_ID = 'ss1';
var CALENDAR_ID = 'cal1';

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign(
    {
      SPREADSHEET_ID: SPREADSHEET_ID,
      CALENDAR_ID: CALENDAR_ID,
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_CHECKOUT_ENABLED: 'true',
      STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.com/success',
      STRIPE_CHECKOUT_CANCEL_URL: 'https://example.com/cancel'
    },
    DEFAULT_MAIL_PROPERTIES,
    opts.properties || {}
  );

  var urlFetchApp = opts.urlFetchApp || stubs.createUrlFetchAppStub(defaultStripeResponder);

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    CalendarApp: opts.calendarApp || stubs.createCalendarAppStub({ cal1: { events: opts.events || [] } }),
    UrlFetchApp: urlFetchApp,
    Utilities: stubs.createUtilitiesStub(),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, globals: globals, urlFetchApp: urlFetchApp };
}

/* デフォルトのStripeレスポンダ: Idempotency-Keyからsession idを決定論的に導出する
   （同じキーで呼べば必ず同じsession idが返る＝Stripeの冪等性保証をテスト用に再現する）。 */
function defaultStripeResponder(url, options) {
  if (url.indexOf('/checkout/sessions/') !== -1 && options.method === 'get') {
    throw new Error('このテストのdefaultStripeResponderはGET（retrieve）に未対応です。個別に差し替えてください。');
  }
  var idKey = options.headers['Idempotency-Key'];
  return {
    responseCode: 200,
    body: {
      id: 'cs_' + idKey,
      url: 'https://checkout.stripe.com/pay/cs_' + idKey,
      status: 'open',
      payment_status: 'unpaid',
      expires_at: 1999999999
    }
  };
}

function sampleRecord(overrides) {
  return Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      createdAt: new Date('2026-09-20T10:00:00+09:00'),
      date: '2026-10-01',
      startAt: new Date('2026-10-01T10:00:00+09:00'),
      endAt: new Date('2026-10-01T12:00:00+09:00'),
      brand: 'studio_x',
      name: '山田太郎',
      email: 'taro@example.com',
      phone: '090-0000-0000',
      people: '2名',
      purpose: '緊縛の自主練習',
      paymentMethod: 'オンラインクレジットカード',
      status: 'PENDING',
      calendarEventId: 'event-1',
      source: 'test',
      note: '',
      paymentStatus: 'not_started',
      priceAmount: 8000,
      priceOverrideAmount: '',
      priceOverrideAt: ''
    },
    overrides || {}
  );
}

function createBookingRow(ctx, overrides) {
  var record = sampleRecord(overrides);
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);
  return record.bookingId;
}

test('beginCardCheckout: 正しいサーバー計算額(priceAmount)・通貨JPYでCheckout Sessionを生成し、stripeAmount/stripeCurrencyへスナップショット保存する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { priceAmount: 12000 });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.amount, 12000);
  assert.strictEqual(result.currency, 'JPY');
  assert.ok(result.checkoutUrl.indexOf('checkout.stripe.com') !== -1);

  var form = ctx.urlFetchApp._calls[0].options.payload;
  assert.ok(form.indexOf('unit_amount%5D=12000') !== -1 || form.indexOf('unit_amount]=12000') !== -1, 'Stripeへ送る金額は12000');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.stripeAmount, 12000);
  assert.strictEqual(found.record.stripeCurrency, 'JPY');
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending');
});

test('beginCardCheckout: 管理者の確定前修正(priceOverrideAmount)がある場合はそちらを請求額として使う', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    priceAmount: 8000, priceOverrideAmount: 7000, priceOverrideAt: new Date('2026-09-21T00:00:00+09:00')
  });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.amount, 7000, 'priceOverrideAmountが優先される（Booking.getEffectivePriceAmount経由）');
});

test('beginCardCheckout: bookingIdしか受け取らないため、クライアントが金額を主張する余地が無い', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { priceAmount: 8000 });

  /* 呼び出し側（Code.gs）がbookingId以外を渡しても、この関数のシグネチャ自体が
     bookingIdしか受け取らないため無視される（改ざんの入力経路が存在しない）。 */
  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, undefined, { amountJpy: 1 });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.amount, 8000, '余分な引数があっても常にサーバー計算額(8000)が使われる');
});

test('beginCardCheckout: Stripeの実際のexpires_atをpaymentHoldExpiresAtへ保存し、GAS側とStripe側の期限を一致させる', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.paymentHoldExpiresAt.getTime(), 1999999999 * 1000);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentHoldExpiresAt.getTime(), 1999999999 * 1000);
});

test('beginCardCheckout: 二重クリック（同一bookingIdへの連続呼び出し）は同じpaymentAttemptId・同じIdempotency-Keyを再利用し、Sessionを1つに収束させる', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    if (options.method === 'get') {
      /* 1回目のcreateで作ったSessionはまだopenのまま（決済可能）。URLからsession idを
         そのまま読み取って返す（動的に発行されるpaymentAttemptId由来のidと一致させる）。 */
      var sessionId = url.split('/checkout/sessions/')[1];
      return {
        responseCode: 200,
        body: { id: sessionId, url: 'https://checkout.stripe.com/pay/' + sessionId, status: 'open', payment_status: 'unpaid', expires_at: 1999999999 }
      };
    }
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var first = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(first.success, true);
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  var attemptId = found.record.paymentAttemptId;

  /* 1回目で既にcheckout_pendingへ進んでいるため、2回目の呼び出しはresumeExistingCheckout_
     （Stripe側のSession状態を確認して再利用する）経路へ入る。まだopenのため新しいSessionは
     作らずそのまま返す。 */
  var second = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.checkoutUrl, first.checkoutUrl, '同じSessionがそのまま返る');

  /* Stripeへの実際のSession作成呼び出しは1回だけ（2回目はretrieveのみ）。 */
  var createCalls = ctx.urlFetchApp._calls.filter(function (c) { return c.options.method === 'post'; });
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].options.headers['Idempotency-Key'], attemptId);
});

test('beginCardCheckout: Stripe Session生成に成功した直後にGASの証跡コミット(applyPaymentStateUpdate)が失敗しても、再試行は同じIdempotency-Keyを再利用し新しいSessionを無条件に発行しない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var callCount = 0;
  var realAtomicUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic;
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = function (id, fields) {
    callCount++;
    /* 1回目の呼び出しはreservePaymentAttempt_によるpaymentAttemptIdだけの永続化（成功させる）。
       2回目の呼び出しがapplyPaymentStateUpdateによる証跡コミット（ここを失敗させる＝
       「Stripe側は成功したがGASへの保存に失敗した」状況を再現する）。 */
    if (callCount === 2) {
      throw new Error('simulated sheets failure right after Stripe succeeded');
    }
    return realAtomicUpdate(id, fields);
  };

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(firstResult.success, false);
  assert.strictEqual(firstResult.error.code, 'PAYMENT_DETAIL_WRITE_FAILED');
  assert.strictEqual(firstResult.retryable, true);

  var afterFirst = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(afterFirst.record.paymentStatus, 'not_started', 'コミット失敗時はpaymentStatusを進めない');
  var reservedAttemptId = afterFirst.record.paymentAttemptId;
  assert.ok(reservedAttemptId, 'paymentAttemptIdはStripe呼び出し前に既に永続化されている');

  assert.strictEqual(ctx.urlFetchApp._calls.length, 1, 'Stripeへの呼び出しは1回目の試行で既に行われている');
  var firstIdempotencyKey = ctx.urlFetchApp._calls[0].options.headers['Idempotency-Key'];
  assert.strictEqual(firstIdempotencyKey, reservedAttemptId);

  /* 修正後（Sheets障害が解消した想定）で再試行する。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = realAtomicUpdate;
  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(secondResult.success, true, JSON.stringify(secondResult));

  assert.strictEqual(ctx.urlFetchApp._calls.length, 2, '再試行でもう一度Stripeを呼ぶ（同じキーでの冪等な呼び出し）');
  var secondIdempotencyKey = ctx.urlFetchApp._calls[1].options.headers['Idempotency-Key'];
  assert.strictEqual(secondIdempotencyKey, firstIdempotencyKey, '新しい決済試行IDを発行せず、同じIdempotency-Keyを再利用する');

  var finalRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(finalRecord.paymentStatus, 'checkout_pending');
  assert.strictEqual(finalRecord.paymentAttemptId, reservedAttemptId);
});

test('beginCardCheckout: Stripe呼び出し自体がタイムアウト/ネットワークエラーの場合は新しいSessionを発行せず、再試行可能なエラーを返す', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { thrown: new Error('simulated timeout') };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_STATUS_UNKNOWN');
  assert.strictEqual(result.retryable, true);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'not_started', '結果不明な失敗ではFAILEDへ進めない（同じpaymentAttemptIdを再利用させるため）');
  assert.ok(found.record.paymentAttemptId, 'paymentAttemptIdは既に永続化されている');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().length, 1);
});

test('beginCardCheckout: Stripeが明確な4xxエラーを返した場合はFAILEDへ進め、次回は新しいpaymentAttemptIdを発行する', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 400, body: { error: { code: 'parameter_invalid_integer', message: 'invalid' } } };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'STRIPE_REQUEST_ERROR');

  var afterFail = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(afterFail.record.paymentStatus, 'failed');
  var firstAttemptId = afterFail.record.paymentAttemptId;

  /* 設定を修正した想定で正常応答へ差し替えて再試行する。 */
  ctx.globals.UrlFetchApp.fetch = stubs.createUrlFetchAppStub(defaultStripeResponder).fetch;
  var retry = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(retry.success, true, JSON.stringify(retry));

  var afterRetry = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.notStrictEqual(afterRetry.record.paymentAttemptId, firstAttemptId, 'FAILED後の再試行では新しい決済試行IDを発行する');
});

test('beginCardCheckout: 既にpaidの予約は新しいSessionを発行しない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'paid', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1',
    stripePaymentIntentId: 'pi_1', lastStripeEventId: 'evt_1'
  });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'ALREADY_PAID');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('beginCardCheckout: checkoutEnabledがfalse（既定値）の場合はCHECKOUT_DISABLEDを返し、Stripeを一切呼ばない（本番未有効化のキルスイッチ）', function () {
  var ctx = setup({ properties: { STRIPE_CHECKOUT_ENABLED: '' } });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CHECKOUT_DISABLED');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('beginCardCheckout: 現地払い(paymentMethod!==card)の予約はNOT_CARD_PAYMENTで拒否し、Stripeを呼ばない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentMethod: 'PayPay' });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_CARD_PAYMENT');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('beginCardCheckout: checkout_pendingでStripe側が既にcomplete/決済済みの場合は自動確定せず、要復旧フラグを立てて新しいSessionも発行しない', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url) {
    assert.ok(url.indexOf('/checkout/sessions/cs_existing') !== -1);
    return { responseCode: 200, body: { id: 'cs_existing', status: 'complete', payment_status: 'paid', expires_at: 1999999999 } };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'checkout_pending', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_existing'
  });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_POSSIBLY_COMPLETED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(found.record.paymentRecoveryRequiredAt, '要復旧フラグを立てる');
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending', '自動で確定・状態変更しない');

  var createCalls = urlFetchApp._calls.filter(function (c) { return c.options.method === 'post'; });
  assert.strictEqual(createCalls.length, 0, '新しいSessionは発行しない');
});

test('beginCardCheckout: checkout_pendingでStripe側が確実にexpired/unpaidの場合のみ、FAILEDへ進めて新しい試行を安全に開始する', function () {
  var retrieveDone = false;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    if (options.method === 'get') {
      retrieveDone = true;
      return { responseCode: 200, body: { id: 'cs_old', status: 'expired', payment_status: 'unpaid', expires_at: 1 } };
    }
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'checkout_pending', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_old'
  });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.ok(retrieveDone);
  assert.strictEqual(result.success, true, JSON.stringify(result));

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending');
  assert.notStrictEqual(found.record.paymentAttemptId, 'PAY-1', '古いSessionが確実に失効しているため新しい決済試行IDを発行する');
  assert.notStrictEqual(found.record.stripeCheckoutSessionId, 'cs_old');
});

test('beginCardCheckout: checkout_pendingでStripe側の状態確認自体が失敗した場合は安全側に倒し、新しいSessionを発行しない', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    if (options.method === 'get') return { thrown: new Error('simulated network failure') };
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'checkout_pending', paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_old'
  });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_STATUS_UNKNOWN');
  assert.strictEqual(result.retryable, true);

  var createCalls = urlFetchApp._calls.filter(function (c) { return c.options.method === 'post'; });
  assert.strictEqual(createCalls.length, 0);
});

/*
 * ============================================================================
 * expirePendingBookings: checkout_pendingの仮押さえ失効分岐（Issue #341 PR-B）
 * ============================================================================
 */

function createExpirySandbox(opts) {
  return setup(opts);
}

test('expirePendingBookings: checkout_pendingのカード予約はpaymentHoldExpiresAt（短時間の仮押さえ）で判定し、旧CARD_TTL_HOURS(72h)は使わない', function () {
  var ctx = createExpirySandbox();
  var now = new Date('2026-09-25T10:00:00+09:00');
  createBookingRow(ctx, {
    bookingId: 'SX-20261001-AAAAAAAA',
    createdAt: new Date('2026-09-25T09:00:00+09:00'),
    startAt: new Date('2026-10-01T10:00:00+09:00'),
    paymentStatus: 'checkout_pending',
    paymentAttemptId: 'PAY-1',
    stripeCheckoutSessionId: 'cs_1',
    paymentHoldExpiresAt: new Date('2026-09-25T09:35:00+09:00') /* 既に仮押さえ期限切れ */
  });

  var urlFetchApp = ctx.urlFetchApp;
  urlFetchApp.fetch = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 200, body: { id: 'cs_1', status: 'expired', payment_status: 'unpaid', expires_at: 1 } };
  }).fetch;

  var result = ctx.sandbox.BookingRepository.expirePendingBookings(now);
  assert.strictEqual(result.expiredCount, 1, '受付から72時間経っていなくても、仮押さえ期限切れとStripe確認により失効する');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.status, 'EXPIRED');
  assert.strictEqual(found.record.paymentStatus, 'failed');
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-1', '決済付随情報は消去・上書きしない');
  assert.strictEqual(found.record.stripeCheckoutSessionId, 'cs_1', '決済付随情報は消去・上書きしない');
});

test('expirePendingBookings: Stripe側がまだopen（安全マージン分バッファが残っている）場合は、GAS側の仮押さえ期限を過ぎていても枠を解放しない', function () {
  var ctx = createExpirySandbox();
  var now = new Date('2026-09-25T10:00:00+09:00');
  createBookingRow(ctx, {
    bookingId: 'SX-20261001-AAAAAAAA',
    createdAt: new Date('2026-09-25T09:00:00+09:00'),
    startAt: new Date('2026-10-01T10:00:00+09:00'),
    paymentStatus: 'checkout_pending',
    paymentAttemptId: 'PAY-1',
    stripeCheckoutSessionId: 'cs_1',
    paymentHoldExpiresAt: new Date('2026-09-25T09:35:00+09:00')
  });

  ctx.urlFetchApp.fetch = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 200, body: { id: 'cs_1', status: 'open', payment_status: 'unpaid', expires_at: 1999999999 } };
  }).fetch;

  var result = ctx.sandbox.BookingRepository.expirePendingBookings(now);
  assert.strictEqual(result.expiredCount, 0);
  assert.strictEqual(result.skippedCount, 1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.status, 'PENDING', 'Stripe側で決済可能な間はGASだけで枠を解放しない');
});

test('expirePendingBookings: Stripe側が決済済み(complete/paid)の可能性を示す場合は、未払いと決めつけて枠を解放しない', function () {
  var ctx = createExpirySandbox();
  var now = new Date('2026-09-25T10:00:00+09:00');
  createBookingRow(ctx, {
    bookingId: 'SX-20261001-AAAAAAAA',
    createdAt: new Date('2026-09-25T09:00:00+09:00'),
    startAt: new Date('2026-10-01T10:00:00+09:00'),
    paymentStatus: 'checkout_pending',
    paymentAttemptId: 'PAY-1',
    stripeCheckoutSessionId: 'cs_1',
    paymentHoldExpiresAt: new Date('2026-09-25T09:35:00+09:00')
  });

  ctx.urlFetchApp.fetch = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 200, body: { id: 'cs_1', status: 'complete', payment_status: 'paid', expires_at: 1 } };
  }).fetch;

  var result = ctx.sandbox.BookingRepository.expirePendingBookings(now);
  assert.strictEqual(result.expiredCount, 0);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.status, 'PENDING');
  assert.ok(found.record.paymentRecoveryRequiredAt, '要復旧フラグを立てて管理者の確認を必須にする');
});

test('expirePendingBookings: Stripe API呼び出し自体が失敗した場合は無条件に枠を解放せず、次回トリガーへ持ち越す', function () {
  var ctx = createExpirySandbox();
  var now = new Date('2026-09-25T10:00:00+09:00');
  createBookingRow(ctx, {
    bookingId: 'SX-20261001-AAAAAAAA',
    createdAt: new Date('2026-09-25T09:00:00+09:00'),
    startAt: new Date('2026-10-01T10:00:00+09:00'),
    paymentStatus: 'checkout_pending',
    paymentAttemptId: 'PAY-1',
    stripeCheckoutSessionId: 'cs_1',
    paymentHoldExpiresAt: new Date('2026-09-25T09:35:00+09:00')
  });

  ctx.urlFetchApp.fetch = stubs.createUrlFetchAppStub(function () {
    return { thrown: new Error('simulated network failure') };
  }).fetch;

  var result = ctx.sandbox.BookingRepository.expirePendingBookings(now);
  assert.strictEqual(result.expiredCount, 0);
  assert.strictEqual(result.skippedCount, 1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.status, 'PENDING');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().length, 1);
});

test('expirePendingBookings: 旧Payment Link方式（paymentStatus=not_started固定）のカード予約は、引き続きCARD_TTL_HOURS(72h)で失効しStripeを一切呼ばない（既存互換性）', function () {
  var ctx = createExpirySandbox();
  var now = new Date('2026-09-30T00:00:00+09:00'); /* createdAtから72h以上経過 */
  createBookingRow(ctx, {
    bookingId: 'SX-20261001-AAAAAAAA',
    createdAt: new Date('2026-09-20T00:00:00+09:00'),
    startAt: new Date('2026-10-01T10:00:00+09:00'),
    paymentStatus: 'not_started'
  });

  var result = ctx.sandbox.BookingRepository.expirePendingBookings(now);
  assert.strictEqual(result.expiredCount, 1);
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0, '旧方式（Stripeを一切使わない予約）はStripeを呼ばない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId('SX-20261001-AAAAAAAA');
  assert.strictEqual(found.record.status, 'EXPIRED');
});

test('expirePendingBookings: 現地払い(PayPay)予約は既存の24時間TTLのまま失効し、Stripeを一切呼ばない（既存互換性）', function () {
  var ctx = createExpirySandbox();
  var now = new Date('2026-09-21T12:00:00+09:00'); /* createdAtから24h以上経過 */
  createBookingRow(ctx, {
    bookingId: 'SX-20261001-AAAAAAAA',
    createdAt: new Date('2026-09-20T00:00:00+09:00'),
    startAt: new Date('2026-10-01T10:00:00+09:00'),
    paymentMethod: 'PayPay',
    paymentStatus: 'not_started'
  });

  var result = ctx.sandbox.BookingRepository.expirePendingBookings(now);
  assert.strictEqual(result.expiredCount, 1);
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});
