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
  'BookingPricing.gs', 'CardPayment.gs', 'MembershipRules.gs', 'EquipmentCatalog.gs', 'BookingOptions.gs', 'StripeGateway.gs',
  'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs', 'RecoveryRepository.gs',
  'FeeCalculator.gs', 'FeeSettlementRepository.gs', 'BookingReschedule.gs', 'StripeEventRepository.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs',
  'BookingRepository.gs', 'AdminNotifier.gs', 'BookingAdminAlerts.gs', 'BookingRefund.gs',
  'BookingAdmin.gs', 'BookingAdminWeb.gs'
];

var EMAIL = 'taro@example.com';

function futureDateJst_(daysAhead) {
  /* Issue #480: 公開経路の予約は30日先まで（会員先行枠を除く）。テストの日付は互いに衝突しない範囲で30日以内へ畳む。 */
  if (daysAhead > 28) daysAhead = 2 + (daysAhead % 27);
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
  return { sandbox: loadBookingSandbox(FILES, globals), globals: globals };
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

/* ---------- Issue #864: OptionOrders台帳の読み取り内訳の計測 ---------- */

test('Issue #864: listAll(stats)は区間ミリ秒と行数・列数だけを書き込み、戻り値は引数なしと同じ', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id);
  addOrder(ctx, id, { category: 'EQUIPMENT_RENTAL' });

  var stats = {};
  var withStats = ctx.sandbox.OptionOrderRepository.listAll(stats);
  var withoutStats = ctx.sandbox.OptionOrderRepository.listAll();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(withStats)), JSON.parse(JSON.stringify(withoutStats)));
  assert.deepStrictEqual(Object.keys(stats).sort(), ['columns', 'convertMs', 'openMs', 'readMs', 'rows', 'sheetMs']);
  Object.keys(stats).forEach(function (key) { assert.strictEqual(typeof stats[key], 'number', key); });
  assert.strictEqual(stats.rows, 2);
  assert.ok(stats.columns > 0);
});

test('Issue #864: getAdminBookingsの計測ログとserverTimingにOptionOrdersの内訳が載り、個人情報・IDを含まない', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id);

  var result = ctx.sandbox.getAdminBookings();
  var lines = ctx.globals.Logger._logs.filter(function (line) { return line.indexOf('getAdminBookings timing ') === 0; });
  assert.strictEqual(lines.length, 1);
  var timing = JSON.parse(lines[0].slice('getAdminBookings timing '.length));
  ['optionOrdersOpenMs', 'optionOrdersSheetMs', 'optionOrdersReadMs', 'optionOrdersConvertMs', 'optionOrdersRows', 'optionOrdersColumns'].forEach(function (key) {
    assert.strictEqual(typeof timing[key], 'number', key);
  });
  assert.strictEqual(timing.optionOrdersRows, 1);
  assert.strictEqual(timing.optionOrderBookings, 1);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result.serverTiming)), timing, 'serverTimingはログと同じ値');
  [id, '山田太郎', EMAIL, 'OPT-', 'ss1'].forEach(function (secret) {
    assert.strictEqual(lines[0].indexOf(secret), -1, secret);
  });
});

test('Issue #864: 台帳の読み取りに失敗しても計測ログは出て、一覧は返る', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  ctx.sandbox.OptionOrderRepository.listAll = function () { throw new Error('boom'); };
  var result = ctx.sandbox.getAdminBookings();
  assert.ok(result.bookings.some(function (b) { return b.bookingId === id; }));
  assert.strictEqual(typeof result.serverTiming.totalMs, 'number');
  assert.strictEqual(result.serverTiming.optionOrdersRows, undefined, '未計測の項目はキー自体を付けない');
});

/* ---------- Issue #864: 一覧取得内でのスプレッドシート共有 ---------- */

function countOpenById_(ctx, fn) {
  var original = ctx.globals.SpreadsheetApp.openById;
  var count = 0;
  ctx.globals.SpreadsheetApp.openById = function () { count += 1; return original.apply(this, arguments); };
  try {
    return { result: fn(), count: count };
  } finally {
    ctx.globals.SpreadsheetApp.openById = original;
  }
}

function stripTiming_(result) {
  var copy = JSON.parse(JSON.stringify(result));
  delete copy.serverTiming;
  return copy;
}

test('Issue #864: getAdminBookingsはスプレッドシートを1回だけ開き、Bookings・OptionOrdersの両方に使う', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id);
  var measured = countOpenById_(ctx, function () { return ctx.sandbox.getAdminBookings(); });
  assert.strictEqual(measured.count, 1, 'openByIdは一覧取得1回につき1回');
  assert.strictEqual(typeof measured.result.serverTiming.spreadsheetOpenMs, 'number');
  assert.strictEqual(measured.result.serverTiming.optionOrdersRows, 1);
});

test('Issue #864: スプレッドシート共有の有無で一覧の結果（予約・オプション状態・件数）は変わらない', function () {
  var ctx = setup();
  var withOption = createRoom(ctx);
  addOrder(ctx, withOption);
  addOrder(ctx, withOption, { category: 'EQUIPMENT_RENTAL', approvalStatus: 'APPROVED', status: 'PENDING_PAYMENT', paymentStatus: 'NOT_STARTED' });
  createRoom(ctx, { brand: 'snb', paymentMethod: 'オンラインクレジットカード' });
  createRoom(ctx, { paymentMethod: 'オンラインクレジットカード', startTime: '15:00' });

  var shared = ctx.sandbox.getAdminBookings();

  /* 変更前の動き（各Repositoryが自分でスプレッドシートを開く）を再現して比較する。 */
  var originalListAll = ctx.sandbox.OptionOrderRepository.listAll;
  var originalGetAll = ctx.sandbox.SpreadsheetRepository.getAllBookings;
  ctx.sandbox.OptionOrderRepository.listAll = function (stats) { return originalListAll(stats); };
  ctx.sandbox.SpreadsheetRepository.getAllBookings = function () { return originalGetAll(); };
  var separate = countOpenById_(ctx, function () { return ctx.sandbox.getAdminBookings(); });

  assert.strictEqual(separate.count, 3, '変更前の再現では一覧用1回＋各Repository1回ずつ開く（前提確認）');
  assert.deepStrictEqual(stripTiming_(shared), stripTiming_(separate.result));
  assert.strictEqual(shared.bookings.length, 3);
});

test('Issue #864: 引数なしのgetAllBookings/listAllは従来どおり自分で開き、渡したときと同じ内容を返す', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id);
  var own = countOpenById_(ctx, function () {
    return { bookings: ctx.sandbox.SpreadsheetRepository.getAllBookings(), orders: ctx.sandbox.OptionOrderRepository.listAll() };
  });
  assert.strictEqual(own.count, 2);
  var spreadsheet = ctx.globals.SpreadsheetApp.openById('ss1');
  var injected = countOpenById_(ctx, function () {
    return { bookings: ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: spreadsheet }), orders: ctx.sandbox.OptionOrderRepository.listAll(undefined, spreadsheet) };
  });
  assert.strictEqual(injected.count, 0);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(injected.result)), JSON.parse(JSON.stringify(own.result)));
});

test('Issue #864: スプレッドシートを開けないときは従来どおり一覧の取得が失敗する', function () {
  var ctx = setup();
  createRoom(ctx);
  ctx.globals.SpreadsheetApp.openById = function () { throw new Error('open failed'); };
  assert.throws(function () { ctx.sandbox.getAdminBookings(); }, /open failed/);
});

test('Issue #979: 一覧専用のTIMEZONE取得は未設定・正常値・空値・不正値で従来と同値', function () {
  var ctx = setup();
  var properties = ctx.globals.PropertiesService.getScriptProperties();
  var config = ctx.sandbox.BookingConfig;
  assert.strictEqual(config.getTimezone(), config.DEFAULTS.TIMEZONE);
  assert.strictEqual(config.getTimezone(), config.getAvailabilityConfig().timezone);
  ['America/New_York', '', 'Invalid/Timezone'].forEach(function (value) {
    properties.setProperty('TIMEZONE', value);
    assert.strictEqual(config.getTimezone(), value || config.DEFAULTS.TIMEZONE);
    assert.strictEqual(config.getTimezone(), config.getAvailabilityConfig().timezone);
  });
});

test('Issue #979: 77件の一覧とサマリを維持し、一覧の設定読取をTIMEZONEだけにする', function () {
  var ctx = setup();
  var sandbox = ctx.sandbox;
  var bookingId = createRoom(ctx, { paymentMethod: 'オンラインクレジットカード' });
  addOrder(ctx, bookingId);
  var record = sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  for (var index = 1; index < 77; index += 1) {
    sandbox.SpreadsheetRepository.appendBooking(Object.assign({}, record, {
      bookingId: 'TEST-979-' + index,
      paymentMethod: '現金'
    }));
  }

  var timezone = sandbox.BookingConfig.getTimezone;
  var properties = ctx.globals.PropertiesService.getScriptProperties();
  var getProperty = properties.getProperty;
  var reads = [];
  sandbox.PropertiesService.getScriptProperties = function () {
    return {
      getProperty: function (key) {
        reads.push(key);
        return getProperty.call(properties, key);
      }
    };
  };
  // Script Propertiesの読取1回を1msとする仮想時計で、実環境の揺れに依存せず区間の差を検証する。
  var fixedNow = Date.now();
  sandbox.Date = class extends Date {
    constructor(...args) {
      super(...(args.length ? args : [fixedNow]));
    }

    static now() {
      return fixedNow + reads.length;
    }
  };

  var actual = JSON.parse(JSON.stringify(sandbox.getAdminBookings()));
  assert.strictEqual(actual.serverTiming.configMs, 1);
  assert.strictEqual(reads[0], 'TIMEZONE');

  sandbox.BookingConfig.getTimezone = function () {
    return sandbox.BookingConfig.getAvailabilityConfig().timezone;
  };
  reads.length = 0;
  var previous = JSON.parse(JSON.stringify(sandbox.getAdminBookings()));
  sandbox.BookingConfig.getTimezone = timezone;
  assert.ok(previous.serverTiming.configMs > actual.serverTiming.configMs);

  assert.strictEqual(actual.serverTiming.bookingRows, 77);
  assert.strictEqual(actual.serverTiming.bookingsColumns, sandbox.BookingsSchema.HEADERS.length);
  ['bookingsSheetMs', 'bookingsValuesReadMs', 'bookingsConvertMs'].forEach(function (key) {
    assert.ok(Number.isFinite(actual.serverTiming[key]), key);
  });
  assert.strictEqual(actual.serverTiming.ttlConfigReads, 1);
  assert.strictEqual(actual.bookings.length, 77);
  var cardBooking = actual.bookings.find(function (booking) { return booking.bookingId === bookingId; });
  assert.ok(cardBooking.cardPaymentDueAt);
  assert.strictEqual(cardBooking.isCardPayment, true);
  assert.ok(cardBooking.effectivePriceAmount > 0);
  assert.strictEqual(cardBooking.optionSummary.state, 'PENDING_APPROVAL');
  assert.deepStrictEqual(
    { ...actual, serverTiming: undefined },
    { ...previous, serverTiming: undefined }
  );
});

test('Issue #981: 計測ありでも行順・Date値・欠損列を維持し、台帳を1回だけ読む', function () {
  var ctx = setup();
  var date = new Date('2026-11-19T10:00:00+09:00');
  var values = [['bookingId', 'createdAt'], ['first', date], ['', ''], ['last', date]];
  var reads = 0;
  var spreadsheet = {
    getSheetByName: function () {
      return {
        getLastRow: function () { return values.length; },
        getDataRange: function () {
          return { getValues: function () { reads += 1; return values; } };
        }
      };
    }
  };
  var repository = ctx.sandbox.SpreadsheetRepository;
  var withoutStats = repository.getAllBookings({ spreadsheet: spreadsheet });
  var stats = {};
  var rows = repository.getAllBookings({ spreadsheet: spreadsheet, stats: stats });
  assert.strictEqual(reads, 2);
  assert.deepStrictEqual(rows, withoutStats);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].record.createdAt, date);
  assert.strictEqual(rows[1].record.bookingId, '');
  assert.strictEqual(rows[2].rowNumber, 4);
  assert.strictEqual(rows[2].record.status, undefined);
  assert.strictEqual(stats.bookingsColumns, 2);

  values = [values[0]];
  assert.strictEqual(repository.getAllBookings({ spreadsheet: spreadsheet, stats: {} }).length, 0);
  spreadsheet.getSheetByName = function () { throw new Error('sheet read failed'); };
  assert.throws(function () { repository.getAllBookings({ spreadsheet: spreadsheet, stats: {} }); }, /sheet read failed/);
});

test('Issue #981: 計測ログに失敗しても一覧と集計値を返す', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  ctx.globals.Logger.log = function () { throw new Error('logger unavailable'); };
  var result = ctx.sandbox.getAdminBookings();
  assert.strictEqual(result.bookings[0].bookingId, id);
  assert.ok(result.serverTiming.bookingsColumns > 0);
});

/* ---- #981 案A: 一覧専用opt-in（skipLastRowCheck）で通常経路のgetLastRowを省く ---- */

function createLedgerSpreadsheet(state) {
  /* state: { sheet: null|{values, lastRow}, calls: [], readError } */
  var spreadsheet = {
    getSheetByName: function () {
      state.calls.push('getSheetByName');
      if (!state.sheet) return null;
      return {
        getLastRow: function () { state.calls.push('getLastRow'); return state.sheet.lastRow; },
        appendRow: function (row) { state.calls.push('appendRow'); state.appended = row; },
        getDataRange: function () {
          state.calls.push('getDataRange');
          return {
            getValues: function () {
              state.calls.push('getValues');
              if (state.readError) throw new Error(state.readError);
              return state.sheet.values;
            }
          };
        }
      };
    },
    insertSheet: function () {
      state.calls.push('insertSheet');
      state.sheet = { values: [['']], lastRow: 0 };
      return spreadsheet.getSheetByName();
    }
  };
  return spreadsheet;
}

function plain(value) { return JSON.parse(JSON.stringify(value)); }

function ledgerCases(ctx) {
  var bookingHeaders = ctx.sandbox.BookingsSchema.HEADERS;
  var orderHeaders = ['optionOrderId', 'bookingId', 'brand'];
  return [
    { name: 'Bookings', headers: bookingHeaders, read: function (ss, extra) {
      return ctx.sandbox.SpreadsheetRepository.getAllBookings(Object.assign({ spreadsheet: ss }, extra));
    }, optIn: { skipLastRowCheck: true } },
    { name: 'OptionOrders', headers: orderHeaders, read: function (ss, extra) {
      return ctx.sandbox.OptionOrderRepository.listAll(undefined, ss, extra);
    }, optIn: { skipLastRowCheck: true } }
  ];
}

test('Issue #981 案A: 内容のある既存シートではgetLastRowを呼ばず、結果は従来と同一', function () {
  var ctx = setup();
  var date = new Date('2026-11-19T10:00:00+09:00');
  ledgerCases(ctx).forEach(function (ledger) {
    var values = [['h1', 'h2'], ['first', date], ['', ''], ['last', date]];
    var baseline = { calls: [], sheet: { values: values, lastRow: values.length } };
    var expected = ledger.read(createLedgerSpreadsheet(baseline), undefined);
    assert.ok(baseline.calls.indexOf('getLastRow') !== -1, ledger.name + ' 既定はgetLastRowを呼ぶ');

    var state = { calls: [], sheet: { values: values, lastRow: values.length } };
    var actual = ledger.read(createLedgerSpreadsheet(state), ledger.optIn);
    assert.deepStrictEqual(state.calls, ['getSheetByName', 'getDataRange', 'getValues'], ledger.name);
    assert.deepStrictEqual(plain(actual), plain(expected), ledger.name);
    assert.strictEqual(actual.length, 3);
    assert.strictEqual(actual[2].rowNumber, 4);
    assert.strictEqual(actual[0].record.h2, undefined);
  });
});

test('Issue #981 案A: spreadsheetを渡しただけ／opt-in=falseではOptionOrdersもgetLastRowを呼ぶ', function () {
  var ctx = setup();
  [undefined, {}, { skipLastRowCheck: false }, { skipLastRowCheck: 'true' }].forEach(function (extra) {
    var state = { calls: [], sheet: { values: [['h'], ['x']], lastRow: 2 } };
    ctx.sandbox.OptionOrderRepository.listAll(undefined, createLedgerSpreadsheet(state), extra);
    assert.deepStrictEqual(state.calls, ['getSheetByName', 'getLastRow', 'getDataRange', 'getValues']);
  });
});

test('Issue #981 案A: ヘッダーのみは書込みなしで空配列（getLastRowは呼ばない）', function () {
  var ctx = setup();
  ledgerCases(ctx).forEach(function (ledger) {
    var state = { calls: [], sheet: { values: [['a', 'b']], lastRow: 1 } };
    assert.deepStrictEqual(plain(ledger.read(createLedgerSpreadsheet(state), ledger.optIn)), [], ledger.name);
    assert.deepStrictEqual(state.calls, ['getSheetByName', 'getDataRange', 'getValues']);
  });
});

test('Issue #981 案A: シート未存在は従来どおり作成してヘッダー追記し空配列', function () {
  var ctx = setup();
  ledgerCases(ctx).forEach(function (ledger) {
    var optInState = { calls: [], sheet: null };
    var baselineState = { calls: [], sheet: null };
    assert.deepStrictEqual(plain(ledger.read(createLedgerSpreadsheet(optInState), ledger.optIn)), []);
    assert.deepStrictEqual(plain(ledger.read(createLedgerSpreadsheet(baselineState), undefined)), []);
    assert.strictEqual(optInState.calls.filter(function (c) { return c === 'insertSheet'; }).length, 1, ledger.name);
    assert.strictEqual(optInState.calls.filter(function (c) { return c === 'appendRow'; }).length, 1, ledger.name);
    assert.deepStrictEqual(plain(optInState.appended), plain(baselineState.appended), ledger.name);
    assert.ok(optInState.appended.length > 0);
  });
});

test('Issue #981 案A: 空シート（[[""]]）はgetLastRow=0でヘッダー追記、従来と同じ副作用', function () {
  var ctx = setup();
  ledgerCases(ctx).forEach(function (ledger) {
    var optInState = { calls: [], sheet: { values: [['']], lastRow: 0 } };
    var baselineState = { calls: [], sheet: { values: [['']], lastRow: 0 } };
    assert.deepStrictEqual(plain(ledger.read(createLedgerSpreadsheet(optInState), ledger.optIn)), []);
    ledger.read(createLedgerSpreadsheet(baselineState), undefined);
    assert.deepStrictEqual(plain(optInState.appended), plain(baselineState.appended), ledger.name);
    assert.strictEqual(optInState.calls.filter(function (c) { return c === 'appendRow'; }).length, 1, ledger.name);
    assert.ok(optInState.calls.indexOf('getLastRow') !== -1, ledger.name);
  });
});

test('Issue #981 案A: A1が空文字を返す数式のみ（getLastRow=1）は追記せず従来と同一結果', function () {
  var ctx = setup();
  ledgerCases(ctx).forEach(function (ledger) {
    var optInState = { calls: [], sheet: { values: [['']], lastRow: 1 } };
    var baselineState = { calls: [], sheet: { values: [['']], lastRow: 1 } };
    var actual = ledger.read(createLedgerSpreadsheet(optInState), ledger.optIn);
    var expected = ledger.read(createLedgerSpreadsheet(baselineState), undefined);
    assert.deepStrictEqual(plain(actual), plain(expected), ledger.name);
    assert.strictEqual(optInState.calls.indexOf('appendRow'), -1, ledger.name);
    assert.strictEqual(baselineState.calls.indexOf('appendRow'), -1, ledger.name);
  });
});

test('Issue #981 案A: 読取例外は従来と同じメッセージで伝播する（getValues失敗）', function () {
  var ctx = setup();
  ledgerCases(ctx).forEach(function (ledger) {
    var state = { calls: [], sheet: { values: [['h'], ['x']], lastRow: 2 }, readError: 'sheet read failed' };
    assert.throws(function () { ledger.read(createLedgerSpreadsheet(state), ledger.optIn); }, /sheet read failed/, ledger.name);
    state = { calls: [], sheet: { values: [['h'], ['x']], lastRow: 2 }, readError: 'sheet read failed' };
    assert.throws(function () { ledger.read(createLedgerSpreadsheet(state), undefined); }, /sheet read failed/, ledger.name);
  });
});

test('Issue #981 案A: getLastRow自体が例外のときの差（opt-in経路は読取成功なら例外にならない）を明示', function () {
  var ctx = setup();
  var values = [['h'], ['x']];
  var spreadsheet = createLedgerSpreadsheet({ calls: [], sheet: { values: values, lastRow: 2 } });
  var original = spreadsheet.getSheetByName;
  spreadsheet.getSheetByName = function () {
    var sheet = original();
    sheet.getLastRow = function () { throw new Error('lastRow failed'); };
    return sheet;
  };
  /* 従来経路: getLastRowの例外が先に出る。opt-in経路: getValuesが成功すれば例外にならない（唯一の異常系差）。 */
  assert.throws(function () { ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: spreadsheet }); }, /lastRow failed/);
  assert.strictEqual(
    ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: spreadsheet, skipLastRowCheck: true }).length, 1
  );
});

test('Issue #981 案A: getAdminBookingsだけがopt-inを指定し、他の呼出しは既定のまま', function () {
  var ctx = setup();
  createRoom(ctx);
  var seen = { bookings: [], options: [] };
  var bookingsRepo = ctx.sandbox.SpreadsheetRepository;
  var optionsRepo = ctx.sandbox.OptionOrderRepository;
  var originalGetAll = bookingsRepo.getAllBookings;
  var originalListAll = optionsRepo.listAll;
  bookingsRepo.getAllBookings = function (options) { seen.bookings.push(options); return originalGetAll(options); };
  optionsRepo.listAll = function (stats, spreadsheet, listOptions) {
    seen.options.push(listOptions);
    return originalListAll(stats, spreadsheet, listOptions);
  };
  var result = ctx.sandbox.getAdminBookings();
  assert.strictEqual(result.bookings.length, 1);
  assert.strictEqual(seen.bookings[0].skipLastRowCheck, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(seen.options[0])), { skipLastRowCheck: true });
  bookingsRepo.getAllBookings = originalGetAll;
  optionsRepo.listAll = originalListAll;
  assert.strictEqual(optionsRepo.listByBookingId('none').length, 0);
});
