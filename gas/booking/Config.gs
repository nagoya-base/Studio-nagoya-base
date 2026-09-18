/*
 * Config.gs — 自社予約システム（Issue #266）の固定仕様値とScript Propertiesの読み出し。
 *
 * Script Propertiesに未設定の項目は、Issue #265/#266で固定された仕様値を
 * デフォルトとして使う。CALENDAR_IDのみ必須（未設定ならエラーにする）。
 *
 * このファイルはPropertiesServiceに依存するため、実際のGAS実行環境でのみ
 * 完全に動作する（vmテストではPropertiesServiceをスタブして検証する）。
 */
'use strict';

var BookingConfig = (function () {
  var DEFAULTS = {
    TIMEZONE: 'Asia/Tokyo',
    OPEN_TIME: '08:00',
    CLOSE_TIME: '23:00',
    MIN_BOOKING_MINUTES: '120',
    BUFFER_MINUTES: '15',
    SLOT_STEP_MINUTES: '15'
  };

  /* 先頭に-を許すが、小数点・空白・数字以外の文字を一切許さない厳密な整数文字列のみ受理する。
     parseInt()単体だと"15abc"や"15.5"の先頭部分だけを緩く読み取って15を返してしまい、
     誤設定に気付けない（マージ前レビュー指摘対応）。 */
  var STRICT_INTEGER_PATTERN_ = /^-?\d+$/;

  function readProperty_(key) {
    var value = PropertiesService.getScriptProperties().getProperty(key);
    return value === null || value === '' ? DEFAULTS[key] : value;
  }

  /* 不正な文字列（"15abc"・"15.5"・" 15"等）はNaNを返す。fail-closedな妥当性判定自体は
     Availability.gsのvalidateInputが一元的に行う（Config.gsはここでは例外を投げない）。 */
  function readIntegerProperty_(key) {
    var raw = readProperty_(key);
    if (typeof raw !== 'string' || !STRICT_INTEGER_PATTERN_.test(raw)) return NaN;
    return parseInt(raw, 10);
  }

  function getCalendarId() {
    var id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
    if (!id) {
      throw new Error('Script Propertiesに CALENDAR_ID が設定されていません。README.mdを参照してください。');
    }
    return id;
  }

  /* getAvailability（Issue #266）が使う空き判定の固定条件一式。
     brandはここに含めない（空き判定ロジックをbrandで分岐させないため）。 */
  function getAvailabilityConfig() {
    return {
      timezone: readProperty_('TIMEZONE'),
      openTime: readProperty_('OPEN_TIME'),
      closeTime: readProperty_('CLOSE_TIME'),
      minBookingMinutes: readIntegerProperty_('MIN_BOOKING_MINUTES'),
      bufferMinutes: readIntegerProperty_('BUFFER_MINUTES'),
      slotStepMinutes: readIntegerProperty_('SLOT_STEP_MINUTES')
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    getCalendarId: getCalendarId,
    getAvailabilityConfig: getAvailabilityConfig
  };
})();
