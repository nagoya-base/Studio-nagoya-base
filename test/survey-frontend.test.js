/*
 * アンケート画面（survey/index.html / scripts/survey-app.js / styles/survey.css）の静的検証（Issue #374）。
 * 実ブラウザでの操作確認手順は PR 本文と gas/survey/README.md を参照。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

function read(file) { return fs.readFileSync(path.join(__dirname, '..', file), 'utf8'); }

test('ページ: noindex・viewport・外部送信/解析タグなし・必要なscriptのみ読み込む', function () {
  var html = read('survey/index.html');
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1\.0"/);
  assert.match(html, /<main class="sv-page">/);
  assert.match(html, /data-schema-url="survey-schema\.json/);
  ['survey-core.js', 'survey-config.js', 'survey-app.js'].forEach(function (s) { assert.ok(html.indexOf('../scripts/' + s) !== -1, s); });
  assert.ok(!/googletagmanager|gtag\(/.test(html), '匿名アンケートに解析タグを入れない');
  assert.ok(!/formspree/i.test(html));
});

test('クライアントJS: textContent描画・text/plain送信・二重送信防止・秘密情報なし', function () {
  var js = read('scripts/survey-app.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(js), '回答・schema文字列をHTMLとして解釈しない');
  assert.match(js, /'Content-Type': 'text\/plain;charset=utf-8'/);
  assert.match(js, /if \(isSubmitting\) return/);
  assert.match(js, /button\.disabled = true/);
  assert.ok(!/AKfycb|spreadsheets\/d\/|SURVEY_SPREADSHEET_ID/.test(js + read('scripts/survey-config.js')), 'Spreadsheet ID等を含めない');
  /* 設問文・選択肢をクライアントにハードコードしていない */
  ['緊縛', '土日祝', '男性同士', 'シャワー'].forEach(function (word) { assert.ok(js.indexOf(word) === -1, word); });
});

test('CSS: スマホ向けタップ領域と16px入力（iOS自動ズーム防止）、横スクロールを作らない', function () {
  var css = read('styles/survey.css');
  assert.match(css, /\.sv-option \{[^}]*min-height: 48px/);
  assert.match(css, /font-size: 16px/);
  assert.match(css, /\.sv-btn \{[^}]*min-height: 52px/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /max-width: 640px/);
  assert.match(css, /prefers-color-scheme: dark/);
});

test('設問定義の正本はJSON1か所: GAS配布物にも同じschemaが埋め込まれる', function () {
  var prepare = require('../scripts/prepare-survey-gas-project');
  var gs = prepare.buildSchemaGs();
  var schema = require('../survey/survey-schema.json');
  var embedded = new Function(gs.replace("'use strict';", '') + '; return SURVEY_SCHEMA;')();
  assert.deepStrictEqual(embedded, schema);
  /* 設問文を重複して持つ可能性があるソースに schema の設問文が現れない */
  ['scripts/survey-core.js', 'scripts/survey-analytics.js', 'gas/survey/public/SurveyWebApp.gs', 'gas/survey/shared/SurveyRepository.gs', 'gas/survey/admin/SurveyAdmin.gs'].forEach(function (file) {
    var text = read(file);
    assert.ok(text.indexOf('利用を見送る') === -1 && text.indexOf('緊縛・ロープとの関わり方') === -1, file);
  });
});
