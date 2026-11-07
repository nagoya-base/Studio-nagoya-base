/*
 * Issue #739: queryDetails 読み取り専用診断のテスト。実 API・実 Secret は使わない（フェイクのみ）。
 * 公式 README の現行仕様（POST /v1.1/webhook/queryWebhook, {"action":"queryDetails","urls":[...]}）を固定する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');
var Diag = require('../scripts/switchbot-verify-webhook-details.js');

var ENV = {
  SWITCHBOT_TOKEN: 'tok-111', SWITCHBOT_SECRET: 'sec-222',
  VERIFY_RELAY_URL: 'https://relay.example/hook', VERIFY_WEBHOOK_TOKEN: 'URL-SECRET-999',
  VERIFY_OLD_WEBHOOK_URL: 'https://old.example/hook?t=OLD-SECRET-777'
};

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
  ['tok-111', 'sec-222', 'URL-SECRET-999', 'relay.example', 'OLD-SECRET-777', 'old.example', 'SECRET-MESSAGE', 'SECRET-DETAIL'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'leak: ' + s);
  });
}

test('statusCode=190: 成功扱いせず 0 件・未登録とも断定しない（終了コード 3）', async function () {
  var r = await run(ENV, recFetch({ statusCode: 190, message: '', body: {} }));
  assert.strictEqual(r.code, 3);
  ['HTTP=200', 'JSON=OK', 'statusCode=190', 'message=EMPTY', 'body=OBJECT', 'details=NOT_ARRAY', '判定=NOT_SUCCESS', '未登録・0 件とは断定しない', '読み取り専用。Webhook設定変更なし']
    .forEach(function (s) { assert.ok(r.out.indexOf(s) !== -1, s); });
  assertNoLeak(r.out);
});

test('statusCode=100 + 配列: 件数と既知キー名のみ表示し、値は出さない', async function () {
  var body = [{ url: 'https://relay.example/hook?t=URL-SECRET-999', createTime: 1, lastUpdateTime: 2, deviceList: 'ALL', enable: true, extra: 'SECRET-DETAIL' }];
  var r = await run(ENV, recFetch({ statusCode: 100, message: 'SECRET-MESSAGE', body: body }));
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.indexOf('details=ARRAY count=1') !== -1);
  assert.ok(r.out.indexOf('keys=url,createTime,lastUpdateTime,deviceList,enable other=1') !== -1);
  assert.ok(r.out.indexOf('message=NON_EMPTY') !== -1);
  assert.ok(r.out.indexOf('判定=DETAILS_OK') !== -1);
  assertNoLeak(r.out);
});

test('statusCode=100 でも body が配列でなければ BODY_UNKNOWN（成功扱いしない）', async function () {
  var bodies = [{}, null, 'x', { urls: [] }];
  for (var i = 0; i < bodies.length; i++) {
    var r = await run(ENV, recFetch({ statusCode: 100, body: bodies[i] }));
    assert.strictEqual(r.code, 3, 'case ' + i);
    assert.ok(r.out.indexOf('判定=BODY_UNKNOWN') !== -1);
    assert.ok(r.out.indexOf('details=NOT_ARRAY') !== -1);
  }
  var r2 = await run(ENV, recFetch({ statusCode: 100 }));
  assert.ok(r2.out.indexOf('body=MISSING') !== -1);
  assert.strictEqual(r2.code, 3);
});

test('summarize: 空配列は件数 0 だが keys=NONE。message/statusCode 欠落を区別', function () {
  var s = Diag.summarize(200, { statusCode: 100, body: [] });
  assert.strictEqual(s.count, 0);
  assert.deepStrictEqual(s.knownKeys, []);
  assert.strictEqual(s.message, 'MISSING');
  s = Diag.summarize(200, { body: [] });
  assert.strictEqual(s.statusCode, null);
  assert.strictEqual(Diag.verdict(s), 'NOT_SUCCESS');
});

test('HTTP 非200・JSON 解析不能・例外は成功扱いしない', async function () {
  var r = await run(ENV, recFetch({ statusCode: 100, body: [] }, 500));
  assert.strictEqual(r.code, 3);
  assert.ok(r.out.indexOf('判定=API_FAILED') !== -1);
  r = await run(ENV, recFetch('BADJSON'));
  assert.strictEqual(r.code, 3);
  assert.ok(r.out.indexOf('JSON=FAILED') !== -1);
  var thrower = async function () { throw new Error('boom tok-111 sec-222 URL-SECRET-999'); };
  r = await run(ENV, thrower);
  assert.strictEqual(r.code, 2);
  assertNoLeak(r.out);
});

test('設定不備は 1 で送信しない。deviceId は不要', async function () {
  var f = recFetch({ statusCode: 100, body: [] });
  var r = await run({ SWITCHBOT_TOKEN: 't' }, f);
  assert.strictEqual(r.code, 1);
  r = await run({ SWITCHBOT_TOKEN: 't', SWITCHBOT_SECRET: 's' }, f);
  assert.strictEqual(r.code, 1);
  r = await run(Object.assign({}, ENV, { TARGET: 'old', VERIFY_OLD_WEBHOOK_URL: '' }), f);
  assert.strictEqual(r.code, 1);
  r = await run(Object.assign({}, ENV, { TARGET: 'bogus' }), f);
  assert.strictEqual(r.code, 1);
  assert.strictEqual(f.calls.length, 0);
  r = await run(ENV, recFetch({ statusCode: 100, body: [] }));
  assert.strictEqual(r.code, 0);
});

test('送信は POST queryWebhook(queryDetails, urls=[current]) の 1 回のみ・再送なし', async function () {
  var f = recFetch({ statusCode: 190, body: {} });
  await run(ENV, f);
  assert.strictEqual(f.calls.length, 1);
  assert.strictEqual(f.calls[0].method, 'POST');
  assert.strictEqual(f.calls[0].url, Core.API_BASE + '/v1.1/webhook/queryWebhook');
  assert.deepStrictEqual(JSON.parse(f.calls[0].body), { action: 'queryDetails', urls: ['https://relay.example/hook?t=URL-SECRET-999'] });
});

test('TARGET=old は旧 URL を 1 回だけ照会する', async function () {
  var f = recFetch({ statusCode: 100, body: [] });
  await run(Object.assign({}, ENV, { TARGET: 'old' }), f);
  assert.strictEqual(f.calls.length, 1);
  assert.deepStrictEqual(JSON.parse(f.calls[0].body), { action: 'queryDetails', urls: [ENV.VERIFY_OLD_WEBHOOK_URL] });
});

test('照会 URL の組み立ては既存 webhook-query と同じ（?/& 判定と token エンコード）', function () {
  assert.strictEqual(Diag.resolveTarget({ VERIFY_RELAY_URL: 'https://r.example/x?a=1', VERIFY_WEBHOOK_TOKEN: 'a b' }), 'https://r.example/x?a=1&t=a%20b');
});

test('スクリプト: 変更系 API を含まない（入口は switchbot-verify-readonly.yml に統合済み）', function () {
  var root = path.join(__dirname, '..');
  var src = fs.readFileSync(path.join(root, 'scripts/switchbot-verify-webhook-details.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
  assert.ok(!/setupWebhook|deleteWebhook|updateWebhook|createKey|deleteKey|'(PUT|DELETE)'/.test(src));
  assert.ok(!/retry|setTimeout/i.test(src));
  assert.strictEqual((src.match(/webhook\/queryWebhook/g) || []).length, 1);
  var raw = fs.readFileSync(path.join(root, 'scripts/switchbot-verify-webhook-raw.js'), 'utf8');
  assert.ok(!/queryDetails/.test(raw.replace(/\/\*[\s\S]*?\*\//, '')));
});
