/*
 * GAS配信画面（gas/ops-reservations/OpsPage.html）のテスト（Issue #936）。
 * - 画面は _ops-app/frontend/ の生成物であり、正本とずれていないこと。
 * - GAS実アダプターが共通接続契約を満たし、通信失敗を正常/0件にしないこと。
 * - 実バックエンド（OpsApi）＋実画面ロジックの結合を、架空データ・架空の認証で確認する。
 * データはすべて架空。実デプロイ・実台帳・実アカウントは使わない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var FRONT = path.join(ROOT, '_ops-app', 'frontend');
var builder = require(path.join(ROOT, 'scripts', 'build-ops-gas-page.js'));
var C = require(path.join(FRONT, 'ops-client.js'));
var Gas = require(path.join(FRONT, 'gas-adapter.js'));
var contract = require('./helpers/ops-contract');

function tick() { return new Promise(function (resolve) { setTimeout(resolve, 5); }); }

/* google.script.run 相当の架空ランナー。 */
function fakeRunner(handlers) {
  var calls = [];
  function make(ok, ng) {
    return new Proxy({}, {
      get: function (_, name) {
        return function (arg) {
          calls.push(name);
          var h = handlers[name];
          if (!h) throw new Error('unknown function ' + name);
          h(arg, ok, ng);
        };
      }
    });
  }
  return {
    calls: calls,
    withSuccessHandler: function (ok) { return { withFailureHandler: function (ng) { return make(ok, ng); } }; }
  };
}

test('生成物: OpsPage.html は _ops-app/frontend/ の正本と一致し、モックを含まない', function () {
  assert.strictEqual(fs.readFileSync(builder.OUT, 'utf8'), builder.build(), 'node scripts/build-ops-gas-page.js を実行して再生成してください');
  var page = fs.readFileSync(builder.OUT, 'utf8');
  assert.ok(!/OpsMockAdapter|mock-adapter/.test(page), 'モックアダプターを含めない');
  assert.ok(/OpsClient\.mount\(document, OpsGasAdapter\.createGasApi\(google\.script\.run\)\)/.test(page));
  assert.ok(/noindex,nofollow/.test(page) && /name="viewport"/.test(page));
  assert.ok(!/<script[^>]+src=/.test(page), '外部スクリプトを読み込まない');
});

test('生成物: 秘密情報・外部送信を含まない（呼ぶのは予約の読み取り3関数（詳細・一覧・鍵状態）とメモの3関数だけ）', function () {
  var page = fs.readFileSync(builder.OUT, 'utf8');
  var names = (page.match(/'ops[A-Za-z]+'/g) || []).sort();
  assert.deepStrictEqual(names, ["'opsDeleteTask'", "'opsGetKeyStatus'", "'opsGetReservation'", "'opsListReservations'", "'opsListTasks'", "'opsSaveTask'"]);
  var code = page.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/fetch\(|XMLHttpRequest|sendBeacon|localStorage|sessionStorage|document\.cookie/.test(code));
  assert.ok(!/OPS_OWNER_EMAIL|OPS_SPREADSHEET_ID|OPS_ACCESS_STATUS|Bearer |api[_-]?key/i.test(code));
});

test('GASアダプター: 成功応答をそのまま渡し、通信失敗・例外は失敗として通知する', async function () {
  var runner = fakeRunner({
    opsListReservations: function (p, ok) { ok({ ok: true, echo: p }); },
    opsGetReservation: function (id, ok, ng) { ng(new Error('boom')); }
  });
  var api = Gas.createGasApi(runner);
  assert.strictEqual(api.kind, 'gas');
  var got = null;
  api.list({ service: 'snb' }, function (r) { got = r; }, function () { throw new Error('unexpected'); });
  assert.deepStrictEqual(got, { ok: true, echo: { service: 'snb' } });
  var failed = 0;
  api.detail('A1', function () { throw new Error('unexpected'); }, function () { failed++; });
  assert.strictEqual(failed, 1);
  var thrown = 0;
  Gas.createGasApi({ withSuccessHandler: function () { throw new Error('x'); } }).list({}, function () {}, function () { thrown++; });
  assert.strictEqual(thrown, 1);
  assert.deepStrictEqual(runner.calls, ['opsListReservations', 'opsGetReservation']);
});

/* ---- 結合: 実バックエンド（OpsApi.handle）＋実画面ロジック。認証・台帳は架空 ---- */
function loadBackend() {
  var dir = path.join(ROOT, 'gas', 'ops-reservations');
  var sandbox = { Logger: { log: function () {} } };
  vm.createContext(sandbox);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox;
}

var NOW = Date.UTC(2026, 11, 1, 2, 0, 0);
var HEADER = ['bookingId', 'date', 'startAt', 'endAt', 'brand', 'name', 'people', 'status'];
function ledger(rows) { return { values: [HEADER].concat(rows) }; }

/* バックエンドの handle を google.script.run の関数として見せる（JSONを往復して構造化複製を模す）。 */
function runnerOver(be, ctx) {
  return fakeRunner({
    opsListReservations: function (p, ok) { ok(JSON.parse(JSON.stringify(be.OpsApi.handle({ op: 'list', params: p }, ctx)))); },
    opsGetReservation: function (id, ok) { ok(JSON.parse(JSON.stringify(be.OpsApi.handle({ op: 'detail', id: id }, ctx)))); }
  });
}

test('結合(架空): 所有者は一覧・詳細を見られ、応答は契約を満たす', async function () {
  var be = loadBackend();
  var ctx = { nowMs: NOW, authenticate: function () { return { ok: true }; },
    readLedger: function () { return ledger([['FAKE-1', '2026-12-02', new Date(Date.UTC(2026, 11, 2, 1, 0)), new Date(Date.UTC(2026, 11, 2, 3, 0)), 'snb', '架空 花子', 2, 'CONFIRMED']]); } };
  var api = Gas.createGasApi(runnerOver(be, ctx));
  var ctl = C.createController(api, function () {});
  ctl.load({ service: 'all', status: 'all', scope: 'upcoming' });
  await tick();
  assert.strictEqual(ctl.state.phase, 'ready');
  assert.deepStrictEqual(contract.validateList(ctl.state.data), []);
  assert.strictEqual(ctl.state.data.items.length, 1);
  assert.ok(/FAKE-1/.test(C.renderView(ctl.state)));
  assert.ok(!/モックデータ/.test(C.renderBanner(ctl.state)), 'GAS実アダプターではモック表示を出さない');
  ctl.openDetail('FAKE-1');
  await tick();
  assert.strictEqual(ctl.state.detailPhase, 'ready');
  assert.deepStrictEqual(contract.validateDetail({ ok: true, contractVersion: 1, fetchedAt: ctl.state.data.fetchedAt, reservation: ctl.state.detail }), []);
});

test('結合(架空): 認証切れ・非所有者は予約を一切表示せず、台帳にも触れない', async function () {
  var be = loadBackend();
  var reads = 0;
  for (const code of ['UNAUTHENTICATED', 'FORBIDDEN']) {
    var ctx = { nowMs: NOW, authenticate: function () { return { ok: false, code: code }; }, readLedger: function () { reads++; return ledger([['LEAK-1', '2026-12-02', '', '', 'snb', 'LEAK', 1, 'CONFIRMED']]); } };
    var ctl = C.createController(Gas.createGasApi(runnerOver(be, ctx)), function () {});
    ctl.load({ service: 'all', status: 'all', scope: 'upcoming' });
    await tick();
    assert.strictEqual(ctl.state.phase, 'denied', code);
    assert.ok(!/LEAK/.test(C.renderBanner(ctl.state) + C.renderView(ctl.state)));
  }
  assert.strictEqual(reads, 0);
});

test('結合(架空): 取得失敗・未接続・0件・通信失敗が区別され、失敗を0件にしない。失敗時は古い表示を明示', async function () {
  var be = loadBackend();
  var mode = 'ok';
  var ctx = { nowMs: NOW, authenticate: function () { return { ok: true }; },
    readLedger: function () {
      if (mode === 'fetch') throw Object.assign(new Error('x'), { opsCode: 'FETCH_FAILED' });
      if (mode === 'nc') return { notConnected: true };
      if (mode === 'empty') return ledger([]);
      return ledger([['FAKE-1', '2026-12-02', new Date(Date.UTC(2026, 11, 2, 1, 0)), new Date(Date.UTC(2026, 11, 2, 3, 0)), 'snb', '架空', 1, 'CONFIRMED']]);
    } };
  var net = true;
  var base = runnerOver(be, ctx);
  var runner = { calls: base.calls, withSuccessHandler: function (ok) { return { withFailureHandler: function (ng) { return net ? base.withSuccessHandler(ok).withFailureHandler(ng) : new Proxy({}, { get: function () { return function () { ng(new Error('offline')); }; } }); } }; } };
  var ctl = C.createController(Gas.createGasApi(runner), function () {});
  var P = { service: 'all', status: 'all', scope: 'upcoming' };
  ctl.load(P); await tick();
  assert.strictEqual(ctl.state.phase, 'ready');
  mode = 'fetch'; ctl.load(P); await tick();
  assert.strictEqual(ctl.state.phase, 'error');
  assert.strictEqual(ctl.state.stale, true, '前回データは古いと明示');
  assert.ok(/古いデータを表示しています/.test(C.renderBanner(ctl.state)));
  net = false; ctl.load(P); await tick();
  assert.strictEqual(ctl.state.phase, 'error');
  net = true; mode = 'nc'; ctl.load(P); await tick();
  assert.strictEqual(ctl.state.phase, 'not_connected');
  mode = 'empty'; ctl.load(P); await tick();
  assert.strictEqual(ctl.state.phase, 'ready');
  assert.strictEqual(ctl.state.data.items.length, 0);
  assert.ok(/0件/.test(C.renderView(ctl.state)));
});
