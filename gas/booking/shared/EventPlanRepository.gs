/*
 * EventPlanRepository.gs — イベント開催日限定プラン（Issue #488）の対象日台帳。
 *
 * 共有Spreadsheetのシート`EventPlanDates`（列: planCode, date, note）に「このプランを販売する日」を
 * 1行1日で置く。管理者がシートへ行を追加・削除するだけで対象日を都度設定でき、特定イベント名・
 * 日付を料金ロジックへ恒久的にハードコードしない。Booking Web App / Booking Adminは同じ
 * SPREADSHEET_IDを読むため、Script Propertiesと違い2プロジェクトで二重設定にならない
 * （予約作成・見積り・日程変更のどこでも同じ対象日で判定できる）。
 *
 * fail-closed: シートが無い・読めない・日付形式が不正な行はすべて「対象日ではない」として扱う。
 * 読み取りだけを担当し、販売可否の最終判定は呼び出し側（BookingPricing.computeBookingPriceが
 * eventDatesを必須入力として検証する）。
 */
'use strict';

var EventPlanRepository = (function () {
  var SHEET_NAME_ = 'EventPlanDates';
  var HEADERS_ = ['planCode', 'date', 'note'];
  var DATE_PATTERN_ = /^\d{4}-\d{2}-\d{2}$/;

  function normalizeDateCell_(value) {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) return '';
      return Utilities.formatDate(value, BookingConfig.getAvailabilityConfig().timezone, 'yyyy-MM-dd');
    }
    var text = String(value === undefined || value === null ? '' : value).trim();
    return DATE_PATTERN_.test(text) ? text : '';
  }

  /* シートが無ければヘッダー付きで作る（管理者が行を追加できるようにする）。 */
  function ensureSheet_() {
    var spreadsheet = SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
    var sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME_);
    if (sheet.getLastRow() < 1) sheet.appendRow(HEADERS_);
    return sheet;
  }

  /*
   * planCodeの対象日（'YYYY-MM-DD'の昇順・重複なし）。読み取りに失敗した場合は空配列
   * （＝どの日も販売しない）を返し、例外は呼び出し側へ出さない。
   */
  function listEligibleDates(planCode) {
    try {
      var values = ensureSheet_().getDataRange().getValues();
      var seen = {};
      var dates = [];
      for (var i = 1; i < values.length; i++) {
        if (String(values[i][0]).trim() !== planCode) continue;
        var date = normalizeDateCell_(values[i][1]);
        if (date && !seen[date]) {
          seen[date] = true;
          dates.push(date);
        }
      }
      return dates.sort();
    } catch (readError) {
      Logger.log('EventPlanRepository: 対象日を読み取れないため、対象日なしとして扱います');
      return [];
    }
  }

  return {
    SHEET_NAME: SHEET_NAME_,
    listEligibleDates: listEligibleDates
  };
})();
