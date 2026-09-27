/*
 * BookingAdminAlerts.gs — Booking Adminプロジェクトから管理者へ送る要対応通知
 * （Issue #341 PR-D）。
 *
 * 既存のAdminNotifier.gs（公開Booking Web Appプロジェクト専用。新規仮予約の通知）は
 * createBooking時にしか動かないため、Booking Admin側で発生する次の事象はこのファイルから
 * 通知する:
 * - Stripe決済による予約の自動確定（鍵承認ゲート対象の予約のみ。「鍵承認待ち」）
 * - 前日リマインドの時点で鍵承認が無く、利用者への来場案内をスキップした予約
 * - 返金の失敗・結果不明など、管理者の確認が必要な返金の状態
 *
 * 宛先・リンクはBooking AdminプロジェクトのScript Properties
 * （ADMIN_NOTIFICATION_EMAIL / BOOKING_ADMIN_URL。いずれも既存のキー名。Booking Web App側と
 * 同じ値をBooking Admin側にも設定する。README参照）。ADMIN_NOTIFICATION_EMAILが未設定なら
 * 何もしない（通知は任意機能。予約・返金の処理自体は失敗させない）。
 *
 * 本文には予約ID・利用日・状態コードのみを含め、氏名・連絡先・鍵情報・Stripeの秘密値は
 * 含めない（AdminNotifier.gsと同じ方針）。すべてbest effortで、例外は呼び出し元へ投げない。
 */
'use strict';

var BookingAdminAlerts = (function () {
  function adminUrlLines_() {
    var adminUrl = BookingConfig.getBookingAdminUrl();
    return adminUrl ? ['', 'Booking Admin:', adminUrl] : [];
  }

  function send_(subject, lines) {
    try {
      var adminEmail = BookingConfig.getAdminNotificationEmail();
      if (!adminEmail) return { sent: false, reason: 'NOT_CONFIGURED' };
      MailApp.sendEmail(adminEmail, subject, lines.concat(adminUrlLines_()).join('\n'));
      return { sent: true };
    } catch (error) {
      Logger.log('BookingAdminAlerts: 管理者通知の送信に失敗しました: ' + BookingMailer.sanitizeErrorMessage(String((error && error.message) || error)));
      return { sent: false, reason: 'SEND_FAILED' };
    }
  }

  function formatDate_(value) {
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var dateString = value && typeof value.getTime === 'function'
      ? BookingAvailability.formatDateInTimezone(value, timezone)
      : String(value || '');
    return BookingAvailability.formatDateWithWeekday(dateString) || dateString;
  }

  /* Stripe決済による自動確定（新規確定時のみ呼ぶ）。鍵承認ゲートの対象予約だけに送る。 */
  function notifyAccessApprovalPending(record) {
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    if (!record || !Booking.requiresAccessApproval(record, timezone)) return { sent: false, reason: 'NOT_REQUIRED' };
    return send_('[' + Booking.getBrandLabel(record.brand) + '] カード決済で予約が確定しました（鍵承認待ち）: ' + record.bookingId, [
      'Stripeでの決済完了を確認し、予約を自動確定しました。',
      '内容を確認し、問題なければBooking Adminで「鍵承認」を行ってください。',
      '鍵承認が無い間は、前日リマインド（鍵情報を含む来場案内）は送信されません。',
      '問題がある場合は「取消・返金」から取り消してください。',
      '',
      'bookingId: ' + record.bookingId,
      '利用日: ' + formatDate_(record.date)
    ]);
  }

  /* 前日リマインドの時点で鍵承認が無く、利用者への送信をスキップした予約の一覧。 */
  function notifyUnapprovedAccessForTomorrow(dateString, bookingIds) {
    if (!bookingIds || bookingIds.length === 0) return { sent: false, reason: 'NO_TARGETS' };
    return send_('【要対応】明日利用・鍵未承認の予約があります（' + bookingIds.length + '件）', [
      '明日（' + formatDate_(dateString) + '）利用のカード決済予約のうち、鍵承認が無いため',
      '前日リマインド（鍵情報を含む来場案内）を送信しなかった予約があります。',
      '内容を確認し、Booking Adminで「鍵承認」→「来場案内を再送」を行うか、「取消・返金」を行ってください。',
      '',
      bookingIds.map(function (id) { return 'bookingId: ' + id; }).join('\n')
    ]);
  }

  /* 返金の失敗・結果不明・台帳不整合など、管理者の確認が必要な返金の状態。 */
  function notifyRefundNeedsAttention(bookingId, code, message) {
    return send_('【要対応】返金処理の確認が必要です: ' + bookingId, [
      '返金処理で管理者の確認が必要な状態になりました。返金完了とは限りません。',
      'Booking Adminの予約詳細で決済・返金の状態を確認し、「返金状態を照会」または対応を行ってください。',
      '',
      'bookingId: ' + bookingId,
      '状態: ' + code,
      '内容: ' + BookingMailer.sanitizeErrorMessage(message || '')
    ]);
  }

  return {
    notifyAccessApprovalPending: notifyAccessApprovalPending,
    notifyUnapprovedAccessForTomorrow: notifyUnapprovedAccessForTomorrow,
    notifyRefundNeedsAttention: notifyRefundNeedsAttention
  };
})();
