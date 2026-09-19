/*
 * AdminNotifier.gs — 管理者向けの最低限の通知フック（Issue #268）。
 *
 * #271（利用者向けメール: 仮予約受付・確定・キャンセル・前日リマインド・来場案内）は
 * このIssueの対象外。ここで送るのは「新しい仮予約が入ったことを管理者へ知らせる」
 * 内部向け通知のみ。
 *
 * ADMIN_NOTIFICATION_EMAILが未設定の場合は何もしない（通知は任意機能であり、
 * 未設定でもcreateBooking自体は失敗させない）。
 *
 * この関数はBookingRepository.createBookingからLock解放後・かつtry/catchで
 * 包まれた状態で呼ばれる。ここで例外を投げても予約自体はロールバックされない
 * （通知失敗を予約失敗として扱わない、というIssue #268の要件を満たすための設計）。
 */
'use strict';

var AdminNotifier = (function () {
  function notifyNewPendingBooking(record) {
    var adminEmail = BookingConfig.getAdminNotificationEmail();
    if (!adminEmail) return;

    var subject = '[' + Booking.getBrandLabel(record.brand) + '] 仮予約を受け付けました: ' + record.bookingId;
    var body = [
      '新しい仮予約（PENDING）が届きました。内容を確認し、問題なければSpreadsheetの管理メニューから確定してください。',
      '',
      'bookingId: ' + record.bookingId,
      '利用日: ' + record.date,
      'Calendar Event ID: ' + record.calendarEventId,
      '',
      '※このメールにはお客様の氏名・連絡先は含めていません。詳細はSpreadsheet台帳（bookingIdで検索）を確認してください。'
    ].join('\n');

    MailApp.sendEmail(adminEmail, subject, body);
  }

  return {
    notifyNewPendingBooking: notifyNewPendingBooking
  };
})();
