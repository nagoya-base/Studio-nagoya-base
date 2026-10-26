/*
 * Issue #544: Studio Xの予約前導線で、シャワーは事前問い合わせ必須のオプションであることを周知する。
 * 周知はページ内の静的案内のみ。予約フォーム・料金・決済ロジックには触れない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

test('Studio X: 料金セクションの予約CTAより前にシャワー事前問い合わせ必須の案内がある', function () {
  var html = read('studio-x/index.html');
  var notice = html.indexOf('id="shower-notice"');
  var cta = html.indexOf('data-analytics-location="price" data-analytics-destination="booking_app"');
  assert.ok(notice > 0, 'shower-notice がある');
  assert.ok(cta > notice, '予約CTAより前に配置');
  var block = html.slice(notice, html.indexOf('</aside>', notice));
  assert.match(block, /通常設備として自由にご利用いただけるものではなく/);
  assert.match(block, /ご予約の前にお問い合わせ/);
  assert.match(block, /設営・片付けサービスと同様/);
  assert.match(block, /事前確認のうえ/);
  assert.match(block, /reservation\/\?intent=consult/);
});

test('Studio X: 案内のCSSは折り返し可能で横スクロールを起こさない', function () {
  var css = read('studio-x/style.css');
  assert.match(css, /\.shower-notice\s*\{[^}]*border/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});
