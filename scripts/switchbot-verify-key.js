/*
 * SwitchBot 期間限定キー 1 件の発行→削除 検証ランナー（Issue #718）。GitHub Actions 手動実行専用。
 * 独立 GAS リレー（gas/switchbot-verify）に Webhook 結果とテスト状態（コード・passcode ID）を保持する。
 * Token / Secret / 署名 / テストコード / 完全 deviceId / passcode ID / リレー URL・トークンはログに出さない。
 * API 受理だけでは成功にせず、今回の commandId + eventName の Webhook success で初めて APPLIED とする。
 */
'use strict';

var crypto = require('node:crypto');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

var CONFIRM = {
  'webhook-setup': 'SETUP-WEBHOOK',
  'create-key': 'CREATE-ONE-TEST-KEY',
  'delete-key': 'DELETE-TEST-KEY',
  'webhook-remove': 'REMOVE-WEBHOOK'
};
var REQUIRED = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'SWITCHBOT_DEVICE_ID',
  'VERIFY_RELAY_URL', 'VERIFY_RELAY_ADMIN_TOKEN', 'VERIFY_WEBHOOK_TOKEN'];

function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function jst(sec) {
  return new Date(sec * 1000).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}

function webhookUrl(env) {
  return env.VERIFY_RELAY_URL + (env.VERIFY_RELAY_URL.indexOf('?') === -1 ? '?' : '&') +
    't=' + encodeURIComponent(env.VERIFY_WEBHOOK_TOKEN);
}

/** 入力検証（秘密なしで単体テスト可能）。エラーコード配列を返す。 */
function validateInputs(env) {
  var errs = [];
  var action = env.ACTION;
  if (!CONFIRM[action]) return ['ACTION_INVALID'];
  if (env.CONFIRM !== CONFIRM[action]) errs.push('CONFIRM_MISMATCH');
  REQUIRED.forEach(function (k) { if (!env[k]) errs.push('SECRET_MISSING_' + k); });
  if (action === 'create-key') {
    var so = Number(env.START_OFFSET_MIN);
    var du = Number(env.DURATION_MIN);
    if (!Number.isInteger(so) || so < 3 || so > 30) errs.push('START_OFFSET_RANGE');
    if (!Number.isInteger(du) || du < 10 || du > 15) errs.push('DURATION_RANGE');
  }
  return errs;
}

function makeClient(env, deps) {
  async function sb(method, path, body) {
    var headers = Core.buildAuthHeaders(env.SWITCHBOT_TOKEN, env.SWITCHBOT_SECRET,
      crypto.randomUUID(), deps.nowMs(), hmac);
    var opt = { method: method, headers: headers };
    if (body) opt.body = JSON.stringify(body);
    var res = await deps.fetch(Core.API_BASE + path, opt);
    var parsed = await res.json().catch(function () { return null; });
    return { http: res.status, parsed: parsed };
  }
  async function relay(payload) {
    var res = await deps.fetch(env.VERIFY_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ t: env.VERIFY_RELAY_ADMIN_TOKEN }, payload)),
      redirect: 'follow'
    });
    var parsed = await res.json().catch(function () { return null; });
    return parsed || { ok: false, error: 'RELAY_BAD_RESPONSE' };
  }
  return { sb: sb, relay: relay };
}

/** 対象 Keypad が一覧に 1 件だけ存在することを確認し deviceList を返す。 */
async function loadDevices(c, env) {
  var r = await c.sb('get', '/v1.1/devices');
  if (Core.classifyApiResponse(r.http, r.parsed).state === Core.STATE.FAILED) {
    return { error: 'DEVICES_FAILED' };
  }
  var list = (r.parsed.body && r.parsed.body.deviceList) || [];
  var hits = Core.pickKeypads(list).filter(function (d) { return d.deviceId === env.SWITCHBOT_DEVICE_ID; });
  if (hits.length !== 1) return { error: hits.length === 0 ? 'TARGET_NOT_FOUND' : 'TARGET_AMBIGUOUS' };
  return { list: list, last4: Core.maskId(hits[0].deviceId).slice(-4) };
}

/** 今回の commandId + eventName に対応する Webhook だけを待つ（上限付き）。 */
async function awaitEvent(c, deps, commandId, eventName) {
  var started = deps.nowSec();
  while (true) {
    var r = await c.relay({ op: 'getEvent', commandId: commandId });
    var ev = r && r.event;
    if (ev && ev.eventName === eventName) return ev.state;
    if (deps.nowSec() - started > Core.WEBHOOK_WAIT_SEC) return Core.STATE.UNKNOWN;
    await deps.sleep(3000);
  }
}

async function createKey(env, deps, c, log) {
  var dev = await loadDevices(c, env);
  if (dev.error) { log('ABORT: ' + dev.error); return 1; }
  log('対象Keypad 末尾4桁=' + dev.last4);

  var nowSec = deps.nowSec();
  var start = nowSec + Number(env.START_OFFSET_MIN) * 60;
  var end = start + Number(env.DURATION_MIN) * 60;
  var params = {
    name: Core.buildTestName(nowSec),
    password: Core.generateTestPassword(deps.randomInt, 8),
    startTime: start,
    endTime: end
  };
  var errs = Core.validateCreateKeyParams(params, nowSec);
  if (errs.length) { log('ABORT: INVALID_PARAMS ' + errs.join(',')); return 1; }

  var claim = await c.relay(Object.assign({ op: 'claim' }, params));
  if (!claim.ok) { log('ABORT: claim 失敗 ' + claim.error + '（未削除の検証キーがある場合は delete-key を先に実行）'); return 1; }

  var r;
  try {
    r = await c.sb('post', '/v1.1/devices/' + env.SWITCHBOT_DEVICE_ID + '/commands', Core.buildCreateKeyBody(params));
  } catch (e) {
    log('UNKNOWN: createKey の送信結果が不明。再送せず停止。keyList/アプリで今回の検証名を確認し delete-key で後片付け');
    return 1;
  }
  var cls = Core.classifyApiResponse(r.http, r.parsed);
  if (cls.state === Core.STATE.FAILED) {
    await c.relay({ op: 'clear' });
    log('FAILED: createKey がAPIで拒否 http=' + r.http + ' statusCode=' + cls.statusCode);
    return 1;
  }
  var ids = Core.extractIdsFromResponse(r.parsed);
  if (!ids.commandId) { log('UNKNOWN: commandId なし。再送せず停止（delete-key で後片付け）'); return 1; }
  await c.relay({ op: 'setCommand', commandId: ids.commandId });
  log('createKey: ' + Core.STATE.ACCEPTED_PENDING + '（Webhook待機）');

  var state = await awaitEvent(c, deps, ids.commandId, 'createKey');
  log('createKey Webhook結果: ' + state);
  if (state === Core.STATE.FAILED) { await c.relay({ op: 'clear' }); return 1; }
  if (state !== Core.STATE.APPLIED) { log('UNKNOWN: 反映有無を断定しない。再送せず停止（delete-key で後片付け）'); return 1; }

  var dl = await c.sb('get', '/v1.1/devices');
  var res = Core.resolvePasscodeIdByName(dl.parsed && dl.parsed.body && dl.parsed.body.deviceList,
    env.SWITCHBOT_DEVICE_ID, params.name);
  if (res.id === null) { log('UNKNOWN: passcode ID を解決できない ' + res.error + '（アプリで今回の検証名のキーを確認）'); return 1; }
  await c.relay({ op: 'setPasscodeId', passcodeId: res.id });

  log('createKey: ' + Core.STATE.APPLIED + ' / passcode ID 保持済み');
  log('有効期間(JST) ' + jst(start) + ' - ' + jst(end) + '（開始 ' + env.START_OFFSET_MIN + ' 分後・' + env.DURATION_MIN + ' 分間）');
  log('テストコードはリレー(GAS)の Script Properties TEST_STATE で確認（ここには出さない）');
  return 0;
}

async function deleteKey(env, deps, c, log) {
  var dev = await loadDevices(c, env);
  if (dev.error) { log('ABORT: ' + dev.error); return 1; }
  var g = await c.relay({ op: 'getState' });
  var st = g.ok ? g.state : null;
  if (!st) { log('ABORT: 削除対象の検証状態なし'); return 1; }

  var id = st.passcodeId;
  if (!id) {
    var rr = Core.resolvePasscodeIdByName(dev.list, env.SWITCHBOT_DEVICE_ID, st.name);
    if (rr.id === null) { log('UNKNOWN: passcode ID 解決不可 ' + rr.error + '（アプリで今回のキーだけを特定して削除）'); return 1; }
    id = rr.id;
  }
  var r;
  try {
    r = await c.sb('post', '/v1.1/devices/' + env.SWITCHBOT_DEVICE_ID + '/commands', Core.buildDeleteKeyBody(id));
  } catch (e) {
    log('UNKNOWN: deleteKey の送信結果が不明。keyList/アプリで確認');
    return 1;
  }
  var cls = Core.classifyApiResponse(r.http, r.parsed);
  if (cls.state === Core.STATE.FAILED) { log('FAILED: deleteKey がAPIで拒否 http=' + r.http); return 1; }
  var ids = Core.extractIdsFromResponse(r.parsed);
  if (!ids.commandId) { log('UNKNOWN: commandId なし'); return 1; }
  log('deleteKey: ' + Core.STATE.ACCEPTED_PENDING + '（Webhook待機）');

  var state = await awaitEvent(c, deps, ids.commandId, 'deleteKey');
  log('deleteKey Webhook結果: ' + state);
  if (state !== Core.STATE.APPLIED) { log('未確認のため保持データは残す。keyList/アプリで確認'); return 1; }

  var after = await c.sb('get', '/v1.1/devices');
  var gone = Core.resolvePasscodeIdByName(after.parsed && after.parsed.body && after.parsed.body.deviceList,
    env.SWITCHBOT_DEVICE_ID, st.name);
  if (gone.error !== 'KEY_NOT_FOUND') { log('UNKNOWN: keyList で対象キー消失を確認できない（' + gone.error + '）。保持データは残す'); return 1; }
  await c.relay({ op: 'clear' });
  log('deleteKey: ' + Core.STATE.APPLIED + ' / keyList から消失を確認 / 保持データを破棄');
  log('実機で削除後に同じコードで解錠不可も確認すること');
  return 0;
}

async function webhookSetup(env, c, log) {
  var q = await c.sb('post', '/v1.1/webhook/queryWebhook', { action: 'queryUrl' });
  if (Core.classifyApiResponse(q.http, q.parsed).state === Core.STATE.FAILED) { log('FAILED: queryWebhook'); return 1; }
  var urls = (q.parsed.body && q.parsed.body.urls) || [];
  if (urls.indexOf(webhookUrl(env)) !== -1) { log('既に今回のWebhookが登録済み（変更なし）'); return 0; }
  if (urls.length > 0) { log('ABORT: 既存Webhook設定あり（' + urls.length + ' 件）。無断で上書きしない'); return 1; }
  var r = await c.sb('post', '/v1.1/webhook/setupWebhook', { action: 'setupWebhook', url: webhookUrl(env), deviceList: 'ALL' });
  var cls = Core.classifyApiResponse(r.http, r.parsed);
  log('setupWebhook: ' + cls.state + ' http=' + r.http);
  return cls.state === Core.STATE.FAILED ? 1 : 0;
}

async function webhookRemove(env, c, log) {
  var q = await c.sb('post', '/v1.1/webhook/queryWebhook', { action: 'queryUrl' });
  if (Core.classifyApiResponse(q.http, q.parsed).state === Core.STATE.FAILED) { log('FAILED: queryWebhook'); return 1; }
  var urls = (q.parsed.body && q.parsed.body.urls) || [];
  if (urls.indexOf(webhookUrl(env)) === -1) { log('今回のWebhookは未登録（変更なし。既存設定は触らない）'); return 0; }
  var r = await c.sb('post', '/v1.1/webhook/deleteWebhook', { action: 'deleteWebhook', url: webhookUrl(env) });
  var cls = Core.classifyApiResponse(r.http, r.parsed);
  log('deleteWebhook: ' + cls.state + ' http=' + r.http);
  return cls.state === Core.STATE.FAILED ? 1 : 0;
}

async function main(env, deps) {
  var log = deps.log;
  var errs = validateInputs(env);
  if (errs.length) { log('ABORT: ' + errs.join(',')); return 1; }
  var c = makeClient(env, deps);
  try {
    switch (env.ACTION) {
      case 'webhook-setup': return await webhookSetup(env, c, log);
      case 'webhook-remove': return await webhookRemove(env, c, log);
      case 'create-key': return await createKey(env, deps, c, log);
      case 'delete-key': return await deleteKey(env, deps, c, log);
    }
  } catch (e) {
    log('ERROR: 想定外の失敗（詳細は秘匿のため出さない）');
    return 1;
  }
  return 1;
}

if (require.main === module) {
  main(process.env, {
    fetch: fetch,
    log: function (m) { console.log(m); },
    nowMs: function () { return Date.now(); },
    nowSec: function () { return Math.floor(Date.now() / 1000); },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    randomInt: function (n) { return crypto.randomInt(n); }
  }).then(function (code) { process.exit(code); });
}

module.exports = { main: main, validateInputs: validateInputs, CONFIRM: CONFIRM };
