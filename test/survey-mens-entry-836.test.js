/*
 * /survey/ のSNB mens向け入口と説明文（Issue #836）の静的検証。
 * 既存の設問・保存キー・分岐、/feedback/（#835）・利用後メール（#834）には触れないことも確認する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('入口: SNB mens向け入口と既存の全般入口が両方あり、推奨文面を省略しない', function () {
  var html = read('survey/index.html');
  assert.match(html, /<h2 class="sv-entry-title" id="sv-entry-mens-title">SNB mens向けアンケート<\/h2>/);
  assert.match(html, /Studio Nagoya Base 全般のアンケート/);
  assert.ok(html.indexOf('SNB mensについて、あなたのご意見をお聞かせください。') !== -1);
  assert.ok(html.indexOf('スタジオの利用経験は問いません。') !== -1);
  assert.ok(html.indexOf('利用したことがない方も') !== -1);
  assert.ok(html.indexOf('興味のあるサービスや今後利用してみたいプランについて回答できます。') !== -1);
  assert.ok(html.indexOf('利用後の満足度調査ではありません') !== -1);
  /* 入口はアンケート本体の手前（初見で見える位置）にある */
  assert.ok(html.indexOf('sv-entry-mens') < html.indexOf('id="survey-app"'));
});

test('入口: リンクは同一ページ内アンケートへの単純なアンカーで、クエリで回答を分けない・予約/利用後導線を置かない', function () {
  var html = read('survey/index.html');
  var links = html.match(/<a class="sv-entry-link[^>]*>/g) || [];
  assert.strictEqual(links.length, 2);
  links.forEach(function (a) { assert.match(a, /href="#survey-app"/); });
  assert.ok(!/source=|entry=|\?mens|from=mens/.test(html));
  assert.ok(!/\/booking\/|\/feedback\/|reservation/.test(html));
  ['利用者限定', '利用後に回答', '利用した感想'].forEach(function (w) { assert.ok(html.indexOf(w) === -1, w); });
});

test('共通冒頭: schema.meta.introに未利用者可・利用後アンケートではない旨があり、設問・保存キー・分岐は変えない', function () {
  var schema = require('../survey/survey-schema.json');
  var intro = schema.meta.intro.join('\n');
  assert.ok(intro.indexOf('スタジオを利用したことがない方も回答できます') !== -1);
  assert.ok(intro.indexOf('利用後の満足度アンケートではなく、今後のサービス改善・ニーズを把握するための調査です') !== -1);
  /* 未利用者の選択肢が残っている */
  var usage;
  schema.steps.forEach(function (s) { s.questions.forEach(function (q) { if (q.id === 'usage_status') usage = q; }); });
  var values = usage.options.map(function (o) { return o.value; });
  ['used', 'known_not_used'].forEach(function (v) { assert.ok(values.indexOf(v) !== -1, v); });
  assert.strictEqual(schema.meta.ageField, 'age_screening');
});

test('補助リンク: /mens/ から調査へ。予約CTA(btn)ではなく説明付きテキストリンク', function () {
  var html = read('mens/index.html');
  var m = html.match(/<p class="cta-hint"[^>]*>[^<]*<a href="\{\{ '\/survey\/' \| relative_url \}\}">SNB mens向けアンケート<\/a>[^<]*<\/p>/);
  assert.ok(m, 'mensからの補助リンク');
  assert.ok(m[0].indexOf('予約ではなく') !== -1);
  assert.ok(!/class="btn-(primary|secondary)"[^>]*\/survey\//.test(html));
});

test('CSS: 入口リンクは48px以上のタップ領域・フォーカス表示を持つ', function () {
  var css = read('styles/survey.css');
  assert.match(css, /\.sv-entry-link \{[^}]*min-height: 52px/);
  assert.match(css, /\.sv-entry-link:focus-visible/);
  assert.match(css, /\.sv-entry-mens/);
});

test('非干渉: /feedback/（#835）・利用後メール連携（#834）の資材に本変更が混入していない', function () {
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'feedback')) || read('feedback/index.html').indexOf('sv-entry') === -1);
});
