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

  function readProperty_(key) {
    var value = PropertiesService.getScriptProperties().getProperty(key);
    return value === null || value === '' ? DEFAULTS[key] : value;
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
      minBookingMinutes: parseInt(readProperty_('MIN_BOOKING_MINUTES'), 10),
      bufferMinutes: parseInt(readProperty_('BUFFER_MINUTES'), 10),
      slotStepMinutes: parseInt(readProperty_('SLOT_STEP_MINUTES'), 10)
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    getCalendarId: getCalendarId,
    getAvailabilityConfig: getAvailabilityConfig
  };
})();
