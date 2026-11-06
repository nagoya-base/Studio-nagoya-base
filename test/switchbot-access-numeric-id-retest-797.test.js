/*
 * Issue #797: 37DD 数値型ID維持 createKey→deleteKey 最小試験のモックテスト。
 * 実GAS・実API・実機・実秘密には一切接続しない。値はすべてテスト内のダミー（偽のSwitchBot端末をメモリ上に持つ）。
 * モックが証明できるのは「JSON型の保持・安全ゲート・予算・停止条件」まで。SwitchBot側が数値IDだけを受理すること、
 * および 11/6 の削除残存の因果は証明しない（実機再試験の結果でのみ判断する）。
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
var PLAN = 'NUMID_PLAN_V1_6CALLS';
var SECRETS = { SWITCHBOT_TOKEN: 'dummy-token-' + 'a1b2c3d4'.repeat(4), SWITCHBOT_SECRET: 'dummy-secret-' + 'e5f6a7b8'.repeat(3) };
var NORMAL_NUM = [{ id: 987654321012, name: 'normal-key-1', type: 'permanent' }];
var NORMAL_STR = [{ id: 'NORMAL-STR-ID-1', name: 'normal-key-1', type: 'permanent' }];
var LEGACY_STATE = JSON.stringify({ v: 1, state: 'STOPPED', calls: 5, name: 'TSTLEGACY1', baselineCount: 1, baselineFp: 'fp-legacy', hasCommandId: false, reason: 'TEST_KEY_STILL_PRESENT' });
var STAGES = ['LIST', 'ISSUE', 'VERIFY_ISSUED', 'PRE_DELETE_LIST', 'DELETE', 'VERIFY_DELETED'];

function cfgJson(over) {
  return JSON.stringify(Object.assign({ environment: 'verify', allowedLast4: ['37DD'], keypads: [{ deviceId: DEVICE }],
    ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test'] }, over || {}));
}

/**
 * 偽の SwitchBot 端末 + Properties + ロック。
 * o.idStyle: 'number'(既定)|'string'  発行されるキーの keyList.id の型
 * o.strictType: true なら deleteKey は parameter.id が型まで一致したときだけ実削除する（String化では消えない端末の仮定）
 * o.deleteNoop: 受理するが削除しない（11/6の観測を模した端末）
 */
function makeWorld(o) {
  o = o || {};
  var w = {
    script: Object.assign({ ACCESS_CONFIG: cfgJson(), ACCESS_ENVIRONMENT: 'verify', ACCESS_ENABLED: 'false',
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }), ACCESS_TEST_KEY_STATE: LEGACY_STATE,
      ACCESS_NUMID_TEST_ARMED: PLAN }, o.script || {}),
    user: Object.assign({}, SECRETS),
    keys: (o.keys || NORMAL_NUM).map(function (k) { return Object.assign({}, k); }),
    calls: [], createArgs: [], deleteArgs: [], passwords: [], atCall: [], nextSeq: 1, now: 1800000000,
    triggers: o.triggers || 0, email: ADMIN, effective: ADMIN, lockBusy: !!o.lockBusy
  };
  function snapshotAtCall(kind) {
    var raw = w.script.ACCESS_NUMID_TEST_STATE;
    w.atCall.push({ kind: kind, state: raw ? JSON.parse(raw) : null, approval: w.script.ACCESS_NUMID_TEST_APPROVAL });
  }
  w.deps = {
    identity: function () { return { email: w.email, effectiveEmail: w.effective }; },
    adminActors: { 'owner@example.test': 'ADMIN-1' },
    accessFlag: function () { return w.script.ACCESS_ENABLED === undefined ? null : w.script.ACCESS_ENABLED; },
    scriptProps: {
      get: function (k) { if (o.failScriptRead && o.failScriptRead(k)) throw new Error('LEAK-ME ' + SECRETS.SWITCHBOT_TOKEN); return w.script[k] === undefined ? null : w.script[k]; },
      set: function (k, v) { if (o.failStateWrite && k === 'ACCESS_NUMID_TEST_STATE' && o.failStateWrite(JSON.parse(v))) throw new Error('write fail'); w.script[k] = v; },
      del: function (k) { if (o.failApprovalDel && k === 'ACCESS_NUMID_TEST_APPROVAL') throw new Error('del fail'); delete w.script[k]; }
    },
    userProps: {
      get: function (k) { return w.user[k] === undefined ? null : w.user[k]; },
      set: function (k, v) { if (o.failTargetStore && k === 'NUMID_TARGET') throw new Error('store fail'); w.user[k] = v; },
      del: function (k) { delete w.user[k]; }
    },
    lock: { tryLock: function () { return !w.lockBusy; }, releaseLock: function () {} },
    triggerCount: function () { return w.triggers; },
    api: {
      listDevices: function () {
        w.calls.push('list'); snapshotAtCall('list');
        if (o.listThrow && o.listThrow(w.calls.length)) throw new Error('timeout ' + DEVICE);
        var b = { ok: true, devices: [{ deviceId: DEVICE, keyList: w.keys.map(function (k) { return Object.assign({}, k); }) }, { deviceId: OTHER, keyList: [{ id: 111, name: 'other' }] }] };
        if (o.mutateList) o.mutateList(b, w);
        return b;
      },
      createKey: function (p) {
        w.calls.push('create'); snapshotAtCall('create'); w.createArgs.push(p); w.passwords.push(p.password);
        if (o.createThrow) throw new Error('timeout ' + p.name);
        if (o.createReject) return { httpCode: 200, parsed: { statusCode: 190, body: {} } };
        var seq = w.nextSeq++;
        w.keys.push({ id: o.idStyle === 'string' ? 'ISSUED-STR-' + seq : 123456789000 + seq, name: p.name, type: 'timeLimit', startTime: String(p.startTime), endTime: String(p.endTime) });
        return { httpCode: 200, parsed: { statusCode: 100, body: {} } };
      },
      deleteKey: function (deviceId, id) {
        w.calls.push('delete'); snapshotAtCall('delete'); w.deleteArgs.push(id);
        if (o.deleteThrow) throw new Error('timeout ' + id);
        if (o.deleteReject) return { httpCode: 200, parsed: { statusCode: 190, body: {} } };
        if (!o.deleteNoop) {
          w.keys = w.keys.filter(function (k) { return o.strictType ? k.id !== id : String(k.id) !== String(id); });
        }
        return { httpCode: 200, parsed: { statusCode: 100, body: {} } };
      }
    },
    sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); },
    randomInt: function (n) { return crypto.randomInt(n); },
    nowSec: function () { return w.now; }
  };
  return w;
}

function plain(x) { return JSON.parse(JSON.stringify(x)); }
function step(w, stage) { w.script.ACCESS_NUMID_TEST_APPROVAL = stage; return plain(Infra.numIdStage(w.deps, stage)); }
function appCheck(w, v) { w.script.ACCESS_NUMID_TEST_APPROVAL = v; return plain(Infra.numIdAppCheck(w.deps)); }
function status(w) { return plain(Infra.numIdStatus(w.deps)); }
function st(w) { return JSON.parse(w.script.ACCESS_NUMID_TEST_STATE); }
function advance(w, sec) { w.now += sec; }

/** 正常系を upto 段階目（1始まり）まで進める。VERIFY_DELETED の前に観測間隔(301秒)を空ける。 */
function runTo(w, upto) {
  var outs = [];
  for (var i = 0; i < upto; i++) {
    if (STAGES[i] === 'VERIFY_DELETED') advance(w, 301); else advance(w, 30);
    outs.push(step(w, STAGES[i]));
    if (!outs[i].ok) break;
  }
  return outs;
}

function leakCheck(w, r) {
  var all = JSON.stringify(r);
  var needles = [DEVICE, OTHER, ADMIN, 'ADMIN-1', 'normal-key', 'LEAK-ME', 'ops@example.test', '987654321012', '123456789', 'ISSUED-STR', 'NORMAL-STR', 'TSTLEGACY1', 'fp-legacy'];
  Object.keys(SECRETS).forEach(function (k) { needles.push(SECRETS[k]); });
  w.passwords.forEach(function (p) { needles.push(p); });
  w.createArgs.forEach(function (a) { needles.push(a.name); });
  needles.forEach(function (x) { assert.ok(all.indexOf(x) === -1, 'leak ' + String(x).slice(0, 6)); });
}
function legacyUntouched(w) {
  assert.strictEqual(w.script.ACCESS_TEST_KEY_STATE, LEGACY_STATE, '#791 の状態(STOPPED・5/5)は不変');
  assert.strictEqual(w.script.ACCESS_TEST_KEY_ARMED, undefined);
  assert.strictEqual(w.script.ACCESS_TEST_KEY_APPROVAL, undefined);
  assert.strictEqual(w.script.ACCESS_ENABLED, 'false');
  assert.strictEqual(w.triggers, 0);
}

// ───────────────── 正常系: 6回・各1回・型維持 ─────────────────

test('正常系(数値ID): 6回の通信が LIST→ISSUE→VERIFY→DELETE前LIST→DELETE→VERIFY の順で各1回。deleteKey は数値のまま。公式アプリ確認まで COMPLETE にしない', function () {
  var w = makeWorld({ strictType: true });
  var outs = runTo(w, 6);
  assert.deepStrictEqual(outs.map(function (r) { return r.code; }),
    ['NUMID_LIST_OK', 'NUMID_ISSUE_OK', 'NUMID_VERIFY_ISSUED_OK', 'NUMID_PRE_DELETE_LIST_OK', 'NUMID_DELETE_OK', 'NUMID_VERIFY_DELETED_OK']);
  assert.deepStrictEqual(w.calls, ['list', 'create', 'list', 'list', 'delete', 'list'], '合計6回・createKey/deleteKey は各1回');
  assert.strictEqual(w.deleteArgs.length, 1);
  assert.strictEqual(typeof w.deleteArgs[0], 'number', 'parameter.id は取得した keyList.id の型(数値)のまま');
  assert.strictEqual(w.deleteArgs[0], 123456789001);
  assert.strictEqual(outs[4].wireIdType, 'ID_TYPE_NUMBER'); assert.strictEqual(outs[3].idType, 'ID_TYPE_NUMBER');
  assert.strictEqual(outs[5].appCheck, 'PENDING_OWNER');
  assert.strictEqual(st(w).state, 'API_ABSENT_APP_PENDING', 'API上の不在だけでは COMPLETE にしない');
  assert.strictEqual(st(w).calls, 6);
  assert.deepStrictEqual(w.keys, NORMAL_NUM, '通常キーは不変で試験キーだけ消えた');
  assert.strictEqual(w.user.NUMID_TARGET, undefined, '削除対象IDは完了後に消す');
  var ac = appCheck(w, 'APP_ABSENT');
  assert.strictEqual(ac.ok, true); assert.strictEqual(ac.code, 'NUMID_APP_CHECK_OK'); assert.strictEqual(ac.appCheck, 'ABSENT_CONFIRMED');
  assert.strictEqual(st(w).state, 'COMPLETE'); assert.strictEqual(w.calls.length, 6, '公式アプリ記録は通信しない');
  outs.concat([ac]).forEach(function (r) { leakCheck(w, r); assert.ok(r.callsMax === 6); });
  legacyUntouched(w);
  assert.strictEqual(w.script.ACCESS_NUMID_TEST_APPROVAL, undefined, '承認は消費済み');
});

test('正常系(文字列ID): keyList.id が文字列なら文字列のまま送る（型を変換しない）', function () {
  var w = makeWorld({ idStyle: 'string', keys: NORMAL_STR, strictType: true });
  var outs = runTo(w, 6);
  assert.ok(outs.every(function (r) { return r.ok; }), JSON.stringify(outs));
  assert.strictEqual(typeof w.deleteArgs[0], 'string'); assert.strictEqual(outs[4].wireIdType, 'ID_TYPE_STRING');
  assert.deepStrictEqual(w.keys, NORMAL_STR);
});

test('比較: 11/6の旧経路(String化)と新経路(型維持)のワイヤJSON型。数値IDだけ差が出て、文字列IDでは差なし（モックのみ・API側の挙動は未証明）', function () {
  var body = function (id) { return JSON.parse(JSON.stringify({ commandType: 'command', command: 'deleteKey', parameter: { id: id } })); };
  var numeric = 123456789001, str = 'ABC-1';
  assert.strictEqual(typeof body(numeric).parameter.id, 'number');
  assert.strictEqual(typeof body(String(numeric)).parameter.id, 'string', '旧経路は文字列になる');
  assert.deepStrictEqual(body(str), body(String(str)), '文字列IDでは新旧に差なし');
  // 厳密型の端末仮定: 旧経路(String化)では消えず、新経路では消える（実機がそうだという証拠ではない）
  var w = makeWorld({ strictType: true }); runTo(w, 6);
  assert.deepStrictEqual(w.keys, NORMAL_NUM);
  var legacyLike = makeWorld({ strictType: true });
  legacyLike.keys.push({ id: 123456789001, name: 'TSTXXXXXXXX', type: 'timeLimit' });
  legacyLike.deps.api.deleteKey(DEVICE, String(123456789001));
  assert.strictEqual(legacyLike.keys.length, 2, 'String化したIDでは厳密型の端末では削除されない');
});

test('発行条件: 11/6(#791)と同一(開始60秒前・有効3600秒・timeLimit)。変更点は固定コードで常に併記し、所要秒数を記録', function () {
  var w = makeWorld(); var outs = runTo(w, 3);
  var a = w.createArgs[0], issueSec = st(w).issueSec;
  assert.strictEqual(a.startTime, issueSec - 60); assert.strictEqual(a.endTime, issueSec + 3600);
  assert.ok(/^TST[A-Z0-9]{8}$/.test(a.name)); assert.ok(/^[0-9]{8}$/.test(a.password));
  assert.strictEqual(w.keys.filter(function (k) { return k.name === a.name; })[0].type, 'timeLimit');
  advance(w, 30); outs.push(step(w, 'PRE_DELETE_LIST')); advance(w, 30); outs.push(step(w, 'DELETE'));
  outs.forEach(function (r) {
    assert.strictEqual(r.validityProfile, 'SAME_AS_791');
    assert.deepStrictEqual(r.changes, ['ID_TYPE_PRESERVED', 'PRE_DELETE_RELIST_ADDED', 'OBSERVATION_MIN_300S']);
  });
  assert.strictEqual(typeof outs[4].issueToDeleteSec, 'number'); assert.ok(outs[4].issueToDeleteSec > 0);
});

// ───────────────── 安全ゲート ─────────────────

test('必須条件: 1つでも欠けたら通信ゼロ・状態不変・承認も消費しない（fail-closed）', function () {
  var cases = [
    ['ARMED 未設定', { script: { ACCESS_NUMID_TEST_ARMED: undefined } }, 'NOT_ARMED'],
    ['ARMED が計画IDと不一致', { script: { ACCESS_NUMID_TEST_ARMED: 'true' } }, 'ARMED_PLAN_MISMATCH'],
    ['ACCESS_ENABLED=true', { script: { ACCESS_ENABLED: 'true' } }, 'ACCESS_NOT_OFF'],
    ['ACCESS_ENABLED 未設定', { script: { ACCESS_ENABLED: undefined } }, 'ACCESS_FLAG_NOT_EXPLICIT_OFF'],
    ['#791 ARMED 設定済み', { script: { ACCESS_TEST_KEY_ARMED: 'true' } }, 'TEST_KEY_ARMED_PRESENT'],
    ['#791 APPROVAL 設定済み', { script: { ACCESS_TEST_KEY_APPROVAL: 'LIST' } }, 'TEST_KEY_APPROVAL_PRESENT'],
    ['#791 STATE が STOPPED でない', { script: { ACCESS_TEST_KEY_STATE: JSON.stringify({ v: 1, state: 'COMPLETE', calls: 5 }) } }, 'TEST_KEY_STATE_NOT_STOPPED'],
    ['#791 STATE 破損', { script: { ACCESS_TEST_KEY_STATE: '{broken' } }, 'TEST_KEY_STATE_UNREADABLE'],
    ['トリガーあり', { triggers: 1 }, 'TRIGGERS_PRESENT'],
    ['環境が production', { script: { ACCESS_ENVIRONMENT: 'production' } }, 'ENV_NOT_VERIFY'],
    ['01FD 対象', { script: { ACCESS_CONFIG: cfgJson({ allowedLast4: ['01FD'], keypads: [{ deviceId: OTHER }] }) } }, 'LAST4_FORBIDDEN'],
    ['37DD+01FD 複数', { script: { ACCESS_CONFIG: cfgJson({ allowedLast4: ['37DD', '01FD'], keypads: [{ deviceId: DEVICE }, { deviceId: OTHER }] }) } }, 'LAST4_FORBIDDEN'],
    ['ロック競合', { lockBusy: true }, 'LOCK_UNAVAILABLE']
  ];
  cases.forEach(function (c) {
    var w = makeWorld(c[1]);
    Object.keys(c[1].script || {}).forEach(function (k) { if (c[1].script[k] === undefined) delete w.script[k]; });
    var r = step(w, 'LIST');
    assert.strictEqual(r.ok, false, c[0]); assert.strictEqual(r.code, c[2], c[0] + ' ' + JSON.stringify(r));
    assert.strictEqual(w.calls.length, 0, c[0]); assert.strictEqual(w.script.ACCESS_NUMID_TEST_STATE, undefined, c[0]);
    assert.strictEqual(w.script.ACCESS_NUMID_TEST_APPROVAL, 'LIST', '承認は消費しない: ' + c[0]);
  });
});

test('実行者・資格情報: 非管理者・active/effective不一致・資格情報なしは通信ゼロ', function () {
  var w = makeWorld(); w.email = 'other@example.test'; w.effective = 'other@example.test';
  assert.strictEqual(step(w, 'LIST').ok, false); assert.strictEqual(w.calls.length, 0);
  w = makeWorld(); w.effective = 'someone@example.test';
  assert.strictEqual(step(w, 'LIST').code, 'ACCOUNT_MISMATCH'); assert.strictEqual(w.calls.length, 0);
  w = makeWorld(); delete w.user.SWITCHBOT_TOKEN;
  assert.strictEqual(step(w, 'LIST').code, 'AUTH_CREDENTIALS_MISSING'); assert.strictEqual(w.calls.length, 0);
});

test('段階承認: 未設定・別段階・不正値では通信しない。順序違反・二重押下でも通信しない', function () {
  [undefined, 'ISSUE', 'list', 'TRUE', ''].forEach(function (v) {
    var w = makeWorld(); if (v === undefined) delete w.script.ACCESS_NUMID_TEST_APPROVAL; else w.script.ACCESS_NUMID_TEST_APPROVAL = v;
    var r = plain(Infra.numIdStage(w.deps, 'LIST'));
    assert.strictEqual(r.code, 'STAGE_NOT_APPROVED'); assert.strictEqual(w.calls.length, 0); assert.strictEqual(w.script.ACCESS_NUMID_TEST_STATE, undefined);
  });
  var w2 = makeWorld(); assert.strictEqual(step(w2, 'DELETE').code, 'STAGE_ORDER_VIOLATION'); assert.strictEqual(w2.calls.length, 0);
  assert.strictEqual(step(w2, 'LIST').ok, true);
  assert.strictEqual(step(w2, 'LIST').code, 'STAGE_ORDER_VIOLATION'); assert.strictEqual(step(w2, 'PRE_DELETE_LIST').code, 'STAGE_ORDER_VIOLATION');
  assert.strictEqual(w2.calls.length, 1, '二重押下で2回目の通信なし');
  assert.strictEqual(plain(Infra.numIdStage(makeWorld().deps, 'BOGUS')).code, 'INVALID_STAGE');
});

test('予算・永続: 承認の消費と「送信済み＋回数」の永続が通信より先。永続/承認消費に失敗したら通信しない。#791 の予算とは独立', function () {
  var w = makeWorld(); runTo(w, 6);
  w.atCall.forEach(function (c, i) {
    assert.strictEqual(c.approval, undefined, '通信時点で承認は消費済み: ' + c.kind + i);
    assert.strictEqual(c.state.calls, i + 1, '通信前に回数を永続: ' + i);
    assert.ok(/_SENT$/.test(c.state.state), '通信前に送信済みマーカー: ' + c.state.state);
  });
  assert.strictEqual(st(w).calls, 6); legacyUntouched(w);
  var w2 = makeWorld({ failStateWrite: function () { return true; } });
  assert.strictEqual(step(w2, 'LIST').code, 'STATE_WRITE_FAILED'); assert.strictEqual(w2.calls.length, 0);
  var w3 = makeWorld({ failApprovalDel: true });
  assert.strictEqual(step(w3, 'LIST').code, 'APPROVAL_CONSUME_FAILED'); assert.strictEqual(w3.calls.length, 0); assert.strictEqual(w3.script.ACCESS_NUMID_TEST_STATE, undefined);
  var w4 = makeWorld({ failScriptRead: function (k) { return k === 'ACCESS_NUMID_TEST_STATE'; } });
  assert.strictEqual(step(w4, 'LIST').code, 'STATE_UNREADABLE'); assert.strictEqual(w4.calls.length, 0);
});

test('予算上限: 7回目は通信しない。壊れた状態も通信しない', function () {
  var w = makeWorld({ script: { ACCESS_NUMID_TEST_STATE: JSON.stringify({ v: 1, state: 'DELETE_ACCEPTED', calls: 6, name: 'TSTABCDEFGH', deviceFp: 'x' }) } });
  w.script.ACCESS_NUMID_TEST_APPROVAL = 'VERIFY_DELETED';
  var r = plain(Infra.numIdStage(w.deps, 'VERIFY_DELETED'));
  assert.ok(['CALL_BUDGET_EXHAUSTED', 'TARGET_DEVICE_CHANGED'].indexOf(r.code) !== -1, r.code); assert.strictEqual(w.calls.length, 0);
  var w2 = makeWorld({ script: { ACCESS_NUMID_TEST_STATE: JSON.stringify({ v: 1, state: 'LISTED', calls: 7 }) } });
  assert.strictEqual(step(w2, 'ISSUE').code, 'STATE_UNREADABLE'); assert.strictEqual(w2.calls.length, 0);
  var w3 = makeWorld({ script: { ACCESS_NUMID_TEST_STATE: '{broken' } });
  assert.strictEqual(step(w3, 'LIST').code, 'STATE_UNREADABLE'); assert.strictEqual(w3.calls.length, 0);
});

// ───────────────── 失敗・曖昧・タイムアウトは STOPPED ─────────────────

test('createKey が例外/不受理: STOPPED・再送なし・以後の段階は通信ゼロ', function () {
  [{ createThrow: true }, { createReject: true }].forEach(function (o) {
    var w = makeWorld(o); var outs = runTo(w, 2);
    assert.strictEqual(outs[1].code, 'ISSUE_RESULT_UNKNOWN'); assert.strictEqual(outs[1].manualRecovery, true);
    assert.strictEqual(st(w).state, 'STOPPED'); assert.deepStrictEqual(w.calls, ['list', 'create']); leakCheck(w, outs[1]);
    var again = step(w, 'ISSUE'); assert.strictEqual(again.code, 'STOPPED_MANUAL_RECOVERY'); assert.strictEqual(w.calls.length, 2, '自動再送なし');
    assert.strictEqual(step(w, 'VERIFY_ISSUED').code, 'STOPPED_MANUAL_RECOVERY'); assert.strictEqual(w.calls.length, 2);
  });
});

test('deleteKey が例外/不受理: DELETE_RESULT_UNKNOWN で STOPPED・再送なし・手動撤去へ。受理でも削除成功扱いにしない', function () {
  [{ deleteThrow: true }, { deleteReject: true }].forEach(function (o) {
    var w = makeWorld(o); var outs = runTo(w, 5);
    assert.strictEqual(outs[4].code, 'DELETE_RESULT_UNKNOWN'); assert.strictEqual(outs[4].manualRecovery, true);
    assert.strictEqual(st(w).state, 'STOPPED'); assert.strictEqual(w.deleteArgs.length, 1);
    advance(w, 400); assert.strictEqual(step(w, 'VERIFY_DELETED').code, 'STOPPED_MANUAL_RECOVERY');
    assert.strictEqual(step(w, 'DELETE').code, 'STOPPED_MANUAL_RECOVERY'); assert.strictEqual(w.deleteArgs.length, 1, '再送なし');
    assert.strictEqual(w.user.NUMID_TARGET, undefined, '停止時は削除対象IDも消す');
    leakCheck(w, outs[4]);
  });
  var acc = makeWorld({ deleteNoop: true }); var o2 = runTo(acc, 5);
  assert.strictEqual(o2[4].ok, true); assert.strictEqual(st(acc).state, 'DELETE_ACCEPTED', '受理は DELETE_ACCEPTED。削除成功ではない');
  assert.notStrictEqual(st(acc).state, 'COMPLETE');
});

test('削除後GETで試験キーが残存(11/6の再現条件): TEST_KEY_STILL_PRESENT で STOPPED・手動撤去・以後通信なし', function () {
  var w = makeWorld({ deleteNoop: true }); var outs = runTo(w, 6);
  assert.strictEqual(outs[5].ok, false); assert.strictEqual(outs[5].code, 'TEST_KEY_STILL_PRESENT'); assert.strictEqual(outs[5].manualRecovery, true);
  assert.strictEqual(st(w).state, 'STOPPED'); assert.strictEqual(w.calls.length, 6); assert.strictEqual(w.deleteArgs.length, 1);
  assert.strictEqual(appCheck(w, 'APP_ABSENT').code, 'STAGE_ORDER_VIOLATION', 'API残存のまま公式アプリ確認へ進めない');
  leakCheck(w, outs[5]); legacyUntouched(w);
});

test('削除後GET: 通常キーが変化していたら成功にしない。観測間隔(300秒)未満はGETせず承認・回数も消費しない', function () {
  var w = makeWorld({ mutateList: function (b, ww) { if (ww.calls.length === 6) b.devices[0].keyList[0].name = 'renamed-normal'; } });
  var outs = runTo(w, 6);
  assert.strictEqual(outs[5].code, 'EXISTING_KEYS_CHANGED'); assert.strictEqual(st(w).state, 'STOPPED');
  var w2 = makeWorld(); runTo(w2, 5); advance(w2, 120);
  var early = step(w2, 'VERIFY_DELETED');
  assert.strictEqual(early.code, 'OBSERVATION_WINDOW_NOT_ELAPSED'); assert.strictEqual(w2.calls.length, 5);
  assert.strictEqual(w2.script.ACCESS_NUMID_TEST_APPROVAL, 'VERIFY_DELETED', '承認は残る'); assert.strictEqual(st(w2).state, 'DELETE_ACCEPTED'); assert.strictEqual(st(w2).calls, 5);
  advance(w2, 200); assert.strictEqual(step(w2, 'VERIFY_DELETED').ok, true);
});

test('公式アプリに残存(APP_PRESENT)を記録: STOPPED・手動撤去。APP_ABSENT/APP_PRESENT 以外や順序違反は拒否', function () {
  var w = makeWorld(); runTo(w, 6);
  assert.strictEqual(appCheck(w, 'MAYBE').code, 'STAGE_NOT_APPROVED'); assert.strictEqual(st(w).state, 'API_ABSENT_APP_PENDING');
  var r = appCheck(w, 'APP_PRESENT');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'APP_STILL_PRESENT'); assert.strictEqual(r.manualRecovery, true); assert.strictEqual(st(w).state, 'STOPPED');
  assert.strictEqual(w.calls.length, 6);
  var early = makeWorld(); runTo(early, 3);
  assert.strictEqual(appCheck(early, 'APP_ABSENT').code, 'STAGE_ORDER_VIOLATION');
});

// ───────────────── 削除直前の再照合・通常キー保護 ─────────────────

test('削除直前の再照合(PRE_DELETE_LIST): 不一致・曖昧は削除せず STOPPED（deleteKey は一度も呼ばれない）', function () {
  var cases = [
    ['試験キーが消えた', function (b, w) { b.devices[0].keyList = b.devices[0].keyList.filter(function (k) { return !/^TST/.test(k.name); }); }, 'KEY_NOT_FOUND'],
    ['同名キーが複数', function (b, w) { var t = b.devices[0].keyList.filter(function (k) { return /^TST/.test(k.name); })[0]; b.devices[0].keyList.push(Object.assign({}, t, { id: 55555 })); }, 'KEY_NAME_AMBIGUOUS'],
    ['通常キーが変化', function (b) { b.devices[0].keyList[0].name = 'renamed'; }, 'EXISTING_KEYS_CHANGED'],
    ['別のキーが増えた', function (b) { b.devices[0].keyList.push({ id: 777, name: 'extra', type: 'permanent' }); }, 'KEYLIST_COUNT_MISMATCH'],
    ['IDの型が変わった(数値→文字列)', function (b) { var t = b.devices[0].keyList.filter(function (k) { return /^TST/.test(k.name); })[0]; t.id = String(t.id); }, 'ID_TYPE_CHANGED'],
    ['安全でない巨大整数ID', function (b) { var t = b.devices[0].keyList.filter(function (k) { return /^TST/.test(k.name); })[0]; t.id = 9007199254740993; }, 'ID_NOT_SAFE_INTEGER'],
    ['IDが欠落', function (b) { var t = b.devices[0].keyList.filter(function (k) { return /^TST/.test(k.name); })[0]; delete t.id; }, 'KEYLIST_ENTRY_INVALID'],
    ['端末が複数一致', function (b) { b.devices.push({ deviceId: DEVICE, keyList: [] }); }, 'DEVICE_AMBIGUOUS'],
    ['有効期間が要求と矛盾', function (b) { var t = b.devices[0].keyList.filter(function (k) { return /^TST/.test(k.name); })[0]; t.endTime = '1'; }, 'KEY_ATTR_MISMATCH']
  ];
  cases.forEach(function (c) {
    var w = makeWorld({ mutateList: function (b, ww) { if (ww.calls.length === 4) c[1](b, ww); } });
    var outs = runTo(w, 4);
    assert.strictEqual(outs[3].ok, false, c[0]); assert.strictEqual(outs[3].code, c[2], c[0] + ' ' + JSON.stringify(outs[3]));
    assert.strictEqual(outs[3].manualRecovery, true, c[0]); assert.strictEqual(st(w).state, 'STOPPED', c[0]);
    assert.strictEqual(w.deleteArgs.length, 0, c[0] + ': deleteKey 未呼出'); assert.strictEqual(w.user.NUMID_TARGET, undefined, c[0]);
    assert.strictEqual(step(w, 'DELETE').code, 'STOPPED_MANUAL_RECOVERY'); assert.strictEqual(w.deleteArgs.length, 0);
  });
});

test('通常キー保護: 削除対象が通常キー/別名/型違い/欠落/古い再照合なら通信せず停止。deleteKey の対象は発行した試験キーIDのみ', function () {
  function tamper(mut) {
    var w = makeWorld({ strictType: true }); runTo(w, 4);
    var tgt = JSON.parse(w.user.NUMID_TARGET); mut(tgt, w);
    return w;
  }
  var cases = [
    ['通常キーのIDを指す', function (t, w) { w.user.NUMID_TARGET = JSON.stringify({ n: t.n, id: NORMAL_NUM[0].id }); }, 'TARGET_IS_BASELINE_KEY'],
    ['名前が不一致', function (t, w) { w.user.NUMID_TARGET = JSON.stringify({ n: 'TSTOTHER99', id: t.id }); }, 'TEST_KEY_ID_MISSING'],
    ['型が書き換わった(数値→文字列)', function (t, w) { w.user.NUMID_TARGET = JSON.stringify({ n: t.n, id: String(t.id) }); }, 'TARGET_ID_INVALID'],
    ['対象が欠落', function (t, w) { delete w.user.NUMID_TARGET; }, 'TEST_KEY_ID_MISSING'],
    ['対象が壊れている', function (t, w) { w.user.NUMID_TARGET = '{broken'; }, 'TEST_KEY_ID_MISSING'],
    ['配列などの不正型', function (t, w) { w.user.NUMID_TARGET = JSON.stringify({ n: t.n, id: [t.id] }); }, 'TARGET_ID_INVALID']
  ];
  cases.forEach(function (c) {
    var w = tamper(c[1]); advance(w, 30);
    var r = step(w, 'DELETE');
    assert.strictEqual(r.ok, false, c[0]); assert.strictEqual(r.code, c[2], c[0] + ' ' + JSON.stringify(r));
    assert.strictEqual(w.deleteArgs.length, 0, c[0] + ': 通信しない'); assert.strictEqual(w.calls.length, 4, c[0]);
    assert.strictEqual(st(w).state, 'STOPPED', c[0]); assert.strictEqual(st(w).calls, 4, '回数は消費しない');
    assert.deepStrictEqual(w.keys[0], NORMAL_NUM[0], '通常キーは無傷');
  });
  // 古い再照合(600秒超)・既に期限切れでは削除しない
  var stale = makeWorld(); runTo(stale, 4); advance(stale, 601);
  var rs = step(stale, 'DELETE'); assert.strictEqual(rs.code, 'PRE_DELETE_STALE'); assert.strictEqual(stale.deleteArgs.length, 0); assert.strictEqual(st(stale).state, 'STOPPED');
  var okW = makeWorld(); runTo(okW, 4); advance(okW, 600);
  assert.strictEqual(step(okW, 'DELETE').ok, true, '600秒ちょうどまでは許容');
  // 全シナリオで deleteKey が受け取るIDは「発行した試験キー」のみ
  var all = makeWorld({ strictType: true }); runTo(all, 6);
  assert.deepStrictEqual(all.deleteArgs, [123456789001]); assert.notStrictEqual(all.deleteArgs[0], NORMAL_NUM[0].id);
});

test('対象端末の固定: 設定の端末が変わったら通信前に停止。他端末(01FD)のキーは参照も削除もしない', function () {
  var w = makeWorld(); runTo(w, 3);
  w.script.ACCESS_CONFIG = cfgJson({ keypads: [{ deviceId: 'DEVICE000000137DD' }] });
  var r = step(w, 'PRE_DELETE_LIST'); assert.strictEqual(r.code, 'TARGET_DEVICE_CHANGED'); assert.strictEqual(w.calls.length, 3);
  var w2 = makeWorld({ script: { ACCESS_CONFIG: cfgJson({ keypads: [{ deviceId: OTHER }], allowedLast4: ['01FD'] }) } });
  assert.strictEqual(step(w2, 'LIST').code, 'LAST4_FORBIDDEN'); assert.strictEqual(w2.calls.length, 0);
});

test('LIST 段階: 試験キー形式の残骸があれば発行に進まない。通信失敗は STOPPED（再送なし）', function () {
  var w = makeWorld({ keys: NORMAL_NUM.concat([{ id: 1, name: 'TSTABCDEFGH', type: 'timeLimit' }]) });
  assert.strictEqual(step(w, 'LIST').code, 'STALE_TEST_KEY_PRESENT'); assert.strictEqual(st(w).state, 'STOPPED');
  var w2 = makeWorld({ listThrow: function () { return true; } });
  var r = step(w2, 'LIST'); assert.strictEqual(r.code, 'LIST_COMM_ERROR'); assert.strictEqual(w2.calls.length, 1); leakCheck(w2, r);
  assert.strictEqual(step(w2, 'LIST').code, 'STOPPED_MANUAL_RECOVERY'); assert.strictEqual(w2.calls.length, 1);
});

test('容量ゲート: 80件以上は発行しない', function () {
  var many = []; for (var i = 0; i < 80; i++) many.push({ id: 1000 + i, name: 'n' + i, type: 'permanent' });
  var w = makeWorld({ keys: many }); step(w, 'LIST'); var r = step(w, 'ISSUE');
  assert.strictEqual(r.ok, false); assert.strictEqual(w.calls.length, 1);
});

test('状態確認: 通信せず、値・ID・名前なしで前提条件・計画ID・#791状態(読取のみ)を返す。ok=true はGOではない', function () {
  var w = makeWorld(); var r = status(w);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.gates, 'PASS'); assert.strictEqual(r.prerequisites, 'PASS');
  assert.strictEqual(r.state, 'INIT'); assert.strictEqual(r.armed, 'ON'); assert.strictEqual(r.approvedStage, 'NONE'); assert.strictEqual(r.planId, PLAN);
  assert.strictEqual(r.legacyState, 'STOPPED'); assert.strictEqual(r.callsMax, 6);
  assert.ok(r.notes.indexOf('STATUS_OK_IS_NOT_GO_NOR_EXECUTABLE') !== -1);
  assert.strictEqual(w.calls.length, 0); leakCheck(w, r); legacyUntouched(w);
  var w2 = makeWorld({ script: { ACCESS_NUMID_TEST_ARMED: 'x' } }); assert.strictEqual(status(w2).armed, 'PLAN_MISMATCH');
  var w3 = makeWorld({ script: { ACCESS_TEST_KEY_ARMED: 'true' } }); r = status(w3);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'TEST_KEY_ARMED_PRESENT');
});

test('秘匿: 全段階の出力と永続した状態に、完全deviceId・生ID・キー名(通常)・パスコード・Token/Secret を含めない', function () {
  var w = makeWorld({ failScriptRead: function (k) { return k === 'NEVER'; } });
  var outs = runTo(w, 6); outs.forEach(function (r) { leakCheck(w, r); });
  var persisted = w.script.ACCESS_NUMID_TEST_STATE;
  [DEVICE, '987654321012', '123456789001', 'normal-key'].concat(w.passwords).concat(Object.keys(SECRETS).map(function (k) { return SECRETS[k]; })).forEach(function (x) {
    assert.ok(persisted.indexOf(x) === -1, '永続状態に出さない: ' + String(x).slice(0, 6));
  });
  // 例外本文は出力に出ない
  var t = makeWorld({ failScriptRead: function (k) { return k === 'ACCESS_NUMID_TEST_APPROVAL'; } });
  var r = plain(Infra.numIdStage(t.deps, 'LIST')); leakCheck(t, r); assert.strictEqual(t.calls.length, 0);
});

// ───────────────── 静的確認 ─────────────────

test('静的確認: 削除対象IDを String() 等で変換しない。#791 の状態を書かない。通常キーを削除する経路がない', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', 'SwitchBotAccessInfra.gs'), 'utf8');
  var seg = src.slice(src.indexOf('// ---------- 37DD 数値型ID維持'), src.indexOf('// ---------- 37DD keyList.id 型のみ')).replace(/\/\/.*$/gm, '');
  assert.ok(seg.length > 3000);
  assert.ok(/deps\.api\.deleteKey\(g\.deviceId, targetId\)/.test(seg), 'deleteKey には型変換なしの targetId を渡す');
  assert.ok(!/deleteKey\([^)]*(String|Number|parseInt|toString)\b/.test(seg), 'deleteKey 引数に変換なし');
  assert.ok(!/targetId\s*=\s*(String|Number)\(/.test(seg));
  assert.strictEqual((seg.match(/deps\.api\.deleteKey\(/g) || []).length, 1, 'deleteKey の呼出し箇所は1つだけ');
  assert.strictEqual((seg.match(/deps\.api\.createKey\(/g) || []).length, 1, 'createKey の呼出し箇所は1つだけ');
  assert.ok(!/TKS_PROP\.STATE|tksWrite|TKS_KEY_ID_PROP|ACCESS_TEST_KEY_STATE/.test(seg.replace(/tksReadState\(sp\)/g, '')), '#791 の状態は読取(tksReadState)のみ');
  assert.ok(!/newTrigger|MailApp|SpreadsheetApp|UrlFetchApp|setTimeout|Utilities\.sleep/.test(seg));
  var app = fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', 'SwitchBotAccessApp.gs'), 'utf8');
  var a = app.slice(app.indexOf('function sba_numIdRun_'), app.indexOf('// ── 本番初期設定の読取専用診断（Issue #774）')).replace(/\/\/.*$/gm, '');
  assert.ok(a.length > 300); assert.ok(!/createKey|deleteKey|sba_runtime_|accessSyncJob|newTrigger|MailApp|SpreadsheetApp|doPost|String\(/.test(a));
  assert.ok(/function sba_api_\(\)[\s\S]*deleteKey: function \(deviceId, id\) \{\s*return sba_request_\('post', '\/v1\.1\/devices\/' \+ deviceId \+ '\/commands', \{\s*commandType: 'command', command: 'deleteKey', parameter: \{ id: id \}/.test(app), 'GAS側の deleteKey も id を無加工で JSON 化');
});

// ───────────────── GAS シェル経由（実際の sba_api_ / JSON.stringify を通す）─────────────────

function loadShell(o) {
  o = o || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba797-'));
  prepare.prepareProject(out);
  var w = makeWorld(o);
  var env = { w: w, fetches: [], logs: [], mails: 0, triggerWrites: 0, devKeys: w.keys.map(function (k) { return Object.assign({}, k); }), seq: 1 };
  function props(m) {
    return { getProperty: function (k) { return m[k] === undefined ? null : m[k]; }, setProperty: function (k, v) { m[k] = v; }, deleteProperty: function (k) { delete m[k]; }, getKeys: function () { return Object.keys(m); } };
  }
  function FakeDate() { return new Date(w.now * 1000); }
  FakeDate.now = function () { return w.now * 1000; };
  var ctx = vm.createContext({
    console: console, Date: FakeDate, Math: Math, JSON: JSON, Number: Number, String: String, Array: Array, Object: Object,
    PropertiesService: { getScriptProperties: function () { return props(w.script); }, getUserProperties: function () { return props(w.user); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return w.email; } }; }, getEffectiveUser: function () { return { getEmail: function () { return w.effective; } }; } },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    LockService: { getScriptLock: function () { return w.deps.lock; } },
    ScriptApp: { getProjectTriggers: function () { return new Array(w.triggers); }, newTrigger: function () { env.triggerWrites++; throw new Error('no'); }, deleteTrigger: function () { env.triggerWrites++; }, getOAuthToken: function () { throw new Error('no'); } },
    MailApp: { sendEmail: function () { env.mails++; } },
    UrlFetchApp: {
      fetch: function (url, options) {
        var u = String(url);
        if (u.indexOf('https://api.switch-bot.com/') !== 0) throw new Error('no external fetch');
        var p = u.slice('https://api.switch-bot.com'.length);
        env.fetches.push({ method: options.method, path: p, body: options.payload || null });
        var text;
        if (options.method === 'get') {
          // 数値IDは数値のまま JSON テキストに載せる（パース後に型が保たれることを確認する）
          text = '{"statusCode":100,"body":{"deviceList":[{"deviceId":"' + DEVICE + '","keyList":[' + env.devKeys.map(function (k) {
            return '{"id":' + (typeof k.id === 'number' ? k.id : JSON.stringify(k.id)) + ',"name":' + JSON.stringify(k.name) + ',"type":' + JSON.stringify(k.type) +
              (k.startTime ? ',"startTime":' + JSON.stringify(k.startTime) + ',"endTime":' + JSON.stringify(k.endTime) : '') + '}';
          }).join(',') + ']}]}}';
        } else {
          var b = JSON.parse(options.payload);
          if (b.command === 'createKey') {
            env.devKeys.push({ id: 123456789000 + env.seq++, name: b.parameter.name, type: 'timeLimit', startTime: b.parameter.startTime, endTime: b.parameter.endTime });
          } else if (b.command === 'deleteKey') {
            // 厳密型の端末仮定: 数値のときだけ実削除（モックの仮定。実機の挙動の証拠ではない）
            if (typeof b.parameter.id === 'number') env.devKeys = env.devKeys.filter(function (k) { return k.id !== b.parameter.id; });
          }
          text = '{"statusCode":100,"body":{}}';
        }
        return { getResponseCode: function () { return 200; }, getContentText: function () { return text; } };
      }
    },
    Utilities: {
      base64Encode: function (b) { return Buffer.from(b).toString('base64'); },
      computeHmacSha256Signature: function (m, k) { return Array.from(crypto.createHmac('sha256', k).update(m).digest()); },
      getUuid: function () { return crypto.randomUUID(); },
      computeDigest: function (a, v) { return Array.from(crypto.createHash('sha256').update(v).digest()).map(function (x) { return x > 127 ? x - 256 : x; }); },
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }
    },
    ContentService: {}, SpreadsheetApp: { openById: function () { throw new Error('no'); } }
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) { vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n }); });
  env.ctx = ctx; return env;
}

test('シェル: 実際の sba_api_/JSON.stringify を通し、6回(GET4・POST2)で deleteKey の parameter.id が数値のままワイヤに載る', function () {
  var env = loadShell(); var w = env.w;
  var entries = [['accessNumIdStep1List', 'LIST'], ['accessNumIdStep2Issue', 'ISSUE'], ['accessNumIdStep3VerifyIssued', 'VERIFY_ISSUED'],
    ['accessNumIdStep4PreDeleteList', 'PRE_DELETE_LIST'], ['accessNumIdStep5Delete', 'DELETE'], ['accessNumIdStep6VerifyDeleted', 'VERIFY_DELETED']];
  var status0 = plain(env.ctx.accessNumIdStatus()); assert.strictEqual(status0.ok, true); assert.strictEqual(env.fetches.length, 0);
  var codes = [];
  entries.forEach(function (e) {
    assert.strictEqual(typeof env.ctx[e[0]], 'function', e[0]);
    w.now += e[1] === 'VERIFY_DELETED' ? 301 : 30;
    w.script.ACCESS_NUMID_TEST_APPROVAL = e[1];
    codes.push(plain(env.ctx[e[0]]()).code);
  });
  assert.deepStrictEqual(codes, ['NUMID_LIST_OK', 'NUMID_ISSUE_OK', 'NUMID_VERIFY_ISSUED_OK', 'NUMID_PRE_DELETE_LIST_OK', 'NUMID_DELETE_OK', 'NUMID_VERIFY_DELETED_OK']);
  assert.deepStrictEqual(env.fetches.map(function (f) { return f.method; }), ['get', 'post', 'get', 'get', 'post', 'get']);
  var posts = env.fetches.filter(function (f) { return f.method === 'post'; });
  assert.deepStrictEqual(posts.map(function (f) { return JSON.parse(f.body).command; }), ['createKey', 'deleteKey'], '変更系は各1回');
  var del = posts[1];
  assert.strictEqual(typeof JSON.parse(del.body).parameter.id, 'number', 'ワイヤ上の parameter.id は数値');
  assert.ok(/"parameter":\{"id":\d+\}/.test(del.body), 'JSON 文字列でも引用符なし: ' + del.body.replace(/\d{6,}/g, '#'));
  assert.ok(!/"id":"/.test(del.body));
  assert.strictEqual(env.devKeys.length, 1, '厳密型の端末仮定でも試験キーだけ消えた'); assert.strictEqual(env.devKeys[0].name, 'normal-key-1');
  assert.strictEqual(plain(env.ctx.accessNumIdStatus()).state, 'API_ABSENT_APP_PENDING');
  w.script.ACCESS_NUMID_TEST_APPROVAL = 'APP_ABSENT'; assert.strictEqual(plain(env.ctx.accessNumIdAppCheck()).code, 'NUMID_APP_CHECK_OK');
  assert.strictEqual(env.fetches.length, 6, '公式アプリ記録は通信しない');
  assert.strictEqual(env.mails + env.triggerWrites, 0);
  legacyUntouched(w);
  var logs = env.logs.join('\n');
  [DEVICE, '987654321012', '123456789001', 'normal-key'].concat(Object.keys(SECRETS).map(function (k) { return SECRETS[k]; })).forEach(function (x) { assert.ok(logs.indexOf(x) === -1, 'ログに出さない: ' + String(x).slice(0, 6)); });
  env.logs.forEach(function (l) { JSON.parse(l); });
});

test('シェル: ARMED も承認もない状態では全入口が通信ゼロ。#791/#795 の入口も塞がったまま', function () {
  var env = loadShell({ script: { ACCESS_NUMID_TEST_ARMED: undefined } }); var w = env.w; delete w.script.ACCESS_NUMID_TEST_ARMED;
  ['accessNumIdStep1List', 'accessNumIdStep2Issue', 'accessNumIdStep3VerifyIssued', 'accessNumIdStep4PreDeleteList', 'accessNumIdStep5Delete', 'accessNumIdStep6VerifyDeleted', 'accessNumIdAppCheck'].forEach(function (n) {
    var r = plain(env.ctx[n]()); assert.strictEqual(r.ok, false, n); assert.strictEqual(r.code, 'NOT_ARMED', n);
  });
  assert.strictEqual(plain(env.ctx.accessTestKeyStep1List()).ok, false, '#791 の入口は STATE=STOPPED/ARMED 未設定で停止のまま');
  assert.strictEqual(env.fetches.length, 0); assert.strictEqual(w.script.ACCESS_NUMID_TEST_STATE, undefined); legacyUntouched(w);
});

test('回帰: 本番ジョブ・OAuthスコープ・既存入口は不変', function () {
  var root = path.join(__dirname, '..', 'gas', 'switchbot-access');
  var m = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets') === -1);
  var app = fs.readFileSync(path.join(root, 'SwitchBotAccessApp.gs'), 'utf8');
  assert.ok(/function accessSyncJob\(\) \{ return sba_runtime_\(\)\.syncCycle\(\); \}/.test(app));
  ['testKeyStage', 'testKeyStatus', 'idTypeDiag', 'idTypeDiagStatus'].forEach(function (n) { assert.strictEqual(typeof Infra[n], 'function', n); });
  assert.strictEqual(Infra.NID_MAX_CALLS, 6); assert.strictEqual(Infra.TKS_MAX_CALLS, 5, '#791 の予算(5)は変更しない');
});

test('手順書: 6回計画・停止条件・#756記録・予算リセット禁止・モックの限界が明記されている', function () {
  var d = fs.readFileSync(path.join(__dirname, '..', 'docs', 'switchbot-access-numeric-id-retest-797.md'), 'utf8');
  [/LIST/, /PRE_DELETE_LIST/, /6回/, /#756/, /NUMID_PLAN_V1_6CALLS/, /交絡/, /公式アプリ/, /証明しない|証明できない/, /リセット.*(禁止|しない)|運用上禁止|運用で禁止/, /01FD/, /実機通信ゼロ|通信ゼロ/, /ACCESS_NUMID_TEST_STATE/].forEach(function (re) { assert.match(d, re); });
  assert.ok(!/ACCESS_TEST_KEY_STATE\s*を削除/.test(d), '#791 状態の削除を案内しない');
});
