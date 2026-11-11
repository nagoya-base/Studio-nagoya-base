/*
 * Issue #895: 利用開始まで30分以下の予約で、入室用暗証番号の案内遅延の注意表示と確認チェックを出す。
 * 判定ロジック（booking-logic.js）、UI配線（booking-app.js）、日英・3ブランドのマークアップを検証する。
 * 受付締切（#885）のロジックには触れないこと、サーバーへ同意を送らないことも確認する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

var RealDate = Date;
function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function flushPromises() { return new Promise(function (resolve) { setImmediate(resolve); }); }
function jst(iso) { return new RealDate(iso + '+09:00').getTime(); }

var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;

/* ── 判定ロジック ── */
test('#895: 残り30:01は対象外、30:00・29:59は対象（秒・ミリ秒の境界）', function () {
  var start = jst('2026-10-10T10:00:00');
  assert.strictEqual(Logic.isShortLeadStart('2026-10-10', '10:00', start - (30 * 60 * 1000 + 1000)), false, '30:01');
  assert.strictEqual(Logic.isShortLeadStart('2026-10-10', '10:00', start - (30 * 60 * 1000 + 1)), false, '30:00.001');
  assert.strictEqual(Logic.isShortLeadStart('2026-10-10', '10:00', start - 30 * 60 * 1000), true, '30:00');
  assert.strictEqual(Logic.isShortLeadStart('2026-10-10', '10:00', start - (30 * 60 * 1000 - 1000)), true, '29:59');
  assert.strictEqual(Logic.isShortLeadStart('2026-10-10', '10:00', start - 31 * 60 * 1000), false, '31:00');
  assert.strictEqual(Logic.isShortLeadStart('2026-10-10', '10:00', start - 5 * 60 * 1000), true, '5:00');
});

test('#895: JST基準・日跨ぎ（23:30 JST → 翌0:00開始は30:00ちょうど）で、端末のタイムゾーンに依存しない', function () {
  assert.strictEqual(Logic.isShortLeadStart('2026-10-11', '00:00', jst('2026-10-10T23:30:00')), true);
  assert.strictEqual(Logic.isShortLeadStart('2026-10-11', '00:00', jst('2026-10-10T23:29:59')), false);
  /* 同じ瞬間をUTCで表しても結果は同じ */
  assert.strictEqual(Logic.isShortLeadStart('2026-10-11', '00:00', RealDate.UTC(2026, 9, 10, 14, 30, 0)), true);
  assert.strictEqual(Logic.isShortLeadStart('2026-10-11', '00:00', RealDate.UTC(2026, 9, 10, 14, 29, 59)), false);
});

test('#895: 不正な日付・時刻はfalse（警告で止めない）', function () {
  var now = jst('2026-10-10T09:00:00');
  assert.strictEqual(Logic.isShortLeadStart('', '10:00', now), false);
  assert.strictEqual(Logic.isShortLeadStart('2026-10-10', '', now), false);
  assert.strictEqual(Logic.isShortLeadStart('2026-10-10', '10:00', NaN), false);
  assert.strictEqual(Logic.isShortLeadStart(null, null, now), false);
});

/* ── UIフロー ── */
function createElement(id) {
  var listeners = {};
  return {
    id: id,
    hidden: true,
    disabled: false,
    checked: id === 'ba-confirm-consent' || id === 'ba-confirm-terms' || id === 'ba-confirm-safety',
    value: id === 'ba-email' ? 'taro@example.com' : '',
    textContent: '',
    innerHTML: '',
    className: '',
    classList: { add: function () {}, remove: function () {} },
    addEventListener: function (name, listener) { listeners[name] = listener; },
    appendChild: function () {},
    focus: function () { this._focusCount = (this._focusCount || 0) + 1; createElement.lastFocused = this; },
    getAttribute: function (name) { return this._attrs ? (this._attrs[name] || null) : null; },
    setAttribute: function (name, value) { this._attrs = this._attrs || {}; this._attrs[name] = String(value); },
    removeAttribute: function (name) { if (this._attrs) delete this._attrs[name]; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    scrollIntoView: function () {},
    _listeners: listeners
  };
}

function setupFlow(opts) {
  opts = opts || {};
  var elements = {};
  var startTimeButtons = [];
  var posts = [];
  var clock = { now: opts.now };

  function FakeDate() {
    if (arguments.length === 0) return new RealDate(clock.now);
    var a = arguments;
    return new RealDate(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
  }
  /* 引数1個（文字列/数値）の場合を正しく扱う */
  function DateProxy(x) {
    if (arguments.length === 0) return new RealDate(clock.now);
    if (arguments.length === 1) return new RealDate(x);
    return FakeDate.apply(null, arguments);
  }
  DateProxy.now = function () { return clock.now; };
  DateProxy.UTC = RealDate.UTC;
  DateProxy.parse = RealDate.parse;
  DateProxy.prototype = RealDate.prototype;

  var root = createElement('booking-app');
  root.getAttribute = function (name) {
    if (name === 'data-brand') return opts.brand || 'snb';
    if (name === 'data-back-url') return '/';
    if (name === 'data-back-label') return null;
    if (name === 'data-locale') return opts.locale || null;
    return null;
  };
  root.querySelectorAll = function () { return []; };
  root.querySelector = function (selector) {
    if (selector === 'input[name="customerType"]:checked') return { value: 'returning' };
    if (selector === 'input[name="paymentMethod"]:checked') return state.paymentMethod ? { value: state.paymentMethod } : null;
    return null;
  };
  var state = { paymentMethod: '' };
  elements['booking-app'] = root;

  var grid = createElement('ba-start-time-grid');
  grid.appendChild = function (child) { startTimeButtons.push(child); };
  elements['ba-start-time-grid'] = grid;

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
    Date: DateProxy,
    fetch: function (url, options) {
      if (url.indexOf('action=estimatePrice') !== -1) {
        return Promise.resolve({ json: function () {
          return Promise.resolve({ success: true, price: { amount: 4000, currency: 'JPY', tier: 'GENERAL', isMember: false, dayType: 'WEEKDAY' } });
        } });
      }
      if (options && options.method === 'POST') {
        posts.push(JSON.parse(options.body));
        return Promise.resolve({ json: function () { return Promise.resolve({ success: true, bookingId: 'TEST-BOOKING', requestId: 'req-1' }); } });
      }
      return Promise.resolve({
        headers: { get: function (n) { return n === 'Date' && opts.serverDate ? opts.serverDate : null; } },
        json: function () { return Promise.resolve({ success: true, bookableStartTimes: opts.times || ['10:00', '11:00'] }); }
      });
    }
  });

  var ctx = {
    elements: elements,
    buttons: startTimeButtons,
    posts: posts,
    setNow: function (ms) { clock.now = ms; },
    el: function (id) { return elements[id]; },
    pickDate: async function () {
      elements['ba-date'].value = opts.date || '2026-10-10';
      elements['ba-duration'].value = '2';
      elements['ba-people'].value = '2名';
      elements['ba-step-datetime-next']._listeners.click();
      await flushPromises();
    },
    select: function (i) { startTimeButtons[i]._listeners.click(); },
    next: function () { elements['ba-step-start-time-next']._listeners.click(); },
    onDetails: function () { return elements['ba-step-details'].hidden === false; },
    fillDetails: function () {
      elements['ba-name'].value = '山田太郎';
      elements['ba-people'].value = '2名';
      elements['ba-purpose'].value = 'セルフ撮影';
      state.paymentMethod = '現金';
      elements['ba-step-details-next']._listeners.click();
    }
  };
  return ctx;
}

var START = jst('2026-10-10T10:00:00');
var MIN = 60 * 1000;

['snb', 'mens', 'studio_x'].forEach(function (brand) {
  [null, 'en'].forEach(function (locale) {
    var tag = '[' + brand + '/' + (locale || 'ja') + '] ';

    test(tag + '#895: 残り31分で選択しても注意・チェックは出ず、そのまま次へ進める', async function () {
      var ctx = setupFlow({ brand: brand, locale: locale, now: START - 31 * MIN });
      await ctx.pickDate();
      ctx.select(0);
      assert.strictEqual(ctx.el('ba-short-lead').hidden, true);
      ctx.next();
      assert.strictEqual(ctx.onDetails(), true);
    });

    test(tag + '#895: 残り30:00で選択すると注意と未チェックの確認欄が出て、未チェックのまま進めず、エラーとフォーカスが出る', async function () {
      var ctx = setupFlow({ brand: brand, locale: locale, now: START - 30 * MIN });
      await ctx.pickDate();
      ctx.select(0);
      assert.strictEqual(ctx.el('ba-short-lead').hidden, false, '注意表示');
      assert.strictEqual(ctx.el('ba-short-lead-check').checked, false, '未チェック');
      ctx.next();
      assert.strictEqual(ctx.onDetails(), false, '進めない');
      assert.strictEqual(ctx.el('ba-short-lead-error').hidden, false, 'インラインエラー');
      assert.ok(ctx.el('ba-short-lead-error').textContent.length > 0);
      assert.strictEqual(ctx.el('ba-short-lead-check').focus && ctx.el('ba-short-lead-check')._focusCount, 1, 'チェック欄へフォーカス');
      assert.strictEqual(ctx.el('ba-short-lead-check').getAttribute('aria-invalid'), 'true');
      /* チェックすると進める */
      ctx.el('ba-short-lead-check').checked = true;
      ctx.el('ba-short-lead-check')._listeners.change();
      assert.strictEqual(ctx.el('ba-short-lead-error').hidden, true, 'チェックでエラー解除');
      ctx.next();
      assert.strictEqual(ctx.onDetails(), true);
    });
  });
});

test('#895: 残り29:59でも（施行前に候補として有効なら）表示される', async function () {
  var ctx = setupFlow({ now: START - 30 * MIN + 1000 });
  await ctx.pickDate();
  ctx.select(0);
  assert.strictEqual(ctx.el('ba-short-lead').hidden, false);
});

test('#895: 受付不可の候補（サーバーが返さない開始時刻）はUIだけで復活させない', async function () {
  /* 10:00開始が残り10分でも、サーバー候補に10:00が無ければボタンは作られず、警告も出ない。 */
  var ctx = setupFlow({ now: START - 10 * MIN, times: ['11:00'] });
  await ctx.pickDate();
  assert.strictEqual(ctx.buttons.length, 1);
  assert.strictEqual(ctx.buttons[0].textContent, '11:00');
  assert.strictEqual(ctx.el('ba-short-lead').hidden, true);
});

test('#895: 31分前に選択→操作中に30分以下になった場合、次へ進む時に再評価して同意を取る', async function () {
  var ctx = setupFlow({ now: START - 31 * MIN });
  await ctx.pickDate();
  ctx.select(0);
  assert.strictEqual(ctx.el('ba-short-lead').hidden, true);
  ctx.setNow(START - 29 * MIN - 30 * 1000);
  ctx.next();
  assert.strictEqual(ctx.onDetails(), false, '進めない');
  assert.strictEqual(ctx.el('ba-short-lead').hidden, false, '注意表示');
  assert.strictEqual(ctx.el('ba-short-lead-error').hidden, false);
  assert.strictEqual(ctx.el('ba-short-lead-check')._focusCount, 1);
});

test('#895: 開始時刻を選び直すとチェックは引き継がれない（対象内→対象内の別時刻・対象外を経由）', async function () {
  var ctx = setupFlow({ now: START - 20 * MIN, times: ['10:00', '10:30', '12:00'] });
  await ctx.pickDate();
  ctx.select(0);
  ctx.el('ba-short-lead-check').checked = true;
  ctx.select(1); /* 10:30（残り50分）は対象外 */
  assert.strictEqual(ctx.el('ba-short-lead').hidden, true);
  assert.strictEqual(ctx.el('ba-short-lead-check').checked, false, '対象外でリセット');
  ctx.select(0);
  assert.strictEqual(ctx.el('ba-short-lead-check').checked, false, '再選択で未チェック');
  assert.strictEqual(ctx.el('ba-short-lead').hidden, false);
});

test('#895: 日付変更（再検索）でチェックと表示がリセットされる', async function () {
  var ctx = setupFlow({ now: START - 20 * MIN });
  await ctx.pickDate();
  ctx.select(0);
  ctx.el('ba-short-lead-check').checked = true;
  ctx.el('ba-date').value = '2026-10-12';
  ctx.el('ba-step-datetime-next')._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.el('ba-short-lead').hidden, true);
  assert.strictEqual(ctx.el('ba-short-lead-check').checked, false);
});

test('#895: 画面を戻ってStep1へ戻ると、古い同意は流用せず再確認になる', async function () {
  var ctx = setupFlow({ now: START - 25 * MIN });
  await ctx.pickDate();
  ctx.select(0);
  ctx.el('ba-short-lead-check').checked = true;
  ctx.next();
  assert.strictEqual(ctx.onDetails(), true);
  ctx.el('ba-step-details-back') && ctx.el('ba-step-details-back')._listeners.click && ctx.el('ba-step-details-back')._listeners.click();
  assert.strictEqual(ctx.el('ba-step-datetime').hidden, false, 'Step1へ戻る');
  assert.strictEqual(ctx.el('ba-short-lead-check').checked, false);
  assert.strictEqual(ctx.el('ba-short-lead').hidden, false);
  ctx.next();
  assert.strictEqual(ctx.onDetails(), false, '再チェックまで進めない');
});

test('#895: ページを開いたまま時間が経過した場合も、最終送信時に再評価して送信せずチェック欄へ戻す', async function () {
  var ctx = setupFlow({ now: START - 32 * MIN });
  await ctx.pickDate();
  ctx.select(0);
  ctx.next();
  assert.strictEqual(ctx.onDetails(), true);
  ctx.fillDetails();
  assert.strictEqual(ctx.el('ba-step-confirm').hidden, false, '確認画面');
  ctx.setNow(START - 29 * MIN);
  ctx.el('ba-confirm-consent').checked = true;
  ctx.el('ba-submit')._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.posts.length, 0, '送信しない');
  assert.strictEqual(ctx.el('ba-step-datetime').hidden, false, 'Step1へ戻す');
  assert.strictEqual(ctx.el('ba-short-lead').hidden, false);
  assert.strictEqual(ctx.el('ba-short-lead-error').hidden, false);
  assert.ok(ctx.el('ba-short-lead-check')._focusCount >= 1, 'チェック欄へフォーカス');
  assert.strictEqual(createElement.lastFocused, ctx.el('ba-short-lead-check'), '最後にフォーカスされるのはチェック欄（global errorではない）');
  assert.strictEqual(ctx.el('ba-global-error').hidden, false);
});

test('#895: 確認済みで30分以下の予約は送信でき、二重クリックでも1回だけ送信され、同意はAPIペイロードに含めない', async function () {
  var ctx = setupFlow({ now: START - 25 * MIN });
  await ctx.pickDate();
  ctx.select(0);
  ctx.el('ba-short-lead-check').checked = true;
  ctx.next();
  assert.strictEqual(ctx.onDetails(), true);
  ctx.fillDetails();
  ctx.el('ba-confirm-consent').checked = true;
  ctx.el('ba-submit')._listeners.click();
  ctx.el('ba-submit')._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.posts.length, 1, '二重送信しない');
  assert.ok(!JSON.stringify(ctx.posts[0]).match(/shortLead|short-lead|ack/i), '同意はサーバーへ送らない');
});

test('#895: 30分超の予約は従来どおりチェックなしで送信できる（回帰なし）', async function () {
  var ctx = setupFlow({ now: START - 90 * MIN });
  await ctx.pickDate();
  ctx.select(0);
  ctx.next();
  ctx.fillDetails();
  ctx.el('ba-confirm-consent').checked = true;
  ctx.el('ba-submit')._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.posts.length, 1);
});

test('#895: 端末時計が遅れていても、取得できればavailability応答のDateヘッダーで補正して判定する', async function () {
  /* 端末は残り40分と見ているが、サーバー時刻では残り25分。 */
  var ctx = setupFlow({ now: START - 40 * MIN, serverDate: new RealDate(START - 25 * MIN).toUTCString() });
  await ctx.pickDate();
  ctx.select(0);
  assert.strictEqual(ctx.el('ba-short-lead').hidden, false);
});

test('#895: Dateヘッダーが取れない場合は端末時刻で判定し、例外にならない', async function () {
  var ctx = setupFlow({ now: START - 40 * MIN });
  await ctx.pickDate();
  ctx.select(0);
  assert.strictEqual(ctx.el('ba-short-lead').hidden, true);
});

/* ── マークアップ（日英・全ブランド共通部品） ── */
[['ja', '_includes/booking_app_ja.html',
  ['入室用の暗証番号のご案内について', '利用開始まで30分以内のご予約は、入室用の暗証番号のご案内が開始直前になる場合があります。', '上記を確認しました', '暗証番号は予約確定後、別メールでお送りします。']],
 ['en', '_includes/booking_app_en.html',
  ['About your entry PIN', 'within 30 minutes', 'I have read the above', 'separate email']]].forEach(function (c) {
  var html = read(c[1]);
  test(c[0] + ': #895 注意文・確認チェックは開始時刻エリア内に条件付き（hidden既定）で置かれ、冒頭には常時表示されない', function () {
    c[2].forEach(function (w) { assert.ok(html.indexOf(w) !== -1, w); });
    var areaStart = html.indexOf('id="ba-start-time-area"');
    var leadPos = html.indexOf('id="ba-short-lead"');
    var memberPos = html.indexOf('id="ba-member-field"');
    assert.ok(leadPos > areaStart && leadPos < memberPos, '開始時刻エリア内');
    assert.match(html, /id="ba-short-lead"[^>]*\bhidden\b/, '既定は非表示');
    assert.match(html, /<input type="checkbox" id="ba-short-lead-check"/, 'ネイティブcheckbox');
    assert.match(html, /<label[^>]*>\s*<input type="checkbox" id="ba-short-lead-check"[\s\S]*?<\/label>/, 'labelで関連づけ');
    assert.match(html, /aria-describedby="ba-short-lead-text ba-short-lead-error"/);
    assert.match(html, /id="ba-short-lead-error"[^>]*role="alert"/);
  });
});

test('#895: ブランド別コピペ実装を避け、3ブランドは同じ共通部品（includes）を使う', function () {
  ['booking/index.html', 'mens/booking/index.html', 'studio-x/booking/index.html', 'booking/en.html'].forEach(function (f) {
    assert.match(read(f), /booking_app_(ja|en)\.html/, f);
  });
  assert.strictEqual(read('_includes/booking_app_ja.html').split('id="ba-short-lead"').length - 1, 1, 'ja: 1箇所のみ');
  assert.strictEqual(read('_includes/booking_app_en.html').split('id="ba-short-lead"').length - 1, 1, 'en: 1箇所のみ');
});

test('#895: 60分締切・#885の締切ロジックは導入・変更していない（GAS側は無変更）', function () {
  var logic = read('scripts/booking-logic.js');
  assert.ok(logic.indexOf('SHORT_LEAD_NOTICE_MS = 30 * 60 * 1000') !== -1);
  assert.ok(!/60\s*\*\s*60\s*\*\s*1000[^\n]*lead|LEAD_60|lead.*60分/i.test(logic), '60分締切は導入しない');
});
