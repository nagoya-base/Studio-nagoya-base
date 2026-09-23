/*
 * CalendarRepository.gs — Google Calendarへのアクセス（Issue #266: 読み取り専用 / Issue #268: 予約作成・状態変更）。
 *
 * 対象日のイベントを1回のCalendar API呼び出しでまとめて取得し、Availability.gsが
 * メモリ上で判定できる形（当日00:00からの経過分単位の占有区間）へ変換する。
 * 1スロットごとにCalendar APIを叩かない（Issue #266実装方針）。
 *
 * getBusyIntervalsForDateではイベントのタイトル・説明・参加者・主催者等のPIIには
 * 一切触れず、開始・終了時刻と終日フラグだけを取り出す。
 *
 * Issue #268で追加したcreateBookingEvent等は、Calendarイベントに氏名・メール等の
 * PIIを一切書き込まない（タイトルは「[ブランド名 状態] bookingId」の形式のみ。
 * 詳細はSpreadsheet台帳側にのみ保存する）。bookingId・status・brandはCalendarEventの
 * setTag/getTagで保持し、タイトル文字列に判定ロジックを依存させない
 * （Issue #269でSNB/mens/Studio Xの3ブランドに拡張したが、3ブランドとも同一室・
 * 同一Calendarのため空き判定はタイトルにもbrandにも依存しない。ブランド表示名は
 * Booking.getBrandLabelを経由し、このファイルではbrand文字列を持たない）。
 */
'use strict';

var CalendarRepository = (function () {
  var MINUTES_PER_DAY = 24 * 60;

  /* Calendarイベントのタイトルは人が一覧で状態を把握するための表示用に過ぎず、
     空き判定・状態判定のいずれのロジックもこの文字列には依存しない（setTagが正）。
     ブランド名はBooking.getBrandLabelから取得し、ここではbrand文字列を持たない。 */
  var STATUS_LABEL_ = {
    PENDING: '仮予約',
    CONFIRMED: '確定',
    CANCELLED: 'キャンセル',
    EXPIRED: '期限切れ'
  };

  function buildEventTitle_(brand, status, bookingId) {
    var brandLabel = Booking.getBrandLabel(brand) || '予約';
    var statusLabel = STATUS_LABEL_[status] || status;
    return '[' + brandLabel + ' ' + statusLabel + '] ' + bookingId;
  }

  function getCalendarOrThrow_(calendarId) {
    var calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) {
      throw new Error('Calendarが見つかりません。CALENDAR_IDの設定を確認してください。');
    }
    return calendar;
  }

  /* dateString: 'YYYY-MM-DD'、timeString: 'HH:mm'、timezone: 例 'Asia/Tokyo' */
  function parseDateTime(dateString, timeString, timezone) {
    return Utilities.parseDate(dateString + ' ' + timeString + ':00', timezone, 'yyyy-MM-dd HH:mm:ss');
  }

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
    var dayStart = parseDateTime(dateString, '00:00', timezone);
    var dayEnd = new Date(dayStart.getTime() + MINUTES_PER_DAY * 60 * 1000);

    var calendar = getCalendarOrThrow_(calendarId);
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

  /*
   * calendarId: Script Propertiesで管理するCalendar ID
   * startDate/endDate: 'YYYY-MM-DD'（timezoneでの暦日。両端を含む区間）
   * timezone: 例 'Asia/Tokyo'
   *
   * 月間空き状況（Issue #318）のために、[startDate, endDate]区間全体を
   * calendar.getEvents()の呼び出し1回だけで取得し、日ごとのbusyIntervalsへ振り分ける。
   * 1日ごとにgetEvents()を呼ぶ実装は不可（Issue #318追記のレビュー対応）。
   *
   * 戻り値: { 'YYYY-MM-DD': [{ startMinutes, endMinutes, isAllDay }], ... }
   * （区間内の全日付ぶんのキーを必ず含む。該当イベントが無い日は空配列）
   * 各日の値の形はgetBusyIntervalsForDateの戻り値と同一（呼び出し側のAvailability.gsが
   * 同じ形として扱えるようにするため。日をまたぐイベントの対象日クランプ規則も同じ）。
   */
  function getBusyIntervalsForRange(calendarId, startDate, endDate, timezone) {
    var rangeStart = parseDateTime(startDate, '00:00', timezone);
    var rangeEnd = new Date(parseDateTime(endDate, '00:00', timezone).getTime() + MINUTES_PER_DAY * 60 * 1000);

    var calendar = getCalendarOrThrow_(calendarId);
    var events = calendar.getEvents(rangeStart, rangeEnd);

    var result = {};
    buildDateRange_(startDate, endDate).forEach(function (dateString) {
      var dayStart = parseDateTime(dateString, '00:00', timezone);
      var dayEnd = new Date(dayStart.getTime() + MINUTES_PER_DAY * 60 * 1000);

      result[dateString] = events
        .filter(function (event) {
          return event.getStartTime().getTime() < dayEnd.getTime() && event.getEndTime().getTime() > dayStart.getTime();
        })
        .map(function (event) {
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
    });
    return result;
  }

  /* startDate〜endDate（両端含む、'YYYY-MM-DD'）の日付文字列を1日刻みで列挙する。
     Date.UTC構築方式（Availability.gsのisValidDateString等と同じ方針）で、
     実行環境のローカルtimezoneに依存しない。 */
  function buildDateRange_(startDate, endDate) {
    var start = parseYmd_(startDate);
    var end = parseYmd_(endDate);
    var cursor = Date.UTC(start.year, start.month - 1, start.day);
    var last = Date.UTC(end.year, end.month - 1, end.day);
    var dates = [];
    while (cursor <= last) {
      dates.push(formatYmd_(cursor));
      cursor += MINUTES_PER_DAY * 60 * 1000;
    }
    return dates;
  }

  function parseYmd_(dateString) {
    var parts = dateString.split('-');
    return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10), day: parseInt(parts[2], 10) };
  }

  function formatYmd_(utcMillis) {
    var d = new Date(utcMillis);
    var year = d.getUTCFullYear();
    var month = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    return year + '-' + (month < 10 ? '0' : '') + month + '-' + (day < 10 ? '0' : '') + day;
  }

  /*
   * PENDING状態のCalendarイベントを作成する（createBooking用）。
   * params: { date, startTime, durationMinutes, timezone, bookingId, brand }
   * 戻り値: 作成したイベントのCalendar Event ID（Sheets台帳との照合キー）。
   *
   * 氏名・メール・電話等のPIIはタイトル・説明のいずれにも書き込まない。
   */
  function createBookingEvent(calendarId, params) {
    var calendar = getCalendarOrThrow_(calendarId);
    var start = parseDateTime(params.date, params.startTime, params.timezone);
    var end = new Date(start.getTime() + params.durationMinutes * 60000);
    var title = buildEventTitle_(params.brand, 'PENDING', params.bookingId);

    var event = calendar.createEvent(title, start, end);
    event.setTag('bookingId', params.bookingId);
    event.setTag('status', 'PENDING');
    event.setTag('brand', params.brand);
    return event.getId();
  }

  /* 存在しない場合はnullを返す（例外にしない）。呼び出し側が「見つからない」ことを
     部分失敗として扱えるようにするため。 */
  function getEventById(calendarId, eventId) {
    var calendar = getCalendarOrThrow_(calendarId);
    return calendar.getEventById(eventId) || null;
  }

  /* 対象イベントが存在しない場合は例外を投げる（呼び出し側でtry/catchし、
     recoveryへ記録するかどうかを判断する。#268の部分失敗補償の要件のため）。 */
  function deleteEventById(calendarId, eventId) {
    var event = getEventById(calendarId, eventId);
    if (!event) {
      throw new Error('削除対象のCalendarイベントが見つかりません: ' + eventId);
    }
    event.deleteEvent();
  }

  /* confirmBooking等でPENDING以外の状態へ遷移させる際、タイトルとstatusタグを更新する。
     ブランド名は呼び出し側から渡させず、作成時にsetTagしたbrandタグから読み取る
     （brand文字列を呼び出し元へ伝播させない・複数箇所でのbrand取り違えを避けるため）。
     イベントが見つからない場合は例外を投げる（confirmBooking側でrecoveryへ記録）。 */
  function setEventStatus(calendarId, eventId, status, bookingId) {
    var event = getEventById(calendarId, eventId);
    if (!event) {
      throw new Error('Calendarイベントが見つかりません: ' + eventId);
    }
    event.setTitle(buildEventTitle_(event.getTag('brand'), status, bookingId));
    event.setTag('status', status);
  }

  /*
   * cancelBookingAdmin（Issue #272）の「Sheets行が無い場合のCalendar診断」専用。
   * 対象日のCalendarイベントのうち、bookingIdタグが一致するものだけを返す
   * （タイトル文字列検索には依存しない。スペースマーケット等の外部イベントは
   * bookingIdタグを持たないため対象外になる）。PII・brandは検索条件に使わない。
   * 通常のキャンセル処理ではSheetsのcalendarEventIdを正として使い、この関数は
   * 異常時のRecovery支援としてのみ呼ぶ。戻り値は配列（0/1/複数件を呼び出し側で区別する）。
   */
  function findBookingEventsByBookingId(calendarId, bookingId, dateString, timezone) {
    var dayStart = parseDateTime(dateString, '00:00', timezone);
    var dayEnd = new Date(dayStart.getTime() + MINUTES_PER_DAY * 60 * 1000);
    var calendar = getCalendarOrThrow_(calendarId);
    var events = calendar.getEvents(dayStart, dayEnd);
    return events.filter(function (event) {
      return event.getTag('bookingId') === bookingId;
    });
  }

  return {
    getBusyIntervalsForDate: getBusyIntervalsForDate,
    getBusyIntervalsForRange: getBusyIntervalsForRange,
    parseDateTime: parseDateTime,
    createBookingEvent: createBookingEvent,
    getEventById: getEventById,
    deleteEventById: deleteEventById,
    setEventStatus: setEventStatus,
    findBookingEventsByBookingId: findBookingEventsByBookingId
  };
})();
