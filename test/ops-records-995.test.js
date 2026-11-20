/*
 * SNBC実績・現地払い受領の記録と年商連携（Issue #995 PR-C）のテスト。金額・予約はすべて架空。
 * 実際にGASへ貼る gas/ops-reservations/ のファイルをvmで実行して検証する（代表5パターン）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var DIR = path.join(__dirname, '..', 'gas', 'ops-reservations');
var NOW = Date.UTC(2026, 10, 20, 3, 0, 0); /* 2026-11-20 12:00 JST */
var LOGS = [];

function load() {
  var sb = { Logger: { log: function (m) { LOGS.push(String(m)); } } };
  vm.createContext(sb);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsRevenue.gs', 'OpsRevenueStore.gs', 'OpsRevenueRecords.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sb, { filename: f });
  });
  return sb;
}
var SB = load();

/* ---- 架空の台帳 ---- */
function jst(y, m, d, hh, mm) { return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)); }
var CASH = '現金', CARD = 'オンラインクレジットカード';
var HEADER = ['bookingId', 'date', 'startAt', 'endAt', 'brand', 'status', 'paymentStatus', 'priceAmount', 'name', 'paymentMethod', 'refundDecision', 'refundAmount', 'feePaidAmount', 'feeRefundedAmount', 'cancelledAt'];
function booking(id, over) {
  var b = Object.assign({ bookingId: id, date: '2026-11-10', startAt: jst(2026, 11, 10, 10, 0), endAt: jst(2026, 11, 10, 12, 0), brand: 'snb', status: 'CONFIRMED', paymentStatus: 'not_started', priceAmount: 6000, name: 'DUMMY', paymentMethod: CASH, refundDecision: '', refundAmount: '', feePaidAmount: '', feeRefundedAmount: '', cancelledAt: '' }, over || {});
  return HEADER.map(function (h) { return b[h]; });
}
function ledger(rows) { return { values: [HEADER].concat(rows) }; }

/* ---- 架空の保存先（SNBCEvents / OnsiteReceipts）。書込みの記録を残す ---- */
function fakeStore(initial) {
  var H = SB.OpsRevenueRecords.DEFS;
  var tabs = { snbc: { header: H.snbc.headers.slice(), rows: [] }, onsite: { header: H.onsite.headers.slice(), rows: [] } };
  Object.keys(initial || {}).forEach(function (k) { tabs[k].rows = initial[k]; });
  var writes = [];
  return {
    writes: writes, tabs: tabs,
    state: function () { return { ready: true }; },
    readAll: function (kind) { return JSON.parse(JSON.stringify({ header: tabs[kind].header, rows: tabs[kind].rows })); },
    append: function (kind, cells) { writes.push(['append', kind]); tabs[kind].rows.push(cells); },
    updateRow: function (kind, n, cells) { writes.push(['update', kind]); tabs[kind].rows[n - 2] = cells; },
    removeRow: function (kind, n) { writes.push(['remove', kind]); tabs[kind].rows.splice(n - 2, 1); }
  };
}
function deps(store) { return { store: store, withLock: function (fn) { return fn(); } }; }
function ctxOf(rows, store, over) {
  return Object.assign({
    authenticate: function () { return { ok: true }; }, nowMs: NOW,
    readLedger: function () { return ledger(rows); },
    readRevenueSources: function () { return { options: { state: 'not_connected' }, members: { state: 'not_connected' } }; },
    records: function () { return deps(store); },
    readRecords: function () { return SB.OpsRevenueRecords.readForRevenue(deps(store)); }
  }, over || {});
}
function run(request, rows, store, over) { return JSON.parse(JSON.stringify(SB.OpsApi.handle(request, ctxOf(rows || [], store, over)))); }
function revenue(rows, store) { return run({ op: 'revenue', params: { year: 2026 } }, rows, store).revenue; }
function snbcInput(over) { return Object.assign({ eventId: 'E-abcdef123456', eventDate: '2026-11-08', title: 'SNBC 11月 練習会', receivedJpy: 21000, refundedJpy: 3500, paidCount: 7, directCostJpy: 5000 }, over || {}); }
function onsiteInput(id, over) { return Object.assign({ bookingId: id, receivedJpy: 6000, refundedJpy: 0, method: 'cash', receivedOn: '2026-11-10' }, over || {}); }

test('① SNBC: 受領21,000−返金3,500＝17,500円が開催月（11月）に1回だけ。経費は年商から引かない。登録なしは「未入力」で0円と断定しない', function () {
  var store = fakeStore();
  var empty = revenue([], store);
  assert.ok(empty.partial.reasons.indexOf('SNBC_NO_RECORDS') !== -1 && empty.totals.actual === 0);
  var saved = run({ op: 'snbc_save', input: snbcInput() }, [], store);
  assert.strictEqual(saved.ok, true);
  var again = run({ op: 'snbc_save', input: snbcInput() }, [], store); /* 二重送信は冪等 */
  assert.strictEqual(again.ok, true); assert.strictEqual(again.replayed, true);
  assert.strictEqual(store.tabs.snbc.rows.length, 1);
  var rev = revenue([], store);
  assert.strictEqual(rev.months[10].snbc.actual, 17500);
  assert.strictEqual(rev.totals.actual, 17500, '経費5,000円は引かない／1行は1回だけ');
  assert.strictEqual(rev.totals.snbcDirectCost, 5000);
  assert.ok(rev.partial.isPartial && rev.partial.reasons.indexOf('SNBC_RECORDED_ONLY') !== -1);
  /* 開催日が未来は保存できない。訂正は同じ行を更新し、削除はその1行だけ。 */
  assert.strictEqual(run({ op: 'snbc_save', input: snbcInput({ eventId: 'E-future000001', eventDate: '2026-11-21' }) }, [], store).ok, false);
  var fixed = run({ op: 'snbc_save', input: snbcInput({ receivedJpy: 22000 }), expectedRevision: 1 }, [], store);
  assert.strictEqual(fixed.ok, true); assert.strictEqual(store.tabs.snbc.rows.length, 1);
  assert.strictEqual(revenue([], store).totals.actual, 18500);
  assert.strictEqual(run({ op: 'snbc_delete', eventId: 'E-abcdef123456', expectedRevision: 2 }, [], store).deleted, true);
  assert.strictEqual(store.tabs.snbc.rows.length, 0);
});

test('② 現地払い: 6,000円は利用終了後に1回だけ。未記録は未確認。台帳に受領記録（feePaidAmount）があれば台帳を優先して二重計上しない', function () {
  var store = fakeStore();
  var rows = [booking('B-ONSITE-1')];
  var none = revenue(rows, store);
  assert.strictEqual(none.totals.actual, 0); assert.strictEqual(none.totals.onsiteUnconfirmedCount, 1);
  var got = run({ op: 'onsite_get', bookingId: 'B-ONSITE-1' }, rows, store);
  assert.strictEqual(got.ok, true); assert.strictEqual(got.record, null); assert.strictEqual(got.ledgerReceipt, false);
  assert.strictEqual(run({ op: 'onsite_save', input: onsiteInput('B-ONSITE-1') }, rows, store).ok, true);
  assert.strictEqual(run({ op: 'onsite_save', input: onsiteInput('B-ONSITE-1') }, rows, store).replayed, true);
  assert.strictEqual(store.tabs.onsite.rows.length, 1);
  var rev = revenue(rows, store);
  assert.strictEqual(rev.totals.actual, 6000); assert.strictEqual(rev.totals.onsiteRecorded, 6000); assert.strictEqual(rev.totals.onsiteUnconfirmedCount, 0);
  /* 利用前の予約は実績にしない（予定のまま）。見積り料金は受領額にしない（記録額6,000と予定料金9,000が違っても記録額）。 */
  var future = [booking('B-ONSITE-1', { date: '2026-12-05', startAt: jst(2026, 12, 5, 10, 0), endAt: jst(2026, 12, 5, 12, 0), priceAmount: 9000 })];
  assert.strictEqual(revenue(future, store).totals.actual, 0);
  assert.strictEqual(revenue([booking('B-ONSITE-1', { priceAmount: 9000 })], store).totals.actual, 6000);
  /* 台帳に受領記録がある予約: 台帳を優先し、手入力は加算しない（重複として要確認）。新規記録も拒否。 */
  var ledgerRows = [booking('B-ONSITE-1', { feePaidAmount: 6000 })];
  var dup = revenue(ledgerRows, store);
  assert.strictEqual(dup.totals.actual, 6000, '台帳6,000のみ（手入力を足さない）');
  assert.ok(dup.partial.reasons.indexOf('ONSITE_RECEIPT_DUPLICATE') !== -1);
  var other = [booking('B-LEDGER-2', { feePaidAmount: 6000 })];
  var rejected = run({ op: 'onsite_save', input: onsiteInput('B-LEDGER-2') }, other, store);
  assert.strictEqual(rejected.ok, false); assert.strictEqual(run({ op: 'onsite_get', bookingId: 'B-LEDGER-2' }, other, store).ledgerReceipt, true);
  /* カード決済・存在しない予約は記録できない。 */
  assert.strictEqual(run({ op: 'onsite_save', input: onsiteInput('B-CARD-3') }, [booking('B-CARD-3', { paymentMethod: CARD })], store).ok, false);
  assert.strictEqual(run({ op: 'onsite_save', input: onsiteInput('B-NONE-4') }, rows, store).error.code, 'NOT_FOUND');
});

test('③ 取消済みの現地払い: 取消後に返金を確定した記録だけが取消確定月の残額になる（取消前の記録は確定しない）', function () {
  var cancelled = [booking('B-CANCEL-1', { status: 'CANCELLED', cancelledAt: jst(2026, 11, 10, 9, 0) })];
  var oldRec = ['B-CANCEL-1', 6000, 0, 'cash', '2026-11-05', '2026-11-05T10:00:00+09:00', 1];
  var stale = revenue(cancelled, fakeStore({ onsite: [oldRec] }));
  assert.strictEqual(stale.totals.actual, 0); assert.ok(stale.partial.reasons.indexOf('REFUND_UNSETTLED') !== -1);
  var newRec = ['B-CANCEL-1', 6000, 4000, 'cash', '2026-11-12', '2026-11-12T10:00:00+09:00', 2];
  var settled = revenue(cancelled, fakeStore({ onsite: [newRec] }));
  assert.strictEqual(settled.totals.actual, 2000); assert.strictEqual(settled.months[10].actual, 2000, '取消確定月（11月）');
  /* 取消確定日時が無ければ要確認（利用月へ振り替えない）。 */
  var noDate = revenue([booking('B-CANCEL-1', { status: 'CANCELLED', cancelledAt: '' })], fakeStore({ onsite: [newRec] }));
  assert.strictEqual(noDate.totals.actual, 0); assert.ok(noDate.partial.reasons.indexOf('CANCEL_MONTH_UNKNOWN') !== -1);
});

test('④ テスト予約・アタルの手入力現地払いは売上から除外（突合不可の警告にも出さない）。予約一覧の表示は変えない', function () {
  var rows = [booking('B-TEST-1', { name: 'テスト' }), booking('B-ATARU-2', { name: 'アタル' }), booking('B-REAL-3')];
  var store = fakeStore({ onsite: [onsiteRow('B-TEST-1'), onsiteRow('B-ATARU-2'), onsiteRow('B-REAL-3')] });
  var rev = revenue(rows, store);
  assert.strictEqual(rev.totals.actual, 6000, '通常予約の6,000円だけ');
  assert.ok(rev.partial.reasons.indexOf('ONSITE_RECEIPT_UNMATCHED') === -1);
  var list = run({ op: 'list', params: { service: 'all', status: 'all', scope: 'past' } }, rows, store);
  assert.ok(list.items.some(function (i) { return i.bookingId === 'B-ATARU-2'; }), 'アタルは一覧に残る');
  /* 台帳に無い予約IDの記録は突合不可（金額に含めない）。 */
  var orphan = revenue([booking('B-REAL-3')], fakeStore({ onsite: [onsiteRow('B-REAL-3'), onsiteRow('B-GHOST-9')] }));
  assert.strictEqual(orphan.totals.actual, 6000); assert.ok(orphan.partial.reasons.indexOf('ONSITE_RECEIPT_UNMATCHED') !== -1);
});
function onsiteRow(id) { return [id, 6000, 0, 'cash', '2026-11-10', '2026-11-10T20:00:00+09:00', 1]; }

test('⑤ 安全: 所有者以外は全操作が拒否され保存先に触れない／保存先が予約台帳と同じ・主キー重複・ヘッダー違いは書込み前に停止／ログに金額・予約IDを出さない', function () {
  var store = fakeStore();
  var denied = { authenticate: function () { return { ok: false, code: 'FORBIDDEN' }; } };
  ['snbc_list', 'snbc_save', 'snbc_delete', 'onsite_get', 'onsite_save', 'onsite_delete'].forEach(function (op) {
    var res = run({ op: op, input: snbcInput(), bookingId: 'B-ONSITE-1', eventId: 'E-abcdef123456', expectedRevision: 1 }, [booking('B-ONSITE-1')], store, denied);
    assert.strictEqual(res.ok, false); assert.strictEqual(res.error.code, 'FORBIDDEN');
  });
  assert.strictEqual(store.writes.length, 0);
  /* 保存先IDが予約台帳IDと同じ: 通信せずに停止。 */
  var calls = 0;
  var same = SB.OpsRevenueStore.create({ getSpreadsheetId: function () { return 'LEDGER-ID-0123456789ABCDEF'; }, getLedgerId: function () { return 'LEDGER-ID-0123456789ABCDEF'; }, fetch: function () { calls++; }, getToken: function () { return 't'; } });
  var viaSame = run({ op: 'snbc_save', input: snbcInput() }, [], null, { records: function () { return deps(same); } });
  assert.strictEqual(viaSame.error.code, 'STORE_FAILED'); assert.strictEqual(viaSame.error.reason, 'TARGET_IS_LEDGER'); assert.strictEqual(calls, 0);
  /* 主キー重複・ヘッダー違い: 書かずに停止し、売上は0円と偽らず「取得失敗」。 */
  var dupStore = fakeStore({ snbc: [['E-abcdef123456', '2026-11-08', 'A', '', 100, 0, '', '2026-11-08T10:00:00+09:00', 1], ['E-abcdef123456', '2026-11-09', 'B', '', 200, 0, '', '2026-11-09T10:00:00+09:00', 1]] });
  var dupRes = run({ op: 'snbc_save', input: snbcInput({ eventId: 'E-zzzzzzzz9999' }) }, [], dupStore);
  assert.strictEqual(dupRes.error.reason, 'DUPLICATE_KEY'); assert.strictEqual(dupStore.writes.length, 0);
  assert.strictEqual(revenue([], dupStore).sources.snbc.state, 'error');
  var badHeader = fakeStore(); badHeader.tabs.snbc.header = ['x'];
  assert.strictEqual(run({ op: 'snbc_save', input: snbcInput() }, [], badHeader).error.reason, 'SCHEMA'); assert.strictEqual(badHeader.writes.length, 0);
  /* 許可外の項目（保存先・範囲）・不正な金額は拒否。 */
  assert.strictEqual(run({ op: 'snbc_save', input: Object.assign(snbcInput(), { spreadsheetId: 'x' }) }, [], store).ok, false);
  assert.strictEqual(run({ op: 'snbc_save', input: snbcInput({ refundedJpy: 30000 }) }, [], store).ok, false);
  assert.strictEqual(run({ op: 'snbc_save', input: snbcInput({ receivedJpy: '21000' }) }, [], store).ok, false);
  assert.ok(!LOGS.some(function (l) { return /21000|17500|B-ONSITE|E-abcdef/.test(l); }), 'ログに金額・IDを出さない');
});

test('レビュー修正: 取消後の返金なし再確認は金額が同じでも確認日時を進め取消確定月に1回だけ計上／予約A保存中にBを開いてもBの入力は消えない', function () {
  /* 利用時に6,000円受領を記録 → 後日取消（返金なし）。同じ内容の再保存は通常「変更なし」。 */
  var cancelled = [booking('B-RECONF-1', { status: 'CANCELLED', cancelledAt: jst(2026, 11, 12, 9, 0) })];
  var store = fakeStore({ onsite: [['B-RECONF-1', 6000, 0, 'cash', '2026-11-10', '2026-11-10T20:00:00+09:00', 1]] });
  assert.strictEqual(revenue(cancelled, store).totals.actual, 0, '取消前の記録は確定しない');
  assert.strictEqual(run({ op: 'onsite_save', input: onsiteInput('B-RECONF-1'), expectedRevision: 1 }, cancelled, store).unchanged, true, 'フラグ無しは従来どおり変更なし');
  var re = run({ op: 'onsite_save', input: onsiteInput('B-RECONF-1'), expectedRevision: 1, reconfirm: true }, cancelled, store);
  assert.strictEqual(re.ok, true); assert.strictEqual(re.record.revision, 2);
  var dupSend = run({ op: 'onsite_save', input: onsiteInput('B-RECONF-1'), expectedRevision: 1, reconfirm: true }, cancelled, store); /* 二重クリック */
  assert.strictEqual(dupSend.replayed, true); assert.strictEqual(store.tabs.onsite.rows[0][6], 2);
  var rev = revenue(cancelled, store);
  assert.strictEqual(rev.totals.actual, 6000); assert.strictEqual(rev.months[10].actual, 6000, '取消確定月（11月）に1回だけ');
  /* 取消でない予約には reconfirm は効かない（版を進めない）。 */
  var normal = [booking('B-RECONF-2')]; var s2 = fakeStore({ onsite: [['B-RECONF-2', 6000, 0, 'cash', '2026-11-10', '2026-11-10T20:00:00+09:00', 1]] });
  assert.strictEqual(run({ op: 'onsite_save', input: onsiteInput('B-RECONF-2'), expectedRevision: 1, reconfirm: true }, normal, s2).unchanged, true);

  /* フロント: A の保存応答が遅れて戻る間に B を開く。 */
  var Rc = require('../_ops-app/frontend/records-client.js');
  var pending = [];
  var api = {
    onsiteGet: function (id, ok) { ok({ ok: true, storeReady: true, ledgerReceipt: false, todayJst: '2026-11-20', record: null }); },
    onsiteSave: function (p, ok) { pending.push(ok); },
    onsiteDelete: function () {}
  };
  var saved = 0;
  var ctl = Rc.createOnsiteController(api, function () {}, { onSaved: function () { saved++; } });
  function detail(id) { return { detailPhase: 'ready', detail: { bookingId: id, paymentMethod: '現金', date: '2026-11-10', serviceLabel: 'SNB', effectivePriceAmount: 6000, status: 'CONFIRMED' } }; }
  ctl.sync(detail('B-A')); ctl.setField('receivedJpy', '6000'); ctl.setField('receivedOn', '2026-11-10'); ctl.save();
  ctl.sync(detail('B-B')); ctl.setField('receivedJpy', '1234'); ctl.setField('receivedOn', '2026-11-11');
  pending[0]({ ok: true, record: { revision: 1 } }); /* A の完了通知が遅れて届く */
  assert.strictEqual(ctl.state.form.receivedJpy, '1234', 'B の入力が消えない');
  assert.strictEqual(ctl.state.message, null, 'A の成功メッセージを B に出さない');
  assert.strictEqual(saved, 1, '年商の再取得だけは妨げない');
  assert.strictEqual(ctl.state.saving, false, 'B はそのまま保存できる');
});
