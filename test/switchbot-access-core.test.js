/*
 * gas/switchbot-access/SwitchBotAccessCore.gs のテスト（Issue #748）。
 * 実 API・実機には接続しない。秘密を使わないフェイクのみ。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');
var C = require('../gas/switchbot-access/SwitchBotAccessCore.gs');
var S = C.STATE;

var DEV_A = 'AAAAAAAAAAAA37DD';
var DEV_B = 'BBBBBBBBBBBB1234';
var NOW = C.jstToEpochSec('2030-01-10', '09:00');

function baseConfig(over) {
  return Object.assign({
    enabled: true, commercialUseApproved: true,
    eligiblePaymentStatuses: ['paid'], eligibleBrands: ['studio'],
    graceBeforeSec: 600, graceAfterSec: 900,
    keypads: [{ brand: 'studio', facility: 'main', room: 'A', deviceId: DEV_A }, { brand: 'studio', facility: 'main', room: 'B', deviceId: DEV_B }],
    maxReads: 3, webhookWaitSec: 90
  }, over || {});
}

function booking(over) {
  return Object.assign({
    bookingId: 'BK1', revision: 1, status: 'CONFIRMED', paymentStatus: 'paid', brand: 'studio',
    facility: 'main', room: 'A', date: '2030-01-11', startTime: '10:00', endTime: '12:00'
  }, over || {});
}

/** フェイク SwitchBot + 永続層。mode でレスポンス挙動を切り替える。 */
function world(opts) {
  opts = opts || {};
  var w = {
    now: NOW, store: {}, secrets: {}, notes: [], delivered: [], calls: [], seq: 100,
    keys: { [DEV_A]: [], [DEV_B]: [] },
    createMode: 'commandId', // commandId | noCommandId | dropResponse | reject | silentNoApply | duplicateApply
    deleteMode: 'ok',        // ok | dropResponse | noApply
    listMode: 'ok',          // ok | fail | throw | nonArray | noKeyList
    notifyFail: false, failSetOnKey: null, setCount: 0
  };
  w.engineDeps = function () {
    return {
      store: {
        get: function (k) { return w.store[k] === undefined ? null : w.store[k]; },
        set: function (k, v) {
          w.setCount++;
          if (w.failSetOnKey && k.indexOf(w.failSetOnKey.prefix) === 0 && w.failSetOnKey.state && JSON.parse(v).state === w.failSetOnKey.state) {
            throw new Error('STORE_FAIL');
          }
          w.store[k] = v;
        },
        del: function (k) { delete w.store[k]; },
        keys: function () { return Object.keys(w.store); }
      },
      secrets: {
        get: function (k) { return w.secrets[k] === undefined ? null : w.secrets[k]; },
        set: function (k, v) { w.secrets[k] = v; },
        del: function (k) { delete w.secrets[k]; }
      },
      lock: function (keys, fn) { return fn(); },
      api: {
        listDevices: function () {
          w.calls.push('list');
          if (w.listMode === 'throw') throw new Error('NET');
          if (w.listMode === 'fail') return { ok: false };
          if (w.listMode === 'nonArray') return { ok: true, devices: null };
          return { ok: true, devices: Object.keys(w.keys).map(function (id) {
            var d = { deviceId: id, deviceType: 'Keypad' };
            if (w.listMode !== 'noKeyList') d.keyList = w.keys[id].map(function (k) { return Object.assign({}, k); });
            return d;
          }) };
        },
        createKey: function (p) {
          w.calls.push('create');
          var apply = function () {
            w.keys[p.deviceId].push({ id: String(++w.seq), name: p.name, type: 'timeLimit', startTime: String(p.startTime), endTime: String(p.endTime) });
          };
          if (w.createMode === 'reject') return { httpCode: 400, parsed: { statusCode: 190 } };
          if (w.createMode === 'dropResponse') { apply(); throw new Error('NET'); }
          if (w.createMode === 'silentNoApply') return { httpCode: 200, parsed: { statusCode: 100, body: {} } };
          if (w.createMode === 'duplicateApply') { apply(); apply(); }
          else apply();
          return { httpCode: 200, parsed: { statusCode: 100, body: w.createMode === 'commandId' ? { commandId: 'CMD' + w.seq } : {} } };
        },
        deleteKey: function (dev, id) {
          w.calls.push('delete:' + id);
          if (w.deleteMode === 'dropResponse') { w.keys[dev] = w.keys[dev].filter(function (k) { return k.id !== id; }); throw new Error('NET'); }
          if (w.deleteMode !== 'noApply') w.keys[dev] = w.keys[dev].filter(function (k) { return k.id !== id; });
          return { httpCode: 200, parsed: { statusCode: 100, body: {} } };
        }
      },
      notifyAdmin: function (e) { if (w.notifyFail) throw new Error('SLACK'); w.notes.push(e); },
      deliverCode: function (ref, code, win) { w.delivered.push({ ref: ref, code: code, win: win }); },
      sha256Hex: function (s) { return crypto.createHash('sha256').update(s).digest('hex'); },
      randomInt: function (n) { return crypto.randomInt(n); },
      nowSec: function () { return w.now; }
    };
  };
  w.engine = function (cfg) { return C.createEngine(w.engineDeps(), cfg || baseConfig()); };
  w.mutations = function () { return w.calls.filter(function (c) { return c === 'create' || c.indexOf('delete:') === 0; }); };
  w.records = function () {
    return Object.keys(w.store).filter(function (k) { return k.indexOf('OP_') === 0; }).map(function (k) { return JSON.parse(w.store[k]); });
  };
  return w;
}

// ---------- 判定・純関数 ----------

test('JST変換: JST 10:00 は UTC 01:00', function () {
  assert.strictEqual(C.jstToEpochSec('2030-01-11', '10:00'), Date.UTC(2030, 0, 11, 1, 0, 0) / 1000);
  assert.strictEqual(C.jstToEpochSec('2030-02-30', '10:00'), null);
  assert.strictEqual(C.jstToEpochSec('bad', '10:00'), null);
});

test('対象判定: 確定+支払済+対象ブランドで期間は猶予込み（推測値なし）', function () {
  var e = C.evaluateEligibility(booking(), baseConfig(), NOW);
  assert.strictEqual(e.eligible, true);
  assert.strictEqual(e.deviceId, DEV_A);
  assert.strictEqual(e.startSec, C.jstToEpochSec('2030-01-11', '10:00') - 600);
  assert.strictEqual(e.endSec, C.jstToEpochSec('2030-01-11', '12:00') + 900);
});

test('対象判定: 非対象は理由付きで停止', function () {
  var cases = [
    [booking({ status: 'PENDING' }), baseConfig(), 'NOT_CONFIRMED'],
    [booking({ status: 'CANCELLED' }), baseConfig(), 'NOT_CONFIRMED'],
    [booking({ paymentStatus: 'checkout_pending' }), baseConfig(), 'PAYMENT_NOT_ELIGIBLE'],
    [booking({ brand: 'mens' }), baseConfig(), 'BRAND_NOT_TARGET'],
    [booking(), baseConfig({ enabled: false }), 'FLAG_OFF'],
    [booking(), baseConfig({ commercialUseApproved: undefined }), 'COMMERCIAL_USE_NOT_APPROVED'],
    [booking(), baseConfig({ graceBeforeSec: undefined }), 'GRACE_NOT_CONFIGURED'],
    [booking({ room: 'Z' }), baseConfig(), 'KEYPAD_NOT_CONFIGURED'],
    [booking({ date: '2030-01-01' }), baseConfig(), 'ALREADY_ENDED'],
    [booking({ startTime: '12:00', endTime: '10:00' }), baseConfig(), 'TIME_INVALID']
  ];
  cases.forEach(function (c) { assert.strictEqual(C.evaluateEligibility(c[0], c[1], NOW).reason, c[2], c[2]); });
});

test('Keypad選択: 複数候補は停止しフォールバックしない', function () {
  var cfg = baseConfig({ keypads: [{ brand: 'studio', facility: 'main', room: 'A', deviceId: DEV_A }, { brand: 'studio', facility: 'main', room: 'A', deviceId: DEV_B }] });
  assert.strictEqual(C.evaluateEligibility(booking(), cfg, NOW).reason, 'KEYPAD_AMBIGUOUS');
});

test('keyList判定: 0件/複数件/ID欠落/属性矛盾/形式不正は確認済みにしない', function () {
  var exp = { startSec: 10, endSec: 20 };
  function j(devs) { return C.judgeIssued(C.inspectKeyList(devs, DEV_A, 'N'), exp); }
  assert.strictEqual(j([{ deviceId: DEV_A, keyList: [] }]).error, 'KEY_NOT_FOUND');
  assert.strictEqual(j([{ deviceId: DEV_A, keyList: [{ id: '1', name: 'N' }, { id: '2', name: 'N' }] }]).error, 'KEY_NAME_AMBIGUOUS');
  assert.strictEqual(j([{ deviceId: DEV_A, keyList: [{ name: 'N' }] }]).error, 'KEY_ID_MISSING');
  assert.strictEqual(j([{ deviceId: DEV_A, keyList: [{ id: '1', name: 'N', endTime: '99' }] }]).error, 'KEY_ATTR_MISMATCH');
  assert.strictEqual(j([{ deviceId: DEV_A }]).error, 'KEYLIST_INVALID');
  assert.strictEqual(j(null).error, 'DEVICE_LIST_INVALID');
  assert.strictEqual(j([{ deviceId: DEV_B, keyList: [] }]).error, 'DEVICE_NOT_FOUND');
  assert.deepStrictEqual(j([{ deviceId: DEV_A, keyList: [{ id: 7, name: 'N', startTime: '10', endTime: '20' }] }]), { ok: true, id: '7' });
});

// ---------- 発行 ----------

test('フラグOFF: API を一切呼ばず何も保存しない', function () {
  var w = world();
  var r = w.engine(baseConfig({ enabled: false })).sync(booking());
  assert.strictEqual(r.skipped, 'FLAG_OFF');
  assert.deepStrictEqual(w.calls, []);
  assert.deepStrictEqual(Object.keys(w.store), []);
});

test('正常: 確定1件で1キーのみ発行し keyList で確認、予約へ一意に紐付く', function () {
  var w = world();
  w.createMode = 'noCommandId';
  var e = w.engine();
  e.sync(booking());
  assert.strictEqual(w.mutations().length, 1);
  var rec = w.records()[0];
  assert.strictEqual(rec.state, S.ISSUED_CONFIRMED);
  assert.deepStrictEqual(rec.evidence, ['KEYLIST_CONFIRMED']);
  assert.strictEqual(rec.bookingId, 'BK1');
  assert.strictEqual(rec.passcodeId, w.keys[DEV_A][0].id);
  assert.strictEqual(w.keys[DEV_B].length, 0);
  assert.ok(/^SNB-[0-9a-f]{16}$/.test(rec.name), 'キー名に個人情報を含まない');
});

test('冪等: 同一イベントの再配信・ジョブ再実行で二重発行しない', function () {
  var w = world();
  w.createMode = 'noCommandId';
  var e = w.engine();
  e.sync(booking()); e.sync(booking()); w.engine().sync(booking());
  assert.strictEqual(w.keys[DEV_A].length, 1);
  assert.strictEqual(w.mutations().length, 1);
});

test('非対象/未確定/取消済みでは発行しない', function () {
  var w = world();
  var e = w.engine();
  e.sync(booking({ status: 'PENDING' }));
  e.sync(booking({ bookingId: 'BK2', status: 'CANCELLED' }));
  e.sync(booking({ bookingId: 'BK3', paymentStatus: 'failed' }));
  assert.deepStrictEqual(w.mutations(), []);
});

test('commandIdあり: Webhook成功+keyList一致の両根拠を別々に保存して確認済み', function () {
  var w = world();
  var e = w.engine();
  e.sync(booking());
  var rec = w.records()[0];
  assert.strictEqual(rec.state, S.SENT_WAIT_WEBHOOK);
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', eventName: 'createKey ', commandId: rec.commandId, result: 'success' } });
  e.sync(booking());
  rec = w.records()[0];
  assert.strictEqual(rec.state, S.ISSUED_CONFIRMED);
  assert.deepStrictEqual(rec.evidence, ['WEBHOOK_SUCCESS', 'KEYLIST_CONFIRMED']);
  assert.strictEqual(w.mutations().length, 1);
});

test('commandIdあり: Webhook failed は FAILED、無関係/重複/他commandIdは状態を変えない', function () {
  var w = world();
  var e = w.engine();
  e.sync(booking());
  var rec = w.records()[0];
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', eventName: 'createKey', commandId: 'OTHER', result: 'success' } });
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoLock', eventName: 'createKey', commandId: rec.commandId, result: 'success' } });
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.SENT_WAIT_WEBHOOK);
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', eventName: 'createKey', commandId: rec.commandId, result: 'failed' } });
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', eventName: 'createKey', commandId: rec.commandId, result: 'success' } });
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.FAILED);
});

test('commandIdあり: Webhook未着のまま待機超過で UNKNOWN、変更APIは再送しない', function () {
  var w = world();
  var e = w.engine();
  e.sync(booking());
  w.now += 200;
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.mutations().length, 1);
  e.sync(booking());
  assert.strictEqual(w.mutations().length, 1);
  assert.ok(w.notes.some(function (n) { return n.code === 'WEBHOOK_TIMEOUT'; }));
});

test('Webhook成功だがkeyListに無い場合は矛盾として UNKNOWN（成功へ寄せない）', function () {
  var w = world();
  var e = w.engine();
  e.sync(booking());
  var rec = w.records()[0];
  w.keys[DEV_A] = [];
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', eventName: 'createKey', commandId: rec.commandId, result: 'success' } });
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

test('commandIdなし: 作成後0件は上限まで読み取りのみで待ち、超過で UNKNOWN（再送なし）', function () {
  var w = world();
  w.createMode = 'silentNoApply';
  var e = w.engine();
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.ACCEPTED_NO_COMMAND_ID);
  e.sync(booking()); e.sync(booking()); e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.mutations().length, 1);
});

test('commandIdなし: 作成後に複数件は UNKNOWN', function () {
  var w = world();
  w.createMode = 'duplicateApply';
  w.engine().sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'KEY_NAME_AMBIGUOUS');
});

test('作成前の keyList に同名が既存なら送信しない', function () {
  var w = world();
  var e = w.engine();
  var name = crypto.createHash('sha256').update(['BK1', 1, DEV_A, 'ISSUE', 1].join('|')).digest('hex').slice(0, 16);
  w.keys[DEV_A].push({ id: '1', name: 'SNB-' + name });
  e.sync(booking());
  assert.deepStrictEqual(w.mutations(), []);
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

test('API拒否(4xx)は FAILED、通信断(応答欠落)は UNKNOWN で再送しない', function () {
  var w = world();
  w.createMode = 'reject';
  w.engine().sync(booking());
  assert.strictEqual(w.records()[0].state, S.FAILED);
  assert.strictEqual(Object.keys(w.secrets).length, 0, '秘密は破棄');

  var w2 = world();
  w2.createMode = 'dropResponse';
  var e2 = w2.engine();
  e2.sync(booking()); e2.sync(booking());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w2.mutations().length, 1);
});

test('keyList取得失敗/通信断/形式不正は事前確認で停止し送信しない', function () {
  ['fail', 'throw', 'nonArray', 'noKeyList'].forEach(function (mode) {
    var w = world();
    w.listMode = mode;
    w.engine().sync(booking());
    assert.deepStrictEqual(w.mutations(), [], mode);
    assert.strictEqual(w.records()[0].state, S.UNKNOWN, mode);
  });
});

test('クラッシュ: 送信前の保存失敗では送信しない', function () {
  var w = world();
  w.failSetOnKey = { prefix: 'OP_', state: S.SENDING };
  assert.throws(function () { w.engine().sync(booking()); }, /STORE_FAIL/);
  assert.deepStrictEqual(w.mutations(), []);
  w.failSetOnKey = null;
  // 再実行: PLANNED から再開（未送信が確実）して1回だけ送信
  w.engine().sync(booking());
  assert.strictEqual(w.mutations().length, 1);
  assert.strictEqual(w.keys[DEV_A].length, 1);
});

test('クラッシュ: 送信後の結果保存失敗 → 再起動後 SENDING は UNKNOWN で再送しない', function () {
  var w = world();
  w.createMode = 'noCommandId';
  w.failSetOnKey = { prefix: 'OP_', state: S.ACCEPTED_NO_COMMAND_ID };
  assert.throws(function () { w.engine().sync(booking()); }, /STORE_FAIL/);
  assert.strictEqual(w.mutations().length, 1);
  assert.strictEqual(w.records()[0].state, S.SENDING);
  w.failSetOnKey = null;
  w.engine().sync(booking());
  w.engine().sync(booking());
  assert.strictEqual(w.mutations().length, 1, '再送されない');
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

test('管理者復旧: UNKNOWN は keyList 検証付きで確認/放棄でき、放棄後のみ新 attempt', function () {
  var w = world();
  w.createMode = 'noCommandId';
  w.failSetOnKey = { prefix: 'OP_', state: S.ACCEPTED_NO_COMMAND_ID };
  assert.throws(function () { w.engine().sync(booking()); });
  w.failSetOnKey = null;
  var e = w.engine();
  e.sync(booking());
  var id = w.records()[0].id;
  assert.strictEqual(e.adminResolveUnknown(id, 'ABANDON_ABSENT', 'ops').error, 'KEY_STILL_PRESENT');
  assert.strictEqual(e.adminResolveUnknown(id, 'CONFIRM_PRESENT', '').error, 'ACTOR_REQUIRED');
  assert.strictEqual(e.adminResolveUnknown(id, 'CONFIRM_PRESENT', 'ops').ok, true);
  assert.deepStrictEqual(w.records()[0].evidence, ['ADMIN_KEYLIST']);
  assert.strictEqual(w.mutations().length, 1);

  var w2 = world();
  w2.createMode = 'silentNoApply';
  var e2 = w2.engine();
  e2.sync(booking()); e2.sync(booking()); e2.sync(booking()); e2.sync(booking());
  var id2 = w2.records()[0].id;
  assert.strictEqual(e2.adminResolveUnknown(id2, 'ABANDON_ABSENT', 'ops').state, S.ABANDONED);
  w2.createMode = 'noCommandId';
  e2.sync(booking());
  assert.strictEqual(w2.records().length, 2);
  assert.strictEqual(w2.records()[1].attempt, 2);
  assert.strictEqual(w2.records()[1].state, S.ISSUED_CONFIRMED);
});

test('同時実行相当: 別インスタンスから同じイベントが交互に来ても1件', function () {
  var w = world();
  w.createMode = 'noCommandId';
  var a = w.engine(), b = w.engine();
  a.sync(booking()); b.sync(booking()); a.sync(booking()); b.sync(booking());
  assert.strictEqual(w.mutations().length, 1);
});

// ---------- 受渡し・秘密 ----------

test('受渡し: 確認済み後にのみ1回だけ。未確認では渡さない', function () {
  var w = world();
  w.createMode = 'silentNoApply';
  var e = w.engine();
  e.sync(booking());
  assert.strictEqual(e.deliver(w.records()[0].id).reason, 'NOT_CONFIRMED');
  var w2 = world();
  w2.createMode = 'noCommandId';
  var e2 = w2.engine();
  e2.sync(booking());
  var id = w2.records()[0].id;
  assert.strictEqual(e2.deliver(id).delivered, true);
  assert.strictEqual(e2.deliver(id).reason, 'ALREADY_DELIVERED');
  assert.strictEqual(w2.delivered.length, 1);
  assert.ok(/^[0-9]{8}$/.test(w2.delivered[0].code));
});

test('秘密非出力: 状態にコードなし・通知/棚卸しにコードと完全deviceIdが含まれない', function () {
  var w = world();
  w.createMode = 'dropResponse';
  var e = w.engine();
  e.sync(booking());
  var code = Object.keys(w.secrets).map(function (k) { return w.secrets[k]; })[0];
  assert.ok(code);
  // 状態ストアは権限限定領域（Keypad操作に完全deviceIdが必要）。passcode は別領域のみ。
  assert.ok(JSON.stringify(w.store).indexOf(code) === -1, '状態ストアに passcode なし');
  var dump = JSON.stringify(w.notes);
  assert.ok(dump.indexOf(code) === -1, '通知に passcode なし');
  assert.ok(dump.indexOf(DEV_A) === -1, '通知に完全deviceIdなし');
  assert.ok(JSON.stringify(e.inventory()).indexOf(DEV_A) === -1);
});

// ---------- 変更・取消・期限切れ ----------

function issued(w, e, b) {
  w.createMode = 'noCommandId';
  e.sync(b || booking());
  return w.records()[w.records().length - 1];
}

test('取消: 旧キーを削除し keyList 消失を確認して削除確定', function () {
  var w = world();
  var e = w.engine();
  issued(w, e);
  e.sync(booking({ revision: 2, status: 'CANCELLED' }));
  var rec = w.records()[0];
  assert.strictEqual(rec.state, S.DELETED_CONFIRMED);
  assert.strictEqual(w.keys[DEV_A].length, 0);
  assert.strictEqual(Object.keys(w.secrets).length, 0);
});

test('取消後に遅延した旧確定イベントでは発行しない（古い改訂・同改訂）', function () {
  var w = world();
  var e = w.engine();
  e.sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(e.sync(booking({ revision: 1 })).skipped, 'STALE_REVISION');
  assert.strictEqual(e.sync(booking({ revision: 2 })).skipped, 'AFTER_CANCEL');
  assert.deepStrictEqual(w.mutations(), []);
});

test('期間延長/短縮: 旧キー削除確認後に新キーを発行（併存しない）', function () {
  var w = world();
  var e = w.engine();
  var first = issued(w, e);
  e.sync(booking({ revision: 2, endTime: '14:00' }));
  var recs = w.records();
  assert.strictEqual(recs.length, 2);
  assert.strictEqual(recs[0].state, S.DELETED_CONFIRMED);
  assert.strictEqual(recs[1].state, S.ISSUED_CONFIRMED);
  assert.strictEqual(w.keys[DEV_A].length, 1);
  assert.notStrictEqual(recs[1].name, first.name);
  assert.strictEqual(recs[1].endSec, C.jstToEpochSec('2030-01-11', '14:00') + 900);
});

test('部屋(Keypad)変更: 旧Keypadのキーだけ削除し新Keypadへ発行、他Keypad/他キーは無影響', function () {
  var w = world();
  var e = w.engine();
  w.keys[DEV_A].push({ id: 'NORMAL', name: 'regular-code', type: 'permanent' });
  issued(w, e);
  e.sync(booking({ revision: 2, room: 'B' }));
  assert.strictEqual(w.keys[DEV_A].length, 1);
  assert.strictEqual(w.keys[DEV_A][0].id, 'NORMAL');
  assert.strictEqual(w.keys[DEV_B].length, 1);
});

test('旧キー削除が不明のまま新キーを自動発行しない（削除結果不明 → UNKNOWN + 通知）', function () {
  var w = world();
  var e = w.engine();
  issued(w, e);
  w.deleteMode = 'noApply';
  var r = e.sync(booking({ revision: 2, endTime: '14:00' }));
  var states = w.records().map(function (x) { return x.state; });
  assert.ok(states.indexOf(S.UNKNOWN) !== -1 || states.indexOf(S.DELETE_SENT) !== -1);
  assert.strictEqual(w.records().length, 1, '新キーは作らない');
  assert.strictEqual(w.mutations().filter(function (c) { return c === 'create'; }).length, 1);
  assert.ok(r);
  e.sync(booking({ revision: 2, endTime: '14:00' })); e.sync(booking({ revision: 2, endTime: '14:00' }));
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length, 1, 'deleteKey は再送しない');
  assert.ok(w.notes.some(function (n) { return n.code === 'KEY_REMAINS'; }));
});

test('削除: 送信前から不在なら ALREADY_ABSENT（API削除成功を捏造しない）', function () {
  var w = world();
  var e = w.engine();
  issued(w, e);
  w.keys[DEV_A] = [];
  e.sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(w.records()[0].state, S.ALREADY_ABSENT);
  assert.strictEqual(w.mutations().length, 1, 'deleteKey 未送信');
});

test('削除: ID不一致・複数件・照会不能は送信しない', function () {
  var w = world();
  var e = w.engine();
  issued(w, e);
  w.keys[DEV_A][0].id = 'DIFFERENT';
  e.sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length, 0);

  var w2 = world();
  var e2 = w2.engine();
  issued(w2, e2);
  w2.listMode = 'fail';
  e2.sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w2.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length, 0);
});

test('削除の応答欠落: deleteKey は再送せず UNKNOWN、実際に消えていても推測確定しない', function () {
  var w = world();
  var e = w.engine();
  issued(w, e);
  w.deleteMode = 'dropResponse';
  e.sync(booking({ revision: 2, status: 'CANCELLED' }));
  e.sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length, 1);
});

test('期限切れ: EXPIRED は削除と区別し、残存なしで ARCHIVED_EXPIRED、残存時は通知', function () {
  var w = world();
  var e = w.engine();
  issued(w, e);
  w.now = w.records()[0].endSec + 10;
  e.sweep();
  assert.strictEqual(w.records()[0].state, S.EXPIRED);
  assert.ok(w.notes.some(function (n) { return n.code === 'EXPIRED_KEY_REMAINS'; }));
  assert.strictEqual(e.adminDelete(w.records()[0].id, 'ops').ok, true);
  assert.strictEqual(w.records()[0].state, S.DELETED_CONFIRMED);

  var w2 = world();
  var e2 = w2.engine();
  issued(w2, e2);
  w2.keys[DEV_A] = [];
  w2.now = w2.records()[0].endSec + 10;
  e2.sweep();
  assert.strictEqual(w2.records()[0].state, S.ARCHIVED_EXPIRED);
});

test('保持期限: 終端のみ破棄し、未解決(UNKNOWN)は破棄しない', function () {
  var w = world();
  w.createMode = 'dropResponse';
  var e = w.engine(baseConfig({ retentionSec: 100 }));
  e.sync(booking());
  w.now += 1000000;
  e.sweep();
  assert.strictEqual(w.records().length, 1);
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

// ---------- 通知・OFF・ロールバック ----------

test('通知: 重複抑止し、通知失敗時は次回再通知', function () {
  var w = world();
  w.createMode = 'dropResponse';
  w.notifyFail = true;
  var e = w.engine();
  e.sync(booking());
  assert.strictEqual(w.notes.length, 0);
  w.notifyFail = false;
  e.sync(booking({ revision: 1 })); // UNKNOWN 維持。OLD_KEY_UNRESOLVED は同改訂のため通知しない
  var cnt = w.notes.length;
  e.sync(booking({ revision: 1 }));
  assert.strictEqual(w.notes.length, cnt, '重複通知なし');
});

test('ロールバック: フラグOFF後も発行済みは残り、管理経路の削除/棚卸しが使え createKey は再送されない', function () {
  var w = world();
  var on = w.engine();
  var rec = issued(w, on);
  var off = w.engine(baseConfig({ enabled: false }));
  var before = w.mutations().length;
  off.sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(w.mutations().length, before, 'OFF では自動処理しない');
  assert.strictEqual(w.keys[DEV_A].length, 1, 'フラグOFFだけではキーは消えない');
  var inv = off.inventory();
  assert.strictEqual(inv[0].unresolved, true);
  assert.strictEqual(off.adminDelete(rec.id, 'ops').ok, true);
  assert.strictEqual(w.keys[DEV_A].length, 0);
  assert.strictEqual(w.mutations().filter(function (c) { return c === 'create'; }).length, 1);
});

test('別予約のキーは影響を受けない', function () {
  var w = world();
  var e = w.engine();
  w.createMode = 'noCommandId';
  e.sync(booking());
  e.sync(booking({ bookingId: 'BK2', startTime: '15:00', endTime: '17:00' }));
  assert.strictEqual(w.keys[DEV_A].length, 2);
  e.sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(w.keys[DEV_A].length, 1);
  assert.strictEqual(w.records().filter(function (r) { return r.bookingId === 'BK2'; })[0].state, S.ISSUED_CONFIRMED);
});

// ---------- レビュー指摘 (Codex) の回帰 ----------

test('PLANNED再開: 取消/非対象になっていたら createKey せず計画を破棄する', function () {
  var w = world();
  w.failSetOnKey = { prefix: 'OP_', state: S.SENDING };
  assert.throws(function () { w.engine().sync(booking()); }, /STORE_FAIL/);
  w.failSetOnKey = null;
  w.engine().sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.deepStrictEqual(w.mutations(), []);
  assert.strictEqual(w.records()[0].state, S.ABANDONED);
  assert.strictEqual(Object.keys(w.secrets).length, 0);
});

test('PLANNED再開: 改訂/期間が変わっていたら旧計画は破棄し新計画で1件だけ発行', function () {
  var w = world();
  w.createMode = 'noCommandId';
  w.failSetOnKey = { prefix: 'OP_', state: S.SENDING };
  assert.throws(function () { w.engine().sync(booking()); });
  w.failSetOnKey = null;
  w.engine().sync(booking({ revision: 2, endTime: '14:00' }));
  assert.strictEqual(w.mutations().length, 1);
  assert.strictEqual(w.records()[0].state, S.ABANDONED);
  assert.strictEqual(w.records()[1].state, S.ISSUED_CONFIRMED);
  assert.strictEqual(w.records()[1].endSec, C.jstToEpochSec('2030-01-11', '14:00') + 900);
});

test('受渡し: ロック下で行い、受渡し中の取消で削除済み状態を上書きしない', function () {
  var w = world();
  w.createMode = 'noCommandId';
  var deps = w.engineDeps();
  var held = [];
  deps.lock = function (keys, fn) { held.push(keys.join(',')); return fn(); };
  var e;
  deps.deliverCode = function () { e.sync(booking({ revision: 2, status: 'CANCELLED' })); };
  e = C.createEngine(deps, baseConfig());
  e.sync(booking());
  var id = w.records()[0].id;
  e.deliver(id);
  assert.ok(held.some(function (h) { return h.indexOf('BOOKING_BK1') === 0; }));
  assert.notStrictEqual(w.records()[0].state, S.ISSUED_CONFIRMED, '削除済みを ISSUED に戻さない');
});

test('通知失敗: UNKNOWN の通知は後続の sync/sweep で再試行される', function () {
  var w = world();
  w.createMode = 'dropResponse';
  w.notifyFail = true;
  var e = w.engine();
  e.sync(booking());
  assert.strictEqual(w.notes.length, 0);
  w.notifyFail = false;
  e.sync(booking());
  assert.strictEqual(w.notes.length, 1);
  e.sync(booking()); e.sweep();
  assert.strictEqual(w.notes.length, 1, '成功後は重複しない');
});

test('フラグOFF: adminReconcile で DELETE_SENT の読み取り照合を再開でき、deleteKey は再送しない', function () {
  var w = world();
  var on = w.engine(baseConfig({ maxReads: 5 }));
  issued(w, on);
  w.deleteMode = 'noApply';
  on.sync(booking({ revision: 2, status: 'CANCELLED' }));
  assert.strictEqual(w.records()[0].state, S.DELETE_SENT);
  var off = w.engine(baseConfig({ enabled: false, maxReads: 5 }));
  var id = w.records()[0].id;
  assert.strictEqual(off.adminReconcile(id, '').error, 'NOT_FOUND_OR_NO_ACTOR');
  w.keys[DEV_A] = []; // 遅れて端末側で削除が反映
  assert.strictEqual(off.adminReconcile(id, 'ops').state, S.DELETED_CONFIRMED);
  assert.strictEqual(w.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length, 1);
});

test('adminDelete: ロック取得後に再読込し、重複呼出しで deleteKey を再送しない', function () {
  var w = world();
  var deps = w.engineDeps();
  var e;
  var recId;
  var nested = false;
  deps.lock = function (keys, fn) {
    if (!nested) { nested = true; e.adminDelete(recId, 'ops2'); } // 先行する管理削除が先にロックを得た状況
    return fn();
  };
  e = C.createEngine(deps, baseConfig());
  w.createMode = 'noCommandId';
  var sdeps = w.engineDeps(); // 発行は通常ロックで
  C.createEngine(sdeps, baseConfig()).sync(booking());
  recId = w.records()[0].id;
  w.deleteMode = 'noApply';
  e.adminDelete(recId, 'ops1');
  assert.strictEqual(w.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length, 1);
});

test('受渡し: 管理者が存在確認した UNKNOWN でも、取消済み/置換済みの予約には渡さない', function () {
  var w = world();
  w.createMode = 'dropResponse';
  var e = w.engine();
  e.sync(booking());
  e.sync(booking({ revision: 2, status: 'CANCELLED' }));
  var id = w.records()[0].id;
  assert.strictEqual(e.adminResolveUnknown(id, 'CONFIRM_PRESENT', 'ops').ok, true);
  assert.strictEqual(e.deliver(id).reason, 'NOT_CURRENT');
  assert.deepStrictEqual(w.delivered, []);
});

test('期間のみ変更(同改訂): attempt を名前空間全体で採番し、旧 record を上書き・重複索引しない', function () {
  var w = world();
  var e = w.engine();
  issued(w, e);
  e.sync(booking({ endTime: '14:00' })); // 改訂は同じ(1)で期間だけ変更
  var recs = w.records();
  assert.strictEqual(recs.length, 2);
  assert.notStrictEqual(recs[0].id, recs[1].id);
  assert.strictEqual(recs[0].state, S.DELETED_CONFIRMED);
  assert.strictEqual(recs[1].state, S.ISSUED_CONFIRMED);
  var idx = JSON.parse(w.store['BK_BK1']);
  assert.strictEqual(idx.ops.length, 2);
  w.deleteMode = 'noApply';
  e.sync(booking({ endTime: '14:00', status: 'CANCELLED' }));
  assert.strictEqual(w.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length, 2, '旧1回+現行1回のみ');
});
