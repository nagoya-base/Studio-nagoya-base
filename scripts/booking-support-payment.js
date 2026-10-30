/*
 * scripts/booking-support-payment.js — 作品撮りサポートプラン（SNB mens。Issue #667）のお支払いページ。
 *
 * 運営の承認後に届くメールのリンク（/mens/booking/support-payment/?b=<予約ID>#t=<決済開始トークン>）から開く。
 * トークンはURLのフラグメントで受け取り、読み取ったらすぐ履歴から消す（サーバーログ・Referer・GA4へ送らない）。
 * 既存のstartCardCheckout（BookingRepository.beginCardCheckout）へ予約IDとトークンだけを送り、返ったStripe Checkout（https）へ遷移する。
 * 承認前・承認後24時間経過後のお支払いの可否はサーバーが判定して拒否する（ここでは案内文言を出すだけ。金額は一切扱わない）。
 */
(function () {
  'use strict';

  var CODE_MESSAGES = {
    SUPPORT_NOT_APPROVED: '運営の承認前のため、まだお支払いいただけません。承認のご連絡メールをお待ちください。',
    SUPPORT_PAYMENT_EXPIRED: 'お支払い期限（承認後24時間）を過ぎたため、お支払いいただけません。お手数ですが、改めてお申し込みください。',
    BOOKING_NOT_PENDING: 'この予約は、お支払い待ちの状態ではありません（すでに確定・不成立となっている可能性があります）。',
    ALREADY_PAID: 'この予約は、すでにお支払い処理が完了しています。二重にお支払いいただく必要はありません。',
    FORBIDDEN: 'お支払いページを開けませんでした。承認メールのリンクからもう一度お開きください。',
    CHECKOUT_DISABLED: '現在オンライン決済を開始できません。運営までご連絡ください。',
    STRIPE_NOT_CONFIGURED: '現在オンライン決済を開始できません。運営までご連絡ください。'
  };
  var GENERIC_MESSAGE = 'お支払いページを開始できませんでした。時間をおいてもう一度お試しいただくか、運営までご連絡ください。お支払い済みの場合は、二重にお支払いしないでください。';

  function parseBookingId(search) {
    var m = /[?&]b=([^&#]+)/.exec(search || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
  }

  function parseToken(hash) {
    var m = /(?:^#|&)t=([^&]+)/.exec(hash || '');
    if (!m) return '';
    try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
  }

  function messageForCode(code) {
    return Object.prototype.hasOwnProperty.call(CODE_MESSAGES, code) ? CODE_MESSAGES[code] : GENERIC_MESSAGE;
  }

  /* Stripe Checkoutへの遷移先はhttpsのみ許可する（想定外のスキームへは遷移しない）。 */
  function isSafeCheckoutUrl(url) {
    return typeof url === 'string' && /^https:\/\/[^\s]+$/.test(url);
  }

  var api = { parseBookingId: parseBookingId, parseToken: parseToken, messageForCode: messageForCode, isSafeCheckoutUrl: isSafeCheckoutUrl };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  window.BookingSupportPayment = api;

  var button = document.getElementById('support-payment-start');
  var errorEl = document.getElementById('support-payment-error');
  var statusEl = document.getElementById('support-payment-status');
  if (!button) return;

  var bookingId = parseBookingId(window.location.search);
  var token = parseToken(window.location.hash);
  /* トークンは読み取り後すぐURLから消す（履歴・共有・GA4へ残さない）。 */
  try {
    if (token) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  } catch (e) { /* 消せなくても動作は変わらない */ }

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
  }

  var baseUrl = window.BookingApiConfig && window.BookingApiConfig.BASE_URL;
  if (!bookingId || !token || !baseUrl) {
    showError(messageForCode('FORBIDDEN'));
    return;
  }
  button.disabled = false;

  var busy = false;
  button.addEventListener('click', function () {
    if (busy) return;
    busy = true;
    button.disabled = true;
    showError('');
    if (statusEl) { statusEl.textContent = 'お支払いページを準備しています…'; statusEl.hidden = false; }
    fetch(baseUrl + (baseUrl.indexOf('?') === -1 ? '?' : '&') + 'action=startCardCheckout', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ bookingId: bookingId, checkoutAccessToken: token })
    })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (result && result.success === true && isSafeCheckoutUrl(result.checkoutUrl)) {
          window.location.href = result.checkoutUrl;
          return;
        }
        busy = false;
        button.disabled = false;
        if (statusEl) statusEl.hidden = true;
        showError(messageForCode(result && result.error && result.error.code));
      })
      .catch(function () {
        busy = false;
        button.disabled = false;
        if (statusEl) statusEl.hidden = true;
        showError(GENERIC_MESSAGE);
      });
  });
})();
