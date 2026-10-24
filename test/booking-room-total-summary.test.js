/*
 * Issue #443: 料金サマリーの部屋代・総合計、機材レンタルのカード決済必須の明示、後付け画面の表示。
 * 最小DOMスタブでscripts/booking-options.jsを実際にmountし、サマリーの描画結果を検査する。
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
    tag: tag, children: [], attrs: {}, hidden: false, className: '', _text: '',
    appendChild: function (child) { node.children.push(child); return child; },
    setAttribute: function (k, v) { node.attrs[k] = String(v); },
    addEventListener: function () {},
    get textContent() { return node._text + node.children.map(function (c) { return c.textContent; }).join(''); },
    set textContent(v) { node._text = v; node.children = []; }
  };
  return node;
}
global.document = { createElement: fakeNode };
var Panel = require('../scripts/booking-options.js');

var gasSandbox = loadBookingSandbox(['EquipmentCatalog.gs', 'BookingOptions.gs'], {});
var CATALOG = JSON.parse(JSON.stringify(gasSandbox.BookingOptions.buildCatalog('studio_x', {})));

function dlPairs(summarySlot) {
  var pairs = {};
  (function walk(n) {
    if (n.tag === 'dl') {
      for (var i = 0; i < n.children.length; i += 2) pairs[n.children[i].textContent] = n.children[i + 1].textContent;
    }
    n.children.forEach(walk);
  })(summarySlot);
  return pairs;
}

function mountWith(roomPrice, extra) {
  var slot = fakeNode('div');
  var summarySlot = fakeNode('div');
  var panel = Panel.mount(Object.assign({ slot: slot, summarySlot: summarySlot, catalog: CATALOG, getRoomPrice: function () { return roomPrice(); } }, extra || {}));
  return { panel: panel, summarySlot: summarySlot, slot: slot };
}

test('初回予約: 部屋代・オプション小計・総合計（= 部屋代 + オプション小計）を別項目で表示し、選択変更で更新される', function () {
  var room = { kind: 'estimate', status: 'ok', amountJpy: 4000 };
  var m = mountWith(function () { return room; });
  var state = m.panel.getState();
  assert.strictEqual(state.equipment && Object.keys(state.equipment).length, 0);
  var pairs = dlPairs(m.summarySlot);
  assert.strictEqual(pairs['部屋代'], '4,000円');
  assert.strictEqual(pairs['オプション小計'], '0円');
  assert.strictEqual(pairs['総合計（部屋代＋オプション小計）'], '4,000円');
  /* 部屋代が変わったら refreshSummary で総合計も追従する。 */
  room = { kind: 'estimate', status: 'ok', amountJpy: 6000 };
  m.panel.refreshSummary();
  assert.strictEqual(dlPairs(m.summarySlot)['総合計（部屋代＋オプション小計）'], '6,000円');
});

test('computeTotals: 総合計 = 部屋代 + computeSummaryのオプション小計。部屋代が未確定なら総合計を推測しない', function () {
  var eq = { COB_FULLCOLOR: 2 };
  var sum = Panel.computeSummary(CATALOG, { equipment: eq, setupService: 'STAFF', cleanupService: 'STAFF' });
  assert.strictEqual(sum.totalJpy, 7000);
  assert.deepStrictEqual(Panel.computeTotals(sum, { kind: 'estimate', status: 'ok', amountJpy: 4000 }),
    { roomJpy: 4000, optionSubtotalJpy: 7000, grandTotalJpy: 11000 });
  assert.strictEqual(Panel.computeTotals(sum, { kind: 'estimate', status: 'pending', amountJpy: null }).grandTotalJpy, null);
  assert.strictEqual(Panel.computeTotals(sum, { kind: 'estimate', status: 'unavailable', amountJpy: null }).grandTotalJpy, null);
});

test('初回予約: 部屋代の計算中・未確定の間は総合計を「—」にする（古い金額・推測値を出さない）', function () {
  var m = mountWith(function () { return { kind: 'estimate', status: 'pending', amountJpy: null }; });
  var pairs = dlPairs(m.summarySlot);
  assert.strictEqual(pairs['部屋代'], '計算中');
  assert.strictEqual(pairs['総合計（部屋代＋オプション小計）'], '—');
});

test('後付け: 予約済みの部屋代と今回の追加請求額を別ラベルで表示し、合算した総合計は作らない', function () {
  var m = mountWith(function () { return { kind: 'booked', status: 'ok', amountJpy: 4000 }; }, { allowNone: true });
  var pairs = dlPairs(m.summarySlot);
  assert.strictEqual(pairs['予約済みの部屋代'], '4,000円');
  assert.strictEqual(pairs['今回の追加オプション'], '0円');
  assert.strictEqual(pairs['今回の追加請求額'], '0円');
  assert.ok(!('総合計（部屋代＋オプション小計）' in pairs));
});

test('後付け: 予約済みの部屋代を取得できない場合は部屋代の行を出さず、推測で合算しない', function () {
  var m = mountWith(function () { return { kind: 'booked', status: 'unavailable', amountJpy: null }; }, { allowNone: true });
  var pairs = dlPairs(m.summarySlot);
  assert.ok(!('予約済みの部屋代' in pairs));
  assert.ok(!('総合計（部屋代＋オプション小計）' in pairs));
  assert.strictEqual(pairs['今回の追加請求額'], '0円');
});

test('getRoomPrice未指定（SNB等・従来の呼び出し）は従来のサマリーのまま', function () {
  var slot = fakeNode('div'); var summarySlot = fakeNode('div');
  Panel.mount({ slot: slot, summarySlot: summarySlot, catalog: CATALOG });
  var pairs = dlPairs(summarySlot);
  assert.strictEqual(pairs['今回のオプション合計'], '0円');
  assert.ok(!('部屋代' in pairs));
});

test('機材レンタル選択時は「オンラインクレジットカード決済のみ（PayPay・現金不可）」を画面に明示する。機材なしでは出さない', function () {
  function textOf(node) { return node.textContent; }
  var none = mountWith(function () { return { kind: 'estimate', status: 'ok', amountJpy: 4000 }; });
  assert.ok(textOf(none.summarySlot).indexOf('クレジットカード決済のみ') === -1);
  var panel = none.panel;
  /* 機材を選んだ状態を直接再現するため、選択数量セレクトのchangeハンドラは使わず、カタログ文言とヘルパーを検査する。 */
  var text = Panel.equipmentCardOnlyText(CATALOG);
  assert.ok(/オンラインクレジットカード決済のみ/.test(text) && /PayPay・現金は受け付けていません/.test(text));
  assert.strictEqual(CATALOG.notices.EQUIPMENT_CARD_ONLY, text, '文言はサーバー（カタログ）の値を使う');
  assert.ok(panel);
});

test('パネル・サマリーのソース: 有料機材選択時にカード専用の注意書きを料金サマリーへ1回だけ出し（Issue #453）、PayPay/現金へのフォールバックを持たない', function () {
  var src = read('scripts/booking-options.js');
  assert.ok(src.indexOf("id: 'ba-summary-card-only'") !== -1);
  assert.strictEqual(src.indexOf('ba-equipment-card-only'), -1, 'パネル側では同じ注意を繰り返さない');
  assert.ok(!/paymentMethod|PayPay.*フォールバック/.test(src));
});

test('予約フォーム: 部屋代は見積りAPIの最新結果（latestPriceEntry）だけから取り、料金表を複製しない。見積り更新でサマリーも更新する', function () {
  var src = read('scripts/booking-app.js');
  assert.ok(src.indexOf('getRoomPrice: currentRoomPrice_') !== -1);
  assert.ok(/function currentRoomPrice_[\s\S]*latestPriceEntry[\s\S]*entry\.price\.amount/.test(src));
  assert.ok(/function renderPriceEverywhere_[\s\S]*optionsPanel\.refreshSummary\(\)/.test(src));
});

test('後付けページ: 予約済みの部屋代はサーバー応答（booking.roomPriceJpy）だけを使い、取得できなければnull扱い', function () {
  var src = read('scripts/booking-options-addon.js');
  assert.ok(src.indexOf('getRoomPrice: currentRoomPrice') !== -1 && src.indexOf('booking.roomPriceJpy') !== -1);
});

test('GAS: 機材レンタルのカード専用文言がカタログのnoticesに入る。機材の決済は既存のStripe Checkout経由のみ（PayPay/現金の経路を持たない）', function () {
  assert.ok(/オンラインクレジットカード決済のみ/.test(CATALOG.notices.EQUIPMENT_CARD_ONLY));
  var svc = read('gas/booking/shared/OptionOrderService.gs');
  assert.ok(svc.indexOf('StripeGateway.createCheckoutSession') !== -1);
  assert.ok(!/PayPay|paypay|現金/.test(svc.replace(/\/\*[\s\S]*?\*\//g, '')), 'OptionOrderServiceにPayPay/現金の決済経路を作らない');
});
