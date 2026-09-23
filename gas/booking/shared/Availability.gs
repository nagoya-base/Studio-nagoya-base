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

  var WEEKDAY_LABELS_JA_ = ['日', '月', '火', '水', '木', '金', '土'];

  /*
   * dateString（'YYYY-MM-DD'）に日本語の曜日を付けて'YYYY-MM-DD（月）'形式にする（Issue #311）。
   * record.dateはformatDateInTimezoneで正規化済みの文字列でありDate型ではないため、
   * new Date(dateString).getDay()のようなGAS実行環境のローカルtimezoneに依存する変換は使わず、
   * isValidDateStringと同じDate.UTC構築方式（Date.UTC(y, m-1, d) + getUTCDay()）で曜日を
   * 算出する。dateStringが不正な場合はそのまま返す（fail-closedに例外を投げて通知メール
   * 自体を止めない）。AdminNotifier.gs / BookingMailTemplates.gsの両方がこの関数を共有し、
   * 曜日変換ロジックを二重実装しない。
   */
  function formatDateWithWeekday(dateString) {
    if (!isValidDateString(dateString)) return dateString;
    var parts = dateString.split('-');
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var day = parseInt(parts[2], 10);
    var weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    return dateString + '（' + WEEKDAY_LABELS_JA_[weekday] + '）';
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

  /*
   * 月間空き状況（Issue #318）の日次ステータス5値。GAS/フロント(scripts/booking-logic.js)の
   * 両方でこの5文字列をそのまま使う（表示記号・文言への変換はフロント側の責務）。
   * OUT_OF_RANGE: 過去日など予約対象外。それ以外は当日以降の日について、
   * computeBookableStartTimesの件数を閾値でバケット分けしたもの。
   */
  var DAY_STATUS = {
    AVAILABLE_HIGH: 'AVAILABLE_HIGH',
    AVAILABLE: 'AVAILABLE',
    LIMITED: 'LIMITED',
    FULL: 'FULL',
    OUT_OF_RANGE: 'OUT_OF_RANGE'
  };

  /*
   * 閾値定義（Issue #318追記対応。ハードコードを分散させず、ここに一元化する）。
   * count: その日にcomputeBookableStartTimesで実際に得られた開始時刻の件数。
   * maxPossible: 同じ日・同じduration・同じminimumStartMinutes（当日なら現在時刻フィルタも
   *   同条件）で、既存予約が一切無かった場合に得られる件数（＝その日に理論上あり得る
   *   最大件数。営業時間・最低利用時間・15分刻みという既存の固定仕様から機械的に決まる）。
   * ratio = count / maxPossible を使い、既存予約でどれだけ枠が埋まっているかの割合で
   * 判定する（絶対件数だけで判定すると、利用時間が長いほど分母となる総枠数自体が
   * 少なくなり、閾値の意味が利用時間ごとに変わってしまうため）。
   *
   * - count === 0（またはmaxPossible === 0＝その利用時間では1件も入らない日）→ FULL
   * - ratio <= 1/3（残り枠が理論上の1/3以下）→ LIMITED（△ 残り枠が少ない）
   * - ratio >= 2/3（理論上の2/3以上が空いている）→ AVAILABLE_HIGH（◎ 十分ある）
   * - それ以外 → AVAILABLE（○ 空きあり）
   */
  var LIMITED_RATIO_THRESHOLD_ = 1 / 3;
  var HIGH_RATIO_THRESHOLD_ = 2 / 3;

  function classifyDayStatus_(count, maxPossible) {
    if (count <= 0 || maxPossible <= 0) return DAY_STATUS.FULL;
    var ratio = count / maxPossible;
    if (ratio <= LIMITED_RATIO_THRESHOLD_) return DAY_STATUS.LIMITED;
    if (ratio >= HIGH_RATIO_THRESHOLD_) return DAY_STATUS.AVAILABLE_HIGH;
    return DAY_STATUS.AVAILABLE;
  }

  /*
   * 希望時間帯フィルタ（Issue #324）。月間空き状況カレンダーの記号判定対象となる
   * 開始時刻候補を、開始時刻基準で4値に絞り込む。単日getAvailabilityの仕様・
   * スロット生成/重複判定ロジック（computeBookableStartTimes）は一切変更しない。
   *
   * - all: 絞り込みなし（現在の全日判定と同一結果になること）
   * - morning: 08:00〜11:45開始
   * - daytime: 12:00〜17:45開始
   * - evening: 18:00以降開始
   *
   * timeBandが未指定、またはこの4値以外の場合はエラーにせずallへフォールバックする
   * （normalizeTimeBand）。GitHub PagesとBooking GASは別々にデプロイされるため、
   * デプロイ過渡期に「timeBandを送らない旧フロント」×「新GAS」の組み合わせが
   * 一時的に発生し得ることへの対応（Issue #324本文レビュー追記4）。
   */
  var TIME_BANDS = {
    ALL: 'all',
    MORNING: 'morning',
    DAYTIME: 'daytime',
    EVENING: 'evening'
  };
  var ALLOWED_TIME_BANDS_ = [TIME_BANDS.ALL, TIME_BANDS.MORNING, TIME_BANDS.DAYTIME, TIME_BANDS.EVENING];

  function normalizeTimeBand(value) {
    return ALLOWED_TIME_BANDS_.indexOf(value) !== -1 ? value : TIME_BANDS.ALL;
  }

  var MORNING_START_MINUTES_ = 8 * 60;        /* 08:00 */
  var MORNING_END_MINUTES_ = 11 * 60 + 45;    /* 11:45 */
  var DAYTIME_START_MINUTES_ = 12 * 60;       /* 12:00 */
  var DAYTIME_END_MINUTES_ = 17 * 60 + 45;    /* 17:45 */
  var EVENING_START_MINUTES_ = 18 * 60;       /* 18:00 */

  function isStartMinutesInTimeBand_(startMinutes, timeBand) {
    if (timeBand === TIME_BANDS.MORNING) {
      return startMinutes >= MORNING_START_MINUTES_ && startMinutes <= MORNING_END_MINUTES_;
    }
    if (timeBand === TIME_BANDS.DAYTIME) {
      return startMinutes >= DAYTIME_START_MINUTES_ && startMinutes <= DAYTIME_END_MINUTES_;
    }
    if (timeBand === TIME_BANDS.EVENING) {
      return startMinutes >= EVENING_START_MINUTES_;
    }
    return true; /* all */
  }

  /*
   * startTimes（computeBookableStartTimesが返す'HH:mm'配列）をtimeBandで絞り込む。
   * classifyDayStatus_へ渡すcount・maxPossibleの両方に同じ関数を適用し、分母
   * （maxPossible）も同じtimeBandで絞り込むこと（Issue #324本文レビュー追記1。
   * 分母を絞らないと記号判定が実態より悪く出る）。
   */
  function filterStartTimesByTimeBand(startTimes, timeBand) {
    var band = normalizeTimeBand(timeBand);
    var list = startTimes || [];
    if (band === TIME_BANDS.ALL) return list.slice();
    return list.filter(function (time) {
      return isStartMinutesInTimeBand_(parseTimeToMinutes_(time), band);
    });
  }

  function isValidYearMonth_(year, month) {
    return Number.isInteger(year) && year >= 2000 && year <= 3000 &&
      Number.isInteger(month) && month >= 1 && month <= 12;
  }

  function validateMonthlyInput(year, month, durationMinutes, config) {
    if (!isValidYearMonth_(year, month)) {
      return { code: 'INVALID_MONTH', message: '年月の指定が正しくありません。' };
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

  function daysInMonth_(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function pad2_(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /*
   * request: { year, month, durationMinutes, brand }
   * busyIntervalsByDate: CalendarRepository.getBusyIntervalsForRangeの戻り値
   *   （{ 'YYYY-MM-DD': busyIntervals, ... }。対象月の全日付ぶんを含むこと）
   * config: BookingConfig.getAvailabilityConfig()の戻り値
   * now: 現在時刻（Date）。省略時は現在時刻。
   *
   * 日ごとのステータスは、既存のcomputeBookableStartTimes（getAvailabilityと同一関数）を
   * 日ごとのbusyIntervalsに対して呼び出し、件数を閾値でバケット分けするだけで求める
   * （スロット生成ロジック自体の再実装はしない。Issue #318追記のレビュー対応）。
   * 当日は既存のgetAvailabilityと同じくminimumStartMinutesで現在時刻以前を除外し、
   * 過去日はOUT_OF_RANGEとしてcomputeBookableStartTimesを呼ばない。
   * 戻り値にはイベントタイトル・説明・参加者等のPIIを一切含めない（getAvailabilityと同じ方針）。
   */
  function getMonthlyAvailability(request, busyIntervalsByDate, config, now) {
    var year = request && request.year;
    var month = request && request.month;
    var durationMinutes = request && request.durationMinutes;
    var brand = (request && request.brand) || null;
    var timeBand = normalizeTimeBand(request && request.timeBand);

    var validationError = validateMonthlyInput(year, month, durationMinutes, config);
    if (validationError) {
      return { success: false, error: validationError };
    }

    var receivedAt = isDateLike_(now) ? now : new Date();
    var todayString = formatDateInTimezone(receivedAt, config.timezone);
    if (!todayString) {
      return { success: false, error: { code: 'INVALID_CONFIG', message: '営業時間・予約ルールの設定が正しくありません。' } };
    }

    var monthString = year + '-' + pad2_(month);
    var totalDays = daysInMonth_(year, month);
    var days = {};

    for (var day = 1; day <= totalDays; day++) {
      var dateString = monthString + '-' + pad2_(day);

      if (dateString < todayString) {
        days[dateString] = { status: DAY_STATUS.OUT_OF_RANGE, availableStartTimes: 0 };
        continue;
      }

      var minimumStartMinutes = null;
      if (dateString === todayString) {
        minimumStartMinutes = getCurrentMinutesInTimezone(receivedAt, config.timezone);
        if (minimumStartMinutes === null) {
          return { success: false, error: { code: 'INVALID_CONFIG', message: '営業時間・予約ルールの設定が正しくありません。' } };
        }
      }

      var busyIntervals = (busyIntervalsByDate && busyIntervalsByDate[dateString]) || [];
      var bookable = filterStartTimesByTimeBand(
        computeBookableStartTimes(durationMinutes, busyIntervals, config, minimumStartMinutes),
        timeBand
      );
      var maxPossible = filterStartTimesByTimeBand(
        computeBookableStartTimes(durationMinutes, [], config, minimumStartMinutes),
        timeBand
      );

      days[dateString] = {
        status: classifyDayStatus_(bookable.length, maxPossible.length),
        availableStartTimes: bookable.length
      };
    }

    return {
      success: true,
      month: monthString,
      durationMinutes: durationMinutes,
      brand: brand,
      days: days
    };
  }

  return {
    isValidDateString: isValidDateString,
    formatDateWithWeekday: formatDateWithWeekday,
    isValidTimeString: isValidTimeString,
    parseTimeToMinutes: parseTimeToMinutes_,
    formatDateInTimezone: formatDateInTimezone,
    formatTimeInTimezone: formatTimeInTimezone,
    getCurrentMinutesInTimezone: getCurrentMinutesInTimezone,
    validateInput: validateInput,
    computeBookableStartTimes: computeBookableStartTimes,
    isStartTimeBookable: isStartTimeBookable,
    getAvailability: getAvailability,
    DAY_STATUS: DAY_STATUS,
    TIME_BANDS: TIME_BANDS,
    normalizeTimeBand: normalizeTimeBand,
    filterStartTimesByTimeBand: filterStartTimesByTimeBand,
    validateMonthlyInput: validateMonthlyInput,
    getMonthlyAvailability: getMonthlyAvailability
  };
})();
