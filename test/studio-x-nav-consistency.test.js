/*
 * Issue #582: Studio Xのデスクトップナビ（.desktop-nav）とモバイルメニュー（.mobile-menu）は
 * ページごとに別々に手書きされており、片方だけ編集できてしまう（#507でモバイルだけに
 * 「6時間貸切ベースプラン」が入り、挿入時に「撮れる世界」も重複した）。
 * 共通化は全ページのfront matter追加を伴い大きいため見送り、差分を機械的に検知する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', 'studio-x');
var BASE_PLAN = 'base-plan/';

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function links(html, open) {
  var start = html.indexOf(open);
  assert.ok(start !== -1, open + ' が無い');
  var end = html.indexOf(open.indexOf('<nav') === 0 ? '</nav>' : '<main', start);
  var block = html.slice(start, end);
  var out = [];
  var re = /<a\b([^>]*)href="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g;
  var m;
  while ((m = re.exec(block))) {
    var cls = /class="([^"]*)"/.exec(m[1] + m[3]);
    out.push({ href: m[2], label: m[4].replace(/<[^>]*>/g, '').trim(), cta: !!(cls && /\bmobile-menu-cta\b/.test(cls[1])) });
  }
  return out;
}

function navs(rel) {
  var html = read(rel);
  return {
    desktop: links(html, '<nav class="desktop-nav"'),
    mobile: links(html, '<div class="mobile-menu"').filter(function (l) { return !l.cta; })
  };
}

/* 導線を持つ主要ページ（予約フォーム・規約など最小ナビのページは対象外） */
var MAIN_PAGES = ['index.html', 'membership/index.html', 'how-to/index.html', 'equipment/index.html'];
var ALL_PAGES = MAIN_PAGES.concat(['legal/index.html', 'base-plan/index.html', 'booking/index.html', 'reservation/index.html']);

test('モバイルメニューに同じリンク先・同じ表示名の重複がない（#582「撮れる世界」重複）', function () {
  ALL_PAGES.forEach(function (rel) {
    var seen = {};
    navs(rel).mobile.forEach(function (l) {
      var key = l.href + '|' + l.label;
      assert.ok(!seen[key], rel + ': モバイルメニューで重複 ' + key);
      seen[key] = true;
    });
  });
});

test('デスクトップナビの全リンクがモバイルメニューにも存在する（片方だけの追加を防ぐ）', function () {
  ALL_PAGES.forEach(function (rel) {
    var n = navs(rel);
    var mobileHrefs = n.mobile.map(function (l) { return l.href; });
    n.desktop.forEach(function (l) {
      assert.ok(mobileHrefs.indexOf(l.href) !== -1, rel + ': デスクトップのみのリンク ' + l.label + ' (' + l.href + ')');
    });
  });
});

test('主要ページは「6時間貸切ベースプラン」へ、デスクトップ・モバイルの両方から遷移できる（#582）', function () {
  MAIN_PAGES.forEach(function (rel) {
    var prefix = rel === 'index.html' ? '' : '../';
    var n = navs(rel);
    [['desktop', n.desktop], ['mobile', n.mobile]].forEach(function (pair) {
      var hits = pair[1].filter(function (l) { return l.href === prefix + BASE_PLAN; });
      assert.strictEqual(hits.length, 1, rel + ' ' + pair[0] + ': ベースプランのリンクはちょうど1件');
      assert.strictEqual(hits[0].label, '6時間貸切ベースプラン');
    });
  });
});

test('Studio Xトップ: デスクトップとモバイルで主要ナビの順序が一致する', function () {
  var n = navs('index.html');
  var mobileOnly = ['legal/'];
  var desktop = n.desktop.map(function (l) { return l.href; });
  var mobile = n.mobile.map(function (l) { return l.href; }).filter(function (h) { return mobileOnly.indexOf(h) === -1; });
  assert.deepStrictEqual(mobile, desktop);
});

test('ベースプランのリンクにGA4計測属性が付いている', function () {
  var html = read('index.html');
  assert.strictEqual(html.split('data-analytics-type="base_plan_menu" data-analytics-location="header" ').length - 1, 1, 'デスクトップ');
  assert.strictEqual(html.split('data-analytics-type="base_plan_menu" data-analytics-location="header_mobile_menu" ').length - 1, 1, 'モバイル');
});
