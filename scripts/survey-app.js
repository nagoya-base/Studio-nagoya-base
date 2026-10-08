/*
 * scripts/survey-app.js — アンケート（Issue #374）のDOM配線。
 *
 * 設問文・選択肢・必須/任意・表示条件・排他制御はすべて survey/survey-schema.json から読み、
 * 検証・正規化は scripts/survey-core.js（GASと共通）を呼ぶだけで、ここには書かない。
 * 現行料金（schema の reveal）は、該当ステップへ到達して描画するまでDOMに存在しない。
 * 送信はContent-Type: text/plain;charset=utf-8のJSON（GAS Web AppのCORSプリフライト回避。
 * scripts/booking-app.js と同じ方針）。
 */
(function () {
  'use strict';

  var root = document.getElementById('survey-app');
  var Core = window.SurveyCore;
  if (!root || !Core) return;

  var schema = null;
  var answers = {};
  var history = []; /* 戻る用: 通過したステップID */
  var currentStep = null;
  var attempted = false;
  var isSubmitting = false;
  var locked = {};
  var eventsSent = {};
  var respondentHash = Core.generateUuid(window.crypto);
  var surveyPath = Core.sanitizeSurveyPath(new URLSearchParams(window.location.search).get('src') || '');

  var MESSAGES = {
    REQUIRED: 'この項目は回答が必要です。',
    INVALID_OPTION: '選択肢を選び直してください。',
    INVALID_TYPE: '入力内容を確認してください。',
    EXCLUSIVE_CONFLICT: 'この選択肢は他の項目と同時に選べません。',
    TOO_MANY: '選べる数の上限を超えています。',
    TOO_LONG: '文字数が上限を超えています。'
  };
  var SUBMIT_ERRORS = {
    SCHEMA_VERSION_MISMATCH: 'アンケートが更新されました。ページを再読み込みしてからもう一度お試しください。',
    VALIDATION_FAILED: '入力内容に不備がありました。各ステップの内容を確認してください。',
    AGE_NOT_ELIGIBLE: 'このアンケートは18歳以上の方を対象としています。',
    RATE_LIMITED: 'アクセスが集中しています。少し時間をおいてからもう一度お試しください。',
    BUSY: '混み合っています。少し時間をおいてからもう一度お試しください。'
  };

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') el.textContent = attrs[key];
      else if (attrs[key] === true) el.setAttribute(key, '');
      else if (attrs[key] !== false && attrs[key] !== null && attrs[key] !== undefined) el.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) {
      if (child) el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return el;
  }

  function normalize() {
    answers = Core.processAnswers(schema, answers).answers;
  }

  function apiUrl(action) {
    var base = (window.SurveyApiConfig && window.SurveyApiConfig.BASE_URL) || '';
    if (!base) return '';
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'action=' + action;
  }

  function post(action, payload) {
    var url = apiUrl(action);
    if (!url) return Promise.resolve({ success: false, error: { code: 'NOT_CONFIGURED' } });
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (response) { return response.json(); });
  }

  /* 匿名のステップ到達イベント（離脱計測）。失敗してもアンケート自体は止めない。 */
  function sendStepEvent(stepId) {
    if (eventsSent[stepId]) return;
    eventsSent[stepId] = true;
    post('event', { schema_version: schema.version, respondent_hash: respondentHash, step_id: stepId })
      .then(function () {}, function () {});
  }

  function visibleStepList() {
    return Core.visibleSteps(schema, answers);
  }

  function clear() {
    while (root.firstChild) root.removeChild(root.firstChild);
  }

  function paragraphs(lines, cls) {
    return lines.map(function (line) { return h('p', { 'class': cls || '', text: line }); });
  }

  function renderEnd(kind) {
    clear();
    var message = kind === 'underage' ? [schema.meta.underageMessage] : schema.meta.completeMessage;
    var box = h('section', { 'class': 'sv-card sv-end', tabindex: '-1', id: 'sv-end' }, [
      h('h1', { text: kind === 'underage' ? '回答の対象外です' : '完了しました' })
    ].concat(paragraphs(message)));
    root.appendChild(box);
    box.focus();
    window.scrollTo(0, 0);
  }

  function errorMessageFor(code, question, other) {
    if (code === 'TOO_MANY') return '選べるのは最大' + question.maxSelect + '個までです。';
    if (code === 'TOO_LONG') return (other ? other.maxLength || 100 : question.maxLength || 500) + '文字以内で入力してください。';
    return MESSAGES[code] || MESSAGES.INVALID_TYPE;
  }

  function otherDefFor(question, field) {
    var found = null;
    (question.otherTexts || []).forEach(function (o) { if (o.field === field) found = o; });
    return found;
  }

  function renderOptionInputs(question, disabled, errorsHere) {
    var selected = Core.toList(answers[question.id]);
    var atMax = question.type === 'multi' && question.maxSelect && selected.length >= question.maxSelect;
    var list = h('div', { 'class': 'sv-options' });
    question.options.forEach(function (option) {
      var checked = selected.indexOf(option.value) !== -1;
      var input = h('input', {
        type: question.type === 'multi' ? 'checkbox' : 'radio',
        name: question.id,
        value: option.value,
        'data-key': question.id + ':' + option.value,
        checked: checked,
        disabled: disabled || (atMax && !checked)
      });
      input.checked = checked;
      input.addEventListener('change', function () { onChoose(question, option.value, input.checked); });
      list.appendChild(h('label', { 'class': 'sv-option' + (checked ? ' is-checked' : '') }, [input, h('span', { text: option.label })]));
    });
    return list;
  }

  function renderSelect(question, disabled) {
    var select = h('select', { name: question.id, 'data-key': question.id, disabled: disabled, 'aria-label': question.label });
    select.appendChild(h('option', { value: '', text: '選択してください' }));
    question.options.forEach(function (option) {
      select.appendChild(h('option', { value: option.value, text: option.label }));
    });
    select.value = answers[question.id] || '';
    select.addEventListener('change', function () { onChoose(question, select.value, true); });
    return select;
  }

  function renderOtherTexts(question, errors) {
    var wrap = [];
    var selected = Core.toList(answers[question.id]);
    (question.otherTexts || []).forEach(function (other) {
      if (selected.indexOf(other.when) === -1) return;
      var errs = errors.filter(function (e) { return e.field === other.field; });
      var input = h('input', {
        type: 'text', name: other.field, maxlength: other.maxLength || 100, autocomplete: 'off',
        'data-key': other.field, value: answers[other.field] || '',
        'aria-invalid': errs.length ? 'true' : 'false'
      });
      input.value = answers[other.field] || '';
      input.addEventListener('input', function () { answers[other.field] = input.value; });
      wrap.push(h('div', { 'class': 'sv-other' }, [
        h('label', {}, [other.label + (other.required ? '（必須）' : ''), input]),
        errs.length ? h('p', { 'class': 'sv-error', role: 'alert', text: errorMessageFor(errs[0].code, question, other) }) : null
      ]));
    });
    return wrap;
  }

  function renderQuestion(question, errors, step) {
    var errs = errors.filter(function (e) { return e.field === question.id; });
    var isLocked = !!locked[question.id];
    var legend = h('legend', {}, [
      question.label,
      h('span', { 'class': 'sv-badge' + (question.required ? ' is-required' : ''), text: question.required ? '必須' : '任意' })
    ]);
    var fieldset = h('fieldset', { 'class': 'sv-question', 'data-q': question.id }, [legend]);
    if (question.hint) fieldset.appendChild(h('p', { 'class': 'sv-hint', text: question.hint }));

    if (question.type === 'text') {
      var area = h('textarea', { name: question.id, rows: '4', maxlength: question.maxLength || 500, 'data-key': question.id, 'aria-label': question.label });
      area.value = answers[question.id] || '';
      var counter = h('p', { 'class': 'sv-hint sv-counter', text: area.value.length + ' / ' + (question.maxLength || 500) });
      area.addEventListener('input', function () {
        answers[question.id] = area.value;
        counter.textContent = area.value.length + ' / ' + (question.maxLength || 500);
      });
      fieldset.appendChild(area);
      fieldset.appendChild(counter);
    } else if (question.ui === 'select') {
      fieldset.appendChild(renderSelect(question, isLocked));
    } else {
      fieldset.appendChild(renderOptionInputs(question, isLocked));
    }
    if (isLocked) fieldset.appendChild(h('p', { 'class': 'sv-hint', text: '回答を確定済みのため、変更できません。' }));
    renderOtherTexts(question, errors).forEach(function (node) { fieldset.appendChild(node); });
    if (errs.length) fieldset.appendChild(h('p', { 'class': 'sv-error', role: 'alert', text: errorMessageFor(errs[0].code, question) }));
    return fieldset;
  }

  function currentErrors() {
    if (!attempted || !currentStep) return [];
    return Core.stepErrors(currentStep, Core.processAnswers(schema, answers).errors);
  }

  function renderProgress() {
    var steps = visibleStepList();
    var index = 0;
    steps.forEach(function (s, i) { if (s.id === currentStep.id) index = i; });
    var percent = Math.round(((index + 1) / steps.length) * 100);
    return h('div', { 'class': 'sv-progress' }, [
      h('p', { 'class': 'sv-progress-text', text: 'ステップ ' + (index + 1) + ' / ' + steps.length + '　' + currentStep.title }),
      h('div', { 'class': 'sv-progress-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent) }, [
        h('i', { style: 'width:' + percent + '%' })
      ])
    ]);
  }

  function renderStep(focusKey) {
    var scrollY = window.scrollY;
    clear();
    var errors = currentErrors();
    var isLast = !Core.nextStep(schema, answers, currentStep.id);
    var card = h('section', { 'class': 'sv-card' }, [renderProgress()]);

    var title = h('h1', { 'class': 'sv-title', tabindex: '-1', id: 'sv-title', text: currentStep.id === 'age' ? schema.meta.title : currentStep.title });
    card.appendChild(title);
    if (currentStep.id === 'age') paragraphs(schema.meta.intro, 'sv-intro').forEach(function (p) { card.appendChild(p); });
    if (currentStep.description) card.appendChild(h('p', { 'class': 'sv-hint', text: currentStep.description }));

    /* 現行料金は、前提設問に回答済みでこのステップを描画するときに初めてDOMへ入れる。 */
    if (Core.shouldReveal(currentStep, answers)) {
      card.appendChild(h('aside', { 'class': 'sv-reveal', 'aria-label': currentStep.reveal.title }, [
        h('h2', { text: currentStep.reveal.title })
      ].concat(paragraphs(currentStep.reveal.lines))));
    }

    if (errors.length) {
      card.appendChild(h('p', { 'class': 'sv-error sv-summary', role: 'alert', id: 'sv-summary', tabindex: '-1', text: '未回答または入力の不備があります。赤字の項目をご確認ください。' }));
    }
    currentStep.questions.forEach(function (question) {
      if (Core.isQuestionVisible(question, answers)) card.appendChild(renderQuestion(question, errors, currentStep));
    });

    var nav = h('div', { 'class': 'sv-nav' });
    if (history.length) {
      var back = h('button', { type: 'button', 'class': 'sv-btn sv-btn-secondary', text: '戻る' });
      back.addEventListener('click', onBack);
      nav.appendChild(back);
    }
    var next = h('button', {
      type: 'button', 'class': 'sv-btn sv-btn-primary', id: 'sv-next',
      text: isLast ? '送信する' : '次へ', disabled: isSubmitting
    });
    next.addEventListener('click', isLast ? onSubmit : onNext);
    nav.appendChild(next);
    card.appendChild(nav);
    card.appendChild(h('p', { 'class': 'sv-error', id: 'sv-submit-error', role: 'alert' }));
    root.appendChild(card);

    var target = focusKey && root.querySelector('[data-key="' + focusKey + '"]');
    if (target) {
      target.focus();
      window.scrollTo(0, scrollY);
    } else if (attempted && errors.length) {
      document.getElementById('sv-summary').focus();
    } else {
      title.focus();
      window.scrollTo(0, 0);
    }
  }

  function onChoose(question, value, checked) {
    if (question.type === 'multi') answers[question.id] = Core.toggleMulti(question, answers[question.id], value, checked);
    else answers[question.id] = value;
    normalize();
    renderStep(question.ui === 'select' ? question.id : question.id + ':' + value);
  }

  function goTo(step, pushHistory) {
    if (pushHistory && currentStep) history.push(currentStep.id);
    currentStep = step;
    attempted = false;
    if (step.id !== 'age') sendStepEvent(step.id);
    renderStep();
  }

  function onNext() {
    normalize();
    attempted = true;
    var errors = Core.stepErrors(currentStep, Core.processAnswers(schema, answers).errors);
    if (errors.length) { renderStep(); return; }

    if (currentStep.id === 'age') {
      if (answers[schema.meta.ageField] === schema.meta.ageBlockValue) { renderEnd('underage'); return; }
      sendStepEvent('age');
    }
    currentStep.questions.forEach(function (q) { if (q.lockOnLeave && answers[q.id]) locked[q.id] = true; });
    var next = Core.nextStep(schema, answers, currentStep.id);
    if (next) goTo(next, true);
  }

  function onBack() {
    var previousId = history.pop();
    var step = schema.steps.filter(function (s) { return s.id === previousId; })[0];
    if (step) { currentStep = step; attempted = false; renderStep(); }
  }

  function showSubmitError(message) {
    var el = document.getElementById('sv-submit-error');
    if (el) el.textContent = message;
  }

  function onSubmit() {
    if (isSubmitting) return; /* 二重送信防止 */
    normalize();
    attempted = true;
    var processed = Core.processAnswers(schema, answers);
    if (Core.stepErrors(currentStep, processed.errors).length) { renderStep(); return; }
    if (processed.errors.length) {
      showSubmitError('前のステップに未回答の項目があります。「戻る」で確認してください。');
      return;
    }
    isSubmitting = true;
    var button = document.getElementById('sv-next');
    button.disabled = true;
    button.textContent = '送信中…';
    showSubmitError('');

    post('submit', {
      schema_version: schema.version,
      respondent_hash: respondentHash,
      survey_path: surveyPath,
      answers: processed.answers
    }).then(function (result) {
      isSubmitting = false;
      if (result && result.success === true) { renderEnd('complete'); return; }
      var code = result && result.error && result.error.code;
      failSubmit(code === 'NOT_CONFIGURED' ? 'アンケートは現在準備中です。公開までしばらくお待ちください。'
        : SUBMIT_ERRORS[code] || '送信できませんでした。時間をおいてもう一度お試しください。');
    }, function () {
      isSubmitting = false;
      failSubmit('通信に失敗しました。電波状況をご確認のうえ、もう一度お試しください。');
    });
  }

  function failSubmit(message) {
    var button = document.getElementById('sv-next');
    if (button) { button.disabled = false; button.textContent = '送信する'; }
    showSubmitError(message);
  }

  function start() {
    var first = Core.nextStep(schema, answers, null);
    currentStep = null;
    goTo(first, false);
  }

  root.setAttribute('aria-busy', 'true');
  fetch(root.getAttribute('data-schema-url'), { cache: 'no-cache' })
    .then(function (response) { return response.json(); })
    .then(function (loaded) {
      schema = loaded;
      root.removeAttribute('aria-busy');
      normalize();
      start();
    })
    .catch(function () {
      clear();
      root.appendChild(h('p', { 'class': 'sv-error', text: 'アンケートを読み込めませんでした。ページを再読み込みしてください。' }));
    });
})();
