/*
 * Issue #422: Stripe Checkout成功後の戻りページがSNB / mens / Studio Xで分離されていること。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var PAGES = {
  snb: 'booking/payment-complete.html',
  mens: 'mens/booking/payment-complete.html',
  studio_x: 'studio-x/booking/payment-complete.html'
};

test('3系統の決済完了ページが存在し、noindexで、予約確定済みとは断言しない', function () {
  Object.keys(PAGES).forEach(function (brand) {
    var html = read(PAGES[brand]);
    assert.match(html, /<meta name="robots" content="noindex/, brand);
    assert.match(html, /予約はまだ確定していません/, brand);
    assert.ok(html.indexOf('booking-app.js') === -1, brand + ': 予約フォームのスクリプトを読まない');
  });
});

test('canonicalがそれぞれの導線のパスを指す', function () {
  assert.ok(read(PAGES.snb).indexOf('Studio-nagoya-base/booking/payment-complete.html') !== -1);
  assert.ok(read(PAGES.mens).indexOf('Studio-nagoya-base/mens/booking/payment-complete.html') !== -1);
  assert.ok(read(PAGES.studio_x).indexOf('Studio-nagoya-base/studio-x/booking/payment-complete.html') !== -1);
});

test('mensの戻りページはmens導線へ戻し、SNBトップ・Studio Xへ誘導しない', function () {
  var html = read(PAGES.mens);
  assert.match(html, /brand="mens"/);
  assert.match(html, /"\/mens\/"\s*\|\s*relative_url/);
  assert.ok(html.indexOf('studio-x') === -1);
  assert.ok(!/"\/"\s*\|\s*relative_url/.test(html), 'SNBトップへのリンクなし');
});

test('Studio Xの戻りページにSNB・緊縛向けの文言やリンクを混在させない', function () {
  var html = read(PAGES.studio_x);
  assert.ok(!/緊縛|SNB|Studio Nagoya Base|\/mens\/|styles\/common\.css/.test(html.replace(/<link rel="canonical"[^>]*>/, '')), 'SNB要素の混入');
  assert.match(html, /Studio X/);
});

test('SNBの戻りページからStudio X / mensへ不要に誘導しない', function () {
  var html = read(PAGES.snb);
  assert.ok(html.indexOf('studio-x') === -1);
  assert.ok(html.indexOf('/mens/') === -1);
});
