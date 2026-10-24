/*
 * scripts/booking-options-addon.js — 既存予約へのオプション後付け・追加決済の案内ページ
 * （Issue #423。studio-x/booking/options/。Studio Xのみ）。
 *
 * - 既存の予約ID（bookingId）を維持する。新しい部屋予約は作らない。
 * - 予約IDだけでは操作できない。登録メールアドレスとの一致をサーバー（GAS）が確認する。
 *   メールアドレスは入力した画面のメモリ内にのみ保持し、localStorage等へは保存しない。
 * - 金額・承認状態・決済可否は常にサーバーの応答をそのまま表示する。画面で決めない。
 * - 決済はサーバーが返したStripe Checkout URL（https://checkout.stripe.com/）へ遷移するだけ。
 */
(function () {
  'use strict';

  var root = document.getElementById('booking-options-app');
  var Panel = window.BookingOptionsPanel;
  if (!root || !Panel) return;

  var API_BASE_URL = (window.BookingApiConfig && window.BookingApiConfig.BASE_URL) || '';
  var CHECKOUT_URL_PATTERN = /^https:\/\/checkout\.stripe\.com\//;

  function $(id) { return document.getElementById(id); }

  var els = {
    form: $('bo-lookup-form'),
    bookingId: $('bo-booking-id'),
    email: $('bo-email'),
    lookupError: $('bo-lookup-error'),
    lookupSubmit: $('bo-lookup-submit'),
    detail: $('bo-detail'),
    dBookingId: $('bo-d-booking-id'),
    dDate: $('bo-d-date'),
    dTime: $('bo-d-time'),
    dStatus: $('bo-d-status'),
    orders: $('bo-orders'),
    payNotice: $('bo-pay-notice'),
    payError: $('bo-pay-error'),
    add: $('bo-add'),
    panelSlot: $('bo-panel-slot'),
    summarySlot: $('bo-summary-slot'),
    submitError: $('bo-submit-error'),
    submitMessage: $('bo-submit-message'),
    submit: $('bo-submit'),
    addClosed: $('bo-add-closed')
  };

  var panel = null;
  var session = { bookingId: '', email: '' };
  var busy = false;

  var BOOKING_STATUS_LABELS = {
    PENDING: '仮予約（確定連絡待ち）',
    CONFIRMED: '確定',
    CANCELLED: '取消',
    EXPIRED: '期限切れ'
  };

  var CLOSED_REASONS = {
    BOOKING_NOT_ELIGIBLE: 'この予約は取消済み・期限切れのため、オプションを追加できません。',
    BOOKING_ALREADY_STARTED: '利用開始後の予約にはオプションを追加できません。',
    ADDON_DEADLINE_PASSED: 'オプションの申込締切を過ぎています。メールでご相談ください。',
    OPTIONS_NOT_AVAILABLE: 'この予約ではオプションをお申し込みいただけません。'
  };

  function show(node, text) {
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  }

  function post(action, payload) {
    var url = API_BASE_URL + (API_BASE_URL.indexOf('?') === -1 ? '?' : '&') + 'action=' + action;
    return fetch(url, {
      method: 'POST',
      /* GAS Web AppのCORS制約のためtext/plainで送る（scripts/booking-app.jsと同じ）。 */
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (response) { return response.json(); });
  }

  function setBusy(next) {
    busy = next;
    els.lookupSubmit.disabled = next;
    els.submit.disabled = next;
    Array.prototype.forEach.call(els.orders.querySelectorAll('button'), function (b) { b.disabled = next; });
  }

  function renderOrders(summary) {
    els.orders.textContent = '';
    var orders = summary.orders || [];
    if (orders.length === 0) {
      var none = document.createElement('p');
      none.textContent = 'お申し込み済みのオプションはありません。';
      els.orders.appendChild(none);
      return;
    }
    orders.forEach(function (order) {
      var box = document.createElement('div');
      box.className = 'ba-banner ba-banner--notice';
      var title = document.createElement('p');
      title.textContent = (order.items || []).map(function (item) { return item.label; }).join('、');
      var meta = document.createElement('p');
      meta.textContent = '注文ID: ' + order.optionOrderId + '／' + (order.amountJpy > 0 ? Panel.formatJpy(order.amountJpy) + '（税込）' : '無料') +
        '／' + Panel.describeOrderStatus(order);
      box.appendChild(title);
      box.appendChild(meta);
      /* お支払いに進めるのは、サーバーが「支払い可能」とした注文で、かつ部屋予約が確定している場合のみ。 */
      if (order.payable && summary.canPayNow) {
        var pay = document.createElement('button');
        pay.type = 'button';
        pay.className = 'ba-btn ba-btn-primary';
        pay.textContent = 'お支払いに進む（' + Panel.formatJpy(order.amountJpy) + '）';
        pay.addEventListener('click', function () { startCheckout(order.optionOrderId); });
        box.appendChild(pay);
      }
      els.orders.appendChild(box);
    });
    var hasPayableBeforeConfirm = orders.some(function (o) { return o.payable; }) && !summary.canPayNow;
    show(els.payNotice, hasPayableBeforeConfirm ? 'お支払いは、ご予約の確定後に行えます。確定のご連絡をお待ちください。' : '');
  }

  /* 予約済みの部屋代（サーバーが予約本体から返した値）。取得できなければnull扱いで、サマリーに部屋代を出さない。 */
  var bookedRoomPriceJpy = null;
  function currentRoomPrice() {
    return { kind: 'booked', status: bookedRoomPriceJpy === null ? 'unavailable' : 'ok', amountJpy: bookedRoomPriceJpy };
  }

  function renderSummary(summary) {
    els.detail.hidden = false;
    var booking = summary.booking || {};
    bookedRoomPriceJpy = booking.roomPriceJpy !== null && booking.roomPriceJpy !== undefined && Number.isFinite(Number(booking.roomPriceJpy)) ? Number(booking.roomPriceJpy) : null;
    els.dBookingId.textContent = booking.bookingId || '';
    els.dDate.textContent = booking.date || '';
    els.dTime.textContent = booking.startTime ? booking.startTime + '〜' + (booking.endTime || '') : '';
    els.dStatus.textContent = BOOKING_STATUS_LABELS[booking.status] || booking.status || '';
    renderOrders(summary);

    show(els.payError, '');
    if (summary.acceptsOptions && summary.catalog && summary.catalog.enabled) {
      els.add.hidden = false;
      els.addClosed.hidden = true;
      if (!panel) {
        /* 後付けでは、申込済みの項目を「追加しない」と選べる（allowNone）。 */
        panel = Panel.mount({ slot: els.panelSlot, summarySlot: $('bo-summary-slot'), getRoomPrice: currentRoomPrice, catalog: summary.catalog, allowNone: true, equipmentPageUrl: '../../equipment/', consultUrl: '../../reservation/?intent=consult' });
      } else {
        panel.setCatalog(summary.catalog);
      }
      /* 申込済みのスタッフ対応を加味して、画面の追加請求額をサーバー（computeStaffServiceCharge）と一致させる。 */
      panel.setExistingOrders(summary.orders || []);
      panel.refreshSummary();
    } else {
      els.add.hidden = true;
      show(els.addClosed, CLOSED_REASONS[summary.acceptsOptionsReason] || 'この予約にはオプションを追加できません。');
    }
  }

  function lookup(keepMessage) {
    show(els.lookupError, '');
    return post('optionSummary', { bookingId: session.bookingId, email: session.email })
      .then(function (body) {
        if (!body || body.success !== true) {
          els.detail.hidden = true;
          var code = body && body.error && body.error.code;
          show(els.lookupError, code === 'FORBIDDEN'
            ? '予約IDまたはメールアドレスが一致しません。ご登録の内容をご確認ください。'
            : Panel.describeError(body && body.error));
          return false;
        }
        renderSummary(body);
        if (!keepMessage) show(els.submitMessage, '');
        return true;
      })
      .catch(function () {
        show(els.lookupError, '通信に失敗しました。時間を置いて再度お試しください。');
        return false;
      });
  }

  els.form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (busy) return;
    var bookingId = els.bookingId.value.trim();
    var email = els.email.value.trim();
    if (!bookingId || !email) {
      show(els.lookupError, '予約IDとメールアドレスを入力してください。');
      return;
    }
    session = { bookingId: bookingId, email: email };
    setBusy(true);
    lookup(false).then(function () { setBusy(false); });
  });

  els.submit.addEventListener('click', function () {
    if (busy || !panel) return;
    show(els.submitError, '');
    show(els.submitMessage, '');
    var problem = panel.validate();
    if (problem) { show(els.submitError, problem); return; }
    var selection = panel.getSelection();
    if (!selection) { show(els.submitError, '追加するオプションを選択してください。'); return; }
    setBusy(true);
    post('submitOptions', { bookingId: session.bookingId, email: session.email, options: selection })
      .then(function (body) {
        if (!body || body.success !== true) {
          show(els.submitError, Panel.describeError(body && body.error));
          return null;
        }
        panel.reset();
        show(els.submitMessage, 'オプションのお申し込みを受け付けました。スタッフ対応（有料）は承認待ちで、まだ確定していません。状況はこのページとメールでご案内します。');
        return lookup(true);
      })
      .catch(function () { show(els.submitError, '通信に失敗しました。時間を置いて再度お試しください。'); })
      .then(function () { setBusy(false); });
  });

  function startCheckout(optionOrderId) {
    if (busy) return;
    show(els.payError, '');
    setBusy(true);
    post('startOptionCheckout', { bookingId: session.bookingId, email: session.email, optionOrderId: optionOrderId })
      .then(function (body) {
        if (body && body.success === true && typeof body.checkoutUrl === 'string' && CHECKOUT_URL_PATTERN.test(body.checkoutUrl)) {
          window.location.href = body.checkoutUrl;
          return;
        }
        show(els.payError, Panel.describeError(body && body.error));
        setBusy(false);
      })
      .catch(function () {
        show(els.payError, '通信に失敗しました。お支払いが完了していないか、メールをご確認のうえ再度お試しください。');
        setBusy(false);
      });
  }

  /* メール内リンク（?bookingId=...）からの遷移では予約IDだけ入力済みにする（メールは入力してもらう）。 */
  try {
    var params = new URLSearchParams(window.location.search);
    var prefill = params.get('bookingId');
    if (prefill && prefill.length <= 64) els.bookingId.value = prefill;
  } catch (e) { /* URLSearchParams非対応環境では何もしない */ }
})();
