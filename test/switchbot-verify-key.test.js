/*
 * scripts/switchbot-verify-key.js と Core.relayHandle のテスト（Issue #718）。
 * 実 API・実機・実 Secrets は使わない（フェイクのみ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');
var K = require('../scripts/switchbot-verify-key.js');

var DEV = 'FULLDEVICEID9999';
var RELAY = 'https://relay.example/exec';
var TOK = { webhook: 'wh-token-xyz', admin: 'admin-token-abc' };
var SECRETS = {
  SWITCHBOT_TOKEN: 'sb-token-111', SWITCHBOT_SECRET: 'sb-secret-222', SWITCHBOT_DEVICE_ID: DEV,
  VERIFY_RELAY_URL: RELAY, VERIFY_RELAY_ADMIN_TOKEN: TOK.admin, VERIFY_WEBHOOK_TOKEN: TOK.webhook
};

function memStore() {
  var m = {};
  return {
    get: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    set: function (k, v) { m[k] = v; },
    del: function (k) { delete m[k]; },
    keys: function () { return Object.keys(m); }
  };
}

/** フェイク世界: リレー(GAS)＋SwitchBot API＋時計。opts.webhook = success|failed|none|wrongEvent|otherCommand */
function world(opts) {
  opts = opts || {};
  var w = { store: memStore(), clock: 1800000000, calls: [], logs: [], keys: opts.keys || [], webhooks: opts.webhooks || [], n: 0 };
  function relayWebhook(commandId, eventName, result) {
    Core.relayHandle(w.store, TOK.webhook, {
      eventType: 'changeReport',
      context: { deviceType: 'WoKeypadTouch', eventName: eventName, commandId: commandId, result: result }
    }, TOK, w.clock);
  }
  w.deps = {
    log: function (m) { w.logs.push(m); },
    nowMs: function () { return w.clock * 1000; },
    nowSec: function () { return w.clock; },
    sleep: async function (ms) { w.clock += ms / 1000; },
    randomInt: function () { return 7; },
    fetch: async function (url, o) {
      var body = o.body ? JSON.parse(o.body) : null;
      var reply = function (http, obj) { return { status: http, json: async function () { return obj; } }; };
      if (url === RELAY) return reply(200, Core.relayHandle(w.store, null, body, TOK, w.clock));
      var path = url.replace(Core.API_BASE, '');
      w.calls.push(o.method + ' ' + path + (body && body.command ? ' ' + body.command : ''));
      if (path === '/v1.1/devices') {
        return reply(200, { statusCode: 100, body: { deviceList: [
          { deviceId: DEV, deviceType: 'Keypad Touch', keyList: w.keys.slice() }] } });
      }
      if (path === '/v1.1/webhook/queryWebhook') return reply(200, { statusCode: 100, body: { urls: w.webhooks.slice() } });
      if (path === '/v1.1/webhook/setupWebhook') { w.webhooks.push(body.url); return reply(200, { statusCode: 100 }); }
      if (path === '/v1.1/webhook/deleteWebhook') {
        w.webhooks = w.webhooks.filter(function (u) { return u !== body.url; });
        return reply(200, { statusCode: 100 });
      }
      if (opts.apiReject) return reply(400, { statusCode: 190 });
      if (opts.netError) throw new Error('network');
      w.n += 1;
      var cid = 'cmd-' + w.n;
      if (body.command === 'createKey') {
        if (!opts.noKeyInList) {
          w.keys.push({ id: 701, name: body.parameter.name });
          if (opts.dupKey) w.keys.push({ id: 702, name: body.parameter.name });
        }
        if (opts.webhook !== 'none') {
          relayWebhook(opts.webhook === 'otherCommand' ? 'unrelated' : cid,
            opts.webhook === 'wrongEvent' ? 'deleteKey' : 'createKey', opts.webhook === 'failed' ? 'failed' : 'success');
        }
      } else if (body.command === 'deleteKey') {
        if (!opts.keepKey) w.keys = w.keys.filter(function (k) { return String(k.id) !== String(body.parameter.id); });
        if (opts.delWebhook !== 'none') relayWebhook(cid, 'deleteKey', 'success');
      }
      return reply(200, { statusCode: 100, body: { commandId: cid } });
    }
  };
  return w;
}

function env(action, extra) {
  var confirm = K.CONFIRM[action];
  return Object.assign({ ACTION: action, CONFIRM: confirm, START_OFFSET_MIN: '5', DURATION_MIN: '15' }, SECRETS, extra || {});
}

function assertNoLeak(w) {
  var out = w.logs.join('\n');
  [DEV, 'sb-token-111', 'sb-secret-222', 'wh-token-xyz', 'admin-token-abc', '77777777', RELAY, '701'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'ログに秘密が出ている: ' + s);
  });
}

function dump(w) { console.error(w.logs.join('\n')); }
function count(w, s) { return w.calls.filter(function (c) { return c.indexOf(s) !== -1; }).length; }

test('入力検証: 確認文字列・Secrets未設定・有効期間範囲を拒否する', function () {
  assert.deepStrictEqual(K.validateInputs(env('create-key')), []);
  assert.ok(K.validateInputs(env('create-key', { CONFIRM: 'yes' })).indexOf('CONFIRM_MISMATCH') !== -1);
  assert.ok(K.validateInputs(env('create-key', { SWITCHBOT_TOKEN: '' })).indexOf('SECRET_MISSING_SWITCHBOT_TOKEN') !== -1);
  assert.ok(K.validateInputs(env('create-key', { DURATION_MIN: '60' })).indexOf('DURATION_RANGE') !== -1);
  assert.ok(K.validateInputs(env('create-key', { START_OFFSET_MIN: '1' })).indexOf('START_OFFSET_RANGE') !== -1);
  assert.deepStrictEqual(K.validateInputs({ ACTION: 'x' }), ['ACTION_INVALID']);
});

test('リレー: 認証・claim重複拒否・パスコード非返却・clear', function () {
  var s = memStore();
  var now = 1800000000;
  var p = { name: 'SNB-API-TEST-1', password: '12345678', startTime: now + 300, endTime: now + 1200 };
  assert.strictEqual(Core.relayHandle(s, null, { op: 'claim', t: 'bad' }, TOK, now).error, 'FORBIDDEN');
  assert.strictEqual(Core.relayHandle(s, 'bad', { eventType: 'changeReport' }, TOK, now).error, 'FORBIDDEN');
  assert.strictEqual(Core.relayHandle(s, null, Object.assign({ op: 'claim', t: TOK.admin }, p), TOK, now).ok, true);
  assert.strictEqual(Core.relayHandle(s, null, Object.assign({ op: 'claim', t: TOK.admin }, p), TOK, now).error, 'ALREADY_CLAIMED');
  var st = Core.relayHandle(s, null, { op: 'getState', t: TOK.admin }, TOK, now).state;
  assert.strictEqual(st.password, undefined);
  assert.strictEqual(Core.relayHandle(s, null, { op: 'getState', t: TOK.admin, reveal: true }, TOK, now).state.password, '12345678');
  Core.relayHandle(s, null, { op: 'clear', t: TOK.admin }, TOK, now);
  assert.strictEqual(s.keys().length, 0);
  assert.strictEqual(Core.relayHandle(s, null, Object.assign({ op: 'claim', t: TOK.admin }, p, { password: '1' }), TOK, now).error, 'INVALID_PARAMS');
});

test('create→delete 正常系: Webhook成功で初めてAPPLIED、keyList消失確認、保持データ破棄、秘密非出力', async function () {
  var w = world();
  var rc = await K.main(env('create-key'), w.deps); if (rc !== 0) dump(w);
  assert.strictEqual(rc, 0);
  assert.strictEqual(count(w, 'createKey'), 1);
  assert.ok(w.logs.join('\n').indexOf('createKey: APPLIED') !== -1);
  var st = JSON.parse(w.store.get('TEST_STATE'));
  assert.strictEqual(st.passcodeId, '701');
  assert.strictEqual(st.password, '77777777'); // リレー側にのみ保持
  var rd = await K.main(env('delete-key'), w.deps); if (rd !== 0) dump(w);
  assert.strictEqual(rd, 0);
  assert.strictEqual(count(w, 'deleteKey'), 1);
  assert.strictEqual(w.keys.length, 0);
  assert.strictEqual(w.store.get('TEST_STATE'), null);
  assertNoLeak(w);
});

test('重複防止: 未削除の状態があれば2回目のcreateは中断しcreateKeyを呼ばない', async function () {
  var w = world();
  await K.main(env('create-key'), w.deps);
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 1);
});

test('Webhook未着: UNKNOWNで停止しcreateKeyを再送せず、状態は残す', async function () {
  var w = world({ webhook: 'none' });
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 1);
  assert.ok(w.logs.join('\n').indexOf('UNKNOWN') !== -1);
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);
  assertNoLeak(w);
});

test('無関係/別イベント/別commandIdのWebhookでは成功にしない', async function () {
  var a = world({ webhook: 'otherCommand' });
  assert.strictEqual(await K.main(env('create-key'), a.deps), 1);
  var b = world({ webhook: 'wrongEvent' });
  assert.strictEqual(await K.main(env('create-key'), b.deps), 1);
  assert.ok(b.logs.join('\n').indexOf('createKey: APPLIED') === -1);
});

test('Webhook failed / API拒否: 失敗終了し状態を残さない', async function () {
  var a = world({ webhook: 'failed' });
  assert.strictEqual(await K.main(env('create-key'), a.deps), 1);
  assert.strictEqual(a.store.get('TEST_STATE'), null);
  var b = world({ apiReject: true });
  assert.strictEqual(await K.main(env('create-key'), b.deps), 1);
  assert.strictEqual(b.store.get('TEST_STATE'), null);
});

test('通信断: 結果不明としてUNKNOWN停止、再送しない', async function () {
  var w = world({ netError: true });
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 1); // 試行は1回のみ
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);
});

test('passcode ID: keyList一致0件/複数件はUNKNOWNでID未保持、削除もしない', async function () {
  var a = world({ noKeyInList: true });
  assert.strictEqual(await K.main(env('create-key'), a.deps), 1);
  assert.strictEqual(JSON.parse(a.store.get('TEST_STATE')).passcodeId, '');
  assert.strictEqual(await K.main(env('delete-key'), a.deps), 1);
  assert.strictEqual(count(a, 'deleteKey'), 0);
  var b = world({ dupKey: true });
  assert.strictEqual(await K.main(env('create-key'), b.deps), 1);
  assert.strictEqual(await K.main(env('delete-key'), b.deps), 1);
  assert.strictEqual(count(b, 'deleteKey'), 0);
  assert.strictEqual(b.keys.length, 2);
});

test('削除: 状態なしは中断。Webhook未確認/keyList残存なら保持データを破棄しない', async function () {
  var none = world();
  assert.strictEqual(await K.main(env('delete-key'), none.deps), 1);
  assert.strictEqual(count(none, 'deleteKey'), 0);

  var nw = world({ delWebhook: 'none' });
  await K.main(env('create-key'), nw.deps);
  assert.strictEqual(await K.main(env('delete-key'), nw.deps), 1);
  assert.notStrictEqual(nw.store.get('TEST_STATE'), null);

  var kept = world({ keepKey: true });
  await K.main(env('create-key'), kept.deps);
  assert.strictEqual(await K.main(env('delete-key'), kept.deps), 1);
  assert.notStrictEqual(kept.store.get('TEST_STATE'), null);
});

test('別runからの後片付け再開: passcode ID未保持でも今回の検証名が1件なら削除できる', async function () {
  var w = world();
  await K.main(env('create-key'), w.deps);
  var st = JSON.parse(w.store.get('TEST_STATE'));
  st.passcodeId = '';
  w.store.set('TEST_STATE', JSON.stringify(st));
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 0);
  assert.strictEqual(w.keys.length, 0);
});

test('対象Keypad不一致なら操作前に中断する', async function () {
  var w = world();
  var e = env('create-key', { SWITCHBOT_DEVICE_ID: 'OTHERDEVICE0000' });
  assert.strictEqual(await K.main(e, w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 0);
});

test('Webhook登録: 既存設定があれば上書きしない。撤去は今回分のみ', async function () {
  var other = world({ webhooks: ['https://other.example/hook'] });
  assert.strictEqual(await K.main(env('webhook-setup'), other.deps), 1);
  assert.deepStrictEqual(other.webhooks, ['https://other.example/hook']);
  assert.strictEqual(await K.main(env('webhook-remove'), other.deps), 0);
  assert.deepStrictEqual(other.webhooks, ['https://other.example/hook']);

  var w = world();
  assert.strictEqual(await K.main(env('webhook-setup'), w.deps), 0);
  assert.strictEqual(w.webhooks.length, 1);
  assert.strictEqual(await K.main(env('webhook-setup'), w.deps), 0); // 冪等
  assert.strictEqual(w.webhooks.length, 1);
  assert.strictEqual(await K.main(env('webhook-remove'), w.deps), 0);
  assert.strictEqual(w.webhooks.length, 0);
  assertNoLeak(w);
});
