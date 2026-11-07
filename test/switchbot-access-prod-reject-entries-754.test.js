/*
 * Issue #754 / #756 参照: 本番配布物に含まれる「検証用（37DD）入口」が、本番設定では通信前に必ず拒否されることの固定。
 * テスト専用。実GAS・実API・実Spreadsheet・実メールには接続しない（GASサービスはフェイクをvmへ注入）。
 *
 * 対象: SwitchBotAccessApp.gs の accessTest* / accessNumId* / accessIdTypeDiag* の全入口（段階入口を含む）。
 * 保証: ACCESS_ENVIRONMENT=production（および環境不明・読取失敗）では、
 *   - UrlFetch（SwitchBot・Sheets 含む全通信）／MailApp／SpreadsheetApp が 0 回
 *   - Script/User Properties の書込み・削除が 0 回
 *   - トリガーの作成・削除が 0 回、ロック取得が 0 回
 *   - 戻り値・ログは ok:false の固定コードのみ（秘密・完全deviceId・メールを含まない）
 * 位置づけ: モックによる保証であり、本番GASへの反映・実機確認の証跡ではない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var prepare = require('../scripts/prepare-switchbot-access-gas-project');

var ROOT = path.resolve(__dirname, '..');
var ADMIN = 'owner@example.test';
var DEVICE_37DD = 'DEVICE000000037DD';
var SECRETS = { SWITCHBOT_TOKEN: 'dummy-token-' + 'a1b2c3d4'.repeat(4), SWITCHBOT_SECRET: 'dummy-secret-' + 'e5f6a7b8'.repeat(3), WEBHOOK_SHARED_TOKEN: 'W'.repeat(32) };

/** 本番バンドルに載る検証用入口の全一覧。App.gs に入口が増えたら、このテストが落ちて追加を強制する。 */
var ENTRIES = [
  'accessTestKeyStatus', 'accessTestKeyStep1List', 'accessTestKeyStep2Issue', 'accessTestKeyStep3VerifyIssued',
  'accessTestKeyStep4Delete', 'accessTestKeyStep5VerifyDeleted',
  'accessIdTypeDiagStatus', 'accessIdTypeDiagRun',
  'accessNumIdStatus', 'accessNumIdStep1List', 'accessNumIdStep2Issue', 'accessNumIdStep3VerifyIssued',
  'accessNumIdStep4PreDeleteList', 'accessNumIdStep5Delete', 'accessNumIdStep6VerifyDeleted', 'accessNumIdAppCheck',
  'accessBndStatus', 'accessBndStep1List', 'accessBndStep2Issue', 'accessBndStep3VerifyIssued', 'accessBndObserve',
  'accessBndStep4FinalList', 'accessBndAppCheck',
  'accessTestReadOnlyDiagnostics'
];

function productionConfig(extra) {
  return JSON.stringify(Object.assign({
    environment: 'production', allowedLast4: ['01FD'], keypads: [{ deviceId: 'DEVICE00000001FD' }],
    ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test']
  }, extra || {}));
}

/** バンドル配布物をそのまま vm へ読み込み、副作用を全部数えるフェイクを注入する。 */
function loadShell(opts) {
  opts = opts || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-prod-reject-'));
  prepare.prepareProject(out);
  var env = {
    script: Object.assign({}, opts.script), user: Object.assign({}, SECRETS),
    fetches: 0, mails: 0, sheetsApp: 0, propWrites: 0, propDeletes: 0, triggerOps: 0, locks: 0, logs: [],
    throwOnRead: opts.throwOnRead || null
  };
  function props(m, isScript) {
    return {
      getProperty: function (k) {
        if (isScript && env.throwOnRead && env.throwOnRead(k)) throw new Error('LEAK-ME ' + SECRETS.SWITCHBOT_TOKEN);
        return m[k] === undefined ? null : m[k];
      },
      setProperty: function (k, v) { env.propWrites++; m[k] = String(v); },
      setProperties: function () { env.propWrites++; },
      deleteProperty: function (k) { env.propDeletes++; delete m[k]; },
      deleteAllProperties: function () { env.propDeletes++; },
      getKeys: function () { return Object.keys(m); },
      getProperties: function () { return Object.assign({}, m); }
    };
  }
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(env.script, true); }, getUserProperties: function () { return props(env.user, false); } },
    LockService: { getScriptLock: function () { return { tryLock: function () { env.locks++; return true; }, releaseLock: function () {}, waitLock: function () { env.locks++; } }; } },
    Utilities: {
      base64Encode: function (b) { return Buffer.from(b).toString('base64'); },
      computeHmacSha256Signature: function () { return [1, 2, 3]; },
      getUuid: function () { return 'uuid-test'; },
      computeDigest: function () { return [1, 2, 3]; },
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      formatDate: function () { return '2030-01-01'; }
    },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: function (t) { return { text: t, setMimeType: function () { return this; } }; } },
    MailApp: { sendEmail: function () { env.mails++; }, getRemainingDailyQuota: function () { return 100; } },
    SpreadsheetApp: { openById: function () { env.sheetsApp++; throw new Error('SpreadsheetApp must not be used'); } },
    Session: {
      getActiveUser: function () { return { getEmail: function () { return ADMIN; } }; },
      getEffectiveUser: function () { return { getEmail: function () { return ADMIN; } }; }
    },
    ScriptApp: {
      getOAuthToken: function () { return 'dummy-oauth-token'; },
      getProjectTriggers: function () { return []; },
      deleteTrigger: function () { env.triggerOps++; },
      newTrigger: function () { env.triggerOps++; throw new Error('trigger must not be created'); }
    },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    UrlFetchApp: { fetch: function () { env.fetches++; throw new Error('network must not be used'); } }
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) {
    vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n });
  });
  env.ctx = ctx;
  return env;
}

function baseScript(over) {
  return Object.assign({
    ACCESS_CONFIG: productionConfig(), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'false',
    LEDGER_SPREADSHEET_ID: 'ss-test', ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' })
  }, over || {});
}

/** 試験の武装・承認が揃っていても本番では動かないこと（ゲートが武装確認より前にある）を見るための設定。 */
function armedScript() {
  return {
    ACCESS_TEST_KEY_ARMED: 'true', ACCESS_TEST_KEY_APPROVAL: 'LIST',
    ACCESS_ID_TYPE_DIAG_APPROVAL: 'ID_TYPE_READ_ONCE',
    ACCESS_NUMID_TEST_ARMED: 'NUMID_6_CALL_PLAN', ACCESS_NUMID_TEST_APPROVAL: 'LIST',
    ACCESS_BND_TEST_ARMED: 'BND_PLAN_V1_4CALLS', ACCESS_BND_TEST_APPROVAL: 'LIST', ACCESS_BND_TEST_PASSCODE: '13572468', ACCESS_BND_PASSCODE_ATTEST: 'NOT_IN_USE_CONFIRMED'
  };
}

function runEntry(env, name) {
  var r;
  assert.strictEqual(typeof env.ctx[name], 'function', name + ' が本番バンドルに存在する');
  r = vm.runInContext(name + '()', env.ctx);
  return JSON.parse(JSON.stringify(r));
}

function assertNoSideEffects(env, label) {
  assert.strictEqual(env.fetches, 0, label + ': UrlFetch（SwitchBot/Sheets）0回');
  assert.strictEqual(env.mails, 0, label + ': MailApp 0回');
  assert.strictEqual(env.sheetsApp, 0, label + ': SpreadsheetApp 0回');
  assert.strictEqual(env.propWrites, 0, label + ': Properties書込み0回');
  assert.strictEqual(env.propDeletes, 0, label + ': Properties削除0回');
  assert.strictEqual(env.triggerOps, 0, label + ': トリガー操作0回');
  assert.strictEqual(env.locks, 0, label + ': ロック取得0回（状態更新へ進まない）');
}

function assertNoLeak(env, result, label) {
  var all = JSON.stringify(result) + '\n' + env.logs.join('\n');
  Object.keys(SECRETS).forEach(function (k) { assert.ok(all.indexOf(SECRETS[k]) === -1, label + ': ' + k + ' を出さない'); });
  [DEVICE_37DD, 'DEVICE00000001FD', ADMIN, 'ops@example.test', 'LEAK-ME', 'ss-test'].forEach(function (x) {
    assert.ok(all.indexOf(x) === -1, label + ': ' + x + ' を出さない');
  });
}

// ================================================================ 入口の網羅

test('入口の網羅: App.gs の検証用入口（accessTest*/accessNumId*/accessIdTypeDiag*）は、このテストの一覧と過不足なく一致する', function () {
  var src = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  var found = [];
  var re = /^function (access(?:Test|NumId|IdTypeDiag|Bnd)[A-Za-z0-9_]*)\s*\(/gm, m;
  while ((m = re.exec(src))) found.push(m[1]);
  assert.deepStrictEqual(found.slice().sort(), ENTRIES.slice().sort(),
    '検証用入口を増減したら、本番拒否テストの ENTRIES も更新する（未テストの入口を本番バンドルに載せない）');
  // 配布物（prepare の出力）にも同じ入口がそのまま載る＝本番に載る前提のテストであること
  var env = loadShell({ script: baseScript() });
  ENTRIES.forEach(function (n) { assert.strictEqual(typeof env.ctx[n], 'function', n); });
});

// ================================================================ 本番設定での拒否

test('本番設定（ACCESS_ENVIRONMENT=production・ACCESS_ENABLED=false）: 全入口が ENV_NOT_VERIFY で通信・書込み・トリガー・ロックなしに拒否される', function () {
  ENTRIES.forEach(function (name) {
    var env = loadShell({ script: baseScript() });
    var r = runEntry(env, name);
    assert.strictEqual(r.ok, false, name + ': ok:false');
    assert.strictEqual(r.code, 'ENV_NOT_VERIFY', name + ': 拒否コード');
    assertNoSideEffects(env, name);
    assertNoLeak(env, r, name);
    assert.ok(env.logs.length >= 1 && env.logs.every(function (l) { return JSON.parse(l).ok === false; }), name + ': ログは固定JSONの失敗のみ');
  });
});

test('本番設定で武装・承認プロパティが揃っていても、全入口が武装確認より前に拒否される（予算・状態も作らない）', function () {
  ENTRIES.forEach(function (name) {
    var env = loadShell({ script: baseScript(armedScript()) });
    var before = JSON.stringify(env.script);
    var r = runEntry(env, name);
    assert.strictEqual(r.ok, false, name);
    assert.strictEqual(r.code, 'ENV_NOT_VERIFY', name);
    assertNoSideEffects(env, name);
    assert.strictEqual(JSON.stringify(env.script), before, name + ': Script Properties 不変（承認の消費・状態作成なし）');
    assertNoLeak(env, r, name);
  });
});

test('本番設定で config.environment だけ verify・末尾4桁が37DD でも（設定の取り違え）、ACCESS_ENVIRONMENT=production なら全入口が拒否される', function () {
  var cfg = productionConfig({ environment: 'verify', allowedLast4: ['37DD'], keypads: [{ deviceId: DEVICE_37DD }] });
  ENTRIES.forEach(function (name) {
    var env = loadShell({ script: baseScript(Object.assign({ ACCESS_CONFIG: cfg }, armedScript())) });
    var r = runEntry(env, name);
    assert.strictEqual(r.ok, false, name);
    assert.strictEqual(r.code, 'ENV_NOT_VERIFY', name);
    assertNoSideEffects(env, name);
    assertNoLeak(env, r, name);
  });
});

// ================================================================ ゲート順序・fail-closed

test('ACCESS_ENABLED が ON／未設定／想定外値の本番設定でも、全入口が通信・書込みなしに拒否される（ok:false・固定コード）', function () {
  var states = { ON: 'true', UNSET: undefined, WEIRD: 'maybe' };
  Object.keys(states).forEach(function (label) {
    ENTRIES.forEach(function (name) {
      var script = baseScript(armedScript());
      if (states[label] === undefined) delete script.ACCESS_ENABLED; else script.ACCESS_ENABLED = states[label];
      var env = loadShell({ script: script });
      var r = runEntry(env, name);
      var id = label + '/' + name;
      assert.strictEqual(r.ok, false, id);
      assert.ok(typeof r.code === 'string' && /^[A-Z0-9_]+$/.test(r.code), id + ': 固定コード ' + r.code);
      assertNoSideEffects(env, id);
      assertNoLeak(env, r, id);
    });
  });
});

test('環境不明（ACCESS_ENVIRONMENT 未設定・空・表記ゆれ）は、全入口が fail-closed（verify と断定しない）', function () {
  var variants = { MISSING: undefined, EMPTY: '', UPPER: 'VERIFY', SPACED: 'verify ', PROD_UPPER: 'Production' };
  Object.keys(variants).forEach(function (label) {
    ENTRIES.forEach(function (name) {
      var script = baseScript(armedScript());
      if (variants[label] === undefined) delete script.ACCESS_ENVIRONMENT; else script.ACCESS_ENVIRONMENT = variants[label];
      var env = loadShell({ script: script });
      var r = runEntry(env, name);
      var id = label + '/' + name;
      assert.strictEqual(r.ok, false, id);
      assert.ok(['SETTINGS_INCOMPLETE', 'ENV_NOT_VERIFY'].indexOf(r.code) !== -1, id + ': ' + r.code);
      assertNoSideEffects(env, id);
      assertNoLeak(env, r, id);
    });
  });
});

test('Script Properties の読取が例外でも、全入口が通信・書込みなしに ok:false で止まる（例外本文を出さない）', function () {
  ENTRIES.forEach(function (name) {
    var env = loadShell({ script: baseScript(armedScript()), throwOnRead: function (k) { return k === 'ACCESS_ENVIRONMENT' || k === 'ACCESS_CONFIG'; } });
    var r = runEntry(env, name);
    assert.strictEqual(r.ok, false, name);
    assertNoSideEffects(env, name);
    assertNoLeak(env, r, name);
  });
  // 例外が ACCESS_ENABLED の読取でも同じ
  ENTRIES.forEach(function (name) {
    var env = loadShell({ script: baseScript(armedScript()), throwOnRead: function (k) { return k === 'ACCESS_ENABLED'; } });
    var r = runEntry(env, name);
    assert.strictEqual(r.ok, false, name + '（ACCESS_ENABLED 読取例外）');
    assertNoSideEffects(env, name + '（ACCESS_ENABLED 読取例外）');
    assertNoLeak(env, r, name);
  });
});

test('許可リスト外の実行者は、本番設定でなくても全入口が通信前に拒否される（認可がゲートの先頭）', function () {
  ENTRIES.forEach(function (name) {
    var env = loadShell({ script: baseScript({ ACCESS_ADMIN_ACTORS: JSON.stringify({ 'someone-else@example.test': 'ADMIN-2' }) }) });
    var r = runEntry(env, name);
    assert.strictEqual(r.ok, false, name);
    assert.notStrictEqual(r.code, 'ENV_NOT_VERIFY', name + ': 認可が環境判定より前');
    assertNoSideEffects(env, name);
    assertNoLeak(env, r, name);
  });
});

// ================================================================ 本番の入口は別物であること

test('対照: 本番用 accessReadOnlyDiagnostics は検証用入口とは別関数で、本番設定の読取専用診断として動く（検証用入口の拒否に依存しない）', function () {
  var env = loadShell({ script: baseScript() });
  assert.strictEqual(typeof env.ctx.accessReadOnlyDiagnostics, 'function');
  assert.ok(ENTRIES.indexOf('accessReadOnlyDiagnostics') === -1, '本番診断は検証用入口の一覧に含めない');
  // 検証用診断は同じ設定で ENV_NOT_VERIFY を返す一方、本番診断は ENV_NOT_VERIFY では止まらない
  var prod = runEntry(env, 'accessReadOnlyDiagnostics');
  assert.notStrictEqual(prod.code, 'ENV_NOT_VERIFY');
  assert.strictEqual(env.mails, 0);
  assert.strictEqual(env.propWrites + env.propDeletes, 0, '本番診断も書込みなし');
});
