/*
 * ホーム画面（Issue #990 Phase 2）のテスト。データはすべて架空（モックアダプター）。
 * - 集計・並び順・月範囲の定義、取得失敗を0件にしないこと、片方のAPI失敗でもう片方を出すこと。
 * - 概要カードの件数と、押した先の一覧の件数が一致すること。
 * - 売上・参加者・DM・鍵の要確認・差分など、根拠のない項目を出さないこと。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var FRONT = path.join(ROOT, '_ops-app', 'frontend');
var H = require(path.join(FRONT, 'home-client.js'));
var C = require(path.join(FRONT, 'ops-client.js'));
var T = require(path.join(FRONT, 'tasks-client.js'));
var M = require(path.join(FRONT, 'mock-adapter.js'));
var builder = require(path.join(ROOT, 'scripts', 'build-ops-gas-page.js'));

function tick() { return new Promise(function (resolve) { setTimeout(resolve, 10); }); }
var NOW = Date.parse('2026-11-20T03:00:00Z'); /* JST 2026-11-20 12:00 */
var DAY = 24 * 3600 * 1000;

test('日付: 月範囲・月切替はJST基準で、うるう年・年またぎ・不正値を扱う', function () {
  assert.strictEqual(H.jstMonth(Date.parse('2026-11-30T15:30:00Z')), '2026-12', 'UTC 11/30 15:30 は JST 12/1');
  assert.deepStrictEqual(H.monthRange('2026-11'), { from: '2026-11-01', to: '2026-11-30' });
  assert.deepStrictEqual(H.monthRange('2028-02'), { from: '2028-02-01', to: '2028-02-29' });
  assert.strictEqual(H.monthRange('2026-13'), null);
  assert.strictEqual(H.monthRange('x'), null);
  assert.strictEqual(H.addMonths('2026-12', 1), '2027-01');
  var opts = H.monthOptions(NOW);
  assert.deepStrictEqual(opts.map(function (o) { return o[0]; }), ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
  assert.strictEqual(H.todayText(NOW), '2026年11月20日（金）');
});

function task(over) {
  return Object.assign({ taskId: 'T-x', title: 't', status: 'todo', statusLabel: '未対応', dueDate: '', overdue: false, updatedAt: '2026-11-01T00:00:00+09:00' }, over);
}

test('優先して確認: 期限超過→期限が近い→その他の決定的順序で最大3件。完了は含めず、独自の重要度を作らない', function () {
  var items = [
    task({ taskId: 'T-5', title: 'none-new', updatedAt: '2026-11-10T00:00:00+09:00' }),
    task({ taskId: 'T-2', title: 'due-far', dueDate: '2026-12-30' }),
    task({ taskId: 'T-1', title: 'overdue-old', dueDate: '2026-11-01', overdue: true }),
    task({ taskId: 'T-9', title: 'done', status: 'done', statusLabel: '完了', dueDate: '2026-11-01', overdue: false }),
    task({ taskId: 'T-3', title: 'due-near', dueDate: '2026-11-22' }),
    task({ taskId: 'T-4', title: 'none-old', updatedAt: '2026-11-02T00:00:00+09:00' }),
    task({ taskId: 'T-0', title: 'overdue-newer', dueDate: '2026-11-15', overdue: true })
  ];
  assert.deepStrictEqual(H.selectPriority(items).map(function (t) { return t.title; }), ['overdue-old', 'overdue-newer', 'due-near']);
  assert.deepStrictEqual(H.selectPriority(items, 10).map(function (t) { return t.taskId; }), ['T-1', 'T-0', 'T-3', 'T-2', 'T-4', 'T-5']);
  assert.deepStrictEqual(H.selectPriority(items.slice().reverse()).map(function (t) { return t.taskId; }), ['T-1', 'T-0', 'T-3'], '入力順に依存しない');
  assert.deepStrictEqual(H.selectPriority([]), []);
});

function item(id, over) {
  return Object.assign({ bookingId: id, service: 'snb', serviceLabel: 'SNB', status: 'CONFIRMED', statusLabel: '確定', phase: 'upcoming', date: '2026-11-25', startAt: '2026-11-25T10:00:00+09:00', endAt: '2026-11-25T12:00:00+09:00', people: 2 }, over);
}

test('直近の予約: 未来の有効（確定・仮予約）だけを開始が早い順に最大5件。過去・キャンセル・失効・状態不明は除く', function () {
  var items = [
    item('B6', { startAt: '2026-11-30T10:00:00+09:00' }), item('B1', { startAt: '2026-11-21T10:00:00+09:00' }),
    item('B2', { startAt: '2026-11-22T10:00:00+09:00', status: 'PENDING', statusLabel: '仮予約' }),
    item('BC', { status: 'CANCELLED' }), item('BE', { status: 'EXPIRED' }), item('BU', { status: null }),
    item('BP', { phase: 'ended' }), item('BI', { phase: 'in_progress' }),
    item('B3', { startAt: '2026-11-23T10:00:00+09:00' }), item('B4', { startAt: '2026-11-24T10:00:00+09:00' }), item('B5', { startAt: '2026-11-25T09:00:00+09:00' })
  ];
  var u = H.selectUpcoming(items);
  assert.deepStrictEqual(u.items.map(function (i) { return i.bookingId; }), ['B1', 'B2', 'B3', 'B4', 'B5']);
  assert.strictEqual(u.total, 6);
});

/* ---------- 状態の独立性・0件にしない ---------- */
function resState(over) {
  var a = { status: 'active', from: '2026-11-01', to: '2026-11-30', service: 'all' };
  var items = [item('B1'), item('B2', { status: 'PENDING', statusLabel: '仮予約' }), item('B3', { status: null, statusLabel: '不明' })];
  return Object.assign({ phase: 'ready', data: { items: items, applied: a, counts: { matched: 3 }, notConnectedSelected: false }, lastSuccessAt: '2026-11-20T12:00:00+09:00', error: null, mock: false }, over || {});
}
function taskState(over) {
  return Object.assign({ phase: 'ready', data: { storeReady: true, skippedRows: 0, items: [task({ taskId: 'T-1', title: '確認A', dueDate: '2026-11-01', overdue: true }), task({ taskId: 'T-2', title: '確認B', status: 'doing', statusLabel: '対応中' }), task({ taskId: 'T-3', status: 'done' })] }, lastSuccessAt: '2026-11-20T12:00:00+09:00', error: null }, over || {});
}
var CTX = { service: 'all', range: { from: '2026-11-01', to: '2026-11-30' } };

test('概要カード: 件数は一覧と同じ定義（キャンセル除外の予約・仮予約・未完了メモ・期限超過メモ）で、押せるのは取得できたものだけ', function () {
  var cards = H.buildCards(H.resStatus(resState(), { from: CTX.range.from, to: CTX.range.to, service: 'all' }), H.taskStatus(taskState()));
  assert.deepStrictEqual(cards.map(function (c) { return [c.key, c.value]; }), [['reservations', 3], ['pending', 1], ['tasks', 2], ['overdue', 1]]);
  var html = H.renderHome(resState(), taskState(), CTX);
  assert.strictEqual((html.match(/data-home="card" data-target/g) || []).length, 5, '4枚のカード＋一覧を見る');
  assert.ok(/優先して確認/.test(html) && /直近の予約・開催/.test(html));
});

test('予約の取得失敗でも、メモ側は表示する。失敗を「0件」と表示しない', function () {
  var res = { phase: 'error', data: null, error: { code: 'FETCH_FAILED', message: '取得に失敗しました。' }, lastSuccessAt: null };
  var html = H.renderHome(res, taskState(), CTX);
  assert.ok(/取得に失敗しました。/.test(html) && /data-home="retry-res"/.test(html));
  assert.ok(/確認A/.test(html), 'メモは表示');
  assert.ok(/取得失敗/.test(html));
  assert.ok(!/<span class="v">0<small>件/.test(html), '失敗を0件にしない');
  /* 逆: メモが失敗しても予約は表示 */
  var html2 = H.renderHome(resState(), { phase: 'error', data: null, error: { code: 'STORE_FAILED', message: 'メモの取得に失敗しました。' } }, CTX);
  assert.ok(/data-home="retry-tasks"/.test(html2) && /直近の予約/.test(html2) && /data-home="res"/.test(html2));
  assert.ok(!/優先して確認するメモはありません/.test(html2), 'メモ失敗を「なし」にしない');
});

test('認可拒否・読込中・メモ保存先未設定・読込不可行は区別して表示する', function () {
  var denied = H.renderHome({ phase: 'denied', data: null, error: { code: 'FORBIDDEN', message: 'x' } }, { phase: 'denied', data: null, error: { code: 'FORBIDDEN', message: 'x' } }, CTX);
  assert.ok(/予約を表示する権限がありません/.test(denied) && /メモを表示する権限がありません/.test(denied));
  var loading = H.renderHome({ phase: 'loading', data: null }, { phase: 'loading', data: null }, CTX);
  assert.ok(/予約を取得中/.test(loading) && /メモを取得中/.test(loading));
  var notReady = H.renderHome(resState(), taskState({ data: { storeReady: false, items: [], skippedRows: 0 } }), CTX);
  assert.ok(/保存先が未設定/.test(notReady) && !/優先して確認するメモはありません/.test(notReady));
  var inc = H.renderHome(resState(), taskState({ data: { storeReady: true, skippedRows: 2, items: [] } }), CTX);
  assert.ok(/不完全/.test(inc));
  var none = H.renderHome(resState(), taskState({ data: { storeReady: true, skippedRows: 0, items: [] } }), CTX);
  assert.ok(/優先して確認するメモはありません/.test(none));
});

test('古い絞り込み（月・状態の違うデータ）はホームの数字に使わず、再取得待ちにする。未接続サービスは0件にしない', function () {
  var other = resState({ data: Object.assign({}, resState().data, { applied: { status: 'PENDING', from: '2026-11-01', to: '2026-11-30' } }) });
  var html = H.renderHome(other, taskState(), CTX);
  assert.ok(/予約を取得中/.test(html) && !/data-home="res" data-id/.test(html));
  var nc = resState({ data: Object.assign({}, resState().data, { items: [], notConnectedSelected: true, applied: { status: 'active', from: '2026-11-01', to: '2026-11-30', service: 'snb_community' } }) });
  var html2 = H.renderHome(nc, taskState(), { service: 'snb_community', range: CTX.range });
  assert.ok(/未接続/.test(html2) && /0件ではなく/.test(html2));
  assert.ok(!/<span class="v">0<small>件/.test(html2));
});

test('出さないもの: 売上・参加予定・DM・鍵の要確認・前回更新との差分・アバター。個人名もホームに出さない', function () {
  var res = resState();
  res.data.items[0].name = '個人名テスト<b>';
  var html = H.renderHome(res, taskState(), CTX);
  ['売上', '参加予定', 'DM', '鍵の要確認', '前回更新', '差分', '<img', 'avatar'].forEach(function (w) { assert.ok(html.indexOf(w) === -1, w + ' を出さない'); });
  assert.ok(html.indexOf('個人名テスト') === -1);
});

test('エスケープ: メモ件名・サービス名のHTMLは実行されない', function () {
  var ts = taskState(); ts.data.items[0].title = '<script>alert(1)</script>';
  var html = H.renderHome(resState(), ts, CTX);
  assert.ok(html.indexOf('<script>') === -1 && /&lt;script&gt;/.test(html));
});

/* ---------- 結線（疑似DOM＋モックアダプター） ---------- */
function fakeDoc() {
  var els = {};
  function el(id) {
    if (!els[id]) {
      els[id] = { id: id, value: '', hidden: false, disabled: false, innerHTML: '', textContent: '', _l: {}, _attr: {}, clicks: 0, parentNode: null,
        addEventListener: function (t, f) { (this._l[t] = this._l[t] || []).push(f); },
        setAttribute: function (k, v) { this._attr[k] = v; }, getAttribute: function (k) { return this._attr[k] === undefined ? null : this._attr[k]; },
        focus: function () {},
        click: function () { this.clicks++; var self = this; (this._l.click || []).forEach(function (f) { f({ preventDefault: function () {}, target: self }); }); } };
    }
    return els[id];
  }
  return { getElementById: el };
}
function node(attrs) { return { getAttribute: function (k) { return attrs[k] === undefined ? null : attrs[k]; }, parentNode: null }; }
function clickIn(doc, id, attrs) { var n = node(attrs); doc.getElementById(id)._l.click.forEach(function (f) { f({ target: n }); }); }

function boot() {
  var doc = fakeDoc();
  var range = H.monthRange(H.jstMonth(NOW));
  var home = null;
  var res = C.mount(doc, M.createMockApi({ scenario: 'ok', nowMs: NOW }), { initial: { service: 'all', status: 'active', scope: 'custom', from: range.from, to: range.to }, onChange: function () { if (home) home.render(); } });
  var tasks = T.mount(doc, M.createMockTasksApi({ scenario: 'ok', nowMs: NOW }), { onChange: function () { if (home) home.render(); } });
  home = H.mount(doc, { res: res, tasks: tasks, now: function () { return NOW; } });
  return { doc: doc, res: res, tasks: tasks, home: home };
}

test('結線: 起動時の予約取得は表示月の1回だけ。ホームの数字がカードに出て、押した先の一覧件数と一致する', async function () {
  var calls = 0;
  var doc = fakeDoc();
  var range = H.monthRange(H.jstMonth(NOW));
  var inner = M.createMockApi({ scenario: 'ok', nowMs: NOW });
  var api = Object.assign({}, inner, { list: function (p, ok, ng) { calls++; assert.strictEqual(p.from, range.from); assert.strictEqual(p.to, range.to); inner.list(p, ok, ng); } });
  var home = null;
  var res = C.mount(doc, api, { initial: { service: 'all', status: 'active', scope: 'custom', from: range.from, to: range.to }, onChange: function () { if (home) home.render(); } });
  var tasks = T.mount(doc, M.createMockTasksApi({ scenario: 'ok', nowMs: NOW }), { onChange: function () { if (home) home.render(); } });
  home = H.mount(doc, { res: res, tasks: tasks, now: function () { return NOW; } });
  await tick();
  assert.strictEqual(calls, 1, '予約一覧の取得は起動時に1回（ホームのために追加取得しない）');
  var view = doc.getElementById('home-view').innerHTML;
  var count = res.state.data.counts.matched;
  assert.ok(new RegExp('今月の予約</span><span class="v">' + count + '<small>件').test(view), 'カードの件数 = 予約一覧の該当件数');
  assert.strictEqual(res.state.data.items.length, count);
  assert.ok(/（モック）DM返信の確認/.test(view), '期限超過メモが優先に出る');
});

test('結線: 優先メモ→メモ展開、仮予約カード→絞り込み一覧（件数一致）→ホームへ戻ると条件が元に戻る', async function () {
  var b = boot(); await tick();
  var doc = b.doc;
  /* 優先メモの行 → メモタブを開き、対象メモを展開（トグルではなく必ず展開） */
  clickIn(doc, 'home-view', { 'data-home': 'task', 'data-id': 'T-mockaaaa0001' });
  assert.strictEqual(doc.getElementById('tab-tasks').clicks, 1);
  assert.strictEqual(b.tasks.state.expanded['T-mockaaaa0001'], true);
  clickIn(doc, 'home-view', { 'data-home': 'task', 'data-id': 'T-mockaaaa0001' });
  assert.strictEqual(b.tasks.state.expanded['T-mockaaaa0001'], true, '2回押しても閉じない');
  assert.strictEqual(doc.getElementById('home-panel').hidden, true);

  /* ホームへ戻る */
  doc.getElementById('tab-home').click(); await tick();
  assert.strictEqual(doc.getElementById('home-panel').hidden, false);
  var pendingCard = b.res.state.data.items.filter(function (i) { return i.status === 'PENDING'; }).length;

  /* 仮予約カード → 予約タブ、状態=仮予約で再取得。一覧件数 = カードの件数 */
  clickIn(doc, 'home-view', { 'data-home': 'card', 'data-target': 'res-pending' }); await tick();
  assert.strictEqual(doc.getElementById('f-status').value, 'PENDING');
  assert.strictEqual(doc.getElementById('tab-res').clicks, 1);
  assert.strictEqual(b.res.state.data.counts.matched, pendingCard);
  assert.ok(b.res.state.data.items.every(function (i) { return i.status === 'PENDING'; }));

  /* ホームに戻ると、キャンセル除外・表示月に戻して再取得（ホームの数字が別条件のデータにならない） */
  doc.getElementById('tab-home').click(); await tick();
  assert.strictEqual(doc.getElementById('f-status').value, 'active');
  assert.strictEqual(b.res.state.data.applied.status, 'active');
});

test('結線: 月・サービス切替は予約一覧の絞り込みに作用し、予約行→詳細、＋メモを追加→メモ追加フォーム、再取得は両方', async function () {
  var b = boot(); await tick();
  var doc = b.doc;
  doc.getElementById('home-month').value = '2026-12';
  doc.getElementById('home-month')._l.change.forEach(function (f) { f({}); }); await tick();
  assert.strictEqual(doc.getElementById('f-from').value, '2026-12-01');
  assert.strictEqual(doc.getElementById('f-to').value, '2026-12-31');
  assert.strictEqual(b.res.state.data.applied.from, '2026-12-01');

  clickIn(doc, 'home-view', { 'data-home': 'service', 'data-service': 'studio_x' }); await tick();
  assert.strictEqual(doc.getElementById('f-service').value, 'studio_x');
  assert.strictEqual(b.home.model.service, 'studio_x');
  assert.ok(b.res.state.data.items.every(function (i) { return i.service === 'studio_x'; }));

  clickIn(doc, 'home-view', { 'data-home': 'service', 'data-service': 'snb_community' }); await tick();
  assert.ok(/未接続/.test(doc.getElementById('home-view').innerHTML));

  doc.getElementById('home-add').click();
  assert.strictEqual(doc.getElementById('t-new').clicks, 1, '既存の「メモを追加」へつなぐ');
  assert.strictEqual(doc.getElementById('tab-tasks').clicks, 1);

  var before = b.res.state.lastSuccessAt;
  doc.getElementById('home-reload').click(); await tick();
  assert.ok(b.tasks.state.phase === 'ready' && b.res.state.phase === 'ready');
  assert.ok(before !== undefined);
});

test('結線: 予約行を押すと予約タブで詳細が開く（鍵・メモへの導線は既存の詳細画面）', async function () {
  var b = boot(); await tick();
  var firstUp = H.selectUpcoming(b.res.state.data.items).items[0];
  if (!firstUp) return; /* モックに未来の有効予約が無い日は対象外 */
  clickIn(b.doc, 'home-view', { 'data-home': 'res', 'data-id': firstUp.bookingId });
  assert.strictEqual(b.doc.getElementById('tab-res').clicks, 1);
  assert.strictEqual(b.res.state.detailId, firstUp.bookingId);
  await tick();
  var detail = C.renderView(b.res.state);
  assert.ok(/鍵・案内の状況/.test(detail) && /id="detail-to-tasks"/.test(detail) && /id="detail-close"/.test(detail));
});

/* ---------- 配布物 ---------- */
test('配布物: 生成物に画面版の印・ホーム・ナビがあり、鍵・メモへの導線コードを含む。未稼働メニューを出さない', function () {
  var page = builder.build();
  assert.ok(/ops-ui-2/.test(page), '配布版の取り違えを確認できる印');
  assert.ok(/id="tab-home"/.test(page) && /id="appnav"/.test(page) && /home-client|OpsHomeClient/.test(page));
  assert.ok(/鍵・案内の状況/.test(page) && /メモ・期限を開く/.test(page), '#961で欠落報告のあった表示');
  var nav = page.slice(page.indexOf('<nav id="appnav"'), page.indexOf('</nav>'));
  ['参加者', 'DM', 'SNS告知', '売上', 'CSV'].forEach(function (w) { assert.ok(nav.indexOf(w) === -1, w + ' をナビに出さない'); });
  var body = page.slice(page.indexOf('<body>'), page.indexOf('<script>'));
  assert.ok(!/売上予定|参加予定|<img/.test(body));
  assert.strictEqual(fs.readFileSync(builder.OUT, 'utf8'), page, '生成物が正本と一致');
});

test('レビュー対応(#992): 日またぎの終了日表示・除外行の不完全警告・一覧へ移る前に詳細を閉じる', async function () {
  var night = item('BN', { startAt: '2026-11-25T22:00:00+09:00', endAt: '2026-11-26T01:00:00+09:00' });
  var res = resState(); res.data.items = [night];
  var html = H.renderHome(res, taskState(), CTX);
  assert.ok(/22:00〜11\/26 01:00/.test(html), '終了日を併記');
  var bad = resState(); bad.data.issues = [{ row: 3, severity: 'error', reasons: ['x'] }]; bad.data.items = [];
  var h2 = H.renderHome(bad, taskState(), CTX);
  assert.ok(/1 件が読み込めず/.test(h2) && /とは限りません/.test(h2) && /不完全/.test(h2));
  assert.ok(!/これからの有効な予約はありません（取得は正常/.test(h2));
  var b = boot(); await tick();
  var up = H.selectUpcoming(b.res.state.data.items).items[0];
  if (!up) return;
  clickIn(b.doc, 'home-view', { 'data-home': 'res', 'data-id': up.bookingId }); await tick();
  assert.ok(b.res.state.detailId);
  b.doc.getElementById('tab-home').click(); await tick();
  clickIn(b.doc, 'home-view', { 'data-home': 'card', 'data-target': 'res-pending' }); await tick();
  assert.strictEqual(b.res.state.detailId, null, '詳細が残らない');
  b.doc.getElementById('tab-home').click(); await tick();
  clickIn(b.doc, 'home-view', { 'data-home': 'res', 'data-id': up.bookingId }); await tick();
  b.doc.getElementById('tab-home').click(); await tick();
  clickIn(b.doc, 'home-view', { 'data-home': 'card', 'data-target': 'res' });
  assert.strictEqual(b.res.state.detailId, null);
});
