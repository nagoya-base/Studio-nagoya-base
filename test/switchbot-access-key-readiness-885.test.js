/*
 * Issue #885（第3弾）: キー未発行対策のモックテスト。
 *  - 開始15分前からの未発行キー優先再試行
 *  - 開始5分前の緊急通知／開始後のエスカレーション
 *  - 緊急通知の不達検知と再通知
 *  - 同一予約への重複キー発行・重複通知の防止
 *  - 正常な既存キー・他の予約・施行前（FLAG_OFF）への非影響
 * 実API・実機・GASデプロイには接続しない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var H = require('./helpers/switchbot-access-world');
var Infra = H.Infra, Core = H.Core, S = Core.STATE;

var START = H.jst('2030-01-11', '10:00').getTime();     // 既定レコードの利用開始
function setNow(w, minutesBeforeStart, extraSec) { w.nowMs = START - minutesBeforeStart * 60000 + (extraSec || 0) * 1000; }
function ops(w) { return w.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store.get(k)); }); }
function mailsOf(w, code) { return w.mails.filter(function (m) { return m.subject.indexOf(code) !== -1; }); }
function keyMails(w) { return w.mails.filter(function (m) { return /KEY_NOT_ISSUED_/.test(m.subject); }); }
function createCalls(w) { return w.callCount('createKey'); }

/** 容量ゲートで新規発行が止まる状態（Keypad 登録数が停止閾値に達している）。 */
function blockByCapacity(w) { w.preload(H.DEV, 80); }
function unblock(w) { w.keys[H.DEV] = []; }

// ================================================================ 純粋判定

test('段階判定: 開始15分前=PRIORITY／5分前=URGENT／開始=STARTED の境界と、終了後・不正値はNONE', function () {
  var ic = { priorityRetryLeadSec: 900, urgentNoticeLeadSec: 300 };
  var L = Infra.keyReadinessLevel;
  var s = 100000, e = s + 7200;
  assert.strictEqual(L(s - 901, s, e, ic), 'NONE');
  assert.strictEqual(L(s - 900, s, e, ic), 'PRIORITY', '残りちょうど15:00は優先再試行');
  assert.strictEqual(L(s - 301, s, e, ic), 'PRIORITY');
  assert.strictEqual(L(s - 300, s, e, ic), 'URGENT', '残りちょうど5:00は緊急通知');
  assert.strictEqual(L(s - 1, s, e, ic), 'URGENT');
  assert.strictEqual(L(s, s, e, ic), 'STARTED', '開始ちょうどは開始後');
  assert.strictEqual(L(e - 1, s, e, ic), 'STARTED');
  assert.strictEqual(L(e, s, e, ic), 'NONE', '利用終了後は対象外');
  assert.strictEqual(L(NaN, s, e, ic), 'NONE');
  assert.strictEqual(L(s, e, s, ic), 'NONE', '開始>=終了は対象外');
  assert.strictEqual(L(s, 'x', e, ic), 'NONE');
});

test('設定: 閾値が不正（0・負・逆転・非数）なら既定値へ戻し、計画に警告を出す', function () {
  var w = H.createWorld({ cfg: { infra: { priorityRetryLeadSec: 200, urgentNoticeLeadSec: 300 } } });
  assert.deepStrictEqual(
    [w.runtime().plan.warnings.indexOf('KEY_READINESS_LEAD_INVALID') !== -1], [true]);
  var ok = H.createWorld({ cfg: { infra: { priorityRetryLeadSec: 1200, urgentNoticeLeadSec: 240 } } });
  assert.strictEqual(ok.runtime().plan.warnings.indexOf('KEY_READINESS_LEAD_INVALID'), -1);
  var bad = H.createWorld({ cfg: { infra: { priorityRetryLeadSec: -5, urgentNoticeLeadSec: 'x' } } });
  assert.ok(bad.runtime().plan.warnings.indexOf('KEY_READINESS_LEAD_INVALID') !== -1);
});

// ================================================================ 1. 開始15分前の優先再試行

test('優先再試行: 開始まで余裕がある予約は従来どおり観測待ち、開始15分前以内は初回観測で即発行する', function () {
  var far = H.createWorld();
  far.records = [H.record()];
  setNow(far, 120);
  far.runtime().syncCycle();
  assert.strictEqual(createCalls(far), 0, '開始2時間前は従来どおり静穏時間待ち（挙動不変）');

  var near = H.createWorld();
  near.records = [H.record()];
  setNow(near, 14);
  var r = near.runtime().syncCycle();
  assert.strictEqual(createCalls(near), 1, '開始14分前は観測待ちを省いて同じ周期で発行する');
  assert.strictEqual(ops(near)[0].state, S.SENT_WAIT_WEBHOOK);
  assert.strictEqual(r.synced, 1);
  assert.strictEqual(keyMails(near).length, 0, '優先再試行の段階では通知しない');
});

test('優先再試行: 発行ゲート待機（10分）を待たず、開始15分前以内は毎周期再評価する。それ以前は従来の待機を維持', function () {
  // 開始15分前以降: 容量不足→解消後、次の周期（60秒後）で発行
  var near = H.createWorld();
  near.records = [H.record()];
  blockByCapacity(near);
  setNow(near, 14);
  var rt = near.runtime();
  var r1 = rt.syncCycle();
  assert.deepStrictEqual(Array.from(r1.gateStops), ['CAPACITY_REACHED']);
  assert.strictEqual(createCalls(near), 0);
  unblock(near);
  near.advance(60);
  rt.syncCycle();
  assert.strictEqual(createCalls(near), 1, '60秒後の周期で再評価されて発行');

  // 開始まで余裕: 従来どおり gateRetrySec(600) 内は再評価しない
  var far = H.createWorld();
  far.records = [H.record()];
  blockByCapacity(far);
  setNow(far, 120);
  var rt2 = far.runtime();
  rt2.syncCycle(); far.advance(300); rt2.syncCycle();
  unblock(far);
  far.advance(60);
  rt2.syncCycle();
  assert.strictEqual(createCalls(far), 0, '開始まで余裕がある予約のゲート待機は不変');
});

test('優先再試行: 処理順は「開始が近い未発行」が先頭（実行時間の上限で繰り延べられても取り残さない）', function () {
  var w = H.createWorld();
  var far = H.record({ bookingId: 'SNB-FAR', startAt: H.jst('2030-01-12', '10:00'), endAt: H.jst('2030-01-12', '12:00'), confirmedAt: H.jst('2030-01-05', '10:05') });
  var near = H.record({ bookingId: 'SNB-NEAR' });
  w.records = [far, near];                 // 台帳の並びは遠い予約が先
  w.recipients['SNB-FAR'] = 'a@example.test';
  setNow(w, 14);
  // 1件目の処理で実行時間の上限を超えたことにする（台帳読取の直後に時計を進める）
  var origRead = w.ledger.read;
  w.ledger.read = function (ctx) { var r = origRead(ctx); w.advance(0); return r; };
  var rt = w.runtime({ infra: { runBudgetSec: 240 } });
  var order = [];
  var origCreate = w.api.createKey;
  w.api.createKey = function (p) { var r = origCreate(p); order.push('created'); w.advance(500); return r; };
  var out = rt.syncCycle();
  assert.strictEqual(order.length, 1);
  var created = ops(w);
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].bookingId, 'SNB-NEAR', '近い予約が先に処理される');
  assert.ok(out.deferred >= 1, '残りは次周期へ繰り延べ');
});

// ================================================================ 2. 開始5分前の緊急通知

test('緊急通知: 開始6分前は通知せず、5分前から1件だけ通知する（コード・予約参照のみ。暗証番号・個人情報なし）', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  blockByCapacity(w);                       // 発行できない状態が続く
  setNow(w, 7);
  var rt = w.runtime();
  rt.syncCycle();
  setNow(w, 6);
  rt.syncCycle();
  assert.strictEqual(keyMails(w).length, 0, '開始6分前までは通知しない');

  setNow(w, 5);
  var r = rt.syncCycle();
  assert.strictEqual(keyMails(w).length, 1, '開始5:00前で緊急通知');
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1);
  assert.strictEqual(r.keyReadiness.urgent, 1);
  var m = keyMails(w)[0];
  assert.ok(m.body.indexOf('SNB-1') !== -1, '予約参照を含む');
  assert.ok(/代替入室/.test(m.body), '代替入室の案内を含む');
  assert.ok(!/guest@example\.test/.test(m.subject + m.body), '個人情報を含まない');
  assert.ok(!/\b\d{8}\b/.test(m.subject + m.body), '8桁の暗証番号を含まない');

  // 重複通知防止: 以後の周期でも増えない
  for (var i = 0; i < 4; i++) { w.advance(60); rt.syncCycle(); }
  assert.strictEqual(keyMails(w).length, 1, '同一予約・同一revisionへの緊急通知は重複しない');
});

test('緊急通知: 開始後も未発行なら別コードで1回だけエスカレーションする', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  blockByCapacity(w);
  var rt = w.runtime();
  setNow(w, 4); rt.syncCycle();
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1);
  setNow(w, 0, 1); rt.syncCycle();           // 開始後
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_STARTED').length, 1, '開始後は別コードでエスカレーション');
  for (var i = 0; i < 4; i++) { w.advance(120); rt.syncCycle(); }
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_STARTED').length, 1);
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1);
  assert.strictEqual(createCalls(w), 0, '容量ゲートが開くまで発行しない（強行しない）');
});

test('開始後の安全な再試行: 容量が空けば開始後でも未送信の予約は発行される（以後は通知しない）', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  blockByCapacity(w);
  var rt = w.runtime();
  setNow(w, 0, 30); rt.syncCycle();
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_STARTED').length, 1);
  unblock(w);
  w.advance(60); rt.syncCycle();
  assert.strictEqual(createCalls(w), 1, '開始後も安全な範囲（未送信）で再試行して発行');
  var op = ops(w)[0];
  w.advance(10);
  rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN);
  w.advance(60); rt.syncCycle();
  assert.strictEqual(ops(w)[0].state, S.ISSUED_CONFIRMED);
  var before = keyMails(w).length;
  for (var i = 0; i < 3; i++) { w.advance(120); rt.syncCycle(); }
  assert.strictEqual(keyMails(w).length, before, '発行確認後は追加通知しない');
});

test('利用終了後は対象外（通知・再試行しない）', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  blockByCapacity(w);
  w.nowMs = H.jst('2030-01-11', '12:30').getTime();
  w.runtime().syncCycle();
  assert.strictEqual(keyMails(w).length, 0);
  assert.strictEqual(createCalls(w), 0);
});

// ================================================================ 3. 通知失敗の検知と再通知

test('通知不達: 緊急通知の送信が失敗したら短い間隔で再送し、不達を検知して記録する。復旧後は1件だけ届く', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  blockByCapacity(w);
  w.mailFailIf = function (subject) { return /KEY_NOT_ISSUED_/.test(subject); };
  var rt = w.runtime();
  setNow(w, 5);
  var r1 = rt.syncCycle();
  assert.strictEqual(keyMails(w).length, 0, '送信失敗');
  assert.strictEqual(r1.keyReadiness.undelivered, 0, '1回目の失敗ではまだ不達判定しない');

  w.advance(120);                                // 緊急通知の再送上限は2分
  var r2 = rt.syncCycle();
  assert.strictEqual(keyMails(w).length, 0);
  assert.strictEqual(r2.keyReadiness.undelivered, 1, '2回失敗で不達と判定');
  assert.ok(Number(w.props.NOTIFYFAIL) > 0, '通知失敗の開始時刻を記録');
  var kr = JSON.parse(w.props.KEYREADY);
  assert.strictEqual(kr.undelivered, 1);
  assert.strictEqual(kr.notReady[0].ref, 'SNB-1');
  var st = rt.admin('status', {});
  assert.strictEqual(st.keyReadiness.undelivered, 1, '状態表示から不達を確認できる');
  assert.ok(st.notifyOutbox.pending >= 1);

  w.mailFailIf = null;                           // メール復旧
  w.advance(120);                                // 再送の待機は最大2分
  rt.syncCycle();
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1, '復旧後に再通知される');
  for (var i = 0; i < 3; i++) { w.advance(10); rt.syncCycle(); }    // まだ開始前
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1, '再通知は1件のみ（重複しない）');
  assert.strictEqual(JSON.parse(w.props.KEYREADY).undelivered, 0, '届いたら不達は解消');
});

test('通知不達: 一般通知の再送間隔・不達判定は変えない（緊急通知だけ短縮）', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  w.mailFail = true;
  var rt = w.runtime();
  rt.infraAlert('SYNC_ERROR', 'SNB-1', 1, null);
  var key = w.store.keys().filter(function (k) { return k.indexOf('IALERT_SYNC_ERROR') === 0; })[0];
  assert.strictEqual(JSON.parse(w.props[key]).attempts, 1);
  w.advance(100);                                 // 一般通知の待機は 60*2^1=120 秒
  rt.infraAlert('SYNC_ERROR', 'SNB-1', 1, null);
  assert.strictEqual(JSON.parse(w.props[key]).attempts, 1, '一般通知は120秒待つ（従来どおり）');
  w.advance(30);
  rt.infraAlert('SYNC_ERROR', 'SNB-1', 1, null);
  assert.strictEqual(JSON.parse(w.props[key]).attempts, 2);
});

test('通知不達: 監視ジョブ（watchdog）も緊急通知を再送し、2回失敗で不達として記録する', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  blockByCapacity(w);
  w.mailFailIf = function (subject) { return /KEY_NOT_ISSUED_/.test(subject); };
  var rt = w.runtime();
  setNow(w, 4); rt.syncCycle();
  w.advance(150); var wd = rt.watchdog();
  assert.ok(wd.outbox.failing >= 1, '緊急通知は少ない失敗回数で不達扱い');
  assert.ok(Number(w.props.NOTIFYFAIL) > 0);
});

// ================================================================ 4. 重複キー発行の防止

test('重複防止: 送信結果が不明（UNKNOWN）の鍵は再送せず、緊急通知だけを出す', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  var orig = w.api.createKey;
  w.api.createKey = function (p) { w.calls.push({ name: 'createKey', device: p.deviceId }); throw new Error('NETWORK'); };
  var rt = w.runtime();
  setNow(w, 14); rt.syncCycle();
  assert.strictEqual(createCalls(w), 1);
  assert.strictEqual(ops(w)[0].state, S.UNKNOWN);
  for (var i = 0; i < 16; i++) { w.advance(60); rt.syncCycle(); }  // 開始5分前を過ぎ、開始も過ぎる
  assert.strictEqual(createCalls(w), 1, 'UNKNOWN の予約へ createKey を再送しない（二重発行しない）');
  assert.strictEqual(ops(w).length, 1, '同一予約に OP は1件のまま');
  assert.ok(mailsOf(w, 'KEY_NOT_ISSUED_').length >= 1, '時刻が迫れば緊急通知は出る');
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1);
  w.api.createKey = orig;
});

test('重複防止: 明確に拒否された（FAILED）鍵も自動では再発行しない。緊急通知で運営者へ', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  w.api.createKey = function (p) { w.calls.push({ name: 'createKey', device: p.deviceId }); return { httpCode: 400, parsed: { statusCode: 400 } }; };
  var rt = w.runtime();
  setNow(w, 14); rt.syncCycle();
  assert.strictEqual(ops(w)[0].state, S.FAILED);
  for (var i = 0; i < 16; i++) { w.advance(60); rt.syncCycle(); }
  assert.strictEqual(createCalls(w), 1, '拒否された鍵を自動で繰り返し送らない');
  assert.strictEqual(ops(w).length, 1);
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1);
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_STARTED').length, 1);
});

test('重複防止: 発行中（SENT_WAIT_WEBHOOK）の予約を毎周期呼んでも createKey は1回、完了後は追加の鍵を作らない', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  var rt = w.runtime();
  setNow(w, 14); rt.syncCycle();
  var op = ops(w)[0];
  assert.strictEqual(op.state, S.SENT_WAIT_WEBHOOK);
  w.advance(10);
  rt.syncCycle(); rt.syncCycle();
  assert.strictEqual(createCalls(w), 1);
  rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN);
  w.advance(30); rt.syncCycle();
  assert.strictEqual(ops(w)[0].state, S.ISSUED_CONFIRMED);
  for (var i = 0; i < 6; i++) { w.advance(60); rt.syncCycle(); }
  assert.strictEqual(createCalls(w), 1);
  assert.strictEqual(w.callCount('deleteKey'), 0);
  assert.strictEqual(w.keys[H.DEV].length, 1);
});

// ================================================================ 5. 既存・他予約への非影響

test('非影響: 発行確認済みの正常なキーは、開始直前・開始後でも通知・削除・再発行されない', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  var rt = w.runtime();
  setNow(w, 60); rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = ops(w)[0];
  w.advance(10);
  rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN);
  w.advance(60); rt.syncCycle();
  assert.strictEqual(ops(w)[0].state, S.ISSUED_CONFIRMED);
  var keysBefore = JSON.stringify(w.keys);
  var creates = createCalls(w);
  [10, 6, 4, 1].forEach(function (min) { setNow(w, min); rt.syncCycle(); });
  setNow(w, 0, 600); rt.syncCycle();
  assert.strictEqual(keyMails(w).length, 0, '発行確認済みなら緊急通知しない');
  assert.strictEqual(createCalls(w), creates);
  assert.strictEqual(w.callCount('deleteKey'), 0);
  assert.strictEqual(JSON.stringify(w.keys), keysBefore, '個別キーを変更しない');
  assert.strictEqual(w.props.KEYREADY, undefined, '未発行が無ければ状態を書かない');
});

test('非影響: 別の予約が未発行で通知・再試行の対象でも、発行済みの予約のキーには何もしない', function () {
  var w = H.createWorld();
  var a = H.record({ bookingId: 'SNB-A', endAt: H.jst('2030-01-11', '14:00') });
  var b = H.record({ bookingId: 'SNB-B', startAt: H.jst('2030-01-11', '11:30'), endAt: H.jst('2030-01-11', '13:00') });
  w.records = [a];
  var rt = w.runtime();
  setNow(w, 60); rt.syncCycle(); w.advance(300); rt.syncCycle();
  var opA = ops(w)[0];
  w.advance(10); rt.handleWebhook(H.webhook({ commandId: opA.commandId }), H.TOKEN, H.TOKEN);
  w.advance(60); rt.syncCycle();
  assert.strictEqual(ops(w)[0].state, S.ISSUED_CONFIRMED);

  w.records = [a, b];
  w.preload(H.DEV, 79);                                // A の1件と合わせて停止閾値(80)に達し、B の新規発行だけ止まる
  var keysA = w.keys[H.DEV].filter(function (k) { return k.name === opA.name; });
  assert.strictEqual(keysA.length, 1);
  w.nowMs = H.jst('2030-01-11', '11:26').getTime();    // A は利用中、B は開始4分前
  var r = rt.syncCycle();
  var urgent = mailsOf(w, 'KEY_NOT_ISSUED_URGENT');
  assert.strictEqual(urgent.length, 1);
  assert.ok(urgent[0].body.indexOf('SNB-B') !== -1, '未発行の B が通知される');
  assert.ok(urgent[0].body.indexOf('SNB-A') === -1, '発行済みの A は通知されない');
  assert.strictEqual(r.keyReadiness.urgent, 1);
  assert.deepStrictEqual(w.keys[H.DEV].filter(function (k) { return k.name === opA.name; }), keysA, 'A のキーは変更されない');
  assert.strictEqual(w.callCount('deleteKey'), 0);
  assert.strictEqual(createCalls(w), 1, 'createKey は A の1回だけ（B は容量ゲートで止まったまま）');
});

test('非影響: 施行前（ACCESS 機能フラグOFF）は何も呼ばず、通知も状態も書かない', function () {
  var w = H.createWorld({ cfg: { enabled: false } });
  w.records = [H.record()];
  setNow(w, 3);
  var r = w.runtime().syncCycle();
  assert.strictEqual(r.skipped, 'FLAG_OFF');
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(w.mails.length, 0);
  assert.strictEqual(w.props.KEYREADY, undefined);
});

test('非影響: 発行対象外の予約（限定稼働の対象外・対象外ブランド・凍結中）には通知も再試行もしない', function () {
  // 限定稼働: 対象は SNB-PILOT のみ
  var w = H.createWorld({ cfg: { limitedRollout: true, pilotBookingIds: ['SNB-PILOT'] } });
  w.records = [H.record({ bookingId: 'SNB-OTHER' })];
  setNow(w, 3);
  w.runtime().syncCycle();
  assert.strictEqual(createCalls(w), 0);
  assert.strictEqual(keyMails(w).length, 0);

  // 対象外ブランド
  var w2 = H.createWorld();
  w2.records = [H.record({ brand: 'mens' })];
  setNow(w2, 3);
  w2.runtime().syncCycle();
  assert.strictEqual(createCalls(w2), 0);
  assert.strictEqual(keyMails(w2).length, 0);

  // 凍結（支払確認が未了）: 鍵操作は止まったまま。緊急通知ではなく既存の凍結通知
  var w3 = H.createWorld();
  w3.records = [H.record({ paymentStatus: '', paymentConfirmedAt: '' })];
  setNow(w3, 3);
  w3.runtime().syncCycle();
  assert.strictEqual(createCalls(w3), 0);
  assert.strictEqual(keyMails(w3).length, 0);
});

test('非影響: 取消済み・期限切れの予約には通知しない', function () {
  var w = H.createWorld();
  w.records = [H.record({ status: 'CANCELLED' })];
  setNow(w, 3);
  w.runtime().syncCycle();
  assert.strictEqual(keyMails(w).length, 0);
  assert.strictEqual(createCalls(w), 0);
});

// ================================================================ 6. API予算超過など同期できない周期

test('同期不能でも未発行の緊急通知は出す: API 予算超過の周期（鍵は触らない）', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  var rt = w.runtime();
  var day = new Date((w.sec() + 9 * 3600) * 1000);
  setNow(w, 4);
  day = new Date((w.sec() + 9 * 3600) * 1000);
  var key = 'APICOUNT_' + day.getUTCFullYear() + ('0' + (day.getUTCMonth() + 1)).slice(-2) + ('0' + day.getUTCDate()).slice(-2);
  w.props[key] = '999999';
  var r = rt.syncCycle();
  assert.strictEqual(r.error, 'API_BUDGET_EXHAUSTED');
  assert.strictEqual(createCalls(w), 0, '予算超過では鍵を作らない');
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1, '未発行の緊急通知は予算超過でも届く');
});

// ================================================================ 7. 予約変更時の整合

test('改訂が進んだ予約は、新しい revision ごとに未発行を判定する（旧 revision の通知とは別管理）', function () {
  var w = H.createWorld();
  w.records = [H.record({ revision: 1 })];
  blockByCapacity(w);
  var rt = w.runtime();
  setNow(w, 4); rt.syncCycle();
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 1);
  w.records = [H.record({ revision: 2 })];
  w.advance(60); rt.syncCycle();
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 2, '新しい revision は別の予約状態として通知');
  for (var i = 0; i < 3; i++) { w.advance(60); rt.syncCycle(); }
  assert.strictEqual(mailsOf(w, 'KEY_NOT_ISSUED_URGENT').length, 2);
});

// ================================================================ 8. 通知内容の秘匿

test('通知内容: 件名・本文に暗証番号・完全な端末ID・個人情報を含めない（固定分類のみ）', function () {
  var w = H.createWorld();
  w.records = [H.record()];
  blockByCapacity(w);
  var rt = w.runtime();
  setNow(w, 4); rt.syncCycle();
  setNow(w, 0, 5); rt.syncCycle();
  var all = JSON.stringify(w.mails);
  assert.strictEqual(keyMails(w).length, 2);
  assert.ok(all.indexOf(H.DEV) === -1, '完全な端末IDを含まない');
  assert.ok(!/guest@example\.test/.test(all));
  w.createdPasswords.forEach(function (pw) { assert.ok(all.indexOf(pw) === -1); });
});
