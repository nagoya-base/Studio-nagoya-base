/*
 * Issue #463: Studio X予約画面の「おすすめ照明セット」3ステップUI。
 * - 8通りの組み合わせ → 機材・ライトスタンド数・ソフトボックスの初期選択
 * - ボーエンズマウントブラケットは「ポータブルストロボ AND ソフトボックス」のときだけ必須
 * - コマンダーは自動選択しない（ストロボ選択時のみ任意追加）
 * - 適用後の手動変更は戻さない／料金計算・在庫はカタログ（GAS）の値のまま
 * 最小DOMスタブで scripts/booking-options.js を実際にmountして操作する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function fakeNode(tag) {
  var node = {
    tag: tag, children: [], attrs: {}, hidden: false, className: '', _text: '', handlers: {},
    appendChild: function (child) { node.children.push(child); return child; },
    setAttribute: function (k, v) { node.attrs[k] = String(v); },
    addEventListener: function (type, fn) { (node.handlers[type] = node.handlers[type] || []).push(fn); },
    fire: function (type) { (node.handlers[type] || []).forEach(function (fn) { fn({}); }); },
    get textContent() { return node._text + node.children.map(function (c) { return c.textContent; }).join(''); },
    set textContent(v) { node._text = v; node.children = []; }
  };
  return node;
}
global.document = { createElement: fakeNode };
var Panel = require('../scripts/booking-options.js');

var gasSandbox = loadBookingSandbox(['EquipmentCatalog.gs', 'BookingOptions.gs'], {});
var CATALOG = JSON.parse(JSON.stringify(gasSandbox.BookingOptions.buildCatalog('studio_x', {})));

function all(node, pred, out) {
  out = out || [];
  if (pred(node)) out.push(node);
  node.children.forEach(function (c) { all(c, pred, out); });
  return out;
}
function mount() {
  var slot = fakeNode('div');
  return { panel: Panel.mount({ slot: slot, catalog: CATALOG }), slot: slot };
}
function pick(m, step, value) {
  var radio = all(m.slot, function (n) { return n.tag === 'input' && n.attrs.name === 'bo-lighting-' + step && n.attrs.value === value; })[0];
  assert.ok(radio, step + '=' + value + ' の選択肢がある');
  radio.checked = true;
  radio.fire('change');
}
function applyButton(m) {
  return all(m.slot, function (n) { return n.tag === 'button' && n.className.indexOf('ba-lighting-apply') !== -1; })[0];
}
function choose(m, kind, count, softbox) {
  pick(m, 'kind', kind); pick(m, 'count', count); pick(m, 'softbox', softbox);
  var button = applyButton(m);
  assert.ok(button, '3つ選ぶと「この構成を選択する」が出る');
  button.fire('click');
  return m.panel.getState().equipment;
}
function equipmentSelect(m, code) {
  var label = CATALOG.equipment.filter(function (e) { return e.code === code; })[0].label;
  return all(m.slot, function (n) { return n.tag === 'select' && n.attrs['aria-label'] === label + 'の数量'; })[0];
}

var EXPECTED = {
  'STROBE,1,OFF': { STROBE_PORTABLE: 1, STAND_260: 1 },
  'STROBE,2,OFF': { STROBE_PORTABLE: 1, STROBE_MONOBLOCK: 1, STAND_260: 2 },
  'VIDEO,1,OFF': { COB_BICOLOR: 1, STAND_260: 1 },
  'VIDEO,2,OFF': { COB_BICOLOR: 1, COB_FULLCOLOR: 1, STAND_260: 2 },
  'STROBE,1,ON': { STROBE_PORTABLE: 1, STAND_260: 1, SOFTBOX_60: 1, BOWENS_BRACKET: 1 },
  'STROBE,2,ON': { STROBE_PORTABLE: 1, STROBE_MONOBLOCK: 1, STAND_260: 2, SOFTBOX_60: 1, SOFTBOX_STRIP_60X90: 1, BOWENS_BRACKET: 1 },
  'VIDEO,1,ON': { COB_BICOLOR: 1, STAND_260: 1, SOFTBOX_60: 1 },
  'VIDEO,2,ON': { COB_BICOLOR: 1, COB_FULLCOLOR: 1, STAND_260: 2, SOFTBOX_60: 1, SOFTBOX_STRIP_60X90: 1 }
};

test('8通りの組み合わせから、Issueどおりの機材・ライトスタンド数・ソフトボックス・ブラケットが選択される', function () {
  Object.keys(EXPECTED).forEach(function (key) {
    var parts = key.split(',');
    var m = mount();
    assert.deepStrictEqual(choose(m, parts[0], parts[1], parts[2]), EXPECTED[key], key);
    assert.deepStrictEqual(Panel.lightingPresetItems({ kind: parts[0], count: parts[1], softbox: parts[2] }), EXPECTED[key], key + '（純粋関数）');
  });
});

test('ブラケット: ポータブルストロボ単体・モノブロック＋ソフトボックス・ビデオライト＋ソフトボックスでは必須にならない', function () {
  assert.strictEqual(Panel.requiredBracketQuantity({ STROBE_PORTABLE: 1 }), 0);
  assert.strictEqual(Panel.requiredBracketQuantity({ STROBE_MONOBLOCK: 1, SOFTBOX_60: 1 }), 0);
  assert.strictEqual(Panel.requiredBracketQuantity({ COB_BICOLOR: 1, SOFTBOX_60: 1 }), 0);
  assert.strictEqual(Panel.requiredBracketQuantity({ STROBE_PORTABLE: 1, SOFTBOX_STRIP_60X90: 1 }), 1);
  assert.strictEqual(Panel.requiredBracketQuantity({ STROBE_PORTABLE: 1, STROBE_MONOBLOCK: 1, SOFTBOX_60: 1 }), 1);
});

test('ブラケットが必須の構成では「借りない」を選べず、外そうとしても自動で戻す。不要な構成では外せる', function () {
  var m = mount();
  choose(m, 'STROBE', '1', 'ON');
  var select = equipmentSelect(m, 'BOWENS_BRACKET');
  assert.ok(select.children[0].disabled, '必須時は 0（借りない）が選べない');
  select.value = '0';
  select.fire('change');
  assert.strictEqual(m.panel.getState().equipment.BOWENS_BRACKET, 1, '外しても自動で戻る');
  assert.ok(/必要なため外せません/.test(m.slot.textContent));
  assert.ok(!/ボーエンズマウントブラケット/.test(m.panel.validate()), '必須ブラケットは満たされている');

  var free = mount();
  choose(free, 'STROBE', '1', 'OFF');
  assert.strictEqual(free.panel.getState().equipment.BOWENS_BRACKET, undefined, 'ポータブル単体では付かない');
  assert.ok(!equipmentSelect(free, 'BOWENS_BRACKET').children[0].disabled);
});

test('手動でポータブルストロボ＋ソフトボックスにするとブラケットが自動追加され、検証もブラケット不足を弾く', function () {
  var m = mount();
  var portable = equipmentSelect(m, 'STROBE_PORTABLE');
  portable.value = '1'; portable.fire('change');
  var softbox = equipmentSelect(m, 'SOFTBOX_60');
  softbox.value = '1'; softbox.fire('change');
  assert.strictEqual(m.panel.getState().equipment.BOWENS_BRACKET, 1);
  assert.ok(/自動で追加/.test(m.slot.textContent));
  var message = Panel.validateSelection({ equipment: { STROBE_PORTABLE: 1, SOFTBOX_60: 1 }, setupChosen: true, setupService: 'SELF', cleanupChosen: true, cleanupService: 'SELF' }, CATALOG);
  assert.ok(/ボーエンズマウントブラケット/.test(message));
});

test('コマンダーは自動選択されない。ストロボ選択時だけCanon/SONYを任意追加でき、ビデオライトでは出ない', function () {
  Object.keys(EXPECTED).forEach(function (key) {
    assert.strictEqual(EXPECTED[key].COMMANDER_CANON, undefined);
    assert.strictEqual(EXPECTED[key].COMMANDER_SONY, undefined);
  });
  var video = mount();
  pick(video, 'kind', 'VIDEO');
  assert.ok(!/ワイヤレスコマンダー/.test(video.slot.textContent.replace(/ワイヤレスコマンダー（(Canon|SONY)専用）/g, '')), 'ビデオライトでは案内を出さない');

  var m = mount();
  pick(m, 'kind', 'STROBE');
  assert.ok(/ワイヤレスコマンダーが必要な方は追加してください/.test(m.slot.textContent));
  var canon = all(m.slot, function (n) { return n.tag === 'input' && n.attrs.name === 'bo-commander' && n.attrs.value === 'COMMANDER_CANON'; })[0];
  var sony = all(m.slot, function (n) { return n.tag === 'input' && n.attrs.name === 'bo-commander' && n.attrs.value === 'COMMANDER_SONY'; })[0];
  assert.ok(canon && sony);
  assert.strictEqual(m.panel.getState().equipment.COMMANDER_CANON, undefined);
  canon.checked = true; canon.fire('change');
  assert.strictEqual(m.panel.getState().equipment.COMMANDER_CANON, 1);
});

test('適用後の手動変更は元に戻らない。再適用するとその時点のおすすめへ更新され、無関係な機材は保たれる', function () {
  var m = mount();
  var bg = equipmentSelect(m, 'BACKGROUND_STAND');
  bg.value = '1'; bg.fire('change');
  choose(m, 'VIDEO', '2', 'ON');
  var eq = m.panel.getState().equipment;
  assert.strictEqual(eq.BACKGROUND_STAND, 1, '背景スタンドは触らない');

  var stand = equipmentSelect(m, 'STAND_260');
  stand.value = '3'; stand.fire('change');
  var octa = equipmentSelect(m, 'SOFTBOX_60');
  octa.value = '0'; octa.fire('change');
  var edited = m.panel.getState().equipment;
  assert.strictEqual(edited.STAND_260, 3);
  assert.strictEqual(edited.SOFTBOX_60, undefined, 'オクタを外せる（別のソフトボックスへ変更可能）');
  assert.strictEqual(edited.COB_BICOLOR, 1);

  pick(m, 'count', '1');
  assert.strictEqual(m.panel.getState().equipment.STAND_260, 3, 'STEPを変えただけでは勝手に書き換わらない');
  applyButton(m).fire('click');
  assert.deepStrictEqual(m.panel.getState().equipment, { BACKGROUND_STAND: 1, COB_BICOLOR: 1, STAND_260: 1, SOFTBOX_60: 1 });
});

test('料金は既存計算のまま: ライトスタンドはセット無料、ブラケットはポータブルとセットで無料', function () {
  var eq = EXPECTED['STROBE,2,ON'];
  var total = Panel.equipmentTotalJpy(CATALOG, eq);
  var price = function (code) { return CATALOG.equipment.filter(function (e) { return e.code === code; })[0].unitPriceJpy; };
  assert.strictEqual(total, price('STROBE_PORTABLE') + price('STROBE_MONOBLOCK') + price('SOFTBOX_60') + price('SOFTBOX_STRIP_60X90'));
});

test('在庫不足・カタログ未掲載のときは部分適用せずnull', function () {
  var short = JSON.parse(JSON.stringify(CATALOG));
  short.equipment = short.equipment.filter(function (e) { return e.code !== 'SOFTBOX_STRIP_60X90'; });
  assert.strictEqual(Panel.applyLightingPreset(short, {}, { kind: 'VIDEO', count: '2', softbox: 'ON' }), null);
  assert.strictEqual(Panel.applyLightingPreset(CATALOG, {}, { kind: 'VIDEO', count: '2' }), null, '未選択ならnull');
});

test('3ステップの文言: 各選択肢に特徴、8通りすべてに専用の説明、組み合わせ名を表示する', function () {
  var steps = Panel.LIGHTING_STEPS;
  assert.deepStrictEqual(steps.map(function (s) { return s.options.length; }), [2, 2, 2]);
  steps.forEach(function (s) { s.options.forEach(function (o) { assert.ok(o.text.length > 10, o.label); }); });
  assert.ok(/見たままの明るさ/.test(steps[0].options[1].text) && /動画/.test(steps[0].options[1].text) && /スマホ/.test(steps[0].options[1].text));
  assert.strictEqual(Object.keys(Panel.LIGHTING_RESULT_TEXT).length, 8);
  assert.strictEqual(Panel.lightingResultTitle({ kind: 'VIDEO', count: '2', softbox: 'ON' }), 'ビデオライト × 2灯 × ソフトボックスあり');
  var m = mount();
  pick(m, 'kind', 'VIDEO'); pick(m, 'count', '2'); pick(m, 'softbox', 'ON');
  assert.ok(m.slot.textContent.indexOf(Panel.LIGHTING_RESULT_TEXT['VIDEO:2:ON']) !== -1);
  assert.ok(/選択されたセット/.test(m.slot.textContent));
  assert.ok(!/[A-H]パターン/.test(m.slot.textContent), '記号を利用者に見せない');
});

test('配線: 予約フォームはbooking-options.jsを読み込み、CSSに照明セットのスタイルがある（横スクロールしない設計）', function () {
  assert.ok(read('studio-x/booking/index.html').indexOf('booking-options.js') !== -1);
  var css = read('styles/booking.css');
  assert.ok(css.indexOf('.ba-lighting-options') !== -1);
  assert.ok(/ba-lighting-option \{[^}]*min-height: 56px/.test(css), 'タップしやすい高さ');
});
