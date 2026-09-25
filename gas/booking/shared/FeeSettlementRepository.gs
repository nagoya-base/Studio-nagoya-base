/*
 * FeeSettlementRepository.gs — 日程変更に伴う精算（入出金の記録）の冪等性台帳
 * （Issue #344追記。PR #345レビュー対応「recordFeeSettlementにLock・精算ID・精算履歴を
 * 追加」）。
 *
 * 「FeeSettlements」シートへ、精算リクエストを settlementId（呼び出し側が指定する
 * 冪等性キー）ごとに1行記録する。同一settlementIdの再送・二重クリック・通信エラー後の
 * 再実行で入金額・返金額を二重加算しないため、BookingReschedule.recordFeeSettlementは
 * 必ずこのリポジトリ経由で「既に同じIDで処理済みか」を確認してから実際の入出金を
 * Bookingsへ反映する。
 *
 * 状態遷移（applyStatus）:
 * - PENDING_APPLY: settlementId行を記録した直後、Bookingsへの反映がまだ完了していない。
 * - APPLIED: Bookingsへの反映が完了した（resultPaidAmount/resultRefundedAmountに
 *   反映後の累計額を記録する）。
 * - FAILED_NEEDS_RECOVERY: Bookingsへの反映に失敗した。この状態のまま同じsettlementIdで
 *   再送されても自動リトライはせず、Bookings側のfeeRecoveryRequiredAtと合わせて
 *   管理者の確認を要求する（「精算履歴と台帳の片方だけが更新された場合も復旧可能にする」
 *   要件への対応。この行が「入金/返金の意図はあったが、台帳へ反映されたかどうか
 *   確定できない」ことの証跡になる）。
 *
 * 同一settlementIdで既存行が見つかった場合の扱いはBookingReschedule.gs側の責務
 * （このリポジトリはCRUDのみを提供する）:
 * - 既存行の内容（bookingId/changeId/settlementState/paidDelta/refundedDelta）が
 *   今回のリクエストと完全一致 → 安全な再送とみなし、既存行の結果をそのまま返す。
 * - 内容が異なる → 拒否する（同じIDを異なる金額で使い回すことを防ぐ）。
 */
'use strict';

var FeeSettlementRepository = (function () {
  var SHEET_NAME_ = 'FeeSettlements';
  var HEADERS_ = [
    'settlementId', 'bookingId', 'changeId', 'settlementState',
    'paidDelta', 'refundedDelta', 'note', 'requestedAt',
    'applyStatus', 'appliedAt', 'resultPaidAmount', 'resultRefundedAmount'
  ];

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  function ensureSheet_() {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME_);
    if (sheet.getLastRow() < 1) sheet.appendRow(HEADERS_);
    return sheet;
  }

  function rowToRecord_(row) {
    var record = {};
    HEADERS_.forEach(function (header, index) { record[header] = row[index]; });
    return record;
  }

  /* settlementIdで1行検索する。見つからなければnull。 */
  function findBySettlementId(settlementId) {
    var sheet = ensureSheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === settlementId) {
        return { rowNumber: i + 1, record: rowToRecord_(values[i]) };
      }
    }
    return null;
  }

  /*
   * 新規リクエストをapplyStatus='PENDING_APPLY'で記録する。呼び出し側は事前に
   * findBySettlementIdで重複が無いことを確認済みであること（このリポジトリ自体は
   * 重複チェックをしない。並行実行の排他はBookingReschedule.gs側のLockService
   * .getScriptLock()が担う）。
   * record: { settlementId, bookingId, changeId, settlementState, paidDelta, refundedDelta, note }
   * 戻り値: 追加した行番号。
   */
  function appendPending(record) {
    var sheet = ensureSheet_();
    sheet.appendRow([
      record.settlementId, record.bookingId, record.changeId || '', record.settlementState,
      record.paidDelta, record.refundedDelta, record.note || '', new Date(),
      'PENDING_APPLY', '', '', ''
    ]);
    return sheet.getLastRow();
  }

  /* Bookingsへの反映が完了した後に呼ぶ。applyStatus/appliedAt/resultPaidAmount/
     resultRefundedAmountの4列（HEADERS_上で連続）を1回のsetValuesで更新する。 */
  function markApplied(rowNumber, resultPaidAmount, resultRefundedAmount) {
    var sheet = ensureSheet_();
    var startIndex = HEADERS_.indexOf('applyStatus');
    sheet.getRange(rowNumber, startIndex + 1, 1, 4)
      .setValues([['APPLIED', new Date(), resultPaidAmount, resultRefundedAmount]]);
  }

  /* Bookingsへの反映に失敗した場合に呼ぶ。resultPaidAmount/resultRefundedAmountは
     空のまま（反映できていないことを示す）。 */
  function markFailedNeedsRecovery(rowNumber) {
    var sheet = ensureSheet_();
    var startIndex = HEADERS_.indexOf('applyStatus');
    sheet.getRange(rowNumber, startIndex + 1, 1, 4).setValues([['FAILED_NEEDS_RECOVERY', '', '', '']]);
  }

  return {
    findBySettlementId: findBySettlementId,
    appendPending: appendPending,
    markApplied: markApplied,
    markFailedNeedsRecovery: markFailedNeedsRecovery
  };
})();
