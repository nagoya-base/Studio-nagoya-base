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

/* ---------- Issue #981 案A: 一覧専用のgetLastRow削減（opt-in） ---------- */

/* Sheets呼出しを記録する疑似シート。rowsが空のときgetDataRange().getValues()はA1だけの[['']]を返す（実Sheetsと同じ形）。 */
function createSpySheet_(initialRows, options) {
  var opts = options || {};
  var sheet = {
    rows: initialRows.map(function (row) { return row.slice(); }),
    calls: [],
    getLastRow: function () {
      sheet.calls.push('getLastRow');
      if (opts.lastRowThrows) throw new Error('lastRow failed');
      return opts.lastRowOverride !== undefined ? opts.lastRowOverride : sheet.rows.length;
    },
    appendRow: function (row) { sheet.calls.push('appendRow'); sheet.rows.push(row.slice()); },
    getDataRange: function () {
      sheet.calls.push('getDataRange');
      return {
        getValues: function () {
          sheet.calls.push('getValues');
          if (opts.valuesThrows) throw new Error('values failed');
          return sheet.rows.length ? sheet.rows.map(function (row) { return row.slice(); }) : [['']];
        }
      };
    }
  };
  return sheet;
}

function createSpySpreadsheet_(sheetsByName) {
  var spreadsheet = {
    calls: [],
    getSheetByName: function (name) {
      spreadsheet.calls.push('getSheetByName');
      return Object.prototype.hasOwnProperty.call(sheetsByName, name) ? sheetsByName[name] : null;
    },
    insertSheet: function (name) {
      spreadsheet.calls.push('insertSheet');
      sheetsByName[name] = createSpySheet_([]);
      return sheetsByName[name];
    }
  };
  return spreadsheet;
}

function bookingsHeaders_(ctx) { return JSON.parse(JSON.stringify(ctx.sandbox.BookingsSchema.HEADERS)); }

var SPY_CASES = [
  { name: 'シート未存在', make: function () { return null; } },
  { name: '空シート', make: function () { return []; } },
  { name: 'ヘッダーのみ', make: function (headers) { return [headers]; } },
  { name: 'データあり', make: function (headers) { return [headers, headers.map(function (h, i) { return i === 0 ? 'row-1' : ''; })]; } }
];

function runBookingsCase_(ctx, spyCase, useFlag) {
  var headers = bookingsHeaders_(ctx);
  var rows = spyCase.make(headers);
  var sheets = {};
  var sheet = null;
  if (rows) { sheet = createSpySheet_(rows); sheets.Bookings = sheet; }
  var spreadsheet = createSpySpreadsheet_(sheets);
  var options = { spreadsheet: spreadsheet };
  if (useFlag) options.deferLastRowCheck = true;
  var result = ctx.sandbox.SpreadsheetRepository.getAllBookings(options);
  var finalSheet = sheets.Bookings;
  return {
    result: JSON.parse(JSON.stringify(result)),
    sheetCalls: finalSheet ? finalSheet.calls.slice() : [],
    spreadsheetCalls: spreadsheet.calls.slice(),
    finalRows: finalSheet ? JSON.parse(JSON.stringify(finalSheet.rows)) : null
  };
}

test('Issue #981 案A: Bookingsは正常シートでgetLastRowを呼ばず、結果・読取回数が従来と同じ', function () {
  var ctx = setup();
  var base = runBookingsCase_(ctx, SPY_CASES[3], false);
  var fast = runBookingsCase_(ctx, SPY_CASES[3], true);
  assert.deepStrictEqual(base.sheetCalls, ['getLastRow', 'getDataRange', 'getValues']);
  assert.deepStrictEqual(fast.sheetCalls, ['getDataRange', 'getValues']);
  assert.deepStrictEqual(fast.spreadsheetCalls, ['getSheetByName']);
  assert.deepStrictEqual(fast.result, base.result);
  assert.strictEqual(fast.result.length, 1);
  assert.strictEqual(fast.result[0].rowNumber, 2);
});

test('Issue #981 案A: Bookingsのシート未存在・空・ヘッダーのみは従来と同じ結果・副作用（追加アクセスはあり得る）', function () {
  var ctx = setup();
  SPY_CASES.slice(0, 3).forEach(function (spyCase) {
    var base = runBookingsCase_(ctx, spyCase, false);
    var fast = runBookingsCase_(ctx, spyCase, true);
    assert.deepStrictEqual(fast.result, base.result, spyCase.name);
    assert.deepStrictEqual(fast.finalRows, base.finalRows, spyCase.name + '：作成・ヘッダー追記の最終状態');
    var count = function (calls, name) { return calls.filter(function (c) { return c === name; }).length; };
    assert.strictEqual(count(fast.sheetCalls, 'appendRow'), count(base.sheetCalls, 'appendRow'), spyCase.name + ': appendRow回数');
    assert.strictEqual(count(fast.spreadsheetCalls, 'insertSheet'), count(base.spreadsheetCalls, 'insertSheet'), spyCase.name + ': insertSheet回数');
    assert.deepStrictEqual(fast.result, [], spyCase.name);
  });
  /* 空シート・シート未存在ではヘッダーが追記される（従来と同じ副作用）。 */
  assert.strictEqual(runBookingsCase_(ctx, SPY_CASES[0], true).finalRows.length, 1);
  assert.strictEqual(runBookingsCase_(ctx, SPY_CASES[1], true).finalRows.length, 1);
  assert.strictEqual(runBookingsCase_(ctx, SPY_CASES[2], true).finalRows.length, 1);
});

test('Issue #981 案A: BookingsのA1が空文字を返すがgetLastRow>=1のシートは書込みなし・空配列（従来と同じ）', function () {
  var ctx = setup();
  [false, true].forEach(function (useFlag) {
    var sheet = createSpySheet_([]);
    sheet.getLastRow = function () { sheet.calls.push('getLastRow'); return 1; };
    var spreadsheet = createSpySpreadsheet_({ Bookings: sheet });
    var options = { spreadsheet: spreadsheet };
    if (useFlag) options.deferLastRowCheck = true;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.sandbox.SpreadsheetRepository.getAllBookings(options))), []);
    assert.strictEqual(sheet.calls.indexOf('appendRow'), -1);
  });
});

test('Issue #981 案A: Bookingsのopt-inは明示指定とspreadsheet指定が必要で、省略・false・引数なしは従来どおりgetLastRowを呼ぶ', function () {
  var ctx = setup();
  var headers = bookingsHeaders_(ctx);
  [
    { spreadsheet: true, flag: undefined },
    { spreadsheet: true, flag: false },
    { spreadsheet: true, flag: 'yes' },
    { spreadsheet: false, flag: true }
  ].forEach(function (c) {
    var sheet = createSpySheet_([headers]);
    var spreadsheet = createSpySpreadsheet_({ Bookings: sheet });
    ctx.globals.SpreadsheetApp.openById = function () { return spreadsheet; };
    var options = {};
    if (c.spreadsheet) options.spreadsheet = spreadsheet;
    if (c.flag !== undefined) options.deferLastRowCheck = c.flag;
    ctx.sandbox.SpreadsheetRepository.getAllBookings(options);
    assert.ok(sheet.calls.indexOf('getLastRow') >= 0, JSON.stringify(c));
  });
});

test('Issue #981 案A: Bookingsは読取例外をそのまま投げる／getLastRowだけが例外のときの差は仕様差として固定する', function () {
  var ctx = setup();
  var headers = bookingsHeaders_(ctx);
  var valuesFails = createSpySpreadsheet_({ Bookings: createSpySheet_([headers], { valuesThrows: true }) });
  assert.throws(function () { ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: valuesFails }); }, /values failed/);
  assert.throws(function () { ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: valuesFails, deferLastRowCheck: true }); }, /values failed/);
  /* 既知の差：getLastRowだけが失敗する異常系では、従来は例外、案Aの通常経路ではgetLastRowを呼ばないため読取が成功する。 */
  var lastRowFails = createSpySpreadsheet_({ Bookings: createSpySheet_([headers], { lastRowThrows: true }) });
  assert.throws(function () { ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: lastRowFails }); }, /lastRow failed/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: lastRowFails, deferLastRowCheck: true }))), []);
});

test('Issue #981 案A: Bookingsの計測statsはopt-in時もキー互換で、未存在シートのフォールバック時も値が数値のまま', function () {
  var ctx = setup();
  var headers = bookingsHeaders_(ctx);
  var normalStats = {};
  ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: createSpySpreadsheet_({ Bookings: createSpySheet_([headers]) }), stats: normalStats, deferLastRowCheck: true });
  var fallbackStats = {};
  ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: createSpySpreadsheet_({}), stats: fallbackStats, deferLastRowCheck: true });
  var baseStats = {};
  ctx.sandbox.SpreadsheetRepository.getAllBookings({ spreadsheet: createSpySpreadsheet_({ Bookings: createSpySheet_([headers]) }), stats: baseStats });
  [normalStats, fallbackStats].forEach(function (stats) {
    assert.deepStrictEqual(Object.keys(stats).sort(), Object.keys(baseStats).sort());
    Object.keys(stats).forEach(function (key) { assert.strictEqual(typeof stats[key], 'number', key); assert.ok(isFinite(stats[key]), key); });
  });
});

test('Issue #981 案A: OptionOrdersは正常シートでgetLastRowを呼ばず、結果が従来と同じ。spreadsheet指定だけでは高速化しない', function () {
  var ctx = setup();
  /* OptionOrdersのHEADERS_は非公開のため、1行目＝ヘッダー行・2行目＝データ行の最小形で比較する。 */
  var sheetRows = [['optionOrderId', 'bookingId'], ['OPT-1', 'b-1']];
  function run(callArgs) {
    var sheet = createSpySheet_(sheetRows);
    var spreadsheet = createSpySpreadsheet_({ OptionOrders: sheet });
    var result = callArgs(spreadsheet);
    return { result: JSON.parse(JSON.stringify(result)), calls: sheet.calls.slice(), spreadsheetCalls: spreadsheet.calls.slice() };
  }
  var base = run(function (ss) { return ctx.sandbox.OptionOrderRepository.listAll(undefined, ss); });
  var spreadsheetOnly = run(function (ss) { return ctx.sandbox.OptionOrderRepository.listAll(undefined, ss, undefined); });
  var fast = run(function (ss) { return ctx.sandbox.OptionOrderRepository.listAll(undefined, ss, { deferLastRowCheck: true }); });
  assert.deepStrictEqual(base.calls, ['getLastRow', 'getDataRange', 'getValues']);
  assert.deepStrictEqual(spreadsheetOnly.calls, base.calls);
  assert.deepStrictEqual(fast.calls, ['getDataRange', 'getValues']);
  assert.deepStrictEqual(fast.spreadsheetCalls, ['getSheetByName']);
  assert.deepStrictEqual(fast.result, base.result);
  assert.strictEqual(fast.result[0].rowNumber, 2);
  /* openedSpreadsheetなしでflagだけ渡しても高速化しない（引数なしの既存利用者は不変）。 */
  var sheet = createSpySheet_(sheetRows);
  ctx.globals.SpreadsheetApp.openById = function () { return createSpySpreadsheet_({ OptionOrders: sheet }); };
  ctx.sandbox.OptionOrderRepository.listAll(undefined, undefined, { deferLastRowCheck: true });
  assert.ok(sheet.calls.indexOf('getLastRow') >= 0);
});

test('Issue #981 案A: OptionOrdersのシート未存在・空・ヘッダーのみは従来と同じ結果・副作用', function () {
  var ctx = setup();
  var cases = [
    function () { return null; },
    function () { return []; },
    function () { return [['optionOrderId']]; }
  ];
  cases.forEach(function (make, index) {
    function run(withFlag) {
      var rows = make();
      var sheets = {};
      if (rows) sheets.OptionOrders = createSpySheet_(rows);
      var spreadsheet = createSpySpreadsheet_(sheets);
      var result = withFlag
        ? ctx.sandbox.OptionOrderRepository.listAll(undefined, spreadsheet, { deferLastRowCheck: true })
        : ctx.sandbox.OptionOrderRepository.listAll(undefined, spreadsheet);
      var s = sheets.OptionOrders;
      var calls = s ? s.calls : [];
      return {
        result: JSON.parse(JSON.stringify(result)),
        finalRows: JSON.parse(JSON.stringify(s.rows)),
        appends: calls.filter(function (c) { return c === 'appendRow'; }).length,
        inserts: spreadsheet.calls.filter(function (c) { return c === 'insertSheet'; }).length
      };
    }
    var base = run(false);
    var fast = run(true);
    assert.deepStrictEqual(fast, base, 'ケース' + index);
    assert.deepStrictEqual(fast.result, []);
  });
});

test('Issue #981 案A: OptionOrdersのA1空文字・getLastRow>=1は書込みなし（従来と同じ）', function () {
  var ctx = setup();
  [false, true].forEach(function (useFlag) {
    var sheet = createSpySheet_([]);
    sheet.getLastRow = function () { sheet.calls.push('getLastRow'); return 1; };
    var spreadsheet = createSpySpreadsheet_({ OptionOrders: sheet });
    var result = useFlag
      ? ctx.sandbox.OptionOrderRepository.listAll(undefined, spreadsheet, { deferLastRowCheck: true })
      : ctx.sandbox.OptionOrderRepository.listAll(undefined, spreadsheet);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), []);
    assert.strictEqual(sheet.calls.indexOf('appendRow'), -1);
  });
});

test('Issue #981 案A: getAdminBookingsは両台帳でgetLastRowを呼ばず、結果は従来経路と同一。他の呼出し元は従来どおり', function () {
  var ctx = setup();
  var withOption = createRoom(ctx);
  addOrder(ctx, withOption);
  createRoom(ctx, { brand: 'snb', paymentMethod: 'オンラインクレジットカード' });

  var original = ctx.globals.SpreadsheetApp.openById;
  var lastRowCalls = 0;
  ctx.globals.SpreadsheetApp.openById = function () {
    var spreadsheet = original.apply(this, arguments);
    var getSheetByName = spreadsheet.getSheetByName;
    spreadsheet.getSheetByName = function (name) {
      var sheet = getSheetByName.apply(this, arguments);
      if (!sheet || sheet.__spied) return sheet;
      var getLastRow = sheet.getLastRow;
      sheet.getLastRow = function () { lastRowCalls += 1; return getLastRow.apply(this, arguments); };
      sheet.__spied = true;
      return sheet;
    };
    return spreadsheet;
  };

  var fast = ctx.sandbox.getAdminBookings();
  assert.strictEqual(lastRowCalls, 0, '一覧の通常経路ではgetLastRowを呼ばない');

  /* 従来経路（opt-inを外した呼出し）と比較して、予約・オプション状態・件数が同一であること。 */
  var originalListAll = ctx.sandbox.OptionOrderRepository.listAll;
  var originalGetAll = ctx.sandbox.SpreadsheetRepository.getAllBookings;
  ctx.sandbox.OptionOrderRepository.listAll = function (stats, spreadsheet) { return originalListAll(stats, spreadsheet); };
  ctx.sandbox.SpreadsheetRepository.getAllBookings = function (options) { return originalGetAll({ spreadsheet: options && options.spreadsheet, stats: options && options.stats }); };
  lastRowCalls = 0;
  var baseline = ctx.sandbox.getAdminBookings();
  assert.strictEqual(lastRowCalls, 2, '従来経路は台帳ごとにgetLastRowを1回呼ぶ（前提確認）');
  assert.deepStrictEqual(stripTiming_(fast), stripTiming_(baseline));
  assert.strictEqual(fast.bookings.length, 2);

  /* 引数なしのgetAllBookings/listAll（返金・招待等の呼出し元）はgetLastRowを呼ぶ従来動作のまま。 */
  ctx.sandbox.OptionOrderRepository.listAll = originalListAll;
  ctx.sandbox.SpreadsheetRepository.getAllBookings = originalGetAll;
  lastRowCalls = 0;
  ctx.sandbox.SpreadsheetRepository.getAllBookings();
  ctx.sandbox.OptionOrderRepository.listAll();
  assert.strictEqual(lastRowCalls, 2);
});

test('Issue #981 案A: OptionOrdersの読取に失敗しても一覧は返り、Studio Xはstate UNKNOWN（従来と同じ）', function () {
  var ctx = setup();
  var id = createRoom(ctx);
  addOrder(ctx, id);
  var original = ctx.globals.SpreadsheetApp.openById;
  ctx.globals.SpreadsheetApp.openById = function () {
    var spreadsheet = original.apply(this, arguments);
    var getSheetByName = spreadsheet.getSheetByName;
    spreadsheet.getSheetByName = function (name) {
      var sheet = getSheetByName.apply(this, arguments);
      if (sheet && name === 'OptionOrders') {
        return Object.assign({}, sheet, { getDataRange: function () { throw new Error('options read failed'); } });
      }
      return sheet;
    };
    return spreadsheet;
  };
  var item = listItem(ctx, id);
  assert.strictEqual(item.optionSummary.state, 'UNKNOWN');
  assert.strictEqual(item.optionSummary.available, false);
});
