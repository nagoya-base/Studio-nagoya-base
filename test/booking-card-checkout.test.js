/*
 * BookingRepository.beginCardCheckout / expirePendingBookingsのcheckout_pending仮押さえ
 * 失効分岐（Issue #341 PR-B）のテスト。実際のStripe APIは呼ばず、UrlFetchAppをスタブする。
 *
 * 受入条件（PRチェックリスト）との対応:
 * - 正しいサーバー計算額・通貨でSessionが生成される
 * - bookingIdだけでは第三者がCheckout URLを取得できない（PR #354レビュー対応・項目1）
 * - 二重クリック・並行申込で二重Session生成が起きない（Idempotency-Keyの再利用）
 * - Stripe生成成功後にGAS保存が失敗しても、再試行で新しいSessionを無条件に生成しない。
 *   その際、Stripeへ送るリクエスト内容（金額・通貨・expires_at）が初回と食い違わない
 *   （PR #354レビュー対応・項目2）
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

/* 予約者本人が保持している前提の決済開始トークン（PR #354レビュー対応・項目1）。
   sampleRecordの既定値と一致させ、正規の呼び出しはこの値を渡す。 */
var TOKEN = 'test-checkout-access-token-0001';

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
      priceOverrideAt: '',
      checkoutAccessToken: TOKEN
    },
    overrides || {}
  );
}

function createBookingRow(ctx, overrides) {
  var record = sampleRecord(overrides);
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);
  return record.bookingId;
}

function parseFormPayload_(payload) {
  var out = {};
  String(payload || '').split('&').forEach(function (pair) {
    if (!pair) return;
    var idx = pair.indexOf('=');
    var key = decodeURIComponent(pair.slice(0, idx));
    var value = decodeURIComponent(pair.slice(idx + 1));
    out[key] = value;
  });
  return out;
}

/*
 * ============================================================================
 * PR #354レビュー対応・項目1: bookingIdだけでは第三者がCheckout Session発行・
 * 再取得ができないこと（決済開始トークンの検証）
 * ============================================================================
 */

test('beginCardCheckout: 正しいトークンを渡した場合のみCheckout Sessionを発行する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, true, JSON.stringify(result));
});

test('beginCardCheckout: bookingIdのみ（トークン省略）ではFORBIDDENで拒否し、Stripeを一切呼ばない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, undefined);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'FORBIDDEN');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0, '第三者がbookingIdだけでCheckout URLを取得できてはならない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'not_started', '認可されていない呼び出しでは台帳を一切変更しない');
});

test('beginCardCheckout: 推測した/間違ったトークンではFORBIDDENで拒否し、Stripeを一切呼ばない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, 'guessed-wrong-token');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'FORBIDDEN');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('beginCardCheckout: 空文字トークンは、現地払い予約（checkoutAccessTokenが常に空文字）を装う攻撃にも使えない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentMethod: 'PayPay', checkoutAccessToken: '' });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, '');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'FORBIDDEN', '空文字同士を一致させてはならない');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('beginCardCheckout: 存在しないbookingIdも、トークン不一致と同じFORBIDDENで返す（存在有無のオラクルにしない）', function () {
  var ctx = setup();
  createBookingRow(ctx); // 別のbookingIdを1件作っておく

  var notFoundResult = ctx.sandbox.BookingRepository.beginCardCheckout('SX-99999999-ZZZZZZZZ', TOKEN);
  var wrongTokenResult = ctx.sandbox.BookingRepository.beginCardCheckout('SX-20261001-AAAAAAAA', 'wrong-token');

  assert.strictEqual(notFoundResult.success, false);
  assert.strictEqual(wrongTokenResult.success, false);
  assert.strictEqual(notFoundResult.error.code, wrongTokenResult.error.code, 'bookingId不在とトークン不一致を区別しない');
  assert.strictEqual(notFoundResult.error.message, wrongTokenResult.error.message);
});

test('beginCardCheckout: 他の予約のトークンでは自分の予約であってもCheckout Sessionを取得できない', function () {
  var ctx = setup();
  createBookingRow(ctx, { bookingId: 'SX-20261001-AAAAAAAA', checkoutAccessToken: 'token-for-booking-a' });
  createBookingRow(ctx, { bookingId: 'SX-20261002-BBBBBBBB', checkoutAccessToken: 'token-for-booking-b' });

  var crossResult = ctx.sandbox.BookingRepository.beginCardCheckout('SX-20261001-AAAAAAAA', 'token-for-booking-b');
  assert.strictEqual(crossResult.success, false);
  assert.strictEqual(crossResult.error.code, 'FORBIDDEN');

  var correctResult = ctx.sandbox.BookingRepository.beginCardCheckout('SX-20261001-AAAAAAAA', 'token-for-booking-a');
  assert.strictEqual(correctResult.success, true);
});

/*
 * ============================================================================
 * 正常系・金額
 * ============================================================================
 */

test('beginCardCheckout: 正しいサーバー計算額(priceAmount)・通貨JPYでCheckout Sessionを生成し、stripeAmount/stripeCurrencyへスナップショット保存する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { priceAmount: 12000 });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
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

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.amount, 7000, 'priceOverrideAmountが優先される（Booking.getEffectivePriceAmount経由）');
});

test('beginCardCheckout: bookingId・トークン以外の入力経路が無いため、クライアントが金額を主張する余地が無い', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { priceAmount: 8000 });

  /* 呼び出し側（Code.gs）がbookingId/token以外を渡しても、この関数のシグネチャ自体が
     それらを受け取らないため無視される（改ざんの入力経路が存在しない）。 */
  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN, undefined, { amountJpy: 1 });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.amount, 8000, '余分な引数があっても常にサーバー計算額(8000)が使われる');
});

test('beginCardCheckout: Stripeの実際のexpires_atをpaymentHoldExpiresAtへ保存し、GAS側とStripe側の期限を一致させる', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
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

  var first = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(first.success, true);
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  var attemptId = found.record.paymentAttemptId;

  /* 1回目で既にcheckout_pendingへ進んでいるため、2回目の呼び出しはresumeExistingCheckout_
     （Stripe側のSession状態を確認して再利用する）経路へ入る。まだopenのため新しいSessionは
     作らずそのまま返す。 */
  var second = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.checkoutUrl, first.checkoutUrl, '同じSessionがそのまま返る');

  /* Stripeへの実際のSession作成呼び出しは1回だけ（2回目はretrieveのみ）。 */
  var createCalls = ctx.urlFetchApp._calls.filter(function (c) { return c.options.method === 'post'; });
  assert.strictEqual(createCalls.length, 1);
  assert.strictEqual(createCalls[0].options.headers['Idempotency-Key'], attemptId);
});

/*
 * ============================================================================
 * PR #354レビュー対応・項目2: Stripe冪等キーとリクエスト内容の一致
 * ============================================================================
 */

test('reservePaymentAttempt_: paymentAttemptId・stripeAmount・stripeCurrency・paymentHoldExpiresAtを1回のRange.setValuesでまとめて予約する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { priceAmount: 9000 });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, true, JSON.stringify(result));

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  /* 1回目のsetValues呼び出しがreservePaymentAttempt_によるスナップショット予約
     （paymentAttemptId・stripeAmount・stripeCurrency・paymentHoldExpiresAtを含む15列の
     atomic範囲への1回の書き込み）、2回目がapplyPaymentStateUpdateの証跡コミット
     （同じ15列への2回目の書き込み）、3回目がpaymentStatus単独の書き込み。 */
  assert.strictEqual(sheet._setValuesCalls.length, 3);
  assert.strictEqual(sheet._setValuesCalls[0].numCols, 17, '予約時点で17列のatomic範囲へまとめて書く（PR #354レビュー対応・3回目でpaymentAttemptResolvedAtを追加）');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.stripeAmount, 9000);
  assert.strictEqual(found.record.stripeCurrency, 'JPY');
  assert.ok(found.record.paymentHoldExpiresAt instanceof Date || typeof found.record.paymentHoldExpiresAt.getTime === 'function');
});

test('reservePaymentAttempt_: GAS保存（証跡コミット）失敗後の再試行は、初回と完全に同一の金額・通貨・expires_atをStripeへ送る', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { priceAmount: 8000 });

  var callCount = 0;
  var realAtomicUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic;
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = function (id, fields) {
    callCount++;
    /* 1回目はreservePaymentAttempt_のスナップショット予約（成功させる）。2回目が
       applyPaymentStateUpdateの証跡コミット（ここを失敗させ、Stripe成功後のGAS保存
       失敗を再現する）。 */
    if (callCount === 2) {
      throw new Error('simulated sheets failure right after Stripe succeeded');
    }
    return realAtomicUpdate(id, fields);
  };

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(firstResult.success, false);
  assert.strictEqual(firstResult.error.code, 'PAYMENT_DETAIL_WRITE_FAILED');

  assert.strictEqual(ctx.urlFetchApp._calls.length, 1);
  var firstPayload = parseFormPayload_(ctx.urlFetchApp._calls[0].options.payload);
  var firstIdempotencyKey = ctx.urlFetchApp._calls[0].options.headers['Idempotency-Key'];

  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = realAtomicUpdate;
  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(secondResult.success, true, JSON.stringify(secondResult));

  assert.strictEqual(ctx.urlFetchApp._calls.length, 2);
  var secondPayload = parseFormPayload_(ctx.urlFetchApp._calls[1].options.payload);
  var secondIdempotencyKey = ctx.urlFetchApp._calls[1].options.headers['Idempotency-Key'];

  assert.strictEqual(secondIdempotencyKey, firstIdempotencyKey, '同じIdempotency-Keyを再利用する');
  assert.strictEqual(secondPayload['line_items[0][price_data][unit_amount]'], firstPayload['line_items[0][price_data][unit_amount]'], '金額が初回と食い違わない');
  assert.strictEqual(secondPayload['line_items[0][price_data][currency]'], firstPayload['line_items[0][price_data][currency]'], '通貨が初回と食い違わない');
  assert.strictEqual(secondPayload.expires_at, firstPayload.expires_at, 'expires_atが初回と食い違わない');
});

test('reservePaymentAttempt_: Stripe APIタイムアウト後の再試行も、初回と完全に同一のリクエスト内容を送る', function () {
  var attempt = 0;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    attempt++;
    if (attempt === 1) {
      return { thrown: new Error('simulated timeout') };
    }
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx, { priceAmount: 8000 });

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(firstResult.success, false);
  assert.strictEqual(firstResult.error.code, 'PAYMENT_STATUS_UNKNOWN');

  var firstPayload = parseFormPayload_(urlFetchApp._calls[0].options.payload);
  var firstIdempotencyKey = urlFetchApp._calls[0].options.headers['Idempotency-Key'];

  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(secondResult.success, true, JSON.stringify(secondResult));

  var secondPayload = parseFormPayload_(urlFetchApp._calls[1].options.payload);
  var secondIdempotencyKey = urlFetchApp._calls[1].options.headers['Idempotency-Key'];

  assert.strictEqual(secondIdempotencyKey, firstIdempotencyKey);
  assert.strictEqual(secondPayload['line_items[0][price_data][unit_amount]'], firstPayload['line_items[0][price_data][unit_amount]']);
  assert.strictEqual(secondPayload.expires_at, firstPayload.expires_at);
});

test('reservePaymentAttempt_: 予約後・未解決の間に料金が修正されても、再試行はスナップショット時点の金額を使い続ける（新しい金額を反映しない）', function () {
  var attempt = 0;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    attempt++;
    if (attempt === 1) {
      return { thrown: new Error('simulated timeout') };
    }
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx, { priceAmount: 8000 });

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(firstResult.success, false);

  /* 1回目の失敗（未解決の決済試行が残ったまま）と2回目の再試行の間に、管理者が
     priceOverrideAmountで金額を修正したことを再現する。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, {
    priceOverrideAmount: 3000,
    priceOverrideAt: new Date('2026-09-21T00:00:00+09:00')
  });

  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(secondResult.success, true, JSON.stringify(secondResult));
  assert.strictEqual(secondResult.amount, 8000, '未解決の決済試行の再試行は、料金修正後でも予約時点のスナップショット額のまま');

  var secondPayload = parseFormPayload_(urlFetchApp._calls[1].options.payload);
  assert.strictEqual(secondPayload['line_items[0][price_data][unit_amount]'], '8000');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.stripeAmount, 8000);
});

test('reservePaymentAttempt_: FAILEDから新しい決済試行を開始する場合は、その時点の最新料金を新しいスナップショットとして使う', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 400, body: { error: { type: 'invalid_request_error', code: 'parameter_invalid_integer', message: 'invalid' } } };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx, { priceAmount: 8000 });

  var failedResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(failedResult.success, false);
  assert.strictEqual(failedResult.error.code, 'STRIPE_REQUEST_ERROR');

  var afterFail = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(afterFail.record.paymentStatus, 'failed');
  var firstAttemptId = afterFail.record.paymentAttemptId;

  /* FAILED確定後に料金が修正された想定。新しい決済試行はこの新しい金額を使ってよい
     （前のtestの「未解決の間は変えない」とは異なるケース）。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, {
    priceOverrideAmount: 6000,
    priceOverrideAt: new Date('2026-09-21T00:00:00+09:00')
  });

  ctx.globals.UrlFetchApp.fetch = stubs.createUrlFetchAppStub(defaultStripeResponder).fetch;
  var retryResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(retryResult.success, true, JSON.stringify(retryResult));
  assert.strictEqual(retryResult.amount, 6000, '新しい決済試行では最新の料金を使う');

  var afterRetry = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.notStrictEqual(afterRetry.record.paymentAttemptId, firstAttemptId);
});

/*
 * ============================================================================
 * PR #354レビュー対応・2回目
 * 1. Stripeへ送るリクエスト全体の固定（金額・通貨・expires_at以外の全項目）
 * 2. Stripeの4xxエラー分類（idempotency_error/409/その他の不明な4xx）
 * ============================================================================
 */

test('reservePaymentAttempt_: 初回後にメールアドレス・successUrlが変更されても、未解決の決済試行の再試行はStripeへ初回と完全に同一のリクエストを送る', function () {
  var attempt = 0;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    attempt++;
    if (attempt === 1) return { thrown: new Error('simulated timeout') };
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx, { email: 'original@example.com' });

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(firstResult.success, false);
  var firstPayload = parseFormPayload_(urlFetchApp._calls[0].options.payload);

  /* 1回目（結果不明のまま未解決）と2回目の間に、予約者のメールアドレスが変わり、
     かつBooking Web AppのScript Properties（STRIPE_CHECKOUT_SUCCESS_URL/CANCEL_URL）も
     変更されたことを再現する。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { email: 'changed@example.com' });
  ctx.globals.PropertiesService.getScriptProperties().setProperty('STRIPE_CHECKOUT_SUCCESS_URL', 'https://example.com/changed-success');
  ctx.globals.PropertiesService.getScriptProperties().setProperty('STRIPE_CHECKOUT_CANCEL_URL', 'https://example.com/changed-cancel');

  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(secondResult.success, true, JSON.stringify(secondResult));
  var secondPayload = parseFormPayload_(urlFetchApp._calls[1].options.payload);

  assert.strictEqual(secondPayload.customer_email, firstPayload.customer_email, 'メールアドレスの変更は未解決の決済試行の再試行に反映しない');
  assert.strictEqual(secondPayload.customer_email, 'original@example.com');
  assert.strictEqual(secondPayload.success_url, firstPayload.success_url, 'Script Properties変更(successUrl)は未解決の決済試行の再試行に反映しない');
  assert.strictEqual(secondPayload.success_url, 'https://example.com/success');
  assert.strictEqual(secondPayload.cancel_url, firstPayload.cancel_url);
  assert.strictEqual(secondPayload.cancel_url, 'https://example.com/cancel');
});

test('reservePaymentAttempt_: 同じ冪等キーへの再試行は、送信フォーム全体（全キー・全値）が初回と完全に一致する（異なるパラメータ送信の防止）', function () {
  var attempt = 0;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    attempt++;
    if (attempt === 1) return { thrown: new Error('simulated timeout') };
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { email: 'changed@example.com' });
  ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);

  assert.strictEqual(urlFetchApp._calls.length, 2);
  assert.strictEqual(urlFetchApp._calls[1].options.payload, urlFetchApp._calls[0].options.payload, '送信するform-urlencoded文字列そのものが完全に一致する');
  assert.deepStrictEqual(urlFetchApp._calls[1].options.headers, urlFetchApp._calls[0].options.headers);
});

test('beginCardCheckout: Stripeがidempotency_errorを返した場合は要復旧として恒久的に停止し、新しい決済試行IDを発行しない', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 400, body: { error: { type: 'idempotency_error', message: 'Keys for idempotent requests can only be used with the same parameters' } } };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_RECOVERY_REQUIRED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'not_started', 'FAILEDへは進めない（恒久ゲートで停止するため遷移自体を行わない）');
  assert.ok(found.record.paymentRecoveryRequiredAt, '要復旧フラグを立てる');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().filter(function (r) { return r.failureType === 'STRIPE_IDEMPOTENCY_CONFLICT'; }).length, 1);

  var attemptIdAfterFirst = found.record.paymentAttemptId;

  /* 恒久ゲートが立った後は、正常応答へ差し替えても自動的には再試行できない
     （beginCardCheckoutの先頭でpaymentRecoveryRequiredAtを検知して即座に拒否する）。 */
  ctx.globals.UrlFetchApp.fetch = stubs.createUrlFetchAppStub(defaultStripeResponder).fetch;
  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(secondResult.success, false);
  assert.strictEqual(secondResult.error.code, 'PAYMENT_RECOVERY_REQUIRED');
  assert.strictEqual(
    ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.paymentAttemptId,
    attemptIdAfterFirst,
    '要復旧ゲートが立っている間は新しい決済試行IDを発行しない'
  );
});

test('beginCardCheckout: Stripeが409（同一キーの別リクエストが処理中）を返した場合は新しい決済試行IDを発行せず、同じキーでの再試行のみ許可する', function () {
  var attempt = 0;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    attempt++;
    if (attempt === 1) {
      return { responseCode: 409, body: { error: { message: 'A request with the same idempotency key is currently in progress' } } };
    }
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(firstResult.success, false);
  assert.strictEqual(firstResult.error.code, 'PAYMENT_STATUS_UNKNOWN');
  var firstAttemptId = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.paymentAttemptId;
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.paymentRecoveryRequiredAt, '', '409だけでは恒久ゲートを立てない（一時的な競合のため）');

  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(secondResult.success, true, JSON.stringify(secondResult));
  var secondIdempotencyKey = urlFetchApp._calls[1].options.headers['Idempotency-Key'];
  assert.strictEqual(secondIdempotencyKey, firstAttemptId, '新しい決済試行IDを発行せず、同じキーで再試行する');
});

test('beginCardCheckout: 種別を確認できない未知の4xxも新しい決済試行IDを発行せず、同じキーでの再試行のみ許可する', function () {
  var attempt = 0;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    attempt++;
    if (attempt === 1) {
      return { responseCode: 422, body: { error: { message: 'unrecognized error shape without a type field' } } };
    }
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(firstResult.success, false);
  assert.strictEqual(firstResult.error.code, 'PAYMENT_STATUS_UNKNOWN', '種別不明の4xxを確定的な失敗と決めつけない');
  var firstAttemptId = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.paymentAttemptId;

  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(secondResult.success, true, JSON.stringify(secondResult));
  var secondIdempotencyKey = urlFetchApp._calls[1].options.headers['Idempotency-Key'];
  assert.strictEqual(secondIdempotencyKey, firstAttemptId, '安全側に倒し、新しい決済試行IDを発行しない');
});

test('beginCardCheckout: 明確にinvalid_request_errorと確認できた場合のみ、安全な新規試行（新しい決済試行ID）へ進める', function () {
  var attempt = 0;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    attempt++;
    if (attempt === 1) {
      return { responseCode: 400, body: { error: { type: 'invalid_request_error', message: 'bad param' } } };
    }
    return defaultStripeResponder(url, options);
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(firstResult.success, false);
  assert.strictEqual(firstResult.error.code, 'STRIPE_REQUEST_ERROR');
  var firstAttemptId = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.paymentAttemptId;
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.paymentStatus, 'failed');

  var secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(secondResult.success, true, JSON.stringify(secondResult));
  var secondIdempotencyKey = urlFetchApp._calls[1].options.headers['Idempotency-Key'];
  assert.notStrictEqual(secondIdempotencyKey, firstAttemptId, '確定的な失敗を確認できた場合のみ新しい決済試行IDを発行する');
});

test('reservePaymentAttempt_: 保存済みのリクエストスナップショットを安全に復元できない場合（破損したJSON）は新しいSessionを発行せず要復旧として停止する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentAttemptId: 'PAY-CORRUPTED',
    stripeAmount: 8000,
    stripeCurrency: 'JPY',
    paymentHoldExpiresAt: new Date('2026-10-01T09:35:00+09:00'),
    stripeCheckoutRequestSnapshot: '{not-valid-json'
  });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_EVIDENCE_MISSING');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0, '復元できないスナップショットのまま新しいSessionを発行しない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(found.record.paymentRecoveryRequiredAt);
});

/*
 * ============================================================================
 * PR #354レビュー対応・3回目: reservePaymentAttempt_のFAILED状態における並行再試行
 *
 * 修正前は、FAILEDの予約へ複数のリクエストがほぼ同時に到達すると、1つ目が新しい
 * paymentAttemptId・スナップショットを予約してLockを解放した直後（まだpaymentStatusは
 * failedのまま・Stripe呼び出し・証跡コミットが終わっていない間）に2つ目が到達した場合、
 * 2つ目もcurrentPaymentStatus===failedのまま「新しい試行」の分岐へ入ってしまい、1つ目の
 * 予約を上書きして別のpaymentAttemptId・別のIdempotency-Keyで2回目のStripe呼び出しを
 * 行ってしまっていた（二重のCheckout Session発行につながる）。
 *
 * paymentAttemptResolvedAt（paymentStatusとは独立に「この決済試行が確定的な結果に到達
 * したか」だけを表すフラグ）を導入し、reservePaymentAttempt_の再利用判定をpaymentStatus
 * ではなくこのフラグで行うことで、両方のリクエストが同じ決済試行へ収束するようにした。
 * ============================================================================
 */

test('reservePaymentAttempt_: FAILEDから2件のリクエストがほぼ同時に到達しても、同じ決済試行ID・同じリクエスト内容へ収束する（二重のCheckout Session発行を防ぐ）', function () {
  var ctx;
  var bookingId;
  var secondResult;
  var nested = false;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    if (options.method === 'post' && !nested) {
      nested = true;
      /*
       * 1つ目のリクエスト（A）がreservePaymentAttempt_で新しい決済試行を予約しLockを
       * 解放した直後、実際にStripeへHTTP呼び出し中（paymentStatusはまだfailedのまま・
       * 証跡コミット前）に、別プロセス（B）が同じbookingIdへほぼ同時に到達したことを
       * シミュレートする。
       */
      secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
    }
    return defaultStripeResponder(url, options);
  });
  ctx = setup({ urlFetchApp: urlFetchApp });
  bookingId = createBookingRow(ctx, {
    paymentStatus: 'failed',
    paymentAttemptId: 'PAY-OLD-RESOLVED',
    paymentAttemptResolvedAt: new Date('2026-09-20T00:00:00+09:00'),
    stripeCheckoutRequestSnapshot: ''
  });

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);

  assert.strictEqual(secondResult.success, true, 'B: ' + JSON.stringify(secondResult));
  assert.strictEqual(firstResult.success, true, 'A: ' + JSON.stringify(firstResult));
  assert.strictEqual(firstResult.checkoutUrl, secondResult.checkoutUrl, 'AとBは同じSessionへ収束する');

  var createCalls = urlFetchApp._calls.filter(function (c) { return c.options.method === 'post'; });
  assert.strictEqual(createCalls.length, 2, 'AとB両方がStripeへ到達する（Stripe側のIdempotency-Key保証で1つのSessionへ収束する設計）');
  assert.strictEqual(
    createCalls[0].options.headers['Idempotency-Key'],
    createCalls[1].options.headers['Idempotency-Key'],
    '同じIdempotency-Keyへ収束する（別々のpaymentAttemptIdを発行しない）'
  );
  assert.strictEqual(createCalls[0].options.payload, createCalls[1].options.payload, '送信するリクエスト内容も完全に一致する');
  assert.notStrictEqual(createCalls[0].options.headers['Idempotency-Key'], 'PAY-OLD-RESOLVED', '解決済みの前回の試行IDを再利用してはいけない（新しいIDを発行する）');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending');
  assert.strictEqual(found.record.paymentAttemptId, createCalls[0].options.headers['Idempotency-Key']);
});

test('resumeExistingCheckout_: 同一予約への2件のリクエストがほぼ同時にexpired/unpaidを確認しても、片方だけが新しい決済試行を開始し、もう片方は古い確認結果でその証跡を上書きしない', function () {
  var ctx;
  var bookingId;
  var secondResult;
  var nested = false;
  var urlFetchApp = stubs.createUrlFetchAppStub(function (url, options) {
    if (options.method === 'get') {
      if (!nested) {
        nested = true;
        /*
         * 1つ目のリクエスト（A）が古いSession（cs_old）の状態確認（retrieveCheckoutSession）
         * のためにStripeへHTTP呼び出し中（まだ何も台帳へ書き込んでいない）に、別プロセス
         * （B）が同じbookingIdへほぼ同時に到達し、同じ古いSessionを確認して先にfailedへの
         * 遷移・新しい決済試行の開始・成功までを完了させたことをシミュレートする。
         */
        secondResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
      }
      return { responseCode: 200, body: { id: 'cs_old', status: 'expired', payment_status: 'unpaid', expires_at: 1 } };
    }
    return defaultStripeResponder(url, options);
  });
  ctx = setup({ urlFetchApp: urlFetchApp });
  bookingId = createBookingRow(ctx, {
    paymentStatus: 'checkout_pending', paymentAttemptId: 'PAY-OLD', stripeCheckoutSessionId: 'cs_old'
  });

  var firstResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);

  assert.strictEqual(secondResult.success, true, 'B: ' + JSON.stringify(secondResult));
  /*
   * A（1つ目）は、応答を受け取った時点で台帳の現在の決済試行が既にBの新しい試行へ
   * 進んでいることを検知し、古い確認結果でBの証跡を上書きせず、安全に再試行可能な
   * エラーとして停止する（新しいpaymentAttemptIdを発行しない・failedへも進めない）。
   */
  assert.strictEqual(firstResult.success, false, 'A: ' + JSON.stringify(firstResult));
  assert.strictEqual(firstResult.error.code, 'PAYMENT_STATUS_UNKNOWN');
  assert.strictEqual(firstResult.retryable, true);

  var createCalls = urlFetchApp._calls.filter(function (c) { return c.options.method === 'post'; });
  assert.strictEqual(createCalls.length, 1, '新しいCheckout Session作成はBの1回だけ（Aは新しい試行を発行しない）');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending', 'Bが開始した新しい決済試行がそのまま残る');
  assert.notStrictEqual(found.record.paymentAttemptId, 'PAY-OLD', '新しい決済試行IDへ進んでいる');
  assert.strictEqual(found.record.paymentAttemptId, createCalls[0].options.headers['Idempotency-Key']);
  assert.strictEqual(found.record.stripeCheckoutSessionId, secondResult.checkoutUrl.split('/pay/')[1], 'Bが作成したSessionのまま（Aによって上書きされていない）');
});

/*
 * ============================================================================
 * PR #354レビュー対応・4回目: handleCheckoutCreateFailure_の確定的失敗処理を
 * 「対象paymentAttemptIdの一致検証」「paymentAttemptResolvedAtの更新」
 * 「paymentStatusのFAILEDへの遷移」の一連の処理として1回のLock取得にまとめる
 * （failConfirmedCheckoutAttempt_）。3回目時点の実装は、この3つを2回の別々のLock取得
 * （settlePaymentAttemptResolved_→applyPaymentStateUpdate）に分けていたため、
 * その間に他のリクエストの新しい決済試行の予約が割り込めていた。
 * ============================================================================
 */

/*
 * LockService.getScriptLock()のtryLock成功→releaseLockの完結した回数を数えるLockService
 * スタブ（通常のcreateLockServiceStubと異なり、1回のacquire→releaseサイクルごとに
 * カウンタを1つ進める）。「一致検証・解決済みマークの更新・FAILEDへの遷移」が本当に
 * 1回のLock取得にまとまっているか（間で解放・再取得していないか）を、外部から観測できる
 * 唯一の手がかりとして使う。
 */
function createLockCycleCountingStub() {
  var held = false;
  var completedCycles = 0;
  return {
    getScriptLock: function () {
      return {
        tryLock: function () {
          if (held) return false;
          held = true;
          return true;
        },
        releaseLock: function () {
          held = false;
          completedCycles++;
        }
      };
    },
    _completedCycles: function () { return completedCycles; }
  };
}

test('handleCheckoutCreateFailure_: 確定的失敗時の「対象paymentAttemptIdの検証・解決済みマークの更新・FAILEDへの遷移」は1回のLock取得にまとまっており、途中でLockを解放・再取得しない', function () {
  var lockService = createLockCycleCountingStub();
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 400, body: { error: { type: 'invalid_request_error', message: 'bad param' } } };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp, lockService: lockService });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'STRIPE_REQUEST_ERROR');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'failed');

  /*
   * 1回目のLock取得サイクルはreservePaymentAttempt_の予約（Stripe呼び出し前）。
   * 2回目のLock取得サイクルが、対象paymentAttemptIdの一致検証・paymentAttemptResolvedAtの
   * 更新・paymentStatusのFAILEDへの遷移をまとめて完了させる。3回目レビュー対応時点の実装は
   * 2回目がさらに2つ（settlePaymentAttemptResolved_・applyPaymentStateUpdate）の別々の
   * Lock取得に分かれており、合計3回のサイクルになっていた。
   */
  assert.strictEqual(
    lockService._completedCycles(), 2,
    '合計のLock取得サイクル数が2回（予約1回＋確定的失敗処理1回）であること。3回になっている場合、' +
      '確定的失敗処理がLockを2回に分けて取得している（間に別リクエストが割り込める隙間がある）'
  );
});

test('failConfirmedCheckoutAttempt_: paymentAttemptResolvedAtの保存直後に別リクエストが到達しても、同じLockを保持し続けているため新しい決済試行を予約できない（古い失敗処理が新しい試行の状態を変更しない）', function () {
  var ctx;
  var bookingId;
  var nestedResult;
  var nested = false;
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 400, body: { error: { type: 'invalid_request_error', message: 'bad param' } } };
  });
  ctx = setup({ urlFetchApp: urlFetchApp });
  bookingId = createBookingRow(ctx);

  var realAtomicUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic;
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = function (id, fields) {
    var result = realAtomicUpdate(id, fields);
    var isResolvedAtOnlyWrite = fields &&
      Object.prototype.hasOwnProperty.call(fields, 'paymentAttemptResolvedAt') &&
      Object.keys(fields).length === 1;
    if (!nested && isResolvedAtOnlyWrite) {
      nested = true;
      /*
       * paymentAttemptResolvedAtの書き込み直後（まだ同じLockを保持したまま、
       * paymentStatusをFAILEDへ書き込む前）に、別のリクエストが同じbookingIdへ
       * 到達したことをシミュレートする。
       */
      nestedResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
    }
    return result;
  };

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'STRIPE_REQUEST_ERROR');

  assert.strictEqual(nestedResult.success, false, JSON.stringify(nestedResult));
  assert.strictEqual(
    nestedResult.error.code, 'LOCK_TIMEOUT',
    '解決済みマークの保存直後でも同じLockを保持し続けているため、割り込みリクエストは新しい決済試行を予約できない'
  );

  var createCalls = urlFetchApp._calls.filter(function (c) { return c.options.method === 'post'; });
  assert.strictEqual(createCalls.length, 1, '新しいCheckout Session作成は行われない（割り込みリクエストはLOCK_TIMEOUTで即座に拒否される）');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'failed', '古い失敗処理どおりFAILEDへ正しく遷移する');
  assert.ok(found.record.paymentAttemptResolvedAt, '解決済みマークが保存されている');
});

test('failConfirmedCheckoutAttempt_: paymentAttemptResolvedAtの書き込みに失敗した場合、成功したものとみなしてFAILEDへの遷移を続行しない', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { responseCode: 400, body: { error: { type: 'invalid_request_error', message: 'bad param' } } };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var realAtomicUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic;
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = function (id, fields) {
    var isResolvedAtOnlyWrite = fields &&
      Object.prototype.hasOwnProperty.call(fields, 'paymentAttemptResolvedAt') &&
      Object.keys(fields).length === 1;
    if (isResolvedAtOnlyWrite) {
      throw new Error('simulated write failure for paymentAttemptResolvedAt');
    }
    return realAtomicUpdate(id, fields);
  };

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_DETAIL_WRITE_FAILED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'not_started', '解決済みマークの書き込みに失敗した場合、FAILEDへは無条件に進めない');
  assert.strictEqual(found.record.paymentAttemptResolvedAt, '', '解決済みマークも書き込まれていない（書き込み失敗のため）');
  assert.ok(found.record.paymentAttemptId, '決済試行IDは既に予約済みのまま残っている（同じ試行での再試行に使える）');

  /* 書き込み失敗から復旧した後の再試行は、同じ決済試行IDのまま正しくFAILEDへ進める。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = realAtomicUpdate;
  var firstAttemptId = found.record.paymentAttemptId;
  var retryResult = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(retryResult.success, false);
  assert.strictEqual(retryResult.error.code, 'STRIPE_REQUEST_ERROR');
  var afterRetry = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(afterRetry.record.paymentStatus, 'failed');
  assert.strictEqual(afterRetry.record.paymentAttemptId, firstAttemptId, '書き込み失敗の間も同じ決済試行IDのままだった');
});

/*
 * ============================================================================
 * その他の分岐（回帰確認）
 * ============================================================================
 */

test('beginCardCheckout: Stripe呼び出し自体がタイムアウト/ネットワークエラーの場合は新しいSessionを発行せず、再試行可能なエラーを返す', function () {
  var urlFetchApp = stubs.createUrlFetchAppStub(function () {
    return { thrown: new Error('simulated timeout') };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
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
    return { responseCode: 400, body: { error: { type: 'invalid_request_error', code: 'parameter_invalid_integer', message: 'invalid' } } };
  });
  var ctx = setup({ urlFetchApp: urlFetchApp });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'STRIPE_REQUEST_ERROR');

  var afterFail = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(afterFail.record.paymentStatus, 'failed');
  var firstAttemptId = afterFail.record.paymentAttemptId;

  /* 設定を修正した想定で正常応答へ差し替えて再試行する。 */
  ctx.globals.UrlFetchApp.fetch = stubs.createUrlFetchAppStub(defaultStripeResponder).fetch;
  var retry = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
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

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'ALREADY_PAID');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('beginCardCheckout: checkoutEnabledがfalse（既定値）の場合はCHECKOUT_DISABLEDを返し、Stripeを一切呼ばない（本番未有効化のキルスイッチ）', function () {
  var ctx = setup({ properties: { STRIPE_CHECKOUT_ENABLED: '' } });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CHECKOUT_DISABLED');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('beginCardCheckout: 現地払い(paymentMethod!==card)の予約はNOT_CARD_PAYMENTで拒否し、Stripeを呼ばない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentMethod: 'PayPay', checkoutAccessToken: TOKEN });

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
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

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
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

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
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

  var result = ctx.sandbox.BookingRepository.beginCardCheckout(bookingId, TOKEN);
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
