/*
 * BookingPricing.gs — 予約料金の自動計算（Issue #342）。
 *
 * 予約時点の条件（ブランド・利用日の平日/土日祝・利用時間・会員区分）から利用料金を
 * 計算する、GAS実行環境に依存しない純粋関数のみを置く（Availability.gs / Booking.gsと
 * 同方針。node --testでそのままvm実行して検証できる）。
 *
 * 料金表はここ1箇所のみに定義する（フロントエンドでの重複定義はしない。フロントは
 * Code.gsの`estimatePrice`（doGetアクション）経由でここを呼ぶだけ。createBooking時の
 * 確定金額もBookingRepository.gsが必ずここを呼んで再計算し、フロントから送られた金額は
 * 一切信用しない）。
 *
 * 料金表の出典（Issue #342調査結果。値はサイト掲載価格をそのまま転記）:
 * - GENERAL（一般/直接予約）: SNB本体（index.html）の「通常価格」表・Studio X
 *   （studio-x/index.html）の掲載価格と一致。
 * - MEMBER（会員）: SNB本体の「会員価格」表・SNB mens（mens/index.html）の掲載価格
 *   （mensページは常にこの表のみを掲載しており、通常価格表はページ上に存在しない）と一致。
 *
 * 会員区分（tier）の決定方針（Issue #342のユーザー確認、およびPR #343レビュー
 * （ブランド分離基準書v1.1）を反映。studio_xの扱いをPR #343レビューで修正）:
 * - studio_x: ブランド分離基準書v1.1により、直接予約（このGAS予約フォーム経由の予約。
 *   スペースマーケット等の外部プラットフォーム予約はそもそもこの経路を通らない）には
 *   SNB本体と共通の会員基準を適用する。snbと同じくisMember入力でGENERAL/MEMBERを
 *   決める（当初Issue #342時点では「Studio Xに会員概念なし」としてisMember入力を
 *   無視し常にGENERALにしていたが、PR #343レビューでこれは誤りと判明したため修正した）。
 * - mens: ランディングページが常に会員相当の価格のみを掲載しているため、isMember入力を
 *   無視して常にMEMBER（現行の「メンズページを見た」自己申告による割引運用をそのまま
 *   自動化したもの）。
 * - snb / studio_x: いずれも予約フォームの自己申告（isMember）でGENERAL/MEMBERを決める。
 *   未指定・不正値はfail-closedでGENERAL（会員特典を誤って適用しない方向へ倒す）。
 * 実際に会員資格が本物かどうかの最終確認は、既存どおり管理者が予約確定前に行い、
 * 必要であればBookingRepository.updateBookingPriceで金額を補正する（このファイルの
 * 責務ではない）。
 *
 * スコープ外（Issue #342で明示。ここでは一切扱わない）:
 * - Studio Xの下見プラン充当・SNBの平日6時間パス（継続利用者向け月額）・
 *   機材レンタルオプション（会員限定DM申告）。いずれも予約フォームに対応する入力項目が
 *   なく、自動計算の対象にできないため、管理者が確定前の金額修正機能で個別対応する。
 *
 * 曜日区分（DAY_TYPE）の判定（Issue #346で拡張。旧Issue #342時点では土曜/日曜のみを
 * 「土日祝」としていたが、月〜金の日本の祝日・振替休日・国民の休日に平日料金が
 * 適用されてしまう既知の制限があった）:
 * - resolveDayType_は、対象日について必ずJapaneseHolidays.classify（
 *   gas/booking/shared/JapaneseHolidays.gs。国民の祝日・振替休日・国民の休日を判定
 *   する）を呼んでから、その結果と土曜・日曜かどうかを合わせてWEEKEND_HOLIDAY/WEEKDAY
 *   を決める。JapaneseHolidays.classifyの呼び出しを土日判定より後回しにしない
 *   （PR #347レビュー対応。先に土日判定を済ませてしまうと、対応年範囲外の土曜・日曜が
 *   祝日判定の検証を経由せず「たまたま」料金計算に成功する一方、同じ日付範囲の月〜金
 *   だけがエラーになるという非対称なfail-closedになってしまうため、曜日を問わず一律で
 *   まずJapaneseHolidays.classifyの成否を確認する）。
 * - JapaneseHolidays.classifyが対応年の範囲外等で判定を確定できない場合、resolveDayType_は
 *   黙って平日（WEEKDAY）にフォールバックせず、computeBookingPriceをvalid:falseで
 *   返させる（見積り・予約作成の両方が明示的なエラーになる。過少請求を避ける方針。
 *   詳細はJapaneseHolidays.gsのファイル冒頭コメント参照）。
 */
'use strict';

var BookingPricing = (function () {
  var CURRENCY_ = 'JPY';

  var TIER = { GENERAL: 'GENERAL', MEMBER: 'MEMBER' };
  var DAY_TYPE = { WEEKDAY: 'WEEKDAY', WEEKEND_HOLIDAY: 'WEEKEND_HOLIDAY' };

  /*
   * 2/3/4時間は基本料金の表引き、4時間を超えた分だけ1時間ごとにextensionPerHourを加算する。
   * 2時間未満の入力はbillableHours_で2時間へ切り上げるため、この表に2時間未満のキーはない。
   */
  var RATE_TABLES_ = {
    GENERAL: {
      WEEKDAY: { base: { 2: 4000, 3: 6000, 4: 8000 }, extensionPerHour: 2000 },
      WEEKEND_HOLIDAY: { base: { 2: 5000, 3: 7500, 4: 10000 }, extensionPerHour: 2500 }
    },
    MEMBER: {
      WEEKDAY: { base: { 2: 4000, 3: 5500, 4: 7000 }, extensionPerHour: 1500 },
      WEEKEND_HOLIDAY: { base: { 2: 5000, 3: 7000, 4: 9000 }, extensionPerHour: 2000 }
    }
  };

  /* mensのみisMember入力を無視して常にMEMBERへ固定する。snb/studio_xはいずれも
     自己申告（isMember）でGENERAL/MEMBERを決める（PR #343レビュー対応。ブランド
     分離基準書v1.1によりstudio_xの直接予約にもSNB共通の会員基準を適用する）。 */
  function resolveTier_(brand, isMemberInput) {
    if (brand === 'mens') return TIER.MEMBER;
    return isMemberInput === true ? TIER.MEMBER : TIER.GENERAL;
  }

  function isValidDateString_(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  }

  /*
   * dateStringは呼び出し側（Booking.gs/Availability.gsの既存パースと同じ方針）で
   * 施設のtimezone基準に正規化済みの'YYYY-MM-DD'であることを前提とする。ブラウザの
   * ローカルtimezoneに依存しないよう、常にDate.UTC構築方式で曜日を求める。
   *
   * 戻り値: { ok: true, dayType } または { ok: false, error }（Issue #346。
   * JapaneseHolidays.classifyが対応年範囲外等で祝日判定を確定できなかった場合）。
   *
   * PR #347レビュー対応: 対応年範囲の検証（JapaneseHolidays.classify呼び出し）を
   * 土曜/日曜の判定より先に行う。土日判定を先に行ってしまうと、対応年範囲外の
   * 土曜・日曜だけがJapaneseHolidays側の検証を経由せず「たまたま」料金計算に成功して
   * しまい、同じ日付の月〜金だけが明示的なエラーになるという非対称なfail-closedに
   * なる。祝日判定を確定できない日付は、曜日を問わず一律でエラーにする。
   */
  function resolveDayType_(dateString) {
    var parts = dateString.split('-');
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var day = parseInt(parts[2], 10);
    var weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    var holiday = JapaneseHolidays.classify(dateString);
    if (!holiday.ok) {
      return { ok: false, error: holiday.error };
    }
    var isWeekendOrHoliday = weekday === 0 || weekday === 6 || holiday.isHoliday;
    return { ok: true, dayType: isWeekendOrHoliday ? DAY_TYPE.WEEKEND_HOLIDAY : DAY_TYPE.WEEKDAY };
  }

  /*
   * 実際の予約UIは常に整数時間（60分単位）のdurationMinutesしか送らないが、サーバー側は
   * フロントからの入力を信用しないため、想定外の分単位（例: 90分）が来ても過小請求に
   * ならないよう常に時間単位へ切り上げる。最低利用時間の妥当性検証自体はBooking.gs
   * （validateCreateBookingInput）側の責務であり、ここでは料金表に存在しない時間帯
   * （2時間未満）を参照しないためだけに2時間へ切り上げる。
   */
  function billableHours_(durationMinutes) {
    var hours = Math.ceil(Number(durationMinutes) / 60);
    return hours < 2 ? 2 : hours;
  }

  function computeAmount_(tier, dayType, hours) {
    var table = RATE_TABLES_[tier][dayType];
    if (hours <= 4) return table.base[hours];
    return table.base[4] + (hours - 4) * table.extensionPerHour;
  }

  /*
   * input: { brand, date ('YYYY-MM-DD'), durationMinutes, isMember }
   * 戻り値: { valid: true, price: {...} } または { valid: false, error: {code, message} }。
   *
   * brand/date/durationMinutesの本格的な入力検証はBooking.validateCreateBookingInput /
   * BookingAvailability.validateInput側で既に行われている前提だが、この関数単体を
   * 誤った入力で呼んでも例外を投げてcreateBooking全体を落とさないよう、
   * 最低限の形式チェックだけをここでも行う（fail-closed）。
   */
  function computeBookingPrice(input) {
    var params = input || {};
    var brand = params.brand;
    var date = params.date;
    var durationMinutes = params.durationMinutes;

    if (brand !== 'snb' && brand !== 'mens' && brand !== 'studio_x') {
      return { valid: false, error: { code: 'INVALID_BRAND', message: 'このブランドでは料金を計算できません。' } };
    }
    if (!isValidDateString_(date)) {
      return { valid: false, error: { code: 'INVALID_DATE', message: '日付の形式が正しくありません（YYYY-MM-DD）。' } };
    }
    if (!Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) <= 0) {
      return { valid: false, error: { code: 'INVALID_DURATION', message: '利用時間（分）が正しくありません。' } };
    }

    var tier = resolveTier_(brand, params.isMember === true);
    var dayTypeResult = resolveDayType_(date);
    if (!dayTypeResult.ok) {
      return { valid: false, error: dayTypeResult.error };
    }
    var dayType = dayTypeResult.dayType;
    var hours = billableHours_(durationMinutes);
    var amount = computeAmount_(tier, dayType, hours);

    return {
      valid: true,
      price: {
        amount: amount,
        currency: CURRENCY_,
        brand: brand,
        tier: tier,
        /* mensではisMemberInputを無視して上書きした結果（実際に適用されたtier）を返す。
           呼び出し側はこの値をSheetsへ保存し、入力値ではなく「実際に何が適用されたか」を
           後から追跡できるようにする。 */
        isMember: tier === TIER.MEMBER,
        dayType: dayType,
        billableHours: hours,
        durationMinutes: Number(durationMinutes)
      }
    };
  }

  return {
    TIER: TIER,
    DAY_TYPE: DAY_TYPE,
    CURRENCY: CURRENCY_,
    computeBookingPrice: computeBookingPrice
  };
})();
