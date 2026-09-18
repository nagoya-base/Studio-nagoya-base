/*
 * GAS組み込みサービス（PropertiesService / CalendarApp / Utilities / ContentService）の
 * テスト用スタブ。実際のGoogle Calendar/Script Propertiesには一切アクセスしない。
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
   （getAvailabilityConfig()のTIMEZONEデフォルトかつIssue #266固定仕様のため）。 */
function createUtilitiesStub() {
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
    }
  };
}

/* event: { start: Date, end: Date, isAllDay: boolean } */
function createEventStub(event) {
  return {
    getStartTime: function () { return event.start; },
    getEndTime: function () { return event.end; },
    isAllDayEvent: function () { return !!event.isAllDay; }
  };
}

/* calendarsById: { [calendarId]: { events: [eventStub, ...] } | undefined(存在しないCalendar) } */
function createCalendarAppStub(calendarsById) {
  return {
    getCalendarById: function (id) {
      var entry = calendarsById[id];
      if (!entry) return null;
      return {
        getEvents: function () { return entry.events; }
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

module.exports = {
  createPropertiesServiceStub: createPropertiesServiceStub,
  createUtilitiesStub: createUtilitiesStub,
  createEventStub: createEventStub,
  createCalendarAppStub: createCalendarAppStub,
  createContentServiceStub: createContentServiceStub
};
