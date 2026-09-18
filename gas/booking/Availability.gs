/*
 * Availability.gs — getAvailability（Issue #266）の空き判定ロジック本体。
 *
 * CalendarApp / PropertiesService等のGAS組み込みサービスに一切依存しない
 * 純粋なロジックのみを置く（vmでそのまま実行してテストできるようにするため）。
 *
 * 固定仕様（Issue #265/#266。実装中に変更しない）:
 * - 営業時間 08:00〜23:00
 * - 最低利用時間 120分
 * - 開始時刻は15分刻み
 * - 予約同士の間隔は15分以上必須
 * - 08:00開始時の前マージン・23:00終了時の後マージンは不要
 * - 終日イベントは空き枠を占有しない
 * - SNB / mens / Studio Xは同一室のため、brandで空き判定を分岐させない
 */
'use strict';

var BookingAvailability = (function () {
  var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function parseTimeToMinutes_(hhmm) {
    var parts = hhmm.split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function minutesToTime_(minutes) {
    var h = Math.floor(minutes / 60);
    var m = minutes % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function isValidDateString(date) {
    if (typeof date !== 'string' || !DATE_PATTERN.test(date)) return false;
    var parts = date.split('-');
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var day = parseInt(parts[2], 10);
    if (month < 1 || month > 12) return false;
    var daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (day < 1 || day > daysInMonth) return false;
    return true;
  }

  /* config.openTime / config.closeTime のような 'HH:mm' 文字列の形式検証。
     Script Propertiesの入力ミスでも判定が壊れないようにする。 */
  function isValidTimeString_(value) {
    return typeof value === 'string' && TIME_PATTERN.test(value);
  }

  function validateInput(date, durationMinutes, config) {
    if (!isValidDateString(date)) {
      return { code: 'INVALID_DATE', message: '日付の形式が正しくありません（YYYY-MM-DD）。' };
    }
    if (!config || !isValidTimeString_(config.openTime) || !isValidTimeString_(config.closeTime)) {
      return { code: 'INVALID_CONFIG', message: '営業時間の設定が正しくありません。' };
    }
    if (typeof durationMinutes !== 'number' || isNaN(durationMinutes) || durationMinutes <= 0) {
      return { code: 'INVALID_DURATION', message: '利用時間（分）が正しくありません。' };
    }
    if (durationMinutes < config.minBookingMinutes) {
      return {
        code: 'DURATION_TOO_SHORT',
        message: '最低利用時間（' + config.minBookingMinutes + '分）未満です。'
      };
    }
    return null;
  }

  /*
   * busyIntervals: [{ startMinutes, endMinutes, isAllDay }]（当日00:00からの経過分）
   * 戻り値: 'HH:mm' 形式の予約可能開始時刻の配列
   *
   * 判定方法: 終日イベントを除いた各占有区間の前後にbufferMinutesを加えた
   * 「拡張区間」を作り、候補スロット [start, start+durationMinutes) が
   * どの拡張区間とも重ならない場合だけ予約可能とする。
   * 営業開始・終業の境界自体には拡張を適用しないため、08:00開始・23:00終了に
   * 前後マージンは要求されない。
   */
  function computeBookableStartTimes(durationMinutes, busyIntervals, config) {
    var openMinutes = parseTimeToMinutes_(config.openTime);
    var closeMinutes = parseTimeToMinutes_(config.closeTime);
    var step = config.slotStepMinutes;
    var buffer = config.bufferMinutes;

    var blockedRanges = (busyIntervals || [])
      .filter(function (interval) { return interval && !interval.isAllDay; })
      .map(function (interval) {
        return { start: interval.startMinutes - buffer, end: interval.endMinutes + buffer };
      });

    var bookable = [];
    for (var start = openMinutes; start + durationMinutes <= closeMinutes; start += step) {
      var end = start + durationMinutes;
      var isBlocked = blockedRanges.some(function (range) {
        return start < range.end && end > range.start;
      });
      if (!isBlocked) bookable.push(minutesToTime_(start));
    }
    return bookable;
  }

  /*
   * request: { date, durationMinutes, brand }
   * busyIntervals: CalendarRepository.getBusyIntervalsForDateの戻り値
   * config: BookingConfig.getAvailabilityConfig()の戻り値
   *
   * 戻り値にはイベントタイトル・説明・参加者・氏名・メール等のPIIを一切含めない。
   * brandは表示・流入元識別のためにエコーバックするだけで、判定ロジックには使わない。
   */
  function getAvailability(request, busyIntervals, config) {
    var date = request && request.date;
    var durationMinutes = request && request.durationMinutes;
    var brand = (request && request.brand) || null;

    var validationError = validateInput(date, durationMinutes, config);
    if (validationError) {
      return { success: false, error: validationError };
    }

    var bookableStartTimes = computeBookableStartTimes(durationMinutes, busyIntervals, config);

    return {
      success: true,
      date: date,
      durationMinutes: durationMinutes,
      brand: brand,
      bookableStartTimes: bookableStartTimes
    };
  }

  return {
    isValidDateString: isValidDateString,
    validateInput: validateInput,
    computeBookableStartTimes: computeBookableStartTimes,
    getAvailability: getAvailability
  };
})();
