/*
 * BookingReminderTriggers.gs — 前日リマインド + 来場案内の時間主導トリガー（Issue #271）。
 *
 * 【重要・デプロイ先について】BookingAdmin.gs / BookingTriggers.gsと同じBooking Admin
 * プロジェクト（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）へデプロイする。
 * Web App本体（スタンドアロン）へはデプロイしない。
 *
 * 本PRでは本番の時間主導トリガー作成そのものは必須にしない
 * （createNextDayReminderTrigger()はBooking Adminプロジェクトのスクリプトエディタから
 * 一度だけ手動実行すればトリガーを作成できる補助関数。README.md参照）。
 */
'use strict';

/* instanceof Dateではなくダックタイピングで判定する（他ファイルのisDateLike_と同じ方針）。 */
function isReminderNowDateLike_(value) {
  return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
}

/*
 * baseDateの「翌日」をtimezone基準の'YYYY-MM-DD'へ変換する（Issue #330で共通化）。
 * 元はsendNextDayReminders内にインライン実装していた翌日日付計算そのもの
 * （baseDateへ24時間加算してformatDateInTimezoneするだけ）。本番の自動送信
 * （sendNextDayReminders）と、Booking Admin診断（BookingReminderDiagnostics.gsの
 * diagnoseReminderEligibility等。管理者が指定した「基準日（今日扱い）」から翌日を
 * 求める）の両方がこの関数だけを呼び、翌日計算ロジックを複製しない。
 * timezoneが不正でIntlが解釈できない場合はnullを返す（呼び出し側でfail-closedに扱う）。
 */
function computeNextDayDateString_(baseDate, timezone) {
  var nextDay = new Date(baseDate.getTime() + 24 * 3600000);
  return BookingAvailability.formatDateInTimezone(nextDay, timezone);
}

/*
 * 正式関数: sendNextDayReminders(now)（Issue #271本文どおりのグローバル関数名）。
 * now引数は省略可能（本番の時間主導トリガーからは常に引数なしで呼ばれる。テストコードから
 * 受付時刻を固定して「翌日」を検証できるようにするため、Booking.gs/BookingRepository.gsの
 * now引数と同じ方針を踏襲する）。
 *
 * 処理:
 *   1. nowをBookingConfigのTIMEZONE基準の「今日」に変換
 *   2. 翌日のYYYY-MM-DDを計算
 *   3. SpreadsheetRepository.getConfirmedBookingsForDateで翌日のCONFIRMED予約を取得
 *   4. 1件ずつBookingMailer.sendReminderMailForBookingへ委譲（内部で最新status/SentAtを再確認）
 *   5. 1件失敗しても残りの予約の処理を継続する（バッチ内の障害分離）
 *
 * ブランド（snb/mens/studio_x）で抽出ロジック・送信ロジックを分岐させない。
 */
function sendNextDayReminders(now) {
  now = isReminderNowDateLike_(now) ? now : new Date();

  var timezone = BookingConfig.getAvailabilityConfig().timezone;
  var tomorrowDateString = computeNextDayDateString_(now, timezone);

  var summary = { processedCount: 0, sentCount: 0, skippedCount: 0, failedCount: 0 };

  if (!tomorrowDateString) {
    Logger.log('sendNextDayReminders: timezone設定が不正なため翌日を計算できませんでした。');
    return summary;
  }

  var candidates = SpreadsheetRepository.getConfirmedBookingsForDate(tomorrowDateString);

  candidates.forEach(function (item) {
    summary.processedCount++;
    try {
      var result = BookingMailer.sendReminderMailForBooking(item.record.bookingId);
      if (!result.success) {
        summary.failedCount++;
        /*
         * PRレビュー対応: JSON.stringify(result.error)はresult.error.messageに
         * MailApp/Gmail側の生の例外メッセージ（利用者メールアドレス等を含み得る）を
         * そのまま含むため、Loggerにはbooking Id・error.codeのみを残す
         * （利用者メールアドレス・解錠コード・キーボックス番号・メール本文は残さない）。
         */
        Logger.log('sendNextDayReminders: 送信失敗 ' + item.record.bookingId + ' code=' + (result.error && result.error.code));
      } else if (result.skipped) {
        summary.skippedCount++;
      } else {
        summary.sentCount++;
      }
    } catch (unexpectedError) {
      /* buildTemplateFn内の想定外の例外等でここまで届いた場合も、他の候補の処理を
         止めない（Issue #271「1件失敗しても残りの予約送信を継続する」）。
         例外messageをそのまま出さず、BookingMailer.sanitizeErrorMessageでメール
         アドレスをredactしてから記録する（PRレビュー対応）。 */
      summary.failedCount++;
      Logger.log(
        'sendNextDayReminders: 予期しない例外 ' +
          item.record.bookingId +
          ': ' +
          BookingMailer.sanitizeErrorMessage(unexpectedError && unexpectedError.message)
      );
    }
  });

  return summary;
}

/* GASエディタから手動で一度だけ実行するための補助関数（README.md参照）。
   毎日18時台に1回 sendNextDayReminders を実行するトリガーを作成する。
   GASの時間主導トリガーは分単位の完全一致を保証しないため、「18:00ちょうど」を
   業務要件にはしない（README「18時台に1回」と明記する）。 */
function createNextDayReminderTrigger() {
  var FUNCTION_NAME = 'sendNextDayReminders';
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === FUNCTION_NAME;
  });
  if (existing.length > 0) {
    Logger.log('トリガーは既に存在します: ' + FUNCTION_NAME);
    return existing[0];
  }
  return ScriptApp.newTrigger(FUNCTION_NAME).timeBased().everyDays(1).atHour(18).create();
}
