/*
 * Issue #887: 状態プロパティ全体の棚卸しと不要履歴の安全な自動整理のモックテスト。
 * 実API・実機には接続しない。キー値・予約ID・宛先などの実データは使わない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var H = require('./helpers/switchbot-access-world');
var Infra = H.Infra, Core = H.Core, S = Core.STATE;

function sec(iso) { return Math.floor(Date.parse(iso) / 1000); }
function ymd(k) { return 'APICOUNT_' + k; }
function memStore(init) {
  var m = Object.assign({}, init || {});
  return {
    get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    set: function (k, v) { m[k] = v; },
    del: function (k) { delete m[k]; },
    keys: function () { return Object.keys(m); },
    dump: m
  };
}
var NO_SECRETS = { keys: function () { return []; }, del: function () {} };

// ============================================================ APICOUNT: 保持範囲（JST 当日＋前日〜7日前の計8暦日）

test('APICOUNT: JST当日と前日〜7日前の8キーを保持し、8日前以前だけ回収する', function () {
  var now = sec('2030-01-10T13:00:00+09:00');
  var store = memStore();
  var keep = ['20300110', '20300109', '20300108', '20300107', '20300106', '20300105', '20300104', '20300103'];
  var drop = ['20300102', '20300101', '20291231', '20290101'];
  keep.concat(drop).forEach(function (d) { store.set(ymd(d), '5'); });
  var rep = {};
  var removed = Infra.garbageCollect(store, NO_SECRETS, now, H.baseCfg(), rep);
  assert.strictEqual(removed.APICOUNT, drop.length);
  assert.deepStrictEqual(store.keys().sort(), keep.map(ymd).sort());
  assert.strictEqual(rep.unclassified, 0);
});

test('APICOUNT: JST 00:00 の境界（23:59:59 と 00:00:00）で保持範囲が1日進む', function () {
  var k = ymd('20300103'); // 当日=2030-01-10 の 7日前 → 保持
  var s1 = memStore(Object.fromEntries([[k, '1']]));
  Infra.garbageCollect(s1, NO_SECRETS, sec('2030-01-10T23:59:59+09:00'), H.baseCfg());
  assert.ok(s1.get(k) !== null, 'JST 1/10 23:59:59 では 7日前は保持');
  Infra.garbageCollect(s1, NO_SECRETS, sec('2030-01-11T00:00:00+09:00'), H.baseCfg());
  assert.strictEqual(s1.get(k), null, 'JST 1/11 00:00 で 8日前になり回収');
  // UTC では前日でも JST では翌日: 2030-01-10T15:00Z = JST 1/11 00:00
  var s2 = memStore(Object.fromEntries([[k, '1']]));
  Infra.garbageCollect(s2, NO_SECRETS, Date.parse('2030-01-10T14:59:59Z') / 1000, H.baseCfg());
  assert.ok(s2.get(k) !== null);
  Infra.garbageCollect(s2, NO_SECRETS, Date.parse('2030-01-10T15:00:00Z') / 1000, H.baseCfg());
  assert.strictEqual(s2.get(k), null);
});

test('APICOUNT: 年跨ぎとうるう日を暦日で数える', function () {
  // 2031-01-03(JST) の7日前 = 2030-12-27
  var s = memStore({ APICOUNT_20301227: '1', APICOUNT_20301226: '1' });
  Infra.garbageCollect(s, NO_SECRETS, sec('2031-01-03T12:00:00+09:00'), H.baseCfg());
  assert.ok(s.get('APICOUNT_20301227') !== null);
  assert.strictEqual(s.get('APICOUNT_20301226'), null);
  // うるう年 2032-03-07(JST) の7日前 = 2032-02-29（実在）。2032-02-28 は8日前で回収
  var l = memStore({ APICOUNT_20320229: '1', APICOUNT_20320228: '1' });
  Infra.garbageCollect(l, NO_SECRETS, sec('2032-03-07T12:00:00+09:00'), H.baseCfg());
  assert.ok(l.get('APICOUNT_20320229') !== null);
  assert.strictEqual(l.get('APICOUNT_20320228'), null);
  // 平年 2031-03-07 の7日前 = 2031-02-28
  var n = memStore({ APICOUNT_20310228: '1', APICOUNT_20310227: '1' });
  Infra.garbageCollect(n, NO_SECRETS, sec('2031-03-07T12:00:00+09:00'), H.baseCfg());
  assert.ok(n.get('APICOUNT_20310228') !== null);
  assert.strictEqual(n.get('APICOUNT_20310227'), null);
});

test('APICOUNT: 同日の再実行は冪等で、将来日付・不正形式・実在しない日付は削除しない（未分類は件数のみ報告）', function () {
  var now = sec('2030-01-10T13:00:00+09:00');
  var junk = ['APICOUNT_', 'APICOUNT_2030011', 'APICOUNT_203001100', 'APICOUNT_2030-01-01', 'APICOUNT_abc', 'APICOUNT_20300230', 'APICOUNT_20301301', 'APICOUNT_00000000'];
  var init = { APICOUNT_20300111: '3', APICOUNT_29990101: '3', APICOUNT_20300102: '9' };
  junk.forEach(function (k) { init[k] = 'x'; });
  var s = memStore(init);
  var rep = {};
  var first = Infra.garbageCollect(s, NO_SECRETS, now, H.baseCfg(), rep);
  assert.strictEqual(first.APICOUNT, 1, '回収は正常形式の古い1件のみ');
  assert.strictEqual(s.get('APICOUNT_20300102'), null);
  assert.strictEqual(s.get('APICOUNT_20300111'), '3');
  assert.strictEqual(s.get('APICOUNT_29990101'), '3');
  junk.forEach(function (k) { assert.strictEqual(s.get(k), 'x', k + ' は不正形式のため削除しない'); });
  assert.strictEqual(rep.unclassified, junk.length, '不正形式は未分類として件数のみ報告');
  var before = JSON.stringify(s.dump);
  var rep2 = {};
  var second = Infra.garbageCollect(s, NO_SECRETS, now, H.baseCfg(), rep2);
  assert.strictEqual(second.APICOUNT, 0);
  assert.strictEqual(JSON.stringify(s.dump), before, '同日再実行で変化しない');
});

test('APICOUNT: 他種類のキーは回収せず、当日の used/exhausted/count に回帰がない', function () {
  var now = sec('2030-01-10T13:00:00+09:00');
  var s = memStore({ META_ENV: 'production', LOCKFAIL: '2', NOTIFYFAIL: '1', HB_SYNC: '{}', HB_SWEEP: '{}', HB_CLEANUP: '{}', HB_DELIVER: '{}', HB_ADMIN: '{}' });
  var budget = Infra.createApiBudget(s, function () { return now; }, 3);
  budget.count(); budget.count();
  s.set('APICOUNT_20300101', '99'); // 古い日の枯渇値は当日判定に影響しない
  assert.strictEqual(budget.used(), 2);
  Infra.garbageCollect(s, NO_SECRETS, now, H.baseCfg());
  assert.strictEqual(s.get('APICOUNT_20300101'), null);
  assert.strictEqual(budget.used(), 2);
  assert.strictEqual(budget.exhausted(), false);
  budget.count();
  assert.strictEqual(budget.exhausted(), true);
  assert.strictEqual(budget.used(), 3);
  ['META_ENV', 'LOCKFAIL', 'NOTIFYFAIL', 'HB_SYNC', 'HB_SWEEP', 'HB_CLEANUP', 'HB_DELIVER', 'HB_ADMIN'].forEach(function (k) { assert.ok(s.get(k) !== null, k + ' は常設'); });
});

// ============================================================ 未分類キー

test('未分類キー: 削除せず件数のみ報告し、キー名・値を結果に含めない', function () {
  var now = sec('2030-01-10T13:00:00+09:00');
  var s = memStore({ META_ENV: 'production', ZZZ_SECRETISH: 'do-not-print', HB_UNKNOWN: 'v', OPX: 'v', 'BKX': 'v' });
  var rep = {};
  var removed = Infra.garbageCollect(s, NO_SECRETS, now, H.baseCfg(), rep);
  assert.strictEqual(rep.unclassified, 4);
  assert.strictEqual(s.get('ZZZ_SECRETISH'), 'do-not-print');
  ['HB_UNKNOWN', 'OPX', 'BKX'].forEach(function (k) { assert.strictEqual(s.get(k), 'v', k + ' は削除しない'); });
  var out = JSON.stringify({ removed: removed, rep: rep });
  assert.ok(out.indexOf('ZZZ_SECRETISH') === -1 && out.indexOf('do-not-print') === -1);
});

// ============================================================ 既存回収（変更しない）の保護確認

test('IALERT: 未送達は期限後も保持、送達済みのみ保持期限後に回収。HB/LOCKFAIL/META_ENV は保護', function () {
  var now = sec('2030-01-10T13:00:00+09:00');
  var old = now - 40 * 86400;
  var s = memStore({
    META_ENV: 'production', LOCKFAIL: '0',
    'IALERT_SENT_-_-': JSON.stringify({ event: { code: 'BOOKING_FROZEN' }, sentAt: old, attempts: 0, lastTryAt: old }),
    'IALERT_PENDING_-_-': JSON.stringify({ event: { code: 'CAPACITY_THRESHOLD_UNSET' }, sentAt: null, attempts: 5, lastTryAt: old })
  });
  var removed = Infra.garbageCollect(s, NO_SECRETS, now, H.baseCfg());
  assert.strictEqual(removed.IALERT, 1);
  assert.strictEqual(s.get('IALERT_SENT_-_-'), null);
  assert.ok(s.get('IALERT_PENDING_-_-'));
  assert.ok(s.get('META_ENV') && s.get('LOCKFAIL') !== null);
});

test('OP/DLV/BK/TRK: 未解決OPとその参照（索引・配送記録・追跡）は期限を過ぎても保持する', function () {
  var now = sec('2030-01-10T13:00:00+09:00');
  var old = now - 400 * 86400;
  var op = { id: 'OPID1', bookingId: 'BK-A', state: S.UNKNOWN, updatedAt: old, deviceId: 'DEV1' };
  var s = memStore({
    OP_OPID1: JSON.stringify(op),
    DLV_OPID1: JSON.stringify({ state: 'PENDING' }),
    BK_BK_A: JSON.stringify({ bookingId: 'BK-A', ops: ['OPID1'], touchedAt: old }),
    'TRK_BK-A': JSON.stringify({ seenAt: old }),
    // OP の無い孤立した配送記録だけを回収する
    DLV_GHOST: JSON.stringify({ state: 'PENDING' })
  });
  var removed = Infra.garbageCollect(s, NO_SECRETS, now, H.baseCfg());
  ['OP_OPID1', 'DLV_OPID1', 'BK_BK_A'].forEach(function (k) { assert.ok(s.get(k), k + ' は保持'); });
  assert.ok(s.get('TRK_BK-A'), '未解決予約の追跡は保持');
  assert.strictEqual(s.get('DLV_GHOST'), null);
  assert.strictEqual(removed.DLV, 1);
  assert.strictEqual(s.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).length, 1, 'garbageCollect は OP_ 自体を削除しない');
});

// ============================================================ sweep 経由・OFF 中・排他

function seed(w) {
  w.props['APICOUNT_20300101'] = '7';   // 古い（回収対象）
  w.props['APICOUNT_20300110'] = '1';   // 当日
  w.props['ZZZ_UNKNOWN'] = 'v';
}

test('sweep: 既存の定期清掃に統合され、APICOUNT 回収件数・未分類件数のみを返す（新トリガー不要）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  seed(w);
  var r = rt.sweepCycle();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed.APICOUNT, 1);
  assert.strictEqual(r.unclassifiedKeys, 1);
  assert.strictEqual(w.props['APICOUNT_20300101'], undefined);
  assert.strictEqual(w.props['APICOUNT_20300110'], '1', '当日分は回収しない');
  assert.strictEqual(w.props['ZZZ_UNKNOWN'], 'v');
  assert.ok(JSON.stringify(r).indexOf('ZZZ_UNKNOWN') === -1);
});

test('OFF 中の sweep: 回収はローカル状態のみで、SwitchBot変更APIを呼ばない・メールを新規に増やさない', function () {
  var w = H.createWorld({ cfg: { enabled: false } });
  var rt = w.runtime();
  seed(w);
  var callsBefore = w.calls.length, mailsBefore = w.mails.length;
  var r = rt.sweepCycle();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.removed.APICOUNT, 1);
  assert.strictEqual(w.props['APICOUNT_20300101'], undefined);
  var mutating = w.calls.slice(callsBefore).filter(function (c) { return !/keyList|list|read/i.test(JSON.stringify(c)); });
  assert.deepStrictEqual(mutating, [], '変更APIは呼ばない');
  assert.strictEqual(w.mails.length, mailsBefore, '未送達通知が無ければメールは増えない');
  assert.strictEqual(w.userMails.length, 0, '利用者向けメール配送は起動しない');
});

test('OFF 中の sweep: 既存動作として未送達の管理者通知(IALERT_)は再送される（#887 は変更しない・文書化のとおり）', function () {
  var w = H.createWorld({ cfg: { enabled: false } });
  var rt = w.runtime();
  seed(w);
  w.props['IALERT_PENDING_-_-'] = JSON.stringify({ event: { code: 'READ_LIMIT' }, sentAt: null, attempts: 0, lastTryAt: 0 });
  var mailsBefore = w.mails.length;
  var r = rt.sweepCycle();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(w.mails.length, mailsBefore + 1, '管理者通知の再送は OFF でも動く（既存仕様）');
  assert.strictEqual(w.userMails.length, 0, '利用者向けメール配送は起動しない');
  assert.strictEqual(r.removed.APICOUNT, 1);
});

test('日次クリーンアップ(HB_CLEANUP)も同じ回収を行い、ロック取得失敗時は何も回収しない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  seed(w);
  w.lockBusy = true;
  var r = rt.dailyCleanupCycle();
  assert.strictEqual(r.error, 'LOCK_UNAVAILABLE');
  assert.strictEqual(w.props['APICOUNT_20300101'], '7', '排他が取れなければ回収しない');
  w.lockBusy = false;
  r = rt.dailyCleanupCycle();
  assert.strictEqual(r.removed.APICOUNT, 1);
  assert.ok(w.props.HB_CLEANUP);
});
