/*
 * SwitchBot Open API v1.1 接続確認（Issue #715）。GitHub Actions 手動実行用。
 * GET /v1.1/devices のみ実行。createKey / deleteKey / Webhook 登録は行わない。
 * Token / Secret / 完全 deviceId はログに出さない（deviceId は末尾4桁のみ）。
 */
'use strict';

var crypto = require('node:crypto');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

/** deviceList からキーパッド要約（末尾4桁のみ）を作る。 */
function summarizeKeypads(deviceList) {
  return Core.pickKeypads(deviceList).map(function (d) {
    return { deviceIdLast4: Core.maskId(d.deviceId), deviceType: d.deviceType, deviceName: d.deviceName };
  });
}

async function main(env, fetchImpl, log) {
  var token = env.SWITCHBOT_TOKEN;
  var secret = env.SWITCHBOT_SECRET;
  if (!token || !secret) {
    log('ERROR: SWITCHBOT_TOKEN / SWITCHBOT_SECRET が未設定（Repository Secrets を確認）');
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
  var keypads = summarizeKeypads(parsed.body && parsed.body.deviceList);
  log('認証成功。Keypad / Keypad Touch 件数 = ' + keypads.length);
  keypads.forEach(function (k) {
    log('- 末尾4桁=' + k.deviceIdLast4.slice(-4) + ' type=' + k.deviceType + ' name=' + k.deviceName);
  });
  if (keypads.length < 1) {
    log('ERROR: Keypad が 1 件も取得できない');
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.env, fetch, function (m) { console.log(m); }).then(function (code) {
    process.exit(code);
  });
}

module.exports = { main: main, summarizeKeypads: summarizeKeypads };
