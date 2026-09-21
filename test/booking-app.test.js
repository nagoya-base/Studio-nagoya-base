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
    getBrandMeta: function () { return { displayName: 'Studio Nagoya Base' }; },
    todayInJapan: function () { return '2026-09-21'; },
    buildCreateBookingPayload: function () { return {}; },
    messageForErrorCode: function () { return '予約の保存に失敗しました。'; },
    recoveryActionForErrorCode: function () { return 'retry'; }
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
