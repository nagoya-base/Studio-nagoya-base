/*
 * Issue #912: 実鍵の不在が確認できた操作履歴を、30日を待たず次の定期sweepで回収する。
 * 実API・実機には接続しない。予約ID・端末ID・宛先などの実データは使わない（すべてダミー）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');
var H = require('./helpers/switchbot-access-world');
var C = H.Core, Infra = H.Infra, S = C.STATE;

var DEV = 'AAAAAAAAAAAA37DD';
var NOW = C.jstToEpochSec('2030-01-10', '13:00');
var HOUR = 3600, DAY = 86400;

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
function engineOf(store, secrets, now) {
  return C.createEngine({
    store: store, secrets: secrets,
    lock: function (keys, fn) { return fn(); },
    api: { listDevices: function () { throw new Error('NO_API_IN_THIS_TEST'); } },
    notifyAdmin: function () {}, deliverCode: function () {}, deliveryGate: function () { return { ok: true }; },
    sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); },
    randomInt: function (n) { return crypto.randomInt(n); },
    nowSec: function () { return now.v; }
  }, { enabled: true, commercialUseApproved: true, eligiblePaymentStatuses: ['paid'], eligibleBrands: ['studio'], graceBeforeSec: 600, graceAfterSec: 900,
       keypads: [{ brand: 'studio', facility: 'main', room: 'A', deviceId: DEV }] });
}
function opRec(bk, rev, state, ageSec, over) {
  var id = bk + ':' + rev + ':****37DD:ISSUE#1';
  return Object.assign({ id: id, bookingId: bk, revision: rev, op: 'ISSUE', deviceId: DEV, name: 'SNB-' + bk, state: state, updatedAt: NOW - ageSec,
    commandId: 'C-' + bk + rev, deleteCommandId: 'D-' + bk + rev, endSec: NOW - 2 * DAY, startSec: NOW - 3 * DAY, evidence: [], history: [] }, over || {});
}
/** 1予約ぶんの状態を作る。ops は [{rev,state,ageSec,over,dlv}]。head は索引の最新予約状態。 */
function seed(store, secrets, bk, head, ops, touchedAgo) {
  var ids = [];
  ops.forEach(function (o) {
    var r = opRec(bk, o.rev, o.state, o.ageSec, o.over);
    ids.push(r.id);
    store.set('OP_' + r.id, JSON.stringify(r));
    secrets.set('SECRET_' + r.id, 'x');
    store.set('ALERT_' + r.id + '_DELIVERY_UNKNOWN', '1');
    store.set('EVT_' + C.normDev(DEV) + '_createKey_' + r.commandId, JSON.stringify({ receivedAtSec: NOW - o.ageSec }));
    store.set('EVT_' + C.normDev(DEV) + '_deleteKey_' + r.deleteCommandId, JSON.stringify({ receivedAtSec: NOW - o.ageSec }));
    if (o.dlv) store.set('DLV_' + r.id, JSON.stringify({ id: 'DLV_' + r.id, opId: r.id, bookingId: bk, state: o.dlv, attempts: 1, history: [] }));
  });
  store.set('BK_' + bk, JSON.stringify({ bookingId: bk, head: head, ops: ids, touchedAt: NOW - (touchedAgo === undefined ? 3 * HOUR : touchedAgo) }));
  store.set('TRK_' + bk, JSON.stringify({ revision: 1, seenAt: NOW - 3 * HOUR }));
  return ids;
}
function opKeys(store, bk) { return store.keys().filter(function (k) { return k.indexOf('OP_' + bk + ':') === 0; }); }
function relatedKeys(store, bk) { return store.keys().filter(function (k) { return k.indexOf(bk) !== -1; }); }

var ENDED = { revision: 1, cancelled: false, desired: true, startSec: NOW - 3 * DAY, endSec: NOW - 2 * DAY, deviceId: DEV };
var CANCELLED = { revision: 2, cancelled: true, desired: false, startSec: null, endSec: null, deviceId: null };

function run(store, secrets, now) {
  var e = engineOf(store, secrets, now);
  e.sweep();
  var rep = {};
  var removed = Infra.garbageCollect(store, { keys: function () { return secrets.keys(); }, del: function (k) { secrets.del(k); } }, now.v, H.baseCfg(), rep);
  return { removed: removed, rep: rep };
}

test('削除確認済み（取消後の DELETED_CONFIRMED）は、猶予後の次のsweepでOP・配送・秘密・通知・Webhook記録まで回収される', function () {
  var st = mem(), se = mem(), now = { v: NOW };
  seed(st, se, 'BK-A', CANCELLED, [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 2 * HOUR, dlv: 'DELIVERED' }]);
  seed(st, se, 'BK-B', CANCELLED, [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 2 * HOUR, dlv: 'DELIVERED' }]);
  st.set('ACCESS_ENABLED', 'true'); st.set('META_ENV', 'production'); st.set('HB_SYNC', '{"at":1}');
  run(st, se, now);
  assert.deepStrictEqual(opKeys(st, 'BK-A'), []);
  assert.deepStrictEqual(st.keys().filter(function (k) { return /^(DLV_|ALERT_|EVT_)/.test(k) && k.indexOf('BK-A') !== -1; }), []);
  assert.deepStrictEqual(se.keys().filter(function (k) { return k.indexOf('BK-A') !== -1; }), [], '秘密も破棄');
  // 取消の head（AFTER_CANCEL の根拠）は、読取範囲内／旧headでは時刻ベース（3日）側に残す
  assert.ok(st.get('BK_BK-A') !== null, '取消予約のBK索引（head）は残る');
  // 常設キーは変更されない
  assert.strictEqual(st.get('ACCESS_ENABLED'), 'true');
  assert.strictEqual(st.get('META_ENV'), 'production');
  assert.ok(st.get('HB_SYNC') !== null);
});

test('猶予（1時間）未満は回収せず、ちょうど猶予を過ぎたら回収する', function () {
  var st = mem(), se = mem(), now = { v: NOW };
  seed(st, se, 'BK-A', CANCELLED, [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: C.EARLY_PURGE_GRACE_SEC - 1, dlv: 'DELIVERED' }]);
  run(st, se, now);
  assert.strictEqual(opKeys(st, 'BK-A').length, 1, '猶予未満は保持（遅延Webhook・直前の確定を待つ）');
  now.v += 1;
  run(st, se, now);
  assert.strictEqual(opKeys(st, 'BK-A').length, 0);
});

test('同じ予約に未解決・未削除・結果不明の操作が1つでもあれば、古い削除済み操作も保持する（変更・再発行・配送の根拠）', function () {
  ['ISSUED_CONFIRMED', 'UNKNOWN', 'DELETE_SENT', 'DELETE_PENDING', 'SENT_WAIT_WEBHOOK', 'PLANNED', 'EXPIRED', 'FAILED', 'ABANDONED'].forEach(function (sib) {
    var st = mem(), se = mem(), now = { v: NOW };
    seed(st, se, 'BK-A', { revision: 2, cancelled: false, desired: true, startSec: NOW + DAY, endSec: NOW + 2 * DAY, deviceId: DEV }, [
      { rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * HOUR, dlv: 'DELIVERED' },
      { rev: 2, state: sib, ageSec: 5 * HOUR }
    ]);
    // 兄弟の操作が未完了/未確認でも、取消済みでも同じ（猶予後・終了後に限らず、全てが安全な終端になるまで残す）
    st.set('BK_BK-A', JSON.stringify(Object.assign(JSON.parse(st.get('BK_BK-A')), { head: CANCELLED })));
    run(st, se, now);
    assert.strictEqual(opKeys(st, 'BK-A').length, 2, sib + ' が残る間は旧操作も保持');
  });
});

test('有効な予約の途中（利用可能時間の終了前）で削除された鍵は早期回収しない（再発行判断を残す）。終了後なら回収する', function () {
  var st = mem(), se = mem(), now = { v: NOW };
  seed(st, se, 'BK-A', { revision: 1, cancelled: false, desired: true, startSec: NOW - DAY, endSec: NOW + DAY, deviceId: DEV },
    [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * HOUR, dlv: 'DELIVERED' }]);
  run(st, se, now);
  assert.strictEqual(opKeys(st, 'BK-A').length, 1);
  now.v += 2 * DAY; // 利用可能時間の終了後
  run(st, se, now);
  assert.strictEqual(opKeys(st, 'BK-A').length, 0);
});

test('期限切れで不在確認済み（ARCHIVED_EXPIRED）・既に不在（ALREADY_ABSENT）も、終了後なら回収する', function () {
  [S.ARCHIVED_EXPIRED, S.ALREADY_ABSENT].forEach(function (state) {
    var st = mem(), se = mem(), now = { v: NOW };
    seed(st, se, 'BK-A', ENDED, [{ rev: 1, state: state, ageSec: 2 * HOUR, dlv: 'DELIVERED' }]);
    run(st, se, now);
    assert.strictEqual(opKeys(st, 'BK-A').length, 0, state);
  });
});

test('配送が送信中・結果不明（UNKNOWN）の操作は回収しない。配送済み・抑止済み・未送信（鍵が失効済みで以後送られない）は回収する', function () {
  [['SENDING', 1], ['UNKNOWN', 1], ['DELIVERED', 0], ['SUPPRESSED', 0], ['NOT_SENT', 0], [null, 0]].forEach(function (c) {
    var st = mem(), se = mem(), now = { v: NOW };
    seed(st, se, 'BK-A', CANCELLED, [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 2 * HOUR, dlv: c[0] || undefined }]);
    run(st, se, now);
    assert.strictEqual(opKeys(st, 'BK-A').length, c[1], 'DLV=' + c[0]);
  });
});

test('不在確認の証拠がない終端（FAILED / ABANDONED）は早期回収せず、保持期限（3日）後に回収する', function () {
  [S.FAILED, S.ABANDONED].forEach(function (state) {
    var st = mem(), se = mem(), now = { v: NOW };
    seed(st, se, 'BK-A', CANCELLED, [{ rev: 1, state: state, ageSec: 2 * HOUR }]);
    run(st, se, now);
    assert.strictEqual(opKeys(st, 'BK-A').length, 1, state + ' は早期回収しない');
    now.v += 4 * DAY;
    run(st, se, now);
    assert.strictEqual(opKeys(st, 'BK-A').length, 0, state + ' は3日後に回収');
  });
});

test('予約索引（head）が無い・操作が索引に載っていない記録は、安全側に倒して早期回収しない', function () {
  var st = mem(), se = mem(), now = { v: NOW };
  var ids = seed(st, se, 'BK-A', CANCELLED, [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * HOUR }]);
  st.set('BK_BK-A', JSON.stringify({ bookingId: 'BK-A', head: null, ops: ids, touchedAt: NOW }));
  run(st, se, now);
  assert.strictEqual(opKeys(st, 'BK-A').length, 1, 'head なし');
  st.set('BK_BK-A', JSON.stringify({ bookingId: 'BK-A', head: CANCELLED, ops: [], touchedAt: NOW }));
  run(st, se, now);
  assert.strictEqual(opKeys(st, 'BK-A').length, 1, '索引外');
});

test('利用終了後の予約は、全操作の回収後に BK 索引・追跡記録もまとめて回収される（参照切れなし）', function () {
  var st = mem(), se = mem(), now = { v: NOW };
  seed(st, se, 'BK-A', ENDED, [
    { rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * HOUR, dlv: 'DELIVERED' },
    { rev: 2, state: S.ARCHIVED_EXPIRED, ageSec: 2 * HOUR, dlv: 'DELIVERED' }
  ]);
  var res = run(st, se, now);
  assert.deepStrictEqual(relatedKeys(st, 'BK-A'), [], '関連キーがすべて消える');
  assert.strictEqual(res.removed.BK, 1);
  assert.strictEqual(res.removed.TRK, 1);
  assert.strictEqual(res.rep.unclassified, 0);
});

test('利用終了後でも、未解決の操作が残る予約の BK・TRK は保持する。取消の予約（windowExitSec を持たない旧head）の BK 索引は時刻ベース（3日）で残す', function () {
  var st = mem(), se = mem(), now = { v: NOW };
  seed(st, se, 'BK-U', ENDED, [{ rev: 1, state: S.UNKNOWN, ageSec: 2 * HOUR }]);
  seed(st, se, 'BK-C', CANCELLED, [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 2 * HOUR, dlv: 'DELIVERED' }]);
  run(st, se, now);
  assert.ok(st.get('BK_BK-U') !== null && st.get('TRK_BK-U') !== null && opKeys(st, 'BK-U').length === 1, '未解決は保持');
  assert.ok(st.get('BK_BK-C') !== null && st.get('TRK_BK-C') !== null, '取消の旧head の BK/TRK は時刻ベース側');
  now.v += 4 * DAY;
  run(st, se, now);
  assert.strictEqual(st.get('BK_BK-C'), null);
});

test('回収は冪等で、再実行しても他の予約・常設キー・API使用量判定のキーを変更しない', function () {
  var st = mem(), se = mem(), now = { v: NOW };
  seed(st, se, 'BK-A', ENDED, [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * HOUR, dlv: 'DELIVERED' }]);
  seed(st, se, 'BK-LIVE', { revision: 1, cancelled: false, desired: true, startSec: NOW + DAY, endSec: NOW + 2 * DAY, deviceId: DEV },
    [{ rev: 1, state: S.ISSUED_CONFIRMED, ageSec: 5 * HOUR, dlv: 'DELIVERED', over: { startSec: NOW + DAY, endSec: NOW + 2 * DAY } }]);
  st.set('APICOUNT_20300110', '5'); st.set('KEYREADY', '{"at":1}'); st.set('NOTIFYFAIL', '0'); st.set('LOCKFAIL', '0');
  var before = relatedKeys(st, 'BK-LIVE').concat(['APICOUNT_20300110', 'KEYREADY', 'NOTIFYFAIL', 'LOCKFAIL']).map(function (k) { return k + '=' + st.get(k); });
  run(st, se, now);
  var mid = st.keys().length;
  run(st, se, now);
  assert.strictEqual(st.keys().length, mid, '2回目は何も消さない');
  var after = relatedKeys(st, 'BK-LIVE').concat(['APICOUNT_20300110', 'KEYREADY', 'NOTIFYFAIL', 'LOCKFAIL']).map(function (k) { return k + '=' + st.get(k); });
  assert.deepStrictEqual(after.sort(), before.sort());
  assert.deepStrictEqual(relatedKeys(st, 'BK-A'), []);
});

test('早期回収は変更APIを呼ばない（読取・状態削除のみ。API呼出しの注入は即失敗するスタブ）', function () {
  var st = mem(), se = mem(), now = { v: NOW };
  seed(st, se, 'BK-A', ENDED, [{ rev: 1, state: S.DELETED_CONFIRMED, ageSec: 5 * HOUR, dlv: 'DELIVERED' }]);
  assert.doesNotThrow(function () { run(st, se, now); });
});

// ---------------------------------------------------------------- 実運用の周期を通す結合（レビュー指摘: 終了後の sync で endSec が null になる）

var SYNC_SEC = 300, DELIVER_SEC = 300, SWEEP_SEC = 3600, WATCHDOG_SEC = 900;
function mailWorld() {
  var w = H.createWorld({ mail: true, cfg: { deliveryConfigured: true, delivery: H.DELIVERY_CFG } });
  w.createMode = 'noCommandId';
  w.deleteMode = 'noCommandId';
  w.preload(H.DEV, 2); // 通常キー（保全対象）
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

test('結合: 通常に利用が終わった予約（台帳に残ったまま）は、鍵の削除確認後に OP・配送・BK・TRK が次のsweepで回収される。通常キーは不変', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = simOf(w, rt);
  var normalBefore = JSON.stringify(w.keys[H.DEV].filter(function (k) { return /^USER-/.test(k.name); }));
  w.records = [H.record()];
  sim.run(SYNC_SEC * 2 + 60);                            // 観測 → 発行 → 反映確認
  w.nowMs = Date.parse('2030-01-10T18:00:00+09:00'); sim.run(DELIVER_SEC + 10); // 前日18:00の案内を1通
  assert.strictEqual(w.userMails.length, 1);
  assert.ok(propKeys(w, 'SNB-1').length > 0);
  w.nowMs = Date.parse('2030-01-11T12:20:00+09:00');      // 終了12:00＋猶予15分の後
  sim.run(3600 + 3600 + 600);                             // sync が ALREADY_ENDED を記録 → 削除確認 → 猶予1時間 → sweep
  assert.deepStrictEqual(propKeys(w, 'SNB-1').filter(function (k) { return /^(OP_|DLV_|ALERT_|EVT_)/.test(k); }), [], '操作・配送・通知・Webhook記録は整理済み');
  // 利用日（1/11）の当日中は台帳の読取範囲内で、sync が BK/TRK を作り直すため、範囲内では BK/TRK を残す（OP・配送等は回収済み）
  w.advance(3600 + 60);
  rt.sweepCycle();
  assert.ok(propKeys(w, 'SNB-1').some(function (k) { return k === 'BK_SNB-1'; }), '読取範囲内（利用日の当日）は BK を残す');
  // 利用日の翌日 0:00 JST を過ぎて範囲外になったら、sync を挟まない sweep で BK/TRK も整理される
  w.nowMs = Date.parse('2030-01-12T00:30:00+09:00');
  rt.sweepCycle();
  var left = propKeys(w, 'SNB-1');
  assert.deepStrictEqual(left.filter(function (k) { return /^(OP_|DLV_|ALERT_|EVT_|BK_|TRK_)/.test(k); }), [], '範囲外になった後は30日を待たず整理される: ' + left.join(','));
  assert.strictEqual(w.callCount('createKey'), 1, '再発行しない');
  assert.strictEqual(w.userMails.length, 1, '二重配送しない');
  assert.strictEqual(JSON.stringify(w.keys[H.DEV].filter(function (k) { return /^USER-/.test(k.name); })), normalBefore, '通常キーは不変');
  // 台帳に予約が残っていても、以後 sync/sweep を回し続けて再発行・再送されない
  sim.run(3600 * 3);
  assert.strictEqual(w.callCount('createKey'), 1);
  assert.strictEqual(w.userMails.length, 1);
});

test('結合: 終了後の sync は head に終了時刻（endedSec）を残し、取消（endSec なし）とは区別する', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = simOf(w, rt);
  w.records = [H.record()];
  sim.run(SYNC_SEC * 2 + 60);
  w.nowMs = Date.parse('2030-01-11T12:20:00+09:00');
  sim.run(SYNC_SEC + 10);
  var head = JSON.parse(w.store.get('BK_SNB-1')).head;
  assert.strictEqual(head.endSec, null);
  assert.strictEqual(typeof head.endedSec, 'number');
  assert.strictEqual(C.headEndSec(head), head.endedSec);
  // 取消は終了時刻を持たない（早期回収は範囲外の時刻 windowExitSec 側）
  var w2 = mailWorld(); var rt2 = w2.runtime(); var sim2 = simOf(w2, rt2);
  w2.records = [H.record()];
  sim2.run(SYNC_SEC * 2 + 60);
  w2.records = [H.record({ revision: 2, status: 'CANCELLED' })];
  sim2.run(SYNC_SEC * 3);
  var h2 = JSON.parse(w2.store.get('BK_SNB-1')).head;
  assert.strictEqual(h2.cancelled, true);
  assert.strictEqual(C.headEndSec(h2), null);
});
