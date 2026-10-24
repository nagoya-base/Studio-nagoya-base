/*
 * Admin予約一覧の予約オプション状態（Issue #447。Studio Xのみ）のテスト。
 * getAdminBookings()がOptionOrdersの状態を部屋予約のstatusとは別キー（optionSummary）で返し、
 * SNB / SNB mens・オプションなしの予約には付けないこと、台帳の読み取り失敗でも一覧が返ることを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs',
  'BookingPricing.gs', 'CardPayment.gs', 'EquipmentCatalog.gs', 'BookingOptions.gs', 'StripeGateway.gs',
  'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs', 'RecoveryRepository.gs',
  'FeeCalculator.gs', 'FeeSettlementRepository.gs', 'BookingReschedule.gs', 'StripeEventRepository.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs',
  'BookingRepository.gs', 'AdminNotifier.gs', 'BookingAdminAlerts.gs', 'BookingRefund.gs',
  'BookingAdmin.gs', 'BookingAdminWeb.gs'
];

var EMAIL = 'taro@example.com';

function futureDateJst_(daysAhead) {
  var d = new Date(Date.now() + daysAhead * 24 * 3600000);
  var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  var out = {};
  parts.forEach(function (part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

function setup() {
  var spreadsheetsById = { ss1: {} };
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({
      CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1', BOOKING_MAIL_DISPLAY_NAME: 'Studio X',
      BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
      RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000'
    }),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: stubs.createMailAppStub(),
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripe呼び出しは想定外'); }),
    Logger: stubs.createLoggerStub()
  };
  return { sandbox: loadBookingSandbox(FILES, globals) };
}

var dayOffset = 60;
function createRoom(ctx, overrides) {
  dayOffset += 1;
  var result = ctx.sandbox.BookingRepository.createBooking(Object.assign({
    brand: 'studio_x', customerType: 'returning', date: futureDateJst_(dayOffset), startTime: '10:00', durationMinutes: 120,
    name: '山田太郎', email: EMAIL, phone: '090-1234-5678', people: '2名', purpose: '作品撮り',
    paymentMethod: '現金', note: '', source: 'test'
  }, overrides || {}));
  assert.strictEqual(result.success, true, JSON.stringify(result.error));
  return result.bookingId;
}

function listItem(ctx, bookingId) {
  return JSON.parse(JSON.stringify(ctx.sandbox.getAdminBookings().bookings.filter(function (b) { return b.bookingId === bookingId; })[0]));
}

function addOrder(ctx, bookingId, overrides) {
  ctx.sandbox.OptionOrderRepository.appendOrders([Object.assign({
    optionOrderId: 'OPT-' + Math.random().toString(36).slice(2, 10).toUpperCase(), bookingId: bookingId, brand: 'studio_x',
    category: 'STAFF_SERVICE', source: 'WITH_BOOKING', items: ['STAFF_PRE_SETUP:EQUIPMENT'], amountJpy: 2000, currency: 'JPY',
    approvalStatus: 'PENDING_APPROVAL', paymentStatus: 'NOT_STARTED', status: 'PENDING_APPROVAL', customerEmail: EMAIL,
    createdAt: new Date(), updatedAt: new Date()
  }, overrides)]);
}

test('オプションなしのStudio X予約はstate NONEで、部屋予約のstatusとは別キーになる', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  var item = listItem(ctx, id);
  assert.strictEqual(item.optionSummary.state, 'NONE');
  assert.strictEqual(item.optionSummary.totalCount, 0);
  assert.strictEqual(item.status, 'PENDING');
});

test('スタッフ設営・片付け・機材の承認待ちがあるとPENDING_APPROVALになり、件数と概要を返す（部屋statusは変わらない）', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id, { items: ['STAFF_PRE_SETUP:EQUIPMENT', 'STAFF_CLEANUP:EQUIPMENT'] });
  addOrder(ctx, id, { category: 'EQUIPMENT', items: ['EQ:COB_BICOLOR:4'], amountJpy: 3200, approvalStatus: 'PENDING_APPROVAL' });
  var item = listItem(ctx, id);
  assert.strictEqual(item.optionSummary.state, 'PENDING_APPROVAL');
  assert.strictEqual(item.optionSummary.pendingApprovalCount, 2);
  assert.deepStrictEqual(item.optionSummary.lines, ['事前設営（スタッフ）｜10:00までに完了', '片付け（スタッフ）｜12:00以降', '機材レンタル 4点']);
  assert.deepStrictEqual(item.optionSummary.staffWork, [
    { kind: 'PRE_SETUP', text: '事前設営（スタッフ）｜10:00までに完了' },
    { kind: 'CLEANUP', text: '片付け（スタッフ）｜12:00以降' }
  ]);
  assert.strictEqual(item.status, 'PENDING');
});

test('状態の優先順位: 承認待ち > 支払い待ち > 確定済み > 不承認/取消のみ', function () {
  var ctx = setup();
  var a = createRoom(ctx);
  addOrder(ctx, a, { status: 'AWAITING_PAYMENT', approvalStatus: 'APPROVED' });
  assert.strictEqual(listItem(ctx, a).optionSummary.state, 'AWAITING_PAYMENT');
  addOrder(ctx, a, { status: 'PENDING_APPROVAL' });
  assert.strictEqual(listItem(ctx, a).optionSummary.state, 'PENDING_APPROVAL');

  var b = createRoom(ctx);
  addOrder(ctx, b, { status: 'PAYMENT_PENDING', approvalStatus: 'APPROVED' });
  assert.strictEqual(listItem(ctx, b).optionSummary.state, 'AWAITING_PAYMENT');

  var c = createRoom(ctx);
  addOrder(ctx, c, { status: 'CONFIRMED', approvalStatus: 'APPROVED', paymentStatus: 'PAID' });
  assert.strictEqual(listItem(ctx, c).optionSummary.state, 'CONFIRMED');

  var d = createRoom(ctx);
  addOrder(ctx, d, { status: 'DECLINED', approvalStatus: 'DECLINED' });
  addOrder(ctx, d, { status: 'CANCELLED' });
  var closed = listItem(ctx, d).optionSummary;
  assert.strictEqual(closed.state, 'CLOSED');
  assert.deepStrictEqual(closed.lines, [], '不承認/取消済みの項目は概要に出さない');
});

test('他の予約のオプションは混ざらない', function () {
  var ctx = setup();
  var a = createRoom(ctx);
  var b = createRoom(ctx);
  addOrder(ctx, a, {});
  assert.strictEqual(listItem(ctx, a).optionSummary.state, 'PENDING_APPROVAL');
  assert.strictEqual(listItem(ctx, b).optionSummary.state, 'NONE');
});

test('SNB / SNB mensの予約にはoptionSummaryを付けない', function () {
  var ctx = setup();
  var snb = createRoom(ctx, { brand: 'snb' });
  assert.strictEqual('optionSummary' in listItem(ctx, snb), false);
});

test('台帳の読み取りに失敗しても一覧は返り、Studio Xはstate UNKNOWNになる', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  ctx.sandbox.OptionOrderRepository.listAll = function () { throw new Error('boom'); };
  var item = listItem(ctx, id);
  assert.strictEqual(item.optionSummary.state, 'UNKNOWN');
  assert.strictEqual(item.optionSummary.available, false);
});

test('一覧のoptionSummaryに決済URL・メール等の内部情報を含めない', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id, {});
  var json = JSON.stringify(listItem(ctx, id).optionSummary);
  assert.ok(json.indexOf(EMAIL) === -1);
  assert.ok(json.indexOf('OPT-') === -1);
});


/* Issue #451: スタッフ作業の作業時刻（親予約の日時が正本。日跨ぎ・詳細カードも）。 */
test('Issue #451: 詳細カードは対象予約日時と設営完了期限／片付け開始目安を返し、承認状態は変えない', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id, { items: ['STAFF_PRE_SETUP:EQUIPMENT', 'STAFF_CLEANUP:EQUIPMENT'] });
  var detail = JSON.parse(JSON.stringify(ctx.sandbox.getAdminBookingDetail(id)));
  var order = detail.booking.options.orders[0];
  var date = detail.booking.date;
  var md = Number(date.slice(5, 7)) + '/' + Number(date.slice(8, 10));
  assert.strictEqual(order.status, 'PENDING_APPROVAL');
  assert.strictEqual(order.canApprove, true);
  assert.deepStrictEqual(order.staffWork.map(function (w) { return w.kind; }), ['PRE_SETUP', 'CLEANUP']);
  var pre = order.staffWork.filter(function (w) { return w.kind === 'PRE_SETUP'; })[0];
  assert.strictEqual(pre.note, md + ' 10:00までに完了');
  assert.strictEqual(pre.target, date + ' 10:00-12:00');
  assert.strictEqual(pre.bookingId, id);
});

test('Issue #451: 片付けは終了時刻以降と表示し、不承認/取消の注文には作業時刻を出さない', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id, { items: ['STAFF_CLEANUP:EQUIPMENT'] });
  addOrder(ctx, id, { items: ['STAFF_PRE_SETUP:EQUIPMENT'], status: 'DECLINED', approvalStatus: 'DECLINED' });
  var orders = JSON.parse(JSON.stringify(ctx.sandbox.getAdminBookingDetail(id))).booking.options.orders;
  var cleanup = orders.filter(function (o) { return o.items[0].code.indexOf('STAFF_CLEANUP') === 0; })[0];
  var declined = orders.filter(function (o) { return o.items[0].code.indexOf('STAFF_PRE_SETUP') === 0; })[0];
  assert.ok(/ 12:00以降$/.test(cleanup.staffWork[0].note));
  assert.ok(cleanup.staffWork[0].note.indexOf('完了') === -1, '片付け完了期限とは断定しない');
  assert.deepStrictEqual(declined.staffWork, []);
});

test('Issue #451: 一覧カードのスタッフ作業は時刻のみ。日跨ぎの終了側は日付つき', function () {
  var ctx = setup();
  var BO = ctx.sandbox.BookingOptions;
  var overnight = { startDate: '2026-10-26', startTime: '22:00', endDate: '2026-10-27', endTime: '02:00' };
  var summary = JSON.parse(JSON.stringify(BO.summarizeForAdminList([
    { status: 'PENDING_APPROVAL', items: ['STAFF_PRE_SETUP:EQUIPMENT', 'STAFF_CLEANUP:EQUIPMENT'] }
  ], overnight)));
  assert.deepStrictEqual(summary.lines, ['事前設営（スタッフ）｜22:00までに完了', '片付け（スタッフ）｜10/27 02:00以降']);
  assert.strictEqual(BO.formatScheduleRange(overnight), '2026-10-26 22:00 〜 2026-10-27 02:00');
  var detailWork = JSON.parse(JSON.stringify(BO.describeStaffWork(['STAFF_PRE_SETUP:EQUIPMENT', 'STAFF_CLEANUP:EQUIPMENT'], overnight, true)));
  assert.strictEqual(detailWork[0].note, '10/26 22:00までに完了');
  assert.strictEqual(detailWork[1].note, '10/27 02:00以降');
});

test('Issue #451: スタッフ対応でない注文・日時未指定ではこれまで通りの表示', function () {
  var ctx = setup();
  var BO = ctx.sandbox.BookingOptions;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(BO.describeStaffWork(['EQ:COB_BICOLOR:4', 'SELF_SETUP:EQUIPMENT']))), []);
  var plain = BO.summarizeForAdminList([{ status: 'PENDING_APPROVAL', items: ['STAFF_PRE_SETUP:EQUIPMENT'] }]);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(plain.lines)), ['事前設営（スタッフ）']);
});
