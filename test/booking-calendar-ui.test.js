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
  /* timeBandは既定「指定なし（all）」がchecked（Issue #324本文レビュー追記3）。
     DOM上でも常にどれか1つがcheckedのラジオ群を模し、未選択という状態は作らない。 */
  var selectedTimeBand = opts.initialTimeBand || 'all';
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
  var timeBandRadio = createElement('timeBand-radio');
  root.querySelectorAll = function (selector) {
    if (selector === 'input[name="customerType"]') return [customerTypeRadio];
    if (selector === 'input[name="timeBand"]') return [timeBandRadio];
    return [];
  };
  root.querySelector = function (selector) {
    if (selector === 'input[name="customerType"]:checked') {
      return selectedCustomerType ? { value: selectedCustomerType } : null;
    }
    if (selector === 'input[name="timeBand"]:checked') {
      return { value: selectedTimeBand };
    }
    return null;
  };
  elements['booking-app'] = root;

  var startTimeGrid = createElement('ba-start-time-grid');
  elements['ba-start-time-grid'] = startTimeGrid;
  /* 実際のHTMLではStep1は初期表示（hiddenなし）。日付クリックで隠れないことを検証する。 */
  var step1 = createElement('ba-step-datetime');
  step1.hidden = false;
  elements['ba-step-datetime'] = step1;

  /* opts.initialDurationHours: 予約フォーム初期表示改善のテスト用。実際のHTMLは
     #ba-durationにvalue="2"を入れて配信するため、documentStub.getElementByIdが
     script読み込み時（handleCalendarPrereqChange_の初期呼び出しより前）に返す
     #ba-duration要素へ、あらかじめその値を持たせておく（createElement直後は
     value: ''のため、指定が無ければ従来どおり未入力を再現する）。 */
  if (opts.initialDurationHours) {
    var durationEl = createElement('ba-duration');
    durationEl.value = String(opts.initialDurationHours);
    elements['ba-duration'] = durationEl;
  }

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

  /* opts.deferMonthly: trueの場合、action=monthlyのfetchは即resolveせず、
     resolvePendingMonthly()で明示的に応答するまで保留する（月をまたいだ
     競合・応答順の入れ替えを再現するテスト用）。 */
  var pendingMonthly = [];
  var pendingAvailability = [];
  var holdMonthly = false; /* holdMonthly()呼び出し以降のmonthlyを保留する */

  function fetchStub(url, fetchOptions) {
    fetchCalls.push({ url: url, options: fetchOptions });
    if (url.indexOf('action=monthly') !== -1) {
      var params = {};
      url.split('?')[1].split('&').forEach(function (pair) {
        var parts = pair.split('=');
        params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || '');
      });
      if (opts.deferMonthly || holdMonthly) {
        return new Promise(function (resolve) {
          pendingMonthly.push({
            year: parseInt(params.year, 10),
            month: parseInt(params.month, 10),
            durationMinutes: params.durationMinutes,
            resolve: resolve
          });
        });
      }
      var body = monthlyResponder(parseInt(params.year, 10), parseInt(params.month, 10), params);
      return Promise.resolve({ json: function () { return Promise.resolve(body); } });
    }
    if (fetchOptions && fetchOptions.method === 'POST') {
      return Promise.resolve({ json: function () { return Promise.resolve({ success: true, bookingId: 'X', requestId: 'r' }); } });
    }
    /* 単日の開始時刻取得（getAvailability）。opts.deferAvailabilityなら保留し、
       resolveAvailability()/rejectAvailability()で明示的に応答する（応答順の入れ替え再現用）。 */
    if (opts.deferAvailability && url.indexOf('action=') === -1) {
      var dateParam = /[?&]date=([^&]+)/.exec(url)[1];
      return new Promise(function (resolve, reject) {
        pendingAvailability.push({ date: decodeURIComponent(dateParam), resolve: resolve, reject: reject });
      });
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
    setTimeBand: function (v) { selectedTimeBand = v; },
    triggerTimeBandChange: function () { timeBandRadio._listeners.change(); },
    setDuration: function (hours) {
      elements['ba-duration'] = elements['ba-duration'] || createElement('ba-duration');
      elements['ba-duration'].value = String(hours);
      elements['ba-duration']._listeners.input();
    },
    resolveAvailability: function (date, body) {
      var i = pendingAvailability.findIndex(function (p) { return p.date === date; });
      if (i === -1) throw new Error('保留中のavailabilityが見つかりません: ' + date);
      var pending = pendingAvailability.splice(i, 1)[0];
      pending.resolve({ json: function () { return Promise.resolve(body); } });
    },
    rejectAvailability: function (date) {
      var i = pendingAvailability.findIndex(function (p) { return p.date === date; });
      if (i === -1) throw new Error('保留中のavailabilityが見つかりません: ' + date);
      pendingAvailability.splice(i, 1)[0].reject(new Error('network'));
    },
    holdMonthly: function () { holdMonthly = true; },
    pendingMonthlyCount: function () { return pendingMonthly.length; },
    resolvePendingMonthly: function (year, month, durationMinutes, body) {
      var index = pendingMonthly.findIndex(function (p) {
        return p.year === year && p.month === month && p.durationMinutes === String(durationMinutes);
      });
      if (index === -1) {
        throw new Error('保留中のmonthlyリクエストが見つかりません: ' + year + '-' + month + '-' + durationMinutes);
      }
      var pending = pendingMonthly[index];
      pendingMonthly.splice(index, 1);
      pending.resolve({ json: function () { return Promise.resolve(body); } });
    }
  };
}

/* 単日の開始時刻取得（getAvailability）だけを数える（monthly/estimatePriceは除く）。 */
function availabilityCalls(ctx) {
  return ctx.fetchCalls.filter(function (c) { return c.url.indexOf('action=') === -1 && !(c.options && c.options.method === 'POST'); });
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

/* グリッド内のボタン（日付セル）を平坦化して返す。 */
function dayButtons(ctx) {
  var out = [];
  ctx.elements['ba-calendar-grid-body'].children.forEach(function (tr) {
    tr.children.forEach(function (td) {
      td.children.forEach(function (b) { out.push(b); });
    });
  });
  return out;
}

function assertAllPending(ctx, message) {
  var buttons = dayButtons(ctx);
  assert.ok(buttons.length >= 28, message + '（日付グリッドが残っている）');
  buttons.forEach(function (b) {
    assert.strictEqual(b.disabled, true, message + '（クリック不可）');
    assert.ok(/^\d+$/.test(b.textContent), message + '（◎○△×を表示しない）: ' + b.textContent);
  });
}

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
  assertAllPending(ctx, '取得失敗時も日付グリッドは残し、どの日も選択できない状態にする');
});

test('取得中は日付グリッドを即時表示し（クリック不可・記号なし）、取得完了後に記号と選択可否だけを反映する', async function () {
  var ctx = setup({ deferMonthly: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();

  assert.strictEqual(ctx.elements['ba-calendar-body'].hidden, false);
  assert.strictEqual(ctx.elements['ba-calendar-loading'].hidden, false);
  assertAllPending(ctx, '取得中');

  var monthA = ctx.Logic.yearMonthFromDateValue(ctx.Logic.todayInJapan());
  ctx.resolvePendingMonthly(monthA.year, monthA.month, 120, {
    success: true,
    month: monthA.year + '-' + pad2(monthA.month),
    days: buildDaysForMonth(monthA.year, monthA.month, 'AVAILABLE_HIGH')
  });
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-calendar-loading'].hidden, true);
  var buttons = dayButtons(ctx);
  assert.ok(buttons.some(function (b) { return b.textContent.indexOf('◎') !== -1; }), '取得後は◎が反映される');
  assert.ok(buttons.some(function (b) { return !b.disabled; }), '取得後は選択可能な日がある');
});

test('月送り中も日付グリッドを維持する（空白にしない）', async function () {
  var ctx = setup({ deferMonthly: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  ctx.elements['ba-calendar-next']._listeners.click();
  assertAllPending(ctx, '翌月取得中');
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

test('日付を1回クリックするだけで、Step1「次へ」を押さずに同じ画面のカレンダー直下で開始時刻取得へ進む', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();

  /* クリック直後（応答待ち）: カレンダー（Step1）は残り、その直下に検索中を表示している */
  assert.strictEqual(ctx.elements['ba-date'].value, today);
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, false, 'Step1（カレンダー）は隠れない');
  assert.strictEqual(ctx.elements['ba-calendar-body'].hidden, false, 'カレンダー本体も表示されたまま');
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, false, 'カレンダー直下の開始時刻エリアを表示');
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, false, '応答前に即ローディング表示');
  assert.strictEqual(ctx.elements['ba-start-time-loading'].textContent, '予約できる時間を検索しています…');
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, true, '応答まで次へはdisabled');
  assert.strictEqual(availabilityCalls(ctx).length, 1, '開始時刻取得のfetchが1回だけ発火');
  assert.ok(availabilityCalls(ctx)[0].url.indexOf('date=' + today) !== -1);
  assert.ok(availabilityCalls(ctx)[0].url.indexOf('durationMinutes=120') !== -1);

  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, true);
  assert.strictEqual(ctx.elements['ba-start-time-grid'].hidden, false, '開始時刻一覧を表示');
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, false, '一覧表示後もカレンダーは残る');
  assert.strictEqual(findDayButton(ctx.elements['ba-calendar-grid-body'], today).getAttribute('aria-pressed'), 'true', '選択日は維持');
  assert.strictEqual(ctx.elements['ba-date-error'].hidden, true);
});

test('同じ日付ボタンを連打してもStep2の開始時刻fetchは二重発火しない', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var button = findDayButton(ctx.elements['ba-calendar-grid-body'], ctx.Logic.todayInJapan());
  button._listeners.click();
  button._listeners.click();
  button._listeners.click();
  assert.strictEqual(availabilityCalls(ctx).length, 1);
});

test('通信が遅くても日付クリック直後にローディングが出て、別の日付を直接クリックすると新しい日付で再取得される（古い応答は捨てる）', async function () {
  var ctx = setup({ deferAvailability: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var other = null;
  ctx.elements['ba-calendar-grid-body'].children.forEach(function (tr) {
    tr.children.forEach(function (td) {
      var b = td.children[0];
      if (b && !b.disabled && b.getAttribute('data-date') !== today && !other) other = b.getAttribute('data-date');
    });
  });
  assert.ok(other, '当日以外にも選択可能な日がある');

  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, false);

  /* 応答前に、カレンダー上で別の日付をそのままクリックする（戻る操作は不要） */
  findDayButton(ctx.elements['ba-calendar-grid-body'], other)._listeners.click();
  assert.strictEqual(availabilityCalls(ctx).length, 2, '別の日付なら再取得する');
  assert.ok(availabilityCalls(ctx)[1].url.indexOf('date=' + other) !== -1);
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, false);
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, false);
  assert.strictEqual(ctx.elements['ba-date'].value, other);

  /* 古い日付（today）の応答が後から届いても表示しない */
  ctx.resolveAvailability(today, { success: true, bookableStartTimes: ['09:00', '09:30'] });
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, false, '古い応答ではローディングを消さない');
  assert.strictEqual(ctx.elements['ba-start-time-grid'].hidden, true);
  assert.strictEqual(ctx.elements['ba-start-time-grid'].children.length, 0, '古い応答の時刻は描画されない');

  /* 新しい日付の応答だけが表示される */
  ctx.resolveAvailability(other, { success: true, bookableStartTimes: ['13:00'] });
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, true);
  assert.strictEqual(ctx.elements['ba-start-time-grid'].hidden, false);
  assert.deepStrictEqual(ctx.elements['ba-start-time-grid'].children.map(function (c) { return c.textContent; }), ['13:00']);
  assert.strictEqual(findDayButton(ctx.elements['ba-calendar-grid-body'], other).getAttribute('aria-pressed'), 'true');
});

test('別の日付をクリックすると、現在の時刻一覧を即クリアして検索中を表示する', async function () {
  var ctx = setup({ deferAvailability: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  var today = ctx.Logic.todayInJapan();
  var other = null;
  ctx.elements['ba-calendar-grid-body'].children.forEach(function (tr) {
    tr.children.forEach(function (td) {
      var b = td.children[0];
      if (b && !b.disabled && b.getAttribute('data-date') !== today && !other) other = b.getAttribute('data-date');
    });
  });
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  ctx.resolveAvailability(today, { success: true, bookableStartTimes: ['10:00', '11:00'] });
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-grid'].children.length, 2);

  findDayButton(ctx.elements['ba-calendar-grid-body'], other)._listeners.click();
  assert.strictEqual(ctx.elements['ba-start-time-grid'].children.length, 0, '旧日付の一覧は即クリア');
  assert.strictEqual(ctx.elements['ba-start-time-grid'].hidden, true);
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, false);
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, true);
});

test('空きなしでもカレンダーは残り、時刻一覧エリアに案内が出る', async function () {
  var ctx = setup({ deferAvailability: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  var today = ctx.Logic.todayInJapan();
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  ctx.resolveAvailability(today, { success: true, bookableStartTimes: [] });
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-empty'].hidden, false);
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, true);
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, false, 'カレンダーは残る');
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, false);
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, true);
});

test('API失敗（通信エラー・エラー応答）でもカレンダーは残り、検索エリア内に再試行導線が出る', async function () {
  var ctx = setup({ deferAvailability: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  var today = ctx.Logic.todayInJapan();
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  ctx.rejectAvailability(today);
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, false, 'カレンダーは残る');
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, true);
  assert.strictEqual(ctx.elements['ba-start-time-error'].hidden, false, '検索エリア内にエラー表示');
  assert.strictEqual(ctx.elements['ba-global-error'].hidden, true, '画面全体のエラーへ切り替えない');
  var retry = ctx.elements['ba-start-time-error-actions'].children[0];
  assert.ok(retry, '再試行ボタンがある');

  /* 再試行: 検索中に戻り、再度fetchする */
  retry._listeners.click();
  assert.strictEqual(availabilityCalls(ctx).length, 2);
  assert.strictEqual(ctx.elements['ba-start-time-error'].hidden, true);
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, false);
  ctx.resolveAvailability(today, { success: false, error: { code: 'INTERNAL_ERROR' } });
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-error'].hidden, false);
  assert.strictEqual(ctx.elements['ba-global-error'].hidden, true);
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, false);
  assert.strictEqual(ctx.elements['ba-start-time-error-actions'].children.length, 1);
});

test('時刻を選択すると次へ進めて、利用者情報（Step3）へ遷移する。カレンダーの日付選択と時刻は保持される', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  var today = ctx.Logic.todayInJapan();
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  await flushPromises();

  var slot = ctx.elements['ba-start-time-grid'].children[0];
  assert.strictEqual(slot.textContent, '10:00');
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, true, '時刻選択前はdisabled');
  slot._listeners.click();
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, false);
  ctx.elements['ba-step-start-time-next']._listeners.click();
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, true, 'Step3へ進むとStep1は隠れる');
  assert.strictEqual(ctx.elements['ba-step-details'].hidden, false, '利用者情報入力へ進む');

  /* 利用者情報から戻ると、カレンダー+開始時刻エリアがそのまま見える */
  ctx.elements['ba-step-details-back']._listeners.click();
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, false);
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, false);
  assert.strictEqual(ctx.elements['ba-date'].value, today);
});

test('日付選択後に利用時間を変更すると、旧条件の開始時刻一覧は消え、進行中の応答も破棄される', async function () {
  var ctx = setup({ deferAvailability: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  var today = ctx.Logic.todayInJapan();
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  ctx.setDuration('3');
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true);
  ctx.resolveAvailability(today, { success: true, bookableStartTimes: ['10:00'] });
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-grid'].children.length, 0, '旧条件の応答は描画しない');
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true);
});

test('EN: 日付クリック直後に英語の検索中文言が出て、カレンダーは残る', async function () {
  var ctx = setup({ locale: 'en' });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  var today = ctx.Logic.todayInJapan();
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  assert.strictEqual(ctx.elements['ba-start-time-loading'].textContent, 'Searching available start times…');
  assert.strictEqual(ctx.elements['ba-start-time-loading'].hidden, false);
  assert.strictEqual(ctx.elements['ba-step-datetime'].hidden, false);
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-grid'].hidden, false);
});

test('戻る→利用時間を変更→日付選択で、新しい利用時間・利用区分・希望時間帯の条件で取得される', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  await flushPromises();

  ctx.setDuration('4');
  ctx.setTimeBand('evening');
  ctx.triggerTimeBandChange();
  await flushPromises();
  var before = availabilityCalls(ctx).length;
  var target = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  if (target.disabled) {
    target = null;
    ctx.elements['ba-calendar-grid-body'].children.forEach(function (tr) {
      tr.children.forEach(function (td) { if (!target && td.children[0] && !td.children[0].disabled) target = td.children[0]; });
    });
  }
  target._listeners.click();
  assert.strictEqual(availabilityCalls(ctx).length, before + 1);
  assert.ok(availabilityCalls(ctx)[before].url.indexOf('durationMinutes=240') !== -1, '変更後の利用時間で取得');
});

test('確認中（pending）の日付ボタンはクリック不可で、Step2へ進まない', async function () {
  var ctx = setup({ deferMonthly: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  var buttons = [];
  ctx.elements['ba-calendar-grid-body'].children.forEach(function (tr) {
    tr.children.forEach(function (td) { if (td.children[0]) buttons.push(td.children[0]); });
  });
  assert.ok(buttons.length > 0);
  buttons.forEach(function (b) {
    assert.strictEqual(b.disabled, true);
    assert.strictEqual(b._listeners.click, undefined, 'pendingにはclickハンドラが付かない');
  });
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true);
  assert.strictEqual(availabilityCalls(ctx).length, 0);
});

test('初回利用+当日は従来どおりクリック不可でStep2へ進まない', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('first_time');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  var button = findDayButton(ctx.elements['ba-calendar-grid-body'], ctx.Logic.todayInJapan());
  assert.strictEqual(button.disabled, true);
  assert.strictEqual(button._listeners.click, undefined);
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true);
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
  await flushPromises();
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
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true, 'Step2（開始時刻取得）へは進めない');
});

test('日付選択後に利用時間を変更すると、再取得中は「次へ」を無効化し、旧日付のままStep2へ進めない。成功後に有効と確認できれば再び進める', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var button = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  button._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-date'].value, today);
  assert.strictEqual(ctx.elements['ba-step-datetime-next'].disabled, false, '確認済みの間は進める');

  /* 再取得を保留にするため、以降のmonthlyは応答しない */
  ctx.holdMonthly();
  ctx.setDuration('3');
  assert.strictEqual(ctx.elements['ba-step-datetime-next'].disabled, true, '再取得中は「次へ」を無効化');
  assert.strictEqual(ctx.elements['ba-date'].value, today, '選択自体は保持される');

  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true, '確認中は旧日付のままStep2へ進めない');

  var month = ctx.Logic.yearMonthFromDateValue(today);
  ctx.resolvePendingMonthly(month.year, month.month, 180, {
    success: true,
    month: month.year + '-' + pad2(month.month),
    days: buildDaysForMonth(month.year, month.month, 'AVAILABLE')
  });
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-step-datetime-next'].disabled, false, '成功後は再び進める');
  assert.strictEqual(ctx.elements['ba-date'].value, today, '新条件でも有効な選択日は保持される');
});

test('日付選択後の再取得が失敗した場合も、旧日付のまま「次へ」で進めない', async function () {
  var fail = false;
  var ctx = setup({
    monthlyResponder: function (year, month) {
      if (fail) return { success: false, error: { code: 'INTERNAL_ERROR' } };
      return { success: true, month: year + '-' + pad2(month), days: buildDaysForMonth(year, month, 'AVAILABLE') };
    }
  });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  var today = ctx.Logic.todayInJapan();
  findDayButton(ctx.elements['ba-calendar-grid-body'], today)._listeners.click();
  await flushPromises();

  fail = true;
  ctx.setDuration('3');
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-step-datetime-next'].disabled, true);
  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true);
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
  await flushPromises();
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
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true, 'Step2（開始時刻取得）へは進めない');
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

/* ── 2回目のPRレビュー対応: 月A→月B→月Aと素早く往復した場合、後から届いた
   月Bの応答で月Aのグリッドを上書きしてはいけない。以前はグローバルな連番トークンで
   「最後に発行したfetchの応答だけ」を採用していたため、月Aの古い応答（正しいデータ）が
   トークン不一致で捨てられる一方、月Bの応答がトークン一致のまま月Aのグリッドへ
   誤って描画されてしまっていた。応答は「今表示すべき月・duration」と一致する場合
   だけ描画するよう修正した。 ── */
test('月A→月B→月Aと素早く往復し、応答順が入れ替わっても、現在表示中の月に別月のデータを描画せず、最終的に月Aの正しいデータが表示される', async function () {
  var ctx = setup({ deferMonthly: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();

  var today = ctx.Logic.todayInJapan();
  var monthA = ctx.Logic.yearMonthFromDateValue(today);
  var monthB = ctx.Logic.shiftMonth(monthA.year, monthA.month, 1);

  /* 月A（当月）のfetchが未解決のまま翌月（月B）へ移動 → 月Bのfetchも開始される */
  ctx.elements['ba-calendar-next']._listeners.click();
  /* 月Bのfetchも未解決のまま、直ちに前月（月A）へ戻る */
  ctx.elements['ba-calendar-prev']._listeners.click();

  assert.strictEqual(ctx.fetchCalls.length, 2, '月A・月Bでそれぞれ1回ずつfetchが開始されている（月Aへ戻った時点では新規fetchしない）');
  assert.strictEqual(ctx.pendingMonthlyCount(), 2);
  assert.strictEqual(
    ctx.elements['ba-calendar-month-label'].textContent,
    ctx.Logic.monthLabel(monthA.year, monthA.month, null),
    '表示は月Aへ戻っているべき'
  );

  /* 応答順を入れ替える: 先に月B（表示していない方）の応答を返す */
  ctx.resolvePendingMonthly(monthB.year, monthB.month, 120, {
    success: true,
    month: monthB.year + '-' + pad2(monthB.month),
    days: buildDaysForMonth(monthB.year, monthB.month, 'AVAILABLE_HIGH')
  });
  await flushPromises();

  assertAllPending(ctx, '現在表示中は月Aのため、先に届いた月Bの応答で記号を描画してはいけない');

  /* 続いて月A（現在表示中）の応答を返す */
  ctx.resolvePendingMonthly(monthA.year, monthA.month, 120, {
    success: true,
    month: monthA.year + '-' + pad2(monthA.month),
    days: buildDaysForMonth(monthA.year, monthA.month, 'AVAILABLE_HIGH')
  });
  await flushPromises();

  var todayButton = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.ok(todayButton, '最終的に月Aの正しいデータが描画され、当日のセルが見つかるべき');
  assert.strictEqual(todayButton.disabled, false);
  assert.strictEqual(
    ctx.elements['ba-calendar-month-label'].textContent,
    ctx.Logic.monthLabel(monthA.year, monthA.month, null)
  );
});

/* ── 3回目のPRレビュー対応（軽微なUI不整合）: 取得済みの月Aから未取得の月Bへ移動すると
   ローディング表示になる。月Bの取得完了前に月Aへ戻った場合、月Aはキャッシュから
   即描画されるが、月Bのために出したローディング表示を消し忘れると、カレンダーは
   表示されているのに「読み込み中…」が残ったままになってしまう。 ── */
/* ── 希望時間帯フィルタ（Issue #324） ── */

test('duration・利用区分確定時、既定の希望時間帯(all)がURLに含まれる（後方互換のデフォルト値）', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  assert.strictEqual(ctx.fetchCalls.length, 1);
  assert.ok(ctx.fetchCalls[0].url.indexOf('timeBand=all') !== -1, '既定は指定なし(all)を送るべき');
});

test('希望時間帯を変更すると、表示中の月だけを新しいtimeBandで再取得する', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 1);

  ctx.setTimeBand('morning');
  ctx.triggerTimeBandChange();
  await flushPromises();

  assert.strictEqual(ctx.fetchCalls.length, 2, 'timeBand変更時は表示中の月を再取得する');
  assert.ok(ctx.fetchCalls[1].url.indexOf('timeBand=morning') !== -1);
  assert.ok(ctx.fetchCalls[1].url.indexOf('durationMinutes=120') !== -1, 'durationMinutesは変更前のまま送られるべき');

  var today = ctx.Logic.todayInJapan();
  var ym = ctx.Logic.yearMonthFromDateValue(today);
  assert.ok(ctx.fetchCalls[1].url.indexOf('year=' + ym.year) !== -1, '取得し直すのは表示中の月のみであるべき');
  assert.ok(ctx.fetchCalls[1].url.indexOf('month=' + ym.month) !== -1);
});

test('cache keyはtimeBand別になる。allへ戻ると再取得せずキャッシュを使う', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 1, 'all（既定）は1回取得済み');

  ctx.setTimeBand('evening');
  ctx.triggerTimeBandChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 2, 'eveningは未取得のため新たに1回取得する');

  ctx.setTimeBand('all');
  ctx.triggerTimeBandChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 2, '取得済みのall（duration=120と同じキー）へ戻る場合は再取得しない');

  ctx.setTimeBand('evening');
  ctx.triggerTimeBandChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 2, '取得済みのeveningへ戻る場合も再取得しない');
});

test('timeBand変更後、選択済み日付が新条件でFULLになれば選択が解除されStep1を通過できない', async function () {
  var ctx = setup({
    monthlyResponder: function (year, month, params) {
      var status = params.timeBand === 'evening' ? 'FULL' : 'AVAILABLE';
      return { success: true, month: year + '-' + pad2(month), days: buildDaysForMonth(year, month, status) };
    }
  });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var button = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.strictEqual(button.disabled, false, 'allではAVAILABLEで選択可能');
  button._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-date'].value, today);

  ctx.setTimeBand('evening');
  ctx.triggerTimeBandChange();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-date'].value, '', '新条件（evening）でFULLになった選択日はクリアされるべき');
  assert.strictEqual(ctx.elements['ba-calendar-selected'].textContent, '');

  var todayButtonAfter = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.strictEqual(todayButtonAfter.disabled, true, 'eveningではFULLのため選択不可になっているべき');

  ctx.elements['ba-step-datetime-next']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.elements['ba-date-error'].hidden, false, '日付未選択としてStep1のエラーが出るべき');
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true, 'Step2（開始時刻取得）へは進めない');
});

test('duration・利用区分未確定の間はtimeBandを変更してもgetMonthlyAvailabilityを呼ばない（isCalendarReady_の判定条件は変更しない）', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setTimeBand('morning');
  ctx.triggerTimeBandChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 0, '利用区分が未確定の間はtimeBand変更でもfetchしない');
  assert.strictEqual(ctx.elements['ba-calendar-body'].hidden, true);
});

test('再読み込みボタンは現在のtimeBandのキャッシュを削除してから再取得する', async function () {
  var ctx = setup({});
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  ctx.setTimeBand('daytime');
  ctx.triggerTimeBandChange();
  await flushPromises();
  assert.strictEqual(ctx.fetchCalls.length, 2);

  ctx.elements['ba-calendar-retry']._listeners.click();
  await flushPromises();

  assert.strictEqual(ctx.fetchCalls.length, 3, '再読み込みは現在のtimeBand(daytime)キーを再取得するべき');
  assert.ok(ctx.fetchCalls[2].url.indexOf('timeBand=daytime') !== -1);
});

test('取得済みの月へキャッシュヒットで戻った場合、別の月のために出していたローディング表示が残らない', async function () {
  var ctx = setup({ deferMonthly: true });
  ctx.setDuration('2');
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();

  var today = ctx.Logic.todayInJapan();
  var monthA = ctx.Logic.yearMonthFromDateValue(today);
  var monthB = ctx.Logic.shiftMonth(monthA.year, monthA.month, 1);

  /* 月A（当月）を取得済みにしておく */
  ctx.resolvePendingMonthly(monthA.year, monthA.month, 120, {
    success: true,
    month: monthA.year + '-' + pad2(monthA.month),
    days: buildDaysForMonth(monthA.year, monthA.month, 'AVAILABLE_HIGH')
  });
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-calendar-loading'].hidden, true, '月Aの取得完了後はローディングが消えているべき');

  /* 未取得の月Bへ移動 → ローディング表示になる（月Bの応答はまだ返さない） */
  ctx.elements['ba-calendar-next']._listeners.click();
  assert.strictEqual(ctx.elements['ba-calendar-loading'].hidden, false, '未取得の月Bへ移動した直後はローディング表示になるべき');

  /* 月Bの取得完了前に、取得済みの月Aへ戻る（キャッシュヒット） */
  ctx.elements['ba-calendar-prev']._listeners.click();

  assert.strictEqual(
    ctx.elements['ba-calendar-loading'].hidden,
    true,
    'キャッシュヒットで即描画される月Aでは、月Bのために出していたローディング表示が残ってはいけない'
  );
  var todayButton = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.ok(todayButton, '月Aのグリッドがキャッシュから描画されているべき');
});

/* ── 予約フォーム初期表示改善: 実際のHTML（_includes/booking_app_ja.html /
   booking_app_en.html）は#ba-durationにvalue="2"、customerType="first_time"に
   checked、timeBand="all"にcheckedを持たせて配信する。ユーザー操作なしで
   ページ読み込み直後にその初期値のまま当月のgetMonthlyAvailabilityが自動で
   呼ばれ、カレンダーが表示されることを検証する（GAS側・月間API・timeBand仕様は
   変更していないため、setup()のopts.initialDurationHours/initialCustomerType/
   initialTimeBandでHTML側の初期値を再現するだけでよい）。 ── */

test('初期表示: ユーザー操作なしで、HTML初期値（2時間・初回利用・指定なし）のまま当月のカレンダーが自動取得・表示される', async function () {
  var ctx = setup({ initialDurationHours: '2', initialCustomerType: 'first_time', initialTimeBand: 'all' });

  /* setDuration/triggerCustomerTypeChangeなど、ユーザー操作を模す呼び出しは一切行わない。
     handleCalendarPrereqChange_の初期呼び出しだけでfetchが起きることを確認する。 */
  assert.strictEqual(ctx.fetchCalls.length, 1, 'ページ読み込み直後、ユーザー操作なしで当月のgetMonthlyAvailabilityが1回呼ばれるべき');
  var url = ctx.fetchCalls[0].url;
  assert.ok(url.indexOf('action=monthly') !== -1);
  assert.ok(url.indexOf('durationMinutes=120') !== -1, '初期値の2時間（120分）で取得するべき');
  assert.ok(url.indexOf('timeBand=all') !== -1, '初期値の指定なし（all）で取得するべき');

  var today = ctx.Logic.todayInJapan();
  var ym = ctx.Logic.yearMonthFromDateValue(today);
  assert.ok(url.indexOf('year=' + ym.year) !== -1);
  assert.ok(url.indexOf('month=' + ym.month) !== -1, '初期表示は現在月であるべき');

  await flushPromises();
  assert.strictEqual(ctx.elements['ba-calendar-body'].hidden, false, '初期表示のままカレンダー本体が表示されているべき');
  assert.strictEqual(ctx.elements['ba-calendar-hint'].hidden, true);
  assert.ok(ctx.elements['ba-calendar-grid-body'].children.length > 0, '当月のグリッドが描画されているべき');
});

test('初期表示: 初回利用＋当日の既存ガードは、ユーザー操作なしの初期表示時にも維持される', async function () {
  var ctx = setup({ initialDurationHours: '2', initialCustomerType: 'first_time', initialTimeBand: 'all' });
  await flushPromises();

  var today = ctx.Logic.todayInJapan();
  var todayButton = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.ok(todayButton, '当日のセルが初期表示の時点で描画されているべき');
  assert.strictEqual(todayButton.disabled, true, '初期値が初回利用のため、当日は初期表示時点から選択不可であるべき');
});

test('初期表示後に利用時間を変更すると、既存仕様どおり表示中の月を新しいdurationで再取得する', async function () {
  var ctx = setup({ initialDurationHours: '2', initialCustomerType: 'first_time', initialTimeBand: 'all' });
  assert.strictEqual(ctx.fetchCalls.length, 1, '初期表示で1回取得済み');

  ctx.setDuration('3');
  await flushPromises();

  assert.strictEqual(ctx.fetchCalls.length, 2, 'duration変更時は表示中の月を再取得する（既存仕様）');
  assert.ok(ctx.fetchCalls[1].url.indexOf('durationMinutes=180') !== -1);
});

test('初期表示後に利用区分を変更すると、既存仕様どおり再取得なしで選択可否だけが切り替わる', async function () {
  var ctx = setup({ initialDurationHours: '2', initialCustomerType: 'first_time', initialTimeBand: 'all' });
  assert.strictEqual(ctx.fetchCalls.length, 1, '初期表示で1回取得済み');
  await flushPromises();

  /* 利用区分はcalendarCacheKey_に含まれないため、切り替えだけでは再取得しない
     （既存仕様。「初回利用＋当日は…」テストで検証済みの挙動を初期表示後に確認する）。 */
  ctx.setCustomerType('returning');
  ctx.triggerCustomerTypeChange();
  await flushPromises();

  assert.strictEqual(ctx.fetchCalls.length, 1, '利用区分の切り替えだけでは再取得しない（既存仕様）');

  var today = ctx.Logic.todayInJapan();
  var todayButton = findDayButton(ctx.elements['ba-calendar-grid-body'], today);
  assert.strictEqual(todayButton.disabled, false, '利用経験ありへ変更後は当日も選択可能になるべき');
});

test('初期表示後に希望時間帯を変更すると、既存仕様どおり表示中の月を再取得する', async function () {
  var ctx = setup({ initialDurationHours: '2', initialCustomerType: 'first_time', initialTimeBand: 'all' });
  assert.strictEqual(ctx.fetchCalls.length, 1, '初期表示で1回取得済み（timeBand=all）');

  ctx.setTimeBand('evening');
  ctx.triggerTimeBandChange();
  await flushPromises();

  assert.strictEqual(ctx.fetchCalls.length, 2, '希望時間帯変更時は表示中の月を再取得する（既存仕様）');
  assert.ok(ctx.fetchCalls[1].url.indexOf('timeBand=evening') !== -1);
  assert.ok(ctx.fetchCalls[1].url.indexOf('durationMinutes=120') !== -1, 'durationMinutesは初期値のまま送られるべき');
});

test('初期表示: HTML側に初期値が無い場合（フォールバック）は従来どおり自動取得しない', async function () {
  var ctx = setup({});
  assert.strictEqual(ctx.fetchCalls.length, 0, '初期値が入っていない場合はページ読み込みだけではfetchしない（回帰なし）');
  assert.strictEqual(ctx.elements['ba-calendar-body'].hidden, true);
});
