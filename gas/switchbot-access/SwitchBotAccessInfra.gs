/**
 * 独立GAS基盤（Issue #754 PR-B）— 純粋ロジック。
 *
 * SwitchBotAccessCore（状態機械）を「本番の独立GAS」で動かすための周辺: 認証・相関・単一排他領域・
 * 容量/保持・通知・監視・管理者復旧。GAS依存（PropertiesService/LockService/UrlFetchApp/MailApp/Session）は
 * すべて deps で注入し、Node でモック検証する。実APIは呼ばない。機能フラグ（enabled）は既定OFF。
 *
 * 設計の要点（詳細: docs/switchbot-access-key-748.md「独立GAS基盤（#754）」）:
 *  - 排他は独立GAS内の「単一ロック領域」に集約。sync/deliver/sweep/Webhook取込/管理者復旧は同じ状態ストアを
 *    同じロックの下でのみ更新する。別GASプロジェクト間のScriptLock共有は仮定しない。取得失敗なら何も送信せず、
 *    取得後はキャッシュを使わず状態を再読込する（ストア層は読み取りキャッシュを持たない）。
 *  - 未認証Webhookは何も保存しない。認証後も「対象Keypad × 操作 × commandId」が進行中の操作と一致する
 *    イベントだけを採用する（ロック取得不能時のみ、同じ検証を満たした最小項目を受信箱へ退避）。
 *  - 管理者操作は認証/認可（許可リスト）を通り、操作者はサーバー側で確定する（クライアントのactor文字列は使わない）。
 *  - 秘密（パスコード・APIトークン）は状態ストアと別の領域（shell が別Propertiesを渡す）。ここでは状態へ出さない。
 */
var SwitchBotAccessInfra = (function () {
  'use strict';

  var Core = (typeof SwitchBotAccessCore !== 'undefined') ? SwitchBotAccessCore
    : (typeof require === 'function' ? require('./SwitchBotAccessCore.gs') : null);

  var ENVIRONMENT = { VERIFY: 'verify', PRODUCTION: 'production' };

  /** 公式クォータ（Apps Script Properties）。デプロイ前に最新の公式値で再確認する。値は設定で上書き可。 */
  var PROPERTIES_LIMITS = { perValueBytes: 9 * 1024, totalBytes: 500 * 1024 };

  /** 既定値。いずれも「実測値」ではなく設計値（basis=UNMEASURED_DEFAULT）。限定検証（#756）で計測して置換する。 */
  var DEFAULTS = {
    syncIntervalSec: 300,
    gateRetrySec: 600,
    quietSec: 60,
    runBudgetSec: 240,
    lockWaitMs: 20000,
    webhookLockWaitMs: 8000,
    inboxMax: 50,
    inboxTtlSec: 900,
    heartbeatStaleSec: 900,
    notifyRepeatSec: 86400,
    notifyBackoffBaseSec: 60,
    notifyBackoffMaxSec: 3600,
    notifyFailingAttempts: 10,
    lockFailAlertStreak: 3,
    apiDailyBudget: 8000,
    storageStopRatio: 0.7,
    storageValueStopRatio: 0.8,
    jitterMarginSec: 120,
    retention: { bkSec: 30 * 86400, evtSec: 30 * 86400, outboxSec: 30 * 86400, trackSec: 30 * 86400, adminLogSec: 90 * 86400 }
  };

  var REF_RE = /^[A-Za-z0-9._-]{1,64}$/;
  var CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;
  var REC_ID_RE = /^[A-Za-z0-9._:#*-]{1,120}$/; // OP id は予約ID:改訂:マスク端末(****XXXX):ISSUE#n
  var DEVICE_MASK_RE = /^\*{4}[A-Za-z0-9]{0,4}$/;

  // ---------- 小物 ----------

  function infraCfg(cfg) {
    var i = (cfg && cfg.infra) || {};
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = i[k] !== undefined ? i[k] : DEFAULTS[k]; });
    out.retention = Object.assign({}, DEFAULTS.retention, i.retention || {});
    return out;
  }

  function last4(id) { var s = String(id || ''); return s.slice(-4).toUpperCase(); }

  function byteLength(str) {
    var s = String(str);
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  function safeParse(raw) { try { return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

  // ---------- 環境分離・設定検証 ----------

  /**
   * 検証/本番の取り違えを送信前に止める。環境名・許可する末尾4桁・対応表が矛盾すれば不正。
   * 本番に自宅検証機(例 37DD)、検証に本番機(例 01FD)を載せられない（allowedLast4 は環境ごとの別設定）。
   */
  function validateConfig(cfg) {
    var errors = [];
    cfg = cfg || {};
    var envs = Object.keys(ENVIRONMENT).map(function (k) { return ENVIRONMENT[k]; });
    if (envs.indexOf(cfg.environment) === -1) errors.push('ENVIRONMENT_INVALID');
    var allowed = Array.isArray(cfg.allowedLast4) ? cfg.allowedLast4.map(function (s) { return String(s).toUpperCase(); }) : [];
    if (!allowed.length) errors.push('ALLOWED_LAST4_MISSING');
    var kps = Array.isArray(cfg.keypads) ? cfg.keypads : [];
    if (!kps.length) errors.push('KEYPADS_MISSING');
    kps.forEach(function (k) {
      if (!k || typeof k.deviceId !== 'string' || !k.deviceId) errors.push('KEYPAD_DEVICE_INVALID');
      else if (allowed.indexOf(last4(k.deviceId)) === -1) errors.push('KEYPAD_NOT_ALLOWED_IN_ENV');
    });
    var targets = cfg.ledgerTarget;
    if (!targets || typeof targets.facility !== 'string' || !targets.facility) errors.push('LEDGER_TARGET_MISSING');
    var to = cfg.adminMailTo;
    if (!Array.isArray(to) || !to.length || to.some(function (a) { return typeof a !== 'string' || a.indexOf('@') < 1; })) errors.push('ADMIN_MAIL_MISSING');
    return { ok: errors.length === 0, errors: errors.filter(function (e, i) { return errors.indexOf(e) === i; }) };
  }

  /** 状態ストアに環境名を刻む。別環境のストアへ向けた起動を拒否する（初回のみ記録）。 */
  function ensureStoreEnvironment(store, environment) {
    var cur = store.get('META_ENV');
    if (cur === null || cur === undefined || cur === '') { store.set('META_ENV', environment); return { ok: true, created: true }; }
    return cur === environment ? { ok: true, created: false } : { ok: false, error: 'ENV_MISMATCH' };
  }

  // ---------- 認証 ----------

  /** 長さに依らず全文字を比較する定数時間比較。 */
  function constantTimeEquals(a, b) {
    var x = String(a === undefined || a === null ? '' : a);
    var y = String(b === undefined || b === null ? '' : b);
    var len = Math.max(x.length, y.length);
    var diff = x.length ^ y.length;
    for (var i = 0; i < len; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
    return diff === 0;
  }

  /** Webhook共有トークンの検証。期待値が短い/未設定なら全拒否（設定不備を認証通過にしない）。 */
  function authenticateWebhook(given, expected) {
    if (typeof expected !== 'string' || expected.length < 24) return false;
    if (typeof given !== 'string' || !given) return false;
    return constantTimeEquals(given, expected);
  }

  /**
   * 管理者の認可。identity はサーバー側で得た実行者（Session由来）。許可リスト(email→非個人情報ラベル)に
   * 載るときだけ許可し、以降の監査にはラベルのみ使う。クライアントが渡した actor は受け付けない。
   */
  function authorizeAdmin(identity, actors) {
    var email = identity && typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';
    if (!email) return { ok: false, error: 'IDENTITY_UNAVAILABLE' };
    if (!actors || typeof actors !== 'object') return { ok: false, error: 'NOT_AUTHORIZED' };
    var label = null;
    Object.keys(actors).forEach(function (k) { if (k.trim().toLowerCase() === email) label = actors[k]; });
    if (typeof label !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(label)) return { ok: false, error: 'NOT_AUTHORIZED' };
    return { ok: true, actor: label };
  }

  // ---------- 資格情報の初期登録（Issue #770）----------

  var CREDENTIAL_NAMES = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'WEBHOOK_SHARED_TOKEN'];
  var CREDENTIAL_CONFIRM_REPLACE = 'REPLACE';

  /** 値そのものは返さない。不備の種別だけ返す。Webhook共有トークンはURLクエリで送るため URL安全文字のみ。 */
  function validateCredentialInput(name, value) {
    if (typeof value !== 'string' || value === '') return { ok: false, error: 'EMPTY' };
    if (/[\s\u0000-\u001f\u007f]/.test(value)) return { ok: false, error: 'WHITESPACE_OR_CONTROL' };
    if (name === 'WEBHOOK_SHARED_TOKEN') {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) return { ok: false, error: 'CHARSET' };
      if (value.length < 24 || value.length > 128) return { ok: false, error: 'LENGTH' };
      var distinct = {};
      value.split('').forEach(function (c) { distinct[c] = true; });
      if (Object.keys(distinct).length < 8) return { ok: false, error: 'LOW_ENTROPY' };
      return { ok: true };
    }
    if (CREDENTIAL_NAMES.indexOf(name) === -1) return { ok: false, error: 'UNKNOWN_NAME' };
    if (value.length < 16 || value.length > 512) return { ok: false, error: 'LENGTH' };
    return { ok: true };
  }

  /** 資格情報操作の認可。active/effective の双方が非空で一致しなければ停止（不明は許可しない）。 */
  function authorizeExecutor(deps) {
    var idn = null;
    try { idn = deps.identity ? deps.identity() : null; } catch (e) { idn = null; }
    var who = authorizeAdmin(idn, deps.adminActors);
    if (!who.ok) return who;
    var eff = idn && typeof idn.effectiveEmail === 'string' ? idn.effectiveEmail.trim().toLowerCase() : '';
    if (!eff) return { ok: false, error: 'IDENTITY_UNAVAILABLE' };
    if (eff !== idn.email.trim().toLowerCase()) return { ok: false, error: 'ACCOUNT_MISMATCH' };
    return { ok: true, actor: who.actor };
  }

  /** 認可と SET/MISSING のみを返す状態確認（入力を要求せず、何も保存しない）。 */
  function credentialStatus(deps) {
    var st = {};
    var gate = authorizeExecutor(deps);
    CREDENTIAL_NAMES.forEach(function (n) {
      var v = null;
      if (gate.ok) { try { v = deps.userProps.get(n); } catch (e) { v = null; } }
      st[n] = v ? 'SET' : 'MISSING';
    });
    return { ok: gate.ok, code: gate.ok ? 'STATUS_OK' : gate.error, status: st, changed: [] };
  }

  /**
   * 実行者本人の User Properties へ資格情報3件だけを登録する。返すのは固定コードと SET/MISSING のみ
   * （入力値・既存値・例外メッセージは返さず、ログにも出さない）。触れるキーは CREDENTIAL_NAMES の3つだけ。
   *
   * deps: userProps{get,set,del}, identity() → {email, effectiveEmail}, adminActors, prompt(name) → 文字列|null(取消)
   * opts: mode 'init'（未設定のものだけ入力。設定済みは変更しない）／'replace'（確認語 REPLACE が必須。空入力=据え置き）、dryRun
   * 入力は全件検証してから書き込み、書込み・照合に失敗したら今回の変更を元に戻す。
   */
  function setupCredentials(deps, opts) {
    opts = opts || {};
    var mode = opts.mode === 'replace' ? 'replace' : 'init';
    var props = deps.userProps;
    function statusOf() {
      var st = {};
      CREDENTIAL_NAMES.forEach(function (n) {
        var v = null;
        try { v = props.get(n); } catch (e) { v = null; }
        st[n] = v ? 'SET' : 'MISSING';
      });
      return st;
    }
    function result(ok, code, extra) {
      var r = { ok: ok, code: code, status: statusOf(), changed: [] };
      if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }

    // 1) 認可（fail closed）: 許可リストの管理者本人で、かつ実行者=有効ユーザーが双方とも取得でき一致するときだけ
    var gate = authorizeExecutor(deps);
    if (!gate.ok) return result(false, gate.error);

    // 2) 現状に応じた対象の決定
    var before = statusOf();
    var targets;
    if (mode === 'init') {
      targets = CREDENTIAL_NAMES.filter(function (n) { return before[n] === 'MISSING'; });
      if (!targets.length) return result(false, 'ALREADY_SET');
    } else {
      if (CREDENTIAL_NAMES.every(function (n) { return before[n] === 'MISSING'; })) return result(false, 'NOT_INITIALIZED');
      targets = CREDENTIAL_NAMES.slice();
    }

    // 3) 上書きは明示確認（確認語の完全一致）が必須。確認前は何も入力させず、何も変更しない
    function ask(name) {
      var v;
      try { v = deps.prompt(name); } catch (e) { return { fail: 'PROMPT_UNAVAILABLE' }; }
      return v === null || v === undefined ? { fail: 'CANCELLED' } : { value: String(v) };
    }
    if (mode === 'replace') {
      var c = ask('__CONFIRM_REPLACE__');
      if (c.fail) return result(false, c.fail);
      if (c.value.trim() !== CREDENTIAL_CONFIRM_REPLACE) return result(false, 'REPLACE_NOT_CONFIRMED');
    }

    // 4) 全件入力→全件検証（1件でも不備なら何も書かない）
    var inputs = {}, invalid = [];
    for (var i = 0; i < targets.length; i++) {
      var a = ask(targets[i]);
      if (a.fail) return result(false, a.fail);
      if (mode === 'replace' && a.value === '' && before[targets[i]] === 'SET') continue; // 据え置き
      var v = validateCredentialInput(targets[i], a.value);
      if (!v.ok) invalid.push(targets[i]); else inputs[targets[i]] = a.value;
    }
    if (invalid.length) return result(false, 'INPUT_INVALID', { invalid: invalid });
    var names = Object.keys(inputs);
    if (!names.length) return result(false, 'NOTHING_TO_CHANGE');
    // 3種は互いに別の値であること（新旧・据え置き分を含めて比較。値は外へ出さない）
    var seen = {}, dup = false;
    CREDENTIAL_NAMES.forEach(function (n) {
      var val = inputs[n] !== undefined ? inputs[n] : (before[n] === 'SET' ? props.get(n) : null);
      if (!val) return;
      if (seen[val]) dup = true;
      seen[val] = true;
    });
    if (dup) return result(false, 'INPUT_DUPLICATE');
    if (opts.dryRun) return result(true, 'DRY_RUN_OK', { wouldChange: names });

    // 5) 書込み→照合。失敗したら今回の分を元に戻す
    var prev = {}, written = [];
    function rollback() {
      written.forEach(function (n) {
        try { if (prev[n]) props.set(n, prev[n]); else props.del(n); } catch (e) { /* 復旧不能でも値は出さない */ }
      });
    }
    try {
      names.forEach(function (n) {
        prev[n] = props.get(n);
        written.push(n);
        props.set(n, inputs[n]);
      });
    } catch (e) {
      rollback();
      return result(false, 'WRITE_FAILED');
    }
    var verified = false;
    try { verified = names.every(function (n) { return props.get(n) === inputs[n]; }); } catch (e) { verified = false; }
    if (!verified) { rollback(); return result(false, 'VERIFY_FAILED'); }
    return result(true, 'OK', { changed: names });
  }

  // ---------- Webhook 相関 ----------

  /** 受信ペイロードを採用に必要な最小項目へ正規化（未知項目・生応答を保存しない）。 */
  function minimizeWebhook(payload) {
    var ev = Core.parseKeypadWebhook(payload);
    if (!ev) return null;
    var c = payload.context;
    return {
      eventType: 'changeReport',
      context: { deviceType: String(c.deviceType), eventName: ev.eventName, commandId: ev.commandId, deviceMac: ev.deviceMac, result: ev.result }
    };
  }

  /**
   * 進行中の操作（Webhook待ち）を OP 記録から列挙する。
   * ISSUE: SENT_WAIT_WEBHOOK の commandId / REVOKE: DELETE_SENT の deleteCommandId。
   */
  function openWebhookOps(ops) {
    var out = [];
    ops.forEach(function (r) {
      if (!r) return;
      if (r.state === Core.STATE.SENT_WAIT_WEBHOOK && r.commandId) {
        out.push({ deviceId: r.deviceId, eventName: 'createKey', commandId: String(r.commandId) });
      } else if (r.state === Core.STATE.DELETE_SENT && r.deleteCommandId) {
        out.push({ deviceId: r.deviceId, eventName: 'deleteKey', commandId: String(r.deleteCommandId) });
      }
    });
    return out;
  }

  /**
   * 認証済みイベントの相関。対象Keypad（設定された端末のいずれか）・操作・commandId が、進行中の操作と
   * 一致する場合のみ accept。理由コードは固定。
   */
  function correlateWebhook(payload, keypadIds, openOps) {
    var min = minimizeWebhook(payload);
    if (!min) return { accept: false, reason: 'NOT_KEYPAD_EVENT' };
    var mac = min.context.deviceMac;
    if (!mac) return { accept: false, reason: 'DEVICE_MISSING' };
    var targets = (keypadIds || []).map(Core.normDev);
    if (targets.indexOf(mac) === -1) return { accept: false, reason: 'DEVICE_NOT_TARGET' };
    var hit = (openOps || []).some(function (o) {
      return Core.normDev(o.deviceId) === mac && o.eventName === min.context.eventName && o.commandId === min.context.commandId;
    });
    if (!hit) return { accept: false, reason: 'NO_MATCHING_OPERATION', minimized: min };
    return { accept: true, reason: null, minimized: min };
  }

  // ---------- 排他領域 ----------

  /**
   * 単一ロック領域。lockService は { tryLock(ms)→bool, releaseLock() }。
   * 取得に失敗/例外なら fn を実行しない（呼び出し側は送信しない）。入れ子は拒否。
   * coreLock は Core の deps.lock へ渡す: 外側の単一ロック保持を確認してから fn を実行するだけ（別ロックを取らない）。
   */
  function createLockDomain(lockService) {
    var held = false;
    return {
      isHeld: function () { return held; },
      run: function (waitMs, fn) {
        if (held) throw new Error('LOCK_REENTRANT');
        var got = false;
        try { got = lockService.tryLock(waitMs) === true; } catch (e) { got = false; }
        if (!got) return { ran: false, error: 'LOCK_UNAVAILABLE' };
        held = true;
        try { return { ran: true, value: fn() }; }
        finally { held = false; try { lockService.releaseLock(); } catch (e2) { /* 解放失敗は次回取得失敗として現れる */ } }
      },
      coreLock: function (keys, fn) {
        if (!held) throw new Error('LOCK_NOT_HELD'); // 排他領域の外から状態を更新させない
        return fn();
      }
    };
  }

  // ---------- 容量 ----------

  /**
   * Keypad 登録件数の安全ゲート（新規発行のみ止める。削除・照合は止めない）。
   * stopAt は運営承認後の設定値。未設定/不正は「容量不明＝安全停止」。80 などの値は既定にしない。
   * policy: { stopAt:number|null, officialLimit:number|null }
   */
  function keypadCapacityGate(devices, deviceId, policy) {
    policy = policy || {};
    if (!Array.isArray(devices)) return { ok: false, code: 'CAPACITY_UNKNOWN', used: null };
    var devs = devices.filter(function (d) { return d && d.deviceId === deviceId; });
    if (devs.length !== 1 || !Array.isArray(devs[0].keyList)) return { ok: false, code: 'CAPACITY_UNKNOWN', used: null };
    var used = devs[0].keyList.length;
    var stopAt = policy.stopAt;
    if (typeof stopAt !== 'number' || !isFinite(stopAt) || stopAt < 1 || Math.floor(stopAt) !== stopAt) {
      return { ok: false, code: 'CAPACITY_THRESHOLD_UNSET', used: used };
    }
    if (typeof policy.officialLimit === 'number' && stopAt > policy.officialLimit) {
      return { ok: false, code: 'CAPACITY_THRESHOLD_INVALID', used: used };
    }
    if (used >= stopAt) return { ok: false, code: 'CAPACITY_REACHED', used: used };
    return { ok: true, code: null, used: used };
  }

  /** 状態ストアの使用量（キー名+値のUTF-8バイト）。接頭辞別の内訳つき。値そのものは返さない。 */
  function measureStore(store) {
    var keys = store.keys();
    var total = 0, maxValue = 0, byPrefix = {};
    keys.forEach(function (k) {
      var v = store.get(k);
      var vb = v === null || v === undefined ? 0 : byteLength(v);
      var kb = byteLength(k);
      total += kb + vb;
      if (vb > maxValue) maxValue = vb;
      var p = k.indexOf('_') > 0 ? k.slice(0, k.indexOf('_')) : k;
      byPrefix[p] = byPrefix[p] || { count: 0, bytes: 0 };
      byPrefix[p].count++;
      byPrefix[p].bytes += kb + vb;
    });
    return { keys: keys.length, bytes: total, maxValueBytes: maxValue, byPrefix: byPrefix };
  }

  /** 保存容量ゲート。上限に近い状態で新規発行を始めない（保存失敗は送信前に検知したい）。 */
  function storageGate(measure, cfg, limits) {
    var lim = Object.assign({}, PROPERTIES_LIMITS, limits || {});
    var ic = infraCfg(cfg);
    var ratio = measure.bytes / lim.totalBytes;
    var valueRatio = measure.maxValueBytes / lim.perValueBytes;
    if (ratio >= ic.storageStopRatio) return { ok: false, code: 'STORAGE_NEAR_LIMIT', ratio: ratio, valueRatio: valueRatio };
    if (valueRatio >= ic.storageValueStopRatio) return { ok: false, code: 'STORAGE_VALUE_NEAR_LIMIT', ratio: ratio, valueRatio: valueRatio };
    return { ok: true, code: null, ratio: ratio, valueRatio: valueRatio };
  }

  /**
   * 容量見積もり（設計時）。入力は予約数・変更数・保持日数・1件あたり実測バイト。
   * 結果は状態件数とバイト数、公式上限に対する比率。入力が欠けたら見積もりを返さない。
   */
  function estimateStorage(p, limits) {
    var need = ['bookingsPerMonth', 'changesPerBooking', 'retentionDays', 'opBytes', 'bkBytes', 'evtBytes', 'alertBytes', 'trackBytes', 'unresolvedOps'];
    for (var i = 0; i < need.length; i++) {
      if (typeof p[need[i]] !== 'number' || !isFinite(p[need[i]]) || p[need[i]] < 0) return { ok: false, error: 'INPUT_MISSING:' + need[i] };
    }
    var lim = Object.assign({}, PROPERTIES_LIMITS, limits || {});
    var window = p.retentionDays / 30;
    var bookings = Math.ceil(p.bookingsPerMonth * window);
    // 変更ごとに 発行+削除 の2 OP。未解決（UNKNOWN 等）の OP は期限なしで滞留する分を別枠で加算
    var ops = Math.ceil(bookings * (1 + p.changesPerBooking) * 2) + p.unresolvedOps;
    var bks = bookings + p.unresolvedOps;
    var bytes = ops * (p.opBytes + p.evtBytes + (p.alertsPerOp || 1) * p.alertBytes) + bks * (p.bkBytes + p.trackBytes);
    return { ok: true, bookings: bookings, ops: ops, bytes: bytes, ratio: bytes / lim.totalBytes, limits: lim };
  }

  // ---------- 保持・回収 ----------

  var ALERT_PREFIX = 'ALERT_';

  function scanOps(store) {
    return store.keys().filter(function (k) { return k.indexOf('OP_') === 0; })
      .map(function (k) { return safeParse(store.get(k)); }).filter(function (r) { return r && r.id; });
  }

  function isUnresolved(rec) { return Core.TERMINAL.indexOf(rec.state) === -1; }

  /**
   * 保持期限に基づく回収（ロック保持下で呼ぶ）。未解決OPと、それに必要な根拠（索引・Webhook・秘密・通知マーカー）は
   * 期限に関わらず保護する。回収: 参照切れのBK索引項目／期限切れBK／期限切れかつ未参照のEVT／OP不在のALERT／
   * OPが無い・終端OPの秘密／期限切れ受信箱／古い追跡・通知・管理者ログ。件数のみ返す。
   */
  function garbageCollect(store, secrets, nowSec, cfg) {
    var ic = infraCfg(cfg);
    var ret = ic.retention;
    var removed = { BK: 0, EVT: 0, ALERT: 0, SECRET: 0, INBOX: 0, TRK: 0, IALERT: 0, ADMINLOG: 0, BK_OPREF: 0 };
    var ops = scanOps(store);
    var opIds = {}, unresolvedIds = {}, protectedEvt = {}, unresolvedBookings = {};
    ops.forEach(function (r) {
      opIds[r.id] = r;
      if (isUnresolved(r)) {
        unresolvedIds[r.id] = true; unresolvedBookings[r.bookingId] = true;
        if (r.commandId) protectedEvt[Core.normDev(r.deviceId) + '_createKey_' + r.commandId] = true;
        if (r.deleteCommandId) protectedEvt[Core.normDev(r.deviceId) + '_deleteKey_' + r.deleteCommandId] = true;
      }
    });
    var keys = store.keys();

    keys.forEach(function (k) {
      var v = store.get(k);
      if (v === null || v === undefined) return;
      // --- BK 索引 ---
      if (k.indexOf('BK_') === 0) {
        var idx = safeParse(v);
        if (!idx) return;
        var live = (idx.ops || []).filter(function (id) { return !!opIds[id]; });
        if (live.length !== (idx.ops || []).length) { idx.ops = live; store.set(k, JSON.stringify(idx)); removed.BK_OPREF++; }
        if (live.length) return; // OP が残る間は保持
        if (unresolvedBookings[idx.bookingId]) return;
        if (typeof idx.touchedAt !== 'number') { idx.touchedAt = nowSec; store.set(k, JSON.stringify(idx)); return; } // 年齢不明は今から数える
        if (nowSec - idx.touchedAt > ret.bkSec) { store.del(k); removed.BK++; }
        return;
      }
      // --- Webhook 記録 ---
      if (k.indexOf('EVT_') === 0) {
        var ev = safeParse(v);
        var evKey = k.slice(4);
        if (protectedEvt[evKey]) return;
        var at = ev && typeof ev.receivedAtSec === 'number' ? ev.receivedAtSec : null;
        if (at === null || nowSec - at > ret.evtSec) { store.del(k); removed.EVT++; }
        return;
      }
      // --- 通知重複抑止マーカー（コア） ---
      if (k.indexOf(ALERT_PREFIX) === 0) {
        var owner = null;
        Object.keys(opIds).forEach(function (id) { if (k.indexOf(ALERT_PREFIX + id + '_') === 0) owner = id; });
        if (!owner) { store.del(k); removed.ALERT++; } // 参照元OPなし（孤立）
        return;
      }
      // --- 受信箱（ロック失敗時の退避） ---
      if (k.indexOf('INBOX_') === 0) {
        var ib = safeParse(v);
        if (!ib || typeof ib.at !== 'number' || nowSec - ib.at > ic.inboxTtlSec) { store.del(k); removed.INBOX++; }
        return;
      }
      // --- 追跡（ledger 照合の観測記録） ---
      if (k.indexOf('TRK_') === 0) {
        var t = safeParse(v);
        var bid = k.slice(4);
        if (unresolvedBookings[bid]) return;
        if (!t || typeof t.seenAt !== 'number' || nowSec - t.seenAt > ret.trackSec) { store.del(k); removed.TRK++; }
        return;
      }
      // --- 管理者通知の送達記録（送達済みのみ回収。未送達は保持） ---
      if (k.indexOf('IALERT_') === 0) {
        var ia = safeParse(v);
        if (ia && typeof ia.sentAt === 'number' && nowSec - ia.sentAt > ret.outboxSec) { store.del(k); removed.IALERT++; }
        return;
      }
      // --- 管理者操作ログ ---
      if (k.indexOf('ADMINLOG_') === 0) {
        var al = safeParse(v);
        if (!al || typeof al.at !== 'number' || nowSec - al.at > ret.adminLogSec) { store.del(k); removed.ADMINLOG++; }
      }
    });

    // --- 孤立した秘密（OP が無い／終端OP）。ロック保持下なので送信中の秘密は存在しない ---
    secrets.keys().forEach(function (k) {
      if (k.indexOf('SECRET_') !== 0) return;
      var id = k.slice(7);
      var rec = opIds[id];
      if (!rec || !isUnresolved(rec)) {
        // 配送待ち(ISSUED_CONFIRMED)は未解決扱いなので残る。終端/不在のみ破棄
        secrets.del(k);
        removed.SECRET++;
      }
    });
    return removed;
  }

  // ---------- ジョブ計画・API予算 ----------

  /**
   * 周期・読取上限・期限の整合を決める。値は設計値で、実測ではない（basis に明記）。
   * commandIdなし削除の読取は照合ジョブの周期でしか進まないため、readWaitSec は
   * (maxReads-1)*周期 + 余裕 以上でなければ上限回数に達する前にUNKNOWNへ落ちる。
   */
  function planJobs(cfg) {
    cfg = cfg || {};
    var ic = infraCfg(cfg);
    var maxReads = typeof cfg.maxReads === 'number' ? cfg.maxReads : 3;
    var webhookWaitSec = typeof cfg.webhookWaitSec === 'number' ? cfg.webhookWaitSec : 90;
    var minRead = (maxReads - 1) * ic.syncIntervalSec + ic.jitterMarginSec;
    var readWaitSec = typeof cfg.readWaitSec === 'number' ? cfg.readWaitSec : minRead;
    var warnings = [];
    if (readWaitSec < minRead) warnings.push('READ_WINDOW_TOO_SHORT_FOR_CYCLE');
    if (ic.runBudgetSec >= 300) warnings.push('RUN_BUDGET_NEAR_EXECUTION_LIMIT');
    if (ic.quietSec >= ic.syncIntervalSec * 2) warnings.push('QUIET_PERIOD_TOO_LONG');
    return {
      syncIntervalSec: ic.syncIntervalSec, maxReads: maxReads, webhookWaitSec: webhookWaitSec, readWaitSec: readWaitSec,
      quietSec: ic.quietSec, runBudgetSec: ic.runBudgetSec, apiDailyBudget: ic.apiDailyBudget,
      basis: { syncIntervalSec: 'DESIGN', maxReads: 'UNMEASURED_DEFAULT', webhookWaitSec: 'UNMEASURED_DEFAULT', readWaitSec: 'DERIVED_FROM_CYCLE', apiDailyBudget: 'DESIGN_MARGIN_UNDER_OFFICIAL_LIMIT' },
      warnings: warnings
    };
  }

  /** 当日(JST)のAPI呼び出し数カウンタ。永続化し、予算超過なら新たな呼び出しを許可しない。 */
  function createApiBudget(store, nowSec, limit) {
    function dayKey() {
      var d = new Date((nowSec() + 9 * 3600) * 1000);
      return 'APICOUNT_' + d.getUTCFullYear() + ('0' + (d.getUTCMonth() + 1)).slice(-2) + ('0' + d.getUTCDate()).slice(-2);
    }
    return {
      used: function () { return Number(store.get(dayKey())) || 0; },
      exhausted: function () { return (Number(store.get(dayKey())) || 0) >= limit; },
      count: function () { var k = dayKey(); store.set(k, String((Number(store.get(k)) || 0) + 1)); },
      key: dayKey
    };
  }

  // ---------- 通知（固定分類） ----------

  var CATALOG = (function () {
    function c(category, severity, action) { return { category: category, severity: severity, action: action }; }
    var UNKNOWN_ACTION = '実機の状態を変更せず、管理者が非公開環境で keyList を確認し、復旧手順に従って解決する。必要なら代替入室（手動解錠・手動パスコード・物理キー）を管理者判断で案内する。';
    var RESIDUAL_ACTION = '期限切れ・取消後のキーが残っている可能性がある。管理者が非公開環境で個別に確認し、必要なら個別削除する。一括削除はしない。';
    var FAIL_ACTION = '反映していない根拠がある。管理者が予約の最新状態を確認し、必要なら代替入室を案内する。';
    return {
      PRECHECK_FAILED: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      NAME_ALREADY_EXISTS: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      SECRET_MISSING: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      ISSUE_REJECTED: c('FAILED', 'medium', FAIL_ACTION),
      SEND_COMM_ERROR: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      SEND_RESPONSE_UNKNOWN: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      ISSUE_FAILED: c('FAILED', 'medium', FAIL_ACTION),
      ISSUE_CONFIRM_FAILED: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      ISSUE_WEBHOOK_CONFLICT: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      WEBHOOK_TIMEOUT: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      CONFIRM_MISMATCH: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      READ_LIMIT: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      DELETE_PRECHECK_FAILED: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      DELETE_AMBIGUOUS: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      DELETE_ID_MISMATCH: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      DELETE_COMM_ERROR: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      DELETE_RESPONSE_UNKNOWN: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      DELETE_CONFIRM_FAILED: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      DELETE_WEBHOOK_CONFLICT: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      DELETE_WEBHOOK_FAILED: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      KEY_REMAINS: c('RESIDUAL_KEY', 'high', RESIDUAL_ACTION),
      EXPIRED_KEY_REMAINS: c('RESIDUAL_KEY', 'medium', RESIDUAL_ACTION),
      EXPIRED_CHECK_FAILED: c('RESIDUAL_KEY', 'medium', RESIDUAL_ACTION),
      CRASH_RECOVERY: c('UNKNOWN_STATE', 'high', UNKNOWN_ACTION),
      OLD_KEY_UNRESOLVED: c('UNKNOWN_STATE', 'high', '旧キーの削除が未確定のため新キーを発行していない。旧キーの解決後に再開する。必要なら代替入室を案内する。'),
      DELIVER_FAILED: c('DELIVERY', 'medium', '暗証番号の配送に失敗した。再送は自動で行わない。管理者が配送状況を確認し、必要なら代替入室を案内する。'),
      // 基盤（#754）
      CAPACITY_REACHED: c('CAPACITY', 'high', 'Keypadの登録件数が停止閾値に達したため、新規コードの自動発行を止めた。予約・決済は取り消さない。管理者が不要な登録を個別に棚卸しし、代替入室で対応する。'),
      CAPACITY_UNKNOWN: c('CAPACITY', 'high', 'Keypadの登録件数を確認できないため、安全のため新規発行を止めた。'),
      CAPACITY_THRESHOLD_UNSET: c('CAPACITY', 'high', '停止閾値が未承認・未設定のため、新規発行を止めた。運営承認後に設定する。'),
      CAPACITY_THRESHOLD_INVALID: c('CAPACITY', 'high', '停止閾値が公式上限を超えているため、新規発行を止めた。設定を見直す。'),
      STORAGE_NEAR_LIMIT: c('CAPACITY', 'high', '状態保存の使用量が停止閾値に近づいたため、新規発行を止めた。保持期限の回収と容量見積もりを確認する。'),
      STORAGE_VALUE_NEAR_LIMIT: c('CAPACITY', 'high', '状態保存の1値が上限に近づいたため、新規発行を止めた。'),
      LOCK_UNAVAILABLE: c('SYSTEM', 'medium', '排他ロックを連続して取得できなかった。処理は送信せずに見送っている。実行状況を確認する。'),
      JOB_STALE: c('SYSTEM', 'high', '照合ジョブが所定時間実行されていない。トリガーと実行履歴を確認する。'),
      LEDGER_READ_FAILED: c('SYSTEM', 'high', '予約台帳を読めなかったため、照合を見送った。'),
      LEDGER_SCHEMA_INVALID: c('SYSTEM', 'high', '予約台帳の列構成が想定と異なるため、照合を止めた（revision列の移行状況を確認する）。'),
      WEBHOOK_INBOX_FULL: c('SYSTEM', 'medium', 'Webhookの退避枠が満杯になり、受信を取りこぼした可能性がある。該当操作は期限後にUNKNOWNとなる。'),
      API_BUDGET_EXHAUSTED: c('SYSTEM', 'high', '1日のAPI呼び出し予算に達したため、処理を見送った。'),
      ENV_MISMATCH: c('SYSTEM', 'high', '状態ストアの環境名が設定と一致しない。検証/本番の取り違えの可能性があるため停止した。'),
      CONFIG_INVALID: c('SYSTEM', 'high', '設定が不正のため停止した。'),
      ISSUE_GATE_ERROR: c('SYSTEM', 'high', '発行前の安全確認で内部エラーが発生したため、新規発行を止めた。'),
      SYNC_ERROR: c('SYSTEM', 'high', '照合中に内部エラーが発生し、処理を中断した（詳細は公開しない）。'),
      NOTIFY_BACKLOG: c('SYSTEM', 'high', '管理者通知の送達が連続して失敗している。通知経路を確認する。'),
      BOOKING_FROZEN: c('FROZEN', 'medium', '予約に鍵操作を止める条件がある（支払未確認・追加料金未了・要復旧・時刻不正など）。管理者が予約を確認する。既存キーは変更していない。'),
      DIGEST_MISMATCH: c('FROZEN', 'high', '予約の内容とrevisionが食い違っている。鍵操作を止めた。revision増分の漏れを確認する。')
    };
  })();

  var FREEZE_REASONS = ['REVISION_INVALID', 'BOOKING_INVALID', 'BRAND_UNKNOWN', 'TIME_INVALID', 'TIME_NOT_MINUTE_ALIGNED',
    'PAYMENT_UNVERIFIED', 'EXTENSION_CHARGE_PENDING', 'RECOVERY_REQUIRED', 'IDENTITY_INVALID'];

  function classify(code) {
    var c = typeof code === 'string' && CODE_RE.test(code) ? CATALOG[code] : null;
    return c ? { code: code, category: c.category, severity: c.severity, action: c.action }
      : { code: 'UNCLASSIFIED', category: 'UNCLASSIFIED', severity: 'high', action: '分類外の事象。管理者が実行ログと状態を確認する。' };
  }

  /** 通知本文。固定文言と検証済みの識別子だけ。自由文・例外メッセージ・秘密・完全ID・個人情報は入れない。 */
  function renderNotification(event) {
    event = event || {};
    var cl = classify(event.code);
    var ref = typeof event.ref === 'string' && REF_RE.test(event.ref) ? event.ref : '-';
    var rev = Number.isInteger(event.rev) ? String(event.rev) : '-';
    var dev = typeof event.device === 'string' && DEVICE_MASK_RE.test(event.device) ? event.device : '-';
    var states = Object.keys(Core.STATE).map(function (k) { return Core.STATE[k]; });
    var state = states.indexOf(event.state) !== -1 ? event.state : '-';
    var detail = typeof event.detail === 'string' && CODE_RE.test(event.detail) ? event.detail : '-';
    var env = typeof event.env === 'string' && /^[a-z]{1,16}$/.test(event.env) ? event.env : '-';
    return {
      subject: '[SNB鍵][' + env + '][' + cl.severity + '] ' + cl.category + ' ' + cl.code,
      body: ['区分: ' + cl.category, 'コード: ' + cl.code, '詳細: ' + detail, '予約参照: ' + ref, 'revision: ' + rev, '端末: ' + dev, '状態: ' + state,
        '', '対応: ' + cl.action, '', '※この通知に暗証番号・完全な端末ID・個人情報は含まれません。'].join('\n')
    };
  }

  // ---------- ランタイム ----------

  /**
   * deps:
   *   store    { get,set,del,keys }       状態（キャッシュしない実装であること）
   *   secrets  { get,set,del,keys }       秘密専用（状態と別の領域）
   *   lockService { tryLock, releaseLock }
   *   api      Core.createEngine の deps.api（listDevices/createKey/deleteKey）
   *   sendMail function(subject, body)    管理者宛。失敗時 throw
   *   ledger   { read({nowMs, trackedIds}) → {ok, records}|{ok:false} }
   *   snapshot AccessKeySnapshot
   *   sha256Hex, randomInt, nowSec, nowMs
   *   identity function() → {email}       管理者操作の実行者（Session由来）
   *   adminActors {email: label}
   *   deliverCode function(bookingRef, code, window) | null
   */
  function createRuntime(deps, cfg) {
    cfg = cfg || {};
    var ic = infraCfg(cfg);
    var lockDomain = createLockDomain(deps.lockService);
    var budget = createApiBudget(deps.store, deps.nowSec, ic.apiDailyBudget);
    var plan = planJobs(cfg);
    var coreConfig = Object.assign({}, cfg, { readWaitSec: plan.readWaitSec, maxReads: plan.maxReads, webhookWaitSec: plan.webhookWaitSec });
    var keypadIds = (cfg.keypads || []).map(function (k) { return k.deviceId; });

    // API 予算を数える薄いラッパ。予算超過時、読取は fail-closed（変更前の事前読取で止まり送信に進まない）。
    function guardedApi() {
      return {
        listDevices: function () {
          if (budget.exhausted()) return { ok: false, error: 'API_BUDGET' };
          budget.count();
          return deps.api.listDevices();
        },
        createKey: function (p) { budget.count(); return deps.api.createKey(p); },
        deleteKey: function (d, id) { budget.count(); return deps.api.deleteKey(d, id); }
      };
    }

    var notifier = {
      core: function (event) { var m = renderNotification(Object.assign({ env: cfg.environment }, event)); deps.sendMail(m.subject, m.body); }
    };

    var api = guardedApi();
    var engine = Core.createEngine({
      store: deps.store, secrets: deps.secrets, lock: lockDomain.coreLock, api: api,
      notifyAdmin: notifier.core, deliverCode: deps.deliverCode || function () { throw new Error('DELIVERY_NOT_CONFIGURED'); },
      sha256Hex: deps.sha256Hex, randomInt: deps.randomInt, nowSec: deps.nowSec,
      issueGate: issueGate
    }, coreConfig);

    // ---- 管理者通知（基盤事象）: 固定分類・重複抑止・失敗時の再送 ----
    function iaKey(code, ref, rev) { return 'IALERT_' + code + '_' + (ref || '-') + '_' + (rev === undefined || rev === null ? '-' : rev); }

    /** 基盤事象の通知。同一事象は repeatSec 内は再通知しない。送達失敗は次回以降バックオフ付きで再送。 */
    function infraAlert(code, ref, rev, detail, repeatSec) {
      var k = iaKey(code, ref, rev);
      var cur = safeParse(deps.store.get(k));
      var now = deps.nowSec();
      var rec = cur || { event: { code: code, ref: ref || undefined, rev: rev === undefined ? undefined : rev, detail: detail || undefined }, firstAt: now, sentAt: null, attempts: 0, lastTryAt: 0 };
      if (rec.sentAt !== null && now - rec.sentAt < (repeatSec || ic.notifyRepeatSec)) return false;
      if (rec.sentAt === null && rec.attempts > 0) {
        var wait = Math.min(ic.notifyBackoffMaxSec, ic.notifyBackoffBaseSec * Math.pow(2, Math.min(rec.attempts, 20)));
        if (now - rec.lastTryAt < wait) return false;
      }
      return trySend(k, rec);
    }

    function trySend(k, rec) {
      var now = deps.nowSec();
      rec.attempts += 1; rec.lastTryAt = now;
      try {
        var m = renderNotification(Object.assign({ env: cfg.environment }, rec.event));
        deps.sendMail(m.subject, m.body);
        rec.sentAt = now; rec.attempts = 0;
        deps.store.set(k, JSON.stringify(rec));
        return true;
      } catch (e) {
        rec.sentAt = null;
        try { deps.store.set(k, JSON.stringify(rec)); } catch (e2) { /* 記録不能でも次回の検知で再通知される */ }
        return false;
      }
    }

    /** 未送達の通知を再送する（バックオフ尊重）。 */
    function flushOutbox() {
      var now = deps.nowSec();
      var pending = 0, failing = 0;
      deps.store.keys().filter(function (k) { return k.indexOf('IALERT_') === 0; }).forEach(function (k) {
        var rec = safeParse(deps.store.get(k));
        if (!rec || rec.sentAt !== null) return;
        pending++;
        var wait = Math.min(ic.notifyBackoffMaxSec, ic.notifyBackoffBaseSec * Math.pow(2, Math.min(rec.attempts, 20)));
        if (rec.attempts > 0 && now - rec.lastTryAt < wait) { if (rec.attempts >= ic.notifyFailingAttempts) failing++; return; }
        if (!trySend(k, rec) && rec.attempts >= ic.notifyFailingAttempts) failing++;
      });
      return { pending: pending, failing: failing };
    }

    // ---- 新規発行ゲート（Keypad 容量・保存容量・API予算）----
    function issueGate(ctx) {
      // 発行直前に最新の登録件数を読む（読取のみ。失敗/予算超過は容量不明として安全停止）
      var out = null;
      try { out = api.listDevices(); } catch (e) { out = null; }
      var cap = keypadCapacityGate(out && out.ok === true ? out.devices : null, ctx.deviceId, cfg.capacity);
      if (!cap.ok) return { ok: false, code: cap.code };
      var st = storageGate(measureStore(deps.store), cfg, cfg.storageLimits);
      if (!st.ok) return { ok: false, code: st.code };
      if (budget.exhausted()) return { ok: false, code: 'API_BUDGET_EXHAUSTED' };
      return { ok: true };
    }

    // ---- ロック付き実行 ----
    function heartbeat(job, ok, code, startedMs) {
      try { deps.store.set('HB_' + job, JSON.stringify({ at: deps.nowSec(), ok: ok, code: code || null, ms: deps.nowMs() - startedMs })); } catch (e) { /* 次回 */ }
    }

    function runLocked(job, waitMs, fn) {
      var startedMs = deps.nowMs();
      var v = validateConfig(cfg);
      if (!v.ok) { infraAlert('CONFIG_INVALID', null, null, null); heartbeat(job, false, 'CONFIG_INVALID', startedMs); return { ok: false, error: 'CONFIG_INVALID' }; }
      var res;
      try { res = lockDomain.run(waitMs, function () {
        var envChk = ensureStoreEnvironment(deps.store, cfg.environment);
        if (!envChk.ok) { infraAlert('ENV_MISMATCH', null, null, null); return { ok: false, error: 'ENV_MISMATCH' }; }
        return fn();
      }); } catch (e) {
        infraAlert('SYNC_ERROR', null, null, null);
        heartbeat(job, false, 'SYNC_ERROR', startedMs);
        return { ok: false, error: 'SYNC_ERROR' };
      }
      if (!res.ran) {
        var n = (Number(deps.store.get('LOCKFAIL')) || 0) + 1;
        try { deps.store.set('LOCKFAIL', String(n)); } catch (e3) { /* 無視 */ }
        if (n >= ic.lockFailAlertStreak) infraAlert('LOCK_UNAVAILABLE', null, null, null);
        return { ok: false, error: 'LOCK_UNAVAILABLE' };
      }
      try { deps.store.set('LOCKFAIL', '0'); } catch (e4) { /* 無視 */ }
      var out = res.value || { ok: true };
      heartbeat(job, out.ok !== false, out.error || null, startedMs);
      return out;
    }

    // ---- Webhook ----
    function openOps() { return openWebhookOps(scanOps(deps.store)); }

    function parseBody(raw) {
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return null;
      return safeParse(raw);
    }

    /** 認証 → 最小化 → 相関 → 保存。未認証/相関不一致は何も保存しない。応答は固定。 */
    function handleWebhook(rawBody, token, expectedToken) {
      if (!authenticateWebhook(token, expectedToken)) return { accepted: false, reason: 'UNAUTHENTICATED' };
      var payload = parseBody(rawBody);
      if (!payload) return { accepted: false, reason: 'BAD_REQUEST' };
      var pre = correlateWebhook(payload, keypadIds, []);
      if (pre.reason === 'NOT_KEYPAD_EVENT' || pre.reason === 'DEVICE_MISSING' || pre.reason === 'DEVICE_NOT_TARGET') return { accepted: false, reason: pre.reason };
      var min = pre.minimized;
      var stored = null;
      var res = lockDomain.run(ic.webhookLockWaitMs, function () {
        var c = correlateWebhook(payload, keypadIds, openOps());
        if (!c.accept) return { accepted: false, reason: c.reason };
        var r = engine.ingestWebhook(c.minimized);
        return { accepted: true, stored: r.stored === true, duplicate: r.duplicate === true };
      });
      if (res.ran) { stored = res.value; return stored; }
      // ロック取得不能: 同じ認証・対象検証を満たした最小項目のみ受信箱へ（単一キー書込み。上限あり）
      var n = deps.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).length;
      if (n >= ic.inboxMax) { infraAlert('WEBHOOK_INBOX_FULL', null, null, null); return { accepted: false, reason: 'INBOX_FULL' }; }
      var ik = 'INBOX_' + min.context.deviceMac + '_' + min.context.eventName + '_' + min.context.commandId + '_' + min.context.result; // 結果ごとに保持（食い違いをコアの矛盾検知へ渡す）
      if (deps.store.get(ik)) return { accepted: true, queued: true, duplicate: true };
      try { deps.store.set(ik, JSON.stringify({ at: deps.nowSec(), payload: min })); } catch (e) { return { accepted: false, reason: 'STORE_FAILED' }; }
      return { accepted: true, queued: true };
    }

    /** ロック下で受信箱を相関付きで取り込む。一致しないものは期限まで保持（先着の可能性）、期限後に回収。 */
    function drainInbox() {
      var now = deps.nowSec();
      var ops = openOps();
      var entries = [];
      deps.store.keys().filter(function (k) { return k.indexOf('INBOX_') === 0; }).forEach(function (k) {
        var e = safeParse(deps.store.get(k));
        if (!e || typeof e.at !== 'number' || now - e.at > ic.inboxTtlSec) { deps.store.del(k); return; }
        entries.push({ k: k, e: e });
      });
      entries.sort(function (x, y) { return x.e.at - y.e.at; }); // 到着順に渡す（先着維持・後続の食い違いは矛盾印）
      entries.forEach(function (it) {
        var k = it.k, e = it.e;
        var c = correlateWebhook(e.payload, keypadIds, ops);
        if (!c.accept) return;
        var r = engine.ingestWebhook(c.minimized);
        // 受信時刻は到着時刻を保つ（取込時刻にすると遅延到着を期限内と偽る）
        if (r.stored) { var evk = 'EVT_' + c.minimized.context.deviceMac + '_' + c.minimized.context.eventName + '_' + c.minimized.context.commandId;
          var ev = safeParse(deps.store.get(evk)); if (ev) { ev.receivedAtSec = e.at; deps.store.set(evk, JSON.stringify(ev)); } }
        deps.store.del(k);
      });
    }

    // ---- 追跡 ----
    function readTrack(bookingId) { return safeParse(deps.store.get('TRK_' + bookingId)); }
    function writeTrack(bookingId, t) { deps.store.set('TRK_' + bookingId, JSON.stringify(t)); }

    // ---- 照合サイクル（5分）----
    function syncCycle() {
      return runLocked('SYNC', ic.lockWaitMs, function () {
        var startedMs = deps.nowMs();
        drainInbox();
        flushOutbox();
        if (cfg.enabled !== true) return { ok: true, skipped: 'FLAG_OFF' };
        if (budget.exhausted()) { infraAlert('API_BUDGET_EXHAUSTED', null, null, null); return { ok: false, error: 'API_BUDGET_EXHAUSTED' }; }
        var ops = scanOps(deps.store);
        var openByBooking = {};
        ops.forEach(function (r) { if (isUnresolved(r)) openByBooking[r.bookingId] = true; });
        var nowMs = deps.nowMs();
        var led = deps.ledger.read({ nowMs: nowMs, trackedIds: Object.keys(openByBooking) });
        if (!led || led.ok !== true) {
          infraAlert(led && led.error === 'LEDGER_SCHEMA_INVALID' ? 'LEDGER_SCHEMA_INVALID' : 'LEDGER_READ_FAILED', null, null, null);
          return { ok: false, error: 'LEDGER_READ_FAILED' };
        }
        var records = led.records.slice().sort(function (a, b) {
          return (openByBooking[String(b.bookingId)] ? 1 : 0) - (openByBooking[String(a.bookingId)] ? 1 : 0);
        });
        var summary = { ok: true, synced: 0, frozen: 0, waiting: 0, skipped: 0, deferred: 0, gateStops: [] };
        for (var i = 0; i < records.length; i++) {
          if (deps.nowMs() - startedMs > ic.runBudgetSec * 1000) { summary.deferred = records.length - i; break; }
          var sn = deps.snapshot.build(records[i], { facility: cfg.ledgerTarget.facility, room: cfg.ledgerTarget.room });
          var input = deps.snapshot.toCoreInput(sn, nowMs);
          var tr = readTrack(sn.bookingId);
          if (input.action === 'FREEZE') {
            var reasons = input.reasons.length ? input.reasons : ['IDENTITY_INVALID'];
            reasons.forEach(function (r) { if (FREEZE_REASONS.indexOf(r) !== -1) infraAlert('BOOKING_FROZEN', safeRef(sn.bookingId), sn.revision, r); });
            summary.frozen++;
            continue;
          }
          if (tr && tr.revision === sn.revision && tr.digest && tr.digest !== sn.digest) {
            infraAlert('DIGEST_MISMATCH', safeRef(sn.bookingId), sn.revision, null);
            summary.frozen++;
            continue;
          }
          var reasonsT = deps.snapshot.triggers(sn, { revision: tr ? tr.revision : null, issueWindowHandled: !!(tr && tr.windowHandled), openKeyRecord: !!openByBooking[sn.bookingId] }, nowMs);
          if (!reasonsT.length) { summary.skipped++; continue; }
          // 静穏時間: 同じ (revision, digest) を quietSec 以上前から観測している場合のみ同期（精算中の中間状態で発行しない）
          var nowS = deps.nowSec();
          var sameObs = tr && tr.obsRevision === sn.revision && tr.obsDigest === sn.digest;
          if (!sameObs) {
            writeTrack(sn.bookingId, Object.assign({}, tr || {}, { obsRevision: sn.revision, obsDigest: sn.digest, obsAt: nowS, seenAt: nowS }));
            summary.waiting++;
            continue;
          }
          if (nowS - tr.obsAt < ic.quietSec) { summary.waiting++; continue; }
          // 発行ゲートで止まった予約は、再評価の間隔を空ける（OP が無い間のみ。進行中 OP の照合は止めない）
          if (tr.gateHoldUntil && nowS < tr.gateHoldUntil && !openByBooking[sn.bookingId]) { summary.waiting++; continue; }
          var out;
          try { out = engine.sync(input.booking); }
          catch (e) {
            infraAlert('SYNC_ERROR', safeRef(sn.bookingId), sn.revision, null);
            return { ok: false, error: 'SYNC_ERROR' }; // 保存失敗などはサイクルを止める（予約側へは何も伝播しない）
          }
          summary.synced++;
          if (out.gateStop) {
            // 発行を試行できなかった（OP未作成/未送信）。revision・発行窓は「未処理」のまま保持し、
            // 次回以降ゲートを再評価する（復旧後に発行対象から脱落させない）。通知は重複抑止、再評価は gateRetrySec 間隔
            summary.gateStops.push(out.gateStop);
            infraAlert(out.gateStop, null, null, null);
            writeTrack(sn.bookingId, { revision: tr ? tr.revision : null, digest: tr ? tr.digest : undefined, windowHandled: tr ? !!tr.windowHandled : false,
              obsRevision: sn.revision, obsDigest: sn.digest, obsAt: tr.obsAt, seenAt: nowS, gateHoldUntil: nowS + ic.gateRetrySec });
            continue;
          }
          var windowOpen = sn.status === 'CONFIRMED' && deps.snapshot.issueWindow(sn, nowMs).open;
          // 保存に失敗した TRK は次回再同期になるだけ（コアは冪等）
          writeTrack(sn.bookingId, { revision: sn.revision, digest: sn.digest, windowHandled: windowOpen, obsRevision: sn.revision, obsDigest: sn.digest, obsAt: tr ? tr.obsAt : nowS, seenAt: nowS });
        }
        return summary;
      });
    }

    function safeRef(id) { return typeof id === 'string' && REF_RE.test(id) ? id : undefined; }

    // ---- 配送（OFF時は停止。#752 の配送が未接続なら何もしない）----
    function deliverCycle() {
      return runLocked('DELIVER', ic.lockWaitMs, function () {
        if (cfg.enabled !== true) return { ok: true, skipped: 'FLAG_OFF' };
        if (cfg.deliveryConfigured !== true || typeof deps.deliverCode !== 'function') return { ok: true, skipped: 'DELIVERY_NOT_CONFIGURED' };
        var delivered = 0, failed = 0;
        scanOps(deps.store).forEach(function (r) {
          if (r.state !== Core.STATE.ISSUED_CONFIRMED || r.deliveredAtSec) return;
          var d = engine.deliver(r.id);
          if (d.delivered) delivered++; else if (d.reason === 'DELIVER_FAILED') failed++;
        });
        return { ok: true, delivered: delivered, failed: failed };
      });
    }

    // ---- 期限切れ確認・回収・容量/保存の監視 ----
    function sweepCycle() {
      return runLocked('SWEEP', ic.lockWaitMs, function () {
        drainInbox();
        flushOutbox();
        engine.sweep();
        var removed = garbageCollect(deps.store, deps.secrets, deps.nowSec(), cfg);
        var st = storageGate(measureStore(deps.store), cfg, cfg.storageLimits);
        if (!st.ok) infraAlert(st.code, null, null, null);
        return { ok: true, removed: removed, storage: { ratio: st.ratio, ok: st.ok } };
      });
    }

    // ---- 監視（ロック不要・読取のみ）----
    function watchdog() {
      var now = deps.nowSec();
      var res = { ok: true, stale: false };
      if (cfg.enabled === true) {
        var hb = safeParse(deps.store.get('HB_SYNC'));
        if (!hb || now - hb.at > ic.heartbeatStaleSec) { infraAlert('JOB_STALE', null, null, null); res.stale = true; }
      }
      var fl = flushOutbox();
      if (fl.failing > 0) { try { deps.store.set('NOTIFYFAIL', String(now)); } catch (e) { /* 無視 */ } }
      res.outbox = fl;
      return res;
    }

    // ---- 管理者操作（フラグOFFでも使用可）----
    var ADMIN_ACTIONS = ['status', 'inventory', 'inspect', 'reconcile', 'resolveUnknown', 'delete'];

    function auditAdmin(actor, action, ref, outcome) {
      var k = 'ADMINLOG_' + deps.nowSec() + '_' + deps.randomInt(1000000);
      try { deps.store.set(k, JSON.stringify({ at: deps.nowSec(), actor: actor, action: action, ref: ref || null, outcome: outcome })); } catch (e) { /* 監査失敗は操作拒否にする（呼出側） */ return false; }
      return true;
    }

    function admin(action, args) {
      args = args || {};
      var who = authorizeAdmin(deps.identity ? deps.identity() : null, deps.adminActors);
      if (!who.ok) return { ok: false, error: who.error };
      if (ADMIN_ACTIONS.indexOf(action) === -1) return { ok: false, error: 'UNKNOWN_ACTION' };
      var recId = args.recId;
      var needsRec = action !== 'status' && action !== 'inventory';
      if (needsRec && (typeof recId !== 'string' || !REC_ID_RE.test(recId))) return { ok: false, error: 'RECORD_ID_INVALID' };
      if (action === 'resolveUnknown' && ['CONFIRM_PRESENT', 'ABANDON_ABSENT'].indexOf(args.decision) === -1) return { ok: false, error: 'DECISION_INVALID' };
      var out = runLocked('ADMIN', ic.lockWaitMs, function () {
        // 変更系は監査の事前記録に失敗したら実行しない
        var mutating = action === 'reconcile' || action === 'resolveUnknown' || action === 'delete';
        if (action !== 'status' && action !== 'inventory') drainInbox(); // 期限内に退避された根拠を、管理者の照合前に反映する
        if (mutating && !auditAdmin(who.actor, action, recId, 'ATTEMPT')) return { ok: false, error: 'AUDIT_UNAVAILABLE' };
        var r;
        if (action === 'status') r = statusLocked();
        else if (action === 'inventory') r = { ok: true, items: engine.inventory() };
        else if (action === 'inspect') r = engine.adminInspect(recId);
        else if (action === 'reconcile') r = engine.adminReconcile(recId, who.actor);
        else if (action === 'resolveUnknown') r = engine.adminResolveUnknown(recId, args.decision, who.actor);
        else r = engine.adminDelete(recId, who.actor);
        if (mutating) auditAdmin(who.actor, action, recId, r && r.ok ? 'OK' : (r && r.error) || 'FAILED');
        return r;
      });
      return out;
    }

    function statusLocked() {
      var ops = scanOps(deps.store);
      var byState = {}, unresolved = 0;
      ops.forEach(function (r) { byState[r.state] = (byState[r.state] || 0) + 1; if (isUnresolved(r)) unresolved++; });
      var m = measureStore(deps.store);
      var st = storageGate(m, cfg, cfg.storageLimits);
      var outbox = { pending: 0 };
      deps.store.keys().forEach(function (k) { if (k.indexOf('IALERT_') === 0) { var x = safeParse(deps.store.get(k)); if (x && x.sentAt === null) outbox.pending++; } });
      return {
        ok: true, environment: cfg.environment, enabled: cfg.enabled === true, byState: byState, unresolved: unresolved,
        storage: { keys: m.keys, bytes: m.bytes, ratio: st.ratio, gate: st.ok ? 'OK' : st.code, byPrefix: m.byPrefix },
        heartbeats: { SYNC: safeParse(deps.store.get('HB_SYNC')), SWEEP: safeParse(deps.store.get('HB_SWEEP')), DELIVER: safeParse(deps.store.get('HB_DELIVER')) },
        apiCallsToday: budget.used(), notifyOutbox: outbox, notifyFailingSince: Number(deps.store.get('NOTIFYFAIL')) || null,
        plan: plan
      };
    }

    return {
      handleWebhook: handleWebhook, syncCycle: syncCycle, deliverCycle: deliverCycle, sweepCycle: sweepCycle,
      watchdog: watchdog, admin: admin, engine: engine, plan: plan, infraAlert: infraAlert
    };
  }

  return {
    ENVIRONMENT: ENVIRONMENT, PROPERTIES_LIMITS: PROPERTIES_LIMITS, DEFAULTS: DEFAULTS, CATALOG: CATALOG, FREEZE_REASONS: FREEZE_REASONS,
    validateConfig: validateConfig, ensureStoreEnvironment: ensureStoreEnvironment,
    constantTimeEquals: constantTimeEquals, authenticateWebhook: authenticateWebhook, authorizeAdmin: authorizeAdmin,
    CREDENTIAL_NAMES: CREDENTIAL_NAMES, validateCredentialInput: validateCredentialInput, setupCredentials: setupCredentials, credentialStatus: credentialStatus,
    minimizeWebhook: minimizeWebhook, openWebhookOps: openWebhookOps, correlateWebhook: correlateWebhook,
    createLockDomain: createLockDomain, keypadCapacityGate: keypadCapacityGate,
    byteLength: byteLength, measureStore: measureStore, storageGate: storageGate, estimateStorage: estimateStorage,
    garbageCollect: garbageCollect, planJobs: planJobs, createApiBudget: createApiBudget,
    classify: classify, renderNotification: renderNotification, createRuntime: createRuntime
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SwitchBotAccessInfra;
}
