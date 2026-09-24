/*
 * scripts/booking-app.js — 共通予約UI（Issue #269）のDOM配線・API呼び出し本体。
 *
 * SNB / SNB mens / Studio Xの3ブランドとも、このファイルとscripts/booking-logic.js・
 * styles/booking.css・_includes/booking_app_ja.htmlをそのまま共有する（ブランド差は
 * data-brand属性・data-back-url属性・data-back-label属性のみ）。
 *
 * 空き判定・最低利用時間・15分刻み・競合判定などの業務ルールはここに実装しない。
 * getAvailability/createBooking（gas/booking/shared/, gas/booking/public/）の応答をそのまま画面へ反映するだけで、
 * GAS側を正とする。
 *
 * createBookingへのPOSTはContent-Type: text/plain;charset=utf-8で送る。GAS Web Appは
 * application/jsonを付けるとブラウザがCORSプリフライト(OPTIONS)を送り、doOptionsを
 * 実装していないApps ScriptのWeb Appでは失敗するため、CORSセーフリストに含まれる
 * text/plainで送りつつ、本文自体は引き続きJSON文字列にする
 * （gas/booking/public/Code.gsのhandleCreateBooking_はcontentsを常にJSON.parseするため
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
    timeBand: 'all',
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

    calendarHint: document.getElementById('ba-calendar-hint'),
    calendarBody: document.getElementById('ba-calendar-body'),
    calendarPrev: document.getElementById('ba-calendar-prev'),
    calendarNext: document.getElementById('ba-calendar-next'),
    calendarMonthLabel: document.getElementById('ba-calendar-month-label'),
    calendarLoading: document.getElementById('ba-calendar-loading'),
    calendarError: document.getElementById('ba-calendar-error'),
    calendarErrorMessage: document.getElementById('ba-calendar-error-message'),
    calendarRetry: document.getElementById('ba-calendar-retry'),
    calendarGridBody: document.getElementById('ba-calendar-grid-body'),
    calendarSelected: document.getElementById('ba-calendar-selected'),

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
    cardIneligibleNotice: document.getElementById('ba-card-ineligible-notice'),
    cardPaymentNotice: document.getElementById('ba-card-payment-notice'),
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
    confirmCardPaymentNotice: document.getElementById('ba-confirm-card-payment-notice'),
    confirmNote: document.getElementById('ba-confirm-note'),
    consent: document.getElementById('ba-confirm-consent'),
    consentError: document.getElementById('ba-consent-error'),
    submitError: document.getElementById('ba-submit-error'),
    step4Back: document.getElementById('ba-step-confirm-back'),
    submit: document.getElementById('ba-submit'),

    stepComplete: document.getElementById('ba-step-complete'),
    completeBookingId: document.getElementById('ba-complete-booking-id'),
    completeGenericNotice: document.getElementById('ba-complete-generic-notice'),
    completeCardPaymentNotice: document.getElementById('ba-complete-card-payment-notice'),
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

  /* linesの各要素をテキストノードとして<br>区切りで流し込む（Issue #334 PR-B）。
     innerHTMLへ文字列連結しない（linesはLogic.cardPaymentNoticeLines等が返す固定文言と
     こちらで計算した支払期限表示のみで、利用者入力は含まれないが、念のためXSS経路を
     作らない構造にする）。linesが空・未指定ならhiddenへ戻す。 */
  function renderMultilineNotice_(el, lines) {
    if (!el) return;
    if (!lines || !lines.length) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.innerHTML = '';
    lines.forEach(function (line, index) {
      if (index > 0) el.appendChild(document.createElement('br'));
      el.appendChild(document.createTextNode(line));
    });
    el.hidden = false;
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

  /*
   * 希望時間帯（Issue #324）。未選択・DOM未配線（テストスタブ等）はLogic.normalizeTimeBand
   * によりallへフォールバックする（デフォルトはallでchecked。isCalendarReady_の判定条件
   * には含めない＝時間帯未選択でもカレンダー自体は表示する）。
   */
  function checkedTimeBand() {
    var checked = root.querySelector('input[name="timeBand"]:checked');
    return Logic.normalizeTimeBand(checked ? checked.value : '');
  }

  /*
   * ── 月間空き状況カレンダー（Issue #318） ──
   * 単一日付入力（#ba-date。type="hidden"）を、1か月表示のカレンダーから選ぶ形へ
   * 置き換える。#ba-dateの値自体は引き続きこのカレンダーが書き込み、Step1の
   * 「次へ」押下時の検証（上のclickハンドラ）・SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME
   * チェックは一切変更しない（既存の開始時刻選択以降のフローをそのまま再利用する）。
   *
   * 利用時間・利用区分を先に確定してからカレンダーを描画・取得する（Issue #318追記の
   * 仕様）。月間取得はGAS側 getMonthlyAvailability(year, month, durationMinutes, brand,
   * timeBand)へのHTTPリクエスト1回（表示中の月ぶんのみ。31回連続アクセスはしない）。
   * 取得済みの月はcalendarCacheに保持し、duration/希望時間帯変更時は表示中の月だけを
   * 再取得する（cacheキーにdurationMinutes・timeBandを含めるため、変更前の組み合わせの
   * 月データはそのまま保持され、無駄な再取得や巻き戻り時の取りこぼしを起こさない。
   * Issue #324でtimeBandをキーへ追加）。
   */
  var calendarMonth = null; /* { year, month } | null（duration/customerType未確定の間はnull） */
  var calendarCache = {}; /* key: 'year-month-durationMinutes-timeBand' -> { status: 'success'|'error', days, message } */
  var calendarInFlight = {}; /* key -> true。同一キーへの重複fetchを防ぐ（PRレビュー対応。
    duration入力への'input'/'change'双方のリスナーが短時間に連続発火しても、最初の
    リクエストが解決するまでは同じキーの2回目のfetchを起こさない）。 */

  /*
   * 応答を描画してよいのは、その応答が対象とするyear/month/durationMinutes/timeBandが
   * 「今まさに表示すべき月・duration・timeBand」と一致する場合だけにする（2回目のPRレビュー
   * 対応）。以前はグローバルな連番トークンで「一番最後に発行したfetchの応答だけ」を
   * 採用していたが、これだと月A→月B→月Aと素早く往復した際、月Aの古い応答は
   * トークン不一致で捨てられる一方、月Bの（月Aへ戻った後に届く）応答がトークン一致の
   * まま月Aのグリッドへ誤って描画されてしまう競合があった（キー別in-flight管理と
   * グローバルトークンの単一採用ルールが噛み合っていなかったため）。
   * 「今のcalendarMonth/durationと一致するかどうか」で判定すれば、応答の到着順に
   * 関わらず、常に現在表示すべき月のデータだけが描画される。キャッシュへの保存自体は
   * 表示中かどうかに関わらず常に行うため、月を往復しても無駄な再取得は起きない。
   */
  function isCalendarKeyCurrent_(year, month, durationMinutes, timeBand) {
    return !!calendarMonth && calendarMonth.year === year && calendarMonth.month === month &&
      durationMinutes === currentCalendarDurationMinutes_() &&
      timeBand === currentTimeBand_();
  }

  function showCalendarLoadingState_() {
    if (els.calendarLoading) els.calendarLoading.hidden = false;
    if (els.calendarError) els.calendarError.hidden = true;
    if (els.calendarGridBody) els.calendarGridBody.innerHTML = '';
  }

  function currentCalendarDurationMinutes_() {
    return Logic.durationHoursToMinutes(els.duration ? els.duration.value : '');
  }

  function currentTimeBand_() {
    return checkedTimeBand();
  }

  function calendarCacheKey_(year, month, durationMinutes, timeBand) {
    return year + '-' + month + '-' + durationMinutes + '-' + timeBand;
  }

  function isCalendarReady_() {
    return Logic.isDurationAtLeastUiMinimum(currentCalendarDurationMinutes_()) && !!checkedCustomerType();
  }

  function handleCalendarPrereqChange_() {
    if (!isCalendarReady_()) {
      if (els.calendarBody) els.calendarBody.hidden = true;
      if (els.calendarHint) els.calendarHint.hidden = false;
      return;
    }
    if (els.calendarHint) els.calendarHint.hidden = true;
    if (els.calendarBody) els.calendarBody.hidden = false;
    if (!calendarMonth) calendarMonth = Logic.yearMonthFromDateValue(Logic.todayInJapan());
    ensureCalendarMonthLoaded_();
  }

  function renderCalendarMonthLabel_() {
    if (els.calendarMonthLabel && calendarMonth) {
      els.calendarMonthLabel.textContent = Logic.monthLabel(calendarMonth.year, calendarMonth.month, locale);
    }
  }

  function ensureCalendarMonthLoaded_() {
    if (!calendarMonth) return;
    var durationMinutes = currentCalendarDurationMinutes_();
    if (!Logic.isDurationAtLeastUiMinimum(durationMinutes)) return;
    var timeBand = currentTimeBand_();

    renderCalendarMonthLabel_();

    var key = calendarCacheKey_(calendarMonth.year, calendarMonth.month, durationMinutes, timeBand);
    var cached = calendarCache[key];
    if (cached) {
      /* 別の月（例: 月B）を読み込み中に月Aへ戻ってキャッシュがヒットした場合、
         月Bのために出したローディング表示が残ったままにならないようにする
         （PRレビュー対応）。 */
      if (els.calendarLoading) els.calendarLoading.hidden = true;
      renderCalendarGrid_(cached);
      return;
    }
    if (calendarInFlight[key]) {
      /* 同じキーへのfetchが既に進行中（例: 月A→月B→月Aと戻ってきた場合の月A）。
         ここで新たにfetchはしないが、表示だけは「読み込み中」へ揃える。応答が
         届いたときにisCalendarKeyCurrent_で現在表示中と判定されれば描画される。 */
      showCalendarLoadingState_();
      return;
    }
    fetchCalendarMonth_(calendarMonth.year, calendarMonth.month, durationMinutes, timeBand, key);
  }

  function calendarMonthlyUrl_(year, month, durationMinutes, timeBand) {
    return API_BASE_URL +
      (API_BASE_URL.indexOf('?') === -1 ? '?' : '&') +
      'action=monthly' +
      '&year=' + encodeURIComponent(String(year)) +
      '&month=' + encodeURIComponent(String(month)) +
      '&durationMinutes=' + encodeURIComponent(String(durationMinutes)) +
      '&brand=' + encodeURIComponent(brand) +
      '&timeBand=' + encodeURIComponent(String(timeBand));
  }

  /*
   * 月間空き状況の取得に失敗した場合、空いているように見せない（fail-open禁止。
   * Issue #318要件）。取得失敗時はグリッドを描画せずエラー表示のみとし、
   * どの日も選択できない状態にする。
   */
  function fetchCalendarMonth_(year, month, durationMinutes, timeBand, key) {
    if (!API_BASE_URL) {
      var notConfigured = { status: 'error', message: Logic.apiNotConfiguredMessage(locale) };
      calendarCache[key] = notConfigured;
      renderCalendarGridIfCurrent_(year, month, durationMinutes, timeBand, notConfigured);
      return;
    }

    calendarInFlight[key] = true;
    showCalendarLoadingState_();

    fetch(calendarMonthlyUrl_(year, month, durationMinutes, timeBand), { method: 'GET' })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        delete calendarInFlight[key];
        var entry;
        if (!body || body.success !== true) {
          var code = body && body.error && body.error.code;
          entry = { status: 'error', message: Logic.messageForErrorCode(code, locale) };
        } else {
          entry = { status: 'success', days: body.days || {} };
        }
        /* 表示中かどうかに関わらずキャッシュへは常に保存する（月を往復した際、
           後からこのキーへ戻ってきたときに再取得せず使えるようにするため）。 */
        calendarCache[key] = entry;
        renderCalendarGridIfCurrent_(year, month, durationMinutes, timeBand, entry);
      })
      .catch(function () {
        delete calendarInFlight[key];
        var networkErrorEntry = { status: 'error', message: Logic.networkErrorMessage(locale) };
        calendarCache[key] = networkErrorEntry;
        renderCalendarGridIfCurrent_(year, month, durationMinutes, timeBand, networkErrorEntry);
      });
  }

  /* この応答が今まさに表示すべき月・duration・timeBandのものである場合だけ描画する
     （2回目のPRレビュー対応。詳細はisCalendarKeyCurrent_のコメント参照。timeBandも
     Issue #324で判定条件へ追加した）。 */
  function renderCalendarGridIfCurrent_(year, month, durationMinutes, timeBand, entry) {
    if (!isCalendarKeyCurrent_(year, month, durationMinutes, timeBand)) return;
    if (els.calendarLoading) els.calendarLoading.hidden = true;
    renderCalendarGrid_(entry);
  }

  function renderCalendarGrid_(entry) {
    if (!calendarMonth || !els.calendarGridBody) return;

    if (!entry || entry.status !== 'success') {
      els.calendarGridBody.innerHTML = '';
      if (els.calendarError) {
        els.calendarErrorMessage.textContent = (entry && entry.message) || Logic.networkErrorMessage(locale);
        els.calendarError.hidden = false;
      }
      return;
    }
    if (els.calendarError) els.calendarError.hidden = true;

    var todayValue = Logic.todayInJapan();
    var customerType = checkedCustomerType();
    var selectedDate = els.date ? els.date.value : '';

    /*
     * duration・利用区分の変更後、以前選択した日付が新しい条件では選択不可になって
     * いる場合、選択を解除する（PRレビュー対応）。解除しないと、hiddenの#ba-dateに
     * 予約不可になった日付が残ったままStep1「次へ」を通過できてしまい、「予約不可日は
     * 選択できない」という受入条件に反する（例: 2時間で10/5を選択→6時間へ変更→
     * 10/5がFULLになった場合。returning+当日を選択→first_timeへ変更した場合も同様）。
     * 判定は現在描画中の月（＝entry.daysが対象とする月）に選択日が含まれる場合のみ行う
     * （別の月を選んだままduration等を変えても、その月の最新データが無ければここでは
     * 判定できないため、実際にその月を再描画するタイミングで改めて判定する）。
     */
    var monthPrefix = calendarMonth.year + '-' + (calendarMonth.month < 10 ? '0' : '') + calendarMonth.month + '-';
    if (selectedDate && selectedDate.indexOf(monthPrefix) === 0) {
      var selectedDayInfo = entry.days[selectedDate];
      var selectedStatus = selectedDayInfo ? selectedDayInfo.status : Logic.DAY_STATUSES.OUT_OF_RANGE;
      if (!Logic.isCalendarDaySelectable(selectedDate, selectedStatus, customerType, todayValue)) {
        els.date.value = '';
        selectedDate = '';
        if (els.calendarSelected) els.calendarSelected.textContent = '';
      }
    }

    var weeks = Logic.buildMonthMatrix(calendarMonth.year, calendarMonth.month);

    els.calendarGridBody.innerHTML = '';
    weeks.forEach(function (week) {
      var row = document.createElement('tr');
      week.forEach(function (cell) {
        var td = document.createElement('td');
        if (!cell) {
          row.appendChild(td);
          return;
        }
        var dayInfo = entry.days[cell.dateValue];
        var status = dayInfo ? dayInfo.status : Logic.DAY_STATUSES.OUT_OF_RANGE;
        var selectable = Logic.isCalendarDaySelectable(cell.dateValue, status, customerType, todayValue);

        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ba-cal-day';
        button.textContent = cell.day + Logic.dayStatusSymbol(status);
        button.setAttribute('data-date', cell.dateValue);
        button.setAttribute('aria-label', Logic.dayAriaLabel(cell.dateValue, status, customerType, todayValue, locale));
        button.disabled = !selectable;
        button.setAttribute('aria-pressed', cell.dateValue === selectedDate ? 'true' : 'false');
        if (selectable) {
          button.addEventListener('click', function () {
            els.date.value = cell.dateValue;
            setFieldError_(els.date, els.dateError, '');
            hideGlobalError();
            if (els.calendarSelected) {
              els.calendarSelected.textContent = Logic.dayAriaLabel(cell.dateValue, status, customerType, todayValue, locale);
            }
            renderCalendarGrid_(entry);
          });
        }
        td.appendChild(button);
        row.appendChild(td);
      });
      els.calendarGridBody.appendChild(row);
    });
  }

  if (els.duration) {
    els.duration.addEventListener('input', handleCalendarPrereqChange_);
    els.duration.addEventListener('change', handleCalendarPrereqChange_);
  }
  root.querySelectorAll('input[name="customerType"]').forEach(function (radio) {
    radio.addEventListener('change', handleCalendarPrereqChange_);
  });
  /* 希望時間帯（Issue #324）。isCalendarReady_の判定条件には含めないため、
     duration/利用区分と同じhandleCalendarPrereqChange_をそのまま再利用できる
     （未確定ならカレンダー非表示のまま、確定済みならensureCalendarMonthLoaded_が
     新しいtimeBand込みのキーで表示中の月だけを再取得する）。 */
  root.querySelectorAll('input[name="timeBand"]').forEach(function (radio) {
    radio.addEventListener('change', handleCalendarPrereqChange_);
  });
  if (els.calendarPrev) {
    els.calendarPrev.addEventListener('click', function () {
      if (!calendarMonth) return;
      calendarMonth = Logic.shiftMonth(calendarMonth.year, calendarMonth.month, -1);
      ensureCalendarMonthLoaded_();
    });
  }
  if (els.calendarNext) {
    els.calendarNext.addEventListener('click', function () {
      if (!calendarMonth) return;
      calendarMonth = Logic.shiftMonth(calendarMonth.year, calendarMonth.month, 1);
      ensureCalendarMonthLoaded_();
    });
  }
  if (els.calendarRetry) {
    els.calendarRetry.addEventListener('click', function () {
      if (!calendarMonth) return;
      var durationMinutes = currentCalendarDurationMinutes_();
      var timeBand = currentTimeBand_();
      delete calendarCache[calendarCacheKey_(calendarMonth.year, calendarMonth.month, durationMinutes, timeBand)];
      ensureCalendarMonthLoaded_();
    });
  }

  /*
   * 予約フォーム初期表示改善: HTML側で利用時間・利用区分・希望時間帯に初期値
   * （2時間・初回利用・指定なし）を入れてあるため、ページ読み込み直後の時点で
   * isCalendarReady_()は既にtrueになる。ユーザーの入力を待たず、この時点で
   * handleCalendarPrereqChange_を1回呼び、現在月のカレンダーを自動取得・表示する。
   * duration/利用区分/希望時間帯を変更した場合の再取得（同じ関数を再利用）・
   * 初回利用+当日ガード（isCalendarDaySelectable経由）・cache/in-flight/retry/
   * current-response判定は、このイベントリスナー群と共通のため変更しない。
   * 初期値がまだ整っていない（テストのDOMスタブ等）場合はisCalendarReady_()が
   * falseのままなので、この呼び出しは何もしない。
   */
  handleCalendarPrereqChange_();

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
      state.timeBand = checkedTimeBand();
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
        /* Step2の開始時刻一覧も、月間カレンダーで選んだ日と同じtimeBandで絞り込む
           （Issue #324本文レビュー追記2）。GAS側の単日getAvailability自体・
           このリクエストURLは変更しない（フロント側フィルタのみ）。 */
        renderStartTimes(Logic.filterStartTimesByTimeBand(body.bookableStartTimes || [], state.timeBand));
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
      updateCardPaymentGating();
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

  function cardPaymentRadio_() {
    return root.querySelector('input[name="paymentMethod"][value="' + Logic.CARD_PAYMENT_METHOD_VALUE + '"]');
  }

  /*
   * カード決済の96時間受付条件（Issue #334 PR-B「1. カード決済の受付条件」）。
   * Step2→Step3遷移時（利用日時が確定した直後）に必ず呼び直す。これにより、
   * 一度カードを選んだ後に戻って日時を変更し、96時間未満になった場合も、次にStep3へ
   * 進んだ時点で選択が解除される（「送信できない状態にする」の実装は、最終的には
   * サーバー側のCARD_PAYMENT_TOO_CLOSE_TO_START拒否が担保する多層防御の一つ）。
   */
  function updateCardPaymentGating() {
    var radio = cardPaymentRadio_();
    if (!radio) return;
    var eligible = Logic.isCardPaymentEligible(state.date, state.startTime);
    radio.disabled = !eligible;
    /* radio.closestはDOM本体では常に使えるが、テストの最小DOMスタブには実装されていない
       ことがあるため、存在確認してから使う（見た目のdisabled表現のみに関わる処理であり、
       欠けても選択不可自体はradio.disabledで担保される）。 */
    var label = typeof radio.closest === 'function' ? radio.closest('label') : null;
    if (label && label.classList) label.classList.toggle('ba-choice--disabled', !eligible);
    if (!eligible && radio.checked) {
      radio.checked = false;
    }
    if (els.cardIneligibleNotice) els.cardIneligibleNotice.hidden = eligible;
    updateCardPaymentNoticeVisibility();
  }

  /* 支払方法欄付近のカード注意書き（Issue #334 PR-B「2. カード決済の注意書き」）。
     カードが選択されている間のみ表示し、他の支払方法へ切り替えると即座に消える
     （現金・PayPay・未定にカード専用文言を混入させないため）。 */
  function updateCardPaymentNoticeVisibility() {
    if (!els.cardPaymentNotice) return;
    var isCard = Logic.isCardPaymentMethodValue(checkedPaymentMethod());
    if (!isCard) {
      renderMultilineNotice_(els.cardPaymentNotice, null);
      return;
    }
    renderMultilineNotice_(els.cardPaymentNotice, Logic.cardPaymentNoticeLines(Logic.cardPaymentDueDisplay(), locale));
  }

  /* name="paymentMethod"のラジオが切り替わるたびにカード注意書きの表示を更新する。
     ラジオ個々にリスナーを付けず、root（#booking-app）へのイベント委任にする
     （Step2以前ではまだ存在しない前提のコードを書かないため、かつテストの最小DOMスタブが
     closest()を実装していなくても動くようにするため）。 */
  root.addEventListener('change', function (event) {
    if (event.target && event.target.name === 'paymentMethod') {
      updateCardPaymentNoticeVisibility();
    }
  });

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

      /* 二重チェック（Issue #334 PR-B）: updateCardPaymentGating()は通常Step2→Step3遷移時に
         カード選択を解除済みだが、Step3に長時間滞在して96時間未満へ状態が変わった場合等に
         備え、送信直前にも再評価する。サーバー側のCARD_PAYMENT_TOO_CLOSE_TO_START拒否と
         合わせた多層防御であり、ここでの拒否メッセージも同じ案内文を使う。 */
      if (Logic.isCardPaymentMethodValue(fields.paymentMethod) && !Logic.isCardPaymentEligible(state.date, state.startTime)) {
        errors.paymentMethod = Logic.cardPaymentIneligibleNotice(locale);
        updateCardPaymentGating();
      }

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

    /* 予約確認画面のカード注意書き（Issue #334 PR-B「2. カード決済の注意書き」）。
       支払期限はここでも改めて「今、確認画面を開いた時点+72時間」で再計算する
       （送信前の目安表示。実際の期限は仮受付メールに記載されるサーバー側の値が正）。 */
    if (Logic.isCardPaymentMethodValue(state.paymentMethod)) {
      renderMultilineNotice_(els.confirmCardPaymentNotice, Logic.cardPaymentNoticeLines(Logic.cardPaymentDueDisplay(), locale));
    } else {
      renderMultilineNotice_(els.confirmCardPaymentNotice, null);
    }
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

      /* PRレビュー対応（Issue #334 PR-B）: 予約確認画面を開いたまま96時間の受付期限を
         過ぎた場合、Step3→Step4遷移時点のチェックだけでは検知できないため、送信直前にも
         必ず再評価する。期限を過ぎていれば送信自体を中止し、Step3へ戻して現地決済への
         切り替えを案内する（サーバー側のCARD_PAYMENT_TOO_CLOSE_TO_START拒否と合わせた
         多層防御。ここで止められればfetch自体を発生させない）。 */
      if (Logic.isCardPaymentMethodValue(state.paymentMethod) && !Logic.isCardPaymentEligible(state.date, state.startTime)) {
        updateCardPaymentGating();
        goToStep('details');
        showGlobalError(Logic.cardPaymentIneligibleNotice(locale), []);
        return;
      }

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
          /* 完了画面（Issue #334 PR-B）: 既存の「通常24時間以内にご連絡します」は
             確定連絡そのものが24時間以内に届くという前提の文言のため、カード決済では
             出さない（実際の確定連絡は入金確認後の承認を経るため、72時間後の支払期限まで
             届かない可能性がある）。代わりにカード注意書きを表示する。現金・PayPay・
             未定は既存文言のまま変更しない。 */
          if (Logic.isCardPaymentMethodValue(state.paymentMethod)) {
            if (els.completeGenericNotice) els.completeGenericNotice.hidden = true;
            renderMultilineNotice_(els.completeCardPaymentNotice, Logic.cardPaymentNoticeLines(Logic.cardPaymentDueDisplay(), locale));
          } else {
            if (els.completeGenericNotice) els.completeGenericNotice.hidden = false;
            renderMultilineNotice_(els.completeCardPaymentNotice, null);
          }
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
