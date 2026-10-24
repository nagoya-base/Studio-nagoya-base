/*
 * scripts/booking-options.js（予約オプション選択パネル。Issue #423。Studio Xのみ）と、
 * 予約フォーム・後付けページへの配線のテスト。
 *
 * - 料金はカタログ（GAS）の値だけを表示し、画面側に金額を持たない。
 * - 送るのは選択内容のみ（金額・承認状態は送らない）。
 * - SNB / mensの予約ページにはオプション欄もスクリプトも入らない（既存の挙動を変えない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
var Panel = require('../scripts/booking-options.js');

var CATALOG = {
  enabled: true,
  equipment: [
    { code: 'COB_BICOLOR', label: 'バイカラーCOBライト（定常光）', unitPriceJpy: 800, unitLabel: '', stock: 1, requiresLecture: true },
    { code: 'STAND_260', label: 'ライトスタンド（260cm）', unitPriceJpy: 200, unitLabel: '本', stock: 3, requiresLecture: false },
    { code: 'BACKGROUND_STAND', label: '背景スタンド', unitPriceJpy: 200, unitLabel: '', stock: 1, requiresLecture: true }
  ],
  themes: [
    { code: 'CLASSROOM', label: '教室セット（机・黒板）' }, { code: 'JAPANESE', label: '和風セット' }, { code: 'GRUNGE', label: 'グランジセット' },
    { code: 'WHITE_BACKDROP', label: '白背景布' }, { code: 'BLACK_BACKDROP', label: '黒背景布' }
  ],
  staffServices: {
    PRE_SETUP: { label: '事前設営を依頼', priceJpy: 3000 },
    CLEANUP: { label: '片付けを依頼', priceJpy: 3000 },
    BOTH: { label: '事前設営＋片付けセット', priceJpy: 5000 }
  }
};

test('buildSelection: 何も選ばなければnull（payloadにoptionsを付けない）。金額・承認状態は含めず、数量0は選ばない扱い', function () {
  assert.strictEqual(Panel.buildSelection({}), null);
  assert.strictEqual(Panel.buildSelection({ equipment: {}, layouts: [], emailSupport: false }), null);
  assert.strictEqual(Panel.buildSelection({ equipment: { STAND_260: 0 } }), null);
  var s = Panel.buildSelection({ equipment: { COB_BICOLOR: 1, STAND_260: 2, BACKGROUND_STAND: 0 }, layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'SELF', emailSupport: true, amountJpy: 1, approvalStatus: 'APPROVED' });
  assert.deepStrictEqual(Object.keys(s).sort(), ['cleanupService', 'emailSupport', 'equipment', 'layouts', 'setupService']);
  assert.deepStrictEqual(s.equipment, { COB_BICOLOR: 1, STAND_260: 2 });
  assert.strictEqual(s.setupService, 'STAFF');
});

test('equipmentTotalJpy: 数量×単価の個別加算。単価はカタログの値だけを使う（無料セルフは0円）', function () {
  assert.strictEqual(Panel.equipmentTotalJpy(CATALOG, { COB_BICOLOR: 1, STAND_260: 3 }), 800 + 600);
  assert.strictEqual(Panel.equipmentTotalJpy(CATALOG, { BACKGROUND_STAND: 1 }), 200);
  assert.strictEqual(Panel.equipmentTotalJpy(CATALOG, {}), 0);
  var changed = JSON.parse(JSON.stringify(CATALOG));
  changed.equipment[1].unitPriceJpy = 250;
  assert.strictEqual(Panel.equipmentTotalJpy(changed, { STAND_260: 2 }), 500, '画面は値を持たずカタログに従う');
});

test('buildSelection: テーマ未選択ならセッティング方法はセルフ扱い。不明値はセルフ(無料)に倒す。NONEは後付け用に通す', function () {
  assert.strictEqual(Panel.buildSelection({ emailSupport: true, setupService: 'STAFF' }).setupService, 'SELF');
  assert.strictEqual(Panel.buildSelection({ layouts: ['GRUNGE'], setupService: 'whatever' }).setupService, 'SELF');
  assert.strictEqual(Panel.buildSelection({ layouts: ['GRUNGE'], setupService: 'NONE', cleanupService: 'STAFF' }).setupService, 'NONE');
});

test('staffServicePrice: 両方依頼ならカタログのセット価格(5,000円)。3,000円×2にしない。金額はカタログから取る', function () {
  assert.strictEqual(Panel.staffServicePrice(CATALOG, 'STAFF', 'STAFF').priceJpy, 5000);
  assert.strictEqual(Panel.staffServicePrice(CATALOG, 'STAFF', 'SELF').priceJpy, 3000);
  assert.strictEqual(Panel.staffServicePrice(CATALOG, 'SELF', 'STAFF').priceJpy, 3000);
  assert.strictEqual(Panel.staffServicePrice(CATALOG, 'SELF', 'SELF'), null);
  assert.strictEqual(Panel.staffServicePrice(CATALOG, 'NONE', 'NONE'), null);
  var changed = JSON.parse(JSON.stringify(CATALOG));
  changed.staffServices.BOTH.priceJpy = 4800;
  assert.strictEqual(Panel.staffServicePrice(changed, 'STAFF', 'STAFF').priceJpy, 4800, '画面は値を持たずカタログに従う');
});

test('validateSelection: スタッフ対応は1テーマのみ。セルフなら複数テーマ可', function () {
  assert.ok(Panel.validateSelection({ layouts: ['GRUNGE', 'CLASSROOM'], setupService: 'STAFF' }));
  assert.strictEqual(Panel.validateSelection({ layouts: ['GRUNGE', 'CLASSROOM'], setupService: 'SELF', cleanupService: 'SELF' }), '');
  assert.strictEqual(Panel.validateSelection({ layouts: ['GRUNGE'], setupService: 'STAFF' }), '');
});

test('summarize: スタッフ対応は「承認後にお支払い。申込時点では確定しません」と明示。無料セルフは無料と表示', function () {
  var staff = Panel.summarize(CATALOG, { layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'STAFF' }).join('\n');
  assert.ok(staff.indexOf('5,000円') !== -1);
  assert.ok(staff.indexOf('承認後にお支払い') !== -1 && staff.indexOf('申込時点では確定しません') !== -1);
  var rental = Panel.summarize(CATALOG, { equipment: { STAND_260: 2, COB_BICOLOR: 1 } }).join('\n');
  assert.ok(rental.indexOf('ライトスタンド（260cm） ×2（400円）') !== -1);
  assert.ok(rental.indexOf('機材レンタル合計: 1,200円') !== -1);
  assert.ok(rental.indexOf('部屋のご予約確定後にお支払い') !== -1);
  var self = Panel.summarize(CATALOG, { layouts: ['GRUNGE'], emailSupport: true }).join('\n');
  assert.ok(self.indexOf('セルフ（無料）') !== -1);
  assert.ok(self.indexOf('メールサポート（無料）') !== -1);
  assert.ok(self.indexOf('承認') === -1, 'セルフは承認不要');
  assert.deepStrictEqual(Panel.summarize(CATALOG, {}), []);
});

test('describeError: サーバーの利用者向け文言をそのまま使う。無ければ汎用文', function () {
  assert.strictEqual(Panel.describeError({ code: 'X', message: 'ビデオライトは許可済みの方のみ' }), 'ビデオライトは許可済みの方のみ');
  assert.ok(Panel.describeError(null).indexOf('時間を置いて') !== -1);
});

test('describeOrderStatus: 承認待ちは「まだ確定していません・お支払い不要」、不承認は「お支払いは発生していません」', function () {
  assert.ok(Panel.describeOrderStatus({ status: 'PENDING_APPROVAL' }).indexOf('まだ確定していません') !== -1);
  assert.ok(Panel.describeOrderStatus({ status: 'DECLINED' }).indexOf('お支払いは発生していません') !== -1);
  assert.ok(Panel.describeOrderStatus({ status: 'AWAITING_PAYMENT', requiresApproval: true }).indexOf('承認済み') !== -1);
  assert.strictEqual(Panel.describeOrderStatus({ status: 'CONFIRMED', amountJpy: 0 }), '確定（無料）');
});

// ---- 配線（Studio Xのみ） ----

test('Studio Xの予約ページだけがオプション欄を有効にし、オプション用スクリプトをbooking-app.jsより先に読む', function () {
  var x = read('studio-x/booking/index.html');
  assert.match(x, /options="true"/);
  assert.ok(x.indexOf('booking-options.js') !== -1);
  assert.ok(x.indexOf('booking-options.js') < x.indexOf('booking-app.js'), 'パネルが先に読み込まれていること');
});

test('SNB / mens / 英語版の予約ページにはオプション欄もスクリプトも入らない（既存の挙動・文面を変えない）', function () {
  ['booking/index.html', 'mens/booking/index.html', 'booking/en.html'].forEach(function (rel) {
    var html = read(rel);
    assert.ok(!/options="true"/.test(html), rel);
    assert.ok(html.indexOf('booking-options') === -1, rel);
  });
  var includeJa = read('_includes/booking_app_ja.html');
  // スロットはoptions=="true"の条件内にだけ存在する
  var slotIndex = includeJa.indexOf('id="ba-options-slot"');
  assert.ok(slotIndex !== -1);
  assert.ok(includeJa.lastIndexOf('{% if include.options == "true" %}', slotIndex) > includeJa.lastIndexOf('{% endif %}', slotIndex));
  assert.ok(read('_includes/booking_app_en.html').indexOf('ba-options-slot') === -1);
});

test('booking-app.js: オプションは選択内容のみをpayloadへ付け、スロットが無いページ（SNB/mens）では何もしない', function () {
  var src = read('scripts/booking-app.js');
  assert.ok(src.indexOf("root.getAttribute('data-options') === 'true'") !== -1);
  assert.ok(src.indexOf('if (optionsSelection) payload.options = optionsSelection;') !== -1);
  assert.ok(/var optionsPanel = null;/.test(src));
  // 金額・承認状態をクライアントから送る記述がない
  assert.ok(!/payload\.options\s*=\s*\{[^}]*(amount|price)/i.test(src));
});

test('後付けページ: noindex・Studio X専用・Stripe URL以外へは遷移しない・メールをストレージへ保存しない', function () {
  var html = read('studio-x/booking/options/index.html');
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.match(html, /data-brand="studio_x"/);
  assert.ok(html.indexOf('SNB') === -1 && html.indexOf('/mens/') === -1);
  var js = read('scripts/booking-options-addon.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(js, /\^https:\\\/\\\/checkout\\\.stripe\\\.com\\\//);
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(js), 'メールアドレス・予約IDをブラウザへ保存しない');
  assert.ok(js.indexOf("action=' + action") !== -1);
});

test('オプション決済完了ページ: 部屋予約の確定とは別の案内で、クエリ・予約IDを扱わず、noindex・Studio X専用', function () {
  var html = read('studio-x/booking/option-payment-complete.html');
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.match(html, /オプションはまだ確定していません/);
  assert.match(html, /二重のお支払いはお控えください/);
  assert.ok(!/session_id|bookingId|location\.search|URLSearchParams/.test(html));
  assert.ok(!/SNB|Studio Nagoya Base|\/mens\//.test(html.replace(/<link rel="canonical"[^>]*>/, '')));
});

test('メール内リンクの案内ページURLはStudio Xのオプション案内ページを指す', function () {
  var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
  var sb = loadBookingSandbox(['Booking.gs', 'EquipmentCatalog.gs', 'BookingOptions.gs', 'Availability.gs', 'OptionMailTemplates.gs'], {});
  var url = sb.OptionMailTemplates.buildOptionsPageUrl({ brand: 'studio_x', bookingId: 'SX-20261101-AAAAAAAA' });
  assert.strictEqual(url, 'https://nagoya-base.github.io/Studio-nagoya-base/studio-x/booking/options/?bookingId=SX-20261101-AAAAAAAA');
});

test('画面の案内文言: 有料レンタル機材全般は施錠管理で「管理者の利用許可が必要」で、未許可の申込は保留（お支払い・確定は管理者の確認後）。「過去利用者のみ」とは言わない', function () {
  var src = read('scripts/booking-options.js').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(src.indexOf('有料機材は管理者の利用許可が必要です') !== -1);
  assert.ok(src.indexOf('ストロボ等に資格の制限はありません') === -1, '資格制限なしの旧文言を残さない');
  assert.ok(src.indexOf('確認できるまでお支払い・確定はできません') !== -1);
  assert.ok(!/Admin/.test(src), '利用者向け画面に内部用語Adminを出さない（Issue #453）');
  assert.ok(src.indexOf('過去にビデオライト') === -1 && src.indexOf('過去の') === -1);
});

// ---- スタッフ設営の事前相談導線（Issue #423 追加要件） ----

test('事前相談の文言: 申込前に相談でき、相談だけでは申込・確定・決済にならない旨を明示し、CTAは「設営について事前相談する」', function () {
  assert.strictEqual(Panel.CONSULT_TEXT.lead, '配置に迷う場合は、申込前に相談できます。');
  assert.strictEqual(Panel.CONSULT_TEXT.notice, '相談だけでは予約されません。');
  assert.strictEqual(Panel.CONSULT_TEXT.cta, '設営について相談する');
});

test('事前相談の導線: 既存の問い合わせフォームへのリンクのみ。注文・API呼び出し・新しい相談管理を作らない', function () {
  var code = read('scripts/booking-options.js').replace(/\/\*[\s\S]*?\*\//g, '');
  // リンクは既存の相談フォーム(?intent=consult)。別タブで開く（申込ページを維持）
  assert.ok(code.indexOf("config.consultUrl || '../reservation/?intent=consult'") !== -1);
  assert.ok(/target: '_blank', rel: 'noopener', text: CONSULT_TEXT\.cta/.test(code));
  // 相談リンクの生成箇所はaタグのみで、fetch/POST/ストレージを呼ばない（パネル内のfetchはカタログ取得だけ）
  var fetches = code.match(/fetch\(/g) || [];
  assert.strictEqual(fetches.length, 1, 'パネルのfetchはoptionCatalogの取得だけ');
  assert.ok(code.indexOf("action=optionCatalog") !== -1);
  assert.ok(!/submitOptions|startOptionCheckout|localStorage|sessionStorage/.test(code));
  // 後付けページ(1階層深い)でも既存の相談フォームを指す
  assert.ok(read('scripts/booking-options-addon.js').indexOf("consultUrl: '../../reservation/?intent=consult'") !== -1);
  // 既存の相談フォームが実在し、?intent=consult を受け付ける
  assert.ok(fs.existsSync(path.join(ROOT, 'studio-x/reservation/index.html')));
  assert.ok(read('studio-x/reservation/form.js').indexOf('intent') !== -1);
  assert.ok(read('studio-x/booking/options/index.html').indexOf('booking-options.js') !== -1);
});

test('事前相談はスタッフ設営の選択肢付近（セッティング選択後）にだけ表示され、機材・無料サポート欄には出ない', function () {
  var src = read('scripts/booking-options.js');
  var start = src.indexOf('if (state.layouts.length > 0 || paidEquipment) {');
  var consult = src.indexOf("var consult = el('div', { className: 'ba-option-consult'");
  var support = src.indexOf("root.appendChild(el('h3', { className: 'ba-option-heading', text: '無料サポート' }))");
  var staffServices = src.indexOf("var staff = catalog.staffServices || {};");
  assert.ok(start !== -1 && consult > start && consult < support, '設営の選択肢(テーマ選択後のブロック)の中');
  assert.ok(staffServices > start && staffServices < consult, '設営/片付けの選択肢の直後');
});

test('事前相談の追加はサーバー側(GAS)・Stripe・注文に一切触れず、SNB / mensの予約ページにも影響しない', function () {
  ['gas/booking/shared/OptionOrderService.gs', 'gas/booking/shared/BookingOptions.gs', 'gas/booking/public/Code.gs'].forEach(function (rel) {
    assert.ok(read(rel).indexOf('CONSULT') === -1 && read(rel).indexOf('consult') === -1, rel + ' に相談関連の処理を追加していない');
  });
  ['booking/index.html', 'mens/booking/index.html', 'booking/en.html'].forEach(function (rel) {
    assert.ok(read(rel).indexOf('booking-options') === -1, rel);
  });
});

// ---- Issue #438: セット無料・設営方法の必須選択（サーバーのカタログ＝正本と同じ結果になること） ----

var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var gasSandbox = loadBookingSandbox(['EquipmentCatalog.gs', 'BookingOptions.gs'], {});
var SERVER_CATALOG = JSON.parse(JSON.stringify(gasSandbox.BookingOptions.buildCatalog('studio_x', {})));

test('画面の機材合計は、サーバー（planOrders）の請求額と一致する（セット無料の組み合わせを総当たり）', function () {
  var codes = ['COB_BICOLOR', 'COB_FULLCOLOR', 'STROBE_MONOBLOCK', 'STROBE_PORTABLE', 'STAND_260', 'BOWENS_BRACKET', 'SOFTBOX_STRIP_30X120', 'SOFTBOX_60', 'SOFTBOX_STRIP_60X90'];
  var max = { COB_BICOLOR: 1, COB_FULLCOLOR: 2, STROBE_MONOBLOCK: 1, STROBE_PORTABLE: 1, STAND_260: 3, BOWENS_BRACKET: 1, SOFTBOX_STRIP_30X120: 2, SOFTBOX_60: 1, SOFTBOX_STRIP_60X90: 2 };
  var checked = 0;
  (function walk(index, equipment) {
    if (index === codes.length) {
      if (Object.keys(equipment).length === 0) return;
      var normalized = gasSandbox.BookingOptions.normalizeSelection({ equipment: equipment, setupService: 'SELF', cleanupService: 'SELF' });
      assert.ok(normalized.ok, JSON.stringify(normalized.error));
      var planned = gasSandbox.BookingOptions.planOrders({
        normalized: normalized.normalized, existingOrders: [], optionsConfig: {},
        eligibility: { eligibleEquipmentCodes: gasSandbox.BookingOptions.lectureRequiredEquipmentCodes() }
      });
      var serverTotal = planned.orders.reduce(function (sum, o) { return o.category === 'EQUIPMENT' ? sum + o.amountJpy : sum; }, 0);
      assert.strictEqual(Panel.equipmentTotalJpy(SERVER_CATALOG, equipment), serverTotal, JSON.stringify(equipment));
      checked += 1;
      return;
    }
    for (var qty = 0; qty <= max[codes[index]]; qty += 1) {
      var next = Object.assign({}, equipment);
      if (qty > 0) next[codes[index]] = qty;
      walk(index + 1, next);
    }
  })(0, {});
  assert.ok(checked > 100);
});

test('summarize: セット無料は「（セット無料）」「（うちN本セット無料）」と表示し、合計から除く', function () {
  var set = Panel.summarize(SERVER_CATALOG, { equipment: { COB_FULLCOLOR: 2, STAND_260: 2 }, setupService: 'SELF', cleanupService: 'SELF', setupChosen: true, cleanupChosen: true }).join('\n');
  assert.ok(set.indexOf('ライトスタンド（260cm） ×2（無料）（セット無料）') !== -1, set);
  assert.ok(set.indexOf('機材レンタル合計: 2,000円') !== -1, set);
  assert.ok(set.indexOf('機材の設営方法: セルフ設営（無料）') !== -1, set);
  var partial = Panel.summarize(SERVER_CATALOG, { equipment: { COB_FULLCOLOR: 1, STAND_260: 3 }, setupService: 'SELF', cleanupService: 'SELF', setupChosen: true, cleanupChosen: true }).join('\n');
  assert.ok(partial.indexOf('ライトスタンド（260cm） ×3（400円）（うち1本セット無料）') !== -1, partial);
  var alone = Panel.summarize(SERVER_CATALOG, { equipment: { STAND_260: 1 }, setupService: 'SELF', cleanupService: 'SELF', setupChosen: true, cleanupChosen: true }).join('\n');
  assert.ok(alone.indexOf('ライトスタンド（260cm）（200円）') !== -1 && alone.indexOf('セット無料') === -1, alone);
});

test('validateSelection: 有料機材を選んだのに設営方法を選んでいなければ次へ進めない。スタッフ設営はテーマ不要', function () {
  var equipment = { STROBE_PORTABLE: 1 };
  assert.ok(Panel.validateSelection({ equipment: equipment, setupService: 'SELF', setupChosen: false }, SERVER_CATALOG).indexOf('設営方法') !== -1);
  assert.strictEqual(Panel.validateSelection({ equipment: equipment, setupService: 'SELF', setupChosen: true, cleanupService: 'SELF', cleanupChosen: true }, SERVER_CATALOG), '');
  assert.strictEqual(Panel.validateSelection({ equipment: equipment, setupService: 'STAFF', setupChosen: true, cleanupService: 'SELF', cleanupChosen: true, layouts: ['GRUNGE'] }, SERVER_CATALOG), '');
  assert.strictEqual(Panel.validateSelection({ equipment: equipment, setupService: 'STAFF', setupChosen: true, cleanupService: 'SELF', cleanupChosen: true, layouts: [] }, SERVER_CATALOG), '', '機材のみでもスタッフ設営を選べる');
  assert.ok(Panel.validateSelection({ equipment: equipment, setupService: 'NONE', setupChosen: true, cleanupChosen: true }, SERVER_CATALOG).indexOf('設営方法') !== -1, '機材レンタルでは後付けでもNONEは通らない');
  assert.strictEqual(Panel.validateSelection({ equipment: {}, setupService: 'SELF', cleanupService: 'SELF', setupChosen: false }, SERVER_CATALOG), '', '機材なしなら設営方法は任意');
  assert.strictEqual(Panel.validateSelection({ equipment: { STAND_260: 1 }, setupService: 'SELF', cleanupService: 'SELF', setupChosen: false }, SERVER_CATALOG).indexOf('設営方法') !== -1, true, 'スタンド単独も有料機材');
});

test('buildSelection: 機材のみでもsetupServiceを送る（サーバーが明示選択を必須で検査する）', function () {
  assert.strictEqual(Panel.buildSelection({ equipment: { STROBE_PORTABLE: 1 }, setupService: 'SELF', cleanupService: 'SELF' }).setupService, 'SELF');
  assert.strictEqual(Panel.buildSelection({ equipment: { STROBE_PORTABLE: 1 }, layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'SELF' }).setupService, 'STAFF');
});

test('パネルのUI: 機材を選ぶと設営方法のラジオを出し、未選択のままにする（セット無料の表示ラベルはカタログの値）', function () {
  var src = read('scripts/booking-options.js');
  assert.ok(src.indexOf('state.setupChosen = true') !== -1);
  assert.ok(src.indexOf('item.freeWhenWith && item.freeWhenWith.label') !== -1);
  assert.ok(src.indexOf('設営方法（機材レンタル時は必須）') !== -1);
  assert.ok(!/セットで無料|単独200円/.test(src), '無料条件の文言をパネルに直書きしない（カタログの値だけ）');
});

test('パネルのUI: 機材レンタル中は後付けでも設営方法に「追加しない」を出さない', function () {
  assert.ok(read('scripts/booking-options.js').indexOf("config.allowNone && !paidEquipment") !== -1);
});

// ---- Issue #441: 片付け方法の必須選択・料金サマリー ----

test('validateSelection: 有料機材は片付け方法も明示選択が必須（未選択は進めない）', function () {
  var base = { equipment: { STROBE_PORTABLE: 1 }, setupService: 'SELF', setupChosen: true };
  assert.ok(Panel.validateSelection(base, SERVER_CATALOG).indexOf('片付け方法') !== -1);
  assert.ok(Panel.validateSelection(Object.assign({}, base, { cleanupService: 'NONE', cleanupChosen: true }), SERVER_CATALOG).indexOf('片付け方法') !== -1, 'NONEは不可');
  assert.strictEqual(Panel.validateSelection(Object.assign({}, base, { cleanupService: 'STAFF', cleanupChosen: true }), SERVER_CATALOG), '', 'テーマ未選択でもスタッフ片付けを選べる');
});

test('computeSummary: 機材・設営・片付け・セット割引・合計。セルフは0円、両方スタッフは5,000円', function () {
  var eq = { COB_FULLCOLOR: 1, STAND_260: 1 };
  var self = Panel.computeSummary(SERVER_CATALOG, { equipment: eq, setupService: 'SELF', cleanupService: 'SELF' });
  assert.deepStrictEqual([self.equipmentJpy, self.setupJpy, self.cleanupJpy, self.bundleAdjustmentJpy, self.totalJpy], [1000, 0, 0, 0, 1000]);
  var both = Panel.computeSummary(SERVER_CATALOG, { equipment: { COB_FULLCOLOR: 2 }, setupService: 'STAFF', cleanupService: 'STAFF' });
  assert.deepStrictEqual([both.equipmentJpy, both.setupJpy, both.cleanupJpy, both.bundleAdjustmentJpy, both.totalJpy], [2000, 3000, 3000, -1000, 7000]);
  var setupOnly = Panel.computeSummary(SERVER_CATALOG, { equipment: eq, setupService: 'STAFF', cleanupService: 'SELF' });
  assert.strictEqual(setupOnly.totalJpy, 4000);
  var none = Panel.computeSummary(SERVER_CATALOG, { equipment: {}, layouts: [], setupService: 'STAFF', cleanupService: 'STAFF' });
  assert.strictEqual(none.totalJpy, 0, '機材もテーマも無ければスタッフ料金は対象外');
});

test('computeSummary の合計は、サーバー（planOrders）の請求額合計と一致する（設営×片付け×セット無料）', function () {
  var equipments = [{ STROBE_PORTABLE: 1, BOWENS_BRACKET: 1, STAND_260: 2 }, { COB_FULLCOLOR: 2, STAND_260: 3 }, { SOFTBOX_STRIP_60X90: 2 }, { COMMANDER_CANON: 1 }];
  var checked = 0;
  equipments.forEach(function (equipment) {
    ['SELF', 'STAFF'].forEach(function (setup) {
      ['SELF', 'STAFF'].forEach(function (cleanup) {
        var normalized = gasSandbox.BookingOptions.normalizeSelection({ equipment: equipment, setupService: setup, cleanupService: cleanup });
        assert.ok(normalized.ok, JSON.stringify(normalized.error));
        var planned = gasSandbox.BookingOptions.planOrders({
          normalized: normalized.normalized, existingOrders: [], optionsConfig: {},
          eligibility: { eligibleEquipmentCodes: gasSandbox.BookingOptions.lectureRequiredEquipmentCodes() }
        });
        var serverTotal = planned.orders.reduce(function (sum, o) { return sum + o.amountJpy; }, 0);
        assert.strictEqual(Panel.computeSummary(SERVER_CATALOG, { equipment: equipment, setupService: setup, cleanupService: cleanup }).totalJpy, serverTotal, JSON.stringify([equipment, setup, cleanup]));
        checked += 1;
      });
    });
  });
  assert.strictEqual(checked, 16);
});

test('オクタゴンソフトボックス（90cm）は300円/個・最大1個（コードSOFTBOX_60は据え置き）', function () {
  var item = SERVER_CATALOG.equipment.filter(function (e) { return e.code === 'SOFTBOX_60'; })[0];
  assert.deepStrictEqual([item.label, item.unitPriceJpy, item.stock, item.unitLabel], ['オクタゴンソフトボックス（90cm）', 300, 1, '個']);
});

test('ストリップソフトボックス（60×90cm）は300円/個・最大2個（コードSOFTBOX_STRIP_60X90は据え置き）', function () {
  var item = SERVER_CATALOG.equipment.filter(function (e) { return e.code === 'SOFTBOX_STRIP_60X90'; })[0];
  assert.deepStrictEqual([item.label, item.unitPriceJpy, item.stock, item.unitLabel], ['ストリップソフトボックス（60×90cm）', 300, 2, '個']);
});

test('後付け: 申込済みのスタッフ対応があるとき、画面の追加請求額はサーバー（planOrders）の差額計算と一致する（Issue #441 レビュー対応）', function () {
  var equipment = { COB_FULLCOLOR: 1 };
  var cases = [
    { existing: ['STAFF_PRE_SETUP:EQUIPMENT'], setup: 'SELF', cleanup: 'STAFF', staff: 2000 },
    { existing: ['STAFF_CLEANUP:EQUIPMENT'], setup: 'STAFF', cleanup: 'SELF', staff: 2000 },
    { existing: ['STAFF_PRE_SETUP:EQUIPMENT'], setup: 'SELF', cleanup: 'SELF', staff: 0 },
    { existing: [], setup: 'STAFF', cleanup: 'STAFF', staff: 5000 }
  ];
  cases.forEach(function (c) {
    var normalized = gasSandbox.BookingOptions.normalizeSelection({ equipment: equipment, setupService: c.setup, cleanupService: c.cleanup });
    assert.ok(normalized.ok, JSON.stringify(normalized.error));
    var existingOrders = c.existing.length ? [{ status: 'PENDING_APPROVAL', items: c.existing }] : [];
    var planned = gasSandbox.BookingOptions.planOrders({
      normalized: normalized.normalized, existingOrders: existingOrders, optionsConfig: {},
      eligibility: { eligibleEquipmentCodes: gasSandbox.BookingOptions.lectureRequiredEquipmentCodes() }
    });
    assert.ok(planned.ok, JSON.stringify(planned.error));
    var serverTotal = planned.orders.reduce(function (sum, o) { return sum + o.amountJpy; }, 0);
    var clientOrders = c.existing.map(function (code) { return { items: [{ code: code, label: code }], status: 'PENDING_APPROVAL' }; });
    var sum = Panel.computeSummary(SERVER_CATALOG, { equipment: equipment, setupService: c.setup, cleanupService: c.cleanup }, clientOrders);
    assert.strictEqual(sum.staffJpy, c.staff, JSON.stringify(c));
    assert.strictEqual(sum.totalJpy, serverTotal, JSON.stringify(c));
    assert.strictEqual(sum.setupJpy + sum.cleanupJpy + sum.bundleAdjustmentJpy, c.staff, '内訳の合計は追加請求額と一致する');
  });
});

test('後付け: 申込済みと同じスタッフ対応の再依頼は重複として画面でも止める（サーバーはDUPLICATE_OPTION）', function () {
  var state = { equipment: { COB_FULLCOLOR: 1 }, setupService: 'STAFF', setupChosen: true, cleanupService: 'SELF', cleanupChosen: true };
  var existing = [{ items: [{ code: 'STAFF_PRE_SETUP:EQUIPMENT' }], status: 'AWAITING_PAYMENT' }];
  assert.ok(Panel.validateSelection(state, SERVER_CATALOG, existing).indexOf('重複') !== -1);
  assert.strictEqual(Panel.validateSelection(state, SERVER_CATALOG, []), '');
});
