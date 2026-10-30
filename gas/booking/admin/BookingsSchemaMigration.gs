/*
 * BookingsSchemaMigration.gs — Bookingsシートのschema migration（Issue #673。管理者がエディタから手動実行）。
 *
 * 【重要・デプロイ先について】Booking Admin専用。Booking Web App（匿名アクセス）・Webhookへは配布しない
 * （shared/ではなくadmin/に置く理由）。GitHub ActionsからSheets APIでmigrationする方式（Issue #671）は
 * 組織ポリシーでサービスアカウント鍵を作れないため廃止し、Apps Scriptが既に持つSpreadsheet権限だけで
 * 運用者が `migrateBookingsSchema` をApps Scriptエディタから1回実行する。実行手順はREADME.md参照。
 *
 * ヘッダー定義の正本は shared/BookingsSchema.gs だけ（ここへ列名を複製しない）。
 *
 * 安全条件:
 * - 既存の1行目が正本の「完全な先頭部分」と一致するときだけ、不足している末尾の列を追加する。
 * - 完全一致なら何も書かず成功（no-op）。何度実行しても結果は同じ。
 * - 次の場合は一切書き換えず固定コードで失敗する（fail closed）: Bookingsシートなし／ヘッダー行が空／
 *   途中欠落・順序違い・不明な列／正本より長いヘッダー／書込み後の再取得が正本と不一致／アクセス・書込み失敗。
 * - 変更するのは Bookings シートの1行目の不足セルと、必要な場合のグリッド列数の拡張だけ。
 *   2行目以降の予約値・他のシートには触れない。列の削除・移動・途中挿入・既存ヘッダーの上書きはしない。
 * - ログ・エラーに出すのは固定コードと追加列数だけ（Spreadsheet ID・シート内容・予約者情報は出さない）。
 */
'use strict';

var BookingsSchemaMigration = (function () {
  var ERROR_NAME_ = 'BookingsSchemaMigrationError';
  var RESULT_OK_ = 'BOOKINGS_SCHEMA_MIGRATION_OK';
  var RESULT_CURRENT_ = 'BOOKINGS_SCHEMA_ALREADY_CURRENT';
  var CODE_FAILED_ = 'BOOKINGS_SCHEMA_MIGRATION_FAILED';
  var CODE_UNEXPECTED_ = 'ACCESS_OR_WRITE_FAILED';

  function fail_(code) {
    var error = new Error(code);
    error.name = ERROR_NAME_;
    error.code = code;
    throw error;
  }

  /* 末尾の空セルは「無い」ものとして扱う。セルは文字列として比較する（数値等は文字列化して不一致になる）。 */
  function normalizeRow_(row) {
    var cells = (row || []).map(function (cell) {
      return cell === null || cell === undefined ? '' : String(cell);
    });
    var end = cells.length;
    while (end > 0 && cells[end - 1] === '') end--;
    return cells.slice(0, end);
  }

  function matchesExactly_(actual, expected) {
    return actual.length === expected.length && actual.every(function (cell, index) {
      return cell === expected[index];
    });
  }

  /*
   * 既存ヘッダーと正本を比較し、末尾へ追加すべき列を返す純粋関数。
   * 既存ヘッダーが正本の先頭部分と完全一致している場合だけ成功する。
   */
  function plan(actualRow, expectedHeaders) {
    var actual = normalizeRow_(actualRow);
    if (actual.length === 0) fail_('HEADER_ROW_EMPTY');
    if (actual.length > expectedHeaders.length) fail_('HEADER_LONGER_THAN_SCHEMA');
    for (var i = 0; i < actual.length; i++) {
      if (actual[i] !== expectedHeaders[i]) fail_('HEADER_MISMATCH');
    }
    return { startIndex: actual.length, missing: expectedHeaders.slice(actual.length) };
  }

  function readHeader_(sheet) {
    var width = Math.max(sheet.getLastColumn(), 1);
    return sheet.getRange(1, 1, 1, width).getValues()[0];
  }

  /* spreadsheet: SpreadsheetApp.openByIdの戻り値（テストではメモリ上の代替）。戻り値: { added: number } */
  function migrate(spreadsheet) {
    var headers = BookingsSchema.HEADERS;
    var sheet = spreadsheet.getSheetByName(BookingsSchema.SHEET_NAME);
    if (!sheet) fail_('SHEET_NOT_FOUND');

    var migrationPlan = plan(readHeader_(sheet), headers);
    if (migrationPlan.missing.length === 0) return { added: 0 };

    /* グリッドの列数が足りない場合だけ末尾へ列を足す（セルの値は変えない）。 */
    var maxColumns = sheet.getMaxColumns();
    if (maxColumns < headers.length) {
      sheet.insertColumnsAfter(maxColumns, headers.length - maxColumns);
    }
    sheet.getRange(1, migrationPlan.startIndex + 1, 1, migrationPlan.missing.length)
      .setValues([migrationPlan.missing]);

    if (!matchesExactly_(normalizeRow_(readHeader_(sheet)), headers)) {
      fail_('POST_WRITE_VERIFICATION_FAILED');
    }
    return { added: migrationPlan.missing.length };
  }

  return {
    RESULT_OK: RESULT_OK_,
    RESULT_CURRENT: RESULT_CURRENT_,
    CODE_FAILED: CODE_FAILED_,
    CODE_UNEXPECTED: CODE_UNEXPECTED_,
    ERROR_NAME: ERROR_NAME_,
    plan: plan,
    migrate: migrate
  };
})();

/*
 * 正式関数: migrateBookingsSchema()。Apps Scriptエディタの関数一覧から選び、管理者が明示的に1回実行する
 * （関数名の末尾に `_` を付けない＝一覧に表示される）。引数なし。
 * 本番Bookingsシートが正本より列が少ない場合に、不足している末尾列だけを追加する。
 * 実行ログは固定コードと追加列数だけ。
 */
function migrateBookingsSchema() {
  var lock = LockService.getScriptLock();
  var result;
  try {
    /* 予約の追記・更新と同じScript Lockを使い、書込みの最中に台帳が更新されないようにする。 */
    if (!lock.tryLock(30000)) {
      var busy = new Error('LOCK_UNAVAILABLE');
      busy.name = BookingsSchemaMigration.ERROR_NAME;
      busy.code = 'LOCK_UNAVAILABLE';
      throw busy;
    }
    var spreadsheet = SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
    result = BookingsSchemaMigration.migrate(spreadsheet);
  } catch (e) {
    /* 元のエラー文（Spreadsheet ID・API応答を含み得る）は出さず、固定コードだけにする。 */
    var code = e && e.name === BookingsSchemaMigration.ERROR_NAME && e.code
      ? e.code : BookingsSchemaMigration.CODE_UNEXPECTED;
    Logger.log(BookingsSchemaMigration.CODE_FAILED + ': ' + code);
    throw new Error(BookingsSchemaMigration.CODE_FAILED + ': ' + code);
  } finally {
    try { lock.releaseLock(); } catch (_) { /* ロック未取得時は何もしない */ }
  }

  if (result.added === 0) {
    Logger.log(BookingsSchemaMigration.RESULT_CURRENT);
  } else {
    Logger.log(BookingsSchemaMigration.RESULT_OK + ': added=' + result.added);
  }
  return result;
}
