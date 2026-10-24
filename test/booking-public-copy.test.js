/*
 * Issue #465: 予約機能のフロント／バックエンド責務分離と、内部運用語の公開UI露出防止。
 *
 * - バックエンド（GAS）の公開カタログは意味（enum・フラグ）だけを返し、日本語の文章（notices）を返さない。
 * - 利用者向け日本語はフロント（scripts/booking-options.js）が持つ。バックエンドの文章を混ぜても表示されない。
 * - 公開予約画面（/studio-x/booking/ 配下）のレンダリング結果・静的HTML・フロントの文言に、
 *   Admin / 管理者 / 承認 / 利用許可 / PENDING_APPROVAL 等の内部用語が0件であること。
 *
 * 内部実装（GAS内部の状態名・コメント・管理画面・メール）の用語は対象外（公開UIのみ検査する）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* 公開UIに出してはいけない内部用語。 */
var FORBIDDEN = [
  /Admin/i, /管理者/, /承認/, /利用許可/,
  /PENDING_APPROVAL/, /AWAITING_PAYMENT/, /PAYMENT_PENDING/, /APPROVAL_/, /DECLINED/, /不承認/
];

function forbiddenHits(text) {
  return FORBIDDEN.filter(function (re) { return re.test(text); }).map(String);
}

function assertClean(text, label) {
  assert.deepStrictEqual(forbiddenHits(text), [], label + ' に内部用語が含まれる: ' + text);
}

/* ---- 最小のフェイクDOM（レンダリング結果の文字列を集めるため。依存パッケージなし） ---- */

function FakeNode(tag) {
  this.tagName = String(tag).toUpperCase();
  this.attrs = {};
  this.children = [];
  this.listeners = {};
  this._text = '';
  this.value = '';
  this.checked = false;
  this.disabled = false;
  this.hidden = false;
  this.className = '';
}
FakeNode.prototype.appendChild = function (child) { this.children.push(child); return child; };
FakeNode.prototype.setAttribute = function (key, value) {
  this.attrs[key] = String(value);
  if (key === 'value') this.value = String(value);
};
FakeNode.prototype.addEventListener = function (type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); };
FakeNode.prototype.dispatch = function (type) { (this.listeners[type] || []).forEach(function (fn) { fn({ target: this }); }, this); };
Object.defineProperty(FakeNode.prototype, 'textContent', {
  get: function () { return this._text + this.children.map(function (c) { return c.textContent; }).join(''); },
  set: function (value) { this._text = String(value); this.children = []; }
});
FakeNode.prototype.walk = function (fn) { fn(this); this.children.forEach(function (c) { c.walk(fn); }); };
/* 画面に見える文字列＋支援技術向けの属性値。 */
FakeNode.prototype.visibleStrings = function () {
  var out = [];
  this.walk(function (n) {
    if (n._text) out.push(n._text);
    ['aria-label', 'title', 'alt', 'placeholder'].forEach(function (k) { if (n.attrs[k]) out.push(n.attrs[k]); });
  });
  return out.join('\n');
};
FakeNode.prototype.find = function (pred) {
  var found = [];
  this.walk(function (n) { if (pred(n)) found.push(n); });
  return found;
};

global.document = { createElement: function (tag) { return new FakeNode(tag); } };
var Panel = require('../scripts/booking-options.js');

/* ---- 実際のGASが返す公開カタログを使う ---- */

var sandbox = loadBookingSandbox(['EquipmentCatalog.gs', 'BookingOptions.gs'], {});
var BookingOptions = sandbox.BookingOptions;
var CATALOG = JSON.parse(JSON.stringify(BookingOptions.buildCatalog('studio_x', { addonDeadlineHoursBeforeStart: '' })));

test('バックエンド: 公開カタログは構造化されたpolicyを返し、日本語の文章（notices）を返さない', function () {
  assert.strictEqual(CATALOG.notices, undefined, 'カタログにnoticesを載せない');
  assert.deepStrictEqual(CATALOG.policy, {
    equipmentPaymentMethod: 'CARD_ONLY',
    equipmentPaymentTiming: 'AFTER_ROOM_CONFIRMED',
    roomAndOptionsPayment: 'SEPARATE',
    staffServicePaymentTiming: 'AFTER_AVAILABILITY_CONFIRMED',
    staffServiceConfirmedOnApply: false,
    equipmentRequiresPrecheck: true,
    equipmentSetupChoiceRequired: true,
    selfServiceFree: true
  });
  /* policyの値はenum・真偽値のみ（文章を持たない） */
  Object.keys(CATALOG.policy).forEach(function (key) {
    var v = CATALOG.policy[key];
    assert.ok(typeof v === 'boolean' || /^[A-Z_]+$/.test(v), key + ' は文章でなくenum/フラグ');
  });
  /* 内部用語は、policyにも載せない */
  assertClean(JSON.stringify(CATALOG.policy), 'catalog.policy');
});

test('バックエンド: 決済条件の中身は維持（機材はカード決済のみ・部屋の予約確定後・部屋代とは別決済・スタッフ対応は確認後）', function () {
  var p = CATALOG.policy;
  assert.strictEqual(p.equipmentPaymentMethod, 'CARD_ONLY');
  assert.strictEqual(p.equipmentPaymentTiming, 'AFTER_ROOM_CONFIRMED');
  assert.strictEqual(p.roomAndOptionsPayment, 'SEPARATE');
  assert.strictEqual(p.staffServicePaymentTiming, 'AFTER_AVAILABILITY_CONFIRMED');
  assert.strictEqual(p.equipmentRequiresPrecheck, true);
  /* スタッフ対応は必ず承認待ちから始まる（内部の承認フローは維持） */
  assert.strictEqual(BookingOptions.STATUS.PENDING_APPROVAL, 'PENDING_APPROVAL');
});

test('フロント: policyからコピーを組み立てる。カード決済のみ・別決済・予約確定後の支払い・事前確認の条件を維持する', function () {
  var c = Panel.copyFor(CATALOG);
  assert.ok(/オンラインクレジットカード決済のみ/.test(c.cardOnly) && /PayPay・現金は受け付けていません/.test(c.cardOnly));
  assert.ok(/部屋予約の確定後にカード決済/.test(c.equipmentPayment));
  assert.ok(/部屋代とオプションは別決済/.test(c.paymentSplit));
  assert.ok(/利用条件の確認後/.test(c.permission) && /初めての方は事前にご相談/.test(c.permission));
  assert.ok(/日程確認後にご利用可能な場合のみ/.test(c.paymentTiming) && /部屋の予約確定後/.test(c.paymentTiming));
  assert.ok(/申込時点ではスタッフ対応は確定していません/.test(c.staffNotice));
});

test('フロント: policyが変われば表示も変わる（バックエンドの意味→フロントの文言）。条件が無ければ文を出さない', function () {
  var changed = JSON.parse(JSON.stringify(CATALOG));
  changed.policy.equipmentPaymentMethod = 'NONE';
  changed.policy.roomAndOptionsPayment = 'COMBINED';
  changed.policy.equipmentRequiresPrecheck = false;
  var c = Panel.copyFor(changed);
  assert.strictEqual(c.cardOnly, '');
  assert.strictEqual(c.paymentSplit, '');
  assert.strictEqual(c.permission, '');
});

test('フロント: policyが無い古いカタログでも現行の運用条件で表示する', function () {
  var legacy = JSON.parse(JSON.stringify(CATALOG));
  delete legacy.policy;
  assert.deepStrictEqual(Panel.copyFor(legacy), Panel.copyFor(CATALOG));
});

/* ---- レンダリング結果の検査 ---- */

function mountPanel(extra) {
  var slot = new FakeNode('div');
  var summarySlot = new FakeNode('div');
  /* 敵対的なカタログ: バックエンドが（旧実装のように）内部用語入りの文章を返しても画面に出さない */
  var catalog = JSON.parse(JSON.stringify(CATALOG));
  catalog.notices = {
    STAFF_SERVICE_APPROVAL: 'Adminの承認後にお支払いください',
    SELF_VS_STAFF: '管理者の利用許可が必要です',
    EQUIPMENT_CARD_ONLY: 'PENDING_APPROVAL'
  };
  var config = Object.assign({ slot: slot, summarySlot: summarySlot, catalog: catalog, allowNone: false }, extra || {});
  var controller = Panel.mount(config);
  return { controller: controller, slot: slot, summarySlot: summarySlot, catalog: catalog };
}

function renderedText(m) {
  return m.slot.visibleStrings() + '\n' + m.summarySlot.visibleStrings();
}

function fire(m, pred, mutate) {
  var nodes = m.slot.find(pred);
  assert.ok(nodes.length > 0, '対象の操作要素が見つかる');
  mutate(nodes[0]);
  nodes[0].dispatch('change');
}

test('公開予約画面（オプション欄＋料金サマリー）: 初期表示に内部用語が0件。バックエンドの文章は表示されない', function () {
  var m = mountPanel({ getRoomPrice: function () { return { kind: 'estimate', status: 'ok', amountJpy: 8000 }; } });
  var text = renderedText(m);
  assert.ok(text.length > 100, '描画されている');
  assertClean(text, '初期表示');
  assert.ok(text.indexOf('Adminの承認後') === -1 && text.indexOf('PENDING_APPROVAL') === -1, 'catalog.noticesは使われない');
});

test('公開予約画面: 有料機材・スタッフ設営/片付け・全テーマを選んだ状態でも内部用語が0件。必要な条件は表示される', function () {
  var m = mountPanel({ getRoomPrice: function () { return { kind: 'estimate', status: 'ok', amountJpy: 8000 }; } });
  CATALOG.equipment.filter(function (e) { return e.unitPriceJpy > 0; }).forEach(function (e) {
    fire(m, function (n) { return n.tagName === 'SELECT' && (n.attrs['aria-label'] || '').indexOf(e.label) === 0; },
      function (n) { n.value = '1'; });
  });
  CATALOG.themes.forEach(function (t) {
    fire(m, function (n) { return n.attrs.name === 'bo-layout' && n.value === t.code; }, function (n) { n.checked = true; });
  });
  fire(m, function (n) { return n.attrs.name === 'bo-setup' && n.value === 'STAFF'; }, function (n) { n.checked = true; });
  fire(m, function (n) { return n.attrs.name === 'bo-cleanup' && n.value === 'STAFF'; }, function (n) { n.checked = true; });
  var text = renderedText(m);
  assertClean(text, '有料機材＋スタッフ対応選択時');
  /* 条件自体は維持されている */
  assert.ok(/オンラインクレジットカード決済のみ/.test(text), 'カード決済のみ');
  assert.ok(/部屋代とオプションは別決済/.test(text), '別決済');
  assert.ok(/部屋予約の確定後にカード決済/.test(text), '機材は部屋の予約確定後');
  assert.ok(/利用条件の確認/.test(text), '機材の利用条件確認');
  assert.ok(/日程確認後にご利用可能な場合のみ/.test(text), 'スタッフ対応の確認後支払い');
  assert.ok(/事前確認制/.test(text));
});

test('公開予約画面（後付けページ相当: 申込済み注文あり・予約済み部屋代）でも内部用語が0件', function () {
  var orders = [
    { optionOrderId: 'OPT-1', category: 'STAFF_SERVICE', status: 'PENDING_APPROVAL', approvalStatus: 'PENDING_APPROVAL', requiresApproval: true, items: [{ code: 'STAFF_SETUP:GRUNGE', label: 'スタッフ設営' }], amountJpy: 3000 }
  ];
  var m = mountPanel({ allowNone: true, existingOrders: orders, getRoomPrice: function () { return { kind: 'booked', status: 'ok', amountJpy: 8000 }; } });
  fire(m, function (n) { return n.attrs.name === 'bo-layout' && n.value === 'GRUNGE'; }, function (n) { n.checked = true; });
  fire(m, function (n) { return n.attrs.name === 'bo-cleanup' && n.value === 'STAFF'; }, function (n) { n.checked = true; });
  assertClean(renderedText(m), '後付け表示');
});

test('注文の状態表示・エラー表示: 内部の状態名／サーバー文言を出さず、利用者の行動に言い換える', function () {
  var statuses = ['PENDING_APPROVAL', 'AWAITING_PAYMENT', 'PAYMENT_PENDING', 'CONFIRMED', 'DECLINED', 'CANCELLED', 'UNKNOWN_FUTURE_STATUS'];
  statuses.forEach(function (status) {
    [true, false].forEach(function (requiresApproval) {
      [0, 3000].forEach(function (amountJpy) {
        assertClean(Panel.describeOrderStatus({ status: status, requiresApproval: requiresApproval, amountJpy: amountJpy }), '注文状態 ' + status);
      });
    });
  });
  assert.ok(/まだ確定していません/.test(Panel.describeOrderStatus({ status: 'PENDING_APPROVAL' })), '確認中の注文は未確定・支払い不要を伝える');
  assert.ok(/お支払いをお願いします/.test(Panel.describeOrderStatus({ status: 'AWAITING_PAYMENT', requiresApproval: true })));

  /* サーバーのerror.messageは使わず、codeからフロントの文言を引く */
  var leaked = '管理者の利用許可を得た方のみ。Adminが承認します。PENDING_APPROVAL';
  assert.strictEqual(Panel.describeError({ code: 'VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE', message: leaked }), Panel.ERROR_COPY.VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE);
  assert.ok(Panel.describeError({ code: 'SOMETHING_NEW', message: leaked }).indexOf('Admin') === -1, '未知のcodeはサーバー文言でなく汎用文');
  assert.ok(Panel.describeError({ message: leaked }).indexOf('時間を置いて') !== -1);
  Object.keys(Panel.ERROR_COPY).forEach(function (code) { assertClean(Panel.ERROR_COPY[code], 'ERROR_COPY.' + code); });
  assertClean(Panel.describeError(null), '汎用エラー');
});

test('GASが公開APIで返しうるオプション関連のerror.codeは、すべてフロントの文言表にある', function () {
  var codes = {};
  ['gas/booking/shared/BookingOptions.gs', 'gas/booking/shared/OptionOrderService.gs'].forEach(function (rel) {
    var src = read(rel);
    var re = /(?:err_|fail_)\(\s*'([A-Z_]+)'/g;
    var mm;
    while ((mm = re.exec(src))) codes[mm[1]] = true;
  });
  /* 管理画面専用のコード（利用者には返らない）、および内部エラー */
  var adminOnly = ['APPROVAL_NOT_REQUIRED', 'INVALID_TRANSITION', 'INVALID_EQUIPMENT', 'INTERNAL_ERROR', 'CHECKOUT_NOT_CONFIGURED_ADMIN'];
  var missing = Object.keys(codes).filter(function (c) { return adminOnly.indexOf(c) === -1 && !Object.prototype.hasOwnProperty.call(Panel.ERROR_COPY, c); });
  assert.deepStrictEqual(missing, [], 'フロントに文言が無いcode: ' + missing.join(','));
});

/* ---- 静的HTML・フロントの文言リテラル ---- */

function publicHtmlFiles() {
  var out = [];
  (function walk(dir) {
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).forEach(function (ent) {
      var rel = dir + '/' + ent.name;
      if (ent.isDirectory()) walk(rel);
      else if (/\.html$/.test(ent.name)) out.push(rel);
    });
  })('studio-x/booking');
  return out;
}

/* ページに表示される文字列＋検索結果に出るmeta/title。script/style/HTMLコメントは見えないので除外する。 */
function visibleHtmlText(html) {
  var metas = [];
  html.replace(/<meta[^>]+(?:name|property)="(?:description|og:[a-z:]+|twitter:[a-z:]+)"[^>]*content="([^"]*)"/g, function (_, c) { metas.push(c); return ''; });
  var body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ');
  return body + '\n' + metas.join('\n');
}

test('公開HTML（/studio-x/booking/ 配下の全ページ）の表示テキストに内部用語が0件', function () {
  var files = publicHtmlFiles();
  assert.ok(files.length >= 4, '予約・オプション・決済完了ページを検査している');
  files.forEach(function (rel) {
    assertClean(visibleHtmlText(read(rel)), rel);
  });
});

/* コメントを除いた文字列リテラル（利用者に表示しうる日本語・用語）を取り出す。 */
function stringLiterals(src) {
  var noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
  var out = [];
  var re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  var mm;
  while ((mm = re.exec(noComments))) out.push(mm[1] !== undefined ? mm[1] : mm[2]);
  return out;
}

test('公開フロントJSの文言リテラルに内部用語が0件（状態名との比較・送信値のコード文字列のみ許可）', function () {
  /* 比較・マップのキーとして使う内部コード（画面に表示されない）。 */
  var codeOnly = /^(PENDING_APPROVAL|AWAITING_PAYMENT|PAYMENT_PENDING|DECLINED)$/;
  ['scripts/booking-options.js', 'scripts/booking-options-addon.js', 'scripts/booking-app.js'].forEach(function (rel) {
    stringLiterals(read(rel)).forEach(function (literal) {
      if (codeOnly.test(literal)) return;
      assertClean(literal, rel + ' の文言');
    });
  });
});

test('フロントの文言（COPY/TEXT/CONSULT_TEXT/照明おすすめ）に内部用語が0件', function () {
  var all = [];
  Object.keys(Panel.TEXT).forEach(function (k) { all.push(Panel.TEXT[k]); });
  Object.keys(Panel.CONSULT_TEXT).forEach(function (k) { all.push(Panel.CONSULT_TEXT[k]); });
  Object.keys(Panel.LIGHTING_RESULT_TEXT).forEach(function (k) { all.push(Panel.LIGHTING_RESULT_TEXT[k]); });
  Object.keys(Panel.copyFor(CATALOG)).forEach(function (k) { all.push(Panel.copyFor(CATALOG)[k]); });
  all.concat(Panel.summarize(CATALOG, { equipment: { COB_BICOLOR: 1 }, layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'STAFF', emailSupport: true })).forEach(function (t) {
    assertClean(String(t), '文言');
  });
});

test('フロントがバックエンドの文章（notices / error.message）をそのまま表示する記述が残っていない', function () {
  var src = ['scripts/booking-options.js', 'scripts/booking-options-addon.js', 'scripts/booking-app.js'].map(read).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.notices\b/.test(src), 'catalog.noticesを参照しない');
  assert.ok(!/error\.message|\.error\.message/.test(src), 'error.messageを表示しない');
});

/* ---- 「必須」「無料」の表示もpolicyから導出する（equipmentSetupChoiceRequired / selfServiceFree） ---- */

function renderWithPolicy(overrides) {
  var catalog = JSON.parse(JSON.stringify(CATALOG));
  Object.keys(overrides).forEach(function (k) { catalog.policy[k] = overrides[k]; });
  var m = mountPanel({ catalog: catalog, getRoomPrice: function () { return { kind: 'estimate', status: 'ok', amountJpy: 8000 }; } });
  /* mountPanel は config.catalog を上書きしてしまうため、改めて差し替える */
  m.controller.setCatalog(Object.assign(catalog, { notices: undefined }));
  var paid = catalog.equipment.filter(function (e) { return e.unitPriceJpy > 0; })[0];
  fire(m, function (n) { return n.tagName === 'SELECT' && (n.attrs['aria-label'] || '').indexOf(paid.label) === 0; }, function (n) { n.value = '1'; });
  fire(m, function (n) { return n.attrs.name === 'bo-layout' && n.value === 'GRUNGE'; }, function (n) { n.checked = true; });
  return { m: m, catalog: catalog, text: renderedText(m) };
}

test('policy: 設営方法の「必須」とセルフの「無料」表示は、バックエンドの条件（フラグ）に従う', function () {
  var on = renderWithPolicy({});
  assert.ok(on.text.indexOf('設営方法（機材レンタル時は必須）') !== -1 && on.text.indexOf('片付け方法（機材レンタル時は必須）') !== -1);
  assert.ok(on.text.indexOf('セルフ設営　無料') !== -1 && on.text.indexOf('自分で原状復帰　無料') !== -1);
  assert.ok(Panel.summarize(on.catalog, { equipment: { COB_BICOLOR: 1 }, setupService: 'SELF', cleanupService: 'SELF' }).join('\n').indexOf('セルフ設営（無料）') !== -1);

  var off = renderWithPolicy({ equipmentSetupChoiceRequired: false, selfServiceFree: false });
  ['機材レンタル時は必須', 'セルフ設営　無料', '自分で原状復帰　無料'].forEach(function (t) {
    assert.strictEqual(off.text.indexOf(t), -1, 'policy=false のとき「' + t + '」が残らない');
  });
  assert.ok(off.text.indexOf('設営方法') !== -1 && off.text.indexOf('セルフ設営') !== -1, '見出し・選択肢自体は表示される');
  var lines = Panel.summarize(off.catalog, { equipment: { COB_BICOLOR: 1 }, layouts: ['GRUNGE'], setupService: 'SELF', cleanupService: 'SELF' }).join('\n');
  assert.strictEqual(lines.indexOf('セルフ設営（無料）'), -1);
  assert.strictEqual(lines.indexOf('セルフ（無料）'), -1);
  assert.strictEqual(Panel.copyFor(off.catalog).selfVsStaff.indexOf('無料です'), -1);
});

test('policy: 設営方法の選択が必須でない条件なら、クライアント側の必須チェックも課さない（最終判定はサーバー）', function () {
  var off = JSON.parse(JSON.stringify(CATALOG));
  off.policy.equipmentSetupChoiceRequired = false;
  var state = { equipment: { COB_BICOLOR: 1 }, layouts: [], setupChosen: false, cleanupChosen: false };
  assert.ok(Panel.validateSelection(state, CATALOG, []).indexOf('設営方法') !== -1, '必須のときは選択を促す');
  assert.strictEqual(Panel.validateSelection(state, off, []), '');
});
