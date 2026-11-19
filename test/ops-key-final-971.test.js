/*
 * Issue #971 Phase 1: 個別鍵の確認済み最終状態（Bookings.accessKeyFinalStatus 1列）の判定・保存・表示のテスト。
 * 実GAS・実Access・実台帳には接続しない。予約ID・トークン・URLはすべて架空のダミー。
 * 主眼: ①保存してよい条件（誤判定防止）②保存値の無効化（改訂番号・指紋）③閲覧は書込みなし・表示はAccess NONEのときだけ
 *       ④管理者の保存処理（フラグOFF・再読込・競合・失敗）⑤書込み先は1セルだけ ⑥既存機能・保持方針への非干渉。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var contract = require('./helpers/ops-contract');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var DIR = path.join(__dirname, '..', 'gas', 'ops-reservations');
var ROOT = path.join(__dirname, '..');
var FRONT = path.join(ROOT, '_ops-app', 'frontend');
var Mock = require(path.join(FRONT, 'mock-adapter.js'));
var C = require(path.join(FRONT, 'ops-client.js'));

var NOW = Date.UTC(2026, 11, 1, 2, 0, 0); /* 2026-12-01 11:00 JST */
var URL_OK = 'https://script.google.com/macros/s/AKfycbFAKE971/exec';
var TOKEN = 'T'.repeat(40);
var SHEET_ID = 'FAKE_SPREADSHEET_ID_971_0000000000';
var REF = 'SNB-20261130-AAAA0001';

function load(globals) {
  var RealDate = Date;
  function FixedDate() { return arguments.length === 0 ? new RealDate(NOW) : new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))(); }
  FixedDate.prototype = RealDate.prototype; FixedDate.now = function () { return NOW; }; FixedDate.UTC = RealDate.UTC; FixedDate.parse = RealDate.parse;
  var sb = { Date: FixedDate, Logger: { log: function () { sb._logs.push([].slice.call(arguments).join(' ')); } }, _logs: [] };
  Object.keys(globals || {}).forEach(function (k) { sb[k] = globals[k]; });
  vm.createContext(sb);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsKeyStatus.gs', 'OpsKeyFinal.gs', 'OpsKeyFinalStore.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
  });
  return sb;
}
function plain(v) { return JSON.parse(JSON.stringify(v)); }
var sbShared = load();
var F = sbShared.OpsKeyFinal;

/* ---- 架空の台帳レコード（正規化済みの形）と Access 応答 ---- */
var ENDED_END = Date.UTC(2026, 10, 30, 3, 0); /* 11/30 12:00 JST（NOW=12/1 11:00 より前＝終了済み） */
function rec(over) {
  return Object.assign({
    bookingId: REF, rowNumber: 2, status: 'CONFIRMED', brandRaw: 'snb', startMs: Date.UTC(2026, 10, 30, 1, 0), endMs: ENDED_END, revision: 1,
    confirmedAt: '2026-11-20T10:00:00+09:00', cancelledAt: null, expiredAt: null, keyFinalStatus: { columnPresent: true, raw: null }
  }, over || {});
}
function op(over) {
  return Object.assign({ rev: 1, kind: 'ISSUE', state: 'DELETED_CONFIRMED', validFromSec: Math.floor(Date.UTC(2026, 10, 30, 0, 45) / 1000),
    validToSec: Math.floor(Date.UTC(2026, 10, 30, 3, 15) / 1000), updatedAtSec: 100, delivery: 'DELIVERED' }, over || {});
}
function data(ops, over) {
  return Object.assign({ consistency: 'STABLE', readAtSec: 1000, jobs: { SYNC: 1, SWEEP: 1, DELIVER: 1, CLEANUP: 1 }, item: { record: 'FOUND', truncated: false, opCount: ops.length, ops: ops } }, over || {});
}
function none() { return data([], { item: { record: 'NONE', truncated: false, opCount: 0, ops: [] } }); }
function decide(r, d, now) { return plain(F.decide(r, d, now === undefined ? NOW : now)); }
var CANCELLED = { status: 'CANCELLED', cancelledAt: '2026-11-25T10:00:00+09:00' };

// ================================================================ 保存してよい条件（decide）

test('保存条件: 利用終了した確定予約は、全件の失効・不在確認＋鍵の有効期限も終了済みのときだけ REVOKED_CONFIRMED', function () {
  assert.deepStrictEqual(decide(rec(), data([op()])), { save: 'REVOKED_CONFIRMED', reason: 'ENDED_ALL_REVOKED' });
  assert.strictEqual(decide(rec(), data([op({ state: 'ALREADY_ABSENT' })])).save, 'REVOKED_CONFIRMED');
  assert.strictEqual(decide(rec(), data([op({ state: 'ARCHIVED_EXPIRED' })])).save, 'REVOKED_CONFIRMED');
  assert.strictEqual(decide(rec({ revision: 2 }), data([op({ rev: 1 }), op({ rev: 2 })])).save, 'REVOKED_CONFIRMED', '全改訂が確認済み');
});

test('保存条件: Bookings の endAt 経過だけでは不可。鍵の猶予込み有効期限（validToSec）が未終了・不明なら保存しない', function () {
  var stillValid = Math.floor((NOW + 1800 * 1000) / 1000);
  assert.strictEqual(decide(rec(), data([op({ validToSec: stillValid })])).reason, 'KEY_VALIDITY_NOT_ENDED');
  assert.strictEqual(decide(rec(), data([op({ validToSec: null })])).reason, 'KEY_VALIDITY_NOT_ENDED');
  /* ちょうど終了した時刻は終了扱い */
  assert.strictEqual(decide(rec(), data([op({ validToSec: Math.floor(NOW / 1000) })])).save, 'REVOKED_CONFIRMED');
});

test('保存条件: 利用終了前の確定予約・仮予約・状態不明は保存しない（有効な間の失効は最終状態ではない）', function () {
  assert.strictEqual(decide(rec({ endMs: NOW + 3600 * 1000 }), data([op()])).reason, 'NOT_TERMINAL');
  assert.strictEqual(decide(rec({ status: 'PENDING' }), data([op()])).reason, 'NOT_TERMINAL');
  assert.strictEqual(decide(rec({ status: null }), data([op()])).reason, 'NOT_TERMINAL');
});

test('保存条件: 取消・失効の予約は、全件が発行失敗のみなら NOT_ISSUED_CONFIRMED／失効確認を含み残りも確認済みなら REVOKED_CONFIRMED', function () {
  assert.deepStrictEqual(decide(rec(CANCELLED), data([op({ state: 'FAILED' })])), { save: 'NOT_ISSUED_CONFIRMED', reason: 'ALL_ISSUES_FAILED' });
  assert.strictEqual(decide(rec({ status: 'EXPIRED', expiredAt: '2026-11-25T10:00:00+09:00' }), data([op({ state: 'FAILED' }), op({ rev: 2, state: 'FAILED' })])).save, 'NOT_ISSUED_CONFIRMED');
  assert.strictEqual(decide(rec(CANCELLED), data([op()])).save, 'REVOKED_CONFIRMED');
  assert.strictEqual(decide(rec(CANCELLED), data([op({ state: 'FAILED' }), op({ rev: 2 })])).save, 'REVOKED_CONFIRMED');
  /* 取消済みは時刻にかかわらず（鍵の有効期限が未来でも、全件が失効確認済みなら）保存可 */
  assert.strictEqual(decide(rec(CANCELLED), data([op({ validToSec: Math.floor((NOW + 3600 * 1000) / 1000) })])).save, 'REVOKED_CONFIRMED');
});

test('保存条件: 利用終了した確定予約で、全件が発行失敗のみなら「未発行確定」にしない（発行失敗の予約の最終状態は保存しない）', function () {
  assert.notStrictEqual(decide(rec(), data([op({ state: 'FAILED' })])).save, 'NOT_ISSUED_CONFIRMED');
  assert.strictEqual(decide(rec(), data([op({ state: 'FAILED' })])).save, null);
});

test('保存条件: 発行中・残存鍵・削除未確認・UNKNOWN・ABANDONED・期限切れ(確認前)が1件でもあれば保存しない', function () {
  ['PLANNED', 'SENDING', 'SENT_WAIT_WEBHOOK', 'ACCEPTED_NO_COMMAND_ID', 'ISSUED_CONFIRMED', 'DELETE_PENDING', 'DELETE_SENDING', 'DELETE_SENT', 'EXPIRED', 'UNKNOWN', 'ABANDONED'].forEach(function (s) {
    [rec(), rec(CANCELLED)].forEach(function (r) {
      assert.strictEqual(decide(r, data([op(), op({ rev: 2, state: s })])).save, null, s + ' ' + r.status);
      assert.strictEqual(decide(r, data([op({ state: s })])).save, null, s + ' only ' + r.status);
    });
  });
});

test('保存条件: 利用終了した確定予約は、現在の改訂の記録がなければ保存しない（古い改訂の失効だけで現在を断定しない）／FAILED混在も保存しない', function () {
  assert.strictEqual(decide(rec({ revision: 3 }), data([op({ rev: 1 }), op({ rev: 2 })])).reason, 'REVISION_NOT_COVERED');
  assert.strictEqual(decide(rec({ revision: 2 }), data([op({ rev: 1, state: 'FAILED' }), op({ rev: 2 })])).reason, 'ENDED_NOT_ALL_REVOKED');
});

test('保存条件: 履歴切捨て・不完全・読取中の更新・索引不整合・複数候補・認識できない記録・Access NONE は保存しない', function () {
  assert.strictEqual(decide(rec(), data([op()], { item: { record: 'FOUND', truncated: true, opCount: 9, ops: [op()] } })).reason, 'OP_HISTORY_TRUNCATED');
  assert.strictEqual(decide(rec(), data([op()], { item: { record: 'FOUND', truncated: false, opCount: 3, ops: [op()] } })).reason, 'OP_HISTORY_INCOMPLETE');
  assert.strictEqual(decide(rec(), data([], {})).reason, 'OP_HISTORY_INCOMPLETE');
  assert.strictEqual(decide(rec(), data([op()], { consistency: 'CHANGED_DURING_READ' })).reason, 'CHANGED_DURING_READ');
  ['AMBIGUOUS', 'INVALID_INDEX'].forEach(function (k) { assert.strictEqual(decide(rec(), data([op()], { item: { record: k, truncated: false, opCount: 1, ops: [op()] } })).reason, 'RECORD_NOT_USABLE'); });
  assert.strictEqual(decide(rec(), none()).reason, 'NO_RECORD', 'Accessに記録がないことだけでは未発行・失効済みを保存しない');
  assert.strictEqual(decide(rec(CANCELLED), none()).save, null);
  [{ state: 'UNRECOGNIZED' }, { kind: 'UNRECOGNIZED' }, { kind: 'REVOKE' }, { rev: null }].forEach(function (o) { assert.strictEqual(decide(rec(), data([op(o)])).reason, 'UNRECOGNIZED_RECORD', JSON.stringify(o)); });
  assert.strictEqual(decide(rec(), null).reason, 'NO_ACCESS_DATA');
});

test('保存条件: 台帳の改訂番号・利用時間が不正なら保存しない', function () {
  assert.strictEqual(decide(rec({ revision: null }), data([op()])).reason, 'LEDGER_REVISION_UNAVAILABLE');
  assert.strictEqual(decide(rec({ endMs: rec().startMs }), data([op()])).reason, 'LEDGER_TIME_INVALID');
  assert.strictEqual(decide(rec({ endMs: null }), data([op()])).reason, 'LEDGER_TIME_INVALID');
});

test('保存条件: 3ブランド（snb / mens / studio_x）を扱う。対象外ブランドは問い合わせず保存しない。ブランドだけでは鍵の状態を推定しない', function () {
  ['snb', 'mens', 'studio_x'].forEach(function (b) {
    assert.strictEqual(decide(rec({ brandRaw: b }), data([op()])).save, 'REVOKED_CONFIRMED', b);
    assert.strictEqual(decide(rec({ brandRaw: b }), none()).save, null, b + ' NONE');
  });
  ['other', '', null, 'SNB'].forEach(function (b) { assert.strictEqual(decide(rec({ brandRaw: b }), data([op()])).reason, 'BRAND_NOT_TARGET', String(b)); });
});

test('対象ブランドの定数は、鍵連携の正本（AccessKeySnapshot.TARGET_BRANDS）と一致する', function () {
  var sb = loadBookingSandbox(['AccessKeySnapshot.gs'], {});
  assert.deepStrictEqual(plain(F.TARGET_BRANDS), plain(sb.AccessKeySnapshot.TARGET_BRANDS));
});

// ================================================================ 保存値（指紋・改訂番号）

test('保存値: 形式は <CODE>@r<改訂>@h<16桁>。2種類以外のコード・不正形式は解釈しない（PIN等を含まない）', function () {
  var v = F.encode('REVOKED_CONFIRMED', 3, rec());
  assert.match(v, /^REVOKED_CONFIRMED@r3@h[0-9a-f]{16}$/);
  assert.deepStrictEqual(plain(F.parse(v)), { code: 'REVOKED_CONFIRMED', revision: 3, fingerprint: v.slice(-16) });
  assert.match(F.encode('NOT_ISSUED_CONFIRMED', 0, rec()), /^NOT_ISSUED_CONFIRMED@r0@h/);
  ['ISSUED_CONFIRMED', 'UNKNOWN', 'FAILED', '', null, undefined].forEach(function (c) { assert.strictEqual(F.encode(c, 1, rec()), null, String(c)); });
  [-1, 1.5, '1', null, 1000000].forEach(function (r) { assert.strictEqual(F.encode('REVOKED_CONFIRMED', r, rec()), null, String(r)); });
  ['', 'REVOKED_CONFIRMED', 'REVOKED_CONFIRMED@r3', 'REVOKED_CONFIRMED@r03@h0123456789abcdef', 'REVOKED_CONFIRMED@r3@hZZZZ456789abcdef', 'UNKNOWN@r3@h0123456789abcdef',
    'REVOKED_CONFIRMED@r3@h0123456789abcdef extra', 'revoked_confirmed@r3@h0123456789abcdef', null, 12].forEach(function (raw) { assert.strictEqual(F.parse(raw), null, String(raw)); });
});

test('保存値: 改訂番号または指紋が現在の台帳と違えば無効。変更・延長・復活・取消で旧結果を流用しない', function () {
  var base = rec();
  var stored = F.parse(F.encode('REVOKED_CONFIRMED', 1, base));
  assert.strictEqual(F.validFor(base, stored), true);
  assert.strictEqual(F.validFor(rec({ revision: 2 }), stored), false, '改訂番号が進んだ');
  /* 改訂番号の増分に失敗した予約変更でも、状態・日時が変われば指紋で無効になる */
  [{ endMs: ENDED_END + 3600 * 1000 }, { startMs: base.startMs + 1800 * 1000 }, { status: 'CANCELLED' }, { brandRaw: 'mens' },
    { confirmedAt: '2026-11-29T10:00:00+09:00' }, { cancelledAt: '2026-11-29T10:00:00+09:00' }, { expiredAt: '2026-11-29T10:00:00+09:00' }].forEach(function (change) {
    assert.strictEqual(F.validFor(rec(change), stored), false, JSON.stringify(change));
  });
  assert.strictEqual(F.validFor(rec({ revision: null }), stored), false);
  assert.strictEqual(F.validFor(base, null), false);
  /* 氏名・メール等の個人情報の変化は指紋に影響しない（そもそも入力に含めない） */
  assert.strictEqual(F.fingerprint(Object.assign(rec(), { name: 'A', email: 'a@example.invalid' })), F.fingerprint(rec()));
});

// ================================================================ 表示（display）

function saved(r) { return Object.assign({}, r, { keyFinalStatus: { columnPresent: true, raw: F.encode('REVOKED_CONFIRMED', r.revision, r) } }); }

test('表示: Access が正常に NONE を返し、保存値が現在の台帳と一致し、台帳が終端のときだけ「保存済みの過去の最終確認」を返す', function () {
  var out = plain(F.display(saved(rec()), none(), NOW));
  assert.deepStrictEqual(out, { code: 'REVOKED_CONFIRMED', label: '失効・不在を確認済み', source: 'BOOKINGS_SAVED' });
  assert.strictEqual(plain(F.display(saved(rec(CANCELLED)), none(), NOW)).code, 'REVOKED_CONFIRMED');
  var ni = Object.assign(rec(CANCELLED), {}); ni.keyFinalStatus = { columnPresent: true, raw: F.encode('NOT_ISSUED_CONFIRMED', 1, ni) };
  assert.strictEqual(plain(F.display(ni, none(), NOW)).code, 'NOT_ISSUED_CONFIRMED');
});

test('表示: Access に実記録がある・読取中の更新・索引不整合・取得できていない場合は保存値を出さない（Accessの現行記録を優先し、隠さない）', function () {
  var r = saved(rec());
  assert.strictEqual(F.display(r, data([op()]), NOW), null);
  assert.strictEqual(F.display(r, data([op()], { consistency: 'CHANGED_DURING_READ' }), NOW), null);
  assert.strictEqual(F.display(r, data([], { item: { record: 'INVALID_INDEX', truncated: false, opCount: 0, ops: [] } }), NOW), null);
  assert.strictEqual(F.display(r, data([], { item: { record: 'AMBIGUOUS', truncated: false, opCount: 0, ops: [] } }), NOW), null);
  assert.strictEqual(F.display(r, null, NOW), null);
});

test('表示: 保存値が無効（改訂・指紋の不一致、列なし、空欄、形式不正）や台帳が終端でない場合は出さない。同revisionの再発行・有効中の予約へ旧結果を出さない', function () {
  var r = saved(rec());
  assert.ok(F.display(r, none(), NOW));
  assert.strictEqual(F.display(Object.assign({}, r, { revision: 2 }), none(), NOW), null);
  assert.strictEqual(F.display(Object.assign({}, r, { endMs: ENDED_END + 1000 }), none(), NOW), null);
  assert.strictEqual(F.display(Object.assign({}, r, { keyFinalStatus: { columnPresent: false, raw: null } }), none(), NOW), null);
  assert.strictEqual(F.display(Object.assign({}, r, { keyFinalStatus: { columnPresent: true, raw: null } }), none(), NOW), null);
  assert.strictEqual(F.display(Object.assign({}, r, { keyFinalStatus: { columnPresent: true, raw: 'REVOKED_CONFIRMED' } }), none(), NOW), null);
  /* 終了前（有効中）・復活（確定へ戻って未終了）の予約には、同じ改訂・同じ指紋でも出さない */
  var active = rec({ endMs: NOW + 3600 * 1000 });
  var activeSaved = Object.assign({}, active, { keyFinalStatus: { columnPresent: true, raw: F.encode('REVOKED_CONFIRMED', active.revision, active) } });
  assert.strictEqual(F.display(activeSaved, none(), NOW), null);
  assert.ok(F.display(activeSaved, none(), NOW + 2 * 3600 * 1000), '終端になれば（指紋が一致する限り）表示対象');
  assert.strictEqual(F.display(Object.assign({}, r, { status: 'PENDING' }), none(), NOW), null);
});

// ================================================================ OpsApi（閲覧は読み取り専用）

var HEADER = ['bookingId', 'date', 'startAt', 'endAt', 'brand', 'status', 'cancelledAt', 'revision', 'accessKeyFinalStatus', 'name'];
function jst(y, m, d, hh, mm) { return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)); }
function ledgerRow(over) {
  var b = Object.assign({ bookingId: REF, date: '2026-11-30', startAt: jst(2026, 11, 30, 10, 0), endAt: jst(2026, 11, 30, 12, 0), brand: 'snb', status: 'CONFIRMED',
    cancelledAt: '', revision: 1, accessKeyFinalStatus: '', name: '架空 太郎' }, over || {});
  return HEADER.map(function (h) { return b[h]; });
}
function ledgerValues(rows, header) { return [header || HEADER].concat(rows); }
function fakeRes(code, body) { return { getResponseCode: function () { return code; }, getContentText: function () { return typeof body === 'string' ? body : JSON.stringify(body); }, getHeaders: function () { return {}; } }; }
function accessNone() { return { ok: true, v: 1, readAtSec: 1000, consistency: 'STABLE', jobs: { SYNC: 1, SWEEP: 1, DELIVER: 1, CLEANUP: 1 }, items: [{ ref: REF, record: 'NONE', truncated: false, opCount: 0, ops: [] }] }; }
function accessFound(ops, over) {
  return Object.assign({ ok: true, v: 1, readAtSec: 1000, consistency: 'STABLE', jobs: { SYNC: 1, SWEEP: 1, DELIVER: 1, CLEANUP: 1 }, items: [{ ref: REF, record: 'FOUND', truncated: false, opCount: ops.length, ops: ops }] }, over || {});
}
function ctxWith(over) {
  var calls = { fetch: [], ledger: 0 };
  var ctx = Object.assign({
    nowMs: NOW, authenticate: function () { return { ok: true }; },
    readLedger: function () { calls.ledger++; return { values: ledgerValues([ledgerRow()]) }; },
    accessConfig: function () { return { url: URL_OK, token: TOKEN, fetch: function (u, o) { calls.fetch.push({ url: u, options: o }); return fakeRes(200, accessNone()); } }; }
  }, over || {});
  return { ctx: ctx, calls: calls };
}
function api(sb, request, c) { return plain(sb.OpsApi.handle(request, c.ctx)); }
function savedRaw(over) {
  var r = rec(over);
  return F.encode('REVOKED_CONFIRMED', r.revision, load().OpsNormalizer.normalize([HEADER.concat([]), ledgerRow(Object.assign({}, over || {}))]).records[0]);
}

test('API: key_status は Access が正常に NONE かつ保存値が現在の台帳と一致するときだけ savedFinal を返す（検証済みの射影だけ）。画面を開くだけでは書き込まない', function () {
  var sb = load();
  var norm = sb.OpsNormalizer.normalize([HEADER, ledgerRow()]).records[0];
  var raw = sb.OpsKeyFinal.encode('REVOKED_CONFIRMED', 1, norm);
  var writes = [];
  var c = ctxWith({ readLedger: function () { return { values: ledgerValues([ledgerRow({ accessKeyFinalStatus: raw })]) }; } });
  var res = api(sb, { op: 'key_status', id: REF }, c);
  assert.deepStrictEqual(contract.validateKeyStatus(res), []);
  assert.strictEqual(res.keyStatus.verdict.code, 'NO_HISTORY');
  assert.deepStrictEqual(res.keyStatus.savedFinal, { code: 'REVOKED_CONFIRMED', label: '失効・不在を確認済み', source: 'BOOKINGS_SAVED' });
  assert.ok(JSON.stringify(res).indexOf(raw) === -1, '保存値そのもの（指紋）を返さない');
  assert.ok(JSON.stringify(res).indexOf('架空 太郎') === -1);
  assert.strictEqual(c.calls.fetch.length, 1, 'Access への問い合わせは1回のみ');
  assert.deepStrictEqual(writes, []);
  assert.deepStrictEqual(sb._logs, ['ops key_status NO_HISTORY']);
});

test('API: 保存値があっても、Access に実記録がある・取得失敗・未接続・保存値が古い（改訂/指紋不一致）・列なし・空欄のときは savedFinal=null（Accessの結果を隠さない）', function () {
  var sb = load();
  var norm = sb.OpsNormalizer.normalize([HEADER, ledgerRow()]).records[0];
  var raw = sb.OpsKeyFinal.encode('REVOKED_CONFIRMED', 1, norm);
  function withRaw(extra, over) { return ctxWith(Object.assign({ readLedger: function () { return { values: ledgerValues([ledgerRow(Object.assign({ accessKeyFinalStatus: raw }, extra || {}))]) }; } }, over || {})); }
  var found = withRaw(null, { accessConfig: function () { return { url: URL_OK, token: TOKEN, fetch: function () { return fakeRes(200, accessFound([{ rev: 1, kind: 'ISSUE', state: 'ISSUED_CONFIRMED', validFromSec: 1, validToSec: 2, updatedAtSec: 3, delivery: 'DELIVERED' }])); } }; } });
  assert.strictEqual(api(sb, { op: 'key_status', id: REF }, found).keyStatus.savedFinal, null);
  var failed = withRaw(null, { accessConfig: function () { return { url: URL_OK, token: TOKEN, fetch: function () { throw new Error('x'); } }; } });
  var fr = api(sb, { op: 'key_status', id: REF }, failed);
  assert.strictEqual(fr.keyStatus.verdict.code, 'FETCH_FAILED'); assert.strictEqual(fr.keyStatus.savedFinal, null);
  var nc = withRaw(null, { accessConfig: function () { return null; } });
  assert.strictEqual(api(sb, { op: 'key_status', id: REF }, nc).keyStatus.savedFinal, null);
  assert.strictEqual(api(sb, { op: 'key_status', id: REF }, withRaw({ revision: 2 })).keyStatus.savedFinal, null, '改訂番号が違う');
  assert.strictEqual(api(sb, { op: 'key_status', id: REF }, withRaw({ endAt: jst(2026, 11, 30, 13, 0) })).keyStatus.savedFinal, null, '指紋が違う（延長）');
  assert.strictEqual(api(sb, { op: 'key_status', id: REF }, withRaw({ accessKeyFinalStatus: '' })).keyStatus.savedFinal, null);
  var noColumn = ctxWith({ readLedger: function () { return { values: [HEADER.filter(function (h) { return h !== 'accessKeyFinalStatus'; }), ledgerRow().filter(function (_, i) { return HEADER[i] !== 'accessKeyFinalStatus'; })] }; } });
  var nr = api(sb, { op: 'key_status', id: REF }, noColumn);
  assert.strictEqual(nr.ok, true); assert.strictEqual(nr.keyStatus.savedFinal, null);
  [found, failed, nc].forEach(function () {});
});

test('API: 一覧・詳細・鍵状態は予約台帳へ書込みをしない（Sheetsへ GET 以外のリクエストを送らない）／handle から保存処理へは到達できない', function () {
  var requests = [];
  var world = { requests: requests, fetch: function (url, options) { requests.push({ url: url, method: String((options && options.method) || 'get').toLowerCase() }); return fakeRes(404, '{}'); } };
  var sb = load({ UrlFetchApp: { fetch: world.fetch }, ScriptApp: { getOAuthToken: function () { return 'tok'; } } });
  var c = ctxWith();
  ['list', 'detail', 'key_status'].forEach(function (op) { api(sb, { op: op, id: REF, params: {} }, c); });
  assert.ok(requests.every(function (r) { return r.method === 'get'; }));
  ['key_final_save', 'final_save', 'save_final', 'write'].forEach(function (op) { assert.strictEqual(api(sb, { op: op, id: REF }, c).error.code, 'INVALID_PARAMS', op); });
  var src = fs.readFileSync(path.join(DIR, 'OpsApi.gs'), 'utf8');
  var handleBody = src.slice(src.indexOf('function handle('), src.indexOf('function runKeyFinalSave'));
  assert.ok(!/OpsKeyFinal\.run|OpsKeyFinalStore|runKeyFinalSave/.test(handleBody), 'handle は保存処理を呼ばない');
  assert.ok(!/OpsKeyFinal\.run|OpsKeyFinalStore|\.write\(/.test(fs.readFileSync(path.join(DIR, 'OpsKeyStatus.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
  assert.ok(!/OpsKeyFinal\.run|OpsKeyFinalStore|\.write\(/.test(fs.readFileSync(path.join(DIR, 'OpsQuery.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
});

// ================================================================ 管理者の保存処理（run）

var RIDS = ['SNB-20261130-AAAA0001', 'SNB-20261130-AAAA0002', 'MENS-20261130-BBBB0003', 'SX-20261130-CCCC0004'];
function mkLedger(rowsOver, header) {
  var h = header || HEADER;
  return { values: [h].concat(rowsOver.map(function (o) { var b = ledgerRow(o); return h === HEADER ? b : h.map(function (name) { return b[HEADER.indexOf(name)]; }); })) };
}

function runWith(over) {
  var sb = load();
  var log = { fetch: [], reads: 0, writes: [], flag: 0 };
  var ledgerOver = over && over.ledger;
  var deps = {
    authenticate: function () { return { ok: true }; },
    getFlag: function () { log.flag++; return 'ON'; },
    accessConfig: function () { return { url: URL_OK, token: TOKEN }; },
    readLedger: function () { log.reads++; return typeof ledgerOver === 'function' ? ledgerOver(log.reads) : (ledgerOver || mkLedger([{}])); },
    fetchAccess: function (cfg, id) { log.fetch.push(id); return { ok: true, data: data([op()]) }; },
    store: { write: function (input) { log.writes.push(input); } },
    withLock: function (fn) { return fn(); },
    nowMs: NOW
  };
  Object.keys(over || {}).forEach(function (k) { if (k !== 'ledger') deps[k] = over[k]; });
  var result = plain(sb.OpsKeyFinal.run(deps));
  return { result: result, log: log, sb: sb };
}

test('保存処理: 固定設定がONでなければ何もしない（通信・台帳読取・書込みなし）。認可は毎回', function () {
  ['OFF', '', null, undefined, 'on', 'true'].forEach(function (flag) {
    var t = runWith({ getFlag: function () { return flag; } });
    assert.deepStrictEqual(t.result, { ok: false, code: 'WRITE_DISABLED' }, String(flag));
    assert.strictEqual(t.log.reads, 0); assert.deepStrictEqual(t.log.fetch, []); assert.deepStrictEqual(t.log.writes, []);
  });
  [{ ok: false, code: 'FORBIDDEN' }, { ok: false, code: 'UNAUTHENTICATED' }, null].forEach(function (auth) {
    var t = runWith({ authenticate: function () { return auth; } });
    assert.strictEqual(t.result.ok, false); assert.ok(['FORBIDDEN', 'UNAUTHENTICATED'].indexOf(t.result.code) !== -1);
    assert.strictEqual(t.log.flag, 0); assert.strictEqual(t.log.reads, 0);
  });
});

test('保存処理: 鍵管理が未接続・設定不正・台帳未接続・列なし・ロック競合のときは何も書かない', function () {
  assert.strictEqual(runWith({ accessConfig: function () { return null; } }).result.code, 'ACCESS_NOT_CONNECTED');
  assert.strictEqual(runWith({ accessConfig: function () { throw new Error('SECRET-CONFIG'); } }).result.code, 'ACCESS_CONFIG_INVALID');
  assert.strictEqual(runWith({ ledger: { notConnected: true } }).result.code, 'LEDGER_NOT_CONNECTED');
  assert.strictEqual(runWith({ ledger: function () { throw new Error('x'); } }).result.code, 'LEDGER_READ_FAILED');
  var noCol = HEADER.filter(function (h) { return h !== 'accessKeyFinalStatus'; });
  var t = runWith({ ledger: mkLedger([{}], noCol) });
  assert.strictEqual(t.result.code, 'COLUMN_MISSING'); assert.deepStrictEqual(t.log.writes, []); assert.deepStrictEqual(t.log.fetch, []);
  var busy = runWith({ withLock: function () { return { busy: true }; } });
  assert.strictEqual(busy.result.code, 'BUSY'); assert.deepStrictEqual(busy.log.writes, []);
  assert.ok(JSON.stringify(runWith({ accessConfig: function () { throw new Error('SECRET-CONFIG'); } }).result).indexOf('SECRET-CONFIG') === -1);
});

test('保存処理: 検証済みの結果だけを1件ずつ書く。書込み直前に台帳を再読込し、値は <CODE>@r<改訂>@h<指紋> の形式', function () {
  var t = runWith({});
  assert.deepStrictEqual(t.result, { ok: true, code: 'DONE', candidates: 1, processed: 1, saved: 1, deferred: 0, skipped: {}, stoppedBy: null });
  assert.strictEqual(t.log.writes.length, 1);
  assert.strictEqual(t.log.writes[0].bookingId, REF);
  assert.strictEqual(t.log.writes[0].rowNumber, 2);
  assert.match(t.log.writes[0].value, /^REVOKED_CONFIRMED@r1@h[0-9a-f]{16}$/);
  assert.ok(t.log.reads >= 2, '初回読取＋書込み直前の再読込');
  /* 書込んだ値は、同じ台帳に対して有効（表示対象になる） */
  var n = t.sb.OpsNormalizer.normalize([HEADER, ledgerRow({ accessKeyFinalStatus: t.log.writes[0].value })]).records[0];
  assert.ok(t.sb.OpsKeyFinal.display(n, none(), NOW));
});

test('保存処理: 3ブランド・取消（発行失敗のみ）を扱い、対象外ブランド・有効中・利用前・古すぎる予約は問い合わせない', function () {
  var ledger = mkLedger([
    { bookingId: RIDS[0], brand: 'snb' }, { bookingId: RIDS[1], brand: 'mens' }, { bookingId: RIDS[2], brand: 'studio_x' },
    { bookingId: RIDS[3], brand: 'snb', status: 'CANCELLED', cancelledAt: '2026-11-29 10:00' },
    { bookingId: 'SNB-20261130-AAAA0010', brand: 'other' },
    { bookingId: 'SNB-20261201-AAAA0011', startAt: jst(2026, 12, 1, 15, 0), endAt: jst(2026, 12, 1, 17, 0) },
    { bookingId: 'SNB-20260101-AAAA0012', startAt: jst(2026, 1, 1, 10, 0), endAt: jst(2026, 1, 1, 12, 0) },
    { bookingId: 'SNB-20261130-AAAA0013', status: 'PENDING' }
  ]);
  var log = { fetch: [], writes: [] };
  var r = runWith({ ledger: ledger, fetchAccess: function (cfg, id) { log.fetch.push(id); return { ok: true, data: data([op({ state: id === RIDS[3] ? 'FAILED' : 'DELETED_CONFIRMED' })]) }; }, store: { write: function (i) { log.writes.push(i); } } });
  assert.deepStrictEqual(log.fetch.slice().sort(), RIDS.slice().sort(), '問い合わせは対象ブランドの終端予約だけ');
  assert.strictEqual(r.result.saved, 4);
  var byId = {}; log.writes.forEach(function (w) { byId[w.bookingId] = w.value; });
  assert.match(byId[RIDS[3]], /^NOT_ISSUED_CONFIRMED@r1@h/);
  [RIDS[0], RIDS[1], RIDS[2]].forEach(function (id) { assert.match(byId[id], /^REVOKED_CONFIRMED@r1@h/, id); });
});

test('保存処理: 1回の問い合わせは最大10件（新しい終端の予約から）。超過は件数として返す。自動で繰り返さない', function () {
  var rows = [];
  for (var i = 0; i < 13; i++) rows.push({ bookingId: 'SNB-2026113' + '0-AAAA' + ('0000' + (100 + i)).slice(-4), endAt: jst(2026, 11, 30, 12, 0) , startAt: jst(2026, 11, 30, 10, 0) });
  var log = { fetch: [] };
  var r = runWith({ ledger: mkLedger(rows), fetchAccess: function (cfg, id) { log.fetch.push(id); return { ok: true, data: none() }; } });
  assert.strictEqual(log.fetch.length, 10);
  assert.strictEqual(r.result.candidates, 13); assert.strictEqual(r.result.deferred, 3); assert.strictEqual(r.result.processed, 10);
  assert.strictEqual(r.result.saved, 0); assert.strictEqual(r.result.skipped.NO_RECORD, 10, 'Access NONE は保存しない');
});

test('保存処理: Access の取得に失敗したら、その時点で停止して以降は問い合わせない（失敗を成功にしない）', function () {
  var rows = RIDS.map(function (id) { return { bookingId: id }; });
  var log = { fetch: [] };
  var r = runWith({ ledger: mkLedger(rows), fetchAccess: function (cfg, id) { log.fetch.push(id); return { ok: false, reason: 'NETWORK' }; } });
  assert.strictEqual(log.fetch.length, 1);
  assert.strictEqual(r.result.stoppedBy, 'NETWORK'); assert.strictEqual(r.result.saved, 0); assert.deepStrictEqual(r.log.writes, []);
});

test('保存処理: 保存済み（有効）は再問合せしない。保存値が古い（改訂・指紋不一致）なら再度対象にする。有効な別の値とは衝突として上書きしない', function () {
  var sb = load();
  var norm = sb.OpsNormalizer.normalize([HEADER, ledgerRow()]).records[0];
  var valid = sb.OpsKeyFinal.encode('REVOKED_CONFIRMED', 1, norm);
  var log1 = { fetch: [] };
  var r1 = runWith({ ledger: mkLedger([{ accessKeyFinalStatus: valid }]), fetchAccess: function (c, id) { log1.fetch.push(id); return { ok: true, data: data([op()]) }; } });
  assert.deepStrictEqual(log1.fetch, []); assert.strictEqual(r1.result.skipped.ALREADY_SAVED, 1); assert.deepStrictEqual(r1.log.writes, []);
  var stale = sb.OpsKeyFinal.encode('REVOKED_CONFIRMED', 1, Object.assign({}, norm, { endMs: norm.endMs - 3600000 }));
  var r2 = runWith({ ledger: mkLedger([{ accessKeyFinalStatus: stale }]) });
  assert.strictEqual(r2.result.saved, 1, '古い保存値は現在の確認結果で置き換える');
  var junk = runWith({ ledger: mkLedger([{ accessKeyFinalStatus: 'ISSUED_CONFIRMED' }]) });
  assert.strictEqual(junk.result.saved, 1, '形式不正の値は無効として扱い、検証済みの結果で置き換える');
  /* 有効な NOT_ISSUED が保存されていて、確認結果は REVOKED → 再問合せしない（有効な保存値がある限り対象外）。再問合せ中に有効値が現れた場合は衝突 */
  var validOther = sb.OpsKeyFinal.encode('NOT_ISSUED_CONFIRMED', 1, norm);
  var reads = 0;
  var r3 = runWith({ ledger: function () { reads++; return mkLedger([{ accessKeyFinalStatus: reads === 1 ? '' : validOther }]); } });
  assert.strictEqual(r3.result.saved, 0); assert.strictEqual(r3.result.skipped.SAVED_VALUE_CONFLICT, 1);
});

test('保存処理: 書込み直前の再読込で、改訂・状態・日時が変わっていた／重複した／消えていた場合は書かない', function () {
  function changing(second) { var n = 0; return function () { n++; return n === 1 ? mkLedger([{}]) : second(); }; }
  var cases = {
    revision: changing(function () { return mkLedger([{ revision: 2 }]); }),
    status: changing(function () { return mkLedger([{ status: 'PENDING' }]); }),
    endAt: changing(function () { return mkLedger([{ endAt: jst(2026, 11, 30, 13, 0) }]); }),
    duplicate: changing(function () { return mkLedger([{}, {}]); }),
    gone: changing(function () { return mkLedger([{ bookingId: 'SNB-20261130-ZZZZ9999' }]); })
  };
  Object.keys(cases).forEach(function (k) {
    var r = runWith({ ledger: cases[k] });
    assert.deepStrictEqual(r.log.writes, [], k);
    assert.strictEqual(r.result.saved, 0, k);
    assert.strictEqual(r.result.skipped.LEDGER_CHANGED, 1, k);
  });
  var rr = runWith({ ledger: function (n) { if (n > 1) throw new Error('x'); return mkLedger([{}]); } });
  assert.strictEqual(rr.result.stoppedBy, 'LEDGER_READ_FAILED'); assert.deepStrictEqual(rr.log.writes, []);
});

test('保存処理: 重複する予約IDの行・予約IDの形式が不正な行は対象にしない', function () {
  var r = runWith({ ledger: mkLedger([{}, {}]) });
  assert.strictEqual(r.result.candidates, 0); assert.deepStrictEqual(r.log.fetch, []);
  var bad = runWith({ ledger: mkLedger([{ bookingId: 'FAKE-001' }]) });
  assert.strictEqual(bad.result.candidates, 0);
});

test('保存処理: 書込みに失敗したら未保存として停止し、成功扱いにしない。戻り値・ログに予約ID・保存値・行番号を出さない', function () {
  var r = runWith({ store: { write: function () { var e = new Error('SECRET-BODY'); e.opsReason = 'WRITE_HTTP/403'; throw e; } } });
  assert.strictEqual(r.result.saved, 0); assert.strictEqual(r.result.stoppedBy, 'WRITE_HTTP/403');
  var weird = runWith({ store: { write: function () { throw new Error('SECRET-BODY ' + REF); } } });
  assert.strictEqual(weird.result.stoppedBy, 'WRITE_FAILED');
  var blob = JSON.stringify(r.result) + JSON.stringify(weird.result) + r.sb._logs.join('\n');
  [REF, 'SECRET-BODY', 'REVOKED_CONFIRMED@', TOKEN, URL_OK, '架空'].forEach(function (v) { assert.ok(blob.indexOf(v) === -1, v); });
});

test('保存処理: GAS入口（OpsApi.runKeyFinalSave）は固定設定OFFなら通信せず、ログは件数と固定コードだけ', function () {
  var fetched = 0;
  var sb = load({ UrlFetchApp: { fetch: function () { fetched++; return fakeRes(404, '{}'); } }, ScriptApp: { getOAuthToken: function () { return 'tok'; } },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function (k) { return k === 'OPS_SPREADSHEET_ID' ? SHEET_ID : null; } }; } },
    LockService: { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } } });
  var res = plain(sb.OpsApi.runKeyFinalSave({ authenticate: function () { return { ok: true }; }, accessConfig: function () { throw new Error('must not be called'); } }));
  assert.deepStrictEqual(res, { ok: false, code: 'WRITE_DISABLED' });
  assert.strictEqual(fetched, 0);
  assert.deepStrictEqual(sb._logs, ['ops key_final_save WRITE_DISABLED']);
  assert.strictEqual(typeof sb.opsSaveKeyFinalStatuses, 'function');
});

// ================================================================ 書込み先（OpsKeyFinalStore）

function storeWorld(over) {
  var o = Object.assign({ header: HEADER.slice(), idCell: REF, readback: null, writeStatus: 200, updatedCells: 1, failOn: null }, over || {});
  var requests = [];
  var finalLetter = String.fromCharCode(65 + HEADER.indexOf('accessKeyFinalStatus'));
  var idLetter = 'A';
  var written = null;
  function fetch(url, options) {
    var method = String((options && options.method) || 'get').toLowerCase();
    requests.push({ url: url, method: method, payload: options && options.payload ? JSON.parse(options.payload) : null, headers: options && options.headers });
    if (o.failOn && o.failOn(method, url)) return fakeRes(500, '{"error":"SECRET-BODY"}');
    var dec = decodeURIComponent(url);
    if (method === 'get' && /!1:1\?/.test(dec)) return fakeRes(200, { values: [o.header] });
    if (method === 'get' && new RegExp("!" + idLetter + "[0-9]+\\?").test(dec)) return fakeRes(200, { values: [[o.idCell]] });
    if (method === 'put') { written = JSON.parse(options.payload).values[0][0]; return fakeRes(o.writeStatus, { updatedCells: o.updatedCells }); }
    if (method === 'get' && new RegExp("!" + finalLetter + "[0-9]+\\?").test(dec)) return fakeRes(200, { values: [[o.readback === null ? written : o.readback]] });
    return fakeRes(404, '{}');
  }
  var sb = load();
  return { sb: sb, requests: requests, store: sb.OpsKeyFinalStore.create({ spreadsheetId: SHEET_ID, fetch: fetch, getToken: function () { return 'TOKEN-SECRET'; } }), finalLetter: finalLetter };
}
var GOOD = 'REVOKED_CONFIRMED@r1@h0123456789abcdef';

test('書込み先: 予約台帳 Bookings の accessKeyFinalStatus 列の1セルだけ（PUT 1回・valueInputOption=RAW）。書込み後に読み戻して検証する', function () {
  var w = storeWorld();
  w.store.write({ rowNumber: 5, bookingId: REF, value: GOOD });
  var puts = w.requests.filter(function (r) { return r.method === 'put'; });
  assert.strictEqual(puts.length, 1);
  assert.match(decodeURIComponent(puts[0].url), new RegExp("/values/'Bookings'!" + w.finalLetter + '5\\?valueInputOption=RAW$'));
  assert.deepStrictEqual(puts[0].payload, { majorDimension: 'ROWS', values: [[GOOD]] });
  assert.ok(w.requests.every(function (r) { return r.method === 'get' || r.method === 'put'; }), 'append/batchUpdate/clear を使わない');
  assert.ok(w.requests.every(function (r) { return r.url.indexOf('TOKEN-SECRET') === -1 && r.headers.Authorization === 'Bearer TOKEN-SECRET'; }), 'トークンはヘッダーだけ');
  assert.strictEqual(w.requests[w.requests.length - 1].method, 'get', '最後は読み戻し');
});

test('書込み先: 列が無い・重複・予約IDの行が違う・読み戻しが違う・書込み未確認・HTTP失敗は、未保存として例外（固定コード・本文を保持しない）', function () {
  function reason(over, input) {
    var w = storeWorld(over);
    try { w.store.write(input || { rowNumber: 5, bookingId: REF, value: GOOD }); } catch (e) { assert.strictEqual(e.opsCode, 'FINAL_STORE_FAILED'); assert.ok(String(e.message + e.opsReason).indexOf('SECRET') === -1); return { reason: e.opsReason, requests: w.requests }; }
    return { reason: null, requests: w.requests };
  }
  var noCol = reason({ header: HEADER.filter(function (h) { return h !== 'accessKeyFinalStatus'; }) });
  assert.strictEqual(noCol.reason, 'COLUMN_MISSING'); assert.ok(noCol.requests.every(function (r) { return r.method === 'get'; }));
  assert.strictEqual(reason({ header: HEADER.concat(['accessKeyFinalStatus']) }).reason, 'COLUMN_DUPLICATE');
  assert.strictEqual(reason({ header: HEADER.concat(['bookingId']) }).reason, 'ID_COLUMN_INVALID');
  var mismatch = reason({ idCell: 'SNB-20261130-ZZZZ9999' });
  assert.strictEqual(mismatch.reason, 'ROW_MISMATCH'); assert.ok(mismatch.requests.every(function (r) { return r.method === 'get'; }), '予約IDが違えば書かない');
  assert.strictEqual(reason({ readback: 'REVOKED_CONFIRMED@r2@h0123456789abcdef' }).reason, 'READBACK_MISMATCH');
  assert.strictEqual(reason({ updatedCells: 0 }).reason, 'WRITE_NOT_CONFIRMED');
  assert.strictEqual(reason({ writeStatus: 403 }).reason, 'WRITE_HTTP/403');
  assert.strictEqual(reason({ failOn: function (m) { return m === 'get'; } }).reason, 'HEADER_HTTP/500');
});

test('書込み先: 受け付ける値は保存値の形式だけ。行番号・予約ID・書込み先IDの不正は書かずに停止', function () {
  ['', 'ISSUED_CONFIRMED@r1@h0123456789abcdef', 'REVOKED_CONFIRMED', '=1+1', 'REVOKED_CONFIRMED@r1@h0123456789abcdef\n', 'REVOKED_CONFIRMED@r1@h0123'].forEach(function (v) {
    var w = storeWorld();
    assert.throws(function () { w.store.write({ rowNumber: 5, bookingId: REF, value: v }); }, function (e) { return e.opsReason === 'VALUE_INVALID'; }, JSON.stringify(v));
    assert.strictEqual(w.requests.length, 0);
  });
  [1, 0, -3, 2.5, '5', null].forEach(function (n) {
    var w = storeWorld();
    assert.throws(function () { w.store.write({ rowNumber: n, bookingId: REF, value: GOOD }); }, function (e) { return e.opsReason === 'INPUT_INVALID'; }, String(n));
    assert.strictEqual(w.requests.length, 0);
  });
  var w2 = storeWorld();
  assert.throws(function () { w2.store.write({ rowNumber: 5, bookingId: '', value: GOOD }); }, function (e) { return e.opsReason === 'INPUT_INVALID'; });
  var sb = load();
  var bad = sb.OpsKeyFinalStore.create({ spreadsheetId: 'short', fetch: function () { throw new Error('no'); }, getToken: function () { return 't'; } });
  assert.throws(function () { bad.write({ rowNumber: 5, bookingId: REF, value: GOOD }); }, function (e) { return e.opsReason === 'TARGET_INVALID'; });
});

// ================================================================ 静的な境界・非回帰・保持

function strip(src) { return src.replace(/\/\*[\s\S]*?\*\//g, ''); }

test('境界: 予約台帳の他の列・他のシートへ書かない。OpsSource は GET のみのまま。UrlFetchApp は OpsApi.gs だけ。Access GAS・Booking の鍵連携は無変更', function () {
  var source = strip(fs.readFileSync(path.join(DIR, 'OpsSource.gs'), 'utf8'));
  assert.ok(!/method: '(post|put|patch|delete)'/i.test(source));
  var users = fs.readdirSync(DIR).filter(function (f) { return /UrlFetchApp/.test(strip(fs.readFileSync(path.join(DIR, f), 'utf8'))); });
  assert.deepStrictEqual(users, ['OpsApi.gs']);
  var store = strip(fs.readFileSync(path.join(DIR, 'OpsKeyFinalStore.gs'), 'utf8'));
  assert.ok(!/:append|:batchUpdate|:clear|:copyTo|addSheet|deleteDimension/.test(store));
  assert.strictEqual((store.match(/method: 'put'|'put'/g) || []).length, 1, 'PUT は1か所だけ');
  assert.ok(!/PropertiesService|ScriptApp|UrlFetchApp|SpreadsheetApp/.test(store));
  var final = strip(fs.readFileSync(path.join(DIR, 'OpsKeyFinal.gs'), 'utf8'));
  assert.ok(!/PropertiesService|ScriptApp|UrlFetchApp|SpreadsheetApp|MailApp|newTrigger/.test(final));
  /* 自動トリガー・スコープ追加なし（Phase 2は別承認） */
  ['OpsApi.gs', 'OpsKeyFinal.gs', 'OpsKeyFinalStore.gs'].forEach(function (f) { assert.ok(!/newTrigger|ScriptApp\.(newTrigger|getProjectTriggers)/.test(strip(fs.readFileSync(path.join(DIR, f), 'utf8'))), f); });
  var manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8'));
  assert.deepStrictEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email']);
  /* Access GAS は列名を一切参照しない（権限・入口・ロジック無変更） */
  fs.readdirSync(path.join(ROOT, 'gas', 'switchbot-access')).forEach(function (f) {
    var s = fs.readFileSync(path.join(ROOT, 'gas', 'switchbot-access', f), 'utf8');
    assert.ok(!/accessKeyFinalStatus|OpsKeyFinal|FIN_/.test(s), f);
  });
  assert.ok(!/spreadsheets"/.test(fs.readFileSync(path.join(ROOT, 'gas', 'switchbot-access', 'appsscript.json'), 'utf8').replace(/spreadsheets\.readonly/g, '')), 'Access GAS のSheets権限は readonly のまま');
});

test('境界: Bookings の新列を書く・読むのは運営GASの保存/表示だけ。予約・決済・Webhook・保持（個人情報消去）のコードは参照しない', function () {
  var hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (/\.(gs|html|json)$/.test(e.name) && /accessKeyFinalStatus/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(path.join(ROOT, 'gas'), p));
    });
  })(path.join(ROOT, 'gas'));
  assert.deepStrictEqual(hits.sort(), ['booking/shared/BookingsSchema.gs', 'ops-reservations/OpsApi.gs', 'ops-reservations/OpsKeyFinal.gs', 'ops-reservations/OpsKeyFinalStore.gs', 'ops-reservations/OpsNormalizer.gs']);
  var retention = fs.readFileSync(path.join(ROOT, 'gas', 'booking', 'admin', 'PersonalDataRetention.gs'), 'utf8');
  assert.ok(!/accessKeyFinalStatus/.test(retention), '#680 の180日整理の対象列は変更しない（保持期間を延ばさず、個人情報も増やさない）');
});

test('スキーマ: accessKeyFinalStatus は Bookings の末尾の1列だけ（途中挿入なし・重複なし）。revision・既存列の順序は不変', function () {
  var h = loadBookingSandbox(['BookingsSchema.gs'], {}).BookingsSchema.HEADERS;
  assert.strictEqual(h[h.length - 1], 'accessKeyFinalStatus');
  assert.strictEqual(h[h.length - 2], 'revision');
  assert.strictEqual(h.filter(function (x) { return x === 'accessKeyFinalStatus'; }).length, 1);
  assert.strictEqual(h.indexOf('accessKeyFinalStatus'), h.length - 1);
});

test('正規化: 保存値は内部の keyFinalStatus に入るだけで、一覧・詳細の応答（画面）へは出ない', function () {
  var sb = load();
  var c = ctxWith({ readLedger: function () { return { values: ledgerValues([ledgerRow({ accessKeyFinalStatus: GOOD })]) }; } });
  var list = api(sb, { op: 'list', params: { scope: 'all' } }, c);
  var detail = api(sb, { op: 'detail', id: REF }, c);
  assert.ok(JSON.stringify(list).indexOf('REVOKED_CONFIRMED') === -1 && JSON.stringify(detail).indexOf('REVOKED_CONFIRMED') === -1);
  assert.ok(JSON.stringify(detail).indexOf('accessKeyFinalStatus') === -1 && JSON.stringify(detail).indexOf('keyFinalStatus') === -1);
  assert.ok(sb.OpsNormalizer.ALLOWED_COLUMNS.indexOf('accessKeyFinalStatus') !== -1);
});

// ================================================================ 画面

test('画面: 「Bookings保存：過去の最終確認」を、Access の現行記録とは別ブロックで、保存時点の確認結果として表示する。savedFinal が無ければ出さない', function () {
  function open(key) {
    var api4 = Mock.createMockApi({ nowMs: NOW, defer: function (fn) { fn(); }, key: key });
    var ctl = C.createController(api4, function () {});
    ctl.openDetail('MOCK-002');
    return C.renderBanner(ctl.state) + C.renderView(ctl.state);
  }
  var without = open('ok');
  assert.ok(without.indexOf('data-saved-final') === -1);
  assert.ok(without.indexOf('data-verdict="NO_HISTORY"') !== -1);
  var html = open('saved');
  assert.ok(/data-saved-final="REVOKED_CONFIRMED"/.test(html));
  assert.ok(/Bookings保存：過去の最終確認/.test(html) && /保存時点の確認結果/.test(html) && /保証するものではありません/.test(html));
  assert.ok(html.indexOf('data-verdict="NO_HISTORY"') !== -1, 'Accessの判定（履歴なし）は消さない');
  assert.ok(html.indexOf('data-saved-final') < html.indexOf('data-verdict'), '補助表示');
  assert.ok(/data-lifecycle="NO_HISTORY"/.test(html), '個別鍵の状態（判別不可）も消さない');
});

test('画面: モックの ?key=saved は履歴が回収済みの予約に保存済みの過去の最終確認を出し、契約の検証を通る（他のシナリオは出さない）', function () {
  ['saved', 'ok'].forEach(function (key) {
    var api4 = Mock.createMockApi({ nowMs: NOW, defer: function (fn) { fn(); }, key: key });
    api4.keyStatus('MOCK-002', function (res) {
      assert.deepStrictEqual(contract.validateKeyStatus(res), [], key);
      assert.strictEqual(res.keyStatus.savedFinal === null, key !== 'saved');
      assert.strictEqual(res.keyStatus.verdict.code, 'NO_HISTORY');
    });
  });
});

test('配布物: 新ファイルは運営GASの配布物に含まれ、生成ページは最新（OpsPage.html は ops-client.js と同期）', function () {
  var lib = require(path.join(ROOT, 'scripts', 'ops-reservations-gas-deploy-lib.js'));
  assert.ok(lib.BUNDLE_FILES.indexOf('OpsKeyFinal.gs') !== -1 && lib.BUNDLE_FILES.indexOf('OpsKeyFinalStore.gs') !== -1);
  var build = require(path.join(ROOT, 'scripts', 'build-ops-gas-page.js'));
  assert.strictEqual(fs.readFileSync(path.join(DIR, 'OpsPage.html'), 'utf8'), build.build());
});
