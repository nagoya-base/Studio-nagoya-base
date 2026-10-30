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
 * - GENERAL: SNB本体（index.html）の「通常価格」表。Studio X V2では内部の互換キーであり、
 *   会員・非会員共通の基本料金を指す（一般／会員の料金区分は設けない。Issue #573）。
 * - MEMBER（会員）: SNB本体の「会員価格」表・SNB mens（mens/index.html）の掲載価格
 *   （mensページは常にこの表のみを掲載しており、通常価格表はページ上に存在しない）と一致。
 *
 * 会員区分（tier）の決定方針（Issue #342のユーザー確認、およびPR #343レビュー
 * （ブランド分離基準書v1.1）を反映。studio_xの扱いをPR #343レビューで修正）:
 * - studio_x（Issue #470 / #486 / #492）: 会員料金の廃止は2026/10/26以降に作成される予約（V2）から。V2は
 *   isMember入力を無視して常にGENERALとし、GENERAL料金そのものは会員・非会員共通のセルフ利用
 *   基本料金（平日1,200円/時・土日祝1,500円/時の単純時間比例。Issue #486）とする。V1（〜2026/10/25作成）は従来どおり自己申告（isMember）で
 *   GENERAL/MEMBERを使い分ける。
 * - 料金世代（Issue #470 / #492）: 予約作成時刻でV1/V2を決めて予約へ保存する。境界はブランド別で、
 *   Studio Xは2026/10/26 0:00 JST（Issue #492で前倒し）、SNB / mensは2026/12/1 0:00 JST。日程変更でも保存済みの世代で再見積りする（現行表で再計算しない）。
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
 * - Studio Xの下見プラン充当・
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
     V1=境界より前に作成された予約の旧料金、V2=境界以降に作成された予約の新料金。
     境界はブランド別（Issue #492）: Studio Xは2026/10/26 0:00 JST、SNB / mensは2026/12/1 0:00 JST。
     空・未知の値は旧予約（列追加前）とみなしV1へ倒す。 */
  var GENERATION = { V1: 'V1', V2: 'V2' };
  var GENERATION_V2_START_MS_ = Date.parse('2026-12-01T00:00:00+09:00');
  var STUDIO_X_GENERATION_V2_START_MS_ = Date.parse('2026-10-26T00:00:00+09:00');

  /*
   * Issue #478: 会員限定2名ペアパック。通常料金tier（GENERAL/MEMBER）の置換ではなく、独立したプランとして
   * 予約へプラン識別子（Bookings.planCode）を保存する。日程変更後も保持し、通常3時間料金へ化けない。
   * - 3時間（BASE_HOURS）が基本、1〜2名、平日5,000円／土日祝6,000円。延長は通常の会員延長料金（MEMBER_RATES_）。
   * - SNB / SNB mensのみ。Issue #539: 提供の可否は予約作成日（料金世代）ではなく**利用日が2026/12/1以降**かで決める
   *   （2026/11/30以前に作成した予約でも、利用日が12/1以降ならペアパックを選べる）。actual membershipが必須
   *   （資格の確認は予約作成・日程変更・確定の各サーバー側処理が行い、この純粋関数は料金だけを決める）。
   * - 他の割引・優待との併用は無い（このプランの料金はisMember・価格overrideの影響を受けない）。
   */
  var PLAN = { MEMBER_PAIR_3H: 'member_pair_3h', MENS_WEEKEND_SHOWER_4H: 'mens_weekend_shower_4h', OSU_COSPLAY_BASE_6H: 'osu_cosplay_base_6h', MENS_PHOTO_SUPPORT: 'mens_photo_support' };
  var PAIR_PACK_ = {
    brands: ['snb', 'mens'],
    baseHours: 3,
    maxPeople: 2,
    base: { WEEKDAY: 5000, WEEKEND_HOLIDAY: 6000 },
    /* Issue #539: 提供開始の利用日（JSTの暦日 'YYYY-MM-DD'。ゼロ埋め固定のため文字列比較で足りる）。 */
    startDate: '2026-12-01'
  };

  /*
   * Issue #586: SNB mens限定「土日祝4時間シャワーパック」。2名ペアパックと同じく通常料金tierの置換ではなく独立プランで、
   * 「mens・土日祝・4時間ちょうど・シャワー1回込み」の組み合わせにだけ適用する固定価格（金額はここが唯一の正本）。
   * - 通常のMEMBER料金（4時間土日祝9,000円）・シャワー単体（BookingOptions.gsのSHOWER_PRICE_JPY_）・ペアパックの料金は変更しない。
   *   シャワー分は6,500円に含まれ、この予約に紐づくシャワー注文は0円（二重加算しない。BookingOptions.planOrdersのshowerIncluded）。
   * - 提供開始はシャワーと同じく利用日が2026/12/1以降。actual membershipが必須（資格確認は予約作成・日程変更・確定の各サーバー側処理）。
   * - 利用人数は1〜2名まで（商品定義。人数はcomputeBookingPriceの入力ではないため、予約作成・見積り(POST)側で isShowerPackPeople により拒否する）。
   * - 平日・4時間以外・mens以外では成立しない（通常料金へ黙って倒さず拒否する）。
   */
  var SHOWER_PACK_ = {
    brands: ['mens'],
    hours: 4,
    maxPeople: 2,
    price: 6500,
    startDate: '2026-12-01',
    label: 'SNB mens 土日祝4時間シャワーパック'
  };

  /*
   * Issue #488 / #492: 貸切ベースプラン（Studio Xのみ・常設）。通常の時間貸し料金表
   * （RATE_TABLES_）には一切手を入れず、独立プランとしてここに固定額を持つ。
   * - Issue #510: 可変時間制。8:00〜21:00の範囲で最低6時間・1時間1,000円/1室（6時間=6,000円、7時間=7,000円…）。
   *   利用時間は予約時に確定し、利用開始後の途中延長は無い。終了が21:00を超える組み合わせ・6時間未満・1時間単位でない時間は拒否する。
   * - 会員区分・料金世代・曜日区分の影響を受けない（isMemberも無視。会員特典ではない）。
   * - Issue #492で対象イベント日の制限（EventPlanDates）を廃止した。利用者が明示的にプランを選んだときだけ
   *   適用し、通常予約へ自動適用しない。Studio Xの予約可能日であればいつでも選べる。
   *   識別子osu_cosplay_base_6hは既存予約・台帳との互換性のため維持する。
   */
  /*
   * Issue #667: SNB mens限定「作品撮りサポートプラン」。通常のMEMBER料金の値下げではなく、スタッフ対応（事前設営／片付け）を
   * 実際に利用することを条件に、部屋料金をStudio Xの現行直接予約セルフ料金（STUDIO_X_V2_SELF_RATES_と同額）にする独立プラン
   * （金額・条件はここが唯一の正本。通常料金表・ペアパック・シャワーパックには手を入れない）。
   * - 対象: mens・SNB MEMBER（予約代表者本人の実会員資格。確認は予約作成・確定の各サーバー側処理）・1〜4名。緊縛の有無は料金条件にしない。
   * - 料金: 部屋料金（平日1,200円/h・土日祝1,500円/hの単純時間比例）＋スタッフ対応料金
   *   （事前設営3,000円／片付け3,000円／事前設営＋片付け5,000円。いずれか必須。スタッフ対応なしでは成立しない）。
   * - 申込は利用日の7日前まで（applyDaysBefore）。承認前は決済できず、承認後の支払い期限は24時間（paymentDueHours）。
   * - 提供開始（効力発生）は**利用日**が startDate 以降（ペアパック・シャワーパックと同じ利用日基準。#539）。予約作成日では判定しない。
   *   30日前告知が済んでいることが前提で、告知日から30日以上あとの日に startDate を置くこと（この1箇所を変えれば全入口が追随する）。
   * - 有料機材は共通機材カタログの別注文（本プランの金額には含めない）。
   */
  var PHOTO_SUPPORT_ = {
    brands: ['mens'],
    maxPeople: 4,
    applyDaysBefore: 7,
    paymentDueHours: 24,
    startDate: '2026-12-01',
    hourlyRate: { WEEKDAY: 1200, WEEKEND_HOLIDAY: 1500 },
    staffFee: { SETUP: 3000, CLEANUP: 3000, BOTH: 5000 },
    staffLabel: { SETUP: '事前設営', CLEANUP: '片付け', BOTH: '事前設営＋片付け' },
    label: 'SNB mens 作品撮りサポートプラン'
  };

  var EVENT_BASE_PLAN_ = {
    brands: ['studio_x'],
    minHours: 6,
    hourlyRate: 1000,
    openMinutes: 8 * 60,
    closeMinutes: 21 * 60,
    maxPeople: 6, // Issue #513 / #570: 6名まで同一料金（人数課金なし）
    label: 'Studio X｜6時間貸切ベースプラン'
  };

  /*
   * Issue #668: SNB mens通常料金の大人数利用（5〜7名）。専用パックではなく、通常のmens時間貸し料金に
   * 「5人目以降、1名につき＋1,000円／予約」を**予約全体で1回だけ**加算する（利用時間ごとには加算しない）。
   * - mensのみ。SNB一般・Studio Xの人数・料金・予約UIは変えない（computeBookingPriceはmens以外ではpeopleを無視する）。
   * - 上限は7名（8名以上は料金計算を含めて受け付けない。上限の拡張は別Issueで再検討する）。
   * - 5〜7名は予約代表者のSNB MEMBER資格と運営の事前承認が必要（資格・承認の確認は予約作成・承認の各サーバー側処理。
   *   この純粋関数は料金だけを決める）。承認できない場合に4名扱いへ自動変換・自動課金することはしない。
   * - 提供開始は利用日が2026/12/1以降（告知日2026/10/30から30日以上。ペアパック・シャワーパックと同じ基準日）。
   *   効力発生前の利用日では5〜7名を選択・適用できない。既存予約は再計算しない。
   * - 独立プラン（ペアパック・シャワーパック・今後の作品撮りサポートプラン）とは併用しない。
   */
  var LARGE_PARTY_ = {
    brands: ['mens'],
    includedPeople: 4,
    minPeople: 5,
    maxPeople: 7,
    surchargePerPerson: 1000,
    startDate: '2026-12-01',
    label: 'SNB mens 大人数利用（5〜7名）'
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
    /* Studio XはV2で基本利用料金の会員区分のみ廃止。SNB共通の会員制度・資格は継続（Issue #573）。
       V2のGENERALは内部の互換キーで、会員・非会員共通のセルフ利用基本料金（Issue #486。
       #470の「現行MEMBER料金スライド」を上書き）。V1は2026/10/25までに作成された旧世代予約の日程変更見積りのためGENERAL/MEMBER双方を保持。 */
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
   * - studio_x: 会員料金の廃止は新料金世代（V2）から。V1（〜2026/10/25作成）は従来どおり
   *   自己申告（isMember）でGENERAL/MEMBER、V2は常にGENERAL。V2 GENERALの金額は
   *   会員・非会員共通のセルフ利用基本料金（Issue #486）。
   */
  function resolveTier_(brand, isMemberInput, generation) {
    if (brand === 'mens') return TIER.MEMBER;
    if (brand === 'studio_x' && generation === GENERATION.V2) return TIER.GENERAL;
    return isMemberInput === true ? TIER.MEMBER : TIER.GENERAL;
  }

  /* 予約作成時刻とブランドから料金世代を決める（施設timezone=JST。境界はStudio X=2026/10/26 0:00、SNB / mens=2026/12/1 0:00）。 */
  function generationAt(createdAt, brand) {
    var ms = createdAt instanceof Date ? createdAt.getTime() : Number(createdAt);
    var startMs = brand === 'studio_x' ? STUDIO_X_GENERATION_V2_START_MS_ : GENERATION_V2_START_MS_;
    return Number.isFinite(ms) && ms >= startMs ? GENERATION.V2 : GENERATION.V1;
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

  /* Issue #539: ペアパックを提供する利用日か（利用日 >= 2026/12/1）。形式不正はfalse（fail-closed）。 */
  function isPairPackAvailableOnDate(dateString) {
    return isValidDateString_(dateString) && dateString >= PAIR_PACK_.startDate;
  }

  /* Issue #586: シャワーパックを提供する利用日か（利用日 >= 2026/12/1。シャワー・ペアパックと同じ基準）。 */
  function isShowerPackAvailableOnDate(dateString) {
    return isValidDateString_(dateString) && dateString >= SHOWER_PACK_.startDate;
  }

  /* Issue #586: シャワーパックの人数条件（1〜2名。ペアパックと同じ判定）。数値以外・3名以上はfalse。 */
  function isShowerPackPeople(people) {
    var m = /^\s*([1-9]\d*)\s*名\s*$/.exec(String(people === undefined || people === null ? '' : people));
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= SHOWER_PACK_.maxPeople;
  }

  /* Issue #586: 会員限定の独立プラン（ペアパック・シャワーパック）か。実会員資格の確認・日程変更時の再確認の対象。 */
  function isMemberPlan(plan) {
    return plan === PLAN.MEMBER_PAIR_3H || plan === PLAN.MENS_WEEKEND_SHOWER_4H || plan === PLAN.MENS_PHOTO_SUPPORT;
  }

  /* Issue #667: 作品撮りサポートプランか（承認制・承認後24時間決済・スタッフ対応必須・1〜4名の対象）。 */
  function isPhotoSupport(plan) {
    return plan === PLAN.MENS_PHOTO_SUPPORT;
  }

  /* Issue #667: 提供する利用日か（利用日 >= 効力発生日。ペアパック・シャワーパックと同じ利用日基準）。形式不正はfalse（fail-closed）。 */
  function isPhotoSupportAvailableOnDate(dateString) {
    return isValidDateString_(dateString) && dateString >= PHOTO_SUPPORT_.startDate;
  }

  /* Issue #667: 1〜4名限定。5名以上・数値以外はfalse。 */
  function isPhotoSupportPeople(people) {
    var m = /^\s*([1-9]\d*)\s*名\s*$/.exec(String(people === undefined || people === null ? '' : people));
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= PHOTO_SUPPORT_.maxPeople;
  }

  /* スタッフ対応の種別（'SETUP'|'CLEANUP'|'BOTH'）の正規化。空・未知の値はnull（スタッフ対応なしでは成立しないため呼び出し側が拒否する）。 */
  function normalizeSupportServices(value) {
    return value === 'SETUP' || value === 'CLEANUP' || value === 'BOTH' ? value : null;
  }

  function photoSupportServicesLabel(services) {
    return PHOTO_SUPPORT_.staffLabel[services] || '';
  }

  /*
   * Issue #667: 申込期限（利用日の7日前まで）。todayString・dateStringはどちらも施設timezone基準の'YYYY-MM-DD'。
   * 利用日 - 今日 >= 7日 のときだけ申込できる。形式不正はfail-closed（期限超過扱い）。
   */
  function isPhotoSupportApplyOpen(dateString, todayString) {
    if (!isValidDateString_(dateString) || !isValidDateString_(todayString)) return false;
    var d = dateString.split('-');
    var t = todayString.split('-');
    var days = Math.round((Date.UTC(Number(d[0]), Number(d[1]) - 1, Number(d[2])) - Date.UTC(Number(t[0]), Number(t[1]) - 1, Number(t[2]))) / 86400000);
    return days >= PHOTO_SUPPORT_.applyDaysBefore;
  }

  /* Issue #586: シャワーパックか（シャワー料金を部屋料金に含める＝シャワー注文を0円にする対象）。 */
  function isShowerPack(plan) {
    return plan === PLAN.MENS_WEEKEND_SHOWER_4H;
  }

  function computePairPackAmount_(dayType, hours) {
    var extra = hours - PAIR_PACK_.baseHours;
    return PAIR_PACK_.base[dayType] + (extra > 0 ? extra * MEMBER_RATES_[dayType].extensionPerHour : 0);
  }

  /* プラン識別子の正規化。空・未指定は''（通常料金）。未知の値はnull（呼び出し側が拒否する。通常料金へ黙って倒さない）。 */
  function normalizePlan(value) {
    if (value === undefined || value === null || value === '') return '';
    if (value === PLAN.MEMBER_PAIR_3H) return PLAN.MEMBER_PAIR_3H;
    if (value === PLAN.MENS_WEEKEND_SHOWER_4H) return PLAN.MENS_WEEKEND_SHOWER_4H;
    if (value === PLAN.OSU_COSPLAY_BASE_6H) return PLAN.OSU_COSPLAY_BASE_6H;
    if (value === PLAN.MENS_PHOTO_SUPPORT) return PLAN.MENS_PHOTO_SUPPORT;
    return null;
  }

  /* 利用人数（'1名'〜）が貸切ベースプランの人数条件（1〜6名）か。11名以上・要相談・数値以外はfalse。 */
  function isEventBasePlanPeople(people) {
    var m = /^\s*([1-9]\d*)\s*名\s*$/.exec(String(people === undefined || people === null ? '' : people));
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= EVENT_BASE_PLAN_.maxPeople;
  }

  /*
   * Issue #510: 貸切ベースプランの利用時間・時間帯の検証。durationMinutesは最低6時間かつ1時間単位。
   * startTime（'HH:mm'）が与えられたときは、開始が8:00以降・終了が21:00以内であることも確認する
   * （料金見積りなど開始時刻を持たない呼び出しでは時間帯の確認を省き、予約作成・日程変更では必ず渡す）。
   * 問題なければnull、違反ならエラー{code, message}を返す。
   */
  function eventPlanScheduleError(durationMinutes, startTime) {
    var minutes = Number(durationMinutes);
    var label = EVENT_BASE_PLAN_.label;
    if (!Number.isFinite(minutes) || minutes < EVENT_BASE_PLAN_.minHours * 60 || minutes % 60 !== 0) {
      return { code: 'PLAN_DURATION_INVALID', message: label + 'は最低' + EVENT_BASE_PLAN_.minHours + '時間から、1時間単位でご利用ください。' };
    }
    if (startTime !== undefined && startTime !== null && startTime !== '') {
      var m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(startTime));
      if (!m) return { code: 'INVALID_TIME', message: '開始時刻の形式が正しくありません（HH:mm）。' };
      var start = Number(m[1]) * 60 + Number(m[2]);
      if (start < EVENT_BASE_PLAN_.openMinutes || start + minutes > EVENT_BASE_PLAN_.closeMinutes) {
        return { code: 'PLAN_HOURS_OUT_OF_RANGE', message: label + 'は8:00〜21:00の範囲内でご利用ください（終了が21:00を超える時間は選べません）。' };
      }
    }
    return null;
  }

  /* 管理画面・メール・料金サマリーに出すプラン名（通常料金・未知の値は''）。 */
  function planLabel(plan) {
    if (plan === PLAN.OSU_COSPLAY_BASE_6H) return EVENT_BASE_PLAN_.label;
    if (plan === PLAN.MENS_WEEKEND_SHOWER_4H) return SHOWER_PACK_.label;
    if (plan === PLAN.MENS_PHOTO_SUPPORT) return PHOTO_SUPPORT_.label;
    return '';
  }

  /* 貸切ベースプラン（独立プラン）か（人数上限・6時間固定・二重販売防止の対象）。 */
  function isEventPlan(plan) {
    return plan === PLAN.OSU_COSPLAY_BASE_6H;
  }

  /* Issue #496: 貸切ベースプランと追加オプションの併用不可。optionsに何らかの選択（空でないオブジェクト等）が
     含まれるか。未指定・null・空オブジェクト・空配列は「指定なし」。形式が不正な値は指定ありとして扱う（fail-closed）。 */
  function hasOptionSelection(options) {
    if (options === undefined || options === null || options === '') return false;
    if (typeof options !== 'object') return true;
    return Object.keys(options).length > 0;
  }

  function eventPlanOptionsError() {
    return { code: 'EVENT_PLAN_OPTIONS_NOT_ALLOWED', message: EVENT_BASE_PLAN_.label + 'では追加オプションをご利用いただけません。' };
  }

  /* 利用人数（フォームの'1名'|'2名'|'3名'…）がペアパックの人数条件（1〜2名）か。数値以外・3名以上・5名以上はfalse。 */
  function isPairPackPeople(people) {
    var m = /^\s*([1-9]\d*)\s*名\s*$/.exec(String(people === undefined || people === null ? '' : people));
    return !!m && Number(m[1]) >= 1 && Number(m[1]) <= PAIR_PACK_.maxPeople;
  }

  /* Issue #668: 利用人数（フォームの'1名'|'2名'…）を整数にする。数値以外（'5名以上・要相談'等）・0・全角は null。 */
  function parseHeadcount(people) {
    var m = /^\s*([1-9]\d{0,2})\s*名\s*$/.exec(String(people === undefined || people === null ? '' : people));
    return m ? Number(m[1]) : null;
  }

  /* Issue #668: mens通常予約で受け付ける人数か（1〜7名）。8名以上・数値以外はfalse。 */
  function isMensPartySizeAllowed(people) {
    var n = parseHeadcount(people);
    return n !== null && n >= 1 && n <= LARGE_PARTY_.maxPeople;
  }

  /* Issue #668: 大人数利用（5〜7名）か。ブランドは見ない（呼び出し側がmensだけに適用する）。 */
  function isLargePartyPeople(people) {
    var n = parseHeadcount(people);
    return n !== null && n >= LARGE_PARTY_.minPeople && n <= LARGE_PARTY_.maxPeople;
  }

  /* Issue #668: 大人数利用を提供する利用日か（利用日 >= 2026/12/1）。形式不正はfalse（fail-closed）。 */
  function isLargePartyAvailableOnDate(dateString) {
    return isValidDateString_(dateString) && dateString >= LARGE_PARTY_.startDate;
  }

  /* Issue #668: 人数加算額（予約1件につき1回）。4名以下・数値以外は0。5名=1,000 / 6名=2,000 / 7名=3,000。 */
  function largePartySurcharge(people) {
    return isLargePartyPeople(people) ? (parseHeadcount(people) - LARGE_PARTY_.includedPeople) * LARGE_PARTY_.surchargePerPerson : 0;
  }

  function computeAmount_(brand, generation, tier, dayType, hours) {
    var table = rateTableGroupOf_(brand)[generation][tier][dayType];
    if (hours <= 4) return table.base[hours];
    return table.base[4] + (hours - 4) * table.extensionPerHour;
  }

  /*
   * input: { brand, date ('YYYY-MM-DD'), durationMinutes, isMember, generation, plan, startTime（任意。貸切ベースプランの時間帯検証用）,
   *          people（任意。'5名'等。mensのときだけ見て、5〜7名なら人数加算を足す。Issue #668） }
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
      /* 独立プラン: 対象ブランド・利用日（2026/12/1以降。Issue #539）・最低3時間を満たさなければ通常料金へ倒さず拒否する。
         料金世代は問わない（会員料金表はV1/V2で同額で、ペアパックは独立した固定料金）。 */
      if (PAIR_PACK_.brands.indexOf(brand) === -1 || !isPairPackAvailableOnDate(date)) {
        return { valid: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
      }
      if (billableHours_(durationMinutes) < PAIR_PACK_.baseHours || Number(durationMinutes) < PAIR_PACK_.baseHours * 60) {
        return { valid: false, error: { code: 'PLAN_DURATION_INVALID', message: '2名ペアパックは3時間以上でご利用ください。' } };
      }
    }
    if (plan === PLAN.MENS_WEEKEND_SHOWER_4H) {
      /* Issue #586: 独立プラン。対象ブランド（mensのみ）・利用日（2026/12/1以降）・4時間ちょうどを満たさなければ通常料金へ倒さず拒否する。
         土日祝かどうかは曜日区分の判定後に確認する。 */
      if (SHOWER_PACK_.brands.indexOf(brand) === -1 || !isShowerPackAvailableOnDate(date)) {
        return { valid: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
      }
      if (Number(durationMinutes) !== SHOWER_PACK_.hours * 60) {
        return { valid: false, error: { code: 'PLAN_DURATION_INVALID', message: SHOWER_PACK_.label + 'は4時間でご利用ください。' } };
      }
    }
    var supportServices = null;
    var supportEquipment = { empty: true, lines: [], items: [], totalJpy: 0 };
    if (plan === PLAN.MENS_PHOTO_SUPPORT) {
      /* Issue #667: 独立プラン。対象ブランド（mensのみ）・利用日（効力発生日以降）・スタッフ対応の種別（いずれか必須）を満たさなければ
         通常料金へ倒さず拒否する。1〜4名・申込期限（7日前）・会員資格は人数・現在時刻・台帳を扱う呼び出し側（予約作成・見積りPOST）が判定する。 */
      if (PHOTO_SUPPORT_.brands.indexOf(brand) === -1 || !isPhotoSupportAvailableOnDate(date)) {
        return { valid: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
      }
      supportServices = normalizeSupportServices(params.supportServices);
      if (supportServices === null) {
        return { valid: false, error: { code: 'PHOTO_SUPPORT_SERVICE_REQUIRED', message: PHOTO_SUPPORT_.label + 'では、スタッフ対応（事前設営／片付け／事前設営＋片付け）を1つ選択してください。' } };
      }
      /* 有料機材（任意）。共通機材カタログ（BookingOptions.gs）を正本に、単価・在庫・セット無料条件を再利用する（複製しない）。 */
      if (params.supportEquipment !== undefined && params.supportEquipment !== null && params.supportEquipment !== '') {
        if (typeof BookingOptions === 'undefined') {
          return { valid: false, error: { code: 'INVALID_OPTIONS', message: '有料機材の料金を計算できません。' } };
        }
        supportEquipment = BookingOptions.computeSupportEquipment(params.supportEquipment);
        if (!supportEquipment.ok) return { valid: false, error: supportEquipment.error };
      }
    }
    if (plan === PLAN.OSU_COSPLAY_BASE_6H) {
      /* Issue #488 / #492 / #510: 独立プラン。ブランド・利用時間（最低6時間・1時間単位。startTimeがあれば8:00〜21:00の範囲）を満たさなければ通常料金へ倒さず拒否する（対象日の制限は無い）。 */
      if (EVENT_BASE_PLAN_.brands.indexOf(brand) === -1) {
        return { valid: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
      }
      var scheduleError = eventPlanScheduleError(durationMinutes, params.startTime);
      if (scheduleError) return { valid: false, error: scheduleError };
    }
    /* Issue #668: mensの大人数利用。8名以上・独立プランとの併用・提供開始前の利用日は、通常料金へ倒さず拒否する。 */
    var largeParty = false;
    var partySurcharge = 0;
    if (LARGE_PARTY_.brands.indexOf(brand) !== -1 && params.people !== undefined && params.people !== null && params.people !== '') {
      var headcount = parseHeadcount(params.people);
      if (headcount !== null && headcount > LARGE_PARTY_.maxPeople) {
        return { valid: false, error: { code: 'PARTY_SIZE_EXCEEDED', message: 'SNB mensのご利用は' + LARGE_PARTY_.maxPeople + '名までです。' } };
      }
      if (isLargePartyPeople(params.people)) {
        if (!isLargePartyAvailableOnDate(date)) {
          return { valid: false, error: { code: 'LARGE_PARTY_NOT_AVAILABLE', message: '5〜7名でのご利用は2026年12月1日以降のご利用日からお申し込みいただけます。' } };
        }
        if (plan) {
          return { valid: false, error: { code: 'LARGE_PARTY_PLAN_NOT_COMBINABLE', message: '5〜7名のご利用は、他のプランとは併用できません。' } };
        }
        largeParty = true;
        partySurcharge = largePartySurcharge(params.people);
      }
    }
    var tier = isMemberPlan(plan)
      ? TIER.MEMBER
      : (plan ? TIER.GENERAL : resolveTier_(brand, params.isMember === true, generation));
    var dayTypeResult = resolveDayType_(date);
    if (!dayTypeResult.ok) {
      return { valid: false, error: dayTypeResult.error };
    }
    var dayType = dayTypeResult.dayType;
    if (plan === PLAN.MENS_WEEKEND_SHOWER_4H && dayType !== DAY_TYPE.WEEKEND_HOLIDAY) {
      return { valid: false, error: { code: 'PLAN_DAY_INVALID', message: SHOWER_PACK_.label + 'は土日祝のみご利用いただけます。' } };
    }
    var hours = billableHours_(durationMinutes);
    var amount;
    var roomAmount = null;
    var staffAmount = null;
    if (plan === PLAN.MENS_PHOTO_SUPPORT) {
      roomAmount = hours * PHOTO_SUPPORT_.hourlyRate[dayType];
      staffAmount = PHOTO_SUPPORT_.staffFee[supportServices];
      amount = roomAmount + staffAmount + supportEquipment.totalJpy;
    } else if (plan === PLAN.MEMBER_PAIR_3H) amount = computePairPackAmount_(dayType, hours);
    else if (plan === PLAN.MENS_WEEKEND_SHOWER_4H) amount = SHOWER_PACK_.price;
    else if (plan === PLAN.OSU_COSPLAY_BASE_6H) amount = hours * EVENT_BASE_PLAN_.hourlyRate;
    else amount = computeAmount_(brand, generation, tier, dayType, hours);
    var baseAmount = amount;
    amount += partySurcharge;

    var result = {
      valid: true,
      price: {
        amount: amount,
        /* Issue #668: 通常部屋料金（人数加算を含まない）と人数加算額。メール・管理画面は基本料金と人数加算を区別して出す。 */
        baseAmount: baseAmount,
        partySurcharge: partySurcharge,
        largeParty: largeParty,
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
    if (plan === PLAN.MENS_PHOTO_SUPPORT) {
      /* Issue #667: 金額内訳（部屋料金＋スタッフ対応料金）。amountは両者の合計で、予約・決済・メール・管理画面はこの内訳を共有する。 */
      result.price.supportServices = supportServices;
      result.price.roomAmount = roomAmount;
      result.price.staffAmount = staffAmount;
      /* 有料機材料金（共通カタログ）。amountは部屋料金＋スタッフ対応料金＋有料機材料金の合計（1回の承認・1回のお支払い）。 */
      result.price.equipmentAmount = supportEquipment.totalJpy;
      result.price.equipmentLines = supportEquipment.lines;
      result.price.equipmentItems = supportEquipment.items;
    }
    return result;
  }

  return {
    TIER: TIER,
    DAY_TYPE: DAY_TYPE,
    CURRENCY: CURRENCY_,
    GENERATION: GENERATION,
    PLAN: PLAN,
    PAIR_PACK_MAX_PEOPLE: PAIR_PACK_.maxPeople,
    PAIR_PACK_BASE_HOURS: PAIR_PACK_.baseHours,
    SHOWER_PACK_PRICE: SHOWER_PACK_.price,
    SHOWER_PACK_HOURS: SHOWER_PACK_.hours,
    SHOWER_PACK_MAX_PEOPLE: SHOWER_PACK_.maxPeople,
    isShowerPackPeople: isShowerPackPeople,
    SHOWER_PACK_START_DATE: SHOWER_PACK_.startDate,
    SHOWER_PACK_LABEL: SHOWER_PACK_.label,
    isShowerPack: isShowerPack,
    isMemberPlan: isMemberPlan,
    PHOTO_SUPPORT_MAX_PEOPLE: PHOTO_SUPPORT_.maxPeople,
    PHOTO_SUPPORT_APPLY_DAYS_BEFORE: PHOTO_SUPPORT_.applyDaysBefore,
    PHOTO_SUPPORT_PAYMENT_DUE_HOURS: PHOTO_SUPPORT_.paymentDueHours,
    PHOTO_SUPPORT_START_DATE: PHOTO_SUPPORT_.startDate,
    PHOTO_SUPPORT_LABEL: PHOTO_SUPPORT_.label,
    PHOTO_SUPPORT_HOURLY_RATE: PHOTO_SUPPORT_.hourlyRate,
    PHOTO_SUPPORT_STAFF_FEE: PHOTO_SUPPORT_.staffFee,
    isPhotoSupport: isPhotoSupport,
    isPhotoSupportAvailableOnDate: isPhotoSupportAvailableOnDate,
    isPhotoSupportPeople: isPhotoSupportPeople,
    isPhotoSupportApplyOpen: isPhotoSupportApplyOpen,
    normalizeSupportServices: normalizeSupportServices,
    photoSupportServicesLabel: photoSupportServicesLabel,
    isShowerPackAvailableOnDate: isShowerPackAvailableOnDate,
    EVENT_BASE_PLAN_MAX_PEOPLE: EVENT_BASE_PLAN_.maxPeople,
    EVENT_BASE_PLAN_MIN_HOURS: EVENT_BASE_PLAN_.minHours,
    EVENT_BASE_PLAN_HOURLY_RATE: EVENT_BASE_PLAN_.hourlyRate,
    eventPlanScheduleError: eventPlanScheduleError,
    EVENT_BASE_PLAN_LABEL: EVENT_BASE_PLAN_.label,
    normalizePlan: normalizePlan,
    isEventPlan: isEventPlan,
    isEventBasePlanPeople: isEventBasePlanPeople,
    hasOptionSelection: hasOptionSelection,
    eventPlanOptionsError: eventPlanOptionsError,
    planLabel: planLabel,
    isPairPackPeople: isPairPackPeople,
    LARGE_PARTY_MAX_PEOPLE: LARGE_PARTY_.maxPeople,
    LARGE_PARTY_MIN_PEOPLE: LARGE_PARTY_.minPeople,
    LARGE_PARTY_SURCHARGE_PER_PERSON: LARGE_PARTY_.surchargePerPerson,
    LARGE_PARTY_START_DATE: LARGE_PARTY_.startDate,
    LARGE_PARTY_LABEL: LARGE_PARTY_.label,
    parseHeadcount: parseHeadcount,
    isMensPartySizeAllowed: isMensPartySizeAllowed,
    isLargePartyPeople: isLargePartyPeople,
    isLargePartyAvailableOnDate: isLargePartyAvailableOnDate,
    largePartySurcharge: largePartySurcharge,
    isPairPackAvailableOnDate: isPairPackAvailableOnDate,
    PAIR_PACK_START_DATE: PAIR_PACK_.startDate,
    generationAt: generationAt,
    /* Issue #559: SNB / mensの料金世代V2境界（2026/12/1 0:00 JST）。TESTモードの終了期限も同じ値に固定する（Script Propertiesでは延長できない）。 */
    GENERATION_V2_START_MS: GENERATION_V2_START_MS_,
    normalizeGeneration: normalizeGeneration,
    computeBookingPrice: computeBookingPrice
  };
})();
