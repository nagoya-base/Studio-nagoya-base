/*
 * Issue #754（PR-B）: 独立GAS基盤（認証・相関・単一排他・容量・保持・通知・監視・管理者復旧）のモックテスト。
 * 実API・実機・GASデプロイには接続しない。秘密を使わないフェイクのみ。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var H = require('./helpers/switchbot-access-world');
var Infra = H.Infra, Core = H.Core, S = Core.STATE;

function ops(w) {
  return w.store.keys().filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store.get(k)); });
}
function onlyOp(w) { var o = ops(w); assert.strictEqual(o.length, 1, 'OP は1件'); return o[0]; }
function storeDump(w) { return JSON.stringify(w.props) + JSON.stringify(w.mails); }

/** 台帳の確定予約を1件、発行確認済み(ISSUED_CONFIRMED)まで進める（commandId あり経路）。 */
function issueOne(w, rt, rec) {
  w.records = [rec || H.record()];
  rt.syncCycle();                       // 観測（静穏時間待ち）
  w.advance(300);
  rt.syncCycle();                       // 発行（createKey → Webhook待ち）
  var op = onlyOp(w);
  assert.strictEqual(op.state, S.SENT_WAIT_WEBHOOK);
  w.advance(10);
  var r = rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN);
  assert.strictEqual(r.accepted, true);
  w.advance(290);
  rt.syncCycle();                       // 反映確認
  assert.strictEqual(onlyOp(w).state, S.ISSUED_CONFIRMED);
  return onlyOp(w);
}

// ================================================================ 環境分離・設定

test('設定検証: 本番に検証機(37DD)、許可端末なし、通知先なしは不正', function () {
  assert.strictEqual(Infra.validateConfig(H.baseCfg()).ok, true);
  assert.ok(Infra.validateConfig(H.baseCfg({ keypads: [{ brand: 'snb', facility: 'main', deviceId: H.DEV_VERIFY }] })).errors.indexOf('KEYPAD_NOT_ALLOWED_IN_ENV') !== -1);
  assert.ok(Infra.validateConfig(H.baseCfg({ allowedLast4: [] })).errors.indexOf('ALLOWED_LAST4_MISSING') !== -1);
  assert.ok(Infra.validateConfig(H.baseCfg({ adminMailTo: [] })).errors.indexOf('ADMIN_MAIL_MISSING') !== -1);
  assert.ok(Infra.validateConfig(H.baseCfg({ environment: 'staging' })).errors.indexOf('ENVIRONMENT_INVALID') !== -1);
  // 検証環境は検証機のみ許可できる
  assert.strictEqual(Infra.validateConfig(H.baseCfg({ environment: 'verify', allowedLast4: ['37DD'], keypads: [{ brand: 'snb', facility: 'main', deviceId: H.DEV_VERIFY }] })).ok, true);
});

test('不正設定・環境取り違えでは何も呼ばない（API・メール以外の書込みも最小）', function () {
  var w = H.createWorld({ cfg: { keypads: [{ brand: 'snb', facility: 'main', deviceId: H.DEV_VERIFY }] } });
  w.records = [H.record()];
  var rt = w.runtime();
  var r = rt.syncCycle();
  assert.strictEqual(r.error, 'CONFIG_INVALID');
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(w.ledgerCalls, 0);

  var w2 = H.createWorld();
  w2.props.META_ENV = 'verify'; // 検証環境の状態ストアを本番設定で開いた
  var rt2 = w2.runtime();
  assert.strictEqual(rt2.syncCycle().error, 'ENV_MISMATCH');
  assert.strictEqual(w2.calls.length, 0);
  assert.ok(w2.mails.some(function (m) { return /ENV_MISMATCH/.test(m.subject); }));
  assert.strictEqual(rt2.admin('status', {}).error, 'ENV_MISMATCH');
});

// ================================================================ Webhook 認証・相関

test('認証: 共有トークンの定数時間比較。期待値が短い/未設定なら全拒否', function () {
  assert.strictEqual(Infra.authenticateWebhook(H.TOKEN, H.TOKEN), true);
  assert.strictEqual(Infra.authenticateWebhook('x' + H.TOKEN.slice(1), H.TOKEN), false);
  assert.strictEqual(Infra.authenticateWebhook(H.TOKEN + 'x', H.TOKEN), false);
  assert.strictEqual(Infra.authenticateWebhook('', H.TOKEN), false);
  assert.strictEqual(Infra.authenticateWebhook(undefined, H.TOKEN), false);
  assert.strictEqual(Infra.authenticateWebhook('short', 'short'), false, '期待値が短い設定を通さない');
  assert.strictEqual(Infra.authenticateWebhook('', ''), false);
  assert.strictEqual(Infra.authenticateWebhook(null, null), false);
  assert.strictEqual(Infra.constantTimeEquals('abc', 'abc'), true);
  assert.strictEqual(Infra.constantTimeEquals('abc', 'abd'), false);
});

test('未認証Webhookは何も保存しない（完全に正しい内容でも）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = onlyOp(w);
  var before = JSON.stringify(w.props);
  ['', 'wrong'.repeat(8), undefined].forEach(function (tok) {
    var r = rt.handleWebhook(H.webhook({ commandId: op.commandId }), tok, H.TOKEN);
    assert.strictEqual(r.accepted, false);
    assert.strictEqual(r.reason, 'UNAUTHENTICATED');
  });
  assert.strictEqual(rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, '').accepted, false, '期待トークン未設定');
  assert.strictEqual(JSON.stringify(w.props), before, '状態は1バイトも変わらない');
  assert.strictEqual(w.locked, false);
});

test('相関: 対象Keypad・操作・commandId が進行中の操作と一致する場合のみ保存', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = onlyOp(w);
  var before = JSON.stringify(w.props);
  var cases = [
    [H.webhook({ commandId: 'UNRELATED' }), 'NO_MATCHING_OPERATION'],
    [H.webhook({ commandId: op.commandId, eventName: 'deleteKey' }), 'NO_MATCHING_OPERATION'],
    [H.webhook({ commandId: op.commandId, deviceMac: 'CCCCCCCCCCCC9999' }), 'DEVICE_NOT_TARGET'],
    [H.webhook({ commandId: op.commandId, deviceMac: H.DEV_VERIFY }), 'DEVICE_NOT_TARGET'],
    [H.webhook({ commandId: op.commandId, deviceMac: '' }), 'DEVICE_MISSING'],
    [H.webhook({ commandId: op.commandId, deviceType: 'WoLock' }), 'NOT_KEYPAD_EVENT'],
    [JSON.stringify({ eventType: 'other' }), 'NOT_KEYPAD_EVENT'],
    ['not json', 'BAD_REQUEST'],
    ['x'.repeat(9000), 'BAD_REQUEST']
  ];
  cases.forEach(function (c) {
    var r = rt.handleWebhook(c[0], H.TOKEN, H.TOKEN);
    assert.strictEqual(r.accepted, false, c[1]);
    assert.strictEqual(r.reason, c[1]);
  });
  assert.strictEqual(JSON.stringify(w.props), before, '不一致はどれも保存しない');
  // 一致するものだけ保存。保存されるのは最小項目のみ（未知フィールドは残らない）
  var ok = rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN);
  assert.deepStrictEqual({ a: ok.accepted, s: ok.stored }, { a: true, s: true });
  var evKeys = w.store.keys().filter(function (k) { return k.indexOf('EVT_') === 0; });
  assert.strictEqual(evKeys.length, 1);
  assert.ok(!/junk|xxxxxxxx/.test(w.store.get(evKeys[0])));
});

test('重複Webhookは初回維持、食い違う重複は矛盾印（成功へ寄せない）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = onlyOp(w);
  w.advance(5);
  assert.strictEqual(rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN).stored, true);
  assert.strictEqual(rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN).duplicate, true);
  rt.handleWebhook(H.webhook({ commandId: op.commandId, result: 'failed' }), H.TOKEN, H.TOKEN);
  w.advance(295);
  rt.syncCycle();
  assert.strictEqual(onlyOp(w).state, S.UNKNOWN, '食い違う重複は成功根拠にしない');
});

test('フラグOFFでも進行中操作のWebhookは相関つきで取り込む', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  // 取消 → 旧キー削除送信（commandIdあり）。その後フラグをOFFへ
  w.records = [H.record({ status: 'CANCELLED', revision: 2 })];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var del = onlyOp(w);
  assert.strictEqual(del.state, S.DELETE_SENT);
  var rtOff = w.runtime({ enabled: false });
  w.advance(5);
  var r = rtOff.handleWebhook(H.webhook({ eventName: 'deleteKey', commandId: del.deleteCommandId }), H.TOKEN, H.TOKEN);
  assert.strictEqual(r.stored, true);
  assert.ok(op);
});

test('ロック取得不能時のWebhookは受信箱へ退避し、次の照合で相関取込（到着時刻を保持）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = onlyOp(w);
  w.advance(10);
  var arrivedAt = w.sec();
  w.lockBusy = true;
  var r = rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN);
  assert.deepStrictEqual({ a: r.accepted, q: r.queued }, { a: true, q: true });
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('EVT_') === 0; }).length, 0, '受信箱のみ。確認根拠(EVT)へは未反映');
  // 認証・対象検証を通らないものは受信箱にも入らない
  assert.strictEqual(rt.handleWebhook(H.webhook({ commandId: op.commandId }), 'bad', H.TOKEN).accepted, false);
  assert.strictEqual(rt.handleWebhook(H.webhook({ commandId: 'X', deviceMac: 'CCCCCCCCCCCC9999' }), H.TOKEN, H.TOKEN).accepted, false);
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).length, 1);
  w.lockBusy = false;
  w.advance(280);
  rt.syncCycle();
  var ev = JSON.parse(w.store.get(w.store.keys().filter(function (k) { return k.indexOf('EVT_') === 0; })[0]));
  assert.strictEqual(ev.receivedAtSec, arrivedAt, '遅延取込でも到着時刻を保つ（期限内と偽らない）');
  assert.strictEqual(onlyOp(w).state, S.ISSUED_CONFIRMED);
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).length, 0);
});

test('受信箱: 上限超過は通知して取りこぼし、期限切れは回収', function () {
  var w = H.createWorld({ cfg: { infra: { inboxMax: 2, inboxTtlSec: 100 } } });
  var rt = w.runtime();
  w.lockBusy = true;
  [1, 2, 3].forEach(function (i) { rt.handleWebhook(H.webhook({ commandId: 'Q' + i }), H.TOKEN, H.TOKEN); });
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).length, 2);
  assert.ok(w.mails.some(function (m) { return /WEBHOOK_INBOX_FULL/.test(m.subject); }));
  w.lockBusy = false;
  w.advance(200);
  rt.sweepCycle();
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).length, 0);
});

// ================================================================ 排他

test('ロック: 取得失敗ならfnを実行しない／入れ子拒否／例外でも解放／外では更新不可', function () {
  var held = false, calls = 0;
  var svc = { tryLock: function () { if (held) return false; held = true; return true; }, releaseLock: function () { held = false; } };
  var dom = Infra.createLockDomain(svc);
  held = true;
  assert.deepStrictEqual(dom.run(10, function () { calls++; }), { ran: false, error: 'LOCK_UNAVAILABLE' });
  assert.strictEqual(calls, 0);
  held = false;
  assert.throws(function () { dom.coreLock(['K'], function () {}); }, /LOCK_NOT_HELD/);
  assert.throws(function () { dom.run(10, function () { throw new Error('boom'); }); }, /boom/);
  assert.strictEqual(held, false, '例外でも解放');
  dom.run(10, function () { assert.throws(function () { dom.run(10, function () {}); }, /LOCK_REENTRANT/); });
  assert.strictEqual(held, false);
  var throwing = Infra.createLockDomain({ tryLock: function () { throw new Error('svc'); }, releaseLock: function () {} });
  assert.strictEqual(throwing.run(1, function () { calls++; }).ran, false, 'tryLock例外も不取得');
});

test('ロック失敗中は送信せず、連続失敗で通知。復帰で状態が再読込される', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  w.lockBusy = true;
  for (var i = 0; i < 3; i++) assert.strictEqual(rt.syncCycle().error, 'LOCK_UNAVAILABLE');
  assert.strictEqual(w.callCount('createKey'), 0);
  assert.strictEqual(w.ledgerCalls, 0);
  assert.ok(w.mails.some(function (m) { return /LOCK_UNAVAILABLE/.test(m.subject); }));
  w.lockBusy = false;
  rt.syncCycle();
  assert.strictEqual(w.store.get('LOCKFAIL'), '0');
});

test('別インスタンス（再起動後）が同じ状態を再読込し、二重発行しない', function () {
  var w = H.createWorld();
  var a = w.runtime();
  w.records = [H.record()];
  a.syncCycle(); w.advance(300); a.syncCycle();
  var b = w.runtime(); // 新しいランタイム＝別実行
  w.advance(300); b.syncCycle();
  w.advance(300); a.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1);
  assert.strictEqual(ops(w).length, 1);
});

test('syncの途中でロックを要求する並行入口（Webhook/管理者）は取得後に直列化される', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  var other = Infra.createRuntime(w.deps(), w.cfg); // 別実行（別インスタンス）が同じロックを要求する
  var inSync = false;
  var origList = w.api.listDevices;
  var seen = null;
  w.api.listDevices = function () {
    if (!inSync) { inSync = true; seen = other.admin('delete', { recId: op.id }); inSync = false; } // sync 中に管理者が割り込む
    return origList();
  };
  w.records = [H.record({ revision: 2 })];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.deepStrictEqual({ ok: seen.ok, error: seen.error }, { ok: false, error: 'LOCK_UNAVAILABLE' }, 'ロック保持中は割込み不可');
  assert.strictEqual(w.callCount('deleteKey') <= 1, true);
});

// ================================================================ 管理者認可・監査

test('管理者認可: 許可リストのみ・ラベルはサーバー確定・actor引数は無視', function () {
  var actors = { 'Owner@Example.test': 'ADMIN-1', bad: 'has space' };
  assert.deepStrictEqual(Infra.authorizeAdmin({ email: ' owner@example.TEST ' }, actors), { ok: true, actor: 'ADMIN-1' });
  assert.strictEqual(Infra.authorizeAdmin({ email: 'x@example.test' }, actors).ok, false);
  assert.strictEqual(Infra.authorizeAdmin({ email: '' }, actors).error, 'IDENTITY_UNAVAILABLE');
  assert.strictEqual(Infra.authorizeAdmin(null, actors).ok, false);
  assert.strictEqual(Infra.authorizeAdmin({ email: 'bad' }, actors).ok, false, '不正ラベルは拒否');
  assert.strictEqual(Infra.authorizeAdmin({ email: 'owner@example.test' }, null).ok, false);
  assert.strictEqual(Infra.authorizeAdmin({ email: 'owner@example.test' }, {}).ok, false);
});

test('未認可の管理操作は拒否され、APIも状態も触らない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  var before = JSON.stringify(w.props), calls = w.calls.length;
  w.identity = { email: 'stranger@example.test' };
  ['status', 'inventory'].forEach(function (a) { assert.strictEqual(rt.admin(a, {}).error, 'NOT_AUTHORIZED'); });
  assert.strictEqual(rt.admin('delete', { recId: op.id, actor: 'ADMIN-1' }).error, 'NOT_AUTHORIZED', 'クライアントのactorでは通らない');
  w.identity = { email: '' };
  assert.strictEqual(rt.admin('delete', { recId: op.id }).error, 'IDENTITY_UNAVAILABLE');
  assert.strictEqual(JSON.stringify(w.props), before);
  assert.strictEqual(w.calls.length, calls);
});

test('管理者の個別削除: フラグOFFでも実行でき、操作者はサーバー確定ラベル、監査に個人情報なし', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  var rtOff = w.runtime({ enabled: false });
  var r = rtOff.admin('delete', { recId: op.id, actor: 'FORGED' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(w.callCount('deleteKey'), 1);
  var logs = w.store.keys().filter(function (k) { return k.indexOf('ADMINLOG_') === 0; }).map(function (k) { return JSON.parse(w.store.get(k)); });
  assert.deepStrictEqual(logs.map(function (l) { return l.outcome; }).sort(), ['ATTEMPT', 'OK']);
  logs.forEach(function (l) { assert.strictEqual(l.actor, 'ADMIN-1'); assert.strictEqual(l.action, 'delete'); });
  assert.ok(!/owner@example|FORGED/.test(storeDump(w)), 'メールアドレス・偽actorは状態に残らない');
});

test('監査の事前記録に失敗した管理操作は実行しない／不正な入力は拒否', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  w.storeFail = function (k) { return k.indexOf('ADMINLOG_') === 0; };
  assert.strictEqual(rt.admin('delete', { recId: op.id }).error, 'AUDIT_UNAVAILABLE');
  assert.strictEqual(w.callCount('deleteKey'), 0);
  w.storeFail = null;
  assert.strictEqual(rt.admin('delete', { recId: '../x' }).error, 'RECORD_ID_INVALID');
  assert.strictEqual(rt.admin('delete', { recId: 5 }).error, 'RECORD_ID_INVALID');
  assert.strictEqual(rt.admin('resolveUnknown', { recId: op.id, decision: 'DROP_TABLE' }).error, 'DECISION_INVALID');
  assert.strictEqual(rt.admin('format', {}).error, 'UNKNOWN_ACTION');
});

test('管理者のUNKNOWN解決はkeyListで検証され、ラベルが履歴に残る', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.createMode = 'noCommandId';
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  // keyList にキーがある状態で、通信断を模したUNKNOWNを人工的に作る
  var op = onlyOp(w);
  op.state = S.UNKNOWN; op.reason = 'COMM_ERROR'; w.props['OP_' + op.id] = JSON.stringify(op);
  var r = rt.admin('resolveUnknown', { recId: op.id, decision: 'CONFIRM_PRESENT' });
  assert.deepStrictEqual({ ok: r.ok, state: r.state }, { ok: true, state: S.ISSUED_CONFIRMED });
  assert.strictEqual(onlyOp(w).history.slice(-1)[0].basis, 'ADMIN:ADMIN-1');
  assert.strictEqual(w.callCount('createKey'), 1, '管理者解決は変更APIを呼ばない');
});

// ================================================================ 容量

test('Keypad容量ゲート: 閾値は設定必須（既定80を持たない）。不明・未設定・到達・不正閾値で停止', function () {
  var dev = function (n) { var l = []; for (var i = 0; i < n; i++) l.push({ id: 'i' + i, name: 'n' + i }); return [{ deviceId: H.DEV, keyList: l }]; };
  assert.deepStrictEqual(Infra.keypadCapacityGate(dev(79), H.DEV, { stopAt: 80, officialLimit: 90 }), { ok: true, code: null, used: 79 });
  assert.strictEqual(Infra.keypadCapacityGate(dev(80), H.DEV, { stopAt: 80, officialLimit: 90 }).code, 'CAPACITY_REACHED');
  assert.strictEqual(Infra.keypadCapacityGate(dev(5), H.DEV, {}).code, 'CAPACITY_THRESHOLD_UNSET');
  assert.strictEqual(Infra.keypadCapacityGate(dev(5), H.DEV, undefined).code, 'CAPACITY_THRESHOLD_UNSET');
  assert.strictEqual(Infra.keypadCapacityGate(dev(5), H.DEV, { stopAt: 0 }).code, 'CAPACITY_THRESHOLD_UNSET');
  assert.strictEqual(Infra.keypadCapacityGate(dev(5), H.DEV, { stopAt: 95, officialLimit: 90 }).code, 'CAPACITY_THRESHOLD_INVALID');
  assert.strictEqual(Infra.keypadCapacityGate(null, H.DEV, { stopAt: 80 }).code, 'CAPACITY_UNKNOWN');
  assert.strictEqual(Infra.keypadCapacityGate([{ deviceId: H.DEV }], H.DEV, { stopAt: 80 }).code, 'CAPACITY_UNKNOWN');
  assert.strictEqual(Infra.keypadCapacityGate(dev(5), 'OTHER', { stopAt: 80 }).code, 'CAPACITY_UNKNOWN');
  assert.ok(!/stopAt\s*[:=]\s*80/.test(fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', 'SwitchBotAccessInfra.gs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')), '80 をハードコードしない');
});

test('容量到達: 新規発行だけ止め、通知し、取消の削除は継続。予約は巻き戻さない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  w.preload(H.DEV, 79); // 既存19件ではなく仮に79件 + 発行済み1件 = 80
  w.records = [H.record({ bookingId: 'SNB-2', revision: 1 })];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1, '2件目は発行しない');
  assert.ok(w.mails.some(function (m) { return /CAPACITY_REACHED/.test(m.subject); }));
  assert.strictEqual(ops(w).filter(function (o) { return o.bookingId === 'SNB-2'; }).length, 0, '発行計画も作らない');
  // 既存予約の取消は容量到達でも削除される
  w.records = [H.record({ status: 'CANCELLED', revision: 2 })];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('deleteKey'), 1);
  assert.ok(op);
});

test('停止閾値が未設定なら発行しない（容量不明の安全停止）', function () {
  var w = H.createWorld({ cfg: { capacity: {} } });
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 0);
  assert.ok(w.mails.some(function (m) { return /CAPACITY_THRESHOLD_UNSET/.test(m.subject); }));
});

test('保存容量: 使用量が閾値を超えたら新規発行を止め、通知する', function () {
  var w = H.createWorld({ cfg: { storageLimits: { totalBytes: 2000, perValueBytes: 9216 } } });
  var rt = w.runtime();
  w.props.FILLER_1 = 'x'.repeat(1600); // 80% > 70%
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 0);
  assert.ok(w.mails.some(function (m) { return /STORAGE_NEAR_LIMIT/.test(m.subject); }));
  var g = Infra.storageGate({ bytes: 100, maxValueBytes: 8000 }, {}, { totalBytes: 500 * 1024, perValueBytes: 9216 });
  assert.strictEqual(g.code, 'STORAGE_VALUE_NEAR_LIMIT');
});

test('容量見積もり: 実測レコードから、多い月4件の3倍負荷・未解決20件・保持30日/180日でも停止閾値(70%)に収まる', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  issueOne(w, rt);
  var m = Infra.measureStore(w.store);
  var avg = function (p) { var e = m.byPrefix[p] || { count: 1, bytes: 0 }; return Math.ceil(e.bytes / e.count); };
  function est(retentionDays, perMonth) {
    return Infra.estimateStorage({
      bookingsPerMonth: perMonth, changesPerBooking: 1, retentionDays: retentionDays, unresolvedOps: 20,
      opBytes: avg('OP'), bkBytes: avg('BK'), evtBytes: avg('EVT'), alertBytes: 200, trackBytes: avg('TRK'), alertsPerOp: 1
    });
  }
  var normal = est(30, 4), stress = est(30, 12), long = est(180, 4);
  [normal, stress, long].forEach(function (e) { assert.strictEqual(e.ok, true); });
  assert.ok(normal.ratio < 0.1, 'normal ' + (normal.ratio * 100).toFixed(1) + '% (OP平均 ' + avg('OP') + 'B)');
  assert.ok(stress.ratio < 0.3, 'stress ' + (stress.ratio * 100).toFixed(1) + '%');
  assert.ok(long.ratio < 0.3, '180日保持 ' + (long.ratio * 100).toFixed(1) + '%');
  assert.ok(m.maxValueBytes < 4096, '1値の最大 ' + m.maxValueBytes + 'B は 9KB 上限に十分余裕');
  assert.strictEqual(Infra.estimateStorage({ bookingsPerMonth: 4 }).ok, false, '入力不足は見積もりを返さない');
});

test('OP履歴が増えても1値の上限(9KB)に達しない前に停止ゲートが働く', function () {
  var big = {};
  for (var i = 0; i < 120; i++) big['k' + i] = 'v'.repeat(60);
  var store = { keys: function () { return ['OP_x']; }, get: function () { return JSON.stringify(big); } };
  var m = Infra.measureStore(store);
  assert.strictEqual(Infra.storageGate(m, {}, {}).ok, false);
});

// ================================================================ 保持・回収

function seedTerminalWorld(w, rt) {
  var op = issueOne(w, rt);
  w.records = [H.record({ status: 'CANCELLED', revision: 2 })];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var del = onlyOp(w);
  w.advance(5);
  rt.handleWebhook(H.webhook({ eventName: 'deleteKey', commandId: del.deleteCommandId }), H.TOKEN, H.TOKEN);
  w.advance(295); rt.syncCycle();
  assert.strictEqual(onlyOp(w).state, S.DELETED_CONFIRMED);
  return op.id;
}

test('保持: 未解決OPと必要な根拠（索引・Webhook・秘密・通知マーカー）は期限後も回収しない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = onlyOp(w);
  w.advance(5);
  rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN);
  // 未解決(UNKNOWN)にして通知マーカーを作る
  var rec = onlyOp(w); rec.state = S.UNKNOWN; rec.alertCode = 'READ_LIMIT'; w.props['OP_' + rec.id] = JSON.stringify(rec);
  w.props['ALERT_' + rec.id + '_READ_LIMIT'] = String(w.sec());
  var snapshot = JSON.stringify(w.props), secrets = JSON.stringify(w.secretProps);
  w.advance(400 * 86400);
  var removed = Infra.garbageCollect(w.store, w.secrets, w.sec(), w.cfg);
  assert.strictEqual(JSON.stringify(w.props).length > 0 && ['BK', 'EVT', 'ALERT', 'SECRET'].every(function (k) { return removed[k] === 0; }), true, JSON.stringify(removed));
  assert.strictEqual(JSON.stringify(w.secretProps), secrets);
  ['OP_', 'BK_', 'EVT_', 'ALERT_'].forEach(function (p) { assert.ok(w.store.keys().some(function (k) { return k.indexOf(p) === 0; }), p + ' は保護される'); });
  assert.ok(snapshot);
});

test('保持: 終端後の期限超過で OP/BK/EVT/ALERT/孤立秘密/追跡/受信箱/管理ログ/送達済み通知を回収。未送達通知は保持', function () {
  var w = H.createWorld({ cfg: { retentionSec: 30 * 86400 } });
  var rt = w.runtime();
  seedTerminalWorld(w, rt);
  // 孤立物を用意
  w.props['ALERT_GHOST_READ_LIMIT'] = String(w.sec());
  w.secretProps['SECRET_GHOST'] = '12345678';
  w.props['INBOX_X_createKey_Z'] = JSON.stringify({ at: w.sec() - 99999, payload: {} });
  w.props['ADMINLOG_1_1'] = JSON.stringify({ at: 1, actor: 'ADMIN-1', action: 'delete', ref: 'x', outcome: 'OK' });
  w.props['IALERT_OLD_-_-'] = JSON.stringify({ event: { code: 'READ_LIMIT' }, sentAt: 1, attempts: 0, lastTryAt: 1 });
  w.props['IALERT_PENDING_-_-'] = JSON.stringify({ event: { code: 'READ_LIMIT' }, sentAt: null, attempts: 3, lastTryAt: 1 });
  w.mailFail = true;         // 未送達通知が残ることを確認するため送達を失敗させる
  w.advance(31 * 86400);
  rt.sweepCycle();           // 終端OPを破棄（コア）→ 同じ巡回で孤立物を回収（インフラ）
  rt.sweepCycle();           // BK 索引は OP 破棄の次の巡回で空になり、そこから年齢を数える
  w.advance(31 * 86400);
  rt.sweepCycle();
  var left = w.store.keys().filter(function (k) { return !/^(META_|HB_|LOCKFAIL|APICOUNT_|IALERT_)/.test(k); });
  assert.deepStrictEqual(left, [], '残存: ' + left.join(','));
  assert.deepStrictEqual(w.secrets.keys(), []);
  assert.ok(w.props['IALERT_PENDING_-_-'], '未送達の通知は消さない');
  assert.ok(!w.props['IALERT_OLD_-_-']);
});

test('保持: 孤立した秘密のみ破棄し、配送待ち(ISSUED_CONFIRMED)の秘密は残す', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  w.secretProps['SECRET_ORPHAN'] = '87654321';
  rt.sweepCycle();
  assert.deepStrictEqual(w.secrets.keys(), ['SECRET_' + op.id]);
});

test('保持: 年齢不明のBK索引は今から数え、期限後に回収される（未解決OPがなければ）', function () {
  var w = H.createWorld();
  w.props['BK_OLD'] = JSON.stringify({ bookingId: 'OLD', head: { revision: 1, cancelled: true }, ops: ['OP-GONE'] });
  var rt = w.runtime();
  rt.sweepCycle();
  var idx = JSON.parse(w.props['BK_OLD']);
  assert.deepStrictEqual(idx.ops, [], '参照切れOP項目を除去');
  assert.strictEqual(typeof idx.touchedAt, 'number');
  w.advance(31 * 86400);
  rt.sweepCycle();
  assert.strictEqual(w.props['BK_OLD'], undefined);
});

test('古いWebhook・ID再利用: 送信前に受信した古い削除イベントは採用せず、回収後は新しいイベントを受け付ける', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  // 古い deleteKey イベント（commandId DEL-REUSED）が過去に保存されていた
  var evk = 'EVT_' + Core.normDev(H.DEV) + '_deleteKey_DEL-REUSED';
  w.props[evk] = JSON.stringify({ eventName: 'deleteKey', commandId: 'DEL-REUSED', deviceMac: Core.normDev(H.DEV), result: 'success', receivedAtSec: w.sec() - 3600 });
  w.deleteMode = 'commandId';
  // 取消 → 削除送信。SwitchBot が同じ commandId を再利用した場合を模す
  var origDelete = w.api.deleteKey;
  w.api.deleteKey = function (d, id) { var r = origDelete(d, id); r.parsed.body.commandId = 'DEL-REUSED'; return r; };
  w.records = [H.record({ status: 'CANCELLED', revision: 2 })];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(onlyOp(w).state, S.UNKNOWN, '古いイベントを根拠に削除確定しない');
  assert.ok(op);
});

test('通知抑止マーカーはOP破棄と共に回収され、ID再利用後の新しい操作の通知を抑止しない', function () {
  var w = H.createWorld({ cfg: { retentionSec: 10 * 86400 } });
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = onlyOp(w);
  // 発行失敗(FAILED) → 通知 → 終端
  w.advance(5);
  rt.handleWebhook(H.webhook({ commandId: op.commandId, result: 'failed' }), H.TOKEN, H.TOKEN);
  w.advance(295); rt.syncCycle();
  assert.strictEqual(onlyOp(w).state, S.FAILED);
  assert.ok(w.store.keys().some(function (k) { return k.indexOf('ALERT_') === 0; }));
  w.advance(11 * 86400); rt.sweepCycle();
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('ALERT_') === 0 || k.indexOf('OP_') === 0; }).length, 0);
});

// ================================================================ 通知

test('通知分類: コアが発するすべての通知コードが固定分類に載っている', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', 'SwitchBotAccessCore.gs'), 'utf8');
  var codes = {};
  var re = /(?:alert|stopUnknown)\(\s*\w+\s*,\s*'([A-Z_]+)'/g, m;
  while ((m = re.exec(src))) codes[m[1]] = true;
  assert.ok(Object.keys(codes).length > 20);
  Object.keys(codes).forEach(function (c) { assert.notStrictEqual(Infra.classify(c).code, 'UNCLASSIFIED', c + ' が未分類'); });
  assert.strictEqual(Infra.classify('free text <script>').code, 'UNCLASSIFIED');
  assert.strictEqual(Infra.classify(undefined).code, 'UNCLASSIFIED');
});

test('通知本文は固定文言と検証済み識別子のみ（自由文・秘密・個人情報・完全IDを出さない）', function () {
  var m = Infra.renderNotification({
    code: 'KEY_REMAINS', ref: 'SNB-1', rev: 3, device: '****01FD', state: 'UNKNOWN', env: 'production',
    message: 'token=SECRET123', detail: 'free text', exception: 'Error: boom', email: 'taro@example.com', password: '12345678'
  });
  assert.ok(/KEY_REMAINS/.test(m.subject) && /SNB-1/.test(m.body) && /\*\*\*\*01FD/.test(m.body));
  assert.ok(!/SECRET123|boom|taro@|12345678|free text/.test(m.subject + m.body));
  var hostile = Infra.renderNotification({ code: 'KEY_REMAINS', ref: 'a b@c.com', device: H.DEV, state: 'x', rev: '1; DROP' });
  assert.ok(!/@c\.com|AAAAAAAAAAAA01FD|DROP/.test(hostile.subject + hostile.body));
});

test('通知失敗: 業務処理を止めず、次の周期で再通知。送達後は重複しない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.createMode = 'noCommandId';
  w.mailFail = true;
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300);
  // 作成が反映されない（0件のまま）→ READ_LIMIT で UNKNOWN
  var orig = w.api.createKey;
  w.api.createKey = function (p) { var r = orig(p); w.keys[p.deviceId] = []; return r; };
  rt.syncCycle(); w.advance(300); rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(onlyOp(w).state, S.UNKNOWN);
  assert.strictEqual(w.mails.length, 0, '送れていない');
  w.mailFail = false;
  w.advance(300); rt.syncCycle();
  var n = w.mails.length;
  assert.ok(n >= 1 && /READ_LIMIT/.test(w.mails[0].subject), '次の周期で再通知');
  w.advance(300); rt.syncCycle();
  assert.strictEqual(w.mails.length, n, '送達後は重複しない');
});

test('基盤通知: バックオフ付き再送、連続失敗は監視状態に出る、送達後は繰り返し間隔内は再送しない', function () {
  var w = H.createWorld({ cfg: { infra: { notifyFailingAttempts: 3, notifyBackoffBaseSec: 10, notifyBackoffMaxSec: 100 } } });
  var rt = w.runtime();
  w.mailFail = true;
  rt.infraAlert('JOB_STALE', null, null, null);
  for (var i = 0; i < 6; i++) { w.advance(200); rt.watchdog(); }
  var st = rt.admin('status', {});
  assert.ok(st.notifyOutbox.pending >= 1);
  assert.ok(st.notifyFailingSince, '連続失敗の検知時刻が出る');
  w.mailFail = false;
  w.advance(200); rt.watchdog();
  assert.strictEqual(w.mails.length, 1);
  w.advance(200); rt.watchdog();
  assert.strictEqual(rt.infraAlert('JOB_STALE', null, null, null), false);
  assert.strictEqual(w.mails.length, 1);
});

test('監視: 有効時に照合ジョブが止まっていればJOB_STALE。OFFなら通知しない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [];
  rt.syncCycle();
  w.advance(100); assert.strictEqual(rt.watchdog().stale, false);
  w.advance(1000); assert.strictEqual(rt.watchdog().stale, true);
  assert.ok(w.mails.some(function (m) { return /JOB_STALE/.test(m.subject); }));
  var w2 = H.createWorld(); var off = w2.runtime({ enabled: false });
  w2.advance(100000); assert.strictEqual(off.watchdog().stale, false);
  assert.strictEqual(w2.mails.length, 0);
});

// ================================================================ 台帳照合（結線）

test('統合: 前日12:00以降の確定予約が、静穏時間→発行→Webhook+keyList確認で ISSUED_CONFIRMED になる。秘密は状態・通知に出ない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  assert.deepStrictEqual(op.evidence.slice().sort(), ['KEYLIST_CONFIRMED', 'WEBHOOK_SUCCESS']);
  var pw = w.createdPasswords[0];
  assert.ok(/^[0-9]{8}$/.test(pw));
  assert.ok(storeDump(w).indexOf(pw) === -1, 'パスコードは状態・通知へ出ない');
  assert.ok(storeDump(w).indexOf(H.DEV) === -1 || !/AAAAAAAAAAAA01FD/.test(JSON.stringify(w.mails)), '通知に完全deviceIdなし');
  assert.strictEqual(w.secretProps['SECRET_' + op.id], pw, '秘密は別領域のみ');
  assert.strictEqual(w.callCount('deleteKey'), 0);
});

test('静穏時間: 内容/revisionが変わり続ける間は同期しない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  for (var i = 1; i <= 4; i++) {
    w.records = [H.record({ revision: i, endAt: H.jst('2030-01-11', '1' + (1 + i) + ':00') })];
    rt.syncCycle(); w.advance(120);
  }
  assert.strictEqual(w.callCount('createKey'), 0);
  assert.strictEqual(ops(w).length, 0);
  w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1);
});

test('コア追加点: 同期のたびに索引へ更新時刻を刻む（保持期限の起算）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  issueOne(w, rt);
  var idx = JSON.parse(w.props['BK_SNB-1']);
  assert.strictEqual(typeof idx.touchedAt, 'number');
  assert.ok(idx.touchedAt <= w.sec());
});

test('FREEZE（支払未確認）: 鍵操作せず管理者へ1回だけ通知。revisionとdigestの食い違いも停止', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record({ paymentStatus: 'pending', paymentConfirmedAt: '' })];
  for (var i = 0; i < 3; i++) { rt.syncCycle(); w.advance(300); }
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(w.mails.filter(function (m) { return /BOOKING_FROZEN/.test(m.subject); }).length, 1, '重複抑止');
  assert.ok(!/SNB-1.*taro|@/.test(w.mails[0].body.replace(/ops@example\.test/g, '')));

  var w2 = H.createWorld();
  var rt2 = w2.runtime();
  w2.records = [H.record()];
  rt2.syncCycle(); w2.advance(300); rt2.syncCycle(); // 同期済み(revision 1)
  w2.records = [H.record({ endAt: H.jst('2030-01-11', '15:00') })]; // 内容だけ変わり revision が増えていない
  w2.advance(300); rt2.syncCycle();
  assert.ok(w2.mails.some(function (m) { return /DIGEST_MISMATCH/.test(m.subject); }));
  assert.strictEqual(w2.callCount('deleteKey'), 0);
});

test('日付が動いても鍵操作記録が残る予約は照合対象に残り、旧キーが削除される', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var op = issueOne(w, rt);
  // 翌週へ延期 → 台帳リーダーは trackedIds のみで拾う
  w.ledger.read = function (ctx) {
    w.lastTracked = ctx.trackedIds;
    return { ok: true, records: ctx.trackedIds.indexOf('SNB-1') !== -1 ? [H.record({ revision: 2, startAt: H.jst('2030-01-20', '10:00'), endAt: H.jst('2030-01-20', '12:00') })] : [] };
  };
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.deepStrictEqual(Array.from(w.lastTracked), ['SNB-1']);
  assert.strictEqual(w.callCount('deleteKey'), 1);
  assert.ok(op);
});

test('台帳の読取失敗・列欠落は通知して照合を見送る（API呼び出しなし）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.ledgerFail = 'LEDGER_READ_FAILED';
  assert.strictEqual(rt.syncCycle().error, 'LEDGER_READ_FAILED');
  w.ledgerFail = 'LEDGER_SCHEMA_INVALID';
  rt.syncCycle();
  assert.strictEqual(w.calls.length, 0);
  assert.ok(w.mails.some(function (m) { return /LEDGER_READ_FAILED/.test(m.subject); }));
  assert.ok(w.mails.some(function (m) { return /LEDGER_SCHEMA_INVALID/.test(m.subject); }));
});

test('実行時間予算: 超過分は次周期へ回し、未解決の予約を先に処理する', function () {
  var w = H.createWorld({ cfg: { infra: { runBudgetSec: 1 } } });
  var rt = w.runtime();
  var t = 0;
  var deps = w.deps();
  deps.nowMs = function () { return w.nowMs + (t += 600); }; // 呼ぶたびに時間が進む
  var rt2 = Infra.createRuntime(deps, w.cfg);
  w.records = [H.record({ bookingId: 'A' }), H.record({ bookingId: 'B' }), H.record({ bookingId: 'C' })];
  var r = rt2.syncCycle();
  assert.ok(r.deferred >= 1, 'deferred=' + r.deferred);
  assert.ok(rt);
});

test('API予算: 当日の呼び出し数が予算に達したら見送り通知（変更APIを呼ばない）', function () {
  var w = H.createWorld({ cfg: { infra: { apiDailyBudget: 2 } } });
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var calls = w.calls.length;
  w.advance(300);
  var r = rt.syncCycle();
  assert.strictEqual(r.error, 'API_BUDGET_EXHAUSTED');
  assert.strictEqual(w.calls.length, calls);
  assert.ok(w.mails.some(function (m) { return /API_BUDGET_EXHAUSTED/.test(m.subject); }));
  w.advance(86400);
  assert.strictEqual(rt.admin('status', {}).apiCallsToday, 0, 'JST日替わりでリセット');
});

test('フラグOFF: 台帳もAPIも読まず、OP/秘密を作らない。配送も停止', function () {
  var w = H.createWorld({ cfg: { enabled: false, deliveryConfigured: true } });
  var rt = w.runtime();
  w.records = [H.record()];
  var r = rt.syncCycle();
  assert.strictEqual(r.skipped, 'FLAG_OFF');
  assert.strictEqual(w.ledgerCalls, 0);
  assert.strictEqual(w.calls.length, 0);
  assert.strictEqual(ops(w).length, 0);
  assert.deepStrictEqual(w.secrets.keys(), []);
  assert.strictEqual(rt.deliverCycle().skipped, 'FLAG_OFF');
});

test('配送: 未接続では何もしない。接続時も1回のみ。OFFにすると新コード配送は止まる', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  issueOne(w, rt);
  assert.strictEqual(rt.deliverCycle().skipped, 'DELIVERY_NOT_CONFIGURED');
  assert.strictEqual(w.delivered.length, 0);
  var on = w.runtime({ deliveryConfigured: true });
  assert.strictEqual(on.deliverCycle().delivered, 1);
  assert.strictEqual(on.deliverCycle().delivered, 0, '二重配送なし');
  assert.strictEqual(w.delivered.length, 1);
  var w2 = H.createWorld(); var rt2 = w2.runtime(); issueOne(w2, rt2);
  var off = w2.runtime({ deliveryConfigured: true, enabled: false });
  assert.strictEqual(off.deliverCycle().skipped, 'FLAG_OFF');
  assert.strictEqual(w2.delivered.length, 0);
});

test('状態保存の失敗: 例外を外へ出さず、送信前永続化に失敗したらcreateKeyを呼ばない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300);
  w.storeFail = function (k, v) { return k.indexOf('OP_') === 0 && /"state":"SENDING"/.test(v); };
  var r;
  assert.doesNotThrow(function () { r = rt.syncCycle(); });
  assert.strictEqual(r.error, 'SYNC_ERROR');
  assert.strictEqual(w.callCount('createKey'), 0);
  assert.ok(w.mails.some(function (m) { return /SYNC_ERROR/.test(m.subject); }));
  assert.strictEqual(w.locked, false, '失敗でもロックは解放');
});

test('取消と作成の競合: 取消済みの後に届いた遅延確定では発行しない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record({ status: 'CANCELLED', revision: 3 })];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  w.records = [H.record({ revision: 2 })]; // 古い確定
  w.advance(300); rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 0);
});

// ================================================================ ジョブ計画

test('ジョブ計画: 読取期限は周期から導出（600秒では3回目の読取前に停止し得る）。既定は実測値ではない', function () {
  var p = Infra.planJobs({});
  assert.strictEqual(p.readWaitSec, 2 * 300 + 120);
  assert.strictEqual(p.basis.maxReads, 'UNMEASURED_DEFAULT');
  assert.strictEqual(p.basis.webhookWaitSec, 'UNMEASURED_DEFAULT');
  assert.deepStrictEqual(Array.from(p.warnings), []);
  assert.ok(Infra.planJobs({ readWaitSec: 600 }).warnings.indexOf('READ_WINDOW_TOO_SHORT_FOR_CYCLE') !== -1);
});

test('commandIdなし削除: 5分周期でも導出した期限なら3回目の読取で確定でき、600秒固定では途中でUNKNOWN', function () {
  function run(readWaitSec) {
    var w = H.createWorld({ cfg: readWaitSec ? { readWaitSec: readWaitSec } : {} });
    w.createMode = 'noCommandId'; w.deleteMode = 'noCommandId';
    var rt = w.runtime();
    w.records = [H.record()];
    rt.syncCycle(); w.advance(300); rt.syncCycle();
    w.advance(300); rt.syncCycle(); // 反映確認
    assert.strictEqual(onlyOp(w).state, S.ISSUED_CONFIRMED);
    w.deleteAppliesAfterLists = 3;  // 3回目の読取で初めて反映が見える
    w.records = [H.record({ status: 'CANCELLED', revision: 2 })];
    rt.syncCycle(); w.advance(330); rt.syncCycle();
    w.advance(330); rt.syncCycle(); w.advance(330); rt.syncCycle();
    return onlyOp(w).state;
  }
  assert.strictEqual(run(null), S.DELETED_CONFIRMED);
  assert.strictEqual(run(600), S.UNKNOWN);
});

// ================================================================ ステータス・棚卸し

test('status/inventory: 件数・容量・監視情報のみ（秘密・完全ID・個人情報なし）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  issueOne(w, rt);
  var st = rt.admin('status', {});
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.unresolved, 1);
  assert.ok(st.storage.ratio > 0 && st.storage.ratio < 0.1);
  assert.ok(st.heartbeats.SYNC);
  var inv = rt.admin('inventory', {});
  assert.strictEqual(inv.items.length, 1);
  var dump = JSON.stringify(st) + JSON.stringify(inv);
  assert.ok(!dump.includes(H.DEV) && !dump.includes(w.createdPasswords[0]) && !/@/.test(dump));
});

// ================================================================ レビュー指摘（Codex P2）の回帰

test('未送信(PLANNED)の再開も発行ゲートを通る（容量が変わっていれば送信しない）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300);
  w.storeFail = function (k, v) { return k.indexOf('OP_') === 0 && /"state":"SENDING"/.test(v); };
  assert.strictEqual(rt.syncCycle().error, 'SYNC_ERROR');
  assert.strictEqual(onlyOp(w).state, S.PLANNED);
  w.storeFail = null;
  w.preload(H.DEV, 80); // 計画後に容量が閾値へ到達
  w.advance(300);
  var r = rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 0, '再開でも送信しない');
  assert.deepStrictEqual(Array.from(r.gateStops), ['CAPACITY_REACHED']);
  assert.strictEqual(onlyOp(w).state, S.PLANNED, '未送信のまま保持');
  // 容量が戻れば再開して1回だけ発行
  w.keys[H.DEV] = [];
  w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1);
});

test('管理者の照合は、退避済みの期限内Webhookを先に取り込む（OFFでもUNKNOWNへ誤って落とさない）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = onlyOp(w);
  w.advance(10);
  w.lockBusy = true;
  rt.handleWebhook(H.webhook({ commandId: op.commandId }), H.TOKEN, H.TOKEN);
  w.lockBusy = false;
  w.advance(290);
  var off = w.runtime({ enabled: false });
  var r = off.admin('reconcile', { recId: op.id });
  assert.deepStrictEqual({ ok: r.ok, state: r.state }, { ok: true, state: S.ISSUED_CONFIRMED });
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).length, 0);
});

test('受信箱でも食い違う結果を保持し、コアの矛盾検知で UNKNOWN になる（ロック有無で結果が変わらない）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  var op = onlyOp(w);
  w.advance(5);
  w.lockBusy = true;
  rt.handleWebhook(H.webhook({ commandId: op.commandId, result: 'success' }), H.TOKEN, H.TOKEN);
  w.advance(1);
  rt.handleWebhook(H.webhook({ commandId: op.commandId, result: 'failed' }), H.TOKEN, H.TOKEN);
  rt.handleWebhook(H.webhook({ commandId: op.commandId, result: 'failed' }), H.TOKEN, H.TOKEN); // 同一結果の重複は1件
  assert.strictEqual(w.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).length, 2);
  w.lockBusy = false;
  w.advance(294);
  rt.syncCycle();
  assert.strictEqual(onlyOp(w).state, S.UNKNOWN);
});

test('ゲート停止後に容量が解消したら、次の照合で1件だけ発行する（revision・発行窓を処理済みにしない）', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  w.preload(H.DEV, 80);
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300);
  var r = rt.syncCycle();                       // 初回: 容量到達でゲート停止
  assert.deepStrictEqual(Array.from(r.gateStops), ['CAPACITY_REACHED']);
  assert.strictEqual(w.callCount('createKey'), 0);
  assert.strictEqual(ops(w).length, 0);
  var trk = JSON.parse(w.props['TRK_SNB-1']);
  assert.notStrictEqual(trk.revision, 1, 'revisionを処理済みにしない');
  assert.strictEqual(!!trk.windowHandled, false, '発行窓を処理済みにしない');
  // 障害継続中: 発行なし。再評価は gateRetrySec 間隔、通知は重複しない
  var listsBefore = w.callCount('listDevices');
  w.advance(300); rt.syncCycle();               // 保留期間内 → ゲート再評価(API)しない
  assert.strictEqual(w.callCount('listDevices'), listsBefore);
  w.advance(300); rt.syncCycle();               // 保留明け → 再評価するが停止のまま
  assert.ok(w.callCount('listDevices') > listsBefore);
  assert.strictEqual(w.callCount('createKey'), 0);
  assert.strictEqual(w.mails.filter(function (m) { return /CAPACITY_REACHED/.test(m.subject); }).length, 1);
  // 容量解消 → 保留明けの次の照合で1件だけ発行（同revision）
  w.keys[H.DEV] = [];
  w.advance(700); rt.syncCycle();
  w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1);
  assert.strictEqual(ops(w).length, 1);
  assert.strictEqual(ops(w)[0].revision, 1);
  w.advance(300); rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1, '以降も二重発行しない');
});

test('容量不明(keyList取得不能)で停止した場合も、復旧後に発行対象から脱落しない', function () {
  var w = H.createWorld();
  var rt = w.runtime();
  var origList = w.api.listDevices;
  w.api.listDevices = function () { w.calls.push({ name: 'listDevices' }); return { ok: false, error: 'LIST_API_ERROR' }; };
  w.records = [H.record()];
  rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 0);
  w.api.listDevices = origList;
  w.advance(700); rt.syncCycle(); w.advance(300); rt.syncCycle();
  assert.strictEqual(w.callCount('createKey'), 1);
});
