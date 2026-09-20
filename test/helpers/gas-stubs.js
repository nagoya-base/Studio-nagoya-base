/*
 * GAS組み込みサービス（PropertiesService / CalendarApp / Utilities / ContentService /
 * LockService / CacheService / SpreadsheetApp / MailApp / ScriptApp）のテスト用スタブ。
 * 実際のGoogle Calendar/Spreadsheet/Script Propertiesには一切アクセスしない。
 */
'use strict';

function createPropertiesServiceStub(initialProperties) {
  var store = {};
  Object.keys(initialProperties || {}).forEach(function (key) {
    store[key] = initialProperties[key];
  });
  return {
    getScriptProperties: function () {
      return {
        getProperty: function (key) {
          return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
        },
        setProperty: function (key, value) {
          store[key] = value;
        }
      };
    }
  };
}

/* Utilities.parseDate相当。テストではAsia/Tokyo（DSTなし・常に+09:00）のみ対応する
   （getAvailabilityConfig()のTIMEZONEデフォルトかつIssue #266固定仕様のため）。
   getUuid()は呼び出しごとに異なる値を返し、bookingId生成の一意性を検証できるようにする。 */
function createUtilitiesStub() {
  var uuidCounter = 0;
  return {
    parseDate: function (dateTimeString, timezone, format) {
      if (timezone !== 'Asia/Tokyo') {
        throw new Error('Utilities stub は Asia/Tokyo 以外のtimezoneに未対応です: ' + timezone);
      }
      if (format !== 'yyyy-MM-dd HH:mm:ss') {
        throw new Error('Utilities stub は想定外のformatを受け取りました: ' + format);
      }
      var iso = dateTimeString.replace(' ', 'T') + '+09:00';
      var date = new Date(iso);
      if (isNaN(date.getTime())) {
        throw new Error('Utilities stub が日時を解釈できません: ' + dateTimeString);
      }
      return date;
    },
    getUuid: function () {
      uuidCounter += 1;
      var hex = uuidCounter.toString(16);
      while (hex.length < 8) hex = '0' + hex;
      return hex + '-mock-uuid-' + hex;
    }
  };
}

/* event: { start: Date, end: Date, isAllDay: boolean } */
function createEventStub(event) {
  var tags = {};
  var deleted = false;
  var self = {
    id: event.id || 'event-' + Math.random().toString(36).slice(2),
    getId: function () { return self.id; },
    getStartTime: function () { return event.start; },
    getEndTime: function () { return event.end; },
    isAllDayEvent: function () { return !!event.isAllDay; },
    getTitle: function () { return event.title || ''; },
    setTitle: function (title) { event.title = title; return self; },
    setTag: function (key, value) { tags[key] = value; return self; },
    getTag: function (key) { return Object.prototype.hasOwnProperty.call(tags, key) ? tags[key] : null; },
    deleteEvent: function () {
      if (deleted) throw new Error('イベントは既に削除されています: ' + self.id);
      deleted = true;
    },
    isDeleted: function () { return deleted; }
  };
  return self;
}

/*
 * calendarsById: { [calendarId]: { events: [eventStub, ...] } | undefined（存在しないCalendar） }
 * createEvent()で追加されたイベントは同じentry.eventsへ反映されるため、後続の
 * getBusyIntervalsForDate呼び出しでも見えるようになる（同時実行・競合検知テスト用）。
 * createEvent失敗を注入したい場合は entry.failCreateEvent = new Error('...') を設定する。
 */
function createCalendarAppStub(calendarsById) {
  function findEventById(entry, eventId) {
    var events = entry.events.filter(function (e) { return !e.isDeleted(); });
    for (var i = 0; i < events.length; i++) {
      if (events[i].getId() === eventId) return events[i];
    }
    return null;
  }

  return {
    getCalendarById: function (id) {
      var entry = calendarsById[id];
      if (!entry) return null;
      return {
        getEvents: function () { return entry.events.filter(function (e) { return !e.isDeleted(); }); },
        createEvent: function (title, start, end) {
          if (entry.failCreateEvent) throw entry.failCreateEvent;
          var newEvent = createEventStub({ title: title, start: start, end: end, isAllDay: false });
          entry.events.push(newEvent);
          return newEvent;
        },
        getEventById: function (eventId) { return findEventById(entry, eventId); }
      };
    }
  };
}

function createContentServiceStub() {
  return {
    MimeType: { JSON: 'JSON' },
    createTextOutput: function (text) {
      var output = { text: text, mimeType: null };
      output.setMimeType = function (mime) {
        output.mimeType = mime;
        return output;
      };
      return output;
    }
  };
}

/*
 * LockService.getScriptLock()相当。単一プロセス内のテストでは真の排他は再現できないため、
 * heldフラグで「同時に2つ目のtryLockが失敗する」ことだけを模擬する。
 * options.forceTryLockFail === true にすると常にtryLockが失敗する（ロック取得失敗系のテスト用）。
 */
function createLockServiceStub(options) {
  var opts = options || {};
  var held = false;
  return {
    getScriptLock: function () {
      return {
        tryLock: function () {
          if (opts.forceTryLockFail) return false;
          if (held) return false;
          held = true;
          return true;
        },
        releaseLock: function () {
          held = false;
        }
      };
    },
    _isHeld: function () { return held; }
  };
}

/*
 * CacheService.getScriptCache()相当。put/getのみをメモリ上のMapで再現する
 * （有効期限は無視して良い。テストでは短い時間窓のみを扱うため）。
 */
function createCacheServiceStub() {
  var store = {};
  return {
    getScriptCache: function () {
      return {
        get: function (key) {
          return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
        },
        put: function (key, value) {
          store[key] = value;
        },
        remove: function (key) {
          delete store[key];
        }
      };
    }
  };
}

/*
 * 簡易インメモリSheet。appendRow / getRange / getDataRange / getLastRowのみ実装する
 * （SpreadsheetRepository.gs / RecoveryRepository.gsが実際に使うAPIのみ）。
 */
function createSheetStub(name) {
  var rows = [];
  return {
    getName: function () { return name; },
    appendRow: function (row) {
      rows.push(row.slice());
    },
    getLastRow: function () { return rows.length; },
    getDataRange: function () {
      return {
        getValues: function () { return rows.map(function (r) { return r.slice(); }); }
      };
    },
    getRange: function (row, col, numRows, numCols) {
      numRows = numRows || 1;
      numCols = numCols || 1;
      return {
        getValues: function () {
          var out = [];
          for (var r = 0; r < numRows; r++) {
            var line = [];
            for (var c = 0; c < numCols; c++) {
              line.push(rows[row - 1 + r][col - 1 + c]);
            }
            out.push(line);
          }
          return out;
        },
        setValues: function (values) {
          for (var r = 0; r < numRows; r++) {
            for (var c = 0; c < numCols; c++) {
              rows[row - 1 + r][col - 1 + c] = values[r][c];
            }
          }
        }
      };
    },
    _rows: rows
  };
}

/*
 * SpreadsheetApp.openById(id)相当。sheetsByName: { [sheetName]: sheetStub } を事前に
 * 用意しなければ、insertSheet()で自動作成する（実際のSpreadsheetRepository.gsの
 * ensureSheet挙動と一致させる）。
 */
function createSpreadsheetAppStub(spreadsheetsById, options) {
  var opts = options || {};
  return {
    openById: function (id) {
      var sheetsByName = spreadsheetsById[id];
      if (!sheetsByName) throw new Error('Spreadsheetが見つかりません: ' + id);
      return {
        getId: function () { return id; },
        getSheetByName: function (name) {
          return Object.prototype.hasOwnProperty.call(sheetsByName, name) ? sheetsByName[name] : null;
        },
        insertSheet: function (name) {
          var sheet = createSheetStub(name);
          sheetsByName[name] = sheet;
          return sheet;
        }
      };
    },
    getActiveSheet: function () {
      if (opts.activeSheet) return opts.activeSheet;
      throw new Error('SpreadsheetApp stub の getActiveSheet は未実装です（BookingAdmin.gsのテストでは個別にスタブすること）。');
    },
    getUi: function () {
      if (opts.ui) return opts.ui;
      throw new Error('SpreadsheetApp stub の getUi は未実装です（BookingAdmin.gsのテストではcreateSpreadsheetUiStub()を渡すこと）。');
    }
  };
}

/*
 * SpreadsheetApp.getUi()相当。createMenu(...).addItem(...).addToUi()、alert(...)、
 * prompt(...)（options.promptResponsesを順番に消費する）を再現する。
 * 実際にメニュー項目のハンドラ関数を呼び出すことはしない（クリック操作の再現はせず、
 * 配線とダイアログ表示内容のみを検証する）。
 */
function createSpreadsheetUiStub(options) {
  var opts = options || {};
  var promptResponses = (opts.promptResponses || []).slice();
  var alerts = [];
  var menus = [];

  var BUTTON = { OK: 'OK', CANCEL: 'CANCEL', CLOSE: 'CLOSE' };

  function menuBuilder(name) {
    var items = [];
    var builder = {
      addItem: function (caption, functionName) {
        items.push({ caption: caption, functionName: functionName });
        return builder;
      },
      addToUi: function () {
        menus.push({ name: name, items: items });
      }
    };
    return builder;
  }

  return {
    Button: BUTTON,
    ButtonSet: { OK_CANCEL: 'OK_CANCEL', OK: 'OK' },
    createMenu: function (name) { return menuBuilder(name); },
    alert: function (message) { alerts.push(message); },
    prompt: function () {
      var next = promptResponses.shift() || { button: BUTTON.CANCEL, text: '' };
      return {
        getSelectedButton: function () { return next.button; },
        getResponseText: function () { return next.text; }
      };
    },
    _menus: menus,
    _alerts: alerts
  };
}

/*
 * MailApp.sendEmail相当。options.throwError を設定すると送信のたびに例外を投げる（通知失敗の模擬用）。
 * 実際のMailAppと同様、sendEmail(to, subject, body)の3引数形式と、
 * sendEmail({to, subject, body, name, replyTo, ...})のオブジェクト形式の両方に対応する
 * （AdminNotifier.gsは前者、BookingMailer.gsは後者を使う。Issue #271）。
 */
function createMailAppStub(options) {
  var opts = options || {};
  var sentEmails = [];
  return {
    sendEmail: function (toOrMessage, subject, body) {
      if (opts.throwError) throw opts.throwError;
      if (toOrMessage && typeof toOrMessage === 'object') {
        sentEmails.push({
          to: toOrMessage.to,
          subject: toOrMessage.subject,
          body: toOrMessage.body,
          name: toOrMessage.name,
          replyTo: toOrMessage.replyTo
        });
      } else {
        sentEmails.push({ to: toOrMessage, subject: subject, body: body });
      }
    },
    _sentEmails: sentEmails
  };
}

/* ScriptApp相当。時間主導トリガー（timeBased().everyMinutes()。expirePendingBookings用）の
   一覧・作成のみをメモリ上で再現する。カスタムメニューはコンテナバインドスクリプトの
   onOpen単純トリガーでのみ動作する仕様のため、installable onOpenトリガーのチェーンは
   意図的にサポートしない（1回目レビューで採用したinstallBookingAdminMenuTrigger()方式は
   Googleの仕様上成立しないため2回目レビューで撤回した。gas/booking/README.md参照）。 */
function createScriptAppStub() {
  var triggers = [];
  return {
    getProjectTriggers: function () { return triggers.slice(); },
    newTrigger: function (functionName) {
      var builder = {
        timeBased: function () { return builder; },
        everyMinutes: function () { return builder; },
        everyDays: function () { return builder; },
        atHour: function () { return builder; },
        nearMinute: function () { return builder; },
        create: function () {
          var trigger = {
            getHandlerFunction: function () { return functionName; }
          };
          triggers.push(trigger);
          return trigger;
        }
      };
      return builder;
    }
  };
}

/* Logger.log相当。呼び出し内容をそのまま保持するだけで、標準出力へは書かない。 */
function createLoggerStub() {
  var logs = [];
  return {
    log: function (message) { logs.push(String(message)); },
    _logs: logs
  };
}

/* vmサンドボックス（別realm）内で生成されたDateはテスト側の `instanceof Date` が
   falseになる（realmが異なるため）。テストではこの関数で判定する。 */
function isDateLike(value) {
  return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
}

module.exports = {
  isDateLike: isDateLike,
  createLoggerStub: createLoggerStub,
  createPropertiesServiceStub: createPropertiesServiceStub,
  createUtilitiesStub: createUtilitiesStub,
  createEventStub: createEventStub,
  createCalendarAppStub: createCalendarAppStub,
  createContentServiceStub: createContentServiceStub,
  createLockServiceStub: createLockServiceStub,
  createCacheServiceStub: createCacheServiceStub,
  createSheetStub: createSheetStub,
  createSpreadsheetAppStub: createSpreadsheetAppStub,
  createSpreadsheetUiStub: createSpreadsheetUiStub,
  createMailAppStub: createMailAppStub,
  createScriptAppStub: createScriptAppStub
};
