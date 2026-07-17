(function () {
  'use strict';

  var form = document.getElementById('reservation-request-form');
  if (!form) return;

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
    var isOther = purposeInput.value === 'Other';
    purposeOtherWrap.hidden = !isOther;
    purposeOtherInput.required = isOther;
    if (!isOther) clearError(purposeOtherInput, 'reservation-purpose-other-error');
  }

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

  function validateForm() {
    var errors = [];
    var nameInput = document.getElementById('reservation-name');
    var emailInput = document.getElementById('reservation-email');
    var termsInput = document.getElementById('reservation-terms');
    var privacyInput = document.getElementById('reservation-privacy');

    clearError(nameInput, 'reservation-name-error');
    clearError(emailInput, 'reservation-email-error');
    clearError(dateInput, 'reservation-date-error');
    clearError(timeInput, 'reservation-start-time-error');
    clearError(durationInput, 'reservation-duration-error');
    clearError(partySizeInput, 'reservation-party-size-error');
    clearError(purposeInput, 'reservation-purpose-error');
    clearError(purposeOtherInput, 'reservation-purpose-other-error');
    clearError(termsInput, 'reservation-terms-error');
    clearError(privacyInput, 'reservation-privacy-error');
    clearRadioError('Payment Method', 'reservation-payment-error');

    if (!nameInput.value.trim()) errors.push(setError(nameInput, 'reservation-name-error', 'Please enter your name.'));
    if (!emailInput.value.trim()) {
      errors.push(setError(emailInput, 'reservation-email-error', 'Please enter your email address.'));
    } else if (!emailInput.validity.valid) {
      errors.push(setError(emailInput, 'reservation-email-error', 'Please enter a valid email address.'));
    }
    if (!dateInput.value) {
      errors.push(setError(dateInput, 'reservation-date-error', 'Please select a preferred date.'));
    } else if (dateInput.value <= todayInJapan()) {
      var isSameDay = dateInput.value === todayInJapan();
      errors.push(setError(dateInput, 'reservation-date-error', isSameDay ? 'Same-day booking requests are not accepted. Please choose a later date.' : 'Please choose a date in the future.'));
    }
    if (!timeInput.value) {
      errors.push(setError(timeInput, 'reservation-start-time-error', 'Please select a start time.'));
    } else if (timeInput.value < '08:00' || timeInput.value > '23:00') {
      errors.push(setError(timeInput, 'reservation-start-time-error', 'Please choose a start time between 8:00 and 23:00.'));
    }
    if (!durationInput.value) errors.push(setError(durationInput, 'reservation-duration-error', 'Please select a duration.'));
    if (timeInput.value && durationInput.value && endTimeExceedsClosing()) {
      errors.push(setError(timeInput, 'reservation-start-time-error', 'Your session would end after 23:00. Please adjust the start time or duration.'));
    }
    if (!partySizeInput.value) errors.push(setError(partySizeInput, 'reservation-party-size-error', 'Please select the number of guests.'));
    if (!purposeInput.value) errors.push(setError(purposeInput, 'reservation-purpose-error', 'Please select the intended use.'));
    if (purposeInput.value === 'Other' && !purposeOtherInput.value.trim()) {
      errors.push(setError(purposeOtherInput, 'reservation-purpose-other-error', 'Please describe your intended use.'));
    }
    if (!checkedRadio('Payment Method')) errors.push(setRadioError('Payment Method', 'reservation-payment-error', 'Please select a payment method.'));
    if (!termsInput.checked) errors.push(setError(termsInput, 'reservation-terms-error', 'You must agree to the Terms of Use.'));
    if (!privacyInput.checked) errors.push(setError(privacyInput, 'reservation-privacy-error', 'You must agree to the Privacy Policy.'));

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
  updatePurposeOther();

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (isSubmitting || !validateForm()) return;

    failureMessage.hidden = true;
    successMessage.hidden = true;

    isSubmitting = true;
    submitButton.disabled = true;
    submitButton.textContent = 'Sending…';
    submitState.textContent = 'Sending your booking request.';
    submittedAt.value = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo',
      dateStyle: 'medium',
      timeStyle: 'medium'
    }).format(new Date());
    subjectInput.value = '[Studio Nagoya Base] Booking Request: ' + dateInput.value + ' ' + timeInput.value;

    fetch(form.action, {
      method: 'POST',
      body: new FormData(form),
      headers: { Accept: 'application/json' }
    }).then(function (response) {
      if (!response.ok) throw new Error('HTTP ' + response.status);
      successMessage.hidden = false;
      form.reset();
      updatePurposeOther();
      updateEndWarning();
      successMessage.focus();
    }).catch(function () {
      failureText.textContent = 'Please check your connection and try again. If the form still does not work, please contact us by email instead.';
      failureMessage.hidden = false;
      failureMessage.focus();
    }).finally(function () {
      isSubmitting = false;
      submitButton.disabled = false;
      submitButton.textContent = 'Submit Booking Request';
      submitState.textContent = 'We will contact you at the email address you provide after reviewing your request.';
    });
  });
})();
