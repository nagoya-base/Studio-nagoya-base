/*
 * revenue-client.js — 年商（売上）目標の達成状況と月次KPI（Issue #990 PR-B）。
 *
 * - 集計はバックエンド（OpsRevenue.gs）が行う。ここは応答を描画するだけで、金額を計算し直したり推計したりしない
 *   （達成率の表示用の割り算と、表示上の丸めのみ）。
 * - 80万円・130万円は年商（売上）目標。利益ではない。経費・利益・SNBCイベント収益は未接続なら「未接続」と表示し、0円にしない。
 * - 実績（利用が過ぎ、かつ支払い済み）／予定／利用済み・入金未確認／返金は別項目。予定は達成率に入れない。
 * - 取得失敗・権限なし・一部ソース未接続・台帳の読めない行は、実績が不完全であることを明示する。
 * - 描画は文字列をすべてエスケープする。個人名・予約IDは扱わない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.OpsRevenueClient = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DENIED_CODES = ['UNAUTHENTICATED', 'FORBIDDEN'];
  var SERVICE_LABELS = { snb: 'SNB', snb_mens: 'SNB Mens', studio_x: 'Studio X', unclassified: '未分類（ブランド不明）' };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function yen(n) { return '¥' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  /* 達成率は切り捨て（100%未満を100%と見せない）。 */
  function pct(rate) { return (Math.floor(rate * 1000) / 10).toFixed(1) + '%'; }
  function bar(rate) { return '<span class="rbar" aria-hidden="true"><span style="width:' + Math.min(100, Math.max(0, Math.floor(rate * 100))) + '%"></span></span>'; }

  function createController(api, onChange, options) {
    var opts = options || {};
    var state = { phase: 'idle', data: null, error: null, year: opts.year || null, goal: 'base', mock: !!(api && api.kind === 'mock') };
    var seq = 0;
    function emit() { if (onChange) onChange(state); }
    function load() {
      var mine = ++seq;
      state.phase = state.data ? 'refreshing' : 'loading'; state.error = null; emit();
      var params = state.year ? { year: state.year } : {};
      if (!api || typeof api.revenue !== 'function') { state.phase = 'error'; state.error = { message: 'この画面では売上を取得できません。' }; emit(); return; }
      api.revenue(params, function (res) {
        if (mine !== seq) return;
        if (res && res.ok) { state.data = res; state.phase = 'ready'; if (!state.year) state.year = res.revenue.year; }
        else if (res && res.error && DENIED_CODES.indexOf(res.error.code) !== -1) { state.data = null; state.phase = 'denied'; state.error = res.error; }
        else { state.phase = 'error'; state.error = res && res.error ? res.error : { message: '売上の取得に失敗しました。' }; }
        emit();
      }, function () {
        if (mine !== seq) return;
        state.phase = 'error'; state.error = { message: '売上の取得に失敗しました（通信エラー）。' }; emit();
      });
    }
    function setYear(y) { state.year = Number(y); state.data = null; load(); }
    function setGoal(id) { state.goal = id === 'upper' ? 'upper' : 'base'; emit(); }
    return { state: state, load: load, setYear: setYear, setGoal: setGoal };
  }

  function sourceNote(name, src) {
    if (!src || src.state === 'ready') return null;
    return src.state === 'error' ? name + 'の取得に失敗しました（金額に含めていません）' : name + 'は未接続です（金額に含めていません）';
  }

  var PARTIAL_TEXT = {
    SNBC_NOT_CONNECTED: 'SNBCイベント収益が未接続（正本が未実装）',
    ONSITE_PAYMENT_UNCONFIRMED: '現地払い（現金・PayPay）の受領記録が台帳にない予約がある',
    REFUND_UNSETTLED: '返金処理中または返金方法が不明な取消がある',
    CANCEL_MONTH_UNKNOWN: '取消確定日時が不明で、キャンセル料の計上月を判断できない取消がある（利用予定月へは振り替えず除外）',
    RECEIPT_UNRESOLVED: '受領済みの可能性があるが、精算の記録が当初のカード入金に満たず集計できない予約がある（二重算入を避けるため除外）',
    SETTLEMENT_PENDING: '日程・人数変更の精算（追加請求・返金）が未了で、受領額の差額が確定していない予約がある',
    AMOUNT_UNKNOWN: '金額が読めない確定予約がある',
    MEMBERS_UNAVAILABLE: '会員費を取得できていない',
    OPTIONS_UNAVAILABLE: '有料オプションを取得できていない',
    OPTION_UNMATCHED: '紐づく予約のない支払い済みオプションがある'
  };
  function partialText(reasons) {
    var list = (reasons || []).map(function (c) { return PARTIAL_TEXT[c]; }).filter(Boolean);
    return list.length ? '未接続ソースあり・未確定の項目あり: ' + list.map(esc).join(' ／ ') + '。' : '';
  }

  function renderMonths(rev, goalAmount, year) {
    var base = goalAmount / 12;
    var rows = rev.months.map(function (m) {
      var future = rev.currentMonth !== null && m.month > rev.currentMonth;
      var ym = year + '-' + (m.month < 10 ? '0' : '') + m.month;
      var rate = base > 0 ? m.actual / base : 0;
      return '<li><button type="button" class="mrow' + (rev.currentMonth === m.month ? ' cur' : '') + '" data-rev="month" data-month="' + esc(ym) + '">' +
        '<span class="mname">' + m.month + '月</span>' +
        '<span class="mval">' + (future && m.actual === 0 ? '<span class="dim">—</span>' : esc(yen(m.actual))) + '</span>' +
        bar(rate) + '<span class="mrate">' + (future && m.actual === 0 ? '' : esc(pct(rate))) + '</span></button></li>';
    }).join('');
    return '<ul class="mlist">' + rows + '</ul><p class="note">月の行を押すと、その月の予約一覧（利用日ベース）を開きます。売上の計上月は、キャンセル料が取消確定月、会員費が入金月のため、一覧の件数・金額とは一致しない場合があります。</p>';
  }

  function renderRevenue(state) {
    var head = '<h2 class="sec">年商の達成状況（売上・暦年）</h2>';
    var mock = state.mock ? '<div class="banner stale">モックデータ（架空）です。実際の売上ではありません。</div>' : '';
    if (state.phase === 'idle' || (state.phase === 'loading' && !state.data)) return head + mock + '<div class="banner loading" role="status">売上を取得中…</div>';
    if (state.phase === 'denied') return head + '<div class="banner err">売上を表示する権限がありません。</div>';
    if (state.phase === 'error' && !state.data) return head + mock + '<div class="banner err">' + esc(state.error && state.error.message || '売上の取得に失敗しました。') + '（0円という意味ではありません）<br><button type="button" class="inline" data-rev="retry">売上を再取得</button></div>';
    var d = state.data, rev = d.revenue;
    var goal = rev.goals.filter(function (g) { return g.id === state.goal; })[0] || rev.goals[0];
    var t = rev.totals;
    var html = head + mock;
    if (state.phase === 'error') html += '<div class="banner stale">最新の取得に失敗しました。古い内容を表示しています。</div>';
    var incomplete = [];
    var n1 = sourceNote('会員費', rev.sources.members), n2 = sourceNote('有料オプション', rev.sources.options);
    if (n1) incomplete.push(n1); if (n2) incomplete.push(n2);
    if (d.excludedRows > 0) incomplete.push('台帳の ' + d.excludedRows + ' 件が読み込めず一覧から除外されています');
    if (rev.notes && rev.notes.optionUnmatchedCount > 0) incomplete.push('紐づく予約が見つからない支払い済みオプションが ' + rev.notes.optionUnmatchedCount + ' 件あります（金額に含めていません）');
    if (t.unknownAmountCount > 0) incomplete.push('金額が読めない確定予約が ' + t.unknownAmountCount + ' 件あります（金額に含めていません）');
    if (incomplete.length) html += '<div class="banner stale" role="alert"><strong>実績は不完全です：</strong>' + incomplete.map(esc).join(' ／ ') + '</div>';

    html += '<div class="rtabs" role="group" aria-label="目標の切替">' + rev.goals.map(function (g) {
      return '<button type="button" class="chip" data-rev="goal" data-goal="' + esc(g.id) + '" aria-pressed="' + (g.id === goal.id ? 'true' : 'false') + '">' + esc(g.label) + ' ' + esc(yen(g.amount)) + '</button>';
    }).join('') + '</div>';
    var part = rev.partial || { isPartial: false, reasons: [] };
    if (part.isPartial) html += '<div class="banner stale" role="note"><strong>この金額は「接続済み・確認済み額の部分計」です。全体の年商ではありません。</strong>' + partialText(part.reasons) + '</div>';
    html += '<div class="rhero"><div class="rlabel">' + esc(rev.year) + '年の実績売上（確認済み額の部分計・年累計）</div><div class="rnum">' + esc(yen(t.actual)) + '<small> / ' + esc(yen(goal.amount)) + '</small></div>' +
      bar(goal.rate) + '<div class="rsub"><strong>達成率 ' + esc(pct(goal.rate)) + '</strong>' + (part.isPartial ? '（部分計に対する達成率。確定達成率とは扱いません）' : '') + ' ・ 残額 ' + esc(yen(goal.remaining)) + '</div>';
    if (goal.requiredMonthlyAverage !== null) html += '<div class="rsub">達成に必要な月平均（当月を含む残り月数で割った値）: ' + esc(yen(goal.requiredMonthlyAverage)) + '</div>';
    if (rev.forecast !== null) html += '<div class="rsub dim">参考予測: ' + esc(yen(rev.forecast)) + '（年初からの実績ペースが続いた場合の年末見込。予測であり、達成率には含めません）</div>';
    html += '</div>';

    if (rev.currentMonth !== null) {
      var cur = rev.months[rev.currentMonth - 1], prev = rev.currentMonth > 1 ? rev.months[rev.currentMonth - 2] : null;
      var rate = goal.monthlyBase > 0 ? cur.actual / goal.monthlyBase : 0;
      html += '<div class="rmonth"><div class="rlabel">当月（' + rev.currentMonth + '月）の実績 / 基準月額 ' + esc(yen(goal.monthlyBase)) + '（年間目標÷12）</div>' +
        '<div class="rnum sm">' + esc(yen(cur.actual)) + '</div>' + bar(rate) +
        '<div class="rsub"><strong>月次達成度 ' + esc(pct(rate)) + '</strong>' + (prev ? ' ・ 前月比 ' + (cur.actual - prev.actual >= 0 ? '+' : '−') + esc(yen(Math.abs(cur.actual - prev.actual))) + '（前月 ' + esc(yen(prev.actual)) + '）' : '') + '</div></div>';
    }

    html += '<h3 class="sub3">内訳（年累計の実績売上）</h3><ul class="rbreak">';
    ['snb', 'snb_mens', 'studio_x'].forEach(function (s) { html += '<li><span>' + esc(SERVICE_LABELS[s]) + '</span><b>' + esc(yen(t.studioByService[s])) + '</b></li>'; });
    if (t.studioByService.unclassified > 0) html += '<li><span>' + esc(SERVICE_LABELS.unclassified) + '</span><b>' + esc(yen(t.studioByService.unclassified)) + '</b></li>';
    html += '<li><span>会員費（入金日基準）</span>' + (rev.sources.members.state === 'ready' ? '<b>' + esc(yen(t.members)) + '</b>' : '<b class="dim">' + (rev.sources.members.state === 'error' ? '取得失敗' : '未接続') + '</b>') + '</li>';
    html += '<li><span>有料オプション</span>' + (rev.sources.options.state === 'ready' ? '<b>' + esc(yen(t.options)) + '</b>' : '<b class="dim">' + (rev.sources.options.state === 'error' ? '取得失敗' : '未接続') + '</b>') + '</li>';
    html += '<li><span>SNBC イベント収益</span><b class="dim">未接続（正本が未実装）</b></li></ul>';

    html += '<h3 class="sub3">実績に含めない項目（別枠）</h3><ul class="rbreak">' +
      '<li><span>予定（確定済み・利用がこれから）</span><b>' + esc(yen(t.scheduled)) + '</b></li>' +
      '<li><span>現地払い・受領記録なし（現金・PayPay等。受領済みでも台帳に記録がないため実績に入れていません）</span><b>' + esc(yen(t.onsiteUnconfirmed || 0)) + '（' + esc(t.onsiteUnconfirmedCount || 0) + '件）</b></li>' +
      '<li><span>カード決済で利用済み・未入金</span><b>' + esc(yen(t.unconfirmed)) + '</b></li>' +
      '<li><span>日程・人数変更の精算が未了（受領が確認できた額だけを実績に入れ、差額は未確定）</span><b>' + esc(t.settlementPendingCount || 0) + '件</b></li>' +
      '<li><span>受領済みの可能性があるが集計不可（精算の記録が当初のカード入金に満たない）</span><b>' + esc(t.receiptUnresolvedCount || 0) + '件</b></li>' +
      '<li><span>取消計上月不明（取消確定日時が不明・集計から除外）</span><b>' + esc(t.cancelMonthUnknownCount || 0) + '件</b></li>' +
      '<li><span>返金処理中・結果不明（差引額を確定できず金額に含めていません）</span><b>' + esc(t.refundUnsettledCount || 0) + '件</b></li>' +
      '<li><span>返金（件数のみ）</span><b>' + esc(t.refundedCount) + '件</b></li>' +
      '<li><span>経費・利益</span><b class="dim">未接続（売上達成率から差し引きません）</b></li></ul>';
    html += '<h3 class="sub3">月別の実績</h3>' + renderMonths(rev, goal.amount, rev.year);
    html += '<p class="note">計上基準: ' + esc(rev.basis) + ' 最終取得 ' + esc((d.fetchedAt || '').slice(0, 16).replace('T', ' ')) + '</p>';
    return html;
  }

  /* DOMへの結線。opts.onDrill({ month: 'YYYY-MM' }) で月の予約一覧へ移る。 */
  function mount(doc, api, options) {
    var opts = options || {};
    function $(id) { return doc.getElementById(id); }
    var now = opts.now ? opts.now() : Date.now();
    var curYear = new Date(now + 9 * 3600 * 1000).getUTCFullYear();
    $('rev-year').innerHTML = [curYear - 1, curYear].map(function (y) { return '<option value="' + y + '">' + y + '年</option>'; }).join('');
    var ctl = createController(api, function (state) {
      if (state.year) $('rev-year').value = String(state.year);
      $('revenue-view').innerHTML = renderRevenue(state);
      if (opts.onChange) opts.onChange(state);
    }, { year: curYear });
    $('rev-year').addEventListener('change', function () { ctl.setYear($('rev-year').value); });
    $('revenue-view').addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== $('revenue-view')) {
        var act = node.getAttribute && node.getAttribute('data-rev');
        if (act === 'goal') { ctl.setGoal(node.getAttribute('data-goal')); return; }
        if (act === 'retry') { ctl.load(); return; }
        if (act === 'month') { if (opts.onDrill) opts.onDrill({ month: node.getAttribute('data-month') }); return; }
        node = node.parentNode;
      }
    });
    ctl.load();
    return ctl;
  }

  return { esc: esc, yen: yen, pct: pct, createController: createController, renderRevenue: renderRevenue, mount: mount };
});
