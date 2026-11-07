/*
 * Issue #804 PR-E2: 読み取り専用診断の統合入口のテスト。実 API・実 Secret は使わない（フェイクのみ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');
var Entry = require('../scripts/switchbot-verify-readonly.js');
var Keylist = require('../scripts/switchbot-verify-keylist.js');
var DeviceId = require('../scripts/switchbot-verify-device-id.js');
var Raw = require('../scripts/switchbot-verify-webhook-raw.js');
var Details = require('../scripts/switchbot-verify-webhook-details.js');

var root = path.join(__dirname, '..');
var FULL = 'ABCDEF0123456789AB12';
var URL_SECRET = 'https://relay.example/hook?t=URL-SECRET-999';
var BASE = { SWITCHBOT_TOKEN: 'tok-111', SWITCHBOT_SECRET: 'sec-222' };

function recFetch(body, status) {
  var calls = [];
  var f = async function (url, opts) {
    calls.push({ url: url, method: opts && opts.method, body: opts && opts.body });
    return { status: status || 200, json: async function () { return body; } };
  };
  f.calls = calls;
  return f;
}
function devices(list) { return { statusCode: 100, body: { deviceList: list } }; }
function kp(extra) { return Object.assign({ deviceId: FULL, deviceType: 'Keypad Touch', deviceName: 'k' }, extra); }
async function run(env, f) {
  var logs = [];
  var code = await Entry.main(env, f, function (m) { logs.push(m); });
  return { code: code, out: logs.join('\n') };
}
async function direct(mod, env, f) {
  var logs = [];
  var code = await mod.main(env, f, function (m) { logs.push(m); });
  return { code: code, out: logs.join('\n') };
}
function assertNoLeak(out) {
  ['tok-111', 'sec-222', FULL, 'URL-SECRET-999', 'relay.example', 'SECRET-PASS', 'pid-999'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'leak: ' + s);
  });
}
function stripComments(s) { return s.replace(/^\s*#.*$/gm, ''); }

// ---- 入力の拒否（API 0 回） ----

test('未知・空・prototype 名の operation は API 0 回で拒否', async function () {
  for (const op of [undefined, '', 'devices', 'create-key', 'webhook-setup', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    var f = recFetch(devices([kp({ keyList: [] })]));
    var r = await run(Object.assign({}, BASE, { OPERATION: op, KEYPAD_LAST4: 'AB12', SWITCHBOT_DEVICE_ID: FULL }), f);
    assert.strictEqual(r.code, 1, String(op));
    assert.strictEqual(f.calls.length, 0, String(op));
    assert.ok(r.out.indexOf('API は呼んでいません') !== -1);
  }
});

test('device-id / keylist は末尾4桁が不正なら API 0 回で拒否', async function () {
  for (const op of ['device-id', 'keylist']) {
    for (const last4 of [undefined, '', '12', 'AB123', 'AB 2', 'A-12']) {
      var f = recFetch(devices([kp({ keyList: [] })]));
      var r = await run(Object.assign({}, BASE, { OPERATION: op, KEYPAD_LAST4: last4, SWITCHBOT_DEVICE_ID: FULL }), f);
      assert.strictEqual(r.code, 1, op + ':' + last4);
      assert.strictEqual(f.calls.length, 0, op + ':' + last4);
    }
  }
});

// ---- 各 operation は既存の個別診断と同じ結果（判定・出力を変えない） ----

test('device-id: 既存診断と同じ終了コード・同じ判定出力（完全ID一致OK）', async function () {
  var env = Object.assign({}, BASE, { SWITCHBOT_DEVICE_ID: FULL, KEYPAD_LAST4: 'AB12' });
  var viaEntry = await run(Object.assign({ OPERATION: 'device-id' }, env), recFetch(devices([kp()])));
  var plain = await direct(DeviceId, env, recFetch(devices([kp()])));
  assert.strictEqual(viaEntry.code, 0);
  assert.strictEqual(viaEntry.code, plain.code);
  assert.ok(viaEntry.out.indexOf(plain.out) !== -1);
  assertNoLeak(viaEntry.out);
});

test('device-id: 不一致・複数一致・種別違いは既存と同じく失敗（完全ID照合を維持）', async function () {
  var env = Object.assign({ OPERATION: 'device-id' }, BASE, { SWITCHBOT_DEVICE_ID: FULL, KEYPAD_LAST4: 'AB12' });
  var none = await run(env, recFetch(devices([kp({ deviceId: 'OTHER000000000000AB12' })])));
  assert.strictEqual(none.code, 1);
  assert.ok(none.out.indexOf('NOT_FOUND') !== -1);
  var dup = await run(env, recFetch(devices([kp(), kp()])));
  assert.strictEqual(dup.code, 1);
  assert.ok(dup.out.indexOf('AMBIGUOUS') !== -1);
  var wrongType = await run(env, recFetch(devices([kp({ deviceType: 'Hub' })])));
  assert.strictEqual(wrongType.code, 1);
  assert.ok(wrongType.out.indexOf('NOT_KEYPAD') !== -1);
  var last4 = await run(Object.assign({}, env, { KEYPAD_LAST4: 'ZZ99' }), recFetch(devices([kp()])));
  assert.strictEqual(last4.code, 1);
  assert.ok(last4.out.indexOf('LAST4_MISMATCH') !== -1);
  [none, dup, wrongType, last4].forEach(function (r) { assertNoLeak(r.out); });
});

test('keylist: 既存診断と同じ件数表示・内容は出力しない', async function () {
  var keys = [{ id: 'pid-999', name: 'n1', password: 'SECRET-PASS' }, { id: 'pid-998', name: 'n2' }];
  var env = Object.assign({}, BASE, { SWITCHBOT_DEVICE_ID: FULL, KEYPAD_LAST4: 'AB12' });
  var viaEntry = await run(Object.assign({ OPERATION: 'keylist' }, env), recFetch(devices([kp({ keyList: keys })])));
  var plain = await direct(Keylist, env, recFetch(devices([kp({ keyList: keys })])));
  assert.strictEqual(viaEntry.code, plain.code);
  assert.ok(viaEntry.out.indexOf(plain.out) !== -1);
  assertNoLeak(viaEntry.out);
});

test('webhook-url: 既存 raw 診断と同じ出力。送るのは queryUrl の POST 1 回のみ', async function () {
  var resp = { statusCode: 100, message: 'success', body: { urls: [URL_SECRET] } };
  var f = recFetch(resp);
  var viaEntry = await run(Object.assign({ OPERATION: 'webhook-url' }, BASE), f);
  var plain = await direct(Raw, BASE, recFetch(resp));
  assert.strictEqual(viaEntry.code, plain.code);
  assert.ok(viaEntry.out.indexOf(plain.out) !== -1);
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].method, 'POST');
  assert.deepStrictEqual(JSON.parse(f.calls[0].body), { action: 'queryUrl' });
  assertNoLeak(viaEntry.out);
});

test('webhook-details: current / old の違いを維持し、queryDetails の POST 1 回のみ', async function () {
  var resp = { statusCode: 100, message: 'success', body: [{ url: URL_SECRET, enable: true }] };
  var env = Object.assign({}, BASE, {
    VERIFY_RELAY_URL: 'https://relay.example/hook',
    VERIFY_WEBHOOK_TOKEN: 'URL-SECRET-999',
    VERIFY_OLD_WEBHOOK_URL: 'https://old.example/x?t=OLD-SECRET'
  });
  var cur = recFetch(resp);
  var rc = await run(Object.assign({ OPERATION: 'webhook-details', TARGET: 'current' }, env), cur);
  assert.strictEqual(cur.calls.length, 1);
  var bc = JSON.parse(cur.calls[0].body);
  assert.strictEqual(bc.action, 'queryDetails');
  assert.deepStrictEqual(bc.urls, [Details.resolveTarget(Object.assign({ TARGET: 'current' }, env))]);
  assert.ok(rc.out.indexOf('target=current') !== -1);

  var old = recFetch(resp);
  var ro = await run(Object.assign({ OPERATION: 'webhook-details', TARGET: 'old' }, env), old);
  assert.deepStrictEqual(JSON.parse(old.calls[0].body).urls, [env.VERIFY_OLD_WEBHOOK_URL]);
  assert.ok(ro.out.indexOf('target=old') !== -1);
  [rc, ro].forEach(function (r) { assertNoLeak(r.out); assert.ok(r.out.indexOf('OLD-SECRET') === -1); });
});

test('webhook-details: 不正な TARGET / Secret 未設定は API 0 回', async function () {
  var f = recFetch({});
  var r = await run(Object.assign({ OPERATION: 'webhook-details', TARGET: 'other' }, BASE), f);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(f.calls.length, 0);
});

test('認証情報が無ければ各診断どおり API 0 回で失敗', async function () {
  for (const op of ['device-id', 'keylist', 'webhook-url', 'webhook-details']) {
    var f = recFetch(devices([]));
    var r = await run({ OPERATION: op, KEYPAD_LAST4: 'AB12', SWITCHBOT_DEVICE_ID: FULL }, f);
    assert.notStrictEqual(r.code, 0, op);
    assert.strictEqual(f.calls.length, 0, op);
  }
});

// ---- 他の操作の Secret を持ち越さない・変更 API へ到達不能 ----

test('診断へ渡る環境変数は、その診断に必要なものだけ（他の Secret を渡さない）', async function () {
  var seen = {};
  var origRaw = Raw.main;
  var origKey = Keylist.main;
  Raw.main = async function (env) { seen.raw = Object.keys(env).sort(); return 0; };
  Keylist.main = async function (env) { seen.keylist = Object.keys(env).sort(); return 0; };
  try {
    var all = Object.assign({}, BASE, {
      SWITCHBOT_DEVICE_ID: FULL, KEYPAD_LAST4: 'AB12', VERIFY_RELAY_URL: 'u', VERIFY_WEBHOOK_TOKEN: 't',
      VERIFY_OLD_WEBHOOK_URL: 'o', VERIFY_RELAY_ADMIN_TOKEN: 'ADMIN', VERIFY_OLD_WEBHOOK_EVIDENCE: 'E', GITHUB_TOKEN: 'G'
    });
    await run(Object.assign({ OPERATION: 'webhook-url' }, all), recFetch({}));
    await run(Object.assign({ OPERATION: 'keylist' }, all), recFetch({}));
  } finally {
    Raw.main = origRaw;
    Keylist.main = origKey;
  }
  assert.deepStrictEqual(seen.raw, ['SWITCHBOT_SECRET', 'SWITCHBOT_TOKEN']);
  assert.deepStrictEqual(seen.keylist, ['KEYPAD_LAST4', 'SWITCHBOT_DEVICE_ID', 'SWITCHBOT_SECRET', 'SWITCHBOT_TOKEN']);
});

test('読み取り専用ガード: GET devices と queryUrl/queryDetails の POST 以外は送信前に拒否', async function () {
  var f = recFetch({});
  var g = Entry.readOnlyFetch(f);
  var B = Core.API_BASE;
  await g(B + '/v1.1/devices', { method: 'GET' });
  await g(B + '/v1.1/webhook/queryWebhook', { method: 'POST', body: JSON.stringify({ action: 'queryUrl' }) });
  await g(B + '/v1.1/webhook/queryWebhook', { method: 'POST', body: JSON.stringify({ action: 'queryDetails', urls: ['x'] }) });
  assert.strictEqual(f.calls.length, 3);
  var blocked = [
    [B + '/v1.1/webhook/setupWebhook', { method: 'POST', body: '{}' }],
    [B + '/v1.1/webhook/deleteWebhook', { method: 'POST', body: '{}' }],
    [B + '/v1.1/webhook/updateWebhook', { method: 'POST', body: '{}' }],
    [B + '/v1.1/webhook/queryWebhook', { method: 'POST', body: JSON.stringify({ action: 'setupWebhook' }) }],
    [B + '/v1.1/webhook/queryWebhook', { method: 'POST', body: JSON.stringify({ action: 'deleteWebhook', url: 'x' }) }],
    [B + '/v1.1/webhook/queryWebhook', { method: 'POST', body: 'not json' }],
    [B + '/v1.1/webhook/queryWebhook', { method: 'POST' }],
    [B + '/v1.1/devices/ID/commands', { method: 'POST', body: JSON.stringify({ command: 'createKey' }) }],
    [B + '/v1.1/devices', { method: 'POST', body: '{}' }],
    [B + '/v1.1/devices', { method: 'DELETE' }],
    [B + '/v1.1/devices?x=1', { method: 'GET' }],
    ['https://evil.example/v1.1/devices', { method: 'GET' }]
  ];
  for (const [url, opts] of blocked) {
    assert.throws(function () { g(url, opts); }, /READ_ONLY_GUARD_BLOCKED/, url + ' ' + opts.method);
  }
  assert.strictEqual(f.calls.length, 3);
});

test('診断が変更 API を送ろうとしても、統合入口経由では 0 回で止まり、内容を出力しない', async function () {
  var orig = Keylist.main;
  var sent = recFetch({});
  Keylist.main = async function (env, fetchImpl) {
    await fetchImpl(Core.API_BASE + '/v1.1/webhook/setupWebhook', { method: 'POST', body: JSON.stringify({ url: URL_SECRET }) });
    return 0;
  };
  var result;
  try {
    result = await run(Object.assign({ OPERATION: 'keylist', KEYPAD_LAST4: 'AB12', SWITCHBOT_DEVICE_ID: FULL }, BASE), sent);
  } catch (e) {
    result = { threw: String(e && e.message) };
  } finally {
    Keylist.main = orig;
  }
  assert.strictEqual(sent.calls.length, 0);
  assert.strictEqual(result.threw, 'READ_ONLY_GUARD_BLOCKED');
});

// ---- workflow / 構成の静的検査 ----

test('workflow: 手動専用・Environment・最小権限・直列化・変更系を含まない', function () {
  var raw = fs.readFileSync(path.join(root, '.github/workflows/switchbot-verify-readonly.yml'), 'utf8');
  var wf = stripComments(raw);
  assert.ok(/workflow_dispatch:/.test(wf));
  assert.ok(!/^\s*(push|pull_request|pull_request_target|schedule|workflow_run):/m.test(wf));
  assert.ok(/environment: switchbot-verify/.test(wf));
  assert.ok(/permissions:\s*\n\s*contents: read/.test(wf));
  assert.ok(!/secrets:\s*inherit/.test(wf));
  assert.ok(/cancel-in-progress: false/.test(wf));
  assert.ok(/group: switchbot-verify-readonly\s*\n/.test(wf));
  assert.ok(!/group: switchbot-verify-key/.test(wf));
  // 変更系の確認文字列・入力・Secret を持たない
  assert.ok(!/confirm:|inputs\.confirm|CREATE-ONE-TEST-KEY|SETUP-WEBHOOK|REMOVE-WEBHOOK|DELETE-TEST-KEY/.test(wf));
  assert.ok(!/VERIFY_RELAY_ADMIN_TOKEN|VERIFY_OLD_WEBHOOK_EVIDENCE|GITHUB_RUN_ATTEMPT/.test(wf));
  assert.ok(!/switchbot-verify-key\.js|switchbot-verify-webhook-setup-once\.js/.test(wf));
  // operation の選択肢は許可リストと一致
  var opts = (raw.match(/options:\s*\n((?:\s+- [\w-]+\n)+)/) || [])[1].match(/- ([\w-]+)/g).map(function (s) { return s.slice(2); });
  assert.deepStrictEqual(opts, Entry.operationNames());
});

test('workflow: Secret は選んだ診断のstepにだけ渡す', function () {
  var wf = stripComments(fs.readFileSync(path.join(root, '.github/workflows/switchbot-verify-readonly.yml'), 'utf8'));
  var job = wf.split('steps:')[1];
  var steps = job.split(/\n      - name: /).slice(1);
  assert.strictEqual(steps.length, 4);
  var expect = {
    'device-id': ['SWITCHBOT_DEVICE_ID', 'SWITCHBOT_SECRET', 'SWITCHBOT_TOKEN'],
    'keylist': ['SWITCHBOT_DEVICE_ID', 'SWITCHBOT_SECRET', 'SWITCHBOT_TOKEN'],
    'webhook-url': ['SWITCHBOT_SECRET', 'SWITCHBOT_TOKEN'],
    'webhook-details': ['SWITCHBOT_SECRET', 'SWITCHBOT_TOKEN', 'VERIFY_OLD_WEBHOOK_URL', 'VERIFY_RELAY_URL', 'VERIFY_WEBHOOK_TOKEN']
  };
  var seenOps = [];
  steps.forEach(function (s) {
    var op = (s.match(/if: inputs\.operation == '([\w-]+)'/) || [])[1];
    assert.ok(op, 'step に operation 条件がある');
    seenOps.push(op);
    assert.ok(new RegExp('OPERATION: ' + op + '\\b').test(s), 'OPERATION が条件と一致');
    var secrets = (s.match(/secrets\.([A-Z_]+)/g) || []).map(function (x) { return x.slice(8); }).sort();
    assert.deepStrictEqual(secrets, expect[op], op);
    assert.ok(/node scripts\/switchbot-verify-readonly\.js/.test(s));
  });
  assert.deepStrictEqual(seenOps.sort(), Entry.operationNames().sort());
  // job 全体の env に Secret を置かない
  assert.ok(!/^\s{4}env:/m.test(wf));
});

test('入口スクリプト: 変更系の API 名・再送・他の変更入口を含まない／許可モジュールは既存診断のみ', function () {
  var src = fs.readFileSync(path.join(root, 'scripts/switchbot-verify-readonly.js'), 'utf8');
  var code = src.replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/setupWebhook|deleteWebhook|updateWebhook|createKey|deleteKey|'(PUT|DELETE)'/.test(code.replace(/'\/v1\.1\/webhook\/queryWebhook'/g, '')));
  assert.ok(!/retry|setTimeout/i.test(code));
  Object.keys(Entry.OPERATIONS).forEach(function (name) {
    var m = Entry.OPERATIONS[name].module;
    assert.ok(/^\.\/switchbot-verify-(device-id|keylist|webhook-raw|webhook-details)\.js$/.test(m), m);
    assert.ok(!/key\.js|setup-once|devices\.js$/.test(m.replace('device-id', '')), m);
  });
});

test('旧入口は削除・変更していない（廃止は証跡確認後の別PR）', function () {
  ['switchbot-verify-devices', 'switchbot-verify-device-id', 'switchbot-verify-keylist',
    'switchbot-verify-webhook-raw', 'switchbot-verify-webhook-details', 'switchbot-verify-key',
    'switchbot-verify-webhook-setup-once'].forEach(function (n) {
    assert.ok(fs.existsSync(path.join(root, '.github/workflows', n + '.yml')), n + '.yml');
  });
  var devices = fs.readFileSync(path.join(root, '.github/workflows/switchbot-verify-devices.yml'), 'utf8');
  assert.ok(!/environment:/.test(devices), 'devices は repository secrets の別境界のまま');
  assert.ok(!/node scripts\/switchbot-verify-readonly/.test(devices));
});

test('PR CI の対象に新workflow・新scriptが含まれる（.github/workflows/** と scripts）', function () {
  var ci = fs.readFileSync(path.join(root, '.github/workflows/booking-pr-tests.yml'), 'utf8');
  assert.ok(/\.github\/workflows\/\*\*/.test(ci));
  assert.ok(/'scripts\/switchbot-\*\.js'/.test(ci), 'scripts/switchbot-*.js が CI 対象');
});
