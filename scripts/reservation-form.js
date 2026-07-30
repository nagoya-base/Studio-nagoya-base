(function () {
  'use strict';

  var form = document.getElementById('reservation-request-form');
  if (!form) return;

  var intentRadios = form.querySelectorAll('input[name="お問い合わせ種別"]');
  var intentError = document.getElementById('reservation-intent-error');
  var bookingOnlyEls = form.querySelectorAll('.is-booking-only');
  var requiredIfBookingEls = form.querySelectorAll('[data-required-if-booking]');
  var dateInput = document.getElementById('reservation-date');
  var timeInput = document.getElementById('reservation-start-time');
  var durationInput = document.getElementById('reservation-duration');
  var partySizeInput = document.getElementById('reservation-party-size');
  var purposeInput = document.getElementById('reservation-purpose');
  var purposeOtherWrap = document.getElementById('reservation-purpose-other-wrap');
  var purposeOtherInput = document.getElementById('reservation-purpose-other');
  var endWarning = document.getElementById('reservation-end-warning');
  var suspensionNote = document.getElementById('reservation-suspension-note');
  var messageInput = document.getElementById('reservation-message');
  var messageMark = document.getElementById('reservation-message-mark');
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

  var SUBMIT_LABEL_DEFAULT = '予約を申し込む';
  var SUBMIT_LABEL_BOOKING = '予約を申し込む';
  var SUBMIT_LABEL_CONSULT = '相談内容を送信する';

  function getIntent() {
    for (var i = 0; i < intentRadios.length; i++) {
      if (intentRadios[i].checked) return intentRadios[i].getAttribute('data-intent');
    }
    return null;
  }

  function submitLabelForIntent(intent) {
    if (intent === 'booking') return SUBMIT_LABEL_BOOKING;
    if (intent === 'consult') return SUBMIT_LABEL_CONSULT;
    return SUBMIT_LABEL_DEFAULT;
  }

  /* 「お問い合わせ種別」の選択に応じて、予約専用項目の表示・必須判定を切り替える */
  function applyIntentMode(intent) {
    var isBooking = intent === 'booking';

    bookingOnlyEls.forEach(function (el) { el.hidden = !isBooking; });

    requiredIfBookingEls.forEach(function (el) {
      if (isBooking) el.setAttribute('required', 'required');
      else el.removeAttribute('required');
    });

    /* 「その他」の利用目的詳細は、予約かつ「その他」選択時のみ必須 */
    if (purposeOtherInput && purposeInput) {
      purposeOtherInput.required = isBooking && purposeInput.value === 'その他';
    }

    if (messageInput && messageMark) {
      if (intent === 'consult') {
        messageInput.setAttribute('required', 'required');
        messageMark.textContent = '必須';
        messageMark.className = 'field-badge field-badge--required';
      } else {
        messageInput.removeAttribute('required');
        messageMark.textContent = '任意';
        messageMark.className = 'field-badge';
      }
    }

    if (submitButton && !submitButton.disabled) {
      submitButton.textContent = submitLabelForIntent(intent);
    }
  }

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

  function mapDurationGroup(value) {
    switch (value) {
      case '2': return '2h';
      case '3': return '3h';
      case '4': return '4h';
      case '5': return '5h';
      case '6': return '6h';
      case '7+': return '7h_plus';
      default: return 'unknown';
    }
  }

  function mapPartySizeGroup(value) {
    switch (value) {
      case '1名': return '1';
      case '2名': return '2';
      case '3名': return '3';
      case '4名': return '4';
      case '5名以上・要相談': return '5_plus';
      default: return 'unknown';
    }
  }

  function mapUsageCategory(value) {
    switch (value) {
      case '緊縛の自主練習': return 'practice';
      case 'ショー・パフォーマンス練習': return 'performance';
      case '講習会・ワークショップ': return 'workshop';
      case '緊縛・ロープ表現の撮影': return 'bondage_photography';
      case '身体表現・作品撮り': return 'body_expression';
      case '静止画・動画撮影': return 'photo_video';
      case 'その他': return 'other';
      default: return 'unknown';
    }
  }

  function mapRiggingUsage(value) {
    switch (value) {
      case '利用する': return 'yes';
      case '利用しない': return 'no';
      case '未定・相談したい': return 'undecided';
      default: return 'unknown';
    }
  }

  function mapPaymentMethod(value) {
    switch (value) {
      case '現金': return 'cash';
      case 'PayPay': return 'paypay';
      case 'オンラインクレジットカード': return 'card';
      case '未定': return 'undecided';
      default: return 'unknown';
    }
  }

  function mapCustomerType(value) {
    switch (value) {
      case '初回利用': return 'first_time';
      case '通常利用': return 'regular';
      case '会員利用': return 'member';
      default: return 'unknown';
    }
  }

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

  function setRadioError(name, errorId, message, type) {
    var radios = form.querySelectorAll('input[name="' + name + '"]');
    radios.forEach(function (radio) { radio.setAttribute('aria-invalid', 'true'); });
    var error = document.getElementById(errorId);
    error.textContent = message;
    error.hidden = false;
    return { element: radios[0], message: message, type: type || 'unknown' };
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
    var isBooking = getIntent() === 'booking';
    purposeOtherWrap.hidden = !(isOther && isBooking);
    purposeOtherInput.required = isOther && isBooking;
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
    var termsInput = document.getElementById('reservation-terms');
    var safetyInput = document.getElementById('reservation-safety');
    var conditionInput = document.getElementById('reservation-condition');
    var intent = getIntent();

    clearError(nameInput, 'reservation-name-error');
    clearError(emailInput, 'reservation-email-error');
    clearError(dateInput, 'reservation-date-error');
    clearError(timeInput, 'reservation-start-time-error');
    clearError(durationInput, 'reservation-duration-error');
    clearError(partySizeInput, 'reservation-party-size-error');
    clearError(purposeInput, 'reservation-purpose-error');
    clearError(purposeOtherInput, 'reservation-purpose-other-error');
    clearError(messageInput, 'reservation-message-error');
    clearError(termsInput, 'reservation-terms-error');
    clearError(safetyInput, 'reservation-safety-error');
    clearError(conditionInput, 'reservation-condition-error');
    clearRadioError('吊り床利用予定', 'reservation-suspension-error');
    clearRadioError('支払方法', 'reservation-payment-error');
    clearRadioError('利用区分', 'reservation-member-error');
    if (intentError) intentError.hidden = true;

    if (!intent) {
      errors.push(setError(intentRadios[0], 'reservation-intent-error', 'お問い合わせ種別を選択してください。', 'required_missing'));
    }

    if (!nameInput.value.trim()) errors.push(setError(nameInput, 'reservation-name-error', 'お名前を入力してください。', 'required_missing'));
    if (!emailInput.value.trim()) {
      errors.push(setError(emailInput, 'reservation-email-error', 'メールアドレスを入力してください。', 'required_missing'));
    } else if (!emailInput.validity.valid) {
      errors.push(setError(emailInput, 'reservation-email-error', 'メールアドレスを正しい形式で入力してください。', 'invalid_email'));
    }

    if (intent === 'booking') {
      if (!dateInput.value) {
        errors.push(setError(dateInput, 'reservation-date-error', '希望日を入力してください。', 'required_missing'));
      } else if (dateInput.value <= todayInJapan()) {
        var isSameDay = dateInput.value === todayInJapan();
        errors.push(setError(dateInput, 'reservation-date-error', isSameDay ? '当日の予約は申し込めません。翌日以降を選択してください。' : '過去の日付は選択できません。', isSameDay ? 'same_day' : 'invalid_date'));
      }
      if (!timeInput.value) {
        errors.push(setError(timeInput, 'reservation-start-time-error', '開始時間を入力してください。', 'required_missing'));
      } else if (timeInput.value < '08:00' || timeInput.value > '23:00') {
        errors.push(setError(timeInput, 'reservation-start-time-error', '開始時間は8:00〜23:00の範囲で選択してください。', 'outside_business_hours'));
      }
      if (!durationInput.value) errors.push(setError(durationInput, 'reservation-duration-error', '利用時間を選択してください。', 'required_missing'));
      if (timeInput.value && durationInput.value && endTimeExceedsClosing()) {
        errors.push(setError(timeInput, 'reservation-start-time-error', '利用終了時間が23:00を超えています。', 'end_time_over'));
      }
      if (!partySizeInput.value) errors.push(setError(partySizeInput, 'reservation-party-size-error', '利用人数を選択してください。', 'required_missing'));
      if (!purposeInput.value) errors.push(setError(purposeInput, 'reservation-purpose-error', '利用目的を選択してください。', 'required_missing'));
      if (purposeInput.value === 'その他' && !purposeOtherInput.value.trim()) {
        errors.push(setError(purposeOtherInput, 'reservation-purpose-other-error', '「その他」の利用目的を入力してください。', 'other_detail_missing'));
      }
      if (!checkedRadio('吊り床利用予定')) errors.push(setRadioError('吊り床利用予定', 'reservation-suspension-error', '吊り床の利用予定を選択してください。', 'required_missing'));
      if (!checkedRadio('支払方法')) errors.push(setRadioError('支払方法', 'reservation-payment-error', '支払方法を選択してください。', 'required_missing'));
      if (!checkedRadio('利用区分')) errors.push(setRadioError('利用区分', 'reservation-member-error', '利用区分を選択してください。', 'required_missing'));
      if (!conditionInput.checked) errors.push(setError(conditionInput, 'reservation-condition-error', '予約成立条件の確認が必要です。', 'reservation_condition_not_agreed'));
    } else if (intent === 'consult' && !messageInput.value.trim()) {
      errors.push(setError(messageInput, 'reservation-message-error', '相談内容をご記入ください。', 'required_missing'));
    }

    if (!termsInput.checked) errors.push(setError(termsInput, 'reservation-terms-error', '利用規約への同意が必要です。', 'terms_not_agreed'));
    if (!safetyInput.checked) errors.push(setError(safetyInput, 'reservation-safety-error', '安全ルールへの同意が必要です。', 'safety_not_agreed'));

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

  purposeInput.addEventListener('change', updatePurposeOther);
  timeInput.addEventListener('change', updateEndWarning);
  durationInput.addEventListener('change', updateEndWarning);
  form.querySelectorAll('input[name="吊り床利用予定"]').forEach(function (radio) {
    radio.addEventListener('change', updateSuspensionNote);
  });
  intentRadios.forEach(function (radio) {
    radio.addEventListener('change', function () {
      if (intentError) intentError.hidden = true;
      applyIntentMode(getIntent());
      updatePurposeOther();
    });
  });
  applyIntentMode(getIntent());
  updatePurposeOther();
  updateSuspensionNote();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (isSubmitting || !validateForm()) return;

    failureMessage.hidden = true;
    successMessage.hidden = true;

    if (form.dataset.endpointConfigured !== 'true') {
      failureText.textContent = 'フォームの送信先がまだ設定されていません。しばらくしてから再度お試しください。';
      failureMessage.hidden = false;
      failureMessage.focus();
      return;
    }

    var intent = getIntent();

    isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = '送信中…';
    submitState.textContent = intent === 'consult' ? '相談内容を送信しています。' : '予約申込を送信しています。';
    submittedAt.value = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(new Date());
    if (sourcePageInput) {
      sourcePageInput.value = window.location.pathname;
    }
    subjectInput.value = intent === 'booking'
      ? '【Studio Nagoya Base】予約申込：' + dateInput.value + ' ' + timeInput.value
      : '【Studio Nagoya Base】予約前の相談';

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
      var completionParams = { contact_intent: intent || 'unknown' };
      if (intent === 'booking') {
        completionParams.duration_group = mapDurationGroup(durationInput.value);
        completionParams.party_size_group = mapPartySizeGroup(partySizeInput.value);
        completionParams.usage_category = mapUsageCategory(purposeInput.value);
        completionParams.rigging_usage = mapRiggingUsage((checkedRadio('吊り床利用予定') || {}).value);
        completionParams.payment_method = mapPaymentMethod((checkedRadio('支払方法') || {}).value);
        completionParams.customer_type = mapCustomerType((checkedRadio('利用区分') || {}).value);
      }
      if (successTitle && successBody) {
        if (intent === 'consult') {
          successTitle.textContent = 'ご相談を受け付けました';
          successBody.innerHTML = 'お問い合わせありがとうございます。<br>内容を確認後、通常24時間以内にメールでご連絡します。';
        } else {
          successTitle.textContent = '予約申込を受け付けました';
          successBody.innerHTML = 'お申し込みありがとうございます。<br>フォーム送信時点では予約は確定していません。内容を確認後、通常24時間以内にメールでご連絡します。当方からの予約確定連絡をもって予約成立となります。';
        }
      }
      successMessage.hidden = false;
      form.reset();
      applyIntentMode(null);
      updatePurposeOther();
      updateSuspensionNote();
      updateEndWarning();
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
      submitButton.textContent = submitLabelForIntent(getIntent());
      submitState.textContent = '送信内容を確認後、入力したメールアドレスへご連絡します。';
    });
  });
})();
