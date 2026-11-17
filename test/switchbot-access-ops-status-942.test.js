/*
 * Issue #942: 運営アプリ向けの鍵状態参照（AccessOpsStatus / doPost の入口振り分け）のテスト。
 * 実GAS・実API・実Spreadsheetには接続しない。予約ID・PIN・端末ID等はすべて架空のダミー。
 * 検査の主眼: ①既存Webhook・doGetの非干渉と、分岐例外のfail-closed ②認証前に状態ストアへ触れない・失敗は同一の固定応答
 * ③許可リスト射影（秘密・識別情報が出ない） ④書込み・ロック・メール・トリガー・外部通信が0回 ⑤欠落/不整合/8件超/読取中の更新を断定しない。
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

var ROOT = path.resolve(__dirname, '..');
var TOKEN = 'T'.repeat(40);
var DIGEST = crypto.createHash('sha256').update(TOKEN).digest('hex');
var REF = 'SNB-20301111-AAAA0001';
var REF2 = 'SX-20301111-BBBB0002';
var NOW_SEC = Math.floor(Date.now() / 1000);
var SENT = { pin: '48271936', cmd: 'CMD-SECRET-942', pass: 'PASSCODE-ID-942', dev: 'DEVICE-FULL-ID-942-01FD', name: 'SNB-KEYNAME-942', evid: 'EVIDENCE-942', mail: 'pii-942@example.test' };

function loadShell(opts) {
  opts = opts || {};
  var out = fs.mkdtempSync(path.join(os.tmpdir(), 'sba942-'));
  prepare.prepareProject(out);
  var env = {
    script: Object.assign({ ACCESS_OPS_STATUS_TOKEN_SHA256: DIGEST }, opts.script || {}), user: Object.assign({}, opts.user || {}),
    logs: [], propWrites: 0, scriptReads: 0, userReads: 0, lockCalls: 0, mails: 0, fetches: 0, triggers: 0, spreadsheetApp: 0, onRead: null
  };
  function props(m, kind) {
    return {
      getProperty: function (k) { if (kind === 'script') { if (k === 'ACCESS_OPS_STATUS_TOKEN_SHA256') env.digestReads = (env.digestReads || 0) + 1; else { env.scriptReads++; if (env.onRead) env.onRead(k); } } else env.userReads++; return m[k] === undefined ? null : m[k]; },
      setProperty: function (k, v) { env.propWrites++; m[k] = String(v); },
      deleteProperty: function (k) { env.propWrites++; delete m[k]; },
      getKeys: function () { env.keysCalls = (env.keysCalls || 0) + 1; return Object.keys(m); },
      getProperties: function () { env.keysCalls = (env.keysCalls || 0) + 1; return Object.assign({}, m); }
    };
  }
  function lockSpy() { env.lockCalls++; return { tryLock: function () { return true; }, releaseLock: function () {} }; }
  var ctx = vm.createContext({
    console: console, Date: Date, Math: Math, JSON: JSON,
    PropertiesService: { getScriptProperties: function () { return props(env.script, 'script'); }, getUserProperties: function () { return props(env.user, 'user'); } },
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
    SpreadsheetApp: { openById: function () { env.spreadsheetApp++; throw new Error('not allowed'); } },
    Session: { getActiveUser: function () { return { getEmail: function () { return 'owner@example.test'; } }; } },
    ScriptApp: {
      getOAuthToken: function () { env.fetches++; return 'x'; },
      getProjectTriggers: function () { env.triggers++; return []; },
      deleteTrigger: function () { env.triggers++; },
      newTrigger: function () { env.triggers++; throw new Error('no triggers'); }
    },
    Logger: { log: function (m) { env.logs.push(String(m)); } },
    UrlFetchApp: { fetch: function () { env.fetches++; throw new Error('NO_EXTERNAL_CALL'); } }
  });
  prepare.fileNames().filter(function (n) { return /\.gs$/.test(n); }).forEach(function (n) {
    vm.runInContext(fs.readFileSync(path.join(out, n), 'utf8'), ctx, { filename: n });
  });
  env.ctx = ctx;
  // 時刻を固定（経過秒の比較が実時計の秒境界でぶれないように）
  ctx.Date = class extends Date { constructor() { if (arguments.length) super(...arguments); else super(NOW_SEC * 1000); } static now() { return NOW_SEC * 1000; } };
  return env;
}

function post(env, body, query) {
  var e = { parameter: query === undefined ? { a: 'opsStatus' } : query, parameters: {}, postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } };
  Object.keys(e.parameter).forEach(function (k) { e.parameters[k] = [e.parameter[k]]; });
  return env.ctx.doPost(e).text;
}
function req(refs, over) { return Object.assign({ v: 1, token: TOKEN, refs: refs }, over || {}); }
function run(env, refs, over) { return JSON.parse(post(env, req(refs, over))); }

function seed(env, ref, o) {
  o = o || {};
  var recId = o.recId || (ref + ':' + (o.revision || 1) + ':****01FD:ISSUE#' + (o.attempt || 1));
  var op = {
    id: recId, bookingId: o.opBookingId || ref, revision: o.revision || 1, deviceId: SENT.dev, op: o.kind || 'ISSUE', attempt: 1, name: SENT.name,
    startSec: o.startSec === undefined ? NOW_SEC + 600 : o.startSec, endSec: o.endSec === undefined ? NOW_SEC + 7800 : o.endSec,
    state: o.state || 'ISSUED_CONFIRMED', passcodeId: SENT.pass, commandId: SENT.cmd, evidence: [SENT.evid, SENT.mail], reads: 1,
    history: [{ at: NOW_SEC - 100, from: null, to: 'PLANNED', basis: SENT.evid }], createdAt: NOW_SEC - 100, updatedAt: o.updatedAt === undefined ? NOW_SEC - 50 : o.updatedAt
  };
  if (!o.noOp) env.script['OP_' + recId] = JSON.stringify(op);
  if (o.delivery) env.script['DLV_' + recId] = JSON.stringify({ id: 'DLV_' + recId, opId: recId, bookingId: ref, seq: 1, state: o.delivery, history: [{ to: o.delivery, note: SENT.mail }] });
  var ids = (o.prior || []).concat([recId]);
  if (!o.noBk) env.script['BK_' + ref] = JSON.stringify({ bookingId: o.bkBookingId || ref, head: { revision: o.revision || 1 }, ops: ids });
  return recId;
}

// ================================================================ 入口の非干渉（doGet / Webhook / 分岐例外）

test('doGet は従来のヘルス応答のままバイト一致。状態参照には使えない', function () {
  var env = loadShell();
  assert.strictEqual(env.ctx.doGet().text, '{"ok":true}');
  assert.strictEqual(env.ctx.doGet({ parameter: { a: 'opsStatus' } }).text, '{"ok":true}');
  assert.strictEqual(env.scriptReads, 0);
});

function webhookSpy(env, accepted) {
  var calls = [];
  env.ctx.sba_runtime_ = function () { return { handleWebhook: function (raw, token, shared) { calls.push({ raw: raw, token: token, shared: shared }); return { accepted: accepted }; } }; };
  return calls;
}

test('正常なWebhook（aなし）は従来の経路だけを通り、応答形・引数が変わらない', function () {
  var env = loadShell({ user: { WEBHOOK_SHARED_TOKEN: 'W'.repeat(32) } });
  var calls = webhookSpy(env, true);
  var out = env.ctx.doPost({ parameter: { t: 'tok' }, postData: { contents: '{"eventType":"x"}' } }).text;
  assert.strictEqual(out, '{"ok":true}');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].raw, '{"eventType":"x"}');
  assert.strictEqual(calls[0].token, 'tok');
  assert.strictEqual(calls[0].shared, 'W'.repeat(32));
  var env2 = loadShell();
  webhookSpy(env2, false);
  assert.strictEqual(env2.ctx.doPost({ parameter: { t: 'bad' }, postData: { contents: '{}' } }).text, '{"ok":false}');
  // Webhook経路で例外が出ても従来どおり {"ok":false}
  var env3 = loadShell();
  env3.ctx.sba_runtime_ = function () { throw new Error('boom'); };
  assert.strictEqual(env3.ctx.doPost({ parameter: { t: 'x' }, postData: { contents: '{}' } }).text, '{"ok":false}');
  // event が空でも従来どおり（aなし）
  assert.strictEqual(env3.ctx.doPost({}).text, '{"ok":false}');
});

test('a=opsStatus は Webhook処理（handleWebhook・sba_runtime_）を一切呼ばない', function () {
  var env = loadShell();
  var calls = webhookSpy(env, true);
  var runtimeCalls = 0;
  var spy = env.ctx.sba_runtime_;
  env.ctx.sba_runtime_ = function () { runtimeCalls++; return spy(); };
  var out = JSON.parse(post(env, req([REF])));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(runtimeCalls, 0);
});

test('a が完全一致以外（別の値・空・大文字小文字違い・複数指定）は固定拒否。Webhook処理は呼ばない', function () {
  var env = loadShell();
  var calls = webhookSpy(env, true);
  ['', 'opsstatus', 'OpsStatus', 'opsStatus ', 'other'].forEach(function (a) {
    assert.strictEqual(post(env, req([REF]), { a: a, t: 'x' }), '{"ok":false,"code":"NOT_AVAILABLE"}', 'a=' + a);
  });
  var e = { parameter: { a: 'opsStatus' }, parameters: { a: ['x', 'opsStatus'] }, postData: { contents: JSON.stringify(req([REF])) } };
  assert.strictEqual(env.ctx.doPost(e).text, '{"ok":false,"code":"NOT_AVAILABLE"}');
  assert.strictEqual(calls.length, 0);
});

test('入口の判定で例外が出たら、Webhook経路へ落とさず固定拒否（fail-closed）', function () {
  var env = loadShell();
  var calls = webhookSpy(env, true);
  var e = { postData: { contents: '{}' } };
  Object.defineProperty(e, 'parameter', { get: function () { throw new Error('boom'); } });
  assert.strictEqual(env.ctx.doPost(e).text, '{"ok":false,"code":"NOT_AVAILABLE"}');
  var e2 = { parameter: { t: 'x' }, postData: { contents: '{}' } };
  Object.defineProperty(e2, 'parameters', { get: function () { throw new Error('boom'); } });
  assert.strictEqual(env.ctx.doPost(e2).text, '{"ok":false,"code":"NOT_AVAILABLE"}');
  assert.strictEqual(calls.length, 0);
});

test('運営用の入口は Webhook用の関数・ロックを経由しない（ソースの静的検査）', function () {
  var app = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/SwitchBotAccessApp.gs'), 'utf8');
  var start = app.indexOf('function sba_opsStatusPost_');
  var body = app.slice(start, app.indexOf('function doPost'));
  assert.ok(!/sba_runtime_|handleWebhook|runLocked|LockService|setProperty|deleteProperty|MailApp|UrlFetchApp|ScriptApp/.test(body));
  var logic = fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/AccessOpsStatus.gs'), 'utf8');
  assert.ok(!/store\.(set|del|keys)\(|setProperty|deleteProperty|getKeys|getProperties|LockService|MailApp|UrlFetchApp|ScriptApp|PropertiesService/.test(logic));
});

// ================================================================ 認証

test('認証の失敗は理由を区別できない同一の固定応答。認証前に状態ストア（Script Properties）へ触れない', function () {
  var FIXED = '{"ok":false,"code":"NOT_AVAILABLE"}';
  var env = loadShell();
  seed(env, REF);
  var bodies = [
    JSON.stringify(req([REF], { token: 'W'.repeat(40) })),             // 誤トークン
    JSON.stringify(req([REF], { token: 'short' })),                    // 短い
    JSON.stringify(req([REF], { token: 12345678901234567890123456789012 })), // 型違い
    JSON.stringify({ v: 1, refs: [REF] }),                             // トークンなし
    JSON.stringify(req([REF], { v: 2 })),                              // バージョン違い
    JSON.stringify(req([REF], { extra: 1 })),                          // 想定外のキー
    '{not json', '', '[]', 'null',                                     // 不正な本文
    JSON.stringify(req([REF])) + ' '.repeat(2100)                       // サイズ超過
  ];
  bodies.forEach(function (b) { assert.strictEqual(post(env, b), FIXED); });
  // ダイジェスト未設定・不正形式
  var unset = loadShell({ script: { ACCESS_OPS_STATUS_TOKEN_SHA256: '' } });
  seed(unset, REF);
  assert.strictEqual(post(unset, req([REF])), FIXED);
  var badDigest = loadShell({ script: { ACCESS_OPS_STATUS_TOKEN_SHA256: 'XYZ' } });
  assert.strictEqual(post(badDigest, req([REF])), FIXED);
  var upper = loadShell({ script: { ACCESS_OPS_STATUS_TOKEN_SHA256: DIGEST.toUpperCase() } });
  assert.strictEqual(post(upper, req([REF])), FIXED);
  [env, unset, badDigest, upper].forEach(function (e) { assert.strictEqual(e.scriptReads, 0, '認証前に状態ストアを読んだ'); assert.ok(!e.keysCalls, 'Properties列挙を呼んだ'); });
});

test('認証後でも、予約IDの形式・件数・長さの不正は要求全体を同じ固定応答で拒否する（部分応答しない）', function () {
  var FIXED = '{"ok":false,"code":"NOT_AVAILABLE"}';
  var env = loadShell();
  seed(env, REF);
  var many = [];
  for (var i = 0; i < 11; i++) many.push('SNB-20301111-AAAA00' + (10 + i));
  [[], many, ['bad'], [REF, 'bad'], ['snb-20301111-aaaa0001'], [REF + 'X'], ['SNB-20301111-AAAA000G'], [123], [REF, null], 'SNB', [REF.repeat(3)], ['A'.repeat(300)]].forEach(function (refs) {
    assert.strictEqual(post(env, req(refs)), FIXED, JSON.stringify(refs).slice(0, 40));
  });
  assert.strictEqual(env.scriptReads, 0);
  // 10件ちょうど・重複は受理（重複は除去）
  var ten = many.slice(0, 10);
  assert.strictEqual(run(env, ten).items.length, 10);
  var dup = run(env, [REF, REF]);
  assert.strictEqual(dup.items.length, 1);
});

test('Bookingの実際のID生成形式（SNB/MENS/SX/XX）はすべて受理される', function () {
  var ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'gas/booking/shared/Booking.gs'), 'utf8'), ctx);
  var env = loadShell();
  ['snb', 'mens', 'studio_x', 'unknown'].forEach(function (b) {
    var id = ctx.Booking.generateBookingId(b, '2030-01-11', crypto.randomUUID());
    assert.ok(env.ctx.AccessOpsStatus.BOOKING_ID_RE.test(id), id);
    assert.strictEqual(run(env, [id]).items[0].record, 'NONE');
  });
});

// ================================================================ 射影・秘密非露出・副作用0

test('応答は許可リストの項目だけ。PIN・passcodeId・commandId・完全deviceId・名前・証跡・メールは出ない', function () {
  var env = loadShell({ script: { HB_SYNC: JSON.stringify({ at: NOW_SEC - 120, ok: true }), SWITCHBOT_TOKEN: 'sbtok-942' } });
  env.user.SECRET_X = SENT.pin;
  seed(env, REF, { delivery: 'DELIVERED' });
  var out = post(env, req([REF]));
  var res = JSON.parse(out);
  assert.strictEqual(res.ok, true);
  [SENT.pin, SENT.cmd, SENT.pass, SENT.dev, SENT.name, SENT.evid, SENT.mail, 'sbtok-942', TOKEN, DIGEST, '01FD'].forEach(function (v) {
    assert.ok(out.indexOf(v) === -1, '出力に出てはいけない値: ' + v);
  });
  assert.ok(env.logs.join('\n').indexOf(REF) === -1);
  assert.deepStrictEqual(Object.keys(res).sort(), ['consistency', 'items', 'jobs', 'ok', 'readAtSec', 'v']);
  assert.deepStrictEqual(Object.keys(res.items[0]).sort(), ['opCount', 'ops', 'record', 'ref', 'truncated']);
  assert.deepStrictEqual(Object.keys(res.items[0].ops[0]).sort(), ['delivery', 'kind', 'rev', 'state', 'updatedAtSec', 'validFromSec', 'validToSec']);
  assert.strictEqual(res.items[0].ops[0].state, 'ISSUED_CONFIRMED');
  assert.strictEqual(res.items[0].ops[0].delivery, 'DELIVERED');
  assert.strictEqual(res.jobs.SYNC, 120);
  assert.strictEqual(res.jobs.SWEEP, null);
  assert.strictEqual(res.consistency, 'STABLE');
});

test('書込み・ロック・メール・トリガー・外部通信・Properties列挙は0回。ログは固定コードのみ', function () {
  var env = loadShell();
  seed(env, REF, { delivery: 'DELIVERED' });
  run(env, [REF]);
  post(env, req([REF], { token: 'x'.repeat(40) }));
  assert.strictEqual(env.propWrites, 0);
  assert.strictEqual(env.lockCalls, 0);
  assert.strictEqual(env.mails, 0);
  assert.strictEqual(env.triggers, 0);
  assert.strictEqual(env.fetches, 0);
  assert.strictEqual(env.spreadsheetApp, 0);
  assert.ok(!env.keysCalls);
  assert.deepStrictEqual(env.logs, ['accessOpsStatus OK', 'accessOpsStatus REJECTED']);
});

test('manifest（scopes・Webアプリ設定）は変えない', function () {
  var m = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas/switchbot-access/appsscript.json'), 'utf8'));
  assert.deepStrictEqual(m.oauthScopes, [
    'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets.readonly',
    'https://www.googleapis.com/auth/script.send_mail', 'https://www.googleapis.com/auth/script.scriptapp', 'https://www.googleapis.com/auth/userinfo.email'
  ]);
  assert.deepStrictEqual(m.webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
});

// ================================================================ 照合・欠落・不整合

test('記録なしは NONE（未発行とは言わない）。ほかの予約の結果と混ざらない', function () {
  var env = loadShell();
  seed(env, REF);
  var res = run(env, [REF, REF2]);
  assert.strictEqual(res.items[0].record, 'FOUND');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(res.items[1])), { ref: REF2, record: 'NONE', truncated: false, opCount: 0, ops: [] });
});

test('BK索引の不整合（OPの欠落・OPの予約ID不一致・索引の予約ID不一致・recId不正・壊れたJSON）は INVALID_INDEX', function () {
  var cases = [
    function (env) { seed(env, REF, { noOp: true }); },
    function (env) { seed(env, REF, { opBookingId: REF2 }); },
    function (env) { seed(env, REF, { bkBookingId: REF2 }); },
    function (env) { seed(env, REF, { recId: REF2 + ':1:****01FD:ISSUE#1' }); },
    function (env) { env.script['BK_' + REF] = '{broken'; },
    function (env) { env.script['BK_' + REF] = JSON.stringify({ bookingId: REF, ops: 'x' }); },
    function (env) { var id = seed(env, REF); env.script['BK_' + REF] = JSON.stringify({ bookingId: REF, ops: [id, id] }); }
  ];
  cases.forEach(function (setup, i) {
    var env = loadShell();
    setup(env);
    var item = run(env, [REF]).items[0];
    assert.strictEqual(item.record, 'INVALID_INDEX', 'case ' + i);
    assert.deepStrictEqual(item.ops, [], 'case ' + i);
  });
});

test('同じ改訂で生きているISSUE OPが複数なら AMBIGUOUS（失敗・放棄・削除確定済みは数えない）', function () {
  var env = loadShell();
  var first = seed(env, REF, { attempt: 1, state: 'UNKNOWN' });
  seed(env, REF, { attempt: 2, state: 'PLANNED', prior: [first] });
  assert.strictEqual(run(env, [REF]).items[0].record, 'AMBIGUOUS');
  var env2 = loadShell();
  var f2 = seed(env2, REF, { attempt: 1, state: 'FAILED' });
  seed(env2, REF, { attempt: 2, state: 'ISSUED_CONFIRMED', prior: [f2] });
  assert.strictEqual(run(env2, [REF]).items[0].record, 'FOUND');
  var env3 = loadShell();
  var d3 = seed(env3, REF, { attempt: 1, state: 'DELETED_CONFIRMED' });
  seed(env3, REF, { attempt: 2, state: 'ISSUED_CONFIRMED', prior: [d3] });
  assert.strictEqual(run(env3, [REF]).items[0].record, 'FOUND');
});

test('改訂（変更・延長）をまたぐ複数OPは改訂ごとに返す（rev・kind・state）。取消後のREVOKEも区別できる', function () {
  var env = loadShell();
  var r1 = seed(env, REF, { revision: 1, state: 'DELETED_CONFIRMED' });
  var rv = seed(env, REF, { revision: 1, kind: 'REVOKE', attempt: 1, recId: REF + ':1:****01FD:REVOKE#1', state: 'DELETED_CONFIRMED', prior: [r1] });
  seed(env, REF, { revision: 2, state: 'ISSUED_CONFIRMED', prior: [r1, rv] });
  var ops = run(env, [REF]).items[0].ops.map(function (o) { return o.rev + ':' + o.kind + ':' + o.state; });
  assert.deepStrictEqual(ops, ['1:ISSUE:DELETED_CONFIRMED', '1:REVOKE:DELETED_CONFIRMED', '2:ISSUE:ISSUED_CONFIRMED']);
});

test('未知の状態・種別・配送状態は UNRECOGNIZED（生の値を返さない）。時刻が不正なら null', function () {
  var env = loadShell();
  var id = seed(env, REF, { state: 'WEIRD_STATE_942', delivery: 'WEIRD_DLV_942', startSec: 'x', endSec: -5 });
  var op = JSON.parse(env.script['OP_' + id]); op.op = 'WEIRD_KIND_942'; op.revision = 'x'; env.script['OP_' + id] = JSON.stringify(op);
  var out = post(env, req([REF]));
  assert.ok(out.indexOf('WEIRD') === -1);
  var o = JSON.parse(out).items[0].ops[0];
  assert.strictEqual(o.state, 'UNRECOGNIZED');
  assert.strictEqual(o.kind, 'UNRECOGNIZED');
  assert.strictEqual(o.rev, null);
  assert.strictEqual(o.validFromSec, null);
  assert.strictEqual(o.validToSec, null);
  assert.strictEqual(o.delivery, null); // ISSUEではない種別のDLVは読まない
});

test('8件を超えるOP履歴は truncated=true と opCount（索引上の総数）を返し、最新8件だけを読む', function () {
  var env = loadShell();
  var prior = [];
  for (var i = 1; i <= 9; i++) prior.push(seed(env, REF, { attempt: i, state: i === 9 ? 'ISSUED_CONFIRMED' : 'FAILED', prior: prior.slice() }));
  var item = run(env, [REF]).items[0];
  assert.strictEqual(item.truncated, true);
  assert.strictEqual(item.opCount, 9);
  assert.strictEqual(item.ops.length, 8);
  assert.strictEqual(item.ops[7].state, 'ISSUED_CONFIRMED');
  // ちょうど8件は truncated にならない
  var env2 = loadShell();
  var p2 = [];
  for (var j = 1; j <= 8; j++) p2.push(seed(env2, REF, { attempt: j, state: j === 8 ? 'ISSUED_CONFIRMED' : 'FAILED', prior: p2.slice() }));
  var item2 = run(env2, [REF]).items[0];
  assert.strictEqual(item2.truncated, false);
  assert.strictEqual(item2.opCount, 8);
});

test('読取途中の更新: 1回の変化は読み直して STABLE、読むたびに変わる場合は CHANGED_DURING_READ', function () {
  var env = loadShell();
  var id = seed(env, REF, { state: 'SENT_WAIT_WEBHOOK' });
  var flips = 0;
  env.onRead = function (k) {
    if (k === 'OP_' + id && flips < 1) { flips++; var op = JSON.parse(env.script['OP_' + id]); op.state = 'ISSUED_CONFIRMED'; op.updatedAt++; env.script['OP_' + id] = JSON.stringify(op); }
  };
  // 1回目の読取り直後に変化 → 再読取りで安定
  var res = run(env, [REF]);
  assert.strictEqual(res.consistency, 'STABLE');
  assert.strictEqual(res.items[0].ops[0].state, 'ISSUED_CONFIRMED');
  // 読むたびに変わる
  var env2 = loadShell();
  var id2 = seed(env2, REF, { state: 'SENT_WAIT_WEBHOOK' });
  var n = 0;
  env2.onRead = function (k) { if (k === 'OP_' + id2) { n++; var op = JSON.parse(env2.script['OP_' + id2]); op.updatedAt = NOW_SEC + n; env2.script['OP_' + id2] = JSON.stringify(op); } };
  assert.strictEqual(run(env2, [REF]).consistency, 'CHANGED_DURING_READ');
});

test('状態ストアの読取りが例外になっても、例外本文を返さず固定拒否', function () {
  var env = loadShell();
  seed(env, REF);
  env.onRead = function () { throw new Error('STORE_FAILURE_SECRET_942'); };
  var out = post(env, req([REF]));
  assert.strictEqual(out, '{"ok":false,"code":"NOT_AVAILABLE"}');
  assert.ok(env.logs.join('\n').indexOf('STORE_FAILURE_SECRET_942') === -1);
});
