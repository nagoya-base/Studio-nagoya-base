/*
 * scripts/membership-join.js — SNB MEMBER入会フォーム（Issue #472）。
 * メールアドレスだけをBooking Web Appの startMembershipCheckout（Issue #471）へ送る。
 * 応答は常に同じ形・同じ文言で返る仕様のため、このスクリプトも「会員かどうか」を推測させる表示をしない。
 * 決済URLはサーバーが入力されたメールアドレス宛にだけ送る（画面には出さない）。
 */
(function () {
  'use strict';

  var ERROR_TEXT = {
    INVALID_EMAIL: 'メールアドレスの形式が正しくありません。',
    CHECKOUT_DISABLED: '現在、オンラインでの入会受付は行っていません。受付を開始しましたら、このページでお知らせします。',
    RATE_LIMITED: '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。'
  };
  var GENERIC_ERROR = '入会の受付を開始できませんでした。しばらくしてから再度お試しください。';
  var NETWORK_ERROR = '通信に失敗しました。時間をおいて再度お試しください。（お支払い済みの場合は、二重のお支払いはお控えください）';

  var form = document.getElementById('membership-join-form');
  if (!form) return;
  var emailInput = document.getElementById('membership-email');
  var consent = document.getElementById('membership-consent');
  var submit = document.getElementById('membership-join-submit');
  var status = document.getElementById('membership-join-status');
  var apiBase = (window.BookingApiConfig && window.BookingApiConfig.BASE_URL) || '';
  var sending = false;

  function show(message, isError) {
    status.textContent = message;
    status.className = 'membership-status' + (isError ? ' is-error' : ' is-ok');
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sending) return;
    var email = (emailInput.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { show(ERROR_TEXT.INVALID_EMAIL, true); return; }
    if (!consent.checked) { show('条件への同意にチェックを入れてください。', true); return; }
    if (!apiBase) { show(GENERIC_ERROR, true); return; }

    sending = true;
    submit.disabled = true;
    show('送信中です…', false);
    var endpoint = apiBase + (apiBase.indexOf('?') === -1 ? '?' : '&') + 'action=startMembershipCheckout';
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ email: email })
    })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (result && result.success === true) {
          show('入力されたメールアドレス宛に、入会のご案内をお送りしました。メールに記載のお支払いページ（35分間有効）から手続きを完了してください。メールが届かない場合は、迷惑メールフォルダもご確認ください。', false);
          return;
        }
        var code = result && result.error && result.error.code;
        show(ERROR_TEXT[code] || GENERIC_ERROR, true);
        sending = false;
        submit.disabled = false;
      })
      .catch(function () {
        show(NETWORK_ERROR, true);
        sending = false;
        submit.disabled = false;
      });
  });
})();
