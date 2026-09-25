/*
 * RecoveryRepository.gs — 部分失敗・不整合の記録先（Issue #268）。
 *
 * 「ログを残すだけで終わらせない」ため、Loggerだけでなく専用Spreadsheetの
 * 「Recovery」シートへ、補償対象を人が確認できる形で記録する。
 *
 * このシートの status / recoveryState は運用者が手動調査・記録するための
 * 補助情報であり、Bookings台帳のstatus（正式な予約状態）とは別物。
 * ここへ書く分には「statusセルの直接編集を正式運用にしない」という
 * Bookings側の制約は適用されない（そもそもBookingsシートではない）。
 */
'use strict';

var RecoveryRepository = (function () {
  var SHEET_NAME_ = 'Recovery';

  var HEADERS_ = [
    'bookingId',
    'failureType',
    'occurredAt',
    'calendarEventId',
    'status',
    'errorMessage',
    'recoveryState',
    'resolvedAt'
  ];

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  function ensureRecoverySheet_() {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_NAME_);
    }
    if (sheet.getLastRow() < 1) {
      sheet.appendRow(HEADERS_);
    }
    return sheet;
  }

  function recordToRow_(record) {
    return HEADERS_.map(function (header) {
      return record[header] !== undefined && record[header] !== null ? record[header] : '';
    });
  }

  function rowToRecord_(row) {
    var record = {};
    HEADERS_.forEach(function (header, index) {
      record[header] = row[index];
    });
    return record;
  }

  /*
   * record: { bookingId, failureType, occurredAt, calendarEventId, status, errorMessage,
   *           recoveryState, resolvedAt }
   * failureTypeの例:
   * - CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE: Calendar作成成功→Sheets保存失敗→Calendar補償削除成功
   * - SHEETS_FAILURE_CALENDAR_ORPHANED: 同上でCalendar補償削除も失敗（要手動対応）
   * - EXPIRE_CALENDAR_DELETE_FAILED: TTL失効時のCalendarイベント削除に失敗
   * - CONFIRM_CALENDAR_EVENT_MISSING: confirmBooking時に対応するCalendarイベントが見つからない
   * - ADMIN_NOTIFICATION_FAILED: 管理者通知の送信に失敗（予約自体は成功のまま）
   * - CANCEL_CALENDAR_EVENT_MISSING（Issue #272）: cancelBookingAdmin時にCalendarイベントが
   *   既に存在しなかった（SheetsはCANCELLEDへ収束させる）
   * - CANCEL_CALENDAR_DELETE_FAILED（Issue #272）: cancelBookingAdmin時のCalendarイベント削除が失敗
   *   （Sheetsは元statusのまま進めない）
   * - CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED（Issue #272）: Calendar削除成功→Sheets側の
   *   CANCELLED更新が失敗（要手動対応。再実行すればCalendar既に無い経路から収束できる）
   * - CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT（Issue #272）: Sheets行が無いがCalendarに
   *   bookingIdタグ一致イベントが1件見つかった（Calendarは自動削除しない）
   * - CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND（Issue #272）: 同上でCalendarに複数件見つかった
   * - CANCEL_BOOKING_NOT_FOUND（Issue #272）: Sheets行が無く、Calendarにも該当イベントが
   *   見つからない（またはbookingId形式が不正で診断自体をスキップした）
   * - CANCEL_CALENDAR_LOOKUP_FAILED（Issue #272 PRレビュー対応）: cancelBookingAdmin時に
   *   CalendarRepository.getEventById自体が例外を投げた（イベントが無いのではなく、
   *   CALENDAR_ID不正・Calendarアクセス障害等。Sheets/Calendarとも変更しない）
   * - CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED（Issue #272 PRレビュー対応）: Sheets行が
   *   無い場合の診断中にCalendarRepository.findBookingEventsByBookingId自体が例外を
   *   投げた（診断そのものが失敗。Calendarは変更しない）
   * - REVIVE_CALENDAR_CREATE_FAILED（Issue #334）: reviveExpiredBooking時にCalendarイベントの
   *   新規作成自体が失敗した（イベント未作成のため補償対象は無い。Sheetsは変更せずEXPIREDのまま）
   * - REVIVE_CALENDAR_STATUS_FAILED_ROLLED_BACK（Issue #334 PRレビュー対応）:
   *   reviveExpiredBooking時にCalendarイベントは新規作成できたが、CONFIRMEDへのsetEventStatusが
   *   失敗→補償削除に成功（Sheetsは一切更新せずEXPIREDのまま）
   * - REVIVE_CALENDAR_STATUS_FAILED_ORPHANED（Issue #334 PRレビュー対応）: 同上で補償削除も
   *   失敗（PENDINGタイトル/タグのままのCalendarイベントが孤立して残る。要手動対応。
   *   Sheetsは一切更新せずEXPIREDのまま）
   * - CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE / SHEETS_FAILURE_CALENDAR_ORPHANED は
   *   reviveExpiredBookingのCalendar成功→Sheets失敗（setEventStatus成功後の段階）でも
   *   同じ意味で再利用する（上記のcreateBookingと共通のfailureType。詳細は
   *   BookingRepository.gsのhandleReviveSheetsUpdateFailure_参照）
   */
  function recordFailure(record) {
    var sheet = ensureRecoverySheet_();
    sheet.appendRow(recordToRow_(record));
  }

  function listAll() {
    var sheet = ensureRecoverySheet_();
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      result.push(rowToRecord_(values[i]));
    }
    return result;
  }

  /*
   * PR #345再レビュー対応（8回目）: BookingReschedule.backfillOriginalPriceが基準料金
   * （priceAmount等5列）の書込み結果を確認できなかった場合の、予約別の永続的な停止条件。
   * feeRecoveryRequiredAt（Bookings側）の保存自体が失敗しても、こちらのRecoveryシートへの
   * 記録が成功していれば、次回以降のbackfillOriginalPrice/commit/recordFeeSettlementを
   * 引き続きブロックできる（isBlockedForFeeRecovery_参照）。既存のHEADERS_・recordFailure
   * をそのまま使い、failureTypeにBASELINE_WRITE_UNCERTAIN_FAILURE_TYPEを指定した行を
   * OPEN/RESOLVEDで管理する。
   */
  var BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE = 'BASELINE_WRITE_UNCERTAIN';

  function hasOpenBaselineRecovery(bookingId) {
    var sheet = ensureRecoverySheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.bookingId === bookingId &&
          record.failureType === BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE &&
          record.recoveryState === 'OPEN') {
        return true;
      }
    }
    return false;
  }

  /*
   * 管理者が基準料金5列を確認・再保存し、検証にも成功した後にのみ呼ぶこと
   * （BookingReschedule.resolveBaselinePriceRecovery参照）。この予約のOPENな
   * BASELINE_WRITE_UNCERTAIN行をすべてRESOLVEDにする（複数回の複合障害でOPENが
   * 複数残っていた場合も、基準料金自体は1つの正しい値に確定しているため全件解消してよい）。
   */
  function resolveBaselineRecovery(bookingId) {
    var sheet = ensureRecoverySheet_();
    var values = sheet.getDataRange().getValues();
    var recoveryStateIndex = HEADERS_.indexOf('recoveryState');
    var resolvedAtIndex = HEADERS_.indexOf('resolvedAt');
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.bookingId === bookingId &&
          record.failureType === BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE &&
          record.recoveryState === 'OPEN') {
        sheet.getRange(i + 1, recoveryStateIndex + 1, 1, 1).setValues([['RESOLVED']]);
        sheet.getRange(i + 1, resolvedAtIndex + 1, 1, 1).setValues([[new Date()]]);
      }
    }
  }

  /*
   * PR #345再レビュー対応（完了条件C）: 基準料金の確認根拠（BASELINE_PRICE_CONFIRMED）の
   * 監査行が実際に保存されたかを読み戻して確認する。appendRowの応答は信頼せず、
   * bookingId・failureType・errorMessage（確認時刻を含む一意な文字列）の完全一致で判定する。
   */
  function hasRecord(bookingId, failureType, errorMessage) {
    var sheet = ensureRecoverySheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.bookingId === bookingId &&
          record.failureType === failureType &&
          record.errorMessage === errorMessage) {
        return true;
      }
    }
    return false;
  }

  return {
    HEADERS: HEADERS_,
    hasRecord: hasRecord,
    recordFailure: recordFailure,
    listAll: listAll,
    BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE: BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE,
    hasOpenBaselineRecovery: hasOpenBaselineRecovery,
    resolveBaselineRecovery: resolveBaselineRecovery
  };
})();
