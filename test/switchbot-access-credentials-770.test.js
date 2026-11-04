/*
 * Issue #770: 独立GASの資格情報3件（User Properties）初期登録のテスト。
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

var NAMES = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'WEBHOOK_SHARED_TOKEN'];
var D = {
  SWITCHBOT_TOKEN: 'dummy-token-' + 'a1b2c3d4'.repeat(4),
  SWITCHBOT_SECRET: 'dummy-secret-' + 'e5f6a7b8'.repeat(3),
  WEBHOOK_SHARED_TOKEN: 'Zx9_Qw-' + 'LmNpRtUv'.repeat(3)
};
var D2 = {
  SWITCHBOT_TOKEN: 'dummy-token2-' + '1a2b3c4d'.repeat(4),
  SWITCHBOT_SECRET: 'dummy-secret2-' + '5e6f7a8b'.repeat(3),
  WEBHOOK_SHARED_TOKEN: 'Hk3_Yz-' + 'BcDfGhJk'.repeat(3)
};
var ADMIN = 'owner@example.test';

/** 呼ばれたプロパティ操作を全記録するフェイクストア。 */
function world(opts) {
  opts = opts || {};
  var w = { data: Object.assign({}, opts.initial || {}), ops: [], prompts: [], answers: (opts.answers || []).slice(), failSetOn: opts.failSetOn || null, corruptOn: opts.corruptOn || null };
  w.store = {
    get: function (k) { w.ops.push(['get', k]); return w.data[k] === undefined ? null : w.data[k]; },
    set: function (k, v) {
      w.ops.push(['set', k]);
      if (w.failSetOn === k) throw new Error('boom ' + v);
      w.data[k] = w.corruptOn === k ? 'corrupted' : String(v);
    },
    del: function (k) { w.ops.push(['del', k]); delete w.data[k]; },
    keys: function () { w.ops.push(['keys']); return Object.keys(w.data); }
  };
  w.deps = {
    userProps: w.store,
    adminActors: opts.actors === undefined ? { 'Owner@Example.test': 'ADMIN-1' } : opts.actors,
    identity: opts.identity || function () { return { email: ADMIN, effectiveEmail: ADMIN }; },
    prompt: function (n) {
      w.prompts.push(n);
      if (!w.answers.length) return null;
      var a = w.answers.shift();
      if (a instanceof Error) throw a;
      return a;
    }
  };
  return w;
}
function answers(m, order) { return (order || NAMES).map(function (n) { return m[n]; }); }
function run(w, opts) { return Infra.setupCredentials(w.deps, opts); }
function noSecretIn(value, vals) {
  var text = typeof value === 'string' ? value : JSON.stringify(value);
  Object.keys(vals).forEach(function (k) { assert.ok(text.indexOf(vals[k]) === -1, 'secret leaked: ' + k); });
}

// ================================================================ 正常系

test('正常登録: 3件がUser Propertiesに入り、結果はSET/固定コードのみ。触れるのは3キーだけ', function () {
  var w = world({ answers: answers(D) });
  var r = run(w);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.code, 'OK');
  assert.deepStrictEqual(r.status, { SWITCHBOT_TOKEN: 'SET', SWITCHBOT_SECRET: 'SET', WEBHOOK_SHARED_TOKEN: 'SET' });
  assert.deepStrictEqual(r.changed, NAMES);
  NAMES.forEach(function (n) { assert.strictEqual(w.data[n], D[n]); });
  noSecretIn(r, D);
  w.ops.forEach(function (op) { assert.ok(op[0] !== 'keys' && NAMES.indexOf(op[1]) !== -1, 'unexpected op ' + op.join(':')); });
});

test('dryRun: ダイアログ・認可・検証だけ行い、何も保存しない', function () {
  var w = world({ answers: answers(D) });
  var r = run(w, { dryRun: true });
  assert.strictEqual(r.code, 'DRY_RUN_OK');
  assert.deepStrictEqual(r.status, { SWITCHBOT_TOKEN: 'MISSING', SWITCHBOT_SECRET: 'MISSING', WEBHOOK_SHARED_TOKEN: 'MISSING' });
  assert.deepStrictEqual(w.data, {});
  assert.ok(!w.ops.some(function (o) { return o[0] === 'set' || o[0] === 'del'; }));
  noSecretIn(r, D);
});

// ================================================================ 欠損・部分設定・上書き

test('部分設定の復旧: 未設定の項目だけを入力させ、設定済みは変更しない', function () {
  var w = world({ initial: { SWITCHBOT_TOKEN: D.SWITCHBOT_TOKEN }, answers: [D.SWITCHBOT_SECRET, D.WEBHOOK_SHARED_TOKEN] });
  var r = run(w);
  assert.strictEqual(r.code, 'OK');
  assert.deepStrictEqual(w.prompts, ['SWITCHBOT_SECRET', 'WEBHOOK_SHARED_TOKEN']);
  assert.deepStrictEqual(r.changed, ['SWITCHBOT_SECRET', 'WEBHOOK_SHARED_TOKEN']);
  assert.strictEqual(w.data.SWITCHBOT_TOKEN, D.SWITCHBOT_TOKEN);
  assert.ok(!w.ops.some(function (o) { return o[0] === 'set' && o[1] === 'SWITCHBOT_TOKEN'; }));
});

test('上書き拒否: 3件設定済みの初回登録は入力画面も出さずに拒否し、値は不変', function () {
  var w = world({ initial: Object.assign({}, D), answers: answers(D2) });
  var r = run(w);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'ALREADY_SET');
  assert.deepStrictEqual(w.prompts, []);
  NAMES.forEach(function (n) { assert.strictEqual(w.data[n], D[n]); });
});

test('差し替え: 確認語REPLACEが必須。誤入力・取消では何も変更しない', function () {
  ['replace', '', 'yes', 'REPLACE2'].forEach(function (bad) {
    var w = world({ initial: Object.assign({}, D), answers: [bad].concat(answers(D2)) });
    var r = run(w, { mode: 'replace' });
    assert.strictEqual(r.code, 'REPLACE_NOT_CONFIRMED');
    assert.deepStrictEqual(w.prompts, ['__CONFIRM_REPLACE__']);
    NAMES.forEach(function (n) { assert.strictEqual(w.data[n], D[n]); });
  });
  var w2 = world({ initial: Object.assign({}, D), answers: [] });
  assert.strictEqual(run(w2, { mode: 'replace' }).code, 'CANCELLED');
  NAMES.forEach(function (n) { assert.strictEqual(w2.data[n], D[n]); });
});

test('差し替え: 確認後に新値へ置換でき、空入力の項目は据え置く', function () {
  var w = world({ initial: Object.assign({}, D), answers: ['REPLACE', D2.SWITCHBOT_TOKEN, '', D2.WEBHOOK_SHARED_TOKEN] });
  var r = run(w, { mode: 'replace' });
  assert.strictEqual(r.code, 'OK');
  assert.deepStrictEqual(r.changed, ['SWITCHBOT_TOKEN', 'WEBHOOK_SHARED_TOKEN']);
  assert.strictEqual(w.data.SWITCHBOT_TOKEN, D2.SWITCHBOT_TOKEN);
  assert.strictEqual(w.data.SWITCHBOT_SECRET, D.SWITCHBOT_SECRET);
  assert.strictEqual(w.data.WEBHOOK_SHARED_TOKEN, D2.WEBHOOK_SHARED_TOKEN);
  noSecretIn(r, Object.assign({}, D, D2));
});

test('差し替え: 未登録なら NOT_INITIALIZED（初回登録を案内）', function () {
  var w = world({ answers: ['REPLACE'].concat(answers(D2)) });
  assert.strictEqual(run(w, { mode: 'replace' }).code, 'NOT_INITIALIZED');
  assert.deepStrictEqual(w.data, {});
});

// ================================================================ 入力検証

test('入力不備: 1件でも不正なら何も書かない。不正な項目名だけ返し、値は返さない', function () {
  var bad = { SWITCHBOT_TOKEN: D.SWITCHBOT_TOKEN, SWITCHBOT_SECRET: 'short', WEBHOOK_SHARED_TOKEN: 'a'.repeat(30) };
  var w = world({ answers: answers(bad) });
  var r = run(w);
  assert.strictEqual(r.code, 'INPUT_INVALID');
  assert.deepStrictEqual(r.invalid, ['SWITCHBOT_SECRET', 'WEBHOOK_SHARED_TOKEN']);
  assert.deepStrictEqual(w.data, {});
  noSecretIn(r, bad);
});

test('validateCredentialInput: Webhookトークンは24文字以上・URL安全文字・低エントロピー拒否、API資格情報は空白/制御文字不可', function () {
  var v = Infra.validateCredentialInput;
  assert.strictEqual(v('WEBHOOK_SHARED_TOKEN', D.WEBHOOK_SHARED_TOKEN).ok, true);
  assert.strictEqual(v('WEBHOOK_SHARED_TOKEN', 'Ab1_Cd2-Ef3_Gh4-Ij5_Kl6').error, 'LENGTH'); // 23文字
  assert.strictEqual(v('WEBHOOK_SHARED_TOKEN', 'Ab1_Cd2-Ef3_Gh4-Ij5_Kl6-').ok, true); // 24文字
  assert.strictEqual(v('WEBHOOK_SHARED_TOKEN', 'a'.repeat(40)).error, 'LOW_ENTROPY');
  assert.strictEqual(v('WEBHOOK_SHARED_TOKEN', 'ab+/'.repeat(10)).error, 'CHARSET');
  assert.strictEqual(v('WEBHOOK_SHARED_TOKEN', 'x'.repeat(129)).ok, false);
  assert.strictEqual(v('SWITCHBOT_TOKEN', 'has space ' + 'x'.repeat(20)).error, 'WHITESPACE_OR_CONTROL');
  assert.strictEqual(v('SWITCHBOT_SECRET', 'abc\ndef' + 'x'.repeat(20)).error, 'WHITESPACE_OR_CONTROL');
  assert.strictEqual(v('SWITCHBOT_SECRET', '').error, 'EMPTY');
  assert.strictEqual(v('OTHER', 'x'.repeat(30)).error, 'UNKNOWN_NAME');
});

test('3種は互いに別の値: 同値の使い回し・設定済み値との重複を拒否', function () {
  // Webhook用の形式に合う値をAPI Tokenとしても使い回すケース
  var reused = 'Ab1_Cd2-Ef3_Gh4-Ij5_Kl6-Mn7_';
  var w = world({ answers: [reused, D.SWITCHBOT_SECRET, reused] });
  assert.strictEqual(run(w).code, 'INPUT_DUPLICATE');
  assert.deepStrictEqual(w.data, {});
  var w2 = world({ initial: { SWITCHBOT_TOKEN: reused }, answers: [D.SWITCHBOT_SECRET, reused] });
  assert.strictEqual(run(w2).code, 'INPUT_DUPLICATE');
  assert.strictEqual(w2.data.SWITCHBOT_SECRET, undefined);
});

// ================================================================ 認可（誤アカウント）

test('誤アカウント: 許可リスト外・未取得・許可リスト無しは入力画面を出さず fail closed', function () {
  var cases = [
    [{ identity: function () { return { email: 'other@example.test', effectiveEmail: 'other@example.test' }; } }, 'NOT_AUTHORIZED'],
    [{ identity: function () { return { email: '', effectiveEmail: '' }; } }, 'IDENTITY_UNAVAILABLE'],
    [{ identity: function () { throw new Error('no session'); } }, 'IDENTITY_UNAVAILABLE'],
    [{ actors: {} }, 'NOT_AUTHORIZED'],
    [{ actors: null }, 'NOT_AUTHORIZED'],
    [{ identity: function () { return { email: ADMIN, effectiveEmail: 'someone-else@example.test' }; } }, 'ACCOUNT_MISMATCH']
  ];
  cases.forEach(function (c) {
    var o = Object.assign({ answers: answers(D) }, c[0]);
    var w = world(o);
    var r = run(w);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.code, c[1]);
    assert.deepStrictEqual(w.prompts, []);
    assert.ok(!w.ops.some(function (op) { return op[0] === 'set' || op[0] === 'del'; }));
  });
});

// ================================================================ 途中失敗・ダイアログ不可

test('途中失敗: 2件目の書込みで例外 → 今回の変更を元に戻す。例外メッセージ（値を含む）は返さない', function () {
  var w = world({ answers: answers(D), failSetOn: 'SWITCHBOT_SECRET' });
  var r = run(w);
  assert.strictEqual(r.code, 'WRITE_FAILED');
  assert.deepStrictEqual(w.data, {});
  assert.deepStrictEqual(r.status, { SWITCHBOT_TOKEN: 'MISSING', SWITCHBOT_SECRET: 'MISSING', WEBHOOK_SHARED_TOKEN: 'MISSING' });
  noSecretIn(r, D);
});

test('途中失敗（差し替え）: 失敗時は元の値へ戻る', function () {
  var w = world({ initial: Object.assign({}, D), answers: ['REPLACE'].concat(answers(D2)), failSetOn: 'WEBHOOK_SHARED_TOKEN' });
  var r = run(w, { mode: 'replace' });
  assert.strictEqual(r.code, 'WRITE_FAILED');
  NAMES.forEach(function (n) { assert.strictEqual(w.data[n], D[n]); });
});

test('照合失敗: 書込み後の読戻しが一致しなければ元に戻す', function () {
  var w = world({ answers: answers(D), corruptOn: 'SWITCHBOT_SECRET' });
  var r = run(w);
  assert.strictEqual(r.code, 'VERIFY_FAILED');
  assert.deepStrictEqual(w.data, {});
});

test('入力途中の取消・ダイアログ不可: 何も書かない', function () {
  var w = world({ answers: [D.SWITCHBOT_TOKEN] }); // 2件目で取消(null)
  assert.strictEqual(run(w).code, 'CANCELLED');
  assert.deepStrictEqual(w.data, {});
  var w2 = world({ answers: [new Error('Cannot call Browser.inputBox from this context')] });
  assert.strictEqual(run(w2).code, 'PROMPT_UNAVAILABLE');
  assert.deepStrictEqual(w2.data, {});
});

// ================================================================ GASシェル（配布物をvmで実行）

function loadShell(over) {
  over = over || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba770-'));
  prepare.prepareProject(out);
  var env = { script: Object.assign({ ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }), ACCESS_ENABLED: undefined }, over.script || {}),
    user: Object.assign({}, over.user || {}), logs: [], fetches: 0, mails: 0, triggers: 0, boxes: [], scriptWrites: 0,
    answers: (over.answers || []).slice(), active: over.active || ADMIN, effective: over.effective || ADMIN, interactive: over.interactive !== false };
  Object.keys(env.script).forEach(function (k) { if (env.script[k] === undefined) delete env.script[k]; });
  function props(m, isScript) {
    return { getProperty: function (k) { return m[k] === undefined ? null : m[k]; },
      setProperty: function (k, v) { if (isScript) env.scriptWrites++; m[k] = String(v); },
      deleteProperty: function (k) { if (isScript) env.scriptWrites++; delete m[k]; }, getKeys: function () { return Object.keys(m); } };
  }
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(env.script, true); }, getUserProperties: function () { return props(env.user, false); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return env.active; } }; }, getEffectiveUser: function () { return { getEmail: function () { return env.effective; } }; } },
    Browser: { Buttons: { OK_CANCEL: 'OK_CANCEL' }, inputBox: function (label) {
      env.boxes.push(label);
      if (!env.interactive) throw new Error('Browser.inputBox is not available in this context');
      return env.answers.length ? env.answers.shift() : 'cancel';
    } },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    UrlFetchApp: { fetch: function () { env.fetches++; throw new Error('must not fetch'); } },
    MailApp: { sendEmail: function () { env.mails++; } },
    ScriptApp: { newTrigger: function () { env.triggers++; throw new Error('must not touch triggers'); }, getProjectTriggers: function () { env.triggers++; return []; }, deleteTrigger: function () { env.triggers++; } },
    LockService: { getScriptLock: function () { throw new Error('unused'); } },
    Utilities: {}, ContentService: {}, SpreadsheetApp: {}
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) {
    vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n });
  });
  env.ctx = ctx;
  return env;
}

test('シェル: 初回登録→accessCheckSetupで3件SET。Script Properties・トリガー・外部通信・メールに触れず、ログに秘密なし', function () {
  var env = loadShell({ answers: answers(D) });
  var r = env.ctx.accessSetupCredentials();
  assert.strictEqual(r.code, 'OK');
  NAMES.forEach(function (n) { assert.strictEqual(env.user[n], D[n]); });
  assert.strictEqual(env.scriptWrites, 0);
  assert.deepStrictEqual([env.fetches, env.mails, env.triggers], [0, 0, 0]);
  var st = env.ctx.accessCheckSetup();
  NAMES.forEach(function (n) { assert.strictEqual(st[n], 'SET'); });
  assert.strictEqual(st.ACCESS_ENABLED, 'OFF');
  noSecretIn(env.logs.join('\n'), D);
  noSecretIn(JSON.stringify(r), D);
  env.boxes.forEach(function (b) { noSecretIn(b, D); });
  assert.ok(!('SECRET_' in env.user));
  assert.deepStrictEqual(Object.keys(env.user).sort(), NAMES.slice().sort());
});

test('シェル: ダイアログの取消(文字列cancel)は取消扱い。誤アカウントは入力画面を出さない', function () {
  var env = loadShell({ answers: [] });
  assert.strictEqual(env.ctx.accessSetupCredentials().code, 'CANCELLED');
  assert.deepStrictEqual(env.user, {});
  var wrong = loadShell({ active: 'other@example.test', effective: 'other@example.test', answers: answers(D) });
  assert.strictEqual(wrong.ctx.accessSetupCredentials().code, 'NOT_AUTHORIZED');
  assert.deepStrictEqual(wrong.boxes, []);
  assert.deepStrictEqual(wrong.user, {});
});

test('シェル: ダイアログ不可（トリガー等の非対話実行）は PROMPT_UNAVAILABLE で何も書かず、未知の例外も固定コード', function () {
  var env = loadShell({ interactive: false, answers: answers(D) });
  assert.strictEqual(env.ctx.accessSetupCredentials().code, 'PROMPT_UNAVAILABLE');
  assert.deepStrictEqual(env.user, {});
  var broken = loadShell({ answers: answers(D) });
  broken.ctx.Session.getEffectiveUser = function () { throw new Error('x ' + D.SWITCHBOT_TOKEN); };
  var r = broken.ctx.accessSetupCredentials();
  assert.strictEqual(r.ok, false);
  noSecretIn(r, D);
  noSecretIn(broken.logs.join('\n'), D);
});

test('シェル: dryRun/replace の入口、Webアプリ(doPost/doGet)からは到達しない', function () {
  var env = loadShell({ answers: answers(D) });
  assert.strictEqual(env.ctx.accessSetupCredentialsDryRun().code, 'DRY_RUN_OK');
  assert.deepStrictEqual(env.user, {});
  var rep = loadShell({ user: Object.assign({}, D), answers: ['REPLACE'].concat(answers(D2)) });
  assert.strictEqual(rep.ctx.accessReplaceCredentials().code, 'OK');
  NAMES.forEach(function (n) { assert.strictEqual(rep.user[n], D2[n]); });
  var src = fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  var doPost = src.slice(src.indexOf('function doPost'), src.indexOf('function doGet'));
  assert.ok(!/Credential|inputBox|setProperty/.test(doPost));
});

test('配布物: manifestに新しいOAuthスコープを追加しない（自動デプロイは新scopeで停止するため）', function () {
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/appsscript.json'), 'utf8'));
  assert.deepStrictEqual(m.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/script.send_mail', 'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/userinfo.email'].sort());
  assert.strictEqual(m.webapp.executeAs, 'USER_DEPLOYING');
});
