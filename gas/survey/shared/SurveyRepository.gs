/*
 * SurveyRepository.gs — アンケート回答・ステップ到達イベントのSpreadsheet入出力（Issue #374）。
 *
 * 列定義はコードに書かず、SurveyCore.responseColumns(SURVEY_SCHEMA)（= survey/survey-schema.json）から
 * 生成する。ヘッダ行がschemaと一致しないシートへは書き込まない（列ずれによるデータ破損を防ぐ）。
 * Spreadsheet IDはScript Properties（SURVEY_SPREADSHEET_ID）にのみ保持し、クライアントへは返さない。
 * 自由記述は SurveyCore.recordToRow が数式インジェクション対策（先頭に ' を付与）を行う。
 *
 * 公開Web Appプロジェクト・管理者Web Appプロジェクトの両方へ配布する（役割ごとのファイル一覧は
 * scripts/prepare-survey-gas-project.js 参照）。
 */
'use strict';

var SurveyRepository = (function () {
  var SHEET_RESPONSES = 'responses';
  var SHEET_EVENTS = 'events';
  var SHEET_QUESTIONS = 'questions';
  var SHEET_SETTINGS = 'settings';
  var LOCK_WAIT_MS = 10000;

  function getSpreadsheet_() {
    var id = PropertiesService.getScriptProperties().getProperty('SURVEY_SPREADSHEET_ID');
    if (!id) throw new Error('SURVEY_SPREADSHEET_ID が設定されていません。');
    return SpreadsheetApp.openById(id);
  }

  /*
   * ヘッダ照合。先頭 (columns.length - optionalTail) 列は完全一致が必須。
   * 末尾 optionalTail 列は「一致」または「空欄（旧Spreadsheetで未追加）」を許す（Issue #381 の is_test）。
   */
  function headerMatches_(header, columns, optionalTail) {
    var required = columns.length - (optionalTail || 0);
    for (var i = 0; i < columns.length; i++) {
      var cell = header[i] === undefined ? '' : header[i];
      if (cell === columns[i]) continue;
      if (i >= required && cell === '') continue;
      return false;
    }
    return true;
  }

  /* シートの列数が足りなければ増やす（実Spreadsheetは範囲外のgetRange/setValuesで例外になり得る）。 */
  function ensureColumns_(sheet, width) {
    if (typeof sheet.getMaxColumns !== 'function') return;
    var max = sheet.getMaxColumns();
    if (max < width) sheet.insertColumnsAfter(max, width - max);
  }

  /* 実在する列数を超えて読まない（未追加の末尾列は空欄として扱う）。 */
  function readWidth_(sheet, width) {
    return typeof sheet.getMaxColumns === 'function' ? Math.min(width, sheet.getMaxColumns()) : width;
  }

  function readHeader_(sheet, width) {
    var actual = readWidth_(sheet, width);
    var header = sheet.getRange(1, 1, 1, actual).getValues()[0];
    while (header.length < width) header.push('');
    return header;
  }

  /*
   * シートを取得（無ければ作成しヘッダを書く）。ヘッダがschemaと異なれば SCHEMA_MISMATCH で止める。
   * 旧ヘッダ（末尾の is_test が無いだけ）は、既存行を変更せずヘッダ行へ列名を追加して移行する。
   */
  function ensureSheet_(spreadsheet, name, columns, optionalTail) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    ensureColumns_(sheet, columns.length);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    } else {
      var header = readHeader_(sheet, columns.length);
      if (!headerMatches_(header, columns, optionalTail)) throw new Error('SCHEMA_MISMATCH:' + name);
      for (var i = columns.length - (optionalTail || 0); i < columns.length; i++) {
        if (header[i] === '') sheet.getRange(1, i + 1, 1, 1).setValues([[columns[i]]]);
      }
    }
    return sheet;
  }

  function appendRow_(sheet, row) {
    var target = sheet.getLastRow() + 1;
    var range = sheet.getRange(target, 1, 1, row.length);
    /* 値を数値・日付へ勝手に変換させない（timestamp列だけは後で日時として扱えるよう変換を許す）。 */
    range.setNumberFormat('@');
    range.setValues([row]);
  }

  /* 読み取りは書き込みなしで旧ヘッダ（is_test列なし）も許し、未追加列の値は空欄＝本番扱いにする。 */
  function readObjects_(sheet, columns) {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var values = sheet.getRange(1, 1, lastRow, readWidth_(sheet, columns.length)).getValues();
    if (!headerMatches_(values[0], columns, SurveyCore.optionalTailColumns)) throw new Error('SCHEMA_MISMATCH:' + sheet.getName());
    return values.slice(1).map(function (row) {
      var obj = {};
      columns.forEach(function (column, index) { obj[column] = row[index] === undefined ? '' : row[index]; });
      return obj;
    });
  }

  function questionRows_() {
    var rows = [['question_id', 'step_id', 'type', 'required', 'label', 'options']];
    SURVEY_SCHEMA.steps.forEach(function (step) {
      step.questions.forEach(function (question) {
        rows.push([
          question.id, step.id, question.type, question.required ? 'required' : 'optional', question.label,
          (question.options || []).map(function (o) { return o.value + '=' + o.label; }).join(' / ')
        ]);
      });
    });
    return rows;
  }

  function writeTable_(sheet, rows) {
    var width = rows[0].length;
    sheet.getRange(1, 1, rows.length, width).setValues(rows);
  }

  /* 初期設定。エディタから一度だけ手動実行する（冪等。既存データは消さない）。 */
  function setup() {
    var spreadsheet = getSpreadsheet_();
    ensureSheet_(spreadsheet, SHEET_RESPONSES, SurveyCore.responseColumns(SURVEY_SCHEMA), SurveyCore.optionalTailColumns);
    ensureSheet_(spreadsheet, SHEET_EVENTS, SurveyCore.eventColumns(), SurveyCore.optionalTailColumns);
    /* questions / settings は人が読む参照用。schemaから毎回上書きする。 */
    var questions = spreadsheet.getSheetByName(SHEET_QUESTIONS) || spreadsheet.insertSheet(SHEET_QUESTIONS);
    writeTable_(questions, questionRows_());
    var settings = spreadsheet.getSheetByName(SHEET_SETTINGS) || spreadsheet.insertSheet(SHEET_SETTINGS);
    writeTable_(settings, [
      ['key', 'value'],
      ['schema_version', String(SURVEY_SCHEMA.version)],
      ['min_cell', String(SURVEY_SCHEMA.analysis.minCell)]
    ]);
    return { success: true };
  }

  /*
   * 重複回答防止（Issue #381）。判定の正はここ（サーバー側）。
   * - 通常回答: 本番行（is_test が 1 でない行。旧行の空欄を含む）に同じrespondent_hashが既にあれば、
   *   追記せず DUPLICATE_RESPONSE を返す。既存行は上書きしない。
   * - テスト回答（record.is_test=1）: 重複判定をせず、常に is_test=1 の行として追記する。
   *   テスト行は本番の重複判定にも数えない（同じブラウザで先にテストしても本番回答できる）。
   */
  function appendResponse(record, now) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) return { success: false, error: { code: 'BUSY' } };
    try {
      var columns = SurveyCore.responseColumns(SURVEY_SCHEMA);
      var sheet = ensureSheet_(getSpreadsheet_(), SHEET_RESPONSES, columns, SurveyCore.optionalTailColumns);
      var isTest = SurveyCore.isTestFlag(record.is_test);
      var lastRow = sheet.getLastRow();
      if (!isTest && lastRow >= 2) {
        var hashes = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
        var flags = sheet.getRange(2, columns.indexOf('is_test') + 1, lastRow - 1, 1).getValues();
        for (var i = 0; i < hashes.length; i++) {
          if (hashes[i][0] === record.respondent_hash && !SurveyCore.isTestFlag(flags[i][0])) {
            return { success: false, error: { code: 'DUPLICATE_RESPONSE' } };
          }
        }
      }
      appendRow_(sheet, SurveyCore.recordToRow(SURVEY_SCHEMA, record, (now || new Date()).toISOString()));
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  }

  function appendEvent(respondentHash, stepId, now, isTest) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) return { success: false, error: { code: 'BUSY' } };
    try {
      var sheet = ensureSheet_(getSpreadsheet_(), SHEET_EVENTS, SurveyCore.eventColumns(), SurveyCore.optionalTailColumns);
      appendRow_(sheet, [(now || new Date()).toISOString(), respondentHash, stepId, isTest ? '1' : '0']);
      return { success: true };
    } finally {
      lock.releaseLock();
    }
  }

  /* 分析用record配列（timestamp付き）。管理者Web Appからのみ呼ぶ。 */
  function readResponses() {
    var columns = SurveyCore.responseColumns(SURVEY_SCHEMA);
    var sheet = getSpreadsheet_().getSheetByName(SHEET_RESPONSES);
    if (!sheet) return [];
    return readObjects_(sheet, columns).map(function (row) {
      var record = SurveyCore.rowToRecord(SURVEY_SCHEMA, row);
      record.timestamp = row.timestamp;
      return record;
    });
  }

  function readEvents() {
    var sheet = getSpreadsheet_().getSheetByName(SHEET_EVENTS);
    if (!sheet) return [];
    return readObjects_(sheet, SurveyCore.eventColumns());
  }

  return {
    setup: setup,
    appendResponse: appendResponse,
    appendEvent: appendEvent,
    readResponses: readResponses,
    readEvents: readEvents
  };
})();

/* エディタから手動実行する初期設定。 */
function setupSurveySpreadsheet() {
  return SurveyRepository.setup();
}
