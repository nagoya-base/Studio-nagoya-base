/*
 * Issue #971 Phase 2: 自動保存の入口 opsSaveKeyFinalStatusesScheduled（15分間隔の時間主導トリガー用）のテスト。
 * 実GAS・実Access・実台帳には接続しない。予約ID・トークン・URLはすべて架空のダミー。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var DIR = path.join(__dirname, '..', 'gas', 'ops-reservations');
var REF = 'SNB-20261130-AAAA0001';
var TOKEN = 'T'.repeat(40);
var URL_OK = 'https://script.google.com/macros/s/AKfycbFAKE971/exec';

function load(globals) {
  var sb = { Logger: { log: function () { sb._logs.push([].slice.call(arguments).join(' ')); } }, _logs: [] };
  Object.keys(globals || {}).forEach(function (k) { sb[k] = globals[k]; });
  vm.createContext(sb);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsKeyStatus.gs', 'OpsKeyFinal.gs', 'OpsKeyFinalStore.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
  });
  return sb;
}
function props(map) { return { getScriptProperties: function () { return { getProperty: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; } }; } }; }
function session(active, effective) {
  return { getActiveUser: function () { return { getEmail: function () { return active; } }; }, getEffectiveUser: function () { return { getEmail: function () { return effective; } }; } };
}
/* run を差し替えて、入口の変換だけを検証する */
function scheduled(runResult, extra) {
  var sb = load({ PropertiesService: props({ OPS_SPREADSHEET_ID: 'FAKE_SPREADSHEET_ID_971' }), ScriptApp: { getOAuthToken: function () { return 'tok'; } },
    UrlFetchApp: { fetch: function () { throw new Error('no fetch'); } }, LockService: { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } } });
  var calls = [];
  sb.OpsKeyFinal.run = function (deps) { calls.push(deps); return typeof runResult === 'function' ? runResult(deps) : runResult; };
  var ctx = Object.assign({ authenticate: function () { return { ok: true }; }, getFlag: function () { return 'ON'; } }, extra || {});
  var out, err = null;
  try { out = JSON.parse(JSON.stringify(sb.OpsApi.runKeyFinalSaveScheduled(ctx))); } catch (e) { err = e; }
  return { sb: sb, calls: calls, out: out, err: err };
}
var DONE = { ok: true, code: 'DONE', candidates: 3, offset: 0, processed: 3, saved: 1, deferred: 0, skipped: { NO_RECORD: 2 }, stoppedBy: null };

test('トリガー入口: 引数なしで呼べる関数として公開され、15分トリガーに登録できる（グローバル関数）', function () {
  var sb = load({ PropertiesService: props({}) });
  assert.strictEqual(typeof sb.opsSaveKeyFinalStatusesScheduled, 'function');
  assert.strictEqual(sb.opsSaveKeyFinalStatusesScheduled.length, 0);
});

test('トリガー入口: 保存処理は offset 0・既存の OpsKeyFinal.run をそのまま呼ぶ（呼び出し側が offset を変えられない）', function () {
  var t = scheduled(DONE, { offset: 20 });
  assert.strictEqual(t.err, null);
  assert.strictEqual(t.calls.length, 1); assert.strictEqual(t.calls[0].offset, 0);
  assert.strictEqual(t.out.saved, 1);
});

test('トリガー入口: 設定が ON 以外なら即スキップ（認可・台帳・Accessに触れず、例外にしない）', function () {
  ['OFF', '', null, undefined, 'on', 'true'].forEach(function (flag) {
    var authCalls = 0;
    var t = scheduled(function () { throw new Error('must not run'); }, { getFlag: function () { return flag; }, authenticate: function () { authCalls++; return { ok: true }; } });
    assert.strictEqual(t.err, null, String(flag));
    assert.deepStrictEqual(t.out, { ok: true, skipped: true, code: 'WRITE_DISABLED' });
    assert.strictEqual(t.calls.length, 0); assert.strictEqual(authCalls, 0);
    assert.deepStrictEqual(t.sb._logs, ['ops key_final_save SCHEDULED SKIPPED WRITE_DISABLED']);
  });
});

test('トリガー入口: BUSY（手動実行と重複）は正常スキップで、例外にしない', function () {
  var t = scheduled({ ok: false, code: 'BUSY' });
  assert.strictEqual(t.err, null);
  assert.deepStrictEqual(t.out, { ok: true, skipped: true, code: 'BUSY' });
});

test('トリガー入口: ok:false（BUSY以外）は固定コードだけの例外にする（標準の失敗通知が届く）', function () {
  ['UNAUTHENTICATED', 'FORBIDDEN', 'ACCESS_NOT_CONNECTED', 'ACCESS_CONFIG_INVALID', 'LEDGER_NOT_CONNECTED', 'LEDGER_READ_FAILED', 'COLUMN_MISSING', 'OFFSET_INVALID'].forEach(function (code) {
    var t = scheduled({ ok: false, code: code });
    assert.ok(t.err && typeof t.err.message === 'string', code);
    assert.strictEqual(t.err.message, 'OPS_KEY_FINAL_SCHEDULED_FAILED:' + code);
  });
  /* 想定外の形（コード不正・値なし）は UNKNOWN。予約ID・URL・秘密は例外文に入らない */
  [{ ok: false, code: REF }, { ok: false, code: 'bad code ' + TOKEN }, { ok: false }].forEach(function (r) {
    var t = scheduled(r);
    assert.strictEqual(t.err.message, 'OPS_KEY_FINAL_SCHEDULED_FAILED:UNKNOWN');
  });
});

test('トリガー入口: ok:true でも stoppedBy があれば固定コードだけの例外にする', function () {
  var t = scheduled(Object.assign({}, DONE, { stoppedBy: 'WRITE_HTTP/403' }));
  assert.strictEqual(t.err.message, 'OPS_KEY_FINAL_SCHEDULED_FAILED:WRITE_HTTP/403');
  var hostile = scheduled(Object.assign({}, DONE, { stoppedBy: 'SECRET ' + REF + ' ' + URL_OK + ' ' + TOKEN }));
  assert.strictEqual(hostile.err.message, 'OPS_KEY_FINAL_SCHEDULED_FAILED:UNKNOWN');
  [REF, URL_OK, TOKEN, 'SECRET'].forEach(function (v) { assert.ok(hostile.err.message.indexOf(v) === -1, v); assert.ok(hostile.sb._logs.join('\n').indexOf(v) === -1, v); });
});

test('トリガー入口: 保存0件・保存あり・skipped があるだけの正常結果は例外にしない', function () {
  [DONE, Object.assign({}, DONE, { saved: 0, candidates: 0, processed: 0, skipped: {} })].forEach(function (r) {
    var t = scheduled(r);
    assert.strictEqual(t.err, null); assert.strictEqual(t.out.ok, true);
  });
});

test('トリガー認証: 実行主体（getEffectiveUser）が OPS_OWNER_EMAIL と一致するときだけ通る。getActiveUser が空でも所有者なら通る', function () {
  function auth(owner, active, effective) {
    var sb = load({ PropertiesService: props({ OPS_OWNER_EMAIL: owner }), Session: session(active, effective) });
    return JSON.parse(JSON.stringify(sb.OpsAuth.createGasTriggerAuthenticator()()));
  }
  assert.deepStrictEqual(auth('owner@example.test', '', 'Owner@Example.test '), { ok: true });
  assert.deepStrictEqual(auth('owner@example.test', 'other@example.test', 'owner@example.test'), { ok: true });
  assert.deepStrictEqual(auth('owner@example.test', 'owner@example.test', 'other@example.test'), { ok: false, code: 'FORBIDDEN' });
  assert.deepStrictEqual(auth('owner@example.test', 'owner@example.test', ''), { ok: false, code: 'UNAUTHENTICATED' });
  assert.deepStrictEqual(auth(null, '', 'owner@example.test'), { ok: false, code: 'FORBIDDEN' });
  assert.deepStrictEqual(auth('', '', ''), { ok: false, code: 'UNAUTHENTICATED' });
  var thrower = load({ PropertiesService: props({ OPS_OWNER_EMAIL: 'owner@example.test' }), Session: { getEffectiveUser: function () { throw new Error('boom'); } } });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(thrower.OpsAuth.createGasTriggerAuthenticator()())), { ok: false, code: 'UNAUTHENTICATED' });
});

test('トリガー入口: 非所有者は何も保存せず固定コードで失敗する（実 OpsKeyFinal.run 経由。台帳・Accessに触れない）', function () {
  var sb = load({ PropertiesService: props({ OPS_OWNER_EMAIL: 'owner@example.test', OPS_KEY_FINAL_STATUS_WRITE: 'ON' }), Session: session('owner@example.test', 'other@example.test'),
    UrlFetchApp: { fetch: function () { throw new Error('no fetch'); } } });
  assert.throws(function () { sb.opsSaveKeyFinalStatusesScheduled(); }, function (e) { return e.message === 'OPS_KEY_FINAL_SCHEDULED_FAILED:FORBIDDEN'; });
  var empty = load({ PropertiesService: props({ OPS_OWNER_EMAIL: 'owner@example.test', OPS_KEY_FINAL_STATUS_WRITE: 'ON' }), Session: session('', ''),
    UrlFetchApp: { fetch: function () { throw new Error('no fetch'); } } });
  assert.throws(function () { empty.opsSaveKeyFinalStatusesScheduled(); }, function (e) { return e.message === 'OPS_KEY_FINAL_SCHEDULED_FAILED:UNAUTHENTICATED'; });
});

test('トリガー入口: 設定OFFの本番入口は、認可情報がなくても通信せず正常終了する', function () {
  var fetched = 0;
  var sb = load({ PropertiesService: props({}), Session: session('', ''), UrlFetchApp: { fetch: function () { fetched++; throw new Error('no fetch'); } } });
  var res = JSON.parse(JSON.stringify(sb.opsSaveKeyFinalStatusesScheduled()));
  assert.deepStrictEqual(res, { ok: true, skipped: true, code: 'WRITE_DISABLED' });
  assert.strictEqual(fetched, 0);
});

test('非回帰: 手動関数は従来どおり（引数・offset・戻り値）。画面の認証器は変更なし。トリガー作成コードと新スコープはない', function () {
  var api = fs.readFileSync(path.join(DIR, 'OpsApi.gs'), 'utf8');
  assert.ok(/function opsSaveKeyFinalStatuses\(\) \{ return OpsApi\.runKeyFinalSave\(\); \}/.test(api));
  assert.ok(/runKeyFinalSave\(\{ offset: 10 \}\)/.test(api) && /runKeyFinalSave\(\{ offset: 20 \}\)/.test(api));
  assert.ok(/createGasSessionAuthenticator\(\)\(\);/.test(api), 'doGet は従来の認証器');
  var handleBody = api.slice(api.indexOf('function handle('), api.indexOf('function runKeyFinalSave'));
  assert.ok(!/Scheduled|OpsKeyFinal\.run/.test(handleBody), 'handle は保存処理・自動入口を呼ばない');
  var all = fs.readdirSync(DIR).filter(function (f) { return /\.(gs|html)$/.test(f); }).map(function (f) { return fs.readFileSync(path.join(DIR, f), 'utf8'); }).join('\n');
  assert.ok(!/ScriptApp\.(newTrigger|deleteTrigger|getProjectTriggers)/.test(all), 'トリガーの自動作成・削除コードなし');
  var manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8'));
  assert.deepStrictEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email']);
  var sc = fs.readFileSync(path.join(DIR, 'OpsAuth.gs'), 'utf8');
  assert.ok(/getActiveEmail: function \(\) \{ return Session\.getActiveUser\(\)\.getEmail\(\); \}/.test(sc));
});
