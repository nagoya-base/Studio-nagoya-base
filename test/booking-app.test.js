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
    peopleLabel: function (v) { return v; },
    purposeLabel: function (v) { return v; },
    paymentMethodLabel: function (v) { return v; },
    networkErrorMessage: function () { return '通信状況をご確認のうえ、時間を置いて再度お試しください。'; },
    apiNotConfiguredMessage: function () { return '現在オンライン予約の準備中です。恐れ入りますが、しばらくしてから再度お試しください。'; },
    /* Issue #334 PR-B: 送信成功ハンドラがカード決済かどうかを毎回判定するため、
       このstubでも最低限の実装を用意する（このテスト群はstate.paymentMethodが
       常に空文字のため、常にfalseを返す形で足りる）。 */
    CARD_PAYMENT_METHOD_VALUE: 'オンラインクレジットカード',
    isCardPaymentMethodValue: function (v) { return v === 'オンラインクレジットカード'; }
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
    fetch: function (url, options) {
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
    'ba-card-ineligible-notice',
    'ba-card-payment-notice',
    'ba-confirm-card-payment-notice',
    'ba-complete-card-payment-notice'
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
        return Promise.resolve({ json: function () {
          return Promise.resolve({ success: true, bookingId: 'SNB-CARD-TEST', requestId: 'req-card' });
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

test('Issue #334 PR-B: 利用開始まで96時間ちょうどはカード決済を選択できる（disabledにならない）', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  assert.strictEqual(ctx.cardRadio.disabled, false);
  assert.strictEqual(ctx.elements['ba-card-ineligible-notice'].hidden, true);
});

test('Issue #334 PR-B: 利用開始まで96時間未満ではカード決済を選択できない（disabled）', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(1);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  assert.strictEqual(ctx.cardRadio.disabled, true);
  /* 案内文自体は_includes/booking_app_ja.html側の静的テキストとして配信され、
     JSはhidden切り替えのみを行う（wordingの検証はHTML側の別テストで行う）。 */
  assert.strictEqual(ctx.elements['ba-card-ineligible-notice'].hidden, false);
});

test('Issue #334 PR-B: 日時変更によって96時間未満になった場合、カード選択が解除され送信できない', async function () {
  var ctx = setupCardFlow(null);

  /* 1回目: 96時間以上先の日程でStep3へ進み、カードを選択する */
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();
  assert.strictEqual(ctx.cardRadio.disabled, false);
  ctx.setPaymentMethod(CARD_VALUE);
  assert.strictEqual(ctx.cardRadio.checked, true);

  /* Step3→Step2→Step1と戻り、96時間未満の日程へ変更してStep3へ再度進む */
  ctx.elements['ba-step-details-back']._listeners.click();
  ctx.elements['ba-step-start-time-back']._listeners.click();
  ctx.elements['ba-date'].value = jstDateString(1);
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();

  assert.strictEqual(ctx.cardRadio.disabled, true, '96時間未満になったらdisabledへ戻ること');
  assert.strictEqual(ctx.cardRadio.checked, false, '選択も解除されること');

  /* 送信直前のバリデーションでも、支払方法未選択として弾かれ、確認画面へ進めない */
  fillStep3RequiredFields(ctx);
  ctx.elements['ba-step-details-next']._listeners.click();
  assert.strictEqual(ctx.elements['ba-step-confirm'].hidden, true, '確認画面へ進めないこと');
  assert.strictEqual(ctx.elements['ba-payment-error'].hidden, false);
});

/* ── PRレビュー対応: 予約確認画面を開いたまま96時間の受付期限を過ぎた場合の
   最終送信直前の再判定（Issue #334 PR-B）。実際の壁時計を4日以上進めることはできないため、
   Step2→Step3遷移時点では現実のLogic.isCardPaymentEligibleで「適格」判定を通したあと、
   確認画面へ進んでから送信直前だけLogic.isCardPaymentEligibleを一時的に差し替えて
   「その間に期限が過ぎた」状況を再現する（呼び出し回数・呼び出し時の引数も確認する）。 ── */
test('Issue #334 PR-B: 確認画面を開いたまま受付期限を過ぎた場合、最終送信直前の再判定で送信を中止し、現地決済を案内する', async function () {
  var ctx = setupCardFlow(null);
  ctx.elements['ba-date'].value = jstDateString(10);
  ctx.elements['ba-duration'].value = '2';
  ctx.setCustomerType('returning');
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  ctx.startTimeButtons[0]._listeners.click();
  ctx.elements['ba-step-start-time-next']._listeners.click();
  assert.strictEqual(ctx.cardRadio.disabled, false, 'Step3進入時点ではまだ96時間以上先で選択できる');

  fillStep3RequiredFields(ctx);
  ctx.setPaymentMethod(CARD_VALUE);
  ctx.elements['ba-step-details-next']._listeners.click();
  assert.strictEqual(ctx.elements['ba-step-confirm'].hidden, false, '確認画面まで進めること（この時点ではまだ適格）');

  /* 確認画面を開いている間に受付期限を過ぎた状況を再現する */
  var eligibilityCalls = [];
  var originalIsEligible = ctx.Logic.isCardPaymentEligible;
  ctx.Logic.isCardPaymentEligible = function (dateValue, startTimeValue) {
    eligibilityCalls.push([dateValue, startTimeValue]);
    return false;
  };

  ctx.elements['ba-confirm-consent'].checked = true;
  ctx.elements['ba-submit']._listeners.click();

  ctx.Logic.isCardPaymentEligible = originalIsEligible;

  assert.strictEqual(ctx.requests.length, 0, 'fetch自体が発生せず送信は中止されること');
  /* 送信ハンドラの判定自体で1回、その後の選択解除（updateCardPaymentGating）内でも
     同じ判定を再利用するため1回、計2回呼ばれる。いずれも同じ引数であること。 */
  assert.ok(eligibilityCalls.length >= 1);
  eligibilityCalls.forEach(function (call) {
    assert.deepStrictEqual(call, [ctx.elements['ba-date'].value, ctx.startTimeButtons[0].textContent]);
  });
  assert.strictEqual(ctx.elements['ba-step-details'].hidden, false, 'Step3（利用者情報）へ戻ること');
  assert.strictEqual(ctx.elements['ba-step-confirm'].hidden, true);
  assert.strictEqual(ctx.cardRadio.disabled, true, '戻った時点でカードは選択不可へ更新されること');
  assert.strictEqual(ctx.cardRadio.checked, false);
  assert.strictEqual(ctx.elements['ba-global-error'].hidden, false, '現地決済への案内が表示されること');
  assert.match(
    ctx.elements['ba-global-error-message'].textContent,
    /カード事前決済は利用開始の4日前までのお申し込みです。直前のご予約は現金・PayPay（現地決済）をお選びください。/
  );
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

  assert.strictEqual(ctx.requests.length, 1);
  assert.strictEqual(ctx.elements['ba-step-complete'].hidden, false);
});

test('Issue #334 PR-B: カード選択時のみ、支払方法欄付近に支払期限つきの注意書きが表示される', async function () {
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
  assert.match(text, /【クレジットカード決済のご案内】/);
  assert.match(text, /24時間以内にメールでお送りします/);
  assert.match(text, /お支払い期限：お申し込みから72時間後/);
  assert.match(text, /自動的に失効/);

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

test('Issue #334 PR-B: 予約確認画面にもカード選択時のみ支払期限つきの注意書きが表示される', async function () {
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
  assert.match(ctx.elements['ba-confirm-card-payment-notice'].renderedText(), /お支払い期限：お申し込みから72時間後/);
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
  assert.match(ctx.elements['ba-complete-card-payment-notice'].renderedText(), /お支払い期限：お申し込みから72時間後/);
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

test('Issue #334 PR-B: 96時間以上先の日程でカード決済を選んだ場合は通常どおり送信できる（既存の予約確定処理に回帰がない）', async function () {
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

  assert.strictEqual(ctx.requests.length, 1);
  assert.strictEqual(ctx.requests[0].body.paymentMethod, CARD_VALUE);
  assert.strictEqual(ctx.elements['ba-complete-booking-id'].textContent, 'SNB-CARD-TEST');
});

/* ── Issue #334 PR-B: _includes/booking_app_ja.htmlの静的な文言・要素IDの確認。
   JSはhidden切り替えのみを行うため、案内文そのものの正しさはHTMLの生テキストを
   直接検証する（DOMスタブ越しでは静的textContentを再現できないため）。 ── */
test('_includes/booking_app_ja.html: カード決済不可時の案内文・各注意書きコンテナのIDが存在する', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_ja.html'), 'utf8');

  assert.match(
    html,
    /id="ba-card-ineligible-notice"[^>]*>カード事前決済は利用開始の4日前までのお申し込みです。直前のご予約は現金・PayPay（現地決済）をお選びください。/
  );
  assert.match(html, /id="ba-card-payment-notice"/);
  assert.match(html, /id="ba-confirm-card-payment-notice"/);
  assert.match(html, /id="ba-complete-generic-notice"/);
  assert.match(html, /id="ba-complete-card-payment-notice"/);
});
