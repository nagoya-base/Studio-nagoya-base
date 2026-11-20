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
    function keyView(code, label, tone, reasons, ops, lc) {
      return {
        verdict: { code: code, label: label, tone: tone }, reasons: reasons.map(function (t) { return { code: 'MOCK', text: t + '（モック）' }; }),
        connection: 'CONNECTED', failure: null, lifecycle: lc || null, savedFinal: null, consistency: 'STABLE', opCount: ops.length, truncated: false, ops: ops,
        jobs: [{ job: 'SYNC', label: '予約と鍵の同期', ageMinutes: 3 }, { job: 'DELIVER', label: '案内メールの送信', ageMinutes: null }], notes: []
      };
    }
    function keyOp(stateLabel, deliveryLabel, current) {
      return { rev: 1, current: current !== false, kindLabel: '発行', stateLabel: stateLabel, validFrom: iso(nowMs, 9, 45), validTo: iso(nowMs, 12, 15), updatedAt: iso(nowMs, 8, 0), deliveryLabel: deliveryLabel };
    }
    /* メール送信記録の架空値（#967）。MOCK-002は鍵記録NONEでも来場案内の送信記録あり、MOCK-003は列欠落、MOCK-004は日時不正。 */
    function mockMail(id, kind) {
      if (id === 'MOCK-003') return { state: 'column_missing', at: null };
      if (id === 'MOCK-004') return { state: 'invalid', at: null };
      if (id === 'MOCK-005' || id === 'MOCK-006') return { state: 'none', at: null };
      return { state: 'recorded', at: iso(nowMs, kind === 'access' ? 8 : 7, 0) };
    }
    var MOCK_KEYS = {
      'MOCK-001': function () { return keyView('ISSUED_GUIDED', '登録確認済み・案内済み', 'ok', [], [keyOp('登録確認済み', '案内済み（送信呼出し成功。利用者への到達は別）')], { code: 'ISSUED', label: '発行済み（登録確認済み）', tone: 'ok', alert: false }); },
      'MOCK-002': function () { return keyView('NO_HISTORY', '鍵の履歴なし（未発行か失効済みかは判別不可）', 'warn', ['鍵管理側に記録がありません。「未発行」とも「失効済み」とも判断していません', '確認先: 鍵管理アプリ側の鍵一覧と、鍵管理側の通知・実行ログ'], [], { code: 'NO_HISTORY', label: '鍵の履歴なし（判別不可）', tone: 'warn', alert: false }); },
      'MOCK-003': function () { return keyView('REVOKED_CONFIRMED', '失効確認済み', 'ok', [], [keyOp('失効確認済み', '案内済み（送信呼出し成功。利用者への到達は別）')], { code: 'REVOKED', label: '失効済み（確認済み）', tone: 'ok', alert: false }); },
      'MOCK-004': function () { return keyView('MISMATCH', '不一致（予約と鍵の記録が食い違っています）', 'ng', ['鍵の有効時間が、予約の利用時間を覆っていません'], [keyOp('登録確認済み', '案内済み（送信呼出し成功。利用者への到達は別）')], { code: 'ISSUED', label: '発行済み（登録確認済み）', tone: 'ok', alert: true }); },
      'MOCK-005': function () { return keyView('NEEDS_REVIEW', '要確認', 'ng', ['予約台帳の状態を判別できません'], [], { code: 'HOLD', label: '判定保留（鍵の記録を確定できません）', tone: 'ng', alert: true }); },
      'MOCK-006': function () { return keyView('GUIDE_NOT_SENT', '登録確認済み・案内未送信', 'warn', [], [keyOp('登録確認済み', '案内未送信')], { code: 'ISSUED', label: '発行済み（登録確認済み）', tone: 'ok', alert: false }); },
      'MOCK-008': function () { return keyView('NOT_ISSUED_CONFIRMED', '未発行（発行失敗の記録のみ・鍵は登録されていません）', 'info', ['発行の記録はすべて発行失敗です'], [keyOp('発行失敗', null)], { code: 'NOT_ISSUED', label: '未発行（根拠付き）', tone: 'info', alert: false }); },
      'MOCK-007': function () { return keyView('REVOKE_UNCONFIRMED', '失効未確認', 'warn', [], [keyOp('失効待ち', null)], { code: 'REVOKING', label: '失効処理中（失効の確認待ち）', tone: 'warn', alert: false }); }
    };

    /* 年商KPI（#990 PR-B）の架空応答。金額はすべて架空。SNBC・経費は未接続のまま。?scenario=error/denied は失敗を返す。 */
    function mockRevenue(params) {
      var yearNow = new Date(nowMs + 9 * 3600 * 1000).getUTCFullYear();
      var monthNow = new Date(nowMs + 9 * 3600 * 1000).getUTCMonth() + 1;
      var year = params && params.year ? params.year : yearNow;
      var amounts = [0, 0, 18000, 22000, 0, 30000, 26000, 0, 41000, 38000, 52000, 12000];
      var months = amounts.map(function (a, i) {
        var m = i + 1, past = year < yearNow || (year === yearNow && m <= monthNow);
        var cell = function (v) { return { actual: past ? v : 0, scheduled: 0, unconfirmed: 0, refundedCount: 0, unknownAmountCount: 0, actualCount: 0 }; };
        var studio = { snb: cell(past ? Math.round(a * 0.6) : 0), snb_mens: cell(past ? Math.round(a * 0.1) : 0), studio_x: cell(past ? Math.round(a * 0.3) : 0), unclassified: cell(0) };
        return { month: m, studio: studio, options: { actual: 0, scheduled: 0 }, members: { actual: 0 }, actual: past ? a : 0, scheduled: year === yearNow && m === monthNow ? 14000 : 0, unconfirmed: 0, refundedCount: 0, unknownAmountCount: 0 };
      });
      var total = months.reduce(function (t, m) { return t + m.actual; }, 0);
      var by = { snb: 0, snb_mens: 0, studio_x: 0, unclassified: 0 };
      months.forEach(function (m) { Object.keys(by).forEach(function (k) { by[k] += m.studio[k].actual; }); });
      var goals = [{ id: 'base', label: '基本目標', amount: 800000 }, { id: 'upper', label: '上位目標', amount: 1300000 }].map(function (g) {
        return { id: g.id, label: g.label, amount: g.amount, rate: total / g.amount, remaining: Math.max(0, g.amount - total), monthlyBase: g.amount / 12, requiredMonthlyAverage: year === yearNow ? Math.max(0, g.amount - total) / (12 - (monthNow - 1)) : null };
      });
      return { ok: true, contractVersion: 1, fetchedAt: isoNow(nowMs), excludedRows: 0, revenue: {
        year: year, currentMonth: year === yearNow ? monthNow : null, basis: '（モック）実績売上＝利用日が過ぎ、かつ支払い済み（paid）。',
        sources: { studio: { state: 'ready' }, options: { state: 'not_connected' }, members: { state: 'not_connected' }, snbc: { state: 'not_connected' }, expenses: { state: 'not_connected' } },
        partial: { isPartial: true, reasons: ['SNBC_NOT_CONNECTED', 'ONSITE_PAYMENT_UNCONFIRMED', 'REFUND_UNSETTLED', 'MEMBERS_UNAVAILABLE', 'OPTIONS_UNAVAILABLE'] },
        months: months, totals: { actual: total, scheduled: 14000, unconfirmed: 0, refundedCount: 2, unknownAmountCount: 0, onsiteUnconfirmed: 18000, onsiteUnconfirmedCount: 3, refundUnsettledCount: 1, retained: 0, studioByService: by, options: 0, members: 0 },
        goals: goals, forecast: year === yearNow ? Math.round(total / 300 * 365) : null, notes: { pendingCount: 0, optionUnmatchedCount: 0 } } };
    }

    /* 運営枠（#1003）の架空応答。?slots=ok|empty|not_configured|no_access|auth_required|read_failed|invalid|denied */
    var slotsScenario = opts.slots || 'ok';
    function mockSlots() {
      var day = 24 * 3600 * 1000;
      function slot(n, type, label, svc, place, title, dayOffset, h1, m1, h2, m2) {
        var d = nowMs + dayOffset * day;
        return { id: 'internal:mock-' + n, type: type, typeLabel: label, service: svc, placeLabel: place, title: title, date: dayText(d), startAt: iso(d, h1, m1), endAt: iso(d, h2, m2), reminded: n === 2 };
      }
      return [
        slot(1, 'snbc_event', 'SNBCイベント', 'snb', 'SNB', 'モック交流会', 1, 18, 0, 21, 0),
        slot(2, 'cleaning', '清掃・メンテナンス', 'studio_x', 'Studio X', 'モック定期清掃', 0, 15, 0, 17, 0),
        slot(3, 'setup', '設営・片付け', 'snb', 'SNB', 'モック設営', 3, 9, 0, 11, 0)
      ];
    }
    function slotsView() {
      if (slotsScenario === 'empty') return { state: 'ready', slots: [], invalid: 0 };
      if (slotsScenario === 'invalid') return { state: 'ready', slots: mockSlots(), invalid: 2 };
      if (['not_configured', 'no_access', 'auth_required', 'read_failed'].indexOf(slotsScenario) !== -1) return { state: slotsScenario, slots: [], invalid: 0 };
      return { state: 'ready', slots: mockSlots(), invalid: 0 };
    }

    return {
      kind: 'mock',
      internalSlots: function (ok) {
        defer(function () {
          if (slotsScenario === 'denied') return ok(err('FORBIDDEN', '権限がありません。（モック）'));
          ok({ ok: true, contractVersion: 1, source: 'mock', fetchedAt: isoNow(nowMs), internalSlots: slotsView() });
        });
      },
      revenue: function (params, ok) {
        defer(function () { var f = failure(); ok(f || mockRevenue(params)); });
      },
      keyStatus: function (id, ok) {
        defer(function () {
          if (keyScenario === 'denied') return ok(err('FORBIDDEN', '権限がありません。（モック）'));
          var v;
          if (keyScenario === 'not_connected') {
            v = keyView('NOT_CONNECTED', '未接続（鍵状態は取得していません）', 'info', [], []); v.connection = 'NOT_CONNECTED'; v.lifecycle = null; v.consistency = null; v.jobs = [];
          } else if (keyScenario === 'failed') {
            v = keyView('FETCH_FAILED', '未取得（取得に失敗しました）', 'ng', ['通信に失敗しました'], []); v.connection = 'FETCH_FAILED'; v.failure = { code: 'NETWORK' }; v.consistency = null; v.jobs = [];
          } else if (MOCK_KEYS[id]) {
            v = MOCK_KEYS[id]();
            /* ?key=saved: 履歴が回収済み（NONE）の予約に、Bookings保存の過去の最終確認を補助表示する（#971）。 */
            /* ?key=schedule: Accessが正常にNONEの予約直後は、予約状態・発行予定に基づく説明を主表示にする（#971）。 */
            if (keyScenario === 'schedule' && id === 'MOCK-002') v.lifecycle = { code: 'BEFORE_ISSUE', label: '発行開始前：利用日の前日12:00（JST）に発行を開始する予定です。発行予定時刻に基づく表示で、実際の鍵が無いことを確認した結果ではありません。（モック）', tone: 'info', alert: false };
            if (keyScenario === 'saved' && id === 'MOCK-002') v.savedFinal = { code: 'REVOKED_CONFIRMED', label: '失効・不在を確認済み', source: 'BOOKINGS_SAVED' };
          }
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
            largeParty: false, source: 'mock', createdAt: found.startAt, updatedAt: null, confirmedAt: null, cancelledAt: null, expiredAt: null,
            accessGuideMail: mockMail(found.bookingId, 'access'), confirmedMail: mockMail(found.bookingId, 'confirmed') });
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

  /* SNBC売上・現地払い受領（#995）のモック。架空データのメモリ内保存（再読込で消える）。 */
  function createMockRecordsApi() {
    var snbc = [], onsite = {};
    function defer(fn) { setTimeout(fn, 0); }
    function today() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
    function view(r) { return Object.assign({}, r, { net: r.receivedJpy - r.refundedJpy }); }
    return {
      kind: 'mock',
      snbcList: function (ok) { defer(function () { ok({ ok: true, storeReady: true, items: snbc.map(view).sort(function (a, b) { return a.eventDate < b.eventDate ? 1 : -1; }), skippedRows: 0, todayJst: today() }); }); },
      snbcSave: function (p, ok) { defer(function () {
        var i = p.input, ex = snbc.filter(function (x) { return x.eventId === i.eventId; })[0];
        var rec = Object.assign({}, i, { updatedAt: new Date().toISOString(), revision: ex ? ex.revision + 1 : 1 });
        if (ex) snbc[snbc.indexOf(ex)] = rec; else snbc.push(rec);
        ok({ ok: true, record: view(rec) });
      }); },
      snbcDelete: function (p, ok) { defer(function () { snbc = snbc.filter(function (x) { return x.eventId !== p.eventId; }); ok({ ok: true, deleted: true }); }); },
      onsiteGet: function (id, ok) { defer(function () { ok({ ok: true, storeReady: true, ledgerReceipt: false, todayJst: today(), record: onsite[id] ? view(onsite[id]) : null }); }); },
      onsiteSave: function (p, ok) { defer(function () {
        var i = p.input, ex = onsite[i.bookingId];
        onsite[i.bookingId] = Object.assign({}, i, { updatedAt: new Date().toISOString(), revision: ex ? ex.revision + 1 : 1, methodLabel: i.method });
        ok({ ok: true, record: view(onsite[i.bookingId]) });
      }); },
      onsiteDelete: function (p, ok) { defer(function () { delete onsite[p.bookingId]; ok({ ok: true, deleted: true }); }); }
    };
  }

  return { createMockApi: createMockApi, createMockTasksApi: createMockTasksApi, createMockRecordsApi: createMockRecordsApi };
});
