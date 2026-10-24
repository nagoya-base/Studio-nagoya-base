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
    COB_BICOLOR: '1x800', PANEL_FULLCOLOR: '1x500', COB_FULLCOLOR: '2x800/台', BACKGROUND_STAND: '1x200', STROBE_MONOBLOCK: '1x800', STROBE_PORTABLE: '1x800',
    COMMANDER_CANON: '1x300', COMMANDER_SONY: '1x300', STAND_260: '3x200/本', BOWENS_BRACKET: '1x200',
    SOFTBOX_STRIP_60X90: '1x300', SOFTBOX_STRIP_30X120: '1x300', SOFTBOX_60: '1x300', COLOR_FILTER_SET: '1x200'
  });
  assert.deepStrictEqual(data.permanent.map(function (e) { return e.label + '×' + e.quantity; }), [
    'バイカラーパネルライト（定常光）×2', 'ライトスタンド（100〜190cm）×2', '背景ローラーサポート×1',
    '背景紙 ブラック（135cm×5m）×1', '背景紙 ホワイト（135cm×5m）×1', 'レフ板 5-in-1（80cm）×1'
  ]);
  // 背景布・背景スタンドはセルフ利用が無料
  assert.deepStrictEqual(data.freeSelf.map(function (e) { return e.code; }), ['BACKDROP_CLOTH_WHITE', 'BACKDROP_POLE', 'BACKDROP_CLOTH_BLACK']);
  assert.strictEqual(data.freeSelf.filter(function (e) { return e.code === 'BACKDROP_POLE'; })[0].selectable, false, '背景用竹竿は無料備品として正本に載せる（個別選択はさせない）');
  // 背景スタンドは無料ではなく200円の有料レンタル機材（Issue #430）。背景紙ロールは常設・無料
  assert.strictEqual(data.rental.filter(function (e) { return e.code === 'BACKGROUND_STAND'; })[0].unitPriceJpy, 200);
  assert.ok(data.permanent.some(function (e) { return /背景紙 ブラック/.test(e.label); }) && data.permanent.some(function (e) { return /背景紙 ホワイト/.test(e.label); }));
  // 有料レンタル機材は全件Admin許可制
  assert.ok(data.rental.every(function (e) { return e.requiresLecture === true; }));
});

test('スタッフ設営料金とテーマの正本（Issue #430）: 事前設営3,000円／片付け3,000円／両方5,000円、5テーマ共通', function () {
  var services = {};
  Object.keys(data.staffService.services).forEach(function (k) { services[k] = data.staffService.services[k].priceJpy; });
  assert.deepStrictEqual(services, { PRE_SETUP: 3000, CLEANUP: 3000, BOTH: 5000 });
  assert.deepStrictEqual(data.staffService.themes.map(function (t) { return t.code; }),
    ['CLASSROOM', 'JAPANESE', 'GRUNGE', 'WHITE_BACKDROP', 'BLACK_BACKDROP']);
  // GASの料金表はJSON(生成カタログ)からの参照で、数値を再定義しない
  var gas = stripComments(read('gas/booking/shared/BookingOptions.gs'));
  assert.ok(gas.indexOf('StudioXEquipmentCatalog.staffService') !== -1);
  assert.ok(!/PRE_SETUP:\s*\d/.test(gas) && !/BOTH:\s*\d/.test(gas), 'GASにスタッフ料金を直書きしない');
});

test('機材ページにスタッフ設営料金を正本から表示し、事前確認制・承認後決済とセルフ無料を明記する（Issue #430）', function () {
  var html = read('studio-x/equipment/index.html') + read('_includes/equipment_catalog_ja.html'); /* 共通include化（Issue #432） */
  assert.match(html, /id="staff-service"/);
  assert.ok(html.indexOf('site.data.studio_x_equipment.staffService') !== -1);
  assert.match(html, /セルフ設営<\/th><td>無料/);
  assert.match(html, /セルフ原状復帰<\/th><td>無料/);
  assert.match(html, /事前確認制/);
  assert.match(html, /承認/);
  assert.match(html, /オンラインで決済/);
});

test('Studio Xのメインナビ「設備・レンタル」は/studio-x/equipment/へ直接つながる（Issue #430）', function () {
  var top = read('studio-x/index.html');
  var nav = top.match(/<nav class="desktop-nav"[\s\S]*?<\/nav>/)[0];
  var mobile = top.match(/<div class="mobile-menu"[\s\S]*?<\/div>/)[0];
  [nav, mobile].forEach(function (block) {
    assert.match(block, /<a href="equipment\/">設備・レンタル<\/a>/);
    assert.ok(block.indexOf('#specs') === -1, '旧「設備」導線(#specs)を残さない');
  });
  assert.ok(top.indexOf('id="specs"') !== -1, '#specsセクション自体は残す');
  var page = read('studio-x/equipment/index.html');
  assert.ok(page.split('設備・レンタル</a>').length >= 3, '機材ページ自身のデスクトップ/モバイルナビも統一');
});

test('機材ページは正本(site.data)を直接読み、常設無料・有料レンタル・セルフ無料を分けて表示し、金額を直書きしない', function () {
  var html = read('studio-x/equipment/index.html') + read('_includes/equipment_catalog_ja.html'); /* 共通include化（Issue #432） */
  assert.ok(html.indexOf('site.data.studio_x_equipment.permanent') !== -1);
  assert.ok(html.indexOf('site.data.studio_x_equipment.rental') !== -1);
  assert.ok(html.indexOf('site.data.studio_x_equipment.freeSelf') !== -1);
  assert.match(html, /id="equipment-free"/);
  assert.match(html, /id="equipment-rental"/);
  assert.match(html, /id="equipment-self"/);
  assert.match(html, /1点ごとの個別加算/);
  assert.match(html, /施錠管理しているため、セルフでのご利用には管理者の利用許可（信用確認）が必要/);
  assert.ok(!/資格制限はありません|資格の制限はありません/.test(html), '資格制限なしの旧文言を残さない');
  assert.match(html, /背景紙ロール[^。]*無料/);
  assert.match(html, /背景用竹竿[^。]*無料/);
  assert.match(html, /背景スタンドは有料レンタル機材/);
  assert.ok(!/背景布・背景スタンドは/.test(html), '背景スタンドを無料扱いにしない');
  assert.ok(html.indexOf('過去にビデオライト') === -1);
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

test('SNB(/equipment/)とStudio X(/studio-x/equipment/)は同じ共通include・正本から機材内容を生成する（Issue #432）', function () {
  var snb = read('equipment/index.html');
  var sx = read('studio-x/equipment/index.html');
  [snb, sx].forEach(function (html) {
    assert.ok(/\{% include equipment_catalog_ja\.html[^%]*%\}/.test(html));
    assert.ok(html.indexOf('{% include equipment_photo_cards.html') !== -1);
    assert.ok(html.indexOf('{% include equipment_caution_ja.html %}') !== -1);
    assert.ok(!/\b(800|500|300|200)円/.test(stripComments(html)), '金額をページへ直書きしない');
  });
  var catalog = read('_includes/equipment_catalog_ja.html');
  ['permanent', 'rental', 'freeSelf', 'staffService'].forEach(function (k) {
    assert.ok(catalog.indexOf('site.data.studio_x_equipment.' + k) !== -1, k);
  });
  assert.match(catalog, /施錠管理しているため、セルフでのご利用には管理者の利用許可（信用確認）が必要/);
  assert.match(catalog, /セルフ設営<\/th><td>無料/);
  assert.match(catalog, /承認前に請求されることはありません/);
  // Studio X専用の予約オプション・承認・決済運用は brand="studio-x" のときだけ出す（SNBに同フローはない）
  assert.ok(sx.indexOf('equipment_catalog_ja.html brand="studio-x"') !== -1);
  assert.ok(snb.indexOf('brand=') === -1, 'SNBページはbrandを渡さない');
  var gated = catalog.replace(/\{%-? comment -%\}[\s\S]*?\{%-? endcomment -%\}/g, "").replace(/\{%-?\s*if is_studio_x\s*-?%\}[\s\S]*?\{%-?\s*(?:else|endif)\s*-?%\}/g, '');
  ['オプション追加', 'お支払いは部屋のご予約', 'オンラインで決済', '承認', 'id="staff-service"', 'staffService'].forEach(function (w) {
    assert.ok(gated.indexOf(w) === -1, 'Studio X専用文言「' + w + '」がブランド分岐の外にある');
  });
  assert.ok(!/保有機材（応相談）|保有・要相談/.test(snb + sx + catalog + read('_includes/equipment_photo_cards.html') + read('_includes/equipment_caution_ja.html')));
  // how-to / mens が使う従来の共通表は今回の対象外（変更しない）
  assert.ok(read('_includes/equipment_table.html').indexOf('保有機材（応相談）') !== -1);
  // 旧「応相談」表は価格を持たず、価格・最新条件の正本として /equipment/ へ誘導する（#433追加方針）
  var oldTable = read('_includes/equipment_table.html');
  assert.ok(oldTable.indexOf('equipment_url | default: \'../equipment/\'') !== -1);
  assert.match(oldTable, /が正本です/);
  assert.ok(!/\d+円/.test(stripComments(oldTable)), '旧表へ価格を重複掲載しない');
  assert.ok(read('mens/how-to/index.html').indexOf('equipment_url="../../equipment/"') !== -1);
});

test('写真カードの有料機材はレンタル価格を正本(unitPriceJpy)から表示し、金額を直書きしない（Issue #432）', function () {
  var cards = read('_includes/equipment_photo_cards.html');
  var code = stripComments(cards);
  assert.ok(!/\d+円/.test(code), '写真カードに金額を直書きしない');
  assert.ok(cards.indexOf('site.data.studio_x_equipment.rental') !== -1);
  assert.strictEqual(cards.split('常設・無料').length - 1, 2, '常設・無料のカードは維持');
  ['COB_BICOLOR', 'COB_FULLCOLOR', 'STROBE_MONOBLOCK', 'STROBE_PORTABLE', 'BOWENS_BRACKET', 'COMMANDER_CANON', 'COMMANDER_SONY'].forEach(function (c) {
    var def = data.rental.filter(function (e) { return e.code === c; })[0];
    assert.ok(def && def.unitPriceJpy > 0, c + ' は正本の有料機材');
    assert.ok(cards.indexOf('"code", "' + c + '"') !== -1, c + ' の価格を正本から引く');
    assert.ok(cards.indexOf('price_' + c + '.unitPriceJpy') !== -1, c);
  });
  assert.strictEqual(cards.split('レンタル {{').length - 1, 6);
});
