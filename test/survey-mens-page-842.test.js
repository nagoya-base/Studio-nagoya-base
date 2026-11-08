/*
 * SNB mens専用の独立ページ /mens/survey/（Issue #842）の静的検証。
 * #839 の共通ページ内カードは撤去済みで、/survey/・/feedback/（#835）・利用後メール（#834）は変更しない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('独立ページ: /mens/survey/ が別HTMLとして存在し、メンズ向けtitle・canonical・h1表記を持つ', function () {
  var html = read('mens/survey/index.html');
  assert.match(html, /<title>SNB mens アンケート \| Studio Nagoya Base<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/nagoya-base\.github\.io\/Studio-nagoya-base\/mens\/survey\/">/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /id="survey-app" data-title="SNB mens アンケート"/);
  /* 共通ページの看板（共通ヒーロー画像・全般向け見出し）は使わず、mens専用のヒーロー／OGPを使う */
  assert.ok(html.indexOf('hero_survey_1200') === -1 && html.indexOf('ogp-survey-1200x630') === -1 && html.indexOf('サービス改善フィードバック') === -1);
  assert.ok(html.indexOf('src="../../images/hero_mens_survey_1200.webp" width="1200" height="630"') !== -1);
  assert.ok(html.indexOf('<meta property="og:image" content="https://nagoya-base.github.io/Studio-nagoya-base/images/ogp-mens-survey-1200x630.jpg">') !== -1);
  assert.ok(html.indexOf('<meta name="twitter:card" content="summary_large_image">') !== -1);
});

test('独立ページ: 回答前に「未利用者も回答可」「利用後の満足度アンケートではない」を明示する', function () {
  var html = read('mens/survey/index.html');
  assert.ok(html.indexOf('SNB mensについて、あなたのご意見をお聞かせください。') !== -1);
  assert.ok(html.indexOf('スタジオを利用したことがない方も回答できます') !== -1);
  assert.ok(html.indexOf('利用後の満足度アンケートではありません') !== -1);
  assert.ok(html.indexOf('今後のサービス改善・ニーズ調査です') !== -1);
  ['利用者限定', '利用後に回答', '利用した感想'].forEach(function (w) { assert.ok(html.indexOf(w) === -1, w); });
  assert.ok(!/\/booking\/|\/feedback\/|reservation/.test(html), '予約・利用後アンケートへ誘導しない');
});

test('独立ページ: schema・スクリプトは1か所の正本を共有し、同じ保護（noindex・解析タグなし）を保つ', function () {
  var html = read('mens/survey/index.html');
  assert.match(html, /data-schema-url="\.\.\/\.\.\/survey\/survey-schema\.json/);
  ['survey-core.js', 'survey-config.js', 'survey-app.js'].forEach(function (s) { assert.ok(html.indexOf('../../scripts/' + s) !== -1, s); });
  assert.match(html, /<link rel="stylesheet" href="\.\.\/\.\.\/styles\/survey\.css/);
  assert.ok(!/googletagmanager|gtag\(|formspree/i.test(html));
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
});

test('共通ページ: #839のメンズ入口カードを撤去し、全般向け案内（未利用者可）は維持する', function () {
  var html = read('survey/index.html');
  assert.ok(!/sv-entry|SNB mens向けアンケート|mens\/survey/.test(html));
  assert.match(html, /data-schema-url="survey-schema\.json/);
  assert.ok(!/sv-entry/.test(read('styles/survey.css')));
  var intro = require('../survey/survey-schema.json').meta.intro.join('\n');
  assert.ok(intro.indexOf('スタジオを利用したことがない方も回答できます') !== -1);
  assert.ok(intro.indexOf('利用後の満足度アンケートではなく') !== -1);
});

test('/mens/ の調査リンクは専用ページへ。予約CTAではなく説明付きテキストリンク', function () {
  ['mens/index.html', 'mens/preview-633.html'].forEach(function (f) {
    var html = read(f);
    var m = html.match(/<p class="cta-hint"[^>]*>[^<]*<a href="\{\{ '\/mens\/survey\/' \| relative_url \}\}">SNB mens アンケート<\/a>[^<]*<\/p>/);
    assert.ok(m, f);
    assert.ok(m[0].indexOf('予約ではなく') !== -1);
    assert.ok(!/href="\{\{ '\/survey\/'/.test(html), f + ': 共通ページへ向けない');
  });
});

test('アプリ: data-titleがあるときだけ初回見出しを差し替え、既存の表示・保存処理は変えない', function () {
  var js = read('scripts/survey-app.js');
  assert.match(js, /root\.getAttribute\('data-title'\) \|\| schema\.meta\.title/);
  assert.ok(read('survey/index.html').indexOf('data-title') === -1, '共通ページの見出しは従来どおりschema');
  /* 画面遷移は入口でなく本体先頭へ、初回はページ先頭のまま（#839レビュー対応を維持） */
  assert.match(js, /function focusAndScroll\(el\)/);
  assert.match(js, /el\.focus\(\{ preventScroll: true \}\)/);
});

test('非干渉: /feedback/（#835）・利用後メール（#834）の資材にメンズ専用ページの変更が混入していない', function () {
  var fb = path.join(__dirname, '..', 'feedback', 'index.html');
  if (fs.existsSync(fb)) assert.ok(read('feedback/index.html').indexOf('mens/survey') === -1);
});

test('戻り先: 完了・回答済み・対象外の全画面（renderEnd）が data-back-* を使い、専用ページは/mens/・共通ページは従来の戻り先', function () {
  var js = read('scripts/survey-app.js');
  /* 3種の終了画面はすべて renderEnd 経由で、戻り先は backLink 1か所から決まる */
  ['complete', 'answered', 'underage'].forEach(function (k) { assert.ok(js.indexOf("renderEnd('" + k + "')") !== -1, k); });
  assert.match(js, /h\('a', \{ href: backLink\.href, text: backLink\.label \}\)/);
  assert.ok(js.split("href: 'https://nagoya-base.github.io/Studio-nagoya-base/'").length === 2, '既定の戻り先は1か所だけ');
  /* サイト内パスだけ受け付ける（//・http(s):・javascript: は既定へ） */
  assert.match(js, /\/\^\\\/\(\?!\\\/\)\[\^\\s\]\*\$\/\.test\(url\)/);
  assert.ok(!/innerHTML/.test(js));
  var mens = read('mens/survey/index.html');
  assert.match(mens, /data-back-url="\{\{ '\/mens\/' \| relative_url \}\}" data-back-label="SNB mens に戻る"/);
  var common = read('survey/index.html');
  assert.ok(common.indexOf('data-back-') === -1, '共通ページは従来の戻り先（既定値）のまま');
});

test('コメント: 撤去済みの入口カード（#836）への言及を残さない', function () {
  assert.ok(read('scripts/survey-app.js').indexOf('入口カード') === -1);
});
