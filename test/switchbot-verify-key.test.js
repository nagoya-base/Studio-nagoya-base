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
  var w = { store: memStore(), clock: 1800000000, calls: [], logs: [], keys: opts.keys || [], webhooks: opts.webhooks || [RELAY + '?t=' + TOK.webhook], n: 0 };
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
      if (url === RELAY) {
        if (opts.relayDown) throw new Error('network');
        return reply(200, Core.relayHandle(w.store, null, body, TOK, w.clock));
      }
      if (url.indexOf(RELAY + '?t=') === 0) { // Webhook受信URL（SwitchBot→リレーと同じ経路の試験POST）
        w.probes = (w.probes || 0) + 1;
        if (opts.endpointDown) throw new Error('network');
        return reply(200, Core.relayHandle(w.store, decodeURIComponent(url.slice((RELAY + '?t=').length)), body, TOK, w.clock));
      }
      var path = url.replace(Core.API_BASE, '');
      w.calls.push(o.method + ' ' + path + (body && body.command ? ' ' + body.command : ''));
      if (path === '/v1.1/devices') {
        if (opts.netErrorDevices) throw new Error('network');
        if (w.deleted && opts.failGetAfterDelete && !w.failedOnce) { w.failedOnce = true; throw new Error('network'); }
        var dv = { deviceId: DEV, deviceType: 'Keypad Touch', keyList: w.keys.slice() };
        if (w.deleted && opts.omitKeyListAfterDelete) delete dv.keyList;
        return reply(200, { statusCode: 100, body: { deviceList: [dv] } });
      }
      if (path === '/v1.1/webhook/queryWebhook') {
        if (opts.queryThrow) throw new Error('network https://secret.example/?t=leak');
        if (opts.queryReply) return reply(opts.queryReply.http, opts.queryReply.body);
        return reply(200, { statusCode: 100, body: { urls: w.webhooks.slice() } });
      }
      if (path === '/v1.1/webhook/setupWebhook') { w.webhooks.push(body.url); return reply(200, { statusCode: 100 }); }
      if (path === '/v1.1/webhook/deleteWebhook') {
        w.webhooks = w.webhooks.filter(function (u) { return u !== body.url; });
        return reply(200, { statusCode: 100 });
      }
      if (opts.apiReject) return reply(400, { statusCode: 190 });
      if (opts.netError) throw new Error('network');
      w.n += 1;
      var cid = 'cmd-' + w.n;
      var respond = function () {
        if (opts.respond502 && body.command === 'createKey') return reply(502, null);
        if (opts.noCommandId) return reply(200, { statusCode: 100, body: {}, message: 'success' }); // 実測(Issue #744): commandId なし
        return reply(200, { statusCode: 100, body: { commandId: cid } });
      };
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
        w.deleted = true;
        if (!opts.keepKey) w.keys = w.keys.filter(function (k) { return String(k.id) !== String(body.parameter.id); });
        if (opts.delWebhook !== 'none') relayWebhook(cid, 'deleteKey', 'success');
      }
      return respond();
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
  var p = { deviceId: DEV, name: 'SNB-API-TEST-1', password: '12345678', startTime: now + 300, endTime: now + 1200 };
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

test('受理有無不明のcreateKey応答(502/JSONなし)では状態を消さず、再実行しても追加発行しない', async function () {
  var w = world({ respond502: true });
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(w.keys.length, 1); // 実際には作成されている
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 1);
  assert.strictEqual(w.keys.length, 1);
  // 状態が残っているので delete-key で後片付けできる（keyListから今回の検証名を特定）
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 0); // 保持した状態から後片付けできる
  assert.strictEqual(w.keys.length, 0);
});

test('削除: 発行元deviceId不一致・保存ID不一致・検証名不一致ではdeleteKeyを送らない', async function () {
  async function setup() {
    var w = world();
    await K.main(env('create-key'), w.deps);
    return w;
  }
  function patch(w, f) {
    var st = JSON.parse(w.store.get('TEST_STATE'));
    f(st);
    w.store.set('TEST_STATE', JSON.stringify(st));
  }
  var a = await setup();
  patch(a, function (st) { st.deviceId = 'OTHERDEVICE0000'; });
  assert.strictEqual(await K.main(env('delete-key'), a.deps), 1);
  assert.strictEqual(count(a, 'deleteKey'), 0);

  var b = await setup();
  patch(b, function (st) { st.passcodeId = '999'; });
  assert.strictEqual(await K.main(env('delete-key'), b.deps), 1);
  assert.strictEqual(count(b, 'deleteKey'), 0);

  var c = await setup();
  patch(c, function (st) { st.name = 'SNB-API-TEST-other'; });
  assert.strictEqual(await K.main(env('delete-key'), c.deps), 1);
  assert.strictEqual(count(c, 'deleteKey'), 0);
  assert.strictEqual(c.keys.length, 1);

  var d = await setup();
  patch(d, function (st) { delete st.deviceId; }); // 旧形式の状態
  assert.strictEqual(await K.main(env('delete-key'), d.deps), 1);
  assert.strictEqual(count(d, 'deleteKey'), 0);
});

test('削除後のkeyList欠落/不完全応答ではキー消失とみなさず状態を保持する', async function () {
  var w = world({ omitKeyListAfterDelete: true, keepKey: true });
  await K.main(env('create-key'), w.deps);
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 1);
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);
  assert.strictEqual(w.keys.length, 1);
  assert.ok(w.logs.join('\n').indexOf('KEYLIST_INVALID') !== -1);
  assert.strictEqual(C_inspect([{ deviceId: DEV }]).valid, false);
  assert.strictEqual(C_inspect([{ deviceId: DEV, keyList: null }]).valid, false);
  assert.strictEqual(C_inspect([{ deviceId: DEV, keyList: [] }, { deviceId: DEV, keyList: [] }]).valid, false);
  assert.strictEqual(C_inspect([{ deviceId: DEV, keyList: [] }]).count, 0);
});

function C_inspect(list) { return Core.inspectKeyList(list, DEV, 'n'); }

test('削除後の一覧取得が一時失敗しても、別runで保存済みcommandIdから確認を再開できる（再削除しない）', async function () {
  var w = world({ failGetAfterDelete: true });
  await K.main(env('create-key'), w.deps);
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 1);
  assert.strictEqual(w.keys.length, 0); // 実際には削除済み
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);
  assert.ok(JSON.parse(w.store.get('TEST_STATE')).deleteCommandId);
  // 状態が残っている間は新規createを許さない
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 1);
  // 復旧後の再実行: 再削除せず Webhook結果 + keyList消失を確認してclear
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 0);
  assert.strictEqual(count(w, 'deleteKey'), 1);
  assert.strictEqual(w.store.get('TEST_STATE'), null);
});

test('再開時にWebhook成功でもキーが残っていれば再削除せず保持する／キーが無いだけでは成功にしない', async function () {
  var w = world({ keepKey: true });
  await K.main(env('create-key'), w.deps);
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 1);
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 1);
  assert.strictEqual(count(w, 'deleteKey'), 1);
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);

  // Webhook結果が無い再開は、キーが無くても成功にしない
  var n = world({ delWebhook: 'none' });
  await K.main(env('create-key'), n.deps);
  assert.strictEqual(await K.main(env('delete-key'), n.deps), 1);
  assert.strictEqual(n.keys.length, 0);
  assert.strictEqual(await K.main(env('delete-key'), n.deps), 1);
  assert.strictEqual(count(n, 'deleteKey'), 1);
  assert.notStrictEqual(n.store.get('TEST_STATE'), null);
});

var MUTATING = ['setupWebhook', 'updateWebhook', 'deleteWebhook', 'createKey', 'deleteKey'];
function assertReadOnlyQuery(w) {
  assert.deepStrictEqual(w.calls, ['post /v1.1/webhook/queryWebhook']);
  MUTATING.forEach(function (m) { assert.strictEqual(count(w, m), 0); });
}

test('webhook-query: 入力検証は照会に必要な秘密のみ要求し、確認文字列を必須とする', function () {
  var e = env('webhook-query', { SWITCHBOT_DEVICE_ID: '', VERIFY_RELAY_ADMIN_TOKEN: '' });
  assert.deepStrictEqual(K.validateInputs(e), []);
  assert.ok(K.validateInputs(env('webhook-query', { CONFIRM: 'SETUP-WEBHOOK' })).indexOf('CONFIRM_MISMATCH') !== -1);
  assert.ok(K.validateInputs(env('webhook-query', { VERIFY_WEBHOOK_TOKEN: '' })).indexOf('SECRET_MISSING_VERIFY_WEBHOOK_TOKEN') !== -1);
});

test('webhook-query: 未登録は NONE(0)、一致は MATCH(0)、変更APIを呼ばない', async function () {
  var none = world({ webhooks: [] });
  assert.strictEqual(await K.main(env('webhook-query'), none.deps), 0);
  assert.ok(none.logs.join('\n').indexOf('NONE 件数=0') !== -1);
  assertReadOnlyQuery(none);
  assertNoLeak(none);

  var url = RELAY + '?t=' + encodeURIComponent(TOK.webhook);
  var match = world({ webhooks: [url] });
  assert.strictEqual(await K.main(env('webhook-query'), match.deps), 0);
  assert.ok(match.logs.join('\n').indexOf('MATCH 件数=1') !== -1);
  assertReadOnlyQuery(match);
  assert.deepStrictEqual(match.webhooks, [url]); // 再登録・削除しない
  assertNoLeak(match);
});

test('webhook-query: 不一致は MISMATCH(1)で上書き・削除せず、URLを出さない', async function () {
  var w = world({ webhooks: ['https://other.example/hook?t=other-secret'] });
  assert.strictEqual(await K.main(env('webhook-query'), w.deps), 1);
  assert.ok(w.logs.join('\n').indexOf('MISMATCH 件数=1') !== -1);
  assertReadOnlyQuery(w);
  assert.deepStrictEqual(w.webhooks, ['https://other.example/hook?t=other-secret']);
  assert.ok(w.logs.join('\n').indexOf('other.example') === -1);
  assert.ok(w.logs.join('\n').indexOf('other-secret') === -1);
  assertNoLeak(w);
});

test('webhook-query: 応答不正・API失敗・通信失敗は UNKNOWN(1)で「登録なし」と見なさない', async function () {
  var cases = [
    { http: 200, body: { statusCode: 100, body: {} } },                      // urls 欠落
    { http: 200, body: { statusCode: 100 } },                                // body 欠落
    { http: 200, body: { statusCode: 100, body: { urls: 'x' } } },           // 配列でない
    { http: 200, body: { statusCode: 100, body: { urls: [1] } } },           // 文字列でない要素
    { http: 200, body: { statusCode: 190, message: 'free text https://x.example/?t=leak' } }, // API失敗
    { http: 500, body: null }                                                // HTTP失敗
  ];
  for (var i = 0; i < cases.length; i++) {
    var w = world({ queryReply: cases[i] });
    assert.strictEqual(await K.main(env('webhook-query'), w.deps), 1, 'case ' + i);
    assert.ok(w.logs.join('\n').indexOf('UNKNOWN') !== -1, 'case ' + i);
    assert.ok(w.logs.join('\n').indexOf('NONE') === -1, 'case ' + i);
    assert.ok(w.logs.join('\n').indexOf('leak') === -1, 'case ' + i);
    assertReadOnlyQuery(w);
    assertNoLeak(w);
  }
  var t = world({ queryThrow: true });
  assert.strictEqual(await K.main(env('webhook-query'), t.deps), 1);
  assert.ok(t.logs.join('\n').indexOf('UNKNOWN') !== -1);
  assert.ok(t.logs.join('\n').indexOf('leak') === -1);
  assertNoLeak(t);
});

test('evaluateWebhookQuery: 判定は純粋関数で状態・件数・コードのみ返す', function () {
  var u = 'https://r.example/exec?t=a';
  assert.strictEqual(K.evaluateWebhookQuery(200, { statusCode: 100, body: { urls: [] } }, u).state, 'NONE');
  assert.strictEqual(K.evaluateWebhookQuery(200, { statusCode: 100, body: { urls: [u] } }, u).state, 'MATCH');
  assert.strictEqual(K.evaluateWebhookQuery(200, { statusCode: 100, body: { urls: ['z', u] } }, u).state, 'MATCH');
  assert.strictEqual(K.evaluateWebhookQuery(200, { statusCode: 100, body: { urls: ['z'] } }, u).state, 'MISMATCH');
  var r = K.evaluateWebhookQuery(200, { statusCode: 100, body: { urls: ['z'] } }, u);
  assert.deepStrictEqual(Object.keys(r).sort(), ['count', 'http', 'reason', 'state', 'statusCode']);
});

// ---- 追加診断（Issue #725）: ダミー値のみ。実Secrets・実APIは使わない ----
var LEAK_MARKERS = ['relay.example', 'other.example', 'wrong-token-qq', 'wh-token-xyz', 'secret-path', 'exec', 'dup1', 'dup2'];
function diagLog(w) {
  return w.logs.filter(function (l) { return l.indexOf('追加診断') !== -1; }).join('\n');
}
async function runQuery(webhooks, extraWorld) {
  var w = world(Object.assign({ webhooks: webhooks }, extraWorld || {}));
  var code = await K.main(env('webhook-query'), w.deps);
  assertReadOnlyQuery(w);
  assertNoLeak(w);
  assert.deepStrictEqual(w.webhooks, webhooks || []);
  return { w: w, code: code, out: w.logs.join('\n') };
}

test('追加診断: ベースURL一致で t の 一致/不一致/欠落/空値 を区別し、終了コードは完全一致判定のまま', async function () {
  var t = encodeURIComponent(TOK.webhook);
  var cases = [
    [RELAY + '?t=' + t, 'BASE_URL_MATCH + TOKEN_MATCH', 0],
    [RELAY + '?t=wrong-token-qq', 'BASE_URL_MATCH + TOKEN_MISMATCH', 1],
    [RELAY, 'BASE_URL_MATCH + TOKEN_MISSING', 1],
    [RELAY + '?x=1', 'BASE_URL_MATCH + TOKEN_MISSING', 1],
    [RELAY + '?t=', 'BASE_URL_MATCH + TOKEN_MISMATCH', 1],   // 空の t は欠落と混同しない
    [RELAY + '?t', 'BASE_URL_MATCH + TOKEN_MISMATCH', 1],
    [RELAY.toUpperCase().replace('HTTPS', 'https').replace('/EXEC', '/exec') + '?t=' + t, 'BASE_URL_MATCH + TOKEN_MATCH', 1] // host 大小文字は診断では一致、完全一致判定(文字列一致)は従来どおり MISMATCH
  ];
  for (var i = 0; i < cases.length; i++) {
    var r = await runQuery([cases[i][0]]);
    assert.ok(diagLog(r.w).indexOf(cases[i][1]) !== -1, 'case ' + i + ': ' + diagLog(r.w));
    if (cases[i][1].indexOf('TOKEN_MISSING') !== -1) assert.ok(diagLog(r.w).indexOf('TOKEN_MATCH') === -1);
    assert.strictEqual(r.code, cases[i][2], 'case ' + i);
    LEAK_MARKERS.forEach(function (m) { assert.ok(r.out.indexOf(m) === -1, 'leak ' + m + ' case ' + i); });
  }
});

test('追加診断: scheme / host / port / path の不一致は BASE_URL_MISMATCH（誤って一致扱いしない）', async function () {
  var t = '?t=' + encodeURIComponent(TOK.webhook);
  var urls = [
    'http://relay.example/exec' + t,            // scheme
    'https://other.example/exec' + t,           // host
    'https://relay.example:8443/exec' + t,      // port
    'https://relay.example/secret-path' + t,    // path
    'https://relay.example/exec/' + t,          // 末尾スラッシュも同一視しない
    'https://relay.example/exec/extra' + t,
    'https://sub.relay.example/exec' + t
  ];
  for (var i = 0; i < urls.length; i++) {
    var r = await runQuery([urls[i]]);
    assert.ok(diagLog(r.w).indexOf('BASE_URL_MISMATCH') !== -1, 'case ' + i);
    assert.ok(diagLog(r.w).indexOf('TOKEN') === -1, 'case ' + i);
    assert.strictEqual(r.code, 1, 'case ' + i);
    ['other.example', 'secret-path'].forEach(function (m) { assert.ok(r.out.indexOf(m) === -1); });
  }
});

test('追加診断: 重複t・複数件・0件・解析不能URL・曖昧入力は推測せず UNKNOWN（診断で成功へ格上げしない）', async function () {
  var t = encodeURIComponent(TOK.webhook);
  // 重複 t（片方が一致でも推測しない）
  var dup = await runQuery([RELAY + '?t=' + t + '&t=dup1']);
  assert.ok(diagLog(dup.w).indexOf('UNKNOWN') !== -1);
  assert.ok(diagLog(dup.w).indexOf('TOKEN_MATCH') === -1);
  assert.strictEqual(dup.code, 1);
  // 複数件（うち1件が完全一致でも追加診断はしない。完全一致判定は従来どおり MATCH）
  var multi = await runQuery(['https://other.example/hook', RELAY + '?t=' + t]);
  assert.ok(diagLog(multi.w).indexOf('UNKNOWN') !== -1);
  assert.ok(diagLog(multi.w).indexOf('BASE_URL') === -1);
  assert.strictEqual(multi.code, 0);
  var multi2 = await runQuery(['https://other.example/a', 'https://other.example/b']);
  assert.ok(diagLog(multi2.w).indexOf('UNKNOWN') !== -1);
  assert.strictEqual(multi2.code, 1);
  // 0件: NONE は維持、追加診断は成功扱いしない
  var none = await runQuery([]);
  assert.ok(none.out.indexOf('NONE 件数=0') !== -1);
  assert.ok(diagLog(none.w).indexOf('UNKNOWN') !== -1);
  assert.ok(diagLog(none.w).indexOf('MATCH') === -1);
  // 解析不能URL
  var bad = await runQuery(['not a url?t=wrong-token-qq']);
  assert.ok(diagLog(bad.w).indexOf('UNKNOWN') !== -1);
  assert.strictEqual(bad.code, 1);
  assert.ok(bad.out.indexOf('wrong-token-qq') === -1);
  // ユーザー情報付きは曖昧として UNKNOWN
  var ui = await runQuery(['https://user:pw@relay.example/exec?t=' + t]);
  assert.ok(diagLog(ui.w).indexOf('UNKNOWN') !== -1);
  // 期待側 VERIFY_RELAY_URL に t が含まれる／トークン空は UNKNOWN（純粋関数）
  assert.strictEqual(K.diagnoseWebhookUrl(RELAY + '?t=a', RELAY + '?t=a', 'a'), 'UNKNOWN');
  assert.strictEqual(K.diagnoseWebhookUrl(RELAY + '?t=a', RELAY, ''), 'UNKNOWN');
  assert.strictEqual(K.diagnoseWebhookUrl(RELAY + '?t=a', '::bad::', 'a'), 'UNKNOWN');
});

test('追加診断: 応答不正・API失敗・通信失敗・秘密未設定では診断せず UNKNOWN/安全停止', async function () {
  var cases = [
    { http: 200, body: { statusCode: 100, body: {} } },
    { http: 200, body: { statusCode: 100 } },
    { http: 200, body: { statusCode: 100, body: { urls: 'x' } } },
    { http: 200, body: { statusCode: 100, body: { urls: [1] } } },
    { http: 200, body: { statusCode: 190, message: 'free text https://relay.example/exec?t=leak' } },
    { http: 500, body: null }
  ];
  for (var i = 0; i < cases.length; i++) {
    var w = world({ queryReply: cases[i] });
    assert.strictEqual(await K.main(env('webhook-query'), w.deps), 1, 'case ' + i);
    assert.ok(diagLog(w).indexOf('BASE_URL') === -1 && diagLog(w).indexOf('TOKEN') === -1, 'case ' + i);
    assert.ok(w.logs.join('\n').indexOf('leak') === -1);
    assertReadOnlyQuery(w);
    assertNoLeak(w);
  }
  var t = world({ queryThrow: true });
  assert.strictEqual(await K.main(env('webhook-query'), t.deps), 1);
  assert.ok(diagLog(t).indexOf('TOKEN') === -1);
  assert.ok(t.logs.join('\n').indexOf('leak') === -1);
  // 秘密未設定は API を一切呼ばず安全停止
  var m = world();
  assert.strictEqual(await K.main(env('webhook-query', { VERIFY_WEBHOOK_TOKEN: '' }), m.deps), 1);
  assert.strictEqual(m.calls.length, 0);
  var m2 = world();
  assert.strictEqual(await K.main(env('webhook-query', { VERIFY_RELAY_URL: '' }), m2.deps), 1);
  assert.strictEqual(m2.calls.length, 0);
});

test('追加診断: TOKEN_MATCH だけで完全一致扱いにしない（別クエリ付きは MISMATCH のまま終了コード1）', async function () {
  var r = await runQuery([RELAY + '?t=' + encodeURIComponent(TOK.webhook) + '&extra=1']);
  assert.ok(r.out.indexOf('MISMATCH 件数=1') !== -1);
  assert.ok(diagLog(r.w).indexOf('BASE_URL_MATCH + TOKEN_MATCH') !== -1);
  assert.strictEqual(r.code, 1);
});

// ---- Issue #718: preflight（読み取り専用の事前確認）と create-key の発行前ゲート ----
var MUTATING = ['createKey', 'deleteKey', 'setupWebhook', 'updateWebhook', 'deleteWebhook'];
function assertNoMutation(w) {
  MUTATING.forEach(function (m) { assert.strictEqual(count(w, m), 0, '変更系が呼ばれた: ' + m); });
  assert.strictEqual(count(w, 'POST /v1.1/devices/'), 0);
}

test('preflight: 全項目PASSで終了0。変更APIを呼ばず、秘密・完全IDを出さない', async function () {
  var w = world();
  var rc = await K.main(env('preflight'), w.deps); if (rc !== 0) dump(w);
  assert.strictEqual(rc, 0);
  var out = w.logs.join('\n');
  assert.ok(out.indexOf('PREFLIGHT_PASS') !== -1);
  assert.ok(out.indexOf('末尾4桁=9999') !== -1);
  assertNoMutation(w);
  assert.strictEqual(w.store.get('TEST_STATE'), null);
  assertNoLeak(w);
});

test('preflight: Webhook 未登録/不一致/複数件/照会失敗は失敗（MATCHかつ厳密1件のみ許可）', async function () {
  var url = RELAY + '?t=' + TOK.webhook;
  var cases = [
    { webhooks: [] },
    { webhooks: ['https://other.example/hook?t=zzz'] },
    { webhooks: [url, 'https://other.example/hook'] },
    { queryReply: { http: 200, body: { statusCode: 190 } } },
    { queryReply: { http: 200, body: { statusCode: 100, body: {} } } },
    { queryThrow: true }
  ];
  for (var i = 0; i < cases.length; i++) {
    var w = world(cases[i]);
    assert.strictEqual(await K.main(env('preflight'), w.deps), 1, 'case ' + i);
    assert.ok(w.logs.join('\n').indexOf('PREFLIGHT_FAIL') !== -1);
    assertNoMutation(w);
    assertNoLeak(w);
  }
});

test('preflight: 受信URL不達・リレー不達・検証状態使用中・残存テストキーは失敗', async function () {
  var a = world({ endpointDown: true });
  assert.strictEqual(await K.main(env('preflight'), a.deps), 1);
  assert.ok(a.logs.join('\n').indexOf('WEBHOOK_ENDPOINT: FAIL') !== -1);
  var b = world({ relayDown: true });
  assert.strictEqual(await K.main(env('preflight'), b.deps), 1);
  assert.ok(b.logs.join('\n').indexOf('RELAY_ADMIN: FAIL') !== -1);
  var c = world();
  Core.relayHandle(c.store, null, { op: 'claim', t: TOK.admin, deviceId: DEV, name: 'SNB-API-TEST-1', password: '12345678',
    startTime: c.clock + 300, endTime: c.clock + 1200 }, TOK, c.clock);
  assert.strictEqual(await K.main(env('preflight'), c.deps), 1);
  assert.ok(c.logs.join('\n').indexOf('RELAY_STATE: IN_USE') !== -1);
  var d = world({ keys: [{ id: 5, name: 'SNB-API-TEST-123' }, { id: 6, name: 'regular user' }] });
  assert.strictEqual(await K.main(env('preflight'), d.deps), 1);
  assert.ok(d.logs.join('\n').indexOf('LEFTOVER_TEST_KEYS: FOUND(1)') !== -1);
  [a, b, c, d].forEach(function (w) { assertNoMutation(w); assertNoLeak(w); });
});

test('preflight: Keypad 不一致/0件/API失敗は失敗', async function () {
  var w = world();
  assert.strictEqual(await K.main(env('preflight', { SWITCHBOT_DEVICE_ID: 'OTHERDEVICE0000' }), w.deps), 1);
  assert.ok(w.logs.join('\n').indexOf('KEYPAD: FAIL(NOT_FOUND)') !== -1);
  assertNoMutation(w);
  var n = world({ netErrorDevices: true });
  assert.strictEqual(await K.main(env('preflight'), n.deps), 1);
  assert.ok(n.logs.join('\n').indexOf('KEYPAD: FAIL(DEVICES_FAILED)') !== -1);
});

test('preflight: Secrets 未設定・確認文字列不一致は非0。Re-run でも読み取り専用なので許可', function () {
  assert.ok(K.validateInputs(env('preflight', { VERIFY_RELAY_URL: '' })).indexOf('SECRET_MISSING_VERIFY_RELAY_URL') !== -1);
  assert.ok(K.validateInputs(env('preflight', { CONFIRM: 'x' })).indexOf('CONFIRM_MISMATCH') !== -1);
  assert.deepStrictEqual(K.validateInputs(env('preflight', { GITHUB_RUN_ATTEMPT: '2' })), []);
});

test('create-key 発行前ゲート: Webhook 未設定/不一致/受信不達ならclaimもcreateKeyも送らない', async function () {
  var cases = [{ webhooks: [] }, { webhooks: ['https://other.example/hook'] }, { endpointDown: true }];
  for (var i = 0; i < cases.length; i++) {
    var w = world(cases[i]);
    assert.strictEqual(await K.main(env('create-key'), w.deps), 1, 'case ' + i);
    assert.strictEqual(count(w, 'createKey'), 0);
    assert.strictEqual(w.store.get('TEST_STATE'), null); // claim もされない
    assert.ok(w.logs.join('\n').indexOf('事前確認が未達') !== -1);
    assertNoLeak(w);
  }
});

test('再実行・同時実行: preflight 後の create-key は1回だけ。2回目は claim 拒否でcreateKey 0回', async function () {
  var w = world();
  assert.strictEqual(await K.main(env('preflight'), w.deps), 0);
  assert.strictEqual(await K.main(env('create-key'), w.deps), 0);
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 1);
  assert.strictEqual(await K.main(env('preflight'), w.deps), 1); // 使用中の状態は preflight でも検知
  assertNoLeak(w);
});


// ---------------------------------------------------------------------------
// Issue #744: 同期応答に commandId が無い（statusCode=100 + body={}）ケース。変更APIは各最大1回。
// ---------------------------------------------------------------------------

function logs(w) { return w.logs.join('\n'); }

test('#744 実測回帰(37DD): create=statusCode100+body{}でkeyList 0→1を確認、解錠後delete=1→0で後片付け（各1回）', async function () {
  var w = world({ noCommandId: true });
  assert.strictEqual(w.keys.length, 0);
  var rc = await K.main(env('create-key'), w.deps); if (rc !== 0) dump(w);
  assert.strictEqual(rc, 0);
  assert.strictEqual(count(w, 'createKey'), 1);
  assert.strictEqual(w.keys.length, 1);
  var out = logs(w);
  assert.ok(out.indexOf('ACCEPTED_NO_COMMAND_ID') !== -1);
  assert.ok(out.indexOf('createKey: KEYLIST_CONFIRMED') !== -1);
  assert.ok(out.indexOf('相関確認なし') !== -1);
  assert.ok(out.indexOf('createKey: APPLIED') === -1, 'Webhook成功と偽装しない');
  var st = JSON.parse(w.store.get('TEST_STATE'));
  assert.strictEqual(st.passcodeId, '701');
  assert.strictEqual(st.createCommandId, K.NO_COMMAND_ID);

  var rd = await K.main(env('delete-key'), w.deps); if (rd !== 0) dump(w);
  assert.strictEqual(rd, 0);
  assert.strictEqual(count(w, 'deleteKey'), 1);
  assert.strictEqual(w.keys.length, 0);
  assert.strictEqual(w.store.get('TEST_STATE'), null);
  assert.ok(logs(w).indexOf('deleteKey: KEYLIST_CONFIRMED') !== -1);
  assert.ok(logs(w).indexOf('deleteKey: APPLIED') === -1);
  assertNoLeak(w);
});

test('#744 create: 反映が遅れて現れても待機後に確認できる（再送しない）', async function () {
  var w = world({ noCommandId: true });
  var polls = 0;
  var orig = w.deps.fetch;
  w.deps.fetch = async function (url, o) {
    // createKey 後の最初の2回の一覧取得では未反映（keyListには出さない）
    if (w.keys.length === 1 && url.indexOf('/v1.1/devices') !== -1 && url.indexOf('/commands') === -1 && polls < 2 && w.calls.some(function (x) { return x.indexOf('createKey') !== -1; })) {
      polls += 1;
      w.calls.push('get /v1.1/devices');
      return { status: 200, json: async function () { return { statusCode: 100, body: { deviceList: [{ deviceId: DEV, deviceType: 'Keypad Touch', keyList: [] }] } }; } };
    }
    return orig(url, o);
  };
  assert.strictEqual(await K.main(env('create-key'), w.deps), 0);
  assert.strictEqual(polls, 2);
  assert.strictEqual(count(w, 'createKey'), 1);
});

test('#744 create: keyList 0件(待機後timeout)・複数件・不正・通信失敗はUNKNOWN、再送なし、状態は保持', async function () {
  var none = world({ noCommandId: true, noKeyInList: true });
  assert.strictEqual(await K.main(env('create-key'), none.deps), 1);
  assert.strictEqual(count(none, 'createKey'), 1);
  assert.notStrictEqual(none.store.get('TEST_STATE'), null);
  assert.ok(logs(none).indexOf('UNKNOWN') !== -1);
  assert.ok(logs(none).indexOf('KEYLIST_CONFIRMED') === -1);

  var dup = world({ noCommandId: true, dupKey: true });
  assert.strictEqual(await K.main(env('create-key'), dup.deps), 1);
  assert.strictEqual(count(dup, 'createKey'), 1);
  assert.strictEqual(JSON.parse(dup.store.get('TEST_STATE')).passcodeId, '');
  assert.ok(logs(dup).indexOf('KEY_NAME_AMBIGUOUS') !== -1);

  // keyList が配列でない（欠落）応答
  var bad = world({ noCommandId: true });
  var orig = bad.deps.fetch;
  bad.deps.fetch = async function (url, o) {
    if (bad.calls.some(function (x) { return x.indexOf('createKey') !== -1; }) && url.indexOf('/commands') === -1 && url.indexOf('/v1.1/devices') !== -1) {
      return { status: 200, json: async function () { return { statusCode: 100, body: { deviceList: [{ deviceId: DEV, deviceType: 'Keypad Touch' }] } }; } };
    }
    return orig(url, o);
  };
  assert.strictEqual(await K.main(env('create-key'), bad.deps), 1);
  assert.strictEqual(count(bad, 'createKey'), 1);
  assert.ok(logs(bad).indexOf('KEYLIST_INVALID') !== -1);

  // 通信失敗
  var net = world({ noCommandId: true });
  var o2 = net.deps.fetch;
  net.deps.fetch = async function (url, o) {
    if (net.calls.some(function (x) { return x.indexOf('createKey') !== -1; }) && url.indexOf('/commands') === -1 && url.indexOf('/v1.1/devices') !== -1) throw new Error('network');
    return o2(url, o);
  };
  assert.strictEqual(await K.main(env('create-key'), net.deps), 1);
  assert.strictEqual(count(net, 'createKey'), 1);
  assert.notStrictEqual(net.store.get('TEST_STATE'), null);
  assertNoLeak(none); assertNoLeak(dup); assertNoLeak(bad); assertNoLeak(net);
});

test('#744 create: 発行前に同名キーがある/keyList不正ならclaimもcreateKeyも送らない', async function () {
  var w = world({ noCommandId: true });
  // 今回の検証名と同名のキーが既に存在
  w.keys.push({ id: 5, name: Core.buildTestName(w.clock) });
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 0);
  assert.strictEqual(w.store.get('TEST_STATE'), null);

  var bad = world({ noCommandId: true, omitKeyListAfterDelete: true });
  bad.deleted = true; // keyList を欠落させる
  assert.strictEqual(await K.main(env('create-key'), bad.deps), 1);
  assert.strictEqual(count(bad, 'createKey'), 0);
  assert.strictEqual(bad.store.get('TEST_STATE'), null);
});

test('#744 create: 二重実行(Re-run/同時)でも、状態が残る限りcreateKeyは再送されない', async function () {
  var w = world({ noCommandId: true, noKeyInList: true });
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(await K.main(env('create-key'), w.deps), 1);
  assert.strictEqual(count(w, 'createKey'), 1);
});

test('#744 delete: statusCode100+body{}でkeyList 1→0を確認しclear。commandIdなしを中間状態として永続化', async function () {
  var w = world({ noCommandId: true });
  await K.main(env('create-key'), w.deps);
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 0);
  assert.strictEqual(count(w, 'deleteKey'), 1);
  assert.strictEqual(w.store.get('TEST_STATE'), null);
});

test('#744 delete: commandIdなしでkeyListに残存/不正/通信失敗ならUNKNOWN。再送せず、別runは確認だけ再開', async function () {
  var kept = world({ noCommandId: true, keepKey: true });
  await K.main(env('create-key'), kept.deps);
  assert.strictEqual(await K.main(env('delete-key'), kept.deps), 1);
  assert.strictEqual(count(kept, 'deleteKey'), 1);
  assert.strictEqual(kept.keys.length, 1);
  assert.strictEqual(JSON.parse(kept.store.get('TEST_STATE')).deleteCommandId, K.NO_COMMAND_ID);
  // 再実行しても deleteKey は再送されない
  assert.strictEqual(await K.main(env('delete-key'), kept.deps), 1);
  assert.strictEqual(count(kept, 'deleteKey'), 1);
  assert.notStrictEqual(kept.store.get('TEST_STATE'), null);
  assert.ok(logs(kept).indexOf('deleteKey: KEYLIST_CONFIRMED') === -1);

  var inv = world({ noCommandId: true, keepKey: true, omitKeyListAfterDelete: true });
  await K.main(env('create-key'), inv.deps);
  assert.strictEqual(await K.main(env('delete-key'), inv.deps), 1);
  assert.strictEqual(count(inv, 'deleteKey'), 1);
  assert.ok(logs(inv).indexOf('KEYLIST_INVALID') !== -1);
  assert.notStrictEqual(inv.store.get('TEST_STATE'), null);

  // 通信失敗で確認できなかった後、復旧した別runが再削除せずに消失を確認してclear
  var flaky = world({ noCommandId: true, failGetAfterDelete: true });
  await K.main(env('create-key'), flaky.deps);
  assert.strictEqual(await K.main(env('delete-key'), flaky.deps), 1);
  assert.strictEqual(flaky.keys.length, 0);
  assert.strictEqual(JSON.parse(flaky.store.get('TEST_STATE')).deleteCommandId, K.NO_COMMAND_ID);
  assert.strictEqual(await K.main(env('delete-key'), flaky.deps), 0);
  assert.strictEqual(count(flaky, 'deleteKey'), 1);
  assert.strictEqual(flaky.store.get('TEST_STATE'), null);
  assertNoLeak(kept); assertNoLeak(inv); assertNoLeak(flaky);
});

test('#744 delete: 対象名が0/複数一致なら別キーを削除せず、deleteKeyを送らない', async function () {
  var w = world({ noCommandId: true });
  await K.main(env('create-key'), w.deps);
  w.keys.push({ id: 702, name: JSON.parse(w.store.get('TEST_STATE')).name }); // 同名が複数
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 1);
  assert.strictEqual(count(w, 'deleteKey'), 0);
  assert.strictEqual(w.keys.length, 2);
  var z = world({ noCommandId: true });
  await K.main(env('create-key'), z.deps);
  z.keys.length = 0; // 0件
  assert.strictEqual(await K.main(env('delete-key'), z.deps), 1);
  assert.strictEqual(count(z, 'deleteKey'), 0);
});

test('#744 従来のcommandId経路は維持: Webhook相関でAPPLIED。commandIdありではkeyList単独確認に切り替えない', async function () {
  var w = world();
  assert.strictEqual(await K.main(env('create-key'), w.deps), 0);
  assert.ok(logs(w).indexOf('createKey: APPLIED') !== -1);
  assert.ok(logs(w).indexOf('ACCEPTED_NO_COMMAND_ID') === -1);
  assert.strictEqual(JSON.parse(w.store.get('TEST_STATE')).createCommandId, 'cmd-1');
  assert.strictEqual(await K.main(env('delete-key'), w.deps), 0);
  assert.ok(logs(w).indexOf('deleteKey: APPLIED') !== -1);
  // commandIdありでWebhook未着ならUNKNOWNのまま（keyListだけでは成功にしない）
  var n = world({ webhook: 'none' });
  assert.strictEqual(await K.main(env('create-key'), n.deps), 1);
  assert.ok(logs(n).indexOf('KEYLIST_CONFIRMED') === -1);
});

test('#744 変更APIは各経路で最大1回、ログに秘密・passcode ID・生レスポンスを出さない', async function () {
  for (var o of [{ noCommandId: true }, { noCommandId: true, keepKey: true }, { noCommandId: true, noKeyInList: true }]) {
    var w = world(o);
    await K.main(env('create-key'), w.deps);
    await K.main(env('delete-key'), w.deps);
    await K.main(env('delete-key'), w.deps);
    assert.ok(count(w, 'createKey') <= 1);
    assert.ok(count(w, 'deleteKey') <= 1);
    assertNoLeak(w);
    assert.ok(logs(w).indexOf('"statusCode"') === -1 && logs(w).indexOf('message') === -1);
  }
});

// ---- Issue #746: 旧 TEST_STATE のみを安全に clear する復旧（clear-stale-state） ----
function seedStale(w) {
  Core.relayHandle(w.store, null, { op: 'claim', t: TOK.admin, deviceId: DEV, name: 'SNB-API-TEST-1', password: '77777777',
    startTime: w.clock + 300, endTime: w.clock + 1200 }, TOK, w.clock);
  Core.relayHandle(w.store, null, { op: 'setPasscodeId', t: TOK.admin, passcodeId: 701 }, TOK, w.clock);
}
/** fetch を包んで relay の op 呼び出しを数え、応答を差し替える。hook(url, body) が値を返せばそれを応答にする。 */
function spy(w, hook) {
  var inner = w.deps.fetch;
  w.relayOps = [];
  w.deps.fetch = async function (url, o) {
    var body = o && o.body ? JSON.parse(o.body) : null;
    if (url === RELAY && body) w.relayOps.push(body.op);
    var h = hook && hook(url, body);
    if (h) {
      if (h.throw) throw new Error('network');
      return { status: h.http || 200, json: async function () { return h.body; } };
    }
    return inner(url, o);
  };
  return w;
}
function clears(w) { return w.relayOps.filter(function (o) { return o === 'clear'; }).length; }
function devicesReply(dev) {
  return function (url) {
    if (url.indexOf('/v1.1/devices') !== -1 && url.indexOf('/commands') === -1) {
      return { body: { statusCode: 100, body: { deviceList: dev } } };
    }
  };
}
function runClear(w, extra) { return K.main(env('clear-stale-state', Object.assign({ GITHUB_RUN_ATTEMPT: '1' }, extra || {})), w.deps); }

test('clear-stale-state: 入力検証（確認文字列・Re-run禁止）', function () {
  assert.strictEqual(K.CONFIRM['clear-stale-state'], 'CLEAR-STALE-TEST-STATE-IF-NO-TEST-KEY');
  assert.deepStrictEqual(K.validateInputs(env('clear-stale-state', { GITHUB_RUN_ATTEMPT: '1' })), []);
  assert.ok(K.validateInputs(env('clear-stale-state', { CONFIRM: 'yes', GITHUB_RUN_ATTEMPT: '1' })).indexOf('CONFIRM_MISMATCH') !== -1);
  assert.ok(K.validateInputs(env('clear-stale-state', { GITHUB_RUN_ATTEMPT: '2' })).indexOf('RERUN_FORBIDDEN') !== -1);
});

test('clear-stale-state: Keypad完全一致+keyList正常+検証キー0件+IN_USE → clear1回 → CLEAN確認で成功。通常キーは触らない', async function () {
  var w = spy(world({ keys: [{ id: 5, name: 'regular user' }] })); seedStale(w);
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);
  var rc = await runClear(w, { GITHUB_RUN_ATTEMPT: '1' }); if (rc !== 0) dump(w);
  assert.strictEqual(rc, 0);
  assert.strictEqual(clears(w), 1);
  assert.strictEqual(w.store.get('TEST_STATE'), null);
  assert.deepStrictEqual(w.relayOps, ['getState', 'clear', 'getState']);
  assert.strictEqual(w.keys.length, 1);
  var out = logs(w);
  ['KEYPAD: PASS', 'TEST_KEYS: NONE', 'RELAY_BEFORE: IN_USE', 'CLEAR: SENT', 'RELAY_AFTER: CLEAN', 'STALE_STATE_CLEARED_CONFIRMED', '末尾4桁=9999']
    .forEach(function (s) { assert.ok(out.indexOf(s) !== -1, s); });
  assertNoMutation(w);
  assertNoLeak(w);
  // clear後に preflight が RELAY_STATE: CLEAN になる
  var p = world(); assert.strictEqual(await K.main(env('preflight'), p.deps), 0);
});

test('clear-stale-state: 検証キーが1件以上なら clear しない', async function () {
  var w = spy(world({ keys: [{ id: 5, name: 'SNB-API-TEST-123' }, { id: 6, name: 'regular user' }] })); seedStale(w);
  assert.strictEqual(await runClear(w), 1);
  assert.strictEqual(clears(w), 0);
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);
  assert.ok(logs(w).indexOf('TEST_KEYS: FOUND') !== -1);
  assertNoMutation(w); assertNoLeak(w);
});

test('clear-stale-state: keyList 欠落/null/非配列は0件と解釈せず clear しない', async function () {
  var variants = [
    { deviceId: DEV, deviceType: 'Keypad Touch' },
    { deviceId: DEV, deviceType: 'Keypad Touch', keyList: null },
    { deviceId: DEV, deviceType: 'Keypad Touch', keyList: 'none' },
    { deviceId: DEV, deviceType: 'Keypad Touch', keyList: {} }
  ];
  for (var i = 0; i < variants.length; i++) {
    var w = spy(world(), devicesReply([variants[i]])); seedStale(w);
    assert.strictEqual(await runClear(w), 1, 'case ' + i);
    assert.strictEqual(clears(w), 0, 'case ' + i);
    assert.notStrictEqual(w.store.get('TEST_STATE'), null);
    assert.ok(logs(w).indexOf('TEST_KEYS: NONE') === -1);
    assertNoMutation(w); assertNoLeak(w);
  }
});

test('clear-stale-state: devices API失敗（通信失敗/statusCode異常）は clear しない', async function () {
  var a = spy(world({ netErrorDevices: true })); seedStale(a);
  assert.strictEqual(await runClear(a), 1);
  var b = spy(world(), function (url) { if (url.indexOf('/v1.1/devices') !== -1) return { http: 401, body: { statusCode: 401 } }; }); seedStale(b);
  assert.strictEqual(await runClear(b), 1);
  [a, b].forEach(function (w) {
    assert.strictEqual(clears(w), 0);
    assert.notStrictEqual(w.store.get('TEST_STATE'), null);
    assertNoMutation(w); assertNoLeak(w);
  });
});

test('clear-stale-state: Keypad不一致/複数/Keypad以外は clear しない', async function () {
  var cases = [
    [{ deviceId: 'OTHERDEVICE0000', deviceType: 'Keypad Touch', keyList: [] }],
    [{ deviceId: DEV, deviceType: 'Keypad Touch', keyList: [] }, { deviceId: DEV, deviceType: 'Keypad Touch', keyList: [] }],
    [{ deviceId: DEV, deviceType: 'Hub 2', keyList: [] }],
    []
  ];
  for (var i = 0; i < cases.length; i++) {
    var w = spy(world(), devicesReply(cases[i])); seedStale(w);
    assert.strictEqual(await runClear(w), 1, 'case ' + i);
    assert.strictEqual(clears(w), 0, 'case ' + i);
    assert.notStrictEqual(w.store.get('TEST_STATE'), null);
    assertNoMutation(w); assertNoLeak(w);
  }
});

test('clear-stale-state: リレー状態取得失敗は clear しない', async function () {
  var hooks = [
    function (u, b) { if (u === RELAY && b && b.op === 'getState') return { throw: true }; },
    function (u, b) { if (u === RELAY && b && b.op === 'getState') return { body: { ok: false, error: 'FORBIDDEN' } }; },
    function (u, b) { if (u === RELAY && b && b.op === 'getState') return { body: { ok: true } }; } // state欠落は不正応答
  ];
  for (var i = 0; i < hooks.length; i++) {
    var w = spy(world(), hooks[i]); seedStale(w);
    assert.strictEqual(await runClear(w), 1, 'case ' + i);
    assert.strictEqual(clears(w), 0, 'case ' + i);
    assert.notStrictEqual(w.store.get('TEST_STATE'), null);
    assertNoMutation(w); assertNoLeak(w);
  }
});

test('clear-stale-state: 既にCLEANなら clear せず ALREADY_CLEAN', async function () {
  var w = spy(world());
  assert.strictEqual(await runClear(w), 0);
  assert.strictEqual(clears(w), 0);
  assert.ok(logs(w).indexOf('ALREADY_CLEAN') !== -1);
  assert.ok(logs(w).indexOf('STALE_STATE_CLEARED_CONFIRMED') === -1);
  assertNoMutation(w); assertNoLeak(w);
});

test('clear-stale-state: clear後もIN_USE/確認不能/clear応答不正は成功扱いしない', async function () {
  var hooks = [
    function (u, b) { if (u === RELAY && b && b.op === 'clear') return { body: { ok: true } }; }, // 応答のみ成功で実際は消えない
    function (u, b) { if (u === RELAY && b && b.op === 'clear') return { body: { ok: false, error: 'LOCK' } }; },
    function (u, b) { if (u === RELAY && b && b.op === 'clear') return { throw: true }; }
  ];
  for (var i = 0; i < hooks.length; i++) {
    var w = spy(world(), hooks[i]); seedStale(w);
    assert.strictEqual(await runClear(w), 1, 'case ' + i);
    assert.ok(logs(w).indexOf('STALE_STATE_CLEARED_CONFIRMED') === -1, 'case ' + i);
    assert.ok(logs(w).indexOf('UNKNOWN') !== -1);
    assertNoMutation(w); assertNoLeak(w);
  }
  // clear後のgetStateが失敗
  var n = 0;
  var f = spy(world(), function (u, b) { if (u === RELAY && b && b.op === 'getState' && ++n === 2) return { throw: true }; }); seedStale(f);
  assert.strictEqual(await runClear(f), 1);
  assert.ok(logs(f).indexOf('RELAY_AFTER: UNKNOWN') !== -1);
  assert.ok(logs(f).indexOf('STALE_STATE_CLEARED_CONFIRMED') === -1);
  assertNoMutation(f); assertNoLeak(f);
  // clear応答は ok だが実際は残存 → RELAY_AFTER: IN_USE
  var h = spy(world(), hooks[0]); seedStale(h);
  assert.strictEqual(await runClear(h), 1);
  assert.ok(logs(h).indexOf('RELAY_AFTER: IN_USE') !== -1);
});

test('clear-stale-state: ログに TEST_STATE 内容・passcode ID・パスコード・完全ID・秘密を出さない', async function () {
  var w = spy(world()); seedStale(w);
  await runClear(w);
  var out = logs(w);
  ['SNB-API-TEST-1', '77777777', '701', 'passcodeId', 'createCommandId', DEV, RELAY, 'sb-token-111', 'admin-token-abc', '"state"'].forEach(function (s) {
    assert.ok(out.indexOf(s) === -1, 'ログに出ている: ' + s);
  });
});

test('clear-stale-state: 保存済み state の deviceId が確認済みKeypadと異なれば clear しない', async function () {
  var w = spy(world()); seedStale(w);
  var st = JSON.parse(w.store.get('TEST_STATE'));
  st.deviceId = 'OLDERDEVICE0000';
  w.store.set('TEST_STATE', JSON.stringify(st));
  assert.strictEqual(await runClear(w), 1);
  assert.strictEqual(clears(w), 0);
  assert.notStrictEqual(w.store.get('TEST_STATE'), null);
  assert.ok(logs(w).indexOf('STALE_STATE_CLEARED_CONFIRMED') === -1);
  assert.ok(logs(w).indexOf('OLDERDEVICE0000') === -1);
  assertNoMutation(w); assertNoLeak(w);
});
