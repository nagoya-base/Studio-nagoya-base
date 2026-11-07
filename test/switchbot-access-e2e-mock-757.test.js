/*
 * Issue #757（棚卸し M1〜M6）: 予約連携の「連鎖」をフェイクだけで1本通すモック結合テスト。
 * 実API・実機・実Spreadsheet・実メールには一切接続しない（フェイク world のみ）。秘密・実IDなし。
 *
 * 位置づけ: モック成功であり、37DD/01FDの実機成功やデプロイ・本番有効化の証跡ではない。
 *  - 台帳は w.records の直接差し替え（フェイク）。Booking Web App/Admin → 台帳 → 独立GAS の実接続は検証していない。
 *  - 反映遅延・ジョブ周期・配送時間はフェイク値／設計値で、実機のSLAではない。期限後の deleteKey が実機で効くことも未証明。
 * 本ファイルは既存挙動を変えず、設計値（周期・読取回数）が連鎖全体で成立するかを数値で固定する。
 *
 *  M1 E2E連鎖（確定→発行→配送→延長→取消／期限→削除）を1本通す
 *  M2 削除反映遅延（0〜15分）× commandIdなし削除の確認 → UNKNOWNに落ちる境界
 *  M3 入室中延長のタイムライン（commit→旧失効→新発行→新コード到着）と60分締切への余裕
 *  M4 取消と遅延確定イベントの競合／延長締切は予約側(#759)の既存テストが境界を網羅（ここでは連鎖の余裕で確認）
 *  M5 フラグOFF＝ロールバック回帰（変更API再送ゼロ・管理者経路は利用可）
 *  M6 配送抑止（取消／旧改訂／期限切れ後は旧コードを送らない）と結果不明時の無条件再送なし
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var H = require('./helpers/switchbot-access-world');
var Core = H.Core, S = Core.STATE, D = Core.DLV;

var PW8 = /(?:^|[^0-9])([0-9]{8})(?:[^0-9]|$)/;
var SYNC_SEC = 300, DELIVER_SEC = 300, SWEEP_SEC = 3600, WATCHDOG_SEC = 900;

// ---------------------------------------------------------------- シミュレータ

function mailWorld(cfgOver) {
  var w = H.createWorld({ mail: true, cfg: Object.assign({ deliveryConfigured: true, delivery: H.DELIVERY_CFG }, cfgOver || {}) });
  // 実機の観測に合わせる: 発行・削除ともcommandIdなし（37DDの全試験で観測）
  w.createMode = 'noCommandId';
  w.deleteMode = 'noCommandId';
  // 通常キー（保全対象）。通常キーはどの経路でも変更されないこと
  w.preload(H.DEV, 2);
  return w;
}
function at(w, iso) { w.nowMs = Date.parse(iso); }
function ops(w) {
  return w.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store.get(k)); });
}
function opsOf(w, state) { return ops(w).filter(function (o) { return o.state === state; }); }
function dlv(w, op) { var v = w.store.get('DLV_' + op.id); return v ? JSON.parse(v) : null; }
function normalKeys(w) { return w.keys[H.DEV].filter(function (k) { return /^USER-/.test(k.name); }); }
function serviceKeys(w) { return w.keys[H.DEV].filter(function (k) { return !/^USER-/.test(k.name); }); }

/**
 * 時間主導トリガーの周期（sync/deliver 300秒、sweep 3600秒、watchdog 900秒）を再現して時間を進める。
 * 10秒刻みで進め、各ジョブは自分の周期で1回ずつ走る。変更APIを呼ぶのは sync / deliver / admin のみ。
 * hook(w, elapsedSec) は各刻みの後に呼ばれる（遅延反映の模擬や記録用）。
 */
function createSim(w, rt) {
  var t = { sync: 0, deliver: 0, sweep: 0, watchdog: 0 };
  return {
    run: function (sec, hook) {
      for (var e = 10; e <= sec; e += 10) {
        w.advance(10);
        ['sync', 'deliver', 'sweep', 'watchdog'].forEach(function (j) { t[j] += 10; });
        if (t.sync >= SYNC_SEC) { t.sync = 0; rt.syncCycle(); }
        if (t.deliver >= DELIVER_SEC) { t.deliver = 0; rt.deliverCycle(); }
        if (t.sweep >= SWEEP_SEC) { t.sweep = 0; rt.sweepCycle(); }
        if (t.watchdog >= WATCHDOG_SEC) { t.watchdog = 0; rt.watchdog(); }
        if (hook) hook(w, e);
      }
    }
  };
}

/**
 * 時間ベースの削除反映遅延を差し込む。deleteKey 受理後、latencySec 経過するまで keyList に残す。
 * 最初の1回の deleteKey のみ対象（再送は検知して数える）。
 */
function installDeleteLatency(w, latencySec) {
  var pending = [];
  var origList = w.api.listDevices;
  var origDelete = w.api.deleteKey;
  w.deleteSent = [];
  w.api.deleteKey = function (dev, id) {
    var keep = w.keys[dev].slice();
    var res = origDelete(dev, id);          // 即時反映する既存フェイクを呼び、
    w.keys[dev] = keep;                     // いったん元に戻して遅延反映にする
    pending.push({ dev: dev, id: id, applyAtMs: w.nowMs + latencySec * 1000 });
    w.deleteSent.push({ atMs: w.nowMs, id: id });
    return res;
  };
  w.api.listDevices = function () {
    pending = pending.filter(function (p) {
      if (w.nowMs >= p.applyAtMs) { w.keys[p.dev] = w.keys[p.dev].filter(function (k) { return k.id !== p.id; }); return false; }
      return true;
    });
    return origList();
  };
  w.applyPendingDeletes = function () { w.api.listDevices(); };
}

/** 確定予約の発行〜反映確認まで（commandIdなし経路）。現在時刻は前日13:00 JST 付近で開始。 */
function issueViaCycles(w, rt, sim) {
  w.records = [H.record()];
  sim.run(SYNC_SEC * 2 + 60);                // 観測（静穏）→ 発行 → 反映確認の読取まで
  var op = opsOf(w, S.ISSUED_CONFIRMED)[0];
  assert.ok(op, '発行反映確認済み');
  return op;
}

// ================================================================ M1: E2E連鎖

test('M1-a: 確定→発行→(18:00)別メール配送→延長で旧キー削除→新キー発行→新コード再案内→取消で削除。通常キーは不変', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var normalBefore = JSON.stringify(normalKeys(w));

  // 確定→発行。18:00前は配送されない
  var op1 = issueViaCycles(w, rt, sim);
  assert.strictEqual(w.callCount('createKey'), 1);
  assert.strictEqual(w.userMails.length, 0, '18:00前は案内メールなし');
  assert.strictEqual(serviceKeys(w).length, 1);

  // 前日18:00 JST 以降に1通だけ配送（予約確認メールとは別）
  at(w, '2030-01-10T18:00:00+09:00');
  sim.run(DELIVER_SEC + 10);
  assert.strictEqual(w.userMails.length, 1);
  assert.strictEqual(dlv(w, op1).state, D.DELIVERED);

  // 当日に入室中延長（12:00→13:00、revision 2）。旧キーを削除してから新キーを発行する
  at(w, '2030-01-11T10:30:00+09:00');
  w.records = [H.record({ endAt: H.jst('2030-01-11', '13:00'), revision: 2 })];
  sim.run(3600);
  var oldRec = ops(w).filter(function (o) { return o.id === op1.id; })[0];
  assert.ok([S.DELETED_CONFIRMED, S.ALREADY_ABSENT].indexOf(oldRec.state) !== -1, '旧キーは削除確認済み: ' + oldRec.state);
  var cur = opsOf(w, S.ISSUED_CONFIRMED);
  assert.strictEqual(cur.length, 1, '有効な運用キーは1件だけ');
  assert.strictEqual(cur[0].revision, 2);
  assert.strictEqual(w.callCount('createKey'), 2);
  assert.strictEqual(w.callCount('deleteKey'), 1);
  assert.strictEqual(serviceKeys(w).length, 1, '機器上の運用キーは常に新しい1件のみ');
  assert.strictEqual(w.userMails.length, 2, '新コードを別メールで再案内（合計2通）');
  assert.ok(w.userMails[1].body.indexOf(w.createdPasswords[1]) !== -1);
  assert.ok(w.userMails[1].body.indexOf(w.createdPasswords[0]) === -1, '再案内に旧コードを含めない');

  // 取消（revision 3）→ 新キー削除・以降の配送なし
  w.records = [H.record({ endAt: H.jst('2030-01-11', '13:00'), revision: 3, status: 'CANCELLED' })];
  sim.run(3600);
  assert.strictEqual(serviceKeys(w).length, 0, '取消後に運用キーは残らない');
  assert.strictEqual(w.callCount('deleteKey'), 2);
  assert.strictEqual(w.callCount('createKey'), 2, '取消で新規発行しない');
  assert.strictEqual(w.userMails.length, 2, '取消後の追加配送なし');

  // 通常キーは一切変更されない／管理者通知にコードを載せない
  assert.strictEqual(JSON.stringify(normalKeys(w)), normalBefore);
  w.calls.filter(function (c) { return c.name === 'deleteKey'; }).forEach(function (c) { assert.ok(!/^U\d$/.test(c.id), '通常キーIDを削除していない'); });
  assert.strictEqual(w.mails.filter(function (m) { return PW8.test(m.body); }).length, 0);
});

test('M1-b: 利用終了＋猶予後、台帳に予約が残る間は sync が期限切れキーを削除確認まで進める（ALREADY_ENDED）。配送は行わない', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op = issueViaCycles(w, rt, sim);
  at(w, '2030-01-11T12:20:00+09:00'); // 終了12:00＋猶予15分を過ぎる
  sim.run(3600);
  var cur = ops(w).filter(function (o) { return o.id === op.id; })[0];
  // 実機未検証の設計挙動: 期限切れでも台帳照合(sync)が削除対象にする → deleteKey が期限後に1回送られる（API予算・容量に影響）
  assert.strictEqual(cur.state, S.DELETED_CONFIRMED);
  assert.strictEqual(w.callCount('deleteKey'), 1);
  assert.strictEqual(serviceKeys(w).length, 0);
  assert.strictEqual(w.userMails.length, 0, '期限後に案内しない');
  assert.strictEqual(normalKeys(w).length, 2);
});

test('M1-c: sweep単独（台帳照合が動かない状況）では期限切れを回収する(#829)。OFF時は EXPIRED＋通知のみ、機器側失効ならアーカイブ', function () {
  // ON: 期限後の sweep が運用キーだけを自動削除し、通常キーは残す（管理者通知なし）
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op = issueViaCycles(w, rt, sim);
  at(w, '2030-01-11T12:20:00+09:00');
  rt.sweepCycle();                       // syncCycle は回さない
  var cur = ops(w).filter(function (o) { return o.id === op.id; })[0];
  assert.strictEqual(cur.state, S.DELETED_CONFIRMED);
  assert.strictEqual(w.callCount('deleteKey'), 1);
  assert.ok(!w.mails.some(function (m) { return /EXPIRED_KEY_REMAINS/.test(m.subject); }), '自動回収できたので管理者へ通知しない');
  assert.strictEqual(serviceKeys(w).length, 0);
  assert.strictEqual(normalKeys(w).length, 2);
  rt.sweepCycle(); rt.sweepCycle();
  assert.strictEqual(w.callCount('deleteKey'), 1, '二重削除しない');

  // OFF: 変更 API を呼ばず、残存を通知のみ
  var w2 = mailWorld(); var rt2 = w2.runtime(); var sim2 = createSim(w2, rt2);
  var op2 = issueViaCycles(w2, rt2, sim2);
  at(w2, '2030-01-11T12:20:00+09:00');
  var off = w2.runtime({ enabled: false });
  off.sweepCycle();
  assert.strictEqual(ops(w2).filter(function (o) { return o.id === op2.id; })[0].state, S.EXPIRED);
  assert.ok(w2.mails.some(function (m) { return /EXPIRED_KEY_REMAINS/.test(m.subject); }), '残存を管理者へ通知');
  assert.strictEqual(w2.callCount('deleteKey'), 0, 'OFF 中は削除を送らない');
  // 機器側が期限で失効させた想定: keyListから消える → 次のsweepでアーカイブ
  w2.keys[H.DEV] = w2.keys[H.DEV].filter(function (k) { return /^USER-/.test(k.name); });
  w2.advance(SWEEP_SEC);
  off.sweepCycle();
  assert.strictEqual(ops(w2).filter(function (o) { return o.id === op2.id; })[0].state, S.ARCHIVED_EXPIRED);
  assert.strictEqual(w2.callCount('deleteKey'), 0);
  assert.strictEqual(normalKeys(w2).length, 2);
});

test('#829 日次クリーンアップ: 1時間sweepの取り残しも期限切れだけ回収し、実行記録(HB)を残す。未来予約は消さない', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op = issueViaCycles(w, rt, sim);
  at(w, '2030-01-11T11:50:00+09:00');    // 利用中（期限前）
  var r0 = rt.dailyCleanupCycle();
  assert.strictEqual(r0.ok, true);
  assert.strictEqual(w.callCount('deleteKey'), 0, '期限前は削除しない');
  at(w, '2030-01-12T00:15:00+09:00');    // 翌日 00:15 JST 近辺
  var r1 = rt.dailyCleanupCycle();
  assert.strictEqual(r1.autoDeleted, 1);
  assert.strictEqual(ops(w).filter(function (o) { return o.id === op.id; })[0].state, S.DELETED_CONFIRMED);
  rt.dailyCleanupCycle();
  assert.strictEqual(w.callCount('deleteKey'), 1, '二重実行でも二重削除しない');
  assert.strictEqual(normalKeys(w).length, 2);
  var st = rt.admin('status', {});
  assert.ok(st.heartbeats.CLEANUP && st.heartbeats.CLEANUP.ok === true, '日次実行の証跡を管理者が確認できる');
});

test('#829 台帳が読めなくても、日次/時間sweepが送った削除の反映確認は5分周期で進み、読取期限内に確定する', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op = issueViaCycles(w, rt, sim);
  installDeleteLatency(w, 300);          // 反映に5分かかる（commandIdなし）
  w.ledgerFail = 'LEDGER_READ_FAILED';   // 台帳照合が失敗し続ける状況
  at(w, '2030-01-12T00:15:00+09:00');
  rt.dailyCleanupCycle();                // 期限切れキーの削除を送信（直後はまだ keyList に残る）
  assert.strictEqual(ops(w).filter(function (o) { return o.id === op.id; })[0].state, S.DELETE_SENT);
  sim.run(1800);                         // 1時間sweepを待たず、同期ジョブ(5分)が台帳に依存せず照合する
  var cur = ops(w).filter(function (o) { return o.id === op.id; })[0];
  assert.strictEqual(cur.state, S.DELETED_CONFIRMED);
  assert.strictEqual(w.callCount('deleteKey'), 1, '再送しない');
  assert.strictEqual(normalKeys(w).length, 2);
});

// ================================================================ M2: 削除反映遅延の境界

function cancelWithLatency(latencySec) {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op = issueViaCycles(w, rt, sim);
  installDeleteLatency(w, latencySec);
  w.records = [H.record({ revision: 2, status: 'CANCELLED' })];
  sim.run(3600);
  var cur = ops(w).filter(function (o) { return o.id === op.id; })[0];
  return { w: w, rec: cur };
}

test('M2: 削除反映遅延ごとの結果（commandIdなし）。deleteKey は常に1回のみ（再送ゼロ）', function () {
  var results = {};
  [0, 120, 300, 600, 900, 1500].forEach(function (lat) {
    var r = cancelWithLatency(lat);
    results[lat] = r.rec.state;
    assert.strictEqual(r.w.deleteSent.length, 1, '遅延' + lat + '秒でも deleteKey は1回のみ');
    assert.strictEqual(r.w.callCount('deleteKey'), 1);
    assert.strictEqual(normalKeys(r.w).length, 2, '通常キー保全');
  });
  // 設計値の確認: 読取は 送信直後・約5分後・約10分後 の3回。遅延がこの範囲に収まれば確定、超えると UNKNOWN（安全停止）
  assert.strictEqual(results[0], S.DELETED_CONFIRMED);
  assert.strictEqual(results[120], S.DELETED_CONFIRMED);
  assert.strictEqual(results[300], S.DELETED_CONFIRMED);
  assert.strictEqual(results[600], S.DELETED_CONFIRMED, '約10分までは確定（境界）');
  assert.strictEqual(results[900], S.UNKNOWN, '15分遅延は読取上限で UNKNOWN（成功に寄せない）');
  assert.strictEqual(results[1500], S.UNKNOWN);
});

test('M2: UNKNOWN停止後は自動で変更APIを再送しない。管理者の個別確認で反映後に確定できる', function () {
  var r = cancelWithLatency(1500);
  var w = r.w; var rt = w.runtime();
  assert.strictEqual(r.rec.state, S.UNKNOWN);
  assert.ok(w.mails.some(function (m) { return /KEY_REMAINS|READ_LIMIT/.test(m.subject + m.body); }), '管理者通知あり');
  var sent = w.callCount('deleteKey');
  createSim(w, rt).run(3600 * 2);
  assert.strictEqual(w.callCount('deleteKey'), sent, 'ジョブが回り続けても deleteKey を再送しない');
  assert.strictEqual(ops(w).filter(function (o) { return o.id === r.rec.id; })[0].state, S.UNKNOWN);
  w.applyPendingDeletes();               // 機器側の反映が遅れて到着
  var res = rt.admin('reconcile', { recId: r.rec.id });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(w.callCount('deleteKey'), sent, '管理者照合も変更APIは送らない');
});

// ================================================================ M3: 入室中延長のタイムライン

function extensionTimeline(latencySec) {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op1 = issueViaCycles(w, rt, sim);
  at(w, '2030-01-10T18:00:00+09:00'); sim.run(DELIVER_SEC + 10);   // 初回配送
  assert.strictEqual(w.userMails.length, 1);
  // 入室中（利用開始10:00後）、延長締切＝旧終了12:00の60分前(11:00:00)ちょうどに延長をcommit（最も遅く承認される場合）
  at(w, '2030-01-11T11:00:00+09:00');
  installDeleteLatency(w, latencySec);
  var commitMs = w.nowMs;
  w.records = [H.record({ endAt: H.jst('2030-01-11', '13:00'), revision: 2 })];
  var tl = { oldGoneSec: null, newReadySec: null, mailedSec: null };
  var oldKeyId = serviceKeys(w)[0].id;
  sim.run(2 * 3600, function (ww, e) {
    var sec = Math.round((ww.nowMs - commitMs) / 1000);
    if (tl.oldGoneSec === null && !ww.keys[H.DEV].some(function (k) { return k.id === oldKeyId; })) tl.oldGoneSec = sec;
    if (tl.newReadySec === null && opsOf(ww, S.ISSUED_CONFIRMED).some(function (o) { return o.revision === 2; })) tl.newReadySec = sec;
    if (tl.mailedSec === null && ww.userMails.length >= 2) tl.mailedSec = sec;
  });
  tl.op1 = op1; tl.w = w; tl.commitMs = commitMs;
  return tl;
}

test('M3: 入室中延長のタイムライン（遅延0/300/600秒）。締切ちょうど(旧終了60分前)にcommitしても新コードが旧終了前に届く', function () {
  var report = {};
  [0, 300, 600].forEach(function (lat) {
    var tl = extensionTimeline(lat);
    report[lat] = { oldGoneSec: tl.oldGoneSec, newReadySec: tl.newReadySec, mailedSec: tl.mailedSec };
    assert.ok(tl.oldGoneSec !== null && tl.newReadySec !== null && tl.mailedSec !== null, '遅延' + lat + 's: 全段階に到達 ' + JSON.stringify(report[lat]));
    // 旧コード失効後に新コードが利用可能になるまでの空白（入室不能になり得る時間）
    var gap = tl.mailedSec - tl.oldGoneSec;
    if (process.env.M3_PRINT) console.log('M3 lat=' + lat + ' ' + JSON.stringify(report[lat]) + ' gap=' + gap);
    assert.ok(gap >= 0, '新コード案内は旧失効より前に出ない（併存させない設計）');
    // 締切ちょうど(旧終了の60分前)に承認されても、新コード到着が旧終了時刻(12:00)より前に収まる＝入室不能時間が旧終了後に及ばない
    var oldEndMs = H.jst('2030-01-11', '12:00').getTime();
    assert.ok(tl.commitMs + tl.mailedSec * 1000 < oldEndMs,
      '遅延' + lat + 's: 新コード到着 ' + new Date(tl.commitMs + tl.mailedSec * 1000).toISOString() + ' が旧終了 ' + new Date(oldEndMs).toISOString() + ' より前 ' + JSON.stringify(report[lat]));
    assert.strictEqual(tl.w.callCount('deleteKey'), 1);
    assert.strictEqual(tl.w.callCount('createKey'), 2);
  });
  // 実測ではなく設計値による上限の記録（周期5分・静穏60秒・読取3回）。実機値は #756 で置換する
  assert.ok(report[0].mailedSec <= 1200, '遅延なしでも20分以内: ' + JSON.stringify(report[0]));
});

test('M3: 旧キー削除がUNKNOWNで止まると新キーは出ない（旧は削除済み）→ 代替入室が必要な状態を管理者通知で検知できる', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  issueViaCycles(w, rt, sim);
  installDeleteLatency(w, 99999);   // 削除が反映されない
  at(w, '2030-01-11T10:50:00+09:00');
  w.records = [H.record({ endAt: H.jst('2030-01-11', '13:00'), revision: 2 })];
  sim.run(2 * 3600);
  assert.strictEqual(opsOf(w, S.UNKNOWN).length, 1);
  assert.strictEqual(w.callCount('createKey'), 1, '旧キー未確定のまま新キーを発行しない');
  assert.strictEqual(w.callCount('deleteKey'), 1);
  assert.ok(w.mails.some(function (m) { return /OLD_KEY_UNRESOLVED|KEY_REMAINS|READ_LIMIT/.test(m.subject + m.body); }), '管理者に通知（代替入室の判断材料）');
});

// ================================================================ M4: 取消と遅延確定の競合

test('M4: 取消(rev2)の後に古い確定(rev1)の遅延スナップショットが来ても、発行・再削除をしない', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  issueViaCycles(w, rt, sim);
  w.records = [H.record({ revision: 2, status: 'CANCELLED' })];
  sim.run(1800);
  assert.strictEqual(serviceKeys(w).length, 0);
  var cr = w.callCount('createKey'), dl = w.callCount('deleteKey');
  w.records = [H.record({ revision: 1 })];          // 遅延した古い確定
  sim.run(1800);
  assert.strictEqual(w.callCount('createKey'), cr, '取消後の遅延確定で発行しない');
  assert.strictEqual(w.callCount('deleteKey'), dl);
  assert.strictEqual(serviceKeys(w).length, 0);
});

test('M4: 延長を承認するのと同時に取消が入る競合（rev2延長→rev3取消）でも最終的に運用キーは0件で重複発行なし', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  issueViaCycles(w, rt, sim);
  at(w, '2030-01-11T10:50:00+09:00');
  w.records = [H.record({ endAt: H.jst('2030-01-11', '13:00'), revision: 2 })];
  sim.run(SYNC_SEC + 120);                           // 延長を取り込み始めた直後に
  w.records = [H.record({ endAt: H.jst('2030-01-11', '13:00'), revision: 3, status: 'CANCELLED' })];
  sim.run(2 * 3600);
  assert.strictEqual(serviceKeys(w).length, 0, '最終的に運用キーなし');
  assert.ok(w.callCount('createKey') <= 2, '発行は多くても旧+延長の2回');
  assert.strictEqual(opsOf(w, S.ISSUED_CONFIRMED).length, 0);
  assert.strictEqual(normalKeys(w).length, 2);
});

// ================================================================ M5: フラグOFF＝ロールバック回帰

test('M5: フラグOFFでは sync/deliver/sweep/watchdog が変更APIを一切呼ばない。進行中の状態データは失われない', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op = issueViaCycles(w, rt, sim);
  var snapshotKeys = Object.keys(w.props).filter(function (k) { return /^(OP_|BK_|DLV_)/.test(k); }).sort();
  var createN = w.callCount('createKey'), deleteN = w.callCount('deleteKey'), mailN = w.userMails.length;

  // ロールバック: 新しいruntimeを enabled=false で起動（同じ状態ストア）
  var off = w.runtime({ enabled: false });
  w.records = [H.record({ revision: 2, status: 'CANCELLED' })];   // OFF中に取消が入っても
  at(w, '2030-01-10T18:30:00+09:00');
  createSim(w, off).run(3 * 3600);
  assert.strictEqual(w.callCount('createKey'), createN, 'OFFで発行しない');
  assert.strictEqual(w.callCount('deleteKey'), deleteN, 'OFFで削除を送らない（キーは消えない）');
  assert.strictEqual(w.userMails.length, mailN, 'OFFで新コード配送しない');
  assert.strictEqual(serviceKeys(w).length, 1, 'フラグOFFだけでは発行済みキーは消えない');
  var afterKeys = Object.keys(w.props).filter(function (k) { return /^(OP_|BK_|DLV_)/.test(k); }).sort();
  assert.deepStrictEqual(afterKeys, snapshotKeys, 'OP/BK/DLV の状態データを失わない');
  assert.strictEqual(ops(w).filter(function (o) { return o.id === op.id; })[0].state, S.ISSUED_CONFIRMED);
});

test('M5: OFFでも管理者経路（status/inventory/inspect/delete）が使え、削除は1回だけ・通常キーは不変。未認可は拒否', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op = issueViaCycles(w, rt, sim);
  var off = w.runtime({ enabled: false });
  assert.strictEqual(off.admin('status', {}).ok, true);
  assert.strictEqual(off.admin('inventory', {}).ok, true);
  assert.strictEqual(off.admin('inspect', { recId: op.id }).ok, true);
  w.identity = { email: 'stranger@example.test' };
  assert.strictEqual(off.admin('delete', { recId: op.id }).ok, false, '未認可は拒否');
  assert.strictEqual(w.callCount('deleteKey'), 0);
  w.identity = { email: 'owner@example.test' };
  var r = off.admin('delete', { recId: op.id });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(w.callCount('deleteKey'), 1);
  assert.strictEqual(normalKeys(w).length, 2);
  // 復旧（ON）しても同じ record に対して deleteKey を再送しない
  var on = w.runtime({ enabled: true });
  createSim(w, on).run(3600);
  assert.strictEqual(w.callCount('deleteKey'), 1, '再有効化後も再送しない');
});

// ================================================================ M6: 配送抑止と結果不明

test('M6: 取消後・期限切れ後・旧改訂のコードは送らない（配送前に取消／延長で旧record抑止）', function () {
  // 取消後
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  issueViaCycles(w, rt, sim);
  w.records = [H.record({ revision: 2, status: 'CANCELLED' })];
  at(w, '2030-01-10T18:00:00+09:00');
  sim.run(3600);
  assert.strictEqual(w.userMails.length, 0, '取消済みには案内しない');

  // 延長（旧改訂）後: 初回配送前に延長 → 旧コードは送られず、新コードだけ1通
  var w2 = mailWorld(); var rt2 = w2.runtime(); var sim2 = createSim(w2, rt2);
  issueViaCycles(w2, rt2, sim2);
  w2.records = [H.record({ endAt: H.jst('2030-01-11', '13:00'), revision: 2 })];
  at(w2, '2030-01-10T17:00:00+09:00');
  sim2.run(2 * 3600);
  at(w2, '2030-01-10T18:00:00+09:00');
  sim2.run(3600);
  assert.ok(w2.userMails.length <= 1);
  w2.userMails.forEach(function (m) { assert.ok(m.body.indexOf(w2.createdPasswords[0]) === -1, '旧改訂のコードを送らない'); });

  // 期限切れ後
  var w3 = mailWorld(); var rt3 = w3.runtime(); var sim3 = createSim(w3, rt3);
  issueViaCycles(w3, rt3, sim3);
  at(w3, '2030-01-11T13:00:00+09:00');
  sim3.run(3600);
  assert.strictEqual(w3.userMails.length, 0, '利用終了後に案内しない');
});

test('M6: 送信結果不明(UNKNOWN)は自動再送しない。管理者の許可後のみ再送し、再案内(REGUIDE)は上限で拒否', function () {
  var w = mailWorld(); var rt = w.runtime(); var sim = createSim(w, rt);
  var op = issueViaCycles(w, rt, sim);
  w.mailMode = 'throwUnknown';
  at(w, '2030-01-10T18:00:00+09:00');
  sim.run(2 * 3600);
  assert.strictEqual(dlv(w, op).state, D.UNKNOWN);
  assert.strictEqual(w.userMailAttempts, 1, 'ジョブが回り続けても再送しない');
  w.mailMode = 'ok';
  sim.run(3600);
  assert.strictEqual(w.userMailAttempts, 1, '回復しても自動再送しない（管理者判断待ち）');
  // 管理者が届いていないことを確認のうえ再送を許可 → 1通だけ送られる
  assert.strictEqual(rt.admin('resolveDelivery', { recId: op.id, decision: 'ALLOW_RESEND' }).ok, true);
  sim.run(DELIVER_SEC + 10);
  assert.strictEqual(w.userMailAttempts, 2);
  assert.strictEqual(dlv(w, op).state, D.DELIVERED);
  sim.run(3600);
  assert.strictEqual(w.userMailAttempts, 2, '許可は1回分。以後は再送しない');
  // 再案内は上限つき（既定2回）。上限後は拒否
  var results = [];
  for (var i = 0; i < 3; i++) {
    var r = rt.admin('resolveDelivery', { recId: op.id, decision: 'REGUIDE' });
    results.push(r.ok === true ? 'OK' : r.error);
    sim.run(DELIVER_SEC + 10);
  }
  assert.deepStrictEqual(results, ['OK', 'OK', 'REGUIDE_LIMIT']);
  assert.strictEqual(w.userMailAttempts, 4);
});
