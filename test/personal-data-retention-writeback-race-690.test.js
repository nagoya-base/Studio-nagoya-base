/*
 * Issue #690 §2: 「古い値を読む → 消去 → 古い値を書き戻す」交差の検証（合成データのみ。実データ・実Spreadsheetは使わない）。
 *
 * 構成: 同じインメモリ台帳（同一Spreadsheet）を、別々のプロジェクト＝別のLockServiceスタブを持つ
 * サンドボックスから操作する。消去は Booking Admin、古い値を持つ書き手は Booking Web App／Webhook。
 * 書き込み直前に Admin の purgeExpiredPersonalData を1回割り込ませて、交差を決定的に再現する。
 *
 * 1. プリミティブ単体の再現: 読んだ行を書き戻す関数は、割り込まれると消去済みの個人情報を戻す（危険の実在）
 * 2. 自己修復: 戻っても、翌日の日次実行が同じ行を再判定して再び消す
 * 3. 到達不能の確認: 別プロジェクトの入口は、消去対象になり得る行（終端・180日経過）へ書かない（状態ガード）
 * 4. 構造の固定: 別プロジェクトから呼ばれ得る範囲書き込みの一覧が変わったら、このテストが落ちて再検討を促す
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');

var DAY = 24 * 60 * 60 * 1000;
var RETENTION = 180 * DAY;
var NOW = new Date('2026-12-10T12:00:00+09:00');
var SPREADSHEET_ID = 'ss1';
var VERSION = '2026-10-31.4';
var EMAIL = 'pii-race@example.com';

function plain(value) { return JSON.parse(JSON.stringify(value)); }
function ago(ms) { return new Date(NOW.getTime() - ms); }

function loadProject(files, spreadsheetsById, properties) {
  return loadBookingSandbox(files, {
    PropertiesService: stubs.createPropertiesServiceStub(Object.assign({ CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID }, properties || {})),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(),
    LockService: stubs.createLockServiceStub(), /* プロジェクトごとに別のスタブ＝ロックを共有しない（本番のAdmin／Web App／Webhookと同じ） */
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: stubs.createMailAppStub(),
    ScriptApp: stubs.createScriptAppStub(),
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { return { code: 500, body: '{}' }; }),
    Logger: stubs.createLoggerStub()
  });
}

var OPTION_HEADERS = ['optionOrderId', 'bookingId', 'brand', 'category', 'source', 'itemsJson', 'amountJpy', 'currency', 'approvalStatus', 'paymentStatus', 'status', 'customerEmail', 'createdAt', 'updatedAt', 'approvedAt', 'declinedAt', 'declineReason', 'paymentAttemptId', 'checkoutRequestJson', 'stripeCheckoutSessionId', 'stripePaymentIntentId', 'stripeAmount', 'stripeCurrency', 'paidAt', 'lastStripeEventId', 'decisionMailSentAt', 'confirmedMailSentAt', 'paymentRecoveryRequiredAt', 'paymentRecoveryReason'];
var MEMBER_HEADERS = ['memberId', 'email', 'stripeCustomerId', 'stripeSubscriptionId', 'status', 'currentPeriodStart', 'currentPeriodEnd', 'canceledAt', 'cancelAtPeriodEnd', 'latestInvoiceId', 'latestEventId', 'latestEventCreated', 'createdAt', 'updatedAt'];

/* 1つの台帳に、Admin（消去）・Web App・Webhook の3プロジェクトを載せる。 */
function setup() {
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var admin = loadProject(manifest.BOOKING_ADMIN_FILES, spreadsheetsById, {
    PERSONAL_DATA_RETENTION_ENABLED: 'true', PERSONAL_DATA_RETENTION_POLICY_VERSION: VERSION, PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: VERSION
  });
  var web = loadProject(manifest.BOOKING_WEB_APP_FILES, spreadsheetsById, {
    STRIPE_CHECKOUT_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_synthetic', STRIPE_CHECKOUT_SUCCESS_URL: 'https://example.com/ok', STRIPE_CHECKOUT_CANCEL_URL: 'https://example.com/ng'
  });
  var webhook = loadProject(manifest.BOOKING_WEBHOOK_FILES, spreadsheetsById);
  var book = admin.SpreadsheetApp.openById(SPREADSHEET_ID);
  var bookings = book.insertSheet('Bookings');
  var headers = admin.BookingsSchema.HEADERS.slice();
  bookings.appendRow(headers);
  var ctx = { admin: admin, web: web, webhook: webhook, book: book, bookings: bookings, headers: headers, sheets: spreadsheetsById[SPREADSHEET_ID] };
  return ctx;
}

var seq = 0;
function addBooking(ctx, overrides) {
  seq += 1;
  var base = Object.assign({
    bookingId: 'snb-20250101-' + ('0000' + seq).slice(-4) + 'abcd', status: 'CONFIRMED', endAt: ago(RETENTION + 30 * DAY),
    brand: 'snb', paymentMethod: 'cash', priceAmount: 6000,
    name: 'テスト太郎', email: EMAIL, phone: '090-0000-0000', purpose: '相談メモ', note: '備考の自由記述',
    feeSettlementNote: '精算メモ', feeRecoveryReason: '精算の復旧理由', refundReason: '返金理由',
    stripeCheckoutRequestSnapshot: '{"customer_email":"pii-race@example.com"}', paymentLastErrorMessage: '決済エラー文', paymentRecoveryReason: '決済の復旧理由'
  }, overrides || {});
  ctx.bookings.appendRow(ctx.headers.map(function (h) { return base[h] === undefined ? '' : base[h]; }));
  return base.bookingId;
}

function bookingCell(ctx, bookingId, column) {
  for (var i = 1; i < ctx.bookings._rows.length; i++) {
    if (ctx.bookings._rows[i][0] === bookingId) return ctx.bookings._rows[i][ctx.headers.indexOf(column)];
  }
  throw new Error('行なし: ' + bookingId);
}

function table(ctx, name, headers) {
  if (!ctx.sheets[name]) {
    ctx.sheets[name] = ctx.book.insertSheet(name);
    ctx.sheets[name].appendRow(headers);
  }
  return ctx.sheets[name];
}

function appendRecord(ctx, name, headers, values) {
  table(ctx, name, headers).appendRow(headers.map(function (h) { return values[h] === undefined ? '' : values[h]; }));
}

function tableCell(ctx, name, headers, keyColumn, key, column) {
  var rows = ctx.sheets[name]._rows;
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][headers.indexOf(keyColumn)] === key) return rows[i][headers.indexOf(column)];
  }
  throw new Error('行なし: ' + key);
}

/* 指定シートの「複数セルを書く setValues」が呼ばれる直前に、Adminの消去を1回だけ実行する（交差の再現）。 */
function interleavePurgeBeforeWrite(ctx, sheet, rowNumber, log) {
  var original = sheet.getRange.bind(sheet);
  var fired = false;
  sheet.getRange = function (row, col, numRows, numCols) {
    var range = original(row, col, numRows, numCols);
    var setValues = range.setValues;
    range.setValues = function () {
      if (!fired && row === rowNumber) {
        fired = true;
        var result = plain(ctx.admin.purgeExpiredPersonalData(NOW));
        if (log) log.result = result;
      }
      return setValues.apply(range, arguments);
    };
    return range;
  };
  return function restore() { sheet.getRange = original; };
}

function enableRun(ctx, now) { return plain(ctx.admin.purgeExpiredPersonalData(now || NOW)); }

// ============================================================================
// 1. プリミティブ単体の再現（危険の実在）と 2. 自己修復
// ============================================================================

var BOOKING_WRITERS = [
  {
    label: 'updateBookingCancellationStateAtomic（status〜updatedAt の連続範囲。note を含む）',
    call: function (web, id) { web.SpreadsheetRepository.updateBookingCancellationStateAtomic(id, { updatedAt: NOW }); },
    revived: ['note']
  },
  {
    label: 'updateBookingPaymentStateAtomic（paymentAttemptId〜paymentRecoveryReason の連続17列）',
    call: function (web, id) { web.SpreadsheetRepository.updateBookingPaymentStateAtomic(id, { paymentAttemptResolvedAt: NOW }); },
    revived: ['stripeCheckoutRequestSnapshot', 'paymentLastErrorMessage', 'paymentRecoveryReason']
  },
  {
    label: 'updateBookingRescheduleFeeAtomic（priceOverrideAmount〜feeRecoveryReason の連続範囲）',
    call: function (web, id) { web.SpreadsheetRepository.updateBookingRescheduleFeeAtomic(id, { scheduleChangeCount: 1 }); },
    revived: ['feeSettlementNote', 'feeRecoveryReason']
  },
  {
    label: 'updateBookingRefundStateAtomic（refundAttemptId〜refundCheckedAt の連続8列）',
    call: function (web, id) { web.SpreadsheetRepository.updateBookingRefundStateAtomic(id, { refundCheckedAt: NOW }); },
    revived: ['refundReason']
  }
];

BOOKING_WRITERS.forEach(function (writer) {
  test('再現: ' + writer.label + ' は、読んだ後に消去が入ると消去済みの個人情報を戻す', function () {
    var ctx = setup();
    var id = addBooking(ctx);
    var rowNumber = ctx.bookings._rows.length;
    var log = {};
    interleavePurgeBeforeWrite(ctx, ctx.bookings, rowNumber, log);
    writer.call(ctx.web, id);
    assert.strictEqual(log.result.status, 'OK', '書き込みの直前に消去が実行された');
    writer.revived.forEach(function (column) {
      assert.notStrictEqual(bookingCell(ctx, id, column), '', column + ' が戻る（読み込み時点の古い値の書き戻し）');
    });
    /* 範囲外の列は戻らない（連続範囲に含まれる列だけが危険） */
    ['name', 'email', 'phone', 'purpose'].forEach(function (column) {
      assert.strictEqual(bookingCell(ctx, id, column), '', column + ' は範囲外なので消えたまま');
    });
  });

  test('自己修復: ' + writer.label + ' で戻っても、翌日の日次実行が同じ行を再判定して再び消す', function () {
    var ctx = setup();
    var id = addBooking(ctx);
    var rowNumber = ctx.bookings._rows.length;
    var restore = interleavePurgeBeforeWrite(ctx, ctx.bookings, rowNumber, {});
    writer.call(ctx.web, id);
    restore();
    writer.revived.forEach(function (column) { assert.notStrictEqual(bookingCell(ctx, id, column), '', column); });
    var next = enableRun(ctx, new Date(NOW.getTime() + DAY));
    assert.strictEqual(next.status, 'OK');
    writer.revived.forEach(function (column) { assert.strictEqual(bookingCell(ctx, id, column), '', column + ' が翌日に再び消える'); });
  });
});

test('再現: OptionOrderRepository.updateOrder（1行を丸ごと書き戻す）は、読んだ後に消去が入ると顧客メール等を戻す', function () {
  var ctx = setup();
  var bookingId = addBooking(ctx);
  appendRecord(ctx, 'OptionOrders', OPTION_HEADERS, {
    optionOrderId: 'OPT-1', bookingId: bookingId, status: 'CONFIRMED', customerEmail: EMAIL, createdAt: ago(RETENTION + 40 * DAY),
    paidAt: ago(RETENTION + 35 * DAY), approvedAt: ago(RETENTION + 36 * DAY), declineReason: '不承認の理由メモ',
    checkoutRequestJson: '{"amountJpy":1000}', paymentRecoveryReason: '復旧理由メモ', itemsJson: '["EQ:COB:1"]', amountJpy: 1000, paymentStatus: 'paid'
  });
  var log = {};
  interleavePurgeBeforeWrite(ctx, ctx.sheets.OptionOrders, 2, log);
  ctx.web.OptionOrderRepository.updateOrder('OPT-1', { lastStripeEventId: 'evt_x' });
  assert.strictEqual(log.result.status, 'OK');
  assert.notStrictEqual(tableCell(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', 'OPT-1', 'customerEmail'), '', '顧客メールが戻る');
  var next = enableRun(ctx, new Date(NOW.getTime() + DAY));
  assert.strictEqual(next.status, 'OK');
  ['customerEmail', 'declineReason', 'checkoutRequestJson', 'paymentRecoveryReason'].forEach(function (column) {
    assert.strictEqual(tableCell(ctx, 'OptionOrders', OPTION_HEADERS, 'optionOrderId', 'OPT-1', column), '', column + ' は翌日に再び消える');
  });
});

test('対照: 1セルだけ書く updateBookingFields・日時3列の updateBookingScheduleAtomic は、消去済みの個人情報を戻さない', function () {
  ['fields', 'schedule'].forEach(function (kind) {
    var ctx = setup();
    var id = addBooking(ctx);
    var rowNumber = ctx.bookings._rows.length;
    var original = ctx.bookings.getRange.bind(ctx.bookings);
    var fired = false;
    ctx.bookings.getRange = function (row, col, numRows, numCols) {
      var range = original(row, col, numRows, numCols);
      var setValues = range.setValues;
      range.setValues = function () {
        if (!fired && row === rowNumber) { fired = true; ctx.admin.purgeExpiredPersonalData(NOW); }
        return setValues.apply(range, arguments);
      };
      return range;
    };
    if (kind === 'fields') ctx.web.SpreadsheetRepository.updateBookingFields(id, { paymentStatus: 'paid' });
    else ctx.web.SpreadsheetRepository.updateBookingScheduleAtomic(id, '2025-01-02', new Date(NOW.getTime() - 400 * DAY), new Date(NOW.getTime() - 399 * DAY));
    assert.ok(fired, kind);
    ['name', 'email', 'phone', 'purpose', 'note', 'feeSettlementNote', 'refundReason', 'stripeCheckoutRequestSnapshot'].forEach(function (column) {
      assert.strictEqual(bookingCell(ctx, id, column), '', kind + ': ' + column);
    });
  });
});

// ============================================================================
// 3. 到達不能の確認: 別プロジェクト（Web App）の入口は、消去対象になり得る行へ書かない
// ============================================================================

function writeCount(ctx) {
  var total = 0;
  Object.keys(ctx.sheets).concat(['Bookings']).forEach(function (name) {
    var sheet = name === 'Bookings' ? ctx.bookings : ctx.sheets[name];
    if (sheet && sheet._setValuesCalls) total += sheet._setValuesCalls.length;
  });
  return total;
}

['CONFIRMED', 'CANCELLED', 'EXPIRED'].forEach(function (status) {
  test('到達不能: Web Appのカード決済開始（beginCardCheckout）は、180日経過した ' + status + ' の予約を書き換えない', function () {
    var ctx = setup();
    var basis = status === 'CONFIRMED' ? { endAt: ago(RETENTION + 30 * DAY) } : status === 'CANCELLED' ? { cancelledAt: ago(RETENTION + 30 * DAY) } : { expiredAt: ago(RETENTION + 30 * DAY) };
    var id = addBooking(ctx, Object.assign({ status: status, paymentMethod: 'オンラインクレジットカード', checkoutAccessToken: 'tok-synthetic-0123456789' }, basis));
    var before = writeCount(ctx);
    var result = plain(ctx.web.BookingRepository.beginCardCheckout(id, 'tok-synthetic-0123456789', NOW));
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.code, 'BOOKING_NOT_PENDING', '状態ガードで止まる');
    assert.strictEqual(writeCount(ctx), before, '台帳へ一切書かない');
  });
});

['CONFIRMED', 'DECLINED'].forEach(function (orderStatus) {
  test('到達不能: Web Appのオプション決済開始（startOptionCheckout）は、終端の注文（' + orderStatus + '）を書き換えない', function () {
    var ctx = setup();
    var bookingId = addBooking(ctx, { endAt: ago(RETENTION + 30 * DAY) });
    appendRecord(ctx, 'OptionOrders', OPTION_HEADERS, {
      optionOrderId: 'OPT-2', bookingId: bookingId, brand: 'snb', category: 'EQUIPMENT', status: orderStatus, customerEmail: EMAIL,
      createdAt: ago(RETENTION + 40 * DAY), paidAt: ago(RETENTION + 35 * DAY), approvedAt: ago(RETENTION + 36 * DAY), declinedAt: ago(RETENTION + 36 * DAY),
      itemsJson: '["EQ:COB:1"]', amountJpy: 1000, paymentStatus: 'paid', approvalStatus: orderStatus === 'DECLINED' ? 'DECLINED' : 'APPROVED'
    });
    var before = writeCount(ctx);
    var result = plain(ctx.web.OptionOrderService.startOptionCheckout(bookingId, EMAIL, 'OPT-2', NOW));
    assert.strictEqual(result.success, false);
    assert.ok(['ALREADY_PAID', 'ORDER_DECLINED'].indexOf(result.error.code) !== -1, '状態ガードで止まる: ' + result.error.code);
    assert.strictEqual(writeCount(ctx), before, '台帳へ一切書かない');
  });
});

test('到達不能: 解約済み（canceled）の会員は、解約予約（markCancelRequested）でも書き換えない', function () {
  var ctx = setup();
  appendRecord(ctx, 'Members', MEMBER_HEADERS, {
    memberId: 'mem-1', email: '', stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', status: 'canceled',
    canceledAt: ago(RETENTION + 61 * DAY), currentPeriodEnd: ago(RETENTION + 60 * DAY), createdAt: ago(RETENTION + 200 * DAY), updatedAt: ago(RETENTION + 61 * DAY)
  });
  var before = writeCount(ctx);
  assert.strictEqual(ctx.web.MemberRepository.markCancelRequested('mem-1', NOW), false);
  assert.strictEqual(writeCount(ctx), before);
});

test('到達不能: 利用開始後の期限切れ予約は復活できない（reviveExpiredBooking。180日経過した EXPIRED は必ず開始後）', function () {
  var ctx = setup();
  var id = addBooking(ctx, {
    status: 'EXPIRED', expiredAt: ago(RETENTION + 30 * DAY), startAt: ago(RETENTION + 31 * DAY), endAt: ago(RETENTION + 30 * DAY)
  });
  var before = writeCount(ctx);
  var result = plain(ctx.admin.BookingRepository.reviveExpiredBooking(id, NOW));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REVIVE_AFTER_START_NOT_ALLOWED');
  assert.strictEqual(writeCount(ctx), before);
});

test('前提: 公開側の予約可能期間（会員90日）は180日より十分短い（期限切れ予約は消去期限までに開始を迎える）', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'booking', 'shared', 'BookingWindow.gs'), 'utf8');
  var m = /var MEMBER_DAYS = (\d+);/.exec(src);
  assert.ok(m, 'MEMBER_DAYS の定義が見つからない: BookingWindow.gs を確認すること');
  assert.ok(Number(m[1]) + 1 < 180, 'MEMBER_DAYS=' + m[1] + '。管理者の遠い先の予約はAdminプロジェクト内（消去と同じスクリプトロック）で扱う');
});

test('直列化: 同じプロジェクト（Booking Admin）の書き込み中は、消去がロックを取れず何も消さない', function () {
  var ctx = setup();
  var id = addBooking(ctx);
  var lock = ctx.admin.LockService.getScriptLock();
  assert.ok(lock.tryLock(1000), 'Admin側の書き手がスクリプトロックを保持');
  var result = plain(ctx.admin.purgeExpiredPersonalData(NOW));
  lock.releaseLock();
  assert.strictEqual(result.status, 'LOCK_TIMEOUT');
  assert.strictEqual(bookingCell(ctx, id, 'email'), EMAIL, '何も消していない');
});

// ============================================================================
// 4. 構造の固定: 古い行を書き戻す関数の呼び出し元が増えたら、ここで落として再検討を促す
// ============================================================================

function callSites(pattern) {
  var root = path.join(__dirname, '..', 'gas', 'booking');
  var found = {};
  ['shared', 'public', 'admin', 'webhook'].forEach(function (dir) {
    fs.readdirSync(path.join(root, dir)).forEach(function (file) {
      if (!/\.gs$/.test(file)) return;
      var text = fs.readFileSync(path.join(root, dir, file), 'utf8');
      var count = (text.match(pattern) || []).length;
      if (count) found[dir + '/' + file] = count;
    });
  });
  return found;
}

test('構造: 読んだ行を書き戻す関数の呼び出し元（ファイル別の件数）が、検証済みの一覧と一致する', function () {
  /* 追加・移動したときは、そのファイルを配布するプロジェクト（manifest）と、消去と同じスクリプトロックで直列化されるかを
     確認してから、この一覧と docs/personal-data-retention-writeback-race-690.md を更新すること。 */
  assert.deepStrictEqual(callSites(/SpreadsheetRepository\.updateBookingCancellationStateAtomic\(/g), { 'shared/BookingRepository.gs': 1 });
  assert.deepStrictEqual(callSites(/SpreadsheetRepository\.updateBookingPaymentStateAtomic\(/g), { 'admin/BookingRefund.gs': 2, 'shared/BookingRepository.gs': 3 });
  assert.deepStrictEqual(callSites(/SpreadsheetRepository\.updateBookingRescheduleFeeAtomic\(/g), { 'admin/BookingReschedule.gs': 4 });
  assert.deepStrictEqual(callSites(/SpreadsheetRepository\.updateBookingRefundStateAtomic\(/g), { 'admin/BookingRefund.gs': 4 });
  assert.deepStrictEqual(callSites(/OptionOrderRepository\.updateOrder\(/g), { 'shared/OptionOrderService.gs': 11 });
  assert.deepStrictEqual(callSites(/MemberRepository\.upsertMember\(/g), { 'admin/StripeWebhookProcessor.gs': 5 });
  assert.deepStrictEqual(callSites(/MemberRepository\.markCancelRequested\(/g), { 'shared/MembershipService.gs': 1 });
  assert.deepStrictEqual(callSites(/MemberRepository\.updatePending\(/g), { 'admin/StripeWebhookProcessor.gs': 2, 'shared/MembershipService.gs': 2 });
});

test('構造: 公開Web Appの入口（Code.gs）が呼ぶリポジトリ／サービスの関数が、検証済みの一覧と一致する', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'booking', 'public', 'Code.gs'), 'utf8');
  var names = (src.match(/\b(?:BookingRepository|OptionOrderService|MembershipService|BookingMemberVerification|OptionOrderRepository|MemberRepository|SpreadsheetRepository|RecoveryRepository)\.[A-Za-z_]+(?=\()/g) || []);
  var unique = Array.from(new Set(names)).sort();
  assert.deepStrictEqual(unique, [
    'BookingMemberVerification.memberStatus', 'BookingMemberVerification.requestCode', 'BookingMemberVerification.verifyCode',
    'BookingRepository.beginCardCheckout', 'BookingRepository.createBooking', 'BookingRepository.getLargePartySummary', 'BookingRepository.startLargePartyCheckout',
    'MembershipService.cancelMembership', 'MembershipService.requestStatusLink', 'MembershipService.startCheckout', 'MembershipService.verifyStatusLink',
    'OptionOrderService.getCatalog', 'OptionOrderService.getCustomerSummary', 'OptionOrderService.startOptionCheckout', 'OptionOrderService.submitAddonOptions'
  ].sort());
});

test('到達不能: Webhookプロジェクトは、終端（COMPLETED）の受信行を再受信されても書き換えない（claim／finalizeForProcessing）', function () {
  var ctx = setup();
  var STRIPE_HEADERS = ['eventId', 'eventType', 'receivedAt', 'claimedAt', 'claimCount', 'processingState', 'bookingId', 'paymentAttemptId', 'stripePaymentIntentId', 'outcomeCode', 'outcomeMessage', 'updatedAt', 'rawBody', 'processingClaimedAt', 'processingClaimCount', 'processingHeartbeatAt', 'processingLeaseExpiresAt'];
  appendRecord(ctx, 'StripeEvents', STRIPE_HEADERS, {
    eventId: 'evt_old', eventType: 'checkout.session.completed', receivedAt: ago(RETENTION + 40 * DAY), claimedAt: ago(RETENTION + 40 * DAY), claimCount: 1,
    processingState: 'COMPLETED', outcomeMessage: '処理結果のメッセージ', updatedAt: ago(RETENTION + 39 * DAY), rawBody: '{"data":{"object":{"customer_email":"pii-race@example.com"}}}',
    processingClaimedAt: ago(RETENTION + 40 * DAY), processingClaimCount: 1
  });
  var before = writeCount(ctx);
  var claim = plain(ctx.webhook.StripeEventRepository.claim('evt_old', 'checkout.session.completed', NOW));
  assert.strictEqual(claim.outcome, 'ALREADY_TERMINAL');
  var fin = plain(ctx.webhook.StripeEventRepository.finalizeForProcessing(2, 1, { processingState: 'COMPLETED', outcomeMessage: 'x' }, NOW));
  assert.strictEqual(fin.written, false);
  assert.strictEqual(fin.reason, 'ALREADY_TERMINAL');
  assert.strictEqual(writeCount(ctx), before, '台帳へ一切書かない');
});
