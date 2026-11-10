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
 *
 * Issue #872での変更点:
 * - 「利用日」行の直後に「利用時間: HH:mm〜HH:mm」行を追加し、予約台帳の確定済み
 *   record.startAt / record.endAt（Date値）から開始・終了時刻を表示する。時刻は
 *   BookingConfig.getMailConfig().timezone（Script Property TIMEZONE。既定Asia/Tokyo）基準で
 *   BookingAvailability.formatTimeInTimezone / formatDateInTimezoneにより整形し、GAS実行環境の
 *   ローカルtimezoneには依存しない。日跨ぎ（終了の暦日が開始と異なる）の場合は終了側に日付も付ける。
 * - startAt/endAtが欠損・不正・終了<=開始の場合は時刻を推測・補完せず「未取得（予約台帳で
 *   確認してください）」と表示し、Loggerに bookingId のみを記録する（PIIは出さない）。
 *   通知・予約作成自体は失敗させない。
 * - SNB / SNB mens / Studio Xはいずれも同じcreateBooking→notifyNewPendingBooking経路のため、
 *   この1か所の変更で3ブランドすべてに反映される。
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

  /*
   * 利用時間（開始〜終了）の表示値（Issue #872）。予約台帳の確定値（Date）のみを使い、
   * 欠損・不正・逆転時は架空の時刻を作らずnullを返す（呼び出し側で「未取得」表示）。
   * 日跨ぎ時は '23:00〜2026-11-11（水） 01:00' のように終了側へ日付を付ける。
   */
  function formatAdminTimeRange_(startAt, endAt, timezone) {
    if (!isDateLike_(startAt) || !isDateLike_(endAt)) return null;
    if (endAt.getTime() <= startAt.getTime()) return null;
    var start = BookingAvailability.formatTimeInTimezone(startAt, timezone);
    var end = BookingAvailability.formatTimeInTimezone(endAt, timezone);
    var startDate = BookingAvailability.formatDateInTimezone(startAt, timezone);
    var endDate = BookingAvailability.formatDateInTimezone(endAt, timezone);
    if (!start || !end || !startDate || !endDate) return null;
    if (endDate !== startDate) {
      return start + '〜' + BookingAvailability.formatDateWithWeekday(endDate) + ' ' + end;
    }
    return start + '〜' + end;
  }

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function resolveTimezone_() {
    var config = (typeof BookingConfig.getMailConfig === 'function') ? BookingConfig.getMailConfig() : null;
    return (config && config.timezone) || 'Asia/Tokyo';
  }

  /* Issue #869: 予約台帳の氏名をそのまま表示する。未取得・空白のみなら推測で補完せず「未登録」。 */
  function formatAdminCustomerName_(name) {
    var value = (name === null || name === undefined) ? '' : String(name).trim();
    return value || '未登録';
  }

  /*
   * options.autoConfirmByCheckout（Issue #709）: 呼び出し元（BookingRepository）が
   * 「Stripe Checkoutの決済完了Webhookで自動CONFIRMEDになる通常カード予約」と判定した場合のみtrue。
   * この場合は手動確定を案内せず、決済待ちで自動確定される旨を明示する。
   * 現地払い・承認制予約（作品撮り/大人数）・Checkout無効のカード予約はfalse/未指定で従来文面。
   *
   * Issue #869: 通常カード決済のPENDINGは決済処理中の短時間の内部状態で管理者対応も不要なため、
   * autoConfirm時は件名・本文から「仮予約」表現を除き「予約申し込み」とする（決済前なので「確定」とは
   * 断言しない）。手動確定・承認が必要なケースは従来の「仮予約」文面を維持する。
   * あわせて全ケースの本文に予約台帳の氏名（record.name）を載せる。件名・ログには出さず、
   * 連絡先（メール・電話）は追加しない。氏名が空なら推測せず「未登録」と表示する。
   */
  function notifyNewPendingBooking(record, options) {
    var adminEmail = BookingConfig.getAdminNotificationEmail();
    if (!adminEmail) return;

    var adminUrl = BookingConfig.getBookingAdminUrl();
    var autoConfirm = !!(options && options.autoConfirmByCheckout);
    var brandLabel = Booking.getBrandLabel(record.brand);
    var subject;
    var intro;
    if (autoConfirm) {
      subject = '[' + brandLabel + '] 予約申し込みを受け付けました: ' + record.bookingId;
      intro = '新しい予約申し込みがありました。クレジットカード決済処理中です。支払い完了後に自動確定されるため、管理者の操作は不要です。';
    } else {
      subject = '[' + brandLabel + '] 仮予約を受け付けました: ' + record.bookingId;
      intro = '新しい仮予約（PENDING）が届きました。' + (adminUrl
        ? '内容を確認し、問題なければBooking Adminから確定してください。'
        : '内容を確認し、問題なければSpreadsheetの管理メニューから確定してください。');
    }

    var lines = [
      intro,
      '',
      'bookingId: ' + record.bookingId,
      '予約者名：' + formatAdminCustomerName_(record.name),
      '利用日: ' + BookingAvailability.formatDateWithWeekday(record.date)
    ];
    /* Issue #872: 開始・終了時刻。取得できなければ推測せず「未取得」と明示し、欠損を検知可能にする。 */
    var timeRange = formatAdminTimeRange_(record.startAt, record.endAt, resolveTimezone_());
    if (timeRange) {
      lines.push('利用時間: ' + timeRange);
    } else {
      lines.push('利用時間: 未取得（予約台帳で確認してください）');
      Logger.log('AdminNotifier: startAt/endAtが未設定または不正なため利用時間を表示できません: ' + record.bookingId);
    }
    var priceLine = formatAdminPriceLine_(record.priceAmount);
    /* Issue #488: 通常料金か貸切ベースプランかを管理者通知でも識別できるようにする（通常予約は変更なし）。 */
    if (typeof BookingPricing !== 'undefined' && BookingPricing.planLabel(record.planCode)) lines.push('プラン: ' + BookingPricing.planLabel(record.planCode));
    if (priceLine) lines.push(priceLine);
    if (adminUrl) {
      lines.push('');
      lines.push('Booking Admin:');
      lines.push(adminUrl);
    }
    lines.push('');
    lines.push('※このメールにはお客様の連絡先は含めていません。詳細はSpreadsheet台帳（bookingIdで検索）を確認してください。');

    MailApp.sendEmail(adminEmail, subject, lines.join('\n'));
  }

  return {
    notifyNewPendingBooking: notifyNewPendingBooking
  };
})();
