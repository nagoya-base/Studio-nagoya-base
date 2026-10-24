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
    { code: 'VIDEO_LIGHT', label: 'ビデオライト', priceJpy: 2000, available: true, requiresPriorRental: true },
    { code: 'STROBE', label: 'ストロボ', priceJpy: null, available: false, requiresPriorRental: false }
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

test('buildSelection: 何も選ばなければnull（payloadにoptionsを付けない）。金額・承認状態は含めない', function () {
  assert.strictEqual(Panel.buildSelection({}), null);
  assert.strictEqual(Panel.buildSelection({ equipment: [], layouts: [], emailSupport: false }), null);
  var s = Panel.buildSelection({ equipment: ['VIDEO_LIGHT'], layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'SELF', emailSupport: true, amountJpy: 1, approvalStatus: 'APPROVED' });
  assert.deepStrictEqual(Object.keys(s).sort(), ['cleanupService', 'emailSupport', 'equipment', 'layouts', 'setupService']);
  assert.strictEqual(s.setupService, 'STAFF');
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
  var self = Panel.summarize(CATALOG, { layouts: ['GRUNGE'], emailSupport: true }).join('\n');
  assert.ok(self.indexOf('セルフ（無料）') !== -1);
  assert.ok(self.indexOf('メールサポート（無料）') !== -1);
  assert.ok(self.indexOf('承認') === -1, 'セルフは承認不要');
  assert.deepStrictEqual(Panel.summarize(CATALOG, {}), []);
});

test('describeError: サーバーの利用者向け文言をそのまま使う。無ければ汎用文', function () {
  assert.strictEqual(Panel.describeError({ code: 'X', message: 'ビデオライトは過去の方のみ' }), 'ビデオライトは過去の方のみ');
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
  var sb = loadBookingSandbox(['Booking.gs', 'BookingOptions.gs', 'Availability.gs', 'OptionMailTemplates.gs'], {});
  var url = sb.OptionMailTemplates.buildOptionsPageUrl({ brand: 'studio_x', bookingId: 'SX-20261101-AAAAAAAA' });
  assert.strictEqual(url, 'https://nagoya-base.github.io/Studio-nagoya-base/studio-x/booking/options/?bookingId=SX-20261101-AAAAAAAA');
});
