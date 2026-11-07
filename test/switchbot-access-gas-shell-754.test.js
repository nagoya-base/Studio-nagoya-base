/*
 * Issue #754: 独立GASのシェル（doPost/トリガー/アダプター）・台帳リーダー・配布物のテスト。
 * 実GAS・実API・実Spreadsheetには接続せず、GASサービスはフェイクをvmへ注入して実ファイルを実行する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var vm = require('vm');
var crypto = require('node:crypto');
var prepare = require('../scripts/prepare-switchbot-access-gas-project');
var H = require('./helpers/switchbot-access-world');
var SheetsFake = require('./helpers/sheets-rest-fake');

var ROOT = path.resolve(__dirname, '..');
var PW_RE = /\b[0-9]{8}\b/;
var TOKEN = 'W'.repeat(32);

function bookingHeaders() {
  var ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/booking/shared/BookingsSchema.gs'), 'utf8'), ctx);
  return Array.from(ctx.BookingsSchema.HEADERS);
}

/** バンドル配布物（prepare の出力順）をそのままvmへ読み込み、GASサービスのフェイクを注入する。 */
function loadShell(opts) {
  opts = opts || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-'));
  prepare.prepareProject(out);
  var headers = bookingHeaders();
  var env = {
    script: Object.assign({}, opts.script || {}), user: Object.assign({}, opts.user || {}),
    mails: [], fetches: [], logs: [], triggers: [], deleted: [], readCols: [], keys: [], seq: 500,
    email: 'owner@example.test', locked: false, rows: opts.rows || []
  };
  function props(m) {
    return { getProperty: function (k) { return m[k] === undefined ? null : m[k]; }, setProperty: function (k, v) { m[k] = String(v); },
      deleteProperty: function (k) { delete m[k]; }, getKeys: function () { return Object.keys(m); } };
  }
  // 台帳は Sheets API(REST) の GET で読む（#776）。テスト中に env.rows を差し替えても反映されるよう、行は getter で参照する
  var sheetState = { headers: headers };
  Object.defineProperty(sheetState, 'rows', { get: function () { return env.rows; } });
  env.sheets = SheetsFake.create(sheetState);
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(env.script); }, getUserProperties: function () { return props(env.user); } },
    LockService: { getScriptLock: function () { return { tryLock: function () { if (env.locked) return false; env.locked = true; return true; }, releaseLock: function () { env.locked = false; } }; } },
    Utilities: {
      base64Encode: function (b) { return Buffer.from(b).toString('base64'); },
      computeHmacSha256Signature: function (msg, secret) { return Array.from(crypto.createHmac('sha256', secret).update(msg).digest()); },
      getUuid: function () { return crypto.randomUUID(); },
      computeDigest: function (alg, s) { return Array.from(crypto.createHash('sha256').update(s).digest()).map(function (b) { return b > 127 ? b - 256 : b; }); },
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }
    },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: function (t) { return { text: t, setMimeType: function () { return this; } }; } },
    MailApp: { sendEmail: function (to, subject, body) { env.mails.push({ to: to, subject: subject, body: body }); } },
    // spreadsheets.readonly では SpreadsheetApp.openById は呼べない。使われたら権限エラーにして、使用を検知する
    SpreadsheetApp: { openById: function () { env.spreadsheetAppCalls = (env.spreadsheetAppCalls || 0) + 1; throw new Error('You do not have permission to call SpreadsheetApp.openById. Required permissions: https://www.googleapis.com/auth/spreadsheets'); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return env.email; } }; } },
    ScriptApp: {
      getOAuthToken: function () { return 'dummy-oauth-token'; },
      getProjectTriggers: function () { return env.triggers.slice(); },
      deleteTrigger: function (t) { env.triggers = env.triggers.filter(function (x) { return x !== t; }); env.deleted.push(t.fn); },
      newTrigger: function (fn) { var t = { fn: fn, getHandlerFunction: function () { return fn; } }; return { timeBased: function () { return { everyMinutes: function (m) { t.every = m + 'm'; return this; }, everyHours: function (h) { t.every = h + 'h'; return this; }, create: function () { env.triggers.push(t); return t; } }; } }; }
    },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    UrlFetchApp: {
      fetch: function (url, options) {
        if (/^https:\/\/sheets\.googleapis\.com\//.test(url)) return env.sheets.fetch(url, options);
        env.fetches.push({ url: url, options: options });
        function res(code, body) { return { getResponseCode: function () { return code; }, getContentText: function () { return JSON.stringify(body); } }; }
        if (options.method === 'get') {
          return res(200, { statusCode: 100, body: { deviceList: [{ deviceId: H.DEV, deviceType: 'Keypad', keyList: env.keys.map(function (k) { return Object.assign({}, k); }) }] } });
        }
        var p = JSON.parse(options.payload);
        env.seq++;
        if (p.command === 'createKey') env.keys.push({ id: String(env.seq), name: p.parameter.name, type: 'timeLimit', startTime: p.parameter.startTime, endTime: p.parameter.endTime });
        else env.keys = env.keys.filter(function (k) { return k.id !== String(p.parameter.id); });
        env.lastPayload = p;
        return res(200, { statusCode: 100, body: { commandId: 'CMD' + env.seq } });
      }
    }
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) {
    vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n });
  });
  env.ctx = ctx; env.headers = headers; env.dir = out;
  return env;
}

function cfgJson(over) {
  var c = H.baseCfg(over);
  delete c.enabled;
  return JSON.stringify(c);
}

function configured(extra) {
  return loadShell(Object.assign({
    script: {
      ACCESS_CONFIG: cfgJson(), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true', LEDGER_SPREADSHEET_ID: 'ss-test',
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' })
    },
    user: { SWITCHBOT_TOKEN: 'tok-test', SWITCHBOT_SECRET: 'sec-test', WEBHOOK_SHARED_TOKEN: TOKEN }
  }, extra || {}));
}

function ledgerRow(over) {
  return Object.assign({
    bookingId: 'SNB-1', startAt: new Date('2030-01-11T10:00:00+09:00'), endAt: new Date('2030-01-11T12:00:00+09:00'), brand: 'snb',
    name: 'PII-NAME', email: 'pii@example.test', phone: '090-0000-0000', purpose: 'PII-PURPOSE', people: '3名',
    paymentMethod: 'オンラインクレジットカード', status: 'CONFIRMED', paymentStatus: 'paid',
    paymentConfirmedAt: new Date('2030-01-05T10:05:00+09:00'), confirmedAt: new Date('2030-01-05T10:05:00+09:00'), revision: 1
  }, over || {});
}

function setNow(env, iso) {
  var t = Date.parse(iso);
  env.ctx.Date = class extends Date { constructor() { if (arguments.length) super(...arguments); else super(t); } static now() { return t; } };
  env.now = t;
}

// ================================================================ 配布物

test('配布物: 6ファイルを決まった順で組み立て、デプロイは行わない。1つのvmコンテキストで衝突なく読める', function () {
  assert.deepStrictEqual(prepare.fileNames(), ['SwitchBotAccessCore.gs', 'AccessKeySnapshot.gs', 'AccessLedgerReader.gs', 'SwitchBotAccessInfra.gs', 'SwitchBotAccessApp.gs', 'appsscript.json']);
  var env = loadShell();
  ['doPost', 'doGet', 'accessSyncJob', 'accessSweepJob', 'accessWatchdogJob', 'accessDeliverJob', 'accessInstallTriggers', 'accessRemoveTriggers',
    'accessAdminStatus', 'accessAdminDelete', 'accessAdminResolveUnknown', 'accessCheckSetup'].forEach(function (f) {
    assert.strictEqual(typeof env.ctx[f], 'function', f);
  });
  assert.ok(!fs.readdirSync(env.dir).some(function (f) { return /clasp|\.env|token/i.test(f); }));
});

test('マニフェスト: 台帳は読み取り専用スコープ、Webアプリは実行者権限・匿名到達（共有トークンで認証）', function () {
  var m = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/appsscript.json'), 'utf8'));
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets.readonly') !== -1);
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets') === -1, '書込みスコープなし');
  assert.strictEqual(m.webapp.executeAs, 'USER_DEPLOYING');
  assert.strictEqual(m.timeZone, 'Asia/Tokyo');
});

test('ソース静的検査: 外部通信先はSwitchBot APIのみ、資格情報・トークン等の埋め込みなし', function () {
  ['SwitchBotAccessApp.gs', 'SwitchBotAccessInfra.gs', 'AccessLedgerReader.gs'].forEach(function (f) {
    var src = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access', f), 'utf8');
    var urls = (src.match(/https?:\/\/[^\s'")]+/g) || []).filter(function (u) { return !/googleapis\.com\/auth|example/.test(u); });
    // 外部通信先は SwitchBot API と、台帳の読取専用 Sheets API(v4) のみ
    urls.forEach(function (u) { assert.ok(/^https:\/\/api\.switch-bot\.com$/.test(u) || /^https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\/$/.test(u), f + ': ' + u); });
    assert.ok(!/[A-Fa-f0-9]{32,}/.test(src), f + ' に長い16進列（秘密の疑い）');
  });
});

// ================================================================ 台帳リーダー

test('台帳リーダー: 読む列は鍵連携に必要な最小限で、すべて現行スキーマに存在する（個人情報列は読まない）', function () {
  var env = configured();
  var R = env.ctx.AccessLedgerReader;
  var headers = bookingHeaders();
  R.REQUIRED_COLUMNS.forEach(function (c) { assert.ok(headers.indexOf(c) !== -1, c + ' が BookingsSchema に無い'); });
  ['name', 'email', 'phone', 'purpose', 'people'].forEach(function (c) { assert.ok(R.REQUIRED_COLUMNS.indexOf(c) === -1, c + ' は読まない'); });
  env.rows = [ledgerRow()];
  var r = R.readFromSheet(env.ctx.sba_openLedgerSheet_('x'), Date.parse('2030-01-10T13:00:00+09:00'), []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.records.length, 1);
  var readCols = env.sheets.state.readCols; assert.ok(readCols.length > 0);
  assert.ok(readCols.every(function (c) { return R.REQUIRED_COLUMNS.indexOf(c) !== -1; }), '読んだ列: ' + readCols.join(','));
  assert.ok(!env.spreadsheetAppCalls, 'SpreadsheetApp は使わない');
  assert.ok(!JSON.stringify(r).match(/PII-|pii@|090-/));
});

test('台帳リーダー: revision列の欠落は LEDGER_SCHEMA_INVALID（migration前に動かさない）', function () {
  var env = configured();
  var R = env.ctx.AccessLedgerReader;
  var chk = R.checkHeaders(bookingHeaders().filter(function (h) { return h !== 'revision'; }));
  assert.deepStrictEqual({ ok: chk.ok, error: chk.error, missing: Array.from(chk.missing) }, { ok: false, error: 'LEDGER_SCHEMA_INVALID', missing: ['revision'] });
});

test('台帳リーダー: 当日・翌日(JST)のSNB ∪ 鍵操作記録のある予約。日付境界は0:00 JST', function () {
  var env = configured();
  var R = env.ctx.AccessLedgerReader;
  function col(rows) {
    var c = {};
    R.REQUIRED_COLUMNS.forEach(function (k) { c[k] = rows.map(function (r) { return r[k]; }); });
    return c;
  }
  var now = Date.parse('2030-01-10T23:59:00+09:00');
  var rows = [
    ledgerRow({ bookingId: 'TODAY', startAt: new Date('2030-01-10T00:00:00+09:00') }),
    ledgerRow({ bookingId: 'TOMORROW', startAt: new Date('2030-01-11T23:30:00+09:00') }),
    ledgerRow({ bookingId: 'DAY3', startAt: new Date('2030-01-12T00:00:00+09:00') }),
    ledgerRow({ bookingId: 'YESTERDAY', startAt: new Date('2030-01-09T23:59:00+09:00') }),
    ledgerRow({ bookingId: 'OTHERBRAND', brand: 'studio-x' }),
    ledgerRow({ bookingId: 'BADTIME', startAt: 'garbage' }),
    ledgerRow({ bookingId: 'MOVED', startAt: new Date('2030-02-01T10:00:00+09:00') }),
    ledgerRow({ bookingId: '' })
  ];
  var ids = Array.from(R.select(col(rows), now, []).map(function (r) { return r.bookingId; }));
  assert.deepStrictEqual(ids, ['TODAY', 'TOMORROW', 'BADTIME']);
  ids = Array.from(R.select(col(rows), now, ['MOVED', 'OTHERBRAND']).map(function (r) { return r.bookingId; }));
  assert.deepStrictEqual(ids.sort(), ['BADTIME', 'MOVED', 'OTHERBRAND', 'TODAY', 'TOMORROW']);
});

test('Booking shim: カード判定の文字列は予約GASの定義と一致する（ドリフト検知）', function () {
  var src = fs.readFileSync(path.join(ROOT, 'gas/booking/shared/Booking.gs'), 'utf8');
  var m = /PAYMENT_METHOD_CARD\s*=\s*'([^']+)'/.exec(src);
  var env = configured();
  assert.ok(m);
  assert.strictEqual(env.ctx.Booking.isCardPaymentMethod(m[1]), true);
  assert.strictEqual(env.ctx.Booking.isCardPaymentMethod('現金'), false);
});

// ================================================================ doPost / 認証

test('doPost: 未認証は {"ok":false}。状態も外部通信も発生しない', function () {
  var env = configured();
  var before = JSON.stringify(env.script);
  var out = env.ctx.doPost({ parameter: { t: 'wrong' }, postData: { contents: H.webhook({ commandId: 'C9' }) } });
  assert.strictEqual(out.text, '{"ok":false}');
  assert.strictEqual(env.ctx.doPost({ parameter: {}, postData: { contents: '{}' } }).text, '{"ok":false}');
  assert.strictEqual(env.ctx.doPost(undefined).text, '{"ok":false}');
  assert.strictEqual(JSON.stringify(env.script), before);
  assert.strictEqual(env.fetches.length, 0);
});

test('doPost: 設定なしでも例外を出さず固定応答。認証通過でも進行中でないイベントは保存しない', function () {
  var bare = loadShell({ user: { WEBHOOK_SHARED_TOKEN: TOKEN } });
  assert.strictEqual(bare.ctx.doPost({ parameter: { t: TOKEN }, postData: { contents: H.webhook() } }).text, '{"ok":false}');
  var env = configured();
  var out = env.ctx.doPost({ parameter: { t: TOKEN }, postData: { contents: H.webhook({ commandId: 'NOT-OPEN' }) } });
  assert.strictEqual(out.text, '{"ok":false}');
  assert.deepStrictEqual(Object.keys(env.script).filter(function (k) { return /^(EVT_|INBOX_)/.test(k); }), []);
  assert.strictEqual(env.ctx.doGet().text, '{"ok":true}');
});

// ================================================================ 結線（フェイクGASサービス）

test('結線: トリガー関数が台帳(最小列)を読み、署名付きAPIで発行し、秘密はUser Properties・状態はScript Propertiesに分かれる', function () {
  var env = configured({ rows: [ledgerRow()] });
  setNow(env, '2030-01-10T13:00:00+09:00');
  env.ctx.accessSyncJob();                       // 観測
  setNow(env, '2030-01-10T13:05:00+09:00');
  var r = env.ctx.accessSyncJob();               // 発行
  assert.strictEqual(r.ok !== false, true, JSON.stringify(r));
  var posts = env.fetches.filter(function (f) { return f.options.method === 'post'; });
  assert.strictEqual(posts.length, 1);
  var h = posts[0].options.headers;
  assert.ok(h.Authorization === 'tok-test' && /^[A-Z0-9+/=]+$/.test(h.sign) && h.nonce && h.t, '署名ヘッダ');
  assert.ok(/^https:\/\/api\.switch-bot\.com\/v1\.1\/devices\/AAAAAAAAAAAA01FD\/commands$/.test(posts[0].url));
  assert.strictEqual(env.lastPayload.parameter.type, 'timeLimit');
  var pw = env.lastPayload.parameter.password;
  assert.ok(/^[0-9]{8}$/.test(pw));
  // 保存先の分離
  assert.ok(Object.keys(env.user).some(function (k) { return k.indexOf('SECRET_') === 0; }), 'パスコードはUser Properties');
  assert.ok(!Object.keys(env.script).some(function (k) { return k.indexOf('SECRET_') === 0; }));
  var scriptDump = JSON.stringify(env.script);
  assert.ok(scriptDump.indexOf(pw) === -1 && scriptDump.indexOf('tok-test') === -1 && scriptDump.indexOf('sec-test') === -1 && scriptDump.indexOf(TOKEN) === -1);
  assert.ok(Object.keys(env.script).some(function (k) { return k.indexOf('OP_') === 0; }), '状態はScript Properties');
  // 台帳は必要列のみ読む
  var rc = env.sheets.state.readCols || []; assert.ok(rc.length > 0 && rc.indexOf('name') === -1 && rc.indexOf('email') === -1);
  assert.ok(env.logs.join('').indexOf(pw) === -1);
  // Webhook（認証済み・進行中のcommandId）→ 次の照合で確認
  var opKey = Object.keys(env.script).filter(function (k) { return k.indexOf('OP_') === 0; })[0];
  var op = JSON.parse(env.script[opKey]);
  setNow(env, '2030-01-10T13:05:10+09:00');
  var hook = env.ctx.doPost({ parameter: { t: TOKEN }, postData: { contents: H.webhook({ commandId: op.commandId }) } });
  assert.strictEqual(hook.text, '{"ok":true}');
  setNow(env, '2030-01-10T13:10:00+09:00');
  env.ctx.accessSyncJob();
  assert.strictEqual(JSON.parse(env.script[opKey]).state, 'ISSUED_CONFIRMED');
});

test('結線: フラグ(ACCESS_ENABLED)が true 以外ならAPI・台帳に触れない。設定JSON内のenabledは無視', function () {
  var env = configured({ rows: [ledgerRow()] });
  env.script.ACCESS_ENABLED = 'TRUE';
  env.script.ACCESS_CONFIG = JSON.stringify(Object.assign(JSON.parse(env.script.ACCESS_CONFIG), { enabled: true }));
  setNow(env, '2030-01-10T13:00:00+09:00');
  assert.strictEqual(env.ctx.accessSyncJob().skipped, 'FLAG_OFF');
  assert.strictEqual(env.fetches.length, 0);
  assert.strictEqual(env.readCols.length, 0);
});

test('結線: ACCESS_ENVIRONMENT と設定の environment が食い違えば停止', function () {
  var env = configured({ rows: [ledgerRow()] });
  env.script.ACCESS_ENVIRONMENT = 'verify';
  setNow(env, '2030-01-10T13:00:00+09:00');
  assert.strictEqual(env.ctx.accessSyncJob().error, 'CONFIG_INVALID');
  assert.strictEqual(env.fetches.length, 0);
});

test('トリガー設置・撤去は許可された管理者のみ。既存の同名トリガーを置換し、状態は消さない', function () {
  var env = configured();
  env.email = 'stranger@example.test';
  assert.throws(function () { env.ctx.accessInstallTriggers(); }, /NOT_AUTHORIZED/);
  assert.strictEqual(env.triggers.length, 0);
  env.email = '';
  assert.throws(function () { env.ctx.accessInstallTriggers(); }, /NOT_AUTHORIZED/);
  env.email = 'owner@example.test';
  env.script.OP_KEEP = '{}';
  env.ctx.accessInstallTriggers();
  env.ctx.accessInstallTriggers();
  assert.deepStrictEqual(env.triggers.map(function (t) { return t.fn; }).sort(), ['accessSweepJob', 'accessSyncJob', 'accessWatchdogJob']);
  assert.strictEqual(env.triggers.find(function (t) { return t.fn === 'accessSyncJob'; }).every, '5m');
  env.ctx.accessRemoveTriggers();
  assert.strictEqual(env.triggers.length, 0);
  assert.strictEqual(env.script.OP_KEEP, '{}');
});

test('管理者関数: 実行者はSessionから確定。未許可は拒否。actor引数は存在しない', function () {
  var env = configured();
  assert.strictEqual(env.ctx.accessAdminStatus().ok, true);
  env.email = 'stranger@example.test';
  assert.strictEqual(env.ctx.accessAdminStatus().error, 'NOT_AUTHORIZED');
  assert.strictEqual(env.ctx.accessAdminDelete('X').error, 'NOT_AUTHORIZED');
  assert.strictEqual(env.ctx.accessAdminDelete.length, 1);
  assert.strictEqual(env.ctx.accessAdminResolveUnknown.length, 2);
});

test('accessAdminStatus（#822）: 許可項目だけをログに出し、戻り値は維持。未許可は固定コードのみ', function () {
  var env = configured();
  var r = env.ctx.accessAdminStatus();
  assert.strictEqual(r.ok, true);
  assert.ok(r.plan && r.storage, '戻り値は従来どおり');
  var line = env.logs.filter(function (l) { return l.indexOf('accessAdminStatus ') === 0; })[0];
  assert.ok(line, 'ログ出力がある');
  var j = JSON.parse(line.slice('accessAdminStatus '.length));
  assert.deepStrictEqual(Object.keys(j).sort(), ['deliveries', 'enabled', 'environment', 'heartbeatAt', 'notifyOutboxPending', 'ok', 'triggers', 'unresolved']);
  assert.strictEqual(j.environment, 'production');
  assert.ok(!/tok-test|sec-test|owner@example|ADMIN-1|storage|plan|apiCalls/.test(line));
  env.email = 'stranger@example.test';
  env.logs.length = 0;
  assert.strictEqual(env.ctx.accessAdminStatus().error, 'NOT_AUTHORIZED');
  assert.strictEqual(env.logs.join('\n'), 'accessAdminStatus {"ok":false,"error":"NOT_AUTHORIZED"}');
});

test('事前チェック: 値は出さず SET/MISSING のみ', function () {
  var env = configured();
  var out = env.ctx.accessCheckSetup();
  assert.strictEqual(out.SWITCHBOT_TOKEN, 'SET');
  assert.strictEqual(out.ACCESS_ENABLED, 'ON');
  var log = env.logs.join('\n');
  assert.ok(!/tok-test|sec-test|W{32}|owner@example/.test(log));
  var bare = loadShell();
  assert.strictEqual(bare.ctx.accessCheckSetup().SWITCHBOT_TOKEN, 'MISSING');
});

test('資格情報なしのAPI呼び出しは通信を行わずエラー（読取は fail-closed）', function () {
  var env = configured({ user: { WEBHOOK_SHARED_TOKEN: TOKEN }, rows: [ledgerRow()] });
  setNow(env, '2030-01-10T13:00:00+09:00'); env.ctx.accessSyncJob();
  setNow(env, '2030-01-10T13:05:00+09:00'); env.ctx.accessSyncJob();
  assert.strictEqual(env.fetches.length, 0);
  assert.ok(!Object.keys(env.script).some(function (k) { return k.indexOf('OP_') === 0 && /SENDING|SENT/.test(env.script[k]); }), '送信段階へ進まない');
});
