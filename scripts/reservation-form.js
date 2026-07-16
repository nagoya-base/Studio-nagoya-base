(function () {
  'use strict';

  var form = document.getElementById('reservation-request-form');
  if (!form) return;

  var dateInput = document.getElementById('reservation-date');
  var timeInput = document.getElementById('reservation-start-time');
  var durationInput = document.getElementById('reservation-duration');
  var purposeInput = document.getElementById('reservation-purpose');
  var purposeOtherWrap = document.getElementById('reservation-purpose-other-wrap');
  var purposeOtherInput = document.getElementById('reservation-purpose-other');
  var endWarning = document.getElementById('reservation-end-warning');
  var suspensionNote = document.getElementById('reservation-suspension-note');
  var errorSummary = document.getElementById('reservation-error-summary');
  var successMessage = document.getElementById('reservation-success');
  var failureMessage = document.getElementById('reservation-failure');
  var failureText = document.getElementById('reservation-failure-message');
  var submitButton = document.getElementById('reservation-submit');
  var submitState = document.getElementById('reservation-submit-state');
  var submittedAt = document.getElementById('reservation-submitted-at');
  var subjectInput = document.getElementById('reservation-subject');
  var isSubmitting = false;

  function japanDateParts(date) {
    var parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    var result = {};
    parts.forEach(function (part) {
      if (part.type !== 'literal') result[part.type] = part.value;
    });
    return result.year + '-' + result.month + '-' + result.day;
  }

  function todayInJapan() {
    return japanDateParts(new Date());
  }

  function tomorrowInJapan() {
    var now = new Date();
    var formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric'
    });
    var parts = formatter.formatToParts(now);
    var values = {};
    parts.forEach(function (part) {
      if (part.type !== 'literal') values[part.type] = Number(part.value);
    });
    var japanTomorrowAtNoonUtc = new Date(Date.UTC(values.year, values.month - 1, values.day + 1, 3));
    return japanDateParts(japanTomorrowAtNoonUtc);
  }

  dateInput.min = tomorrowInJapan();

  function setError(element, errorId, message) {
    var error = document.getElementById(errorId);
    element.setAttribute('aria-invalid', 'true');
    error.textContent = message;
    error.hidden = false;
    return { element: element, message: message };
  }

  function clearError(element, errorId) {
    var error = document.getElementById(errorId);
    element.removeAttribute('aria-invalid');
    if (error) {
      error.textContent = '';
      error.hidden = true;
    }
  }

  function checkedRadio(name) {
    return form.querySelector('input[name="' + name + '"]:checked');
  }

  function clearRadioError(name, errorId) {
    var radios = form.querySelectorAll('input[name="' + name + '"]');
    radios.forEach(function (radio) { radio.removeAttribute('aria-invalid'); });
    var error = document.getElementById(errorId);
    error.textContent = '';
    error.hidden = true;
  }

  function setRadioError(name, errorId, message) {
    var radios = form.querySelectorAll('input[name="' + name + '"]');
    radios.forEach(function (radio) { radio.setAttribute('aria-invalid', 'true'); });
    var error = document.getElementById(errorId);
    error.textContent = message;
    error.hidden = false;
    return { element: radios[0], message: message };
  }

  function endTimeExceedsClosing() {
    if (!timeInput.value || !durationInput.value) return false;
    var timeParts = timeInput.value.split(':');
    var startMinutes = Number(timeParts[0]) * 60 + Number(timeParts[1]);
    var durationHours = durationInput.value === '7+' ? 7 : Number(durationInput.value);
    return startMinutes + durationHours * 60 > 23 * 60;
  }

  function updateEndWarning() {
    endWarning.hidden = !endTimeExceedsClosing();
  }

  function updatePurposeOther() {
    var isOther = purposeInput.value === 'その他';
    purposeOtherWrap.hidden = !isOther;
    purposeOtherInput.required = isOther;
    if (!isOther) clearError(purposeOtherInput, 'reservation-purpose-other-error');
  }

  function updateSuspensionNote() {
    var selection = checkedRadio('吊り床利用予定');
    suspensionNote.hidden = !selection || selection.value !== '利用する';
  }

  function validateForm() {
    var errors = [];
    var nameInput = document.getElementById('reservation-name');
    var emailInput = document.getElementById('reservation-email');
    var partySizeInput = document.getElementById('reservation-party-size');
    var termsInput = document.getElementById('reservation-terms');
    var safetyInput = document.getElementById('reservation-safety');
    var conditionInput = document.getElementById('reservation-condition');

    clearError(nameInput, 'reservation-name-error');
    clearError(emailInput, 'reservation-email-error');
    clearError(dateInput, 'reservation-date-error');
    clearError(timeInput, 'reservation-start-time-error');
    clearError(durationInput, 'reservation-duration-error');
    clearError(partySizeInput, 'reservation-party-size-error');
    clearError(purposeInput, 'reservation-purpose-error');
    clearError(purposeOtherInput, 'reservation-purpose-other-error');
    clearError(termsInput, 'reservation-terms-error');
    clearError(safetyInput, 'reservation-safety-error');
    clearError(conditionInput, 'reservation-condition-error');
    clearRadioError('吊り床利用予定', 'reservation-suspension-error');
    clearRadioError('支払方法', 'reservation-payment-error');
    clearRadioError('利用区分', 'reservation-member-error');

    if (!nameInput.value.trim()) errors.push(setError(nameInput, 'reservation-name-error', 'お名前を入力してください。'));
    if (!emailInput.value.trim()) {
      errors.push(setError(emailInput, 'reservation-email-error', 'メールアドレスを入力してください。'));
    } else if (!emailInput.validity.valid) {
      errors.push(setError(emailInput, 'reservation-email-error', 'メールアドレスを正しい形式で入力してください。'));
    }
    if (!dateInput.value) {
      errors.push(setError(dateInput, 'reservation-date-error', '希望日を入力してください。'));
    } else if (dateInput.value <= todayInJapan()) {
      errors.push(setError(dateInput, 'reservation-date-error', dateInput.value === todayInJapan() ? '当日の予約は申し込めません。翌日以降を選択してください。' : '過去の日付は選択できません。'));
    }
    if (!timeInput.value) {
      errors.push(setError(timeInput, 'reservation-start-time-error', '開始時間を入力してください。'));
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
    if (!checkedRadio('吊り床利用予定')) errors.push(setRadioError('吊り床利用予定', 'reservation-suspension-error', '吊り床の利用予定を選択してください。'));
    if (!checkedRadio('支払方法')) errors.push(setRadioError('支払方法', 'reservation-payment-error', '支払方法を選択してください。'));
    if (!checkedRadio('利用区分')) errors.push(setRadioError('利用区分', 'reservation-member-error', '利用区分を選択してください。'));
    if (!termsInput.checked) errors.push(setError(termsInput, 'reservation-terms-error', '利用規約への同意が必要です。'));
    if (!safetyInput.checked) errors.push(setError(safetyInput, 'reservation-safety-error', '安全ルールへの同意が必要です。'));
    if (!conditionInput.checked) errors.push(setError(conditionInput, 'reservation-condition-error', '予約成立条件の確認が必要です。'));

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
    }
    return errors.length === 0;
  }

  purposeInput.addEventListener('change', updatePurposeOther);
  timeInput.addEventListener('change', updateEndWarning);
  durationInput.addEventListener('change', updateEndWarning);
  form.querySelectorAll('input[name="吊り床利用予定"]').forEach(function (radio) {
    radio.addEventListener('change', updateSuspensionNote);
  });
  updatePurposeOther();
  updateSuspensionNote();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (isSubmitting || !validateForm()) return;

    failureMessage.hidden = true;
    successMessage.hidden = true;

    if (form.dataset.endpointConfigured !== 'true') {
      failureText.textContent = 'フォームの送信先がまだ設定されていません。メールからお申し込みください。';
      failureMessage.hidden = false;
      failureMessage.focus();
      return;
    }

    isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = '送信中…';
    submitState.textContent = '予約申込を送信しています。';
    submittedAt.value = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(new Date());
    subjectInput.value = '【Studio Nagoya Base】予約申込：' + dateInput.value + ' ' + timeInput.value;

    fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      successMessage.hidden = false;
      form.reset();
      updatePurposeOther();
      updateSuspensionNote();
      updateEndWarning();
      successMessage.focus();
    }).catch(function () {
      failureText.textContent = '通信状況をご確認のうえ、時間を置いて再度お試しください。送信できない場合は、メールからお申し込みください。';
      failureMessage.hidden = false;
      failureMessage.focus();
    }).finally(function () {
      isSubmitting = false;
      submitButton.disabled = false;
      submitButton.textContent = '予約を申し込む';
      submitState.textContent = '送信内容を確認後、入力したメールアドレスへご連絡します。';
    });
  });
})();
