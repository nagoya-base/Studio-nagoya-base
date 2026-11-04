/**
 * 独立GAS（鍵管理基盤）エントリ — Issue #754 PR-B。
 *
 * 予約GAS・検証GAS（switchbot-verify）とは別プロジェクト。ロジックは SwitchBotAccessInfra / SwitchBotAccessCore に
 * あり、ここは GAS のサービス（PropertiesService / LockService / UrlFetchApp / MailApp / SpreadsheetApp / Session /
 * ScriptApp）を注入する薄いシェルのみ。コード・設定をマージしても、デプロイ・トリガー作成・Webhook登録・
 * 機能ON は行われない（それぞれ別の実施判断・別証跡）。
 *
 * ── 保存領域と実効権限（秘密と状態を分離）──
 *  Script Properties（プロジェクト編集者が閲覧可）… 設定 ACCESS_CONFIG（JSON・秘密なし）、ACCESS_ENABLED、
 *    ACCESS_ENVIRONMENT、LEDGER_SPREADSHEET_ID、ACCESS_ADMIN_ACTORS（メール→非個人情報ラベル）、状態（OP_/BK_/EVT_ …）
 *  User Properties（デプロイ実行者本人のみ）… SWITCHBOT_TOKEN / SWITCHBOT_SECRET / WEBHOOK_SHARED_TOKEN、
 *    パスコード（SECRET_*）。Web アプリ・時間主導トリガーは実行者として動くため読めるが、他の編集者は読めない。
 *  → 管理者の鍵操作（adminDelete 等）はデプロイ実行者のアカウントでのみ実行できる（SwitchBot資格情報を持つため）。
 *    管理者不在時の引継ぎは docs の手順（実行者の再設定）に従う。
 *
 * ── 環境分離 ──
 *  検証用と本番用は別の GAS プロジェクト・別の Script/User Properties。ACCESS_ENVIRONMENT と設定の environment が
 *  一致しない、または許可端末（末尾4桁）以外が対応表にある場合は起動しない。既存の switchbot-verify の Webhook は置換しない。
 */
var SBA_SECRET_NAMES_ = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'WEBHOOK_SHARED_TOKEN'];
var SBA_API_BASE_ = 'https://api.switch-bot.com';

function sba_scriptProps_() { return PropertiesService.getScriptProperties(); }
function sba_userProps_() { return PropertiesService.getUserProperties(); }

/** キャッシュを持たない Properties 参照（ロック取得後は常に最新を読む）。 */
function sba_storeOf_(props, prefixes) {
  return {
    get: function (k) { return props.getProperty(k); },
    set: function (k, v) { props.setProperty(k, v); },
    del: function (k) { props.deleteProperty(k); },
    keys: function () {
      return props.getKeys().filter(function (k) {
        return !prefixes || prefixes.some(function (p) { return k.indexOf(p) === 0; });
      });
    }
  };
}

/** 状態ストア: 設定・認証系プロパティ（ACCESS_*, LEDGER_*）を除く。 */
function sba_stateStore_() {
  var base = sba_storeOf_(sba_scriptProps_(), null);
  var reserved = /^(ACCESS_|LEDGER_)/;
  return {
    get: base.get, set: base.set, del: base.del,
    keys: function () { return base.keys().filter(function (k) { return !reserved.test(k); }); }
  };
}

/** 秘密ストア: User Properties 内の SECRET_ のみ（資格情報は別名で参照）。 */
function sba_secretStore_() {
  var base = sba_storeOf_(sba_userProps_(), null);
  return {
    get: base.get, set: base.set, del: base.del,
    keys: function () { return base.keys().filter(function (k) { return k.indexOf('SECRET_') === 0; }); }
  };
}

function sba_config_() {
  var raw = sba_scriptProps_().getProperty('ACCESS_CONFIG');
  var cfg = {};
  try { cfg = raw ? JSON.parse(raw) : {}; } catch (e) { cfg = {}; }
  // フラグは別プロパティ（'true' のときだけON）。設定JSONの enabled は無視する。
  cfg.enabled = sba_scriptProps_().getProperty('ACCESS_ENABLED') === 'true';
  // 環境名は二重に持つ（設定JSONと専用プロパティが一致しなければ起動しない）
  if (sba_scriptProps_().getProperty('ACCESS_ENVIRONMENT') !== cfg.environment) cfg.environment = '__MISMATCH__';
  return cfg;
}

function sba_hmacBase64_(secret, message) {
  return Utilities.base64Encode(Utilities.computeHmacSha256Signature(message, secret));
}

function sba_request_(method, path, body) {
  var u = sba_userProps_();
  var token = u.getProperty('SWITCHBOT_TOKEN');
  var secret = u.getProperty('SWITCHBOT_SECRET');
  if (!token || !secret) throw new Error('AUTH_CREDENTIALS_MISSING');
  var nonce = Utilities.getUuid();
  var t = String(Date.now());
  var headers = {
    Authorization: token, sign: String(sba_hmacBase64_(secret, token + t + nonce)).toUpperCase(),
    nonce: nonce, t: t, 'Content-Type': 'application/json; charset=utf8'
  };
  var options = { method: method, headers: headers, muteHttpExceptions: true };
  if (body) options.payload = JSON.stringify(body);
  var res = UrlFetchApp.fetch(SBA_API_BASE_ + path, options); // 通信断は throw（コアが UNKNOWN 扱い）
  var parsed = null;
  try { parsed = JSON.parse(res.getContentText()); } catch (e) { parsed = null; }
  return { httpCode: res.getResponseCode(), parsed: parsed };
}

function sba_api_() {
  return {
    listDevices: function () {
      var r;
      try { r = sba_request_('get', '/v1.1/devices'); } catch (e) { return { ok: false, error: 'LIST_COMM_ERROR' }; }
      var list = r.parsed && r.parsed.body && r.parsed.body.deviceList;
      if (r.httpCode !== 200 || !r.parsed || r.parsed.statusCode !== 100 || !Array.isArray(list)) return { ok: false, error: 'LIST_API_ERROR' };
      return { ok: true, devices: list };
    },
    createKey: function (p) {
      return sba_request_('post', '/v1.1/devices/' + p.deviceId + '/commands', {
        commandType: 'command', command: 'createKey',
        parameter: { name: p.name, type: 'timeLimit', password: p.password, startTime: String(p.startTime), endTime: String(p.endTime) }
      });
    },
    deleteKey: function (deviceId, id) {
      return sba_request_('post', '/v1.1/devices/' + deviceId + '/commands', {
        commandType: 'command', command: 'deleteKey', parameter: { id: id }
      });
    }
  };
}

function sba_ledger_() {
  return {
    read: function (ctx) {
      var id = sba_scriptProps_().getProperty('LEDGER_SPREADSHEET_ID');
      if (!id) return { ok: false, error: 'LEDGER_READ_FAILED' };
      try {
        var sheet = SpreadsheetApp.openById(id).getSheetByName(AccessLedgerReader.SHEET_NAME);
        if (!sheet) return { ok: false, error: 'LEDGER_SCHEMA_INVALID' };
        return AccessLedgerReader.readFromSheet(sheet, ctx.nowMs, ctx.trackedIds);
      } catch (e) {
        return { ok: false, error: 'LEDGER_READ_FAILED' };
      }
    }
  };
}

function sba_adminActors_() {
  var raw = sba_scriptProps_().getProperty('ACCESS_ADMIN_ACTORS');
  try { return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; }
}

function sba_runtime_() {
  var cfg = sba_config_();
  return SwitchBotAccessInfra.createRuntime({
    store: sba_stateStore_(), secrets: sba_secretStore_(), lockService: LockService.getScriptLock(),
    api: sba_api_(), ledger: sba_ledger_(), snapshot: AccessKeySnapshot,
    sendMail: function (subject, body) { MailApp.sendEmail(cfg.adminMailTo.join(','), subject, body); },
    sha256Hex: function (s) {
      return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
        .map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
    },
    randomInt: function (n) { return Math.floor(Math.random() * n); },
    nowSec: function () { return Math.floor(Date.now() / 1000); },
    nowMs: function () { return Date.now(); },
    identity: function () { return { email: Session.getActiveUser().getEmail() }; },
    adminActors: sba_adminActors_(),
    deliverCode: null // #752 の配送を接続するまで未設定（OFF/未接続では配送しない）
  }, cfg);
}

// ── Web アプリ（SwitchBot Webhook の常設受信先）──
// 応答は固定 {"ok":true|false} のみ。ペイロード・理由・設定は返さない。認証前は何も保存しない。
function doPost(e) {
  var ok = false;
  try {
    var token = e && e.parameter ? e.parameter.t : '';
    var raw = e && e.postData ? e.postData.contents : '';
    var res = sba_runtime_().handleWebhook(raw, token, sba_userProps_().getProperty('WEBHOOK_SHARED_TOKEN'));
    ok = res && res.accepted === true;
  } catch (err) { ok = false; }
  return ContentService.createTextOutput(JSON.stringify({ ok: ok })).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

// ── 時間主導トリガー（accessInstallTriggers で作成）──
function accessSyncJob() { return sba_runtime_().syncCycle(); }
function accessDeliverJob() { return sba_runtime_().deliverCycle(); }
function accessSweepJob() { return sba_runtime_().sweepCycle(); }
function accessWatchdogJob() { return sba_runtime_().watchdog(); }

var SBA_JOBS_ = ['accessSyncJob', 'accessDeliverJob', 'accessSweepJob', 'accessWatchdogJob'];

function sba_requireAdmin_() {
  var who = SwitchBotAccessInfra.authorizeAdmin({ email: Session.getActiveUser().getEmail() }, sba_adminActors_());
  if (!who.ok) throw new Error('NOT_AUTHORIZED');
  return who.actor;
}

/** 管理者のみ。トリガーを作り直す（既存の同名トリガーは削除）。デプロイ後の実施判断・日時・版は別証跡に記録する。 */
function accessInstallTriggers() {
  var actor = sba_requireAdmin_();
  accessRemoveTriggers_();
  var cfg = sba_config_();
  var plan = SwitchBotAccessInfra.planJobs(cfg);
  ScriptApp.newTrigger('accessSyncJob').timeBased().everyMinutes(Math.max(1, Math.round(plan.syncIntervalSec / 60))).create();
  ScriptApp.newTrigger('accessSweepJob').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('accessWatchdogJob').timeBased().everyMinutes(15).create();
  if (cfg.deliveryConfigured === true) ScriptApp.newTrigger('accessDeliverJob').timeBased().everyMinutes(5).create();
  Logger.log('triggers installed by ' + actor);
  return { ok: true };
}

function accessRemoveTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (SBA_JOBS_.indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
}

/** 管理者のみ。撤去: トリガーを止める（状態は削除しない）。 */
function accessRemoveTriggers() {
  sba_requireAdmin_();
  accessRemoveTriggers_();
  return { ok: true };
}

// ── 管理者復旧（フラグOFFでも使える。認可はサーバー側で確定。actor 引数は受け付けない）──
function accessAdminStatus() { return sba_runtime_().admin('status', {}); }
function accessAdminInventory() { return sba_runtime_().admin('inventory', {}); }
function accessAdminInspect(recId) { return sba_runtime_().admin('inspect', { recId: recId }); }
function accessAdminReconcile(recId) { return sba_runtime_().admin('reconcile', { recId: recId }); }
function accessAdminResolveUnknown(recId, decision) { return sba_runtime_().admin('resolveUnknown', { recId: recId, decision: decision }); }
function accessAdminDelete(recId) { return sba_runtime_().admin('delete', { recId: recId }); }

// ── 資格情報の初期登録（Issue #770。実行者本人の User Properties へ、ローカルから Execution API 経由）──
// 呼び出し元は scripts.run（API実行可能Deployment。アクセスは「自分のみ」。運営者が明示的に作成する別Deployment）のみ。Web アプリ（doPost/doGet）・トリガー・
// Webhook からは到達しない。値は呼び出し元がHTTPS本文で渡し、戻り値・Logger・例外には出さない（固定コードと SET/MISSING のみ）。
// Script Properties・トリガー・Webhook登録・端末APIには触れない。ローカル側: scripts/switchbot-access-setup-credentials.js
// 手順と根拠: docs/switchbot-access-credentials-770.md
// req = { mode: 'init'|'replace', dryRun: boolean, values: { SWITCHBOT_TOKEN, SWITCHBOT_SECRET, WEBHOOK_SHARED_TOKEN, __CONFIRM_REPLACE__ } }
function accessSetupCredentialsApi(req) {
  var res;
  try {
    var values = req && req.values && typeof req.values === 'object' ? req.values : {};
    res = SwitchBotAccessInfra.setupCredentials({
      userProps: sba_storeOf_(sba_userProps_(), null),
      adminActors: sba_adminActors_(),
      identity: function () {
        return { email: Session.getActiveUser().getEmail(), effectiveEmail: Session.getEffectiveUser().getEmail() };
      },
      prompt: function (name) { return typeof values[name] === 'string' ? values[name] : null; },
      lock: LockService.getScriptLock()
    }, { mode: req && req.mode === 'replace' ? 'replace' : 'init', dryRun: !!(req && req.dryRun === true) });
  } catch (e) {
    res = { ok: false, code: 'UNEXPECTED_ERROR', status: {}, changed: [] };
  }
  var out = { ok: res.ok === true, code: String(res.code), status: res.status || {}, changed: res.changed || [] };
  if (res.invalid) out.invalid = res.invalid;
  Logger.log(JSON.stringify(out));
  return out;
}

/** 認可と SET/MISSING のみを返す状態確認（入力を要求せず、何も保存しない）。CLI の --dry-run と登録前の確認に使う。 */
function accessCredentialStatusApi() {
  var out;
  try {
    out = SwitchBotAccessInfra.credentialStatus({
      userProps: sba_storeOf_(sba_userProps_(), null),
      adminActors: sba_adminActors_(),
      identity: function () {
        return { email: Session.getActiveUser().getEmail(), effectiveEmail: Session.getEffectiveUser().getEmail() };
      }
    });
  } catch (e) {
    out = { ok: false, code: 'UNEXPECTED_ERROR', status: {}, changed: [] };
  }
  Logger.log(JSON.stringify(out));
  return out;
}

/** 事前チェック: 必要な設定の有無のみ表示（値・完全IDは出さない）。 */
function accessCheckSetup() {
  var s = sba_scriptProps_(), u = sba_userProps_();
  var status = {};
  ['ACCESS_CONFIG', 'ACCESS_ENVIRONMENT', 'LEDGER_SPREADSHEET_ID', 'ACCESS_ADMIN_ACTORS'].forEach(function (n) { status[n] = s.getProperty(n) ? 'SET' : 'MISSING'; });
  SBA_SECRET_NAMES_.forEach(function (n) { status[n] = u.getProperty(n) ? 'SET' : 'MISSING'; });
  status.ACCESS_ENABLED = s.getProperty('ACCESS_ENABLED') === 'true' ? 'ON' : 'OFF';
  var v = SwitchBotAccessInfra.validateConfig(sba_config_());
  status.config = v.ok ? 'VALID' : v.errors;
  Logger.log(JSON.stringify(status));
  return status;
}
