/*
 * Studio X「一室で、6つの世界。」ギャラリー（Issue #459）。トップ(/studio-x/)と設備ページ(/studio-x/equipment/)の両方が対象。
 * 写真を元の縦横比のまま全体表示し、固定aspect-ratio・固定高さ・object-fit:coverでトリミングしない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..', 'studio-x');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var css = fs.readFileSync(path.join(ROOT, 'style.css'), 'utf8');
var section = html.slice(html.indexOf('id="worlds"'), html.indexOf('equipment-highlight-cta'));
var cards = section.match(/<article class="world-card[\s\S]*?<\/article>/g) || [];

test('6テーマすべて名称・説明が残り、画像は元寸法のwidth/heightを持つ', function () {
  assert.strictEqual(cards.length, 6);
  ['サイバー・ネオン', '白背景', '黒背景', '教室セット', '和ダーク', 'グランジ・廃墟風'].forEach(function (n) {
    assert.ok(section.indexOf('<h3>' + n + '</h3>') !== -1, n);
  });
  cards.forEach(function (c) {
    var m = /width="(\d+)" height="(\d+)"/.exec(c);
    var r = /--ratio:([\d.]+)/.exec(c);
    assert.ok(m && r, 'width/height と --ratio');
    assert.ok(Math.abs(m[1] / m[2] - parseFloat(r[1])) < 0.005, '--ratio は画像の縦横比');
  });
});

test('サイバー・ネオンは縦長のまま表示する', function () {
  assert.ok(/width="1200" height="1887"[^>]*sample_04_neon|sample_04_neon_1200\.webp" width="1200" height="1887"/.test(cards[0]));
});

test('worldsギャラリーのCSSは画像をトリミングしない', function () {
  var rules = css.match(/[^{}]*\.world-[^{}]*\{[^}]*\}/g) || [];
  assert.ok(rules.length > 0);
  rules.forEach(function (r) {
    assert.ok(!/object-fit\s*:\s*cover/.test(r), 'object-fit:cover禁止: ' + r);
    assert.ok(!/aspect-ratio\s*:/.test(r), 'aspect-ratio強制禁止: ' + r);
    assert.ok(!/grid-auto-rows\s*:\s*\d+px/.test(r), '固定行高禁止: ' + r);
  });
  assert.ok(/\.world-card img\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto/.test(css));
});

// ---- 設備ページ（共通パーツ _includes/studio_x_worlds_ja.html + _data/studio_x_worlds.yml）----
var include = fs.readFileSync(path.join(__dirname, '..', '_includes', 'studio_x_worlds_ja.html'), 'utf8');
var worlds = fs.readFileSync(path.join(__dirname, '..', '_data', 'studio_x_worlds.yml'), 'utf8');
var pagesCss = fs.readFileSync(path.join(ROOT, 'pages.css'), 'utf8');

test('設備ページの6テーマは実寸のwidth/heightを持ち、トップの--ratioと同じ縦横比', function () {
  var entries = worlds.split(/^- kicker:/m).slice(1);
  assert.strictEqual(entries.length, 6);
  assert.ok(/<img [^>]*width="\{\{ world\.width \}\}" height="\{\{ world\.height \}\}"/.test(include));
  entries.forEach(function (e, i) {
    var w = +/width: (\d+)/.exec(e)[1], h = +/height: (\d+)/.exec(e)[1];
    var r = parseFloat(/--ratio:([\d.]+)/.exec(cards[i])[1]);
    assert.ok(Math.abs(w / h - r) < 0.005, 'トップと設備ページの縦横比が一致: ' + i);
    var m = /width="(\d+)" height="(\d+)"/.exec(cards[i]);
    assert.ok(+m[1] === w && +m[2] === h, 'トップと設備ページで画像寸法が一致: ' + i);
  });
});

test('設備ページのテーマ写真CSSは画像をトリミングしない', function () {
  var rules = pagesCss.match(/[^{}]*\.theme-option-[^{}]*\{[^}]*\}/g) || [];
  assert.ok(rules.length > 0);
  rules.forEach(function (r) {
    assert.ok(!/object-fit\s*:\s*cover/.test(r), 'object-fit:cover禁止: ' + r);
    assert.ok(!/aspect-ratio\s*:/.test(r), 'aspect-ratio強制禁止: ' + r);
    assert.ok(!/[^-]height\s*:\s*\d+px/.test(r), '固定高さ禁止: ' + r);
  });
  assert.ok(/\.theme-option-card img\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto/.test(pagesCss));
});

test('設備ページ: 6テーマが3列に割り当てられ、1列表示用の順序が付く', function () {
  [1, 2, 3].forEach(function (c) { assert.ok(new RegExp('column: ' + c + '\\n').test(worlds), 'column ' + c); });
  [1, 2, 3, 4, 5, 6].forEach(function (p) { assert.ok(new RegExp('position: ' + p + '\\n').test(worlds), 'position ' + p); });
  assert.ok(/style="order:\{\{ world\.position \}\}"/.test(include));
});
