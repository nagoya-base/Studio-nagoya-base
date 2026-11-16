/*
 * mock-adapter.js — フロントエンド検証用のモックアダプター（Issue #936）。
 *
 * ★ すべて架空のデータです。実際の予約・個人情報ではありません。応答は kind:'mock' のアダプターから返り、
 *   画面には常に「モックデータ」の表示が出ます。
 * 共通接続契約（docs/ops-reservations-936.md §6）と同じ形の応答を返します。実バックエンドには接続しません。
 * scenario: 'ok'（既定）| 'empty' | 'error' | 'not_connected' | 'denied' | 'flaky'（初回成功→以降失敗＝古いデータ表示の確認）
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
      if (scenario === 'not_connected') return err('NOT_CONNECTED', '予約台帳が未接続です。（モック）');
      if (scenario === 'denied') return err('FORBIDDEN', '権限がありません。（モック）');
      if (scenario === 'flaky' && calls > 1) return err('FETCH_FAILED', '予約台帳の取得に失敗しました。（モック）');
      return null;
    }

    return {
      kind: 'mock',
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

  return { createMockApi: createMockApi };
});
