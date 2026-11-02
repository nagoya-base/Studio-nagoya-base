/**
 * SwitchBot Open API 期間限定パスコード検証ランナー（Issue #713）。
 *
 * 技術検証専用。予約・決済・既存本番コードには触れない独立 GAS プロジェクト。
 * 手動実行（エディタから関数を選んで実行）のみ。トリガーは作らない。
 *
 * Script Properties（ソース・ログに出さない）:
 *   SWITCHBOT_TOKEN, SWITCHBOT_SECRET   … Open API v1.1 認証情報
 *   SWITCHBOT_DEVICE_ID                 … 対象キーパッド（verifyListDevices で特定後に設定）
 *   WEBHOOK_SHARED_TOKEN                … Webhook URL 用の共有トークン（推測困難な値）
 * 実行状態（自動管理）:
 *   PENDING_<commandId> / EVENT_<commandId> / STATE_LAST_*
 */
var SBV_PROP = PropertiesService.getScriptProperties();

function sbvLog_(label, obj) {
  Logger.log(label + ' ' + JSON.stringify(SwitchBotVerifyCore.redact(obj)));
}

function sbvHmac_(secret, message) {
  var bytes = Utilities.computeHmacSha256Signature(message, secret);
  return Utilities.base64Encode(bytes);
}

function sbvRequest_(method, path, body, overrides) {
  overrides = overrides || {};
  var token = overrides.token !== undefined ? overrides.token : SBV_PROP.getProperty('SWITCHBOT_TOKEN');
  var secret = overrides.secret !== undefined ? overrides.secret : SBV_PROP.getProperty('SWITCHBOT_SECRET');
  var headers = SwitchBotVerifyCore.buildAuthHeaders(token, secret, Utilities.getUuid(), Date.now(), sbvHmac_);
  var options = { method: method, headers: headers, muteHttpExceptions: true };
  if (body) options.payload = JSON.stringify(body);
  var res = UrlFetchApp.fetch(SwitchBotVerifyCore.API_BASE + path, options);
  var parsed = null;
  try { parsed = JSON.parse(res.getContentText()); } catch (e) { parsed = null; }
  return { http: res.getResponseCode(), parsed: parsed };
}

/** 1) 接続確認: デバイス一覧からキーパッドのみを表示（ID は下4桁マスク）。 */
function verifyListDevices() {
  var r = sbvRequest_('get', '/v1.1/devices');
  var cls = SwitchBotVerifyCore.classifyApiResponse(r.http, r.parsed);
  if (cls.state === SwitchBotVerifyCore.STATE.FAILED) {
    sbvLog_('devices FAILED', cls);
    return cls;
  }
  var keypads = SwitchBotVerifyCore.pickKeypads(r.parsed.body && r.parsed.body.deviceList);
  sbvLog_('keypads', keypads.map(function (d) {
    return { deviceId: d.deviceId, deviceType: d.deviceType, deviceName: d.deviceName };
  }));
  Logger.log('keypad count = ' + keypads.length +
    '（対象を SWITCHBOT_DEVICE_ID に設定。末尾4桁で照合: ' +
    keypads.map(function (d) { return SwitchBotVerifyCore.maskId(d.deviceId); }).join(', ') + '）');
  return { count: keypads.length };
}

/** Webhook 受信先の登録。事前に WEBHOOK_SHARED_TOKEN と Web アプリ URL(/exec) を用意する。 */
function verifySetupWebhook(execUrl) {
  var shared = SBV_PROP.getProperty('WEBHOOK_SHARED_TOKEN');
  if (!execUrl || !shared) throw new Error('execUrl と WEBHOOK_SHARED_TOKEN が必要');
  var url = execUrl + (execUrl.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(shared);
  var r = sbvRequest_('post', '/v1.1/webhook/setupWebhook',
    { action: 'setupWebhook', url: url, deviceList: 'ALL' });
  var cls = SwitchBotVerifyCore.classifyApiResponse(r.http, r.parsed);
  sbvLog_('setupWebhook', cls);
  return cls;
}

/** Webhook 受信。結果を commandId 単位で保存する（ペイロード全体は保存・出力しない）。 */
function doPost(e) {
  var ok = SwitchBotVerifyCore.isWebhookAuthorized(
    e && e.parameter && e.parameter.t, SBV_PROP.getProperty('WEBHOOK_SHARED_TOKEN'));
  if (!ok) return ContentService.createTextOutput('forbidden');
  var payload = null;
  try { payload = JSON.parse(e.postData.contents); } catch (err) { payload = null; }
  var ev = SwitchBotVerifyCore.parseKeypadWebhook(payload);
  if (ev && ev.commandId) {
    SBV_PROP.setProperty('EVENT_' + ev.commandId, JSON.stringify(ev));
  }
  return ContentService.createTextOutput('ok');
}

function sbvAwaitState_(commandId, timeoutSec) {
  var started = Math.floor(Date.now() / 1000);
  while (true) {
    var now = Math.floor(Date.now() / 1000);
    var raw = SBV_PROP.getProperty('EVENT_' + commandId);
    var webhook = raw ? JSON.parse(raw) : null;
    var state = SwitchBotVerifyCore.resolveCommandState({ acceptedAtSec: started }, webhook, now);
    if (state !== SwitchBotVerifyCore.STATE.ACCEPTED_PENDING) return state;
    if (now - started > timeoutSec) return SwitchBotVerifyCore.STATE.UNKNOWN;
    Utilities.sleep(3000);
  }
}

/**
 * 2) 期間限定パスコード作成（1件）。
 * startOffsetMin 分後に有効化、durationMin 分間有効。パスコード平文はログに出さず、
 * Script Properties の TEST_PASSWORD にのみ保存（検証後 verifyCleanupLocal で消す）。
 */
function verifyCreateTimeLimitKey(startOffsetMin, durationMin) {
  var deviceId = SBV_PROP.getProperty('SWITCHBOT_DEVICE_ID');
  if (!deviceId) throw new Error('SWITCHBOT_DEVICE_ID 未設定（verifyListDevices で特定）');
  var nowSec = Math.floor(Date.now() / 1000);
  var start = nowSec + (startOffsetMin || 5) * 60;
  var end = start + (durationMin || 15) * 60;
  var params = {
    name: SwitchBotVerifyCore.buildTestName(nowSec),
    password: SwitchBotVerifyCore.generateTestPassword(function (n) { return Math.floor(Math.random() * n); }, 8),
    startTime: start,
    endTime: end
  };
  var errs = SwitchBotVerifyCore.validateCreateKeyParams(params, nowSec);
  if (errs.length) throw new Error('INVALID_PARAMS: ' + errs.join(','));

  var r = sbvRequest_('post', '/v1.1/devices/' + deviceId + '/commands',
    SwitchBotVerifyCore.buildCreateKeyBody(params));
  var cls = SwitchBotVerifyCore.classifyApiResponse(r.http, r.parsed);
  var ids = SwitchBotVerifyCore.extractIdsFromResponse(r.parsed);
  sbvLog_('createKey api', { state: cls.state, statusCode: cls.statusCode, commandId: ids.commandId, hasPasscodeId: ids.passcodeId !== null });
  if (cls.state === SwitchBotVerifyCore.STATE.FAILED) return cls;

  SBV_PROP.setProperties({
    TEST_PASSWORD: params.password,
    TEST_NAME: params.name,
    TEST_START_SEC: String(start),
    TEST_END_SEC: String(end),
    TEST_PASSCODE_ID: ids.passcodeId === null ? '' : String(ids.passcodeId),
    TEST_CREATE_COMMAND_ID: ids.commandId || ''
  });
  var state = ids.commandId ? sbvAwaitState_(ids.commandId, SwitchBotVerifyCore.WEBHOOK_WAIT_SEC) : SwitchBotVerifyCore.STATE.UNKNOWN;
  sbvLog_('createKey result', {
    state: state,
    startJst: Utilities.formatDate(new Date(start * 1000), 'Asia/Tokyo', 'HH:mm:ss'),
    endJst: Utilities.formatDate(new Date(end * 1000), 'Asia/Tokyo', 'HH:mm:ss'),
    passcodeIdKnown: !!SBV_PROP.getProperty('TEST_PASSCODE_ID')
  });
  Logger.log('テストコードは Script Properties の TEST_PASSWORD を参照（ログ・Issueには書かない）');
  return { state: state };
}

/** 4) 削除。passcode ID は応答から取れた場合 TEST_PASSCODE_ID、取れなければ引数で渡す（実機アプリで確認）。 */
function verifyDeleteKey(passcodeIdOverride) {
  var deviceId = SBV_PROP.getProperty('SWITCHBOT_DEVICE_ID');
  var id = passcodeIdOverride || SBV_PROP.getProperty('TEST_PASSCODE_ID');
  var r = sbvRequest_('post', '/v1.1/devices/' + deviceId + '/commands',
    SwitchBotVerifyCore.buildDeleteKeyBody(id));
  var cls = SwitchBotVerifyCore.classifyApiResponse(r.http, r.parsed);
  var ids = SwitchBotVerifyCore.extractIdsFromResponse(r.parsed);
  sbvLog_('deleteKey api', { state: cls.state, statusCode: cls.statusCode, commandId: ids.commandId });
  if (cls.state === SwitchBotVerifyCore.STATE.FAILED) return cls;
  var state = ids.commandId ? sbvAwaitState_(ids.commandId, SwitchBotVerifyCore.WEBHOOK_WAIT_SEC) : SwitchBotVerifyCore.STATE.UNKNOWN;
  sbvLog_('deleteKey result', { state: state });
  return { state: state };
}

/** 5) 異常系。いずれも「成功扱いにならないこと」を確認する（期待値: FAILED もしくは Webhook failed）。 */
function verifyAbnormalCases() {
  var C = SwitchBotVerifyCore;
  var nowSec = Math.floor(Date.now() / 1000);
  var results = {};

  // 不正な認証情報
  var bad = sbvRequest_('get', '/v1.1/devices', null, { token: 'invalid-token', secret: 'invalid-secret' });
  results.invalidCredentials = C.classifyApiResponse(bad.http, bad.parsed).state;

  // 不正な deviceId
  var badDev = sbvRequest_('post', '/v1.1/devices/INVALID0000/commands',
    C.buildDeleteKeyBody(1));
  results.invalidDeviceId = C.classifyApiResponse(badDev.http, badDev.parsed).state;

  // start >= end（送信前検証で拒否されること）
  results.startNotBeforeEnd = C.validateCreateKeyParams(
    { name: 'x', password: '12345678', startTime: nowSec + 600, endTime: nowSec + 600 }, nowSec
  ).indexOf('START_NOT_BEFORE_END') !== -1 ? 'REJECTED_LOCALLY' : 'NOT_REJECTED';

  // 重複 name は実機で作成済みテスト名を使って再 createKey し、Webhook failed を確認（手動）
  results.duplicateName = 'MANUAL: 作成済み TEST_NAME で再度 createKey し Webhook result を確認';
  results.apiAcceptedIsNotApplied = C.classifyApiResponse(200, { statusCode: 100 }).state; // ACCEPTED_PENDING であること
  sbvLog_('abnormal', results);
  return results;
}

/** 検証後のローカル秘密情報の掃除（テストコード・状態）。Token/Secret は残す。 */
function verifyCleanupLocal() {
  var keep = { SWITCHBOT_TOKEN: 1, SWITCHBOT_SECRET: 1, SWITCHBOT_DEVICE_ID: 1, WEBHOOK_SHARED_TOKEN: 1 };
  var all = SBV_PROP.getKeys();
  all.forEach(function (k) { if (!keep[k]) SBV_PROP.deleteProperty(k); });
  Logger.log('cleanup done: removed ' + all.filter(function (k) { return !keep[k]; }).length + ' keys');
}
