/*
 * Issue #912（追加修正）: 通常の状態履歴は原則3日。取消・非対象の BK/TRK は台帳の読取範囲を外れた後に回収する。
 * 未解決・UNKNOWN・配送中・削除未確認は期限だけで消さない。APICOUNT・HB・設定・秘密は対象外。
 * 実API・実機には接続しない。予約ID・端末ID・宛先などの実データは使わない（すべてダミー）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');
var H = require('./helpers/switchbot-access-world');
var C = H.Core, Infra = H.Infra, S = C.STATE;

var DEV = 'AAAAAAAAAAAA37DD';
var HOUR = 3600, DAY = 86400;
var NOW = C.jstToEpochSec('2030-01-10', '13:00');
var NO_SECRETS = { keys: function () { return []; }, del: function () {} };

function mem(init) {
  var m = Object.assign({}, init || {});
  return {
    m: m,
    get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    set: function (k, v) { m[k] = String(v); },
    del: function (k) { delete m[k]; },
    keys: function () { return Object.keys(m); }
  };
}
function engineOf(store, now) {
  return C.createEngine({
    store: store, secrets: mem(),
    lock: function (keys, fn) { return fn(); },
    api: { listDevices: function () { throw new Error('NO_API_IN_THIS_TEST'); } },
    notifyAdmin: function () {}, deliverCode: function () {}, deliveryGate: function () { return { ok: true }; },
    sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); },
    randomInt: function (n) { return crypto.randomInt(n); },
    nowSec: function () { return now.v; }
  }, { enabled: true, commercialUseApproved: true, eligiblePaymentStatuses: ['paid'], eligibleBrands: ['studio'], graceBeforeSec: 600, graceAfterSec: 900,
       keypads: [{ brand: 'studio', facility: 'main', room: 'A', deviceId: DEV }] });
}
function gc(store, now, rep) { return Infra.garbageCollect(store, NO_SECRETS, now.v, H.baseCfg(), rep); }
function opRec(bk, rev, state, ageSec, over) {
  var id = bk + ':' + rev + ':****37DD:ISSUE#1';
  return Object.assign({ id: id, bookingId: bk, revision: rev, op: 'ISSUE', deviceId: DEV, name: 'SNB-' + bk, state: state, updatedAt: NOW - ageSec,
    commandId: 'C-' + bk + rev, deleteCommandId: 'D-' + bk + rev, endSec: NOW - 2 * DAY, startSec: NOW - 3 * DAY, evidence: [], history: [] }, over || {});
}
function put(store, bk, head, ops, touchedAgo, seenAgo) {
  var ids = (ops || []).map(function (o) {
    var r = opRec(bk, o.rev, o.state, o.ageSec, o.over);
    store.set('OP_' + r.id, JSON.stringify(r));
    if (o.dlv) store.set('DLV_' + r.id, JSON.stringify({ id: 'DLV_' + r.id, opId: r.id, bookingId: bk, state: o.dlv, attempts: 1, history: [] }));
    return r.id;
  });
  store.set('BK_' + bk, JSON.stringify({ bookingId: bk, head: head, ops: ids, touchedAt: NOW - touchedAgo }));
  store.set('TRK_' + bk, JSON.stringify({ revision: 1, seenAt: NOW - (seenAgo === undefined ? touchedAgo : seenAgo) }));
  return ids;
}
// 予約は利用日 D（JST）。読取範囲は「利用日が当日・翌日」なので、範囲を外れるのは D の翌日 0:00 JST。
var D = '2030-01-10';
var EXIT = C.jstToEpochSec(D, '00:00') + DAY;
function cancelledHead(withExit) { return { revision: 2, cancelled: true, desired: false, startSec: null, endSec: null, deviceId: null, endedSec: null, windowExitSec: withExit ? EXIT : null }; }
function nonTargetHead() { return { revision: 1, cancelled: false, desired: false, startSec: null, endSec: null, deviceId: null, endedSec: null, windowExitSec: EXIT }; }
function has(store, k) { return store.get(k) !== null; }

// ---------------------------------------------------------------- 既定値

test('既定の保持: BK/TRK/EVT/送達済みIALERT は3日。ADMINLOG は90日（理由はコード内コメント）。Core の終端OPも3日', function () {
  var r = Infra.DEFAULTS.retention;
  assert.strictEqual(C.DEFAULT_RETENTION_SEC, 3 * DAY);
  ['bkSec', 'evtSec', 'outboxSec', 'trackSec'].forEach(function (k) { assert.strictEqual(r[k], 3 * DAY, k); });
  assert.strictEqual(r.adminLogSec, 90 * DAY);
  assert.strictEqual(Infra.DEFAULTS.syncIntervalSec, 300, '周期は変えない');
});

// ---------------------------------------------------------------- 3日保持の境界

test('通常の BK/TRK/EVT/送達済みIALERT は、最終の確定・観測から3日を過ぎたら回収し、3日ちょうどまでは残す', function () {
  var st = mem(), now = { v: NOW };
  st.set('EVT_x_createKey_C1', JSON.stringify({ receivedAtSec: NOW - 3 * DAY }));
  st.set('IALERT_SENT_a', JSON.stringify({ event: { code: 'BOOKING_FROZEN' }, sentAt: NOW - 3 * DAY, attempts: 0 }));
  put(st, 'BK-A', cancelledHead(false), [], 3 * DAY); // 旧head（早期回収なし）。時刻ベースの境界だけを見る
  gc(st, now);
  ['EVT_x_createKey_C1', 'IALERT_SENT_a', 'BK_BK-A', 'TRK_BK-A'].forEach(function (k) { assert.ok(has(st, k), k + ' は3日ちょうどまで残る'); });
  now.v += 1;
  var removed = gc(st, now);
  ['EVT_x_createKey_C1', 'IALERT_SENT_a', 'BK_BK-A', 'TRK_BK-A'].forEach(function (k) { assert.ok(!has(st, k), k + ' は3日超で回収'); });
  assert.strictEqual(removed.EVT, 1); assert.strictEqual(removed.IALERT, 1); assert.strictEqual(removed.BK, 1); assert.strictEqual(removed.TRK, 1);
});

// ---------------------------------------------------------------- 取消・非対象（desired=false, endSec=null, ops=[]）

test('Core.earlyReclaimAtSec: 取消・非対象は範囲外の時刻、有効な予約は終了後かつ範囲外、旧headは終了済みのみ', function () {
  assert.strictEqual(C.earlyReclaimAtSec(null), null);
  assert.strictEqual(C.earlyReclaimAtSec(cancelledHead(true)), EXIT);
  assert.strictEqual(C.earlyReclaimAtSec(nonTargetHead()), EXIT);
  assert.strictEqual(C.earlyReclaimAtSec(cancelledHead(false)), null, '旧head（取消）は時刻ベース');
  assert.strictEqual(C.earlyReclaimAtSec({ desired: true, endSec: EXIT - 10 * HOUR, windowExitSec: EXIT }), EXIT, '終了が範囲外より前なら範囲外まで待つ');
  assert.strictEqual(C.earlyReclaimAtSec({ desired: true, endSec: EXIT + 5 * HOUR, windowExitSec: EXIT }), EXIT + 5 * HOUR, '複数日にまたがる場合は終了後');
  assert.strictEqual(C.earlyReclaimAtSec({ desired: true, endSec: null }), null, '有効で終了未確認');
  assert.strictEqual(C.earlyReclaimAtSec({ desired: false, endedSec: NOW }), NOW, '旧head（終了済み）は従来どおり');
});

test('取消の BK/TRK: 読取範囲内（利用日の当日・翌日）は3日待たずとも残し、範囲外になった後の次の清掃で回収する', function () {
  var st = mem(), now = { v: EXIT - 2 * HOUR };
  put(st, 'BK-C', cancelledHead(true), [], 5 * HOUR);
  gc(st, now);
  assert.ok(has(st, 'BK_BK-C') && has(st, 'TRK_BK-C'), '範囲内（利用日の当日中）は残す。同期が作り直すため');
  now.v = EXIT + 10;
  gc(st, now);
  assert.ok(!has(st, 'BK_BK-C') && !has(st, 'TRK_BK-C'), '範囲外になったら翌日までに回収');
});

test('取消の BK/TRK: 直近の同期（touchedAt）から猶予（1時間）未満なら残す。非対象（取消でない）予約も同じ', function () {
  var st = mem(), now = { v: EXIT + 10 };
  var recent = NOW - now.v + 10 * 60; // 最後の同期は清掃の10分前（touchedAt = now.v - 10分）
  put(st, 'BK-C', cancelledHead(true), [], recent);
  put(st, 'BK-N', nonTargetHead(), [], recent);
  gc(st, now);
  assert.ok(has(st, 'BK_BK-C') && has(st, 'BK_BK-N'), '猶予内は残す');
  now.v += HOUR;
  gc(st, now);
  assert.ok(!has(st, 'BK_BK-C') && !has(st, 'BK_BK-N') && !has(st, 'TRK_BK-C') && !has(st, 'TRK_BK-N'), '猶予後に回収');
});

test('windowExitSec を持たない旧headの取消は、時刻ベース（3日）まで残して回収する（安全を証明できないので早期回収しない）', function () {
  var st = mem(), now = { v: NOW };
  put(st, 'BK-OLD', cancelledHead(false), [], 2 * DAY);
  gc(st, now);
  assert.ok(has(st, 'BK_BK-OLD') && has(st, 'TRK_BK-OLD'));
  now.v += 2 * DAY;
  gc(st, now);
  assert.ok(!has(st, 'BK_BK-OLD') && !has(st, 'TRK_BK-OLD'));
});

test('取消でも、未解決の操作・削除未確認の鍵が残る予約の BK/TRK は範囲外・期限後も保持する', function () {
  var st = mem(), now = { v: EXIT + 10 * DAY };
  [S.UNKNOWN, S.DELETE_SENT, S.DELETE_PENDING, S.ISSUED_CONFIRMED].forEach(function (state, i) {
    put(st, 'BK-' + i, cancelledHead(true), [{ rev: 1, state: state, ageSec: 10 * DAY }], 10 * DAY);
  });
  gc(st, now);
  [0, 1, 2, 3].forEach(function (i) {
    assert.ok(has(st, 'BK_BK-' + i) && has(st, 'TRK_BK-' + i), 'state#' + i + ' は保持');
    assert.strictEqual(st.keys().filter(function (k) { return k.indexOf('OP_BK-' + i + ':') === 0; }).length, 1);
  });
});

test('鍵準備の追跡対象（KEYREADY.refs）の予約は、範囲外でも早期回収しない（通常の期限は待つ）', function () {
  var st = mem(), now = { v: EXIT + 2 * HOUR };
  put(st, 'BK-K', cancelledHead(true), [], 5 * HOUR);
  st.set('KEYREADY', JSON.stringify({ at: NOW, count: 1, notReady: [], refs: ['BK-K'] }));
  gc(st, now);
  assert.ok(has(st, 'BK_BK-K') && has(st, 'TRK_BK-K'));
  assert.ok(has(st, 'KEYREADY'), '常設キーは回収しない');
});

// ---------------------------------------------------------------- 終端OP・配送・同一予約の保護

test('終端OPは3日で回収するが、配送が送信中・結果不明なら3日を過ぎても保持する（配送済み・抑止・未送信は回収）', function () {
  var now = { v: NOW };
  ['SENDING', 'UNKNOWN'].forEach(function (dlv) {
    var st = mem();
    put(st, 'BK-D', cancelledHead(true), [{ rev: 1, state: S.FAILED, ageSec: 5 * DAY, dlv: dlv }], 5 * DAY);
    engineOf(st, now).sweep();
    assert.strictEqual(st.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).length, 1, dlv + ' は保持');
    assert.ok(has(st, 'DLV_BK-D:1:****37DD:ISSUE#1'));
  });
  ['DELIVERED', 'SUPPRESSED', 'NOT_SENT'].forEach(function (dlv) {
    var st = mem();
    put(st, 'BK-D', cancelledHead(true), [{ rev: 1, state: S.FAILED, ageSec: 5 * DAY, dlv: dlv }], 5 * DAY);
    engineOf(st, now).sweep();
    assert.strictEqual(st.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).length, 0, dlv + ' は3日後に回収');
  });
});

test('終端OPは3日を過ぎても、同じ予約に未終端の操作（有効な鍵・UNKNOWN等）が残る間は保持する（案内メール種別の判定根拠）', function () {
  var now = { v: NOW };
  [S.ISSUED_CONFIRMED, S.UNKNOWN, S.DELETE_SENT].forEach(function (state) {
    var st = mem();
    put(st, 'BK-S', { revision: 2, cancelled: false, desired: true, startSec: NOW, endSec: NOW + DAY, deviceId: DEV },
      [{ rev: 1, state: S.FAILED, ageSec: 5 * DAY, dlv: 'DELIVERED' }, { rev: 2, state: state, ageSec: HOUR, over: { endSec: NOW + DAY } }], 5 * DAY);
    // 未終端側の遷移（EXPIRED 判定・削除）は API を呼ばない状態だけを使う。ISSUED_CONFIRMED は期限前
    try { engineOf(st, now).sweep(); } catch (e) { /* 読取APIは注入が即失敗。この状態は照合せず保持の確認だけ */ }
    assert.ok(has(st, 'OP_BK-S:1:****37DD:ISSUE#1'), state + ' が残る間は終端OPも保持');
  });
  var st2 = mem();
  put(st2, 'BK-S', { revision: 2, cancelled: false, desired: true, startSec: NOW, endSec: NOW + DAY, deviceId: DEV },
    [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * DAY, dlv: 'DELIVERED' }, { rev: 2, state: S.ABANDONED, ageSec: 5 * DAY, dlv: 'DELIVERED' }], 5 * DAY);
  engineOf(st2, now).sweep();
  assert.strictEqual(st2.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).length, 0, 'すべて終端なら3日後に回収');
});

test('UNKNOWN・未解決のOPと、その根拠（EVT・BK・TRK）は期限（3日）を大きく超えても保持する', function () {
  var st = mem(), now = { v: NOW };
  var ids = put(st, 'BK-U', { revision: 1, cancelled: false, desired: true, startSec: NOW - 20 * DAY, endSec: NOW - 19 * DAY, deviceId: DEV },
    [{ rev: 1, state: S.UNKNOWN, ageSec: 20 * DAY, dlv: 'UNKNOWN' }], 20 * DAY);
  var r = opRec('BK-U', 1, S.UNKNOWN, 20 * DAY);
  st.set('EVT_' + C.normDev(DEV) + '_createKey_' + r.commandId, JSON.stringify({ receivedAtSec: NOW - 20 * DAY }));
  st.set('EVT_' + C.normDev(DEV) + '_deleteKey_' + r.deleteCommandId, JSON.stringify({ receivedAtSec: NOW - 20 * DAY }));
  var rep = {};
  gc(st, now, rep);
  engineOf(st, now).sweep();
  assert.ok(has(st, 'OP_' + ids[0]) && has(st, 'BK_BK-U') && has(st, 'TRK_BK-U') && has(st, 'DLV_' + ids[0]));
  assert.strictEqual(st.keys().filter(function (k) { return k.indexOf('EVT_') === 0; }).length, 2);
  assert.strictEqual(rep.retained.BK_OP_REMAINS, 1);
  assert.strictEqual(rep.retained.TRK_UNRESOLVED_OP, 1);
  assert.strictEqual(rep.retained.EVT_UNRESOLVED_OP, 2);
});

// ---------------------------------------------------------------- 別目的のキーは対象外

test('APICOUNT（当日＋過去7日）・HB・META_ENV・KEYREADY・LOCKFAIL・未送達IALERT・ADMINLOG（90日内）は3日保持の対象外', function () {
  var st = mem({
    APICOUNT_20300110: '5', APICOUNT_20300103: '5',
    HB_SYNC: '{"at":1}', META_ENV: 'production', KEYREADY: '{"refs":[]}', LOCKFAIL: '0',
    'IALERT_PENDING_a': JSON.stringify({ event: { code: 'X' }, sentAt: null, attempts: 3 })
  });
  st.set('ADMINLOG_1_1', JSON.stringify({ at: NOW - 60 * DAY, action: 'DELETE' }));
  gc(st, { v: NOW });
  ['APICOUNT_20300110', 'APICOUNT_20300103', 'HB_SYNC', 'META_ENV', 'KEYREADY', 'LOCKFAIL', 'IALERT_PENDING_a', 'ADMINLOG_1_1'].forEach(function (k) { assert.ok(has(st, k), k); });
  st.set('ADMINLOG_1_2', JSON.stringify({ at: NOW - 91 * DAY, action: 'DELETE' }));
  gc(st, { v: NOW });
  assert.ok(!has(st, 'ADMINLOG_1_2'), 'ADMINLOG は90日超で回収');
});

// ---------------------------------------------------------------- 残存理由・次回回収時刻（固定コード・集計のみ）

test('残存理由は固定コードの件数と、次の回収可能時刻だけを返す（予約ID・キー名・値は含めない）', function () {
  var st = mem(), now = { v: EXIT - HOUR };
  put(st, 'SECRET-BOOKING-ID', cancelledHead(true), [], HOUR);
  st.set('EVT_dev_createKey_cmd', JSON.stringify({ receivedAtSec: NOW }));
  var rep = {};
  gc(st, now, rep);
  assert.strictEqual(rep.retained.BK_WAIT_EARLY_RECLAIM, 1);
  assert.strictEqual(rep.retained.TRK_WAIT_RETENTION, 1);
  assert.strictEqual(rep.retained.EVT_WAIT_RETENTION, 1);
  assert.strictEqual(typeof rep.nextPurgeAtSec, 'number');
  assert.ok(rep.nextPurgeAtSec <= now.v + 3 * DAY);
  var out = JSON.stringify(rep);
  assert.ok(out.indexOf('SECRET-BOOKING-ID') === -1 && out.indexOf('dev_createKey') === -1 && out.indexOf(DEV) === -1);
  Object.keys(rep.retained).forEach(function (c) { assert.ok(/^[A-Z_]+$/.test(c), '固定コード: ' + c); });
});

// ---------------------------------------------------------------- 実運用の周期を通す結合

var SYNC_SEC = 300, SWEEP_SEC = 3600, WATCHDOG_SEC = 900, DELIVER_SEC = 300;
function mailWorld() {
  var w = H.createWorld({ mail: true, cfg: { deliveryConfigured: true, delivery: H.DELIVERY_CFG } });
  w.createMode = 'noCommandId';
  w.deleteMode = 'noCommandId';
  w.preload(H.DEV, 2);
  return w;
}
function simOf(w, rt) {
  var t = { sync: 0, deliver: 0, sweep: 0, watchdog: 0 };
  return {
    run: function (sec) {
      for (var e = 10; e <= sec; e += 10) {
        w.advance(10);
        ['sync', 'deliver', 'sweep', 'watchdog'].forEach(function (j) { t[j] += 10; });
        if (t.sync >= SYNC_SEC) { t.sync = 0; rt.syncCycle(); }
        if (t.deliver >= DELIVER_SEC) { t.deliver = 0; rt.deliverCycle(); }
        if (t.sweep >= SWEEP_SEC) { t.sweep = 0; rt.sweepCycle(); }
        if (t.watchdog >= WATCHDOG_SEC) { t.watchdog = 0; rt.watchdog(); }
      }
    }
  };
}
function propKeys(w, bk) { return w.store.keys().filter(function (k) { return k.indexOf(bk) !== -1; }); }

test('結合: sync は head に windowExitSec（利用日の翌日0:00 JST）を残す。取消後に、同じ改訂以下の遅延確定イベントは範囲内の間 AFTER_CANCEL で弾かれる', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = simOf(w, rt);
  w.records = [H.record()];                                   // 利用日 2030-01-11
  sim.run(SYNC_SEC * 2 + 60);
  assert.strictEqual(w.callCount('createKey'), 1);
  w.records = [H.record({ revision: 2, status: 'CANCELLED' })];
  sim.run(SYNC_SEC * 4);                                      // 取消 → 旧キー削除
  var head = JSON.parse(w.store.get('BK_SNB-1')).head;
  assert.strictEqual(head.cancelled, true);
  assert.strictEqual(head.windowExitSec, C.jstToEpochSec('2030-01-12', '00:00'));
  // 遅延した古い確定スナップショット（同じ改訂）。範囲内の間は BK を保持しているので、再発行しない
  var created = w.callCount('createKey');
  w.records = [H.record({ revision: 2, status: 'CONFIRMED' })];
  sim.run(SYNC_SEC * 3 + 3600);                               // sweep も数回通る（利用日の当日中）
  assert.ok(propKeys(w, 'SNB-1').some(function (k) { return k === 'BK_SNB-1'; }), '範囲内は BK を保持');
  assert.strictEqual(w.callCount('createKey'), created, '遅延確定イベントで旧コードを復活させない');
});

test('結合: 取消済み予約が台帳に残る間、連続同期でも TRK の観測時刻（seenAt）は更新され続けず、範囲外の後は BK/TRK が回収される', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = simOf(w, rt);
  w.records = [H.record({ revision: 2, status: 'CANCELLED' })];
  sim.run(SYNC_SEC * 2 + 60);
  var seen1 = JSON.parse(w.store.get('TRK_SNB-1')).seenAt;
  sim.run(SYNC_SEC * 12);                                     // 連続同期（利用日の前日）
  var seen2 = JSON.parse(w.store.get('TRK_SNB-1')).seenAt;
  assert.strictEqual(seen2, seen1, '改訂が変わらなければ起点は動かない（回収が先延ばしされない）');
  assert.strictEqual(w.callCount('createKey'), 0, '取消の予約に鍵は作らない');
  // 台帳の読取範囲を外れた（予約が台帳の対象日から外れる＝以後 sync に渡らない）状態を再現: 台帳から外して翌日0時以降の清掃
  w.records = [];
  w.nowMs = Date.parse('2030-01-12T00:30:00+09:00');
  rt.sweepCycle();
  assert.deepStrictEqual(propKeys(w, 'SNB-1').filter(function (k) { return /^(OP_|DLV_|BK_|TRK_)/.test(k); }), [], '範囲外後は翌日の清掃までに整理');
});

// ---------------------------------------------------------------- 範囲外の再読込が起きないこと（BK head 破棄の安全前提）
// 台帳の読取（AccessLedgerReader.select）は「利用日(JST)が当日・翌日」＋ trackedIds（未解決OPのある予約・KEYREADY.refs）だけを返す。
// head.windowExitSec（利用日の翌日0:00 JST）の前後で、実際の select の返却と一致することを固定する。

var Reader = require('../gas/switchbot-access/AccessLedgerReader.gs');
function pick(startIso, now, tracked) {
  var cols = { bookingId: ['B-1'], startAt: [new Date(startIso)], endAt: [new Date(startIso)], brand: ['snb'], status: ['confirmed'],
    paymentMethod: ['cash'], paymentStatus: ['paid'], revision: [1] };
  return Reader.select(cols, now * 1000, tracked || [], ['snb']).length === 1;
}

test('読取範囲の境界: 利用日の前々日は範囲外、前日0:00〜当日中は範囲内、翌日0:00 JST（windowExitSec）ちょうどで範囲外になる', function () {
  var start = '2030-01-10T10:00:00+09:00';
  var exit = C.jstToEpochSec('2030-01-10', '00:00') + DAY; // = 2030-01-11 00:00 JST
  assert.strictEqual(pick(start, C.jstToEpochSec('2030-01-07', '23:59')), false, '前々日以前は対象外（まだ読まれない）');
  assert.strictEqual(pick(start, C.jstToEpochSec('2030-01-08', '23:59')), false, 'ちょうど2日前の23:59は対象外');
  assert.strictEqual(pick(start, C.jstToEpochSec('2030-01-09', '00:00')), true, '前日0:00から範囲内');
  assert.strictEqual(pick(start, exit - 1), true, '翌日0:00の1秒前は範囲内');
  assert.strictEqual(pick(start, exit), false, '翌日0:00ちょうどで範囲外');
  assert.strictEqual(pick(start, exit + 30 * DAY), false, '以後は読まれない');
});

test('同期が記録する windowExitSec は、select が予約を返さなくなる最初の時刻と一致する（取消・非対象・終了済みいずれも）', function () {
  var cases = [
    { name: '取消', booking: { status: 'CANCELLED' } },
    { name: '非対象', booking: { brand: 'other' } },
    { name: '有効', booking: {} }
  ];
  cases.forEach(function (c) {
    var st = mem(), now = { v: C.jstToEpochSec('2030-01-09', '12:00') };
    var eng = engineOf(st, now);
    var b = Object.assign({ bookingId: 'B-1', revision: 1, status: 'CONFIRMED', paymentStatus: 'paid', brand: 'studio', facility: 'main', room: 'A',
      date: '2030-01-10', startTime: '10:00', endDate: '2030-01-10', endTime: '12:00' }, c.booking);
    eng.sync(b);
    var head = JSON.parse(st.get('BK_B-1')).head;
    assert.strictEqual(head.windowExitSec, C.jstToEpochSec('2030-01-11', '00:00'), c.name);
    assert.strictEqual(pick('2030-01-10T10:00:00+09:00', head.windowExitSec - 1), true, c.name + ': 直前は範囲内');
    assert.strictEqual(pick('2030-01-10T10:00:00+09:00', head.windowExitSec), false, c.name + ': 一致する時刻から範囲外');
  });
});

test('trackedIds（未解決OPのある予約）は範囲外でも読取対象に残る。解決（OP回収）後は範囲外のまま読まれない', function () {
  var start = '2030-01-10T10:00:00+09:00';
  var late = C.jstToEpochSec('2030-02-01', '12:00');
  assert.strictEqual(pick(start, late, []), false, '追跡なしは範囲外');
  assert.strictEqual(pick(start, late, ['B-1']), true, '未解決OPがあれば範囲外でも読む（旧キー削除・UNKNOWN の確認が続く）');
  assert.strictEqual(pick(start, late, ['OTHER']), false, '別予約の追跡は無関係');
});

test('時刻が読めない予約（startAt が空）は常に読取対象。windowExitSec を持たないため BK/TRK は時刻ベース（3日）でしか回収されない', function () {
  var cols = { bookingId: ['B-X'], startAt: [''], endAt: [''], brand: ['snb'], status: ['confirmed'], paymentMethod: ['cash'], paymentStatus: ['paid'], revision: [1] };
  assert.strictEqual(Reader.select(cols, C.jstToEpochSec('2031-01-01', '00:00') * 1000, [], ['snb']).length, 1);
  var st = mem(), now = { v: NOW };
  engineOf(st, now).sync({ bookingId: 'B-X', revision: 1, status: 'CANCELLED', paymentStatus: 'paid', brand: 'studio', facility: 'main', room: 'A', date: '', startTime: '', endDate: '', endTime: '' });
  var head = JSON.parse(st.get('BK_B-X')).head;
  assert.strictEqual(head.windowExitSec, null);
  assert.strictEqual(C.earlyReclaimAtSec(head), null, '早期回収しない');
});

// ---------------------------------------------------------------- Codex レビュー対応（P2 x2）

test('有効な予約（利用可能時間が終了していない）の FAILED 記録は、3日を超えても保持し、同期が同じ改訂で再発行しない。終了後は期限で回収する', function () {
  // 複数日にまたがる予約（利用開始から5日経過・終了は3日後）。FAILED は同じ改訂・窓の再発行を妨げる根拠
  var st = mem(), now = { v: NOW };
  var wStart = C.jstToEpochSec('2030-01-05', '10:00') - 600, wEnd = C.jstToEpochSec('2030-01-13', '12:00') + 900; // 設定の猶予（前600秒・後900秒）込みの窓
  var head = { revision: 1, cancelled: false, desired: true, startSec: wStart, endSec: wEnd, deviceId: DEV, endedSec: null, windowExitSec: null };
  put(st, 'BK-M', head, [{ rev: 1, state: S.FAILED, ageSec: 5 * DAY, dlv: 'NOT_SENT', over: { startSec: wStart, endSec: wEnd } }], 5 * DAY);
  engineOf(st, now).sweep();
  assert.strictEqual(st.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).length, 1, '有効な予約の FAILED は保持');
  // 同期（予約が有効なまま）は FAILED を理由に再発行しない（API 注入は即失敗するスタブ。呼べば例外）
  var eng = engineOf(st, now);
  var out = eng.sync({ bookingId: 'BK-M', revision: 1, status: 'CONFIRMED', paymentStatus: 'paid', brand: 'studio', facility: 'main', room: 'A',
    date: '2030-01-05', startTime: '10:00', endDate: '2030-01-13', endTime: '12:00' });
  assert.ok(out.skipped, '再発行せず見送る: ' + JSON.stringify(out));
  // 利用可能時間の終了後は、時刻ベースで回収する
  now.v = wEnd + HOUR + 1;
  var h2 = Object.assign({}, head, { desired: false, endSec: null, endedSec: wEnd });
  var bk = JSON.parse(st.get('BK_BK-M')); bk.head = h2; st.set('BK_BK-M', JSON.stringify(bk));
  var op = JSON.parse(st.get('OP_BK-M:1:****37DD:ISSUE#1')); op.updatedAt = now.v - 4 * DAY; st.set('OP_BK-M:1:****37DD:ISSUE#1', JSON.stringify(op));
  engineOf(st, now).sweep();
  assert.strictEqual(st.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).length, 0, '終了後は3日超で回収');
});

test('終端OPに残った送信中・結果不明の配送は、管理者が GIVE_UP / CONFIRM_DELIVERED で確定でき、確定後は期限で回収される（永久保持にしない）', function () {
  ['UNKNOWN', 'SENDING'].forEach(function (dlv) {
    ['GIVE_UP', 'CONFIRM_DELIVERED'].forEach(function (decision) {
      var st = mem(), now = { v: NOW };
      put(st, 'BK-R', cancelledHead(true), [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * DAY, dlv: dlv }], 5 * DAY);
      var id = 'BK-R:1:****37DD:ISSUE#1';
      var eng = engineOf(st, now);
      eng.sweep();
      assert.ok(has(st, 'OP_' + id), dlv + ': 確定前は保持');
      var r = eng.adminResolveDelivery(id, decision, 'admin-label');
      assert.strictEqual(r.ok, true, dlv + '/' + decision + ': 終端OPでも確定できる ' + JSON.stringify(r));
      assert.strictEqual(JSON.parse(st.get('DLV_' + id)).state, decision === 'GIVE_UP' ? 'SUPPRESSED' : 'DELIVERED');
      eng.sweep();
      assert.ok(!has(st, 'OP_' + id) && !has(st, 'DLV_' + id), dlv + '/' + decision + ': 確定後は3日超で回収');
    });
  });
});

test('終端OPへの管理者操作は、再送を伴わない確定（GIVE_UP / CONFIRM_DELIVERED）だけ。ALLOW_RESEND / REGUIDE は拒否し、メールを送らない', function () {
  var st = mem(), now = { v: NOW };
  put(st, 'BK-R', cancelledHead(true), [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * DAY, dlv: 'UNKNOWN' }], 5 * DAY);
  var id = 'BK-R:1:****37DD:ISSUE#1';
  var sent = 0;
  var eng = C.createEngine({
    store: st, secrets: mem(), lock: function (keys, fn) { return fn(); },
    api: { listDevices: function () { throw new Error('NO_API_IN_THIS_TEST'); } },
    notifyAdmin: function () {}, deliverCode: function () { sent++; }, deliveryGate: function () { return { ok: true }; },
    sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); }, randomInt: function (n) { return crypto.randomInt(n); },
    nowSec: function () { return now.v; }
  }, { enabled: true, commercialUseApproved: true, eligiblePaymentStatuses: ['paid'], eligibleBrands: ['studio'], graceBeforeSec: 600, graceAfterSec: 900,
       keypads: [{ brand: 'studio', facility: 'main', room: 'A', deviceId: DEV }] });
  ['ALLOW_RESEND', 'REGUIDE'].forEach(function (decision) {
    var r = eng.adminResolveDelivery(id, decision, 'admin-label');
    assert.strictEqual(r.ok, false, decision + ' は拒否');
  });
  assert.strictEqual(JSON.parse(st.get('DLV_' + id)).state, 'UNKNOWN', '拒否時は配送状態を変えない');
  assert.strictEqual(sent, 0, '送信しない');
});

test('有効な予約（利用可能時間の終了前）の BK/TRK は、3日を超えても回収しない（TRK の digest が同じ改訂での内容変更 DIGEST_MISMATCH の凍結根拠）。終了後は期限で回収する', function () {
  var st = mem(), now = { v: NOW };
  // 複数日予約（終了は3日後）。OPは無い（管理者が鍵を削除済み等）。TRK は5日前の観測
  put(st, 'BK-M', { revision: 1, cancelled: false, desired: true, startSec: NOW - 5 * DAY, endSec: NOW + 3 * DAY, deviceId: DEV, endedSec: null, windowExitSec: null }, [], 5 * DAY);
  st.set('TRK_BK-M', JSON.stringify({ revision: 1, digest: 'ORIGINAL-DIGEST', seenAt: NOW - 5 * DAY }));
  var rep = {};
  gc(st, now, rep);
  assert.ok(has(st, 'BK_BK-M') && has(st, 'TRK_BK-M'), '有効な予約の BK/TRK は保持');
  assert.strictEqual(JSON.parse(st.get('TRK_BK-M')).digest, 'ORIGINAL-DIGEST', '凍結判定の根拠（digest）を保つ');
  assert.strictEqual(rep.retained.BK_ACTIVE_BOOKING, 1);
  assert.strictEqual(rep.retained.TRK_ACTIVE_BOOKING, 1);
  now.v = NOW + 3 * DAY + 1;                                   // 利用可能時間の終了後
  gc(st, now);
  assert.ok(!has(st, 'BK_BK-M') && !has(st, 'TRK_BK-M'), '終了後は期限（3日）超過なら回収');
});
