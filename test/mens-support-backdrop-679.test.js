/*
 * SNB mens「作品撮りサポート」の照明3問ガイドと背景5種の選択（Issue #679）のテスト。
 *
 * - 背景の品目定義の唯一の正本は _data/studio_x_equipment.json の supportBackdrops（EquipmentCatalog.gs へ生成）。
 * - 背景は専用列 Bookings.supportBackdrop（末尾追加）に1件だけ保存し、料金計算用の supportEquipment には混ぜない。
 * - 未知コード・複数値・他ブランド／他プランでの指定はサーバーで拒否する。旧予約の空欄は背景なしとして扱う。
 * - 和柄2種の未確認の値（在庫・寸法・運用文言）は推測しない。承認前に運営が現物・利用可否・設置上の注意を確認する。
 * - 照明3問は Studio X と同じロジック（scripts/booking-options.js）を共有し、対応表・料金表を複製しない。
 *
 * Stripe・Sheets・Calendarはすべてスタブ/fixtureで、本番へは一切アクセスしない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var memberProof = require('./helpers/booking-member-proof');
var Logic = require('../scripts/booking-logic.js');
var Panel = require('../scripts/booking-options.js');
var sync = require('../scripts/sync-studio-x-equipment');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
var DATA = JSON.parse(read('_data/studio_x_equipment.json'));

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs',
  'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'EquipmentCatalog.gs',
  'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs',
  'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs', 'BookingMailTemplates.gs',
  'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs', 'BookingRepository.gs', 'AdminNotifier.gs',
  'BookingAdminAlerts.gs', 'BookingReschedule.gs', 'BookingMemberVerification.gs', 'Code.gs'
];

var PLAN = 'mens_photo_support';
var CARD = 'オンラインクレジットカード';
var EMAIL = 'taro@example.com';
var NOW = new Date('2026-12-05T12:00:00+09:00');
var SATURDAY = '2026-12-12';
var MEMBER = { [EMAIL]: ['2026-12', '2027-01'] };

var CODES = ['BACKDROP_CLOTH_WHITE', 'BACKDROP_CLOTH_BLACK', 'BACKDROP_TSURU_BLACK', 'BACKDROP_ASANOHA_INDIGO', 'BACKDROP_GRUNGE'];
var LABELS = {
  BACKDROP_CLOTH_WHITE: '白背景布',
  BACKDROP_CLOTH_BLACK: '黒背景布',
  BACKDROP_TSURU_BLACK: '和柄背景（鶴・黒）',
  BACKDROP_ASANOHA_INDIGO: '和柄背景（麻の葉・藍）',
  BACKDROP_GRUNGE: 'グランジ背景'
};
var JAPANESE = ['BACKDROP_TSURU_BLACK', 'BACKDROP_ASANOHA_INDIGO'];

function loadPricing() {
  return loadBookingSandbox(['JapaneseHolidays.gs', 'BookingPricing.gs', 'BookingOptions.gs', 'EquipmentCatalog.gs', 'MembershipRules.gs', 'Config.gs'], {});
}

function setup(opts) {
  var o = opts || {};
  var calendarsById = { cal1: { events: [] } };
  var spreadsheetsById = { ss1: {} };
  var properties = {
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1',
    BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000',
    STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_CHECKOUT_ENABLED: 'true',
    STRIPE_CHECKOUT_SUCCESS_URL: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/payment-complete.html?session_id={CHECKOUT_SESSION_ID}',
    STRIPE_CHECKOUT_CANCEL_URL: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/'
  };
  var mailApp = stubs.createMailAppStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp,
    UrlFetchApp: stubs.createUrlFetchAppStub(function (url) { throw new Error('Stripeは呼ばれない想定: ' + url); }),
    Logger: stubs.createLoggerStub(), ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(FILES.concat(o.admin ? ['BookingAdminWeb.gs'] : []), globals);
  var ctx = { sandbox: sandbox, mailApp: mailApp, calendars: calendarsById, sheets: spreadsheetsById.ss1, members: JSON.parse(JSON.stringify(o.members || MEMBER)), proofs: {} };
  sandbox.MemberRepository.isMemberForMonth = function (email, month) {
    return (ctx.members[String(email).toLowerCase()] || []).indexOf(month) !== -1;
  };
  sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    return sandbox.MemberRepository.isMemberForMonth(email, String(date).substring(0, 7));
  };
  return ctx;
}

function payload(overrides) {
  return Object.assign({
    brand: 'mens', customerType: 'returning', date: SATURDAY, startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '2名', purpose: '作品撮り',
    paymentMethod: CARD, note: '', source: 'test', isMember: false, plan: PLAN, supportServices: 'BOTH'
  }, overrides || {});
}

function book(ctx, overrides, now) {
  var at = now || NOW;
  var p = payload(overrides);
  p.memberProof = memberProof.proofFor(ctx.proofs, ctx.sandbox, ctx.mailApp, p.email, at);
  return ctx.sandbox.BookingRepository.createBooking(p, at);
}

function record(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

function heldEvents(ctx) {
  return ctx.calendars.cal1.events.filter(function (e) { return !e.isDeleted(); }).length;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

// ============================================================================
// 正本（_data/studio_x_equipment.json の supportBackdrops）
// ============================================================================

test('正本: 背景5種の識別コード・表示名・対象（mens／作品撮りサポートのみ）が確定どおりで、生成物と同期している', function () {
  var items = DATA.supportBackdrops.items;
  assert.deepStrictEqual(items.map(function (i) { return i.code; }), CODES);
  items.forEach(function (i) {
    assert.strictEqual(i.label, LABELS[i.code], i.code);
    assert.deepStrictEqual(i.brands, ['mens'], i.code);
    assert.deepStrictEqual(i.plans, [PLAN], i.code);
  });
  assert.strictEqual(fs.readFileSync(sync.TARGET, 'utf8'), sync.render(), 'EquipmentCatalog.gs を再生成してください');
  assert.ok(read('gas/booking/shared/EquipmentCatalog.gs').indexOf('BACKDROP_ASANOHA_INDIGO') !== -1);
});

test('正本: 背景の単体料金・背景紙料金・追加設営料金は持たない（金額のキーが無い）', function () {
  DATA.supportBackdrops.items.forEach(function (i) {
    ['unitPriceJpy', 'priceJpy', 'amountJpy', 'price', 'staffFeeJpy'].forEach(function (k) { assert.ok(!(k in i), i.code + ' に ' + k); });
  });
});

test('正本: 白・黒の背景布は既存の freeSelf（幅180cm×長さ250cm・在庫1）を参照し、寸法・在庫を複製しない。135cmの背景紙ロール（permanent）とは別物', function () {
  ['BACKDROP_CLOTH_WHITE', 'BACKDROP_CLOTH_BLACK'].forEach(function (code) {
    var def = DATA.supportBackdrops.items.filter(function (i) { return i.code === code; })[0];
    var cloth = DATA.freeSelf.filter(function (f) { return f.code === def.freeSelfCode; })[0];
    assert.ok(cloth, code + ' は freeSelf の同コードを参照する');
    assert.strictEqual(def.freeSelfCode, code);
    assert.strictEqual(cloth.stock, 1);
    assert.strictEqual(cloth.widthCm, 180);
    assert.strictEqual(cloth.lengthCm, 250);
    assert.ok(cloth.label.indexOf('幅180cm×長さ250cm') !== -1, '寸法の構造化値と表示ラベルが一致');
    assert.strictEqual(def.stock, null, '在庫は freeSelf を参照し、ここでは複製しない');
    assert.strictEqual(def.image, null, '紙の写真・仮画像を布の見本にしない（見本画像なし）');
  });
  assert.strictEqual(DATA.supportBackdrops.items.filter(function (i) { return i.code === 'BACKDROP_CLOTH_WHITE'; })[0].themeCode, 'WHITE_BACKDROP');
  assert.strictEqual(DATA.supportBackdrops.items.filter(function (i) { return i.code === 'BACKDROP_CLOTH_BLACK'; })[0].themeCode, 'BLACK_BACKDROP');
  assert.ok(DATA.permanent.some(function (p) { return /背景紙 ホワイト（135cm×5m）/.test(p.label); }), '常設の背景紙ロールは別品目のまま');
  CODES.forEach(function (code) {
    assert.ok(!DATA.rental.some(function (r) { return r.code === code; }), code + ' を有料機材（rental）にしない');
  });
});

test('正本: 和柄2種は未確認の値（在庫・寸法・運用文言）を推測せず null。JAPANESE（和風セット）とは別品目として個別に識別する', function () {
  JAPANESE.forEach(function (code) {
    var def = DATA.supportBackdrops.items.filter(function (i) { return i.code === code; })[0];
    assert.strictEqual(def.stock, null, code + ' の在庫は不明（0でも無制限でもない）');
    assert.strictEqual(def.freeSelfCode, null, code + ' は寸法を持つ定義へ紐づけない');
    assert.strictEqual(def.themeCode, null, code + ' は運用文言が未整備（JAPANESEの畳の運用ではない）');
    assert.ok(!('widthCm' in def) && !('lengthCm' in def));
  });
  assert.ok(!DATA.supportBackdrops.items.some(function (i) { return i.themeCode === 'JAPANESE'; }), '和風セットへ1件にまとめない');
  assert.ok(!DATA.freeSelf.some(function (f) { return JAPANESE.indexOf(f.code) !== -1; }), '和柄を freeSelf（確定在庫）に載せない');
});

test('正本: グランジ背景は既存の GRUNGE（グランジセット。白黒背景布と同じ運用で確定済み）に対応する。SXのテーマコードは変更しない', function () {
  var def = DATA.supportBackdrops.items.filter(function (i) { return i.code === 'BACKDROP_GRUNGE'; })[0];
  assert.strictEqual(def.themeCode, 'GRUNGE');
  assert.deepStrictEqual(DATA.staffService.themes.map(function (t) { return t.code; }), ['CLASSROOM', 'JAPANESE', 'GRUNGE', 'WHITE_BACKDROP', 'BLACK_BACKDROP']);
});

test('正本: 見本画像は実在する既存画像（鶴・麻の葉・グランジ）だけ。白黒布は見本なし', function () {
  var images = {};
  DATA.supportBackdrops.items.forEach(function (i) { images[i.code] = i.image; });
  assert.deepStrictEqual(images, {
    BACKDROP_CLOTH_WHITE: null,
    BACKDROP_CLOTH_BLACK: null,
    BACKDROP_TSURU_BLACK: 'images/pattern-tsuru-black_1200.webp',
    BACKDROP_ASANOHA_INDIGO: 'images/pattern-asanoha-indigo_1200.webp',
    BACKDROP_GRUNGE: 'images/backdrop-tiedye-gray_1200.webp'
  });
  Object.keys(images).forEach(function (code) {
    if (images[code]) assert.ok(fs.existsSync(path.join(ROOT, images[code])), images[code]);
  });
});

// ============================================================================
// 保存先（専用列）
// ============================================================================

test('スキーマ: supportBackdrop は Bookings の末尾列。途中挿入なし・supportEquipment とは別の列', function () {
  var h = loadBookingSandbox(['BookingsSchema.gs'], {}).BookingsSchema.HEADERS;
  assert.strictEqual(h[h.length - 1], 'supportBackdrop');
  assert.strictEqual(h.filter(function (x) { return x === 'supportBackdrop'; }).length, 1);
  assert.strictEqual(h[h.length - 2], 'largePartyPaymentDueAt', '直前の列は#668の末尾列のまま（既存列は移動しない）');
  assert.ok(h.indexOf('supportEquipment') < h.indexOf('supportBackdrop') && h.indexOf('supportEquipment') !== h.indexOf('supportBackdrop'));
});

// ============================================================================
// サーバー検証
// ============================================================================

test('検証: 既知の1コードだけ受理。空は背景なし。未知・複数値・小文字・配列・オブジェクトは拒否', function () {
  var O = loadPricing().BookingOptions;
  var ctx = { brand: 'mens', plan: PLAN };
  CODES.forEach(function (code) {
    var r = O.normalizeSupportBackdrop(code, ctx);
    assert.deepStrictEqual([r.ok, r.code, r.empty], [true, code, false], code);
  });
  ['', undefined, null, '   '].forEach(function (v) {
    var r = O.normalizeSupportBackdrop(v, ctx);
    assert.deepStrictEqual([r.ok, r.code, r.empty], [true, '', true], String(v));
  });
  assert.strictEqual(O.normalizeSupportBackdrop('BACKDROP_UNKNOWN', ctx).error.code, 'UNKNOWN_SUPPORT_BACKDROP');
  assert.strictEqual(O.normalizeSupportBackdrop('JAPANESE', ctx).error.code, 'UNKNOWN_SUPPORT_BACKDROP', 'SXのテーマコードは背景コードではない');
  assert.strictEqual(O.normalizeSupportBackdrop('WHITE_BACKDROP', ctx).error.code, 'UNKNOWN_SUPPORT_BACKDROP');
  assert.strictEqual(O.normalizeSupportBackdrop('BACKDROP_CLOTH_WHITE,BACKDROP_CLOTH_BLACK', ctx).error.code, 'INVALID_SUPPORT_BACKDROP', '複数値');
  assert.strictEqual(O.normalizeSupportBackdrop('backdrop_cloth_white', ctx).error.code, 'INVALID_SUPPORT_BACKDROP');
  assert.strictEqual(O.normalizeSupportBackdrop(['BACKDROP_CLOTH_WHITE'], ctx).error.code, 'INVALID_SUPPORT_BACKDROP');
  assert.strictEqual(O.normalizeSupportBackdrop({ code: 'BACKDROP_CLOTH_WHITE' }, ctx).error.code, 'INVALID_SUPPORT_BACKDROP');
  assert.strictEqual(O.normalizeSupportBackdrop(1, ctx).error.code, 'INVALID_SUPPORT_BACKDROP');
});

test('検証: 他ブランド・他プランでの非空指定は拒否（SX・SNB一般・通常のmens予約には付けられない）', function () {
  var O = loadPricing().BookingOptions;
  ['snb', 'studio_x'].forEach(function (brand) {
    assert.strictEqual(O.normalizeSupportBackdrop('BACKDROP_CLOTH_WHITE', { brand: brand, plan: PLAN }).error.code, 'SUPPORT_BACKDROP_NOT_AVAILABLE', brand);
  });
  ['', 'member_pair_3h', 'mens_weekend_shower_4h'].forEach(function (plan) {
    assert.strictEqual(O.normalizeSupportBackdrop('BACKDROP_GRUNGE', { brand: 'mens', plan: plan }).error.code, 'SUPPORT_BACKDROP_NOT_AVAILABLE', plan);
  });
});

test('料金: 背景の選択は金額に一切影響しない（5種とも・片付けのみでも事前設営料金は加算されない）。スタンドは自動追加されない', function () {
  var P = loadPricing().BookingPricing;
  ['SETUP', 'CLEANUP', 'BOTH'].forEach(function (services) {
    var base = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 120, generation: 'V2', plan: PLAN, supportServices: services });
    assert.strictEqual(base.valid, true);
    assert.strictEqual(base.price.supportBackdrop, '');
    CODES.forEach(function (code) {
      var r = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 120, generation: 'V2', plan: PLAN, supportServices: services, supportBackdrop: code });
      assert.strictEqual(r.valid, true, services + ' ' + code);
      assert.strictEqual(r.price.amount, base.price.amount, services + ' ' + code + ' は金額が変わらない');
      assert.strictEqual(r.price.staffAmount, base.price.staffAmount);
      assert.strictEqual(r.price.equipmentAmount, 0, '背景を選んだだけでスタンド等の機材を加算しない');
      assert.deepStrictEqual(clone(r.price.equipmentItems), []);
      assert.strictEqual(r.price.supportBackdrop, code);
    });
  });
  var cleanup = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 120, generation: 'V2', plan: PLAN, supportServices: 'CLEANUP', supportBackdrop: 'BACKDROP_TSURU_BLACK' });
  assert.strictEqual(cleanup.price.staffAmount, 3000, '片付けのみは片付け料金のまま（事前設営を足さない）');
});

test('料金: 背景スタンド（200円）は利用者が機材として明示選択した場合だけ加算される（共通カタログの単価）', function () {
  var P = loadPricing().BookingPricing;
  var stand = DATA.rental.filter(function (r) { return r.code === 'BACKGROUND_STAND'; })[0];
  assert.strictEqual(stand.unitPriceJpy, 200);
  var base = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 120, generation: 'V2', plan: PLAN, supportServices: 'BOTH', supportBackdrop: 'BACKDROP_CLOTH_BLACK' });
  var withStand = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 120, generation: 'V2', plan: PLAN, supportServices: 'BOTH', supportBackdrop: 'BACKDROP_CLOTH_BLACK', supportEquipment: { BACKGROUND_STAND: 1 } });
  assert.strictEqual(withStand.price.amount - base.price.amount, 200);
  assert.strictEqual(withStand.price.equipmentAmount, 200);
  assert.strictEqual(withStand.price.supportBackdrop, 'BACKDROP_CLOTH_BLACK');
});

test('料金: 作品撮りサポート以外のプラン・他ブランドで supportBackdrop を渡すと拒否（通常料金へ黙って倒さない）。既存の通常料金は不変', function () {
  var P = loadPricing().BookingPricing;
  var normal = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 120, generation: 'V2', isMember: true });
  var withBackdrop = P.computeBookingPrice({ brand: 'mens', date: SATURDAY, durationMinutes: 120, generation: 'V2', isMember: true, supportBackdrop: 'BACKDROP_GRUNGE' });
  assert.strictEqual(withBackdrop.valid, false);
  assert.strictEqual(withBackdrop.error.code, 'SUPPORT_BACKDROP_NOT_AVAILABLE');
  assert.strictEqual(normal.valid, true);
  assert.strictEqual('supportBackdrop' in normal.price, false, '通常予約の料金結果にキーを足さない');
  ['snb', 'studio_x'].forEach(function (brand) {
    var r = P.computeBookingPrice({ brand: brand, date: SATURDAY, durationMinutes: 120, generation: 'V2', supportBackdrop: 'BACKDROP_CLOTH_WHITE' });
    assert.strictEqual(r.valid, false, brand);
  });
});

// ============================================================================
// 公開カタログ（optionCatalog）
// ============================================================================

test('カタログAPI: mensだけが背景5種を返す。在庫・未確認の値は返さず、和柄は寸法なし・運用文言未整備、白黒布は寸法あり', function () {
  var S = loadPricing();
  var catalog = clone(S.BookingOptions.buildCatalog('mens', {}));
  assert.deepStrictEqual(catalog.supportBackdrops.map(function (i) { return i.code; }), CODES);
  var byCode = {};
  catalog.supportBackdrops.forEach(function (i) { byCode[i.code] = i; });
  CODES.forEach(function (code) {
    assert.strictEqual(byCode[code].label, LABELS[code]);
    assert.ok(!('stock' in byCode[code]), code + ' の在庫は公開しない');
    assert.ok(!('themeCode' in byCode[code]), '内部のテーマコードは公開しない');
  });
  ['BACKDROP_CLOTH_WHITE', 'BACKDROP_CLOTH_BLACK'].forEach(function (code) {
    assert.strictEqual(byCode[code].sizeLabel, '幅180cm×長さ250cm');
    assert.strictEqual(byCode[code].selfSetupGuidanceReady, true, '白黒布は確定済みの案内を使う');
    assert.strictEqual(byCode[code].image, null);
  });
  JAPANESE.forEach(function (code) {
    assert.strictEqual(byCode[code].sizeLabel, null, '未確認の寸法は表示しない');
    assert.strictEqual(byCode[code].selfSetupGuidanceReady, false, '和柄の運用文言は未整備');
    assert.ok(/^images\/.+\.webp$/.test(byCode[code].image));
  });
  assert.strictEqual(byCode.BACKDROP_GRUNGE.selfSetupGuidanceReady, true, 'グランジは白黒布と同じ確定済みの運用');
  assert.strictEqual(byCode.BACKDROP_GRUNGE.sizeLabel, null);
  assert.ok(byCode.BACKDROP_CLOTH_WHITE.note.indexOf('135cm') !== -1, '135cm背景紙ロールとの違いを示す');
  ['snb', 'studio_x'].forEach(function (brand) {
    assert.strictEqual(S.BookingOptions.buildCatalog(brand, {}).supportBackdrops, undefined, brand + ' には背景を出さない');
  });
  assert.ok(!JSON.stringify(S.BookingOptions.buildCatalog('studio_x', {})).includes('BACKDROP_TSURU'), 'SXのカタログは変わらない');
});

test('カタログAPI: 有料機材（supportEquipment）に背景品目は混ざらない', function () {
  var catalog = loadPricing().BookingOptions.buildCatalog('mens', {});
  catalog.supportEquipment.forEach(function (e) {
    assert.ok(CODES.indexOf(e.code) === -1 || e.code === 'BACKDROP_CLOTH_WHITE' || e.code === 'BACKDROP_CLOTH_BLACK', e.code);
  });
  /* freeSelf の背景布は selectable:false のため、機材の選択肢には出ない（背景は専用の欄で選ぶ）。 */
  assert.ok(!catalog.supportEquipment.some(function (e) { return CODES.indexOf(e.code) !== -1; }));
});

// ============================================================================
// 申込→保存→確認→メール→管理（往復）
// ============================================================================

test('往復: 5種とも専用列へ保存され、supportEquipment・金額・料金世代には混ざらない', function () {
  CODES.forEach(function (code) {
    var ctx = setup();
    var plain = book(ctx, {});
    assert.strictEqual(plain.success, true, JSON.stringify(plain));
    var withBackdrop = book(ctx, { supportBackdrop: code, startTime: '15:00' });
    assert.strictEqual(withBackdrop.success, true, code + JSON.stringify(withBackdrop));
    assert.strictEqual(withBackdrop.price.supportBackdrop, code);
    var a = record(ctx, plain.bookingId);
    var b = record(ctx, withBackdrop.bookingId);
    assert.strictEqual(a.supportBackdrop, '', '未指定は空文字');
    assert.strictEqual(b.supportBackdrop, code);
    assert.strictEqual(b.supportEquipment, '', '背景を supportEquipment に混ぜない');
    assert.strictEqual(b.supportEquipmentAmount, 0);
    assert.strictEqual(b.priceAmount, a.priceAmount, '金額は背景なしと同じ');
    assert.strictEqual(b.priceGeneration, a.priceGeneration);
    assert.strictEqual(b.planCode, PLAN);
  });
});

test('往復: 未知コード・複数値・配列・他ブランド／他プラン向けの指定は拒否し、Calendarにもシートにも何も書かない', function () {
  var ctx = setup();
  [
    { supportBackdrop: 'BACKDROP_NOPE' },
    { supportBackdrop: 'BACKDROP_CLOTH_WHITE,BACKDROP_GRUNGE' },
    { supportBackdrop: ['BACKDROP_CLOTH_WHITE'] },
    { supportBackdrop: 'WHITE_BACKDROP' }
  ].forEach(function (extra) {
    var r = book(ctx, extra);
    assert.strictEqual(r.success, false, JSON.stringify(extra));
    assert.ok(['UNKNOWN_SUPPORT_BACKDROP', 'INVALID_SUPPORT_BACKDROP'].indexOf(r.error.code) !== -1, JSON.stringify(r));
  });
  assert.strictEqual(heldEvents(ctx), 0, '拒否した申込は仮押さえを作らない');
  var normal = book(ctx, { plan: '', supportServices: undefined, paymentMethod: '現金', supportBackdrop: 'BACKDROP_CLOTH_WHITE', startTime: '18:00', durationMinutes: 60 });
  assert.strictEqual(normal.success, false);
  assert.strictEqual(heldEvents(ctx), 0);
  var snb = ctx.sandbox.BookingRepository.createBooking(payload({ brand: 'snb', plan: '', supportServices: undefined, paymentMethod: '現金', supportBackdrop: 'BACKDROP_CLOTH_WHITE' }), NOW);
  assert.strictEqual(snb.success, false);
  assert.strictEqual(heldEvents(ctx), 0);
});

test('往復: 旧予約（列が無い／空）は背景なしとして読め、保存済みの料金・選択を変更しない', function () {
  var ctx = setup();
  var r = book(ctx, { supportEquipment: { COB_BICOLOR: 1 } });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  var before = clone(record(ctx, r.bookingId));
  assert.strictEqual(before.supportBackdrop, '');
  /* 列が無い旧シートの行（短い行）を読んでも落ちず、空欄として扱う。 */
  var H = ctx.sandbox.BookingsSchema.HEADERS;
  var shortRow = H.map(function (h) { return before[h] === undefined ? '' : before[h]; }).slice(0, H.length - 1);
  var rec = {};
  H.forEach(function (h, i) { rec[h] = shortRow[i]; });
  assert.strictEqual(rec.supportBackdrop, undefined);
  assert.strictEqual(ctx.sandbox.BookingOptions.describeSupportBackdrop(rec.supportBackdrop), '');
  var after = record(ctx, r.bookingId);
  assert.strictEqual(after.priceAmount, before.priceAmount);
  assert.strictEqual(after.supportEquipment, before.supportEquipment);
});

test('メール: 受付・承認案内に希望背景を示し、確保されない旨・片付けのみのセルフ設営・スタンド明示選択を明記。背景なしの予約には何も足さない', function () {
  var ctx = setup();
  var none = book(ctx, { supportServices: 'CLEANUP' });
  assert.strictEqual(none.success, true);
  var noneMail = ctx.mailApp._sentEmails.filter(function (m) { return m.subject.indexOf('承認待ち') !== -1; })[0];
  assert.ok(noneMail.body.indexOf('希望背景') === -1 && noneMail.body.indexOf('背景の設置') === -1, '旧予約・背景なしの本文は変わらない');

  var r = book(ctx, { supportServices: 'CLEANUP', supportBackdrop: 'BACKDROP_TSURU_BLACK', startTime: '15:00' });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  var mails = ctx.mailApp._sentEmails.filter(function (m) { return m.subject.indexOf('承認待ち') !== -1; });
  var received = mails[mails.length - 1];
  ['希望背景: 和柄背景（鶴・黒）', '申込時点では確保されません', '対応可否を確認後にご案内します', '背景の設置: ご自身で行っていただきます', '事前設営は含まれません', '事前設営料金は加算されません', '背景スタンド（200円）は、機材として明示的に選択した場合のみ加算'].forEach(function (t) {
    assert.ok(received.body.indexOf(t) !== -1, t + '\n' + received.body);
  });
  var rec = record(ctx, r.bookingId);
  var ok = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date('2026-12-06T09:00:00+09:00'), { backdropChecked: true, setupGuidanceDone: true });
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  var approved = ctx.mailApp._sentEmails[ctx.mailApp._sentEmails.length - 1];
  assert.ok(approved.body.indexOf('希望背景: 和柄背景（鶴・黒）') !== -1, approved.body);
  assert.strictEqual(rec.priceAmount, record(ctx, r.bookingId).priceAmount);
});

test('メール: 事前設営を含む申込では「片付けのみ」のセルフ設営文言を出さない', function () {
  var ctx = setup();
  var r = book(ctx, { supportServices: 'BOTH', supportBackdrop: 'BACKDROP_CLOTH_BLACK' });
  assert.strictEqual(r.success, true);
  var received = ctx.mailApp._sentEmails.filter(function (m) { return m.subject.indexOf('承認待ち') !== -1; })[0];
  assert.ok(received.body.indexOf('希望背景: 黒背景布') !== -1);
  assert.ok(received.body.indexOf('背景の設置: ご自身で') === -1);
});

// ============================================================================
// 承認前の運営確認（共有背景は自動予約しない）
// ============================================================================

test('承認: 背景の希望がある申込は、運営の現物・利用可否・競合の確認（backdropChecked）が無ければ承認できず、決済案内も出ない', function () {
  var ctx = setup();
  var r = book(ctx, { supportBackdrop: 'BACKDROP_CLOTH_WHITE' });
  assert.strictEqual(r.success, true);
  var sentBefore = ctx.mailApp._sentEmails.length;
  [undefined, {}, { backdropChecked: false }, { backdropChecked: 'true' }, { setupGuidanceDone: true }].forEach(function (c) {
    var res = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date('2026-12-06T09:00:00+09:00'), c);
    assert.strictEqual(res.success, false, JSON.stringify(c));
    assert.strictEqual(res.error.code, 'BACKDROP_CONFIRMATION_REQUIRED');
    assert.ok(res.error.message.indexOf('白背景布') !== -1);
  });
  assert.strictEqual(record(ctx, r.bookingId).supportApprovedAt, '', '承認が記録されない（支払い期限も作られない）');
  assert.strictEqual(ctx.mailApp._sentEmails.length, sentBefore, '承認案内メール（決済案内）を送らない');
  var ok = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date('2026-12-06T09:00:00+09:00'), { backdropChecked: true });
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  assert.strictEqual(ok.supportStage, 'AWAITING_PAYMENT');
  /* 承認済みの再承認は確認なしで冪等（期限を延長しない）。 */
  var again = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date('2026-12-06T10:00:00+09:00'));
  assert.strictEqual(again.success, true);
  assert.strictEqual(again.alreadyApproved, true);
});

test('承認: 和柄（運用文言が未整備）は、利用者自身が設置・片付けする部分があるとき、案内完了（setupGuidanceDone）まで承認しない。事前設営＋片付けの両方をスタッフが行う場合は不要', function () {
  JAPANESE.forEach(function (code) {
    ['SETUP', 'CLEANUP'].forEach(function (services) {
      var ctx = setup();
      var r = book(ctx, { supportBackdrop: code, supportServices: services });
      assert.strictEqual(r.success, true, code + services + JSON.stringify(r));
      var at = new Date('2026-12-06T09:00:00+09:00');
      var denied = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, at, { backdropChecked: true });
      assert.strictEqual(denied.success, false, code + services);
      assert.strictEqual(denied.error.code, 'BACKDROP_GUIDANCE_REQUIRED');
      assert.strictEqual(record(ctx, r.bookingId).supportApprovedAt, '');
      var ok = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, at, { backdropChecked: true, setupGuidanceDone: true });
      assert.strictEqual(ok.success, true, JSON.stringify(ok));
    });
    var ctxBoth = setup();
    var both = book(ctxBoth, { supportBackdrop: code, supportServices: 'BOTH' });
    var okBoth = ctxBoth.sandbox.BookingRepository.approvePhotoSupport(both.bookingId, new Date('2026-12-06T09:00:00+09:00'), { backdropChecked: true });
    assert.strictEqual(okBoth.success, true, '両方スタッフ対応なら利用者のセルフ作業が無い: ' + JSON.stringify(okBoth));
  });
});

test('承認: 白黒布・グランジは確定済みの案内があるため、案内完了の確認は不要（現物確認は必要）', function () {
  ['BACKDROP_CLOTH_WHITE', 'BACKDROP_CLOTH_BLACK', 'BACKDROP_GRUNGE'].forEach(function (code) {
    var ctx = setup();
    var r = book(ctx, { supportBackdrop: code, supportServices: 'CLEANUP' });
    assert.strictEqual(r.success, true);
    var ok = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date('2026-12-06T09:00:00+09:00'), { backdropChecked: true });
    assert.strictEqual(ok.success, true, code + JSON.stringify(ok));
  });
});

test('承認: 背景なしの申込・旧予約は従来どおり確認なしで承認できる', function () {
  var ctx = setup();
  var r = book(ctx, {});
  var ok = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date('2026-12-06T09:00:00+09:00'));
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
});

test('管理画面: 希望背景の表示名・自己設置の有無・運用文言の整備状況・スタンド選択を同じ正本から返す。旧予約は空', function () {
  var ctx = setup({ admin: true });
  var sandbox = ctx.sandbox;
  var base = { planCode: PLAN, status: 'PENDING', supportServices: 'CLEANUP', supportRoomAmount: 4500, supportStaffAmount: 3000, supportApprovedAt: '', supportPaymentDueAt: '', supportApprovalMailSentAt: '', membershipStatus: 'ACTIVE' };
  var tsuru = sandbox.buildAdminPhotoSupportFields_(Object.assign({}, base, { supportBackdrop: 'BACKDROP_TSURU_BLACK' }), 'Asia/Tokyo');
  assert.strictEqual(tsuru.supportBackdrop, 'BACKDROP_TSURU_BLACK');
  assert.strictEqual(tsuru.supportBackdropLabel, '和柄背景（鶴・黒）');
  assert.strictEqual(tsuru.supportBackdropGuidanceReady, false, 'Adminで未整備と分かる');
  assert.strictEqual(tsuru.supportBackdropSelfWork, true, '片付けのみ＝設置は利用者');
  assert.strictEqual(tsuru.supportBackdropStandSelected, false);
  var black = sandbox.buildAdminPhotoSupportFields_(Object.assign({}, base, { supportServices: 'BOTH', supportBackdrop: 'BACKDROP_CLOTH_BLACK', supportEquipment: 'EQ:BACKGROUND_STAND:1' }), 'Asia/Tokyo');
  assert.strictEqual(black.supportBackdropLabel, '黒背景布');
  assert.strictEqual(black.supportBackdropGuidanceReady, true);
  assert.strictEqual(black.supportBackdropSelfWork, false);
  assert.strictEqual(black.supportBackdropStandSelected, true);
  var legacy = sandbox.buildAdminPhotoSupportFields_(base, 'Asia/Tokyo');
  assert.strictEqual(legacy.supportBackdrop, '');
  assert.strictEqual(legacy.supportBackdropLabel, '');
  assert.strictEqual(legacy.supportBackdropGuidanceReady, true);
  /* 管理画面クライアント: 行の表示・承認前の確認ダイアログ・確認結果の送信。 */
  var admin = read('admin/booking/booking-admin.js');
  assert.ok(admin.indexOf("['supportBackdropLabel', '希望背景（作品撮りサポート）']") !== -1);
  assert.ok(admin.indexOf('confirmations.backdropChecked = true') !== -1 && admin.indexOf('confirmations.setupGuidanceDone = true') !== -1);
  assert.ok(admin.indexOf('.adminApprovePhotoSupport(bookingId, confirmations)') !== -1);
  assert.ok(read('gas/booking/admin/BookingAdminWeb.gs').indexOf('backdropChecked: confirmations.backdropChecked === true') !== -1, '真偽値の true だけを通す');
});

// ============================================================================
// フロント
// ============================================================================

test('フロント: 送信ペイロードは作品撮りサポートでだけ supportBackdrop（背景コード1件。未指定は空文字）を送り、料金・機材のキーには混ぜない', function () {
  var base = { brand: 'mens', customerType: 'returning', date: SATURDAY, startTime: '10:00', durationMinutes: 180, name: 'a', email: EMAIL, people: '2名', purpose: 'x', paymentMethod: CARD, plan: PLAN, supportServices: 'SETUP' };
  assert.strictEqual(Logic.buildCreateBookingPayload(base).supportBackdrop, '', '未指定は空文字');
  var p = Logic.buildCreateBookingPayload(Object.assign({}, base, { supportBackdrop: 'BACKDROP_ASANOHA_INDIGO', supportEquipment: { STAND_260: 1 } }));
  assert.strictEqual(p.supportBackdrop, 'BACKDROP_ASANOHA_INDIGO');
  assert.deepStrictEqual(p.supportEquipment, { STAND_260: 1 });
  var normal = Logic.buildCreateBookingPayload(Object.assign({}, base, { plan: '', supportBackdrop: 'BACKDROP_ASANOHA_INDIGO' }));
  assert.strictEqual('supportBackdrop' in normal, false, '作品撮りサポート以外には付けない');
});

test('フロント文言: 確保されない旨・片付けのみのセルフ設営・スタンド明示選択（単価はカタログ値）・和柄の案内待ちを示す。未確認の寸法・手順を創作しない', function () {
  var tsuruInfo = { code: 'BACKDROP_TSURU_BLACK', selfSetupGuidanceReady: false };
  var lines = Logic.photoBackdropNoticeLines('CLEANUP', tsuruInfo, { unitPriceJpy: 200 });
  var text = lines.join('\n');
  ['申込時点では確保されません', '対応可否を確認後にご案内します', '先に確定しているご利用を優先', '別の背景へ自動では変更しません', '背景の設置はご自身で行っていただきます', '事前設営は含まれません', '事前設営の料金は加算されません', '運営がお申し込み後にご案内します', '背景スタンド（200円）は、背景を選んだだけでは追加されません', '無料で設置できると約束するものではありません'].forEach(function (t) {
    assert.ok(text.indexOf(t) !== -1, t);
  });
  var white = Logic.photoBackdropNoticeLines('BOTH', { code: 'BACKDROP_CLOTH_WHITE', selfSetupGuidanceReady: true }, null).join('\n');
  assert.ok(white.indexOf('背景の設置はご自身で') === -1 && white.indexOf('運営がお申し込み後にご案内') === -1);
  assert.ok(white.indexOf('申込時点では確保されません') !== -1);
  assert.ok(!/(cm|㎝|枚|在庫|収納)/.test(text), '寸法・在庫・収納場所を創作しない');
  /* 確認画面の撮影環境欄。 */
  var confirm = Logic.photoSupportConfirmLines({ services: 'CLEANUP', equipmentLines: ['ストロボ ×1'], backdropLabel: '和柄背景（鶴・黒）' }).join('\n');
  ['スタッフ対応：片付け（3,000円）', '機材：ストロボ ×1', '背景：和柄背景（鶴・黒）', '片付けのみ', '事前設営は含まれません'].forEach(function (t) { assert.ok(confirm.indexOf(t) !== -1, t); });
  assert.ok(Logic.photoSupportConfirmLines({ services: 'BOTH', equipmentLines: [], backdropLabel: '' }).join('\n').indexOf('背景：希望なし') !== -1);
});

test('フロント: 予約フォーム（mens）に「背景を選ぶ」欄・照明3問・個別調整の欄がある。見本画像はサイト内のwebpだけ。SX・SNB一般には出さない', function () {
  var inc = read('_includes/booking_app_ja.html');
  var block = inc.slice(inc.indexOf('{% if include.brand == "mens" %}\n    <!-- Issue #667'), inc.indexOf('id="ba-photo-support-terms"'));
  ['id="ba-photo-support-lighting"', 'id="ba-photo-support-backdrop"', 'id="ba-photo-support-backdrop-list"', 'role="radiogroup"', '機材を個別に選ぶ／調整する', '幅135cmの背景紙ロールとは別', '背景だけの料金や背景紙の料金はありません', '3つの質問'].forEach(function (t) {
    assert.ok(block.indexOf(t) !== -1, t);
  });
  assert.strictEqual(inc.split('id="ba-photo-support-backdrop"').length - 1, 1, 'mens条件内の1か所だけ');
  assert.ok(inc.indexOf('{% if include.brand == "mens" %}<tr id="ba-confirm-photo-row"') !== -1, '確認画面の撮影環境欄もmensだけ');
  var app = read('scripts/booking-app.js');
  ['supportBackdrop: photoSupportBackdrop_()', 'mountLightingGuide', "input.name = 'supportBackdrop'", 'photoBackdropCatalog_ = Array.isArray(backdrops) ? backdrops : []', 'Logic.photoSupportConfirmLines'].forEach(function (t) {
    assert.ok(app.indexOf(t) !== -1, t);
  });
  assert.ok(app.indexOf('/^images\\/[A-Za-z0-9_-]+\\.webp$/') !== -1, '見本画像は images/ 配下のwebpだけ');
  assert.ok(!/backdrop-color-white/.test(app + inc + read('_data/studio_x_equipment.json')), '紙の写真（backdrop-color-white）を布の見本に流用しない');
  var mens = read('mens/booking/index.html');
  assert.ok(mens.indexOf('booking-options.js') < mens.indexOf('booking-app.js'));
  ['booking/index.html', 'booking/en.html'].forEach(function (rel) {
    assert.ok(read(rel).indexOf('booking-options') === -1, rel);
  });
});

// ============================================================================
// 照明3問（SXと同じロジックの共有）
// ============================================================================

var SX_CATALOG = clone(loadPricing().BookingOptions.buildCatalog('studio_x', {}));
var MENS_CATALOG = { equipment: clone(loadPricing().BookingOptions.buildCatalog('mens', {}).supportEquipment) };

function eachChoice(fn) {
  ['STROBE', 'VIDEO'].forEach(function (kind) {
    ['1', '2'].forEach(function (count) {
      ['OFF', 'ON'].forEach(function (softbox) { fn({ kind: kind, count: count, softbox: softbox }); });
    });
  });
}

test('3問: 質問・選択肢はSXと同じ LIGHTING_STEPS（光の種類／灯数／ソフトボックス）。mens用の別の対応表を持たない', function () {
  assert.deepStrictEqual(Panel.LIGHTING_STEPS.map(function (s) { return s.key; }), ['kind', 'count', 'softbox']);
  assert.deepStrictEqual(Panel.LIGHTING_STEPS[0].options.map(function (o) { return o.value; }), ['STROBE', 'VIDEO']);
  assert.deepStrictEqual(Panel.LIGHTING_STEPS[1].options.map(function (o) { return o.value; }), ['1', '2']);
  assert.deepStrictEqual(Panel.LIGHTING_STEPS[2].options.map(function (o) { return o.value; }), ['OFF', 'ON']);
  assert.strictEqual(Object.keys(Panel.LIGHTING_RESULT_TEXT).length, 8);
  var app = read('scripts/booking-app.js');
  assert.ok(app.indexOf('LIGHTING_STEPS') === -1 && app.indexOf('lightingPresetItems') === -1, 'booking-app.js に3問の定義・対応表を複製しない');
  assert.strictEqual(typeof Panel.mountLightingGuide, 'function');
  assert.strictEqual(typeof Panel.buildLightingSection, 'function');
});

test('3問: 8通りの構成が、mensの共通カタログでもSXと同じ機材・同じ合計金額（セット無料を反映）・在庫判定になる', function () {
  var seen = 0;
  eachChoice(function (choice) {
    var items = Panel.lightingPresetItems(choice);
    assert.ok(items, JSON.stringify(choice));
    assert.deepStrictEqual(Panel.lightingPresetShortage(MENS_CATALOG, items), [], '在庫不足なし: ' + JSON.stringify(choice));
    assert.strictEqual(Panel.equipmentTotalJpy(MENS_CATALOG, items), Panel.equipmentTotalJpy(SX_CATALOG, items), 'SXと同額: ' + JSON.stringify(choice));
    /* サーバーの計算（正本）とも一致する。 */
    var server = loadPricing().BookingOptions.computeSupportEquipment(items);
    assert.strictEqual(server.ok, true, JSON.stringify(server));
    assert.strictEqual(server.totalJpy, Panel.equipmentTotalJpy(MENS_CATALOG, items), 'サーバー計算と一致: ' + JSON.stringify(choice));
    if (choice.kind === 'STROBE' && choice.softbox === 'ON') {
      assert.strictEqual(items.STROBE_PORTABLE, 1);
      assert.strictEqual(items.BOWENS_BRACKET, 1, 'ポータブルストロボ＋ソフトボックスはブラケット必須');
    }
    seen += 1;
  });
  assert.strictEqual(seen, 8);
});

test('3問: ストロボのCanon／Sonyコマンダーは自動選択せず任意追加。未対応機種を対応済みと断定する文言を足さない', function () {
  eachChoice(function (choice) {
    var items = Panel.lightingPresetItems(choice);
    assert.ok(!('COMMANDER_CANON' in items) && !('COMMANDER_SONY' in items), '回答だけでコマンダーを確定しない');
  });
  var commanders = MENS_CATALOG.equipment.filter(function (e) { return /^COMMANDER_/.test(e.code); }).map(function (e) { return e.label; });
  assert.deepStrictEqual(commanders, ['ワイヤレスコマンダー（Canon専用）', 'ワイヤレスコマンダー（SONY専用）']);
  var src = read('scripts/booking-options.js');
  assert.ok(src.indexOf('カメラによっては不要な場合があります') !== -1);
});

test('3問: 適用は照明機材だけを入れ替える。再適用・回答の変更で重複加算せず、背景スタンド・カラーフィルター等の他の選択は消えない', function () {
  var current = { BACKGROUND_STAND: 1, COLOR_FILTER_SET: 1, COMMANDER_CANON: 1 };
  var first = Panel.applyLightingPreset(MENS_CATALOG, current, { kind: 'STROBE', count: '2', softbox: 'ON' });
  assert.ok(first);
  assert.strictEqual(first.BACKGROUND_STAND, 1);
  assert.strictEqual(first.COLOR_FILTER_SET, 1);
  assert.strictEqual(first.COMMANDER_CANON, 1, 'コマンダーは利用者の選択のまま');
  assert.strictEqual(first.STAND_260, 2);
  /* 同じ構成の再適用は数量が増えない（重複加算しない）。 */
  assert.deepStrictEqual(Panel.applyLightingPreset(MENS_CATALOG, first, { kind: 'STROBE', count: '2', softbox: 'ON' }), first);
  /* 別構成へ変更すると前の照明が残らない。 */
  var video = Panel.applyLightingPreset(MENS_CATALOG, first, { kind: 'VIDEO', count: '1', softbox: 'OFF' });
  assert.ok(!('STROBE_PORTABLE' in video) && !('STROBE_MONOBLOCK' in video) && !('SOFTBOX_60' in video) && !('BOWENS_BRACKET' in video));
  assert.strictEqual(video.COB_BICOLOR, 1);
  assert.strictEqual(video.STAND_260, 1);
  assert.strictEqual(video.BACKGROUND_STAND, 1);
  assert.strictEqual(video.COLOR_FILTER_SET, 1);
  assert.deepStrictEqual(Object.keys(first).sort(), Object.keys(Panel.applyLightingPreset(MENS_CATALOG, first, { kind: 'STROBE', count: '2', softbox: 'ON' })).sort());
});

test('3問: 在庫不足のおすすめは黙って不完全に適用しない（null）。持ち込み利用のために照明機材だけを外せる', function () {
  var limited = clone(MENS_CATALOG);
  limited.equipment.forEach(function (e) { if (e.code === 'SOFTBOX_60') e.stock = 0; });
  var choice = { kind: 'VIDEO', count: '1', softbox: 'ON' };
  assert.deepStrictEqual(Panel.lightingPresetShortage(limited, Panel.lightingPresetItems(choice)), ['SOFTBOX_60']);
  var current = { BACKGROUND_STAND: 1 };
  assert.strictEqual(Panel.applyLightingPreset(limited, current, choice), null);
  assert.deepStrictEqual(current, { BACKGROUND_STAND: 1 }, '元の選択は変えない');
  var applied = Panel.applyLightingPreset(MENS_CATALOG, { BACKGROUND_STAND: 1, COMMANDER_SONY: 1 }, { kind: 'STROBE', count: '1', softbox: 'ON' });
  assert.deepStrictEqual(Panel.clearLightingEquipment(applied), { BACKGROUND_STAND: 1 }, '照明（コマンダー含む）だけ外し、他の選択は残す');
  assert.deepStrictEqual(Panel.clearLightingEquipment({}), {}, '機材なし・持込利用はそのまま');
});

test('3問: 回答しただけでは機材を確定しない（「この構成を選択する」を押したときだけ反映）。SXの設営方法・セルフレンタル許可・別決済はmensへコピーしない', function () {
  var src = read('scripts/booking-options.js');
  var guide = src.slice(src.indexOf('function mountLightingGuide'), src.indexOf('var api = {'));
  assert.ok(guide.length > 200);
  ['setupService', 'cleanupService', 'confirmLecture', 'PENDING_APPROVAL', 'allowEligibilityLookup', 'SEPARATE'].forEach(function (t) {
    assert.ok(guide.indexOf(t) === -1, 'mens用の3問に ' + t + ' を持ち込まない');
  });
  var section = src.slice(src.indexOf('function buildLightingSection'), src.indexOf('function clearLightingEquipment'));
  assert.ok(section.indexOf("'この構成を選択する'") !== -1);
  /* 回答（change）ハンドラは choice の更新と再描画だけで、機材（setEquipment）を呼ばない。 */
  var changeHandler = section.slice(section.indexOf("input.addEventListener('change'"), section.indexOf('options.appendChild'));
  assert.ok(changeHandler.indexOf('setEquipment') === -1);
  var inc = read('_includes/booking_app_ja.html');
  assert.ok(inc.indexOf('持ち込みの機材で撮影する場合は、何も選ばずにお進みください') !== -1, '機材なし・持込利用を残す');
});

// ============================================================================
// 運用ドキュメント（#673の本番反映手順）
// ============================================================================

test('運用: README に supportBackdrop の末尾列追加と #673 の反映順（admin-only → migrateBookingsSchema → full）が記載されている', function () {
  var readme = read('gas/booking/README.md');
  var idx = readme.indexOf('Issue #679');
  assert.ok(idx !== -1, 'Issue #679 の節がある');
  var section = readme.slice(idx);
  ['supportBackdrop', 'scope=admin-only', 'migrateBookingsSchema', 'schema_migrated=true', 'scope=full', 'BOOKINGS_SCHEMA_MIGRATION_OK', '末尾', 'supportEquipment', '既存の予約行', '和柄'].forEach(function (t) {
    assert.ok(section.indexOf(t) !== -1, t);
  });
});

// ============================================================================
// レビュー対応: セルフ作業の確定済み案内・BOTHの承認条件表示・提供範囲の文言
// ============================================================================

function receivedMailBody(ctx) {
  var mails = ctx.mailApp._sentEmails.filter(function (m) { return m.subject.indexOf('承認待ち') !== -1; });
  return mails[mails.length - 1].body;
}

test('メール案内: 確定済みの背景（白黒布・グランジ）は、サービス種別に応じて必要なセルフ作業の手順だけを既存の運用文言から届ける', function () {
  ['BACKDROP_CLOTH_WHITE', 'BACKDROP_CLOTH_BLACK', 'BACKDROP_GRUNGE'].forEach(function (code) {
    var label = LABELS[code];
    var theme = { BACKDROP_CLOTH_WHITE: '白背景布', BACKDROP_CLOTH_BLACK: '黒背景布', BACKDROP_GRUNGE: 'グランジセット' }[code];
    /* 片付けのみ: 設置は利用者。保管場所・使う備品・セット方法・注意事項を届け、原状復帰（片付け）の手順は含めない。 */
    var c1 = setup();
    assert.strictEqual(book(c1, { supportServices: 'CLEANUP', supportBackdrop: code }).success, true);
    var cleanup = receivedMailBody(c1);
    ['【' + theme + 'のセルフセッティング】', '保管場所:', '使用する備品:', 'セット方法: 背景スタンド、または竹の梁にセットして使用してください', '注意事項:'].forEach(function (t) {
      assert.ok(cleanup.indexOf(t) !== -1, code + ' CLEANUP: ' + t + '\n' + cleanup);
    });
    assert.ok(cleanup.indexOf('原状復帰の方法:') === -1, '片付けはスタッフ対応のため原状復帰の手順は届けない');
    assert.ok(label && cleanup.indexOf('運営にて内容を確認中') === -1);
    /* 事前設営のみ: 片付けは利用者。原状復帰の手順を届け、セット方法は含めない。 */
    var c2 = setup();
    assert.strictEqual(book(c2, { supportServices: 'SETUP', supportBackdrop: code }).success, true);
    var setupOnly = receivedMailBody(c2);
    assert.ok(setupOnly.indexOf('原状復帰の方法: 布に汚れ・異物がないことを確認してから畳み') !== -1 || code === 'BACKDROP_GRUNGE' || setupOnly.indexOf('原状復帰の方法:') !== -1, code + ' SETUP\n' + setupOnly);
    assert.ok(setupOnly.indexOf('セット方法:') === -1, '設置はスタッフ対応のためセット方法は届けない');
    assert.ok(setupOnly.indexOf('靴で背景布を踏まないでください') !== -1, '注意事項（既存の確定文言）');
    /* 両方スタッフ対応: セルフ作業が無いので手順を足さない。 */
    var c3 = setup();
    assert.strictEqual(book(c3, { supportServices: 'BOTH', supportBackdrop: code }).success, true);
    var both = receivedMailBody(c3);
    assert.ok(both.indexOf('セルフセッティング】') === -1 && both.indexOf('原状復帰の方法:') === -1 && both.indexOf('セット方法:') === -1, code + ' BOTH');
  });
});

test('メール案内: 承認案内メールにも、必要なセルフ作業の確定済み手順が入る（背景なしの予約は変わらない）', function () {
  var ctx = setup();
  var r = book(ctx, { supportServices: 'CLEANUP', supportBackdrop: 'BACKDROP_CLOTH_BLACK' });
  var ok = ctx.sandbox.BookingRepository.approvePhotoSupport(r.bookingId, new Date('2026-12-06T09:00:00+09:00'), { backdropChecked: true });
  assert.strictEqual(ok.success, true, JSON.stringify(ok));
  var approved = ctx.mailApp._sentEmails[ctx.mailApp._sentEmails.length - 1].body;
  assert.ok(approved.indexOf('【黒背景布のセルフセッティング】') !== -1 && approved.indexOf('セット方法:') !== -1, approved);
  var plain = setup();
  assert.strictEqual(book(plain, { supportServices: 'CLEANUP' }).success, true);
  assert.ok(receivedMailBody(plain).indexOf('セルフセッティング】') === -1);
});

test('メール案内: 和柄は運用文言が未整備のため手順を創作せず、セルフ作業があるときだけ「運営が別途案内」と伝える。BOTHでは何も足さない', function () {
  JAPANESE.forEach(function (code) {
    ['SETUP', 'CLEANUP'].forEach(function (services) {
      var ctx = setup();
      assert.strictEqual(book(ctx, { supportServices: services, supportBackdrop: code }).success, true);
      var body = receivedMailBody(ctx);
      assert.ok(body.indexOf('【' + LABELS[code] + 'のセルフ作業】設置・片付けの手順と注意事項は、運営が確認のうえ、別途メールでご案内します') !== -1, code + services + '\n' + body);
      assert.ok(body.indexOf('セット方法:') === -1 && body.indexOf('保管場所:') === -1 && body.indexOf('原状復帰の方法:') === -1, '手順を創作しない');
    });
    var both = setup();
    assert.strictEqual(book(both, { supportServices: 'BOTH', supportBackdrop: code }).success, true);
    assert.ok(receivedMailBody(both).indexOf('のセルフ作業】') === -1);
  });
  var O = loadPricing().BookingOptions;
  assert.strictEqual(O.renderSupportBackdropGuidance('BACKDROP_TSURU_BLACK', 'CLEANUP').incomplete, true);
  assert.strictEqual(O.renderSupportBackdropGuidance('BACKDROP_CLOTH_WHITE', 'CLEANUP').incomplete, false);
  assert.strictEqual(O.renderSupportBackdropGuidance('', 'CLEANUP').text, '');
  assert.strictEqual(O.renderSupportBackdropGuidance('BACKDROP_CLOTH_WHITE', 'BOTH').text, '');
});

test('画面: 「案内が済むまで承認されません」は、セルフ作業が残るSETUP／CLEANUPの和柄だけに出す。BOTHは現物・対応可否の確認のみ（サーバーの承認条件と一致）', function () {
  var pending = { code: 'BACKDROP_TSURU_BLACK', selfSetupGuidanceReady: false };
  ['SETUP', 'CLEANUP'].forEach(function (services) {
    assert.ok(Logic.photoBackdropNoticeLines(services, pending, null).join('\n').indexOf('ご案内が済むまで承認されません') !== -1, services);
  });
  var both = Logic.photoBackdropNoticeLines('BOTH', pending, null).join('\n');
  assert.ok(both.indexOf('ご案内が済むまで承認されません') === -1 && both.indexOf('運営がお申し込み後にご案内します') === -1);
  assert.ok(both.indexOf('現物・利用可否') !== -1, '現物・対応可否の確認は案内する');
  assert.ok(Logic.photoBackdropNoticeLines('', pending, null).join('\n').indexOf('ご案内が済むまで承認されません') === -1, 'スタッフ対応が未選択のうちは条件を断定しない');
  /* サーバーの承認条件との一致（BOTHは案内完了なしで承認できる）。 */
  var ctx = setup();
  var b = book(ctx, { supportServices: 'BOTH', supportBackdrop: 'BACKDROP_TSURU_BLACK' });
  assert.strictEqual(ctx.sandbox.BookingRepository.approvePhotoSupport(b.bookingId, new Date('2026-12-06T09:00:00+09:00'), { backdropChecked: true }).success, true);
});

test('提供範囲: スタッフ対応の説明は「白／黒背景」に限定せず「選択した背景」で揃え、撮影代行・施術等を含めない既存条件は保持する', function () {
  ['_includes/booking_app_ja.html', '_includes/mens_photo_support_ja.html', '_includes/legal_ja.html', 'gas/booking/shared/BookingMailTemplates.gs'].forEach(function (rel) {
    var src = read(rel);
    assert.ok(src.indexOf('白／黒背景を使った') === -1, rel + ' に「白／黒背景を使った」が残っている');
    assert.ok(src.indexOf('選択した背景') !== -1, rel);
  });
  var legal = read('_includes/legal_ja.html');
  assert.ok(legal.indexOf('グランジ等、SNB mensで提供可否を確認していない') === -1, 'グランジを提供範囲外と読ませない');
  ['吊り設備の組み替え', '緊縛の施術・指導', '撮影代行', '当日の常駐スタッフ対応は含みません'].forEach(function (t) { assert.ok(legal.indexOf(t) !== -1, t); });
  var mail = read('gas/booking/shared/BookingMailTemplates.gs');
  assert.ok(mail.indexOf('撮影代行・緊縛の施術や指導・吊り設備の組み替えは含みません') !== -1);
});
