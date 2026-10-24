/*
 * BookingOptions.gs — 予約オプション（Issue #423）の純粋ロジック。GAS組み込みサービスに
 * 一切依存せず、node --testからvmでそのまま検証できる（BookingPricing.gs等と同方針）。
 *
 * 【Issue #423の確定要件（本文＋追加コメント3件。コメントを本文より優先）】
 * - 初期リリースはStudio X（studio_x）のみ。SNB / mensの予約フォーム・料金・決済・メール・
 *   Adminの挙動は変えない（ENABLED_BRANDS_）。
 * - 有料スタッフ対応（管理者承認制・承認後にStripe Checkout）:
 *     事前設営 3,000円 / 片付け 3,000円 / 事前設営＋片付けセット 5,000円
 *   教室・和風・グランジ・白背景布・黒背景布で共通料金（テーマ別の追加料金は持たない）。
 *   両方選択時は6,000円ではなくセット価格を適用する。料金はSTAFF_SERVICE_PRICES_の1箇所のみ。
 * - 無料セルフ対応: セルフ設営・セルフ片付け（原状復帰）・メールサポート。管理者承認不要・
 *   課金なし。選択時は対象テーマごとの定型案内（GUIDANCE_TEMPLATES_）を案内メールへ付加する。
 * - 有料機材: 個別レンタル機材を1点ごとに数量×単価で加算（セット料金ではない）。管理者承認不要。
 *   料金・数量・在庫は機材ページ(studio-x/equipment/)と同じ正本 _data/studio_x_equipment.json
 *   から生成した EquipmentCatalog.gs（StudioXEquipmentCatalog）だけを参照する。画面・GAS・
 *   機材ページに金額を重複して持たない。在庫数を超える選択は拒否する。背景布・背景スタンドの
 *   セルフ利用は0円。有料機材は部屋予約確定後の追加Checkout方式（Issue追加要件で正式採用）。
 * - ビデオライト系（定常光）のセルフレンタルは「過去に当該ビデオライトを借りたことがある利用者」
 *   のみ。自動判定できない既存利用者は管理者の許可（OptionEligibility）で補う。初回利用者は
 *   拒否する（誤って即時Checkoutへ進ませない）。ストロボ等へ追加の資格制限は設けない。
 *
 * 【状態の分離】予約（Bookings.status）とオプション注文（OptionOrders）は別の状態を持つ。
 * 注文ごとに approvalStatus / paymentStatus / status を持ち、セッティングのDECLINEDで
 * 部屋予約を変更しない。未承認のスタッフ対応を確定扱い・課金扱いにしない。
 *
 * 【注文（OptionOrder）の単位】決済・承認の単位。1回の申込から最大3件に分かれる:
 *   FREE（無料。承認・決済なし。即CONFIRMED） / EQUIPMENT（有料機材。承認不要・決済待ち）
 *   / STAFF_SERVICE（スタッフ対応。PENDING_APPROVAL開始）。
 */
'use strict';

var BookingOptions = (function () {
  var ENABLED_BRANDS_ = ['studio_x'];
  var CURRENCY_ = 'JPY';
  var ORDER_TYPE_ADDON = 'addon';

  var CATEGORY = { FREE: 'FREE', EQUIPMENT: 'EQUIPMENT', STAFF_SERVICE: 'STAFF_SERVICE' };

  /* 'WITH_BOOKING'=部屋予約と同時申込 / 'ADDON'=既存予約への後付け。 */
  var SOURCE = { WITH_BOOKING: 'WITH_BOOKING', ADDON: 'ADDON' };

  var APPROVAL_STATUS = {
    NOT_REQUIRED: 'NOT_REQUIRED',
    PENDING_APPROVAL: 'PENDING_APPROVAL',
    APPROVED: 'APPROVED',
    DECLINED: 'DECLINED'
  };

  var PAYMENT_STATUS = {
    NOT_REQUIRED: 'NOT_REQUIRED',
    NOT_STARTED: 'NOT_STARTED',
    CHECKOUT_PENDING: 'CHECKOUT_PENDING',
    PAID: 'PAID',
    FAILED: 'FAILED'
  };

  /* PENDING_APPROVAL → AWAITING_PAYMENT（承認済み・未払い）→ PAYMENT_PENDING（Checkout発行済み）
     → CONFIRMED。DECLINED / CANCELLEDは終端。AWAITING_PAYMENTはIssue本文の APPROVED に相当
     （承認の事実はapprovalStatus=APPROVEDで別に持つ。機材は承認不要のためここから始まる）。 */
  var STATUS = {
    PENDING_APPROVAL: 'PENDING_APPROVAL',
    AWAITING_PAYMENT: 'AWAITING_PAYMENT',
    PAYMENT_PENDING: 'PAYMENT_PENDING',
    CONFIRMED: 'CONFIRMED',
    DECLINED: 'DECLINED',
    CANCELLED: 'CANCELLED'
  };

  var ACTIVE_STATUSES_ = [STATUS.PENDING_APPROVAL, STATUS.AWAITING_PAYMENT, STATUS.PAYMENT_PENDING, STATUS.CONFIRMED];

  var ALLOWED_TRANSITIONS_ = {};
  ALLOWED_TRANSITIONS_[STATUS.PENDING_APPROVAL] = [STATUS.AWAITING_PAYMENT, STATUS.DECLINED, STATUS.CANCELLED];
  ALLOWED_TRANSITIONS_[STATUS.AWAITING_PAYMENT] = [STATUS.PAYMENT_PENDING, STATUS.CONFIRMED, STATUS.CANCELLED];
  /* PAYMENT_PENDING→AWAITING_PAYMENT: 決済失敗・Checkout失効後に再試行できる状態へ戻す。 */
  ALLOWED_TRANSITIONS_[STATUS.PAYMENT_PENDING] = [STATUS.CONFIRMED, STATUS.AWAITING_PAYMENT, STATUS.CANCELLED];
  ALLOWED_TRANSITIONS_[STATUS.CONFIRMED] = [];
  ALLOWED_TRANSITIONS_[STATUS.DECLINED] = [];
  ALLOWED_TRANSITIONS_[STATUS.CANCELLED] = [];

  function canTransition(fromStatus, toStatus) {
    var targets = ALLOWED_TRANSITIONS_[fromStatus];
    return !!targets && targets.indexOf(toStatus) !== -1;
  }

  function isActiveStatus(status) {
    return ACTIVE_STATUSES_.indexOf(status) !== -1;
  }

  /* ---- カタログ ---- */

  /* ---- 機材カタログ（EquipmentCatalog.gs。唯一の正本は _data/studio_x_equipment.json） ---- */

  function equipmentRental_(code) {
    var list = StudioXEquipmentCatalog.rental;
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
    return null;
  }

  function equipmentFreeSelf_(code) {
    var list = StudioXEquipmentCatalog.freeSelf;
    for (var i = 0; i < list.length; i++) if (list[i].code === code && list[i].selectable === true) return list[i];
    return null;
  }

  /* 予約の機材項目コード: 'EQ:<機材コード>:<数量>'。 */
  var EQUIPMENT_ITEM_PREFIX = 'EQ:';

  function equipmentItemCode_(code, quantity) {
    return EQUIPMENT_ITEM_PREFIX + code + ':' + quantity;
  }

  function parseEquipmentItem_(item) {
    var m = /^EQ:([A-Z0-9_]+):(\d+)$/.exec(String(item || ''));
    return m ? { code: m[1], quantity: Number(m[2]) } : null;
  }

  /* 過去に借りたことが条件の機材（ビデオライト系の定常光）か。 */
  function isPriorRentalItem(item) {
    var parsed = parseEquipmentItem_(item);
    var def = parsed && equipmentRental_(parsed.code);
    return !!(def && def.requiresPriorRental === true);
  }

  /* セルフ設営・スタッフ対応の共通対象（Issue #423 追加コメント）。 */
  var THEMES = {
    CLASSROOM: { code: 'CLASSROOM', label: '教室セット（机・黒板）' },
    JAPANESE: { code: 'JAPANESE', label: '和風セット' },
    GRUNGE: { code: 'GRUNGE', label: 'グランジセット' },
    WHITE_BACKDROP: { code: 'WHITE_BACKDROP', label: '白背景布' },
    BLACK_BACKDROP: { code: 'BLACK_BACKDROP', label: '黒背景布' }
  };
  var THEME_CODES_ = ['CLASSROOM', 'JAPANESE', 'GRUNGE', 'WHITE_BACKDROP', 'BLACK_BACKDROP'];

  /* スタッフ対応の料金（Issue #423 追加コメント。テーマ別の個別価格は持たない）。
     この表が唯一の正本。画面はoptionCatalog APIで取得して表示し、GAS・Webhookも必ずここを参照する。 */
  var STAFF_SERVICE_PRICES_ = { PRE_SETUP: 3000, CLEANUP: 3000, BOTH: 5000 };
  var STAFF_SERVICE_LABELS_ = { PRE_SETUP: '事前設営を依頼', CLEANUP: '片付けを依頼', BOTH: '事前設営＋片付けセット' };

  /* ---- 定型案内（無料セルフセッティング。Issue #423 追加コメント 3） ----
   *
   * 収納場所・設置手順・原状復帰・注意事項は、運営（オーナー）から提供された確定文言のみを書く
   * （2026-10-24。PR #427のレビュー対応）。実装者判断で場所や手順を作らない。
   * - CLASSROOM（黒板教室）／JAPANESE（和風・畳）／WHITE_BACKDROP・BLACK_BACKDROP（白黒背景布）／
   *   GRUNGE（グランジ。背景布と同じ運用）: 5テーマすべて確定済み。
   * - 将来テーマを追加して文言が未確定の項目はnullにする。nullの項目は案内メール上で
   *   「運営にて内容を確認中」と明示し、Adminの予約詳細にも未整備として表示する
   *   （renderSelfGuidanceのincomplete）。文章が確定したらnullを置き換えるだけで全箇所へ反映される。
   *
   * 収納場所は「所定位置／指定の収納場所」という提供文言のとおり。部屋内の具体的な位置は
   * 現地の掲示・原状写真・室内のラミネート手順書で確認する前提（ここでは新しい場所を作らない）。
   */
  var BACKDROP_GUIDANCE_ = {
    items: '白・黒の背景布、背景スタンド（または竹の梁）',
    storage: '白・黒背景布は指定の収納場所に保管しています。',
    setupSteps: '背景スタンド、または竹の梁にセットして使用してください。使用する色を選び、しわやたるみを整えてください。床まで垂らす場合は、踏み込み部分を必要最小限にしてください。',
    restoreSteps: '布に汚れ・異物がないことを確認してから畳み、元の場所へ収納してください。背景スタンドを使用した場合は、スタンドも元の位置へ戻してください。',
    cautions: '靴で背景布を踏まないでください。粘着テープを直接貼らないでください。濡れ・飲食物・化粧品の付着に注意してください。'
  };
  var GUIDANCE_TEMPLATES_ = {
    CLASSROOM: {
      items: '教卓・小黒板・学校机・椅子',
      storage: '教卓・小黒板・学校机・椅子は、教室セット側の所定位置に置いてあります。',
      setupSteps: '教卓を前方、小黒板を背景側に置き、必要に応じて机・椅子を配置してください。',
      restoreSteps: '教卓・黒板・机・椅子を、原状写真と同じ位置へ戻してください。黒板に書いた内容は消してください。',
      cautions: '【黒板を移動するときは、チョークを必ずケースに収納してください。】移動中にチョークが落下すると割れるおそれがあります。黒板以外の壁や備品へは筆記しないでください。備品を強く引きずらないでください。'
    },
    JAPANESE: {
      items: '畳、滑り止め、和風備品',
      storage: '畳・和風備品は、指定の収納場所に保管しています。',
      setupSteps: '畳の下に滑り止めを敷いてから設置してください。詳しい敷き方・並べ方は、室内のラミネート手順書を参照してください。',
      restoreSteps: '畳・滑り止め・備品を、所定の順序・位置へ戻してください。',
      cautions: '畳の上で靴を使用しないでください。飲食物・濡れた物を直接置かないでください。重量物を引きずらないでください。'
    },
    /* グランジ: 運営確定「背景布と同じ運用」（2026-10-24）。提供された4点（セット／収納／スタンドの原状復帰／注意）のみ。 */
    GRUNGE: {
      items: 'グランジ背景、背景スタンド（または竹の梁）',
      storage: 'グランジ背景は、白・黒背景布と同じ運用で、指定の収納場所に保管しています。',
      setupSteps: '背景スタンド、または竹の梁にセットして使用してください。',
      restoreSteps: '使用後は畳んで元の場所へ収納してください。背景スタンドを使用した場合は、スタンドも元の位置へ戻してください。',
      cautions: '靴・粘着テープ・濡れ・飲食物・化粧品に注意してください。'
    },
    WHITE_BACKDROP: BACKDROP_GUIDANCE_,
    BLACK_BACKDROP: BACKDROP_GUIDANCE_
  };
  var COMMON_RESTORE_ = '使用後は清掃して元の位置へ戻してください。';
  var GUIDANCE_PENDING_NOTE_ = '運営にて内容を確認中です。予約確定後に、メールで改めてご案内します。';
  var EMAIL_SUPPORT_NOTE_ = 'セルフセッティング方法は予約案内に記載します。追加のご質問はメールでお問い合わせください。';

  /* 利用者向けの固定文言（画面・メールで共通。複数箇所に重複して書かない）。 */
  var NOTICES = {
    STAFF_SERVICE_APPROVAL:
      'スタッフによる事前設営・片付けは、スタッフの予定を確認する必要があるため事前確認制です。' +
      'お申し込み後、対応可否をご案内します。承認後にオンライン決済をお願いします。' +
      '申込時点ではスタッフ対応は確定していません。',
    SELF_VS_STAFF:
      'セルフ（自分で設営・原状復帰）は無料で、スタッフの空き確認は不要です。スタッフ対応（有料）は承認後の決済で確定します。',
    EMAIL_SUPPORT: EMAIL_SUPPORT_NOTE_
  };

  /* ---- 設定 ---- */

  function readPositiveInteger_(value) {
    var n = Number(value);
    return Number.isFinite(n) && n > 0 && Math.round(n) === n ? n : null;
  }

  function isBrandEnabled(brand) {
    return ENABLED_BRANDS_.indexOf(brand) !== -1;
  }

  function err_(code, message, extra) {
    var e = { code: code, message: message };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  /* 利用者向けカタログ（optionCatalog API）。PIIを含まない。 */
  function buildCatalog(brand, config) {
    if (!isBrandEnabled(brand)) {
      return { enabled: false, brand: brand, currency: CURRENCY_ };
    }
    return {
      enabled: true,
      brand: brand,
      currency: CURRENCY_,
      /* 機材ページ(studio-x/equipment/)と同一のカタログ。数量選択の上限は在庫数。 */
      equipment: StudioXEquipmentCatalog.rental.map(function (item) {
        return {
          code: item.code,
          label: item.label,
          unitPriceJpy: item.unitPriceJpy,
          unitLabel: item.unitLabel || '',
          stock: item.stock,
          requiresPriorRental: item.requiresPriorRental === true
        };
      }).concat(StudioXEquipmentCatalog.freeSelf.filter(function (item) { return item.selectable === true; }).map(function (item) {
        return { code: item.code, label: item.label, unitPriceJpy: 0, unitLabel: '', stock: item.stock, requiresPriorRental: false };
      })),
      themes: THEME_CODES_.map(function (code) { return { code: code, label: THEMES[code].label }; }),
      staffServices: {
        PRE_SETUP: { label: STAFF_SERVICE_LABELS_.PRE_SETUP, priceJpy: STAFF_SERVICE_PRICES_.PRE_SETUP },
        CLEANUP: { label: STAFF_SERVICE_LABELS_.CLEANUP, priceJpy: STAFF_SERVICE_PRICES_.CLEANUP },
        BOTH: { label: STAFF_SERVICE_LABELS_.BOTH, priceJpy: STAFF_SERVICE_PRICES_.BOTH }
      },
      notices: NOTICES
    };
  }

  /* ---- 申込内容の正規化 ----
   *
   * selection（クライアント入力。金額は一切受け取らない）:
   *   { equipment: { COB_BICOLOR: 1, STAND_260: 2 }（機材コード→数量）, layouts: ['CLASSROOM',...],
   *     setupService: 'SELF'|'STAFF'|'NONE', cleanupService: 'SELF'|'STAFF'|'NONE', emailSupport: true }
   * 戻り値: { ok:true, normalized:{equipment[], layouts[], setupService, cleanupService, emailSupport} }
   *        | { ok:false, error }
   * 未知の値・型違いはfail-closed。何も選ばれていなければ empty:true。
   */
  function isPlainObject_(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function uniqueStrings_(list) {
    var seen = {};
    var out = [];
    list.forEach(function (v) { if (!seen[v]) { seen[v] = true; out.push(v); } });
    return out;
  }

  function normalizeSelection(selection) {
    if (selection === undefined || selection === null) {
      return { ok: true, empty: true, normalized: emptySelection_() };
    }
    if (!isPlainObject_(selection)) {
      return { ok: false, error: err_('INVALID_OPTIONS', 'オプションの指定形式が正しくありません。') };
    }
    var equipmentInput = selection.equipment === undefined || selection.equipment === null ? {} : selection.equipment;
    var layouts = selection.layouts === undefined || selection.layouts === null ? [] : selection.layouts;
    if (!isPlainObject_(equipmentInput) || !Array.isArray(layouts) || layouts.length > 10 || Object.keys(equipmentInput).length > 30) {
      return { ok: false, error: err_('INVALID_OPTIONS', 'オプションの指定形式が正しくありません。') };
    }
    /* 機材: { 機材コード: 数量 }。数量0は「選ばない」。在庫数を超える数量・小数・負数は拒否する。 */
    var equipment = {};
    var equipmentCodes = Object.keys(equipmentInput);
    var i;
    for (i = 0; i < equipmentCodes.length; i++) {
      var eqCode = equipmentCodes[i];
      var def = equipmentRental_(eqCode) || equipmentFreeSelf_(eqCode);
      if (!def) {
        return { ok: false, error: err_('UNKNOWN_OPTION', '選択できないオプションが含まれています。') };
      }
      var qty = equipmentInput[eqCode];
      if (typeof qty !== 'number' || !Number.isFinite(qty) || Math.round(qty) !== qty || qty < 0) {
        return { ok: false, error: err_('INVALID_OPTIONS', def.label + 'の数量が正しくありません。') };
      }
      if (qty > def.stock) {
        return { ok: false, error: err_('STOCK_EXCEEDED', def.label + 'は最大' + def.stock + '点までです。', { items: [eqCode] }) };
      }
      if (qty > 0) equipment[eqCode] = qty;
    }
    for (i = 0; i < layouts.length; i++) {
      if (typeof layouts[i] !== 'string' || THEME_CODES_.indexOf(layouts[i]) === -1) {
        return { ok: false, error: err_('UNKNOWN_OPTION', '選択できないセッティングが含まれています。') };
      }
    }
    var setupService = selection.setupService === undefined || selection.setupService === null || selection.setupService === '' ? 'SELF' : selection.setupService;
    var cleanupService = selection.cleanupService === undefined || selection.cleanupService === null || selection.cleanupService === '' ? 'SELF' : selection.cleanupService;
    /* NONE: 後付け申込で「この項目は追加しない」（例: 事前設営は申込済みで、片付けだけ追加する）。 */
    if (['SELF', 'STAFF', 'NONE'].indexOf(setupService) === -1 || ['SELF', 'STAFF', 'NONE'].indexOf(cleanupService) === -1) {
      return { ok: false, error: err_('INVALID_OPTIONS', 'セッティング方法の指定が正しくありません。') };
    }
    if (selection.emailSupport !== undefined && selection.emailSupport !== null && typeof selection.emailSupport !== 'boolean') {
      return { ok: false, error: err_('INVALID_OPTIONS', 'メールサポートの指定が正しくありません。') };
    }

    var normalized = {
      equipment: equipment,
      layouts: uniqueStrings_(layouts),
      setupService: setupService,
      cleanupService: cleanupService,
      emailSupport: selection.emailSupport === true
    };

    /* テーマ未選択で「スタッフ対応」だけが指定されても作業対象が決まらないため拒否する。
       テーマ未選択のSELF/SELFは単に「セッティングなし」。 */
    var staffRequested = normalized.setupService === 'STAFF' || normalized.cleanupService === 'STAFF';
    if (normalized.layouts.length === 0) {
      if (staffRequested) {
        return { ok: false, error: err_('LAYOUT_REQUIRED_FOR_STAFF_SERVICE', 'スタッフ対応を依頼するセッティング（テーマ）を選択してください。') };
      }
      normalized.setupService = 'SELF';
      normalized.cleanupService = 'SELF';
    }
    /* スタッフ作業は1テーマ分（共通料金のため、複数テーマを1回の料金で依頼させない）。 */
    if (staffRequested && normalized.layouts.length !== 1) {
      return { ok: false, error: err_('STAFF_SERVICE_SINGLE_THEME', 'スタッフ対応を依頼できるセッティングは1種類です。複数ある場合は残りをセルフ設営にするか、メールでご相談ください。') };
    }

    var empty = Object.keys(normalized.equipment).length === 0 && normalized.layouts.length === 0 && !normalized.emailSupport;
    return { ok: true, empty: empty, normalized: normalized };
  }

  function emptySelection_() {
    return { equipment: {}, layouts: [], setupService: 'SELF', cleanupService: 'SELF', emailSupport: false };
  }

  /* ---- 項目コード ----
   * 注文のitemsに保存する文字列。重複判定・Admin表示・定型案内の生成に使う。 */
  var ITEM_PREFIX = {
    SELF_SETUP: 'SELF_SETUP:',
    SELF_CLEANUP: 'SELF_CLEANUP:',
    STAFF_PRE_SETUP: 'STAFF_PRE_SETUP:',
    STAFF_CLEANUP: 'STAFF_CLEANUP:',
    EMAIL_SUPPORT: 'EMAIL_SUPPORT'
  };

  function describeItem(itemCode) {
    var code = String(itemCode || '');
    var eq = parseEquipmentItem_(code);
    if (eq) {
      var eqDef = equipmentRental_(eq.code) || equipmentFreeSelf_(eq.code);
      return (eqDef ? eqDef.label : eq.code) + (eq.quantity > 1 ? ' ×' + eq.quantity : '');
    }
    if (code === ITEM_PREFIX.EMAIL_SUPPORT) return 'メールサポート';
    var themeOf = function (prefix) { var t = THEMES[code.slice(prefix.length)]; return t ? t.label : code.slice(prefix.length); };
    if (code.indexOf(ITEM_PREFIX.SELF_SETUP) === 0) return 'セルフ設営: ' + themeOf(ITEM_PREFIX.SELF_SETUP);
    if (code.indexOf(ITEM_PREFIX.SELF_CLEANUP) === 0) return 'セルフ原状復帰: ' + themeOf(ITEM_PREFIX.SELF_CLEANUP);
    if (code.indexOf(ITEM_PREFIX.STAFF_PRE_SETUP) === 0) return '事前設営（スタッフ）: ' + themeOf(ITEM_PREFIX.STAFF_PRE_SETUP);
    if (code.indexOf(ITEM_PREFIX.STAFF_CLEANUP) === 0) return '片付け（スタッフ）: ' + themeOf(ITEM_PREFIX.STAFF_CLEANUP);
    return code;
  }

  function staffServicesOfItems_(items) {
    var services = [];
    var theme = null;
    (items || []).forEach(function (item) {
      if (item.indexOf(ITEM_PREFIX.STAFF_PRE_SETUP) === 0) { services.push('PRE_SETUP'); theme = item.slice(ITEM_PREFIX.STAFF_PRE_SETUP.length); }
      if (item.indexOf(ITEM_PREFIX.STAFF_CLEANUP) === 0) { services.push('CLEANUP'); theme = item.slice(ITEM_PREFIX.STAFF_CLEANUP.length); }
    });
    return { services: uniqueStrings_(services), theme: theme };
  }

  /* スタッフ対応の合計料金（services: 'PRE_SETUP'/'CLEANUP'の集合）。両方ならセット価格。 */
  function staffServiceTotal_(services) {
    var hasPre = services.indexOf('PRE_SETUP') !== -1;
    var hasCleanup = services.indexOf('CLEANUP') !== -1;
    if (hasPre && hasCleanup) return STAFF_SERVICE_PRICES_.BOTH;
    if (hasPre) return STAFF_SERVICE_PRICES_.PRE_SETUP;
    if (hasCleanup) return STAFF_SERVICE_PRICES_.CLEANUP;
    return 0;
  }

  /*
   * 今回の追加請求額。既に有効な（却下・取消でない）スタッフ対応の注文がある予約へ後から
   * もう一方を足す場合、「合計に対するセット価格」から「既存分」を差し引く（3,000円＋3,000円＝
   * 6,000円と誤計算しない。事前設営3,000円済みに片付けを足せば5,000-3,000=2,000円）。
   * 既存と重複するサービス・既存と異なるテーマはエラー。
   */
  function computeStaffServiceCharge(existingServices, existingTheme, requestedServices, requestedTheme) {
    var overlap = requestedServices.filter(function (s) { return existingServices.indexOf(s) !== -1; });
    if (overlap.length > 0) {
      return { ok: false, error: err_('DUPLICATE_OPTION', '既に申し込み済みのスタッフ対応は重複して追加できません。') };
    }
    if (existingServices.length > 0 && existingTheme && existingTheme !== requestedTheme) {
      return { ok: false, error: err_('STAFF_SERVICE_THEME_MISMATCH', '既に申し込み済みのスタッフ対応と同じセッティングを指定してください。') };
    }
    var union = uniqueStrings_(existingServices.concat(requestedServices));
    var amount = staffServiceTotal_(union) - staffServiceTotal_(existingServices);
    if (!(amount > 0)) {
      return { ok: false, error: err_('INVALID_OPTIONS', '請求額を確定できませんでした。') };
    }
    return { ok: true, amountJpy: amount, totalAfterJpy: staffServiceTotal_(union), services: requestedServices };
  }

  /* ---- 申込 → 注文の組み立て ----
   *
   * input: {
   *   normalized,            // normalizeSelectionのnormalized
   *   existingOrders,        // 同一bookingIdの既存注文（{items:[], status}）
   *   optionsConfig,         // BookingConfig.getOptionsConfig()
   *   eligibility: { videoLightSelfRental: bool }  // 呼び出し側が履歴・Adminの許可から判定
   * }
   * 戻り値: { ok:true, orders:[{category, items[], amountJpy, approvalStatus, paymentStatus, status}] }
   *        | { ok:false, error }
   * 副作用なし。重複・未設定価格・資格なしは注文を一件も作らず全体を拒否する。
   */
  function planOrders(input) {
    var normalized = input.normalized;
    var existing = (input.existingOrders || []).filter(function (o) { return isActiveStatus(o.status); });
    var existingItems = [];
    existing.forEach(function (o) { (o.items || []).forEach(function (it) { existingItems.push(it); }); });

    var orders = [];

    /* 機材（個別加算: 数量×単価）。在庫数は予約単位で、既存の有効な注文の数量も合算して超過を拒否する。 */
    var existingQuantity = {};
    existingItems.forEach(function (item) {
      var parsed = parseEquipmentItem_(item);
      if (parsed) existingQuantity[parsed.code] = (existingQuantity[parsed.code] || 0) + parsed.quantity;
    });
    var paidItems = [];
    var paidTotal = 0;
    var freeEquipmentItems = [];
    var needsPriorRental = [];
    var equipmentCodes = Object.keys(normalized.equipment);
    for (var i = 0; i < equipmentCodes.length; i++) {
      var code = equipmentCodes[i];
      var quantity = normalized.equipment[code];
      var rental = equipmentRental_(code);
      var def = rental || equipmentFreeSelf_(code);
      if (!def) return { ok: false, error: err_('UNKNOWN_OPTION', '選択できないオプションが含まれています。') };
      if ((existingQuantity[code] || 0) + quantity > def.stock) {
        return { ok: false, error: err_('STOCK_EXCEEDED', def.label + 'は在庫数（' + def.stock + '点）を超えて申し込めません。', { items: [code] }) };
      }
      if (rental) {
        paidItems.push(equipmentItemCode_(code, quantity));
        paidTotal += rental.unitPriceJpy * quantity;
        if (rental.requiresPriorRental === true) needsPriorRental.push(rental.label);
      } else {
        freeEquipmentItems.push(equipmentItemCode_(code, quantity));
      }
    }
    if (needsPriorRental.length > 0 && !(input.eligibility && input.eligibility.videoLightSelfRental === true)) {
      return { ok: false, error: err_('VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE', needsPriorRental.join('・') + 'のセルフレンタルは、過去にビデオライトをご利用いただいた方のみ選択できます。初めての方はメールでご相談ください。', { items: needsPriorRental }) };
    }
    if (paidItems.length > 0) {
      orders.push({
        category: CATEGORY.EQUIPMENT,
        items: paidItems,
        amountJpy: paidTotal,
        approvalStatus: APPROVAL_STATUS.NOT_REQUIRED,
        paymentStatus: PAYMENT_STATUS.NOT_STARTED,
        status: STATUS.AWAITING_PAYMENT
      });
    }

    /* 無料セルフ対応・メールサポート */
    var freeItems = [];
    var staffPre = normalized.layouts.length > 0 && normalized.setupService === 'STAFF';
    var staffCleanup = normalized.layouts.length > 0 && normalized.cleanupService === 'STAFF';
    normalized.layouts.forEach(function (theme) {
      if (!staffPre && normalized.setupService !== 'NONE') freeItems.push(ITEM_PREFIX.SELF_SETUP + theme);
      if (!staffCleanup && normalized.cleanupService !== 'NONE') freeItems.push(ITEM_PREFIX.SELF_CLEANUP + theme);
    });
    if (normalized.emailSupport) freeItems.push(ITEM_PREFIX.EMAIL_SUPPORT);
    /* 無料機材（背景スタンド等）は数量・在庫を上で検査済み。重複判定は項目コードの完全一致ではなく在庫で行う。 */
    for (var j = 0; j < freeItems.length; j++) {
      if (existingItems.indexOf(freeItems[j]) !== -1) {
        return { ok: false, error: err_('DUPLICATE_OPTION', '既に選択済みのオプションが含まれています。', { items: [freeItems[j]] }) };
      }
    }
    freeItems = freeItems.concat(freeEquipmentItems);
    if (freeItems.length > 0) {
      orders.push({
        category: CATEGORY.FREE,
        items: freeItems,
        amountJpy: 0,
        approvalStatus: APPROVAL_STATUS.NOT_REQUIRED,
        paymentStatus: PAYMENT_STATUS.NOT_REQUIRED,
        status: STATUS.CONFIRMED
      });
    }

    /* 有料スタッフ対応（承認制。必ずPENDING_APPROVALから開始し、この時点では課金しない） */
    if (staffPre || staffCleanup) {
      var theme = normalized.layouts[0];
      var requested = [];
      if (staffPre) requested.push('PRE_SETUP');
      if (staffCleanup) requested.push('CLEANUP');
      var prior = staffServicesOfItems_(existingItems);
      var charge = computeStaffServiceCharge(prior.services, prior.theme, requested, theme);
      if (!charge.ok) return { ok: false, error: charge.error };
      var staffItems = [];
      if (staffPre) staffItems.push(ITEM_PREFIX.STAFF_PRE_SETUP + theme);
      if (staffCleanup) staffItems.push(ITEM_PREFIX.STAFF_CLEANUP + theme);
      orders.push({
        category: CATEGORY.STAFF_SERVICE,
        items: staffItems,
        amountJpy: charge.amountJpy,
        approvalStatus: APPROVAL_STATUS.PENDING_APPROVAL,
        paymentStatus: PAYMENT_STATUS.NOT_STARTED,
        status: STATUS.PENDING_APPROVAL
      });
    }

    /* 同じテーマの設営（または片付け）をセルフとスタッフで両方申し込む矛盾を拒否する
       （既存注文との組み合わせを含む。無料と有料の状態・料金を混同させない）。 */
    var allItems = existingItems.slice();
    orders.forEach(function (o) { o.items.forEach(function (it) { allItems.push(it); }); });
    for (var k = 0; k < THEME_CODES_.length; k++) {
      var t = THEME_CODES_[k];
      var setupConflict = allItems.indexOf(ITEM_PREFIX.SELF_SETUP + t) !== -1 && allItems.indexOf(ITEM_PREFIX.STAFF_PRE_SETUP + t) !== -1;
      var cleanupConflict = allItems.indexOf(ITEM_PREFIX.SELF_CLEANUP + t) !== -1 && allItems.indexOf(ITEM_PREFIX.STAFF_CLEANUP + t) !== -1;
      if (setupConflict || cleanupConflict) {
        return { ok: false, error: err_('SERVICE_MODE_CONFLICT', THEMES[t].label + 'の設営・片付けは、セルフとスタッフ対応を同時に選べません。') };
      }
    }

    return { ok: true, orders: orders };
  }

  /* ---- 予約側の受付可否（後付け・同時申込の共通） ----
   * booking: { status, startAt(Date), brand }。PENDING/CONFIRMEDかつ利用開始前のみ。
   * addonDeadlineHoursBeforeStartは設定値（未設定ならIssueどおり独自の締切を設けない）。 */
  function checkBookingAcceptsOptions(booking, optionsConfig, now) {
    if (!booking) return { ok: false, error: err_('BOOKING_NOT_FOUND', '予約が見つかりません。') };
    if (!isBrandEnabled(booking.brand)) {
      return { ok: false, error: err_('OPTIONS_NOT_AVAILABLE', 'この予約ではオプションをお申し込みいただけません。') };
    }
    if (booking.status !== 'PENDING' && booking.status !== 'CONFIRMED') {
      return { ok: false, error: err_('BOOKING_NOT_ELIGIBLE', 'この予約にはオプションを追加できません（取消済み・期限切れ等）。') };
    }
    var startMillis = new Date(booking.startAt).getTime();
    if (!Number.isFinite(startMillis) || startMillis <= now.getTime()) {
      return { ok: false, error: err_('BOOKING_ALREADY_STARTED', '利用開始後の予約にはオプションを追加できません。') };
    }
    var deadlineHours = optionsConfig && readPositiveInteger_(optionsConfig.addonDeadlineHoursBeforeStart);
    if (deadlineHours && startMillis - now.getTime() < deadlineHours * 3600000) {
      return { ok: false, error: err_('ADDON_DEADLINE_PASSED', 'オプションの申込締切（利用開始の' + deadlineHours + '時間前）を過ぎています。') };
    }
    return { ok: true };
  }

  /* ---- 決済 ---- */

  /* 追加決済のCheckout Sessionに載せる安全な内部参照（Issue #423 7）。PII・秘密情報は載せない。 */
  function buildCheckoutReference(order, paymentAttemptId, brand) {
    return {
      clientReferenceId: order.optionOrderId,
      metadata: {
        orderType: ORDER_TYPE_ADDON,
        bookingId: order.bookingId,
        optionOrderId: order.optionOrderId,
        paymentAttemptId: paymentAttemptId,
        brand: brand
      }
    };
  }

  function generatePaymentAttemptId(optionOrderId, uuid) {
    return 'OPAY-' + String(optionOrderId || '') + '-' + String(uuid || '').replace(/-/g, '').slice(0, 12).toUpperCase();
  }

  function generateOptionOrderId(uuid) {
    return 'OPT-' + String(uuid || '').replace(/-/g, '').slice(0, 8).toUpperCase();
  }

  /* 支払いに進める注文か（承認済み/承認不要・未払い・金額確定）。 */
  function isPayable(order) {
    if (!order) return false;
    var amount = Number(order.amountJpy);
    if (!(Number.isFinite(amount) && amount > 0 && Math.round(amount) === amount)) return false;
    var approved = order.approvalStatus === APPROVAL_STATUS.NOT_REQUIRED || order.approvalStatus === APPROVAL_STATUS.APPROVED;
    if (!approved) return false;
    return order.status === STATUS.AWAITING_PAYMENT || order.status === STATUS.PAYMENT_PENDING;
  }

  /* ---- 定型案内 ---- */

  /*
   * items: 注文のitems（FREE注文）。対象テーマごとに、保管場所・使う備品・セット方法・原状復帰・
   * 注意事項を並べる。nullの項目は「運営確認中」と明示し、incomplete:trueを返す
   * （Adminに未整備を知らせるため。内容を創作しない）。
   * 戻り値: { text, incomplete, themes[] }。セルフ対応・メールサポートがなければtext=''。
   */
  function renderSelfGuidance(items) {
    var list = items || [];
    var themes = [];
    var setupThemes = {};
    var cleanupThemes = {};
    list.forEach(function (item) {
      if (item.indexOf(ITEM_PREFIX.SELF_SETUP) === 0) {
        var t1 = item.slice(ITEM_PREFIX.SELF_SETUP.length);
        setupThemes[t1] = true;
        if (themes.indexOf(t1) === -1) themes.push(t1);
      }
      if (item.indexOf(ITEM_PREFIX.SELF_CLEANUP) === 0) {
        var t2 = item.slice(ITEM_PREFIX.SELF_CLEANUP.length);
        cleanupThemes[t2] = true;
        if (themes.indexOf(t2) === -1) themes.push(t2);
      }
    });
    var hasEmailSupport = list.indexOf(ITEM_PREFIX.EMAIL_SUPPORT) !== -1;
    if (themes.length === 0 && !hasEmailSupport) return { text: '', incomplete: false, themes: [] };

    var incomplete = false;
    var blocks = [];
    function field_(label, value) {
      if (value) return label + ': ' + value;
      incomplete = true;
      return label + ': ' + GUIDANCE_PENDING_NOTE_;
    }
    themes.forEach(function (theme) {
      var tpl = GUIDANCE_TEMPLATES_[theme];
      if (!tpl) return;
      var lines = ['【' + THEMES[theme].label + 'のセルフセッティング】'];
      lines.push(field_('保管場所', tpl.storage));
      lines.push(field_('使用する備品', tpl.items));
      if (setupThemes[theme]) lines.push(field_('セット方法', tpl.setupSteps));
      if (cleanupThemes[theme]) {
        lines.push(field_('原状復帰の方法', tpl.restoreSteps));
        lines.push(COMMON_RESTORE_);
      }
      lines.push(field_('注意事項', tpl.cautions));
      blocks.push(lines.join('\n'));
    });
    if (themes.length > 0 || hasEmailSupport) blocks.push(EMAIL_SUPPORT_NOTE_);
    return { text: blocks.join('\n\n'), incomplete: incomplete, themes: themes };
  }

  /* 注文の表示用サマリ（PII・内部トークンを含まない。利用者向けAPI・Admin両方で使う）。 */
  function summarizeOrder(order) {
    var items = order.items || [];
    return {
      optionOrderId: order.optionOrderId,
      category: order.category,
      source: order.source,
      items: items.map(function (code) { return { code: code, label: describeItem(code) }; }),
      amountJpy: Number(order.amountJpy) || 0,
      currency: CURRENCY_,
      approvalStatus: order.approvalStatus,
      paymentStatus: order.paymentStatus,
      status: order.status,
      requiresApproval: order.category === CATEGORY.STAFF_SERVICE,
      payable: isPayable(order)
    };
  }

  return {
    ENABLED_BRANDS: ENABLED_BRANDS_.slice(),
    CURRENCY: CURRENCY_,
    ORDER_TYPE_ADDON: ORDER_TYPE_ADDON,
    CATEGORY: CATEGORY,
    SOURCE: SOURCE,
    APPROVAL_STATUS: APPROVAL_STATUS,
    PAYMENT_STATUS: PAYMENT_STATUS,
    STATUS: STATUS,
    NOTICES: NOTICES,
    ITEM_PREFIX: ITEM_PREFIX,
    isBrandEnabled: isBrandEnabled,
    isActiveStatus: isActiveStatus,
    canTransition: canTransition,
    buildCatalog: buildCatalog,
    normalizeSelection: normalizeSelection,
    describeItem: describeItem,
    isPriorRentalItem: isPriorRentalItem,
    computeStaffServiceCharge: computeStaffServiceCharge,
    planOrders: planOrders,
    checkBookingAcceptsOptions: checkBookingAcceptsOptions,
    buildCheckoutReference: buildCheckoutReference,
    generatePaymentAttemptId: generatePaymentAttemptId,
    generateOptionOrderId: generateOptionOrderId,
    isPayable: isPayable,
    renderSelfGuidance: renderSelfGuidance,
    summarizeOrder: summarizeOrder
  };
})();
