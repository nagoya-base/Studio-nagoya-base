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

  return {
    HEADERS: HEADERS_,
    recordFailure: recordFailure,
    listAll: listAll
  };
})();
