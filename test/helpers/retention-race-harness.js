/*
 * Issue #690 §2: 書き戻し競合（消去後の個人情報の復活）の実入口テスト用の共通部品。合成データのみ。
 * Booking Admin（消去と書き手が同じプロジェクト＝同じスクリプトロック）のサンドボックスを作り、外部呼び出し（Stripe・メール・カレンダー）の
 * 各時点で消去を1回挟んで、消去済みの個人情報が戻らないこと・書き込みが常にロック保持中であることを監査する。
 */
'use strict';

var assert = require('node:assert');
var loadBookingSandbox = require('./gas-sandbox').loadBookingSandbox;
var stubs = require('./gas-stubs');
var manifest = require('./booking-deployment-manifest');

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
  var ctxRef = {};
  spreadsheetsById[SPREADSHEET_ID] = new Proxy({}, {
    set: function (target, key, value) {
      target[key] = value;
      if (value && typeof value.getRange === 'function' && typeof ctxRef.watch === 'function') ctxRef.watch(value, key);
      return true;
    }
  });
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
  /* 書き込み時のロック保持と、書き込み先（シート・行・列・列数）を記録する（全シート。後から作られるシートも自動）。 */
  ctx.unlockedWrites = 0;
  ctx.writeLog = [];
  /* テストの準備（別プロジェクト＝Webhook等の代わりに行を仕込む書き込み）は監査の対象にしない。実入口の呼び出しの直前に呼ぶ。 */
  ctx.resetWriteAudit = function () { ctx.unlockedWrites = 0; ctx.writeLog.length = 0; };
  ctx.watch = function (sheet, name) {
    if (sheet.__watched) return;
    sheet.__watched = true;
    var sheetName = name || (typeof sheet.getName === 'function' ? sheet.getName() : '?');
    var original = sheet.getRange.bind(sheet);
    sheet.getRange = function (r, c, nr, nc) {
      var range = original(r, c, nr, nc);
      var setValues = range.setValues, setValue = range.setValue;
      range.setValues = function () { if (!ctx.inPurge) { if (!held.value) ctx.unlockedWrites++; ctx.writeLog.push({ sheet: sheetName, row: r, col: c, cols: nc || 1, held: held.value }); } return setValues.apply(range, arguments); };
      range.setValue = function () { if (!ctx.inPurge) { if (!held.value) ctx.unlockedWrites++; ctx.writeLog.push({ sheet: sheetName, row: r, col: c, cols: 1, held: held.value }); } return setValue.apply(range, arguments); };
      return range;
    };
  };
  ctxRef.watch = ctx.watch;
  /* appendRow（行の追加）も記録する */
  var origInsert = book.insertSheet.bind(book);
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
function interleaveAll(build, run, extraAudit, auditTarget) {
  var target = auditTarget || { read: function (ctx) { return piiOf(ctx, BOOKING_ID); }, columns: PII_COLUMNS, seeded: SEEDED };
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
      var before = target.read(ctx);
      ctx.inPurge = true;
      var purged;
      try { purged = plain(ctx.admin.purgeExpiredPersonalData(realNow())); } finally { ctx.inPurge = false; }
      var after = target.read(ctx);
      if (lockedByWriter) {
        assert.strictEqual(purged.status, 'LOCK_TIMEOUT', 'ロック保持中は消去が待たされる（別の書き手と並行しない）');
        assert.deepStrictEqual(after, before, 'ロック保持中は何も消さない');
        summary.serialized++;
      }
      clearedColumns = target.columns.filter(function (c) { return before[c] !== '' && after[c] === ''; });
      if (!lockedByWriter) summary.openGaps++;
    };
    ctx.__k = k;
    if (k === -1) {
      ctx.inPurge = true;
      try { ctx.admin.purgeExpiredPersonalData(realNow()); } finally { ctx.inPurge = false; }
      clearedColumns = target.columns.filter(function (c) { return target.read(ctx)[c] === ''; });
    }
    run(ctx);
    var final = target.read(ctx);
    (clearedColumns || []).forEach(function (column) {
      assert.notStrictEqual(final[column], target.seeded[column], '段階 ' + k + ': ' + column + ' が消去前の値に戻った');
    });
    assert.strictEqual(ctx.unlockedWrites, 0, '段階 ' + k + ': ロック外の書き込み');
    if (typeof extraAudit === 'function') extraAudit(ctx, k);
    summary.runs++;
    if (clearedColumns && clearedColumns.length > 0) summary.cleared++;
    else if (k >= 0) summary.heldRuns++;
  }
  return summary;
}


module.exports = {
  DAY: DAY,
  RETENTION: RETENTION,
  VERSION: VERSION,
  SPREADSHEET_ID: SPREADSHEET_ID,
  EMAIL: EMAIL,
  BOOKING_ID: BOOKING_ID,
  SESSION_ID: SESSION_ID,
  PI_ID: PI_ID,
  ATTEMPT_ID: ATTEMPT_ID,
  plain: plain,
  PII_COLUMNS: PII_COLUMNS,
  SEEDED: SEEDED,
  OPTION_HEADERS: OPTION_HEADERS,
  OPTION_PII: OPTION_PII,
  realNow: realNow,
  agoReal: agoReal,
  flowSetup: flowSetup,
  bookingRow: bookingRow,
  piiOf: piiOf,
  addOldBooking: addOldBooking,
  interleaveAll: interleaveAll
};
