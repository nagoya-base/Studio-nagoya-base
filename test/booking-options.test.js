/*
 * BookingOptions.gs（Issue #423。Studio X限定の予約オプションの純粋ロジック）のテスト。
 * 確定要件（Issue本文＋追加コメント3件）をそのままテスト名にしている:
 * 事前設営3,000円 / 片付け3,000円 / 設営＋片付け5,000円（両方選択時に6,000円と誤計算しない）、
 * 5テーマ共通料金、スタッフ対応は必ずPENDING_APPROVAL、セルフは無料・承認不要、
 * 有料レンタル機材全件（ビデオライト・ストロボ・ソフトボックス・背景スタンド等）はAdmin許可者のみ、機材は個別加算（数量×単価）・在庫超過は拒否。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var sandbox = loadBookingSandbox(['EquipmentCatalog.gs', 'BookingOptions.gs'], {});
var BookingOptions = sandbox.BookingOptions;

var CONFIG_WITH_PRICES = { addonDeadlineHoursBeforeStart: '' };
var ALL_RENTAL_CODES = sandbox.StudioXEquipmentCatalog.rental.map(function (e) { return e.code; });
var ELIGIBLE = { eligibleEquipmentCodes: ALL_RENTAL_CODES };
var NOT_ELIGIBLE = { eligibleEquipmentCodes: [] };

function select(overrides) {
  var r = BookingOptions.normalizeSelection(Object.assign({}, overrides));
  assert.ok(r.ok, JSON.stringify(r.error));
  return r.normalized;
}

function plan(selection, extra) {
  var e = extra || {};
  return BookingOptions.planOrders({
    normalized: selection,
    existingOrders: e.existingOrders || [],
    optionsConfig: e.config || CONFIG_WITH_PRICES,
    eligibility: e.eligibility || ELIGIBLE
  });
}

/* vmサンドボックス由来の配列はrealmが異なりdeepStrictEqualが失敗するため、JSON経由で比較する。 */
function plain(value) { return JSON.parse(JSON.stringify(value)); }

var THEMES = ['CLASSROOM', 'JAPANESE', 'GRUNGE', 'WHITE_BACKDROP', 'BLACK_BACKDROP'];

// ---- ブランド・カタログ ----

test('初期リリースはStudio Xのみ: SNB / mensではカタログが無効', function () {
  assert.strictEqual(BookingOptions.isBrandEnabled('studio_x'), true);
  assert.strictEqual(BookingOptions.isBrandEnabled('snb'), false);
  assert.strictEqual(BookingOptions.isBrandEnabled('mens'), false);
  assert.strictEqual(BookingOptions.buildCatalog('snb', CONFIG_WITH_PRICES).enabled, false);
  assert.strictEqual(BookingOptions.buildCatalog('mens', CONFIG_WITH_PRICES).enabled, false);
});

test('カタログ: スタッフ対応料金は3,000/3,000/5,000円、5テーマ、機材は個別単価・在庫つき', function () {
  var c = BookingOptions.buildCatalog('studio_x', CONFIG_WITH_PRICES);
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.staffServices.PRE_SETUP.priceJpy, 3000);
  assert.strictEqual(c.staffServices.CLEANUP.priceJpy, 3000);
  assert.strictEqual(c.staffServices.BOTH.priceJpy, 5000);
  assert.deepStrictEqual(plain(c.themes.map(function (t) { return t.code; })), THEMES);
  var byCode = {};
  c.equipment.forEach(function (e) { byCode[e.code] = e; });
  assert.strictEqual(byCode.COB_BICOLOR.unitPriceJpy, 800);
  assert.strictEqual(byCode.COB_BICOLOR.requiresLecture, true);
  assert.strictEqual(byCode.COB_FULLCOLOR.stock, 2);
  assert.strictEqual(byCode.STAND_260.stock, 3);
  assert.strictEqual(byCode.STROBE_MONOBLOCK.requiresLecture, true, 'ストロボも施錠管理の有料レンタル機材としてAdmin許可制');
  assert.strictEqual(byCode.BACKGROUND_STAND.unitPriceJpy, 200, '背景スタンドは無料ではなく200円（Issue #430）');
  assert.strictEqual(byCode.BACKDROP_CLOTH_WHITE, undefined, '背景布は無料セルフ設営(テーマ)から選ぶ。機材欄には出さない');
});

test('機材カタログ: Issue追加要件の個別料金・数量と完全に一致する', function () {
  var expected = {
    COB_BICOLOR: [1, 800], PANEL_FULLCOLOR: [1, 500], COB_FULLCOLOR: [2, 1000], STROBE_MONOBLOCK: [1, 800], STROBE_PORTABLE: [1, 1000],
    BACKGROUND_STAND: [1, 200], COMMANDER_CANON: [1, 300], COMMANDER_SONY: [1, 300], STAND_260: [3, 200], BOWENS_BRACKET: [1, 200],
    SOFTBOX_STRIP_60X90: [1, 300], SOFTBOX_STRIP_30X120: [2, 300], SOFTBOX_60: [1, 300], COLOR_FILTER_SET: [1, 200]
  };
  var actual = {};
  plain(sandbox.StudioXEquipmentCatalog.rental).forEach(function (e) { actual[e.code] = [e.stock, e.unitPriceJpy]; });
  assert.deepStrictEqual(actual, expected);
  // 有料レンタル機材は全件施錠管理で、Adminの利用許可を要する（Issue #430）
  assert.ok(plain(sandbox.StudioXEquipmentCatalog.rental).every(function (e) { return e.requiresLecture === true; }));
});

// ---- 入力の正規化 ----

test('normalizeSelection: 未指定・空は何も選ばれていない扱い', function () {
  assert.strictEqual(BookingOptions.normalizeSelection(undefined).empty, true);
  assert.strictEqual(BookingOptions.normalizeSelection(null).empty, true);
  assert.strictEqual(BookingOptions.normalizeSelection({}).empty, true);
});

test('normalizeSelection: 未知のコード・型違い・金額フィールドの注入はfail-closed', function () {
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { LASER: 1 } }).error.code, 'UNKNOWN_OPTION');
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { BACKDROP_CLOTH_WHITE: 1 } }).error.code, 'UNKNOWN_OPTION', '背景布は機材欄からは選べない(テーマで選ぶ)');
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { STAND_260: -1 } }).error.code, 'INVALID_OPTIONS');
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { STAND_260: '2' } }).error.code, 'INVALID_OPTIONS');
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { STAND_260: 4 } }).error.code, 'STOCK_EXCEEDED');
  assert.strictEqual(BookingOptions.normalizeSelection({ layouts: ['TATAMI'] }).error.code, 'UNKNOWN_OPTION');
  assert.strictEqual(BookingOptions.normalizeSelection('VIDEO_LIGHT').error.code, 'INVALID_OPTIONS');
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: ['STAND_260'] }).error.code, 'INVALID_OPTIONS');
  assert.strictEqual(BookingOptions.normalizeSelection({ layouts: ['CLASSROOM'], setupService: 'FREE' }).error.code, 'INVALID_OPTIONS');
  assert.strictEqual(BookingOptions.normalizeSelection({ emailSupport: 'yes' }).error.code, 'INVALID_OPTIONS');
  // 金額はクライアントから受け取らない（無視され、結果に現れない）
  var r = BookingOptions.normalizeSelection({ layouts: ['CLASSROOM'], setupService: 'STAFF', amountJpy: 1, price: 1 });
  assert.ok(r.ok);
  assert.strictEqual(r.normalized.amountJpy, undefined);
});

test('テーマ未選択でスタッフ対応だけ指定は拒否、複数テーマでのスタッフ対応も拒否（共通料金の1回分）', function () {
  assert.strictEqual(
    BookingOptions.normalizeSelection({ setupService: 'STAFF' }).error.code, 'LAYOUT_REQUIRED_FOR_STAFF_SERVICE');
  assert.strictEqual(
    BookingOptions.normalizeSelection({ layouts: ['CLASSROOM', 'GRUNGE'], setupService: 'STAFF' }).error.code, 'STAFF_SERVICE_SINGLE_THEME');
  // セルフなら複数テーマ可
  assert.ok(BookingOptions.normalizeSelection({ layouts: ['CLASSROOM', 'GRUNGE'] }).ok);
});

// ---- 有料スタッフ対応: 共通料金・承認制 ----

THEMES.forEach(function (theme) {
  test('スタッフ対応の料金は5テーマ共通: ' + theme + ' 事前設営3,000 / 片付け3,000 / セット5,000、必ずPENDING_APPROVAL', function () {
    [['STAFF', 'SELF', 3000], ['SELF', 'STAFF', 3000], ['STAFF', 'STAFF', 5000]].forEach(function (c) {
      var r = plan(select({ layouts: [theme], setupService: c[0], cleanupService: c[1] }));
      assert.ok(r.ok);
      var staff = r.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; });
      assert.strictEqual(staff.length, 1);
      assert.strictEqual(staff[0].amountJpy, c[2], theme + ' ' + c[0] + '/' + c[1]);
      assert.strictEqual(staff[0].status, 'PENDING_APPROVAL');
      assert.strictEqual(staff[0].approvalStatus, 'PENDING_APPROVAL');
      assert.strictEqual(staff[0].paymentStatus, 'NOT_STARTED');
    });
  });
});

test('設営＋片付けの両方選択は5,000円（3,000+3,000=6,000円と誤計算しない）', function () {
  var r = plan(select({ layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'STAFF' }));
  var staff = r.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0];
  assert.strictEqual(staff.amountJpy, 5000);
  assert.notStrictEqual(staff.amountJpy, 6000);
  assert.deepStrictEqual(plain(staff.items.sort()), ['STAFF_CLEANUP:CLASSROOM', 'STAFF_PRE_SETUP:CLASSROOM']);
});

test('後付けでも共通料金ルールを適用（運営確定のA案）: 事前設営(3,000)申込済みに片付けだけ足すと2,000円、通算でセット5,000円', function () {
  var r = plan(select({ layouts: ['GRUNGE'], setupService: 'NONE', cleanupService: 'STAFF' }), {
    existingOrders: [{ status: 'CONFIRMED', items: ['STAFF_PRE_SETUP:GRUNGE'] }]
  });
  assert.ok(r.ok, JSON.stringify(r.error));
  assert.strictEqual(r.orders.length, 1);
  assert.strictEqual(r.orders[0].amountJpy, 2000);
  assert.strictEqual(r.orders[0].status, 'PENDING_APPROVAL');
  assert.deepStrictEqual(plain(r.orders[0].items), ['STAFF_CLEANUP:GRUNGE']);
  // 同じ設営を再度スタッフ依頼すると重複
  var dup = plan(select({ layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'NONE' }), {
    existingOrders: [{ status: 'CONFIRMED', items: ['STAFF_PRE_SETUP:GRUNGE'] }]
  });
  assert.strictEqual(dup.error.code, 'DUPLICATE_OPTION');
  // 既存がスタッフ設営なのにセルフ設営を足すのは矛盾
  var conflict = plan(select({ layouts: ['GRUNGE'], setupService: 'SELF', cleanupService: 'STAFF' }), {
    existingOrders: [{ status: 'CONFIRMED', items: ['STAFF_PRE_SETUP:GRUNGE'] }]
  });
  assert.strictEqual(conflict.error.code, 'SERVICE_MODE_CONFLICT');
  // 直接の差額計算
  var charge = BookingOptions.computeStaffServiceCharge(['PRE_SETUP'], 'GRUNGE', ['CLEANUP'], 'GRUNGE');
  assert.strictEqual(charge.amountJpy, 2000);
  assert.strictEqual(charge.totalAfterJpy, 5000);
});

test('設営・片付けとも「追加しない」ならテーマを選んでも注文は作られない', function () {
  var r = plan(select({ layouts: ['GRUNGE'], setupService: 'NONE', cleanupService: 'NONE' }));
  assert.ok(r.ok);
  assert.strictEqual(r.orders.length, 0);
});

test('既存と同じスタッフ対応の重複・別テーマへの追加は拒否', function () {
  var dup = BookingOptions.computeStaffServiceCharge(['PRE_SETUP'], 'GRUNGE', ['PRE_SETUP'], 'GRUNGE');
  assert.strictEqual(dup.error.code, 'DUPLICATE_OPTION');
  var other = BookingOptions.computeStaffServiceCharge(['PRE_SETUP'], 'GRUNGE', ['CLEANUP'], 'CLASSROOM');
  assert.strictEqual(other.error.code, 'STAFF_SERVICE_THEME_MISMATCH');
});

test('取消・不承認の既存注文は重複判定に含めない（再申込できる）', function () {
  var r = plan(select({ layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'SELF' }), {
    existingOrders: [{ status: 'DECLINED', items: ['STAFF_PRE_SETUP:CLASSROOM'] }, { status: 'CANCELLED', items: ['SELF_CLEANUP:CLASSROOM'] }]
  });
  assert.ok(r.ok);
});

// ---- 無料セルフ・メールサポート ----

test('セルフ設営・セルフ原状復帰・メールサポートは無料・承認不要・課金対象外で即CONFIRMED', function () {
  var r = plan(select({ layouts: ['WHITE_BACKDROP'], emailSupport: true }));
  assert.ok(r.ok);
  assert.strictEqual(r.orders.length, 1);
  var free = r.orders[0];
  assert.strictEqual(free.category, 'FREE');
  assert.strictEqual(free.amountJpy, 0);
  assert.strictEqual(free.approvalStatus, 'NOT_REQUIRED');
  assert.strictEqual(free.paymentStatus, 'NOT_REQUIRED');
  assert.strictEqual(free.status, 'CONFIRMED');
  assert.deepStrictEqual(plain(free.items.sort()), ['EMAIL_SUPPORT', 'SELF_CLEANUP:WHITE_BACKDROP', 'SELF_SETUP:WHITE_BACKDROP']);
  assert.strictEqual(BookingOptions.isPayable({ amountJpy: 0, approvalStatus: 'NOT_REQUIRED', status: 'CONFIRMED' }), false);
});

test('同じセルフ項目の重複追加は拒否', function () {
  var r = plan(select({ layouts: ['CLASSROOM'] }), { existingOrders: [{ status: 'CONFIRMED', items: ['SELF_SETUP:CLASSROOM', 'SELF_CLEANUP:CLASSROOM'] }] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'DUPLICATE_OPTION');
  var r2 = plan(select({ emailSupport: true }), { existingOrders: [{ status: 'CONFIRMED', items: ['EMAIL_SUPPORT'] }] });
  assert.strictEqual(r2.error.code, 'DUPLICATE_OPTION');
});

test('同じテーマの設営をセルフとスタッフで同時に選ぶ矛盾は拒否（無料と有料を混同させない）', function () {
  var r = plan(select({ layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'SELF' }), {
    existingOrders: [{ status: 'CONFIRMED', items: ['SELF_SETUP:CLASSROOM'] }]
  });
  assert.strictEqual(r.error.code, 'SERVICE_MODE_CONFLICT');
});

// ---- 有料機材（個別加算・在庫・資格） ----

test('機材は1点ごとの個別加算（数量×単価）。承認不要・決済待ち（AWAITING_PAYMENT）の注文になる', function () {
  var r = plan(select({ equipment: { STROBE_MONOBLOCK: 1, STAND_260: 2, SOFTBOX_60: 1, COMMANDER_CANON: 1 }, setupService: 'SELF' }));
  assert.ok(r.ok, JSON.stringify(r.error));
  var eq = r.orders[0];
  assert.strictEqual(eq.category, 'EQUIPMENT');
  assert.strictEqual(eq.amountJpy, 800 + 200 + 300 + 300, 'ストロボとセットのライトスタンド2本のうち1本は無料（相手機材1点につき1本まで）、残り1本は200円');
  assert.strictEqual(eq.approvalStatus, 'NOT_REQUIRED');
  assert.strictEqual(eq.paymentStatus, 'NOT_STARTED');
  assert.strictEqual(eq.status, 'AWAITING_PAYMENT');
  assert.deepStrictEqual(plain(eq.items.sort()), ['EQ:COMMANDER_CANON:1', 'EQ:SOFTBOX_60:1', 'EQ:STAND_260:2:F1', 'EQ:STROBE_MONOBLOCK:1']);
});

test('複数台の機材は数量×単価: フルカラーCOB 2台=2,000円、ライトスタンド3本（単独）=600円', function () {
  assert.strictEqual(plan(select({ equipment: { COB_FULLCOLOR: 2 }, setupService: 'SELF' })).orders[0].amountJpy, 2000);
  assert.strictEqual(plan(select({ equipment: { STAND_260: 3 }, setupService: 'SELF' })).orders[0].amountJpy, 600);
  assert.strictEqual(plan(select({ equipment: { COB_FULLCOLOR: 1, STAND_260: 1 }, setupService: 'SELF' })).orders[0].amountJpy, 1000, 'ライトとセットのスタンドは無料');
});

test('在庫数を超える申込は拒否（既存の有効な注文の数量も合算）。不承認・取消の注文は在庫を占有しない', function () {
  var overNew = plan(select({ equipment: { STAND_260: 3 }, setupService: 'SELF' }), { existingOrders: [{ status: 'AWAITING_PAYMENT', items: ['EQ:STAND_260:1'] }] });
  assert.strictEqual(overNew.ok, false);
  assert.strictEqual(overNew.error.code, 'STOCK_EXCEEDED');
  assert.ok(plan(select({ equipment: { STAND_260: 2 }, setupService: 'SELF' }), { existingOrders: [{ status: 'AWAITING_PAYMENT', items: ['EQ:STAND_260:1'] }] }).ok, '残り2本まで追加できる');
  assert.ok(plan(select({ equipment: { STAND_260: 3 }, setupService: 'SELF' }), { existingOrders: [{ status: 'CANCELLED', items: ['EQ:STAND_260:3'] }] }).ok);
  assert.strictEqual(plan(select({ equipment: { STROBE_MONOBLOCK: 1 }, setupService: 'SELF' }), { existingOrders: [{ status: 'CONFIRMED', items: ['EQ:STROBE_MONOBLOCK:1'] }] }).error.code, 'STOCK_EXCEEDED');
});

test('背景スタンドは200円の有料レンタル機材（Issue #430）。無料注文ではなくEQUIPMENT注文で課金され、Admin許可制', function () {
  var r = plan(select({ equipment: { BACKGROUND_STAND: 1 }, setupService: 'SELF' }));
  assert.ok(r.ok);
  assert.strictEqual(r.orders.length, 1);
  assert.strictEqual(r.orders[0].category, 'EQUIPMENT');
  assert.strictEqual(r.orders[0].amountJpy, 200);
  assert.strictEqual(r.orders[0].status, 'AWAITING_PAYMENT');
  var held = plan(select({ equipment: { BACKGROUND_STAND: 1 }, setupService: 'SELF' }), { eligibility: NOT_ELIGIBLE });
  assert.strictEqual(held.orders[0].status, 'PENDING_APPROVAL', '未許可は保留（Checkoutを発行しない）');
  var mixed = plan(select({ equipment: { BACKGROUND_STAND: 1, STROBE_PORTABLE: 1 }, setupService: 'SELF' }));
  assert.strictEqual(mixed.orders.filter(function (o) { return o.category === 'EQUIPMENT'; })[0].amountJpy, 1200);
});

test('有料レンタル機材は全件、Admin付与の利用許可が無ければ拒否せず保留注文にする。Checkoutは発行できず、管理者が許可/不承認する', function () {
  ALL_RENTAL_CODES.forEach(function (code) {
    var sel = {}; sel[code] = 1;
    var r = plan(select({ equipment: sel, setupService: 'SELF' }), { eligibility: NOT_ELIGIBLE });
    assert.strictEqual(r.ok, true, code);
    assert.strictEqual(r.orders.length, 1, code);
    var hold = r.orders[0];
    assert.strictEqual(hold.category, 'EQUIPMENT', code);
    assert.strictEqual(hold.status, 'PENDING_APPROVAL', code);
    assert.strictEqual(hold.approvalStatus, 'PENDING_APPROVAL', code);
    assert.strictEqual(hold.paymentStatus, 'NOT_STARTED', code);
    assert.strictEqual(BookingOptions.isPayable(hold), false, code + ': 保留注文は支払い不可');
    assert.strictEqual(BookingOptions.summarizeOrder(hold).eligibilityHold, true, code);
    assert.strictEqual(BookingOptions.summarizeOrder(hold).requiresApproval, true, code);
  });
  // 許可済みなら承認不要・決済待ち
  var ok = plan(select({ equipment: { COB_BICOLOR: 1 }, setupService: 'SELF' }), { eligibility: ELIGIBLE });
  assert.strictEqual(ok.orders[0].status, 'AWAITING_PAYMENT');
  assert.strictEqual(ok.orders[0].approvalStatus, 'NOT_REQUIRED');
  assert.strictEqual(BookingOptions.summarizeOrder(ok.orders[0]).eligibilityHold, false);
  // 資格情報が無い（旧形式・欠落）場合も同じ保留状態に落ちる（fail-closed。直接改ざん入力でも決済へ進まない）
  [{ videoLightSelfRental: true }, undefined].forEach(function (elig) {
    var r = BookingOptions.planOrders({ normalized: select({ equipment: { COB_BICOLOR: 1 }, setupService: 'SELF' }), existingOrders: [], optionsConfig: CONFIG_WITH_PRICES, eligibility: elig });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.orders[0].status, 'PENDING_APPROVAL');
  });
});

test('ストロボ・ソフトボックス・アクセサリーも未許可なら保留注文になり、Checkoutに進めない（Issue #430）', function () {
  var r = plan(select({ equipment: { STROBE_MONOBLOCK: 1, STROBE_PORTABLE: 1, STAND_260: 1, COMMANDER_SONY: 1, COLOR_FILTER_SET: 1, SOFTBOX_60: 1 }, setupService: 'SELF' }), { eligibility: NOT_ELIGIBLE });
  assert.strictEqual(r.orders.length, 1);
  assert.strictEqual(r.orders[0].status, 'PENDING_APPROVAL');
  assert.strictEqual(BookingOptions.isPayable(r.orders[0]), false);
});

test('許可済みの機材と未許可の機材を同時に申し込むと注文が分かれる: 許可済み分は決済待ち、未許可分だけ保留（保留分の金額が決済額に混ざらない）', function () {
  var r = plan(select({ equipment: { COB_BICOLOR: 1, STROBE_MONOBLOCK: 1 }, setupService: 'SELF' }), { eligibility: { eligibleEquipmentCodes: ['STROBE_MONOBLOCK'] } });
  assert.strictEqual(r.orders.length, 2);
  var byStatus = {};
  r.orders.forEach(function (o) { byStatus[o.status] = o; });
  assert.strictEqual(byStatus.AWAITING_PAYMENT.amountJpy, 800);
  assert.deepStrictEqual(plain(byStatus.AWAITING_PAYMENT.items), ['EQ:STROBE_MONOBLOCK:1']);
  assert.strictEqual(byStatus.PENDING_APPROVAL.amountJpy, 800);
  assert.deepStrictEqual(plain(byStatus.PENDING_APPROVAL.items), ['EQ:COB_BICOLOR:1']);
});

test('資格は機材コード単位: バイカラーCOBの許可だけでは、フルカラーCOB・フルカラーパネルは保留になる（許可済み分だけ即決済待ち）', function () {
  var onlyBicolor = { eligibleEquipmentCodes: ['COB_BICOLOR'] };
  assert.strictEqual(plan(select({ equipment: { COB_BICOLOR: 1 }, setupService: 'SELF' }), { eligibility: onlyBicolor }).orders[0].status, 'AWAITING_PAYMENT');
  assert.strictEqual(plan(select({ equipment: { COB_FULLCOLOR: 1 }, setupService: 'SELF' }), { eligibility: onlyBicolor }).orders[0].status, 'PENDING_APPROVAL');
  assert.strictEqual(plan(select({ equipment: { PANEL_FULLCOLOR: 1 }, setupService: 'SELF' }), { eligibility: onlyBicolor }).orders[0].status, 'PENDING_APPROVAL');
  var mixed = plan(select({ equipment: { COB_BICOLOR: 1, COB_FULLCOLOR: 2 }, setupService: 'SELF' }), { eligibility: onlyBicolor });
  assert.strictEqual(mixed.orders.length, 2);
  var pay = mixed.orders.filter(function (o) { return o.status === 'AWAITING_PAYMENT'; })[0];
  var hold = mixed.orders.filter(function (o) { return o.status === 'PENDING_APPROVAL'; })[0];
  assert.deepStrictEqual(plain(pay.items), ['EQ:COB_BICOLOR:1']);
  assert.deepStrictEqual(plain(hold.items), ['EQ:COB_FULLCOLOR:2']);
  assert.strictEqual(hold.amountJpy, 2000);
});

test('lectureRequiredEquipmentCodes / equipmentCodeOfItem: 対象は有料レンタル機材全件、機材項目からコードだけを取り出す', function () {
  assert.deepStrictEqual(plain(BookingOptions.lectureRequiredEquipmentCodes().sort()), plain(ALL_RENTAL_CODES).sort());
  assert.strictEqual(BookingOptions.equipmentCodeOfItem('EQ:COB_FULLCOLOR:2'), 'COB_FULLCOLOR');
  assert.strictEqual(BookingOptions.equipmentCodeOfItem('SELF_SETUP:CLASSROOM'), '');
});

test('isLectureRequiredItem: 有料レンタル機材の項目が許可の対象（機材以外は対象外）', function () {
  assert.strictEqual(BookingOptions.isLectureRequiredItem('EQ:COB_BICOLOR:1'), true);
  assert.strictEqual(BookingOptions.isLectureRequiredItem('EQ:COB_FULLCOLOR:2'), true);
  assert.strictEqual(BookingOptions.isLectureRequiredItem('EQ:STROBE_MONOBLOCK:1'), true);
  assert.strictEqual(BookingOptions.isLectureRequiredItem('SELF_SETUP:CLASSROOM'), false);
  assert.strictEqual(BookingOptions.isLectureRequiredItem('VIDEO_LIGHT'), false);
});

// ---- 混在: 未承認スタッフ料金が機材の決済額へ混入しない ----

test('機材+スタッフ対応+無料: 注文が分かれ、機材の決済額に未承認のスタッフ料金が混ざらない', function () {
  var r = plan(select({ equipment: { STROBE_MONOBLOCK: 1 }, layouts: ['CLASSROOM'], setupService: 'STAFF', cleanupService: 'STAFF', emailSupport: true }));
  assert.ok(r.ok);
  var byCat = {};
  r.orders.forEach(function (o) { byCat[o.category] = o; });
  assert.strictEqual(byCat.EQUIPMENT.amountJpy, 800);
  assert.strictEqual(byCat.STAFF_SERVICE.amountJpy, 5000);
  assert.strictEqual(byCat.STAFF_SERVICE.status, 'PENDING_APPROVAL');
  assert.strictEqual(BookingOptions.isPayable(byCat.STAFF_SERVICE), false, '未承認のスタッフ対応は支払い対象にならない');
  assert.strictEqual(BookingOptions.isPayable(byCat.EQUIPMENT), true);
  assert.strictEqual(byCat.FREE.amountJpy, 0);
  assert.strictEqual(r.orders.length, 3);
});

// ---- 状態遷移・支払い可否 ----

test('状態遷移: PENDING_APPROVAL→承認→支払い→CONFIRMED、不承認はDECLINEDで終端', function () {
  var S = BookingOptions.STATUS;
  assert.ok(BookingOptions.canTransition(S.PENDING_APPROVAL, S.AWAITING_PAYMENT));
  assert.ok(BookingOptions.canTransition(S.AWAITING_PAYMENT, S.PAYMENT_PENDING));
  assert.ok(BookingOptions.canTransition(S.PAYMENT_PENDING, S.CONFIRMED));
  assert.ok(BookingOptions.canTransition(S.PAYMENT_PENDING, S.AWAITING_PAYMENT), '決済失敗後の再試行');
  assert.ok(BookingOptions.canTransition(S.PENDING_APPROVAL, S.DECLINED));
  // 承認前に決済待ち/確定へ飛べない
  assert.strictEqual(BookingOptions.canTransition(S.PENDING_APPROVAL, S.PAYMENT_PENDING), false);
  assert.strictEqual(BookingOptions.canTransition(S.PENDING_APPROVAL, S.CONFIRMED), true, '請求額0円（セット無料）の機材注文はAdmin許可で確定できる（Issue #438）。決済経由の確定は決済待ちからのみ');
  // 終端は動かない
  [S.DECLINED, S.CANCELLED, S.CONFIRMED].forEach(function (t) {
    Object.keys(S).forEach(function (k) { assert.strictEqual(BookingOptions.canTransition(t, S[k]), false); });
  });
});

test('isPayable: 承認前・不承認・確定済み・金額不正は支払えない', function () {
  var base = { amountJpy: 3000, approvalStatus: 'APPROVED', status: 'AWAITING_PAYMENT' };
  assert.strictEqual(BookingOptions.isPayable(base), true);
  assert.strictEqual(BookingOptions.isPayable(Object.assign({}, base, { approvalStatus: 'PENDING_APPROVAL', status: 'PENDING_APPROVAL' })), false);
  assert.strictEqual(BookingOptions.isPayable(Object.assign({}, base, { approvalStatus: 'PENDING_APPROVAL' })), false, 'statusが先に進んでいても承認が無ければ不可');
  assert.strictEqual(BookingOptions.isPayable(Object.assign({}, base, { approvalStatus: 'DECLINED', status: 'DECLINED' })), false);
  assert.strictEqual(BookingOptions.isPayable(Object.assign({}, base, { status: 'CONFIRMED' })), false);
  [0, -1, 1.5, NaN, ''].forEach(function (a) { assert.strictEqual(BookingOptions.isPayable(Object.assign({}, base, { amountJpy: a })), false, String(a)); });
});

// ---- 予約側の受付可否 ----

test('checkBookingAcceptsOptions: PENDING/CONFIRMEDかつ利用開始前のStudio Xのみ', function () {
  var now = new Date('2026-10-24T10:00:00+09:00');
  var future = new Date('2026-11-01T10:00:00+09:00');
  var ok = function (o) { return BookingOptions.checkBookingAcceptsOptions(Object.assign({ status: 'CONFIRMED', brand: 'studio_x', startAt: future }, o), {}, now); };
  assert.strictEqual(ok({}).ok, true);
  assert.strictEqual(ok({ status: 'PENDING' }).ok, true);
  assert.strictEqual(ok({ status: 'CANCELLED' }).error.code, 'BOOKING_NOT_ELIGIBLE');
  assert.strictEqual(ok({ status: 'EXPIRED' }).error.code, 'BOOKING_NOT_ELIGIBLE');
  assert.strictEqual(ok({ startAt: new Date('2026-10-24T09:00:00+09:00') }).error.code, 'BOOKING_ALREADY_STARTED');
  assert.strictEqual(ok({ brand: 'snb' }).error.code, 'OPTIONS_NOT_AVAILABLE');
  assert.strictEqual(ok({ brand: 'mens' }).error.code, 'OPTIONS_NOT_AVAILABLE');
  assert.strictEqual(BookingOptions.checkBookingAcceptsOptions(null, {}, now).error.code, 'BOOKING_NOT_FOUND');
});

test('申込締切は設定値のみ（未設定なら独自の締切を設けない）', function () {
  var now = new Date('2026-10-24T10:00:00+09:00');
  var booking = { status: 'CONFIRMED', brand: 'studio_x', startAt: new Date('2026-10-25T10:00:00+09:00') }; // 24時間後
  assert.strictEqual(BookingOptions.checkBookingAcceptsOptions(booking, { addonDeadlineHoursBeforeStart: '' }, now).ok, true);
  assert.strictEqual(BookingOptions.checkBookingAcceptsOptions(booking, { addonDeadlineHoursBeforeStart: '24' }, now).ok, true);
  assert.strictEqual(BookingOptions.checkBookingAcceptsOptions(booking, { addonDeadlineHoursBeforeStart: '48' }, now).error.code, 'ADDON_DEADLINE_PASSED');
});

// ---- Stripe参照 ----

test('Checkoutの参照: bookingId・optionOrderId・orderType=addonのみで、PII・秘密情報を含まない', function () {
  var ref = BookingOptions.buildCheckoutReference({ optionOrderId: 'OPT-AAAA1111', bookingId: 'SX-20261101-AAAAAAAA' }, 'OPAY-OPT-AAAA1111-ABCDEF012345', 'studio_x');
  assert.strictEqual(ref.clientReferenceId, 'OPT-AAAA1111');
  assert.deepStrictEqual(plain(Object.keys(ref.metadata).sort()), ['bookingId', 'brand', 'optionOrderId', 'orderType', 'paymentAttemptId']);
  assert.strictEqual(ref.metadata.orderType, 'addon');
  assert.ok(!/@|name|email|phone/i.test(JSON.stringify(ref)));
});

test('optionOrderId・決済試行IDの形式と、同一UUIDから同一IDにならない一意性の材料', function () {
  assert.match(BookingOptions.generateOptionOrderId('1234abcd-0000'), /^OPT-1234ABCD$/);
  assert.match(BookingOptions.generatePaymentAttemptId('OPT-1234ABCD', 'aaaaaaaa-bbbb-cccc'), /^OPAY-OPT-1234ABCD-AAAAAAAABBBB$/);
});

// ---- 定型案内 ----

test('定型案内（確定文言）: 黒板教室は保管場所・セット方法・原状復帰・注意事項を案内し、チョーク収納を明示する', function () {
  var g = BookingOptions.renderSelfGuidance(['SELF_SETUP:CLASSROOM', 'SELF_CLEANUP:CLASSROOM']);
  assert.strictEqual(g.incomplete, false, '教室セットは確定文言のため未整備にならない');
  assert.ok(g.text.indexOf('【教室セット（机・黒板）のセルフセッティング】') !== -1);
  assert.ok(g.text.indexOf('教卓・小黒板・学校机・椅子は、教室セット側の所定位置') !== -1);
  assert.ok(g.text.indexOf('教卓を前方、小黒板を背景側に置き') !== -1);
  assert.ok(g.text.indexOf('原状写真と同じ位置へ戻してください。黒板に書いた内容は消してください') !== -1);
  assert.ok(g.text.indexOf('黒板を移動するときは、チョークを必ずケースに収納してください') !== -1);
  assert.ok(g.text.indexOf('チョークが落下すると割れるおそれ') !== -1);
  assert.ok(g.text.indexOf('使用後は清掃して元の位置へ戻してください。') !== -1);
  assert.ok(g.text.indexOf('運営にて内容を確認中です') === -1);
  assert.ok(g.text.indexOf('追加のご質問はメールでお問い合わせください') !== -1);
});

test('定型案内（確定文言）: 和風・畳は滑り止めとラミネート手順書、靴・飲食・重量物の注意を案内する', function () {
  var g = BookingOptions.renderSelfGuidance(['SELF_SETUP:JAPANESE', 'SELF_CLEANUP:JAPANESE']);
  assert.strictEqual(g.incomplete, false);
  assert.ok(g.text.indexOf('畳の下に滑り止めを敷いてから設置してください') !== -1);
  assert.ok(g.text.indexOf('室内のラミネート手順書を参照してください') !== -1);
  assert.ok(g.text.indexOf('所定の順序・位置へ戻してください') !== -1);
  assert.ok(g.text.indexOf('畳の上で靴を使用しないでください') !== -1);
  assert.ok(g.text.indexOf('重量物を引きずらないでください') !== -1);
});

test('定型案内（確定文言）: 白黒背景布は同じ案内で、スタンド/竹の梁・踏み込み・靴・テープの注意を案内する', function () {
  ['WHITE_BACKDROP', 'BLACK_BACKDROP'].forEach(function (theme) {
    var g = BookingOptions.renderSelfGuidance(['SELF_SETUP:' + theme, 'SELF_CLEANUP:' + theme]);
    assert.strictEqual(g.incomplete, false, theme);
    assert.ok(g.text.indexOf('背景スタンド、または竹の梁にセットして使用してください') !== -1, theme);
    assert.ok(g.text.indexOf('踏み込み部分を必要最小限にしてください') !== -1, theme);
    assert.ok(g.text.indexOf('布に汚れ・異物がないことを確認してから畳み') !== -1, theme);
    assert.ok(g.text.indexOf('スタンドも元の位置へ戻してください') !== -1, theme);
    assert.ok(g.text.indexOf('靴で背景布を踏まないでください') !== -1 && g.text.indexOf('粘着テープを直接貼らない') !== -1, theme);
  });
  assert.ok(BookingOptions.renderSelfGuidance(['SELF_SETUP:WHITE_BACKDROP']).text.indexOf('【白背景布のセルフセッティング】') !== -1);
  assert.ok(BookingOptions.renderSelfGuidance(['SELF_SETUP:BLACK_BACKDROP']).text.indexOf('【黒背景布のセルフセッティング】') !== -1);
});

test('定型案内（確定文言）: グランジは背景布と同じ運用（スタンド/竹の梁・畳んで収納・スタンドも原状復帰・靴/テープ/濡れ/飲食/化粧品）', function () {
  var g = BookingOptions.renderSelfGuidance(['SELF_SETUP:GRUNGE', 'SELF_CLEANUP:GRUNGE']);
  assert.strictEqual(g.incomplete, false);
  assert.ok(g.text.indexOf('【グランジセットのセルフセッティング】') !== -1);
  assert.ok(g.text.indexOf('背景スタンド、または竹の梁にセットして使用してください') !== -1);
  assert.ok(g.text.indexOf('布に汚れ・異物がないことを確認してから畳み、元の場所へ収納してください') !== -1);
  assert.ok(g.text.indexOf('スタンドも元の位置へ戻してください') !== -1);
  assert.ok(g.text.indexOf('靴で背景布を踏まないでください') !== -1);
  assert.ok(g.text.indexOf('粘着テープを直接貼らないでください') !== -1);
  assert.ok(g.text.indexOf('濡れ・飲食物・化粧品の付着に注意してください') !== -1);
  assert.ok(g.text.indexOf('運営にて内容を確認中です') === -1);
});

test('定型案内: 5テーマすべて確定済みで、未整備(null)の項目が残っていない', function () {
  THEMES.forEach(function (theme) {
    var g = BookingOptions.renderSelfGuidance(['SELF_SETUP:' + theme, 'SELF_CLEANUP:' + theme]);
    assert.strictEqual(g.incomplete, false, theme);
    assert.ok(g.text.indexOf('運営にて内容を確認中です') === -1, theme);
    ['保管場所:', '使用する備品:', 'セット方法:', '原状復帰の方法:', '注意事項:'].forEach(function (label) {
      assert.ok(g.text.indexOf(label) !== -1, theme + ' に ' + label + ' がある');
    });
  });
});

test('定型案内: 将来テーマの文言が未確定(null)の項目は創作せず「運営確認中」と明示し、Adminに未整備を知らせる（フォールバック）', function () {
  // 確定済みの収納場所をnullへ差し替えたソースを読み込み、フォールバック動作だけを検証する
  var fs2 = require('node:fs');
  var src = fs2.readFileSync(path.join(__dirname, '..', 'gas', 'booking', 'shared', 'BookingOptions.gs'), 'utf8')
    .replace("storage: 'グランジ背景は、白・黒背景布と同じ運用で、指定の収納場所に保管しています。',", 'storage: null,');
  assert.ok(src.indexOf('storage: null,') !== -1);
  var vm2 = require('node:vm');
  var ctx = {};
  vm2.createContext(ctx);
  vm2.runInContext(fs2.readFileSync(path.join(__dirname, '..', 'gas', 'booking', 'shared', 'EquipmentCatalog.gs'), 'utf8'), ctx);
  vm2.runInContext(src, ctx);
  var g = ctx.BookingOptions.renderSelfGuidance(['SELF_SETUP:GRUNGE']);
  assert.strictEqual(g.incomplete, true);
  assert.ok(g.text.indexOf('運営にて内容を確認中です') !== -1);
  assert.ok(g.text.indexOf('セット方法: 背景スタンド、または竹の梁にセットして使用してください') !== -1, '確定済みの項目はそのまま出る');
});

test('定型案内: セルフ設営だけなら原状復帰の項目を出さず、スタッフ対応・機材のみなら案内なし', function () {
  var g = BookingOptions.renderSelfGuidance(['SELF_SETUP:JAPANESE']);
  assert.ok(g.text.indexOf('セット方法') !== -1);
  assert.ok(g.text.indexOf('原状復帰の方法') === -1);
  assert.strictEqual(BookingOptions.renderSelfGuidance(['STAFF_PRE_SETUP:JAPANESE', 'EQ:STROBE_MONOBLOCK:1']).text, '');
  assert.strictEqual(BookingOptions.renderSelfGuidance([]).text, '');
});

test('定型案内: メールサポートのみでも「追加質問はメール」の案内を付ける。チャット・電話は案内しない', function () {
  var g = BookingOptions.renderSelfGuidance(['EMAIL_SUPPORT']);
  assert.ok(g.text.indexOf('メールでお問い合わせください') !== -1);
  assert.ok(!/チャット|電話/.test(g.text));
});

test('summarizeOrder: 内部トークン・メールアドレスを含まず、requiresApproval/payableを返す', function () {
  var s = BookingOptions.summarizeOrder({
    optionOrderId: 'OPT-1', category: 'STAFF_SERVICE', items: ['STAFF_PRE_SETUP:GRUNGE'], amountJpy: 3000,
    approvalStatus: 'PENDING_APPROVAL', paymentStatus: 'NOT_STARTED', status: 'PENDING_APPROVAL',
    customerEmail: 'a@example.com', paymentAttemptId: 'OPAY-x', stripeCheckoutSessionId: 'cs_x'
  });
  assert.strictEqual(s.requiresApproval, true);
  assert.strictEqual(s.payable, false);
  assert.strictEqual(s.items[0].label, '事前設営（スタッフ）: グランジセット');
  assert.ok(!/example\.com|OPAY|cs_x/.test(JSON.stringify(s)));
});

// ---- 金額の重複ハードコード防止（Issue要件） ----

test('スタッフ対応料金(3,000/5,000円)はBookingOptions.gsにのみ定義され、画面・Webhook・Adminへ重複ハードコードされていない', function () {
  var root = path.join(__dirname, '..');
  var targets = [
    'scripts/booking-options.js', 'scripts/booking-options-addon.js', 'scripts/booking-app.js',
    'admin/booking/booking-admin.js',
    'gas/booking/shared/OptionOrderService.gs', 'gas/booking/shared/OptionOrderRepository.gs',
    'gas/booking/shared/OptionMailTemplates.gs', 'gas/booking/admin/StripeWebhookProcessor.gs',
    'gas/booking/public/Code.gs', 'studio-x/booking/options/index.html'
  ];
  targets.forEach(function (rel) {
    var text = fs.readFileSync(path.join(root, rel), 'utf8');
    // コメント内の説明（「3,000円」等）は許容せず、数値リテラルとして現れないことを確認する
    var code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/\b3000\b|\b5000\b|3,000|5,000/.test(code), rel + ' に金額が重複して書かれている');
  });
  // 正本は_data/studio_x_equipment.json（Issue #430）。GASは生成カタログから参照し、数値を再定義しない
  var source = fs.readFileSync(path.join(root, 'gas/booking/shared/BookingOptions.gs'), 'utf8');
  assert.ok(!/PRE_SETUP: \d|BOTH: \d/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')));
  var canon = JSON.parse(fs.readFileSync(path.join(root, '_data/studio_x_equipment.json'), 'utf8'));
  assert.strictEqual(canon.staffService.services.PRE_SETUP.priceJpy, 3000);
  assert.strictEqual(canon.staffService.services.BOTH.priceJpy, 5000);
});

// ---- Issue #438: セット無料・設営方法の必須選択 ----

test('ライトスタンド: 単独は200円/本、ライト・ストロボとセットなら相手機材1点につき1本まで無料（二重計上しない）', function () {
  assert.strictEqual(plan(select({ equipment: { STAND_260: 2 }, setupService: 'SELF' })).orders[0].amountJpy, 400, '単独は200円/本');
  var withLight = plan(select({ equipment: { COB_FULLCOLOR: 2, STAND_260: 2 }, setupService: 'SELF' }));
  assert.strictEqual(withLight.orders[0].amountJpy, 2000, 'COB2台=2,000円、スタンド2本は無料');
  assert.deepStrictEqual(plain(withLight.orders[0].items.sort()), ['EQ:COB_FULLCOLOR:2', 'EQ:STAND_260:2:F2']);
  var extra = plan(select({ equipment: { COB_FULLCOLOR: 1, STAND_260: 3 }, setupService: 'SELF' }));
  assert.strictEqual(extra.orders[0].amountJpy, 1000 + 200 * 2, 'ライト1台につき1本無料、残り2本は200円');
  assert.ok(plan(select({ equipment: { STROBE_PORTABLE: 1, STAND_260: 1 }, setupService: 'SELF' })).orders[0].items.indexOf('EQ:STAND_260:1:F1') !== -1);
  assert.strictEqual(plan(select({ equipment: { SOFTBOX_60: 1, STAND_260: 1 }, setupService: 'SELF' })).orders[0].amountJpy, 500, 'ソフトボックスはセット対象ではない');
});

test('ボーエンズマウントブラケット: 単独200円、ポータブルストロボとセットなら無料（モノブロックではセット無料にならない）', function () {
  assert.strictEqual(plan(select({ equipment: { BOWENS_BRACKET: 1 }, setupService: 'SELF' })).orders[0].amountJpy, 200);
  var set = plan(select({ equipment: { STROBE_PORTABLE: 1, BOWENS_BRACKET: 1 }, setupService: 'SELF' }));
  assert.strictEqual(set.orders[0].amountJpy, 1000);
  assert.ok(set.orders[0].items.indexOf('EQ:BOWENS_BRACKET:1:F1') !== -1);
  assert.strictEqual(plan(select({ equipment: { STROBE_MONOBLOCK: 1, BOWENS_BRACKET: 1 }, setupService: 'SELF' })).orders[0].amountJpy, 1000);
});

test('ストリップソフトボックス（30×120cm）は300円/個で最大2個、フルカラーCOBは1,000円/台で最大2台', function () {
  assert.strictEqual(plan(select({ equipment: { SOFTBOX_STRIP_30X120: 2 }, setupService: 'SELF' })).orders[0].amountJpy, 600);
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { SOFTBOX_STRIP_30X120: 3 }, setupService: 'SELF' }).error.code, 'STOCK_EXCEEDED');
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { COB_FULLCOLOR: 3 }, setupService: 'SELF' }).error.code, 'STOCK_EXCEEDED');
});

test('セット無料の表示: 品目名に「セット無料」が付き、Admin・メール・Checkoutの品名（describeItem）で一致する', function () {
  assert.strictEqual(BookingOptions.describeItem('EQ:STAND_260:2:F2'), 'ライトスタンド（260cm） ×2（セット無料）');
  assert.strictEqual(BookingOptions.describeItem('EQ:STAND_260:3:F1'), 'ライトスタンド（260cm） ×3（うち1点セット無料）');
  assert.strictEqual(BookingOptions.describeItem('EQ:STAND_260:2'), 'ライトスタンド（260cm） ×2');
  var catalog = BookingOptions.buildCatalog('studio_x', {});
  var stand = catalog.equipment.filter(function (e) { return e.code === 'STAND_260'; })[0];
  assert.strictEqual(stand.unitPriceJpy, 200);
  assert.strictEqual(stand.freeWhenWith.label, 'ライト・ストロボとセットで無料／単独200円');
  assert.strictEqual(catalog.equipment.filter(function (e) { return e.code === 'BOWENS_BRACKET'; })[0].freeWhenWith.label, 'ポータブルストロボとセットで無料／単独200円');
});

test('有料機材を選んだら設営方法（セルフ/スタッフ）の明示選択が必須。未指定は拒否、セルフは0円、スタッフは既存の事前設営フロー', function () {
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { STROBE_PORTABLE: 1 } }).error.code, 'SETUP_METHOD_REQUIRED');
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { STROBE_PORTABLE: 1 }, setupService: '' }).error.code, 'SETUP_METHOD_REQUIRED');
  assert.ok(BookingOptions.normalizeSelection({ equipment: { STROBE_PORTABLE: 1 }, setupService: 'SELF' }).ok);
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { STROBE_PORTABLE: 1 }, setupService: 'NONE' }).error.code, 'SETUP_METHOD_REQUIRED', '機材レンタルでは後付けでもNONEは選べない');
  assert.ok(BookingOptions.normalizeSelection({ layouts: ['CLASSROOM'], setupService: 'NONE', cleanupService: 'STAFF' }).ok, '機材なしの後付けではNONEを許容');
  assert.ok(BookingOptions.normalizeSelection({ layouts: ['CLASSROOM'] }).ok, '機材なしのセッティングは従来どおり既定セルフ');
  assert.ok(BookingOptions.normalizeSelection({ equipment: { BACKGROUND_STAND: 1 }, setupService: 'SELF' }).ok);
  assert.ok(BookingOptions.normalizeSelection({ equipment: { STROBE_PORTABLE: 1 }, setupService: 'STAFF' }).ok, '機材のみでもスタッフ設営を選べる（テーマ不要）');
  assert.strictEqual(BookingOptions.normalizeSelection({ layouts: [], setupService: 'STAFF' }).error.code, 'LAYOUT_REQUIRED_FOR_STAFF_SERVICE', '機材なしのスタッフ設営は従来どおりテーマが必要');
  assert.strictEqual(BookingOptions.normalizeSelection({ equipment: { STROBE_PORTABLE: 1 }, setupService: 'SELF', cleanupService: 'STAFF' }).error.code, 'LAYOUT_REQUIRED_FOR_STAFF_SERVICE', '片付けのスタッフ依頼は従来どおりテーマが必要');
  var staff = plan(select({ equipment: { STROBE_PORTABLE: 1 }, layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'STAFF' }));
  assert.ok(staff.ok);
  var staffOrder = staff.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0];
  assert.strictEqual(staffOrder.amountJpy, 5000, '事前設営＋片付けは通算5,000円');
  assert.strictEqual(staffOrder.status, 'PENDING_APPROVAL', 'スタッフ設営は承認後に決済');
  var self = plan(select({ equipment: { STROBE_PORTABLE: 1 }, setupService: 'SELF' }));
  assert.strictEqual(self.orders.reduce(function (sum, o) { return sum + o.amountJpy; }, 0), 1000, 'セルフ設営は追加料金なし');
  var preOnly = plan(select({ equipment: { STROBE_PORTABLE: 1 }, layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'SELF' }));
  assert.strictEqual(preOnly.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0].amountJpy, 3000);
});

test('セット無料の付帯機材だけが許可待ちの場合は0円の保留注文になり、許可済みの本体は支払い対象のまま（付帯機材は勝手に確定しない）', function () {
  var r = plan(select({ equipment: { STROBE_PORTABLE: 1, BOWENS_BRACKET: 1 }, setupService: 'SELF' }), { eligibility: { eligibleEquipmentCodes: ['STROBE_PORTABLE'] } });
  assert.ok(r.ok);
  var hold = r.orders.filter(function (o) { return o.status === 'PENDING_APPROVAL'; })[0];
  assert.ok(hold, '付帯機材はAdmin許可待ち');
  assert.strictEqual(hold.amountJpy, 0);
  assert.deepStrictEqual(plain(hold.items), ['EQ:BOWENS_BRACKET:1:F1']);
  var pay = r.orders.filter(function (o) { return o.status === 'AWAITING_PAYMENT'; });
  assert.strictEqual(pay.length, 1);
  assert.strictEqual(pay[0].amountJpy, 1000);
});

test('ライトが許可待ちなら、セット無料のスタンドも同じ保留注文に載る（許可前に付帯機材だけ決済・確定させない）', function () {
  var r = plan(select({ equipment: { COB_FULLCOLOR: 1, STAND_260: 1 }, setupService: 'SELF' }), { eligibility: { eligibleEquipmentCodes: ['STAND_260'] } });
  assert.ok(r.ok);
  assert.strictEqual(r.orders.length, 1);
  assert.strictEqual(r.orders[0].status, 'PENDING_APPROVAL');
  assert.strictEqual(r.orders[0].amountJpy, 1000);
});

test('機材のみのスタッフ設営（テーマなし）は既存の事前設営3,000円・承認後決済に乗り、片付けとの通算5,000円ルールを維持する', function () {
  var r = plan(select({ equipment: { COB_FULLCOLOR: 1 }, setupService: 'STAFF' }));
  assert.ok(r.ok, JSON.stringify(r.error));
  var staff = r.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0];
  assert.deepStrictEqual(plain(staff.items), ['STAFF_PRE_SETUP:EQUIPMENT']);
  assert.strictEqual(staff.amountJpy, 3000);
  assert.strictEqual(staff.status, 'PENDING_APPROVAL');
  assert.strictEqual(BookingOptions.describeItem('STAFF_PRE_SETUP:EQUIPMENT'), '事前設営（スタッフ）: 機材の設営');
  assert.strictEqual(r.orders.filter(function (o) { return o.category === 'EQUIPMENT'; })[0].amountJpy, 1000, '機材料金は別に加算');
  // 既存の事前設営（テーマなし）へ、後から片付け（テーマあり）を足しても通算5,000円。差額は2,000円
  var later = plan(select({ layouts: ['CLASSROOM'], setupService: 'NONE', cleanupService: 'STAFF' }), { existingOrders: [{ status: 'PENDING_APPROVAL', items: ['STAFF_PRE_SETUP:EQUIPMENT'] }] });
  assert.ok(later.ok, JSON.stringify(later.error));
  assert.strictEqual(later.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0].amountJpy, 2000);
  // テーマを選んだ場合はそのテーマを紐づける
  var themed = plan(select({ equipment: { COB_FULLCOLOR: 1 }, layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'STAFF' }));
  assert.deepStrictEqual(plain(themed.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0].items.sort()), ['STAFF_CLEANUP:GRUNGE', 'STAFF_PRE_SETUP:GRUNGE']);
  assert.strictEqual(themed.orders.filter(function (o) { return o.category === 'STAFF_SERVICE'; })[0].amountJpy, 5000);
});
