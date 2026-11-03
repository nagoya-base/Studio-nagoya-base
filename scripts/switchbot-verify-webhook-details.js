/*
 * SwitchBot queryWebhook(queryDetails) の読み取り専用診断（Issue #739）。GitHub Actions 手動実行用。
 * 送信する API は POST /v1.1/webhook/queryWebhook（body {"action":"queryDetails","urls":[<Webhook URL>]}）を 1 回のみ。自動リトライなし。
 * 公式 README（OpenWonderLabs/SwitchBotAPI）の仕様: queryDetails は照会対象の Webhook URL を urls 配列で指定する必須仕様。
 *   そのため SWITCHBOT_DEVICE_ID は不要だが、照会対象 URL の元になる Secret（リレーURL＋トークン、または旧URL）が必要。
 * Webhook の登録・更新・削除、Keypad のキー操作などの変更系 API は一切呼ばない。
 * 出力は構造情報のみ（HTTP / JSON解析可否 / statusCode / message の空・非空・欠落 / body の型 / 件数 / 既知キー名の有無）。
 * Token / Secret / 署名 / Webhook URL / deviceId / 応答全体は出力しない。既存の webhook-query・#737 診断とは独立。
 *
 * 終了コード: 0=statusCode=100 かつ body が配列 / 1=設定不備 / 2=接続失敗 /
 *            3=応答は得たが成功扱いしない（HTTP≠200・JSON不可・statusCode≠100・body が配列でない）
 */
'use strict';

var crypto = require('node:crypto');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

// 公式 README の queryDetails 応答例に載っているキー名だけを表示対象にする（未知キーは件数のみ。値は一切出さない）。
var KNOWN_KEYS = ['url', 'createTime', 'lastUpdateTime', 'deviceList', 'enable'];

function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function typeOf(v) {
  if (v === undefined) return 'MISSING';
  if (v === null) return 'NULL';
  if (Array.isArray(v)) return 'ARRAY';
  if (typeof v === 'object') return 'OBJECT';
  return 'OTHER';
}

/** 既存 webhookUrl()（switchbot-verify-key.js）と同じ組み立て。ログには出さない。 */
function currentWebhookUrl(env) {
  return env.VERIFY_RELAY_URL + (env.VERIFY_RELAY_URL.indexOf('?') === -1 ? '?' : '&') +
    't=' + encodeURIComponent(env.VERIFY_WEBHOOK_TOKEN);
}

/** 照会対象 URL を決める。必要な Secret が無ければ null（理由コードは resolveError）。 */
function resolveTarget(env) {
  if (env.TARGET === 'old') return env.VERIFY_OLD_WEBHOOK_URL ? env.VERIFY_OLD_WEBHOOK_URL : null;
  if (env.TARGET && env.TARGET !== 'current') return null;
  return env.VERIFY_RELAY_URL && env.VERIFY_WEBHOOK_TOKEN ? currentWebhookUrl(env) : null;
}

/** 応答の構造だけを抽出する純粋関数。値（URL・message 本文・各項目の値）は返さない。 */
function summarize(http, parsed) {
  var json = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  var sc = json && typeof parsed.statusCode === 'number' ? parsed.statusCode : null;
  var msg = 'MISSING';
  if (json && parsed.message !== undefined && parsed.message !== null) {
    msg = typeof parsed.message === 'string' && parsed.message.trim() === '' ? 'EMPTY' : 'NON_EMPTY';
  }
  var body = json ? parsed.body : undefined;
  var bodyType = typeOf(body);
  var isArr = bodyType === 'ARRAY';
  var present = {};
  var otherKeys = 0;
  if (isArr) {
    body.forEach(function (item) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) return;
      Object.keys(item).forEach(function (k) {
        if (KNOWN_KEYS.indexOf(k) !== -1) present[k] = true; else otherKeys++;
      });
    });
  }
  return {
    http: http,
    json: json,
    statusCode: sc,
    message: msg,
    bodyType: bodyType,
    bodyIsArray: isArr,
    count: isArr ? body.length : null,
    knownKeys: KNOWN_KEYS.filter(function (k) { return present[k]; }),
    otherKeys: otherKeys
  };
}

/** statusCode=100 かつ body が配列のときだけ詳細を信頼する。それ以外は「不明」で、0 件・未登録とは断定しない。 */
function verdict(s) {
  if (s.http !== 200 || !s.json) return 'API_FAILED';
  if (s.statusCode !== 100) return 'NOT_SUCCESS';
  if (!s.bodyIsArray) return 'BODY_UNKNOWN';
  return 'DETAILS_OK';
}

async function main(env, fetchImpl, log) {
  if (!env.SWITCHBOT_TOKEN || !env.SWITCHBOT_SECRET) {
    log('ERROR: SWITCHBOT_TOKEN / SWITCHBOT_SECRET が未設定');
    return 1;
  }
  var target = resolveTarget(env);
  if (!target) {
    log('ERROR: 照会対象 URL を組み立てる Secret が未設定、または TARGET が不正（current / old）');
    return 1;
  }
  var headers = Core.buildAuthHeaders(env.SWITCHBOT_TOKEN, env.SWITCHBOT_SECRET, crypto.randomUUID(), Date.now(), hmac);
  var res;
  var parsed = null;
  try {
    res = await fetchImpl(Core.API_BASE + '/v1.1/webhook/queryWebhook', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ action: 'queryDetails', urls: [target] }),
      signal: AbortSignal.timeout(30000)
    });
    parsed = await res.json().catch(function () { return null; });
  } catch (e) {
    log('ERROR: SwitchBot API に接続できない（再送しない）');
    return 2;
  }
  var s = summarize(res.status, parsed);
  log('queryDetails diagnostic (target=' + (env.TARGET === 'old' ? 'old' : 'current') + ')');
  log('HTTP=' + s.http);
  log('JSON=' + (s.json ? 'OK' : 'FAILED'));
  log('statusCode=' + (s.statusCode === null ? 'MISSING' : s.statusCode));
  log('message=' + s.message);
  log('body=' + s.bodyType);
  log('details=' + (s.bodyIsArray ? 'ARRAY count=' + s.count : 'NOT_ARRAY'));
  if (s.bodyIsArray) {
    log('keys=' + (s.knownKeys.length ? s.knownKeys.join(',') : 'NONE') + (s.otherKeys ? ' other=' + s.otherKeys : ''));
  }
  var v = verdict(s);
  log('判定=' + v + (v === 'DETAILS_OK' ? '' : '（未登録・0 件とは断定しない）'));
  log('読み取り専用。Webhook設定変更なし');
  return v === 'DETAILS_OK' ? 0 : 3;
}

if (require.main === module) {
  main(process.env, fetch, function (m) { console.log(m); }).then(
    function (code) { process.exit(code); },
    function () { console.log('ERROR: 想定外の失敗（詳細は秘匿のため非表示）'); process.exit(1); });
}

module.exports = { main: main, summarize: summarize, verdict: verdict, resolveTarget: resolveTarget };
