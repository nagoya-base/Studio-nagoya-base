/*
 * 予約オプション（Issue #423。Studio Xのみ）の統合テスト。
 * createBooking（同時申込）・後付け申込・本人確認・承認／不承認・追加Stripe Checkout・
 * Webhook反映・Code.gsの公開エンドポイントを、Calendar/Sheets/Lock/Stripe/MailAppの
 * スタブ上で実際のGASコードごと動かして検証する。
 *
 * 受入条件との対応（Issue本文＋追加コメント）:
 * - 同時: 部屋のみ / 部屋+機材 / 部屋+無料 / 部屋+セッティング→PENDING_APPROVAL /
 *   部屋+機材+セッティング→未承認料金が混入しない。
 * - 後付け: bookingId維持・新しい部屋予約を作らない・重複防止・無効ID・本人確認失敗・
 *   取消/利用済み拒否・承認→Checkout→決済→CONFIRMED・不承認→DECLINED（部屋は不変）。
 * - Stripe/Webhook: bookingId/optionOrderIdの関連付け・Checkout重複生成防止・Webhook再送の
 *   冪等性・決済未完了でCONFIRMEDにならない・既存の部屋Checkout経路に触れない。
 * - 後方互換: オプションを持たない既存予約・SNB・mens（options指定なしで従来どおり）。
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
  'JapaneseHolidays.gs',
  'BookingPricing.gs',
  'CardPayment.gs',
  'EquipmentCatalog.gs',
  'BookingOptions.gs',
  'StripeGateway.gs',
  'RateLimiter.gs',
  'SpreadsheetRepository.gs',
  'OptionOrderRepository.gs',
  'RecoveryRepository.gs',
  'StripeEventRepository.gs',
  'MembershipRules.gs',
  'MemberRepository.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'OptionMailTemplates.gs',
  'OptionOrderService.gs',
  'BookingRepository.gs',
  'AdminNotifier.gs',
  'BookingAdminAlerts.gs',
  'StripeWebhookProcessor.gs',
  'Code.gs'
];

var SPREADSHEET_ID = 'ss1';
var CALENDAR_ID = 'cal1';
var EMAIL = 'taro@example.com';

function futureDateJst_(daysAhead) {
  /* Issue #480: 公開経路の予約は30日先まで（会員先行枠を除く）。テストの日付は互いに衝突しない範囲で30日以内へ畳む。 */
  if (daysAhead > 28) daysAhead = 2 + (daysAhead % 27);
  var d = new Date(Date.now() + daysAhead * 24 * 3600000);
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  var out = {};
  parts.forEach(function (part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

var FUTURE_DATE = futureDateJst_(60);

/* Stripeのスタブ状態。Checkout Session作成・取得・PaymentIntent取得を再現する。 */
function makeStripe(state) {
  var s = state;
  return function (url, options) {
    var method = (options && options.method) || 'get';
    if (method === 'post' && /\/checkout\/sessions$/.test(url)) {
      s.createCalls.push({ payload: String(options.payload), headers: options.headers });
      if (s.createResult) return s.createResult;
      s.sessionCounter += 1;
      var id = 'cs_test_' + s.sessionCounter;
      var params = {};
      String(options.payload).split('&').forEach(function (pair) {
        var kv = pair.split('=');
        params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
      });
      s.sessions[id] = {
        id: id, status: 'open', payment_status: 'unpaid', url: 'https://checkout.stripe.com/c/pay/' + id,
        payment_intent: 'pi_' + id, client_reference_id: params.client_reference_id,
        amount_total: Number(params['line_items[0][price_data][unit_amount]']), currency: 'jpy',
        metadata: { bookingId: params['metadata[bookingId]'], brand: params['metadata[brand]'], paymentAttemptId: params['metadata[paymentAttemptId]'], orderType: params['metadata[orderType]'], optionOrderId: params['metadata[optionOrderId]'] },
        expires_at: Number(params.expires_at)
      };
      return { responseCode: 200, body: s.sessions[id] };
    }
    var sessionMatch = /\/checkout\/sessions\/([^/?]+)$/.exec(url);
    if (sessionMatch) {
      var found = s.sessions[sessionMatch[1]];
      return found ? { responseCode: 200, body: found } : { responseCode: 404, body: { error: { type: 'invalid_request_error', message: 'no' } } };
    }
    var piMatch = /\/payment_intents\/([^/?]+)$/.exec(url);
    if (piMatch) {
      var sessionId = piMatch[1].replace(/^pi_/, '');
      var sess = s.sessions[sessionId];
      return { responseCode: 200, body: { id: piMatch[1], status: s.paymentIntentStatus, amount_received: s.amountReceivedOverride !== null ? s.amountReceivedOverride : (sess ? sess.amount_total : 0), currency: 'jpy' } };
    }
    throw new Error('未対応のStripe URL: ' + url);
  };
}

function setup(options) {
  var opts = options || {};
  var calendarsById = { cal1: { events: [] } };
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = Object.assign({
    CALENDAR_ID: CALENDAR_ID,
    SPREADSHEET_ID: SPREADSHEET_ID,
    BOOKING_MAIL_DISPLAY_NAME: 'Studio X',
    BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
    BOOKING_CONTACT_EMAIL: 'contact@example.com',
    ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
    BOOKING_ADMIN_URL: 'https://script.google.com/macros/s/admin/exec',
    RATE_LIMIT_EMAIL_COUNT: '100',
    RATE_LIMIT_GLOBAL_COUNT: '1000',
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_CHECKOUT_ENABLED: 'true',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/payment-complete.html?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/'
  }, opts.properties || {});
  var stripeState = { sessions: {}, sessionCounter: 0, createCalls: [], createResult: null, paymentIntentStatus: 'succeeded', amountReceivedOverride: null };
  var urlFetchApp = stubs.createUrlFetchAppStub(makeStripe(stripeState));
  var mailApp = stubs.createMailAppStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp,
    UrlFetchApp: urlFetchApp,
    Logger: stubs.createLoggerStub(),
    ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  /* スタッフ対応は会員限定（Issue #472）。会員資格の正本は会員台帳（#471）の MemberRepository.isMemberForMonth。
     既定ではメールの会員資格を満たすものとして通し、非会員・台帳障害は ctx.members で試験する
     （members: true=全員有効 / false=全員非会員 / { 'メール': ['YYYY-MM', ...] }=利用月ごと）。 */
  var memberState = { rule: opts.members === undefined ? true : opts.members, calls: [] };
  if (opts.members !== 'LEDGER') sandbox.MemberRepository.isMemberForMonth = function (email, month) {
    memberState.calls.push({ email: email, month: month });
    if (memberState.rule === 'THROW') throw new Error('Sheets error');
    if (memberState.rule === true || memberState.rule === false) return memberState.rule;
    return (memberState.rule[String(email).toLowerCase()] || []).indexOf(month) !== -1;
  };
  /* Issue #532: 資格判定は日付（isMemberOnDate）。月単位のスタブへ委譲して、既存の利用月ごとの試験を保つ。 */
  if (opts.members !== 'LEDGER') sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    return sandbox.MemberRepository.isMemberForMonth(email, String(date).substring(0, 7));
  };
  /* 有料レンタル機材は全件Admin許可制（Issue #430）。既定ではストロボだけ許可済みにして、
     「許可済みなら即決済待ち」の経路を試験する。許可の保留・付与を試験するテストは COB 等を使う。 */
  if (opts.grantStrobe !== false) {
    sandbox.OptionOrderService.grantVideoLightEligibility(EMAIL, 'STROBE_MONOBLOCK', 'test setup');
  }
  return { memberState: memberState, sandbox: sandbox, mailApp: mailApp, urlFetchApp: urlFetchApp, stripe: stripeState, sheets: spreadsheetsById[SPREADSHEET_ID], calendars: calendarsById };
}

function payload(overrides) {
  return Object.assign({
    brand: 'studio_x', customerType: 'returning', date: FUTURE_DATE, startTime: '10:00', durationMinutes: 120,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '2名', purpose: '作品撮り',
    paymentMethod: '現金', note: '', source: 'test'
  }, overrides || {});
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function createRoom(ctx, overrides) {
  var result = ctx.sandbox.BookingRepository.createBooking(payload(overrides));
  assert.strictEqual(result.success, true, JSON.stringify(result.error));
  return result;
}

function confirmRoom(ctx, bookingId) {
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { status: 'CONFIRMED' });
}

function orderRows(ctx, bookingId) {
  return ctx.sandbox.OptionOrderRepository.listByBookingId(bookingId).map(function (r) { return plain(r.record); });
}

function room(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

function mailsTo(ctx, to) {
  return ctx.mailApp._sentEmails.filter(function (m) { return m.to === to; });
}

var FULL_SELECTION = { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { STROBE_MONOBLOCK: 1 }, layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'STAFF', emailSupport: true };

// ============================================================================
// 同時申込
// ============================================================================

test('同時: 部屋のみ（options無し）は従来どおり。OptionOrdersに行を作らず、レスポンスにoptionsも付かない', function () {
  var ctx = setup();
  var result = createRoom(ctx);
  assert.strictEqual(result.options, undefined);
  assert.strictEqual(orderRows(ctx, result.bookingId).length, 0);
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('同時: 部屋+セッティング+機材+無料 → 3注文に分かれ、同じbookingIdに紐付く。Stripeは呼ばれず、部屋はPENDINGのまま', function () {
  var ctx = setup();
  var result = createRoom(ctx, { options: FULL_SELECTION });
  assert.strictEqual(result.options.success, true);
  assert.strictEqual(result.options.orders.length, 3);

  var rows = orderRows(ctx, result.bookingId);
  assert.strictEqual(rows.length, 3);
  rows.forEach(function (r) {
    assert.strictEqual(r.bookingId, result.bookingId);
    assert.match(r.optionOrderId, /^OPT-[0-9A-F]{8}$/);
    assert.strictEqual(r.source, 'WITH_BOOKING');
    assert.strictEqual(r.brand, 'studio_x');
  });
  var byCat = {};
  rows.forEach(function (r) { byCat[r.category] = r; });

  // スタッフ対応: 必ずPENDING_APPROVAL・未課金・5,000円（セット）
  assert.strictEqual(byCat.STAFF_SERVICE.status, 'PENDING_APPROVAL');
  assert.strictEqual(byCat.STAFF_SERVICE.approvalStatus, 'PENDING_APPROVAL');
  assert.strictEqual(byCat.STAFF_SERVICE.paymentStatus, 'NOT_STARTED');
  assert.strictEqual(Number(byCat.STAFF_SERVICE.amountJpy), 5000);
  // 機材: 設定値。未承認のスタッフ料金が混ざらない
  assert.strictEqual(Number(byCat.EQUIPMENT.amountJpy), 800);
  assert.strictEqual(byCat.EQUIPMENT.status, 'AWAITING_PAYMENT');
  // 無料: 即確定・課金なし
  assert.strictEqual(byCat.FREE.status, 'CONFIRMED');
  assert.strictEqual(Number(byCat.FREE.amountJpy), 0);
  assert.strictEqual(byCat.FREE.paymentStatus, 'NOT_REQUIRED');

  // 部屋予約のstatusとオプションのstatusは別。部屋はPENDINGのまま、Stripeは一切呼ばれない
  assert.strictEqual(room(ctx, result.bookingId).status, 'PENDING');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0, '申込時点ではCheckoutを生成しない');
  // 予約IDの生成方式は変更しない（SX-日付-8桁）
  assert.match(result.bookingId, /^SX-/);
});

test('同時: 受付メールにスタッフ対応の事前確認制の説明と無料セルフの定型案内（メールサポート含む）が入り、管理者へ承認依頼が届く', function () {
  var ctx = setup();
  var result = createRoom(ctx, { options: FULL_SELECTION });
  var mails = mailsTo(ctx, EMAIL).filter(function (m) { return m.subject.indexOf('オプション') !== -1; });
  assert.strictEqual(mails.length, 1);
  var body = mails[0].body;
  assert.ok(body.indexOf('申込時点ではスタッフ対応は確定していません') !== -1);
  assert.ok(body.indexOf('承認後にオンライン決済をお願いします') !== -1);
  // 5テーマ共通のセルフ案内は「セルフ」を選んだ項目にだけ付く。スタッフ依頼のテーマ(教室)は設営・片付けともスタッフなのでセルフ案内なし
  assert.ok(body.indexOf('メールでお問い合わせください') !== -1);
  assert.ok(body.indexOf(result.bookingId) !== -1);
  assert.ok(!/解錠|キーボックス/.test(body), '秘密情報は含めない');
  var adminMails = mailsTo(ctx, 'admin@example.com').filter(function (m) { return m.subject.indexOf('承認依頼') !== -1; });
  assert.strictEqual(adminMails.length, 1);
  assert.ok(adminMails[0].body.indexOf(result.bookingId) !== -1);
  assert.ok(adminMails[0].body.indexOf('山田') === -1 && adminMails[0].body.indexOf(EMAIL) === -1, '管理者通知にPIIを含めない');
});

test('同時: 無料セルフ選択の受付メールにテーマ別の確定済み定型案内が付く（グランジ・白背景布）', function () {
  var ctx = setup();
  createRoom(ctx, { options: { layouts: ['GRUNGE', 'WHITE_BACKDROP'] } });
  var mail = mailsTo(ctx, EMAIL).filter(function (m) { return m.subject.indexOf('オプション') !== -1; })[0];
  assert.ok(mail.body.indexOf('【グランジセットのセルフセッティング】') !== -1);
  assert.ok(mail.body.indexOf('背景スタンド、または竹の梁にセットして使用してください') !== -1, '白背景布は確定文言');
  assert.ok(mail.body.indexOf('【白背景布のセルフセッティング】') !== -1);
  assert.ok(mail.body.indexOf('使用後は清掃して元の位置へ戻してください。') !== -1);
  assert.ok(mail.body.indexOf('濡れ・飲食物・化粧品の付着に注意してください') !== -1, 'グランジは確定文言');
  assert.ok(mail.body.indexOf('運営にて内容を確認中です') === -1);
  assert.ok(mail.body.indexOf('お支払い') === -1 || mail.body.indexOf('無料') !== -1);
});

test('同時: SNB / mensでoptions付きは予約自体を作らず拒否。options無しの従来予約は変わらない（Studio Xのみ）', function () {
  ['snb', 'mens'].forEach(function (brand) {
    var ctx = setup();
    var rejected = ctx.sandbox.BookingRepository.createBooking(payload({ brand: brand, options: { emailSupport: true } }));
    assert.strictEqual(rejected.success, false, brand);
    assert.strictEqual(rejected.error.code, 'OPTIONS_NOT_AVAILABLE', brand);
    assert.strictEqual(ctx.calendars.cal1.events.length, 0, brand + ': Calendarに予約枠を作らない');
    assert.strictEqual(ctx.sheets.Bookings === undefined || ctx.sheets.Bookings.getLastRow() <= 1, true, brand + ': 台帳に行を作らない');

    var ok = ctx.sandbox.BookingRepository.createBooking(payload({ brand: brand }));
    assert.strictEqual(ok.success, true, brand);
    assert.strictEqual(ok.options, undefined, brand);
  });
});

test('同時: 不正なオプション指定・在庫超過は予約を作る前に拒否する', function () {
  var ctx = setup();
  assert.strictEqual(ctx.sandbox.BookingRepository.createBooking(payload({ options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { LASER: 1 }, setupService: 'SELF', cleanupService: 'SELF' } })).error.code, 'UNKNOWN_OPTION');
  assert.strictEqual(ctx.sandbox.BookingRepository.createBooking(payload({ options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { STAND_260: 4 }, setupService: 'SELF', cleanupService: 'SELF' } })).error.code, 'STOCK_EXCEEDED');
  assert.strictEqual(ctx.sandbox.BookingRepository.createBooking(payload({ options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { STAND_260: 1.5 }, setupService: 'SELF', cleanupService: 'SELF' } })).error.code, 'INVALID_OPTIONS');
  assert.strictEqual(ctx.calendars.cal1.events.length, 0);
});

test('同時: 空のoptions指定（何も選ばない）は部屋のみの予約として成功する', function () {
  var ctx = setup();
  var result = createRoom(ctx, { options: {} });
  assert.strictEqual(result.options, undefined);
  assert.strictEqual(orderRows(ctx, result.bookingId).length, 0);
});

// ============================================================================
// ビデオライトのセルフレンタル資格
// ============================================================================

test('ビデオライト: 未許可の申込は拒否して消さず保留注文として残り、Checkoutには進まない。管理者が「許可済みにして進める」と選べる', function () {
  var ctx = setup();
  var svc = ctx.sandbox.OptionOrderService;

  // 同時申込: 予約は成立し、定常光は保留注文になる（資格の無い申込でも予約は妨げない）
  var first = ctx.sandbox.BookingRepository.createBooking(payload({ options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' } }));
  assert.strictEqual(first.success, true, JSON.stringify(first.error));
  var held = first.options.orders[0];
  assert.strictEqual(held.status, 'PENDING_APPROVAL');
  assert.strictEqual(held.eligibilityHold, true);
  assert.strictEqual(held.payable, false);
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0, '未許可でCheckoutを作らない');
  var adminMail = mailsTo(ctx, 'admin@example.com').filter(function (m) { return m.subject.indexOf('承認依頼') !== -1; });
  assert.strictEqual(adminMail.length, 1, '管理者へ許可確認の依頼が届く');
  var custMail = mailsTo(ctx, EMAIL).filter(function (m) { return m.subject.indexOf('オプション') !== -1; })[0];
  assert.ok(custMail.body.indexOf('利用許可の確認待ち（まだ確定していません・お支払いは不要です）') !== -1);

  confirmRoom(ctx, first.bookingId);
  assert.strictEqual(svc.startOptionCheckout(first.bookingId, EMAIL, held.optionOrderId).error.code, 'APPROVAL_REQUIRED');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);

  // Admin: 資格未確認として見える
  var view = svc.listForAdmin(first.bookingId).orders[0];
  assert.strictEqual(view.eligibilityHold, true);
  assert.strictEqual(view.eligibilityMissing, true);
  assert.deepStrictEqual(plain(view.eligibilityMissingLabels), ['バイカラーCOBライト（定常光）']);

  // 「許可済みにして進める」= 承認: 機材コード単位の許可を記録し、支払い可能になる（機材用の承認メール）
  var before = mailsTo(ctx, EMAIL).length;
  var approved = svc.approveOrder(held.optionOrderId);
  assert.strictEqual(approved.success, true, JSON.stringify(approved.error));
  var row = orderRows(ctx, first.bookingId)[0];
  assert.strictEqual(row.status, 'AWAITING_PAYMENT');
  assert.strictEqual(row.approvalStatus, 'APPROVED');
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.hasEligibilityGrant(EMAIL, 'COB_BICOLOR'), true);
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.hasEligibilityGrant(EMAIL, 'COB_FULLCOLOR'), false, '他の機材コードは許可されない');
  var approvalMail = mailsTo(ctx, EMAIL).slice(before)[0];
  assert.ok(approvalMail.body.indexOf('有料レンタル機材のセルフレンタルについて、利用許可を確認しました') !== -1);
  assert.ok(approvalMail.body.indexOf('スタッフ対応') === -1, '機材用の文面');
  assert.strictEqual(svc.approveOrder(held.optionOrderId).alreadyDecided, true, '二重承認は冪等');
  assert.strictEqual(mailsTo(ctx, EMAIL).slice(before).length, 1);
  assert.strictEqual(svc.startOptionCheckout(first.bookingId, EMAIL, held.optionOrderId).success, true);
  assert.strictEqual(ctx.stripe.createCalls.length, 1);

  // 後付けでも同じ（未許可は保留）
  var next = createRoom(ctx, { date: futureDateJst_(61), email: 'hanako@example.com' });
  confirmRoom(ctx, next.bookingId);
  var addon = svc.submitAddonOptions(next.bookingId, 'hanako@example.com', { equipment: { COB_FULLCOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(addon.success, true);
  assert.strictEqual(addon.orders[0].status, 'PENDING_APPROVAL');
  assert.strictEqual(svc.startOptionCheckout(next.bookingId, 'hanako@example.com', addon.orders[0].optionOrderId).error.code, 'APPROVAL_REQUIRED');
});

test('ビデオライト: 保留注文の不承認はDECLINEDになり、部屋予約は不変。機材用の否認メールで、二重否認は冪等', function () {
  var ctx = setup();
  var svc = ctx.sandbox.OptionOrderService;
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var res = svc.submitAddonOptions(r.bookingId, EMAIL, { equipment: { PANEL_FULLCOLOR: 1, STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(res.orders.length, 2, 'ストロボ分と定常光(保留)分に分かれる');
  var hold = res.orders.filter(function (o) { return o.status === 'PENDING_APPROVAL'; })[0];
  var strobe = res.orders.filter(function (o) { return o.status === 'AWAITING_PAYMENT'; })[0];
  assert.strictEqual(strobe.amountJpy, 800, '保留分の金額がストロボの決済額に混ざらない');

  var roomBefore = plain(room(ctx, r.bookingId));
  var before = mailsTo(ctx, EMAIL).length;
  var declined = svc.declineOrder(hold.optionOrderId, 'レクチャー未実施');
  assert.strictEqual(declined.success, true);
  assert.strictEqual(orderRows(ctx, r.bookingId).filter(function (x) { return x.optionOrderId === hold.optionOrderId; })[0].status, 'DECLINED');
  assert.deepStrictEqual(plain(room(ctx, r.bookingId)), roomBefore, '否認しても部屋予約には影響しない');
  var mail = mailsTo(ctx, EMAIL).slice(before)[0];
  assert.ok(mail.body.indexOf('管理者による利用許可を確認できなかった') !== -1);
  assert.ok(mail.body.indexOf('スタッフの予定') === -1 && mail.body.indexOf('セルフでの設営') === -1, 'スタッフ対応向けの文面を使わない');
  assert.strictEqual(svc.declineOrder(hold.optionOrderId, '').alreadyDecided, true);
  assert.strictEqual(svc.approveOrder(hold.optionOrderId).error.code, 'INVALID_TRANSITION', '否認後は承認できない');
  assert.strictEqual(svc.startOptionCheckout(r.bookingId, EMAIL, hold.optionOrderId).error.code, 'ORDER_DECLINED');
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.hasEligibilityGrant(EMAIL, 'PANEL_FULLCOLOR'), false, '否認では許可を付与しない');
  // ストロボの注文は影響を受けず支払える
  assert.strictEqual(svc.startOptionCheckout(r.bookingId, EMAIL, strobe.optionOrderId).success, true);
});

test('ビデオライト: 過去に支払い済みで借りた履歴があっても自動では資格ありにならない（保留になりAdminの付与のみが正）', function () {
  var ctx = setup();
  var past = createRoom(ctx);
  confirmRoom(ctx, past.bookingId);
  ctx.sandbox.OptionOrderRepository.appendOrders([{
    optionOrderId: 'OPT-PAST0001', bookingId: past.bookingId, brand: 'studio_x', category: 'EQUIPMENT', source: 'ADDON',
    items: ['EQ:COB_BICOLOR:1'], amountJpy: 800, currency: 'JPY', approvalStatus: 'NOT_REQUIRED', paymentStatus: 'PAID',
    status: 'CONFIRMED', customerEmail: EMAIL, createdAt: new Date(), updatedAt: new Date()
  }]);

  var again = ctx.sandbox.BookingRepository.createBooking(payload({ date: futureDateJst_(61), options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' } }));
  assert.strictEqual(again.success, true);
  assert.strictEqual(again.options.orders[0].status, 'PENDING_APPROVAL', '履歴があっても自動では資格ありにしない');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);

  // Adminが機材コード単位で付与した後の申込は、承認不要で支払い待ちになる
  assert.strictEqual(ctx.sandbox.OptionOrderService.grantVideoLightEligibility(EMAIL, 'COB_BICOLOR', '対面レクチャー済み').success, true);
  var allowed = ctx.sandbox.BookingRepository.createBooking(payload({ date: futureDateJst_(62), options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' } }));
  assert.strictEqual(allowed.success, true, JSON.stringify(allowed.error));
  assert.strictEqual(allowed.options.orders[0].status, 'AWAITING_PAYMENT');

  // 他人のメールアドレスの許可は引き継がれない
  var other = ctx.sandbox.BookingRepository.createBooking(payload({ date: futureDateJst_(63), email: 'hanako@example.com', options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' } }));
  assert.strictEqual(other.options.orders[0].status, 'PENDING_APPROVAL');
});

// ============================================================================
// 後付け申込
// ============================================================================

test('後付け: CONFIRMED予約へ追加しても予約IDは同じまま、新しい部屋予約・Calendar枠は作られない', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var bookingsBefore = ctx.sandbox.SpreadsheetRepository.getAllBookings().length;
  var eventsBefore = ctx.calendars.cal1.events.length;

  var result = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF', emailSupport: true });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.bookingId, r.bookingId);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllBookings().length, bookingsBefore);
  assert.strictEqual(ctx.calendars.cal1.events.length, eventsBefore);
  orderRows(ctx, r.bookingId).forEach(function (row) {
    assert.strictEqual(row.bookingId, r.bookingId);
    assert.strictEqual(row.source, 'ADDON');
  });
  assert.strictEqual(room(ctx, r.bookingId).status, 'CONFIRMED');
});

test('後付け: CONFIRMED予約へセッティングを追加するとPENDING_APPROVAL（Checkoutは生成されない）', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var result = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { layouts: ['JAPANESE'], setupService: 'STAFF', cleanupService: 'SELF' });
  assert.strictEqual(result.success, true);
  var staff = result.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0];
  assert.strictEqual(staff.status, 'PENDING_APPROVAL');
  assert.strictEqual(staff.amountJpy, 3000);
  assert.strictEqual(staff.payable, false);
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('後付け: 同じオプションの重複追加は拒否される', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF', emailSupport: true }).success, true);
  var dup = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(dup.error.code, 'STOCK_EXCEEDED', '在庫1点の機材を二重に借りられない');
  var dupFree = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { emailSupport: true });
  assert.strictEqual(dupFree.error.code, 'DUPLICATE_OPTION');
  assert.strictEqual(orderRows(ctx, r.bookingId).length, 2, '失敗した申込は注文を作らない');
});

test('後付け: 無効なbookingId・メール不一致・大文字小文字違いのメール。失敗理由は区別せず同一のFORBIDDEN', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var unknown = ctx.sandbox.OptionOrderService.submitAddonOptions('SX-20300101-ZZZZZZZZ', EMAIL, { emailSupport: true });
  var wrongEmail = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, 'other@example.com', { emailSupport: true });
  var emptyEmail = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, '', { emailSupport: true });
  [unknown, wrongEmail, emptyEmail].forEach(function (x) {
    assert.strictEqual(x.success, false);
    assert.strictEqual(x.error.code, 'FORBIDDEN');
  });
  assert.strictEqual(unknown.error.message, wrongEmail.error.message, '予約IDの存在確認に使えない');
  assert.strictEqual(orderRows(ctx, r.bookingId).length, 0);
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, ' TARO@Example.COM ', { emailSupport: true }).success, true);
});

test('後付け: 取消済み・期限切れ・利用開始後の予約、およびSNB予約には追加できない', function () {
  var ctx = setup();
  var cancelled = createRoom(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(cancelled.bookingId, { status: 'CANCELLED' });
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(cancelled.bookingId, EMAIL, { emailSupport: true }).error.code, 'BOOKING_NOT_ELIGIBLE');

  var expired = createRoom(ctx, { date: futureDateJst_(61) });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(expired.bookingId, { status: 'EXPIRED' });
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(expired.bookingId, EMAIL, { emailSupport: true }).error.code, 'BOOKING_NOT_ELIGIBLE');

  var started = createRoom(ctx, { date: futureDateJst_(62) });
  confirmRoom(ctx, started.bookingId);
  var past = new Date(Date.now() - 3600000);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(started.bookingId, { startAt: past, endAt: new Date(Date.now() + 3600000) });
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(started.bookingId, EMAIL, { emailSupport: true }).error.code, 'BOOKING_ALREADY_STARTED');

  var snb = createRoom(ctx, { brand: 'snb', date: futureDateJst_(63) });
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(snb.bookingId, EMAIL, { emailSupport: true }).error.code, 'OPTIONS_NOT_AVAILABLE');
});

test('後付け: 締切は設定値のみ。設定すれば適用され、未設定なら独自の締切は無い', function () {
  var ctx = setup({ properties: { OPTION_ADDON_DEADLINE_HOURS: '100000' } });
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { emailSupport: true }).error.code, 'ADDON_DEADLINE_PASSED');
});

test('後付け: 旧データ（Optionシートが無い・オプション無し）でも照会は正常に動く（後方互換）', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  var summary = ctx.sandbox.OptionOrderService.getCustomerSummary(r.bookingId, EMAIL);
  assert.strictEqual(summary.success, true);
  assert.strictEqual(summary.orders.length, 0);
  assert.strictEqual(summary.acceptsOptions, true);
  assert.strictEqual(summary.canPayNow, false, '部屋が確定するまでオプションは決済できない');
  assert.ok(!JSON.stringify(summary).match(/example\.com|山田/), '氏名・メールアドレスを返さない');
});

test('後付け照会: 予約済みの部屋代は予約本体の金額（Booking.getEffectivePriceAmount）をそのまま返す。取得できなければnull（Issue #443）', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  var summary = ctx.sandbox.OptionOrderService.getCustomerSummary(r.bookingId, EMAIL);
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(r.bookingId).record;
  var expected = ctx.sandbox.Booking.getEffectivePriceAmount(record);
  assert.strictEqual(summary.booking.roomPriceJpy, expected);
  assert.ok(expected === null || Number.isFinite(expected));
});

// ============================================================================
// 承認 / 不承認（Admin）
// ============================================================================

function stagedStaffOrder(ctx) {
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var res = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'STAFF' });
  assert.strictEqual(res.success, true);
  return { bookingId: r.bookingId, optionOrderId: res.orders[0].optionOrderId };
}

test('承認: PENDING_APPROVAL→AWAITING_PAYMENT（承認メール1通）。二重承認は冪等で追加メール・状態変更なし', function () {
  var ctx = setup();
  var s = stagedStaffOrder(ctx);
  var before = mailsTo(ctx, EMAIL).length;

  var first = ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId);
  assert.strictEqual(first.success, true);
  assert.strictEqual(first.alreadyDecided, false);
  var row = orderRows(ctx, s.bookingId)[0];
  assert.strictEqual(row.status, 'AWAITING_PAYMENT');
  assert.strictEqual(row.approvalStatus, 'APPROVED');
  assert.strictEqual(row.paymentStatus, 'NOT_STARTED');
  assert.ok(row.approvedAt);
  var approvalMails = mailsTo(ctx, EMAIL).slice(before);
  assert.strictEqual(approvalMails.length, 1);
  assert.ok(approvalMails[0].body.indexOf('オンライン決済') !== -1);
  assert.ok(approvalMails[0].body.indexOf('checkout.stripe.com') === -1, 'メールにCheckout URLは載せない（本人確認付きの案内ページへ誘導）');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0, '承認だけではStripeを呼ばない');

  var second = ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.alreadyDecided, true);
  assert.strictEqual(mailsTo(ctx, EMAIL).slice(before).length, 1, '二重承認でメールを再送しない');
});

test('不承認: DECLINEDになり部屋予約はCONFIRMEDのまま。以後承認・決済はできない', function () {
  var ctx = setup();
  var s = stagedStaffOrder(ctx);
  var roomBefore = plain(room(ctx, s.bookingId));

  var declined = ctx.sandbox.OptionOrderService.declineOrder(s.optionOrderId, '当日は不在');
  assert.strictEqual(declined.success, true);
  var row = orderRows(ctx, s.bookingId)[0];
  assert.strictEqual(row.status, 'DECLINED');
  assert.strictEqual(row.approvalStatus, 'DECLINED');
  assert.strictEqual(row.paymentStatus, 'NOT_STARTED');

  var roomAfter = plain(room(ctx, s.bookingId));
  assert.strictEqual(roomAfter.status, 'CONFIRMED', '不承認でも部屋予約を取消・変更しない');
  assert.deepStrictEqual(roomAfter, roomBefore, 'Bookings行は一切変わらない');

  assert.strictEqual(ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId).error.code, 'INVALID_TRANSITION');
  assert.strictEqual(ctx.sandbox.OptionOrderService.declineOrder(s.optionOrderId, '').alreadyDecided, true, '二重不承認は冪等');
  var pay = ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId);
  assert.strictEqual(pay.error.code, 'ORDER_DECLINED');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
  var declineMail = mailsTo(ctx, EMAIL).filter(function (m) { return m.subject.indexOf('対応できませんでした') !== -1; })[0];
  assert.ok(declineMail.body.indexOf('ご予約（部屋の利用）の内容には影響ありません') !== -1);
  assert.ok(declineMail.body.indexOf('当日は不在') === -1, '内部理由は利用者へ出さない');
});

test('承認の対象外: 機材・無料の注文、存在しない注文は承認できない。承認時点で部屋が取消済みなら承認不可', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var res = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1 }, emailSupport: true, layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'SELF' });
  res.orders.filter(function (o) { return o.category !== 'STAFF_SERVICE'; }).forEach(function (o) {
    assert.strictEqual(ctx.sandbox.OptionOrderService.approveOrder(o.optionOrderId).error.code, 'APPROVAL_NOT_REQUIRED');
  });
  assert.strictEqual(ctx.sandbox.OptionOrderService.approveOrder('OPT-NOSUCH00').error.code, 'ORDER_NOT_FOUND');
  var staff = res.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0];
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(r.bookingId, { status: 'CANCELLED' });
  assert.strictEqual(ctx.sandbox.OptionOrderService.approveOrder(staff.optionOrderId).error.code, 'BOOKING_NOT_ELIGIBLE');
});

// ============================================================================
// 追加Stripe Checkout
// ============================================================================

test('Checkout: 承認前のスタッフ対応・無料の注文・未確定の部屋ではCheckoutを生成しない', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var res = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { emailSupport: true, layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'SELF' });
  var staff = res.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0];
  var free = res.orders.filter(function (o) { return o.category === 'FREE'; })[0];
  assert.strictEqual(ctx.sandbox.OptionOrderService.startOptionCheckout(r.bookingId, EMAIL, staff.optionOrderId).error.code, 'APPROVAL_REQUIRED');
  assert.strictEqual(ctx.sandbox.OptionOrderService.startOptionCheckout(r.bookingId, EMAIL, free.optionOrderId).error.code, 'NOT_PAYABLE');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);

  // 部屋がPENDINGの間は、機材(承認不要)でも決済に進めない
  var pendingRoom = createRoom(ctx, { date: futureDateJst_(61), options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true },  equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' } });
  var eq = orderRows(ctx, pendingRoom.bookingId)[0];
  assert.strictEqual(ctx.sandbox.OptionOrderService.startOptionCheckout(pendingRoom.bookingId, EMAIL, eq.optionOrderId).error.code, 'BOOKING_NOT_CONFIRMED');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('Checkout: STRIPE_CHECKOUT_ENABLEDが無効ならfail-closed（フラグは変更しない）', function () {
  var ctx = setup({ properties: { STRIPE_CHECKOUT_ENABLED: '' } });
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var res = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  var out = ctx.sandbox.OptionOrderService.startOptionCheckout(r.bookingId, EMAIL, res.orders[0].optionOrderId);
  assert.strictEqual(out.error.code, 'CHECKOUT_DISABLED');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
  assert.strictEqual(ctx.sandbox.BookingConfig.getStripeConfig().checkoutEnabled, false);
});

test('Checkout: 本人確認に失敗した／別予約の注文IDではCheckoutを生成しない', function () {
  var ctx = setup();
  var a = createRoom(ctx);
  confirmRoom(ctx, a.bookingId);
  var b = createRoom(ctx, { date: futureDateJst_(61) });
  confirmRoom(ctx, b.bookingId);
  var resA = ctx.sandbox.OptionOrderService.submitAddonOptions(a.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  var orderA = resA.orders[0].optionOrderId;
  assert.strictEqual(ctx.sandbox.OptionOrderService.startOptionCheckout(a.bookingId, 'x@example.com', orderA).error.code, 'FORBIDDEN');
  assert.strictEqual(ctx.sandbox.OptionOrderService.startOptionCheckout(b.bookingId, EMAIL, orderA).error.code, 'FORBIDDEN', '他の予約の注文IDでは操作できない');
  assert.strictEqual(ctx.sandbox.OptionOrderService.startOptionCheckout(a.bookingId, EMAIL, '').error.code, 'FORBIDDEN');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('Checkout: 入会受付の一時停止（MEMBERSHIP_JOIN_PAUSED=true。Issue #532）はオプション決済に影響しない', function () {
  var ctx = setup({ properties: { MEMBERSHIP_JOIN_PAUSED: 'true' } });
  var s = stagedStaffOrder(ctx);
  ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId);
  var out = ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId);
  assert.strictEqual(out.success, true, JSON.stringify(out));
  assert.match(out.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.strictEqual(ctx.stripe.createCalls.length, 1);
});

test('Checkout: 承認後にのみ生成され、bookingId/optionOrderId/orderType=addonがmetadataとclient_reference_idに載る。再実行しても二重生成しない', function () {
  var ctx = setup();
  var s = stagedStaffOrder(ctx);
  ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId);

  var out = ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId);
  assert.strictEqual(out.success, true);
  assert.match(out.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.strictEqual(ctx.stripe.createCalls.length, 1);
  var call = ctx.stripe.createCalls[0];
  var form = {};
  call.payload.split('&').forEach(function (p) { var kv = p.split('='); form[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); });
  assert.strictEqual(form.client_reference_id, s.optionOrderId);
  assert.strictEqual(form['metadata[bookingId]'], s.bookingId);
  assert.strictEqual(form['metadata[optionOrderId]'], s.optionOrderId);
  assert.strictEqual(form['metadata[orderType]'], 'addon');
  assert.strictEqual(form['metadata[brand]'], 'studio_x');
  assert.strictEqual(form['line_items[0][price_data][unit_amount]'], '5000', 'セット価格。3,000+3,000にならない');
  assert.strictEqual(form['line_items[0][price_data][currency]'], 'jpy');
  assert.ok(!call.payload.match(/sk_test|example\.com%40|%E5%B1%B1%E7%94%B0/) || form.customer_email === EMAIL, '機微情報はmetadataへ入れない');
  assert.ok(!/metadata\[(email|name|phone)/.test(decodeURIComponent(call.payload)));
  assert.match(call.headers['Idempotency-Key'], /^optcheckout-OPAY-OPT-/);
  // 戻り先はStudio X専用（SNBへ戻さない）
  assert.ok(form.success_url.indexOf('/studio-x/booking/option-payment-complete.html') !== -1, form.success_url);
  assert.ok(form.cancel_url.indexOf('/studio-x/booking/options/') !== -1, form.cancel_url);

  var row = orderRows(ctx, s.bookingId)[0];
  assert.strictEqual(row.status, 'PAYMENT_PENDING');
  assert.strictEqual(row.paymentStatus, 'CHECKOUT_PENDING');
  assert.strictEqual(String(row.stripeCheckoutSessionId), 'cs_test_1');
  assert.strictEqual(Number(row.stripeAmount), 5000);

  // 再クリック・二重送信: 既存の有効なSessionのURLを返し、新規Sessionを作らない
  var again = ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId);
  assert.strictEqual(again.success, true);
  assert.strictEqual(again.checkoutUrl, out.checkoutUrl);
  assert.strictEqual(ctx.stripe.createCalls.length, 1, 'Checkout Sessionを重複生成しない');

  // 部屋予約のStripe列は一切変わらない
  var roomRow = room(ctx, s.bookingId);
  assert.ok(!roomRow.stripeCheckoutSessionId && !roomRow.paymentAttemptId);
});

test('Checkout: Sessionが失効していたら新しい決済試行で作り直す。結果不明の失敗は同じ試行(冪等キー)で再送する', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var res = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  var id = res.orders[0].optionOrderId;

  // 結果不明（HTTP 500）→ 試行IDを残す。同じ冪等キーで再送される
  ctx.stripe.createResult = { responseCode: 500, body: { error: { type: 'api_error', message: 'boom' } } };
  var uncertain = ctx.sandbox.OptionOrderService.startOptionCheckout(r.bookingId, EMAIL, id);
  assert.strictEqual(uncertain.error.code, 'CHECKOUT_UNCERTAIN');
  var attempt1 = orderRows(ctx, r.bookingId)[0].paymentAttemptId;
  assert.ok(attempt1);
  ctx.stripe.createResult = null;
  var retry = ctx.sandbox.OptionOrderService.startOptionCheckout(r.bookingId, EMAIL, id);
  assert.strictEqual(retry.success, true);
  assert.strictEqual(ctx.stripe.createCalls.length, 2);
  assert.strictEqual(ctx.stripe.createCalls[0].headers['Idempotency-Key'], ctx.stripe.createCalls[1].headers['Idempotency-Key']);
  assert.strictEqual(ctx.stripe.createCalls[0].payload, ctx.stripe.createCalls[1].payload, '冪等キーが同じなら要求内容も同一');

  // 失効 → 新しい試行
  ctx.stripe.sessions.cs_test_1.status = 'expired';
  var renewed = ctx.sandbox.OptionOrderService.startOptionCheckout(r.bookingId, EMAIL, id);
  assert.strictEqual(renewed.success, true);
  assert.strictEqual(ctx.stripe.createCalls.length, 3);
  assert.notStrictEqual(orderRows(ctx, r.bookingId)[0].paymentAttemptId, attempt1);

  // 確定的な拒否(400)→ 試行を破棄して再試行可能な状態へ戻す
  ctx.stripe.sessions.cs_test_2.status = 'expired';
  ctx.stripe.createResult = { responseCode: 400, body: { error: { type: 'invalid_request_error', message: 'bad' } } };
  var rejected = ctx.sandbox.OptionOrderService.startOptionCheckout(r.bookingId, EMAIL, id);
  assert.strictEqual(rejected.error.code, 'CHECKOUT_FAILED');
  var after = orderRows(ctx, r.bookingId)[0];
  assert.strictEqual(after.status, 'AWAITING_PAYMENT');
  assert.strictEqual(after.paymentStatus, 'FAILED');
  assert.ok(!after.paymentAttemptId);
});

// ============================================================================
// Webhook反映（Booking Admin）
// ============================================================================

function addonEvent(id, type, sessionId, overrides) {
  return JSON.stringify({ id: id, type: type, data: { object: Object.assign({ id: sessionId }, overrides || {}) } });
}

function receiveAndProcess(ctx, eventBody, now) {
  var parsed = JSON.parse(eventBody);
  var claim = ctx.sandbox.StripeEventRepository.claim(parsed.id, parsed.type, now);
  if (claim.outcome === 'CLAIMED') ctx.sandbox.StripeEventRepository.storeRawBody(claim.rowNumber, eventBody, now);
  var run = ctx.sandbox.StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
  return run.results.filter(function (x) { return x.eventId === parsed.id; })[0] || { finalized: false, code: 'SKIPPED' };
}

function paidScenario(ctx) {
  var s = stagedStaffOrder(ctx);
  ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId);
  var out = ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId);
  assert.strictEqual(out.success, true);
  ctx.stripe.sessions.cs_test_1.payment_status = 'paid';
  ctx.stripe.sessions.cs_test_1.status = 'complete';
  return { bookingId: s.bookingId, optionOrderId: s.optionOrderId, sessionId: 'cs_test_1' };
}

test('Webhook: 追加決済の成功でoptionOrderがPAID/CONFIRMEDになり、部屋予約は新規作成も変更もされない。確定メールは1通', function () {
  var ctx = setup();
  var p = paidScenario(ctx);
  var roomBefore = plain(room(ctx, p.bookingId));
  var bookingCount = ctx.sandbox.SpreadsheetRepository.getAllBookings().length;
  var before = mailsTo(ctx, EMAIL).length;

  var result = receiveAndProcess(ctx, addonEvent('evt_a1', 'checkout.session.completed', p.sessionId), new Date());
  assert.strictEqual(result.finalized, true);
  assert.strictEqual(result.code, 'ADDON_CONFIRMED');

  var row = orderRows(ctx, p.bookingId)[0];
  assert.strictEqual(row.status, 'CONFIRMED');
  assert.strictEqual(row.paymentStatus, 'PAID');
  assert.strictEqual(row.stripePaymentIntentId, 'pi_cs_test_1');
  assert.ok(row.paidAt);
  assert.strictEqual(row.lastStripeEventId, 'evt_a1');
  assert.deepStrictEqual(plain(room(ctx, p.bookingId)), roomBefore, '部屋予約の行は変わらない');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllBookings().length, bookingCount);
  var confirmMails = mailsTo(ctx, EMAIL).slice(before).filter(function (m) { return m.subject.indexOf('オプションが確定') !== -1; });
  assert.strictEqual(confirmMails.length, 1);
});

test('Webhook: 再送（別イベントID・同一イベントID）でも二重反映・二重メールにならない', function () {
  var ctx = setup();
  var p = paidScenario(ctx);
  receiveAndProcess(ctx, addonEvent('evt_b1', 'checkout.session.completed', p.sessionId), new Date());
  var mailsAfterFirst = mailsTo(ctx, EMAIL).length;
  var rowAfterFirst = orderRows(ctx, p.bookingId)[0];

  // 同一イベントIDの再送
  receiveAndProcess(ctx, addonEvent('evt_b1', 'checkout.session.completed', p.sessionId), new Date());
  // 別イベントID(async_payment_succeededなど)での再通知
  var second = receiveAndProcess(ctx, addonEvent('evt_b2', 'checkout.session.async_payment_succeeded', p.sessionId), new Date());
  assert.strictEqual(second.code, 'ADDON_ALREADY_APPLIED');

  assert.strictEqual(mailsTo(ctx, EMAIL).length, mailsAfterFirst, '確定メールを二重送信しない');
  var rowAfter = orderRows(ctx, p.bookingId)[0];
  assert.strictEqual(rowAfter.paidAt.getTime ? rowAfter.paidAt.getTime() : rowAfter.paidAt, rowAfterFirst.paidAt.getTime ? rowAfterFirst.paidAt.getTime() : rowAfterFirst.paidAt, '支払日時を上書きしない');
  assert.strictEqual(rowAfter.lastStripeEventId, 'evt_b1');
  assert.strictEqual(orderRows(ctx, p.bookingId).length, 1);
});

test('Webhook: 決済未完了（unpaid）・PaymentIntent未成功ではCONFIRMEDにならない', function () {
  var ctx = setup();
  var s = stagedStaffOrder(ctx);
  ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId);
  ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId);

  var unpaid = receiveAndProcess(ctx, addonEvent('evt_c1', 'checkout.session.completed', 'cs_test_1'), new Date());
  assert.strictEqual(unpaid.code, 'PAYMENT_NOT_YET_COMPLETE');
  assert.strictEqual(orderRows(ctx, s.bookingId)[0].status, 'PAYMENT_PENDING');

  ctx.stripe.sessions.cs_test_1.payment_status = 'paid';
  ctx.stripe.paymentIntentStatus = 'processing';
  var notSucceeded = receiveAndProcess(ctx, addonEvent('evt_c2', 'checkout.session.completed', 'cs_test_1'), new Date());
  assert.strictEqual(notSucceeded.finalized, true);
  assert.notStrictEqual(orderRows(ctx, s.bookingId)[0].status, 'CONFIRMED');
  assert.strictEqual(orderRows(ctx, s.bookingId)[0].paymentStatus, 'CHECKOUT_PENDING');
});

test('Webhook: 金額不一致は確定せず要復旧。部屋予約の決済ゲート（PAYMENT_系Recovery）には波及しない', function () {
  var ctx = setup();
  var p = paidScenario(ctx);
  ctx.stripe.amountReceivedOverride = 1;
  var result = receiveAndProcess(ctx, addonEvent('evt_d1', 'checkout.session.completed', p.sessionId), new Date());
  assert.strictEqual(result.code, 'ADDON_AMOUNT_MISMATCH');
  var row = orderRows(ctx, p.bookingId)[0];
  assert.notStrictEqual(row.status, 'CONFIRMED');
  assert.ok(row.paymentRecoveryRequiredAt);
  var recovery = ctx.sandbox.RecoveryRepository.listAll().filter(function (x) { return x.bookingId === p.bookingId; });
  assert.ok(recovery.length >= 1);
  recovery.forEach(function (x) { assert.match(x.failureType, /^OPTION_/); });
  assert.strictEqual(ctx.sandbox.RecoveryRepository.hasOpenPaymentRecords(p.bookingId), false, '部屋予約の決済Recovery判定に影響しない');
  assert.ok(!room(ctx, p.bookingId).paymentRecoveryRequiredAt);
});

test('Webhook: Sessionのmetadataと台帳が食い違う（別の注文ID・別の試行ID）場合は確定しない', function () {
  var ctx = setup();
  var p = paidScenario(ctx);
  ctx.stripe.sessions.cs_test_1.metadata.paymentAttemptId = 'OPAY-OTHER-000000000000';
  var result = receiveAndProcess(ctx, addonEvent('evt_e1', 'checkout.session.completed', p.sessionId), new Date());
  assert.strictEqual(result.code, 'ADDON_IDENTITY_MISMATCH');
  assert.notStrictEqual(orderRows(ctx, p.bookingId)[0].status, 'CONFIRMED');

  var ctx2 = setup();
  var p2 = paidScenario(ctx2);
  ctx2.stripe.sessions.cs_test_1.client_reference_id = 'OPT-OTHER000';
  assert.strictEqual(receiveAndProcess(ctx2, addonEvent('evt_e2', 'checkout.session.completed', p2.sessionId), new Date()).code, 'ADDON_IDENTITY_MISMATCH');

  var ctx3 = setup();
  var p3 = paidScenario(ctx3);
  ctx3.stripe.sessions.cs_test_1.metadata.optionOrderId = 'OPT-NOSUCH99';
  assert.strictEqual(receiveAndProcess(ctx3, addonEvent('evt_e3', 'checkout.session.completed', p3.sessionId), new Date()).code, 'ORDER_NOT_FOUND');
});

test('Webhook: 非同期決済の失敗は決済待ちから再試行可能な状態へ戻す（CONFIRMEDにしない）。成功後の失敗通知は無視', function () {
  var ctx = setup();
  var s = stagedStaffOrder(ctx);
  ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId);
  ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId);
  var failed = receiveAndProcess(ctx, addonEvent('evt_f1', 'checkout.session.async_payment_failed', 'cs_test_1'), new Date());
  assert.strictEqual(failed.code, 'ADDON_MARKED_FAILED');
  var row = orderRows(ctx, s.bookingId)[0];
  assert.strictEqual(row.status, 'AWAITING_PAYMENT');
  assert.strictEqual(row.paymentStatus, 'FAILED');
  // 再度Checkoutを開始できる
  assert.strictEqual(ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId).success, true);
});

test('Webhook: 不承認・取消済みの注文への遅延入金は確定にせず、入金の事実を残して運営へ回す', function () {
  var ctx = setup();
  var p = paidScenario(ctx);
  // 管理者操作でCANCELLEDになった状況を直接再現（運用手順での取消を想定）
  ctx.sandbox.OptionOrderRepository.updateOrder(p.optionOrderId, { status: 'CANCELLED' });
  var result = receiveAndProcess(ctx, addonEvent('evt_g1', 'checkout.session.completed', p.sessionId), new Date());
  assert.strictEqual(result.code, 'ADDON_RECOVERY_REQUIRED');
  var row = orderRows(ctx, p.bookingId)[0];
  assert.strictEqual(row.status, 'CANCELLED');
  assert.strictEqual(row.paymentStatus, 'PAID', '入金の事実は残す');
  assert.ok(row.paymentRecoveryRequiredAt);
});

test('Webhook: 部屋予約が既に取消されていてもオプションは確定し、運営へ返金確認のRecoveryを残す', function () {
  var ctx = setup();
  var p = paidScenario(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(p.bookingId, { status: 'CANCELLED' });
  var result = receiveAndProcess(ctx, addonEvent('evt_h1', 'checkout.session.completed', p.sessionId), new Date());
  assert.strictEqual(result.code, 'ADDON_CONFIRMED');
  var recovery = ctx.sandbox.RecoveryRepository.listAll().filter(function (x) { return x.failureType === 'OPTION_PAID_BOOKING_NOT_CONFIRMED'; });
  assert.strictEqual(recovery.length, 1);
});

test('Webhook回帰: orderTypeを持たない従来の部屋予約Checkoutは従来の経路で処理される（追加経路に入らない）', function () {
  var ctx = setup();
  var record = {
    bookingId: 'SX-20261101-AAAAAAAA', createdAt: new Date(), date: FUTURE_DATE, startAt: new Date('2099-01-01T10:00:00+09:00'), endAt: new Date('2099-01-01T12:00:00+09:00'),
    brand: 'studio_x', name: 'x', email: 'y@example.com', phone: '', people: '1名', purpose: 'p', paymentMethod: 'オンラインクレジットカード',
    status: 'PENDING', calendarEventId: 'event-1', source: 't', note: '', paymentStatus: 'checkout_pending', priceAmount: 8000,
    paymentAttemptId: 'PAY-SX-20261101-AAAAAAAA-ABCDEF012345', stripeCheckoutSessionId: 'cs_room', stripeAmount: 8000, stripeCurrency: 'JPY'
  };
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);
  ctx.stripe.sessions.cs_room = {
    id: 'cs_room', status: 'complete', payment_status: 'paid', payment_intent: 'pi_cs_room', amount_total: 8000, currency: 'jpy',
    metadata: { bookingId: record.bookingId, brand: 'studio_x', paymentAttemptId: record.paymentAttemptId }
  };
  var result = receiveAndProcess(ctx, addonEvent('evt_room', 'checkout.session.completed', 'cs_room'), new Date());
  assert.ok(result.code.indexOf('ADDON_') !== 0, '部屋予約の決済は追加経路では処理しない: ' + result.code);
  assert.strictEqual(orderRows(ctx, record.bookingId).length, 0);
});

// ============================================================================
// Code.gs（公開エンドポイント）
// ============================================================================

function callGet(ctx, params) {
  return JSON.parse(ctx.sandbox.doGet({ parameter: params }).text);
}

function callPost(ctx, action, body) {
  return JSON.parse(ctx.sandbox.doPost({ parameter: { action: action }, postData: { contents: JSON.stringify(body) } }).text);
}

test('Code.gs: optionCatalogはPIIを含まず、Studio Xは全カタログ・SNB / mensはシャワーのみ', function () {
  var ctx = setup();
  var x = callGet(ctx, { action: 'optionCatalog', brand: 'studio_x' });
  assert.strictEqual(x.success, true);
  assert.strictEqual(x.catalog.enabled, true);
  assert.strictEqual(x.catalog.staffServices.BOTH.priceJpy, 5000);
  /* Issue #478: SNB / mensはシャワーのみのカタログ（Studio Xの機材・スタッフ対応は出さない）。 */
  ['snb', 'mens'].forEach(function (brand) {
    var c = callGet(ctx, { action: 'optionCatalog', brand: brand }).catalog;
    assert.strictEqual(c.enabled, true);
    assert.strictEqual(c.showerOnly, true);
    assert.strictEqual(c.shower.priceJpy, 1000);
    assert.strictEqual(c.staffServices, undefined);
  });
  assert.strictEqual(callGet(ctx, { action: 'optionCatalog', brand: 'zzz' }).error.code, 'INVALID_BRAND');
});

test('Code.gs: createBooking（action無し）にoptionsを付けて送ると同時申込になり、レスポンスにoptionsの結果が載る', function () {
  var ctx = setup();
  var res = JSON.parse(ctx.sandbox.doPost({ postData: { contents: JSON.stringify(payload({ options: { emailSupport: true } })) } }).text);
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.options.success, true);
  assert.strictEqual(res.options.orders[0].category, 'FREE');
});

test('Code.gs: optionSummary / submitOptions / startOptionCheckout は本人確認が必須で、失敗は同一のFORBIDDEN。ログにメールアドレスを出さない', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var bad = callPost(ctx, 'optionSummary', { bookingId: r.bookingId, email: 'nope@example.com' });
  assert.strictEqual(bad.error.code, 'FORBIDDEN');
  assert.strictEqual(callPost(ctx, 'submitOptions', { bookingId: r.bookingId, email: 'nope@example.com', options: { emailSupport: true } }).error.code, 'FORBIDDEN');
  assert.strictEqual(callPost(ctx, 'startOptionCheckout', { bookingId: r.bookingId, email: 'nope@example.com', optionOrderId: 'OPT-X' }).error.code, 'FORBIDDEN');
  assert.strictEqual(callPost(ctx, 'optionSummary', { bookingId: r.bookingId }).error.code, 'FORBIDDEN');

  var ok = callPost(ctx, 'optionSummary', { bookingId: r.bookingId, email: EMAIL });
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.canPayNow, true);
  var submit = callPost(ctx, 'submitOptions', { bookingId: r.bookingId, email: EMAIL, options: { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' } });
  assert.strictEqual(submit.success, true);
  var pay = callPost(ctx, 'startOptionCheckout', { bookingId: r.bookingId, email: EMAIL, optionOrderId: submit.orders[0].optionOrderId });
  assert.strictEqual(pay.success, true);
  assert.match(pay.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);

  var logs = ctx.sandbox.Logger._logs.join('\n');
  assert.ok(logs.indexOf(EMAIL) === -1 && logs.indexOf('nope@example.com') === -1, 'ログに個人情報を出さない');
  assert.ok(logs.indexOf('sk_test') === -1 && logs.indexOf('checkout.stripe.com') === -1);
});

test('Code.gs: 本人確認エンドポイントは予約ID単位でレート制限される（総当たり対策）', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  var last;
  for (var i = 0; i < 25; i++) {
    last = callPost(ctx, 'optionSummary', { bookingId: r.bookingId, email: 'guess' + i + '@example.com' });
  }
  assert.strictEqual(last.error.code, 'RATE_LIMITED');
});

test('Code.gs: 不正なJSON・bookingId/emailの欠落・過長な入力は拒否される', function () {
  var ctx = setup();
  var invalid = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'optionSummary' }, postData: { contents: '{bad' } }).text);
  assert.strictEqual(invalid.error.code, 'INVALID_JSON');
  assert.strictEqual(callPost(ctx, 'optionSummary', {}).error.code, 'FORBIDDEN');
  assert.strictEqual(callPost(ctx, 'optionSummary', { bookingId: 'x'.repeat(65), email: EMAIL }).error.code, 'FORBIDDEN');
});

// ============================================================================
// SNB / mens の既存挙動
// ============================================================================

test('SNB / mens: Stripe戻り先・予約作成は従来どおり（オプション関連のコードが入り込まない）', function () {
  var ctx = setup({ properties: {
    STRIPE_CHECKOUT_SUCCESS_URL_MENS: 'https://nagoya-base.github.io/Studio-nagoya-base/mens/booking/payment-complete.html?session_id={CHECKOUT_SESSION_ID}'
  } });
  var cfg = ctx.sandbox.BookingConfig.getStripeConfig();
  assert.strictEqual(plain(ctx.sandbox.Booking.resolveCheckoutReturnUrls('snb', cfg)).successUrl, cfg.successUrl);
  var mensCfg = plain(ctx.sandbox.Booking.resolveCheckoutReturnUrls('mens', cfg));
  assert.ok(mensCfg.successUrl.indexOf('/mens/booking/payment-complete.html') !== -1);
  ['snb', 'mens'].forEach(function (brand) {
    var ok = ctx.sandbox.BookingRepository.createBooking(payload({ brand: brand, date: futureDateJst_(brand === 'snb' ? 61 : 62) }));
    assert.strictEqual(ok.success, true, brand);
    assert.strictEqual(orderRows(ctx, ok.bookingId).length, 0);
  });
});

// ============================================================================
// 選び直し・照会の制限
// ============================================================================

test('オプション由来で拒否された申込（不正な選択・在庫超過）は連投制限に計上されない（選択を直して同じ日時・メールで再送できる）', function () {
  var ctx = setup({ properties: { RATE_LIMIT_EMAIL_COUNT: '3' } });
  var rejected = ctx.sandbox.BookingRepository.createBooking(payload({ options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { STAND_260: 9 }, setupService: 'SELF', cleanupService: 'SELF' } }));
  assert.strictEqual(rejected.error.code, 'STOCK_EXCEEDED');
  var retry = ctx.sandbox.BookingRepository.createBooking(payload({ options: { emailSupport: true } }));
  assert.strictEqual(retry.success, true, JSON.stringify(retry.error));
});

test('ビデオライトの資格(許可)の照会はメールアドレス単位でレート制限される（許可の有無を探られない）', function () {
  var ctx = setup();
  var last;
  for (var i = 0; i < 6; i++) {
    last = ctx.sandbox.BookingRepository.createBooking(payload({ options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' } }));
  }
  assert.strictEqual(last.error.code, 'RATE_LIMITED');
});

test('Admin配布ファイルセット相当: Booking Web Appに無いRateLimiterを使わずに承認・不承認・Webhook反映のサービスが動く（Admin側の依存を持ち込まない）', function () {
  var source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'gas', 'booking', 'shared', 'OptionOrderService.gs'), 'utf8');
  assert.ok(source.indexOf('RateLimiter') === -1 || source.replace(/\/\*[\s\S]*?\*\//g, '').indexOf('RateLimiter') === -1);
});

test('台帳: 管理者入力(不承認理由・資格メモ)が数式として評価される先頭文字でも文字列として保存する（数式インジェクション対策）', function () {
  var ctx = setup();
  var s = stagedStaffOrder(ctx);
  ctx.sandbox.OptionOrderService.declineOrder(s.optionOrderId, '=HYPERLINK("http://example.com")');
  var raw = ctx.sheets.OptionOrders._rows[1];
  var reasonIndex = ctx.sandbox.OptionOrderRepository.HEADERS.indexOf('declineReason');
  assert.strictEqual(raw[reasonIndex].charAt(0), "'");
  ctx.sandbox.OptionOrderService.grantVideoLightEligibility('a@example.com', 'COB_BICOLOR', '+81-90-xxxx');
  assert.strictEqual(ctx.sheets.OptionEligibility._rows[ctx.sheets.OptionEligibility._rows.length - 1][3].charAt(0), "'");
});

test('同時: 黒板教室のセルフ選択ではチョーク収納の注意を含む確定文言が届き、未整備の注記は出ない', function () {
  var ctx = setup();
  createRoom(ctx, { options: { layouts: ['CLASSROOM'] } });
  var mail = mailsTo(ctx, EMAIL).filter(function (m) { return m.subject.indexOf('オプション') !== -1; })[0];
  assert.ok(mail.body.indexOf('チョークを必ずケースに収納してください') !== -1);
  assert.ok(mail.body.indexOf('運営にて内容を確認中です') === -1);
});

test('後付け片付け（運営確定のA案）: 事前設営3,000円を申込済みの予約へ片付けだけ追加すると2,000円、通算5,000円（6,000円にしない）', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var first = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'NONE' });
  assert.strictEqual(first.orders[0].amountJpy, 3000);
  var second = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { layouts: ['GRUNGE'], setupService: 'NONE', cleanupService: 'STAFF' });
  assert.strictEqual(second.success, true, JSON.stringify(second.error));
  assert.strictEqual(second.orders[0].amountJpy, 2000);
  assert.strictEqual(second.orders[0].status, 'PENDING_APPROVAL');
  var total = orderRows(ctx, r.bookingId).reduce(function (sum, row) { return sum + Number(row.amountJpy); }, 0);
  assert.strictEqual(total, 5000);
});

test('資格は機材コード単位でAdmin付与のみ: 支払い済み履歴は資格にならず、バイカラーCOBの許可でフルカラーは保留になる', function () {
  var ctx = setup();
  var past = createRoom(ctx);
  confirmRoom(ctx, past.bookingId);
  ctx.sandbox.OptionOrderRepository.appendOrders([{
    optionOrderId: 'OPT-PAST0002', bookingId: past.bookingId, brand: 'studio_x', category: 'EQUIPMENT', source: 'ADDON',
    items: ['EQ:COB_BICOLOR:1', 'EQ:COB_FULLCOLOR:1'], amountJpy: 1600, currency: 'JPY', approvalStatus: 'NOT_REQUIRED', paymentStatus: 'PAID',
    status: 'CONFIRMED', customerEmail: EMAIL, createdAt: new Date(), updatedAt: new Date()
  }]);
  var next = createRoom(ctx, { date: futureDateJst_(61) });
  confirmRoom(ctx, next.bookingId);
  var svc = ctx.sandbox.OptionOrderService;

  // 履歴では通らない（保留）。保留注文は支払い不可
  var heldRes = svc.submitAddonOptions(next.bookingId, EMAIL, { equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(heldRes.orders[0].status, 'PENDING_APPROVAL');
  svc.declineOrder(heldRes.orders[0].optionOrderId, '');

  // 許可は機材コード単位
  assert.strictEqual(svc.grantVideoLightEligibility(EMAIL, 'COB_BICOLOR', '対面レクチャー済み').success, true);
  assert.strictEqual(svc.grantVideoLightEligibility(EMAIL, 'VIDEO_LIGHT', '').error.code, 'INVALID_EQUIPMENT', '一括コードでは許可できない');
  assert.strictEqual(svc.grantVideoLightEligibility(EMAIL, 'STROBE_MONOBLOCK', '').alreadyGranted, true, 'ストロボも許可制の対象（セットアップで付与済み）');
  assert.strictEqual(svc.grantVideoLightEligibility(EMAIL, 'NOT_A_RENTAL', '').error.code, 'INVALID_EQUIPMENT', '有料レンタル機材以外は許可できない');
  var mixed = svc.submitAddonOptions(next.bookingId, EMAIL, { equipment: { COB_BICOLOR: 1, COB_FULLCOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(mixed.success, true);
  var statuses = {};
  mixed.orders.forEach(function (o) { statuses[o.items.map(function (i) { return i.code; }).join(',')] = o.status; });
  assert.strictEqual(statuses['EQ:COB_BICOLOR:1'], 'AWAITING_PAYMENT', '許可済みの機材は支払い待ち');
  assert.strictEqual(statuses['EQ:COB_FULLCOLOR:1'], 'PENDING_APPROVAL', '未許可の機材だけ保留');

  assert.strictEqual(svc.grantVideoLightEligibility(EMAIL, 'COB_FULLCOLOR', '対面レクチャー済み').success, true);
  var third = svc.submitAddonOptions(next.bookingId, EMAIL, { equipment: { PANEL_FULLCOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(third.orders[0].status, 'PENDING_APPROVAL', 'フルカラーCOBの許可でパネルは通らない');
});

test('資格: 他人のメールアドレスの許可は引き継がれない（機材コード単位でも同様）', function () {
  var ctx = setup();
  ctx.sandbox.OptionOrderService.grantVideoLightEligibility('hanako@example.com', 'COB_BICOLOR', '');
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var res = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(res.orders[0].status, 'PENDING_APPROVAL');
});

// ============================================================================
// 資格の再検証（Issue追加要件: 未許可は支払い不可・確定不可、Adminが否認できる）
// ============================================================================

function grantedBicolorOrder(ctx) {
  var svc = ctx.sandbox.OptionOrderService;
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  svc.grantVideoLightEligibility(EMAIL, 'COB_BICOLOR', '対面レクチャー済み');
  var res = svc.submitAddonOptions(r.bookingId, EMAIL, { equipment: { COB_BICOLOR: 1, STAND_260: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(res.success, true, JSON.stringify(res.error));
  return { bookingId: r.bookingId, optionOrderId: res.orders[0].optionOrderId };
}

test('資格の再検証: 許可が取り消されると、申込済みの注文でもCheckoutを生成せず支払い不可（Stripeを呼ばない）', function () {
  var ctx = setup();
  var o = grantedBicolorOrder(ctx);
  var svc = ctx.sandbox.OptionOrderService;
  assert.strictEqual(svc.revokeVideoLightEligibility(EMAIL, 'COB_BICOLOR').revoked, 1);

  var out = svc.startOptionCheckout(o.bookingId, EMAIL, o.optionOrderId);
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.error.code, 'VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE');
  assert.ok(out.error.message.indexOf('バイカラーCOBライト') !== -1);
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
  assert.strictEqual(orderRows(ctx, o.bookingId)[0].status, 'AWAITING_PAYMENT', '状態は自動では変えない（Adminが判断）');

  // 再付与すれば支払える（許可はサーバーが毎回再検証する）
  svc.grantVideoLightEligibility(EMAIL, 'COB_BICOLOR', '再付与');
  assert.strictEqual(svc.startOptionCheckout(o.bookingId, EMAIL, o.optionOrderId).success, true);
});

test('資格の再検証: Checkout発行後に許可が取り消されても、既存の有効なSessionのURLを返さない', function () {
  var ctx = setup();
  var o = grantedBicolorOrder(ctx);
  var svc = ctx.sandbox.OptionOrderService;
  assert.strictEqual(svc.startOptionCheckout(o.bookingId, EMAIL, o.optionOrderId).success, true);
  svc.revokeVideoLightEligibility(EMAIL, 'COB_BICOLOR');
  var again = svc.startOptionCheckout(o.bookingId, EMAIL, o.optionOrderId);
  assert.strictEqual(again.error.code, 'VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE');
  assert.strictEqual(ctx.stripe.createCalls.length, 1);
});

test('資格の再検証: 許可の無いまま保存された注文（不正な申込データ）もCheckoutに進めず、Adminが否認でき、部屋予約は不変', function () {
  var ctx = setup();
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  // 申込時の検証をすり抜けて保存された想定の注文を直接作る
  ctx.sandbox.OptionOrderRepository.appendOrders([{
    optionOrderId: 'OPT-FORGED01', bookingId: r.bookingId, brand: 'studio_x', category: 'EQUIPMENT', source: 'ADDON',
    items: ['EQ:COB_FULLCOLOR:2', 'EQ:STAND_260:1'], amountJpy: 1800, currency: 'JPY', approvalStatus: 'NOT_REQUIRED', paymentStatus: 'NOT_STARTED',
    status: 'AWAITING_PAYMENT', customerEmail: EMAIL, createdAt: new Date(), updatedAt: new Date()
  }]);
  var svc = ctx.sandbox.OptionOrderService;
  assert.strictEqual(svc.startOptionCheckout(r.bookingId, EMAIL, 'OPT-FORGED01').error.code, 'VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);

  // Admin: 資格未確認として見え、否認できる
  var listed = svc.listForAdmin(r.bookingId).orders[0];
  assert.strictEqual(listed.eligibilityMissing, true);
  assert.deepStrictEqual(plain(listed.eligibilityMissingLabels), ['フルカラーCOBライト（定常光）', 'ライトスタンド（260cm）']);
  assert.strictEqual(listed.canDeclineEligibility, true);

  var roomBefore = plain(room(ctx, r.bookingId));
  var before = mailsTo(ctx, EMAIL).length;
  var declined = svc.declineOrder('OPT-FORGED01', '対面レクチャー未実施');
  assert.strictEqual(declined.success, true);
  var row = orderRows(ctx, r.bookingId)[0];
  assert.strictEqual(row.status, 'DECLINED');
  assert.strictEqual(row.approvalStatus, 'DECLINED');
  assert.deepStrictEqual(plain(room(ctx, r.bookingId)), roomBefore, '否認しても部屋予約には影響しない');
  var mail = mailsTo(ctx, EMAIL).slice(before)[0];
  assert.ok(mail.body.indexOf('管理者による利用許可を確認できなかった') !== -1);
  assert.ok(mail.body.indexOf('スタッフの予定') === -1, '機材の否認メールにスタッフ対応の文面を使わない');
  assert.strictEqual(svc.declineOrder('OPT-FORGED01', '').alreadyDecided, true, '二重否認は冪等');
  assert.strictEqual(svc.startOptionCheckout(r.bookingId, EMAIL, 'OPT-FORGED01').error.code, 'ORDER_DECLINED');
  assert.strictEqual(svc.approveOrder('OPT-FORGED01').error.code, 'INVALID_TRANSITION', '否認済みの注文は承認できない');
});

test('資格の再検証: 許可済みの機材注文・ストロボ等の注文は否認の対象にならない', function () {
  var ctx = setup();
  var o = grantedBicolorOrder(ctx);
  var svc = ctx.sandbox.OptionOrderService;
  assert.strictEqual(svc.listForAdmin(o.bookingId).orders[0].eligibilityMissing, false);
  assert.strictEqual(svc.declineOrder(o.optionOrderId, '').error.code, 'APPROVAL_NOT_REQUIRED', '許可済みの注文を勝手に否認できない');
  var r2 = createRoom(ctx, { date: futureDateJst_(61) });
  confirmRoom(ctx, r2.bookingId);
  var strobe = svc.submitAddonOptions(r2.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(svc.declineOrder(strobe.orders[0].optionOrderId, '').error.code, 'APPROVAL_NOT_REQUIRED');
  assert.strictEqual(svc.startOptionCheckout(r2.bookingId, EMAIL, strobe.orders[0].optionOrderId).success, true, '許可済みのストロボは支払える');
});

test('資格の再検証（Webhook）: 支払い済みでも許可を確認できないビデオライト系は確定にせず、入金の事実を残して要復旧にする', function () {
  var ctx = setup();
  var o = grantedBicolorOrder(ctx);
  var svc = ctx.sandbox.OptionOrderService;
  assert.strictEqual(svc.startOptionCheckout(o.bookingId, EMAIL, o.optionOrderId).success, true);
  svc.revokeVideoLightEligibility(EMAIL, 'COB_BICOLOR');
  ctx.stripe.sessions.cs_test_1.payment_status = 'paid';
  ctx.stripe.sessions.cs_test_1.status = 'complete';
  var before = mailsTo(ctx, EMAIL).length;
  var result = receiveAndProcess(ctx, addonEvent('evt_elig1', 'checkout.session.completed', 'cs_test_1'), new Date());
  assert.strictEqual(result.code, 'ADDON_RECOVERY_REQUIRED');
  var row = orderRows(ctx, o.bookingId)[0];
  assert.notStrictEqual(row.status, 'CONFIRMED');
  assert.strictEqual(row.paymentStatus, 'PAID', '入金の事実は保持する');
  assert.ok(row.paymentRecoveryRequiredAt);
  assert.strictEqual(mailsTo(ctx, EMAIL).length, before, '確定メールを送らない');
  var recovery = ctx.sandbox.RecoveryRepository.listAll().filter(function (x) { return x.failureType === 'OPTION_PAID_NOT_ELIGIBLE'; });
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(ctx.sandbox.RecoveryRepository.hasOpenPaymentRecords(o.bookingId), false, '部屋予約の決済ゲートに波及しない');
});

test('許可の取り消しは機材コード単位で、他の機材・他人の許可に影響しない。有料レンタル機材以外は対象外', function () {
  var ctx = setup();
  var svc = ctx.sandbox.OptionOrderService;
  svc.grantVideoLightEligibility(EMAIL, 'COB_BICOLOR', '');
  svc.grantVideoLightEligibility(EMAIL, 'COB_FULLCOLOR', '');
  svc.grantVideoLightEligibility('hanako@example.com', 'COB_BICOLOR', '');
  assert.strictEqual(svc.revokeVideoLightEligibility(EMAIL, 'COB_BICOLOR').revoked, 1);
  assert.strictEqual(svc.revokeVideoLightEligibility(EMAIL, 'COB_BICOLOR').revoked, 0, '二重取り消しは何もしない');
  assert.strictEqual(svc.revokeVideoLightEligibility(EMAIL, 'NOT_A_RENTAL').error.code, 'INVALID_EQUIPMENT');
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.hasEligibilityGrant(EMAIL, 'COB_FULLCOLOR'), true);
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.hasEligibilityGrant('hanako@example.com', 'COB_BICOLOR'), true);
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.hasEligibilityGrant(EMAIL, 'COB_BICOLOR'), false);
  // 取り消し後に再付与できる
  assert.strictEqual(svc.grantVideoLightEligibility(EMAIL, 'COB_BICOLOR', '再付与').alreadyGranted, false);
});

test('有料レンタル機材は全件Admin許可制（Issue #430）: 未許可のストロボ・ソフトボックス・背景スタンドは保留注文になりCheckoutに進めず、Adminが許可/不承認できる', function () {
  var ctx = setup({ grantStrobe: false });
  var svc = ctx.sandbox.OptionOrderService;
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var res = svc.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_MONOBLOCK: 1, SOFTBOX_60: 1, BACKGROUND_STAND: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(res.success, true, JSON.stringify(res.error));
  assert.strictEqual(res.orders.length, 1);
  var hold = res.orders[0];
  assert.strictEqual(hold.status, 'PENDING_APPROVAL');
  assert.strictEqual(hold.eligibilityHold, true);
  assert.strictEqual(hold.amountJpy, 800 + 300 + 200);
  assert.strictEqual(svc.startOptionCheckout(r.bookingId, EMAIL, hold.optionOrderId).error.code, 'APPROVAL_REQUIRED');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0, '未許可でCheckoutを作らない');
  var view = svc.listForAdmin(r.bookingId).orders[0];
  assert.strictEqual(view.eligibilityMissing, true);
  assert.strictEqual(svc.approveOrder(hold.optionOrderId).success, true, 'Adminが許可して進める');
  assert.strictEqual(ctx.sandbox.OptionOrderRepository.hasEligibilityGrant(EMAIL, 'SOFTBOX_60'), true);
  assert.strictEqual(svc.startOptionCheckout(r.bookingId, EMAIL, hold.optionOrderId).success, true);
});


test('セット無料の付帯機材（0円の保留注文）はAdminの許可でCheckoutなしに確定し、本体の支払い注文は影響を受けない（Issue #438）', function () {
  var ctx = setup();
  var svc = ctx.sandbox.OptionOrderService;
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  svc.grantVideoLightEligibility(EMAIL, 'STROBE_PORTABLE', '対面レクチャー済み');
  var res = svc.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_PORTABLE: 1, BOWENS_BRACKET: 1 }, setupService: 'SELF', cleanupService: 'SELF' });
  assert.strictEqual(res.success, true, JSON.stringify(res.error));
  var pay = res.orders.filter(function (o) { return o.status === 'AWAITING_PAYMENT'; })[0];
  var hold = res.orders.filter(function (o) { return o.status === 'PENDING_APPROVAL'; })[0];
  assert.strictEqual(pay.amountJpy, 1000);
  assert.strictEqual(hold.amountJpy, 0);
  assert.strictEqual(hold.items[0].label, 'ボーエンズマウントブラケット（セット無料）');
  assert.strictEqual(hold.payable, false);
  assert.strictEqual(svc.startOptionCheckout(r.bookingId, EMAIL, hold.optionOrderId).success, false, '付帯機材は許可前にCheckoutへ進めない');
  var approved = svc.approveOrder(hold.optionOrderId);
  assert.strictEqual(approved.success, true, JSON.stringify(approved.error));
  assert.strictEqual(approved.order.status, 'CONFIRMED');
  assert.strictEqual(approved.order.paymentStatus, 'NOT_REQUIRED');
  assert.strictEqual(svc.startOptionCheckout(r.bookingId, EMAIL, pay.optionOrderId).success, true, '本体は通常どおり支払える');
  assert.strictEqual(ctx.stripe.createCalls.length, 1);
});

test('機材のみでsetupService未指定の申込は予約作成・後付けの両方で拒否される（Issue #438）', function () {
  var ctx = setup();
  var rejected = ctx.sandbox.BookingRepository.createBooking(payload({ options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true }, equipment: { STROBE_PORTABLE: 1 } } }));
  assert.strictEqual(rejected.error.code, 'SETUP_METHOD_REQUIRED');
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, { equipment: { STROBE_PORTABLE: 1 } }).error.code, 'SETUP_METHOD_REQUIRED');
});

// ============================================================================
// スタッフ対応は会員限定（Issue #472）。会員資格の正本は会員台帳（#471）の利用月の支払い事実
// ============================================================================

var STAFF_ONLY_SELECTION = { layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'STAFF' };
var SELF_SELECTION = { layouts: ['CLASSROOM'], setupService: 'SELF', cleanupService: 'SELF', emailSupport: true };
var FUTURE_MONTH = FUTURE_DATE.slice(0, 7);

test('会員限定: 非会員は部屋と同時にスタッフ対応を申し込めず、予約自体も作られない（正しい文言で拒否）', function () {
  var ctx = setup({ members: false });
  var result = ctx.sandbox.BookingRepository.createBooking(payload({ options: STAFF_ONLY_SELECTION }));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
  assert.match(result.error.message, /会員限定/);
  assert.ok(!/管理者|承認|Admin|MemberMonths|membershipStatus|Webhook/.test(result.error.message), '内部用語を出さない');
  assert.strictEqual(ctx.calendars.cal1.events.length, 0, '予約（Calendar枠）は作られない');
  assert.strictEqual(ctx.urlFetchApp._calls.length, 0);
});

test('会員限定: 非会員でも部屋・セルフ設営（無料）・メールサポートは従来どおり利用できる', function () {
  var ctx = setup({ members: false });
  var result = createRoom(ctx, { options: SELF_SELECTION });
  assert.strictEqual(result.options.success, true);
  assert.ok(result.options.orders.every(function (o) { return o.category !== 'STAFF_SERVICE'; }));
  assert.strictEqual(createRoom(ctx, { date: futureDateJst_(61) }).success, true, '部屋のみの利用は非会員でも可');
});

test('会員限定: 非会員の後付け申込も拒否され、注文は作られない（フロントの表示だけに頼らない）', function () {
  var ctx = setup({ members: false });
  var r = createRoom(ctx);
  confirmRoom(ctx, r.bookingId);
  var result = ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, STAFF_ONLY_SELECTION);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
  assert.strictEqual(orderRows(ctx, r.bookingId).length, 0);
  /* 同じ予約へのセルフ設営は非会員でも追加できる */
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, SELF_SELECTION).success, true);
});

test('会員限定: 有効会員は同時申込・後付けともにスタッフ対応を申し込め、料金は3,000/3,000/5,000円のまま。判定は利用日の属する月', function () {
  var members = {};
  members[EMAIL] = [FUTURE_MONTH];
  var ctx = setup({ members: members });
  var r = createRoom(ctx, { options: { layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'STAFF' } });
  assert.strictEqual(r.options.success, true);
  var staff = r.options.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0];
  assert.strictEqual(staff.amountJpy, 5000);
  assert.ok(ctx.memberState.calls.every(function (c) { return c.month === FUTURE_MONTH; }), '利用日の月で会員台帳を確認する: ' + JSON.stringify(ctx.memberState.calls));
  var r2 = createRoom(ctx, { date: futureDateJst_(61) });
  confirmRoom(ctx, r2.bookingId);
  var addon = ctx.sandbox.OptionOrderService.submitAddonOptions(r2.bookingId, EMAIL, { layouts: ['JAPANESE'], setupService: 'STAFF', cleanupService: 'SELF' });
  if (futureDateJst_(61).slice(0, 7) === FUTURE_MONTH) {
    assert.strictEqual(addon.success, true);
    assert.strictEqual(addon.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0].amountJpy, 3000);
  } else {
    assert.strictEqual(addon.error.code, 'STAFF_SERVICE_MEMBERS_ONLY', '別の月の会費が未払いなら利用不可');
  }
});

test('会員限定: 別の月の会費しか支払っていない・台帳を読めない場合は拒否（fail-closed）', function () {
  var otherMonth = {};
  otherMonth[EMAIL] = ['2000-01'];
  var a = setup({ members: otherMonth });
  assert.strictEqual(a.sandbox.BookingRepository.createBooking(payload({ options: STAFF_ONLY_SELECTION })).error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
  var b = setup({ members: 'THROW' });
  assert.strictEqual(b.sandbox.BookingRepository.createBooking(payload({ options: STAFF_ONLY_SELECTION })).error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
  /* メールの大文字小文字・別メールでは通らない（予約メールと会員登録メールの照合） */
  var other = {};
  other['someone-else@example.com'] = [FUTURE_MONTH];
  var c = setup({ members: other });
  assert.strictEqual(c.sandbox.BookingRepository.createBooking(payload({ options: STAFF_ONLY_SELECTION })).error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
});

test('会員限定: スペースマーケット経由などsource・備考が何であっても条件は同じ（非会員の例外は無い）', function () {
  var ctx = setup({ members: false });
  ['spacemarket', 'スペースマーケット', 'studio-x-booking-app'].forEach(function (source) {
    var result = ctx.sandbox.BookingRepository.createBooking(payload({ source: source, note: 'スペースマーケット経由です', options: STAFF_ONLY_SELECTION }));
    assert.strictEqual(result.success, false, source);
    assert.strictEqual(result.error.code, 'STAFF_SERVICE_MEMBERS_ONLY', source);
  });
  var r = createRoom(ctx, { source: 'spacemarket' });
  confirmRoom(ctx, r.bookingId);
  assert.strictEqual(ctx.sandbox.OptionOrderService.submitAddonOptions(r.bookingId, EMAIL, STAFF_ONLY_SELECTION).error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
});

test('会員限定: 支払い（確定）の時点でも会員資格を再確認する。承認後に資格を失っていたらCheckoutを作らない', function () {
  var ctx = setup();
  var s = stagedStaffOrder(ctx);
  ctx.sandbox.OptionOrderService.approveOrder(s.optionOrderId);
  ctx.memberState.rule = false;
  var out = ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId);
  assert.strictEqual(out.success, false);
  assert.strictEqual(out.error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
  assert.strictEqual(ctx.stripe.createCalls.length, 0, 'Stripeを呼ばない');
  ctx.memberState.rule = true;
  assert.strictEqual(ctx.sandbox.OptionOrderService.startOptionCheckout(s.bookingId, EMAIL, s.optionOrderId).success, true, '会員なら決済に進める');
});

test('会員限定: 実際の会員台帳（#471のMemberRepository）で、未登録は拒否・利用月の支払い事実がある会員は利用できる', function () {
  var ctx = setup({ members: 'LEDGER' });
  var denied = ctx.sandbox.BookingRepository.createBooking(payload({ options: STAFF_ONLY_SELECTION }));
  assert.strictEqual(denied.error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
  ctx.sandbox.MemberRepository.upsertMember({ memberId: 'MBR-T1' }, { email: EMAIL }, { id: 'evt_seed', created: 1 }, { create: true }, new Date());
  assert.strictEqual(ctx.sandbox.BookingRepository.createBooking(payload({ options: STAFF_ONLY_SELECTION })).error.code, 'STAFF_SERVICE_MEMBERS_ONLY', '会員行だけでは不可（利用月の支払い事実が必要）');
  ctx.sandbox.MemberRepository.recordPaidMonth({ memberId: 'MBR-T1', month: FUTURE_MONTH, amount: 1000 }, new Date());
  var ok = ctx.sandbox.BookingRepository.createBooking(payload({ options: STAFF_ONLY_SELECTION }));
  assert.strictEqual(ok.success, true, JSON.stringify(ok.error));
  assert.strictEqual(ok.options.success, true);
});
