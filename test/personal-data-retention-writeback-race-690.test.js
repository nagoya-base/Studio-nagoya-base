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

// ============================================================================
// 5. 返金の多段処理（Stripe呼び出しを挟みロックを解放→再取得する）: 各段階の間に消去を挟み、復活の有無を監査する
// ============================================================================

var REFUND_PI = 'pi_synthetic_0001';
var PII_COLUMNS = ['name', 'email', 'phone', 'purpose', 'note', 'feeSettlementNote', 'feeRecoveryReason', 'refundReason', 'stripeCheckoutRequestSnapshot', 'paymentLastErrorMessage', 'paymentRecoveryReason'];

/* 返金専用: 消去と返金が同じBooking Adminプロジェクト（＝同じスクリプトロック）で動く。ロックの保持状況も記録する。 */
function refundSetup(gapHook) {
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
  var events = [];
  var refunds = [];
  var calls = { n: 0 };
  function refundBody(r) { return { id: r.id, status: 'succeeded', amount: r.amount, currency: 'jpy', payment_intent: REFUND_PI, metadata: r.metadata }; }
  var responder = function (url, options) {
    var index = calls.n++;
    if (typeof gapHook === 'function') gapHook(index, url);
    var method = (options && options.method) || 'get';
    if (url.indexOf('/payment_intents/') !== -1) return { responseCode: 200, body: { id: REFUND_PI, status: 'succeeded', amount_received: 8000, currency: 'jpy' } };
    if (url.indexOf('/refunds?payment_intent=') !== -1) return { responseCode: 200, body: { data: refunds.map(refundBody), has_more: false } };
    if (method === 'post' && /\/refunds$/.test(url)) {
      var form = {};
      String(options.payload || '').split('&').forEach(function (kv) { var p = kv.split('='); form[decodeURIComponent(p[0])] = decodeURIComponent((p[1] || '').replace(/\+/g, ' ')); });
      var r = { id: 're_synthetic_' + (refunds.length + 1), amount: Number(form.amount), metadata: { bookingId: form['metadata[bookingId]'], refundAttemptId: form['metadata[refundAttemptId]'] } };
      refunds.push(r);
      return { responseCode: 200, body: refundBody(r) };
    }
    var m = /\/refunds\/([^/?]+)$/.exec(url);
    if (m) return { responseCode: 200, body: refundBody(refunds.filter(function (x) { return x.id === decodeURIComponent(m[1]); })[0]) };
    throw new Error('未対応のURL: ' + method + ' ' + url);
  };
  var admin = loadBookingSandbox(manifest.BOOKING_ADMIN_FILES, {
    PropertiesService: stubs.createPropertiesServiceStub({
      CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID, STRIPE_SECRET_KEY: 'sk_test_synthetic', ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
      BOOKING_ADMIN_URL: 'https://script.google.com/macros/s/admin/exec', BOOKING_MAIL_DISPLAY_NAME: 'Studio', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
      PERSONAL_DATA_RETENTION_ENABLED: 'true', PERSONAL_DATA_RETENTION_POLICY_VERSION: VERSION, PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: VERSION
    }),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: events } }),
    Utilities: stubs.createUtilitiesStub(), LockService: lockService,
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById), MailApp: stubs.createMailAppStub(), ScriptApp: stubs.createScriptAppStub(),
    UrlFetchApp: stubs.createUrlFetchAppStub(responder), Logger: stubs.createLoggerStub()
  });
  var book = admin.SpreadsheetApp.openById(SPREADSHEET_ID);
  var bookings = book.insertSheet('Bookings');
  var headers = admin.BookingsSchema.HEADERS.slice();
  bookings.appendRow(headers);
  return { admin: admin, bookings: bookings, headers: headers, held: held, events: events, calls: calls, refunds: refunds, sheets: spreadsheetsById[SPREADSHEET_ID] };
}

function addPaidOldBooking(rc) {
  var end = ago(RETENTION + 30 * DAY);
  var start = new Date(end.getTime() - 2 * 60 * 60 * 1000);
  var row = {
    bookingId: 'SX-20250101-AAAAAAAA', createdAt: new Date(start.getTime() - 20 * DAY), date: '2025-04-10', startAt: start, endAt: end, brand: 'studio_x',
    people: '2名', paymentMethod: 'オンラインクレジットカード', status: 'CONFIRMED', calendarEventId: 'event-1', source: 'test', customerType: 'returning',
    confirmedAt: new Date(start.getTime() - 19 * DAY), confirmedMailSentAt: new Date(start.getTime() - 19 * DAY), paymentStatus: 'paid', priceAmount: 8000,
    paymentAttemptId: 'PAY-SX-20250101-AAAAAAAA-ABCDEF012345', paymentAttemptResolvedAt: new Date(start.getTime() - 19 * DAY),
    stripeCheckoutSessionId: 'cs_synthetic_0001', stripePaymentIntentId: REFUND_PI, stripeAmount: 8000, stripeCurrency: 'JPY',
    paymentConfirmedAt: new Date(start.getTime() - 19 * DAY), lastStripeEventId: 'evt_synthetic_0001',
    name: 'テスト太郎', email: EMAIL, phone: '090-0000-0000', purpose: '相談メモ', note: '旧い備考',
    feeSettlementNote: '旧い精算メモ', feeRecoveryReason: '旧い復旧理由', refundReason: '旧い返金理由',
    stripeCheckoutRequestSnapshot: '{"customer_email":"pii-race@example.com"}', paymentLastErrorMessage: '旧い決済エラー', paymentRecoveryReason: '旧い決済の復旧理由'
  };
  rc.bookings.appendRow(rc.headers.map(function (h) { return row[h] === undefined ? '' : row[h]; }));
  var event = stubs.createEventStub({ id: 'event-1', title: 'CONFIRMED', start: start, end: end });
  event.setTag('bookingId', row.bookingId);
  rc.events.push(event);
  return row;
}

function cellsOf(rc, bookingId) {
  var out = {};
  for (var i = 1; i < rc.bookings._rows.length; i++) {
    if (rc.bookings._rows[i][0] === bookingId) PII_COLUMNS.forEach(function (c) { out[c] = rc.bookings._rows[i][rc.headers.indexOf(c)]; });
  }
  return out;
}

var SEEDED = { name: 'テスト太郎', email: EMAIL, phone: '090-0000-0000', purpose: '相談メモ', note: '旧い備考', feeSettlementNote: '旧い精算メモ', feeRecoveryReason: '旧い復旧理由', refundReason: '旧い返金理由', stripeCheckoutRequestSnapshot: '{"customer_email":"pii-race@example.com"}', paymentLastErrorMessage: '旧い決済エラー', paymentRecoveryReason: '旧い決済の復旧理由' };

['FULL', 'PARTIAL', 'NONE'].forEach(function (decision) {
  test('返金の多段処理（' + decision + '）: Stripe呼び出しの各段階の間に消去を挟んでも、消去済みの個人情報は戻らず、書き込みは常にロック保持中', function () {
    /* 1回目: 段階数を数える（消去なし）。2回目以降: 各段階 k で消去を1回挟む。 */
    var stageCount = 0;
    var dry = refundSetup();
    addPaidOldBooking(dry);
    var request = { decision: decision, amountJpy: 3000, reason: '新しい返金理由' };
    var dryResult = dry.admin.BookingRefund.cancelWithRefund('SX-20250101-AAAAAAAA', request, NOW);
    assert.strictEqual(dryResult.success, true, '返金の入口が実際に成功する（空振りでない）');
    stageCount = dry.calls.n;
    var sawCleared = 0, sawHeld = 0;

    for (var k = -1; k < Math.max(stageCount, 1); k++) {
      var cleared = null;
      var unlockedWrites = 0;
      var rc = refundSetup(function (index) {
        if (index === k && cleared === null) {
          var before = cellsOf(rc, 'SX-20250101-AAAAAAAA');
          assert.strictEqual(rc.held.value, false, 'Stripe呼び出し中はロックを保持していない（段階の間）');
          rc.admin.purgeExpiredPersonalData(NOW);
          var after = cellsOf(rc, 'SX-20250101-AAAAAAAA');
          cleared = PII_COLUMNS.filter(function (c) { return before[c] !== '' && after[c] === ''; });
        }
      });
      addPaidOldBooking(rc);
      if (k === -1) {
        /* 操作の前に消去が済んでいる（古い行を読み直して操作する）ケース */
        rc.admin.purgeExpiredPersonalData(NOW);
        cleared = PII_COLUMNS.filter(function (c) { return cellsOf(rc, 'SX-20250101-AAAAAAAA')[c] === ''; });
      }
      var originalGetRange = rc.bookings.getRange.bind(rc.bookings);
      rc.bookings.getRange = function (r, c, nr, nc) {
        var range = originalGetRange(r, c, nr, nc);
        var setValues = range.setValues;
        range.setValues = function () { if (!rc.held.value) unlockedWrites++; return setValues.apply(range, arguments); };
        var setValue = range.setValue;
        range.setValue = function () { if (!rc.held.value) unlockedWrites++; return setValue.apply(range, arguments); };
        return range;
      };
      var result = rc.admin.BookingRefund.cancelWithRefund('SX-20250101-AAAAAAAA', request, NOW);
      assert.strictEqual(result.success, true, decision + ' 段階' + k + ': 返金・取消が完了する');
      assert.strictEqual(rc.bookings._rows[1][rc.headers.indexOf('status')], 'CANCELLED');
      if (cleared && cleared.length > 0) sawCleared++;
      if (cleared && cleared.length === 0 && k >= 0) sawHeld++;
      var final = cellsOf(rc, 'SX-20250101-AAAAAAAA');
      (cleared || []).forEach(function (column) {
        assert.notStrictEqual(final[column], SEEDED[column], decision + ' 段階' + k + ': ' + column + ' が消去前の値に戻った');
      });
      assert.strictEqual(unlockedWrites, 0, decision + ' 段階' + k + ': ロック外の書き込み');
    }
    if (decision === 'NONE') {
      assert.strictEqual(stageCount, 0, '返金なしはStripeを呼ばない（段階の間が無い。操作前に消去が済んでいるケースだけを検証する）');
    } else {
      assert.strictEqual(stageCount, 3, 'Stripe呼び出しは3回（確認2回＋返金1回）。変わったらこのテストの前提を見直す');
    }
    assert.ok(sawCleared >= (decision === 'NONE' ? 1 : 3), '消去が実際に個人情報を消した段階がある（空振りでない）: ' + sawCleared);
    assert.ok(sawHeld >= (decision === 'NONE' ? 0 : 1), '返金が進行中の段階では保留として何も消さない: ' + sawHeld);
  });
});

// ============================================================================
// 6. 自己修復の限界（上限・保留）
// ============================================================================

test('自己修復: 既に空の行は1回200行の上限を消費しない（復活した行は、大量の消去済みの行の後ろにあっても次回の実行で消える）', function () {
  var ctx = setup();
  for (var i = 0; i < 250; i++) addBooking(ctx);
  assert.strictEqual(enableRun(ctx).status, 'TRUNCATED', '初回の積み残し（最大200行）');
  assert.strictEqual(enableRun(ctx, new Date(NOW.getTime() + DAY)).status, 'OK', '2回目で積み残しが完了');
  var last = ctx.bookings._rows.length - 1;
  ctx.bookings._rows[last][ctx.headers.indexOf('note')] = '復活した備考';
  var third = enableRun(ctx, new Date(NOW.getTime() + 2 * DAY));
  assert.strictEqual(third.status, 'OK');
  assert.strictEqual(ctx.bookings._rows[last][ctx.headers.indexOf('note')], '', '次回の実行で消える');
});

test('自己修復の限界: 書き手の更新で保留条件（決済未解決等）が立った行は、保留中は消えない（保留中の情報は利用中のもの）', function () {
  var ctx = setup();
  var id = addBooking(ctx);
  ctx.web.SpreadsheetRepository.updateBookingFields(id, { paymentStatus: 'refund_pending' });
  var result = enableRun(ctx);
  assert.strictEqual(result.status, 'OK');
  assert.strictEqual(bookingCell(ctx, id, 'email'), EMAIL, '保留中は消さない');
  ctx.web.SpreadsheetRepository.updateBookingFields(id, { paymentStatus: 'refunded' });
  assert.strictEqual(enableRun(ctx, new Date(NOW.getTime() + DAY)).status, 'OK');
  assert.strictEqual(bookingCell(ctx, id, 'email'), '', '保留が解けた翌日の実行で消える');
});

// ============================================================================
// 7. 構造の固定（続き）: 消去対象の列を引数で渡す書き込み箇所の一覧
// ============================================================================

/* 呼び出し元が「持ち越して後で書く」値は、引数で渡す値だけ（書き戻す範囲の他の列は、関数の中で行を読み直す）。
   消去対象の列を引数に含む呼び出しを数え、検証済みの一覧と照合する。増えたら、渡す値が「新しく作った値」「同じロック内で読み直した値」
   のどちらかであること（ロック外で読んだ個人情報を後で書かないこと）を確認してから、一覧と文書を更新する。 */
function piiArgumentWriters(callPattern, columns) {
  var root = path.join(__dirname, '..', 'gas', 'booking');
  var found = {};
  ['shared', 'public', 'admin', 'webhook'].forEach(function (dir) {
    fs.readdirSync(path.join(root, dir)).forEach(function (file) {
      if (!/\.gs$/.test(file) || file === 'SpreadsheetRepository.gs' || file === 'OptionOrderRepository.gs') return;
      var text = fs.readFileSync(path.join(root, dir, file), 'utf8');
      var re = new RegExp(callPattern, 'g');
      var m;
      while ((m = re.exec(text))) {
        var i = m.index + m[0].length, depth = 1;
        while (i < text.length && depth > 0) { depth += (text[i] === '(') - (text[i] === ')'); i++; }
        var call = text.slice(m.index, i);
        if (columns.some(function (c) { return new RegExp('\\b' + c + '\\s*:').test(call); })) found[dir + '/' + file] = (found[dir + '/' + file] || 0) + 1;
      }
    });
  });
  return found;
}

test('構造: 消去対象の列を引数で渡す書き込み箇所（Bookings・OptionOrders）が、検証済みの一覧と一致する', function () {
  var BOOKING_PII = ['note', 'stripeCheckoutRequestSnapshot', 'paymentLastErrorMessage', 'paymentRecoveryReason', 'feeSettlementNote', 'feeRecoveryReason', 'refundReason', 'paymentLinkSentTo', 'lastMailErrorMessage', 'paymentLinkLastErrorMessage', 'name', 'email', 'phone', 'purpose'];
  assert.deepStrictEqual(piiArgumentWriters('SpreadsheetRepository\\.updateBookingFields\\(', BOOKING_PII), {
    'admin/BookingRefund.gs': 1, 'admin/BookingReschedule.gs': 6, 'admin/StripeWebhookProcessor.gs': 1, 'shared/BookingMailer.gs': 4, 'shared/BookingRepository.gs': 1
  });
  assert.deepStrictEqual(piiArgumentWriters('SpreadsheetRepository\\.update(?:BookingCancellationStateAtomic|BookingPaymentStateAtomic|BookingRescheduleFeeAtomic|BookingRefundStateAtomic)\\(', BOOKING_PII), {
    'admin/BookingRefund.gs': 4, 'admin/BookingReschedule.gs': 1, 'shared/BookingRepository.gs': 1
  });
  assert.deepStrictEqual(piiArgumentWriters('OptionOrderRepository\\.updateOrder\\(', ['customerEmail', 'declineReason', 'checkoutRequestJson', 'paymentRecoveryReason']), { 'shared/OptionOrderService.gs': 6 });
});
