/*
 * Issue #774: 独立GAS 本番初期設定の読取専用診断（accessReadOnlyDiagnostics）のテスト。
 * 実GAS・実API・実秘密には接続しない。値はすべてテスト内のダミー。
 * 全ケースで「書込み・ロック・通信・メール・トリガー・シート書込み 0件」と「出力に秘密/個票/完全IDなし」をアサートする。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var Infra = require('../gas/switchbot-access/SwitchBotAccessInfra.gs');
var Ledger = require('../gas/switchbot-access/AccessLedgerReader.gs');
var prepare = require('../scripts/prepare-switchbot-access-gas-project');
var SheetsFake = require('./helpers/sheets-rest-fake');

var ADMIN = 'owner@example.test';
var SHEET_ID = 'sheet-id-DUMMY-1234567890';
var SECRETS = {
  SWITCHBOT_TOKEN: 'dummy-token-' + 'a1b2c3d4'.repeat(4),
  SWITCHBOT_SECRET: 'dummy-secret-' + 'e5f6a7b8'.repeat(3),
  WEBHOOK_SHARED_TOKEN: 'Zx9_Qw-' + 'LmNpRtUv'.repeat(3)
};
var LEAK_WORDS = ['PII-NAME-TARO', 'pii-mail@example.test', 'BOOKING-ID-SECRET-001', 'LEAK-ME-IN-ERROR', 'https://hooks.example.test', '090-0000-0000'];
var HEADERS = Ledger.REQUIRED_COLUMNS.concat(['name', 'email', 'phone']);

function cfgJson(over) {
  return JSON.stringify(Object.assign({
    environment: 'production', allowedLast4: ['01FD'], keypads: [{ deviceId: 'DEVICE00000001FD' }],
    ledgerTarget: { facility: 'snb' }, adminMailTo: ['ops@example.test']
  }, over || {}));
}
function row(over) {
  var r = { bookingId: 'BOOKING-ID-SECRET-001', startAt: new Date('2030-01-10T10:00:00+09:00'), endAt: new Date('2030-01-10T12:00:00+09:00'),
    brand: 'snb', status: 'confirmed', paymentMethod: 'cash', paymentStatus: 'paid', paymentConfirmedAt: '', confirmedAt: '', expiredAt: '',
    feeSettlementState: '', feeRecoveryRequiredAt: '', paymentRecoveryRequiredAt: '', revision: 1,
    name: 'PII-NAME-TARO', email: 'pii-mail@example.test', phone: '090-0000-0000' };
  return Object.assign(r, over || {});
}

function loadShell(o) {
  o = o || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba774-'));
  prepare.prepareProject(out);
  var env = {
    script: Object.assign({ ACCESS_CONFIG: cfgJson(), ACCESS_ENVIRONMENT: 'production', LEDGER_SPREADSHEET_ID: SHEET_ID,
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }) }, o.script || {}),
    user: Object.assign({}, 'user' in o ? o.user : SECRETS),
    headers: o.headers || HEADERS, rows: o.rows || [row()], email: ADMIN, effective: ADMIN,
    logs: [], writes: 0, fetches: 0, mails: 0, triggers: 0, locks: 0, sheetWrites: 0, opened: 0
  };
  function props(m) {
    return {
      getProperty: function (k) { if (o.failRead && o.failRead(k)) throw new Error('LEAK-ME-IN-ERROR ' + SECRETS.SWITCHBOT_TOKEN); return m[k] === undefined ? null : m[k]; },
      setProperty: function () { env.writes++; }, deleteProperty: function () { env.writes++; }, setProperties: function () { env.writes++; }, deleteAllProperties: function () { env.writes++; },
      getKeys: function () { if (o.failKeys) throw new Error('LEAK-ME-IN-ERROR'); return Object.keys(m); }
    };
  }
  // 台帳は SpreadsheetApp ではなく Sheets API(REST) の GET で読む（#776）。SpreadsheetApp は使われたら権限エラーになる
  env.sheets = SheetsFake.create({ headers: env.headers, rows: env.rows, noSheet: o.noSheet, http: o.http || null, fetchThrow: o.fetchThrow, dateAs: o.dateAs });
  env.sheetFetches = 0; env.tokens = 0;
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(env.script); }, getUserProperties: function () { return props(env.user); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return env.email; } }; }, getEffectiveUser: function () { return { getEmail: function () { return env.effective; } }; } },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    UrlFetchApp: {
      fetch: function (url, options) {
        if (/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\//.test(url)) { env.sheetFetches++; return env.sheets.fetch(url, options); }
        env.fetches++; throw new Error('no fetch'); // SwitchBot等、Sheets API以外への通信は禁止
      }
    },
    MailApp: { sendEmail: function () { env.mails++; } },
    ScriptApp: { getOAuthToken: function () { env.tokens++; return 'dummy-oauth-token'; }, newTrigger: function () { env.triggers++; throw new Error('no'); }, getProjectTriggers: function () { env.triggers++; return []; }, deleteTrigger: function () { env.triggers++; } },
    LockService: { getScriptLock: function () { env.locks++; return { tryLock: function () { env.locks++; return true; }, releaseLock: function () {} }; } },
    SpreadsheetApp: {
      openById: function () {
        env.opened++;
        throw new Error('You do not have permission to call SpreadsheetApp.openById. Required permissions: https://www.googleapis.com/auth/spreadsheets');
      }
    },
    Utilities: {}, ContentService: {}
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) { vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n }); });
  env.ctx = ctx;
  return env;
}
function plain(x) { return JSON.parse(JSON.stringify(x)); }

/** 全ケース共通: 副作用0件、ログと戻り値が同一の固定JSON、秘密・個票・完全IDなし。 */
function run(env) {
  var snapshot = JSON.stringify([env.script, env.user]);
  var r = plain(env.ctx.accessReadOnlyDiagnostics());
  assert.strictEqual(env.logs.length, 1, 'ログは固定JSON1行');
  assert.deepStrictEqual(JSON.parse(env.logs[0]), r);
  var all = env.logs.join('\n') + JSON.stringify(r);
  Object.keys(SECRETS).forEach(function (k) { assert.ok(all.indexOf(SECRETS[k]) === -1, 'leak ' + k); });
  LEAK_WORDS.concat([SHEET_ID, ADMIN, 'ADMIN-1', 'DEVICE00000001FD', 'ops@example.test']).forEach(function (w) { assert.ok(all.indexOf(w) === -1, 'leak ' + w); });
  assert.deepStrictEqual([env.writes, env.fetches, env.mails, env.triggers, env.locks, env.sheets.state.writes], [0, 0, 0, 0, 0, 0], '副作用なし（書込み・SwitchBot通信・メール・トリガー・ロック・Sheets書込み）');
  assert.strictEqual(env.opened, 0, 'SpreadsheetApp は使わない（spreadsheets.readonly では呼べない）');
  env.sheets.state.calls.forEach(function (c) { assert.strictEqual(c.method, 'get'); assert.ok(c.auth, 'OAuthトークン付き'); assert.ok(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[^/?]+(\/values.*|\?fields=.*)?$/.test(c.url), c.url); });
  assert.strictEqual(JSON.stringify([env.script, env.user]), snapshot, 'プロパティ不変');
  return r;
}

test('正常（未初期化の空ストア）: ok=true・DIAGNOSTICS_OK。値は出さず固定コードと集計のみ', function () {
  var r = run(loadShell());
  assert.strictEqual(r.ok, true); assert.strictEqual(r.code, 'DIAGNOSTICS_OK'); assert.deepStrictEqual(r.failures, []);
  assert.strictEqual(r.identity, 'AUTHORIZED'); assert.strictEqual(r.accessEnabled, 'OFF'); assert.strictEqual(r.environment, 'PRODUCTION');
  assert.strictEqual(r.config.state, 'VALID'); assert.strictEqual(r.config.envMatch, 'MATCH'); assert.deepStrictEqual(r.config.errors, []);
  assert.strictEqual(r.config.source, 'LEGACY'); // #859: ACCESS_CONFIG_FORMAT 未設定は旧形式
  assert.strictEqual(r.issuance.state, 'NOT_READY'); // #859: 対象ブランド等が無い設定は基本妥当でも発行前提不足を示す
  assert.deepStrictEqual(r.settings, { ACCESS_CONFIG: 'SET', ACCESS_ENVIRONMENT: 'SET', LEDGER_SPREADSHEET_ID: 'SET', ACCESS_ADMIN_ACTORS: 'SET' });
  assert.deepStrictEqual(r.credentials, { SWITCHBOT_TOKEN: 'SET', SWITCHBOT_SECRET: 'SET', WEBHOOK_SHARED_TOKEN: 'SET' });
  assert.strictEqual(r.ledger.state, 'LEDGER_ACCESS_OK'); assert.strictEqual(r.ledger.headers, 'COMPLETE'); assert.strictEqual(r.ledger.columnFormat, 'OK');
  assert.strictEqual(r.ledger.rows, 1);
  assert.strictEqual(r.store.state, 'EMPTY_UNINITIALIZED'); assert.strictEqual(r.store.keys, 0);
  assert.deepStrictEqual(r.notes, ['NO_WRITES', 'NO_EXTERNAL_COMMUNICATION', 'CREDENTIAL_VALIDITY_NOT_VERIFIED']);
});

test('ACCESS_ENABLED が未設定/false は OFF として進む。ACCESS_*/LEDGER_*/BOOTSTRAP_* は状態件数に含めない', function () {
  var env = loadShell({ script: { ACCESS_ENABLED: 'false', BOOTSTRAP_SWITCHBOT_TOKEN: 'x'.repeat(30) } });
  var r = run(env);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.accessEnabled, 'OFF'); assert.strictEqual(r.store.keys, 0);
});

test('初期化済みストア: 接頭辞は許可リストのみ集計（未知は OTHER）、未解決OPを件数で示す。個別キー名・内容は出さない', function () {
  var env = loadShell({ script: {
    META_ENV: 'production', HB_SYNC: '{"at":1}', NOTIFYFAIL: '1', SECRETKEY_WITH_NAME: 'z',
    OP_A: JSON.stringify({ id: 'OP-1', state: 'SENDING' }), OP_B: JSON.stringify({ id: 'OP-2', state: 'DELETED_CONFIRMED' })
  } });
  var r = run(env);
  assert.strictEqual(r.ok, true); assert.strictEqual(r.store.state, 'INITIALIZED'); assert.strictEqual(r.store.metaEnv, 'MATCH');
  assert.deepStrictEqual(r.store.ops, { total: 2, unresolved: 1, unreadable: 0 });
  assert.deepStrictEqual(r.store.byPrefix, { META: 1, HB: 1, OP: 2, OTHER: 2 });
  assert.ok(JSON.stringify(r).indexOf('SECRETKEY') === -1 && JSON.stringify(r).indexOf('NOTIFYFAIL') === -1);
});

test('ストア異常: 別環境の刻印・環境刻印なしのデータ・読めないOP・容量超過は ok=false', function () {
  var cases = [
    [{ META_ENV: 'verify' }, 'STORE_ENV_MISMATCH'],
    [{ HB_SYNC: '{}' }, 'STORE_INCONSISTENT'],
    [{ META_ENV: 'production', OP_X: 'not-json' }, 'STORE_RECORD_INVALID'],
    [{ META_ENV: 'production', OP_X: JSON.stringify({ id: 'x', state: 'NOT_A_REAL_STATE' }) }, 'STORE_RECORD_INVALID'],
    [{ META_ENV: 'production', OP_X: JSON.stringify({ id: 'x' }) }, 'STORE_RECORD_INVALID'],
    [{ META_ENV: 'production', EVT_BIG: 'x'.repeat(8 * 1024 + 900) }, 'STORAGE_VALUE_NEAR_LIMIT']
  ];
  cases.forEach(function (c) {
    var r = run(loadShell({ script: c[0] }));
    assert.strictEqual(r.ok, false, c[1]); assert.strictEqual(r.code, c[1]); assert.strictEqual(r.store.state, c[1]);
  });
});

test('OFF以外（ON/想定外値/読取不能）は警告して追加診断を中止。台帳へも触れない', function () {
  [['true', 'ACCESS_NOT_OFF', 'ON'], ['TRUE', 'ACCESS_STATE_UNKNOWN', 'UNKNOWN'], ['1', 'ACCESS_STATE_UNKNOWN', 'UNKNOWN']].forEach(function (c) {
    var env = loadShell({ script: { ACCESS_ENABLED: c[0] } });
    var r = run(env);
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, c[1]); assert.strictEqual(r.accessEnabled, c[2]); assert.strictEqual(r.stopped, true);
    assert.strictEqual(r.settings.ACCESS_CONFIG, 'NOT_CHECKED'); assert.strictEqual(r.ledger.state, 'NOT_CHECKED'); assert.strictEqual(env.sheets.state.calls.length, 0);
  });
  var env = loadShell({ failRead: function (k) { return k === 'ACCESS_ENABLED'; } });
  var r = run(env);
  assert.strictEqual(r.code, 'ACCESS_STATE_UNKNOWN'); assert.strictEqual(env.sheets.state.calls.length, 0);
});

test('権限: 本人以外・空・active/effective不一致・許可リスト異常は fail closed（機微データを返さない、何も読まない）', function () {
  [
    function (e) { e.email = 'stranger@example.test'; e.effective = 'stranger@example.test'; },
    function (e) { e.email = ''; e.effective = ''; },
    function (e) { e.effective = 'other@example.test'; },
    function (e) { e.effective = ''; },
    function (e) { e.script.ACCESS_ADMIN_ACTORS = 'not json'; },
    function (e) { e.script.ACCESS_ADMIN_ACTORS = JSON.stringify({ 'owner@example.test': 'bad label!' }); }
  ].forEach(function (mut, i) {
    var env = loadShell(); mut(env);
    var r = run(env);
    assert.strictEqual(r.ok, false, 'case ' + i); assert.ok(/^(IDENTITY_UNAVAILABLE|NOT_AUTHORIZED|ACCOUNT_MISMATCH)$/.test(r.code), r.code);
    assert.strictEqual(r.stopped, true); assert.strictEqual(r.accessEnabled, 'NOT_CHECKED'); assert.strictEqual(r.settings.ACCESS_CONFIG, 'NOT_CHECKED');
    assert.strictEqual(r.credentials.SWITCHBOT_TOKEN, 'NOT_CHECKED'); assert.strictEqual(env.sheets.state.calls.length, 0);
  });
});

test('設定の欠落/不整合: 未設定と読取失敗を区別。本番以外・環境名不一致・設定不正・資格情報欠落を ok=false', function () {
  var miss = run(loadShell({ script: { ACCESS_CONFIG: '' }, user: {} }));
  assert.strictEqual(miss.ok, false); assert.strictEqual(miss.settings.ACCESS_CONFIG, 'MISSING');
  assert.deepStrictEqual(miss.credentials, { SWITCHBOT_TOKEN: 'MISSING', SWITCHBOT_SECRET: 'MISSING', WEBHOOK_SHARED_TOKEN: 'MISSING' });
  assert.ok(miss.failures.indexOf('SETTINGS_INCOMPLETE') !== -1 && miss.failures.indexOf('CREDENTIALS_INCOMPLETE') !== -1);

  var unk = run(loadShell({ failRead: function (k) { return k === 'ACCESS_CONFIG' || k === 'SWITCHBOT_SECRET'; } }));
  assert.strictEqual(unk.settings.ACCESS_CONFIG, 'UNKNOWN'); assert.strictEqual(unk.credentials.SWITCHBOT_SECRET, 'UNKNOWN'); assert.strictEqual(unk.ok, false);

  var ver = run(loadShell({ script: { ACCESS_ENVIRONMENT: 'verify', ACCESS_CONFIG: cfgJson({ environment: 'verify' }) } }));
  assert.strictEqual(ver.environment, 'NOT_PRODUCTION'); assert.ok(ver.failures.indexOf('ENV_NOT_PRODUCTION') !== -1);

  var mm = run(loadShell({ script: { ACCESS_CONFIG: cfgJson({ environment: 'verify' }) } }));
  assert.strictEqual(mm.config.envMatch, 'MISMATCH'); assert.strictEqual(mm.config.state, 'INVALID'); assert.strictEqual(mm.code === 'DIAGNOSTICS_OK', false);

  var bad = run(loadShell({ script: { ACCESS_CONFIG: cfgJson({ keypads: [{ deviceId: 'DEVICE00000099ZZ' }] }) } }));
  assert.strictEqual(bad.config.state, 'INVALID'); assert.deepStrictEqual(bad.config.errors, ['KEYPAD_NOT_ALLOWED_IN_ENV']); assert.strictEqual(bad.code, 'CONFIG_INVALID');

  assert.strictEqual(run(loadShell({ script: { ACCESS_CONFIG: '{not json' } })).config.state, 'PARSE_ERROR');
  assert.strictEqual(run(loadShell({ script: { ACCESS_CONFIG: '[1]' } })).config.state, 'NOT_OBJECT');
});

test('台帳: 参照不可（権限承認必要/文書権限なし/その他）を区別し、エラー本文・機微値は出さない', function () {
  [[{ code: 401, body: { error: { message: 'LEAK-ME-IN-ERROR' } } }, 'LEDGER_AUTH_REQUIRED'],
    [{ code: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'LEAK-ME-IN-ERROR' } } }, 'LEDGER_ACCESS_DENIED'],
    [{ code: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes. LEAK-ME-IN-ERROR', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } }, 'LEDGER_SCOPE_INCOMPATIBLE'],
    [{ code: 403, body: { error: { message: 'Google Sheets API has not been used in project 1 before or it is disabled. LEAK-ME-IN-ERROR', details: [{ reason: 'SERVICE_DISABLED' }] } } }, 'LEDGER_API_DISABLED'],
    [{ code: 404, body: 'LEAK-ME-IN-ERROR' }, 'LEDGER_NOT_FOUND'],
    [{ code: 429, body: 'LEAK-ME-IN-ERROR' }, 'LEDGER_RATE_LIMITED'],
    [{ code: 500, body: 'LEAK-ME-IN-ERROR ' + SECRETS.SWITCHBOT_TOKEN }, 'LEDGER_READ_FAILED'],
    [{ code: 200, body: 'not json LEAK-ME-IN-ERROR' }, 'LEDGER_READ_FAILED']].forEach(function (c) {
    var r = run(loadShell({ http: c[0] }));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.ledger.state, c[1]); assert.strictEqual(r.code, c[1]);
  });
  // fetch自体の例外（承認未了など）。本文は分類にだけ使い出さない
  [['Authorization is required to perform that action. LEAK-ME-IN-ERROR', 'LEDGER_AUTH_REQUIRED'],
    ['Specified permissions are not sufficient to call UrlFetchApp.fetch. Required permissions: https://www.googleapis.com/auth/script.external_request LEAK-ME-IN-ERROR', 'LEDGER_SCOPE_INCOMPATIBLE'],
    ['Something odd LEAK-ME-IN-ERROR ' + SECRETS.SWITCHBOT_TOKEN, 'LEDGER_READ_FAILED']].forEach(function (c) {
    var r = run(loadShell({ fetchThrow: c[0] }));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.ledger.state, c[1]); assert.strictEqual(r.code, c[1]);
  });
  var nos = run(loadShell({ noSheet: true }));
  assert.strictEqual(nos.ledger.state, 'LEDGER_SCHEMA_INVALID'); assert.strictEqual(nos.ledger.headers, 'SHEET_MISSING');
  var noId = run(loadShell({ script: { LEDGER_SPREADSHEET_ID: '' } }));
  assert.strictEqual(noId.ledger.state, 'LEDGER_ID_MISSING'); assert.strictEqual(noId.ok, false);
  var unkId = run(loadShell({ failRead: function (k) { return k === 'LEDGER_SPREADSHEET_ID'; } }));
  assert.strictEqual(unkId.ledger.state, 'LEDGER_READ_FAILED');
});

test('台帳: 列不足・重複列・列形式の改変は LEDGER_SCHEMA_INVALID。個人情報列は読まない（出力にも出ない）', function () {
  var miss = run(loadShell({ headers: HEADERS.filter(function (h) { return h !== 'revision'; }) }));
  assert.strictEqual(miss.ledger.state, 'LEDGER_SCHEMA_INVALID'); assert.strictEqual(miss.ledger.headers, 'MISSING'); assert.strictEqual(miss.code, 'LEDGER_SCHEMA_INVALID');
  var dup = run(loadShell({ headers: HEADERS.concat(['status']) }));
  assert.strictEqual(dup.ledger.headers, 'DUPLICATE'); assert.strictEqual(dup.ok, false);
  var fmt = run(loadShell({ rows: [row(), row({ startAt: 'not a date', bookingId: 'BOOKING-ID-SECRET-002' })] }));
  assert.strictEqual(fmt.ledger.state, 'LEDGER_SCHEMA_INVALID'); assert.strictEqual(fmt.ledger.columnFormat, 'INVALID'); assert.strictEqual(fmt.ledger.sampled, 2);
  var emptyRowOk = run(loadShell({ rows: [row({ bookingId: '', startAt: '', endAt: '' })] }));
  assert.strictEqual(emptyRowOk.ledger.state, 'LEDGER_ACCESS_OK');
  var noData = run(loadShell({ rows: [] }));
  assert.strictEqual(noData.ledger.state, 'LEDGER_ACCESS_OK'); assert.strictEqual(noData.ledger.columnFormat, 'NO_DATA');
});

test('読取例外（機微値入り）は握りつぶして固定コード。ストア列挙失敗は STORE_READ_FAILED', function () {
  var r = run(loadShell({ failKeys: true }));
  assert.strictEqual(r.ok, false); assert.strictEqual(r.store.state, 'STORE_READ_FAILED'); assert.strictEqual(r.code, 'STORE_READ_FAILED');
  var env = loadShell();
  env.ctx.sba_adminActors_ = function () { throw new Error('LEAK-ME-IN-ERROR ' + SECRETS.SWITCHBOT_SECRET); };
  var u = run(env);
  assert.strictEqual(u.ok, false); assert.strictEqual(u.code, 'UNEXPECTED_ERROR');
});

test('純粋ロジック: 出力はホワイトリスト化され、自由文・URL・IDは INVALID_VALUE に潰れる／読取手段なしの deps は fail closed', function () {
  var r = Infra.readOnlyDiagnostics({
    identity: function () { return { email: ADMIN, effectiveEmail: ADMIN }; }, adminActors: { 'owner@example.test': 'ADMIN-1' },
    accessFlag: function () { return null; },
    scriptProps: { get: function (k) { return k === 'ACCESS_CONFIG' ? cfgJson() : k === 'ACCESS_ENVIRONMENT' ? 'production' : 'v'; } },
    userProps: { get: function () { return 'v'; } },
    stateStore: { get: function () { return null; }, keys: function () { return []; } },
    ledgerInspect: function () { return { code: 'https://leak.example.test/x?id=1', headers: 'a b c', rows: 3 }; }
  });
  assert.strictEqual(r.ledger.state, 'INVALID_VALUE'); assert.strictEqual(r.ledger.headers, 'INVALID_VALUE'); assert.strictEqual(r.ok, false);
  assert.ok(JSON.stringify(r).indexOf('leak.example') === -1);
  var none = Infra.readOnlyDiagnostics({});
  assert.strictEqual(none.ok, false);
  assert.strictEqual(Infra.readOnlyDiagnostics({ identity: function () { return { email: ADMIN, effectiveEmail: ADMIN }; }, adminActors: { 'owner@example.test': 'A' } }).code, 'ACCESS_STATE_UNKNOWN');
});

test('静的確認: 診断の経路に書込み・ロック・通信・メール・トリガー・シート書込みの呼び出しが存在しない。台帳検査はスコープ変更不要', function () {
  var root = path.join(__dirname, '..', 'gas', 'switchbot-access');
  var infra = fs.readFileSync(path.join(root, 'SwitchBotAccessInfra.gs'), 'utf8');
  var diag = infra.slice(infra.indexOf('本番初期設定の読取専用診断（Issue #774）'), infra.indexOf('  return {\n    ENVIRONMENT: ENVIRONMENT'));
  var app = fs.readFileSync(path.join(root, 'SwitchBotAccessApp.gs'), 'utf8');
  var shell = app.slice(app.indexOf('function sba_readOnlyStore_'));
  var ledger = fs.readFileSync(path.join(root, 'AccessLedgerReader.gs'), 'utf8');
  var insp = ledger.slice(ledger.indexOf('var INSPECT_SAMPLE_ROWS'), ledger.indexOf('  return {', ledger.indexOf('function inspectSheet')));
  [diag, shell, insp].forEach(function (src) {
    assert.ok(!/setProperty|deleteProperty|setProperties|\.set\(|\.del\(|tryLock|waitLock|LockService|MailApp|UrlFetchApp|ScriptApp|setValue|appendRow|deleteRow|\.clear|accessAdminStatus|runLocked|\.admin\(/.test(src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')), 'forbidden call');
  });
  var m = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets') === -1);
  assert.strictEqual(Ledger.classifyError(new Error('x')), 'LEDGER_READ_FAILED');
});
