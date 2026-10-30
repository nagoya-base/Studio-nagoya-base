'use strict';
/*
 * Issue #665: 本番 mens トップの初期テーマを黒（kuro）にする。
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
  assert.match(src, /\{% include header_ja\.html [^%]*brand="mens"[^%]*theme="kuro"[^%]*%\}/);
});

test('静的: 試作 preview-633 と SNB トップは theme を指定せず、生成りのまま', function () {
  var pre = read('mens/preview-633.html');
  assert.match(pre, /<html lang="ja" data-theme="kinari">/);
  assert.doesNotMatch(pre.match(/\{% include header_ja\.html[^%]*%\}/)[0], /theme=/);
  assert.doesNotMatch(read('index.html').match(/\{% include header_ja\.html[^%]*%\}/)[0], /theme=/);
});

test('静的: header_ja は theme 未指定を生成りとし、JS に依存せず HTML で選択状態を出す', function () {
  var h = read('_includes/header_ja.html');
  assert.match(h, /assign nav_theme = include\.theme \| default: "kinari"/);
  assert.strictEqual((h.match(/class="theme-btn/g) || []).length, 4, 'PC 2 + モバイル 2');
  assert.strictEqual((h.match(/nav_theme == "kuro"/g) || []).length, 6);
});

test('ビルド: 本番 mens は初期 kuro。PC・モバイルとも 黒が active/aria-pressed=true、生成りは false', { skip: skipBuilt }, function () {
  var html = page('mens/index.html');
  assert.strictEqual(htmlTheme(html), 'kuro');
  var b = buttons(html);
  assert.strictEqual(b.length, 4);
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

test('ビルド: 本番 mens の金色予約バナー・詳細ページの白青方針は変わらない', { skip: skipBuilt }, function () {
  assert.ok(page('mens/index.html').indexOf('booking-fixed-banner') !== -1);
  ['mens/booking/index.html', 'mens/legal/index.html'].forEach(function (rel) {
    if (fs.existsSync(path.join(dest, rel))) assert.notStrictEqual(htmlTheme(page(rel)), 'kuro', rel);
  });
});

test('JS: main.js は既存のテーマ同期のみで、保存・自動判定を持たない', function () {
  var js = read('scripts/main.js');
  var seg = js.slice(js.indexOf('/* Theme switcher */'));
  seg = seg.slice(0, seg.indexOf('})();') + 5);
  assert.doesNotMatch(seg, /localStorage|sessionStorage|matchMedia|prefers-color-scheme/);
  assert.match(seg, /syncButtons\(document\.documentElement\.getAttribute\('data-theme'\)/);
});
