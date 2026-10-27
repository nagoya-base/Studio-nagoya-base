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
      durationRequired: '利用時間を1時間以上の整数で入力してください。',
      customerTypeRequired: '利用区分を選択してください。',
      memberRequired: '会員区分を選択してください。',
      startTimeSummary: function (date, hours) { return date + '　' + hours + '時間利用'; },
      startTimeReselect: function (time) { return '※' + time + '開始は、変更後の利用時間では空きがありません。開始時刻を選び直してください。'; },
      searchingStartTimes: '予約できる時間を検索しています…',
      retryCheck: 'もう一度確認する',
      confirmTime: function (startTime, endTime, hours) { return startTime + '〜' + endTime + '（' + hours + '時間）'; },
      phoneUnset: '（未入力）',
      noteUnset: '（なし）',
      consentRequired: '予約成立条件の確認が必要です。',
      submitting: '送信中…',
      submitLabel: 'この内容で仮予約を送信する',
      diagnosticIdLabel: '\n診断ID: ',
      pendingStatusLabel: '仮予約受付（未確定）',
      priceLine: function (amount) { return '利用料金: ' + amount + '（税込）'; },
      timeRangeLine: function (range) { return '利用時間：' + range; },
      memberCodeFormat: '確認コード（6桁の数字）を入力してください。',
      memberCodeSent: '入力されたメールアドレス宛に、6桁の確認コードをお送りしました（60分間有効）。',
      memberVerified: 'メールアドレスの確認が完了しました（60分間有効）。会員料金・会員特典・先行予約の対象かどうかは、利用日に応じて自動で判定されます。',
      memberGeneralContinued: '一般のご予約として進めます。会員料金・会員特典・先行予約を利用する場合は、確認コードを送信して会員確認をしてください。',
      confirmMemberVerified: '確認済み'
    },
    en: {
      backLabelDefault: 'Back to Studio Nagoya Base',
      invalidBrandTitle: Logic.messageForErrorCode('INVALID_BRAND', 'en'),
      dateRequired: 'Please select a date.',
      durationRequired: 'Please enter a duration of 1 hour or more (whole numbers only).',
      customerTypeRequired: 'Please select a customer type.',
      memberRequired: 'Please select a membership type.',
      startTimeSummary: function (date, hours) { return date + ' · ' + hours + (hours === 1 ? ' hour' : ' hours'); },
      startTimeReselect: function (time) { return '* ' + time + ' is not available for the new duration. Please choose a start time again.'; },
      searchingStartTimes: 'Searching available start times…',
      retryCheck: 'Check again',
      confirmTime: function (startTime, endTime, hours) { return startTime + '–' + endTime + ' (' + hours + (hours === 1 ? ' hour)' : ' hours)'); },
      phoneUnset: '(not provided)',
      noteUnset: '(none)',
      consentRequired: 'Please confirm the pending booking condition.',
      submitting: 'Submitting…',
      submitLabel: 'Submit Pending Booking',
      diagnosticIdLabel: '\nDiagnostic ID: ',
      pendingStatusLabel: 'Pending — not confirmed yet',
      priceLine: function (amount) { return 'Price: ' + amount + ' (tax included)'; },
      timeRangeLine: function (range) { return 'Time: ' + range; },
      memberCodeFormat: 'Please enter the 6-digit verification code.',
      memberCodeSent: 'We sent a 6-digit verification code to the email address you entered (valid for 60 minutes).',
      memberVerified: 'Your email address is verified (valid for 60 minutes). Whether member rates, benefits and advance booking apply is determined automatically for your date of use.',
      memberGeneralContinued: 'Continuing as a general booking. To use member rates, benefits or advance booking, send a verification code and verify your membership.',
      confirmMemberVerified: 'Verified'
    }
  }[locale];

  /* Issue #563: Studio Xの会員確認の文言は「SNB MEMBER」「会員料金」を出さず、会員限定のオプション・先行予約として案内する。 */
  if (brand === 'studio_x') {
    if (locale === 'ja') {
      UI_TEXT.memberVerified = 'メールアドレスの確認が完了しました（60分間有効）。会員限定のオプション・先行予約の対象かどうかは、利用日に応じて自動で判定されます。';
      UI_TEXT.memberGeneralContinued = '一般のご予約として進めます。会員限定のオプション・先行予約を利用する場合は、確認コードを送信して会員確認をしてください。';
    } else {
      UI_TEXT.memberVerified = 'Your email address is verified (valid for 60 minutes). Whether member-only options and advance booking apply is determined automatically for your date of use.';
      UI_TEXT.memberGeneralContinued = 'Continuing as a general booking. To use member-only options or advance booking, send a verification code and verify your membership.';
    }
  }

  var backLabel = root.getAttribute('data-back-label') || UI_TEXT.backLabelDefault;

  var API_BASE_URL = (window.BookingApiConfig && window.BookingApiConfig.BASE_URL) || '';

  /*
   * 予約オプション（Issue #423。Studio Xのみ）。include側がdata-options="true"を付けた
   * ページ（studio-x/booking/）でだけ有効。SNB / mensのページにはスロット自体が無く、
   * 以降のoptionsPanel分岐はすべて素通りになる（既存の挙動・payloadは変わらない）。
   */
  var optionsPanel = null;

  /* 料金サマリーの部屋代（Issue #443）。見積りAPI（BookingPricing）の最新結果だけを使い、金額表は持たない。
     function宣言で巻き上げられるため、optionsPanel.mountより後で定義するlatestPriceEntryも参照できる。 */
  function currentRoomPrice_() {
    var entry = typeof latestPriceEntry === 'undefined' ? null : latestPriceEntry;
    var amount = entry && entry.status === 'success' && entry.price ? Number(entry.price.amount) : NaN;
    if (Number.isFinite(amount)) return { kind: 'estimate', status: 'ok', amountJpy: amount };
    return { kind: 'estimate', status: entry && entry.status === 'loading' ? 'pending' : 'unavailable', amountJpy: null };
  }
  var optionsSlot = document.getElementById('ba-options-slot');
  if (optionsSlot && root.getAttribute('data-options') === 'true' && window.BookingOptionsPanel) {
    optionsPanel = window.BookingOptionsPanel.mount({ slot: optionsSlot, summarySlot: document.getElementById('ba-options-summary-slot'), getRoomPrice: currentRoomPrice_, apiBaseUrl: API_BASE_URL, brand: brand });
  }

  var state = {
    date: '',
    durationMinutes: null,
    startTime: null,
    customerType: '',
    timeBand: 'all',
    isMember: false,
    name: '', email: '', phone: '', people: '', purpose: '', purposeOther: '',
    paymentMethod: '', note: ''
  };
  var isFetchingAvailability = false;
  var availabilityInFlightKey = null;
  var availabilityRequestSeq = 0;
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
    durationOther: document.getElementById('ba-duration-other'),
    durationError: document.getElementById('ba-duration-error'),
    customerTypeError: document.getElementById('ba-customer-type-error'),
    memberField: document.getElementById('ba-member-field'),
    benefitsField: document.getElementById('ba-benefits-field'),
    planPair: document.getElementById('ba-plan-pair'),
    planPairNote: document.getElementById('ba-plan-pair-note'),
    planEvent: document.getElementById('ba-plan-event'),
    planBanner: document.getElementById('ba-plan-banner'),
    planRelease: document.getElementById('ba-plan-release'),
    shower: document.getElementById('ba-shower'),
    memberVerifyField: document.getElementById('ba-member-verify-field'),
    memberCodeSend: document.getElementById('ba-member-code-send'),
    memberCodeEntry: document.getElementById('ba-member-code-entry'),
    memberCode: document.getElementById('ba-member-code'),
    memberCodeVerify: document.getElementById('ba-member-code-verify'),
    memberVerifyStatus: document.getElementById('ba-member-verify-status'),
    memberSuccess: document.getElementById('ba-member-success'),
    memberConfirmed: document.getElementById('ba-member-confirmed'),
    memberCodeSendRow: document.getElementById('ba-member-code-send-row'),
    confirmMemberRow: document.getElementById('ba-confirm-member-row'),
    confirmMember: document.getElementById('ba-confirm-member'),
    memberVerifyError: document.getElementById('ba-member-verify-error'),
    memberReverify: document.getElementById('ba-member-reverify'),
    memberReverifyMessage: document.getElementById('ba-member-reverify-message'),
    memberGeneralContinue: document.getElementById('ba-member-general-continue'),
    memberUnlockField: document.getElementById('ba-member-unlock-field'),
    memberUnlock: document.getElementById('ba-member-unlock'),
    benefitsLocked: document.getElementById('ba-benefits-locked'),
    priceExtra: document.getElementById('ba-price-extra'),
    priceExtraLine: document.getElementById('ba-price-extra-line'),
    priceExtraNote: document.getElementById('ba-price-extra-note'),
    confirmShowerRow: document.getElementById('ba-confirm-shower-row'),
    confirmShowerLabel: document.getElementById('ba-confirm-shower-label'),
    confirmShower: document.getElementById('ba-confirm-shower'),
    benefitsError: document.getElementById('ba-benefits-error'),
    memberError: document.getElementById('ba-member-error'),
    priceTime: document.getElementById('ba-price-time'),
    priceLine: document.getElementById('ba-price-line'),
    priceApplied: document.getElementById('ba-price-applied'),
    priceNote: document.getElementById('ba-price-note'),
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

    startTimeHint: document.getElementById('ba-start-time-hint'),
    startTimeArea: document.getElementById('ba-start-time-area'),
    startTimeSummary: document.getElementById('ba-start-time-summary'),
    startTimeLoading: document.getElementById('ba-start-time-loading'),
    startTimeGrid: document.getElementById('ba-start-time-grid'),
    startTimeEmpty: document.getElementById('ba-start-time-empty'),
    startTimeError: document.getElementById('ba-start-time-error'),
    startTimeErrorMessage: document.getElementById('ba-start-time-error-message'),
    startTimeErrorActions: document.getElementById('ba-start-time-error-actions'),
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
    peoplePlanHelp: document.getElementById('ba-people-plan-help'),
    purpose: document.getElementById('ba-purpose'),
    purposeError: document.getElementById('ba-purpose-error'),
    purposeOtherWrap: document.getElementById('ba-purpose-other-wrap'),
    purposeOther: document.getElementById('ba-purpose-other'),
    purposeOtherError: document.getElementById('ba-purpose-other-error'),
    paymentError: document.getElementById('ba-payment-error'),
    firstTimeCardNotice: document.getElementById('ba-first-time-card-notice'),
    cardPaymentNotice: document.getElementById('ba-card-payment-notice'),
    flowBannerTitle: document.getElementById('ba-flow-banner-title'),
    flowBannerBody: document.getElementById('ba-flow-banner-body'),
    confirmHeading: document.getElementById('ba-confirm-heading'),
    confirmFlowTitle: document.getElementById('ba-confirm-flow-title'),
    confirmFlowBody: document.getElementById('ba-confirm-flow-body'),
    consentText: document.getElementById('ba-consent-text'),
    completeHeading: document.getElementById('ba-complete-heading'),
    completeStatusLabel: document.getElementById('ba-complete-status-label'),
    note: document.getElementById('ba-note'),
    noteError: document.getElementById('ba-note-error'),
    step3Back: document.getElementById('ba-step-details-back'),
    step3Next: document.getElementById('ba-step-details-next'),

    stepConfirm: document.getElementById('ba-step-confirm'),
    confirmBrand: document.getElementById('ba-confirm-brand'),
    confirmCustomerType: document.getElementById('ba-confirm-customer-type'),
    confirmDate: document.getElementById('ba-confirm-date'),
    confirmTime: document.getElementById('ba-confirm-time'),
    confirmPrice: document.getElementById('ba-confirm-price'),
    confirmAppliedRow: document.getElementById('ba-confirm-applied-row'),
    confirmAppliedLabel: document.getElementById('ba-confirm-applied-label'),
    confirmApplied: document.getElementById('ba-confirm-applied'),
    confirmPlanRow: document.getElementById('ba-confirm-plan-row'),
    confirmPlan: document.getElementById('ba-confirm-plan'),
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
    completeBrand: document.getElementById('ba-complete-brand'),
    completeDate: document.getElementById('ba-complete-date'),
    completeTime: document.getElementById('ba-complete-time'),
    completePeople: document.getElementById('ba-complete-people'),
    completePrice: document.getElementById('ba-complete-price'),
    completePayment: document.getElementById('ba-complete-payment'),
    completeStatus: document.getElementById('ba-complete-status'),
    completeGenericNotice: document.getElementById('ba-complete-generic-notice'),
    completeCardPaymentNotice: document.getElementById('ba-complete-card-payment-notice'),
    completeCheckoutNotice: document.getElementById('ba-complete-checkout-notice'),
    completeCheckoutWrap: document.getElementById('ba-complete-checkout-wrap'),
    completeCheckoutLink: document.getElementById('ba-complete-checkout-link'),
    completeCheckoutUncertainNotice: document.getElementById('ba-complete-checkout-uncertain-notice'),
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
     （旧: 初回利用+当日の禁止）
     Issue #407以降は初回利用の当日も許可する（支払方法がカード必須になる）。 */
  if (els.date) els.date.min = Logic.todayInJapan();

  /*
   * 会員自己申告欄（Issue #342。PR #343レビュー対応でstudio_xも対象に追加）はsnb/
   * studio_xで表示する（Logic.brandShowsMemberOption）。SNB mensは常に会員相当の価格が
   * 適用されるため表示しない。HTML自体は3ブランド共通のため、表示制御だけをここで行う。
   */
  /*
   * 料金世代（'V1'|'V2'）はサーバーが返す値を正とする（Issue #532）。ブラウザ端末の時計では判断しない。
   * 月間空き状況・見積りのGET応答（priceGeneration）で更新し、判定できない間は会員区分ラジオを表示する側へ倒す。
   */
  var serverGeneration = null;
  /* Issue #563: Studio Xの会員確認（OTP）がサーバー側で必須か。料金世代とは独立（サーバーの認証フェーズ。既定は台帳照合＝false）。 */
  var serverMemberAuthRequired = false;

  /*
   * Issue #548: V2（サーバーが返す料金世代がV2。SNB / SNB mensの2026/12/1 0:00 JST以降に作成する予約）の会員確認。
   * 予約メール宛の6桁確認コード（OTP）で所有を確認すると、サーバーが「確認済み証明」（不透明な文字列。メール・用途に拘束・60分）を返す。
   * この証明はサーバー送信用に保持するだけで、フロントは証明の有効性・会員資格を判断しない（verified=true等も送らない）。
   * 会員で結果が変わる処理（先行予約・会員料金の見積り・createBooking）は証明をサーバーが検証する。V1は従来どおり（この仕組みを使わない）。
   */
  function emptyMemberAuth_(epoch) {
    return { proof: '', email: '', expiresAt: 0, advanceEligible: false, epoch: epoch, reverifyPending: false };
  }
  var memberAuth = emptyMemberAuth_(0);

  /*
   * Issue #559: テスト資格（2026/12/1より前にV2を試す管理者用）。予約ページの<head>内インライン処理が、URLフラグメント（#bt=...）から
   * 受け取って直ちにURLから除去し、sessionStorageへ保存している（gtag設定・page_viewより前。このファイルでは除去しない）。
   * - 資格はURLクエリ・GET・カスタムヘッダー・Cookie・分析ログへ載せない。必要なリクエストだけ、**POST本文のJSON**（Content-Type: text/plain）で送る
   *   （月間空き状況・見積りはテスト資格付きの専用POSTに切り替え、資格を持たない通常利用者の既存GETは変えない）。
   * - 資格の有効性・モード・許可メールとの一致はサーバーだけが判定する。フロントは期限（トークン内のexp）を端末時計で確認するのみで、
   *   モード値や世代値を送って昇格させる口は無い。
   * - 期限切れ・失効・メール変更・モード変更で資格を破棄し、通常フローへ戻す。黙って料金・特典を変えず、日程の選び直しを案内する。
   */
  var TEST_CREDENTIAL_STORAGE_KEY_ = 'snbBookingTestCredential';
  var TEST_CREDENTIAL_PATTERN_ = /^t1\.[0-9a-f]{16}\.\d{10}\.(\d{10})\.[0-9a-f]{32}\.[0-9a-f]{64}$/;
  var testCredentialEpoch_ = 0;
  var testCredentialEmail_ = '';
  var testCredentialLostHandling_ = false;
  function sessionStore_() {
    try {
      return typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : null;
    } catch (e) {
      return null;
    }
  }
  function clearStoredTestCredential_() {
    try {
      var store = sessionStore_();
      if (store) store.removeItem(TEST_CREDENTIAL_STORAGE_KEY_);
    } catch (e) { /* 保存先が使えなくても通常フローで動く */ }
  }
  function loadStoredTestCredential_() {
    if (!Logic.brandSupportsMemberAuth(brand)) return '';
    try {
      var store = sessionStore_();
      var stored = store ? store.getItem(TEST_CREDENTIAL_STORAGE_KEY_) : null;
      if (!stored) return '';
      var match = TEST_CREDENTIAL_PATTERN_.exec(stored);
      if (!match || Date.now() >= Number(match[1]) * 1e3) {
        clearStoredTestCredential_();
        return '';
      }
      return stored;
    } catch (e) {
      return '';
    }
  }
  var testCredential_ = loadStoredTestCredential_();
  function testCredentialExpiredLocally_() {
    var match = TEST_CREDENTIAL_PATTERN_.exec(testCredential_);
    return !match || Date.now() >= Number(match[1]) * 1e3;
  }
  function calendarEpochSuffix_() {
    return testCredentialEpoch_ ? '-c' + testCredentialEpoch_ : '';
  }
  /* 資格付きで送るべきときだけ { email, testCredential } を返す（メール未入力・不正の間は通常のGET＝一般利用者と同じ）。 */
  function activeTestCredentialBody_() {
    if (!testCredential_) return null;
    if (testCredentialExpiredLocally_()) { handleTestCredentialLost_(); return null; }
    if (emailErrorMessage_() !== '') return null;
    var email = normalizedEmail_();
    if (testCredentialEmail_ && testCredentialEmail_ !== email) { handleTestCredentialLost_(); return null; }
    if (!testCredentialEmail_) { testCredentialEmail_ = email; testCredentialEpoch_++; }
    return { email: email, testCredential: testCredential_ };
  }
  /* メールアドレスが確定したら資格を結び付け、空き状況・見積りを資格付きで取り直す（それまでの結果は一般利用者向け）。 */
  function bindTestCredentialIfNeeded_() {
    if (!testCredential_ || testCredentialEmail_ || emailErrorMessage_() !== '') return;
    testCredentialEmail_ = normalizedEmail_();
    testCredentialEpoch_++;
    ensureCalendarMonthLoaded_();
    refreshPriceEstimate_();
  }
  /* 資格の期限切れ・失効・メール変更・モード変更。資格と確認済み証明を破棄し、選択済みの日程を外して通常フローで取り直す。 */
  function handleTestCredentialLost_() {
    if (testCredentialLostHandling_) return;
    testCredentialLostHandling_ = true;
    try {
      testCredential_ = '';
      testCredentialEmail_ = '';
      clearStoredTestCredential_();
      testCredentialEpoch_++;
      resetMemberAuth_();
      clearSelectedDate_();
      goToStep('datetime');
      showGlobalError(Logic.messageForErrorCode('TEST_CREDENTIAL_INVALID', locale, brand), []);
      ensureCalendarMonthLoaded_();
      refreshPriceEstimate_();
    } finally {
      testCredentialLostHandling_ = false;
    }
  }
  /* 12/1以降など、資格が不要になった場合は黙って破棄する（世代・料金は変わらない）。 */
  function dropTestCredentialQuietly_() {
    testCredential_ = '';
    testCredentialEmail_ = '';
    clearStoredTestCredential_();
  }
  /* サーバー応答のtestCredentialStatus（VALID / INVALID / INACTIVE。資格を送ったリクエストにだけ付く）を反映する。 */
  function applyTestCredentialStatus_(status) {
    if (!testCredential_) return;
    if (status === 'INVALID') handleTestCredentialLost_();
    else if (status === 'INACTIVE') dropTestCredentialQuietly_();
  }

  var memberCodeSent_ = false;
  var memberCodeEmail_ = '';
  var memberCodeBusy_ = false;
  function normalizedEmail_() {
    return String(els.email ? els.email.value : '').trim().toLowerCase();
  }
  function otpMode_() {
    return Logic.usesMemberOtp(brand, serverGeneration, serverMemberAuthRequired);
  }
  function memberVerified_() {
    return otpMode_() && !!memberAuth.proof && memberAuth.email === normalizedEmail_();
  }
  function memberProofExpiredLocally_() {
    return memberVerified_() && Date.now() >= memberAuth.expiresAt;
  }
  /* 31〜90日先の先行予約枠を選べるか（V2は確認済み証明 + 今日の会員資格。V1は従来の会員向けUI）。UXのみで、最終判定はサーバー。 */
  function advanceFeaturesEnabled_() {
    return otpMode_() ? (memberVerified_() && memberAuth.advanceEligible === true) : memberFeaturesEnabled_();
  }
  /* 見積りのキーに使う会員区分。V2で確認済みなら証明の世代（epoch）を含め、証明が変われば古い見積りを再利用しない。 */
  function estimateMemberFlag_() {
    return memberVerified_() ? 'v' + memberAuth.epoch : isMemberChecked_();
  }

  function memberOptionVisible_() {
    return Logic.brandShowsMemberOption(brand, undefined, serverGeneration);
  }
  if (els.memberField) els.memberField.hidden = !memberOptionVisible_();

  /* サーバーが返した料金世代を反映する。V2は自己申告を使わないため、会員区分欄を隠し、選択済みの回答も破棄して見積りを取り直す。 */
  function applyServerGeneration_(value, memberAuthRequired) {
    var generationChanged = (value === 'V1' || value === 'V2') && value !== serverGeneration;
    /* Studio X（Issue #563）: 認証フェーズの切替（台帳照合⇄OTP）も、料金世代が同じでもUIへ反映する。 */
    /* 応答にmemberAuthRequiredが無い（undefined）場合はfalse扱いにせず、認証状態を変更しない。 */
    var authChanged = brand === 'studio_x' && typeof memberAuthRequired === 'boolean' && memberAuthRequired !== serverMemberAuthRequired;
    if (!generationChanged && !authChanged) return;
    if (generationChanged) serverGeneration = value;
    if (authChanged) serverMemberAuthRequired = memberAuthRequired === true;
    if (els.memberField) els.memberField.hidden = eventPlanSelected_() || !memberOptionVisible_();
    if (serverGeneration === 'V2') memberStatusRadios_().forEach(function (radio) { radio.checked = false; });
    /* OTPが不要になった（切戻し等）ら、確認済み証明は破棄する。 */
    if (authChanged && !serverMemberAuthRequired && memberAuth.proof) memberAuth = emptyMemberAuth_(memberAuth.epoch + 1);
    applyMemberGate_();
  }

  /* 会員限定の特典（Issue #478。SNB / SNB mens）。表示制御のみで、可否はサーバーが判定する。
     2名ペアパック（Issue #539）とシャワー（Issue #541）は「利用日が2026/12/1以降」基準で、
     利用日を選んだ時点で（予約フォームを12/1より前に開いていても）表示・選択できる。 */
  function showerVisible_() {
    return Logic.showerAvailableOnDate(brand, els.date ? els.date.value : '');
  }
  function pairPackVisible_() {
    return Logic.pairPackAvailableOnDate(brand, els.date ? els.date.value : '');
  }
  /* Issue #552: 3時間未満ではペアパックを選べない（成立しない選択をUIで防ぐ。拒否の正本はサーバー）。 */
  function pairPackDurationOk_() {
    return Logic.pairPackDurationAllowed(currentCalendarDurationMinutes_());
  }
  function benefitChoiceOf_(control) {
    return control && control.parentNode ? control.parentNode : null;
  }
  /* 利用日・日付変更のたびに特典欄の表示を同期する。ペアパックが出せなくなったら選択も外す（古い選択を送らない）。 */
  function syncBenefitsVisibility_() {
    /* Issue #546: 会員向けUIが有効でない間は、表示してもdisabledにし、選択済みも外す（UXのみ。資格の最終判定はサーバー）。 */
    var unlocked = memberFeaturesEnabled_();
    var pairVisible = pairPackVisible_();
    var pairDurationOk = pairPackDurationOk_();
    if ((!pairVisible || !unlocked || !pairDurationOk) && els.planPair) els.planPair.checked = false;
    if (els.planPair) els.planPair.disabled = !unlocked || !pairDurationOk;
    if (els.planPairNote) els.planPairNote.hidden = !(pairVisible && unlocked && !pairDurationOk);
    var pairChoice = benefitChoiceOf_(els.planPair);
    if (pairChoice) pairChoice.hidden = !pairVisible;
    var showerVisible = showerVisible_();
    if ((!showerVisible || !unlocked) && els.shower) els.shower.checked = false;
    if (els.shower) els.shower.disabled = !unlocked;
    var showerChoice = benefitChoiceOf_(els.shower);
    if (showerChoice) showerChoice.hidden = !showerVisible;
    if (els.benefitsField) els.benefitsField.hidden = !(pairVisible || showerVisible);
    if (els.benefitsLocked) els.benefitsLocked.hidden = unlocked || !(pairVisible || showerVisible);
  }

  /*
   * Issue #546: 会員限定の特典・31〜90日先の先行予約を選べるか（UX上の可否だけ。実会員資格の正本ではない）。
   * - SNB V1（会員区分ラジオ表示中）: 「会員」を選んだときだけ。
   * - SNB V2 / SNB mens（ラジオなし）: 「SNB MEMBERの特典・先行予約を利用する」を明示チェックしたときだけ。
   *   このチェックでisMember=true等は決めず、料金・資格は送らない。最終判定は予約メールと会員台帳によるサーバー側。
   * - Studio Xは対象外（既存仕様のまま常に有効扱い）。
   */
  function memberFeaturesEnabled_() {
    /* Issue #548 / #563: OTPが必須のときは、メールOTPの確認済み証明があるときだけ（自己申告のチェックでは解除できない）。
       切替前のStudio X（台帳照合）は従来どおり常に有効扱い（31〜90日先も選べる。最終判定はサーバーの台帳照合）。 */
    if (otpMode_()) return memberVerified_();
    if (!Logic.brandGatesMemberFeatures(brand)) return true;
    if (memberOptionVisible_() && memberStatusRadios_().length > 0) return checkedMemberStatus_() === 'member';
    return !!els.memberUnlock && els.memberUnlock.checked;
  }
  syncBenefitsVisibility_();
  /* 貸切ベースプラン（Issue #488 / #492。Studio Xのみ・常設）。欄は常に表示し、利用者が明示的に選んだときだけ
     プランを送る。表示制御のみで、可否（ブランド・人数・6時間以上・8:00〜21:00）はサーバーが全入口で判定する。 */
  function eventPlanSelected_() {
    return !!els.planEvent && els.planEvent.checked;
  }
  function selectedPlan_() {
    if (eventPlanSelected_()) return Logic.EVENT_BASE_PLAN_CODE;
    return pairPackVisible_() && memberFeaturesEnabled_() && pairPackDurationOk_() && els.planPair && els.planPair.checked ? Logic.PAIR_PACK_PLAN_CODE : '';
  }
  function showerSelected_() {
    return showerVisible_() && memberFeaturesEnabled_() && !!els.shower && els.shower.checked;
  }

  /* 会員区分は「一般 / 会員」のラジオ（name="memberStatus"）。単一checkboxでは「非会員と回答した」
     のか「未回答」なのか区別できないため、初期は未選択にする。サーバーへ送る isMember
     （estimatePrice/createBooking）は従来どおり真偽値のまま。 */
  function memberStatusRadios_() {
    return Array.prototype.slice.call(root.querySelectorAll('input[name="memberStatus"]') || []);
  }

  function checkedMemberStatus_() {
    var checked = root.querySelector('input[name="memberStatus"]:checked');
    return checked ? checked.value : '';
  }

  function isMemberChecked_() {
    return memberOptionVisible_() && !eventPlanSelected_() && checkedMemberStatus_() === 'member';
  }

  /* 会員区分の回答が必要か（snb/studio_xでラジオが存在する場合のみ。mensは常に会員相当で表示しない）。 */
  function memberAnswerRequired_() {
    /* イベント限定プランは会員区分と無関係の固定料金のため、会員区分の回答を求めない。 */
    return memberOptionVisible_() && !eventPlanSelected_() && memberStatusRadios_().length > 0;
  }

  function memberAnswered_() {
    return !memberAnswerRequired_() || checkedMemberStatus_() !== '';
  }

  /* ── ステップ切り替え ──
     'start-time'（開始時刻の選択）は独立した画面でも進捗項目でもなく、Step1（#ba-step-datetime）内の
     カレンダー直後に表示するエリア（#ba-start-time-area）。goToStep('start-time')は
     「Step1へ戻ってエリアを見せる」呼び出しの別名として残し、進捗は常に'datetime'として扱う
     （カレンダーを消さない）。 */
  var STEP_ORDER = ['datetime', 'details', 'confirm', 'complete'];

  function setProgress_(stepName) {
    if (stepName === 'start-time') stepName = 'datetime';
    els.progressItems.forEach(function (item) {
      var name = item.getAttribute('data-step');
      var index = STEP_ORDER.indexOf(name);
      var currentIndex = STEP_ORDER.indexOf(stepName);
      item.removeAttribute('aria-current');
      item.classList.remove('ba-progress-done');
      if (name === stepName) item.setAttribute('aria-current', 'step');
      else if (index < currentIndex) item.classList.add('ba-progress-done');
    });
  }

  function goToStep(stepName) {
    var sectionName = stepName === 'start-time' ? 'datetime' : stepName;
    STEP_ORDER.forEach(function (name) {
      var section = document.getElementById('ba-step-' + name);
      if (section) section.hidden = name !== sectionName;
    });
    setProgress_(stepName);
    if (stepName === 'start-time') setStartTimeAreaVisible_(true);
    /* 開始時刻エリアはStep1のカレンダー直後にインライン表示する。ここでは動かさず、日付クリック時のみ
       proceedFromSelectedDate_がrevealStartTimeAreaIfOffscreen_で必要なときだけ寄せる。 */
    if (stepName !== 'start-time') {
      var target = document.getElementById('ba-step-' + sectionName);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    hideGlobalError();
  }

  /* 開始時刻エリアと事前案内（#ba-start-time-hint）はカレンダー直後の同じ位置を入れ替えて使う:
     日付未選択の間は案内、日付クリック後はエリア。 */
  function setStartTimeAreaVisible_(visible) {
    if (els.startTimeArea) els.startTimeArea.hidden = !visible;
    if (els.startTimeHint) els.startTimeHint.hidden = !!visible;
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
   * 「次へ」押下時の検証（上のclickハンドラ）は一切変更しない（既存の開始時刻選択以降のフローをそのまま再利用する）。
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

  /*
   * calendarSelectionStale_: 日付を選択済みの状態でduration/利用区分/希望時間帯が変わり、
   * その選択日がまだ新しい条件で再検証されていないことを示す。この間（確認中・取得失敗）は、
   * #ba-dateに旧条件の日付が残っていても「次へ」で進めない（旧条件の日付が新条件では
   * ×になり得るため）。選択自体は保持し、成功レスポンスで再検証できた時点で解除する
   * （表示中の月以外の選択日は検証できないため、その成功描画で選択を解除する）。
   */
  var calendarSelectionStale_ = false;
  /* Issue #546: 選択中の日付が31〜90日先の会員先行枠か（月間APIのmemberAdvanceの印。日数はフロントで再計算しない）。 */
  var selectedDateMemberAdvance_ = false;
  /* Issue #546追記: 利用時間などの条件変更では、選択済みの開始時刻を無条件に捨てない。新条件で空き一覧を取り直し、
     同じ日付・同じ開始時刻が一覧にあれば再選択状態に戻す（無ければ選び直しを案内）。日付を選び直したら破棄する。 */
  var preservedStart_ = null; /* { date, time } | null */

  /*
   * resumeStartTimesAfterRecheck_: 開始時刻エリアを表示していた状態で条件（利用時間・利用区分・
   * 希望時間帯）が変わったことを示す。エリアは旧条件の一覧を残さないため一旦閉じるが、
   * 月間カレンダーの再確認後も選択日が有効なら、利用者に押し直させず、新条件で開始時刻を
   * 自動で再検索する（renderCalendarGrid_の成功時に判定）。選択日が無効になった場合や、
   * 利用者が日付を選び直した場合は解除する。
   */
  var resumeStartTimesAfterRecheck_ = false;

  function syncStep1NextEnabled_() {
    setStepDisabled_(els.step1Next, isCalendarReady_() && calendarSelectionStale_);
  }

  function showCalendarLoadingState_() {
    if (els.calendarLoading) els.calendarLoading.hidden = false;
    if (els.calendarError) els.calendarError.hidden = true;
    /* カレンダー本体は消さない。日付グリッドだけを先に描画し、全セルを「確認中」
       （クリック不可・記号なし）にする。空き状況の取得完了後にrenderCalendarGrid_が
       記号と選択可否だけを反映する（時間帯・月送りによる再取得時も同じ）。 */
    renderCalendarGrid_({ status: 'loading' });
  }

  /* 利用時間（時間）の入力値。プルダウンが「その他」のときは数値入力欄の値を使う（Issue #494） */
  function durationHoursValue_() {
    if (!els.duration) return '';
    if (els.duration.value === 'other') return els.durationOther ? els.durationOther.value : '';
    return els.duration.value;
  }
  function syncDurationOther_() {
    if (!els.durationOther || !els.duration) return;
    els.durationOther.hidden = els.duration.value !== 'other';
  }

  function currentCalendarDurationMinutes_() {
    return Logic.durationHoursToMinutes(durationHoursValue_());
  }

  function currentTimeBand_() {
    return checkedTimeBand();
  }

  function calendarCacheKey_(year, month, durationMinutes, timeBand) {
    return year + '-' + month + '-' + durationMinutes + '-' + timeBand + calendarEpochSuffix_();
  }

  function isCalendarReady_() {
    return Logic.isDurationAtLeastUiMinimum(currentCalendarDurationMinutes_()) && !!checkedCustomerType();
  }

  /* 直近に処理した条件（利用時間・利用区分・希望時間帯）。利用時間入力欄はinput後にblurで
     値の変わらないchangeも発火する。その度にカレンダーを再描画すると、日付ボタンの
     mousedown（=入力欄のblur）とmouseupの間にボタンが作り直され、最初のクリックが
     無視される。また表示中の開始時刻エリアも無駄に閉じてしまう。条件が実際に変わった
     ときだけ処理する。 */
  var lastPrereqSignature_ = null;

  function handleCalendarPrereqChange_() {
    var signature = currentCalendarDurationMinutes_() + '|' + checkedCustomerType() + '|' + currentTimeBand_();
    if (signature === lastPrereqSignature_) return;
    lastPrereqSignature_ = signature;
    /* Issue #342: 利用時間の変更は利用料金にも影響するため、ここから呼ぶ
       （duration/利用区分/希望時間帯のいずれの変更もこの関数を経由するが、
       refreshPriceEstimate_自体は日付・利用時間・会員自己申告だけで見積りキーを
       決めるため、利用区分・希望時間帯の変更では実質キャッシュヒットしfetchは
       起きない）。els.durationへ2つ目のリスナーを追加しない理由: このリポジトリの
       DOMスタブ（test/helpers）はaddEventListenerを「同じイベント名は1つだけ」保持する
       前提で実装されており、2つ目を追加すると1つ目を上書きしてしまうため。 */
    refreshPriceEstimate_();
    /* 条件（利用時間・利用区分・希望時間帯）が変わると、表示中の開始時刻一覧は旧条件の
       ものになる。古い一覧を確定値のように残さず、進行中のfetchの応答も破棄する（#365/#367）。 */
    if (els.startTimeArea && !els.startTimeArea.hidden) resumeStartTimesAfterRecheck_ = true;
    /* 連続して条件が変わっても、最初に選んでいた開始時刻を失わない（2回目の呼び出しではstate.startTimeは既にnull）。 */
    if (state.date && state.startTime && els.date && els.date.value === state.date) {
      preservedStart_ = { date: state.date, time: state.startTime };
    }
    resetStartTimeArea_();
    if (els.date && els.date.value) calendarSelectionStale_ = true;
    if (!isCalendarReady_()) {
      if (els.calendarBody) els.calendarBody.hidden = true;
      if (els.calendarHint) els.calendarHint.hidden = false;
      syncStep1NextEnabled_();
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
    var credentialBody = activeTestCredentialBody_();
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
    fetchCalendarMonth_(calendarMonth.year, calendarMonth.month, durationMinutes, timeBand, key, credentialBody);
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
   * Issue #318要件）。取得失敗時も日付グリッド自体は残し、◎○△×は表示せず、
   * エラー表示とともにどの日も選択できない状態にする。
   */
  function fetchCalendarMonth_(year, month, durationMinutes, timeBand, key, credentialBody) {
    if (!API_BASE_URL) {
      var notConfigured = { status: 'error', message: Logic.apiNotConfiguredMessage(locale) };
      calendarCache[key] = notConfigured;
      renderCalendarGridIfCurrent_(year, month, durationMinutes, timeBand, notConfigured);
      return;
    }

    calendarInFlight[key] = true;
    showCalendarLoadingState_();

    /* Issue #559: テスト資格があれば、資格付きの専用POST（本文JSON・text/plain）。無ければ従来のGET（通常利用者は変わらない）。 */
    var epoch = testCredentialEpoch_;
    var pendingMonth = credentialBody
      ? postApi_('testMonthly', {
        year: String(year), month: String(month), durationMinutes: String(durationMinutes), brand: brand, timeBand: String(timeBand),
        email: credentialBody.email, testCredential: credentialBody.testCredential
      })
      : fetch(calendarMonthlyUrl_(year, month, durationMinutes, timeBand), { method: 'GET' }).then(function (response) { return response.json(); });
    pendingMonth
      .then(function (body) {
        delete calendarInFlight[key];
        var entry;
        if (!body || body.success !== true) {
          var code = body && body.error && body.error.code;
          entry = { status: 'error', message: Logic.messageForErrorCode(code, locale, brand) };
        } else {
          entry = { status: 'success', days: body.days || {} };
        }
        /* 表示中かどうかに関わらずキャッシュへは常に保存する（月を往復した際、
           後からこのキーへ戻ってきたときに再取得せず使えるようにするため）。 */
        calendarCache[key] = entry;
        /* 資格の状態が変わった後に届いた古い応答は描画しない（取り直しは資格の切替時に済んでいる）。 */
        if (epoch !== testCredentialEpoch_) return;
        renderCalendarGridIfCurrent_(year, month, durationMinutes, timeBand, entry);
        if (entry.status === 'success') applyServerGeneration_(body.priceGeneration, body.memberAuthRequired);
        if (credentialBody && body) applyTestCredentialStatus_(body.testCredentialStatus);
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

    /* 取得中(loading)・取得失敗(error)でも日付グリッド自体は描画する。この場合、
       全セルはクリック不可で◎○△×は表示しない（fail-open禁止）。 */
    var isSuccess = !!entry && entry.status === 'success';
    var isLoading = !!entry && entry.status === 'loading';
    if (!isSuccess && !isLoading) {
      if (els.calendarError) {
        els.calendarErrorMessage.textContent = (entry && entry.message) || Logic.networkErrorMessage(locale);
        els.calendarError.hidden = false;
      }
    } else if (els.calendarError) {
      els.calendarError.hidden = true;
    }
    var days = isSuccess ? (entry.days || {}) : {};

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
    if (isSuccess && selectedDate && selectedDate.indexOf(monthPrefix) === 0) {
      var selectedDayInfo = days[selectedDate];
      var selectedStatus = selectedDayInfo ? selectedDayInfo.status : Logic.DAY_STATUSES.OUT_OF_RANGE;
      if (!Logic.isCalendarDaySelectable(selectedDate, selectedStatus, customerType, todayValue, !!(selectedDayInfo && selectedDayInfo.memberAdvance), advanceFeaturesEnabled_())) {
        els.date.value = '';
        selectedDate = '';
        selectedDateMemberAdvance_ = false;
        if (els.calendarSelected) els.calendarSelected.textContent = '';
      } else {
        selectedDateMemberAdvance_ = !!(selectedDayInfo && selectedDayInfo.memberAdvance);
      }
      calendarSelectionStale_ = false;
    } else if (isSuccess && selectedDate && calendarSelectionStale_) {
      /* 条件変更後に別の月を表示しており、選択日は新条件で検証できないため解除する。 */
      els.date.value = '';
      selectedDate = '';
      selectedDateMemberAdvance_ = false;
      calendarSelectionStale_ = false;
      if (els.calendarSelected) els.calendarSelected.textContent = '';
    }
    if (isSuccess) calendarSelectionStale_ = false;
    syncStep1NextEnabled_();
    /* 再確認の結果、選択日が新条件でも有効なら、新条件の開始時刻を自動で再検索する。
       この判定は、グリッド描画（下）より前に副作用を起こさないよう、フラグだけ先に確定する。 */
    var resumeStartTimes = isSuccess && resumeStartTimesAfterRecheck_ && !!selectedDate;
    if (isSuccess) resumeStartTimesAfterRecheck_ = false;

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
        var button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('data-date', cell.dateValue);
        if (!isSuccess) {
          /* 確認中／取得失敗: 日付のみ。クリック不可・記号なし。 */
          button.className = 'ba-cal-day ba-cal-day--pending';
          button.textContent = String(cell.day);
          button.setAttribute('aria-label', Logic.formatCalendarDayLabel(cell.dateValue, locale));
          button.disabled = true;
          if (isLoading) button.setAttribute('aria-busy', 'true');
          td.appendChild(button);
          row.appendChild(td);
          return;
        }
        var dayInfo = days[cell.dateValue];
        var status = dayInfo ? dayInfo.status : Logic.DAY_STATUSES.OUT_OF_RANGE;
        /* 31〜90日先は会員先行枠（Issue #480。APIが全員に同じ印を返す。資格の最終確認は予約送信時のサーバー側）。
           Issue #546: 会員向けUIが有効でない間は表示のみで選択不可にする（月間APIは会員別に分けない）。 */
        var memberAdvance = !!(dayInfo && dayInfo.memberAdvance);
        var selectable = Logic.isCalendarDaySelectable(cell.dateValue, status, customerType, todayValue, memberAdvance, advanceFeaturesEnabled_());
        button.className = memberAdvance ? 'ba-cal-day ba-cal-day--member-advance' : 'ba-cal-day';
        button.textContent = cell.day + Logic.dayStatusSymbol(status);
        button.setAttribute('aria-label', Logic.dayAriaLabel(cell.dateValue, status, customerType, todayValue, locale, memberAdvance, brand));
        button.disabled = !selectable;
        button.setAttribute('aria-pressed', cell.dateValue === selectedDate ? 'true' : 'false');
        if (selectable) {
          button.addEventListener('click', function () {
            els.date.value = cell.dateValue;
            if (preservedStart_ && preservedStart_.date !== cell.dateValue) preservedStart_ = null;
            selectedDateMemberAdvance_ = memberAdvance;
            setFieldError_(els.date, els.dateError, '');
            hideGlobalError();
            if (els.calendarSelected) {
              els.calendarSelected.textContent = Logic.dayAriaLabel(cell.dateValue, status, customerType, todayValue, locale, memberAdvance, brand);
            }
            renderCalendarGrid_(entry);
            refreshPriceEstimate_();
            /* 日付選択自体をStep1「次へ」と同じトリガーとして扱う（共通関数を再利用）。 */
            proceedFromSelectedDate_({ scrollToStartTime: true });
          });
        }
        td.appendChild(button);
        row.appendChild(td);
      });
      els.calendarGridBody.appendChild(row);
    });
    if (resumeStartTimes) proceedFromSelectedDate_();
  }

  /*
   * ── 利用料金の見積り（Issue #342） ──
   * 利用日・利用時間（・snb/studio_xのみ会員自己申告）が揃った時点でGASのestimatePriceを呼ぶ。
   * 料金表そのものはここに置かず、必ずGAS側（BookingPricing.gs）の値を表示する。
   * 実際に予約として保存される金額はcreateBookingのレスポンス（送信成功時のみ確定）で、
   * ここで表示する値はあくまで見積りに過ぎない（submitハンドラ参照）。
   *
   * 月間カレンダー（calendarCache/calendarInFlight/isCalendarKeyCurrent_）と同じ設計:
   * キャッシュに条件をキーとして保持し、応答が「今まさに表示すべき条件」と一致する
   * 場合だけ描画する。これにより、入力を素早く変更しても古い金額が確定値のように
   * 表示され続けることはない（変更した瞬間に必ず「計算中」へ切り替える）。
   */
  var priceEstimateCache = {}; /* key -> {status:'success', price} | {status:'error', message} */
  var priceEstimateInFlight = {};

  function priceEstimateKey_(dateValue, durationMinutes, memberFlag, plan) {
    var flag = typeof memberFlag === 'string' ? memberFlag : (memberFlag ? '1' : '0');
    return dateValue + '|' + durationMinutes + '|' + flag + '|' + (plan || '') + calendarEpochSuffix_();
  }

  function currentPriceEstimateKey_() {
    var dateValue = els.date ? els.date.value : '';
    return priceEstimateKey_(dateValue, currentCalendarDurationMinutes_(), estimateMemberFlag_(), selectedPlan_());
  }

  function priceEstimateUrl_(dateValue, durationMinutes, memberFlag, plan) {
    return API_BASE_URL +
      (API_BASE_URL.indexOf('?') === -1 ? '?' : '&') +
      'action=estimatePrice' +
      '&brand=' + encodeURIComponent(brand) +
      '&date=' + encodeURIComponent(dateValue) +
      '&durationMinutes=' + encodeURIComponent(String(durationMinutes)) +
      '&isMember=' + (memberFlag ? '1' : '0') +
      /* 2名ペアパックの見積り。見積りAPIは会員台帳を照会しない（資格の確認は予約作成時のサーバー側のみ）。 */
      (plan ? '&plan=' + encodeURIComponent(plan) : '');
  }

  /* lineEl/noteElの組へ、現在の見積り状態を描画する。取得中・失敗時はlineElを必ず
     隠し、noteElへ理由を表示する（古い金額を確定料金として出さないための唯一の描画元）。 */
  function renderPriceEntryInto_(lineEl, noteEl, entry) {
    if (!lineEl && !noteEl) return;
    if (!entry || entry.status === 'unset') {
      if (lineEl) lineEl.hidden = true;
      if (noteEl) noteEl.textContent = '';
      return;
    }
    if (entry.status === 'loading') {
      if (lineEl) lineEl.hidden = true;
      if (noteEl) noteEl.textContent = Logic.priceComputingLabel(locale);
      return;
    }
    if (entry.status === 'error') {
      if (lineEl) lineEl.hidden = true;
      if (noteEl) noteEl.textContent = entry.message || Logic.priceUnavailableLabel(locale);
      return;
    }
    var formatted = Logic.formatJpyAmount(entry.price && entry.price.amount);
    if (!formatted) {
      if (lineEl) lineEl.hidden = true;
      if (noteEl) noteEl.textContent = Logic.priceUnavailableLabel(locale);
      return;
    }
    if (noteEl) noteEl.textContent = '';
    if (lineEl) {
      lineEl.textContent = UI_TEXT.priceLine(formatted);
      lineEl.hidden = false;
    }
  }

  /* Issue #520: 料金表示の近くに、選択済みの開始〜終了時刻（と利用時間）を出す。
     開始時刻・利用時間はstate（開始時刻ボタンのclickで設定、条件変更で必ずnullへ戻る）だけを
     参照し、未選択なら隠す。料金計算・見積りとは独立した表示専用の描画。 */
  function renderPriceTimeRange_() {
    if (!els.priceTime) return;
    var endTime = state.startTime && state.durationMinutes ? Logic.computeEndTime(state.startTime, state.durationMinutes) : '';
    if (!endTime) {
      els.priceTime.textContent = '';
      els.priceTime.hidden = true;
      return;
    }
    els.priceTime.textContent = UI_TEXT.timeRangeLine(UI_TEXT.confirmTime(state.startTime, endTime, state.durationMinutes / 60));
    els.priceTime.hidden = false;
  }

  /* latestPriceEntryはStep4確認画面（renderConfirmSummary）・送信直前の再確認からも
     参照する共有状態（「今わかっている最新の見積り」）。 */
  var latestPriceEntry = { status: 'unset' };

  /* Step4確認画面の<td>のような、hidden切り替えを持たないプレーンなテキスト表示先で使う。
     Step1に到達済みであれば通常'unset'/'loading'にはならないが、念のため
     「計算中」表示にフォールバックする（古い金額を出さないための同じ方針）。 */
  function priceDisplayText_(entry) {
    if (!entry || entry.status === 'unset' || entry.status === 'loading') return Logic.priceComputingLabel(locale);
    if (entry.status === 'error') return entry.message || Logic.priceUnavailableLabel(locale);
    var formatted = Logic.formatJpyAmount(entry.price && entry.price.amount);
    return formatted ? UI_TEXT.priceLine(formatted) : Logic.priceUnavailableLabel(locale);
  }

  /*
   * PRレビュー対応（Issue #342）: Step4確認画面の料金表示（els.confirmPrice）も
   * ここへ含める。以前はrenderConfirmSummary()内で一度だけ（Step4表示時点の
   * latestPriceEntryを読んで）設定していたが、その後に見積りAPIの応答が届いても
   * els.confirmPriceは更新されず、Step4に古い「計算中」表示や別条件の金額が
   * 残り続める不具合があった。ここへ含めることで、Step4表示中・表示前を問わず、
   * 応答が「今の入力条件と一致する場合だけ」（renderPriceEverywhereIfCurrent_）
   * Step4の表示も含めて常に最新化される。els.confirmPriceが存在しない（まだStep4に
   * 到達していない）場合はrenderPriceEntryInto_同様に何もしない。
   */
  /* Issue #539: 適用料金／適用プランは、金額と同じ見積り応答（entry.price）からだけ導出する。成功した見積り以外
     （計算中・失敗・未確定）では必ず隠し、古い区分を金額と食い違ったまま残さない。 */
  function renderAppliedRate_(entry) {
    var info = entry && entry.status === 'success' && Logic.formatJpyAmount(entry.price && entry.price.amount)
      ? Logic.appliedRateInfo(entry.price, locale)
      : null;
    if (els.priceApplied) {
      els.priceApplied.textContent = info ? info.text : '';
      els.priceApplied.hidden = !info;
    }
    if (els.confirmAppliedRow) els.confirmAppliedRow.hidden = !info;
    if (els.confirmAppliedLabel && info) els.confirmAppliedLabel.textContent = info.label;
    if (els.confirmApplied) els.confirmApplied.textContent = info ? info.value : '';
  }

  function renderPriceEverywhere_(entry) {
    latestPriceEntry = entry;
    if (optionsPanel && optionsPanel.refreshSummary) optionsPanel.refreshSummary();
    renderPriceEntryInto_(els.priceLine, els.priceNote, entry);
    renderAppliedRate_(entry);
    renderShowerExtra_();
    renderPriceTimeRange_();
    if (els.confirmPrice) els.confirmPrice.textContent = priceDisplayText_(entry);
  }

  function renderPriceEverywhereIfCurrent_(key, entry) {
    if (key !== currentPriceEstimateKey_()) return;
    renderPriceEverywhere_(entry);
  }

  function refreshPriceEstimate_() {
    syncBenefitsVisibility_();
    /* Issue #548: 保持している確認済み証明が（端末の時計で）期限切れなら、見積りの前に再確認を求める（黙って一般料金へ切り替えない）。 */
    if (memberProofExpiredLocally_()) { handleReverifyRequired_(); return; }
    var credentialBody = activeTestCredentialBody_();
    var dateValue = els.date ? els.date.value : '';
    var durationMinutes = currentCalendarDurationMinutes_();
    var memberFlag = estimateMemberFlag_();
    var plan = selectedPlan_();

    /* snb/studio_xは会員区分が確定してから料金を表示する（未回答のまま一般料金を出さない）。 */
    if (!dateValue || !Logic.isDurationAtLeastUiMinimum(durationMinutes) || !memberAnswered_()) {
      renderPriceEverywhere_({ status: 'unset' });
      return;
    }

    var key = priceEstimateKey_(dateValue, durationMinutes, memberFlag, plan);
    var cached = priceEstimateCache[key];
    if (cached) {
      renderPriceEverywhere_(cached);
      return;
    }

    renderPriceEverywhere_({ status: 'loading' });

    if (!API_BASE_URL) {
      var notConfigured = { status: 'error', message: Logic.apiNotConfiguredMessage(locale) };
      priceEstimateCache[key] = notConfigured;
      renderPriceEverywhereIfCurrent_(key, notConfigured);
      return;
    }
    if (priceEstimateInFlight[key]) return;
    priceEstimateInFlight[key] = true;

    /* Issue #548: V2で確認済みなら、会員料金の見積りは証明を検証するPOST（bookingMemberStatus）で取得する（GETのisMemberは使わない）。 */
    var verifiedQuote = memberVerified_();
    var estimateEpoch = testCredentialEpoch_;
    var memberStatusPayload = { brand: brand, email: memberAuth.email, proof: memberAuth.proof, date: dateValue, durationMinutes: durationMinutes, plan: plan };
    if (credentialBody) memberStatusPayload.testCredential = credentialBody.testCredential;
    var pendingEstimate = verifiedQuote
      ? postApi_('bookingMemberStatus', memberStatusPayload)
      : credentialBody
        /* Issue #559: テスト資格付きの見積りはPOST（本文JSON・text/plain）。資格が無い通常利用者は従来のGET。 */
        ? postApi_('testEstimatePrice', {
          brand: brand, date: dateValue, durationMinutes: String(durationMinutes), isMember: memberFlag ? '1' : '0', plan: plan || '',
          email: credentialBody.email, testCredential: credentialBody.testCredential
        })
        : fetch(priceEstimateUrl_(dateValue, durationMinutes, memberFlag, plan), { method: 'GET' }).then(function (response) { return response.json(); });
    pendingEstimate
      .then(function (body) {
        delete priceEstimateInFlight[key];
        if (estimateEpoch !== testCredentialEpoch_) return;
        var entry;
        if (verifiedQuote && body && body.success !== true && body.error && body.error.code === 'MEMBER_REVERIFY_REQUIRED') {
          /* 証明がサーバーで無効（期限切れ等）。古い見積りとして残さず再確認を求める。 */
          if (key === currentPriceEstimateKey_()) handleReverifyRequired_();
          return;
        }
        if (!body || body.success !== true || (verifiedQuote && !body.price)) {
          var code = body && body.error && body.error.code;
          entry = { status: 'error', message: Logic.messageForErrorCode(code, locale, brand) };
        } else {
          entry = { status: 'success', price: body.price };
        }
        priceEstimateCache[key] = entry;
        renderPriceEverywhereIfCurrent_(key, entry);
        if (entry.status === 'success') applyServerGeneration_(body.priceGeneration, body.memberAuthRequired);
        if (credentialBody && body) applyTestCredentialStatus_(body.testCredentialStatus);
      })
      .catch(function () {
        delete priceEstimateInFlight[key];
        var networkErrorEntry = { status: 'error', message: Logic.networkErrorMessage(locale) };
        priceEstimateCache[key] = networkErrorEntry;
        renderPriceEverywhereIfCurrent_(key, networkErrorEntry);
      });
  }

  /* Issue #546: 会員向けUIの切替（会員区分・UI解除・料金世代）で、会員限定の選択状態を同期する。
     無効になったら、ペアパック・シャワーを外し、31〜90日先を選択済みなら利用日・開始時刻・見積りも解除する
     （古い日付・料金・確認画面の内容を残さない）。有効になった場合は選択可否の再描画だけ行う。 */
  function syncMemberUnlockField_() {
    if (!els.memberUnlockField) return;
    var radiosShown = memberOptionVisible_() && !eventPlanSelected_();
    /* Issue #548: V2はメールOTPの会員確認が唯一の解除手段。自己申告のチェックは出さず、選択済みも破棄する（V1の間だけ表示）。 */
    var otp = otpMode_();
    els.memberUnlockField.hidden = !Logic.brandGatesMemberFeatures(brand) || radiosShown || otp;
    if ((radiosShown || otp) && els.memberUnlock) els.memberUnlock.checked = false;
  }

  /* ── Issue #548: V2の会員確認（メールOTP）UI ── */
  function postApi_(action, payload) {
    var endpoint = API_BASE_URL + (API_BASE_URL.indexOf('?') === -1 ? '?' : '&') + 'action=' + action;
    return fetch(endpoint, {
      method: 'POST',
      /* text/plainで送る理由はファイル冒頭のコメント参照（GAS Web AppのCORS制約） */
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (response) { return response.json(); });
  }

  function setMemberVerifyStatus_(text) {
    if (!els.memberVerifyStatus) return;
    els.memberVerifyStatus.textContent = text || '';
    els.memberVerifyStatus.hidden = !text;
  }

  function showMemberVerifyError_(text) {
    if (!els.memberVerifyError) return;
    els.memberVerifyError.textContent = text || '';
    els.memberVerifyError.hidden = !text;
  }

  function renderMemberVerify_() {
    var otp = otpMode_();
    if (els.memberVerifyField) els.memberVerifyField.hidden = !otp;
    if (els.memberCodeEntry) els.memberCodeEntry.hidden = !otp || !memberCodeSent_ || memberVerified_();
    if (els.memberReverify) els.memberReverify.hidden = !otp || !memberAuth.reverifyPending;
    if (els.memberReverifyMessage) els.memberReverifyMessage.textContent = Logic.messageForErrorCode('MEMBER_REVERIFY_REQUIRED', locale, brand);
    /* Issue #567: 確認済みは同じカード内の成功表示へ切り替える（送信ボタン行は非表示ではなく成功表示に置き換える）。
       確認済みでない状態（未送信・失効・再確認待ち）では成功表示を必ず隠し、誤って「確認済み」を残さない。 */
    var verified = memberVerified_();
    /* OTP成功はメール所有の確認であって会員資格の成立ではない。今日の会員資格が確認できた（advanceEligible）ときだけ会員向けの成功表示にし、
       それ以外は「メールアドレスの確認完了」に留めて特典を使えるとは断定しない。 */
    var memberCard = otp && verified && memberAuth.advanceEligible === true;
    var neutralCard = otp && verified && !memberCard;
    if (els.memberSuccess) els.memberSuccess.hidden = !memberCard;
    if (els.memberConfirmed) els.memberConfirmed.hidden = !neutralCard;
    if (els.memberCodeSendRow) els.memberCodeSendRow.hidden = otp && verified;
    if (verified) setMemberVerifyStatus_(els.memberSuccess ? '' : UI_TEXT.memberVerified);
    else if (!memberCodeSent_) setMemberVerifyStatus_('');
  }

  /* 確認済み証明を破棄する（メール変更・期限切れ）。会員料金・会員特典・先行予約は安全側（一般・30日）へ戻す。
     reverify=trueは期限切れ等で会員利用中だった可能性があるため、利用者が再確認するか「一般予約として続ける」を選ぶまで先へ進ませない。 */
  function resetMemberAuth_(options) {
    var hadProof = !!memberAuth.proof;
    var reverify = !!(options && options.reverify);
    memberAuth = emptyMemberAuth_(memberAuth.epoch + 1);
    memberAuth.reverifyPending = reverify;
    memberCodeSent_ = false;
    setMemberVerifyStatus_('');
    showMemberVerifyError_('');
    if (els.memberCode) els.memberCode.value = '';
    renderMemberVerify_();
    if (hadProof || reverify) applyMemberGate_();
  }

  function revealMemberVerify_() {
    if (els.memberVerifyField && typeof els.memberVerifyField.scrollIntoView === 'function') els.memberVerifyField.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function handleReverifyRequired_() {
    resetMemberAuth_({ reverify: true });
    revealMemberVerify_();
  }

  /* 端末の時計で期限切れの証明を持っていたら再確認へ。再確認待ち（一般予約へ戻る明示操作が未了）なら先へ進ませない。 */
  function reverifyBlocked_() {
    if (memberProofExpiredLocally_()) handleReverifyRequired_();
    if (!otpMode_() || !memberAuth.reverifyPending) return false;
    showGlobalError(Logic.messageForErrorCode('MEMBER_REVERIFY_REQUIRED', locale, brand), []);
    revealMemberVerify_();
    return true;
  }

  if (els.memberCodeSend) {
    els.memberCodeSend.addEventListener('click', function () {
      if (memberCodeBusy_) return;
      var message = emailErrorMessage_();
      setFieldError_(els.email, els.emailError, message);
      if (message) { focusEmail_(); return; }
      if (!API_BASE_URL) { showMemberVerifyError_(Logic.apiNotConfiguredMessage(locale)); return; }
      memberCodeBusy_ = true;
      els.memberCodeSend.disabled = true;
      showMemberVerifyError_('');
      var codeRequest = { email: String(els.email.value).trim() };
      if (brand === 'studio_x') codeRequest.brand = brand;
      /* Issue #563: Studio XのTESTフェーズでは、テスト資格を送ってOTP対象のリクエストとして扱わせる（資格が無ければサーバーはLEGACYのまま）。 */
      var codeCredential = activeTestCredentialBody_();
      if (codeCredential) codeRequest.testCredential = codeCredential.testCredential;
      postApi_('requestBookingMemberCode', codeRequest)
        .then(function (body) {
          if (!body || body.success !== true) {
            showMemberVerifyError_(Logic.messageForErrorCode(body && body.error && body.error.code, locale, brand));
            return;
          }
          memberCodeSent_ = true;
          memberCodeEmail_ = normalizedEmail_();
          setMemberVerifyStatus_(body.message || UI_TEXT.memberCodeSent);
          renderMemberVerify_();
          if (els.memberCode && typeof els.memberCode.focus === 'function') els.memberCode.focus();
        })
        .catch(function () { showMemberVerifyError_(Logic.networkErrorMessage(locale)); })
        .then(function () { memberCodeBusy_ = false; els.memberCodeSend.disabled = false; });
    });
  }

  if (els.memberCodeVerify) {
    els.memberCodeVerify.addEventListener('click', function () {
      if (memberCodeBusy_) return;
      var code = String(els.memberCode ? els.memberCode.value : '').trim();
      if (!/^\d{6}$/.test(code)) { showMemberVerifyError_(UI_TEXT.memberCodeFormat); return; }
      var emailAtRequest = normalizedEmail_();
      memberCodeBusy_ = true;
      els.memberCodeVerify.disabled = true;
      showMemberVerifyError_('');
      postApi_('verifyBookingMemberCode', { email: String(els.email.value).trim(), code: code })
        .then(function (body) {
          if (!body || body.success !== true || !body.proof) {
            showMemberVerifyError_(Logic.messageForErrorCode(body && body.error && body.error.code, locale, brand));
            return;
          }
          /* 確認コードの入力中にメールアドレスが変わっていたら、その証明は使わない（証明はメールに拘束される）。 */
          if (emailAtRequest !== normalizedEmail_()) { showMemberVerifyError_(Logic.messageForErrorCode('INVALID_CODE', locale, brand)); return; }
          memberAuth = {
            proof: body.proof,
            email: emailAtRequest,
            expiresAt: Date.now() + (Number(body.expiresInMinutes) > 0 ? Number(body.expiresInMinutes) : 60) * 60 * 1e3,
            advanceEligible: body.advanceEligible === true,
            epoch: memberAuth.epoch + 1,
            reverifyPending: false
          };
          memberCodeSent_ = false;
          if (els.memberCode) els.memberCode.value = '';
          renderMemberVerify_();
          applyMemberGate_();
        })
        .catch(function () { showMemberVerifyError_(Logic.networkErrorMessage(locale)); })
        .then(function () { memberCodeBusy_ = false; els.memberCodeVerify.disabled = false; });
    });
  }

  if (els.memberGeneralContinue) {
    els.memberGeneralContinue.addEventListener('click', function () {
      /* 利用者自身が明示的に一般予約へ戻る操作。会員料金・会員特典・先行予約は使わず、一般として進める。 */
      memberAuth.reverifyPending = false;
      hideGlobalError();
      renderMemberVerify_();
      setMemberVerifyStatus_(UI_TEXT.memberGeneralContinued);
    });
  }
  function clearSelectedDate_() {
    if (els.date) els.date.value = '';
    if (els.calendarSelected) els.calendarSelected.textContent = '';
    selectedDateMemberAdvance_ = false;
    preservedStart_ = null;
    calendarSelectionStale_ = false;
    resumeStartTimesAfterRecheck_ = false;
    state.date = '';
    resetStartTimeArea_();
    syncStep1NextEnabled_();
  }
  function applyMemberGate_() {
    syncMemberUnlockField_();
    renderMemberVerify_();
    if (!memberFeaturesEnabled_()) {
      if (els.planPair) els.planPair.checked = false;
      if (els.shower) els.shower.checked = false;
      if (selectedDateMemberAdvance_) clearSelectedDate_();
    } else if (!advanceFeaturesEnabled_() && selectedDateMemberAdvance_) {
      /* 確認済みでも今日の会員資格が無ければ、31〜90日先の先行予約日は選べない。 */
      clearSelectedDate_();
    }
    if (calendarMonth && isCalendarReady_()) {
      var cached = calendarCache[calendarCacheKey_(calendarMonth.year, calendarMonth.month, currentCalendarDurationMinutes_(), currentTimeBand_())];
      if (cached) renderCalendarGrid_(cached);
    }
    refreshPriceEstimate_();
  }

  /* Issue #546: シャワーは部屋料金に含めず、承認後に別途決済する追加オプション。確定合計へ加算せず別行で表示する。
     金額はoptionCatalog（サーバーの正本）のshower.priceJpyだけを使い、フロントに価格を持たない。 */
  var showerPriceJpy_ = null;
  var showerPriceRequested_ = false;
  function ensureShowerPrice_() {
    if (showerPriceRequested_ || !API_BASE_URL || typeof fetch !== 'function') return;
    showerPriceRequested_ = true;
    try {
      fetch(API_BASE_URL + (API_BASE_URL.indexOf('?') === -1 ? '?' : '&') + 'action=optionCatalog&brand=' + encodeURIComponent(brand))
        .then(function (response) { return response.json(); })
        .then(function (body) {
          var price = body && body.success === true && body.catalog && body.catalog.shower ? Number(body.catalog.shower.priceJpy) : NaN;
          if (Number.isFinite(price)) { showerPriceJpy_ = price; renderShowerExtra_(); }
        })
        .catch(function () { showerPriceRequested_ = false; });
    } catch (e) { showerPriceRequested_ = false; }
  }
  function renderShowerExtra_() {
    var selected = showerSelected_();
    var info = selected ? Logic.showerExtraInfo(showerPriceJpy_, locale) : null;
    if (selected && showerPriceJpy_ === null) ensureShowerPrice_();
    if (els.priceExtra) els.priceExtra.hidden = !info;
    if (els.priceExtraLine) els.priceExtraLine.textContent = info ? info.text : '';
    if (els.priceExtraNote) els.priceExtraNote.textContent = info ? info.notes.join(' ') : '';
    if (els.confirmShowerRow) els.confirmShowerRow.hidden = !info;
    if (els.confirmShowerLabel && info) els.confirmShowerLabel.textContent = info.label;
    if (els.confirmShower) els.confirmShower.textContent = info ? info.value + '（' + info.confirmNote + '）' : '';
  }

  [els.planPair, els.shower].forEach(function (control) {
    if (control) control.addEventListener('change', function () { refreshPriceEstimate_(); });
  });

  /* 貸切ベースプラン（Issue #510）の選択に合わせ、利用時間の選択肢を6〜13時間（1時間単位）に絞り、初期値を6時間にする。
     6時間固定ではなく、7時間・8時間…と増やせる。外すと元の入力に戻す。終了が21:00を超える開始時刻は一覧から外す（fetchAvailability）。 */
  var eventPlanDurationApplied_ = false;
  function applyEventPlanDurationOptions_(selected) {
    Array.prototype.slice.call(els.duration.options).forEach(function (option) {
      option.disabled = selected && !Logic.isEventPlanDurationHours(option.value);
    });
  }
  /* Issue #513: 貸切ベースプラン中だけ5〜10名を選べる（'5名以上・要相談'は選べない）。解除時は通常の選択肢に戻し、
     5〜10名が選ばれていたら空に戻して通常予約の上限を超える値を残さない。サーバー側でも同じ上限で拒否する。 */
  function applyEventPlanPeopleOptions_(selected) {
    if (!els.people) return;
    Array.prototype.slice.call(els.people.options).forEach(function (option) {
      var planOnly = option.getAttribute('data-event-plan-only') === '1';
      if (planOnly) {
        option.disabled = !selected;
        option.hidden = !selected;
      } else if (option.value === '5名以上・要相談') {
        option.disabled = selected;
        option.hidden = selected;
      }
    });
    var current = els.people.value;
    var invalid = selected ? (current && !Logic.isEventPlanPeopleValue(current)) : /^(?:[5-9]|10)名$/.test(current);
    if (invalid) els.people.value = '';
    if (els.peoplePlanHelp) els.peoplePlanHelp.hidden = !selected;
  }
  function applyEventPlanState_() {
    var selected = eventPlanSelected_();
    applyEventPlanPeopleOptions_(selected);
    if (els.duration) {
      applyEventPlanDurationOptions_(selected);
      if (selected) {
        if (!Logic.isEventPlanDurationHours(els.duration.value)) els.duration.value = String(Logic.EVENT_BASE_PLAN_MIN_HOURS);
        if (els.durationOther) { els.durationOther.value = ''; els.durationOther.disabled = true; }
      } else {
        /* 解除時は通常の時間選択へ戻し、プラン用の初期値のままにせず初期値（3時間）へ戻す（Issue #494） */
        if (eventPlanDurationApplied_) els.duration.value = String(Logic.DEFAULT_DURATION_HOURS || 3);
        if (els.durationOther) els.durationOther.disabled = false;
      }
      eventPlanDurationApplied_ = selected;
      syncDurationOther_();
    }
    if (els.memberField) els.memberField.hidden = selected || !memberOptionVisible_();
    /* Issue #496: ベースプラン中は追加オプション欄を畳み、選択済みの内容（数量・スタッフサービス含む）を破棄する。
       解除しても以前の選択は復元しない。確認画面・payload・見積りはパネルが空を返すため自動で除外される。 */
    if (optionsPanel && optionsPanel.setSuspended) {
      optionsPanel.setSuspended(selected);
      var optionsErrorEl = document.getElementById('ba-options-error');
      if (optionsErrorEl) { optionsErrorEl.textContent = ''; optionsErrorEl.hidden = true; }
    }
    /* Issue #500: プラン選択済みであることを示すバナー。解除すると通常予約へ戻る。 */
    if (els.planBanner) els.planBanner.hidden = !selected;
    handleCalendarPrereqChange_();
    refreshPriceEstimate_();
  }
  if (els.planEvent) els.planEvent.addEventListener('change', applyEventPlanState_);

  /* Issue #500: 解除したらURLの plan も外し、再読込や戻る操作で勝手に再選択されないようにする。 */
  function clearPlanParam_() {
    try {
      var params = window.location.search.replace(/^\?/, '').split('&').filter(function (kv) { return kv && kv.split('=')[0] !== 'plan'; });
      var url = window.location.pathname + (params.length ? '?' + params.join('&') : '') + window.location.hash;
      if (window.history && window.history.replaceState) window.history.replaceState(null, '', url);
    } catch (e) { /* URL書き換えに失敗しても予約操作は続行する */ }
  }
  if (els.planEvent) els.planEvent.addEventListener('change', function () { if (!els.planEvent.checked) clearPlanParam_(); });
  if (els.planRelease && els.planEvent) {
    els.planRelease.addEventListener('click', function () {
      els.planEvent.checked = false;
      applyEventPlanState_();
      clearPlanParam_();
      els.planEvent.focus();
    });
  }

  if (els.duration) {
    els.duration.addEventListener('input', function () { syncDurationOther_(); handleCalendarPrereqChange_(); });
    els.duration.addEventListener('change', function () { syncDurationOther_(); handleCalendarPrereqChange_(); });
  }
  if (els.durationOther) {
    els.durationOther.addEventListener('input', handleCalendarPrereqChange_);
    els.durationOther.addEventListener('change', handleCalendarPrereqChange_);
  }
  memberStatusRadios_().forEach(function (radio) {
    radio.addEventListener('change', function () {
      setFieldError_(null, els.memberError, '');
      applyMemberGate_();
    });
  });
  if (els.memberUnlock) els.memberUnlock.addEventListener('change', applyMemberGate_);
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
   * カレンダー選択（isCalendarDaySelectable経由）・cache/in-flight/retry/
   * current-response判定は、このイベントリスナー群と共通のため変更しない。
   * 初期値がまだ整っていない（テストのDOMスタブ等）場合はisCalendarReady_()が
   * falseのままなので、この呼び出しは何もしない。
   */
  handleCalendarPrereqChange_();
  applyMemberGate_();

  /*
   * Step1の検証・state反映・開始時刻エリアの表示・空き時間取得を行う共通処理。
   * カレンダーの日付クリック（自動遷移）と、フォールバック用の非表示Step1ボタンの
   * 両方がこの関数だけを呼ぶ（予約条件のロジックを2箇所に持たない）。
   */
  function proceedFromSelectedDate_(options) {
    /* 空き状況の確認中・取得失敗の間は、以前選んだ日付が残っていても進めない。 */
    if (isCalendarReady_() && calendarSelectionStale_) return;
    /* Issue #548: 会員確認の期限切れ後は、再確認または「一般予約として続ける」を選ぶまで先へ進ませない。 */
    if (reverifyBlocked_()) return;
    resumeStartTimesAfterRecheck_ = false;
    var dateValue = els.date ? els.date.value : '';
    var durationMinutes = Logic.durationHoursToMinutes(durationHoursValue_());
    /* Issue #301/#410: 最低利用時間（1時間）未満はStep 1で止める（UX guard）。最終判定の正はGAS側
       MIN_BOOKING_MINUTESであり、ここではUI側の入力を早期に拒否するだけ。 */
    var durationValid = Logic.isDurationAtLeastUiMinimum(durationMinutes);
    var customerType = checkedCustomerType();

    /* メールアドレスは予約フォームの前半（Step1）で1回だけ入力する（Issue #532）。Step2で再入力させず、
       最終送信にもこの値をそのまま使う。会員資格は送信時にサーバーが予約メールと利用日で自動判定する。 */
    var emailMessage = emailErrorMessage_();
    setFieldError_(els.email, els.emailError, emailMessage);
    setFieldError_(els.date, els.dateError, dateValue ? '' : UI_TEXT.dateRequired);
    setFieldError_(els.duration, els.durationError, durationValid ? '' : UI_TEXT.durationRequired);
    setFieldError_(null, els.customerTypeError, customerType ? '' : UI_TEXT.customerTypeRequired);
    if (emailMessage) { resetStartTimeArea_(); focusEmail_(); return; }
    if (!dateValue || !durationValid || !customerType) { resetStartTimeArea_(); return; }
    state.email = els.email.value;

    state.date = dateValue;
    state.durationMinutes = durationMinutes;
    state.customerType = customerType;
    state.timeBand = checkedTimeBand();
    state.isMember = isMemberChecked_();
    state.startTime = null;
    renderPriceTimeRange_();

    /* カレンダーは隠さない（goToStep('start-time')でStep1全体を切り替えない）。
       Step1最下部の開始時刻エリアを表示し、その中だけをローディング→一覧へ切り替える。 */
    hideGlobalError();
    setStartTimeAreaVisible_(true);
    setProgress_('datetime');
    fetchAvailability();
    refreshPriceEstimate_();
    /* 日付クリック由来のときだけ、検索中表示が画面外なら見える位置まで寄せる。
       条件変更の自動再検索・フォールバックボタンでは画面を動かさない。 */
    if (options && options.scrollToStartTime === true) revealStartTimeAreaIfOffscreen_();
  }

  function revealStartTimeAreaIfOffscreen_() {
    var area = els.startTimeArea;
    if (!area || typeof area.scrollIntoView !== 'function') return;
    var probe = els.startTimeLoading || area;
    if (typeof probe.getBoundingClientRect === 'function') {
      var rect = probe.getBoundingClientRect();
      var viewportHeight = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
      if (viewportHeight && rect.top >= 0 && rect.bottom <= viewportHeight) return;
    }
    area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  if (els.step1Next) {
    els.step1Next.addEventListener('click', proceedFromSelectedDate_);
  }

  /* メールアドレス（Step1）。入力が有効になった時点でエラーを消し、日付が選択済みで開始時刻エリアが未表示なら先へ進める。 */
  function emailErrorMessage_() {
    return Logic.validateEmailField(els.email ? els.email.value : '', locale);
  }

  function focusEmail_() {
    if (!els.email) return;
    if (typeof els.email.scrollIntoView === 'function') els.email.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (typeof els.email.focus === 'function') els.email.focus();
  }

  /* Issue #548: メールアドレスが変わったら、確認済み証明・先行予約資格・会員料金/特典を即破棄して安全側（一般・30日）へ戻す。 */
  function discardMemberAuthIfEmailChanged_() {
    /* Issue #559: テスト資格を結び付けたメールアドレスから変わったら、資格を破棄して通常フローへ戻す。 */
    if (testCredential_ && testCredentialEmail_ && testCredentialEmail_ !== normalizedEmail_()) {
      handleTestCredentialLost_();
    } else if (memberAuth.proof && memberAuth.email !== normalizedEmail_()) {
      resetMemberAuth_();
    } else if (memberCodeSent_ && memberCodeEmail_ !== normalizedEmail_()) {
      /* 別のメールアドレス宛に送った確認コードの入力欄は閉じる。 */
      memberCodeSent_ = false;
      setMemberVerifyStatus_('');
      renderMemberVerify_();
    }
  }

  if (els.email) {
    els.email.addEventListener('input', discardMemberAuthIfEmailChanged_);
    els.email.addEventListener('change', function () {
      discardMemberAuthIfEmailChanged_();
      var message = emailErrorMessage_();
      setFieldError_(els.email, els.emailError, message);
      if (message) return;
      state.email = els.email.value;
      bindTestCredentialIfNeeded_();
      if (els.date && els.date.value && els.startTimeArea && els.startTimeArea.hidden) proceedFromSelectedDate_();
    });
  }

  /* ── 開始時刻（Step1最下部のエリア） ── */
  function hideStartTimeError_() {
    if (els.startTimeError) els.startTimeError.hidden = true;
  }

  /* 検索エリア内にエラーと再試行導線を出す（Step1全体・別画面へは切り替えない）。
     エリアが無いDOM（テストのスタブ等）ではグローバルエラーへフォールバックする。 */
  function showStartTimeError_(message, actions) {
    if (!els.startTimeError || !els.startTimeErrorMessage || !els.startTimeErrorActions) {
      showGlobalError(message, actions);
      return;
    }
    els.startTimeErrorMessage.textContent = message;
    els.startTimeErrorActions.innerHTML = '';
    (actions || []).forEach(function (action) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ba-btn ba-btn-ghost';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      els.startTimeErrorActions.appendChild(button);
    });
    els.startTimeError.hidden = false;
  }

  /* 開始時刻エリアを初期状態（非表示・空）へ戻し、進行中のfetchの応答も破棄する。 */
  function resetStartTimeArea_() {
    availabilityRequestSeq++;
    isFetchingAvailability = false;
    availabilityInFlightKey = null;
    state.startTime = null;
    renderPriceTimeRange_();
    setStartTimeAreaVisible_(false);
    if (els.startTimeLoading) els.startTimeLoading.hidden = true;
    if (els.startTimeGrid) { els.startTimeGrid.hidden = true; els.startTimeGrid.innerHTML = ''; }
    if (els.startTimeEmpty) els.startTimeEmpty.hidden = true;
    hideStartTimeError_();
    setStepDisabled_(els.step2Next, true);
    /* エリアを閉じたら進捗表示も「利用日・時間」へ戻す（状態と表示をずらさない）。 */
    if (els.stepDatetime && !els.stepDatetime.hidden) setProgress_('datetime');
  }

  function fetchAvailability() {
    /* 同じ条件のfetchが実行中なら二重発火しない。条件が違う場合（別の日付をクリック）は
       新しいfetchを開始し、古い応答は連番で判別して捨てる。 */
    var requestKey = state.date + '|' + state.durationMinutes + '|' + state.timeBand + '|' + brand;
    if (isFetchingAvailability && availabilityInFlightKey === requestKey) return;
    isFetchingAvailability = true;
    availabilityInFlightKey = requestKey;
    var requestSeq = ++availabilityRequestSeq;

    /* fetch開始前に必ず「検索中」を表示する。旧日付の一覧・エラーは即クリアし、
       状態が変わる間も領域を空白にしない。 */
    state.startTime = null;
    renderPriceTimeRange_();
    els.startTimeSummary.textContent = UI_TEXT.startTimeSummary(state.date, state.durationMinutes / 60);
    els.startTimeLoading.textContent = UI_TEXT.searchingStartTimes;
    els.startTimeLoading.hidden = false;
    els.startTimeGrid.hidden = true;
    els.startTimeGrid.innerHTML = '';
    els.startTimeEmpty.hidden = true;
    hideStartTimeError_();
    setStepDisabled_(els.step2Next, true);

    if (!API_BASE_URL) {
      isFetchingAvailability = false;
      els.startTimeLoading.hidden = true;
      showStartTimeError_(Logic.apiNotConfiguredMessage(locale), []);
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
        if (requestSeq !== availabilityRequestSeq) return;
        isFetchingAvailability = false;
        els.startTimeLoading.hidden = true;
        if (!body || body.success !== true) {
          var code = body && body.error && body.error.code;
          showStartTimeError_(Logic.messageForErrorCode(code, locale, brand), [
            { label: UI_TEXT.retryCheck, onClick: fetchAvailability }
          ]);
          return;
        }
        /* 開始時刻一覧も、月間カレンダーで選んだ日と同じtimeBandで絞り込む
           （Issue #324本文レビュー追記2）。GAS側の単日getAvailability自体・
           このリクエストURLは変更しない（フロント側フィルタのみ）。 */
        var bandTimes = Logic.filterStartTimesByTimeBand(body.bookableStartTimes || [], state.timeBand);
        /* Issue #510: 貸切ベースプランは8:00〜21:00の範囲。終了が21:00を超える開始時刻は出さない（サーバーでも拒否する）。 */
        renderStartTimes(eventPlanSelected_() ? Logic.filterStartTimesForEventPlan(bandTimes, state.durationMinutes) : bandTimes);
      })
      .catch(function () {
        if (requestSeq !== availabilityRequestSeq) return;
        isFetchingAvailability = false;
        els.startTimeLoading.hidden = true;
        showStartTimeError_(Logic.networkErrorMessage(locale), [
          { label: UI_TEXT.retryCheck, onClick: fetchAvailability }
        ]);
      });
  }

  function renderStartTimes(times) {
    els.startTimeGrid.innerHTML = '';
    var preserved = preservedStart_;
    preservedStart_ = null;
    if (!times.length) {
      els.startTimeEmpty.hidden = false;
      els.startTimeGrid.hidden = true;
      return;
    }
    els.startTimeEmpty.hidden = true;
    els.startTimeGrid.hidden = false;
    var restored = false;
    times.forEach(function (time) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'ba-time-slot';
      button.textContent = time;
      button.setAttribute('aria-pressed', 'false');
      function select() {
        state.startTime = time;
        renderPriceTimeRange_();
        els.startTimeGrid.querySelectorAll('.ba-time-slot').forEach(function (el) {
          el.setAttribute('aria-pressed', el === button ? 'true' : 'false');
        });
        setStepDisabled_(els.step2Next, false);
        hideGlobalError();
      }
      button.addEventListener('click', select);
      els.startTimeGrid.appendChild(button);
      /* 条件変更前と同じ日付・同じ開始時刻が新条件でも空いていれば、そのまま選択状態に戻す。 */
      if (preserved && preserved.date === state.date && preserved.time === time) { select(); restored = true; }
    });
    if (preserved && preserved.date === state.date && !restored && els.startTimeSummary) {
      els.startTimeSummary.textContent += ' ' + UI_TEXT.startTimeReselect(preserved.time);
    }
  }

  if (els.step2Next) {
    els.step2Next.addEventListener('click', function () {
      if (!state.startTime) return;
      if (reverifyBlocked_()) return;
      /* 会員区分（snb/studio_x）は未回答のまま進ませない。料金も会員区分の確定後にだけ表示する。 */
      if (!memberAnswered_()) {
        setFieldError_(null, els.memberError, UI_TEXT.memberRequired);
        return;
      }
      state.isMember = isMemberChecked_();
      updatePaymentMethodGating();
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
   * 支払方法の選択制御（Issue #407）。カード決済は日程にかかわらず選べる（旧96時間受付制限は撤廃）。
   * 初回利用はカード固定: カード以外のラジオを選べなくし、カードを選択済みにする。
   * 利用経験ありへ戻した場合は解除して従来どおり全て選べる。Step2→Step3遷移時に呼び直す。
   * 最終的な拒否はサーバー側（FIRST_TIME_CARD_PAYMENT_REQUIRED）が担保する。
   */
  function updatePaymentMethodGating() {
    var radio = cardPaymentRadio_();
    if (!radio) return;
    var firstTime = Logic.isFirstTimeCardRequired(state.customerType);
    root.querySelectorAll('input[name="paymentMethod"]').forEach(function (other) {
      if (other === radio) return;
      other.disabled = firstTime;
      /* closestはDOM本体では常に使えるが、テストの最小DOMスタブには実装されていないことが
         あるため、存在確認してから使う（見た目のdisabled表現のみに関わる処理）。 */
      var otherLabel = typeof other.closest === 'function' ? other.closest('label') : null;
      if (otherLabel && otherLabel.classList) otherLabel.classList.toggle('ba-choice--disabled', firstTime);
      if (firstTime && other.checked) other.checked = false;
    });
    if (firstTime) radio.checked = true;
    if (els.firstTimeCardNotice) els.firstTimeCardNotice.hidden = !firstTime;
    updateCardPaymentNoticeVisibility();
  }

  /* 支払方法欄付近のカード注意書き（Issue #334 PR-B「2. カード決済の注意書き」）。
     カードが選択されている間のみ表示し、他の支払方法へ切り替えると即座に消える
     （現金・PayPay・未定にカード専用文言を混入させないため）。 */
  function setText_(el, text) {
    if (el) el.textContent = text;
  }

  /* 支払方法に応じた案内の切替（Issue #445）。フォーム上部バナー・確認画面の案内/同意文/見出し・
     送信ボタン文言を、選択中の支払方法（カード／現金・PayPay・未定／未選択）で一括更新する。
     送信処理・Stripe Checkout遷移ロジックには関与しない（表示文言のみ）。 */
  function updateBookingFlowCopy_() {
    var copy = Logic.bookingFlowCopy(checkedPaymentMethod(), locale);
    setText_(els.flowBannerTitle, copy.banner.title);
    setText_(els.flowBannerBody, copy.banner.body);
    var confirmCopy = Logic.bookingFlowCopy(state.paymentMethod || checkedPaymentMethod(), locale);
    var confirmKind = confirmCopy.kind === 'neutral' ? Logic.bookingFlowCopy('未定', locale) : confirmCopy;
    setText_(els.confirmHeading, confirmKind.confirmHeading);
    setText_(els.confirmFlowTitle, confirmKind.banner.title);
    setText_(els.confirmFlowBody, confirmKind.banner.body);
    setText_(els.consentText, confirmKind.consent);
    if (els.submit && !isSubmitting) els.submit.textContent = submitLabelFor_(state.paymentMethod || checkedPaymentMethod());
  }

  function submitLabelFor_(paymentMethod) {
    return Logic.isCardPaymentMethodValue(paymentMethod)
      ? Logic.bookingFlowCopy(paymentMethod, locale).submitLabel
      : UI_TEXT.submitLabel;
  }

  function updateCardPaymentNoticeVisibility() {
    updateBookingFlowCopy_();
    if (!els.cardPaymentNotice) return;
    var isCard = Logic.isCardPaymentMethodValue(checkedPaymentMethod());
    if (!isCard) {
      renderMultilineNotice_(els.cardPaymentNotice, null);
      return;
    }
    renderMultilineNotice_(els.cardPaymentNotice, Logic.cardPaymentNoticeLines(locale));
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

      /* 貸切ベースプランは10名まで・最低6時間（8:00〜21:00。サーバー側でも同じ条件で拒否する）。 */
      if (eventPlanSelected_()) {
        if (fields.people && !Logic.isEventPlanPeopleValue(fields.people)) {
          errors.people = Logic.messageForErrorCode('EVENT_PLAN_PEOPLE_EXCEEDED', locale, brand);
        }
      } else if (selectedPlan_()) {
        /* 2名ペアパックは1〜2名・3時間以上（サーバー側でも同じ条件で拒否する）。 */
        if (fields.people && !Logic.isPairPackPeopleValue(fields.people)) {
          errors.people = Logic.messageForErrorCode('PAIR_PACK_PEOPLE_EXCEEDED', locale, brand);
        }
        if (state.durationMinutes < 180 && els.benefitsError) {
          els.benefitsError.textContent = Logic.messageForErrorCode('PLAN_DURATION_INVALID', locale, brand);
          els.benefitsError.hidden = false;
          return;
        }
      }
      if (els.benefitsError) els.benefitsError.hidden = true;

      /* 二重チェック（Issue #407）: 初回利用はカード以外を送信させない（サーバー側と同じ条件）。 */
      if (fields.paymentMethod && !Logic.isPaymentMethodAllowedForCustomer(state.customerType, fields.paymentMethod)) {
        errors.paymentMethod = Logic.messageForErrorCode('FIRST_TIME_CARD_PAYMENT_REQUIRED', locale, brand);
      }

      /* メールアドレスの入力欄はStep1にある。ここで不正（Step1を経ずに値が変わった等）なら、Step1へ戻して直させる。 */
      setFieldError_(els.email, els.emailError, errors.email);
      if (errors.email) {
        goToStep('datetime');
        focusEmail_();
        return;
      }
      setFieldError_(els.name, els.nameError, errors.name);
      setFieldError_(els.phone, els.phoneError, errors.phone);
      setFieldError_(els.people, els.peopleError, errors.people);
      setFieldError_(els.purpose, els.purposeError, errors.purpose);
      setFieldError_(els.purposeOther, els.purposeOtherError, errors.purposeOther);
      setFieldError_(null, els.paymentError, errors.paymentMethod);
      setFieldError_(els.note, els.noteError, errors.note);

      var optionsErrorEl = document.getElementById('ba-options-error');
      var optionsErrorText = optionsPanel ? optionsPanel.validate() : '';
      if (optionsErrorEl) {
        optionsErrorEl.textContent = optionsErrorText;
        optionsErrorEl.hidden = !optionsErrorText;
      }
      if (optionsErrorText) return;

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
    /* Issue #488 / #492: 貸切ベースプランを選んだときだけ、プラン名と責任範囲を確認画面に出す。 */
    if (els.confirmPlanRow) {
      els.confirmPlanRow.hidden = !eventPlanSelected_();
      if (els.confirmPlan) els.confirmPlan.textContent = eventPlanSelected_() ? Logic.EVENT_BASE_PLAN_LABEL : '';
    }
    els.confirmTime.textContent = UI_TEXT.confirmTime(state.startTime, endTime, state.durationMinutes / 60);
    /*
     * 利用料金（Issue #342。PRレビュー対応）。ここでは表示更新のトリガーとして
     * refreshPriceEstimate_()を呼ぶだけで、els.confirmPriceへの実際の書き込みは
     * renderPriceEverywhere_（refreshPriceEstimate_から同期的または非同期に呼ばれる）に
     * 一元化している。日付・利用時間・会員自己申告はStep1確定後に変わらないため、
     * 通常はここに来る前に取得済み（キャッシュヒットで即時反映）だが、万一まだ
     * 取得中・未取得の場合でも、renderPriceEverywhereが応答到着時にStep4の表示を
     * 含めて自動的に最新化する（古い金額のまま固定される問題の修正）。
     */
    refreshPriceEstimate_();
    var confirmOptionsRow = document.getElementById('ba-confirm-options-row');
    var confirmOptions = document.getElementById('ba-confirm-options');
    if (confirmOptionsRow && confirmOptions) {
      var optionLines = optionsPanel ? optionsPanel.summaryLines() : [];
      confirmOptions.textContent = optionLines.join(' / ');
      confirmOptionsRow.hidden = optionLines.length === 0;
    }
    els.confirmName.textContent = state.name;
    els.confirmEmail.textContent = state.email;
    /* Issue #567: 確認画面にも会員確認の状態を出す。確認済み（失効していない）ときだけ表示し、未確認では行ごと隠す。 */
    if (els.confirmMemberRow) {
      var memberConfirmed = memberVerified_() && !memberProofExpiredLocally_();
      els.confirmMemberRow.hidden = !memberConfirmed;
      if (els.confirmMember) els.confirmMember.textContent = memberConfirmed ? UI_TEXT.confirmMemberVerified : '';
    }
    els.confirmPhone.textContent = state.phone || UI_TEXT.phoneUnset;
    /* 確認画面の表示のみlocale別ラベルへ変換する。送信payload（buildCreateBookingPayload）
       は引き続きstate.people/purpose/paymentMethodの内部valueをそのまま使う（Issue #297
       PR #300再レビュー対応：表示とpayloadは別物）。 */
    els.confirmPeople.textContent = Logic.peopleLabel(state.people, locale);
    els.confirmPurpose.textContent = Logic.purposeLabel(state.purpose, state.purposeOther, locale);
    els.confirmPayment.textContent = Logic.paymentMethodLabel(state.paymentMethod, locale);
    els.confirmNote.textContent = state.note || UI_TEXT.noteUnset;

    /* 予約確認画面のカード注意書き（Issue #334 PR-B / Issue #407）。支払期限は申込後に表示される
       Stripe Checkoutの決済ページの有効期限が正のため、ここでは日時を表示しない。 */
    if (Logic.isCardPaymentMethodValue(state.paymentMethod)) {
      renderMultilineNotice_(els.confirmCardPaymentNotice, Logic.cardPaymentNoticeLines(locale));
    } else {
      renderMultilineNotice_(els.confirmCardPaymentNotice, null);
    }
    /* 確認画面の見出し・案内・同意文・送信ボタンを選択済み支払方法に合わせる（Issue #445）。 */
    updateBookingFlowCopy_();
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
    var message = appendDiagnosticRequestId_(Logic.messageForErrorCode(code, locale, brand), requestId);
    var action = Logic.recoveryActionForErrorCode(code);

    /* Issue #559: テスト資格が送信時点で無効（期限切れ・失効・モード変更）。予約は作られていない。資格を破棄して通常フローで選び直してもらう。 */
    if (code === 'TEST_CREDENTIAL_INVALID') {
      handleTestCredentialLost_();
      return;
    }

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
    /* Issue #548: 会員確認が無い／期限切れ。予約は作られていない。証明を破棄し、Step1の会員確認（再送）か一般予約へ戻る操作を求める。 */
    if (action === 'reverify') {
      if (code === 'MEMBER_REVERIFY_REQUIRED') handleReverifyRequired_();
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

  /*
   * PR #354レビュー対応・項目3: 「Stripe Checkoutが開始されていないと確実に判断できる」
   * エラーコードだけを、運営からの個別案内（旧Payment Link方式）へのフォールバック対象とする。
   * これ以外（Session作成結果が確認できない、台帳への保存が失敗した、決済済みの可能性が
   * ある等）を安易に「これから決済リンクを送ります」という案内へ丸めてしまうと、既に
   * Stripe側で決済試行が進んでいるかもしれない予約について、後日さらに別経路（旧
   * Payment Link）でも支払わせてしまい、二重決済につながる恐れがある。
   * CHECKOUT_DISABLED: キルスイッチが無効（本番の既定状態）。STRIPE_NOT_CONFIGURED:
   * 決済機能自体が未設定。いずれもGAS側がStripe APIを一切呼んでいないと確定できる。
   */
  var CHECKOUT_SAFE_FALLBACK_CODES_ = ['CHECKOUT_DISABLED', 'STRIPE_NOT_CONFIGURED'];

  /* オプション由来で予約が作られなかった場合のerror.code（BookingOptions.gs / OptionOrderService.gs）。 */
  var OPTION_ERROR_CODES_ = [
    'INVALID_OPTIONS', 'UNKNOWN_OPTION', 'SETUP_METHOD_REQUIRED', 'CLEANUP_METHOD_REQUIRED', 'LAYOUT_REQUIRED_FOR_STAFF_SERVICE', 'STAFF_SERVICE_SINGLE_THEME',
    'OPTIONS_NOT_AVAILABLE', 'PRICE_NOT_CONFIGURED', 'VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE',
    'DUPLICATE_OPTION', 'SERVICE_MODE_CONFLICT', 'STAFF_SERVICE_THEME_MISMATCH', 'EVENT_PLAN_OPTIONS_NOT_ALLOWED'
  ];

  /* 完了画面のオプション結果（Issue #423）。部屋予約とは別の状態であることを明示する。 */
  function renderOptionsResult_(result) {
    var target = document.getElementById('ba-complete-options');
    if (!target) return;
    target.textContent = '';
    if (!result) { target.hidden = true; return; }
    var lines = [];
    if (result.success) {
      lines.push('オプションのお申し込みを受け付けました（ご予約とは別の状態で管理します）。');
      (result.orders || []).forEach(function (order) {
        var itemLabels = (order.items || []).map(function (i) { return i.label; }).join('、');
        lines.push('・' + itemLabels + '：' + window.BookingOptionsPanel.describeOrderStatus(order));
      });
      lines.push('お支払いや状況のご確認は、受付メールの案内ページ（予約IDとご登録のメールアドレスで確認します）から行えます。');
    } else {
      lines.push(window.BookingOptionsPanel.describeError(result.error));
    }
    lines.forEach(function (line) {
      var p = document.createElement('p');
      p.textContent = line;
      target.appendChild(p);
    });
    target.hidden = false;
  }

  /*
   * Stripe Checkout Session発行（Issue #341 PR-B）。createBooking成功後、カード決済のみ
   * 追加で呼ぶ。戻り値は必ず次のいずれか（rejectしない。このリクエストの失敗が仮予約
   * 受付自体の完了表示を止めてはならないため）:
   * - { status: 'success', checkoutUrl }: Checkout Sessionを発行できた。
   * - { status: 'fallback', code }: CHECKOUT_SAFE_FALLBACK_CODES_のいずれか。Checkoutは
   *   確実に未着手のため、運営から決済方法を案内する旨の案内（日時の約束なし）を表示してよい。
   * - { status: 'uncertain', code }: 上記以外のすべて（ネットワーク障害・タイムアウト・
   *   応答の解析失敗を含む）。Checkoutが実際に開始された可能性を否定できないため、
   *   旧方式へは誘導せず専用のエラー・再試行案内を表示する。
   */
  function attemptCardCheckout_(bookingId, checkoutAccessToken) {
    if (!API_BASE_URL || !bookingId || !checkoutAccessToken) {
      return Promise.resolve({ status: 'fallback', code: 'CHECKOUT_DISABLED' });
    }
    var checkoutEndpoint = API_BASE_URL + (API_BASE_URL.indexOf('?') === -1 ? '?' : '&') + 'action=startCardCheckout';
    return fetch(checkoutEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ bookingId: bookingId, checkoutAccessToken: checkoutAccessToken })
    })
      .then(function (response) { return response.json(); })
      .then(function (result) {
        if (result && result.success === true && result.checkoutUrl) {
          return { status: 'success', checkoutUrl: result.checkoutUrl, paymentHoldExpiresAt: result.paymentHoldExpiresAt };
        }
        var code = result && result.error && result.error.code;
        if (CHECKOUT_SAFE_FALLBACK_CODES_.indexOf(code) !== -1) {
          return { status: 'fallback', code: code };
        }
        return { status: 'uncertain', code: code || 'UNKNOWN' };
      })
      .catch(function () {
        /* fetch自体の失敗（オフライン・タイムアウト等）はGAS側で何が起きたか一切分からない
           ため、安全側のuncertain扱いとする（旧方式へは絶対にフォールバックしない）。 */
        return { status: 'uncertain', code: 'NETWORK_ERROR' };
      });
  }

  if (els.submit) {
    els.submit.addEventListener('click', function () {
      /* 二重送信防止: 送信中・成功後はここで必ず止める（サーバー側のrate limit・
         duplicate submission抑止と合わせた多層防御）。 */
      if (isSubmitting || hasSubmittedSuccessfully) return;

      /* Issue #548: 会員確認が期限切れ（端末の時計）または再確認待ちなら、送信せずStep1の会員確認へ戻す（黙って一般料金で送らない）。 */
      if (reverifyBlocked_()) { goToStep('datetime'); showGlobalError(Logic.messageForErrorCode('MEMBER_REVERIFY_REQUIRED', locale, brand), []); return; }

      hideSubmitError();
      setFieldError_(els.consent, els.consentError, els.consent.checked ? '' : UI_TEXT.consentRequired);
      if (!els.consent.checked) return;

      /* 送信直前にも初回利用のカード必須を再確認する（サーバー側のFIRST_TIME_CARD_PAYMENT_REQUIRED拒否と
         合わせた多層防御。ここで止められればfetch自体を発生させない）。 */
      if (!Logic.isPaymentMethodAllowedForCustomer(state.customerType, state.paymentMethod)) {
        updatePaymentMethodGating();
        goToStep('details');
        showGlobalError(Logic.messageForErrorCode('FIRST_TIME_CARD_PAYMENT_REQUIRED', locale, brand), []);
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
        note: state.note,
        isMember: state.isMember,
        plan: selectedPlan_(),
        shower: showerSelected_(),
        /* Issue #548: V2で確認済みなら、サーバーが発行した証明を送る。有効性・予約メールとの一致・会員資格はサーバーが再判定する。 */
        memberProof: memberVerified_() ? memberAuth.proof : '',
        /* Issue #559: テスト資格はPOST本文のJSONだけで送る。有効性・予約メールとの一致・モードはサーバーが判定する。 */
        testCredential: (function () { var body = activeTestCredentialBody_(); return body ? body.testCredential : ''; })()
      });
      /* オプションは選択内容のみ送る（金額・承認状態はサーバーが決める）。未選択ならキー自体を付けない。 */
      var optionsSelection = optionsPanel ? optionsPanel.getSelection() : null;
      if (optionsSelection) payload.options = optionsSelection;

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
            els.submit.textContent = submitLabelFor_(state.paymentMethod);
            if (optionsPanel && body && body.error && OPTION_ERROR_CODES_.indexOf(body.error.code) !== -1) {
              /* オプション由来の拒否（資格なし・受付停止等）は予約自体は作られていない。サーバーの
                 利用者向け文言をそのまま表示し、選択を直してもらう。 */
              goToStep('details');
              showGlobalError(window.BookingOptionsPanel.describeError(body.error), []);
              return;
            }
            showSubmitError(body && body.error && body.error.code, body && body.requestId);
            return;
          }
          hasSubmittedSuccessfully = true;
          els.completeBookingId.textContent = body.bookingId || '';
          renderOptionsResult_(body.options);
          els.completeBackLink.href = backUrl;
          els.completeBackLink.textContent = backLabel;

          /*
           * 予約内容・利用料金の表示（Issue #342）。フォーム側の見積り（latestPriceEntry）
           * ではなく、createBookingのレスポンス（body）が返す値だけを使う。これは
           * GASがcreateBooking時点で確定・保存した金額であり、予約データへ保存された
           * priceAmountと同じ値になる。「仮予約受付」と「予約確定」の区別は
           * pendingStatusLabel（常にPENDING）と、この画面・上の見出しが一貫して
           * 「送信を受け付けました」としか言わないことで保つ（「確定」という語を
           * ここでは一切使わない）。
           */
          if (els.completeBrand) els.completeBrand.textContent = brandMeta.displayName;
          if (els.completeDate) els.completeDate.textContent = body.date || '';
          if (els.completeTime) {
            els.completeTime.textContent = body.startTime
              ? UI_TEXT.confirmTime(body.startTime, Logic.computeEndTime(body.startTime, body.durationMinutes), Number(body.durationMinutes) / 60)
              : '';
          }
          if (els.completePeople) els.completePeople.textContent = Logic.peopleLabel(body.people, locale);
          if (els.completePrice) {
            var completeAmount = Logic.formatJpyAmount(body.price && body.price.amount);
            els.completePrice.textContent = completeAmount ? UI_TEXT.priceLine(completeAmount) : Logic.priceUnavailableLabel(locale);
          }
          if (els.completePayment) els.completePayment.textContent = Logic.paymentMethodLabel(body.paymentMethod, locale);
          /* Issue #445: カードは「予約申込を受け付けました→お支払い完了で確定」を前面に出し、
             「仮予約」を主見出しにしない。現金・PayPay・未定は従来どおり仮予約受付。内部状態（PENDING）は不変。 */
          var completeCopy = Logic.bookingFlowCopy(state.paymentMethod, locale);
          var completeIsCard = Logic.isCardPaymentMethodValue(state.paymentMethod);
          setText_(els.completeHeading, completeCopy.completeHeading);
          setText_(els.completeStatusLabel, completeCopy.statusLabel);
          if (els.completeStatus) {
            /* Issue #563: テスト資格のドライラン。実予約は作成されていない。 */
            els.completeStatus.textContent = body.dryRun === true
              ? (locale === 'en' ? 'TEST: no booking was created' : 'テスト（予約は作成されていません）')
              : body.status === 'PENDING'
              ? (completeIsCard ? completeCopy.statusValue : UI_TEXT.pendingStatusLabel)
              : (body.status || '');
          }
          /* 完了画面（Issue #334 PR-B / Issue #407）: 既存の「通常24時間以内にご連絡します」は
             確定連絡そのものが24時間以内に届くという前提の文言のため、カード決済では
             出さない（カードは決済ページでの支払い完了で確定する）。代わりにカード注意書きを表示する。現金・PayPay・
             未定は既存文言のまま変更しない。 */
          if (Logic.isCardPaymentMethodValue(state.paymentMethod) && body.dryRun !== true) {
            if (els.completeGenericNotice) els.completeGenericNotice.hidden = true;
            /*
             * Issue #341 PR-B / PR #354レビュー対応・項目3: startCardCheckoutを追加で
             * 試みる。結果は3通りに分岐する（attemptCardCheckout_のコメント参照）:
             * - success: Stripe Checkoutへの遷移導線を表示する。
             * - fallback: Checkoutが確実に未着手（キルスイッチ無効等）の場合のみ、
             *   運営から決済方法を案内する旨の案内（日時の約束なし）を表示する。
             * - uncertain: それ以外すべて。旧方式へは絶対に誘導せず（二重決済の恐れが
             *   あるため）、専用のエラー・再試行案内を表示する。
             */
            attemptCardCheckout_(body.bookingId, body.checkoutAccessToken).then(function (checkout) {
              if (checkout.status === 'success') {
                renderMultilineNotice_(els.completeCardPaymentNotice, null);
                renderMultilineNotice_(els.completeCheckoutUncertainNotice, null);
                renderMultilineNotice_(els.completeCheckoutNotice, Logic.cardCheckoutRedirectNoticeLines(locale, Logic.formatPaymentDeadline(checkout.paymentHoldExpiresAt)));
                if (els.completeCheckoutWrap) els.completeCheckoutWrap.hidden = false;
                if (els.completeCheckoutLink) {
                  els.completeCheckoutLink.href = checkout.checkoutUrl;
                  els.completeCheckoutLink.textContent = Logic.cardCheckoutButtonLabel(locale);
                }
              } else if (checkout.status === 'fallback') {
                renderMultilineNotice_(els.completeCheckoutNotice, null);
                renderMultilineNotice_(els.completeCheckoutUncertainNotice, null);
                if (els.completeCheckoutWrap) els.completeCheckoutWrap.hidden = true;
                renderMultilineNotice_(els.completeCardPaymentNotice, Logic.cardCheckoutFallbackNoticeLines(locale));
              } else {
                renderMultilineNotice_(els.completeCardPaymentNotice, null);
                renderMultilineNotice_(els.completeCheckoutNotice, null);
                if (els.completeCheckoutWrap) els.completeCheckoutWrap.hidden = true;
                renderMultilineNotice_(els.completeCheckoutUncertainNotice, Logic.cardCheckoutUncertainNoticeLines(locale));
              }
              goToStep('complete');
            });
          } else {
            if (els.completeGenericNotice) els.completeGenericNotice.hidden = false;
            renderMultilineNotice_(els.completeCardPaymentNotice, null);
            renderMultilineNotice_(els.completeCheckoutNotice, null);
            renderMultilineNotice_(els.completeCheckoutUncertainNotice, null);
            if (els.completeCheckoutWrap) els.completeCheckoutWrap.hidden = true;
            goToStep('complete');
          }
        })
        .catch(function () {
          isSubmitting = false;
          els.submit.disabled = false;
          els.submit.textContent = submitLabelFor_(state.paymentMethod);
          els.submitError.textContent = Logic.networkErrorMessage(locale);
          els.submitError.hidden = false;
          els.submitError.focus();
        });
    });
  }

  /* Issue #500: /studio-x/booking/?plan=osu_cosplay_base_6h は貸切ベースプランの初期選択だけを行う。初期化の最後に1回だけ適用し、
     以降はユーザー操作を優先する（解除後に再選択しない）。可否はサーバーが予約作成時に必ず判定する。 */
  if (els.planEvent && Logic.planFromSearch(window.location && window.location.search, brand) === Logic.EVENT_BASE_PLAN_CODE) {
    els.planEvent.checked = true;
    applyEventPlanState_();
  }
})();
