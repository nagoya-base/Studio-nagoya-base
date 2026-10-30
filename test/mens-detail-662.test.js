'use strict';
/*
 * Issue #662: mens専用の詳細・予約・オプション・完了ページの白地＋青アクセント統一、旧ヒーロー／OGPの差し替え。
 * 配色の正本は本番トップ styles/mens-preview-633.css の .z-paper。専用CSSの変数値と一致することを検査する
 * （トップ側のCSSは分割・移動しない）。
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var BASE = 'https://nagoya-base.github.io/Studio-nagoya-base';
var NEW_OGP = BASE + '/images/mens-preview-ogp-1200x630.jpg';
var TARGETS = [
  'mens/how-to/index.html',
  'mens/membership/index.html',
  'mens/legal/index.html',
  'mens/booking/index.html',
  'mens/booking/options/index.html',
  'mens/booking/payment-complete.html',
  'mens/booking/option-payment-complete.html',
  'mens/membership/complete.html'
];
var META_PAGES = ['mens/how-to/index.html', 'mens/membership/index.html', 'mens/legal/index.html'];
var NO_IMAGE_PAGES = TARGETS.filter(function (f) { return META_PAGES.indexOf(f) === -1; });

var KEYS = ['--bg', '--bg-card', '--bg-section', '--text', '--text-muted', '--accent', '--accent-dark', '--accent-rgb', '--border', '--on-accent'];

function block(css, selector) {
  var i = css.indexOf(selector + ' {');
  assert.ok(i !== -1, selector + ' が見つからない');
  return css.slice(i, css.indexOf('}', i));
}
function vars(b) {
  var o = {};
  b.replace(/(--[a-z-]+):\s*([^;]+);/g, function (_, k, v) { o[k] = v.trim(); return ''; });
  return o;
}
function lum(hex) {
  var c = [1, 3, 5].map(function (i) {
    var v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function ratio(a, b) {
  var la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

test('mens-detail.css: .z-paper（mens-preview-633.css）とパレット値が一致する', function () {
  var top = vars(block(read('styles/mens-preview-633.css'), '.z-paper'));
  var detail = vars(block(read('styles/mens-detail.css'), 'body.mens-detail'));
  KEYS.forEach(function (k) {
    assert.ok(top[k], '.z-paper に ' + k + ' がない');
    assert.strictEqual(detail[k], top[k], k + ' が .z-paper と一致しない');
  });
  ['--bg-nav', '--bg-drawer', '--banner-bg', '--banner-text'].forEach(function (k) {
    assert.ok(detail[k], k + ' が未定義');
  });
});

test('mens-detail.css: 通常本文・リンク・状態色が白地で 4.5:1 以上', function () {
  var d = vars(block(read('styles/mens-detail.css'), 'body.mens-detail'));
  ['--text', '--text-muted', '--accent', '--accent-dark'].forEach(function (k) {
    assert.ok(ratio(d[k], d['--bg']) >= 4.5, k);
    assert.ok(ratio(d[k], d['--bg-card']) >= 4.5, k + ' on card');
  });
  assert.ok(ratio(d['--on-accent'], d['--accent']) >= 4.5);
  assert.ok(ratio(d['--banner-text'], d['--banner-bg']) >= 4.5);
  var css = read('styles/mens-detail.css');
  ['#b3261e', '#1e6b35'].forEach(function (c) { assert.ok(ratio(c, '#ffffff') >= 4.5, c); assert.ok(css.indexOf(c) !== -1, c); });
  assert.ok(ratio('#c0392b', '#ffffff') >= 4.5, '予約エラー色（booking.css 既定）');
});

test('mens-detail.css: 状態色（エラー・成功）を青へ置換せず、予約のエラー色を上書きしない', function () {
  var css = read('styles/mens-detail.css');
  assert.match(css, /\.membership-status\.is-error \{\s*color: #b3261e;/);
  assert.match(css, /\.membership-status\.is-ok \{\s*color: #1e6b35;/);
  assert.strictEqual(css.indexOf('--ba-error:'), -1);
});

test('対象8ページだけが専用CSSとbodyクラスを持つ。対象外のHTMLには波及しない', function () {
  TARGETS.forEach(function (f) {
    var h = read(f);
    var depth = f.split('/').length - 1;
    var href = new Array(depth + 1).join('../') + 'styles/mens-detail.css';
    assert.ok(h.indexOf('<link rel="stylesheet" href="' + href + '">') !== -1, f + ' のCSS読込');
    assert.ok(fs.existsSync(path.join(ROOT, path.dirname(f), href)), f + ' の相対パス');
    assert.match(h, /<body class="mens-detail" data-page-type=/, f);
    assert.match(h, /data-site-section="mens"/, f);
  });
  var all = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach(function (e) {
      var rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory()) {
        if (['node_modules', '.git', '_site', 'archive'].indexOf(e.name) === -1 && e.name[0] !== '.') walk(rel);
      } else if (/\.html$/.test(e.name)) all.push(rel);
    });
  })('');
  all.forEach(function (f) {
    var uses = /mens-detail\.css|class="mens-detail"/.test(read(f));
    assert.strictEqual(uses, TARGETS.indexOf(f) !== -1, f);
  });
  ['styles/common.css', 'styles/mens.css', 'styles/booking.css', 'styles/mens-preview-633.css'].forEach(function (f) {
    assert.strictEqual(read(f).indexOf('mens-detail'), -1, f + ' は変更しない');
  });
});

test('旧OGP／旧ヒーローを採用済み素材へ差し替え（利用ガイド・会員案内・規約）', function () {
  META_PAGES.forEach(function (f) {
    var h = read(f);
    assert.strictEqual(h.indexOf('ogp-mens-v2'), -1, f);
    assert.ok(h.indexOf('<meta property="og:image" content="' + NEW_OGP + '">') !== -1, f + ' og:image');
    assert.ok(h.indexOf('<meta name="twitter:image" content="' + NEW_OGP + '">') !== -1, f + ' twitter:image');
  });
  assert.ok(fs.existsSync(path.join(ROOT, 'images/mens-preview-ogp-1200x630.jpg')));
  assert.ok(fs.existsSync(path.join(ROOT, 'images/ogp-mens-v2-1200x630.jpg')), '旧画像は削除しない');
});

test('会員案内: 文字入りヒーロー(1600x841)・alt・preloadとH1の併存。ヒーローとOGPは別ファイル', function () {
  var h = read('mens/membership/index.html');
  var top = read('mens/index.html');
  var webp = fs.readFileSync(path.join(ROOT, 'images/mens-preview-hero.webp'));
  assert.strictEqual(webp.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(webp.toString('ascii', 12, 16), 'VP8 ');
  assert.strictEqual(webp.readUInt16LE(26) & 0x3FFF, 1600);
  assert.strictEqual(webp.readUInt16LE(28) & 0x3FFF, 841);
  assert.ok(h.indexOf('<link rel="preload" as="image" href="../../images/mens-preview-hero.webp" fetchpriority="high">') !== -1);
  assert.ok(h.indexOf('src="../../images/mens-preview-hero.webp"\n        width="1600"\n        height="841"') !== -1);
  var topAlt = /alt="([^"]*Studio Nagoya Base mens[^"]*)"/.exec(top.slice(top.indexOf('mens-preview-hero.webp', top.indexOf('<picture'))));
  assert.ok(topAlt, 'トップのalt');
  assert.ok(h.indexOf('alt="' + topAlt[1] + '"') !== -1, 'altはトップと同じ画像説明');
  assert.match(h, /id="mens-membership-hero-title"/);
  assert.ok(h.indexOf('今すぐ使える特典は、') !== -1, 'ページ固有のH1を保持');
  assert.notStrictEqual('images/mens-preview-hero.webp', 'images/mens-preview-ogp-1200x630.jpg');
});

test('画像のない取引画面5ページへヒーロー・共有用メタ情報を新設しない', function () {
  NO_IMAGE_PAGES.forEach(function (f) {
    var h = read(f);
    assert.strictEqual(h.indexOf('og:image'), -1, f);
    assert.strictEqual(h.indexOf('twitter:image'), -1, f);
    assert.strictEqual(h.indexOf('mens-ogp-hero'), -1, f);
    assert.strictEqual(h.indexOf('mens-preview-hero'), -1, f);
  });
  ['payment-complete.html', 'option-payment-complete.html'].forEach(function (n) {
    assert.match(read('mens/booking/' + n), /noindex/, n + ' のnoindexを維持');
  });
});

test('共通includeの変更はクラス付与のみ（SNB一般の見た目は変わらない）', function () {
  var inc = read('_includes/checkin_checkout_common_ja.html');
  assert.strictEqual((inc.match(/class="cc-step-num" style="/g) || []).length, 3);
  ['styles/common.css', 'styles/booking.css', 'styles/mens.css'].forEach(function (f) {
    assert.strictEqual(read(f).indexOf('cc-step-num'), -1, f);
  });
});
