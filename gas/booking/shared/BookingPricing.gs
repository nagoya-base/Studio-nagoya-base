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
 * - studio_x（Issue #470 / #486）: 会員料金の廃止は2026/12/1以降に作成される予約（V2）から。V2は
 *   isMember入力を無視して常にGENERALとし、GENERAL料金そのものは会員・非会員共通のセルフ利用
 *   基本料金（平日1,200円/時・土日祝1,500円/時の単純時間比例。Issue #486）とする。V1（〜2026/11/30作成）は従来どおり自己申告（isMember）で
 *   GENERAL/MEMBERを使い分ける。
 * - 料金世代（Issue #470）: 予約作成時刻でV1（〜2026/11/30）/V2（2026/12/1〜）を決めて
 *   予約へ保存し、日程変更でも保存済みの世代で再見積りする（現行表で再計算しない）。
 *   料金表はブランド別（snb/studio_x。mensはsnbのMEMBER表）に分離している。
 * - mens: 予約導線でMEMBER料金を自動適用する。会員資格の付与ではなく価格優遇のみ
 *   （isMember入力・SNB MEMBER加入有無は無関係）。
 * - snb: 予約フォームの自己申告（isMember）でGENERAL/MEMBERを決める。
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

  /* 料金世代。予約作成時に決まり、以後（日程変更を含む）その予約では変わらない。
     V1=2026/11/30までに作成された予約の旧料金、V2=2026/12/1以降に作成された予約の新料金。
     空・未知の値は旧予約（列追加前）とみなしV1へ倒す。 */
  var GENERATION = { V1: 'V1', V2: 'V2' };
  var GENERATION_V2_START_MS_ = Date.parse('2026-12-01T00:00:00+09:00');

  /*
   * Issue #478: 会員限定2名ペアパック。通常料金tier（GENERAL/MEMBER）の置換ではなく、独立したプランとして
   * 予約へプラン識別子（Bookings.planCode）を保存する。日程変更後も保持し、通常3時間料金へ化けない。
   * - 3時間（BASE_HOURS）が基本、1〜2名、平日5,000円／土日祝6,000円。延長は通常の会員延長料金（MEMBER_RATES_）。
   * - SNB / SNB mensのみ。2026/12/1以降に作成された予約（V2）のみ。actual membershipが必須（資格の確認は
   *   予約作成・日程変更・確定の各サーバー側処理が行い、この純粋関数は料金だけを決める）。
   * - 他の割引・優待との併用は無い（このプランの料金はisMember・価格overrideの影響を受けない）。
   */
  var PLAN = { MEMBER_PAIR_3H: 'member_pair_3h' };
  var PAIR_PACK_ = {
    brands: ['snb', 'mens'],
    baseHours: 3,
    maxPeople: 2,
    base: { WEEKDAY: 5000, WEEKEND_HOLIDAY: 6000 }
  };

  var MEMBER_RATES_ = {
    WEEKDAY: { base: { 1: 2000, 2: 4000, 3: 5500, 4: 7000 }, extensionPerHour: 1500 },
    WEEKEND_HOLIDAY: { base: { 1: 2500, 2: 5000, 3: 7000, 4: 9000 }, extensionPerHour: 2000 }
  };
  /* Issue #486: Studio X V2のセルフ利用基本料金（会員・非会員共通）。単純時間比例（1時間=平日1,200円/土日祝1,500円）。
     セルフ設営・原状復帰を含み、スタッフ設営等はプレミアムオプション（BookingOptions.gs）として別建て。
     SNB / mensの料金表には連動させない。 */
  var STUDIO_X_V2_SELF_RATES_ = {
    WEEKDAY: { base: { 1: 1200, 2: 2400, 3: 3600, 4: 4800 }, extensionPerHour: 1200 },
    WEEKEND_HOLIDAY: { base: { 1: 1500, 2: 3000, 3: 4500, 4: 6000 }, extensionPerHour: 1500 }
  };
  /* 現行一般料金。SNB V1/V2とStudio X V1のGENERALで共通（Issue #475でSNB V2の値上げを撤回）。 */
  var CURRENT_GENERAL_RATES_ = {
    WEEKDAY: { base: { 1: 2000, 2: 4000, 3: 6000, 4: 8000 }, extensionPerHour: 2000 },
    WEEKEND_HOLIDAY: { base: { 1: 2500, 2: 5000, 3: 7500, 4: 10000 }, extensionPerHour: 2500 }
  };

  /*
   * 1/2/3/4時間は基本料金の表引き、4時間を超えた分だけ1時間ごとにextensionPerHourを加算する。
   * 1時間料金は（Issue #410）延長+1時間料金と同額（GENERALの平日2,000円/土日祝2,500円）。
   * 1時間未満の入力はbillableHours_で1時間へ切り上げるため、この表に1時間未満のキーはない。
   * MEMBERの1時間料金はGENERALと同額（既存のMEMBER 2時間料金がGENERALと同額であることに
   * 合わせた。会員割引の適用条件＝3時間以上・延長は変更しない）。
   */
  var RATE_TABLES_ = {
    snb: {
      V1: {
        GENERAL: CURRENT_GENERAL_RATES_,
        MEMBER: MEMBER_RATES_
      },
      V2: {
        /* Issue #475: SNB一般料金の値上げは撤回し、V2もV1と同じ現行一般料金を維持する。 */
        GENERAL: CURRENT_GENERAL_RATES_,
        MEMBER: MEMBER_RATES_
      }
    },
    /* Studio XはV2で会員区分を廃止し、V2のGENERAL料金は会員・非会員共通のセルフ利用基本料金（Issue #486。
       #470の「現行MEMBER料金スライド」を上書き）。V1は2026/11/30までの新規予約と旧世代予約の日程変更見積りのためGENERAL/MEMBER双方を保持。 */
    studio_x: {
      V1: {
        GENERAL: CURRENT_GENERAL_RATES_,
        MEMBER: MEMBER_RATES_
      },
      V2: {
        GENERAL: STUDIO_X_V2_SELF_RATES_
      }
    }
  };

  /*
   * 価格優遇（MEMBER料金の適用）の判定。実際の会員資格とは別概念で、ここで決まるのは
   * 「どの料金表を使うか」だけ（会員資格の付与・確認ではない）。
   * - mens: 予約導線で自動判定し、会員加入の有無・isMember入力に関係なく常にMEMBER料金。
   * - snb: 予約フォームの自己申告（isMember）でGENERAL/MEMBER。未指定はGENERAL。
   * - studio_x: 会員料金の廃止は新料金世代（V2）から。V1（〜2026/11/30作成）は従来どおり
   *   自己申告（isMember）でGENERAL/MEMBER、V2は常にGENERAL。V2 GENERALの金額は
   *   会員・非会員共通のセルフ利用基本料金（Issue #486）。
   */
  function resolveTier_(brand, isMemberInput, generation) {
    if (brand === 'mens') return TIER.MEMBER;
    if (brand === 'studio_x' && generation === GENERATION.V2) return TIER.GENERAL;
    return isMemberInput === true ? TIER.MEMBER : TIER.GENERAL;
  }

  /* 予約作成時刻から料金世代を決める（施設timezone=JSTの2026/12/1 0:00が境界）。 */
  function generationAt(createdAt) {
    var ms = createdAt instanceof Date ? createdAt.getTime() : Number(createdAt);
    return Number.isFinite(ms) && ms >= GENERATION_V2_START_MS_ ? GENERATION.V2 : GENERATION.V1;
  }

  /* 保存済みの料金世代を正規化する。空・不正値は旧予約としてV1。 */
  function normalizeGeneration(value) {
    return value === GENERATION.V2 ? GENERATION.V2 : GENERATION.V1;
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
   * （1時間未満）を参照しないためだけに1時間へ切り上げる。
   */
  function billableHours_(durationMinutes) {
    var hours = Math.ceil(Number(durationMinutes) / 60);
    return hours < 1 ? 1 : hours;
  }

  /* mensはSNBの料金表（MEMBER）を使う。ブランドごとに表を分離している。 */
  function rateTableGroupOf_(brand) {
    return brand === 'studio_x' ? RATE_TABLES_.studio_x : RATE_TABLES_.snb;
  }

  function computePairPackAmount_(dayType, hours) {
    var extra = hours - PAIR_PACK_.baseHours;
    return PAIR_PACK_.base[dayType] + (extra > 0 ? extra * MEMBER_RATES_[dayType].extensionPerHour : 0);
  }

  /* プラン識別子の正規化。空・未指定は''（通常料金）。未知の値はnull（呼び出し側が拒否する。通常料金へ黙って倒さない）。 */
  function normalizePlan(value) {
    if (value === undefined || value === null || value === '') return '';
    return value === PLAN.MEMBER_PAIR_3H ? PLAN.MEMBER_PAIR_3H : null;
  }

  /* 利用人数（フォームの'1名'|'2名'|'3名'…）がペアパックの人数条件（1〜2名）か。数値以外・3名以上・5名以上はfalse。 */
  function isPairPackPeople(people) {
    var m = /^\s*([1-9]\d*)\s*名\s*$/.exec(String(people === undefined || people === null ? '' : people));
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= PAIR_PACK_.maxPeople;
  }

  function computeAmount_(brand, generation, tier, dayType, hours) {
    var table = rateTableGroupOf_(brand)[generation][tier][dayType];
    if (hours <= 4) return table.base[hours];
    return table.base[4] + (hours - 4) * table.extensionPerHour;
  }

  /*
   * input: { brand, date ('YYYY-MM-DD'), durationMinutes, isMember, generation }
   * generation: 料金世代（'V1'|'V2'。省略・不正値はV1）。新規予約は呼び出し側がgenerationAt(now)で渡し、
   * 既存予約の再見積りは保存済みの世代を渡す。
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

    var generation = normalizeGeneration(params.generation);
    var plan = normalizePlan(params.plan);
    if (plan === null) {
      return { valid: false, error: { code: 'INVALID_PLAN', message: 'プランの指定が正しくありません。' } };
    }
    if (plan === PLAN.MEMBER_PAIR_3H) {
      /* 独立プラン: 対象ブランド・料金世代（V2）・最低3時間を満たさなければ通常料金へ倒さず拒否する。 */
      if (PAIR_PACK_.brands.indexOf(brand) === -1 || generation !== GENERATION.V2) {
        return { valid: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
      }
      if (billableHours_(durationMinutes) < PAIR_PACK_.baseHours || Number(durationMinutes) < PAIR_PACK_.baseHours * 60) {
        return { valid: false, error: { code: 'PLAN_DURATION_INVALID', message: '2名ペアパックは3時間以上でご利用ください。' } };
      }
    }
    var tier = plan ? TIER.MEMBER : resolveTier_(brand, params.isMember === true, generation);
    var dayTypeResult = resolveDayType_(date);
    if (!dayTypeResult.ok) {
      return { valid: false, error: dayTypeResult.error };
    }
    var dayType = dayTypeResult.dayType;
    var hours = billableHours_(durationMinutes);
    var amount = plan === PLAN.MEMBER_PAIR_3H
      ? computePairPackAmount_(dayType, hours)
      : computeAmount_(brand, generation, tier, dayType, hours);

    return {
      valid: true,
      price: {
        amount: amount,
        currency: CURRENCY_,
        brand: brand,
        tier: tier,
        generation: generation,
        /* 独立プラン識別子（通常料金は''）。tierはプランでも'MEMBER'だが、料金は通常のMEMBER表ではなくプラン料金。 */
        plan: plan,
        /* 価格優遇（MEMBER料金）の適用有無であり、実会員資格ではない。
           mensではisMemberInputを無視して上書きした結果（実際に適用されたtier）を返す。
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
    GENERATION: GENERATION,
    PLAN: PLAN,
    PAIR_PACK_MAX_PEOPLE: PAIR_PACK_.maxPeople,
    PAIR_PACK_BASE_HOURS: PAIR_PACK_.baseHours,
    normalizePlan: normalizePlan,
    isPairPackPeople: isPairPackPeople,
    generationAt: generationAt,
    normalizeGeneration: normalizeGeneration,
    computeBookingPrice: computeBookingPrice
  };
})();
