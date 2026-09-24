/*
 * scripts/booking-logic.js — 共通予約UI（Issue #269）のDOM非依存な純粋ロジック。
 *
 * gas/booking/shared/Booking.gs 等と同じ方針で、CalendarApp相当のブラウザAPI（DOM操作・fetch）
 * に一切依存しない部分だけをここに切り出し、node --test でそのままテストできるようにする
 * （scripts/booking-app.js がDOM配線・fetch呼び出しを担当し、ここの関数を呼ぶだけにする）。
 *
 * ここでの検証はあくまでUI側の一次チェック（未入力のまま次へ進めない等のUX目的）であり、
 * 空き判定・最低利用時間・15分刻み・競合判定のような業務ルールの正はGAS側
 * （gas/booking/配下）に置く。ここではそれらを再実装・複製しない。
 */
(function (global) {
  'use strict';

  /* ブランド表示専用のメタ情報。brand識別子はgas/booking/shared/Booking.gsのALLOWED_BOOKING_BRANDS
     と一致させること（snb / mens / studio_x）。空き判定・予約可否の権限はここにはない。 */
  var BRAND_META = {
    snb: { brand: 'snb', displayName: 'Studio Nagoya Base', source: 'snb-booking-app' },
    mens: { brand: 'mens', displayName: 'SNB mens', source: 'mens-booking-app' },
    studio_x: { brand: 'studio_x', displayName: 'Studio X', source: 'studio-x-booking-app' }
  };

  function getBrandMeta(brand) {
    return BRAND_META[brand] || null;
  }

  /* 対応locale（Issue #297）。表示文言のみをlocaleで切り替え、空き判定・当日予約条件・
     送信payload・エラーaction判定等の業務ルールはlocaleで分岐させない。
     未指定・未知のlocaleは常にjaへfallbackする。 */
  var DEFAULT_LOCALE = 'ja';
  var SUPPORTED_LOCALES = ['ja', 'en'];

  function normalizeLocale(locale) {
    return SUPPORTED_LOCALES.indexOf(locale) !== -1 ? locale : DEFAULT_LOCALE;
  }

  /*
   * 利用区分（Issue #270）。「会員かどうか」ではなく、SNB / SNB mens / Studio Xという
   * 同一施設を過去に利用した経験があるかどうかで当日予約可否を判定する。
   * 内部値はgas/booking/shared/Booking.gsのCUSTOMER_TYPESと一致させること（first_time/returning）。
   * 表示文言と内部値を混同しない（表示はCUSTOMER_TYPE_LABELS経由のみ）。
   */
  var CUSTOMER_TYPES = { FIRST_TIME: 'first_time', RETURNING: 'returning' };
  var ALLOWED_CUSTOMER_TYPES = [CUSTOMER_TYPES.FIRST_TIME, CUSTOMER_TYPES.RETURNING];
  var CUSTOMER_TYPE_LABELS = {
    ja: { first_time: '初回利用', returning: '利用経験あり' },
    en: { first_time: 'First-time guest', returning: 'Returning guest' }
  };

  function isAllowedCustomerType(value) {
    return ALLOWED_CUSTOMER_TYPES.indexOf(value) !== -1;
  }

  /* customerTypeLabel(value, locale) — localeは任意。未指定・未知値はja。 */
  function customerTypeLabel(value, locale) {
    var labels = CUSTOMER_TYPE_LABELS[normalizeLocale(locale)];
    return labels[value] || '';
  }

  /* dateValue/todayValueは'YYYY-MM-DD'。当日（dateValue===todayValue）かつ初回利用の
     組み合わせのみを検出する（Issue #270最終仕様）。todayValueは呼び出し側がtodayInJapan()で
     求めた値を渡すこと（この関数自体はブラウザのローカルtimezoneに依存しない）。 */
  function isSameDayFirstTimeBlocked(dateValue, customerType, todayValue) {
    return dateValue === todayValue && customerType === CUSTOMER_TYPES.FIRST_TIME;
  }

  /* createBooking / getAvailability が返すerror.codeの文言。
     gas/booking/README.md「API仕様」のerror.code一覧と対応させること。
     locale別の表示文言のみを持ち、error.code自体・判定ロジックはlocaleで分岐させない（Issue #297）。 */
  var ERROR_MESSAGES = {
    ja: {
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
      INVALID_CUSTOMER_TYPE: '利用区分（初回利用／利用経験あり）を選択してください。',
      SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME: '初回利用の方は当日のご予約を受け付けていません。翌日以降の日付を選択してください。',
      SAME_DAY_START_TIME_PASSED: '指定した開始時刻はすでに過ぎています。現在時刻より後の開始時刻を選択してください。',
      CARD_PAYMENT_TOO_CLOSE_TO_START: 'カード事前決済は利用開始の4日前（96時間前）までのお申し込みに限ります。直前のご予約は現金・PayPay（現地決済）をお選びください。',
      RATE_LIMITED: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。',
      LOCK_TIMEOUT: '一時的に混み合っています。もう一度お試しください。',
      BOOKING_SAVE_FAILED: '予約の保存に失敗しました。しばらくしてから再度お試しください。',
      INVALID_JSON: '送信内容の形式が正しくありませんでした。もう一度お試しください。',
      INTERNAL_ERROR: '予約処理中にエラーが発生しました。しばらくしてから再度お試しください。'
    },
    en: {
      INVALID_BRAND: 'There is a problem with this page’s booking settings. Please reload the page and try again.',
      INVALID_CONFIG: 'Online booking is not available right now. Please try again later.',
      INVALID_DATE: 'The date you entered is not valid.',
      INVALID_DURATION: 'The duration you entered is not valid.',
      DURATION_TOO_SHORT: 'The selected duration is too short. Please choose a different duration.',
      INVALID_START_TIME: 'The start time is not valid. Please choose an available start time again.',
      START_TIME_NOT_ALIGNED: 'The start time is not valid. Please choose an available start time again.',
      SLOT_CONFLICT: 'The selected time slot was just booked by someone else. Please choose another start time.',
      INVALID_NAME: 'Please enter your name.',
      INVALID_EMAIL: 'Please enter a valid email address.',
      INVALID_PHONE: 'Please enter a valid phone number.',
      INVALID_PEOPLE: 'Please select the number of guests.',
      INVALID_PURPOSE: 'Please select the purpose of your visit.',
      INVALID_PAYMENT_METHOD: 'Please select a payment method.',
      INVALID_NOTE: 'Notes must be 1000 characters or fewer.',
      INVALID_SOURCE: 'There is a problem with the request source. Please reload the page and try again.',
      INVALID_CUSTOMER_TYPE: 'Please select your customer type (first-time guest or returning guest).',
      SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME: 'First-time guests cannot book for the same day. Please choose a date from tomorrow onward.',
      SAME_DAY_START_TIME_PASSED: 'The selected start time has already passed. Please choose a start time later than the current time.',
      CARD_PAYMENT_TOO_CLOSE_TO_START: 'Card prepayment is only available up to 96 hours (4 days) before your start time. For last-minute bookings, please choose cash or PayPay (pay on site).',
      RATE_LIMITED: 'Too many requests have been submitted. Please wait a moment and try again.',
      LOCK_TIMEOUT: 'The system is currently busy. Please try again.',
      BOOKING_SAVE_FAILED: 'We couldn’t save your booking. Please try again in a moment.',
      INVALID_JSON: 'Your submission could not be read correctly. Please try again.',
      INTERNAL_ERROR: 'An error occurred while processing your request. Please try again in a moment.'
    }
  };

  var GENERIC_ERROR_MESSAGE = {
    ja: 'エラーが発生しました。しばらくしてから再度お試しください。',
    en: 'An error occurred. Please try again in a moment.'
  };

  var NETWORK_ERROR_MESSAGES = {
    ja: '通信状況をご確認のうえ、時間を置いて再度お試しください。',
    en: 'Please check your connection and try again in a moment.'
  };
  var API_NOT_CONFIGURED_MESSAGES = {
    ja: '現在オンライン予約の準備中です。恐れ入りますが、しばらくしてから再度お試しください。',
    en: 'Online booking is currently being prepared. Please try again later.'
  };

  /* 既存呼び出し（scripts/booking-app.js旧実装・他ブランドのインライン利用等）との
     後方互換のため、ja固定の文字列としても引き続き公開する。 */
  var NETWORK_ERROR_MESSAGE = NETWORK_ERROR_MESSAGES.ja;
  var API_NOT_CONFIGURED_MESSAGE = API_NOT_CONFIGURED_MESSAGES.ja;

  /* messageForErrorCode(code, locale) — localeは任意。未指定・未知値はja（既存呼び出しとの後方互換）。 */
  function messageForErrorCode(code, locale) {
    var loc = normalizeLocale(locale);
    return ERROR_MESSAGES[loc][code] || GENERIC_ERROR_MESSAGE[loc];
  }

  function networkErrorMessage(locale) {
    return NETWORK_ERROR_MESSAGES[normalizeLocale(locale)];
  }

  function apiNotConfiguredMessage(locale) {
    return API_NOT_CONFIGURED_MESSAGES[normalizeLocale(locale)];
  }

  /* SLOT_CONFLICTのみ「空き時間の選び直し」に誘導し、それ以外の入力系エラー
     （INVALID_EMAIL等）は「内容の修正」に、rate limit等は「再試行」に誘導する。
     利用日・利用区分そのものをやり直す必要があるエラー（当日+初回利用の組み合わせ等）は
     「日付・利用区分の選び直し」（'reselect-date'）に誘導する。空き時間の再取得だけでは
     解決しないため、'reselect-time'とは区別する（Issue #270）。
     UIの導線分岐のみを担い、エラーメッセージ自体はmessageForErrorCode()を使う。 */
  function recoveryActionForErrorCode(code) {
    if (code === 'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME' || code === 'INVALID_CUSTOMER_TYPE') {
      return 'reselect-date';
    }
    if (
      code === 'SLOT_CONFLICT' ||
      code === 'INVALID_START_TIME' ||
      code === 'START_TIME_NOT_ALIGNED' ||
      code === 'SAME_DAY_START_TIME_PASSED'
    ) {
      return 'reselect-time';
    }
    if (
      code === 'INVALID_NAME' ||
      code === 'INVALID_EMAIL' ||
      code === 'INVALID_PHONE' ||
      code === 'INVALID_PEOPLE' ||
      code === 'INVALID_PURPOSE' ||
      code === 'INVALID_PAYMENT_METHOD' ||
      code === 'INVALID_NOTE' ||
      /* Issue #334: 支払方法を現地決済へ変更するか、日程を選び直せば解消するため、
         支払方法系のエラーと同じedit-detailsへ誘導する。 */
      code === 'CARD_PAYMENT_TOO_CLOSE_TO_START'
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

  /* 利用時間（時間単位の入力値）を分単位へ変換する。正の整数時間であれば上限を設けず
     そのまま変換する（不正な値はnull）。最低利用時間・上限の判定はgetAvailability/
     createBooking側の責務であり、ここでは何時間までなら妥当かを判断しない。 */
  function durationHoursToMinutes(hours) {
    var n = Number(hours);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
    return n * 60;
  }

  /* 新予約UIのStep 1で1時間入力を止めるためのUX guard（Issue #301）。
     120はUIが把握している最低受付時間の目安に過ぎず、予約可否の正はGAS側
     （gas/booking/shared/Config.gs の MIN_BOOKING_MINUTES）。ここでの値をサーバー側の
     設定値の複製・代替として扱わないこと。 */
  var UI_MIN_BOOKING_MINUTES = 120;

  function isDurationAtLeastUiMinimum(durationMinutes) {
    return Number(durationMinutes) >= UI_MIN_BOOKING_MINUTES;
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

  /* Step3の必須項目チェックメッセージ。判定ロジック（何が不正か）はlocaleで分岐させず、
     表示文言のみをlocaleで切り替える。「その他」を検出するpurpose値自体は言語を問わず
     buildPurposeValueと同じ日本語固定値のまま（Issue #297: purpose内部value無変更）。 */
  var DETAILS_VALIDATION_MESSAGES = {
    ja: {
      nameRequired: 'お名前を入力してください。',
      nameTooLong: 'お名前は100文字以内で入力してください。',
      emailRequired: 'メールアドレスを入力してください。',
      emailInvalid: 'メールアドレスの形式が正しくありません。',
      phoneInvalid: '電話番号の形式が正しくありません。',
      peopleRequired: '利用人数を選択してください。',
      purposeRequired: '利用目的を選択してください。',
      purposeOtherRequired: '利用目的の詳細を入力してください。',
      paymentMethodRequired: '支払方法を選択してください。',
      noteTooLong: '連絡事項は1000文字以内で入力してください。'
    },
    en: {
      nameRequired: 'Please enter your name.',
      nameTooLong: 'Name must be 100 characters or fewer.',
      emailRequired: 'Please enter your email address.',
      emailInvalid: 'Please enter a valid email address.',
      phoneInvalid: 'Please enter a valid phone number.',
      peopleRequired: 'Please select the number of guests.',
      purposeRequired: 'Please select the purpose of your visit.',
      purposeOtherRequired: 'Please describe the purpose of your visit.',
      paymentMethodRequired: 'Please select a payment method.',
      noteTooLong: 'Notes must be 1000 characters or fewer.'
    }
  };

  /* fields: { name, email, phone, people, purpose, purposeOther, paymentMethod, note }
     locale: 任意。未指定・未知値はja（既存呼び出し・test/booking-logic.test.jsとの後方互換）。
     戻り値: フィールド名をキーとするエラーメッセージのオブジェクト（空オブジェクト = 検証OK）。
     ここでの検証は一次チェックに過ぎず、最終的な正はcreateBookingのサーバー側検証。 */
  function validateDetailsForm(fields, locale) {
    var f = fields || {};
    var m = DETAILS_VALIDATION_MESSAGES[normalizeLocale(locale)];
    var errors = {};

    if (!isNonEmpty(f.name)) errors.name = m.nameRequired;
    else if (f.name.length > 100) errors.name = m.nameTooLong;

    if (!isNonEmpty(f.email)) errors.email = m.emailRequired;
    else if (!isValidEmail(f.email)) errors.email = m.emailInvalid;

    if (!isValidPhone(f.phone)) errors.phone = m.phoneInvalid;

    if (!isNonEmpty(f.people)) errors.people = m.peopleRequired;
    if (!isNonEmpty(f.purpose)) errors.purpose = m.purposeRequired;
    if (f.purpose === 'その他' && !isNonEmpty(f.purposeOther)) {
      errors.purposeOther = m.purposeOtherRequired;
    }
    if (!isNonEmpty(f.paymentMethod)) errors.paymentMethod = m.paymentMethodRequired;

    if (f.note && f.note.length > 1000) errors.note = m.noteTooLong;

    return errors;
  }

  function buildPurposeValue(purpose, purposeOther) {
    if (purpose === 'その他' && isNonEmpty(purposeOther)) {
      return 'その他：' + purposeOther.trim();
    }
    return purpose;
  }

  /* ── 確認画面（Step4）表示専用のラベル変換（Issue #297 PR #300再レビュー対応） ──
     people/purpose/paymentMethodの内部value・保存値（buildCreateBookingPayload/
     buildPurposeValueの出力）はここでは一切変更しない。既存日本語呼び出し・
     buildPurposeValue自体の仕様も変更しない。ここは確認画面へ出す文字列だけを
     localeで切り替える表示専用マップで、ja（未指定含む）は既存どおり内部valueを
     そのまま返す（後方互換）。 */
  var PEOPLE_LABELS_EN = {
    '1名': '1 guest',
    '2名': '2 guests',
    '3名': '3 guests',
    '4名': '4 guests',
    '5名以上・要相談': '5 or more (please contact us)'
  };

  function peopleLabel(value, locale) {
    if (normalizeLocale(locale) === 'en' && Object.prototype.hasOwnProperty.call(PEOPLE_LABELS_EN, value)) {
      return PEOPLE_LABELS_EN[value];
    }
    return value || '';
  }

  var PURPOSE_LABELS_EN = {
    '緊縛・ロープ表現の自主練習': 'Rope practice',
    'コスプレ撮影': 'Cosplay photography',
    'ポートレート撮影': 'Portrait photography',
    'セルフ撮影': 'Self-photography',
    '作品撮り': 'Creative shoot',
    '商品・物撮り': 'Product photography',
    '動画撮影': 'Video shoot',
    '講習会・ワークショップ': 'Workshop / class',
    'その他': 'Other'
  };

  /* purposeLabel(value, purposeOther, locale) — 確認画面表示専用。保存値を組み立てる
     buildPurposeValue()とは別関数であり、そちらの仕様（'その他：'+自由記述、Sheets/mail/
     admin互換のための日本語プレフィックス固定）は変更しない。 */
  function purposeLabel(value, purposeOther, locale) {
    var loc = normalizeLocale(locale);
    if (value === 'その他' && isNonEmpty(purposeOther)) {
      return (loc === 'en' ? 'Other: ' : 'その他：') + purposeOther.trim();
    }
    if (loc === 'en' && Object.prototype.hasOwnProperty.call(PURPOSE_LABELS_EN, value)) {
      return PURPOSE_LABELS_EN[value];
    }
    return value || '';
  }

  var PAYMENT_METHOD_LABELS_EN = {
    '現金': 'Cash',
    'PayPay': 'PayPay',
    'オンラインクレジットカード': 'Online credit card',
    '未定': 'Undecided'
  };

  function paymentMethodLabel(value, locale) {
    if (normalizeLocale(locale) === 'en' && Object.prototype.hasOwnProperty.call(PAYMENT_METHOD_LABELS_EN, value)) {
      return PAYMENT_METHOD_LABELS_EN[value];
    }
    return value || '';
  }

  /*
   * state: { brand, customerType, date, startTime, durationMinutes, name, email, phone,
   *          people, purpose, purposeOther, paymentMethod, note }
   * 戻り値: createBooking（POST）へそのまま渡せるペイロード。
   * sourceはブランドごとに固定の値をBRAND_METAから補う（利用者が触れる余地を与えない）。
   * customerTypeはサーバー側（Booking.validateCreateBookingInput）でも必須検証・fail-closedに
   * 拒否されるため、ここで未指定・不正値を補正することはしない（そのまま渡す）。
   */
  function buildCreateBookingPayload(state) {
    var s = state || {};
    var brandMeta = getBrandMeta(s.brand);
    return {
      brand: s.brand,
      customerType: s.customerType,
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

  function isDateLike_(value) {
    /* instanceof Dateではなくダックタイピングで判定する（別realm・vmサンドボックスを
       またぐテストでinstanceof Dateが偽陰性になるため。gas/booking/shared/BookingRepository.gsの
       isDateLike_と同じ方針）。 */
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  /*
   * ── カード決済の96時間受付条件・支払期限表示（Issue #334 PR-B） ──
   * ここでの判定・表示はあくまでフォーム側の事前チェック・目安表示であり、実際の受付可否・
   * 支払期限の正はgas/booking/shared/Booking.gs（CARD_MIN_HOURS_BEFORE_START/CARD_TTL_HOURS/
   * computeCardPaymentDueMillis）。しきい値・TTLはそちらと値を一致させること。ここを
   * すり抜けても、サーバー側のvalidateCreateBookingInputがfail-closedに拒否する
   * （CARD_PAYMENT_TOO_CLOSE_TO_START。既にERROR_MESSAGES/recoveryActionForErrorCodeへ
   * 対応済み）。
   */
  var CARD_PAYMENT_METHOD_VALUE = 'オンラインクレジットカード';
  var CARD_MIN_HOURS_BEFORE_START = 96;
  var CARD_TTL_HOURS = 72;

  function isCardPaymentMethodValue(value) {
    return value === CARD_PAYMENT_METHOD_VALUE;
  }

  /*
   * dateValue（'YYYY-MM-DD'）とtimeValue（'HH:mm'）をAsia/Tokyo基準の壁時計時刻として
   * 解釈し、その瞬間のUTC epoch msを返す（PRレビュー対応: 以前は「今日からの暦日差 × 1440分
   * + 分単位に切り捨てたstartMinutes/nowMinutes」で分単位の判定をしていたため、
   * 現在時刻の秒が切り捨てられる分だけ実際の残り時間より最大59秒長く見積もる方向の
   * バイアスがあり、96時間未満の申込を誤って受け付け可能と判定しうる不具合があった。
   * Asia/Tokyoは夏時間の無い固定UTC+9オフセットのtimezoneのため、Date.UTC(...)の月・日を
   * そのまま使い、時をUTC+9分だけ引くだけで正しい絶対時刻（epoch ms）が一意に求まる
   * （タイムゾーンデータベースへの依存なしに秒単位で正確）。この関数はミリ秒精度を返す
   * ため、以降の比較はdaysBetweenDateStrings_やcurrentMinutesInJapan_のような分単位の
   * 中間表現を経由しない。 */
  function jstWallClockToUtcMillis_(dateValue, timeValue) {
    var dateParts = (dateValue || '').split('-');
    var timeParts = (timeValue || '').split(':');
    var year = parseInt(dateParts[0], 10);
    var month = parseInt(dateParts[1], 10);
    var day = parseInt(dateParts[2], 10);
    var hour = parseInt(timeParts[0], 10);
    var minute = parseInt(timeParts[1], 10);
    return Date.UTC(year, month - 1, day, hour - 9, minute, 0, 0);
  }

  /*
   * カード決済を選べるかどうかの事前判定。dateValue/startTimeValueが未確定の間は
   * true（まだ判定できる材料がないため選択肢を塞がない）。日時が確定した時点
   * （Step2→Step3遷移時、および最終送信直前）で呼び出し側が再評価する
   * （PRレビュー対応: 確認画面を開いたまま96時間の受付期限をまたいだ場合に備え、
   * scripts/booking-app.jsのsubmitハンドラでも送信直前に呼び直す）。
   * gas/booking/shared/Booking.gsのvalidateCreateBookingInput（`< CARD_MIN_HOURS_BEFORE_START`
   * で拒否＝ちょうど96時間は許可）と同じ境界（>=で許可）をミリ秒精度で判定する。
   */
  function isCardPaymentEligible(dateValue, startTimeValue, now) {
    if (!isNonEmpty(dateValue) || !isNonEmpty(startTimeValue)) return true;
    var base = isDateLike_(now) ? now : new Date();
    var startMillis = jstWallClockToUtcMillis_(dateValue, startTimeValue);
    var msUntilStart = startMillis - base.getTime();
    return msUntilStart >= CARD_MIN_HOURS_BEFORE_START * 3600000;
  }

  var WEEKDAY_LABELS_JA_ = ['日', '月', '火', '水', '木', '金', '土'];

  /* Date（絶対時刻）をAsia/Tokyo基準の'YYYY-MM-DD（曜）HH:mm'へ整形する。
     gas/booking/shared/Availability.gsのformatDateWithWeekdayと表示体裁を揃える。 */
  function formatDateTimeWithWeekdayInJapan_(date) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(date);
    var result = {};
    parts.forEach(function (part) { if (part.type !== 'literal') result[part.type] = part.value; });
    var weekdayIndex = new Date(Date.UTC(
      parseInt(result.year, 10), parseInt(result.month, 10) - 1, parseInt(result.day, 10)
    )).getUTCDay();
    return result.year + '-' + result.month + '-' + result.day +
      '（' + WEEKDAY_LABELS_JA_[weekdayIndex] + '） ' + result.hour + ':' + result.minute;
  }

  /*
   * カード決済の支払期限の「目安」表示（フォーム送信前のみ使う）。実際の支払期限は
   * サーバー側の申込日時（createdAt）を起点に計算されるため、送信後は仮受付メールに
   * 記載される正式な期限を必ず確認するよう案内する（cardPaymentNoticeLines参照）。
   */
  function cardPaymentDueDisplay(now) {
    var base = isDateLike_(now) ? now : new Date();
    var due = new Date(base.getTime() + CARD_TTL_HOURS * 3600000);
    return formatDateTimeWithWeekdayInJapan_(due);
  }

  var CARD_PAYMENT_INELIGIBLE_NOTICE = {
    ja: 'カード事前決済は利用開始の4日前までのお申し込みです。直前のご予約は現金・PayPay（現地決済）をお選びください。',
    en: 'Card prepayment is only available up to 4 days before your start time. For last-minute bookings, please choose cash or PayPay (pay on site).'
  };

  function cardPaymentIneligibleNotice(locale) {
    return CARD_PAYMENT_INELIGIBLE_NOTICE[normalizeLocale(locale)];
  }

  /* フォーム（支払方法欄・確認画面）で使うカード決済の注意書き本文（Issue #334本文の
     引用ブロックと一致させる）。仮受付メール側（gas/booking/shared/BookingMailTemplates.gsの
     buildCardPendingNotice_）は、この末尾行と重複する既存の仮受付案内が別にあるため、
     その行を省いた独自の組み立てを別途持つ（テキストの正はこちら1か所ではなく、
     フォーム/メールそれぞれの文脈に応じて必要な行だけを使う）。 */
  var CARD_PAYMENT_NOTICE_TEXT_ = {
    ja: {
      title: '【クレジットカード決済のご案内】',
      linkTiming: '決済リンクは、お申し込みから24時間以内にメールでお送りします。',
      dueLabel: function (dueDisplay) { return 'お支払い期限：お申し込みから72時間後（' + dueDisplay + '）'; },
      expiry: '期限までにお支払いのうえ、予約確定のご案内をお待ちください。期限までに予約が確定しなかった場合は、予約が自動的に失効します。',
      reapply: '失効後もご利用を希望される場合は、改めて予約フォームからお申し込みください。',
      alreadyPaid: 'すでにお支払い済みの場合は、再申し込みや二重決済をせず、運営までご連絡ください。',
      pendingNote: '※お申し込み時点では仮受付です。入金確認後、当施設の承認をもって予約確定となります。'
    },
    en: {
      title: '[Credit Card Payment]',
      linkTiming: 'We will email you a payment link within 24 hours of your request.',
      dueLabel: function (dueDisplay) { return 'Payment due: 72 hours after your request (' + dueDisplay + ')'; },
      expiry: 'Please complete payment before the deadline and wait for booking confirmation. If the booking is not confirmed by the deadline, it will expire automatically.',
      reapply: 'If you still wish to book after it expires, please submit a new request through the booking form.',
      alreadyPaid: 'If you have already paid, please contact us instead of submitting a new request or paying again.',
      pendingNote: 'Your request is only a provisional hold at this point. The booking is confirmed only after we verify payment and approve it.'
    }
  };

  /* dueDisplay/localeに加え、options.omitPendingNote:trueで末尾の「仮受付です」行を省く
     （仮受付メール本文で既存の仮受付案内と重複させないため。フォーム表示側は省かない）。 */
  function cardPaymentNoticeLines(dueDisplay, locale, options) {
    var t = CARD_PAYMENT_NOTICE_TEXT_[normalizeLocale(locale)];
    var opts = options || {};
    var lines = [t.title, t.linkTiming, t.dueLabel(dueDisplay), t.expiry, t.reapply, t.alreadyPaid];
    if (!opts.omitPendingNote) lines.push(t.pendingNote);
    return lines;
  }

  /*
   * ── 月間空き状況カレンダー（Issue #318） ──
   * gas/booking/shared/Availability.gsのgetMonthlyAvailabilityが返すDAY_STATUS（5値）を
   * 記号・aria-label・選択可否へ変換する、DOM非依存の純粋ロジック。
   * 空き判定そのもの（何件あれば◎/○/△/×か）はGAS側（Availability.gsのgetMonthlyAvailability）
   * が正であり、ここではGASが返したstatus文字列をどう見せるかだけを扱う
   * （判定ロジックの再実装・複製はしない）。
   */
  var DAY_STATUSES = {
    AVAILABLE_HIGH: 'AVAILABLE_HIGH',
    AVAILABLE: 'AVAILABLE',
    LIMITED: 'LIMITED',
    FULL: 'FULL',
    OUT_OF_RANGE: 'OUT_OF_RANGE'
  };

  /* ○/◎/△は選択可能、×/－（予約可能枠なし・対象外）は選択不可。
     「今日＋初回利用」は別途isSameDayFirstTimeBlockedで上書きする（下記参照）。 */
  var SELECTABLE_DAY_STATUSES_ = [DAY_STATUSES.AVAILABLE_HIGH, DAY_STATUSES.AVAILABLE, DAY_STATUSES.LIMITED];

  function isBookableDayStatus(status) {
    return SELECTABLE_DAY_STATUSES_.indexOf(status) !== -1;
  }

  var DAY_STATUS_SYMBOLS_ = {
    AVAILABLE_HIGH: '◎',
    AVAILABLE: '○',
    LIMITED: '△',
    FULL: '×',
    OUT_OF_RANGE: '－'
  };

  /* 記号だけに依存しないアクセシビリティ対応（Issue #318要件）のため、aria-label用の
     文言を別途用意する。色・記号を見なくても状態が分かるようにする。 */
  var DAY_STATUS_LABELS_ = {
    ja: {
      AVAILABLE_HIGH: '空き時間が十分あります',
      AVAILABLE: '空きあります',
      LIMITED: '残り枠が少ないです',
      FULL: '予約可能枠がありません',
      OUT_OF_RANGE: '予約対象外です'
    },
    en: {
      AVAILABLE_HIGH: 'Plenty of availability',
      AVAILABLE: 'Available',
      LIMITED: 'Limited availability',
      FULL: 'Fully booked',
      OUT_OF_RANGE: 'Not available'
    }
  };

  function dayStatusSymbol(status) {
    return DAY_STATUS_SYMBOLS_[status] || '';
  }

  function dayStatusLabel(status, locale) {
    var labels = DAY_STATUS_LABELS_[normalizeLocale(locale)];
    return labels[status] || '';
  }

  /*
   * カレンダー上のセルが選択可能かどうか。GASのstatus判定に加えて、当日＋初回利用の
   * 組み合わせは（getAvailability自体がcustomerTypeを見ないため）ここで上書きして
   * 選択不可にする（Issue #318追記のテスト要件: 「今日」セルが初回利用選択時は
   * 選択不可／警告になることを再現する）。最終的な可否の正はcreateBookingの
   * サーバー側検証であり、ここはUX目的の一次チェック（既存のisSameDayFirstTimeBlockedと
   * 同じ位置づけ）。
   */
  function isCalendarDaySelectable(dateValue, status, customerType, todayValue) {
    if (!isBookableDayStatus(status)) return false;
    if (isSameDayFirstTimeBlocked(dateValue, customerType, todayValue)) return false;
    return true;
  }

  /*
   * ── 希望時間帯フィルタ（Issue #324） ──
   * gas/booking/shared/Availability.gsのfilterStartTimesByTimeBand/normalizeTimeBandと
   * 同じ4値・同じ境界値をフロント側でも持つ（GASとブラウザは別ランタイムのため共有
   * importはできない。DAY_STATUSES等、既存の月間カレンダー機能と同じ方針で複製する）。
   * ここでの絞り込みはStep2（単日開始時刻一覧）表示専用。月間カレンダーの記号判定
   * そのものはGAS側getMonthlyAvailabilityが正で、ここでは再実装しない。
   */
  var TIME_BANDS = {
    ALL: 'all',
    MORNING: 'morning',
    DAYTIME: 'daytime',
    EVENING: 'evening'
  };
  var ALLOWED_TIME_BANDS_ = [TIME_BANDS.ALL, TIME_BANDS.MORNING, TIME_BANDS.DAYTIME, TIME_BANDS.EVENING];

  /* 未指定・不正値はallへフォールバックする（Issue #324本文レビュー追記4と同じ方針。
     GAS側normalizeTimeBandと同じ規則）。 */
  function normalizeTimeBand(value) {
    return ALLOWED_TIME_BANDS_.indexOf(value) !== -1 ? value : TIME_BANDS.ALL;
  }

  var TIME_BAND_LABELS_ = {
    ja: { all: '指定なし', morning: '午前', daytime: '昼', evening: '夜' },
    en: { all: 'Any time', morning: 'Morning', daytime: 'Afternoon', evening: 'Evening' }
  };

  function timeBandLabel(value, locale) {
    var labels = TIME_BAND_LABELS_[normalizeLocale(locale)];
    return labels[normalizeTimeBand(value)];
  }

  var TIME_BAND_MORNING_START_MIN_ = 8 * 60;      /* 08:00 */
  var TIME_BAND_MORNING_END_MIN_ = 11 * 60 + 45;  /* 11:45 */
  var TIME_BAND_DAYTIME_START_MIN_ = 12 * 60;     /* 12:00 */
  var TIME_BAND_DAYTIME_END_MIN_ = 17 * 60 + 45;  /* 17:45 */
  var TIME_BAND_EVENING_START_MIN_ = 18 * 60;     /* 18:00 */

  function timeStringToMinutes_(hhmm) {
    var parts = (typeof hhmm === 'string' ? hhmm : '').split(':');
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
  }

  function isStartTimeInTimeBand_(hhmm, band) {
    var minutes = timeStringToMinutes_(hhmm);
    if (band === TIME_BANDS.MORNING) return minutes >= TIME_BAND_MORNING_START_MIN_ && minutes <= TIME_BAND_MORNING_END_MIN_;
    if (band === TIME_BANDS.DAYTIME) return minutes >= TIME_BAND_DAYTIME_START_MIN_ && minutes <= TIME_BAND_DAYTIME_END_MIN_;
    if (band === TIME_BANDS.EVENING) return minutes >= TIME_BAND_EVENING_START_MIN_;
    return true; /* all */
  }

  /*
   * Step2（単日開始時刻一覧）を、月間カレンダーで選んだ日と同じtimeBandで絞り込む
   * （Issue #324本文レビュー追記2）。GAS側の単日getAvailability自体は変更しない。
   */
  function filterStartTimesByTimeBand(times, timeBand) {
    var band = normalizeTimeBand(timeBand);
    var list = times || [];
    if (band === TIME_BANDS.ALL) return list.slice();
    return list.filter(function (time) { return isStartTimeInTimeBand_(time, band); });
  }

  var MONTH_NAMES_EN_ = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  function pad2_(n) {
    return (n < 10 ? '0' : '') + n;
  }

  /* year/month（数値）を画面見出し用に整形する。例: ja '2026年10月' / en 'October 2026'。 */
  function monthLabel(year, month, locale) {
    if (normalizeLocale(locale) === 'en') return MONTH_NAMES_EN_[month - 1] + ' ' + year;
    return year + '年' + month + '月';
  }

  /* dateValue（'YYYY-MM-DD'）を日単位の見出し用に整形する。例: ja '10月5日' / en 'October 5'。
     aria-labelの先頭（「10月5日 空きあり」等）に使う。 */
  function formatCalendarDayLabel(dateValue, locale) {
    var parts = (dateValue || '').split('-');
    var month = parseInt(parts[1], 10);
    var day = parseInt(parts[2], 10);
    if (normalizeLocale(locale) === 'en') return MONTH_NAMES_EN_[month - 1] + ' ' + day;
    return month + '月' + day + '日';
  }

  /* カレンダーの日セルのaria-label。記号・色だけに依存しないアクセシビリティ対応
     （Issue #318要件）。「今日＋初回利用」の場合はSAME_DAY_NOT_ALLOWED_FOR_FIRST_TIMEの
     メッセージをそのまま使い、通常のstatusラベルとメッセージを二重に定義しない。 */
  function dayAriaLabel(dateValue, status, customerType, todayValue, locale) {
    var loc = normalizeLocale(locale);
    var dayLabel = formatCalendarDayLabel(dateValue, loc);
    if (isSameDayFirstTimeBlocked(dateValue, customerType, todayValue)) {
      return dayLabel + '　' + messageForErrorCode('SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME', loc);
    }
    return dayLabel + '　' + dayStatusLabel(status, loc);
  }

  function daysInCalendarMonth_(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function firstWeekdayOfCalendarMonth_(year, month) {
    return new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  }

  /*
   * year/month（数値）の月間カレンダーを、7列（日〜土）×5〜6週の2次元配列として返す。
   * 各セルはnull（月外の空白セル）か { day, dateValue } のいずれか。
   * 月初の曜日位置・月末までの週数（28〜31日、5〜6週）を実行環境のローカルtimezoneに
   * 依存せずDate.UTC構築方式で計算する（gas/booking/shared/Availability.gsの
   * isValidDateString等と同じ方針）。
   */
  function buildMonthMatrix(year, month) {
    var totalDays = daysInCalendarMonth_(year, month);
    var startWeekday = firstWeekdayOfCalendarMonth_(year, month);
    var monthPrefix = year + '-' + pad2_(month) + '-';

    var cells = [];
    for (var i = 0; i < startWeekday; i++) cells.push(null);
    for (var day = 1; day <= totalDays; day++) {
      cells.push({ day: day, dateValue: monthPrefix + pad2_(day) });
    }
    while (cells.length % 7 !== 0) cells.push(null);

    var weeks = [];
    for (var w = 0; w < cells.length; w += 7) weeks.push(cells.slice(w, w + 7));
    return weeks;
  }

  /* year/month（数値）をdelta ヶ月分ずらした{year, month}を返す（年跨ぎ対応）。
     例: shiftMonth(2026, 12, 1) → {year: 2027, month: 1}、shiftMonth(2026, 1, -1) → {year: 2025, month: 12}。 */
  function shiftMonth(year, month, delta) {
    var totalMonths = year * 12 + (month - 1) + delta;
    var newYear = Math.floor(totalMonths / 12);
    var newMonth = (totalMonths % 12) + 1;
    return { year: newYear, month: newMonth };
  }

  /* dateValue（'YYYY-MM-DD'）から{year, month}（数値）を取り出す。カレンダー初期表示月
     （Logic.todayInJapan()の月）を求めるために使う。 */
  function yearMonthFromDateValue(dateValue) {
    var parts = (dateValue || '').split('-');
    return { year: parseInt(parts[0], 10), month: parseInt(parts[1], 10) };
  }

  /* 曜日インデックス（0=日〜6=土）から表示色分け用のクラス名を返す（日曜:赤系、土曜:青系、
     平日:通常色。Issue #318要件）。 */
  function weekdayColumnClass(index) {
    if (index === 0) return 'ba-cal-sun';
    if (index === 6) return 'ba-cal-sat';
    return 'ba-cal-weekday';
  }

  /*
   * JST（日本時間）での「今日」を'YYYY-MM-DD'で返す。日付入力の下限（過去日を選べなくする）と、
   * isSameDayFirstTimeBlockedへ渡す「当日かどうか」の判定基準の両方に使う（Issue #270）。
   * ブラウザのローカルtimezoneには依存せず、常にAsia/Tokyo基準で計算する。
   * ここでの判定はあくまでUI側の一次チェック（UX目的）であり、最終的な当日予約可否の正は
   * createBookingのサーバー側検証（gas/booking/shared/Booking.gsのformatDateInTimezoneも同じ方針で
   * availabilityConfig.timezone基準の暦日を計算する）。
   */
  function todayInJapan(now) {
    var base = isDateLike_(now) ? now : new Date();
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(base);
    var result = {};
    parts.forEach(function (part) { if (part.type !== 'literal') result[part.type] = part.value; });
    return result.year + '-' + result.month + '-' + result.day;
  }

  var api = {
    DEFAULT_LOCALE: DEFAULT_LOCALE,
    SUPPORTED_LOCALES: SUPPORTED_LOCALES,
    normalizeLocale: normalizeLocale,
    getBrandMeta: getBrandMeta,
    CUSTOMER_TYPES: CUSTOMER_TYPES,
    ALLOWED_CUSTOMER_TYPES: ALLOWED_CUSTOMER_TYPES,
    isAllowedCustomerType: isAllowedCustomerType,
    customerTypeLabel: customerTypeLabel,
    isSameDayFirstTimeBlocked: isSameDayFirstTimeBlocked,
    messageForErrorCode: messageForErrorCode,
    recoveryActionForErrorCode: recoveryActionForErrorCode,
    NETWORK_ERROR_MESSAGE: NETWORK_ERROR_MESSAGE,
    API_NOT_CONFIGURED_MESSAGE: API_NOT_CONFIGURED_MESSAGE,
    networkErrorMessage: networkErrorMessage,
    apiNotConfiguredMessage: apiNotConfiguredMessage,
    isNonEmpty: isNonEmpty,
    isValidEmail: isValidEmail,
    isValidPhone: isValidPhone,
    durationHoursToMinutes: durationHoursToMinutes,
    UI_MIN_BOOKING_MINUTES: UI_MIN_BOOKING_MINUTES,
    isDurationAtLeastUiMinimum: isDurationAtLeastUiMinimum,
    computeEndTime: computeEndTime,
    validateDetailsForm: validateDetailsForm,
    buildPurposeValue: buildPurposeValue,
    peopleLabel: peopleLabel,
    purposeLabel: purposeLabel,
    paymentMethodLabel: paymentMethodLabel,
    buildCreateBookingPayload: buildCreateBookingPayload,
    todayInJapan: todayInJapan,
    DAY_STATUSES: DAY_STATUSES,
    isBookableDayStatus: isBookableDayStatus,
    dayStatusSymbol: dayStatusSymbol,
    dayStatusLabel: dayStatusLabel,
    isCalendarDaySelectable: isCalendarDaySelectable,
    TIME_BANDS: TIME_BANDS,
    normalizeTimeBand: normalizeTimeBand,
    timeBandLabel: timeBandLabel,
    filterStartTimesByTimeBand: filterStartTimesByTimeBand,
    monthLabel: monthLabel,
    formatCalendarDayLabel: formatCalendarDayLabel,
    dayAriaLabel: dayAriaLabel,
    buildMonthMatrix: buildMonthMatrix,
    shiftMonth: shiftMonth,
    yearMonthFromDateValue: yearMonthFromDateValue,
    weekdayColumnClass: weekdayColumnClass,
    CARD_PAYMENT_METHOD_VALUE: CARD_PAYMENT_METHOD_VALUE,
    CARD_MIN_HOURS_BEFORE_START: CARD_MIN_HOURS_BEFORE_START,
    CARD_TTL_HOURS: CARD_TTL_HOURS,
    isCardPaymentMethodValue: isCardPaymentMethodValue,
    isCardPaymentEligible: isCardPaymentEligible,
    cardPaymentDueDisplay: cardPaymentDueDisplay,
    cardPaymentIneligibleNotice: cardPaymentIneligibleNotice,
    cardPaymentNoticeLines: cardPaymentNoticeLines
  };

  global.BookingLogic = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : this);
