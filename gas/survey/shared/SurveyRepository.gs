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

  function headerMatches_(header, columns) {
    if (header.length < columns.length) return false;
    for (var i = 0; i < columns.length; i++) if (header[i] !== columns[i]) return false;
    return true;
  }

  /* シートを取得（無ければ作成しヘッダを書く）。ヘッダがschemaと異なれば SCHEMA_MISMATCH で止める。 */
  function ensureSheet_(spreadsheet, name, columns) {
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
    } else {
      var header = sheet.getRange(1, 1, 1, columns.length).getValues()[0];
      if (!headerMatches_(header, columns)) throw new Error('SCHEMA_MISMATCH:' + name);
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

  function readObjects_(sheet, columns) {
    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];
    var values = sheet.getRange(1, 1, lastRow, columns.length).getValues();
    if (!headerMatches_(values[0], columns)) throw new Error('SCHEMA_MISMATCH:' + sheet.getName());
    return values.slice(1).map(function (row) {
      var obj = {};
      columns.forEach(function (column, index) { obj[column] = row[index]; });
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
    ensureSheet_(spreadsheet, SHEET_RESPONSES, SurveyCore.responseColumns(SURVEY_SCHEMA));
    ensureSheet_(spreadsheet, SHEET_EVENTS, SurveyCore.eventColumns());
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

  /* 二重送信防止: 同じrespondent_hashが既にあれば追記せず duplicate:true を返す（冪等）。 */
  function appendResponse(record, now) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) return { success: false, error: { code: 'BUSY' } };
    try {
      var columns = SurveyCore.responseColumns(SURVEY_SCHEMA);
      var sheet = ensureSheet_(getSpreadsheet_(), SHEET_RESPONSES, columns);
      var lastRow = sheet.getLastRow();
      if (lastRow >= 2) {
        var hashes = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
        for (var i = 0; i < hashes.length; i++) {
          if (hashes[i][0] === record.respondent_hash) return { success: true, duplicate: true };
        }
      }
      appendRow_(sheet, SurveyCore.recordToRow(SURVEY_SCHEMA, record, (now || new Date()).toISOString()));
      return { success: true, duplicate: false };
    } finally {
      lock.releaseLock();
    }
  }

  function appendEvent(respondentHash, stepId, now) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_WAIT_MS)) return { success: false, error: { code: 'BUSY' } };
    try {
      var sheet = ensureSheet_(getSpreadsheet_(), SHEET_EVENTS, SurveyCore.eventColumns());
      appendRow_(sheet, [(now || new Date()).toISOString(), respondentHash, stepId]);
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
