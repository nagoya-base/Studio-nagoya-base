/*
 * Issue #791: verify環境専用・37DD 段階承認型 API 単体試験入口のテスト。
 * 実GAS・実API・実秘密には接続しない。値はすべてテスト内のダミー（偽のSwitchBot端末をメモリ上に持つ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var crypto = require('crypto');
var Infra = require('../gas/switchbot-access/SwitchBotAccessInfra.gs');
var prepare = require('../scripts/prepare-switchbot-access-gas-project');

var ADMIN = 'owner@example.test';
var DEVICE = 'DEVICE000000037DD';
var OTHER = 'DEVICE00000001FD';
var SECRETS = { SWITCHBOT_TOKEN: 'dummy-token-' + 'a1b2c3d4'.repeat(4), SWITCHBOT_SECRET: 'dummy-secret-' + 'e5f6a7b8'.repeat(3) };
var EXISTING = [{ id: 'EXIST-ID-AAA111', name: 'normal-key-1', type: 'timeLimit' }, { id: 'EXIST-ID-BBB222', name: 'normal-key-2', type: 'permanent' }];

function sha(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function cfgJson(over) {
  return JSON.stringify(Object.assign({ environment: 'verify', allowedLast4: ['37DD'], keypads: [{ deviceId: DEVICE }],
    ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test'] }, over || {}));
}

/** 偽の SwitchBot 端末 + Properties + ロック。o.* で故障を注入する。 */
function makeWorld(o) {
  o = o || {};
  var w = {
    script: Object.assign({ ACCESS_CONFIG: cfgJson(), ACCESS_ENVIRONMENT: 'verify', ACCESS_ENABLED: 'false',
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }), ACCESS_TEST_KEY_ARMED: 'true' }, o.script || {}),
    user: Object.assign({}, 'user' in o ? o.user : SECRETS),
    keys: (o.keys || EXISTING).map(function (k) { return Object.assign({}, k); }),
    calls: [], created: null, passwords: [], locks: 0, lockBusy: !!o.lockBusy, triggers: o.triggers || 0, nextId: 1, email: ADMIN, effective: ADMIN
  };
  function listBody() { return { ok: true, devices: [{ deviceId: DEVICE, keyList: w.keys.map(function (k) { return Object.assign({}, k); }) }].concat(o.extraDevice ? [{ deviceId: OTHER, keyList: [] }] : []) }; }
  w.deps = {
    identity: function () { return { email: w.email, effectiveEmail: w.effective }; },
    adminActors: { 'owner@example.test': 'ADMIN-1' },
    accessFlag: function () { return w.script.ACCESS_ENABLED === undefined ? null : w.script.ACCESS_ENABLED; },
    scriptProps: {
      get: function (k) { if (o.failScriptRead && o.failScriptRead(k)) throw new Error('LEAK-ME ' + SECRETS.SWITCHBOT_TOKEN); return w.script[k] === undefined ? null : w.script[k]; },
      set: function (k, v) { if (o.failStateWrite && k === 'ACCESS_TEST_KEY_STATE' && o.failStateWrite()) throw new Error('write fail'); w.script[k] = v; },
      del: function (k) { if (o.failApprovalDel && k === 'ACCESS_TEST_KEY_APPROVAL') throw new Error('del fail'); delete w.script[k]; }
    },
    userProps: {
      get: function (k) { return w.user[k] === undefined ? null : w.user[k]; },
      set: function (k, v) { w.user[k] = v; }, del: function (k) { delete w.user[k]; }
    },
    lock: { tryLock: function () { w.locks++; return !w.lockBusy; }, releaseLock: function () {} },
    triggerCount: function () { if (o.triggerUnknown) throw new Error('x'); return w.triggers; },
    api: {
      listDevices: function () {
        w.calls.push('list');
        if (o.listThrow && o.listThrow(w.calls.length)) throw new Error('timeout');
        if (o.listFail && o.listFail(w.calls.length)) return { ok: false, error: 'LIST_API_ERROR' };
        var b = listBody(); if (o.mutateList) o.mutateList(b, w.calls.length); return b;
      },
      createKey: function (p) {
        w.calls.push('create'); w.passwords.push(p.password); w.created = { name: p.name, deviceId: p.deviceId };
        if (o.createThrow) throw new Error('timeout');
        if (o.createReject) return { httpCode: 200, parsed: { statusCode: 190, body: {} } };
        if (!o.createNoApply) w.keys.push({ id: 'TEST-ID-' + (w.nextId++), name: p.name, type: 'timeLimit', startTime: String(p.startTime), endTime: String(p.endTime) });
        return { httpCode: 200, parsed: { statusCode: 100, body: o.noCommandId ? {} : { commandId: 'CMD-SECRET-1' } } };
      },
      deleteKey: function (d, id) {
        w.calls.push('delete:' + d + ':' + id);
        if (o.deleteThrow) throw new Error('timeout');
        if (!o.deleteNoApply) w.keys = w.keys.filter(function (k) { return k.id !== id; });
        return { httpCode: 200, parsed: { statusCode: 100, body: { commandId: 'CMD-SECRET-2' } } };
      }
    },
    sha256Hex: sha,
    randomInt: function (n) { return Math.floor(Math.random() * n); },
    nowSec: function () { return 1800000000; }
  };
  return w;
}

function step(w, stage, approval) {
  if (approval !== null) w.script.ACCESS_TEST_KEY_APPROVAL = approval === undefined ? stage : approval;
  return JSON.parse(JSON.stringify(Infra.testKeyStage(w.deps, stage)));
}
function state(w) { return JSON.parse(w.script.ACCESS_TEST_KEY_STATE || '{"state":"INIT","calls":0}'); }
function leakCheck(w, r) {
  var all = JSON.stringify(r);
  Object.keys(SECRETS).forEach(function (k) { assert.ok(all.indexOf(SECRETS[k]) === -1); });
  [DEVICE, OTHER, ADMIN, 'ADMIN-1', 'EXIST-ID', 'TEST-ID-', 'CMD-SECRET', 'LEAK-ME', 'ops@example.test', 'normal-key'].forEach(function (x) { assert.ok(all.indexOf(x) === -1, 'leak ' + x); });
  if (w.created) assert.ok(all.indexOf(w.created.name) === -1, 'キー名を出さない');
  w.passwords.forEach(function (p) { assert.ok(all.indexOf(p) === -1); });
}
function runAll(w) {
  return ['LIST', 'ISSUE', 'VERIFY_ISSUED', 'DELETE', 'VERIFY_DELETED'].map(function (s) { return step(w, s); });
}

test('正常系: 5段階で API は合計5回（list,create,list,delete,list）。既存キー不変・試験キーのみ削除・COMPLETE', function () {
  var w = makeWorld();
  var rs = runAll(w);
  rs.forEach(function (r) { assert.strictEqual(r.ok, true, JSON.stringify(r)); leakCheck(w, r); assert.strictEqual(r.apiCalls, 1); });
  assert.deepStrictEqual(rs.map(function (r) { return r.callsUsed; }), [1, 2, 3, 4, 5]);
  assert.strictEqual(w.calls.length, 5);
  assert.deepStrictEqual(w.calls.map(function (c) { return c.split(':')[0]; }), ['list', 'create', 'list', 'delete', 'list']);
  assert.deepStrictEqual(w.keys.map(function (k) { return k.id; }), ['EXIST-ID-AAA111', 'EXIST-ID-BBB222'], '既存キーのみ残る');
  assert.ok(w.calls[3].indexOf('delete:' + DEVICE + ':TEST-ID-1') === 0, '削除対象は試験キーのみ・37DDのみ');
  assert.strictEqual(state(w).state, 'COMPLETE');
  assert.strictEqual(rs[1].evidence, 'API_ACCEPTED_WITH_COMMAND_ID');
  assert.strictEqual(w.script.ACCESS_TEST_KEY_APPROVAL, undefined, '承認は消費済み');
  assert.strictEqual(w.user.TESTKEY_ID, undefined, '試験キーIDは後片付け済み');
  assert.ok(!/TST[A-Z0-9]{8}/.test(JSON.stringify(rs)));
});

test('既定OFF: ARMED 未設定/false/不正では何も通信しない（承認があっても）', function () {
  [undefined, 'false', 'TRUE', '1', ''].forEach(function (v) {
    var w = makeWorld({ script: { ACCESS_TEST_KEY_ARMED: v } });
    if (v === undefined) delete w.script.ACCESS_TEST_KEY_ARMED;
    var r = step(w, 'LIST');
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'NOT_ARMED'); assert.strictEqual(w.calls.length, 0);
    assert.strictEqual(w.script.ACCESS_TEST_KEY_STATE, undefined, '状態も作らない');
  });
  var w2 = makeWorld({ script: { ACCESS_TEST_KEY_ARMED: undefined } });
  assert.strictEqual(w2.script.ACCESS_TEST_KEY_ARMED, undefined);
});

test('段階承認: 承認なし・別段階名の承認・不正値では通信しない。承認は1回で消費', function () {
  var w = makeWorld();
  var r = step(w, 'LIST', null); assert.strictEqual(r.code, 'STAGE_NOT_APPROVED');
  r = step(w, 'LIST', 'ISSUE'); assert.strictEqual(r.code, 'STAGE_NOT_APPROVED');
  r = step(w, 'LIST', 'list'); assert.strictEqual(r.code, 'STAGE_NOT_APPROVED');
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(step(w, 'LIST', 'LIST').ok, true);
  assert.strictEqual(w.script.ACCESS_TEST_KEY_APPROVAL, undefined);
  r = step(w, 'ISSUE', null); assert.strictEqual(r.code, 'STAGE_NOT_APPROVED'); assert.strictEqual(w.calls.length, 1);
});

test('二重押下: 同じ段階の再実行・順序飛ばし・事前の承認では通信しない', function () {
  var w = makeWorld();
  assert.strictEqual(step(w, 'LIST').ok, true);
  var r = step(w, 'LIST'); assert.strictEqual(r.ok, false); assert.ok(['STAGE_ALREADY_DONE', 'STAGE_ORDER_VIOLATION'].indexOf(r.code) !== -1);
  r = step(w, 'DELETE'); assert.strictEqual(r.code, 'STAGE_ORDER_VIOLATION');
  r = step(w, 'VERIFY_DELETED'); assert.strictEqual(r.code, 'STAGE_ORDER_VIOLATION');
  assert.strictEqual(step(w, 'ISSUE').ok, true);
  r = step(w, 'ISSUE'); assert.strictEqual(r.ok, false);
  assert.strictEqual(w.calls.filter(function (c) { return c === 'create'; }).length, 1, 'createKey は1回だけ');
  assert.strictEqual(w.keys.length, 3);
});

test('既存キーの属性（名前・種別・有効期間）がIDそのままで変わっても EXISTING_KEYS_CHANGED（#792レビュー）', function () {
  [['name', 'renamed'], ['type', 'permanent'], ['startTime', '123']].forEach(function (c) {
    var w = makeWorld({ mutateList: function (b, n) { if (n === 3) b.devices[0].keyList[0][c[0]] = c[1]; } });
    step(w, 'LIST'); step(w, 'ISSUE');
    var r = step(w, 'VERIFY_ISSUED'); assert.strictEqual(r.code, 'EXISTING_KEYS_CHANGED', c[0]);
    assert.ok(!w.calls.some(function (x) { return x.indexOf('delete') === 0; }));
  });
  var w2 = makeWorld({ mutateList: function (b, n) { if (n === 5) b.devices[0].keyList[1].name = 'renamed'; } });
  ['LIST', 'ISSUE', 'VERIFY_ISSUED', 'DELETE'].forEach(function (x) { step(w2, x); });
  assert.strictEqual(step(w2, 'VERIFY_DELETED').code, 'EXISTING_KEYS_CHANGED');
});

test('対象端末の固定: 設定の端末が途中で別の37DD端末に変わったら、以降の段階は通信しない（#792レビュー）', function () {
  var w = makeWorld(); ['LIST', 'ISSUE', 'VERIFY_ISSUED'].forEach(function (x) { step(w, x); });
  w.script.ACCESS_CONFIG = cfgJson({ keypads: [{ deviceId: 'DIFFERENT000037DD' }] });
  var before = w.calls.length;
  var r = step(w, 'DELETE'); assert.strictEqual(r.code, 'TARGET_DEVICE_CHANGED');
  assert.strictEqual(w.calls.length, before, '削除を送らない');
  assert.strictEqual(w.script.ACCESS_TEST_KEY_APPROVAL, 'DELETE', '承認も消費しない');
  ['ISSUE', 'VERIFY_ISSUED', 'VERIFY_DELETED'].forEach(function (x) { assert.strictEqual(step(w, x).ok, false); });
  w = makeWorld(); step(w, 'LIST'); var st = state(w); delete st.deviceFp; w.script.ACCESS_TEST_KEY_STATE = JSON.stringify(st);
  assert.strictEqual(step(w, 'ISSUE').code, 'TARGET_DEVICE_CHANGED');
});

test('ロック競合（同時実行）: LOCK_UNAVAILABLE で通信しない', function () {
  var w = makeWorld({ lockBusy: true });
  var r = step(w, 'LIST'); assert.strictEqual(r.code, 'LOCK_UNAVAILABLE'); assert.strictEqual(w.calls.length, 0);
});

test('認可失敗: 非管理者・ACCOUNT_MISMATCH・本人不明は通信しない', function () {
  var w = makeWorld(); w.email = 'intruder@example.test';
  assert.strictEqual(step(w, 'LIST').code, 'NOT_AUTHORIZED');
  w = makeWorld(); w.effective = 'other@example.test';
  assert.strictEqual(step(w, 'LIST').code, 'ACCOUNT_MISMATCH');
  w = makeWorld(); w.email = '';
  assert.strictEqual(step(w, 'LIST').code, 'IDENTITY_UNAVAILABLE');
  assert.strictEqual(w.calls.length, 0);
});

test('OFF維持/環境ゲート: ACCESS_ENABLED=true・未設定・不正値・verify不一致・production・設定不備は通信しない', function () {
  function code(over, cfgOver) {
    var w = makeWorld({ script: over });
    if (cfgOver) w.script.ACCESS_CONFIG = cfgJson(cfgOver);
    var r = step(w, 'LIST'); assert.strictEqual(w.calls.length, 0); return r.code;
  }
  assert.strictEqual(code({ ACCESS_ENABLED: 'true' }), 'ACCESS_NOT_OFF');
  assert.strictEqual(code({ ACCESS_ENABLED: 'yes' }), 'ACCESS_STATE_UNKNOWN');
  var w = makeWorld(); delete w.script.ACCESS_ENABLED; assert.strictEqual(step(w, 'LIST').code, 'ACCESS_FLAG_NOT_EXPLICIT_OFF'); assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(code({ ACCESS_ENVIRONMENT: 'production' }), 'ENV_NOT_VERIFY');
  assert.strictEqual(code({ ACCESS_ENVIRONMENT: undefined }), 'SETTINGS_INCOMPLETE');
  assert.strictEqual(code({}, { environment: 'production' }), 'ENV_MISMATCH');
  assert.strictEqual(code({ ACCESS_CONFIG: '{not json' }), 'CONFIG_INVALID');
  assert.strictEqual(code({}, { adminMailTo: [] }), 'CONFIG_INVALID');
});

test('01FD混入・37DD以外・複数端末は通信しない', function () {
  function code(cfgOver) { var w = makeWorld(); w.script.ACCESS_CONFIG = cfgJson(cfgOver); var r = step(w, 'LIST'); assert.strictEqual(w.calls.length, 0); return r.code; }
  assert.strictEqual(code({ allowedLast4: ['37DD', '01FD'] }), 'LAST4_FORBIDDEN');
  assert.strictEqual(code({ keypads: [{ deviceId: DEVICE }, { deviceId: OTHER }], allowedLast4: ['37DD', '01FD'] }), 'LAST4_FORBIDDEN');
  assert.strictEqual(code({ keypads: [{ deviceId: DEVICE }, { deviceId: OTHER }] }), 'CONFIG_INVALID');
  assert.strictEqual(code({ allowedLast4: ['AAAA'], keypads: [{ deviceId: 'DEVICE0000000AAAA' }] }), 'LAST4_MISMATCH');
  assert.strictEqual(code({ keypads: [{ deviceId: DEVICE }, { deviceId: 'DEVICE0000000037DD' }] }), 'LAST4_MISMATCH');
});

test('トリガーが1件でもある・取得不能なら通信しない', function () {
  var w = makeWorld({ triggers: 1 }); assert.strictEqual(step(w, 'LIST').code, 'TRIGGERS_PRESENT'); assert.strictEqual(w.calls.length, 0);
  w = makeWorld({ triggerUnknown: true }); assert.strictEqual(step(w, 'LIST').code, 'TRIGGER_STATE_UNKNOWN'); assert.strictEqual(w.calls.length, 0);
});

test('資格情報欠落: 通信せず、状態を進めない（認証情報の登録は別承認）', function () {
  var w = makeWorld({ user: {} }); var r = step(w, 'LIST');
  assert.strictEqual(r.code, 'AUTH_CREDENTIALS_MISSING'); assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(w.script.ACCESS_TEST_KEY_STATE, undefined);
  assert.strictEqual(w.script.ACCESS_TEST_KEY_APPROVAL, 'LIST', '承認も消費しない');
});

test('通信タイムアウト/結果不明（list）: STOPPED。自動再送なし・次段階も止まる', function () {
  var w = makeWorld({ listThrow: function () { return true; } });
  var r = step(w, 'LIST'); assert.strictEqual(r.code, 'LIST_COMM_ERROR'); assert.strictEqual(r.manualRecovery, true);
  assert.strictEqual(w.calls.length, 1);
  r = step(w, 'LIST'); assert.strictEqual(r.code, 'STOPPED_MANUAL_RECOVERY'); r = step(w, 'ISSUE'); assert.strictEqual(r.code, 'STOPPED_MANUAL_RECOVERY');
  assert.strictEqual(w.calls.length, 1, '再送しない');
  leakCheck(w, r);
});

test('通信タイムアウト/結果不明（createKey）: ISSUE_RESULT_UNKNOWN で停止。再送・削除を自動で行わない', function () {
  var w = makeWorld({ createThrow: true });
  assert.strictEqual(step(w, 'LIST').ok, true);
  var r = step(w, 'ISSUE'); assert.strictEqual(r.code, 'ISSUE_RESULT_UNKNOWN'); assert.strictEqual(r.manualRecovery, true);
  ['ISSUE', 'VERIFY_ISSUED', 'DELETE', 'VERIFY_DELETED'].forEach(function (s) { assert.strictEqual(step(w, s).ok, false); });
  assert.deepStrictEqual(w.calls, ['list', 'create']);
  leakCheck(w, r);
});

test('createKey が拒否（statusCode≠100）: 停止し、再送しない', function () {
  var w = makeWorld({ createReject: true });
  step(w, 'LIST'); var r = step(w, 'ISSUE');
  assert.strictEqual(r.code, 'ISSUE_RESULT_UNKNOWN'); assert.strictEqual(step(w, 'ISSUE').ok, false);
  assert.strictEqual(w.calls.filter(function (c) { return c === 'create'; }).length, 1);
});

test('commandId なし: 受理を根拠にせず keyList で確認。証跡区分を分ける', function () {
  var w = makeWorld({ noCommandId: true });
  step(w, 'LIST'); var r = step(w, 'ISSUE');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.evidence, 'API_ACCEPTED_NO_COMMAND_ID');
  r = step(w, 'VERIFY_ISSUED'); assert.strictEqual(r.ok, true); assert.strictEqual(r.evidence, 'KEYLIST');
});

test('受理されたが keyList に反映なし/複数/件数矛盾/既存キー変化: 停止（手動確認）', function () {
  var w = makeWorld({ createNoApply: true }); step(w, 'LIST'); step(w, 'ISSUE');
  var r = step(w, 'VERIFY_ISSUED'); assert.strictEqual(r.code, 'KEY_NOT_FOUND'); assert.strictEqual(r.manualRecovery, true);
  assert.strictEqual(step(w, 'DELETE').ok, false);
  assert.ok(!w.calls.some(function (c) { return c.indexOf('delete') === 0; }), '削除しない');

  w = makeWorld({ mutateList: function (b, n) { if (n === 3) { var k = b.devices[0].keyList; k.push(Object.assign({}, k[k.length - 1])); k[k.length - 1].id = 'DUP-OTHER'; } } });
  step(w, 'LIST'); step(w, 'ISSUE'); r = step(w, 'VERIFY_ISSUED'); assert.strictEqual(r.code, 'KEY_NAME_AMBIGUOUS');

  w = makeWorld({ mutateList: function (b, n) { if (n === 3) b.devices[0].keyList.push({ id: 'SOMEONE-ELSE', name: 'added-by-other' }); } });
  step(w, 'LIST'); step(w, 'ISSUE'); r = step(w, 'VERIFY_ISSUED'); assert.strictEqual(r.code, 'KEYLIST_COUNT_MISMATCH');

  w = makeWorld({ mutateList: function (b, n) { if (n === 3) b.devices[0].keyList[0].id = 'CHANGED-ID'; } });
  step(w, 'LIST'); step(w, 'ISSUE'); r = step(w, 'VERIFY_ISSUED'); assert.strictEqual(r.code, 'EXISTING_KEYS_CHANGED');
  assert.ok(!w.calls.some(function (c) { return c.indexOf('delete') === 0; }));
});

test('一覧に異常（端末不在・keyList欠落・要素の不備・重複ID）/ API失敗: 変更操作に進まない', function () {
  var cases = [
    [function (b) { b.devices = []; }, 'DEVICE_NOT_FOUND'],
    [function (b) { delete b.devices[0].keyList; }, 'KEYLIST_INVALID'],
    [function (b) { b.devices[0].keyList.push({ id: '', name: 'x' }); }, 'KEYLIST_ENTRY_INVALID'],
    [function (b) { b.devices[0].keyList.push({ id: 'EXIST-ID-AAA111', name: 'dup' }); }, 'KEYLIST_DUPLICATE_ID'],
    [function (b) { b.devices.push({ deviceId: DEVICE, keyList: [] }); }, 'DEVICE_AMBIGUOUS']
  ];
  cases.forEach(function (c) {
    var w = makeWorld({ mutateList: c[0] }); var r = step(w, 'LIST');
    assert.strictEqual(r.code, c[1]); assert.strictEqual(step(w, 'ISSUE').ok, false);
    assert.strictEqual(w.calls.length, 1);
  });
  var w2 = makeWorld({ listFail: function () { return true; } }); assert.strictEqual(step(w2, 'LIST').code, 'LIST_API_ERROR');
});

test('既に試験キー形式の名前がある（すでに発行済み）/ 容量問題: 発行しない', function () {
  var w = makeWorld({ keys: EXISTING.concat([{ id: 'OLD-TEST', name: 'TSTABCD2345', type: 'timeLimit' }]) });
  assert.strictEqual(step(w, 'LIST').code, 'STALE_TEST_KEY_PRESENT'); assert.strictEqual(step(w, 'ISSUE').ok, false);
  var many = []; for (var i = 0; i < 80; i++) many.push({ id: 'K' + i, name: 'n' + i });
  w = makeWorld({ keys: many }); assert.strictEqual(step(w, 'LIST').ok, true);
  var r = step(w, 'ISSUE'); assert.strictEqual(r.code, 'CAPACITY_REACHED'); assert.ok(!w.calls.some(function (c) { return c === 'create'; }));
});

test('対象外削除拒否: 状態/キーID/名前が揃わなければ deleteKey を呼ばない。削除は保存済み試験キーIDのみ', function () {
  var w = makeWorld(); step(w, 'LIST'); step(w, 'ISSUE'); step(w, 'VERIFY_ISSUED');
  delete w.user.TESTKEY_ID;
  assert.strictEqual(step(w, 'DELETE').code, 'TEST_KEY_ID_MISSING');
  assert.ok(!w.calls.some(function (c) { return c.indexOf('delete') === 0; }));
  w = makeWorld(); step(w, 'LIST'); step(w, 'ISSUE'); step(w, 'VERIFY_ISSUED');
  var st = state(w); st.name = 'normal-key-1'; w.script.ACCESS_TEST_KEY_STATE = JSON.stringify(st);
  assert.strictEqual(step(w, 'DELETE').code, 'TEST_KEY_NAME_MISSING');
  assert.ok(!w.calls.some(function (c) { return c.indexOf('delete') === 0; }));
  w = makeWorld(); step(w, 'LIST'); step(w, 'ISSUE'); step(w, 'VERIFY_ISSUED'); step(w, 'DELETE');
  assert.ok(w.calls.filter(function (c) { return c.indexOf('delete') === 0; }).every(function (c) { return /TEST-ID-\d+$/.test(c); }));
  assert.strictEqual(w.keys.length, 2);
});

test('削除が反映されない/例外: 停止。再削除を自動で行わず、回数上限も守る', function () {
  var w = makeWorld({ deleteNoApply: true });
  ['LIST', 'ISSUE', 'VERIFY_ISSUED', 'DELETE'].forEach(function (x) { assert.strictEqual(step(w, x).ok, true); });
  var r = step(w, 'VERIFY_DELETED'); assert.strictEqual(r.code, 'TEST_KEY_STILL_PRESENT'); assert.strictEqual(r.manualRecovery, true);
  assert.strictEqual(step(w, 'DELETE').ok, false);
  assert.strictEqual(w.calls.filter(function (c) { return c.indexOf('delete') === 0; }).length, 1);
  assert.ok(w.calls.length <= 5);

  w = makeWorld({ deleteThrow: true }); step(w, 'LIST'); step(w, 'ISSUE'); step(w, 'VERIFY_ISSUED');
  r = step(w, 'DELETE'); assert.strictEqual(r.code, 'DELETE_RESULT_UNKNOWN'); assert.strictEqual(r.manualRecovery, true);
  assert.strictEqual(step(w, 'VERIFY_DELETED').ok, false);
  assert.strictEqual(w.calls.filter(function (c) { return c.indexOf('delete') === 0; }).length, 1);
});

test('通信中断（送信済みマーカーだけ残った状態）: 次段階を止め、要手動復旧', function () {
  var w = makeWorld(); step(w, 'LIST');
  var st = state(w); st.state = 'ISSUE_SENT'; st.name = 'TSTABCDEFGH'; w.script.ACCESS_TEST_KEY_STATE = JSON.stringify(st);
  var r = step(w, 'ISSUE'); assert.strictEqual(r.code, 'INTERRUPTED_MANUAL_RECOVERY'); assert.strictEqual(r.manualRecovery, true);
  assert.strictEqual(w.calls.length, 1);
});

test('永続に失敗したら通信しない（状態書込み失敗・承認消費失敗・状態破損・読取不能）', function () {
  var w = makeWorld({ failStateWrite: function () { return true; } });
  assert.strictEqual(step(w, 'LIST').code, 'STATE_WRITE_FAILED'); assert.strictEqual(w.calls.length, 0);
  w = makeWorld({ failApprovalDel: true }); assert.strictEqual(step(w, 'LIST').code, 'APPROVAL_CONSUME_FAILED'); assert.strictEqual(w.calls.length, 0);
  w = makeWorld(); w.script.ACCESS_TEST_KEY_STATE = '{broken'; assert.strictEqual(step(w, 'LIST').code, 'STATE_UNREADABLE'); assert.strictEqual(w.calls.length, 0);
  w = makeWorld(); w.script.ACCESS_TEST_KEY_STATE = JSON.stringify({ v: 1, state: 'INIT', calls: 99 }); assert.strictEqual(step(w, 'LIST').code, 'STATE_UNREADABLE');
  w = makeWorld({ failScriptRead: function (k) { return k === 'ACCESS_TEST_KEY_STATE'; } }); assert.strictEqual(step(w, 'LIST').code, 'STATE_UNREADABLE'); assert.strictEqual(w.calls.length, 0);
});

test('呼出し回数の上限: 5回で打ち止め（改ざん状態でも超えない）', function () {
  var w = makeWorld(); step(w, 'LIST');
  var st = state(w); st.calls = 5; w.script.ACCESS_TEST_KEY_STATE = JSON.stringify(st);
  var r = step(w, 'ISSUE'); assert.strictEqual(r.code, 'CALL_BUDGET_EXHAUSTED'); assert.strictEqual(w.calls.length, 1);
  assert.strictEqual(Infra.TKS_MAX_CALLS, 5);
});

test('完了後は再実行不可（ALREADY_COMPLETE）。不正な段階名は拒否', function () {
  var w = makeWorld(); runAll(w);
  assert.strictEqual(step(w, 'LIST').code, 'ALREADY_COMPLETE'); assert.strictEqual(w.calls.length, 5);
  assert.strictEqual(step(w, 'NOPE').code, 'INVALID_STAGE');
});

test('ステータス確認: 通信0・値を出さず、ゲート/ARMED/承認/回数のみ', function () {
  var w = makeWorld(); step(w, 'LIST'); w.script.ACCESS_TEST_KEY_APPROVAL = 'ISSUE';
  var before = w.calls.length;
  var r = JSON.parse(JSON.stringify(Infra.testKeyStatus(w.deps)));
  assert.strictEqual(w.calls.length, before); assert.strictEqual(r.ok, true); assert.strictEqual(r.state, 'LISTED');
  assert.strictEqual(r.armed, 'ON'); assert.strictEqual(r.approvedStage, 'ISSUE'); assert.strictEqual(r.callsUsed, 1); assert.strictEqual(r.gates, 'PASS');
  leakCheck(w, r);
  var off = makeWorld({ script: { ACCESS_ENABLED: 'true' } });
  assert.strictEqual(JSON.parse(JSON.stringify(Infra.testKeyStatus(off.deps))).gates, 'ACCESS_NOT_OFF');
});

test('ログ秘匿: 失敗系を含む全出力に秘密・完全ID・キー名・パスコード・commandIdがない', function () {
  [{}, { createThrow: true }, { noCommandId: true }, { createNoApply: true }, { deleteNoApply: true }, { listThrow: function (n) { return n === 3; } }].forEach(function (o) {
    var w = makeWorld(o); runAll(w).forEach(function (r) { leakCheck(w, r); });
  });
});

// ── GAS シェル経由（実際の入口関数・UrlFetchApp 注入・User Properties）──
function loadShell(o) {
  o = o || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba791-'));
  prepare.prepareProject(out);
  var w = makeWorld(o); var env = { w: w, fetches: [], mails: 0, logs: [], sheetCalls: 0, triggerWrites: 0 };
  function props(m, isUser) {
    return {
      getProperty: function (k) { return m[k] === undefined ? null : m[k]; },
      setProperty: function (k, v) { m[k] = v; }, deleteProperty: function (k) { delete m[k]; },
      getKeys: function () { return Object.keys(m); }
    };
  }
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(w.script); }, getUserProperties: function () { return props(w.user, true); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return w.email; } }; }, getEffectiveUser: function () { return { getEmail: function () { return w.effective; } }; } },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    LockService: { getScriptLock: function () { return w.deps.lock; } },
    ScriptApp: { getProjectTriggers: function () { return new Array(w.triggers); }, newTrigger: function () { env.triggerWrites++; throw new Error('no'); }, deleteTrigger: function () { env.triggerWrites++; }, getOAuthToken: function () { env.sheetCalls++; return 'x'; } },
    MailApp: { sendEmail: function () { env.mails++; }, getRemainingDailyQuota: function () { return 100; } },
    UrlFetchApp: {
      fetch: function (url, options) {
        var u = String(url);
        if (u.indexOf('https://api.switch-bot.com/') !== 0) throw new Error('no external fetch: ' + u.split('/')[2]);
        env.fetches.push({ method: options.method, path: u.slice('https://api.switch-bot.com'.length), body: options.payload ? JSON.parse(options.payload) : null });
        var f = env.fetches[env.fetches.length - 1];
        function R(code, b) { return { getResponseCode: function () { return code; }, getContentText: function () { return JSON.stringify(b); } }; }
        if (f.method === 'get' && f.path === '/v1.1/devices') return R(200, { statusCode: 100, body: { deviceList: [{ deviceId: DEVICE, keyList: w.keys.slice() }] } });
        var m = /^\/v1\.1\/devices\/([^/]+)\/commands$/.exec(f.path);
        if (f.method === 'post' && m && m[1] === DEVICE && f.body.command === 'createKey') {
          w.keys.push({ id: 'TEST-ID-S' + (w.nextId++), name: f.body.parameter.name, type: 'timeLimit', startTime: f.body.parameter.startTime, endTime: f.body.parameter.endTime });
          return R(200, { statusCode: 100, body: { commandId: 'CMD-SECRET-9' } });
        }
        if (f.method === 'post' && m && m[1] === DEVICE && f.body.command === 'deleteKey') {
          w.keys = w.keys.filter(function (k) { return k.id !== f.body.parameter.id; });
          return R(200, { statusCode: 100, body: { commandId: 'CMD-SECRET-8' } });
        }
        throw new Error('unexpected request');
      }
    },
    Utilities: {
      base64Encode: function (b) { return Buffer.from(b).toString('base64'); },
      computeHmacSha256Signature: function (m, k) { return Array.from(crypto.createHmac('sha256', k).update(m).digest()); },
      getUuid: function () { return crypto.randomUUID(); },
      computeDigest: function (a, v) { return Array.from(crypto.createHash('sha256').update(v).digest()).map(function (x) { return x > 127 ? x - 256 : x; }); },
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }
    },
    ContentService: {}, SpreadsheetApp: { openById: function () { env.sheetCalls++; throw new Error('no'); } }
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) { vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n }); });
  env.ctx = ctx; return env;
}
function plain(x) { return JSON.parse(JSON.stringify(x)); }

test('シェル: 入口関数が存在し、ARMED なしのデプロイ直後は通信ゼロ・状態書込みなし', function () {
  var env = loadShell(); delete env.w.script.ACCESS_TEST_KEY_ARMED;
  ['accessTestKeyStep1List', 'accessTestKeyStep2Issue', 'accessTestKeyStep3VerifyIssued', 'accessTestKeyStep4Delete', 'accessTestKeyStep5VerifyDeleted'].forEach(function (fn) {
    assert.strictEqual(typeof env.ctx[fn], 'function', fn);
    var r = plain(env.ctx[fn]()); assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'NOT_ARMED');
  });
  var st = plain(env.ctx.accessTestKeyStatus()); assert.strictEqual(st.armed, 'OFF');
  assert.strictEqual(env.fetches.length, 0); assert.strictEqual(env.mails, 0); assert.strictEqual(env.triggerWrites, 0); assert.strictEqual(env.sheetCalls, 0);
  assert.strictEqual(env.w.script.ACCESS_TEST_KEY_STATE, undefined);
});

test('シェル: 5段階を通すと実リクエストは37DD宛の5回のみ。台帳/メール/トリガー/本番ジョブ・Script PropertiesへのAPI秘密なし', function () {
  var env = loadShell(); var w = env.w;
  var fns = [['accessTestKeyStep1List', 'LIST'], ['accessTestKeyStep2Issue', 'ISSUE'], ['accessTestKeyStep3VerifyIssued', 'VERIFY_ISSUED'], ['accessTestKeyStep4Delete', 'DELETE'], ['accessTestKeyStep5VerifyDeleted', 'VERIFY_DELETED']];
  fns.forEach(function (p) {
    w.script.ACCESS_TEST_KEY_APPROVAL = p[1];
    var r = plain(env.ctx[p[0]]()); assert.strictEqual(r.ok, true, p[0] + JSON.stringify(r));
    assert.deepStrictEqual(JSON.parse(env.logs[env.logs.length - 1]), r, 'ログ=戻り値（固定JSON）');
  });
  assert.strictEqual(env.fetches.length, 5);
  assert.deepStrictEqual(env.fetches.map(function (f) { return f.method + ' ' + (f.body ? f.body.command : 'list'); }), ['get list', 'post createKey', 'get list', 'post deleteKey', 'get list']);
  env.fetches.forEach(function (f) { assert.ok(f.path === '/v1.1/devices' || f.path === '/v1.1/devices/' + DEVICE + '/commands'); });
  assert.strictEqual(env.fetches[1].body.parameter.type, 'timeLimit'); assert.ok(/^[0-9]{8}$/.test(env.fetches[1].body.parameter.password));
  assert.deepStrictEqual(w.keys.map(function (k) { return k.id; }), ['EXIST-ID-AAA111', 'EXIST-ID-BBB222']);
  assert.strictEqual(env.mails + env.triggerWrites + env.sheetCalls, 0);
  var all = env.logs.join('\n') + JSON.stringify(w.script);
  Object.keys(SECRETS).forEach(function (k) { assert.ok(all.indexOf(SECRETS[k]) === -1); });
  assert.ok(env.logs.join('\n').indexOf(env.fetches[1].body.parameter.password) === -1, 'パスコードをログに出さない');
  ['CMD-SECRET', 'TEST-ID-', DEVICE].forEach(function (x) { assert.ok(env.logs.join('\n').indexOf(x) === -1, x); });
  assert.strictEqual(w.script.ACCESS_ENABLED, 'false'); assert.strictEqual(w.triggers, 0);
});

test('シェル: 二重押下（同じ段階を連続実行）でも createKey は1回', function () {
  var env = loadShell(); var w = env.w;
  w.script.ACCESS_TEST_KEY_APPROVAL = 'LIST'; env.ctx.accessTestKeyStep1List();
  w.script.ACCESS_TEST_KEY_APPROVAL = 'ISSUE'; env.ctx.accessTestKeyStep2Issue();
  w.script.ACCESS_TEST_KEY_APPROVAL = 'ISSUE'; var r = plain(env.ctx.accessTestKeyStep2Issue());
  assert.strictEqual(r.ok, false);
  assert.strictEqual(env.fetches.filter(function (f) { return f.body && f.body.command === 'createKey'; }).length, 1);
});

test('既存本番診断の回帰: 新入口は本番ジョブ・診断を変更せず、アクセストークンの範囲（スコープ）も不変', function () {
  var root = path.join(__dirname, '..', 'gas', 'switchbot-access');
  var m = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets') === -1);
  assert.strictEqual(typeof Infra.readOnlyDiagnostics, 'function'); assert.strictEqual(typeof Infra.testReadOnlyDiagnostics, 'function');
  var app = fs.readFileSync(path.join(root, 'SwitchBotAccessApp.gs'), 'utf8');
  assert.ok(/function accessSyncJob\(\) \{ return sba_runtime_\(\)\.syncCycle\(\); \}/.test(app));
  var seg = app.slice(app.indexOf('function sba_testKeyDeps_'), app.indexOf('// ── 本番初期設定の読取専用診断（Issue #774）'));
  assert.ok(!/sba_runtime_|accessSyncJob|accessDeliverJob|accessSweepJob|accessWatchdogJob|accessInstallTriggers|newTrigger|MailApp|SpreadsheetApp|sba_ledger|sba_openLedgerSheet_|WEBHOOK_SHARED_TOKEN|doPost/.test(seg.replace(/\/\/.*$/gm, '')), '本番ジョブ・台帳・メール・トリガーを使わない');
  assert.ok(!/SWITCHBOT_TOKEN|SWITCHBOT_SECRET/.test(seg), '資格情報は既存のAPI層(User Properties)経由のみ');
});
