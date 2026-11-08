/*
 * 利用後アンケート管理画面（Issue #849）の集計・カード生成 scripts/feedback-analytics.js の検証。
 * 受入1（全体/ブランド別・期間・評価分布・問題件数・再利用意向）と受入2（テスト除外・0件）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var Core = require('../scripts/feedback-core.js');
var Analytics = require('../scripts/feedback-analytics.js');

var NOW = new Date('2026-11-08T03:00:00.000Z');
var seq = 0;

function row(opts) {
  seq++;
  var answers = Core.validateAnswers(Object.assign({ q1: 4, q6: 'definitely' }, opts.answers || {})).answers;
  var received = new Date(NOW.getTime() - (opts.daysAgo || 0) * 86400000).toISOString();
  var r = Core.buildRow(answers, { responseId: 'rid-' + String(seq).padStart(4, '0'), receivedAt: received, brand: opts.brand || 'snb', isTest: !!opts.isTest });
  if (opts.status) r[Core.COLUMNS.indexOf('status')] = opts.status;
  if (opts.notifyFailed) r[Core.COLUMNS.indexOf('notify_failed')] = 1;
  return r;
}
function records(rows) { return Analytics.parseRows(Core.COLUMNS, rows); }

var FIXTURE = [
  row({ brand: 'snb', answers: { q1: 5, q6: 'definitely', q2: { website: 'ok', booking: 'trouble' } }, daysAgo: 1 }),
  row({ brand: 'snb', answers: { q1: 2, q6: 'not_now', q5: ['supplies', 'damage'], comment: '紙が無かった' }, daysAgo: 10 }),
  row({ brand: 'mens', answers: { q1: 1, q6: 'maybe', q3: { lighting: 'minor', aircon: 'na' } }, daysAgo: 45 }),
  row({ brand: 'studio-x', answers: { q1: 4, q6: 'maybe', q5: ['none'], q2: { website: 'minor' } }, daysAgo: 100 }),
  row({ brand: 'studio-x', answers: { q1: 3, q6: 'definitely', q5: ['cleanliness'] }, daysAgo: 5, status: '対応中' }),
  row({ brand: 'snb', answers: { q1: 1, q6: 'not_now', q5: ['other'], comment: 'テスト' }, daysAgo: 1, isTest: true })
];

test('parseRows: Spreadsheetの行を型付きレコードにする（Date型・数値文字列・先頭アポストロフィにも対応）', function () {
  var r = records(FIXTURE)[1];
  assert.strictEqual(r.rowNumber, 3);
  assert.strictEqual(r.brand, 'snb');
  assert.strictEqual(r.q1, 2);
  assert.deepStrictEqual(r.q5, ['supplies', 'damage']);
  assert.strictEqual(r.comment, '紙が無かった');
  assert.strictEqual(r.status, '未対応');
  assert.ok(r.receivedAt instanceof Date);
  var raw = FIXTURE[0].slice();
  raw[Core.COLUMNS.indexOf('received_at')] = new Date('2026-11-01T00:00:00Z');
  raw[Core.COLUMNS.indexOf('q1_overall')] = '5';
  raw[Core.COLUMNS.indexOf('is_test')] = '1';
  raw[Core.COLUMNS.indexOf('comment')] = "'=1+1";
  var parsed = records([raw])[0];
  assert.strictEqual(parsed.receivedAt.toISOString(), '2026-11-01T00:00:00.000Z');
  assert.strictEqual(parsed.q1, 5);
  assert.strictEqual(parsed.isTest, true);
  assert.strictEqual(parsed.comment, '=1+1');
});

test('受入1: 全体・期間30日の概要（回答数・平均・分布・再利用意向・低評価・未対応）。テストは除外', function () {
  var d = Analytics.buildDashboard(records(FIXTURE), { brand: 'all', period: '30' }, NOW);
  var s = d.summary;
  assert.strictEqual(s.count, 3, '1日・10日・5日前の本番回答（テスト・45日・100日前は除外）');
  assert.strictEqual(s.averageRating, 3.3);
  assert.deepStrictEqual(s.ratingDistribution.map(function (x) { return x.count; }), [0, 1, 1, 0, 1]);
  assert.deepStrictEqual(s.reuse.map(function (x) { return [x.id, x.count]; }), [['definitely', 2], ['maybe', 0], ['not_now', 1]]);
  assert.strictEqual(s.lowRatingCount, 1);
  assert.strictEqual(s.openCount, 1);
  assert.deepStrictEqual(s.statusCounts.map(function (x) { return x.count; }), [1, 1, 0, 1]);
});

test('受入1: 期間（30/90/全期間）とブランド別の切替', function () {
  var all = records(FIXTURE);
  function count(f) { return Analytics.buildDashboard(all, f, NOW).summary.count; }
  assert.strictEqual(count({ period: '30' }), 3);
  assert.strictEqual(count({ period: '90' }), 4);
  assert.strictEqual(count({ period: 'all' }), 5);
  assert.strictEqual(count({ period: 'all', brand: 'snb' }), 2);
  assert.strictEqual(count({ period: 'all', brand: 'mens' }), 1);
  assert.strictEqual(count({ period: 'all', brand: 'studio-x' }), 2);
  assert.strictEqual(count({ period: 'zzz', brand: 'zzz' }), 3, '不正値は既定（全体・30日）に丸める');
  var mens = Analytics.buildDashboard(all, { period: 'all', brand: 'mens' }, NOW).summary;
  assert.strictEqual(mens.averageRating, 1);
  assert.strictEqual(mens.lowRatingCount, 1);
});

test('受入1: 問題分析。未回答・該当なしを分母から除外し、分母を返す。Q5は4カテゴリの件数', function () {
  var a = Analytics.buildDashboard(records(FIXTURE), { period: 'all' }, NOW).issues;
  assert.strictEqual(a.items.length, 9);
  var website = a.items.filter(function (i) { return i.id === 'website'; })[0];
  assert.deepStrictEqual(website.counts, { ok: 1, minor: 1, trouble: 0, na: 0, unanswered: 3 });
  assert.strictEqual(website.denominator, 2);
  assert.strictEqual(website.problemRate, 50);
  var aircon = a.items.filter(function (i) { return i.id === 'aircon'; })[0];
  assert.strictEqual(aircon.denominator, 0);
  assert.strictEqual(aircon.problemRate, null, '分母0は率を出さない');
  assert.strictEqual(aircon.counts.na, 1);
  assert.deepStrictEqual(a.categories.map(function (c) { return [c.id, c.count]; }), [['supplies', 1], ['damage', 1], ['cleanliness', 1], ['other', 0]]);
  assert.strictEqual(a.noIssueCount, 1);
  assert.strictEqual(a.q5AnsweredCount, 3);
});

test('受入2: テスト回答は scope:test のときだけ、テスト回答だけを扱う', function () {
  var d = Analytics.buildDashboard(records(FIXTURE), { scope: 'test', period: 'all' }, NOW);
  assert.strictEqual(d.summary.count, 1);
  assert.strictEqual(d.list.cards[0].isTest, true);
  assert.strictEqual(d.issues.categories.filter(function (c) { return c.id === 'other'; })[0].count, 1);
});

test('受入2: 0件でも壊れない（平均は null、率は null、カード0件）', function () {
  var d = Analytics.buildDashboard([], {}, NOW);
  assert.strictEqual(d.summary.count, 0);
  assert.strictEqual(d.summary.averageRating, null);
  assert.strictEqual(d.list.total, 0);
  assert.ok(d.issues.items.every(function (i) { return i.problemRate === null; }));
});

test('カード: 未対応→対応中→その他、同順位は新しい順。自由記述なしの設備問題も残す。状況・問題有無で絞り込み', function () {
  var all = records(FIXTURE.concat([row({ brand: 'mens', answers: { q5: ['damage'] }, daysAgo: 2, notifyFailed: true })]));
  var list = Analytics.buildDashboard(all, { period: 'all' }, NOW).list;
  assert.deepStrictEqual(list.cards.map(function (c) { return c.status; }), ['未対応', '未対応', '対応中', '対応不要', '対応不要', '対応不要']);
  var first = list.cards[0];
  assert.strictEqual(first.brandName, 'SNB mens');
  assert.strictEqual(first.comment, '', '自由記述なしの設備問題');
  assert.deepStrictEqual(first.issues, ['備品の破損・故障']);
  assert.strictEqual(first.notifyFailed, true);
  assert.strictEqual(first.receivedAt, '2026/11/06 12:00');
  assert.ok(first.details.some(function (d) { return d.label.indexOf('Q3. 照明の操作') === 0 && d.value === '未回答'; }));
  function ids(f) { return Analytics.buildDashboard(all, Object.assign({ period: 'all' }, f), NOW).list.cards.length; }
  assert.strictEqual(ids({ status: '対応中' }), 1);
  assert.strictEqual(ids({ problem: 'yes' }), 3);
  assert.strictEqual(ids({ problem: 'no' }), 3);
});

test('カード: 長いコメントもそのまま返し、件数上限を超えたら limited を立てる', function () {
  var many = [];
  for (var i = 0; i < Analytics.CARD_LIMIT + 5; i++) many.push(row({ answers: { comment: 'あ'.repeat(500) }, daysAgo: 1 }));
  var list = Analytics.buildDashboard(records(many), {}, NOW).list;
  assert.strictEqual(list.total, Analytics.CARD_LIMIT + 5);
  assert.strictEqual(list.cards.length, Analytics.CARD_LIMIT);
  assert.strictEqual(list.limited, true);
  assert.strictEqual(list.cards[0].comment.length, 500);
});

test('対応更新の入力検証: status は4種のみ・memo は200字・対象は response_id とブランドだけ', function () {
  var ok = Analytics.validateStatusUpdate({ responseId: 'rid-0001', brand: 'snb', status: '対応中', memo: ' 補充済み\r\n\u0007 ' });
  assert.deepStrictEqual(ok, { ok: true, value: { responseId: 'rid-0001', brand: 'snb', status: '対応中', memo: '補充済み' } });
  assert.deepStrictEqual(Analytics.STATUS_OPTIONS, ['未対応', '対応中', '対応済み', '対応不要']);
  function code(input) { return Analytics.validateStatusUpdate(input).code; }
  assert.strictEqual(code({ responseId: 'rid-0001', brand: 'snb', status: '完了' }), 'INVALID_STATUS');
  assert.strictEqual(code({ responseId: 'rid-0001', brand: 'x', status: '対応中' }), 'INVALID_BRAND');
  assert.strictEqual(code({ responseId: 'a b', brand: 'snb', status: '対応中' }), 'INVALID_RESPONSE_ID');
  assert.strictEqual(code({ responseId: 'rid-0001', brand: 'snb', status: '対応中', memo: 'あ'.repeat(201) }), 'MEMO_TOO_LONG');
  assert.strictEqual(Analytics.validateStatusUpdate({ responseId: 'rid-0001', brand: 'snb', status: '対応中', memo: 'あ'.repeat(200) }).ok, true);
  assert.strictEqual(code({ responseId: 'rid-0001', brand: 'snb', status: '対応中', memo: 5 }), 'INVALID_MEMO');
  assert.strictEqual(code({ responseId: 'rid-0001', brand: 'snb', status: '対応中', comment: '上書き' }), 'UNKNOWN_FIELD');
  assert.strictEqual(code(null), 'INVALID_PAYLOAD');
});
