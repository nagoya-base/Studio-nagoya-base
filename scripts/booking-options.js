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
 *   （画面で選択できる＝申込が通る、ではない。ビデオライトのセルフレンタル資格等は
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
      setupService: layouts.length > 0 ? normalizeService(s.setupService) : 'SELF',
      cleanupService: layouts.length > 0 ? normalizeService(s.cleanupService) : 'SELF',
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

  /* 送信前のクライアント側チェック（最終判定はサーバー）。エラー文言 or ''。 */
  function validateSelection(state) {
    var s = state || {};
    var layouts = s.layouts || [];
    var staff = layouts.length > 0 && (s.setupService === 'STAFF' || s.cleanupService === 'STAFF');
    if (staff && layouts.length !== 1) {
      return 'スタッフ対応（有料）を依頼できるセッティングは1種類です。複数選ぶ場合は、残りをセルフ（無料）にするか、メールでご相談ください。';
    }
    return '';
  }

  /* 機材の合計（数量×単価の個別加算）。単価はカタログの値だけを使う。 */
  function equipmentTotalJpy(catalog, equipment) {
    var byCode = {};
    ((catalog && catalog.equipment) || []).forEach(function (e) { byCode[e.code] = e; });
    return Object.keys(equipment || {}).reduce(function (sum, code) {
      var e = byCode[code];
      return sum + (e ? Number(e.unitPriceJpy) * Number(equipment[code]) : 0);
    }, 0);
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
      var unit = e ? Number(e.unitPriceJpy) : 0;
      lines.push((e ? e.label : code) + (qty > 1 ? ' ×' + qty : '') + '（' + (unit > 0 ? formatJpy(unit * qty) : '無料') + '）');
    });
    var equipmentTotal = equipmentTotalJpy(catalog, selection.equipment);
    if (equipmentTotal > 0) lines.push('機材レンタル合計: ' + formatJpy(equipmentTotal) + '（個別加算。部屋のご予約確定後にお支払い）');
    var themeByCode = {};
    ((catalog && catalog.themes) || []).forEach(function (t) { themeByCode[t.code] = t; });
    selection.layouts.forEach(function (code) {
      lines.push((themeByCode[code] ? themeByCode[code].label : code) +
        '：設営=' + serviceLabel(selection.setupService) +
        '／片付け=' + serviceLabel(selection.cleanupService));
    });
    var staffPrice = staffServicePrice(catalog, selection.setupService, selection.cleanupService);
    if (selection.layouts.length > 0 && staffPrice) {
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
    var state = { equipment: {}, layouts: [], setupService: 'SELF', cleanupService: 'SELF', emailSupport: false };
    var controller = {
      isAvailable: function () { return !!(catalog && catalog.enabled); },
      getState: function () { return JSON.parse(JSON.stringify(state)); },
      getSelection: function () { return buildSelection(state); },
      validate: function () { return validateSelection(state); },
      summaryLines: function () { return summarize(catalog, state); },
      reset: function () { state = { equipment: {}, layouts: [], setupService: 'SELF', cleanupService: 'SELF', emailSupport: false }; render(); },
      setCatalog: function (next) { catalog = next; render(); },
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
        var priceText = item.unitPriceJpy > 0
          ? formatJpy(item.unitPriceJpy) + (item.unitLabel ? ' / ' + item.unitLabel : '')
          : '無料（セルフ）';
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
      var needsLecture = (catalog.equipment || []).some(function (e) { return e.requiresLecture && state.equipment[e.code]; });
      root.appendChild(el('p', { className: needsLecture ? 'ba-banner ba-banner--notice' : 'ba-field-help', text: 'ビデオライト系（定常光）のセルフレンタルは、対面で操作レクチャーを受け、利用許可済みの方のみ選択できます（初めての方・レクチャー未実施の方はメールでご相談ください）。ストロボ等に資格の制限はありません。' }));

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

      if (state.layouts.length > 0) {
        var staff = catalog.staffServices || {};
        var setupPrice = staff.PRE_SETUP ? formatJpy(staff.PRE_SETUP.priceJpy) : '';
        var cleanupPrice = staff.CLEANUP ? formatJpy(staff.CLEANUP.priceJpy) : '';
        root.appendChild(el('p', { className: 'ba-field-help', text: '設営（利用前）' }));
        var setupGroup = el('div', { className: 'ba-choices' });
        var setupChoices = [['SELF', 'セルフ設営　無料'], ['STAFF', '事前設営を依頼　+' + setupPrice + '（事前確認制）']];
        if (config.allowNone) setupChoices.push(['NONE', '設営は追加しない（申込済み・不要）']);
        setupChoices.forEach(function (pair) {
          var c = choice('bo-setup', pair[0], pair[1], 'radio', false);
          c.input.checked = state.setupService === pair[0];
          c.input.addEventListener('change', function () { state.setupService = pair[0]; render(); });
          setupGroup.appendChild(c.label);
        });
        root.appendChild(setupGroup);
        root.appendChild(el('p', { className: 'ba-field-help', text: '片付け（利用後）' }));
        var cleanupGroup = el('div', { className: 'ba-choices' });
        var cleanupChoices = [['SELF', '自分で原状復帰　無料'], ['STAFF', '片付けを依頼　+' + cleanupPrice + '（事前確認制）']];
        if (config.allowNone) cleanupChoices.push(['NONE', '片付けは追加しない（申込済み・不要）']);
        cleanupChoices.forEach(function (pair) {
          var c = choice('bo-cleanup', pair[0], pair[1], 'radio', false);
          c.input.checked = state.cleanupService === pair[0];
          c.input.addEventListener('change', function () { state.cleanupService = pair[0]; render(); });
          cleanupGroup.appendChild(c.label);
        });
        root.appendChild(cleanupGroup);

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

        var price = staffServicePrice(catalog, state.setupService, state.cleanupService);
        if (price) {
          root.appendChild(el('p', { className: 'ba-banner ba-banner--notice', text: price.label + '：' + formatJpy(price.priceJpy) + '（税込）' }));
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
    validateSelection: validateSelection,
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
