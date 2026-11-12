/*
 * Issue #916: 発行タイムライン診断（accessTimelineDiag / SwitchBotAccessInfra.timelineReport）のテスト。
 * 実GAS・実API・実Spreadsheetには接続しない。予約ID・メール・PIN・端末ID等はすべてダミー。
 * 検査の主眼: ①読取専用（書込・ロック・メール・SwitchBot API・トリガー0回）②出力に識別情報・絶対日時を含まない
 * ③欠損・不整合は推測せず null＋固定理由コード ④t0=confirmedAt のみ（paymentConfirmedAt で代用しない）。
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
var C = H.Core;
var DEV = H.DEV;
var NOW_ISO = '2030-01-11T12:00:00+09:00';
var HOUR = 3600;

// 識別情報として「出力に出てはいけない」ダミー値
var SENTINEL = { email: 'pii-916@example.test', name: 'PII-NAME-916', pin: '48271936', cmd: 'CMD-SECRET-916', secretLike: 'tok-916-secret' };

function jst(date, time) { return Math.floor(Date.parse(date + 'T' + time + ':00+09:00') / 1000); }
function jd(date, time) { return new Date(date + 'T' + time + ':00+09:00'); }

function bookingHeaders() {
  var ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/booking/shared/BookingsSchema.gs'), 'utf8'), ctx);
  return Array.from(ctx.BookingsSchema.HEADERS);
}

/** 配布物をそのままvmへ読み込み、GASサービスのフェイクを注入する。副作用の呼出回数を数える。 */
function loadShell(opts) {
  opts = opts || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba916-'));
  prepare.prepareProject(out);
  var headers = bookingHeaders();
  var env = {
    script: Object.assign({}, opts.script || {}), user: Object.assign({}, opts.user || {}),
    logs: [], mails: 0, otherFetches: 0, propWrites: 0, lockCalls: 0, triggerCalls: 0, spreadsheetApp: 0,
    email: 'owner@example.test', rows: opts.rows || []
  };
  function props(m) {
    return {
      getProperty: function (k) { return m[k] === undefined ? null : m[k]; },
      setProperty: function (k, v) { env.propWrites++; m[k] = String(v); },
      deleteProperty: function (k) { env.propWrites++; delete m[k]; },
      getKeys: function () { return Object.keys(m); }
    };
  }
  var sheetState = { headers: headers };
  Object.defineProperty(sheetState, 'rows', { get: function () { return env.rows; } });
  env.sheetState = sheetState;
  env.sheets = SheetsFake.create(sheetState);
  function lockSpy() { env.lockCalls++; return { tryLock: function () { return true; }, releaseLock: function () {} }; }
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(env.script); }, getUserProperties: function () { return props(env.user); } },
    LockService: { getScriptLock: lockSpy, getUserLock: lockSpy, getDocumentLock: lockSpy },
    Utilities: {
      base64Encode: function (b) { return Buffer.from(b).toString('base64'); },
      computeHmacSha256Signature: function (msg, secret) { return Array.from(crypto.createHmac('sha256', secret).update(msg).digest()); },
      getUuid: function () { return crypto.randomUUID(); },
      computeDigest: function (alg, s) { return Array.from(crypto.createHash('sha256').update(s).digest()).map(function (b) { return b > 127 ? b - 256 : b; }); },
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' }
    },
    ContentService: { MimeType: { JSON: 'JSON' }, createTextOutput: function (t) { return { text: t, setMimeType: function () { return this; } }; } },
    MailApp: { sendEmail: function () { env.mails++; }, getRemainingDailyQuota: function () { return 100; } },
    SpreadsheetApp: { openById: function () { env.spreadsheetApp++; throw new Error('SpreadsheetApp is not allowed'); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return env.email; } }; } },
    ScriptApp: {
      getOAuthToken: function () { return 'dummy-oauth-token'; },
      getProjectTriggers: function () { env.triggerCalls++; return []; },
      deleteTrigger: function () { env.triggerCalls++; },
      newTrigger: function () { env.triggerCalls++; throw new Error('no triggers in this test'); }
    },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    UrlFetchApp: {
      fetch: function (url, options) {
        if (/^https:\/\/sheets\.googleapis\.com\//.test(url)) return env.sheets.fetch(url, options);
        env.otherFetches++; // SwitchBot API など。呼ばれてはいけない
        throw new Error('NO_EXTERNAL_CALL_IN_THIS_TEST');
      }
    }
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) {
    vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n });
  });
  env.ctx = ctx;
  return env;
}

function setNow(env, iso) {
  var t = Date.parse(iso);
  env.ctx.Date = class extends Date { constructor() { if (arguments.length) super(...arguments); else super(t); } static now() { return t; } };
}

function configured(over) {
  var cfg = H.baseCfg(Object.assign({ delivery: { senderName: 'テスト施設', facilityLabel: 'テスト施設', inquiryNote: 'お問い合わせください', startHoursBeforeDay: 6 } }, over || {}));
  delete cfg.enabled;
  var env = loadShell({
    script: { ACCESS_CONFIG: JSON.stringify(cfg), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true', LEDGER_SPREADSHEET_ID: 'ss-test',
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }) },
    user: { SWITCHBOT_TOKEN: SENTINEL.secretLike, SWITCHBOT_SECRET: SENTINEL.secretLike, WEBHOOK_SHARED_TOKEN: 'W'.repeat(32) }
  });
  setNow(env, NOW_ISO);
  return env;
}

function ledgerRow(over) {
  return Object.assign({
    bookingId: 'DUMMY-916-A', startAt: jd('2030-01-11', '10:00'), endAt: jd('2030-01-11', '12:00'), brand: 'snb',
    name: SENTINEL.name, email: SENTINEL.email, phone: '090-0000-0000', purpose: 'PII-PURPOSE', people: '3名',
    paymentMethod: 'オンラインクレジットカード', status: 'CONFIRMED', paymentStatus: 'paid',
    paymentConfirmedAt: jd('2030-01-11', '09:29'), confirmedAt: jd('2030-01-11', '09:30'), revision: 1
  }, over || {});
}

/** 1予約ぶんの状態（BK_/TRK_/OP_/EVT_/DLV_）を作る。時刻はすべて epoch 秒（絶対）。 */
function seed(env, bid, o) {
  var s = env.script;
  var recId = o.recId || (bid + ':' + (o.revision || 1) + ':****01FD:ISSUE#1');
  var op = {
    id: recId, bookingId: bid, revision: o.revision || 1, deviceId: DEV, op: 'ISSUE', name: 'SNB-' + bid, state: o.state || 'ISSUED_CONFIRMED',
    commandId: SENTINEL.cmd + bid, sentAtSec: o.sent, startSec: o.sent + 600, endSec: o.sent + 7800, evidence: [], reads: 1,
    history: [{ at: o.created, from: null, to: 'PLANNED', basis: null }, { at: o.sent, from: 'PLANNED', to: 'SENT_WAIT_WEBHOOK', basis: null }].concat(
      o.confirmed ? [{ at: o.confirmed, from: 'SENT_WAIT_WEBHOOK', to: 'ISSUED_CONFIRMED', basis: null }] : []),
    createdAt: o.created, updatedAt: o.created
  };
  s['OP_' + recId] = JSON.stringify(op);
  var ids = (o.priorOps || []).concat([recId]);
  if (!o.noBk) s['BK_' + bid] = JSON.stringify({ bookingId: bid, head: null, ops: ids });
  if (!o.noTrk) s['TRK_' + bid] = JSON.stringify({ revision: o.trkRevision === undefined ? (o.revision || 1) : o.trkRevision, obsRevision: o.obsRevision === undefined ? (o.revision || 1) : o.obsRevision, obsAt: o.obs, seenAt: o.obs });
  if (o.webhook) s['EVT_' + C.normDev(DEV) + '_createKey_' + op.commandId] = JSON.stringify({ receivedAtSec: o.webhook, result: 'success' });
  if (o.dlvHistory) s['DLV_' + recId] = JSON.stringify({ id: 'DLV_' + recId, opId: recId, bookingId: bid, seq: 1, state: o.dlvState || 'DELIVERED', history: o.dlvHistory });
  return recId;
}

function run(env) {
  // vm 内で作られたオブジェクトは Array/Object のプロトタイプが別なので、JSON で正規化して比較する
  return JSON.parse(JSON.stringify(env.ctx.accessTimelineDiag()));
}

var T0A = jst('2030-01-11', '09:30'); // DUMMY-916-A の確定

function seedA(env, over) {
  return seed(env, 'DUMMY-916-A', Object.assign({
    created: T0A + 20, obs: T0A + 20, sent: T0A + 25, webhook: T0A + 40, confirmed: T0A + 45,
    dlvHistory: [{ at: T0A + 46, from: null, to: 'SENDING', basis: null }, { at: T0A + 48, from: 'SENDING', to: 'DELIVERED', basis: null }]
  }, over || {}));
}

// 出力に出てはいけないもの（識別情報・秘密・絶対日時）を一括検査する
function assertNoLeak(env, res, bookingIds, recIds) {
  var blob = JSON.stringify(res) + '\n' + env.logs.join('\n');
  (bookingIds || []).forEach(function (b) { assert.ok(blob.indexOf(b) === -1, '予約IDが出力にある: ' + b); });
  (recIds || []).forEach(function (r) { assert.ok(blob.indexOf(r) === -1, 'recIdが出力にある'); });
  [SENTINEL.email, SENTINEL.name, SENTINEL.pin, SENTINEL.cmd, SENTINEL.secretLike, '090-0000-0000', 'PII-PURPOSE', DEV, C.normDev(DEV), 'owner@example.test'].forEach(function (v) {
    assert.ok(blob.indexOf(v) === -1, '識別情報・秘密が出力にある: ' + v);
  });
  assert.ok(!/\b\d{4}-\d{2}-\d{2}/.test(blob), 'ISO形式の日付が出力にある');
  assert.ok(!/\b\d{1,2}:\d{2}\b/.test(blob), 'HH:MM形式の時刻が出力にある');
  assert.ok(!/\d{10,}/.test(blob), '10桁以上の数値（epoch秒など）が出力にある');
}

// ================================================================ 基本・出力

test('正常: 確定からの経過秒（初観測・送信・Webhook・登録確認・配送の送信呼出）を出し、層Aと余裕を示す', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  var recId = seedA(env);
  var res = run(env);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.readConsistency, 'BEST_EFFORT');
  assert.strictEqual(res.precisionSec, 1);
  assert.strictEqual(res.windowTotal, 1); assert.strictEqual(res.shown, 1); assert.strictEqual(res.excludedNoConfirmedAt, 0);
  var r = res.rows[0];
  assert.strictEqual(r.rank, 1); assert.strictEqual(r.tie, false); assert.strictEqual(r.branch, '');
  assert.strictEqual(r.brand, 'snb'); assert.strictEqual(r.pay, 'card'); assert.strictEqual(r.ledgerStatus, 'CONFIRMED');
  assert.strictEqual(r.tier, 'A'); assert.strictEqual(r.leadSec, 1800);
  assert.strictEqual(r.state, 'ISSUED_CONFIRMED'); assert.strictEqual(r.delivery, 'DELIVERED');
  assert.strictEqual(r.obs, 20); assert.strictEqual(r.sent, 25); assert.strictEqual(r.webhook, 40); assert.strictEqual(r.confirmed, 45);
  assert.strictEqual(r.sendStart, 46); assert.strictEqual(r.sendCall, 2);
  assert.strictEqual(r.gateOpen, null); assert.strictEqual(r.postGateDelay, null);
  assert.deepStrictEqual(r.reasons, []);
  assertNoLeak(env, res, ['DUMMY-916-A'], [recId]);
  assert.strictEqual(env.logs.length, 1);
  assert.ok(env.logs[0].indexOf('accessTimelineDiag ') === 0);
  assert.deepStrictEqual(JSON.parse(env.logs[0].slice('accessTimelineDiag '.length)), JSON.parse(JSON.stringify(res)));
});

test('読取専用: Properties書込・ロック・メール・SwitchBot等の外部通信・トリガー・SpreadsheetAppが0回で、状態は変わらない。台帳はGETのみ', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  seedA(env);
  var beforeScript = JSON.stringify(env.script), beforeUser = JSON.stringify(env.user);
  run(env);
  assert.strictEqual(env.propWrites, 0);
  assert.strictEqual(env.lockCalls, 0);
  assert.strictEqual(env.mails, 0);
  assert.strictEqual(env.otherFetches, 0);
  assert.strictEqual(env.triggerCalls, 0);
  assert.strictEqual(env.spreadsheetApp, 0);
  assert.strictEqual(JSON.stringify(env.script), beforeScript);
  assert.strictEqual(JSON.stringify(env.user), beforeUser);
  assert.strictEqual(env.sheets.state.writes, 0);
  assert.ok(env.sheets.state.calls.length >= 4 && env.sheets.state.calls.length <= 13, 'Sheets API 呼出回数: ' + env.sheets.state.calls.length);
  assert.ok(env.sheets.state.calls.every(function (c) { return c.method === 'get'; }));
  assert.ok(!('HB_ADMIN' in env.script) && !('META_ENV' in env.script) && !('LOCKFAIL' in env.script), 'HB_ADMIN/META_ENV/LOCKFAIL を書かない');
});

test('読取専用ファサード: set/del/keys は例外で止まり、get は読める', function () {
  var env = configured();
  env.script.X_PROBE = 'v';
  var store = env.ctx.sba_timelineStore_();
  assert.strictEqual(store.get('X_PROBE'), 'v');
  assert.throws(function () { store.set('X_PROBE', 'w'); }, /READ_ONLY_STORE/);
  assert.throws(function () { store.del('X_PROBE'); }, /READ_ONLY_STORE/);
  assert.throws(function () { store.keys(); }, /READ_ONLY_STORE/);
  assert.strictEqual(env.script.X_PROBE, 'v');
});

test('ソース静的検査: 診断は admin()/runLocked/drainInbox/createRuntime/sba_runtime_、メール、ロック、書込、SwitchBot API、トリガー、ユーザープロパティに到達しない', function () {
  var app = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  var start = app.indexOf('function sba_timelineStore_(');
  var end = app.indexOf('function accessAdminInspect(');
  assert.ok(start !== -1 && end > start);
  var appPart = app.slice(start, end).replace(/\/\/[^\n]*/g, '');
  ['sba_runtime_', 'createRuntime', '.admin(', 'runLocked', 'drainInbox', 'MailApp', 'LockService', 'setProperty', 'deleteProperty', 'UrlFetchApp', 'ScriptApp', 'sba_request_', 'sba_api_', 'getUserProperties', 'sba_userProps_', 'sba_stateStore_', 'sba_secretStore_'].forEach(function (t) {
    assert.ok(appPart.indexOf(t) === -1, '診断のApp側が ' + t + ' を参照している');
  });
  var infra = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/SwitchBotAccessInfra.gs'), 'utf8');
  var s2 = infra.indexOf('function timelineReport(');
  var e2 = infra.indexOf('// ---------- 配送（暗証番号案内メール。Issue #752）');
  assert.ok(s2 !== -1 && e2 > s2);
  var infraPart = infra.slice(s2, e2).replace(/\/\/[^\n]*/g, '');
  ['store.set', 'store.del', 'store.keys', 'deps.api', 'deps.lock', 'sendMail', 'deliverCode', '.createKey(', '.deleteKey(', 'listDevices', 'engine.', 'infraAlert', 'heartbeat'].forEach(function (t) {
    assert.ok(infraPart.indexOf(t) === -1, '診断の純粋ロジックが ' + t + ' を参照している');
  });
  assert.ok(app.indexOf("var SBA_JOBS_ = ['accessSyncJob', 'accessDeliverJob', 'accessSweepJob', 'accessWatchdogJob', 'accessDailyCleanupJob'];") !== -1, '診断はトリガー対象ジョブに加えない');
});

test('配布物・マニフェストは変えない（ファイル構成・スコープ・Webアプリ設定）', function () {
  assert.deepStrictEqual(prepare.fileNames(), ['SwitchBotAccessCore.gs', 'AccessKeySnapshot.gs', 'AccessLedgerReader.gs', 'SwitchBotAccessInfra.gs', 'SwitchBotAccessApp.gs', 'appsscript.json']);
  var m = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/appsscript.json'), 'utf8'));
  assert.deepStrictEqual(m.oauthScopes, [
    'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/script.send_mail', 'https://www.googleapis.com/auth/script.scriptapp', 'https://www.googleapis.com/auth/userinfo.email'
  ]);
  assert.strictEqual(m.webapp.executeAs, 'USER_DEPLOYING');
});

// ================================================================ 認可・台帳エラー

test('管理者以外・実行者不明は NOT_AUTHORIZED の固定コードだけ。台帳にも触れない', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  seedA(env);
  env.email = 'intruder@example.test';
  var res = run(env);
  assert.deepStrictEqual(res, { ok: false, error: 'NOT_AUTHORIZED' });
  assert.strictEqual(env.sheets.state.calls.length, 0);
  env.email = '';
  assert.deepStrictEqual(run(env), { ok: false, error: 'NOT_AUTHORIZED' });
  assert.ok(env.logs.every(function (l) { return l.indexOf('intruder') === -1; }));
});

test('台帳読取エラー: 固定コードのみ返し、例外本文・HTTP本文は出さない。投げない', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  seedA(env);
  env.sheetState.http = { code: 403, body: { error: { message: 'LEAK-ME-916 ' + SENTINEL.email, status: 'PERMISSION_DENIED' } } };
  var res = run(env);
  assert.strictEqual(res.ok, false);
  assert.ok(/^LEDGER_[A-Z_]+$/.test(res.error), res.error);
  assert.ok(env.logs.join('\n').indexOf('LEAK-ME-916') === -1);
  assert.ok(env.logs.join('\n').indexOf(SENTINEL.email) === -1);
  env.sheetState.http = null;
  env.sheetState.fetchThrow = 'boom ' + SENTINEL.email;
  var res2 = run(env);
  assert.strictEqual(res2.ok, false);
  assert.ok(/^LEDGER_[A-Z_]+$/.test(res2.error));
  assert.ok(env.logs.join('\n').indexOf(SENTINEL.email) === -1);
  assert.strictEqual(env.propWrites, 0);
});

test('想定外の例外は UNEXPECTED_ERROR の固定コードのみ（本文を出さない）', function () {
  var env = configured();
  env.script.LEDGER_SPREADSHEET_ID = 'ss-test';
  env.ctx.AccessLedgerReader = { readFromSheet: function () { throw new Error('INTERNAL-916 ' + SENTINEL.email); }, classifyError: function () { throw new Error('INTERNAL2-916'); } };
  var res = run(env);
  assert.deepStrictEqual(res, { ok: false, error: 'UNEXPECTED_ERROR' });
  assert.ok(env.logs.join('\n').indexOf('INTERNAL') === -1);
});

// ================================================================ 対象選択・t0

test('対象: 窓内（利用日が当日・翌日）で confirmedAt が有効な行を新しい順に最大10件。窓外は取得しない・件数だけ併記', function () {
  var env = configured();
  var rows = [];
  for (var i = 0; i < 12; i++) {
    rows.push(ledgerRow({ bookingId: 'DUMMY-916-N' + i, confirmedAt: new Date(jst('2030-01-11', '08:00') * 1000 + i * 60000), startAt: jd('2030-01-11', '14:00'), endAt: jd('2030-01-11', '16:00') }));
  }
  rows.push(ledgerRow({ bookingId: 'DUMMY-916-OUT', startAt: jd('2030-01-14', '10:00'), endAt: jd('2030-01-14', '12:00') })); // 窓外（3日後）
  rows.push(ledgerRow({ bookingId: 'DUMMY-916-NOCONF', confirmedAt: '' }));
  env.rows = rows;
  var res = run(env);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.windowTotal, 13, '窓内の行（窓外は含まない）');
  assert.strictEqual(res.excludedNoConfirmedAt, 1);
  assert.strictEqual(res.shown, 10);
  assert.strictEqual(res.rows.length, 10);
  assert.strictEqual(res.outOfWindow, 'NOT_FETCHED');
  assert.strictEqual(res.scope, 'LEDGER_WINDOW_TODAY_TOMORROW_JST');
  res.rows.forEach(function (r, k) { assert.strictEqual(r.rank, k + 1); });
  // 新しい順（N11 が #1 → leadSec は開始までの余裕で、確定が新しいほど小さい）
  for (var k = 1; k < res.rows.length; k++) assert.ok(res.rows[k - 1].leadSec <= res.rows[k].leadSec);
  assert.ok(res.rows.every(function (r) { return r.reasons.indexOf('NO_RECORD') !== -1; }), '窓内で状態に記録が無い行は NO_RECORD（未観測か回収済みかは区別しない）');
  assertNoLeak(env, res, rows.map(function (r) { return r.bookingId; }), []);
});

test('t0 は confirmedAt のみ: confirmedAt が無い行は paymentConfirmedAt があっても対象外で、代用しない', function () {
  var env = configured();
  env.rows = [ledgerRow({ confirmedAt: '', paymentConfirmedAt: jd('2030-01-11', '09:29') })];
  seedA(env);
  var res = run(env);
  assert.strictEqual(res.excludedNoConfirmedAt, 1);
  assert.strictEqual(res.shown, 0);
  assert.deepStrictEqual(res.rows, []);
});

test('同一秒の確定は TIE（順序を確定扱いにしない）', function () {
  var env = configured();
  env.rows = [
    ledgerRow({ bookingId: 'DUMMY-916-T1', confirmedAt: jd('2030-01-11', '09:30') }),
    ledgerRow({ bookingId: 'DUMMY-916-T2', confirmedAt: jd('2030-01-11', '09:30') }),
    ledgerRow({ bookingId: 'DUMMY-916-T3', confirmedAt: jd('2030-01-11', '09:00') })
  ];
  var res = run(env);
  assert.deepStrictEqual(res.rows.map(function (r) { return r.tie; }), [true, true, false]);
});

test('台帳に同じIDが複数ある行は LEDGER_AMBIGUOUS（誤結合しない）', function () {
  var env = configured();
  env.rows = [ledgerRow(), ledgerRow()];
  seedA(env);
  var res = run(env);
  assert.ok(res.rows.length >= 1);
  res.rows.forEach(function (r) { assert.deepStrictEqual(r.reasons, ['LEDGER_AMBIGUOUS']); assert.strictEqual(r.obs, null); assert.strictEqual(r.sent, null); });
});

// ================================================================ 欠損・不整合

test('状態ストアに記録が無い: NO_RECORD。すべて null で、回収済みか未観測かは断定しない', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  var res = run(env);
  var r = res.rows[0];
  assert.deepStrictEqual(r.reasons, ['NO_RECORD']);
  ['state', 'delivery', 'obs', 'sent', 'webhook', 'confirmed', 'sendStart', 'sendCall', 'gateOpen', 'postGateDelay'].forEach(function (f) { assert.strictEqual(r[f], null, f); });
});

test('一部欠落（早期回収の途中）: 残った区間だけ出し、無い区間は null。OPが無く追跡だけ残る場合は初観測のみ', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  seedA(env, { dlvHistory: undefined, webhook: undefined, confirmed: undefined, state: 'SENT_WAIT_WEBHOOK' });
  var r = run(env).rows[0];
  assert.strictEqual(r.obs, 20); assert.strictEqual(r.sent, 25);
  assert.strictEqual(r.webhook, null); assert.strictEqual(r.confirmed, null); assert.strictEqual(r.sendStart, null); assert.strictEqual(r.sendCall, null);
  assert.strictEqual(r.delivery, null);

  var env2 = configured();
  env2.rows = [ledgerRow()];
  env2.script['TRK_DUMMY-916-A'] = JSON.stringify({ revision: 1, obsRevision: 1, obsAt: T0A + 15, seenAt: T0A + 15 });
  var r2 = run(env2).rows[0];
  assert.deepStrictEqual(r2.reasons, ['NO_RECORD']);
  assert.strictEqual(r2.obs, 15); assert.strictEqual(r2.sent, null);
});

test('revision 不一致: その操作の t0 起点の列は null（REVISION_MISMATCH）。旧 revision の秒を混ぜない', function () {
  var env = configured();
  env.rows = [ledgerRow({ revision: 2 })];
  seedA(env, { revision: 1, obsRevision: 1 });
  var r = run(env).rows[0];
  assert.ok(r.reasons.indexOf('REVISION_MISMATCH') !== -1);
  ['obs', 'sent', 'webhook', 'confirmed', 'sendStart'].forEach(function (f) { assert.strictEqual(r[f], null, f); });
  assert.strictEqual(r.sendCall, 2, '操作内の送信呼出の所要は t0 に依存しないので残る');
});

test('複数の操作: 枝番で別行にし、t0 相対秒は現在 revision の操作にだけ付ける', function () {
  var env = configured();
  env.rows = [ledgerRow({ revision: 2 })];
  var oldId = seed(env, 'DUMMY-916-A', { revision: 1, created: T0A - 7200, obs: T0A - 7200, sent: T0A - 7190, webhook: T0A - 7170, confirmed: T0A - 7160, obsRevision: 1 });
  seed(env, 'DUMMY-916-A', { revision: 2, priorOps: [oldId], created: T0A + 30, obs: T0A + 30, sent: T0A + 35, webhook: T0A + 50, confirmed: T0A + 55, obsRevision: 2 });
  var res = run(env);
  assert.deepStrictEqual(res.rows.map(function (r) { return r.branch; }), ['a', 'b']);
  var a = res.rows[0], b = res.rows[1];
  assert.ok(a.reasons.indexOf('REVISION_MISMATCH') !== -1 || a.reasons.indexOf('ORDER_VIOLATION') !== -1);
  assert.strictEqual(a.sent, null); assert.strictEqual(a.confirmed, null);
  assert.strictEqual(b.sent, 35); assert.strictEqual(b.webhook, 50); assert.strictEqual(b.confirmed, 55); assert.deepStrictEqual(b.reasons, []);
});

test('時刻逆転（確定より前に作られた操作・確定より前のイベント）: ORDER_VIOLATION で null。負の秒を出さない', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  seedA(env, { created: T0A - 600, obs: T0A - 600, sent: T0A - 590, webhook: T0A - 570, confirmed: T0A - 560 });
  var r = run(env).rows[0];
  assert.ok(r.reasons.indexOf('ORDER_VIOLATION') !== -1);
  ['obs', 'sent', 'webhook', 'confirmed', 'sendStart'].forEach(function (f) { assert.strictEqual(r[f], null, f); });

  var env2 = configured();
  env2.rows = [ledgerRow()];
  seedA(env2, { webhook: T0A - 100 }); // 操作は現在の確定後だが、Webhook時刻だけが確定より前
  var r2 = run(env2).rows[0];
  assert.strictEqual(r2.webhook, null);
  assert.ok(r2.reasons.indexOf('ORDER_VIOLATION') !== -1);
  assert.strictEqual(r2.sent, 25);
  [r, r2].forEach(function (x) { ['obs', 'sent', 'webhook', 'confirmed', 'sendStart', 'sendCall', 'postGateDelay'].forEach(function (f) { assert.ok(x[f] === null || x[f] >= 0, f); }); });
});

test('追跡記録が旧 revision の観測なら初観測は null（現在 revision の観測だけを使う）', function () {
  var env = configured();
  env.rows = [ledgerRow({ revision: 2 })];
  seedA(env, { revision: 2, obsRevision: 1 });
  var r = run(env).rows[0];
  assert.strictEqual(r.obs, null);
  assert.ok(r.reasons.indexOf('REVISION_MISMATCH') !== -1);
  assert.strictEqual(r.sent, 25);
});

// ================================================================ 配送

test('管理者が配送確認した行: DELIVERED_BY_ADMIN。送信呼出の秒は null（管理者操作の時刻を送信時刻と誤読しない）', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  seedA(env, { dlvHistory: [
    { at: T0A + 46, from: null, to: 'SENDING', basis: null }, { at: T0A + 47, from: 'SENDING', to: 'UNKNOWN', basis: 'SEND_RESULT_UNKNOWN' },
    { at: T0A + 4000, from: 'UNKNOWN', to: 'DELIVERED', basis: 'ADMIN:ADMIN-1' }
  ] });
  var r = run(env).rows[0];
  assert.ok(r.reasons.indexOf('DELIVERED_BY_ADMIN') !== -1);
  assert.strictEqual(r.sendCall, null); assert.strictEqual(r.sendStart, null);
  assert.strictEqual(r.sent, 25);
  assert.ok(JSON.stringify(run(env)).indexOf('ADMIN-1') === -1, '管理者ラベルを出さない');
});

test('再送（送信が2回以上）: 最初の送信だけを計測し、sendCycles と合わせて混入を明示する', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  seedA(env, { dlvHistory: [
    { at: T0A + 46, from: null, to: 'SENDING', basis: null }, { at: T0A + 48, from: 'SENDING', to: 'DELIVERED', basis: null },
    { at: T0A + 900, from: 'DELIVERED', to: 'SENDING', basis: null }, { at: T0A + 950, from: 'SENDING', to: 'DELIVERED', basis: null }
  ] });
  var r = run(env).rows[0];
  assert.strictEqual(r.sendCycles, 2);
  assert.strictEqual(r.sendStart, 46); assert.strictEqual(r.sendCall, 2);
});

test('送信が完了していない（NOT_SENT/UNKNOWN）: 送信呼出の秒は null で配送状態コードだけ示す', function () {
  var env = configured();
  env.rows = [ledgerRow()];
  seedA(env, { dlvState: 'NOT_SENT', dlvHistory: [{ at: T0A + 46, from: null, to: 'SENDING', basis: null }, { at: T0A + 47, from: 'SENDING', to: 'NOT_SENT', basis: 'DELIVER_FAILED' }] });
  var r = run(env).rows[0];
  assert.strictEqual(r.delivery, 'NOT_SENT'); assert.strictEqual(r.sendCall, null); assert.strictEqual(r.sendStart, 46);
});

// ================================================================ 層

test('層C（前日18:00より前に確定）: 初観測〜登録確認は null にせず、ゲート由来の待ちと配送処理の遅延を分ける', function () {
  var env = configured();
  var t0 = jst('2030-01-10', '15:00');
  var gate = jst('2030-01-10', '18:00');
  env.rows = [ledgerRow({ bookingId: 'DUMMY-916-C', confirmedAt: jd('2030-01-10', '15:00'), startAt: jd('2030-01-11', '10:00'), endAt: jd('2030-01-11', '12:00') })];
  seed(env, 'DUMMY-916-C', {
    created: t0 + 30, obs: t0 + 30, sent: t0 + 40, webhook: t0 + 60, confirmed: t0 + 70,
    dlvHistory: [{ at: gate + 12, from: null, to: 'SENDING', basis: null }, { at: gate + 14, from: 'SENDING', to: 'DELIVERED', basis: null }]
  });
  var r = run(env).rows[0];
  assert.strictEqual(r.tier, 'C');
  assert.strictEqual(r.obs, 30); assert.strictEqual(r.sent, 40); assert.strictEqual(r.webhook, 60); assert.strictEqual(r.confirmed, 70);
  assert.strictEqual(r.gateOpen, gate - t0);
  assert.strictEqual(r.sendStart, gate + 12 - t0);
  assert.strictEqual(r.postGateDelay, 12, 'ゲートが開いてから配送処理が始まるまで');
  assert.strictEqual(r.sendCall, 2);
});

test('層の境界: 前日18:00ちょうどの確定は C にならず、開始まで60分以内なら A・超えれば B', function () {
  var env = configured();
  env.rows = [
    ledgerRow({ bookingId: 'DUMMY-916-B1', confirmedAt: jd('2030-01-10', '17:59'), startAt: jd('2030-01-11', '10:00'), endAt: jd('2030-01-11', '12:00') }),
    ledgerRow({ bookingId: 'DUMMY-916-B2', confirmedAt: jd('2030-01-10', '18:00'), startAt: jd('2030-01-11', '10:00'), endAt: jd('2030-01-11', '12:00') }),
    ledgerRow({ bookingId: 'DUMMY-916-B3', confirmedAt: jd('2030-01-11', '09:00'), startAt: jd('2030-01-11', '10:00'), endAt: jd('2030-01-11', '12:00') }),
    ledgerRow({ bookingId: 'DUMMY-916-B4', confirmedAt: jd('2030-01-11', '08:59'), startAt: jd('2030-01-11', '10:00'), endAt: jd('2030-01-11', '12:00') })
  ];
  var byLead = {};
  run(env).rows.forEach(function (r) { byLead[r.leadSec] = r.tier; });
  assert.strictEqual(byLead[jst('2030-01-11', '10:00') - jst('2030-01-10', '17:59')], 'C');
  assert.strictEqual(byLead[jst('2030-01-11', '10:00') - jst('2030-01-10', '18:00')], 'B');
  assert.strictEqual(byLead[3600], 'A');
  assert.strictEqual(byLead[3660], 'B');
});

test('配送ゲートの設定が読めない: 層は UNKNOWN_TIER（推測しない）', function () {
  var env = loadShell({
    script: { ACCESS_CONFIG: JSON.stringify(Object.assign(H.baseCfg(), { enabled: undefined })), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true', LEDGER_SPREADSHEET_ID: 'ss-test',
      ACCESS_ADMIN_ACTORS: JSON.stringify({ 'owner@example.test': 'ADMIN-1' }) }
  });
  setNow(env, NOW_ISO);
  env.rows = [ledgerRow()];
  seedA(env);
  var r = run(env).rows[0];
  assert.strictEqual(r.tier, 'UNKNOWN_TIER');
  assert.strictEqual(r.gateOpen, null);
  assert.strictEqual(r.sent, 25);
});

test('ブランド: 対象3つはそのまま、それ以外・空は OTHER。決済はカード/その他の2種類だけ', function () {
  var env = configured();
  env.rows = [
    ledgerRow({ bookingId: 'DUMMY-916-M', brand: 'mens', paymentMethod: '現金', confirmedAt: jd('2030-01-11', '09:10') }),
    ledgerRow({ bookingId: 'DUMMY-916-X', brand: 'studio_x', confirmedAt: jd('2030-01-11', '09:20') }),
    ledgerRow({ bookingId: 'DUMMY-916-E', brand: '', confirmedAt: jd('2030-01-11', '09:30') })
  ];
  var res = run(env);
  assert.deepStrictEqual(res.rows.map(function (r) { return r.brand; }), ['OTHER', 'studio_x', 'mens']);
  assert.deepStrictEqual(res.rows.map(function (r) { return r.pay; }), ['card', 'card', 'other']);
  assertNoLeak(env, res, ['DUMMY-916-M', 'DUMMY-916-X', 'DUMMY-916-E'], []);
});

// ================================================================ 出力の安全性（総合）

test('出力の総合検査: 多様な状態でも、ID・recId・メール・PIN・commandId・deviceId・絶対日時・epoch・HH:MMが戻り値とログに出ない', function () {
  var env = configured();
  env.rows = [
    ledgerRow(),
    ledgerRow({ bookingId: 'DUMMY-916-C', confirmedAt: jd('2030-01-10', '15:00'), startAt: jd('2030-01-11', '10:00'), endAt: jd('2030-01-11', '12:00') })
  ];
  var r1 = seedA(env, { dlvHistory: [{ at: T0A + 46, from: null, to: 'SENDING', basis: null }, { at: T0A + 4000, from: 'SENDING', to: 'DELIVERED', basis: 'ADMIN:ADMIN-1' }] });
  var t0 = jst('2030-01-10', '15:00');
  var r2 = seed(env, 'DUMMY-916-C', { created: t0 + 30, obs: t0 + 30, sent: t0 + 40, webhook: t0 + 60, confirmed: t0 + 70 });
  env.user.SECRET_ABC = SENTINEL.pin; // PIN相当のダミー（診断は User Properties を読まない）
  var res = run(env);
  assert.strictEqual(res.ok, true);
  assertNoLeak(env, res, ['DUMMY-916-A', 'DUMMY-916-C'], [r1, r2]);
  assert.ok(JSON.stringify(res).indexOf('ADMIN-1') === -1);
});
