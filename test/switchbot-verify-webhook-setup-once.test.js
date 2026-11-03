/*
 * Issue #741: setup-current-once のテスト。実 API・実 Secret は使わない（フェイクのみ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var Once = require('../scripts/switchbot-verify-webhook-setup-once.js');

var URL_EXPECTED = 'https://relay.example/hook?t=URL-SECRET-999';
var ENV = {
  CONFIRM: 'I-CONFIRM-SETUP-CURRENT-ONCE', GITHUB_RUN_ATTEMPT: '1',
  SWITCHBOT_TOKEN: 'tok-111', SWITCHBOT_SECRET: 'sec-222',
  VERIFY_RELAY_URL: 'https://relay.example/hook', VERIFY_WEBHOOK_TOKEN: 'URL-SECRET-999'
};

/** responses: 呼び出し順の応答配列。Error 要素は通信失敗。 */
function seqFetch(responses) {
  var calls = [];
  var f = async function (url, opts) {
    var body = JSON.parse(opts.body);
    calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), action: body.action, body: body, method: opts.method });
    var r = responses[calls.length - 1];
    if (r instanceof Error) throw r;
    return { status: r.status || 200, json: async function () { if (r.body === 'BADJSON') throw new Error('x'); return r.body; } };
  };
  f.calls = calls;
  return f;
}
async function run(env, f) {
  var logs = [];
  var code = await Once.main(env, f, function (m) { logs.push(m); });
  return { code: code, out: logs.join('\n') };
}
function assertNoLeak(out) {
  ['tok-111', 'sec-222', 'URL-SECRET-999', 'relay.example', 'SECRET-MESSAGE', 'SECRET-BODY'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'leak: ' + s);
  });
}
function setupCount(f) { return f.calls.filter(function (c) { return c.action === 'setupWebhook'; }).length; }
var FORBIDDEN = ['deleteWebhook', 'updateWebhook', 'createKey', 'deleteKey'];
function assertNoForbidden(f) {
  f.calls.forEach(function (c) {
    assert.ok(FORBIDDEN.indexOf(c.action) === -1, c.action);
    assert.ok(!/delete|update|key/i.test(c.path), c.path);
  });
}

test('RECOVERED_CONFIRMED: setup=100 → queryUrl=100 / 1件 / 完全一致。呼出は setup→queryUrl の 2 回のみ', async function () {
  var f = seqFetch([
    { body: { statusCode: 100, message: 'SECRET-MESSAGE', body: {} } },
    { body: { statusCode: 100, message: 'success', body: { urls: [URL_EXPECTED] } } }
  ]);
  var r = await run(ENV, f);
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(f.calls.map(function (c) { return c.action; }), ['setupWebhook', 'queryUrl']);
  assert.strictEqual(f.calls[0].path, '/v1.1/webhook/setupWebhook');
  assert.strictEqual(f.calls[0].method, 'POST');
  assert.deepStrictEqual(f.calls[0].body, { action: 'setupWebhook', url: URL_EXPECTED, deviceList: 'ALL' });
  ['setup-current-once', 'setupWebhook: HTTP=200', 'statusCode=100', 'message=NONEMPTY', 'urls=ARRAY count=1 match=YES', '判定=RECOVERED_CONFIRMED']
    .forEach(function (s) { assert.ok(r.out.indexOf(s) !== -1, s); });
  assertNoLeak(r.out);
  assertNoForbidden(f);
});

test('queryUrl が 100 でも 0件/2件/不一致なら RECOVERED にしない', async function () {
  var cases = [[], [URL_EXPECTED, 'https://other.example/x'], ['https://other.example/x']];
  for (var i = 0; i < cases.length; i++) {
    var f = seqFetch([
      { body: { statusCode: 100, message: '', body: {} } },
      { body: { statusCode: 100, message: '', body: { urls: cases[i] } } },
      { body: { statusCode: 100, message: '', body: [] } }
    ]);
    var r = await run(ENV, f);
    assert.strictEqual(r.code, 3);
    assert.ok(r.out.indexOf('判定=SETUP_ACCEPTED_BUT_QUERY_UNKNOWN') !== -1);
    assert.strictEqual(setupCount(f), 1);
    assertNoForbidden(f);
    assertNoLeak(r.out);
  }
});

test('setup=100 でも queryUrl=190 / 通信失敗 / JSON不正は SETUP_ACCEPTED_BUT_QUERY_UNKNOWN（queryDetails は参考で 1 回まで）', async function () {
  var queries = [
    { body: { statusCode: 190, message: '', body: {} } },
    new Error('net'),
    { body: 'BADJSON' }
  ];
  for (var i = 0; i < queries.length; i++) {
    var f = seqFetch([{ body: { statusCode: 100, message: '', body: {} } }, queries[i], { body: { statusCode: 190, message: '', body: {} } }]);
    var r = await run(ENV, f);
    assert.strictEqual(r.code, 3);
    assert.ok(r.out.indexOf('判定=SETUP_ACCEPTED_BUT_QUERY_UNKNOWN') !== -1);
    assert.deepStrictEqual(f.calls.map(function (c) { return c.action; }), ['setupWebhook', 'queryUrl', 'queryDetails']);
    assertNoForbidden(f);
    assertNoLeak(r.out);
  }
});

test('SETUP_FAILED_190: 190 は即停止。追加の API 呼出しなし・再送なし', async function () {
  var f = seqFetch([{ body: { statusCode: 190, message: '', body: {} } }]);
  var r = await run(ENV, f);
  assert.strictEqual(r.code, 3);
  assert.strictEqual(f.calls.length, 1);
  ['statusCode=190', '判定=SETUP_FAILED_190', '再送なし。追加変更操作なし'].forEach(function (s) { assert.ok(r.out.indexOf(s) !== -1, s); });
  assertNoLeak(r.out);
});

test('EXISTING_STATE_DETECTED: 既存を示す明確な応答。停止して再送しない', async function () {
  var f = seqFetch([{ body: { statusCode: 160, message: 'webhook already exists', body: {} } }]);
  var r = await run(ENV, f);
  assert.strictEqual(r.code, 3);
  assert.strictEqual(f.calls.length, 1);
  assert.ok(r.out.indexOf('判定=EXISTING_STATE_DETECTED') !== -1);
  assert.ok(r.out.indexOf('already') === -1);
});

test('UNKNOWN: 通信失敗・JSON不正・HTTP≠200・その他 statusCode は停止（再送なし・照会なし）', async function () {
  var cases = [new Error('net'), { body: 'BADJSON' }, { status: 500, body: { statusCode: 100 } }, { body: { statusCode: 500, message: 'x', body: {} } }];
  for (var i = 0; i < cases.length; i++) {
    var f = seqFetch([cases[i]]);
    var r = await run(ENV, f);
    assert.strictEqual(r.code, 3);
    assert.strictEqual(f.calls.length, 1);
    assert.ok(r.out.indexOf('判定=UNKNOWN') !== -1);
    assertNoLeak(r.out);
  }
});

test('入力不備: 確認文字列違い・Re-run(attempt≠1)・未設定・Secret欠落では 1 回も送信しない', async function () {
  var bad = [
    { CONFIRM: 'wrong' }, { CONFIRM: undefined },
    { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_RUN_ATTEMPT: undefined },
    { SWITCHBOT_TOKEN: '' }, { SWITCHBOT_SECRET: '' },
    { VERIFY_RELAY_URL: '' }, { VERIFY_WEBHOOK_TOKEN: '' }
  ];
  for (var i = 0; i < bad.length; i++) {
    var f = seqFetch([{ body: { statusCode: 100 } }]);
    var r = await run(Object.assign({}, ENV, bad[i]), f);
    assert.strictEqual(r.code, 1);
    assert.strictEqual(f.calls.length, 0);
    assertNoLeak(r.out);
  }
});

test('Re-run 相当(run_attempt=2)の理由コードが RERUN_FORBIDDEN', async function () {
  assert.ok(Once.validateInputs(Object.assign({}, ENV, { GITHUB_RUN_ATTEMPT: '2' })).indexOf('RERUN_FORBIDDEN') !== -1);
  assert.deepStrictEqual(Once.validateInputs(ENV), []);
});

test('ワークフロー: workflow_dispatch 専用・確認文字列・run_attempt 連携・Secrets 由来・禁止操作なし', function () {
  var y = fs.readFileSync(path.join(__dirname, '../.github/workflows/switchbot-verify-webhook-setup-once.yml'), 'utf8');
  assert.ok(/workflow_dispatch:/.test(y));
  assert.ok(!/^\s*(push|pull_request|schedule):/m.test(y));
  assert.ok(y.indexOf('I-CONFIRM-SETUP-CURRENT-ONCE') !== -1);
  assert.ok(y.indexOf('GITHUB_RUN_ATTEMPT: ${{ github.run_attempt }}') !== -1);
  assert.ok(y.indexOf('secrets.VERIFY_RELAY_URL') !== -1 && y.indexOf('secrets.VERIFY_WEBHOOK_TOKEN') !== -1);
  assert.ok(!/inputs\.(url|webhook)/i.test(y));
  assert.ok(/group: switchbot-verify-key/.test(y));
  var src = fs.readFileSync(path.join(__dirname, '../scripts/switchbot-verify-webhook-setup-once.js'), 'utf8');
  var code = src.replace(/\/\*[\s\S]*?\*\//, '');
  ['deleteWebhook', 'updateWebhook', 'createKey', 'deleteKey'].forEach(function (w) {
    assert.ok(code.indexOf(w) === -1, w);
  });
});
