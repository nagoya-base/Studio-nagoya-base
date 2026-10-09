/*
 * アンケートGAS（gas/survey/）のテスト環境。prepare-survey-gas-project.js が出力する
 * 「実際にGASへ配布するファイル一式」をvmで実行する（ロジックを別途書き写さない）。
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var stubs = require('./gas-stubs');
var prepare = require('../../scripts/prepare-survey-gas-project');

/* 値の読み書きができる最小限のSheetスタブ（setNumberFormat / 部分getRange対応）。 */
function createSurveySheet(name) {
  var rows = [];
  /* 実Spreadsheetと同じく、列数を超える範囲の読み書きは例外にする（既定は新規シートと同じ26列）。 */
  var maxColumns = 26;
  return {
    getName: function () { return name; },
    getLastRow: function () { return rows.length; },
    getMaxColumns: function () { return maxColumns; },
    insertColumnsAfter: function (after, count) { maxColumns = Math.max(maxColumns, after + count); },
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      if (col - 1 + numCols > maxColumns) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var line = [];
            for (var c = 0; c < numCols; c++) {
              var source = rows[row - 1 + r] || [];
              line.push(source[col - 1 + c] === undefined ? '' : source[col - 1 + c]);
            }
            out.push(line);
          }
          return out;
        },
        setValues: function (values) {
          for (var r = 0; r < values.length; r++) {
            rows[row - 1 + r] = rows[row - 1 + r] || [];
            for (var c = 0; c < values[r].length; c++) rows[row - 1 + r][col - 1 + c] = values[r][c];
          }
        },
        setNumberFormat: function () { return this; }
      };
    },
    _rows: rows
  };
}

function createSurveySpreadsheets(id) {
  var sheets = {};
  var all = {};
  all[id] = sheets;
  return {
    sheets: sheets,
    app: {
      openById: function (requested) {
        if (requested !== id) throw new Error('Spreadsheetが見つかりません');
        return {
          getSheetByName: function (name) { return sheets[name] || null; },
          insertSheet: function (name) { sheets[name] = createSurveySheet(name); return sheets[name]; }
        };
      }
    }
  };
}

/* target: 'public' | 'admin'。options.properties / options.activeEmail / options.lockFails */
function loadSurveyProject(target, options) {
  var opts = options || {};
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-gas-'));
  prepare.prepareProject(target, dir);
  var spreadsheets = createSurveySpreadsheets('ss-survey');
  var properties = Object.assign({ SURVEY_SPREADSHEET_ID: 'ss-survey' }, opts.properties || {});
  var logs = [];
  var mails = [];
  var sandbox = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    SpreadsheetApp: spreadsheets.app,
    LockService: stubs.createLockServiceStub({ forceTryLockFail: !!opts.lockFails }),
    CacheService: stubs.createCacheServiceStub(),
    ContentService: stubs.createContentServiceStub(),
    Session: { getActiveUser: function () { return { getEmail: function () { return opts.activeEmail || ''; } }; } },
    HtmlService: {
      createHtmlOutput: function (text) { return { kind: 'text', text: text, setTitle: function () { return this; } }; },
      createHtmlOutputFromFile: function (name) {
        return { kind: 'file', name: name, setTitle: function () { return this; }, addMetaTag: function () { return this; } };
      }
    },
    MailApp: {
      sendEmail: function (to, subject, body) {
        if (opts.mailFails) throw new Error('mail failed');
        mails.push({ to: to, subject: subject, body: body });
      }
    },
    Logger: { log: function (m) { logs.push(m); } }
  };
  vm.createContext(sandbox);
  prepare.fileNames(target).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (file) {
    var filePath = path.join(dir, file);
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), sandbox, { filename: filePath });
  });
  return { sandbox: sandbox, sheets: spreadsheets.sheets, dir: dir, logs: logs, mails: mails, run: function (code) { return vm.runInContext(code, sandbox); } };
}

module.exports = { loadSurveyProject: loadSurveyProject };
