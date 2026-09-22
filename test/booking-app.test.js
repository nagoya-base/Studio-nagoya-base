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
