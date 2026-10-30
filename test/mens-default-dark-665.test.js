'use strict';
/*
 * Issue #665: 本番 mens トップの初期テーマを黒（kuro）にし、明るい切替先を生成りから白青（shiroao）へ変更する。
 * 初期の html data-theme とヘッダーの両テーマボタン（PC・モバイル）の active／aria-pressed が一致すること、
 * 試作・SNBトップなど他の呼出元は従来の生成りのままであることを検証する。
 * ビルド検査は Jekyll が使えない環境ではスキップする（静的な検査は常に実行）。
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snb-665-'));
var built = false;
var attempts = [['bundle', ['exec', 'jekyll', 'build', '--destination', dest]]];
try {
  var jp = cp.execFileSync('bundle', ['info', 'jekyll', '--path'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  attempts.push(['bundle', ['exec', 'ruby', path.join(jp, 'exe', 'jekyll'), 'build', '--destination', dest]]);
} catch (e) { /* bundle なし */ }
for (var i = 0; i < attempts.length && !built; i++) {
  try { cp.execFileSync(attempts[i][0], attempts[i][1], { cwd: ROOT, stdio: 'ignore' }); built = true; } catch (e) { /* 次へ */ }
}
var skipBuilt = built ? false : 'Jekyll が利用できないためスキップ';

function page(rel) { return fs.readFileSync(path.join(dest, rel), 'utf8'); }
function htmlTheme(html) { return (html.match(/<html[^>]*\sdata-theme="([^"]*)"/) || [])[1]; }
function buttons(html) {
  var out = [];
  var re = /<button class="theme-btn([^"]*)"[^>]*?data-theme="([^"]*)"[^>]*?aria-pressed="([^"]*)"/g, m;
  var flat = html.replace(/\s+/g, ' ');
  while ((m = re.exec(flat))) out.push({ active: /\bactive\b/.test(m[1]), theme: m[2], pressed: m[3] });
  return out;
}

test('静的: 本番 mens トップは html 初期値が kuro で、include に theme="kuro" を渡す', function () {
  var src = read('mens/index.html');
  assert.match(src, /<html lang="ja" data-theme="kuro">/);
  assert.match(src, /\{% include header_ja\.html [^%]*brand="mens"[^%]*theme="kuro"[^%]*light="shiroao"[^%]*%\}/);
  assert.match(src, /styles\/mens-top-theme-665\.css/, '本番トップ専用CSSを読み込む');
});

test('静的: 試作 preview-633 と SNB トップは theme/light を指定せず、生成りのまま', function () {
  var pre = read('mens/preview-633.html');
  assert.match(pre, /<html lang="ja" data-theme="kinari">/);
  assert.doesNotMatch(pre.match(/\{% include header_ja\.html[^%]*%\}/)[0], /theme=|light=/);
  assert.doesNotMatch(pre, /mens-top-theme-665/);
  assert.doesNotMatch(read('index.html').match(/\{% include header_ja\.html[^%]*%\}/)[0], /theme=|light=/);
});

test('静的: header_ja は theme 未指定を生成りとし、JS に依存せず HTML で選択状態を出す', function () {
  var h = read('_includes/header_ja.html');
  assert.match(h, /assign nav_light = include\.light \| default: "kinari"/);
  assert.match(h, /assign nav_theme = include\.theme \| default: nav_light/);
  assert.strictEqual((h.match(/class="theme-btn/g) || []).length, 4, 'PC 2 + モバイル 2');
  assert.strictEqual((h.match(/nav_theme == "kuro"/g) || []).length, 6);
});

test('ビルド: 本番 mens は初期 kuro。PC・モバイルとも 黒が active/aria-pressed=true、生成りは false', { skip: skipBuilt }, function () {
  var html = page('mens/index.html');
  assert.strictEqual(htmlTheme(html), 'kuro');
  var b = buttons(html);
  assert.strictEqual(b.length, 4);
  var flat = html.replace(/\s+/g, ' ');
  assert.strictEqual((flat.match(/data-theme="shiroao" aria-label="白青テーマ"/g) || []).length, 2, 'PC・モバイルの aria-label が白青');
  assert.strictEqual((flat.match(/🔷 白青<\/button>/g) || []).length, 2, '表示名が白青');
  assert.doesNotMatch(flat, /data-theme="kinari"|生成り/, '明るい側に生成りが残らない');
  assert.deepStrictEqual(b.map(function (x) { return x.theme; }), ['shiroao', 'kuro', 'shiroao', 'kuro']);
  b.forEach(function (x) {
    var on = x.theme === 'kuro';
    assert.strictEqual(x.active, on, x.theme + ' active');
    assert.strictEqual(x.pressed, String(on), x.theme + ' aria-pressed');
    assert.strictEqual(x.active, htmlTheme(html) === x.theme, '実テーマと一致');
  });
});

test('ビルド: 試作・SNBトップ・英語ページ・booking 等は従来どおり生成りが初期で、ボタン表示も一致', { skip: skipBuilt }, function () {
  ['mens/preview-633.html', 'index.html'].forEach(function (rel) {
    var html = page(rel);
    assert.strictEqual(htmlTheme(html), 'kinari', rel);
    var b = buttons(html);
    assert.strictEqual(b.length, 4, rel);
    b.forEach(function (x) {
      var on = x.theme === 'kinari';
      assert.strictEqual(x.active, on, rel + ' ' + x.theme);
      assert.strictEqual(x.pressed, String(on), rel + ' ' + x.theme);
    });
  });
});

test('静的: 白青の変数は #662 の .z-paper と一致し、共通 kinari / kuro の値は変えない', function () {
  var css = read('styles/mens-top-theme-665.css');
  var block = css.match(/html\[data-theme="shiroao"\] \{([^}]*)\}/)[1];
  function v(name) { return (block.match(new RegExp('--' + name + ':\\s*([^;]+);')) || [])[1]; }
  var expected = { bg: '#ffffff', 'bg-card': '#f4f6fa', 'bg-section': '#f1f4f9', text: '#172033', 'text-muted': '#46536a', accent: '#1d4f91', 'accent-dark': '#173f74', 'accent-rgb': '29, 79, 145', border: '#d3dbe7', 'on-accent': '#ffffff', 'banner-bg': '#172033', 'banner-text': '#ffffff' };
  Object.keys(expected).forEach(function (k) { assert.strictEqual(v(k), expected[k], '--' + k); });
  /* .z-paper（#662 と同じ白青）と変数値が一致する */
  var paper = read('styles/mens-preview-633.css').match(/\.z-paper \{([^}]*)\}/)[1];
  ['bg', 'bg-card', 'bg-section', 'text', 'text-muted', 'accent', 'accent-dark', 'accent-rgb', 'border', 'on-accent'].forEach(function (k) {
    assert.strictEqual(paper.match(new RegExp('--' + k + ':\\s*([^;]+);'))[1], v(k), '.z-paper --' + k);
  });
  /* 白系ナビ・ドロワー */
  assert.match(v('bg-nav'), /^rgba\(255, 255, 255,/);
  assert.match(v('bg-drawer'), /^rgba\(255, 255, 255,/);
  /* 共通テーマは変更しない */
  var common = read('styles/common.css');
  assert.doesNotMatch(common, /shiroao/);
  assert.match(common, /html\[data-theme="kinari"\] \{\s*--bg:\s*#f5f0e2;/);
  assert.match(common, /--banner-bg:\s*linear-gradient\(135deg, #c8a96e 0%, #a08050 100%\)/);
  /* 専用CSSは shiroao に限定し、詳細用CSSを丸ごと読み込まない */
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/html\[data-theme="shiroao"\][^{]*\{[^}]*\}/g, ''), /\S/, 'shiroao 以外のルールを持たない');
  assert.doesNotMatch(read('mens/index.html'), /mens-detail|booking-detail/);
});

test('ビルド: shiroao を使うのは本番 mens トップだけ', { skip: skipBuilt }, function () {
  var users = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      var q = path.join(dir, e.name);
      if (e.isDirectory()) return walk(q);
      if (/\.html$/.test(e.name) && /shiroao|mens-top-theme-665/.test(fs.readFileSync(q, 'utf8'))) users.push(path.relative(dest, q));
    });
  })(dest);
  assert.deepStrictEqual(users, ['mens/index.html']);
});

test('ビルド: 本番 mens の金色予約バナー・詳細ページの白青方針は変わらない', { skip: skipBuilt }, function () {
  assert.ok(page('mens/index.html').indexOf('booking-fixed-banner') !== -1);
  ['mens/booking/index.html', 'mens/legal/index.html'].forEach(function (rel) {
    if (fs.existsSync(path.join(dest, rel))) assert.notStrictEqual(htmlTheme(page(rel)), 'kuro', rel);
  });
});

test('JS: main.js は既存のテーマ同期のみで、保存・自動判定を持たない', function () {
  var js = read('scripts/main.js');
  assert.doesNotMatch(js, /shiroao/, 'main.js は変更しない');
  var seg = js.slice(js.indexOf('/* Theme switcher */'));
  seg = seg.slice(0, seg.indexOf('})();') + 5);
  assert.doesNotMatch(seg, /localStorage|sessionStorage|matchMedia|prefers-color-scheme/);
  assert.match(seg, /syncButtons\(document\.documentElement\.getAttribute\('data-theme'\)/);
});
