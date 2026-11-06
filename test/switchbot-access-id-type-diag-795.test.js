/*
 * Issue #795: 37DD keyList.id の「型のみ」読取専用診断のテスト。
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
var NUM_KEYS = [{ id: 987654321012, name: 'normal-key-1', type: 'permanent' }];
var STR_KEYS = [{ id: 'STR-ID-AAA111', name: 'normal-key-1', type: 'permanent' }];
var STOPPED_STATE = JSON.stringify({ v: 1, state: 'STOPPED', calls: 5, name: 'TSTABCDEFGH', baselineCount: 1, baselineFp: 'fp-dummy', hasCommandId: false, reason: 'TEST_KEY_STILL_PRESENT' });

function cfgJson() {
  return JSON.stringify({ environment: 'verify', allowedLast4: ['37DD'], keypads: [{ deviceId: DEVICE }], ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test'] });
}

function makeWorld(o) {
  o = o || {};
  var w = {
    script: Object.assign({ ACCESS_CONFIG: cfgJson(), ACCESS_ENVIRONMENT: 'verify', ACCESS_ENABLED: 'false',
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }), ACCESS_TEST_KEY_STATE: STOPPED_STATE,
      ACCESS_ID_TYPE_DIAG_APPROVAL: 'ID_TYPE_READ_ONCE' }, o.script || {}),
    user: Object.assign({}, SECRETS), userWrites: 0,
    keys: (o.keys || NUM_KEYS).map(function (k) { return Object.assign({}, k); }),
    calls: [], locks: 0, triggers: o.triggers || 0, email: ADMIN, effective: ADMIN
  };
  w.deps = {
    identity: function () { return { email: w.email, effectiveEmail: w.effective }; },
    adminActors: { 'owner@example.test': 'ADMIN-1' },
    accessFlag: function () { return w.script.ACCESS_ENABLED === undefined ? null : w.script.ACCESS_ENABLED; },
    scriptProps: {
      get: function (k) { if (o.failScriptRead && o.failScriptRead(k)) throw new Error('LEAK-ME ' + SECRETS.SWITCHBOT_TOKEN); return w.script[k] === undefined ? null : w.script[k]; },
      set: function (k, v) { if (o.failStateWrite && k === 'ACCESS_ID_TYPE_DIAG_STATE') throw new Error('write fail'); w.script[k] = v; },
      del: function (k) { if (o.failApprovalDel) throw new Error('del fail'); delete w.script[k]; }
    },
    userProps: {
      get: function (k) { return w.user[k] === undefined ? null : w.user[k]; },
      set: function (k, v) { w.userWrites++; w.user[k] = v; }, del: function (k) { w.userWrites++; delete w.user[k]; }
    },
    lock: { tryLock: function () { w.locks++; return !o.lockBusy; }, releaseLock: function () {} },
    triggerCount: function () { return w.triggers; },
    api: {
      listDevices: function () {
        w.calls.push('list');
        if (o.listThrow) throw new Error('timeout ' + DEVICE);
        if (o.listFail) return { ok: false, error: 'LIST_API_ERROR' };
        var devices = o.devices ? o.devices(w.keys) : [{ deviceId: DEVICE, keyList: w.keys.map(function (k) { return Object.assign({}, k); }) }, { deviceId: OTHER, keyList: [{ id: 111, name: 'other' }] }];
        return { ok: true, devices: devices };
      },
      createKey: function () { w.calls.push('create'); throw new Error('must not be called'); },
      deleteKey: function () { w.calls.push('delete'); throw new Error('must not be called'); }
    },
    sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); }
  };
  return w;
}

function run(w) { return JSON.parse(JSON.stringify(Infra.idTypeDiag(w.deps))); }
function status(w) { return JSON.parse(JSON.stringify(Infra.idTypeDiagStatus(w.deps))); }
function leakCheck(w, r) {
  var all = JSON.stringify(r);
  Object.keys(SECRETS).forEach(function (k) { assert.ok(all.indexOf(SECRETS[k]) === -1); });
  [DEVICE, OTHER, ADMIN, 'ADMIN-1', 'STR-ID', '987654321012', '9876', '1012', 'normal-key', 'LEAK-ME', 'ops@example.test', 'TSTABCDEFGH', 'fp-dummy'].forEach(function (x) { assert.ok(all.indexOf(x) === -1, 'leak ' + x); });
}
function noMutation(w) {
  assert.ok(w.calls.every(function (c) { return c === 'list'; }), '変更系API未呼出');
  assert.strictEqual(w.script.ACCESS_TEST_KEY_STATE, STOPPED_STATE, '既存 STATE は不変（STOPPED・callsUsed=5/5）');
  assert.strictEqual(w.userWrites, 0, 'User Properties 不変');
  assert.strictEqual(w.script.ACCESS_ENABLED, 'false');
  assert.strictEqual(w.script.ACCESS_TEST_KEY_ARMED, undefined);
  assert.strictEqual(w.script.ACCESS_TEST_KEY_APPROVAL, undefined);
  assert.strictEqual(w.triggers, 0);
}
function diagState(w) { return JSON.parse(w.script.ACCESS_ID_TYPE_DIAG_STATE); }

test('型判定: 数値/文字列/混在/不明が固定コードのみで返り、GETは1回・値は出ない', function () {
  [[NUM_KEYS, 'ID_TYPE_NUMBER', true],
   [STR_KEYS, 'ID_TYPE_STRING', true],
   [NUM_KEYS.concat(STR_KEYS), 'ID_TYPE_MIXED', true],
   [[], 'ID_TYPE_UNKNOWN', false],
   [[{ id: null, name: 'x' }], 'ID_TYPE_UNKNOWN', false],
   [[{ id: true, name: 'x' }], 'ID_TYPE_UNKNOWN', false],
   [[{ id: '', name: 'x' }], 'ID_TYPE_UNKNOWN', false],
   [NUM_KEYS.concat([{ id: {}, name: 'x' }]), 'ID_TYPE_UNKNOWN', false]
  ].forEach(function (c) {
    var w = makeWorld({ keys: c[0] });
    var r = run(w);
    assert.strictEqual(r.code, c[1], JSON.stringify(r)); assert.strictEqual(r.idType, c[1]); assert.strictEqual(r.ok, c[2]);
    assert.strictEqual(r.apiCalls, 1); assert.strictEqual(w.calls.length, 1);
    leakCheck(w, r); noMutation(w);
    assert.strictEqual(diagState(w).state, 'DONE'); assert.strictEqual(diagState(w).result, c[1]);
    assert.strictEqual(w.script.ACCESS_ID_TYPE_DIAG_APPROVAL, undefined, '承認は消費済み');
    assert.deepStrictEqual(Object.keys(r).filter(function (k) { return /count|length|digits|last/i.test(k); }), [], '件数・桁数を出さない');
  });
});

test('1回予算: 2回目は通信せず DIAG_ALREADY_USED（承認を再設定しても）', function () {
  var w = makeWorld(); assert.strictEqual(run(w).ok, true);
  w.script.ACCESS_ID_TYPE_DIAG_APPROVAL = 'ID_TYPE_READ_ONCE';
  var r = run(w); assert.strictEqual(r.code, 'DIAG_ALREADY_USED'); assert.strictEqual(w.calls.length, 1); noMutation(w);
});

test('承認: 未設定・不正値・別値では通信しない。フラグ不正でも通信しない', function () {
  [undefined, 'TRUE', 'LIST', '', 'id_type_read_once'].forEach(function (v) {
    var w = makeWorld({ script: { ACCESS_ID_TYPE_DIAG_APPROVAL: v } });
    if (v === undefined) delete w.script.ACCESS_ID_TYPE_DIAG_APPROVAL;
    var r = run(w); assert.strictEqual(r.code, 'DIAG_NOT_APPROVED'); assert.strictEqual(w.calls.length, 0);
    assert.strictEqual(w.script.ACCESS_ID_TYPE_DIAG_STATE, undefined, '状態も作らない');
  });
});

test('必須条件: 1つでも欠けたら通信ゼロ（fail-closed）', function () {
  var cases = [
    ['ACCESS_ENABLED=true', { script: { ACCESS_ENABLED: 'true' } }, 'ACCESS_NOT_OFF'],
    ['ACCESS_ENABLED 未設定', { script: { ACCESS_ENABLED: undefined } }, 'ACCESS_FLAG_NOT_EXPLICIT_OFF'],
    ['ARMED 設定済み', { script: { ACCESS_TEST_KEY_ARMED: 'true' } }, 'TEST_KEY_ARMED_PRESENT'],
    ['試験APPROVAL 設定済み', { script: { ACCESS_TEST_KEY_APPROVAL: 'LIST' } }, 'TEST_KEY_APPROVAL_PRESENT'],
    ['STATE が STOPPED でない(COMPLETE)', { script: { ACCESS_TEST_KEY_STATE: JSON.stringify({ v: 1, state: 'COMPLETE', calls: 5 }) } }, 'TEST_KEY_STATE_NOT_STOPPED'],
    ['STATE が送信中', { script: { ACCESS_TEST_KEY_STATE: JSON.stringify({ v: 1, state: 'DELETE_SENT', calls: 4 }) } }, 'TEST_KEY_STATE_NOT_STOPPED'],
    ['STATE 破損', { script: { ACCESS_TEST_KEY_STATE: '{broken' } }, 'TEST_KEY_STATE_UNREADABLE'],
    ['トリガーあり', { triggers: 1 }, 'TRIGGERS_PRESENT'],
    ['環境がverifyでない', { script: { ACCESS_ENVIRONMENT: 'production' } }, 'ENV_NOT_VERIFY'],
    ['01FD 対象', { script: { ACCESS_CONFIG: JSON.stringify({ environment: 'verify', allowedLast4: ['01FD'], keypads: [{ deviceId: OTHER }], ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test'] }) } }, 'LAST4_FORBIDDEN'],
    ['37DD+01FD 複数', { script: { ACCESS_CONFIG: JSON.stringify({ environment: 'verify', allowedLast4: ['37DD', '01FD'], keypads: [{ deviceId: DEVICE }, { deviceId: OTHER }], ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test'] }) } }, 'LAST4_FORBIDDEN'],
    ['ロック競合', { lockBusy: true }, 'LOCK_UNAVAILABLE']
  ];
  cases.forEach(function (c) {
    var w = makeWorld(c[1]);
    if (c[1].script && 'ACCESS_ENABLED' in c[1].script && c[1].script.ACCESS_ENABLED === undefined) delete w.script.ACCESS_ENABLED;
    var r = run(w);
    assert.strictEqual(r.ok, false, c[0]); assert.strictEqual(r.code, c[2], c[0] + ' ' + JSON.stringify(r));
    assert.strictEqual(w.calls.length, 0, c[0]); assert.strictEqual(w.script.ACCESS_ID_TYPE_DIAG_STATE, undefined, c[0]);
    assert.strictEqual(w.script.ACCESS_ID_TYPE_DIAG_APPROVAL, c[1].script && c[1].script.ACCESS_ID_TYPE_DIAG_APPROVAL || 'ID_TYPE_READ_ONCE', '承認は消費しない: ' + c[0]);
  });
});

test('実行者確認: 非管理者・active/effective 不一致・不明は通信しない', function () {
  var w = makeWorld(); w.email = 'other@example.test'; w.effective = 'other@example.test';
  assert.strictEqual(run(w).ok, false); assert.strictEqual(w.calls.length, 0);
  w = makeWorld(); w.effective = 'someone@example.test';
  assert.strictEqual(run(w).code, 'ACCOUNT_MISMATCH'); assert.strictEqual(w.calls.length, 0);
  w = makeWorld(); w.effective = '';
  assert.strictEqual(run(w).ok, false); assert.strictEqual(w.calls.length, 0);
});

test('資格情報なし・永続失敗・承認消費失敗・状態読取不能では通信しない', function () {
  var w = makeWorld(); delete w.user.SWITCHBOT_TOKEN;
  assert.strictEqual(run(w).code, 'AUTH_CREDENTIALS_MISSING'); assert.strictEqual(w.calls.length, 0);
  w = makeWorld({ failStateWrite: true });
  var r = run(w); assert.strictEqual(r.code, 'STATE_WRITE_FAILED'); assert.strictEqual(w.calls.length, 0); leakCheck(w, r);
  w = makeWorld({ failApprovalDel: true });
  r = run(w); assert.strictEqual(r.code, 'APPROVAL_CONSUME_FAILED'); assert.strictEqual(w.calls.length, 0);
  w = makeWorld({ failScriptRead: function (k) { return k === 'ACCESS_ID_TYPE_DIAG_STATE'; } });
  r = run(w); assert.strictEqual(r.code, 'DIAG_STATE_UNKNOWN'); assert.strictEqual(w.calls.length, 0); leakCheck(w, r);
});

test('GETエラー/例外: 不明停止・再試行なし（1回のみ）・例外本文を出さない・予算は消費済み', function () {
  [{ listThrow: true, code: 'LIST_COMM_ERROR' }, { listFail: true, code: 'LIST_API_ERROR' }].forEach(function (o) {
    var w = makeWorld(o); var r = run(w);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, o.code); assert.strictEqual(r.idType, 'NOT_CHECKED');
    assert.strictEqual(w.calls.length, 1); leakCheck(w, r); noMutation(w);
    assert.strictEqual(diagState(w).state, 'STOPPED');
    w.script.ACCESS_ID_TYPE_DIAG_APPROVAL = 'ID_TYPE_READ_ONCE';
    assert.strictEqual(run(w).code, 'DIAG_ALREADY_USED'); assert.strictEqual(w.calls.length, 1, '自動再試行なし');
  });
});

test('対象特定: 完全一致のみ。0件・重複・keyList欠落/不正は固定コードで停止', function () {
  var near = function () { return [{ deviceId: 'X' + DEVICE, keyList: NUM_KEYS }, { deviceId: DEVICE.toLowerCase(), keyList: NUM_KEYS }]; };
  var dup = function () { return [{ deviceId: DEVICE, keyList: NUM_KEYS }, { deviceId: DEVICE, keyList: STR_KEYS }]; };
  var noList = function () { return [{ deviceId: DEVICE }]; };
  var badEntry = function () { return [{ deviceId: DEVICE, keyList: [null] }]; };
  [[near, 'TARGET_NOT_UNIQUE'], [dup, 'TARGET_NOT_UNIQUE'], [noList, 'KEYLIST_INVALID'], [badEntry, 'KEYLIST_INVALID'], [function () { return 'x'; }, 'KEYLIST_INVALID']].forEach(function (c) {
    var w = makeWorld({ devices: c[0] }); var r = run(w);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, c[1], JSON.stringify(r)); assert.strictEqual(w.calls.length, 1);
    leakCheck(w, r); noMutation(w); assert.strictEqual(diagState(w).state, 'STOPPED');
  });
});

test('状態確認: 通信せず、値・件数なしで前提条件と診断状態のみ返す', function () {
  var w = makeWorld(); var r = status(w);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.gates, 'PASS'); assert.strictEqual(r.prerequisites, 'PASS');
  assert.strictEqual(r.diagState, 'NOT_USED'); assert.strictEqual(r.approved, 'ON'); assert.strictEqual(w.calls.length, 0); leakCheck(w, r);
  run(w); r = status(w);
  assert.strictEqual(r.diagState, 'DONE'); assert.strictEqual(r.lastResult, 'ID_TYPE_NUMBER'); assert.strictEqual(r.approved, 'OFF'); assert.strictEqual(w.calls.length, 1); leakCheck(w, r);
  w = makeWorld({ script: { ACCESS_TEST_KEY_ARMED: 'true' } }); r = status(w);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'TEST_KEY_ARMED_PRESENT'); assert.strictEqual(w.calls.length, 0);
});

test('静的確認: 診断本体は変更系API・User Properties書込・トリガー・メール・台帳を参照しない', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', 'SwitchBotAccessInfra.gs'), 'utf8');
  var seg = src.slice(src.indexOf('// ---------- 37DD keyList.id 型のみ'), src.indexOf('// ---------- 本番初期設定の読取専用診断（Issue #774）')).replace(/\/\/.*$/gm, '');
  assert.ok(seg.length > 500);
  assert.ok(!/createKey|deleteKey|userProps\.(set|del)|ACCESS_TEST_KEY_STATE|TKS_PROP\.STATE|tksWrite|newTrigger|MailApp|SpreadsheetApp|String\(.*\.id\)/.test(seg), seg.match(/createKey|deleteKey|userProps\.(set|del)|tksWrite|String\(.*\.id\)/));
  var app = fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', 'SwitchBotAccessApp.gs'), 'utf8');
  var a = app.slice(app.indexOf('function sba_idTypeDiagDeps_'), app.indexOf('// ── 本番初期設定の読取専用診断（Issue #774）')).replace(/\/\/.*$/gm, '');
  assert.ok(!/createKey|deleteKey|sba_runtime_|accessSyncJob|newTrigger|MailApp|SpreadsheetApp|sba_ledger|doPost/.test(a));
});

// ── GAS シェル経由 ──
function loadShell(o) {
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba795-'));
  prepare.prepareProject(out);
  var w = makeWorld(o); var env = { w: w, fetches: [], logs: [], mails: 0, triggerWrites: 0 };
  function props(m) {
    return { getProperty: function (k) { return m[k] === undefined ? null : m[k]; }, setProperty: function (k, v) { m[k] = v; if (m === w.user) w.userWrites++; }, deleteProperty: function (k) { delete m[k]; if (m === w.user) w.userWrites++; }, getKeys: function () { return Object.keys(m); } };
  }
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
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
        env.fetches.push({ method: options.method, path: u.slice('https://api.switch-bot.com'.length), body: options.payload || null });
        // 数値IDをそのまま JSON 文字列で返し、パース後に型が保たれることを確認する
        var text = '{"statusCode":100,"body":{"deviceList":[{"deviceId":"' + DEVICE + '","keyList":[{"id":987654321012,"name":"normal-key-1","type":"permanent"}]}]}}';
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
function plain(x) { return JSON.parse(JSON.stringify(x)); }

test('シェル: 状態確認は通信ゼロ。承認なしの診断実行も通信ゼロ', function () {
  var env = loadShell(); var w = env.w;
  assert.strictEqual(typeof env.ctx.accessIdTypeDiagStatus, 'function'); assert.strictEqual(typeof env.ctx.accessIdTypeDiagRun, 'function');
  var st = plain(env.ctx.accessIdTypeDiagStatus()); assert.strictEqual(st.ok, true);
  delete w.script.ACCESS_ID_TYPE_DIAG_APPROVAL;
  var r = plain(env.ctx.accessIdTypeDiagRun()); assert.strictEqual(r.code, 'DIAG_NOT_APPROVED');
  assert.strictEqual(env.fetches.length, 0); assert.strictEqual(w.script.ACCESS_ID_TYPE_DIAG_STATE, undefined);
});

test('シェル: 承認後の実行は GET /v1.1/devices 1回のみ。数値IDを ID_TYPE_NUMBER と判定し、変更・秘密出力なし', function () {
  var env = loadShell(); var w = env.w;
  var r = plain(env.ctx.accessIdTypeDiagRun());
  assert.strictEqual(r.code, 'ID_TYPE_NUMBER', JSON.stringify(r)); assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(env.fetches.map(function (f) { return f.method + ' ' + f.path; }), ['get /v1.1/devices']);
  assert.strictEqual(env.fetches[0].body, null);
  assert.deepStrictEqual(JSON.parse(env.logs[env.logs.length - 1]), r, 'ログ=戻り値（固定JSON）');
  assert.strictEqual(w.script.ACCESS_TEST_KEY_STATE, STOPPED_STATE);
  assert.strictEqual(w.userWrites, 0); assert.strictEqual(env.mails + env.triggerWrites, 0);
  var all = env.logs.join('\n') + w.script.ACCESS_ID_TYPE_DIAG_STATE; // 診断が出力・永続した内容のみ（ACCESS_CONFIG の設定値は対象外）
  Object.keys(SECRETS).forEach(function (k) { assert.ok(all.indexOf(SECRETS[k]) === -1); });
  ['987654321012', DEVICE, 'normal-key'].forEach(function (x) { assert.ok(all.indexOf(x) === -1, x); });
  var again = plain(env.ctx.accessIdTypeDiagRun()); assert.strictEqual(again.ok, false); assert.strictEqual(env.fetches.length, 1, '二重実行でもGETは1回');
});

test('回帰: 既存の #791 入口と本番ジョブは不変、スコープも不変', function () {
  var root = path.join(__dirname, '..', 'gas', 'switchbot-access');
  var m = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets') === -1);
  var app = fs.readFileSync(path.join(root, 'SwitchBotAccessApp.gs'), 'utf8');
  assert.ok(/function accessSyncJob\(\) \{ return sba_runtime_\(\)\.syncCycle\(\); \}/.test(app));
  assert.strictEqual(typeof Infra.testKeyStage, 'function');
});

test('再実行防止: DONE/STOPPED/SENT(中断)/ID_TYPE_UNKNOWN の各状態で承認を再設定してもGETは増えない。既存STATEは不変', function () {
  [{ keys: [], first: 'ID_TYPE_UNKNOWN', ok: false }, { keys: NUM_KEYS, first: 'ID_TYPE_NUMBER', ok: true }].forEach(function (c) {
    var w = makeWorld({ keys: c.keys }); var r = run(w);
    assert.strictEqual(r.code, c.first); assert.strictEqual(r.ok, c.ok); assert.strictEqual(r.apiCalls, 1);
    for (var i = 0; i < 3; i++) {
      w.script.ACCESS_ID_TYPE_DIAG_APPROVAL = 'ID_TYPE_READ_ONCE';
      var again = run(w); assert.strictEqual(again.code, 'DIAG_ALREADY_USED'); assert.strictEqual(again.apiCalls, 0);
    }
    assert.strictEqual(w.calls.length, 1); noMutation(w);
  });
  // 送信済みマーカーのみ残った中断状態（結果未記録）でも再実行しない
  var w2 = makeWorld({ script: { ACCESS_ID_TYPE_DIAG_STATE: JSON.stringify({ v: 1, state: 'SENT', calls: 1 }) } });
  assert.strictEqual(run(w2).code, 'DIAG_ALREADY_USED'); assert.strictEqual(w2.calls.length, 0);
  // 壊れた状態値も「使用済み」として扱い、通信しない
  var w3 = makeWorld({ script: { ACCESS_ID_TYPE_DIAG_STATE: '{broken' } });
  assert.strictEqual(run(w3).code, 'DIAG_ALREADY_USED'); assert.strictEqual(w3.calls.length, 0);
});

test('状態確認: ok=true はGO/実行可能の意味ではない旨を明示し、SENT/DONE・承認OFFでもokになりうる（実行可否と混同しない）', function () {
  var w = makeWorld(); var r = status(w);
  assert.ok(r.notes.indexOf('STATUS_OK_IS_NOT_GO_NOR_EXECUTABLE') !== -1);
  run(w); r = status(w);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.diagState, 'DONE'); assert.strictEqual(r.approved, 'OFF');
  assert.ok(r.notes.indexOf('STATUS_OK_IS_NOT_GO_NOR_EXECUTABLE') !== -1);
  var w2 = makeWorld({ script: { ACCESS_ID_TYPE_DIAG_STATE: JSON.stringify({ v: 1, state: 'SENT', calls: 1 }) } });
  r = status(w2); assert.strictEqual(r.ok, true); assert.strictEqual(r.diagState, 'SENT'); assert.strictEqual(w2.calls.length, 0);
});

test('手順書: 状態プロパティ削除による予算リセットを通常手順として案内せず、追加診断は新たな個別GO+安全レビューを前提とする', function () {
  var d = fs.readFileSync(path.join(__dirname, '..', 'docs', 'switchbot-access-id-type-diag-795.md'), 'utf8');
  assert.ok(!/プロパティを削除してから|削除してから/.test(d));
  assert.ok(/運用上禁止|運用で禁止/.test(d)); assert.ok(/新たな個別GO/.test(d)); assert.ok(/別途の安全レビュー/.test(d));
  assert.ok(/ok=true.*GOでも実行可能の判定でもない/.test(d));
});
