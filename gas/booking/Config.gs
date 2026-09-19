/*
 * Config.gs — 自社予約システム（Issue #266/#268）の固定仕様値とScript Propertiesの読み出し。
 *
 * Script Propertiesに未設定の項目は、Issue #265/#266/#268で固定された仕様値を
 * デフォルトとして使う。CALENDAR_ID / SPREADSHEET_ID のみ必須（未設定ならエラーにする）。
 *
 * TTL・レート制限のような運用チューニング値は、誤設定（数値以外・0以下）の場合でも
 * 例外を投げず安全な既定値へフォールバックする。空き判定側（BUFFER_MINUTES等）と異なり、
 * ここでNaNをそのまま返すと「レート制限が常に無効化される」というfail-open事故になるため
 * （例: count < NaN は常にfalseになり、無制限に送信を許してしまう）、あえてfail-closedに
 * 倒れる既定値へ丸める方針にしている。
 *
 * このファイルはPropertiesService依存のため、実際のGAS実行環境でのみ完全に動作する
 * （vmテストではPropertiesServiceをスタブして検証する）。
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

  function getSpreadsheetId() {
    var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!id) {
      throw new Error('Script Propertiesに SPREADSHEET_ID が設定されていません。README.mdを参照してください。');
    }
    return id;
  }

  /* getAdminNotificationEmail() の戻り値が空文字の場合、AdminNotifier.gsは通知を送らない
     （管理者通知は#268では任意機能のため、未設定でもcreateBooking自体は失敗させない）。 */
  function getAdminNotificationEmail() {
    return PropertiesService.getScriptProperties().getProperty('ADMIN_NOTIFICATION_EMAIL') || '';
  }

  var POSITIVE_INTEGER_STRICT_PATTERN_ = /^\d+$/;

  /* readIntegerProperty_と異なり、不正値・0以下は例外にもNaNにもせずdefaultValueへフォールバックする
     （このファイル冒頭のコメント参照）。 */
  function readPositiveIntegerProperty_(key, defaultValue) {
    var raw = PropertiesService.getScriptProperties().getProperty(key);
    if (raw === null || raw === '') return defaultValue;
    if (typeof raw !== 'string' || !POSITIVE_INTEGER_STRICT_PATTERN_.test(raw)) return defaultValue;
    var parsed = parseInt(raw, 10);
    return parsed > 0 ? parsed : defaultValue;
  }

  /* PENDING TTLの既定値（Issue #268固定仕様）:
     - PENDING_TTL_HOURS: 受付から24時間
     - PENDING_TTL_MIN_HOURS_BEFORE_START: 利用開始時刻の2時間前を超えて保持しない
     どちらもScript Propertiesで変更可能。 */
  function getTtlConfig() {
    return {
      ttlHours: readPositiveIntegerProperty_('PENDING_TTL_HOURS', 24),
      minHoursBeforeStart: readPositiveIntegerProperty_('PENDING_TTL_MIN_HOURS_BEFORE_START', 2)
    };
  }

  /* レート制限の既定値（Issue #268固定仕様）:
     - 同一メール: 10分以内3件まで
     - 全体: 1分あたり20件まで
     - 同一内容の連投抑止: 2分以内の完全一致再送信を1件目のみ許可する
     すべてScript Propertiesで変更可能。 */
  function getRateLimitConfig() {
    return {
      emailCount: readPositiveIntegerProperty_('RATE_LIMIT_EMAIL_COUNT', 3),
      emailWindowMinutes: readPositiveIntegerProperty_('RATE_LIMIT_EMAIL_WINDOW_MINUTES', 10),
      globalCount: readPositiveIntegerProperty_('RATE_LIMIT_GLOBAL_COUNT', 20),
      globalWindowMinutes: readPositiveIntegerProperty_('RATE_LIMIT_GLOBAL_WINDOW_MINUTES', 1),
      duplicateWindowMinutes: readPositiveIntegerProperty_('RATE_LIMIT_DUPLICATE_WINDOW_MINUTES', 2)
    };
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
    getAvailabilityConfig: getAvailabilityConfig,
    getSpreadsheetId: getSpreadsheetId,
    getAdminNotificationEmail: getAdminNotificationEmail,
    getTtlConfig: getTtlConfig,
    getRateLimitConfig: getRateLimitConfig
  };
})();
