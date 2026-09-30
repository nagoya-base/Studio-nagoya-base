/*
 * 予約ページのキャッシュ不整合対策のテスト。
 * 新しいHTML（予約フォームの部品）と旧booking-app.jsがブラウザ/CDNキャッシュ上で
 * 組み合わさる事故（PR #367後に日付クリックで自動遷移しなかった事象）を防ぐため、
 * 予約UIを読み込む全ページで、booking用のJS/CSSのURLへビルドごとに変わる
 * バージョン（site.time）を付けることを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
var PAGES = ['booking/index.html', 'booking/en.html', 'mens/booking/index.html', 'studio-x/booking/index.html'];
var VERSION = "\\?v=\\{\\{ site\\.time \\| date: '%s' \\}\\}\"";

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'archive') return;
    var p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.html$/.test(e.name)) out.push(p);
  });
  return out;
}

PAGES.forEach(function (page) {
  test(page + ': booking-logic/config/app.jsとbooking.cssのURLにビルド単位のバージョンが付く', function () {
    var html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    ['scripts/booking-logic.js', 'scripts/booking-config.js', 'scripts/booking-app.js', 'styles/booking.css'].forEach(function (asset) {
      var re = new RegExp('(src|href)="(\\.\\./)+' + asset.replace('.', '\\.') + VERSION);
      assert.match(html, re, asset + 'にバージョンが付いている（相対パスは維持）');
    });
  });
});

test('予約UI（booking_app_*.html）を読み込むページはすべて上記の対象に含まれ、バージョン無しのbooking-app.js参照が残っていない', function () {
  var pages = walk(ROOT, []).filter(function (f) {
    var rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (rel.indexOf('_includes/') === 0) return false;
    var html = fs.readFileSync(f, 'utf8');
    if (/scripts\/booking-app\.js"/.test(html)) assert.fail(rel + ': バージョン無しのbooking-app.js参照');
    return /include booking_app_/.test(html);
  }).map(function (f) { return path.relative(ROOT, f).split(path.sep).join('/'); });
  assert.deepStrictEqual(pages.sort(), PAGES.slice().sort());
});
