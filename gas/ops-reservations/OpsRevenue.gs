/*
 * OpsRevenue.gs — 年商・月次の売上集計（Issue #990 PR-B）。読み取り専用・純粋な集計（通信・書込みなし）。
 *
 * 計上基準（オーナー確定 2026-11-20。年80万円・130万円は「年商（売上）」目標で、利益ではない）:
 * - 実績売上 = 「利用日が過ぎ、かつ支払い済み（paid）」の金額。月は利用日（JST）。
 * - 予定 = 確定済みで利用がこれから（予約の料金）／支払い済みで利用がこれから（有料オプション）。実績率に加えない。
 * - 利用済み・入金未確認 = 確定済みで利用が過ぎたが paid ではない（現地払い等）。実績に入れず、別項目で示す（0円にしない）。
 * - 現地払い（現金・PayPay等）: 既存の予約システムは現地払いの paymentStatus を NOT_STARTED のまま更新せず、受領の記録が台帳に無い。
 *   したがって利用が過ぎた現地払いは「現地払い・受領記録なし」として別枠に出し、実績には入れない（実際には受領済みでも年商に入らないため、
 *   実績は『確認済み額の部分計』であり全体年商ではない）。受領記録の正本ができるまで確定達成率とは扱わない。
 * - 日程変更・人数変更の精算: 現在の料金（見積り）を受領額とみなさない。精算が未了（追加請求・返金待ち）のものは、確認済みの入出金の累計
 *   （feePaidAmount－feeRefundedAmount）だけを実績にし、差額は未確定として件数で示す（記録が無ければ金額に含めない）。
 * - キャンセル料の計上月: **取消確定月（cancelledAt・JST）**。元の利用予定月ではない（オーナー確定 2026-11-20）。取消確定日時が不明なものは
 *   利用予定月へフォールバックせず、「取消計上月不明」の件数として集計から除外する。
 * - 取消・返金: 返金方法（refundDecision: FULL/PARTIAL/NONE）と返金額（refundAmount）を使い、「受領額－返金額」の残額を計上する。
 *   返金が完了（paymentStatus=refunded）していて返金額が確定しているときだけ残額を実績にする。返金NONE（返金なしで paid のまま）は全額が残額。
 *   返金処理中（refund_pending）・返金方法が不明・返金額が受領額を超えるなど差引額を確定できないものは、金額に含めず「返金処理中・結果不明」の件数にする。
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
    STUDIO_SERVICES.forEach(function (s) { studio[s] = { actual: 0, scheduled: 0, unconfirmed: 0, refundedCount: 0, unknownAmountCount: 0, actualCount: 0, retained: 0, onsiteUnconfirmed: 0, onsiteUnconfirmedCount: 0, refundUnsettledCount: 0, settlementPendingCount: 0, receiptUnresolvedCount: 0 }; });
    return { studio: studio, options: { actual: 0, scheduled: 0 }, members: { actual: 0 } };
  }

  /* 予約フォームのカード決済の支払方法（Booking.PAYMENT_METHOD_CARD と同じ値）。これ以外は現地払い。 */
  var CARD_METHOD = 'オンラインクレジットカード';

  /*
   * 返金後の差引額（受領額－返金額）。確定できないときは null。
   * decision: FULL→0／PARTIAL→受領額－返金額（返金額が0以上かつ受領額以下）／NONE→受領額。未記録・不正は null。
   */
  function refundNet_(r, price) {
    var d = String(r.refundDecision || '').trim();
    if (price === null) return null;
    if (d === 'FULL') return 0;
    if (d === 'NONE') return price;
    if (d === 'PARTIAL') {
      var ra = num_(r.refundAmount);
      return ra !== null && ra <= price ? price - ra : null;
    }
    return null;
  }

  /*
   * 受領額の基準（日程変更・人数変更の精算を考慮）。現在の料金（priceOverrideAmount を含む見積り）を受領額とみなさない。
   * - 精算が未了（feeSettlementState が PENDING_CHARGE / PENDING_REFUND / PENDING_DECISION）: 実際に確認した入出金の累計
   *   （feePaidAmount－feeRefundedAmount）だけを受領額とする。記録が無ければ受領額は不明（null）。いずれも差額は未確定。
   * - 精算済み・記録あり: 記録された入出金の累計を受領額とする。
   * - 精算の関与なし（通常の予約）: 料金を受領額とする。
   * 当初のカード入金は stripeAmount（決済成功時にWebhookで台帳のスナップショットと照合済みの額）で証明する。
   * 戻り値: { amount: 受領額|null, pending: 精算未了か, involved: 日程/人数変更の精算が関与しているか, hasRecord, unresolved: 判別不能（集計しない） }
   */
  function receiptBasis_(r, price) {
    var state = String(r.feeSettlementState || '').trim();
    var paid = num_(r.feePaidAmount), refunded = num_(r.feeRefundedAmount) || 0;
    var stripe = num_(r.stripeAmount);
    var isCard = String(r.paymentMethod || '').trim() === CARD_METHOD;
    var hasRecord = paid !== null && paid > 0;
    var pending = state !== '' && state !== 'SETTLED';
    if (hasRecord) {
      /* カードで、記録された累計が当初のカード入金（Webhook検証済みの stripeAmount）に満たないときは、
         「追加分だけを記録した」のか「累計を記録した」のか台帳から判別できない。二重算入を避けるため集計しない（受領済みの可能性あり）。 */
      if (isCard && stripe !== null && stripe > 0 && paid < stripe) return { amount: null, pending: pending, involved: true, hasRecord: true, unresolved: true };
      return { amount: Math.max(0, paid - refunded), pending: pending, involved: true, hasRecord: true, unresolved: false };
    }
    if (pending) {
      /* 精算の記録が無い。当初のカード入金だけは、決済成功時にWebhookで検証済みの請求額（stripeAmount）で証明できる。
         追加請求・変更後の差額は未確定（実績に入れない）。返金の記録だけがあるときは差引を確定できない。 */
      if (isCard && stripe !== null && stripe > 0 && refunded === 0) return { amount: stripe, pending: true, involved: true, hasRecord: false, unresolved: false };
      return { amount: null, pending: true, involved: true, hasRecord: false, unresolved: false };
    }
    return { amount: price, pending: false, involved: state !== '', hasRecord: false, unresolved: false };
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
    var notes = { pendingCount: 0, bookingsOutOfYear: 0, optionUnmatchedCount: 0, cancelMonthUnknownCount: 0 };

    (input.bookings || []).forEach(function (r) {
      var ym = ymOfDate_(r.date);
      if (!ym) return;
      var endOrStart = r.endMs !== null && r.endMs !== undefined && r.endMs > r.startMs ? r.endMs : r.startMs;
      var passed = endOrStart <= nowMs;
      usage[r.bookingId] = { passed: passed, ym: ym, status: r.status };
      var svc = STUDIO_SERVICES.indexOf(r.service) !== -1 ? r.service : 'unclassified';
      var kind = paymentKind_(r.paymentStatus);
      var price = num_(r.effectivePriceAmount);
      var isCard = String(r.paymentMethod || '').trim() === CARD_METHOD;
      var basis = receiptBasis_(r, price);
      /*
       * 取消・返金に関わる予約（キャンセル料）は、オーナー確定（2026-11-20）により**取消確定月（cancelledAt・JST）**に計上する。
       * 元の利用予定月ではない。利用日による年フィルタより前に分岐し、年をまたぐ取消（翌年の予約を今年取り消す等）も取りこぼさない。
       * 取消確定日時が空・不正・未来のときは、利用予定月へフォールバックせず「取消計上月不明」として集計から除外する（金額に含めない）。
       */
      if (r.status === 'CANCELLED' || kind === 'refund') {
        if (kind !== 'paid' && kind !== 'refund') return; /* 受領なしの取消は売上にしない */
        var cMs = toMs_(r.cancelledAt);
        if (cMs === null || cMs > nowMs) { notes.cancelMonthUnknownCount++; return; }
        var cym = jstYearMonth_(cMs);
        if (cym.y !== year) return;
        var ccell = months[cym.m - 1].studio[svc];
        if (kind === 'refund') {
          ccell.refundedCount++;
          var net = refundNet_(r, basis.involved ? null : price); /* 日程変更の精算が関与する場合、2つの返金記録を突き合わせられないので確定しない */
          /* 返金完了（refunded）かつ差引額が確定しているときだけ残額を実績にする。返金中・方法不明・精算が絡むものは金額に含めない。 */
          if (String(r.paymentStatus).trim() !== 'refunded' || net === null) ccell.refundUnsettledCount++;
          else if (net > 0) { ccell.actual += net; ccell.retained += net; ccell.actualCount++; }
          return;
        }
        /* 取消でも paid のまま（返金なし）。返金方法が NONE と記録され、精算が関与しないときだけ全額を残額として計上。 */
        if (String(r.refundDecision || '').trim() === 'NONE' && price !== null && !basis.involved) { ccell.actual += price; ccell.retained += price; ccell.actualCount++; }
        else ccell.refundUnsettledCount++;
        return;
      }
      /* 以下は通常の予約（利用日基準）。 */
      if (ym.y !== year) { notes.bookingsOutOfYear++; return; }
      var cell = months[ym.m - 1].studio[svc];
      if (r.status === 'PENDING') { notes.pendingCount++; return; }
      if (r.status !== 'CONFIRMED') return; /* 失効・不明は売上にしない */
      if (price === null) { cell.unknownAmountCount++; return; }
      /* 明示的に記録された入金（feePaidAmount。現地払いの受領確認も含む）は、決済状態（旧来の paymentStatus）に関わらず受領額として扱う。 */
      if (passed && (kind === 'paid' || basis.hasRecord)) {
        /* 実績は「記録された受領額」。精算が未了（追加請求・返金待ち）で差額が未確定の分は実績に入れず、件数で示す。 */
        if (basis.amount !== null) { cell.actual += basis.amount; cell.actualCount++; }
        if (basis.unresolved) cell.receiptUnresolvedCount++; /* 受領済みの可能性があるが集計不可 */
        else if (basis.pending || basis.amount === null) cell.settlementPendingCount++;
      }
      else if (passed && !isCard) { cell.onsiteUnconfirmed += price; cell.onsiteUnconfirmedCount++; } /* 現地払い・受領記録なし（実績に入れない） */
      else if (passed) cell.unconfirmed += price; /* カード決済で利用済み・未入金（実績に入れない） */
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
      var studioActual = 0, studioSched = 0, studioUnconf = 0, refundedCount = 0, unknownAmount = 0, onsite = 0, onsiteCount = 0, unsettled = 0, retained = 0, settlePending = 0, unresolvedReceipt = 0;
      STUDIO_SERVICES.forEach(function (s) {
        var c = mo.studio[s]; studioActual += c.actual; studioSched += c.scheduled; studioUnconf += c.unconfirmed; refundedCount += c.refundedCount; unknownAmount += c.unknownAmountCount;
        onsite += c.onsiteUnconfirmed; onsiteCount += c.onsiteUnconfirmedCount; unsettled += c.refundUnsettledCount; retained += c.retained; settlePending += c.settlementPendingCount; unresolvedReceipt += c.receiptUnresolvedCount;
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
        unknownAmountCount: unknownAmount,
        onsiteUnconfirmed: onsite, onsiteUnconfirmedCount: onsiteCount, refundUnsettledCount: unsettled, retained: retained, settlementPendingCount: settlePending, receiptUnresolvedCount: unresolvedReceipt
      };
    });
    var totals = out.reduce(function (t, m) {
      t.actual += m.actual; t.scheduled += m.scheduled; t.unconfirmed += m.unconfirmed; t.refundedCount += m.refundedCount; t.unknownAmountCount += m.unknownAmountCount;
      t.onsiteUnconfirmed += m.onsiteUnconfirmed; t.onsiteUnconfirmedCount += m.onsiteUnconfirmedCount; t.refundUnsettledCount += m.refundUnsettledCount; t.retained += m.retained; t.settlementPendingCount += m.settlementPendingCount; t.receiptUnresolvedCount += m.receiptUnresolvedCount;
      return t;
    }, { actual: 0, scheduled: 0, unconfirmed: 0, refundedCount: 0, unknownAmountCount: 0, onsiteUnconfirmed: 0, onsiteUnconfirmedCount: 0, refundUnsettledCount: 0, retained: 0, settlementPendingCount: 0, receiptUnresolvedCount: 0 });
    /* 実績は「接続済み・確認済み額の部分計」。全体年商として確定できない理由を固定コードで返す（SNBC未接続は現状常に該当）。 */
    var partialReasons = [];
    if (sources.snbc.state !== 'ready') partialReasons.push('SNBC_NOT_CONNECTED');
    if (totals.onsiteUnconfirmedCount > 0) partialReasons.push('ONSITE_PAYMENT_UNCONFIRMED');
    if (totals.refundUnsettledCount > 0) partialReasons.push('REFUND_UNSETTLED');
    if (totals.settlementPendingCount > 0) partialReasons.push('SETTLEMENT_PENDING');
    if (totals.receiptUnresolvedCount > 0) partialReasons.push('RECEIPT_UNRESOLVED');
    if (notes.cancelMonthUnknownCount > 0) partialReasons.push('CANCEL_MONTH_UNKNOWN');
    if (totals.unknownAmountCount > 0) partialReasons.push('AMOUNT_UNKNOWN');
    if (sources.members.state !== 'ready') partialReasons.push('MEMBERS_UNAVAILABLE');
    if (sources.options.state !== 'ready') partialReasons.push('OPTIONS_UNAVAILABLE');
    if (notes.optionUnmatchedCount > 0) partialReasons.push('OPTION_UNMATCHED');
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
      basis: '実績売上＝利用日が過ぎ、かつ支払い済み（paid）のカード決済、取消後の残額（返金完了・差引額確定）、会員費（入金日）、有料オプション（紐づく予約の利用日）。現地払いは受領記録が無いため実績に含めず別枠。',
      sources: sources,
      partial: { isPartial: partialReasons.length > 0, reasons: partialReasons },
      months: out,
      totals: { actual: totals.actual, scheduled: totals.scheduled, unconfirmed: totals.unconfirmed, refundedCount: totals.refundedCount, unknownAmountCount: totals.unknownAmountCount,
        onsiteUnconfirmed: totals.onsiteUnconfirmed, onsiteUnconfirmedCount: totals.onsiteUnconfirmedCount, refundUnsettledCount: totals.refundUnsettledCount, retained: totals.retained, settlementPendingCount: totals.settlementPendingCount, receiptUnresolvedCount: totals.receiptUnresolvedCount, cancelMonthUnknownCount: notes.cancelMonthUnknownCount,
        studioByService: byService, options: optionsTotal, members: membersTotal },
      goals: goals,
      forecast: forecast,
      notes: { pendingCount: notes.pendingCount, optionUnmatchedCount: notes.optionUnmatchedCount }
    };
  }

  return { compute: compute, paymentKind: paymentKind_, GOALS: GOALS };
})();
