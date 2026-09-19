/*
 * Booking.gs — createBooking（Issue #268）の予約状態・入力検証・bookingId・TTLに関する
 * 純粋なロジック本体。CalendarApp / PropertiesService / LockService等のGAS組み込み
 * サービスには一切依存せず、vmでそのまま実行してテストできる（Availability.gsと同方針）。
 *
 * ここではBookingAvailability（同じくGASサービス非依存）の時刻ユーティリティのみを使う。
 * GAS実行時は全.gsファイルが同一グローバルスコープにコンパイルされるため、
 * Availability.gsを先に読み込む前提で参照できる（Code.gs等の既存の依存順と同じ）。
 *
 * 固定仕様（Issue #268/#269。実装中に変更しない）:
 * - 予約状態は PENDING / CONFIRMED / CANCELLED / EXPIRED の4つ
 * - 利用者からの送信は必ずPENDING（送信即CONFIRMEDは禁止）
 * - 予約作成を許可するbrandは snb / mens / studio_x の3つ（Issue #269でstudio_x限定から
 *   拡張。3ブランドとも同一室・同一Calendarのため、空き判定ロジックはbrandで分岐させない。
 *   ブランド一覧・bookingId prefix・表示名はいずれも運用値ではなく仕様であるため、
 *   Script Propertiesではなくこの定数で一元管理する。他ファイル（CalendarRepository.gs /
 *   AdminNotifier.gs等）はbrand文字列やラベルを直接持たず、必ずBooking.getBrandLabel等
 *   ここの定義を経由する）
 */
'use strict';

var Booking = (function () {
  var STATUS = {
    PENDING: 'PENDING',
    CONFIRMED: 'CONFIRMED',
    CANCELLED: 'CANCELLED',
    EXPIRED: 'EXPIRED'
  };

  /* 予約作成できるbrandはこの3つのみ（Issue #269）。brand偽装で未知のbrandから
     予約を作れないよう、フロントの表示に関わらずサーバー側でこの一覧のみ許可する。 */
  var ALLOWED_BOOKING_BRANDS = ['snb', 'mens', 'studio_x'];

  /* bookingIdの接頭辞。studio_xの'SX'はIssue #268から変更しない
     （既発行のbookingId・運用ドキュメントとの整合のため）。 */
  var BRAND_ID_PREFIX_ = { snb: 'SNB', mens: 'MENS', studio_x: 'SX' };

  /* Calendarタイトル・管理者通知メール等、人が読む表示にのみ使うブランド名。
     空き判定・状態判定のロジックはこのラベルに一切依存しない。 */
  var BRAND_LABELS_ = { snb: 'SNB', mens: 'SNB mens', studio_x: 'Studio X' };

  function getBrandLabel(brand) {
    return BRAND_LABELS_[brand] || String(brand || '');
  }

  /* PENDINGから遷移できる先のみを許可する。CONFIRMED/CANCELLED/EXPIREDはいずれも
     終端状態として扱う（#268時点でCONFIRMED後のキャンセルは#272の責務）。 */
  var ALLOWED_TRANSITIONS = {
    PENDING: [STATUS.CONFIRMED, STATUS.CANCELLED, STATUS.EXPIRED]
  };

  function canTransition(fromStatus, toStatus) {
    var allowedTargets = ALLOWED_TRANSITIONS[fromStatus];
    return !!allowedTargets && allowedTargets.indexOf(toStatus) !== -1;
  }

  function isAllowedBrand(brand) {
    return ALLOWED_BOOKING_BRANDS.indexOf(brand) !== -1;
  }

  function isNonEmptyString_(value, maxLength) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
  }

  var EMAIL_PATTERN_ = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function isValidEmail_(value) {
    return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN_.test(value);
  }

  var PHONE_PATTERN_ = /^[0-9()+\-\s]+$/;

  function isValidPhone_(value) {
    if (value === undefined || value === null || value === '') return true; /* 任意項目 */
    return typeof value === 'string' && value.length <= 20 && PHONE_PATTERN_.test(value);
  }

  function err_(code, message) {
    return { code: code, message: message };
  }

  /*
   * rawInput: createBooking APIが受け取る生のリクエストボディ相当。
   * availabilityConfig: BookingConfig.getAvailabilityConfig()の戻り値
   *   （openTime/closeTime/minBookingMinutes/slotStepMinutes/bufferMinutes/timezone）。
   *
   * 戻り値: { valid: true, normalized: {...} } または { valid: false, error: {code, message} }。
   * normalizedはtrim済み・型を揃えた値のみを含み、以降の処理（bookingId発行・Calendar/Sheets保存）は
   * すべてこのnormalizedを使う（生入力を直接使わない）。
   */
  function validateCreateBookingInput(rawInput, availabilityConfig) {
    var input = rawInput || {};

    if (!isAllowedBrand(input.brand)) {
      return { valid: false, error: err_('INVALID_BRAND', 'このブランドではオンライン予約を受け付けていません。') };
    }

    /*
     * 日付・利用時間・Availability設定全体（営業時間/最低利用時間/バッファ分/開始刻み）を、
     * getAvailabilityと全く同じ判定（BookingAvailability.validateInput）でfail-closedに
     * 検証する。ここを素通りさせると、例えばBUFFER_MINUTES=abc（NaN）のまま後続の
     * isStartTimeBookableへ渡ってしまい、既存予約との競合を見落とす恐れがある
     * （NaNを含む比較は常にfalseになるため）。openTime/closeTime/slotStepMinutesの
     * 形式・整合性もここで保証されるため、これより後のstartMinutes計算は安全に行える
     * （レビュー指摘対応）。
     */
    var baseError = BookingAvailability.validateInput(input.date, input.durationMinutes, availabilityConfig);
    if (baseError) {
      return { valid: false, error: baseError };
    }
    var durationMinutes = input.durationMinutes;

    if (!BookingAvailability.isValidTimeString(input.startTime)) {
      return { valid: false, error: err_('INVALID_START_TIME', '開始時刻の形式が正しくありません（HH:mm）。') };
    }
    var startMinutes = BookingAvailability.parseTimeToMinutes(input.startTime);
    var openMinutes = BookingAvailability.parseTimeToMinutes(availabilityConfig.openTime);
    var closeMinutes = BookingAvailability.parseTimeToMinutes(availabilityConfig.closeTime);
    if (startMinutes < openMinutes || startMinutes + durationMinutes > closeMinutes) {
      return { valid: false, error: err_('INVALID_START_TIME', '営業時間（' + availabilityConfig.openTime + '〜' + availabilityConfig.closeTime + '）の範囲外です。') };
    }
    /*
     * #265/#266固定仕様: 開始時刻はslotStepMinutes（既定15分）刻みのみ許可する
     * （例: 10:00/10:15/10:30/10:45は可、10:07は不可）。getAvailabilityが提示する
     * 候補開始時刻と、実際にcreateBookingできる開始時刻を一致させるサーバー側の
     * ハード制約であり、フロントのUI都合ではない（レビュー指摘対応）。
     * baseErrorのチェックによりslotStepMinutesは正の整数であることが保証済みのため、
     * 剰余演算がNaN・0除算になることはない。
     */
    if ((startMinutes - openMinutes) % availabilityConfig.slotStepMinutes !== 0) {
      return {
        valid: false,
        error: err_('START_TIME_NOT_ALIGNED', '開始時刻は' + availabilityConfig.slotStepMinutes + '分刻みで指定してください。')
      };
    }

    if (!isNonEmptyString_(input.name, 100)) {
      return { valid: false, error: err_('INVALID_NAME', 'お名前を入力してください。') };
    }
    if (!isValidEmail_(input.email)) {
      return { valid: false, error: err_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。') };
    }
    if (!isValidPhone_(input.phone)) {
      return { valid: false, error: err_('INVALID_PHONE', '電話番号の形式が正しくありません。') };
    }
    if (!isNonEmptyString_(input.people, 50)) {
      return { valid: false, error: err_('INVALID_PEOPLE', '利用人数を入力してください。') };
    }
    if (!isNonEmptyString_(input.purpose, 200)) {
      return { valid: false, error: err_('INVALID_PURPOSE', '利用目的を入力してください。') };
    }
    if (!isNonEmptyString_(input.paymentMethod, 50)) {
      return { valid: false, error: err_('INVALID_PAYMENT_METHOD', '支払方法を選択してください。') };
    }
    if (input.note !== undefined && input.note !== null && (typeof input.note !== 'string' || input.note.length > 1000)) {
      return { valid: false, error: err_('INVALID_NOTE', '連絡事項は1000文字以内で入力してください。') };
    }
    if (input.source !== undefined && input.source !== null && (typeof input.source !== 'string' || input.source.length > 100)) {
      return { valid: false, error: err_('INVALID_SOURCE', '流入元の形式が正しくありません。') };
    }

    return {
      valid: true,
      normalized: {
        brand: input.brand,
        date: input.date,
        startTime: input.startTime,
        durationMinutes: durationMinutes,
        name: input.name.trim(),
        email: input.email.trim(),
        phone: input.phone ? String(input.phone).trim() : '',
        people: String(input.people).trim(),
        purpose: input.purpose.trim(),
        paymentMethod: input.paymentMethod.trim(),
        note: input.note ? String(input.note).trim() : '',
        source: input.source ? String(input.source).trim() : 'unknown'
      }
    };
  }

  /*
   * brand・dateString（'YYYY-MM-DD'）・uuid（Utilities.getUuid()相当）からbookingIdを発行する。
   * 例: 'SX-20261001-3F2A9B1C'
   * - 連番だけに依存しない（uuidの一部を混ぜることで、同時発行時の衝突可能性を下げる）
   * - 日付を含むため人が見て追跡しやすい
   * - Calendar / Sheets / recoveryのいずれでも同じ文字列で照合できる
   */
  function generateBookingId(brand, dateString, uuid) {
    var prefix = BRAND_ID_PREFIX_[brand] || 'XX';
    var compactDate = String(dateString).replace(/-/g, '');
    var uuidPart = String(uuid || '').replace(/-/g, '').slice(0, 8).toUpperCase();
    return prefix + '-' + compactDate + '-' + uuidPart;
  }

  /*
   * PENDING TTLの失効時刻（ミリ秒epoch）を計算する。
   * 「受付から ttlHours 時間後」と「利用開始時刻の minHoursBeforeStart 時間前」の
   * より早い方を採用する（Issue #268固定仕様）。
   */
  function computeTtlExpiryMillis(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart) {
    var ttlExpiry = createdAtMillis + ttlHours * 3600000;
    var startLimit = startAtMillis - minHoursBeforeStart * 3600000;
    return Math.min(ttlExpiry, startLimit);
  }

  function isExpired(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart, nowMillis) {
    return nowMillis >= computeTtlExpiryMillis(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart);
  }

  return {
    STATUS: STATUS,
    ALLOWED_BOOKING_BRANDS: ALLOWED_BOOKING_BRANDS,
    getBrandLabel: getBrandLabel,
    canTransition: canTransition,
    isAllowedBrand: isAllowedBrand,
    validateCreateBookingInput: validateCreateBookingInput,
    generateBookingId: generateBookingId,
    computeTtlExpiryMillis: computeTtlExpiryMillis,
    isExpired: isExpired
  };
})();
