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

var DAY = 24 * 60 * 60 * 1000;
var RETENTION = 180 * DAY;
var VERSION = '2026-10-31.4';
var SPREADSHEET_ID = 'ss1';
var EMAIL = 'pii-entry@example.com';
var BOOKING_ID = 'SX-20250101-BBBBBBBB';
var SESSION_ID = 'cs_synthetic_entry';
var PI_ID = 'pi_synthetic_entry';
var ATTEMPT_ID = 'PAY-' + BOOKING_ID + '-ABCDEF012345';

function plain(value) { return JSON.parse(JSON.stringify(value)); }

var PII_COLUMNS = ['name', 'email', 'phone', 'purpose', 'note', 'feeSettlementNote', 'feeRecoveryReason', 'refundReason', 'stripeCheckoutRequestSnapshot', 'paymentLastErrorMessage', 'paymentRecoveryReason', 'paymentLinkSentTo', 'lastMailErrorMessage', 'paymentLinkLastErrorMessage'];
var SEEDED = {
  name: 'テスト太郎', email: EMAIL, phone: '090-0000-0000', purpose: '相談メモ', note: '旧い備考', feeSettlementNote: '旧い精算メモ', feeRecoveryReason: '旧い復旧理由',
  refundReason: '旧い返金理由', stripeCheckoutRequestSnapshot: '{"customer_email":"pii-entry@example.com"}', paymentLastErrorMessage: '旧い決済エラー',
  paymentRecoveryReason: '旧い決済の復旧理由', paymentLinkSentTo: EMAIL, lastMailErrorMessage: '旧いメールエラー', paymentLinkLastErrorMessage: '旧い決済リンクエラー'
};
var OPTION_HEADERS = ['optionOrderId', 'bookingId', 'brand', 'category', 'source', 'itemsJson', 'amountJpy', 'currency', 'approvalStatus', 'paymentStatus', 'status', 'customerEmail', 'createdAt', 'updatedAt', 'approvedAt', 'declinedAt', 'declineReason', 'paymentAttemptId', 'checkoutRequestJson', 'stripeCheckoutSessionId', 'stripePaymentIntentId', 'stripeAmount', 'stripeCurrency', 'paidAt', 'lastStripeEventId', 'decisionMailSentAt', 'confirmedMailSentAt', 'paymentRecoveryRequiredAt', 'paymentRecoveryReason'];
var OPTION_PII = ['customerEmail', 'declineReason', 'checkoutRequestJson', 'paymentRecoveryReason'];

/* 実時間で動く処理（日程変更は new Date() を使う）に合わせ、消去も実時間で行う。 */
function realNow() { return new Date(); }
function agoReal(ms) { return new Date(Date.now() - ms); }

/* Booking Admin（消去と書き手が同じプロジェクト＝同じスクリプトロック）。外部呼び出しの直前に hook を呼ぶ。 */
function flowSetup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var held = { value: false };
  var lockService = {
    getScriptLock: function () {
      return {
        tryLock: function () { if (held.value) return false; held.value = true; return true; },
        releaseLock: function () { held.value = false; }
      };
    }
  };
  var ctx = { calls: 0, onExternal: null, held: held, events: [] };
  function external(kind) {
    var index = ctx.calls++;
    if (typeof ctx.onExternal === 'function') ctx.onExternal(index, kind);
  }
  var mail = stubs.createMailAppStub();
  var sendEmail = mail.sendEmail;
  mail.sendEmail = function () { external('mail'); return sendEmail.apply(mail, arguments); };
  var calendar = stubs.createCalendarAppStub({ cal1: { events: ctx.events } });
  var getCalendarById = calendar.getCalendarById;
  calendar.getCalendarById = function (id) {
    var cal = getCalendarById.call(calendar, id);
    ['getEvents', 'createEvent', 'getEventById'].forEach(function (name) {
      if (typeof cal[name] !== 'function' || cal['__wrapped_' + name]) return;
      var original = cal[name];
      cal[name] = function () { external('calendar'); return original.apply(cal, arguments); };
      cal['__wrapped_' + name] = true;
    });
    return cal;
  };
  var responder = opts.responder || function () { throw new Error('未対応のStripe呼び出し'); };
  var admin = loadBookingSandbox(manifest.BOOKING_ADMIN_FILES, {
    PropertiesService: stubs.createPropertiesServiceStub({
      CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID, STRIPE_SECRET_KEY: 'sk_test_synthetic', ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
      BOOKING_ADMIN_URL: 'https://script.google.com/macros/s/admin/exec', BOOKING_MAIL_DISPLAY_NAME: 'Studio', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
      PERSONAL_DATA_RETENTION_ENABLED: 'true', PERSONAL_DATA_RETENTION_POLICY_VERSION: VERSION, PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: VERSION
    }),
    CalendarApp: calendar, Utilities: stubs.createUtilitiesStub(), LockService: lockService,
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById), MailApp: mail, ScriptApp: stubs.createScriptAppStub(),
    UrlFetchApp: stubs.createUrlFetchAppStub(function (url, options) { external('stripe'); return responder(url, options); }),
    Logger: stubs.createLoggerStub()
  });
  var book = admin.SpreadsheetApp.openById(SPREADSHEET_ID);
  var bookings = book.insertSheet('Bookings');
  var headers = admin.BookingsSchema.HEADERS.slice();
  bookings.appendRow(headers);
  ctx.admin = admin; ctx.book = book; ctx.bookings = bookings; ctx.headers = headers; ctx.sheets = spreadsheetsById[SPREADSHEET_ID]; ctx.mail = mail;
  /* 書き込み時のロック保持を記録する（Bookings・OptionOrders） */
  ctx.unlockedWrites = 0;
  ctx.watch = function (sheet) {
    var original = sheet.getRange.bind(sheet);
    sheet.getRange = function (r, c, nr, nc) {
      var range = original(r, c, nr, nc);
      var setValues = range.setValues, setValue = range.setValue;
      range.setValues = function () { if (!held.value) ctx.unlockedWrites++; return setValues.apply(range, arguments); };
      range.setValue = function () { if (!held.value) ctx.unlockedWrites++; return setValue.apply(range, arguments); };
      return range;
    };
  };
  ctx.watch(bookings);
  return ctx;
}

function bookingRow(ctx, bookingId) {
  for (var i = 1; i < ctx.bookings._rows.length; i++) if (ctx.bookings._rows[i][0] === bookingId) return ctx.bookings._rows[i];
  throw new Error('行なし: ' + bookingId);
}
function piiOf(ctx, bookingId) {
  var row = bookingRow(ctx, bookingId), out = {};
  PII_COLUMNS.forEach(function (c) { out[c] = row[ctx.headers.indexOf(c)]; });
  return out;
}

/* 消去対象の古い予約（終端・180日超）を作る。overrides で状態・日時を指定。個人情報は全列に seed する。 */
function addOldBooking(ctx, overrides) {
  var end = agoReal(RETENTION + 30 * DAY);
  var start = new Date(end.getTime() - 2 * 60 * 60 * 1000);
  var row = Object.assign({
    bookingId: BOOKING_ID, createdAt: new Date(start.getTime() - 20 * DAY), date: '2025-04-10', startAt: start, endAt: end, brand: 'studio_x', people: '2名',
    paymentMethod: 'オンラインクレジットカード', status: 'CONFIRMED', calendarEventId: 'event-1', source: 'test', customerType: 'returning',
    confirmedAt: new Date(start.getTime() - 19 * DAY), confirmedMailSentAt: new Date(start.getTime() - 19 * DAY), paymentStatus: 'paid', priceAmount: 8000,
    paymentAttemptId: ATTEMPT_ID, paymentAttemptResolvedAt: new Date(start.getTime() - 19 * DAY), stripeCheckoutSessionId: SESSION_ID, stripePaymentIntentId: PI_ID,
    stripeAmount: 8000, stripeCurrency: 'JPY', paymentConfirmedAt: new Date(start.getTime() - 19 * DAY), lastStripeEventId: 'evt_synthetic_old', checkoutAccessToken: 'token-synthetic-0001'
  }, SEEDED, overrides || {});
  ctx.bookings.appendRow(ctx.headers.map(function (h) { return row[h] === undefined ? '' : row[h]; }));
  var event = stubs.createEventStub({ id: row.calendarEventId, title: row.status, start: row.startAt, end: row.endAt });
  event.setTag('bookingId', row.bookingId);
  event.setTag('status', row.status);
  ctx.events.push(event);
  return row;
}

/*
 * run(ctx) を、外部呼び出しの回数ぶん（＋事前に消去済みのケース）繰り返す。毎回新しい環境で:
 *   k=-1: 実入口の前に消去を済ませる ／ k=0..n-1: k番目の外部呼び出しの瞬間に消去を1回挟む
 * 各回で、消去が消した個人情報が戻っていないこと・書き込みがロック保持中であることを監査する。
 * 返り値: { stages, cleared（消去が個人情報を消した回数）, held（保留で何も消さなかった回数） }
 */
function interleaveAll(build, run, extraAudit) {
  var probe = build();
  run(probe);
  var stages = probe.calls;
  var summary = { stages: stages, cleared: 0, heldRuns: 0, runs: 0, serialized: 0, openGaps: 0 };
  for (var k = -1; k < stages; k++) {
    var ctx = build();
    var clearedColumns = null;
    ctx.onExternal = function (index) {
      if (index !== ctx.__k || clearedColumns !== null) return;
      /* 書き手がロックを保持している外部呼び出しでは、消去はロックを取れず何も消さない（直列化）。保持していなければ消去が走る。 */
      var lockedByWriter = ctx.held.value === true;
      var before = piiOf(ctx, BOOKING_ID);
      var purged = plain(ctx.admin.purgeExpiredPersonalData(realNow()));
      var after = piiOf(ctx, BOOKING_ID);
      if (lockedByWriter) {
        assert.strictEqual(purged.status, 'LOCK_TIMEOUT', 'ロック保持中は消去が待たされる（別の書き手と並行しない）');
        assert.deepStrictEqual(after, before, 'ロック保持中は何も消さない');
        summary.serialized++;
      }
      clearedColumns = PII_COLUMNS.filter(function (c) { return before[c] !== '' && after[c] === ''; });
      if (!lockedByWriter) summary.openGaps++;
    };
    ctx.__k = k;
    if (k === -1) {
      ctx.admin.purgeExpiredPersonalData(realNow());
      clearedColumns = PII_COLUMNS.filter(function (c) { return piiOf(ctx, BOOKING_ID)[c] === ''; });
    }
    run(ctx);
    var final = piiOf(ctx, BOOKING_ID);
    (clearedColumns || []).forEach(function (column) {
      assert.notStrictEqual(final[column], SEEDED[column], '段階 ' + k + ': ' + column + ' が消去前の値に戻った');
    });
    assert.strictEqual(ctx.unlockedWrites, 0, '段階 ' + k + ': ロック外の書き込み');
    if (typeof extraAudit === 'function') extraAudit(ctx, k);
    summary.runs++;
    if (clearedColumns && clearedColumns.length > 0) summary.cleared++;
    else if (k >= 0) summary.heldRuns++;
  }
  return summary;
}

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
      ctx.watch(ctx.sheets.StripeEvents);
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
