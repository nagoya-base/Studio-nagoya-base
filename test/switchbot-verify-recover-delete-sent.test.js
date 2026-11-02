/*
 * recover-delete-sent（Issue #731）のテスト。ダミー値とフェイクのみ。実Secrets・実API・実機は使わない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');
var K = require('../scripts/switchbot-verify-key.js');

var RELAY = 'https://relay.example/exec';
var TOK = { webhook: 'wh-token-xyz', admin: 'admin-token-abc' };
var OLD = 'https://old-relay.example/exec?t=old-token-999';
var NOW = 1800000000;
var FP = 'abcdef012345';
var LEAKS = ['sb-token-111', 'sb-secret-222', TOK.webhook, TOK.admin, 'old-token-999', 'old-relay.example',
  'relay.example', 'RAW-MESSAGE-LEAK', 'Error: boom', FP];
var ACTION = 'recover-delete-sent';

function memStore() {
  var m = {};
  return {
    get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    set: function (k, v) { m[k] = v; }, del: function (k) { delete m[k]; }, keys: function () { return Object.keys(m); }
  };
}

function world(o) {
  o = o || {};
  var store = memStore();
  if (o.mig !== undefined) store.set('WEBHOOK_MIG', typeof o.mig === 'string' ? o.mig : JSON.stringify(o.mig));
  var w = { store: store, calls: [], relayOps: [], logs: [] };
  w.deps = {
    log: function (m) { w.logs.push(m); },
    nowMs: function () { return NOW * 1000; }, nowSec: function () { return NOW; },
    sleep: async function () {}, randomInt: function () { return 7; },
    fetch: async function (url, opt) {
      var body = opt.body ? JSON.parse(opt.body) : null;
      var reply = function (http, obj) { return { status: http, json: async function () { return obj; } }; };
      if (url === RELAY) {
        w.relayOps.push(body.op);
        if (o.relayDown) throw new Error('Error: boom ' + OLD);
        if ((o.relayFailOps || []).indexOf(body.op) !== -1) return reply(200, { ok: false, error: 'X' });
        return reply(200, Core.relayHandle(store, null, body, TOK, NOW));
      }
      var path = url.replace(Core.API_BASE, '');
      w.calls.push(path);
      if (path !== '/v1.1/webhook/queryWebhook') throw new Error('禁止/想定外のAPI: ' + path);
      var q = o.query || { http: 200, body: { statusCode: 100, message: 'RAW-MESSAGE-LEAK', body: { urls: [] } } };
      if (q === 'throw') throw new Error('Error: boom ' + OLD);
      return reply(q.http, q.body);
    }
  };
  return w;
}

function env(extra) {
  return Object.assign({
    ACTION: ACTION, CONFIRM: K.CONFIRM[ACTION], GITHUB_RUN_ATTEMPT: '1',
    SWITCHBOT_TOKEN: 'sb-token-111', SWITCHBOT_SECRET: 'sb-secret-222',
    VERIFY_RELAY_URL: RELAY, VERIFY_RELAY_ADMIN_TOKEN: TOK.admin, VERIFY_WEBHOOK_TOKEN: TOK.webhook
  }, extra || {});
}

function mig(w) { var r = w.store.get('WEBHOOK_MIG'); return r ? JSON.parse(r) : null; }
function sent() { return { phase: 'DELETE_SENT', fp: FP, atSec: NOW - 600 }; }
function resp(statusCode, urls) { return { http: 200, body: { statusCode: statusCode, message: 'RAW-MESSAGE-LEAK', body: urls === undefined ? undefined : { urls: urls } } }; }

function assertSafe(w) {
  w.calls.forEach(function (c) { assert.strictEqual(c, '/v1.1/webhook/queryWebhook', '照会以外のAPI: ' + c); });
  ['/deleteWebhook', '/setupWebhook', '/updateWebhook', 'createKey', 'deleteKey'].forEach(function (s) {
    w.calls.forEach(function (c) { assert.ok(c.indexOf(s) === -1, '変更API: ' + c); });
  });
  var out = w.logs.join('\n');
  LEAKS.forEach(function (s) { assert.ok(out.indexOf(s) === -1, 'ログ漏洩: ' + s); });
}

async function run(w, e) { return K.main(e || env(), w.deps); }

test('DELETE_SENT + 0件 → REMOVED へ1回だけ遷移し、変更APIは呼ばない', async function () {
  var w = world({ mig: sent() });
  assert.strictEqual(await run(w), 0);
  assert.strictEqual(mig(w).phase, 'REMOVED');
  assert.strictEqual(w.relayOps.filter(function (o) { return o === 'migMarkRemoved'; }).length, 1);
  assert.deepStrictEqual(w.calls, ['/v1.1/webhook/queryWebhook']);
  assert.ok(w.logs.join('\n').indexOf('DELETED_CONFIRMED') !== -1);
  assertSafe(w);
  // 続けて実行しても2回目は phase 不一致で何も変えない
  var w2 = world({ mig: mig(w) });
  assert.strictEqual(await run(w2), 1);
  assert.strictEqual(mig(w2).phase, 'REMOVED');
  assert.ok(w2.relayOps.indexOf('migMarkRemoved') === -1);
});

test('DELETE_SENT + 1件/複数件 → 状態変更なし（STILL_PRESENT、URL実値を出さない）', async function () {
  for (var urls of [[OLD], [OLD, 'https://other.example/x?t=other-token-555']]) {
    var w = world({ mig: sent(), query: resp(100, urls) });
    assert.strictEqual(await run(w), 1);
    assert.deepStrictEqual(mig(w), sent());
    assert.ok(w.relayOps.indexOf('migMarkRemoved') === -1);
    assert.ok(w.logs.join('\n').indexOf('STILL_PRESENT') !== -1);
    assert.ok(w.logs.join('\n').indexOf('other-token-555') === -1);
    assertSafe(w);
  }
});

test('DELETE_SENT + API190 / HTTP失敗 / 通信断 / 応答不正 → UNKNOWNで状態変更なし', async function () {
  var cases = {
    api190: resp(190),
    http500: { http: 500, body: { statusCode: 100, message: 'RAW-MESSAGE-LEAK', body: { urls: [] } } },
    throws: 'throw',
    noBody: { http: 200, body: { statusCode: 100, message: 'RAW-MESSAGE-LEAK' } },
    urlsNotArray: resp(100, 'none'),
    urlsNonString: resp(100, [1]),
    nullJson: { http: 200, body: null }
  };
  for (var k of Object.keys(cases)) {
    var w = world({ mig: sent(), query: cases[k] });
    assert.strictEqual(await run(w), 1, k);
    assert.deepStrictEqual(mig(w), sent(), k);
    assert.ok(w.relayOps.indexOf('migMarkRemoved') === -1, k);
    assert.ok(w.logs.join('\n').indexOf('UNKNOWN') !== -1, k);
    assertSafe(w);
  }
});

test('phase不一致・記録なし・不正形式 → 状態変更なし（照会もしない）', async function () {
  var cases = [
    undefined,
    { phase: 'REMOVED', fp: FP, atSec: NOW },
    { phase: 'SETUP_SENT', fp: FP, atSec: NOW },
    { phase: 'DONE', fp: FP, atSec: NOW },
    { phase: 'delete_sent', fp: FP, atSec: NOW },
    { phase: 123 },
    {},
    '{broken'
  ];
  for (var m of cases) {
    var w = world({ mig: m });
    var before = w.store.get('WEBHOOK_MIG');
    assert.strictEqual(await run(w), 1, JSON.stringify(m));
    assert.strictEqual(w.store.get('WEBHOOK_MIG'), before);
    assert.strictEqual(w.calls.length, 0);
    assert.ok(w.relayOps.indexOf('migMarkRemoved') === -1);
    assertSafe(w);
  }
});

test('リレー通信断・REMOVED保存失敗 → 状態変更なし', async function () {
  var w = world({ mig: sent(), relayDown: true });
  assert.strictEqual(await run(w), 1);
  assertSafe(w);
  var w2 = world({ mig: sent(), relayFailOps: ['migMarkRemoved'] });
  assert.strictEqual(await run(w2), 1);
  assert.deepStrictEqual(mig(w2), sent());
  assertSafe(w2);
});

test('入力検証: Re-run・確認文字列不一致・秘密未設定は拒否（何も呼ばない）', async function () {
  assert.deepStrictEqual(K.validateInputs(env()), []);
  ['2', '', undefined].forEach(function (a) {
    assert.ok(K.validateInputs(env({ GITHUB_RUN_ATTEMPT: a })).indexOf('RERUN_FORBIDDEN') !== -1);
  });
  assert.ok(K.validateInputs(env({ CONFIRM: 'SETUP-CURRENT-WEBHOOK' })).indexOf('CONFIRM_MISMATCH') !== -1);
  assert.ok(K.validateInputs(env({ VERIFY_RELAY_ADMIN_TOKEN: '' })).indexOf('SECRET_MISSING_VERIFY_RELAY_ADMIN_TOKEN') !== -1);
  var w = world({ mig: sent() });
  assert.strictEqual(await run(w, env({ GITHUB_RUN_ATTEMPT: '2' })), 1);
  assert.deepStrictEqual(mig(w), sent());
  assert.strictEqual(w.calls.length + w.relayOps.length, 0);
});

test('復旧後は既存 setup-current へ別runで進める（本操作では登録しない）', async function () {
  var w = world({ mig: sent() });
  assert.strictEqual(await run(w), 0);
  assert.strictEqual(w.calls.filter(function (c) { return c.indexOf('setupWebhook') !== -1; }).length, 0);
  assert.strictEqual(mig(w).phase, 'REMOVED');
});
