/*
 * OpsRevenue.gs — 年商・月次の売上集計（Issue #990 PR-B）。読み取り専用・純粋な集計（通信・書込みなし）。
 *
 * 計上基準（オーナー確定 2026-11-20。年80万円・130万円は「年商（売上）」目標で、利益ではない）:
 * - 実績売上 = 「利用日が過ぎ、かつ支払い済み（paid）」の金額。月は利用日（JST）。
 * - 予定 = 確定済みで利用がこれから（予約の料金）／支払い済みで利用がこれから（有料オプション）。実績率に加えない。
 * - 利用済み・入金未確認 = 確定済みで利用が過ぎたが paid ではない（現地払い等）。実績に入れず、別項目で示す（0円にしない）。
 * - 返金（refund_pending / refunded）は金額を合算せず件数のみ（返金額の正本列をOpsは読まない）。実績にも予定にも入れない。
 * - 会員費 = Stripe入金の記録（MemberPeriods＋凍結済みMemberMonths）を入金日（JST）の月で計上。全額返金済み（MemberRefunds）は除外。
 *   同じ支払い（sourceType+sourceId）は1回だけ数える。
 * - 有料オプション = OptionOrders の PAID を、紐づく予約の利用日で実績/予定に分ける。部屋代（priceAmount）とは別金額で重複しない。
 *   紐づく予約が見つからない注文は「未確認」（実績に入れない）。
 * - SNBCイベント収益・経費・利益は正本が未実装のため「未接続」。0円として扱わない。
 * 金額が読めない行（null）は金額に含めず、件数で別表示する。個人情報は集計に持ち込まない（氏名・予約IDを返さない）。
 */
'use strict';

var OpsRevenue = (function () {
  var GOALS = [{ id: 'base', label: '基本目標', amount: 800000 }, { id: 'upper', label: '上位目標', amount: 1300000 }];
  var STUDIO_SERVICES = ['snb', 'snb_mens', 'studio_x', 'unclassified'];
  var JST_MS = 9 * 3600 * 1000;
  var DAY_MS = 24 * 3600 * 1000;

  function toMs_(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v.getTime === 'function') { var t = v.getTime(); return isNaN(t) ? null : t; }
    if (typeof v === 'string') { var p = Date.parse(v); return isNaN(p) ? null : p; }
    return null;
  }
  function num_(v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : null; }
  function jstYearMonth_(ms) { var d = new Date(ms + JST_MS); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; }
  /* 'YYYY-MM-DD' → { y, m }（形式が不正なら null）。 */
  function ymOfDate_(text) {
    var m = /^(\d{4})-(\d{2})-\d{2}$/.exec(String(text || ''));
    return m ? { y: +m[1], m: +m[2] } : null;
  }
  function emptyMonth_() {
    var studio = {};
    STUDIO_SERVICES.forEach(function (s) { studio[s] = { actual: 0, scheduled: 0, unconfirmed: 0, refundedCount: 0, unknownAmountCount: 0, actualCount: 0 }; });
    return { studio: studio, options: { actual: 0, scheduled: 0 }, members: { actual: 0 } };
  }

  /* 決済状態の判定（Booking の正規化と同じ語彙）。未知の値は 'unknown'（支払い済みと断定しない）。 */
  function paymentKind_(raw) {
    var v = typeof raw === 'string' ? raw.trim() : '';
    if (v === 'paid') return 'paid';
    if (v === 'refund_pending' || v === 'refunded') return 'refund';
    if (v === '' || v === 'unpaid' || v === 'not_started' || v === 'checkout_pending' || v === 'failed') return 'unpaid';
    return 'unknown';
  }

  /*
   * input: { bookings: [正規化済み予約], options: {state, rows}, members: {state, periods, months, refunds} }
   * state: 'ready' | 'not_connected' | 'error'。 ready 以外のソースは金額を 0 として足さず、sources に状態を返す。
   */
  function compute(input, year, nowMs) {
    var months = [];
    for (var i = 0; i < 12; i++) months.push(emptyMonth_());
    var usage = {}; /* bookingId → { passed, ym }（オプションの紐づけ用） */
    var notes = { pendingCount: 0, bookingsOutOfYear: 0, optionUnmatchedCount: 0 };

    (input.bookings || []).forEach(function (r) {
      var ym = ymOfDate_(r.date);
      if (!ym) return;
      var endOrStart = r.endMs !== null && r.endMs !== undefined && r.endMs > r.startMs ? r.endMs : r.startMs;
      var passed = endOrStart <= nowMs;
      usage[r.bookingId] = { passed: passed, ym: ym, status: r.status };
      if (ym.y !== year) { notes.bookingsOutOfYear++; return; }
      var svc = STUDIO_SERVICES.indexOf(r.service) !== -1 ? r.service : 'unclassified';
      var cell = months[ym.m - 1].studio[svc];
      var kind = paymentKind_(r.paymentStatus);
      /* 返金は予約の状態に関わらず件数に数える（管理画面の返金はキャンセル後に返金状態になるため）。金額は合算しない。 */
      if (kind === 'refund') { cell.refundedCount++; return; }
      if (r.status === 'PENDING') { notes.pendingCount++; return; }
      if (r.status !== 'CONFIRMED') return; /* キャンセル・失効・不明は売上にしない */
      var price = num_(r.effectivePriceAmount);
      if (price === null) { cell.unknownAmountCount++; return; }
      if (passed && kind === 'paid') { cell.actual += price; cell.actualCount++; }
      else if (passed) cell.unconfirmed += price; /* 利用済み・入金未確認（実績に入れない） */
      else cell.scheduled += price;
    });

    var sources = { studio: { state: 'ready' }, options: { state: 'not_connected' }, members: { state: 'not_connected' }, snbc: { state: 'not_connected' }, expenses: { state: 'not_connected' } };

    if (input.options && input.options.state === 'ready') {
      sources.options = { state: 'ready' };
      (input.options.rows || []).forEach(function (o) {
        if (String(o.paymentStatus || '').trim() !== 'PAID' || String(o.status || '').trim() !== 'CONFIRMED') return;
        var amount = num_(o.amountJpy);
        if (amount === null || amount === 0) return;
        var u = usage[String(o.bookingId || '').trim()];
        if (!u) { notes.optionUnmatchedCount++; return; }
        if (u.ym.y !== year || u.status !== 'CONFIRMED') return;
        var cell = months[u.ym.m - 1].options;
        if (u.passed) cell.actual += amount; else cell.scheduled += amount;
      });
    } else if (input.options) sources.options = { state: input.options.state || 'not_connected' };

    if (input.members && input.members.state === 'ready') {
      sources.members = { state: 'ready' };
      var refunded = {};
      (input.members.refunds || []).forEach(function (x) { refunded[String(x.sourceType || '') + '\n' + String(x.sourceId || '')] = true; });
      var seen = {};
      (input.members.periods || []).concat(input.members.months || []).forEach(function (x) {
        var key = String(x.sourceType || '') + '\n' + String(x.sourceId || '');
        if (!x.sourceId || seen[key] || refunded[key]) return;
        seen[key] = true;
        var amount = num_(typeof x.amount === 'string' ? Number(x.amount) : x.amount);
        var paidMs = toMs_(x.paidAt);
        if (amount === null || paidMs === null || paidMs > nowMs) return;
        var ym = jstYearMonth_(paidMs);
        if (ym.y === year) months[ym.m - 1].members.actual += amount;
      });
    } else if (input.members) sources.members = { state: input.members.state || 'not_connected' };

    var out = months.map(function (mo, idx) {
      var studioActual = 0, studioSched = 0, studioUnconf = 0, refundedCount = 0, unknownAmount = 0;
      STUDIO_SERVICES.forEach(function (s) {
        var c = mo.studio[s]; studioActual += c.actual; studioSched += c.scheduled; studioUnconf += c.unconfirmed; refundedCount += c.refundedCount; unknownAmount += c.unknownAmountCount;
      });
      var optActual = sources.options.state === 'ready' ? mo.options.actual : 0;
      var memActual = sources.members.state === 'ready' ? mo.members.actual : 0;
      return {
        month: idx + 1,
        studio: mo.studio,
        options: { actual: mo.options.actual, scheduled: mo.options.scheduled },
        members: { actual: mo.members.actual },
        actual: studioActual + optActual + memActual,
        scheduled: studioSched + (sources.options.state === 'ready' ? mo.options.scheduled : 0),
        unconfirmed: studioUnconf,
        refundedCount: refundedCount,
        unknownAmountCount: unknownAmount
      };
    });
    var totals = out.reduce(function (t, m) {
      t.actual += m.actual; t.scheduled += m.scheduled; t.unconfirmed += m.unconfirmed; t.refundedCount += m.refundedCount; t.unknownAmountCount += m.unknownAmountCount;
      return t;
    }, { actual: 0, scheduled: 0, unconfirmed: 0, refundedCount: 0, unknownAmountCount: 0 });
    var byService = {};
    STUDIO_SERVICES.forEach(function (s) { byService[s] = out.reduce(function (a, m) { return a + m.studio[s].actual; }, 0); });
    var optionsTotal = out.reduce(function (a, m) { return a + (sources.options.state === 'ready' ? m.options.actual : 0); }, 0);
    var membersTotal = out.reduce(function (a, m) { return a + (sources.members.state === 'ready' ? m.members.actual : 0); }, 0);

    var cur = jstYearMonth_(nowMs);
    var isCurrentYear = cur.y === year;
    var goals = GOALS.map(function (g) {
      var remaining = Math.max(0, g.amount - totals.actual);
      var o = { id: g.id, label: g.label, amount: g.amount, rate: totals.actual / g.amount, remaining: remaining, monthlyBase: g.amount / 12, requiredMonthlyAverage: null };
      if (isCurrentYear) o.requiredMonthlyAverage = remaining / (12 - (cur.m - 1)); /* 当月を含む残り月数 */
      return o;
    });
    var forecast = null;
    if (isCurrentYear) {
      var yearStart = Date.UTC(year, 0, 1) - JST_MS;
      var days = Math.max(1, Math.floor((nowMs - yearStart) / DAY_MS) + 1);
      var daysInYear = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / DAY_MS;
      forecast = Math.round(totals.actual / days * daysInYear); /* 参考予測: 年初からの実績ペースが続いた場合 */
    }
    return {
      year: year,
      currentMonth: isCurrentYear ? cur.m : null,
      basis: '実績売上＝利用日が過ぎ、かつ支払い済み（paid）。会員費は入金日、有料オプションは紐づく予約の利用日で計上。',
      sources: sources,
      months: out,
      totals: { actual: totals.actual, scheduled: totals.scheduled, unconfirmed: totals.unconfirmed, refundedCount: totals.refundedCount, unknownAmountCount: totals.unknownAmountCount,
        studioByService: byService, options: optionsTotal, members: membersTotal },
      goals: goals,
      forecast: forecast,
      notes: { pendingCount: notes.pendingCount, optionUnmatchedCount: notes.optionUnmatchedCount }
    };
  }

  return { compute: compute, paymentKind: paymentKind_, GOALS: GOALS };
})();
