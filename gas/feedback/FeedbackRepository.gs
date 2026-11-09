/*
 * FeedbackRepository.gs — 利用後アンケート（Issue #835）の回答Spreadsheet入出力。
 *
 * 保存先は Booking・既存 /survey/ とは別の新規Spreadsheet 1ファイル（3ブランド共通。brand列で識別）。
 * - Script Properties の FEEDBACK_SPREADSHEET_ID だけを参照する。未設定なら保存しない（他へフォールバックしない）。
 * - setupFeedbackSpreadsheet() が settings シートへ書く識別マーカーが無いSpreadsheetには書き込まない
 *   （Booking・既存surveyのIDを誤って設定しても保存が止まる）。
 * - responses のヘッダが FeedbackCore.COLUMNS と一致しない場合も書き込まない。
 * - token_uses（Issue #834。本番トークンの使用済み台帳。列: token_key, expires_at）も同じSpreadsheetに置く。
 *   予約ID・回答ID・回答日時は書かない（回答と予約を結び付けない）。ヘッダが違えば読み書きしない。
 */
'use strict';

var FEEDBACK_SHEET_RESPONSES = 'responses';
var FEEDBACK_SHEET_SETTINGS = 'settings';
var FEEDBACK_SHEET_TOKEN_USES = 'token_uses';
var FEEDBACK_TOKEN_USES_COLUMNS = ['token_key', 'expires_at'];
var FEEDBACK_MARKER_KEY = 'feedback_spreadsheet';
var FEEDBACK_MARKER_VALUE = 'studio-nagoya-base-post-use-feedback-v1';

var FeedbackRepository = (function () {
  function spreadsheetId_() {
    return String(PropertiesService.getScriptProperties().getProperty('FEEDBACK_SPREADSHEET_ID') || '').trim();
  }

  function openSpreadsheet_() {
    var id = spreadsheetId_();
    if (!id) return { error: 'STORAGE_NOT_CONFIGURED' };
    try {
      return { spreadsheet: SpreadsheetApp.openById(id) };
    } catch (openError) {
      return { error: 'STORAGE_UNAVAILABLE' };
    }
  }

  function hasMarker_(spreadsheet) {
    var settings = spreadsheet.getSheetByName(FEEDBACK_SHEET_SETTINGS);
    if (!settings || settings.getLastRow() < 1) return false;
    var values = settings.getRange(1, 1, settings.getLastRow(), 2).getValues();
    return values.some(function (row) { return row[0] === FEEDBACK_MARKER_KEY && row[1] === FEEDBACK_MARKER_VALUE; });
  }

  function headerMatches_(sheet) {
    var columns = FeedbackCore.COLUMNS;
    if (sheet.getLastRow() < 1) return false;
    var header = sheet.getRange(1, 1, 1, columns.length).getValues()[0];
    return columns.every(function (c, i) { return header[i] === c; });
  }

  /* 書き込み可能な responses シートを返す。{ sheet } / { error } */
  function openResponses() {
    var opened = openSpreadsheet_();
    if (opened.error) return opened;
    if (!hasMarker_(opened.spreadsheet)) return { error: 'STORAGE_NOT_INITIALIZED' };
    var sheet = opened.spreadsheet.getSheetByName(FEEDBACK_SHEET_RESPONSES);
    if (!sheet || !headerMatches_(sheet)) return { error: 'STORAGE_SCHEMA_MISMATCH' };
    return { sheet: sheet };
  }

  /* 1行追記。{ success:true, rowNumber } / { success:false, error:{code} } */
  function appendRow(sheet, row) {
    try {
      var rowNumber = sheet.getLastRow() + 1;
      sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
      return { success: true, rowNumber: rowNumber };
    } catch (writeError) {
      return { success: false, error: { code: 'STORAGE_WRITE_FAILED' } };
    }
  }

  /* 通知失敗の記録。行番号がずれていても response_id で探し直してから書く。 */
  function markNotifyFailed(responseId, rowNumberHint) {
    var opened = openResponses();
    if (opened.error) return false;
    var sheet = opened.sheet;
    var columns = FeedbackCore.COLUMNS;
    var idCol = columns.indexOf('response_id') + 1;
    var flagCol = columns.indexOf('notify_failed') + 1;
    var target = 0;
    if (rowNumberHint >= 2 && rowNumberHint <= sheet.getLastRow() &&
      sheet.getRange(rowNumberHint, idCol, 1, 1).getValues()[0][0] === responseId) {
      target = rowNumberHint;
    } else if (sheet.getLastRow() >= 2) {
      var ids = sheet.getRange(2, idCol, sheet.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < ids.length; i++) if (ids[i][0] === responseId) { target = i + 2; break; }
    }
    if (!target) return false;
    sheet.getRange(target, flagCol, 1, 1).setValues([[1]]);
    return true;
  }

  /* ===== token_uses（Issue #834） ===== */

  function tokenLedgerHeaderMatches_(sheet) {
    if (sheet.getLastRow() < 1) return false;
    var header = sheet.getRange(1, 1, 1, FEEDBACK_TOKEN_USES_COLUMNS.length).getValues()[0];
    return FEEDBACK_TOKEN_USES_COLUMNS.every(function (c, i) { return header[i] === c; });
  }

  /* 使用済み台帳シートを返す。{ sheet } / { error } */
  function openTokenLedger() {
    var opened = openSpreadsheet_();
    if (opened.error) return opened;
    if (!hasMarker_(opened.spreadsheet)) return { error: 'STORAGE_NOT_INITIALIZED' };
    var sheet = opened.spreadsheet.getSheetByName(FEEDBACK_SHEET_TOKEN_USES);
    if (!sheet) return { error: 'TOKEN_LEDGER_NOT_INITIALIZED' };
    if (!tokenLedgerHeaderMatches_(sheet)) return { error: 'STORAGE_SCHEMA_MISMATCH' };
    return { sheet: sheet };
  }

  function tokenKeys_(sheet) {
    if (sheet.getLastRow() < 2) return [];
    return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); });
  }

  function isTokenUsed(sheet, tokenKey) {
    return tokenKeys_(sheet).indexOf(String(tokenKey)) !== -1;
  }

  function appendTokenUse(sheet, tokenKey, expiresAtIso) {
    try {
      sheet.getRange(sheet.getLastRow() + 1, 1, 1, 2).setValues([[String(tokenKey), String(expiresAtIso)]]);
      return true;
    } catch (writeError) {
      return false;
    }
  }

  /* 下の行から削除する（行番号のずれを防ぐ）。削除できた行があれば true。 */
  function removeTokenUse(sheet, tokenKey) {
    var keys = tokenKeys_(sheet);
    var removed = false;
    for (var i = keys.length - 1; i >= 0; i--) {
      if (keys[i] === String(tokenKey)) {
        sheet.deleteRow(i + 2);
        removed = true;
      }
    }
    return removed;
  }

  /* expires_at が cutoffMs より前の行を削除し、件数を返す。日時が読めない行は消さない。 */
  function purgeTokenUses(sheet, cutoffMs) {
    if (sheet.getLastRow() < 2) return 0;
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
    var deleted = 0;
    for (var i = values.length - 1; i >= 0; i--) {
      var raw = values[i][1];
      var ms = raw && typeof raw.getTime === 'function' ? raw.getTime() : Date.parse(String(raw));
      if (isFinite(ms) && ms < cutoffMs) {
        sheet.deleteRow(i + 2);
        deleted++;
      }
    }
    return deleted;
  }

  return {
    openSpreadsheet_: openSpreadsheet_,
    hasMarker_: hasMarker_,
    openResponses: openResponses,
    appendRow: appendRow,
    markNotifyFailed: markNotifyFailed,
    openTokenLedger: openTokenLedger,
    isTokenUsed: isTokenUsed,
    appendTokenUse: appendTokenUse,
    removeTokenUse: removeTokenUse,
    purgeTokenUses: purgeTokenUses
  };
})();

/*
 * 初期設定（GASエディタから1回実行。冪等）。responses / settings / token_uses シートを作り、識別マーカーを書く。
 * 第1・2段階で初期化済みのSpreadsheetで再実行すると、不足している token_uses だけを追加する（既存行は変更しない）。
 * 他の用途のデータが入ったSpreadsheet（Booking・既存survey等）には、誤設定とみなして何も書かずに止める。
 */
function setupFeedbackSpreadsheet() {
  var opened = FeedbackRepository.openSpreadsheet_();
  if (opened.error) throw new Error('setupFeedbackSpreadsheet: ' + opened.error);
  var spreadsheet = opened.spreadsheet;
  var known = [FEEDBACK_SHEET_RESPONSES, FEEDBACK_SHEET_SETTINGS, FEEDBACK_SHEET_TOKEN_USES];
  if (!FeedbackRepository.hasMarker_(spreadsheet)) {
    var foreign = spreadsheet.getSheets().filter(function (sheet) {
      return known.indexOf(sheet.getName()) === -1 && sheet.getLastRow() > 0;
    });
    var knownWithData = known.some(function (name) {
      var sheet = spreadsheet.getSheetByName(name);
      return sheet && sheet.getLastRow() > 0;
    });
    if (foreign.length || knownWithData) {
      throw new Error('setupFeedbackSpreadsheet: 空ではないSpreadsheetです。利用後アンケート専用の新規Spreadsheetを指定してください');
    }
  }

  var responses = spreadsheet.getSheetByName(FEEDBACK_SHEET_RESPONSES) || spreadsheet.insertSheet(FEEDBACK_SHEET_RESPONSES);
  var columns = FeedbackCore.COLUMNS;
  if (responses.getLastRow() < 1) {
    responses.getRange(1, 1, 1, columns.length).setValues([columns]);
  } else {
    var header = responses.getRange(1, 1, 1, columns.length).getValues()[0];
    if (!columns.every(function (c, i) { return header[i] === c; })) {
      throw new Error('setupFeedbackSpreadsheet: responses のヘッダが想定と異なります');
    }
  }

  var tokenUses = spreadsheet.getSheetByName(FEEDBACK_SHEET_TOKEN_USES) || spreadsheet.insertSheet(FEEDBACK_SHEET_TOKEN_USES);
  if (tokenUses.getLastRow() < 1) {
    tokenUses.getRange(1, 1, 1, FEEDBACK_TOKEN_USES_COLUMNS.length).setValues([FEEDBACK_TOKEN_USES_COLUMNS]);
  } else {
    var ledgerHeader = tokenUses.getRange(1, 1, 1, FEEDBACK_TOKEN_USES_COLUMNS.length).getValues()[0];
    if (!FEEDBACK_TOKEN_USES_COLUMNS.every(function (c, i) { return ledgerHeader[i] === c; })) {
      throw new Error('setupFeedbackSpreadsheet: token_uses のヘッダが想定と異なります');
    }
  }

  var settings = spreadsheet.getSheetByName(FEEDBACK_SHEET_SETTINGS) || spreadsheet.insertSheet(FEEDBACK_SHEET_SETTINGS);
  if (!FeedbackRepository.hasMarker_(spreadsheet)) {
    settings.getRange(1, 1, 3, 2).setValues([
      ['key', 'value'],
      [FEEDBACK_MARKER_KEY, FEEDBACK_MARKER_VALUE],
      ['form_version', String(FeedbackCore.FORM_VERSION)]
    ]);
  }
  return 'ok';
}
