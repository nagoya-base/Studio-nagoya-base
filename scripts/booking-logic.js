/*
 * scripts/booking-logic.js — 共通予約UI（Issue #269）のDOM非依存な純粋ロジック。
 *
 * gas/booking/Booking.gs 等と同じ方針で、CalendarApp相当のブラウザAPI（DOM操作・fetch）
 * に一切依存しない部分だけをここに切り出し、node --test でそのままテストできるようにする
 * （scripts/booking-app.js がDOM配線・fetch呼び出しを担当し、ここの関数を呼ぶだけにする）。
 *
 * ここでの検証はあくまでUI側の一次チェック（未入力のまま次へ進めない等のUX目的）であり、
 * 空き判定・最低利用時間・15分刻み・競合判定のような業務ルールの正はGAS側
 * （gas/booking/配下）に置く。ここではそれらを再実装・複製しない。
 */
(function (global) {
  'use strict';

  /* ブランド表示専用のメタ情報。brand識別子はgas/booking/Booking.gsのALLOWED_BOOKING_BRANDS
     と一致させること（snb / mens / studio_x）。空き判定・予約可否の権限はここにはない。 */
  var BRAND_META = {
    snb: { brand: 'snb', displayName: 'Studio Nagoya Base', source: 'snb-booking-app' },
    mens: { brand: 'mens', displayName: 'SNB mens', source: 'mens-booking-app' },
    studio_x: { brand: 'studio_x', displayName: 'Studio X', source: 'studio-x-booking-app' }
  };

  function getBrandMeta(brand) {
    return BRAND_META[brand] || null;
  }

  /* createBooking / getAvailability が返すerror.codeの文言。
     gas/booking/README.md「API仕様」のerror.code一覧と対応させること。 */
  var ERROR_MESSAGES = {
    INVALID_BRAND: 'このページの予約設定に問題があります。お手数ですがページを開き直してください。',
    INVALID_CONFIG: '現在オンライン予約を受け付けられません。恐れ入りますが、時間をおいて再度お試しください。',
    INVALID_DATE: '日付の指定が正しくありません。',
    INVALID_DURATION: '利用時間の指定が正しくありません。',
    DURATION_TOO_SHORT: '選択した利用時間は短すぎます。別の利用時間を選択してください。',
    INVALID_START_TIME: '開始時刻が正しくありません。空き時間を選び直してください。',
    START_TIME_NOT_ALIGNED: '開始時刻の指定が正しくありません。空き時間を選び直してください。',
    SLOT_CONFLICT: '選択した時間帯は、たった今埋まってしまいました。お手数ですが別の時間を選び直してください。',
    INVALID_NAME: 'お名前を入力してください。',
    INVALID_EMAIL: 'メールアドレスの形式が正しくありません。',
    INVALID_PHONE: '電話番号の形式が正しくありません。',
    INVALID_PEOPLE: '利用人数を選択してください。',
    INVALID_PURPOSE: '利用目的を選択してください。',
    INVALID_PAYMENT_METHOD: '支払方法を選択してください。',
    INVALID_NOTE: '連絡事項は1000文字以内で入力してください。',
    INVALID_SOURCE: '送信元の情報が正しくありません。お手数ですがページを開き直してください。',
    RATE_LIMITED: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。',
    LOCK_TIMEOUT: '一時的に混み合っています。もう一度お試しください。',
    BOOKING_SAVE_FAILED: '予約の保存に失敗しました。しばらくしてから再度お試しください。',
    INVALID_JSON: '送信内容の形式が正しくありませんでした。もう一度お試しください。',
    INTERNAL_ERROR: '予約処理中にエラーが発生しました。しばらくしてから再度お試しください。'
  };

  var NETWORK_ERROR_MESSAGE = '通信状況をご確認のうえ、時間を置いて再度お試しください。';
  var API_NOT_CONFIGURED_MESSAGE = '現在オンライン予約の準備中です。恐れ入りますが、しばらくしてから再度お試しください。';

  function messageForErrorCode(code) {
    return ERROR_MESSAGES[code] || 'エラーが発生しました。しばらくしてから再度お試しください。';
  }

  /* SLOT_CONFLICTのみ「空き時間の選び直し」に誘導し、それ以外の入力系エラー
     （INVALID_EMAIL等）は「内容の修正」に、rate limit等は「再試行」に誘導する。
     UIの導線分岐のみを担い、エラーメッセージ自体はmessageForErrorCode()を使う。 */
  function recoveryActionForErrorCode(code) {
    if (code === 'SLOT_CONFLICT' || code === 'INVALID_START_TIME' || code === 'START_TIME_NOT_ALIGNED') {
      return 'reselect-time';
    }
    if (
      code === 'INVALID_NAME' ||
      code === 'INVALID_EMAIL' ||
      code === 'INVALID_PHONE' ||
      code === 'INVALID_PEOPLE' ||
      code === 'INVALID_PURPOSE' ||
      code === 'INVALID_PAYMENT_METHOD' ||
      code === 'INVALID_NOTE'
    ) {
      return 'edit-details';
    }
    return 'retry';
  }

  function isNonEmpty(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  function isValidEmail(value) {
    return typeof value === 'string' && EMAIL_PATTERN.test(value);
  }

  var PHONE_PATTERN = /^[0-9()+\-\s]+$/;
  function isValidPhone(value) {
    if (!value) return true; /* 任意項目 */
    return typeof value === 'string' && PHONE_PATTERN.test(value);
  }

  /* '2'〜'8'（時間単位・UIの選択肢）を分単位へ変換する。不正な値はnull
     （最終的な最低利用時間・上限の判定はgetAvailability/createBooking側の責務）。 */
  function durationHoursToMinutes(hours) {
    var n = Number(hours);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    return n * 60;
  }

  /* 表示専用。'10:00' + 120分 → '12:00'。日をまたぐ場合も表示上は24時間表記で丸める
     （営業時間内であることの保証はサーバー側の入力検証が行う）。 */
  function computeEndTime(startTime, durationMinutes) {
    if (typeof startTime !== 'string' || !/^\d{2}:\d{2}$/.test(startTime)) return '';
    var parts = startTime.split(':');
    var totalMinutes = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + Number(durationMinutes || 0);
    var wrapped = ((totalMinutes % (24 * 60)) + 24 * 60) % (24 * 60);
    var h = Math.floor(wrapped / 60);
    var m = wrapped % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  /* fields: { name, email, phone, people, purpose, purposeOther, paymentMethod, note }
     戻り値: フィールド名をキーとするエラーメッセージのオブジェクト（空オブジェクト = 検証OK）。
     ここでの検証は一次チェックに過ぎず、最終的な正はcreateBookingのサーバー側検証。 */
  function validateDetailsForm(fields) {
    var f = fields || {};
    var errors = {};

    if (!isNonEmpty(f.name)) errors.name = 'お名前を入力してください。';
    else if (f.name.length > 100) errors.name = 'お名前は100文字以内で入力してください。';

    if (!isNonEmpty(f.email)) errors.email = 'メールアドレスを入力してください。';
    else if (!isValidEmail(f.email)) errors.email = 'メールアドレスの形式が正しくありません。';

    if (!isValidPhone(f.phone)) errors.phone = '電話番号の形式が正しくありません。';

    if (!isNonEmpty(f.people)) errors.people = '利用人数を選択してください。';
    if (!isNonEmpty(f.purpose)) errors.purpose = '利用目的を選択してください。';
    if (f.purpose === 'その他' && !isNonEmpty(f.purposeOther)) {
      errors.purposeOther = '利用目的の詳細を入力してください。';
    }
    if (!isNonEmpty(f.paymentMethod)) errors.paymentMethod = '支払方法を選択してください。';

    if (f.note && f.note.length > 1000) errors.note = '連絡事項は1000文字以内で入力してください。';

    return errors;
  }

  function buildPurposeValue(purpose, purposeOther) {
    if (purpose === 'その他' && isNonEmpty(purposeOther)) {
      return 'その他：' + purposeOther.trim();
    }
    return purpose;
  }

  /*
   * state: { brand, date, startTime, durationMinutes, name, email, phone, people,
   *          purpose, purposeOther, paymentMethod, note }
   * 戻り値: createBooking（POST）へそのまま渡せるペイロード。
   * sourceはブランドごとに固定の値をBRAND_METAから補う（利用者が触れる余地を与えない）。
   */
  function buildCreateBookingPayload(state) {
    var s = state || {};
    var brandMeta = getBrandMeta(s.brand);
    return {
      brand: s.brand,
      date: s.date,
      startTime: s.startTime,
      durationMinutes: s.durationMinutes,
      name: isNonEmpty(s.name) ? s.name.trim() : '',
      email: isNonEmpty(s.email) ? s.email.trim() : '',
      phone: s.phone ? String(s.phone).trim() : '',
      people: s.people || '',
      purpose: buildPurposeValue(s.purpose, s.purposeOther),
      paymentMethod: s.paymentMethod || '',
      note: s.note ? String(s.note).trim() : '',
      source: brandMeta ? brandMeta.source : 'unknown'
    };
  }

  /* JST（日本時間）の「明日」を'YYYY-MM-DD'で返す。#270で当日利用ルールが実装されるまでの
     暫定の下限であり、会員/新規による当日可否の判定はここでは行わない
     （TODO #270: 会員種別に応じた当日利用可否の分岐はこの関数の責務にしない）。 */
  function isDateLike_(value) {
    /* instanceof Dateではなくダックタイピングで判定する（別realm・vmサンドボックスを
       またぐテストでinstanceof Dateが偽陰性になるため。gas/booking/BookingRepository.gsの
       isDateLike_と同じ方針）。 */
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function tomorrowInJapan(now) {
    var base = isDateLike_(now) ? now : new Date();
    var formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' });
    var values = {};
    formatter.formatToParts(base).forEach(function (part) {
      if (part.type !== 'literal') values[part.type] = Number(part.value);
    });
    var nextDayNoonUtc = new Date(Date.UTC(values.year, values.month - 1, values.day + 1, 3));
    var jstParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(nextDayNoonUtc);
    var result = {};
    jstParts.forEach(function (part) { if (part.type !== 'literal') result[part.type] = part.value; });
    return result.year + '-' + result.month + '-' + result.day;
  }

  var api = {
    getBrandMeta: getBrandMeta,
    messageForErrorCode: messageForErrorCode,
    recoveryActionForErrorCode: recoveryActionForErrorCode,
    NETWORK_ERROR_MESSAGE: NETWORK_ERROR_MESSAGE,
    API_NOT_CONFIGURED_MESSAGE: API_NOT_CONFIGURED_MESSAGE,
    isNonEmpty: isNonEmpty,
    isValidEmail: isValidEmail,
    isValidPhone: isValidPhone,
    durationHoursToMinutes: durationHoursToMinutes,
    computeEndTime: computeEndTime,
    validateDetailsForm: validateDetailsForm,
    buildPurposeValue: buildPurposeValue,
    buildCreateBookingPayload: buildCreateBookingPayload,
    tomorrowInJapan: tomorrowInJapan
  };

  global.BookingLogic = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : this);
