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
 *
 * Issue #270（レビュー対応）で追加した当日の過去時刻除外:
 * - date/getCurrentMinutesInTimezoneを使い、利用日が当日（config.timezone基準）の場合のみ、
 *   現在時刻以前（ちょうど含む）の開始時刻を候補から除外する。customerTypeルールは
 *   ここに一切持ち込まない（当日+初回利用の可否判定はBooking.gs/createBookingの責務）。
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

  function isPositiveInteger_(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
  }

  /* instanceof Dateではなくダックタイピングで判定する（別realm・vmサンドボックスを
     またぐテストでinstanceof Dateが偽陰性になるため。他ファイルのisDateLike_と同じ方針）。 */
  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  /*
   * dateを指定timezoneの暦日として'YYYY-MM-DD'へ変換する（Issue #270）。
   * 当日判定はブラウザのローカルtimezone・GAS実行環境timezoneに依存させず、
   * 必ずこの関数でconfig.timezone（既定Asia/Tokyo）基準に統一する。
   * getAvailability（このファイル）とcreateBooking（Booking.gsが
   * BookingAvailability.formatDateInTimezoneとして再利用する）の両方で共有する。
   * timezoneが不正でIntlが例外を投げた場合はnullを返す（呼び出し側でfail-closedに扱う）。
   */
  function formatDateInTimezone(date, timezone) {
    if (!isDateLike_(date)) return null;
    try {
      var parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
      }).formatToParts(date);
      var result = {};
      parts.forEach(function (part) { if (part.type !== 'literal') result[part.type] = part.value; });
      if (!result.year || !result.month || !result.day) return null;
      return result.year + '-' + result.month + '-' + result.day;
    } catch (e) {
      return null;
    }
  }

  /*
   * dateを指定timezoneの「00:00からの経過分」（0〜1439）へ変換する（Issue #270）。
   * getAvailability「当日は現在時刻以前の開始時刻を返さない」、createBooking
   * 「当日は現在時刻以前の開始時刻をSAME_DAY_START_TIME_PASSEDで拒否する」の両方が
   * この関数を共有するテスト可能な共通ヘルパー。ブラウザのローカルtimezone・
   * GAS実行環境timezoneに依存しない。timezoneが不正な場合はnullを返す
   * （呼び出し側でfail-closedに扱う）。
   */
  function getCurrentMinutesInTimezone(date, timezone) {
    if (!isDateLike_(date)) return null;
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(date);
      var hour = null;
      var minute = null;
      parts.forEach(function (part) {
        if (part.type === 'hour') hour = parseInt(part.value, 10);
        if (part.type === 'minute') minute = parseInt(part.value, 10);
      });
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
      return hour * 60 + minute;
    } catch (e) {
      return null;
    }
  }

  /*
   * dateを指定timezoneの'HH:mm'へ変換する（Issue #271。メールテンプレートの開始/終了時刻表示用）。
   * getCurrentMinutesInTimezoneと同じIntl.DateTimeFormatベースの実装を共有し、
   * ブラウザ・GAS実行環境のローカルtimezoneに依存しない。timezoneが不正な場合はnullを返す。
   */
  function formatTimeInTimezone(date, timezone) {
    if (!isDateLike_(date)) return null;
    try {
      var parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
      }).formatToParts(date);
      var hour = null;
      var minute = null;
      parts.forEach(function (part) {
        if (part.type === 'hour') hour = part.value;
        if (part.type === 'minute') minute = part.value;
      });
      if (hour === null || minute === null) return null;
      return hour + ':' + minute;
    } catch (e) {
      return null;
    }
  }

  function isNonNegativeInteger_(value) {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
  }

  /*
   * Script Propertiesの誤設定・欠落をfail-closedに検出する（マージ前レビュー指摘対応）。
   * ここを通さないと、例えば BUFFER_MINUTES=abc（NaN）で占有区間の前後バッファ計算が
   * NaNになり、比較が常にfalseへ倒れて既存予約を空きと誤判定する恐れがある。
   * また SLOT_STEP_MINUTES=0 だと候補スロット生成のfor文が進まずタイムアウトする。
   */
  function isValidConfig_(config) {
    if (!config) return false;
    if (!isValidTimeString_(config.openTime) || !isValidTimeString_(config.closeTime)) return false;
    if (parseTimeToMinutes_(config.openTime) >= parseTimeToMinutes_(config.closeTime)) return false;
    if (!isPositiveInteger_(config.minBookingMinutes)) return false;
    if (!isNonNegativeInteger_(config.bufferMinutes)) return false;
    if (!isPositiveInteger_(config.slotStepMinutes)) return false;
    return true;
  }

  function validateInput(date, durationMinutes, config) {
    if (!isValidDateString(date)) {
      return { code: 'INVALID_DATE', message: '日付の形式が正しくありません（YYYY-MM-DD）。' };
    }
    if (!isValidConfig_(config)) {
      return { code: 'INVALID_CONFIG', message: '営業時間・予約ルールの設定が正しくありません。' };
    }
    if (!isPositiveInteger_(durationMinutes)) {
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

  /* busyIntervals（終日イベント含む）から、bufferMinutesぶん前後に拡張した占有区間の
     配列を作る。computeBookableStartTimes・isStartTimeBookableの両方から使う共通ロジック。 */
  function computeBlockedRanges_(busyIntervals, bufferMinutes) {
    return (busyIntervals || [])
      .filter(function (interval) { return interval && !interval.isAllDay; })
      .map(function (interval) {
        return { start: interval.startMinutes - bufferMinutes, end: interval.endMinutes + bufferMinutes };
      });
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
   *
   * minimumStartMinutes（Issue #270で追加。省略可）: 指定した場合、
   * start <= minimumStartMinutes（現在時刻ちょうど含む）の候補を除外する。
   * getAvailabilityが「当日は現在時刻以前の開始時刻を返さない」ために使う
   * （省略時は既存どおり全候補を返す。customerTypeルールはここに一切持ち込まない）。
   */
  function computeBookableStartTimes(durationMinutes, busyIntervals, config, minimumStartMinutes) {
    var openMinutes = parseTimeToMinutes_(config.openTime);
    var closeMinutes = parseTimeToMinutes_(config.closeTime);
    var step = config.slotStepMinutes;
    var blockedRanges = computeBlockedRanges_(busyIntervals, config.bufferMinutes);
    var floor = typeof minimumStartMinutes === 'number' ? minimumStartMinutes : -Infinity;

    var bookable = [];
    for (var start = openMinutes; start + durationMinutes <= closeMinutes; start += step) {
      if (start <= floor) continue;
      if (isRangeFree_(start, start + durationMinutes, blockedRanges)) bookable.push(minutesToTime_(start));
    }
    return bookable;
  }

  function isRangeFree_(start, end, blockedRanges) {
    return !blockedRanges.some(function (range) {
      return start < range.end && end > range.start;
    });
  }

  /*
   * createBooking（Issue #268）が、Lock取得後の直前再確認で使う単一スロット判定。
   * computeBookableStartTimesと同じ「buffer込みの占有区間に重ならないか」だけを見る。
   * openTime/closeTimeの範囲チェックはvalidateCreateBookingInput側の責務とし、
   * ここでは営業時間外の呼び出しかどうかは判定しない（純粋に空き重複だけを見る）。
   */
  function isStartTimeBookable(startMinutes, durationMinutes, busyIntervals, bufferMinutes) {
    var blockedRanges = computeBlockedRanges_(busyIntervals, bufferMinutes);
    return isRangeFree_(startMinutes, startMinutes + durationMinutes, blockedRanges);
  }

  function isValidTimeString(value) {
    return isValidTimeString_(value);
  }

  /*
   * request: { date, durationMinutes, brand }
   * busyIntervals: CalendarRepository.getBusyIntervalsForDateの戻り値
   * config: BookingConfig.getAvailabilityConfig()の戻り値
   * now: 現在時刻（Date）。省略時は現在時刻。当日の過去時刻除外に使う（Issue #270）。
   *
   * 戻り値にはイベントタイトル・説明・参加者・氏名・メール等のPIIを一切含めない。
   * brandは表示・流入元識別のためにエコーバックするだけで、判定ロジックには使わない。
   * customerTypeはgetAvailabilityの引数・応答のいずれにも登場しない
   * （当日+初回利用の可否判定はBooking.gs/createBookingの責務。Issue #270レビュー対応）。
   */
  function getAvailability(request, busyIntervals, config, now) {
    var date = request && request.date;
    var durationMinutes = request && request.durationMinutes;
    var brand = (request && request.brand) || null;

    var validationError = validateInput(date, durationMinutes, config);
    if (validationError) {
      return { success: false, error: validationError };
    }

    var receivedAt = isDateLike_(now) ? now : new Date();
    var todayString = formatDateInTimezone(receivedAt, config.timezone);
    if (!todayString) {
      return { success: false, error: { code: 'INVALID_CONFIG', message: '営業時間・予約ルールの設定が正しくありません。' } };
    }

    /*
     * 過去日はfail-closedに拒否する（2回目レビュー指摘対応）。createBooking
     * （Booking.validateCreateBookingInput）と同じ判定・同じerror.code/messageに揃え、
     * API間で意味を統一する。当日・翌日以降の判定はこの下で従来どおり行う。
     */
    if (date < todayString) {
      return { success: false, error: { code: 'INVALID_DATE', message: '過去の日付は指定できません。' } };
    }

    var minimumStartMinutes = null;
    if (date === todayString) {
      minimumStartMinutes = getCurrentMinutesInTimezone(receivedAt, config.timezone);
      if (minimumStartMinutes === null) {
        return { success: false, error: { code: 'INVALID_CONFIG', message: '営業時間・予約ルールの設定が正しくありません。' } };
      }
    }

    var bookableStartTimes = computeBookableStartTimes(durationMinutes, busyIntervals, config, minimumStartMinutes);

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
    isValidTimeString: isValidTimeString,
    parseTimeToMinutes: parseTimeToMinutes_,
    formatDateInTimezone: formatDateInTimezone,
    formatTimeInTimezone: formatTimeInTimezone,
    getCurrentMinutesInTimezone: getCurrentMinutesInTimezone,
    validateInput: validateInput,
    computeBookableStartTimes: computeBookableStartTimes,
    isStartTimeBookable: isStartTimeBookable,
    getAvailability: getAvailability
  };
})();
