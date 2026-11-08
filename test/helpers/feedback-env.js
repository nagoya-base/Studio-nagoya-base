/*
 * 利用後アンケートGAS（gas/feedback/。Issue #835）のテスト環境。
 * prepare-feedback-gas-project.js が出力する配布物そのものをvmで実行する。
 * 実際のSpreadsheet・メール・トークン台帳には一切アクセスしない。
 */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var stubs = require('./gas-stubs');
var preparePublic = require('../../scripts/prepare-feedback-gas-project');
var prepareAdmin = require('../../scripts/prepare-feedback-admin-gas-project');

function createSheet(name) {
  var rows = [];
  var sheet = {
    getName: function () { return name; },
    getLastRow: function () { return rows.length; },
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      if (sheet._failWrites) {
        return { getValues: read, setValues: function () { throw new Error('write failed'); } };
      }
      function read() {
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
      }
      return {
        getValues: read,
        setValues: function (values) {
          /* _failAfterWrites: この回数の書き込みが成功した後は失敗させる（途中失敗の再現用） */
          if (typeof sheet._failAfterWrites === 'number' && sheet._writes.length >= sheet._failAfterWrites) throw new Error('write failed');
          sheet._writes.push({ row: row, col: col, numRows: numRows, numCols: numCols });
          for (var r = 0; r < values.length; r++) {
            rows[row - 1 + r] = rows[row - 1 + r] || [];
            for (var c = 0; c < values[r].length; c++) rows[row - 1 + r][col - 1 + c] = values[r][c];
          }
        }
      };
    },
    deleteRow: function (rowNumber) { rows.splice(rowNumber - 1, 1); },
    _rows: rows,
    _writes: [],
    _failWrites: false
  };
  return sheet;
}

function createSpreadsheets() {
  var books = {};
  function book(id) {
    if (!books[id]) books[id] = { sheets: {}, order: [] };
    return books[id];
  }
  return {
    books: books,
    book: book,
    app: {
      openById: function (id) {
        if (!books[id]) throw new Error('Spreadsheetが見つかりません: ' + id);
        var b = books[id];
        return {
          getSheetByName: function (name) { return b.sheets[name] || null; },
          getSheets: function () { return b.order.map(function (n) { return b.sheets[n]; }); },
          insertSheet: function (name) { b.sheets[name] = createSheet(name); b.order.push(name); return b.sheets[name]; }
        };
      }
    },
    addSheet: function (id, name, rows) {
      var b = book(id);
      b.sheets[name] = createSheet(name);
      b.order.push(name);
      (rows || []).forEach(function (r) { b.sheets[name]._rows.push(r.slice()); });
      return b.sheets[name];
    }
  };
}

/*
 * options: target('public' 既定 | 'admin') / properties / mailFails / lockFails / activeEmail（管理者画面の閲覧者）
 *          spreadsheetId(既定 'ss-feedback'。null で作らない) / spreadsheets（別プロジェクトと同じSpreadsheetを共有する）
 */
function loadFeedbackProject(options) {
  var opts = options || {};
  var prepare = opts.target === 'admin' ? prepareAdmin : preparePublic;
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-gas-'));
  prepare.prepareProject(dir);
  var spreadsheets = opts.spreadsheets || createSpreadsheets();
  var ssId = opts.spreadsheetId === undefined ? 'ss-feedback' : opts.spreadsheetId;
  if (ssId) spreadsheets.book(ssId);
  var properties = Object.assign(ssId ? { FEEDBACK_SPREADSHEET_ID: ssId } : {}, opts.properties || {});
  var logs = [];
  var mails = [];
  var triggers = [];
  var sandbox = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    SpreadsheetApp: spreadsheets.app,
    LockService: stubs.createLockServiceStub({ forceTryLockFail: !!opts.lockFails }),
    CacheService: stubs.createCacheServiceStub(),
    ContentService: stubs.createContentServiceStub(),
    Utilities: stubs.createUtilitiesStub(),
    MailApp: {
      sendEmail: function (to, subject, body) {
        if (opts.mailFails) throw new Error('mail failed to ' + to);
        mails.push({ to: to, subject: subject, body: body });
      }
    },
    ScriptApp: {
      getProjectTriggers: function () { return triggers.slice(); },
      deleteTrigger: function (t) { triggers.splice(triggers.indexOf(t), 1); },
      newTrigger: function (handler) {
        var spec = { handler: handler };
        var builder = {
          timeBased: function () { return builder; },
          onMonthDay: function (d) { spec.monthDay = d; return builder; },
          atHour: function (h) { spec.hour = h; return builder; },
          create: function () {
            var t = { spec: spec, getHandlerFunction: function () { return handler; } };
            triggers.push(t);
            return t;
          }
        };
        return builder;
      }
    },
    Session: {
      getActiveUser: function () {
        return { getEmail: function () { if (opts.activeEmailThrows) throw new Error('no email'); return opts.activeEmail || ''; } };
      }
    },
    HtmlService: {
      createHtmlOutput: function (text) { return { kind: 'text', text: text, setTitle: function () { return this; } }; },
      createHtmlOutputFromFile: function (name) {
        return { kind: 'file', name: name, setTitle: function () { return this; }, addMetaTag: function () { return this; } };
      }
    },
    Logger: { log: function (m) { logs.push(String(m)); } }
  };
  vm.createContext(sandbox);
  prepare.fileNames().filter(function (f) { return /\.gs$/.test(f); }).forEach(function (file) {
    var filePath = path.join(dir, file);
    vm.runInContext(fs.readFileSync(filePath, 'utf8'), sandbox, { filename: filePath });
  });
  var project = {
    sandbox: sandbox,
    spreadsheets: spreadsheets,
    dir: dir,
    logs: logs,
    mails: mails,
    triggers: triggers,
    properties: properties,
    run: function (code) { return vm.runInContext(code, sandbox); },
    sheet: function (name, id) {
      var b = spreadsheets.books[id || ssId];
      return b && b.sheets[name];
    },
    rows: function () {
      var sheet = project.sheet('responses');
      if (!sheet) return [];
      var header = sheet._rows[0];
      return sheet._rows.slice(1).map(function (r) {
        var o = {};
        header.forEach(function (c, i) { o[c] = r[i]; });
        return o;
      });
    },
    call: function (action, payload, now) {
      sandbox.__action = action;
      sandbox.__body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      sandbox.__now = now || new Date('2026-11-08T03:00:00.000Z');
      return JSON.parse(JSON.stringify(vm.runInContext('handleFeedbackRequest_(__action, __body, __now)', sandbox)));
    }
  };
  return project;
}

module.exports = { loadFeedbackProject: loadFeedbackProject, createSpreadsheets: createSpreadsheets };
