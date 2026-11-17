/*
 * OpsTasks.gs — 未対応メモと期限管理（Issue #941）。業務ロジック（検証・競合・保持）。通信方式・保存基盤に依存しない。
 *
 * 保存先は予約台帳とは別の「アプリ専用スプレッドシート」の Tasks 表だけ（OpsTasksStore.gs）。ここでは予約台帳を
 * 一切読まず・書かない（予約との結び付きは手入力の予約ID/サービスの文字列だけ。同期で手入力メモを上書きしない）。
 *
 * request: { op: 'tasks_list' } | { op: 'task_save', input, expectedRevision } | { op: 'task_delete', taskId, expectedRevision }
 * deps:    { store, withLock }   store は OpsTasksStore 形式、withLock(fn) は排他実行（取れなければ { busy: true }）
 * 戻り値:  { ok: true, ... } | { ok: false, error: { code, message[, current] } }
 *
 * 失敗を成功にしない: 書込み後は保存先を読み直して内容を照合し、一致しなければ STORE_FAILED（保存結果を確認できない）。
 * 二重送信: 作成は端末が採番した taskId を冪等キーにし、同じ内容の再送は「保存済み」として成功、別内容は CONFLICT。
 * 競合: 更新・削除は expectedRevision（読み込んだ版）が保存先と一致する場合だけ実行。不一致は上書きせず CONFLICT。
 * 履歴: 更新日時と版番号だけ持つ。全項目の変更前後履歴・監査表は作らない。
 * 保持: 完了から180日（最終更新日時基準）を過ぎた「完了」メモは一覧取得時に削除。未完了は自動削除しない（見直し表示のみ）。
 */
'use strict';

var OpsTasks = (function () {
  var HEADERS = ['taskId', 'title', 'bookingId', 'service', 'status', 'memo', 'dueDate', 'evidenceUrl', 'createdAt', 'updatedAt', 'revision'];
  var STATUSES = ['todo', 'doing', 'done'];
  var STATUS_LABELS = { todo: '未対応', doing: '対応中', done: '完了' };
  /* 端末から受け取る項目の許可リスト。これ以外のキー（保存先ID・範囲・版番号など）が来たら拒否する。 */
  var INPUT_KEYS = ['taskId', 'title', 'bookingId', 'service', 'status', 'memo', 'dueDate', 'evidenceUrl'];
  var CONTENT_KEYS = ['title', 'bookingId', 'service', 'status', 'memo', 'dueDate', 'evidenceUrl'];
  var LIMITS = { title: 80, bookingId: 64, memo: 500, evidenceUrl: 300 };
  var MAX_TASKS = 1000;
  var RETENTION_DAYS = 180;
  var DAY_MS = 24 * 60 * 60 * 1000;

  var FIELD_MESSAGES = {
    taskId: 'タスクIDの形式が不正です。',
    title: '件名は必須です（' + LIMITS.title + '文字以内）。',
    bookingId: '予約IDは英数字と - _ : . のみ・' + LIMITS.bookingId + '文字以内です。',
    service: 'サービスが不正です。',
    status: '状態が不正です。',
    memo: 'メモは' + LIMITS.memo + '文字以内です。',
    dueDate: '期限は実在する日付（YYYY-MM-DD）で指定してください。',
    evidenceUrl: '証跡リンクは https:// で始まるURL（' + LIMITS.evidenceUrl + '文字以内）にしてください。',
    input: '入力が不正です。',
    expectedRevision: '版番号が不正です。',
    unknown: '許可されていない項目が含まれています。'
  };

  var MESSAGES = {
    BUSY: '他の保存が進行中です。少し待ってからもう一度お試しください（入力は残っています）。',
    CONFLICT: '別の端末・操作で先に更新されています。上書きはしていません。',
    NOT_FOUND: '該当するメモが見つかりません（削除済みの可能性があります）。',
    STORE_FAILED: 'メモの保存先との通信に失敗しました。保存できたか確認できていません。再読み込みして内容を確認してください。',
    TOO_MANY: 'メモが上限（' + MAX_TASKS + '件）に達しています。完了済みを削除してから追加してください。'
  };

  function error_(code, message, extra) {
    var e = { code: code, message: message || MESSAGES[code] };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    return { ok: false, error: e };
  }

  function isObject_(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function str_(v) { return typeof v === 'string' ? v : ''; }
  function hasControl_(s, allowNewline) {
    return (allowNewline ? /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(s);
  }

  /* ---- 入力検証（サーバーが正本。画面側の検証は補助） ---- */
  function validate_(input, requireId) {
    if (!isObject_(input)) return { fields: ['input'] };
    var fields = [];
    Object.keys(input).forEach(function (k) { if (INPUT_KEYS.indexOf(k) === -1) fields.push('unknown'); });
    function text(key, max, required, allowNewline) {
      var raw = input[key];
      if (raw === undefined || raw === null) raw = '';
      if (typeof raw !== 'string') { fields.push(key); return ''; }
      var s = allowNewline ? raw.replace(/\r\n?/g, '\n').trim() : raw.trim();
      if ((required && s === '') || s.length > max || hasControl_(s, allowNewline)) { fields.push(key); return ''; }
      return s;
    }
    var v = {};
    v.taskId = str_(input.taskId).trim();
    if (requireId && !/^T-[0-9a-z]{8,32}$/.test(v.taskId)) fields.push('taskId');
    v.title = text('title', LIMITS.title, true, false);
    v.bookingId = text('bookingId', LIMITS.bookingId, false, false);
    if (v.bookingId && !/^[A-Za-z0-9_:.\-]+$/.test(v.bookingId)) fields.push('bookingId');
    v.service = text('service', 32, false, false);
    if (v.service && !OpsContract.serviceById(v.service)) fields.push('service');
    v.status = text('status', 16, true, false);
    if (v.status && STATUSES.indexOf(v.status) === -1) fields.push('status');
    v.memo = text('memo', LIMITS.memo, false, true);
    v.dueDate = text('dueDate', 10, false, false);
    if (v.dueDate && OpsContract.parseJstDate(v.dueDate) === null) fields.push('dueDate');
    v.evidenceUrl = text('evidenceUrl', LIMITS.evidenceUrl, false, false);
    if (v.evidenceUrl && !/^https:\/\/[^\s<>"'\\@]+$/.test(v.evidenceUrl)) fields.push('evidenceUrl');
    var uniq = fields.filter(function (f, i) { return fields.indexOf(f) === i; });
    return uniq.length ? { fields: uniq } : { value: v };
  }

  function invalid_(fields) {
    var first = FIELD_MESSAGES[fields[0]] || FIELD_MESSAGES.input;
    return error_('INVALID_PARAMS', first + (fields.length > 1 ? '（ほか' + (fields.length - 1) + '項目）' : ''), { fields: fields });
  }

  function validRevision_(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v >= 1; }

  /* ---- 行 ⇔ オブジェクト ---- */
  function cell_(v) { return v === undefined || v === null ? '' : v; }
  function fromRow_(cells) {
    var t = {};
    HEADERS.forEach(function (h, i) { t[h] = cell_(cells[i]); });
    if (typeof t.taskId !== 'string' || !/^T-[0-9a-z]{8,32}$/.test(t.taskId)) return null;
    HEADERS.forEach(function (h) { if (h !== 'revision' && typeof t[h] !== 'string') t[h] = String(t[h]); });
    t.revision = typeof t.revision === 'number' ? t.revision : Number(t.revision);
    if (!validRevision_(t.revision)) return null;
    if (STATUSES.indexOf(t.status) === -1) return null;
    return t;
  }
  function toRow_(t) { return HEADERS.map(function (h) { return h === 'revision' ? t.revision : cell_(t[h]); }); }

  function sameContent_(a, b) {
    return CONTENT_KEYS.every(function (k) { return String(cell_(a[k])) === String(cell_(b[k])); });
  }

  function ageDays_(isoText, nowMs) {
    var ms = Date.parse(isoText);
    return isNaN(ms) ? null : (nowMs - ms) / DAY_MS;
  }

  function toPublic_(t, todayJst, nowMs) {
    var open = t.status !== 'done';
    var age = ageDays_(t.updatedAt, nowMs);
    return {
      taskId: t.taskId, title: t.title, bookingId: t.bookingId, service: t.service,
      status: t.status, statusLabel: STATUS_LABELS[t.status], memo: t.memo, dueDate: t.dueDate, evidenceUrl: t.evidenceUrl,
      createdAt: t.createdAt, updatedAt: t.updatedAt, revision: t.revision,
      overdue: open && t.dueDate !== '' && t.dueDate < todayJst,
      /* 未完了で180日以上更新がないものは自動削除せず「見直し」表示だけ（黙って消さない）。 */
      stale: open && age !== null && age >= RETENTION_DAYS
    };
  }

  /* 並び: 期限超過 → 未完了（期限が近い順、期限なしは後ろ・更新が新しい順）→ 完了（更新が新しい順）。単純な規則のみ。 */
  function compareDisplay_(a, b) {
    function group(t) { return t.status === 'done' ? 2 : t.overdue ? 0 : 1; }
    if (group(a) !== group(b)) return group(a) - group(b);
    if (group(a) !== 2) {
      var ad = a.dueDate || '9999-99-99', bd = b.dueDate || '9999-99-99';
      if (ad !== bd) return ad < bd ? -1 : 1;
    }
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0;
  }

  /* 保存先の読み取り。ヘッダー不一致・ID重複は fail-closed（どれが正か判断しない）。 */
  function read_(store) {
    var raw = store.readAll();
    var header = (raw.header || []).map(function (h) { return String(h).trim(); });
    if (header.join('|') !== HEADERS.join('|')) throw storeError_('SCHEMA');
    var tasks = [], seen = {}, skipped = 0;
    (raw.rows || []).forEach(function (cells, i) {
      if (!cells || !cells.some(function (c) { return String(cell_(c)) !== ''; })) return; /* 空行 */
      var t = fromRow_(cells);
      if (!t) { skipped++; return; }
      if (seen[t.taskId]) throw storeError_('DUPLICATE_TASK_ID');
      seen[t.taskId] = true;
      t.rowNumber = i + 2;
      tasks.push(t);
    });
    return { tasks: tasks, skipped: skipped };
  }

  function storeError_(reason) { var e = new Error('store'); e.opsCode = 'STORE_FAILED'; e.opsReason = reason; return e; }

  function failStore_(e) {
    var reason = e && typeof e.opsReason === 'string' && /^[A-Z0-9_\/]{1,40}$/.test(e.opsReason) ? e.opsReason : 'UNKNOWN';
    Logger.log('ops tasks: store failed ' + reason);
    return error_('STORE_FAILED', MESSAGES.STORE_FAILED, { reason: reason });
  }

  function locked_(deps, fn) {
    var out;
    try {
      out = deps.withLock(fn);
    } catch (e) {
      return failStore_(e);
    }
    if (out && out.busy === true) return error_('BUSY');
    return out;
  }

  function nowIso_(nowMs) { return OpsContract.toIso(nowMs); }

  /* 完了から180日を過ぎたメモの行番号。 */
  function expired_(tasks, nowMs) {
    return tasks.filter(function (t) {
      if (t.status !== 'done') return false;
      var age = ageDays_(t.updatedAt, nowMs);
      return age !== null && age >= RETENTION_DAYS;
    });
  }

  /* 期限切れ完了メモの削除。ロック内で読み直してから削除し、削除後に不在を確認する。件数だけを返す。 */
  function purge_(deps, nowMs) {
    var out = locked_(deps, function () {
      var read = read_(deps.store);
      var gone = expired_(read.tasks, nowMs);
      if (!gone.length) return { ok: true, deleted: 0 };
      deps.store.removeRows(gone.map(function (t) { return t.rowNumber; }));
      var after = read_(deps.store).tasks;
      var ids = {};
      after.forEach(function (t) { ids[t.taskId] = true; });
      if (gone.some(function (t) { return ids[t.taskId]; })) throw storeError_('PURGE_VERIFY');
      return { ok: true, deleted: gone.length };
    });
    return out && out.ok === true ? { deleted: out.deleted, failed: false } : { deleted: 0, failed: true };
  }

  function list_(deps, nowMs) {
    var today = OpsContract.formatJstDate(nowMs);
    var base = { ok: true, contractVersion: OpsContract.CONTRACT_VERSION, fetchedAt: OpsContract.toIso(nowMs), todayJst: today, retentionDays: RETENTION_DAYS, statuses: STATUSES.map(function (s) { return { value: s, label: STATUS_LABELS[s] }; }) };
    var state;
    try { state = deps.store.state(); } catch (e0) { return failStore_(e0); }
    if (!state.ready) {
      return Object.assign(base, { storeReady: false, items: [], counts: { open: 0, overdue: 0, done: 0, stale: 0 }, purge: { deleted: 0, failed: false } });
    }
    var read;
    try { read = read_(deps.store); } catch (e) { return failStore_(e); }
    var purge = { deleted: 0, failed: false };
    if (expired_(read.tasks, nowMs).length) {
      purge = purge_(deps, nowMs);
      try { read = read_(deps.store); } catch (e2) { return failStore_(e2); }
    }
    var items = read.tasks.map(function (t) { return toPublic_(t, today, nowMs); }).sort(compareDisplay_);
    return Object.assign(base, {
      storeReady: true,
      items: items,
      counts: {
        open: items.filter(function (t) { return t.status !== 'done'; }).length,
        overdue: items.filter(function (t) { return t.overdue; }).length,
        done: items.filter(function (t) { return t.status === 'done'; }).length,
        stale: items.filter(function (t) { return t.stale; }).length
      },
      skippedRows: read.skipped,
      purge: purge
    });
  }

  function save_(request, deps, nowMs) {
    var today = OpsContract.formatJstDate(nowMs);
    var expected = request.expectedRevision;
    var creating = expected === undefined || expected === null;
    if (!creating && !validRevision_(expected)) return invalid_(['expectedRevision']);
    var checked = validate_(request.input, true);
    if (checked.fields) return invalid_(checked.fields);
    var input = checked.value;
    return locked_(deps, function () {
      try {
        var state = deps.store.state();
        if (!state.ready) {
          if (!creating) return error_('NOT_FOUND');
          deps.store.create();
        }
        var read = read_(deps.store);
        var existing = null;
        read.tasks.forEach(function (t) { if (t.taskId === input.taskId) existing = t; });
        var now = nowIso_(nowMs);
        var saved;
        if (creating) {
          if (existing) {
            /* 二重送信: 同じ内容なら保存済みとして成功、別内容は上書きせず競合。 */
            if (sameContent_(existing, input)) return { ok: true, task: toPublic_(existing, today, nowMs), replayed: true };
            return error_('CONFLICT', MESSAGES.CONFLICT, { current: toPublic_(existing, today, nowMs) });
          }
          if (read.tasks.length >= MAX_TASKS) return error_('TOO_MANY');
          saved = Object.assign({}, input, { createdAt: now, updatedAt: now, revision: 1 });
          deps.store.append(toRow_(saved));
        } else {
          if (!existing) return error_('NOT_FOUND');
          if (existing.revision !== expected) {
            /* 自分の更新が既に反映済みの再送（版が1つ進み内容が同じ）は成功。それ以外は上書きしない。 */
            if (existing.revision === expected + 1 && sameContent_(existing, input)) return { ok: true, task: toPublic_(existing, today, nowMs), replayed: true };
            return error_('CONFLICT', MESSAGES.CONFLICT, { current: toPublic_(existing, today, nowMs) });
          }
          if (sameContent_(existing, input)) return { ok: true, task: toPublic_(existing, today, nowMs), unchanged: true };
          saved = Object.assign({}, input, { createdAt: existing.createdAt, updatedAt: now, revision: existing.revision + 1 });
          deps.store.updateRow(existing.rowNumber, toRow_(saved));
        }
        /* 読み直して照合する。一致しなければ成功と言わない。 */
        var verify = null;
        read_(deps.store).tasks.forEach(function (t) { if (t.taskId === saved.taskId) verify = t; });
        if (!verify || verify.revision !== saved.revision || !sameContent_(verify, saved)) throw storeError_('VERIFY');
        return { ok: true, task: toPublic_(verify, today, nowMs) };
      } catch (e) {
        return failStore_(e);
      }
    });
  }

  function delete_(request, deps, nowMs) {
    var taskId = str_(request.taskId).trim();
    if (!/^T-[0-9a-z]{8,32}$/.test(taskId)) return invalid_(['taskId']);
    if (!validRevision_(request.expectedRevision)) return invalid_(['expectedRevision']);
    var today = OpsContract.formatJstDate(nowMs);
    return locked_(deps, function () {
      try {
        if (!deps.store.state().ready) return { ok: true, deleted: false, alreadyDeleted: true };
        var existing = null;
        read_(deps.store).tasks.forEach(function (t) { if (t.taskId === taskId) existing = t; });
        /* 二重送信: すでに無ければ成功（重ねて削除しない）。 */
        if (!existing) return { ok: true, deleted: false, alreadyDeleted: true };
        if (existing.revision !== request.expectedRevision) return error_('CONFLICT', MESSAGES.CONFLICT, { current: toPublic_(existing, today, nowMs) });
        deps.store.removeRows([existing.rowNumber]);
        var still = false;
        read_(deps.store).tasks.forEach(function (t) { if (t.taskId === taskId) still = true; });
        if (still) throw storeError_('VERIFY');
        return { ok: true, deleted: true };
      } catch (e) {
        return failStore_(e);
      }
    });
  }

  /* 共通契約の入口。認可は OpsApi.handle が済ませてから呼ぶ（ここでは行わない）。 */
  function handle(request, deps, nowMs) {
    if (request.op === 'tasks_list') return list_(deps, nowMs);
    if (request.op === 'task_save') return save_(request, deps, nowMs);
    if (request.op === 'task_delete') return delete_(request, deps, nowMs);
    return error_('INVALID_PARAMS', '要求の種類が不正です。');
  }

  return {
    handle: handle, HEADERS: HEADERS, STATUSES: STATUSES, STATUS_LABELS: STATUS_LABELS, LIMITS: LIMITS,
    MAX_TASKS: MAX_TASKS, RETENTION_DAYS: RETENTION_DAYS, validate: validate_, fromRow: fromRow_, toRow: toRow_
  };
})();
