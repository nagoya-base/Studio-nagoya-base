/*
 * Issue #772: 一時 Script Properties → User Properties ワンショット移行のテスト（GAS側ロジック＋エントリ）。
 * 実GAS・実API・実秘密には接続しない。値はすべてテスト内のダミー。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var Infra = require('../gas/switchbot-access/SwitchBotAccessInfra.gs');
var prepare = require('../scripts/prepare-switchbot-access-gas-project');

var ADMIN = 'owner@example.test';
var NAMES = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'WEBHOOK_SHARED_TOKEN'];
var TEMP = ['BOOTSTRAP_SWITCHBOT_TOKEN', 'BOOTSTRAP_SWITCHBOT_SECRET', 'BOOTSTRAP_WEBHOOK_SHARED_TOKEN'];
var D = {
  SWITCHBOT_TOKEN: 'dummy-token-' + 'a1b2c3d4'.repeat(4),
  SWITCHBOT_SECRET: 'dummy-secret-' + 'e5f6a7b8'.repeat(3),
  WEBHOOK_SHARED_TOKEN: 'Zx9_Qw-' + 'LmNpRtUv'.repeat(3)
};
function temp(m) { var o = {}; TEMP.forEach(function (t, i) { o[t] = m[NAMES[i]]; }); return o; }
function noSecret(x) {
  var t = typeof x === 'string' ? x : JSON.stringify(x);
  NAMES.forEach(function (n) { assert.ok(t.indexOf(D[n]) === -1, 'leak ' + n); });
}

function store(data, log, hooks) {
  hooks = hooks || {};
  return {
    get: function (k) { log.push(['get', k]); if (hooks.failGet === k) throw new Error('x ' + data[k]); return data[k] === undefined ? null : data[k]; },
    set: function (k, v) { log.push(['set', k]); if (hooks.failSet === k) throw new Error('boom ' + v); data[k] = hooks.corrupt === k ? 'corrupted' : String(v); },
    del: function (k) { log.push(['del', k]); if (hooks.failDel === k) throw new Error('nodel'); delete data[k]; },
    keys: function () { return Object.keys(data); }
  };
}
function world(o) {
  o = o || {};
  var w = { sp: Object.assign({ ACCESS_CONFIG: '{}', ACCESS_ENABLED: 'false', ACCESS_ENVIRONMENT: 'production' }, 'script' in o ? o.script : temp(D)),
    up: Object.assign({}, o.user || {}), spLog: [], upLog: [], locks: 0, releases: 0 };
  w.deps = {
    scriptProps: store(w.sp, w.spLog, o.spHooks), userProps: store(w.up, w.upLog, o.upHooks),
    adminActors: { 'Owner@Example.test': 'ADMIN-1' },
    identity: o.identity || function () { return { email: ADMIN, effectiveEmail: ADMIN }; },
    lock: o.noLock ? undefined : { tryLock: function () { w.locks++; return !o.busy; }, releaseLock: function () { w.releases++; } }
  };
  return w;
}
function tempLeft(w) { return TEMP.filter(function (t) { return w.sp[t] !== undefined; }); }
function otherScriptKeys(w) { return JSON.stringify(Object.keys(w.sp).filter(function (k) { return TEMP.indexOf(k) === -1; }).sort().map(function (k) { return [k, w.sp[k]]; })); }

test('正常: 3件がUser Propertiesへ移り、一時キー3件は削除、他のScript Propertiesは不変、結果に値なし', function () {
  var w = world(), before = otherScriptKeys(w);
  var r = Infra.migrateBootstrapCredentials(w.deps);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.code, 'OK');
  NAMES.forEach(function (n) { assert.strictEqual(w.up[n], D[n]); });
  assert.deepStrictEqual(Object.keys(w.up).sort(), NAMES.slice().sort());
  assert.deepStrictEqual(tempLeft(w), []);
  assert.strictEqual(otherScriptKeys(w), before);
  assert.deepStrictEqual(r.status, { SWITCHBOT_TOKEN: 'SET', SWITCHBOT_SECRET: 'SET', WEBHOOK_SHARED_TOKEN: 'SET' });
  TEMP.forEach(function (t) { assert.strictEqual(r.bootstrap[t], 'ABSENT'); });
  noSecret(r);
  // Script Propertiesへ触れたのは一時キーだけ（読み・消去のみ。書込みなし）
  w.spLog.forEach(function (op) { assert.ok(TEMP.indexOf(op[1]) !== -1 && op[0] !== 'set', 'unexpected ' + op.join(':')); });
  assert.strictEqual(w.locks, 1); assert.strictEqual(w.releases, 1);
});

test('既存User Propertiesが1件でもSETなら上書き拒否・何も書かず、一時キーは削除', function () {
  var w = world({ user: { SWITCHBOT_SECRET: 'existing-secret-value-123' } });
  var r = Infra.migrateBootstrapCredentials(w.deps);
  assert.strictEqual(r.code, 'USER_PROPS_NOT_EMPTY'); assert.strictEqual(r.ok, false);
  assert.strictEqual(w.up.SWITCHBOT_SECRET, 'existing-secret-value-123');
  assert.deepStrictEqual(Object.keys(w.up), ['SWITCHBOT_SECRET']);
  assert.deepStrictEqual(tempLeft(w), []);
  assert.ok(!w.upLog.some(function (o) { return o[0] === 'set' || o[0] === 'del'; }));
  noSecret(r);
});

test('入力不備（欠落/形式/重複）は未登録で、一時キーは削除される', function () {
  var cases = [
    ['BOOTSTRAP_INCOMPLETE', function (s) { delete s.BOOTSTRAP_SWITCHBOT_SECRET; }],
    ['INPUT_INVALID', function (s) { s.BOOTSTRAP_WEBHOOK_SHARED_TOKEN = 'short'; }],
    ['INPUT_INVALID', function (s) { s.BOOTSTRAP_WEBHOOK_SHARED_TOKEN = 'has space ' + 'x'.repeat(30); }],
    ['INPUT_DUPLICATE', function (s) { s.BOOTSTRAP_SWITCHBOT_SECRET = s.BOOTSTRAP_SWITCHBOT_TOKEN; }]
  ];
  cases.forEach(function (c) {
    var s = temp(D); c[1](s);
    var w = world({ script: s });
    var r = Infra.migrateBootstrapCredentials(w.deps);
    assert.strictEqual(r.code, c[0]); assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(Object.keys(w.up), []);
    assert.deepStrictEqual(tempLeft(w), []);
    noSecret(r);
  });
});

test('一時キーが無ければ BOOTSTRAP_MISSING（何も書かない・何も消さない）', function () {
  var w = world({ script: {} });
  var r = Infra.migrateBootstrapCredentials(w.deps);
  assert.strictEqual(r.code, 'BOOTSTRAP_MISSING');
  assert.deepStrictEqual(Object.keys(w.up), []);
  assert.ok(!w.spLog.some(function (o) { return o[0] === 'del'; }));
});

test('書込み失敗: 書いた分を戻し、一時キーを削除。戻せないときは ROLLBACK_FAILED', function () {
  var w = world({ upHooks: { failSet: 'SWITCHBOT_SECRET' } });
  var r = Infra.migrateBootstrapCredentials(w.deps);
  assert.strictEqual(r.code, 'WRITE_FAILED');
  assert.deepStrictEqual(Object.keys(w.up), []); assert.deepStrictEqual(tempLeft(w), []);
  noSecret(r);
  var w2 = world({ upHooks: { failSet: 'SWITCHBOT_SECRET', failDel: 'SWITCHBOT_TOKEN' } });
  var r2 = Infra.migrateBootstrapCredentials(w2.deps);
  assert.strictEqual(r2.code, 'ROLLBACK_FAILED'); assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.status.SWITCHBOT_TOKEN, 'SET'); // 部分書込みが残ったことを状態で示す
  assert.deepStrictEqual(tempLeft(w2), []);
  noSecret(r2);
});

test('照合不一致: VERIFY_FAILED で戻し、一時キー削除', function () {
  var w = world({ upHooks: { corrupt: 'SWITCHBOT_TOKEN' } });
  var r = Infra.migrateBootstrapCredentials(w.deps);
  assert.strictEqual(r.code, 'VERIFY_FAILED');
  assert.deepStrictEqual(Object.keys(w.up), []); assert.deepStrictEqual(tempLeft(w), []);
});

test('一時キー削除に失敗: 移行済みでも ok=false の MIGRATED_CLEANUP_FAILED で手動削除を促す', function () {
  var w = world({ spHooks: { failDel: 'BOOTSTRAP_SWITCHBOT_TOKEN' } });
  var r = Infra.migrateBootstrapCredentials(w.deps);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'MIGRATED_CLEANUP_FAILED');
  assert.strictEqual(r.bootstrap.BOOTSTRAP_SWITCHBOT_TOKEN, 'SET');
  NAMES.forEach(function (n) { assert.strictEqual(w.up[n], D[n]); });
  noSecret(r);
});

test('読取失敗はMISSING/ABSENT扱いにしない（fail closed）。例外メッセージの値も出ない', function () {
  var w = world({ upHooks: { failGet: 'SWITCHBOT_TOKEN' } });
  var r = Infra.migrateBootstrapCredentials(w.deps);
  assert.strictEqual(r.code, 'READ_FAILED'); assert.deepStrictEqual(Object.keys(w.up), []);
  var w2 = world({ spHooks: { failGet: 'BOOTSTRAP_SWITCHBOT_SECRET' } });
  assert.strictEqual(Infra.migrateBootstrapCredentials(w2.deps).code, 'READ_FAILED');
  assert.deepStrictEqual(Object.keys(w2.up), []);
});

test('認可: 許可外・実行者不明・実効ユーザー不一致は何も読まず・消さず・書かない', function () {
  [function () { return { email: 'other@example.test', effectiveEmail: ADMIN }; },
    function () { return { email: '', effectiveEmail: ADMIN }; },
    function () { return { email: ADMIN, effectiveEmail: '' }; },
    function () { return { email: ADMIN, effectiveEmail: 'dep@example.test' }; },
    function () { throw new Error('x'); }].forEach(function (id) {
    var w = world({ identity: id });
    var r = Infra.migrateBootstrapCredentials(w.deps);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(w.spLog.length, 0); assert.strictEqual(w.upLog.length, 0); assert.strictEqual(tempLeft(w).length, 3);
    TEMP.forEach(function (t) { assert.strictEqual(r.bootstrap[t], 'ABSENT'); });
  });
});

test('ロック: 無い→LOCK_UNAVAILABLE（書かず削除）／使用中→LOCK_BUSY（書かず・消さない）', function () {
  var a = world({ noLock: true });
  assert.strictEqual(Infra.migrateBootstrapCredentials(a.deps).code, 'LOCK_UNAVAILABLE');
  assert.deepStrictEqual(Object.keys(a.up), []); assert.deepStrictEqual(tempLeft(a), []);
  var b = world({ busy: true });
  assert.strictEqual(Infra.migrateBootstrapCredentials(b.deps).code, 'LOCK_BUSY');
  assert.deepStrictEqual(Object.keys(b.up), []); assert.strictEqual(tempLeft(b).length, 3);
});

test('復旧と再実行: 失敗→一時キー再登録→再実行で成功。消去関数は一時キーだけを消す', function () {
  var w = world({ upHooks: { failSet: 'WEBHOOK_SHARED_TOKEN' } });
  assert.strictEqual(Infra.migrateBootstrapCredentials(w.deps).code, 'WRITE_FAILED');
  w.deps.userProps = store(w.up, w.upLog); // 障害解消
  Object.assign(w.sp, temp(D));
  assert.strictEqual(Infra.migrateBootstrapCredentials(w.deps).code, 'OK');
  // scrub: 他のキーは無傷
  var w2 = world(), before = otherScriptKeys(w2);
  var s = Infra.scrubBootstrapCredentials(w2.deps);
  assert.strictEqual(s.code, 'SCRUBBED'); assert.deepStrictEqual(tempLeft(w2), []);
  assert.strictEqual(otherScriptKeys(w2), before); assert.deepStrictEqual(Object.keys(w2.up), []);
});

test('診断bootstrapStatus: 読取専用で残存を検出し、値は返さない', function () {
  var w = world();
  var r = Infra.bootstrapStatus(w.deps);
  assert.strictEqual(r.code, 'BOOTSTRAP_KEYS_REMAIN');
  assert.ok(!w.spLog.concat(w.upLog).some(function (o) { return o[0] === 'set' || o[0] === 'del'; }));
  noSecret(r);
  assert.strictEqual(Infra.bootstrapStatus(world({ script: {} }).deps).code, 'STATUS_OK');
});

// ---------- GASエントリ（実シェルをvmで読み込み）----------
function loadShell(over) {
  over = over || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba772-'));
  prepare.prepareProject(out);
  var env = { script: Object.assign({ ACCESS_CONFIG: '{"x":1}', ACCESS_ENVIRONMENT: 'production', LEDGER_SPREADSHEET_ID: 'ledger', ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }) }, temp(D), over.script || {}),
    user: Object.assign({}, over.user || {}), logs: [], fetches: 0, mails: 0, triggers: 0, scriptSets: 0 };
  function props(m, isScript) {
    return { getProperty: function (k) { return m[k] === undefined ? null : m[k]; },
      setProperty: function (k, v) { if (isScript) env.scriptSets++; m[k] = String(v); },
      deleteProperty: function (k) { delete m[k]; }, getKeys: function () { return Object.keys(m); } };
  }
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(env.script, true); }, getUserProperties: function () { return props(env.user, false); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return ADMIN; } }; }, getEffectiveUser: function () { return { getEmail: function () { return ADMIN; } }; } },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    UrlFetchApp: { fetch: function () { env.fetches++; throw new Error('no fetch'); } },
    MailApp: { sendEmail: function () { env.mails++; } },
    ScriptApp: { newTrigger: function () { env.triggers++; throw new Error('no'); }, getProjectTriggers: function () { env.triggers++; return []; }, deleteTrigger: function () { env.triggers++; } },
    LockService: { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } },
    Utilities: {}, ContentService: {}, SpreadsheetApp: {}
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) { vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n }); });
  env.ctx = ctx;
  return env;
}
function plain(x) { return JSON.parse(JSON.stringify(x)); }

test('GASエントリ: 移行→accessCheckSetupで3件SET、ACCESS_ENABLEDはOFFのまま、他設定・外部通信・トリガー不変、ログに秘密なし', function () {
  var env = loadShell();
  var keep = JSON.stringify(['ACCESS_CONFIG', 'ACCESS_ENVIRONMENT', 'LEDGER_SPREADSHEET_ID', 'ACCESS_ADMIN_ACTORS'].map(function (k) { return env.script[k]; }));
  var r = plain(env.ctx.accessMigrateCredentialsOnce());
  assert.strictEqual(r.ok, true); assert.strictEqual(r.code, 'OK'); assert.strictEqual(r.accessEnabled, 'OFF');
  assert.strictEqual(env.scriptSets, 0);
  assert.deepStrictEqual(Object.keys(env.script).sort(), ['ACCESS_ADMIN_ACTORS', 'ACCESS_CONFIG', 'ACCESS_ENVIRONMENT', 'LEDGER_SPREADSHEET_ID']);
  assert.strictEqual(JSON.stringify(['ACCESS_CONFIG', 'ACCESS_ENVIRONMENT', 'LEDGER_SPREADSHEET_ID', 'ACCESS_ADMIN_ACTORS'].map(function (k) { return env.script[k]; })), keep);
  assert.deepStrictEqual(Object.keys(env.user).sort(), NAMES.slice().sort());
  var st = plain(env.ctx.accessCheckSetup());
  NAMES.forEach(function (n) { assert.strictEqual(st[n], 'SET'); });
  assert.strictEqual(st.ACCESS_ENABLED, 'OFF');
  assert.strictEqual(env.fetches + env.mails + env.triggers, 0);
  noSecret(env.logs.join('\n')); noSecret(r);
  // 2回目: 移行先がSETなので上書きしない
  assert.strictEqual(plain(env.ctx.accessMigrateCredentialsOnce()).code, 'USER_PROPS_NOT_EMPTY');
});

test('GASエントリ: 状態管理ストアは BOOTSTRAP_ を状態として扱わない（GC対象外）／未知例外は固定コード', function () {
  var src = fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  assert.ok(/reserved = \/\^\(ACCESS_\|LEDGER_\|BOOTSTRAP_\)\//.test(src));
  var env = loadShell({ user: { SWITCHBOT_TOKEN: 'already-set-value-12345' } });
  var r = plain(env.ctx.accessMigrateCredentialsOnce());
  assert.strictEqual(r.code, 'USER_PROPS_NOT_EMPTY');
  assert.strictEqual(env.user.SWITCHBOT_TOKEN, 'already-set-value-12345');
  assert.strictEqual(TEMP.filter(function (t) { return env.script[t] !== undefined; }).length, 0);
});

test('GASエントリ: 一時キー名はソース/ドキュメントに値を含まず、Web入口(doPost/doGet)から移行関数に到達しない', function () {
  var src = fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  var web = src.slice(src.indexOf('function doPost'), src.indexOf('var SBA_JOBS_'));
  assert.ok(web.indexOf('Migrate') === -1 && web.indexOf('Bootstrap') === -1);
  var doc = fs.readFileSync(path.join(__dirname, '../docs/switchbot-access-bootstrap-772.md'), 'utf8');
  NAMES.forEach(function (n) { assert.ok(doc.indexOf(D[n]) === -1); });
  TEMP.forEach(function (t) { assert.ok(doc.indexOf(t) !== -1, t); });
});
