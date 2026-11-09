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
      newTrigger: function (fn) { var t = { fn: fn, getHandlerFunction: function () { return fn; } }; return { timeBased: function () { return { atHour: function (h) { t.atHour = h; return this; }, nearMinute: function (m) { t.nearMinute = m; return this; }, everyDays: function (d) { t.every = d + 'd'; return this; }, inTimezone: function (z) { t.tz = z; return this; }, everyMinutes: function (m) { t.every = m + 'm'; return this; }, everyHours: function (h) { t.every = h + 'h'; return this; }, create: function () { env.triggers.push(t); return t; } }; } }; }
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
  assert.deepStrictEqual(env.triggers.map(function (t) { return t.fn; }).sort(), ['accessDailyCleanupJob', 'accessSweepJob', 'accessSyncJob', 'accessWatchdogJob']);
  assert.strictEqual(env.triggers.find(function (t) { return t.fn === 'accessSyncJob'; }).every, '5m');
  // #829: 日次クリーンアップは 00:15 JST 近辺・1日1回。再設置しても重複しない（上の deepStrictEqual で1本ずつを確認済み）
  var daily = env.triggers.find(function (t) { return t.fn === 'accessDailyCleanupJob'; });
  assert.deepStrictEqual([daily.atHour, daily.nearMinute, daily.every, daily.tz], [0, 15, '1d', 'Asia/Tokyo']);
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

// ================================================================ #857 棚卸しの安全な集計診断

var INV_KEYS_857 = ['byDelivery', 'byState', 'diagnosis', 'environment', 'invalid', 'ok', 'scanned', 'scope', 'stages', 'total', 'truncated', 'unresolved'];
function invLine857(env) {
  var lines = env.logs.filter(function (l) { return l.indexOf('accessAdminInventorySummary ') === 0; });
  assert.strictEqual(lines.length, 1, '実行ログは1行');
  return { raw: lines[0], j: JSON.parse(lines[0].slice('accessAdminInventorySummary '.length)) };
}
function configured857() { var env = configured(); env.script.META_ENV = 'production'; return env; } // 本番は環境印が既にある

function seedOp857(env, id, state, dlv) {
  env.script['OP_' + id] = JSON.stringify({ id: id, bookingId: 'PII-BOOK-' + id, state: state, endSec: 1893456000, deviceId: H.DEV, passcodeId: 'KEYID-' + id, name: 'KEYNAME-' + id });
  if (dlv) env.script['DLV_' + id] = JSON.stringify({ state: dlv, to: 'pii@example.test' });
}
function untouched857(before, after) {
  var ign = /^(HB_ADMIN|LOCKFAIL)$/;
  var pick = function (o) { var r = {}; Object.keys(o).filter(function (k) { return !ign.test(k); }).sort().forEach(function (k) { r[k] = o[k]; }); return r; };
  assert.deepStrictEqual(pick(after), pick(before), '状態・設定は変わらない');
}

test('accessAdminInventorySummary（#857）: ON・0件でも読取専用で1行の安全JSON。外部通信・トリガー・状態に影響しない', function () {
  var env = configured857();
  env.triggers.push({ fn: 'accessSyncJob', getHandlerFunction: function () { return 'accessSyncJob'; } });
  var before = Object.assign({}, env.script), userBefore = Object.assign({}, env.user);
  var r = env.ctx.accessAdminInventorySummary();
  var L = invLine857(env);
  assert.deepStrictEqual(Object.keys(L.j).sort(), INV_KEYS_857);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), L.j, '戻り値もログと同じ要約');
  assert.strictEqual(L.j.ok, true);
  assert.strictEqual(L.j.environment, 'production');
  assert.strictEqual(L.j.diagnosis, 'NO_RECORDS');
  assert.strictEqual(L.j.total, 0);
  assert.strictEqual(env.fetches.length, 0, 'SwitchBot APIに触れない');
  assert.strictEqual(env.mails.length, 0);
  assert.strictEqual(env.triggers.length, 1, 'トリガーは変えない');
  untouched857(before, env.script);
  assert.deepStrictEqual(env.user, userBefore);
  assert.strictEqual(env.script.ACCESS_ENABLED, 'true', 'ONのまま');
});

test('accessAdminInventorySummary（#857）: 状態別・配送別・段階別の件数のみ。ID・予約・端末・時刻・秘密は出さない', function () {
  var env = configured857();
  seedOp857(env, 'R1', 'ISSUED_CONFIRMED', null);
  seedOp857(env, 'R2', 'ISSUED_CONFIRMED', 'NOT_SENT');
  seedOp857(env, 'R3', 'ISSUED_CONFIRMED', 'DELIVERED');
  seedOp857(env, 'R4', 'ISSUED_CONFIRMED', 'UNKNOWN');
  seedOp857(env, 'R5', 'SENT_WAIT_WEBHOOK', null);
  seedOp857(env, 'R6', 'UNKNOWN', null);
  seedOp857(env, 'R7', 'DELETED_CONFIRMED', 'SUPPRESSED');
  seedOp857(env, 'R8', 'WEIRD state <x>', 'odd');
  env.script.OP_BROKEN = '{}';
  env.script.OP_NOSTATE = JSON.stringify({ id: 'R9', state: 42 });
  var before = Object.assign({}, env.script);
  var raw = env.ctx.accessAdminInventory();
  assert.strictEqual(raw.ok, true, '既存の accessAdminInventory は従来どおり');
  assert.ok(Array.isArray(raw.items) && raw.items.length === 10);
  env.logs.length = 0;
  env.ctx.accessAdminInventorySummary();
  var L = invLine857(env);
  assert.deepStrictEqual(Object.keys(L.j).sort(), INV_KEYS_857);
  assert.strictEqual(L.j.diagnosis, 'HAS_RECORDS');
  assert.strictEqual(L.j.total, 10);
  assert.strictEqual(L.j.invalid, 2);
  assert.strictEqual(L.j.truncated, false);
  assert.deepStrictEqual(L.j.byState, { ISSUED_CONFIRMED: 4, SENT_WAIT_WEBHOOK: 1, UNKNOWN: 1, DELETED_CONFIRMED: 1, OTHER: 1 });
  assert.deepStrictEqual(L.j.byDelivery, { NONE: 3, NOT_SENT: 1, DELIVERED: 1, UNKNOWN: 1, SUPPRESSED: 1, OTHER: 1 });
  assert.deepStrictEqual(L.j.stages, { ISSUED_NO_DELIVERY_RECORD: 1, ISSUED_DELIVERY_PENDING: 1, ISSUED_DELIVERED: 1, ISSUED_DELIVERY_UNKNOWN: 1, ISSUE_IN_PROGRESS: 1, STATE_UNKNOWN: 1, ENDED: 1, OTHER: 1 });
  assert.ok(!/R[1-8]|PII|BOOK|KEYID|KEYNAME|pii@|AAAAAAAA|01FD|1893456000|WEIRD|odd|tok-test|sec-test|owner@example|ADMIN-1|WWWW/.test(L.raw), L.raw);
  Object.keys(L.j.byState).concat(Object.keys(L.j.byDelivery), Object.keys(L.j.stages)).forEach(function (k) { assert.ok(/^[A-Z][A-Z0-9_]*$/.test(k), k); });
  [L.j.byState, L.j.byDelivery, L.j.stages].forEach(function (o) { Object.keys(o).forEach(function (k) { assert.ok(Number.isSafeInteger(o[k]) && o[k] >= 0); }); });
  assert.strictEqual(env.fetches.length, 0);
  untouched857(before, env.script);
});

test('accessAdminInventorySummary（#857）: 管理者以外・管理API失敗・破損は固定コードのみ。例外内容は出さず投げない', function () {
  var env = configured();
  env.email = 'stranger@example.test';
  var r = env.ctx.accessAdminInventorySummary();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), { ok: false, error: 'NOT_AUTHORIZED' });
  assert.strictEqual(env.logs.join('\n'), 'accessAdminInventorySummary {"ok":false,"error":"NOT_AUTHORIZED"}');
  // JSONとして読めない記録 → 既存の管理経路が固定コードで失敗
  env = configured();
  env.script.OP_X = 'not-json {secret}';
  env.ctx.accessAdminInventorySummary();
  var L = invLine857(env);
  assert.deepStrictEqual(Object.keys(L.j).sort(), ['error', 'ok']);
  assert.strictEqual(L.j.ok, false);
  assert.ok(/^[A-Z][A-Z0-9_]*$/.test(L.j.error));
  assert.ok(!/secret|not-json|Unexpected/.test(L.raw));
  // 設定破損 → 既存経路の固定コード
  env = configured();
  env.script.ACCESS_CONFIG = '{broken';
  env.ctx.accessAdminInventorySummary();
  assert.strictEqual(env.logs.join('\n'), 'accessAdminInventorySummary {"ok":false,"error":"CONFIG_INVALID"}');
  // 想定外の例外 → EXCEPTION（メッセージ・スタックは出さず、投げない）
  env = configured();
  env.ctx.sba_runtime_ = function () { throw new Error('detail pii@example.test tok-test'); };
  assert.doesNotThrow(function () { env.ctx.accessAdminInventorySummary(); });
  assert.strictEqual(env.logs.join('\n'), 'accessAdminInventorySummary {"ok":false,"error":"EXCEPTION"}');
});

test('accessAdminInventorySummary（#857）: 集計関数は非配列・自由文エラー・上限超過を安全に扱う', function () {
  var env = configured();
  var S = env.ctx.sba_summarizeInventory_;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S(null))), { ok: false, error: 'ERROR' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S({ ok: false, error: 'boom at line 3: pii@example.test' }))), { ok: false, error: 'ERROR' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S({ ok: false, error: 'LOCK_UNAVAILABLE' }))), { ok: false, error: 'LOCK_UNAVAILABLE' });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(S({ ok: true, items: {} }))), { ok: false, error: 'INVENTORY_INVALID' });
  var many = []; for (var i = 0; i < 5003; i++) many.push({ id: 'I' + i, state: 'PLANNED', delivery: null, unresolved: true });
  var big = S({ ok: true, items: many });
  assert.strictEqual(big.total, 5003);
  assert.strictEqual(big.scanned, 5000);
  assert.strictEqual(big.truncated, true);
  assert.strictEqual(big.unresolved, 5000);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(big.stages)), { ISSUE_IN_PROGRESS: 5000 });
});

test('accessAdminInventorySummary（#857）: ソース上、書込み・外部通信・ジョブ系を呼ばない', function () {
  var src = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  var start = src.indexOf('function accessAdminInventorySummary(');
  var end = src.indexOf('function sba_inventoryStage_(');
  var body = src.slice(start, src.indexOf('\n}\n', end) + 3).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(start > 0 && end > start);
  assert.ok(!/setProperty|deleteProperty|UrlFetchApp|MailApp|ScriptApp|syncCycle|deliverCycle|sweepCycle|reconcile|'delete'|'resolveUnknown'|'resolveDelivery'|createKey|deleteKey|newTrigger/.test(body), 'forbidden call');
  assert.strictEqual((body.match(/\.admin\(/g) || []).length, 1);
  assert.ok(/\.admin\('inventory', \{\}\)/.test(body));
});
