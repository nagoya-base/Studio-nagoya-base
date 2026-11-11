/**
 * 独立GAS（鍵管理基盤）エントリ — Issue #754 PR-B。
 *
 * 予約GAS・検証GAS（switchbot-verify）とは別プロジェクト。ロジックは SwitchBotAccessInfra / SwitchBotAccessCore に
 * あり、ここは GAS のサービス（PropertiesService / LockService / UrlFetchApp / MailApp / Sheets API(UrlFetchApp) / Session /
 * ScriptApp）を注入する薄いシェルのみ。コード・設定をマージしても、デプロイ・トリガー作成・Webhook登録・
 * 機能ON は行われない（それぞれ別の実施判断・別証跡）。
 *
 * ── 保存領域と実効権限（秘密と状態を分離）──
 *  Script Properties（プロジェクト編集者が閲覧可）… 設定 ACCESS_CONFIG（JSON・秘密なし）または分割設定（ACCESS_CONFIG_FORMAT=split-v1。
 *    #859。どちらか一方だけが正本）、ACCESS_ENABLED、
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
  var reserved = /^(ACCESS_|LEDGER_|BOOTSTRAP_)/;
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

/**
 * 設定の読込（Issue #859）。正本は ACCESS_CONFIG_FORMAT で一箇所に決まる: 未設定=旧 ACCESS_CONFIG（JSON）、
 * 'split-v1'=分割プロパティ（ACCESS_ELIGIBLE_BRANDS 等）。旧・新の暗黙マージはしない（混在は CONFIG_SOURCE_MIXED で起動拒否）。
 * フラグは別プロパティ ACCESS_ENABLED（'true' のときだけON。設定JSONの enabled は無視）。読込エラー時は enabled=false。
 * 環境名は二重に持つ（設定の environment と ACCESS_ENVIRONMENT が一致しなければ起動しない）。
 */
function sba_config_() {
  var sp = sba_scriptProps_();
  return SwitchBotAccessInfra.loadConfig(function (k) { return sp.getProperty(k); }).cfg;
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

/**
 * 台帳シートを開く唯一の入口（Issue #776）。本番照合（sba_ledger_）と読取専用診断（sba_ledgerInspect_）が共有する。
 * SpreadsheetApp.openById は承認スコープが spreadsheets（書込み可）のみで、宣言している spreadsheets.readonly では
 * 呼べない。そのため Sheets API v4 の GET（values.get / values:batchGet）を ScriptApp.getOAuthToken() で呼ぶ。
 * 例外は呼出側で AccessLedgerReader.classifyError により固定コードへ分類する（本文は保持しない）。
 */
function sba_openLedgerSheet_(id) {
  return AccessLedgerReader.openApiSheet({
    spreadsheetId: id,
    fetch: function (url, options) { return UrlFetchApp.fetch(url, options); },
    getToken: function () { return ScriptApp.getOAuthToken(); },
    tzOffsetMs: function (tz, ms) {
      try {
        var m = /^([+-])(\d{2})(\d{2})$/.exec(Utilities.formatDate(new Date(ms), tz, 'Z'));
        if (!m) return null;
        return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60000;
      } catch (e) {
        return null;
      }
    }
  });
}

function sba_ledger_() {
  return {
    read: function (ctx) {
      var id = sba_scriptProps_().getProperty('LEDGER_SPREADSHEET_ID');
      if (!id) return { ok: false, error: 'LEDGER_READ_FAILED' };
      try {
        var sheet = sba_openLedgerSheet_(id);
        if (!sheet) return { ok: false, error: 'LEDGER_SCHEMA_INVALID' };
        return AccessLedgerReader.readFromSheet(sheet, ctx.nowMs, ctx.trackedIds);
      } catch (e) {
        return { ok: false, error: AccessLedgerReader.classifyError(e) };
      }
    }
  };
}

/**
 * 配送（Issue #752）: 暗証番号案内メールの宛先を、送信直前に台帳から1件だけ読む。
 * 特定できない（0件・複数件・列欠落・不正形式）ときは { ok:false }。メールアドレスは保存・ログしない。
 */
function sba_resolveRecipient_(bookingRef) {
  var id = sba_scriptProps_().getProperty('LEDGER_SPREADSHEET_ID');
  if (!id) return { ok: false };
  try {
    var sheet = sba_openLedgerSheet_(id);
    if (!sheet) return { ok: false };
    var r = AccessLedgerReader.readRecipient(sheet, bookingRef);
    return r && r.ok === true ? { ok: true, to: r.to } : { ok: false };
  } catch (e) {
    return { ok: false };
  }
}

/**
 * 配送（Issue #752）: 利用者宛の暗証番号案内メール。管理者通知の sendMail とは別物（混同しない）。
 * 日次送信枠が尽きているときは「送信していない」と確定できるので notSent として投げる。
 * それ以外の MailApp の例外は、相手に届いたか不明なため notSent を付けない（コアが UNKNOWN にし、自動再送しない）。
 */
function sba_sendUserMail_(m) {
  var quota = MailApp.getRemainingDailyQuota();
  if (!(quota >= 1)) {
    var e = new Error('DELIVER_FAILED');
    e.notSent = true;
    e.alertCode = 'DELIVER_FAILED';
    throw e;
  }
  var opt = { to: m.to, subject: m.subject, body: m.body, name: m.name };
  if (m.replyTo) opt.replyTo = m.replyTo; else opt.noReply = true;
  MailApp.sendEmail(opt);
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
    // 同期実行内の短時間確認（#893）で使う待機。infra.inRunConfirmMaxSec が 0（既定）の間は呼ばれない。
    sleep: function (ms) { Utilities.sleep(ms); },
    identity: function () { return { email: Session.getActiveUser().getEmail() }; },
    adminActors: sba_adminActors_(),
    // 配送（#752）の手段。cfg.deliveryConfigured が運営承認までtrueにならない限り、この2つは呼ばれない
    // （accessDeliverJob のトリガーも作られない）。コード・設定をマージしても、実利用者へのメール送信は起きない。
    sendUserMail: sba_sendUserMail_,
    resolveRecipient: sba_resolveRecipient_
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
// 期限切れ予約用キーの日次回収（00:15 JST 近辺。厳密な着火時刻には依存しない。Issue #829）
function accessDailyCleanupJob() { return sba_runtime_().dailyCleanupCycle(); }

var SBA_JOBS_ = ['accessSyncJob', 'accessDeliverJob', 'accessSweepJob', 'accessWatchdogJob', 'accessDailyCleanupJob'];

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
  ScriptApp.newTrigger('accessDailyCleanupJob').timeBased().atHour(0).nearMinute(15).everyDays(1).inTimezone('Asia/Tokyo').create();
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
// GASエディタ実行では戻り値が実行ログに出ないため、許可フィールドだけの短いJSONをログに出す（#822）。戻り値・API契約は従来どおり。
function accessAdminStatus() {
  var r;
  try { r = sba_runtime_().admin('status', {}); } catch (e) { sba_logStatus_({ ok: false, error: 'EXCEPTION' }); throw e; }
  sba_logStatus_(r);
  return r;
}
function sba_logStatus_(r) {
  var out;
  try {
    var code = function (v, d) { return typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(v) ? v : d; };
    var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : null; };
    if (!r || r.ok !== true) {
      out = { ok: false, error: code(r && r.error, 'ERROR') };
    } else {
      out = { ok: true, environment: typeof r.environment === 'string' && /^[a-z0-9_-]{1,20}$/.test(r.environment) ? r.environment : null, enabled: r.enabled === true, unresolved: num(r.unresolved) };
      var hb = {};
      ['SYNC', 'SWEEP', 'CLEANUP', 'DELIVER'].forEach(function (j) {
        var at = r.heartbeats && r.heartbeats[j] && num(r.heartbeats[j].at);
        hb[j] = at ? new Date(at * 1000).toISOString() : null;
      });
      out.heartbeatAt = hb;
      out.notifyOutboxPending = num(r.notifyOutbox && r.notifyOutbox.pending);
      var dl = {};
      Object.keys(r.deliveries || {}).forEach(function (k) { var c = code(k, null); var n = num(r.deliveries[k]); if (c && n !== null) dl[c] = n; });
      out.deliveries = dl;
      try { out.triggers = ScriptApp.getProjectTriggers().filter(function (t) { return SBA_JOBS_.indexOf(t.getHandlerFunction()) !== -1; }).length; } catch (e2) { /* 取得できる場合のみ */ }
    }
  } catch (e) { out = { ok: false, error: 'LOG_FAILED' }; }
  Logger.log('accessAdminStatus ' + JSON.stringify(out));
}
function accessAdminInventory() { return sba_runtime_().admin('inventory', {}); }

// ── 棚卸しの安全な集計診断（#857。Access ON のまま実行可。読み取り専用）──
// 既存 accessAdminInventory() の戻り値・権限・呼出元は変えない。こちらは既存の admin('inventory') の読取結果だけを
// 件数に集計し、許可リスト方式で組み立てた1行JSONを実行ログに出す（そのまま相談に貼れる形）。
// 出さないもの: record ID・予約ID・端末ID・終了時刻等の個別値・生inventory・例外内容。未知値は OTHER、失敗は固定コード。
// 新規のSwitchBot API呼出し・sync/deliver/reconcile/delete・設定書換え・トリガー更新は行わない
// （既存の管理者経路と同じく、ロック取得の記録 HB_ADMIN/LOCKFAIL のみ更新される）。
// 切り分けの限界: total=0 は「発行管理記録が無い」ことまでしか示さない。予約が候補外・許可リスト不一致・
// ブランド/施設/部屋不一致・支払い未承認・失効/取消のどれかは本関数では断定できない（別PRで集約理由を追加する方針）。
var SBA_INV_SUMMARY_MAX_ = 5000;
var SBA_INV_ISSUING_ = ['PLANNED', 'SENDING', 'SENT_WAIT_WEBHOOK', 'ACCEPTED_NO_COMMAND_ID'];
var SBA_INV_REVOKING_ = ['EXPIRED', 'DELETE_PENDING', 'DELETE_SENDING', 'DELETE_SENT'];
var SBA_INV_ENDED_ = ['DELETED_CONFIRMED', 'ALREADY_ABSENT', 'ARCHIVED_EXPIRED', 'ABANDONED'];

function accessAdminInventorySummary() {
  var out;
  try {
    sba_requireAdmin_();
    out = sba_summarizeInventory_(sba_runtime_().admin('inventory', {}));
  } catch (e) {
    out = { ok: false, error: e && e.message === 'NOT_AUTHORIZED' ? 'NOT_AUTHORIZED' : 'EXCEPTION' };
  }
  var line;
  try { line = JSON.stringify(out); } catch (e2) { out = { ok: false, error: 'LOG_FAILED' }; line = JSON.stringify(out); }
  Logger.log('accessAdminInventorySummary ' + line);
  return out;
}

/** inventory の読取結果 → 件数だけの要約（純関数。入力のどの値もそのままは出さない）。 */
function sba_summarizeInventory_(r) {
  var CODE_RE = /^[A-Z][A-Z0-9_]{0,39}$/;
  if (!r || typeof r !== 'object' || r.ok !== true) {
    return { ok: false, error: r && typeof r.error === 'string' && CODE_RE.test(r.error) ? r.error : 'ERROR' };
  }
  if (!Array.isArray(r.items)) return { ok: false, error: 'INVENTORY_INVALID' };
  var C = SwitchBotAccessCore;
  var states = Object.keys(C.STATE).map(function (k) { return C.STATE[k]; });
  var dlvs = Object.keys(C.DLV).map(function (k) { return C.DLV[k]; });
  var inc = function (o, k) { o[k] = (o[k] || 0) + 1; };
  var byState = {}, byDelivery = {}, stages = {}, invalid = 0, unresolved = 0;
  var n = Math.min(r.items.length, SBA_INV_SUMMARY_MAX_);
  for (var i = 0; i < n; i++) {
    var it = r.items[i];
    if (!it || typeof it !== 'object' || typeof it.state !== 'string') { invalid++; continue; }
    var st = states.indexOf(it.state) !== -1 ? it.state : 'OTHER';
    var dl = it.delivery === null || it.delivery === undefined ? 'NONE' : (dlvs.indexOf(it.delivery) !== -1 ? it.delivery : 'OTHER');
    inc(byState, st); inc(byDelivery, dl);
    if (it.unresolved === true) unresolved++;
    inc(stages, sba_inventoryStage_(st, dl));
  }
  var environment = null;
  try { var env = sba_config_().environment; if (typeof env === 'string' && /^[a-z0-9_-]{1,20}$/.test(env)) environment = env; } catch (e) { /* 出さない */ }
  return {
    ok: true, environment: environment, scope: 'INVENTORY_ONLY',
    diagnosis: r.items.length === 0 ? 'NO_RECORDS' : 'HAS_RECORDS',
    total: r.items.length, scanned: n, truncated: r.items.length > n, invalid: invalid, unresolved: unresolved,
    byState: byState, byDelivery: byDelivery, stages: stages
  };
}

/** 発行状態×配送状態 → 「どこで止まっているか」の固定コード。確認できない状態は成功（DELIVERED）に寄せない。 */
function sba_inventoryStage_(st, dl) {
  if (SBA_INV_ISSUING_.indexOf(st) !== -1) return 'ISSUE_IN_PROGRESS';
  if (st === 'UNKNOWN') return 'STATE_UNKNOWN'; // 発行・削除のどちらの失敗でも UNKNOWN になる（inventory では区別できない）
  if (st === 'FAILED') return 'ISSUE_FAILED';
  if (st === 'ISSUED_CONFIRMED') {
    if (dl === 'NONE') return 'ISSUED_NO_DELIVERY_RECORD';
    if (dl === 'DELIVERED') return 'ISSUED_DELIVERED';
    if (dl === 'UNKNOWN') return 'ISSUED_DELIVERY_UNKNOWN';
    if (dl === 'SUPPRESSED') return 'ISSUED_DELIVERY_SUPPRESSED';
    if (dl === 'SENDING' || dl === 'NOT_SENT') return 'ISSUED_DELIVERY_PENDING';
    return 'OTHER';
  }
  if (SBA_INV_REVOKING_.indexOf(st) !== -1) return 'REVOKE_IN_PROGRESS';
  if (SBA_INV_ENDED_.indexOf(st) !== -1) return 'ENDED';
  return 'OTHER';
}
function accessAdminInspect(recId) { return sba_runtime_().admin('inspect', { recId: recId }); }
function accessAdminReconcile(recId) { return sba_runtime_().admin('reconcile', { recId: recId }); }
function accessAdminResolveUnknown(recId, decision) { return sba_runtime_().admin('resolveUnknown', { recId: recId, decision: decision }); }
function accessAdminDelete(recId) { return sba_runtime_().admin('delete', { recId: recId }); }
// 配送の結果不明・未着の管理者判断（#752。メールは送らない。再送は次回の配送ジョブが全ゲートを通して行う）。
// decision: CONFIRM_DELIVERED / ALLOW_RESEND / REGUIDE / GIVE_UP
function accessAdminResolveDelivery(recId, decision) { return sba_runtime_().admin('resolveDelivery', { recId: recId, decision: decision }); }

// ── 資格情報の初期登録（Issue #770。【#772以降の標準手順ではない。通常は下の accessMigrateCredentialsOnce を使う】実行者本人の User Properties へ、ローカルから Execution API 経由）──
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

// ── 資格情報のワンショット移行（Issue #772。標準の初期登録手順）──
// 追加のGCP/OAuth/API executable Deployment/CLI は不要。設定画面で Script Properties に一時キー3件
// （BOOTSTRAP_SWITCHBOT_TOKEN / BOOTSTRAP_SWITCHBOT_SECRET / BOOTSTRAP_WEBHOOK_SHARED_TOKEN）を登録 → エディタから
// accessMigrateCredentialsOnce を手動で1回実行 → User Properties へ移し、一時キーを削除する。
// 値は戻り値・Logger・例外に出さない（固定コードと SET/MISSING/ABSENT のみ）。Web アプリ・トリガーからは呼ばれない。
// 実行前の確認（編集者が本人のみ・ACCESS_ENABLED=OFF）と限界: docs/switchbot-access-bootstrap-772.md
function sba_bootstrapDeps_() {
  return {
    scriptProps: sba_storeOf_(sba_scriptProps_(), null),
    userProps: sba_storeOf_(sba_userProps_(), null),
    accessFlag: function () { return sba_scriptProps_().getProperty('ACCESS_ENABLED'); }, // ACCESS_ENABLED が OFF でなければ移行しない
    adminActors: sba_adminActors_(),
    identity: function () {
      return { email: Session.getActiveUser().getEmail(), effectiveEmail: Session.getEffectiveUser().getEmail() };
    },
    lock: LockService.getScriptLock()
  };
}

function sba_bootstrapRun_(fn) {
  var out;
  try {
    var res = fn(sba_bootstrapDeps_());
    out = { ok: res.ok === true, code: String(res.code), status: res.status || {}, bootstrap: res.bootstrap || {}, changed: res.changed || [] };
    if (res.invalid) out.invalid = res.invalid;
    if (res.cleanup) out.cleanup = res.cleanup;
  } catch (e) {
    out = { ok: false, code: 'UNEXPECTED_ERROR', status: {}, bootstrap: {}, changed: [] };
  }
  try { out.accessEnabled = SwitchBotAccessInfra.accessFlagState(sba_bootstrapDeps_()); } catch (e) { out.accessEnabled = 'UNKNOWN'; }
  Logger.log(JSON.stringify(out));
  return out;
}

/** 手動で1回だけ実行。User Properties が1件でも SET なら上書きしない。失敗時も一時キーは可能な限り削除する。 */
function accessMigrateCredentialsOnce() {
  return sba_bootstrapRun_(function (d) { return SwitchBotAccessInfra.migrateBootstrapCredentials(d); });
}

/** 読取専用の診断: 一時キー（Script Properties）と正式キー（User Properties）の SET/ABSENT のみ。何も変更しない。 */
function accessBootstrapStatus() {
  return sba_bootstrapRun_(function (d) { return SwitchBotAccessInfra.bootstrapStatus(d); });
}

/** 一時キー3件だけを消す（失敗後の復旧・入力やり直し用）。他のプロパティには触れない。 */
function accessScrubBootstrapCredentials() {
  return sba_bootstrapRun_(function (d) { return SwitchBotAccessInfra.scrubBootstrapCredentials(d); });
}

/** 事前チェック: 必要な設定の有無のみ表示（値・完全IDは出さない）。 */
function accessCheckSetup() {
  var s = sba_scriptProps_(), u = sba_userProps_();
  var status = {};
  [SwitchBotAccessInfra.CONFIG_FORMAT_PROP, 'ACCESS_CONFIG', 'ACCESS_ENVIRONMENT', 'LEDGER_SPREADSHEET_ID', 'ACCESS_ADMIN_ACTORS']
    .concat(SwitchBotAccessInfra.SPLIT_PROP_NAMES).forEach(function (n) { status[n] = s.getProperty(n) ? 'SET' : 'MISSING'; });
  SBA_SECRET_NAMES_.forEach(function (n) { status[n] = u.getProperty(n) ? 'SET' : 'MISSING'; });
  status.ACCESS_ENABLED = s.getProperty('ACCESS_ENABLED') === 'true' ? 'ON' : 'OFF';
  var loaded = SwitchBotAccessInfra.loadConfig(function (k) { return s.getProperty(k); });
  status.configSource = loaded.source;
  var v = SwitchBotAccessInfra.validateConfig(loaded.cfg);
  status.config = v.ok ? 'VALID' : v.errors;
  // 発行前提（#859）: 件数と固定コードのみ（予約ID・完全deviceId・宛先は出さない）
  if (v.ok) status.issuance = SwitchBotAccessInfra.issuanceReadiness(loaded.cfg);
  Logger.log(JSON.stringify(status));
  return status;
}

// ── verify環境専用・37DD 期限境界（開始前／期間内／期限後）解錠試験（親 #748・計画 #756）──
// エディタの関数選択から引数なしで1回ずつ実行する手動入口。マージ・デプロイ・ARMED のみでは通信しない（実機GOは #756 で別途）。
// 通信には ACCESS_BND_TEST_ARMED=BND_PLAN_V1_4CALLS と、その段階名の ACCESS_BND_TEST_APPROVAL（通信前に消費）の両方が必要。
// 通信は SwitchBot API 合計4回（LIST / ISSUE / VERIFY_ISSUED / FINAL_LIST。各1回・自動再送なし）。deleteKey は渡さない（到達不能）。
// 使い捨て暗証番号は ACCESS_BND_TEST_PASSCODE（8桁）と申告 ACCESS_BND_PASSCODE_ATTEST=NOT_IN_USE_CONFIRMED を ISSUE の直前に設定する。
// ISSUE が通信より前に読み取って両方を削除する。拒否・失敗・例外の全経路でも削除を試み、残ればSTOPPEDで管理者対応。出力・ログに値を出さない。
// 解錠の観測はAPIではなく現地の物理操作。結果は accessBndObserve（通信なし）で申告する。試験キーは公式アプリで手動削除し accessBndAppCheck で記録する。
// #791(STOPPED)・#797(COMPLETE) の状態は読むだけで書換えない。手順: docs/switchbot-access-boundary-test-756.md
function sba_bndDeps_() {
  var d = sba_testKeyDeps_();
  var api = sba_api_();
  d.api = { listDevices: api.listDevices, createKey: api.createKey }; // deleteKey は渡さない
  d.userProps = { get: d.userProps.get, set: function () { throw new Error('READ_ONLY'); }, del: function () { throw new Error('READ_ONLY'); } };
  return d;
}

function sba_bndRun_(stage) {
  var out;
  try { out = SwitchBotAccessInfra.bndStage(sba_bndDeps_(), stage); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}

function accessBndStatus() {
  var out;
  try { out = SwitchBotAccessInfra.bndStatus(sba_bndDeps_()); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}
function accessBndStep1List() { return sba_bndRun_('LIST'); }
function accessBndStep2Issue() { return sba_bndRun_('ISSUE'); }
function accessBndStep3VerifyIssued() { return sba_bndRun_('VERIFY_ISSUED'); }
function accessBndObserve() {
  var out;
  try { out = SwitchBotAccessInfra.bndObserve(sba_bndDeps_()); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}
function accessBndStep4FinalList() { return sba_bndRun_('FINAL_LIST'); }
function accessBndAppCheck() {
  var out;
  try { out = SwitchBotAccessInfra.bndAppCheck(sba_bndDeps_()); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}
// ── 37DD 期限境界試験ここまで ──

// ── verify環境専用・37DD 段階承認型 API 単体試験（Issue #791）──
// エディタの関数選択から引数なしで1回ずつ実行する手動入口。マージ・デプロイ・ARMED のみでは通信しない。
// 通信には ACCESS_TEST_KEY_ARMED=true と、その段階名の ACCESS_TEST_KEY_APPROVAL（LIST / ISSUE / VERIFY_ISSUED / DELETE /
// VERIFY_DELETED。通信前に消費）の両方が必要。順序: Step1 → Step2 → Step3 → Step4 → Step5。SwitchBot API は合計5回まで・自動再送なし。
// 本番ジョブ（accessSyncJob 等）・トリガー・Webhook・台帳・メールは使わない。ログと戻り値は固定コード・件数のみ。
// 中断・不明時は次の変更操作を停止し、公式アプリで手動確認・復旧する（手順: docs/switchbot-access-test-key-stage-791.md）。
function sba_testKeyDeps_() {
  var s = sba_scriptProps_(), u = sba_userProps_();
  return {
    identity: function () {
      return { email: Session.getActiveUser().getEmail(), effectiveEmail: Session.getEffectiveUser().getEmail() };
    },
    adminActors: sba_adminActors_(),
    accessFlag: function () { return s.getProperty('ACCESS_ENABLED'); },
    scriptProps: {
      get: function (k) { return s.getProperty(k); },
      set: function (k, v) { s.setProperty(k, v); },
      del: function (k) { s.deleteProperty(k); }
    },
    userProps: {
      get: function (k) { return u.getProperty(k); },
      set: function (k, v) { u.setProperty(k, v); },
      del: function (k) { u.deleteProperty(k); }
    },
    lock: LockService.getScriptLock(),
    triggerCount: function () { return ScriptApp.getProjectTriggers().length; },
    api: sba_api_(),
    sha256Hex: function (v) {
      return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, v, Utilities.Charset.UTF_8)
        .map(function (b) { return ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2); }).join('');
    },
    randomInt: function (n) { return Math.floor(Math.random() * n); },
    nowSec: function () { return Math.floor(Date.now() / 1000); }
  };
}

function sba_testKeyRun_(stage) {
  var out;
  try {
    out = SwitchBotAccessInfra.testKeyStage(sba_testKeyDeps_(), stage);
  } catch (e) {
    out = { ok: false, code: 'UNEXPECTED_ERROR' };
  }
  Logger.log(JSON.stringify(out));
  return out;
}

function accessTestKeyStatus() {
  var out;
  try { out = SwitchBotAccessInfra.testKeyStatus(sba_testKeyDeps_()); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}
function accessTestKeyStep1List() { return sba_testKeyRun_('LIST'); }
function accessTestKeyStep2Issue() { return sba_testKeyRun_('ISSUE'); }
function accessTestKeyStep3VerifyIssued() { return sba_testKeyRun_('VERIFY_ISSUED'); }
function accessTestKeyStep4Delete() { return sba_testKeyRun_('DELETE'); }
function accessTestKeyStep5VerifyDeleted() { return sba_testKeyRun_('VERIFY_DELETED'); }

// ── 37DD keyList.id 型のみの読取専用診断（Issue #795）──
// 手動実行専用・引数なし。通信には ACCESS_ID_TYPE_DIAG_APPROVAL=ID_TYPE_READ_ONCE（通信前に消費）が必要で、GET /v1.1/devices は
// 永続予算1回のみ。ACCESS_TEST_KEY_STATE=STOPPED を維持し、変更系 API・トリガー・User Properties 書込は使わない。
// 結果は固定コードのみ。マージ・デプロイ・本関数の存在は実機診断のGOを意味しない（#756 の個別GOが必要）。
function sba_idTypeDiagDeps_() {
  var d = sba_testKeyDeps_();
  d.api = { listDevices: sba_api_().listDevices }; // 読取のみ渡す（createKey/deleteKey は到達不能）
  d.userProps = { get: d.userProps.get, set: function () { throw new Error('READ_ONLY'); }, del: function () { throw new Error('READ_ONLY'); } };
  return d;
}

function accessIdTypeDiagStatus() {
  var out;
  try { out = SwitchBotAccessInfra.idTypeDiagStatus(sba_idTypeDiagDeps_()); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}

function accessIdTypeDiagRun() {
  var out;
  try { out = SwitchBotAccessInfra.idTypeDiag(sba_idTypeDiagDeps_()); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}

// ── verify環境専用・37DD 数値型ID維持 createKey→deleteKey 最小試験（Issue #797）──
// エディタの関数選択から引数なしで1回ずつ実行する手動入口。マージ・デプロイ・ARMED のみでは通信しない。
// 通信には ACCESS_NUMID_TEST_ARMED=NUMID_PLAN_V1_6CALLS（手順書の6回計画との合致の目印）と、その段階名の
// ACCESS_NUMID_TEST_APPROVAL（LIST / ISSUE / VERIFY_ISSUED / PRE_DELETE_LIST / DELETE / VERIFY_DELETED。通信前に消費）の両方が必要。
// 順序: Step1 → … → Step6 のあと、公式アプリの目視結果を accessNumIdAppCheck（通信なし）で記録。SwitchBot API は合計6回まで・自動再送なし。
// 既存の #791 状態（ACCESS_TEST_KEY_STATE=STOPPED）・ARMED・APPROVAL は読むだけで書換えない。独立の状態 ACCESS_NUMID_TEST_STATE で予算を管理する。
// deleteKey の parameter.id は PRE_DELETE_LIST で取得した keyList.id の型のまま送る（String() 変換なし）。ログと戻り値は固定コード・件数・秒数のみ。
// 中断・不明時は次の変更操作を停止し、公式アプリで手動確認・撤去する（手順: docs/switchbot-access-numeric-id-retest-797.md）。
function sba_numIdRun_(stage) {
  var out;
  try { out = SwitchBotAccessInfra.numIdStage(sba_testKeyDeps_(), stage); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}

function accessNumIdStatus() {
  var out;
  try { out = SwitchBotAccessInfra.numIdStatus(sba_testKeyDeps_()); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}
function accessNumIdStep1List() { return sba_numIdRun_('LIST'); }
function accessNumIdStep2Issue() { return sba_numIdRun_('ISSUE'); }
function accessNumIdStep3VerifyIssued() { return sba_numIdRun_('VERIFY_ISSUED'); }
function accessNumIdStep4PreDeleteList() { return sba_numIdRun_('PRE_DELETE_LIST'); }
function accessNumIdStep5Delete() { return sba_numIdRun_('DELETE'); }
function accessNumIdStep6VerifyDeleted() { return sba_numIdRun_('VERIFY_DELETED'); }
function accessNumIdAppCheck() {
  var out;
  try { out = SwitchBotAccessInfra.numIdAppCheck(sba_testKeyDeps_()); } catch (e) { out = { ok: false, code: 'UNEXPECTED_ERROR' }; }
  Logger.log(JSON.stringify(out));
  return out;
}

// ── 本番初期設定の読取専用診断（Issue #774）──
// エディタの関数選択から引数なしで1回実行。ACCESS_ADMIN_ACTORS の本人（active/effective 一致）のみ。ACCESS_ENABLED が
// 明示OFFのときだけ進む。書込み（Properties/Sheets/ロック）・通信（UrlFetch/Mail）・トリガー操作は一切しない。
// ログと戻り値は固定コード・SET/MISSING・集計値のみ（値・ID・メール・予約情報・例外本文を出さない）。
// accessAdminStatus（runLockedで状態を書く）とは別物。手順: docs/switchbot-access-infra-754.md「読取専用診断（#774）」
function sba_readOnlyStore_() {
  var base = sba_stateStore_();
  return { get: base.get, keys: base.keys }; // 書込み手段（set/del）を渡さない
}

function sba_ledgerInspect_() {
  var id = sba_scriptProps_().getProperty('LEDGER_SPREADSHEET_ID');
  if (!id) return { code: 'LEDGER_ID_MISSING' };
  try {
    return AccessLedgerReader.inspectSheet(sba_openLedgerSheet_(id));
  } catch (e) {
    return { code: AccessLedgerReader.classifyError(e) };
  }
}

function accessReadOnlyDiagnostics() {
  var out;
  try {
    var s = sba_scriptProps_(), u = sba_userProps_();
    out = SwitchBotAccessInfra.readOnlyDiagnostics({
      identity: function () {
        return { email: Session.getActiveUser().getEmail(), effectiveEmail: Session.getEffectiveUser().getEmail() };
      },
      adminActors: sba_adminActors_(),
      accessFlag: function () { return s.getProperty('ACCESS_ENABLED'); },
      scriptProps: { get: function (k) { return s.getProperty(k); } },
      userProps: { get: function (k) { return u.getProperty(k); } },
      stateStore: sba_readOnlyStore_(),
      ledgerInspect: sba_ledgerInspect_
    });
  } catch (e) {
    out = { ok: false, code: 'UNEXPECTED_ERROR' };
  }
  Logger.log(JSON.stringify(out));
  return out;
}

// ── verify環境専用の読取専用診断（Issue #789）──
// SwitchBot Access Test GAS 用。ACCESS_ENVIRONMENT=verify・ACCESS_ENABLED=false（明示）・ACCESS_ADMIN_ACTORS 本人のときだけ進む。
// 台帳は Sheets API の GET のみ（Bookings・必須14列・JST）。資格情報・状態ストアは読まず、書込み・通信（SwitchBot/メール）・トリガー・ロックなし。
// 本番の accessReadOnlyDiagnostics は変更しない（production 専用のまま）。ログと戻り値は固定コード・件数のみ。
function sba_ledgerInspectTest_() {
  var id = sba_scriptProps_().getProperty('LEDGER_SPREADSHEET_ID');
  if (!id) return { code: 'LEDGER_ID_MISSING' };
  try {
    return AccessLedgerReader.inspectTestSheet(sba_openLedgerSheet_(id));
  } catch (e) {
    return { code: AccessLedgerReader.classifyError(e) };
  }
}

function accessTestReadOnlyDiagnostics() {
  var out;
  try {
    var s = sba_scriptProps_();
    out = SwitchBotAccessInfra.testReadOnlyDiagnostics({
      identity: function () {
        return { email: Session.getActiveUser().getEmail(), effectiveEmail: Session.getEffectiveUser().getEmail() };
      },
      adminActors: sba_adminActors_(),
      accessFlag: function () { return s.getProperty('ACCESS_ENABLED'); },
      scriptProps: { get: function (k) { return s.getProperty(k); } },
      ledgerInspect: sba_ledgerInspectTest_
    });
  } catch (e) {
    out = { ok: false, code: 'UNEXPECTED_ERROR' };
  }
  Logger.log(JSON.stringify(out));
  return out;
}
