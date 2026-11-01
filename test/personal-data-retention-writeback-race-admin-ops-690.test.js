/*
 * Issue #690 §2（続き）: 管理画面（Booking Admin）の操作を、実際の書き込み関数に対応付けて、消去との交差を機械的に検証する。
 *
 * 方法: 管理画面から呼べる操作（admin*・メニュー・時間主導トリガー）を、消去対象の古い予約（4種類）に対して実際に呼ぶ。
 *   (1) 操作の前に消去が済んでいる場合と、外部呼び出し（Stripe・メール・カレンダー）の各時点で消去を挟む場合の両方で、
 *       消去が消した個人情報が消去前の値に戻っていないこと
 *   (2) 全シートへの書き込みが、常にスクリプトロック保持中であること
 *   を監査する（interleaveAll）。あわせて、操作ごとに「どの書き込み先（シート・列）に届いたか」を記録する。
 * 操作の一覧が変わった（管理画面に新しい操作が増えた）場合は、最後の構造テストが落ちて、分類を求める。
 * 合成データのみ。実Spreadsheet・実Stripe・実メールには触れない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var H = require('./helpers/retention-race-harness');
var stubs = require('./helpers/gas-stubs');

var DAY = H.DAY, RETENTION = H.RETENTION, BOOKING_ID = H.BOOKING_ID, EMAIL = H.EMAIL;
var agoReal = H.agoReal, realNow = H.realNow, plain = H.plain;
var OPTION_ID = 'OPT-ADMIN-1';

function jstDate(date) {
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  var out = {};
  parts.forEach(function (p) { if (p.type !== 'literal') out[p.type] = p.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

/* 管理画面の操作が呼ぶ外部サービス（Stripe）の最小限の合成応答。未知のURLは例外にせず404を返す。 */
function stripeResponder() {
  return function (url, options) {
    var method = String((options && options.method) || 'get').toLowerCase();
    if (/\/checkout\/sessions\/[^/]+\/expire$/.test(url)) return { responseCode: 200, body: { id: H.SESSION_ID, status: 'expired', payment_status: 'unpaid', amount_total: 8000, currency: 'jpy', payment_intent: null, metadata: {} } };
    if (url.indexOf('/checkout/sessions/') !== -1) return { responseCode: 200, body: { id: H.SESSION_ID, status: 'complete', payment_status: 'paid', amount_total: 8000, currency: 'jpy', payment_intent: H.PI_ID, metadata: { bookingId: BOOKING_ID, brand: 'studio_x', paymentAttemptId: H.ATTEMPT_ID } } };
    if (url.indexOf('/payment_intents/') !== -1) return { responseCode: 200, body: { id: H.PI_ID, status: 'succeeded', amount_received: 8000, currency: 'jpy' } };
    if (url.indexOf('/refunds?payment_intent=') !== -1) return { responseCode: 200, body: { data: [], has_more: false } };
    if (method === 'post' && /\/refunds$/.test(url)) return { responseCode: 200, body: { id: 're_synthetic_1', status: 'succeeded', amount: 8000, currency: 'jpy', payment_intent: H.PI_ID, metadata: { bookingId: BOOKING_ID } } };
    return { responseCode: 404, body: { error: { type: 'invalid_request_error', message: 'synthetic: not found' } } };
  };
}

/* 消去対象の古い予約の4種類。いずれも個人情報を全列に入れ、終端・180日超・未解決なしにする。 */
var KINDS = {
  'card-confirmed': function (ctx) { H.addOldBooking(ctx, {}); },
  'paypay-confirmed': function (ctx) {
    var end = agoReal(RETENTION + 30 * DAY), start = new Date(end.getTime() - 2 * 3600000), date0 = jstDate(start);
    var quote = ctx.admin.BookingPricing.computeBookingPrice({ brand: 'snb', date: date0, durationMinutes: 120, isMember: false });
    H.addOldBooking(ctx, {
      brand: 'snb', date: date0, startAt: start, endAt: end, paymentMethod: 'PayPay', paymentStatus: 'not_started', paymentAttemptId: '', paymentAttemptResolvedAt: '', stripeCheckoutSessionId: '', stripePaymentIntentId: '',
      stripeAmount: '', stripeCurrency: '', paymentConfirmedAt: '', lastStripeEventId: '', priceAmount: quote.price.amount, priceTier: 'GENERAL', priceDayType: quote.price.dayType, priceIsMember: false,
      priceComputedAt: agoReal(RETENTION + 60 * DAY), feePaidAmount: quote.price.amount
    });
  },
  /* SNB mens の大人数（5〜7名）・承認済み・確定済み。大人数／人数変更の操作が、種別ではなく状態で止まることを確かめる。 */
  'mens-large-party': function (ctx) {
    H.addOldBooking(ctx, { brand: 'mens', people: '6名', largeParty: 'TRUE', largePartyApprovalStatus: 'APPROVED', paymentMethod: 'PayPay', paymentStatus: 'not_started', paymentAttemptId: '', paymentAttemptResolvedAt: '',
      stripeCheckoutSessionId: '', stripePaymentIntentId: '', stripeAmount: '', stripeCurrency: '', paymentConfirmedAt: '', lastStripeEventId: '' });
  },
  /* 作品撮りサポート（mens）・確定済み。承認の操作が、種別ではなく状態で止まることを確かめる。 */
  'mens-photo-support': function (ctx) {
    H.addOldBooking(ctx, { brand: 'mens', planCode: 'mens_photo_support', supportApprovedAt: agoReal(RETENTION + 40 * DAY), paymentMethod: 'PayPay', paymentStatus: 'not_started', paymentAttemptId: '', paymentAttemptResolvedAt: '',
      stripeCheckoutSessionId: '', stripePaymentIntentId: '', stripeAmount: '', stripeCurrency: '', paymentConfirmedAt: '', lastStripeEventId: '' });
  },
  'cancelled-refunded': function (ctx) { H.addOldBooking(ctx, { status: 'CANCELLED', paymentStatus: 'refunded', cancelledAt: agoReal(RETENTION + 30 * DAY) }); },
  'expired-card': function (ctx) {
    H.addOldBooking(ctx, { status: 'EXPIRED', paymentStatus: 'not_started', paymentAttemptId: '', paymentAttemptResolvedAt: '', stripeCheckoutSessionId: '', stripePaymentIntentId: '', stripeAmount: '', stripeCurrency: '',
      paymentConfirmedAt: '', lastStripeEventId: '', expiredAt: agoReal(RETENTION + 30 * DAY), createdAt: agoReal(RETENTION + 33 * DAY) });
  }
};

function buildKind(kind) {
  var ctx = H.flowSetup({ responder: stripeResponder() });
  KINDS[kind](ctx);
  /* 終端のオプション注文（個人情報あり）も1件 */
  var sheet = ctx.book.insertSheet('OptionOrders');
  sheet.appendRow(H.OPTION_HEADERS);
  var values = {
    optionOrderId: OPTION_ID, bookingId: BOOKING_ID, brand: 'studio_x', category: 'EQUIPMENT', status: 'CONFIRMED', customerEmail: EMAIL, createdAt: agoReal(RETENTION + 40 * DAY), paidAt: agoReal(RETENTION + 35 * DAY),
    approvedAt: agoReal(RETENTION + 36 * DAY), declineReason: '旧い不承認理由', checkoutRequestJson: '{"amountJpy":1000}', paymentRecoveryReason: '旧い復旧理由', itemsJson: '["EQ:COB:1"]', amountJpy: 1000, paymentStatus: 'paid', approvalStatus: 'APPROVED'
  };
  sheet.appendRow(H.OPTION_HEADERS.map(function (h) { return values[h] === undefined ? '' : values[h]; }));
  ctx.resetWriteAudit();
  return ctx;
}

/*
 * 管理画面の操作の表。各操作を、合成の引数で実際に呼ぶ。引数が不適切で拒否されても、それは「書き込みに届かなかった」結果として記録される。
 * kind: 'booking'（古い予約を対象）／'option'（オプション注文）／'create'（新規予約。古い行に触れない）／'read'（読み取りのみ）
 */
var NOW_ARG = function () { return realNow(); };
var OPERATIONS = {
  // --- 管理画面（BookingAdminWeb.gs） ---
  adminApproveOptionOrder: function (a) { return a.admin.adminApproveOptionOrder(OPTION_ID); },
  adminDeclineOptionOrder: function (a) { return a.admin.adminDeclineOptionOrder(OPTION_ID, '新しい不承認理由'); },
  adminGrantVideoLightEligibility: function (a) { return a.admin.adminGrantVideoLightEligibility(EMAIL, a.admin.BookingOptions.lectureRequiredEquipmentCodes()[0], '付与メモ'); },
  adminRevokeVideoLightEligibility: function (a) { return a.admin.adminRevokeVideoLightEligibility(EMAIL, a.admin.BookingOptions.lectureRequiredEquipmentCodes()[0]); },
  adminConfirmBooking: function (a) { return a.admin.adminConfirmBooking(BOOKING_ID); },
  adminApproveLargeParty: function (a) { return a.admin.adminApproveLargeParty(BOOKING_ID); },
  adminRejectLargeParty: function (a) { return a.admin.adminRejectLargeParty(BOOKING_ID); },
  adminChangeBookingPeople: function (a) { return a.admin.adminChangeBookingPeople(BOOKING_ID, '3名'); },
  adminApprovePhotoSupport: function (a) { return a.admin.adminApprovePhotoSupport(BOOKING_ID, {}); },
  adminCancelBooking: function (a) { return a.admin.adminCancelBooking(BOOKING_ID); },
  adminReviveExpiredBooking: function (a) { return a.admin.adminReviveExpiredBooking(BOOKING_ID); },
  adminReviveExpiredCardBooking: function (a) { return a.admin.adminReviveExpiredCardBooking(BOOKING_ID, true); },
  adminSendCardPaymentLink: function (a) { return a.admin.adminSendCardPaymentLink(BOOKING_ID, 'https://buy.stripe.com/test_synthetic', false, 0, ''); },
  adminResolvePaymentLinkMetadataInconsistency: function (a) { return a.admin.adminResolvePaymentLinkMetadataInconsistency(BOOKING_ID, 0, 'https://buy.stripe.com/test_synthetic'); },
  adminUpdateBookingPrice: function (a) { return a.admin.adminUpdateBookingPrice(BOOKING_ID, 5000); },
  adminSendPriceUpdateMail: function (a) { return a.admin.adminSendPriceUpdateMail(BOOKING_ID, {}); },
  adminCancelBookingWithRefund: function (a) { return a.admin.adminCancelBookingWithRefund(BOOKING_ID, 'FULL', 0, '返金理由'); },
  adminReconcileRefund: function (a) { return a.admin.adminReconcileRefund(BOOKING_ID); },
  adminResendReminderMail: function (a) { return a.admin.adminResendReminderMail(BOOKING_ID, ''); },
  adminReconcileCheckoutExpiry: function (a) { return a.admin.adminReconcileCheckoutExpiry(BOOKING_ID); },
  adminResolvePaymentRecovery: function (a) { return a.admin.adminResolvePaymentRecovery(BOOKING_ID, '確認済み'); },
  adminRecoverInitialMembershipPeriod: function (a) { return a.admin.adminRecoverInitialMembershipPeriod({ memberId: 'MBR-none', subscriptionId: 'sub_none' }); },
  adminCreateBooking: function (a) { return a.admin.adminCreateBooking({ name: '新規', email: 'new@example.com', phone: '090-1111-1111', date: jstDate(new Date(Date.now() + 40 * DAY)), startTime: '13:00', endTime: '15:00', brand: 'snb', people: '1名', purpose: '撮影', paymentMethod: 'PayPay' }); },
  getAdminBookings: function (a) { return a.admin.getAdminBookings(); },
  getAdminBookingDetail: function (a) { return a.admin.getAdminBookingDetail(BOOKING_ID); },
  getAdminPaymentRecoveries: function (a) { return a.admin.getAdminPaymentRecoveries(); },
  // --- 日程変更・料金（BookingReschedule.gs） ---
  adminPreviewBookingReschedule: function (a) { return a.admin.adminPreviewBookingReschedule(BOOKING_ID, { date: jstDate(new Date(Date.now() + 40 * DAY)), startTime: '13:00', endTime: '15:00' }, ''); },
  adminRescheduleBooking: function (a) { return a.admin.adminRescheduleBooking(BOOKING_ID, { date: jstDate(new Date(Date.now() + 40 * DAY)), startTime: '13:00', endTime: '15:00' }, '', '理由', '', '', ''); },
  adminResendRescheduleMail: function (a) { return a.admin.adminResendRescheduleMail('00000000-none'); },
  adminGetBookingChanges: function (a) { return a.admin.adminGetBookingChanges(BOOKING_ID); },
  adminBackfillOriginalPrice: function (a) { return a.admin.adminBackfillOriginalPrice(BOOKING_ID, 'GENERAL', 5000, '確認メモ', 5000, 0); },
  adminRecordRescheduleFeeSettlement: function (a) { return a.admin.adminRecordRescheduleFeeSettlement(BOOKING_ID, 'chg-none', 'set-none', 'CONFIRMED_APPLIED', 5000, 0, ''); },
  adminResolveFeeRecovery: function (a) { return a.admin.adminResolveFeeRecovery(BOOKING_ID, { scheduleChangeCount: 0 }); },
  adminResolveBaselinePriceRecovery: function (a) { return a.admin.adminResolveBaselinePriceRecovery(BOOKING_ID, 'GENERAL', 5000, '確認メモ', 5000, 0); },
  // --- メニュー・スクリプトエディタから呼ぶ関数（BookingAdmin.gs・MembershipRecovery.gs・診断） ---
  confirmBooking: function (a) { return a.admin.confirmBooking(BOOKING_ID); },
  approveLargeParty: function (a) { return a.admin.approveLargeParty(BOOKING_ID); },
  rejectLargeParty: function (a) { return a.admin.rejectLargeParty(BOOKING_ID); },
  changeBookingPeople: function (a) { return a.admin.changeBookingPeople(BOOKING_ID, '3名'); },
  approvePhotoSupport: function (a) { return a.admin.approvePhotoSupport(BOOKING_ID, {}); },
  cancelBookingAdmin: function (a) { return a.admin.cancelBookingAdmin(BOOKING_ID); },
  cancelBookingWithRefund: function (a) { return a.admin.cancelBookingWithRefund(BOOKING_ID, { decision: 'FULL', reason: '返金理由' }); },
  reconcileBookingRefund: function (a) { return a.admin.reconcileBookingRefund(BOOKING_ID); },
  reconcileBookingCheckoutExpiry: function (a) { return a.admin.reconcileBookingCheckoutExpiry(BOOKING_ID); },
  resolveBookingPaymentRecovery: function (a) { return a.admin.resolveBookingPaymentRecovery(BOOKING_ID, '確認済み'); },
  reviveExpiredBooking: function (a) { return a.admin.reviveExpiredBooking(BOOKING_ID, realNow()); },
  updateBookingPrice: function (a) { return a.admin.updateBookingPrice(BOOKING_ID, 5000); },
  sendCardPaymentLinkMail: function (a) { return a.admin.sendCardPaymentLinkMail(BOOKING_ID, 'https://buy.stripe.com/test_synthetic', {}); },
  resolveCardPaymentLinkMetadataInconsistency: function (a) { return a.admin.resolveCardPaymentLinkMetadataInconsistency(BOOKING_ID, 0, 'https://buy.stripe.com/test_synthetic'); },
  sendPriceUpdateMail: function (a) { return a.admin.sendPriceUpdateMail(BOOKING_ID, {}); },
  recoverInitialMembershipPeriod: function (a) { return a.admin.recoverInitialMembershipPeriod({ memberId: 'MBR-none', subscriptionId: 'sub_none' }); },
  diagnoseReminderEligibility: function (a) { return a.admin.diagnoseReminderEligibility(BOOKING_ID, jstDate(new Date())); },
  previewReminderMail: function (a) { return a.admin.previewReminderMail(BOOKING_ID, {}); },
  sendReminderTestMail: function (a) { return a.admin.sendReminderTestMail(BOOKING_ID, jstDate(new Date())); },
  // --- メニューの「メール再送」（RESEND_MAIL_HANDLERS_。force: true） ---
  'menu:resend:PENDING': function (a) { return a.admin.BookingMailer.sendPendingMailForBooking(BOOKING_ID, { force: true }); },
  'menu:resend:CONFIRMED': function (a) { return a.admin.BookingMailer.sendConfirmedMailForBooking(BOOKING_ID, { force: true }); },
  'menu:resend:CANCELLED': function (a) { return a.admin.BookingMailer.sendCancelledMailForBooking(BOOKING_ID, { force: true }); },
  'menu:resend:REMINDER': function (a) { return a.admin.BookingMailer.sendReminderMailForBooking(BOOKING_ID, { force: true }); },
  'menu:resend:EXPIRED': function (a) { return a.admin.BookingMailer.sendExpiredMailForBooking(BOOKING_ID, { force: true }); },
  'menu:resend:PRICE_UPDATE': function (a) { return a.admin.BookingMailer.sendPriceUpdateMailForBooking(BOOKING_ID, { force: true }); },
  // --- 時間主導トリガー ---
  expirePendingBookings: function (a) { return a.admin.expirePendingBookings(NOW_ARG()); },
  sendNextDayReminders: function (a) { return a.admin.sendNextDayReminders(NOW_ARG()); },
  sendNextDayReminderCatchUp: function (a) { return a.admin.sendNextDayReminderCatchUp(NOW_ARG()); },
  processPendingStripeWebhookEvents: function (a) { return a.admin.processPendingStripeWebhookEvents(NOW_ARG()); }
};

/* 書き込みに届いた先を「シート名:開始列+列数」で要約する。 */
function summarizeWrites(ctx) {
  var seen = {};
  ctx.writeLog.forEach(function (w) { seen[w.sheet + ':' + w.col + '+' + w.cols] = true; });
  return Object.keys(seen).sort();
}

var MATRIX = {};

/* Bookingsへの書き込みを列名の範囲に直す（消去対象の個人情報の列に届くかを見るため）。 */
function bookingColumns(ctx, col, cols) {
  var names = ctx.headers.slice(col - 1, col - 1 + cols);
  return 'Bookings[' + names.join(',') + ']';
}

Object.keys(OPERATIONS).forEach(function (operation) {
  test('管理画面の操作 ' + operation + ': 消去対象の古い予約（4種類）に対して、消去を挟んでも個人情報は戻らず、書き込みは常にロック保持中', function () {
    Object.keys(KINDS).forEach(function (kind) {
      var result = null;
      var threw = null;
      var writes = {};
      var summary = H.interleaveAll(function () { return buildKind(kind); }, function (ctx) {
        ctx.resetWriteAudit();
        try { result = plain(OPERATIONS[operation](ctx)); } catch (e) { threw = String(e && e.message || e).slice(0, 80); }
        ctx.writeLog.forEach(function (w) {
          if (w.sheet === 'Bookings' && w.row === 1) return;
          var name = w.sheet === 'Bookings' ? bookingColumns(ctx, w.col, w.cols) : w.sheet + ':' + w.col + '+' + w.cols;
          writes[name] = true;
        });
      });
      MATRIX[operation + ' × ' + kind] = { stages: summary.stages, writes: Object.keys(writes).sort(), code: result && (result.error && result.error.code || (result.success === false ? 'FAILED' : result.success === true ? 'OK' : '')) || (threw ? 'THREW:' + threw : '') };
      assert.ok(summary.runs >= 1);
    });
  });
});

test('出力（任意）: RACE_MATRIX=1 のとき、操作×状態ごとの結果を出力する', function () {
  if (process.env.RACE_MATRIX) fs.writeFileSync(process.env.RACE_MATRIX, JSON.stringify(MATRIX, null, 1));
});


// ============================================================================
// 構造の固定: 操作の一覧と、古い行の書き込みに届く操作の一覧
// ============================================================================

/* 管理画面・メニュー・トリガーから呼べる公開関数のうち、表（OPERATIONS）に入れないもの。理由を付ける。 */
var EXCLUDED = {
  onOpen: 'メニューの登録（シートへ書かない）',
  addBookingAdminMenu: 'メニューの登録（シートへ書かない）',
  doGet: '管理画面の表示（読み取りのみ）',
  createNextDayReminderTrigger: 'トリガーの設定（シートへ書かない）',
  createNextDayReminderCatchUpTrigger: 'トリガーの設定（シートへ書かない）',
  createExpirePendingBookingsTrigger: 'トリガーの設定（シートへ書かない）',
  createProcessPendingStripeWebhookEventsTrigger: 'トリガーの設定（シートへ書かない）',
  migrateBookingsSchema: '見出し行の列追加のみ（行のデータは書かない）',
  purgeExpiredPersonalData: '消去本体（セル単位で空にする。別途検証済み）',
  dryRunPersonalDataRetention: '消去のdry-run（何も書かない）',
  enablePersonalDataRetention: '消去の有効化（設定のみ）',
  disablePersonalDataRetention: '消去の停止（設定のみ）',
  getPersonalDataRetentionStatus: '消去の状態確認（読み取りのみ）',
  addPersonalDataRetentionHold: '保留シートへの追記（個人情報を持たない）',
  resolvePersonalDataRetentionHold: '保留シートの解決日時（個人情報を持たない）',
  addPersonalDataRetentionMemberHold: '保留シートへの追記（個人情報を持たない）',
  resolvePersonalDataRetentionMemberHold: '保留シートの解決日時（個人情報を持たない）',
  createPersonalDataRetentionTrigger: 'トリガーの設定（シートへ書かない）',
  removePersonalDataRetentionTriggers: 'トリガーの削除（シートへ書かない）'
};

test('構造: Booking Admin の公開関数は、すべて操作の表か除外の表（理由つき）のどちらかに分類されている。増えたらここで落ちる', function () {
  var dir = path.join(__dirname, '..', 'gas', 'booking', 'admin');
  var found = [];
  fs.readdirSync(dir).forEach(function (file) {
    if (!/\.gs$/.test(file)) return;
    var text = fs.readFileSync(path.join(dir, file), 'utf8');
    (text.match(/^function [A-Za-z][A-Za-z0-9_]*/gm) || []).forEach(function (m) {
      var name = m.replace('function ', '');
      if (/_$/.test(name)) return;
      if (found.indexOf(name) === -1) found.push(name);
    });
  });
  var unclassified = found.filter(function (n) { return !Object.prototype.hasOwnProperty.call(OPERATIONS, n) && !Object.prototype.hasOwnProperty.call(EXCLUDED, n); });
  assert.deepStrictEqual(unclassified, [], '分類されていない公開関数（OPERATIONS か EXCLUDED に追加し、docs/personal-data-retention-writeback-race-690.md を更新すること）');
  var stale = Object.keys(OPERATIONS).concat(Object.keys(EXCLUDED)).filter(function (n) { return n.indexOf('menu:') !== 0 && found.indexOf(n) === -1; });
  assert.deepStrictEqual(stale, [], '存在しない関数が表に残っている');
  var topLevelOnly = Object.keys(OPERATIONS).filter(function (n) { return Object.prototype.hasOwnProperty.call(EXCLUDED, n); });
  assert.deepStrictEqual(topLevelOnly, [], '操作と除外の両方にある');
});

test('構造: メニューの「メール再送」の種別（RESEND_MAIL_HANDLERS_）は、すべて操作の表にある', function () {
  var text = fs.readFileSync(path.join(__dirname, '..', 'gas', 'booking', 'admin', 'BookingAdmin.gs'), 'utf8');
  var block = text.slice(text.indexOf('var RESEND_MAIL_HANDLERS_ = {'), text.indexOf('};', text.indexOf('var RESEND_MAIL_HANDLERS_ = {')));
  var types = (block.match(/^  [A-Z_]+:/gm) || []).map(function (t) { return t.trim().replace(':', ''); }).sort();
  var covered = Object.keys(OPERATIONS).filter(function (n) { return n.indexOf('menu:resend:') === 0; }).map(function (n) { return n.replace('menu:resend:', ''); }).sort();
  assert.deepStrictEqual(covered, types);
});

/* 古い（終端・180日超）行へ実際に書き込みに届く操作。それ以外は、状態・種別の条件で書き込みの手前で止まる（または読み取りのみ・新規作成のみ）。
   ここが変わった（既存の条件が外れて、別の操作が古い行へ書くようになった）場合は、その操作の書き込み先を確認して更新する。 */
var REACHES_WRITES_ON_OLD_ROWS = [
  'adminBackfillOriginalPrice', 'adminCancelBooking', 'adminCancelBookingWithRefund', 'adminChangeBookingPeople', 'adminResendReminderMail',
  'cancelBookingAdmin', 'cancelBookingWithRefund', 'changeBookingPeople'
];

test('構造: 古い行の書き込みに届く操作の一覧が、検証済みの一覧と一致する（個人情報の列を含む書き込みは、行を読み直す関数かこの操作自身の新しい値）', function () {
  var reaching = {};
  Object.keys(MATRIX).forEach(function (key) { if (MATRIX[key].writes.length > 0) reaching[key.split(' × ')[0]] = true; });
  var mailResend = Object.keys(reaching).filter(function (n) { return n.indexOf('menu:resend:') === 0; });
  assert.deepStrictEqual(Object.keys(reaching).filter(function (n) { return n.indexOf('menu:resend:') !== 0; }).sort(), REACHES_WRITES_ON_OLD_ROWS.slice().sort(), '書き込みに届く操作。メール再送: ' + mailResend.join(','));
});
