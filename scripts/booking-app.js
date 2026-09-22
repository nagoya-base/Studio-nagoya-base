/*
 * scripts/booking-app.js — 共通予約UI（Issue #269）のDOM配線・API呼び出し本体。
 *
 * SNB / SNB mens / Studio Xの3ブランドとも、このファイルとscripts/booking-logic.js・
 * styles/booking.css・_includes/booking_app_ja.htmlをそのまま共有する（ブランド差は
 * data-brand属性・data-back-url属性・data-back-label属性のみ）。
 *
 * 空き判定・最低利用時間・15分刻み・競合判定などの業務ルールはここに実装しない。
 * getAvailability/createBooking（gas/booking/）の応答をそのまま画面へ反映するだけで、
 * GAS側を正とする。
 *
 * createBookingへのPOSTはContent-Type: text/plain;charset=utf-8で送る。GAS Web Appは
 * application/jsonを付けるとブラウザがCORSプリフライト(OPTIONS)を送り、doOptionsを
 * 実装していないApps ScriptのWeb Appでは失敗するため、CORSセーフリストに含まれる
 * text/plainで送りつつ、本文自体は引き続きJSON文字列にする
 * （gas/booking/Code.gsのhandleCreateBooking_はcontentsを常にJSON.parseするため
 *   Content-Typeの値そのものはGAS側の処理に影響しない）。
 */
(function () {
  'use strict';

  var root = document.getElementById('booking-app');
  if (!root) return;

  var Logic = window.BookingLogic;
  if (!Logic) return;

  var brand = root.getAttribute('data-brand');
  var brandMeta = Logic.getBrandMeta(brand);
  var backUrl = root.getAttribute('data-back-url') || '/';

  /* 表示文言のlocale切り替え（Issue #297）。#booking-app[data-locale]を読み、
     未指定・未知値はjaへfallbackする。API呼び出し・状態管理・step遷移・submit処理は
     localeで分岐させず、ここに定義する表示文言のみを切り替える。 */
  var locale = Logic.normalizeLocale(root.getAttribute('data-locale'));

  var UI_TEXT = {
    ja: {
      backLabelDefault: 'トップへ戻る',
      invalidBrandTitle: Logic.messageForErrorCode('INVALID_BRAND', 'ja'),
      dateRequired: '利用日を選択してください。',
      durationRequired: '利用時間を2時間以上の整数で入力してください。',
      customerTypeRequired: '利用区分を選択してください。',
      startTimeSummary: function (date, hours) { return date + '　' + hours + '時間利用'; },
      back: '戻る',
      reselectDateTime: '日付・利用時間を選び直す',
      retryCheck: 'もう一度確認する',
      confirmTime: function (startTime, endTime, hours) { return startTime + '〜' + endTime + '（' + hours + '時間）'; },
      phoneUnset: '（未入力）',
      noteUnset: '（なし）',
      consentRequired: '予約成立条件の確認が必要です。',
      submitting: '送信中…',
      submitLabel: 'この内容で仮予約を送信する',
      diagnosticIdLabel: '\n診断ID: '
    },
    en: {
      backLabelDefault: 'Back to Studio Nagoya Base',
      invalidBrandTitle: Logic.messageForErrorCode('INVALID_BRAND', 'en'),
      dateRequired: 'Please select a date.',
      durationRequired: 'Please enter a duration of 2 hours or more (whole numbers only).',
      customerTypeRequired: 'Please select a customer type.',
      startTimeSummary: function (date, hours) { return date + ' · ' + hours + (hours === 1 ? ' hour' : ' hours'); },
      back: 'Back',
      reselectDateTime: 'Choose date & duration again',
      retryCheck: 'Check again',
      confirmTime: function (startTime, endTime, hours) { return startTime + '–' + endTime + ' (' + hours + (hours === 1 ? ' hour)' : ' hours)'); },
      phoneUnset: '(not provided)',
      noteUnset: '(none)',
      consentRequired: 'Please confirm the pending booking condition.',
      submitting: 'Submitting…',
      submitLabel: 'Submit Pending Booking',
      diagnosticIdLabel: '\nDiagnostic ID: '
    }
  }[locale];

  var backLabel = root.getAttribute('data-back-label') || UI_TEXT.backLabelDefault;

  var API_BASE_URL = (window.BookingApiConfig && window.BookingApiConfig.BASE_URL) || '';

  var state = {
    date: '',
    durationMinutes: null,
    startTime: null,
    customerType: '',
    name: '', email: '', phone: '', people: '', purpose: '', purposeOther: '',
    paymentMethod: '', note: ''
  };
  var isFetchingAvailability = false;
  var isSubmitting = false;
  var hasSubmittedSuccessfully = false;

  /* ── 要素参照 ── */
  var els = {
    progressItems: root.querySelectorAll('#ba-progress li'),
    globalError: document.getElementById('ba-global-error'),
    globalErrorMessage: document.getElementById('ba-global-error-message'),
    globalErrorActions: document.getElementById('ba-global-error-actions'),

    stepDatetime: document.getElementById('ba-step-datetime'),
    date: document.getElementById('ba-date'),
    dateError: document.getElementById('ba-date-error'),
    duration: document.getElementById('ba-duration'),
    durationError: document.getElementById('ba-duration-error'),
    customerTypeError: document.getElementById('ba-customer-type-error'),
    step1Next: document.getElementById('ba-step-datetime-next'),

    stepStartTime: document.getElementById('ba-step-start-time'),
    startTimeSummary: document.getElementById('ba-start-time-summary'),
    startTimeLoading: document.getElementById('ba-start-time-loading'),
    startTimeGrid: document.getElementById('ba-start-time-grid'),
    startTimeEmpty: document.getElementById('ba-start-time-empty'),
    step2Back: document.getElementById('ba-step-start-time-back'),
    step2Next: document.getElementById('ba-step-start-time-next'),

    stepDetails: document.getElementById('ba-step-details'),
    name: document.getElementById('ba-name'),
    nameError: document.getElementById('ba-name-error'),
    email: document.getElementById('ba-email'),
    emailError: document.getElementById('ba-email-error'),
    phone: document.getElementById('ba-phone'),
    phoneError: document.getElementById('ba-phone-error'),
    people: document.getElementById('ba-people'),
    peopleError: document.getElementById('ba-people-error'),
    purpose: document.getElementById('ba-purpose'),
    purposeError: document.getElementById('ba-purpose-error'),
    purposeOtherWrap: document.getElementById('ba-purpose-other-wrap'),
    purposeOther: document.getElementById('ba-purpose-other'),
    purposeOtherError: document.getElementById('ba-purpose-other-error'),
    paymentError: document.getElementById('ba-payment-error'),
    note: document.getElementById('ba-note'),
    noteError: document.getElementById('ba-note-error'),
    step3Back: document.getElementById('ba-step-details-back'),
    step3Next: document.getElementById('ba-step-details-next'),

    stepConfirm: document.getElementById('ba-step-confirm'),
    confirmBrand: document.getElementById('ba-confirm-brand'),
    confirmCustomerType: document.getElementById('ba-confirm-customer-type'),
    confirmDate: document.getElementById('ba-confirm-date'),
    confirmTime: document.getElementById('ba-confirm-time'),
    confirmName: document.getElementById('ba-confirm-name'),
    confirmEmail: document.getElementById('ba-confirm-email'),
    confirmPhone: document.getElementById('ba-confirm-phone'),
    confirmPeople: document.getElementById('ba-confirm-people'),
    confirmPurpose: document.getElementById('ba-confirm-purpose'),
    confirmPayment: document.getElementById('ba-confirm-payment'),
    confirmNote: document.getElementById('ba-confirm-note'),
    consent: document.getElementById('ba-confirm-consent'),
    consentError: document.getElementById('ba-consent-error'),
    submitError: document.getElementById('ba-submit-error'),
    step4Back: document.getElementById('ba-step-confirm-back'),
    submit: document.getElementById('ba-submit'),

    stepComplete: document.getElementById('ba-step-complete'),
    completeBookingId: document.getElementById('ba-complete-booking-id'),
    completeBackLink: document.getElementById('ba-complete-back-link')
  };

  /* brandが未知の場合、フロントの表示に関わらずサーバー側でも拒否されるが、
     ここでも防御的にAPIを一切呼ばず案内のみ表示する（brand偽装対策の多層防御）。 */
  if (!brandMeta) {
    showGlobalError(UI_TEXT.invalidBrandTitle, []);
    setStepDisabled_(els.step1Next, true);
    return;
  }

  /* 過去日を選べないようにするだけの技術的な下限（当日は選択可）。当日利用ルール
     （初回利用+当日の禁止）は、日付・利用区分の両方が決まるStep1の「次へ」押下時に
     Logic.isSameDayFirstTimeBlockedで判定する（Issue #270）。 */
  if (els.date) els.date.min = Logic.todayInJapan();

  /* ── ステップ切り替え ── */
  var STEP_ORDER = ['datetime', 'start-time', 'details', 'confirm', 'complete'];

  function goToStep(stepName) {
    STEP_ORDER.forEach(function (name) {
      var section = document.getElementById('ba-step-' + name);
      if (section) section.hidden = name !== stepName;
    });
    els.progressItems.forEach(function (item) {
      var name = item.getAttribute('data-step');
      var index = STEP_ORDER.indexOf(name);
      var currentIndex = STEP_ORDER.indexOf(stepName);
      item.removeAttribute('aria-current');
      item.classList.remove('ba-progress-done');
      if (name === stepName) item.setAttribute('aria-current', 'step');
      else if (index < currentIndex) item.classList.add('ba-progress-done');
    });
    var section = document.getElementById('ba-step-' + stepName);
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    hideGlobalError();
  }

  function setStepDisabled_(button, disabled) {
    if (button) button.disabled = !!disabled;
  }

  function showGlobalError(message, actionButtons) {
    if (!els.globalError) return;
    els.globalErrorMessage.textContent = message;
    els.globalErrorActions.innerHTML = '';
    (actionButtons || []).forEach(function (action) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ba-btn ba-btn-ghost';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      els.globalErrorActions.appendChild(button);
    });
    els.globalError.hidden = false;
    els.globalError.focus();
  }

  function hideGlobalError() {
    if (els.globalError) els.globalError.hidden = true;
  }

  function setFieldError_(inputEl, errorEl, message) {
    if (inputEl) inputEl.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (!errorEl) return;
    if (message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    } else {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
  }

  /* ── Step 1: 日時・利用区分 ── */
  function checkedCustomerType() {
    var checked = root.querySelector('input[name="customerType"]:checked');
    return checked ? checked.value : '';
  }

  if (els.step1Next) {
    els.step1Next.addEventListener('click', function () {
      var dateValue = els.date ? els.date.value : '';
      var durationMinutes = Logic.durationHoursToMinutes(els.duration ? els.duration.value : '');
      /* Issue #301: 1時間はStep 1で止める（UX guard）。最終判定の正はGAS側
         MIN_BOOKING_MINUTESであり、ここではUI側の入力を早期に拒否するだけ。 */
      var durationValid = Logic.isDurationAtLeastUiMinimum(durationMinutes);
      var customerType = checkedCustomerType();

      setFieldError_(els.date, els.dateError, dateValue ? '' : UI_TEXT.dateRequired);
      setFieldError_(els.duration, els.durationError, durationValid ? '' : UI_TEXT.durationRequired);
      setFieldError_(null, els.customerTypeError, customerType ? '' : UI_TEXT.customerTypeRequired);
      if (!dateValue || !durationValid || !customerType) return;

      /*
       * 初回利用＋当日はここで空き時間取得（getAvailability）へ進ませない（Issue #270）。
       * これはUX目的の一次チェックであり、最終的な当日予約可否の正はcreateBookingの
       * サーバー側検証（Booking.validateCreateBookingInput）。フロントを書き換えて
       * このチェックを回避されても、サーバー側でSAME_DAY_NOT_ALLOWED_FOR_FIRST_TIMEとして
       * 拒否される（BookingRepository.gs参照）。
       */
      if (Logic.isSameDayFirstTimeBlocked(dateValue, customerType, Logic.todayInJapan())) {
        setFieldError_(els.date, els.dateError, Logic.messageForErrorCode('SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME', locale));
        return;
      }

      state.date = dateValue;
      state.durationMinutes = durationMinutes;
      state.customerType = customerType;
      state.startTime = null;

      goToStep('start-time');
      fetchAvailability();
    });
  }

  /* ── Step 2: 開始時刻 ── */
  function fetchAvailability() {
    if (isFetchingAvailability) return;
    isFetchingAvailability = true;

    els.startTimeSummary.textContent = UI_TEXT.startTimeSummary(state.date, state.durationMinutes / 60);
    els.startTimeLoading.hidden = false;
    els.startTimeGrid.hidden = true;
    els.startTimeGrid.innerHTML = '';
    els.startTimeEmpty.hidden = true;
    setStepDisabled_(els.step2Next, true);

    if (!API_BASE_URL) {
      isFetchingAvailability = false;
      els.startTimeLoading.hidden = true;
      showGlobalError(Logic.apiNotConfiguredMessage(locale), [{ label: UI_TEXT.back, onClick: function () { goToStep('datetime'); } }]);
      return;
    }

    var url = API_BASE_URL +
      (API_BASE_URL.indexOf('?') === -1 ? '?' : '&') +
      'date=' + encodeURIComponent(state.date) +
      '&durationMinutes=' + encodeURIComponent(String(state.durationMinutes)) +
      '&brand=' + encodeURIComponent(brand);

    fetch(url, { method: 'GET' })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        isFetchingAvailability = false;
        els.startTimeLoading.hidden = true;
        if (!body || body.success !== true) {
          var code = body && body.error && body.error.code;
          showGlobalError(Logic.messageForErrorCode(code, locale), [
            { label: UI_TEXT.reselectDateTime, onClick: function () { goToStep('datetime'); } }
          ]);
          return;
        }
        renderStartTimes(body.bookableStartTimes || []);
      })
      .catch(function () {
        isFetchingAvailability = false;
        els.startTimeLoading.hidden = true;
        showGlobalError(Logic.networkErrorMessage(locale), [
          { label: UI_TEXT.retryCheck, onClick: fetchAvailability }
        ]);
      });
  }

  function renderStartTimes(times) {
    els.startTimeGrid.innerHTML = '';
    if (!times.length) {
      els.startTimeEmpty.hidden = false;
      els.startTimeGrid.hidden = true;
      return;
    }
    els.startTimeEmpty.hidden = true;
    els.startTimeGrid.hidden = false;
    times.forEach(function (time) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ba-time-slot';
      button.textContent = time;
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', function () {
        state.startTime = time;
        els.startTimeGrid.querySelectorAll('.ba-time-slot').forEach(function (el) {
          el.setAttribute('aria-pressed', el === button ? 'true' : 'false');
        });
        setStepDisabled_(els.step2Next, false);
        hideGlobalError();
      });
      els.startTimeGrid.appendChild(button);
    });
  }

  if (els.step2Back) {
    els.step2Back.addEventListener('click', function () { goToStep('datetime'); });
  }
  if (els.step2Next) {
    els.step2Next.addEventListener('click', function () {
      if (!state.startTime) return;
      goToStep('details');
    });
  }

  /* ── Step 3: 利用者情報 ── */
  if (els.purpose) {
    els.purpose.addEventListener('change', function () {
      var isOther = els.purpose.value === 'その他';
      els.purposeOtherWrap.hidden = !isOther;
      if (!isOther) setFieldError_(els.purposeOther, els.purposeOtherError, '');
    });
  }

  function checkedPaymentMethod() {
    var checked = root.querySelector('input[name="paymentMethod"]:checked');
    return checked ? checked.value : '';
  }

  if (els.step3Back) {
    els.step3Back.addEventListener('click', function () { goToStep('start-time'); });
  }

  if (els.step3Next) {
    els.step3Next.addEventListener('click', function () {
      var fields = {
        name: els.name.value,
        email: els.email.value,
        phone: els.phone.value,
        people: els.people.value,
        purpose: els.purpose.value,
        purposeOther: els.purposeOther.value,
        paymentMethod: checkedPaymentMethod(),
        note: els.note.value
      };
      var errors = Logic.validateDetailsForm(fields, locale);

      setFieldError_(els.name, els.nameError, errors.name);
      setFieldError_(els.email, els.emailError, errors.email);
      setFieldError_(els.phone, els.phoneError, errors.phone);
      setFieldError_(els.people, els.peopleError, errors.people);
      setFieldError_(els.purpose, els.purposeError, errors.purpose);
      setFieldError_(els.purposeOther, els.purposeOtherError, errors.purposeOther);
      setFieldError_(null, els.paymentError, errors.paymentMethod);
      setFieldError_(els.note, els.noteError, errors.note);

      if (Object.keys(errors).length > 0) return;

      state.name = fields.name;
      state.email = fields.email;
      state.phone = fields.phone;
      state.people = fields.people;
      state.purpose = fields.purpose;
      state.purposeOther = fields.purposeOther;
      state.paymentMethod = fields.paymentMethod;
      state.note = fields.note;

      renderConfirmSummary();
      goToStep('confirm');
    });
  }

  /* ── Step 4: 確認・送信 ── */
  function renderConfirmSummary() {
    var endTime = Logic.computeEndTime(state.startTime, state.durationMinutes);
    els.confirmBrand.textContent = brandMeta.displayName;
    els.confirmCustomerType.textContent = Logic.customerTypeLabel(state.customerType, locale);
    els.confirmDate.textContent = state.date;
    els.confirmTime.textContent = UI_TEXT.confirmTime(state.startTime, endTime, state.durationMinutes / 60);
    els.confirmName.textContent = state.name;
    els.confirmEmail.textContent = state.email;
    els.confirmPhone.textContent = state.phone || UI_TEXT.phoneUnset;
    /* 確認画面の表示のみlocale別ラベルへ変換する。送信payload（buildCreateBookingPayload）
       は引き続きstate.people/purpose/paymentMethodの内部valueをそのまま使う（Issue #297
       PR #300再レビュー対応：表示とpayloadは別物）。 */
    els.confirmPeople.textContent = Logic.peopleLabel(state.people, locale);
    els.confirmPurpose.textContent = Logic.purposeLabel(state.purpose, state.purposeOther, locale);
    els.confirmPayment.textContent = Logic.paymentMethodLabel(state.paymentMethod, locale);
    els.confirmNote.textContent = state.note || UI_TEXT.noteUnset;
  }

  if (els.step4Back) {
    els.step4Back.addEventListener('click', function () { goToStep('details'); });
  }

  function hideSubmitError() {
    if (els.submitError) els.submitError.hidden = true;
  }

  /* Issue #273の一時診断用。失敗レスポンスとGASログを突合できるよう、サーバーが
     発行した安全なrequestIdだけを表示する。診断完了後にこの追記は撤去する。 */
  function appendDiagnosticRequestId_(message, requestId) {
    var value = String(requestId || '');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(value)) return message;
    return message + UI_TEXT.diagnosticIdLabel + value;
  }

  function showSubmitError(code, requestId) {
    var message = appendDiagnosticRequestId_(Logic.messageForErrorCode(code, locale), requestId);
    var action = Logic.recoveryActionForErrorCode(code);

    /* 'reselect-time'/'edit-details' は別ステップへ移動するため、移動先でも
       #ba-global-error（ステップに関わらず常に表示できる領域）でメッセージを
       維持する。goToStep()はステップ切り替え時に一度エラーを隠すため、
       goToStepの後にshowGlobalErrorを呼ぶ順序を守ること
       （「成立したか不明」な画面のまま無言で戻さないための対応）。 */
    if (action === 'reselect-date') {
      goToStep('datetime');
      showGlobalError(message, []);
      return;
    }
    if (action === 'reselect-time') {
      goToStep('start-time');
      showGlobalError(message, []);
      fetchAvailability();
      return;
    }
    if (action === 'edit-details') {
      goToStep('details');
      showGlobalError(message, []);
      return;
    }

    /* action === 'retry' はconfirm画面に留まり、インラインで表示して再送信できるようにする */
    if (!els.submitError) return;
    els.submitError.textContent = message;
    els.submitError.hidden = false;
    els.submitError.focus();
  }

  if (els.submit) {
    els.submit.addEventListener('click', function () {
      /* 二重送信防止: 送信中・成功後はここで必ず止める（サーバー側のrate limit・
         duplicate submission抑止と合わせた多層防御）。 */
      if (isSubmitting || hasSubmittedSuccessfully) return;

      hideSubmitError();
      setFieldError_(els.consent, els.consentError, els.consent.checked ? '' : UI_TEXT.consentRequired);
      if (!els.consent.checked) return;

      if (!API_BASE_URL) {
        els.submitError.textContent = Logic.apiNotConfiguredMessage(locale);
        els.submitError.hidden = false;
        els.submitError.focus();
        return;
      }

      isSubmitting = true;
      els.submit.disabled = true;
      els.submit.textContent = UI_TEXT.submitting;

      var payload = Logic.buildCreateBookingPayload({
        brand: brand,
        customerType: state.customerType,
        date: state.date,
        startTime: state.startTime,
        durationMinutes: state.durationMinutes,
        name: state.name,
        email: state.email,
        phone: state.phone,
        people: state.people,
        purpose: state.purpose,
        purposeOther: state.purposeOther,
        paymentMethod: state.paymentMethod,
        note: state.note
      });

      fetch(API_BASE_URL, {
        method: 'POST',
        /* text/plainで送る理由はファイル冒頭のコメント参照（GAS Web AppのCORS制約） */
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      })
        .then(function (response) { return response.json(); })
        .then(function (body) {
          isSubmitting = false;
          if (!body || body.success !== true) {
            els.submit.disabled = false;
            els.submit.textContent = UI_TEXT.submitLabel;
            showSubmitError(body && body.error && body.error.code, body && body.requestId);
            return;
          }
          hasSubmittedSuccessfully = true;
          els.completeBookingId.textContent = body.bookingId || '';
          els.completeBackLink.href = backUrl;
          els.completeBackLink.textContent = backLabel;
          goToStep('complete');
        })
        .catch(function () {
          isSubmitting = false;
          els.submit.disabled = false;
          els.submit.textContent = UI_TEXT.submitLabel;
          els.submitError.textContent = Logic.networkErrorMessage(locale);
          els.submitError.hidden = false;
          els.submitError.focus();
        });
    });
  }
})();
