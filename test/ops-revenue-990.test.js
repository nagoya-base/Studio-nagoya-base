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
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsRevenue.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
  });
  return sb;
}
var SB = load();

function jst(y, m, d, hh, mm) { return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)); }
var HEADER = ['bookingId', 'date', 'startAt', 'endAt', 'brand', 'status', 'paymentStatus', 'priceAmount', 'priceOverrideAmount', 'priceOverrideAt', 'name'];
function booking(id, over) {
  var b = Object.assign({ bookingId: id, date: '2026-11-10', startAt: jst(2026, 11, 10, 10, 0), endAt: jst(2026, 11, 10, 12, 0), brand: 'snb', status: 'CONFIRMED', paymentStatus: 'paid', priceAmount: 10000, priceOverrideAmount: '', priceOverrideAt: '', name: 'SECRET-NAME' }, over || {});
  return HEADER.map(function (h) { return b[h]; });
}
function ledger(rows) { return { values: [HEADER].concat(rows) }; }

function call(rows, extra, params) {
  var ctx = {
    authenticate: function () { return { ok: true }; }, nowMs: NOW,
    readLedger: function () { return ledger(rows); },
    readRevenueSources: function () { return extra || { options: { state: 'not_connected' }, members: { state: 'not_connected' } }; }
  };
  return JSON.parse(JSON.stringify(SB.OpsApi.handle({ op: 'revenue', params: params }, ctx)));
}

test('計上基準: 実績＝利用が過ぎ、かつ paid。未入金は実績に入れず別枠、将来は予定、返金は件数のみ。PENDING/キャンセルは売上にしない', function () {
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
    booking('E1', { status: 'CANCELLED', priceAmount: 8888 }),
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
    booking('R1', { status: 'CANCELLED', paymentStatus: 'refunded', priceAmount: 9000 }),
    booking('R2', { status: 'CANCELLED', paymentStatus: 'refund_pending', priceAmount: 9000 }),
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
