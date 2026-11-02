/*
 * Issue #720: 完全 deviceId の登録スクリプトと登録後確認のテスト。実 API・実 Secret は使わない（フェイクのみ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');
var Reg = require('../scripts/switchbot-register-device-id.js');
var Ver = require('../scripts/switchbot-verify-device-id.js');

var FULL = 'ABCDEF0123456789AB12';
var ENV = { SWITCHBOT_TOKEN: 'tok-111', SWITCHBOT_SECRET: 'sec-222', KEYPAD_LAST4: 'AB12' };

function fakeFetch(body, status) {
  return async function () {
    return { status: status || 200, json: async function () { return body; } };
  };
}
function ok(list) { return { statusCode: 100, body: { deviceList: list } }; }
function kp(id, type) { return { deviceId: id, deviceType: type || 'Keypad Touch', deviceName: 'k' }; }
function run(fn) {
  var logs = [];
  return fn(function (m) { logs.push(m); }).then(function (code) { return { code: code, out: logs.join('\n') }; });
}
function assertNoLeak(out) {
  ['tok-111', 'sec-222', FULL].forEach(function (s) { assert.ok(out.indexOf(s) === -1, 'leak: ' + s); });
}

test('登録: 一意一致で完全IDを setSecret にのみ渡し、ログは末尾4桁のみ', async function () {
  var passed = [];
  var r = await run(function (log) {
    return Reg.main(ENV, fakeFetch(ok([kp(FULL), kp('XXXXXXXXXXXX0000')])), function (v, o) { passed.push([v, o]); return true; }, log);
  });
  assert.strictEqual(r.code, 0);
  assert.deepStrictEqual(passed.map(function (p) { return p[0]; }), [FULL]);
  assert.strictEqual(passed[0][1].environment, 'switchbot-verify');
  assert.ok(r.out.indexOf('末尾4桁=AB12') !== -1);
  assertNoLeak(r.out);
});

test('登録: 0件・複数件・API失敗・応答不正・認証情報なしでは Secret を書かない', async function () {
  var cases = [
    ['0件', fakeFetch(ok([kp('ZZZZ0000')])), ENV],
    ['複数件', fakeFetch(ok([kp(FULL), kp('OTHER000000AB12')])), ENV],
    ['Keypad以外', fakeFetch(ok([{ deviceId: FULL, deviceType: 'Hub 2' }])), ENV],
    ['API失敗', fakeFetch({ statusCode: 190 }, 200), ENV],
    ['HTTP失敗', fakeFetch({}, 401), ENV],
    ['応答不正', fakeFetch({ statusCode: 100, body: {} }), ENV],
    ['例外', async function () { throw new Error('boom ' + FULL); }, ENV],
    ['末尾4桁不正', fakeFetch(ok([kp(FULL)])), Object.assign({}, ENV, { KEYPAD_LAST4: 'AB1' })],
    ['認証なし', fakeFetch(ok([kp(FULL)])), { KEYPAD_LAST4: 'AB12' }]
  ];
  for (var i = 0; i < cases.length; i++) {
    var called = 0;
    var c = cases[i];
    var r = await run(function (log) {
      return Reg.main(c[2], c[1], function () { called++; return true; }, log);
    });
    assert.strictEqual(r.code, 1, c[0]);
    assert.strictEqual(called, 0, c[0]);
    assertNoLeak(r.out);
  }
});

test('登録: Secret登録の失敗は未完了（成功を表示しない）', async function () {
  var r = await run(function (log) {
    return Reg.main(ENV, fakeFetch(ok([kp(FULL)])), function () { return false; }, log);
  });
  assert.strictEqual(r.code, 1);
  assert.ok(r.out.indexOf('登録成功') === -1);
  assertNoLeak(r.out);
});

test('確認: 完全ID一致1件・Keypad・末尾4桁一致で成功', async function () {
  var r = await run(function (log) {
    return Ver.main(Object.assign({ SWITCHBOT_DEVICE_ID: FULL }, ENV), fakeFetch(ok([kp(FULL), kp('OTHER0000000')])), log);
  });
  assert.strictEqual(r.code, 0);
  assert.ok(r.out.indexOf('末尾4桁=AB12') !== -1);
  assertNoLeak(r.out);
});

test('確認: 未設定・不一致・0件/複数件・種別違い・応答不正は失敗', async function () {
  var base = Object.assign({ SWITCHBOT_DEVICE_ID: FULL }, ENV);
  var cases = [
    ['Secret未設定', Object.assign({}, base, { SWITCHBOT_DEVICE_ID: '' }), fakeFetch(ok([kp(FULL)]))],
    ['完全ID不一致(末尾4桁は同じ)', base, fakeFetch(ok([kp('OTHER000000AB12')]))],
    ['複数件', base, fakeFetch(ok([kp(FULL), kp(FULL)]))],
    ['種別違い', base, fakeFetch(ok([kp(FULL, 'Hub 2')]))],
    ['末尾4桁入力違い', Object.assign({}, base, { KEYPAD_LAST4: 'ZZZZ' }), fakeFetch(ok([kp(FULL)]))],
    ['応答不正', base, fakeFetch({ statusCode: 100, body: {} })],
    ['認証失敗', base, fakeFetch({ statusCode: 190 })]
  ];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    var r = await run(function (log) { return Ver.main(c[1], c[2], log); });
    assert.strictEqual(r.code, 1, c[0]);
    assertNoLeak(r.out);
  }
});

test('Core.verifyKeypadByFullId: エラーに ID を含めない', function () {
  var r = Core.verifyKeypadByFullId([kp('OTHER000000AB12')], FULL, 'AB12');
  assert.deepStrictEqual(r, { ok: false, error: 'NOT_FOUND', count: 0 });
});
