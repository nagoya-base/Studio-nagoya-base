/*
 * scripts/feedback-app.js — 3ブランド利用後アンケート（Issue #835）の回答画面。
 *
 * - 設問・選択肢・検証は scripts/feedback-core.js（GASと同一ファイル）から読む。ここに設問文を書かない。
 * - ブランドはページのパス /feedback/<brand>/ から決める（<div data-brand> と一致しなければ表示しない）。
 * - ?test=1 のときだけテストモード（is_test=1 で保存・通知なし・何度でも回答可）。
 * - 本番用トークンは #t=... のフラグメントからだけ読み、読んだ直後にURLから消す（履歴・共有・リファラに残さない）。
 * - 描画は textContent と DOM 生成のみ（HTML文字列として解釈させない）。GA4 等の解析タグは読み込まない。
 */
(function () {
  'use strict';

  var Core = window.FeedbackCore;
  var root = document.getElementById('feedback-app');
  if (!root || !Core) return;

  var config = window.FeedbackApiConfig || {};
  var loc = Core.parseLocation(window.location.pathname, window.location.search, window.location.hash);
  var token = loc.token;
  if (window.location.hash && window.history && window.history.replaceState) {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  var brand = loc.brand && root.getAttribute('data-brand') === loc.brand ? Core.getBrand(loc.brand) : null;
  var answers = { q1: '', q2: {}, q3: {}, q4: '', q4_rating: '', q5: [], q6: '', comment: '' };
  var isSubmitting = false;

  var MESSAGES = {
    TOKEN_USED: 'このリンクからは既に回答をいただいています。ご協力ありがとうございました。',
    TOKEN_EXPIRED: '回答の受付期間（ご利用後14日間）を過ぎています。ご協力ありがとうございました。',
    TOKEN_INVALID: 'このリンクは無効です。ご利用後にお送りしたメールのリンクから開いてください。',
    NO_TOKEN: 'このアンケートは、ご利用後にお送りするメールのリンクから回答できます。',
    NOT_READY: 'ただいま準備中です。回答は保存されていません。',
    BUSY: '混み合っています。少し時間をおいて、もう一度送信してください。',
    FAILED: '送信できませんでした。通信環境をご確認のうえ、もう一度お試しください。',
    INVALID: '入力内容をご確認ください。'
  };
  var TOKEN_CODES = ['TOKEN_MISSING', 'TOKEN_INVALID', 'TOKEN_USED', 'TOKEN_EXPIRED', 'TOKEN_BRAND_MISMATCH', 'TOKEN_NOT_CONNECTED'];

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

  function clear() { while (root.firstChild) root.removeChild(root.firstChild); }

  function backLink(label) {
    return el('a', { className: 'fb-btn fb-btn-secondary', href: brand.backUrl, rel: 'noreferrer', text: label || brand.backLabel });
  }

  /* 完了・中断・エラーの共通画面。 */
  function showEnd(kind, title, message) {
    clear();
    var heading = el('h1', { className: 'fb-title', tabindex: '-1', text: title });
    root.appendChild(el('section', { className: 'fb-card fb-end fb-end-' + kind, 'data-state': kind }, [
      heading,
      el('p', { text: message }),
      el('p', { className: 'fb-actions' }, [backLink()])
    ]));
    heading.focus();
  }

  function testBanner() {
    return el('p', { className: 'fb-test-banner', role: 'status', text: 'TEST MODE：この回答はテストとして保存され、本番集計・通知の対象になりません' });
  }

  function scaleField(name, question, required) {
    var options = [];
    for (var i = 1; i <= 5; i++) options.push({ id: i, label: String(i) });
    var fieldset = el('fieldset', { className: 'fb-question', id: 'fb-' + name });
    fieldset.appendChild(legend(question.label, required));
    var row = el('div', { className: 'fb-scale' });
    options.forEach(function (o) {
      var input = el('input', { type: 'radio', name: name, value: String(o.id) });
      if (answers[name] === o.id) input.checked = true;
      input.addEventListener('change', function () { answers[name] = o.id; });
      row.appendChild(el('label', { className: 'fb-scale-item' }, [input, el('span', { text: o.label })]));
    });
    fieldset.appendChild(row);
    fieldset.appendChild(el('p', { className: 'fb-scale-ends' }, [el('span', { text: '1：' + question.low }), el('span', { text: '5：' + question.high })]));
    fieldset.appendChild(el('p', { className: 'fb-field-error', 'data-error-for': name }));
    return fieldset;
  }

  function legend(text, required) {
    return el('legend', {}, [
      document.createTextNode(text),
      el('span', { className: 'fb-badge' + (required ? ' is-required' : ''), text: required ? '必須' : '任意' })
    ]);
  }

  function radioList(name, options, current, onChange) {
    var list = el('div', { className: 'fb-options' });
    options.forEach(function (o) {
      var input = el('input', { type: 'radio', name: name, value: o.id });
      if (current === o.id) input.checked = true;
      input.addEventListener('change', function () { onChange(o.id); });
      list.appendChild(el('label', { className: 'fb-option' }, [input, el('span', { text: o.label })]));
    });
    return list;
  }

  function matrixField(name, question, items) {
    var fieldset = el('fieldset', { className: 'fb-question', id: 'fb-' + name });
    fieldset.appendChild(legend(question.label, false));
    fieldset.appendChild(el('p', { className: 'fb-hint', text: question.hint }));
    items.forEach(function (item) {
      var group = el('div', { className: 'fb-matrix-item', role: 'radiogroup', 'aria-label': item.label });
      group.appendChild(el('p', { className: 'fb-matrix-label', text: item.label }));
      group.appendChild(radioList(name + '_' + item.id, Core.CONDITION_OPTIONS, answers[name][item.id], function (id) {
        answers[name][item.id] = id;
      }));
      fieldset.appendChild(group);
    });
    fieldset.appendChild(el('p', { className: 'fb-field-error', 'data-error-for': name }));
    return fieldset;
  }

  function staffField() {
    var fieldset = el('fieldset', { className: 'fb-question', id: 'fb-q4' });
    fieldset.appendChild(legend(Core.QUESTIONS.q4.label, false));
    var ratingBox = el('div', { className: 'fb-reveal', id: 'fb-q4-rating' });
    function syncRating() {
      ratingBox.hidden = answers.q4 !== 'yes';
      if (answers.q4 !== 'yes') {
        answers.q4_rating = '';
        Array.prototype.forEach.call(ratingBox.querySelectorAll('input'), function (i) { i.checked = false; });
      }
    }
    fieldset.appendChild(radioList('q4', Core.STAFF_OPTIONS, answers.q4, function (id) { answers.q4 = id; syncRating(); }));
    ratingBox.appendChild(scaleField('q4_rating', Core.QUESTIONS.q4_rating, false));
    fieldset.appendChild(ratingBox);
    syncRating();
    return fieldset;
  }

  function issuesField() {
    var fieldset = el('fieldset', { className: 'fb-question', id: 'fb-q5' });
    fieldset.appendChild(legend(Core.QUESTIONS.q5.label, false));
    var list = el('div', { className: 'fb-options' });
    var inputs = [];
    Core.ISSUE_OPTIONS.forEach(function (o) {
      var input = el('input', { type: 'checkbox', name: 'q5', value: o.id });
      inputs.push(input);
      input.addEventListener('change', function () {
        /* 「特になし」は他の選択肢と排他 */
        if (input.checked && o.exclusive) inputs.forEach(function (other) { if (other !== input) other.checked = false; });
        if (input.checked && !o.exclusive) inputs.forEach(function (other) { if (other.value === 'none') other.checked = false; });
        answers.q5 = inputs.filter(function (i) { return i.checked; }).map(function (i) { return i.value; });
      });
      list.appendChild(el('label', { className: 'fb-option' }, [input, el('span', { text: o.label })]));
    });
    fieldset.appendChild(list);
    fieldset.appendChild(el('p', { className: 'fb-field-error', 'data-error-for': 'q5' }));
    return fieldset;
  }

  function commentField() {
    var q = Core.QUESTIONS.comment;
    var wrap = el('div', { className: 'fb-question', id: 'fb-comment' });
    var textarea = el('textarea', { id: 'fb-comment-input', name: 'comment', rows: '5', maxlength: String(Core.COMMENT_MAX_CHARS * 2), 'aria-describedby': 'fb-comment-hint fb-comment-count' });
    var counter = el('p', { className: 'fb-counter', id: 'fb-comment-count', 'aria-live': 'polite' });
    function update() {
      answers.comment = textarea.value;
      var n = Core.charCount(textarea.value.trim());
      counter.textContent = n + ' / ' + Core.COMMENT_MAX_CHARS + '字';
      counter.className = 'fb-counter' + (n > Core.COMMENT_MAX_CHARS ? ' is-over' : '');
    }
    textarea.addEventListener('input', update);
    wrap.appendChild(el('label', { className: 'fb-label', for: 'fb-comment-input' }, [
      document.createTextNode(q.label), el('span', { className: 'fb-badge', text: '任意' })
    ]));
    wrap.appendChild(el('p', { className: 'fb-hint', id: 'fb-comment-hint', text: q.hint }));
    wrap.appendChild(textarea);
    wrap.appendChild(counter);
    wrap.appendChild(el('p', { className: 'fb-field-error', 'data-error-for': 'comment' }));
    update();
    return wrap;
  }

  function reuseField() {
    var fieldset = el('fieldset', { className: 'fb-question', id: 'fb-q6' });
    fieldset.appendChild(legend(Core.QUESTIONS.q6.label, true));
    fieldset.appendChild(radioList('q6', Core.REUSE_OPTIONS, answers.q6, function (id) { answers.q6 = id; }));
    fieldset.appendChild(el('p', { className: 'fb-field-error', 'data-error-for': 'q6' }));
    return fieldset;
  }

  var ERROR_TEXT = {
    REQUIRED: 'この設問は必須です。',
    TOO_LONG: Core.COMMENT_MAX_CHARS + '字以内で入力してください。',
    EXCLUSIVE_CONFLICT: '「特になし」は他の項目と同時に選べません。'
  };

  function showErrors(errors) {
    Array.prototype.forEach.call(root.querySelectorAll('.fb-field-error'), function (p) { p.textContent = ''; });
    var first = null;
    (errors || []).forEach(function (e) {
      var target = root.querySelector('[data-error-for="' + e.field + '"]');
      if (!target) return;
      target.textContent = ERROR_TEXT[e.code] || '入力内容をご確認ください。';
      if (!first) first = target;
    });
    if (first && first.parentNode && first.parentNode.scrollIntoView) first.parentNode.scrollIntoView({ block: 'center' });
  }

  function payload() {
    var data = { brand: brand.id, answers: {} };
    if (loc.isTest) data.test = 1;
    else data.token = token;
    data.answers.q1 = answers.q1;
    data.answers.q6 = answers.q6;
    ['q2', 'q3'].forEach(function (k) { if (Object.keys(answers[k]).length) data.answers[k] = answers[k]; });
    if (answers.q4) data.answers.q4 = answers.q4;
    if (answers.q4 === 'yes' && answers.q4_rating) data.answers.q4_rating = answers.q4_rating;
    if (answers.q5.length) data.answers.q5 = answers.q5;
    if (answers.comment.trim()) data.answers.comment = answers.comment;
    return data;
  }

  function post(action, data) {
    return fetch(config.BASE_URL + '?action=' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(data),
      referrerPolicy: 'no-referrer',
      credentials: 'omit'
    }).then(function (response) { return response.json(); });
  }

  function handleTokenError(code) {
    if (code === 'TOKEN_USED') showEnd('used', '回答済みです', MESSAGES.TOKEN_USED);
    else if (code === 'TOKEN_EXPIRED') showEnd('expired', '受付期間が終了しました', MESSAGES.TOKEN_EXPIRED);
    else showEnd('invalid', 'このリンクは使用できません', MESSAGES.TOKEN_INVALID);
  }

  function submit(button, status) {
    if (isSubmitting) return;
    var data = payload();
    var checked = Core.validateAnswers(data.answers);
    if (!checked.ok) {
      showErrors(checked.errors);
      status.textContent = MESSAGES.INVALID;
      return;
    }
    showErrors([]);
    if (!config.BASE_URL) {
      status.textContent = MESSAGES.NOT_READY;
      return;
    }
    isSubmitting = true;
    button.disabled = true;
    status.textContent = '送信しています…';
    post('submit', data).then(function (result) {
      if (result && result.success) {
        showEnd('done', 'ご回答ありがとうございました', brand.name + 'をご利用いただき、ありがとうございました。いただいたご意見は、今後の改善に役立てます。' + (loc.isTest ? '（テスト回答）' : ''));
        return;
      }
      var code = result && result.error && result.error.code;
      if (TOKEN_CODES.indexOf(code) !== -1) { handleTokenError(code); return; }
      if (code === 'VALIDATION_FAILED') { showErrors(result.error.fields); status.textContent = MESSAGES.INVALID; }
      else if (code === 'RATE_LIMITED' || code === 'BUSY') status.textContent = MESSAGES.BUSY;
      else status.textContent = MESSAGES.FAILED;
      isSubmitting = false;
      button.disabled = false;
    }).catch(function () {
      status.textContent = MESSAGES.FAILED;
      isSubmitting = false;
      button.disabled = false;
    });
  }

  function renderForm() {
    clear();
    var form = el('form', { className: 'fb-card', novalidate: 'novalidate' });
    if (loc.isTest) form.appendChild(testBanner());
    form.appendChild(el('h1', { className: 'fb-title', text: brand.name + ' ご利用後アンケート' }));
    form.appendChild(el('p', { className: 'fb-intro', text: 'ご利用いただきありがとうございました。今後の改善のため、2〜3分ほどでお答えいただけるアンケートにご協力ください。' }));
    form.appendChild(el('p', { className: 'fb-hint', text: '回答は任意です。お名前・メールアドレス・予約番号の入力は不要です。必須はQ1とQ6だけです。' }));
    form.appendChild(scaleField('q1', Core.QUESTIONS.q1, true));
    form.appendChild(matrixField('q2', Core.QUESTIONS.q2, Core.Q2_ITEMS));
    form.appendChild(matrixField('q3', Core.QUESTIONS.q3, Core.Q3_ITEMS));
    form.appendChild(staffField());
    form.appendChild(issuesField());
    form.appendChild(commentField());
    form.appendChild(reuseField());
    var status = el('p', { className: 'fb-status', role: 'status', 'aria-live': 'polite' });
    var button = el('button', { type: 'submit', className: 'fb-btn', text: '回答を送信する' });
    form.appendChild(status);
    form.appendChild(el('p', { className: 'fb-actions' }, [button]));
    var quit = el('a', { className: 'fb-quit', href: brand.backUrl, rel: 'noreferrer', text: '回答をやめて戻る' });
    form.appendChild(el('p', { className: 'fb-actions' }, [quit]));
    form.addEventListener('submit', function (event) { event.preventDefault(); submit(button, status); });
    root.appendChild(form);
  }

  function start() {
    if (!brand) {
      clear();
      root.appendChild(el('p', { className: 'fb-error', text: 'ページの設定に誤りがあります。' }));
      return;
    }
    if (loc.isTest) { renderForm(); return; }
    if (!token) { showEnd('notoken', 'アンケートについて', MESSAGES.NO_TOKEN); return; }
    if (!config.BASE_URL) { showEnd('notready', '準備中です', MESSAGES.NOT_READY); return; }
    post('verify', { brand: brand.id, token: token }).then(function (result) {
      if (result && result.success) { renderForm(); return; }
      var code = result && result.error && result.error.code;
      if (TOKEN_CODES.indexOf(code) !== -1) handleTokenError(code);
      else showEnd('error', '読み込めませんでした', MESSAGES.FAILED);
    }).catch(function () { showEnd('error', '読み込めませんでした', MESSAGES.FAILED); });
  }

  start();
})();
