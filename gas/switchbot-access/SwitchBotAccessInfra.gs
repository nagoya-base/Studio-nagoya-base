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
    // キー未発行対策（#885 第3弾）。いずれも「利用開始時刻までの残り秒」。開始15分前から優先再試行、5分前から緊急通知。
    priorityRetryLeadSec: 900,
    warningNoticeLeadSec: 600,
    urgentNoticeLeadSec: 300,
    startedRenotifySec: 600,
    // 緊急通知（KEY_UNCONFIRMED_*）の再送は一般通知より短い間隔に抑え、数回の失敗で「不達」と判定する
    urgentNotifyBackoffMaxSec: 120,
    urgentNotifyFailingAttempts: 2,
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
    // 優先再試行・緊急通知の閾値は正の有限数かつ「優先再試行 > 緊急通知」のときだけ採用する（不正なら既定値へ戻す）
    ['priorityRetryLeadSec', 'warningNoticeLeadSec', 'urgentNoticeLeadSec', 'startedRenotifySec', 'urgentNotifyBackoffMaxSec', 'urgentNotifyFailingAttempts'].forEach(function (k) {
      if (typeof out[k] !== 'number' || !isFinite(out[k]) || out[k] <= 0) out[k] = DEFAULTS[k];
    });
    if (!(out.priorityRetryLeadSec > out.warningNoticeLeadSec && out.warningNoticeLeadSec > out.urgentNoticeLeadSec)) {
      out.priorityRetryLeadSec = DEFAULTS.priorityRetryLeadSec;
      out.warningNoticeLeadSec = DEFAULTS.warningNoticeLeadSec;
      out.urgentNoticeLeadSec = DEFAULTS.urgentNoticeLeadSec;
    }
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

  // ---------- キー未発行対策（#885 第3弾）: 純粋判定 ----------

  /** 緊急通知（KEY_UNCONFIRMED_*）のコード。再送間隔と不達判定が一般通知より厳しい。 */
  var URGENT_CODES = ['KEY_UNCONFIRMED_WARNING', 'KEY_UNCONFIRMED_URGENT', 'KEY_UNCONFIRMED_STARTED'];
  /** 通知コードごとに必要な最低段階（送信直前の再検証で、段階が下回る通知は失効させる）。 */
  var URGENT_CODE_LEVEL = { KEY_UNCONFIRMED_WARNING: 'WARNING', KEY_UNCONFIRMED_URGENT: 'URGENT', KEY_UNCONFIRMED_STARTED: 'STARTED' };
  var LEVEL_RANK = { NONE: 0, PRIORITY: 1, WARNING: 2, URGENT: 3, STARTED: 4 };

  /**
   * 利用開始までの残り時間から、キー未発行時の対応段階を決める（鍵の有無は見ない。時刻のみの純粋関数）。
   *  - NONE:     まだ早い、または利用終了済み
   *  - PRIORITY: 開始 priorityRetryLeadSec(既定15分) 以内 … 優先再試行（通知はしない）
   *  - WARNING:  開始 warningNoticeLeadSec(既定10分) 以内 … 反映未確認の初回警告
   *  - URGENT:   開始 urgentNoticeLeadSec(既定5分) 以内 … 運営者へ緊急通知
   *  - STARTED:  開始時刻を過ぎた（終了前）… 代替入室へエスカレーション。未解決の間は一定間隔で再通知し、安全な再試行は続ける
   * 境界: 残りちょうど各閾値はその段階（15分=PRIORITY／10分=WARNING／5分=URGENT）、開始ちょうどは STARTED。
   * startSec/endSec は予約の利用時刻（キー有効期間の前後の許容時間を含めない）。
   */
  function keyReadinessLevel(nowSec, startSec, endSec, ic) {
    if (typeof nowSec !== 'number' || typeof startSec !== 'number' || typeof endSec !== 'number') return 'NONE';
    if (!isFinite(nowSec) || !isFinite(startSec) || !isFinite(endSec) || startSec >= endSec) return 'NONE';
    if (nowSec >= endSec) return 'NONE';
    var remain = startSec - nowSec;
    if (remain <= 0) return 'STARTED';
    if (remain <= ic.urgentNoticeLeadSec) return 'URGENT';
    if (remain <= ic.warningNoticeLeadSec) return 'WARNING';
    if (remain <= ic.priorityRetryLeadSec) return 'PRIORITY';
    return 'NONE';
  }

  /** 現行の予約内容（改訂・端末・有効期間）に一致する、発行確認済み(ISSUED_CONFIRMED)の個別キーがあるか。 */
  function hasConfirmedKey(opsOfBooking, revision, elig) {
    return (opsOfBooking || []).some(function (r) {
      return r && r.op === Core.OP.ISSUE && r.state === Core.STATE.ISSUED_CONFIRMED && r.revision === revision &&
        r.startSec === elig.startSec && r.endSec === elig.endSec && r.deviceId === elig.deviceId;
    });
  }

  // ---------- 環境分離・設定検証 ----------

  /**
   * 検証/本番の取り違えを送信前に止める。環境名・許可する末尾4桁・対応表が矛盾すれば不正。
   * 本番に自宅検証機(例 37DD)、検証に本番機(例 01FD)を載せられない（allowedLast4 は環境ごとの別設定）。
   */
  /** 予約GAS（Booking.ALLOWED_BOOKING_BRANDS）が受け付けるブランド。空文字・未知の値は含めない。 */
  var KNOWN_BRANDS = ['snb', 'mens', 'studio_x'];

  function validateConfig(cfg) {
    var errors = [];
    cfg = cfg || {};
    // 設定読込（loadConfig。#859）で見つかった問題は、そのまま設定不備として拒否する（fail-closed）
    if (Array.isArray(cfg.configLoadErrors)) cfg.configLoadErrors.forEach(function (e) { errors.push(typeof e === 'string' && CODE_RE.test(e) ? e : 'CONFIG_LOAD_ERROR'); });
    else if (cfg.configLoadErrors !== undefined) errors.push('CONFIG_LOAD_ERROR');
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
    if (cfg.delivery !== undefined && !deliverySettings(cfg)) errors.push('DELIVERY_CONFIG_INVALID');
    // eligibleBrands は「鍵発行の対象ブランド」。未設定は発行対象なし（コアが BRAND_NOT_TARGET で止める）なので許容するが、
    // 設定されている場合は既知の予約ブランドだけを許す。空文字・未知・非文字列・非配列は設定不備として拒否する（#754）。
    if (cfg.eligibleBrands !== undefined) {
      var eb = cfg.eligibleBrands;
      if (!Array.isArray(eb) || eb.some(function (b) { return KNOWN_BRANDS.indexOf(b) === -1; })) errors.push('ELIGIBLE_BRANDS_INVALID');
    }
    // pilotBookingIds は限定稼働用の予約ID許可リスト（#757）。設定する場合は空でない文字列の配列のみ（空配列は全件停止として許容）。
    if (cfg.pilotBookingIds !== undefined) {
      var pb = cfg.pilotBookingIds;
      if (!Array.isArray(pb) || pb.some(function (x) { return typeof x !== 'string' || !x; })) errors.push('PILOT_BOOKING_IDS_INVALID');
    }
    // 限定稼働モード（#757）: limitedRollout=true のときは対象予約ID1件の明示設定が必須（欠落・複数は PILOT_REQUIRED で起動拒否）。
    // 通常モード（limitedRollout 未設定）は pilotBookingIds 未設定でも従来どおり有効。limitedRollout は true／未設定のみ許容。
    if (cfg.limitedRollout !== undefined && cfg.limitedRollout !== true && cfg.limitedRollout !== false) errors.push('LIMITED_ROLLOUT_INVALID');
    if (cfg.limitedRollout === true && (!Array.isArray(cfg.pilotBookingIds) || cfg.pilotBookingIds.length !== 1)) errors.push('PILOT_REQUIRED');
    return { ok: errors.length === 0, errors: errors.filter(function (e, i) { return errors.indexOf(e) === i; }) };
  }

  // ---------- 設定の読込（Issue #859。旧 ACCESS_CONFIG 一括JSON ／ 分割プロパティ split-v1）----------
  //
  // 正本は常に一箇所。ACCESS_CONFIG_FORMAT が未設定なら旧形式（ACCESS_CONFIG のみ）、'split-v1' なら分割形式のみを読む。
  // 旧・新の暗黙マージや上書き優先順位は作らない。もう一方の形式のプロパティが残っていれば CONFIG_SOURCE_MIXED で拒否する
  // （移行・ロールバックの途中＝不整合状態では発行しない）。読込エラーがあると enabled=false かつ validateConfig が失敗する。
  // ここは Script Properties を読むだけ（書込み・通信なし）。値はエラーコードに含めない。

  var CONFIG_FORMAT_PROP = 'ACCESS_CONFIG_FORMAT';
  var CONFIG_FORMAT_SPLIT = 'split-v1';
  var LEGACY_CONFIG_PROP = 'ACCESS_CONFIG';
  /** 分割形式（split-v1）のプロパティ。高頻度の運営設定は独立プロパティ、低頻度の構造化設定は小さなJSON。 */
  var SPLIT_PROPS = {
    CORE: 'ACCESS_CORE_CONFIG',              // JSON: 商用承認・支払根拠・台帳対象・容量/保持など（低頻度）
    DEVICES: 'ACCESS_DEVICES',               // JSON: environment・allowedLast4・keypads（端末対応。低頻度）
    DELIVERY: 'ACCESS_DELIVERY',             // JSON: adminMailTo・deliveryConfigured・delivery（配送・通知先。低頻度）
    BRANDS: 'ACCESS_ELIGIBLE_BRANDS',        // JSON配列: 発行対象ブランド（例 ["mens"]）
    LIMITED: 'ACCESS_LIMITED_ROLLOUT',       // 'true' | 'false'
    PILOT: 'ACCESS_PILOT_BOOKING_IDS',       // JSON配列: 限定モードの予約ID（ちょうど1件）。限定モードOFFでは設定しない
    GRACE_BEFORE: 'ACCESS_GRACE_BEFORE_SEC', // 整数秒（0〜86400）
    GRACE_AFTER: 'ACCESS_GRACE_AFTER_SEC'    // 整数秒（0〜86400）
  };
  var SPLIT_PROP_NAMES = Object.keys(SPLIT_PROPS).map(function (k) { return SPLIT_PROPS[k]; });
  /** 各JSONに置いてよいキー。高頻度設定（ブランド・限定モード・予約ID・猶予）や enabled はJSONに置けない（二重管理の禁止）。 */
  var SPLIT_JSON_KEYS = {
    CORE: { required: ['commercialUseApproved', 'eligiblePaymentStatuses', 'ledgerTarget'],
      // 旧形式で使える運用パラメータはすべて移行できるようにする（未設定時の既定値は旧形式と同じ。例: autoDeleteExpired=false を落とすと自動削除が有効に戻る）
      optional: ['capacity', 'storageLimits', 'infra', 'maxReads', 'webhookWaitSec', 'readWaitSec', 'dailyCleanupMaxDeletes',
        'autoDeleteExpired', 'expiredDeleteMaxPerSweep', 'retentionSec', 'deleteFreshSec'] },
    DEVICES: { required: ['environment', 'allowedLast4', 'keypads'], optional: [] },
    DELIVERY: { required: ['adminMailTo', 'deliveryConfigured'], optional: ['delivery', 'maxDeliveryAttempts', 'deliveryRetrySec', 'maxReguides'] }
  };
  /** 支払根拠の語彙（AccessKeySnapshot.PAYMENT_BASIS）。UNVERIFIED や台帳の生値（not_started 等）は許可しない。 */
  var ELIGIBLE_PAYMENT_BASIS = ['STRIPE_PAID', 'ADMIN_APPROVED'];
  var PILOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  var GRACE_MAX_SEC = 86400;

  function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function hasDup(arr) { return arr.some(function (x, i) { return arr.indexOf(x) !== i; }); }

  /** read(name) → { state: SET|MISSING|UNKNOWN, raw }。例外・undefined は UNKNOWN（MISSING に潰さない）。 */
  function readProp(read, name) {
    var v;
    try { v = read(name); } catch (e) { return { state: 'UNKNOWN', raw: null }; }
    if (v === undefined) return { state: 'UNKNOWN', raw: null };
    return v === null || v === '' ? { state: 'MISSING', raw: null } : { state: 'SET', raw: String(v) };
  }

  /** 分割形式の小さなJSON（オブジェクト）を読む。未知キー・必須キー欠落は拒否。 */
  function splitJson(r, part, errors) {
    var prefix = part + '_CONFIG';
    if (r.state !== 'SET') { errors.push(prefix + '_' + (r.state === 'MISSING' ? 'MISSING' : 'UNREADABLE')); return null; }
    var obj = safeParse(r.raw);
    if (!isPlainObject(obj)) { errors.push(prefix + '_PARSE_ERROR'); return null; }
    var spec = SPLIT_JSON_KEYS[part];
    var allowed = spec.required.concat(spec.optional);
    if (Object.keys(obj).some(function (k) { return allowed.indexOf(k) === -1; })) errors.push(prefix + '_UNKNOWN_KEY');
    if (spec.required.some(function (k) { return obj[k] === undefined; })) errors.push(prefix + '_KEY_MISSING');
    return obj;
  }

  /** JSON配列の文字列プロパティ（空・重複・非文字列・形式不一致は拒否）。 */
  function splitStringArray(r, code, itemOk, errors, allowMissing) {
    if (r.state === 'MISSING' && allowMissing) return undefined;
    if (r.state !== 'SET') { errors.push(code + '_' + (r.state === 'MISSING' ? 'MISSING' : 'UNREADABLE')); return null; }
    var arr = safeParse(r.raw);
    if (!Array.isArray(arr)) { errors.push(code + '_PARSE_ERROR'); return null; }
    if (!arr.length) { errors.push(code + '_EMPTY'); return null; }
    if (arr.some(function (x) { return typeof x !== 'string' || !itemOk(x); })) { errors.push(code + '_INVALID'); return null; }
    if (hasDup(arr)) { errors.push(code + '_DUPLICATE'); return null; }
    return arr;
  }

  function splitGrace(r, code, errors) {
    if (r.state !== 'SET') { errors.push(code + '_' + (r.state === 'MISSING' ? 'MISSING' : 'UNREADABLE')); return null; }
    if (!/^(0|[1-9][0-9]{0,5})$/.test(r.raw)) { errors.push(code + '_INVALID'); return null; }
    var n = Number(r.raw);
    if (n > GRACE_MAX_SEC) { errors.push(code + '_INVALID'); return null; }
    return n;
  }

  /** 分割形式の端末対応の追加検査（旧形式より厳格）: brand 既知・facility 必須・キー限定・brand+facility+room の重複禁止。 */
  function splitKeypadErrors(kps, errors) {
    if (!Array.isArray(kps)) return;
    var seen = [];
    kps.forEach(function (k) {
      if (!isPlainObject(k) || Object.keys(k).some(function (x) { return ['brand', 'facility', 'room', 'deviceId'].indexOf(x) === -1; })) { errors.push('KEYPAD_ENTRY_INVALID'); return; }
      if (KNOWN_BRANDS.indexOf(k.brand) === -1) errors.push('KEYPAD_BRAND_INVALID');
      if (typeof k.facility !== 'string' || !k.facility) errors.push('KEYPAD_FACILITY_INVALID');
      if (k.room !== undefined && k.room !== null && (typeof k.room !== 'string' || !k.room)) errors.push('KEYPAD_ROOM_INVALID');
      var key = JSON.stringify([k.brand, k.facility, k.room === undefined ? null : k.room]);
      if (seen.indexOf(key) !== -1) errors.push('KEYPAD_DUPLICATE');
      seen.push(key);
    });
    // allowedLast4 との照合は validateConfig（KEYPAD_NOT_ALLOWED_IN_ENV）が旧・新共通で行う
  }

  /**
   * 設定を読み込む。read(name) は Script Properties の getProperty 相当（読取のみ）。
   * 戻り値 { cfg, source: 'LEGACY' | 'SPLIT_V1' | 'UNKNOWN', errors: [固定コード], props: { 名前: SET|MISSING|UNKNOWN } }
   * cfg.enabled は ACCESS_ENABLED==='true' かつ errors が空のときだけ true。ACCESS_ENVIRONMENT と設定の environment が
   * 一致しなければ environment='__MISMATCH__'（従来どおり起動しない）。errors は cfg.configLoadErrors にも入れ、validateConfig が拒否する。
   */
  function loadConfig(read) {
    var errors = [];
    var props = {};
    function rp(name) { var r = readProp(read, name); props[name] = r.state; return r; }
    var fmt = rp(CONFIG_FORMAT_PROP);
    var legacy = rp(LEGACY_CONFIG_PROP);
    var split = {};
    Object.keys(SPLIT_PROPS).forEach(function (k) { split[k] = rp(SPLIT_PROPS[k]); });
    var envProp = rp('ACCESS_ENVIRONMENT');
    var flag = rp('ACCESS_ENABLED');
    var splitPresent = Object.keys(split).filter(function (k) { return split[k].state !== 'MISSING'; });
    var cfg = {};
    var source;

    if (fmt.state === 'UNKNOWN') { source = 'UNKNOWN'; errors.push('CONFIG_FORMAT_UNREADABLE'); }
    else if (fmt.state === 'MISSING') {
      source = 'LEGACY';
      if (splitPresent.length) errors.push('CONFIG_SOURCE_MIXED');
      if (legacy.state === 'SET') {
        var parsed = safeParse(legacy.raw);
        if (isPlainObject(parsed)) cfg = parsed; else errors.push('LEGACY_CONFIG_PARSE_ERROR');
      } else errors.push(legacy.state === 'MISSING' ? 'LEGACY_CONFIG_MISSING' : 'LEGACY_CONFIG_UNREADABLE');
    } else if (fmt.raw !== CONFIG_FORMAT_SPLIT) { source = 'UNKNOWN'; errors.push('CONFIG_FORMAT_INVALID'); }
    else {
      source = 'SPLIT_V1';
      if (legacy.state !== 'MISSING') errors.push('CONFIG_SOURCE_MIXED');
      var core = splitJson(split.CORE, 'CORE', errors);
      var dev = splitJson(split.DEVICES, 'DEVICES', errors);
      var dlv = splitJson(split.DELIVERY, 'DELIVERY', errors);
      [core, dev, dlv].forEach(function (o) { if (o) Object.keys(o).forEach(function (k) { cfg[k] = o[k]; }); });
      if (core) {
        if (typeof core.commercialUseApproved !== 'boolean') errors.push('COMMERCIAL_USE_INVALID');
        var ps = core.eligiblePaymentStatuses;
        if (!Array.isArray(ps) || !ps.length || ps.some(function (x) { return ELIGIBLE_PAYMENT_BASIS.indexOf(x) === -1; }) || hasDup(ps)) errors.push('PAYMENT_STATUSES_INVALID');
      }
      if (dev) splitKeypadErrors(dev.keypads, errors);
      if (dlv) {
        if (typeof dlv.deliveryConfigured !== 'boolean') errors.push('DELIVERY_CONFIGURED_INVALID');
        if (dlv.deliveryConfigured === true && dlv.delivery === undefined) errors.push('DELIVERY_SETTINGS_MISSING');
      }
      var brands = splitStringArray(split.BRANDS, 'ELIGIBLE_BRANDS', function (b) { return KNOWN_BRANDS.indexOf(b) !== -1; }, errors, false);
      if (brands) cfg.eligibleBrands = brands;
      var limited = null;
      if (split.LIMITED.state !== 'SET') errors.push('LIMITED_ROLLOUT_' + (split.LIMITED.state === 'MISSING' ? 'MISSING' : 'UNREADABLE'));
      else if (split.LIMITED.raw === 'true') limited = true;
      else if (split.LIMITED.raw === 'false') limited = false;
      else errors.push('LIMITED_ROLLOUT_INVALID');
      if (limited !== null) cfg.limitedRollout = limited;
      var pilot = splitStringArray(split.PILOT, 'PILOT_BOOKING_IDS', function (x) { return PILOT_ID_RE.test(x); }, errors, true);
      if (limited === true) {
        if (pilot === undefined) errors.push('PILOT_REQUIRED');
        else if (pilot && pilot.length !== 1) errors.push('PILOT_BOOKING_IDS_NOT_SINGLE');
      }
      // 限定モードOFFで予約IDだけ残すと「全件なのか限定なのか」が曖昧になるため拒否（解除は両方を外す）
      if (limited === false && split.PILOT.state !== 'MISSING') errors.push('PILOT_WITHOUT_LIMITED_ROLLOUT');
      if (pilot) cfg.pilotBookingIds = pilot;
      var gb = splitGrace(split.GRACE_BEFORE, 'GRACE_BEFORE', errors);
      var ga = splitGrace(split.GRACE_AFTER, 'GRACE_AFTER', errors);
      if (gb !== null) cfg.graceBeforeSec = gb;
      if (ga !== null) cfg.graceAfterSec = ga;
    }

    if (envProp.state !== 'SET' || envProp.raw !== cfg.environment) cfg.environment = '__MISMATCH__';
    var uniq = errors.filter(function (e, i) { return errors.indexOf(e) === i; });
    cfg.enabled = flag.state === 'SET' && flag.raw === 'true' && uniq.length === 0;
    if (uniq.length) cfg.configLoadErrors = uniq;
    else delete cfg.configLoadErrors;
    return { cfg: cfg, source: source, errors: uniq, props: props };
  }

  /**
   * 発行前提の診断（読取のみ）。validateConfig の基本妥当性とは別に、実際にコアの発行判定を通り得るかを固定コードで返す。
   * 件数のみ返し、予約ID・完全deviceId・宛先は返さない。
   */
  function issuanceReadiness(cfg) {
    cfg = cfg || {};
    var problems = [];
    var brands = Array.isArray(cfg.eligibleBrands) ? cfg.eligibleBrands : null;
    var kps = Array.isArray(cfg.keypads) ? cfg.keypads : [];
    var out = {
      state: 'NOT_READY', problems: problems, warnings: [],
      commercialUse: cfg.commercialUseApproved === true ? 'APPROVED' : (cfg.commercialUseApproved === false ? 'NOT_APPROVED' : 'NOT_SET'),
      paymentStatuses: 0, brands: brands ? brands.length : 0,
      limitedRollout: cfg.limitedRollout === true ? 'ON' : (cfg.limitedRollout === false || cfg.limitedRollout === undefined ? 'OFF' : 'INVALID'),
      pilotBookingIds: Array.isArray(cfg.pilotBookingIds) ? cfg.pilotBookingIds.length : 0,
      keypads: kps.length, grace: 'NOT_SET', delivery: 'NOT_CONFIGURED'
    };
    if (out.commercialUse !== 'APPROVED') problems.push('COMMERCIAL_USE_NOT_APPROVED');
    var ps = cfg.eligiblePaymentStatuses;
    if (!Array.isArray(ps) || !ps.length) problems.push('PAYMENT_STATUSES_MISSING');
    else {
      out.paymentStatuses = ps.length;
      if (ps.some(function (x) { return ELIGIBLE_PAYMENT_BASIS.indexOf(x) === -1; })) problems.push('PAYMENT_STATUS_NOT_ALLOWED');
    }
    if (!brands || !brands.length) problems.push('ELIGIBLE_BRANDS_MISSING');
    else if (brands.some(function (b) { return KNOWN_BRANDS.indexOf(b) === -1; })) problems.push('ELIGIBLE_BRANDS_INVALID');
    if (out.limitedRollout === 'INVALID') problems.push('LIMITED_ROLLOUT_INVALID');
    if (cfg.pilotBookingIds !== undefined && !Array.isArray(cfg.pilotBookingIds)) problems.push('PILOT_BOOKING_IDS_INVALID');
    if (cfg.limitedRollout === true && out.pilotBookingIds !== 1) problems.push('PILOT_BOOKING_IDS_NOT_SINGLE');
    if (cfg.limitedRollout !== true && cfg.pilotBookingIds !== undefined) problems.push('PILOT_WITHOUT_LIMITED_ROLLOUT');
    var gOk = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 && Math.floor(v) === v && v <= GRACE_MAX_SEC; };
    if (cfg.graceBeforeSec === undefined && cfg.graceAfterSec === undefined) problems.push('GRACE_NOT_CONFIGURED');
    else if (!gOk(cfg.graceBeforeSec) || !gOk(cfg.graceAfterSec)) { out.grace = 'INVALID'; problems.push('GRACE_INVALID'); }
    else out.grace = 'SET';
    // 対象ブランドごとに、台帳対象（ledgerTarget の facility/room）でコアと同じ完全一致の端末解決ができるか／
    // 対象外ブランドの端末（余計な対象端末）が無いか。brand だけ一致して facility/room がずれていれば全件 KEYPAD_NOT_CONFIGURED になる
    var lt = isPlainObject(cfg.ledgerTarget) ? cfg.ledgerTarget : null;
    if (!lt || typeof lt.facility !== 'string' || !lt.facility) problems.push('LEDGER_TARGET_MISSING');
    else if (brands) brands.forEach(function (b) {
      var kp = Core.resolveKeypad(cfg, { brand: b, facility: lt.facility, room: lt.room === undefined ? null : lt.room });
      if (kp.error === 'KEYPAD_AMBIGUOUS') problems.push('KEYPAD_AMBIGUOUS_FOR_BRAND');
      else if (!kp.deviceId) problems.push('KEYPAD_MISSING_FOR_BRAND');
    });
    // 対象外ブランドの予備マッピング（例: 共通入口に3ブランド分の keypads を置き、eligibleBrands は ["mens"] のみ）は、
    // コアが BRAND_NOT_TARGET で止めるため発行に影響しない。READY を妨げない非ブロッキング警告としてだけ示す（PR #871 レビュー）。
    var warnings = [];
    if (kps.some(function (k) { return !k || !brands || brands.indexOf(k.brand) === -1; })) warnings.push('KEYPAD_FOR_NON_TARGET_BRAND');
    if (cfg.deliveryConfigured === true) out.delivery = deliverySettings(cfg) ? 'CONFIGURED' : 'INVALID';
    else if (cfg.delivery !== undefined && !deliverySettings(cfg)) out.delivery = 'INVALID';
    if (out.delivery === 'INVALID') problems.push('DELIVERY_CONFIG_INVALID');
    var uniq = problems.filter(function (e, i) { return problems.indexOf(e) === i; });
    out.problems = uniq;
    out.warnings = warnings;
    out.state = uniq.length ? 'NOT_READY' : 'READY';
    return out;
  }

  /** 状態ストアに環境名を刻む。別環境のストアへ向けた起動を拒否する（初回のみ記録）。 */
  function ensureStoreEnvironment(store, environment) {
    var cur = store.get('META_ENV');
    if (cur === null || cur === undefined || cur === '') { store.set('META_ENV', environment); return { ok: true, created: true }; }
    return cur === environment ? { ok: true, created: false } : { ok: false, error: 'ENV_MISMATCH' };
  }

  // ---------- 配送（暗証番号案内メール。Issue #752）----------

  /**
   * 配送設定 cfg.delivery の検証。メールアドレス・暗証番号・場所の詳細は設定の公開面に置かない
   * （replyTo は運営が非公開の Script Properties に設定する任意項目）。不正なら null（配送しない）。
   *   senderName … 差出人表示名 / facilityLabel … 件名・本文に出す施設名 / inquiryNote … 未着・入室できない場合の問合せ案内文
   *   startHoursBeforeDay … 配送開始（利用日0:00の何時間前か。既定6 = 前日18:00 JST）
   */
  function deliverySettings(cfg) {
    var d = cfg && cfg.delivery;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
    function text(v, max) { return typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v); }
    if (!text(d.senderName, 64) || !text(d.facilityLabel, 64) || !text(d.inquiryNote, 400)) return null;
    var replyTo = null;
    if (d.replyTo !== undefined && d.replyTo !== null && d.replyTo !== '') {
      if (typeof d.replyTo !== 'string' || !EMAIL_RE.test(d.replyTo)) return null;
      replyTo = d.replyTo;
    }
    var hours = d.startHoursBeforeDay === undefined ? 6 : d.startHoursBeforeDay;
    if (typeof hours !== 'number' || !isFinite(hours) || hours < 0 || hours > 48) return null;
    return { senderName: d.senderName.trim(), facilityLabel: d.facilityLabel.trim(), inquiryNote: d.inquiryNote.trim(), replyTo: replyTo, startHoursBeforeDay: hours };
  }

  var EMAIL_RE = /^[^\s@<>",;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

  /** 「送信していない」と確定した失敗（上限付きで再試行してよい）。それ以外の例外は結果不明として扱われる。 */
  function notSentError(code) { var e = new Error(code); e.notSent = true; e.alertCode = code; return e; }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtJst(sec) {
    var d = new Date((sec + 9 * 3600) * 1000);
    return d.getUTCFullYear() + '年' + (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 ' + d.getUTCHours() + ':' + pad2(d.getUTCMinutes());
  }

  /**
   * 暗証番号案内メールの固定文面（予約確認メールとは別送。別送である旨の括弧書きは本文に出さない＝#881運営指示）。差し込むのは暗証番号・施設名・有効時間・予約番号のみ。
   * 場所・キーボックス番号・バックアップキー・手動コードは載せない。p: { code, startSec, endSec, kind, previousInvalidated, bookingRef, settings }
   * 暗証番号の形式が不正ならメールを作らない（notSent）。
   */
  function renderCodeMail(p) {
    var st = p.settings;
    if (!st || !Core.validatePasscode(p.code) || typeof p.startSec !== 'number' || typeof p.endSec !== 'number' || p.startSec >= p.endSec) {
      throw notSentError('DELIVER_FAILED');
    }
    var change = p.kind === 'CHANGE';
    var ref = typeof p.bookingRef === 'string' && REF_RE.test(p.bookingRef) ? p.bookingRef : null;
    var subject = '【' + st.facilityLabel + '】' + (change ? '暗証番号のご案内（変更のお知らせ）' : '入室用の暗証番号のご案内');
    var lines = [];
    lines.push(st.senderName + 'です。');
    lines.push(change ? 'ご予約内容の変更に伴い、入室用の暗証番号をあらためてお送りします。' : 'ご予約の入室用の暗証番号をお送りします。');
    if (change) {
      lines.push(p.previousInvalidated === true
        ? '以前にお送りした暗証番号は使用できません。本メールの暗証番号をご利用ください。'
        : '以前にお送りした暗証番号ではなく、本メールの暗証番号をご利用ください。');
    }
    lines.push('');
    lines.push('■ 暗証番号: ' + p.code);
    lines.push('■ ご利用可能な時間: ' + fmtJst(p.startSec) + ' 〜 ' + fmtJst(p.endSec));
    lines.push('■ 対象: ' + st.facilityLabel + (ref ? '（予約番号 ' + ref + '）' : ''));
    lines.push('');
    lines.push('【ご利用にあたって】');
    lines.push('・暗証番号は、ご案内した時間内のみご利用いただけます。');
    lines.push('・暗証番号は、ご利用される方以外には共有しないでください。');
    lines.push('・入室できない場合や暗証番号についてお困りの際は、お問い合わせください。');
    lines.push('');
    lines.push('【お問い合わせ】');
    lines.push(st.inquiryNote);
    return { subject: subject, body: lines.join('\n') };
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

  /**
   * 3件の SET/MISSING を読む。読取例外を MISSING に潰さない（既存値を「未設定」と誤認して上書きする経路を作らない）:
   * 1件でも読めなければ ok=false・全項目 UNKNOWN。
   */
  function readCredentialStatus(props) {
    var st = {};
    for (var i = 0; i < CREDENTIAL_NAMES.length; i++) {
      var v;
      try { v = props.get(CREDENTIAL_NAMES[i]); } catch (e) { v = undefined; }
      if (v === undefined) {
        CREDENTIAL_NAMES.forEach(function (n) { st[n] = 'UNKNOWN'; });
        return { ok: false, status: st };
      }
      st[CREDENTIAL_NAMES[i]] = v ? 'SET' : 'MISSING';
    }
    return { ok: true, status: st };
  }

  /** 認可と SET/MISSING のみを返す状態確認（入力を要求せず、何も保存しない）。未認可・読取失敗は状態を見せない。 */
  function credentialStatus(deps) {
    var gate = authorizeExecutor(deps);
    var unknown = {};
    CREDENTIAL_NAMES.forEach(function (n) { unknown[n] = 'MISSING'; });
    if (!gate.ok) return { ok: false, code: gate.error, status: unknown, changed: [] };
    var r = readCredentialStatus(deps.userProps);
    if (!r.ok) return { ok: false, code: 'READ_FAILED', status: r.status, changed: [] };
    return { ok: true, code: 'STATUS_OK', status: r.status, changed: [] };
  }

  /**
   * 実行者本人の User Properties へ資格情報3件だけを登録する。返すのは固定コードと SET/MISSING/UNKNOWN のみ
   * （入力値・既存値・例外メッセージは返さず、ログにも出さない）。触れるキーは CREDENTIAL_NAMES の3つだけ。
   *
   * deps: userProps{get,set,del}, identity() → {email, effectiveEmail}, adminActors, prompt(name) → 文字列|null(取消),
   *       lock{tryLock(ms), releaseLock()}（必須。状態確認〜書込みの競合を直列化）
   * opts: mode 'init'（未設定のものだけ入力。設定済みは変更しない）／'replace'（確認語 REPLACE が必須。空入力=据え置き）、dryRun
   * 入力は全件検証してから書き込み、書込み・照合に失敗したら今回の変更を元に戻す。
   * 読取エラーは READ_FAILED で停止（MISSING 扱いにしない）。書込み直前に対象キーを再読取し、状態が変わっていれば STATE_CHANGED で停止。
   */
  function setupCredentials(deps, opts) {
    opts = opts || {};
    var mode = opts.mode === 'replace' ? 'replace' : 'init';
    var props = deps.userProps;
    function result(ok, code, extra) {
      var r = { ok: ok, code: code, status: readCredentialStatus(props).status, changed: [] };
      if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }

    // 1) 認可（fail closed）: 許可リストの管理者本人で、かつ実行者=有効ユーザーが双方とも取得でき一致するときだけ
    var gate = authorizeExecutor(deps);
    if (!gate.ok) { // 未認可には状態も見せない
      var masked = {};
      CREDENTIAL_NAMES.forEach(function (n) { masked[n] = 'MISSING'; });
      return { ok: false, code: gate.error, status: masked, changed: [] };
    }

    // 2) 状態確認〜書込みを直列化する（同時実行による上書き競合を防ぐ）。dryRun は書かないのでロック不要。
    var locked = false;
    if (!opts.dryRun) {
      if (!deps.lock) return result(false, 'LOCK_UNAVAILABLE');
      try { locked = deps.lock.tryLock(10000) === true; } catch (e) { locked = false; }
      if (!locked) return result(false, 'LOCK_BUSY');
    }
    try {
      return runSetup();
    } finally {
      if (locked) { try { deps.lock.releaseLock(); } catch (e) { /* 値は出さない */ } }
    }

    function runSetup() {
      // 3) 現状確認。読取エラーは MISSING にせず停止（入力は聞かない）
      var cur = readCredentialStatus(props);
      if (!cur.ok) return result(false, 'READ_FAILED');
      var before = cur.status;
      var targets;
      if (mode === 'init') {
        targets = CREDENTIAL_NAMES.filter(function (n) { return before[n] === 'MISSING'; });
        if (!targets.length) return result(false, 'ALREADY_SET');
      } else {
        if (CREDENTIAL_NAMES.every(function (n) { return before[n] === 'MISSING'; })) return result(false, 'NOT_INITIALIZED');
        targets = CREDENTIAL_NAMES.slice();
      }

      // 4) 上書きは明示確認（確認語の完全一致）が必須。確認前は何も入力させず、何も変更しない
      var ask = function (name) {
        var v;
        try { v = deps.prompt(name); } catch (e) { return { fail: 'PROMPT_UNAVAILABLE' }; }
        return v === null || v === undefined ? { fail: 'CANCELLED' } : { value: String(v) };
      };
      if (mode === 'replace') {
        var c = ask('__CONFIRM_REPLACE__');
        if (c.fail) return result(false, c.fail);
        if (c.value.trim() !== CREDENTIAL_CONFIRM_REPLACE) return result(false, 'REPLACE_NOT_CONFIRMED');
      }

      // 5) 全件入力→全件検証（1件でも不備なら何も書かない）
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

      // 6) 3種は互いに別の値であること（新旧・据え置き分を含めて比較。値は外へ出さない）。読取エラーは READ_FAILED
      var seen = {}, dup = false;
      try {
        CREDENTIAL_NAMES.forEach(function (n) {
          var val = inputs[n] !== undefined ? inputs[n] : (before[n] === 'SET' ? props.get(n) : null);
          if (!val) return;
          if (seen[val]) dup = true;
          seen[val] = true;
        });
      } catch (e) { return result(false, 'READ_FAILED'); }
      if (dup) return result(false, 'INPUT_DUPLICATE');
      if (opts.dryRun) return result(true, 'DRY_RUN_OK', { wouldChange: names });

      // 7) 書込み直前の再検証: 状態確認後に設定状況が変わっていたら（競合・他経路の更新）書かずに停止
      var prev = {};
      for (var k = 0; k < names.length; k++) {
        var cv;
        try { cv = props.get(names[k]); } catch (e) { return result(false, 'READ_FAILED'); }
        if ((cv ? 'SET' : 'MISSING') !== before[names[k]]) return result(false, 'STATE_CHANGED');
        prev[names[k]] = cv;
      }

      // 8) 書込み→照合。失敗（例外・不一致）したら今回の分を元に戻す
      var written = [];
      var rollback = function () {
        written.forEach(function (n) {
          try { if (prev[n]) props.set(n, prev[n]); else props.del(n); } catch (e) { /* 復旧不能でも値は出さない */ }
        });
      };
      try {
        names.forEach(function (n) {
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
  }

  // ---------- 資格情報のワンショット移行（Issue #772。エディタ手動実行・追加GCP/OAuth/API Deployment不要）----------

  /** Script Properties 側の一時キー（移行元）→ User Properties 側の正式キー（移行先）。 */
  var BOOTSTRAP_KEYS = {
    BOOTSTRAP_SWITCHBOT_TOKEN: 'SWITCHBOT_TOKEN',
    BOOTSTRAP_SWITCHBOT_SECRET: 'SWITCHBOT_SECRET',
    BOOTSTRAP_WEBHOOK_SHARED_TOKEN: 'WEBHOOK_SHARED_TOKEN'
  };
  var BOOTSTRAP_NAMES = Object.keys(BOOTSTRAP_KEYS);

  function bootstrapMasked(map) {
    var m = {};
    BOOTSTRAP_NAMES.forEach(function (n) { m[n] = map || 'ABSENT'; });
    return m;
  }

  /**
   * 機能フラグ ACCESS_ENABLED の状態: 'OFF'（未設定/'false'）| 'ON'('true') | 'UNKNOWN'（読取不能・想定外の値・読取手段なし）。
   * 移行は OFF のときだけ行う（ON/UNKNOWN は fail closed）。deps.accessFlag() は生の値（文字列|null）を返す。
   */
  function accessFlagState(deps) {
    var raw;
    try { raw = typeof deps.accessFlag === 'function' ? deps.accessFlag() : undefined; } catch (e) { return 'UNKNOWN'; }
    if (raw === undefined) return 'UNKNOWN';
    if (raw === null || raw === '' || raw === 'false') return 'OFF';
    return raw === 'true' ? 'ON' : 'UNKNOWN';
  }
  function flagCode(state) { return state === 'ON' ? 'ACCESS_NOT_OFF' : 'ACCESS_STATE_UNKNOWN'; }

  /** 一時キー3件の SET/ABSENT。読取例外は UNKNOWN（ABSENT に潰さない）。 */
  function readBootstrapStatus(sp) {
    var st = {}, ok = true;
    BOOTSTRAP_NAMES.forEach(function (n) {
      var v;
      try { v = sp.get(n); } catch (e) { v = undefined; }
      if (v === undefined) { st[n] = 'UNKNOWN'; ok = false; } else st[n] = v ? 'SET' : 'ABSENT';
    });
    return { ok: ok, status: st };
  }

  /** 一時キー3件だけを削除する（他のキーには触れない）。削除後に再読取して ABSENT を確認し、残存/不明なら false。 */
  function scrubBootstrap(sp) {
    BOOTSTRAP_NAMES.forEach(function (n) { try { sp.del(n); } catch (e) { /* 値は出さない。下の再確認で検出 */ } });
    var r = readBootstrapStatus(sp);
    return r.ok && BOOTSTRAP_NAMES.every(function (n) { return r.status[n] === 'ABSENT'; });
  }

  /**
   * 読取専用の診断。値は外部に返さず SET/ABSENT だけ返す（一時キー残存の検出に使う。何も変更しない）。
   * deps: scriptProps{get,set,del}, userProps{get,set,del}, identity(), adminActors
   */
  function bootstrapStatus(deps) {
    var gate = authorizeExecutor(deps);
    if (!gate.ok) return { ok: false, code: gate.error, status: {}, bootstrap: bootstrapMasked(), changed: [] };
    var u = readCredentialStatus(deps.userProps);
    var b = readBootstrapStatus(deps.scriptProps);
    if (!u.ok || !b.ok) return { ok: false, code: 'READ_FAILED', status: u.status, bootstrap: b.status, changed: [] };
    var fs0 = accessFlagState(deps); // 秘密を入力する前の事前ゲート: OFF でなければ ok=false
    if (fs0 !== 'OFF') return { ok: false, code: flagCode(fs0), status: u.status, bootstrap: b.status, changed: [] };
    var left = BOOTSTRAP_NAMES.some(function (n) { return b.status[n] === 'SET'; });
    return { ok: true, code: left ? 'BOOTSTRAP_KEYS_REMAIN' : 'STATUS_OK', status: u.status, bootstrap: b.status, changed: [] };
  }

  /** 一時キー3件の手動消去（失敗後の復旧・やり直し用）。認可必須。触れるのは BOOTSTRAP_* の3キーのみ。 */
  function scrubBootstrapCredentials(deps) {
    var gate = authorizeExecutor(deps);
    if (!gate.ok) return { ok: false, code: gate.error, status: {}, bootstrap: bootstrapMasked(), changed: [] };
    var clean = scrubBootstrap(deps.scriptProps);
    var u = readCredentialStatus(deps.userProps);
    return { ok: clean, code: clean ? 'SCRUBBED' : 'CLEANUP_FAILED', status: u.status, bootstrap: readBootstrapStatus(deps.scriptProps).status, changed: [] };
  }

  /**
   * Script Properties の一時キー3件を、実行者本人の User Properties の正式3キーへ1回だけ移し、一時キーを消す。
   * 返すのは固定コードと SET/MISSING/ABSENT のみ（値・例外メッセージは返さず、ログにも出さない）。
   *
   * 触れるキー: Script Properties は BOOTSTRAP_* の3つのみ（他の ACCESS_* 等は読みも書きもしない）、
   *            User Properties は CREDENTIAL_NAMES の3つのみ。ACCESS_ENABLED・Deployment・トリガー・Webhook・SwitchBot API には触れない。
   * 上書き禁止: User Properties に1件でも SET（または読取不明）があれば何も書かない（置換は #770 の replace 経路）。
   * 認可後の失敗では、可能な限り一時キーを削除する（秘密を Script Properties に残さない）。
   *   移行先の部分書込みは元に戻す。戻せなかった場合は ROLLBACK_FAILED で停止し、状態点検（accessBootstrapStatus）を促す。
   *
   * deps: scriptProps, userProps（{get,set,del}）, identity() → {email, effectiveEmail}, adminActors, lock{tryLock, releaseLock}
   */
  function migrateBootstrapCredentials(deps) {
    var sp = deps.scriptProps, up = deps.userProps;
    function result(ok, code, extra) {
      var r = { ok: ok, code: code, status: readCredentialStatus(up).status, bootstrap: readBootstrapStatus(sp).status, changed: [] };
      if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
      return r;
    }
    var gate = authorizeExecutor(deps);
    if (!gate.ok) { // 未認可には状態も見せず、何も消さない
      var masked = {};
      CREDENTIAL_NAMES.forEach(function (n) { masked[n] = 'MISSING'; });
      return { ok: false, code: gate.error, status: masked, bootstrap: bootstrapMasked(), changed: [] };
    }
    // 機能が ON（または不明）のときは何も書かない。一時キーは自動では消さず、運営者が accessScrubBootstrapCredentials か設定画面で削除する
    var f0 = accessFlagState(deps);
    if (f0 !== 'OFF') return result(false, flagCode(f0));
    if (!deps.lock) { scrubBootstrap(sp); return result(false, 'LOCK_UNAVAILABLE'); }
    var locked = false;
    try { locked = deps.lock.tryLock(10000) === true; } catch (e) { locked = false; }
    if (!locked) return result(false, 'LOCK_BUSY'); // 他の実行が一時キーを使用中かもしれないので消さない
    try {
      return run();
    } finally {
      try { deps.lock.releaseLock(); } catch (e) { /* 値は出さない */ }
    }

    /** 失敗終了: 一時キーを消してから固定コードを返す。消せなければ CLEANUP_FAILED を付す。 */
    function fail(code, extra) {
      var clean = scrubBootstrap(sp);
      var r = result(false, code, extra);
      if (!clean) r.cleanup = 'CLEANUP_FAILED';
      return r;
    }

    function run() {
      // 1) 移行先の現状。読取不能・1件でも SET なら上書きしない
      var cur = readCredentialStatus(up);
      if (!cur.ok) return fail('READ_FAILED');
      if (CREDENTIAL_NAMES.some(function (n) { return cur.status[n] !== 'MISSING'; })) return fail('USER_PROPS_NOT_EMPTY');

      // 2) 一時キー: 3件すべて存在（読取不能・欠落があれば不備）。全く無ければ何も消すものがない
      var b = readBootstrapStatus(sp);
      if (!b.ok) return fail('READ_FAILED');
      var present = BOOTSTRAP_NAMES.filter(function (n) { return b.status[n] === 'SET'; });
      if (!present.length) return result(false, 'BOOTSTRAP_MISSING');
      if (present.length !== BOOTSTRAP_NAMES.length) return fail('BOOTSTRAP_INCOMPLETE');

      // 3) 形式検証・重複検証（値は外へ出さない。不備は移行先の名前だけ返す）
      var vals = {}, invalid = [];
      try {
        BOOTSTRAP_NAMES.forEach(function (n) {
          var dest = BOOTSTRAP_KEYS[n];
          var v = sp.get(n);
          vals[dest] = v;
          if (!validateCredentialInput(dest, v).ok) invalid.push(dest);
        });
      } catch (e) { return fail('READ_FAILED'); }
      if (invalid.length) return fail('INPUT_INVALID', { invalid: invalid });
      var seen = {}, dup = false;
      CREDENTIAL_NAMES.forEach(function (n) { if (seen[vals[n]]) dup = true; seen[vals[n]] = true; });
      if (dup) return fail('INPUT_DUPLICATE');

      // 4) 書込み直前の再確認（競合・他経路の更新があれば書かない）
      var again = readCredentialStatus(up);
      if (!again.ok) return fail('READ_FAILED');
      if (CREDENTIAL_NAMES.some(function (n) { return again.status[n] !== 'MISSING'; })) return fail('STATE_CHANGED');

      // 4b) ロック下・実書込み直前にフラグを再確認（ON への切替競合を防ぐ）。ON/不明なら書かない（一時キーは残す）
      var f1 = accessFlagState(deps);
      if (f1 !== 'OFF') return result(false, flagCode(f1));

      // 5) 書込み→照合。失敗したら今回書いた分を戻す（移行前は全件 MISSING なので削除で復元できる）
      var written = [];
      function rollback() {
        var ok = true;
        written.forEach(function (n) { try { up.del(n); } catch (e) { ok = false; } });
        var chk = readCredentialStatus(up);
        return ok && chk.ok && CREDENTIAL_NAMES.every(function (n) { return chk.status[n] === 'MISSING'; });
      }
      try {
        CREDENTIAL_NAMES.forEach(function (n) { written.push(n); up.set(n, vals[n]); });
      } catch (e) {
        return fail(rollback() ? 'WRITE_FAILED' : 'ROLLBACK_FAILED');
      }
      var verified = false;
      try { verified = CREDENTIAL_NAMES.every(function (n) { return up.get(n) === vals[n]; }); } catch (e) { verified = false; }
      if (!verified) return fail(rollback() ? 'VERIFY_FAILED' : 'ROLLBACK_FAILED');

      // 6) 成功: 一時キーを消し、ABSENT を再確認。消えなければ即座に手動削除を促す
      if (!scrubBootstrap(sp)) return result(false, 'MIGRATED_CLEANUP_FAILED', { changed: CREDENTIAL_NAMES.slice() });
      return result(true, 'OK', { changed: CREDENTIAL_NAMES.slice() });
    }
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

  // ---------- 状態ストアのキー分類・APICOUNT の回収（Issue #887）----------

  /** 日別API使用量の保持日数（JST 当日＋前日〜7日前＝計8暦日分）。それより前の正常な日付キーのみ回収する。 */
  var APICOUNT_KEEP_DAYS = 7;
  var APICOUNT_KEY_RE = /^APICOUNT_(\d{4})(\d{2})(\d{2})$/;
  /** 稼働監視の既知キー（runLocked の job 名）。これ以外の HB_ は未分類として報告のみ。 */
  var HB_JOBS = ['ADMIN', 'CLEANUP', 'DELIVER', 'SWEEP', 'SYNC'];
  /** 値を1か所に上書きする常設キー（回収しない）。 */
  var PERSISTENT_STATE_KEYS = ['META_ENV', 'LOCKFAIL', 'NOTIFYFAIL', 'KEYREADY'];
  /** 既存 garbageCollect が個別に回収判断する接頭辞（OP_ は Core.sweep が終端＋保持期限後に回収）。 */
  var MANAGED_STATE_PREFIXES = ['OP_', 'BK_', 'EVT_', 'ALERT_', 'DLV_', 'INBOX_', 'TRK_', 'IALERT_', 'ADMINLOG_'];

  /** JST の日番号（1970-01-01 JST からの暦日数）。 */
  function jstDayNumber(sec) { return Math.floor((sec + 9 * 3600) / 86400); }

  /**
   * APICOUNT_YYYYMMDD の日番号。実在する暦日の正常形式だけ数値を返し、それ以外（形式不正・存在しない日付）は null。
   */
  function apiCountDayNumber(key) {
    var m = APICOUNT_KEY_RE.exec(key);
    if (!m) return null;
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var t = Date.UTC(y, mo - 1, d);
    var dt = new Date(t);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(t / 86400000);
  }

  /** 回収対象の APICOUNT か（JST 当日より APICOUNT_KEEP_DAYS 日を超えて前の正常な日付キーのみ true）。当日・将来・不正形式は false。 */
  function isExpiredApiCountKey(key, nowSec) {
    var day = apiCountDayNumber(key);
    return day !== null && day < jstDayNumber(nowSec) - APICOUNT_KEEP_DAYS;
  }

  /** 状態ストアの既知キーか。接頭辞が似ているだけの不正キー（例 APICOUNT_x, HB_UNKNOWN）は false。 */
  function isClassifiedStateKey(k) {
    if (PERSISTENT_STATE_KEYS.indexOf(k) !== -1) return true;
    if (k.indexOf('HB_') === 0) return HB_JOBS.indexOf(k.slice(3)) !== -1;
    if (k.indexOf('APICOUNT_') === 0) return apiCountDayNumber(k) !== null;
    return MANAGED_STATE_PREFIXES.some(function (p) { return k.indexOf(p) === 0; });
  }

  /**
   * 保持期限に基づく回収（ロック保持下で呼ぶ）。未解決OPと、それに必要な根拠（索引・Webhook・秘密・通知マーカー）は
   * 期限に関わらず保護する。回収: 参照切れのBK索引項目／期限切れBK／期限切れかつ未参照のEVT／OP不在のALERT／
   * OPが無い・終端OPの秘密／期限切れ受信箱／古い追跡・通知・管理者ログ／JST当日より8日以上前の APICOUNT（#887）。件数のみ返す。
   * report（任意）には、未分類の状態キーの件数 report.unclassified を入れる（削除しない。値・キー名は返さない）。
   */
  function garbageCollect(store, secrets, nowSec, cfg, report) {
    var ic = infraCfg(cfg);
    var ret = ic.retention;
    var removed = { BK: 0, EVT: 0, ALERT: 0, SECRET: 0, INBOX: 0, TRK: 0, IALERT: 0, ADMINLOG: 0, BK_OPREF: 0, DLV: 0, APICOUNT: 0 };
    var unclassified = 0;
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
      // --- 日別API使用量（当日の予算判定に使う当日分・将来日付・不正形式は回収しない） ---
      if (k.indexOf('APICOUNT_') === 0) {
        if (isExpiredApiCountKey(k, nowSec)) { store.del(k); removed.APICOUNT++; }
        else if (apiCountDayNumber(k) === null) unclassified++;
        return;
      }
      // --- 常設キー・稼働監視（上書き型。回収しない。未知の HB_ は報告のみ） ---
      if (PERSISTENT_STATE_KEYS.indexOf(k) !== -1) return;
      if (k.indexOf('HB_') === 0) { if (HB_JOBS.indexOf(k.slice(3)) === -1) unclassified++; return; }
      if (!isClassifiedStateKey(k)) { unclassified++; return; } // 未知のキーは削除せず件数のみ報告
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
      // --- 配送記録（参照元OPが無いものは回収。OPが残る間は結果不明の根拠として保持） ---
      if (k.indexOf('DLV_') === 0) {
        if (!opIds[k.slice(4)]) { store.del(k); removed.DLV++; }
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
    if (report) report.unclassified = unclassified;
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
    var rawInfra = cfg.infra || {};
    if ((rawInfra.priorityRetryLeadSec !== undefined && rawInfra.priorityRetryLeadSec !== ic.priorityRetryLeadSec) ||
        (rawInfra.warningNoticeLeadSec !== undefined && rawInfra.warningNoticeLeadSec !== ic.warningNoticeLeadSec) ||
        (rawInfra.urgentNoticeLeadSec !== undefined && rawInfra.urgentNoticeLeadSec !== ic.urgentNoticeLeadSec)) warnings.push('KEY_READINESS_LEAD_INVALID');
    if (ic.priorityRetryLeadSec < ic.syncIntervalSec) warnings.push('PRIORITY_LEAD_SHORTER_THAN_SYNC_CYCLE');
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
      DELIVER_FAILED: c('DELIVERY', 'medium', '暗証番号メールを送信できなかった（送信していないと確定した失敗のみ、所定回数まで自動で再試行する）。予約・決済は取り消さない。利用者へ「利用可能」とは案内しない。管理者が状況を確認し、必要なら代替入室を案内する。'),
      DELIVERY_UNKNOWN: c('DELIVERY', 'high', '暗証番号メールの送信結果が不明（送信済みの可能性がある）。自動再送はしない。管理者が送信記録を確認し、accessAdminResolveDelivery で「配送済み確認」か「再送許可」を決める。確認できるまで利用者へ「利用可能」と案内しない。必要なら本人・予約を確認のうえ、代替入室（手動解錠・手動パスコード発行・キーボックス内の物理キー）を個別に案内する。保管場所や番号は定型メールに書かない。'),
      DELIVERY_RETRY_EXHAUSTED: c('DELIVERY', 'high', '暗証番号メールの自動再試行が上限に達した。管理者が原因（宛先・送信枠など）を確認し、再送許可か代替入室（本人・予約を確認のうえ個別案内）を決める。'),
      CHANGE_CODE_UNDELIVERED: c('DELIVERY', 'high', '予約変更・延長後の新しい暗証番号が利用者へ届いたと確認できない。延長の承認と新コードの利用可能は別なので、「利用可能」と案内しない。入室中・期限直前の場合は優先して代替入室を案内する（本人・予約を確認のうえ個別に）。'),
      DELIVERY_RECIPIENT_UNRESOLVED: c('DELIVERY', 'high', '予約の受渡し先を一意に特定できず、メールを送っていない。誤送信を避けるため送らない。管理者が予約を確認し、必要なら個別に案内する。'),
      DELIVERY_NOT_CONFIGURED: c('DELIVERY', 'medium', '配送の設定（差出人・問合せ案内・送信手段）が不足しているため送信していない。運営の承認済み設定を確認する。'),
      DELIVERY_GATE_BLOCKED: c('DELIVERY', 'medium', '送信直前の安全確認が通らなかったため、メールを送っていない。'),
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
      LEDGER_SCOPE_INCOMPATIBLE: c('SYSTEM', 'high', '予約台帳の読取りが、宣言済みのOAuthスコープと合わないため照合を見送った。スコープは運営者の承認なしに広げない。'),
      LEDGER_AUTH_REQUIRED: c('SYSTEM', 'high', '予約台帳の読取りに必要なGAS権限の承認が未完了のため、照合を見送った。'),
      LEDGER_ACCESS_DENIED: c('SYSTEM', 'high', '予約台帳の閲覧権限がないため、照合を見送った。'),
      LEDGER_API_DISABLED: c('SYSTEM', 'high', 'Google Sheets APIが有効でないため、照合を見送った（GASが使うGoogle Cloudプロジェクトで有効化の要否を確認する）。'),
      LEDGER_NOT_FOUND: c('SYSTEM', 'high', '予約台帳が見つからないため、照合を見送った（台帳IDの設定を確認する）。'),
      LEDGER_RATE_LIMITED: c('SYSTEM', 'medium', '予約台帳の読取りがクォータ制限に達したため、照合を見送った。次回の実行で再試行する。'),
      LEDGER_TOO_LARGE: c('SYSTEM', 'high', '予約台帳の行数が読取上限を超えたため、照合を止めた（切り捨てて照合しない）。'),
      LEDGER_TIMEZONE_UNSUPPORTED: c('SYSTEM', 'high', '予約台帳のタイムゾーンを解釈できないため、日時を誤読しないよう照合を止めた。'),
      WEBHOOK_INBOX_FULL: c('SYSTEM', 'medium', 'Webhookの退避枠が満杯になり、受信を取りこぼした可能性がある。該当操作は期限後にUNKNOWNとなる。'),
      API_BUDGET_EXHAUSTED: c('SYSTEM', 'high', '1日のAPI呼び出し予算に達したため、処理を見送った。'),
      ENV_MISMATCH: c('SYSTEM', 'high', '状態ストアの環境名が設定と一致しない。検証/本番の取り違えの可能性があるため停止した。'),
      CONFIG_INVALID: c('SYSTEM', 'high', '設定が不正のため停止した。'),
      ISSUE_GATE_ERROR: c('SYSTEM', 'high', '発行前の安全確認で内部エラーが発生したため、新規発行を止めた。'),
      SYNC_ERROR: c('SYSTEM', 'high', '照合中に内部エラーが発生し、処理を中断した（詳細は公開しない）。'),
      // キー未発行対策（#885 第3弾）: 開始5分前／開始後に、発行確認済みの個別キーが無い確定予約。予約・決済は取り消さない。
      KEY_UNCONFIRMED_WARNING: c('KEY_UNCONFIRMED', 'medium', '利用開始10分前になっても、個別キーの反映を確認できていない（発行の途中状態を含む。「発行失敗」と確定したものではない）。自動の再試行は続いている。管理者は予約と鍵の状態を確認する。この通知に暗証番号は含まれない。'),
      KEY_UNCONFIRMED_URGENT: c('KEY_UNCONFIRMED', 'high', '利用開始5分前になっても、個別キーの反映を確認できていない（途中状態を含む。「発行失敗」と確定したものではない）。管理者は直ちに予約と鍵の状態を確認し（accessAdminInspect 等）、入室に間に合わない見込みなら、本人・予約を確認のうえ代替入室（手動解錠・手動パスコード発行・物理キー）を個別に案内する。予約・決済は取り消さない。'),
      KEY_UNCONFIRMED_STARTED: c('KEY_UNCONFIRMED', 'high', '利用開始時刻を過ぎても、個別キーの反映を確認できていない（未解決の間、約10分ごとに再通知する）。利用者が入室できていない可能性が高い。責任者は直ちに本人・予約を確認し、代替入室へ切り替える。予約・決済は取り消さない。'),
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
   *   deliverCode function(bookingRef, code, window, meta) | null   （テスト用の差替え。未指定なら下の sendUserMail / resolveRecipient で組み立てる）
   *   sendUserMail function({to, subject, body, name, replyTo})      利用者宛。「送信していない」と確定した失敗のみ error.notSent=true
   *   resolveRecipient function(bookingRef) → {ok:true, to}|{ok:false} 送信時にだけ台帳から宛先を1件読む（保存・ログしない）
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

    // ---- 配送（#752）: 内蔵の暗証番号案内メール（deps.deliverCode 未指定のとき）----
    function builtinDeliver(bookingRef, code, win, meta) {
      var ds = deliverySettings(cfg);
      if (!ds || typeof deps.sendUserMail !== 'function' || typeof deps.resolveRecipient !== 'function') throw notSentError('DELIVERY_NOT_CONFIGURED');
      var rcp = null;
      try { rcp = deps.resolveRecipient(bookingRef); } catch (e) { rcp = null; }
      if (!rcp || rcp.ok !== true || typeof rcp.to !== 'string' || !EMAIL_RE.test(rcp.to)) throw notSentError('DELIVERY_RECIPIENT_UNRESOLVED'); // 識別できなければ送らない
      var m = renderCodeMail({ code: code, startSec: win.startSec, endSec: win.endSec, kind: meta && meta.kind, previousInvalidated: meta && meta.previousInvalidated, bookingRef: bookingRef, settings: ds });
      deps.sendUserMail({ to: rcp.to, subject: m.subject, body: m.body, name: ds.senderName, replyTo: ds.replyTo });
    }
    var deliverFn = typeof deps.deliverCode === 'function' ? deps.deliverCode : builtinDeliver;
    function deliveryReady() {
      if (typeof deps.deliverCode === 'function') return true;
      return !!deliverySettings(cfg) && typeof deps.sendUserMail === 'function' && typeof deps.resolveRecipient === 'function';
    }

    var cycleFresh = null; // 配送サイクル内で1回だけ読んだ最新台帳（送信直前の再確認に使う。サイクル外では都度読む）

    var notifier = {
      core: function (event) { var m = renderNotification(Object.assign({ env: cfg.environment }, event)); deps.sendMail(m.subject, m.body); }
    };

    var api = guardedApi();
    var engine = Core.createEngine({
      store: deps.store, secrets: deps.secrets, lock: lockDomain.coreLock, api: api,
      notifyAdmin: notifier.core, deliverCode: deliverFn, deliveryGate: deliveryGate,
      sha256Hex: deps.sha256Hex, randomInt: deps.randomInt, nowSec: deps.nowSec,
      issueGate: issueGate
    }, coreConfig);

    // ---- 管理者通知（基盤事象）: 固定分類・重複抑止・失敗時の再送 ----
    function iaKey(code, ref, rev) { return 'IALERT_' + code + '_' + (ref || '-') + '_' + (rev === undefined || rev === null ? '-' : rev); }

    /** 基盤事象の通知。同一事象は repeatSec 内は再通知しない。送達失敗は次回以降バックオフ付きで再送。 */
    function infraAlert(code, ref, rev, detail, repeatSec, verified) {
      var k = iaKey(code, ref, rev);
      var cur = safeParse(deps.store.get(k));
      var now = deps.nowSec();
      var rec = cur || { event: { code: code, ref: ref || undefined, rev: rev === undefined ? undefined : rev, detail: detail || undefined }, firstAt: now, sentAt: null, attempts: 0, lastTryAt: 0 };
      if (rec.sentAt !== null && now - rec.sentAt < (repeatSec || ic.notifyRepeatSec)) return false;
      if (rec.sentAt === null && rec.attempts > 0) {
        if (now - rec.lastTryAt < backoffWaitSec(rec)) return false;
      }
      return trySend(k, rec, verified) === 'SENT';
    }

    /** 緊急通知は一般通知より短い間隔（既定2分）で再送し、少ない失敗回数（既定2回）で不達と判定する。 */
    function isUrgentRec(rec) { return !!(rec && rec.event && URGENT_CODES.indexOf(rec.event.code) !== -1); }
    function backoffWaitSec(rec) {
      var max = isUrgentRec(rec) ? Math.min(ic.notifyBackoffMaxSec, ic.urgentNotifyBackoffMaxSec) : ic.notifyBackoffMaxSec;
      return Math.min(max, ic.notifyBackoffBaseSec * Math.pow(2, Math.min(rec.attempts, 20)));
    }
    function failingThreshold(rec) { return isUrgentRec(rec) ? ic.urgentNotifyFailingAttempts : ic.notifyFailingAttempts; }

    /**
     * 戻り値: 'SENT' 送信成功／'FAILED' 送信失敗（再送対象）／'VOID' 失効（送らず記録も消す）／'HOLD' 検証できず保留（何も変えない）。
     * 緊急通知（KEY_UNCONFIRMED_*）は、送信直前に現行の台帳・OPで再検証する。メール失敗の後にキーが反映された、
     * 予約が取消・変更（revision）・終了した場合に、古い通知を送らないため。verified=true は直前に同じ判定を済ませた呼出し。
     */
    function trySend(k, rec, verified) {
      if (isUrgentRec(rec) && verified !== true) {
        var v = urgentStillValid(rec);
        if (v === 'HOLD') return 'HOLD';
        if (v === 'VOID') { try { deps.store.del(k); } catch (e0) { /* 次回も失効判定になる */ } return 'VOID'; }
      }
      var now = deps.nowSec();
      rec.attempts += 1; rec.lastTryAt = now;
      try {
        var m = renderNotification(Object.assign({ env: cfg.environment }, rec.event));
        deps.sendMail(m.subject, m.body);
        rec.sentAt = now; rec.attempts = 0;
        deps.store.set(k, JSON.stringify(rec));
        return 'SENT';
      } catch (e) {
        rec.sentAt = null;
        try { deps.store.set(k, JSON.stringify(rec)); } catch (e2) { /* 記録不能でも次回の検知で再通知される */ }
        return 'FAILED';
      }
    }

    var ledgerForFlush = null; // flushOutbox 1回の間だけ、再検証用の台帳読取を共有する
    var flushing = false;
    var flushTrackedIds = []; // flushOutbox 中に共有する台帳読取で追跡する、未送達の緊急通知の予約参照すべて

    /** 緊急通知がまだ有効か。'OK' 送ってよい／'VOID' 失効／'HOLD' 台帳を確認できず保留。 */
    function urgentStillValid(rec) {
      var ev = rec.event || {};
      var need = URGENT_CODE_LEVEL[ev.code];
      if (!need || typeof ev.ref !== 'string' || !Number.isInteger(ev.rev)) return 'VOID';
      if (cfg.enabled !== true) return 'VOID';
      var nowMs = deps.nowMs();
      var led = ledgerForFlush;
      if (!led) {
        try { led = deps.ledger.read({ nowMs: nowMs, trackedIds: flushing ? flushTrackedIds : [ev.ref] }); } catch (e) { return 'HOLD'; }
        if (flushing) ledgerForFlush = led;
      }
      if (!led || led.ok !== true) return 'HOLD';
      var hits = (led.records || []).filter(function (r) { return String(r.bookingId) === ev.ref; });
      if (hits.length === 0) return 'VOID';
      if (hits.length > 1) return 'HOLD';
      var p;
      try { p = prepareRecord(hits[0], nowMs); } catch (e1) { return 'HOLD'; }
      if (p.sn.revision !== ev.rev) return 'VOID';
      var rd = readinessOf(p, groupOps(scanOps(deps.store)), deps.nowSec());
      if (!rd || rd.ready || LEVEL_RANK[rd.level] < LEVEL_RANK[need]) return 'VOID';
      return 'OK';
    }

    /** 未送達の通知を再送する（バックオフ尊重）。 */
    function flushOutbox() {
      var now = deps.nowSec();
      var pending = 0, failing = 0;
      ledgerForFlush = null; flushing = true;
      // 日付をまたいで続く予約は、台帳の通常の読取範囲（当日・翌日）から外れうる。共有する1回の読取に、未送達の全予約参照を追跡対象として渡す
      flushTrackedIds = [];
      deps.store.keys().forEach(function (k0) {
        if (k0.indexOf('IALERT_') !== 0) return;
        var r0 = safeParse(deps.store.get(k0));
        if (r0 && r0.sentAt === null && isUrgentRec(r0) && typeof r0.event.ref === 'string' && flushTrackedIds.indexOf(r0.event.ref) === -1) flushTrackedIds.push(r0.event.ref);
      });
      try {
        deps.store.keys().filter(function (k) { return k.indexOf('IALERT_') === 0; }).forEach(function (k) {
          var rec = safeParse(deps.store.get(k));
          if (!rec || rec.sentAt !== null) return;
          pending++;
          var th = failingThreshold(rec);
          if (rec.attempts > 0 && now - rec.lastTryAt < backoffWaitSec(rec)) { if (rec.attempts >= th) failing++; return; }
          var res = trySend(k, rec);
          if (res === 'VOID') pending--;
          else if (res === 'FAILED' && rec.attempts >= th) failing++;
        });
      } finally { ledgerForFlush = null; flushing = false; flushTrackedIds = []; }
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


    // ---- 送信直前の配送ゲート（#752）: 最新の台帳で予約を再確認する。保留(hold)は何も送らず次回再評価、不成立(hold:false)は配送を打ち切る ----
    function ledgerErrCode(led) {
      return led && typeof led.error === 'string' && /^LEDGER_[A-Z_]+$/.test(led.error) && Object.prototype.hasOwnProperty.call(CATALOG, led.error) ? led.error : 'LEDGER_READ_FAILED';
    }

    function deliveryGate(rec) {
      function hold(code) { return { ok: false, hold: true, code: code }; }
      function stop(code) { return { ok: false, hold: false, code: code }; }
      if (cfg.enabled !== true) return hold('FLAG_OFF');
      var led = cycleFresh;
      if (!led) { try { led = deps.ledger.read({ nowMs: deps.nowMs(), trackedIds: [rec.bookingId] }); } catch (e) { led = null; } }
      if (!led || led.ok !== true) return hold('LEDGER_READ_FAILED'); // 読めなければ送らない
      var hits = (led.records || []).filter(function (r) { return String(r.bookingId) === String(rec.bookingId); });
      if (hits.length === 0) return hold('BOOKING_NOT_FOUND');
      if (hits.length > 1) return hold('BOOKING_AMBIGUOUS');
      var nowMs = deps.nowMs(), nowSec = deps.nowSec();
      var sn = deps.snapshot.build(hits[0], { facility: cfg.ledgerTarget.facility, room: cfg.ledgerTarget.room });
      var input = deps.snapshot.toCoreInput(sn, nowMs, { eligibleBrands: Array.isArray(cfg.eligibleBrands) ? cfg.eligibleBrands : [] });
      if (input.action === 'FREEZE') return hold('BOOKING_FROZEN'); // 支払/承認不明・追加料金未了・要復旧は送らない（解消後に再評価）
      if (sn.revision !== rec.revision) return stop('STALE_REVISION');
      if (sn.status === 'CANCELLED') return stop('CANCELLED');
      if (sn.status !== 'CONFIRMED') return stop('NOT_CONFIRMED');
      if (nowSec >= rec.endSec) return stop('EXPIRED');
      var elig = Core.evaluateEligibility(input.booking, coreConfig, nowSec);
      if (!elig.eligible) return stop(/^[A-Z][A-Z0-9_]{2,47}$/.test(String(elig.reason)) ? elig.reason : 'NOT_ELIGIBLE');
      if (elig.startSec !== rec.startSec || elig.endSec !== rec.endSec || elig.deviceId !== rec.deviceId) return stop('TARGET_CHANGED');
      var ds = deliverySettings(cfg);
      var hours = ds ? ds.startHoursBeforeDay : 6;
      var dayStart = Core.jstToEpochSec(sn.date, '00:00');
      if (dayStart === null) return hold('TIME_INVALID');
      if (nowSec < dayStart - hours * 3600) return hold('NOT_YET'); // 利用前日18:00 JST より前は送らない
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
    // ---- キー未発行対策（#885 第3弾）----
    // 「同期ジョブが完了した」ことと「個別キーが発行確認済みになった」ことは別。ジョブの成否とは独立に、
    // 利用開始が近い確定予約について発行確認済みのキー（ISSUED_CONFIRMED）の有無を見る。
    //  - 開始15分前〜: 優先再試行（観測待ち・ゲート待機を省き、処理順の先頭へ）。通知はしない。
    //  - 開始5分前〜 / 開始後: 運営者へ緊急通知（予約参照・revision のみ。暗証番号・個人情報は載せない）。
    // 再試行は既存の engine.sync（冪等）だけを使う。UNKNOWN/FAILED/送信中の鍵を壊して再発行することはしない
    // （同一予約・同一内容に対する二重発行を防ぐ）。通知は (コード, 予約参照, revision) ごとに1件で、不達のときだけ再送する。
    /**
     * 台帳読取で追跡する予約ID: 未解決の鍵操作がある予約 ∪ 直近の判定で反映未確認だった予約（KEYREADY.refs）。
     * 日付をまたいで続く予約は台帳の通常範囲（当日・翌日）から外れるため、OP が無い（容量で止まった）／終端（FAILED）でも
     * 反映未確認の間は追跡を続ける。解決・利用終了・台帳から消えた時点で、次の判定が refs から外す。
     */
    function trackedLedgerIds(ops) {
      var out = [];
      ops.forEach(function (r) { if (isUnresolved(r) && out.indexOf(r.bookingId) === -1) out.push(r.bookingId); });
      var kr = safeParse(deps.store.get('KEYREADY'));
      if (kr && Array.isArray(kr.refs)) kr.refs.forEach(function (id) { if (typeof id === 'string' && out.indexOf(id) === -1) out.push(id); });
      return out;
    }

    function prepareRecord(rec, nowMs) {
      var sn = deps.snapshot.build(rec, { facility: cfg.ledgerTarget.facility, room: cfg.ledgerTarget.room });
      var input = deps.snapshot.toCoreInput(sn, nowMs, { eligibleBrands: Array.isArray(cfg.eligibleBrands) ? cfg.eligibleBrands : [] });
      return { sn: sn, input: input };
    }

    function groupOps(ops) {
      var m = {};
      ops.forEach(function (r) { var k = String(r.bookingId); (m[k] = m[k] || []).push(r); });
      return m;
    }

    /** 発行確認済みキーが期待される予約（発行対象として有効な確定予約）だけ段階を返す。それ以外は null。 */
    function readinessOf(p, opsBy, nowSec) {
      var b = p.input && p.input.action === 'SYNC' ? p.input.booking : null;
      if (!b || b.status !== 'CONFIRMED') return null;
      // 内容とrevisionが食い違う予約（DIGEST_MISMATCH）は鍵操作を止めて凍結している。反映未確認の警告・再試行の対象にしない
      var trk = readTrack(p.sn.bookingId);
      if (trk && trk.revision === p.sn.revision && trk.digest && trk.digest !== p.sn.digest) return null;
      var elig = Core.evaluateEligibility(b, coreConfig, nowSec);
      if (!elig.eligible) return null;
      var s0 = Core.jstToEpochSec(p.sn.date, p.sn.startTime);
      var e0 = Core.jstToEpochSec(p.sn.endDate || p.sn.date, p.sn.endTime);
      if (s0 === null || e0 === null) return null;
      var level = keyReadinessLevel(nowSec, s0, e0, ic);
      return { level: level, ready: hasConfirmedKey(opsBy[String(p.sn.bookingId)], p.sn.revision, elig) };
    }

    function latestIssueState(opsOfBooking, revision) {
      var mine = (opsOfBooking || []).filter(function (r) { return r.op === Core.OP.ISSUE && r.revision === revision; });
      if (!mine.length) return 'NO_OP';
      mine.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
      var st = mine[mine.length - 1].state;
      return typeof st === 'string' && CODE_RE.test(st) ? st : 'UNKNOWN_STATE';
    }

    /**
     * 未発行の判定と緊急通知。鍵・予約には一切触れない（読取のみ＋通知）。失敗しても同期結果に影響させない。
     * 戻り値は件数のみ。予約単位の状態は状態ストア KEYREADY（予約参照・段階・OP状態のみ）へ最新を残す。
     */
    function runKeyReadiness(prepared) {
      var report = { priority: 0, warning: 0, urgent: 0, started: 0, undelivered: 0 };
      try {
        var nowSec = deps.nowSec();
        var opsBy = groupOps(scanOps(deps.store));
        var notReady = [];
        var refs = [];
        var alerts = [];
        prepared.forEach(function (p) {
          var rd = readinessOf(p, opsBy, nowSec);
          if (!rd || rd.level === 'NONE' || rd.ready) return;
          var ref = safeRef(p.sn.bookingId);
          notReady.push({ ref: ref || '-', level: rd.level, opState: latestIssueState(opsBy[String(p.sn.bookingId)], p.sn.revision) });
          if (ref && refs.length < 100) refs.push(ref);
          if (rd.level === 'PRIORITY') { report.priority++; return; }
          var code = rd.level === 'WARNING' ? 'KEY_UNCONFIRMED_WARNING' : (rd.level === 'URGENT' ? 'KEY_UNCONFIRMED_URGENT' : 'KEY_UNCONFIRMED_STARTED');
          if (rd.level === 'WARNING') report.warning++; else if (rd.level === 'URGENT') report.urgent++; else report.started++;
          // 開始後は未解決の間 startedRenotifySec ごとに再通知（利用終了で判定対象から外れて止まる）。直前に判定済みなので再検証は省く
          infraAlert(code, ref, p.sn.revision, null, rd.level === 'STARTED' ? ic.startedRenotifySec : undefined, true);
          alerts.push({ code: code, ref: ref, rev: p.sn.revision });
        });
        // 通知の不達検知: 緊急通知が所定回数失敗したまま未送達
        // 同じ予約・revision の段階（警告／緊急／開始後）のいずれかが所定回数失敗したまま未送達なら、予約1件として数える
        var undeliveredRefs = {};
        alerts.forEach(function (a) {
          URGENT_CODES.forEach(function (c) {
            var r = safeParse(deps.store.get(iaKey(c, a.ref, a.rev)));
            if (r && r.sentAt === null && r.attempts >= ic.urgentNotifyFailingAttempts) undeliveredRefs[(a.ref || '-') + '#' + a.rev] = true;
          });
        });
        report.undelivered = Object.keys(undeliveredRefs).length;
        var prev = safeParse(deps.store.get('KEYREADY'));
        if (notReady.length || (prev && prev.count > 0)) {
          deps.store.set('KEYREADY', JSON.stringify({ at: nowSec, count: notReady.length, undelivered: report.undelivered, notReady: notReady.slice(0, 20), refs: refs }));
        }
        if (report.undelivered > 0) { try { deps.store.set('NOTIFYFAIL', String(nowSec)); } catch (e1) { /* 無視 */ } }
      } catch (e) {
        report.error = true; // 判定・記録の失敗は同期結果へ伝播させない（次の周期で再判定）
      }
      return report;
    }

    /** 同期を実行できない周期（API予算超過）でも、台帳を読めれば未発行の緊急通知だけは判定する。 */
    function runKeyReadinessWithoutSync() {
      try {
        var nowMs = deps.nowMs();
        // 日付をまたいで続く予約は台帳の通常範囲から外れる。通常の同期と同じく、未解決の鍵操作がある予約を追跡対象にする
        var led = deps.ledger.read({ nowMs: nowMs, trackedIds: trackedLedgerIds(scanOps(deps.store)) });
        if (!led || led.ok !== true) return null;
        return runKeyReadiness(led.records.map(function (r) { return prepareRecord(r, nowMs); }));
      } catch (e) { return null; }
    }

    function syncCycle() {
      return runLocked('SYNC', ic.lockWaitMs, function () {
        var startedMs = deps.nowMs();
        drainInbox();
        flushOutbox();
        if (cfg.enabled !== true) return { ok: true, skipped: 'FLAG_OFF' };
        if (budget.exhausted()) {
          infraAlert('API_BUDGET_EXHAUSTED', null, null, null);
          runKeyReadinessWithoutSync();
          return { ok: false, error: 'API_BUDGET_EXHAUSTED' };
        }
        var ops = scanOps(deps.store);
        var openByBooking = {};
        ops.forEach(function (r) { if (isUnresolved(r)) openByBooking[r.bookingId] = true; });
        var nowMs = deps.nowMs();
        var led = deps.ledger.read({ nowMs: nowMs, trackedIds: trackedLedgerIds(ops) });
        if (!led || led.ok !== true) {
          var ledCode = led && typeof led.error === 'string' && /^LEDGER_[A-Z_]+$/.test(led.error) && Object.prototype.hasOwnProperty.call(CATALOG, led.error) ? led.error : 'LEDGER_READ_FAILED';
          infraAlert(ledCode, null, null, null);
          engine.reconcilePending({}); // 台帳が読めなくても、送信済み削除の確認（読み取りのみ）は期限内に進める（#829）
          return { ok: false, error: 'LEDGER_READ_FAILED' };
        }
        // 準備: 予約ごとのスナップショットと入力を1回だけ作る。開始が近い未発行の予約（優先再試行の対象）を先頭へ、
        // 次に未解決OPのある予約。実行時間の上限（runBudgetSec）で後ろが繰り延べられても、直近の予約が取り残されない。
        var prepared = led.records.map(function (r) { return prepareRecord(r, nowMs); });
        var opsBy = groupOps(ops);
        var nowS0 = deps.nowSec();
        var imminent = {};
        prepared.forEach(function (p) {
          var rd = readinessOf(p, opsBy, nowS0);
          if (rd && rd.level !== 'NONE' && !rd.ready) imminent[String(p.sn.bookingId)] = rd.level;
        });
        function rank(p) { var id = String(p.sn.bookingId); return imminent[id] ? 2 : (openByBooking[id] ? 1 : 0); }
        var order = prepared.slice().sort(function (a, b) { return rank(b) - rank(a); });
        var summary = { ok: true, synced: 0, frozen: 0, waiting: 0, skipped: 0, deferred: 0, gateStops: [] };
        var syncedBookings = {};
        for (var i = 0; i < order.length; i++) {
          if (deps.nowMs() - startedMs > ic.runBudgetSec * 1000) { summary.deferred = order.length - i; break; }
          var sn = order[i].sn;
          var input = order[i].input;
          var isImminent = !!imminent[String(sn.bookingId)];
          var tr = readTrack(sn.bookingId);
          // 限定稼働（#757）: 許可リスト外で、鍵の未解決OPも無い予約は、凍結通知・追跡記録のどちらも行わず黙って対象外とする。
          // 追跡（revision／発行窓の処理済み）を書かないので、後でリストに加えれば次の周期で再評価される。
          // 既に鍵のOPがある予約は通常の経路へ進み、非対象として旧キーが回収される。
          var pilotExcluded = Array.isArray(cfg.pilotBookingIds) && cfg.pilotBookingIds.indexOf(String(sn.bookingId)) === -1;
          if (pilotExcluded && !openByBooking[sn.bookingId]) {
            summary.skipped++;
            continue;
          }
          // 発行対象外ブランド（#824）: 設定 eligibleBrands に無いブランドの予約が、追跡記録も未解決OPも無いまま候補に入った場合は、
          // 凍結通知・追跡記録のどちらも行わず黙って見送る。ここで「処理済み(revision/発行窓)」を書くと、後で eligibleBrands を
          // 拡大しても再評価されず発行されないため。追跡済み・OPありの予約（SNB→他ブランド変更の旧キー回収など）は通常の経路へ進む。
          var brandExcluded = sn.brand !== '' && !(Array.isArray(cfg.eligibleBrands) && cfg.eligibleBrands.indexOf(sn.brand) !== -1);
          if (brandExcluded && !tr && !openByBooking[sn.bookingId]) {
            summary.skipped++;
            continue;
          }
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
          // 開始が近い未発行の予約は、改訂・発行窓が処理済みでも毎周期 engine.sync（冪等）で再評価する
          if (!reasonsT.length && !isImminent) { summary.skipped++; continue; }
          // 静穏時間: 同じ (revision, digest) を quietSec 以上前から観測している場合のみ同期（精算中の中間状態で発行しない）
          var nowS = deps.nowSec();
          var sameObs = tr && tr.obsRevision === sn.revision && tr.obsDigest === sn.digest;
          // 優先再試行（開始15分前〜）の予約は、静穏時間・ゲート待機を省く。支払未確認などは toCoreInput が先に凍結済みで、
          // ここへ来るのは発行対象として有効な確定予約のみ。内容が後で変わっても、旧キーは次回の sync が回収する。
          if (!sameObs) {
            writeTrack(sn.bookingId, Object.assign({}, tr || {}, { obsRevision: sn.revision, obsDigest: sn.digest, obsAt: nowS, seenAt: nowS }));
            if (!isImminent) { summary.waiting++; continue; }
            tr = readTrack(sn.bookingId) || { obsAt: nowS };
          } else if (nowS - tr.obsAt < ic.quietSec && !isImminent) { summary.waiting++; continue; }
          // 発行ゲートで止まった予約は、再評価の間隔を空ける（OP が無い間のみ。進行中 OP の照合は止めない）。優先再試行の対象は毎周期再評価
          if (tr.gateHoldUntil && nowS < tr.gateHoldUntil && !openByBooking[sn.bookingId] && !isImminent) { summary.waiting++; continue; }
          var out;
          try { out = engine.sync(input.booking); }
          catch (e) {
            infraAlert('SYNC_ERROR', safeRef(sn.bookingId), sn.revision, null);
            runKeyReadiness(prepared); // 同期が失敗しても、反映未確認の判定・通知は読取りと通知だけで実行できる（結果は SYNC_ERROR のまま）
            return { ok: false, error: 'SYNC_ERROR' }; // 保存失敗などはサイクルを止める（予約側へは何も伝播しない）
          }
          summary.synced++;
          syncedBookings[String(sn.bookingId)] = true;
          if (out.gateStop) {
            // 発行を試行できなかった（OP未作成/未送信）。revision・発行窓は「未処理」のまま保持し、
            // 次回以降ゲートを再評価する（復旧後に発行対象から脱落させない）。通知は重複抑止、再評価は gateRetrySec 間隔
            summary.gateStops.push(out.gateStop);
            infraAlert(out.gateStop, null, null, null);
            writeTrack(sn.bookingId, { revision: tr ? tr.revision : null, digest: tr ? tr.digest : undefined, windowHandled: tr ? !!tr.windowHandled : false,
              obsRevision: sn.revision, obsDigest: sn.digest, obsAt: tr.obsAt, seenAt: nowS, gateHoldUntil: isImminent ? nowS : nowS + ic.gateRetrySec });
            continue;
          }
          var windowOpen = sn.status === 'CONFIRMED' && deps.snapshot.issueWindow(sn, nowMs).open;
          // 保存に失敗した TRK は次回再同期になるだけ（コアは冪等）
          // 許可リスト外の旧キー回収中は「処理済み」を記録しない（revision=null・発行窓は未処理）。回収後にリストへ戻した予約が、
          // 追加の改訂なしで再評価・再発行されるようにするため。回収中は未解決OPが再同期の理由になるので、処理は進む。
          if (pilotExcluded) writeTrack(sn.bookingId, { revision: null, windowHandled: false, obsRevision: sn.revision, obsDigest: sn.digest, obsAt: tr ? tr.obsAt : nowS, seenAt: nowS });
          else writeTrack(sn.bookingId, { revision: sn.revision, digest: sn.digest, windowHandled: windowOpen, obsRevision: sn.revision, obsDigest: sn.digest, obsAt: tr ? tr.obsAt : nowS, seenAt: nowS });
        }
        engine.reconcilePending(syncedBookings); // 今回 sync で照合済みの予約は除く（読取回数を二重に消費しない）
        summary.keyReadiness = runKeyReadiness(prepared); // 同期の成否とは別に、発行確認済みキーの有無を判定・通知する
        return summary;
      });
    }

    function safeRef(id) { return typeof id === 'string' && REF_RE.test(id) ? id : undefined; }

    // ---- 配送（OFF時は停止。cfg.deliveryConfigured が運営承認までtrueにならない限り何もしない）----
    function deliverCycle() {
      return runLocked('DELIVER', ic.lockWaitMs, function () {
        if (cfg.enabled !== true) return { ok: true, skipped: 'FLAG_OFF' };
        if (cfg.deliveryConfigured !== true || !deliveryReady()) return { ok: true, skipped: 'DELIVERY_NOT_CONFIGURED' };
        var startedMs = deps.nowMs();
        var out = { ok: true, delivered: 0, failed: 0, unknown: 0, held: 0, suppressed: 0 };
        var due = scanOps(deps.store).filter(function (r) { return r.state === Core.STATE.ISSUED_CONFIRMED && engine.deliveryDue(r.id); });
        if (!due.length) return out; // 台帳も読まない
        // 送信直前の再確認のため、サイクル内で最新の台帳を1回読む。読めなければ何も送らない（fail closed）
        var led = null;
        try { led = deps.ledger.read({ nowMs: deps.nowMs(), trackedIds: due.map(function (r) { return r.bookingId; }) }); } catch (e) { led = null; }
        if (!led || led.ok !== true) { infraAlert(ledgerErrCode(led), null, null, null); return { ok: false, error: 'LEDGER_READ_FAILED' }; }
        cycleFresh = led;
        try {
          for (var i = 0; i < due.length; i++) {
            if (deps.nowMs() - startedMs > ic.runBudgetSec * 1000) { out.held += due.length - i; break; } // 実行時間の上限。残りは次回
            var d;
            try { d = engine.deliver(due[i].id); }
            catch (e2) { infraAlert('SYNC_ERROR', safeRef(due[i].bookingId), due[i].revision, null); out.failed++; continue; } // 保存失敗等: 送信前なら何も送っていない
            if (d.delivered) out.delivered++;
            else if (d.reason === 'DELIVERY_UNKNOWN') out.unknown++;
            else if (d.reason === 'DELIVER_FAILED' || d.reason === 'RETRY_EXHAUSTED') out.failed++;
            else if (typeof d.reason === 'string' && d.reason.indexOf('SUPPRESSED') === 0) out.suppressed++;
            else out.held++;
          }
        } finally { cycleFresh = null; }
        return out;
      });
    }

    // ---- 期限切れ確認・回収・容量/保存の監視 ----
    function sweepBody(sweepOpts) {
      drainInbox();
      flushOutbox();
      var sw = engine.sweep(sweepOpts); // 期限切れ予約用キーの自動削除（Issue #829。ACCESS_ENABLED=ON のときだけ変更APIを呼ぶ）
      var gcReport = {};
      var removed = garbageCollect(deps.store, deps.secrets, deps.nowSec(), cfg, gcReport);
      // 未分類キーは削除も通知もしない（メール送信の副作用を増やさない）。件数のみ unclassifiedKeys で報告する。
      var st = storageGate(measureStore(deps.store), cfg, cfg.storageLimits);
      if (!st.ok) infraAlert(st.code, null, null, null);
      return { ok: true, removed: removed, unclassifiedKeys: gcReport.unclassified || 0, cleanup: { attempted: sw && sw.attempted || 0, confirmed: sw && sw.confirmed || 0, pending: sw && sw.pending || 0, stopped: sw && sw.stopped || 0, deferred: sw && sw.deferred || 0 }, storage: { ratio: st.ratio, ok: st.ok } };
    }

    function sweepCycle() {
      return runLocked('SWEEP', ic.lockWaitMs, function () { return sweepBody(); });
    }

    /**
     * 日次クリーンアップ（Issue #829。00:15 JST 近辺。GAS の時間主導は厳密でないため、実行時刻に依存せず
     * 常に「endSec <= 現在」だけを根拠にする）。1 時間周期の sweep の取り残しを補完する。
     * 1 回あたりの削除上限は日次のほうが大きい。上限超過・API 障害分は次の周期（1 時間後の sweep）で収束する。
     */
    function dailyCleanupCycle() {
      var cap = typeof cfg.dailyCleanupMaxDeletes === 'number' ? cfg.dailyCleanupMaxDeletes : 20;
      return runLocked('CLEANUP', ic.lockWaitMs, function () { return sweepBody({ maxDeletes: cap }); });
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
    var ADMIN_ACTIONS = ['status', 'inventory', 'inspect', 'reconcile', 'resolveUnknown', 'delete', 'resolveDelivery'];

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
      if (action === 'resolveDelivery' && Core.DELIVERY_DECISIONS.indexOf(args.decision) === -1) return { ok: false, error: 'DECISION_INVALID' };
      var out = runLocked('ADMIN', ic.lockWaitMs, function () {
        // 変更系は監査の事前記録に失敗したら実行しない
        var mutating = action === 'reconcile' || action === 'resolveUnknown' || action === 'delete' || action === 'resolveDelivery';
        if (action !== 'status' && action !== 'inventory') drainInbox(); // 期限内に退避された根拠を、管理者の照合前に反映する
        if (mutating && !auditAdmin(who.actor, action, recId, 'ATTEMPT')) return { ok: false, error: 'AUDIT_UNAVAILABLE' };
        var r;
        if (action === 'status') r = statusLocked();
        else if (action === 'inventory') r = { ok: true, items: engine.inventory() };
        else if (action === 'inspect') r = engine.adminInspect(recId);
        else if (action === 'reconcile') r = engine.adminReconcile(recId, who.actor);
        else if (action === 'resolveUnknown') r = engine.adminResolveUnknown(recId, args.decision, who.actor);
        else if (action === 'resolveDelivery') r = engine.adminResolveDelivery(recId, args.decision, who.actor);
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
      var deliveries = {};
      deps.store.keys().forEach(function (k) { if (k.indexOf('DLV_') === 0) { var dx = safeParse(deps.store.get(k)); var ds0 = dx && typeof dx.state === 'string' ? dx.state : 'INVALID'; deliveries[ds0] = (deliveries[ds0] || 0) + 1; } });
      deps.store.keys().forEach(function (k) { if (k.indexOf('IALERT_') === 0) { var x = safeParse(deps.store.get(k)); if (x && x.sentAt === null) outbox.pending++; } });
      return {
        ok: true, environment: cfg.environment, enabled: cfg.enabled === true, byState: byState, unresolved: unresolved, deliveries: deliveries,
        storage: { keys: m.keys, bytes: m.bytes, ratio: st.ratio, gate: st.ok ? 'OK' : st.code, byPrefix: m.byPrefix },
        heartbeats: { SYNC: safeParse(deps.store.get('HB_SYNC')), SWEEP: safeParse(deps.store.get('HB_SWEEP')), CLEANUP: safeParse(deps.store.get('HB_CLEANUP')), DELIVER: safeParse(deps.store.get('HB_DELIVER')) },
        keyReadiness: safeParse(deps.store.get('KEYREADY')), apiCallsToday: budget.used(), notifyOutbox: outbox, notifyFailingSince: Number(deps.store.get('NOTIFYFAIL')) || null,
        plan: plan
      };
    }

    return {
      handleWebhook: handleWebhook, syncCycle: syncCycle, deliverCycle: deliverCycle, sweepCycle: sweepCycle, dailyCleanupCycle: dailyCleanupCycle,
      watchdog: watchdog, admin: admin, engine: engine, plan: plan, infraAlert: infraAlert
    };
  }

  // ---------- 37DD 期限境界（開始前／期間内／期限後）解錠試験（親 #748・計画 #756）----------
  //
  // 目的: 未来開始・短期間の試験キー1件で「開始前不可／期間内可／期限後不可」を粗い境界（±180秒）で実測する。
  // #791/#797 は一度も解錠しておらず、startTime/endTime の単位・時刻解釈は実機で未検証。本試験でも成功を保証しない。
  // 設計上の約束:
  //  - SwitchBot API は合計 BND_MAX_CALLS(=4) 回: LIST(GET)・ISSUE(createKey POST)・VERIFY_ISSUED(GET)・FINAL_LIST(GET)。各1回・再送なし。
  //  - deleteKey の経路を持たない。試験キーの回収は公式アプリでの手動削除（APP_ABSENT の記録が完了条件）。
  //  - #791(ACCESS_TEST_KEY_STATE=STOPPED)・#797(ACCESS_NUMID_TEST_STATE=COMPLETE) は読むだけ。指紋で不変を毎段階確認する。
  //  - 使い捨て暗証番号はオーナーが Script Properties に一時設定。ISSUE が通信より前に読み取り・削除し、以後どの経路にも残さない。
  //  - 解錠は現地の物理操作でありAPIでは観測できない。結果はオーナーが通信なしの bndObserve で申告し、時刻の整合だけ機械検査する。
  // コード・設定のマージ/デプロイ/ARMED では何も起きない。#756 の実機GO（日時・担当・通信上限・試行回数）後にのみ実行する。
  var BND_MAX_CALLS = 4;
  var BND_PLAN = 'BND_PLAN_V1_4CALLS';
  var BND_PROP = {
    ARMED: 'ACCESS_BND_TEST_ARMED', APPROVAL: 'ACCESS_BND_TEST_APPROVAL', STATE: 'ACCESS_BND_TEST_STATE',
    PASSCODE: 'ACCESS_BND_TEST_PASSCODE', ATTEST: 'ACCESS_BND_PASSCODE_ATTEST', A2_RETRY: 'ACCESS_BND_A2_RETRY_GO'
  };
  var BND_ATTEST_VALUE = 'NOT_IN_USE_CONFIRMED';  // 「既存の通常コードと重複しない」ことのオーナー申告。照合手段がないため申告がなければ発行しない
  var BND_A2_RETRY_VALUE = 'ALLOWED_ONCE';       // GO欄で許可された場合だけ A2 の再試行を1回認める
  var BND_START_OFFSET_SEC = 600, BND_DURATION_SEC = 900;
  var BND_START_OFFSET_RANGE = [300, 900], BND_DURATION_RANGE = [600, 1800];
  var BND_LIST_TO_ISSUE_MIN_SEC = 60;   // LIST→ISSUE の最短間隔
  var BND_BASELINE_MAX_AGE_SEC = 900;   // LIST の基準が古すぎるときは発行しない
  var BND_ISSUE_TO_VERIFY_MIN_SEC = 120;
  var BND_A1_HEADROOM_SEC = 240;        // VERIFY_ISSUED は S-240 秒より前でなければ実行しない（A1=S-180 の余裕を機械的に確保）
  var BND_SEND_DRIFT_MAX_SEC = 5;       // 状態永続から送信までの時計のずれ上限。T0 は実際の送信直前に固定する
  var BND_FINAL_AFTER_END_SEC = 300;    // FINAL_LIST は E+300 秒以降
  var BND_STAGES = {
    LIST:          { from: ['INIT'],               pre: 'LIST_SENT' },
    ISSUE:         { from: ['LISTED'],             pre: 'ISSUE_SENT' },
    VERIFY_ISSUED: { from: ['ISSUE_ACCEPTED'],     pre: 'VERIFY_ISSUED_SENT' },
    FINAL_LIST:    { from: ['A4_RECORDED'],        pre: 'FINAL_LIST_SENT' }
  };
  // 通信なしの観測申告。critical は即 STOPPED（重大な異常）。when は申告時刻の整合検査（申告は試行の後なので「少なくとも」の検査）。
  var BND_OBS = {
    A1_DENIED:       { step: 'A1',  res: 'DENIED',       from: 'ISSUED_VERIFIED',  to: 'A1_RECORDED', when: 'BEFORE_START' },
    A1_INCONCLUSIVE: { step: 'A1',  res: 'INCONCLUSIVE', from: 'ISSUED_VERIFIED',  to: 'A1_RECORDED', when: 'BEFORE_START' },
    A1_SKIPPED:      { step: 'A1',  res: 'SKIPPED',      from: 'ISSUED_VERIFIED',  to: 'A1_RECORDED', when: null },
    A1_UNLOCKED:     { step: 'A1',  res: 'UNLOCKED',     from: 'ISSUED_VERIFIED',  critical: 'A1_UNLOCKED_BEFORE_START' },
    A2_UNLOCKED:     { step: 'A2',  res: 'UNLOCKED',     from: 'A1_RECORDED',      to: 'A2_RECORDED', when: 'IN_WINDOW' },
    A2_SKIPPED:      { step: 'A2',  res: 'SKIPPED',      from: 'A1_RECORDED',      to: 'A2_RECORDED', when: null },
    A2_DENIED:       { step: 'A2',  res: 'DENIED',       from: 'A1_RECORDED',      retry: true, when: 'IN_WINDOW' },
    A2R_UNLOCKED:    { step: 'A2R', res: 'UNLOCKED',     from: 'A2_RETRY_PENDING', to: 'A2_RECORDED', when: 'IN_WINDOW' },
    A2R_SKIPPED:     { step: 'A2R', res: 'SKIPPED',      from: 'A2_RETRY_PENDING', to: 'A2_RECORDED', when: null }, // 許可された再試行を実施しなかった（期限切れ等）。合否は NOT_ESTABLISHED
    A2R_DENIED:      { step: 'A2R', res: 'DENIED',       from: 'A2_RETRY_PENDING', critical: 'A2_DENIED_AFTER_RETRY' },
    A3_UNLOCKED:     { step: 'A3',  res: 'UNLOCKED',     from: 'A2_RECORDED',      to: 'A3_RECORDED', when: 'IN_WINDOW' },
    A3_SKIPPED:      { step: 'A3',  res: 'SKIPPED',      from: 'A2_RECORDED',      to: 'A3_RECORDED', when: null },
    A3_DENIED:       { step: 'A3',  res: 'DENIED',       from: 'A2_RECORDED',      critical: 'A3_DENIED_IN_WINDOW' },
    A4_DENIED:       { step: 'A4',  res: 'DENIED',       from: 'A3_RECORDED',      to: 'A4_RECORDED', when: 'AFTER_END' },
    A4_INCONCLUSIVE: { step: 'A4',  res: 'INCONCLUSIVE', from: 'A3_RECORDED',      to: 'A4_RECORDED', when: 'AFTER_END' },
    A4_SKIPPED:      { step: 'A4',  res: 'SKIPPED',      from: 'A3_RECORDED',      to: 'A4_RECORDED', when: null },
    A4_UNLOCKED:     { step: 'A4',  res: 'UNLOCKED',     from: 'A3_RECORDED',      critical: 'A4_UNLOCKED_AFTER_END' },
    KEYPAD_LOCK_SIGN: { any: true, critical: 'KEYPAD_LOCK_OR_ALARM_SIGN' }
  };
  var BND_OBS_STATES = ['ISSUED_VERIFIED', 'A1_RECORDED', 'A2_RETRY_PENDING', 'A2_RECORDED', 'A3_RECORDED', 'A4_RECORDED', 'FINAL_LISTED_APP_PENDING']; // 末尾2つは回収前の遅れた重大申告（KEYPAD_LOCK_SIGN）だけ受け付ける

  /**
   * 境界試験の合否（回収完了とは独立）。全必須観測が A1=DENIED・A2=UNLOCKED（許可再試行での解錠を含む）・A3=UNLOCKED・A4=DENIED で、
   * かつ前提の証拠（発行したキーの開始・終了が返却値と一致）がそろったときだけ BOUNDARY_PASS。
   * SKIPPED を含めば PARTIAL、INCONCLUSIVE を含めば INCONCLUSIVE、観測が欠ける・重大異常で停止なら NOT_ESTABLISHED。
   * PASS 以外は 01FD の判断に使えない。粗い境界（±180秒）・単一端末・単一キー・申告ベースの結果であり、一般化しない。
   */
  function bndVerdict(s) {
    var o = (s && s.obs) || {};
    if (!s || s.state === 'STOPPED' || s.state === 'STOPPED_RECOVERED' || o.LOCK === 'SIGN') return 'BOUNDARY_NOT_ESTABLISHED';
    var vals = ['A1', 'A2', 'A3', 'A4'].map(function (k) { return o[k]; });
    if (vals.some(function (v) { return v === undefined; })) return 'BOUNDARY_NOT_ESTABLISHED';
    if (vals.indexOf('INCONCLUSIVE') !== -1) return 'BOUNDARY_INCONCLUSIVE';
    if (vals.indexOf('SKIPPED') !== -1) return 'BOUNDARY_PARTIAL';
    var a2ok = o.A2 === 'UNLOCKED' || (o.A2 === 'DENIED' && o.A2R === 'UNLOCKED');
    if (o.A1 === 'DENIED' && a2ok && o.A3 === 'UNLOCKED' && o.A4 === 'DENIED') {
      return s.attrEcho === 'RETURNED_AND_MATCHED' ? 'BOUNDARY_PASS' : 'BOUNDARY_PARTIAL_PREMISE_UNVERIFIED';
    }
    return 'BOUNDARY_NOT_ESTABLISHED';
  }

  function bndJudgement(out, s) {
    out.verdict = bndVerdict(s);
    out.decisionUse = out.verdict === 'BOUNDARY_PASS' ? 'USABLE_FOR_01FD_JUDGEMENT' : 'NOT_USABLE_FOR_01FD_JUDGEMENT';
    var o = (s && s.obs) || {};
    out.a2Basis = o.A2 === 'UNLOCKED' ? 'FIRST_ATTEMPT' : (o.A2R === 'UNLOCKED' ? 'RETRY_GRANTED' : 'NOT_UNLOCKED');
  }

  function bndBlank() {
    return { ok: false, code: 'BND_TEST_NOT_RUN', stage: 'NOT_CHECKED', failures: [], stopped: false, apiCalls: 0, callsUsed: 0, callsMax: BND_MAX_CALLS,
      state: 'NOT_CHECKED', manualRecovery: false, evidence: 'NONE', keyCount: 0, passcodeState: 'NOT_TOUCHED',
      timeProfile: 'OFFSET_600_DURATION_900', timeUnit: 'EPOCH_SECONDS_NOT_VERIFIED_ON_DEVICE',
      notes: ['VERIFY_ONLY', 'TARGET_37DD_ONLY', 'ONE_TEST_KEY_ONLY', 'NO_AUTO_RETRY', 'NO_DELETE_KEY_PATH', 'COARSE_BOUNDARY_ONLY',
        'ACCEPTED_IS_NOT_UNLOCK_PROOF', 'DENIAL_ALONE_IS_NOT_TIME_CONTROL_PROOF', 'OWNER_DECLARED_OBSERVATIONS'] };
  }

  function bndReadState(sp) {
    var raw;
    try { raw = sp.get(BND_PROP.STATE); } catch (e) { return { ok: false }; }
    if (raw === undefined) return { ok: false };
    if (raw === null || raw === '') return { ok: true, st: { v: 1, state: 'INIT', calls: 0, name: '', baselineCount: -1, baselineFp: '', obs: {} } };
    var p = safeParse(raw);
    if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.state !== 'string' || typeof p.calls !== 'number' || p.calls < 0 || p.calls > BND_MAX_CALLS) return { ok: false };
    return { ok: true, st: p };
  }

  function bndWrite(sp, st) {
    try { sp.set(BND_PROP.STATE, JSON.stringify(st)); return true; } catch (e) { return false; }
  }

  /**
   * STOPPED を永続する。書込み結果を必ず返し、失敗時は「保存済み」と報告させない（呼出し側が STOP_NOT_PERSISTED を明示する）。
   * 失敗しても自動再送・追加通信・無断復旧はしない。*_SENT が残る場合はそれが再送抑止になる。
   */
  function bndStopWrite(sp, base, code, out) {
    var s = JSON.parse(JSON.stringify(base)); s.state = 'STOPPED'; s.reason = code;
    out.manualRecovery = true;
    if (bndWrite(sp, s)) { out.state = 'STOPPED'; out.persistence = 'PERSISTED'; return true; }
    out.persistence = 'NOT_PERSISTED';
    if (out.failures.indexOf('STOP_NOT_PERSISTED') === -1) out.failures.push('STOP_NOT_PERSISTED'); // 先頭に出す固定コード。元の理由も続けて残す
    return false;
  }

  /** 開始・終了時刻の計算とガード（純粋関数）。範囲外は通信前に拒否する。値は epoch 秒。 */
  function bndWindowPlan(nowSec, offsetSec, durationSec) {
    if (typeof nowSec !== 'number' || !isFinite(nowSec) || nowSec <= 0) return { ok: false, code: 'TIME_WINDOW_GUARD' };
    if (typeof offsetSec !== 'number' || !isFinite(offsetSec) || offsetSec < BND_START_OFFSET_RANGE[0] || offsetSec > BND_START_OFFSET_RANGE[1]) return { ok: false, code: 'TIME_WINDOW_GUARD' };
    if (typeof durationSec !== 'number' || !isFinite(durationSec) || durationSec < BND_DURATION_RANGE[0] || durationSec > BND_DURATION_RANGE[1]) return { ok: false, code: 'TIME_WINDOW_GUARD' };
    var s = Math.floor(nowSec) + offsetSec;
    return { ok: true, startSec: s, endSec: s + durationSec };
  }

  /** 8桁の数字。全桁同一・連番は拒否（推測されやすい番号を使い捨てでも使わない）。値は返さない。 */
  function bndPasscodeOk(v) {
    if (typeof v !== 'string' || !/^[0-9]{8}$/.test(v)) return false;
    if (/^(.)\1{7}$/.test(v)) return false;
    if ('01234567890'.indexOf(v) !== -1 || '09876543210'.indexOf(v) !== -1) return false;
    return true;
  }

  /** 暗証番号と申告プロパティの両方を削除し、消えたことを読み直して確認する。成功のときだけ true。 */
  function bndScrubPasscode(sp) {
    [BND_PROP.PASSCODE, BND_PROP.ATTEST].forEach(function (k) {
      if (diagRead(sp, k).state === 'MISSING') return; // 未設定なら削除操作自体を行わない
      try { sp.del(k); } catch (e) { /* 読み直しで判定 */ }
    });
    return diagRead(sp, BND_PROP.PASSCODE).state === 'MISSING' && diagRead(sp, BND_PROP.ATTEST).state === 'MISSING';
  }

  function bndLegacyFp(sp, sha) {
    var a, b;
    try { a = sp.get(TKS_PROP.STATE); b = sp.get(NID_PROP.STATE); } catch (e) { return null; }
    return sha('BND_LEGACY|' + String(a) + '|' + String(b));
  }

  /** #791(STOPPED)・#797(COMPLETE) が不変で、それぞれの ARMED/APPROVAL が未設定であることを読むだけで確認する。 */
  function bndPrereq(sp) {
    var pr = nidPrereq(sp);
    if (pr) return pr;
    var na = diagRead(sp, NID_PROP.ARMED);
    if (na.state === 'UNKNOWN') return 'NUMID_ARMED_STATE_UNKNOWN';
    if (na.state === 'SET') return 'NUMID_ARMED_PRESENT';
    var np = diagRead(sp, NID_PROP.APPROVAL);
    if (np.state === 'UNKNOWN') return 'NUMID_APPROVAL_STATE_UNKNOWN';
    if (np.state === 'SET') return 'NUMID_APPROVAL_PRESENT';
    var ns = nidReadState(sp);
    if (!ns.ok) return 'NUMID_STATE_UNREADABLE';
    if (ns.st.state !== 'COMPLETE') return 'NUMID_STATE_NOT_COMPLETE';
    return null;
  }

  /**
   * 通信する1段階。stage ∈ LIST / ISSUE / VERIFY_ISSUED / FINAL_LIST。deleteKey は呼ばない（コードパスなし）。
   * 返すのは固定コード・件数・真偽値・秒数のみ（完全deviceId・暗証番号・トークン・passcode ID・キー名・例外本文・commandId を含めない）。
   */
  function bndStage(deps, stage) {
    var out = bndBlank();
    var def = BND_STAGES[stage];
    out.stage = def ? stage : 'INVALID_STAGE';
    var sp = deps.scriptProps, locked = false, scrubDue = false;
    function fin() {
      out.ok = out.failures.length === 0;
      out.code = out.ok ? 'BND_' + stage + '_OK' : out.failures[0];
      return diagSanitize(out, 0);
    }
    function stop(code) {
      if (scrubDue) { // 暗証番号を読みうる段階の拒否・失敗・例外では、必ず破棄を試みる（残れば手動復旧）
        var ok = bndScrubPasscode(sp);
        scrubDue = !ok; out.passcodeState = ok ? 'SCRUBBED_ON_STOP' : 'SCRUB_FAILED';
        if (!ok) out.manualRecovery = true;
      }
      if (out.failures.indexOf(code) === -1) out.failures.push(code);
      out.stopped = true; return fin();
    }
    if (!def) return stop('INVALID_STAGE');
    // ISSUE の直前にオーナーが番号を設定する。以降の拒否・例外は、どのゲートでの拒否でも番号と申告を破棄する（通信は常にゼロ）。
    // 削除するのは暗証番号と申告の2プロパティだけで、ゲートの判定・通信前拒否の順序は変えない。
    if (stage === 'ISSUE') scrubDue = true;
    try {
      var g = tksGates(deps);
      if (!g.ok) return stop(g.code);
      var pr = bndPrereq(sp);
      if (pr) return stop(pr);
      var armed = diagRead(sp, BND_PROP.ARMED);
      if (armed.state === 'UNKNOWN') return stop('ARMED_STATE_UNKNOWN');
      if (armed.state === 'MISSING') return stop('NOT_ARMED');
      if (armed.raw !== BND_PLAN) return stop('ARMED_PLAN_MISMATCH');

      if (stage !== 'ISSUE') {
        var pc0 = diagRead(sp, BND_PROP.PASSCODE), at0 = diagRead(sp, BND_PROP.ATTEST);
        if (pc0.state === 'UNKNOWN' || at0.state === 'UNKNOWN') return stop('PASSCODE_STATE_UNKNOWN');
        if (pc0.state === 'SET' || at0.state === 'SET') {
          var cleaned = bndScrubPasscode(sp);
          out.passcodeState = cleaned ? 'RESIDUAL_SCRUBBED' : 'SCRUB_FAILED';
          out.manualRecovery = true;
          return stop('PASSCODE_RESIDUAL');
        }
      }

      if (!deps.lock || !deps.lock.tryLock(1000)) return stop('LOCK_UNAVAILABLE');
      locked = true;

      var rs = bndReadState(sp);
      if (!rs.ok) return stop('STATE_UNREADABLE');
      var st = rs.st;
      out.state = DIAG_VALUE_RE.test(st.state) ? st.state : 'INVALID_VALUE';
      out.callsUsed = st.calls;
      if (st.state === 'STOPPED' || /_SENT$/.test(st.state)) { out.manualRecovery = true; return stop(st.state === 'STOPPED' ? 'STOPPED_MANUAL_RECOVERY' : 'INTERRUPTED_MANUAL_RECOVERY'); }
      if (st.state === 'RECOVERED' || st.state === 'STOPPED_RECOVERED') return stop('ALREADY_COMPLETE');
      if (def.from.indexOf(st.state) === -1) return stop(st.state === def.pre || st.state === stage ? 'STAGE_ALREADY_DONE' : 'STAGE_ORDER_VIOLATION');

      var sha = deps.sha256Hex;
      var nowSec = deps.nowSec();

      function persistStop(code) { // 通信前の不整合: 呼出し回数は増やさず STOPPED にする（以後は公式アプリで手動撤去）。保存できなければそう報告する
        bndStopWrite(sp, st, code, out);
        return stop(code);
      }

      var ap = diagRead(sp, BND_PROP.APPROVAL);
      if (ap.state === 'UNKNOWN') return stop('APPROVAL_STATE_UNKNOWN');
      if (ap.raw !== stage) return stop('STAGE_NOT_APPROVED');
      var cred;
      try { cred = !!(deps.userProps.get('SWITCHBOT_TOKEN') && deps.userProps.get('SWITCHBOT_SECRET')); } catch (e) { cred = false; }
      if (!cred) return stop('AUTH_CREDENTIALS_MISSING');
      if (st.calls >= BND_MAX_CALLS) return stop('CALL_BUDGET_EXHAUSTED');
      var devFp = sha('BND_DEVICE|' + g.deviceId);
      var legacyFp = bndLegacyFp(sp, sha);
      if (!legacyFp) return stop('LEGACY_STATE_UNREADABLE');
      if (stage !== 'LIST') {
        if (st.deviceFp !== devFp) return stop('TARGET_DEVICE_CHANGED');
        if (st.legacyFp !== legacyFp) return persistStop('LEGACY_STATE_CHANGED');
      }
      if (stage !== 'LIST' && stage !== 'ISSUE' && !TKS_NAME_RE.test(String(st.name || ''))) return stop('TEST_KEY_NAME_MISSING');

      var password = null, name = null, startSec = 0, endSec = 0;
      if (stage === 'ISSUE') {
        if (st.baselineCount < 0 || !st.baselineFp) return stop('BASELINE_MISSING');
        var cap = keypadCapacityGate([{ deviceId: g.deviceId, keyList: new Array(Math.max(0, st.baselineCount)) }], g.deviceId, { stopAt: TKS_CAPACITY_STOP, officialLimit: null });
        if (!cap.ok) return stop(cap.code);
        if (typeof st.listSec !== 'number' || nowSec - st.listSec < BND_LIST_TO_ISSUE_MIN_SEC) return stop('INTERVAL_NOT_ELAPSED');
        if (nowSec - st.listSec > BND_BASELINE_MAX_AGE_SEC) return persistStop('BASELINE_STALE');
        var pc = diagRead(sp, BND_PROP.PASSCODE), at = diagRead(sp, BND_PROP.ATTEST);
        if (pc.state === 'UNKNOWN' || at.state === 'UNKNOWN') return stop('PASSCODE_STATE_UNKNOWN');
        if (pc.state !== 'SET') return stop('PASSCODE_NOT_SET');
        if (at.state !== 'SET' || at.raw !== BND_ATTEST_VALUE) return stop('PASSCODE_UNIQUENESS_UNATTESTED'); // 通常コードとの重複を確認できなければ発行しない
        if (!bndPasscodeOk(pc.raw)) return stop('PASSCODE_INVALID');
        var win = bndWindowPlan(nowSec, BND_START_OFFSET_SEC, BND_DURATION_SEC);
        if (!win.ok) return stop(win.code);
        password = pc.raw; startSec = win.startSec; endSec = win.endSec;
        name = 'TST'; for (var i = 0; i < 8; i++) name += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.charAt(deps.randomInt(32));
      }
      if (stage === 'VERIFY_ISSUED') {
        if (typeof st.issueSec !== 'number' || nowSec - st.issueSec < BND_ISSUE_TO_VERIFY_MIN_SEC) return stop('OBSERVATION_WINDOW_NOT_ELAPSED'); // 承認・回数は消費しない
        if (typeof st.startSec !== 'number' || nowSec > st.startSec - BND_A1_HEADROOM_SEC) return persistStop('A1_HEADROOM_INSUFFICIENT'); // 通信せず停止。回収は公式アプリ
      }
      if (stage === 'FINAL_LIST') {
        if (typeof st.endSec !== 'number' || nowSec < st.endSec + BND_FINAL_AFTER_END_SEC) return stop('OBSERVATION_WINDOW_NOT_ELAPSED');
      }

      // 通信前に: 暗証番号の破棄 + 承認の消費 + 呼出し回数 + 送信済みマーカーを永続（どれか失敗したら通信しない）
      if (stage === 'ISSUE') {
        var gone = bndScrubPasscode(sp);
        scrubDue = !gone;
        if (!gone) { password = null; out.passcodeState = 'SCRUB_FAILED'; return persistStop('PASSCODE_DELETE_FAILED'); }
        out.passcodeState = 'CONSUMED';
      }
      var pre = JSON.parse(JSON.stringify(st));
      pre.state = def.pre; pre.calls = st.calls + 1; pre.deviceFp = devFp; pre.legacyFp = legacyFp;
      if (stage === 'LIST') { pre.listSec = nowSec; }
      if (stage === 'ISSUE') { pre.name = name; pre.startSec = startSec; pre.endSec = endSec; pre.issueSec = nowSec; pre.obs = {}; }
      try { sp.del(BND_PROP.APPROVAL); } catch (e) { password = null; return stop('APPROVAL_CONSUME_FAILED'); }
      if (!bndWrite(sp, pre)) { password = null; return stop('STATE_WRITE_FAILED'); }
      out.callsUsed = pre.calls; out.apiCalls = 1; out.state = pre.state;
      function halt(code) { // 通信後の失敗: 永続できなければ *_SENT のまま（再送抑止）で、保存済みと偽らない
        bndStopWrite(sp, pre, code, out);
        return stop(code);
      }
      function done(next, mut) {
        var s = JSON.parse(JSON.stringify(pre)); s.state = next; if (mut) mut(s);
        if (!bndWrite(sp, s)) { out.manualRecovery = true; out.persistence = 'NOT_PERSISTED'; return stop('STATE_WRITE_FAILED'); }
        out.state = next; return fin();
      }

      if (stage !== 'ISSUE') {
        var lr;
        try { lr = deps.api.listDevices(); } catch (e) { lr = null; }
        if (!lr || lr.ok !== true) return halt(lr && lr.error === 'LIST_API_ERROR' ? 'LIST_API_ERROR' : 'LIST_COMM_ERROR');
        var snap = tksSnapshot(lr.devices, g.deviceId, sha);
        if (!snap.valid) return halt(snap.code);
        out.keyCount = snap.count; out.evidence = 'KEYLIST';
        if (stage === 'LIST') {
          if (snap.list.some(function (k) { return TKS_NAME_RE.test(String(k.name)); })) return halt('STALE_TEST_KEY_PRESENT');
          return done('LISTED', function (s) { s.baselineCount = snap.count; s.baselineFp = snap.fp; });
        }
        var hits = snap.list.filter(function (k) { return k.name === st.name; });
        if (hits.length > 1) return halt('KEY_NAME_AMBIGUOUS');
        if (stage === 'VERIFY_ISSUED') {
          if (hits.length === 0) return halt('KEY_NOT_FOUND');
          if (typeof st.startSec !== 'number' || typeof st.endSec !== 'number') return halt('KEY_ATTR_EXPECTATION_MISSING');
          var judged = Core.judgeIssued({ valid: true, count: 1, entries: hits }, { startSec: st.startSec, endSec: st.endSec });
          if (!judged.ok) return halt(CODE_RE.test(String(judged.error)) ? judged.error : 'KEY_ATTR_MISMATCH');
          if (snap.count !== st.baselineCount + 1) return halt('KEYLIST_COUNT_MISMATCH');
          if (tksExcluding(snap, String(hits[0].id), sha) !== st.baselineFp) return halt('EXISTING_KEYS_CHANGED');
          if (nidIdType(hits[0].id) === 'ID_TYPE_UNKNOWN') return halt('TARGET_ID_INVALID');
          out.attrEcho = hits[0].startTime !== undefined && hits[0].endTime !== undefined ? 'RETURNED_AND_MATCHED' : 'NOT_RETURNED_UNVERIFIED';
          return done('ISSUED_VERIFIED', function (s) { s.attrEcho = out.attrEcho; });
        }
        // FINAL_LIST: 期限切れ後の実態を観測するだけ。残っていても自動削除しない（回収は公式アプリ）。
        var expiredListed = hits.length === 1;
        var restFp = expiredListed ? tksExcluding(snap, String(hits[0].id), sha) : snap.fp;
        if (!expiredListed && snap.count !== st.baselineCount) return halt('KEYLIST_COUNT_MISMATCH');
        if (restFp !== st.baselineFp) return halt('EXISTING_KEYS_CHANGED');
        out.expiredKeyListed = expiredListed;
        out.appCheck = 'PENDING_OWNER'; // API の結果と公式アプリの目視は別々に記録する。試験キーの手動削除と不在の目視が回収の完了条件
        bndJudgement(out, pre); out.recovery = 'PENDING_APP_REMOVAL'; // 合否は回収と独立。回収済みでも合格にはならない
        return done('FINAL_LISTED_APP_PENDING', function (s) { s.expiredKeyListed = expiredListed; s.verdict = out.verdict; });
      }

      // ISSUE: T0 は送信直前の時計で確認する（永続との差が大きければ送信せず停止）
      var sendSec = deps.nowSec();
      if (sendSec - pre.issueSec > BND_SEND_DRIFT_MAX_SEC || sendSec < pre.issueSec) { password = null; out.apiCalls = 0; return halt('ISSUE_CLOCK_DRIFT'); }
      var res, thrown = false;
      try {
        res = deps.api.createKey({ deviceId: g.deviceId, name: name, password: password, startTime: startSec, endTime: endSec });
      } catch (e) { thrown = true; }
      password = null;
      if (thrown) return halt('ISSUE_RESULT_UNKNOWN');
      var c = Core.classifyApi(res);
      if (!c.accepted) return halt('ISSUE_RESULT_UNKNOWN');
      out.evidence = c.commandId ? 'API_ACCEPTED_WITH_COMMAND_ID' : 'API_ACCEPTED_NO_COMMAND_ID';
      return done('ISSUE_ACCEPTED', function (s) { s.hasCommandId = !!c.commandId; });
    } catch (e) {
      out.manualRecovery = true;
      return stop('UNEXPECTED_ERROR');
    } finally {
      if (locked) { try { deps.lock.releaseLock(); } catch (e) { /* noop */ } }
    }
  }

  /**
   * 通信しない観測申告。承認値 = BND_OBS のキー。解錠は現地の物理操作でAPIでは観測できないため、結果はオーナーの申告。
   * 時刻の整合（A1は開始前、A2/A3は期間内、A4は期限後に申告）だけ機械検査し、外れる申告は状態を変えず拒否する（SKIPPED を使う）。
   * 重大（開始前/期限後に解錠できた・期間内に解錠できない・ロック/警報の兆候）は即 STOPPED。通信・資格情報・呼出し回数なし。
   */
  function bndObserve(deps) {
    var out = bndBlank(); out.stage = 'OBSERVE';
    function fin() {
      out.ok = out.failures.length === 0;
      out.code = out.ok ? 'BND_OBSERVE_OK' : out.failures[0];
      return diagSanitize(out, 0);
    }
    function stop(code) { if (out.failures.indexOf(code) === -1) out.failures.push(code); out.stopped = true; return fin(); }
    var sp = deps.scriptProps, locked = false;
    try {
      var g = tksGates(deps);
      if (!g.ok) return stop(g.code);
      var pr = bndPrereq(sp);
      if (pr) return stop(pr);
      var armed = diagRead(sp, BND_PROP.ARMED);
      if (armed.state === 'UNKNOWN') return stop('ARMED_STATE_UNKNOWN');
      if (armed.state === 'MISSING') return stop('NOT_ARMED');
      if (armed.raw !== BND_PLAN) return stop('ARMED_PLAN_MISMATCH');
      if (!deps.lock || !deps.lock.tryLock(1000)) return stop('LOCK_UNAVAILABLE');
      locked = true;
      var rs = bndReadState(sp);
      if (!rs.ok) return stop('STATE_UNREADABLE');
      var st = rs.st;
      out.state = DIAG_VALUE_RE.test(st.state) ? st.state : 'INVALID_VALUE'; out.callsUsed = st.calls;
      if (st.state === 'STOPPED' || /_SENT$/.test(st.state)) { out.manualRecovery = true; return stop(st.state === 'STOPPED' ? 'STOPPED_MANUAL_RECOVERY' : 'INTERRUPTED_MANUAL_RECOVERY'); }
      if (BND_OBS_STATES.indexOf(st.state) === -1) return stop('STAGE_ORDER_VIOLATION');
      var ap = diagRead(sp, BND_PROP.APPROVAL);
      if (ap.state === 'UNKNOWN') return stop('APPROVAL_STATE_UNKNOWN');
      var o = ap.state === 'SET' && Object.prototype.hasOwnProperty.call(BND_OBS, ap.raw) ? BND_OBS[ap.raw] : null;
      if (!o) return stop('STAGE_NOT_APPROVED');
      if (!o.any && o.from !== st.state) return stop('STAGE_ORDER_VIOLATION');
      var sha = deps.sha256Hex, nowSec = deps.nowSec();
      if (st.legacyFp !== bndLegacyFp(sp, sha)) { /* 先に記録を残して停止 */
        bndStopWrite(sp, st, 'LEGACY_STATE_CHANGED', out);
        return stop('LEGACY_STATE_CHANGED');
      }
      if (!o.critical && !o.retry && o.when) { // 時刻の整合（申告は試行のあと。外れるなら SKIPPED を申告する）
        var okTime = o.when === 'BEFORE_START' ? nowSec < st.startSec
          : o.when === 'IN_WINDOW' ? (nowSec >= st.startSec && nowSec < st.endSec)
          : nowSec >= st.endSec;
        if (!okTime) return stop('OBSERVATION_TIME_MISMATCH');
      }
      if (o.retry && !(nowSec >= st.startSec && nowSec < st.endSec)) return stop('OBSERVATION_TIME_MISMATCH');
      var s = JSON.parse(JSON.stringify(st)); s.obs = s.obs || {};
      var key = o.any ? 'LOCK' : o.step;
      s.obs[key] = o.any ? 'SIGN' : o.res;
      s.obsRel = s.obsRel || {}; s.obsRel[key] = nowSec - st.startSec; // 申告時刻の開始からの相対秒（基準時計との照合用）
      out.obs = s.obs;
      // 永続 → 承認の消費の順。永続できなければ承認を消費せず（申告を失わない）、永続失敗を明示して手動対応へ引き継ぐ。
      function commit(next, reason, critical) {
        s.state = next; if (reason) s.reason = reason;
        if (typeof s.verdict === 'string') s.verdict = bndVerdict(s); // 保存済みの暫定合否は、重大申告で停止したら無効化する
        if (!bndWrite(sp, s)) {
          out.manualRecovery = true; out.persistence = 'NOT_PERSISTED';
          return stop(critical ? 'CRITICAL_NOT_PERSISTED' : 'STATE_WRITE_FAILED'); // 状態は変わっていない。重大観測なら公式アプリで手動回収
        }
        out.state = next; out.persistence = 'PERSISTED';
        try { sp.del(BND_PROP.APPROVAL); } catch (e) { out.manualRecovery = true; out.notes = out.notes.concat(['APPROVAL_NOT_CONSUMED']); if (!critical) return stop('APPROVAL_CONSUME_FAILED'); }
        return null;
      }
      function critStop(code) {
        var f = commit('STOPPED', code, true); if (f) return f;
        out.manualRecovery = true; return stop(code);
      }
      if (o.critical) return critStop(o.critical);
      if (o.retry) { // A2 の最初の拒否: GO欄で許可された場合だけ1回再試行できる
        var rt = diagRead(sp, BND_PROP.A2_RETRY);
        if (rt.state === 'SET' && rt.raw === BND_A2_RETRY_VALUE) {
          try { sp.del(BND_PROP.A2_RETRY); } catch (e) { /* 読み直しで判定 */ }
          if (diagRead(sp, BND_PROP.A2_RETRY).state !== 'MISSING') return critStop('A2_RETRY_GO_NOT_CONSUMED');
          var fr = commit('A2_RETRY_PENDING', null, true); if (fr) return fr;
          out.notes = out.notes.concat(['A2_RETRY_ONCE_GRANTED']); return fin();
        }
        return critStop('A2_DENIED_NO_RETRY_GO');
      }
      var fo = commit(o.to, null, false); if (fo) return fo;
      if (o.res === 'INCONCLUSIVE') out.notes = out.notes.concat(['INCONCLUSIVE_NOT_PROOF']);
      return fin();
    } catch (e) {
      out.manualRecovery = true;
      return stop('UNEXPECTED_ERROR');
    } finally {
      if (locked) { try { deps.lock.releaseLock(); } catch (e) { /* noop */ } }
    }
  }

  /**
   * 通信しない最終段階: 公式アプリで試験キーを手動削除し、不在を目視した結果を記録する（回収の完了条件）。
   * APP_ABSENT: FINAL_LISTED_APP_PENDING → RECOVERED（回収の完了。試験の合否は verdict で別に示す）。途中停止（STOPPED/中断）からの回収なら STOPPED_RECOVERED。
   * APP_PRESENT: 残存＝STOPPED のまま管理者対応。試験キーを放置したまま 01FD へ進まない。
   */
  function bndAppCheck(deps) {
    var out = bndBlank(); out.stage = 'APP_CHECK';
    function fin() {
      out.ok = out.failures.length === 0;
      out.code = out.ok ? 'BND_APP_CHECK_OK' : out.failures[0];
      return diagSanitize(out, 0);
    }
    function stop(code) { if (out.failures.indexOf(code) === -1) out.failures.push(code); out.stopped = true; return fin(); }
    var sp = deps.scriptProps, locked = false;
    try {
      var g = tksGates(deps);
      if (!g.ok) return stop(g.code);
      var pr = bndPrereq(sp);
      if (pr) return stop(pr);
      var armed = diagRead(sp, BND_PROP.ARMED);
      if (armed.state === 'UNKNOWN') return stop('ARMED_STATE_UNKNOWN');
      if (armed.state === 'SET' && armed.raw !== BND_PLAN) return stop('ARMED_PLAN_MISMATCH');
      // ARMED が未設定でも、途中停止の「回収の記録」だけは通信なしで許可する（停止手順で先に武装解除するため）。通常の完了記録は武装が必要。
      var pc = diagRead(sp, BND_PROP.PASSCODE), at = diagRead(sp, BND_PROP.ATTEST);
      if (pc.state === 'UNKNOWN' || at.state === 'UNKNOWN') return stop('PASSCODE_STATE_UNKNOWN');
      if (pc.state === 'SET' || at.state === 'SET') {
        out.passcodeState = bndScrubPasscode(sp) ? 'RESIDUAL_SCRUBBED' : 'SCRUB_FAILED'; out.manualRecovery = true;
        return stop('PASSCODE_RESIDUAL');
      }
      if (!deps.lock || !deps.lock.tryLock(1000)) return stop('LOCK_UNAVAILABLE');
      locked = true;
      var rs = bndReadState(sp);
      if (!rs.ok) return stop('STATE_UNREADABLE');
      var st = rs.st;
      out.state = DIAG_VALUE_RE.test(st.state) ? st.state : 'INVALID_VALUE'; out.callsUsed = st.calls;
      var aborted = st.state === 'STOPPED' || /_SENT$/.test(st.state);
      if (!aborted && st.state !== 'FINAL_LISTED_APP_PENDING') return stop('STAGE_ORDER_VIOLATION');
      if (armed.state === 'MISSING' && !aborted) return stop('NOT_ARMED');
      if (aborted && typeof st.name === 'string' && !TKS_NAME_RE.test(st.name)) return stop('STAGE_ORDER_VIOLATION'); // 試験キーを作っていない（発行前の停止）ならアプリ回収の記録は不要
      var ap = diagRead(sp, BND_PROP.APPROVAL);
      if (ap.state === 'UNKNOWN') return stop('APPROVAL_STATE_UNKNOWN');
      if (ap.raw !== 'APP_ABSENT' && ap.raw !== 'APP_PRESENT') return stop('STAGE_NOT_APPROVED');
      var present = ap.raw === 'APP_PRESENT';
      var s = JSON.parse(JSON.stringify(st));
      if (present) { s.state = 'STOPPED'; s.reason = 'APP_STILL_PRESENT'; }
      else if (aborted) { s.state = 'STOPPED_RECOVERED'; s.reason = 'APP_ABSENT_AFTER_ABORT'; }
      else { s.state = 'RECOVERED'; s.reason = 'APP_ABSENT_CONFIRMED'; } // 「回収完了」であって「試験合格」ではない
      bndJudgement(out, s); s.verdict = out.verdict;
      if (!bndWrite(sp, s)) { out.manualRecovery = true; return stop('STATE_WRITE_FAILED'); } // 永続できなければ承認を消費しない
      try { sp.del(BND_PROP.APPROVAL); } catch (e) { out.manualRecovery = true; out.notes = out.notes.concat(['APPROVAL_NOT_CONSUMED']); }
      out.state = s.state; out.obs = s.obs || {};
      if (present) { out.manualRecovery = true; out.recovery = 'NOT_RECOVERED'; return stop('APP_STILL_PRESENT'); }
      out.appCheck = 'ABSENT_CONFIRMED';
      out.recovery = 'RECOVERED';
      out.outcome = aborted ? 'ABORTED_AND_RECOVERED' : (out.verdict === 'BOUNDARY_PASS' ? 'RECOVERED_AND_BOUNDARY_PASS' : 'RECOVERED_BUT_NOT_PASS');
      return fin();
    } catch (e) {
      out.manualRecovery = true;
      return stop('UNEXPECTED_ERROR');
    } finally {
      if (locked) { try { deps.lock.releaseLock(); } catch (e) { /* noop */ } }
    }
  }

  /** 通信しない状態確認。ok=true はゲート通過のみ（GOでも実行可能の判定でもない）。値・ID・名前・暗証番号は出さない。 */
  function bndStatus(deps) {
    var out = bndBlank(); out.stage = 'STATUS'; out.planId = BND_PLAN;
    out.notes = out.notes.concat(['STATUS_OK_IS_NOT_GO_NOR_EXECUTABLE']);
    var g = tksGates(deps);
    out.gates = g.ok ? 'PASS' : g.code;
    var pr = g.ok ? bndPrereq(deps.scriptProps) : null;
    out.prerequisites = !g.ok ? 'NOT_CHECKED' : (pr || 'PASS');
    var rs = bndReadState(deps.scriptProps);
    var nowSec = deps.nowSec();
    if (rs.ok) {
      out.state = DIAG_VALUE_RE.test(rs.st.state) ? rs.st.state : 'INVALID_VALUE'; out.callsUsed = rs.st.calls;
      out.manualRecovery = rs.st.state === 'STOPPED' || /_SENT$/.test(rs.st.state);
      if (rs.st.obs && typeof rs.st.obs === 'object') out.obs = rs.st.obs;
      if (typeof rs.st.verdict === 'string') out.verdict = bndVerdict(rs.st); // 保存値は使わず、現在の状態と観測から導出する
      if (typeof rs.st.startSec === 'number' && typeof rs.st.endSec === 'number') { out.secToStart = rs.st.startSec - nowSec; out.secToEnd = rs.st.endSec - nowSec; }
    } else out.state = 'STATE_UNREADABLE';
    var a = diagRead(deps.scriptProps, BND_PROP.ARMED);
    out.armed = a.state === 'UNKNOWN' ? 'UNKNOWN' : (a.state === 'MISSING' ? 'OFF' : (a.raw === BND_PLAN ? 'ON' : 'PLAN_MISMATCH'));
    var ap = diagRead(deps.scriptProps, BND_PROP.APPROVAL);
    var okVal = Object.keys(BND_STAGES).concat(Object.keys(BND_OBS), ['APP_ABSENT', 'APP_PRESENT']);
    out.approvedStage = ap.state === 'UNKNOWN' ? 'UNKNOWN' : (ap.state === 'MISSING' ? 'NONE' : (okVal.indexOf(ap.raw) !== -1 ? ap.raw : 'INVALID_VALUE'));
    var pc = diagRead(deps.scriptProps, BND_PROP.PASSCODE), at = diagRead(deps.scriptProps, BND_PROP.ATTEST), rt = diagRead(deps.scriptProps, BND_PROP.A2_RETRY);
    out.passcode = pc.state === 'UNKNOWN' ? 'UNKNOWN' : (pc.state === 'SET' ? 'PRESENT' : 'ABSENT'); // 値は読まない・出さない
    out.passcodeAttest = at.state === 'UNKNOWN' ? 'UNKNOWN' : (at.state === 'SET' ? 'PRESENT' : 'ABSENT');
    out.a2RetryGo = rt.state === 'UNKNOWN' ? 'UNKNOWN' : (rt.state === 'SET' ? (rt.raw === BND_A2_RETRY_VALUE ? 'ALLOWED_ONCE' : 'INVALID_VALUE') : 'NONE');
    var ns = nidReadState(deps.scriptProps), ls = tksReadState(deps.scriptProps);
    out.legacyState = ls.ok && DIAG_VALUE_RE.test(ls.st.state) ? ls.st.state : 'STATE_UNREADABLE';   // #791（読むだけ）
    out.numIdState = ns.ok && DIAG_VALUE_RE.test(ns.st.state) ? ns.st.state : 'STATE_UNREADABLE';     // #797（読むだけ）
    out.ok = g.ok && !pr && rs.ok;
    out.code = out.ok ? 'BND_STATUS_OK' : (!g.ok ? g.code : (pr || 'STATE_UNREADABLE'));
    return diagSanitize(out, 0);
  }

  // ---------- 37DD 期限境界試験ここまで ----------

  // ---------- verify環境専用・37DD 段階承認型 API 単体試験（Issue #791）----------
  //
  // 第1段階（#756）: 37DD のテストキー1件の発行→確認→削除→不在確認だけを、人間の段階承認つきで行う。
  // コード・設定のマージ/デプロイ/ARMED では何も起きない。各段階は「ARMED=true」かつ「その段階名の承認」が揃ったときだけ
  // 通信し、承認は通信の前に消費する（二重押下・再実行で同じ通信をしない）。本番ジョブ（accessSyncJob 等）は流用しない。
  // 通信は SwitchBot API 合計 TKS_MAX_CALLS 回まで（呼出し前に永続カウント。自動再送・自動復旧なし）。
  var TKS_MAX_CALLS = 5;
  var TKS_STAGES = {
    LIST:            { approval: 'LIST',            from: ['INIT'],            pre: 'LIST_SENT' },
    ISSUE:           { approval: 'ISSUE',           from: ['LISTED'],          pre: 'ISSUE_SENT' },
    VERIFY_ISSUED:   { approval: 'VERIFY_ISSUED',   from: ['ISSUE_ACCEPTED'],  pre: 'VERIFY_ISSUED_SENT' },
    DELETE:          { approval: 'DELETE',          from: ['ISSUED_VERIFIED'], pre: 'DELETE_SENT' },
    VERIFY_DELETED:  { approval: 'VERIFY_DELETED',  from: ['DELETE_ACCEPTED'], pre: 'VERIFY_DELETED_SENT' }
  };
  var TKS_PROP = { ARMED: 'ACCESS_TEST_KEY_ARMED', APPROVAL: 'ACCESS_TEST_KEY_APPROVAL', STATE: 'ACCESS_TEST_KEY_STATE' };
  var TKS_KEY_ID_PROP = 'TESTKEY_ID'; // 試験キーの識別子は実行者本人の User Properties にのみ置く（ログ・出力・Script Propertiesに出さない）
  var TKS_CAPACITY_STOP = 80; // 試験は既存キーを増やさない前提。80件以上は容量問題として発行しない
  var TKS_NAME_RE = /^TST[A-Z0-9]{8}$/;

  function tksBlank() {
    return { ok: false, code: 'TEST_KEY_NOT_RUN', stage: 'NOT_CHECKED', failures: [], stopped: false, apiCalls: 0, callsUsed: 0, callsMax: TKS_MAX_CALLS,
      state: 'NOT_CHECKED', manualRecovery: false, evidence: 'NONE', keyCount: 0, notes: ['VERIFY_ONLY', 'TARGET_37DD_ONLY', 'ONE_TEST_KEY_ONLY', 'NO_AUTO_RETRY'] };
  }

  function tksReadState(sp) {
    var raw;
    try { raw = sp.get(TKS_PROP.STATE); } catch (e) { return { ok: false }; }
    if (raw === undefined) return { ok: false };
    if (raw === null || raw === '') return { ok: true, st: { v: 1, state: 'INIT', calls: 0, name: '', baselineCount: -1, baselineFp: '', hasCommandId: false, reason: '' } };
    var p = safeParse(raw);
    if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.state !== 'string' || typeof p.calls !== 'number' || p.calls < 0 || p.calls > TKS_MAX_CALLS) return { ok: false };
    return { ok: true, st: p };
  }

  /** 状態遷移は1回の set。失敗時は呼出し側が通信しない（先に永続できなければ通信しない）。 */
  function tksWrite(sp, st) {
    try { sp.set(TKS_PROP.STATE, JSON.stringify(st)); return true; } catch (e) { return false; }
  }

  /** 環境・設定・末尾4桁・フラグ・トリガー・ARMED のゲート。通信より前に全部通す。失敗時は最初の理由だけ返す。 */
  function tksGates(deps) {
    var gate = authorizeExecutor(deps);
    if (!gate.ok) return { ok: false, code: gate.error };
    var flag = accessFlagState(deps), flagRaw;
    try { flagRaw = deps.accessFlag(); } catch (e) { flagRaw = undefined; }
    if (flag !== 'OFF') return { ok: false, code: flagCode(flag) };
    if (flagRaw !== 'false') return { ok: false, code: 'ACCESS_FLAG_NOT_EXPLICIT_OFF' };
    var sp = deps.scriptProps;
    var envRaw = diagRead(sp, 'ACCESS_ENVIRONMENT'), cfgRaw = diagRead(sp, 'ACCESS_CONFIG');
    if (envRaw.state !== 'SET' || cfgRaw.state !== 'SET') return { ok: false, code: 'SETTINGS_INCOMPLETE' };
    if (envRaw.raw !== ENVIRONMENT.VERIFY) return { ok: false, code: 'ENV_NOT_VERIFY' };
    var cfg = safeParse(cfgRaw.raw);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { ok: false, code: 'CONFIG_INVALID' };
    if (cfg.environment !== ENVIRONMENT.VERIFY) return { ok: false, code: 'ENV_MISMATCH' };
    if (!validateConfig(cfg).ok) return { ok: false, code: 'CONFIG_INVALID' };
    var allowed = (Array.isArray(cfg.allowedLast4) ? cfg.allowedLast4 : []).map(function (x) { return String(x).toUpperCase(); });
    var pads = Array.isArray(cfg.keypads) ? cfg.keypads : [];
    var padLast4 = pads.map(function (k) { return last4(k && k.deviceId); });
    if (allowed.concat(padLast4).some(function (x) { return TEST_FORBIDDEN_LAST4.indexOf(x) !== -1; })) return { ok: false, code: 'LAST4_FORBIDDEN' };
    if (allowed.length !== 1 || allowed[0] !== TEST_ALLOWED_LAST4[0] || pads.length !== 1 || padLast4[0] !== TEST_ALLOWED_LAST4[0]) return { ok: false, code: 'LAST4_MISMATCH' };
    var n;
    try { n = deps.triggerCount(); } catch (e) { n = undefined; }
    if (typeof n !== 'number') return { ok: false, code: 'TRIGGER_STATE_UNKNOWN' };
    if (n !== 0) return { ok: false, code: 'TRIGGERS_PRESENT' };
    return { ok: true, deviceId: pads[0].deviceId, actor: gate.actor };
  }

  /** keyList 全体の完全性検査。id・name を持たない/重複 id のある要素があれば不在・件数を断定しない。 */
  function tksSnapshot(devices, deviceId, sha) {
    if (!Array.isArray(devices)) return { valid: false, code: 'DEVICE_LIST_INVALID' };
    var devs = devices.filter(function (d) { return d && d.deviceId === deviceId; });
    if (devs.length !== 1) return { valid: false, code: devs.length === 0 ? 'DEVICE_NOT_FOUND' : 'DEVICE_AMBIGUOUS' };
    var list = devs[0].keyList;
    if (!Array.isArray(list)) return { valid: false, code: 'KEYLIST_INVALID' };
    var seen = {}, ids = [], canon = {};
    for (var i = 0; i < list.length; i++) {
      var k = list[i];
      if (!k || typeof k !== 'object' || k.id === undefined || k.id === null || String(k.id) === '' || typeof k.name !== 'string' || k.name === '') return { valid: false, code: 'KEYLIST_ENTRY_INVALID' };
      var id = String(k.id);
      if (seen[id]) return { valid: false, code: 'KEYLIST_DUPLICATE_ID' };
      seen[id] = true; ids.push(id);
      // 指紋は ID だけでなく名前・種別・有効期間も含む正規化表現（既存キーの属性変更も検知する）
      canon[id] = JSON.stringify([id, k.name, k.type === undefined ? null : String(k.type),
        k.startTime === undefined ? null : String(k.startTime), k.endTime === undefined ? null : String(k.endTime)]);
    }
    return { valid: true, list: list, count: list.length, ids: ids, canon: canon, fp: tksFp(ids, canon, sha) };
  }

  function tksFp(ids, canon, sha) {
    return sha(ids.map(function (x) { return canon[x]; }).sort().join('\n'));
  }

  function tksExcluding(snap, id, sha) {
    return tksFp(snap.ids.filter(function (x) { return x !== id; }), snap.canon, sha);
  }

  /**
   * 1段階だけ実行する。stage ∈ LIST / ISSUE / VERIFY_ISSUED / DELETE / VERIFY_DELETED。
   * deps: identity, adminActors, accessFlag, scriptProps{get,set,del}, userProps{get,set,del}, lock{tryLock,releaseLock},
   *       triggerCount(), api{listDevices,createKey,deleteKey}, sha256Hex, randomInt, nowSec
   * 返すのは固定コード・件数・真偽値のみ（完全deviceId・パスコード・トークン・passcode ID・キー名・例外本文・commandId を含めない）。
   */
  function testKeyStage(deps, stage) {
    var out = tksBlank();
    var def = TKS_STAGES[stage];
    out.stage = def ? stage : 'INVALID_STAGE';
    function fin() {
      out.ok = out.failures.length === 0;
      out.code = out.ok ? 'TEST_KEY_' + stage + '_OK' : out.failures[0];
      return diagSanitize(out, 0);
    }
    function stop(code) { if (out.failures.indexOf(code) === -1) out.failures.push(code); out.stopped = true; return fin(); }
    if (!def) return stop('INVALID_STAGE');
    var sp = deps.scriptProps, locked = false;
    try {
      var g = tksGates(deps);
      if (!g.ok) return stop(g.code);
      var armed = diagRead(sp, TKS_PROP.ARMED);
      if (armed.state === 'UNKNOWN') return stop('ARMED_STATE_UNKNOWN');
      if (armed.raw !== 'true') return stop('NOT_ARMED');

      if (!deps.lock || !deps.lock.tryLock(1000)) return stop('LOCK_UNAVAILABLE');
      locked = true;

      var rs = tksReadState(sp);
      if (!rs.ok) return stop('STATE_UNREADABLE');
      var st = rs.st;
      out.state = DIAG_VALUE_RE.test(st.state) ? st.state : 'INVALID_VALUE';
      out.callsUsed = st.calls;
      if (st.state === 'STOPPED' || /_SENT$/.test(st.state)) { out.manualRecovery = true; return stop(st.state === 'STOPPED' ? 'STOPPED_MANUAL_RECOVERY' : 'INTERRUPTED_MANUAL_RECOVERY'); }
      if (st.state === 'COMPLETE') return stop('ALREADY_COMPLETE');
      if (def.from.indexOf(st.state) === -1) return stop(st.state === def.pre || st.state === stage ? 'STAGE_ALREADY_DONE' : 'STAGE_ORDER_VIOLATION');

      // 段階ごとの明示承認（その段階名と完全一致）。通信前に消費する
      var ap = diagRead(sp, TKS_PROP.APPROVAL);
      if (ap.state === 'UNKNOWN') return stop('APPROVAL_STATE_UNKNOWN');
      if (ap.raw !== def.approval) return stop('STAGE_NOT_APPROVED');
      var cred;
      try { cred = !!(deps.userProps.get('SWITCHBOT_TOKEN') && deps.userProps.get('SWITCHBOT_SECRET')); } catch (e) { cred = false; }
      if (!cred) return stop('AUTH_CREDENTIALS_MISSING');
      if (st.calls >= TKS_MAX_CALLS) return stop('CALL_BUDGET_EXHAUSTED');
      // 試験の対象端末は LIST 時に固定（完全IDのハッシュのみ保存）。以降の段階で設定の端末が変わっていれば停止
      var devFp = deps.sha256Hex('TKS_DEVICE|' + g.deviceId);
      if (stage !== 'LIST' && st.deviceFp !== devFp) return stop('TARGET_DEVICE_CHANGED');

      var sha = deps.sha256Hex;
      var keyId = null;
      if (stage === 'DELETE' || stage === 'VERIFY_DELETED' || stage === 'VERIFY_ISSUED') {
        if (!TKS_NAME_RE.test(String(st.name || ''))) return stop('TEST_KEY_NAME_MISSING');
      }
      if (stage === 'DELETE' || stage === 'VERIFY_DELETED') {
        try { keyId = deps.userProps.get(TKS_KEY_ID_PROP); } catch (e) { keyId = undefined; }
        if (!keyId) return stop('TEST_KEY_ID_MISSING');
      }
      var password = null, name = null, startSec = 0, endSec = 0;
      if (stage === 'ISSUE') {
        var cap = keypadCapacityGate([{ deviceId: g.deviceId, keyList: new Array(Math.max(0, st.baselineCount)) }], g.deviceId, { stopAt: TKS_CAPACITY_STOP, officialLimit: null });
        if (st.baselineCount < 0 || !st.baselineFp) return stop('BASELINE_MISSING');
        if (!cap.ok) return stop(cap.code);
        name = 'TST'; for (var i = 0; i < 8; i++) name += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.charAt(deps.randomInt(32));
        password = ''; for (var j = 0; j < 8; j++) password += String(deps.randomInt(10));
        startSec = deps.nowSec() - 60; endSec = deps.nowSec() + 3600;
      }

      // 通信前に: 承認の消費 + 呼出し回数 + 送信済みマーカーを永続（永続に失敗したら通信しない）
      var pre = JSON.parse(JSON.stringify(st));
      pre.state = def.pre; pre.calls = st.calls + 1; pre.deviceFp = devFp;
      if (stage === 'ISSUE') { pre.name = name; pre.startSec = startSec; pre.endSec = endSec; }
      try { sp.del(TKS_PROP.APPROVAL); } catch (e) { return stop('APPROVAL_CONSUME_FAILED'); }
      if (!tksWrite(sp, pre)) return stop('STATE_WRITE_FAILED');
      out.callsUsed = pre.calls; out.apiCalls = 1; out.state = pre.state;
      function halt(code, cleanup) {
        var s = JSON.parse(JSON.stringify(pre)); s.state = 'STOPPED'; s.reason = code;
        tksWrite(sp, s); out.state = 'STOPPED'; out.manualRecovery = true;
        return stop(code);
      }
      function done(next, mut) {
        var s = JSON.parse(JSON.stringify(pre)); s.state = next; if (mut) mut(s);
        if (!tksWrite(sp, s)) { out.manualRecovery = true; return stop('STATE_WRITE_FAILED'); }
        out.state = next; return fin();
      }

      if (stage === 'LIST' || stage === 'VERIFY_ISSUED' || stage === 'VERIFY_DELETED') {
        var lr;
        try { lr = deps.api.listDevices(); } catch (e) { lr = null; }
        if (!lr || lr.ok !== true) return halt(lr && lr.error === 'LIST_API_ERROR' ? 'LIST_API_ERROR' : 'LIST_COMM_ERROR');
        var snap = tksSnapshot(lr.devices, g.deviceId, sha);
        if (!snap.valid) return halt(snap.code);
        out.keyCount = snap.count; out.evidence = 'KEYLIST';
        if (stage === 'LIST') {
          // 既存キーの読取専用確認。端末末尾4桁も再確認（完全IDで1件一致済み）
          if (snap.list.some(function (k) { return TKS_NAME_RE.test(String(k.name)); })) return halt('STALE_TEST_KEY_PRESENT');
          return done('LISTED', function (s) { s.baselineCount = snap.count; s.baselineFp = snap.fp; });
        }
        if (stage === 'VERIFY_ISSUED') {
          var hits = snap.list.filter(function (k) { return k.name === st.name; });
          if (hits.length === 0) return halt('KEY_NOT_FOUND');
          if (hits.length > 1) return halt('KEY_NAME_AMBIGUOUS');
          // 要求した種別・有効期間と矛盾する返却は確認済みにしない（既存の judgeIssued と同じ契約。1時間で自然失効する保険を担保）
          if (typeof st.startSec !== 'number' || typeof st.endSec !== 'number') return halt('KEY_ATTR_EXPECTATION_MISSING');
          var judged = Core.judgeIssued({ valid: true, count: 1, entries: hits }, { startSec: st.startSec, endSec: st.endSec });
          if (!judged.ok) return halt(CODE_RE.test(String(judged.error)) ? judged.error : 'KEY_ATTR_MISMATCH');
          var tid = String(hits[0].id);
          if (snap.count !== st.baselineCount + 1) return halt('KEYLIST_COUNT_MISMATCH');
          if (tksExcluding(snap, tid, sha) !== st.baselineFp) return halt('EXISTING_KEYS_CHANGED');
          try { deps.userProps.set(TKS_KEY_ID_PROP, tid); } catch (e) { return halt('TEST_KEY_ID_STORE_FAILED'); }
          return done('ISSUED_VERIFIED', null);
        }
        // VERIFY_DELETED
        var byName = snap.list.filter(function (k) { return k.name === st.name; }).length;
        var byId = snap.list.filter(function (k) { return String(k.id) === String(keyId); }).length;
        if (byName || byId) return halt('TEST_KEY_STILL_PRESENT');
        if (snap.count !== st.baselineCount || snap.fp !== st.baselineFp) return halt('EXISTING_KEYS_CHANGED');
        try { deps.userProps.del(TKS_KEY_ID_PROP); } catch (e) { /* 残っても無害（削除済み）。状態は完了にする */ }
        return done('COMPLETE', null);
      }

      var res, thrown = false;
      try {
        res = stage === 'ISSUE'
          ? deps.api.createKey({ deviceId: g.deviceId, name: name, password: password, startTime: startSec, endTime: endSec })
          : deps.api.deleteKey(g.deviceId, String(keyId));
      } catch (e) { thrown = true; }
      password = null;
      if (thrown) return halt(stage === 'ISSUE' ? 'ISSUE_RESULT_UNKNOWN' : 'DELETE_RESULT_UNKNOWN');
      var c = Core.classifyApi(res);
      if (!c.accepted) return halt(stage === 'ISSUE' ? 'ISSUE_RESULT_UNKNOWN' : 'DELETE_RESULT_UNKNOWN');
      out.evidence = c.commandId ? 'API_ACCEPTED_WITH_COMMAND_ID' : 'API_ACCEPTED_NO_COMMAND_ID';
      return done(stage === 'ISSUE' ? 'ISSUE_ACCEPTED' : 'DELETE_ACCEPTED', function (s) { s.hasCommandId = !!c.commandId; });
    } catch (e) {
      out.manualRecovery = true;
      return stop('UNEXPECTED_ERROR');
    } finally {
      if (locked) { try { deps.lock.releaseLock(); } catch (e) { /* noop */ } }
    }
  }

  /** 通信しない状態確認。段階・回数・要手動復旧のみ（キー名・IDは出さない）。 */
  function testKeyStatus(deps) {
    var out = tksBlank(); out.stage = 'STATUS';
    var g = tksGates(deps);
    out.gates = g.ok ? 'PASS' : g.code;
    var rs = tksReadState(deps.scriptProps);
    if (rs.ok) { out.state = rs.st.state; out.callsUsed = rs.st.calls; out.manualRecovery = rs.st.state === 'STOPPED' || /_SENT$/.test(rs.st.state); }
    else out.state = 'STATE_UNREADABLE';
    var a = diagRead(deps.scriptProps, TKS_PROP.ARMED);
    out.armed = a.raw === 'true' ? 'ON' : (a.state === 'UNKNOWN' ? 'UNKNOWN' : 'OFF');
    var ap = diagRead(deps.scriptProps, TKS_PROP.APPROVAL);
    out.approvedStage = ap.state === 'SET' && DIAG_VALUE_RE.test(ap.raw) ? ap.raw : (ap.state === 'SET' ? 'INVALID_VALUE' : 'NONE');
    out.ok = g.ok && rs.ok;
    out.code = out.ok ? 'TEST_KEY_STATUS_OK' : (g.ok ? 'STATE_UNREADABLE' : g.code);
    return diagSanitize(out, 0);
  }

  // ---------- 37DD 数値型ID維持 createKey→deleteKey 最小試験（Issue #797 / 親 #756・原因調査 #793）----------
  //
  // #791 の試験（11/6）は deleteKey の parameter.id を String() 化して送り、削除が反映されなかった。11/3 の成功経路は keyList.id を
  // 無加工で送っていた。本試験は「取得した keyList.id の型を保持して送る」ことだけを変えた最小の再試験である。
  // #791 の状態（ACCESS_TEST_KEY_STATE=STOPPED・5/5）・ARMED・APPROVAL は読むだけで書換・リセットしない。予算・状態・承認は独立管理。
  // 通信は SwitchBot API 合計 NID_MAX_CALLS(=6) 回まで（LIST→ISSUE→VERIFY_ISSUED→PRE_DELETE_LIST→DELETE→VERIFY_DELETED。各1回）。
  // 追加の反映確認GETはこの実装に含めない（必要なら上限と時点を明記して別PR・別GO）。変更系（createKey/deleteKey）は各1回・再送なし。
  // コード・設定のマージ/デプロイ/ARMED では何も起きない。#756 に通信回数・コマンド・停止条件が記録されたあとのオーナー別GOでのみ実行する。
  var NID_MAX_CALLS = 6;
  var NID_PLAN = 'NUMID_PLAN_V1_6CALLS'; // ARMED の値。手順書（docs/…-797.md）の6回計画と合致していることの目印
  var NID_PROP = { ARMED: 'ACCESS_NUMID_TEST_ARMED', APPROVAL: 'ACCESS_NUMID_TEST_APPROVAL', STATE: 'ACCESS_NUMID_TEST_STATE' };
  var NID_TARGET_PROP = 'NUMID_TARGET'; // 削除対象の「型付きID」。実行者本人の User Properties にのみ置く（出力・Script Properties に出さない）
  var NID_STAGES = {
    LIST:            { from: ['INIT'],            pre: 'LIST_SENT' },
    ISSUE:           { from: ['LISTED'],          pre: 'ISSUE_SENT' },
    VERIFY_ISSUED:   { from: ['ISSUE_ACCEPTED'],  pre: 'VERIFY_ISSUED_SENT' },
    PRE_DELETE_LIST: { from: ['ISSUED_VERIFIED'], pre: 'PRE_DELETE_LIST_SENT' },
    DELETE:          { from: ['DELETE_READY'],    pre: 'DELETE_SENT' },
    VERIFY_DELETED:  { from: ['DELETE_ACCEPTED'], pre: 'VERIFY_DELETED_SENT' }
  };
  var NID_PREDELETE_MAX_AGE_SEC = 600; // 削除直前の再照合から削除送信までの上限。超えたら通信せず停止（古い照合で削除しない）
  var NID_OBSERVE_MIN_SEC = 300;       // 削除受理から削除後GETまでの最短間隔（#791 の VERIFY_DELETED は約5分後）
  var NID_CHANGES = ['ID_TYPE_PRESERVED', 'PRE_DELETE_RELIST_ADDED', 'OBSERVATION_MIN_300S']; // #791 からの変更点（交絡要因として常に併記）

  function nidBlank() {
    return { ok: false, code: 'NUMID_TEST_NOT_RUN', stage: 'NOT_CHECKED', failures: [], stopped: false, apiCalls: 0, callsUsed: 0, callsMax: NID_MAX_CALLS,
      state: 'NOT_CHECKED', manualRecovery: false, evidence: 'NONE', keyCount: 0, validityProfile: 'SAME_AS_791', changes: NID_CHANGES.slice(),
      notes: ['VERIFY_ONLY', 'TARGET_37DD_ONLY', 'ONE_TEST_KEY_ONLY', 'NO_AUTO_RETRY', 'NO_NORMAL_KEY_DELETE_PATH', 'ACCEPTED_IS_NOT_DELETED'] };
  }

  function nidReadState(sp) {
    var raw;
    try { raw = sp.get(NID_PROP.STATE); } catch (e) { return { ok: false }; }
    if (raw === undefined) return { ok: false };
    if (raw === null || raw === '') return { ok: true, st: { v: 1, state: 'INIT', calls: 0, name: '', baselineCount: -1, baselineFp: '', baselineIds: [] } };
    var p = safeParse(raw);
    if (!p || typeof p !== 'object' || p.v !== 1 || typeof p.state !== 'string' || typeof p.calls !== 'number' || p.calls < 0 || p.calls > NID_MAX_CALLS) return { ok: false };
    return { ok: true, st: p };
  }

  function nidWrite(sp, st) {
    try { sp.set(NID_PROP.STATE, JSON.stringify(st)); return true; } catch (e) { return false; }
  }

  /** keyList.id の型分類。数値は正の安全な整数のみ（JSON.parse で精度を失う値は送らない）。値は返さない。 */
  function nidIdType(id) {
    if (typeof id === 'number') {
      if (!isFinite(id) || id <= 0 || Math.floor(id) !== id) return 'ID_TYPE_UNKNOWN';
      return id <= 9007199254740991 ? 'ID_TYPE_NUMBER' : 'ID_NOT_SAFE_INTEGER';
    }
    if (typeof id === 'string' && id !== '') return 'ID_TYPE_STRING';
    return 'ID_TYPE_UNKNOWN';
  }

  function nidIdHash(sha, id) { return sha('NUMID_BASE|' + String(id)).slice(0, 12); }

  /** #791 の試験が止まったまま・旧 ARMED/APPROVAL が未設定であることを読むだけで確認する（書込なし）。 */
  function nidPrereq(sp) {
    var oa = diagRead(sp, TKS_PROP.ARMED);
    if (oa.state === 'UNKNOWN') return 'ARMED_STATE_UNKNOWN';
    if (oa.state === 'SET') return 'TEST_KEY_ARMED_PRESENT';
    var op = diagRead(sp, TKS_PROP.APPROVAL);
    if (op.state === 'UNKNOWN') return 'APPROVAL_STATE_UNKNOWN';
    if (op.state === 'SET') return 'TEST_KEY_APPROVAL_PRESENT';
    var rs = tksReadState(sp);
    if (!rs.ok) return 'TEST_KEY_STATE_UNREADABLE';
    if (rs.st.state !== 'STOPPED') return 'TEST_KEY_STATE_NOT_STOPPED';
    return null;
  }

  /**
   * 1段階だけ実行する。stage ∈ LIST / ISSUE / VERIFY_ISSUED / PRE_DELETE_LIST / DELETE / VERIFY_DELETED。
   * deps: testKeyStage と同じ（api は listDevices/createKey/deleteKey）。返すのは固定コード・件数・真偽値・秒数のみ
   * （完全deviceId・パスコード・トークン・passcode ID・キー名・例外本文・commandId を含めない）。
   */
  function numIdStage(deps, stage) {
    var out = nidBlank();
    var def = NID_STAGES[stage];
    out.stage = def ? stage : 'INVALID_STAGE';
    function fin() {
      out.ok = out.failures.length === 0;
      out.code = out.ok ? 'NUMID_' + stage + '_OK' : out.failures[0];
      return diagSanitize(out, 0);
    }
    function stop(code) { if (out.failures.indexOf(code) === -1) out.failures.push(code); out.stopped = true; return fin(); }
    if (!def) return stop('INVALID_STAGE');
    var sp = deps.scriptProps, locked = false;
    try {
      var g = tksGates(deps);
      if (!g.ok) return stop(g.code);
      var pr = nidPrereq(sp);
      if (pr) return stop(pr);
      var armed = diagRead(sp, NID_PROP.ARMED);
      if (armed.state === 'UNKNOWN') return stop('ARMED_STATE_UNKNOWN');
      if (armed.state === 'MISSING') return stop('NOT_ARMED');
      if (armed.raw !== NID_PLAN) return stop('ARMED_PLAN_MISMATCH');

      if (!deps.lock || !deps.lock.tryLock(1000)) return stop('LOCK_UNAVAILABLE');
      locked = true;

      var rs = nidReadState(sp);
      if (!rs.ok) return stop('STATE_UNREADABLE');
      var st = rs.st;
      out.state = DIAG_VALUE_RE.test(st.state) ? st.state : 'INVALID_VALUE';
      out.callsUsed = st.calls;
      if (st.state === 'STOPPED' || /_SENT$/.test(st.state)) { out.manualRecovery = true; return stop(st.state === 'STOPPED' ? 'STOPPED_MANUAL_RECOVERY' : 'INTERRUPTED_MANUAL_RECOVERY'); }
      if (st.state === 'COMPLETE') return stop('ALREADY_COMPLETE');
      if (def.from.indexOf(st.state) === -1) return stop(st.state === def.pre || st.state === stage ? 'STAGE_ALREADY_DONE' : 'STAGE_ORDER_VIOLATION');

      var sha = deps.sha256Hex;
      var nowSec = deps.nowSec();

      /** 通信前の曖昧・不整合で止める。呼出し回数は増やさず、状態だけ STOPPED にして対象IDも消す（以後は公式アプリで手動撤去）。 */
      function persistStop(code) {
        var s = JSON.parse(JSON.stringify(st)); s.state = 'STOPPED'; s.reason = code;
        nidWrite(sp, s);
        try { deps.userProps.del(NID_TARGET_PROP); } catch (e) { /* noop */ }
        out.state = 'STOPPED'; out.manualRecovery = true;
        return stop(code);
      }

      // 承認の確認（通信前に消費する前の検査。ここで止まれば承認も呼出し回数も消費しない）
      var ap = diagRead(sp, NID_PROP.APPROVAL);
      if (ap.state === 'UNKNOWN') return stop('APPROVAL_STATE_UNKNOWN');
      if (ap.raw !== stage) return stop('STAGE_NOT_APPROVED');
      var cred;
      try { cred = !!(deps.userProps.get('SWITCHBOT_TOKEN') && deps.userProps.get('SWITCHBOT_SECRET')); } catch (e) { cred = false; }
      if (!cred) return stop('AUTH_CREDENTIALS_MISSING');
      if (st.calls >= NID_MAX_CALLS) return stop('CALL_BUDGET_EXHAUSTED');
      var devFp = sha('NUMID_DEVICE|' + g.deviceId);
      if (stage !== 'LIST' && st.deviceFp !== devFp) return stop('TARGET_DEVICE_CHANGED');
      if (stage !== 'LIST' && stage !== 'ISSUE' && !TKS_NAME_RE.test(String(st.name || ''))) return stop('TEST_KEY_NAME_MISSING');

      var password = null, name = null, startSec = 0, endSec = 0, targetId = null, targetType = null;
      if (stage === 'ISSUE') {
        var cap = keypadCapacityGate([{ deviceId: g.deviceId, keyList: new Array(Math.max(0, st.baselineCount)) }], g.deviceId, { stopAt: TKS_CAPACITY_STOP, officialLimit: null });
        if (st.baselineCount < 0 || !st.baselineFp) return stop('BASELINE_MISSING');
        if (!cap.ok) return stop(cap.code);
        name = 'TST'; for (var i = 0; i < 8; i++) name += 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.charAt(deps.randomInt(32));
        password = ''; for (var j = 0; j < 8; j++) password += String(deps.randomInt(10));
        startSec = nowSec - 60; endSec = nowSec + 3600; // #791 と同条件（開始済み・有効1時間・timeLimit）。変更しない
      }
      if (stage === 'DELETE') {
        // 削除対象は「直前再照合で型付きのまま保存した ID」だけ。通常キーのIDは基準ハッシュと突合して拒否。古い照合では削除しない
        var rawT;
        try { rawT = deps.userProps.get(NID_TARGET_PROP); } catch (e) { rawT = undefined; }
        var tp = safeParse(rawT);
        if (!tp || typeof tp !== 'object' || tp.n !== st.name) return persistStop('TEST_KEY_ID_MISSING');
        targetId = tp.id; targetType = nidIdType(targetId);
        if (targetType !== st.targetIdType || (targetType !== 'ID_TYPE_NUMBER' && targetType !== 'ID_TYPE_STRING')) return persistStop('TARGET_ID_INVALID');
        if (Array.isArray(st.baselineIds) && st.baselineIds.indexOf(nidIdHash(sha, targetId)) !== -1) return persistStop('TARGET_IS_BASELINE_KEY');
        if (typeof st.preDeleteSec !== 'number' || nowSec - st.preDeleteSec < 0 || nowSec - st.preDeleteSec > NID_PREDELETE_MAX_AGE_SEC) return persistStop('PRE_DELETE_STALE');
        if (typeof st.endSec === 'number' && nowSec >= st.endSec) return persistStop('TEST_KEY_ALREADY_EXPIRED');
      }
      if (stage === 'VERIFY_DELETED') {
        if (typeof st.deleteSec !== 'number' || nowSec - st.deleteSec < NID_OBSERVE_MIN_SEC) return stop('OBSERVATION_WINDOW_NOT_ELAPSED'); // 承認・回数は消費しない
        var rawV;
        try { rawV = deps.userProps.get(NID_TARGET_PROP); } catch (e) { rawV = undefined; }
        var vp = safeParse(rawV);
        if (!vp || typeof vp !== 'object' || vp.n !== st.name || nidIdType(vp.id) !== st.targetIdType) return persistStop('TEST_KEY_ID_MISSING');
        targetId = vp.id;
      }

      // 通信前に: 承認の消費 + 呼出し回数 + 送信済みマーカーを永続（永続に失敗したら通信しない）
      var pre = JSON.parse(JSON.stringify(st));
      pre.state = def.pre; pre.calls = st.calls + 1; pre.deviceFp = devFp;
      if (stage === 'ISSUE') { pre.name = name; pre.startSec = startSec; pre.endSec = endSec; pre.issueSec = nowSec; }
      try { sp.del(NID_PROP.APPROVAL); } catch (e) { return stop('APPROVAL_CONSUME_FAILED'); }
      if (!nidWrite(sp, pre)) return stop('STATE_WRITE_FAILED');
      out.callsUsed = pre.calls; out.apiCalls = 1; out.state = pre.state;
      function halt(code) {
        var s = JSON.parse(JSON.stringify(pre)); s.state = 'STOPPED'; s.reason = code;
        nidWrite(sp, s);
        try { deps.userProps.del(NID_TARGET_PROP); } catch (e) { /* noop */ }
        out.state = 'STOPPED'; out.manualRecovery = true;
        return stop(code);
      }
      function done(next, mut) {
        var s = JSON.parse(JSON.stringify(pre)); s.state = next; if (mut) mut(s);
        if (!nidWrite(sp, s)) { out.manualRecovery = true; return stop('STATE_WRITE_FAILED'); }
        out.state = next; return fin();
      }

      if (stage !== 'ISSUE' && stage !== 'DELETE') {
        var lr;
        try { lr = deps.api.listDevices(); } catch (e) { lr = null; }
        if (!lr || lr.ok !== true) return halt(lr && lr.error === 'LIST_API_ERROR' ? 'LIST_API_ERROR' : 'LIST_COMM_ERROR');
        var snap = tksSnapshot(lr.devices, g.deviceId, sha);
        if (!snap.valid) return halt(snap.code);
        out.keyCount = snap.count; out.evidence = 'KEYLIST';
        if (stage === 'LIST') {
          if (snap.list.some(function (k) { return TKS_NAME_RE.test(String(k.name)); })) return halt('STALE_TEST_KEY_PRESENT');
          var baseType = idtClassify(lr.devices, g.deviceId);
          out.idType = IDT_RESULTS.indexOf(baseType) !== -1 && /^ID_TYPE_/.test(baseType) ? baseType : 'ID_TYPE_UNKNOWN';
          return done('LISTED', function (s) {
            s.baselineCount = snap.count; s.baselineFp = snap.fp; s.baselineIdType = out.idType;
            s.baselineIds = snap.ids.map(function (x) { return nidIdHash(sha, x); });
          });
        }
        if (stage === 'VERIFY_ISSUED' || stage === 'PRE_DELETE_LIST') {
          // 試験キーの一意性・通常キー不変を毎回照合する。削除の直前（PRE_DELETE_LIST）でも同じ契約で再照合する
          var hits = snap.list.filter(function (k) { return k.name === st.name; });
          if (hits.length === 0) return halt('KEY_NOT_FOUND');
          if (hits.length > 1) return halt('KEY_NAME_AMBIGUOUS');
          if (typeof st.startSec !== 'number' || typeof st.endSec !== 'number') return halt('KEY_ATTR_EXPECTATION_MISSING');
          var judged = Core.judgeIssued({ valid: true, count: 1, entries: hits }, { startSec: st.startSec, endSec: st.endSec });
          if (!judged.ok) return halt(CODE_RE.test(String(judged.error)) ? judged.error : 'KEY_ATTR_MISMATCH');
          if (snap.count !== st.baselineCount + 1) return halt('KEYLIST_COUNT_MISMATCH');
          var rawId = hits[0].id, rawType = nidIdType(rawId);
          if (rawType !== 'ID_TYPE_NUMBER' && rawType !== 'ID_TYPE_STRING') return halt(rawType === 'ID_NOT_SAFE_INTEGER' ? 'ID_NOT_SAFE_INTEGER' : 'TARGET_ID_INVALID');
          if (tksExcluding(snap, String(rawId), sha) !== st.baselineFp) return halt('EXISTING_KEYS_CHANGED');
          if (Array.isArray(st.baselineIds) && st.baselineIds.indexOf(nidIdHash(sha, rawId)) !== -1) return halt('TARGET_IS_BASELINE_KEY');
          out.idType = rawType;
          if (stage === 'VERIFY_ISSUED') return done('ISSUED_VERIFIED', function (s) { s.issuedIdType = rawType; });
          if (rawType !== st.issuedIdType) return halt('ID_TYPE_CHANGED');
          // 取得した生IDの型を保ったまま保存する（JSON.stringify で number は number のまま、string は string のまま往復する）
          try { deps.userProps.set(NID_TARGET_PROP, JSON.stringify({ n: st.name, id: rawId })); } catch (e) { return halt('TEST_KEY_ID_STORE_FAILED'); }
          return done('DELETE_READY', function (s) { s.targetIdType = rawType; s.preDeleteSec = nowSec; });
        }
        // VERIFY_DELETED
        var byName = snap.list.filter(function (k) { return k.name === st.name; }).length;
        var byId = snap.list.filter(function (k) { return String(k.id) === String(targetId); }).length;
        out.idType = st.targetIdType;
        if (byName || byId) return halt('TEST_KEY_STILL_PRESENT');
        if (snap.count !== st.baselineCount || snap.fp !== st.baselineFp) return halt('EXISTING_KEYS_CHANGED');
        try { deps.userProps.del(NID_TARGET_PROP); } catch (e) { /* 残っても無害（削除済み）。状態は完了にする */ }
        out.appCheck = 'PENDING_OWNER'; // API上の不在だけでは成功としない。公式アプリの表示確認（オーナー）が残る
        return done('API_ABSENT_APP_PENDING', null);
      }

      var res, thrown = false;
      try {
        res = stage === 'ISSUE'
          ? deps.api.createKey({ deviceId: g.deviceId, name: name, password: password, startTime: startSec, endTime: endSec })
          : deps.api.deleteKey(g.deviceId, targetId); // 型を変換しない（String() なし）。数値は数値のまま JSON.stringify される
      } catch (e) { thrown = true; }
      password = null;
      if (thrown) return halt(stage === 'ISSUE' ? 'ISSUE_RESULT_UNKNOWN' : 'DELETE_RESULT_UNKNOWN');
      var c = Core.classifyApi(res);
      if (!c.accepted) return halt(stage === 'ISSUE' ? 'ISSUE_RESULT_UNKNOWN' : 'DELETE_RESULT_UNKNOWN');
      out.evidence = c.commandId ? 'API_ACCEPTED_WITH_COMMAND_ID' : 'API_ACCEPTED_NO_COMMAND_ID';
      if (stage === 'DELETE') {
        out.idType = targetType; out.wireIdType = targetType; // 送信した parameter.id の JSON 型（値は出さない）
        out.issueToDeleteSec = typeof pre.issueSec === 'number' ? Math.max(0, nowSec - pre.issueSec) : -1;
        return done('DELETE_ACCEPTED', function (s) { s.hasCommandId = !!c.commandId; s.deleteSec = nowSec; s.deleteWireType = targetType; });
      }
      return done('ISSUE_ACCEPTED', function (s) { s.hasCommandId = !!c.commandId; });
    } catch (e) {
      out.manualRecovery = true;
      return stop('UNEXPECTED_ERROR');
    } finally {
      if (locked) { try { deps.lock.releaseLock(); } catch (e) { /* noop */ } }
    }
  }

  /**
   * 通信しない最終段階: 削除後GETで不在だったあと、公式アプリで試験キーが消えていることをオーナーが目視した結果を記録する。
   * 承認値 APP_ABSENT → COMPLETE。APP_PRESENT → STOPPED（API不在と公式アプリ表示の矛盾。手動撤去）。通信・資格情報・呼出し回数なし。
   */
  function numIdAppCheck(deps) {
    var out = nidBlank(); out.stage = 'APP_CHECK';
    function fin() {
      out.ok = out.failures.length === 0;
      out.code = out.ok ? 'NUMID_APP_CHECK_OK' : out.failures[0];
      return diagSanitize(out, 0);
    }
    function stop(code) { if (out.failures.indexOf(code) === -1) out.failures.push(code); out.stopped = true; return fin(); }
    var sp = deps.scriptProps, locked = false;
    try {
      var g = tksGates(deps);
      if (!g.ok) return stop(g.code);
      var pr = nidPrereq(sp);
      if (pr) return stop(pr);
      var armed = diagRead(sp, NID_PROP.ARMED);
      if (armed.state === 'UNKNOWN') return stop('ARMED_STATE_UNKNOWN');
      if (armed.state === 'MISSING') return stop('NOT_ARMED');
      if (armed.raw !== NID_PLAN) return stop('ARMED_PLAN_MISMATCH');
      if (!deps.lock || !deps.lock.tryLock(1000)) return stop('LOCK_UNAVAILABLE');
      locked = true;
      var rs = nidReadState(sp);
      if (!rs.ok) return stop('STATE_UNREADABLE');
      var st = rs.st;
      out.state = DIAG_VALUE_RE.test(st.state) ? st.state : 'INVALID_VALUE'; out.callsUsed = st.calls;
      if (st.state !== 'API_ABSENT_APP_PENDING') return stop('STAGE_ORDER_VIOLATION');
      var ap = diagRead(sp, NID_PROP.APPROVAL);
      if (ap.state === 'UNKNOWN') return stop('APPROVAL_STATE_UNKNOWN');
      if (ap.raw !== 'APP_ABSENT' && ap.raw !== 'APP_PRESENT') return stop('STAGE_NOT_APPROVED');
      var present = ap.raw === 'APP_PRESENT';
      try { sp.del(NID_PROP.APPROVAL); } catch (e) { return stop('APPROVAL_CONSUME_FAILED'); }
      var s = JSON.parse(JSON.stringify(st)); s.state = present ? 'STOPPED' : 'COMPLETE'; s.reason = present ? 'APP_STILL_PRESENT' : 'APP_ABSENT_CONFIRMED';
      if (!nidWrite(sp, s)) { out.manualRecovery = true; return stop('STATE_WRITE_FAILED'); }
      out.state = s.state;
      if (present) { out.manualRecovery = true; return stop('APP_STILL_PRESENT'); }
      out.appCheck = 'ABSENT_CONFIRMED';
      return fin();
    } catch (e) {
      out.manualRecovery = true;
      return stop('UNEXPECTED_ERROR');
    } finally {
      if (locked) { try { deps.lock.releaseLock(); } catch (e) { /* noop */ } }
    }
  }

  /** 通信しない状態確認。ok=true はゲート通過のみ（GOでも実行可能の判定でもない）。値・ID・名前は出さない。 */
  function numIdStatus(deps) {
    var out = nidBlank(); out.stage = 'STATUS'; out.planId = NID_PLAN;
    out.notes = out.notes.concat(['STATUS_OK_IS_NOT_GO_NOR_EXECUTABLE']);
    var g = tksGates(deps);
    out.gates = g.ok ? 'PASS' : g.code;
    var pr = g.ok ? nidPrereq(deps.scriptProps) : null;
    out.prerequisites = !g.ok ? 'NOT_CHECKED' : (pr || 'PASS');
    var rs = nidReadState(deps.scriptProps);
    if (rs.ok) { out.state = DIAG_VALUE_RE.test(rs.st.state) ? rs.st.state : 'INVALID_VALUE'; out.callsUsed = rs.st.calls; out.manualRecovery = rs.st.state === 'STOPPED' || /_SENT$/.test(rs.st.state); }
    else out.state = 'STATE_UNREADABLE';
    var a = diagRead(deps.scriptProps, NID_PROP.ARMED);
    out.armed = a.state === 'UNKNOWN' ? 'UNKNOWN' : (a.state === 'MISSING' ? 'OFF' : (a.raw === NID_PLAN ? 'ON' : 'PLAN_MISMATCH'));
    var ap = diagRead(deps.scriptProps, NID_PROP.APPROVAL);
    var okVal = Object.keys(NID_STAGES).concat(['APP_ABSENT', 'APP_PRESENT']);
    out.approvedStage = ap.state === 'UNKNOWN' ? 'UNKNOWN' : (ap.state === 'MISSING' ? 'NONE' : (okVal.indexOf(ap.raw) !== -1 ? ap.raw : 'INVALID_VALUE'));
    var legacy = tksReadState(deps.scriptProps);
    out.legacyState = legacy.ok && DIAG_VALUE_RE.test(legacy.st.state) ? legacy.st.state : 'STATE_UNREADABLE'; // #791 の状態は読むだけ
    out.ok = g.ok && !pr && rs.ok;
    out.code = out.ok ? 'NUMID_STATUS_OK' : (!g.ok ? g.code : (pr || 'STATE_UNREADABLE'));
    return diagSanitize(out, 0);
  }

  // ---------- 37DD keyList.id 型のみの読取専用診断（Issue #795）----------
  // 目的: 現存する通常キーの keyList.id が JSON 上で数値か文字列かを、固定コードだけで把握する。
  // 通信は GET /v1.1/devices を永続予算1回のみ。変更系 API・User Properties 書込・既存 ACCESS_TEST_KEY_STATE の変更はしない。
  // 観測できるのは「現存する通常キー」の型であり、11/6 に削除済みの試験キーの過去の型を証明するものではない。
  var IDT_PROP = { APPROVAL: 'ACCESS_ID_TYPE_DIAG_APPROVAL', STATE: 'ACCESS_ID_TYPE_DIAG_STATE' };
  var IDT_APPROVAL_VALUE = 'ID_TYPE_READ_ONCE';
  var IDT_RESULTS = ['ID_TYPE_NUMBER', 'ID_TYPE_STRING', 'ID_TYPE_MIXED', 'ID_TYPE_UNKNOWN', 'KEYLIST_INVALID', 'TARGET_NOT_UNIQUE'];

  function idtBlank(stage) {
    return { ok: false, code: 'ID_TYPE_DIAG_NOT_RUN', stage: stage, failures: [], stopped: false, apiCalls: 0, idType: 'NOT_CHECKED',
      notes: ['READ_ONLY', 'TARGET_37DD_ONLY', 'ONE_GET_ONLY', 'NO_AUTO_RETRY', 'NORMAL_KEYS_ONLY_NOT_DELETED_TEST_KEY'] };
  }

  /** 既存の変更試験が STOPPED のまま・ARMED/APPROVAL 未設定であることを読むだけで確認する（書込なし）。 */
  function idtPrereq(sp) {
    var armed = diagRead(sp, TKS_PROP.ARMED);
    if (armed.state === 'UNKNOWN') return 'ARMED_STATE_UNKNOWN';
    if (armed.state === 'SET') return 'TEST_KEY_ARMED_PRESENT';
    var tap = diagRead(sp, TKS_PROP.APPROVAL);
    if (tap.state === 'UNKNOWN') return 'APPROVAL_STATE_UNKNOWN';
    if (tap.state === 'SET') return 'TEST_KEY_APPROVAL_PRESENT';
    var rs = tksReadState(sp);
    if (!rs.ok) return 'TEST_KEY_STATE_UNREADABLE';
    if (rs.st.state !== 'STOPPED') return 'TEST_KEY_STATE_NOT_STOPPED';
    return null;
  }

  /** keyList.id の型だけを集約する。値は保持・返却しない。 */
  function idtClassify(devices, deviceId) {
    if (!Array.isArray(devices)) return 'KEYLIST_INVALID';
    var n = 0, list = null;
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      if (d && typeof d === 'object' && d.deviceId === deviceId) { n++; list = d.keyList; }
    }
    if (n !== 1) return 'TARGET_NOT_UNIQUE';
    if (!Array.isArray(list)) return 'KEYLIST_INVALID';
    var num = false, str = false, other = false;
    for (var j = 0; j < list.length; j++) {
      var k = list[j];
      if (!k || typeof k !== 'object') return 'KEYLIST_INVALID';
      var t = typeof k.id;
      if (t === 'number' && isFinite(k.id)) num = true;
      else if (t === 'string' && k.id !== '') str = true;
      else other = true;
    }
    if (other || (!num && !str)) return 'ID_TYPE_UNKNOWN';
    return num && str ? 'ID_TYPE_MIXED' : (num ? 'ID_TYPE_NUMBER' : 'ID_TYPE_STRING');
  }

  function idTypeDiag(deps) {
    var out = idtBlank('RUN');
    function fin() {
      out.ok = out.failures.length === 0 && ['ID_TYPE_NUMBER', 'ID_TYPE_STRING', 'ID_TYPE_MIXED'].indexOf(out.idType) !== -1;
      out.code = out.failures.length ? out.failures[0] : out.idType;
      return diagSanitize(out, 0);
    }
    function stop(code) { if (out.failures.indexOf(code) === -1) out.failures.push(code); out.stopped = true; return fin(); }
    var sp = deps.scriptProps, locked = false;
    try {
      var g = tksGates(deps);
      if (!g.ok) return stop(g.code);
      var pr = idtPrereq(sp);
      if (pr) return stop(pr);
      if (!deps.lock || !deps.lock.tryLock(1000)) return stop('LOCK_UNAVAILABLE');
      locked = true;

      // 診断の予算は永続の1回のみ。状態が何かあれば（送信済み・完了・停止・読取不能）再実行しない
      var cur = diagRead(sp, IDT_PROP.STATE);
      if (cur.state === 'UNKNOWN') return stop('DIAG_STATE_UNKNOWN');
      if (cur.state === 'SET') return stop('DIAG_ALREADY_USED');
      var ap = diagRead(sp, IDT_PROP.APPROVAL);
      if (ap.state === 'UNKNOWN') return stop('APPROVAL_STATE_UNKNOWN');
      if (ap.raw !== IDT_APPROVAL_VALUE) return stop('DIAG_NOT_APPROVED');
      var cred;
      try { cred = !!(deps.userProps.get('SWITCHBOT_TOKEN') && deps.userProps.get('SWITCHBOT_SECRET')); } catch (e) { cred = false; }
      if (!cred) return stop('AUTH_CREDENTIALS_MISSING');

      // 通信前に: 承認の消費 + 送信済みマーカーを永続（どちらか失敗したら通信しない）
      try { sp.del(IDT_PROP.APPROVAL); } catch (e) { return stop('APPROVAL_CONSUME_FAILED'); }
      try { sp.set(IDT_PROP.STATE, JSON.stringify({ v: 1, state: 'SENT', calls: 1 })); } catch (e) { return stop('STATE_WRITE_FAILED'); }
      out.apiCalls = 1;
      function finish(state, result) {
        try { sp.set(IDT_PROP.STATE, JSON.stringify({ v: 1, state: state, calls: 1, result: result })); } catch (e) { out.failures.push('STATE_WRITE_FAILED'); }
      }

      var lr;
      try { lr = deps.api.listDevices(); } catch (e) { lr = null; }
      if (!lr || lr.ok !== true) {
        var ec = lr && lr.error === 'LIST_API_ERROR' ? 'LIST_API_ERROR' : 'LIST_COMM_ERROR';
        finish('STOPPED', ec);
        return stop(ec);
      }
      var res = idtClassify(lr.devices, g.deviceId);
      lr = null;
      if (IDT_RESULTS.indexOf(res) === -1) res = 'ID_TYPE_UNKNOWN';
      if (res === 'KEYLIST_INVALID' || res === 'TARGET_NOT_UNIQUE') { finish('STOPPED', res); return stop(res); }
      out.idType = res;
      finish('DONE', res);
      return fin();
    } catch (e) {
      return stop('UNEXPECTED_ERROR');
    } finally {
      if (locked) { try { deps.lock.releaseLock(); } catch (e) { /* noop */ } }
    }
  }

  /** 通信しない状態確認。値・件数は出さない。 */
  function idTypeDiagStatus(deps) {
    var out = idtBlank('STATUS');
    out.notes = out.notes.concat(['STATUS_OK_IS_NOT_GO_NOR_EXECUTABLE']); // ok=true はゲート通過のみ。GOでも実行可能でもない
    var g = tksGates(deps);
    out.gates = g.ok ? 'PASS' : g.code;
    var pr = g.ok ? idtPrereq(deps.scriptProps) : null;
    out.prerequisites = !g.ok ? 'NOT_CHECKED' : (pr || 'PASS');
    var cur = diagRead(deps.scriptProps, IDT_PROP.STATE);
    if (cur.state === 'MISSING') out.diagState = 'NOT_USED';
    else if (cur.state === 'UNKNOWN') out.diagState = 'UNKNOWN';
    else { var p = safeParse(cur.raw); out.diagState = p && typeof p.state === 'string' && DIAG_VALUE_RE.test(p.state) ? p.state : 'INVALID_VALUE'; if (p && IDT_RESULTS.indexOf(p.result) !== -1) out.lastResult = p.result; else if (p && typeof p.result === 'string' && /^LIST_(API|COMM)_ERROR$/.test(p.result)) out.lastResult = p.result; }
    var ap = diagRead(deps.scriptProps, IDT_PROP.APPROVAL);
    out.approved = ap.state === 'SET' && ap.raw === IDT_APPROVAL_VALUE ? 'ON' : (ap.state === 'UNKNOWN' ? 'UNKNOWN' : (ap.state === 'SET' ? 'INVALID_VALUE' : 'OFF'));
    out.ok = g.ok && !pr;
    out.code = out.ok ? 'ID_TYPE_DIAG_STATUS_OK' : (g.ok ? pr : g.code);
    return diagSanitize(out, 0);
  }

  // ---------- 本番初期設定の読取専用診断（Issue #774）----------

  var DIAG_PREFIXES = ['OP', 'BK', 'EVT', 'DLV', 'HB', 'IALERT', 'ALERT', 'INBOX', 'TRK', 'ADMINLOG', 'APICOUNT', 'META'];
  var DIAG_VALUE_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
  var DIAG_NOTES = ['NO_WRITES', 'NO_EXTERNAL_COMMUNICATION', 'CREDENTIAL_VALIDITY_NOT_VERIFIED'];

  /** 出力ホワイトリスト: 固定コード形式の文字列・有限数・真偽値・それらの配列/入れ子のみ通す。それ以外（自由文・ID・URL等）は潰す。 */
  function diagSanitize(v, depth) {
    if (depth > 4) return 'INVALID_VALUE';
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return isFinite(v) ? v : 'INVALID_VALUE';
    if (typeof v === 'string') return DIAG_VALUE_RE.test(v) ? v : 'INVALID_VALUE';
    if (Array.isArray(v)) return v.slice(0, 32).map(function (x) { return diagSanitize(x, depth + 1); });
    if (v && typeof v === 'object') {
      var o = {};
      Object.keys(v).forEach(function (k) { if (DIAG_VALUE_RE.test(k) || /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(k)) o[k] = diagSanitize(v[k], depth + 1); });
      return o;
    }
    return 'INVALID_VALUE';
  }

  /** プロパティ1件を SET/MISSING/UNKNOWN で読む（値は返さない）。読取例外・undefined は UNKNOWN（MISSING に潰さない）。 */
  function diagRead(props, name) {
    var v;
    try { v = props.get(name); } catch (e) { return { state: 'UNKNOWN', raw: null }; }
    if (v === undefined) return { state: 'UNKNOWN', raw: null };
    return v === null || v === '' ? { state: 'MISSING', raw: null } : { state: 'SET', raw: String(v) };
  }

  function diagBlank() {
    return {
      ok: false, code: 'DIAGNOSTICS_NOT_RUN', failures: [], stopped: false,
      identity: 'NOT_CHECKED', accessEnabled: 'NOT_CHECKED', environment: 'NOT_CHECKED',
      config: { state: 'NOT_CHECKED', source: 'NOT_CHECKED', envMatch: 'NOT_CHECKED', errors: [], splitProps: {} },
      settings: { ACCESS_CONFIG: 'NOT_CHECKED', ACCESS_ENVIRONMENT: 'NOT_CHECKED', LEDGER_SPREADSHEET_ID: 'NOT_CHECKED', ACCESS_ADMIN_ACTORS: 'NOT_CHECKED' },
      credentials: { SWITCHBOT_TOKEN: 'NOT_CHECKED', SWITCHBOT_SECRET: 'NOT_CHECKED', WEBHOOK_SHARED_TOKEN: 'NOT_CHECKED' },
      issuance: { state: 'NOT_CHECKED', problems: [] },
      ledger: { state: 'NOT_CHECKED', headers: 'NOT_CHECKED', columnFormat: 'NOT_CHECKED', rows: 0, sampled: 0 },
      store: { state: 'NOT_CHECKED', metaEnv: 'NOT_CHECKED', gate: 'NOT_CHECKED', keys: 0, bytes: 0, ratio: 0, valueRatio: 0, byPrefix: {}, ops: { total: 0, unresolved: 0, unreadable: 0 } },
      notes: DIAG_NOTES.slice()
    };
  }

  function diagStore(store, cfg, out) {
    var s = out.store;
    try {
      var keys = store.keys();
      var m = measureStore(store);
      var gate = storageGate(m, cfg, cfg && cfg.storageLimits);
      s.keys = m.keys; s.bytes = m.bytes;
      s.ratio = Math.round(gate.ratio * 10000) / 10000; s.valueRatio = Math.round(gate.valueRatio * 10000) / 10000;
      s.gate = gate.ok ? 'OK' : gate.code;
      var byPrefix = {};
      Object.keys(m.byPrefix).forEach(function (p) {
        var name = DIAG_PREFIXES.indexOf(p) !== -1 ? p : 'OTHER';
        byPrefix[name] = (byPrefix[name] || 0) + m.byPrefix[p].count;
      });
      s.byPrefix = byPrefix;
      var opKeys = keys.filter(function (k) { return k.indexOf('OP_') === 0; });
      var knownStates = Object.keys(Core.STATE).map(function (k) { return Core.STATE[k]; });
      var ops = scanOps(store).filter(function (r) { return typeof r.id === 'string' && knownStates.indexOf(r.state) !== -1; }); // 状態が未知/欠落の記録は不正として数える
      s.ops = { total: ops.length, unresolved: ops.filter(isUnresolved).length, unreadable: opKeys.length - ops.length };
      var meta = store.get('META_ENV');
      s.metaEnv = meta === null || meta === undefined || meta === '' ? 'ABSENT' : (meta === ENVIRONMENT.PRODUCTION ? 'MATCH' : 'MISMATCH');
      if (s.metaEnv === 'MISMATCH') s.state = 'STORE_ENV_MISMATCH';
      else if (s.ops.unreadable > 0) s.state = 'STORE_RECORD_INVALID';
      else if (!gate.ok) s.state = gate.code;
      else if (m.keys === 0) s.state = 'EMPTY_UNINITIALIZED';
      else if (s.metaEnv === 'ABSENT') s.state = 'STORE_INCONSISTENT';
      else s.state = 'INITIALIZED';
    } catch (e) {
      s.state = 'STORE_READ_FAILED';
    }
    return s.state === 'EMPTY_UNINITIALIZED' || s.state === 'INITIALIZED';
  }

  /**
   * 独立GAS本番初期設定の読取専用診断。書込み・ロック・通信・トリガー・メール・Sheets書込みを一切行わない
   * （deps に set/del/lock/api/sendMail を渡さない）。返すのは固定コード・SET/MISSING/UNKNOWN・集計値のみ
   * （値・ID・メール・予約情報・例外本文は含めない）。資格情報の実API有効性・実機疎通は確認しない。
   * deps: identity(), adminActors, accessFlag(), scriptProps{get}, userProps{get}, stateStore{get,keys}, ledgerInspect()
   */
  function readOnlyDiagnostics(deps) {
    var out = diagBlank();
    function fin() {
      out.ok = out.failures.length === 0;
      out.code = out.ok ? 'DIAGNOSTICS_OK' : out.failures[0];
      return diagSanitize(out, 0);
    }
    function fail(code) { if (out.failures.indexOf(code) === -1) out.failures.push(code); }
    try {
      var gate = authorizeExecutor(deps);
      if (!gate.ok) { out.identity = gate.error; fail(gate.error); out.stopped = true; return fin(); }
      out.identity = 'AUTHORIZED';

      var flag = accessFlagState(deps);
      out.accessEnabled = flag;
      if (flag !== 'OFF') { fail(flagCode(flag)); out.stopped = true; return fin(); }

      var sp = deps.scriptProps, up = deps.userProps;
      var cfgRaw = diagRead(sp, 'ACCESS_CONFIG'), envRaw = diagRead(sp, 'ACCESS_ENVIRONMENT');
      var idRaw = diagRead(sp, 'LEDGER_SPREADSHEET_ID'), actorsRaw = diagRead(sp, 'ACCESS_ADMIN_ACTORS');
      out.settings = { ACCESS_CONFIG: cfgRaw.state, ACCESS_ENVIRONMENT: envRaw.state, LEDGER_SPREADSHEET_ID: idRaw.state, ACCESS_ADMIN_ACTORS: actorsRaw.state };
      CREDENTIAL_NAMES.forEach(function (n) { out.credentials[n] = diagRead(up, n).state; });
      // 設定の正本（#859）: ACCESS_CONFIG_FORMAT 未設定=旧 ACCESS_CONFIG、'split-v1'=分割プロパティ。旧形式のときだけ ACCESS_CONFIG を必須にする
      var loaded = loadConfig(function (k) { return sp.get(k); });
      out.config.source = loaded.source;
      SPLIT_PROP_NAMES.concat([CONFIG_FORMAT_PROP]).forEach(function (n) { out.config.splitProps[n] = loaded.props[n] || 'UNKNOWN'; });
      var settingsOk = Object.keys(out.settings).every(function (k) {
        return out.settings[k] === 'SET' || (k === 'ACCESS_CONFIG' && loaded.source !== 'LEGACY' && out.settings[k] === 'MISSING');
      });
      var credsOk = CREDENTIAL_NAMES.every(function (n) { return out.credentials[n] === 'SET'; });
      if (!settingsOk) fail('SETTINGS_INCOMPLETE');
      if (!credsOk) fail('CREDENTIALS_INCOMPLETE');

      out.environment = envRaw.state === 'SET' ? (envRaw.raw === ENVIRONMENT.PRODUCTION ? 'PRODUCTION' : 'NOT_PRODUCTION') : envRaw.state;
      if (out.environment !== 'PRODUCTION' && envRaw.state === 'SET') fail('ENV_NOT_PRODUCTION');

      var cfg = {};
      if (loaded.source !== 'LEGACY') {
        cfg = loaded.cfg;
        out.config.envMatch = cfg.environment !== '__MISMATCH__' && envRaw.state === 'SET' ? 'MATCH' : 'MISMATCH';
        var vs = validateConfig(cfg);
        out.config.state = vs.ok && out.config.envMatch === 'MATCH' ? 'VALID' : 'INVALID';
        out.config.errors = vs.errors.slice(0, 16);
      } else if (cfgRaw.state !== 'SET') out.config.state = cfgRaw.state;
      else {
        var parsed = safeParse(cfgRaw.raw);
        if (parsed === null && cfgRaw.raw !== 'null') out.config.state = 'PARSE_ERROR';
        else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) out.config.state = 'NOT_OBJECT';
        else {
          cfg = parsed;
          out.config.envMatch = envRaw.state === 'SET' && cfg.environment === envRaw.raw ? 'MATCH' : 'MISMATCH';
          var v = validateConfig(out.config.envMatch === 'MATCH' ? cfg : Object.assign({}, cfg, { environment: '__MISMATCH__' }));
          // 旧形式のまま分割プロパティが残っている（移行途中・ロールバック漏れ）は黙って許容しない
          var lerr = loaded.errors.filter(function (e) { return v.errors.indexOf(e) === -1; });
          out.config.state = v.ok && !lerr.length && out.config.envMatch === 'MATCH' ? 'VALID' : 'INVALID';
          out.config.errors = lerr.concat(v.errors).slice(0, 16);
        }
      }
      if (out.config.state !== 'VALID') fail(out.config.state === 'INVALID' ? 'CONFIG_INVALID' : 'CONFIG_' + out.config.state);
      // 発行前提（#859）: 基本妥当性（VALID）とは別に、コアの発行判定を通り得るかを示す。ON前の合否は issuance.state=READY で判断する
      if (out.config.state === 'VALID') out.issuance = issuanceReadiness(cfg);

      if (idRaw.state !== 'SET') { out.ledger.state = idRaw.state === 'MISSING' ? 'LEDGER_ID_MISSING' : 'LEDGER_READ_FAILED'; fail(out.ledger.state); }
      else {
        var lr = null;
        try { lr = deps.ledgerInspect ? deps.ledgerInspect() : null; } catch (e) { lr = null; }
        if (!lr || typeof lr !== 'object') lr = { code: 'LEDGER_READ_FAILED' };
        out.ledger.state = typeof lr.code === 'string' ? lr.code : 'LEDGER_READ_FAILED';
        ['headers', 'columnFormat'].forEach(function (k) { if (typeof lr[k] === 'string') out.ledger[k] = lr[k]; });
        ['rows', 'sampled'].forEach(function (k) { if (typeof lr[k] === 'number') out.ledger[k] = lr[k]; });
        if (out.ledger.state !== 'LEDGER_ACCESS_OK') fail(DIAG_VALUE_RE.test(out.ledger.state) ? out.ledger.state : 'LEDGER_READ_FAILED');
      }

      if (!diagStore(deps.stateStore, cfg, out)) fail(DIAG_VALUE_RE.test(out.store.state) ? out.store.state : 'STORE_READ_FAILED');
    } catch (e) {
      fail('UNEXPECTED_ERROR');
    }
    return fin();
  }

  // ---------- verify環境専用の読取専用診断（Issue #789）----------

  var TEST_ALLOWED_LAST4 = ['37DD'];
  var TEST_FORBIDDEN_LAST4 = ['01FD'];
  var TEST_NOTES = ['NO_WRITES', 'NO_EXTERNAL_COMMUNICATION', 'NO_SWITCHBOT_API', 'CREDENTIALS_NOT_READ'];

  function testDiagBlank() {
    return {
      ok: false, code: 'DIAGNOSTICS_NOT_RUN', failures: [], stopped: false,
      identity: 'NOT_CHECKED', accessEnabled: 'NOT_CHECKED', environment: 'NOT_CHECKED',
      config: { state: 'NOT_CHECKED', envMatch: 'NOT_CHECKED', last4: 'NOT_CHECKED', errors: [] },
      settings: { ACCESS_CONFIG: 'NOT_CHECKED', ACCESS_ENVIRONMENT: 'NOT_CHECKED', LEDGER_SPREADSHEET_ID: 'NOT_CHECKED', ACCESS_ADMIN_ACTORS: 'NOT_CHECKED' },
      ledger: { state: 'NOT_CHECKED', headers: 'NOT_CHECKED', columnFormat: 'NOT_CHECKED', timezone: 'NOT_CHECKED', rows: 0, sampled: 0 },
      notes: TEST_NOTES.slice()
    };
  }

  /**
   * verify環境（SwitchBot Access Test）専用の読取専用診断。本番診断 readOnlyDiagnostics とは別関数で、本番の基準は変えない。
   * fail-closed: 操作主体=ACCESS_ADMIN_ACTORS 本人 / ACCESS_ENABLED が明示 'false' / ACCESS_ENVIRONMENT と ACCESS_CONFIG.environment がともに verify /
   * allowedLast4 が ['37DD'] のみで keypads 末尾4桁もすべて 37DD（01FD は拒否）。満たさなければ台帳へ触れない。
   * 台帳はGETのみ（ledgerInspect）。資格情報・状態ストアは読まない。書込み・通信（SwitchBot/メール）・トリガー・ロックなし。
   * 返すのは固定コード・SET/MISSING/UNKNOWN・件数のみ（完全deviceId・スプレッドシートID・メール・予約内容・例外本文は含めない）。
   * deps: identity(), adminActors, accessFlag(), scriptProps{get}, ledgerInspect()
   */
  function testReadOnlyDiagnostics(deps) {
    var out = testDiagBlank();
    function fin() {
      out.ok = out.failures.length === 0;
      out.code = out.ok ? 'TEST_DIAGNOSTICS_OK' : out.failures[0];
      return diagSanitize(out, 0);
    }
    function fail(code) { if (out.failures.indexOf(code) === -1) out.failures.push(code); }
    function stop(code) { fail(code); out.stopped = true; return fin(); }
    try {
      var gate = authorizeExecutor(deps);
      if (!gate.ok) { out.identity = gate.error; return stop(gate.error); }
      out.identity = 'AUTHORIZED';

      var flag = accessFlagState(deps);
      var flagRaw;
      try { flagRaw = deps.accessFlag(); } catch (e) { flagRaw = undefined; }
      if (flag === 'OFF' && flagRaw !== 'false') { out.accessEnabled = 'NOT_EXPLICIT'; return stop('ACCESS_FLAG_NOT_EXPLICIT_OFF'); }
      out.accessEnabled = flag;
      if (flag !== 'OFF') return stop(flagCode(flag));

      var sp = deps.scriptProps;
      var cfgRaw = diagRead(sp, 'ACCESS_CONFIG'), envRaw = diagRead(sp, 'ACCESS_ENVIRONMENT');
      var idRaw = diagRead(sp, 'LEDGER_SPREADSHEET_ID'), actorsRaw = diagRead(sp, 'ACCESS_ADMIN_ACTORS');
      out.settings = { ACCESS_CONFIG: cfgRaw.state, ACCESS_ENVIRONMENT: envRaw.state, LEDGER_SPREADSHEET_ID: idRaw.state, ACCESS_ADMIN_ACTORS: actorsRaw.state };
      if (!Object.keys(out.settings).every(function (k) { return out.settings[k] === 'SET'; })) fail('SETTINGS_INCOMPLETE');

      out.environment = envRaw.state === 'SET' ? (envRaw.raw === ENVIRONMENT.VERIFY ? 'VERIFY' : 'NOT_VERIFY') : envRaw.state;
      if (out.environment !== 'VERIFY') {
        fail(envRaw.state === 'SET' ? 'ENV_NOT_VERIFY' : 'SETTINGS_INCOMPLETE');
        out.stopped = true;
        return fin();
      }

      var cfg = null;
      if (cfgRaw.state !== 'SET') out.config.state = cfgRaw.state;
      else {
        var parsed = safeParse(cfgRaw.raw);
        if (parsed === null && cfgRaw.raw !== 'null') out.config.state = 'PARSE_ERROR';
        else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) out.config.state = 'NOT_OBJECT';
        else {
          cfg = parsed;
          out.config.envMatch = cfg.environment === ENVIRONMENT.VERIFY ? 'MATCH' : 'MISMATCH';
          var v = validateConfig(cfg);
          out.config.errors = v.errors.slice(0, 16);
          out.config.state = v.ok && out.config.envMatch === 'MATCH' ? 'VALID' : 'INVALID';
          var allowed = Array.isArray(cfg.allowedLast4) ? cfg.allowedLast4.map(function (x) { return String(x).toUpperCase(); }) : [];
          var padLast4 = (Array.isArray(cfg.keypads) ? cfg.keypads : []).map(function (k) { return k && typeof k.deviceId === 'string' ? last4(k.deviceId) : ''; });
          var all = allowed.concat(padLast4);
          if (all.some(function (x) { return TEST_FORBIDDEN_LAST4.indexOf(x) !== -1; })) out.config.last4 = 'FORBIDDEN';
          else if (allowed.length && padLast4.length && all.every(function (x) { return TEST_ALLOWED_LAST4.indexOf(x) !== -1; })) out.config.last4 = 'MATCH';
          else out.config.last4 = 'MISMATCH';
        }
      }
      if (out.config.state !== 'VALID') fail(out.config.state === 'INVALID' ? 'CONFIG_INVALID' : 'CONFIG_' + out.config.state);
      if (out.config.last4 === 'FORBIDDEN') fail('LAST4_FORBIDDEN');
      else if (out.config.last4 === 'MISMATCH') fail('LAST4_MISMATCH');

      // 前提（環境・設定・末尾4桁）が崩れていれば、台帳へは触れない
      if (out.failures.length) { out.stopped = true; return fin(); }

      var lr = null;
      try { lr = deps.ledgerInspect ? deps.ledgerInspect() : null; } catch (e) { lr = null; }
      if (!lr || typeof lr !== 'object') lr = { code: 'LEDGER_READ_FAILED' };
      out.ledger.state = typeof lr.code === 'string' ? lr.code : 'LEDGER_READ_FAILED';
      ['headers', 'columnFormat', 'timezone'].forEach(function (k) { if (typeof lr[k] === 'string') out.ledger[k] = lr[k]; });
      ['rows', 'sampled'].forEach(function (k) { if (typeof lr[k] === 'number') out.ledger[k] = lr[k]; });
      if (out.ledger.state !== 'LEDGER_ACCESS_OK') fail(DIAG_VALUE_RE.test(out.ledger.state) ? out.ledger.state : 'LEDGER_READ_FAILED');
      else if (out.ledger.timezone !== 'JST') fail('LEDGER_TIMEZONE_UNSUPPORTED');
    } catch (e) {
      fail('UNEXPECTED_ERROR');
    }
    return fin();
  }

  return {
    keyReadinessLevel: keyReadinessLevel, hasConfirmedKey: hasConfirmedKey, URGENT_CODES: URGENT_CODES,
    ENVIRONMENT: ENVIRONMENT, PROPERTIES_LIMITS: PROPERTIES_LIMITS, DEFAULTS: DEFAULTS, CATALOG: CATALOG, FREEZE_REASONS: FREEZE_REASONS,
    validateConfig: validateConfig, ensureStoreEnvironment: ensureStoreEnvironment,
    loadConfig: loadConfig, issuanceReadiness: issuanceReadiness, CONFIG_FORMAT_PROP: CONFIG_FORMAT_PROP, CONFIG_FORMAT_SPLIT: CONFIG_FORMAT_SPLIT,
    SPLIT_PROPS: SPLIT_PROPS, SPLIT_PROP_NAMES: SPLIT_PROP_NAMES, SPLIT_JSON_KEYS: SPLIT_JSON_KEYS, ELIGIBLE_PAYMENT_BASIS: ELIGIBLE_PAYMENT_BASIS,
    constantTimeEquals: constantTimeEquals, authenticateWebhook: authenticateWebhook, authorizeAdmin: authorizeAdmin,
    CREDENTIAL_NAMES: CREDENTIAL_NAMES, validateCredentialInput: validateCredentialInput, setupCredentials: setupCredentials, credentialStatus: credentialStatus,
    BOOTSTRAP_KEYS: BOOTSTRAP_KEYS, accessFlagState: accessFlagState, migrateBootstrapCredentials: migrateBootstrapCredentials, bootstrapStatus: bootstrapStatus, scrubBootstrapCredentials: scrubBootstrapCredentials,
    readOnlyDiagnostics: readOnlyDiagnostics, testReadOnlyDiagnostics: testReadOnlyDiagnostics, testKeyStage: testKeyStage, testKeyStatus: testKeyStatus, idTypeDiag: idTypeDiag, idTypeDiagStatus: idTypeDiagStatus, TKS_MAX_CALLS: TKS_MAX_CALLS,
    numIdStage: numIdStage, numIdAppCheck: numIdAppCheck, numIdStatus: numIdStatus, NID_MAX_CALLS: NID_MAX_CALLS, NID_PLAN: NID_PLAN,
    bndStage: bndStage, bndObserve: bndObserve, bndAppCheck: bndAppCheck, bndStatus: bndStatus, bndWindowPlan: bndWindowPlan, BND_MAX_CALLS: BND_MAX_CALLS, BND_PLAN: BND_PLAN,
    minimizeWebhook: minimizeWebhook, openWebhookOps: openWebhookOps, correlateWebhook: correlateWebhook,
    createLockDomain: createLockDomain, keypadCapacityGate: keypadCapacityGate,
    byteLength: byteLength, measureStore: measureStore, storageGate: storageGate, estimateStorage: estimateStorage,
    garbageCollect: garbageCollect, isExpiredApiCountKey: isExpiredApiCountKey, APICOUNT_KEEP_DAYS: APICOUNT_KEEP_DAYS, planJobs: planJobs, createApiBudget: createApiBudget,
    classify: classify, renderNotification: renderNotification, createRuntime: createRuntime,
    deliverySettings: deliverySettings, renderCodeMail: renderCodeMail, notSentError: notSentError
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SwitchBotAccessInfra;
}
