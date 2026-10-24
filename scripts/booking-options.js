/*
 * scripts/booking-options.js — 予約オプション（Issue #423。Studio Xのみ）の選択パネル。
 *
 * 予約フォーム（scripts/booking-app.js）と、既存予約への後付け案内ページ
 * （scripts/booking-options-addon.js）の両方から、同じパネルを使う。
 *
 * 【方針】
 * - 料金・対象・文言はGAS（optionCatalog API）が返すカタログが唯一の正本。このファイルに
 *   金額（3,000円等）を持たない。表示する金額は常にカタログの値。
 * - 画面は「選択内容」だけをサーバーへ送る。金額・承認状態・資格はサーバーが判定する
 *   （画面で選択できる＝申込が通る、ではない。有料レンタル機材の利用許可等は
 *   サーバーの応答をそのまま表示する）。
 * - 無料セルフ（自分で設営・原状復帰）と有料スタッフ対応（事前確認制）の違いが一目で分かる
 *   ようにし、スタッフ対応は「申込時点では確定しない」旨を選択箇所の近くに表示する。
 */
(function (global) {
  'use strict';

  /* スタッフ設営の事前相談導線の文言（相談は申込・確定・決済ではない）。 */
  var CONSULT_TEXT = {
    lead: '配置や内容に迷っている場合は、申し込み前にご相談いただけます。',
    notice: '事前相談だけではスタッフ設営の申込・確定・決済にはなりません。',
    cta: '設営について事前相談する',
    back: '相談フォームは別のタブで開きます。相談後はこのページに戻って、通常どおり設営を申し込めます。'
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
    if (catalog && hasPaidEquipment(catalog, s.equipment) && !(s.setupChosen === true && (s.setupService === 'SELF' || s.setupService === 'STAFF'))) {
      return '機材をレンタルする場合は、設営方法（セルフ設営／スタッフ設営）を選択してください。';
    }
    /* 片付け方法も同様に必須（Issue #441）。 */
    if (catalog && hasPaidEquipment(catalog, s.equipment) && !(s.cleanupChosen === true && (s.cleanupService === 'SELF' || s.cleanupService === 'STAFF'))) {
      return '機材をレンタルする場合は、片付け方法（セルフ片付け／スタッフ片付け）を選択してください。';
    }
    if (catalog && existingOrders && computeSummary(catalog, s, existingOrders).duplicate) {
      return '既に申し込み済みのスタッフ対応（設営／片付け）は重複して追加できません。申込済みの項目は「セルフ」または「追加しない」を選んでください。';
    }
    var staff = layouts.length > 0 && (s.setupService === 'STAFF' || s.cleanupService === 'STAFF');
    if (staff && layouts.length !== 1) {
      return 'スタッフ対応（有料）を依頼できるセッティングは1種類です。複数選ぶ場合は、残りをセルフ（無料）にするか、メールでご相談ください。';
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

  /* 機材レンタルの支払方法の明示（Issue #443）。文言はカタログ（サーバー）の値を優先する。 */
  var EQUIPMENT_CARD_ONLY_FALLBACK = '機材レンタルはオンラインクレジットカード決済のみです（PayPay・現金は受け付けていません）。';
  function equipmentCardOnlyText(catalog) {
    return (catalog && catalog.notices && catalog.notices.EQUIPMENT_CARD_ONLY) || EQUIPMENT_CARD_ONLY_FALLBACK;
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

  function serviceLabel(value) {
    if (value === 'STAFF') return 'スタッフ';
    if (value === 'NONE') return '追加なし';
    return 'セルフ（無料）';
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
      lines.push('機材の設営方法: ' + (state.setupService === 'STAFF' ? 'スタッフ設営（事前確認制・事前設営料金）' : 'セルフ設営（無料）'));
      lines.push('機材の片付け方法: ' + (state.cleanupService === 'STAFF' ? 'スタッフ片付け（事前確認制・片付け料金）' : 'セルフ片付け・原状復帰（無料）'));
    }
    if (equipmentTotal > 0) lines.push('機材レンタル合計: ' + formatJpy(equipmentTotal) + '（個別加算。部屋のご予約確定後にお支払い）');
    var themeByCode = {};
    ((catalog && catalog.themes) || []).forEach(function (t) { themeByCode[t.code] = t; });
    selection.layouts.forEach(function (code) {
      lines.push((themeByCode[code] ? themeByCode[code].label : code) +
        '：設営=' + serviceLabel(selection.setupService) +
        '／片付け=' + serviceLabel(selection.cleanupService));
    });
    var staffPrice = computeSummary(catalog, state).applicable ? staffServicePrice(catalog, selection.setupService, selection.cleanupService) : null;
    if (staffPrice) {
      lines.push('スタッフ対応料金: ' + formatJpy(staffPrice.priceJpy) + '（承認後にお支払い。申込時点では確定しません）');
    }
    if (selection.emailSupport) lines.push('メールサポート（無料）');
    return lines;
  }

  /* サーバーが返したerror.messageは利用者向けの文言。codeが無い・messageが無い場合のみ汎用文。 */
  function describeError(error) {
    if (error && typeof error.message === 'string' && error.message) return error.message;
    return 'オプションのお申し込みを処理できませんでした。時間を置いて再度お試しください。';
  }

  /* 注文の状態表示（利用者向け）。 */
  function describeOrderStatus(order) {
    if (!order) return '';
    if (order.status === 'CONFIRMED') return order.amountJpy > 0 ? '確定（お支払い済み）' : '確定（無料）';
    if (order.status === 'PENDING_APPROVAL') return '承認待ち（まだ確定していません・お支払いは不要です）';
    if (order.status === 'AWAITING_PAYMENT') return order.requiresApproval ? '承認済み（お支払いをお願いします）' : 'お支払い待ち';
    if (order.status === 'PAYMENT_PENDING') return 'お支払い手続き中';
    if (order.status === 'DECLINED') return '対応できませんでした（お支払いは発生していません）';
    if (order.status === 'CANCELLED') return '取消';
    return order.status || '';
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
    var controller = {
      isAvailable: function () { return !!(catalog && catalog.enabled); },
      getState: function () { return JSON.parse(JSON.stringify(state)); },
      getSelection: function () { return buildSelection(state); },
      validate: function () { return validateSelection(state, catalog, existingOrders); },
      getSummary: function () { return computeSummary(catalog, state, existingOrders); },
      setExistingOrders: function (orders) { existingOrders = orders || []; render(); },
      summaryLines: function () { return summarize(catalog, state); },
      reset: function () { state = { equipment: {}, layouts: [], setupService: 'SELF', setupChosen: false, cleanupService: 'SELF', cleanupChosen: false, emailSupport: false }; render(); },
      setCatalog: function (next) { catalog = next; render(); },
      /* 部屋代の見積り・予約済み部屋代が変わったとき、サマリーだけを描き直す（入力中のパネルは触らない）。 */
      refreshSummary: function () { renderSummary(); },
      ready: null
    };

    function render() {
      slot.textContent = '';
      if (!catalog || !catalog.enabled) {
        slot.hidden = true;
        return;
      }
      slot.hidden = false;
      var root = el('fieldset', { className: 'ba-fieldset' });
      root.appendChild(el('legend', { text: 'オプション（任意）' }));
      root.appendChild(el('p', { className: 'ba-field-help', text: (catalog.notices && catalog.notices.SELF_VS_STAFF) || '' }));

      /* 機材レンタル（1点ごとの個別加算。料金・在庫はカタログ＝機材ページと同一の正本） */
      root.appendChild(el('h3', { className: 'ba-option-heading', text: '機材レンタル（1点ごとの個別加算）' }));
      var equipmentLink = el('a', { href: config.equipmentPageUrl || '../equipment/', text: '撮影機材・レンタル料金を見る', target: '_blank', rel: 'noopener' });
      root.appendChild(el('p', { className: 'ba-field-help' }, [equipmentLink]));
      var equipmentGroup = el('div', { className: 'ba-option-equipment' });
      (catalog.equipment || []).forEach(function (item) {
        uid += 1;
        var select = el('select', { id: 'bo-eq-' + uid, 'aria-label': item.label + 'の数量' });
        for (var n = 0; n <= item.stock; n += 1) {
          select.appendChild(el('option', { value: String(n), text: n === 0 ? '0（借りない）' : String(n) }));
        }
        select.value = String(state.equipment[item.code] || 0);
        select.addEventListener('change', function () {
          var qty = Number(select.value);
          if (qty > 0) state.equipment[item.code] = qty;
          else delete state.equipment[item.code];
          render();
        });
        var priceText = item.freeWhenWith && item.freeWhenWith.label
          ? item.freeWhenWith.label
          : (item.unitPriceJpy > 0
            ? formatJpy(item.unitPriceJpy) + (item.unitLabel ? ' / ' + item.unitLabel : '')
            : '無料（セルフ）');
        var stockText = item.stock > 1 ? '（最大' + item.stock + (item.unitLabel || '点') + '）' : '';
        equipmentGroup.appendChild(el('div', { className: 'ba-choice' }, [
          el('label', { for: 'bo-eq-' + uid, text: item.label + '　' + priceText + stockText + '　' }), select
        ]));
      });
      root.appendChild(equipmentGroup);
      var equipmentTotal = equipmentTotalJpy(catalog, state.equipment);
      if (equipmentTotal > 0) {
        root.appendChild(el('p', { className: 'ba-banner ba-banner--notice', text: '機材レンタル合計：' + formatJpy(equipmentTotal) + '（税込。部屋のご予約が確定した後にお支払いいただきます）' }));
      }
      if (hasPaidEquipment(catalog, state.equipment)) {
        root.appendChild(el('p', { className: 'ba-banner ba-banner--notice', id: 'ba-equipment-card-only', text: equipmentCardOnlyText(catalog) }));
      }
      var needsLecture = (catalog.equipment || []).some(function (e) { return e.requiresLecture && state.equipment[e.code]; });
      root.appendChild(el('p', { className: needsLecture ? 'ba-banner ba-banner--notice' : 'ba-field-help', text: '有料レンタル機材は施錠管理しているため、セルフでのご利用には管理者の利用許可（信用確認）が必要です。許可を確認できない場合、申込は保留となり、管理者が確認するまでお支払い・確定はできません（許可が確認できない場合はお受けできません）。初めての方は、先にメールでご相談ください。' }));

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
      if (state.layouts.length > 0 || paidEquipment) {
        var staff = catalog.staffServices || {};
        var setupPrice = staff.PRE_SETUP ? formatJpy(staff.PRE_SETUP.priceJpy) : '';
        var cleanupPrice = staff.CLEANUP ? formatJpy(staff.CLEANUP.priceJpy) : '';
        root.appendChild(el('p', { className: 'ba-field-help', text: paidEquipment ? '設営方法（機材レンタルでは必須）' : '設営（利用前）' }));
        if (paidEquipment) root.appendChild(el('p', { className: 'ba-field-help', text: (catalog.notices && catalog.notices.EQUIPMENT_SETUP) || '' }));
        var setupGroup = el('div', { className: 'ba-choices' });
        var setupChoices = [['SELF', 'セルフ設営　無料'], ['STAFF', '事前設営を依頼　+' + setupPrice + '（事前確認制）']];
        if (config.allowNone && !paidEquipment) setupChoices.push(['NONE', '設営は追加しない（申込済み・不要）']);
        setupChoices.forEach(function (pair) {
          var c = choice('bo-setup', pair[0], pair[1], 'radio', false);
          c.input.checked = state.setupService === pair[0] && (!paidEquipment || state.setupChosen);
          c.input.addEventListener('change', function () { state.setupService = pair[0]; state.setupChosen = true; render(); });
          setupGroup.appendChild(c.label);
        });
        root.appendChild(setupGroup);

        /* 片付け方法。機材レンタルでは設営方法と同様に必須（Issue #441。テーマ未選択でも選べる）。 */
        root.appendChild(el('p', { className: 'ba-field-help', text: paidEquipment ? '片付け方法（機材レンタルでは必須）' : '片付け（利用後）' }));
        var cleanupGroup = el('div', { className: 'ba-choices' });
        var cleanupChoices = [['SELF', '自分で原状復帰　無料'], ['STAFF', '片付けを依頼　+' + cleanupPrice + '（事前確認制）']];
        if (config.allowNone && !paidEquipment) cleanupChoices.push(['NONE', '片付けは追加しない（申込済み・不要）']);
        cleanupChoices.forEach(function (pair) {
          var c = choice('bo-cleanup', pair[0], pair[1], 'radio', false);
          c.input.checked = state.cleanupService === pair[0] && (!paidEquipment || state.cleanupChosen);
          c.input.addEventListener('change', function () { state.cleanupService = pair[0]; state.cleanupChosen = true; render(); });
          cleanupGroup.appendChild(c.label);
        });
        root.appendChild(cleanupGroup);

        if (state.layouts.length > 0) {
          /* 設営について申込前に相談できる導線（Issue #423 追加要件）。既存の問い合わせフォームへのリンクのみで、
             相談してもオプション注文・承認・Checkoutは一切作られない。別タブで開くので、相談後は
             このページに戻って通常の設営申込をそのまま続けられる。 */
          var consult = el('div', { className: 'ba-option-consult' }, [
            el('p', { className: 'ba-field-help', text: CONSULT_TEXT.lead }),
            el('p', { className: 'ba-field-help', text: CONSULT_TEXT.notice }),
            el('a', { className: 'ba-btn ba-btn-ghost', href: config.consultUrl || '../reservation/?intent=consult', target: '_blank', rel: 'noopener', text: CONSULT_TEXT.cta }),
            el('p', { className: 'ba-field-help', text: CONSULT_TEXT.back })
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
          root.appendChild(el('p', { className: 'ba-banner ba-banner--notice', text: (catalog.notices && catalog.notices.STAFF_SERVICE_APPROVAL) || '' }));
        } else {
          root.appendChild(el('p', { className: 'ba-field-help', text: 'セルフで設営・原状復帰する場合は無料で、スタッフの空き確認は不要です。選択後、予約案内に保管場所・セット方法・原状復帰方法を記載します。' }));
        }
      }

      /* メールサポート */
      root.appendChild(el('h3', { className: 'ba-option-heading', text: '無料サポート' }));
      var supportChoice = choice('bo-support', 'EMAIL_SUPPORT', 'メールサポート（無料）', 'checkbox', false);
      supportChoice.input.checked = state.emailSupport;
      supportChoice.input.addEventListener('change', function () { state.emailSupport = supportChoice.input.checked; });
      root.appendChild(el('div', { className: 'ba-choices' }, [supportChoice.label]));
      root.appendChild(el('p', { className: 'ba-field-help', text: (catalog.notices && catalog.notices.EMAIL_SUPPORT) || '' }));

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
        estimate ? el('p', { className: 'ba-field-help', text: '部屋代とオプションは別々にお支払いいただきます（決済は分かれます）。この総合計は合算表示です。' }) : null,
        el('p', { className: 'ba-field-help', text: 'スタッフ対応分は承認後、機材分は部屋の予約確定後にお支払いいただきます。申込済みのスタッフ対応がある場合は、セット価格との差額を表示しています。' })
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
    computeSummary: computeSummary,
    computeTotals: computeTotals,
    equipmentCardOnlyText: equipmentCardOnlyText,
    summarize: summarize,
    describeError: describeError,
    describeOrderStatus: describeOrderStatus,
    CONSULT_TEXT: CONSULT_TEXT,
    formatJpy: formatJpy
  };

  global.BookingOptionsPanel = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : this);
