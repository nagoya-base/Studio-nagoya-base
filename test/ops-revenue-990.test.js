/*
 * 年商（売上）KPI（Issue #990 PR-B）のテスト。データはすべて架空。
 * 計上基準（オーナー確定）: 実績売上＝利用日が過ぎ、かつ支払い済み（paid）。80万/130万は年商目標（利益ではない）。
 * 実際にGASへ貼る gas/ops-reservations/ のファイルをvmで実行して検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var DIR = path.join(__dirname, '..', 'gas', 'ops-reservations');
var FRONT = path.join(__dirname, '..', '_ops-app', 'frontend');
var R = require(path.join(FRONT, 'revenue-client.js'));
var Gas = require(path.join(FRONT, 'gas-adapter.js'));

var NOW = Date.UTC(2026, 10, 20, 3, 0, 0); /* 2026-11-20 12:00 JST */

function load() {
  var sb = { Logger: { log: function () {} } };
  vm.createContext(sb);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsRevenue.gs', 'OpsRevenueStore.gs', 'OpsRevenueRecords.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
  });
  return sb;
}
var SB = load();

function jst(y, m, d, hh, mm) { return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)); }
var CARD = 'オンラインクレジットカード';
var HEADER = ['bookingId', 'date', 'startAt', 'endAt', 'brand', 'status', 'paymentStatus', 'priceAmount', 'priceOverrideAmount', 'priceOverrideAt', 'name', 'paymentMethod', 'refundDecision', 'refundAmount', 'feePaidAmount', 'feeRefundedAmount', 'feeSettlementState', 'stripeAmount', 'cancelledAt'];
function booking(id, over) {
  var b = Object.assign({ bookingId: id, date: '2026-11-10', startAt: jst(2026, 11, 10, 10, 0), endAt: jst(2026, 11, 10, 12, 0), brand: 'snb', status: 'CONFIRMED', paymentStatus: 'paid', priceAmount: 10000, priceOverrideAmount: '', priceOverrideAt: '', name: 'SECRET-NAME', paymentMethod: CARD, refundDecision: '', refundAmount: '', feePaidAmount: '', feeRefundedAmount: '', feeSettlementState: '', stripeAmount: '', cancelledAt: '' }, over || {});
  /* 取消・返金の予約には、既定で取消確定日時（2026-11-10。既定の利用日と同月）を入れる。個別に上書きできる。 */
  if (!over || !('cancelledAt' in over)) { if (b.status === 'CANCELLED' || /refund/.test(String(b.paymentStatus))) b.cancelledAt = jst(2026, 11, 10, 9, 0); }
  return HEADER.map(function (h) { return b[h]; });
}
function ledger(rows) { return { values: [HEADER].concat(rows) }; }

function call(rows, extra, params, records) {
  var ctx = {
    authenticate: function () { return { ok: true }; }, nowMs: NOW,
    readLedger: function () { return ledger(rows); },
    readRevenueSources: function () { return extra || { options: { state: 'not_connected' }, members: { state: 'not_connected' } }; },
    readRecords: function () { return records || { snbc: { state: 'not_connected' }, onsite: { state: 'not_connected' } }; } /* #995: 既定は保存先未設定 */
  };
  return JSON.parse(JSON.stringify(SB.OpsApi.handle({ op: 'revenue', params: params }, ctx)));
}

test('計上基準: 実績＝利用が過ぎ、かつ paid。未入金は実績に入れず別枠、将来は予定。返金方法が不明な返金は確定しない。PENDING/キャンセルは売上にしない', function () {
  var res = call([
    booking('A1'),                                                                                     /* 実績 10,000 (SNB) */
    booking('A2', { brand: 'mens', priceAmount: 5000 }),                                               /* 実績 5,000 (Mens) */
    booking('A3', { brand: 'studio_x', priceAmount: 7000 }),                                           /* 実績 7,000 */
    booking('B1', { paymentStatus: 'not_started', priceAmount: 4000 }),                                /* 利用済み・入金未確認 */
    booking('B2', { paymentStatus: '', priceAmount: 1000 }),                                           /* 同上 */
    booking('B3', { paymentStatus: 'mystery_value', priceAmount: 2000 }),                              /* 未知の決済状態は支払い済みと断定しない */
    booking('C1', { date: '2026-12-05', startAt: jst(2026, 12, 5, 10, 0), endAt: jst(2026, 12, 5, 12, 0), priceAmount: 6000 }),  /* 予定 */
    booking('C2', { date: '2026-12-06', startAt: jst(2026, 12, 6, 10, 0), endAt: jst(2026, 12, 6, 12, 0), paymentStatus: 'not_started', priceAmount: 3000 }), /* 予定（未入金でも予定） */
    booking('D1', { paymentStatus: 'refunded', priceAmount: 9999 }),                                   /* 返金 */
    booking('D2', { paymentStatus: 'refund_pending', priceAmount: 9999 }),
    booking('E1', { status: 'CANCELLED', paymentStatus: 'not_started', priceAmount: 8888 }),
    booking('E2', { status: 'EXPIRED', priceAmount: 8888 }),
    booking('E3', { status: 'PENDING', priceAmount: 8888 }),
    booking('F1', { priceAmount: '' }),                                                                /* 金額不明 */
    booking('G1', { priceAmount: 3000, priceOverrideAmount: 2500, priceOverrideAt: jst(2026, 11, 1, 9, 0) }), /* 修正額が優先 */
    booking('H1', { date: '2025-12-31', startAt: jst(2025, 12, 31, 10, 0), endAt: jst(2025, 12, 31, 12, 0), priceAmount: 70000 })  /* 前年 */
  ]);
  assert.strictEqual(res.ok, true);
  var t = res.revenue.totals;
  assert.strictEqual(t.studioByService.snb, 10000 + 2500);
  assert.strictEqual(t.studioByService.snb_mens, 5000);
  assert.strictEqual(t.studioByService.studio_x, 7000);
  assert.strictEqual(t.actual, 10000 + 2500 + 5000 + 7000);
  assert.strictEqual(t.unconfirmed, 4000 + 1000 + 2000);
  assert.strictEqual(t.scheduled, 6000 + 3000);
  assert.strictEqual(t.refundedCount, 2);
  assert.strictEqual(t.refundUnsettledCount, 2, '返金方法が記録されていない返金は差引額を確定しない');
  assert.strictEqual(t.unknownAmountCount, 1);
  assert.strictEqual(res.revenue.notes.pendingCount, 1);
  assert.strictEqual(res.revenue.months[10].actual, t.actual, '11月に計上');
  assert.strictEqual(res.revenue.months[11].scheduled, 9000, '12月は予定のみ');
  assert.strictEqual(res.revenue.months[11].actual, 0);
});

test('当日の利用: 終了前は予定、終了後は実績。終了が不明なときは開始時刻で判定', function () {
  var res = call([
    booking('N1', { date: '2026-11-20', startAt: jst(2026, 11, 20, 10, 0), endAt: jst(2026, 11, 20, 11, 59), priceAmount: 1000 }),
    booking('N2', { date: '2026-11-20', startAt: jst(2026, 11, 20, 13, 0), endAt: jst(2026, 11, 20, 15, 0), priceAmount: 2000 }),
    booking('N3', { date: '2026-11-20', startAt: jst(2026, 11, 20, 9, 0), endAt: '', priceAmount: 4000 })
  ]);
  assert.strictEqual(res.revenue.months[10].actual, 1000 + 4000);
  assert.strictEqual(res.revenue.months[10].scheduled, 2000);
});

test('目標: 80万/130万は年商の達成率・残額・基準月額・必要月平均。予定は達成率に入れない。年末見込は予測として別', function () {
  var res = call([booking('A1', { priceAmount: 200000 }), booking('S1', { date: '2026-12-10', startAt: jst(2026, 12, 10, 10, 0), endAt: jst(2026, 12, 10, 12, 0), priceAmount: 500000 })]);
  var g = res.revenue.goals;
  assert.deepStrictEqual(g.map(function (x) { return [x.id, x.amount]; }), [['base', 800000], ['upper', 1300000]]);
  assert.strictEqual(g[0].rate, 0.25);
  assert.strictEqual(g[0].remaining, 600000);
  assert.ok(Math.abs(g[0].monthlyBase - 66666.666) < 1);
  assert.ok(Math.abs(g[1].monthlyBase - 108333.333) < 1);
  assert.strictEqual(g[0].requiredMonthlyAverage, 600000 / 2, '当月（11月）を含む残り2か月');
  assert.strictEqual(res.revenue.totals.actual, 200000, '予定50万円は実績に入らない');
  assert.ok(res.revenue.forecast > 200000 && typeof res.revenue.forecast === 'number');
  assert.ok(/年商|売上/.test(res.revenue.basis) && !/利益目標/.test(res.revenue.basis));
});

test('過去の年: 年末見込・必要月平均は出さない。対象年は検証される', function () {
  var past = call([booking('P1', { date: '2025-06-01', startAt: jst(2025, 6, 1, 10, 0), endAt: jst(2025, 6, 1, 12, 0), priceAmount: 5000 })], null, { year: 2025 });
  assert.strictEqual(past.revenue.totals.actual, 5000);
  assert.strictEqual(past.revenue.forecast, null);
  assert.strictEqual(past.revenue.goals[0].requiredMonthlyAverage, null);
  assert.strictEqual(past.revenue.months[5].actual, 5000);
  ['2026', 1999, 3000, 2026.5, null].forEach(function (y, i) {
    var r = call([], null, { year: y });
    if (y === null) assert.strictEqual(r.ok, true, '省略扱い'); else assert.strictEqual(r.error.code, 'INVALID_PARAMS', String(y));
  });
});

test('会員費・有料オプション: 重複・全額返金・未連携・未払いを数えない。未接続ソースは0円にしない', function () {
  var extra = {
    options: { state: 'ready', rows: [
      { bookingId: 'A1', amountJpy: 3000, paymentStatus: 'PAID', status: 'CONFIRMED' },          /* 利用済み予約 → 実績 */
      { bookingId: 'S1', amountJpy: 2000, paymentStatus: 'PAID', status: 'CONFIRMED' },          /* 将来予約 → 予定 */
      { bookingId: 'A1', amountJpy: 999, paymentStatus: 'NOT_STARTED', status: 'AWAITING_PAYMENT' },
      { bookingId: 'NOPE', amountJpy: 500, paymentStatus: 'PAID', status: 'CONFIRMED' },          /* 予約に紐づかない */
      { bookingId: 'A1', amountJpy: 0, paymentStatus: 'PAID', status: 'CONFIRMED' }
    ] },
    members: { state: 'ready',
      periods: [{ sourceType: 'invoice', sourceId: 'in_1', amount: 1000, paidAt: jst(2026, 11, 3, 10, 0) }, { sourceType: 'invoice', sourceId: 'in_2', amount: 1000, paidAt: jst(2026, 10, 3, 10, 0) }],
      months: [{ sourceType: 'invoice', sourceId: 'in_1', amount: 1000, paidAt: jst(2026, 11, 3, 10, 0) } /* 重複 */, { sourceType: 'invoice', sourceId: 'in_old', amount: 1000, paidAt: jst(2026, 2, 3, 10, 0) }, { sourceType: 'invoice', sourceId: 'in_future', amount: 1000, paidAt: jst(2026, 12, 3, 10, 0) }],
      refunds: [{ sourceType: 'invoice', sourceId: 'in_2' }] }
  };
  var res = call([booking('A1', { priceAmount: 10000 }), booking('S1', { date: '2026-12-05', startAt: jst(2026, 12, 5, 10, 0), endAt: jst(2026, 12, 5, 12, 0), priceAmount: 6000 })], extra);
  var t = res.revenue.totals;
  assert.strictEqual(t.options, 3000);
  assert.strictEqual(t.members, 1000 + 1000, '重複・全額返金・未来の入金は除く');
  assert.strictEqual(t.actual, 10000 + 3000 + 2000);
  assert.strictEqual(t.scheduled, 6000 + 2000);
  assert.strictEqual(res.revenue.notes.optionUnmatchedCount, 1);

  var none = call([booking('A1')], { options: { state: 'error' }, members: { state: 'not_connected' } });
  assert.strictEqual(none.revenue.sources.options.state, 'error');
  assert.strictEqual(none.revenue.sources.members.state, 'not_connected');
  assert.strictEqual(none.revenue.sources.snbc.state, 'not_connected');
  assert.strictEqual(none.revenue.sources.expenses.state, 'not_connected');
});

test('API: 認可必須・予約台帳の取得失敗は集計を返さない・追加ソース例外は未取得にして続行・個人情報は返さない', function () {
  var denied = SB.OpsApi.handle({ op: 'revenue' }, { authenticate: function () { return { ok: false, code: 'FORBIDDEN' }; }, nowMs: NOW });
  assert.strictEqual(denied.error.code, 'FORBIDDEN');
  var failed = SB.OpsApi.handle({ op: 'revenue' }, { authenticate: function () { return { ok: true }; }, nowMs: NOW, readLedger: function () { throw new Error('boom'); } });
  assert.strictEqual(failed.ok, false);
  assert.ok(!failed.revenue);
  var boom = SB.OpsApi.handle({ op: 'revenue' }, { authenticate: function () { return { ok: true }; }, nowMs: NOW, readLedger: function () { return ledger([booking('A1')]); }, readRevenueSources: function () { throw new Error('SECRET'); } });
  assert.strictEqual(boom.ok, true);
  assert.strictEqual(boom.revenue.sources.options.state, 'error');
  assert.ok(!/SECRET/.test(JSON.stringify(boom)), '例外本文・氏名を返さない');
  var ok = call([booking('A1')]);
  assert.ok(!/SECRET|A1/.test(JSON.stringify(ok)), '氏名・予約IDを返さない');
});

test('API: 読めない行（除外）は件数で返す', function () {
  var res = call([booking('A1'), booking('A1')]); /* 重複ID → 除外 */
  assert.ok(res.excludedRows >= 1);
});

/* ---------- 読取り専用・読む列の許可リスト ---------- */
test('読取り: 追加シートは Sheets API の GET だけで、許可した列（金額・日付・識別子）以外を要求しない', function () {
  var requests = [];
  var world = {
    'OptionOrders': [['optionOrderId', 'bookingId', 'amountJpy', 'paymentStatus', 'status', 'customerEmail'], ['O1', 'A1', 3000, 'PAID', 'CONFIRMED', 'SECRET-MAIL@example.invalid']]
  };
  var out = JSON.parse(JSON.stringify(SB.OpsSource.readSheet({
    spreadsheetId: 'FAKE', getToken: function () { return 'TOKEN'; },
    fetch: function (url, options) {
      requests.push({ url: decodeURIComponent(url), method: options.method });
      var u = decodeURIComponent(url);
      if (/fields=/.test(u)) return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify({ properties: { timeZone: 'Asia/Tokyo' }, sheets: [{ properties: { title: 'OptionOrders' } }] }); } };
      if (/!1:1/.test(u)) return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify({ values: [world.OptionOrders[0]] }); } };
      var ranges = (u.match(/ranges='OptionOrders'!([A-Z]+)2:/g) || []);
      var cols = ranges.map(function (r) { return r.match(/!([A-Z]+)2/)[1]; });
      return { getResponseCode: function () { return 200; }, getContentText: function () {
        return JSON.stringify({ valueRanges: cols.map(function (c) { var i = c.charCodeAt(0) - 65; return { values: [[world.OptionOrders[1][i]]] }; }) });
      } };
    }
  }, { sheetName: 'OptionOrders', columns: ['bookingId', 'amountJpy', 'paymentStatus', 'status'], dateColumns: [] })));
  assert.deepStrictEqual(out[0], ['bookingId', 'amountJpy', 'paymentStatus', 'status']);
  assert.deepStrictEqual(out[1], ['A1', 3000, 'PAID', 'CONFIRMED']);
  assert.ok(requests.every(function (r) { return r.method === 'get'; }));
  assert.ok(!/customerEmail|SECRET/.test(JSON.stringify(out)));
  var data = requests.filter(function (r) { return /batchGet/.test(r.url); })[0].url;
  assert.ok(!/!F2:F/.test(data), 'customerEmail列（F）は要求しない');
});

test('アダプター: 売上は新規の読取り関数 opsGetRevenue のみ（書込み・外部送信なし）', function () {
  var seen = [];
  var runner = { withSuccessHandler: function (ok) { return { withFailureHandler: function () { return new Proxy({}, { get: function (_, n) { return function (a) { seen.push([n, a]); ok({ ok: true }); }; } }); } }; } };
  Gas.createGasApi(runner).revenue({ year: 2026 }, function () {}, function () {});
  assert.deepStrictEqual(seen, [['opsGetRevenue', { year: 2026 }]]);
});

/* ---------- 画面 ---------- */
function resp(over) {
  var r = (call([booking('A1', { priceAmount: 200000 })], { options: { state: 'ready', rows: [] }, members: { state: 'ready', periods: [], months: [], refunds: [] } }));
  return Object.assign(r, over || {});
}
function stateOf(data, over) { return Object.assign({ phase: 'ready', data: data, error: null, year: 2026, goal: 'base', mock: false }, over || {}); }

test('画面: 年累計の実績・達成率・残額・基準月額・月次達成度・別枠・SNBC未接続を表示する', function () {
  var html = R.renderRevenue(stateOf(resp()));
  assert.ok(/¥200,000/.test(html) && /¥800,000/.test(html) && /達成率 25\.0%/.test(html) && /残額 ¥600,000/.test(html));
  assert.ok(/基準月額 ¥66,667/.test(html) && /月次達成度 300\.0%/.test(html));
  assert.ok(/参考予測/.test(html) && /予測であり、達成率には含めません/.test(html));
  assert.ok(/SNBC イベント収益<\/span><b class="dim">未接続/.test(html));
  assert.ok(/経費・利益<\/span><b class="dim">未接続（売上達成率から差し引きません）/.test(html));
  assert.ok(/data-rev="month" data-month="2026-11"/.test(html));
  var upper = R.renderRevenue(stateOf(resp(), { goal: 'upper' }));
  assert.ok(/達成率 15\.3%/.test(upper) && /基準月額 ¥108,333/.test(upper));
});

test('画面: 取得失敗・権限なし・未接続ソース・除外行・金額不明は「0円」にせず不完全を明示する', function () {
  assert.ok(/0円という意味ではありません/.test(R.renderRevenue({ phase: 'error', data: null, error: { message: '売上の取得に失敗しました。' }, year: 2026, goal: 'base' })));
  assert.ok(/権限がありません/.test(R.renderRevenue({ phase: 'denied', data: null, error: {}, year: 2026, goal: 'base' })));
  var d = resp({ excludedRows: 2 });
  d.revenue.sources.members = { state: 'not_connected' }; d.revenue.sources.options = { state: 'error' };
  d.revenue.totals.unknownAmountCount = 3;
  var html = R.renderRevenue(stateOf(d));
  assert.ok(/実績は不完全です/.test(html) && /会員費は未接続/.test(html) && /有料オプションの取得に失敗/.test(html) && /2 件が読み込めず/.test(html) && /金額が読めない確定予約が 3 件/.test(html));
  assert.ok(/<span>会員費（入金日基準）<\/span><b class="dim">未接続/.test(html) && /<span>有料オプション<\/span><b class="dim">取得失敗/.test(html));
  var stale = R.renderRevenue(stateOf(resp(), { phase: 'error', error: { message: 'x' } }));
  assert.ok(/古い内容を表示しています/.test(stale));
});

test('画面: エスケープと、売上と利益の混同がないこと', function () {
  var d = resp(); d.revenue.basis = '<script>alert(1)</script>';
  var html = R.renderRevenue(stateOf(d));
  assert.ok(html.indexOf('<script>') === -1 && /&lt;script&gt;/.test(html));
  assert.ok(!/利益目標|利益率/.test(html));
});

test('制御: 年の切替は古い応答を破棄し、権限なしでは表示を消す', function () {
  var pending = [];
  var api = { revenue: function (p, ok) { pending.push({ p: p, ok: ok }); } };
  var c = R.createController(api, null, { year: 2026 });
  c.load(); c.setYear(2025);
  pending[0].ok(resp()); /* 古い（2026）応答 */
  assert.strictEqual(c.state.data, null, '古い応答は採用しない');
  pending[1].ok(Object.assign(resp(), {}));
  assert.strictEqual(c.state.phase, 'ready');
  c.load();
  pending[2].ok({ ok: false, error: { code: 'FORBIDDEN', message: 'x' } });
  assert.strictEqual(c.state.phase, 'denied');
  assert.strictEqual(c.state.data, null);
});

test('レビュー対応(#992): キャンセル後に返金状態になった予約も返金件数に数える（金額は合算しない）', function () {
  var res = call([
    booking('R1', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 9000, refundDecision: 'FULL', refundAmount: 9000 }),
    booking('R2', { status: 'CANCELLED', paymentStatus: 'refund_pending', priceAmount: 9000, refundDecision: 'FULL', refundAmount: 9000 }),
    booking('R3', { status: 'CANCELLED', paymentStatus: 'not_started', priceAmount: 9000 })
  ]);
  assert.strictEqual(res.revenue.totals.refundedCount, 2);
  assert.strictEqual(res.revenue.totals.actual, 0);
  assert.strictEqual(res.revenue.totals.unconfirmed, 0);
});

test('レビュー対応(#992): 必須列が欠けた追加シートは ready にせず、0円・不完全でなくエラー状態にする', function () {
  function sheetWith(header) {
    return function (url) {
      var u = decodeURIComponent(url);
      var ok = function (o) { return { getResponseCode: function () { return 200; }, getContentText: function () { return JSON.stringify(o); } }; };
      if (/fields=/.test(u)) return ok({ properties: { timeZone: 'Asia/Tokyo' }, sheets: [{ properties: { title: 'OptionOrders' } }] });
      if (/!1:1/.test(u)) return ok({ values: [header] });
      return ok({ valueRanges: [] });
    };
  }
  var spec = { sheetName: 'OptionOrders', columns: ['bookingId', 'amountJpy', 'paymentStatus', 'status'], dateColumns: [], required: ['bookingId', 'amountJpy', 'paymentStatus', 'status'] };
  var deps = function (header) { return { spreadsheetId: 'FAKE', getToken: function () { return 'T'; }, fetch: sheetWith(header) }; };
  assert.throws(function () { SB.OpsSource.readSheet(deps(['bookingId', 'amountJpy', 'status']), spec); }, function (e) { return e.opsCode === 'SCHEMA_MISMATCH'; });
  assert.doesNotThrow(function () { SB.OpsSource.readSheet(deps(['bookingId', 'amountJpy', 'paymentStatus', 'status']), spec); });
  var api = fs.readFileSync(path.join(DIR, 'OpsApi.gs'), 'utf8');
  assert.ok(/required: specs\[i\]\.columns/.test(api), '売上の追加シートは全列を必須にする');
});

test('レビュー対応(#992): ホームの再取得は売上も一緒に更新する', function () {
  var H = require(path.join(FRONT, 'home-client.js'));
  var els = {};
  function el(id) { if (!els[id]) els[id] = { id: id, value: '', hidden: false, innerHTML: '', textContent: '', _l: {}, addEventListener: function (t, f) { (this._l[t] = this._l[t] || []).push(f); }, setAttribute: function () {}, getAttribute: function () { return null; }, click: function () {} }; return els[id]; }
  var calls = [];
  var res = { state: {}, getFilters: function () { return { service: 'all', status: 'active', scope: 'custom', from: '2026-11-01', to: '2026-11-30' }; }, setFilters: function () {}, reload: function () { calls.push('res'); }, closeDetail: function () {} };
  var tasks = { state: {}, load: function () { calls.push('tasks'); } };
  H.mount({ getElementById: el }, { res: res, tasks: tasks, revenue: { load: function () { calls.push('revenue'); } }, now: function () { return NOW; } });
  calls.length = 0;
  el('home-reload')._l.click[0]({});
  assert.deepStrictEqual(calls.sort(), ['res', 'revenue', 'tasks']);
});

test('レビュー対応(#992): 紐づく予約のない支払い済みオプションは「実績は不完全です」で件数を示す', function () {
  var d = resp(); d.revenue.notes.optionUnmatchedCount = 2;
  var html = R.renderRevenue(stateOf(d));
  assert.ok(/実績は不完全です/.test(html) && /紐づく予約が見つからない支払い済みオプションが 2 件/.test(html));
  var clean = R.renderRevenue(stateOf(resp()));
  assert.ok(!/紐づく予約が見つからない/.test(clean));
});

/* ---------- タケルレビュー(#992) P1: 現地払い・取消返金 ---------- */
test('P1: 現地払い（現金・PayPay）は受領記録が無いので実績に入れず「現地払い・受領記録なし」として別枠。カードpaidは実績', function () {
  var res = call([
    booking('K1', { priceAmount: 10000 }),                                                                 /* カードpaid → 実績 */
    booking('K2', { paymentMethod: '現地払い（現金）', paymentStatus: 'not_started', priceAmount: 6000 }),  /* 現地・利用済み（NOT_STARTEDのまま） → 受領未確認 */
    booking('K3', { paymentMethod: '現地払い（PayPay）', paymentStatus: '', priceAmount: 4000 }),
    booking('K4', { paymentMethod: '現地払い（現金）', paymentStatus: 'paid', priceAmount: 1500 }),          /* 台帳に paid と記録済み → 実績 */
    booking('K5', { paymentMethod: '現地払い（現金）', date: '2026-12-05', startAt: jst(2026, 12, 5, 10, 0), endAt: jst(2026, 12, 5, 12, 0), priceAmount: 3000 }), /* 現地・これから → 予定 */
    booking('K6', { paymentStatus: 'not_started', priceAmount: 2000 })                                      /* カード未入金・利用済み → 別枠（現地払いではない） */
  ]);
  var t = res.revenue.totals;
  assert.strictEqual(t.actual, 10000 + 1500);
  assert.strictEqual(t.onsiteUnconfirmed, 6000 + 4000);
  assert.strictEqual(t.onsiteUnconfirmedCount, 2);
  assert.strictEqual(t.unconfirmed, 2000);
  assert.strictEqual(t.scheduled, 3000);
  assert.ok(res.revenue.partial.isPartial && res.revenue.partial.reasons.indexOf('ONSITE_PAYMENT_UNCONFIRMED') !== -1);
});

test('P1: 取消の返金方法（全額/一部/なし/返金中/結果不明）で差引額を安全に計上する', function () {
  var res = call([
    booking('F1', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'FULL', refundAmount: 6000 }),   /* 全額返金完了 → 0 */
    booking('F2', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: 2000 }), /* 一部返金完了 → 残額4,000 */
    booking('F3', { status: 'CANCELLED', paymentStatus: 'paid', priceAmount: 3000, refundDecision: 'NONE', refundAmount: 0 }),            /* 返金なし → 全額3,000 */
    booking('F4', { status: 'CANCELLED', paymentStatus: 'refund_pending', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: 2000 }), /* 返金中 → 確定しない */
    booking('F5', { status: 'CANCELLED', paymentStatus: 'paid', priceAmount: 5000 }),                                                       /* 取消・paid・返金方法の記録なし → 確定しない */
    booking('F6', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: 9000 }),  /* 返金額が受領額超過（不正） → 確定しない */
    booking('F7', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: '' }),    /* 返金額が不明 → 確定しない */
    booking('F8', { status: 'CANCELLED', paymentStatus: 'not_started', priceAmount: 7000 })                                                 /* 受領なしの取消 → 売上なし・要確認でもない */
  ]);
  var t = res.revenue.totals;
  assert.strictEqual(t.actual, 4000 + 3000);
  assert.strictEqual(t.retained, 4000 + 3000);
  assert.strictEqual(t.refundUnsettledCount, 4, 'F4・F5・F6・F7');
  assert.strictEqual(t.refundedCount, 5, 'F1・F2・F4・F6・F7（返金状態の予約）');
  assert.strictEqual(t.unconfirmed, 0);
  assert.ok(res.revenue.partial.reasons.indexOf('REFUND_UNSETTLED') !== -1);
  assert.ok(!/SECRET/.test(JSON.stringify(res)));
});

test('P1: 部分計の明示 — SNBC未接続の間は常に部分計（全体年商の確定達成率ではない）', function () {
  var res = call([booking('A1', { priceAmount: 1000 })], { options: { state: 'ready', rows: [] }, members: { state: 'ready', periods: [], months: [], refunds: [] } });
  assert.deepStrictEqual(res.revenue.partial.reasons, ['SNBC_NOT_CONNECTED']);
  assert.strictEqual(res.revenue.partial.isPartial, true);
});

test('P1: 画面は実績を「確認済み額の部分計」と表示し、達成率も部分計に対するものと明記。現地払い・返金の未確定を別枠で出す', function () {
  var d = resp();
  d.revenue.totals.onsiteUnconfirmed = 10000; d.revenue.totals.onsiteUnconfirmedCount = 2; d.revenue.totals.refundUnsettledCount = 3;
  d.revenue.partial = { isPartial: true, reasons: ['SNBC_NOT_CONNECTED', 'ONSITE_PAYMENT_UNCONFIRMED', 'REFUND_UNSETTLED'] };
  var html = R.renderRevenue(stateOf(d));
  assert.ok(/確認済み額の部分計/.test(html) && /全体の年商ではありません/.test(html));
  assert.ok(/部分計に対する達成率/.test(html) && !/確定達成率/.test(html.replace(/確定達成率とは扱いません/g, '')));
  assert.ok(/現地払い・受領記録なし/.test(html) && /¥10,000/.test(html) && /2件/.test(html));
  assert.ok(/返金処理中・結果不明/.test(html) && /3件/.test(html));
  assert.ok(/SNBC/.test(html) && /未接続ソースあり/.test(html));
});

/* ---------- Codex P1(#992): 日程変更後の受領額 ---------- */
test('P1(Codex): 日程変更で料金が上がっても、精算が未了なら見積り額を実績にしない（確認済みの入出金累計だけ）', function () {
  var res = call([
    booking('S1', { priceAmount: 6000, priceOverrideAmount: 10000, priceOverrideAt: jst(2026, 11, 9, 9, 0), feePaidAmount: 6000, feeRefundedAmount: 0, feeSettlementState: 'PENDING_CHARGE' }), /* 6,000受領・10,000に変更・追加請求待ち */
    booking('S2', { priceAmount: 6000, priceOverrideAmount: 10000, priceOverrideAt: jst(2026, 11, 9, 9, 0), feeSettlementState: 'PENDING_CHARGE' }),                          /* 受領の記録なし → 金額に含めない */
    booking('S3', { priceAmount: 10000, priceOverrideAmount: 4000, priceOverrideAt: jst(2026, 11, 9, 9, 0), feePaidAmount: 10000, feeRefundedAmount: 0, feeSettlementState: 'PENDING_REFUND' }), /* 値下げ・返金待ち：受領10,000のまま */
    booking('S4', { priceAmount: 6000, priceOverrideAmount: 10000, priceOverrideAt: jst(2026, 11, 9, 9, 0), feePaidAmount: 10000, feeRefundedAmount: 0, feeSettlementState: 'SETTLED' }),     /* 追加分も受領・精算済み → 記録の10,000 */
    booking('S5', { priceAmount: 6000, feeSettlementState: 'SETTLED' })                                                                                                                  /* 精算済み・累計の記録なし → 料金 */
  ]);
  var t = res.revenue.totals;
  assert.strictEqual(t.actual, 6000 + 0 + 10000 + 10000 + 6000);
  assert.strictEqual(t.settlementPendingCount, 3, 'S1・S2・S3');
  assert.ok(res.revenue.partial.reasons.indexOf('SETTLEMENT_PENDING') !== -1);
});

test('P1(Codex): 取消の返金で、日程変更の精算が絡む予約は2つの返金記録を突き合わせられないので確定しない', function () {
  var res = call([
    booking('X1', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, priceOverrideAmount: 10000, priceOverrideAt: jst(2026, 11, 9, 9, 0), refundDecision: 'PARTIAL', refundAmount: 2000, feePaidAmount: 6000, feeSettlementState: 'PENDING_CHARGE' }),
    booking('X2', { status: 'CANCELLED', paymentStatus: 'paid', priceAmount: 6000, refundDecision: 'NONE', refundAmount: 0, feePaidAmount: 6000, feeSettlementState: 'SETTLED' }),
    booking('X3', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: 2000 }) /* 精算の関与なし → 4,000 */
  ]);
  var t = res.revenue.totals;
  assert.strictEqual(t.actual, 4000);
  assert.strictEqual(t.refundUnsettledCount, 2);
});

test('P1(Codex): 画面は精算未了の件数と、部分計の理由を表示する', function () {
  var d = resp();
  d.revenue.totals.settlementPendingCount = 2;
  d.revenue.partial = { isPartial: true, reasons: ['SNBC_NOT_CONNECTED', 'SETTLEMENT_PENDING'] };
  var html = R.renderRevenue(stateOf(d));
  assert.ok(/日程・人数変更の精算が未了/.test(html) && /2件/.test(html) && /受領額の差額が確定していない/.test(html));
});

test('P2(Codex): 精算の記録（feePaidAmount）がある現地払いは、paymentStatus が未更新でも受領済みとして実績に入れる。記録のない現地払いは除外のまま', function () {
  var res = call([
    booking('L1', { paymentMethod: '現地払い（現金）', paymentStatus: 'not_started', priceAmount: 10000, feePaidAmount: 10000, feeRefundedAmount: 0, feeSettlementState: 'SETTLED' }), /* 確認済みの受領 → 実績 */
    booking('L2', { paymentMethod: '現地払い（PayPay）', paymentStatus: 'not_started', priceAmount: 5000 }),                                                                        /* 記録なし → 受領記録なし */
    booking('L3', { paymentMethod: '現地払い（現金）', paymentStatus: 'not_started', priceAmount: 8000, feePaidAmount: 3000, feeRefundedAmount: 1000, feeSettlementState: 'PENDING_CHARGE' }) /* 受領2,000のみ確認・差額未了 */
  ]);
  var t = res.revenue.totals;
  assert.strictEqual(t.actual, 10000 + 2000);
  assert.strictEqual(t.onsiteUnconfirmed, 5000);
  assert.strictEqual(t.onsiteUnconfirmedCount, 1);
  assert.strictEqual(t.settlementPendingCount, 1);
});

/* ---------- タケル再レビュー(#992) 要判断1: 精算未了時の当初カード入金 ---------- */
test('当初のカード入金は stripeAmount（Webhook検証済み）で証明し、精算の記録が無くても丸ごと落とさない。追加分は二重算入しない', function () {
  var res = call([
    booking('C1', { priceAmount: 6000, priceOverrideAmount: 10000, priceOverrideAt: jst(2026, 11, 9, 9, 0), feeSettlementState: 'PENDING_CHARGE', stripeAmount: 6000 }),  /* 記録なし・追加請求待ち → 当初の6,000だけ */
    booking('C2', { priceAmount: 6000, priceOverrideAmount: 10000, priceOverrideAt: jst(2026, 11, 9, 9, 0), feeSettlementState: 'PENDING_CHARGE', stripeAmount: 6000, feePaidAmount: 10000 }), /* 累計10,000（当初を含む）→ 10,000 */
    booking('C3', { priceAmount: 6000, priceOverrideAmount: 10000, priceOverrideAt: jst(2026, 11, 9, 9, 0), feeSettlementState: 'PENDING_CHARGE', stripeAmount: 6000, feePaidAmount: 4000 }),  /* 4,000＜当初6,000：追加分だけか累計か判別不能 → 集計しない */
    booking('C4', { priceAmount: 6000, feeSettlementState: 'PENDING_REFUND', stripeAmount: 6000, feeRefundedAmount: 2000 }),                                                              /* 返金の記録だけ → 差引確定不可 */
    booking('C5', { paymentMethod: '現地払い（現金）', paymentStatus: 'not_started', priceAmount: 4000, feePaidAmount: 1000, feeSettlementState: 'PENDING_CHARGE' })                      /* 現地払いはstripeAmountなし。記録の1,000だけ */
  ]);
  var t = res.revenue.totals;
  assert.strictEqual(t.actual, 6000 + 10000 + 0 + 0 + 1000);
  assert.strictEqual(t.receiptUnresolvedCount, 1, 'C3');
  assert.strictEqual(t.settlementPendingCount, 4, 'C1・C2（PENDING）・C4・C5');
  assert.ok(res.revenue.partial.reasons.indexOf('RECEIPT_UNRESOLVED') !== -1);
});

test('画面: 受領済みの可能性があるが集計不可の件数と理由を表示する', function () {
  var d = resp();
  d.revenue.totals.receiptUnresolvedCount = 2;
  d.revenue.partial = { isPartial: true, reasons: ['SNBC_NOT_CONNECTED', 'RECEIPT_UNRESOLVED'] };
  var html = R.renderRevenue(stateOf(d));
  assert.ok(/受領済みの可能性があるが集計不可/.test(html) && /2件/.test(html) && /二重算入を避ける/.test(html));
});

/* ---------- タケル再レビュー(#992) P1: キャンセル料は取消確定月（cancelledAt・JST）に計上 ---------- */
test('P1: キャンセル料は取消確定月に計上する（2026-12-20利用予定・2026-11-20取消・6,000円受領・2,000円一部返金完了 → 11月に4,000円、12月は0円）', function () {
  var res = call([booking('Z1', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: 2000,
    date: '2026-12-20', startAt: jst(2026, 12, 20, 10, 0), endAt: jst(2026, 12, 20, 12, 0), cancelledAt: jst(2026, 11, 20, 9, 0) })]);
  var m = res.revenue.months;
  assert.strictEqual(m[10].actual, 4000, '11月');
  assert.strictEqual(m[11].actual, 0, '12月');
  assert.strictEqual(res.revenue.totals.retained, 4000);
});

test('P1: 年をまたぐ取消 — 2027-01利用予定を2026-11に取消（返金なし）は2026年の実績。2026年の予定を2025年に取消したものは2026年に入れない', function () {
  var res = call([
    booking('Y1', { status: 'CANCELLED', paymentStatus: 'paid', priceAmount: 5000, refundDecision: 'NONE', refundAmount: 0, date: '2027-01-15', startAt: jst(2027, 1, 15, 10, 0), endAt: jst(2027, 1, 15, 12, 0), cancelledAt: jst(2026, 11, 5, 9, 0) }),
    booking('Y2', { status: 'CANCELLED', paymentStatus: 'paid', priceAmount: 7000, refundDecision: 'NONE', refundAmount: 0, date: '2026-03-15', startAt: jst(2026, 3, 15, 10, 0), endAt: jst(2026, 3, 15, 12, 0), cancelledAt: jst(2025, 12, 28, 9, 0) })
  ]);
  assert.strictEqual(res.revenue.totals.actual, 5000);
  assert.strictEqual(res.revenue.months[10].actual, 5000, '取消確定月（11月）');
  assert.strictEqual(res.revenue.months[2].actual, 0, '利用予定月（3月）には入れない');
  var y25 = call([booking('Y2', { status: 'CANCELLED', paymentStatus: 'paid', priceAmount: 7000, refundDecision: 'NONE', refundAmount: 0, date: '2026-03-15', startAt: jst(2026, 3, 15, 10, 0), endAt: jst(2026, 3, 15, 12, 0), cancelledAt: jst(2025, 12, 28, 9, 0) })], null, { year: 2025 });
  assert.strictEqual(y25.revenue.months[11].actual, 7000, '2025年12月の実績');
});

test('P1: 取消確定日時が空・不正・未来のときは利用予定月へフォールバックせず「取消計上月不明」で除外。受領なしの取消は数えない。月境界はJST', function () {
  var base = { status: 'CANCELLED', paymentStatus: 'paid', priceAmount: 5000, refundDecision: 'NONE', refundAmount: 0 };
  var res = call([
    booking('U1', Object.assign({}, base, { cancelledAt: '' })),
    booking('U2', Object.assign({}, base, { cancelledAt: 'not a date' })),
    booking('U3', Object.assign({}, base, { cancelledAt: jst(2027, 1, 5, 9, 0) })),   /* 未来 */
    booking('U4', { status: 'CANCELLED', paymentStatus: 'not_started', priceAmount: 5000, cancelledAt: '' }), /* 受領なし：数えない */
    booking('U5', Object.assign({}, base, { cancelledAt: new Date(Date.UTC(2026, 9, 31, 15, 30)) })) /* UTC 10/31 15:30 = JST 11/1 00:30 → 11月 */
  ]);
  var t = res.revenue.totals;
  assert.strictEqual(t.cancelMonthUnknownCount, 3);
  assert.strictEqual(t.actual, 5000);
  assert.strictEqual(res.revenue.months[10].actual, 5000, 'JSTの11月');
  assert.ok(res.revenue.partial.reasons.indexOf('CANCEL_MONTH_UNKNOWN') !== -1);
});

test('P1: FULL・NONE・PARTIAL・返金中・返金額不明を取消確定月で正しく扱う', function () {
  var c = jst(2026, 11, 20, 9, 0);
  var res = call([
    booking('M1', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'FULL', refundAmount: 6000, cancelledAt: c }),
    booking('M2', { status: 'CANCELLED', paymentStatus: 'paid', priceAmount: 3000, refundDecision: 'NONE', refundAmount: 0, cancelledAt: c }),
    booking('M3', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: 2000, cancelledAt: c }),
    booking('M4', { status: 'CANCELLED', paymentStatus: 'refund_pending', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: 2000, cancelledAt: c }),
    booking('M5', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 6000, refundDecision: 'PARTIAL', refundAmount: '', cancelledAt: c })
  ]);
  assert.strictEqual(res.revenue.months[10].actual, 3000 + 4000);
  assert.strictEqual(res.revenue.totals.refundUnsettledCount, 2);
});

test('画面: 取消計上月不明の件数を表示し、月の行は利用日ベースの一覧であることを明記する', function () {
  var d = resp(); d.revenue.totals.cancelMonthUnknownCount = 2;
  d.revenue.partial = { isPartial: true, reasons: ['SNBC_NOT_CONNECTED', 'CANCEL_MONTH_UNKNOWN'] };
  var html = R.renderRevenue(stateOf(d));
  assert.ok(/取消計上月不明/.test(html) && /2件/.test(html) && /利用予定月へは振り替えず/.test(html));
  assert.ok(/利用日ベース/.test(html) && /取消確定月/.test(html));
});

test('レビュー対応(#992): 取消・失効に紐づく支払い済みオプションは実績に入れず、件数で警告する', function () {
  var extra = { options: { state: 'ready', rows: [
    { bookingId: 'OC', amountJpy: 3000, paymentStatus: 'PAID', status: 'CONFIRMED' },
    { bookingId: 'OE', amountJpy: 2000, paymentStatus: 'PAID', status: 'CONFIRMED' },
    { bookingId: 'OK', amountJpy: 1000, paymentStatus: 'PAID', status: 'CONFIRMED' }
  ] }, members: { state: 'ready', periods: [], months: [], refunds: [] } };
  var res = call([
    booking('OC', { status: 'CANCELLED', paymentStatus: 'not_started', priceAmount: 5000 }),
    booking('OE', { status: 'EXPIRED', priceAmount: 5000 }),
    booking('OK', { priceAmount: 5000 })
  ], extra);
  assert.strictEqual(res.revenue.totals.options, 1000);
  assert.strictEqual(res.revenue.notes.optionInactiveCount, 2);
  assert.ok(res.revenue.partial.reasons.indexOf('OPTION_ON_INACTIVE_BOOKING') !== -1);
  var d = resp(); d.revenue.notes.optionInactiveCount = 2;
  assert.ok(/取消・失効・仮予約に紐づく支払い済みオプションが 2 件/.test(R.renderRevenue(stateOf(d))));
});

test('レビュー対応(#992): 受領記録のある現地払いの取消は、残る額を確定できないので黙って落とさず「返金処理中・結果不明」に数える', function () {
  var res = call([
    booking('Q1', { status: 'CANCELLED', paymentMethod: '現地払い（現金）', paymentStatus: 'not_started', priceAmount: 10000, feePaidAmount: 10000, feeSettlementState: 'SETTLED' }),
    booking('Q2', { status: 'CANCELLED', paymentMethod: '現地払い（現金）', paymentStatus: 'not_started', priceAmount: 10000 }) /* 受領の記録なし：数えない */
  ]);
  assert.strictEqual(res.revenue.totals.refundUnsettledCount, 1);
  assert.strictEqual(res.revenue.totals.actual, 0);
});

/* ---- Issue #996: テスト・アタルの除外 ---- */
test('#996 売上: テスト(TEST含む)・アタルは予約・キャンセル料・オプションから除外。テスト太郎/testは対象外。警告も出ない', function () {
  var cancelled = { status: 'CANCELLED', paymentStatus: 'paid', refundDecision: 'NONE', priceAmount: 3000 };
  var res = call([
    booking('T1', { name: 'TEST' }), booking('T2', { name: ' テスト ' }),
    booking('T3', Object.assign({ name: 'Test' }, cancelled)),
    booking('AT', { name: 'アタル', priceAmount: 4000 }),
    booking('N1', { name: 'テスト太郎', priceAmount: 1000 }), booking('N2', { name: 'test', priceAmount: 2000 })
  ], {
    options: { state: 'ready', rows: [
      { bookingId: 'T1', amountJpy: 500, paymentStatus: 'PAID', status: 'CONFIRMED' },
      { bookingId: 'AT', amountJpy: 700, paymentStatus: 'PAID', status: 'CONFIRMED' }
    ] }, members: { state: 'not_connected' }
  });
  var r = res.revenue;
  assert.strictEqual(r.totals.actual, 1000 + 2000, '一般の2件のみ');
  assert.strictEqual(r.totals.options, 0);
  assert.strictEqual(r.notes.optionUnmatchedCount, 0, '除外予約のオプションは未確認警告にしない');
  assert.strictEqual(r.totals.refundUnsettledCount, 0);
});

test('#996 一覧: テストは非表示、アタルは表示、台帳は変更しない', function () {
  var rows = [booking('T1', { name: 'TEST' }), booking('T2', { name: 'ぬし' }), booking('AT', { name: 'アタル' }), booking('N1', { name: 'test' })];
  var ctx = { authenticate: function () { return { ok: true }; }, nowMs: NOW, readLedger: function () { return ledger(rows); } };
  var res = JSON.parse(JSON.stringify(SB.OpsApi.handle({ op: 'list', params: { from: '2026-11-01', to: '2026-11-30' } }, ctx)));
  assert.strictEqual(res.ok, true);
  var ids = res.items.map(function (i) { return i.bookingId; }).sort();
  assert.deepStrictEqual(ids, ['AT', 'N1']);
  assert.strictEqual(res.counts.valid, 2);
});
