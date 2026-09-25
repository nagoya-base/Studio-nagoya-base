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
 *
 * Issue #311での変更点:
 * - 利用日にBookingAvailability.formatDateWithWeekday（Availability.gs）で曜日を付ける。
 *   record.dateはタイムゾーン正規化済みの'YYYY-MM-DD'文字列のため、
 *   new Date(record.date).getDay()のようなGAS実行環境のローカルtimezoneに依存する
 *   変換は使わない。
 * - 本文から`Calendar Event ID`表示を削除する（calendarEventId自体の内部保持・
 *   Spreadsheet/Calendar連携ロジックは変更しない。この関数はメール本文を組み立てる
 *   だけで、record.calendarEventIdの値そのものには触れない）。
 * - BookingConfig.getBookingAdminUrl()（Booking Web App側のBOOKING_ADMIN_URL）が
 *   設定されている場合のみ、Booking Adminへのリンクを本文末尾に追加し、確認方法の案内も
 *   「Booking Adminから確定してください」に切り替える。未設定時は従来どおり
 *   Spreadsheetの管理メニューへの案内のまま据え置く。
 */
'use strict';

var AdminNotifier = (function () {
  /*
   * 利用料金の表示行（Issue #342）。record.priceAmountが数値化できない場合
   * （過去の予約データ等）は空文字を返し、joinNonEmptyLines_により行自体を出さない。
   * 利用者向け仮予約受付メール（BookingMailTemplates.buildPendingMail）と同じ値
   * （record.priceAmount）を使い、表示のずれを避ける（書式はここで独立して組み立てる。
   * BookingMailTemplates.gsはこのファイルに依存させない既存方針を保つ）。
   */
  function formatAdminPriceLine_(priceAmount) {
    /* Number('')/Number(null)は0になってしまうため、空文字・null・undefinedは
       先に弾く（過去の予約データを「0円」と誤表示しないため）。 */
    if (priceAmount === '' || priceAmount === null || priceAmount === undefined) return '';
    var value = Number(priceAmount);
    return Number.isFinite(value) ? '利用料金: ' + value.toLocaleString('ja-JP') + '円（税込）' : '';
  }

  function notifyNewPendingBooking(record) {
    var adminEmail = BookingConfig.getAdminNotificationEmail();
    if (!adminEmail) return;

    var adminUrl = BookingConfig.getBookingAdminUrl();
    var confirmInstruction = adminUrl
      ? '内容を確認し、問題なければBooking Adminから確定してください。'
      : '内容を確認し、問題なければSpreadsheetの管理メニューから確定してください。';

    var subject = '[' + Booking.getBrandLabel(record.brand) + '] 仮予約を受け付けました: ' + record.bookingId;
    var lines = [
      '新しい仮予約（PENDING）が届きました。' + confirmInstruction,
      '',
      'bookingId: ' + record.bookingId,
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date)
    ];
    var priceLine = formatAdminPriceLine_(record.priceAmount);
    if (priceLine) lines.push(priceLine);
    if (adminUrl) {
      lines.push('');
      lines.push('Booking Admin:');
      lines.push(adminUrl);
    }
    lines.push('');
    lines.push('※このメールにはお客様の氏名・連絡先は含めていません。詳細はSpreadsheet台帳（bookingIdで検索）を確認してください。');

    MailApp.sendEmail(adminEmail, subject, lines.join('\n'));
  }

  return {
    notifyNewPendingBooking: notifyNewPendingBooking
  };
})();
