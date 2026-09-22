/*
 * scripts/booking-app.js（共通予約UI）のIssue #273一時診断表示テスト。
 * 外部DOMライブラリへ依存せず、送信失敗レスポンスからエラー欄への表示までを
 * 最小DOMスタブで通し、ブラウザが受け取ったrequestIdを確認できることを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

function createElement(id) {
  var listeners = {};
  return {
    id: id,
    hidden: true,
    disabled: false,
    checked: id === 'ba-confirm-consent',
    value: '',
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
    messageForErrorCode: function () { return '予約の保存に失敗しました。'; },
    recoveryActionForErrorCode: function () { return 'retry'; },
    customerTypeLabel: function () { return ''; },
    validateDetailsForm: function () { return {}; },
    peopleLabel: function (v) { return v; },
    purposeLabel: function (v) { return v; },
    paymentMethodLabel: function (v) { return v; },
    networkErrorMessage: function () { return '通信状況をご確認のうえ、時間を置いて再度お試しください。'; },
    apiNotConfiguredMessage: function () { return '現在オンライン予約の準備中です。恐れ入りますが、しばらくしてから再度お試しください。'; }
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
function setupFullFlow(locale) {
  var elements = {};
  var startTimeButtons = [];
  var selectedCustomerType = null;
  var selectedPaymentMethod = null;
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
    fetch: function (url, options) {
      fetchCallCount += 1;
      if (options && options.method === 'POST') {
        requests.push({ url: url, body: JSON.parse(options.body) });
        return Promise.resolve({ json: function () {
          return Promise.resolve({ success: true, bookingId: 'SNB-FULLFLOW-TEST', requestId: 'req-full-flow' });
        } });
      }
      return Promise.resolve({ json: function () {
        return Promise.resolve({ success: true, bookableStartTimes: ['10:00', '11:00'] });
      } });
    }
  });

  return {
    elements: elements,
    startTimeButtons: startTimeButtons,
    setCustomerType: function (v) { selectedCustomerType = v; },
    setPaymentMethod: function (v) { selectedPaymentMethod = v; },
    requests: requests,
    getFetchCallCount: function () { return fetchCallCount; }
  };
}

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

/* ── Issue #301: 新予約UIのStep 1で2時間未満を即時拒否する。
   setupFullFlow(locale)でStep1のclick handlerを実際に通し、durationMinutesの計算だけでなく
   getAvailability呼び出し（fetch）自体が起きていないことまで確認する。 */
test('Issue #301: 日本語（locale未指定）でduration=1はStep 1で止まり、field errorを表示してgetAvailabilityを呼ばない', async function () {
  var ctx = setupFullFlow(null);

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '1';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-duration-error'].textContent, '利用時間を2時間以上の整数で入力してください。');
  assert.strictEqual(ctx.elements['ba-duration-error'].hidden, false);
  assert.strictEqual(ctx.startTimeButtons.length, 0, 'Step 2の開始時刻選択肢が描画されないこと');
  assert.strictEqual(ctx.getFetchCallCount(), 0, 'getAvailabilityが呼ばれないこと');
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

test('Issue #301: locale="en"でduration=1はStep 1で止まり、英語field errorを表示してgetAvailabilityを呼ばない', async function () {
  var ctx = setupFullFlow('en');

  ctx.elements['ba-date'].value = '2026-10-10';
  ctx.elements['ba-duration'].value = '1';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(
    ctx.elements['ba-duration-error'].textContent,
    'Please enter a duration of 2 hours or more (whole numbers only).'
  );
  assert.strictEqual(ctx.elements['ba-duration-error'].hidden, false);
  assert.strictEqual(ctx.startTimeButtons.length, 0, 'Step 2の開始時刻選択肢が描画されないこと');
  assert.strictEqual(ctx.getFetchCallCount(), 0, 'getAvailabilityが呼ばれないこと');
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
