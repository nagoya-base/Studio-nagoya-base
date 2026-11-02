/**
 * SwitchBot Open API 期間限定パスコード検証（Issue #713）— 純粋ロジック。
 *
 * 技術検証専用。予約・決済・既存 GAS（gas/booking）からは一切参照しない。
 * GAS 依存（UrlFetchApp / PropertiesService / Utilities）を持たないため Node でテストできる。
 * 署名の HMAC は呼び出し側から注入する（GAS: Utilities、Node: crypto）。
 *
 * 結果状態:
 *   ACCEPTED_PENDING … API が受理しただけ。鍵への反映は未確認（成功扱いにしない）
 *   APPLIED          … Webhook で result=success を確認
 *   FAILED           … API 拒否 / Webhook result=failed
 *   UNKNOWN          … Webhook 未着 / timeout（反映有無を断定しない）
 */
var SwitchBotVerifyCore = (function () {
  'use strict';

  var STATE = {
    ACCEPTED_PENDING: 'ACCEPTED_PENDING',
    APPLIED: 'APPLIED',
    FAILED: 'FAILED',
    UNKNOWN: 'UNKNOWN'
  };

  var API_BASE = 'https://api.switch-bot.com';
  var KEYPAD_DEVICE_TYPES = ['Keypad', 'Keypad Touch'];
  var WEBHOOK_WAIT_SEC = 90; // 公式 timeout は 1 分。余裕を見て 90 秒で UNKNOWN 扱い

  /** v1.1 署名ヘッダ。sign = base64(HMAC-SHA256(secret, token + t + nonce)) を大文字化。 */
  function buildAuthHeaders(token, secret, nonce, tMs, hmacBase64) {
    if (!token || !secret) throw new Error('AUTH_CREDENTIALS_MISSING');
    var t = String(tMs);
    var sign = String(hmacBase64(secret, String(token) + t + String(nonce))).toUpperCase();
    return {
      Authorization: token,
      sign: sign,
      nonce: String(nonce),
      t: t,
      'Content-Type': 'application/json; charset=utf8'
    };
  }

  /**
   * createKey パラメータ検証。問題があればエラーコード配列を返す（空配列 = 有効）。
   * パスコード値そのものはエラーに含めない。
   */
  function validateCreateKeyParams(p, nowSec) {
    var errors = [];
    p = p || {};
    if (typeof p.name !== 'string' || !p.name.trim()) errors.push('NAME_REQUIRED');
    if (typeof p.password !== 'string' || !/^[0-9]{6,12}$/.test(p.password)) errors.push('PASSWORD_FORMAT');
    var s = p.startTime;
    var e = p.endTime;
    var tsRe = /^[0-9]{10}$/;
    if (!tsRe.test(String(s))) errors.push('START_TIME_FORMAT');
    if (!tsRe.test(String(e))) errors.push('END_TIME_FORMAT');
    if (tsRe.test(String(s)) && tsRe.test(String(e))) {
      if (Number(s) >= Number(e)) errors.push('START_NOT_BEFORE_END');
      if (typeof nowSec === 'number' && Number(e) <= nowSec) errors.push('END_IN_PAST');
    }
    return errors;
  }

  function buildCreateKeyBody(p) {
    return {
      commandType: 'command',
      command: 'createKey',
      parameter: {
        name: p.name,
        type: 'timeLimit',
        password: p.password,
        startTime: String(p.startTime),
        endTime: String(p.endTime)
      }
    };
  }

  function buildDeleteKeyBody(passcodeId) {
    if (passcodeId === undefined || passcodeId === null || String(passcodeId) === '') {
      throw new Error('PASSCODE_ID_REQUIRED');
    }
    return { commandType: 'command', command: 'deleteKey', parameter: { id: passcodeId } };
  }

  /** テスト用名称。SNB-API-TEST-<unix秒> */
  function buildTestName(nowSec) {
    return 'SNB-API-TEST-' + String(nowSec);
  }

  /** 検証用の6〜12桁コード生成。randomInt(n) は 0..n-1 を返す関数。 */
  function generateTestPassword(randomInt, length) {
    var len = length || 8;
    if (len < 6 || len > 12) throw new Error('PASSWORD_LENGTH_RANGE');
    var out = '';
    for (var i = 0; i < len; i++) out += String(randomInt(10));
    return out;
  }

  /** 対象デバイスの絞り込み。deviceId / MAC は返すが、ログ用には maskId を使うこと。 */
  function pickKeypads(deviceList) {
    var list = Array.isArray(deviceList) ? deviceList : [];
    return list.filter(function (d) {
      return d && KEYPAD_DEVICE_TYPES.indexOf(d.deviceType) !== -1;
    });
  }

  function maskId(id) {
    var s = String(id || '');
    if (s.length <= 4) return '****';
    return '****' + s.slice(-4);
  }

  /**
   * API 応答の分類。HTTP 200 + statusCode 100 でも「受理」止まり。
   * 鍵への反映成功とは判定しない。
   */
  function classifyApiResponse(httpCode, parsed) {
    var sc = parsed && typeof parsed.statusCode === 'number' ? parsed.statusCode : null;
    if (httpCode === 200 && sc === 100) return { state: STATE.ACCEPTED_PENDING, statusCode: sc };
    return { state: STATE.FAILED, statusCode: sc, httpCode: httpCode };
  }

  /** 応答 body から commandId / passcode ID の候補を取り出す（存在しない場合は null）。 */
  function extractIdsFromResponse(parsed) {
    var body = (parsed && parsed.body) || {};
    var id = null;
    if (body.id !== undefined && body.id !== null) id = body.id;
    else if (body.passwordId !== undefined && body.passwordId !== null) id = body.passwordId;
    else if (body.keyId !== undefined && body.keyId !== null) id = body.keyId;
    return { commandId: body.commandId || null, passcodeId: id };
  }

  /**
   * Webhook 1 件の解釈。Keypad の changeReport のみ対象。
   * 公式 payload には passcode ID が含まれない点に注意（context.eventName / commandId / result のみ）。
   */
  function parseKeypadWebhook(payload) {
    if (!payload || payload.eventType !== 'changeReport' || !payload.context) return null;
    var c = payload.context;
    if (c.deviceType !== 'WoKeypad' && c.deviceType !== 'WoKeypadTouch') return null;
    var name = String(c.eventName || '').trim(); // 公式例に末尾空白あり
    if (name !== 'createKey' && name !== 'deleteKey') return null;
    var state = STATE.UNKNOWN;
    if (c.result === 'success') state = STATE.APPLIED;
    else if (c.result === 'failed') state = STATE.FAILED;
    // timeout 等は UNKNOWN（鍵側で反映済みの可能性があるため断定しない）
    return {
      eventName: name,
      commandId: c.commandId || null,
      result: c.result || null,
      state: state,
      timeOfSample: c.timeOfSample || null
    };
  }

  /** 保留中コマンドの最終状態。Webhook 未着のまま待機時間を過ぎたら UNKNOWN。 */
  function resolveCommandState(pending, webhook, nowSec) {
    if (webhook) return webhook.state;
    if (pending && typeof pending.acceptedAtSec === 'number' &&
        nowSec - pending.acceptedAtSec > WEBHOOK_WAIT_SEC) {
      return STATE.UNKNOWN;
    }
    return STATE.ACCEPTED_PENDING;
  }

  /** ログ出力用の秘匿。token/secret/password/sign と deviceId 系をマスクする。 */
  function redact(value) {
    var secretKeys = /^(authorization|token|secret|sign|password|webhooksecret)$/i;
    var idKeys = /^(deviceid|devicemac|id|passcodeid)$/i;
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (k) {
        if (secretKeys.test(k)) out[k] = '[REDACTED]';
        else if (idKeys.test(k) && value[k] !== null && typeof value[k] !== 'object') out[k] = maskId(value[k]);
        else out[k] = redact(value[k]);
      });
      return out;
    }
    return value;
  }

  /** Webhook 受信 URL の簡易認証（GAS は HTTP ヘッダを読めないためクエリの共有トークンで照合）。 */
  function isWebhookAuthorized(provided, expected) {
    if (!provided || !expected) return false;
    var a = String(provided);
    var b = String(expected);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  return {
    STATE: STATE,
    API_BASE: API_BASE,
    WEBHOOK_WAIT_SEC: WEBHOOK_WAIT_SEC,
    buildAuthHeaders: buildAuthHeaders,
    validateCreateKeyParams: validateCreateKeyParams,
    buildCreateKeyBody: buildCreateKeyBody,
    buildDeleteKeyBody: buildDeleteKeyBody,
    buildTestName: buildTestName,
    generateTestPassword: generateTestPassword,
    pickKeypads: pickKeypads,
    maskId: maskId,
    classifyApiResponse: classifyApiResponse,
    extractIdsFromResponse: extractIdsFromResponse,
    parseKeypadWebhook: parseKeypadWebhook,
    resolveCommandState: resolveCommandState,
    redact: redact,
    isWebhookAuthorized: isWebhookAuthorized
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SwitchBotVerifyCore;
}
