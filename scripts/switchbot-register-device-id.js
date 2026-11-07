/*
 * SwitchBot Keypad の完全 deviceId を表示せず Environment Secret へ登録する（Issue #720）。
 * 運用者のローカル端末（gh ログイン済み・Environment secrets 書き込み権限あり）で実行する。
 *
 * 流れ: GET /v1.1/devices → Keypad / Keypad Touch を末尾4桁で照合 → ちょうど1件のときだけ
 *       `gh secret set SWITCHBOT_DEVICE_ID --env <env>` の標準入力へ完全 ID を渡す。
 * - 完全 ID は標準出力・標準エラー・コマンド引数・ファイルに出さない（末尾4桁のみ表示）。
 * - 0件・複数件・API失敗・応答不正・登録失敗では中断。登録失敗時に gh の出力は表示しない。
 * - createKey / deleteKey / Webhook 登録は行わない。
 */
'use strict';

var crypto = require('node:crypto');
var childProcess = require('node:child_process');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

var SECRET_NAME = 'SWITCHBOT_DEVICE_ID';
var DEFAULT_REPO = 'nagoya-base/Studio-nagoya-base';
var DEFAULT_ENV = 'switchbot-verify';

function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

/** gh の標準入力へ値を渡して Environment Secret を登録する。成功なら true。出力は破棄する。 */
function ghSetSecret(value, opts) {
  var childEnv = {};
  Object.keys(process.env).forEach(function (k) { childEnv[k] = process.env[k]; });
  delete childEnv.GH_DEBUG;
  delete childEnv.DEBUG;
  delete childEnv.GH_TRACE;
  try {
    var r = childProcess.spawnSync(
      'gh', ['secret', 'set', SECRET_NAME, '--env', opts.environment, '--repo', opts.repo],
      { input: value, env: childEnv, stdio: ['pipe', 'ignore', 'ignore'] });
    return r.status === 0 && !r.error;
  } catch (e) {
    return false;
  }
}

async function main(env, fetchImpl, setSecret, log) {
  var token = env.SWITCHBOT_TOKEN;
  var secret = env.SWITCHBOT_SECRET;
  var last4 = env.KEYPAD_LAST4;
  var repo = env.TARGET_REPO || DEFAULT_REPO;
  var environment = env.TARGET_ENVIRONMENT || DEFAULT_ENV;
  if (!token || !secret) {
    log('ERROR: SWITCHBOT_TOKEN / SWITCHBOT_SECRET が未設定');
    return 1;
  }
  if (!last4 || String(last4).trim().length !== 4) {
    log('ERROR: KEYPAD_LAST4 は末尾4桁を指定する');
    return 1;
  }
  var headers = Core.buildAuthHeaders(token, secret, crypto.randomUUID(), Date.now(), hmac);
  var res;
  var parsed = null;
  try {
    res = await fetchImpl(Core.API_BASE + '/v1.1/devices', { method: 'GET', headers: headers });
    parsed = await res.json().catch(function () { return null; });
  } catch (e) {
    log('ERROR: SwitchBot API に接続できない（Secret は未変更）');
    return 1;
  }
  var cls = Core.classifyApiResponse(res.status, parsed);
  if (cls.state === Core.STATE.FAILED) {
    log('ERROR: 認証/取得に失敗 http=' + res.status + ' statusCode=' + cls.statusCode + '（Secret は未変更）');
    return 1;
  }
  var deviceList = parsed && parsed.body && parsed.body.deviceList;
  if (!Array.isArray(deviceList)) {
    log('ERROR: 応答構造が不正（deviceList なし）。Secret は未変更');
    return 1;
  }
  var found = Core.findKeypadByLast4(deviceList, last4);
  if (!found.device) {
    log('ERROR: 照合失敗 reason=' + found.error + '（0件/複数件/形式不正のため Secret は未変更）');
    return 1;
  }
  var fullId = found.device.deviceId;
  if (!setSecret(fullId, { repo: repo, environment: environment })) {
    log('ERROR: Secret 登録に失敗または結果不明。未完了として扱う（完全 ID の表示による調査はしない）');
    return 1;
  }
  log('登録成功: ' + SECRET_NAME + ' → Environment ' + environment + ' (' + repo + ')');
  log('照合件数=1 末尾4桁=' + Core.maskId(fullId).slice(-4) + ' type=' + found.device.deviceType);
  log('次: Actions "SwitchBot read-only diagnostics (manual)" の operation=device-id で登録値の完全ID一致を確認する');
  return 0;
}

if (require.main === module) {
  main(process.env, fetch, ghSetSecret, function (m) { console.log(m); }).then(
    function (code) { process.exit(code); },
    function () { console.log('ERROR: 想定外の失敗（詳細は秘匿のため非表示）'); process.exit(1); });
}

module.exports = { main: main, ghSetSecret: ghSetSecret };
