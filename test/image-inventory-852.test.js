/*
 * 画像アセット棚卸し（Issue #852 Phase 1）。scripts/image-inventory-852.js の参照解決と、
 * docs/image-inventory-852.md が実在する画像をすべて追跡していることを検証する。
 * 画像の移動・削除（Phase 2）を行うときの、画像切れ・棚卸し漏れの検知も兼ねる。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var inventory = require('../scripts/image-inventory-852.js');

var ROOT = path.join(__dirname, '..');
var result = inventory.run();
var byPath = {};
result.images.forEach(function (i) { byPath[i.path] = i; });

test('images/ と studio-x/images/ の全画像について形式と寸法を読み取れる', function () {
  assert.ok(result.images.length > 0);
  result.images.forEach(function (i) {
    assert.ok(/^(png|jpeg|webp|svg)$/.test(i.format), i.path + ' の形式: ' + i.format);
    assert.ok(i.width > 0 && i.height > 0, i.path + ' の寸法');
    assert.ok(/^[0-9a-f]{40}$/.test(i.sha), i.path + ' の blob SHA');
  });
});

test('公開ページ（HTML / CSS）から参照される画像パスはすべて実在する（画像切れなし）', function () {
  var broken = result.unresolved.filter(function (u) { return /\.(html?|css)$/.test(u.file); });
  assert.deepStrictEqual(broken, []);
});

test('相対パス・絶対URL・Liquid変数・ファイル名のみの参照を正しい画像に解決する', function () {
  assert.deepStrictEqual(inventory.resolveToken('../../images/logo.svg', 'feedback/snb/index.html'), ['images/logo.svg']);
  assert.deepStrictEqual(inventory.resolveToken('images/sample_04_neon_1200.webp', 'studio-x/index.html'), ['studio-x/images/sample_04_neon_1200.webp']);
  assert.deepStrictEqual(inventory.resolveToken('https://nagoya-base.github.io/Studio-nagoya-base/images/ogp-survey-1200x630.jpg', 'survey/index.html'), ['images/ogp-survey-1200x630.jpg']);
  assert.deepStrictEqual(inventory.resolveToken('../images/a%20b.webp?v=2', 'mens/index.html'), ['images/a b.webp']);
  /* Markdown のリポジトリ基準パス（`images/x`）は docs/ 起点に解決しない */
  assert.deepStrictEqual(inventory.resolveToken('images/apple-touch-icon.png', 'docs/image-inventory-852.md'), ['images/apple-touch-icon.png']);
  assert.ok(!result.unresolved.some(function (u) { return u.reason === 'no-such-path' && /^docs\//.test(u.file); }), 'docs の実在パスが未解決にならない');
  assert.strictEqual(inventory.resolveToken('}}/equipment-mount-bracket.webp', '_includes/equipment_photo_cards.html'), null);
  assert.strictEqual(inventory.resolveToken('sample_04_neon_1200.webp', '_data/studio_x_worlds.yml'), null);
  /* include 経由・データ連結の参照も計上される */
  assert.ok(byPath['images/equipment/equipment-mount-bracket.webp'].refs.some(function (r) { return r.file === '_includes/equipment_photo_cards.html'; }));
  assert.ok(byPath['studio-x/images/studiox_ruins_1200.webp'].refs.some(function (r) { return r.file === '_data/studio_x_worlds.yml'; }));
  /* studio-x/images と images の同名取り違えをしない（Studio X ページの images/x は studio-x/images/x） */
  assert.ok(byPath['studio-x/images/studiox_white_1200.webp'].refs.some(function (r) { return r.file === 'studio-x/index.html'; }));
});

test('棚卸しレポートは実在する全画像を1行ずつ記載している', function () {
  var doc = fs.readFileSync(path.join(ROOT, 'docs', 'image-inventory-852.md'), 'utf8');
  result.images.forEach(function (i) {
    assert.ok(doc.indexOf('| `' + i.path + '` |') !== -1, i.path + ' が docs/image-inventory-852.md の一覧にない');
  });
});

test('一覧から消えた画像（削除・リネーム後）への参照は未解決として検出する', function () {
  var files = inventory.listTrackedFiles();
  var images = inventory.listImages(files).filter(function (i) { return i.path !== 'images/gallery_bondage01_1200.webp'; });
  var unresolved = inventory.scanReferences(images, files);
  assert.ok(unresolved.some(function (u) {
    return u.file === 'index.html' && /gallery_bondage01_1200\.webp$/.test(u.token);
  }), 'index.html の gallery_bondage01 参照が未解決になる');
});

test('blob SHA と bytes は HEAD ではなく作業ツリーの内容から計算する（未コミットの追加画像も扱える）', function () {
  var tmp = 'images/__inventory-test-852.png';
  fs.copyFileSync(path.join(ROOT, 'images/apple-touch-icon.png'), path.join(ROOT, tmp));
  try {
    var listed = inventory.listImages([tmp, 'images/apple-touch-icon.png']);
    assert.strictEqual(listed.length, 2);
    assert.strictEqual(listed[0].path, tmp);
    assert.strictEqual(listed[0].sha, byPath['images/apple-touch-icon.png'].sha);
    assert.strictEqual(listed[0].bytes, byPath['images/apple-touch-icon.png'].bytes);
  } finally {
    fs.unlinkSync(path.join(ROOT, tmp));
  }
});
