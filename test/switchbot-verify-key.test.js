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
      var respond = function () { return opts.respond502 && body.command === 'createKey' ? reply(502, null) : reply(200, { statusCode: 100, body: { commandId: cid } }); };
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
  var none = world();
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
