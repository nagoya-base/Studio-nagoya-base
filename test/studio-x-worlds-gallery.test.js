/*
 * Studio X「一室で、6つの世界。」ギャラリー（Issue #459）。
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
