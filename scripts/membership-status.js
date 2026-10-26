/*
 * scripts/membership-status.js — SNB MEMBER 会員資格確認（Issue #490）。
 * 1) メールアドレスだけをrequestMembershipStatusへ送る。応答は会員かどうかにかかわらず同一で、画面にも会員状態を出さない。
 * 2) メールのワンタイムリンク（URLフラグメント #t=トークン）を開いたときだけ、membershipStatusでトークンを送り、
 *    返ってきた会員状態を表示する。トークンはフラグメントのためサーバーログ・Refererに残らず、読んだら直ちにURLから消す。
 * 表示する値はすべてtextContentで挿入する（HTMLとして解釈しない）。Stripe ID・内部IDはAPIが返さない。
 */
(function () {
  'use strict';

  var ERROR_TEXT = {
    INVALID_EMAIL: 'メールアドレスの形式が正しくありません。',
    RATE_LIMITED: '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。',
    INVALID_TOKEN: 'リンクが無効か、有効期限が切れています。お手数ですが、もう一度メールアドレスを入力してリンクを再発行してください。'
  };
  var GENERIC_ERROR = '会員資格を確認できませんでした。しばらくしてから再度お試しください。';
  var NETWORK_ERROR = '通信に失敗しました。時間をおいて再度お試しください。';

  var form = document.getElementById('membership-status-form');
  var requestBlock = document.getElementById('membership-status-request');
  var resultBlock = document.getElementById('membership-status-result');
  if (!form || !resultBlock) return;
  var emailInput = document.getElementById('membership-status-email');
  var submit = document.getElementById('membership-status-submit');
  var message = document.getElementById('membership-status-message');
  var apiBase = (window.BookingApiConfig && window.BookingApiConfig.BASE_URL) || '';
  var sending = false;

  function show(text, isError) {
    message.textContent = text;
    message.className = 'membership-status' + (isError ? ' is-error' : ' is-ok');
  }

  function post(action, body) {
    var endpoint = apiBase + (apiBase.indexOf('?') === -1 ? '?' : '&') + 'action=' + action;
    return fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body)
    }).then(function (response) { return response.json(); });
  }

  function formatDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    return m ? m[1] + '年' + parseInt(m[2], 10) + '月' + parseInt(m[3], 10) + '日' : '';
  }

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function row(list, label, value) {
    var item = el('li');
    item.appendChild(el('strong', label + '：'));
    item.appendChild(document.createTextNode(value));
    list.appendChild(item);
  }

  function renderStatus(status) {
    resultBlock.textContent = '';
    resultBlock.appendChild(el('h2', status.active ? '会員資格：有効' : '会員資格：無効', 'membership-heading'));
    var list = el('ul', undefined, 'membership-status-list');
    row(list, '登録メールアドレス', status.maskedEmail || '');
    row(list, '会員状態', status.active ? '有効' : '無効');
    if (status.active) {
      row(list, '有効期間（支払済み期間の末日）', formatDate(status.validUntil));
      row(list, '次回更新日', status.nextRenewalDate ? formatDate(status.nextRenewalDate) : '自動更新はありません（解約済み）');
    }
    row(list, '月額', (status.monthlyFeeJpy || 500) + '円（税込）');
    resultBlock.appendChild(list);

    if (status.active) {
      resultBlock.appendChild(el('h3', '利用できる特典', 'membership-heading'));
      var benefits = el('ul', undefined, 'membership-status-list');
      (status.benefits || []).forEach(function (b) {
        row(benefits, b.label, b.available ? '利用可' : formatDate(b.startsOn) + 'から');
      });
      resultBlock.appendChild(benefits);
    } else {
      resultBlock.appendChild(el('p', 'このメールアドレスでは、現在の会員資格を確認できませんでした。加入は会員案内ページから行えます。', 'membership-note'));
    }
    requestBlock.hidden = true;
    resultBlock.hidden = false;
  }

  function verifyFromFragment() {
    var match = /(?:^#|&)t=([A-Za-z0-9]{16,128})(?:&|$)/.exec(window.location.hash || '');
    if (!match) return false;
    var token = match[1];
    /* 読んだら直ちにURLから消す（履歴・共有・Refererにトークンを残さない）。 */
    try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch (e) { /* noop */ }
    if (!apiBase) { show(GENERIC_ERROR, true); return true; }
    show('会員資格を確認しています…', false);
    post('membershipStatus', { token: token })
      .then(function (result) {
        if (result && result.success === true && result.status) {
          show('', false);
          renderStatus(result.status);
          return;
        }
        var code = result && result.error && result.error.code;
        show(ERROR_TEXT[code] || GENERIC_ERROR, true);
      })
      .catch(function () { show(NETWORK_ERROR, true); });
    return true;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (sending) return;
    var email = (emailInput.value || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { show(ERROR_TEXT.INVALID_EMAIL, true); return; }
    if (!apiBase) { show(GENERIC_ERROR, true); return; }
    sending = true;
    submit.disabled = true;
    show('送信中です…', false);
    post('requestMembershipStatus', { email: email })
      .then(function (result) {
        if (result && result.success === true) {
          /* 会員かどうかにかかわらず同じ表示。会員状態はメールのリンクを開いた本人にだけ表示される。 */
          show('入力されたメールアドレス宛に、会員資格を確認するためのリンクをお送りしました（30分間有効・1回のみ）。メールをご確認ください。届かない場合は迷惑メールフォルダもご確認ください。', false);
        } else {
          var code = result && result.error && result.error.code;
          show(ERROR_TEXT[code] || GENERIC_ERROR, true);
        }
        sending = false;
        submit.disabled = false;
      })
      .catch(function () {
        show(NETWORK_ERROR, true);
        sending = false;
        submit.disabled = false;
      });
  });

  verifyFromFragment();
})();
