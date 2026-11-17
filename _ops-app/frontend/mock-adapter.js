/*
 * mock-adapter.js — フロントエンド検証用のモックアダプター（Issue #936）。
 *
 * ★ すべて架空のデータです。実際の予約・個人情報ではありません。応答は kind:'mock' のアダプターから返り、
 *   画面には常に「モックデータ」の表示が出ます。
 * 共通接続契約（docs/ops-reservations-936.md §6）と同じ形の応答を返します。実バックエンドには接続しません。
 * scenario: 'ok'（既定）| 'empty' | 'error' | 'not_connected' | 'denied' | 'flaky'（初回成功→以降失敗＝古いデータ表示の確認）
 * メモ（#941）のモックは createMockTasksApi（?tasks=ok|empty|not_ready|save_error|conflict|denied）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpsMockAdapter = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SERVICE_STATES = [
    { service: 'snb', label: 'SNB', state: 'connected' },
    { service: 'studio_x', label: 'Studio X', state: 'connected' },
    { service: 'snb_mens', label: 'SNB Mens', state: 'connected' },
    { service: 'snb_community', label: 'SNB Community', state: 'not_connected' }
  ];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dayText(ms) { var d = new Date(ms + 9 * 3600 * 1000); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  function isoNow(ms) { var d = new Date(ms + 9 * 3600 * 1000); return dayText(ms) + 'T' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()) + '+09:00'; }
  function iso(dayMs, hh, mm) { return dayText(dayMs) + 'T' + pad(hh) + ':' + pad(mm) + ':00+09:00'; }

  /* nowMs 基準の架空予約（今日・明日・日またぎ・取消・未分類）。 */
  function buildReservations(nowMs) {
    var day = 24 * 3600 * 1000;
    var base = nowMs;
    return [
      { bookingId: 'MOCK-001', service: 'snb', serviceLabel: 'SNB', status: 'CONFIRMED', statusLabel: '確定', date: dayText(base), startAt: iso(base, 10, 0), endAt: iso(base, 12, 0), name: 'モック 花子', people: 2 },
      { bookingId: 'MOCK-002', service: 'studio_x', serviceLabel: 'Studio X', status: 'PENDING', statusLabel: '仮予約', date: dayText(base + day), startAt: iso(base + day, 13, 0), endAt: iso(base + day, 15, 30), name: 'モック 太郎', people: 0 },
      { bookingId: 'MOCK-003', service: 'snb_mens', serviceLabel: 'SNB Mens', status: 'CANCELLED', statusLabel: 'キャンセル', date: dayText(base + 2 * day), startAt: iso(base + 2 * day, 9, 0), endAt: null, name: null, people: 1 },
      { bookingId: 'MOCK-004', service: 'snb', serviceLabel: 'SNB', status: 'CONFIRMED', statusLabel: '確定', date: dayText(base + 3 * day), startAt: iso(base + 3 * day, 22, 0), endAt: iso(base + 4 * day, 1, 0), name: 'モック 夜間', people: 3 },
      { bookingId: 'MOCK-005', service: 'unclassified', serviceLabel: '未分類', status: null, statusLabel: '不明', date: dayText(base + 5 * day), startAt: iso(base + 5 * day, 18, 0), endAt: iso(base + 5 * day, 19, 0), name: 'モック 不明', people: 2 }
      ,{ bookingId: 'MOCK-006', service: 'studio_x', serviceLabel: 'Studio X', status: 'CONFIRMED', statusLabel: '確定', date: dayText(base - day), startAt: iso(base - day, 22, 0), endAt: iso(base, 1, 0), name: 'モック 前夜', people: 2 },
      { bookingId: 'MOCK-007', service: 'snb', serviceLabel: 'SNB', status: 'EXPIRED', statusLabel: '失効', date: dayText(base - 10 * day), startAt: iso(base - 10 * day, 14, 0), endAt: iso(base - 10 * day, 16, 0), name: 'モック 過去', people: 1 }
    ].map(function (r) { r.phase = phaseOf(r, nowMs); return r; });
  }

  /* バックエンドと同じ定義: 現在時刻に対する分類。終了が分からないものは推測せず 'unknown'。 */
  function phaseOf(r, nowMs) {
    var start = Date.parse(r.startAt);
    var end = r.endAt === null ? null : Date.parse(r.endAt);
    if (nowMs < start) return 'upcoming';
    if (end === null || end <= start) return 'unknown';
    return nowMs < end ? 'in_progress' : 'ended';
  }

  /* バックエンドと同じ期間の定義（JST）: 始端=fromの0:00（含む）、終端=toの翌日0:00（含まない）。予約の時間帯の重なりで判定。 */
  function dayStartMs(text) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) - 9 * 3600 * 1000 : null; }
  function resolveRange(p, nowMs) {
    var day = 24 * 3600 * 1000;
    var past = p.scope === 'past';
    var from = p.from, to = p.to;
    if (past) { to = to || dayText(nowMs - day); from = from || dayText(dayStartMs(to) - 29 * day); }
    else { from = from || dayText(nowMs); to = to || dayText(dayStartMs(from) + 29 * day); }
    return { from: from, to: to, order: past ? 'desc' : 'asc' };
  }
  function overlaps(r, range) {
    var start = Date.parse(r.startAt), end = r.endAt === null ? null : Date.parse(r.endAt);
    var rs = dayStartMs(range.from), re = dayStartMs(range.to) + 24 * 3600 * 1000;
    if (start >= re) return false;
    return end !== null && end > start ? end > rs : start >= rs;
  }

  function err(code, message) { return { ok: false, error: { code: code, message: message } }; }

  function createMockApi(options) {
    var opts = options || {};
    var scenario = opts.scenario || 'ok';
    var nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
    var defer = opts.defer || function (fn) { setTimeout(fn, 0); };
    var calls = 0;
    var reservations = buildReservations(nowMs);

    function failure() {
      if (scenario === 'error') return err('FETCH_FAILED', '予約台帳の取得に失敗しました。（モック）');
      if (scenario === 'diag_api_disabled') {
        var r = err('FETCH_FAILED', '予約台帳の取得に失敗しました。（モック）');
        r.error.diagnostic = { code: 'META/API_DISABLED/403', stage: 'META', reason: 'API_DISABLED', http: 403, advice: '（モック）診断コードに応じた対応案がここに表示されます。' };
        return r;
      }
      if (scenario === 'not_connected') return err('NOT_CONNECTED', '予約台帳が未接続です。（モック）');
      if (scenario === 'denied') return err('FORBIDDEN', '権限がありません。（モック）');
      if (scenario === 'flaky' && calls > 1) return err('FETCH_FAILED', '予約台帳の取得に失敗しました。（モック）');
      return null;
    }

    /* 鍵・案内の状況（#942）の架空応答。?key=ok|not_connected|failed|denied（予約IDごとに状態が変わる）。 */
    var keyScenario = opts && opts.key ? opts.key : 'ok';
    function keyView(code, label, tone, reasons, ops) {
      return {
        verdict: { code: code, label: label, tone: tone }, reasons: reasons.map(function (t) { return { code: 'MOCK', text: t + '（モック）' }; }),
        connection: 'CONNECTED', failure: null, consistency: 'STABLE', opCount: ops.length, truncated: false, ops: ops,
        jobs: [{ job: 'SYNC', label: '予約と鍵の同期', ageMinutes: 3 }, { job: 'DELIVER', label: '案内メールの送信', ageMinutes: null }], notes: []
      };
    }
    function keyOp(stateLabel, deliveryLabel, current) {
      return { rev: 1, current: current !== false, kindLabel: '発行', stateLabel: stateLabel, validFrom: iso(nowMs, 9, 45), validTo: iso(nowMs, 12, 15), updatedAt: iso(nowMs, 8, 0), deliveryLabel: deliveryLabel };
    }
    var MOCK_KEYS = {
      'MOCK-001': function () { return keyView('ISSUED_GUIDED', '登録確認済み・案内済み', 'ok', [], [keyOp('登録確認済み', '案内済み（送信呼出し成功。利用者への到達は別）')]); },
      'MOCK-002': function () { return keyView('UNVERIFIABLE', '確認不能（記録を確認できません）', 'warn', ['鍵管理側に記録がありません。「未発行」とは判断していません'], []); },
      'MOCK-003': function () { return keyView('REVOKED_CONFIRMED', '失効確認済み', 'ok', [], [keyOp('失効確認済み', '案内済み（送信呼出し成功。利用者への到達は別）')]); },
      'MOCK-004': function () { return keyView('MISMATCH', '不一致（予約と鍵の記録が食い違っています）', 'ng', ['鍵の有効時間が、予約の利用時間を覆っていません'], [keyOp('登録確認済み', '案内済み（送信呼出し成功。利用者への到達は別）')]); },
      'MOCK-005': function () { return keyView('NEEDS_REVIEW', '要確認', 'ng', ['予約台帳の状態を判別できません'], []); },
      'MOCK-006': function () { return keyView('GUIDE_NOT_SENT', '登録確認済み・案内未送信', 'warn', [], [keyOp('登録確認済み', '案内未送信')]); },
      'MOCK-007': function () { return keyView('REVOKE_UNCONFIRMED', '失効未確認', 'warn', [], [keyOp('失効待ち', null)]); }
    };

    return {
      kind: 'mock',
      keyStatus: function (id, ok) {
        defer(function () {
          if (keyScenario === 'denied') return ok(err('FORBIDDEN', '権限がありません。（モック）'));
          var v;
          if (keyScenario === 'not_connected') {
            v = keyView('NOT_CONNECTED', '未接続（鍵状態は取得していません）', 'info', [], []); v.connection = 'NOT_CONNECTED'; v.consistency = null; v.jobs = [];
          } else if (keyScenario === 'failed') {
            v = keyView('FETCH_FAILED', '未取得（取得に失敗しました）', 'ng', ['通信に失敗しました'], []); v.connection = 'FETCH_FAILED'; v.failure = { code: 'NETWORK' }; v.consistency = null; v.jobs = [];
          } else if (MOCK_KEYS[id]) v = MOCK_KEYS[id]();
          else return ok(err('NOT_FOUND', '該当する予約が見つかりません。（モック）'));
          ok({ ok: true, contractVersion: 1, source: 'mock', fetchedAt: isoNow(nowMs), bookingId: id, keyStatus: v });
        });
      },
      list: function (params, ok) {
        calls++;
        defer(function () {
          var f = failure();
          if (f) return ok(f);
          var p = params || {};
          var range = resolveRange(p, nowMs);
          if (!dayStartMs(range.from) || !dayStartMs(range.to) || range.from > range.to) return ok(err('INVALID_PARAMS', '条件が不正です。（モック）'));
          var items = scenario === 'empty' ? [] : reservations.filter(function (r) {
            return (!p.service || p.service === 'all' || r.service === p.service) && (!p.status || p.status === 'all' || (p.status === 'UNKNOWN' ? r.status === null : r.status === p.status)) && overlaps(r, range);
          });
          items.sort(function (a, b) { var d = Date.parse(a.startAt) - Date.parse(b.startAt) || (a.bookingId < b.bookingId ? -1 : 1); return range.order === 'desc' ? -d : d; });
          ok({
            ok: true, contractVersion: 1, source: 'mock', fetchedAt: isoNow(nowMs), todayJst: dayText(nowMs),
            applied: { scope: p.scope || 'upcoming', service: p.service || 'all', status: p.status || 'all', from: range.from, to: range.to, order: range.order },
            complete: true,
            counts: { sheetRows: reservations.length, valid: reservations.length, matched: p.service === 'snb_community' ? 0 : items.length, issues: 1 },
            serviceStates: SERVICE_STATES,
            notConnectedSelected: p.service === 'snb_community',
            items: p.service === 'snb_community' ? [] : items,
            issues: [{ row: 9, bookingId: null, severity: 'error', reasons: ['予約IDが空欄'] }]
          });
        });
      },
      detail: function (id, ok) {
        calls++;
        defer(function () {
          var f = failure();
          if (f) return ok(f);
          var found = reservations.filter(function (r) { return r.bookingId === id; })[0];
          if (!found) return ok(err('NOT_FOUND', '該当する予約が見つかりません。（モック）'));
          var detail = Object.assign({}, found, { brandRaw: found.service === 'unclassified' ? 'mock_brand' : null, statusRaw: found.status === null ? 'MOCK' : null,
            customerType: 'モック区分', purpose: 'モック用途', paymentMethod: 'cash', paymentStatus: 'not_started', planCode: null, effectivePriceAmount: 0, priceOverridden: false,
            largeParty: false, source: 'mock', createdAt: found.startAt, updatedAt: null, confirmedAt: null, cancelledAt: null, expiredAt: null });
          ok({ ok: true, contractVersion: 1, source: 'mock', fetchedAt: isoNow(nowMs), reservation: detail });
        });
      }
    };
  }

  /*
   * メモ（Issue #941）のモック。メモリ上だけに保存する架空データで、再読込で消える（実際のメモは保存されない）。
   * バックエンドと同じ契約: 版番号による競合、新規の冪等（同じIDの同内容は保存済み扱い）、状態/期限超過の判定。
   * scenario: 'ok' | 'empty' | 'not_ready'（保存先未設定）| 'save_error'（保存が必ず失敗）| 'conflict'（更新が必ず競合）| 'denied'
   */
  var TASK_STATUS_LABELS = { todo: '未対応', doing: '対応中', done: '完了' };
  var TASK_CONTENT = ['title', 'bookingId', 'service', 'status', 'memo', 'dueDate', 'evidenceUrl'];

  function createMockTasksApi(options) {
    var opts = options || {};
    var scenario = opts.scenario || 'ok';
    var nowMs = typeof opts.nowMs === 'number' ? opts.nowMs : Date.now();
    var defer = opts.defer || function (fn) { setTimeout(fn, 0); };
    var day = 24 * 3600 * 1000;
    var ready = scenario !== 'not_ready';
    var tasks = scenario === 'ok' || scenario === 'save_error' || scenario === 'conflict' ? [
      { taskId: 'T-mockaaaa0001', title: '（モック）DM返信の確認', bookingId: '', service: '', status: 'todo', memo: '件名とリンクだけ登録する例', dueDate: dayText(nowMs - 2 * day), evidenceUrl: 'https://example.com/mock-dm', createdAt: isoNow(nowMs - 3 * day), updatedAt: isoNow(nowMs - 3 * day), revision: 1 },
      { taskId: 'T-mockaaaa0002', title: '（モック）撮影の機材確認', bookingId: 'MOCK-001', service: 'snb', status: 'doing', memo: '', dueDate: dayText(nowMs + 2 * day), evidenceUrl: '', createdAt: isoNow(nowMs - day), updatedAt: isoNow(nowMs - day), revision: 1 },
      { taskId: 'T-mockaaaa0003', title: '（モック）完了済みの例', bookingId: '', service: '', status: 'done', memo: '', dueDate: '', evidenceUrl: '', createdAt: isoNow(nowMs - 9 * day), updatedAt: isoNow(nowMs - 8 * day), revision: 2 }
    ] : [];

    function decorate(t) {
      var open = t.status !== 'done';
      return Object.assign({}, t, { statusLabel: TASK_STATUS_LABELS[t.status], overdue: open && t.dueDate !== '' && t.dueDate < dayText(nowMs), stale: false });
    }
    function rank(t) { return t.status === 'done' ? 2 : t.overdue ? 0 : 1; }
    function view() {
      var items = tasks.map(decorate).sort(function (a, b) {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        var ad = a.dueDate || '9999-99-99', bd = b.dueDate || '9999-99-99';
        if (rank(a) !== 2 && ad !== bd) return ad < bd ? -1 : 1;
        return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
      });
      return {
        ok: true, contractVersion: 1, source: 'mock', fetchedAt: isoNow(nowMs), todayJst: dayText(nowMs), retentionDays: 180,
        statuses: [{ value: 'todo', label: '未対応' }, { value: 'doing', label: '対応中' }, { value: 'done', label: '完了' }],
        storeReady: ready, items: items,
        counts: {
          open: items.filter(function (t) { return t.status !== 'done'; }).length, overdue: items.filter(function (t) { return t.overdue; }).length,
          done: items.filter(function (t) { return t.status === 'done'; }).length, stale: 0
        },
        skippedRows: 0, purge: { deleted: 0, failed: false }
      };
    }
    function same(a, b) { return TASK_CONTENT.every(function (k) { return String(a[k] || '') === String(b[k] || ''); }); }
    function byId(id) { return tasks.filter(function (t) { return t.taskId === id; })[0] || null; }
    function denied() { return scenario === 'denied' ? err('FORBIDDEN', '権限がありません。（モック）') : null; }

    return {
      kind: 'mock',
      list: function (ok) {
        defer(function () { ok(denied() || view()); });
      },
      save: function (payload, ok) {
        defer(function () {
          var d = denied();
          if (d) return ok(d);
          if (scenario === 'save_error') return ok(err('STORE_FAILED', 'メモの保存先との通信に失敗しました。保存できたか確認できていません。（モック）'));
          var input = (payload && payload.input) || {};
          var expected = payload ? payload.expectedRevision : null;
          if (!input.title || !String(input.title).trim()) return ok(err('INVALID_PARAMS', '件名は必須です。（モック）'));
          var existing = byId(input.taskId);
          var now = isoNow(nowMs);
          if (expected === null || expected === undefined) {
            if (existing) {
              if (same(existing, input)) return ok({ ok: true, task: decorate(existing), replayed: true, fetchedAt: now });
              return ok(Object.assign(err('CONFLICT', '別の端末・操作で先に更新されています。上書きはしていません。（モック）'), {}));
            }
            if (!ready) return ok(Object.assign(err('STORE_FAILED', 'メモの保存先との通信に失敗しました。保存できたか確認できていません。（モック）'), { reason: 'NOT_CONFIGURED' }));
            var made = { taskId: input.taskId, title: String(input.title).trim(), bookingId: input.bookingId || '', service: input.service || '', status: input.status || 'todo', memo: input.memo || '', dueDate: input.dueDate || '', evidenceUrl: input.evidenceUrl || '', createdAt: now, updatedAt: now, revision: 1 };
            tasks.push(made);
            return ok({ ok: true, task: decorate(made), fetchedAt: now });
          }
          if (!existing) return ok(err('NOT_FOUND', '該当するメモが見つかりません。（モック）'));
          if (scenario === 'conflict' || existing.revision !== expected) {
            var c = err('CONFLICT', '別の端末・操作で先に更新されています。上書きはしていません。（モック）');
            c.error.current = decorate(existing);
            return ok(c);
          }
          TASK_CONTENT.forEach(function (k) { existing[k] = input[k] === undefined || input[k] === null ? '' : input[k]; });
          existing.updatedAt = now; existing.revision += 1;
          ok({ ok: true, task: decorate(existing), fetchedAt: now });
        });
      },
      remove: function (payload, ok) {
        defer(function () {
          var d = denied();
          if (d) return ok(d);
          if (scenario === 'save_error') return ok(err('STORE_FAILED', 'メモの保存先との通信に失敗しました。（モック）'));
          var existing = byId(payload && payload.taskId);
          if (!existing) return ok({ ok: true, deleted: false, alreadyDeleted: true, fetchedAt: isoNow(nowMs) });
          if (existing.revision !== payload.expectedRevision) { var c = err('CONFLICT', '別の端末・操作で先に更新されています。上書きはしていません。（モック）'); c.error.current = decorate(existing); return ok(c); }
          tasks = tasks.filter(function (t) { return t !== existing; });
          ok({ ok: true, deleted: true, fetchedAt: isoNow(nowMs) });
        });
      }
    };
  }

  return { createMockApi: createMockApi, createMockTasksApi: createMockTasksApi };
});
