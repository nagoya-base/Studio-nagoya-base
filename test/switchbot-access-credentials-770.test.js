/*
 * Issue #770: 独立GASの資格情報3件（User Properties）初期登録のテスト（GAS側ロジック・Execution API入口・ローカルCLI）。
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

test('照合の読戻しが例外でも元に戻す（VERIFY_FAILED、値は返さない）', function () {
  var w = world({ answers: answers(D) });
  var armed = false, origSet = w.store.set, origGet = w.store.get;
  w.store.set = function (k, v) { origSet(k, v); armed = true; };
  w.store.get = function (k) { if (armed && k === 'SWITCHBOT_TOKEN' && w.data[k] === D[k]) { armed = false; throw new Error('read failed ' + D[k]); } return origGet(k); };
  var r = run(w);
  assert.strictEqual(r.code, 'VERIFY_FAILED');
  assert.deepStrictEqual(w.data, {});
  noSecretIn(r, D);
});

test('入力途中の取消・ダイアログ不可: 何も書かない', function () {
  var w = world({ answers: [D.SWITCHBOT_TOKEN] }); // 2件目で取消(null)
  assert.strictEqual(run(w).code, 'CANCELLED');
  assert.deepStrictEqual(w.data, {});
  var w2 = world({ answers: [new Error('Cannot call Browser.inputBox from this context')] });
  assert.strictEqual(run(w2).code, 'PROMPT_UNAVAILABLE');
  assert.deepStrictEqual(w2.data, {});
});

// ================================================================ GAS入口（accessSetupCredentialsApi）

function loadShell(over) {
  over = over || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba770-'));
  prepare.prepareProject(out);
  var env = { script: Object.assign({ ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }) }, over.script || {}),
    user: Object.assign({}, over.user || {}), logs: [], fetches: 0, mails: 0, triggers: 0, scriptWrites: 0,
    active: 'active' in over ? over.active : ADMIN, effective: 'effective' in over ? over.effective : ADMIN };
  function props(m, isScript) {
    return { getProperty: function (k) { return m[k] === undefined ? null : m[k]; },
      setProperty: function (k, v) { if (isScript) env.scriptWrites++; m[k] = String(v); },
      deleteProperty: function (k) { if (isScript) env.scriptWrites++; delete m[k]; }, getKeys: function () { return Object.keys(m); } };
  }
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(env.script, true); }, getUserProperties: function () { return props(env.user, false); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return env.active; } }; }, getEffectiveUser: function () { return { getEmail: function () { return env.effective; } }; } },
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
function plain(x) { return JSON.parse(JSON.stringify(x)); }

test('GAS入口: 登録→accessCheckSetupで3件SET。Script Properties・トリガー・外部通信・メールに触れず、ログ/戻り値に秘密なし', function () {
  var env = loadShell();
  var r = plain(env.ctx.accessSetupCredentialsApi({ mode: 'init', dryRun: false, values: D }));
  assert.strictEqual(r.code, 'OK');
  NAMES.forEach(function (n) { assert.strictEqual(env.user[n], D[n]); });
  assert.strictEqual(env.scriptWrites, 0);
  assert.deepStrictEqual([env.fetches, env.mails, env.triggers], [0, 0, 0]);
  var st = plain(env.ctx.accessCheckSetup());
  NAMES.forEach(function (n) { assert.strictEqual(st[n], 'SET'); });
  assert.strictEqual(st.ACCESS_ENABLED, 'OFF');
  noSecretIn(env.logs.join('\n'), D);
  noSecretIn(r, D);
  assert.deepStrictEqual(Object.keys(env.user).sort(), NAMES.slice().sort());
});

test('GAS入口: accessCredentialStatusApi は入力なし・無保存で認可とSET/MISSINGだけ返す', function () {
  var env = loadShell({ user: { SWITCHBOT_TOKEN: D.SWITCHBOT_TOKEN } });
  var r = plain(env.ctx.accessCredentialStatusApi());
  assert.deepStrictEqual(r, { ok: true, code: 'STATUS_OK', status: { SWITCHBOT_TOKEN: 'SET', SWITCHBOT_SECRET: 'MISSING', WEBHOOK_SHARED_TOKEN: 'MISSING' }, changed: [] });
  assert.deepStrictEqual(Object.keys(env.user), ['SWITCHBOT_TOKEN']);
  noSecretIn(r, D); noSecretIn(env.logs.join('\n'), D);
  var bad = loadShell({ active: 'other@example.test', effective: 'other@example.test', user: Object.assign({}, D) });
  var br = plain(bad.ctx.accessCredentialStatusApi());
  assert.strictEqual(br.code, 'NOT_AUTHORIZED');
  assert.deepStrictEqual(br.status, { SWITCHBOT_TOKEN: 'MISSING', SWITCHBOT_SECRET: 'MISSING', WEBHOOK_SHARED_TOKEN: 'MISSING' }); // 未認可には状態も見せない
  assert.strictEqual(plain(bad.ctx.accessSetupCredentialsApi(undefined)).ok, false);
});

test('GAS入口: effectiveEmail が空/未取得なら管理者でも停止（IDENTITY_UNAVAILABLE）、不一致は ACCOUNT_MISMATCH。入力・書込みより前', function () {
  ['', null, undefined].forEach(function (eff) {
    var w = world({ answers: answers(D), identity: function () { return { email: ADMIN, effectiveEmail: eff }; } });
    var r = run(w);
    assert.strictEqual(r.code, 'IDENTITY_UNAVAILABLE');
    assert.deepStrictEqual(w.prompts, []);
    assert.ok(!w.ops.some(function (op) { return op[0] === 'set' || op[0] === 'del'; }));
    var st = Infra.credentialStatus(w.deps);
    assert.strictEqual(st.code, 'IDENTITY_UNAVAILABLE');
  });
  var noEff = world({ answers: answers(D), identity: function () { return { email: ADMIN }; } });
  assert.strictEqual(run(noEff).code, 'IDENTITY_UNAVAILABLE');
  var env = loadShell({ effective: '' });
  assert.strictEqual(plain(env.ctx.accessSetupCredentialsApi({ mode: 'init', values: D })).code, 'IDENTITY_UNAVAILABLE');
  assert.deepStrictEqual(env.user, {});
  var mm = world({ answers: answers(D), identity: function () { return { email: ADMIN, effectiveEmail: 'x@example.test' }; } });
  assert.strictEqual(run(mm).code, 'ACCOUNT_MISMATCH');
});

test('GAS入口: 誤アカウントは書かない／想定外例外は固定コードで値を出さない／replaceは確認語必須', function () {
  var wrong = loadShell({ active: 'other@example.test', effective: 'other@example.test' });
  assert.strictEqual(plain(wrong.ctx.accessSetupCredentialsApi({ mode: 'init', values: D })).code, 'NOT_AUTHORIZED');
  assert.deepStrictEqual(wrong.user, {});
  var broken = loadShell();
  broken.ctx.Session.getEffectiveUser = function () { throw new Error('x ' + D.SWITCHBOT_TOKEN); };
  var r = plain(broken.ctx.accessSetupCredentialsApi({ mode: 'init', values: D }));
  assert.strictEqual(r.ok, false);
  noSecretIn(r, D);
  noSecretIn(broken.logs.join('\n'), D);
  assert.deepStrictEqual(broken.user, {});
  var rep = loadShell({ user: Object.assign({}, D) });
  assert.strictEqual(plain(rep.ctx.accessSetupCredentialsApi({ mode: 'replace', values: Object.assign({ __CONFIRM_REPLACE__: 'no' }, D2) })).code, 'REPLACE_NOT_CONFIRMED');
  assert.strictEqual(rep.user.SWITCHBOT_TOKEN, D.SWITCHBOT_TOKEN);
  assert.strictEqual(plain(rep.ctx.accessSetupCredentialsApi({ mode: 'replace', values: Object.assign({ __CONFIRM_REPLACE__: 'REPLACE' }, D2) })).code, 'OK');
  assert.strictEqual(rep.user.SWITCHBOT_TOKEN, D2.SWITCHBOT_TOKEN);
});

test('GAS入口: Webアプリ(doPost/doGet)・ダイアログ(Browser)からは到達しない／manifest無変更', function () {
  var src = fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  var doPost = src.slice(src.indexOf('function doPost'), src.indexOf('function doGet'));
  assert.ok(!/Credential|setProperty/.test(doPost));
  assert.ok(!/Browser\./.test(src));
  var m = JSON.parse(fs.readFileSync(path.join(__dirname, '../gas/switchbot-access/appsscript.json'), 'utf8'));
  assert.deepStrictEqual(m.oauthScopes.slice().sort(), [
    'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/script.send_mail', 'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/userinfo.email'].sort());
  assert.strictEqual(m.webapp.executeAs, 'USER_DEPLOYING');
});

// ================================================================ ローカルCLI（scripts/switchbot-access-credentials-lib.js）

var lib = require('../scripts/switchbot-access-credentials-lib');
var DEPLOYMENT_ID = 'AKfycb' + 'D'.repeat(30);
var RC = JSON.stringify({ tokens: { default: { client_id: 'cid.test', client_secret: 'csec-test', refresh_token: 'rt-test' } } });

/** GAS入口を本物のvmで動かし、scripts.run のHTTP応答として返すフェイクfetch。 */
function cli(over) {
  over = over || {};
  var env = loadShell(over.shell);
  var c = { calls: [], out: [], err: [], files: {}, asked: [], env: env };
  var answers = (over.answers || []).slice();
  c.fetch = async function (url, init) {
    c.calls.push({ url: url, init: init });
    if (/oauth2\.googleapis\.com/.test(url)) return over.tokenFail ? { ok: false, status: 400, json: async function () { return {}; } } : { ok: true, status: 200, json: async function () { return { access_token: 'at-test' }; } };
    if (over.httpStatus) return { ok: false, status: over.httpStatus, json: async function () { return { error: { message: 'detail ' + D.SWITCHBOT_TOKEN } }; } };
    var body = JSON.parse(init.body);
    assert.ok(url.indexOf('/v1/scripts/' + DEPLOYMENT_ID + ':run') !== -1); // デプロイIDを指定
    assert.strictEqual(body.devMode, false);
    assert.ok(['accessCredentialStatusApi', 'accessSetupCredentialsApi'].indexOf(body.function) !== -1);
    if (over.scriptError) return { ok: true, status: 200, json: async function () { return { error: { details: [{ errorMessage: 'x ' + D.SWITCHBOT_TOKEN }] } }; } };
    var result = env.ctx[body.function].apply(null, body.parameters);
    return { ok: true, status: 200, json: async function () { return { done: true, response: { result: plain(result) } }; } };
  };
  c.deps = {
    argv: over.argv || [], env: Object.assign({ SBA_API_DEPLOYMENT_ID: DEPLOYMENT_ID }, over.env || {}), homedir: over.homedir || '/home/op', isTTY: over.isTTY !== false,
    readFile: function (p) { c.rcPath = p; if (over.rc === null) throw new Error('ENOENT'); return over.rc || RC; },
    writeNewFile: function (p, content) { if (c.files[p] !== undefined || over.fileExists) throw new Error('EEXIST'); c.files[p] = content; },
    fetch: c.fetch, randomToken: function () { return D.WEBHOOK_SHARED_TOKEN; },
    ask: { secret: async function (l) { c.asked.push(l); return answers.length ? answers.shift() : null; }, visible: async function (l) { c.asked.push(l); return answers.length ? answers.shift() : null; } },
    out: function (l) { c.out.push(l); }, err: function (l) { c.err.push(l); }
  };
  c.run = function () { return lib.main(c.deps); };
  c.text = function () { return c.out.concat(c.err).concat(c.asked).join('\n'); };
  return c;
}
function bodies(c) { return c.calls.filter(function (x) { return /script\.googleapis/.test(x.url); }).map(function (x) { return x.init.body; }); }

test('CLI: 正常登録。値はscripts.runのHTTPS本文にのみ載り、標準出力/エラー/質問文言には出ない', async function () {
  var c = cli({ answers: answers(D) });
  var code = await c.run();
  assert.strictEqual(code, 0);
  NAMES.forEach(function (n) { assert.strictEqual(c.env.user[n], D[n]); });
  assert.ok(c.out.indexOf('result: OK') !== -1);
  NAMES.forEach(function (n) { assert.ok(c.out.indexOf(n + ': SET') !== -1); });
  noSecretIn(c.text(), D);
  assert.strictEqual(bodies(c).length, 2); // 状態確認(値なし) + 登録
  noSecretIn(bodies(c)[0], D);
  assert.ok(bodies(c)[1].indexOf(D.SWITCHBOT_SECRET) !== -1);
  c.calls.forEach(function (x) { assert.ok(x.url.indexOf(D.SWITCHBOT_TOKEN) === -1); });
  assert.strictEqual(c.env.scriptWrites, 0);
  noSecretIn(c.env.logs.join('\n'), D);
});

test('CLI: --dry-runは認可と状態確認のみ（値を一切聞かず、無保存）。部分設定では未設定の項目だけ聞く', async function () {
  var c = cli({ argv: ['--dry-run'], answers: answers(D) });
  assert.strictEqual(await c.run(), 0);
  assert.ok(c.out.indexOf('result: STATUS_OK') !== -1);
  assert.deepStrictEqual(c.asked, []);
  assert.deepStrictEqual(c.env.user, {});
  assert.strictEqual(bodies(c).length, 1);
  var p = cli({ shell: { user: { SWITCHBOT_TOKEN: D.SWITCHBOT_TOKEN } }, answers: [D.SWITCHBOT_SECRET, D.WEBHOOK_SHARED_TOKEN] });
  assert.strictEqual(await p.run(), 0);
  assert.strictEqual(p.asked.length, 2);
  assert.strictEqual(p.env.user.SWITCHBOT_TOKEN, D.SWITCHBOT_TOKEN);
});

test('CLI: 上書き拒否（3件設定済みの初回登録は何も聞かず終了）、replaceは確認語必須', async function () {
  var c = cli({ shell: { user: Object.assign({}, D) }, answers: answers(D2) });
  assert.strictEqual(await c.run(), 1);
  assert.ok(c.out.indexOf('result: ALREADY_SET') !== -1);
  assert.deepStrictEqual(c.asked, []);
  NAMES.forEach(function (n) { assert.strictEqual(c.env.user[n], D[n]); });
  var r = cli({ argv: ['--replace'], shell: { user: Object.assign({}, D) }, answers: ['yes'].concat(answers(D2)) });
  assert.strictEqual(await r.run(), 1);
  assert.ok(r.out.indexOf('result: REPLACE_NOT_CONFIRMED') !== -1);
  NAMES.forEach(function (n) { assert.strictEqual(r.env.user[n], D[n]); });
  var ok = cli({ argv: ['--replace'], shell: { user: Object.assign({}, D) }, answers: ['REPLACE', D2.SWITCHBOT_TOKEN, '', D2.WEBHOOK_SHARED_TOKEN] });
  assert.strictEqual(await ok.run(), 0);
  assert.strictEqual(ok.env.user.SWITCHBOT_TOKEN, D2.SWITCHBOT_TOKEN);
  assert.strictEqual(ok.env.user.SWITCHBOT_SECRET, D.SWITCHBOT_SECRET);
});

test('CLI: 誤アカウント（許可リスト外）は値を聞く前に停止、認証失敗・API未リンク・スクリプトエラーも固定コード', async function () {
  var wrong = cli({ shell: { active: 'other@example.test', effective: 'other@example.test' }, answers: answers(D) });
  assert.strictEqual(await wrong.run(), 1);
  assert.ok(wrong.out.indexOf('result: NOT_AUTHORIZED') !== -1);
  assert.deepStrictEqual(wrong.asked, []);
  var cases = [[{ tokenFail: true }, 'API_AUTH_FAILED'], [{ httpStatus: 403 }, 'API_AUTH_FAILED'], [{ httpStatus: 404 }, 'API_NOT_FOUND'],
    [{ httpStatus: 500 }, 'API_ERROR'], [{ scriptError: true }, 'SCRIPT_ERROR'], [{ rc: '{}' }, 'CLASPRC_INVALID'], [{ rc: null }, 'CLASPRC_INVALID'],
    [{ env: { SBA_API_DEPLOYMENT_ID: 'short' } }, 'DEPLOYMENT_ID_MISSING']];
  for (var k = 0; k < cases.length; k++) {
    var c = cli(Object.assign({ answers: answers(D) }, cases[k][0]));
    assert.strictEqual(await c.run(), 1);
    assert.deepStrictEqual(c.err, ['error: ' + cases[k][1]]);
    assert.deepStrictEqual(c.asked, []);
    noSecretIn(c.text(), D);
  }
});

test('CLI: 引数で値を渡す・未知の引数・非TTY入力は拒否し、引数を出力しない', async function () {
  var secretArg = 'tok-' + D.SWITCHBOT_TOKEN;
  var a = cli({ argv: [secretArg], answers: answers(D) });
  assert.strictEqual(await a.run(), 1);
  assert.deepStrictEqual(a.err, ['error: BAD_ARGS']);
  noSecretIn(a.text(), { x: secretArg });
  assert.strictEqual(a.calls.length, 0);
  var b = cli({ argv: ['--token=' + D.SWITCHBOT_TOKEN] });
  assert.strictEqual(await b.run(), 1);
  assert.deepStrictEqual(b.err, ['error: BAD_ARGS']);
  var n = cli({ isTTY: false, answers: answers(D) });
  assert.strictEqual(await n.run(), 1);
  assert.deepStrictEqual(n.err, ['error: NO_TTY']);
  assert.strictEqual(n.calls.length, 0);
  assert.throws(function () { lib.parseArgs(['--generate-webhook-token-to']); });
});

test('CLI: 入力途中の取消・途中失敗では何も保存しない', async function () {
  var c = cli({ answers: [D.SWITCHBOT_TOKEN] }); // 2件目で取消
  assert.strictEqual(await c.run(), 1);
  assert.deepStrictEqual(c.err, ['error: CANCELLED']);
  assert.deepStrictEqual(c.env.user, {});
  var f = cli({ answers: answers(D) });
  // GAS側書込み失敗（2件目で例外）→ ロールバック → 固定コード
  var realProps = f.env.ctx.PropertiesService.getUserProperties;
  f.env.ctx.PropertiesService.getUserProperties = function () {
    var p = realProps();
    return { getProperty: p.getProperty, deleteProperty: p.deleteProperty, getKeys: p.getKeys, setProperty: function (k, v) { if (k === 'SWITCHBOT_SECRET') throw new Error('boom ' + v); p.setProperty(k, v); } };
  };
  assert.strictEqual(await f.run(), 1);
  assert.ok(f.out.indexOf('result: WRITE_FAILED') !== -1);
  assert.deepStrictEqual(f.env.user, {});
  noSecretIn(f.text(), D);
});

test('CLI: --generate-webhook-token-to は新規ファイル(0600想定)へ出力し、画面には出さない。既存ファイルは拒否', async function () {
  var c = cli({ argv: ['--generate-webhook-token-to', '/tmp/wh.txt'], answers: [D.SWITCHBOT_TOKEN, D.SWITCHBOT_SECRET] });
  assert.strictEqual(await c.run(), 0);
  assert.strictEqual(c.files['/tmp/wh.txt'], D.WEBHOOK_SHARED_TOKEN + '\n');
  assert.strictEqual(c.env.user.WEBHOOK_SHARED_TOKEN, D.WEBHOOK_SHARED_TOKEN);
  assert.strictEqual(c.asked.length, 2);
  noSecretIn(c.text(), D);
  var e = cli({ argv: ['--generate-webhook-token-to', '/tmp/wh.txt'], fileExists: true, answers: answers(D) });
  assert.strictEqual(await e.run(), 1);
  assert.deepStrictEqual(e.err, ['error: TOKEN_FILE_EXISTS_OR_UNWRITABLE']);
  assert.deepStrictEqual(e.env.user, {});
  // 実ファイル書込みは新規のみ・0600
  var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sba770f-'));
  var fp = path.join(dir, 'wh.txt');
  lib.newFileWriter(fp, 'x\n');
  assert.strictEqual(fs.statSync(fp).mode & 0o777, 0o600);
  assert.throws(function () { lib.newFileWriter(fp, 'y\n'); });
  assert.ok(/^[A-Za-z0-9_-]{43}$/.test(lib.randomToken()));
  assert.strictEqual(Infra.validateCredentialInput('WEBHOOK_SHARED_TOKEN', lib.randomToken()).ok, true);
});

test('CLI: clasprc の読取り（tokens.default / 旧形式）。不足は拒否', function () {
  assert.deepStrictEqual(lib.readClasprc(RC, 'default'), { clientId: 'cid.test', clientSecret: 'csec-test', refreshToken: 'rt-test' });
  var legacy = JSON.stringify({ token: { refresh_token: 'r' }, oauth2ClientSettings: { clientId: 'c', clientSecret: 's' } });
  assert.strictEqual(lib.readClasprc(legacy).refreshToken, 'r');
  assert.throws(function () { lib.readClasprc(JSON.stringify({ tokens: { default: { refresh_token: 'r' } } })); });
  assert.throws(function () { lib.readClasprc('not json'); });
});

test('CLI: Windows対応。ホームは os.homedir() 相当(USERPROFILE系)を使い、HOME未設定でもclasprcを読む。PowerShell例を手順書に記載', async function () {
  var c = cli({ answers: answers(D), homedir: 'C:\\Users\\operator' });
  assert.deepStrictEqual(Object.keys(c.deps.env), ['SBA_API_DEPLOYMENT_ID']); // HOME/CLASPRC_PATH なし
  assert.strictEqual(await c.run(), 0);
  assert.ok(/\.clasprc\.json$/.test(c.rcPath) && c.rcPath.indexOf('operator') !== -1);
  var doc = fs.readFileSync(path.join(__dirname, '../docs/switchbot-access-credentials-770.md'), 'utf8');
  assert.ok(doc.indexOf('$env:SBA_API_DEPLOYMENT_ID') !== -1);
  var libSrc = fs.readFileSync(path.join(__dirname, '../scripts/switchbot-access-credentials-lib.js'), 'utf8');
  assert.ok(!/env\.HOME/.test(libSrc));
});
