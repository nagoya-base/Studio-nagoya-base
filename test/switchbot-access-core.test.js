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
    notifyFail: false, failSetOnKey: null, setCount: 0,
    idMode: 'string',        // string | number（#799: SwitchBot 実機の keyList.id は NUMBER）
    onList: null             // listDevices 呼出し時のフック（鮮度・直前変化の模擬）
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
          if (w.onList) w.onList();
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
            w.keys[p.deviceId].push({ id: w.idMode === 'number' ? ++w.seq : String(++w.seq), name: p.name, type: 'timeLimit', startTime: String(p.startTime), endTime: String(p.endTime) });
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
      deliveryGate: function () { return { ok: true }; }, // 送信直前ゲート（#752）。コア単体では常に通し、ゲート自体は infra / delivery テストで検証する
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

test('限定稼働(#757): pilotBookingIds は列挙された予約だけを対象にし、未設定は従来どおり', function () {
  var id = booking().bookingId;
  assert.strictEqual(C.evaluateEligibility(booking(), baseConfig(), NOW).eligible, true, '未設定は制限なし');
  assert.strictEqual(C.evaluateEligibility(booking(), baseConfig({ pilotBookingIds: [id] }), NOW).eligible, true);
  assert.strictEqual(C.evaluateEligibility(booking(), baseConfig({ pilotBookingIds: ['OTHER'] }), NOW).reason, 'NOT_PILOT_TARGET');
  assert.strictEqual(C.evaluateEligibility(booking(), baseConfig({ pilotBookingIds: [] }), NOW).reason, 'NOT_PILOT_TARGET', '空配列は全件停止');
  assert.strictEqual(C.evaluateEligibility(booking(), baseConfig({ pilotBookingIds: id }), NOW).reason, 'PILOT_CONFIG_INVALID');
  assert.strictEqual(C.evaluateEligibility(booking(), baseConfig({ pilotBookingIds: [id, 1] }), NOW).reason, 'PILOT_CONFIG_INVALID');
  assert.strictEqual(C.evaluateEligibility(booking(), baseConfig({ pilotBookingIds: [id], enabled: false }), NOW).reason, 'FLAG_OFF');
});

test('限定稼働モード(#757): limitedRollout=true は対象予約ID1件の明示設定が必須（欠落・複数・不正は全件停止）', function () {
  var id = booking().bookingId;
  function r(over) { return C.evaluateEligibility(booking(), baseConfig(over), NOW); }
  assert.strictEqual(r({ limitedRollout: true, pilotBookingIds: [id] }).eligible, true);
  assert.strictEqual(r({ limitedRollout: true }).reason, 'PILOT_CONFIG_INVALID', '設定を落としても全件発行しない');
  assert.strictEqual(r({ limitedRollout: true, pilotBookingIds: [] }).reason, 'PILOT_CONFIG_INVALID');
  assert.strictEqual(r({ limitedRollout: true, pilotBookingIds: [id, 'OTHER'] }).reason, 'PILOT_CONFIG_INVALID');
  assert.strictEqual(r({ limitedRollout: true, pilotBookingIds: ['OTHER'] }).reason, 'NOT_PILOT_TARGET');
  assert.strictEqual(r({}).eligible, true, '通常モードは未設定互換');
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
  assert.deepStrictEqual(j([{ deviceId: DEV_A, keyList: [{ id: 7, name: 'N', startTime: '10', endTime: '20' }] }]), { ok: true, id: 7, idType: 'ID_TYPE_NUMBER' }, '生の型を保持する（String() 化しない #799）');
  assert.deepStrictEqual(j([{ deviceId: DEV_A, keyList: [{ id: '7', name: 'N', startTime: '10', endTime: '20' }] }]), { ok: true, id: '7', idType: 'ID_TYPE_STRING' });
  assert.strictEqual(j([{ deviceId: DEV_A, keyList: [{ id: 9007199254740993, name: 'N' }] }]).error, 'ID_NOT_SAFE_INTEGER');
  assert.strictEqual(j([{ deviceId: DEV_A, keyList: [{ id: 1.5, name: 'N' }] }]).error, 'KEY_ID_INVALID');
  assert.strictEqual(j([{ deviceId: DEV_A, keyList: [{ id: -3, name: 'N' }] }]).error, 'KEY_ID_INVALID');
  assert.strictEqual(j([{ deviceId: DEV_A, keyList: [{ id: {}, name: 'N' }] }]).error, 'KEY_ID_INVALID');
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
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', deviceMac: DEV_A, eventName: 'createKey ', commandId: rec.commandId, result: 'success' } });
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
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', deviceMac: DEV_A, eventName: 'createKey', commandId: 'OTHER', result: 'success' } });
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoLock', deviceMac: DEV_A, eventName: 'createKey', commandId: rec.commandId, result: 'success' } });
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.SENT_WAIT_WEBHOOK);
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', deviceMac: DEV_A, eventName: 'createKey', commandId: rec.commandId, result: 'failed' } });
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', deviceMac: DEV_A, eventName: 'createKey', commandId: rec.commandId, result: 'success' } });
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
  e.ingestWebhook({ eventType: 'changeReport', context: { deviceType: 'WoKeypad', deviceMac: DEV_A, eventName: 'createKey', commandId: rec.commandId, result: 'success' } });
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

test('期間 A→B→A(同改訂): 復元した期間で新 attempt を再発行する', function () {
  var w = world();
  var e = w.engine();
  issued(w, e);
  e.sync(booking({ endTime: '14:00' }));
  var r = e.sync(booking());
  var recs = w.records();
  assert.strictEqual(recs.length, 3);
  assert.notStrictEqual(r.skipped, 'ALREADY_PLANNED');
  assert.deepStrictEqual(recs.map(function (x) { return x.state; }), [S.DELETED_CONFIRMED, S.DELETED_CONFIRMED, S.ISSUED_CONFIRMED]);
  assert.strictEqual(w.keys[DEV_A].length, 1);
  assert.strictEqual(new Set(recs.map(function (x) { return x.id; })).size, 3);
});

test('FAILED/期限切れの同期間 record は再発行を妨げる（拒否の無限再試行をしない）', function () {
  var w = world();
  w.createMode = 'reject';
  var e = w.engine();
  e.sync(booking()); e.sync(booking());
  assert.strictEqual(w.records().length, 1);
  assert.strictEqual(w.mutations().length, 1);
});

test('adminResolveUnknown: ロック下で再読込し、並行する削除結果を ISSUED で上書きしない', function () {
  var w = world();
  w.createMode = 'dropResponse';
  var deps = w.engineDeps();
  var e;
  var id;
  var inner = false;
  var origList = deps.api.listDevices;
  deps.api.listDevices = function () {
    var res = origList();
    if (!inner) {
      inner = true; // 先行処理: 別の管理者が確認→削除まで完了させる状況
      e.adminResolveUnknown(id, 'CONFIRM_PRESENT', 'ops2');
      e.adminDelete(id, 'ops2');
    }
    return res;
  };
  e = C.createEngine(deps, baseConfig());
  e.sync(booking());
  id = w.records()[0].id;
  inner = false;
  e.adminResolveUnknown(id, 'CONFIRM_PRESENT', 'ops1');
  assert.notStrictEqual(w.records()[0].state, S.ISSUED_CONFIRMED);
});

test('保持期限後の ID 再利用でも、新しい操作の通知が前回マーカーに抑止されない', function () {
  var w = world();
  w.createMode = 'dropResponse';
  var e = w.engine(baseConfig({ retentionSec: 100 }));
  e.sync(booking());
  var id = w.records()[0].id;
  assert.strictEqual(e.adminResolveUnknown(id, 'CONFIRM_PRESENT', 'ops').ok, true);
  e.adminDelete(id, 'ops');
  w.now += 101;
  e.sweep();
  assert.strictEqual(w.records().length, 0);
  assert.strictEqual(Object.keys(w.store).filter(function (k) { return k.indexOf('ALERT_') === 0; }).length, 0);
  var before = w.notes.length;
  e.sync(booking());
  assert.ok(w.notes.length > before, '新しい UNKNOWN が通知される');
});

test('受渡し: 同改訂で期間が短縮された場合、管理者確認済みの旧キーは渡さない', function () {
  var w = world();
  w.createMode = 'dropResponse';
  var e = w.engine();
  e.sync(booking());
  e.sync(booking({ endTime: '11:00' }));
  var id = w.records()[0].id;
  assert.strictEqual(e.adminResolveUnknown(id, 'CONFIRM_PRESENT', 'ops').ok, true);
  assert.strictEqual(e.deliver(id).reason, 'NOT_CURRENT');
  assert.deepStrictEqual(w.delivered, []);
});

test('フラグOFF: 結果保存前に中断した SENDING も adminReconcile→adminResolveUnknown で復旧でき、再送しない', function () {
  var w = world();
  w.createMode = 'noCommandId';
  w.failSetOnKey = { prefix: 'OP_', state: S.ACCEPTED_NO_COMMAND_ID };
  assert.throws(function () { w.engine().sync(booking()); });
  w.failSetOnKey = null;
  var off = w.engine(baseConfig({ enabled: false }));
  var id = w.records()[0].id;
  assert.strictEqual(w.records()[0].state, S.SENDING);
  assert.strictEqual(off.adminReconcile(id, 'ops').state, S.UNKNOWN);
  assert.strictEqual(off.adminResolveUnknown(id, 'CONFIRM_PRESENT', 'ops').state, S.ISSUED_CONFIRMED);
  assert.strictEqual(off.adminDelete(id, 'ops').state, S.DELETED_CONFIRMED);
  assert.strictEqual(w.mutations().filter(function (c) { return c === 'create'; }).length, 1);
});

test('sweep: ロック下で再読込し、並行した削除の進行状態を EXPIRED で巻き戻さない', function () {
  var w = world();
  w.createMode = 'noCommandId';
  var deps = w.engineDeps();
  var e;
  var recId;
  var nested = false;
  deps.lock = function (keys, fn) {
    if (!nested && recId) { nested = true; w.deleteMode = 'noApply'; e.adminDelete(recId, 'ops'); }
    return fn();
  };
  e = C.createEngine(deps, baseConfig());
  e.sync(booking());
  recId = w.records()[0].id;
  w.now = w.records()[0].endSec + 10;
  e.sweep();
  assert.notStrictEqual(w.records()[0].state, S.EXPIRED);
  assert.strictEqual(w.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length, 1);
});

// ---------- Issue #751: 削除確認のID・名前・Webhook照合 ----------

function hook(rec, over, ctx) {
  return Object.assign({ eventType: 'changeReport', context: Object.assign({
    deviceType: 'WoKeypad', deviceMac: DEV_A, eventName: 'deleteKey', commandId: rec.deleteCommandId, result: 'success'
  }, ctx || {}) }, over || {});
}
function delCalls(w) { return w.mutations().filter(function (c) { return c.indexOf('delete:') === 0; }).length; }
var CANCEL = function () { return booking({ revision: 2, status: 'CANCELLED' }); };

/** deleteKey が commandId を返すよう、フェイクを差し替える（削除は端末に反映する）。 */
function withDeleteCommandId(w, applied) {
  var deps = w.engineDeps();
  var orig = deps.api.deleteKey;
  deps.api.deleteKey = function (dev, id) {
    var r = applied === false ? (w.calls.push('delete:' + id), { httpCode: 200, parsed: { statusCode: 100, body: {} } }) : orig(dev, id);
    r.parsed.body = { commandId: 'DEL-CMD' };
    return r;
  };
  return deps;
}
function issuedWithDelCmd(w, applied) {
  var deps = withDeleteCommandId(w, applied);
  var e = C.createEngine(deps, baseConfig());
  issued(w, e);
  e.sync(CANCEL());
  return e;
}

test('#751 inspectAbsence: 別名同ID・同名別ID・対象外端末・欠落・不正要素を不在と断定しない', function () {
  function a(devs, pid) { return C.inspectAbsence(devs, DEV_A, 'N', pid === undefined ? '5' : pid); }
  assert.strictEqual(a([{ deviceId: DEV_A, keyList: [] }]).absent, true);
  assert.strictEqual(a([{ deviceId: DEV_A, keyList: [{ id: '5', name: 'OTHER' }] }]).absent, false, '別名の同ID');
  assert.strictEqual(a([{ deviceId: DEV_A, keyList: [{ id: '9', name: 'N' }] }]).absent, false, '同名の別ID');
  assert.strictEqual(a([{ deviceId: DEV_B, keyList: [] }]).error, 'DEVICE_NOT_FOUND');
  assert.strictEqual(a([{ deviceId: DEV_A }]).error, 'KEYLIST_INVALID');
  assert.strictEqual(a([{ deviceId: DEV_A, keyList: [null] }]).error, 'KEYLIST_ENTRY_INVALID');
  assert.strictEqual(a([{ deviceId: DEV_A, keyList: [{ name: 'X' }] }]).error, 'KEYLIST_ENTRY_INVALID');
  assert.strictEqual(a(null).error, 'DEVICE_LIST_INVALID');
  assert.strictEqual(a([{ deviceId: DEV_A, keyList: [] }], '').error, 'PASSCODE_ID_MISSING');
  assert.strictEqual(a([{ deviceId: DEV_A, keyList: [{ id: 5, name: 'N' }] }]).bothCount, 1, '数値IDも文字列比較');
});

test('#751 削除前: 別名で同IDだけ残存/同名別IDだけ残存は ALREADY_ABSENT にせず UNKNOWN（deleteKey未送信）', function () {
  var w = world(); var e = w.engine(); issued(w, e);
  w.keys[DEV_A][0].name = 'RENAMED';
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w), 0);

  var w2 = world(); var e2 = w2.engine(); issued(w2, e2);
  w2.keys[DEV_A][0].id = 'OTHER-ID';
  e2.sync(CANCEL());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w2), 0);
});

test('#751 削除前: 同名別IDと別名同IDが別要素で残る場合も送信しない', function () {
  var w = world(); var e = w.engine(); var rec = issued(w, e);
  w.keys[DEV_A].push({ id: 'X9', name: rec.name });
  w.keys[DEV_A][0].name = 'ALIAS';
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w), 0);
});

test('#751 削除前: ID・名前とも不在なら ALREADY_ABSENT、別予約/通常キーは無関係', function () {
  var w = world(); var e = w.engine(); issued(w, e);
  w.keys[DEV_A] = [{ id: 'NORMAL', name: 'regular', type: 'permanent' }];
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.ALREADY_ABSENT);
  assert.strictEqual(delCalls(w), 0);
  assert.strictEqual(w.keys[DEV_A].length, 1);
});

test('#751 削除前: keyList要素の欠落/対象外端末のみの応答は不在と補完しない', function () {
  var w = world(); var e = w.engine(); issued(w, e);
  w.keys[DEV_A].push({ name: 'no-id' });
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w), 0);
});

test('#751 commandIdなし削除後: 別名で同IDが残る/同名別IDが残る場合は成功にしない', function () {
  var w = world(); var e = w.engine(); var rec = issued(w, e);
  // deleteKey 後に ID だけ別名で残る端末挙動を模す
  var deps = w.engineDeps(); var orig = deps.api.deleteKey;
  deps.api.deleteKey = function (dev, id) { var r = orig(dev, id); w.keys[dev].push({ id: id, name: 'ALIAS' }); return r; };
  var e2 = C.createEngine(deps, baseConfig());
  e2.sync(CANCEL());
  e2.sync(CANCEL()); e2.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.notStrictEqual(w.records()[0].state, S.DELETED_CONFIRMED);
  assert.strictEqual(delCalls(w), 1, '再送なし');

  var w2 = world(); var e3 = w2.engine(); issued(w2, e3);
  var d2 = w2.engineDeps(); var o2 = d2.api.deleteKey;
  d2.api.deleteKey = function (dev, id) { var r = o2(dev, id); w2.keys[dev].push({ id: 'NEW', name: w2.records()[0].name }); return r; };
  var e4 = C.createEngine(d2, baseConfig());
  e4.sync(CANCEL()); e4.sync(CANCEL()); e4.sync(CANCEL());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w2), 1);
});

test('#751 commandIdなし削除: 両不在の読取確認のみで確定、証拠はKEYLIST_ABSENTのみ（Webhook証拠を捏造しない）', function () {
  var w = world(); var e = w.engine(); issued(w, e);
  e.sync(CANCEL());
  var rec = w.records()[0];
  assert.strictEqual(rec.state, S.DELETED_CONFIRMED);
  assert.deepStrictEqual(rec.evidence.slice(-1), ['KEYLIST_ABSENT']);
  assert.strictEqual(rec.evidence.indexOf('WEBHOOK_SUCCESS'), -1);
  assert.strictEqual(rec.deleteCommandId, '');
});

test('#751 commandIdなし削除: 読取回数上限・経過時間上限を永続化し、再起動でリセットされず再送もない', function () {
  var w = world(); var e = w.engine(baseConfig({ maxReads: 3 })); issued(w, e);
  w.deleteMode = 'noApply';
  e.sync(CANCEL());                       // read 1
  assert.strictEqual(w.records()[0].reads, 1);
  assert.strictEqual(w.records()[0].state, S.DELETE_SENT);
  var e2 = w.engine(baseConfig({ maxReads: 3 })); // 再起動相当
  e2.sync(CANCEL());                      // read 2
  assert.strictEqual(w.records()[0].reads, 2);
  w.engine(baseConfig({ maxReads: 3 })).sync(CANCEL()); // read 3 → 上限
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w), 1);

  var w2 = world(); var e3 = w2.engine(baseConfig({ readWaitSec: 100, maxReads: 50 })); issued(w2, e3);
  w2.deleteMode = 'noApply';
  e3.sync(CANCEL());
  w2.now += 101;
  w2.keys[DEV_A] = []; // 期限後に消えても、期限超過は成功扱いにしない
  e3.sync(CANCEL());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w2.records()[0].reason, 'READ_WINDOW_EXCEEDED');
  assert.strictEqual(delCalls(w2), 1);
});

test('#751 commandIdなし削除: 読取の通信/API失敗は消費しつつ上限まで保留、成功扱いしない', function () {
  var w = world(); var e = w.engine(baseConfig({ maxReads: 2 })); issued(w, e);
  w.deleteMode = 'noApply';
  e.sync(CANCEL());
  w.listMode = 'throw';
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w), 1);
});

test('#751 commandIdあり: 同一端末・deleteKey・同一commandId・success のWebhook＋両不在で確定、証拠は別々', function () {
  var w = world(); var e = issuedWithDelCmd(w);
  var rec = w.records()[0];
  assert.strictEqual(rec.state, S.DELETE_SENT, 'Webhook未着は保留');
  assert.strictEqual(rec.deleteCommandId, 'DEL-CMD');
  e.ingestWebhook(hook(rec));
  e.sync(CANCEL());
  rec = w.records()[0];
  assert.strictEqual(rec.state, S.DELETED_CONFIRMED);
  assert.deepStrictEqual(rec.evidence.slice(-2), ['WEBHOOK_SUCCESS', 'KEYLIST_ABSENT']);
  assert.strictEqual(delCalls(w), 1);
});

test('#751 commandIdあり: Webhookとkeylistの到着順が逆（先にWebhook到着→先に不在）でも同じ結果', function () {
  var w = world(); var deps = withDeleteCommandId(w);
  var e = C.createEngine(deps, baseConfig());
  w.createMode = 'noCommandId'; e.sync(booking());
  var rec0 = w.records()[0];
  // 削除送信前にWebhookが先着（commandIdは予測可能な固定値の想定）
  e.ingestWebhook(hook({ deleteCommandId: 'DEL-CMD' }));
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.DELETED_CONFIRMED);
  assert.strictEqual(rec0.id, w.records()[0].id);
});

test('#751 commandIdあり: Webhook不在/未着は期限前は保留、期限超過で UNKNOWN（keyListが両不在でも成功にしない）', function () {
  var w = world(); var e = issuedWithDelCmd(w);
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.DELETE_SENT);
  assert.strictEqual(w.records()[0].reads, 0, '未着の保留は読取を消費しない');
  w.now += 91;
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'WEBHOOK_TIMEOUT');
  assert.strictEqual(w.keys[DEV_A].length, 0);
  assert.strictEqual(delCalls(w), 1);
});

test('#751 commandIdあり: failed＋両不在でも成功にせず UNKNOWN＋通知', function () {
  var w = world(); var e = issuedWithDelCmd(w);
  e.ingestWebhook(hook(w.records()[0], null, { result: 'failed' }));
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.ok(w.notes.some(function (n) { return n.code === 'DELETE_WEBHOOK_FAILED'; }));
  assert.strictEqual(delCalls(w), 1);
});

test('#751 commandIdあり: success＋keyList残存は矛盾として UNKNOWN', function () {
  var w = world(); var e = issuedWithDelCmd(w, false);
  e.ingestWebhook(hook(w.records()[0]));
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'WEBHOOK_SUCCESS_BUT_REMAINS');
  assert.strictEqual(delCalls(w), 1);
});

test('#751 commandIdあり: success＋別名同ID残存/同名別ID残存も矛盾で UNKNOWN', function () {
  var w = world(); var e = issuedWithDelCmd(w, false);
  w.keys[DEV_A][0].name = 'ALIAS';
  e.ingestWebhook(hook(w.records()[0]));
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

test('#751 commandIdあり: device/操作/commandId不一致・種別違いのWebhookは採用しない（期限でUNKNOWN）', function () {
  var w = world(); var e = issuedWithDelCmd(w);
  var rec = w.records()[0];
  e.ingestWebhook(hook(rec, null, { deviceMac: DEV_B }));                 // 別端末
  e.ingestWebhook(hook(rec, null, { eventName: 'createKey' }));           // 別操作
  e.ingestWebhook(hook(rec, null, { commandId: 'OTHER' }));               // 別commandId
  e.ingestWebhook(hook(rec, null, { deviceType: 'WoLock' }));             // 別種別
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.DELETE_SENT);
  w.now += 91;
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

test('#751 Webhook: 対象端末(deviceMac)欠落の旧形式は保存せず補完しない／正規化は大文字・区切り除去のみ', function () {
  var w = world(); var e = w.engine();
  var ctx = { deviceType: 'WoKeypad', eventName: 'deleteKey', commandId: 'C1', result: 'success' };
  assert.deepStrictEqual(e.ingestWebhook({ eventType: 'changeReport', context: ctx }), { stored: false, reason: 'DEVICE_MISSING' });
  assert.strictEqual(Object.keys(w.store).length, 0);
  assert.strictEqual(C.parseKeypadWebhook({ eventType: 'changeReport', context: Object.assign({ deviceMac: 'aa:aa-aa AAAAAA37dd' }, ctx) }).deviceMac, 'AAAAAAAAAAAA37DD');
  assert.strictEqual(C.parseKeypadWebhook({ eventType: 'changeReport', context: Object.assign({}, ctx, { commandId: '' }) }), null);
});

test('#751 Webhook: 重複/遅延は初回維持、結果が食い違う重複は矛盾として確定に使わない', function () {
  var w = world(); var e = issuedWithDelCmd(w);
  var rec = w.records()[0];
  e.ingestWebhook(hook(rec));
  assert.strictEqual(e.ingestWebhook(hook(rec)).duplicate, true);
  e.ingestWebhook(hook(rec, null, { result: 'failed' }));
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'WEBHOOK_CONFLICT');
});

test('#751 旧形式: deleteSentAtSec欠落の DELETE_SENT は推測補完せず UNKNOWN', function () {
  var w = world(); var e = w.engine(); issued(w, e);
  w.deleteMode = 'noApply';
  e.sync(CANCEL());
  var key = Object.keys(w.store).filter(function (k) { return k.indexOf('OP_') === 0; })[0];
  var r = JSON.parse(w.store[key]); delete r.deleteSentAtSec; w.store[key] = JSON.stringify(r);
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w), 1);
});

test('#751 保存失敗・同時/重複実行・OFF復旧: deleteKeyは再送されない', function () {
  // 結果保存失敗 → DELETE_SENDING → 再起動で UNKNOWN
  var w = world(); var e = w.engine(); issued(w, e);
  w.failSetOnKey = { prefix: 'OP_', state: S.DELETE_SENT };
  assert.throws(function () { e.sync(CANCEL()); }, /STORE_FAIL/);
  w.failSetOnKey = null;
  w.engine().sync(CANCEL()); w.engine().sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w), 1);

  // 別インスタンス交互/OFF時のadminReconcileで遅れて両不在を確認 → 確定、再送なし
  var w2 = world(); var on = w2.engine(baseConfig({ maxReads: 5 })); issued(w2, on);
  w2.deleteMode = 'noApply';
  on.sync(CANCEL());
  w2.engine(baseConfig({ maxReads: 5 })).sync(CANCEL());
  var off = w2.engine(baseConfig({ enabled: false, maxReads: 5 }));
  w2.keys[DEV_A] = [];
  assert.strictEqual(off.adminReconcile(w2.records()[0].id, 'ops').state, S.DELETED_CONFIRMED);
  assert.strictEqual(delCalls(w2), 1);
});

test('#751 期限切れ確認: 別名で同IDが残る間は ARCHIVED_EXPIRED にしない（残存通知）', function () {
  var w = world(); var e = w.engine(); issued(w, e);
  w.keys[DEV_A][0].name = 'ALIAS';
  w.now = w.records()[0].endSec + 10;
  e.sweep();
  assert.strictEqual(w.records()[0].state, S.EXPIRED);
  assert.ok(w.notes.some(function (n) { return n.code === 'EXPIRED_KEY_REMAINS'; }));
});

test('#751 別予約・通常キーは削除で影響を受けない', function () {
  var w = world(); var e = w.engine();
  w.keys[DEV_A].push({ id: 'NORMAL', name: 'regular', type: 'permanent' });
  w.createMode = 'noCommandId';
  e.sync(booking()); e.sync(booking({ bookingId: 'BK2', startTime: '15:00', endTime: '17:00' }));
  e.sync(CANCEL());
  assert.strictEqual(w.keys[DEV_A].length, 2);
  assert.ok(w.keys[DEV_A].some(function (k) { return k.id === 'NORMAL'; }));
});

test('#751 commandIdあり: 期限後に到着したsuccess Webhookは採用しない（期限内到着なら後の照合でも採用）', function () {
  var w = world(); var e = issuedWithDelCmd(w);
  w.now += 600;                       // 期限(90秒)を大きく超えてから到着
  e.ingestWebhook(hook(w.records()[0]));
  e.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'WEBHOOK_LATE');
  assert.strictEqual(delCalls(w), 1);

  var w2 = world(); var e2 = issuedWithDelCmd(w2);
  w2.now += 30;                       // 期限内に到着
  e2.ingestWebhook(hook(w2.records()[0]));
  w2.now += 600;                      // 照合ジョブが遅れて実行
  e2.sync(CANCEL());
  assert.strictEqual(w2.records()[0].state, S.DELETED_CONFIRMED);
});

test('#751 name欠落/不正のkeyList要素は不在と断定しない（削除前・送信後commandIdあり/なし・sweep）、秘密は破棄せず再発行しない', function () {
  function a(entry) { return C.inspectAbsence([{ deviceId: DEV_A, keyList: [entry] }], DEV_A, 'N', '5'); }
  assert.strictEqual(a({ id: 'OTHER' }).error, 'KEYLIST_ENTRY_INVALID');
  assert.strictEqual(a({ id: 'OTHER', name: '' }).error, 'KEYLIST_ENTRY_INVALID');
  assert.strictEqual(a({ id: 'OTHER', name: 123 }).error, 'KEYLIST_ENTRY_INVALID');
  assert.strictEqual(a({ id: 'OTHER', name: null }).error, 'KEYLIST_ENTRY_INVALID');
  assert.strictEqual(a({ id: 'OTHER', name: 'x' }).absent, true);

  // 削除前
  var w = world(); var e = w.engine(); issued(w, e);
  w.keys[DEV_A] = [{ id: 'OTHER' }];
  e.sync(CANCEL()); e.sync(booking({ revision: 3 }));
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w), 0);
  assert.strictEqual(w.records().length, 1, '新キーを再発行しない');
  assert.strictEqual(Object.keys(w.secrets).length, 1, '秘密を破棄しない');

  // 送信後 commandIdなし
  var w2 = world(); var e2 = w2.engine(); issued(w2, e2);
  var d2 = w2.engineDeps(); var o2 = d2.api.deleteKey;
  d2.api.deleteKey = function (dev, id) { var r = o2(dev, id); w2.keys[dev].push({ id: 'OTHER' }); return r; };
  C.createEngine(d2, baseConfig()).sync(CANCEL());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(delCalls(w2), 1);
  assert.strictEqual(Object.keys(w2.secrets).length, 1);

  // 送信後 commandIdあり（success Webhook あり）
  var w3 = world(); var e3 = issuedWithDelCmd(w3, false);
  w3.keys[DEV_A] = [{ id: 'OTHER' }];
  e3.ingestWebhook(hook(w3.records()[0]));
  e3.sync(CANCEL());
  assert.strictEqual(w3.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w3.records().length, 1);
  assert.strictEqual(Object.keys(w3.secrets).length, 1);

  // sweep 期限切れ
  var w4 = world(); var e4 = w4.engine(); issued(w4, e4);
  w4.keys[DEV_A] = [{ id: 'OTHER' }];
  w4.now = w4.records()[0].endSec + 10;
  e4.sweep();
  assert.strictEqual(w4.records()[0].state, S.EXPIRED);
  assert.ok(w4.notes.some(function (n) { return n.code === 'EXPIRED_CHECK_FAILED'; }));
  assert.strictEqual(Object.keys(w4.secrets).length, 1);
});

// ---------- Issue #763: 発行側 createKey の遅着Webhook ----------

function createHook(rec, ctx) {
  return { eventType: 'changeReport', context: Object.assign({
    deviceType: 'WoKeypad', deviceMac: DEV_A, eventName: 'createKey', commandId: rec.commandId, result: 'success'
  }, ctx || {}) };
}
function creates(w) { return w.mutations().filter(function (c) { return c === 'create'; }).length; }
function setRec(w, fn) {
  var key = Object.keys(w.store).filter(function (k) { return k.indexOf('OP_') === 0; })[0];
  var r = JSON.parse(w.store[key]); fn(r); w.store[key] = JSON.stringify(r);
}
function setEvt(w, fn) {
  var key = Object.keys(w.store).filter(function (k) { return k.indexOf('EVT_') === 0; })[0];
  var r = JSON.parse(w.store[key]); fn(r); w.store[key] = JSON.stringify(r);
}

test('#763 発行: 期限後に到着したsuccessは keyList が一致していても採用せず UNKNOWN＋通知、再送・復活しない', function () {
  var w = world(); var e = w.engine();
  e.sync(booking());
  var rec = w.records()[0];
  assert.strictEqual(rec.state, S.SENT_WAIT_WEBHOOK);
  w.now += 600;                                  // 上限90秒を大きく超えて到着
  e.ingestWebhook(createHook(rec));
  e.sync(booking());
  rec = w.records()[0];
  assert.strictEqual(rec.state, S.UNKNOWN);
  assert.strictEqual(rec.reason, 'WEBHOOK_LATE');
  assert.ok(w.notes.some(function (n) { return n.code === 'WEBHOOK_TIMEOUT'; }));
  assert.strictEqual(w.keys[DEV_A].length, 1, 'keyList は一致している');
  e.sync(booking()); e.sweep();
  assert.strictEqual(w.records()[0].state, S.UNKNOWN, '自動復活しない');
  assert.strictEqual(creates(w), 1);
  assert.strictEqual(w.records().length, 1, '自動再発行しない');
  assert.deepStrictEqual(w.delivered, []);
});

test('#763 発行: 期限内に受信したsuccessは、照合が600秒後に遅れても keyList 一致で確定できる', function () {
  var w = world(); var e = w.engine();
  e.sync(booking());
  var rec = w.records()[0];
  w.now += 30;
  e.ingestWebhook(createHook(rec));
  w.now += 600;
  e.sync(booking());
  rec = w.records()[0];
  assert.strictEqual(rec.state, S.ISSUED_CONFIRMED);
  assert.deepStrictEqual(rec.evidence, ['WEBHOOK_SUCCESS', 'KEYLIST_CONFIRMED']);
  assert.strictEqual(creates(w), 1);
});

test('#763 発行: Webhook未着は期限前に保留、期限超過で UNKNOWN。期限後に届いても復活・再送しない', function () {
  var w = world(); var e = w.engine();
  e.sync(booking());
  w.now += 60; e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.SENT_WAIT_WEBHOOK);
  w.now += 100; e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  e.ingestWebhook(createHook(w.records()[0]));
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(creates(w), 1);
});

test('#763 発行: 受信時刻欠落・非数値・保存の送信時刻欠落は成功根拠にしない', function () {
  [['欠落', function (ev) { delete ev.receivedAtSec; }], ['非数値', function (ev) { ev.receivedAtSec = 'x'; }],
   ['NaN文字列', function (ev) { ev.receivedAtSec = 'NaN'; }]].forEach(function (c) {
    var w = world(); var e = w.engine();
    e.sync(booking());
    e.ingestWebhook(createHook(w.records()[0]));
    setEvt(w, c[1]);
    e.sync(booking());
    assert.strictEqual(w.records()[0].state, S.UNKNOWN, c[0]);
    assert.strictEqual(creates(w), 1, c[0]);
  });
  var w2 = world(); var e2 = w2.engine();
  e2.sync(booking());
  e2.ingestWebhook(createHook(w2.records()[0]));
  setRec(w2, function (r) { delete r.sentAtSec; });
  e2.sync(booking());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(creates(w2), 1);
});

test('#763 発行: 結果が食い違う重複success→failedは成功にせず UNKNOWN、failed先着は FAILED のまま', function () {
  var w = world(); var e = w.engine();
  e.sync(booking());
  var rec = w.records()[0];
  e.ingestWebhook(createHook(rec));
  e.ingestWebhook(createHook(rec, { result: 'failed' }));
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'WEBHOOK_CONFLICT');
  assert.ok(w.notes.some(function (n) { return n.code === 'ISSUE_WEBHOOK_CONFLICT'; }));

  var w2 = world(); var e2 = w2.engine();
  e2.sync(booking());
  e2.ingestWebhook(createHook(w2.records()[0], { result: 'failed' }));
  e2.sync(booking());
  assert.strictEqual(w2.records()[0].state, S.FAILED);
  assert.strictEqual(Object.keys(w2.secrets).length, 0);
});

test('#763 発行: 他端末・別操作・別commandId・別種別のWebhookは成功扱いせず期限で UNKNOWN', function () {
  var w = world(); var e = w.engine();
  e.sync(booking());
  var rec = w.records()[0];
  e.ingestWebhook(createHook(rec, { deviceMac: DEV_B }));
  e.ingestWebhook(createHook(rec, { eventName: 'deleteKey' }));
  e.ingestWebhook(createHook(rec, { commandId: 'OTHER' }));
  e.ingestWebhook(createHook(rec, { deviceType: 'WoLock' }));
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.SENT_WAIT_WEBHOOK);
  w.now += 91; e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(creates(w), 1);
});

test('#763 発行: 期限内successでも keyList が不一致（0件/属性矛盾）なら確定しない', function () {
  var w = world(); var e = w.engine();
  e.sync(booking());
  e.ingestWebhook(createHook(w.records()[0]));
  w.keys[DEV_A] = [];
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);

  var w2 = world(); var e2 = w2.engine();
  e2.sync(booking());
  e2.ingestWebhook(createHook(w2.records()[0]));
  w2.keys[DEV_A][0].endTime = '1';
  e2.sync(booking());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
});

test('#763 発行: commandIdなしは Webhook を必須とせず、遅着Webhook規則の影響を受けない（回帰）', function () {
  var w = world(); w.createMode = 'noCommandId';
  var e = w.engine();
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.ISSUED_CONFIRMED);
  assert.deepStrictEqual(w.records()[0].evidence, ['KEYLIST_CONFIRMED']);

  var w2 = world(); w2.createMode = 'silentNoApply';
  var e2 = w2.engine();
  e2.sync(booking()); e2.sync(booking()); e2.sync(booking()); e2.sync(booking());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(creates(w2), 1);
});

test('#763 発行: 遅着で UNKNOWN の間は旧改訂/取消の処理が通常キーを消さず、新キーも自動発行されない', function () {
  var w = world(); var e = w.engine();
  w.keys[DEV_A].push({ id: 'NORMAL', name: 'regular', type: 'permanent' });
  e.sync(booking());
  w.now += 600;
  e.ingestWebhook(createHook(w.records()[0]));
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  e.sync(booking({ revision: 2, endTime: '14:00' }));
  assert.strictEqual(creates(w), 1, '旧キー未確定の間は新キーを発行しない');
  assert.ok(w.keys[DEV_A].some(function (k) { return k.id === 'NORMAL'; }));
  assert.strictEqual(delCalls(w), 0);
  assert.deepStrictEqual(w.delivered, []);
});

test('#763 発行: Webhook未着＋sentAtSec欠落/非数値は、期限前後を問わず UNKNOWN＋通知（無期限滞留しない）、再送・再発行・配送なし', function () {
  [['欠落', function (r) { delete r.sentAtSec; }], ['文字列', function (r) { r.sentAtSec = 'abc'; }],
   ['null', function (r) { r.sentAtSec = null; }], ['数値文字列', function (r) { r.sentAtSec = String(r.sentAtSec); }]].forEach(function (c) {
    var w = world(); var e = w.engine();
    e.sync(booking());
    setRec(w, c[1]);
    e.sync(booking());                               // 期限前でも停止
    assert.strictEqual(w.records()[0].state, S.UNKNOWN, c[0]);
    assert.strictEqual(w.records()[0].reason, 'SENT_TIME_MISSING', c[0]);
    assert.ok(w.notes.some(function (n) { return n.code === 'ISSUE_CONFIRM_FAILED'; }), c[0]);
    w.now += 1000; e.sync(booking()); e.sweep();      // 期限超過後も UNKNOWN のまま
    assert.strictEqual(w.records()[0].state, S.UNKNOWN, c[0]);
    assert.strictEqual(creates(w), 1, c[0]);
    assert.strictEqual(w.records().length, 1, c[0]);
    assert.deepStrictEqual(w.delivered, [], c[0]);
  });
  // Webhook 到着後（success）でも同様に止まる
  var w2 = world(); var e2 = w2.engine();
  e2.sync(booking());
  e2.ingestWebhook(createHook(w2.records()[0]));
  setRec(w2, function (r) { delete r.sentAtSec; });
  e2.sync(booking());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
});

test('#763 発行: 送信時刻より前に受信したsuccessは keyList 一致でも UNKNOWN、送信時刻ちょうどは採用', function () {
  var w = world(); var e = w.engine();
  e.sync(booking());
  e.ingestWebhook(createHook(w.records()[0]));
  setEvt(w, function (ev) { ev.receivedAtSec = w.records()[0].sentAtSec - 1; });
  e.sync(booking());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'WEBHOOK_LATE');
  assert.strictEqual(w.keys[DEV_A].length, 1, 'keyList は一致している');
  e.sync(booking());
  assert.strictEqual(creates(w), 1);
  assert.strictEqual(w.records().length, 1);
  assert.deepStrictEqual(w.delivered, []);

  var w2 = world(); var e2 = w2.engine();
  e2.sync(booking());
  e2.ingestWebhook(createHook(w2.records()[0]));      // 受信=送信と同時刻
  e2.sync(booking());
  assert.strictEqual(w2.records()[0].state, S.ISSUED_CONFIRMED);
});


// ---------- #799 deleteKey: ID型保持＋削除直前再照合 ----------

function deleteCalls(w) { return w.calls.filter(function (c) { return c.indexOf('delete:') === 0; }); }
/** 送信された parameter.id の JSON 型（値は見ない）。フェイクは呼出し記録を文字列化するので、別途型を捕捉する。 */
function trackWireTypes(w) {
  var types = [];
  var base = w.engineDeps;
  w.engineDeps = function () {
    var d = base();
    var orig = d.api.deleteKey;
    d.api.deleteKey = function (dev, id) { types.push(typeof id); return orig(dev, id); };
    return d;
  };
  return types;
}

test('#799 NUMBER: 発行確認で数値IDを保持し、削除は数値のまま送信され、後続keyListで不在確認して確定', function () {
  var w = world(); w.idMode = 'number';
  var wire = trackWireTypes(w);
  var e = w.engine();
  var rec = issued(w, e);
  assert.strictEqual(typeof rec.passcodeId, 'number', '保存IDは数値のまま');
  assert.strictEqual(rec.passcodeIdType, 'ID_TYPE_NUMBER');
  e.sync(CANCEL());
  assert.deepStrictEqual(wire, ['number'], 'parameter.id は数値');
  var r = w.records()[0];
  assert.strictEqual(r.state, S.DELETED_CONFIRMED);
  assert.strictEqual(r.deleteIdType, 'ID_TYPE_NUMBER');
  assert.strictEqual(w.keys[DEV_A].length, 0);
});

test('#799 STRING: 文字列IDは文字列のまま送信される', function () {
  var w = world(); w.idMode = 'string';
  var wire = trackWireTypes(w);
  var e = w.engine();
  var rec = issued(w, e);
  assert.strictEqual(rec.passcodeIdType, 'ID_TYPE_STRING');
  e.sync(CANCEL());
  assert.deepStrictEqual(wire, ['string']);
  assert.strictEqual(w.records()[0].state, S.DELETED_CONFIRMED);
});

test('#799 旧経路差: 数値IDを String() で送ると端末は受理しても削除されない（旧実装の再現）→ 残存は成功にせず UNKNOWN', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); issued(w, e);
  // 旧実装相当: 数値IDを文字列化して送る端末フェイク（型が違うと削除されない）
  var deps = w.engineDeps(); var orig = deps.api.deleteKey;
  deps.api.deleteKey = function (dev, id) { return orig(dev, String(id)); };
  var e2 = C.createEngine(deps, baseConfig());
  e2.sync(CANCEL());
  assert.strictEqual(w.keys[DEV_A].length, 1, '試験キー残存');
  e2.sync(CANCEL()); e2.sync(CANCEL()); e2.sync(CANCEL());
  assert.strictEqual(w.records()[0].state, S.UNKNOWN, 'API受理は削除成功にしない');
  assert.strictEqual(deleteCalls(w).length, 1, '変更系は再送しない');
  assert.ok(w.notes.some(function (n) { return n.code === 'KEY_REMAINS'; }), '運営者通知');
});

test('#799 型の往復: User Properties 相当(JSON文字列)の保存・再読込で数値IDが文字列化しない', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); issued(w, e);
  var raw = w.store[Object.keys(w.store).filter(function (k) { return k.indexOf('OP_') === 0; })[0]];
  assert.strictEqual(typeof JSON.parse(raw).passcodeId, 'number');
});

test('#799 削除直前にID型が変化(NUMBER→STRING)したら送信せず UNKNOWN', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); issued(w, e);
  w.keys[DEV_A][0].id = String(w.keys[DEV_A][0].id);
  e.sync(CANCEL());
  assert.strictEqual(deleteCalls(w).length, 0);
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'ID_TYPE_CHANGED');
});

test('#799 削除直前にID値が変化したら送信せず UNKNOWN（古いIDを使わない）', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); issued(w, e);
  w.keys[DEV_A][0].id = w.keys[DEV_A][0].id + 1;
  e.sync(CANCEL());
  assert.strictEqual(deleteCalls(w).length, 0);
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

test('#799 安全でない整数・不正なID型は送信しない', function () {
  [[9007199254740993, 'ID_NOT_SAFE_INTEGER'], [1.5, 'TARGET_ID_INVALID'], [-4, 'TARGET_ID_INVALID'], [0, 'TARGET_ID_INVALID']].forEach(function (c) {
    var w = world(); w.idMode = 'number';
    var e = w.engine(); var rec = issued(w, e);
    w.keys[DEV_A][0].id = c[0];
    var recObj = JSON.parse(w.store['OP_' + rec.id]);
    recObj.passcodeId = c[0]; delete recObj.passcodeIdType; w.store['OP_' + rec.id] = JSON.stringify(recObj);
    e.sync(CANCEL());
    assert.strictEqual(deleteCalls(w).length, 0, String(c[1]));
    assert.strictEqual(w.records()[0].state, S.UNKNOWN);
    assert.strictEqual(w.records()[0].reason, c[1]);
  });
});

test('#799 同名複数: 送信しない（KEY_NAME_AMBIGUOUS）', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); var rec = issued(w, e);
  w.keys[DEV_A].push({ id: 999999, name: rec.name, type: 'timeLimit' });
  e.sync(CANCEL());
  assert.strictEqual(deleteCalls(w).length, 0);
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

test('#799 通常キー衝突: 通常キーが保存IDを持つ／運用キー名形式でない名前は送信しない。通常キーは削除されない', function () {
  // (a) 通常キーが同じIDを持つ（名前は別）
  var w = world(); w.idMode = 'number';
  var e = w.engine(); var rec = issued(w, e);
  w.keys[DEV_A].push({ id: w.keys[DEV_A][0].id, name: 'NORMAL', type: 'permanent' });
  e.sync(CANCEL());
  assert.strictEqual(deleteCalls(w).length, 0);
  assert.ok(w.keys[DEV_A].some(function (k) { return k.name === 'NORMAL'; }), '通常キー保持');
  // (b) 記録の名前が運用キー形式でない（通常キー名を指している）
  var w2 = world(); w2.idMode = 'number';
  var e2 = w2.engine(); var rec2 = issued(w2, e2);
  var o = JSON.parse(w2.store['OP_' + rec2.id]); o.name = 'Alice-Normal'; w2.store['OP_' + rec2.id] = JSON.stringify(o);
  w2.keys[DEV_A][0].name = 'Alice-Normal';
  e2.sync(CANCEL());
  assert.strictEqual(deleteCalls(w2).length, 0);
  assert.strictEqual(w2.records()[0].reason, 'NOT_SERVICE_KEY');
  assert.strictEqual(w2.keys[DEV_A].length, 1, '通常キーは不変');
});

test('#799 属性矛盾(種別・有効期間)は送信しない', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); issued(w, e);
  w.keys[DEV_A][0].type = 'permanent';
  e.sync(CANCEL());
  assert.strictEqual(deleteCalls(w).length, 0);
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
});

test('#799 鮮度: 直前keyListの取得から送信までが上限を超えたら送信しない', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(baseConfig({ deleteFreshSec: 30 })); issued(w, e);
  w.onList = function () { w.now += 120; }; // 取得に時間がかかった（古い照合）
  e.sync(CANCEL());
  assert.strictEqual(deleteCalls(w).length, 0);
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  assert.strictEqual(w.records()[0].reason, 'PRE_DELETE_STALE');
});

test('#799 通信失敗: 削除直前のkeyList取得失敗は送信しない／deleteKey通信断は再送せず UNKNOWN', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); issued(w, e);
  w.listMode = 'throw';
  e.sync(CANCEL());
  assert.strictEqual(deleteCalls(w).length, 0);
  assert.strictEqual(w.records()[0].state, S.UNKNOWN);
  var w2 = world(); w2.idMode = 'number';
  var e2 = w2.engine(); issued(w2, e2);
  w2.deleteMode = 'dropResponse';
  e2.sync(CANCEL()); e2.sync(CANCEL());
  assert.strictEqual(w2.records()[0].state, S.UNKNOWN);
  assert.strictEqual(deleteCalls(w2).length, 1, '自動再送なし');
});

test('#799 秘匿: 通知・record履歴・理由にIDの値を出さない（型コードのみ）', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); issued(w, e);
  var idStr = String(w.keys[DEV_A][0].id);
  w.deleteMode = 'noApply';
  e.sync(CANCEL()); e.sync(CANCEL()); e.sync(CANCEL()); e.sync(CANCEL());
  var out = JSON.stringify(w.notes) + JSON.stringify(w.records()[0].history) + w.records()[0].reason + w.records()[0].alertCode + w.records()[0].deleteIdType;
  assert.ok(out.indexOf(idStr) === -1, 'ID値なし');
  assert.strictEqual(w.records()[0].deleteIdType, 'ID_TYPE_NUMBER');
});

test('#799 旧形式record(passcodeIdType未記録・文字列ID)も、今回取得した生の型で送信できる（互換）', function () {
  var w = world(); w.idMode = 'number';
  var e = w.engine(); var rec = issued(w, e);
  var o = JSON.parse(w.store['OP_' + rec.id]); o.passcodeId = String(o.passcodeId); delete o.passcodeIdType; w.store['OP_' + rec.id] = JSON.stringify(o);
  var wire = trackWireTypes(w);
  var e2 = w.engine();
  e2.sync(CANCEL());
  assert.deepStrictEqual(wire, ['number'], '旧String保存でも再取得した生の型(NUMBER)を送る');
  assert.strictEqual(w.records()[0].state, S.DELETED_CONFIRMED);
});
