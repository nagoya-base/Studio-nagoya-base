/*
 * テスト資格（Issue #559）のフロント側のテスト。
 *
 * - SNB・SNB mens・英語版の各予約ページ: <head>のインライン処理が、gtag設定・page_view送信より前に、URLフラグメント（#bt=...）から資格を取り出して
 *   直ちにURLから除去し、sessionStorageへ保存する（booking-app.js内だけの除去は不可）。
 * - booking-app.js: 資格はカスタムヘッダー・GETクエリに載せず、text/plainのPOST JSON本文だけで送る。資格が必要な月間空き状況・見積りは資格付きPOSTに変え、
 *   通常利用者（資格なし）の既存GETは変えない。期限切れ・失効・メール変更・モード変更で資格を破棄して通常フローへ戻る。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

var ROOT = path.join(__dirname, '..');
var PAGES = ['booking/index.html', 'booking/en.html', 'mens/booking/index.html', 'studio-x/booking/index.html'];
var STORAGE_KEY = 'snbBookingTestCredential';

function tokenWithExpiry(expSeconds) {
  return 't1.' + '0123456789abcdef' + '.' + '1700000000' + '.' + String(expSeconds) + '.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
}

function flushPromises() { return new Promise(function (resolve) { setImmediate(resolve); }); }

// ============================================================================
// <head>のフラグメント取り込み（3ページ）
// ============================================================================

function readPage(page) { return fs.readFileSync(path.join(ROOT, page), 'utf8'); }

function intakeScript(html) {
  var match = /<script id="ba-test-credential-intake">([\s\S]*?)<\/script>/.exec(html);
  return match ? match[1] : '';
}

/* location / history / sessionStorageのスタブでインライン処理を実行する。 */
function runIntake(html, options) {
  var o = options || {};
  var calls = [];
  var stored = {};
  var windowStub = {
    location: { hash: o.hash || '', pathname: '/Studio-nagoya-base/booking/', search: o.search || '' },
    history: {
      state: null,
      replaceState: function (state, title, url) {
        calls.push({ type: 'replaceState', url: url });
        if (o.replaceStateThrows) throw new Error('blocked');
        var hashIndex = url.indexOf('#');
        windowStub.location.hash = hashIndex === -1 ? '' : url.substring(hashIndex);
      }
    },
    sessionStorage: {
      setItem: function (key, value) { calls.push({ type: 'setItem', key: key }); stored[key] = value; },
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null; }
    }
  };
  if (o.sessionStorageThrows) windowStub.sessionStorage.setItem = function () { throw new Error('denied'); };
  vm.runInNewContext(intakeScript(html), { window: windowStub });
  return { window: windowStub, calls: calls, stored: stored };
}

PAGES.forEach(function (page) {
  var html = readPage(page);

  test(page + ': 取り込み処理は<head>内でgtagの読み込み・設定・page_view送信より前に置く', function () {
    var intakeAt = html.indexOf('id="ba-test-credential-intake"');
    var headEnd = html.indexOf('</head>');
    var gtagLoad = html.indexOf('googletagmanager.com/gtag/js');
    var gtagConfig = html.indexOf("gtag('config'");
    assert.ok(intakeAt !== -1, '取り込み処理がある');
    assert.ok(intakeAt < headEnd, '<head>内にある');
    assert.ok(gtagLoad !== -1 && gtagConfig !== -1);
    assert.ok(intakeAt < gtagLoad, 'gtag.jsの読み込みより前');
    assert.ok(intakeAt < gtagConfig, 'gtag設定（page_viewの契機）より前');
    assert.ok(!/<script[^>]*\sasync\b[^>]*id="ba-test-credential-intake"|<script[^>]*id="ba-test-credential-intake"[^>]*\ssrc=/.test(html), '同期のインライン（外部ファイル・asyncにしない）');
    assert.strictEqual((html.match(/id="ba-test-credential-intake"/g) || []).length, 1);
  });

  test(page + ': 有効な形式のフラグメントは直ちにURLから除去し、sessionStorageへ保存する（クエリ・Cookieには載せない）', function () {
    var token = tokenWithExpiry(1900000000);
    var run = runIntake(html, { hash: '#bt=' + token });
    assert.strictEqual(run.window.location.hash, '', 'URLからフラグメントが消える');
    assert.deepStrictEqual(run.calls.map(function (c) { return c.type; }), ['replaceState', 'setItem'], 'URL除去が保存より先');
    assert.strictEqual(run.calls[0].url, '/Studio-nagoya-base/booking/', 'パス・クエリは維持し、資格を含まない');
    assert.strictEqual(run.stored[STORAGE_KEY], token);
    assert.ok(run.calls.every(function (c) { return !c.url || c.url.indexOf(token) === -1; }), 'URLに資格を残さない');
    assert.ok(!/document\.cookie|localStorage|dataLayer|gtag\(/.test(intakeScript(html)), 'Cookie・localStorage・分析へ送らない');
  });

  test(page + ': 他のフラグメントやクエリは保持し、btだけ除去する。形式不正の資格は保存しないがURLからは除去する', function () {
    var token = tokenWithExpiry(1900000000);
    var mixed = runIntake(html, { hash: '#main-content&bt=' + token, search: '?debug_mode=true' });
    assert.strictEqual(mixed.calls[0].url, '/Studio-nagoya-base/booking/?debug_mode=true#main-content');
    assert.strictEqual(mixed.stored[STORAGE_KEY], token);

    var invalid = runIntake(html, { hash: '#bt=not-a-valid-token' });
    assert.strictEqual(invalid.window.location.hash, '');
    assert.strictEqual(invalid.stored[STORAGE_KEY], undefined, '不正な形式は保存しない');

    var plainAnchor = runIntake(html, { hash: '#main-content' });
    assert.deepStrictEqual(plainAnchor.calls, [], '資格が無い通常のアンカーには何もしない');
    assert.strictEqual(plainAnchor.window.location.hash, '#main-content');
    assert.deepStrictEqual(runIntake(html, { hash: '' }).calls, [], 'フラグメント無しは何もしない');
  });

  test(page + ': replaceStateが使えなくてもフラグメントを空にし、保存先が使えなくても例外にしない', function () {
    var token = tokenWithExpiry(1900000000);
    var fallback = runIntake(html, { hash: '#bt=' + token, replaceStateThrows: true });
    assert.strictEqual(fallback.window.location.hash, '', 'フォールバックでも資格をURLに残さない');
    assert.doesNotThrow(function () { runIntake(html, { hash: '#bt=' + token, sessionStorageThrows: true }); });
  });
});

// ============================================================================
// booking-app.js
// ============================================================================

var FIXED_NOW_MS = Date.parse('2026-11-20T03:00:00Z'); /* 2026-11-20 12:00 JST */
var NOW_SECONDS = Math.floor(FIXED_NOW_MS / 1000);
var TODAY = '2026-11-20';

function pad2(n) { return (n < 10 ? '0' : '') + n; }

function monthlyBody(year, month, generation, extra) {
  var days = {};
  var total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (var d = 1; d <= total; d++) {
    var dateValue = year + '-' + pad2(month) + '-' + pad2(d);
    var ahead = Math.round((Date.parse(dateValue + 'T00:00:00Z') - Date.parse(TODAY + 'T00:00:00Z')) / 86400000);
    if (ahead < 0 || ahead > 90) days[dateValue] = { status: 'OUT_OF_RANGE' };
    else if (ahead > 30) days[dateValue] = { status: 'AVAILABLE', availableStartTimes: 8, memberAdvance: true };
    else days[dateValue] = { status: 'AVAILABLE', availableStartTimes: 8 };
  }
  return Object.assign({ success: true, month: year + '-' + pad2(month), days: days, priceGeneration: generation }, extra || {});
}

function createElement(id) {
  var listeners = {};
  var attrs = {};
  var el = {
    id: id, hidden: true, disabled: false, checked: false, value: '',
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

/*
 * opts.brand: 'snb' | 'mens' | 'studio_x'
 * opts.credential: 起動時にsessionStorageへ入れておく資格（取り込み処理が保存した状態）
 * opts.initialEmail: メール欄の初期値（既定は空＝資格を結び付ける前）
 * opts.respond(url, body): 資格付きPOST（testMonthly / testEstimatePrice）の応答を返す関数
 */
function setup(opts) {
  opts = opts || {};
  var brand = opts.brand || 'snb';
  var elements = {};
  var requests = [];
  var storage = {};
  if (opts.credential) storage[STORAGE_KEY] = opts.credential;

  function FakeDate() {
    var args = Array.prototype.slice.call(arguments);
    if (!(this instanceof FakeDate)) return new Date(FIXED_NOW_MS).toString();
    return args.length === 0 ? new Date(FIXED_NOW_MS + clockOffsetMs) : new (Function.prototype.bind.apply(Date, [null].concat(args)))();
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
    return null;
  };
  elements['booking-app'] = root;
  elements['ba-duration'] = createElement('ba-duration');
  elements['ba-duration'].value = '3';
  elements['ba-email'] = createElement('ba-email');
  elements['ba-email'].value = opts.initialEmail || '';
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
  var windowStub = {
    BookingApiConfig: { BASE_URL: 'https://example.invalid/exec' },
    sessionStorage: {
      getItem: function (key) { return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null; },
      setItem: function (key, value) { storage[key] = value; },
      removeItem: function (key) { delete storage[key]; }
    }
  };

  function fetchStub(url, options) {
    var method = (options && options.method) || 'GET';
    var request = { url: url, method: method, headers: (options && options.headers) || {}, body: options && options.body ? JSON.parse(options.body) : null, rawBody: options && options.body };
    requests.push(request);
    var body;
    if (url.indexOf('action=testMonthly') !== -1 || url.indexOf('action=testEstimatePrice') !== -1) {
      body = opts.respond ? opts.respond(url, request.body) : null;
    } else if (url.indexOf('action=monthly') !== -1) {
      body = monthlyBody(Number(/[?&]year=(\d+)/.exec(url)[1]), Number(/[?&]month=(\d+)/.exec(url)[1]), opts.generationOf ? opts.generationOf() : 'V1', opts.monthlyExtra ? opts.monthlyExtra() : undefined);
    } else if (url.indexOf('action=requestBookingMemberCode') !== -1) {
      body = { success: true, message: 'sent' };
    } else if (url.indexOf('action=estimatePrice') !== -1) {
      body = { success: true, priceGeneration: 'V1', price: { amount: 6600, tier: 'GENERAL', brand: brand, plan: '' } };
    } else if (url.indexOf('action=optionCatalog') !== -1) {
      body = { success: true, catalog: { enabled: true, showerOnly: true, shower: { code: 'SHOWER', priceJpy: 1000 } } };
    } else {
      body = { success: true, bookableStartTimes: ['10:00', '10:15'] };
    }
    return Promise.resolve({ json: function () { return Promise.resolve(body); } });
  }

  loadFrontendSandbox(['booking-logic.js', 'booking-app.js'], {
    document: documentStub, window: windowStub, fetch: fetchStub, Date: FakeDate
  });

  var ctx = {
    elements: elements, requests: requests, storage: storage,
    advanceClock: function (ms) { clockOffsetMs += ms; },
    postsTo: function (action) { return requests.filter(function (r) { return r.method === 'POST' && r.url.indexOf('action=' + action) !== -1; }); },
    gets: function (action) { return requests.filter(function (r) { return r.method === 'GET' && r.url.indexOf('action=' + action) !== -1; }); },
    /* メール欄を入力して確定する（入力中のinputイベント → 確定のchangeイベント）。 */
    enterEmail: async function (value) {
      elements['ba-email'].value = value;
      elements['ba-email']._listeners.input();
      elements['ba-email']._listeners.change();
      await flushPromises();
      await flushPromises();
    },
    typeEmail: async function (value) {
      elements['ba-email'].value = value;
      elements['ba-email']._listeners.input();
      await flushPromises();
      await flushPromises();
    },
    globalError: function () {
      var el = elements['ba-global-error-message'];
      return el ? el.textContent : '';
    }
  };
  return ctx;
}

async function ready(opts) {
  var ctx = setup(opts);
  await flushPromises();
  return ctx;
}

function v2Responder(extra) {
  return function (url, body) {
    if (url.indexOf('action=testMonthly') !== -1) {
      return monthlyBody(Number(body.year), Number(body.month), 'V2', Object.assign({ testCredentialStatus: 'VALID' }, extra || {}));
    }
    return { success: true, priceGeneration: 'V2', price: { amount: 6600, tier: 'GENERAL', brand: 'snb', plan: '' }, testCredentialStatus: 'VALID' };
  };
}

var VALID_TOKEN = tokenWithExpiry(NOW_SECONDS + 3600);

test('資格なしの通常利用者: 月間空き状況・見積りは従来どおりGET。資格付きPOSTは一切送らない', async function () {
  var ctx = await ready({ brand: 'snb' });
  await ctx.enterEmail('taro@example.com');
  assert.ok(ctx.gets('monthly').length >= 1);
  assert.strictEqual(ctx.postsTo('testMonthly').length, 0);
  assert.strictEqual(ctx.postsTo('testEstimatePrice').length, 0);
  ctx.requests.forEach(function (r) {
    assert.ok(r.url.indexOf('testCredential') === -1 && r.url.indexOf('t1.') === -1, 'URLに資格を載せない: ' + r.url);
  });
});

test('資格あり・メール未入力の間は通常のGET（資格はメールに結び付いて初めて送る）。URLにも資格を載せない', async function () {
  var ctx = await ready({ brand: 'snb', credential: VALID_TOKEN, respond: v2Responder() });
  assert.ok(ctx.gets('monthly').length >= 1, '起動時の取得は通常GET');
  assert.strictEqual(ctx.postsTo('testMonthly').length, 0);
  assert.strictEqual(ctx.storage[STORAGE_KEY], VALID_TOKEN, '資格はsessionStorageに保持');
});

test('資格あり・メール確定後: 月間空き状況は資格付きPOST（本文JSON・Content-Type: text/plain）。ヘッダー・URLクエリに資格を載せない', async function () {
  var ctx = await ready({ brand: 'snb', credential: VALID_TOKEN, respond: v2Responder() });
  await ctx.enterEmail('admin@example.com');
  var posts = ctx.postsTo('testMonthly');
  assert.ok(posts.length >= 1, '資格付きPOSTで取り直す');
  var post = posts[posts.length - 1];
  assert.strictEqual(post.headers['Content-Type'], 'text/plain;charset=utf-8');
  assert.deepStrictEqual(Object.keys(post.headers), ['Content-Type'], 'カスタムヘッダーを付けない');
  assert.strictEqual(post.body.testCredential, VALID_TOKEN, '資格はPOST本文のJSONに入れる');
  assert.strictEqual(post.body.email, 'admin@example.com');
  assert.strictEqual(post.body.brand, 'snb');
  assert.strictEqual(typeof post.body.year, 'string');
  assert.strictEqual(post.url.indexOf(VALID_TOKEN), -1);
  assert.ok(!/[?&](testCredential|email)=/.test(post.url), 'URLクエリに資格・メールを載せない');
  /* モード・世代をクライアントから送らない。 */
  assert.deepStrictEqual(Object.keys(post.body).sort(), ['brand', 'durationMinutes', 'email', 'month', 'testCredential', 'timeBand', 'year']);
  ctx.requests.forEach(function (r) {
    assert.strictEqual(r.url.indexOf(VALID_TOKEN), -1, 'どのリクエストのURLにも資格を含めない');
    if (r.method === 'GET') assert.ok(r.url.indexOf('testCredential') === -1);
  });
  /* 資格付きGETは存在しない（資格が必要な経路はPOSTへ）。 */
  assert.ok(ctx.requests.every(function (r) { return r.method === 'POST' || r.rawBody === undefined; }));
  /* サーバーがV2を返したので、V2のUI（会員確認欄）に切り替わる。 */
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, false);
  assert.strictEqual(ctx.storage[STORAGE_KEY], VALID_TOKEN, '有効な間は保持');
});

test('資格あり: 見積りも資格付きPOST（testEstimatePrice）。会員料金の見積り（bookingMemberStatus）にも資格を本文で渡す設計', async function () {
  var source = fs.readFileSync(path.join(ROOT, 'scripts', 'booking-app.js'), 'utf8');
  assert.ok(/postApi_\('testEstimatePrice'/.test(source));
  assert.ok(/memberStatusPayload\.testCredential = credentialBody\.testCredential/.test(source));
  assert.ok(/postApi_\('testMonthly'/.test(source));
  /* 資格はURLを組み立てる関数（GET）へ渡さない。 */
  var urlFunctions = source.match(/function (calendarMonthlyUrl_|priceEstimateUrl_)[\s\S]*?\n  }\n/g) || [];
  assert.strictEqual(urlFunctions.length, 2);
  urlFunctions.forEach(function (body) { assert.ok(!/testCredential|credential/i.test(body)); });
});

test('サーバーがINVALIDを返したら（期限切れ・失効・モード変更・メール不一致）資格を破棄し、通常フローへ戻して日程の選び直しを案内する', async function () {
  var ctx = await ready({
    brand: 'snb', credential: VALID_TOKEN,
    respond: function (url, body) {
      return monthlyBody(Number(body.year), Number(body.month), 'V1', { testCredentialStatus: 'INVALID' });
    }
  });
  await ctx.enterEmail('admin@example.com');
  assert.strictEqual(ctx.storage[STORAGE_KEY], undefined, 'sessionStorageから破棄');
  assert.ok(/テスト用の資格が無効/.test(ctx.globalError()), '黙って変えず、案内を出す');
  var before = ctx.postsTo('testMonthly').length;
  await ctx.enterEmail('admin2@example.com');
  assert.strictEqual(ctx.postsTo('testMonthly').length, before, '破棄後は資格付きPOSTを送らない');
  assert.ok(ctx.gets('monthly').length >= 2, '通常のGETで取り直す');
});

test('メールアドレスを変更したら資格を破棄する（結び付けた後に別のメールへ）', async function () {
  var ctx = await ready({ brand: 'snb', credential: VALID_TOKEN, respond: v2Responder() });
  await ctx.enterEmail('admin@example.com');
  assert.strictEqual(ctx.storage[STORAGE_KEY], VALID_TOKEN);
  await ctx.typeEmail('someone-else@example.com');
  assert.strictEqual(ctx.storage[STORAGE_KEY], undefined);
  assert.ok(/テスト用の資格が無効/.test(ctx.globalError()));
  var posts = ctx.postsTo('testMonthly').length;
  await ctx.enterEmail('someone-else@example.com');
  assert.strictEqual(ctx.postsTo('testMonthly').length, posts, '破棄後は通常のGETだけ');
});

test('端末の時計で資格の期限が切れていたら、リクエストを送らずに破棄する。期限切れの資格は起動時にも読み込まない', async function () {
  var expired = await ready({ brand: 'snb', credential: tokenWithExpiry(NOW_SECONDS - 10), respond: v2Responder() });
  await expired.enterEmail('admin@example.com');
  assert.strictEqual(expired.postsTo('testMonthly').length, 0);
  assert.strictEqual(expired.storage[STORAGE_KEY], undefined, '起動時に破棄');

  var ctx = await ready({ brand: 'snb', credential: VALID_TOKEN, respond: v2Responder() });
  await ctx.enterEmail('admin@example.com');
  var before = ctx.postsTo('testMonthly').length;
  ctx.advanceClock(2 * 3600 * 1000);
  await ctx.typeEmail('admin@example.com');
  ctx.elements['ba-calendar-next']._listeners.click();
  await flushPromises();
  assert.strictEqual(ctx.postsTo('testMonthly').length, before, '期限切れの資格は送らない');
  assert.strictEqual(ctx.storage[STORAGE_KEY], undefined);
});

test('INACTIVE（12/1以降など資格が不要）は黙って破棄し、案内は出さない', async function () {
  var ctx = await ready({
    brand: 'snb', credential: VALID_TOKEN,
    respond: function (url, body) { return monthlyBody(Number(body.year), Number(body.month), 'V2', { testCredentialStatus: 'INACTIVE' }); }
  });
  await ctx.enterEmail('admin@example.com');
  assert.strictEqual(ctx.storage[STORAGE_KEY], undefined);
  assert.ok(!/テスト用の資格/.test(ctx.globalError()));
});

test('一般利用者が11/30から12/1へフォームを開いたまま境界をまたぐ挙動は現行mainから変えない（資格の案内・破棄・POSTは出ない）', async function () {
  var generation = 'V1';
  var ctx = await ready({ brand: 'snb', generationOf: function () { return generation; } });
  await ctx.enterEmail('taro@example.com');
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, true, '境界前はV1のUI');
  generation = 'V2';
  ctx.elements['ba-calendar-next']._listeners.click();
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, false, 'サーバーの世代がV2になったら従来どおりV2のUIへ切り替わる');
  assert.ok(!/テスト用の資格/.test(ctx.globalError()), 'テスト資格の案内は一般利用者に出さない');
  assert.strictEqual(ctx.postsTo('testMonthly').length, 0);
  assert.strictEqual(ctx.postsTo('testEstimatePrice').length, 0);
});

test('Studio X（Issue #563）は資格を読み込み、資格付きPOST（testMonthly）で認証フェーズTESTを試せる。壊れた値の場合は資格を読み込まない（通常のGETのみ）', async function () {
  var studioX = await ready({ brand: 'studio_x', credential: VALID_TOKEN, respond: v2Responder() });
  await studioX.enterEmail('admin@example.com');
  assert.ok(studioX.postsTo('testMonthly').length >= 1);
  assert.strictEqual(studioX.postsTo('testMonthly')[0].body.brand, 'studio_x');

  var broken = await ready({ brand: 'snb', credential: 'not-a-credential', respond: v2Responder() });
  await broken.enterEmail('admin@example.com');
  assert.strictEqual(broken.postsTo('testMonthly').length, 0);
  assert.strictEqual(broken.storage[STORAGE_KEY], undefined, '形式不正は破棄');
});

test('createBookingのペイロード: 資格はPOST本文（JSON）だけ。保持していなければキー自体を付けない。モード・世代は送らない', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  var base = { brand: 'snb', customerType: 'returning', date: '2026-12-14', startTime: '10:00', durationMinutes: 180, name: 'a', email: 'admin@example.com', phone: '', people: '2名', purpose: '緊縛・ロープ表現の自主練習', paymentMethod: '現金', note: '' };
  var withCredential = Logic.buildCreateBookingPayload(Object.assign({}, base, { testCredential: VALID_TOKEN }));
  assert.strictEqual(withCredential.testCredential, VALID_TOKEN);
  var without = Logic.buildCreateBookingPayload(base);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(without, 'testCredential'), false, '通常のペイロードは1バイトも変わらない');
  ['', null, undefined, 123].forEach(function (value) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(Logic.buildCreateBookingPayload(Object.assign({}, base, { testCredential: value })), 'testCredential'), false);
  });
  ['mode', 'priceGeneration', 'generation', 'authMode', 'testMode'].forEach(function (key) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(withCredential, key), false, key + 'を送らない');
  });
  var source = fs.readFileSync(path.join(ROOT, 'scripts', 'booking-app.js'), 'utf8');
  assert.ok(/testCredential: \(function \(\) \{ var body = activeTestCredentialBody_\(\); return body \? body\.testCredential : ''; \}\)\(\)/.test(source), '送信時に結び付いた資格だけを付ける');
});

test('TEST_CREDENTIAL_INVALID: メッセージ（ja / en）があり、送信時の拒否は資格を破棄して通常フローへ戻す配線になっている', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  assert.ok(/テスト用の資格が無効/.test(Logic.messageForErrorCode('TEST_CREDENTIAL_INVALID', 'ja')));
  assert.ok(/test credential is no longer valid/.test(Logic.messageForErrorCode('TEST_CREDENTIAL_INVALID', 'en')));
  var source = fs.readFileSync(path.join(ROOT, 'scripts', 'booking-app.js'), 'utf8');
  assert.ok(/if \(code === 'TEST_CREDENTIAL_INVALID'\) \{\s*handleTestCredentialLost_\(\);\s*return;\s*\}/.test(source));
});

test('booking-app.jsはURLフラグメントから資格を受け取らない（取り込み・除去は<head>のインライン処理に限る）。資格をログ・分析へ出さない', function () {
  var source = fs.readFileSync(path.join(ROOT, 'scripts', 'booking-app.js'), 'utf8');
  var code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/bt=|#bt|snbBookingTestCredential.*location|gtag\(|dataLayer|console\./.test(code), 'フラグメントの資格処理・分析・consoleに資格を出さない');
  assert.ok(!/setItem/.test(code), '資格を書き込むのは<head>のインライン処理だけ（booking-app.jsは読み取り・破棄のみ）');
});

// ============================================================================
// Studio X（Issue #563）: 料金世代V2とは独立に、サーバーが認証フェーズ（OTP）を返したときだけ会員確認UIへ切り替わる
// ============================================================================

test('Studio X・切替前（サーバーがmemberAuthRequiredを返さない）: V2料金でも会員確認欄は出さず、31〜90日先は現状どおり（最終判定はサーバーの台帳照合）', async function () {
  var ctx = await ready({ brand: 'studio_x', generationOf: function () { return 'V2'; } });
  await ctx.enterEmail('taro@example.com');
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, true, '切替前はOTP欄を出さない');
  assert.strictEqual(ctx.postsTo('requestBookingMemberCode').length, 0);
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  assert.strictEqual(Logic.usesMemberOtp('studio_x', 'V2', false), false);
  assert.strictEqual(Logic.usesMemberOtp('studio_x', 'V2', undefined), false);
});

test('Studio X・正式V2（memberAuthRequired=true）: 会員確認欄が出て、確認コード送信にbrandを付ける。資格が無ければtestCredentialは付けない', async function () {
  var ctx = await ready({ brand: 'studio_x', generationOf: function () { return 'V2'; }, monthlyExtra: function () { return { memberAuthRequired: true }; } });
  await ctx.enterEmail('taro@example.com');
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, false, 'OTPフェーズでは会員確認欄を出す');
  ctx.elements['ba-member-code-send']._listeners.click();
  await flushPromises();
  await flushPromises();
  var posts = ctx.postsTo('requestBookingMemberCode');
  assert.strictEqual(posts.length, 1);
  assert.deepStrictEqual(posts[0].body, { email: 'taro@example.com', brand: 'studio_x' });
});

test('Studio X・TESTフェーズ: 資格付きPOSTがOTP必須を返したら会員確認欄を出し、確認コード送信にも資格を本文で付ける', async function () {
  var ctx = await ready({
    brand: 'studio_x', credential: VALID_TOKEN,
    respond: v2Responder({ memberAuthRequired: true })
  });
  await ctx.enterEmail('admin@example.com');
  assert.ok(ctx.postsTo('testMonthly').length >= 1);
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, false);
  ctx.elements['ba-member-code-send']._listeners.click();
  await flushPromises();
  await flushPromises();
  var post = ctx.postsTo('requestBookingMemberCode')[0];
  assert.strictEqual(post.body.testCredential, VALID_TOKEN, '資格はPOST本文だけ');
  assert.strictEqual(post.body.brand, 'studio_x');
  assert.strictEqual(post.url.indexOf(VALID_TOKEN), -1);
});

test('Studio X・OTPが不要に戻ったら（切戻し）会員確認欄を隠す。SNBのコード送信ペイロードは従来どおりbrandを付けない', async function () {
  var phase = { memberAuthRequired: true };
  var ctx = await ready({ brand: 'studio_x', generationOf: function () { return 'V2'; }, monthlyExtra: function () { return phase; } });
  await ctx.enterEmail('taro@example.com');
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, false);
  phase = { memberAuthRequired: false };
  ctx.elements['ba-calendar-next']._listeners.click();
  await flushPromises();
  await flushPromises();
  assert.strictEqual(ctx.elements['ba-member-verify-field'].hidden, true, '切戻しで台帳照合の導線へ戻る');

  var snb = await ready({ brand: 'snb', generationOf: function () { return 'V2'; } });
  await snb.enterEmail('taro@example.com');
  snb.elements['ba-member-code-send']._listeners.click();
  await flushPromises();
  await flushPromises();
  assert.deepStrictEqual(snb.postsTo('requestBookingMemberCode')[0].body, { email: 'taro@example.com' });
});

test('Studio Xの文言: エラー・カレンダー表示・確認UIに「SNB MEMBER」を出さない（SNBは従来どおり）', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  ['ja', 'en'].forEach(function (locale) {
    ['MEMBER_VERIFICATION_REQUIRED', 'MEMBER_REVERIFY_REQUIRED', 'ADVANCE_BOOKING_MEMBER_ONLY', 'MEMBER_BENEFIT_NOT_AVAILABLE'].forEach(function (code) {
      var studioX = Logic.messageForErrorCode(code, locale, 'studio_x');
      assert.ok(studioX && !/SNB MEMBER/.test(studioX), code + '/' + locale + ': Studio Xに SNB MEMBER を出さない');
    });
    assert.ok(!/SNB MEMBER/.test(Logic.dayAriaLabel('2026-12-20', 'AVAILABLE', 'returning', '2026-11-20', locale, true, 'studio_x')));
  });
  assert.ok(/SNB MEMBER/.test(Logic.messageForErrorCode('ADVANCE_BOOKING_MEMBER_ONLY', 'ja', 'snb')), 'SNBの文言は変えない');
  assert.ok(/SNB MEMBER/.test(Logic.messageForErrorCode('ADVANCE_BOOKING_MEMBER_ONLY', 'ja')), 'brand未指定は従来どおり');
  assert.ok(/SNB MEMBER先行予約枠/.test(Logic.dayAriaLabel('2026-12-20', 'AVAILABLE', 'returning', '2026-11-20', 'ja', true, 'snb')));
  /* テンプレート: Studio X向けの分岐にSNB MEMBERの文言が混ざらない。 */
  var tpl = readPage('_includes/booking_app_ja.html');
  var legend = /\{% if include\.brand == "studio_x" %\}\s*<legend>([^<]*)<\/legend>/.exec(tpl);
  assert.ok(legend && !/SNB/.test(legend[1]), 'Studio Xの会員確認欄の見出し');
  var calendar = /\{% if include\.brand == "studio_x" %\}\s*<li>([^<]*)<\/li>/.exec(tpl);
  assert.ok(calendar && !/SNB/.test(calendar[1]), 'Studio Xのカレンダー凡例');
});
