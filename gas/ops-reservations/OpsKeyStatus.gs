/*
 * OpsKeyStatus.gs — 予約ごとの鍵発行・案内状況の取得と照合（Issue #942）。読み取り専用。
 *
 * 既存のAccess GASの「状態参照」（AccessOpsStatus。認証付きPOST）を、運営GASのサーバー内から呼ぶ。
 * 鍵の発行/更新/削除/解錠・メール送信・トリガーの操作は持たない。ブラウザーには共有トークン・接続先URLを渡さない
 * （画面へ返すのは下の evaluate の射影だけ）。
 *
 * 「記録が取れない」「確認不能」「不一致」「要確認」を互いに別の状態にし、取れない・矛盾するものを鍵の成功と断定しない。
 * ジョブの稼働（jobs）は予約別の鍵の成功ではないため、別枠として返す。
 */
'use strict';

var OpsKeyStatus = (function () {
  var BOOKING_ID_RE = /^[A-Z]{2,4}-[0-9]{8}-[0-9A-F]{8}$/;
  /* 送信先は Apps Script のWebアプリURLに限定する（トークンを別ホストへ送らない）。 */
  var URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[A-Za-z0-9.-]+\/|macros\/)s\/[A-Za-z0-9_-]+\/exec$/;
  /* POSTのリダイレクト先は Google のコンテンツ配信ホストだけ（本文・トークンは再送せず、GETで結果だけ読む）。 */
  var REDIRECT_RE = /^https:\/\/script\.googleusercontent\.com\//;
  var MAX_RESPONSE_CHARS = 65536;
  var MAX_OPS = 8;
  var TOKEN_MIN = 32;

  var STATES = ['PLANNED', 'SENDING', 'SENT_WAIT_WEBHOOK', 'ACCEPTED_NO_COMMAND_ID', 'ISSUED_CONFIRMED', 'DELETE_PENDING', 'DELETE_SENDING',
    'DELETE_SENT', 'DELETED_CONFIRMED', 'ALREADY_ABSENT', 'EXPIRED', 'ARCHIVED_EXPIRED', 'FAILED', 'UNKNOWN', 'ABANDONED', 'UNRECOGNIZED'];
  var KINDS = ['ISSUE', 'REVOKE', 'UNRECOGNIZED'];
  var DELIVERIES = ['SENDING', 'DELIVERED', 'NOT_SENT', 'UNKNOWN', 'SUPPRESSED', 'UNRECOGNIZED'];
  var RECORDS = ['NONE', 'FOUND', 'AMBIGUOUS', 'INVALID_INDEX'];
  var JOBS = ['SYNC', 'SWEEP', 'DELIVER', 'CLEANUP'];
  var JOB_LABELS = { SYNC: '予約と鍵の同期', SWEEP: '失効の確認', DELIVER: '案内メールの送信', CLEANUP: '日次の整理' };

  var IN_FLIGHT = ['PLANNED', 'SENDING', 'SENT_WAIT_WEBHOOK', 'ACCEPTED_NO_COMMAND_ID'];
  var REVOKING = ['DELETE_PENDING', 'DELETE_SENDING', 'DELETE_SENT', 'EXPIRED'];
  var GONE = ['DELETED_CONFIRMED', 'ALREADY_ABSENT', 'ARCHIVED_EXPIRED'];
  var NOT_ISSUED = ['FAILED', 'ABANDONED'];

  var STATE_LABELS = {
    PLANNED: '発行待ち（計画のみ）', SENDING: '発行の送信中', SENT_WAIT_WEBHOOK: '発行済み・登録確認待ち', ACCEPTED_NO_COMMAND_ID: '発行受理・登録確認待ち',
    ISSUED_CONFIRMED: '登録確認済み', DELETE_PENDING: '失効待ち', DELETE_SENDING: '失効の送信中', DELETE_SENT: '失効送信済み・確認待ち',
    DELETED_CONFIRMED: '失効確認済み', ALREADY_ABSENT: '失効確認済み（元から無し）', EXPIRED: '期限切れ・失効の確認待ち', ARCHIVED_EXPIRED: '期限切れ・整理済み',
    FAILED: '発行失敗', UNKNOWN: '反映の有無が不明', ABANDONED: '管理者が放棄', UNRECOGNIZED: '認識できない状態'
  };
  var KIND_LABELS = { ISSUE: '発行', REVOKE: '失効', UNRECOGNIZED: '認識できない操作' };
  var DELIVERY_LABELS = {
    SENDING: '送信呼出し中', DELIVERED: '案内済み（送信呼出し成功。利用者への到達は別）', NOT_SENT: '案内未送信', UNKNOWN: '送信の有無が不明',
    SUPPRESSED: '案内は停止済み', UNRECOGNIZED: '認識できない状態'
  };
  /* verdict: 画面の主表示。tone: ok / info / warn / ng。 */
  var VERDICTS = {
    NOT_CONNECTED: { label: '未接続（鍵状態は取得していません）', tone: 'info' },
    FETCH_FAILED: { label: '未取得（取得に失敗しました）', tone: 'ng' },
    UNVERIFIABLE: { label: '確認不能（記録を確認できません）', tone: 'warn' },
    NEEDS_REVIEW: { label: '要確認', tone: 'ng' },
    MISMATCH: { label: '不一致（予約と鍵の記録が食い違っています）', tone: 'ng' },
    ISSUE_PENDING: { label: '発行待ち（登録確認はまだです）', tone: 'warn' },
    ISSUE_UNCONFIRMED: { label: '登録未確認', tone: 'ng' },
    GUIDE_NOT_SENT: { label: '登録確認済み・案内未送信', tone: 'warn' },
    ISSUED_GUIDED: { label: '登録確認済み・案内済み', tone: 'ok' },
    ISSUED_GUIDE_UNKNOWN: { label: '登録確認済み・案内の記録なし（確認不能）', tone: 'warn' },
    REVOKE_UNCONFIRMED: { label: '失効未確認', tone: 'warn' },
    REVOKED_CONFIRMED: { label: '失効確認済み', tone: 'ok' }
  };
  var REASON_TEXTS = {
    CONFIG_INVALID: '接続先の設定が不正です（URLの形式）。',
    NETWORK: '通信に失敗しました。',
    HTTP_STATUS: '鍵管理側が想定外のHTTP応答を返しました。',
    REDIRECT_REJECTED: '想定外のリダイレクトのため、取得を中止しました（トークンは再送していません）。',
    RESPONSE_INVALID: '鍵管理側の応答を解釈できませんでした。',
    NOT_AVAILABLE: '鍵管理側が要求を受け付けませんでした（認証の不一致・停止中・入力不正などを区別できません）。',
    UNSUPPORTED_ID: 'この予約IDの形式は鍵状態の照会に対応していないため、取得していません。',
    CHANGED_DURING_READ: '読取り中に記録が更新されました。少し待って再取得してください。',
    NO_RECORD: '鍵管理側に記録がありません（未観測・回収済み・対象外のいずれかで、区別できません）。「未発行」とは判断していません。',
    INVALID_INDEX: '鍵管理側の索引と操作記録が一致しません。',
    AMBIGUOUS: '同じ改訂に有効な発行記録が複数あります。',
    OP_HISTORY_TRUNCATED: '操作履歴が上限（8件）を超えており、古い記録を確認できません。見えている一部の記録から成功とは判断していません。',
    UNRECOGNIZED_RECORD: '認識できない状態・種別・改訂の記録があります。',
    LEDGER_REVISION_UNAVAILABLE: '予約台帳の改訂番号を読めないため、鍵の記録と対応づけできません。',
    LEDGER_STATUS_UNKNOWN: '予約台帳の状態を判別できません。',
    LEDGER_TIME_UNAVAILABLE: '予約の終了時刻が台帳で不明なため、有効時間との照合ができません。',
    VALIDITY_UNAVAILABLE: '鍵の有効時間の記録が読めないため、予約時間との照合ができません。',
    PENDING_WITH_KEY_RECORD: '仮予約なのに鍵の記録があります。',
    CANCELLED_KEY_REMAINS: '予約は取消・失効済みですが、鍵が有効・発行中の記録のままです。',
    REVISION_MISMATCH: '予約の現在の改訂に対応する鍵の記録がなく、古い改訂の記録だけがあります（変更・延長後の再発行が見えていません）。',
    OLD_REVISION_KEY_REMAINS: '古い改訂の鍵が有効・発行中のまま残っています。',
    NO_ISSUE_RECORD_FOR_CONFIRMED: '予約は確定ですが、発行の記録が見つかりません（未発行とは断定できません）。',
    MULTIPLE_CURRENT: '現在の改訂に有効な発行記録が複数あります。',
    ISSUE_FAILED: '現在の改訂の発行は失敗または放棄された記録のみです。',
    STATE_UNKNOWN: '鍵の反映の有無が断定できない状態です（自動再送はされません。管理者の確認が必要です）。',
    KEY_REVOKED_WHILE_CONFIRMED: '予約は有効ですが、鍵は失効済みの記録です。',
    KEY_BEING_REVOKED: '予約は有効ですが、鍵を失効する処理中の記録です。',
    ENDED_NOT_REVOKED: '利用終了後ですが、鍵の失効を確認できていません。',
    ISSUE_PENDING_AFTER_END: '利用終了後も発行が完了していない記録です。',
    WINDOW_NOT_COVERING: '鍵の有効時間が、予約の利用時間を覆っていません（変更・延長の反映漏れの可能性）。',
    GUIDE_STATE_UNCERTAIN: '案内メールの送信状態が確定していません。',
    ONLY_FAILED_RECORDS: '失敗・放棄の記録のみで、取消後の失効を確認できる記録はありません。',
    ISSUED_NO_GUIDE_RECORD: '案内の記録がありません（案内機能が未設定の可能性もあるため、未送信とは断定していません）。'
  };

  function reasons_(codes) { return codes.map(function (c) { return { code: c, text: REASON_TEXTS[c] || c }; }); }

  function result_(verdictCode, reasonCodes, extra) {
    var v = VERDICTS[verdictCode];
    var out = { verdict: { code: verdictCode, label: v.label, tone: v.tone }, reasons: reasons_(reasonCodes || []) };
    Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  /* ---------------- 取得（運営GAS → Access GAS） ---------------- */

  function failure_(reason) { return { ok: false, reason: reason }; }

  function header_(res, name) {
    var h = typeof res.getHeaders === 'function' ? res.getHeaders() : null;
    if (!h || typeof h !== 'object') return null;
    var keys = Object.keys(h);
    for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === name) return typeof h[keys[i]] === 'string' ? h[keys[i]] : null;
    return null;
  }

  function readJson_(res) {
    var text = String(res.getContentText());
    if (text.length > MAX_RESPONSE_CHARS) return null;
    try { var v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch (e) { return null; }
  }

  function intOrNull_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 ? v : null; }

  /* 応答を許可リストの形へ検証・複写する（想定外の項目は捨てる。形が違えば RESPONSE_INVALID）。 */
  function validate_(body, ref) {
    if (!body) return null;
    if (body.ok === false) return { notAvailable: true };
    if (body.ok !== true || body.v !== 1 || !Array.isArray(body.items) || body.items.length !== 1) return null;
    if (body.consistency !== 'STABLE' && body.consistency !== 'CHANGED_DURING_READ') return null;
    var it = body.items[0];
    if (!it || it.ref !== ref || RECORDS.indexOf(it.record) === -1 || typeof it.truncated !== 'boolean' || intOrNull_(it.opCount) === null || !Array.isArray(it.ops) || it.ops.length > MAX_OPS) return null;
    var ops = [];
    for (var i = 0; i < it.ops.length; i++) {
      var o = it.ops[i];
      if (!o || KINDS.indexOf(o.kind) === -1 || STATES.indexOf(o.state) === -1) return null;
      if (o.delivery !== null && DELIVERIES.indexOf(o.delivery) === -1) return null;
      ops.push({ rev: intOrNull_(o.rev), kind: o.kind, state: o.state, validFromSec: intOrNull_(o.validFromSec), validToSec: intOrNull_(o.validToSec),
        updatedAtSec: intOrNull_(o.updatedAtSec), delivery: o.delivery === undefined ? null : o.delivery });
    }
    var jobs = {};
    JOBS.forEach(function (j) { jobs[j] = body.jobs && typeof body.jobs === 'object' ? intOrNull_(body.jobs[j]) : null; });
    return { consistency: body.consistency, readAtSec: intOrNull_(body.readAtSec), jobs: jobs, item: { record: it.record, truncated: it.truncated, opCount: it.opCount, ops: ops } };
  }

  /*
   * deps: { url, token, fetch(url, options) }。トークンは本文だけに入れ、クエリ・ヘッダー・ログ・戻り値には出さない。
   * リダイレクトは自動追従しない（followRedirects:false）。302/303で、場所が Google のコンテンツ配信ホストのときだけ、
   * 本文なしのGETで結果を読む（トークンは再送しない）。それ以外のリダイレクトは REDIRECT_REJECTED。
   * 戻り値: { ok:true, data } | { ok:false, reason }（reason は固定コード）。例外本文は保持しない。
   */
  function fetchAccess(deps, ref) {
    if (typeof deps.url !== 'string' || !URL_RE.test(deps.url) || typeof deps.token !== 'string' || deps.token.length < TOKEN_MIN) return failure_('CONFIG_INVALID');
    var res;
    try {
      res = deps.fetch(deps.url + '?a=opsStatus', {
        method: 'post', contentType: 'text/plain', payload: JSON.stringify({ v: 1, token: deps.token, refs: [ref] }),
        muteHttpExceptions: true, followRedirects: false
      });
      var code = res.getResponseCode();
      if (code === 302 || code === 303) {
        var loc = header_(res, 'location');
        if (!loc || !REDIRECT_RE.test(loc)) return failure_('REDIRECT_REJECTED');
        res = deps.fetch(loc, { method: 'get', muteHttpExceptions: true, followRedirects: false });
        code = res.getResponseCode();
      }
      if (code !== 200) return failure_(code >= 300 && code < 400 ? 'REDIRECT_REJECTED' : 'HTTP_STATUS');
    } catch (e) {
      return failure_('NETWORK');
    }
    var parsed;
    try { parsed = validate_(readJson_(res), ref); } catch (e2) { parsed = null; }
    if (!parsed) return failure_('RESPONSE_INVALID');
    if (parsed.notAvailable) return failure_('NOT_AVAILABLE');
    return { ok: true, data: parsed };
  }

  /* ---------------- 照合 ---------------- */

  function sec2iso_(sec) { return sec === null ? null : OpsContract.toIso(sec * 1000); }

  function opView_(o, current) {
    return {
      rev: o.rev, current: current, kindLabel: KIND_LABELS[o.kind], stateLabel: STATE_LABELS[o.state],
      validFrom: sec2iso_(o.validFromSec), validTo: sec2iso_(o.validToSec), updatedAt: sec2iso_(o.updatedAtSec),
      deliveryLabel: o.kind === 'ISSUE' && o.delivery ? DELIVERY_LABELS[o.delivery] : (o.kind === 'ISSUE' ? '案内の記録なし' : null)
    };
  }

  function jobViews_(jobs) {
    return JOBS.map(function (j) { return { job: j, label: JOB_LABELS[j], ageMinutes: jobs[j] === null ? null : Math.floor(jobs[j] / 60) }; });
  }

  function has_(list, v) { return list.indexOf(v) !== -1; }

  /*
   * 台帳の予約（rec: status / startMs / endMs / revision）とAccessの記録（data: fetchAccess の data）を突き合わせる。
   * 取れる範囲だけを判定し、判定できない・矛盾する場合は要確認/確認不能/不一致にする（成功にしない）。
   */
  function evaluate(rec, data, nowMs) {
    var item = data.item;
    var current = function (o) { return o.kind === 'ISSUE' && rec.revision !== null && o.rev === rec.revision; };
    var base = {
      connection: 'CONNECTED', failure: null, consistency: data.consistency, opCount: item.opCount, truncated: item.truncated,
      ops: item.ops.slice().sort(function (a, b) { return (a.rev === null ? -1 : a.rev) - (b.rev === null ? -1 : b.rev) || (a.updatedAtSec || 0) - (b.updatedAtSec || 0); }),
      jobs: jobViews_(data.jobs), notes: []
    };
    function done(verdict, codes) {
      var out = result_(verdict, codes, base);
      out.ops = base.ops.map(function (o) { return opView_(o, current(o)); });
      return out;
    }
    if (data.consistency !== 'STABLE') return done('NEEDS_REVIEW', ['CHANGED_DURING_READ']);
    if (item.record === 'NONE') return done('UNVERIFIABLE', ['NO_RECORD']);
    if (item.record === 'INVALID_INDEX') return done('NEEDS_REVIEW', ['INVALID_INDEX']);
    var review = [];
    if (item.record === 'AMBIGUOUS') review.push('AMBIGUOUS');
    if (item.truncated) review.push('OP_HISTORY_TRUNCATED');
    if (item.ops.some(function (o) { return o.state === 'UNRECOGNIZED' || o.kind === 'UNRECOGNIZED' || o.rev === null || o.delivery === 'UNRECOGNIZED'; })) review.push('UNRECOGNIZED_RECORD');
    if (rec.revision === null) review.push('LEDGER_REVISION_UNAVAILABLE');
    if (rec.status === null) review.push('LEDGER_STATUS_UNKNOWN');
    if (review.length) return done('NEEDS_REVIEW', review);

    var issues = item.ops.filter(function (o) { return o.kind === 'ISSUE'; });
    var ended = rec.endMs !== null && nowMs >= rec.endMs;

    if (rec.status === 'PENDING') return done('NEEDS_REVIEW', ['PENDING_WITH_KEY_RECORD']);

    if (rec.status === 'CANCELLED' || rec.status === 'EXPIRED') {
      if (issues.some(function (o) { return o.state === 'ISSUED_CONFIRMED' || has_(IN_FLIGHT, o.state); })) return done('MISMATCH', ['CANCELLED_KEY_REMAINS']);
      if (issues.some(function (o) { return o.state === 'UNKNOWN'; })) return done('NEEDS_REVIEW', ['STATE_UNKNOWN']);
      if (issues.some(function (o) { return has_(REVOKING, o.state); })) return done('REVOKE_UNCONFIRMED', []);
      if (issues.some(function (o) { return has_(GONE, o.state); })) return done('REVOKED_CONFIRMED', []);
      return done('UNVERIFIABLE', ['ONLY_FAILED_RECORDS']);
    }

    /* 確定（CONFIRMED） */
    var cur = issues.filter(current);
    var older = issues.filter(function (o) { return !current(o); });
    if (!cur.length) return done(older.length ? 'MISMATCH' : 'NEEDS_REVIEW', [older.length ? 'REVISION_MISMATCH' : 'NO_ISSUE_RECORD_FOR_CONFIRMED']);
    if (older.some(function (o) { return o.state === 'ISSUED_CONFIRMED' || has_(IN_FLIGHT, o.state); })) return done('MISMATCH', ['OLD_REVISION_KEY_REMAINS']);
    var candidates = cur.filter(function (o) { return !has_(NOT_ISSUED, o.state); });
    if (!candidates.length) return done('ISSUE_UNCONFIRMED', ['ISSUE_FAILED']);
    var live = candidates.filter(function (o) { return !has_(GONE, o.state); });
    if (live.length > 1) return done('NEEDS_REVIEW', ['MULTIPLE_CURRENT']);
    if (!live.length) return ended ? done('REVOKED_CONFIRMED', []) : done('MISMATCH', ['KEY_REVOKED_WHILE_CONFIRMED']);
    var op = live[0];
    if (has_(IN_FLIGHT, op.state)) return ended ? done('NEEDS_REVIEW', ['ISSUE_PENDING_AFTER_END']) : done('ISSUE_PENDING', []);
    if (op.state === 'UNKNOWN') return done('ISSUE_UNCONFIRMED', ['STATE_UNKNOWN']);
    if (has_(REVOKING, op.state)) return ended ? done('REVOKE_UNCONFIRMED', []) : done('MISMATCH', ['KEY_BEING_REVOKED']);
    /* ISSUED_CONFIRMED */
    if (ended) return done('REVOKE_UNCONFIRMED', ['ENDED_NOT_REVOKED']);
    if (rec.endMs === null) return done('NEEDS_REVIEW', ['LEDGER_TIME_UNAVAILABLE']);
    if (op.validFromSec === null || op.validToSec === null) return done('NEEDS_REVIEW', ['VALIDITY_UNAVAILABLE']);
    if (op.validFromSec * 1000 > rec.startMs || op.validToSec * 1000 < rec.endMs) return done('MISMATCH', ['WINDOW_NOT_COVERING']);
    base.notes.push('鍵の有効時間が予約時間より長い分（猶予の設定）は、設定を安全に読めないため判定していません。');
    if (op.delivery === 'DELIVERED') return done('ISSUED_GUIDED', []);
    if (op.delivery === 'NOT_SENT') return done('GUIDE_NOT_SENT', []);
    if (op.delivery === null) return done('ISSUED_GUIDE_UNKNOWN', ['ISSUED_NO_GUIDE_RECORD']);
    return done('NEEDS_REVIEW', ['GUIDE_STATE_UNCERTAIN']);
  }

  /* 取得できなかった・接続していない場合の画面用の値（鍵の状態は何も主張しない）。 */
  function unavailable(verdictCode, reasonCode) {
    return result_(verdictCode, reasonCode ? [reasonCode] : [], { connection: verdictCode === 'NOT_CONNECTED' ? 'NOT_CONNECTED' : (verdictCode === 'FETCH_FAILED' ? 'FETCH_FAILED' : 'UNSUPPORTED'),
      failure: reasonCode && verdictCode === 'FETCH_FAILED' ? { code: reasonCode } : null, consistency: null, opCount: 0, truncated: false, ops: [], jobs: [], notes: [] });
  }

  return {
    BOOKING_ID_RE: BOOKING_ID_RE, URL_RE: URL_RE, VERDICTS: VERDICTS, REASON_TEXTS: REASON_TEXTS,
    fetchAccess: fetchAccess, evaluate: evaluate, unavailable: unavailable
  };
})();
