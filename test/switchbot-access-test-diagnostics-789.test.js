/*
 * Issue #789: verify環境専用の読取専用診断（accessTestReadOnlyDiagnostics）のテスト。
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
    environment: 'verify', allowedLast4: ['37DD'], keypads: [{ deviceId: 'DEVICE000000037DD' }],
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
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba789-'));
  prepare.prepareProject(out);
  var env = {
    script: Object.assign({ ACCESS_CONFIG: cfgJson(), ACCESS_ENVIRONMENT: 'verify', LEDGER_SPREADSHEET_ID: SHEET_ID,
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }), ACCESS_ENABLED: 'false' }, o.script || {}),
    user: Object.assign({}, 'user' in o ? o.user : {}),
    headers: o.headers || HEADERS, rows: o.rows || [row()], email: ADMIN, effective: ADMIN,
    logs: [], userReads: 0, writes: 0, fetches: 0, mails: 0, triggers: 0, locks: 0, sheetWrites: 0, opened: 0
  };
  function props(m) {
    return {
      getProperty: function (k) { if (o.failRead && o.failRead(k)) throw new Error('LEAK-ME-IN-ERROR ' + SECRETS.SWITCHBOT_TOKEN); if (m === env.user) env.userReads++; return m[k] === undefined ? null : m[k]; },
      setProperty: function () { env.writes++; }, deleteProperty: function () { env.writes++; }, setProperties: function () { env.writes++; }, deleteAllProperties: function () { env.writes++; },
      getKeys: function () { if (o.failKeys) throw new Error('LEAK-ME-IN-ERROR'); return Object.keys(m); }
    };
  }
  // 台帳は SpreadsheetApp ではなく Sheets API(REST) の GET で読む（#776）。SpreadsheetApp は使われたら権限エラーになる
  env.sheets = SheetsFake.create({ headers: env.headers, rows: env.rows, noSheet: o.noSheet, http: o.http || null, fetchThrow: o.fetchThrow, dateAs: o.dateAs, tz: o.tz });
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
  var r = plain(env.ctx.accessTestReadOnlyDiagnostics());
  assert.strictEqual(env.logs.length, 1, 'ログは固定JSON1行');
  assert.deepStrictEqual(JSON.parse(env.logs[0]), r);
  var all = env.logs.join('\n') + JSON.stringify(r);
  Object.keys(SECRETS).forEach(function (k) { assert.ok(all.indexOf(SECRETS[k]) === -1, 'leak ' + k); });
  LEAK_WORDS.concat([SHEET_ID, ADMIN, 'ADMIN-1', 'DEVICE000000037DD', 'DEVICE00000001FD', 'ops@example.test']).forEach(function (w) { assert.ok(all.indexOf(w) === -1, 'leak ' + w); });
  assert.deepStrictEqual([env.writes, env.fetches, env.mails, env.triggers, env.locks, env.sheets.state.writes], [0, 0, 0, 0, 0, 0], '副作用なし（書込み・SwitchBot通信・メール・トリガー・ロック・Sheets書込み）');
  assert.strictEqual(env.opened, 0, 'SpreadsheetApp は使わない（spreadsheets.readonly では呼べない）');
  env.sheets.state.calls.forEach(function (c) { assert.strictEqual(c.method, 'get'); assert.ok(c.auth, 'OAuthトークン付き'); assert.ok(/^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/[^/?]+(\/values.*|\?fields=.*)?$/.test(c.url), c.url); });
  assert.strictEqual(JSON.stringify([env.script, env.user]), snapshot, 'プロパティ不変');
  assert.strictEqual(env.userReads, 0, '資格情報（User Properties）は読まない');
  return r;
}

test('verify正常: ok=true・TEST_DIAGNOSTICS_OK。JST・必須14列・件数のみ。値は出さない', function () {
  var r = run(loadShell());
  assert.strictEqual(r.ok, true); assert.strictEqual(r.code, 'TEST_DIAGNOSTICS_OK'); assert.deepStrictEqual(r.failures, []);
  assert.strictEqual(r.identity, 'AUTHORIZED'); assert.strictEqual(r.accessEnabled, 'OFF'); assert.strictEqual(r.environment, 'VERIFY');
  assert.deepStrictEqual(r.config, { state: 'VALID', envMatch: 'MATCH', last4: 'MATCH', errors: [] });
  assert.strictEqual(r.ledger.state, 'LEDGER_ACCESS_OK'); assert.strictEqual(r.ledger.headers, 'COMPLETE'); assert.strictEqual(r.ledger.timezone, 'JST'); assert.strictEqual(r.ledger.rows, 1);
  assert.ok(r.notes.indexOf('NO_SWITCHBOT_API') !== -1);
});

test('空台帳（ヘッダーのみ）は許容。ledger.rows=0・columnFormat=NO_DATA', function () {
  var r = run(loadShell({ rows: [] }));
  assert.strictEqual(r.ok, true); assert.strictEqual(r.ledger.rows, 0); assert.strictEqual(r.ledger.columnFormat, 'NO_DATA'); assert.strictEqual(r.ledger.timezone, 'JST');
});

test('本番env拒否: ACCESS_ENVIRONMENT=production は ENV_NOT_VERIFY で停止し、台帳へ触れない', function () {
  var env = loadShell({ script: { ACCESS_ENVIRONMENT: 'production', ACCESS_CONFIG: cfgJson({ environment: 'production', allowedLast4: ['01FD'], keypads: [{ deviceId: 'DEVICE00000001FD' }] }) } });
  var r = run(env);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'ENV_NOT_VERIFY'); assert.strictEqual(r.environment, 'NOT_VERIFY'); assert.strictEqual(r.stopped, true);
  assert.strictEqual(env.sheets.state.calls.length, 0); assert.strictEqual(r.ledger.state, 'NOT_CHECKED');
});

test('ACCESS_CONFIG.environment が verify でない（ACCESS_ENVIRONMENTだけ verify）は拒否', function () {
  var env = loadShell({ script: { ACCESS_CONFIG: cfgJson({ environment: 'production' }) } });
  var r = run(env);
  assert.strictEqual(r.ok, false); assert.strictEqual(r.config.envMatch, 'MISMATCH'); assert.strictEqual(r.config.state, 'INVALID'); assert.strictEqual(env.sheets.state.calls.length, 0);
});

test('ACCESS_ENABLED: true は ACCESS_NOT_OFF、想定外値は ACCESS_STATE_UNKNOWN、未設定/空は明示OFFでないため拒否。台帳へ触れない', function () {
  [['true', 'ACCESS_NOT_OFF', 'ON'], ['TRUE', 'ACCESS_STATE_UNKNOWN', 'UNKNOWN'], ['1', 'ACCESS_STATE_UNKNOWN', 'UNKNOWN'], ['', 'ACCESS_FLAG_NOT_EXPLICIT_OFF', 'NOT_EXPLICIT']].forEach(function (c) {
    var env = loadShell({ script: { ACCESS_ENABLED: c[0] } });
    var r = run(env);
    assert.strictEqual(r.ok, false, c[0]); assert.strictEqual(r.code, c[1]); assert.strictEqual(r.accessEnabled, c[2]); assert.strictEqual(r.stopped, true);
    assert.strictEqual(r.settings.ACCESS_CONFIG, 'NOT_CHECKED'); assert.strictEqual(env.sheets.state.calls.length, 0);
  });
  var unset = loadShell(); delete unset.script.ACCESS_ENABLED;
  var r2 = run(unset);
  assert.strictEqual(r2.code, 'ACCESS_FLAG_NOT_EXPLICIT_OFF'); assert.strictEqual(unset.sheets.state.calls.length, 0);
  var rd = loadShell({ failRead: function (k) { return k === 'ACCESS_ENABLED'; } });
  assert.strictEqual(run(rd).code, 'ACCESS_STATE_UNKNOWN');
});

test('権限: 本人以外・空・active/effective不一致・許可リスト異常は fail closed。何も読まない', function () {
  [
    function (e) { e.email = 'stranger@example.test'; e.effective = 'stranger@example.test'; },
    function (e) { e.email = ''; e.effective = ''; },
    function (e) { e.effective = 'other@example.test'; },
    function (e) { e.script.ACCESS_ADMIN_ACTORS = 'not json'; }
  ].forEach(function (mut, i) {
    var env = loadShell(); mut(env);
    var r = run(env);
    assert.strictEqual(r.ok, false, 'case ' + i); assert.ok(/^(IDENTITY_UNAVAILABLE|NOT_AUTHORIZED|ACCOUNT_MISMATCH)$/.test(r.code), r.code);
    assert.strictEqual(r.stopped, true); assert.strictEqual(r.accessEnabled, 'NOT_CHECKED'); assert.strictEqual(env.sheets.state.calls.length, 0);
  });
});

test('末尾4桁: 01FD の混入（allowedLast4/keypads）は LAST4_FORBIDDEN、37DD 以外は LAST4_MISMATCH。台帳へ触れない', function () {
  var cases = [
    [{ allowedLast4: ['37DD', '01FD'] }, 'LAST4_FORBIDDEN'],
    [{ allowedLast4: ['37DD', '01FD'], keypads: [{ deviceId: 'DEVICE000000037DD' }, { deviceId: 'DEVICE00000001FD' }] }, 'LAST4_FORBIDDEN'],
    [{ allowedLast4: ['37dd', 'ABCD'], keypads: [{ deviceId: 'DEVICE000000037DD' }, { deviceId: 'DEVICE0000000ABCD' }] }, 'LAST4_MISMATCH'],
    [{ allowedLast4: ['ABCD'], keypads: [{ deviceId: 'DEVICE0000000ABCD' }] }, 'LAST4_MISMATCH']
  ];
  cases.forEach(function (c) {
    var env = loadShell({ script: { ACCESS_CONFIG: cfgJson(c[0]) } });
    var r = run(env);
    assert.strictEqual(r.ok, false); assert.ok(r.failures.indexOf(c[1]) !== -1, JSON.stringify(r.failures)); assert.strictEqual(env.sheets.state.calls.length, 0);
  });
  var lower = run(loadShell({ script: { ACCESS_CONFIG: cfgJson({ allowedLast4: ['37dd'], keypads: [{ deviceId: 'device000000037dd' }] }) } }));
  assert.strictEqual(lower.config.last4, 'MATCH');
});

test('設定欠落/不正: 欠落・パース不能・オブジェクトでない は固定コードで拒否', function () {
  var miss = run(loadShell({ script: { ACCESS_CONFIG: '' } }));
  assert.strictEqual(miss.ok, false); assert.strictEqual(miss.settings.ACCESS_CONFIG, 'MISSING'); assert.ok(miss.failures.indexOf('SETTINGS_INCOMPLETE') !== -1);
  assert.strictEqual(run(loadShell({ script: { ACCESS_CONFIG: '{not json' } })).config.state, 'PARSE_ERROR');
  assert.strictEqual(run(loadShell({ script: { ACCESS_CONFIG: '[1]' } })).config.state, 'NOT_OBJECT');
  assert.strictEqual(run(loadShell({ script: { LEDGER_SPREADSHEET_ID: '' } })).ok, false);
  assert.strictEqual(run(loadShell({ script: { ACCESS_ENVIRONMENT: '' } })).ok, false);
});

test('台帳列欠落・重複列・Bookingsシートなしは LEDGER_SCHEMA_INVALID', function () {
  var miss = run(loadShell({ headers: HEADERS.filter(function (h) { return h !== 'revision'; }) }));
  assert.strictEqual(miss.ledger.state, 'LEDGER_SCHEMA_INVALID'); assert.strictEqual(miss.ledger.headers, 'MISSING'); assert.strictEqual(miss.code, 'LEDGER_SCHEMA_INVALID'); assert.strictEqual(miss.ledger.timezone, 'NOT_CHECKED');
  assert.strictEqual(run(loadShell({ headers: HEADERS.concat(['status']) })).ledger.headers, 'DUPLICATE');
  var nos = run(loadShell({ noSheet: true }));
  assert.strictEqual(nos.ledger.state, 'LEDGER_SCHEMA_INVALID'); assert.strictEqual(nos.ledger.headers, 'SHEET_MISSING');
});

test('台帳タイムゾーン: JST以外は LEDGER_TIMEZONE_UNSUPPORTED（値は出さず NOT_JST）', function () {
  [['UTC', 'NOT_JST'], ['America/New_York', 'NOT_JST']].forEach(function (c) {
    var r = run(loadShell({ tz: c[0] }));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.code, 'LEDGER_TIMEZONE_UNSUPPORTED'); assert.strictEqual(r.ledger.timezone, c[1]);
    assert.ok(JSON.stringify(r).indexOf(c[0]) === -1);
  });
});

test('アクセス権なし・API無効・未発見・承認未了などは固定コード。例外本文・秘密は出さない', function () {
  [[{ code: 401, body: 'LEAK-ME-IN-ERROR' }, 'LEDGER_AUTH_REQUIRED'],
    [{ code: 403, body: { error: { status: 'PERMISSION_DENIED', message: 'LEAK-ME-IN-ERROR' } } }, 'LEDGER_ACCESS_DENIED'],
    [{ code: 403, body: { error: { message: 'insufficient authentication scopes LEAK-ME-IN-ERROR', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } } }, 'LEDGER_SCOPE_INCOMPATIBLE'],
    [{ code: 403, body: { error: { message: 'API has not been used in project LEAK-ME-IN-ERROR', details: [{ reason: 'SERVICE_DISABLED' }] } } }, 'LEDGER_API_DISABLED'],
    [{ code: 404, body: 'LEAK-ME-IN-ERROR' }, 'LEDGER_NOT_FOUND'],
    [{ code: 500, body: 'LEAK-ME-IN-ERROR ' + SECRETS.SWITCHBOT_TOKEN }, 'LEDGER_READ_FAILED']].forEach(function (c) {
    var r = run(loadShell({ http: c[0] }));
    assert.strictEqual(r.ok, false); assert.strictEqual(r.ledger.state, c[1]); assert.strictEqual(r.code, c[1]);
  });
  var r2 = run(loadShell({ fetchThrow: 'Authorization is required to perform that action. LEAK-ME-IN-ERROR ' + SECRETS.SWITCHBOT_SECRET }));
  assert.strictEqual(r2.ledger.state, 'LEDGER_AUTH_REQUIRED');
});

test('ログ漏洩防止: 予約内容・ID・メール・完全deviceId・例外原文は出ない。例外は UNEXPECTED_ERROR', function () {
  var env = loadShell({ rows: [row(), row({ bookingId: 'BOOKING-ID-SECRET-002' })] });
  var r = run(env);
  assert.strictEqual(r.ok, true);
  var env2 = loadShell();
  env2.ctx.sba_adminActors_ = function () { throw new Error('LEAK-ME-IN-ERROR ' + SECRETS.SWITCHBOT_SECRET); };
  var u = run(env2);
  assert.strictEqual(u.ok, false); assert.strictEqual(u.code, 'UNEXPECTED_ERROR');
});

test('純粋ロジック: 出力はホワイトリスト化。自由文・URLは INVALID_VALUE／deps不足は fail closed', function () {
  var r = Infra.testReadOnlyDiagnostics({
    identity: function () { return { email: ADMIN, effectiveEmail: ADMIN }; }, adminActors: { 'owner@example.test': 'ADMIN-1' },
    accessFlag: function () { return 'false'; },
    scriptProps: { get: function (k) { return k === 'ACCESS_CONFIG' ? cfgJson() : k === 'ACCESS_ENVIRONMENT' ? 'verify' : 'v'; } },
    ledgerInspect: function () { return { code: 'https://leak.example.test/x?id=1', headers: 'a b c', rows: 3 }; }
  });
  assert.strictEqual(r.ledger.state, 'INVALID_VALUE'); assert.strictEqual(r.ok, false); assert.ok(JSON.stringify(r).indexOf('leak.example') === -1);
  assert.strictEqual(Infra.testReadOnlyDiagnostics({}).ok, false);
});

test('回帰: 本番診断 accessReadOnlyDiagnostics は verify を従来どおり ENV_NOT_PRODUCTION で拒否し、検証用の基準を取り込まない', function () {
  var env = loadShell();
  var r = plain(env.ctx.accessReadOnlyDiagnostics());
  assert.strictEqual(r.ok, false); assert.ok(r.failures.indexOf('ENV_NOT_PRODUCTION') !== -1);
  assert.strictEqual(r.environment, 'NOT_PRODUCTION');
  assert.strictEqual(typeof Infra.readOnlyDiagnostics, 'function');
  assert.strictEqual(Ledger.inspectSheet(null).code, 'LEDGER_SCHEMA_INVALID');
  assert.strictEqual(Ledger.inspectSheet(null).timezone, undefined, '共通のinspectSheetの戻り値は不変');
});

test('静的確認: 検証用診断に書込み・ロック・通信・メール・トリガー・資格情報読取・本番設定値が存在しない。スコープ不変', function () {
  var root = path.join(__dirname, '..', 'gas', 'switchbot-access');
  var strip = function (s) { return s.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); };
  var infra = fs.readFileSync(path.join(root, 'SwitchBotAccessInfra.gs'), 'utf8');
  var diag = strip(infra.slice(infra.indexOf('function testReadOnlyDiagnostics'), infra.indexOf('  return {\n    ENVIRONMENT: ENVIRONMENT')));
  var app = fs.readFileSync(path.join(root, 'SwitchBotAccessApp.gs'), 'utf8');
  var shell = strip(app.slice(app.indexOf('function sba_ledgerInspectTest_')));
  var ledger = fs.readFileSync(path.join(root, 'AccessLedgerReader.gs'), 'utf8');
  var insp = strip(ledger.slice(ledger.indexOf('function inspectTestSheet'), ledger.indexOf('  return { SHEET_NAME')));
  [diag, shell, insp].forEach(function (src) {
    assert.ok(!/setProperty|deleteProperty|setProperties|\.set\(|\.del\(|tryLock|waitLock|LockService|MailApp|UrlFetchApp|ScriptApp|setValue|appendRow|deleteRow|\.clear|runLocked|\.admin\(|sba_userProps_|userProps|stateStore|sba_stateStore_/.test(src), 'forbidden call');
  });
  assert.ok(!/ENVIRONMENT\.PRODUCTION|'production'|01FD/.test(diag.replace(/TEST_FORBIDDEN_LAST4 = \['01FD'\]/, '')), '本番値を診断経路で使わない');
  var m = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets') === -1);
});
