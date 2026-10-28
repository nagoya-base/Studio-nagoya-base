(function () {
  'use strict';

  /* 予約前相談・お問い合わせフォーム（SNB / SNB mens 共通）。予約は /booking/ へ一本化済みで、
     このフォームは相談・問い合わせの送信のみを扱う（Issue #594）。 */
  var form = document.getElementById('reservation-request-form');
  if (!form) return;

  var messageInput = document.getElementById('reservation-message');
  var errorSummary = document.getElementById('reservation-error-summary');
  var successMessage = document.getElementById('reservation-success');
  var successTitle = document.getElementById('reservation-success-title');
  var successBody = document.getElementById('reservation-success-body');
  var failureMessage = document.getElementById('reservation-failure');
  var failureText = document.getElementById('reservation-failure-message');
  var submitButton = document.getElementById('reservation-submit');
  var submitState = document.getElementById('reservation-submit-state');
  var submittedAt = document.getElementById('reservation-submitted-at');
  var subjectInput = document.getElementById('reservation-subject');
  var sourcePageInput = document.getElementById('reservation-source-page');
  var isSubmitting = false;
  /* 送信操作ごとに採番し、generate_lead の二重計測を防ぐ */
  var submissionSeq = 0;

  var SUBMIT_LABEL = '相談内容を送信する';
  /* 問い合わせ種別は「予約前に相談する」のみ。GA4 contact_intent は過去データとの連続性のため consult 固定（Issue #602） */
  var CONTACT_INTENT = 'consult';

  function trackFormStart() {
    if (window.StudioAnalytics) window.StudioAnalytics.trackFormStart();
  }
  form.addEventListener('input', function (event) {
    var tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') trackFormStart();
  });
  form.addEventListener('change', function (event) {
    var tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') trackFormStart();
  });

  function setError(element, errorId, message, type) {
    var error = document.getElementById(errorId);
    element.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
    return { element: element, message: message, type: type || 'unknown' };
  }

  function clearError(element, errorId) {
    var error = document.getElementById(errorId);
    element.removeAttribute('aria-invalid');
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
  }

  function validateForm() {
    var errors = [];
    var nameInput = document.getElementById('reservation-name');
    var emailInput = document.getElementById('reservation-email');
    var xAccountInput = document.getElementById('reservation-x-account');

    clearError(nameInput, 'reservation-name-error');
    clearError(emailInput, 'reservation-email-error');
    clearError(xAccountInput, 'reservation-x-account-error');
    clearError(messageInput, 'reservation-message-error');

    if (!nameInput.value.trim()) errors.push(setError(nameInput, 'reservation-name-error', 'お名前を入力してください。', 'required_missing'));
    if (!emailInput.value.trim()) {
      errors.push(setError(emailInput, 'reservation-email-error', 'メールアドレスを入力してください。', 'required_missing'));
    } else if (!emailInput.validity.valid) {
      errors.push(setError(emailInput, 'reservation-email-error', 'メールアドレスを正しい形式で入力してください。', 'invalid_email'));
    }

    if (!messageInput.value.trim()) {
      errors.push(setError(messageInput, 'reservation-message-error', '相談内容をご記入ください。', 'required_missing'));
    }

    var list = errorSummary.querySelector('ul');
    list.innerHTML = '';
    errors.forEach(function (error) {
      var item = document.createElement('li');
      item.textContent = error.message;
      list.appendChild(item);
    });
    errorSummary.hidden = errors.length === 0;
    if (errors.length) {
      errorSummary.focus();
      errors[0].element.focus();
      if (window.StudioAnalytics) window.StudioAnalytics.trackFormError(errors[0].type, errors.length);
    }
    return errors.length === 0;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (isSubmitting || !validateForm()) return;

    failureMessage.hidden = true;
    successMessage.hidden = true;

    var xAccountInput = document.getElementById('reservation-x-account');
    xAccountInput.value = xAccountInput.value.trim();

    if (form.dataset.endpointConfigured !== 'true') {
      failureText.textContent = 'フォームの送信先がまだ設定されていません。しばらくしてから再度お試しください。';
      failureMessage.hidden = false;
      failureMessage.focus();
      return;
    }

    isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = '送信中…';
    submitState.textContent = '相談内容を送信しています。';
    submittedAt.value = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(new Date());
    if (sourcePageInput) {
      sourcePageInput.value = window.location.pathname;
    }
    subjectInput.value = '【Studio Nagoya Base】予約前の相談';

    submissionSeq += 1;
    var submissionToken = submissionSeq;

    fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) {
        var httpError = new Error('HTTP ' + response.status);
        httpError.failureType = 'server';
        throw httpError;
      }
      var completionParams = { contact_intent: CONTACT_INTENT };
      if (successTitle && successBody) {
        successTitle.textContent = 'ご相談を受け付けました';
        successBody.innerHTML = 'お問い合わせありがとうございます。<br>内容を確認後、通常24時間以内にメールでご連絡します。';
      }
      successMessage.hidden = false;
      form.reset();
      successMessage.focus();
      if (window.StudioAnalytics) {
        /* キーイベント：POST成功時のみ、1送信につき1回 */
        window.StudioAnalytics.trackGenerateLead(submissionToken, completionParams);
      }
    }).catch(function (error) {
      if (window.StudioAnalytics) window.StudioAnalytics.trackFormError((error && error.failureType) || 'network', 0);
      failureText.textContent = '通信状況をご確認のうえ、しばらく時間を置いてから再度お試しください。入力内容は保持されていますので、そのまま再送信いただけます。';
      failureMessage.hidden = false;
      failureMessage.focus();
    }).finally(function () {
      isSubmitting = false;
      submitButton.disabled = false;
      submitButton.textContent = SUBMIT_LABEL;
      submitState.textContent = '送信内容を確認後、入力したメールアドレスへご連絡します。';
    });
  });
})();
