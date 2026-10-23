/*
 * BookingAdminAlerts.gs — Booking Adminプロジェクトから管理者へ送る要対応通知
 * （Issue #341 PR-D）。
 *
 * 既存のAdminNotifier.gs（公開Booking Web Appプロジェクト専用。新規仮予約の通知）は
 * createBooking時にしか動かないため、Booking Admin側で発生する次の事象はこのファイルから
 * 通知する:
 * - 前日リマインドの時点で決済未確定・Recovery未解消等で、利用者への来場案内をスキップした予約
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

  /* 前日リマインドの時点で決済未確定・Recovery未解消のため、利用者への送信をスキップした予約の一覧。 */
  function notifyAccessGuideBlockedForTomorrow(dateString, bookingIds) {
    if (!bookingIds || bookingIds.length === 0) return { sent: false, reason: 'NO_TARGETS' };
    return send_('【要対応】明日利用・来場案内を送信できなかった予約があります（' + bookingIds.length + '件）', [
      '明日（' + formatDate_(dateString) + '）利用のカード決済予約のうち、決済が未確定、または決済の要対応（Recovery）が',
      '未解消のため、前日リマインド（鍵情報を含む来場案内）を送信しなかった予約があります。',
      'Booking Adminで決済状態を確認し、解消後に「来場案内を再送」を行うか、「取消・返金」を行ってください。',
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

  /*
   * PR-Dレビュー対応・1回目: 入金は成立したが予約を確定できなかった（取消済み・失効済み等への
   * 遅延入金を含む）。予約は復活させずRecoveryで管理されるため、管理者が入金の事実を認識し、
   * 返金方針を判断できるよう通知する。
   */
  function notifyPaidBookingNotConfirmed(bookingId, bookingStatus, reasonCode) {
    return send_('【要対応】入金済みですが予約を確定できませんでした: ' + bookingId, [
      'Stripeでの入金を確認しましたが、予約は' + (bookingStatus || '不明') + 'のため自動確定しませんでした（予約は復活させていません）。',
      '入金は台帳へ記録済みです。Booking Adminの「決済要対応」から予約詳細を開き、',
      '「取消・返金」で返金方針（全額／一部／返金なし）を判断してください。取消時点の判断は、この入金には適用されません。',
      '',
      'bookingId: ' + bookingId,
      '状態: ' + (reasonCode || '')
    ]);
  }

  return {
    notifyPaidBookingNotConfirmed: notifyPaidBookingNotConfirmed,
    notifyAccessGuideBlockedForTomorrow: notifyAccessGuideBlockedForTomorrow,
    notifyRefundNeedsAttention: notifyRefundNeedsAttention
  };
})();
