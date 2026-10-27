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
var memberAuthRequiredForTest = false; /* Studio XがOTPフェーズ（認証必須）のとき、setupのopts.memberAuthRequiredで有効にする */
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
  return { success: true, month: year + '-' + pad2(month), days: days, priceGeneration: generation, memberAuthRequired: memberAuthRequiredForTest === true };
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
  memberAuthRequiredForTest = opts.memberAuthRequired === true;
  var elements = {};
  var fetchCalls = [];
  var selectedMemberStatus = '';

  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof FakeDate)) return new Date(FIXED_NOW_MS).toString();
    return args.length === 0 ? new Date(FIXED_NOW_MS) : new (Function.prototype.bind.apply(Date, [null].concat(args)))();
  }
  var clockOffsetMs = 0;
  FakeDate.now = function () { return FIXED_NOW_MS + clockOffsetMs; };
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

  var posts = [];
  function fetchStub(url, options) {
    fetchCalls.push(url);
    var body;
    if (options && options.method === 'POST') {
      var requestBody = JSON.parse(options.body || '{}');
      posts.push({ url: url, body: requestBody });
      if (url.indexOf('action=requestBookingMemberCode') !== -1) {
        body = opts.requestCode ? opts.requestCode(requestBody) : { success: true, message: 'sent', ttlMinutes: 60 };
      } else if (url.indexOf('action=verifyBookingMemberCode') !== -1) {
        body = requestBody.code === '123456'
          ? { success: true, proof: 'P'.repeat(40), expiresInMinutes: 60, advanceEligible: opts.advanceEligible !== false }
          : { success: false, error: { code: 'INVALID_CODE' } };
      } else if (url.indexOf('action=bookingMemberStatus') !== -1) {
        body = opts.memberStatus ? opts.memberStatus(requestBody) : {
          success: true, verified: true, advanceEligible: true, memberOnDate: true, priceGeneration: 'V2', memberAuthRequired: memberAuthRequiredForTest === true,
          price: { amount: 5500, tier: 'MEMBER', brand: brand, plan: requestBody.plan || '' }
        };
      } else {
        body = { success: false, error: { code: 'INTERNAL_ERROR' } };
      }
      return Promise.resolve({ json: function () { return Promise.resolve(body); } });
    }
    if (url.indexOf('action=monthly') !== -1) {
      var year = Number(/[?&]year=(\d+)/.exec(url)[1]);
      var month = Number(/[?&]month=(\d+)/.exec(url)[1]);
      body = monthlyBody(year, month, generation);
    } else if (url.indexOf('action=estimatePrice') !== -1) {
      var plan = /[?&]plan=([^&]+)/.exec(url);
      body = { success: true, priceGeneration: generation, memberAuthRequired: memberAuthRequiredForTest === true, price: { amount: plan ? 5000 : 6600, tier: 'GENERAL', brand: brand, plan: plan ? plan[1] : '' } };
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
    posts: posts,
    advanceClock: function (ms) { clockOffsetMs += ms; },
    postsOf: function (action) { return posts.filter(function (p) { return p.url.indexOf('action=' + action) !== -1; }); },
    click: function (id) { elements[id]._listeners.click(); },
    typeEmail: function (value) { elements['ba-email'].value = value; elements['ba-email']._listeners.input(); },
    /* 確認コードを送信 → 入力 → 確認する。 */
    verifyMember: async function (code) {
      elements['ba-member-code-send']._listeners.click();
      await flushPromises();
      elements['ba-member-code'].value = code || '123456';
      elements['ba-member-code-verify']._listeners.click();
      await flushPromises();
      await flushPromises();
    },
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

[['mens', 'V1']].forEach(function (c) {
  var brand = c[0], generation = c[1];
  var label = 'SNB mens（V1。2026/11/30までの作成はUI解除）';

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

/* ── Issue #548: V2（SNB / SNB mens）の会員確認（メールOTP） ── */

['snb', 'mens'].forEach(function (brand) {
  var label = brand === 'snb' ? 'SNB V2' : 'SNB mens V2';

  test(label + ': 未確認では会員確認欄を出し、自己申告のUI解除は出さない。31日先・会員限定特典は選べず、見積りは一般（isMember=0）', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2' });
    await ctx.dayButton(1); /* 月間応答（priceGeneration=V2）を反映させる */
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, false, 'メールOTPの会員確認欄を表示');
    assert.strictEqual(ctx.elements['ba-member-unlock-field'].hidden, true, '自己申告の解除は出さない（#546のUI解除はV2では実装しない）');
    assert.strictEqual(ctx.elements['ba-member-code-entry'].hidden, true, '確認コードの入力欄は送信後に表示');
    assert.strictEqual((await ctx.dayButton(30)).disabled, false, '一般は30日先まで');
    assert.strictEqual((await ctx.dayButton(31)).disabled, true);
    assert.strictEqual((await ctx.dayButton(90)).disabled, true);
    await ctx.pick(20);
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, true);
    assert.strictEqual(ctx.elements['ba-shower'].disabled, true);
    assert.ok(/isMember=0/.test(lastEstimateUrl(ctx)), '未確認はGETの見積り（一般）: ' + lastEstimateUrl(ctx));
    assert.strictEqual(ctx.postsOf('bookingMemberStatus').length, 0, '未確認は会員結果を取得しない');
  });

  test(label + ': 確認コードを送信 → 6桁入力 → 確認済みで、先行予約・会員限定特典を選べ、会員料金の見積りは証明つきPOSTで取得する', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2' });
    await ctx.dayButton(1);
    await flushPromises();

    ctx.click('ba-member-code-send');
    await flushPromises();
    assert.strictEqual(ctx.postsOf('requestBookingMemberCode').length, 1);
    assert.deepStrictEqual(ctx.postsOf('requestBookingMemberCode')[0].body, { email: 'taro@example.com' }, 'メールだけを送る');
    assert.strictEqual(ctx.elements['ba-member-code-entry'].hidden, false, '送信後に入力欄を表示');

    /* 6桁でない入力はAPIへ送らない。誤ったコードは拒否され、会員機能は開かない。 */
    ctx.elements['ba-member-code'].value = '12ab';
    ctx.click('ba-member-code-verify');
    await flushPromises();
    assert.strictEqual(ctx.postsOf('verifyBookingMemberCode').length, 0);
    assert.strictEqual(ctx.elements['ba-member-verify-error'].hidden, false);
    ctx.elements['ba-member-code'].value = '000000';
    ctx.click('ba-member-code-verify');
    await flushPromises();
    await flushPromises();
    assert.strictEqual(ctx.postsOf('verifyBookingMemberCode').length, 1);
    assert.strictEqual(ctx.elements['ba-member-verify-error'].hidden, false, '誤ったコードはエラー表示');
    assert.strictEqual((await ctx.dayButton(31)).disabled, true, '未確認のまま');

    ctx.elements['ba-member-code'].value = '123456';
    ctx.click('ba-member-code-verify');
    await flushPromises();
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-member-verify-error'].hidden, true);
    assert.strictEqual(ctx.elements['ba-member-code-entry'].hidden, true, '確認後は入力欄を閉じる');
    assert.strictEqual((await ctx.dayButton(31)).disabled, false, '確認済み + 今日会員なら先行予約枠を選べる');
    assert.strictEqual((await ctx.dayButton(90)).disabled, false);
    assert.strictEqual((await ctx.dayButton(91)).disabled, true, '91日先は範囲外のまま');

    await ctx.pick(20);
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, false);
    assert.strictEqual(ctx.elements['ba-shower'].disabled, false);
    var statusPosts = ctx.postsOf('bookingMemberStatus');
    assert.ok(statusPosts.length >= 1, '会員料金の見積りは証明つきPOST');
    var quote = statusPosts[statusPosts.length - 1].body;
    assert.strictEqual(quote.email, 'taro@example.com');
    assert.strictEqual(quote.proof, 'P'.repeat(40));
    assert.strictEqual(quote.date, '2026-12-10');
    assert.strictEqual(quote.brand, brand);
    assert.ok(ctx.elements['ba-price-line'].textContent.indexOf('5,500') !== -1, '会員料金を表示: ' + ctx.elements['ba-price-line'].textContent);
    var getEstimates = ctx.fetchCalls.filter(function (u) { return u.indexOf('action=estimatePrice') !== -1; });
    getEstimates.forEach(function (u) { assert.ok(/isMember=0/.test(u), 'GETの見積りはisMember=1を送らない: ' + u); });
  });

  test(label + ': 確認済みでも今日の会員資格が無ければ先行予約枠は選べない（会員限定特典の欄は開く）', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2', advanceEligible: false });
    await ctx.dayButton(1);
    await flushPromises();
    await ctx.verifyMember();
    assert.strictEqual((await ctx.dayButton(31)).disabled, true);
    assert.strictEqual((await ctx.dayButton(30)).disabled, false);
    await ctx.pick(20);
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, false);
  });

  test(label + ': メールアドレスを変えると確認済み状態・先行予約日・特典・会員料金を即破棄する', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2' });
    await ctx.dayButton(1);
    await flushPromises();
    await ctx.verifyMember();
    await ctx.pick(45);
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-date'].value, dateAfter(45));
    ctx.setBenefit('ba-shower', true);

    ctx.typeEmail('other@example.com');
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-date'].value, '', '先行予約日を解除');
    assert.strictEqual(ctx.elements['ba-shower'].checked, false, '特典を解除');
    assert.strictEqual((await ctx.dayButton(31)).disabled, true, '30日先までへ戻る');
    assert.strictEqual(ctx.elements['ba-price-line'].hidden, true, '会員料金の見積りを消す');
    await ctx.pick(20);
    assert.ok(/isMember=0/.test(lastEstimateUrl(ctx)), '一般料金の見積りへ戻る');
    assert.strictEqual(ctx.postsOf('bookingMemberStatus').filter(function (p) { return p.body.email === 'other@example.com'; }).length, 0, '新しいメールで古い証明を使わない');
  });

  test(label + ': 利用日を変えても確認済み証明は維持し、利用日ごとに会員結果と見積りを再取得する', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2' });
    await ctx.dayButton(1);
    await flushPromises();
    await ctx.verifyMember();
    await ctx.pick(20);
    var before = ctx.postsOf('bookingMemberStatus').length;
    await ctx.pick(21);
    await flushPromises();
    var posts = ctx.postsOf('bookingMemberStatus');
    assert.ok(posts.length > before, '利用日変更で再取得');
    assert.strictEqual(posts[posts.length - 1].body.date, dateAfter(21));
    assert.strictEqual(posts[posts.length - 1].body.proof, 'P'.repeat(40), '証明は維持');
    assert.strictEqual(ctx.postsOf('verifyBookingMemberCode').length, 1, '再度コード入力は求めない');
  });

  test(label + ': 会員結果の再取得で証明が無効（期限切れ）と分かったら、黙って一般料金へ降格せず再確認を求め、先へ進ませない', async function () {
    var expired = false;
    var ctx = await ready({
      brand: brand, generation: 'V2',
      memberStatus: function (body) {
        return expired
          ? { success: false, error: { code: 'MEMBER_REVERIFY_REQUIRED' } }
          : { success: true, verified: true, advanceEligible: true, memberOnDate: true, priceGeneration: 'V2', price: { amount: 5500, tier: 'MEMBER', brand: brand, plan: body.plan || '' } };
      }
    });
    await ctx.dayButton(1);
    await flushPromises();
    await ctx.verifyMember();
    await ctx.pick(45); /* 先行予約日を選択済み */
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-date'].value, dateAfter(45));

    expired = true;
    ctx.setDuration(4); /* 条件変更で会員結果を再取得 */
    await flushPromises();
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-member-reverify'].hidden, false, '再確認の案内を表示');
    assert.ok(ctx.elements['ba-member-reverify-message'].textContent.indexOf('確認コードを再送') !== -1);
    assert.strictEqual(ctx.elements['ba-date'].value, '', '先行予約日は一般予約として確定させない（解除）');
    assert.strictEqual((await ctx.dayButton(31)).disabled, true);
    assert.ok(ctx.elements['ba-price-line'].hidden === true || ctx.elements['ba-price-line'].textContent.indexOf('5,500') === -1, '会員料金のまま残さない');

    /* 再確認するか「一般予約として続ける」を選ぶまで、Step1の「次へ」は進まない。 */
    ctx.elements['ba-date'].value = dateAfter(20);
    var fetchCountBefore = ctx.fetchCalls.length;
    ctx.click('ba-step-datetime-next');
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-start-time-area'].hidden, true, '開始時刻へ進まない');
    assert.strictEqual(ctx.fetchCalls.slice(fetchCountBefore).filter(function (u) { return u.indexOf('action=getAvailability') !== -1 || (u.indexOf('action=') === -1 && u.indexOf('date=') !== -1); }).length, 0);
    assert.strictEqual(ctx.elements['ba-global-error'].hidden, false, '再確認を促すエラーを表示');

    /* 利用者自身の明示操作で一般予約へ戻る。 */
    ctx.click('ba-member-general-continue');
    assert.strictEqual(ctx.elements['ba-member-reverify'].hidden, true);
  });

  test(label + ': 端末の時計で60分を過ぎた確認済み証明は、見積り・先へ進む前に再確認へ（サーバーへ古い証明を送り続けない）', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2' });
    await ctx.dayButton(1);
    await flushPromises();
    await ctx.verifyMember();
    await ctx.pick(20);
    var before = ctx.postsOf('bookingMemberStatus').length;
    ctx.advanceClock(61 * 60 * 1000);
    ctx.setDuration(4);
    await flushPromises();
    assert.strictEqual(ctx.postsOf('bookingMemberStatus').length, before, '期限切れの証明で会員結果を取得しない');
    assert.strictEqual(ctx.elements['ba-member-reverify'].hidden, false);
  });

  test(label + ': 確認コードの送信はメールアドレスの形式が正しいときだけ（会員の有無は表示しない）', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2' });
    await ctx.dayButton(1);
    await flushPromises();
    ctx.elements['ba-email'].value = 'not-an-email';
    ctx.click('ba-member-code-send');
    await flushPromises();
    assert.strictEqual(ctx.postsOf('requestBookingMemberCode').length, 0);
    assert.strictEqual(ctx.elements['ba-email-error'].hidden, false);
  });
});

test('SNB V1: 会員確認欄（メールOTP）は出さない（V1は従来仕様）。V1/V2はサーバーが返す料金世代で決め、端末の時計では判断しない', async function () {
  var ctx = await ready({ brand: 'snb', generation: 'V1' });
  await ctx.dayButton(1);
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, true);
  assert.strictEqual(ctx.postsOf('requestBookingMemberCode').length, 0);
  ctx.setMember('member');
  assert.strictEqual((await ctx.dayButton(31)).disabled, false, 'V1は会員区分で従来どおり先行予約を選べる');
  var mens = await ready({ brand: 'mens', generation: 'V1' });
  await mens.dayButton(1);
  assert.strictEqual(mens.elements['ba-member-verify-field'].hidden, true);
});

test('Studio X: 会員確認欄は出さず、従来どおり（本Issueの対象外）', async function () {
  var ctx = await ready({ brand: 'studio_x', generation: 'V2' });
  await ctx.dayButton(1);
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, true);
});

test('Logic.buildCreateBookingPayload: memberProofは保持している場合だけ送る。verified/isMember=trueは会員確認の代わりにならない（サーバーが検証）', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  var base = { brand: 'snb', customerType: 'returning', date: '2026-12-10', startTime: '10:00', durationMinutes: 180, name: 'a', email: 'a@example.com', people: '1名', purpose: 'x', paymentMethod: '現金', isMember: false };
  var without = Logic.buildCreateBookingPayload(base);
  assert.strictEqual('memberProof' in without, false, '証明が無ければキー自体を付けない');
  assert.strictEqual(without.isMember, false);
  var withProof = Logic.buildCreateBookingPayload(Object.assign({}, base, { memberProof: 'P'.repeat(40), verified: true }));
  assert.strictEqual(withProof.memberProof, 'P'.repeat(40));
  assert.strictEqual('verified' in withProof, false, 'verifiedなどのクライアント値は送らない');
  assert.strictEqual('memberProof' in Logic.buildCreateBookingPayload(Object.assign({}, base, { memberProof: '' })), false);
});

test('Logic: 会員確認が無い／期限切れのエラーは再確認の導線（reverify）で、予約を作らず会員確認欄へ戻す。文言に会員の有無を含めない', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  assert.strictEqual(Logic.recoveryActionForErrorCode('MEMBER_REVERIFY_REQUIRED'), 'reverify');
  assert.strictEqual(Logic.recoveryActionForErrorCode('MEMBER_VERIFICATION_REQUIRED'), 'reverify');
  ['ja', 'en'].forEach(function (locale) {
    ['MEMBER_REVERIFY_REQUIRED', 'MEMBER_VERIFICATION_REQUIRED', 'INVALID_CODE', 'VERIFICATION_UNAVAILABLE'].forEach(function (code) {
      var message = Logic.messageForErrorCode(code, locale);
      assert.ok(message && message !== Logic.messageForErrorCode('NO_SUCH_CODE', locale), code + ' ' + locale + ' に専用の文言がある');
      assert.ok(!/非会員|台帳|不一致/.test(message), '会員の有無を示さない: ' + message);
    });
  });
  assert.ok(Logic.messageForErrorCode('MEMBER_REVERIFY_REQUIRED', 'ja').indexOf('確認コードを再送してもう一度確認してください') !== -1);
});

test('配線: 確認済み証明はcreateBookingの送信にだけ付け、フロントはverified/isMemberを正本にしない', function () {
  var app = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'booking-app.js'), 'utf8');
  assert.ok(/memberProof: memberVerified_\(\) \? memberAuth\.proof : ''/.test(app), '送信ペイロードに証明を付ける');
  assert.ok(!/isMember: *true|verified *: *true/.test(app.replace(/\/\*[\s\S]*?\*\//g, '')), 'フロントでisMember/verifiedをtrueにして送らない');
  /* Issue #559: sessionStorageを読むのは、<head>のインライン処理が保存したテスト資格（snbBookingTestCredential）だけ。OTP確認済み証明は書き込まない（メモリのみ）。 */
  var appCode = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/localStorage|setItem|document\.cookie/.test(appCode), '証明をlocalStorage・Cookie等へ保存しない（メモリのみ）');
  assert.ok((appCode.match(/sessionStorage/g) || []).length === 2 && /getItem\(TEST_CREDENTIAL_STORAGE_KEY_\)/.test(appCode) && /removeItem\(TEST_CREDENTIAL_STORAGE_KEY_\)/.test(appCode), 'sessionStorageはテスト資格の読み取り・破棄だけに使い、証明は保存しない');
  assert.ok(!/console\./.test(app), '証明・コードをconsoleへ出さない');
  var tpl = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_ja.html'), 'utf8');
  assert.ok(tpl.indexOf('id="ba-member-verify-field"') > tpl.indexOf('{% if include.brand == "snb" or include.brand == "mens" or include.brand == "studio_x" %}'), '会員確認欄はSNB / mens / Studio Xのテンプレート内だけ（Studio XはサーバーがOTPフェーズを返すまでJSが隠す）');
  assert.ok(/autocomplete="one-time-code"/.test(tpl));
});
/* ── Issue #552: ペアパックは3時間未満で選択不可。利用時間の変更で自動解除し、通常/会員料金へ再見積りする ── */

[['snb', 'V1'], ['mens', 'V1']].forEach(function (c) {
  var brand = c[0], generation = c[1];
  var label = brand === 'snb' ? 'SNB' : 'SNB mens';

  async function memberReady(duration) {
    var ctx = await ready({ brand: brand, generation: generation, duration: duration });
    if (brand === 'snb') ctx.setMember('member');
    else { await ctx.dayButton(1); await flushPromises(); ctx.setUnlock(true); }
    await ctx.pick(20); /* 2026-12-10 */
    await flushPromises();
    return ctx;
  }

  test(label + ': 1時間・2時間ではペアパックが選択不可で補足を出し、シャワーは選択可能のまま', async function () {
    var ctx = await memberReady(2);
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, true);
    assert.strictEqual(ctx.elements['ba-plan-pair-note'].hidden, false, '3時間以上で選べる旨の補足');
    assert.strictEqual(ctx.elements['ba-shower'].disabled, false, 'シャワーは独立オプション');
    ctx.setDuration(1);
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, true);
    assert.strictEqual(ctx.elements['ba-shower'].disabled, false);
    ctx.setBenefit('ba-shower', true);
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-shower'].checked, true);
  });

  test(label + ': 2h→3h→4hで選択可能になるが、自動ではチェックしない', async function () {
    var ctx = await memberReady(2);
    ctx.setDuration(3);
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, false);
    assert.strictEqual(ctx.elements['ba-plan-pair'].checked, false, '自動でチェックしない');
    assert.strictEqual(ctx.elements['ba-plan-pair-note'].hidden, true);
    ctx.setDuration(4);
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, false);
  });

  [[3, 2], [4, 2]].forEach(function (t) {
    test(label + ': ペアパック選択中に' + t[0] + 'h→' + t[1] + 'hで自動解除し、通常料金の見積りへ戻る（適用プラン・旧金額を残さない）', async function () {
      var ctx = await memberReady(t[0]);
      ctx.setBenefit('ba-plan-pair', true);
      ctx.setBenefit('ba-shower', true);
      await flushPromises();
      assert.ok(/plan=member_pair_3h/.test(lastEstimateUrl(ctx)));
      assert.ok(ctx.elements['ba-price-line'].textContent.indexOf('5,000') !== -1);

      ctx.setDuration(t[1]);
      await flushPromises();
      assert.strictEqual(ctx.elements['ba-plan-pair'].checked, false, '自動解除');
      assert.strictEqual(ctx.elements['ba-plan-pair'].disabled, true);
      assert.ok(!/plan=/.test(lastEstimateUrl(ctx)), '見積りへ member_pair_3h を載せない: ' + lastEstimateUrl(ctx));
      assert.ok(new RegExp('durationMinutes=' + t[1] * 60).test(lastEstimateUrl(ctx)), '2時間の新しい見積り');
      assert.ok(ctx.elements['ba-price-line'].textContent.indexOf('6,600') !== -1, '通常の見積りを表示: ' + ctx.elements['ba-price-line'].textContent);
      assert.ok(ctx.elements['ba-price-line'].textContent.indexOf('5,000') === -1, '旧ペアパック金額を残さない');
      assert.ok(!/ペアパック/.test(ctx.elements['ba-price-applied'].textContent), '適用プラン表示を残さない: ' + ctx.elements['ba-price-applied'].textContent);
      assert.ok(!/ペアパック/.test(ctx.elements['ba-confirm-applied'].textContent), '確認画面の適用プランも残さない');
      assert.strictEqual(ctx.elements['ba-shower'].checked, true, 'シャワー選択は維持');
      assert.strictEqual(ctx.Logic.pairPackDurationAllowed(t[1] * 60), false);
    });
  });
});

test('Logic.pairPackDurationAllowed: 179分以下は不可、180分以上は可', function () {
  var Logic = require('../scripts/booking-logic.js');
  assert.strictEqual(Logic.pairPackDurationAllowed(60), false);
  assert.strictEqual(Logic.pairPackDurationAllowed(120), false);
  assert.strictEqual(Logic.pairPackDurationAllowed(179), false);
  assert.strictEqual(Logic.pairPackDurationAllowed(180), true);
  assert.strictEqual(Logic.pairPackDurationAllowed(240), true);
  assert.strictEqual(Logic.pairPackDurationAllowed(NaN), false);
});

/* ── Issue #567: 会員確認成功の明示（同じカード内で切り替え）と、確認画面の会員確認行 ── */

['snb', 'mens', 'studio_x'].forEach(function (brand) {
  test('Issue #567 ' + brand + ': OTP成功で成功表示に切り替わり、失効・メール変更・一般へ戻るでは確認済み表示を残さない', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2', memberAuthRequired: true });
    await ctx.dayButton(1);
    await flushPromises();
    var success = ctx.elements['ba-member-success'];
    var sendRow = ctx.elements['ba-member-code-send-row'];

    assert.strictEqual(success.hidden, true, '未送信では成功表示を出さない');
    ctx.click('ba-member-code-send');
    await flushPromises();
    assert.strictEqual(success.hidden, true, 'コード送信済みでも成功表示は出さない');

    ctx.elements['ba-member-code'].value = '000000';
    ctx.click('ba-member-code-verify');
    await flushPromises();
    await flushPromises();
    assert.strictEqual(success.hidden, true, '誤ったコードでは成功表示を出さない');

    await ctx.verifyMember();
    assert.strictEqual(success.hidden, false, 'OTP成功で成功表示');
    assert.strictEqual(sendRow.hidden, true, '同じカード内で送信ボタン行は成功表示に置き換わる');
    assert.strictEqual(ctx.elements['ba-member-verify-status'].hidden, true, '成功文は成功カードへ集約し、二重に出さない');

    /* メール変更で確認は失効し、成功表示は消えて送信ボタンが戻る。 */
    ctx.typeEmail('other@example.com');
    await flushPromises();
    assert.strictEqual(success.hidden, true, 'メール変更後に確認済み表示を残さない');
    assert.strictEqual(sendRow.hidden, false);
  });

  test('Issue #567 ' + brand + ': 端末時計で失効したら再確認待ちとなり、成功表示は消える', async function () {
    var ctx = await ready({ brand: brand, generation: 'V2', memberAuthRequired: true });
    await ctx.dayButton(1);
    await flushPromises();
    await ctx.verifyMember();
    await ctx.pick(20);
    assert.strictEqual(ctx.elements['ba-member-success'].hidden, false);
    ctx.advanceClock(61 * 60 * 1000);
    ctx.setDuration(4);
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-member-reverify'].hidden, false);
    assert.strictEqual(ctx.elements['ba-member-success'].hidden, true, '失効後に確認済み表示を残さない');
    ctx.click('ba-member-general-continue');
    assert.strictEqual(ctx.elements['ba-member-success'].hidden, true, '一般予約へ戻っても確認済み表示は出ない');
  });
});

test('Issue #567: 確認画面の会員確認行は、確認済み（失効していない）ときだけ出す', function () {
  var app = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'booking-app.js'), 'utf8');
  assert.ok(/var memberConfirmed = memberVerified_\(\) && !memberProofExpiredLocally_\(\);/.test(app));
  assert.ok(/els\.confirmMemberRow\.hidden = !memberConfirmed;/.test(app), '未確認では行ごと隠す');
  var tpl = fs.readFileSync(path.join(__dirname, '..', '_includes', 'booking_app_ja.html'), 'utf8');
  assert.ok(/id="ba-confirm-member-row" hidden/.test(tpl), '確認画面の会員確認行は初期非表示');
});

test('Issue #567: レイアウトシフト抑制のCSS（ステータス・エラー・料金・カレンダー領域の高さを確保）', function () {
  var css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'booking.css'), 'utf8');
  assert.ok(/#ba-member-verify-status,\s*#ba-member-verify-error\s*\{\s*min-height:/.test(css));
  assert.ok(/\.ba-price-box \{ min-height:/.test(css));
  assert.ok(/#ba-calendar-body \{ min-height:/.test(css));
});
