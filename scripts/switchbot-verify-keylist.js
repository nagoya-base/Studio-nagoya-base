/*
 * 対象 Keypad の keyList 取得可否・総件数の読み取り専用確認（Issue #735）。GitHub Actions 手動実行用。
 * GET /v1.1/devices のみ。POST / PUT / DELETE・createKey / deleteKey・Webhook 操作は行わない。
 * 完全 deviceId / Token / Secret / keyList の内容 / API 応答全体はログに出さない（deviceId は末尾4桁のみ）。
 *
 * 終了コード: 0=keyList 取得成功 / 1=設定不備 / 2=接続・認証・API 失敗 /
 *            3=対象デバイス不一致（0件・複数件・Keypad以外・末尾4桁不一致）/ 4=keyList 不正（UNKNOWN）
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
    return 2;
  }
  var cls = Core.classifyApiResponse(res.status, parsed);
  if (cls.state === Core.STATE.FAILED) {
    log('ERROR: 認証/取得に失敗 http=' + res.status + ' statusCode=' + cls.statusCode);
    return 2;
  }
  var deviceList = parsed && parsed.body && parsed.body.deviceList;
  var r = Core.verifyKeypadByFullId(deviceList, deviceId, env.KEYPAD_LAST4);
  if (!r.ok) {
    log('ERROR: 対象Keypadの確認に失敗 reason=' + r.error + ' 完全ID一致件数=' + r.count);
    return 3;
  }
  var last4 = Core.maskId(deviceId).slice(-4);
  log('対象Keypad 末尾4桁=' + last4);
  var k = Core.countKeyList(deviceList, deviceId);
  if (!k.valid) {
    log('keyList: UNKNOWN reason=' + (k.error === 'KEY_LIST_INVALID' ? 'KEY_LIST_INVALID' : k.error));
    log('読み取り専用。設定変更なし');
    return 4;
  }
  log('keyList: 取得成功');
  log('登録キー件数=' + k.count);
  log('読み取り専用。設定変更なし');
  return 0;
}

if (require.main === module) {
  main(process.env, fetch, function (m) { console.log(m); }).then(
    function (code) { process.exit(code); },
    function () { console.log('ERROR: 想定外の失敗（詳細は秘匿のため非表示）'); process.exit(1); });
}

module.exports = { main: main };
