/*
 * OpsKeyFinal.gs — 個別鍵の「確認済みの最終状態」の判定・保存値の検証・管理者の保存処理（Issue #971 Phase 1）。
 *
 * 目的: Access GAS の操作履歴が回収された後も、予約ごとの「失効・不在を確認済み」「未発行を確認済み」を運営アプリで確認できるようにする。
 * 保存先は Bookings の末尾1列 accessKeyFinalStatus だけ。書き手はこの運営GASの、管理者が明示実行する保存処理だけ
 * （予約詳細の閲覧・key_status・一覧は読み取り専用のまま。画面を開くだけでは書かない）。Access GAS・Booking GAS は無変更。
 *
 * 保存値: `<CODE>@r<改訂番号>@h<16桁16進>`
 *   CODE … REVOKED_CONFIRMED（該当する鍵の失効・不在を記録で確認済み）／ NOT_ISSUED_CONFIRMED（発行されていないことを操作記録で確認済み）の2種類だけ。
 *   r    … 保存時点の予約の改訂番号。h … 保存時点の台帳内容（状態・ブランド・利用日時・確定/取消/失効日時）の指紋。
 *   PIN・端末ID・氏名等は含めない。**改訂番号と指紋が現在の台帳と一致しなければ表示しない**（改訂番号の増分に失敗した予約変更でも、
 *   状態・日時が変われば指紋で無効になる）。あくまで「保存時点の確認結果」で、SwitchBotの現在の状態を保証しない。
 *
 * 保存してよい条件は decide() に集約する。空欄・履歴なし・読取失敗・矛盾は何も保存せず「判別不可」のまま（推測しない）。
 * 通信・保存先は deps で注入する。UrlFetchApp / PropertiesService はこのファイルでは参照しない（GAS専用の薄いアダプターは OpsApi.gs）。
 */
'use strict';

var OpsKeyFinal = (function () {
  /* 鍵連携の対象ブランドの正本は gas/booking/shared/AccessKeySnapshot.gs の TARGET_BRANDS（テストで一致を固定）。
     ブランドは問い合わせ候補の絞込みにだけ使い、鍵の状態の根拠にはしない（根拠は Access の記録だけ）。 */
  var TARGET_BRANDS = ['snb', 'mens', 'studio_x'];
  var CODES = ['REVOKED_CONFIRMED', 'NOT_ISSUED_CONFIRMED'];
  var VALUE_RE = /^(REVOKED_CONFIRMED|NOT_ISSUED_CONFIRMED)@r(0|[1-9][0-9]{0,5})@h([0-9a-f]{16})$/;
  var FLAG_PROPERTY = 'OPS_KEY_FINAL_STATUS_WRITE';
  var COLUMN = 'accessKeyFinalStatus';
  var MAX_PER_RUN = 10;
  var MAX_OFFSET = 100; /* 再実行で届く範囲（候補は最大110件。超える分は件数として返すだけ） */
  var WINDOW_MS = 7 * 24 * 3600 * 1000; /* 終了/取消からこの期間内の予約だけを問い合わせる（Accessの既定保持3日より長め） */

  /* Access の操作の状態（OpsKeyStatus の語彙と同じ）。 */
  var GONE = ['DELETED_CONFIRMED', 'ALREADY_ABSENT', 'ARCHIVED_EXPIRED'];
  var FAILED = 'FAILED';

  var LABELS = {
    REVOKED_CONFIRMED: '失効・不在を確認済み',
    NOT_ISSUED_CONFIRMED: '未発行を確認済み（発行失敗の記録のみ）'
  };

  /* ---------------- 値 ---------------- */

  /* 32bit FNV-1a。暗号用途ではなく、台帳内容の変化を検知するための指紋（二つの初期値で16桁にする）。 */
  function fnv_(text, basis) {
    var h = basis >>> 0;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function part_(v) { return v === null || v === undefined ? '' : String(v); }

  /* 台帳（正規化済みの予約）の指紋。予約ID・状態・ブランド・利用日時・確定/取消/失効日時だけ。個人情報は含めない。
     予約IDを入力に含めるのは、同じ改訂番号・同じ属性の別予約へ保存値が転記・行ずれで入っても、有効と認識しないため（予約ID自体は保存しない）。 */
  function fingerprint(rec) {
    var text = ['v1', rec.bookingId, rec.status, rec.brandRaw, rec.startMs, rec.endMs, rec.confirmedAt, rec.cancelledAt, rec.expiredAt].map(part_).join('|');
    return fnv_(text, 0x811c9dc5) + fnv_(text, 0x1b873593);
  }

  function encode(code, revision, rec) {
    if (CODES.indexOf(code) === -1 || !(typeof revision === 'number' && Math.floor(revision) === revision && revision >= 0 && revision <= 999999)) return null;
    return code + '@r' + revision + '@h' + fingerprint(rec);
  }

  /* 保存値の解析。形式が違うものは null（推測しない）。 */
  function parse(raw) {
    var m = typeof raw === 'string' ? VALUE_RE.exec(raw.trim()) : null;
    return m ? { code: m[1], revision: Number(m[2]), fingerprint: m[3] } : null;
  }

  /* 保存値が現在の台帳に対して有効か（改訂番号と指紋の両方が一致）。 */
  function validFor(rec, stored) {
    return !!stored && rec.revision !== null && stored.revision === rec.revision && stored.fingerprint === fingerprint(rec);
  }

  /* ---------------- 台帳側の終端判定 ---------------- */

  function modeOf_(rec, nowMs) {
    if (rec.status === 'CANCELLED' || rec.status === 'EXPIRED') return 'CANCELLED';
    if (rec.status === 'CONFIRMED' && rec.endMs !== null && rec.endMs <= nowMs) return 'ENDED';
    return null;
  }

  function timeValid_(rec) {
    return typeof rec.startMs === 'number' && typeof rec.endMs === 'number' && rec.endMs > rec.startMs;
  }

  /* ---------------- 保存の可否（保存してよい条件の集約） ---------------- */

  /*
   * rec: 正規化済みの予約。data: OpsKeyStatus.fetchAccess の data。
   * 戻り値: { save: 'REVOKED_CONFIRMED'|'NOT_ISSUED_CONFIRMED'|null, reason: 固定コード }
   * 保存しない既定: 条件を1つでも満たさなければ保存しない。Access NONE・取得失敗・不一致・要確認・期限経過のみを根拠にした保存はしない。
   */
  function decide(rec, data, nowMs) {
    function no(reason) { return { save: null, reason: reason }; }
    if (!rec || TARGET_BRANDS.indexOf(rec.brandRaw) === -1) return no('BRAND_NOT_TARGET');
    if (rec.revision === null) return no('LEDGER_REVISION_UNAVAILABLE');
    if (!timeValid_(rec)) return no('LEDGER_TIME_INVALID');
    var mode = modeOf_(rec, nowMs);
    if (!mode) return no('NOT_TERMINAL');
    if (!data || !data.item) return no('NO_ACCESS_DATA');
    if (data.consistency !== 'STABLE') return no('CHANGED_DURING_READ');
    var item = data.item;
    if (item.record !== 'FOUND') return no(item.record === 'NONE' ? 'NO_RECORD' : 'RECORD_NOT_USABLE');
    if (item.truncated) return no('OP_HISTORY_TRUNCATED');
    var ops = item.ops;
    if (!Array.isArray(ops) || !ops.length || ops.length !== item.opCount) return no('OP_HISTORY_INCOMPLETE');
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      if (o.kind !== 'ISSUE' || o.rev === null || o.state === 'UNRECOGNIZED') return no('UNRECOGNIZED_RECORD');
      /* 発行中・残存鍵・削除未確認・UNKNOWN・ABANDONED・期限切れ（失効の確認前）はすべて対象外。 */
      if (GONE.indexOf(o.state) === -1 && o.state !== FAILED) return no('OP_NOT_SETTLED');
    }
    /* 既存の照合（OpsKeyStatus.evaluate）の判定が、保存しようとするコードと一致することを必要条件にする。
       MISMATCH / NEEDS_REVIEW（例: 案内状態が認識できない記録）等の「要確認」を確定結果として永続保存しない。 */
    function agrees_(code) {
      var v;
      try { v = OpsKeyStatus.evaluate(rec, data, nowMs).verdict.code; } catch (e) { return false; }
      return v === code;
    }
    if (mode === 'CANCELLED') {
      if (ops.every(function (o) { return o.state === FAILED; })) return agrees_('NOT_ISSUED_CONFIRMED') ? { save: 'NOT_ISSUED_CONFIRMED', reason: 'ALL_ISSUES_FAILED' } : no('VERDICT_MISMATCH');
      return agrees_('REVOKED_CONFIRMED') ? { save: 'REVOKED_CONFIRMED', reason: 'CANCELLED_ALL_SETTLED' } : no('VERDICT_MISMATCH');
    }
    /* 利用終了した確定予約: 現在の改訂の記録があり、全件の失効・不在を確認でき、鍵の有効期限（猶予込み）も終了していること。
       Bookings の endAt の経過だけでは保存しない。 */
    if (!ops.some(function (o) { return o.rev === rec.revision; })) return no('REVISION_NOT_COVERED');
    if (ops.some(function (o) { return GONE.indexOf(o.state) === -1; })) return no('ENDED_NOT_ALL_REVOKED');
    if (ops.some(function (o) { return o.validToSec === null || o.validToSec * 1000 > nowMs; })) return no('KEY_VALIDITY_NOT_ENDED');
    return agrees_('REVOKED_CONFIRMED') ? { save: 'REVOKED_CONFIRMED', reason: 'ENDED_ALL_REVOKED' } : no('VERDICT_MISMATCH');
  }

  /* ---------------- 表示（key_status の補助） ---------------- */

  /*
   * Access が正常に NONE（接続成功・STABLE・記録なし）を返し、保存値が現在の台帳と一致し、台帳が終端のときだけ返す。
   * 取得失敗・認可エラー・矛盾・読取中の更新・Access に実記録がある場合は null（Accessの現行記録を優先し、保存値で隠さない）。
   */
  function display(rec, data, nowMs) {
    if (!rec || !data || !data.item || data.consistency !== 'STABLE' || data.item.record !== 'NONE') return null;
    var fin = rec.keyFinalStatus;
    if (!fin || fin.columnPresent !== true) return null;
    var stored = parse(fin.raw);
    if (!stored || !validFor(rec, stored) || !modeOf_(rec, nowMs)) return null;
    return { code: stored.code, label: LABELS[stored.code], source: 'BOOKINGS_SAVED' };
  }

  /* ---------------- 予約直後の表示（保存列は使わない・永続状態なし） ---------------- */

  var DAY_MS_ = 24 * 3600 * 1000;
  var JST_OFFSET_MS_ = 9 * 3600 * 1000;
  var ISSUE_START_BEFORE_DAY_MS_ = 12 * 3600 * 1000; /* 利用日の前日12:00 JST に発行開始（AccessKeySnapshot の issueWindow と同じ） */
  var SCHEDULE_VIEWS = {
    PENDING_NOT_TARGET: { label: '発行対象外（予約未確定）', tone: 'info', note: '予約が未確定のため、鍵の発行対象ではありません。現在の予約状態による説明で、過去の実鍵の不在を保証するものではありません。' },
    BEFORE_ISSUE: { label: '発行開始前', tone: 'info', note: '利用日の前日12:00（JST）に発行を開始する予定です。発行予定時刻に基づく表示で、SwitchBotの実鍵が無いことを確認した結果ではありません。' },
    AWAITING_ISSUE: { label: '発行記録なし（確認待ち）', tone: 'warn', note: '発行開始時刻を過ぎていますが、鍵管理側に操作記録がありません。未発行とは断定していません。しばらくして再取得してください。' }
  };

  function issueStartMs_(rec) {
    var day0 = typeof rec.date === 'string' ? OpsContract.parseJstDate(rec.date) : null;
    if (day0 === null) day0 = Math.floor((rec.startMs + JST_OFFSET_MS_) / DAY_MS_) * DAY_MS_ - JST_OFFSET_MS_;
    return day0 - DAY_MS_ + ISSUE_START_BEFORE_DAY_MS_;
  }

  /*
   * 鍵管理(Access)が正常に NONE（接続成功・STABLE・記録なし）で、有効な保存結果もないときだけ、予約の状態・発行予定時刻に基づく説明を返す。
   * Accessに実記録がある・取得失敗・読取中の更新・矛盾のときは null（予定による表示で覆い隠さない）。
   * 取消・失効・利用終了後・時刻が不正なものは null（判別不可のまま。NONE だけで未発行と断定しない）。
   * 戻り値は「発行開始前」等であり、保存対象の NOT_ISSUED_CONFIRMED（実記録で確認済み）とは別のコード・別の表示。
   */
  function scheduleView(rec, data, nowMs) {
    if (!rec || !data || !data.item || data.consistency !== 'STABLE' || data.item.record !== 'NONE') return null;
    var code = null;
    if (rec.status === 'PENDING') {
      code = 'PENDING_NOT_TARGET';
    } else if (rec.status === 'CONFIRMED' && timeValid_(rec) && nowMs < rec.endMs) {
      code = nowMs < issueStartMs_(rec) ? 'BEFORE_ISSUE' : 'AWAITING_ISSUE';
    }
    if (!code) return null;
    var v = SCHEDULE_VIEWS[code];
    return { code: code, label: v.label, tone: v.tone, note: v.note, source: 'SCHEDULE' };
  }

  /* ---------------- 管理者の保存処理 ---------------- */

  function terminalMs_(rec, mode) {
    if (mode === 'ENDED') return rec.endMs;
    var t = Date.parse(rec.cancelledAt || rec.expiredAt || '');
    return isNaN(t) ? rec.endMs : t;
  }

  function bump_(map, key) { map[key] = (map[key] || 0) + 1; }

  function recordsOf_(deps) {
    var read = deps.readLedger();
    if (!read || read.notConnected) return { code: 'LEDGER_NOT_CONNECTED' };
    var n = OpsNormalizer.normalize(read.values);
    if (n.schemaError) return { code: 'LEDGER_SCHEMA_INVALID' };
    return { normalized: n };
  }

  /*
   * deps: { authenticate, getFlag(), accessConfig(), readLedger(), store, fetchAccess(cfg, id), withLock(fn), nowMs }
   * store: { write({ rowNumber, bookingId, value }) } — 失敗は例外（本文を保持しない固定コード）。
   * 戻り値は件数と固定コードだけ（予約ID・値・行番号を返さない・ログに出さない）。
   * 1回の実行で問い合わせるのは最大 MAX_PER_RUN 件（新しい終端の予約から順。deps.offset で後続の候補へ進める）。自動トリガーはない。
   */
  function run(deps) {
    var auth = deps.authenticate();
    if (!auth || auth.ok !== true) return { ok: false, code: auth && auth.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAUTHENTICATED' };
    if (deps.getFlag() !== 'ON') return { ok: false, code: 'WRITE_DISABLED' };
    var cfg;
    try { cfg = deps.accessConfig(); } catch (e0) { cfg = undefined; }
    if (cfg === undefined) return { ok: false, code: 'ACCESS_CONFIG_INVALID' };
    if (!cfg) return { ok: false, code: 'ACCESS_NOT_CONNECTED' };
    /* 取りこぼし防止（状態を持たない）: 保存できない候補が先頭を占めても、offset を進めて再実行すれば後続の候補へ届く。 */
    var offset = deps.offset === undefined ? 0 : deps.offset;
    if (!(typeof offset === 'number' && Math.floor(offset) === offset && offset >= 0 && offset <= MAX_OFFSET && offset % MAX_PER_RUN === 0)) return { ok: false, code: 'OFFSET_INVALID' };
    var locked = deps.withLock(function () { return doRun_(deps, cfg, offset); });
    return locked && locked.busy ? { ok: false, code: 'BUSY' } : locked;
  }

  function doRun_(deps, cfg, offset) {
    var nowMs = deps.nowMs;
    var first;
    try { first = recordsOf_(deps); } catch (e1) { return { ok: false, code: 'LEDGER_READ_FAILED' }; }
    if (first.code) return { ok: false, code: first.code };
    var n = first.normalized;
    if (n.records.some(function (r) { return !r.keyFinalStatus.columnPresent; })) return { ok: false, code: 'COLUMN_MISSING' };

    var dup = {};
    (n.duplicateIds || []).forEach(function (id) { dup[id] = true; });
    var skipped = {};
    var candidates = [];
    n.records.forEach(function (rec) {
      if (dup[rec.bookingId] || !OpsKeyStatus.BOOKING_ID_RE.test(rec.bookingId)) return;
      if (TARGET_BRANDS.indexOf(rec.brandRaw) === -1 || rec.revision === null) return;
      var mode = modeOf_(rec, nowMs);
      if (!mode || !timeValid_(rec)) return;
      var t = terminalMs_(rec, mode);
      if (!(nowMs - t <= WINDOW_MS)) return;
      if (validFor(rec, parse(rec.keyFinalStatus.raw))) { bump_(skipped, 'ALREADY_SAVED'); return; }
      candidates.push({ rec: rec, t: t });
    });
    candidates.sort(function (a, b) { return b.t - a.t; });
    var batch = candidates.slice(offset, offset + MAX_PER_RUN);
    var summary = { ok: true, code: 'DONE', candidates: candidates.length, offset: offset, processed: 0, saved: 0, deferred: Math.max(0, candidates.length - offset - batch.length), skipped: skipped, stoppedBy: null };

    for (var i = 0; i < batch.length; i++) {
      var rec = batch[i].rec;
      var got = deps.fetchAccess(cfg, rec.bookingId);
      if (!got || got.ok !== true) { summary.stoppedBy = got && got.reason ? got.reason : 'ACCESS_FETCH_FAILED'; break; }
      summary.processed += 1;
      var d = decide(rec, got.data, nowMs);
      if (!d.save) { bump_(skipped, d.reason); continue; }

      /* 保存直前に台帳を再読込し、予約ID・状態・改訂番号・指紋が同じで、重複・途中変更がないことを確認する。 */
      var again;
      try { again = recordsOf_(deps); } catch (e2) { summary.stoppedBy = 'LEDGER_READ_FAILED'; break; }
      if (again.code) { summary.stoppedBy = again.code; break; }
      var same = again.normalized.records.filter(function (r) { return r.bookingId === rec.bookingId; });
      var isDup = (again.normalized.duplicateIds || []).indexOf(rec.bookingId) !== -1;
      var cur = same.length === 1 ? same[0] : null;
      if (!cur || isDup || cur.revision !== rec.revision || fingerprint(cur) !== fingerprint(rec) || !modeOf_(cur, nowMs)) { bump_(skipped, 'LEDGER_CHANGED'); continue; }
      var existing = parse(cur.keyFinalStatus.raw);
      if (validFor(cur, existing)) { bump_(skipped, existing.code === d.save ? 'ALREADY_SAVED' : 'SAVED_VALUE_CONFLICT'); continue; }
      var value = encode(d.save, cur.revision, cur);
      try {
        deps.store.write({ rowNumber: cur.rowNumber, bookingId: cur.bookingId, value: value });
        summary.saved += 1;
      } catch (e3) {
        summary.stoppedBy = e3 && typeof e3.opsReason === 'string' && /^[A-Z_\/0-9]{1,60}$/.test(e3.opsReason) ? e3.opsReason : 'WRITE_FAILED';
        break;
      }
    }
    return summary;
  }

  return {
    TARGET_BRANDS: TARGET_BRANDS, CODES: CODES, COLUMN: COLUMN, FLAG_PROPERTY: FLAG_PROPERTY, MAX_PER_RUN: MAX_PER_RUN, LABELS: LABELS,
    fingerprint: fingerprint, encode: encode, parse: parse, validFor: validFor, decide: decide, display: display, scheduleView: scheduleView, run: run, MAX_OFFSET: MAX_OFFSET
  };
})();
