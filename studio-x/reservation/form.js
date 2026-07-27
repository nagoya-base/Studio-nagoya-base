(function () {
  'use strict';

  var form = document.getElementById('reservation-request-form');
  if (!form) return;

  var intentRadios = form.querySelectorAll('input[name="お問い合わせ種別"]');
  var intentError = document.getElementById('reservation-intent-error');
  var dateInput = document.getElementById('reservation-date');
  var timeInput = document.getElementById('reservation-start-time');
  var durationInput = document.getElementById('reservation-duration');
  var partySizeInput = document.getElementById('reservation-party-size');
  var purposeInput = document.getElementById('reservation-purpose');
  var purposeOtherWrap = document.getElementById('reservation-purpose-other-wrap');
  var purposeOtherInput = document.getElementById('reservation-purpose-other');
  var endWarning = document.getElementById('reservation-end-warning');
  var errorSummary = document.getElementById('reservation-error-summary');
  var successMessage = document.getElementById('reservation-success');
  var failureMessage = document.getElementById('reservation-failure');
  var failureText = document.getElementById('reservation-failure-message');
  var submitButton = document.getElementById('reservation-submit');
  var submitState = document.getElementById('reservation-submit-state');
  var submittedAt = document.getElementById('reservation-submitted-at');
  var subjectInput = document.getElementById('reservation-subject');
  var messageInput = document.getElementById('reservation-message');
  var messageMark = document.getElementById('reservation-message-mark');
  var conditionInput = document.getElementById('reservation-condition');
  var bookingOnlyEls = form.querySelectorAll('.is-booking-only');
  var emailField = document.getElementById('reservation-email');
  var xField = document.getElementById('reservation-x');
  var methodRadios = form.querySelectorAll('input[name="希望する返信方法"]');
  var isSubmitting = false;
  var submissionSeq = 0;

  function japanDateParts(date) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(date);
    var result = {};
    parts.forEach(function (part) { if (part.type !== 'literal') result[part.type] = part.value; });
    return result.year + '-' + result.month + '-' + result.day;
  }

  function tomorrowInJapan() {
    var now = new Date();
    var formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' });
    var parts = formatter.formatToParts(now);
    var values = {};
    parts.forEach(function (part) { if (part.type !== 'literal') values[part.type] = Number(part.value); });
    var japanTomorrowAtNoonUtc = new Date(Date.UTC(values.year, values.month - 1, values.day + 1, 3));
    return japanDateParts(japanTomorrowAtNoonUtc);
  }

  if (dateInput) dateInput.min = tomorrowInJapan();

  /* ── 遷移元からの問い合わせ種別プリフィル（未知の値は安全に無視） ── */
  var INTENT_QUERY_MAP = { booking: 'booking', consult: 'consult', 'same-day': 'same-day' };
  try {
    var params = new URLSearchParams(window.location.search);
    var queryIntent = params.get('intent');
    if (queryIntent && Object.prototype.hasOwnProperty.call(INTENT_QUERY_MAP, queryIntent)) {
      var target = form.querySelector('input[name="お問い合わせ種別"][data-intent="' + INTENT_QUERY_MAP[queryIntent] + '"]');
      if (target) target.checked = true;
    }
  } catch (e) {
    /* URLSearchParams非対応環境でもフォーム自体は使えるようにする */
  }

  function getIntent() {
    for (var i = 0; i < intentRadios.length; i++) {
      if (intentRadios[i].checked) return intentRadios[i].getAttribute('data-intent');
    }
    return null;
  }

  function applyIntentMode(intent) {
    var isBooking = intent === 'booking';
    bookingOnlyEls.forEach(function (el) { el.hidden = !isBooking; });

    ['reservation-date', 'reservation-start-time', 'reservation-duration', 'reservation-party-size', 'reservation-purpose'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      if (isBooking) el.setAttribute('required', 'required'); else el.removeAttribute('required');
    });
    form.querySelectorAll('input[name="希望する支払方法"], input[name="ご利用区分"]').forEach(function (radio) {
      if (isBooking) radio.setAttribute('required', 'required'); else radio.removeAttribute('required');
    });
    if (conditionInput) {
      if (isBooking) conditionInput.setAttribute('required', 'required'); else conditionInput.removeAttribute('required');
    }

    if (messageInput && messageMark) {
      if (isBooking) {
        messageInput.removeAttribute('required');
        messageMark.textContent = '任意';
      } else {
        messageInput.setAttribute('required', 'required');
        messageMark.textContent = '必須';
      }
    }

    if (submitButton && !submitButton.disabled) {
      submitButton.textContent = isBooking ? '予約を申し込む' : '送信する';
    }
  }

  intentRadios.forEach(function (radio) {
    radio.addEventListener('change', function () {
      intentError.hidden = true;
      applyIntentMode(getIntent());
      if (window.StudioXAnalytics) window.StudioXAnalytics.trackFormStart();
    });
  });
  applyIntentMode(getIntent());

  function trackFormStart() {
    if (window.StudioXAnalytics) window.StudioXAnalytics.trackFormStart();
  }
  form.addEventListener('input', function (event) {
    var tag = event.target && event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') trackFormStart();
  });

  if (window.StudioXAnalytics) window.StudioXAnalytics.trackFormView();

  function setError(element, errorId, message) {
    var error = document.getElementById(errorId);
    if (element) element.setAttribute('aria-invalid', 'true');
    if (error) { error.textContent = message; error.hidden = false; }
    return { element: element, message: message };
  }

  function clearError(element, errorId) {
    if (element) element.removeAttribute('aria-invalid');
    var error = document.getElementById(errorId);
    if (error) { error.textContent = ''; error.hidden = true; }
  }

  function checkedRadio(name) { return form.querySelector('input[name="' + name + '"]:checked'); }

  function clearRadioError(name, errorId) {
    form.querySelectorAll('input[name="' + name + '"]').forEach(function (radio) { radio.removeAttribute('aria-invalid'); });
    var error = document.getElementById(errorId);
    if (error) { error.textContent = ''; error.hidden = true; }
  }

  function setRadioError(name, errorId, message) {
    form.querySelectorAll('input[name="' + name + '"]').forEach(function (radio) { radio.setAttribute('aria-invalid', 'true'); });
    var error = document.getElementById(errorId);
    if (error) { error.textContent = message; error.hidden = false; }
    return { element: form.querySelector('input[name="' + name + '"]'), message: message };
  }

  function endTimeExceedsClosing() {
    if (!timeInput.value || !durationInput.value) return false;
    var timeParts = timeInput.value.split(':');
    var startMinutes = Number(timeParts[0]) * 60 + Number(timeParts[1]);
    var durationHours = durationInput.value === '7+' ? 7 : Number(durationInput.value);
    return startMinutes + durationHours * 60 > 23 * 60;
  }

  function updateEndWarning() { endWarning.hidden = !endTimeExceedsClosing(); }

  function updatePurposeOther() {
    var isOther = purposeInput.value === 'その他';
    purposeOtherWrap.hidden = !isOther;
    purposeOtherInput.required = isOther && getIntent() === 'booking';
    if (!isOther) clearError(purposeOtherInput, 'reservation-purpose-other-error');
  }

  if (purposeInput) purposeInput.addEventListener('change', updatePurposeOther);
  if (timeInput) timeInput.addEventListener('change', updateEndWarning);
  if (durationInput) durationInput.addEventListener('change', updateEndWarning);
  updatePurposeOther();

  function validateForm() {
    var errors = [];
    var nameInput = document.getElementById('reservation-name');
    var emailInput = document.getElementById('reservation-email');
    var termsInput = document.getElementById('reservation-terms');
    var intent = getIntent();

    clearError(nameInput, 'reservation-name-error');
    clearError(emailInput, 'reservation-email-error');
    clearError(xField, 'reservation-x-error');
    clearError(dateInput, 'reservation-date-error');
    clearError(timeInput, 'reservation-start-time-error');
    clearError(durationInput, 'reservation-duration-error');
    clearError(partySizeInput, 'reservation-party-size-error');
    clearError(purposeInput, 'reservation-purpose-error');
    clearError(purposeOtherInput, 'reservation-purpose-other-error');
    clearError(termsInput, 'reservation-terms-error');
    clearError(messageInput, 'reservation-message-error');
    clearError(conditionInput, 'reservation-condition-error');
    clearRadioError('希望する返信方法', 'reservation-method-error');
    clearRadioError('希望する支払方法', 'reservation-payment-error');
    clearRadioError('ご利用区分', 'reservation-repeat-error');
    intentError.hidden = true;

    if (!intent) {
      errors.push(setError(intentRadios[0], 'reservation-intent-error', 'お問い合わせ種別を選択してください。'));
    }
    if (!nameInput.value.trim()) errors.push(setError(nameInput, 'reservation-name-error', 'お名前を入力してください。'));

    var hasEmail = emailInput.value.trim() !== '';
    var hasX = xField.value.trim() !== '';
    if (!hasEmail && !hasX) {
      errors.push(setError(emailInput, 'reservation-email-error', 'メールアドレスまたはXアカウントのどちらかを入力してください。'));
    } else if (hasEmail && !emailInput.validity.valid) {
      errors.push(setError(emailInput, 'reservation-email-error', 'メールアドレスを正しい形式で入力してください。'));
    }
    if (!checkedRadio('希望する返信方法')) {
      errors.push(setRadioError('希望する返信方法', 'reservation-method-error', '希望する返信方法を選択してください。'));
    } else {
      var preferredMethod = checkedRadio('希望する返信方法').value;
      if (preferredMethod === 'メール' && !hasEmail) {
        errors.push(setError(emailInput, 'reservation-email-error', 'メールでの返信を希望する場合は、メールアドレスを入力してください。'));
      }
      if (preferredMethod === 'XのDM' && !hasX) {
        errors.push(setError(xField, 'reservation-x-error', 'XのDMでの返信を希望する場合は、Xアカウントを入力してください。'));
      }
    }

    if (intent === 'booking') {
      if (!dateInput.value) {
        errors.push(setError(dateInput, 'reservation-date-error', '第1希望日を入力してください。'));
      }
      if (!timeInput.value) {
        errors.push(setError(timeInput, 'reservation-start-time-error', '希望開始時間を入力してください。'));
      } else if (timeInput.value < '08:00' || timeInput.value > '23:00') {
        errors.push(setError(timeInput, 'reservation-start-time-error', '開始時間は8:00〜23:00の範囲で選択してください。'));
      }
      if (!durationInput.value) errors.push(setError(durationInput, 'reservation-duration-error', '利用時間を選択してください。'));
      if (timeInput.value && durationInput.value && endTimeExceedsClosing()) {
        errors.push(setError(timeInput, 'reservation-start-time-error', '利用終了時間が23:00を超えています。'));
      }
      if (!partySizeInput.value) errors.push(setError(partySizeInput, 'reservation-party-size-error', '利用人数を選択してください。'));
      if (!purposeInput.value) errors.push(setError(purposeInput, 'reservation-purpose-error', '利用目的を選択してください。'));
      if (purposeInput.value === 'その他' && !purposeOtherInput.value.trim()) {
        errors.push(setError(purposeOtherInput, 'reservation-purpose-other-error', '「その他」の利用目的を入力してください。'));
      }
      if (!checkedRadio('希望する支払方法')) errors.push(setRadioError('希望する支払方法', 'reservation-payment-error', '支払方法を選択してください。'));
      if (!checkedRadio('ご利用区分')) errors.push(setRadioError('ご利用区分', 'reservation-repeat-error', '利用区分を選択してください。'));
      if (!conditionInput.checked) errors.push(setError(conditionInput, 'reservation-condition-error', '予約成立条件の確認が必要です。'));
    } else if (messageInput && !messageInput.value.trim()) {
      errors.push(setError(messageInput, 'reservation-message-error', 'ご質問・ご相談内容を入力してください。'));
    }

    if (!termsInput.checked) errors.push(setError(termsInput, 'reservation-terms-error', '利用規約・プライバシーポリシーへの同意が必要です。'));

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
      if (errors[0].element) errors[0].element.focus();
      if (window.StudioXAnalytics) window.StudioXAnalytics.trackFormError(errors[0].message);
    }
    return errors.length === 0;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (isSubmitting || !validateForm()) return;

    failureMessage.hidden = true;
    successMessage.hidden = true;

    var intent = getIntent();

    isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = '送信中…';
    submitState.textContent = '送信しています。';
    submittedAt.value = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date());
    subjectInput.value = '【Studio X】' + (intent === 'booking' ? '予約申込' : '撮影相談') + '：' + (dateInput.value ? dateInput.value + ' ' + timeInput.value : '日程未定');

    submissionSeq += 1;
    var submissionToken = submissionSeq;

    fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      successMessage.hidden = false;
      form.reset();
      applyIntentMode(null);
      updatePurposeOther();
      updateEndWarning();
      successMessage.focus();
      if (window.StudioXAnalytics) {
        window.StudioXAnalytics.trackFormSubmit(submissionToken, intent, { contact_intent: intent || 'unknown' });
        window.StudioXAnalytics.trackFormSuccess(intent);
      }
    }).catch(function () {
      if (window.StudioXAnalytics) window.StudioXAnalytics.trackFormError('network');
      failureText.textContent = '通信状況をご確認のうえ、時間を置いて再度お試しください。';
      failureMessage.hidden = false;
      failureMessage.focus();
    }).finally(function () {
      isSubmitting = false;
      submitButton.disabled = false;
      applyIntentMode(getIntent());
      submitState.textContent = '送信内容を確認後、入力したメールアドレスへご連絡します。';
    });
  });
})();
