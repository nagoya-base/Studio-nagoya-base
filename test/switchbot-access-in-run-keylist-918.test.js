/*
 * Issue #918: commandId なし鍵の同期内 keyList 高速確認（待機ループ開始から +10/+25/+45秒に最大3回・listDevices は1回/回）のモックテスト。
 * 実API・実機・実Spreadsheet・実メールには接続しない。暗証番号・メール・完全deviceIdはすべてダミー。
 * 時間は仮想時計（sleep は仮想時計を進めるだけ）。SwitchBot の反映時間は「発行後 N 秒たつまで keyList に載せない」で再現する。
 * 実際の反映時間分布は未計測。ここでの +10/+25/+45 は仕様の境界を確かめるためのもので、効果を保証するものではない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var H = require('./helpers/switchbot-access-world');
var Core = H.Core, S = Core.STATE;

var START = H.jst('2030-01-11', '10:00').getTime();

function setNow(w, minutesBeforeStart) { w.nowMs = START - minutesBeforeStart * 60000; }
function ops(w) {
  return w.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store.get(k)); })
    .sort(function (a, b) { return String(a.bookingId).localeCompare(String(b.bookingId)); });
}
function theOp(w) { var l = ops(w); assert.strictEqual(l.length, 1, 'OPは1件'); return l[0]; }
function opOf(w, bookingId) { var l = ops(w).filter(function (o) { return o.bookingId === bookingId; }); assert.strictEqual(l.length, 1); return l[0]; }
function createCalls(w) { return w.callCount('createKey'); }
function listCalls(w) { return w.callCount('listDevices'); }
function totalSleepSec(w) { return w.sleeps.reduce(function (a, b) { return a + b; }, 0) / 1000; }
function confirmBasis(op) {
  var h = (op.history || []).filter(function (e) { return e.to === S.ISSUED_CONFIRMED; });
  return h.length ? h[0].basis : undefined;
}

/**
 * commandId なしの発行。delaySec: 発行（createKey）後この秒数がたつまで keyList に載せない（未指定=すぐ載る）。
 * delayOf(name) を渡せば鍵ごとに変えられる。tickCalls: 各待機の直後に行われた listDevices 回数（= 各回の追加読取）を記録する。
 */
function world(o) {
  o = o || {};
  var cfg = Object.assign({ infra: Object.assign({ priorityRetryLeadSec: 3600, inRunConfirmMaxSec: 45 }, o.infra || {}) },
    o.mail ? { deliveryConfigured: true, delivery: H.DELIVERY_CFG } : {}, o.cfg || {});
  var w = H.createWorld({ sleep: o.sleep !== false, mail: !!o.mail, cfg: cfg });
  w.records = o.records || [H.record()];
  setNow(w, o.minutesBefore === undefined ? 45 : o.minutesBefore);
  w.createMode = o.createMode || 'noCommandId';
  w.visibleAt = {};
  var origCreate = w.api.createKey, origList = w.api.listDevices;
  w.api.createKey = function (p) {
    var r = origCreate(p);
    var d = typeof o.delayOf === 'function' ? o.delayOf(p.name, w) : o.delaySec;
    if (typeof d === 'number') w.visibleAt[p.name] = w.nowMs + d * 1000;
    return r;
  };
  w.api.listDevices = function () {
    var r = origList();
    if (w.listOverride) return w.listOverride(r);
    r.devices.forEach(function (d) { d.keyList = d.keyList.filter(function (k) { return !(w.visibleAt[k.name] > w.nowMs); }); });
    return r;
  };
  w.listAtSleep = [];
  w.sleepHook = function (n) { w.listAtSleep.push(listCalls(w)); if (o.onSleep) o.onSleep(n, w); };
  return w;
}
/** 各回（待機の直後）に行われた listDevices の回数。最後の待機の直後〜実行終了までの分は finalCount で渡す。 */
function perTickLists(w, finalCount) {
  var out = [];
  for (var i = 0; i < w.listAtSleep.length; i++) out.push((i + 1 < w.listAtSleep.length ? w.listAtSleep[i + 1] : finalCount) - w.listAtSleep[i]);
  return out;
}

/** 同じ条件で高速確認を使わない（inRunConfirmMaxSec=0）ときの、1回の同期での listDevices 回数。追加読取が無いことの比較基準。 */
function baselineLists(extraCfg) {
  var w = world({ delaySec: 10, infra: { inRunConfirmMaxSec: 0 }, cfg: extraCfg });
  w.runtime().syncCycle();
  return listCalls(w);
}

// ================================================================ 高速確認の基本（+10/+25/+45）

[
  { name: '+10秒で反映', delay: 10, basis: 'IN_RUN_T1', ticks: 1, sleeps: [10000] },
  { name: '+25秒で反映', delay: 25, basis: 'IN_RUN_T2', ticks: 2, sleeps: [10000, 15000] },
  { name: '+45秒ちょうどで反映', delay: 45, basis: 'IN_RUN_T3', ticks: 3, sleeps: [10000, 15000, 20000] }
].forEach(function (c) {
  test('高速確認: ' + c.name + ' → 該当ティックでのみ確定（basis=' + c.basis + '）。API追加は ' + c.ticks + ' 回、createKeyは1回、通常readsは不変', function () {
    var w = world({ delaySec: c.delay });
    var rt = w.runtime();
    var r = rt.syncCycle();
    var op = theOp(w);
    assert.strictEqual(createCalls(w), 1, 'createKeyは1回');
    assert.strictEqual(op.state, S.ISSUED_CONFIRMED);
    assert.strictEqual(confirmBasis(op), c.basis);
    assert.ok(op.evidence.indexOf(Core.EVIDENCE.KEYLIST_CONFIRMED) !== -1, '証拠はkeyList');
    assert.strictEqual(op.evidence.indexOf(Core.EVIDENCE.WEBHOOK_SUCCESS), -1);
    assert.strictEqual(op.reads, 1, '通常読取は発行直後の1回のまま（高速確認はreadsを増やさない）');
    assert.strictEqual(op.commandId, '');
    assert.strictEqual(r.inRun.fast.confirmed, 1);
    assert.strictEqual(r.inRun.fast.ticks, c.ticks);
    assert.deepStrictEqual(w.sleeps, c.sleeps, '待機は各ティックの時刻まで（+10/+25/+45）。ポーリングで余計に読まない');
    assert.ok(totalSleepSec(w) <= 45);
    assert.deepStrictEqual(perTickLists(w, listCalls(w)), c.sleeps.map(function () { return 1; }), 'listDevicesは各ティック1回');
  });
});

test('高速確認: 45秒を超えて反映（+46/+90秒）なら高速では確認せず、読取は3回まで。未確認のまま従来の次周期へ（UNKNOWN/FAILEDにしない・createKey再送なし）', function () {
  var w = world({ delaySec: 46 });
  var rt = w.runtime();
  var r = rt.syncCycle();
  var op = theOp(w);
  assert.strictEqual(op.state, S.ACCEPTED_NO_COMMAND_ID);
  assert.strictEqual(op.reads, 1, '通常readsは不変');
  assert.strictEqual(r.inRun.fast.ticks, 3);
  assert.strictEqual(r.inRun.fast.confirmed, 0);
  assert.strictEqual(r.inRun.fast.unconfirmed, 1);
  assert.deepStrictEqual(w.sleeps, [10000, 15000, 20000]);
  assert.ok(totalSleepSec(w) <= 45, '待機は最大45秒/run');
  assert.deepStrictEqual(perTickLists(w, listCalls(w)), [1, 1, 1], '追加APIは最大3回/run');
  assert.strictEqual(createCalls(w), 1);
  assert.strictEqual(w.mails.filter(function (m) { return /UNKNOWN|FAILED|CONFIRM/.test(m.subject); }).length, 0, '管理者通知なし');
  // 従来の次周期（5分後）の通常読取#2で確認できる（高速確認の基準は付かない）
  w.advance(300);
  var r2 = rt.syncCycle();
  var op2 = theOp(w);
  assert.strictEqual(op2.state, S.ISSUED_CONFIRMED);
  assert.strictEqual(op2.reads, 2, '従来の読取#2で確認');
  assert.strictEqual(confirmBasis(op2), null, '周期確定は basis なし');
  assert.strictEqual(createCalls(w), 1, '二重にcreateKeyしない');
  assert.ok(!r2.inRun || !r2.inRun.fast, '過去runのOPは高速確認の対象外');
});

test('高速確認: 発行直後の通常読取で見えれば、待機も追加読取もしない（従来動作）', function () {
  var w = world({ delaySec: 0 });
  var r = w.runtime().syncCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(confirmBasis(theOp(w)), null);
  assert.strictEqual(w.sleeps.length, 0);
  assert.ok(!r.inRun || !r.inRun.fast);
});

test('高速確認: 見つかった時点で後続ティックは行わない（+10で確定→+25/+45は読まない）', function () {
  var w = world({ delaySec: 10 });
  w.runtime().syncCycle();
  assert.strictEqual(w.sleeps.length, 1);
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.deepStrictEqual(perTickLists(w, listCalls(w)), [1]);
});

// ================================================================ 設定

test('設定: inRunConfirmMaxSec=0 は完全無効（従来動作）。待機も追加読取もなく、同期結果にinRunも出ない', function () {
  var w = world({ delaySec: 10, infra: { inRunConfirmMaxSec: 0 } });
  var r = w.runtime().syncCycle();
  assert.strictEqual(w.sleeps.length, 0);
  assert.strictEqual(r.inRun, undefined);
  assert.strictEqual(theOp(w).state, S.ACCEPTED_NO_COMMAND_ID);
  assert.strictEqual(theOp(w).reads, 1);
  // 追加の読取はない（高速確認の機能を持たない従来と同じ回数。基準はテスト内で計測）
  assert.strictEqual(listCalls(w), baselineLists());
});

test('設定: inRunConfirmMaxSec=30 なら +10/+25 の2回だけ（+45は行わない）。60でも固定の +10/+25/+45 の3回まで', function () {
  var w30 = world({ delaySec: 40, infra: { inRunConfirmMaxSec: 30 } });
  var r30 = w30.runtime().syncCycle();
  assert.deepStrictEqual(w30.sleeps, [10000, 15000]);
  assert.strictEqual(r30.inRun.fast.ticks, 2);
  assert.strictEqual(theOp(w30).state, S.ACCEPTED_NO_COMMAND_ID);
  var w60 = world({ delaySec: 200, infra: { inRunConfirmMaxSec: 60 } });
  var r60 = w60.runtime().syncCycle();
  assert.deepStrictEqual(w60.sleeps, [10000, 15000, 20000], '最大3回');
  assert.strictEqual(r60.inRun.fast.ticks, 3);
  var w9 = world({ delaySec: 5, infra: { inRunConfirmMaxSec: 9 } });
  var r9 = w9.runtime().syncCycle();
  assert.strictEqual(w9.sleeps.length, 0, '最初の回(+10)より短い設定では待たない');
  assert.strictEqual(theOp(w9).state, S.ACCEPTED_NO_COMMAND_ID);
  assert.strictEqual(r9.inRun.fast.ticks, 0);
});

test('設定: ACCESS_ENABLED=OFF は発行も待機も追加読取もしない', function () {
  var w = world({ delaySec: 10, cfg: { enabled: false } });
  var r = w.runtime().syncCycle();
  assert.strictEqual(createCalls(w), 0);
  assert.strictEqual(w.sleeps.length, 0);
  assert.strictEqual(listCalls(w), 0);
  assert.strictEqual(r.skipped, 'FLAG_OFF');
});

// ================================================================ 複数鍵の同時確認

test('複数鍵: 同一run内の2予約でも listDevices は1回/ティック。共通45秒期限で逐次45秒待たない。鍵ごとの確定ティックが反映順に付く', function () {
  var w = world({
    records: [H.record({ bookingId: 'SNB-1' }), H.record({ bookingId: 'SNB-2' })],
    delayOf: function (name, ww) { return Object.keys(ww.visibleAt).length === 0 ? 10 : 25; } // 1件目 +10、2件目 +25
  });
  w.recipients['SNB-2'] = 'guest2@example.test';
  var rt = w.runtime();
  var r = rt.syncCycle();
  assert.strictEqual(createCalls(w), 2);
  var a = opOf(w, 'SNB-1'), b = opOf(w, 'SNB-2');
  assert.strictEqual(a.state, S.ISSUED_CONFIRMED);
  assert.strictEqual(b.state, S.ISSUED_CONFIRMED);
  assert.strictEqual(confirmBasis(a), 'IN_RUN_T1');
  assert.strictEqual(confirmBasis(b), 'IN_RUN_T2');
  assert.strictEqual(a.reads, 1);
  assert.strictEqual(b.reads, 1);
  assert.deepStrictEqual(w.sleeps, [10000, 15000], '待機は共通の期限内。鍵ごとに逐次待たない');
  assert.deepStrictEqual(perTickLists(w, listCalls(w)), [1, 1], 'ティックごとにlistDevicesは1回（鍵の数に比例しない）');
  assert.strictEqual(r.inRun.fast.targets, 2);
  assert.strictEqual(r.inRun.fast.confirmed, 2);
});

test('複数鍵: 3予約が全部45秒まで未確認でも、追加のlistDevicesは3回/runで、待機は合計45秒以内', function () {
  var w = world({
    records: [H.record({ bookingId: 'SNB-1' }), H.record({ bookingId: 'SNB-2' }), H.record({ bookingId: 'SNB-3' })],
    delaySec: 300
  });
  var r = w.runtime().syncCycle();
  assert.strictEqual(createCalls(w), 3);
  assert.deepStrictEqual(perTickLists(w, listCalls(w)), [1, 1, 1]);
  assert.ok(totalSleepSec(w) <= 45);
  assert.strictEqual(r.inRun.fast.unconfirmed, 3);
  ops(w).forEach(function (o) { assert.strictEqual(o.state, S.ACCEPTED_NO_COMMAND_ID); assert.strictEqual(o.reads, 1); });
});

test('対象: 過去のrunのOP・UNKNOWN・FAILED・削除は対象外。今回送信した発行OPだけが確定する', function () {
  var w = world({ delaySec: 10 });
  var rt = w.runtime();
  // 過去のrunで発行されたOP（反映は遠い将来）。今回のrunの途中で見えるようになっても、高速確認の対象にしない
  w.records = [H.record({ bookingId: 'SNB-OLD' })];
  w.recipients['SNB-OLD'] = 'old@example.test';
  w.visibleAt = {};
  var origCreate = w.api.createKey;
  w.api.createKey = function (p) { var r = origCreate(p); w.visibleAt[p.name] = w.nowMs + 9999 * 1000; return r; };
  rt.syncCycle();
  var old = opOf(w, 'SNB-OLD');
  assert.strictEqual(old.state, S.ACCEPTED_NO_COMMAND_ID);
  // 次の周期: 新しい予約を追加。旧OPの鍵がこのrunの+10秒に見えるようになる
  w.advance(300);
  w.records = [H.record({ bookingId: 'SNB-OLD' }), H.record({ bookingId: 'SNB-NEW' })];
  w.recipients['SNB-NEW'] = 'new@example.test';
  var runStart = w.nowMs;
  w.api.createKey = function (p) {
    var r = origCreate(p);
    w.visibleAt[p.name] = w.nowMs + 10 * 1000;
    Object.keys(w.visibleAt).forEach(function (n) { if (n === old.name) w.visibleAt[n] = runStart + 10 * 1000; });
    return r;
  };
  var r = rt.syncCycle();
  assert.strictEqual(opOf(w, 'SNB-NEW').state, S.ISSUED_CONFIRMED);
  assert.strictEqual(confirmBasis(opOf(w, 'SNB-NEW')), 'IN_RUN_T1');
  assert.strictEqual(r.inRun.fast.targets, 1, '対象は今回送信した1件だけ');
  var oldAfter = opOf(w, 'SNB-OLD');
  assert.notStrictEqual(confirmBasis(oldAfter), 'IN_RUN_T1', '過去runのOPは高速確認で確定しない');
  assert.strictEqual(createCalls(w), 2, '各予約1回ずつ');
});

test('対象: createKeyの応答が不明（5xx）→UNKNOWN の鍵は対象外。待機も追加読取もせず、再送しない', function () {
  var w = world({ delaySec: 10 });
  w.api.createKey = function (p) { w.calls.push({ name: 'createKey', device: p.deviceId }); return { httpCode: 500, parsed: null }; };
  var r = w.runtime().syncCycle();
  assert.strictEqual(theOp(w).state, S.UNKNOWN);
  assert.strictEqual(w.sleeps.length, 0);
  assert.ok(!r.inRun || !r.inRun.fast);
  w.advance(300);
  w.runtime().syncCycle();
  assert.strictEqual(createCalls(w), 1, 'UNKNOWNへ再送しない');
});

test('対象: commandId ありの鍵（Webhook経路）には高速keyList確認を使わない。従来どおりWebhook到着で確認し、keyListだけでは確定しない', function () {
  var w = world({ createMode: 'commandId', delaySec: 0 });
  var rt = w.runtime();
  var r = rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.SENT_WAIT_WEBHOOK, 'keyListに見えていても、Webhookが無ければ確定しない（従来どおり）');
  assert.ok(!r.inRun.fast);
  assert.strictEqual(theOp(w).reads, 0);
  assert.ok(w.sleeps.every(function (ms) { return ms === 3000; }), '従来のポーリング間隔のまま');
});

test('共存: commandId あり（Webhook）と なし（高速keyList）が同じrunにあっても、共通45秒内で両方確認できる', function () {
  // Webhook ありの鍵は発行直後から keyList に載る（Webhook成功でkeyListに無ければ矛盾でUNKNOWNになる従来仕様）。commandId なしの鍵は +10秒で載る
  var w = world({ records: [H.record({ bookingId: 'SNB-1' }), H.record({ bookingId: 'SNB-2' })],
    delayOf: function (name, ww) { return ww.createMode === 'commandId' ? 0 : 10; } });
  w.recipients['SNB-2'] = 'g2@example.test';
  var n = 0;
  var origCreate = w.api.createKey;
  w.api.createKey = function (p) { n++; w.createMode = n === 1 ? 'commandId' : 'noCommandId'; return origCreate(p); };
  var other = w.runtime();
  w.sleepHook = function (k) {
    if (k !== 1) return;
    var withCmd = ops(w).filter(function (o) { return o.commandId; })[0];
    other.handleWebhook(H.webhook({ commandId: withCmd.commandId, deviceMac: H.DEV }), H.TOKEN, H.TOKEN);
  };
  var r = w.runtime().syncCycle();
  assert.strictEqual(createCalls(w), 2);
  ops(w).forEach(function (o) { assert.strictEqual(o.state, S.ISSUED_CONFIRMED); });
  var fast = ops(w).filter(function (o) { return !o.commandId; })[0];
  var hook = ops(w).filter(function (o) { return o.commandId; })[0];
  assert.strictEqual(confirmBasis(fast), 'IN_RUN_T1');
  assert.strictEqual(confirmBasis(hook), null, 'Webhook経路は従来のまま');
  assert.ok(hook.evidence.indexOf(Core.EVIDENCE.WEBHOOK_SUCCESS) !== -1);
  assert.ok(totalSleepSec(w) <= 45);
  assert.strictEqual(r.inRun.confirmed, 2);
});

// ================================================================ 異常系: 誤確定・早期UNKNOWN・二重送信がない

function assertSafeFallback(w, extra) {
  var op = theOp(w);
  assert.strictEqual(op.state, S.ACCEPTED_NO_COMMAND_ID, '成功扱い・UNKNOWN・FAILEDにしない');
  assert.strictEqual(op.reads, 1, '通常readsは不変');
  assert.strictEqual(createCalls(w), 1, '二重createKeyなし');
  assert.strictEqual(w.userMails.length, 0, 'メール送信なし');
  assert.ok(!w.props['DLV_' + op.id], '配送記録なし');
  if (extra) extra(op);
}

test('異常: listDevices が例外（タイムアウト）→ 誤確定なし・UNKNOWNなし。次周期の通常読取へ', function () {
  var w = world({ delaySec: 10, mail: true, infra: { inRunDeliver: true } });
  var origList = w.api.listDevices;
  var failing = false;
  w.sleepHook = function (n) { w.listAtSleep.push(listCalls(w)); failing = true; };
  w.api.listDevices = function () { if (failing) { w.calls.push({ name: 'listDevices' }); throw new Error('TIMEOUT'); } return origList(); };
  var r = w.runtime().syncCycle();
  assertSafeFallback(w);
  assert.strictEqual(r.inRun.fast.skipped, 'LIST_FAILED');
  assert.strictEqual(r.inRun.fast.ticks, 3, '失敗しても最大3回まで（連打しない）');
  // 復旧後の次周期で通常確認
  failing = false;
  w.advance(300);
  w.runtime().syncCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(theOp(w).reads, 2);
  assert.strictEqual(createCalls(w), 1);
});

test('異常: listDevices が ok:false／不正応答（devicesが配列でない・null）→ 誤確定なし', function () {
  [{ ok: false, error: 'DOWN' }, { ok: true, devices: 'garbage' }, { ok: true }, null, undefined].forEach(function (bad) {
    var w = world({ delaySec: 10, mail: true, infra: { inRunDeliver: true } });
    var origList = w.api.listDevices;
    var broken = false;
    w.sleepHook = function () { w.listAtSleep.push(listCalls(w)); broken = true; };
    w.api.listDevices = function () { if (broken) { w.calls.push({ name: 'listDevices' }); return bad; } return origList(); };
    w.runtime().syncCycle();
    assertSafeFallback(w);
  });
});

test('異常: 対象端末が応答に無い／keyListが欠落（DEVICE_NOT_FOUND・KEYLIST_INVALID）→ 誤確定なし。通常経路へ', function () {
  [
    function (r) { return { ok: true, devices: [] }; },
    function (r) { return { ok: true, devices: r.devices.map(function (d) { return { deviceId: d.deviceId }; }) }; }
  ].forEach(function (mk) {
    var w = world({ delaySec: 10 });
    var origList = w.api.listDevices;
    var broken = false;
    w.sleepHook = function () { w.listAtSleep.push(listCalls(w)); broken = true; };
    w.api.listDevices = function () { var r = origList(); if (!broken) return r; w.calls.push({ name: 'listDevices' }); return mk(r); };
    w.runtime().syncCycle();
    assertSafeFallback(w);
  });
});

test('異常: keyListの重複・ID欠損・属性矛盾（期間違い・種別違い）は成功扱いにしない。高速経路ではUNKNOWNにもせず、次周期の通常読取が従来どおり停止させる', function () {
  var mutate = {
    '重複': function (list, name) { var k = list.filter(function (x) { return x.name === name; })[0]; list.push(Object.assign({}, k, { id: 'DUP' })); return list; },
    'ID欠損': function (list, name) { return list.map(function (x) { if (x.name === name) { var y = Object.assign({}, x); delete y.id; return y; } return x; }); },
    '終了時刻の矛盾': function (list, name) { return list.map(function (x) { return x.name === name ? Object.assign({}, x, { endTime: '1' }) : x; }); },
    '種別の矛盾': function (list, name) { return list.map(function (x) { return x.name === name ? Object.assign({}, x, { type: 'permanent' }) : x; }); }
  };
  Object.keys(mutate).forEach(function (label) {
    var w = world({ delaySec: 10, mail: true, infra: { inRunDeliver: true } });
    var origList = w.api.listDevices;
    var odd = false;
    w.sleepHook = function () { w.listAtSleep.push(listCalls(w)); odd = true; };
    w.api.listDevices = function () {
      var r = origList();
      if (!odd) return r;
      r.devices.forEach(function (d) { if (d.deviceId === H.DEV) d.keyList = mutate[label](d.keyList, theOp(w).name); });
      return r;
    };
    var res = w.runtime().syncCycle();
    assertSafeFallback(w);
    assert.strictEqual(res.inRun.fast.confirmed, 0, label);
    // 次周期の通常読取（高速経路ではなく従来の異常判定）が、従来どおり停止させる
    odd = true;
    w.advance(300);
    w.runtime().syncCycle();
    assert.strictEqual(theOp(w).state, S.UNKNOWN, label + ': 従来の通常経路の異常停止が維持される');
    assert.strictEqual(createCalls(w), 1, label + ': 再送しない');
    assert.strictEqual(w.userMails.length, 0, label + ': 未確認PINは送らない');
  });
});

test('異常: 日次API予算の残りが少ないとき（80%超使用）は高速確認を行わない（既存の通常業務へ予算を残す）。通常の同期は継続', function () {
  var w = world({ delaySec: 10 });
  var dayKey = 'APICOUNT_' + new Date((w.sec() + 9 * 3600) * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  w.props[dayKey] = '6600'; // 8000の82.5%
  var r = w.runtime().syncCycle();
  assert.strictEqual(createCalls(w), 1, '通常の発行は予算内なので従来どおり');
  assert.strictEqual(w.sleeps.length, 0, '実施できない回のためにロックを保持して待たない');
  assert.strictEqual(r.inRun.fast.skipped, 'API_BUDGET_LOW');
  assert.strictEqual(r.inRun.fast.ticks, 0, '追加のAPI呼出なし');
  assertSafeFallback(w);
  assert.strictEqual(listCalls(w), baselineLists(), '従来と同じ回数（追加読取なし）');
});

test('異常: 日次API予算が枯渇していれば、そもそも同期を実行しない（従来どおり）。高速確認も動かない', function () {
  var w = world({ delaySec: 10 });
  var dayKey = 'APICOUNT_' + new Date((w.sec() + 9 * 3600) * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  w.props[dayKey] = '8000';
  var r = w.runtime().syncCycle();
  assert.strictEqual(r.error, 'API_BUDGET_EXHAUSTED');
  assert.strictEqual(createCalls(w), 0);
  assert.strictEqual(w.sleeps.length, 0);
});

test('異常: 実行時間の残り（runBudgetSec）が足りない回は読まずに見送る。足りる回だけ実施し、予定時刻が期限を超える回は予定しない', function () {
  // runBudgetSec=30: 期限は+30秒。+45の回は予定されない。+25の回は残り5秒しかなく（必要15秒）見送る。+10の回は実施
  var w = world({ delaySec: 28, infra: { runBudgetSec: 30 } });
  var r = w.runtime().syncCycle();
  assert.strictEqual(r.inRun.fast.ticks, 1, '+10の1回だけ実施');
  assert.strictEqual(r.inRun.fast.skipped, 'TIME_BUDGET');
  assert.deepStrictEqual(w.sleeps, [10000], '実施できない+25の回のためには待たない');
  assertSafeFallback(w);
  // 期限が極端に短い場合は、1回も読まない
  var w2 = world({ delaySec: 10, infra: { runBudgetSec: 20 } });
  var r2 = w2.runtime().syncCycle();
  assert.strictEqual(r2.inRun.fast.ticks, 0);
  assert.strictEqual(theOp(w2).state, S.ACCEPTED_NO_COMMAND_ID);
});

test('異常: sleep が注入されていない実行基盤では待機も追加読取もしない（SLEEP_UNAVAILABLE）。従来の次周期へ', function () {
  var w = world({ delaySec: 10, sleep: false });
  var r = w.runtime().syncCycle();
  assert.strictEqual(r.inRun.waitSkipped, 'SLEEP_UNAVAILABLE');
  assertSafeFallback(w);
  assert.strictEqual(listCalls(w), baselineLists(), '追加読取なし');
});

test('異常: sleep が例外を投げても、高速確認を打ち切って従来の次周期へ（同期は失敗にしない）', function () {
  var w = world({ delaySec: 10 });
  var d = w.deps();
  d.sleep = function () { throw new Error('SLEEP_BROKEN'); };
  var r = H.Infra.createRuntime(d, w.cfg).syncCycle();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.inRun.waitSkipped, 'SLEEP_FAILED');
  assertSafeFallback(w);
});

test('異常: 確定の保存に失敗（状態ストア障害）→ SYNC_ERROR を通知（隠さない）。鍵は未確認のまま、次周期の通常読取で確認。二重送信なし', function () {
  var w = world({ delaySec: 10, mail: true, infra: { inRunDeliver: true } });
  w.storeFail = function (k, v) { return k.indexOf('OP_') === 0 && /ISSUED_CONFIRMED/.test(v); };
  w.runtime().syncCycle();
  assert.strictEqual(createCalls(w), 1);
  assert.ok(w.mails.some(function (m) { return /SYNC_ERROR/.test(m.subject); }), '状態保存の失敗は通知する');
  assert.strictEqual(w.userMails.length, 0, '確定を保存できなかった鍵のPINは送らない');
  assert.strictEqual(JSON.parse(w.store.get(Object.keys(w.props).filter(function (k) { return k.indexOf('OP_') === 0; })[0])).state, S.ACCEPTED_NO_COMMAND_ID);
  w.storeFail = null;
  w.advance(300);
  w.runtime().syncCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(createCalls(w), 1);
  assert.strictEqual(w.userMails.length, 1, '次周期で確認後に1通だけ');
});

test('ロック: 待機中の別ジョブ（配送・清掃）はロックを取れず何も実行しない。同期は高速確認を完了する', function () {
  var w = world({ delaySec: 25, mail: true, infra: { inRunDeliver: true } });
  var other = w.runtime();
  var seen = [];
  w.sleepHook = function () {
    w.listAtSleep.push(listCalls(w));
    seen.push(other.deliverCycle().error, other.sweepCycle().error);
  };
  var r = w.runtime().syncCycle();
  assert.ok(seen.length >= 2);
  seen.forEach(function (e) { assert.strictEqual(e, 'LOCK_UNAVAILABLE'); });
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(r.inRun.fast.confirmed, 1);
  assert.strictEqual(createCalls(w), 1);
});

test('ロック: 待機中のWebhook受信（別の実行）はINBOXへ退避され、取込まれる。高速確認と干渉しない', function () {
  var w = world({ delaySec: 10 });
  var other = w.runtime();
  var queued = [];
  w.sleepHook = function (n) {
    w.listAtSleep.push(listCalls(w));
    if (n === 1) queued.push(other.handleWebhook(H.webhook({ commandId: 'ZZZ-UNRELATED', deviceMac: H.DEV }), H.TOKEN, H.TOKEN).queued);
  };
  w.runtime().syncCycle();
  assert.deepStrictEqual(queued, [true]);
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
});

// ================================================================ 配送

test('配送: 高速確認で今回確定した鍵だけ、既存の同期内配送（inRunDeliver）で1通だけ送る。次周期の配送ジョブで二重送信しない', function () {
  var w = world({ delaySec: 25, mail: true, infra: { inRunDeliver: true } });
  var rt = w.runtime();
  var r = rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(confirmBasis(theOp(w)), 'IN_RUN_T2');
  assert.strictEqual(r.inRun.delivered, 1);
  assert.strictEqual(w.userMails.length, 1);
  assert.ok(w.ledgerCalls >= 2, '送信直前に台帳を再読込する');
  w.advance(300);
  rt.deliverCycle();
  rt.syncCycle();
  assert.strictEqual(w.userMails.length, 1, '二重送信しない');
  assert.strictEqual(createCalls(w), 1);
});

test('配送: 未確認の鍵のPINは送らない（+45秒を超えて反映）。確認後は次周期以降に1通だけ', function () {
  var w = world({ delaySec: 60, mail: true, infra: { inRunDeliver: true } });
  var rt = w.runtime();
  rt.syncCycle();
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(theOp(w).state, S.ACCEPTED_NO_COMMAND_ID);
  w.advance(300);
  rt.syncCycle();
  rt.deliverCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(w.userMails.length, 1);
});

test('配送: 高速確認の後でも既存ゲートを通す。待機中に予約が取り消されたら送らない（台帳再読込・取消チェック）', function () {
  var w = world({ delaySec: 25, mail: true, infra: { inRunDeliver: true }, onSleep: function (n, ww) { ww.records = [H.record({ status: 'CANCELLED', revision: 2 })]; } });
  w.runtime().syncCycle();
  assert.strictEqual(w.userMails.length, 0, '取消後はPINを送らない');
});

test('配送: inRunDeliver=false なら高速確認はするが同期内配送はしない（配送ジョブの責務のまま）。ゲート未開放（前日18:00前）も従来どおり送らない', function () {
  var w = world({ delaySec: 10, mail: true, infra: { inRunDeliver: false } });
  var rt = w.runtime();
  var r = rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(r.inRun.delivered, 0);
  rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 1, '従来の配送ジョブが送る');
  // ゲート前: 利用日の前々日（前日18:00より前）に確認できても送らない
  var g = world({ delaySec: 10, mail: true, infra: { inRunDeliver: true }, minutesBefore: 60 * 40 });
  g.runtime().syncCycle();
  assert.strictEqual(g.userMails.length, 0, '配送ゲート前は送らない');
});

// ================================================================ 回帰: 通常読取カウント・削除

test('回帰: 高速確認の有無で、未確認キーの通常読取の進み方（#2・#3・READ_LIMIT）が変わらない。高速失敗で早期READ_LIMITにならない', function () {
  function trail(maxSec) {
    var w = world({ delaySec: 100000, infra: { inRunConfirmMaxSec: maxSec } });
    var rt = w.runtime();
    var out = [];
    for (var i = 0; i < 4; i++) {
      rt.syncCycle();
      var o = theOp(w);
      out.push(o.state + ':' + o.reads);
      w.advance(300);
    }
    return { out: out, creates: createCalls(w) };
  }
  var base = trail(0), fast = trail(45);
  assert.deepStrictEqual(fast.out, base.out, '状態とreadsの推移は完全に同じ');
  assert.strictEqual(fast.creates, 1);
  assert.strictEqual(base.out[2].split(':')[0], 'UNKNOWN', '従来は3回目の読取でREAD_LIMIT');
});

test('回帰: commandId なし削除（取消）の確認は高速確認の影響を受けない（読取回数・状態の推移が同じ）', function () {
  function run(maxSec) {
    var w = world({ delaySec: 0, infra: { inRunConfirmMaxSec: maxSec } });
    w.deleteMode = 'noCommandId';
    var rt = w.runtime();
    rt.syncCycle(); // 発行（直後の通常読取で確認）
    w.advance(300);
    w.records = [H.record({ status: 'CANCELLED', revision: 2 })];
    var trail = [];
    for (var i = 0; i < 4; i++) {
      rt.syncCycle();
      var o = ops(w)[0];
      trail.push([o.state, o.reads, w.callCount('deleteKey')].join(':'));
      w.advance(300);
    }
    return { trail: trail, sleeps: w.sleeps.length, list: listCalls(w) };
  }
  var base = run(0), fast = run(45);
  assert.deepStrictEqual(fast.trail, base.trail);
  assert.strictEqual(fast.sleeps, 0, '削除には待機も追加読取もない');
  assert.strictEqual(fast.list, base.list);
});

test('回帰: commandId ありの既存Webhook経路は従来どおり。keyListの追加読取（高速確認）は行わない', function () {
  var w = world({ createMode: 'commandId' });
  var rt = w.runtime(), other = w.runtime();
  w.sleepHook = function (n) {
    w.listAtSleep.push(listCalls(w));
    if (n === 2) other.handleWebhook(H.webhook({ commandId: theOp(w).commandId, deviceMac: H.DEV }), H.TOKEN, H.TOKEN);
  };
  var r = rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(confirmBasis(theOp(w)), null);
  assert.strictEqual(r.inRun.confirmed, 1);
  assert.ok(!r.inRun.fast);
  assert.strictEqual(w.sleeps.length, 2);
  assert.strictEqual(theOp(w).reads, 1);
});

// ================================================================ 診断（最小証跡）

test('診断: 高速確定と周期確定が basis・evidence で判別できる。出力は固定列挙と件数だけ（recId・commandId・deviceId・PIN・絶対時刻を含まない）', function () {
  function timeline(w) {
    return H.Infra.timelineReport({
      store: { get: function (k) { return w.store.get(k); } },
      ledger: w.ledger, snapshot: H.LOADED.snapshot, nowMs: function () { return w.nowMs; },
      gateHours: 6, isCard: function (m) { return /クレジット/.test(String(m)); }
    });
  }
  var fast = world({ delaySec: 25 });
  fast.runtime().syncCycle();
  var f = timeline(fast).rows[0];
  assert.strictEqual(f.basis, 'IN_RUN_T2');
  assert.deepStrictEqual(f.evidence, ['KEYLIST_CONFIRMED']);
  assert.strictEqual(f.hasCommandId, false);
  assert.strictEqual(f.reads, 1);

  var slow = world({ delaySec: 120 });
  var rt = slow.runtime();
  rt.syncCycle();
  var u = timeline(slow).rows[0];
  assert.strictEqual(u.basis, null, '未確認');
  slow.advance(300);
  rt.syncCycle();
  var p = timeline(slow).rows[0];
  assert.strictEqual(p.basis, 'PERIODIC');
  assert.strictEqual(p.reads, 2);
  assert.deepStrictEqual(p.evidence, ['KEYLIST_CONFIRMED']);

  var text = JSON.stringify([f, u, p]);
  var op = theOp(fast);
  [op.id, op.name, op.deviceId, H.DEV, String(op.passcodeId)].forEach(function (secret) {
    assert.ok(text.indexOf(secret) === -1, '秘匿値が出ていない');
  });
});

test('出力: 同期結果・通知・ログ・メールに、PIN・完全deviceId・商品の秘匿値が出ない', function () {
  var w = world({ delaySec: 25, mail: true, infra: { inRunDeliver: true } });
  var r = w.runtime().syncCycle();
  var blob = JSON.stringify(r) + JSON.stringify(w.mails) + JSON.stringify(w.logs);
  w.createdPasswords.forEach(function (pw) { assert.strictEqual(blob.indexOf(pw), -1, 'PINがログ・通知・結果に出ない'); });
  assert.strictEqual(blob.indexOf(H.DEV), -1, '完全なdeviceIdが出ない');
  assert.strictEqual(w.userMails.length, 1, 'PINは本人宛メールにだけ');
});
