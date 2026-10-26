/*
 * Issue #546: 会員限定の特典（2名ペアパック・シャワー）と31〜90日先の会員先行予約を、
 * 会員向けUIが有効でない間は選択できないようにするフロント（scripts/booking-app.js）の配線テスト。
 *
 * - 実際の scripts/booking-logic.js と booking-app.js を最小DOMスタブでvm実行する（Dateは2026-11-20 JST固定）。
 * - 31〜90日先の判定はAPIの memberAdvance の印だけを使う（日数はフロントで再計算しない）。ここでは
 *   30/31日・90/91日の境界を、APIと同じ形の月間応答で再現する。
 * - フロントの制御はUXのみ。実会員資格・先行予約資格の最終判定はサーバー（本テストの対象外）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

var FIXED_NOW_MS = Date.parse('2026-11-20T03:00:00Z'); /* 2026-11-20 12:00 JST */
var TODAY = '2026-11-20';

function pad2(n) { return (n < 10 ? '0' : '') + n; }
function dateAfter(days) {
  var d = new Date(Date.parse(TODAY + 'T00:00:00Z') + days * 86400000);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}
function monthsBetween(dateValue) {
  var t = TODAY.split('-'), d = dateValue.split('-');
  return (Number(d[0]) - Number(t[0])) * 12 + (Number(d[1]) - Number(t[1]));
}

/* APIと同じ規則の月間応答: 0〜30日先=通常、31〜90日先=会員先行枠（memberAdvance）、91日以降=範囲外。 */
function monthlyBody(year, month, generation) {
  var days = {};
  var total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (var d = 1; d <= total; d++) {
    var dateValue = year + '-' + pad2(month) + '-' + pad2(d);
    var ahead = Math.round((Date.parse(dateValue + 'T00:00:00Z') - Date.parse(TODAY + 'T00:00:00Z')) / 86400000);
    if (ahead < 0 || ahead > 90) days[dateValue] = { status: 'OUT_OF_RANGE' };
    else if (ahead > 30) days[dateValue] = { status: 'AVAILABLE', availableStartTimes: 8, memberAdvance: true };
    else days[dateValue] = { status: 'AVAILABLE', availableStartTimes: 8 };
  }
  return { success: true, month: year + '-' + pad2(month), days: days, priceGeneration: generation };
}

function createElement(id) {
  var listeners = {};
  var attrs = {};
  var el = {
    id: id, hidden: true, disabled: false, checked: false,
    value: id === 'ba-email' ? 'taro@example.com' : '',
    textContent: '', className: '', children: [],
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
    _listeners: listeners
  };
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return el._innerHTML || ''; },
    set: function (value) { el._innerHTML = value; el.children = []; }
  });
  return el;
}

function flushPromises() { return new Promise(function (resolve) { setImmediate(resolve); }); }

function findDayButton(gridBody, dateValue) {
  for (var r = 0; r < gridBody.children.length; r++) {
    var row = gridBody.children[r];
    for (var c = 0; c < row.children.length; c++) {
      var button = row.children[c].children[0];
      if (button && button.getAttribute('data-date') === dateValue) return button;
    }
  }
  return null;
}

/*
 * opts.brand: 'snb' | 'mens' | 'studio_x'
 * opts.generation: 'V1' | 'V2'（サーバーが返す料金世代。月間応答・見積り応答のpriceGenerationとして返す）
 */
function setup(opts) {
  opts = opts || {};
  var brand = opts.brand || 'snb';
  var generation = opts.generation || 'V1';
  var elements = {};
  var fetchCalls = [];
  var selectedMemberStatus = '';

  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof FakeDate)) return new Date(FIXED_NOW_MS).toString();
    return args.length === 0 ? new Date(FIXED_NOW_MS) : new (Function.prototype.bind.apply(Date, [null].concat(args)))();
  }
  FakeDate.now = function () { return FIXED_NOW_MS; };
  FakeDate.parse = Date.parse;
  FakeDate.UTC = Date.UTC;
  FakeDate.prototype = Date.prototype;

  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return brand;
    if (name === 'data-back-url') return '/';
    return null;
  };
  var memberRadio = createElement('memberStatus-radio');
  var checkedValue = false;
  Object.defineProperty(memberRadio, 'checked', {
    get: function () { return checkedValue; },
    set: function (v) { checkedValue = v; if (!v) selectedMemberStatus = ''; }
  });
  var customerTypeRadio = createElement('customerType-radio');
  var timeBandRadio = createElement('timeBand-radio');
  var progressItems = ['datetime', 'details', 'confirm', 'complete'].map(function (name) {
    var item = createElement('progress-' + name);
    item.setAttribute('data-step', name);
    return item;
  });
  root.querySelectorAll = function (selector) {
    if (selector === 'input[name="memberStatus"]') return (brand === 'snb' || brand === 'studio_x') ? [memberRadio] : [];
    if (selector === 'input[name="customerType"]') return [customerTypeRadio];
    if (selector === 'input[name="timeBand"]') return [timeBandRadio];
    if (selector === '#ba-progress li') return progressItems;
    return [];
  };
  root.querySelector = function (selector) {
    if (selector === 'input[name="customerType"]:checked') return { value: 'returning' };
    if (selector === 'input[name="timeBand"]:checked') return { value: 'all' };
    if (selector === 'input[name="memberStatus"]:checked') return selectedMemberStatus ? { value: selectedMemberStatus } : null;
    return null;
  };
  elements['booking-app'] = root;

  var durationEl = createElement('ba-duration');
  durationEl.value = String(opts.duration || 3);
  elements['ba-duration'] = durationEl;
  /* 会員限定の特典はSNB / mensのテンプレートだけにある。各checkboxは親（label）要素を持つ。 */
  if (brand === 'snb' || brand === 'mens') {
    ['ba-plan-pair', 'ba-shower'].forEach(function (id) {
      var control = createElement(id);
      control.parentNode = { hidden: true };
      elements[id] = control;
    });
    elements['ba-member-unlock'] = createElement('ba-member-unlock');
    elements['ba-member-unlock-field'] = createElement('ba-member-unlock-field');
  }

  var documentStub = {
    getElementById: function (id) {
      if (!elements[id]) elements[id] = createElement(id);
      return elements[id];
    },
    createElement: createElement
  };
  var windowStub = { BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' } };

  function fetchStub(url) {
    fetchCalls.push(url);
    var body;
    if (url.indexOf('action=monthly') !== -1) {
      var year = Number(/[?&]year=(\d+)/.exec(url)[1]);
      var month = Number(/[?&]month=(\d+)/.exec(url)[1]);
      body = monthlyBody(year, month, generation);
    } else if (url.indexOf('action=estimatePrice') !== -1) {
      var plan = /[?&]plan=([^&]+)/.exec(url);
      body = { success: true, priceGeneration: generation, price: { amount: plan ? 5000 : 6600, tier: 'GENERAL', brand: brand, plan: plan ? plan[1] : '' } };
    } else if (url.indexOf('action=optionCatalog') !== -1) {
      body = { success: true, catalog: { enabled: true, showerOnly: true, shower: { code: 'SHOWER', priceJpy: 1000 } } };
    } else {
      var minutes = Number((/[?&]durationMinutes=(\d+)/.exec(url) || [])[1]);
      body = { success: true, bookableStartTimes: opts.availability ? opts.availability(minutes) : ['10:00', '10:15'] };
    }
    return Promise.resolve({ json: function () { return Promise.resolve(body); } });
  }

  loadFrontendSandbox(['booking-logic.js', 'booking-app.js'], {
    document: documentStub, window: windowStub, fetch: fetchStub, Date: FakeDate
  });

  var ctx = {
    elements: elements,
    fetchCalls: fetchCalls,
    Logic: windowStub.BookingLogic,
    setMember: function (value) { selectedMemberStatus = value; checkedValue = !!value; memberRadio._listeners.change(); },
    setDuration: function (hours) { durationEl.value = String(hours); durationEl._listeners.input(); },
    startTimeButton: function (time) {
      return (elements['ba-start-time-grid'].children || []).filter(function (b) { return b.textContent === time; })[0] || null;
    },
    setUnlock: function (checked) { elements['ba-member-unlock'].checked = checked; elements['ba-member-unlock']._listeners.change(); },
    setBenefit: function (id, checked) { elements[id].checked = checked; elements[id]._listeners.change(); },
    gridBody: function () { return elements['ba-calendar-grid-body']; },
    /* 日付を含む月までカレンダーを送る（初期表示月は2026-11）。 */
    showMonthOf: async function (dateValue) {
      var steps = monthsBetween(dateValue) - monthsBetween(ctx.shownDate || TODAY);
      for (var i = 0; i < Math.abs(steps); i++) {
        elements[steps > 0 ? 'ba-calendar-next' : 'ba-calendar-prev']._listeners.click();
        await flushPromises();
      }
      ctx.shownDate = dateValue;
    },
    dayButton: async function (daysAhead) {
      var dateValue = dateAfter(daysAhead);
      await ctx.showMonthOf(dateValue);
      return findDayButton(ctx.gridBody(), dateValue);
    },
    pick: async function (daysAhead) {
      var button = await ctx.dayButton(daysAhead);
      assert.ok(button, dateAfter(daysAhead) + 'のボタンがある');
      assert.strictEqual(button.disabled, false, dateAfter(daysAhead) + 'は選択できる');
      button._listeners.click();
      await flushPromises();
    }
  };
  ctx.shownDate = TODAY;
  return ctx;
}

async function ready(opts) {
  var ctx = setup(opts);
  await flushPromises();
  return ctx;
}

function lastEstimateUrl(ctx) {
  var urls = ctx.fetchCalls.filter(function (u) { return u.indexOf('action=estimatePrice') !== -1; });
  return urls[urls.length - 1] || '';
}

/* ── 境界: 30/31日・90/91日（V1の一般・会員） ── */

test('V1・会員区分が未選択／一般: 30日先は選べるが、31日先・90日先の会員先行枠と91日先（範囲外）は選べない', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  assert.strictEqual((await ctx.dayButton(30)).disabled, false, '30日先は一般も選択可');
  assert.strictEqual((await ctx.dayButton(31)).disabled, true, '31日先（会員先行枠）は未選択では選択不可');
  assert.strictEqual((await ctx.dayButton(90)).disabled, true, '90日先（会員先行枠）は未選択では選択不可');
  assert.strictEqual((await ctx.dayButton(91)).disabled, true, '91日先は範囲外');

  ctx.setMember('general');
  assert.strictEqual((await ctx.dayButton(30)).disabled, false);
  assert.strictEqual((await ctx.dayButton(31)).disabled, true, '一般では31日先を選べない');
  assert.strictEqual((await ctx.dayButton(90)).disabled, true, '一般では90日先を選べない');
});

test('V1・会員: 31日先〜90日先の先行予約を選べるが、91日先は範囲外のまま選べない', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  ctx.setMember('member');
  assert.strictEqual((await ctx.dayButton(30)).disabled, false);
  assert.strictEqual((await ctx.dayButton(31)).disabled, false, '会員は31日先を選べる');
  assert.strictEqual((await ctx.dayButton(90)).disabled, false, '会員は90日先を選べる');
  assert.strictEqual((await ctx.dayButton(91)).disabled, true, '91日先は会員でも選べない');
});

test('月間availability APIのリクエストは会員区分・UI解除で分岐しない（キャッシュ・APIは全員共通）', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  ctx.setMember('member');
  await ctx.dayButton(31);
  ctx.setMember('general');
  var monthly = ctx.fetchCalls.filter(function (u) { return u.indexOf('action=monthly') !== -1; });
  assert.ok(monthly.length >= 1);
  monthly.forEach(function (url) { assert.ok(!/member|unlock|isMember/i.test(url.split('?')[1]), '月間APIへ会員情報を渡さない: ' + url); });
});

/* ── 会員限定特典 ── */

test('V1・一般: 2026/12/10でもペアパック・シャワーは選択不可（disabled）で、「SNB MEMBER会員のみ」の案内を出す', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  ctx.setMember('general');
  await ctx.pick(20); /* 2026-12-10 */
  assert.strictEqual(ctx.elements['ba-date'].value, '2026-12-10');
  assert.strictEqual(ctx.elements['ba-plan-pair'].parentNode.hidden, false, '12/1以降は欄を表示する');
  assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, true);
  assert.strictEqual(ctx.elements['ba-shower'].disabled, true);
  assert.strictEqual(ctx.elements['ba-benefits-locked'].hidden, false, '選べない理由を表示する');
});

test('V1・会員: 2026/12/10でペアパックもシャワーも選択可能', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  ctx.setMember('member');
  await ctx.pick(20);
  assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, false);
  assert.strictEqual(ctx.elements['ba-shower'].disabled, false);
  assert.strictEqual(ctx.elements['ba-benefits-locked'].hidden, true);
});

test('会員→一般: ペアパック・シャワーが自動解除され、見積りは通常（plan無し）へ戻り、シャワーの追加オプション表示も消える', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  ctx.setMember('member');
  await ctx.pick(20);
  ctx.setBenefit('ba-plan-pair', true);
  ctx.setBenefit('ba-shower', true);
  await flushPromises();
  assert.ok(/plan=member_pair_3h/.test(lastEstimateUrl(ctx)), 'ペアパック選択中はplanを見積りへ渡す');
  assert.strictEqual(ctx.elements['ba-price-extra'].hidden, false);

  ctx.setMember('general');
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-plan-pair'].checked, false);
  assert.strictEqual(ctx.elements['ba-shower'].checked, false);
  assert.ok(!/plan=/.test(lastEstimateUrl(ctx)), '一般へ戻したら通常予約の見積り（plan無し）');
  assert.ok(/isMember=0/.test(lastEstimateUrl(ctx)));
  assert.strictEqual(ctx.elements['ba-price-extra'].hidden, true, '追加オプション表示は消える');
  assert.strictEqual(ctx.elements['ba-confirm-shower-row'].hidden, true, '確認画面のシャワー行も消える');
  assert.strictEqual(ctx.elements['ba-date'].value, '2026-12-10', '30日以内の日付は残してよい');
});

test('会員→一般: 31〜90日先を選択済みなら、利用日・開始時刻・見積り・Step1「次へ」が解除され、カレンダーも再描画される', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  ctx.setMember('member');
  await ctx.pick(45); /* 2027-01-04（会員先行枠） */
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-date'].value, dateAfter(45));
  assert.ok(ctx.elements['ba-price-line'].hidden === false, '料金見積りが表示されている');
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, false, '開始時刻エリアが開いている');

  ctx.setMember('general');
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-date'].value, '', '利用日を解除');
  assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true, '開始時刻エリアを閉じる');
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, true, '開始時刻の「次へ」を無効化');
  assert.strictEqual(ctx.elements['ba-price-line'].hidden, true, '古い料金見積りを消す');
  assert.strictEqual(ctx.elements['ba-confirm-price'].textContent.indexOf('6,600'), -1, '確認画面に古い料金を残さない');
  assert.strictEqual(ctx.elements['ba-calendar-selected'].textContent, '', '選択日の表示を消す');
  assert.strictEqual(findDayButton(ctx.gridBody(), dateAfter(45)).disabled, true, 'カレンダー上も選択不可へ戻る');
});

/* ── V2 / SNB mens: UI解除操作 ── */

[['snb', 'V2'], ['mens', 'V1']].forEach(function (c) {
  var brand = c[0], generation = c[1];
  var label = brand === 'snb' ? 'SNB V2' : 'SNB mens';

  test(label + ': 通常状態では31日先・会員限定特典を選べず、UI解除を出す', async function () {
    var ctx = await ready({ brand: brand, generation: generation });
    await ctx.dayButton(1); /* 月間応答（priceGeneration）を反映させる */
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-member-unlock-field'].hidden, false, '会員向けUI解除の操作を表示する');
    assert.strictEqual(ctx.elements['ba-member-unlock'].checked, false, '初期は解除しない');
    assert.strictEqual((await ctx.dayButton(30)).disabled, false);
    assert.strictEqual((await ctx.dayButton(31)).disabled, true);
    assert.strictEqual((await ctx.dayButton(90)).disabled, true);
    await ctx.pick(20);
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, true);
    assert.strictEqual(ctx.elements['ba-shower'].disabled, true);
  });

  test(label + ': UI解除を行うと31〜90日先と会員限定特典を選べる。ただし91日先は選べず、解除だけでisMember・会員料金は確定しない', async function () {
    var ctx = await ready({ brand: brand, generation: generation });
    await ctx.dayButton(1);
    await flushPromises();
    ctx.setUnlock(true);
    assert.strictEqual((await ctx.dayButton(31)).disabled, false);
    assert.strictEqual((await ctx.dayButton(90)).disabled, false);
    assert.strictEqual((await ctx.dayButton(91)).disabled, true);
    await ctx.pick(20);
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, false);
    assert.strictEqual(ctx.elements['ba-shower'].disabled, false);
    ctx.setBenefit('ba-plan-pair', true);
    await flushPromises();
    assert.ok(/isMember=0/.test(lastEstimateUrl(ctx)), 'UI解除は見積りへisMember=1を送らない: ' + lastEstimateUrl(ctx));
    assert.ok(!/unlock/i.test(lastEstimateUrl(ctx)), 'UI解除そのものはAPIへ渡さない');
  });

  test(label + ': UI解除をOFFへ戻すと、ペアパック・シャワー・31日先以降の日付と開始時刻が解除される', async function () {
    var ctx = await ready({ brand: brand, generation: generation });
    await ctx.dayButton(1);
    await flushPromises();
    ctx.setUnlock(true);
    await ctx.pick(45);
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-date'].value, dateAfter(45));
    ctx.setUnlock(false);
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-date'].value, '');
    assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true);
    assert.strictEqual(ctx.elements['ba-price-line'].hidden, true);
    assert.strictEqual(findDayButton(ctx.gridBody(), dateAfter(45)).disabled, true);

    ctx.setUnlock(true);
    await ctx.pick(20);
    ctx.setBenefit('ba-plan-pair', true);
    ctx.setBenefit('ba-shower', true);
    ctx.setUnlock(false);
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-plan-pair'].checked, false);
    assert.strictEqual(ctx.elements['ba-shower'].checked, false);
    assert.ok(ctx.elements['ba-price-line'].textContent.indexOf('6,600') !== -1, '通常予約の見積り（ペアパック5,000円ではない）へ戻る: ' + ctx.elements['ba-price-line'].textContent);
    assert.strictEqual(ctx.elements['ba-date'].value, '2026-12-10', '30日以内の日付は残る');
  });
});

test('SNB V1: 会員区分ラジオ表示中は、UI解除操作を出さない（会員区分が唯一の入口）', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  await ctx.dayButton(1);
  assert.strictEqual(ctx.elements['ba-member-unlock-field'].hidden, true);
});

test('Studio X: 会員向け特典欄もUI解除も出さず、カレンダーの選択可否は従来どおり（本Issueの対象外）', async function () {
  var ctx = await ready({ brand: 'studio_x', generation: 'V1' });
  assert.strictEqual(ctx.elements['ba-member-unlock-field'].hidden, true);
  assert.strictEqual(ctx.elements['ba-benefits-field'].hidden, true);
  assert.strictEqual((await ctx.dayButton(31)).disabled, false, 'Studio Xは既存仕様のまま');
  var tpl = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_ja.html'), 'utf8');
  var unlockIndex = tpl.indexOf('id="ba-member-unlock"');
  assert.ok(unlockIndex > tpl.indexOf('{% if include.brand == "snb" or include.brand == "mens" %}'), 'UI解除はSNB / mensのテンプレート内だけ');
  assert.ok(tpl.indexOf('{% endif %}', unlockIndex) > unlockIndex);
});

/* ── シャワー料金の表示 ── */

test('シャワー選択時: 部屋料金とは別に「シャワー ¥1,000（税込）」と別途決済の注記を出し、確認画面にも出す。外すと消える', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  ctx.setMember('member');
  await ctx.pick(20);
  assert.strictEqual(ctx.elements['ba-price-extra'].hidden, true, '未選択では出さない');
  ctx.setBenefit('ba-shower', true);
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-price-extra'].hidden, false);
  assert.strictEqual(ctx.elements['ba-price-extra-line'].textContent, '追加オプション：シャワー ¥1,000（税込）');
  var note = ctx.elements['ba-price-extra-note'].textContent;
  assert.ok(note.indexOf('部屋料金には含まれていません') !== -1, note);
  assert.ok(note.indexOf('別途') !== -1 && note.indexOf('承認') !== -1, note);
  assert.strictEqual(ctx.elements['ba-confirm-shower-row'].hidden, false);
  assert.ok(ctx.elements['ba-confirm-shower'].textContent.indexOf('シャワー ¥1,000（税込）') !== -1);
  assert.ok(ctx.elements['ba-confirm-shower'].textContent.indexOf('別途決済') !== -1);
  assert.ok(ctx.elements['ba-price-line'].textContent.indexOf('7,600') === -1, '部屋料金へ加算した合計を出さない');
  assert.ok(ctx.fetchCalls.some(function (u) { return u.indexOf('action=optionCatalog') !== -1 && u.indexOf('brand=snb') !== -1; }), '金額はoptionCatalog（サーバー）から取得');

  ctx.setBenefit('ba-shower', false);
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-price-extra'].hidden, true);
  assert.strictEqual(ctx.elements['ba-confirm-shower-row'].hidden, true);
});

test('Logic.showerExtraInfo: 金額はカタログ由来の引数だけから作り、取得できない間は金額を出さない（ja / en）', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  var ja = Logic.showerExtraInfo(1000, 'ja');
  assert.strictEqual(ja.text, '追加オプション：シャワー ¥1,000（税込）');
  assert.ok(ja.notes.join('').indexOf('部屋料金には含まれていません') !== -1);
  assert.strictEqual(Logic.showerExtraInfo(null, 'ja').value, 'シャワー（別途料金）', '金額不明では確定額を出さない');
  assert.strictEqual(Logic.showerExtraInfo(undefined, 'ja').value, 'シャワー（別途料金）');
  assert.strictEqual(Logic.showerExtraInfo(1000, 'en').value, 'Shower ¥1,000 (tax incl.)');
  var app = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'booking-app.js'), 'utf8');
  assert.ok(!/1000|1,000/.test(app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'フロントにシャワー価格を複製しない');
});

/* ── 純粋ロジック ── */

test('Logic.isCalendarDaySelectable: 会員先行枠は会員向けUIが有効なときだけ。従来の4引数呼び出しは空き状況だけで決まる', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-12-01', 'AVAILABLE', 'returning', TODAY), true, '従来の呼び出し');
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-12-21', 'AVAILABLE', 'returning', TODAY, true, false), false, '先行枠・UI無効');
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-12-21', 'AVAILABLE', 'returning', TODAY, true, true), true, '先行枠・UI有効');
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-12-20', 'AVAILABLE', 'returning', TODAY, false, false), true, '通常枠はUI無効でも選べる');
  assert.strictEqual(Logic.isCalendarDaySelectable('2026-12-21', 'FULL', 'returning', TODAY, true, true), false, '満席は常に選べない');
  assert.strictEqual(Logic.isCalendarDaySelectable('2027-02-19', 'OUT_OF_RANGE', 'returning', TODAY, false, true), false, '範囲外は常に選べない');
});

test('Logic.brandGatesMemberFeatures: SNB / mensのみ（Studio Xは対象外）。mensの価格優遇は会員資格とみなさない', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  assert.strictEqual(Logic.brandGatesMemberFeatures('snb'), true);
  assert.strictEqual(Logic.brandGatesMemberFeatures('mens'), true);
  assert.strictEqual(Logic.brandGatesMemberFeatures('studio_x'), false);
});

test('最終判定はサーバーが正本: ADVANCE_BOOKING_MEMBER_ONLY等のサーバー側判定をフロントのUI解除で置き換えない', function () {
  var app = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'booking-app.js'), 'utf8');
  var logic = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'booking-logic.js'), 'utf8');
  assert.ok(/ADVANCE_BOOKING_MEMBER_ONLY/.test(logic), 'サーバーの拒否コードの案内文言は維持');
  assert.ok(!/memberUnlock[^;\n]*isMember|isMember[^;\n]*memberUnlock/.test(app), 'UI解除をisMemberへ結び付けない');
  assert.ok(!/action=(member|membership)/i.test(app), '公開会員照会APIを呼ばない');
});

/* ── 追記: 利用時間の変更だけでは開始時刻を捨てない ── */

function durationAvailability(minutes) {
  if (minutes === 240) return ['13:00', '14:00'];
  if (minutes === 180) return ['13:00', '14:00', '15:00'];
  if (minutes === 120) return ['13:00', '14:00', '15:00', '16:00'];
  return ['10:00', '11:00']; /* 5時間以上は14:00開始が成立しない */
}

async function pickWithStartTime(ctx, time) {
  await ctx.pick(20); /* 2026-12-10 */
  await flushPromises();
  var button = ctx.startTimeButton(time);
  assert.ok(button, time + 'の開始時刻ボタンがある');
  button._listeners.click();
  assert.ok(ctx.elements['ba-price-time'].textContent.indexOf(time) !== -1);
}

test('利用時間を4→3時間へ短縮: 日付・14:00開始を保持し、終了時刻と見積りだけ新しい利用時間に同期する', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1', duration: 4, availability: durationAvailability });
  ctx.setMember('general');
  ctx.elements['ba-name'] = ctx.elements['ba-name'] || createElement('ba-name');
  ctx.elements['ba-name'].value = '山田 太郎';
  await pickWithStartTime(ctx, '14:00');
  assert.ok(ctx.elements['ba-price-time'].textContent.indexOf('18:00') !== -1, '4時間なら終了18:00');

  ctx.setDuration(3);
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-date'].value, '2026-12-10', '利用日は保持');
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, false, '開始時刻が保持され「次へ」を押せる');
  var timeText = ctx.elements['ba-price-time'].textContent;
  assert.ok(timeText.indexOf('14:00') !== -1 && timeText.indexOf('17:00') !== -1, '終了時刻は新しい利用時間(17:00): ' + timeText);
  assert.ok(timeText.indexOf('18:00') === -1, '古い終了時刻を残さない');
  assert.ok(ctx.elements['ba-start-time-summary'].textContent.indexOf('3時間') !== -1);
  assert.ok(ctx.elements['ba-start-time-summary'].textContent.indexOf('選び直') === -1, '選び直しの案内は出さない');
  assert.ok(/durationMinutes=180/.test(lastEstimateUrl(ctx)), '料金見積りは新しい利用時間で取り直す: ' + lastEstimateUrl(ctx));
  assert.strictEqual(ctx.elements['ba-email'].value, 'taro@example.com', 'メールアドレスは失われない');
  assert.strictEqual(ctx.elements['ba-name'].value, '山田 太郎', '氏名は失われない');
});

test('利用時間を3→5時間へ延長して14:00開始が成立しなくなった場合だけ、開始時刻を解除して選び直しを案内する（他の入力は残す）', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1', duration: 3, availability: durationAvailability });
  await pickWithStartTime(ctx, '14:00');

  ctx.setDuration(5);
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-date'].value, '2026-12-10', '利用日は保持');
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, true, '開始時刻は未選択（再選択が必要）');
  assert.strictEqual(ctx.elements['ba-price-time'].hidden, true, '古い終了時刻を残さない');
  var summary = ctx.elements['ba-start-time-summary'].textContent;
  assert.ok(summary.indexOf('14:00') !== -1 && summary.indexOf('選び直') !== -1, '再選択を明確に案内: ' + summary);
  assert.ok(ctx.startTimeButton('14:00') === null && ctx.startTimeButton('10:00'), '新しい利用時間で空く開始時刻だけを出す');
  assert.strictEqual(ctx.elements['ba-email'].value, 'taro@example.com');
});

test('利用時間を続けて変えても、最初に選んだ開始時刻を失わない（4→3→2時間）', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1', duration: 4, availability: durationAvailability });
  await pickWithStartTime(ctx, '14:00');
  ctx.setDuration(3);
  ctx.setDuration(2); /* 応答を待たずに再変更 */
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, false);
  var timeText = ctx.elements['ba-price-time'].textContent;
  assert.ok(timeText.indexOf('14:00') !== -1 && timeText.indexOf('16:00') !== -1, timeText);
});

test('利用時間を変えても日付を選び直した場合は、前の開始時刻を自動選択しない', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1', duration: 4, availability: durationAvailability });
  await pickWithStartTime(ctx, '14:00');
  ctx.setDuration(3);
  await flushPromises();
  await flushPromises();
  await ctx.pick(21); /* 別の日を選択 */
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-date'].value, '2026-12-11');
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, true, '別日は開始時刻を選び直す');
});
