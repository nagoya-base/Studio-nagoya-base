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
    if (cfg.delivery !== undefined && !deliverySettings(cfg)) errors.push('DELIVERY_CONFIG_INVALID');
    return { ok: errors.length === 0, errors: errors.filter(function (e, i) { return errors.indexOf(e) === i; }) };
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
   * 暗証番号案内メールの固定文面（予約確認メールとは別送）。差し込むのは暗証番号・施設名・有効時間・予約番号のみ。
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
    lines.push(st.senderName + ' です。');
    lines.push(change ? 'ご予約内容の変更に伴い、入室用の暗証番号をあらためてお送りします。' : 'ご予約の入室用の暗証番号をお送りします。');
    lines.push('（この暗証番号は、予約確認メールとは別にお送りしています）');
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

  /**
   * 保持期限に基づく回収（ロック保持下で呼ぶ）。未解決OPと、それに必要な根拠（索引・Webhook・秘密・通知マーカー）は
   * 期限に関わらず保護する。回収: 参照切れのBK索引項目／期限切れBK／期限切れかつ未参照のEVT／OP不在のALERT／
   * OPが無い・終端OPの秘密／期限切れ受信箱／古い追跡・通知・管理者ログ。件数のみ返す。
   */
  function garbageCollect(store, secrets, nowSec, cfg) {
    var ic = infraCfg(cfg);
    var ret = ic.retention;
    var removed = { BK: 0, EVT: 0, ALERT: 0, SECRET: 0, INBOX: 0, TRK: 0, IALERT: 0, ADMINLOG: 0, BK_OPREF: 0, DLV: 0 };
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
      var input = deps.snapshot.toCoreInput(sn, nowMs);
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
          var ledCode = led && typeof led.error === 'string' && /^LEDGER_[A-Z_]+$/.test(led.error) && Object.prototype.hasOwnProperty.call(CATALOG, led.error) ? led.error : 'LEDGER_READ_FAILED';
          infraAlert(ledCode, null, null, null);
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
      config: { state: 'NOT_CHECKED', envMatch: 'NOT_CHECKED', errors: [] },
      settings: { ACCESS_CONFIG: 'NOT_CHECKED', ACCESS_ENVIRONMENT: 'NOT_CHECKED', LEDGER_SPREADSHEET_ID: 'NOT_CHECKED', ACCESS_ADMIN_ACTORS: 'NOT_CHECKED' },
      credentials: { SWITCHBOT_TOKEN: 'NOT_CHECKED', SWITCHBOT_SECRET: 'NOT_CHECKED', WEBHOOK_SHARED_TOKEN: 'NOT_CHECKED' },
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
      var settingsOk = Object.keys(out.settings).every(function (k) { return out.settings[k] === 'SET'; });
      var credsOk = CREDENTIAL_NAMES.every(function (n) { return out.credentials[n] === 'SET'; });
      if (!settingsOk) fail('SETTINGS_INCOMPLETE');
      if (!credsOk) fail('CREDENTIALS_INCOMPLETE');

      out.environment = envRaw.state === 'SET' ? (envRaw.raw === ENVIRONMENT.PRODUCTION ? 'PRODUCTION' : 'NOT_PRODUCTION') : envRaw.state;
      if (out.environment !== 'PRODUCTION' && envRaw.state === 'SET') fail('ENV_NOT_PRODUCTION');

      var cfg = {};
      if (cfgRaw.state !== 'SET') out.config.state = cfgRaw.state;
      else {
        var parsed = safeParse(cfgRaw.raw);
        if (parsed === null && cfgRaw.raw !== 'null') out.config.state = 'PARSE_ERROR';
        else if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) out.config.state = 'NOT_OBJECT';
        else {
          cfg = parsed;
          out.config.envMatch = envRaw.state === 'SET' && cfg.environment === envRaw.raw ? 'MATCH' : 'MISMATCH';
          var v = validateConfig(out.config.envMatch === 'MATCH' ? cfg : Object.assign({}, cfg, { environment: '__MISMATCH__' }));
          out.config.state = v.ok && out.config.envMatch === 'MATCH' ? 'VALID' : 'INVALID';
          out.config.errors = v.errors.slice(0, 16);
        }
      }
      if (out.config.state !== 'VALID') fail(out.config.state === 'INVALID' ? 'CONFIG_INVALID' : 'CONFIG_' + out.config.state);

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
    ENVIRONMENT: ENVIRONMENT, PROPERTIES_LIMITS: PROPERTIES_LIMITS, DEFAULTS: DEFAULTS, CATALOG: CATALOG, FREEZE_REASONS: FREEZE_REASONS,
    validateConfig: validateConfig, ensureStoreEnvironment: ensureStoreEnvironment,
    constantTimeEquals: constantTimeEquals, authenticateWebhook: authenticateWebhook, authorizeAdmin: authorizeAdmin,
    CREDENTIAL_NAMES: CREDENTIAL_NAMES, validateCredentialInput: validateCredentialInput, setupCredentials: setupCredentials, credentialStatus: credentialStatus,
    BOOTSTRAP_KEYS: BOOTSTRAP_KEYS, accessFlagState: accessFlagState, migrateBootstrapCredentials: migrateBootstrapCredentials, bootstrapStatus: bootstrapStatus, scrubBootstrapCredentials: scrubBootstrapCredentials,
    readOnlyDiagnostics: readOnlyDiagnostics, testReadOnlyDiagnostics: testReadOnlyDiagnostics, testKeyStage: testKeyStage, testKeyStatus: testKeyStatus, idTypeDiag: idTypeDiag, idTypeDiagStatus: idTypeDiagStatus, TKS_MAX_CALLS: TKS_MAX_CALLS,
    numIdStage: numIdStage, numIdAppCheck: numIdAppCheck, numIdStatus: numIdStatus, NID_MAX_CALLS: NID_MAX_CALLS, NID_PLAN: NID_PLAN,
    minimizeWebhook: minimizeWebhook, openWebhookOps: openWebhookOps, correlateWebhook: correlateWebhook,
    createLockDomain: createLockDomain, keypadCapacityGate: keypadCapacityGate,
    byteLength: byteLength, measureStore: measureStore, storageGate: storageGate, estimateStorage: estimateStorage,
    garbageCollect: garbageCollect, planJobs: planJobs, createApiBudget: createApiBudget,
    classify: classify, renderNotification: renderNotification, createRuntime: createRuntime,
    deliverySettings: deliverySettings, renderCodeMail: renderCodeMail, notSentError: notSentError
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SwitchBotAccessInfra;
}
