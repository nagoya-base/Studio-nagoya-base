/*
 * scripts/membership-status.js — SNB MEMBER 会員資格確認（Issue #490）。
 * 1) メールアドレスだけをrequestMembershipStatusへ送る。応答は会員かどうかにかかわらず同一で、画面にも会員状態を出さない。
 * 2) メールのワンタイムリンク（URLフラグメント #t=トークン）を開いたときだけ、membershipStatusでトークンを送り、
 *    返ってきた会員状態を表示する。トークンはフラグメントのためサーバーログ・Refererに残らず、読んだら直ちにURLから消す。
 * 3) 会員資格が有効な通常会員には、確認の1段を挟んで「解約する」（action=cancelMembership）を出す（Issue #506）。
 *    解約用トークンは応答のメモリ上にだけ置き、URL・ストレージには書かない。
 * 表示する値はすべてtextContentで挿入する（HTMLとして解釈しない）。Stripe ID・内部IDはAPIが返さない。
 */
(function () {
  'use strict';

  var ERROR_TEXT = {
    INVALID_EMAIL: 'メールアドレスの形式が正しくありません。',
    RATE_LIMITED: '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。',
    INVALID_TOKEN: 'リンクが無効か、有効期限が切れています。お手数ですが、もう一度メールアドレスを入力してリンクを再発行してください。'
  };
  var CANCEL_ERROR_TEXT = {
    INVALID_TOKEN: '操作の有効期限が切れました。お手数ですが、もう一度メールアドレスを入力して確認用リンクを再発行してください。',
    RATE_LIMITED: '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。',
    CANCEL_UNAVAILABLE: '解約を受け付けられませんでした。しばらくしてから再度お試しください。解決しない場合は、予約フォームなどから運営へ「SNB MEMBER解約」と登録メールアドレスをご連絡ください。'
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

  function renderStatus(status, cancel) {
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
      renderCancelSection(status, cancel);
    } else {
      resultBlock.appendChild(el('p', 'このメールアドレスでは、現在の会員資格を確認できませんでした。加入は会員案内ページから行えます。', 'membership-note'));
    }
    requestBlock.hidden = true;
    resultBlock.hidden = false;
  }

  /* ===== 解約（Issue #506）。本人確認後の応答に解約操作が付いているときだけ表示する。 ===== */

  function renderCancelSection(status, cancel) {
    var state = cancel && cancel.state;
    if (!status.active || (state !== 'AVAILABLE' && state !== 'SCHEDULED')) return;
    var box = el('div', undefined, 'membership-cancel');
    box.id = 'membership-cancel';
    box.appendChild(el('h3', 'SNB MEMBERの解約', 'membership-heading'));
    if (state === 'SCHEDULED') {
      box.appendChild(el('p', '次回更新は停止済みです。' + formatDate(status.validUntil) + 'まで会員資格が有効です。', 'membership-status is-ok'));
    } else {
      box.appendChild(el('p', '解約すると、次回以降の自動更新を停止します。現在のお支払い済み期間の末日までは、SNB MEMBERをご利用いただけます。'));
      var open = el('button', 'SNB MEMBERを解約する', 'btn-secondary');
      open.type = 'button';
      open.addEventListener('click', function () { showConfirm(box, open, status, cancel.token); });
      box.appendChild(open);
    }
    box.appendChild(el('p', 'オンラインで解約できない場合は、予約フォームなどから運営へ「SNB MEMBER解約」と登録メールアドレスをご連絡ください。', 'membership-note'));
    resultBlock.appendChild(box);
  }

  function showConfirm(box, openButton, status, cancelToken) {
    openButton.hidden = true;
    var panel = el('div', undefined, 'membership-cancel-confirm');
    panel.setAttribute('role', 'group');
    panel.setAttribute('aria-label', '解約の確認');
    panel.appendChild(el('h4', '解約の内容をご確認ください', 'membership-heading'));
    var list = el('ul', undefined, 'membership-status-list');
    row(list, '会員資格の有効最終日', formatDate(status.validUntil));
    row(list, '解約後のご利用', '上記の日まで、これまでどおりご利用いただけます（すぐには失効しません）');
    row(list, '停止されるもの', '次回以降の自動更新のみ');
    row(list, '返金', '支払い済みの会費は、日割りを含め返金しません');
    panel.appendChild(list);
    var message = el('p', '', 'membership-status');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    var confirm = el('button', '解約を確定する', 'btn-primary');
    confirm.type = 'button';
    var back = el('button', 'やめる', 'btn-secondary');
    back.type = 'button';
    var busy = false;
    back.addEventListener('click', function () {
      if (busy) return;
      panel.remove();
      openButton.hidden = false;
    });
    confirm.addEventListener('click', function () {
      if (busy) return;
      busy = true;
      confirm.disabled = true;
      back.disabled = true;
      message.textContent = '解約を受け付けています…';
      message.className = 'membership-status is-ok';
      post('cancelMembership', { cancelToken: cancelToken })
        .then(function (result) {
          if (result && result.success === true && result.cancel) {
            renderCancelDone(box, result.cancel);
            return;
          }
          var code = result && result.error && result.error.code;
          message.textContent = CANCEL_ERROR_TEXT[code] || CANCEL_ERROR_TEXT.CANCEL_UNAVAILABLE;
          message.className = 'membership-status is-error';
          /* 一時的な失敗は再試行できる。トークンが無効・期限切れのときは再試行しても通らないため閉じる。 */
          if (code === 'INVALID_TOKEN') { busy = true; return; }
          busy = false;
          confirm.disabled = false;
          back.disabled = false;
        })
        .catch(function () {
          message.textContent = NETWORK_ERROR;
          message.className = 'membership-status is-error';
          busy = false;
          confirm.disabled = false;
          back.disabled = false;
        });
    });
    panel.appendChild(confirm);
    panel.appendChild(back);
    panel.appendChild(message);
    box.insertBefore(panel, openButton.nextSibling);
    confirm.focus();
  }

  function renderCancelDone(box, cancel) {
    box.textContent = '';
    box.appendChild(el('h3', cancel.alreadyScheduled ? '次回更新は停止済みです' : '解約手続きが完了しました', 'membership-heading'));
    var list = el('ul', undefined, 'membership-status-list');
    row(list, '次回以降の自動更新', '停止しました');
    row(list, '会員資格の有効最終日', formatDate(cancel.validUntil));
    row(list, 'ご利用', 'この日まで、これまでどおりご利用いただけます');
    box.appendChild(list);
    if (!cancel.alreadyScheduled) {
      box.appendChild(el('p', '登録メールアドレス宛に、同じ内容の確認メールをお送りしました。', 'membership-note'));
    }
    box.setAttribute('tabindex', '-1');
    box.focus();
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
          renderStatus(result.status, result.cancel);
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
