/*
 * Issue #893: 個別コードの高速化（a 直前60分の優先処理 / b 同一同期実行内の短時間反映確認 / c 確認直後の即時配送）のモックテスト。
 * 実API・実機・実Spreadsheet・実メールには接続しない。暗証番号・メール・完全deviceIdはすべてダミー。
 * 時間は仮想時計。待機（sleep）は仮想時計を進めるだけで実際には待たない。
 * 「5分以内」を保証するテストではない（Webhook到着時間 W は外部要因）。設計上の目安を計測して診断に出す。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var H = require('./helpers/switchbot-access-world');
var Infra = H.Infra, Core = H.Core, S = Core.STATE, D = Core.DLV;

var START = H.jst('2030-01-11', '10:00').getTime();
var PW8 = /(?:^|[^0-9])([0-9]{8})(?:[^0-9]|$)/;

function setNow(w, minutesBeforeStart, extraSec) { w.nowMs = START - minutesBeforeStart * 60000 + (extraSec || 0) * 1000; }
function ops(w) { return w.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store.get(k)); }); }
function dlvOf(w, op) { var v = w.store.get('DLV_' + op.id); return v ? JSON.parse(v) : null; }
function createCalls(w) { return w.callCount('createKey'); }

/** 高速化の設定を入れた世界。mail=true で暗証番号メールの実配送経路（フェイク）を使う。 */
function fastWorld(o) {
  o = o || {};
  var cfg = Object.assign({ infra: Object.assign({ priorityRetryLeadSec: 3600, inRunConfirmMaxSec: 45 }, o.infra || {}) }, o.mail ? { deliveryConfigured: true, delivery: H.DELIVERY_CFG } : {}, o.cfg || {});
  var w = H.createWorld({ sleep: o.sleep !== false, mail: !!o.mail, cfg: cfg });
  w.records = [H.record()];
  setNow(w, o.minutesBefore === undefined ? 45 : o.minutesBefore);
  return w;
}
/** doPost 相当（別の実行）。同期がロックを保持している間は INBOX へ退避される。 */
function postWebhook(w, other, op) {
  return other.handleWebhook(H.webhook({ commandId: op.commandId, deviceMac: H.DEV }), H.TOKEN, H.TOKEN);
}
function theOp(w) { var l = ops(w); assert.strictEqual(l.length, 1, 'OPは1件'); return l[0]; }
/** 発行直後（sleep 1回目）に Webhook を退避受信として届ける。n 回目の待機後に届けるなら at を指定。 */
function webhookAfterSleep(w, other, at, extra) {
  w.sleepHook = function (n) {
    if (n !== at) return;
    var r = postWebhook(w, other, theOp(w));
    w.lastWebhook = { result: r, atSec: w.sec(), inboxKeys: w.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }) };
    if (extra) extra(w);
  };
}

// ================================================================ 設定

test('設定: inRunConfirmMaxSec は既定0（無効）。負・非数・非有限は0、上限60秒に丸める。inRunDeliver は true のときだけ有効', function () {
  // 設定は plan 経由では見えないため、挙動で確認する（待機の有無・最大秒数）
  function maxWaitSec(infra) {
    var w = fastWorld({ infra: infra });
    var rt = w.runtime();
    rt.syncCycle();
    return w.sleeps.reduce(function (a, b) { return a + b; }, 0) / 1000;
  }
  assert.strictEqual(maxWaitSec({ priorityRetryLeadSec: 3600, inRunConfirmMaxSec: undefined }), 0, '既定は待機しない（挙動不変）');
  [0, -5, 'x', NaN, Infinity, null].forEach(function (v) {
    assert.strictEqual(maxWaitSec({ priorityRetryLeadSec: 3600, inRunConfirmMaxSec: v }), 0, '不正値は無効: ' + String(v));
  });
  assert.ok(maxWaitSec({ priorityRetryLeadSec: 3600, inRunConfirmMaxSec: 20 }) <= 20);
  assert.ok(maxWaitSec({ priorityRetryLeadSec: 3600, inRunConfirmMaxSec: 20 }) > 0);
  var big = maxWaitSec({ priorityRetryLeadSec: 3600, inRunConfirmMaxSec: 9999 });
  assert.ok(big <= 60 && big > 45, '上限60秒へ丸める（待機は60秒を超えない）: ' + big);
});

test('既定（高速化の設定なし）: 待機も同期内配送も起きず、同期結果に inRun を出さない（挙動不変）', function () {
  var w = H.createWorld({ sleep: true, mail: true, cfg: { deliveryConfigured: true, delivery: H.DELIVERY_CFG } });
  w.records = [H.record()];
  setNow(w, 14);
  var rt = w.runtime();
  var r = rt.syncCycle();
  assert.strictEqual(createCalls(w), 1);
  assert.strictEqual(w.sleeps.length, 0, '待機しない');
  assert.strictEqual(r.inRun, undefined);
  assert.strictEqual(w.userMails.length, 0);
});

test('sleep を注入していない実行基盤: 待機を設定しても何もせず、従来どおり次回同期へ（SLEEP_UNAVAILABLE）', function () {
  var w = fastWorld({ sleep: false });
  var r = w.runtime().syncCycle();
  assert.strictEqual(createCalls(w), 1);
  assert.strictEqual(r.inRun.waitSkipped, 'SLEEP_UNAVAILABLE');
  assert.strictEqual(theOp(w).state, S.SENT_WAIT_WEBHOOK);
});

// ================================================================ a. 直前60分の優先処理

test('a: priorityRetryLeadSec=3600 で、開始60:00/59:59 は初回の同期で発行。60:01 は従来の観測待ち。既定900では45分前は待つ', function () {
  var cases = [[3600, 1], [3599, 1], [3601, 0]];
  cases.forEach(function (c) {
    var w = H.createWorld({ cfg: { infra: { priorityRetryLeadSec: 3600 } } });
    w.records = [H.record()];
    w.nowMs = START - c[0] * 1000;
    w.runtime().syncCycle();
    assert.strictEqual(createCalls(w), c[1], '開始' + c[0] + '秒前');
  });
  var def = H.createWorld();
  def.records = [H.record()];
  setNow(def, 45);
  def.runtime().syncCycle();
  assert.strictEqual(createCalls(def), 0, '既定900秒: 45分前は静穏時間待ち（現行条件との互換）');
});

test('a: 優先処理でも確定済み適格予約だけ。承認待ち・決済未完了・返金・取消・利用終了後・対象外ブランドでは鍵を作らない', function () {
  var bad = {
    '承認待ち(PENDING)': { status: 'PENDING' },
    '決済未完了': { paymentStatus: 'unpaid', paymentConfirmedAt: '' },
    '返金済み': { paymentStatus: 'refunded' },
    '取消': { status: 'CANCELLED', revision: 2 },
    '対象外ブランド': { brand: 'unknown_brand' }
  };
  Object.keys(bad).forEach(function (name) {
    var w = fastWorld();
    w.records = [H.record(bad[name])];
    var r = w.runtime().syncCycle();
    assert.strictEqual(createCalls(w), 0, name + ': createKeyしない');
    assert.strictEqual(w.sleeps.length, 0, name + ': 待機しない');
    assert.ok(!r.inRun || r.inRun.pending === 0);
  });
  var ended = fastWorld();
  ended.nowMs = H.jst('2030-01-11', '12:30').getTime() + 16 * 60000; // 利用終了+猶予後
  ended.runtime().syncCycle();
  assert.strictEqual(createCalls(ended), 0, '利用終了後は発行しない');
});

test('a: 3ブランド（SNB／SNB mens／Studio X）すべてで同じ優先処理。ブランドの対象設定は変えない', function () {
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var w = fastWorld({ cfg: {
      eligibleBrands: ['snb', 'mens', 'studio_x'],
      keypads: [{ brand: 'snb', facility: 'main', deviceId: H.DEV }, { brand: 'mens', facility: 'main', deviceId: H.DEV }, { brand: 'studio_x', facility: 'main', deviceId: H.DEV }]
    } });
    w.records = [H.record({ brand: brand })];
    w.runtime().syncCycle();
    assert.strictEqual(createCalls(w), 1, brand);
  });
  var off = fastWorld({ cfg: { eligibleBrands: ['snb'] } });
  off.records = [H.record({ brand: 'mens' })];
  off.runtime().syncCycle();
  assert.strictEqual(createCalls(off), 0, '対象外に設定されたブランドには作らない');
});

test('a: 警告10分・緊急5分の閾値は変わらない。優先処理の拡大では通知しない', function () {
  var w = fastWorld({ minutesBefore: 50 });
  // 発行できない（容量）まま 50分前→開始まで進めても、通知は 10分前から
  w.preload(H.DEV, 80);
  var rt = w.runtime();
  rt.syncCycle();
  assert.strictEqual(w.mails.filter(function (m) { return /KEY_UNCONFIRMED_/.test(m.subject); }).length, 0, '50分前は通知しない');
  setNow(w, 9);
  rt.syncCycle();
  assert.strictEqual(w.mails.filter(function (m) { return /KEY_UNCONFIRMED_WARNING/.test(m.subject); }).length, 1, '10分前以内は警告');
  assert.strictEqual(createCalls(w), 0);
});

// ================================================================ b. 同一同期実行内の短時間反映確認

test('b: 発行→待機中にWebhookが退避受信(INBOX)で届く→drainInboxで取り込み→同じ実行でISSUED_CONFIRMED。createKeyは1回、到着時刻は保たれる', function () {
  var w = fastWorld();
  var rt = w.runtime(), other = w.runtime();
  var arrivalSec = null;
  webhookAfterSleep(w, other, 3, function () { arrivalSec = w.sec(); });
  var t0 = w.nowMs;
  var r = rt.syncCycle();
  assert.strictEqual(createCalls(w), 1);
  assert.strictEqual(w.lastWebhook.result.queued, true, 'ロック保持中のdoPostはINBOXへ退避');
  assert.ok(w.lastWebhook.inboxKeys.length === 1);
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).length, 0, '取り込み後はINBOXが空');
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(r.inRun.confirmed, 1);
  assert.strictEqual(r.inRun.unconfirmed, 0);
  assert.strictEqual(w.sleeps.length, 3);
  assert.ok(w.nowMs - t0 <= 45000, '待機は設定秒数以内');
  var evk = w.store.keys().filter(function (k) { return k.indexOf('EVT_') === 0; })[0];
  assert.strictEqual(JSON.parse(w.store.get(evk)).receivedAtSec, arrivalSec, '受信時刻は到着時刻（取込時刻にしない）');
  assert.strictEqual(w.userMails.length, 0, '配送の設定がなければメールは送らない（反映確認だけ）');
});

test('b: 発行直後にWebhookが着いていれば待機せず確認する（sleep=0回）', function () {
  var w = fastWorld();
  var rt = w.runtime(), other = w.runtime();
  // createKey の応答直後（ロック保持中）にWebhookが着いた状態を再現
  var origCreate = w.api.createKey;
  w.api.createKey = function (p) {
    var res = origCreate(p);
    other.handleWebhook(H.webhook({ commandId: 'CMD' + w.seq, deviceMac: H.DEV }), H.TOKEN, H.TOKEN);
    return res;
  };
  var r = rt.syncCycle();
  assert.strictEqual(w.sleeps.length, 0);
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(r.inRun.confirmed, 1);
});

test('b: 待機の上限内に未着なら従来の次回同期へ戻す。UNKNOWN/FAILEDにせず、createKeyを再送しない。遅れて着いたWebhook（90秒以内）は次回同期で確認できる', function () {
  var w = fastWorld();
  var rt = w.runtime();
  var r = rt.syncCycle();
  assert.strictEqual(createCalls(w), 1);
  assert.strictEqual(r.inRun.unconfirmed, 1);
  assert.ok(w.sleeps.reduce(function (a, b) { return a + b; }, 0) <= 45000);
  assert.strictEqual(theOp(w).state, S.SENT_WAIT_WEBHOOK, '成功扱いにしない');
  assert.strictEqual(theOp(w).reads, 0, 'keyList読取も消費していない');
  // 待機の後（送信から約60秒）にWebhookが着く → 次回同期（5分後）で、到着時刻を根拠に確認
  var other = w.runtime();
  w.advance(15);
  assert.strictEqual(postWebhook(w, other, theOp(w)).accepted, true);
  w.advance(285);
  rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(createCalls(w), 1, '二重にcreateKeyしない');
});

test('b: Webhookが90秒を超えても着かない場合は従来どおり WEBHOOK_TIMEOUT で UNKNOWN＋通知。自動再送しない', function () {
  var w = fastWorld();
  var rt = w.runtime();
  rt.syncCycle();
  w.advance(300);
  rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.UNKNOWN);
  assert.strictEqual(createCalls(w), 1);
  assert.ok(w.mails.some(function (m) { return /WEBHOOK_TIMEOUT/.test(m.subject); }), '管理者へ通知');
  w.advance(300);
  rt.syncCycle();
  assert.strictEqual(createCalls(w), 1, 'UNKNOWNへ自動でcreateKeyを再送しない');
});

test('b: Webhook成功でもkeyListに無い（不一致）なら成功にせずUNKNOWN。待機は打ち切り、メールは送らない', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  var rt = w.runtime(), other = w.runtime();
  webhookAfterSleep(w, other, 2, function () { w.keys[H.DEV] = []; }); // Webhook後にkeyListから消えた状態
  // 注意: フックは Webhook 投入より後に extra を呼ぶため、keyList は取込前に空になる
  var r = rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.UNKNOWN);
  assert.strictEqual(r.inRun.confirmed, 0);
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(createCalls(w), 1);
  assert.ok(w.sleeps.length <= 3, '不一致を検出したら待機を続けない');
});

test('b: Webhook着後のkeyList読取に失敗（API障害）したら、短時間に読取を繰り返さず待機を打ち切って次回同期へ（reads=1）', function () {
  var w = fastWorld();
  var rt = w.runtime(), other = w.runtime();
  var origList = w.api.listDevices;
  w.api.listDevices = function () { if (w.listFail) return { ok: false, error: 'DOWN' }; return origList(); };
  webhookAfterSleep(w, other, 1, function () { w.listFail = true; });
  var r = rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.SENT_WAIT_WEBHOOK);
  assert.strictEqual(theOp(w).reads, 1, '読取を使い切らない（短時間に連打しない）');
  assert.strictEqual(r.inRun.confirmed, 0);
  assert.ok(w.sleeps.length <= 2);
  // 復旧後の次回同期で確認
  w.listFail = false;
  w.advance(60);
  rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(createCalls(w), 1);
});

test('b: 待機はロックを保持するが上限つき。待機中の別ジョブ（同期・配送）はロック取得できず何も実行しない。ロックが取れない同期は発行も待機もしない', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  var rt = w.runtime(), other = w.runtime(), dup = w.runtime();
  var seen = [];
  w.sleepHook = function (n) {
    if (n === 1) { seen.push(dup.syncCycle(), dup.deliverCycle()); }
  };
  rt.syncCycle();
  assert.deepStrictEqual(seen.map(function (x) { return x.error; }), ['LOCK_UNAVAILABLE', 'LOCK_UNAVAILABLE'], '二重実行はロックで排他');
  assert.strictEqual(createCalls(w), 1, '二重のcreateKeyなし');
  var busy = fastWorld();
  busy.lockBusy = true;
  var r = busy.runtime().syncCycle();
  assert.strictEqual(r.error, 'LOCK_UNAVAILABLE');
  assert.strictEqual(createCalls(busy), 0);
  assert.strictEqual(busy.sleeps.length, 0);
  assert.ok(other);
});

test('b: 複数予約を同じ実行で発行しても、待機は合計で上限内。全員のWebhookが着けば全員確認される', function () {
  var w = fastWorld();
  w.records = [
    H.record({ bookingId: 'SNB-1' }),
    H.record({ bookingId: 'SNB-2', startAt: H.jst('2030-01-11', '10:00'), endAt: H.jst('2030-01-11', '11:30') })
  ];
  var rt = w.runtime(), other = w.runtime();
  w.sleepHook = function (n) {
    if (n === 2) ops(w).forEach(function (o) { postWebhook(w, other, o); });
  };
  var r = rt.syncCycle();
  assert.strictEqual(createCalls(w), 2);
  assert.strictEqual(r.inRun.pending, 2);
  assert.strictEqual(r.inRun.confirmed, 2);
  ops(w).forEach(function (o) { assert.strictEqual(o.state, S.ISSUED_CONFIRMED); });
  assert.ok(w.sleeps.reduce(function (a, b) { return a + b; }, 0) <= 45000);
});

test('b: 前回以前に発行した（今回の実行で発行していない）SENT_WAIT_WEBHOOK の鍵は待機の対象にしない', function () {
  var w = fastWorld({ infra: { inRunConfirmMaxSec: 0 } });
  var rt = w.runtime();
  rt.syncCycle(); // 待機なしで発行（従来動作）
  assert.strictEqual(theOp(w).state, S.SENT_WAIT_WEBHOOK);
  var w2 = fastWorld();
  var rt2 = w2.runtime();
  rt2.syncCycle(); // 今回の実行で発行 → 待機して未確認
  w2.sleeps.length = 0;
  w2.advance(60);
  var r = rt2.syncCycle(); // 次回: 既存の鍵は今回の発行ではない
  assert.strictEqual(r.inRun.pending, 0);
  assert.strictEqual(w2.sleeps.length, 0, '次回同期は従来の再照合のみ（待機しない）');
});

test('b: ACCESS_ENABLED=OFF（enabled!==true）では何もしない。FLAG_OFFで待機も発行もない', function () {
  var w = fastWorld({ cfg: { enabled: false } });
  var r = w.runtime().syncCycle();
  assert.strictEqual(r.skipped, 'FLAG_OFF');
  assert.strictEqual(createCalls(w), 0);
  assert.strictEqual(w.sleeps.length, 0);
});

test('b: APIの日次予算が尽きている周期は発行も待機もしない（従来のAPI_BUDGET_EXHAUSTED）', function () {
  var w = fastWorld({ infra: { apiDailyBudget: 1 } });
  var rt = w.runtime();
  w.store.set('APICOUNT_' + (function () { var d = new Date(w.nowMs + 9 * 3600000); return d.getUTCFullYear() + ('0' + (d.getUTCMonth() + 1)).slice(-2) + ('0' + d.getUTCDate()).slice(-2); })(), '999');
  var r = rt.syncCycle();
  assert.strictEqual(createCalls(w), 0);
  assert.strictEqual(w.sleeps.length, 0);
  assert.strictEqual(r.error, 'API_BUDGET_EXHAUSTED');
});

// ================================================================ c. 確認直後の即時配送

function runWithWebhook(w, at) {
  var rt = w.runtime(), other = w.runtime();
  webhookAfterSleep(w, other, at || 2, w.afterWebhook);
  var r = rt.syncCycle();
  return { rt: rt, other: other, r: r };
}

test('c: 同じ実行で ISSUED_CONFIRMED になった鍵だけを即時配送。コードは別メール1通、管理者通知にコードを含めない。配送ジョブは再送しない', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  var x = runWithWebhook(w, 2);
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(x.r.inRun.delivered, 1);
  assert.strictEqual(w.userMails.length, 1);
  var m = w.userMails[0];
  assert.strictEqual(m.to, 'guest@example.test');
  assert.ok(/入室用の暗証番号/.test(m.subject));
  assert.ok(m.body.indexOf(w.createdPasswords[0]) !== -1, '発行したコードを案内');
  assert.strictEqual(dlvOf(w, theOp(w)).state, D.DELIVERED);
  assert.strictEqual(w.mails.filter(function (a) { return PW8.test(a.body) || a.body.indexOf(w.createdPasswords[0]) !== -1; }).length, 0, '管理者通知にコードを含めない');
  // 配送ジョブ（5分周期）が同時刻・後で走っても二重送信しない
  var d1 = x.rt.deliverCycle();
  w.advance(300);
  var d2 = x.rt.deliverCycle();
  assert.strictEqual(d1.delivered + d2.delivered, 0);
  assert.strictEqual(w.userMails.length, 1);
  assert.strictEqual(w.userMailAttempts, 1);
});

test('c: inRunDeliver が無効（既定）なら、確認できても同期内では送らない。従来の配送ジョブが送る', function () {
  var w = fastWorld({ mail: true });
  var x = runWithWebhook(w, 2);
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(x.r.inRun.delivered, 0);
  assert.strictEqual(x.rt.deliverCycle().delivered, 1);
  assert.strictEqual(w.userMails.length, 1);
});

test('c: 配送が未設定（deliveryConfigured!=true）なら同期内でも送らない', function () {
  var w = fastWorld({ infra: { inRunDeliver: true } });
  var x = runWithWebhook(w, 2);
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(x.r.inRun.deliverSkipped, 'DELIVERY_NOT_CONFIGURED');
  assert.strictEqual(w.delivered.length + w.userMails.length, 0);
});

test('c: 未確認（Webhook未着）の鍵のコードは送らない。確認前に配送へ進まない', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  var r = w.runtime().syncCycle();
  assert.strictEqual(theOp(w).state, S.SENT_WAIT_WEBHOOK);
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(w.userMailAttempts, 0);
  assert.strictEqual(r.inRun.delivered, 0);
});

test('c: 確認から送信までに予約が取消・改訂された場合、送信直前の台帳再確認で止まり、コードを送らない（SUPPRESSED）', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  w.afterWebhook = function (ww) { ww.records = [H.record({ status: 'CANCELLED', revision: 2 })]; };
  var x = runWithWebhook(w, 2);
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(dlvOf(w, theOp(w)).state, D.SUPPRESSED);
  assert.strictEqual(x.r.inRun.delivered, 0);
  // 後続の配送ジョブも旧コードを送らない
  w.advance(300);
  x.rt.deliverCycle();
  assert.strictEqual(w.userMails.length, 0);
});

test('c: 送信直前の台帳が読めなければ送らず、配送ジョブに任せる（fail closed）。台帳が戻れば配送ジョブが1通送る', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  w.afterWebhook = function (ww) { ww.ledgerFail = 'LEDGER_READ_FAILED'; };
  var x = runWithWebhook(w, 2);
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(x.r.inRun.deliverSkipped, 'LEDGER_READ_FAILED');
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  w.ledgerFail = null;
  w.advance(300);
  assert.strictEqual(x.rt.deliverCycle().delivered, 1);
  assert.strictEqual(w.userMails.length, 1);
});

test('c: 送信結果が不明な例外は DELIVERY_UNKNOWN。自動再送しない（配送ジョブも再送しない）', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  w.mailMode = 'throwUnknown';
  var x = runWithWebhook(w, 2);
  assert.strictEqual(dlvOf(w, theOp(w)).state, D.UNKNOWN);
  assert.ok(w.mails.some(function (m) { return /DELIVERY_UNKNOWN/.test(m.subject); }));
  w.mailMode = 'ok';
  w.advance(900);
  x.rt.deliverCycle();
  assert.strictEqual(w.userMailAttempts, 1, '再送しない');
  assert.strictEqual(w.userMails.length, 0);
});

test('c: 「送っていない」と確定した失敗はバックオフ付きで再試行。同期内の失敗直後に配送ジョブがすぐ再送しない', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  w.mailMode = 'notSent';
  var x = runWithWebhook(w, 2);
  assert.strictEqual(dlvOf(w, theOp(w)).state, D.NOT_SENT);
  assert.strictEqual(w.userMailAttempts, 1);
  x.rt.deliverCycle();
  assert.strictEqual(w.userMailAttempts, 1, 'バックオフ中は再試行しない');
  w.mailMode = 'ok';
  w.advance(601);
  assert.strictEqual(x.rt.deliverCycle().delivered, 1);
  assert.strictEqual(w.userMails.length, 1);
});

test('c: 前回以前から ISSUED_CONFIRMED の鍵は同期内配送の対象外（配送ジョブの責務のまま）。配送ジョブが送る', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true }, minutesBefore: 20 * 60 }); // 前日14:00
  var rt = w.runtime(), other = w.runtime();
  rt.syncCycle(); // 観測
  w.advance(300);
  rt.syncCycle(); // 発行（待機で未確認）
  assert.strictEqual(theOp(w).state, S.SENT_WAIT_WEBHOOK);
  postWebhook(w, other, theOp(w));
  w.advance(60);
  var r2 = rt.syncCycle(); // 今回の実行で確認になった → 配送を試みる（ただし前日18:00前なので保留）
  assert.strictEqual(theOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(w.userMails.length, 0, '前日18:00前は送らない（既存の配送開始時刻）');
  assert.strictEqual(r2.inRun.delivered, 0);
  w.nowMs = H.jst('2030-01-10', '18:00').getTime();
  var r3 = rt.syncCycle(); // すでに確認済みの鍵: 同期内配送の対象にしない
  assert.strictEqual(w.userMails.length, 0);
  assert.strictEqual(r3.inRun.delivered, 0);
  assert.strictEqual(rt.deliverCycle().delivered, 1, '配送ジョブが送る');
  assert.strictEqual(w.userMails.length, 1);
});

test('c: 同期内配送の対象は ISSUED_CONFIRMED のみ。UNKNOWN/FAILED の鍵のコードは送らない', function () {
  var w = fastWorld({ mail: true, infra: { inRunDeliver: true } });
  w.createMode = 'commandId';
  var rt = w.runtime();
  var orig = w.api.createKey;
  w.api.createKey = function (p) { orig(p); return { httpCode: 400, parsed: { statusCode: 400 } }; }; // 明確な拒否
  rt.syncCycle();
  assert.strictEqual(theOp(w).state, S.FAILED);
  assert.strictEqual(w.userMailAttempts, 0);
  w.advance(300);
  rt.syncCycle();
  assert.strictEqual(createCalls(w), 1, 'FAILEDへ自動でcreateKeyを再送しない');
  assert.strictEqual(w.userMailAttempts, 0);
});

// ================================================================ 計測（モック）

/**
 * 予約確定(t0)から暗証番号メール送信までを、5分周期の同期・配送トリガー（位相は任意）と Webhook 到着遅延 W でシミュレーションする。
 * 外部の遅れ（実Webhook・GASトリガー・メール）は含まない。保証値ではなく、構成ごとの比較用。
 */
function latencySec(infra, syncPhaseSec, deliverPhaseSec, W) {
  var w = H.createWorld({ sleep: true, mail: true, cfg: { deliveryConfigured: true, delivery: H.DELIVERY_CFG, infra: infra } });
  w.records = [H.record()];
  var t0 = START - 45 * 60000;
  w.nowMs = t0;
  var rtS = w.runtime(), rtD = w.runtime(), hook = w.runtime();
  var arrival = null;
  var orig = w.api.createKey;
  w.api.createKey = function (p) { var r = orig(p); arrival = { at: w.nowMs + W * 1000, cmd: 'CMD' + w.seq }; return r; };
  function fireArrival(lockHeld) {
    if (!arrival || w.nowMs < arrival.at) return;
    var a = arrival, keep = w.nowMs;
    arrival = null;
    w.nowMs = a.at;
    hook.handleWebhook(H.webhook({ commandId: a.cmd, deviceMac: H.DEV }), H.TOKEN, H.TOKEN);
    w.nowMs = Math.max(keep, a.at);
  }
  w.sleepHook = function () { fireArrival(true); };
  var nextS = t0 + syncPhaseSec * 1000, nextD = t0 + deliverPhaseSec * 1000;
  for (var guard = 0; guard < 400 && w.userMails.length === 0; guard++) {
    var cands = [nextS, nextD].concat(arrival ? [arrival.at] : []);
    var t = Math.min.apply(null, cands);
    if (t > w.nowMs) w.nowMs = t;
    fireArrival(false);
    if (w.userMails.length) break;
    if (nextS <= w.nowMs) { rtS.syncCycle(); nextS += 300000; fireArrival(false); }
    if (w.userMails.length) break;
    if (nextD <= w.nowMs) { rtD.deliverCycle(); nextD += 300000; }
  }
  assert.strictEqual(w.userMails.length, 1, 'メールは1通だけ');
  return Math.round((w.nowMs - t0) / 1000);
}

test('計測(モック): 5分周期のまま、構成ごとの「確定→コード案内メール送信」までの仮想所要時間（保証値ではない）', function (t) {
  var phases = [1, 60, 120, 180, 240, 299];
  var W = 20;
  var cfgs = {
    '現行': {},
    'a のみ': { priorityRetryLeadSec: 3600 },
    'a+b': { priorityRetryLeadSec: 3600, inRunConfirmMaxSec: 45 },
    'a+b+c': { priorityRetryLeadSec: 3600, inRunConfirmMaxSec: 45, inRunDeliver: true }
  };
  var res = {};
  Object.keys(cfgs).forEach(function (name) {
    res[name] = phases.map(function (p) { return latencySec(cfgs[name], p, (p + 137) % 300 || 1, W); });
    t.diagnostic(name + ' (W=' + W + 's, 同期位相' + phases.join('/') + 's): ' + res[name].join(', ') + ' 秒 / 最小' + Math.min.apply(null, res[name]) + ' 最大' + Math.max.apply(null, res[name]));
  });
  assert.ok(Math.min.apply(null, res['現行']) >= 600, '現行は静穏時間・確認・配送の周期待ちで10分以上');
  assert.ok(Math.max.apply(null, res['a+b+c']) <= 330, 'a+b+c: 初回待ち(最大5分)+W+数秒に収まる（外部遅延は含まない）');
  assert.ok(Math.max.apply(null, res['a+b+c']) < Math.min.apply(null, res['現行']));
  assert.ok(Math.max.apply(null, res['a のみ']) < Math.max.apply(null, res['現行']));
});

test('計測(モック): Webhookが待機上限より遅い(W=70秒)と同期内では確認できず、5分超になり得る。次回同期で安全に確認・配送される（5分以内の保証ではない）', function (t) {
  var phases = [1, 150, 299];
  var r = phases.map(function (p) { return latencySec({ priorityRetryLeadSec: 3600, inRunConfirmMaxSec: 45, inRunDeliver: true }, p, (p + 137) % 300 || 1, 70); });
  t.diagnostic('a+b+c, W=70s: ' + r.join(', ') + ' 秒');
  assert.ok(Math.max.apply(null, r) > 330, '待機上限を超える遅延では5分を超える（保証しない）');
  assert.ok(Math.max.apply(null, r) <= 900, 'それでも従来の経路で数周期内に案内される');
});
