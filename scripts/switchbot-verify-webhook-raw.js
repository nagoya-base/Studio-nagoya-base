/*
 * SwitchBot queryWebhook 応答構造の読み取り専用診断（Issue #737）。GitHub Actions 手動実行用。
 * 送信する API は POST /v1.1/webhook/queryWebhook（body {"action":"queryUrl"}）を 1 回のみ。自動リトライなし。
 * Webhook の登録・更新・削除、Keypad のキー操作などの変更系 API は一切呼ばない。
 * 出力は構造情報のみ（HTTP / JSON解析可否 / statusCode / message の空・非空・欠落 / body の型 / urls の配列可否と件数）。
 * Token / Secret / 署名 / URL 値 / deviceId / 応答全体は出力しない。既存の webhook-query 判定ロジックとは独立。
 *
 * 終了コード: 0=statusCode=100 かつ urls が配列 / 1=設定不備 / 2=接続失敗 /
 *            3=応答は得たが成功扱いしない（HTTP≠200・JSON不可・statusCode≠100・urls が配列でない）
 */
'use strict';

var crypto = require('node:crypto');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

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

/** 応答の構造だけを抽出する純粋関数。値（URL・message 本文）は返さない。 */
function summarize(http, parsed) {
  var json = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  var sc = json && typeof parsed.statusCode === 'number' ? parsed.statusCode : null;
  var msg = 'MISSING';
  if (json && parsed.message !== undefined && parsed.message !== null) {
    msg = typeof parsed.message === 'string' && parsed.message.trim() === '' ? 'EMPTY' : 'NON_EMPTY';
  }
  var body = json ? parsed.body : undefined;
  var bodyType = typeOf(body);
  var urls = bodyType === 'OBJECT' ? body.urls : undefined;
  var urlsIsArray = Array.isArray(urls);
  return {
    http: http,
    json: json,
    statusCode: sc,
    message: msg,
    bodyType: bodyType,
    urlsIsArray: urlsIsArray,
    urlsCount: urlsIsArray ? urls.length : null
  };
}

/** statusCode=100 かつ urls が配列のときだけ件数を信頼する。0 件確定は urls=[] の場合のみ。 */
function verdict(s) {
  if (s.http !== 200 || !s.json) return 'API_FAILED';
  if (s.statusCode !== 100) return 'NOT_SUCCESS';
  if (!s.urlsIsArray) return 'URLS_UNKNOWN';
  return s.urlsCount === 0 ? 'ZERO_CONFIRMED' : 'REGISTERED';
}

async function main(env, fetchImpl, log) {
  if (!env.SWITCHBOT_TOKEN || !env.SWITCHBOT_SECRET) {
    log('ERROR: SWITCHBOT_TOKEN / SWITCHBOT_SECRET が未設定');
    return 1;
  }
  var headers = Core.buildAuthHeaders(env.SWITCHBOT_TOKEN, env.SWITCHBOT_SECRET, crypto.randomUUID(), Date.now(), hmac);
  var res;
  var parsed = null;
  try {
    res = await fetchImpl(Core.API_BASE + '/v1.1/webhook/queryWebhook', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ action: 'queryUrl' }),
      signal: AbortSignal.timeout(30000)
    });
    parsed = await res.json().catch(function () { return null; });
  } catch (e) {
    log('ERROR: SwitchBot API に接続できない（再送しない）');
    return 2;
  }
  var s = summarize(res.status, parsed);
  log('queryWebhook raw diagnostic');
  log('HTTP=' + s.http);
  log('JSON=' + (s.json ? 'OK' : 'FAILED'));
  log('statusCode=' + (s.statusCode === null ? 'MISSING' : s.statusCode));
  log('message=' + s.message);
  log('body=' + s.bodyType);
  log('urls=' + (s.urlsIsArray ? 'ARRAY count=' + s.urlsCount : 'NOT_ARRAY'));
  var v = verdict(s);
  log('判定=' + v + (v === 'ZERO_CONFIRMED' ? '（statusCode=100 かつ urls=[] のため 0 件）' : v === 'REGISTERED' ? '' : '（0 件とは断定しない）'));
  log('読み取り専用。Webhook設定変更なし');
  return v === 'ZERO_CONFIRMED' || v === 'REGISTERED' ? 0 : 3;
}

if (require.main === module) {
  main(process.env, fetch, function (m) { console.log(m); }).then(
    function (code) { process.exit(code); },
    function () { console.log('ERROR: 想定外の失敗（詳細は秘匿のため非表示）'); process.exit(1); });
}

module.exports = { main: main, summarize: summarize, verdict: verdict };
