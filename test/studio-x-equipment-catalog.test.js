/*
 * Studio X機材・料金ページ(/studio-x/equipment/)と予約オプションの料金の同一正本（Issue #423 追加要件）。
 * 正本は _data/studio_x_equipment.json。機材ページはこれを直接読み、GAS(EquipmentCatalog.gs)は
 * scripts/sync-studio-x-equipment.js で生成する。二重管理にならないことと、SNB / mensの
 * 機材ページ・料金に手を入れていないことを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var sync = require('../scripts/sync-studio-x-equipment');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
}
var data = JSON.parse(read('_data/studio_x_equipment.json'));

test('EquipmentCatalog.gsは_data/studio_x_equipment.jsonから生成した内容と一致している（片方だけの編集を検出）', function () {
  assert.strictEqual(fs.readFileSync(sync.TARGET, 'utf8'), sync.render(),
    'node scripts/sync-studio-x-equipment.js を実行して EquipmentCatalog.gs を再生成してください');
});

test('正本の内容がIssueの確定料金・数量・常設無料設備と一致する', function () {
  var rental = {};
  data.rental.forEach(function (e) { rental[e.code] = e.stock + 'x' + e.unitPriceJpy + (e.unitLabel ? '/' + e.unitLabel : ''); });
  assert.deepStrictEqual(rental, {
    COB_BICOLOR: '1x800', PANEL_FULLCOLOR: '1x500', COB_FULLCOLOR: '2x800/台', STROBE_MONOBLOCK: '1x800', STROBE_PORTABLE: '1x800',
    COMMANDER_CANON: '1x300', COMMANDER_SONY: '1x300', STAND_260: '3x200/本', BOWENS_BRACKET: '1x200',
    SOFTBOX_STRIP_60X90: '1x300', SOFTBOX_STRIP_30X120: '1x300', SOFTBOX_60: '1x300', COLOR_FILTER_SET: '1x200'
  });
  assert.deepStrictEqual(data.permanent.map(function (e) { return e.label + '×' + e.quantity; }), [
    'バイカラーパネルライト（定常光）×2', 'ライトスタンド（100〜190cm）×2', '背景ローラーサポート×1',
    '背景紙 ブラック（135cm×5m）×1', '背景紙 ホワイト（135cm×5m）×1', 'レフ板 5-in-1（80cm）×1'
  ]);
  // 背景布・背景スタンドはセルフ利用が無料
  assert.deepStrictEqual(data.freeSelf.map(function (e) { return e.code; }), ['BACKGROUND_STAND', 'BACKDROP_CLOTH_WHITE', 'BACKDROP_CLOTH_BLACK']);
});

test('機材ページは正本(site.data)を直接読み、常設無料・有料レンタル・セルフ無料を分けて表示し、金額を直書きしない', function () {
  var html = read('studio-x/equipment/index.html');
  assert.ok(html.indexOf('site.data.studio_x_equipment.permanent') !== -1);
  assert.ok(html.indexOf('site.data.studio_x_equipment.rental') !== -1);
  assert.ok(html.indexOf('site.data.studio_x_equipment.freeSelf') !== -1);
  assert.match(html, /id="equipment-free"/);
  assert.match(html, /id="equipment-rental"/);
  assert.match(html, /id="equipment-self"/);
  assert.match(html, /1点ごとの個別加算/);
  assert.match(html, /過去にビデオライトをご利用いただいた方のみ/);
  var code = stripComments(html);
  assert.ok(!/\b(800|500|300|200)円/.test(code), '機材の単価をページへ直書きしない');
  assert.ok(!/3,?000円|5,?000円/.test(code), 'スタッフ対応料金も重複して書かない');
});

test('予約オプション側(画面・GAS)にも機材の単価・在庫を重複ハードコードしていない', function () {
  ['scripts/booking-options.js', 'scripts/booking-options-addon.js', 'gas/booking/shared/OptionOrderService.gs',
    'gas/booking/shared/OptionOrderRepository.gs', 'gas/booking/shared/OptionMailTemplates.gs', 'gas/booking/shared/BookingOptions.gs'
  ].forEach(function (rel) {
    /* 文字列長の切り詰め(slice(0, 500)等)は単価ではないので除外して数値リテラルを調べる */
    var code = stripComments(read(rel)).replace(/slice\(0,\s*\d+\)/g, '');
    assert.ok(!/\b(800|500|300)\b/.test(code), rel + ' に機材単価らしき数値がある');
  });
  // 機材コード別の単価(unitPriceJpy: 数値)を持つのは生成カタログだけ
  assert.ok(!/unitPriceJpy:\s*[1-9]/.test(read('gas/booking/shared/BookingOptions.gs')));
});

test('機材・料金ページへの導線: Studio Xトップ・ご利用ガイドの機材・予約フォームの機材オプション・後付け画面', function () {
  var label = '撮影機材・レンタル料金を見る';
  assert.ok(read('studio-x/index.html').indexOf(label) !== -1);
  assert.ok(read('studio-x/how-to/index.html').indexOf(label) !== -1);
  assert.ok(read('studio-x/booking/options/index.html').indexOf(label) !== -1);
  assert.ok(read('scripts/booking-options.js').indexOf(label) !== -1, '予約フォームの機材オプション付近');
  assert.ok(read('studio-x/index.html').indexOf('href="equipment/"') !== -1);
});

test('SNB / mensの機材ページ・共通機材表は変更していない（応相談表示のまま）', function () {
  var table = read('_includes/equipment_table.html');
  assert.ok(table.indexOf('保有機材（応相談）') !== -1);
  assert.ok(!/studio_x_equipment/.test(table));
  assert.ok(!/studio_x_equipment/.test(read('equipment/index.html')));
  assert.ok(!/studio_x_equipment/.test(read('mens/index.html')));
});
