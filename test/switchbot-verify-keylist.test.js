/*
 * Issue #735: keyList 読み取り専用確認のテスト。実 API・実 Secret は使わない（フェイクのみ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');
var Ver = require('../scripts/switchbot-verify-keylist.js');

var FULL = 'ABCDEF0123456789AB12';
var ENV = { SWITCHBOT_TOKEN: 'tok-111', SWITCHBOT_SECRET: 'sec-222', SWITCHBOT_DEVICE_ID: FULL, KEYPAD_LAST4: 'AB12' };

function recFetch(body, status) {
  var calls = [];
  var f = async function (url, opts) {
    calls.push({ url: url, method: opts && opts.method, body: opts && opts.body });
    return { status: status || 200, json: async function () { return body; } };
  };
  f.calls = calls;
  return f;
}
function ok(list) { return { statusCode: 100, body: { deviceList: list } }; }
function kp(extra) { return Object.assign({ deviceId: FULL, deviceType: 'Keypad Touch', deviceName: 'k' }, extra); }
async function run(env, f) {
  var logs = [];
  var code = await Ver.main(env, f, function (m) { logs.push(m); });
  return { code: code, out: logs.join('\n') };
}
function assertNoLeak(out) {
  ['tok-111', 'sec-222', FULL, 'SECRET-PASS', 'pid-999'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'leak: ' + s);
  });
}

test('keyList が配列: 件数のみ表示し 0 で終了（0件も取得成功）', async function () {
  var keys = [{ id: 'pid-999', name: 'n1', password: 'SECRET-PASS' }, { id: 'pid-998', name: 'n2' }];
  var f = recFetch(ok([kp({ keyList: keys })]));
  var r = await run(ENV, f);
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.indexOf('末尾4桁=AB12') !== -1);
  assert.ok(r.out.indexOf('keyList: 取得成功') !== -1);
  assert.ok(r.out.indexOf('登録キー件数=2') !== -1);
  assert.ok(r.out.indexOf('読み取り専用。設定変更なし') !== -1);
  assertNoLeak(r.out);
  var r0 = await run(ENV, recFetch(ok([kp({ keyList: [] })])));
  assert.strictEqual(r0.code, 0);
  assert.ok(r0.out.indexOf('登録キー件数=0') !== -1);
});

test('送信する API は GET /v1.1/devices の 1 回のみ（変更系・Webhook なし）', async function () {
  var f = recFetch(ok([kp({ keyList: [] })]));
  await run(ENV, f);
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].method, 'GET');
  assert.strictEqual(f.calls[0].url, Core.API_BASE + '/v1.1/devices');
  assert.strictEqual(f.calls[0].body, undefined);
});

test('keyList 欠落・null・非配列は 0 件扱いせず UNKNOWN（終了コード 4）', async function () {
  var variants = [kp({}), kp({ keyList: null }), kp({ keyList: 'x' }), kp({ keyList: { a: 1 } })];
  for (var i = 0; i < variants.length; i++) {
    var r = await run(ENV, recFetch(ok([variants[i]])));
    assert.strictEqual(r.code, 4, 'case ' + i);
    assert.ok(r.out.indexOf('keyList: UNKNOWN reason=KEY_LIST_INVALID') !== -1);
    assert.ok(r.out.indexOf('登録キー件数') === -1);
    assertNoLeak(r.out);
  }
});

test('認証/API失敗=2、デバイス不一致系=3、設定不備=1 を区別する', async function () {
  var cases = [
    ['HTTP失敗', recFetch({}, 401), ENV, 2],
    ['statusCode 190', recFetch({ statusCode: 190 }), ENV, 2],
    ['例外', async function () { throw new Error('boom ' + FULL); }, ENV, 2],
    ['0件', recFetch(ok([{ deviceId: 'ZZZZ0000', deviceType: 'Keypad' }])), ENV, 3],
    ['複数件', recFetch(ok([kp({ keyList: [] }), kp({ keyList: [] })])), ENV, 3],
    ['Keypad以外', recFetch(ok([{ deviceId: FULL, deviceType: 'Hub 2', keyList: [] }])), ENV, 3],
    ['末尾4桁不一致', recFetch(ok([kp({ keyList: [] })])), Object.assign({}, ENV, { KEYPAD_LAST4: 'ZZZZ' }), 3],
    ['deviceList不正', recFetch({ statusCode: 100, body: {} }), ENV, 3],
    ['認証情報なし', recFetch(ok([])), { SWITCHBOT_DEVICE_ID: FULL, KEYPAD_LAST4: 'AB12' }, 1],
    ['deviceId未設定', recFetch(ok([])), { SWITCHBOT_TOKEN: 't', SWITCHBOT_SECRET: 's', KEYPAD_LAST4: 'AB12' }, 1]
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var r = await run(c[2], c[1]);
    assert.strictEqual(r.code, c[3], c[0]);
    assert.ok(r.out.indexOf('登録キー件数') === -1, c[0]);
    assertNoLeak(r.out);
  }
});

test('Core.countKeyList: 総件数のみ返し、内容は返さない', function () {
  var r = Core.countKeyList([kp({ keyList: [{ id: 'pid-999' }] })], FULL);
  assert.deepStrictEqual(r, { valid: true, count: 1, error: null });
  assert.strictEqual(Core.countKeyList([kp({})], FULL).error, 'KEY_LIST_INVALID');
  assert.strictEqual(Core.countKeyList([], FULL).error, 'DEVICE_NOT_FOUND');
  assert.strictEqual(Core.countKeyList([kp({ keyList: [] }), kp({ keyList: [] })], FULL).error, 'DEVICE_AMBIGUOUS');
  assert.strictEqual(Core.countKeyList(null, FULL).error, 'DEVICE_LIST_INVALID');
});

test('ワークフロー: workflow_dispatch のみ・変更系/Webhook を呼ばない', function () {
  var wf = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/switchbot-verify-keylist.yml'), 'utf8');
  assert.ok(/workflow_dispatch:/.test(wf));
  assert.ok(!/^\s*(push|pull_request|schedule):/m.test(wf));
  assert.ok(/environment: switchbot-verify/.test(wf));
  assert.ok(/node scripts\/switchbot-verify-keylist\.js/.test(wf));
  var src = fs.readFileSync(path.join(__dirname, '..', 'scripts/switchbot-verify-keylist.js'), 'utf8');
  assert.ok(!/createKey|deleteKey|webhook|'(POST|PUT|DELETE)'/i.test(src.replace(/\/\*[\s\S]*?\*\//, '')));
});
