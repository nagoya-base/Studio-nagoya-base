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
 * - SNBCイベント収益（#995 PR-C）: 開催済み SNBCEvents の「受領額－返金済額」を**開催月（eventDate・JST）**に1行1回だけ計上する。直接経費は別表示で年商から引かない。
 *   スタジオ利用料の内部付替え・架空の会場売上は作らない。保存先未設定は「未接続」、読取失敗・ヘッダー不一致は「取得失敗」で、0円として扱わない。
 *   対象年に登録行が無ければ「未入力・要確認」。登録行があっても「記録済み分」の部分計（旧イベントは手入力の補完待ち）。
 * - 現地払い（#995 PR-C）: オーナーが手入力した受領確認（OnsiteReceipts。累計受領－累計返金済）を、台帳に受領記録（paid／feePaidAmount）が
 *   **無い**現地払いの予約に限り代替採用する（利用終了後に利用月へ）。台帳に受領記録がある・カード決済の予約は台帳を優先し、手入力は加算しない
 *   （両方ある場合は「受領記録重複」として要確認）。予約行が無い／重複IDの記録は「突合不可」。取消済みは、取消確定日時より後に更新された記録だけを
 *   取消確定月の残額として計上し、それ以前の記録は確定しない。見積り料金（priceAmount）は受領額とみなさない。
 * - 経費・利益は未接続（年商から差し引かない）。
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
    STUDIO_SERVICES.forEach(function (s) { studio[s] = { actual: 0, scheduled: 0, unconfirmed: 0, refundedCount: 0, unknownAmountCount: 0, actualCount: 0, retained: 0, onsiteUnconfirmed: 0, onsiteUnconfirmedCount: 0, refundUnsettledCount: 0, settlementPendingCount: 0, receiptUnresolvedCount: 0, onsiteRecorded: 0, onsiteRecordedCount: 0 }; });
    return { studio: studio, options: { actual: 0, scheduled: 0 }, members: { actual: 0 }, snbc: { actual: 0, count: 0, directCost: 0 } };
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
    var notes = { pendingCount: 0, bookingsOutOfYear: 0, optionUnmatchedCount: 0, cancelMonthUnknownCount: 0, optionInactiveCount: 0, onsiteDuplicateCount: 0, onsiteUnmatchedCount: 0, snbcFutureCount: 0 };
    /* #995: 現地払いの手入力受領（bookingId → 記録）。ready 以外は使わない。 */
    var onsiteById = {}, onsiteSeen = {};
    if (input.onsite && input.onsite.state === 'ready') (input.onsite.rows || []).forEach(function (o) { onsiteById[o.bookingId] = o; });

    var excluded = {}; /* #996: テスト・アタルの bookingId。売上（予約・キャンセル料・オプション）から除外する。 */
    (input.bookings || []).forEach(function (r) {
      if (OpsNormalizer.isTestBooking(r) || OpsNormalizer.isAtaruBooking(r)) { excluded[r.bookingId] = true; return; }
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
       * 現地払いの手入力受領（#995）。台帳に受領記録がある・カード決済の予約は台帳が正本で、手入力を足さない（両方あれば重複として要確認）。
       */
      var onsiteRec = onsiteById[r.bookingId] || null;
      var useOnsite = null;
      if (onsiteRec) {
        onsiteSeen[r.bookingId] = true;
        if (isCard || kind === 'paid' || kind === 'refund' || basis.hasRecord) notes.onsiteDuplicateCount++;
        else useOnsite = onsiteRec;
      }
      /*
       * 取消・返金に関わる予約（キャンセル料）は、オーナー確定（2026-11-20）により**取消確定月（cancelledAt・JST）**に計上する。
       * 元の利用予定月ではない。利用日による年フィルタより前に分岐し、年をまたぐ取消（翌年の予約を今年取り消す等）も取りこぼさない。
       * 取消確定日時が空・不正・未来のときは、利用予定月へフォールバックせず「取消計上月不明」として集計から除外する（金額に含めない）。
       */
      if (r.status === 'CANCELLED' || kind === 'refund') {
        if (useOnsite && r.status === 'CANCELLED') {
          /* 現地払いの取消: 取消確定日時より後に確認・更新された受領記録だけで残額を確定する（古い記録・返金処理中の記録から断定しない）。 */
          var oMs = toMs_(r.cancelledAt);
          if (oMs === null || oMs > nowMs) { notes.cancelMonthUnknownCount++; return; }
          var oym = jstYearMonth_(oMs);
          if (oym.y !== year) return;
          var ocell = months[oym.m - 1].studio[svc];
          var uMs = toMs_(useOnsite.updatedAt);
          if (uMs === null || uMs < oMs) { ocell.refundUnsettledCount++; return; }
          var onet = useOnsite.receivedJpy - useOnsite.refundedJpy;
          if (onet > 0) { ocell.actual += onet; ocell.retained += onet; ocell.actualCount++; ocell.onsiteRecorded += onet; ocell.onsiteRecordedCount++; }
          return;
        }
        if (kind !== 'paid' && kind !== 'refund' && !basis.hasRecord) return; /* 受領の記録がない取消は売上にしない */
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
        /* 現地払い等で、受領の記録（feePaidAmount）はあるが決済状態が paid でない取消は、残る額を確定できないので金額に含めず警告する。 */
        if (kind !== 'paid') { ccell.refundUnsettledCount++; return; }
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
      if (price === null && !(useOnsite && passed)) { cell.unknownAmountCount++; return; }
      /* 明示的に記録された入金（feePaidAmount。現地払いの受領確認も含む）は、決済状態（旧来の paymentStatus）に関わらず受領額として扱う。 */
      if (passed && (kind === 'paid' || basis.hasRecord)) {
        /* 実績は「記録された受領額」。精算が未了（追加請求・返金待ち）で差額が未確定の分は実績に入れず、件数で示す。 */
        if (basis.amount !== null) { cell.actual += basis.amount; cell.actualCount++; }
        if (basis.unresolved) cell.receiptUnresolvedCount++; /* 受領済みの可能性があるが集計不可 */
        else if (basis.pending || basis.amount === null) cell.settlementPendingCount++;
      }
      else if (passed && useOnsite) {
        /* 手入力の受領確認（累計受領－累計返金済）を、利用終了後に1回だけ実績へ。見積り料金は使わない。 */
        var onsiteNet = useOnsite.receivedJpy - useOnsite.refundedJpy;
        cell.actual += onsiteNet; cell.actualCount++; cell.onsiteRecorded += onsiteNet; cell.onsiteRecordedCount++;
      }
      else if (passed && !isCard) { cell.onsiteUnconfirmed += price; cell.onsiteUnconfirmedCount++; } /* 現地払い・受領記録なし（実績に入れない） */
      else if (passed) cell.unconfirmed += price; /* カード決済で利用済み・未入金（実績に入れない） */
      else cell.scheduled += price;
    });

    var sources = { studio: { state: 'ready' }, options: { state: 'not_connected' }, members: { state: 'not_connected' }, snbc: { state: 'not_connected' }, expenses: { state: 'not_connected' }, onsite: { state: 'not_connected' } };

    /* 現地払い記録の突合: 台帳に該当予約（有効な1行）が無い記録は「突合不可」（金額に含めない）。除外予約（テスト・アタル）は警告にも出さない。 */
    if (input.onsite && input.onsite.state === 'ready') {
      sources.onsite = { state: 'ready', skipped: input.onsite.skipped || 0 };
      Object.keys(onsiteById).forEach(function (id) { if (!onsiteSeen[id] && !excluded[id]) notes.onsiteUnmatchedCount++; });
    } else if (input.onsite) sources.onsite = { state: input.onsite.state || 'not_connected' };

    /* SNBCイベント（#995）。開催済みだけを開催月に1回計上。未来日の行は無視して警告（保存時にも拒否している）。 */
    if (input.snbc && input.snbc.state === 'ready') {
      sources.snbc = { state: 'ready', skipped: input.snbc.skipped || 0 };
      var todayText = new Date(nowMs + JST_MS).toISOString().slice(0, 10);
      (input.snbc.rows || []).forEach(function (e) {
        var eym = ymOfDate_(e.eventDate);
        if (!eym) return;
        if (e.eventDate > todayText) { notes.snbcFutureCount++; return; }
        if (eym.y !== year) return;
        var sc = months[eym.m - 1].snbc;
        sc.actual += e.receivedJpy - e.refundedJpy; sc.count++;
        if (typeof e.directCostJpy === 'number') sc.directCost += e.directCostJpy; /* 別表示のみ。年商から引かない */
      });
    } else if (input.snbc) sources.snbc = { state: input.snbc.state || 'not_connected' };

    if (input.options && input.options.state === 'ready') {
      sources.options = { state: 'ready' };
      (input.options.rows || []).forEach(function (o) {
        if (String(o.paymentStatus || '').trim() !== 'PAID' || String(o.status || '').trim() !== 'CONFIRMED') return;
        var amount = num_(o.amountJpy);
        if (amount === null || amount === 0) return;
        var oid = String(o.bookingId || '').trim();
        if (excluded[oid]) return; /* 除外予約のオプション。未確認警告にも出さない */
        var u = usage[oid];
        if (!u) { notes.optionUnmatchedCount++; return; }
        if (u.ym.y !== year) return;
        /* 取消・失効・仮予約に紐づく支払い済みオプション（返金判断が必要な状態）。実績に入れず、件数で警告する。 */
        if (u.status !== 'CONFIRMED') { notes.optionInactiveCount++; return; }
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
      var onsiteRec = 0, onsiteRecCount = 0;
      var studioActual = 0, studioSched = 0, studioUnconf = 0, refundedCount = 0, unknownAmount = 0, onsite = 0, onsiteCount = 0, unsettled = 0, retained = 0, settlePending = 0, unresolvedReceipt = 0;
      STUDIO_SERVICES.forEach(function (s) {
        var c = mo.studio[s]; studioActual += c.actual; studioSched += c.scheduled; studioUnconf += c.unconfirmed; refundedCount += c.refundedCount; unknownAmount += c.unknownAmountCount;
        onsite += c.onsiteUnconfirmed; onsiteCount += c.onsiteUnconfirmedCount; unsettled += c.refundUnsettledCount; retained += c.retained; settlePending += c.settlementPendingCount; unresolvedReceipt += c.receiptUnresolvedCount;
        onsiteRec += c.onsiteRecorded; onsiteRecCount += c.onsiteRecordedCount;
      });
      var optActual = sources.options.state === 'ready' ? mo.options.actual : 0;
      var memActual = sources.members.state === 'ready' ? mo.members.actual : 0;
      var snbcActual = sources.snbc.state === 'ready' ? mo.snbc.actual : 0;
      return {
        month: idx + 1,
        studio: mo.studio,
        options: { actual: mo.options.actual, scheduled: mo.options.scheduled },
        members: { actual: mo.members.actual },
        snbc: sources.snbc.state === 'ready' ? { actual: mo.snbc.actual, count: mo.snbc.count, directCost: mo.snbc.directCost } : { actual: 0, count: 0, directCost: 0 },
        onsiteRecorded: onsiteRec, onsiteRecordedCount: onsiteRecCount,
        actual: studioActual + optActual + memActual + snbcActual,
        scheduled: studioSched + (sources.options.state === 'ready' ? mo.options.scheduled : 0),
        unconfirmed: studioUnconf,
        refundedCount: refundedCount,
        unknownAmountCount: unknownAmount,
        onsiteUnconfirmed: onsite, onsiteUnconfirmedCount: onsiteCount, refundUnsettledCount: unsettled, retained: retained, settlementPendingCount: settlePending, receiptUnresolvedCount: unresolvedReceipt
      };
    });
    var totals = out.reduce(function (t, m) {
      t.actual += m.actual; t.scheduled += m.scheduled; t.unconfirmed += m.unconfirmed; t.refundedCount += m.refundedCount; t.unknownAmountCount += m.unknownAmountCount;
      t.snbc += m.snbc.actual; t.snbcCount += m.snbc.count; t.snbcDirectCost += m.snbc.directCost; t.onsiteRecorded += m.onsiteRecorded; t.onsiteRecordedCount += m.onsiteRecordedCount;
      t.onsiteUnconfirmed += m.onsiteUnconfirmed; t.onsiteUnconfirmedCount += m.onsiteUnconfirmedCount; t.refundUnsettledCount += m.refundUnsettledCount; t.retained += m.retained; t.settlementPendingCount += m.settlementPendingCount; t.receiptUnresolvedCount += m.receiptUnresolvedCount;
      return t;
    }, { snbc: 0, snbcCount: 0, snbcDirectCost: 0, onsiteRecorded: 0, onsiteRecordedCount: 0, actual: 0, scheduled: 0, unconfirmed: 0, refundedCount: 0, unknownAmountCount: 0, onsiteUnconfirmed: 0, onsiteUnconfirmedCount: 0, refundUnsettledCount: 0, retained: 0, settlementPendingCount: 0, receiptUnresolvedCount: 0 });
    /* 実績は「接続済み・確認済み額の部分計」。全体年商として確定できない理由を固定コードで返す（SNBC未接続は現状常に該当）。 */
    var partialReasons = [];
    if (sources.snbc.state === 'not_connected') partialReasons.push('SNBC_NOT_CONNECTED');
    else if (sources.snbc.state !== 'ready') partialReasons.push('SNBC_UNAVAILABLE');
    else {
      /* 登録行があっても「記録済み分」。旧イベントの補完状況はこの表から判別できないため、全体年商とは断定しない。 */
      partialReasons.push(totals.snbcCount === 0 ? 'SNBC_NO_RECORDS' : 'SNBC_RECORDED_ONLY');
      if (sources.snbc.skipped > 0) partialReasons.push('SNBC_ROWS_SKIPPED');
      if (notes.snbcFutureCount > 0) partialReasons.push('SNBC_FUTURE_ROWS');
    }
    if (sources.onsite.state === 'error') partialReasons.push('ONSITE_RECORDS_UNAVAILABLE');
    if (sources.onsite.state === 'ready' && sources.onsite.skipped > 0) partialReasons.push('ONSITE_ROWS_SKIPPED');
    if (notes.onsiteDuplicateCount > 0) partialReasons.push('ONSITE_RECEIPT_DUPLICATE');
    if (notes.onsiteUnmatchedCount > 0) partialReasons.push('ONSITE_RECEIPT_UNMATCHED');
    if (totals.onsiteUnconfirmedCount > 0) partialReasons.push('ONSITE_PAYMENT_UNCONFIRMED');
    if (totals.refundUnsettledCount > 0) partialReasons.push('REFUND_UNSETTLED');
    if (totals.settlementPendingCount > 0) partialReasons.push('SETTLEMENT_PENDING');
    if (totals.receiptUnresolvedCount > 0) partialReasons.push('RECEIPT_UNRESOLVED');
    if (notes.cancelMonthUnknownCount > 0) partialReasons.push('CANCEL_MONTH_UNKNOWN');
    if (totals.unknownAmountCount > 0) partialReasons.push('AMOUNT_UNKNOWN');
    if (sources.members.state !== 'ready') partialReasons.push('MEMBERS_UNAVAILABLE');
    if (sources.options.state !== 'ready') partialReasons.push('OPTIONS_UNAVAILABLE');
    if (notes.optionUnmatchedCount > 0) partialReasons.push('OPTION_UNMATCHED');
    if (notes.optionInactiveCount > 0) partialReasons.push('OPTION_ON_INACTIVE_BOOKING');
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
      basis: '実績売上＝利用日が過ぎ、かつ支払い済み（paid）のカード決済、取消後の残額（返金完了・差引額確定）、会員費（入金日）、有料オプション（紐づく予約の利用日）。現地払いは、台帳に受領記録があるもの＋オーナーが手入力で受領確認したもの（利用終了後）だけを実績に含め、記録が無いものは別枠。SNBCイベントは記録済みの開催済み分を開催月に計上（経費は引かない）。',
      sources: sources,
      partial: { isPartial: partialReasons.length > 0, reasons: partialReasons },
      months: out,
      totals: { actual: totals.actual, scheduled: totals.scheduled, unconfirmed: totals.unconfirmed, refundedCount: totals.refundedCount, unknownAmountCount: totals.unknownAmountCount,
        onsiteUnconfirmed: totals.onsiteUnconfirmed, onsiteUnconfirmedCount: totals.onsiteUnconfirmedCount, refundUnsettledCount: totals.refundUnsettledCount, retained: totals.retained, settlementPendingCount: totals.settlementPendingCount, receiptUnresolvedCount: totals.receiptUnresolvedCount, cancelMonthUnknownCount: notes.cancelMonthUnknownCount,
        studioByService: byService, options: optionsTotal, members: membersTotal,
        snbc: sources.snbc.state === 'ready' ? totals.snbc : 0, snbcCount: sources.snbc.state === 'ready' ? totals.snbcCount : 0, snbcDirectCost: sources.snbc.state === 'ready' ? totals.snbcDirectCost : 0,
        onsiteRecorded: totals.onsiteRecorded, onsiteRecordedCount: totals.onsiteRecordedCount, onsiteDuplicateCount: notes.onsiteDuplicateCount, onsiteUnmatchedCount: notes.onsiteUnmatchedCount },
      goals: goals,
      forecast: forecast,
      notes: { pendingCount: notes.pendingCount, optionUnmatchedCount: notes.optionUnmatchedCount, optionInactiveCount: notes.optionInactiveCount, snbcFutureCount: notes.snbcFutureCount }
    };
  }

  /* 台帳に受領記録がある（paid／返金系／feePaidAmount>0）か。現地払いの手入力受領を重ねてよいかの判定に使う（#995）。 */
  function hasLedgerReceipt(r) {
    var kind = paymentKind_(r.paymentStatus);
    var paid = num_(r.feePaidAmount);
    return kind === 'paid' || kind === 'refund' || (paid !== null && paid > 0);
  }

  return { compute: compute, paymentKind: paymentKind_, hasLedgerReceipt: hasLedgerReceipt, CARD_METHOD: CARD_METHOD, GOALS: GOALS };
})();
