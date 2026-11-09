/*
 * 利用後アンケート画面（/feedback/<brand>/。Issue #835）の静的検証。
 * 受入テスト1（3ブランドのページ・ロゴ・文言・戻り先）と、解析タグ・リファラ漏れ・既存surveyとの分離。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var Core = require('../scripts/feedback-core.js');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

var PAGES = {
  snb: { name: 'Studio Nagoya Base', logo: '../../images/logo.svg' },
  mens: { name: 'SNB mens', logo: '../../images/logo.svg' },
  'studio-x': { name: 'Studio X', logo: '../../studio-x/touch-icon.svg' }
};

Object.keys(PAGES).forEach(function (brand) {
  test('ページ ' + brand + ': ブランド名・ロゴ・OGP・戻り先・data-brand が正しい', function () {
    var html = read('feedback/' + brand + '/index.html');
    var p = PAGES[brand];
    assert.match(html, new RegExp('<title>ご利用後アンケート \\| ' + p.name + '</title>'));
    assert.ok(html.indexOf('<body data-brand="' + brand + '">') !== -1);
    assert.ok(html.indexOf('<div id="feedback-app" data-brand="' + brand + '"') !== -1);
    assert.ok(html.indexOf('src="' + p.logo + '"') !== -1);
    assert.ok(html.indexOf('<a href="' + Core.BRANDS[brand].backUrl + '" rel="noreferrer">← ' + Core.BRANDS[brand].backLabel + '</a>') !== -1);
    assert.ok(html.indexOf('og:url" content="https://nagoya-base.github.io/Studio-nagoya-base/feedback/' + brand + '/"') !== -1);
    assert.match(html, /<meta property="og:image" content="https:\/\/nagoya-base\.github\.io\/Studio-nagoya-base\/[^"]+\.jpg">/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'feedback', brand, p.logo)), 'ロゴ画像が存在する');
    var og = /og:image" content="https:\/\/nagoya-base\.github\.io\/Studio-nagoya-base\/([^"]+)"/.exec(html)[1];
    assert.ok(fs.existsSync(path.join(__dirname, '..', og)), 'OGP画像が存在する: ' + og);
  });

  test('ページ ' + brand + ': noindex・no-referrer・CSP。GA4等の解析タグ・既存surveyのJSを読み込まない', function () {
    var html = read('feedback/' + brand + '/index.html');
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
    assert.match(html, /<meta name="referrer" content="no-referrer">/);
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self';/);
    assert.ok(!/googletagmanager|gtag\(|analytics\.js|survey-|formspree/i.test(html));
    var scripts = html.match(/<script src="[^"]+"/g).map(function (s) { return s.replace(/<script src="\.\.\/\.\.\/scripts\/|\?v=.*$/g, ''); });
    assert.deepStrictEqual(scripts, ['feedback-core.js', 'feedback-config.js', 'feedback-app.js']);
    assert.ok(!/<script>/.test(html), 'インラインscriptなし（CSPで禁止）');
  });
});

test('Studio X のページに緊縛・フェチ等の用途を示す文言を混入させない', function () {
  var html = read('feedback/studio-x/index.html');
  ['緊縛', 'フェチ', 'bondage', 'Studio Nagoya Base', 'SNB', '縄'].forEach(function (w) { assert.strictEqual(html.indexOf(w), -1, w); });
  var app = read('scripts/feedback-app.js');
  ['緊縛', 'フェチ', 'bondage'].forEach(function (w) { assert.strictEqual(app.indexOf(w), -1, w); });
});

test('クライアントJS: textContent描画・text/plain送信・二重送信防止・トークンをURLから消す・no-referrer', function () {
  var js = read('scripts/feedback-app.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js));
  assert.match(js, /'Content-Type': 'text\/plain;charset=utf-8'/);
  assert.match(js, /if \(isSubmitting\) return/);
  assert.match(js, /button\.disabled = true/);
  assert.match(js, /history\.replaceState\(null, '', window\.location\.pathname \+ window\.location\.search\)/);
  assert.match(js, /referrerPolicy: 'no-referrer'/);
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(js), 'トークン・回答を端末に保存しない');
  /* 設問文は core から読む */
  ['ホームページの見やすさ', '消耗品不足', 'ぜひ利用したい'].forEach(function (w) { assert.strictEqual(js.indexOf(w), -1, w); });
});

test('設定: 公開GAS（回答用 /exec）のURLに接続（Issue #860）。既存surveyのURLを流用しない', function () {
  var config = read('scripts/feedback-config.js');
  var feedbackUrl = /BASE_URL: '([^']+)'/.exec(config)[1];
  assert.strictEqual(feedbackUrl, 'https://script.google.com/macros/s/AKfycbx58zdSmueqRqE36stH03gYjbiRmHQJxmXYGZEuixLRvMeAPrIoipGIzoB6LAOGq0Jh/exec');
  assert.match(feedbackUrl, /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/, '/dev ではなく公開デプロイの /exec');
  var surveyConfig = read('scripts/survey-config.js');
  var surveyUrl = /BASE_URL: '([^']+)'/.exec(surveyConfig)[1];
  assert.strictEqual(config.indexOf(surveyUrl), -1);
  assert.ok(!/spreadsheets\/d\/|SPREADSHEET_ID/.test(config + read('scripts/feedback-app.js')));
});

test('CSS: スマホ向けタップ領域・16px入力・Studio Xの専用配色', function () {
  var css = read('styles/feedback.css');
  assert.match(css, /\.fb-option \{[^}]*min-height: 48px/);
  assert.match(css, /font-size: 16px/);
  assert.match(css, /\.fb-btn \{[^}]*min-height: 52px/);
  assert.match(css, /body\[data-brand="studio-x"\]/);
});

test('既存の /survey/・/mens/survey/ は新しい feedback ファイルを参照しない', function () {
  ['survey/index.html', 'mens/survey/index.html', 'scripts/survey-app.js', 'scripts/survey-core.js', 'gas/survey/public/SurveyWebApp.gs'].forEach(function (file) {
    assert.ok(!/feedback-(core|app|config)|FeedbackCore|FEEDBACK_/.test(read(file)), file);
  });
});
