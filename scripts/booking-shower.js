/*
 * scripts/booking-shower.js — 会員限定シャワー（Issue #478／#481）の利用希望・お支払いページ
 * （/booking/options/ ＝ SNB、/mens/booking/options/ ＝ SNB mens）。
 *
 * - 既存の予約ID（bookingId）に紐づく。新しい部屋予約は作らない。予約IDだけでは操作できず、登録メールとの
 *   一致をサーバー（GAS）が確認する。メールアドレスは画面のメモリ内にのみ保持し、localStorage等へ保存しない。
 * - 金額・会員資格・支払い可否の判定は常にサーバー。ここは optionSummary / submitOptions / startOptionCheckout を
 *   呼んで結果を表示するだけで、会員の有無を推測させる出し分けをしない（資格関連の拒否は同一メッセージ）。
 * - 決済はサーバーが返した Stripe Checkout URL（https://checkout.stripe.com/）へ遷移するだけ。
 */
(function () {
  'use strict';

  var root = document.getElementById('booking-shower-app');
  if (!root) return;

  var API_BASE_URL = (window.BookingApiConfig && window.BookingApiConfig.BASE_URL) || '';
  var CHECKOUT_URL_PATTERN = /^https:\/\/checkout\.stripe\.com\//;
  var SHOWER_CODE = 'SHOWER';

  function $(id) { return document.getElementById(id); }

  var els = {
    form: $('bs-lookup-form'), bookingId: $('bs-booking-id'), email: $('bs-email'),
    lookupError: $('bs-lookup-error'), lookupSubmit: $('bs-lookup-submit'),
    detail: $('bs-detail'), dBookingId: $('bs-d-booking-id'), dDate: $('bs-d-date'), dTime: $('bs-d-time'), dStatus: $('bs-d-status'),
    orders: $('bs-orders'), payNotice: $('bs-pay-notice'), payError: $('bs-pay-error'),
    add: $('bs-add'), submit: $('bs-submit'), submitError: $('bs-submit-error'), submitMessage: $('bs-submit-message'),
    addClosed: $('bs-add-closed')
  };

  var session = { bookingId: '', email: '' };
  var busy = false;

  var BOOKING_STATUS_LABELS = { PENDING: '仮予約（確定連絡待ち）', CONFIRMED: '確定', CANCELLED: '取消', EXPIRED: '期限切れ' };
  var ORDER_STATUS_LABELS = {
    PENDING_APPROVAL: '運営の確認待ち（まだ利用確定ではありません・お支払いは不要です）',
    AWAITING_PAYMENT: '承認済み・お支払い待ち', PAYMENT_PENDING: 'お支払い手続き中', CONFIRMED: '確定（お支払い済み）',
    DECLINED: 'お受けできませんでした', CANCELLED: '取消'
  };
  var CLOSED_REASONS = {
    BOOKING_NOT_ELIGIBLE: 'この予約は取消済み・期限切れのため、オプションを追加できません。',
    BOOKING_ALREADY_STARTED: '利用開始後の予約にはオプションを追加できません。',
    ADDON_DEADLINE_PASSED: 'オプションの申込締切を過ぎています。メールでご相談ください。',
    OPTIONS_NOT_AVAILABLE: 'この予約ではオプションをお申し込みいただけません。'
  };
  /* error.code → 利用者向け文言（サーバーのerror.messageは表示しない）。資格関連は常に同一文言。 */
  var ERROR_COPY = {
    MEMBER_BENEFIT_NOT_AVAILABLE: 'この特典は、ご利用日がお支払い済みの有効期間に入るSNB MEMBER会員資格を確認できた場合のみご利用いただけます。ご予約のメールアドレスは会員登録と同じものをご入力ください。次回更新前の未払いの期間は、更新の決済が成功してから確定できます。',
    OPTIONS_NOT_AVAILABLE: 'この予約ではシャワーをお申し込みいただけません（会員限定シャワーは、ご利用日が2026年12月1日以降の予約でお申し込みいただけます）。',
    APPROVAL_REQUIRED: 'シャワー利用は事前確認が必要です。運営の承認後にお支払いいただけます。承認をお待ちください。',
    ORDER_DECLINED: 'このシャワー利用は対応できませんでした。',
    DUPLICATE_OPTION: 'シャワーは1予約につき1回までです。既にお申し込み済みです。',
    FORBIDDEN: '予約IDまたはメールアドレスが一致しません。ご登録の内容をご確認ください。',
    RATE_LIMITED: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。',
    LOCK_TIMEOUT: '一時的に混み合っています。もう一度お試しください。',
    CHECKOUT_DISABLED: '現在オンライン決済は受け付けていません。ご案内をお待ちください。',
    CHECKOUT_NOT_CONFIGURED: '現在オンライン決済をご利用いただけません。しばらくしてから再度お試しください。',
    BOOKING_NOT_CONFIRMED: 'ご予約の確定後にお支払いいただけます。',
    ALREADY_PAID: 'このオプションはお支払い済みです。確定のご案内メールをお待ちください。',
    NOT_PAYABLE: 'このオプションはお支払いの対象ではありません。',
    ORDER_NOT_FOUND: '対象のお申し込みが見つかりません。',
    CHECKOUT_LOOKUP_FAILED: '決済ページを確認できませんでした。しばらくしてから再度お試しください。',
    CHECKOUT_FAILED: '決済ページを作成できませんでした。しばらくしてから再度お試しください。',
    CHECKOUT_UNCERTAIN: '決済ページの作成結果を確認できませんでした。しばらくしてから再度お試しください。二重にお支払いにならないよう、同じ手順で再度ご案内します。',
    BOOKING_NOT_FOUND: '予約が見つかりません。',
    BOOKING_ALREADY_STARTED_ERR: '利用開始後の予約にはオプションを追加できません。'
  };
  var GENERIC_ERROR = 'お手続きを処理できませんでした。時間を置いて再度お試しください。';

  function describeError(error) {
    var code = error && error.code;
    return ERROR_COPY[code] || CLOSED_REASONS[code] || GENERIC_ERROR;
  }

  function show(node, text) {
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  }

  function formatJpy(amount) {
    return Number(amount).toLocaleString('ja-JP') + '円';
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

  function isShowerOrder(order) {
    return (order.items || []).some(function (item) { return item.code === SHOWER_CODE; });
  }

  function isActiveShower(order) {
    return isShowerOrder(order) && order.status !== 'DECLINED' && order.status !== 'CANCELLED';
  }

  function renderOrders(summary) {
    els.orders.textContent = '';
    var orders = (summary.orders || []).filter(isShowerOrder);
    if (orders.length === 0) {
      var none = document.createElement('p');
      none.textContent = 'お申し込み済みのオプションはありません。';
      els.orders.appendChild(none);
      show(els.payNotice, '');
      return;
    }
    orders.forEach(function (order) {
      var box = document.createElement('div');
      box.className = 'ba-banner ba-banner--notice';
      var title = document.createElement('p');
      title.textContent = (order.items || []).map(function (item) { return item.label; }).join('、');
      var meta = document.createElement('p');
      meta.textContent = '注文ID: ' + order.optionOrderId + '／' + formatJpy(order.amountJpy) + '（税込）／' + (ORDER_STATUS_LABELS[order.status] || order.status);
      box.appendChild(title);
      box.appendChild(meta);
      /* お支払いに進めるのは、サーバーが「支払い可能」とした注文で、かつ部屋予約が確定している場合のみ。 */
      if (order.payable && summary.canPayNow) {
        var pay = document.createElement('button');
        pay.type = 'button';
        pay.className = 'ba-btn ba-btn-primary';
        pay.textContent = 'お支払いに進む（' + formatJpy(order.amountJpy) + '）';
        pay.addEventListener('click', function () { startCheckout(order.optionOrderId); });
        box.appendChild(pay);
      }
      els.orders.appendChild(box);
    });
    var waiting = orders.some(function (o) { return o.payable; }) && !summary.canPayNow;
    var pending = orders.some(function (o) { return o.status === 'PENDING_APPROVAL'; });
    show(els.payNotice, waiting ? 'お支払いは、ご予約の確定後に行えます。確定のご連絡をお待ちください。'
      : (pending ? '運営の承認後にお支払いいただけます。承認のご連絡をお待ちください。' : ''));
  }

  function renderSummary(summary) {
    els.detail.hidden = false;
    var booking = summary.booking || {};
    els.dBookingId.textContent = booking.bookingId || '';
    els.dDate.textContent = booking.date || '';
    els.dTime.textContent = booking.startTime ? booking.startTime + '〜' + (booking.endTime || '') : '';
    els.dStatus.textContent = BOOKING_STATUS_LABELS[booking.status] || booking.status || '';
    renderOrders(summary);
    show(els.payError, '');

    var hasActiveShower = (summary.orders || []).some(isActiveShower);
    var catalog = summary.catalog || {};
    if (summary.acceptsOptions && catalog.enabled && catalog.showerOnly && !hasActiveShower) {
      els.add.hidden = false;
      els.addClosed.hidden = true;
    } else {
      els.add.hidden = true;
      var reason = !summary.acceptsOptions
        ? (CLOSED_REASONS[summary.acceptsOptionsReason] || 'この予約にはオプションを追加できません。')
        : (hasActiveShower ? '' : 'この予約ではシャワーをお申し込みいただけません。');
      show(els.addClosed, reason);
    }
  }

  function lookup(keepMessage) {
    show(els.lookupError, '');
    return post('optionSummary', { bookingId: session.bookingId, email: session.email })
      .then(function (body) {
        if (!body || body.success !== true) {
          els.detail.hidden = true;
          show(els.lookupError, describeError(body && body.error));
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
    if (busy) return;
    show(els.submitError, '');
    show(els.submitMessage, '');
    setBusy(true);
    post('submitOptions', { bookingId: session.bookingId, email: session.email, options: { shower: true } })
      .then(function (body) {
        if (!body || body.success !== true) {
          show(els.submitError, describeError(body && body.error));
          return null;
        }
        show(els.submitMessage, 'シャワーの利用希望を受け付けました。まだ利用確定ではありません。運営が対応可否を確認し、承認された場合のみご案内します。承認後に、このページからお支払いください。');
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
        show(els.payError, describeError(body && body.error));
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
