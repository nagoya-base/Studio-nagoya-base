/*
 * 親 #748・計画 #756: 37DD 期限境界（開始前／期間内／期限後）解錠試験の入口のモックテスト。
 * 実GAS・実API・実機・実秘密には一切接続しない。値はすべてテスト内のダミー（偽のSwitchBot端末をメモリ上に持つ）。
 * モックが証明できるのは「時刻ガード・暗証番号の破棄・予算・停止条件・状態遷移・出力の秘匿」まで。
 * SwitchBot側が startTime/endTime をどう解釈するか、キーパッドが実際に解錠/拒否するか、誤入力でロックされるかは証明しない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var Infra = require('../gas/switchbot-access/SwitchBotAccessInfra.gs');

var ADMIN = 'owner@example.test';
var DEVICE = 'DEVICE000000037DD';
var OTHER = 'DEVICE00000001FD';
var PLAN = 'BND_PLAN_V1_4CALLS';
var PASSCODE = '13572468';
var ATTEST = 'NOT_IN_USE_CONFIRMED';
var SECRETS = { SWITCHBOT_TOKEN: 'dummy-token-' + 'a1b2c3d4'.repeat(4), SWITCHBOT_SECRET: 'dummy-secret-' + 'e5f6a7b8'.repeat(3) };
var NORMAL = [{ id: 987654321012, name: 'normal-key-1', type: 'permanent' }];
var LEGACY_791 = JSON.stringify({ v: 1, state: 'STOPPED', calls: 5, name: 'TSTLEGACY1', baselineCount: 1, baselineFp: 'fp-legacy', reason: 'TEST_KEY_STILL_PRESENT' });
var LEGACY_797 = JSON.stringify({ v: 1, state: 'COMPLETE', calls: 6, name: 'TSTNUMID01', baselineCount: 1, baselineFp: 'fp-numid', reason: 'APP_ABSENT_CONFIRMED' });
var S = 600, D = 900; // 開始オフセットと期間

function cfgJson() {
  return JSON.stringify({ environment: 'verify', allowedLast4: ['37DD'], keypads: [{ deviceId: DEVICE }], ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test'] });
}

function makeWorld(o) {
  o = o || {};
  var w = {
    script: Object.assign({ ACCESS_CONFIG: cfgJson(), ACCESS_ENVIRONMENT: 'verify', ACCESS_ENABLED: 'false',
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }), ACCESS_TEST_KEY_STATE: LEGACY_791, ACCESS_NUMID_TEST_STATE: LEGACY_797,
      ACCESS_BND_TEST_ARMED: PLAN }, o.script || {}),
    user: Object.assign({}, SECRETS),
    keys: (o.keys || NORMAL).map(function (k) { return Object.assign({}, k); }),
    calls: [], createArgs: [], passwords: [], atCreate: null, deleteCalls: 0, nextSeq: 1, now: 1800000000, triggers: 0,
    email: ADMIN, effective: ADMIN, logs: [], propDeletes: []
  };
  w.deps = {
    identity: function () { return { email: w.email, effectiveEmail: w.effective }; },
    adminActors: { 'owner@example.test': 'ADMIN-1' },
    accessFlag: function () { return w.script.ACCESS_ENABLED === undefined ? null : w.script.ACCESS_ENABLED; },
    scriptProps: {
      get: function (k) { if (o.failScriptRead && o.failScriptRead(k)) throw new Error('LEAK-ME ' + SECRETS.SWITCHBOT_TOKEN); return w.script[k] === undefined ? null : w.script[k]; },
      set: function (k, v) { if (o.failStateWrite && k === 'ACCESS_BND_TEST_STATE' && o.failStateWrite(JSON.parse(v))) throw new Error('write fail'); w.script[k] = v; },
      del: function (k) {
        if (o.failPasscodeDel && (k === 'ACCESS_BND_TEST_PASSCODE' || k === 'ACCESS_BND_PASSCODE_ATTEST')) throw new Error('del fail');
        if (o.failApprovalDel && k === 'ACCESS_BND_TEST_APPROVAL' && o.failApprovalDel(w)) throw new Error('del fail');
        w.propDeletes.push(k); delete w.script[k];
      }
    },
    userProps: {
      get: function (k) { return w.user[k] === undefined ? null : w.user[k]; },
      set: function () { throw new Error('READ_ONLY'); }, del: function () { throw new Error('READ_ONLY'); }
    },
    lock: { tryLock: function () { return !o.lockBusy; }, releaseLock: function () {} },
    triggerCount: function () { return w.triggers; },
    api: {
      listDevices: function () {
        w.calls.push('list');
        if (o.listThrow && o.listThrow(w.calls.length)) throw new Error('timeout ' + DEVICE);
        var b = { ok: true, devices: [{ deviceId: DEVICE, keyList: w.keys.map(function (k) { return Object.assign({}, k); }) }, { deviceId: OTHER, keyList: [{ id: 111, name: 'other' }] }] };
        if (o.mutateList) o.mutateList(b, w);
        return b;
      },
      createKey: function (p) {
        w.calls.push('create'); w.createArgs.push(p); w.passwords.push(p.password);
        // 通信の時点で暗証番号プロパティが既に消えていること（通信前に破棄）を観測する
        w.atCreate = { passcode: w.script.ACCESS_BND_TEST_PASSCODE, attest: w.script.ACCESS_BND_PASSCODE_ATTEST, state: JSON.parse(w.script.ACCESS_BND_TEST_STATE), approval: w.script.ACCESS_BND_TEST_APPROVAL };
        if (o.createThrow) throw new Error('timeout ' + p.name);
        if (o.createReject) return { httpCode: 200, parsed: { statusCode: 190, body: {} } };
        if (o.afterCreate) o.afterCreate(w);
        var seq = w.nextSeq++;
        w.keys.push({ id: 123456789000 + seq, name: p.name, type: 'timeLimit', startTime: String(p.startTime), endTime: String(p.endTime) });
        return { httpCode: 200, parsed: { statusCode: 100, body: {} } };
      },
      deleteKey: function () { w.deleteCalls++; throw new Error('deleteKey must be unreachable'); }
    },
    sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); },
    randomInt: function (n) { return crypto.randomInt(n); },
    nowSec: function () { if (o.nowSeq && o.nowSeq.length) return o.nowSeq.shift(); return w.now; }
  };
  return w;
}

function plain(x) { return JSON.parse(JSON.stringify(x)); }
function stg(w, stage, extra) { w.script.ACCESS_BND_TEST_APPROVAL = stage; return plain(Infra.bndStage(w.deps, stage)); }
function issue(w) { w.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST; return stg(w, 'ISSUE'); }
function obs(w, v) { w.script.ACCESS_BND_TEST_APPROVAL = v; return plain(Infra.bndObserve(w.deps)); }
function app(w, v) { w.script.ACCESS_BND_TEST_APPROVAL = v; return plain(Infra.bndAppCheck(w.deps)); }
function status(w) { return plain(Infra.bndStatus(w.deps)); }
function st(w) { return JSON.parse(w.script.ACCESS_BND_TEST_STATE); }

/** 正常系を VERIFY_ISSUED 完了（ISSUED_VERIFIED）まで進める。T0=now を基準に S=T0+600。 */
function toVerified(w) {
  assert.strictEqual(stg(w, 'LIST').ok, true);
  w.now += 90;
  var i = issue(w); assert.strictEqual(i.ok, true, JSON.stringify(i));
  w.now += 150;
  var v = stg(w, 'VERIFY_ISSUED'); assert.strictEqual(v.ok, true, JSON.stringify(v));
  return v;
}
function startOf(w) { return st(w).startSec; }
function endOf(w) { return st(w).endSec; }

function leakCheck(w, r) {
  var all = JSON.stringify(r);
  var needles = [DEVICE, OTHER, ADMIN, 'ADMIN-1', 'normal-key', 'LEAK-ME', 'ops@example.test', '987654321012', '123456789', 'TSTLEGACY1', 'TSTNUMID01', PASSCODE];
  Object.keys(SECRETS).forEach(function (k) { needles.push(SECRETS[k]); });
  w.createArgs.forEach(function (a) { needles.push(a.name); });
  needles.forEach(function (x) { assert.ok(all.indexOf(x) === -1, 'leak ' + String(x).slice(0, 6)); });
}
function legacyUntouched(w) {
  assert.strictEqual(w.script.ACCESS_TEST_KEY_STATE, LEGACY_791, '#791 の状態は不変');
  assert.strictEqual(w.script.ACCESS_NUMID_TEST_STATE, LEGACY_797, '#797 の状態は不変');
  assert.strictEqual(w.script.ACCESS_ENABLED, 'false');
  assert.strictEqual(w.triggers, 0);
}
function noSecretsLeft(w) {
  assert.strictEqual(w.script.ACCESS_BND_TEST_PASSCODE, undefined, '暗証番号プロパティが残っていない');
  assert.strictEqual(w.script.ACCESS_BND_PASSCODE_ATTEST, undefined, '申告プロパティが残っていない');
  assert.ok(JSON.stringify(w.script).indexOf(PASSCODE) === -1, '暗証番号がどのプロパティ（状態含む）にも残っていない');
}

// ───────────────── 時刻ガード（純粋関数） ─────────────────

test('bndWindowPlan: 開始オフセット300〜900・期間600〜1800の範囲外と不正な現在時刻は拒否する', function () {
  var ok = Infra.bndWindowPlan(1800000000, 600, 900);
  assert.deepStrictEqual(plain(ok), { ok: true, startSec: 1800000600, endSec: 1800001500 });
  [[299, 900], [901, 900], [600, 599], [600, 1801], ['600', 900], [600, '900'], [NaN, 900]].forEach(function (a) {
    assert.strictEqual(Infra.bndWindowPlan(1800000000, a[0], a[1]).ok, false, JSON.stringify(a));
  });
  assert.strictEqual(Infra.bndWindowPlan(0, 600, 900).ok, false);
  assert.strictEqual(Infra.bndWindowPlan('x', 600, 900).ok, false);
});

// ───────────────── 正常系 ─────────────────

test('正常系: 通信は GET3+POST1=4回、各1回。createKey は未来開始（S=T0+600）・期間900秒の epoch 秒、通信前に暗証番号が破棄済み、deleteKey は呼ばれない', function () {
  var w = makeWorld(); var t0;
  var r1 = stg(w, 'LIST'); assert.strictEqual(r1.ok, true); assert.strictEqual(r1.code, 'BND_LIST_OK'); assert.strictEqual(r1.keyCount, 1);
  w.now += 90; t0 = w.now;
  var r2 = issue(w);
  assert.strictEqual(r2.ok, true, JSON.stringify(r2)); assert.strictEqual(r2.apiCalls, 1); assert.strictEqual(r2.passcodeState, 'CONSUMED');
  assert.strictEqual(w.createArgs.length, 1);
  assert.strictEqual(w.createArgs[0].startTime, t0 + S); assert.strictEqual(w.createArgs[0].endTime, t0 + S + D);
  assert.strictEqual(w.createArgs[0].password, PASSCODE);
  assert.strictEqual(w.atCreate.passcode, undefined, '通信の時点で暗証番号プロパティは消えている');
  assert.strictEqual(w.atCreate.attest, undefined);
  assert.strictEqual(w.atCreate.approval, undefined, '承認は通信前に消費済み');
  assert.strictEqual(w.atCreate.state.state, 'ISSUE_SENT'); assert.strictEqual(w.atCreate.state.calls, 2, '呼出し回数は通信前に永続済み');
  noSecretsLeft(w);
  w.now += 150;
  var r3 = stg(w, 'VERIFY_ISSUED'); assert.strictEqual(r3.ok, true); assert.strictEqual(r3.keyCount, 2); assert.strictEqual(r3.attrEcho, 'RETURNED_AND_MATCHED');
  assert.strictEqual(st(w).state, 'ISSUED_VERIFIED');
  // 観測（物理操作の申告）: S-180 で A1、S+180 で A2、E-180 で A3、E+180 で A4
  var s = startOf(w), e = endOf(w);
  w.now = s - 180; assert.strictEqual(obs(w, 'A1_DENIED').ok, true);
  w.now = s + 180; assert.strictEqual(obs(w, 'A2_UNLOCKED').ok, true);
  w.now = e - 180; assert.strictEqual(obs(w, 'A3_UNLOCKED').ok, true);
  w.now = e + 180; assert.strictEqual(obs(w, 'A4_DENIED').ok, true);
  assert.strictEqual(st(w).state, 'A4_RECORDED');
  w.now = e + 300;
  var r4 = stg(w, 'FINAL_LIST'); assert.strictEqual(r4.ok, true); assert.strictEqual(r4.expiredKeyListed, true); assert.strictEqual(r4.appCheck, 'PENDING_OWNER');
  assert.strictEqual(st(w).state, 'FINAL_LISTED_APP_PENDING');
  assert.notStrictEqual(st(w).state, 'RECOVERED', 'APIの観測だけでは回収完了にしない'); assert.strictEqual(r4.verdict, 'BOUNDARY_PASS'); assert.strictEqual(r4.recovery, 'PENDING_APP_REMOVAL');
  // 公式アプリで手動削除（モック上でキーを除去）→ 不在の目視
  w.keys = w.keys.filter(function (k) { return k.name === 'normal-key-1'; });
  var r5 = app(w, 'APP_ABSENT');
  assert.strictEqual(r5.ok, true); assert.strictEqual(r5.state, 'RECOVERED'); assert.strictEqual(r5.recovery, 'RECOVERED');
  assert.strictEqual(r5.verdict, 'BOUNDARY_PASS'); assert.strictEqual(r5.outcome, 'RECOVERED_AND_BOUNDARY_PASS'); assert.strictEqual(r5.decisionUse, 'USABLE_FOR_01FD_JUDGEMENT'); assert.strictEqual(r5.a2Basis, 'FIRST_ATTEMPT');
  assert.deepStrictEqual(w.calls, ['list', 'create', 'list', 'list']);
  assert.strictEqual(w.deleteCalls, 0, 'deleteKey は一度も呼ばれない');
  assert.strictEqual(st(w).calls, 4);
  assert.deepStrictEqual(st(w).obs, { A1: 'DENIED', A2: 'UNLOCKED', A3: 'UNLOCKED', A4: 'DENIED' });
  noSecretsLeft(w); legacyUntouched(w);
  [r1, r2, r3, r4, r5].forEach(function (r) { leakCheck(w, r); });
});

test('FINAL_LIST: 期限切れキーが一覧から消えていても失敗にしない（残存/不在を別々に記録）。ただし公式アプリの確認なしに完了にしない', function () {
  var w = makeWorld(); toVerified(w);
  var s = startOf(w), e = endOf(w);
  w.now = s - 180; obs(w, 'A1_DENIED'); w.now = s + 180; obs(w, 'A2_UNLOCKED'); w.now = e - 180; obs(w, 'A3_UNLOCKED'); w.now = e + 180; obs(w, 'A4_DENIED');
  w.keys = w.keys.filter(function (k) { return k.name === 'normal-key-1'; }); // 端末側で自動消去された想定
  w.now = e + 300;
  var r = stg(w, 'FINAL_LIST');
  assert.strictEqual(r.ok, true); assert.strictEqual(r.expiredKeyListed, false); assert.strictEqual(r.appCheck, 'PENDING_OWNER');
  assert.strictEqual(st(w).state, 'FINAL_LISTED_APP_PENDING');
});

// ───────────────── 暗証番号のライフサイクル ─────────────────

test('暗証番号: 申告なし／形式不正／弱い番号／未設定は発行せず通信ゼロ、ISSUE の拒否経路でも暗証番号と申告が破棄される', function () {
  [
    { pc: PASSCODE, at: undefined, code: 'PASSCODE_UNIQUENESS_UNATTESTED' },
    { pc: PASSCODE, at: 'YES', code: 'PASSCODE_UNIQUENESS_UNATTESTED' },
    { pc: '1234567', at: ATTEST, code: 'PASSCODE_INVALID' },
    { pc: '123456789', at: ATTEST, code: 'PASSCODE_INVALID' },
    { pc: '1234abcd', at: ATTEST, code: 'PASSCODE_INVALID' },
    { pc: '11111111', at: ATTEST, code: 'PASSCODE_INVALID' },
    { pc: '12345678', at: ATTEST, code: 'PASSCODE_INVALID' },
    { pc: '87654321', at: ATTEST, code: 'PASSCODE_INVALID' },
    { pc: undefined, at: ATTEST, code: 'PASSCODE_NOT_SET' }
  ].forEach(function (c) {
    var w = makeWorld(); stg(w, 'LIST'); w.now += 90;
    if (c.pc !== undefined) w.script.ACCESS_BND_TEST_PASSCODE = c.pc;
    if (c.at !== undefined) w.script.ACCESS_BND_PASSCODE_ATTEST = c.at;
    var r = stg(w, 'ISSUE');
    assert.strictEqual(r.ok, false, c.code); assert.strictEqual(r.code, c.code);
    assert.strictEqual(w.calls.length, 1, '通信は LIST の1回のみ');
    assert.strictEqual(w.createArgs.length, 0);
    assert.strictEqual(w.script.ACCESS_BND_TEST_PASSCODE, undefined, c.code + ': 暗証番号は破棄');
    assert.strictEqual(w.script.ACCESS_BND_PASSCODE_ATTEST, undefined, c.code + ': 申告も破棄');
    leakCheck(w, r);
  });
});

test('暗証番号: ISSUE の別の拒否（承認なし・順序違反・LIST直後で間隔不足・ロック競合・認証情報なし）でも破棄される', function () {
  var cases = {
    NOT_APPROVED: function (w) { return { r: (function () { w.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST; delete w.script.ACCESS_BND_TEST_APPROVAL; return plain(Infra.bndStage(w.deps, 'ISSUE')); })(), code: 'STAGE_NOT_APPROVED' }; },
    TOO_SOON: function (w) { w.now -= 60; return { r: issue(w), code: 'INTERVAL_NOT_ELAPSED' }; },
    NO_CREDS: function (w) { w.user = {}; return { r: issue(w), code: 'AUTH_CREDENTIALS_MISSING' }; }
  };
  Object.keys(cases).forEach(function (k) {
    var w = makeWorld(); stg(w, 'LIST'); w.now += 90;
    var c = cases[k](w);
    assert.strictEqual(c.r.code, c.code, k); assert.strictEqual(w.createArgs.length, 0, k);
    noSecretsLeft(w);
  });
  var w2 = makeWorld(); w2.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w2.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST;
  var r = stg(w2, 'ISSUE'); assert.strictEqual(r.code, 'STAGE_ORDER_VIOLATION'); noSecretsLeft(w2);
  var w3 = makeWorld({ lockBusy: true }); w3.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w3.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST;
  var r3 = stg(w3, 'ISSUE'); assert.strictEqual(r3.code, 'LOCK_UNAVAILABLE'); noSecretsLeft(w3);
});

test('暗証番号: createKey の例外・不受理・状態保存失敗・承認消費失敗のどの経路でも、暗証番号は出力・状態・プロパティに残らない', function () {
  var variants = {
    THROW: { o: { createThrow: true }, code: 'ISSUE_RESULT_UNKNOWN' },
    REJECT: { o: { createReject: true }, code: 'ISSUE_RESULT_UNKNOWN' },
    APPROVAL_DEL_FAIL: { o: { failApprovalDel: function (w) { return w.calls.length >= 1; } }, code: 'APPROVAL_CONSUME_FAILED', noComm: true },
    PRE_STATE_FAIL: { o: { failStateWrite: function (s) { return s.state === 'ISSUE_SENT'; } }, code: 'STATE_WRITE_FAILED', noComm: true },
    POST_STATE_FAIL: { o: { failStateWrite: function (s) { return s.state === 'ISSUE_ACCEPTED'; } }, code: 'STATE_WRITE_FAILED' }
  };
  Object.keys(variants).forEach(function (k) {
    var v = variants[k]; var w = makeWorld(v.o); stg(w, 'LIST'); w.now += 90;
    var r = issue(w);
    assert.strictEqual(r.ok, false, k); assert.strictEqual(r.code, v.code, k);
    if (v.noComm) assert.strictEqual(w.createArgs.length, 0, k + ': 通信しない'); else assert.strictEqual(w.createArgs.length, 1, k + ': createKey は1回だけ（再送なし）');
    noSecretsLeft(w); leakCheck(w, r);
    assert.ok(w.calls.filter(function (c) { return c === 'create'; }).length <= 1, k);
  });
});

test('暗証番号: 削除に失敗したら通信せず STOPPED（PASSCODE_DELETE_FAILED・手動復旧）。残留を成功扱いしない', function () {
  var w = makeWorld({ failPasscodeDel: true }); stg(w, 'LIST'); w.now += 90;
  var r = issue(w);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'PASSCODE_DELETE_FAILED'); assert.strictEqual(r.manualRecovery, true);
  assert.strictEqual(r.passcodeState, 'SCRUB_FAILED');
  assert.strictEqual(w.createArgs.length, 0, 'createKey は送られない');
  assert.strictEqual(st(w).state, 'STOPPED');
  leakCheck(w, r);
});

test('暗証番号: ISSUE 以外の段階で残留していたら破棄して停止（PASSCODE_RESIDUAL）。状態確認は値を読まず PRESENT/ABSENT のみ出す', function () {
  var w = makeWorld(); w.script.ACCESS_BND_TEST_PASSCODE = PASSCODE;
  var s0 = status(w); assert.strictEqual(s0.passcode, 'PRESENT'); assert.strictEqual(s0.passcodeAttest, 'ABSENT'); leakCheck(w, s0);
  var r = stg(w, 'LIST');
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'PASSCODE_RESIDUAL'); assert.strictEqual(w.calls.length, 0);
  noSecretsLeft(w);
  var s1 = status(w); assert.strictEqual(s1.passcode, 'ABSENT');
});

// ───────────────── 時刻と観測の安全設計 ─────────────────

test('T0 は送信直前の時計で固定: 状態永続と送信の時計差が5秒超なら createKey を送らず停止（ISSUE_CLOCK_DRIFT）', function () {
  var w = makeWorld(); stg(w, 'LIST'); w.now += 90;
  var base = w.now;
  w.deps.nowSec = (function () { var n = 0; return function () { n++; return n <= 1 ? base : base + 6; }; })();
  var r = issue(w);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'ISSUE_CLOCK_DRIFT'); assert.strictEqual(r.apiCalls, 0);
  assert.strictEqual(w.createArgs.length, 0); noSecretsLeft(w); assert.strictEqual(st(w).state, 'STOPPED');
});

test('VERIFY_ISSUED: 発行から120秒未満は通信も承認消費もしない／S-240秒を過ぎたら通信せず停止（A1の余裕を機械的に確保）', function () {
  var w = makeWorld(); stg(w, 'LIST'); w.now += 90; issue(w);
  w.now += 119;
  w.script.ACCESS_BND_TEST_APPROVAL = 'VERIFY_ISSUED';
  var r = plain(Infra.bndStage(w.deps, 'VERIFY_ISSUED'));
  assert.strictEqual(r.code, 'OBSERVATION_WINDOW_NOT_ELAPSED'); assert.strictEqual(w.calls.length, 2, '追加通信なし');
  assert.strictEqual(w.script.ACCESS_BND_TEST_APPROVAL, 'VERIFY_ISSUED', '承認は消費されない'); assert.strictEqual(st(w).calls, 2);
  w.now = startOf(w) - 239; // S-240 を過ぎた
  var late = plain(Infra.bndStage(w.deps, 'VERIFY_ISSUED'));
  assert.strictEqual(late.ok, false); assert.strictEqual(late.code, 'A1_HEADROOM_INSUFFICIENT'); assert.strictEqual(late.apiCalls, 0);
  assert.strictEqual(w.calls.length, 2); assert.strictEqual(st(w).state, 'STOPPED'); assert.strictEqual(late.manualRecovery, true);
});

test('LIST の基準が900秒より古い場合は発行しない（BASELINE_STALE）。LIST から60秒未満は通信せず待つ', function () {
  var w = makeWorld(); stg(w, 'LIST'); w.now += 30;
  w.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST;
  assert.strictEqual(stg(w, 'ISSUE').code, 'INTERVAL_NOT_ELAPSED'); noSecretsLeft(w);
  var w2 = makeWorld(); stg(w2, 'LIST'); w2.now += 901;
  var r = issue(w2); assert.strictEqual(r.code, 'BASELINE_STALE'); assert.strictEqual(w2.createArgs.length, 0); noSecretsLeft(w2);
});

test('VERIFY_ISSUED: 返却された開始・終了が要求と違う／試験キーが0件・重複／通常キー変化は停止', function () {
  var bad = { MISMATCH: { o: { afterCreate: function (w) { w.keys.push({ id: 5, name: 'x' }); w.keys.pop(); } }, mut: function (w) { var k = w.keys[w.keys.length - 1]; k.startTime = String(Number(k.startTime) - 1); }, code: 'KEY_ATTR_MISMATCH' },
    MISSING: { mut: function (w) { w.keys.pop(); }, code: 'KEY_NOT_FOUND' },
    NORMAL_CHANGED: { mut: function (w) { w.keys[0].name = 'renamed'; }, code: 'EXISTING_KEYS_CHANGED' } };
  Object.keys(bad).forEach(function (k) {
    var w = makeWorld(); stg(w, 'LIST'); w.now += 90; issue(w); bad[k].mut(w); w.now += 150;
    var r = stg(w, 'VERIFY_ISSUED'); assert.strictEqual(r.ok, false, k); assert.ok(r.code === bad[k].code || r.code.indexOf('KEY_') === 0 || r.code === 'KEYLIST_COUNT_MISMATCH', k + ' ' + r.code);
    assert.strictEqual(st(w).state, 'STOPPED', k);
  });
});

test('観測の時刻整合: A1 は開始前、A2/A3 は期間内、A4 は期限後にしか申告できない（外れたら状態を変えず拒否。SKIPPED を申告する）', function () {
  var w = makeWorld(); toVerified(w); var s = startOf(w), e = endOf(w);
  w.now = s; var r = obs(w, 'A1_DENIED'); assert.strictEqual(r.code, 'OBSERVATION_TIME_MISMATCH'); assert.strictEqual(st(w).state, 'ISSUED_VERIFIED');
  assert.strictEqual(w.script.ACCESS_BND_TEST_APPROVAL, 'A1_DENIED', '時刻不整合では承認を消費しない');
  assert.strictEqual(obs(w, 'A1_SKIPPED').ok, true); assert.strictEqual(st(w).obs.A1, 'SKIPPED');
  w.now = s - 1; assert.strictEqual(obs(w, 'A2_UNLOCKED').code, 'OBSERVATION_TIME_MISMATCH');
  w.now = s + 180; assert.strictEqual(obs(w, 'A2_UNLOCKED').ok, true);
  w.now = e; assert.strictEqual(obs(w, 'A3_UNLOCKED').code, 'OBSERVATION_TIME_MISMATCH');
  w.now = e - 180; assert.strictEqual(obs(w, 'A3_UNLOCKED').ok, true);
  w.now = e - 1; assert.strictEqual(obs(w, 'A4_DENIED').code, 'OBSERVATION_TIME_MISMATCH');
  w.now = e + 180; assert.strictEqual(obs(w, 'A4_DENIED').ok, true);
});

test('観測の順序: A1 より前に A2、同じ段階の二重申告、FINAL_LIST の前倒しはできない', function () {
  var w = makeWorld(); toVerified(w); var s = startOf(w), e = endOf(w);
  w.now = s + 180; assert.strictEqual(obs(w, 'A2_UNLOCKED').code, 'STAGE_ORDER_VIOLATION');
  w.now = s - 180; assert.strictEqual(obs(w, 'A1_DENIED').ok, true);
  assert.strictEqual(obs(w, 'A1_DENIED').code, 'STAGE_ORDER_VIOLATION');
  w.now = e + 300; w.script.ACCESS_BND_TEST_APPROVAL = 'FINAL_LIST';
  assert.strictEqual(plain(Infra.bndStage(w.deps, 'FINAL_LIST')).code, 'STAGE_ORDER_VIOLATION');
});

test('FINAL_LIST は E+300秒より前には通信しない（承認・回数も消費しない）', function () {
  var w = makeWorld(); toVerified(w); var s = startOf(w), e = endOf(w);
  w.now = s - 180; obs(w, 'A1_DENIED'); w.now = s + 180; obs(w, 'A2_UNLOCKED'); w.now = e - 180; obs(w, 'A3_UNLOCKED'); w.now = e + 180; obs(w, 'A4_DENIED');
  w.now = e + 299; var before = w.calls.length;
  w.script.ACCESS_BND_TEST_APPROVAL = 'FINAL_LIST';
  var r = plain(Infra.bndStage(w.deps, 'FINAL_LIST'));
  assert.strictEqual(r.code, 'OBSERVATION_WINDOW_NOT_ELAPSED'); assert.strictEqual(w.calls.length, before); assert.strictEqual(w.script.ACCESS_BND_TEST_APPROVAL, 'FINAL_LIST'); assert.strictEqual(st(w).calls, 3);
});

// ───────────────── 重大異常・一時ロック・A2 の再試行 ─────────────────

test('重大: A1 で解錠できた／A4 で解錠できた／A3 で拒否／キーパッドのロック・警報の兆候は、即 STOPPED（手動復旧）で成功扱いしない', function () {
  var cases = [
    { upto: 0, v: 'A1_UNLOCKED', code: 'A1_UNLOCKED_BEFORE_START', t: function (s) { return s - 180; } },
    { upto: 0, v: 'KEYPAD_LOCK_SIGN', code: 'KEYPAD_LOCK_OR_ALARM_SIGN', t: function (s) { return s - 170; } },
    { upto: 3, v: 'A4_UNLOCKED', code: 'A4_UNLOCKED_AFTER_END', t: function (s, e) { return e + 180; } },
    { upto: 2, v: 'A3_DENIED', code: 'A3_DENIED_IN_WINDOW', t: function (s, e) { return e - 180; } }
  ];
  cases.forEach(function (c) {
    var w = makeWorld(); toVerified(w); var s = startOf(w), e = endOf(w);
    var seq = [['A1_DENIED', s - 180], ['A2_UNLOCKED', s + 180], ['A3_UNLOCKED', e - 180]];
    for (var i = 0; i < c.upto; i++) { w.now = seq[i][1]; assert.strictEqual(obs(w, seq[i][0]).ok, true); }
    w.now = c.t(s, e);
    var r = obs(w, c.v);
    assert.strictEqual(r.ok, false, c.v); assert.strictEqual(r.code, c.code); assert.strictEqual(r.manualRecovery, true);
    assert.strictEqual(st(w).state, 'STOPPED'); assert.strictEqual(st(w).reason, c.code);
    // 以後の通信段階・観測は止まる（追加通信なし）
    var before = w.calls.length; w.now = e + 400;
    assert.strictEqual(stg(w, 'FINAL_LIST').code, 'STOPPED_MANUAL_RECOVERY'); assert.strictEqual(w.calls.length, before);
    assert.strictEqual(obs(w, 'A4_DENIED').code, 'STOPPED_MANUAL_RECOVERY');
  });
});

test('A2 の最初の拒否: GO欄の再試行許可（ALLOWED_ONCE）がなければ STOPPED。許可があれば1回だけ消費して A2R を申告できる', function () {
  var w = makeWorld(); toVerified(w); var s = startOf(w);
  w.now = s - 180; obs(w, 'A1_DENIED'); w.now = s + 180;
  var r = obs(w, 'A2_DENIED'); assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'A2_DENIED_NO_RETRY_GO'); assert.strictEqual(st(w).state, 'STOPPED');

  var w2 = makeWorld(); toVerified(w2); s = startOf(w2);
  w2.now = s - 180; obs(w2, 'A1_DENIED'); w2.now = s + 180; w2.script.ACCESS_BND_A2_RETRY_GO = 'ALLOWED_ONCE';
  var r2 = obs(w2, 'A2_DENIED'); assert.strictEqual(r2.ok, true); assert.strictEqual(r2.state, 'A2_RETRY_PENDING');
  assert.strictEqual(w2.script.ACCESS_BND_A2_RETRY_GO, undefined, '再試行許可は1回で消費');
  w2.now = s + 300;
  assert.strictEqual(obs(w2, 'A2R_UNLOCKED').ok, true); assert.strictEqual(st(w2).state, 'A2_RECORDED');

  var w3 = makeWorld(); toVerified(w3); s = startOf(w3);
  w3.now = s - 180; obs(w3, 'A1_DENIED'); w3.now = s + 180; w3.script.ACCESS_BND_A2_RETRY_GO = 'ALLOWED_ONCE'; obs(w3, 'A2_DENIED'); w3.now = s + 300;
  var r3 = obs(w3, 'A2R_DENIED'); assert.strictEqual(r3.code, 'A2_DENIED_AFTER_RETRY'); assert.strictEqual(st(w3).state, 'STOPPED');

  var w4 = makeWorld(); toVerified(w4); s = startOf(w4);
  w4.now = s - 180; obs(w4, 'A1_DENIED'); w4.now = s + 180; w4.script.ACCESS_BND_A2_RETRY_GO = 'ALLOWED_TWICE';
  assert.strictEqual(obs(w4, 'A2_DENIED').code, 'A2_DENIED_NO_RETRY_GO', '許可値が違えば再試行しない');
});

test('INCONCLUSIVE（誤入力のロック・通信不良など前提が崩れた拒否）は証拠として数えず注記する。SKIPPED は未実施として残る', function () {
  var w = makeWorld(); toVerified(w); var s = startOf(w), e = endOf(w);
  w.now = s - 180; var r = obs(w, 'A1_INCONCLUSIVE'); assert.strictEqual(r.ok, true); assert.ok(r.notes.indexOf('INCONCLUSIVE_NOT_PROOF') !== -1);
  w.now = s + 180; obs(w, 'A2_UNLOCKED'); w.now = e - 180; obs(w, 'A3_SKIPPED'); w.now = e + 180; obs(w, 'A4_SKIPPED');
  assert.deepStrictEqual(st(w).obs, { A1: 'INCONCLUSIVE', A2: 'UNLOCKED', A3: 'SKIPPED', A4: 'SKIPPED' });
});

// ───────────────── 回収（完了条件）・予算・停止 ─────────────────

test('回収: 公式アプリで残存（APP_PRESENT）なら STOPPED のまま。途中停止からの回収は STOPPED_RECOVERED（合否は NOT_ESTABLISHED）', function () {
  var w = makeWorld(); toVerified(w); var s = startOf(w), e = endOf(w);
  w.now = s - 180; obs(w, 'A1_DENIED'); w.now = s + 180; obs(w, 'A2_UNLOCKED'); w.now = e - 180; obs(w, 'A3_UNLOCKED'); w.now = e + 180; obs(w, 'A4_DENIED'); w.now = e + 300; stg(w, 'FINAL_LIST');
  var p = app(w, 'APP_PRESENT'); assert.strictEqual(p.ok, false); assert.strictEqual(p.code, 'APP_STILL_PRESENT'); assert.strictEqual(p.manualRecovery, true); assert.strictEqual(st(w).state, 'STOPPED');

  var w2 = makeWorld(); toVerified(w2); s = startOf(w2); w2.now = s - 170; obs(w2, 'A1_UNLOCKED'); // 重大異常で停止
  var rec = app(w2, 'APP_ABSENT');
  assert.strictEqual(rec.ok, true); assert.strictEqual(rec.state, 'STOPPED_RECOVERED'); assert.strictEqual(rec.outcome, 'ABORTED_AND_RECOVERED'); assert.strictEqual(rec.verdict, 'BOUNDARY_NOT_ESTABLISHED'); assert.strictEqual(rec.decisionUse, 'NOT_USABLE_FOR_01FD_JUDGEMENT');
  assert.strictEqual(st(w2).state, 'STOPPED_RECOVERED');

  var w3 = makeWorld(); toVerified(w3);
  assert.strictEqual(app(w3, 'APP_ABSENT').code, 'STAGE_ORDER_VIOLATION', 'FINAL_LIST 前に回収完了にできない');
  var w4 = makeWorld(); stg(w4, 'LIST'); w4.now += 90; w4.script.ACCESS_BND_TEST_PASSCODE = PASSCODE;
  assert.strictEqual(app(w4, 'APP_ABSENT').code, 'PASSCODE_RESIDUAL');
});

test('回収: 発行前の停止（試験キーなし）には回収記録は不要。STAGE_ORDER_VIOLATION', function () {
  var w = makeWorld(); stg(w, 'LIST'); w.now += 90;
  var st0 = st(w); st0.state = 'STOPPED'; st0.reason = 'X'; w.script.ACCESS_BND_TEST_STATE = JSON.stringify(st0);
  assert.strictEqual(app(w, 'APP_ABSENT').code, 'STAGE_ORDER_VIOLATION');
});

test('予算: 4回を超えて通信しない。timeout/UNKNOWN は再送も追加確認もせず停止し、以後の段階は通信しない', function () {
  var w = makeWorld({ listThrow: function (n) { return n === 3; } });
  stg(w, 'LIST'); w.now += 90; issue(w); w.now += 150;
  var r = stg(w, 'VERIFY_ISSUED'); assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'LIST_COMM_ERROR');
  assert.strictEqual(st(w).state, 'STOPPED'); var n = w.calls.length;
  w.script.ACCESS_BND_TEST_APPROVAL = 'VERIFY_ISSUED';
  assert.strictEqual(plain(Infra.bndStage(w.deps, 'VERIFY_ISSUED')).code, 'STOPPED_MANUAL_RECOVERY'); assert.strictEqual(w.calls.length, n);
  var w2 = makeWorld(); stg(w2, 'LIST'); var s2 = st(w2); s2.calls = 4; s2.state = 'LISTED'; w2.script.ACCESS_BND_TEST_STATE = JSON.stringify(s2);
  w2.now += 90; var r2 = issue(w2); assert.strictEqual(r2.code, 'CALL_BUDGET_EXHAUSTED'); assert.strictEqual(w2.createArgs.length, 0); noSecretsLeft(w2);
});

test('承認: 通信前に消費され、二重実行は通信しない。ARMED の値違い・未設定は通信前に拒否', function () {
  var w = makeWorld(); w.script.ACCESS_BND_TEST_APPROVAL = 'LIST'; Infra.bndStage(w.deps, 'LIST');
  assert.strictEqual(w.script.ACCESS_BND_TEST_APPROVAL, undefined); var n = w.calls.length;
  var again = plain(Infra.bndStage(w.deps, 'LIST')); assert.strictEqual(again.ok, false); assert.strictEqual(again.apiCalls, 0); assert.strictEqual(w.calls.length, n);
  var w2 = makeWorld({ script: { ACCESS_BND_TEST_ARMED: 'true' } }); assert.strictEqual(stg(w2, 'LIST').code, 'ARMED_PLAN_MISMATCH'); assert.strictEqual(w2.calls.length, 0);
  var w3 = makeWorld(); delete w3.script.ACCESS_BND_TEST_ARMED; assert.strictEqual(stg(w3, 'LIST').code, 'NOT_ARMED'); assert.strictEqual(w3.calls.length, 0);
});

// ───────────────── ゲート・不変・秘匿 ─────────────────

test('ゲート: 01FD・複数端末・ACCESS_ENABLED≠false・トリガーあり・実行者違いは通信前に拒否。#791/#797 の状態が COMPLETE/STOPPED でなければ拒否', function () {
  var w = makeWorld({ script: { ACCESS_CONFIG: JSON.stringify({ environment: 'verify', allowedLast4: ['01FD'], keypads: [{ deviceId: OTHER }], ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test'] }) } });
  assert.strictEqual(stg(w, 'LIST').ok, false); assert.strictEqual(w.calls.length, 0);
  var w2 = makeWorld({ script: { ACCESS_ENABLED: 'true' } }); assert.strictEqual(stg(w2, 'LIST').ok, false); assert.strictEqual(w2.calls.length, 0);
  var w3 = makeWorld(); w3.triggers = 1; assert.strictEqual(stg(w3, 'LIST').code, 'TRIGGERS_PRESENT');
  var w4 = makeWorld(); w4.email = 'other@example.test'; assert.strictEqual(stg(w4, 'LIST').ok, false); assert.strictEqual(w4.calls.length, 0);
  var w5 = makeWorld({ script: { ACCESS_NUMID_TEST_STATE: JSON.stringify({ v: 1, state: 'STOPPED', calls: 5 }) } }); assert.strictEqual(stg(w5, 'LIST').code, 'NUMID_STATE_NOT_COMPLETE');
  var w6 = makeWorld({ script: { ACCESS_TEST_KEY_STATE: JSON.stringify({ v: 1, state: 'LISTED', calls: 1 }) } }); assert.strictEqual(stg(w6, 'LIST').code, 'TEST_KEY_STATE_NOT_STOPPED');
  var w7 = makeWorld({ script: { ACCESS_NUMID_TEST_ARMED: 'NUMID_PLAN_V1_6CALLS' } }); assert.strictEqual(stg(w7, 'LIST').code, 'NUMID_ARMED_PRESENT');
  [w, w2, w3, w4, w5, w6, w7].forEach(function (x) { assert.strictEqual(x.createArgs.length, 0); });
});

test('不変: 途中で #791/#797 の状態が書き換わったら、次の通信段階は通信せず STOPPED（LEGACY_STATE_CHANGED）', function () {
  var w = makeWorld(); stg(w, 'LIST'); w.now += 90;
  w.script.ACCESS_NUMID_TEST_STATE = JSON.stringify({ v: 1, state: 'COMPLETE', calls: 6, name: 'TSTNUMID01', baselineCount: 1, baselineFp: 'tampered', reason: 'APP_ABSENT_CONFIRMED' });
  var r = issue(w); assert.strictEqual(r.code, 'LEGACY_STATE_CHANGED'); assert.strictEqual(w.createArgs.length, 0); noSecretsLeft(w); assert.strictEqual(st(w).state, 'STOPPED');
});

test('出力・ログの秘匿: すべての段階の出力に deviceId・暗証番号・キー名・ID・トークン・例外本文・メールが含まれない。deleteKey 経路がコードに存在しない', function () {
  var w = makeWorld({ failScriptRead: function (k) { return k === 'ZZZ'; } });
  var outs = [];
  outs.push(status(w)); outs.push(stg(w, 'LIST')); w.now += 90; outs.push(issue(w)); w.now += 150; outs.push(stg(w, 'VERIFY_ISSUED')); outs.push(status(w));
  outs.forEach(function (r) { leakCheck(w, r); });
  var src = fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/SwitchBotAccessInfra.gs'), 'utf8');
  var start = src.indexOf('37DD 期限境界（開始前／期間内／期限後）解錠試験');
  var end = src.indexOf('37DD 期限境界試験ここまで');
  var block = src.slice(start, end);
  assert.ok(block.length > 1000 && block.indexOf('deleteKey(') === -1 && block.indexOf('.deleteKey') === -1, '境界試験のコードに deleteKey の呼出しがない');
  var app = fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  var a0 = app.indexOf('function sba_bndDeps_'); var a1 = app.indexOf('// ── 37DD 期限境界試験ここまで ──');
  assert.ok(app.slice(a0, a1).indexOf('deleteKey') === -1 || /deleteKey は渡さない/.test(app.slice(a0, a1)), 'App 側でも deleteKey を渡さない');
  assert.ok(!/d\.api\s*=\s*\{[^}]*deleteKey/.test(app.slice(a0, a1)), 'bnd の deps.api に deleteKey がない');
});

test('状態確認: 通信ゼロ・ok=true はゲート通過のみ。開始/終了までの秒数・観測・再試行許可の有無・#791/#797の状態を値なしで出す', function () {
  var w = makeWorld(); var s0 = status(w);
  assert.strictEqual(s0.ok, true); assert.strictEqual(s0.code, 'BND_STATUS_OK'); assert.strictEqual(s0.apiCalls, 0); assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(s0.armed, 'ON'); assert.strictEqual(s0.legacyState, 'STOPPED'); assert.strictEqual(s0.numIdState, 'COMPLETE'); assert.strictEqual(s0.a2RetryGo, 'NONE');
  assert.ok(s0.notes.indexOf('STATUS_OK_IS_NOT_GO_NOR_EXECUTABLE') !== -1);
  toVerified(w); var s1 = status(w);
  assert.ok(typeof s1.secToStart === 'number' && typeof s1.secToEnd === 'number' && s1.secToEnd - s1.secToStart === D);
  w.script.ACCESS_BND_A2_RETRY_GO = 'ALLOWED_ONCE'; assert.strictEqual(status(w).a2RetryGo, 'ALLOWED_ONCE');
});


// ───────────────── 回収完了と試験合否の分離（必須1） ─────────────────

/** 観測 A1〜A4 を指定どおりに申告して FINAL_LIST → APP_ABSENT まで進め、各段階の出力を返す。 */
function runToRecovery(seq, o, setup) {
  var w = makeWorld(o); toVerified(w); if (setup) setup(w);
  var s = startOf(w), e = endOf(w);
  var times = { A1: s - 180, A2: s + 180, A2R: s + 300, A3: e - 180, A4: e + 180 };
  seq.forEach(function (v) { w.now = times[v.split('_')[0]]; var r = obs(w, v); assert.strictEqual(r.ok, true, v + ' ' + r.code); });
  w.now = e + 300;
  var f = stg(w, 'FINAL_LIST'); assert.strictEqual(f.ok, true, f.code);
  w.keys = w.keys.filter(function (k) { return k.name === 'normal-key-1'; });
  var a = app(w, 'APP_ABSENT'); assert.strictEqual(a.ok, true, a.code);
  return { w: w, final: f, app: a };
}

test('合否: SKIPPED を含む場合は回収が完了しても境界試験は PARTIAL（合格にしない・01FD判断に使えない）', function () {
  [['A1_SKIPPED', 'A2_UNLOCKED', 'A3_UNLOCKED', 'A4_DENIED'], ['A1_DENIED', 'A2_UNLOCKED', 'A3_UNLOCKED', 'A4_SKIPPED'],
   ['A1_SKIPPED', 'A2_SKIPPED', 'A3_SKIPPED', 'A4_SKIPPED']].forEach(function (seq) {
    var r = runToRecovery(seq);
    assert.strictEqual(r.app.recovery, 'RECOVERED', '回収は成功として別に記録する');
    assert.strictEqual(r.app.state, 'RECOVERED');
    assert.strictEqual(r.app.verdict, 'BOUNDARY_PARTIAL', seq.join());
    assert.strictEqual(r.app.decisionUse, 'NOT_USABLE_FOR_01FD_JUDGEMENT');
    assert.strictEqual(r.app.outcome, 'RECOVERED_BUT_NOT_PASS');
    assert.strictEqual(r.final.verdict, 'BOUNDARY_PARTIAL', 'FINAL_LIST の暫定判定も同じ');
    assert.strictEqual(st(r.w).verdict, 'BOUNDARY_PARTIAL');
  });
});

test('合否: INCONCLUSIVE（前提が崩れた拒否）を含む場合は INCONCLUSIVE。SKIPPED との併存でも合格にならない', function () {
  var r = runToRecovery(['A1_INCONCLUSIVE', 'A2_UNLOCKED', 'A3_UNLOCKED', 'A4_DENIED']);
  assert.strictEqual(r.app.verdict, 'BOUNDARY_INCONCLUSIVE'); assert.strictEqual(r.app.decisionUse, 'NOT_USABLE_FOR_01FD_JUDGEMENT'); assert.strictEqual(r.app.recovery, 'RECOVERED');
  var r2 = runToRecovery(['A1_SKIPPED', 'A2_UNLOCKED', 'A3_UNLOCKED', 'A4_INCONCLUSIVE']);
  assert.notStrictEqual(r2.app.verdict, 'BOUNDARY_PASS');
});

test('合否: A1=DENIED・A2=UNLOCKED・A3=UNLOCKED・A4=DENIED と前提の証拠がそろったときだけ PASS。許可再試行での A2 解錠は根拠を記録', function () {
  var pass = runToRecovery(['A1_DENIED', 'A2_UNLOCKED', 'A3_UNLOCKED', 'A4_DENIED']);
  assert.strictEqual(pass.app.verdict, 'BOUNDARY_PASS'); assert.strictEqual(pass.app.decisionUse, 'USABLE_FOR_01FD_JUDGEMENT');
  var retry = runToRecovery(['A1_DENIED', 'A2_DENIED', 'A2R_UNLOCKED', 'A3_UNLOCKED', 'A4_DENIED'], null, function (w) { w.script.ACCESS_BND_A2_RETRY_GO = 'ALLOWED_ONCE'; });
  assert.strictEqual(retry.app.verdict, 'BOUNDARY_PASS'); assert.strictEqual(retry.app.a2Basis, 'RETRY_GRANTED', '再試行で解錠したことを根拠として区別');
  assert.strictEqual(pass.app.a2Basis, 'FIRST_ATTEMPT');
});

test('合否: 前提の証拠（返却された開始・終了の一致）がなければ PASS にしない（PARTIAL_PREMISE_UNVERIFIED）', function () {
  var o = { mutateList: function (b, w) { if (w.calls.length === 3) b.devices[0].keyList.forEach(function (k) { if (/^TST/.test(k.name)) { delete k.startTime; delete k.endTime; } }); } };
  var r = runToRecovery(['A1_DENIED', 'A2_UNLOCKED', 'A3_UNLOCKED', 'A4_DENIED'], o);
  assert.strictEqual(st(r.w).attrEcho, 'NOT_RETURNED_UNVERIFIED');
  assert.strictEqual(r.app.verdict, 'BOUNDARY_PARTIAL_PREMISE_UNVERIFIED'); assert.strictEqual(r.app.decisionUse, 'NOT_USABLE_FOR_01FD_JUDGEMENT');
});

test('合否: 回収済みの途中停止・重大異常・アプリ残存は PASS にならない。状態確認も合否を出す', function () {
  var w = makeWorld(); toVerified(w); w.now = startOf(w) - 170; obs(w, 'A1_UNLOCKED');
  var rec = app(w, 'APP_ABSENT'); assert.strictEqual(rec.recovery, 'RECOVERED'); assert.strictEqual(rec.verdict, 'BOUNDARY_NOT_ESTABLISHED');
  var s = status(w); assert.strictEqual(s.verdict, 'BOUNDARY_NOT_ESTABLISHED');
  var r = runToRecovery(['A1_DENIED', 'A2_UNLOCKED', 'A3_UNLOCKED', 'A4_DENIED']);
  assert.strictEqual(status(r.w).verdict, 'BOUNDARY_PASS');
  var w2 = makeWorld(); toVerified(w2); var s2 = startOf(w2), e2 = endOf(w2);
  w2.now = s2 - 180; obs(w2, 'A1_DENIED'); w2.now = s2 + 180; obs(w2, 'A2_UNLOCKED'); w2.now = e2 - 180; obs(w2, 'A3_UNLOCKED'); w2.now = e2 + 180; obs(w2, 'A4_DENIED'); w2.now = e2 + 300; stg(w2, 'FINAL_LIST');
  var p = app(w2, 'APP_PRESENT'); assert.strictEqual(p.recovery, 'NOT_RECOVERED'); assert.strictEqual(p.ok, false);
});

// ───────────────── ISSUE の早期ゲート拒否でも暗証番号を残さない（必須2） ─────────────────

test('早期ゲート拒否: 番号と申告を設定したあとの ISSUE が、どのゲートで拒否されても通信ゼロで両方を削除する（読み直し確認）', function () {
  function setSecrets(w) { w.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST; w.script.ACCESS_BND_TEST_APPROVAL = 'ISSUE'; }
  var cases = {
    PRODUCTION_ENV: { w: function () { return makeWorld({ script: { ACCESS_ENVIRONMENT: 'production' } }); }, code: 'ENV_NOT_VERIFY' },
    ACCESS_ENABLED_ON: { w: function () { return makeWorld({ script: { ACCESS_ENABLED: 'true' } }); } },
    TRIGGERS: { w: function () { var w = makeWorld(); w.triggers = 1; return w; }, code: 'TRIGGERS_PRESENT' },
    NOT_ADMIN: { w: function () { var w = makeWorld(); w.email = 'other@example.test'; return w; } },
    DEVICE_01FD: { w: function () { return makeWorld({ script: { ACCESS_CONFIG: JSON.stringify({ environment: 'verify', allowedLast4: ['01FD'], keypads: [{ deviceId: OTHER }], ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test'] }) } }); } },
    LEGACY_791_NOT_STOPPED: { w: function () { return makeWorld({ script: { ACCESS_TEST_KEY_STATE: JSON.stringify({ v: 1, state: 'LISTED', calls: 1 }) } }); }, code: 'TEST_KEY_STATE_NOT_STOPPED' },
    LEGACY_797_NOT_COMPLETE: { w: function () { return makeWorld({ script: { ACCESS_NUMID_TEST_STATE: JSON.stringify({ v: 1, state: 'STOPPED', calls: 5 }) } }); }, code: 'NUMID_STATE_NOT_COMPLETE' },
    NUMID_ARMED_PRESENT: { w: function () { return makeWorld({ script: { ACCESS_NUMID_TEST_ARMED: 'NUMID_PLAN_V1_6CALLS' } }); }, code: 'NUMID_ARMED_PRESENT' },
    NOT_ARMED: { w: function () { var w = makeWorld(); delete w.script.ACCESS_BND_TEST_ARMED; return w; }, code: 'NOT_ARMED' },
    ARMED_MISMATCH: { w: function () { return makeWorld({ script: { ACCESS_BND_TEST_ARMED: 'true' } }); }, code: 'ARMED_PLAN_MISMATCH' },
    STATE_UNREADABLE: { w: function () { return makeWorld({ script: { ACCESS_BND_TEST_STATE: 'not-json' } }); }, code: 'STATE_UNREADABLE' },
    LOCK_BUSY: { w: function () { return makeWorld({ lockBusy: true }); }, code: 'LOCK_UNAVAILABLE' }
  };
  Object.keys(cases).forEach(function (k) {
    var w = cases[k].w(); setSecrets(w);
    var r = plain(Infra.bndStage(w.deps, 'ISSUE'));
    assert.strictEqual(r.ok, false, k); if (cases[k].code) assert.strictEqual(r.code, cases[k].code, k);
    assert.strictEqual(w.calls.length, 0, k + ': 通信ゼロ'); assert.strictEqual(w.createArgs.length, 0, k);
    noSecretsLeft(w); assert.strictEqual(r.passcodeState, 'SCRUBBED_ON_STOP', k);
    assert.deepStrictEqual(w.propDeletes.sort(), ['ACCESS_BND_PASSCODE_ATTEST', 'ACCESS_BND_TEST_PASSCODE'], k + ': 削除は番号と申告の2つだけ');
    leakCheck(w, r);
  });
});

test('早期ゲート拒否: 例外（プロパティ読取の失敗）でも番号は破棄を試みる。削除できなければ残留を明示して手動復旧へ引き継ぐ', function () {
  var w = makeWorld({ failScriptRead: function (k) { return k === 'ACCESS_BND_TEST_ARMED'; } });
  w.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST; w.script.ACCESS_BND_TEST_APPROVAL = 'ISSUE';
  var r = plain(Infra.bndStage(w.deps, 'ISSUE'));
  assert.strictEqual(r.ok, false); assert.strictEqual(w.calls.length, 0); assert.strictEqual(w.createArgs.length, 0);
  noSecretsLeft(w); leakCheck(w, r);
  // 削除そのものが失敗する場合
  var w2 = makeWorld({ failPasscodeDel: true, script: { ACCESS_ENVIRONMENT: 'production' } });
  w2.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w2.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST;
  var r2 = plain(Infra.bndStage(w2.deps, 'ISSUE'));
  assert.strictEqual(r2.ok, false); assert.strictEqual(r2.code, 'ENV_NOT_VERIFY', '元の拒否理由を保つ');
  assert.strictEqual(r2.passcodeState, 'SCRUB_FAILED'); assert.strictEqual(r2.manualRecovery, true, '残留を明示し手動対応へ');
  assert.strictEqual(w2.calls.length, 0); leakCheck(w2, r2);
});

test('早期ゲート拒否: 番号を設定していなければ何も削除しない。ISSUE 以外の段階は、ゲート拒否で番号に触れない', function () {
  var w = makeWorld({ script: { ACCESS_ENVIRONMENT: 'production' } }); w.script.ACCESS_BND_TEST_APPROVAL = 'ISSUE';
  var r = plain(Infra.bndStage(w.deps, 'ISSUE')); assert.strictEqual(r.code, 'ENV_NOT_VERIFY'); assert.deepStrictEqual(w.propDeletes, [], '未設定なら削除操作自体を行わない');
  var w2 = makeWorld({ script: { ACCESS_ENVIRONMENT: 'production' } }); w2.script.ACCESS_BND_TEST_PASSCODE = PASSCODE; w2.script.ACCESS_BND_PASSCODE_ATTEST = ATTEST;
  var r2 = plain(Infra.bndStage(w2.deps, 'LIST')); assert.strictEqual(r2.code, 'ENV_NOT_VERIFY');
  assert.strictEqual(w2.script.ACCESS_BND_TEST_PASSCODE, PASSCODE, 'LIST は番号に触れない（ゲートが先）');
});
