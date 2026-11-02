/*
 * remove-old / setup-current（Issue #727）のテスト。ダミー値とフェイクのみ。実Secrets・実API・実機は使わない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');
var K = require('../scripts/switchbot-verify-key.js');
var crypto = require('node:crypto');

var RELAY = 'https://relay.example/exec';
var TOK = { webhook: 'wh-token-xyz', admin: 'admin-token-abc' };
var OLD = 'https://old-relay.example/exec?t=old-token-999';
var CURRENT = RELAY + '?t=' + encodeURIComponent(TOK.webhook);
var OTHER = 'https://unrelated.example/hook?t=other-token-555';
var NOW = 1800000000;
var LEAKS = ['sb-token-111', 'sb-secret-222', TOK.webhook, TOK.admin, 'old-token-999', 'other-token-555',
  'old-relay.example', 'relay.example', 'unrelated.example', 'RAW-MESSAGE-LEAK', 'Error: boom'];

function sha12(t) { return crypto.createHash('sha256').update(t).digest('hex').slice(0, 12); }
function iso(sec) { return new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function evidence(url, sec) { return sha12(url) + '@' + iso(sec); }

function memStore() {
  var m = {};
  return {
    get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    set: function (k, v) { m[k] = v; }, del: function (k) { delete m[k]; }, keys: function () { return Object.keys(m); }
  };
}

/**
 * opts: webhooks / deleteMode(ok|noop|fail|throw|other) / setupMode(ok|noop|fail|throw|wrong) /
 *       queryOverride(function(n, w) -> reply|undefined, n=何回目のqueryか) / relayDown / relayFailOps
 */
function world(opts, shared) {
  opts = opts || {};
  var w = shared || { store: memStore(), webhooks: (opts.webhooks || []).slice(), calls: [], relayOps: [], q: 0 };
  w.logs = [];
  w.opts = opts;
  w.deps = {
    log: function (m) { w.logs.push(m); },
    nowMs: function () { return NOW * 1000; }, nowSec: function () { return NOW; },
    sleep: async function () {}, randomInt: function () { return 7; },
    fetch: async function (url, o) {
      var body = o.body ? JSON.parse(o.body) : null;
      var reply = function (http, obj) { return { status: http, json: async function () { return obj; } }; };
      if (url === RELAY) {
        w.relayOps.push(body.op);
        if (opts.relayDown) throw new Error('boom ' + OLD);
        if ((opts.relayFailOps || []).indexOf(body.op) !== -1) return reply(200, { ok: false, error: 'X' });
        return reply(200, Core.relayHandle(w.store, null, body, TOK, NOW));
      }
      var path = url.replace(Core.API_BASE, '');
      w.calls.push(path);
      if (path === '/v1.1/webhook/queryWebhook') {
        w.q += 1;
        var ov = opts.queryOverride && opts.queryOverride(w.q, w);
        if (ov === 'throw') throw new Error('Error: boom ' + OLD);
        if (ov) return reply(ov.http, ov.body);
        return reply(200, { statusCode: 100, message: 'RAW-MESSAGE-LEAK', body: { urls: w.webhooks.slice() } });
      }
      if (path === '/v1.1/webhook/deleteWebhook') {
        var dm = opts.deleteMode || 'ok';
        if (dm === 'throw') throw new Error('Error: boom ' + body.url);
        if (dm === 'fail') return reply(500, { statusCode: 190, message: 'RAW-MESSAGE-LEAK' });
        if (dm === 'ok') w.webhooks = w.webhooks.filter(function (u) { return u !== body.url; });
        if (dm === 'other') w.webhooks = [OTHER];
        return reply(200, { statusCode: 100, message: 'RAW-MESSAGE-LEAK' });
      }
      if (path === '/v1.1/webhook/setupWebhook') {
        var sm = opts.setupMode || 'ok';
        if (sm === 'throw') throw new Error('Error: boom ' + body.url);
        if (sm === 'fail') return reply(500, { statusCode: 190, message: 'RAW-MESSAGE-LEAK' });
        if (sm === 'ok') w.webhooks.push(body.url);
        if (sm === 'wrong') w.webhooks.push(OTHER);
        return reply(200, { statusCode: 100, message: 'RAW-MESSAGE-LEAK' });
      }
      throw new Error('禁止/想定外のAPI: ' + path);
    }
  };
  return w;
}

function env(action, extra) {
  return Object.assign({
    ACTION: action, CONFIRM: K.CONFIRM[action], GITHUB_RUN_ATTEMPT: '1',
    SWITCHBOT_TOKEN: 'sb-token-111', SWITCHBOT_SECRET: 'sb-secret-222',
    VERIFY_RELAY_URL: RELAY, VERIFY_RELAY_ADMIN_TOKEN: TOK.admin, VERIFY_WEBHOOK_TOKEN: TOK.webhook,
    VERIFY_OLD_WEBHOOK_URL: OLD, VERIFY_OLD_WEBHOOK_EVIDENCE: evidence(OLD, NOW - 3600)
  }, extra || {});
}

function n(w, p) { return w.calls.filter(function (c) { return c === '/v1.1/webhook/' + p; }).length; }
function noLeak(w) {
  var out = w.logs.join('\n');
  LEAKS.forEach(function (s) { assert.ok(out.indexOf(s) === -1, 'ログに秘密/生応答が出ている: ' + s); });
}
function noKeyApis(w) {
  w.calls.forEach(function (c) { assert.ok(c.indexOf('/v1.1/webhook/') === 0, '禁止API: ' + c); });
}
function mig(w) { var r = w.store.get('WEBHOOK_MIG'); return r ? JSON.parse(r) : null; }

test('入力検証: 確認文字列・秘密未設定・再実行(run_attempt)を拒否し、他の操作と取り違えない', function () {
  assert.deepStrictEqual(K.validateInputs(env('remove-old')), []);
  assert.deepStrictEqual(K.validateInputs(env('setup-current', { VERIFY_OLD_WEBHOOK_URL: '', VERIFY_OLD_WEBHOOK_EVIDENCE: '' })), []);
  assert.ok(K.validateInputs(env('remove-old', { CONFIRM: 'REMOVE-WEBHOOK' })).indexOf('CONFIRM_MISMATCH') !== -1);
  assert.ok(K.validateInputs(env('setup-current', { CONFIRM: 'REMOVE-OLD-WEBHOOK' })).indexOf('CONFIRM_MISMATCH') !== -1);
  ['VERIFY_OLD_WEBHOOK_URL', 'VERIFY_OLD_WEBHOOK_EVIDENCE', 'VERIFY_RELAY_ADMIN_TOKEN', 'VERIFY_WEBHOOK_TOKEN', 'SWITCHBOT_TOKEN']
    .forEach(function (k) {
      var o = {}; o[k] = '';
      assert.ok(K.validateInputs(env('remove-old', o)).indexOf('SECRET_MISSING_' + k) !== -1, k);
    });
  ['2', '', undefined].forEach(function (a) {
    assert.ok(K.validateInputs(env('remove-old', { GITHUB_RUN_ATTEMPT: a })).indexOf('RERUN_FORBIDDEN') !== -1);
    assert.ok(K.validateInputs(env('setup-current', { GITHUB_RUN_ATTEMPT: a })).indexOf('RERUN_FORBIDDEN') !== -1);
  });
});

test('秘密未設定・再実行では変更APIはおろか照会APIも呼ばない', async function () {
  var w = world({ webhooks: [OLD] });
  assert.strictEqual(await K.main(env('remove-old', { VERIFY_OLD_WEBHOOK_URL: '' }), w.deps), 1);
  assert.strictEqual(await K.main(env('remove-old', { GITHUB_RUN_ATTEMPT: '2' }), w.deps), 1);
  assert.strictEqual(await K.main(env('setup-current', { VERIFY_WEBHOOK_TOKEN: '' }), w.deps), 1);
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(w.relayOps.length, 0);
  noLeak(w);
});

test('正常系: 削除1回→0件確認→別操作→0件確認→登録1回→1件MATCH（順序・回数・禁止API）', async function () {
  var w = world({ webhooks: [OLD] });
  assert.strictEqual(await K.main(env('remove-old'), w.deps), 0);
  assert.deepStrictEqual(w.calls, ['query', 'query', 'deleteWebhook', 'queryWebhook'].map(function (x) {
    return '/v1.1/webhook/' + (x === 'query' ? 'queryWebhook' : x);
  }));
  assert.strictEqual(n(w, 'deleteWebhook'), 1);
  assert.strictEqual(n(w, 'setupWebhook'), 0);
  assert.deepStrictEqual(w.webhooks, []);
  assert.strictEqual(mig(w).phase, 'REMOVED');

  var w2 = world({}, w);
  w2.calls.length = 0;
  assert.strictEqual(await K.main(env('setup-current'), w2.deps), 0);
  assert.deepStrictEqual(w2.calls, ['queryWebhook', 'setupWebhook', 'queryWebhook'].map(function (x) { return '/v1.1/webhook/' + x; }));
  assert.strictEqual(n(w2, 'deleteWebhook'), 0);
  assert.strictEqual(n(w2, 'setupWebhook'), 1);
  assert.deepStrictEqual(w2.webhooks, [CURRENT]);
  assert.strictEqual(mig(w2).phase, 'DONE');
  noKeyApis(w); noKeyApis(w2); noLeak(w); noLeak(w2);
  assert.ok(w2.logs.join('\n').indexOf('到達性') !== -1, 'MATCHは設定一致のみと明記');

  // 完了後の再実行・同時実行相当: どちらも変更APIを送らない
  var w3 = world({}, w2); w3.calls.length = 0;
  assert.strictEqual(await K.main(env('remove-old'), w3.deps), 1);
  assert.strictEqual(await K.main(env('setup-current'), w3.deps), 1);
  assert.strictEqual(n(w3, 'deleteWebhook') + n(w3, 'setupWebhook'), 0);
  noLeak(w3);
});

test('remove-old: 0件/複数件/別URL/現在URL/応答不正/通信断/API失敗では削除しない', async function () {
  var cases = [
    { webhooks: [] }, { webhooks: [OLD, OTHER] }, { webhooks: [OTHER] }, { webhooks: [CURRENT] },
    { webhooks: [OLD], queryOverride: function () { return { http: 500, body: { statusCode: 190, message: 'RAW-MESSAGE-LEAK' } }; } },
    { webhooks: [OLD], queryOverride: function () { return { http: 200, body: { statusCode: 100, body: {} } }; } },
    { webhooks: [OLD], queryOverride: function () { return { http: 200, body: { statusCode: 100, body: { urls: [OLD, 5] } } }; } },
    { webhooks: [OLD], queryOverride: function () { return 'throw'; } }
  ];
  for (var i = 0; i < cases.length; i++) {
    var w = world(cases[i]);
    assert.strictEqual(await K.main(env('remove-old'), w.deps), 1, 'case ' + i);
    assert.strictEqual(n(w, 'deleteWebhook'), 0, 'case ' + i);
    assert.strictEqual(w.relayOps.indexOf('migBeginDelete'), -1, 'case ' + i);
    noKeyApis(w); noLeak(w);
  }
});

test('remove-old: 人手確認の証跡が欠落・不一致・古い・未来・形式不正なら削除しない', async function () {
  var bad = [
    'x', sha12(OTHER) + '@' + iso(NOW - 60), sha12(OLD) + '@' + iso(NOW - 90000), sha12(OLD) + '@' + iso(NOW + 600),
    sha12(OLD) + '@2026-11-02', sha12(OLD).toUpperCase() + '@' + iso(NOW - 60)
  ];
  for (var i = 0; i < bad.length; i++) {
    var w = world({ webhooks: [OLD] });
    assert.strictEqual(await K.main(env('remove-old', { VERIFY_OLD_WEBHOOK_EVIDENCE: bad[i] }), w.deps), 1, 'case ' + i);
    assert.strictEqual(w.calls.length, 0, 'case ' + i + ' 照会も変更もしない');
    noLeak(w);
  }
  assert.strictEqual(K.checkOldEvidence(OLD, evidence(OLD, NOW - 60), NOW).ok, true);
});

test('remove-old: 1回目と削除直前の再照会で対象が変わったら削除しない', async function () {
  var w = world({ webhooks: [OLD], queryOverride: function (q, ww) { if (q === 2) ww.webhooks = [OTHER]; } });
  assert.strictEqual(await K.main(env('remove-old'), w.deps), 1);
  assert.strictEqual(n(w, 'deleteWebhook'), 0);
  assert.strictEqual(mig(w), null);
  noLeak(w);
});

test('remove-old: 進行記録の取得/保存に失敗したら変更APIを呼ばない', async function () {
  [{ relayDown: true }, { relayFailOps: ['migGet'] }, { relayFailOps: ['migBeginDelete'] }].forEach(function () {});
  var cases = [{ relayDown: true }, { relayFailOps: ['migGet'] }, { relayFailOps: ['migBeginDelete'] }];
  for (var i = 0; i < cases.length; i++) {
    cases[i].webhooks = [OLD];
    var w = world(cases[i]);
    assert.strictEqual(await K.main(env('remove-old'), w.deps), 1, 'case ' + i);
    assert.strictEqual(n(w, 'deleteWebhook'), 0, 'case ' + i);
    noLeak(w);
  }
});

test('remove-old: 受理されても残存/別URL出現/API失敗/通信断/再照会不明は成功にせず再送しない', async function () {
  var cases = [
    { deleteMode: 'noop' }, { deleteMode: 'other' }, { deleteMode: 'fail' }, { deleteMode: 'throw' },
    { queryOverride: function (q) { return q === 3 ? { http: 200, body: { statusCode: 100 } } : undefined; } },
    { queryOverride: function (q) { return q === 3 ? 'throw' : undefined; } },
    { relayFailOps: ['migMarkRemoved'] }
  ];
  for (var i = 0; i < cases.length; i++) {
    cases[i].webhooks = [OLD];
    var w = world(cases[i]);
    assert.strictEqual(await K.main(env('remove-old'), w.deps), 1, 'case ' + i);
    assert.strictEqual(n(w, 'deleteWebhook'), 1, 'case ' + i);
    assert.strictEqual(n(w, 'setupWebhook'), 0, 'case ' + i);
    assert.notStrictEqual(mig(w) && mig(w).phase, 'REMOVED', 'case ' + i + ' 成功記録を残さない');
    // 別run/Re-run相当の再実行・setup-currentも変更APIを送らない
    var again = world({ webhooks: w.webhooks }, w); again.calls.length = 0;
    again.opts = {};
    assert.strictEqual(await K.main(env('remove-old'), again.deps), 1, 'case ' + i);
    assert.strictEqual(await K.main(env('setup-current'), again.deps), 1, 'case ' + i);
    assert.strictEqual(n(again, 'deleteWebhook') + n(again, 'setupWebhook'), 0, 'case ' + i);
    noKeyApis(w); noLeak(w); noLeak(again);
  }
});

test('setup-current: 削除成功の証跡なし/古い/進行済みなら登録しない（削除なしで登録不可）', async function () {
  var w = world({ webhooks: [] });
  assert.strictEqual(await K.main(env('setup-current'), w.deps), 1);
  assert.strictEqual(w.calls.length, 0);
  w.store.set('WEBHOOK_MIG', JSON.stringify({ phase: 'DELETE_SENT', fp: sha12(OLD), atSec: NOW - 10 }));
  assert.strictEqual(await K.main(env('setup-current'), w.deps), 1);
  w.store.set('WEBHOOK_MIG', JSON.stringify({ phase: 'REMOVED', fp: sha12(OLD), atSec: NOW - 90000 }));
  assert.strictEqual(await K.main(env('setup-current'), w.deps), 1);
  w.store.set('WEBHOOK_MIG', JSON.stringify({ phase: 'SETUP_SENT', fp: sha12(OLD), atSec: NOW - 10 }));
  assert.strictEqual(await K.main(env('setup-current'), w.deps), 1);
  assert.strictEqual(n(w, 'setupWebhook') + n(w, 'deleteWebhook'), 0);
  noLeak(w);
});

test('setup-current: 登録直前に0件でない/不明なら登録しない', async function () {
  var cases = [
    { webhooks: [OTHER] }, { webhooks: [OLD] },
    { queryOverride: function () { return { http: 500, body: { statusCode: 190, message: 'RAW-MESSAGE-LEAK' } }; } },
    { queryOverride: function () { return 'throw'; } },
    { relayFailOps: ['migBeginSetup'] }
  ];
  for (var i = 0; i < cases.length; i++) {
    var w = world(cases[i]);
    w.store.set('WEBHOOK_MIG', JSON.stringify({ phase: 'REMOVED', fp: sha12(OLD), atSec: NOW - 60 }));
    assert.strictEqual(await K.main(env('setup-current'), w.deps), 1, 'case ' + i);
    assert.strictEqual(n(w, 'setupWebhook'), 0, 'case ' + i);
    assert.strictEqual(n(w, 'deleteWebhook'), 0, 'case ' + i);
    noLeak(w);
  }
});

test('setup-current: 失敗/通信断/登録後MISMATCH/件数不正は1回で停止し、再送・削除・ロールバックしない', async function () {
  var cases = [
    { setupMode: 'fail' }, { setupMode: 'throw' }, { setupMode: 'noop' }, { setupMode: 'wrong' },
    { queryOverride: function (q) { return q === 2 ? { http: 200, body: { statusCode: 100, body: { urls: 'x' } } } : undefined; } },
    { queryOverride: function (q) { return q === 2 ? 'throw' : undefined; } },
    { relayFailOps: ['migMarkDone'] }
  ];
  for (var i = 0; i < cases.length; i++) {
    cases[i].webhooks = [];
    var w = world(cases[i]);
    w.store.set('WEBHOOK_MIG', JSON.stringify({ phase: 'REMOVED', fp: sha12(OLD), atSec: NOW - 60 }));
    assert.strictEqual(await K.main(env('setup-current'), w.deps), 1, 'case ' + i);
    assert.strictEqual(n(w, 'setupWebhook'), 1, 'case ' + i);
    assert.strictEqual(n(w, 'deleteWebhook'), 0, 'case ' + i);
    assert.notStrictEqual(mig(w).phase, 'DONE', 'case ' + i);
    var again = world({ webhooks: w.webhooks }, w); again.calls.length = 0;
    assert.strictEqual(await K.main(env('setup-current'), again.deps), 1, 'case ' + i + ' 再実行');
    assert.strictEqual(n(again, 'setupWebhook'), 0, 'case ' + i + ' 再送なし');
    noKeyApis(w); noLeak(w); noLeak(again);
  }
});

test('setup-current: 共有トークンは既存の期待URL生成規則でエンコードされ、部分一致はMATCHにならない', async function () {
  var t = { webhook: 'a b&c=d/é' };
  var w = world({ webhooks: [] });
  w.store.set('WEBHOOK_MIG', JSON.stringify({ phase: 'REMOVED', fp: sha12(OLD), atSec: NOW - 60 }));
  // リレー側のtokensはTOKのまま（setupの合否はURL一致のみ）
  assert.strictEqual(await K.main(env('setup-current', { VERIFY_WEBHOOK_TOKEN: t.webhook }), w.deps), 0);
  assert.deepStrictEqual(w.webhooks, [RELAY + '?t=' + encodeURIComponent(t.webhook)]);
  var w2 = world({ setupMode: 'wrong' });
  w2.store.set('WEBHOOK_MIG', JSON.stringify({ phase: 'REMOVED', fp: sha12(OLD), atSec: NOW - 60 }));
  assert.strictEqual(await K.main(env('setup-current'), w2.deps), 1);
});

test('リレーの進行記録: 一方向の遷移のみ。巻き戻し・飛び越し・消去opなし。秘密を保持しない', function () {
  var s = memStore();
  var call = function (b) { return Core.relayHandle(s, null, Object.assign({ t: TOK.admin }, b), TOK, NOW); };
  assert.strictEqual(call({ op: 'migGet' }).mig, null);
  assert.strictEqual(call({ op: 'migMarkRemoved' }).ok, false);
  assert.strictEqual(call({ op: 'migBeginSetup' }).ok, false);
  assert.strictEqual(call({ op: 'migBeginDelete', fp: OLD }).ok, false); // URL等は受け付けない
  assert.strictEqual(call({ op: 'migBeginDelete', fp: sha12(OLD) }).ok, true);
  assert.strictEqual(call({ op: 'migBeginDelete', fp: sha12(OLD) }).ok, false);
  assert.strictEqual(call({ op: 'migBeginSetup' }).ok, false);
  assert.strictEqual(call({ op: 'migMarkRemoved' }).ok, true);
  assert.strictEqual(call({ op: 'migMarkRemoved' }).ok, false);
  assert.strictEqual(call({ op: 'migBeginSetup' }).ok, true);
  assert.strictEqual(call({ op: 'migMarkDone' }).ok, true);
  assert.strictEqual(call({ op: 'migMarkDone' }).ok, false);
  call({ op: 'clear' });
  assert.strictEqual(call({ op: 'migGet' }).mig.phase, 'DONE', 'clearでは消えない');
  assert.strictEqual(Core.relayHandle(s, null, { op: 'migGet', t: 'wrong' }, TOK, NOW).ok, false);
  assert.ok(s.get('WEBHOOK_MIG').indexOf('token') === -1 && s.get('WEBHOOK_MIG').indexOf('http') === -1);
});

// ---- Issue #729: replace-single-webhook-remove ----
var SINGLE = 'replace-single-webhook-remove';
function envS(extra) { return env(SINGLE, Object.assign({ VERIFY_OLD_WEBHOOK_URL: '', VERIFY_OLD_WEBHOOK_EVIDENCE: '' }, extra || {})); }

test('#729 入力検証: 確認文字列完全一致・秘密・Re-runを検証し、旧URL/証跡Secretは不要', function () {
  assert.strictEqual(K.CONFIRM[SINGLE], 'I-CONFIRM-SINGLE-WEBHOOK-IS-MINE');
  assert.deepStrictEqual(K.validateInputs(envS()), []);
  ['REMOVE-OLD-WEBHOOK', 'i-confirm-single-webhook-is-mine', ''].forEach(function (c) {
    assert.ok(K.validateInputs(envS({ CONFIRM: c })).indexOf('CONFIRM_MISMATCH') !== -1, c);
  });
  assert.ok(K.validateInputs(env('remove-old', { CONFIRM: 'I-CONFIRM-SINGLE-WEBHOOK-IS-MINE' })).indexOf('CONFIRM_MISMATCH') !== -1);
  ['VERIFY_RELAY_ADMIN_TOKEN', 'VERIFY_WEBHOOK_TOKEN', 'SWITCHBOT_TOKEN'].forEach(function (k) {
    var o = {}; o[k] = '';
    assert.ok(K.validateInputs(envS(o)).indexOf('SECRET_MISSING_' + k) !== -1, k);
  });
  ['2', '', undefined].forEach(function (a) {
    assert.ok(K.validateInputs(envS({ GITHUB_RUN_ATTEMPT: a })).indexOf('RERUN_FORBIDDEN') !== -1);
  });
});

test('#729 正常系: 1件確認→再照会→削除1回→0件確認→setup-currentで1件MATCH。setupは削除操作内で呼ばない', async function () {
  var w = world({ webhooks: [OLD] });
  assert.strictEqual(await K.main(envS(), w.deps), 0);
  assert.deepStrictEqual(w.calls.map(function (c) { return c.replace('/v1.1/webhook/', ''); }),
    ['queryWebhook', 'queryWebhook', 'deleteWebhook', 'queryWebhook']);
  assert.strictEqual(n(w, 'setupWebhook'), 0);
  assert.deepStrictEqual(w.webhooks, []);
  assert.strictEqual(mig(w).phase, 'REMOVED');

  var w2 = world({}, w); w2.calls.length = 0;
  assert.strictEqual(await K.main(env('setup-current'), w2.deps), 0);
  assert.strictEqual(n(w2, 'setupWebhook'), 1);
  assert.strictEqual(n(w2, 'deleteWebhook'), 0);
  assert.deepStrictEqual(w2.webhooks, [CURRENT]);
  assert.strictEqual(mig(w2).phase, 'DONE');
  noKeyApis(w); noKeyApis(w2); noLeak(w); noLeak(w2);
  // 完了後の再実行は変更APIを送らない
  var w3 = world({}, w2); w3.calls.length = 0;
  assert.strictEqual(await K.main(envS(), w3.deps), 1);
  assert.strictEqual(n(w3, 'deleteWebhook') + n(w3, 'setupWebhook'), 0);
});

test('#729 0件/複数件/現在URL/応答不正/通信断/API失敗では削除せず進行記録も作らない', async function () {
  var cases = [
    { webhooks: [] }, { webhooks: [OLD, OTHER] }, { webhooks: [CURRENT] },
    { webhooks: [OLD], queryOverride: function () { return { http: 500, body: { statusCode: 190, message: 'RAW-MESSAGE-LEAK' } }; } },
    { webhooks: [OLD], queryOverride: function () { return { http: 200, body: { statusCode: 100, body: {} } }; } },
    { webhooks: [OLD], queryOverride: function () { return { http: 200, body: { statusCode: 100, body: { urls: 'x' } } }; } },
    { webhooks: [OLD], queryOverride: function () { return 'throw'; } }
  ];
  for (var i = 0; i < cases.length; i++) {
    var w = world(cases[i]);
    assert.strictEqual(await K.main(envS(), w.deps), 1, 'case ' + i);
    assert.strictEqual(n(w, 'deleteWebhook') + n(w, 'setupWebhook'), 0, 'case ' + i);
    assert.strictEqual(mig(w), null, 'case ' + i);
    noKeyApis(w); noLeak(w);
  }
});

test('#729 削除直前の再照会で件数/対象が変わったら削除しない', async function () {
  var a = world({ webhooks: [OLD], queryOverride: function (q, ww) { if (q === 2) ww.webhooks = [OLD, OTHER]; } });
  assert.strictEqual(await K.main(envS(), a.deps), 1);
  var b = world({ webhooks: [OLD], queryOverride: function (q, ww) { if (q === 2) ww.webhooks = [OTHER]; } });
  assert.strictEqual(await K.main(envS(), b.deps), 1);
  var c = world({ webhooks: [OLD], queryOverride: function (q) { return q === 2 ? { http: 500, body: { statusCode: 190 } } : undefined; } });
  assert.strictEqual(await K.main(envS(), c.deps), 1);
  [a, b, c].forEach(function (w) { assert.strictEqual(n(w, 'deleteWebhook'), 0); assert.strictEqual(mig(w), null); noLeak(w); });
});

test('#729 進行記録あり/取得・保存失敗では変更APIを呼ばない', async function () {
  var w = world({ webhooks: [OLD] });
  w.store.set('WEBHOOK_MIG', JSON.stringify({ phase: 'DONE', fp: sha12(OLD), atSec: NOW - 10 }));
  assert.strictEqual(await K.main(envS(), w.deps), 1);
  assert.strictEqual(n(w, 'deleteWebhook'), 0);
  var cases = [{ relayDown: true }, { relayFailOps: ['migGet'] }, { relayFailOps: ['migBeginDelete'] }];
  for (var i = 0; i < cases.length; i++) {
    cases[i].webhooks = [OLD];
    var x = world(cases[i]);
    assert.strictEqual(await K.main(envS(), x.deps), 1, 'case ' + i);
    assert.strictEqual(n(x, 'deleteWebhook'), 0, 'case ' + i);
    noLeak(x);
  }
});

test('#729 受理後の残存/別URL出現/API失敗/通信断/再照会不明/記録失敗は成功にせず再送しない', async function () {
  var cases = [
    { deleteMode: 'noop' }, { deleteMode: 'other' }, { deleteMode: 'fail' }, { deleteMode: 'throw' },
    { queryOverride: function (q) { return q === 3 ? { http: 200, body: { statusCode: 100 } } : undefined; } },
    { queryOverride: function (q) { return q === 3 ? 'throw' : undefined; } },
    { relayFailOps: ['migMarkRemoved'] }
  ];
  for (var i = 0; i < cases.length; i++) {
    cases[i].webhooks = [OLD];
    var w = world(cases[i]);
    assert.strictEqual(await K.main(envS(), w.deps), 1, 'case ' + i);
    assert.strictEqual(n(w, 'deleteWebhook'), 1, 'case ' + i);
    assert.strictEqual(n(w, 'setupWebhook'), 0, 'case ' + i);
    assert.notStrictEqual(mig(w) && mig(w).phase, 'REMOVED', 'case ' + i);
    var again = world({ webhooks: w.webhooks }, w); again.calls.length = 0; again.opts = {};
    assert.strictEqual(await K.main(envS(), again.deps), 1, 'case ' + i);
    assert.strictEqual(await K.main(env('setup-current'), again.deps), 1, 'case ' + i);
    assert.strictEqual(n(again, 'deleteWebhook') + n(again, 'setupWebhook'), 0, 'case ' + i);
    noKeyApis(w); noLeak(w); noLeak(again);
  }
});

test('#729 秘密未設定・Re-runでは照会APIも呼ばず、削除なしのsetup-currentも登録しない', async function () {
  var w = world({ webhooks: [OLD] });
  assert.strictEqual(await K.main(envS({ GITHUB_RUN_ATTEMPT: '2' }), w.deps), 1);
  assert.strictEqual(await K.main(envS({ VERIFY_RELAY_ADMIN_TOKEN: '' }), w.deps), 1);
  assert.strictEqual(await K.main(envS({ CONFIRM: 'REMOVE-OLD-WEBHOOK' }), w.deps), 1);
  assert.strictEqual(w.calls.length + w.relayOps.length, 0);
  assert.strictEqual(await K.main(env('setup-current'), w.deps), 1); // REMOVED記録なし
  assert.strictEqual(n(w, 'setupWebhook'), 0);
  noLeak(w);
});
