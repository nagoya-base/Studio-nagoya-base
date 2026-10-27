/*
 * 予約オプション（Issue #423）の配布ファイルセット回帰テスト。
 *
 * test/helpers/booking-deployment-manifest.js の BOOKING_ADMIN_FILES / BOOKING_WEB_APP_FILES
 * （README「GASプロジェクトへのデプロイ対象ファイル」表と同期）「だけ」をvmへ読み込み、
 * 実際の本番構成と同じファイルセットでReferenceErrorなく動くことを検証する（Issue #273と
 * 同じ事故の再発防止: 新しい.gsを追加したのに配布一覧へ入れ忘れる）。
 * Booking Webhook（署名検証済みイベントを永続化するだけの公開プロジェクト）には
 * オプション関連ファイルを一切配布しないことも確認する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');

var SPREADSHEET_ID = 'ss1';
var OPTION_FILES = ['EquipmentCatalog.gs', 'BookingOptions.gs', 'OptionOrderRepository.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs'];

function futureDateJst_(daysAhead) {
  /* Issue #480: 公開経路の予約は30日先まで（会員先行枠を除く）。テストの日付は互いに衝突しない範囲で30日以内へ畳む。 */
  if (daysAhead > 28) daysAhead = 2 + (daysAhead % 27);
  var d = new Date(Date.now() + daysAhead * 24 * 3600000);
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  var out = {};
  parts.forEach(function (part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

function setup(files, extraGlobals) {
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = {
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID,
    BOOKING_MAIL_DISPLAY_NAME: 'Studio X', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100'
  };
  var mailApp = stubs.createMailAppStub();
  var globals = Object.assign({
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp,
    ScriptApp: stubs.createScriptAppStub(),
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('このテストではStripeを呼ばない'); }),
    Logger: stubs.createLoggerStub(),
    ContentService: stubs.createContentServiceStub()
  }, extraGlobals || {});
  return { sandbox: loadBookingSandbox(files, globals), mailApp: mailApp };
}

function seedBooking(ctx, overrides) {
  var record = Object.assign({
    bookingId: 'SX-20991001-AAAAAAAA', createdAt: new Date(), date: '2099-10-01',
    startAt: new Date('2099-10-01T09:30:00+09:00'), endAt: new Date('2099-10-01T11:30:00+09:00'),
    brand: 'studio_x', name: '山田太郎', email: 'taro@example.com', phone: '090-0000-0000', people: '2名', purpose: 'x',
    paymentMethod: '現金', status: 'CONFIRMED', calendarEventId: 'event-1', source: 'test', note: '', customerType: 'returning'
  }, overrides || {});
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);
  return record.bookingId;
}

test('配布一覧: オプション関連ファイルはBooking Web AppとBooking Adminに含まれ、Booking Webhookには含まれない', function () {
  OPTION_FILES.forEach(function (file) {
    assert.ok(manifest.BOOKING_ADMIN_FILES.indexOf(file) !== -1, 'Admin: ' + file);
    assert.ok(manifest.BOOKING_WEB_APP_FILES.indexOf(file) !== -1, 'WebApp: ' + file);
    assert.ok(manifest.BOOKING_WEBHOOK_FILES.indexOf(file) === -1, 'Webhook: ' + file);
  });
  // 依存順: 純粋ロジック(BookingOptions.gs)はサービスより前。Booking Adminは慣例どおりBookingRepository.gsより前
  // （GASはトップレベルで他ファイルを参照しないため実行上は順不同でも動くが、既存の並びの慣例に合わせる）。
  [manifest.BOOKING_ADMIN_FILES, manifest.BOOKING_WEB_APP_FILES].forEach(function (list) {
    assert.ok(list.indexOf('BookingOptions.gs') < list.indexOf('OptionOrderService.gs'));
    assert.ok(list.indexOf('OptionOrderRepository.gs') < list.indexOf('OptionOrderService.gs'));
  });
  assert.ok(manifest.BOOKING_ADMIN_FILES.indexOf('OptionOrderService.gs') < manifest.BOOKING_ADMIN_FILES.indexOf('BookingRepository.gs'));
});

test('Booking Admin配布ファイルセット: 予約詳細にオプションが載り、承認・不承認が部屋予約に触れずに動く', function () {
  var ctx = setup(manifest.BOOKING_ADMIN_FILES);
  var bookingId = seedBooking(ctx);
  ctx.sandbox.OptionOrderRepository.appendOrders([
    { optionOrderId: 'OPT-STAFF001', bookingId: bookingId, brand: 'studio_x', category: 'STAFF_SERVICE', source: 'ADDON', items: ['STAFF_PRE_SETUP:CLASSROOM'], amountJpy: 3000, currency: 'JPY', approvalStatus: 'PENDING_APPROVAL', paymentStatus: 'NOT_STARTED', status: 'PENDING_APPROVAL', customerEmail: 'taro@example.com', createdAt: new Date(), updatedAt: new Date() },
    { optionOrderId: 'OPT-STAFF002', bookingId: bookingId, brand: 'studio_x', category: 'STAFF_SERVICE', source: 'WITH_BOOKING', items: ['STAFF_CLEANUP:GRUNGE'], amountJpy: 3000, currency: 'JPY', approvalStatus: 'PENDING_APPROVAL', paymentStatus: 'NOT_STARTED', status: 'PENDING_APPROVAL', customerEmail: 'taro@example.com', createdAt: new Date(), updatedAt: new Date() },
    { optionOrderId: 'OPT-FREE0001', bookingId: bookingId, brand: 'studio_x', category: 'FREE', source: 'ADDON', items: ['SELF_SETUP:GRUNGE', 'EMAIL_SUPPORT'], amountJpy: 0, currency: 'JPY', approvalStatus: 'NOT_REQUIRED', paymentStatus: 'NOT_REQUIRED', status: 'CONFIRMED', customerEmail: 'taro@example.com', createdAt: new Date(), updatedAt: new Date() }
  ]);

  var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(detail.success, true);
  var options = detail.booking.options;
  assert.strictEqual(options.available, true);
  assert.strictEqual(options.orders.length, 3);
  assert.strictEqual(options.guidanceIncomplete, false, '5テーマとも確定済みのため未整備警告は出ない');
  var staff = options.orders.filter(function (o) { return o.optionOrderId === 'OPT-STAFF001'; })[0];
  // 選択内容・有料/無料・同時/後付け・申込日時・承認状態・決済状態・optionOrderId
  assert.strictEqual(staff.paidLabel, '有料');
  assert.strictEqual(staff.sourceLabel, '後付け');
  assert.strictEqual(staff.approvalStatus, 'PENDING_APPROVAL');
  assert.strictEqual(staff.paymentStatus, 'NOT_STARTED');
  assert.strictEqual(staff.canApprove, true);
  assert.strictEqual(typeof staff.createdAt, 'string', 'Dateをそのままクライアントへ渡さない');
  var free = options.orders.filter(function (o) { return o.optionOrderId === 'OPT-FREE0001'; })[0];
  assert.strictEqual(free.paidLabel, '無料');
  assert.strictEqual(free.sourceLabel, '後付け');
  assert.strictEqual(free.canApprove, false);
  assert.ok(!JSON.stringify(options).match(/example\.com|stripe|paymentAttempt/i), '内部情報・メールアドレスを返さない');

  var roomBefore = JSON.stringify(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record);
  /* Issue #478: Admin承認の時点でもactual membershipを再確認する。会員でなければ承認できない（不承認は資格不要）。 */
  var deniedApprove = ctx.sandbox.adminApproveOptionOrder('OPT-STAFF001');
  assert.strictEqual(deniedApprove.success, false);
  assert.strictEqual(deniedApprove.error.code, 'STAFF_SERVICE_MEMBERS_ONLY');
  ctx.sandbox.MemberRepository.upsertMember({ memberId: 'MBR-D1' }, { email: 'taro@example.com' }, { id: 'evt_seed', created: 1 }, { create: true }, new Date());
  ctx.sandbox.MemberRepository.recordPaidMonth({ memberId: 'MBR-D1', month: '2099-10', amount: 1000 }, new Date());
  var approved = ctx.sandbox.adminApproveOptionOrder('OPT-STAFF001');
  assert.strictEqual(approved.success, true);
  assert.strictEqual(approved.order.status, 'AWAITING_PAYMENT');
  assert.strictEqual(typeof approved.order.createdAt, 'string');
  var declined = ctx.sandbox.adminDeclineOptionOrder('OPT-STAFF002', '予定が合わない');
  assert.strictEqual(declined.success, true);
  assert.strictEqual(declined.order.status, 'DECLINED');
  assert.strictEqual(JSON.stringify(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record), roomBefore, '部屋予約の行は一切変わらない');
  assert.strictEqual(ctx.sandbox.adminApproveOptionOrder('OPT-STAFF001').alreadyDecided, true, '二重承認は冪等');
  assert.strictEqual(ctx.sandbox.adminGrantVideoLightEligibility('hanako@example.com', 'COB_FULLCOLOR', 'DM記録').success, true);
  assert.strictEqual(ctx.sandbox.adminRevokeVideoLightEligibility('hanako@example.com', 'COB_FULLCOLOR').revoked, 1);
  assert.strictEqual(ctx.sandbox.adminRevokeVideoLightEligibility('hanako@example.com', 'NOT_A_RENTAL').error.code, 'INVALID_EQUIPMENT');
});

test('Booking Admin配布ファイルセット: オプション注文が無い既存予約の詳細は従来どおり表示でき、optionsは空', function () {
  var ctx = setup(manifest.BOOKING_ADMIN_FILES);
  var bookingId = seedBooking(ctx, { brand: 'snb', bookingId: 'SNB-20991001-BBBBBBBB' });
  var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(detail.success, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(detail.booking.options)), { available: true, guidanceIncomplete: false, orders: [] });
});

test('Booking Web App配布ファイルセット: 同時申込・本人確認付き後付け・カタログがReferenceErrorなく動く', function () {
  var ctx = setup(manifest.BOOKING_WEB_APP_FILES);
  var date = futureDateJst_(60);
  /* スタッフ対応は会員限定（Issue #472）。会員台帳（#471）に利用月の支払い事実がある会員として登録しておく。 */
  ctx.sandbox.MemberRepository.upsertMember({ memberId: 'MBR-1' }, { email: 'taro@example.com' }, { id: 'evt_seed', created: 1 }, { create: true }, new Date());
  ctx.sandbox.MemberRepository.recordPaidMonth({ memberId: 'MBR-1', month: date.slice(0, 7), amount: 1000 }, new Date());
  var res = JSON.parse(ctx.sandbox.doPost({ postData: { contents: JSON.stringify({
    brand: 'studio_x', customerType: 'returning', date: date, startTime: '10:00', durationMinutes: 120, name: '山田太郎',
    email: 'taro@example.com', phone: '090-1234-5678', people: '2名', purpose: '作品撮り', paymentMethod: '現金', note: '', source: 'test',
    options: { confirmations: { equipmentLecture: true, setupScheduleAdjusted: true },  equipment: { STROBE_MONOBLOCK: 1 }, layouts: ['GRUNGE'], setupService: 'STAFF', cleanupService: 'SELF' }
  }) } }).text);
  assert.strictEqual(res.success, true, JSON.stringify(res.error));
  assert.strictEqual(res.options.success, true);

  var catalog = JSON.parse(ctx.sandbox.doGet({ parameter: { action: 'optionCatalog', brand: 'studio_x' } }).text);
  assert.strictEqual(catalog.catalog.enabled, true);
  var summary = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'optionSummary' }, postData: { contents: JSON.stringify({ bookingId: res.bookingId, email: 'taro@example.com' }) } }).text);
  assert.strictEqual(summary.success, true);
  assert.strictEqual(summary.orders.length, 3, '機材・無料(セルフ原状復帰)・スタッフ対応の3注文');
});

test('Booking Web App配布ファイルセット: Adminに無いRateLimiterへ依存するのはCode.gs/BookingRepository.gsの入口側のみ', function () {
  // Booking Adminの配布セットにRateLimiter.gsは無い。OptionOrderService自体はRateLimiterに依存しない。
  assert.ok(manifest.BOOKING_ADMIN_FILES.indexOf('RateLimiter.gs') === -1);
  var ctx = setup(manifest.BOOKING_ADMIN_FILES);
  assert.strictEqual(typeof ctx.sandbox.RateLimiter, 'undefined');
  assert.strictEqual(typeof ctx.sandbox.OptionOrderService.approveOrder, 'function');
});


// 本番回帰: GASのファイル初期化順を配布一覧の依存順と仮定しない。
['public', 'admin'].forEach(function (target) {
  test(target + ': BookingOptionsがEquipmentCatalogより先でも初期化・カタログ・料金・案内が動く', function () {
    var files = (target === 'public' ? manifest.BOOKING_WEB_APP_FILES : manifest.BOOKING_ADMIN_FILES).slice().sort();
    assert.ok(files.indexOf('BookingOptions.gs') < files.indexOf('EquipmentCatalog.gs'));
    var ctx = setup(files);
    var options = ctx.sandbox.BookingOptions;
    var catalog = options.buildCatalog('studio_x', {});
    assert.strictEqual(catalog.enabled, true);
    assert.strictEqual(catalog.themes.length, 5);
    assert.strictEqual(catalog.staffServices.BOTH.priceJpy, 5000);
    assert.strictEqual(options.normalizeSelection({}).ok, true);
    assert.ok(options.renderSelfGuidance(['SELF_SETUP:CLASSROOM']).text.length > 0);
    if (target === 'public') {
      var date = futureDateJst_(3);
      ['snb', 'mens', 'studio_x'].forEach(function (brand) {
        [
          { action: 'monthly', year: date.slice(0, 4), month: String(Number(date.slice(5, 7))), durationMinutes: '120', brand: brand },
          { date: date, durationMinutes: '120', brand: brand },
          { action: 'estimatePrice', date: date, durationMinutes: '120', brand: brand }
        ].forEach(function (parameter) {
          var result = JSON.parse(ctx.sandbox.doGet({ parameter: parameter }).text);
          assert.strictEqual(result.success, true, JSON.stringify(result));
        });
      });
    }
  });
});
