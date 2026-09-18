/*
 * CalendarRepository.gs — Google Calendarからの読み取り専用アクセス（Issue #266）。
 *
 * 対象日のイベントを1回のCalendar API呼び出しでまとめて取得し、Availability.gsが
 * メモリ上で判定できる形（当日00:00からの経過分単位の占有区間）へ変換する。
 * 1スロットごとにCalendar APIを叩かない（Issue #266実装方針）。
 *
 * ここではイベントのタイトル・説明・参加者・主催者等のPIIには一切触れず、
 * 開始・終了時刻と終日フラグだけを取り出す。
 */
'use strict';

var CalendarRepository = (function () {
  var MINUTES_PER_DAY = 24 * 60;

  /*
   * calendarId: Script Propertiesで管理するCalendar ID
   * dateString: 'YYYY-MM-DD'（timezoneでの暦日）
   * timezone: 例 'Asia/Tokyo'
   *
   * 戻り値: [{ startMinutes, endMinutes, isAllDay }]
   * - 終日イベントは isAllDay:true とし、startMinutes/endMinutesは0固定（Availability.gs側で除外する）
   * - 対象日をまたぐ時間指定イベントは、対象日の範囲[0, 1440]にクランプする
   */
  function getBusyIntervalsForDate(calendarId, dateString, timezone) {
    var dayStart = Utilities.parseDate(dateString + ' 00:00:00', timezone, 'yyyy-MM-dd HH:mm:ss');
    var dayEnd = new Date(dayStart.getTime() + MINUTES_PER_DAY * 60 * 1000);

    var calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) {
      throw new Error('Calendarが見つかりません。CALENDAR_IDの設定を確認してください。');
    }

    var events = calendar.getEvents(dayStart, dayEnd);

    return events.map(function (event) {
      if (event.isAllDayEvent()) {
        return { startMinutes: 0, endMinutes: 0, isAllDay: true };
      }
      var startMinutes = Math.round((event.getStartTime().getTime() - dayStart.getTime()) / 60000);
      var endMinutes = Math.round((event.getEndTime().getTime() - dayStart.getTime()) / 60000);
      return {
        startMinutes: Math.max(0, startMinutes),
        endMinutes: Math.min(MINUTES_PER_DAY, endMinutes),
        isAllDay: false
      };
    });
  }

  return {
    getBusyIntervalsForDate: getBusyIntervalsForDate
  };
})();
