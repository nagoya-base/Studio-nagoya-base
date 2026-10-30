/*
 * scripts/booking-party.js — SNB mens 大人数利用（5〜7名。Issue #668）の承認後のお支払いページ（/mens/booking/party/）。
 *
 * - 既存の予約ID（bookingId）に紐づく。予約IDだけでは操作できず、登録メールとの一致をサーバー（GAS）が確認する。
 *   メールアドレスは画面のメモリ内にのみ保持し、localStorage等へ保存しない。
 * - 承認状態・確定料金・支払期限・支払い可否の判定は常にサーバー。ここは partySummary / startPartyCheckout を呼んで表示するだけ。
 * - 決済はサーバーが返した Stripe Checkout URL（https://checkout.stripe.com/）へ遷移するだけ。
 */
(function () {
  'use strict';

  var root = document.getElementById('booking-party-app');
  if (!root) return;

  var API_BASE_URL = (window.BookingApiConfig && window.BookingApiConfig.BASE_URL) || '';
  var CHECKOUT_URL_PATTERN = /^https:\/\/checkout\.stripe\.com\//;

  function $(id) { return document.getElementById(id); }

  var els = {
    form: $('bp-lookup-form'), bookingId: $('bp-booking-id'), email: $('bp-email'),
    lookupError: $('bp-lookup-error'), lookupSubmit: $('bp-lookup-submit'),
    detail: $('bp-detail'), dBookingId: $('bp-d-booking-id'), dDate: $('bp-d-date'), dPeople: $('bp-d-people'),
    dBase: $('bp-d-base'), dSurcharge: $('bp-d-surcharge'), dAmount: $('bp-d-amount'), dStatus: $('bp-d-status'),
    dDueRow: $('bp-d-due-row'), dDue: $('bp-d-due'),
    notice: $('bp-notice'), payError: $('bp-pay-error'), payWrap: $('bp-pay-wrap'), pay: $('bp-pay')
  };

  var session = { bookingId: '', email: '' };
  var busy = false;

  var STATUS_LABELS = {
    PENDING_APPROVAL: '運営の確認待ち（まだ確定していません・お支払いは不要です）',
    APPROVED: '承認済み・お支払い待ち',
    REJECTED: '承認されませんでした'
  };
  var NOTICE_BY_REASON = {
    LARGE_PARTY_NOT_APPROVED: '運営の承認後にお支払いいただけます。承認のご連絡をお待ちください。',
    LARGE_PARTY_PAYMENT_EXPIRED: 'お支払い期限（承認から24時間）を過ぎたため、このご予約は不成立となります。お手数ですが改めてお申し込みください。'
  };
  /* error.code → 利用者向け文言（サーバーのerror.messageは表示しない）。 */
  var ERROR_COPY = {
    FORBIDDEN: '予約IDまたはメールアドレスが一致しません。ご登録の内容をご確認ください。',
    RATE_LIMITED: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。',
    LOCK_TIMEOUT: '一時的に混み合っています。もう一度お試しください。',
    CHECKOUT_DISABLED: '現在オンライン決済は受け付けていません。ご案内をお待ちください。',
    STRIPE_NOT_CONFIGURED: '現在オンライン決済をご利用いただけません。しばらくしてから再度お試しください。',
    ALREADY_PAID: 'このご予約はお支払い済みです。確定のご案内メールをお待ちください。',
    LARGE_PARTY_NOT_APPROVED: NOTICE_BY_REASON.LARGE_PARTY_NOT_APPROVED,
    LARGE_PARTY_PAYMENT_EXPIRED: NOTICE_BY_REASON.LARGE_PARTY_PAYMENT_EXPIRED,
    BOOKING_NOT_PENDING: 'このご予約はお支払い待ちの状態ではありません。'
  };
  var GENERIC_ERROR = 'お手続きを処理できませんでした。時間を置いて再度お試しください。';

  function show(node, text) {
    if (!node) return;
    node.textContent = text || '';
    node.hidden = !text;
  }

  function formatJpy(amount) {
    return amount === null || amount === undefined || amount === '' ? '' : Number(amount).toLocaleString('ja-JP') + '円';
  }

  function formatDue(value) {
    var d = value ? new Date(value) : null;
    return d && !isNaN(d.getTime()) ? d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '';
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
    els.pay.disabled = next;
  }

  function render(summary) {
    var b = summary.booking || {};
    els.dBookingId.textContent = b.bookingId || '';
    els.dDate.textContent = b.date || '';
    els.dPeople.textContent = b.people || '';
    els.dBase.textContent = formatJpy(b.baseAmount);
    els.dSurcharge.textContent = formatJpy(b.partySurcharge);
    els.dAmount.textContent = formatJpy(b.amount);
    var statusText = b.paid ? 'お支払い済み' : (b.status === 'CONFIRMED' ? '確定' : (b.status === 'CANCELLED' || b.status === 'EXPIRED' ? '不成立（枠は解除されました）' : (STATUS_LABELS[b.approvalStatus] || '')));
    els.dStatus.textContent = statusText;
    var due = formatDue(b.paymentDueAt);
    els.dDue.textContent = due;
    els.dDueRow.hidden = !due;
    show(els.notice, summary.payable ? '' : (NOTICE_BY_REASON[summary.payableReason] || ''));
    els.payWrap.hidden = !summary.payable;
    show(els.payError, '');
    els.detail.hidden = false;
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
    show(els.lookupError, '');
    setBusy(true);
    post('partySummary', session)
      .then(function (body) {
        if (!body || body.success !== true) {
          els.detail.hidden = true;
          show(els.lookupError, ERROR_COPY[body && body.error && body.error.code] || GENERIC_ERROR);
          return;
        }
        render(body);
      })
      .catch(function () { show(els.lookupError, '通信に失敗しました。時間を置いて再度お試しください。'); })
      .then(function () { setBusy(false); });
  });

  els.pay.addEventListener('click', function () {
    if (busy) return;
    show(els.payError, '');
    setBusy(true);
    post('startPartyCheckout', session)
      .then(function (body) {
        if (body && body.success === true && typeof body.checkoutUrl === 'string' && CHECKOUT_URL_PATTERN.test(body.checkoutUrl)) {
          window.location.href = body.checkoutUrl;
          return;
        }
        show(els.payError, ERROR_COPY[body && body.error && body.error.code] || GENERIC_ERROR);
        setBusy(false);
      })
      .catch(function () {
        show(els.payError, '通信に失敗しました。お支払いが完了していないか、メールをご確認のうえ再度お試しください。');
        setBusy(false);
      });
  });

  /* メール内リンク（?bookingId=...）からの遷移では予約IDだけ入力済みにする（メールは入力してもらう）。 */
  try {
    var prefill = new URLSearchParams(window.location.search).get('bookingId');
    if (prefill && prefill.length <= 64) els.bookingId.value = prefill;
  } catch (e) { /* URLSearchParams非対応環境では何もしない */ }
})();
