/*
 * 運営アプリ段階1 フロントエンド（ops-app/frontend/）のテスト（Issue #936）。
 * - 画面ロジックは共通接続契約に対するアダプターだけに依存し、モックで先行検証できること。
 * - 契約の検証関数でバックエンド実応答とモック応答の両方を同じ基準で確認する。
 * - データはすべて架空。実バックエンドには接続しない（結合は別PR）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var contract = require('./helpers/ops-contract');

var ROOT = path.join(__dirname, '..');
var FRONT = path.join(ROOT, 'ops-app', 'frontend');
var C = require(path.join(FRONT, 'ops-client.js'));
var Mock = require(path.join(FRONT, 'mock-adapter.js'));

var NOW = Date.UTC(2026, 11, 1, 2, 0, 0); /* 2026-12-01 11:00 JST */

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function fakeApi(kind) {
  var pending = { list: [], detail: [] };
  return {
    kind: kind,
    pending: pending,
    list: function (p, ok, ng) { pending.list.push({ p: p, ok: ok, ng: ng }); },
    detail: function (id, ok, ng) { pending.detail.push({ id: id, ok: ok, ng: ng }); }
  };
}

function okList(items, at) {
  return { ok: true, contractVersion: 1, fetchedAt: at || '2026-12-01T11:00:00+09:00', todayJst: '2026-12-01',
    applied: { scope: 'upcoming', service: 'all', status: 'all', from: '2026-12-01', to: '2026-12-30', order: 'asc' }, complete: true,
    counts: { matched: items.length, sheetRows: items.length, valid: items.length, issues: 0 },
    serviceStates: [{ service: 'snb_community', label: 'SNB Community', state: 'not_connected' }], notConnectedSelected: false, items: items, issues: [] };
}

function item(over) {
  return Object.assign({ bookingId: 'X', service: 'snb', serviceLabel: 'SNB', status: 'CONFIRMED', statusLabel: '確定', date: '2026-12-02',
    startAt: '2026-12-02T10:00:00+09:00', endAt: '2026-12-02T12:00:00+09:00', phase: 'upcoming', name: '架空', people: 2 }, over || {});
}

function tick() { return new Promise(function (resolve) { setTimeout(resolve, 5); }); }

/* ---- 契約: モック応答 ---- */
test('モック: 全シナリオの応答が共通接続契約を満たし、画面に「モック」と表示される', async function () {
  var scenarios = ['ok', 'empty', 'error', 'not_connected', 'denied'];
  for (var i = 0; i < scenarios.length; i++) {
    var api = Mock.createMockApi({ scenario: scenarios[i], nowMs: NOW });
    var list = await new Promise(function (resolve) { api.list({}, resolve); });
    assert.deepStrictEqual(contract.validateList(list), [], scenarios[i]);
    var detail = await new Promise(function (resolve) { api.detail('MOCK-001', resolve); });
    assert.deepStrictEqual(contract.validateDetail(detail), [], scenarios[i] + ' detail');
  }
  var api2 = Mock.createMockApi({ nowMs: NOW });
  assert.strictEqual(api2.kind, 'mock');
  var ctl = C.createController(api2);
  assert.ok(/モックデータ（架空）/.test(C.renderBanner(ctl.state)));
  var miss = await new Promise(function (resolve) { api2.detail('NOPE', resolve); });
  assert.deepStrictEqual(contract.validateDetail(miss), []);
  assert.strictEqual(miss.error.code, 'NOT_FOUND');
});

test('モック: flaky は初回成功→以降失敗で、古いデータ表示を確認できる', async function () {
  var api = Mock.createMockApi({ scenario: 'flaky', nowMs: NOW });
  var ctl = C.createController(api);
  ctl.load({});
  await tick();
  assert.strictEqual(ctl.state.phase, 'ready');
  ctl.load({});
  await tick();
  assert.strictEqual(ctl.state.phase, 'error');
  assert.strictEqual(ctl.state.stale, true);
  assert.ok(/古いデータ/.test(C.renderBanner(ctl.state)));
});

/* ---- コントローラー ---- */
test('画面: 遅れて返った古い応答が最新結果を上書きしない', function () {
  var a = fakeApi();
  var ctl = C.createController(a);
  ctl.load({ service: 'snb' });
  ctl.load({ service: 'studio_x' });
  a.pending.list[1].ok(okList([item({ bookingId: 'NEW' })], '2026-12-01T12:00:00+09:00'));
  a.pending.list[0].ok(okList([item({ bookingId: 'OLD' })], '2026-12-01T11:00:00+09:00'));
  assert.strictEqual(ctl.state.data.items[0].bookingId, 'NEW');
  assert.strictEqual(ctl.state.lastSuccessAt, '2026-12-01T12:00:00+09:00');
  a.pending.list[0].ng();
  assert.strictEqual(ctl.state.phase, 'ready');
});

test('画面: 失敗は成功/0件にせず、前回データは「古いデータ」と最終成功日時（JST）つきで残す', function () {
  var a = fakeApi(), ctl = C.createController(a);
  ctl.load({});
  a.pending.list[0].ok(okList([item()], '2026-12-01T11:00:00+09:00'));
  assert.ok(/最終取得成功: 2026-12-01 11:00 JST/.test(C.renderBanner(ctl.state)));
  ctl.load({});
  a.pending.list[1].ng();
  assert.strictEqual(ctl.state.phase, 'error');
  assert.strictEqual(ctl.state.stale, true);
  assert.ok(/古いデータ/.test(C.renderBanner(ctl.state)) && /2026-12-01 11:00 JST/.test(C.renderBanner(ctl.state)));
  var b = fakeApi(), ctl2 = C.createController(b);
  ctl2.load({});
  b.pending.list[0].ok({ ok: false, error: { code: 'FETCH_FAILED', message: '取得に失敗' } });
  assert.strictEqual(ctl2.state.phase, 'error');
  assert.ok(!/0件/.test(C.renderView(ctl2.state)));
  var c = fakeApi(), ctl3 = C.createController(c);
  ctl3.load({});
  c.pending.list[0].ok({ ok: false, error: { code: 'NOT_CONNECTED', message: '未接続' } });
  assert.strictEqual(ctl3.state.phase, 'not_connected');
});

test('画面: 認可失敗（UNAUTHENTICATED/FORBIDDEN）では以前の表示も残さず、予約情報を出さない', function () {
  ['UNAUTHENTICATED', 'FORBIDDEN'].forEach(function (code) {
    var a = fakeApi(), ctl = C.createController(a);
    ctl.load({});
    a.pending.list[0].ok(okList([item({ bookingId: 'SHOULD-VANISH' })]));
    ctl.openDetail('SHOULD-VANISH');
    ctl.load({});
    a.pending.list[1].ok({ ok: false, error: { code: code, message: '権限がありません。' } });
    assert.strictEqual(ctl.state.phase, 'denied');
    assert.strictEqual(ctl.state.data, null);
    assert.strictEqual(ctl.state.stale, false);
    var html = C.renderBanner(ctl.state) + C.renderView(ctl.state);
    assert.ok(!/SHOULD-VANISH/.test(html) && /権限がありません/.test(html));
  });
});

test('画面: 正常0件・未接続サービス選択・エスケープ・0と未入力の区別', function () {
  var a = fakeApi(), ctl = C.createController(a);
  ctl.load({});
  a.pending.list[0].ok(okList([]));
  assert.ok(/0件です（取得は正常に完了/.test(C.renderView(ctl.state)));
  var nc = okList([]); nc.notConnectedSelected = true;
  ctl.load({}); a.pending.list[1].ok(nc);
  var view = C.renderView(ctl.state);
  assert.ok(/未接続です。予約が0件という意味ではありません/.test(view) && !/0件です/.test(view));
  ctl.load({});
  a.pending.list[2].ok(okList([item({ bookingId: '"><img src=x onerror=1>', serviceLabel: '<b>', name: '<script>1</script>', people: 0, endAt: null })]));
  var html = C.renderView(ctl.state);
  assert.ok(!/<script>|<img |<b>/.test(html), html);
  assert.ok(/0名/.test(html) && /未入力/.test(html));
});

test('画面: 日時は日本時間で表示し、利用の進行（利用中・終了済み・開始済み終了不明）を区別する', function () {
  assert.strictEqual(C.jstText('2026-12-01T15:30:00Z', true), '2026-12-02 00:30');
  assert.strictEqual(C.jstText('2026-12-02T00:30:00+09:00'), '00:30');
  assert.strictEqual(C.jstText(null), null);
  var a = fakeApi(), ctl = C.createController(a);
  ctl.load({});
  a.pending.list[0].ok(okList([item({ bookingId: 'A', phase: 'in_progress' }), item({ bookingId: 'B', phase: 'ended' }), item({ bookingId: 'C', phase: 'unknown', endAt: null })]));
  var html = C.renderView(ctl.state);
  assert.ok(/利用中/.test(html) && /終了済み/.test(html) && /開始済み（終了不明）/.test(html));
});

test('画面: 詳細を開いたまま再取得すると詳細も取り直し、閉じた後は取得しない。遅延応答は最新のみ採用', function () {
  var a = fakeApi(), ctl = C.createController(a);
  ctl.openDetail('A'); ctl.openDetail('B');
  a.pending.detail[1].ok({ ok: true, reservation: Object.assign(item({ bookingId: 'B' }), { effectivePriceAmount: 0 }) });
  a.pending.detail[0].ok({ ok: true, reservation: item({ bookingId: 'A' }) });
  assert.strictEqual(ctl.state.detail.bookingId, 'B');
  assert.ok(/0円/.test(C.renderView(ctl.state)), '料金0は0円（未計算ではない）');
  ctl.load({});
  assert.strictEqual(a.pending.detail.length, 3);
  assert.strictEqual(ctl.state.detail, null, '取り直し中は古い詳細を表示しない');
  ctl.closeDetail();
  ctl.load({});
  assert.strictEqual(a.pending.detail.length, 3);
});

test('画面: 詳細の重複ID/不存在はバックエンドのメッセージをそのまま表示し、別予約を出さない', function () {
  var a = fakeApi(), ctl = C.createController(a);
  ctl.openDetail('DUP');
  a.pending.detail[0].ok({ ok: false, error: { code: 'DUPLICATE_ID', message: '同じ予約IDの行が複数あるため表示できません。' } });
  assert.strictEqual(ctl.state.detail, null);
  assert.ok(/同じ予約IDの行が複数/.test(C.renderView(ctl.state)));
});

test('画面: 入力は契約の一覧要求へ変換される', function () {
  assert.deepStrictEqual(plain(C.paramsFromInputs({ service: 'all', status: 'all', scope: 'past', from: '2026-01-01', to: '' })), { service: 'all', status: 'all', scope: 'past' });
  assert.deepStrictEqual(plain(C.paramsFromInputs({ service: 'snb', status: 'all', scope: 'custom', from: '2026-12-01', to: '2026-12-05' })), { service: 'snb', status: 'all', scope: 'upcoming', from: '2026-12-01', to: '2026-12-05' });
});

/* ---- フロント×バックエンドの契約適合（同一プロセス内。実ネットワークではない） ---- */
function loadBackend() {
  var sandbox = { Logger: { log: function () {} } };
  vm.createContext(sandbox);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas', 'ops-reservations', f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox;
}

var HEADER = ['bookingId', 'date', 'startAt', 'endAt', 'brand', 'name', 'people', 'status', 'priceAmount'];
function jst(y, m, d, hh, mm) { return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)); }

function loopbackApi(rows, auth) {
  var backend = loadBackend();
  var ctx = { nowMs: NOW, authenticate: function () { return auth || { ok: true }; }, readLedger: function () { return { values: [HEADER].concat(rows) }; } };
  return {
    kind: 'loopback',
    list: function (p, ok) { setTimeout(function () { ok(plain(backend.OpsApi.handle({ op: 'list', params: p }, ctx))); }, 0); },
    detail: function (id, ok) { setTimeout(function () { ok(plain(backend.OpsApi.handle({ op: 'detail', id: id }, ctx))); }, 0); }
  };
}

test('契約適合: バックエンドの実応答（一覧・詳細・各エラー）が共通契約を満たし、フロントがそのまま描画できる', async function () {
  var rows = [
    ['A1', '2026-12-02', jst(2026, 12, 2, 10, 0), jst(2026, 12, 2, 12, 0), 'snb', '架空 一', 2, 'CONFIRMED', 3000],
    ['A2', '2026-12-02', jst(2026, 12, 2, 13, 0), '', 'studio_x', null, 0, 'PENDING', 0],
    ['DUP', '2026-12-03', jst(2026, 12, 3, 9, 0), jst(2026, 12, 3, 10, 0), 'snb', 'x', 1, 'CONFIRMED', 1],
    ['DUP', '2026-12-03', jst(2026, 12, 3, 9, 0), jst(2026, 12, 3, 10, 0), 'snb', 'y', 1, 'CANCELLED', 1],
    ['', '2026-12-04', jst(2026, 12, 4, 9, 0), jst(2026, 12, 4, 10, 0), 'snb', 'z', 1, 'CONFIRMED', 1]
  ];
  var api = loopbackApi(rows);
  var list = await new Promise(function (resolve) { api.list({}, resolve); });
  assert.deepStrictEqual(contract.validateList(list), []);
  assert.deepStrictEqual(plain(list.items.map(function (i) { return i.bookingId; })), ['A1', 'A2']);
  var detail = await new Promise(function (resolve) { api.detail('A1', resolve); });
  assert.deepStrictEqual(contract.validateDetail(detail), []);
  var dup = await new Promise(function (resolve) { api.detail('DUP', resolve); });
  assert.deepStrictEqual(contract.validateError(dup), []);
  assert.strictEqual(dup.error.code, 'DUPLICATE_ID');
  var nf = await new Promise(function (resolve) { api.detail('NOPE', resolve); });
  assert.strictEqual(nf.error.code, 'NOT_FOUND');
  var bad = await new Promise(function (resolve) { api.list({ service: 'x' }, resolve); });
  assert.deepStrictEqual(contract.validateError(bad), []);
  assert.strictEqual(bad.error.code, 'INVALID_PARAMS');
  /* フロント経由の描画 */
  var ctl = C.createController(api);
  ctl.load({});
  await tick();
  var html = C.renderView(ctl.state);
  assert.ok(/A1/.test(html) && /10:00〜12:00/.test(html) && /0名/.test(html));
  assert.ok(/確認が必要な行/.test(html) && /重複/.test(html));
  assert.ok(!/モックデータ/.test(C.renderBanner(ctl.state)));
});

test('契約適合: 認可失敗はバックエンドが予約情報を返さず、フロントは何も表示しない', async function () {
  ['UNAUTHENTICATED', 'FORBIDDEN'].forEach(function () {});
  for (var code of ['UNAUTHENTICATED', 'FORBIDDEN']) {
    var api = loopbackApi([['A1', '2026-12-02', jst(2026, 12, 2, 10, 0), jst(2026, 12, 2, 12, 0), 'snb', 'LEAK', 2, 'CONFIRMED', 3000]], { ok: false, code: code });
    var list = await new Promise(function (resolve) { api.list({}, resolve); });
    assert.deepStrictEqual(contract.validateError(list), []);
    assert.strictEqual(list.error.code, code);
    assert.ok(!/LEAK|A1/.test(JSON.stringify(list)));
    var ctl = C.createController(api);
    ctl.load({});
    await tick();
    assert.strictEqual(ctl.state.phase, 'denied');
    assert.ok(!/LEAK|A1/.test(C.renderBanner(ctl.state) + C.renderView(ctl.state)));
  }
});

/* ---- 静的な境界（フロントとGAS専用アダプターの分離） ---- */
test('境界: フロントはGAS・Sheets・SwitchBotに直接依存せず、秘密情報を持たない。google.script.runはGAS検証画面だけ', function () {
  fs.readdirSync(FRONT).forEach(function (f) {
    var src = fs.readFileSync(path.join(FRONT, f), 'utf8');
    var code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/google\.script|sheets\.googleapis|switchbot|api\.switch-bot|script\.google\.com|SpreadsheetApp|UrlFetchApp/i.test(code), f + 'が通信方式・外部システムに直接依存している');
    assert.ok(!/OPS_OWNER_EMAIL|OPS_SPREADSHEET_ID|Bearer |api[_-]?key|secret|token/i.test(code), f + 'に秘密情報らしき記述がある');
  });
  var gasDir = path.join(ROOT, 'gas', 'ops-reservations');
  var users = fs.readdirSync(gasDir).filter(function (f) {
    var code = fs.readFileSync(path.join(gasDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
    return /google\.script\.run/.test(code);
  });
  assert.deepStrictEqual(users, ['OpsPage.html']);
  var page = fs.readFileSync(path.join(gasDir, 'OpsPage.html'), 'utf8');
  assert.ok(/Sitesフロントではありません/.test(page));
  assert.ok(!/ops-client|OpsClient/.test(page), 'GAS検証画面は画面ロジックを共有・複製しない');
});

test('境界: フロントのモックページは架空・非インデックスで、既存の公開物・workflowから参照されない', function () {
  var index = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  assert.ok(/noindex,nofollow/.test(index) && /架空のモックデータ/.test(index));
  assert.ok(!/---\n/.test(index.slice(0, 5)), 'front matterを含まない');
  var wf = path.join(ROOT, '.github', 'workflows');
  fs.readdirSync(wf).forEach(function (f) {
    assert.ok(!/ops-app/.test(fs.readFileSync(path.join(wf, f), 'utf8')), f + 'がops-appを参照している');
  });
  assert.ok(!/ops-app/.test(fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8')));
  assert.ok(!/ops-app/.test(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
});
