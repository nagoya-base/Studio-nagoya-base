/*
 * scripts/booking-app.js の月間空き状況カレンダー配線（Issue #318）のテスト。
 * scripts/booking-logic.js（実ファイル）と組み合わせてvmで実行し、
 * getMonthlyAvailability（action=monthly）へのfetch配線・グリッド描画・
 * 選択可否・fail-open禁止・既存の開始時刻選択フローへの接続を検証する。
 *
 * 日ごとの空き判定ロジック自体（GAS側）はtest/booking-monthly-availability.test.jsで、
 * 記号・aria-label・選択可否の純粋ロジックはtest/booking-logic.test.jsで別途検証済みのため、
 * ここではDOM配線（何回fetchするか・グリッドに何が描画されるか）だけを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function buildDaysForMonth(year, month, status) {
  var days = {};
  var totalDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (var d = 1; d <= totalDays; d++) {
    var dateValue = year + '-' + pad2(month) + '-' + pad2(d);
    days[dateValue] = { status: status, availableStartTimes: status === 'FULL' ? 0 : 10 };
  }
  return days;
}

/* innerHTML='' でchildrenをクリアできる、appendChildが実際に子要素を積む
   最小限のDOM要素スタブ（test/booking-app.test.jsのcreateElementを、
   tr/td/buttonのネスト構造を検証できるよう拡張したもの）。 */
function createElement(id) {
  var listeners = {};
  var attrs = {};
  var el = {
    id: id,
    hidden: true,
    disabled: false,
    checked: false,
    value: '',
    textContent: '',
    className: '',
    children: [],
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function (name, listener) { listeners[name] = listener; },
    appendChild: function (child) { el.children.push(child); },
    focus: function () {},
    getAttribute: function (name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    setAttribute: function (name, value) { attrs[name] = value; },
    removeAttribute: function (name) { delete attrs[name]; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    scrollIntoView: function () {},
    _listeners: listeners,
    _attrs: attrs
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el._innerHTML || ''; },
    set: function (value) { el._innerHTML = value; el.children = []; }
  });
  return el;
}

function setup(options) {
  var opts = options || {};
  var elements = {};
  var selectedCustomerType = opts.initialCustomerType || null;
  var fetchCalls = [];

  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return 'snb';
    if (name === 'data-back-url') return '/';
    if (name === 'data-back-label') return null;
    if (name === 'data-locale') return opts.locale || null;
    return null;
  };
  var customerTypeRadio = createElement('customerType-radio');
  root.querySelectorAll = function (selector) {
    if (selector === 'input[name="customerType"]') return [customerTypeRadio];
    return [];
  };
  root.querySelector = function (selector) {
    if (selector === 'input[name="customerType"]:checked') {
      return selectedCustomerType ? { value: selectedCustomerType } : null;
    }
    return null;
  };
  elements['booking-app'] = root;

  var startTimeGrid = createElement('ba-start-time-grid');
  elements['ba-start-time-grid'] = startTimeGrid;

  var documentStub = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement: createElement
  };

  var windowStub = { BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' } };

  var monthlyResponder = opts.monthlyResponder || function (year, month) {
    return { success: true, month: year + '-' + pad2(month), days: buildDaysForMonth(year, month, 'AVAILABLE') };
  };

  function fetchStub(url, fetchOptions) {
    fetchCalls.push({ url: url, options: fetchOptions });
    if (url.indexOf('action=monthly') !== -1) {
      var params = {};
      url.split('?')[1].split('&').forEach(function (pair) {
        var parts = pair.split('=');
        params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
      });
      var body = monthlyResponder(parseInt(params.year, 10), parseInt(params.month, 10), params);
      return Promise.resolve({ json: function () { return Promise.resolve(body); } });
    }
    if (fetchOptions && fetchOptions.method === 'POST') {
      return Promise.resolve({ json: function () { return Promise.resolve({ success: true, bookingId: 'X', requestId: 'r' }); } });
    }
    return Promise.resolve({ json: function () { return Promise.resolve({ success: true, bookableStartTimes: ['10:00'] }); } });
  }

  loadFrontendSandbox(['booking-logic.js', 'booking-app.js'], {
    document: documentStub,
    window: windowStub,
    fetch: fetchStub
  });

  return {
    elements: elements,
    Logic: windowStub.BookingLogic,
    fetchCalls: fetchCalls,
    setCustomerType: function (v) { selectedCustomerType = v; },
    triggerCustomerTypeChange: function () { customerTypeRadio._listeners.change(); },
    setDuration: function (hours) {
      elements['ba-duration'] = elements['ba-duration'] || createElement('ba-duration');
      elements['ba-duration'].value = String(hours);
      elements['ba-duration']._listeners.input();
    }
  };
}

function flushPromises() {
  return new Promise(function (resolve) { setImmediate(resolve); });
}

/* カレンダーグリッド（tbody相当）から、指定dateValueの<button>を探す。
   行(tr).children=[td,...]、各td.children[0]がbutton（空白セルはchildren=[]）。 */
function findDayButton(gridBody, dateValue) {
  for (var r = 0; r < gridBody.children.length; r++) {
    var row = gridBody.children[r];
    for (var c = 0; c < row.children.length; c++) {
      var td = row.children[c];
      var button = td.children[0];
      if (button && button.getAttribute('data-date') === dateValue) return button;
    }
  }
  return null;
}

test('duration・利用区分が未確定の間はカレンダーを表示せず、getMonthlyAvailabilityも呼ばない', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 0, '利用区分が未確定の間はfetchしない');
  assert.strictEqual(ctx.elements['ba-calendar-body'].hidden, true);
});

test('duration・利用区分が両方確定すると、当月のgetMonthlyAvailability(action=monthly)を1回だけ呼ぶ', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  assert.strictEqual(ctx.fetchCalls.length, 1, '月間空き状況の取得はHTTPリクエスト1回であるべき');
  var url = ctx.fetchCalls[0].url;
  assert.ok(url.indexOf('action=monthly') !== -1);
  assert.ok(url.indexOf('durationMinutes=120') !== -1);
  assert.ok(url.indexOf('brand=snb') !== -1);

  var today = ctx.Logic.todayInJapan();
  var ym = ctx.Logic.yearMonthFromDateValue(today);
  assert.ok(url.indexOf('year=' + ym.year) !== -1);
  assert.ok(url.indexOf('month=' + ym.month) !== -1, '初期表示月は当日の月であるべき');
  assert.strictEqual(ctx.elements['ba-calendar-body'].hidden, false);
});

test('取得した月のグリッドが描画され、空きのある日は選択して#ba-dateへ反映できる', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var ym = ctx.Logic.yearMonthFromDateValue(today);
  var gridBody = ctx.elements['ba-calendar-grid-body'];
  assert.ok(gridBody.children.length > 0, '週の行が描画されているべき');

  var button = findDayButton(gridBody, today);
  assert.ok(button, '当日のセルが描画されているべき');
  assert.strictEqual(button.disabled, false, 'AVAILABLEステータスかつ利用経験ありなら選択可能');

  button._listeners.click();
  assert.strictEqual(ctx.elements['ba-date'].value, today, 'クリックで#ba-dateへ選択日が反映される');
  void ym;
});

test('初回利用＋当日は、GAS側のstatusが予約可でもセルが選択不可になる（フロント側ガードの再現）', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('first_time');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var gridBody = ctx.elements['ba-calendar-grid-body'];
  var todayButton = findDayButton(gridBody, today);
  assert.ok(todayButton, '当日のセルが描画されているべき');
  assert.strictEqual(todayButton.disabled, true, '初回利用は当日を選択できない');
  assert.ok(
    todayButton.getAttribute('aria-label').indexOf('初回利用の方は当日のご予約を受け付けていません') !== -1,
    'aria-labelにも理由が示されるべき'
  );

  /* 利用経験ありへ切り替えると、再取得なしで同じ当日セルが選択可能になる */
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  var fetchCountAfterSwitch = ctx.fetchCalls.length;
  var todayButtonAfter = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.strictEqual(todayButtonAfter.disabled, false);
  assert.strictEqual(ctx.fetchCalls.length, fetchCountAfterSwitch, '選択可否の切り替えだけでは再取得しない');
});

test('月間空き状況の取得に失敗した場合、グリッドを描画せずエラー表示のみにする（fail-open禁止）', async function () {
  var ctx = setup({
    monthlyResponder: function () {
      return { success: false, error: { code: 'INTERNAL_ERROR' } };
    }
  });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-calendar-error'].hidden, false);
  assert.strictEqual(ctx.elements['ba-calendar-grid-body'].children.length, 0, '取得失敗時はどの日も描画・選択できない状態にする');
});

test('翌月・前月ボタンで表示中の月だけを取得し直す（年またぎも正しく計算される）', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var ym = ctx.Logic.yearMonthFromDateValue(today);
  var next = ctx.Logic.shiftMonth(ym.year, ym.month, 1);

  ctx.elements['ba-calendar-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.fetchCalls.length, 2);
  var nextUrl = ctx.fetchCalls[1].url;
  assert.ok(nextUrl.indexOf('year=' + next.year) !== -1);
  assert.ok(nextUrl.indexOf('month=' + next.month) !== -1);
  assert.strictEqual(
    ctx.elements['ba-calendar-month-label'].textContent,
    ctx.Logic.monthLabel(next.year, next.month, null)
  );

  /* 前月へ戻ると、durationが変わっていないため再取得せずキャッシュを使う */
  ctx.elements['ba-calendar-prev']._listeners.click();
  assert.strictEqual(ctx.fetchCalls.length, 2, '取得済みの月へ戻る場合はキャッシュを使い再取得しない');
});

test('利用時間を変更すると、表示中の月だけを新しいdurationで再取得する', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 1);

  ctx.setDuration('3');
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 2, 'duration変更時は表示中の月を再取得する');
  assert.ok(ctx.fetchCalls[1].url.indexOf('durationMinutes=180') !== -1);
});

test('カレンダーで選択した日付は、既存のStep1「次へ」→Step2の開始時刻取得フローへそのまま引き継がれる', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var button = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  button._listeners.click();

  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-date-error'].hidden, true, '日付が選択済みならエラーにならない');
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, true, 'Step1が終わりStep2へ進んでいる');
  assert.strictEqual(ctx.elements['ba-step-start-time'].hidden, false);
});

/* ── PRレビュー対応: duration/利用区分の変更で選択済み日付が新条件で選択不可になった
   場合、#ba-dateの選択を解除する（解除しないと、hiddenの#ba-dateに予約不可な日付が
   残ったままStep1「次へ」を通過できてしまい、「予約不可日は選択できない」という
   受入条件に反する）。 ── */

test('2時間で日付選択→duration変更→その日がFULLになった場合、選択が解除されStep1を通過できない', async function () {
  var ctx = setup({
    monthlyResponder: function (year, month, params) {
      var status = params.durationMinutes === '360' ? 'FULL' : 'AVAILABLE';
      return { success: true, month: year + '-' + pad2(month), days: buildDaysForMonth(year, month, status) };
    }
  });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var button = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.strictEqual(button.disabled, false, '2時間ならAVAILABLEで選択可能');
  button._listeners.click();
  assert.strictEqual(ctx.elements['ba-date'].value, today);

  /* 6時間へ変更すると、同じ日がFULLになる想定 */
  ctx.setDuration('6');
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-date'].value, '', '新条件でFULLになった選択日はクリアされるべき');
  assert.strictEqual(ctx.elements['ba-calendar-selected'].textContent, '', '選択サマリー表示もクリアされるべき');

  var todayButtonAfter = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.strictEqual(todayButtonAfter.disabled, true, '6時間ではFULLのため選択不可になっているべき');
  assert.strictEqual(todayButtonAfter.getAttribute('aria-pressed'), 'false');

  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-date-error'].hidden, false, '日付未選択としてStep1のエラーが出るべき');
  assert.strictEqual(ctx.elements['ba-step-start-time'].hidden, true, 'Step2（開始時刻取得）へは進めない');
});

test('利用経験ありで当日選択→初回利用へ変更→当日の選択状態が残らない', async function () {
  var ctx = setup({}); /* 既定のmonthlyResponderは常にAVAILABLE（当日はcustomerType側のガードのみで判定される） */
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var button = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  button._listeners.click();
  assert.strictEqual(ctx.elements['ba-date'].value, today);

  var fetchCountBeforeSwitch = ctx.fetchCalls.length;
  ctx.setCustomerType('first_time');
  ctx.triggerCustomerTypeChange();

  assert.strictEqual(ctx.fetchCalls.length, fetchCountBeforeSwitch, '選択可否の再判定だけでは再取得しない');
  assert.strictEqual(ctx.elements['ba-date'].value, '', '初回利用へ変更後、当日の選択状態は残らないべき');
  assert.strictEqual(ctx.elements['ba-calendar-selected'].textContent, '');

  var todayButtonAfter = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.strictEqual(todayButtonAfter.disabled, true, '初回利用+当日は選択不可');

  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-date-error'].hidden, false, '日付未選択としてStep1のエラーが出るべき');
  assert.strictEqual(ctx.elements['ba-step-start-time'].hidden, true, 'Step2（開始時刻取得）へは進めない');
});

test('duration変更時に短時間でinput/changeが連続発火しても、同じ月・同じdurationのfetchは1回だけ（in-flightキーで重複を抑止）', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 1);

  /* durationを変更したうえで、fetchの解決前にinput/changeが連続発火するケースを再現する
     （setDurationはinputイベントのみを発火するため、直後にchangeも手動で発火させる）。 */
  ctx.elements['ba-duration'].value = '4';
  ctx.elements['ba-duration']._listeners.input();
  ctx.elements['ba-duration']._listeners.change();

  assert.strictEqual(ctx.fetchCalls.length, 2, 'fetch解決前の連続発火では、同じキーへの2回目のfetchは起きないべき');

  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 2, 'fetch解決後も重複していないこと');
});
