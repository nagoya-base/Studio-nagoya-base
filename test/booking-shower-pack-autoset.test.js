/*
 * Issue #588: SNB mens「土日祝4時間シャワーパック」のチェックで利用時間を4時間へ自動セットし、即時に再見積りする
 * フロント（scripts/booking-app.js）の配線テスト。実際の booking-logic.js / booking-app.js を最小DOMスタブでvm実行する。
 * パック成立の正本（mens・土日祝・4時間ちょうど・1〜2名・2026/12/1以降・actual membership）はサーバーで、
 * 本テストはフロントが条件を緩和しないこと（成立しない場合は自動変更しない）と操作の簡略化だけを検証する。
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
    ['ba-plan-pair', 'ba-plan-shower-pack', 'ba-shower', 'ba-shower-schedule'].forEach(function (id) {
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
      var estDate = /[?&]date=([^&]+)/.exec(url)[1];
      var estMinutes = Number(/[?&]durationMinutes=(\d+)/.exec(url)[1]);
      var dow = new Date(estDate + 'T00:00:00Z').getUTCDay();
      if (plan && plan[1] === 'mens_weekend_shower_4h' && dow >= 1 && dow <= 5) {
        body = { success: false, error: { code: 'PLAN_DAY_INVALID' } };
      } else if (plan && plan[1] === 'mens_weekend_shower_4h' && estMinutes !== 240) {
        body = { success: false, error: { code: 'PLAN_DURATION_INVALID' } };
      } else if (plan && opts.legacyGas) {
        body = { success: false, error: { code: 'INVALID_PLAN' } };
      } else {
        body = { success: true, priceGeneration: generation, memberAuthRequiredForTest: false, price: { amount: plan ? (plan[1] === 'mens_weekend_shower_4h' ? 6500 : 6000) : 9000, tier: 'MEMBER', brand: brand, plan: plan ? plan[1] : '' } };
      }
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
    setPeople: function (people) { elements['ba-people'].value = people; elements['ba-people']._listeners.change(); },
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

/* ============================================================================
 * Issue #588: シャワーパックのチェックで利用時間を4時間へ自動セットし、即時に6,500円で再見積りする。
 * 2026-12-12(土)=pick(22)、2026-12-10(木・平日)=pick(20)。会員確認はV1のUI解除（mens）で代用する。
 * ============================================================================ */

var PACK = 'mens_weekend_shower_4h';
var SATURDAY_AHEAD = 22;
var WEEKDAY_AHEAD = 20;
var PACK_ID = 'ba-plan-shower-pack';

async function packReady(opts) {
  var ctx = await ready(Object.assign({ brand: 'mens', generation: 'V1' }, opts || {}));
  ctx.setUnlock(true);
  return ctx;
}

async function pickWithStart(ctx, daysAhead, startTime) {
  await ctx.pick(daysAhead);
  await flushPromises();
  ctx.startTimeButton(startTime)._listeners.click();
  await flushPromises();
}

function packNote(ctx) { return ctx.elements['ba-plan-shower-pack-note'].textContent; }
function priceText(ctx) { return ctx.elements['ba-price-line'].textContent; }
function lastEstimate(ctx) {
  var urls = ctx.fetchCalls.filter(function (u) { return u.indexOf('action=estimatePrice') !== -1; });
  return urls[urls.length - 1] || '';
}

[2, 3, 5].forEach(function (hours) {
  test('パックをチェックすると' + hours + '時間から4時間へ自動変更され、開始時刻は変わらず、即時に6,500円で再見積りされる', async function () {
    var ctx = await packReady();
    ctx.setDuration(hours);
    await flushPromises();
    await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
    ctx.setPeople('2名');
    assert.strictEqual(ctx.elements['ba-plan-shower-pack'].disabled, false, '時間が4時間でなくても、他の条件を満たせばチェックできる');
    assert.ok(/4時間に変更/.test(packNote(ctx)), '4時間へ変更することを事前に案内する');

    ctx.setBenefit(PACK_ID, true);
    await flushPromises();
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-duration'].value, '4', '利用時間が4時間へ変わる');
    assert.strictEqual(ctx.elements[PACK_ID].checked, true, 'パックの選択は維持される');
    assert.ok(new RegExp('plan=' + PACK).test(lastEstimate(ctx)) && /durationMinutes=240/.test(lastEstimate(ctx)), '4時間・パックで再見積りする: ' + lastEstimate(ctx));
    assert.ok(/6,500/.test(priceText(ctx)), '追加操作なしで6,500円を表示する: ' + priceText(ctx));
    assert.strictEqual(ctx.elements['ba-price-line'].hidden, false);
    /* 開始時刻は維持され、終了時刻だけ4時間後になる。 */
    assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, false, '開始時刻が選択されたまま');
    assert.ok(/10:00〜14:00（4時間）/.test(ctx.elements['ba-price-time'].textContent), '開始10:00・終了14:00: ' + ctx.elements['ba-price-time'].textContent);
  });
});

test('すでに4時間なら追加の確認なしにそのまま6,500円で見積る（従来の挙動）', async function () {
  var ctx = await packReady();
  ctx.setDuration(4);
  await flushPromises();
  await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
  ctx.setPeople('1名');
  var before = ctx.fetchCalls.length;
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-duration'].value, '4');
  assert.ok(/6,500/.test(priceText(ctx)));
  var availabilityCalls = ctx.fetchCalls.slice(before).filter(function (u) { return u.indexOf('action=') === -1; });
  assert.strictEqual(availabilityCalls.length, 0, '空き状況の事前確認は不要');
});

test('開始時刻から4時間確保できない場合は自動変更せず、チェックを外して理由を表示する（利用時間・開始時刻・料金は変えない）', async function () {
  var ctx = await packReady({ availability: function (minutes) { return minutes === 240 ? ['13:00'] : ['10:00', '10:15']; } });
  ctx.setDuration(2);
  await flushPromises();
  await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
  ctx.setPeople('2名');
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-duration'].value, '2', '利用時間は変えない');
  assert.strictEqual(ctx.elements[PACK_ID].checked, false, 'パックは成立させない');
  assert.ok(/10:00開始では4時間を確保できない/.test(packNote(ctx)), packNote(ctx));
  assert.strictEqual(ctx.elements['ba-plan-shower-pack-note'].hidden, false);
  assert.ok(!/6,500/.test(priceText(ctx)), 'パック料金を表示しない: ' + priceText(ctx));
  assert.strictEqual(ctx.elements['ba-step-start-time-next'].disabled, false, '開始時刻の選択も維持される');
});

test('その日に4時間の空きが全く無い場合も自動変更しない（開始時刻が未選択のとき）', async function () {
  var ctx = await packReady({ availability: function (minutes) { return minutes === 240 ? [] : ['10:00']; } });
  ctx.setDuration(3);
  await flushPromises();
  await ctx.pick(SATURDAY_AHEAD);
  await flushPromises();
  ctx.setPeople('2名');
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-duration'].value, '3');
  assert.strictEqual(ctx.elements[PACK_ID].checked, false);
  assert.ok(/4時間を確保できる開始時刻がない/.test(packNote(ctx)), packNote(ctx));
});

test('平日はパックが成立しないため、自動で4時間にせず、理由を表示してチェックを外す', async function () {
  var ctx = await packReady();
  ctx.setDuration(3);
  await flushPromises();
  await pickWithStart(ctx, WEEKDAY_AHEAD, '10:00');
  ctx.setPeople('2名');
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-duration'].value, '3', '平日は4時間へ変えない');
  assert.strictEqual(ctx.elements[PACK_ID].checked, false);
  assert.ok(packNote(ctx).length > 0 && packNote(ctx).indexOf('PLAN_DAY_INVALID') === -1, '利用者向けの文言: ' + packNote(ctx));
});

test('3名以上は自動4時間化の対象外（チェックできず、利用時間も変えない）', async function () {
  var ctx = await packReady();
  ctx.setDuration(3);
  await flushPromises();
  await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
  ctx.setPeople('3名');
  assert.strictEqual(ctx.elements[PACK_ID].disabled, true);
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-duration'].value, '3');
  assert.strictEqual(ctx.elements[PACK_ID].checked, false);
});

test('提供開始前（11月30日以前）の利用日・会員確認前は、パックを選べず自動4時間化もしない', async function () {
  var early = await packReady();
  early.setDuration(3);
  await flushPromises();
  await early.pick(8); /* 2026-11-28（土） */
  early.setPeople('2名');
  assert.strictEqual(early.elements[PACK_ID].disabled, true, '提供開始前');
  early.setBenefit(PACK_ID, true);
  await flushPromises();
  assert.strictEqual(early.elements['ba-duration'].value, '3');
  assert.strictEqual(early.elements[PACK_ID].checked, false);

  var ctx = await ready({ brand: 'mens', generation: 'V1' }); /* 会員確認（UI解除）をしていない */
  ctx.setDuration(3);
  await flushPromises();
  await ctx.pick(SATURDAY_AHEAD);
  ctx.setPeople('2名');
  assert.strictEqual(ctx.elements[PACK_ID].disabled, true, '非会員');
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-duration'].value, '3');
  assert.strictEqual(ctx.elements[PACK_ID].checked, false);
});

test('パックのチェックを外すと通常の自動適用（1〜2名・3時間以上はペアパック）の見積りへ戻る。利用時間は4時間のまま', async function () {
  var ctx = await packReady();
  ctx.setDuration(3);
  await flushPromises();
  await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
  ctx.setPeople('2名');
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  await flushPromises();
  assert.ok(/6,500/.test(priceText(ctx)));
  ctx.setBenefit(PACK_ID, false);
  await flushPromises();
  assert.ok(/plan=member_pair_3h/.test(lastEstimate(ctx)) && /durationMinutes=240/.test(lastEstimate(ctx)), lastEstimate(ctx));
  assert.ok(/6,000/.test(priceText(ctx)) && !/6,500/.test(priceText(ctx)), '既存の自動適用の料金へ戻る: ' + priceText(ctx));
  assert.strictEqual(ctx.elements['ba-duration'].value, '4');
});

test('チェック後に利用時間を4時間以外へ手動で変えると、パックは自動で外れる（成立しない選択を残さない）', async function () {
  var ctx = await packReady();
  ctx.setDuration(3);
  await flushPromises();
  await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
  ctx.setPeople('2名');
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  await flushPromises();
  ctx.setDuration(5);
  await flushPromises();
  assert.strictEqual(ctx.elements[PACK_ID].checked, false);
  assert.ok(!new RegExp('plan=' + PACK).test(lastEstimate(ctx)));
});

test('GAS Web Appが旧版でINVALID_PLANを返す場合は、利用時間を変えずに案内する（4時間化のあと壊れた見積りを残さない）', async function () {
  var ctx = await packReady({ legacyGas: true });
  ctx.setDuration(3);
  await flushPromises();
  await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
  ctx.setPeople('2名');
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-duration'].value, '3');
  assert.strictEqual(ctx.elements[PACK_ID].checked, false);
});

test('チェックの確認中に条件を変えた古い応答は無視する（連打・取り消しで利用時間が勝手に変わらない）', async function () {
  var ctx = await packReady();
  ctx.setDuration(3);
  await flushPromises();
  await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
  ctx.setPeople('2名');
  ctx.setBenefit(PACK_ID, true);
  ctx.elements[PACK_ID].disabled = false; /* 確認中は無効化されるが、テストでは取り消し操作を再現する */
  ctx.setBenefit(PACK_ID, false);
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-duration'].value, '3', '取り消した操作の応答で利用時間を変えない');
  assert.strictEqual(ctx.elements[PACK_ID].checked, false);
});

/* ── V2（メールOTP）: 自動4時間化の成立確認は actual membership を照合する bookingMemberStatus で行う ── */

function v2MemberStatus(member, reverify) {
  return function (body) {
    if (reverify) return { success: false, error: { code: 'MEMBER_REVERIFY_REQUIRED' } };
    var date = new Date(body.date + 'T00:00:00Z').getUTCDay();
    if (body.plan === PACK && !member) return { success: false, error: { code: 'MEMBER_BENEFIT_NOT_AVAILABLE' } };
    if (body.plan === PACK && (date >= 1 && date <= 5)) return { success: false, error: { code: 'PLAN_DAY_INVALID' } };
    return {
      success: true, verified: true, advanceEligible: true, memberOnDate: member, priceGeneration: 'V2', memberAuthRequired: false,
      price: { amount: body.plan === PACK ? 6500 : 9000, tier: 'MEMBER', brand: 'mens', plan: body.plan || '' }
    };
  };
}

async function v2PackReady(member, reverify) {
  var ctx = await ready({ brand: 'mens', generation: 'V2', memberStatus: v2MemberStatus(member, reverify) });
  await ctx.dayButton(1);
  await flushPromises();
  await ctx.verifyMember();
  ctx.setDuration(3);
  await flushPromises();
  await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
  ctx.setPeople('2名');
  return ctx;
}

test('V2・actual membershipあり: bookingMemberStatus（email＋proof＋日付＋240分＋パック＋人数）で成立を確認してから4時間へ変更し、6,500円を表示する', async function () {
  var ctx = await v2PackReady(true);
  var before = ctx.postsOf('bookingMemberStatus').length;
  ctx.setBenefit(PACK_ID, true);
  await flushPromises();
  await flushPromises();
  var preflight = ctx.postsOf('bookingMemberStatus').slice(before)[0].body;
  assert.strictEqual(preflight.plan, PACK);
  assert.strictEqual(preflight.durationMinutes, 240);
  assert.strictEqual(preflight.date, dateAfter(SATURDAY_AHEAD));
  assert.strictEqual(preflight.people, '2名');
  assert.strictEqual(preflight.email, 'taro@example.com');
  assert.strictEqual(preflight.proof, 'P'.repeat(40));
  assert.strictEqual(preflight.autoPairPack, false);
  assert.strictEqual(ctx.elements['ba-duration'].value, '4');
  assert.strictEqual(ctx.elements[PACK_ID].checked, true);
  assert.ok(/6,500/.test(priceText(ctx)), priceText(ctx));
  assert.ok(!ctx.fetchCalls.some(function (u) { return /action=estimatePrice/.test(u) && /plan=mens_weekend_shower_4h/.test(u); }), 'V2では会員確認なしのGET見積りで成立確認しない');
});

[['2', 2], ['3', 3], ['5', 5]].forEach(function (c) {
  test('V2・OTP確認済みでもactual membershipなし: ' + c[0] + '時間のまま変更せず、チェックを外す（MEMBER_BENEFIT_NOT_AVAILABLE）', async function () {
    var ctx = await ready({ brand: 'mens', generation: 'V2', memberStatus: v2MemberStatus(false) });
    await ctx.dayButton(1);
    await flushPromises();
    await ctx.verifyMember();
    ctx.setDuration(c[1]);
    await flushPromises();
    await pickWithStart(ctx, SATURDAY_AHEAD, '10:00');
    ctx.setPeople('2名');
    ctx.setBenefit(PACK_ID, true);
    await flushPromises();
    await flushPromises();
    assert.strictEqual(ctx.elements['ba-duration'].value, String(c[1]), '利用時間は元のまま');
    assert.strictEqual(ctx.elements[PACK_ID].checked, false);
    assert.ok(packNote(ctx).length > 0 && packNote(ctx).indexOf('MEMBER_BENEFIT_NOT_AVAILABLE') === -1, '利用者向けの案内: ' + packNote(ctx));
    assert.ok(!/6,500/.test(priceText(ctx)));
  });
});

test('V2・確認済み証明が無効（MEMBER_REVERIFY_REQUIRED）: 利用時間は変えず、チェックを外して既存の再確認導線へ進む', async function () {
  var reverify = await ready({ brand: 'mens', generation: 'V2', memberStatus: function (body) {
    return body.plan === PACK ? { success: false, error: { code: 'MEMBER_REVERIFY_REQUIRED' } } : v2MemberStatus(true)(body);
  } });
  await reverify.dayButton(1);
  await flushPromises();
  await reverify.verifyMember();
  reverify.setDuration(3);
  await flushPromises();
  await pickWithStart(reverify, SATURDAY_AHEAD, '10:00');
  reverify.setPeople('2名');
  reverify.setBenefit(PACK_ID, true);
  await flushPromises();
  await flushPromises();
  assert.strictEqual(reverify.elements['ba-duration'].value, '3');
  assert.strictEqual(reverify.elements[PACK_ID].checked, false);
});
