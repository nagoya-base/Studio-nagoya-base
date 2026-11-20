/*
 * Issue #942: 運営アプリの「鍵・案内の状況」（OpsKeyStatus / OpsApi key_status / 画面）のテスト。
 * 実GAS・実Access・実台帳には接続しない。予約・トークン・URLはすべて架空のダミー。
 * 検査の主眼: ①取得（リダイレクトでトークンを再送しない・接続先の限定・失敗の固定コード）②照合（取消・変更・延長・8件超・欠落を成功扱いしない）
 * ③認可と秘密非露出 ④取得失敗が予約詳細を壊さない ⑤画面で「未接続/未取得/確認不能/要確認/不一致」が別表示。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var contract = require('./helpers/ops-contract');

var DIR = path.join(__dirname, '..', 'gas', 'ops-reservations');
var FRONT = path.join(__dirname, '..', '_ops-app', 'frontend');
var C = require(path.join(FRONT, 'ops-client.js'));
var Mock = require(path.join(FRONT, 'mock-adapter.js'));
var Gas = require(path.join(FRONT, 'gas-adapter.js'));

var NOW = Date.UTC(2026, 11, 1, 2, 0, 0); /* 2026-12-01 11:00 JST */
var URL_OK = 'https://script.google.com/macros/s/AKfycbFAKE942/exec';
var LOC_OK = 'https://script.googleusercontent.com/macros/echo?user_content_key=FAKE-KEY';
var TOKEN = 'T'.repeat(40);
var REF = 'SNB-20261202-AAAA0001';
var DAY = 24 * 3600 * 1000;

function load(globals) {
  var RealDate = Date;
  function FixedDate() { return arguments.length === 0 ? new RealDate(NOW) : new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))(); }
  FixedDate.prototype = RealDate.prototype; FixedDate.now = function () { return NOW; }; FixedDate.UTC = RealDate.UTC;
  var sb = { Date: FixedDate, Logger: { log: function () { sb._logs.push([].slice.call(arguments).join(' ')); } }, _logs: [] };
  Object.keys(globals || {}).forEach(function (k) { sb[k] = globals[k]; });
  vm.createContext(sb);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsKeyStatus.gs', 'OpsKeyFinal.gs', 'OpsKeyFinalStore.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
  });
  return sb;
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }

// ================================================================ 取得（fetchAccess）

function fakeRes(code, body, headers) {
  return { getResponseCode: function () { return code; }, getContentText: function () { return typeof body === 'string' ? body : JSON.stringify(body); }, getHeaders: function () { return headers || {}; } };
}
function accessBody(over) {
  return Object.assign({ ok: true, v: 1, readAtSec: 1000, consistency: 'STABLE', jobs: { SYNC: 120, SWEEP: null, DELIVER: 60, CLEANUP: null },
    items: [{ ref: REF, record: 'FOUND', truncated: false, opCount: 1, ops: [{ rev: 1, kind: 'ISSUE', state: 'ISSUED_CONFIRMED', validFromSec: Math.floor(Date.UTC(2026, 11, 2, 0, 45) / 1000), validToSec: Math.floor(Date.UTC(2026, 11, 2, 3, 15) / 1000), updatedAtSec: 5, delivery: 'DELIVERED' }] }] }, over || {});
}
function fetchWith(handlers, cfg) {
  var sb = load();
  var calls = [];
  var i = 0;
  var deps = Object.assign({ url: URL_OK, token: TOKEN, fetch: function (u, o) {
    calls.push({ url: u, options: o });
    var h = handlers[Math.min(i++, handlers.length - 1)];
    if (typeof h === 'function') return h(u, o);
    return h;
  } }, cfg || {});
  var res = plain(sb.OpsKeyStatus.fetchAccess(deps, REF));
  return { res: res, calls: calls, sb: sb };
}

test('取得: 直接200・本文はPOSTのみ（トークンはクエリ・URL・ヘッダーに載せない）', function () {
  var r = fetchWith([fakeRes(200, accessBody())]);
  assert.strictEqual(r.res.ok, true);
  assert.strictEqual(r.calls.length, 1);
  assert.strictEqual(r.calls[0].url, URL_OK + '?a=opsStatus');
  assert.strictEqual(r.calls[0].options.method, 'post');
  assert.strictEqual(r.calls[0].options.followRedirects, false);
  assert.ok(r.calls[0].url.indexOf(TOKEN) === -1);
  assert.deepStrictEqual(JSON.parse(r.calls[0].options.payload), { v: 1, token: TOKEN, refs: [REF] });
  assert.ok(!r.calls[0].options.headers);
});

test('取得: 302は Google のコンテンツ配信ホストのときだけ、本文なしのGETで読む（トークンを再送しない）', function () {
  var r = fetchWith([fakeRes(302, '', { Location: LOC_OK }), fakeRes(200, accessBody())]);
  assert.strictEqual(r.res.ok, true);
  assert.strictEqual(r.calls.length, 2);
  assert.strictEqual(r.calls[1].url, LOC_OK);
  assert.strictEqual(r.calls[1].options.method, 'get');
  assert.strictEqual(r.calls[1].options.payload, undefined);
  assert.strictEqual(r.calls[1].options.followRedirects, false);
  assert.ok(JSON.stringify(r.calls[1]).indexOf(TOKEN) === -1, '2回目の要求にトークンが含まれている');
  assert.ok(!r.calls[1].options.headers);
});

test('取得: 想定外のリダイレクト先・不明な3xx・Locationなしは中止（2回目の要求を出さない）', function () {
  [
    fakeRes(302, '', { Location: 'https://evil.example.test/steal' }),
    fakeRes(302, '', { Location: 'http://script.googleusercontent.com/x' }),
    fakeRes(302, '', { Location: 'https://script.googleusercontent.com.evil.test/x' }),
    fakeRes(302, '', { Location: 'https://evil.test/https://script.googleusercontent.com/' }),
    fakeRes(302, '', {}), fakeRes(307, '', { Location: LOC_OK }), fakeRes(308, '', { Location: LOC_OK }), fakeRes(301, '', { Location: LOC_OK })
  ].forEach(function (h, i) {
    var r = fetchWith([h]);
    assert.deepStrictEqual(r.res, { ok: false, reason: 'REDIRECT_REJECTED' }, 'case ' + i);
    assert.strictEqual(r.calls.length, 1, 'case ' + i);
  });
  // リダイレクト先がさらにリダイレクトしても追わない
  var r2 = fetchWith([fakeRes(302, '', { Location: LOC_OK }), fakeRes(302, '', { Location: 'https://evil.test/' })]);
  assert.deepStrictEqual(r2.res, { ok: false, reason: 'REDIRECT_REJECTED' });
  assert.strictEqual(r2.calls.length, 2);
});

test('取得: 接続先URL・トークンの形式が不正なら通信せず CONFIG_INVALID', function () {
  ['http://script.google.com/macros/s/AK/exec', 'https://evil.example.test/macros/s/AK/exec', 'https://script.google.com/macros/s/AK/exec?x=1',
    'https://script.google.com/macros/s/AK/dev', 'https://script.google.com.evil.test/macros/s/AK/exec', '', null].forEach(function (u) {
    var r = fetchWith([fakeRes(200, accessBody())], { url: u });
    assert.deepStrictEqual(r.res, { ok: false, reason: 'CONFIG_INVALID' });
    assert.strictEqual(r.calls.length, 0);
  });
  var short = fetchWith([fakeRes(200, accessBody())], { token: 'short' });
  assert.deepStrictEqual(short.res, { ok: false, reason: 'CONFIG_INVALID' });
  assert.strictEqual(short.calls.length, 0);
  // Workspace形式のURLは許可
  assert.strictEqual(fetchWith([fakeRes(200, accessBody())], { url: 'https://script.google.com/a/macros/example.test/s/AK/exec' }).res.ok, true);
});

test('取得: 失敗は固定コードのみ（例外本文・応答本文を保持しない）', function () {
  var net = fetchWith([function () { throw new Error('SECRET-NETWORK-DETAIL'); }]);
  assert.deepStrictEqual(net.res, { ok: false, reason: 'NETWORK' });
  assert.ok(JSON.stringify(net.res).indexOf('SECRET') === -1);
  assert.deepStrictEqual(fetchWith([fakeRes(500, 'SECRET-BODY')]).res, { ok: false, reason: 'HTTP_STATUS' });
  assert.deepStrictEqual(fetchWith([fakeRes(200, 'not json SECRET-BODY')]).res, { ok: false, reason: 'RESPONSE_INVALID' });
  assert.deepStrictEqual(fetchWith([fakeRes(200, 'x'.repeat(70000))]).res, { ok: false, reason: 'RESPONSE_INVALID' });
  assert.deepStrictEqual(fetchWith([fakeRes(200, { ok: false, code: 'NOT_AVAILABLE' })]).res, { ok: false, reason: 'NOT_AVAILABLE' });
  assert.deepStrictEqual(fetchWith([fakeRes(200, { ok: false, code: 'SECRET-CODE' })]).res, { ok: false, reason: 'NOT_AVAILABLE' });
});

test('取得: 応答の形が許可リストと違えば RESPONSE_INVALID（別の予約・未知の列挙・件数超過・複数items）', function () {
  var bad = [
    accessBody({ items: [{ ref: 'SNB-20261202-BBBB0002', record: 'NONE', truncated: false, opCount: 0, ops: [] }] }),
    accessBody({ items: [] }), accessBody({ v: 2 }), accessBody({ consistency: 'MAYBE' }),
    accessBody({ items: [{ ref: REF, record: 'WEIRD', truncated: false, opCount: 0, ops: [] }] }),
    accessBody({ items: [{ ref: REF, record: 'FOUND', truncated: 'no', opCount: 0, ops: [] }] }),
    accessBody({ items: [{ ref: REF, record: 'FOUND', truncated: false, opCount: 9, ops: new Array(9).fill({ rev: 1, kind: 'ISSUE', state: 'FAILED', validFromSec: null, validToSec: null, updatedAtSec: 1, delivery: null }) }] }),
    accessBody({ items: [{ ref: REF, record: 'FOUND', truncated: false, opCount: 1, ops: [{ rev: 1, kind: 'ISSUE', state: 'MADE_UP', validFromSec: 1, validToSec: 2, updatedAtSec: 1, delivery: null }] }] }),
    accessBody({ items: [{ ref: REF, record: 'FOUND', truncated: false, opCount: 1, ops: [{ rev: 1, kind: 'ISSUE', state: 'FAILED', validFromSec: 1, validToSec: 2, updatedAtSec: 1, delivery: 'MADE_UP' }] }] }),
    accessBody({ items: [accessBody().items[0], accessBody().items[0]] })
  ];
  bad.forEach(function (b, i) { assert.deepStrictEqual(fetchWith([fakeRes(200, b)]).res, { ok: false, reason: 'RESPONSE_INVALID' }, 'case ' + i); });
});

test('取得: 応答に余分な項目（passcodeId等）が混ざっても捨てる。結果に残らない', function () {
  var b = accessBody();
  b.items[0].ops[0].passcodeId = 'SECRET-PASSCODE'; b.items[0].secret = 'SECRET-X'; b.extra = 'SECRET-Y';
  var r = fetchWith([fakeRes(200, b)]);
  assert.strictEqual(r.res.ok, true);
  assert.ok(JSON.stringify(r.res).indexOf('SECRET') === -1);
});

// ================================================================ 照合（evaluate）

function rec(over) {
  return Object.assign({ status: 'CONFIRMED', startMs: Date.UTC(2026, 11, 2, 1, 0), endMs: Date.UTC(2026, 11, 2, 3, 0), revision: 1 }, over || {}); /* 12/2 10:00-12:00 JST */
}
function op(over) {
  return Object.assign({ rev: 1, kind: 'ISSUE', state: 'ISSUED_CONFIRMED', validFromSec: Math.floor(Date.UTC(2026, 11, 2, 0, 45) / 1000), validToSec: Math.floor(Date.UTC(2026, 11, 2, 3, 15) / 1000),
    updatedAtSec: 100, delivery: 'DELIVERED' }, over || {});
}
function data(ops, over) {
  return Object.assign({ consistency: 'STABLE', readAtSec: 1000, jobs: { SYNC: 120, SWEEP: null, DELIVER: 60, CLEANUP: null }, item: { record: 'FOUND', truncated: false, opCount: ops.length, ops: ops } }, over || {});
}
function verdict(r, d, now) { var sb = load(); var out = plain(sb.OpsKeyStatus.evaluate(r, d, now === undefined ? NOW : now)); return { code: out.verdict.code, reasons: out.reasons.map(function (x) { return x.code; }), out: out }; }

var AFTER_END = Date.UTC(2026, 11, 2, 4, 0);

test('照合: 正常系の各状態を区別する（発行待ち/登録未確認/案内未送信/案内済み/失効未確認/失効確認済み）', function () {
  var cases = [
    ['ISSUED_GUIDED', rec(), [op()]],
    ['GUIDE_NOT_SENT', rec(), [op({ delivery: 'NOT_SENT' })]],
    ['ISSUED_GUIDE_UNKNOWN', rec(), [op({ delivery: null })]],
    ['ISSUE_PENDING', rec(), [op({ state: 'SENT_WAIT_WEBHOOK', delivery: null })]],
    ['ISSUE_PENDING', rec(), [op({ state: 'PLANNED', delivery: null })]],
    ['ISSUE_UNCONFIRMED', rec(), [op({ state: 'UNKNOWN', delivery: null })]],
    ['ISSUE_UNCONFIRMED', rec(), [op({ state: 'FAILED', delivery: null })]],
    ['REVOKE_UNCONFIRMED', rec(), [op({ state: 'DELETE_SENT' })], AFTER_END],
    ['REVOKE_UNCONFIRMED', rec(), [op({ state: 'ISSUED_CONFIRMED' })], AFTER_END],
    ['REVOKED_CONFIRMED', rec(), [op({ state: 'DELETED_CONFIRMED' })], AFTER_END],
    ['REVOKED_CONFIRMED', rec({ status: 'CANCELLED' }), [op({ state: 'DELETED_CONFIRMED' })]],
    ['REVOKE_UNCONFIRMED', rec({ status: 'CANCELLED' }), [op({ state: 'DELETE_PENDING' })]],
    ['REVOKE_UNCONFIRMED', rec({ status: 'EXPIRED' }), [op({ state: 'EXPIRED' })]]
  ];
  cases.forEach(function (c, i) { assert.strictEqual(verdict(c[1], data(c[2]), c[3]).code, c[0], 'case ' + i + ' ' + c[0]); });
});

test('照合: 予約の変更・延長・取消との不一致は MISMATCH（正常扱いにしない）', function () {
  // 延長後: 台帳の終了が延びたのに、鍵の有効時間が旧いまま
  var ext = verdict(rec({ endMs: Date.UTC(2026, 11, 2, 5, 0) }), data([op()]));
  assert.strictEqual(ext.code, 'MISMATCH'); assert.deepStrictEqual(ext.reasons, ['WINDOW_NOT_COVERING']);
  // 開始が前倒し
  assert.strictEqual(verdict(rec({ startMs: Date.UTC(2026, 11, 2, 0, 0) }), data([op()])).code, 'MISMATCH');
  // 変更後: 台帳はrevision 2、鍵はrevision 1のみ
  var rev = verdict(rec({ revision: 2 }), data([op({ rev: 1 })]));
  assert.strictEqual(rev.code, 'MISMATCH'); assert.deepStrictEqual(rev.reasons, ['REVISION_MISMATCH']);
  // 旧改訂の鍵が残存
  var old = verdict(rec({ revision: 2 }), data([op({ rev: 1 }), op({ rev: 2 })]));
  assert.strictEqual(old.code, 'MISMATCH'); assert.deepStrictEqual(old.reasons, ['OLD_REVISION_KEY_REMAINS']);
  // 旧改訂は削除済みで、現行改訂が確認済み → 正常
  assert.strictEqual(verdict(rec({ revision: 2 }), data([op({ rev: 1, state: 'DELETED_CONFIRMED' }), op({ rev: 2 })])).code, 'ISSUED_GUIDED');
  // 取消なのに鍵が有効／発行中
  assert.deepStrictEqual(verdict(rec({ status: 'CANCELLED' }), data([op()])).reasons, ['CANCELLED_KEY_REMAINS']);
  assert.strictEqual(verdict(rec({ status: 'CANCELLED' }), data([op({ state: 'SENT_WAIT_WEBHOOK' })])).code, 'MISMATCH');
  assert.strictEqual(verdict(rec({ status: 'EXPIRED' }), data([op()])).code, 'MISMATCH');
  // 確定なのに鍵が失効済み／失効処理中（利用前）
  assert.strictEqual(verdict(rec(), data([op({ state: 'DELETED_CONFIRMED' })])).code, 'MISMATCH');
  assert.strictEqual(verdict(rec(), data([op({ state: 'DELETE_PENDING' })])).code, 'MISMATCH');
});

test('照合: 記録なしは「確認不能」。未発行・案内済み・失効済みと断定しない', function () {
  var none = verdict(rec(), data([], { item: { record: 'NONE', truncated: false, opCount: 0, ops: [] } }));
  assert.strictEqual(none.code, 'NO_HISTORY'); assert.deepStrictEqual(none.reasons, ['NO_RECORD', 'NO_RECORD_NEXT']);
  assert.ok(!/未発行です|発行されていません/.test(JSON.stringify(none.out)));
  // 取消済みの予約でも同じ（失効済みとは断定しない）
  assert.strictEqual(verdict(rec({ status: 'CANCELLED' }), data([], { item: { record: 'NONE', truncated: false, opCount: 0, ops: [] } })).code, 'NO_HISTORY');
  // FOUNDだが発行記録が無い（確定）→ 要確認。放棄のみの取消 → 確認不能（未発行と断定しない）
  assert.strictEqual(verdict(rec(), data([])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec({ status: 'CANCELLED' }), data([op({ state: 'ABANDONED' })])).code, 'UNVERIFIABLE');
});

test('照合: 8件超（truncated）は、見えている記録が正常でも要確認を優先する（成功判定をしない）', function () {
  var ok = [op()];
  var d = data(ok, { item: { record: 'FOUND', truncated: true, opCount: 9, ops: ok } });
  var v = verdict(rec(), d);
  assert.strictEqual(v.code, 'NEEDS_REVIEW'); assert.ok(v.reasons.indexOf('OP_HISTORY_TRUNCATED') !== -1);
  ['ISSUED_GUIDED', 'REVOKED_CONFIRMED', 'GUIDE_NOT_SENT'].forEach(function (c) { assert.notStrictEqual(v.code, c); });
  // 失効確認済みの見かけでも、取消の予約で truncated なら成功にしない
  var gone = [op({ state: 'DELETED_CONFIRMED' })];
  assert.strictEqual(verdict(rec({ status: 'CANCELLED' }), data(gone, { item: { record: 'FOUND', truncated: true, opCount: 12, ops: gone } })).code, 'NEEDS_REVIEW');
  // 現行改訂が見えない（古い8件の外にある可能性）ときも不一致とは断定せず要確認
  var seen = [op({ rev: 1, state: 'DELETED_CONFIRMED' })];
  assert.strictEqual(verdict(rec({ revision: 2 }), data(seen, { item: { record: 'FOUND', truncated: true, opCount: 10, ops: seen } })).code, 'NEEDS_REVIEW');
  // ちょうど8件で truncated でなければ通常どおり
  assert.strictEqual(verdict(rec(), data(ok, { item: { record: 'FOUND', truncated: false, opCount: 8, ops: ok } })).code, 'ISSUED_GUIDED');
});

test('照合: 索引不整合・複数候補・読取中の更新・認識できない記録・台帳側の欠落は要確認', function () {
  var base = { truncated: false, opCount: 1, ops: [op()] };
  assert.strictEqual(verdict(rec(), data([op()], { item: Object.assign({ record: 'INVALID_INDEX' }, base) })).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec(), data([op()], { item: Object.assign({ record: 'AMBIGUOUS' }, base) })).code, 'NEEDS_REVIEW');
  assert.deepStrictEqual(verdict(rec(), data([op()], { consistency: 'CHANGED_DURING_READ' })).reasons, ['CHANGED_DURING_READ']);
  assert.strictEqual(verdict(rec(), data([op({ state: 'UNRECOGNIZED' })])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec(), data([op({ kind: 'UNRECOGNIZED' })])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec(), data([op({ rev: null })])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec(), data([op({ delivery: 'UNRECOGNIZED' })])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec({ revision: null }), data([op()])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec({ status: null }), data([op()])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec({ status: 'PENDING' }), data([op()])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec({ endMs: null }), data([op()])).code, 'NEEDS_REVIEW');
  assert.strictEqual(verdict(rec(), data([op({ validToSec: null })])).code, 'NEEDS_REVIEW');
  // 現行改訂に有効な発行記録が複数
  assert.strictEqual(verdict(rec(), data([op({ updatedAtSec: 1 }), op({ updatedAtSec: 2 })])).code, 'NEEDS_REVIEW');
  // 案内が送信中・不明・停止
  ['SENDING', 'UNKNOWN', 'SUPPRESSED'].forEach(function (s) { assert.strictEqual(verdict(rec(), data([op({ delivery: s })])).code, 'NEEDS_REVIEW', s); });
  // 利用終了後も発行待ち
  assert.strictEqual(verdict(rec(), data([op({ state: 'PLANNED', delivery: null })]), AFTER_END).code, 'NEEDS_REVIEW');
});

test('照合: 台帳の終了が開始と同時刻・開始以前（逆転）なら、鍵の有効時間が一致して見えても要確認（成功にしない）', function () {
  var start = Date.UTC(2026, 11, 2, 1, 0);
  // 鍵の有効時間（09:45-12:15）が、同時刻・逆転した台帳時間を「覆って」見えるケース
  [start, start - 3600 * 1000].forEach(function (endMs) {
    [rec({ endMs: endMs }), rec({ endMs: endMs, status: 'CANCELLED' })].forEach(function (r, i) {
      var v = verdict(r, data(r.status === 'CANCELLED' ? [op({ state: 'DELETED_CONFIRMED' })] : [op()]));
      assert.strictEqual(v.code, 'NEEDS_REVIEW', 'end=' + (endMs - start) + ' case ' + i);
      assert.ok(v.reasons.indexOf('LEDGER_TIME_INVALID') !== -1);
    });
  });
  // 利用終了後の時刻でも、逆転していれば失効確認済みにしない
  assert.strictEqual(verdict(rec({ endMs: start }), data([op({ state: 'DELETED_CONFIRMED' })]), AFTER_END).code, 'NEEDS_REVIEW');
  // 正常な時刻（終了が開始より後）は従来どおり成功判定になる
  assert.strictEqual(verdict(rec({ endMs: start + 1000 }), data([op({ validToSec: Math.floor((start + 1000) / 1000) + 600 })])).code, 'ISSUED_GUIDED');
  assert.strictEqual(verdict(rec(), data([op()])).code, 'ISSUED_GUIDED');
});

test('API: 台帳の終了が開始以前の予約は、台帳→照合の通しでも要確認', function () {
  var sb = load();
  [jst(2026, 12, 2, 10, 0), jst(2026, 12, 2, 9, 0)].forEach(function (end) {
    var c = ctxWith({ readLedger: function () { return { values: ledgerValues([ledgerRow({ endAt: end })]) }; } });
    var res = api(sb, { op: 'key_status', id: REF }, c);
    assert.strictEqual(res.keyStatus.verdict.code, 'NEEDS_REVIEW');
    assert.deepStrictEqual(res.keyStatus.reasons.map(function (x) { return x.code; }), ['LEDGER_TIME_INVALID']);
  });
});

test('照合: ジョブの稼働は別枠。稼働していても予約の鍵の状態は変えない（記録なしは確認不能のまま）', function () {
  var d = data([], { item: { record: 'NONE', truncated: false, opCount: 0, ops: [] }, jobs: { SYNC: 30, SWEEP: 30, DELIVER: 30, CLEANUP: 30 } });
  var v = verdict(rec(), d);
  assert.strictEqual(v.code, 'NO_HISTORY');
  assert.strictEqual(v.out.jobs.length, 4);
  assert.strictEqual(v.out.jobs[0].ageMinutes, 0);
  assert.ok(v.out.jobs.every(function (j) { return !('verdict' in j); }));
});

test('照合: 過剰な有効時間は判定しない旨を明記し、有効期間が覆っていれば正常とする', function () {
  var wide = op({ validFromSec: Math.floor(Date.UTC(2026, 11, 2, 0, 0) / 1000), validToSec: Math.floor(Date.UTC(2026, 11, 2, 6, 0) / 1000) });
  var v = verdict(rec(), data([wide]));
  assert.strictEqual(v.code, 'ISSUED_GUIDED');
  assert.ok(v.out.notes.length === 1 && /猶予/.test(v.out.notes[0]));
});

test('照合結果は契約の形（許可リスト）で、未知のキーを含まない', function () {
  var sb = load();
  var out = plain(sb.OpsKeyStatus.evaluate(rec(), data([op()]), NOW));
  out.ops.forEach(function (o) { assert.deepStrictEqual(Object.keys(o).sort(), ['current', 'deliveryLabel', 'kindLabel', 'rev', 'stateLabel', 'updatedAt', 'validFrom', 'validTo']); });
  assert.deepStrictEqual(contract.validateKeyStatus({ ok: true, contractVersion: 1, fetchedAt: '2026-12-01T11:00:00+09:00', bookingId: REF, keyStatus: out }), []);
});

// ================================================================ OpsApi key_status

var HEADER = ['bookingId', 'date', 'startAt', 'endAt', 'brand', 'status', 'email', 'phone', 'revision', 'name'];
function ledgerValues(rows) { return [HEADER].concat(rows); }
function jst(y, m, d, hh, mm) { return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)); }
function ledgerRow(over) {
  var b = Object.assign({ bookingId: REF, date: '2026-12-02', startAt: jst(2026, 12, 2, 10, 0), endAt: jst(2026, 12, 2, 12, 0), brand: 'snb', status: 'CONFIRMED',
    email: 'SECRET-EMAIL@example.invalid', phone: 'SECRET-PHONE', revision: 1, name: '架空 太郎' }, over || {});
  return HEADER.map(function (h) { return b[h]; });
}
function ctxWith(over) {
  var calls = { fetch: [], ledger: 0 };
  var ctx = Object.assign({
    nowMs: NOW, authenticate: function () { return { ok: true }; },
    readLedger: function () { calls.ledger++; return { values: ledgerValues([ledgerRow()]) }; },
    accessConfig: function () { return { url: URL_OK, token: TOKEN, fetch: function (u, o) { calls.fetch.push({ url: u, options: o }); return fakeRes(200, accessBody()); } }; }
  }, over || {});
  return { ctx: ctx, calls: calls };
}
function api(sb, request, c) { return plain(sb.OpsApi.handle(request, c.ctx)); }

test('API: 正常系は契約どおり。応答に接続先URL・トークン・PIN・メール・電話が出ない。ログは固定コード', function () {
  var sb = load(); var c = ctxWith();
  var res = api(sb, { op: 'key_status', id: REF }, c);
  assert.deepStrictEqual(contract.validateKeyStatus(res), []);
  assert.strictEqual(res.keyStatus.verdict.code, 'ISSUED_GUIDED');
  var blob = JSON.stringify(res) + sb._logs.join('\n');
  [URL_OK, 'AKfycbFAKE942', TOKEN, 'SECRET-EMAIL', 'SECRET-PHONE', '架空 太郎', LOC_OK].forEach(function (v) { assert.ok(blob.indexOf(v) === -1, '出力に出てはいけない値: ' + v); });
  assert.deepStrictEqual(sb._logs, ['ops key_status ISSUED_GUIDED']);
  assert.strictEqual(c.calls.fetch.length, 1);
});

test('API: 認可は毎回。拒否時は台帳にも鍵管理側にも触れない', function () {
  var sb = load();
  [{ ok: false, code: 'FORBIDDEN' }, { ok: false, code: 'UNAUTHENTICATED' }, null].forEach(function (auth) {
    var c = ctxWith({ authenticate: function () { return auth; } });
    var res = api(sb, { op: 'key_status', id: REF }, c);
    assert.strictEqual(res.ok, false);
    assert.ok(['FORBIDDEN', 'UNAUTHENTICATED'].indexOf(res.error.code) !== -1);
    assert.strictEqual(c.calls.ledger, 0); assert.strictEqual(c.calls.fetch.length, 0);
    assert.deepStrictEqual(contract.validateKeyStatus(res), []);
  });
});

test('API: 未接続（設定なし）・設定不正・取得失敗・IDの形式非対応は、それぞれ別の表示で、予約自体の取得は成功のまま', function () {
  var sb = load();
  var nc = api(sb, { op: 'key_status', id: REF }, ctxWith({ accessConfig: function () { return null; } }));
  assert.strictEqual(nc.ok, true); assert.strictEqual(nc.keyStatus.verdict.code, 'NOT_CONNECTED'); assert.strictEqual(nc.keyStatus.connection, 'NOT_CONNECTED');
  var bad = api(sb, { op: 'key_status', id: REF }, ctxWith({ accessConfig: function () { return { url: 'https://evil.test/', token: TOKEN, fetch: function () { throw new Error('must not be called'); } }; } }));
  assert.strictEqual(bad.keyStatus.verdict.code, 'FETCH_FAILED'); assert.deepStrictEqual(bad.keyStatus.failure, { code: 'CONFIG_INVALID' });
  var thrown = api(sb, { op: 'key_status', id: REF }, ctxWith({ accessConfig: function () { throw new Error('SECRET-CONFIG'); } }));
  assert.strictEqual(thrown.keyStatus.verdict.code, 'FETCH_FAILED');
  assert.ok(JSON.stringify(thrown).indexOf('SECRET-CONFIG') === -1);
  var failed = api(sb, { op: 'key_status', id: REF }, ctxWith({ accessConfig: function () { return { url: URL_OK, token: TOKEN, fetch: function () { throw new Error('SECRET-NET'); } }; } }));
  assert.strictEqual(failed.keyStatus.verdict.code, 'FETCH_FAILED'); assert.deepStrictEqual(failed.keyStatus.failure, { code: 'NETWORK' });
  assert.ok(JSON.stringify(failed).indexOf('SECRET-NET') === -1);
  var legacyId = 'FAKE-001';
  var calls = 0;
  var unsupported = api(sb, { op: 'key_status', id: legacyId }, ctxWith({
    readLedger: function () { return { values: ledgerValues([ledgerRow({ bookingId: legacyId })]) }; },
    accessConfig: function () { return { url: URL_OK, token: TOKEN, fetch: function () { calls++; return fakeRes(200, accessBody()); } }; }
  }));
  assert.strictEqual(unsupported.keyStatus.verdict.code, 'UNVERIFIABLE'); assert.strictEqual(unsupported.keyStatus.connection, 'UNSUPPORTED'); assert.strictEqual(calls, 0);
  [nc, bad, thrown, failed, unsupported].forEach(function (r) { assert.deepStrictEqual(contract.validateKeyStatus(r), []); });
  assert.notStrictEqual(nc.keyStatus.verdict.code, failed.keyStatus.verdict.code);
});

test('API: 台帳側の失敗・不存在・重複・不正なIDは詳細と同じ扱い（鍵管理側へ問い合わせない）', function () {
  var sb = load();
  var c = ctxWith({ readLedger: function () { return { notConnected: true }; } });
  assert.strictEqual(api(sb, { op: 'key_status', id: REF }, c).error.code, 'NOT_CONNECTED');
  var c2 = ctxWith({ readLedger: function () { return { values: ledgerValues([ledgerRow({ bookingId: 'SNB-20261202-ZZZZ0009' })]) }; } });
  assert.strictEqual(api(sb, { op: 'key_status', id: REF }, c2).error.code, 'NOT_FOUND');
  var c3 = ctxWith({ readLedger: function () { return { values: ledgerValues([ledgerRow(), ledgerRow()]) }; } });
  assert.strictEqual(api(sb, { op: 'key_status', id: REF }, c3).error.code, 'DUPLICATE_ID');
  var c4 = ctxWith();
  assert.strictEqual(api(sb, { op: 'key_status', id: '  ' }, c4).error.code, 'INVALID_PARAMS');
  assert.strictEqual(api(sb, { op: 'key_status' }, c4).error.code, 'INVALID_PARAMS');
  [c, c2, c3, c4].forEach(function (x) { assert.strictEqual(x.calls.fetch.length, 0); });
});

test('API: 台帳の改訂番号が読めない・整数でない場合は要確認（推測で一致させない）', function () {
  var sb = load();
  ['', 'abc', 1.5, -1].forEach(function (rv) {
    var c = ctxWith({ readLedger: function () { return { values: ledgerValues([ledgerRow({ revision: rv })]) }; } });
    var res = api(sb, { op: 'key_status', id: REF }, c);
    assert.strictEqual(res.keyStatus.verdict.code, 'NEEDS_REVIEW', String(rv));
  });
});

test('API: 取消した予約に鍵が残っていれば不一致として返す（台帳の取消と鍵記録の突合を通しで確認）', function () {
  var sb = load();
  var c = ctxWith({ readLedger: function () { return { values: ledgerValues([ledgerRow({ status: 'CANCELLED' })]) }; } });
  var res = api(sb, { op: 'key_status', id: REF }, c);
  assert.strictEqual(res.keyStatus.verdict.code, 'MISMATCH');
});

test('API: 書込み系・予約の変更・メール送信のコード経路を持たない（静的検査）', function () {
  var src = fs.readFileSync(path.join(DIR, 'OpsKeyStatus.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/MailApp|GmailApp|ScriptApp|PropertiesService|LockService|SpreadsheetApp|setProperty|deleteProperty|createKey|deleteKey|unlock/i.test(src));
  assert.ok(!/method:\s*'(put|patch|delete)'/i.test(src));
  var api2 = fs.readFileSync(path.join(DIR, 'OpsApi.gs'), 'utf8');
  var fn = api2.slice(api2.indexOf('function keyStatus_'), api2.indexOf('/* 共通契約の入口'));
  assert.ok(!/OpsTasks|setProperty|MailApp/.test(fn));
  var m = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8'));
  assert.deepStrictEqual(m.oauthScopes, ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email']);
  assert.deepStrictEqual(m.webapp, { access: 'MYSELF', executeAs: 'USER_DEPLOYING' });
});

// ================================================================ 画面

function ctlWith(opts) {
  var api3 = Mock.createMockApi(Object.assign({ nowMs: NOW, defer: function (fn) { fn(); } }, opts || {}));
  var ctl = C.createController(api3, function () {});
  return ctl;
}
function viewHtml(ctl) { return C.renderBanner(ctl.state) + C.renderView(ctl.state); }

test('画面: 鍵・案内の状況が予約詳細に出る。状態ごとに別の表示（成功/案内未送信/不一致/確認不能/要確認/失効未確認）', function () {
  var expect = { 'MOCK-001': 'ISSUED_GUIDED', 'MOCK-002': 'NO_HISTORY', 'MOCK-003': 'REVOKED_CONFIRMED', 'MOCK-004': 'MISMATCH', 'MOCK-005': 'NEEDS_REVIEW', 'MOCK-006': 'GUIDE_NOT_SENT', 'MOCK-007': 'REVOKE_UNCONFIRMED' };
  var htmls = {};
  Object.keys(expect).forEach(function (id) {
    var ctl = ctlWith();
    ctl.openDetail(id);
    assert.strictEqual(ctl.state.key.phase, 'ready', id);
    var html = viewHtml(ctl);
    assert.ok(html.indexOf('data-verdict="' + expect[id] + '"') !== -1, id);
    assert.ok(/鍵・案内の状況（読み取り専用）/.test(html));
    htmls[id] = html;
  });
  assert.ok(/不一致/.test(htmls['MOCK-004']) && !/登録確認済み・案内済み/.test(htmls['MOCK-004']));
  assert.ok(/鍵の履歴なし/.test(htmls['MOCK-002']) && /未発行」とも「失効済み」とも判断していません/.test(htmls['MOCK-002']) && /確認先/.test(htmls['MOCK-002']));
  assert.ok(/案内未送信/.test(htmls['MOCK-006']));
  assert.ok(/処理ジョブの稼働（予約ごとの鍵の成功ではありません）/.test(htmls['MOCK-001']));
  assert.ok(/参考表示です。実際に解錠できるかは確認していません/.test(htmls['MOCK-001']));
});

test('画面: 未接続・取得失敗・認可拒否は別表示で、成功/正常に見えない。予約詳細は壊れない', function () {
  var nc = ctlWith({ key: 'not_connected' }); nc.openDetail('MOCK-001');
  var h1 = viewHtml(nc);
  assert.ok(h1.indexOf('data-verdict="NOT_CONNECTED"') !== -1 && /未接続/.test(h1) && /予約ID/.test(h1));
  var fl = ctlWith({ key: 'failed' }); fl.openDetail('MOCK-001');
  var h2 = viewHtml(fl);
  assert.ok(h2.indexOf('data-verdict="FETCH_FAILED"') !== -1 && /未取得/.test(h2) && !/登録確認済み/.test(h2));
  var dn = ctlWith({ key: 'denied' }); dn.openDetail('MOCK-001');
  assert.strictEqual(dn.state.key.phase, 'error');
  var h3 = viewHtml(dn);
  assert.ok(/未取得: 権限がありません/.test(h3) && !/data-verdict/.test(h3) && /予約ID/.test(h3));
  assert.notStrictEqual(h1, h2);
});

test('画面: 通信自体の失敗は「未取得」。古い応答は新しい詳細を上書きしない。詳細を閉じたら鍵状況も消える', function () {
  var pending = [];
  var base = Mock.createMockApi({ nowMs: NOW, defer: function (fn) { fn(); } });
  var delayed = { kind: 'mock', list: base.list, detail: base.detail, keyStatus: function (id, ok) { pending.push({ id: id, ok: ok }); } };
  var ctl = C.createController(delayed, function () {});
  ctl.openDetail('MOCK-001'); ctl.openDetail('MOCK-004');
  assert.strictEqual(ctl.state.key.phase, 'loading');
  var first = pending[0], second = pending[1];
  base.keyStatus(first.id, function (r) { first.ok(r); }); // 古い応答（MOCK-001）が先に到着
  assert.strictEqual(ctl.state.key.phase, 'loading', '古い応答で上書きされた');
  base.keyStatus(second.id, function (r) { second.ok(r); });
  assert.strictEqual(ctl.state.key.data.verdict.code, 'MISMATCH');
  ctl.closeDetail();
  assert.strictEqual(ctl.state.key.phase, 'idle');
  // 通信失敗（ng）
  var broken = { kind: 'mock', list: base.list, detail: base.detail, keyStatus: function (id, ok, ng) { ng(new Error('x')); } };
  var c2 = C.createController(broken, function () {}); c2.openDetail('MOCK-001');
  assert.strictEqual(c2.state.key.phase, 'error');
  assert.ok(/未取得/.test(viewHtml(c2)));
  // アダプターが鍵状態に未対応
  var legacy = { kind: 'mock', list: base.list, detail: base.detail };
  var c3 = C.createController(legacy, function () {}); c3.openDetail('MOCK-001');
  assert.strictEqual(c3.state.key.phase, 'error');
});

test('画面: サーバーの文字列はすべてエスケープして描画する（XSS）', function () {
  var ctl = ctlWith();
  ctl.openDetail('MOCK-001');
  ctl.state.key.data.verdict.label = '<img src=x onerror=alert(1)>';
  ctl.state.key.data.reasons = [{ code: 'X', text: '<script>alert(2)</script>' }];
  ctl.state.key.data.ops[0].stateLabel = '<b>x</b>';
  var html = viewHtml(ctl);
  assert.ok(html.indexOf('<img src=x') === -1 && html.indexOf('<script>') === -1 && html.indexOf('<b>x</b>') === -1);
});

test('モックの鍵状態応答は、バックエンドと同じ契約の検証を通る', function () {
  ['ok', 'not_connected', 'failed'].forEach(function (key) {
    var api4 = Mock.createMockApi({ nowMs: NOW, defer: function (fn) { fn(); }, key: key });
    ['MOCK-001', 'MOCK-002', 'MOCK-003', 'MOCK-004', 'MOCK-005', 'MOCK-006', 'MOCK-007', 'MOCK-008'].forEach(function (id) {
      api4.keyStatus(id, function (res) { assert.deepStrictEqual(contract.validateKeyStatus(res), [], key + ' ' + id); });
    });
  });
});

test('GASアダプター: 鍵状態は opsGetKeyStatus だけを呼び、通信失敗は失敗として通知する', function () {
  var called = [];
  var runner = { withSuccessHandler: function (ok) { return { withFailureHandler: function (ng) { return new Proxy({}, { get: function (_, name) { return function (arg) { called.push([name, arg]); if (name === 'opsGetKeyStatus' && arg === 'BOOM') ng(new Error('x')); else ok({ ok: true }); }; } }); } }; } };
  var a = Gas.createGasApi(runner);
  var got = null, failed = false;
  a.keyStatus('SNB-1', function (r) { got = r; }, function () { failed = true; });
  a.keyStatus('BOOM', function () {}, function () { failed = true; });
  assert.deepStrictEqual(called, [['opsGetKeyStatus', 'SNB-1'], ['opsGetKeyStatus', 'BOOM']]);
  assert.deepStrictEqual(got, { ok: true });
  assert.strictEqual(failed, true);
});

/* ---- #967 メール送信記録と個別鍵状況の分離表示 ---- */
test('画面(#967): 来場案内の送信記録は鍵記録NONE・取得失敗でも別ブロックで表示され、個別鍵の発行と混同しない', function () {
  var ok = ctlWith(); ok.openDetail('MOCK-002'); /* 鍵記録なし（確認不能）だが来場案内の送信記録あり */
  var h = viewHtml(ok);
  assert.ok(/予約台帳のメール送信記録（読み取り専用）/.test(h) && /予約台帳／来場案内メール<\/dt><dd>送信記録あり（\d{4}-\d{2}-\d{2} \d{2}:\d{2} JST）/.test(h));
  assert.ok(h.indexOf('data-verdict="NO_HISTORY"') !== -1 && /個別鍵の登録・暗証番号の別送・解錠の成否を意味しません/.test(h));
  assert.ok(!/案内未送信|未発行です/.test(h.split('鍵・案内の状況')[0]));
  var fl = ctlWith({ key: 'failed' }); fl.openDetail('MOCK-002');
  var h2 = viewHtml(fl);
  assert.ok(/送信記録あり/.test(h2) && /未取得/.test(h2));
});

test('画面(#967): 空欄=台帳上の記録なし／列欠落・日時不正は別表示で、いずれも「未送信」と断定しない', function () {
  var none = ctlWith(); none.openDetail('MOCK-005');
  assert.ok(/台帳上の記録なし/.test(viewHtml(none)));
  var miss = ctlWith(); miss.openDetail('MOCK-003');
  assert.ok(/確認不能（台帳に該当の項目がありません）/.test(viewHtml(miss)));
  var bad = ctlWith(); bad.openDetail('MOCK-004');
  assert.ok(/日時不正・不明/.test(viewHtml(bad)));
  [none, miss, bad].forEach(function (c) { assert.ok(!/(来場案内|確定)メール<\/dt><dd>[^<]*未送信/.test(viewHtml(c))); });
});

// ================================================================ #969 個別鍵の実状態（lifecycle）

function lc(r, d, now) { var o = verdict(r, d, now); return { verdict: o.code, lc: o.out.lifecycle && o.out.lifecycle.code, label: o.out.lifecycle && o.out.lifecycle.label, alert: o.out.lifecycle && o.out.lifecycle.alert, reasons: o.reasons }; }

test('#969 主表示: 取消/失効かつ発行記録が全て失敗 → 未発行（根拠付き）。発行失敗・発行待ちは未発行に合算しない', function () {
  var a = lc(rec({ status: 'CANCELLED' }), data([op({ state: 'FAILED' }), op({ rev: 2, state: 'FAILED' })]));
  assert.deepStrictEqual([a.verdict, a.lc], ['NOT_ISSUED_CONFIRMED', 'NOT_ISSUED']); assert.ok(/未発行（根拠付き）/.test(a.label));
  assert.strictEqual(lc(rec({ status: 'EXPIRED' }), data([op({ state: 'FAILED' })])).lc, 'NOT_ISSUED');
  // 確定の予約の発行失敗は「発行失敗」（未発行ではない）
  assert.strictEqual(lc(rec(), data([op({ state: 'FAILED' })])).lc, 'ISSUE_FAILED');
  // 発行待ち・処理中
  ['PLANNED', 'SENDING', 'SENT_WAIT_WEBHOOK', 'ACCEPTED_NO_COMMAND_ID'].forEach(function (st) { assert.strictEqual(lc(rec(), data([op({ state: st })])).lc, 'ISSUE_PENDING', st); });
  // 放棄のみ・失敗と放棄の混在は、未発行とも発行失敗とも断定せず「発行中止・要確認」。失効記録のみは保留
  [[rec({ status: 'CANCELLED' }), [op({ state: 'ABANDONED' })]], [rec({ status: 'CANCELLED' }), [op({ state: 'FAILED' }), op({ rev: 2, state: 'ABANDONED' })]],
    [rec(), [op({ state: 'ABANDONED' })]], [rec({ revision: 2 }), [op({ rev: 1, state: 'FAILED' }), op({ rev: 2, state: 'ABANDONED' })]]].forEach(function (c) {
    var r = lc(c[0], data(c[1])); assert.strictEqual(r.lc, 'ISSUE_ABORTED'); assert.ok(!/未発行（根拠付き）|発行失敗（/.test(r.label));
  });
  assert.strictEqual(lc(rec({ status: 'CANCELLED' }), data([op({ kind: 'REVOKE', state: 'FAILED' })])).lc, 'HOLD');
  // 失敗の記録でも truncated / 読取中の更新 / 取消後に鍵が残る場合は断定しない
  assert.strictEqual(lc(rec({ status: 'CANCELLED' }), data([op({ state: 'FAILED' })], { item: { record: 'FOUND', truncated: true, opCount: 9, ops: [op({ state: 'FAILED' })] } })).lc, 'HOLD');
  assert.strictEqual(lc(rec({ status: 'CANCELLED' }), data([op({ state: 'FAILED' })], { consistency: 'CHANGED_DURING_READ' })).lc, 'HOLD');
  assert.strictEqual(lc(rec({ status: 'CANCELLED' }), data([op({ state: 'FAILED' }), op({ rev: 2, state: 'ISSUED_CONFIRMED' })])).lc, 'ISSUED');
});

test('#969 主表示: 発行済み／失効処理中／失効済み（確認済み）。期限切れ・利用終了は失効済みにしない', function () {
  assert.strictEqual(lc(rec(), data([op()])).lc, 'ISSUED');
  ['DELETE_PENDING', 'DELETE_SENDING', 'DELETE_SENT'].forEach(function (st) { assert.strictEqual(lc(rec({ status: 'CANCELLED' }), data([op({ state: st })])).lc, 'REVOKING', st); });
  // Coreの EXPIRED は「期限切れ（削除とは区別）」。失効処理中とは別表示
  var exp = lc(rec({ status: 'CANCELLED' }), data([op({ state: 'EXPIRED' })]));
  assert.strictEqual(exp.lc, 'EXPIRED'); assert.ok(/期限切れ・失効未確認/.test(exp.label) && !/失効処理中/.test(exp.label));
  ['DELETED_CONFIRMED', 'ALREADY_ABSENT', 'ARCHIVED_EXPIRED'].forEach(function (st) {
    assert.strictEqual(lc(rec({ status: 'CANCELLED' }), data([op({ state: st })])).lc, 'REVOKED', st);
    assert.strictEqual(lc(rec(), data([op({ state: st })]), AFTER_END).lc, 'REVOKED', st);
  });
  // 利用終了後でも鍵が登録確認済みのまま（有効期限が過ぎただけ）→ 失効済みではない
  var ended = lc(rec(), data([op()]), AFTER_END);
  assert.strictEqual(ended.lc, 'ENDED_NOT_REVOKED'); assert.ok(/失効は未確認/.test(ended.label));
  // 反映の有無が不明
  assert.strictEqual(lc(rec(), data([op({ state: 'UNKNOWN' })])).lc, 'STATE_UNKNOWN');
});

test('#969 主表示: NONE（履歴なし）は未発行・失効済みの二択にせず、予約の時刻・状態と無関係に判別不可。確認先を示す', function () {
  var cases = [rec(), rec({ status: 'CANCELLED' }), rec({ status: 'EXPIRED' }), rec({ endMs: Date.UTC(2026, 10, 3, 3, 0), startMs: Date.UTC(2026, 10, 3, 1, 0) })];
  cases.forEach(function (r) {
    var o = verdict(r, data([], { item: { record: 'NONE', truncated: false, opCount: 0, ops: [] } }), NOW);
    assert.strictEqual(o.out.lifecycle.code, 'NO_HISTORY');
    var text = JSON.stringify(o.out);
    assert.ok(/鍵の履歴なし（判別不可）/.test(text) && /確認先/.test(text) && /SwitchBot/.test(text));
    assert.ok(!/"code":"(NOT_ISSUED|REVOKED)"/.test(text));
  });
});

test('#969 主表示: 矛盾・改訂変更・取得エラー・未接続は鍵の状態を主張しない（HOLD / null）', function () {
  assert.strictEqual(lc(rec({ revision: 2 }), data([op({ rev: 1 })])).lc, 'HOLD'); /* 改訂不一致 */
  assert.strictEqual(lc(rec({ revision: null }), data([op()])).lc, 'HOLD');
  var sb = load();
  ['NOT_CONNECTED', 'FETCH_FAILED'].forEach(function (c) { assert.strictEqual(plain(sb.OpsKeyStatus.unavailable(c, 'NETWORK')).lifecycle, null); });
  assert.strictEqual(plain(sb.OpsKeyStatus.unavailable('UNVERIFIABLE', 'UNSUPPORTED_ID')).lifecycle, null);
});

test('#969 主表示: メール送信記録・予約の時刻・ACCESS_ENABLED は入力にならない（evaluateの入力はrec/dataのみ）', function () {
  var sb = load();
  var base = plain(sb.OpsKeyStatus.evaluate(rec({ status: 'CANCELLED' }), data([], { item: { record: 'NONE', truncated: false, opCount: 0, ops: [] } }), NOW));
  var withMail = plain(sb.OpsKeyStatus.evaluate(Object.assign(rec({ status: 'CANCELLED' }), { accessGuideMail: { state: 'recorded' }, confirmedMail: { state: 'recorded' }, accessApprovedAt: 1 }), data([], { item: { record: 'NONE', truncated: false, opCount: 0, ops: [] } }), NOW + 400 * DAY));
  assert.deepStrictEqual(withMail.lifecycle, base.lifecycle);
  assert.strictEqual(withMail.lifecycle.code, 'NO_HISTORY');
});

test('#969 画面: 個別鍵の状態が主表示で、照合結果・メール送信記録とは別枠。NONE/未発行/失効済みが別表示', function () {
  var want = { 'MOCK-001': 'ISSUED', 'MOCK-002': 'NO_HISTORY', 'MOCK-003': 'REVOKED', 'MOCK-007': 'REVOKING' };
  Object.keys(want).forEach(function (id) {
    var ctl = ctlWith(); ctl.openDetail(id);
    var h = viewHtml(ctl);
    assert.ok(h.indexOf('data-lifecycle="' + want[id] + '"') !== -1, id);
    assert.ok(h.indexOf('個別鍵の状態:') < h.indexOf('data-verdict='), id + ': 主表示が照合結果より先');
  });
  var none = ctlWith(); none.openDetail('MOCK-002');
  assert.ok(/個別鍵の状態: 鍵の履歴なし（判別不可）/.test(viewHtml(none)) && !/data-lifecycle="(NOT_ISSUED|REVOKED)"/.test(viewHtml(none)));
  /* 未発行（根拠付き）はモックの予約一覧に無いため、状態を直接組み立てて描画する */
  var ni = ctlWith(); ni.openDetail('MOCK-003');
  var apiNi = Mock.createMockApi({ nowMs: NOW, defer: function (fn) { fn(); } });
  apiNi.keyStatus('MOCK-008', function (res) {
    ni.state.key = { phase: 'ready', data: res.keyStatus, error: null, fetchedAt: res.fetchedAt };
  });
  var niHtml = viewHtml(ni);
  assert.ok(niHtml.indexOf('data-lifecycle="NOT_ISSUED"') !== -1 && /個別鍵の状態: 未発行（根拠付き）/.test(niHtml));
  var nc = ctlWith({ key: 'not_connected' }); nc.openDetail('MOCK-001');
  assert.ok(viewHtml(nc).indexOf('data-lifecycle') === -1);
});

test('#969 主表示: 鍵の明示的な証拠は予約との矛盾・案内の不明で隠さない（lifecycleは鍵の記録から直接求め、警告はalert/verdictに分離）', function () {
  // 案内状態だけが不確かでも、登録確認済みの鍵は「発行済み」。verdictは要確認を維持
  ['SENDING', 'UNKNOWN', 'SUPPRESSED'].forEach(function (d) {
    var r = lc(rec(), data([op({ delivery: d })]));
    assert.deepStrictEqual([r.lc, r.verdict, r.alert], ['ISSUED', 'NEEDS_REVIEW', true], d);
    assert.deepStrictEqual(r.reasons, ['GUIDE_STATE_UNCERTAIN']);
  });
  // 取消予約＋有効な鍵が残っている → 発行済み（有効な鍵が残る）を隠さず、MISMATCHの警告つき
  var c = lc(rec({ status: 'CANCELLED' }), data([op()])); assert.deepStrictEqual([c.lc, c.verdict, c.alert], ['ISSUED', 'MISMATCH', true]);
  var c2 = lc(rec({ status: 'EXPIRED' }), data([op({ state: 'SENT_WAIT_WEBHOOK' })])); assert.deepStrictEqual([c2.lc, c2.verdict, c2.alert], ['ISSUE_PENDING', 'MISMATCH', true]);
  // 予約は有効（利用前）なのに鍵は失効確認済み → 失効済み（確認済み）＋警告
  ['DELETED_CONFIRMED', 'ALREADY_ABSENT'].forEach(function (st) {
    var r = lc(rec(), data([op({ state: st })])); assert.deepStrictEqual([r.lc, r.verdict, r.alert], ['REVOKED', 'MISMATCH', true], st);
  });
  // 失効処理中（予約は有効）
  var rv = lc(rec(), data([op({ state: 'DELETE_PENDING' })])); assert.deepStrictEqual([rv.lc, rv.verdict, rv.alert], ['REVOKING', 'MISMATCH', true]);
  // 鍵の有効時間が予約を覆っていない → 登録確認は発行済みのまま、時間不一致はMISMATCH警告
  var w = lc(rec(), data([op({ validToSec: Math.floor(Date.UTC(2026, 11, 2, 2, 0) / 1000) })])); assert.deepStrictEqual([w.lc, w.verdict, w.alert], ['ISSUED', 'MISMATCH', true]);
  // 正常は警告なし
  assert.strictEqual(lc(rec(), data([op()])).alert, false);
  // 誤成功防止（truncated・複数候補・読取競合・不整合・認識不能・改訂不明）は引き続き保留（鍵の状態を主張しない）
  var hold = function (d, r) { var x = lc(r || rec(), d); assert.deepStrictEqual([x.lc, x.alert], ['HOLD', true]); };
  hold(data([op()], { item: { record: 'FOUND', truncated: true, opCount: 9, ops: [op()] } }));
  hold(data([op()], { item: { record: 'AMBIGUOUS', truncated: false, opCount: 2, ops: [op(), op()] } }));
  hold(data([op()], { item: { record: 'INVALID_INDEX', truncated: false, opCount: 0, ops: [] } }));
  hold(data([op()], { consistency: 'CHANGED_DURING_READ' }));
  hold(data([op({ state: 'UNRECOGNIZED' })]));
  hold(data([op()]), rec({ revision: null }));
  hold(data([op({ rev: 1 })]), rec({ revision: 2 })); /* 現在の改訂の鍵記録なし */
  // 現在の改訂に鍵があり古い改訂の鍵が残る → 現在の改訂の状態＋MISMATCH警告
  var old = lc(rec({ revision: 2 }), data([op({ rev: 1 }), op({ rev: 2 })])); assert.deepStrictEqual([old.lc, old.verdict, old.alert], ['ISSUED', 'MISMATCH', true]);
});

test('#969 画面: 警告つきの主表示は、鍵の状態の直下に警告を出す（取消なのに鍵が有効）', function () {
  var ctl = ctlWith(); ctl.openDetail('MOCK-004');
  var h = viewHtml(ctl);
  assert.ok(h.indexOf('data-lifecycle="ISSUED"') !== -1 && h.indexOf('data-lifecycle-alert="1"') !== -1 && h.indexOf('data-lifecycle-alert') < h.indexOf('data-verdict='));
  var ok = ctlWith(); ok.openDetail('MOCK-001');
  assert.ok(viewHtml(ok).indexOf('data-lifecycle-alert') === -1);
});
