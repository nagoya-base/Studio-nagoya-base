/*
 * Issue #498: プレスタート期間（2026/10/26〜11/30）の会員案内ヒーローは90日先行予約を主役にし、
 * 2名ペアパック・シャワー等が2026年12月1日スタートであることをヒーロー内で明示する。12/1以降はプレスタート表示を残さない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var hero = require('../scripts/membership-prestart-hero.js');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function textOf(html) { return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '); }

var PAGES = ['membership/index.html', 'mens/membership/index.html', 'studio-x/membership/index.html'];

function prestartHeroOf(html) {
  var start = html.indexOf('data-membership-phase="prestart"');
  var end = html.indexOf('data-membership-phase="regular"');
  assert.ok(start > -1 && end > start, 'prestart / regular の順にヒーローがある');
  return html.slice(start, end);
}

PAGES.forEach(function (page) {
  test(page + ': プレスタートヒーローは90日先行予約が主役で、12/1開始特典を明示する', function () {
    var html = read(page);
    var pre = prestartHeroOf(html);
    var t = textOf(pre);
    assert.match(t, /今すぐ使える特典は/);
    assert.match(t, /90日先行予約/);
    assert.match(t, /30日先まで/);
    assert.match(t, /90日先まで/);
    assert.match(t, /月額500円/);
    assert.match(t, /2026年12月1日スタート/);
    assert.match(t, /シャワー|有料の機材/);
    assert.ok(pre.indexOf('<h1') > -1 && pre.indexOf('90日先行予約') < pre.indexOf('2026年12月1日スタート'), '90日先行予約が開始日より先');
    assert.match(pre, /href="#join"/, '会員登録導線を維持');
  });

  test(page + ': 価格を出す場合は開始日が価格より前にあり、regularヒーローは12/1以降だけ見える', function () {
    var html = read(page);
    var pre = prestartHeroOf(html);
    if (/5,000|¥5,000/.test(pre)) {
      assert.ok(pre.indexOf('2026年12月1日スタート') < pre.search(/5,000/), '開始日が価格より前');
    }
    assert.match(html, /<div data-membership-phase="regular"\{% if membership_is_prestart %\} hidden\{% endif %\}>/);
    assert.match(html, /<div data-membership-phase="prestart"\{% unless membership_is_prestart %\} hidden\{% endunless %\}>/);
    assert.match(html, /\{% include membership_phase_ja\.html %\}/);
    assert.match(html, /membership-prestart-hero\.js/);
  });
});

test('プレスタート告知includeも12/1以降は非表示になる', function () {
  var inc = read('_includes/membership_prestart_ja.html');
  assert.match(inc, /data-membership-phase="prestart"\{% unless membership_is_prestart %\} hidden\{% endunless %\}/);
});

test('ビルド時の境界（1796050800）が2026-12-01 00:00 JSTと一致する', function () {
  assert.match(read('_includes/membership_phase_ja.html'), /< 1796050800/);
  assert.strictEqual(1796050800 * 1000, Date.parse('2026-12-01T00:00:00+09:00'));
  assert.strictEqual(hero.BENEFITS_START_MS, 1796050800 * 1000);
});

test('JS切替: 11/30 23:59 JSTまでprestart、12/1 00:00 JST以降はregular', function () {
  assert.strictEqual(hero.phaseAt(Date.parse('2026-10-26T00:00:00+09:00')), 'prestart');
  assert.strictEqual(hero.phaseAt(Date.parse('2026-11-30T23:59:59+09:00')), 'prestart');
  assert.strictEqual(hero.phaseAt(Date.parse('2026-12-01T00:00:00+09:00')), 'regular');
  var nodes = [{ a: 'prestart', hidden: false }, { a: 'regular', hidden: true }];
  nodes.forEach(function (n) { n.getAttribute = function () { return n.a; }; });
  var doc = { querySelectorAll: function () { return nodes; } };
  hero.apply(doc, Date.parse('2026-12-01T00:00:00+09:00'));
  assert.deepStrictEqual([nodes[0].hidden, nodes[1].hidden], [true, false]);
  hero.apply(doc, Date.parse('2026-11-30T12:00:00+09:00'));
  assert.deepStrictEqual([nodes[0].hidden, nodes[1].hidden], [false, true]);
});
