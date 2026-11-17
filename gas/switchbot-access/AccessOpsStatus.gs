/**
 * 運営アプリ向け 予約別の鍵状態参照（読取り専用）— Issue #942。独立GAS（鍵管理）用。純粋ロジック。
 *
 * 目的: 運営アプリ（別GAS）が、予約IDを指定して「鍵の発行/登録確認/案内/失効」の記録を読むための入口。
 * 鍵・通知・設定・トリガー・ロックには一切触れない。状態ストアは get のみ（呼出元が set/del/keys を渡さない）。
 *
 * 認証前は状態ストアに触れない（本文サイズ → JSON → v → トークン形式 → ダイジェスト比較の順。通過後に初めて予約IDを検証し読取る）。
 * 認証・入力の失敗は、理由を区別できない固定の応答（NOT_AVAILABLE）に統一する（予約の存在・状態・設定の有無を漏らさない）。
 *
 * 返すのは許可リストの射影だけ（列挙値・整数）。OP/DLV/BKの生オブジェクト、PIN、passcodeId、commandId、完全deviceId、
 * 名前（keyName）、証跡、履歴、メール等は、コード上到達しない（記録内の文字列は返さない。要求した予約IDだけを返す）。
 *
 * 読取りの一貫性: ロックは取らない（鍵処理を待たせない）。BK→OP→DLV の生値を読んだ後に同じキーを再読し、
 * 1つでも変わっていれば1回だけ読み直す。それでも変わる場合は consistency=CHANGED_DURING_READ（運営側は要確認として扱う）。
 *
 * 8件上限: 1予約あたり読むOPは最新8件まで。BK索引（ops配列）の長さは正確に分かるため、8件を超える場合は
 * truncated=true と opCount（索引上の総数）を返す。読めなかった古いOPは分からないため、運営側は成功判定をしない。
 */
var AccessOpsStatus = (function () {
  'use strict';

  var MAX_BODY_CHARS = 2048;
  var MAX_REFS = 10;
  var MAX_OPS = 8;
  var MAX_RECID_CHARS = 100;
  var TOKEN_MIN = 32;
  var TOKEN_MAX = 128;
  var VERSION = 1;
  /** Booking.generateBookingId の形（接頭辞 SNB / MENS / SX / XX の2〜4文字＋利用日8桁＋uuid先頭8桁）。 */
  var BOOKING_ID_RE = /^[A-Z]{2,4}-[0-9]{8}-[0-9A-F]{8}$/;
  var RECID_RE = /^[A-Za-z0-9:_*#\-]+$/;
  var DIGEST_RE = /^[0-9a-f]{64}$/;

  var STATES = ['PLANNED', 'SENDING', 'SENT_WAIT_WEBHOOK', 'ACCEPTED_NO_COMMAND_ID', 'ISSUED_CONFIRMED', 'DELETE_PENDING',
    'DELETE_SENDING', 'DELETE_SENT', 'DELETED_CONFIRMED', 'ALREADY_ABSENT', 'EXPIRED', 'ARCHIVED_EXPIRED', 'FAILED', 'UNKNOWN', 'ABANDONED'];
  var KINDS = ['ISSUE', 'REVOKE'];
  var DELIVERY_STATES = ['SENDING', 'DELIVERED', 'NOT_SENT', 'UNKNOWN', 'SUPPRESSED'];
  /** 同じ改訂で「まだ生きている」とみなさない状態（重複判定から除く）。 */
  var NOT_LIVE = ['FAILED', 'ABANDONED', 'DELETED_CONFIRMED', 'ALREADY_ABSENT', 'ARCHIVED_EXPIRED'];
  var JOBS = ['SYNC', 'SWEEP', 'DELIVER', 'CLEANUP'];

  function reject_() { return { ok: false, code: 'NOT_AVAILABLE' }; }

  function parse_(raw) {
    if (typeof raw !== 'string' || raw === '') return null;
    try { var v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; }
  }

  function int_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v < 4102444800 ? v : null; }
  function revision_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v < 1000000 ? v : null; }
  function enum_(v, list) { return typeof v === 'string' && list.indexOf(v) !== -1 ? v : 'UNRECOGNIZED'; }

  function constantTimeEquals_(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  /**
   * 1回の読取り。戻り値: { item, snap }。snap は読んだキーと生値（再読して変化を検出する）。
   */
  function readOnce_(store, ref) {
    var snap = [];
    function get(k) { var v = store.get(k); snap.push([k, v === undefined ? null : v]); return v === undefined ? null : v; }
    var item = { ref: ref, record: 'NONE', truncated: false, opCount: 0, ops: [] };
    var bkRaw = get('BK_' + ref);
    if (bkRaw === null || bkRaw === '') return { item: item, snap: snap };
    var idx = parse_(bkRaw);
    if (!idx || idx.bookingId !== ref || !Array.isArray(idx.ops)) { item.record = 'INVALID_INDEX'; return { item: item, snap: snap }; }
    item.record = 'FOUND';
    item.opCount = idx.ops.length;
    var ids = idx.ops;
    if (ids.length > MAX_OPS) { item.truncated = true; ids = ids.slice(ids.length - MAX_OPS); } // 最新8件（索引は追加順）
    var seen = {};
    var invalid = false;
    var live = {};
    var ambiguous = false;
    ids.forEach(function (recId) {
      if (invalid) return;
      if (typeof recId !== 'string' || recId.length === 0 || recId.length > MAX_RECID_CHARS || !RECID_RE.test(recId)
          || recId.indexOf(ref + ':') !== 0 || seen[recId]) { invalid = true; return; }
      seen[recId] = true;
      var op = parse_(get('OP_' + recId));
      if (!op || op.bookingId !== ref) { invalid = true; return; }
      var kind = enum_(op.op, KINDS);
      var state = enum_(op.state, STATES);
      var rev = revision_(op.revision);
      var delivery = null;
      if (kind === 'ISSUE') {
        var dlvRaw = get('DLV_' + recId);
        if (dlvRaw !== null && dlvRaw !== '') {
          var dlv = parse_(dlvRaw);
          delivery = dlv ? enum_(dlv.state, DELIVERY_STATES) : 'UNRECOGNIZED';
        }
      }
      if (kind === 'ISSUE' && state !== 'UNRECOGNIZED' && NOT_LIVE.indexOf(state) === -1) {
        var lk = String(rev);
        if (live[lk]) ambiguous = true;
        live[lk] = true;
      }
      item.ops.push({ rev: rev, kind: kind, state: state, validFromSec: int_(op.startSec), validToSec: int_(op.endSec), updatedAtSec: int_(op.updatedAt), delivery: delivery });
    });
    if (invalid) { item.record = 'INVALID_INDEX'; item.ops = []; return { item: item, snap: snap }; }
    if (ambiguous) item.record = 'AMBIGUOUS';
    return { item: item, snap: snap };
  }

  function unchanged_(store, snap) {
    for (var i = 0; i < snap.length; i++) {
      var v = store.get(snap[i][0]);
      if ((v === undefined ? null : v) !== snap[i][1]) return false;
    }
    return true;
  }

  function readRef_(store, ref) {
    for (var attempt = 0; attempt < 2; attempt++) {
      var r = readOnce_(store, ref);
      if (unchanged_(store, r.snap)) return { item: r.item, stable: true };
      if (attempt === 1) return { item: r.item, stable: false };
    }
    return null; // 到達しない
  }

  function heartbeats_(store, nowSec) {
    var out = {};
    JOBS.forEach(function (job) {
      var hb = parse_(store.get('HB_' + job));
      var at = hb ? int_(hb.at) : null;
      out[job] = at === null || at > nowSec ? null : nowSec - at;
    });
    return out;
  }

  /**
   * raw: 本文（文字列）。deps: { store(get のみ), expectedDigest（小文字hex64。無ければ全拒否）, sha256Hex(s), nowSec() }。
   * 戻り値は常にプレーンなオブジェクト（失敗は { ok:false, code:'NOT_AVAILABLE' } のみ）。例外は投げない。
   */
  function handle(raw, deps) {
    try {
      if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_BODY_CHARS) return reject_();
      var body;
      try { body = JSON.parse(raw); } catch (e) { return reject_(); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reject_();
      var keys = Object.keys(body);
      for (var k = 0; k < keys.length; k++) if (['v', 'token', 'refs'].indexOf(keys[k]) === -1) return reject_();
      if (body.v !== VERSION) return reject_();
      var token = body.token;
      if (typeof token !== 'string' || token.length < TOKEN_MIN || token.length > TOKEN_MAX) return reject_();
      var expected = deps.expectedDigest;
      if (typeof expected !== 'string' || !DIGEST_RE.test(expected)) return reject_();
      if (!constantTimeEquals_(deps.sha256Hex(token), expected)) return reject_();
      // ここから認証済み。入力検証（不正は要求全体を固定拒否。部分応答しない）
      var refs = body.refs;
      if (!Array.isArray(refs) || refs.length === 0 || refs.length > MAX_REFS) return reject_();
      var uniq = [];
      for (var i = 0; i < refs.length; i++) {
        if (typeof refs[i] !== 'string' || refs[i].length > 24 || !BOOKING_ID_RE.test(refs[i])) return reject_();
        if (uniq.indexOf(refs[i]) === -1) uniq.push(refs[i]);
      }
      var nowSec = deps.nowSec();
      var stableAll = true;
      var items = uniq.map(function (ref) {
        var r = readRef_(deps.store, ref);
        if (!r.stable) stableAll = false;
        return r.item;
      });
      return { ok: true, v: VERSION, readAtSec: nowSec, consistency: stableAll ? 'STABLE' : 'CHANGED_DURING_READ', jobs: heartbeats_(deps.store, nowSec), items: items };
    } catch (err) {
      return reject_(); // 例外本文は保持しない
    }
  }

  return {
    handle: handle,
    MAX_BODY_CHARS: MAX_BODY_CHARS, MAX_REFS: MAX_REFS, MAX_OPS: MAX_OPS,
    BOOKING_ID_RE: BOOKING_ID_RE, STATES: STATES, DELIVERY_STATES: DELIVERY_STATES
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AccessOpsStatus;
