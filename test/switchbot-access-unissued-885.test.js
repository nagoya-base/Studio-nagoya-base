/*
 * Issue #885: 開始直前・開始後の個別キー未発行の検知と、開始15分前からの優先再評価。
 * フェイクworldのみ（実API・実機・実メールなし）。発行・再発行の仕組みは変えず、通知と待ち時間の短縮だけを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var H = require('./helpers/switchbot-access-world');
var Core = H.Core, S = Core.STATE;

var DAY = '2030-01-11';

function world() {
  var w = H.createWorld({});
  w.createMode = 'noCommandId';
  w.preload(H.DEV, 2);
  return w;
}
function at(w, hhmmss) { w.nowMs = Date.parse(DAY + 'T' + hhmmss + '+09:00'); }
function alerts(w, code) { return w.mails.filter(function (m) { return m.subject.indexOf(code) !== -1; }); }
function opsOf(w, state) {
  return w.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; })
    .map(function (k) { return JSON.parse(w.store.get(k)); }).filter(function (o) { return o.state === state; });
}
/** 発行が受理されない（鍵が作られない）状態。 */
function rejectIssue(w) {
  w.api.createKey = function (p) { w.calls.push({ name: 'createKey', device: p.deviceId }); return { httpCode: 400, parsed: { statusCode: 400, body: {} } }; };
}

test('開始5分以内（4分前）に個別キーが未確認なら緊急通知する。10分前は通知しない', function () {
  var w = world(); rejectIssue(w); var rt = w.runtime();
  w.records = [H.record()]; // 10:00-12:00

  at(w, '09:50:00');
  rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 0, '10分前は通知しない');

  at(w, '09:56:00');
  rt.syncCycle();
  var m = alerts(w, 'KEY_NOT_ISSUED_SOON');
  assert.strictEqual(m.length, 1, '4分前は通知する');
  assert.ok(/\[high\]/.test(m[0].subject));
  assert.ok(m[0].body.indexOf('代替入室') !== -1);
  assert.ok(m[0].body.indexOf('SNB-1') !== -1, '予約参照を含む');
  assert.ok(!/[0-9]{6,}/.test(m[0].body.replace('SNB-1', '')), '暗証番号・長い数字を含まない');
});

test('開始ちょうど5:00前は通知、5:01前は通知しない（境界）', function () {
  var w = world(); rejectIssue(w); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:54:59'); rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 0);
  at(w, '09:55:00'); rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 1);
});

test('開始後・終了前でも未発行なら別コードで通知し続ける（再通知は10分間隔）。終了後は通知しない', function () {
  var w = world(); rejectIssue(w); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '10:05:00'); rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_STARTED').length, 1);
  at(w, '10:10:00'); rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_STARTED').length, 1, '10分未満は再通知しない');
  at(w, '10:16:00'); rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_STARTED').length, 2, '10分経過で再通知');
  var before = w.mails.length;
  at(w, '12:30:00'); rt.syncCycle();
  assert.strictEqual(w.mails.length, before, '終了後は通知しない');
});

test('個別キーが反映確認済みなら通知しない', function () {
  var w = world(); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:30:00');
  for (var i = 0; i < 4; i++) { rt.syncCycle(); w.advance(300); }
  assert.ok(opsOf(w, S.ISSUED_CONFIRMED).length >= 1, '前提: 発行・反映確認済み');
  at(w, '09:56:00'); rt.syncCycle();
  at(w, '10:05:00'); rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED').length, 0);
});

test('取消・非対象ブランド・限定稼働外の予約は未発行通知の対象にしない', function () {
  var w = world(); rejectIssue(w); var rt = w.runtime();
  at(w, '09:56:00');
  w.records = [H.record({ status: 'CANCELLED', revision: 2 })]; rt.syncCycle();
  w.records = [H.record({ bookingId: 'MENS-1', brand: 'mens' })]; rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED').length, 0);
});

test('優先再評価: 開始10分前は観測待ち（静穏時間）を待たず、最初の周期で発行を試みる', function () {
  var w = world(); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:50:00'); // 開始10分前
  rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1, '優先窓では最初の周期で発行する');
});

test('優先窓の外（開始60分前）は従来どおり、最初の周期は観測のみで発行しない', function () {
  var w = world(); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:00:00');
  rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 0, '従来の静穏時間は維持');
});

test('通知メールの送信が失敗しても照合サイクルは成功のまま', function () {
  var w = world(); rejectIssue(w); w.mailFail = true; var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:56:00');
  var out = rt.syncCycle();
  assert.strictEqual(out.ok, true);
});

test('API予算を使い切っていても、開始5分以内の未発行は運営者へ通知する（SwitchBot APIは呼ばない）', function () {
  var w = world(); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:56:00');
  var key = 'APICOUNT_' + '20300111';
  w.props[key] = '8000';
  var out = rt.syncCycle();
  assert.strictEqual(out.error, 'API_BUDGET_EXHAUSTED');
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 1);
  assert.strictEqual(w.callCount('createKey'), 0, '変更APIは呼ばない');
  assert.strictEqual(w.callCount('listDevices'), 0, 'SwitchBot APIを読まない');
});

test('通知メールが不達だった未発行通知は、回復後に利用終了を過ぎていれば送らず破棄する', function () {
  var w = world(); rejectIssue(w); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:56:00');
  w.mailFail = true;
  rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 0, '不達');
  w.mailFail = false;
  at(w, '12:30:00');
  rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED').length, 0, '終了後は古い緊急通知を送らない');
  var pending = w.store.keys().filter(function (k) { return k.indexOf('IALERT_KEY_NOT_ISSUED') === 0; });
  assert.strictEqual(pending.length, 0, '破棄される');
});

test('通知メールが不達の間に個別キーが反映確認済みになれば、回復後も古い緊急通知は送らない', function () {
  var w = world(); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:56:00');
  w.mailFail = true;
  // 不達で送信待ちに残った未発行通知（revision 1）を再現する
  rt.infraAlert('KEY_NOT_ISSUED_SOON', 'SNB-1', 1, null, 300, Math.floor(Date.parse(DAY + 'T12:00:00+09:00') / 1000));
  assert.ok(w.store.keys().some(function (k) { return k.indexOf('IALERT_KEY_NOT_ISSUED_SOON') === 0; }), '前提: 不達の通知が送信待ちに残っている');
  w.mailFail = false;
  for (var i = 0; i < 4; i++) { rt.syncCycle(); w.advance(60); }
  assert.ok(opsOf(w, S.ISSUED_CONFIRMED).length >= 1, '前提: 反映確認済み');
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED').length, 0, '反映確認後は古い通知を送らない');
});

// ---- 段階化（予告→緊急→開始後）と、再送直前の再評価（オーナーレビュー）----

test('段階化: 開始10分前に予告（NOTICE）、5分前に緊急（SOON）、開始後に通知（STARTED）。5分周期で重複しない', function () {
  var w = world(); rejectIssue(w); var rt = w.runtime();
  w.records = [H.record()]; // 10:00開始
  at(w, '09:48:00'); rt.syncCycle();                       // 12分前: 通知なし
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED').length, 0);
  at(w, '09:53:00'); rt.syncCycle();                       // 7分前: 予告
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_NOTICE').length, 1);
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 0);
  at(w, '09:58:00'); rt.syncCycle();                       // 2分前: 緊急
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 1);
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_NOTICE').length, 1, '予告は再送しない');
  at(w, '10:03:00'); rt.syncCycle();                       // 開始後
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_STARTED').length, 1);
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 1, '緊急は再送しない');
  at(w, '10:08:00'); rt.syncCycle();                       // 開始後5分: 10分間隔のため再通知なし
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_STARTED').length, 1);
  at(w, '10:14:00'); rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_STARTED').length, 2);
});

test('予告は開始10:00前ちょうどから（境界）。severityは予告=medium、緊急=high', function () {
  var w = world(); rejectIssue(w); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:49:59'); rt.syncCycle();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_NOTICE').length, 0);
  at(w, '09:50:00'); rt.syncCycle();
  var n = alerts(w, 'KEY_NOT_ISSUED_NOTICE');
  assert.strictEqual(n.length, 1);
  assert.ok(/\[medium\]/.test(n[0].subject));
});

test('文言: 反映未確認と表現し、「発行失敗」と断定しない', function () {
  var w = world(); rejectIssue(w); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:56:00'); rt.syncCycle();
  var body = alerts(w, 'KEY_NOT_ISSUED_SOON')[0].body;
  assert.ok(body.indexOf('反映が確認できていない') !== -1);
  assert.ok(body.indexOf('発行失敗') === -1 || body.indexOf('発行失敗と断定') !== -1);
});

function pendingAlertThenChange(change) {
  var w = world(); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:56:00');
  w.mailFail = true;
  rt.infraAlert('KEY_NOT_ISSUED_SOON', 'SNB-1', 1, null, 300, Math.floor(Date.parse(DAY + 'T12:00:00+09:00') / 1000));
  assert.ok(w.store.keys().some(function (k) { return k.indexOf('IALERT_KEY_NOT_ISSUED_SOON') === 0; }), '前提: 送信待ち');
  change(w);
  w.mailFail = false;
  at(w, '10:30:00'); // バックオフ経過後・終了前
  rejectIssue(w);
  rt.syncCycle();
  return w;
}

test('再送直前の再評価: 不達の間に予約が取消されたら、回復後も古い緊急通知を送らない', function () {
  var w = pendingAlertThenChange(function (x) { x.records = [H.record({ status: 'CANCELLED', revision: 2 })]; });
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED').length, 0);
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('IALERT_KEY_NOT_ISSUED_SOON') === 0; }).length, 0, '破棄される');
});

test('再送直前の再評価: 不達の間にrevisionが変わったら古いrevisionの通知は送らない（新しいrevisionの未発行は検知側が通知する）', function () {
  var w = pendingAlertThenChange(function (x) { x.records = [H.record({ revision: 2 })]; });
  var stale = w.mails.filter(function (m) { return m.subject.indexOf('KEY_NOT_ISSUED_SOON') !== -1 && /revision: 1/.test(m.body); });
  assert.strictEqual(stale.length, 0);
});

test('再送直前の再評価: 不達の間に台帳から予約が消えたら送らない', function () {
  var w = pendingAlertThenChange(function (x) { x.records = []; });
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED').length, 0);
});

test('再送直前の再評価: 台帳を読めない場合は、台帳を使わない判定だけで残し、必要な緊急通知を取りこぼさない', function () {
  var w = world(); var rt = w.runtime();
  w.records = [H.record()];
  at(w, '09:56:00');
  w.mailFail = true;
  rt.infraAlert('KEY_NOT_ISSUED_SOON', 'SNB-1', 1, null, 300, Math.floor(Date.parse(DAY + 'T12:00:00+09:00') / 1000));
  w.mailFail = false;
  w.ledgerFail = 'LEDGER_READ_FAILED';
  at(w, '10:30:00');
  rt.flushOutbox ? rt.flushOutbox() : rt.watchdog();
  assert.strictEqual(alerts(w, 'KEY_NOT_ISSUED_SOON').length, 1, '台帳不明でも終了前・未確認なら送る');
});
