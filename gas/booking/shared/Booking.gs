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
 *
 * Issue #270で追加した当日利用ルール:
 * - 「会員かどうか」ではなく「利用区分（customerType。初回利用/利用経験あり）」で
 *   当日予約可否を判定する。CUSTOMER_TYPES/isAllowedCustomerType参照。
 * - 当日判定は必ずavailabilityConfig.timezone（既定Asia/Tokyo）基準で行い、
 *   ブラウザのローカルtimezoneには依存しない（formatDateInTimezone参照。実体は
 *   BookingAvailability.formatDateInTimezone）。
 * - 当日（isSameDayBooking）は、開始時刻が現在時刻より後であることも必須とする
 *   （レビュー対応で追加。SAME_DAY_START_TIME_PASSED。現在時刻の判定は
 *   BookingAvailability.getCurrentMinutesInTimezoneを使う）。
 * - brandでこのルールを分岐させない（snb/mens/studio_xは同一施設という前提はIssue #269と同じ）。
 */
'use strict';

var Booking = (function () {
  var STATUS = {
    PENDING: 'PENDING',
    CONFIRMED: 'CONFIRMED',
    CANCELLED: 'CANCELLED',
    EXPIRED: 'EXPIRED'
  };

  var PAYMENT_STATUS = {
    UNPAID: 'unpaid',
    PAID: 'paid'
  };

  /* 予約作成できるbrandはこの3つのみ（Issue #269）。brand偽装で未知のbrandから
     予約を作れないよう、フロントの表示に関わらずサーバー側でこの一覧のみ許可する。 */
  var ALLOWED_BOOKING_BRANDS = ['snb', 'mens', 'studio_x'];

  /*
   * 利用区分（Issue #270）。「会員かどうか」ではなく、SNB / SNB mens / Studio X という
   * 同一施設を過去に利用した経験があるかどうかで当日予約可否を判定する。
   * brandをまたいで自己申告する値であり、DB照合はしない（Issue #270本文の非対象）。
   * 表示文言と内部値を混同しないよう、内部値はfirst_time/returningの2値のみで固定する
   * （既存にこの区分の正式名称が無かったため、Issue #270本文の例示どおり採用した）。
   */
  var CUSTOMER_TYPES = { FIRST_TIME: 'first_time', RETURNING: 'returning' };
  var ALLOWED_CUSTOMER_TYPES = [CUSTOMER_TYPES.FIRST_TIME, CUSTOMER_TYPES.RETURNING];

  /* Sheets台帳・管理者向け表示にのみ使う。判定ロジックはCUSTOMER_TYPESの内部値のみで行う。 */
  var CUSTOMER_TYPE_LABELS_ = { first_time: '初回利用', returning: '利用経験あり' };

  function isAllowedCustomerType(value) {
    return ALLOWED_CUSTOMER_TYPES.indexOf(value) !== -1;
  }

  function getCustomerTypeLabel(value) {
    return CUSTOMER_TYPE_LABELS_[value] || String(value || '');
  }

  /* bookingIdの接頭辞。studio_xの'SX'はIssue #268から変更しない
     （既発行のbookingId・運用ドキュメントとの整合のため）。 */
  var BRAND_ID_PREFIX_ = { snb: 'SNB', mens: 'MENS', studio_x: 'SX' };

  /*
   * カード決済まわりの固定仕様値（Issue #334）。Script Propertiesではなくこの定数で
   * 一元管理する（Issue #334本文「Script Propertiesは変更しない」「しきい値は定数1か所で
   * 管理する」に従う）。
   * - PAYMENT_METHOD_CARD: 予約フォームのpaymentMethod値と一致させる唯一の正
   *   （_includes/booking_app_ja.htmlのvalue="オンラインクレジットカード"と一致させること）。
   * - CARD_TTL_HOURS: カード予約のみに適用するPENDING TTL（受付から72時間）。
   *   現金/PayPay/未定の基本TTL（Script PropertiesのPENDING_TTL_HOURS。既定24時間）は
   *   このIssueでは変更しない。
   * - CARD_MIN_HOURS_BEFORE_START: カード決済を受け付ける最低リードタイム（96時間）。
   *   これ未満の申込はvalidateCreateBookingInputで拒否する（GAS側のfail-closedな検証。
   *   フロント側の選択肢非表示はPR-Bの対象）。
   */
  var PAYMENT_METHOD_CARD = 'オンラインクレジットカード';
  var CARD_TTL_HOURS = 72;
  var CARD_MIN_HOURS_BEFORE_START = 96;

  function isCardPaymentMethod(paymentMethod) {
    return String(paymentMethod || '').trim() === PAYMENT_METHOD_CARD;
  }

  /*
   * Stripe決済リンクURLの検証（Issue #334 PR-C）。GASには`URL`クラスがないため、
   * 正規表現による厳密な完全一致（`^...$`）で判定する。email検証（EMAIL_PATTERN_）と
   * 同じ方針で、前後の空白・クエリ・フラグメント・ポート・userinfo・他ホストは
   * 一切許可しない。呼び出し側（BookingMailer.sendPaymentLinkMailForBooking）は
   * email検証と同じく、渡された値をtrimせずそのままここへ通す（trimしてから緩く
   * 検証すると、前後に空白を含む入力を誤って受理してしまうため）。
   */
  var STRIPE_PAYMENT_LINK_URL_PATTERN_ = /^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]+$/;

  function isValidStripePaymentLinkUrl(url) {
    return typeof url === 'string' && STRIPE_PAYMENT_LINK_URL_PATTERN_.test(url);
  }

  /* Calendarタイトル・管理者通知メール等、人が読む表示にのみ使うブランド名。
     空き判定・状態判定のロジックはこのラベルに一切依存しない。 */
  var BRAND_LABELS_ = { snb: 'SNB', mens: 'SNB mens', studio_x: 'Studio X' };

  function getBrandLabel(brand) {
    return BRAND_LABELS_[brand] || String(brand || '');
  }

  /*
   * PENDINGからCONFIRMED/CANCELLED/EXPIREDへ、CONFIRMEDからCANCELLEDへの遷移のみを許可する
   * （Issue #272で管理者キャンセルを追加し、CONFIRMEDを終端状態から外した）。
   * CANCELLED/EXPIREDはいずれも終端状態のまま（CANCELLED→CANCELLEDの二重実行は
   * この関数ではなくcancelBookingAdmin側でalreadyCancelledとして冪等に処理する）。
   */
  /*
   * EXPIRED→CONFIRMED（Issue #334の手動復活）はここに追加するが、実際にこの遷移を
   * 実行できるのは専用のBookingRepository.reviveExpiredBookingのみとする。
   * 既存のconfirmBooking（confirmBookingLocked_）はEXPIREDを拒否し続ける
   * （canTransitionが一般に「その遷移が制度として存在するか」を表す表であるのに対し、
   * confirmBookingは「その関数が実際に受け付ける遷移」をさらに絞り込む別の関数だと
   * 整理する。confirmBookingLocked_側に明示ガードを追加している理由はそこにある）。
   */
  var ALLOWED_TRANSITIONS = {
    PENDING: [STATUS.CONFIRMED, STATUS.CANCELLED, STATUS.EXPIRED],
    CONFIRMED: [STATUS.CANCELLED],
    EXPIRED: [STATUS.CONFIRMED]
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

  /* instanceof Dateではなくダックタイピングで判定する（別realm・vmサンドボックスを
     またぐテストでinstanceof Dateが偽陰性になるため。BookingRepository.gs/
     scripts/booking-logic.jsのisDateLike_と同じ方針）。 */
  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  /*
   * dateオブジェクトを指定timezoneの暦日として'YYYY-MM-DD'へ変換する（Issue #270）。
   * 実体はBookingAvailability.formatDateInTimezone（Availability.gs）で、getAvailabilityと
   * createBookingの両方が同じタイムゾーン変換ロジックを共有する（レビュー対応で
   * getCurrentMinutesInTimezoneと合わせてAvailability.gs側に一元化した）。
   * ここではBooking.gs内部の呼び出し・Booking.formatDateInTimezoneとしての
   * 後方互換エクスポートのために薄いエイリアスを用意する。
   */
  function formatDateInTimezone(date, timezone) {
    return BookingAvailability.formatDateInTimezone(date, timezone);
  }

  /*
   * rawInput: createBooking APIが受け取る生のリクエストボディ相当。
   * availabilityConfig: BookingConfig.getAvailabilityConfig()の戻り値
   *   （openTime/closeTime/minBookingMinutes/slotStepMinutes/bufferMinutes/timezone）。
   * now: 受付時刻（Date）。省略時は現在時刻。当日判定（Asia/Tokyo基準）に使う（Issue #270）。
   *
   * 戻り値: { valid: true, normalized: {...} } または { valid: false, error: {code, message} }。
   * normalizedはtrim済み・型を揃えた値のみを含み、以降の処理（bookingId発行・Calendar/Sheets保存）は
   * すべてこのnormalizedを使う（生入力を直接使わない）。
   */
  function validateCreateBookingInput(rawInput, availabilityConfig, now) {
    var input = rawInput || {};
    var receivedAt = isDateLike_(now) ? now : new Date();

    if (!isAllowedBrand(input.brand)) {
      return { valid: false, error: err_('INVALID_BRAND', 'このブランドではオンライン予約を受け付けていません。') };
    }

    /*
     * 利用区分（初回利用/利用経験あり）はIssue #270で必須項目とした。未指定・未知の値は
     * fail-closedで拒否する（フロントを書き換えてcustomerTypeを省略・改ざんしても
     * 当日予約制限を回避できないようにするための、サーバー側の必須検証）。
     */
    if (!isAllowedCustomerType(input.customerType)) {
      return { valid: false, error: err_('INVALID_CUSTOMER_TYPE', '利用区分（初回利用／利用経験あり）を選択してください。') };
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

    /*
     * 当日判定はブラウザのローカルtimezoneを正としない。受付時刻(receivedAt)を
     * availabilityConfig.timezone（既定Asia/Tokyo）基準の暦日へ変換し、入力された
     * 利用日(input.date)と文字列比較する（'YYYY-MM-DD'は辞書順=日付順に一致する）。
     * - 過去日は初回/利用経験ありを問わず拒否する
     * - 当日 + 初回利用は拒否する（Issue #270本文の最終仕様）
     * - 当日 + 利用経験ありはここでは拒否せず、以降の通常フローへ進む
     * - 翌日以降は初回/利用経験ありのどちらも通常フローへ進む
     * timezoneの設定自体が不正でIntlが解釈できない場合はfail-closedにINVALID_CONFIGとする
     * （BUFFER_MINUTES等の誤設定と同じ扱い。isValidConfig_はtimezoneの妥当性まで検証しないため、
     * ここで別途フォールバックする）。
     */
    var todayString = formatDateInTimezone(receivedAt, availabilityConfig.timezone);
    if (!todayString) {
      return { valid: false, error: err_('INVALID_CONFIG', '営業時間・予約ルールの設定が正しくありません。') };
    }
    if (input.date < todayString) {
      return { valid: false, error: err_('INVALID_DATE', '過去の日付は指定できません。') };
    }
    var isSameDayBooking = input.date === todayString;
    if (isSameDayBooking && input.customerType === CUSTOMER_TYPES.FIRST_TIME) {
      return {
        valid: false,
        error: err_(
          'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME',
          '初回利用の方は当日のご予約を受け付けていません。翌日以降の日付をお選びください。'
        )
      };
    }

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

    /*
     * 当日（isSameDayBooking）は、開始時刻が現在時刻より後であることを必須とする
     * （Issue #270レビュー対応）。現在時刻ちょうども不可（「後」であることを要求する）。
     * ここに到達する時点でfirst_time+当日は既に上でSAME_DAY_NOT_ALLOWED_FOR_FIRST_TIMEとして
     * 拒否済みのため、この判定に実際に到達するのはreturning+当日のみ。フロントの
     * getAvailabilityが過去時刻を候補から除外していても、フロント改変・タイミングのずれ
     * （空き取得後に時間が経過した等）でここまで来る可能性があるため、Calendar書き込み前に
     * 必ずここで再検証する。
     */
    if (isSameDayBooking) {
      var currentMinutes = BookingAvailability.getCurrentMinutesInTimezone(receivedAt, availabilityConfig.timezone);
      if (currentMinutes === null) {
        return { valid: false, error: err_('INVALID_CONFIG', '営業時間・予約ルールの設定が正しくありません。') };
      }
      if (startMinutes <= currentMinutes) {
        return {
          valid: false,
          error: err_(
            'SAME_DAY_START_TIME_PASSED',
            '指定した開始時刻はすでに過ぎています。現在時刻より後の開始時刻を選択してください。'
          )
        };
      }
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

    /*
     * カード決済の最低リードタイム（Issue #334）: 利用開始まで96時間（4日）未満の申込は
     * GAS側で拒否する（フロントの選択肢非表示に依存しないfail-closedな検証。フロント側の
     * 表示制御自体はPR-Bで対応する）。
     *
     * PR-Bレビュー対応: 以前は「今日からの暦日差×1440分＋分単位に丸めたstartMinutes/
     * 現在時刻」という分単位の中間表現で比較していたため、96時間ちょうど付近の秒・
     * ミリ秒単位の境界でフロント側（scripts/booking-logic.jsのisCardPaymentEligible。
     * 同じくミリ秒精度）の判定とずれうる不具合があった。ここではBookingAvailability.
     * zonedDateTimeToUtcMillisで利用開始日時をavailabilityConfig.timezone基準の絶対時刻
     * （UTC epoch ms）へ変換し、receivedAt（Dateとして既にミリ秒精度の絶対時刻）との差分を
     * そのままミリ秒で比較する。CARD_MIN_HOURS_BEFORE_START=96はそのまま維持し、
     * 新しいScript Propertiesは追加しない。
     */
    if (isCardPaymentMethod(input.paymentMethod)) {
      var cardStartAtMillis = BookingAvailability.zonedDateTimeToUtcMillis(
        input.date, input.startTime, availabilityConfig.timezone
      );
      if (cardStartAtMillis === null) {
        return { valid: false, error: err_('INVALID_CONFIG', '営業時間・予約ルールの設定が正しくありません。') };
      }
      var msUntilStart = cardStartAtMillis - receivedAt.getTime();
      if (msUntilStart < CARD_MIN_HOURS_BEFORE_START * 3600000) {
        return {
          valid: false,
          error: err_(
            'CARD_PAYMENT_TOO_CLOSE_TO_START',
            'カード事前決済は利用開始の4日前（96時間前）までのお申し込みに限ります。直前のご予約は現金・PayPay（現地決済）をお選びください。'
          )
        };
      }
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
        customerType: input.customerType,
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
   * 通常TTL（#268固定仕様。翌日以降の予約はこの式のみで決まる）:
   *   normalExpiry = min(受付+ttlHours, 利用開始-minHoursBeforeStart)
   *
   * minHoldHours（Issue #270レビュー対応で再設計。省略時0＝#268時点と完全に同じ挙動）:
   * 通常TTLの「利用開始-minHoursBeforeStart」が受付時刻以前になる場合（＝利用開始まで
   * minHoursBeforeStart未満しかない直前の当日予約）に限り、grace（猶予）を使う。
   * 「受付から少なくともminHoldHours時間は保持する」という単純な下限ではなく、
   * **利用開始時刻(startAtMillis)を必ず上限とする**（expiry <= startAt を保証する。
   * 当日PENDINGが利用開始後までCalendar/Sheets上に残ってしまう事故を防ぐため）。
   * 通常TTLが受付時刻より後になる場合（＝開始まで十分な余裕がある）はgraceを使わず、
   * 通常TTLをそのまま返す＝#268時点とビット単位で同じ値になる。
   */
  function computeTtlExpiryMillis(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart, minHoldHours) {
    var ttlExpiry = createdAtMillis + ttlHours * 3600000;
    var normalStartLimit = startAtMillis - minHoursBeforeStart * 3600000;
    var normalExpiry = Math.min(ttlExpiry, normalStartLimit);

    if (!minHoldHours || minHoldHours <= 0 || normalExpiry > createdAtMillis) {
      return normalExpiry;
    }

    var graceExpiry = createdAtMillis + minHoldHours * 3600000;

    return Math.min(ttlExpiry, graceExpiry, startAtMillis);
  }

  function isExpired(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart, nowMillis, minHoldHours) {
    return nowMillis >= computeTtlExpiryMillis(createdAtMillis, startAtMillis, ttlHours, minHoursBeforeStart, minHoldHours);
  }

  /*
   * カード予約の支払期限（＝PENDING TTL失効時刻）をミリ秒epochで返す（Issue #334）。
   * expirePendingBookings（失効判定）とBooking Admin表示（支払期限表示）の両方が
   * 必ずこの1関数だけを経由する（表示用と判定用で別計算・別定数を持たない）。
   * 内部はcomputeTtlExpiryMillisをCARD_TTL_HOURS固定・minHoldHours=0（当日受付グレースは
   * 適用しない。カードは96時間未満の申込自体をvalidateCreateBookingInputで拒否している
   * ため、通常運用でminHoldHoursのgraceが必要になるケースはそもそも発生しない）で
   * 呼び出すだけの薄いラッパー。minHoursBeforeStartは既存のPENDING_TTL_MIN_HOURS_BEFORE_START
   * （既定2時間。Script Properties経由。Issue #334で変更しない）をそのまま渡す。
   */
  function computeCardPaymentDueMillis(createdAtMillis, startAtMillis, minHoursBeforeStart) {
    return computeTtlExpiryMillis(createdAtMillis, startAtMillis, CARD_TTL_HOURS, minHoursBeforeStart, 0);
  }

  return {
    STATUS: STATUS,
    PAYMENT_STATUS: PAYMENT_STATUS,
    ALLOWED_BOOKING_BRANDS: ALLOWED_BOOKING_BRANDS,
    CUSTOMER_TYPES: CUSTOMER_TYPES,
    ALLOWED_CUSTOMER_TYPES: ALLOWED_CUSTOMER_TYPES,
    PAYMENT_METHOD_CARD: PAYMENT_METHOD_CARD,
    CARD_TTL_HOURS: CARD_TTL_HOURS,
    CARD_MIN_HOURS_BEFORE_START: CARD_MIN_HOURS_BEFORE_START,
    isCardPaymentMethod: isCardPaymentMethod,
    isValidStripePaymentLinkUrl: isValidStripePaymentLinkUrl,
    getBrandLabel: getBrandLabel,
    getCustomerTypeLabel: getCustomerTypeLabel,
    canTransition: canTransition,
    isAllowedBrand: isAllowedBrand,
    isAllowedCustomerType: isAllowedCustomerType,
    formatDateInTimezone: formatDateInTimezone,
    validateCreateBookingInput: validateCreateBookingInput,
    generateBookingId: generateBookingId,
    computeTtlExpiryMillis: computeTtlExpiryMillis,
    computeCardPaymentDueMillis: computeCardPaymentDueMillis,
    isExpired: isExpired
  };
})();
