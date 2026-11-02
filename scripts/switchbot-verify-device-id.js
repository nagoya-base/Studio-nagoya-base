/*
 * 登録済み SWITCHBOT_DEVICE_ID の読み取り専用確認（Issue #720）。GitHub Actions 手動実行用。
 * GET /v1.1/devices のみ。deviceList 上で完全 ID 一致がちょうど 1 件・Keypad 種別・末尾4桁一致を確認する。
 * 完全 ID / Token / Secret はログに出さない（deviceId は末尾4桁のみ）。
 */
'use strict';

var crypto = require('node:crypto');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

async function main(env, fetchImpl, log) {
  var token = env.SWITCHBOT_TOKEN;
  var secret = env.SWITCHBOT_SECRET;
  var deviceId = env.SWITCHBOT_DEVICE_ID;
  if (!token || !secret) {
    log('ERROR: SWITCHBOT_TOKEN / SWITCHBOT_SECRET が未設定');
    return 1;
  }
  if (!deviceId) {
    log('ERROR: SWITCHBOT_DEVICE_ID が未設定（Environment switchbot-verify の Secret を確認）');
    return 1;
  }
  var headers = Core.buildAuthHeaders(token, secret, crypto.randomUUID(), Date.now(), hmac);
  var res;
  var parsed = null;
  try {
    res = await fetchImpl(Core.API_BASE + '/v1.1/devices', { method: 'GET', headers: headers });
    parsed = await res.json().catch(function () { return null; });
  } catch (e) {
    log('ERROR: SwitchBot API に接続できない');
    return 1;
  }
  var cls = Core.classifyApiResponse(res.status, parsed);
  if (cls.state === Core.STATE.FAILED) {
    log('ERROR: 認証/取得に失敗 http=' + res.status + ' statusCode=' + cls.statusCode);
    return 1;
  }
  var r = Core.verifyKeypadByFullId(parsed && parsed.body && parsed.body.deviceList, deviceId, env.KEYPAD_LAST4);
  if (!r.ok) {
    log('ERROR: 登録値の確認に失敗 reason=' + r.error + ' 完全ID一致件数=' + r.count);
    return 1;
  }
  log('OK: 登録値(SWITCHBOT_DEVICE_ID)と完全ID一致=' + r.count + '件 type=' + r.deviceType +
    ' 末尾4桁=' + Core.maskId(deviceId).slice(-4));
  return 0;
}

if (require.main === module) {
  main(process.env, fetch, function (m) { console.log(m); }).then(
    function (code) { process.exit(code); },
    function () { console.log('ERROR: 想定外の失敗（詳細は秘匿のため非表示）'); process.exit(1); });
}

module.exports = { main: main };
