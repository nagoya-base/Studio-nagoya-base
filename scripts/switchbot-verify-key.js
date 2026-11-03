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
  'webhook-remove': 'REMOVE-WEBHOOK',
  'webhook-query': 'QUERY-WEBHOOK',
  'remove-old': 'REMOVE-OLD-WEBHOOK',
  'setup-current': 'SETUP-CURRENT-WEBHOOK',
  // Issue #729: 初回接続・他用途Webhookなしを管理者が明示確認した場合だけの例外フロー（現行remove-oldとは別）
  'replace-single-webhook-remove': 'I-CONFIRM-SINGLE-WEBHOOK-IS-MINE',
  // Issue #731: deleteWebhook送信後に照会不能となった場合の復旧。読み取り照合のみで DELETE_SENT→REMOVED だけを確定する
  'recover-delete-sent': 'RECOVER-DELETE-SENT-IF-ZERO',
  // Issue #718: createKey 前の読み取り専用の事前確認（Keypad完全ID・Webhook設定一致・受信基盤・残存キー）
  'preflight': 'PREFLIGHT-CHECK'
};
var REQUIRED = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'SWITCHBOT_DEVICE_ID',
  'VERIFY_RELAY_URL', 'VERIFY_RELAY_ADMIN_TOKEN', 'VERIFY_WEBHOOK_TOKEN'];

var QUERY_REQUIRED = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'VERIFY_RELAY_URL', 'VERIFY_WEBHOOK_TOKEN'];

// Webhook置換(Issue #727)。Keypad ID は不要。進行記録はリレーに保持するため管理トークンが必要。
var REPLACE_REQUIRED = QUERY_REQUIRED.concat(['VERIFY_RELAY_ADMIN_TOKEN']);
var REMOVE_OLD_REQUIRED = REPLACE_REQUIRED.concat(['VERIFY_OLD_WEBHOOK_URL', 'VERIFY_OLD_WEBHOOK_EVIDENCE']);
var MUTATING_REPLACE = ['remove-old', 'setup-current', 'replace-single-webhook-remove', 'recover-delete-sent'];
var EVIDENCE_MAX_AGE_SEC = 24 * 60 * 60; // 人手確認の証跡・削除成功の証跡の有効期間

function hmac(secret, message) {
  return crypto.createHmac('sha256', secret).update(message).digest('base64');
}

function jst(sec) {
  return new Date(sec * 1000).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}

/**
 * createKey が「明確に拒否された（未作成）」と言えるか。
 * 4xx、または statusCode 151/152/160/161（デバイス不明・コマンド不正等）のみ。
 * 5xx・応答なし・JSON解析不能・その他は受理有無が不明なので拒否扱いにしない。
 */
function isDefiniteRejection(r) {
  var sc = r && r.parsed && typeof r.parsed.statusCode === 'number' ? r.parsed.statusCode : null;
  if (r.http >= 400 && r.http < 500) return true;
  return r.http === 200 && [151, 152, 160, 161].indexOf(sc) !== -1;
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
  // webhook-query は照会専用。Keypad ID・リレー管理トークンは不要（最小限の秘密だけを要求）
  var req = REQUIRED;
  if (action === 'webhook-query') req = QUERY_REQUIRED;
  if (action === 'setup-current' || action === 'replace-single-webhook-remove' || action === 'recover-delete-sent') req = REPLACE_REQUIRED;
  if (action === 'remove-old') req = REMOVE_OLD_REQUIRED;
  req.forEach(function (k) { if (!env[k]) errs.push('SECRET_MISSING_' + k); });
  // 変更API(置換)は初回のrunだけ。「Re-run jobs」(run_attempt>1)では送信しない（未設定も不許可）
  if (MUTATING_REPLACE.indexOf(action) !== -1 && env.GITHUB_RUN_ATTEMPT !== '1') errs.push('RERUN_FORBIDDEN');
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
    opt.signal = AbortSignal.timeout(30000); // 無期限待ちにしない。自動リトライはしない
    var res = await deps.fetch(Core.API_BASE + path, opt);
    var parsed = await res.json().catch(function () { return null; });
    return { http: res.status, parsed: parsed };
  }
  async function relay(payload) {
    var res = await deps.fetch(env.VERIFY_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ t: env.VERIFY_RELAY_ADMIN_TOKEN }, payload)),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    var parsed = await res.json().catch(function () { return null; });
    return parsed || { ok: false, error: 'RELAY_BAD_RESPONSE' };
  }
  return { sb: sb, relay: relay, deps: deps };
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

var TEST_NAME_PREFIX = 'SNB-API-TEST-';

/**
 * 発行前ゲート（読み取り専用）。Webhook受信基盤が利用可能であることを確認する。
 *  - WEBHOOK_SET: queryWebhook が厳密に1件・今回の期待URLと完全一致（MATCH）。0件/不一致/複数件/不明は NG。
 *  - WEBHOOK_ENDPOINT: 受信URLへ無害な試験POST（commandIdなし＝何も保存されない）を送り ok:true が返る（URL・トークンが有効）。
 *  - RELAY_ADMIN: 管理トークンでリレーの getState が成功する。
 * 戻り値の checks は固定の状態名のみ。URL・トークン・生レスポンス・例外詳細は含めない。
 * MATCH でも SwitchBot→受信基盤の到達は証明されない（実際の到達は createKey の Webhook で初めて確認）。
 */
async function checkWebhookInfra(env, c) {
  var checks = {};
  var q;
  try {
    q = await c.sb('post', '/v1.1/webhook/queryWebhook', { action: 'queryUrl' });
    var r = evaluateWebhookQuery(q.http, q.parsed, webhookUrl(env));
    checks.WEBHOOK_SET = r.state === 'MATCH' && r.count === 1 ? 'PASS' : 'FAIL(' + r.state + (r.state === 'MATCH' ? '_COUNT=' + r.count : '') + ')';
  } catch (e) {
    checks.WEBHOOK_SET = 'FAIL(UNKNOWN)';
  }
  try {
    var res = await c.deps.fetch(webhookUrl(env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventType: 'preflight' }),
      redirect: 'follow',
      signal: AbortSignal.timeout(30000)
    });
    var pj = await res.json().catch(function () { return null; });
    checks.WEBHOOK_ENDPOINT = pj && pj.ok === true ? 'PASS' : 'FAIL';
  } catch (e) {
    checks.WEBHOOK_ENDPOINT = 'FAIL';
  }
  try {
    var st = await c.relay({ op: 'getState' });
    checks.RELAY_ADMIN = st && st.ok === true ? 'PASS' : 'FAIL';
    checks.RELAY_STATE = st && st.ok === true ? (st.state === null ? 'CLEAN' : 'IN_USE') : 'UNKNOWN';
  } catch (e) {
    checks.RELAY_ADMIN = 'FAIL';
    checks.RELAY_STATE = 'UNKNOWN';
  }
  return checks;
}

function infraOk(checks) {
  return checks.WEBHOOK_SET === 'PASS' && checks.WEBHOOK_ENDPOINT === 'PASS' && checks.RELAY_ADMIN === 'PASS';
}

/**
 * Issue #718 手順1〜2: 読み取り専用の事前確認。createKey / deleteKey / setup / update / delete の各APIは呼ばない。
 * 全項目 PASS のときだけ終了コード0。PASS は「発行してよい前提が整った」ことのみを意味し、
 * キー発行・Webhook到達・実機解錠の成功とは扱わない。
 */
async function preflight(env, deps, c, log) {
  log('preflight: 読み取り専用（変更API・createKey/deleteKeyは呼ばない）');
  var checks = {};
  var last4 = null;
  var dl;
  try {
    dl = await c.sb('get', '/v1.1/devices');
  } catch (e) {
    dl = null;
  }
  var list = dl && Core.classifyApiResponse(dl.http, dl.parsed).state !== Core.STATE.FAILED
    ? (dl.parsed.body && dl.parsed.body.deviceList) : null;
  if (!Array.isArray(list)) {
    checks.KEYPAD = 'FAIL(DEVICES_FAILED)';
    checks.LEFTOVER_TEST_KEYS = 'UNKNOWN';
  } else {
    var id = String(env.SWITCHBOT_DEVICE_ID);
    var v = Core.verifyKeypadByFullId(list, id, id.slice(-4));
    checks.KEYPAD = v.ok ? 'PASS' : 'FAIL(' + v.error + ')';
    if (v.ok) last4 = id.slice(-4);
    var kl = Core.countKeyList(list, id);
    if (!kl.valid) {
      checks.LEFTOVER_TEST_KEYS = 'UNKNOWN';
    } else {
      var dev = list.filter(function (d) { return d && d.deviceId === id; })[0];
      var left = dev.keyList.filter(function (k) { return k && typeof k.name === 'string' && k.name.indexOf(TEST_NAME_PREFIX) === 0; }).length;
      checks.LEFTOVER_TEST_KEYS = left === 0 ? 'NONE' : 'FOUND(' + left + ')';
    }
  }
  Object.assign(checks, await checkWebhookInfra(env, c));

  log('対象Keypad 末尾4桁=' + (last4 || '不明'));
  Object.keys(checks).forEach(function (k) { log('  ' + k + ': ' + checks[k]); });
  var ok = checks.KEYPAD === 'PASS' && infraOk(checks) &&
    checks.RELAY_STATE === 'CLEAN' && checks.LEFTOVER_TEST_KEYS === 'NONE';
  log(ok ? 'PREFLIGHT_PASS: 発行前の前提が整った（キー発行・Webhook到達・解錠の成功ではない）'
    : 'PREFLIGHT_FAIL: 前提が整っていない。create-key は実行しない（残存キー/使用中の検証状態は delete-key・アプリで先に整理）');
  return ok ? 0 : 1;
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

/** 削除後の確認: 完全な応答で、対象デバイスの keyList(配列)に今回の検証名が無い場合だけ GONE。 */
async function checkKeyGone(c, env, name) {
  var r = await c.sb('get', '/v1.1/devices');
  if (Core.classifyApiResponse(r.http, r.parsed).state === Core.STATE.FAILED) return { result: 'INVALID', error: 'DEVICES_FAILED' };
  var ins = Core.inspectKeyList(r.parsed.body && r.parsed.body.deviceList, env.SWITCHBOT_DEVICE_ID, name);
  if (!ins.valid) return { result: 'INVALID', error: ins.error };
  return { result: ins.count === 0 ? 'GONE' : 'PRESENT', error: null };
}

/** 削除コマンド送信済みの状態から再開: 保存済み commandId の Webhook 結果と keyList 消失だけを確認する（再削除しない）。 */
async function resumeDelete(env, deps, c, log, st) {
  log('前回の deleteKey 送信済み。Webhook結果とkeyList消失の確認を再開（再削除しない）');
  var state = await awaitEvent(c, deps, st.deleteCommandId, 'deleteKey');
  log('deleteKey Webhook結果: ' + state);
  if (state === Core.STATE.FAILED) {
    await c.relay({ op: 'setDelete', commandId: '' });
    log('FAILED: 前回の deleteKey は失敗。進行状態をリセット（状態は保持。再度 delete-key 可）');
    return 1;
  }
  if (state !== Core.STATE.APPLIED) { log('UNKNOWN: Webhook未確認。保持データは残す'); return 1; }
  return finishDelete(env, c, log, st);
}

async function finishDelete(env, c, log, st) {
  var g = await checkKeyGone(c, env, st.name);
  if (g.result === 'PRESENT') { log('UNKNOWN: Webhook成功だが keyList にキーが残っている。再削除せず保持データを残す'); return 1; }
  if (g.result !== 'GONE') { log('UNKNOWN: keyList で消失を確認できない（' + g.error + '）。保持データは残す'); return 1; }
  await c.relay({ op: 'clear' });
  log('deleteKey: ' + Core.STATE.APPLIED + ' / keyList(完全な応答)から消失を確認 / 保持データを破棄');
  log('実機で削除後に同じコードで解錠不可も確認すること');
  return 0;
}

async function createKey(env, deps, c, log) {
  var dev = await loadDevices(c, env);
  if (dev.error) { log('ABORT: ' + dev.error); return 1; }
  log('対象Keypad 末尾4桁=' + dev.last4);

  // 発行前ゲート: Webhook受信基盤が利用可能でなければ、claim も createKey も送らず中断する
  var gate = await checkWebhookInfra(env, c);
  if (!infraOk(gate)) {
    log('ABORT: Webhook受信基盤の事前確認が未達 ' + Object.keys(gate).map(function (k) { return k + '=' + gate[k]; }).join(' ') +
      '（claim・createKeyは送らない。preflight で確認）');
    return 1;
  }

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

  var claim = await c.relay(Object.assign({ op: 'claim', deviceId: env.SWITCHBOT_DEVICE_ID }, params));
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
    if (!isDefiniteRejection(r)) {
      log('UNKNOWN: createKey の受理有無が不明 http=' + r.http + '。再送せず停止、状態は保持（keyList/アプリで今回の検証名を確認し delete-key で後片付け）');
      return 1;
    }
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

  // 発行元 deviceId と現在の対象が一致しなければ操作前に中断（Secret差し替え対策）
  if (!st.deviceId || st.deviceId !== env.SWITCHBOT_DEVICE_ID) {
    log('ABORT: 保存された発行先Keypadと現在の対象が一致しない。削除しない（アプリで今回のキーだけを特定して対応）');
    return 1;
  }
  if (st.deleteCommandId) return resumeDelete(env, deps, c, log, st);
  // 保存済み ID があっても、現在の対象 keyList で今回の検証名が一意かつ ID 一致であることを確認
  var rr = Core.resolvePasscodeIdByName(dev.list, env.SWITCHBOT_DEVICE_ID, st.name);
  if (rr.id === null) { log('UNKNOWN: 今回のキーを keyList で一意に特定できない ' + rr.error + '（削除しない。アプリで今回のキーだけを特定）'); return 1; }
  if (st.passcodeId && String(rr.id) !== String(st.passcodeId)) {
    log('ABORT: 保存したpasscode IDと keyList の今回のキーが不一致。削除しない');
    return 1;
  }
  var id = rr.id;
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

  await c.relay({ op: 'setDelete', commandId: ids.commandId }); // 別runで再開できるよう送信後すぐ永続化
  var state = await awaitEvent(c, deps, ids.commandId, 'deleteKey');
  log('deleteKey Webhook結果: ' + state);
  if (state !== Core.STATE.APPLIED) { log('未確認のため保持データは残す。keyList/アプリで確認'); return 1; }
  return finishDelete(env, c, log, st);
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

/**
 * queryWebhook(queryUrl) 応答を判定する純粋関数（照会専用。秘密なしでテスト可能）。
 * 成功（HTTP200 + statusCode100）かつ body.urls が文字列の配列のときだけ判定する。
 * 欠落・非配列・非文字列要素・API失敗は「登録なし」と見なさず UNKNOWN。
 * 戻り値は公開可能な情報のみ（状態・件数・HTTP/APIコード）。URL・message は含めない。
 */
function evaluateWebhookQuery(http, parsed, expectedUrl) {
  var sc = parsed && typeof parsed.statusCode === 'number' ? parsed.statusCode : null;
  var base = { count: null, http: http, statusCode: sc };
  if (http !== 200 || sc !== 100) return Object.assign(base, { state: 'UNKNOWN', reason: 'API_FAILED' });
  var urls = parsed.body && parsed.body.urls;
  if (!Array.isArray(urls) || urls.some(function (u) { return typeof u !== 'string'; })) {
    return Object.assign(base, { state: 'UNKNOWN', reason: 'BAD_FORMAT' });
  }
  base.count = urls.length;
  if (urls.length === 0) return Object.assign(base, { state: 'NONE', reason: null });
  var state = urls.indexOf(expectedUrl) !== -1 ? 'MATCH' : 'MISMATCH';
  return Object.assign(base, { state: state, reason: null });
}

/**
 * 既存 Webhook URL 1 件の追加診断（照会専用の純粋関数。秘密なしでテスト可能）。
 * 比較は実行環境内のみ。戻り値は固定の分類名だけで、URL・クエリ・トークン・例外詳細を含めない。
 *   BASE_URL_MATCH + TOKEN_MATCH / BASE_URL_MATCH + TOKEN_MISMATCH / BASE_URL_MATCH + TOKEN_MISSING
 *   BASE_URL_MISMATCH / UNKNOWN（安全に判定できない。推測しない）
 * 正規化方針: URL API で解析し scheme・host(ポート含む。大小文字・既定ポートはURL APIが正規化)・path を厳密比較する。
 *   path は末尾スラッシュ等を含め完全一致のみ（正規化で同一視しない）。クエリ・フラグメントはベースURL比較に含めない。
 * ユーザー情報付きURL、期待URL側に t があるなど曖昧な入力は UNKNOWN。空の t は欠落ではなく値不一致として扱う。
 * これは部分診断であり、完全一致(MATCH/MISMATCH)の判定・終了コードには影響させない。
 */
function diagnoseWebhookUrl(existingUrl, relayUrl, token) {
  var ex;
  var rl;
  try {
    ex = new URL(existingUrl);
    rl = new URL(relayUrl);
  } catch (e) {
    return 'UNKNOWN';
  }
  if (typeof token !== 'string' || token === '') return 'UNKNOWN';
  if (ex.username || ex.password || rl.username || rl.password) return 'UNKNOWN';
  if (rl.searchParams.has('t')) return 'UNKNOWN';
  if (ex.protocol !== rl.protocol || ex.host !== rl.host || ex.pathname !== rl.pathname) return 'BASE_URL_MISMATCH';
  var ts = ex.searchParams.getAll('t');
  if (ts.length === 0) return 'BASE_URL_MATCH + TOKEN_MISSING';
  if (ts.length > 1) return 'UNKNOWN';
  return ts[0] === token ? 'BASE_URL_MATCH + TOKEN_MATCH' : 'BASE_URL_MATCH + TOKEN_MISMATCH';
}

/**
 * 既存 Webhook 設定の照会専用入口。queryWebhook のみ呼び、setup/update/delete は呼ばない。
 * 比較は実行環境内で行い、公開するのは 未登録(NONE)/一致(MATCH)/不一致(MISMATCH)/不明(UNKNOWN)・件数・HTTP/API状態のみ。
 * MATCH でも再登録・削除しない。MISMATCH でも上書き・削除しない。MATCH は到達性・キー反映成功を意味しない。
 */
async function webhookQuery(env, c, log) {
  var q;
  try {
    q = await c.sb('post', '/v1.1/webhook/queryWebhook', { action: 'queryUrl' });
  } catch (e) {
    log('webhook-query: UNKNOWN（通信失敗）。「登録なし」とは見なさない');
    return 1;
  }
  var r = evaluateWebhookQuery(q.http, q.parsed, webhookUrl(env));
  log('webhook-query: ' + r.state + ' 件数=' + (r.count === null ? '不明' : r.count) +
    ' http=' + r.http + ' statusCode=' + (r.statusCode === null ? '不明' : r.statusCode) +
    (r.reason ? ' 理由=' + r.reason : ''));
  // 追加診断: 既存Webhookが厳密に1件で、判定が成立している場合だけ。それ以外は推測せず UNKNOWN
  var diag = 'UNKNOWN';
  if (r.count === 1 && (r.state === 'MATCH' || r.state === 'MISMATCH')) {
    diag = diagnoseWebhookUrl(q.parsed.body.urls[0], env.VERIFY_RELAY_URL, env.VERIFY_WEBHOOK_TOKEN);
  }
  log('webhook-query 追加診断: ' + diag + (r.count === 1 ? '' : '（診断対象は既存1件のみ）'));
  log('照会のみ。Webhook設定は変更していない。一致でも到達性・キー反映成功は意味しない。診断結果から設定変更しない');
  return r.state === 'NONE' || r.state === 'MATCH' ? 0 : 1;
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

// ---------------------------------------------------------------------------
// Webhook置換（Issue #727）: remove-old（旧Webhookの削除だけ）と setup-current（現在URLの登録だけ）。
// 出力は固定文字列・件数・固定の理由コードのみ。URL・トークン・生レスポンス・message・例外詳細は出さない。
// 変更APIは各操作で最大1回。送信後は結果にかかわらず再送・自動継続・ロールバックをしない。
// ---------------------------------------------------------------------------

function sha12(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 12);
}

/**
 * 人手確認の証跡（秘密を含まない照合記録）を検証する純粋関数。
 * 形式: "<旧URLのSHA-256先頭12桁>@<確認時刻 ISO8601 UTC 例 2026-11-02T12:00:00Z>"
 * 旧URL(秘密領域)の値と結び付き、24時間以内・未来でないものだけ有効。
 */
function checkOldEvidence(oldUrl, evidence, nowSec) {
  var m = /^([0-9a-f]{12})@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)$/.exec(String(evidence || ''));
  if (!m) return { ok: false, error: 'EVIDENCE_FORMAT' };
  if (m[1] !== sha12(oldUrl)) return { ok: false, error: 'EVIDENCE_TARGET_MISMATCH' };
  var at = Date.parse(m[2]);
  if (!Number.isFinite(at)) return { ok: false, error: 'EVIDENCE_FORMAT' };
  var age = nowSec - Math.floor(at / 1000);
  if (age < 0) return { ok: false, error: 'EVIDENCE_FUTURE' };
  if (age > EVIDENCE_MAX_AGE_SEC) return { ok: false, error: 'EVIDENCE_STALE' };
  return { ok: true };
}

/** queryWebhook の結果を { ok, urls, reason } に正規化。通信失敗・応答不正は UNKNOWN（登録なしと見なさない）。 */
async function queryUrls(c) {
  var q;
  try {
    q = await c.sb('post', '/v1.1/webhook/queryWebhook', { action: 'queryUrl' });
  } catch (e) {
    return { ok: false, reason: 'COMM_FAILED' };
  }
  var r = evaluateWebhookQuery(q.http, q.parsed, '');
  if (r.state === 'UNKNOWN') return { ok: false, reason: r.reason };
  return { ok: true, urls: q.parsed.body.urls.slice() };
}

async function relayCall(c, payload) {
  try {
    var r = await c.relay(payload);
    return r && r.ok === true ? r : { ok: false, error: (r && r.error) || 'RELAY_FAILED' };
  } catch (e) {
    return { ok: false, error: 'RELAY_COMM_FAILED' };
  }
}

/** 既存が厳密に1件で、それが人手確認済みの旧URLと完全一致することを再照会で確認する。 */
async function confirmOldTarget(env, c) {
  var q = await queryUrls(c);
  if (!q.ok) return { ok: false, error: 'QUERY_' + q.reason };
  if (q.urls.length !== 1) return { ok: false, error: q.urls.length === 0 ? 'COUNT_ZERO' : 'COUNT_MULTIPLE' };
  if (q.urls[0] === webhookUrl(env)) return { ok: false, error: 'TARGET_IS_CURRENT_URL' };
  if (q.urls[0] !== env.VERIFY_OLD_WEBHOOK_URL) return { ok: false, error: 'TARGET_NOT_CONFIRMED' };
  return { ok: true };
}

async function removeOld(env, deps, c, log) {
  log('remove-old: 旧Webhookの削除のみ（deleteWebhookは最大1回。setupWebhookは呼ばない）');
  var ev = checkOldEvidence(env.VERIFY_OLD_WEBHOOK_URL, env.VERIFY_OLD_WEBHOOK_EVIDENCE, deps.nowSec());
  if (!ev.ok) { log('ABORT: 人手確認の証跡が不正 ' + ev.error + '（変更APIは呼ばない）'); return 1; }

  var m = await relayCall(c, { op: 'migGet' });
  if (!m.ok) { log('ABORT: 進行記録を確認できない ' + m.error + '（変更APIは呼ばない）'); return 1; }
  if (m.mig) { log('ABORT: 置換の進行記録あり phase=' + m.mig.phase + '。元runの再送はしない（照会と人手確認のみ）'); return 1; }

  var t1 = await confirmOldTarget(env, c);
  if (!t1.ok) { log('ABORT: 対象を確認できない ' + t1.error + '（変更APIは呼ばない）'); return 1; }
  var t2 = await confirmOldTarget(env, c); // 削除直前の再照会（同じ1件であること）
  if (!t2.ok) { log('ABORT: 削除直前の再照会で対象が変わった/確認できない ' + t2.error + '（変更APIは呼ばない）'); return 1; }

  // 送信前に「送信済み」を永続化する（成功した場合のみ送信へ進む）。以後、別runや再実行では削除を送らない
  var b = await relayCall(c, { op: 'migBeginDelete', fp: sha12(env.VERIFY_OLD_WEBHOOK_URL) });
  if (!b.ok) { log('ABORT: 送信済み記録を保存できない ' + b.error + '（変更APIは呼ばない）'); return 1; }

  var r;
  try {
    r = await c.sb('post', '/v1.1/webhook/deleteWebhook', { action: 'deleteWebhook', url: env.VERIFY_OLD_WEBHOOK_URL });
  } catch (e) {
    log('UNKNOWN: deleteWebhook の送信結果が不明。再送せず停止（照会と人手確認のみ）');
    return 1;
  }
  if (Core.classifyApiResponse(r.http, r.parsed).state === Core.STATE.FAILED) {
    log('FAILED: deleteWebhook がAPIで失敗 http=' + r.http + '。再送・自動継続せず停止（照会と人手確認のみ）');
    return 1;
  }
  log('deleteWebhook: 受理応答 http=' + r.http + '（受理だけでは削除成功としない。再照会で確認）');

  var after = await queryUrls(c);
  if (!after.ok) { log('UNKNOWN: 削除後の再照会が不明 ' + after.reason + '。再送せず停止'); return 1; }
  if (after.urls.length !== 0) { log('UNKNOWN: 削除後も登録が残存/出現 件数=' + after.urls.length + '。再送せず停止'); return 1; }
  var done = await relayCall(c, { op: 'migMarkRemoved' });
  if (!done.ok) { log('UNKNOWN: 削除は0件確認済みだが成功記録を保存できない ' + done.error + '。停止（setup-currentは進めない）'); return 1; }
  log('remove-old: 旧Webhookの削除を確認（再照会 件数=0）。次は別操作 setup-current（本操作では登録しない）');
  return 0;
}

/**
 * 例外フロー（Issue #729）: 管理者が「初回接続・他用途Webhookなし・既存1件は自分のもの」と確認済みの場合だけ、
 * 実行環境内で得た既存1件を削除する（旧URLのSecret/証跡は不要）。現行 remove-old は変更しない。
 * 削除のみ。setupWebhookは呼ばない。登録は別操作 setup-current（REMOVED記録が必須）。
 */
async function replaceSingleWebhookRemove(env, deps, c, log) {
  log('replace-single-webhook-remove: 管理者確認済みの既存1件の削除のみ（deleteWebhookは最大1回。setupWebhookは呼ばない）');
  var m = await relayCall(c, { op: 'migGet' });
  if (!m.ok) { log('ABORT: 進行記録を確認できない ' + m.error + '（変更APIは呼ばない）'); return 1; }
  if (m.mig) { log('ABORT: 置換の進行記録あり phase=' + m.mig.phase + '。元runの再送はしない（照会と人手確認のみ）'); return 1; }

  var expected = webhookUrl(env);
  async function single() {
    var q = await queryUrls(c);
    if (!q.ok) return { ok: false, error: 'QUERY_' + q.reason };
    if (q.urls.length !== 1) return { ok: false, error: q.urls.length === 0 ? 'COUNT_ZERO' : 'COUNT_MULTIPLE' };
    if (q.urls[0] === expected) return { ok: false, error: 'TARGET_IS_CURRENT_URL' };
    return { ok: true, url: q.urls[0] };
  }
  var t1 = await single();
  if (!t1.ok) { log('ABORT: 対象を確認できない ' + t1.error + '（変更APIは呼ばない）'); return 1; }
  var t2 = await single(); // 削除直前の再照会（厳密に1件かつ同一であること）
  if (!t2.ok) { log('ABORT: 削除直前の再照会で対象が変わった/確認できない ' + t2.error + '（変更APIは呼ばない）'); return 1; }
  if (t2.url !== t1.url) { log('ABORT: 削除直前の再照会で対象が変わった（変更APIは呼ばない）'); return 1; }

  var b = await relayCall(c, { op: 'migBeginDelete', fp: sha12(t2.url) });
  if (!b.ok) { log('ABORT: 送信済み記録を保存できない ' + b.error + '（変更APIは呼ばない）'); return 1; }

  var r;
  try {
    r = await c.sb('post', '/v1.1/webhook/deleteWebhook', { action: 'deleteWebhook', url: t2.url });
  } catch (e) {
    log('UNKNOWN: deleteWebhook の送信結果が不明。再送せず停止（照会と人手確認のみ）');
    return 1;
  }
  if (Core.classifyApiResponse(r.http, r.parsed).state === Core.STATE.FAILED) {
    log('FAILED: deleteWebhook がAPIで失敗 http=' + r.http + '。再送・自動継続せず停止（照会と人手確認のみ）');
    return 1;
  }
  log('deleteWebhook: 受理応答 http=' + r.http + '（受理だけでは削除成功としない。再照会で確認）');

  var after = await queryUrls(c);
  if (!after.ok) { log('UNKNOWN: 削除後の再照会が不明 ' + after.reason + '。再送せず停止'); return 1; }
  if (after.urls.length !== 0) { log('UNKNOWN: 削除後も登録が残存/出現 件数=' + after.urls.length + '。再送せず停止'); return 1; }
  var done = await relayCall(c, { op: 'migMarkRemoved' });
  if (!done.ok) { log('UNKNOWN: 削除は0件確認済みだが成功記録を保存できない ' + done.error + '。停止（setup-currentは進めない）'); return 1; }
  log('replace-single-webhook-remove: 既存1件の削除を確認（再照会 件数=0）。次は別操作 setup-current（本操作では登録しない）');
  return 0;
}

/**
 * Issue #731: deleteWebhook送信後に queryWebhook が不明(statusCode=190等)となった状態の復旧。
 * 変更API(deleteWebhook/setupWebhook/updateWebhook/createKey/deleteKey)は一切呼ばない。呼ぶのは queryWebhook(queryUrl) と
 * リレーの migGet / migMarkRemoved のみ。phase が厳密に DELETE_SENT で、かつ照会が厳密に0件の場合だけ REMOVED へ確定する。
 *   DELETED_CONFIRMED … 0件 → REMOVED へ遷移（1回のみ）
 *   STILL_PRESENT     … 1件以上 → 状態変更なし（人手判断。URL実値は出さない）
 *   UNKNOWN           … 190/通信断/応答不正 → 状態変更なし（推測しない）
 */
async function recoverDeleteSent(env, deps, c, log) {
  log('recover-delete-sent: 読み取り照合のみ（変更APIは呼ばない。DELETE_SENT→REMOVED以外の遷移はしない）');
  var m = await relayCall(c, { op: 'migGet' });
  if (!m.ok) { log('ABORT: 進行記録を確認できない ' + m.error + '（状態は変更しない）'); return 1; }
  var rec = m.mig && typeof m.mig === 'object' && !Array.isArray(m.mig) ? m.mig : null;
  var phase = rec && typeof rec.phase === 'string' ? rec.phase : null;
  if (phase !== 'DELETE_SENT') {
    var known = ['REMOVED', 'SETUP_SENT', 'DONE'].indexOf(phase) !== -1;
    log('ABORT: phase が DELETE_SENT ではない phase=' + (m.mig === null ? 'NONE' : known ? phase : 'INVALID') + '（状態は変更しない）');
    return 1;
  }
  // DELETE_SENT レコードの構造検証（fp=12桁hex・atSec=有限な数値）。不正なら照会も遷移もしない。値は出さない
  if (typeof rec.fp !== 'string' || !/^[0-9a-f]{12}$/.test(rec.fp) ||
      typeof rec.atSec !== 'number' || !isFinite(rec.atSec)) {
    log('ABORT: 進行記録の形式が不正（DELETE_SENT の fp/atSec）。照会せず状態は変更しない');
    return 1;
  }
  var q = await queryUrls(c);
  if (!q.ok) {
    log('UNKNOWN: 現在のWebhook状態を読み取れない 理由=' + q.reason + '。削除済み/未登録とは推測しない。状態は変更しない');
    return 1;
  }
  if (q.urls.length !== 0) {
    log('STILL_PRESENT: Webhookが残存 件数=' + q.urls.length + '。状態は変更しない・自動再削除しない（人手判断へ）');
    return 1;
  }
  var mv = await relayCall(c, { op: 'migMarkRemoved' });
  if (!mv.ok) { log('UNKNOWN: 0件は確認済みだが REMOVED を保存できない ' + mv.error + '。状態は変更しない'); return 1; }
  log('DELETED_CONFIRMED: 照会 件数=0。進行記録を DELETE_SENT→REMOVED に確定。次は別runで setup-current（本操作では登録しない）');
  return 0;
}

async function setupCurrent(env, deps, c, log) {
  log('setup-current: 現在URLの登録のみ（setupWebhookは最大1回。deleteWebhookは呼ばない）');
  var m = await relayCall(c, { op: 'migGet' });
  if (!m.ok) { log('ABORT: 進行記録を確認できない ' + m.error + '（変更APIは呼ばない）'); return 1; }
  if (!m.mig || m.mig.phase !== 'REMOVED') {
    log('ABORT: 削除成功の証跡がない/進行済み phase=' + (m.mig ? m.mig.phase : 'NONE') + '（変更APIは呼ばない）');
    return 1;
  }
  if (typeof m.mig.atSec !== 'number' || deps.nowSec() - m.mig.atSec > EVIDENCE_MAX_AGE_SEC || deps.nowSec() < m.mig.atSec) {
    log('ABORT: 削除成功の証跡が古い/不正（変更APIは呼ばない）');
    return 1;
  }
  var q = await queryUrls(c);
  if (!q.ok) { log('ABORT: 登録直前の再照会が不明 ' + q.reason + '（変更APIは呼ばない）'); return 1; }
  if (q.urls.length !== 0) { log('ABORT: 登録直前に別設定が存在 件数=' + q.urls.length + '（変更APIは呼ばない）'); return 1; }

  var b = await relayCall(c, { op: 'migBeginSetup' });
  if (!b.ok) { log('ABORT: 送信済み記録を保存できない ' + b.error + '（変更APIは呼ばない）'); return 1; }

  var expected = webhookUrl(env);
  var r;
  try {
    r = await c.sb('post', '/v1.1/webhook/setupWebhook', { action: 'setupWebhook', url: expected, deviceList: 'ALL' });
  } catch (e) {
    log('UNKNOWN: setupWebhook の送信結果が不明。再送せず停止（照会と人手確認のみ）');
    return 1;
  }
  if (Core.classifyApiResponse(r.http, r.parsed).state === Core.STATE.FAILED) {
    log('FAILED: setupWebhook がAPIで失敗 http=' + r.http + '。再送・自動継続せず停止（照会と人手確認のみ）');
    return 1;
  }
  log('setupWebhook: 受理応答 http=' + r.http + '（受理だけでは成功としない。再照会で確認）');

  var after = await queryUrls(c);
  if (!after.ok) { log('UNKNOWN: 登録後の再照会が不明 ' + after.reason + '。再送せず停止'); return 1; }
  if (after.urls.length !== 1 || after.urls[0] !== expected) {
    log('UNKNOWN: 登録後の照会が MATCH でない 件数=' + after.urls.length + '。再送・削除・ロールバックせず停止');
    return 1;
  }
  var done = await relayCall(c, { op: 'migMarkDone' });
  if (!done.ok) { log('UNKNOWN: MATCH確認済みだが完了記録を保存できない ' + done.error); return 1; }
  log('setup-current: 再照会 件数=1 MATCH（設定一致のみの確認。Webhook到達性・createKey/deleteKeyの反映成功は未確認）');
  return 0;
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
      case 'webhook-query': return await webhookQuery(env, c, log);
      case 'remove-old': return await removeOld(env, deps, c, log);
      case 'replace-single-webhook-remove': return await replaceSingleWebhookRemove(env, deps, c, log);
      case 'recover-delete-sent': return await recoverDeleteSent(env, deps, c, log);
      case 'setup-current': return await setupCurrent(env, deps, c, log);
      case 'preflight': return await preflight(env, deps, c, log);
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

module.exports = { main: main, validateInputs: validateInputs, evaluateWebhookQuery: evaluateWebhookQuery, diagnoseWebhookUrl: diagnoseWebhookUrl, checkOldEvidence: checkOldEvidence, CONFIRM: CONFIRM };
