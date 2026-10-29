'use strict';
/*
 * Issue #633: mens/preview-633.html（/mens/ 再構成案の比較用試作）の検証。
 * 現行 mens/index.html と試作をローカルJekyllビルドし、表示テキスト・リンク・計測属性・画像・メタ情報・
 * 構造化データを機械的に照合する。試作固有の例外は ALLOWED_PREVIEW_ONLY_TEXT だけに明示する。
 * Jekyll が使えない環境では照合系テストをスキップする（静的な検査は常に実行）。
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* 試作固有の例外（フォーム付近の検証用注記）のみ許容する */
var ALLOWED_PREVIEW_ONLY_TEXT = ['【試作ページ】検証用のため、このフォームからは送信できません。'];

var built = null;
function tryBuild() {
  var dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snb-633-'));
  var attempts = [['bundle', ['exec', 'jekyll', 'build', '--destination', dest]]];
  try {
    var p = cp.execFileSync('bundle', ['info', 'jekyll', '--path'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    attempts.push(['bundle', ['exec', 'ruby', path.join(p, 'exe', 'jekyll'), 'build', '--destination', dest]]);
  } catch (e) { /* bundle なし */ }
  for (var i = 0; i < attempts.length; i++) {
    try {
      cp.execFileSync(attempts[i][0], attempts[i][1], { cwd: ROOT, stdio: 'ignore' });
      return { current: fs.readFileSync(path.join(dest, 'mens', 'index.html'), 'utf8'), preview: fs.readFileSync(path.join(dest, 'mens', 'preview-633.html'), 'utf8'), dest: dest };
    } catch (e) { /* 次へ */ }
  }
  return null;
}
built = tryBuild();
var skipBuilt = built ? false : 'Jekyll が利用できないためスキップ';

/* ---- ヘルパー ---- */
function norm(s) { return s.replace(/\s+/g, ' ').trim(); }
function bodyOf(html) {
  var m = html.match(/<body[\s\S]*<\/body>/);
  return m ? m[0] : html;
}
function visibleLeaves(html) {
  var s = bodyOf(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  return s.replace(/<[^>]+>/g, '\n').split('\n').map(norm).filter(Boolean);
}
function multiset(arr) {
  var m = {};
  arr.forEach(function (x) { m[x] = (m[x] || 0) + 1; });
  return m;
}
function diff(a, b) { /* a にあって b に足りない要素 */
  var ma = multiset(a), mb = multiset(b), out = [];
  Object.keys(ma).forEach(function (k) { if ((mb[k] || 0) < ma[k]) out.push(k); });
  return out;
}
function anchors(html) {
  var out = [];
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g, m;
  var body = bodyOf(html).replace(/<!--[\s\S]*?-->/g, '');
  while ((m = re.exec(body))) {
    var attrs = {};
    (m[1].match(/[\w:-]+="[^"]*"/g) || []).forEach(function (a) {
      var k = a.slice(0, a.indexOf('=')); attrs[k] = a.slice(a.indexOf('=') + 2, -1);
    });
    var keep = Object.keys(attrs).filter(function (k) { return k === 'href' || k === 'target' || k === 'rel' || k.indexOf('data-analytics-') === 0; }).sort();
    out.push(norm(m[2].replace(/<[^>]+>/g, ' ')) + ' | ' + keep.map(function (k) { return k + '=' + attrs[k]; }).join(' '));
  }
  return out;
}
function images(html) {
  var body = bodyOf(html).replace(/<!--[\s\S]*?-->/g, '');
  return (body.match(/<img\b[^>]*>/g) || []).map(function (t) {
    var g = function (k) { var r = t.match(new RegExp('\\b' + k + '="([^"]*)"')); return r ? r[1] : ''; };
    return g('src') + ' | ' + g('alt') + ' | ' + g('width') + 'x' + g('height');
  }).filter(function (x) { return x.indexOf('拡大画像') === -1; });
}
function metaContent(html, attr, key) {
  var r = html.match(new RegExp('<meta[^>]*' + attr + '="' + key + '"[^>]*content="([^"]*)"'));
  return r ? r[1] : null;
}
function jsonld(html) {
  return (html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || []);
}

/* ---- 静的検査（Jekyll不要） ---- */
test('#633: 試作の source は noindex・canonical は現行 /mens/・GA4/計測JS/送信JS を読み込まない', function () {
  var src = read('mens/preview-633.html');
  assert.match(src, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(src, /<link rel="canonical" href="https:\/\/nagoya-base\.github\.io\/Studio-nagoya-base\/mens\/">/);
  assert.doesNotMatch(src, /googletagmanager|gtag\(|analytics\.js|reservation-form\.js/);
  assert.doesNotMatch(src, /booking_app_/ , '試作に booking_app_* の include を追加しない');
  assert.match(src, /<script src="\.\.\/scripts\/main\.js"><\/script>/);
  ['imageModal', 'modalImage', 'floatingBookingBtn'].forEach(function (id) {
    assert.ok(src.indexOf('id="' + id + '"') !== -1, id + ' を維持する');
  });
});

test('#633: 相談フォームは試作側の <fieldset disabled> で include 全体を囲む（先頭legend内に操作要素なし）', function () {
  var src = read('mens/preview-633.html');
  var m = src.match(/<fieldset class="pv-form-lock" disabled>([\s\S]*?)<\/fieldset>\s*<\/div>/);
  assert.ok(m, 'disabled fieldset が見つからない');
  assert.match(m[1], /\{% include reservation_form_ja\.html %\}/);
  assert.doesNotMatch(m[1].split('{% include')[0], /<legend/, 'include 前に legend を置かない');
  assert.ok(src.indexOf('【試作ページ】検証用のため、このフォームからは送信できません。') !== -1);
});

test('#633: 初期化の途中で例外が起きても reveal-ready を外し、成功フラグを立てない（全情報が表示される）', function () {
  var vm = require('vm');
  function run(ioImpl) {
    var classes = { 'reveal-ready': true };
    var sandbox = {
      document: {
        documentElement: { classList: { contains: function (c) { return !!classes[c]; }, remove: function (c) { delete classes[c]; } } },
        querySelectorAll: function () { return [{}, {}]; }
      },
      IntersectionObserver: ioImpl
    };
    sandbox.window = sandbox;
    vm.runInNewContext(read('scripts/mens-preview-633.js'), sandbox);
    return { classes: classes, ready: sandbox.__pv633Ready };
  }
  var ctorThrows = run(function () { throw new Error('boom'); });
  assert.strictEqual(ctorThrows.classes['reveal-ready'], undefined);
  assert.ok(!ctorThrows.ready);
  var observeThrows = run(function () { this.observe = function () { throw new Error('boom'); }; });
  assert.strictEqual(observeThrows.classes['reveal-ready'], undefined);
  assert.ok(!observeThrows.ready);
  var ok = run(function () { this.observe = function () {}; this.unobserve = function () {}; });
  assert.strictEqual(ok.classes['reveal-ready'], true);
  assert.strictEqual(ok.ready, true);
});

test('#633: sitemap.xml・他ページから試作への参照がない', function () {
  assert.ok(read('sitemap.xml').indexOf('preview-633') === -1);
  var hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '_site') return;
      var p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.(html|xml|yml|json)$/.test(e.name)) return;
      if (p.endsWith(path.join('mens', 'preview-633.html'))) return;
      if (fs.readFileSync(p, 'utf8').indexOf('preview-633') !== -1) hits.push(path.relative(ROOT, p));
    });
  })(ROOT);
  assert.deepStrictEqual(hits, []);
});

/* ---- ビルド後の照合 ---- */
test('#633: ビルド後の試作に googletagmanager / gtag( / analytics.js / reservation-form.js が含まれない', { skip: skipBuilt }, function () {
  assert.doesNotMatch(built.preview, /googletagmanager|gtag\(|analytics\.js|reservation-form\.js/);
  assert.match(built.preview, /<fieldset class="pv-form-lock" disabled>/);
  assert.match(built.preview, /<meta name="robots" content="noindex, nofollow">/);
});

test('#633: 表示テキスト（文／項目）が現行と一致する（順序・空白・装飾差は正規化、例外は注記のみ）', { skip: skipBuilt }, function () {
  var cur = visibleLeaves(built.current);
  var pre = visibleLeaves(built.preview).filter(function (t) { return ALLOWED_PREVIEW_ONLY_TEXT.indexOf(t) === -1; });
  assert.deepStrictEqual(diff(cur, pre), [], '試作で欠落・変更された現行テキスト');
  assert.deepStrictEqual(diff(pre, cur), [], '試作で追加・変更されたテキスト');
  assert.ok(cur.length > 200, '照合対象が空洞化していないこと');
});

test('#633: リンク先・CTA文言・data-analytics-* の対応が現行と一致する', { skip: skipBuilt }, function () {
  var cur = anchors(built.current), pre = anchors(built.preview);
  assert.deepStrictEqual(diff(cur, pre), []);
  assert.deepStrictEqual(diff(pre, cur), []);
  assert.ok(cur.length > 40);
});

test('#633: 現行トップの写真（src/alt/寸法）をすべて維持している', { skip: skipBuilt }, function () {
  var cur = images(built.current), pre = images(built.preview);
  assert.deepStrictEqual(diff(cur, pre), []);
  assert.deepStrictEqual(diff(pre, cur), []);
});

test('#633: title・description・OGP・Twitter・canonical・JSON-LD を維持している', { skip: skipBuilt }, function () {
  var t = function (h) { return (h.match(/<title>([\s\S]*?)<\/title>/) || [])[1]; };
  assert.strictEqual(t(built.preview), t(built.current));
  ['description'].forEach(function (k) { assert.strictEqual(metaContent(built.preview, 'name', k), metaContent(built.current, 'name', k)); });
  ['og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'og:locale', 'og:site_name'].forEach(function (k) {
    assert.strictEqual(metaContent(built.preview, 'property', k), metaContent(built.current, 'property', k), k);
  });
  ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].forEach(function (k) {
    assert.strictEqual(metaContent(built.preview, 'name', k), metaContent(built.current, 'name', k), k);
  });
  var canon = function (h) { return (h.match(/<link rel="canonical" href="([^"]*)"/) || [])[1]; };
  assert.strictEqual(canon(built.preview), canon(built.current));
  assert.deepStrictEqual(jsonld(built.preview), jsonld(built.current));
});

test('#633: 現行トップにあるIDは試作にも存在し、試作内でIDが重複しない', { skip: skipBuilt }, function () {
  var ids = function (h) { return (bodyOf(h).match(/\bid="([^"]+)"/g) || []).map(function (x) { return x.slice(4, -1); }); };
  var cur = ids(built.current), pre = ids(built.preview);
  assert.deepStrictEqual(diff(cur, pre), [], '試作で消えたID（アンカー・参照元の退行）');
  assert.strictEqual(new Set(pre).size, pre.length, 'IDが重複している');
});
