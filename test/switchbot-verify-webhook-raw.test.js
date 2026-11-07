/*
 * Issue #737: queryWebhook 生レスポンス構造の読み取り専用診断のテスト。実 API・実 Secret は使わない（フェイクのみ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');
var Diag = require('../scripts/switchbot-verify-webhook-raw.js');

var ENV = { SWITCHBOT_TOKEN: 'tok-111', SWITCHBOT_SECRET: 'sec-222' };
var URL_SECRET = 'https://relay.example/hook?t=URL-SECRET-999';

function recFetch(body, status) {
  var calls = [];
  var f = async function (url, opts) {
    calls.push({ url: url, method: opts && opts.method, body: opts && opts.body });
    return { status: status || 200, json: async function () { if (body === 'BADJSON') throw new Error('x'); return body; } };
  };
  f.calls = calls;
  return f;
}
async function run(env, f) {
  var logs = [];
  var code = await Diag.main(env, f, function (m) { logs.push(m); });
  return { code: code, out: logs.join('\n') };
}
function assertNoLeak(out) {
  ['tok-111', 'sec-222', 'URL-SECRET-999', 'relay.example', 'SECRET-MESSAGE'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'leak: ' + s);
  });
}

test('statusCode=190: 成功扱いせず 0 件とも断定しない（終了コード 3）', async function () {
  var r = await run(ENV, recFetch({ statusCode: 190, message: '', body: {} }));
  assert.strictEqual(r.code, 3);
  ['HTTP=200', 'JSON=OK', 'statusCode=190', 'message=EMPTY', 'body=OBJECT', 'urls=NOT_ARRAY', '判定=NOT_SUCCESS', '読み取り専用。Webhook設定変更なし']
    .forEach(function (s) { assert.ok(r.out.indexOf(s) !== -1, s); });
  assert.ok(r.out.indexOf('ZERO_CONFIRMED') === -1);
  assertNoLeak(r.out);
});

test('statusCode=100 + urls=[] のときだけ 0 件確定', async function () {
  var r = await run(ENV, recFetch({ statusCode: 100, body: { urls: [] } }));
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.indexOf('urls=ARRAY count=0') !== -1);
  assert.ok(r.out.indexOf('判定=ZERO_CONFIRMED') !== -1);
});

test('statusCode=100 + urls 1 件: 件数のみ表示し URL 値は出さない', async function () {
  var r = await run(ENV, recFetch({ statusCode: 100, message: 'SECRET-MESSAGE', body: { urls: [URL_SECRET] } }));
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.indexOf('urls=ARRAY count=1') !== -1);
  assert.ok(r.out.indexOf('message=NON_EMPTY') !== -1);
  assert.ok(r.out.indexOf('判定=REGISTERED') !== -1);
  assertNoLeak(r.out);
});

test('urls 欠落・null・非配列は 0 件と断定しない（statusCode=100 でも URLS_UNKNOWN）', async function () {
  var bodies = [{}, { urls: null }, { urls: 'x' }, { urls: { a: 1 } }];
  for (var i = 0; i < bodies.length; i++) {
    var r = await run(ENV, recFetch({ statusCode: 100, body: bodies[i] }));
    assert.strictEqual(r.code, 3, 'case ' + i);
    assert.ok(r.out.indexOf('urls=NOT_ARRAY') !== -1);
    assert.ok(r.out.indexOf('判定=URLS_UNKNOWN') !== -1);
    assert.ok(r.out.indexOf('ZERO_CONFIRMED') === -1);
  }
});

test('body の型・message 欠落・statusCode 欠落を区別する', async function () {
  var s = Diag.summarize(200, { statusCode: 100, body: null });
  assert.strictEqual(s.bodyType, 'NULL');
  assert.strictEqual(s.message, 'MISSING');
  s = Diag.summarize(200, { body: [] });
  assert.strictEqual(s.bodyType, 'ARRAY');
  assert.strictEqual(s.statusCode, null);
  s = Diag.summarize(200, {});
  assert.strictEqual(s.bodyType, 'MISSING');
  var r = await run(ENV, recFetch({ body: 'str' }));
  assert.ok(r.out.indexOf('statusCode=MISSING') !== -1);
  assert.ok(r.out.indexOf('body=OTHER') !== -1);
  assert.strictEqual(r.code, 3);
});

test('HTTP 非200・JSON 解析不能・例外は成功扱いしない', async function () {
  var r = await run(ENV, recFetch({ statusCode: 100, body: { urls: [] } }, 500));
  assert.strictEqual(r.code, 3);
  assert.ok(r.out.indexOf('判定=API_FAILED') !== -1);
  r = await run(ENV, recFetch('BADJSON'));
  assert.strictEqual(r.code, 3);
  assert.ok(r.out.indexOf('JSON=FAILED') !== -1);
  var thrower = async function () { throw new Error('boom tok-111 sec-222'); };
  r = await run(ENV, thrower);
  assert.strictEqual(r.code, 2);
  assertNoLeak(r.out);
});

test('Token/Secret 未設定は 1。deviceId は不要', async function () {
  var f = recFetch({ statusCode: 100, body: { urls: [] } });
  var r = await run({ SWITCHBOT_TOKEN: 't' }, f);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(f.calls.length, 0);
  r = await run(ENV, recFetch({ statusCode: 100, body: { urls: [] } }));
  assert.strictEqual(r.code, 0);
});

test('送信は POST queryWebhook(queryUrl) の 1 回のみ・再送なし', async function () {
  var f = recFetch({ statusCode: 190, body: {} });
  await run(ENV, f);
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].method, 'POST');
  assert.strictEqual(f.calls[0].url, Core.API_BASE + '/v1.1/webhook/queryWebhook');
  assert.deepStrictEqual(JSON.parse(f.calls[0].body), { action: 'queryUrl' });
});

test('スクリプト: 変更系 API を含まない（入口は switchbot-verify-readonly.yml に統合済み）', function () {
  var root = path.join(__dirname, '..');
  var src = fs.readFileSync(path.join(root, 'scripts/switchbot-verify-webhook-raw.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/setupWebhook|deleteWebhook|updateWebhook|createKey|deleteKey|'(PUT|DELETE)'/.test(src));
  assert.strictEqual((src.match(/webhook\/queryWebhook/g) || []).length, 1);
});
