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

  return {
    getBusyIntervalsForDate: getBusyIntervalsForDate,
    parseDateTime: parseDateTime,
    createBookingEvent: createBookingEvent,
    getEventById: getEventById,
    deleteEventById: deleteEventById,
    setEventStatus: setEventStatus
  };
})();
