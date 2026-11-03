/*
 * 現行 Webhook を 1 回だけ再登録して復旧可否を観測する例外的な検証（Issue #741）。GitHub Actions 手動実行専用。
 * 送信する変更 API は POST /v1.1/webhook/setupWebhook（{"action":"setupWebhook","url":<現行URL>,"deviceList":"ALL"}）を 1 回のみ。
 * 自動リトライなし。失敗・190・UNKNOWN のどの経路でも再送しない。delete / update / createKey / deleteKey / Keypad 変更は一切呼ばない。
 * setup 後は読み取り専用の queryWebhook(queryUrl) を 1 回、必要時のみ queryWebhook(queryDetails, current) を 1 回だけ呼ぶ。
 * 出力は構造情報のみ（HTTP / JSON解析可否 / statusCode / message の EMPTY・NONEMPTY・MISSING / body の型 / 件数 / 一致可否）。
 * Token / Secret / 署名 / Webhook URL / 完全 deviceId / 応答全文は出力しない。
 *
 * 判定: RECOVERED_CONFIRMED / SETUP_ACCEPTED_BUT_QUERY_UNKNOWN / SETUP_FAILED_190 / EXISTING_STATE_DETECTED / UNKNOWN
 * 終了コード: 0=RECOVERED_CONFIRMED / 1=設定不備（送信前に停止） / 3=それ以外（成功扱いしない）
 */
'use strict';

var crypto = require('node:crypto');
var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

var CONFIRM_TEXT = 'I-CONFIRM-SETUP-CURRENT-ONCE';

function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

/** 既存 webhookUrl()（switchbot-verify-key.js）と同じ組み立て。ログには出さない。 */
function currentWebhookUrl(env) {
  return env.VERIFY_RELAY_URL + (env.VERIFY_RELAY_URL.indexOf('?') === -1 ? '?' : '&') +
    't=' + encodeURIComponent(env.VERIFY_WEBHOOK_TOKEN);
}

/** 送信前の検証。エラーコード配列（空なら送信可）。 */
function validateInputs(env) {
  var errs = [];
  if (env.CONFIRM !== CONFIRM_TEXT) errs.push('CONFIRM_MISMATCH');
  // 変更 API は初回 run のみ。Re-run jobs（run_attempt>1）や未設定では送信しない。
  if (env.GITHUB_RUN_ATTEMPT !== '1') errs.push('RERUN_FORBIDDEN');
  if (!env.SWITCHBOT_TOKEN || !env.SWITCHBOT_SECRET) errs.push('SWITCHBOT_CREDENTIALS_MISSING');
  if (!env.VERIFY_RELAY_URL || !env.VERIFY_WEBHOOK_TOKEN) errs.push('CURRENT_URL_SECRETS_MISSING');
  return errs;
}

function typeOf(v) {
  if (v === undefined) return 'MISSING';
  if (v === null) return 'NULL';
  if (Array.isArray(v)) return 'ARRAY';
  if (typeof v === 'object') return 'OBJECT';
  return 'OTHER';
}

/** 応答の構造だけを抽出する。message 本文は返さず、既存判定用の boolean だけ持つ。 */
function summarize(http, parsed) {
  var json = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  var msg = 'MISSING';
  var existing = false;
  if (json && parsed.message !== undefined && parsed.message !== null) {
    var isStr = typeof parsed.message === 'string';
    msg = isStr && parsed.message.trim() === '' ? 'EMPTY' : 'NONEMPTY';
    existing = isStr && /already|exist/i.test(parsed.message);
  }
  return {
    http: http,
    json: json,
    statusCode: json && typeof parsed.statusCode === 'number' ? parsed.statusCode : null,
    message: msg,
    existing: existing,
    bodyType: json ? typeOf(parsed.body) : 'MISSING',
    body: json ? parsed.body : undefined
  };
}

/** setup 応答の分類。statusCode=100（かつ HTTP 200）の場合のみ受理。 */
function classifySetup(s) {
  if (s.http !== 200 || !s.json || s.statusCode === null) return 'UNKNOWN';
  if (s.statusCode === 100) return 'SETUP_ACCEPTED';
  if (s.statusCode === 190) return 'SETUP_FAILED_190';
  if (s.existing) return 'EXISTING_STATE_DETECTED';
  return 'UNKNOWN';
}

/** queryUrl の評価。RECOVERED は statusCode=100 + urls 配列 1 件 + 期待 URL 完全一致のときだけ。 */
function evaluateQueryUrl(s, expectedUrl) {
  if (s.http !== 200 || !s.json || s.statusCode !== 100) return { ok: false, urlsArray: false, count: null, match: null };
  var urls = s.bodyType === 'OBJECT' ? s.body.urls : undefined;
  if (!Array.isArray(urls)) return { ok: false, urlsArray: false, count: null, match: null };
  var match = urls.length === 1 && urls[0] === expectedUrl;
  return { ok: match, urlsArray: true, count: urls.length, match: match };
}

async function post(fetchImpl, env, path, payload) {
  var headers = Core.buildAuthHeaders(env.SWITCHBOT_TOKEN, env.SWITCHBOT_SECRET, crypto.randomUUID(), Date.now(), hmac);
  var res = await fetchImpl(Core.API_BASE + path, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  var parsed = await res.json().catch(function () { return null; });
  return summarize(res.status, parsed);
}

function logLine(log, label, s) {
  log(label + ': HTTP=' + s.http + ' JSON=' + (s.json ? 'OK' : 'FAILED') +
    ' statusCode=' + (s.statusCode === null ? 'MISSING' : s.statusCode) + ' message=' + s.message + ' body=' + s.bodyType);
}

async function main(env, fetchImpl, log) {
  var errs = validateInputs(env);
  if (errs.length) {
    log('ERROR: 入力不備のため setupWebhook を送信せず停止: ' + errs.join(','));
    return 1;
  }
  var expected = currentWebhookUrl(env);
  log('setup-current-once');

  // --- 変更 API: setupWebhook は 1 回だけ。どの経路でも再送しない ---
  var setup;
  try {
    setup = await post(fetchImpl, env, '/v1.1/webhook/setupWebhook', { action: 'setupWebhook', url: expected, deviceList: 'ALL' });
  } catch (e) {
    log('setupWebhook: 通信失敗（送信有無が不明）');
    log('判定=UNKNOWN');
    log('再送なし。追加変更操作なし');
    return 3;
  }
  logLine(log, 'setupWebhook', setup);
  var cls = classifySetup(setup);
  if (cls !== 'SETUP_ACCEPTED') {
    log('判定=' + cls);
    log('再送なし。追加変更操作なし');
    return 3;
  }

  // --- 以降は読み取り専用（queryUrl 1 回、必要時のみ queryDetails(current) 1 回） ---
  var verdict = 'SETUP_ACCEPTED_BUT_QUERY_UNKNOWN';
  var q;
  try {
    q = await post(fetchImpl, env, '/v1.1/webhook/queryWebhook', { action: 'queryUrl' });
  } catch (e) {
    q = null;
    log('queryUrl: 通信失敗');
  }
  if (q) {
    var ev = evaluateQueryUrl(q, expected);
    logLine(log, 'queryUrl', q);
    log('queryUrl: urls=' + (ev.urlsArray ? 'ARRAY count=' + ev.count + ' match=' + (ev.match ? 'YES' : 'NO') : 'NOT_ARRAY'));
    if (ev.ok) verdict = 'RECOVERED_CONFIRMED';
  }
  if (verdict !== 'RECOVERED_CONFIRMED') {
    // 参考情報のみ。判定は成功に変えない。
    try {
      var d = await post(fetchImpl, env, '/v1.1/webhook/queryWebhook', { action: 'queryDetails', urls: [expected] });
      logLine(log, 'queryDetails(current)', d);
    } catch (e) {
      log('queryDetails(current): 通信失敗');
    }
  }
  log('判定=' + verdict);
  log(verdict === 'RECOVERED_CONFIRMED' ? '追加の変更操作なし' : '再送なし。追加変更操作なし');
  return verdict === 'RECOVERED_CONFIRMED' ? 0 : 3;
}

if (require.main === module) {
  main(process.env, fetch, function (m) { console.log(m); }).then(
    function (code) { process.exit(code); },
    function () { console.log('ERROR: 想定外の失敗（詳細は秘匿のため非表示）'); process.exit(1); });
}

module.exports = { main: main, validateInputs: validateInputs, classifySetup: classifySetup, evaluateQueryUrl: evaluateQueryUrl, summarize: summarize, CONFIRM_TEXT: CONFIRM_TEXT };
