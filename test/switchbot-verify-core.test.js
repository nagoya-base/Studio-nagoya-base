/*
 * gas/switchbot-verify/SwitchBotVerifyCore.gs のテスト（Issue #713）。
 * 実 API・実機には接続しない純粋ロジックのみ。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');
var C = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

function hmac(secret, msg) {
  return crypto.createHmac('sha256', secret).update(msg).digest('base64');
}

test('署名ヘッダ: token+t+nonce の HMAC-SHA256 を大文字 base64 で付与する', function () {
  var h = C.buildAuthHeaders('tok', 'sec', 'n1', 1700000000000, hmac);
  assert.strictEqual(h.Authorization, 'tok');
  assert.strictEqual(h.t, '1700000000000');
  assert.strictEqual(h.nonce, 'n1');
  assert.strictEqual(h.sign, hmac('sec', 'tok1700000000000n1').toUpperCase());
});

test('署名ヘッダ: 認証情報が空なら例外', function () {
  assert.throws(function () { C.buildAuthHeaders('', 'sec', 'n', 1, hmac); }, /AUTH_CREDENTIALS_MISSING/);
  assert.throws(function () { C.buildAuthHeaders('tok', '', 'n', 1, hmac); }, /AUTH_CREDENTIALS_MISSING/);
});

var NOW = 1800000000;
function valid() {
  return { name: 'SNB-API-TEST-1', password: '12345678', startTime: NOW + 300, endTime: NOW + 1200 };
}

test('createKey 検証: 正常値はエラーなし', function () {
  assert.deepStrictEqual(C.validateCreateKeyParams(valid(), NOW), []);
});

test('createKey 検証: startTime >= endTime を拒否する', function () {
  var p = valid(); p.endTime = p.startTime;
  assert.ok(C.validateCreateKeyParams(p, NOW).indexOf('START_NOT_BEFORE_END') !== -1);
  p.endTime = p.startTime - 1;
  assert.ok(C.validateCreateKeyParams(p, NOW).indexOf('START_NOT_BEFORE_END') !== -1);
});

test('createKey 検証: パスコードは6〜12桁の数字のみ、エラーに値を含めない', function () {
  ['12345', '1234567890123', 'abcdef12', ''].forEach(function (pw) {
    var p = valid(); p.password = pw;
    var errs = C.validateCreateKeyParams(p, NOW);
    assert.ok(errs.indexOf('PASSWORD_FORMAT') !== -1, pw);
    assert.ok(JSON.stringify(errs).indexOf('abcdef12') === -1);
  });
  ['123456', '123456789012'].forEach(function (pw) {
    var p = valid(); p.password = pw;
    assert.deepStrictEqual(C.validateCreateKeyParams(p, NOW), []);
  });
});

test('createKey 検証: 10桁でない時刻・過去の終了時刻・空 name を拒否', function () {
  var p = valid(); p.startTime = 1800000000000;
  assert.ok(C.validateCreateKeyParams(p, NOW).indexOf('START_TIME_FORMAT') !== -1);
  p = valid(); p.endTime = NOW - 10;
  assert.ok(C.validateCreateKeyParams(p, NOW).indexOf('END_IN_PAST') !== -1);
  p = valid(); p.name = ' ';
  assert.ok(C.validateCreateKeyParams(p, NOW).indexOf('NAME_REQUIRED') !== -1);
});

test('リクエスト body: timeLimit の createKey / deleteKey を組み立てる', function () {
  var b = C.buildCreateKeyBody(valid());
  assert.strictEqual(b.command, 'createKey');
  assert.strictEqual(b.parameter.type, 'timeLimit');
  assert.strictEqual(b.parameter.startTime, String(NOW + 300));
  assert.deepStrictEqual(C.buildDeleteKeyBody(42), { commandType: 'command', command: 'deleteKey', parameter: { id: 42 } });
  assert.throws(function () { C.buildDeleteKeyBody(''); }, /PASSCODE_ID_REQUIRED/);
  assert.strictEqual(C.buildTestName(NOW), 'SNB-API-TEST-' + NOW);
});

test('テストコード生成: 指定桁数の数字のみ、範囲外の桁数は拒否', function () {
  var pw = C.generateTestPassword(function () { return 7; }, 8);
  assert.strictEqual(pw, '77777777');
  assert.throws(function () { C.generateTestPassword(function () { return 0; }, 5); }, /PASSWORD_LENGTH_RANGE/);
});

test('デバイス絞り込み: Keypad / Keypad Touch のみ', function () {
  var list = [{ deviceType: 'Hub 2' }, { deviceType: 'Keypad' }, { deviceType: 'Keypad Touch' }, { deviceType: 'Lock' }];
  assert.strictEqual(C.pickKeypads(list).length, 2);
  assert.deepStrictEqual(C.pickKeypads(null), []);
});

test('API 応答: HTTP 200 + statusCode 100 でも ACCEPTED_PENDING で APPLIED にしない', function () {
  assert.strictEqual(C.classifyApiResponse(200, { statusCode: 100 }).state, C.STATE.ACCEPTED_PENDING);
  assert.strictEqual(C.classifyApiResponse(401, null).state, C.STATE.FAILED);
  assert.strictEqual(C.classifyApiResponse(200, { statusCode: 190 }).state, C.STATE.FAILED);
  assert.strictEqual(C.classifyApiResponse(200, null).state, C.STATE.FAILED);
});

test('応答 body から commandId / passcode ID を取り出す（無ければ null）', function () {
  assert.deepStrictEqual(C.extractIdsFromResponse({ body: { commandId: 'CMD-1', id: 7 } }), { commandId: 'CMD-1', passcodeId: 7 });
  assert.deepStrictEqual(C.extractIdsFromResponse({ body: {} }), { commandId: null, passcodeId: null });
  assert.deepStrictEqual(C.extractIdsFromResponse(null), { commandId: null, passcodeId: null });
});

function hook(result, eventName) {
  return {
    eventType: 'changeReport', eventVersion: '1',
    context: { deviceType: 'WoKeypad', deviceMac: 'AABBCCDDEEFF', eventName: eventName, commandId: 'CMD-1', result: result, timeOfSample: 123 }
  };
}

test('Webhook: success=APPLIED / failed=FAILED / timeout=UNKNOWN、eventName 末尾空白を許容', function () {
  assert.strictEqual(C.parseKeypadWebhook(hook('success', 'createKey')).state, C.STATE.APPLIED);
  assert.strictEqual(C.parseKeypadWebhook(hook('failed', 'createKey')).state, C.STATE.FAILED);
  assert.strictEqual(C.parseKeypadWebhook(hook('timeout', 'deleteKey')).state, C.STATE.UNKNOWN);
  assert.strictEqual(C.parseKeypadWebhook(hook('success', 'deleteKey ')).eventName, 'deleteKey');
});

test('Webhook: 対象外イベントは null', function () {
  assert.strictEqual(C.parseKeypadWebhook(null), null);
  assert.strictEqual(C.parseKeypadWebhook({ eventType: 'other' }), null);
  var h = hook('success', 'createKey'); h.context.deviceType = 'WoHand';
  assert.strictEqual(C.parseKeypadWebhook(h), null);
  assert.strictEqual(C.parseKeypadWebhook(hook('success', 'lock')), null);
});

test('コマンド状態: Webhook 未着は待機中→待機超過で UNKNOWN、着いたらその結果', function () {
  var pending = { acceptedAtSec: 1000 };
  assert.strictEqual(C.resolveCommandState(pending, null, 1010), C.STATE.ACCEPTED_PENDING);
  assert.strictEqual(C.resolveCommandState(pending, null, 1000 + C.WEBHOOK_WAIT_SEC + 1), C.STATE.UNKNOWN);
  assert.strictEqual(C.resolveCommandState(pending, { state: C.STATE.FAILED }, 1010), C.STATE.FAILED);
});

test('秘匿: token/secret/sign/password は伏せ、ID は下4桁のみ、入れ子も処理', function () {
  var out = C.redact({
    Authorization: 'tok', sign: 's', password: '12345678', secret: 'x',
    deviceId: 'ABCDEF123456', nested: { token: 't', deviceMac: 'AABBCCDDEEFF', keep: 'ok' },
    list: [{ id: 99887766 }]
  });
  var s = JSON.stringify(out);
  ['"tok"', '12345678', 'ABCDEF123456', 'AABBCCDDEEFF', '99887766'].forEach(function (leak) {
    assert.ok(s.indexOf(leak) === -1, leak);
  });
  assert.strictEqual(out.nested.keep, 'ok');
  assert.strictEqual(out.deviceId, '****3456');
});

test('Webhook 認証: 共有トークンの一致のみ許可', function () {
  assert.strictEqual(C.isWebhookAuthorized('abc', 'abc'), true);
  assert.strictEqual(C.isWebhookAuthorized('abd', 'abc'), false);
  assert.strictEqual(C.isWebhookAuthorized('', 'abc'), false);
  assert.strictEqual(C.isWebhookAuthorized('abc', ''), false);
  assert.strictEqual(C.isWebhookAuthorized('abcd', 'abc'), false);
});

test('keyList からの ID 解決: name 一意一致で id を返す', function () {
  var list = [
    { deviceId: 'OTHER', keyList: [{ id: 1, name: 'SNB-API-TEST-1' }] },
    { deviceId: 'DEV1', keyList: [{ id: 10, name: 'regular' }, { id: 11, name: 'SNB-API-TEST-1', type: 'timeLimit' }] }
  ];
  var r = C.resolvePasscodeIdByName(list, 'DEV1', 'SNB-API-TEST-1');
  assert.deepStrictEqual(r, { state: C.STATE.APPLIED, id: 11, error: null });
});

test('keyList からの ID 解決: 0件・複数件・対象デバイス無し・ID欠落は UNKNOWN で id を返さない', function () {
  var dev = function (keys) { return [{ deviceId: 'DEV1', keyList: keys }]; };
  var r = C.resolvePasscodeIdByName(dev([{ id: 10, name: 'x' }]), 'DEV1', 'SNB-API-TEST-1');
  assert.deepStrictEqual([r.state, r.id, r.error], [C.STATE.UNKNOWN, null, 'KEY_NOT_FOUND']);
  r = C.resolvePasscodeIdByName(dev([{ id: 1, name: 'n' }, { id: 2, name: 'n' }]), 'DEV1', 'n');
  assert.deepStrictEqual([r.state, r.id, r.error], [C.STATE.UNKNOWN, null, 'KEY_NAME_AMBIGUOUS']);
  r = C.resolvePasscodeIdByName(dev([]), 'NOPE', 'n');
  assert.deepStrictEqual([r.state, r.id, r.error], [C.STATE.UNKNOWN, null, 'DEVICE_NOT_FOUND']);
  r = C.resolvePasscodeIdByName([{ deviceId: 'DEV1' }], 'DEV1', 'n');
  assert.strictEqual(r.error, 'KEY_NOT_FOUND');
  r = C.resolvePasscodeIdByName(dev([{ name: 'n' }]), 'DEV1', 'n');
  assert.strictEqual(r.error, 'KEY_ID_MISSING');
  r = C.resolvePasscodeIdByName(dev([{ id: 1, name: 'n' }]), 'DEV1', '');
  assert.strictEqual(r.error, 'NAME_REQUIRED');
});
