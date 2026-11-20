/*
 * OpsRevenueRecords.gs — SNBCイベント実績／現地払い受領の記録（Issue #995 PR-C）。業務ロジック（検証・競合・冪等）。
 * 通信方式・保存基盤に依存しない（保存は OpsRevenueStore.gs を deps で受ける）。認可は OpsApi.handle が済ませてから呼ぶ。
 *
 * 保存先: オーナー専用メモ保存先内の固定2タブだけ。予約台帳と Tasks タブへは書かない。
 *   SNBCEvents    eventId, eventDate, title, paidCount, receivedJpy, refundedJpy, directCostJpy, updatedAt, revision（1イベント1行）
 *   OnsiteReceipts bookingId, receivedJpy, refundedJpy, method, receivedOn, updatedAt, revision（bookingIdが主キー。1予約1行・金額は累計）
 * 個人名・連絡先・DM本文・Stripe IDは持たない。「受領0円の明示登録」と「レコード未作成」は別状態。
 *
 * request: { op: 'snbc_list' | 'snbc_save' | 'snbc_delete' | 'onsite_get' | 'onsite_save' | 'onsite_delete', ... }
 * deps:    { store, withLock, booking }  booking は onsite_get / onsite_save で OpsApi が予約台帳から解決した { code, ledgerReceipt }
 * 失敗を成功にしない: 書込み後は同じ行を読み直して照合する。二重送信は上書き（冪等）で、金額を再加算しない。
 */
'use strict';

var OpsRevenueRecords = (function () {
  var DEFS = {
    snbc: {
      headers: ['eventId', 'eventDate', 'title', 'paidCount', 'receivedJpy', 'refundedJpy', 'directCostJpy', 'updatedAt', 'revision'],
      key: 'eventId', keyPattern: /^E-[0-9a-z]{8,32}$/,
      content: ['eventDate', 'title', 'paidCount', 'receivedJpy', 'refundedJpy', 'directCostJpy']
    },
    onsite: {
      headers: ['bookingId', 'receivedJpy', 'refundedJpy', 'method', 'receivedOn', 'updatedAt', 'revision'],
      key: 'bookingId', keyPattern: /^[A-Za-z0-9_:.\-]{1,64}$/,
      content: ['receivedJpy', 'refundedJpy', 'method', 'receivedOn']
    }
  };
  var METHODS = { cash: '現金', paypay: 'PayPay', other: 'その他・混在' };
  var TITLE_MAX = 80;
  var MAX_YEN = 100000000;

  var FIELD_MESSAGES = {
    eventId: 'イベントIDの形式が不正です。',
    bookingId: '予約IDの形式が不正です。',
    eventDate: '開催日は実在する日付（YYYY-MM-DD）で、開催済み（今日を含む過去）の日付にしてください。',
    title: 'イベント名は必須です（' + TITLE_MAX + '文字以内。参加者情報は入れないでください）。',
    paidCount: '有料人数は0以上の整数（任意）です。',
    receivedJpy: '受領額は0以上の整数円で入力してください。',
    refundedJpy: '返金済額は0以上の整数円で、受領額以下にしてください。',
    directCostJpy: '直接経費は0以上の整数円（任意）です。',
    method: '方法は 現金／PayPay／その他・混在 から選んでください。',
    receivedOn: '受領確認日は実在する日付（YYYY-MM-DD）で、今日以前にしてください。',
    input: '入力が不正です。',
    expectedRevision: '版番号が不正です。',
    unknown: '許可されていない項目が含まれています。'
  };
  var MESSAGES = {
    BUSY: '他の保存が進行中です。少し待ってからもう一度お試しください（入力は残っています）。',
    CONFLICT: '別の端末・操作で先に更新されています。上書きはしていません。再読み込みして内容を確認してください。',
    NOT_FOUND: '該当する記録が見つかりません（削除済みの可能性があります）。',
    STORE_FAILED: '保存先との通信に失敗しました。保存できたか確認できていません。再読み込みして内容を確認してください。',
    TOO_MANY: '記録が上限に達しています。'
  };
  var BOOKING_MESSAGES = {
    NOT_FOUND: '該当する予約が台帳に見つかりません。',
    DUPLICATE_ID: '同じ予約IDの行が台帳に複数あるため記録できません。',
    NOT_ONSITE: 'この予約は現地払いではありません（カード決済は台帳の記録を使います）。'
  };

  function error_(code, message, extra) {
    var e = { code: code, message: message || MESSAGES[code] };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return { ok: false, error: e };
  }
  function invalid_(fields) {
    return error_('INVALID_PARAMS', (FIELD_MESSAGES[fields[0]] || FIELD_MESSAGES.input) + (fields.length > 1 ? '（ほか' + (fields.length - 1) + '項目）' : ''), { fields: fields });
  }
  function isObject_(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isYen_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 0 && v <= MAX_YEN; }
  function blank_(v) { return v === undefined || v === null || v === ''; }
  function validRevision_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 1; }
  function cell_(v) { return v === undefined || v === null ? '' : v; }
  function storeError_(reason) { var e = new Error('store'); e.opsCode = 'STORE_FAILED'; e.opsReason = reason; return e; }

  /* 日付は実在かつ「今日（JST）以前」だけ。将来の予算・見込みはここに保存しない。 */
  function pastDate_(text, todayJst) {
    return typeof text === 'string' && OpsContract.parseJstDate(text) !== null && text.trim() === text && text <= todayJst;
  }

  /* ---- 入力検証（サーバーが正本） ---- */
  function validate_(kind, input, todayJst, requireKey) {
    var def = DEFS[kind];
    if (!isObject_(input)) return { fields: ['input'] };
    var allowed = [def.key].concat(def.content);
    var fields = [];
    Object.keys(input).forEach(function (k) { if (allowed.indexOf(k) === -1) fields.push('unknown'); });
    var v = {};
    var key = typeof input[def.key] === 'string' ? input[def.key].trim() : '';
    if (requireKey && !def.keyPattern.test(key)) fields.push(def.key);
    v[def.key] = key;
    var received = input.receivedJpy, refunded = input.refundedJpy;
    if (!isYen_(received)) fields.push('receivedJpy');
    if (!isYen_(refunded) || (isYen_(received) && refunded > received)) fields.push('refundedJpy');
    v.receivedJpy = received; v.refundedJpy = refunded;
    if (kind === 'snbc') {
      v.eventDate = typeof input.eventDate === 'string' ? input.eventDate.trim() : '';
      if (!pastDate_(v.eventDate, todayJst)) fields.push('eventDate');
      var title = typeof input.title === 'string' ? input.title.trim() : '';
      if (!title || title.length > TITLE_MAX || /[\u0000-\u001f\u007f]/.test(title)) fields.push('title');
      v.title = title;
      ['paidCount', 'directCostJpy'].forEach(function (k) {
        if (blank_(input[k])) { v[k] = ''; return; }
        if (!isYen_(input[k]) || (k === 'paidCount' && input[k] > 9999)) { fields.push(k); return; }
        v[k] = input[k];
      });
    } else {
      v.method = typeof input.method === 'string' ? input.method : '';
      if (!Object.prototype.hasOwnProperty.call(METHODS, v.method)) fields.push('method');
      v.receivedOn = typeof input.receivedOn === 'string' ? input.receivedOn.trim() : '';
      if (!pastDate_(v.receivedOn, todayJst)) fields.push('receivedOn');
    }
    var uniq = fields.filter(function (f, i) { return fields.indexOf(f) === i; });
    return uniq.length ? { fields: uniq } : { value: v };
  }

  /* ---- 行 ⇔ オブジェクト。不正な行は null（集計に使わない）。 ---- */
  function fromRow_(kind, cells) {
    var def = DEFS[kind], r = {};
    def.headers.forEach(function (h, i) { r[h] = cell_(cells[i]); });
    if (typeof r[def.key] !== 'string' || !def.keyPattern.test(r[def.key])) return null;
    if (!isYen_(r.receivedJpy) || !isYen_(r.refundedJpy) || r.refundedJpy > r.receivedJpy) return null;
    if (typeof r.updatedAt !== 'string' || r.updatedAt === '' || !validRevision_(r.revision)) return null;
    if (kind === 'snbc') {
      if (typeof r.eventDate !== 'string' || OpsContract.parseJstDate(r.eventDate) === null) return null;
      if (typeof r.title !== 'string' || r.title.trim() === '') return null;
      if (r.paidCount !== '' && !isYen_(r.paidCount)) return null;
      if (r.directCostJpy !== '' && !isYen_(r.directCostJpy)) return null;
    } else {
      if (!Object.prototype.hasOwnProperty.call(METHODS, r.method)) return null;
      if (typeof r.receivedOn !== 'string' || OpsContract.parseJstDate(r.receivedOn) === null) return null;
    }
    return r;
  }
  function toRow_(kind, r) { return DEFS[kind].headers.map(function (h) { return cell_(r[h]); }); }
  function sameContent_(kind, a, b) {
    return DEFS[kind].content.every(function (k) { return String(cell_(a[k])) === String(cell_(b[k])); });
  }

  /* ヘッダー不一致・主キー重複は fail-closed（どれが正か判断しない）。不正な行は件数だけ数えて除外。 */
  function read_(kind, store) {
    var def = DEFS[kind];
    var raw = store.readAll(kind);
    var header = (raw.header || []).map(function (h) { return String(h).trim(); });
    if (header.join('|') !== def.headers.join('|')) throw storeError_('SCHEMA');
    var rows = [], seen = {}, skipped = 0;
    (raw.rows || []).forEach(function (cells, i) {
      if (!cells || !cells.some(function (c) { return String(cell_(c)) !== ''; })) return;
      var rec = fromRow_(kind, cells);
      if (!rec) { skipped++; return; }
      if (seen[rec[def.key]]) throw storeError_('DUPLICATE_KEY');
      seen[rec[def.key]] = true;
      rec.rowNumber = i + 2;
      rows.push(rec);
    });
    return { rows: rows, skipped: skipped };
  }

  var HINTS = [
    [/^NOT_CONFIGURED$/, '保存先が未設定です。サーバー設定 OPS_TASKS_SPREADSHEET_ID（既存のメモ保存先）を確認してください。'],
    [/^TARGET_IS_LEDGER$/, '保存先のIDが予約台帳と同じです。安全のため停止しました。'],
    [/^TARGET_INVALID$/, '保存先のIDの形式が不正です。URLではなくIDのみを設定してください。'],
    [/^SCHEMA$/, '保存先のタブ（SNBCEvents / OnsiteReceipts）の1行目が定義のヘッダーと一致しません。データは書き換えていません。手順書のヘッダーに合わせてください。'],
    [/^DUPLICATE_KEY$/, '保存先に同じIDの行が複数あります。どれが正か判断できないため停止しました。重複行を整理してください。'],
    [/_HTTP\/400/, 'Googleがリクエストを受け付けませんでした。タブ（SNBCEvents / OnsiteReceipts）が存在するか確認してください（原因は断定できません）。'],
    [/_HTTP\/403\/PROTECTED_RANGE$/, 'Googleが「保護された範囲への書込み」として拒否しました。タブの保護を確認してください。'],
    [/_HTTP\/403\/SCOPE_INSUFFICIENT$/, '権限（scope）不足です。所有者本人で専用URLを開き直し、再承認してください。'],
    [/_HTTP\/(401|403)/, 'Googleが保存先へのアクセスを受け付けませんでした（原因は断定できません）。実行アカウントが保存先を編集できるか確認してください。'],
    [/_HTTP\/404/, 'Googleが保存先ファイルを見つけられませんでした。IDを確認してください。'],
    [/_HTTP\/429/, 'Googleの利用回数制限の可能性があります。数分あけて1回だけ再試行してください。'],
    [/_(NETWORK|TOKEN|PARSE)$/, '通信またはGoogle認証で失敗しました（原因は断定できません）。再読み込みして内容を確認してください。']
  ];
  function failStore_(e) {
    var reason = e && typeof e.opsReason === 'string' && /^[A-Z0-9_\/]{1,48}$/.test(e.opsReason) ? e.opsReason : 'UNKNOWN';
    Logger.log('ops records: store failed ' + reason); /* 固定コードのみ。金額・予約ID・氏名は出さない */
    var extra = { reason: reason };
    for (var i = 0; i < HINTS.length; i++) if (HINTS[i][0].test(reason)) { extra.hint = HINTS[i][1]; break; }
    return error_('STORE_FAILED', MESSAGES.STORE_FAILED, extra);
  }
  function locked_(deps, fn) {
    var out;
    try { out = deps.withLock(fn); } catch (e) { return failStore_(e); }
    if (out && out.busy === true) return error_('BUSY');
    return out;
  }

  function toPublic_(kind, r) {
    var out = {};
    DEFS[kind].headers.forEach(function (h) { out[h] = r[h]; });
    out.net = r.receivedJpy - r.refundedJpy;
    if (kind === 'onsite') out.methodLabel = METHODS[r.method];
    return out;
  }

  /* ---- 一覧（SNBC）／1件取得（現地払い） ---- */
  function snbcList_(deps, nowMs) {
    var base = { ok: true, contractVersion: OpsContract.CONTRACT_VERSION, fetchedAt: OpsContract.toIso(nowMs), todayJst: OpsContract.formatJstDate(nowMs) };
    var state;
    try { state = deps.store.state(); } catch (e0) { return failStore_(e0); }
    if (!state.ready) return Object.assign(base, { storeReady: false, items: [], skippedRows: 0 });
    var read;
    try { read = read_('snbc', deps.store); } catch (e) { return failStore_(e); }
    var items = read.rows.map(function (r) { return toPublic_('snbc', r); }).sort(function (a, b) {
      if (a.eventDate !== b.eventDate) return a.eventDate < b.eventDate ? 1 : -1;
      return a.eventId < b.eventId ? -1 : 1;
    });
    return Object.assign(base, { storeReady: true, items: items, skippedRows: read.skipped });
  }

  function onsiteGet_(request, deps, nowMs) {
    var key = typeof request.bookingId === 'string' ? request.bookingId.trim() : '';
    if (!DEFS.onsite.keyPattern.test(key)) return invalid_(['bookingId']);
    var b = deps.booking || {};
    if (b.code && b.code !== 'OK') return error_(b.code === 'NOT_ONSITE' ? 'INVALID_PARAMS' : b.code, BOOKING_MESSAGES[b.code]);
    var base = { ok: true, contractVersion: OpsContract.CONTRACT_VERSION, fetchedAt: OpsContract.toIso(nowMs), todayJst: OpsContract.formatJstDate(nowMs), ledgerReceipt: !!b.ledgerReceipt, methods: Object.keys(METHODS).map(function (k) { return { value: k, label: METHODS[k] }; }) };
    var state;
    try { state = deps.store.state(); } catch (e0) { return failStore_(e0); }
    if (!state.ready) return Object.assign(base, { storeReady: false, record: null });
    var read;
    try { read = read_('onsite', deps.store); } catch (e) { return failStore_(e); }
    var found = null;
    read.rows.forEach(function (r) { if (r.bookingId === key) found = r; });
    return Object.assign(base, { storeReady: true, record: found ? toPublic_('onsite', found) : null });
  }

  /* ---- 保存（作成・訂正）。expectedRevision が無ければ作成（同じ主キーの再送は冪等）。 ---- */
  function save_(kind, request, deps, nowMs) {
    var def = DEFS[kind];
    var today = OpsContract.formatJstDate(nowMs);
    var expected = request.expectedRevision;
    var creating = expected === undefined || expected === null;
    if (!creating && !validRevision_(expected)) return invalid_(['expectedRevision']);
    var checked = validate_(kind, request.input, today, true);
    if (checked.fields) return invalid_(checked.fields);
    var input = checked.value;
    if (kind === 'onsite') {
      var b = deps.booking || {};
      if (b.code !== 'OK') return error_(b.code === 'NOT_ONSITE' ? 'INVALID_PARAMS' : (b.code || 'NOT_FOUND'), BOOKING_MESSAGES[b.code] || BOOKING_MESSAGES.NOT_FOUND);
      /* 台帳（feePaidAmount／paid）に受領記録がある予約は台帳を正本とし、手入力で重ねない（二重計上防止）。 */
      if (b.ledgerReceipt) return error_('INVALID_PARAMS', 'この予約は台帳に受領記録があります。台帳の記録を正本とするため、新規記録は保存できません（重複計上の防止）。', { fields: ['ledger'] });
    }
    return locked_(deps, function () {
      try {
        if (!deps.store.state().ready) throw storeError_('NOT_CONFIGURED');
        var read = read_(kind, deps.store);
        var existing = null;
        read.rows.forEach(function (r) { if (r[def.key] === input[def.key]) existing = r; });
        var now = OpsContract.toIso(nowMs);
        var saved;
        if (creating) {
          if (existing) {
            if (sameContent_(kind, existing, input)) return { ok: true, record: toPublic_(kind, existing), replayed: true };
            return error_('CONFLICT', MESSAGES.CONFLICT, { current: toPublic_(kind, existing) });
          }
          if (read.rows.length >= OpsRevenueStore.MAX_ROWS) return error_('TOO_MANY');
          saved = Object.assign({}, input, { updatedAt: now, revision: 1 });
          deps.store.append(kind, toRow_(kind, saved));
        } else {
          if (!existing) return error_('NOT_FOUND');
          if (existing.revision !== expected) {
            if (existing.revision === expected + 1 && sameContent_(kind, existing, input)) return { ok: true, record: toPublic_(kind, existing), replayed: true };
            return error_('CONFLICT', MESSAGES.CONFLICT, { current: toPublic_(kind, existing) });
          }
          if (sameContent_(kind, existing, input)) return { ok: true, record: toPublic_(kind, existing), unchanged: true };
          saved = Object.assign({}, input, { updatedAt: now, revision: existing.revision + 1 });
          deps.store.updateRow(kind, existing.rowNumber, toRow_(kind, saved));
        }
        /* 同じ行を読み直して照合する。一致しなければ成功と言わない。 */
        var verify = null;
        read_(kind, deps.store).rows.forEach(function (r) { if (r[def.key] === saved[def.key]) verify = r; });
        if (!verify || verify.revision !== saved.revision || !sameContent_(kind, verify, saved)) throw storeError_('VERIFY');
        return { ok: true, record: toPublic_(kind, verify) };
      } catch (e) {
        return failStore_(e);
      }
    });
  }

  /* ---- 削除（確認は画面側。対象の1行だけ）。 ---- */
  function delete_(kind, request, deps) {
    var def = DEFS[kind];
    var key = typeof request[def.key] === 'string' ? request[def.key].trim() : '';
    if (!def.keyPattern.test(key)) return invalid_([def.key]);
    if (!validRevision_(request.expectedRevision)) return invalid_(['expectedRevision']);
    return locked_(deps, function () {
      try {
        if (!deps.store.state().ready) return { ok: true, deleted: false, alreadyDeleted: true };
        var existing = null;
        read_(kind, deps.store).rows.forEach(function (r) { if (r[def.key] === key) existing = r; });
        if (!existing) return { ok: true, deleted: false, alreadyDeleted: true };
        if (existing.revision !== request.expectedRevision) return error_('CONFLICT', MESSAGES.CONFLICT, { current: toPublic_(kind, existing) });
        deps.store.removeRow(kind, existing.rowNumber);
        var still = false;
        read_(kind, deps.store).rows.forEach(function (r) { if (r[def.key] === key) still = true; });
        if (still) throw storeError_('VERIFY');
        return { ok: true, deleted: true };
      } catch (e) {
        return failStore_(e);
      }
    });
  }

  /*
   * 売上集計用の読み取り（読み取りのみ）。未設定は not_connected、シート欠落・ヘッダー不一致・重複・読取失敗は error（0円として足さない）。
   * 戻り値: { snbc: { state, rows, skipped }, onsite: { state, rows, skipped } }
   */
  function readForRevenue(deps) {
    var ready;
    try { ready = deps.store.state().ready; } catch (e) { return { snbc: { state: 'error' }, onsite: { state: 'error' } }; }
    if (!ready) return { snbc: { state: 'not_connected' }, onsite: { state: 'not_connected' } };
    function one(kind) {
      try { var r = read_(kind, deps.store); return { state: 'ready', rows: r.rows, skipped: r.skipped }; }
      catch (e) { Logger.log('ops records: revenue read failed ' + kind + ' ' + (e && /^[A-Z0-9_\/]{1,48}$/.test(e.opsReason) ? e.opsReason : 'UNKNOWN')); return { state: 'error' }; }
    }
    return { snbc: one('snbc'), onsite: one('onsite') };
  }

  function handle(request, deps, nowMs) {
    switch (request.op) {
      case 'snbc_list': return snbcList_(deps, nowMs);
      case 'snbc_save': return save_('snbc', request, deps, nowMs);
      case 'snbc_delete': return delete_('snbc', request, deps);
      case 'onsite_get': return onsiteGet_(request, deps, nowMs);
      case 'onsite_save': return save_('onsite', request, deps, nowMs);
      case 'onsite_delete': return delete_('onsite', request, deps);
      default: return error_('INVALID_PARAMS', '要求の種類が不正です。');
    }
  }

  return { handle: handle, readForRevenue: readForRevenue, DEFS: DEFS, METHODS: METHODS };
})();
