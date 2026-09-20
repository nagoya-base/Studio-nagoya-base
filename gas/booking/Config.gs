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

  /* PENDING TTLの既定値（Issue #268固定仕様 + Issue #270で追加）:
     - PENDING_TTL_HOURS: 受付から24時間
     - PENDING_TTL_MIN_HOURS_BEFORE_START: 利用開始時刻の2時間前を超えて保持しない
     - PENDING_TTL_MIN_HOLD_HOURS（Issue #270で追加。レビュー対応で意味を再定義）:
       「利用開始まで2時間未満で受け付けた当日予約」で通常TTL計算式が受付時刻以前に
       なってしまう場合にだけ使う最大猶予（grace）。既定2時間。「受付から少なくとも
       この時間は必ず保持する」という下限ではなく、利用開始時刻を必ず上限とする
       （expiry<=startAtを保証。Booking.gsのcomputeTtlExpiryMillisコメント参照）。
     - timezone（Issue #270で追加）: expirePendingBookingsが「当日受付かどうか」を
       Asia/Tokyo基準で判定するために使う（Availability設定のTIMEZONEと同じ値を共有する）。
     いずれもScript Propertiesで変更可能。 */
  function getTtlConfig() {
    return {
      ttlHours: readPositiveIntegerProperty_('PENDING_TTL_HOURS', 24),
      minHoursBeforeStart: readPositiveIntegerProperty_('PENDING_TTL_MIN_HOURS_BEFORE_START', 2),
      minHoldHours: readPositiveIntegerProperty_('PENDING_TTL_MIN_HOLD_HOURS', 2),
      timezone: readProperty_('TIMEZONE')
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

  /*
   * 利用者向けメール（Issue #271）の基本設定。実値（表示名・reply-to・問い合わせ先）は
   * GitHubへ直書きせず、すべてScript Propertiesから読む。未設定の項目は空文字を返す
   * （fail-closedな要否判定自体はBookingMailer.gs側で行う。ここでは例外を投げない）。
   *
   * timezone（PRレビュー対応で追加）: メール本文の開始/終了時刻表示（
   * BookingMailTemplates.gsのformatTime_）に使う。新規Script Propertyは追加せず、
   * 既存のTIMEZONE（getAvailabilityConfig/getTtlConfigと共有。既定Asia/Tokyo）を
   * そのまま使う。ここを渡し忘れると、Intl.DateTimeFormatがGAS実行環境の既定
   * timezoneへフォールバックし、実行環境によってはJSTではない時刻がメール本文へ
   * 出てしまう事故につながるため、getMailConfig()の戻り値に必ず含める。
   */
  function getMailConfig() {
    return {
      displayName: PropertiesService.getScriptProperties().getProperty('BOOKING_MAIL_DISPLAY_NAME') || '',
      replyTo: PropertiesService.getScriptProperties().getProperty('BOOKING_MAIL_REPLY_TO') || '',
      contactEmail: PropertiesService.getScriptProperties().getProperty('BOOKING_CONTACT_EMAIL') || '',
      timezone: readProperty_('TIMEZONE')
    };
  }

  /*
   * 来場案内（前日リマインドに同梱。Issue #271）の設定値。
   * keyboxNumber / unlockCodeは特に機密性が高いため、実値はScript Properties（または
   * 将来的な管理用Sheet等）でのみ管理し、GitHubへは一切コミットしない。README.mdには
   * キー名と「何を入れるか」のみを記載する。
   * entryMethod（PRレビュー対応で追加。ACCESS_GUIDE_ENTRY_METHOD）: 前日リマインド
   * 必須内容の「入室方法」用。将来、施設側の運用変更で入室方法が変わっても
   * コード変更なしで差し替えられるよう、固定文言をテンプレートへ埋め込まずScript
   * Propertyから読む。
   */
  function getAccessGuideConfig() {
    return {
      address: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_ADDRESS') || '',
      building: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_BUILDING') || '',
      room: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_ROOM') || '',
      entrance: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_ENTRANCE') || '',
      keyboxLocation: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_KEYBOX_LOCATION') || '',
      keyboxNumber: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_KEYBOX_NUMBER') || '',
      unlockCode: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_UNLOCK_CODE') || '',
      entryMethod: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_ENTRY_METHOD') || '',
      url: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_URL') || '',
      pdfUrl: PropertiesService.getScriptProperties().getProperty('ACCESS_GUIDE_PDF_URL') || ''
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    getCalendarId: getCalendarId,
    getAvailabilityConfig: getAvailabilityConfig,
    getSpreadsheetId: getSpreadsheetId,
    getAdminNotificationEmail: getAdminNotificationEmail,
    getTtlConfig: getTtlConfig,
    getRateLimitConfig: getRateLimitConfig,
    getMailConfig: getMailConfig,
    getAccessGuideConfig: getAccessGuideConfig
  };
})();
