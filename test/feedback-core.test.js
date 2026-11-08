/*
 * 利用後アンケート（Issue #835）の共通コア scripts/feedback-core.js の検証。
 * 受入テスト2（Q1/Q6だけで回答可・Q4条件表示・Q5排他・500字制限）と保存列の安全性。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var Core = require('../scripts/feedback-core.js');

function codes(result) { return result.errors.map(function (e) { return e.field + ':' + e.code; }); }
var MIN = { q1: 4, q6: 'maybe' };

test('ブランド: SNB・mens・Studio X の3つだけで、戻り先がブランド別', function () {
  assert.deepStrictEqual(Object.keys(Core.BRANDS), ['snb', 'mens', 'studio-x']);
  assert.strictEqual(Core.BRANDS.snb.backUrl, 'https://nagoya-base.github.io/Studio-nagoya-base/');
  assert.strictEqual(Core.BRANDS.mens.backUrl, 'https://nagoya-base.github.io/Studio-nagoya-base/mens/');
  assert.strictEqual(Core.BRANDS['studio-x'].backUrl, 'https://nagoya-base.github.io/Studio-nagoya-base/studio-x/');
  ['', 'SNB', 'studio_x', 'toString', '__proto__', null, 1].forEach(function (b) { assert.strictEqual(Core.isBrand(b), false, String(b)); });
});

test('設問: Q2は4項目・Q3は5項目・4択、Q5は5択（特になしが排他）、Q6は3択', function () {
  assert.deepStrictEqual(Core.Q2_ITEMS.map(function (i) { return i.label; }), ['ホームページの見やすさ', '予約のしやすさ', '案内メールのタイミング', '案内メールのわかりやすさ']);
  assert.deepStrictEqual(Core.Q3_ITEMS.map(function (i) { return i.label; }), ['場所の見つけやすさ', '照明の操作', 'エアコンの操作', '備品の探しやすさ', '後片付けのわかりやすさ']);
  assert.deepStrictEqual(Core.CONDITION_OPTIONS.map(function (o) { return o.label; }), ['問題なかった', '少し気になった', '困った', '該当なし・利用していない']);
  assert.deepStrictEqual(Core.ISSUE_OPTIONS.map(function (o) { return o.label; }), ['消耗品不足', '備品の破損・故障', '清掃・衛生面', 'その他改善してほしいこと', '特になし']);
  assert.deepStrictEqual(Core.REUSE_OPTIONS.map(function (o) { return o.label; }), ['ぜひ利用したい', '機会があれば利用したい', '今のところ利用したいと思わない']);
  assert.strictEqual(Core.QUESTIONS.comment.label, '気になった点・ご感想など');
  assert.match(Core.QUESTIONS.comment.hint, /個人情報/);
  assert.match(Core.QUESTIONS.comment.hint, /オーナーが確認/);
});

test('Studio X に出る文言（設問・選択肢）に用途を示す語を含めない', function () {
  var text = JSON.stringify([Core.QUESTIONS, Core.Q2_ITEMS, Core.Q3_ITEMS, Core.CONDITION_OPTIONS, Core.STAFF_OPTIONS, Core.ISSUE_OPTIONS, Core.REUSE_OPTIONS, Core.BRANDS['studio-x']]);
  ['緊縛', 'フェチ', 'SM', 'bondage', '縄', 'ロープ'].forEach(function (w) { assert.strictEqual(text.indexOf(w), -1, w); });
  assert.ok(!/完全匿名/.test(text));
});

test('必須はQ1とQ6だけ（それ以外が空でも回答できる）', function () {
  var ok = Core.validateAnswers(MIN);
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.answers, { q1: 4, q2: {}, q3: {}, q4: '', q4_rating: '', q5: [], q6: 'maybe', comment: '' });
  assert.deepStrictEqual(codes(Core.validateAnswers({})), ['q1:REQUIRED', 'q6:REQUIRED']);
  assert.deepStrictEqual(codes(Core.validateAnswers({ q1: 0, q6: 'x' })), ['q1:INVALID_OPTION', 'q6:INVALID_OPTION']);
  assert.deepStrictEqual(codes(Core.validateAnswers({ q1: '5', q6: 'maybe' })), ['q1:INVALID_OPTION'], '文字列の"5"は受け付けない');
  assert.deepStrictEqual(codes(Core.validateAnswers({ q1: 4.5, q6: 'maybe' })), ['q1:INVALID_OPTION']);
});

test('Q2/Q3: 定義済みの項目・4択だけを受け付ける', function () {
  var r = Core.validateAnswers(Object.assign({ q2: { website: 'ok', booking: 'na' }, q3: { lighting: 'trouble' } }, MIN));
  assert.deepStrictEqual(r.answers.q2, { website: 'ok', booking: 'na' });
  assert.deepStrictEqual(r.answers.q3, { lighting: 'trouble' });
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q2: { shower: 'ok' } }, MIN))), ['q2:UNKNOWN_FIELD']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q3: { aircon: 'bad' } }, MIN))), ['q3:INVALID_OPTION']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q3: ['ok'] }, MIN))), ['q3:INVALID_TYPE']);
});

test('Q4: 「はい」のときだけ評価を受け付け、それ以外で評価が届いたら hidden 値として拒否', function () {
  assert.strictEqual(Core.validateAnswers(Object.assign({ q4: 'yes', q4_rating: 5 }, MIN)).answers.q4_rating, 5);
  assert.strictEqual(Core.validateAnswers(Object.assign({ q4: 'yes' }, MIN)).ok, true, '「はい」でも評価は任意');
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q4: 'no', q4_rating: 3 }, MIN))), ['q4_rating:HIDDEN_VALUE']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q4_rating: 3 }, MIN))), ['q4_rating:HIDDEN_VALUE']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q4: 'yes', q4_rating: 6 }, MIN))), ['q4_rating:INVALID_OPTION']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q4: 'maybe' }, MIN))), ['q4:INVALID_OPTION']);
});

test('Q5: 複数選択可・「特になし」は他と排他・重複/未知は拒否', function () {
  assert.deepStrictEqual(Core.validateAnswers(Object.assign({ q5: ['other', 'supplies'] }, MIN)).answers.q5, ['supplies', 'other'], '表示順に並べ直す');
  assert.deepStrictEqual(Core.validateAnswers(Object.assign({ q5: ['none'] }, MIN)).answers.q5, ['none']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q5: ['none', 'damage'] }, MIN))), ['q5:EXCLUSIVE_CONFLICT']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q5: ['damage', 'damage'] }, MIN))), ['q5:DUPLICATE_OPTION']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q5: ['noise'] }, MIN))), ['q5:INVALID_OPTION']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ q5: 'none' }, MIN))), ['q5:INVALID_TYPE']);
});

test('自由記述: 500字まで（コードポイント単位）・501字は拒否・制御文字除去', function () {
  assert.strictEqual(Core.validateAnswers(Object.assign({ comment: 'あ'.repeat(500) }, MIN)).ok, true);
  assert.strictEqual(Core.validateAnswers(Object.assign({ comment: '😀'.repeat(500) }, MIN)).ok, true, '絵文字1つ=1字');
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ comment: 'あ'.repeat(501) }, MIN))), ['comment:TOO_LONG']);
  assert.deepStrictEqual(codes(Core.validateAnswers(Object.assign({ comment: { a: 1 } }, MIN))), ['comment:INVALID_TYPE']);
  assert.strictEqual(Core.validateAnswers(Object.assign({ comment: '  a\u0000b\r\nc\u0007  ' }, MIN)).answers.comment, 'ab\nc');
});

test('未知のフィールド（氏名・メール・予約番号など）は受け付けない', function () {
  ['name', 'email', 'booking_id', 'token', 'is_test', 'status'].forEach(function (key) {
    var input = Object.assign({}, MIN);
    input[key] = 'x';
    assert.deepStrictEqual(codes(Core.validateAnswers(input)), ['answers:UNKNOWN_FIELD'], key);
  });
  assert.deepStrictEqual(codes(Core.validateAnswers(null)), ['answers:INVALID_TYPE']);
  assert.deepStrictEqual(codes(Core.validateAnswers([1])), ['answers:INVALID_TYPE']);
});

test('要確認判定: Q5で特になし以外を選択、または自由記述あり → 未対応。それ以外は対応不要', function () {
  function status(extra) {
    var answers = Core.validateAnswers(Object.assign({}, MIN, extra)).answers;
    var row = Core.buildRow(answers, { responseId: 'r', receivedAt: 'x', brand: 'snb', isTest: false });
    return row[Core.COLUMNS.indexOf('status')];
  }
  assert.strictEqual(status({}), '対応不要');
  assert.strictEqual(status({ q5: ['none'] }), '対応不要');
  assert.strictEqual(status({ q2: { booking: 'trouble' } }), '対応不要', 'Q2/Q3だけでは要確認にしない');
  ['supplies', 'damage', 'cleanliness', 'other'].forEach(function (id) { assert.strictEqual(status({ q5: [id] }), '未対応', id); });
  assert.strictEqual(status({ comment: 'ありがとうございました' }), '未対応');
  assert.strictEqual(status({ comment: '   ' }), '対応不要', '空白だけは空欄扱い');
});

test('保存列: 予約ID・氏名・メール・トークンを持たず、status/memo/notify_failed を持つ。数式は無害化', function () {
  var cols = Core.COLUMNS;
  ['response_id', 'received_at', 'brand', 'is_test', 'q1_overall', 'q6_reuse', 'comment', 'status', 'memo', 'notify_failed'].forEach(function (c) { assert.ok(cols.indexOf(c) !== -1, c); });
  cols.forEach(function (c) { assert.ok(!/token|booking_?id|^name|email|phone|reservation|digest|^ip/i.test(c), c); });
  var answers = Core.validateAnswers(Object.assign({ comment: '=HYPERLINK("http://x")', q5: ['supplies', 'damage'] }, MIN)).answers;
  var row = Core.buildRow(answers, { responseId: 'rid', receivedAt: '2026-11-08T03:00:00.000Z', brand: 'mens', isTest: true });
  assert.strictEqual(row.length, cols.length);
  assert.strictEqual(row[cols.indexOf('comment')], '\'=HYPERLINK("http://x")');
  assert.strictEqual(row[cols.indexOf('is_test')], 1);
  assert.strictEqual(row[cols.indexOf('q5_issues')], 'supplies,damage');
  assert.strictEqual(row[cols.indexOf('brand')], 'mens');
});

test('URL解釈: ブランドはパスだけ、テストは厳密な ?test=1、トークンは #t= だけ', function () {
  var base = '/Studio-nagoya-base/feedback/';
  assert.deepStrictEqual(Core.parseLocation(base + 'snb/', '', ''), { brand: 'snb', isTest: false, token: '' });
  assert.deepStrictEqual(Core.parseLocation(base + 'studio-x/index.html', '?test=1', ''), { brand: 'studio-x', isTest: true, token: '' });
  assert.strictEqual(Core.parseLocation(base + 'mens/', '?test=true', '').isTest, false);
  assert.strictEqual(Core.parseLocation(base + 'mens/', '?test=1&x=1', '').isTest, false);
  assert.strictEqual(Core.parseLocation(base + 'mens/', '', '#t=abcdefghijklmnop').token, 'abcdefghijklmnop');
  assert.strictEqual(Core.parseLocation(base + 'other/', '', '').brand, null);
  assert.strictEqual(Core.parseLocation('/survey/', '', '').brand, null);
  assert.strictEqual(Core.isValidTokenFormat('abcdefghijklmnop'), true);
  assert.strictEqual(Core.isValidTokenFormat('short'), false);
  assert.strictEqual(Core.isValidTokenFormat('a'.repeat(16) + '<'), false);
});
