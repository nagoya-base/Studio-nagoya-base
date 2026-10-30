/*
 * scripts/booking-app.js（共通予約UI）のIssue #273一時診断表示テスト。
 * 外部DOMライブラリへ依存せず、送信失敗レスポンスからエラー欄への表示までを
 * 最小DOMスタブで通し、ブラウザが受け取ったrequestIdを確認できることを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

function createElement(id) {
  var listeners = {};
  return {
    id: id,
    hidden: true,
    disabled: false,
    checked: id === 'ba-confirm-consent' || id === 'ba-confirm-terms' || id === 'ba-confirm-safety',
    /* メールアドレスは予約フォーム前半（Step1）で入力する（Issue #532）。Step1で日付を選ぶ前に入力済みの前提。 */
    value: id === 'ba-email' ? 'taro@example.com' : '',
    textContent: '',
    innerHTML: '',
    className: '',
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function (name, listener) { listeners[name] = listener; },
    appendChild: function () {},
    focus: function () {},
    getAttribute: function () { return null; },
    setAttribute: function () {},
    removeAttribute: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    scrollIntoView: function () {},
    _listeners: listeners
  };
}

function setup(responseBody) {
  var elements = {};
  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return 'snb';
    if (name === 'data-back-url') return '/';
    if (name === 'data-back-label') return 'トップへ戻る';
    return null;
  };
  root.querySelectorAll = function () { return []; };
  elements['booking-app'] = root;

  var documentStub = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement: createElement
  };

  var logicStub = {
    normalizeLocale: function (loc) { return loc === 'en' ? 'en' : 'ja'; },
    getBrandMeta: function () { return { displayName: 'Studio Nagoya Base' }; },
    todayInJapan: function () { return '2026-09-21'; },
    buildCreateBookingPayload: function () { return {}; },
    /* 初期表示改善（Issue #328想定）: ページ読み込み直後にhandleCalendarPrereqChange_を
       1回呼ぶようになったため、このテストのDOMスタブ（ba-durationは既定で空文字、
       customerTypeは未選択）でもLogic側の判定関数を最低限本物と同じ挙動で用意しておく
       必要がある（未確定のためカレンダーは表示されず、このテスト自体の検証内容には
       影響しない）。 */
    durationHoursToMinutes: function (hours) {
      var n = Number(hours);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
      return n * 60;
    },
    isDurationAtLeastUiMinimum: function (durationMinutes) { return Number(durationMinutes) >= 120; },
    normalizeTimeBand: function (value) {
      return (value === 'morning' || value === 'daytime' || value === 'evening') ? value : 'all';
    },
    messageForErrorCode: function () { return '予約の保存に失敗しました。'; },
    recoveryActionForErrorCode: function () { return 'retry'; },
    customerTypeLabel: function () { return ''; },
    validateDetailsForm: function () { return {}; },
    validateEmailField: function (email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '') ? '' : 'メールアドレスの形式が正しくありません。'; },
    peopleLabel: function (v) { return v; },
    purposeLabel: function (v) { return v; },
    paymentMethodLabel: function (v) { return v; },
    networkErrorMessage: function () { return '通信状況をご確認のうえ、時間を置いて再度お試しください。'; },
    apiNotConfiguredMessage: function () { return '現在オンライン予約の準備中です。恐れ入りますが、しばらくしてから再度お試しください。'; },
    /* Issue #334 PR-B: 送信成功ハンドラがカード決済かどうかを毎回判定するため、
       このstubでも最低限の実装を用意する（このテスト群はstate.paymentMethodが
       常に空文字のため、常にfalseを返す形で足りる）。 */
    CARD_PAYMENT_METHOD_VALUE: 'オンラインクレジットカード',
    isCardPaymentMethodValue: function (v) { return v === 'オンラインクレジットカード'; },
    /* Issue #445: 支払方法別の案内文言。このstubのテスト群は常に現金相当（manual）で足りる。 */
    bookingFlowCopy: function () {
      return {
        kind: 'manual',
        banner: { title: '', body: '' },
        consent: '',
        confirmHeading: '',
        submitLabel: '',
        completeHeading: '',
        statusLabel: '',
        statusValue: ''
      };
    },
    /* Issue #407: 初回利用のカード必須判定。このstubのテスト群は利用区分を持たないため常に許可する。 */
    isFirstTimeCardRequired: function () { return false; },
    isPaymentMethodAllowedForCustomer: function () { return true; },
    /* Issue #342: 料金見積り表示の配線用スタブ。このテスト群はstate.date等が常に
       未設定（Step1へ進んでいない）ため、実際に見積りfetchが発生することはないが、
       モジュール読み込み時点（brandShowsMemberOptionの呼び出し）で例外にならないよう
       最低限の実装を用意する。 */
    brandShowsMemberOption: function (b) { return b === 'snb' || b === 'studio_x'; },
    brandShowsMemberBenefits: function () { return false; },
    pairPackAvailableOnDate: function () { return false; },
    pairPackDurationAllowed: function () { return false; },
    showerAvailableOnDate: function () { return false; },
    showerPackAvailableOnDate: function () { return false; },
    /* Issue #667: 作品撮りサポート（mens限定）。このスタブでは常に選択不可。 */
    PHOTO_SUPPORT_PLAN_CODE: 'mens_photo_support',
    photoSupportAvailableOnDate: function () { return false; },
    photoSupportPeopleAllowed: function () { return true; },
    photoSupportApplyOpen: function () { return false; },
    photoSupportServicesValid: function () { return false; },
    todayJstString: function () { return '2026-01-01'; },
    photoSupportFlowCopy: function () { return {}; },
    photoSupportNote: function () { return ''; },
    photoSupportReceivedNoticeLines: function () { return []; },
    showerPackDurationAllowed: function () { return false; },
    showerPackPeopleAllowed: function () { return true; },
    SHOWER_PACK_PLAN_CODE: 'mens_weekend_shower_4h',
    appliedRateInfo: function () { return null; },
    isPairPackPeopleValue: function () { return true; },
    PAIR_PACK_PLAN_CODE: 'member_pair_3h',
    brandGatesMemberFeatures: function () { return false; },
    /* Issue #563: OTP対象かどうか。このstubのテスト群は常に従来の台帳照合（OTPなし）。 */
    brandSupportsMemberAuth: function () { return false; },
    usesMemberOtp: function () { return false; },
    showerExtraInfo: function () { return { label: '', value: '', text: '', notes: [], confirmNote: '' }; },
    /* Issue #500: 初期化末尾でURLのplanを読む。このstub群はURLのplanを持たない。 */
    planFromSearch: function () { return ''; },
    formatJpyAmount: function (amount) {
      var value = Number(amount);
      return Number.isFinite(value) ? '¥' + value.toLocaleString('en-US') : '';
    },
    priceComputingLabel: function () { return '料金を計算しています…'; },
    priceUnavailableLabel: function () { return '現在、料金を確認できません。時間をおいて再度お試しください。'; }
  };

  var sandbox = loadFrontendSandbox(['booking-app.js'], {
    document: documentStub,
    window: {
      BookingLogic: logicStub,
      BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' }
    },
    fetch: function () {
      return Promise.resolve({ json: function () { return Promise.resolve(responseBody); } });
    }
  });

  return { sandbox: sandbox, elements: elements };
}

function flushPromises() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

test('Issue #273診断: createBooking失敗時だけエラー欄へブラウザ応答のrequestIdを表示する', async function () {
  var ctx = setup({
    success: false,
    error: { code: 'BOOKING_SAVE_FAILED', message: 'server message is not rendered directly' },
    requestId: 'diagnostic-request-273'
  });

  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(
    ctx.elements['ba-submit-error'].textContent,
    '予約の保存に失敗しました。\n診断ID: diagnostic-request-273'
  );
  assert.strictEqual(ctx.elements['ba-submit-error'].hidden, false);
});

test('Issue #273診断: 想定外形式のrequestIdはエラー欄へ表示しない', async function () {
  var ctx = setup({
    success: false,
    error: { code: 'BOOKING_SAVE_FAILED' },
    requestId: 'invalid requestId with PII@example.com'
  });

  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-submit-error'].textContent, '予約の保存に失敗しました。');
  assert.strictEqual(ctx.elements['ba-submit-error'].textContent.indexOf('@example.com'), -1);
});

test('Issue #273診断: createBooking成功時はrequestIdを画面へ表示しない', async function () {
  var ctx = setup({
    success: true,
    bookingId: 'SNB-20260921-TEST',
    requestId: 'success-request-id'
  });

  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-submit-error'].textContent, '');
  assert.strictEqual(ctx.elements['ba-submit-error'].hidden, true);
  assert.strictEqual(ctx.elements['ba-complete-booking-id'].textContent, 'SNB-20260921-TEST');
  assert.strictEqual(ctx.elements['ba-complete-booking-id'].textContent.indexOf('success-request-id'), -1);
});

/*
 * Issue #342: 仮予約完了画面は、createBookingのレスポンス（GASがcreateBooking時点で
 * 確定・保存した値）だけを使って予約内容・利用料金を表示する。フォーム側の見積り値は
 * 一切使わない（このテストのfetchスタブは常にresponseBodyのみを返すため、完了画面の
 * 表示がresponseBody以外の値に依存していないことも間接的に確認できる）。
 */
test('Issue #342: 仮予約完了画面はcreateBookingレスポンスのprice等を使って予約内容を表示する', async function () {
  var ctx = setup({
    success: true,
    bookingId: 'SNB-20260921-PRICE',
    requestId: 'req-price',
    date: '2026-10-05',
    durationMinutes: 120,
    brand: 'snb',
    people: '2名',
    paymentMethod: '現金',
    status: 'PENDING',
    price: { amount: 4000, currency: 'JPY', tier: 'GENERAL', isMember: false, dayType: 'WEEKDAY' }
  });

  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-complete-brand'].textContent, 'Studio Nagoya Base');
  assert.strictEqual(ctx.elements['ba-complete-date'].textContent, '2026-10-05');
  assert.strictEqual(ctx.elements['ba-complete-people'].textContent, '2名');
  assert.strictEqual(ctx.elements['ba-complete-price'].textContent, '利用料金: ¥4,000（税込）');
  assert.strictEqual(ctx.elements['ba-complete-payment'].textContent, '現金');
  assert.strictEqual(ctx.elements['ba-complete-status'].textContent, '仮予約受付（未確定）');
});

test('Issue #342: createBookingが金額を返せなかった場合、完了画面は金額不明の案内を表示し例外を投げない', async function () {
  var ctx = setup({
    success: true,
    bookingId: 'SNB-20260921-NOPRICE',
    requestId: 'req-noprice',
    date: '2026-10-05',
    durationMinutes: 120,
    brand: 'snb',
    people: '2名',
    paymentMethod: '現金',
    status: 'PENDING'
  });

  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-complete-price'].textContent, '現在、料金を確認できません。時間をおいて再度お試しください。');
});

/*
 * Issue #342: 会員自己申告欄はSNBのみ表示する。mens/studio_xでは常に非表示のまま
 * （BookingPricing.gsのresolveTier_と同じ分岐をUI側でも表示制御として反映する）。
 * 実際のscripts/booking-logic.jsを読み込み、brandShowsMemberOptionの結合を検証する。
 */
function setupForBrand(brand) {
  var elements = {};
  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return brand;
    if (name === 'data-back-url') return '/';
    if (name === 'data-back-label') return null;
    return null;
  };
  root.querySelectorAll = function () { return []; };
  elements['booking-app'] = root;

  var documentStub = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement: createElement
  };

  loadFrontendSandbox(['booking-logic.js', 'booking-app.js'], {
    document: documentStub,
    window: { BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' } },
    fetch: function () { return Promise.resolve({ json: function () { return Promise.resolve({ success: true }); } }); }
  });

  return { elements: elements };
}

test('Issue #470 / #492 / #532: 会員自己申告欄はsnb・studio_xで世代が判定できない間は表示（ブラウザ端末の時計では判断しない）、mensは非表示', function () {
  assert.strictEqual(setupForBrand('snb').elements['ba-member-field'].hidden, false);
  /* 以前は端末時刻（2026/10/26 0:00 JST）でstudio_xを隠していた。サーバーが返す料金世代が分かるまでは、端末の時計に関わらず表示する側へ倒す。 */
  assert.strictEqual(setupForBrand('studio_x').elements['ba-member-field'].hidden, false);
  assert.strictEqual(setupForBrand('mens').elements['ba-member-field'].hidden, true);
});

test('Issue #532: 自己申告ラジオの表示はサーバーの料金世代で決まる（V1は表示・V2は廃止・不明は表示・端末時刻は見ない）', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  var far = Date.parse('2030-01-01T00:00:00+09:00');
  var past = Date.parse('2020-01-01T00:00:00+09:00');
  ['snb', 'studio_x'].forEach(function (brand) {
    assert.strictEqual(Logic.brandShowsMemberOption(brand, far, 'V1'), true, brand + ' V1は自己申告');
    assert.strictEqual(Logic.brandShowsMemberOption(brand, past, 'V2'), false, brand + ' V2は端末時刻が過去でも廃止');
    assert.strictEqual(Logic.brandShowsMemberOption(brand, far, undefined), true, brand + ' 世代不明は端末時刻が未来でも表示');
    assert.strictEqual(Logic.brandShowsMemberOption(brand, far, 'bad'), true, brand + ' 不明な値は表示');
  });
  assert.strictEqual(Logic.brandShowsMemberOption('mens', 0, 'V1'), false);
  assert.strictEqual(Logic.brandShowsMemberOption('mens', 0, undefined), false);
});

test('Issue #532: 見積りのGET応答の料金世代がV2なら会員区分欄を隠し、V1なら表示のまま（サーバー応答が正）', async function () {
  var v2 = setupFullFlow(null, { estimateExtra: { priceGeneration: 'V2' } });
  v2.elements['ba-date'].value = '2026-12-10';
  v2.elements['ba-duration'].value = '2';
  v2.setCustomerType('returning');
  v2.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  assert.strictEqual(v2.elements['ba-member-field'].hidden, true, 'V2は自己申告欄を出さない');

  var v1 = setupFullFlow(null, { estimateExtra: { priceGeneration: 'V1' } });
  v1.elements['ba-date'].value = '2026-11-10';
  v1.elements['ba-duration'].value = '2';
  v1.setCustomerType('returning');
  v1.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  assert.strictEqual(v1.elements['ba-member-field'].hidden, false, 'V1は自己申告欄を表示');
});

test('Issue #532: メールアドレスはStep1で1回だけ入力する。未入力・形式不正ではStep1で止まり、有効なら進んで、Step2で再入力せず最終送信へそのまま使う', async function () {
  var ctx = setupFullFlow(null);
  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');

  ctx.elements['ba-email'].value = '';
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-email-error'].hidden, false, '未入力はStep1にエラー');
  assert.strictEqual(ctx.getFetchCallCount(), 0, 'availabilityを取得しない');

  ctx.elements['ba-email'].value = 'not-an-email';
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-email-error'].hidden, false, '形式不正はStep1にエラー');
  assert.strictEqual(ctx.getFetchCallCount(), 0);

  ctx.elements['ba-email'].value = 'step1@example.com';
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-email-error'].hidden, true);
  assert.strictEqual(ctx.getFetchCallCount(), 1, '有効なメールで先へ進む');

  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();
  /* Step2ではメールを再入力しない（入力欄はStep1にある1つだけ）。 */
  ctx.elements['ba-name'].value = '山田太郎';
  ctx.elements['ba-people'].value = '2名';
  ctx.elements['ba-purpose'].value = 'セルフ撮影';
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();
  assert.strictEqual(ctx.elements['ba-confirm-email'].textContent, 'step1@example.com');

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.requests.length, 1);
  assert.strictEqual(ctx.requests[0].body.email, 'step1@example.com', 'Step1のメールをそのまま最終送信に使う');
});

test('Issue #603: 規約等・安全ルールの同意が未チェックなら送信されず、チェックごとにエラーを出す', async function () {
  var ctx = setupFullFlow(null);
  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-email'].value = 'step1@example.com';
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();
  ctx.elements['ba-name'].value = '山田太郎';
  ctx.elements['ba-people'].value = '2名';
  ctx.elements['ba-purpose'].value = 'セルフ撮影';
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();

  ctx.elements['ba-confirm-consent'].checked = false;
  ctx.elements['ba-confirm-terms'].checked = false;
  ctx.elements['ba-confirm-safety'].checked = false;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.requests.length, 0, '未同意では送信しない');
  assert.strictEqual(ctx.elements['ba-consent-error'].hidden, false, '3つとも未チェックなら1回で全エラーを表示する');
  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-terms-error'].hidden, false);
  assert.strictEqual(ctx.elements['ba-safety-error'].hidden, false);

  ctx.elements['ba-confirm-terms'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.requests.length, 0, '安全ルール未同意では送信しない');
  assert.strictEqual(ctx.elements['ba-terms-error'].hidden, true);
  assert.strictEqual(ctx.elements['ba-safety-error'].hidden, false);

  ctx.elements['ba-confirm-safety'].checked = true;
  ctx.elements['ba-confirm-consent'].checked = false;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.requests.length, 0, '既存の予約成立条件確認も必須');

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.requests.length, 1, '全て同意すれば送信する');
});

/* ── English locale（Issue #297）: 実際のscripts/booking-logic.jsをbooking-app.jsと
   一緒にvmへ読み込み、data-locale="en"のときにruntime messageが実際に英語へ切り替わる
   ことと、API送信payloadのbrand・その他内部valueが言語で変わらないことを確認する
   （スタブではなく実ファイルを通すことで、locale配線の結合部分を検証する）。 */
function setupWithRealLogic(locale, responseBody) {
  var elements = {};
  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return 'snb';
    if (name === 'data-back-url') return '/';
    if (name === 'data-back-label') return null;
    if (name === 'data-locale') return locale;
    return null;
  };
  root.querySelectorAll = function () { return []; };
  elements['booking-app'] = root;

  var documentStub = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement: createElement
  };

  var capturedRequest = null;
  var windowStub = { BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' } };

  var sandbox = loadFrontendSandbox(['booking-logic.js', 'booking-app.js'], {
    document: documentStub,
    window: windowStub,
    fetch: function (url, options) {
      capturedRequest = { url: url, body: JSON.parse(options.body) };
      return Promise.resolve({ json: function () { return Promise.resolve(responseBody); } });
    }
  });

  return { sandbox: sandbox, elements: elements, getRequest: function () { return capturedRequest; } };
}

test('English locale: data-locale="en"でcreateBooking失敗時のruntime messageが英語になる（実ロジック結合）', async function () {
  var ctx = setupWithRealLogic('en', {
    success: false,
    error: { code: 'BOOKING_SAVE_FAILED' },
    requestId: 'en-locale-request-1'
  });

  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(
    ctx.elements['ba-submit-error'].textContent,
    'We couldn’t save your booking. Please try again in a moment.\nDiagnostic ID: en-locale-request-1'
  );
});

test('English locale: data-locale未指定（既定）ではruntime messageが日本語のまま（回帰なし）', async function () {
  var ctx = setupWithRealLogic(null, {
    success: false,
    error: { code: 'BOOKING_SAVE_FAILED' },
    requestId: 'ja-locale-request-1'
  });

  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(
    ctx.elements['ba-submit-error'].textContent,
    '予約の保存に失敗しました。しばらくしてから再度お試しください。\n診断ID: ja-locale-request-1'
  );
});

test('English locale: createBooking送信payloadのbrand/customerType/people/purpose/paymentMethodの内部valueは日本語版と一致する', async function () {
  var ctx = setupWithRealLogic('en', { success: true, bookingId: 'SNB-20261005-EN', requestId: 'req-en' });

  /* Step1〜3の入力状態を直接stateへ持たせるため、Step3「次へ」相当の内部stateを
     click経由で作るのは大掛かりになるため、ここではsubmitボタン押下時点のpayload
     組み立てに使うLogic.buildCreateBookingPayloadの実装が実際に使われていることのみを
     間接確認する（state初期値はすべて空文字のため、送信されるpayloadの構造・brandを見る）。 */
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  var request = ctx.getRequest();
  assert.strictEqual(request.body.brand, 'snb');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(request.body, 'customerType'), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(request.body, 'purpose'), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(request.body, 'paymentMethod'), true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(request.body, 'people'), true);
});

/* ── PR #300再レビュー対応: Step1〜Step4をclickで実際に通し、確認画面の表示ラベルと
   送信payloadの内部valueが別物であることを検証する（実ロジック結合）。
   root.querySelectorをcustomerType/paymentMethodのラジオ選択の代わりに、
   ba-start-time-gridのappendChildを描画された開始時刻ボタンの捕捉に、それぞれ
   差し替える。 */
function setupFullFlow(locale, options) {
  var opts = options || {};
  var elements = {};
  var startTimeButtons = [];
  var selectedCustomerType = null;
  var selectedPaymentMethod = null;
  /* 希望時間帯（Issue #324）。未選択はDOM上「どのラジオもchecked情報を持たない」を
     querySelector(':checked')がnullを返すことで再現し、checkedTimeBand()がallへ
     フォールバックすることを既存フロー（他のテスト）でも確認できるようにする。 */
  var selectedTimeBand = null;
  var requests = [];

  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return 'snb';
    if (name === 'data-back-url') return '/';
    if (name === 'data-back-label') return null;
    if (name === 'data-locale') return locale;
    return null;
  };
  root.querySelectorAll = function () { return []; };
  root.querySelector = function (selector) {
    if (selector === 'input[name="customerType"]:checked') {
      return selectedCustomerType ? { value: selectedCustomerType } : null;
    }
    if (selector === 'input[name="paymentMethod"]:checked') {
      return selectedPaymentMethod ? { value: selectedPaymentMethod } : null;
    }
    if (selector === 'input[name="timeBand"]:checked') {
      return selectedTimeBand ? { value: selectedTimeBand } : null;
    }
    return null;
  };
  elements['booking-app'] = root;

  var startTimeGrid = createElement('ba-start-time-grid');
  startTimeGrid.appendChild = function (child) { startTimeButtons.push(child); };
  elements['ba-start-time-grid'] = startTimeGrid;

  var documentStub = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement: createElement
  };

  var windowStub = { BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' } };
  var fetchCallCount = 0;

  loadFrontendSandbox(['booking-logic.js', 'booking-app.js'], {
    document: documentStub,
    window: windowStub,
    /* Issue #342: 利用料金の見積り（action=estimatePrice）もGETで呼ばれるようになったが、
       getFetchCallCountは既存どおり「getAvailabilityが呼ばれた回数」を数える指標として
       使うため、estimatePriceへのリクエストはこのカウントに含めない（別のAPI呼び出し
       であり、getAvailabilityの呼び出し回数自体には影響しないことを検証する既存テストの
       前提を壊さないため）。 */
    fetch: function (url, options) {
      if (url.indexOf('action=estimatePrice') !== -1) {
        return Promise.resolve({ json: function () {
          return Promise.resolve(Object.assign({ success: true, price: { amount: 4000, currency: 'JPY', tier: 'GENERAL', isMember: false, dayType: 'WEEKDAY' } }, opts.estimateExtra || {}));
        } });
      }
      fetchCallCount += 1;
      if (options && options.method === 'POST') {
        requests.push({ url: url, body: JSON.parse(options.body) });
        return Promise.resolve({ json: function () {
          return Promise.resolve({ success: true, bookingId: 'SNB-FULLFLOW-TEST', requestId: 'req-full-flow' });
        } });
      }
      return Promise.resolve({ json: function () {
        return Promise.resolve({ success: true, bookableStartTimes: opts.bookableStartTimes || ['10:00', '11:00'] });
      } });
    }
  });

  return {
    elements: elements,
    startTimeButtons: startTimeButtons,
    setCustomerType: function (v) { selectedCustomerType = v; },
    setPaymentMethod: function (v) { selectedPaymentMethod = v; },
    setTimeBand: function (v) { selectedTimeBand = v; },
    requests: requests,
    getFetchCallCount: function () { return fetchCallCount; }
  };
}

/*
 * PR #343レビュー対応の回帰テスト用セットアップ: setupFullFlowとほぼ同じだが、
 * action=estimatePriceへのfetchだけ即座には解決させず、テスト側が任意のタイミングで
 * resolvePriceFetch(responseBody)を呼ぶまで待たせる。「Step4表示後に見積もりAPIの
 * 応答が届いた場合、確認画面の料金が更新されること」を検証するために、応答到着の
 * タイミングをテストから制御できるようにする。 */
function setupFullFlowWithDeferredPrice(locale, options) {
  var opts = options || {};
  var elements = {};
  var startTimeButtons = [];
  var selectedCustomerType = null;
  var selectedPaymentMethod = null;
  var priceFetchResolvers = [];

  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return opts.brand || 'snb';
    if (name === 'data-back-url') return '/';
    if (name === 'data-back-label') return null;
    if (name === 'data-locale') return locale;
    return null;
  };
  root.querySelectorAll = function () { return []; };
  root.querySelector = function (selector) {
    if (selector === 'input[name="customerType"]:checked') {
      return selectedCustomerType ? { value: selectedCustomerType } : null;
    }
    if (selector === 'input[name="paymentMethod"]:checked') {
      return selectedPaymentMethod ? { value: selectedPaymentMethod } : null;
    }
    return null;
  };
  elements['booking-app'] = root;

  var startTimeGrid = createElement('ba-start-time-grid');
  startTimeGrid.appendChild = function (child) { startTimeButtons.push(child); };
  elements['ba-start-time-grid'] = startTimeGrid;

  var documentStub = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement: createElement
  };

  loadFrontendSandbox(['booking-logic.js', 'booking-app.js'], {
    document: documentStub,
    window: { BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' } },
    fetch: function (url) {
      if (url.indexOf('action=estimatePrice') !== -1) {
        return new Promise(function (resolve) {
          priceFetchResolvers.push(function (responseBody) {
            resolve({ json: function () { return Promise.resolve(responseBody); } });
          });
        });
      }
      return Promise.resolve({ json: function () {
        return Promise.resolve({ success: true, bookableStartTimes: opts.bookableStartTimes || ['10:00', '11:00'] });
      } });
    }
  });

  return {
    elements: elements,
    startTimeButtons: startTimeButtons,
    setCustomerType: function (v) { selectedCustomerType = v; },
    setPaymentMethod: function (v) { selectedPaymentMethod = v; },
    /* 現在待機中（未解決）の見積りfetch呼び出し数。 */
    pendingPriceFetchCount: function () { return priceFetchResolvers.length; },
    /* 最も古い（最初の）未解決の見積りfetchを指定の応答で解決する。 */
    resolveOldestPriceFetch: function (responseBody) {
      var resolver = priceFetchResolvers.shift();
      if (resolver) resolver(responseBody);
    },
    /* すべての未解決の見積りfetchを指定の応答で解決する（同一条件の重複呼び出し等）。 */
    resolveAllPriceFetches: function (responseBody) {
      var resolvers = priceFetchResolvers.splice(0, priceFetchResolvers.length);
      resolvers.forEach(function (resolver) { resolver(responseBody); });
    }
  };
}

test('PR #343レビュー対応: Step4表示後に見積りAPIの応答が届くと、確認画面の料金が「計算中」から更新される（古い表示のまま固定されない）', async function () {
  var ctx = setupFullFlowWithDeferredPrice(null);

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  /* Step1→Step2遷移時点では見積りfetchはまだ未解決のまま（Step1のisMember変更等での
     再発火を含め複数回リクエストされている可能性があるため、件数は問わず「1件以上
     保留中」であることだけを確認する）。 */
  assert.ok(ctx.pendingPriceFetchCount() >= 1, '見積りfetchが保留中であるべき');

  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  ctx.elements['ba-name'].value = '山田太郎';
  ctx.elements['ba-email'].value = 'taro@example.com';
  ctx.elements['ba-people'].value = '2名';
  ctx.elements['ba-purpose'].value = 'セルフ撮影';
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();

  /* Step4表示直後: 見積りはまだ届いていないため「計算中」等の表示で、確定した金額
     （¥4,000等）は一切表示されないべき（古い/未確定の金額を確定料金として出さない）。 */
  assert.doesNotMatch(ctx.elements['ba-confirm-price'].textContent, /¥/, 'まだ確定金額を表示してはいけない');

  /* Step4表示後に、ようやく見積りAPIの応答が届いたケースを再現する。 */
  ctx.resolveAllPriceFetches({ success: true, price: { amount: 6000, currency: 'JPY', tier: 'GENERAL', isMember: false, dayType: 'WEEKDAY' } });
  await flushPromises();

  assert.match(ctx.elements['ba-confirm-price'].textContent, /¥6,000/, 'Step4表示中でも、後から届いた見積りで料金表示が更新されるべき');
});

test('PR #343レビュー対応: Step4表示中に見積りAPIが失敗した場合も、古い金額のまま固定されず失敗理由を表示する', async function () {
  var ctx = setupFullFlowWithDeferredPrice(null);

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  ctx.elements['ba-name'].value = '山田太郎';
  ctx.elements['ba-email'].value = 'taro@example.com';
  ctx.elements['ba-people'].value = '2名';
  ctx.elements['ba-purpose'].value = 'セルフ撮影';
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();

  ctx.resolveAllPriceFetches({ success: false, error: { code: 'INTERNAL_ERROR', message: '予約処理中にエラーが発生しました。' } });
  await flushPromises();

  assert.doesNotMatch(ctx.elements['ba-confirm-price'].textContent, /¥/, '失敗時に金額を表示してはいけない');
});

test('PR #300再レビュー: English localeの確認画面はpeople/purpose/paymentMethodを英語ラベルで表示し、送信payloadは日本語の既存内部valueのまま送る', async function () {
  var ctx = setupFullFlow('en');

  /* Step1: 利用日・利用時間・利用区分 */
  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  /* Step2: 開始時刻（実際に描画されたボタンをクリック） */
  assert.ok(ctx.startTimeButtons.length > 0, '開始時刻の選択肢が描画されること');
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  /* Step3: 利用者情報（内部valueは既存日本語のまま入力する） */
  ctx.elements['ba-name'].value = 'John Smith';
  ctx.elements['ba-email'].value = 'john@example.com';
  ctx.elements['ba-people'].value = '2名';
  ctx.elements['ba-purpose'].value = 'その他';
  ctx.elements['ba-purpose-other'].value = 'Cosplay shoot';
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();

  /* Step4: 確認画面は英語ラベルで表示される（内部valueそのものではない） */
  assert.strictEqual(ctx.elements['ba-confirm-people'].textContent, '2 guests');
  assert.strictEqual(ctx.elements['ba-confirm-purpose'].textContent, 'Other: Cosplay shoot');
  assert.strictEqual(ctx.elements['ba-confirm-payment'].textContent, 'Cash');

  /* 送信: payloadは表示ラベルではなく、既存日本語の内部value・保存仕様のまま */
  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.requests.length, 1);
  var body = ctx.requests[0].body;
  assert.strictEqual(body.brand, 'snb');
  assert.strictEqual(body.people, '2名');
  assert.strictEqual(body.purpose, 'その他：Cosplay shoot');
  assert.strictEqual(body.paymentMethod, '現金');
});

test('PR #300再レビュー: 日本語locale（未指定）では確認画面の表示が既存どおり日本語のまま（回帰なし）', async function () {
  var ctx = setupFullFlow(null);

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  ctx.elements['ba-name'].value = '山田太郎';
  ctx.elements['ba-email'].value = 'taro@example.com';
  ctx.elements['ba-people'].value = '2名';
  ctx.elements['ba-purpose'].value = 'その他';
  ctx.elements['ba-purpose-other'].value = 'コスプレ撮影';
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();

  assert.strictEqual(ctx.elements['ba-confirm-people'].textContent, '2名');
  assert.strictEqual(ctx.elements['ba-confirm-purpose'].textContent, 'その他：コスプレ撮影');
  assert.strictEqual(ctx.elements['ba-confirm-payment'].textContent, '現金');
});

/* ── Issue #301/#410: 新予約UIのStep 1で最低利用時間（1時間）未満を即時拒否する。
   setupFullFlow(locale)でStep1のclick handlerを実際に通し、durationMinutesの計算だけでなく
   getAvailability呼び出し（fetch）自体が起きていないことまで確認する。 */
test('Issue #301: 日本語（locale未指定）でduration=0はStep 1で止まり、field errorを表示してgetAvailabilityを呼ばない', async function () {
  var ctx = setupFullFlow(null);

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '0';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-duration-error'].textContent, '利用時間を1時間以上の整数で入力してください。');
  assert.strictEqual(ctx.elements['ba-duration-error'].hidden, false);
  assert.strictEqual(ctx.startTimeButtons.length, 0, 'Step 2の開始時刻選択肢が描画されないこと');
  assert.strictEqual(ctx.getFetchCallCount(), 0, 'getAvailabilityが呼ばれないこと');
});

test('Issue #342: 利用日・利用時間が揃うとStep1に見積り金額が1か所だけ表示される', async function () {
  var ctx = setupFullFlow(null);

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-price-line'].textContent, '利用料金: ¥4,000（税込）');
  assert.strictEqual(ctx.elements['ba-price-line'].hidden, false);
});

test('Issue #301: 日本語（locale未指定）でduration=2は通常どおりStep 2へ進みavailabilityを取得する', async function () {
  var ctx = setupFullFlow(null);

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-duration-error'].hidden, true);
  assert.strictEqual(ctx.getFetchCallCount(), 1, 'getAvailabilityが1回呼ばれること');
  assert.ok(ctx.startTimeButtons.length > 0, '開始時刻の選択肢が描画されること');
});

test('Issue #301: locale="en"でduration=0はStep 1で止まり、英語field errorを表示してgetAvailabilityを呼ばない', async function () {
  var ctx = setupFullFlow('en');

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '0';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(
    ctx.elements['ba-duration-error'].textContent,
    'Please enter a duration of 1 hour or more (whole numbers only).'
  );
  assert.strictEqual(ctx.elements['ba-duration-error'].hidden, false);
  assert.strictEqual(ctx.startTimeButtons.length, 0, 'Step 2の開始時刻選択肢が描画されないこと');
  assert.strictEqual(ctx.getFetchCallCount(), 0, 'getAvailabilityが呼ばれないこと');
});

test('Issue #410: 日本語でduration=1（1時間）はStep 1で止まらずStep 2へ進みavailabilityを取得する', async function () {
  var ctx = setupFullFlow(null);

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '1';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-duration-error'].hidden, true);
  assert.strictEqual(ctx.getFetchCallCount(), 1, 'getAvailabilityが1回呼ばれること');
  assert.ok(ctx.startTimeButtons.length > 0, '開始時刻の選択肢が描画されること');
});

test('Issue #410: locale="en"でduration=1（1時間）はStep 1で止まらずStep 2へ進む', async function () {
  var ctx = setupFullFlow('en');

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '1';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-duration-error'].hidden, true);
  assert.strictEqual(ctx.getFetchCallCount(), 1, 'getAvailabilityが1回呼ばれること');
});

test('Issue #301: locale="en"でduration=2は通常どおりStep 2へ進みavailabilityを取得する', async function () {
  var ctx = setupFullFlow('en');

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-duration-error'].hidden, true);
  assert.strictEqual(ctx.getFetchCallCount(), 1, 'getAvailabilityが1回呼ばれること');
  assert.ok(ctx.startTimeButtons.length > 0, '開始時刻の選択肢が描画されること');
});

/* ── Issue #324: Step2（単日開始時刻一覧）は、月間カレンダーと同じ希望時間帯(timeBand)で
   絞り込んで表示する。GAS側getAvailability自体・そのリクエストURLは変更しない
   （フロント側でbookableStartTimesをフィルタするだけ）。 */
test('Issue #324: Step1で希望時間帯「午前」を選ぶと、Step2にはその時間帯の開始時刻だけが描画される', async function () {
  var ctx = setupFullFlow(null, { bookableStartTimes: ['08:00', '10:00', '13:00', '19:00'] });

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.setTimeBand('morning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  var renderedTimes = ctx.startTimeButtons.map(function (button) { return button.textContent; });
  assert.deepStrictEqual(renderedTimes, ['08:00', '10:00'], '午前(08:00〜11:45開始)の候補だけが描画されるべき');
  assert.strictEqual(ctx.getFetchCallCount(), 1, 'getAvailabilityの呼び出し回数自体は変わらない（フロント側フィルタのみ）');
});

test('Issue #324: 希望時間帯が未選択（DOM未配線含む）の場合はallとして扱われ、既存どおり全開始時刻が描画される（後方互換）', async function () {
  var ctx = setupFullFlow(null, { bookableStartTimes: ['08:00', '13:00', '19:00'] });

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  var renderedTimes = ctx.startTimeButtons.map(function (button) { return button.textContent; });
  assert.deepStrictEqual(renderedTimes, ['08:00', '13:00', '19:00']);
});

test('Issue #324: 希望時間帯「夜」でStep2に該当候補が無い場合、既存の「開始時刻がありません」表示になる', async function () {
  var ctx = setupFullFlow(null, { bookableStartTimes: ['08:00', '09:00'] });

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.setTimeBand('evening');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.startTimeButtons.length, 0);
  assert.strictEqual(ctx.elements['ba-start-time-empty'].hidden, false);
  assert.strictEqual(ctx.elements['ba-start-time-grid'].hidden, true);
});

/* ── Issue #334 PR-B: カード決済の96時間受付条件・注意書き（実ロジック結合） ──
   setupFullFlowをベースに、カード決済ラジオ（input[name="paymentMethod"][value="…"]）と
   支払方法欄・確認画面・完了画面の注意書き要素を、実際にdisabled/checked/表示テキストを
   検証できるスタブへ差し替える。日付は実行時刻からの相対日数で計算し、実行タイミングに
   依存して96時間の境界をまたがないようにする（offsetDays=10なら常に96時間超、
   offsetDays=1なら常に96時間未満になる）。 */
var CARD_VALUE = 'オンラインクレジットカード';

function jstDateString(offsetDays) {
  var d = new Date(Date.now() + offsetDays * 86400000);
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  var result = {};
  parts.forEach(function (p) { if (p.type !== 'literal') result[p.type] = p.value; });
  return result.year + '-' + result.month + '-' + result.day;
}

function setupCardFlow(locale, options) {
  var opts = options || {};
  var elements = {};
  var startTimeButtons = [];
  var selectedCustomerType = null;
  var selectedPaymentMethod = null;
  var selectedTimeBand = null;
  var requests = [];

  var cardLabelEl = {
    classList: {
      classes: {},
      toggle: function (cls, force) { this.classes[cls] = !!force; },
      contains: function (cls) { return !!this.classes[cls]; }
    }
  };
  var cardRadioEl = {
    name: 'paymentMethod',
    value: CARD_VALUE,
    disabled: false,
    checked: false,
    closest: function (selector) { return selector === 'label' ? cardLabelEl : null; }
  };

  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return 'snb';
    if (name === 'data-back-url') return '/';
    if (name === 'data-back-label') return null;
    if (name === 'data-locale') return locale;
    return null;
  };
  root.querySelectorAll = function () { return []; };
  root.querySelector = function (selector) {
    if (selector === 'input[name="customerType"]:checked') {
      return selectedCustomerType ? { value: selectedCustomerType } : null;
    }
    if (selector === 'input[name="paymentMethod"]:checked') {
      if (selectedPaymentMethod === CARD_VALUE) {
        return cardRadioEl.checked ? { value: CARD_VALUE } : null;
      }
      return selectedPaymentMethod ? { value: selectedPaymentMethod } : null;
    }
    if (selector === 'input[name="paymentMethod"][value="' + CARD_VALUE + '"]') {
      return cardRadioEl;
    }
    if (selector === 'input[name="timeBand"]:checked') {
      return selectedTimeBand ? { value: selectedTimeBand } : null;
    }
    return null;
  };
  elements['booking-app'] = root;

  var startTimeGrid = createElement('ba-start-time-grid');
  startTimeGrid.appendChild = function (child) { startTimeButtons.push(child); };
  elements['ba-start-time-grid'] = startTimeGrid;

  /* renderMultilineNotice_（scripts/booking-app.js）が積むテキストノード（{nodeValue}）と
     <br>要素（document.createElementのid='br'スタブ、nodeValueを持たない）を見分けて
     結合し、実際に画面へ表示される文言を1本の文字列として取り出せるようにする。 */
  function createNoticeElement(id) {
    var el = createElement(id);
    var parts = [];
    el.appendChild = function (child) { parts.push(child); };
    el.renderedText = function () {
      return parts
        .filter(function (p) { return p && typeof p.nodeValue === 'string'; })
        .map(function (p) { return p.nodeValue; })
        .join('\n');
    };
    return el;
  }
  [
    'ba-first-time-card-notice',
    'ba-card-payment-notice',
    'ba-confirm-card-payment-notice',
    'ba-complete-card-payment-notice',
    'ba-complete-checkout-notice',
    'ba-complete-checkout-uncertain-notice'
  ].forEach(function (id) { elements[id] = createNoticeElement(id); });

  var documentStub = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement: createElement,
    createTextNode: function (text) { return { nodeValue: text }; }
  };

  var windowStub = { BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' } };
  var fetchCallCount = 0;

  loadFrontendSandbox(['booking-logic.js', 'booking-app.js'], {
    document: documentStub,
    window: windowStub,
    fetch: function (url, fetchOptions) {
      fetchCallCount += 1;
      if (fetchOptions && fetchOptions.method === 'POST') {
        requests.push({ url: url, body: JSON.parse(fetchOptions.body) });
        /*
         * Issue #341 PR-B: createBooking成功後、カード決済は追加でstartCardCheckoutを
         * 呼ぶ（action=startCardCheckoutをURLクエリへ付与する。scripts/booking-app.jsの
         * attemptCardCheckout_参照）。既定ではopts.checkoutResponseを指定しない限り
         * success:falseを返し、attemptCardCheckout_がnullへ丸めて既存の「決済リンクを
         * 後日送付」フォールバックへ進む（既存テストの回帰なし）。
         */
        if (typeof url === 'string' && url.indexOf('action=startCardCheckout') !== -1) {
          if (opts.checkoutFetchThrows) {
            return Promise.reject(new Error('simulated network failure'));
          }
          return Promise.resolve({ json: function () {
            return Promise.resolve(opts.checkoutResponse || { success: false, error: { code: 'CHECKOUT_DISABLED' } });
          } });
        }
        return Promise.resolve({ json: function () {
          /* PR #354レビュー対応・項目1: checkoutAccessTokenもcreateBookingのレスポンスに
             含める（実際のGAS応答と同じ。これがないとattemptCardCheckout_がfetch自体を
             呼ばずfallback扱いへ短絡してしまい、opts.checkoutResponseの検証ができない）。 */
          return Promise.resolve({ success: true, status: 'PENDING', bookingId: 'SNB-CARD-TEST', checkoutAccessToken: 'test-token-for-snb-card-test', requestId: 'req-card' });
        } });
      }
      return Promise.resolve({ json: function () {
        return Promise.resolve({ success: true, bookableStartTimes: opts.bookableStartTimes || ['10:00', '11:00'] });
      } });
    }
  });

  return {
    elements: elements,
    startTimeButtons: startTimeButtons,
    cardRadio: cardRadioEl,
    cardLabel: cardLabelEl,
    /* 実際にvmへ読み込まれたLogic（scripts/booking-logic.js）そのもの。送信直前の
       再判定テストで、Logic.isCardPaymentEligibleを一時的に差し替えて「確認画面を
       開いている間に受付期限が過ぎた」状況を再現するために公開する。 */
    Logic: windowStub.BookingLogic,
    setCustomerType: function (v) { selectedCustomerType = v; },
    /* カードを選ぶ操作をシミュレートする。cardRadioEl.checkedも連動させ、後段の
       updateCardPaymentGating()がradio.checked = falseへ戻した場合に
       checkedPaymentMethod()側でも選択解除が反映されるようにする（実DOMでの
       「disabled化されたラジオはchecked状態も失う」を模したテスト用の配線）。 */
    setPaymentMethod: function (v) {
      selectedPaymentMethod = v;
      if (v === CARD_VALUE) cardRadioEl.checked = true;
    },
    triggerPaymentMethodChange: function () {
      root._listeners.change({ target: { name: 'paymentMethod' } });
    },
    setTimeBand: function (v) { selectedTimeBand = v; },
    requests: requests,
    getFetchCallCount: function () { return fetchCallCount; }
  };
}

function fillStep3RequiredFields(ctx) {
  ctx.elements['ba-name'].value = '山田太郎';
  ctx.elements['ba-email'].value = 'taro@example.com';
  ctx.elements['ba-people'].value = '2名';
  ctx.elements['ba-purpose'].value = 'セルフ撮影';
}

test('Issue #407: 10日先の日程ではカード決済を選択できる（disabledにならない）', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  assert.strictEqual(ctx.cardRadio.disabled, false);
});

test('Issue #407: 利用経験ありは、当日・翌日・2日後・3日後のいずれでもカード決済を選択できる（96時間制限は撤廃）', async function () {
  for (var offset = 0; offset <= 3; offset++) {
    var ctx = setupCardFlow(null);
    ctx.elements['ba-date'].value = jstDateString(offset);
    ctx.elements['ba-duration'].value = '2';
    ctx.setCustomerType('returning');
    ctx.elements['ba-step-datetime-next']._listeners.click();
    await flushPromises();

    ctx.startTimeButtons[0]._listeners.click();
    ctx.elements['ba-step-start-time-next']._listeners.click();

    assert.strictEqual(ctx.cardRadio.disabled, false, offset + '日後でもカードは選択可能');
    assert.strictEqual(ctx.elements['ba-first-time-card-notice'].hidden, true, '利用経験ありには初回利用向け案内を出さない');

    fillStep3RequiredFields(ctx);
    ctx.setPaymentMethod(CARD_VALUE);
    ctx.elements['ba-step-details-next']._listeners.click();
    assert.strictEqual(ctx.elements['ba-step-confirm'].hidden, false, offset + '日後でも確認画面へ進める');
  }
});

test('Issue #407: 日時を直前の日程へ変更してもカード選択は解除されない', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();
  ctx.setPaymentMethod(CARD_VALUE);
  assert.strictEqual(ctx.cardRadio.checked, true);

  ctx.elements['ba-step-details-back']._listeners.click();
  ctx.elements['ba-date'].value = jstDateString(1);
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  assert.strictEqual(ctx.cardRadio.disabled, false);
  assert.strictEqual(ctx.cardRadio.checked, true, '翌日に変更してもカード選択は維持される');
});

test('Issue #407: 初回利用はStep3でカードが選択済みになり、初回利用向け案内が表示される。カード以外の支払方法では確認画面へ進めない', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(0);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('first_time');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-people'].value = '2名';
  ctx.elements['ba-step-start-time-next']._listeners.click();

  assert.strictEqual(ctx.cardRadio.checked, true, '初回利用はカードが選択済み');
  assert.strictEqual(ctx.elements['ba-first-time-card-notice'].hidden, false);

  /* DOMを書き換えて現金を送ろうとしても、確認画面へ進めない */
  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();
  assert.strictEqual(ctx.elements['ba-step-confirm'].hidden, true, '確認画面へ進めないこと');
  assert.strictEqual(ctx.elements['ba-payment-error'].hidden, false);
  assert.strictEqual(ctx.requests.length, 0);

  /* カードなら当日でも確認画面へ進める */
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();
  assert.strictEqual(ctx.elements['ba-step-confirm'].hidden, false);
});

test('Issue #334 PR-B: 送信直前もなお受付期限内であれば、通常どおり送信できる（回帰なし）', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  /*
   * Issue #341 PR-B: createBooking成功後、カード決済のみ追加でstartCardCheckoutを
   * 呼ぶため2件になる（このテストのfetchスタブはURLを問わずsuccess:trueを返すが
   * checkoutUrlを含まないため、attemptCardCheckout_はnullへ丸めて既存の「決済リンクを
   * 後日送付」案内フォールバックへ進む。回帰なし）。
   */
  assert.strictEqual(ctx.requests.length, 2);
  assert.match(ctx.requests[1].url, /action=startCardCheckout/);
  assert.strictEqual(ctx.requests[1].body.bookingId, 'SNB-CARD-TEST');
  assert.strictEqual(ctx.elements['ba-step-complete'].hidden, false);
});

test('Issue #334 PR-B: カード選択時のみ、支払方法欄付近にCheckout基準の注意書きが表示される', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  ctx.setPaymentMethod(CARD_VALUE);
  ctx.triggerPaymentMethodChange();

  var text = ctx.elements['ba-card-payment-notice'].renderedText();
  assert.strictEqual(ctx.elements['ba-card-payment-notice'].hidden, false);
  assert.match(text, /【クレジットカード決済】/);
  assert.match(text, /予約申込後30分以内にお支払いを完了してください/);
  assert.match(text, /未決済・期限切れの場合、予約は確定しません/);
  assert.doesNotMatch(text, /24時間|72時間|96時間/);

  /* 現金へ切り替えると即座に消える（現金・PayPay・未定にカード専用文言を混入させない） */
  ctx.setPaymentMethod('現金');
  ctx.triggerPaymentMethodChange();
  assert.strictEqual(ctx.elements['ba-card-payment-notice'].hidden, true);
});

test('Issue #334 PR-B: 現金・PayPay・未定を選んでも支払方法欄の注意書きは一度も表示されない', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  ['現金', 'PayPay', '未定'].forEach(function (method) {
    ctx.setPaymentMethod(method);
    ctx.triggerPaymentMethodChange();
    assert.strictEqual(ctx.elements['ba-card-payment-notice'].hidden, true, method + 'では注意書きが出ないこと');
  });
});

test('Issue #334 PR-B: 予約確認画面にもカード選択時のみCheckout基準の注意書きが表示される', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();

  assert.strictEqual(ctx.elements['ba-step-confirm'].hidden, false);
  assert.strictEqual(ctx.elements['ba-confirm-card-payment-notice'].hidden, false);
  var confirmText = ctx.elements['ba-confirm-card-payment-notice'].renderedText();
  assert.match(confirmText, /未決済・期限切れの場合、予約は確定しません/);
  assert.doesNotMatch(confirmText, /24時間|72時間|96時間/);
});

test('Issue #334 PR-B: 現金決済では予約確認画面のカード注意書きが表示されない（既存の仮予約バナーのみ）', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();

  assert.strictEqual(ctx.elements['ba-confirm-card-payment-notice'].hidden, true);
});

test('Issue #334 PR-B: 仮予約送信成功後、カード決済のみ完了画面のカード注意書きが表示され、既存の24時間案内は隠れる', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-step-complete'].hidden, false);
  assert.strictEqual(ctx.elements['ba-complete-generic-notice'].hidden, true, '既存の「通常24時間以内にご連絡します」は隠れること');
  assert.strictEqual(ctx.elements['ba-complete-card-payment-notice'].hidden, false);
  var completeText = ctx.elements['ba-complete-card-payment-notice'].renderedText();
  assert.match(completeText, /運営より決済方法をご案内します/);
  assert.doesNotMatch(completeText, /24時間|72時間|96時間/);
});

test('Issue #341 PR-B: startCardCheckoutがcheckoutUrlを返した場合、旧「決済リンクを後日送付」案内の代わりにStripe決済ボタンを表示する', async function () {
  var ctx = setupCardFlow(null, {
    checkoutResponse: {
      success: true,
      checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_abc',
      amount: 8000,
      currency: 'JPY'
    }
  });
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-step-complete'].hidden, false);
  assert.strictEqual(ctx.elements['ba-complete-card-payment-notice'].hidden, true, '旧「決済リンクを後日送付」案内は表示しない');
  assert.strictEqual(ctx.elements['ba-complete-checkout-notice'].hidden, false);
  assert.match(
    ctx.elements['ba-complete-checkout-notice'].renderedText(),
    /未決済・期限切れの場合、予約は確定しません/,
    '期限切れ/未決済は確定しない旨を案内する（Issue #407 / #454）'
  );
  assert.strictEqual(ctx.elements['ba-complete-checkout-wrap'].hidden, false);
  assert.strictEqual(ctx.elements['ba-complete-checkout-link'].href, 'https://checkout.stripe.com/pay/cs_test_abc');
});

/*
 * PR #354レビュー対応・項目3: startCardCheckoutの結果コード別に、正しい画面へ振り分けること
 * を検証する。CHECKOUT_DISABLED（確実に未着手）だけが旧「決済リンクを後日送付」案内へ
 * フォールバックしてよく、それ以外はすべて専用の「確認できません」エラー画面を表示し、
 * 旧方式へは絶対に誘導しない（二重決済防止）。
 */
[
  { code: 'CHECKOUT_DISABLED', expectedNotice: 'fallback' },
  { code: 'STRIPE_NOT_CONFIGURED', expectedNotice: 'fallback' },
  { code: 'PAYMENT_STATUS_UNKNOWN', expectedNotice: 'uncertain' },
  { code: 'PAYMENT_DETAIL_WRITE_FAILED', expectedNotice: 'uncertain' },
  { code: 'PAYMENT_POSSIBLY_COMPLETED', expectedNotice: 'uncertain' },
  { code: 'FORBIDDEN', expectedNotice: 'uncertain' },
  { code: 'STRIPE_REQUEST_ERROR', expectedNotice: 'uncertain' }
].forEach(function (testCase) {
  test('startCardCheckoutがerror.code=' + testCase.code + 'を返した場合、' +
    (testCase.expectedNotice === 'fallback' ? '旧「決済リンクを後日送付」案内を表示する' : '旧方式へ誘導せず専用のエラー案内を表示する'), async function () {
    var ctx = setupCardFlow(null, {
      checkoutResponse: { success: false, error: { code: testCase.code, message: 'test message' } }
    });
    ctx.elements['ba-date'].value = jstDateString(10);
    ctx.elements['ba-duration'].value = '2';
    ctx.setCustomerType('returning');
    ctx.elements['ba-step-datetime-next']._listeners.click();
    await flushPromises();
    ctx.startTimeButtons[0]._listeners.click();
    ctx.elements['ba-step-start-time-next']._listeners.click();

    fillStep3RequiredFields(ctx);
    ctx.setPaymentMethod(CARD_VALUE);
    ctx.elements['ba-step-details-next']._listeners.click();

    ctx.elements['ba-confirm-consent'].checked = true;
    ctx.elements['ba-submit']._listeners.click();
    await flushPromises();

    assert.strictEqual(ctx.elements['ba-step-complete'].hidden, false);
    if (testCase.expectedNotice === 'fallback') {
      assert.strictEqual(ctx.elements['ba-complete-card-payment-notice'].hidden, false, '確実に未着手のコードは旧案内を表示してよい');
      assert.strictEqual(ctx.elements['ba-complete-checkout-uncertain-notice'].hidden, true);
      assert.strictEqual(ctx.elements['ba-complete-checkout-wrap'].hidden, true);
    } else {
      assert.strictEqual(ctx.elements['ba-complete-card-payment-notice'].hidden, true, '結果不明・要対応のコードでは旧「決済リンクを後日送付」案内を絶対に表示しない（二重決済防止）');
      assert.strictEqual(ctx.elements['ba-complete-checkout-uncertain-notice'].hidden, false);
      assert.strictEqual(ctx.elements['ba-complete-checkout-wrap'].hidden, true);
      assert.match(
        ctx.elements['ba-complete-checkout-uncertain-notice'].renderedText(),
        /確認できませんでした/
      );
    }
  });
});

test('startCardCheckout自体のfetchが失敗（ネットワーク断・タイムアウト）した場合も、旧方式へ誘導せず専用のエラー案内を表示する', async function () {
  var ctx = setupCardFlow(null, { checkoutFetchThrows: true });
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-step-complete'].hidden, false);
  assert.strictEqual(ctx.elements['ba-complete-card-payment-notice'].hidden, true, 'fetch自体の失敗も旧方式へフォールバックしない');
  assert.strictEqual(ctx.elements['ba-complete-checkout-uncertain-notice'].hidden, false);
});

test('Issue #334 PR-B: 仮予約送信成功後、現金決済では完了画面は既存どおり（回帰なし）', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-complete-generic-notice'].hidden, false);
  assert.strictEqual(ctx.elements['ba-complete-card-payment-notice'].hidden, true);
});

test('Issue #334 PR-B: 先の日程でカード決済を選んだ場合は通常どおり送信できる（既存の予約確定処理に回帰がない）', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  /* Issue #341 PR-B: createBooking成功後にstartCardCheckoutが追加で1回呼ばれる（上記コメント参照）。 */
  assert.strictEqual(ctx.requests.length, 2);
  assert.strictEqual(ctx.requests[0].body.paymentMethod, CARD_VALUE);
  assert.strictEqual(ctx.elements['ba-complete-booking-id'].textContent, 'SNB-CARD-TEST');
});

/* ── Issue #334 PR-B: _includes/booking_app_ja.htmlの静的な文言・要素IDの確認。
   JSはhidden切り替えのみを行うため、案内文そのものの正しさはHTMLの生テキストを
   直接検証する（DOMスタブ越しでは静的textContentを再現できないため）。 ── */
test('_includes/booking_app_ja.html: 初回利用向けカード案内・各注意書きコンテナのIDが存在し、96時間制限の案内は残っていない', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_ja.html'), 'utf8');

  assert.match(html, /id="ba-first-time-card-notice"[^>]*>初回利用の方はオンラインクレジットカード決済のみご利用いただけます。/);
  assert.doesNotMatch(html, /ba-card-ineligible-notice/);
  assert.doesNotMatch(html, /4日前|96時間/);
  assert.match(html, /id="ba-card-payment-notice"/);
  assert.match(html, /id="ba-confirm-card-payment-notice"/);
  assert.match(html, /id="ba-complete-generic-notice"/);
  assert.match(html, /id="ba-complete-card-payment-notice"/);
});

/* ── Issue #445: オンラインクレカは「申込→そのまま決済→決済完了で即確定」と分かる導線 ── */

async function goToDetailsStep_(ctx) {
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();
}

function flowBannerText_(ctx) {
  return ctx.elements['ba-flow-banner-title'].textContent + ' ' + ctx.elements['ba-flow-banner-body'].textContent;
}

test('Issue #445: フォーム上部バナーは、クレカ選択で「決済完了で確定」、現金・PayPayで「仮受付→管理者確認」へ切り替わり、切替で更新される', async function () {
  var ctx = setupCardFlow(null);
  await goToDetailsStep_(ctx);

  ctx.setPaymentMethod(CARD_VALUE);
  ctx.triggerPaymentMethodChange();
  var card = flowBannerText_(ctx);
  assert.match(card, /お支払い完了で予約確定/);
  assert.match(card, /予約申込後30分以内にお支払いを完了してください/);
  assert.doesNotMatch(card, /仮予約|PENDING|仮受付|管理者|確定のご連絡|当方から/);

  ['現金', 'PayPay'].forEach(function (method) {
    ctx.setPaymentMethod(method);
    ctx.triggerPaymentMethodChange();
    var manual = flowBannerText_(ctx);
    assert.match(manual, /仮受付/, method);
    assert.match(manual, /この時点では予約は確定していません/, method);
    assert.match(manual, /確定のご連絡/, method);
    assert.doesNotMatch(manual, /お支払い完了で予約確定/, method);
  });

  ctx.setPaymentMethod(CARD_VALUE);
  ctx.triggerPaymentMethodChange();
  assert.match(flowBannerText_(ctx), /お支払い完了で予約確定/, '現金からクレカへ戻すと表示が戻る');
});

test('Issue #445: クレカ選択の支払方法欄・確認画面に「申込後そのままお支払いへ進み、完了後すぐ確定」が出て、管理者確認待ち・後払いを連想させる文言が出ない', async function () {
  var ctx = setupCardFlow(null);
  await goToDetailsStep_(ctx);
  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.triggerPaymentMethodChange();

  var fieldNotice = ctx.elements['ba-card-payment-notice'].renderedText();
  assert.match(fieldNotice, /予約申込後、そのままお支払いへ進みます。/);
  assert.match(fieldNotice, /お支払い完了で予約確定となります。/);
  assert.match(fieldNotice, /支払済みの場合は再決済せず、運営へご連絡ください。/);

  ctx.elements['ba-step-details-next']._listeners.click();
  assert.strictEqual(ctx.elements['ba-step-confirm'].hidden, false);

  var confirmText = [
    ctx.elements['ba-confirm-heading'].textContent,
    ctx.elements['ba-confirm-flow-title'].textContent,
    ctx.elements['ba-confirm-flow-body'].textContent,
    ctx.elements['ba-consent-text'].textContent,
    ctx.elements['ba-confirm-card-payment-notice'].renderedText()
  ].join('\n');
  assert.match(confirmText, /お支払い完了で予約が確定/);
  assert.match(confirmText, /お支払い画面へ進む/);
  assert.match(confirmText, /予約申込後30分以内にお支払いを完了してください/);
  assert.doesNotMatch(confirmText, /仮予約|PENDING|仮受付|管理者|確定のご連絡|確定連絡|当方から/);

  assert.strictEqual(ctx.elements['ba-submit'].textContent, '予約内容を確認して支払いへ進む');
});

test('Issue #445: 現金・PayPayの確認画面と送信ボタンは従来どおり仮受付→確定連絡の案内・文言を維持する', async function () {
  for (const method of ['現金', 'PayPay']) {
    var ctx = setupCardFlow(null);
    await goToDetailsStep_(ctx);
    fillStep3RequiredFields(ctx);
    ctx.setPaymentMethod(method);
    ctx.triggerPaymentMethodChange();
    ctx.elements['ba-step-details-next']._listeners.click();

    assert.strictEqual(ctx.elements['ba-confirm-heading'].textContent, '内容を確認して仮予約を送信', method);
    assert.match(ctx.elements['ba-confirm-flow-title'].textContent, /仮受付/, method);
    assert.match(ctx.elements['ba-confirm-flow-title'].textContent, /予約は確定していません/, method);
    assert.match(ctx.elements['ba-confirm-flow-body'].textContent, /確定のご連絡/, method);
    assert.match(ctx.elements['ba-consent-text'].textContent, /確定連絡をもって予約成立/, method);
    assert.strictEqual(ctx.elements['ba-submit'].textContent, 'この内容で仮予約を送信する', method);
  }
});

test('Issue #445: クレカの送信後は「予約申込を受け付けました→続けてお支払いへ→決済完了後に確定」を示し、仮予約完了を主見出しにしない', async function () {
  var ctx = setupCardFlow(null, { checkoutResponse: { success: true, checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_abc' } });
  await goToDetailsStep_(ctx);
  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();
  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-step-complete'].hidden, false);
  assert.strictEqual(ctx.elements['ba-complete-heading'].textContent, '予約申込を受け付けました');
  assert.strictEqual(ctx.elements['ba-complete-status-label'].textContent, '予約ステータス');
  assert.match(ctx.elements['ba-complete-status'].textContent, /お支払い完了で確定/);
  var redirect = ctx.elements['ba-complete-checkout-notice'].renderedText();
  assert.match(redirect, /予約申込を受け付けました/);
  assert.match(redirect, /続けて/);
  assert.match(redirect, /お支払い完了後、予約が確定します/);
  assert.match(redirect, /予約申込後30分以内にお支払いを完了してください/);
  assert.match(redirect, /未決済・期限切れの場合、予約は確定しません/);
  assert.doesNotMatch(redirect + ctx.elements['ba-complete-heading'].textContent, /仮予約|管理者|確定のご連絡/);
});

test('Issue #445: 現金の送信後は従来どおり仮予約受付の完了画面・管理者確認の案内を維持する', async function () {
  var ctx = setupCardFlow(null);
  await goToDetailsStep_(ctx);
  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod('現金');
  ctx.elements['ba-step-details-next']._listeners.click();
  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-complete-heading'].textContent, '仮予約の送信を受け付けました');
  assert.strictEqual(ctx.elements['ba-complete-status-label'].textContent, '仮予約ステータス');
  assert.strictEqual(ctx.elements['ba-complete-generic-notice'].hidden, false);
});

test('Issue #445: 全ブランド（SNB / SNB mens / Studio X）が共通のbooking_app_ja/enインクルードを使い、静的な共通バナーに「仮予約（PENDING）」を前面に出さない', function () {
  ['booking/index.html', 'mens/booking/index.html', 'studio-x/booking/index.html'].forEach(function (file) {
    var html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(html, /booking_app_ja\.html/, file);
  });
  ['ja', 'en'].forEach(function (lang) {
    var html = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_' + lang + '.html'), 'utf8');
    ['ba-flow-banner-title', 'ba-flow-banner-body', 'ba-confirm-flow-title', 'ba-confirm-flow-body', 'ba-consent-text', 'ba-confirm-heading', 'ba-complete-heading', 'ba-complete-status-label'].forEach(function (id) {
      assert.match(html, new RegExp('id="' + id + '"'), lang + ' ' + id);
    });
  });
  var ja = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_ja.html'), 'utf8');
  assert.doesNotMatch(ja, /このフォームの送信は「仮予約（PENDING）」の申込です/);
  assert.doesNotMatch(ja, /送信すると「仮予約（PENDING）」として受け付けます/);
});

test('Issue #445レビュー: 初回利用はカード決済のみの案内は補足文(ba-field-help)ではなく強調noticeとして存在し、CSSで太字になる', function () {
  var css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'booking.css'), 'utf8');
  ['ja', 'en'].forEach(function (lang) {
    var html = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_' + lang + '.html'), 'utf8');
    var tag = html.match(/<p[^>]*id="ba-first-time-card-notice"[^>]*>/);
    assert.ok(tag, lang);
    assert.match(tag[0], /class="[^"]*ba-banner[^"]*ba-banner--notice[^"]*ba-first-time-card-notice/, lang);
    assert.doesNotMatch(tag[0], /ba-field-help/, lang);
    assert.match(tag[0], /role="note"/, lang);
  });
  assert.match(css, /\.ba-first-time-card-notice\s*\{[^}]*font-weight:\s*700/);
});

test('Issue #445レビュー: 利用者向けコピー（フォームのHTML・案内文言）に「管理者」「Admin」を出さない', function () {
  var strip = function (html) {
    return html.replace(/<!--[\s\S]*?-->/g, '');
  };
  ['ja', 'en'].forEach(function (lang) {
    var html = strip(fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_' + lang + '.html'), 'utf8'));
    assert.doesNotMatch(html, /管理者|\bAdmin(istrator)?\b/, lang);
  });
  var Logic = loadLogicForCopy_();
  ['ja', 'en'].forEach(function (locale) {
    ['', 'オンラインクレジットカード', '現金', 'PayPay', '未定'].forEach(function (method) {
      var copy = JSON.stringify(Logic.bookingFlowCopy(method, locale));
      assert.doesNotMatch(copy, /管理者|\bAdmin(istrator)?\b/, locale + ':' + method);
    });
    assert.doesNotMatch(Logic.cardPaymentNoticeLines(locale).join('\n'), /管理者|\bAdmin(istrator)?\b/, locale);
  });
});

function loadLogicForCopy_() {
  return require(path.join(__dirname, '..', 'scripts', 'booking-logic.js'));
}

test('Issue #445レビュー: クレカ選択時、フォーム上部・支払方法欄・確認画面の同意文に「予約申込後30分以内」の支払期限が出る（曖昧な失効表現だけにしない）', async function () {
  var ctx = setupCardFlow(null);
  await goToDetailsStep_(ctx);
  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.triggerPaymentMethodChange();

  assert.match(flowBannerText_(ctx), /予約申込後30分以内にお支払いを完了してください/);
  assert.match(ctx.elements['ba-card-payment-notice'].renderedText(), /予約申込後30分以内にお支払いを完了してください/);

  ctx.elements['ba-step-details-next']._listeners.click();
  assert.match(ctx.elements['ba-consent-text'].textContent, /30分以内にお支払いを完了すること/);
  assert.match(ctx.elements['ba-confirm-card-payment-notice'].renderedText(), /予約申込後30分以内にお支払いを完了してください/);

  /* 現金・PayPayには30分の支払期限を出さない */
  ctx.setPaymentMethod('現金');
  ctx.triggerPaymentMethodChange();
  assert.doesNotMatch(flowBannerText_(ctx), /30分/);
});

test('Issue #445レビュー: Checkout作成後の完了画面は、paymentHoldExpiresAtをAsia/Tokyo基準の「お支払い期限：YYYY/MM/DD HH:mm」で表示し、値がなければ期限行を出さない', async function () {
  async function submitWith_(checkoutResponse) {
    var ctx = setupCardFlow(null, { checkoutResponse: checkoutResponse });
    await goToDetailsStep_(ctx);
    fillStep3RequiredFields(ctx);
    ctx.setPaymentMethod(CARD_VALUE);
    ctx.elements['ba-step-details-next']._listeners.click();
    ctx.elements['ba-confirm-consent'].checked = true;
    ctx.elements['ba-submit']._listeners.click();
    await flushPromises();
    return ctx.elements['ba-complete-checkout-notice'].renderedText();
  }

  /* 2033-05-18T03:33:19Z = JST 12:33（端末のローカル時刻に依存しない） */
  var withDeadline = await submitWith_({
    success: true, checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_abc',
    paymentHoldExpiresAt: '2033-05-18T03:33:19.000Z'
  });
  assert.match(withDeadline, /お支払い期限：2033\/05\/18 12:33/);
  assert.match(withDeadline, /予約申込後30分以内にお支払いを完了してください/);

  var without = await submitWith_({ success: true, checkoutUrl: 'https://checkout.stripe.com/pay/cs_test_abc' });
  assert.doesNotMatch(without, /お支払い期限：/);
  assert.match(without, /予約申込後30分以内にお支払いを完了してください/);
});

/* ── Issue #520: 料金表示エリアに選択した利用時間帯（開始〜終了）を表示する ── */
test('Issue #520: 開始時刻を選ぶと料金表示エリアに「利用時間：開始〜終了（N時間）」が出る', async function () {
  var ctx = setupFullFlow(null, { bookableStartTimes: ['11:00', '12:15'] });

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '6';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-price-time'].hidden, true, '開始時刻の未選択時は出さない');
  assert.strictEqual(ctx.elements['ba-price-time'].textContent, '');

  ctx.startTimeButtons[0]._listeners.click();
  assert.strictEqual(ctx.elements['ba-price-time'].hidden, false);
  assert.strictEqual(ctx.elements['ba-price-time'].textContent, '利用時間：11:00〜17:00（6時間）');

  ctx.startTimeButtons[1]._listeners.click();
  assert.strictEqual(ctx.elements['ba-price-time'].textContent, '利用時間：12:15〜18:15（6時間）', '開始時刻の変更で即時更新');
  assert.strictEqual(ctx.elements['ba-price-line'].textContent, '利用料金: ¥4,000（税込）', '料金表示は変わらない');
});

test('Issue #520: 利用時間を変更すると開始時刻が未選択に戻り、利用時間帯は消える', async function () {
  var ctx = setupFullFlow(null, { bookableStartTimes: ['11:00'] });

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '6';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  assert.strictEqual(ctx.elements['ba-price-time'].hidden, false);

  ctx.elements['ba-duration'].value = '3';
  ctx.elements['ba-duration']._listeners.change();
  assert.strictEqual(ctx.elements['ba-price-time'].hidden, true, '古い時間帯を残さない');
});
