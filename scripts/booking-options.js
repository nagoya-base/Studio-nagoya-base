/*
 * scripts/booking-options.js — 予約オプション（Issue #423。Studio Xのみ）の選択パネル。
 *
 * 予約フォーム（scripts/booking-app.js）と、既存予約への後付け案内ページ
 * （scripts/booking-options-addon.js）の両方から、同じパネルを使う。
 *
 * 【方針】
 * - 料金・在庫・対象・利用条件はGAS（optionCatalog API）が返すカタログが唯一の正本。このファイルに
 *   金額（3,000円等）を持たない。表示する金額は常にカタログの値。
 * - 【責務分離（Issue #465）】バックエンドは意味（金額・在庫・enum・フラグ・error.code・注文のstatus）だけを返し、
 *   利用者向けの日本語はこのファイル（COPY / ERROR_COPY / describeOrderStatus）が持つ。
 *   バックエンドの文章（notices・error.message）は表示しない。内部用語（管理者・承認・利用許可・
 *   PENDING_APPROVAL等）は公開画面に出さず、利用者の行動（確認後にご案内／お支払い）へ言い換える。
 *   GAS内部の状態名・コメントはそのままでよい。公開画面の内部用語0件はtest/booking-public-copy.test.jsが検査する。
 * - 画面は「選択内容」だけをサーバーへ送る。金額・確認状態・資格はサーバーが判定する
 *   （画面で選択できる＝申込が通る、ではない）。
 * - 無料セルフ（自分で設営・原状復帰）と有料スタッフ対応（事前確認制）の違いが一目で分かる
 *   ようにし、スタッフ対応は「申込時点では確定しない」旨を選択箇所の近くに表示する。
 */
(function (global) {
  'use strict';

  /* スタッフ設営の事前相談導線の文言（相談は申込・確定・決済ではない）。 */
  var CONSULT_TEXT = {
    lead: '配置に迷う場合は、申込前に相談できます。',
    notice: '相談だけでは予約されません。',
    cta: '設営について相談する'
  };

  /* 利用条件が変わらない画面の短い補足文（Issue #453）。詳細は機材ページへ逃がし、同じ注意を複数箇所で繰り返さない。 */
  var TEXT = {
    selfGuidance: '保管場所・セット方法・原状復帰方法は予約案内に記載します。',
    emailSupport: '予約後の設営方法についてメールで確認できます。'
  };

  /*
   * カタログの policy（構造化された利用条件。GAS BookingOptions.PUBLIC_POLICY）。
   * 古いキャッシュ等でpolicyが無くても、現行の運用条件で表示する（文言はサーバーから受け取らない）。
   */
  var DEFAULT_POLICY = {
    equipmentPaymentMethod: 'CARD_ONLY',
    equipmentPaymentTiming: 'AFTER_ROOM_CONFIRMED',
    roomAndOptionsPayment: 'SEPARATE',
    staffServicePaymentTiming: 'AFTER_AVAILABILITY_CONFIRMED',
    staffServiceConfirmedOnApply: false,
    equipmentRequiresPrecheck: true,
    equipmentSetupChoiceRequired: true,
    selfServiceFree: true
  };

  function policyOf(catalog) {
    var given = (catalog && catalog.policy) || {};
    var policy = {};
    Object.keys(DEFAULT_POLICY).forEach(function (key) {
      policy[key] = given[key] !== undefined ? given[key] : DEFAULT_POLICY[key];
    });
    return policy;
  }

  /* policy（意味）→ 利用者向けコピー。条件を満たさない項目は空文字（画面に出さない）。 */
  function copyFor(catalog) {
    var p = policyOf(catalog);
    var staffAfterCheck = p.staffServicePaymentTiming === 'AFTER_AVAILABILITY_CONFIRMED';
    var equipmentAfterRoom = p.equipmentPaymentTiming === 'AFTER_ROOM_CONFIRMED';
    var selfFree = p.selfServiceFree === true;
    var setupRequired = p.equipmentSetupChoiceRequired === true;
    return {
      cardOnly: p.equipmentPaymentMethod === 'CARD_ONLY'
        ? '機材レンタルはオンラインクレジットカード決済のみです（PayPay・現金は受け付けていません）。' : '',
      equipmentPayment: equipmentAfterRoom ? '部屋予約の確定後にカード決済します。' : '',
      permission: p.equipmentRequiresPrecheck
        ? '有料機材は、利用条件の確認後にご案内します。初めての方は事前にご相談ください。' : '',
      permissionSelected: p.equipmentRequiresPrecheck
        ? '有料機材は、利用条件の確認がとれるまでお支払い・確定はできません。' : '',
      paymentSplit: p.roomAndOptionsPayment === 'SEPARATE' ? '部屋代とオプションは別決済です。' : '',
      paymentTiming: (staffAfterCheck ? 'スタッフ対応は日程確認後にご利用可能な場合のみ、' : '') +
        (equipmentAfterRoom ? '機材は部屋の予約確定後に' : '') + (staffAfterCheck || equipmentAfterRoom ? 'お支払いです。' : ''),
      staffNotice: staffAfterCheck
        ? 'スタッフ設営・片付けは事前確認制です。お申し込み後に対応可否をご案内し、ご利用可能な場合のみオンライン決済をお願いします。' +
          (p.staffServiceConfirmedOnApply === false ? '申込時点ではスタッフ対応は確定していません。' : '')
        : '',
      selfVsStaff: staffAfterCheck
        ? 'セルフ（自分で設営・原状復帰）は' + (selfFree ? '無料です。' : 'ご自身で行う方法です。') +
          'スタッフ対応（有料）は、日程確認後にご利用可能な場合のみお支払いいただきます。' : '',
      /* 「必須」「無料」の表示は policy.equipmentSetupChoiceRequired / selfServiceFree から導出する。 */
      setupHeadingPaid: '設営方法' + (setupRequired ? '（機材レンタル時は必須）' : ''),
      cleanupHeadingPaid: '片付け方法' + (setupRequired ? '（機材レンタル時は必須）' : ''),
      selfSetupChoice: 'セルフ設営' + (selfFree ? '　無料' : ''),
      selfCleanupChoice: '自分で原状復帰' + (selfFree ? '　無料' : ''),
      selfSetupLine: 'セルフ設営' + (selfFree ? '（無料）' : ''),
      selfCleanupLine: 'セルフ片付け・原状復帰' + (selfFree ? '（無料）' : ''),
      selfLabel: 'セルフ' + (selfFree ? '（無料）' : ''),
      setupRequired: setupRequired
    };
  }

  /* error.code → 利用者向け文言。サーバーのerror.messageは表示しない（文言の責任はフロント）。 */
  var GENERIC_ERROR_TEXT = 'オプションのお申し込みを処理できませんでした。時間を置いて再度お試しください。';
  var ERROR_COPY = {
    INVALID_OPTIONS: 'オプションの指定内容を確認してください。',
    UNKNOWN_OPTION: '選択できないオプションが含まれています。選び直してください。',
    STOCK_EXCEEDED: '在庫数を超える数量は選択できません。数量を見直してください。',
    SETUP_METHOD_REQUIRED: '機材をレンタルする場合は、設営方法（セルフ設営／スタッフ設営）を選択してください。',
    CLEANUP_METHOD_REQUIRED: '機材をレンタルする場合は、片付け方法（セルフ片付け／スタッフ片付け）を選択してください。',
    LAYOUT_REQUIRED_FOR_STAFF_SERVICE: 'スタッフ対応を依頼するセッティング（テーマ）を選択してください。',
    STAFF_SERVICE_SINGLE_THEME: 'スタッフ対応を依頼できるセッティングは1種類です。複数ある場合は残りをセルフ設営にするか、メールでご相談ください。',
    DUPLICATE_OPTION: '既に申し込み済みのオプションは重複して追加できません。',
    STAFF_SERVICE_THEME_MISMATCH: '既に申し込み済みのスタッフ対応と同じセッティングを指定してください。',
    SERVICE_MODE_CONFLICT: '同じセッティングの設営・片付けは、セルフとスタッフ対応を同時に選べません。',
    BOOKING_NOT_FOUND: '予約が見つかりません。',
    BOOKING_NOT_ELIGIBLE: 'この予約にはオプションを追加できません（取消済み・期限切れ等）。',
    BOOKING_ALREADY_STARTED: '利用開始後の予約にはオプションを追加できません。',
    ADDON_DEADLINE_PASSED: 'オプションの申込締切を過ぎています。メールでご相談ください。',
    OPTIONS_NOT_AVAILABLE: 'この予約ではオプションをお申し込みいただけません。',
    VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE: '施錠管理している有料レンタル機材は、利用条件の確認がとれた方のみご利用いただけます。お支払いには進めません。メールでご相談ください。',
    APPROVAL_REQUIRED: 'お支払いは、利用条件・日程の確認後にご案内します。ご案内をお待ちください。',
    NO_OPTIONS_SELECTED: '追加するオプションを選択してください。',
    RATE_LIMITED: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。',
    LOCK_TIMEOUT: '一時的に混み合っています。もう一度お試しください。',
    CHECKOUT_DISABLED: '現在オンライン決済は受け付けていません。ご案内をお待ちください。',
    CHECKOUT_NOT_CONFIGURED: '現在オンライン決済をご利用いただけません。しばらくしてから再度お試しください。',
    BOOKING_NOT_CONFIRMED: 'ご予約の確定後にお支払いいただけます。',
    NOT_PAYABLE: 'このオプションはお支払いの対象ではありません。',
    ALREADY_PAID: 'このオプションはお支払い済みです。確定のご案内メールをお待ちください。',
    ORDER_DECLINED: 'このスタッフ対応は対応できませんでした。お支払いは発生していません。',
    ORDER_NOT_FOUND: '対象のオプションのお申し込みが見つかりません。',
    CHECKOUT_LOOKUP_FAILED: '決済ページを確認できませんでした。しばらくしてから再度お試しください。',
    CHECKOUT_FAILED: '決済ページを作成できませんでした。しばらくしてから再度お試しください。',
    CHECKOUT_UNCERTAIN: '決済ページの作成結果を確認できませんでした。しばらくしてから再度お試しください。二重にお支払いにならないよう、同じ手順で再度ご案内します。',
    FORBIDDEN: '予約IDまたはメールアドレスが一致しません。ご登録の内容をご確認ください。',
    INVALID_EMAIL: 'メールアドレスの形式が正しくありません。',
    PRICE_NOT_CONFIGURED: '現在このオプションは受け付けていません。メールでご相談ください。'
  };

  var THEME_ORDER = ['CLASSROOM', 'JAPANESE', 'GRUNGE', 'WHITE_BACKDROP', 'BLACK_BACKDROP'];

  function formatJpy(amount) {
    var n = Number(amount);
    return Number.isFinite(n) ? n.toLocaleString('ja-JP') + '円' : '';
  }

  /* ---- 純粋ロジック（DOM非依存。node --testで検証する） ---- */

  /* 'NONE'は後付け申込で「この項目は追加しない」。それ以外の不明値はセルフ(無料)に倒す。 */
  function normalizeService(value) {
    return value === 'STAFF' || value === 'NONE' ? value : 'SELF';
  }

  /*
   * state: { equipment:[], layouts:[], setupService:'SELF'|'STAFF', cleanupService:'SELF'|'STAFF', emailSupport:bool }
   * 何も選ばれていなければnull（payloadにoptionsを付けない）。金額は含めない。
   */
  function buildSelection(state) {
    var s = state || {};
    /* 機材: { 機材コード: 数量 }。数量0以下は選ばない扱い。 */
    var equipment = {};
    Object.keys(s.equipment || {}).forEach(function (code) {
      var qty = Number(s.equipment[code]);
      if (Number.isFinite(qty) && qty > 0) equipment[code] = qty;
    });
    var layouts = (s.layouts || []).slice();
    var emailSupport = s.emailSupport === true;
    if (Object.keys(equipment).length === 0 && layouts.length === 0 && !emailSupport) return null;
    return {
      equipment: equipment,
      layouts: layouts,
      setupService: layouts.length > 0 || Object.keys(equipment).length > 0 ? normalizeService(s.setupService) : 'SELF',
      cleanupService: layouts.length > 0 || Object.keys(equipment).length > 0 ? normalizeService(s.cleanupService) : 'SELF',
      emailSupport: emailSupport
    };
  }

  /* スタッフ対応の表示料金。両方依頼ならカタログのセット価格（3,000円×2にしない）。 */
  function staffServicePrice(catalog, setupService, cleanupService) {
    var services = catalog && catalog.staffServices;
    if (!services) return null;
    var setup = setupService === 'STAFF';
    var cleanup = cleanupService === 'STAFF';
    var key = setup && cleanup ? 'BOTH' : (setup ? 'PRE_SETUP' : (cleanup ? 'CLEANUP' : ''));
    if (!key || !services[key]) return null;
    return { key: key, label: services[key].label, priceJpy: services[key].priceJpy };
  }

  /*
   * 料金サマリー（Issue #441）。カタログの単価・セット価格だけから算出する（金額の別ロジックは持たない）。
   * スタッフ設営・片付けは、セッティング（テーマ）を選んでいるか有料機材をレンタルする場合に対象になる
   * （サーバー BookingOptions.normalizeSelection / planOrders と同じ規則）。両方依頼ならセット価格で、
   * 個別価格の合計との差額を「セット割引」として分けて返す。最終請求額はサーバーが決める。
   */
  /* 後付け時: 申込済み（有効）注文のスタッフ対応サービス。サーバー staffServicesOfItems_ と同じ項目コードで判定する。 */
  function existingStaffServices(existingOrders) {
    var found = { PRE_SETUP: false, CLEANUP: false };
    (existingOrders || []).forEach(function (order) {
      (order.items || []).forEach(function (item) {
        var code = typeof item === 'string' ? item : (item && item.code) || '';
        if (code.indexOf('STAFF_PRE_SETUP:') === 0) found.PRE_SETUP = true;
        if (code.indexOf('STAFF_CLEANUP:') === 0) found.CLEANUP = true;
      });
    });
    return found;
  }

  function computeSummary(catalog, state, existingOrders) {
    var s = state || {};
    var equipment = {};
    Object.keys(s.equipment || {}).forEach(function (code) {
      if (Number(s.equipment[code]) > 0) equipment[code] = Number(s.equipment[code]);
    });
    var services = (catalog && catalog.staffServices) || {};
    var existing = existingStaffServices(existingOrders);
    var applicable = (s.layouts || []).length > 0 || hasPaidEquipment(catalog, equipment);
    var setupStaff = applicable && s.setupService === 'STAFF' && !!services.PRE_SETUP;
    var cleanupStaff = applicable && s.cleanupService === 'STAFF' && !!services.CLEANUP;
    /* 申込済みのサービスと重複する依頼は、サーバーが DUPLICATE_OPTION で拒否する（validateSelectionで案内）。 */
    var duplicate = (setupStaff && existing.PRE_SETUP) || (cleanupStaff && existing.CLEANUP);
    function priceOf(pre, cleanup) {
      if (pre && cleanup) return services.BOTH ? Number(services.BOTH.priceJpy) : Number(services.PRE_SETUP.priceJpy) + Number(services.CLEANUP.priceJpy);
      if (pre) return services.PRE_SETUP ? Number(services.PRE_SETUP.priceJpy) : 0;
      if (cleanup) return services.CLEANUP ? Number(services.CLEANUP.priceJpy) : 0;
      return 0;
    }
    var setupJpy = setupStaff && !existing.PRE_SETUP ? Number(services.PRE_SETUP.priceJpy) : 0;
    var cleanupJpy = cleanupStaff && !existing.CLEANUP ? Number(services.CLEANUP.priceJpy) : 0;
    /* 今回の追加請求額 = 「既存＋今回」のセット価格 − 「既存」のセット価格（サーバー computeStaffServiceCharge と同じ式）。 */
    var staffJpy = (setupStaff || cleanupStaff) && !duplicate
      ? priceOf(existing.PRE_SETUP || setupStaff, existing.CLEANUP || cleanupStaff) - priceOf(existing.PRE_SETUP, existing.CLEANUP)
      : 0;
    if (duplicate) { setupJpy = 0; cleanupJpy = 0; }
    var bundleAdjustmentJpy = duplicate ? 0 : staffJpy - setupJpy - cleanupJpy;
    var equipmentJpy = equipmentTotalJpy(catalog, equipment);
    return {
      equipmentJpy: equipmentJpy,
      setupJpy: setupJpy,
      cleanupJpy: cleanupJpy,
      bundleAdjustmentJpy: bundleAdjustmentJpy,
      staffJpy: staffJpy,
      setupMethod: applicable ? normalizeService(s.setupService) : 'SELF',
      cleanupMethod: applicable ? normalizeService(s.cleanupService) : 'SELF',
      existingStaff: existing,
      duplicate: !!duplicate,
      applicable: applicable,
      totalJpy: equipmentJpy + staffJpy
    };
  }

  function formatSignedJpy(amount) {
    return (amount < 0 ? '-' : '') + formatJpy(Math.abs(amount));
  }

  /* 送信前のクライアント側チェック（最終判定はサーバー）。エラー文言 or ''。 */
  function validateSelection(state, catalog, existingOrders) {
    var s = state || {};
    var layouts = s.layouts || [];
    /* 機材レンタルの設営方法はセルフ/スタッフの2択（後付けでも「追加しない」は選べない）。スタッフ設営はテーマ未選択でも依頼できる。 */
    var choiceRequired = !!catalog && policyOf(catalog).equipmentSetupChoiceRequired === true && hasPaidEquipment(catalog, s.equipment);
    if (choiceRequired && !(s.setupChosen === true && (s.setupService === 'SELF' || s.setupService === 'STAFF'))) {
      return '機材をレンタルする場合は、設営方法（セルフ設営／スタッフ設営）を選択してください。';
    }
    /* 片付け方法も同様に必須（Issue #441）。 */
    if (choiceRequired && !(s.cleanupChosen === true && (s.cleanupService === 'SELF' || s.cleanupService === 'STAFF'))) {
      return '機材をレンタルする場合は、片付け方法（セルフ片付け／スタッフ片付け）を選択してください。';
    }
    if (catalog && existingOrders && computeSummary(catalog, s, existingOrders).duplicate) {
      return '既に申し込み済みのスタッフ対応（設営／片付け）は重複して追加できません。申込済みの項目は「セルフ」または「追加しない」を選んでください。';
    }
    /* ポータブルストロボにソフトボックスを付ける場合は、ボーエンズマウントブラケットが物理的に必須（Issue #463）。 */
    if (catalog && s.equipment && ((catalog.equipment || []).some(function (e) { return e.code === 'BOWENS_BRACKET'; })) &&
        Number(s.equipment.BOWENS_BRACKET || 0) < requiredBracketQuantity(s.equipment)) {
      return 'ポータブルストロボにソフトボックスを取り付ける場合は、ボーエンズマウントブラケットが必要です。';
    }
    var staff = layouts.length > 0 && (s.setupService === 'STAFF' || s.cleanupService === 'STAFF');
    if (staff && layouts.length !== 1) {
      return 'スタッフ対応（有料）を依頼できるセッティングは1種類です。複数選ぶ場合は、残りを' + copyFor(catalog).selfLabel + 'にするか、メールでご相談ください。';
    }
    return '';
  }

  /* セット無料の数量（表示用。サーバー BookingOptions.bundleFreeQuantities_ と同じ規則: min(数量, 相手機材の合計数量)）。
     相手機材の定義はカタログ（freeWhenWith.codes）の値だけを使う。最終請求額はサーバーが決める。 */
  function bundleFreeQuantity(catalog, equipment, code) {
    var item = null;
    ((catalog && catalog.equipment) || []).forEach(function (e) { if (e.code === code) item = e; });
    var quantity = Number((equipment || {})[code]) || 0;
    if (!item || !item.freeWhenWith || !(quantity > 0)) return 0;
    var companions = 0;
    (item.freeWhenWith.codes || []).forEach(function (c) { companions += Number((equipment || {})[c]) || 0; });
    return Math.min(quantity, companions);
  }

  function equipmentLineJpy(catalog, equipment, code) {
    var item = null;
    ((catalog && catalog.equipment) || []).forEach(function (e) { if (e.code === code) item = e; });
    if (!item) return 0;
    return Number(item.unitPriceJpy) * (Number(equipment[code]) - bundleFreeQuantity(catalog, equipment, code));
  }

  /* 機材の合計（数量×単価の個別加算。セット無料の対象分は除く）。単価はカタログの値だけを使う。 */
  function equipmentTotalJpy(catalog, equipment) {
    return Object.keys(equipment || {}).reduce(function (sum, code) {
      return sum + equipmentLineJpy(catalog, equipment, code);
    }, 0);
  }

  /* 有料レンタル機材（単価>0）を1点でも選んでいるか。設営方法の必須選択の判定に使う。 */
  function hasPaidEquipment(catalog, equipment) {
    var paid = {};
    ((catalog && catalog.equipment) || []).forEach(function (e) { if (Number(e.unitPriceJpy) > 0) paid[e.code] = true; });
    return Object.keys(equipment || {}).some(function (code) { return paid[code] && Number(equipment[code]) > 0; });
  }

  /* ---- おすすめ照明セット（Issue #463） ----
   * 3ステップ（光の種類・灯数・ソフトボックス）から、既存の機材数量（state.equipment）へ初期選択を入れる補助。
   * 料金・在庫・無料セット条件は既存のカタログ／計算をそのまま使い、ここでは金額を持たない。
   * 適用は利用者が「この構成を選択する」を押したときだけ。適用後の手動変更は元に戻さない。 */
  var LIGHTING_STEPS = [
    {
      key: 'kind',
      title: 'STEP 1　光の種類',
      options: [
        { value: 'STROBE', label: 'ストロボ', text: '一瞬だけ強く発光します。人物をくっきり撮りたいときや、動きを止めたい撮影に向いています。基本はカメラ向けです。' },
        { value: 'VIDEO', label: 'ビデオライト（定常光）', text: '見たままの明るさを確認しながら撮影できます。写真だけでなく、動画撮影やスマホ撮影にも使いやすい照明です。' }
      ]
    },
    {
      key: 'count',
      title: 'STEP 2　灯数',
      options: [
        { value: '1', label: '1灯', text: '光と影がはっきり出やすく、立体感のある仕上がりになります。シンプルに撮りたい方にもおすすめです。' },
        { value: '2', label: '2灯', text: '片側の影をやわらげたり、背景や輪郭にも光を回せます。明るさのバランスを取りやすく、人物撮影の幅が広がります。' }
      ]
    },
    {
      key: 'softbox',
      title: 'STEP 3　ソフトボックス',
      options: [
        { value: 'OFF', label: 'なし', text: '光がやや硬めで、陰影やコントラストが出やすい設定です。' },
        { value: 'ON', label: 'あり', text: '光がやわらかく広がり、顔や肌の影が穏やかになります。人物撮影で自然に仕上げたいときにおすすめです。' }
      ]
    }
  ];

  /* 組み合わせごとの「どんな撮影になるか」。機械的な連結だと不自然になるため、8通りの専用文言を持つ。 */
  var LIGHTING_RESULT_TEXT = {
    'STROBE:1:OFF': 'くっきり硬めの光で、陰影のはっきりした立体感のある人物写真に。1灯でシンプルに、動きも止めやすい構成です。',
    'STROBE:2:OFF': '2灯で片側の影を起こしつつ、背景や輪郭にも光を回せます。コントラストを保ったまま、メリハリのある人物撮影に向いています。',
    'VIDEO:1:OFF': '見たままの明るさを確認しながら撮れる1灯。陰影がはっきり出て、写真・動画・スマホ撮影のどれにも使いやすい構成です。',
    'VIDEO:2:OFF': '見たままの明るさで調整しやすく、動画・スマホ撮影にも対応。2灯で影のバランスを整えながら撮れます。',
    'STROBE:1:ON': 'ソフトボックスで光がやわらかく広がり、顔や肌の影が穏やかに。1灯でも自然な人物ポートレートに仕上がります。',
    'STROBE:2:ON': '大きなソフトボックスで顔をやわらかく照らし、細長いソフトボックスで輪郭や背景に光を足せます。ストロボの切れ味を残しつつ、自然な人物撮影ができます。',
    'VIDEO:1:ON': '見たままの明るさで調整しやすく、ソフトボックスで人物をやわらかく照らせます。動画・スマホ撮影にもおすすめです。',
    'VIDEO:2:ON': '見たままの明るさで調整しやすく、動画・スマホ撮影にも対応。2灯で影を整え、ソフトボックスで人物をやわらかく照らせます。'
  };

  var SOFTBOX_CODES = ['SOFTBOX_60', 'SOFTBOX_STRIP_60X90', 'SOFTBOX_STRIP_30X120'];
  /* おすすめ適用時に入れ替える照明機材。コマンダー・背景スタンド等の他の選択には触れない。 */
  var LIGHTING_MANAGED_CODES = ['STROBE_PORTABLE', 'STROBE_MONOBLOCK', 'COB_BICOLOR', 'COB_FULLCOLOR', 'STAND_260', 'BOWENS_BRACKET'].concat(SOFTBOX_CODES);
  var COMMANDER_CODES = ['COMMANDER_CANON', 'COMMANDER_SONY'];

  function lightingChoiceKey(choice) {
    var c = choice || {};
    if ((c.kind !== 'STROBE' && c.kind !== 'VIDEO') || (c.count !== '1' && c.count !== '2') || (c.softbox !== 'ON' && c.softbox !== 'OFF')) return '';
    return c.kind + ':' + c.count + ':' + c.softbox;
  }

  /* ボーエンズマウントブラケットが物理的に必須な数量。ポータブルストロボにソフトボックスを付ける場合のみ1。
     モノブロック・ビデオライトのソフトボックスや、ポータブル単体では不要。 */
  function requiredBracketQuantity(equipment) {
    var eq = equipment || {};
    var portable = Number(eq.STROBE_PORTABLE) > 0;
    var softbox = SOFTBOX_CODES.some(function (code) { return Number(eq[code]) > 0; });
    return portable && softbox ? 1 : 0;
  }

  /* 必須ブラケットが足りなければ補う（equipmentを直接更新）。補った場合true。カタログにブラケットが無ければ何もしない。 */
  function ensureRequiredBracket(catalog, equipment) {
    var need = requiredBracketQuantity(equipment);
    var known = ((catalog && catalog.equipment) || []).some(function (e) { return e.code === 'BOWENS_BRACKET'; });
    if (!known || need === 0 || Number(equipment.BOWENS_BRACKET) >= need) return false;
    equipment.BOWENS_BRACKET = need;
    return true;
  }

  /* 3ステップの選択から、おすすめ機材 { 機材コード: 数量 } を作る。未選択があればnull。 */
  function lightingPresetItems(choice) {
    if (!lightingChoiceKey(choice)) return null;
    var count = Number(choice.count);
    var items = {};
    if (choice.kind === 'STROBE') {
      items.STROBE_PORTABLE = 1;
      if (count === 2) items.STROBE_MONOBLOCK = 1;
    } else {
      items.COB_BICOLOR = 1;
      if (count === 2) items.COB_FULLCOLOR = 1;
    }
    items.STAND_260 = count;
    if (choice.softbox === 'ON') {
      items.SOFTBOX_60 = 1;
      if (count === 2) items.SOFTBOX_STRIP_60X90 = 1;
    }
    var bracket = requiredBracketQuantity(items);
    if (bracket > 0) items.BOWENS_BRACKET = bracket;
    return items;
  }

  function lightingResultTitle(choice) {
    var key = lightingChoiceKey(choice);
    if (!key) return '';
    return (choice.kind === 'STROBE' ? 'ストロボ' : 'ビデオライト') + ' × ' + choice.count + '灯 × ソフトボックス' + (choice.softbox === 'ON' ? 'あり' : 'なし');
  }

  /* おすすめを現在の機材数量へ適用した結果を返す（元は変更しない）。照明機材だけ入れ替え、他の選択は保つ。
     カタログに無い・在庫を超える機材があれば適用せずnull（部分的な構成にしない）。 */
  function applyLightingPreset(catalog, equipment, choice) {
    var items = lightingPresetItems(choice);
    if (!items || lightingPresetShortage(catalog, items).length > 0) return null;
    var next = {};
    Object.keys(equipment || {}).forEach(function (code) {
      if (LIGHTING_MANAGED_CODES.indexOf(code) === -1) next[code] = equipment[code];
    });
    Object.keys(items).forEach(function (code) { next[code] = items[code]; });
    return next;
  }

  /* おすすめに必要な機材のうち、カタログに無い／在庫が足りないもののコード。 */
  function lightingPresetShortage(catalog, items) {
    var byCode = {};
    ((catalog && catalog.equipment) || []).forEach(function (e) { byCode[e.code] = e; });
    return Object.keys(items || {}).filter(function (code) {
      return !byCode[code] || Number(byCode[code].stock) < items[code];
    });
  }

  /* 機材レンタルの支払方法の明示（Issue #443）。条件はカタログの policy（構造化データ）から、文言はフロントのコピーで組み立てる（Issue #465）。 */
  function equipmentCardOnlyText(catalog) {
    return copyFor(catalog).cardOnly;
  }

  /*
   * 部屋代を含む表示用の合計（Issue #443）。部屋代は予約本体の正本（見積りAPI／予約済みの金額）をそのまま渡され、
   * ここでは金額表を持たない。オプション小計は computeSummary（= サーバー請求額と同じ規則）の totalJpy。
   * roomPrice: { kind:'estimate'|'booked', status:'ok'|'pending'|'unavailable', amountJpy }
   *   estimate（初回予約）: 総合計 = 部屋代 + オプション小計。部屋代が確定していない間は総合計を出さない（推測しない）。
   *   booked（後付け）: 予約済み部屋代と今回の追加請求額を別ラベルで並べ、合算した「総合計」は作らない。
   */
  function computeTotals(sum, roomPrice) {
    var room = roomPrice && roomPrice.status === 'ok' && Number.isFinite(Number(roomPrice.amountJpy)) ? Number(roomPrice.amountJpy) : null;
    return {
      roomJpy: room,
      optionSubtotalJpy: sum.totalJpy,
      grandTotalJpy: roomPrice && roomPrice.kind === 'estimate' && room !== null ? room + sum.totalJpy : null
    };
  }

  function serviceLabel(value, catalog) {
    if (value === 'STAFF') return 'スタッフ';
    if (value === 'NONE') return '追加なし';
    return copyFor(catalog).selfLabel;
  }

  /* 申込内容の確認用サマリ行。 */
  function summarize(catalog, state) {
    var selection = buildSelection(state);
    if (!selection) return [];
    var lines = [];
    var equipmentByCode = {};
    ((catalog && catalog.equipment) || []).forEach(function (e) { equipmentByCode[e.code] = e; });
    Object.keys(selection.equipment).forEach(function (code) {
      var e = equipmentByCode[code];
      var qty = selection.equipment[code];
      var lineJpy = equipmentLineJpy(catalog, selection.equipment, code);
      var freeQty = bundleFreeQuantity(catalog, selection.equipment, code);
      var freeText = freeQty > 0 ? (freeQty >= qty ? '（セット無料）' : '（うち' + freeQty + (e && e.unitLabel ? e.unitLabel : '点') + 'セット無料）') : '';
      lines.push((e ? e.label : code) + (qty > 1 ? ' ×' + qty : '') + '（' + (lineJpy > 0 ? formatJpy(lineJpy) : '無料') + '）' + freeText);
    });
    var equipmentTotal = equipmentTotalJpy(catalog, selection.equipment);
    if (hasPaidEquipment(catalog, selection.equipment)) {
      lines.push('機材の設営方法: ' + (state.setupService === 'STAFF' ? 'スタッフ設営（事前確認制・事前設営料金）' : copyFor(catalog).selfSetupLine));
      lines.push('機材の片付け方法: ' + (state.cleanupService === 'STAFF' ? 'スタッフ片付け（事前確認制・片付け料金）' : copyFor(catalog).selfCleanupLine));
    }
    if (equipmentTotal > 0) lines.push('機材レンタル合計: ' + formatJpy(equipmentTotal) + '（個別加算。部屋のご予約確定後にお支払い）');
    var themeByCode = {};
    ((catalog && catalog.themes) || []).forEach(function (t) { themeByCode[t.code] = t; });
    selection.layouts.forEach(function (code) {
      lines.push((themeByCode[code] ? themeByCode[code].label : code) +
        '：設営=' + serviceLabel(selection.setupService, catalog) +
        '／片付け=' + serviceLabel(selection.cleanupService, catalog));
    });
    var staffPrice = computeSummary(catalog, state).applicable ? staffServicePrice(catalog, selection.setupService, selection.cleanupService) : null;
    if (staffPrice) {
      lines.push('スタッフ対応料金: ' + formatJpy(staffPrice.priceJpy) + '（日程確認後、ご利用可能な場合のみお支払い。申込時点では確定しません）');
    }
    if (selection.emailSupport) lines.push('メールサポート（無料）');
    return lines;
  }

  /* error.codeから利用者向け文言を引く。サーバーのerror.messageは使わない。未知のcodeは汎用文。 */
  function describeError(error) {
    var code = error && typeof error.code === 'string' ? error.code : '';
    return Object.prototype.hasOwnProperty.call(ERROR_COPY, code) ? ERROR_COPY[code] : GENERIC_ERROR_TEXT;
  }

  /* 注文の状態表示（利用者向け）。内部の状態名（PENDING_APPROVAL等）は画面に出さず、利用者の行動に言い換える。 */
  function describeOrderStatus(order) {
    if (!order) return '';
    if (order.status === 'CONFIRMED') return order.amountJpy > 0 ? '確定（お支払い済み）' : '確定（無料）';
    if (order.status === 'PENDING_APPROVAL') return '確認中（まだ確定していません・お支払いは不要です）';
    if (order.status === 'AWAITING_PAYMENT') return order.requiresApproval ? '確認済み（お支払いをお願いします）' : 'お支払い待ち';
    if (order.status === 'PAYMENT_PENDING') return 'お支払い手続き中';
    if (order.status === 'DECLINED') return '対応できませんでした（お支払いは発生していません）';
    if (order.status === 'CANCELLED') return '取消';
    return '';
  }

  /* ---- DOM ---- */

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else if (key === 'className') node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  var uid = 0;

  function choice(name, value, labelText, type, disabled) {
    uid += 1;
    var input = el('input', { type: type, name: name, value: value, id: 'bo-' + uid });
    if (disabled) input.disabled = true;
    var label = el('label', { className: 'ba-choice' + (disabled ? ' ba-choice--disabled' : ''), for: 'bo-' + uid }, [input, el('span', { text: ' ' + labelText })]);
    return { label: label, input: input };
  }

  function mount(config) {
    var slot = config.slot;
    var catalog = config.catalog || null;
    var state = { equipment: {}, layouts: [], setupService: 'SELF', setupChosen: false, cleanupService: 'SELF', cleanupChosen: false, emailSupport: false };
    var existingOrders = config.existingOrders || [];
    /* おすすめ照明セットの3ステップ選択（Issue #463）。料金計算に使う state には混ぜない。 */
    var lightingChoice = { kind: '', count: '', softbox: '' };
    var lightingNotice = '';
    var dependencyNotice = '';
    var controller = {
      isAvailable: function () { return !!(catalog && catalog.enabled); },
      getState: function () { return JSON.parse(JSON.stringify(state)); },
      getSelection: function () { return buildSelection(state); },
      validate: function () { return validateSelection(state, catalog, existingOrders); },
      getSummary: function () { return computeSummary(catalog, state, existingOrders); },
      setExistingOrders: function (orders) { existingOrders = orders || []; render(); },
      summaryLines: function () { return summarize(catalog, state); },
      reset: function () { state = { equipment: {}, layouts: [], setupService: 'SELF', setupChosen: false, cleanupService: 'SELF', cleanupChosen: false, emailSupport: false }; lightingChoice = { kind: '', count: '', softbox: '' }; lightingNotice = ''; dependencyNotice = ''; render(); },
      setCatalog: function (next) { catalog = next; render(); },
      /* 部屋代の見積り・予約済み部屋代が変わったとき、サマリーだけを描き直す（入力中のパネルは触らない）。 */
      refreshSummary: function () { renderSummary(); },
      ready: null
    };

    /* ---- おすすめ照明セット（Issue #463）: 3ステップ→確認表示→「この構成を選択する」で機材欄へ反映 ---- */
    function lightingItemLines(items) {
      var byCode = {};
      (catalog.equipment || []).forEach(function (e) { byCode[e.code] = e; });
      return Object.keys(items).map(function (code) {
        return (byCode[code] ? byCode[code].label : code) + ' ×' + items[code];
      });
    }

    function renderLightingSection(root) {
      var section = el('div', { className: 'ba-lighting' });
      section.appendChild(el('h4', { className: 'ba-lighting-title', text: 'おすすめ照明セット' }));
      section.appendChild(el('p', { className: 'ba-field-help', text: '3つ選ぶだけで、必要な機材をまとめて選択します。選択後も機材は自由に変更できます。' }));

      LIGHTING_STEPS.forEach(function (step) {
        var group = el('fieldset', { className: 'ba-lighting-step' }, [el('legend', { text: step.title })]);
        var name = 'bo-lighting-' + step.key;
        var options = el('div', { className: 'ba-lighting-options' });
        step.options.forEach(function (opt) {
          var input = el('input', { type: 'radio', name: name, value: opt.value });
          input.checked = lightingChoice[step.key] === opt.value;
          input.addEventListener('change', function () {
            lightingChoice[step.key] = opt.value;
            lightingNotice = '';
            render();
          });
          options.appendChild(el('label', { className: 'ba-lighting-option' }, [
            input,
            el('span', { className: 'ba-lighting-option-body' }, [
              el('strong', { text: opt.label }),
              el('span', { className: 'ba-lighting-option-text', text: opt.text })
            ])
          ]));
        });
        group.appendChild(options);
        section.appendChild(group);
      });

      var items = lightingPresetItems(lightingChoice);
      if (items) {
        var shortage = lightingPresetShortage(catalog, items);
        var preview = el('div', { className: 'ba-lighting-preview ba-banner ba-banner--notice' }, [
          el('p', { className: 'ba-lighting-preview-title', text: lightingResultTitle(lightingChoice) }),
          el('p', { className: 'ba-lighting-preview-text', text: LIGHTING_RESULT_TEXT[lightingChoiceKey(lightingChoice)] }),
          el('p', { className: 'ba-option-subheading', text: '選択されたセット' })
        ]);
        var list = el('ul', { className: 'ba-lighting-items' });
        lightingItemLines(items).forEach(function (line) { list.appendChild(el('li', { text: line })); });
        preview.appendChild(list);
        if (shortage.length === 0) {
          preview.appendChild(el('p', { className: 'ba-field-help', text: 'この構成の機材レンタル：' + formatJpy(equipmentTotalJpy(catalog, items)) + '（税込・セット無料を反映）' }));
        } else {
          preview.appendChild(el('p', { className: 'ba-field-help', role: 'alert', text: 'この構成は現在選択できません。下の機材欄から個別に選んでください。' }));
        }
        section.appendChild(preview);
        var apply = el('button', { type: 'button', className: 'ba-btn ba-btn-primary ba-lighting-apply', text: 'この構成を選択する' });
        if (shortage.length > 0) apply.disabled = true;
        apply.addEventListener('click', function () {
          var next = applyLightingPreset(catalog, state.equipment, lightingChoice);
          if (!next) return;
          state.equipment = next;
          dependencyNotice = '';
          lightingNotice = 'おすすめの機材を選択しました。下の機材欄で自由に追加・削除・変更できます。';
          render();
        });
        section.appendChild(apply);
      } else {
        section.appendChild(el('p', { className: 'ba-field-help', text: 'STEP 1〜3 を選ぶと、おすすめの機材セットが表示されます。' }));
      }
      if (lightingNotice) section.appendChild(el('p', { className: 'ba-field-help ba-lighting-notice', role: 'status', text: lightingNotice }));

      /* ストロボのコマンダーは自動選択せず、必要な方だけ任意で追加できる（カメラによっては不要）。 */
      var commanders = (catalog.equipment || []).filter(function (e) { return COMMANDER_CODES.indexOf(e.code) !== -1; });
      if (lightingChoice.kind === 'STROBE' && commanders.length > 0) {
        var commanderBox = el('div', { className: 'ba-lighting-commander' }, [
          el('p', { className: 'ba-option-subheading', text: 'ワイヤレスコマンダー（任意）' }),
          el('p', { className: 'ba-field-help', text: 'ワイヤレスコマンダーが必要な方は追加してください。カメラによっては不要な場合があります。' })
        ]);
        var commanderChoices = el('div', { className: 'ba-choices' });
        commanders.forEach(function (item) {
          var c = choice('bo-commander', item.code, item.label + '　' + formatJpy(item.unitPriceJpy), 'checkbox', false);
          c.input.checked = Number(state.equipment[item.code]) > 0;
          c.input.addEventListener('change', function () {
            if (c.input.checked) state.equipment[item.code] = 1;
            else delete state.equipment[item.code];
            render();
          });
          commanderChoices.appendChild(c.label);
        });
        commanderBox.appendChild(commanderChoices);
        section.appendChild(commanderBox);
      }
      root.appendChild(section);
    }

    function render() {
      slot.textContent = '';
      if (!catalog || !catalog.enabled) {
        slot.hidden = true;
        return;
      }
      slot.hidden = false;
      var root = el('fieldset', { className: 'ba-fieldset' });
      root.appendChild(el('legend', { text: 'オプション（任意）' }));
      /* 長い説明は案内ページへ逃がし、予約フォームは選択・申込に集中させる（Issue #457）。 */
      var guideLink = el('a', { href: config.equipmentPageUrl || '../equipment/', text: '背景・照明・設営オプションを先に確認する →', target: '_blank', rel: 'noopener' });
      root.appendChild(el('p', { className: 'ba-field-help' }, [guideLink]));
      var copy = copyFor(catalog);
      if (copy.selfVsStaff) root.appendChild(el('p', { className: 'ba-field-help', text: copy.selfVsStaff }));

      /* 機材レンタル（1点ごとの個別加算。料金・在庫はカタログ＝機材ページと同一の正本） */
      root.appendChild(el('h3', { className: 'ba-option-heading', text: '機材レンタル（1点ごとの個別加算）' }));
      var equipmentLink = el('a', { href: config.equipmentPageUrl || '../equipment/', text: '撮影機材・レンタル料金を見る', target: '_blank', rel: 'noopener' });
      root.appendChild(el('p', { className: 'ba-field-help' }, [equipmentLink]));
      renderLightingSection(root);
      var equipmentGroup = el('div', { className: 'ba-option-equipment' });
      (catalog.equipment || []).forEach(function (item) {
        uid += 1;
        var select = el('select', { id: 'bo-eq-' + uid, 'aria-label': item.label + 'の数量' });
        /* 物理的に必須のブラケットは「借りない」を選べない（外しても自動で戻す保険は change 側にもある）。 */
        var locked = item.code === 'BOWENS_BRACKET' && requiredBracketQuantity(state.equipment) > 0;
        for (var n = 0; n <= item.stock; n += 1) {
          var option = el('option', { value: String(n), text: n === 0 ? '0（借りない）' : String(n) });
          if (locked && n === 0) option.disabled = true;
          select.appendChild(option);
        }
        select.value = String(state.equipment[item.code] || 0);
        select.addEventListener('change', function () {
          var qty = Number(select.value);
          if (qty > 0) state.equipment[item.code] = qty;
          else delete state.equipment[item.code];
          dependencyNotice = '';
          var hadBracket = Number(state.equipment.BOWENS_BRACKET) > 0;
          if (ensureRequiredBracket(catalog, state.equipment)) {
            dependencyNotice = item.code === 'BOWENS_BRACKET' && !hadBracket
              ? 'ポータブルストロボにソフトボックスを付ける場合は、ボーエンズマウントブラケットが必要なため外せません。'
              : 'ポータブルストロボにソフトボックスを付けるため、ボーエンズマウントブラケットを自動で追加しました。';
          }
          render();
        });
        var priceText = item.freeWhenWith && item.freeWhenWith.label
          ? item.freeWhenWith.label
          : (item.unitPriceJpy > 0
            ? formatJpy(item.unitPriceJpy) + (item.unitLabel ? ' / ' + item.unitLabel : '')
            : '無料（セルフ）');
        var stockText = item.stock > 1 ? '（最大' + item.stock + (item.unitLabel || '点') + '）' : '';
        equipmentGroup.appendChild(el('div', { className: 'ba-choice' }, [
          el('label', { for: 'bo-eq-' + uid, text: item.label + (locked ? '【必須】' : '') + '　' + priceText + stockText + '　' }), select
        ]));
      });
      root.appendChild(equipmentGroup);
      if (dependencyNotice) root.appendChild(el('p', { className: 'ba-field-help ba-lighting-notice', role: 'status', text: dependencyNotice }));
      var equipmentTotal = equipmentTotalJpy(catalog, state.equipment);
      if (hasPaidEquipment(catalog, state.equipment)) {
        /* 金額を主役に、条件は短い2行へまとめる（カード決済のみの明示は料金サマリーに1回だけ出す）。 */
        root.appendChild(el('div', { className: 'ba-banner ba-banner--notice ba-equipment-notes' }, [
          el('p', { className: 'ba-equipment-total', text: '機材レンタル：' + formatJpy(equipmentTotal) + '（税込）' }),
          copy.equipmentPayment ? el('p', { className: 'ba-equipment-note', text: '※' + copy.equipmentPayment }) : null,
          copy.permissionSelected ? el('p', { className: 'ba-equipment-note', text: '※' + copy.permissionSelected }) : null
        ]));
      } else if (copy.permission) {
        root.appendChild(el('p', { className: 'ba-field-help', text: copy.permission }));
      }

      /* セッティング（テーマ） */
      root.appendChild(el('h3', { className: 'ba-option-heading', text: 'セッティング' }));
      var themeGroup = el('div', { className: 'ba-choices' });
      THEME_ORDER.forEach(function (code) {
        var theme = (catalog.themes || []).filter(function (t) { return t.code === code; })[0];
        if (!theme) return;
        var c = choice('bo-layout', theme.code, theme.label, 'checkbox', false);
        c.input.checked = state.layouts.indexOf(theme.code) !== -1;
        c.input.addEventListener('change', function () {
          state.layouts = state.layouts.filter(function (value) { return value !== theme.code; });
          if (c.input.checked) state.layouts.push(theme.code);
          render();
        });
        themeGroup.appendChild(c.label);
      });
      root.appendChild(themeGroup);

      var paidEquipment = hasPaidEquipment(catalog, state.equipment);
      var choiceRequired = paidEquipment && copy.setupRequired;
      if (state.layouts.length > 0 || paidEquipment) {
        var staff = catalog.staffServices || {};
        var setupPrice = staff.PRE_SETUP ? formatJpy(staff.PRE_SETUP.priceJpy) : '';
        var cleanupPrice = staff.CLEANUP ? formatJpy(staff.CLEANUP.priceJpy) : '';
        root.appendChild(el('p', { className: 'ba-option-subheading', text: paidEquipment ? copy.setupHeadingPaid : '設営（利用前）' }));
        var setupGroup = el('div', { className: 'ba-choices' });
        var setupChoices = [['SELF', copy.selfSetupChoice], ['STAFF', 'スタッフ設営　+' + setupPrice + '（事前確認制）']];
        if (config.allowNone && !paidEquipment) setupChoices.push(['NONE', '設営は追加しない（申込済み・不要）']);
        setupChoices.forEach(function (pair) {
          var c = choice('bo-setup', pair[0], pair[1], 'radio', false);
          c.input.checked = state.setupService === pair[0] && (!choiceRequired || state.setupChosen);
          c.input.addEventListener('change', function () { state.setupService = pair[0]; state.setupChosen = true; render(); });
          setupGroup.appendChild(c.label);
        });
        root.appendChild(setupGroup);

        /* 片付け方法。機材レンタルでは設営方法と同様に必須（Issue #441。テーマ未選択でも選べる）。 */
        root.appendChild(el('p', { className: 'ba-option-subheading', text: paidEquipment ? copy.cleanupHeadingPaid : '片付け（利用後）' }));
        var cleanupGroup = el('div', { className: 'ba-choices' });
        var cleanupChoices = [['SELF', copy.selfCleanupChoice], ['STAFF', 'スタッフ片付け　+' + cleanupPrice + '（事前確認制）']];
        if (config.allowNone && !paidEquipment) cleanupChoices.push(['NONE', '片付けは追加しない（申込済み・不要）']);
        cleanupChoices.forEach(function (pair) {
          var c = choice('bo-cleanup', pair[0], pair[1], 'radio', false);
          c.input.checked = state.cleanupService === pair[0] && (!choiceRequired || state.cleanupChosen);
          c.input.addEventListener('change', function () { state.cleanupService = pair[0]; state.cleanupChosen = true; render(); });
          cleanupGroup.appendChild(c.label);
        });
        root.appendChild(cleanupGroup);

        if (state.layouts.length > 0) {
          /* 設営について申込前に相談できる導線（Issue #423 追加要件）。既存の問い合わせフォームへのリンクのみで、
             相談してもオプション注文・Checkoutは一切作られない。別タブで開くので、相談後は
             このページに戻って通常の設営申込をそのまま続けられる。 */
          var consult = el('div', { className: 'ba-option-consult' }, [
            el('p', { className: 'ba-field-help', text: CONSULT_TEXT.lead }),
            el('a', { className: 'ba-btn ba-btn-ghost', href: config.consultUrl || '../reservation/?intent=consult', target: '_blank', rel: 'noopener', text: CONSULT_TEXT.cta }),
            el('p', { className: 'ba-field-help', text: CONSULT_TEXT.notice })
          ]);
          root.appendChild(consult);
        }

        var price = staffServicePrice(catalog, state.setupService, state.cleanupService);
        var existingStaff = computeSummary(catalog, state, existingOrders).existingStaff;
        if (price) {
          /* 後付けで申込済みのスタッフ対応がある場合は、セット価格ではなく今回の追加請求額を示す。 */
          var bannerText = existingStaff.PRE_SETUP || existingStaff.CLEANUP
            ? '今回のスタッフ対応の追加料金：' + formatJpy(computeSummary(catalog, state, existingOrders).staffJpy) + '（申込済み分との差額・税込）'
            : price.label + '：' + formatJpy(price.priceJpy) + '（税込）';
          root.appendChild(el('p', { className: 'ba-banner ba-banner--notice', text: bannerText }));
          if (copy.staffNotice) root.appendChild(el('p', { className: 'ba-banner ba-banner--notice', text: copy.staffNotice }));
        } else {
          root.appendChild(el('p', { className: 'ba-field-help', text: TEXT.selfGuidance }));
        }
      }

      /* メールサポート */
      root.appendChild(el('h3', { className: 'ba-option-heading', text: '無料サポート' }));
      var supportChoice = choice('bo-support', 'EMAIL_SUPPORT', 'メールサポート（無料）', 'checkbox', false);
      supportChoice.input.checked = state.emailSupport;
      supportChoice.input.addEventListener('change', function () { state.emailSupport = supportChoice.input.checked; });
      root.appendChild(el('div', { className: 'ba-choices' }, [supportChoice.label]));
      root.appendChild(el('p', { className: 'ba-field-help', text: TEXT.emailSupport }));

      slot.appendChild(root);
      renderSummary();
    }

    /* 遷移CTA直前の料金サマリー（Issue #441）。summarySlotがあればそこへ、無ければパネル末尾へ描く。 */
    function renderSummary() {
      var target = config.summarySlot || null;
      if (!target) return;
      target.textContent = '';
      if (!catalog || !catalog.enabled) {
        target.hidden = true;
        return;
      }
      target.hidden = false;
      var sum = computeSummary(catalog, state, existingOrders);
      var copy = copyFor(catalog);
      var roomPrice = typeof config.getRoomPrice === 'function' ? config.getRoomPrice() : null;
      var totals = computeTotals(sum, roomPrice);
      var rows = [];
      if (roomPrice) {
        if (roomPrice.kind === 'booked') {
          if (totals.roomJpy !== null) rows.push(['予約済みの部屋代', formatJpy(totals.roomJpy)]);
        } else {
          rows.push(['部屋代', totals.roomJpy !== null ? formatJpy(totals.roomJpy) : (roomPrice.status === 'pending' ? '計算中' : '日時の選択後に表示')]);
        }
      }
      rows.push(['機材レンタル小計', formatJpy(sum.equipmentJpy)]);
      if (sum.applicable) {
        rows.push(['スタッフ設営', sum.existingStaff.PRE_SETUP ? (sum.setupMethod === 'STAFF' ? '0円（申込済み）' : '0円（申込済み・追加なし）') : (sum.setupMethod === 'STAFF' ? formatJpy(sum.setupJpy) : (sum.setupMethod === 'NONE' ? '追加なし' : '0円（セルフ）'))]);
        rows.push(['スタッフ片付け', sum.existingStaff.CLEANUP ? (sum.cleanupMethod === 'STAFF' ? '0円（申込済み）' : '0円（申込済み・追加なし）') : (sum.cleanupMethod === 'STAFF' ? formatJpy(sum.cleanupJpy) : (sum.cleanupMethod === 'NONE' ? '追加なし' : '0円（セルフ）'))]);
      } else {
        rows.push(['スタッフ設営', '0円']);
        rows.push(['スタッフ片付け', '0円']);
      }
      if (sum.bundleAdjustmentJpy !== 0) rows.push(['セット割引（設営＋片付け）', formatSignedJpy(sum.bundleAdjustmentJpy)]);
      var list = el('dl', { className: 'ba-option-summary-list' });
      rows.forEach(function (row) {
        list.appendChild(el('dt', { text: row[0] }));
        list.appendChild(el('dd', { text: row[1] }));
      });
      var booked = !!roomPrice && roomPrice.kind === 'booked';
      var estimate = !!roomPrice && !booked;
      if (booked) {
        list.appendChild(el('dt', { text: '今回の追加オプション' }));
        list.appendChild(el('dd', { text: formatJpy(sum.totalJpy) }));
        list.appendChild(el('dt', { className: 'ba-option-summary-total', text: '今回の追加請求額' }));
      } else {
        list.appendChild(el('dt', { className: estimate ? '' : 'ba-option-summary-total', text: estimate ? 'オプション小計' : '今回のオプション合計' }));
      }
      list.appendChild(el('dd', { className: estimate ? '' : 'ba-option-summary-total', id: 'ba-option-summary-total', text: formatJpy(sum.totalJpy) }));
      if (estimate) {
        list.appendChild(el('dt', { className: 'ba-option-summary-total', text: '総合計（部屋代＋オプション小計）' }));
        list.appendChild(el('dd', { className: 'ba-option-summary-total', id: 'ba-option-summary-grand-total', text: totals.grandTotalJpy !== null ? formatJpy(totals.grandTotalJpy) : '—' }));
      }
      target.appendChild(el('div', { className: 'ba-banner ba-banner--notice ba-option-summary', role: 'status', 'aria-live': 'polite' }, [
        el('h3', { className: 'ba-option-heading', text: '料金サマリー（税込）' }),
        list,
        hasPaidEquipment(catalog, state.equipment) ? el('p', { className: 'ba-field-help', id: 'ba-summary-card-only', text: equipmentCardOnlyText(catalog) }) : null,
        estimate && copy.paymentSplit ? el('p', { className: 'ba-field-help', text: '※' + copy.paymentSplit }) : null,
        copy.paymentTiming ? el('p', { className: 'ba-field-help', text: '※' + copy.paymentTiming }) : null
      ]));
    }

    render();

    /* カタログ未指定ならAPIから取得する。取得に失敗した場合はパネルを出さない（予約自体は妨げない）。 */
    if (!catalog && config.apiBaseUrl) {
      var url = config.apiBaseUrl + (config.apiBaseUrl.indexOf('?') === -1 ? '?' : '&') + 'action=optionCatalog&brand=' + encodeURIComponent(config.brand || '');
      controller.ready = fetch(url)
        .then(function (response) { return response.json(); })
        .then(function (body) {
          if (body && body.success === true && body.catalog) {
            catalog = body.catalog;
          }
          render();
        })
        .catch(function () { render(); });
    }
    return controller;
  }

  var api = {
    mount: mount,
    buildSelection: buildSelection,
    staffServicePrice: staffServicePrice,
    equipmentTotalJpy: equipmentTotalJpy,
    bundleFreeQuantity: bundleFreeQuantity,
    hasPaidEquipment: hasPaidEquipment,
    validateSelection: validateSelection,
    lightingPresetItems: lightingPresetItems,
    lightingResultTitle: lightingResultTitle,
    applyLightingPreset: applyLightingPreset,
    requiredBracketQuantity: requiredBracketQuantity,
    ensureRequiredBracket: ensureRequiredBracket,
    LIGHTING_STEPS: LIGHTING_STEPS,
    LIGHTING_RESULT_TEXT: LIGHTING_RESULT_TEXT,
    computeSummary: computeSummary,
    computeTotals: computeTotals,
    equipmentCardOnlyText: equipmentCardOnlyText,
    summarize: summarize,
    describeError: describeError,
    describeOrderStatus: describeOrderStatus,
    copyFor: copyFor,
    policyOf: policyOf,
    ERROR_COPY: ERROR_COPY,
    CONSULT_TEXT: CONSULT_TEXT,
    TEXT: TEXT,
    formatJpy: formatJpy
  };

  global.BookingOptionsPanel = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : this);
