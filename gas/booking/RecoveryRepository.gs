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
