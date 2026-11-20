/*
 * Issue #989 検証専用テスト: Bookings＋OptionOrders を Sheets API `values.batchGet` で一括読取できるか。
 *
 * 目的は「本番に接続せずに、batchGetの値表現が getValues() と同じ getAdminBookings() 全体を返し得るかを
 * 証明または反証する」こと。本番コード（BookingAdminWeb.gs / SpreadsheetRepository.gs /
 * OptionOrderRepository.gs / manifest配布）は一切変更していない。API・Spreadsheet・Advanced Serviceへは
 * 接続せず、Googleの公式仕様に基づく合成レスポンス（test/helpers/sheets-batchget-model-989.js）だけを使う。
 * ローカルNodeのスタブ結果は本番の速度を意味しない（速度効果は未確認）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var model = require('./helpers/sheets-batchget-model-989');
var deployment = require('./helpers/booking-deployment-manifest');
var prepare = require('../scripts/prepare-booking-gas-project');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs',
  'BookingPricing.gs', 'CardPayment.gs', 'MembershipRules.gs', 'EquipmentCatalog.gs', 'BookingOptions.gs', 'StripeGateway.gs',
  'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs', 'RecoveryRepository.gs',
  'FeeCalculator.gs', 'FeeSettlementRepository.gs', 'BookingReschedule.gs', 'StripeEventRepository.gs',
  'BookingMailTemplates.gs', 'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs',
  'BookingRepository.gs', 'AdminNotifier.gs', 'BookingAdminAlerts.gs', 'BookingRefund.gs',
  'BookingAdmin.gs', 'BookingAdminWeb.gs'
];

var JST = 9 * 3600000;
var FIXED_NOW_MILLIS = Date.parse('2026-11-19T15:30:00Z'); // 2026-11-20 00:30 JST
var RealDate = Date;
function FixedDate() {
  if (!(this instanceof FixedDate)) return new RealDate(FIXED_NOW_MILLIS).toString();
  if (arguments.length === 0) return new RealDate(FIXED_NOW_MILLIS);
  return new (Function.prototype.bind.apply(RealDate, [null].concat(Array.prototype.slice.call(arguments))))();
}
FixedDate.prototype = RealDate.prototype;
FixedDate.now = function () { return FIXED_NOW_MILLIS; };
FixedDate.UTC = RealDate.UTC;
FixedDate.parse = RealDate.parse;

/* ---------- 架空フィクスチャ（実予約・本番Spreadsheetは使わない） ---------- */

function pad2(n) { return n < 10 ? '0' + n : String(n); }
function jst(y, m, d, h, mi, s, ms) {
  return new RealDate(y + '-' + pad2(m) + '-' + pad2(d) + 'T' + pad2(h || 0) + ':' + pad2(mi || 0) + ':' + pad2(s || 0) + '.' + ('00' + (ms || 0)).slice(-3) + '+09:00');
}

/* 78件（104列）。Date・数値・Boolean・先頭ゼロ文字列・空値・日付境界・文字列createdAtを意図的に混在させる。 */
function makeBookingRecords() {
  var statuses = ['PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED'];
  var out = [];
  for (var i = 0; i < 78; i++) {
    var month = i < 40 ? 12 : 11;
    var day = 1 + (i % 28);
    var card = i % 3 === 0;
    var brand = i % 7 === 0 ? 'mens' : (i % 5 === 0 ? 'snb' : 'studio_x');
    var largeParty = i % 26 === 13;
    out.push({
      bookingId: 'SX-2026' + pad2(month) + pad2(day) + '-FIX' + ('0000' + i).slice(-5),
      createdAt: jst(2026, 11, 1 + (i % 17), 9 + (i % 10), i % 60, i % 60),
      date: jst(2026, month, day),
      startAt: jst(2026, month, day, 10 + (i % 8), 0),
      endAt: jst(2026, month, day, 12 + (i % 8), 30),
      brand: brand, name: '架空 太郎' + i, email: 'dummy' + i + '@example.com', phone: '0901234' + ('0000' + i).slice(-4),
      people: largeParty ? '6名' : (1 + (i % 4)) + '名', purpose: 'テスト', paymentMethod: card ? 'オンラインクレジットカード' : '現金',
      status: statuses[i % 4], calendarEventId: 'ev-' + i, source: 'test', note: '',
      customerType: i % 2 ? 'first' : 'returning',
      confirmedMailSentAt: i % 4 === 1 ? jst(2026, 11, 12, 10, 0) : '',
      paymentStatus: card ? 'not_started' : '',
      priceAmount: i % 6 === 0 ? 0 : 3000 + i * 10, priceOverrideAmount: i % 11 === 0 ? 2500 : '',
      priceOverrideAt: i % 11 === 0 ? jst(2026, 11, 15, 12, 0) : '',
      scheduleChangeCount: 0, paymentLinkSendCount: 0,
      largeParty: largeParty, partySurcharge: largeParty ? 1000 : 0,
      largePartyApprovalStatus: largeParty ? 'APPROVED' : '',
      largePartyApprovedAt: largeParty ? jst(2026, 11, 18, 9, 0) : '',
      largePartyPaymentDueAt: largeParty ? jst(2026, 11, 19, 9, 0) : '',
      revision: i
    });
  }
  /* 日付・時刻の境界（ミリ秒・日跨ぎ・年越し・00:00開始・23:59終了）と、過去の混在データ（文字列createdAt）。 */
  out[1].createdAt = jst(2026, 11, 18, 23, 59, 59, 999);
  out[1].startAt = jst(2026, 12, 5, 23, 0); out[1].endAt = jst(2026, 12, 6, 0, 0); out[1].date = jst(2026, 12, 5);
  out[2].date = jst(2026, 12, 31); out[2].startAt = jst(2026, 12, 31, 0, 0); out[2].endAt = jst(2026, 12, 31, 23, 59);
  out[3].date = jst(2027, 1, 1); out[3].startAt = jst(2027, 1, 1, 0, 0); out[3].endAt = jst(2027, 1, 1, 3, 0);
  out[4].createdAt = '2026-11-10T00:30:00.000Z';
  out[6].createdAt = '2026-11-10 09:30';
  out[8].createdAt = 'not-a-date';
  out[9].date = '2026-12-09'; /* 日付列が文字列のまま（過去データ） */
  return out;
}

function makeOptionOrders(bookings) {
  var ids = [0, 1, 2, 4, 12].map(function (i) { return bookings[i].bookingId; });
  var statuses = [
    ['PENDING_APPROVAL', 'NOT_STARTED', 'PENDING_APPROVAL'], ['APPROVED', 'NOT_STARTED', 'AWAITING_PAYMENT'],
    ['APPROVED', 'PAID', 'CONFIRMED'], ['DECLINED', 'NOT_STARTED', 'DECLINED'], ['APPROVED', 'NOT_STARTED', 'AWAITING_PAYMENT']
  ];
  return ids.map(function (id, n) {
    return {
      bookingId: id, optionOrderId: 'OPT-FIX' + ('00000' + n).slice(-5), brand: 'studio_x', source: 'WITH_BOOKING', currency: 'JPY',
      customerEmail: 'dummy@example.com', category: n % 2 ? 'EQUIPMENT' : 'STAFF_SERVICE',
      items: n % 2 ? ['EQ:COB_BICOLOR:4'] : ['STAFF_PRE_SETUP:EQUIPMENT', 'STAFF_CLEANUP:EQUIPMENT'],
      amountJpy: 2000 + n * 600, approvalStatus: statuses[n][0], paymentStatus: statuses[n][1], status: statuses[n][2],
      createdAt: jst(2026, 11, 11, 9, 0), updatedAt: jst(2026, 11, 11, 9, n),
      approvedAt: n === 1 || n === 2 ? jst(2026, 11, 12, 9, 0) : '', paidAt: n === 2 ? jst(2026, 11, 13, 9, 0) : ''
    };
  });
}

/* ---------- 「現行getValues」世界 ---------- */

/*
 * 同じ入力で何度でも世界を作る。world.byId は SpreadsheetApp スタブの実体。
 * mutateGrids: 読込み後に生のシート行へ手を入れる（過去の混在データの再現用）。
 */
function createWorld(options) {
  options = options || {};
  var byId = { ss1: {} };
  var baseApp = stubs.createSpreadsheetAppStub(byId);
  var current = baseApp;
  var app = { openById: function (id) { return current.openById(id); } };
  var globals = {
    Date: FixedDate,
    PropertiesService: stubs.createPropertiesServiceStub({
      CALENDAR_ID: 'cal1', SPREADSHEET_ID: 'ss1', BOOKING_MAIL_DISPLAY_NAME: 'Studio X',
      BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com'
    }),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(),
    LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: app,
    MailApp: stubs.createMailAppStub(),
    UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripe呼び出しは想定外'); }),
    Logger: stubs.createLoggerStub()
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  var bookings = options.bookings || makeBookingRecords();
  bookings.forEach(function (r) { sandbox.SpreadsheetRepository.appendBooking(Object.assign({}, r)); });
  if (options.withOptionOrders !== false) {
    sandbox.OptionOrderRepository.appendOrders(makeOptionOrders(bookings).map(function (o) { return Object.assign({}, o); }));
  }
  if (options.mutate) options.mutate(byId.ss1);
  return {
    sandbox: sandbox, byId: byId, baseApp: baseApp,
    useApp: function (next) { current = next || baseApp; },
    /* getValues() が返す矩形配列（モデルへの入力）。 */
    grid: function (name) { return model.rectangularize(byId.ss1[name]._rows.map(function (r) { return r.slice(); })); }
  };
}

function normalize(result) {
  var copy = JSON.parse(JSON.stringify(result));
  assert.ok(copy.serverTiming && typeof copy.serverTiming === 'object', 'serverTimingは存在し、比較から除外するキーはこれだけ');
  delete copy.serverTiming;
  return copy;
}

function describeCell(v) {
  return model.isDate(v) ? 'Date:' + v.getTime() : typeof v + ':' + String(v);
}
/* vm realm由来の配列とNode realmの配列をdeepStrictEqualで比べられるよう、JSON往復でprototypeを揃える。 */
function describeGrid(grid) {
  return JSON.parse(JSON.stringify(Array.prototype.map.call(grid, function (row) { return Array.prototype.map.call(row, describeCell); })));
}

function specOf(world) {
  return [
    { range: "'Bookings'!A1:CZ", title: 'Bookings', grid: world.grid('Bookings') },
    { range: "'OptionOrders'!A1:AC", title: 'OptionOrders', grid: world.grid('OptionOrders') }
  ];
}

var BOOKING_DATE_FORMATS = { date: 'DATE' };
var MODES = {
  FORMATTED_VALUE: { valueRenderOption: 'FORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' },
  SERIAL: { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER' },
  FORMATTED_STRING: { valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING' }
};
function renderOpts(mode, extra) {
  return Object.assign({ dateFormatByHeader: BOOKING_DATE_FORMATS }, MODES[mode], extra || {});
}

/* 候補経路: 合成batchGet → アダプタ → 注入 → 本物の getAdminBookings。 */
function runCandidate(world, api, adapter, adapterOpts) {
  var plan = model.planLedgerRead(api, 'ss1', adapter, adapterOpts);
  var counters = {};
  if (plan.source === 'batchGet') {
    world.useApp(model.wrapSpreadsheetApp(world.baseApp, { Bookings: plan.bookings, OptionOrders: plan.options }, counters));
  } else {
    world.useApp(world.baseApp);
  }
  var result = world.sandbox.getAdminBookings();
  world.useApp(world.baseApp);
  return { plan: plan, result: result, counters: counters };
}

function responseApi(world, mode, extra) {
  var calls = { n: 0 };
  var response = model.buildValueRanges(specOf(world), renderOpts(mode, extra));
  return { calls: calls, batchGet: function () { calls.n++; return response; } };
}

function naiveSerial(extra) {
  return function (values, opts) { return { ok: true, values: model.naiveSerialAdapter(values, Object.assign({}, opts, extra || {})) }; };
}

/* ---------- 1. ベースライン固定 ---------- */

test('baseline: 78件×104列・5件×29列の架空データが現行getValues経路でJSON化できる（型の混在を含む）', function () {
  var world = createWorld();
  var bookings = world.grid('Bookings');
  var options = world.grid('OptionOrders');
  assert.strictEqual(bookings.length, 1 + 78);
  assert.strictEqual(bookings[0].length, 104);
  assert.strictEqual(options.length, 1 + 5);
  assert.strictEqual(options[0].length, 29);

  var kinds = {};
  bookings.slice(1).forEach(function (row) { row.forEach(function (v) { kinds[model.isDate(v) ? 'Date' : (v === '' ? 'empty' : typeof v)] = true; }); });
  assert.deepStrictEqual(Object.keys(kinds).sort(), ['Date', 'boolean', 'empty', 'number', 'string']);

  var result = normalize(world.sandbox.getAdminBookings());
  assert.strictEqual(result.bookings.length, 78);
  assert.ok(result.bookings.some(function (b) { return b.cardPaymentDueAt; }), 'カード期限が出力に現れる');
  assert.ok(result.bookings.some(function (b) { return b.optionSummary && b.optionSummary.state === 'CONFIRMED'; }), 'オプション状態が出力に現れる');
  assert.ok(result.bookings.some(function (b) { return b.largeParty === true; }), '大人数予約が出力に現れる');
});

/* ---------- 2. 値表現の非互換（batchGet単独では getValues() の型を復元できない） ---------- */

test('FORMATTED_VALUE: Dateセル・数値・真偽値が文字列へ潰れ、同じ見た目の「元から文字列のセル」と区別できない', function () {
  var opts = renderOpts('FORMATTED_VALUE');
  var grid = [
    ['createdAt', 'phone', 'people', 'flag'],
    [jst(2026, 12, 1, 10, 0), '2026/12/01 10:00:00', '123', 'TRUE'],
    ['x', 'x', 'x', 'x']
  ];
  var dateRow = [['createdAt'], [jst(2026, 12, 1, 10, 0)]];
  var textRow = [['createdAt'], ['2026/12/01 10:00:00']];
  assert.deepStrictEqual(model.renderValues(dateRow, opts), model.renderValues(textRow, opts), 'Dateセルと日付形式の文字列セルが同一の応答になる');
  assert.notStrictEqual(describeCell(dateRow[1][0]), describeCell(textRow[1][0]), 'getValues()では型が違う（Date と string）');

  assert.deepStrictEqual(model.renderValues([['n'], [123]], opts), model.renderValues([['n'], ['123']], opts), '数値123と文字列"123"');
  assert.deepStrictEqual(model.renderValues([['b'], [true]], opts), model.renderValues([['b'], ['TRUE']], opts), '真偽値trueと文字列"TRUE"');
  assert.ok(grid.length);
});

test('UNFORMATTED+SERIAL_NUMBER: Dateセルと同じ値の「ただの数値セル」が同一の応答になり、型を復元できない', function () {
  var opts = renderOpts('SERIAL');
  var instant = jst(2026, 12, 1, 10, 0);
  var serial = model.serialFromDate(instant, JST);
  assert.deepStrictEqual(model.renderValues([['createdAt'], [instant]], opts), model.renderValues([['createdAt'], [serial]], opts));
  assert.notStrictEqual(describeCell(instant), describeCell(serial));
  /* 日付文字列は文字列のまま・先頭ゼロ文字列も保たれる（ここは getValues() と一致）。 */
  assert.deepStrictEqual(model.renderValues([['phone', 'createdAt'], ['0901234567', '2026-11-10 09:30']], opts), [['phone', 'createdAt'], ['0901234567', '2026-11-10 09:30']]);
});

test('UNFORMATTED+FORMATTED_STRING: Dateセルが書式付き文字列になり、元から文字列のセルと区別できない（数値・真偽値は型を保つ）', function () {
  var opts = renderOpts('FORMATTED_STRING');
  assert.deepStrictEqual(
    model.renderValues([['createdAt'], [jst(2026, 12, 1, 10, 0)]], opts),
    model.renderValues([['createdAt'], ['2026/12/01 10:00:00']], opts)
  );
  assert.deepStrictEqual(model.renderValues([['n', 'b'], [123, true]], opts), [['n', 'b'], [123, true]]);
});

test('FORMATTED系ではミリ秒が失われ、getValues()のDateと瞬間が一致しない（createdAt 23:59:59.999）', function () {
  var original = jst(2026, 11, 18, 23, 59, 59, 999);
  var formatted = model.renderValues([['createdAt'], [original]], renderOpts('FORMATTED_VALUE'))[1][0];
  assert.strictEqual(formatted, '2026/11/18 23:59:59');
  var restored = model.naiveFormattedAdapter([['createdAt'], [formatted]], {})[1][0];
  assert.notStrictEqual(restored.getTime(), original.getTime());
  assert.strictEqual(original.getTime() - restored.getTime(), 999);
});

test('固定オフセットを超えて壁時計→瞬間を解決する場合（DST）、曖昧な時刻が2つの瞬間に対応する', function () {
  /* America/New_York 2026-11-01 01:30（夏時間終了で2回現れる）。Googleがどちらを返すかはこのモデルでは確認できない。 */
  var edt = new RealDate('2026-11-01T05:30:00Z'); // 01:30 EDT (UTC-4)
  var est = new RealDate('2026-11-01T06:30:00Z'); // 01:30 EST (UTC-5)
  var fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  assert.strictEqual(fmt.format(edt), fmt.format(est), '壁時計の表示は同一');
  assert.strictEqual(est.getTime() - edt.getTime(), 3600000, '瞬間は1時間ずれる＝シリアル値だけでは一意に戻せない');
});

/* ---------- 3. 素朴な型推測アダプタは過去データ・変異で壊れる（反証と変異テスト） ---------- */

test('素朴なSERIALアダプタ: 日付列がクリーンならgetValues()と型・値まで一致する（互換にできる条件の確認）', function () {
  var world = createWorld();
  var api = responseApi(world, 'SERIAL');
  var legacy = normalize(world.sandbox.getAdminBookings());
  var candidate = runCandidate(world, api, naiveSerial());
  assert.strictEqual(candidate.plan.source, 'batchGet');
  assert.deepStrictEqual(describeGrid(candidate.plan.bookings), describeGrid(world.grid('Bookings')), 'DateはDateのまま（getTime一致）');
  assert.deepStrictEqual(describeGrid(candidate.plan.options), describeGrid(world.grid('OptionOrders')));
  assert.deepStrictEqual(normalize(candidate.result), legacy);
});

test('素朴なSERIALアダプタ: 過去データ（日付列に入った通常の数値）が誤ってDateへ変換され、一覧の戻り値が変わる', function () {
  var world = createWorld({
    mutate: function (sheets) {
      /* 旧データ: createdAtが「日付書式でない数値」、dateがシリアル風の数値のまま保存されている。 */
      var headers = sheets.Bookings._rows[0];
      sheets.Bookings._rows[3][headers.indexOf('createdAt')] = 46000;
      sheets.Bookings._rows[5][headers.indexOf('paymentHoldExpiresAt')] = 12345;
    }
  });
  var legacy = normalize(world.sandbox.getAdminBookings());
  var candidate = runCandidate(world, responseApi(world, 'SERIAL'), naiveSerial());
  assert.strictEqual(candidate.plan.source, 'batchGet', '素朴アダプタは何も疑わず成功扱いにしてしまう');
  assert.notDeepStrictEqual(describeGrid(candidate.plan.bookings), describeGrid(world.grid('Bookings')), 'numberがDateに化ける');
  assert.notDeepStrictEqual(normalize(candidate.result), legacy, 'getAdminBookings全体が一致しない');
});

test('素朴なFORMATTED_VALUEアダプタ: ミリ秒喪失と文字列セルのDate化で、getValues()と一致しない', function () {
  var world = createWorld();
  var legacy = normalize(world.sandbox.getAdminBookings());
  var api = responseApi(world, 'FORMATTED_VALUE');
  var candidate = runCandidate(world, api, function (values, opts) { return { ok: true, values: model.naiveFormattedAdapter(values, opts) }; });
  assert.notDeepStrictEqual(describeGrid(candidate.plan.bookings), describeGrid(world.grid('Bookings')));
  /* 数値・真偽値も文字列になり、amount/boolean判定の型が変わる（例: priceAmount 3000→"3000"、largeParty false→"FALSE"）。 */
  var headers = candidate.plan.bookings[0];
  var row = candidate.plan.bookings[1];
  assert.strictEqual(typeof row[headers.indexOf('priceAmount')], 'string');
  assert.strictEqual(typeof row[headers.indexOf('largeParty')], 'string');
  /* 注意: 一覧のJSONは分単位の文字列へ整形されるため、この架空データでは最終JSONが偶然一致することがある
     （ミリ秒・型の差はJSON化の前に存在する）。そのためIssue #989は「JSON化前にDateの型名とgetTime()を比較する」ことを求めており、
     上のdescribeGrid比較が互換性の判定基準になる。最終JSONの一致だけでは互換の証明にならない。 */
  assert.ok(candidate.result && legacy);
});

test('変異テスト: 日付列・数値列・タイムゾーンの取り違えは getAdminBookings 全体の deepStrictEqual で検出される', function () {
  var world = createWorld();
  var legacy = normalize(world.sandbox.getAdminBookings());
  var cases = {
    'startAt列を日付列として扱わない': { isDateColumn: function (h) { return h !== 'startAt' && (h === 'date' || /At$/.test(h)); } },
    '数値列priceAmountを日付列として扱う': { isDateColumn: function (h) { return h === 'priceAmount' || h === 'date' || /At$/.test(h); } },
    'タイムゾーンをUTCとして扱う': { offsetMs: 0 }
  };
  Object.keys(cases).forEach(function (name) {
    var extra = cases[name];
    var adapter = function (values, opts) {
      var rows = model.rectangularize(values);
      var headers = rows[0];
      var isDateColumn = extra.isDateColumn || function (h) { return h === 'date' || /At$/.test(h); };
      var offset = extra.offsetMs === undefined ? JST : extra.offsetMs;
      return {
        ok: true,
        values: rows.map(function (row, r) {
          return r === 0 ? row : row.map(function (v, c) { return typeof v === 'number' && isDateColumn(headers[c]) ? model.dateFromSerial(v, offset) : v; });
        })
      };
    };
    var candidate = runCandidate(world, responseApi(world, 'SERIAL'), adapter);
    assert.notDeepStrictEqual(normalize(candidate.result), legacy, '変異「' + name + '」が検出されない');
  });
});

/* ---------- 4. fail-closed: 型を証明できなければ必ずレガシーへ ---------- */

test('fail-closedアダプタ: 実データ同様Dateを含む台帳は常に拒否され、レガシーへ最大1回だけ戻り、出力は従来と完全一致する', function () {
  var world = createWorld();
  var legacy = normalize(world.sandbox.getAdminBookings());
  var api = responseApi(world, 'SERIAL');
  var candidate = runCandidate(world, api, model.failClosedSerialAdapter);
  assert.deepStrictEqual({ source: candidate.plan.source, reason: candidate.plan.reason }, { source: 'legacy', reason: 'AMBIGUOUS_NUMERIC_IN_DATE_COLUMN' });
  assert.strictEqual(api.calls.n, 1, 'batchGetは1回だけ（再試行しない）');
  assert.strictEqual(candidate.counters.injectedReads || 0, 0);
  assert.deepStrictEqual(normalize(candidate.result), legacy);
});

test('fail-closedアダプタ: batchGetが採用できるのは「日付セルが1つも無い」台帳だけ（Dateが日常的に存在する本番では実質採用されない）', function () {
  /* 全日付を文字列で保存した台帳（ISO風文字列）。この場合のみ SERIAL 応答は getValues() と一致する。 */
  var textOnly = makeBookingRecords().map(function (r) {
    ['createdAt', 'startAt', 'endAt', 'confirmedMailSentAt', 'priceOverrideAt', 'largePartyApprovedAt', 'largePartyPaymentDueAt', 'date'].forEach(function (k) {
      if (model.isDate(r[k])) r[k] = r[k].toISOString();
    });
    return r;
  });
  var world = createWorld({ bookings: textOnly });
  /* OptionOrdersのDate(createdAt等)は別途存在するため、Bookings側だけを検証対象にする。 */
  var plan = model.planLedgerRead(responseApi(world, 'SERIAL'), 'ss1', model.failClosedSerialAdapter, {});
  assert.strictEqual(plan.source, 'legacy', 'OptionOrders側にDateがあるため全体は拒否');
  var bookingsOnly = model.failClosedSerialAdapter(model.renderValues(world.grid('Bookings'), renderOpts('SERIAL')));
  assert.strictEqual(bookingsOnly.ok, true);
  assert.deepStrictEqual(describeGrid(bookingsOnly.values), describeGrid(world.grid('Bookings')));

  var typical = createWorld();
  var typicalResult = model.failClosedSerialAdapter(model.renderValues(typical.grid('Bookings'), renderOpts('SERIAL')));
  assert.strictEqual(typicalResult.ok, false, '通常のDate混在台帳は拒否');
});

/* ---------- 5. 型メタデータ付き代替（spreadsheets.get + fields） ---------- */

test('grid data(effectiveValue+numberFormat.type): 固定オフセット(JST)ならDate/数値/真偽値/文字列を型ごと復元できる（モデル上）', function () {
  var world = createWorld({
    mutate: function (sheets) {
      var headers = sheets.Bookings._rows[0];
      sheets.Bookings._rows[3][headers.indexOf('createdAt')] = 46000; /* 日付書式でない数値は数値のまま */
    }
  });
  var legacy = normalize(world.sandbox.getAdminBookings());
  var grid = model.buildGridData(specOf(world), { dateFormatByHeader: BOOKING_DATE_FORMATS, offsetMs: JST });
  var b = model.gridDataAdapter(grid.sheets[0], grid.properties, {});
  var o = model.gridDataAdapter(grid.sheets[1], grid.properties, {});
  assert.ok(b.ok && o.ok);
  assert.deepStrictEqual(describeGrid(b.values), describeGrid(world.grid('Bookings')));
  world.useApp(model.wrapSpreadsheetApp(world.baseApp, { Bookings: b.values, OptionOrders: o.values }));
  assert.deepStrictEqual(normalize(world.sandbox.getAdminBookings()), legacy);
  world.useApp(world.baseApp);
});

test('grid data: DST地域のタイムゾーンは拒否し、実Sheetsでの数値書式・タイムゾーン解決・ミリ秒は「未確認」として採用しない', function () {
  var world = createWorld();
  var grid = model.buildGridData(specOf(world), { dateFormatByHeader: BOOKING_DATE_FORMATS, offsetMs: JST, timeZone: 'America/New_York' });
  var refused = model.gridDataAdapter(grid.sheets[0], grid.properties, { fixedOffsetByTimeZone: { 'Asia/Tokyo': JST } });
  assert.deepStrictEqual(refused, { ok: false, reason: 'TIMEZONE_NOT_FIXED_OFFSET' });
});

test('ペイロード評価（合成レスポンスの概算）: grid dataはvalues.batchGetより数倍大きい（このフィクスチャで約5倍）', function () {
  var world = createWorld();
  var spec = specOf(world);
  var valuesBytes = Buffer.byteLength(JSON.stringify(model.buildValueRanges(spec, renderOpts('SERIAL'))));
  var gridBytes = Buffer.byteLength(JSON.stringify(model.buildGridData(spec, { dateFormatByHeader: BOOKING_DATE_FORMATS })));
  assert.ok(gridBytes > valuesBytes * 4, 'grid dataは' + (gridBytes / valuesBytes).toFixed(1) + '倍（values ' + valuesBytes + 'B / grid ' + gridBytes + 'B）');
});

/* ---------- 6. 障害注入・後方互換 ---------- */

function sheetsState(world) {
  var out = {};
  Object.keys(world.byId.ss1).sort().forEach(function (name) { out[name] = describeGrid(world.byId.ss1[name]._rows); });
  return out;
}

var FAILURES = {
  'API 403（権限なし）': function () { var e = new Error('The caller does not have permission'); e.code = 403; throw e; },
  'API 404（シート未存在・範囲解釈不能）': function () { var e = new Error('Requested entity was not found'); e.code = 404; throw e; },
  'API 429（quota）': function () { var e = new Error('Quota exceeded'); e.code = 429; throw e; },
  'API 500': function () { var e = new Error('Internal error'); e.code = 500; throw e; },
  'API 503': function () { var e = new Error('Service unavailable'); e.code = 503; throw e; },
  'Advanced Service未登録（ReferenceError）': function () { throw new ReferenceError('Sheets is not defined'); },
  'ネットワーク例外': function () { throw new Error('Exception: Service invoked too many times'); }
};

Object.keys(FAILURES).forEach(function (name) {
  test('障害注入: ' + name + ' → レガシーへ1回だけ戻り、再試行せず、出力・副作用が従来経路と一致する', function () {
    var legacyWorld = createWorld();
    var legacy = normalize(legacyWorld.sandbox.getAdminBookings());
    var world = createWorld();
    var calls = { n: 0 };
    var api = { batchGet: function () { calls.n++; FAILURES[name](); } };
    var candidate = runCandidate(world, api, naiveSerial());
    assert.strictEqual(candidate.plan.source, 'legacy');
    assert.strictEqual(calls.n, 1, '再試行しない');
    assert.deepStrictEqual(normalize(candidate.result), legacy);
    assert.deepStrictEqual(sheetsState(world), sheetsState(legacyWorld));
  });
});

test('障害注入: Advanced Serviceが無い（api=undefined）→ SERVICE_UNAVAILABLEでレガシー', function () {
  var world = createWorld();
  var plan = model.planLedgerRead(undefined, 'ss1', naiveSerial(), {});
  assert.deepStrictEqual(plan, { source: 'legacy', reason: 'SERVICE_UNAVAILABLE' });
});

test('障害注入: 応答の欠損・行数/範囲/行形式の不整合は成功として流さずレガシーへ', function () {
  var world = createWorld();
  var good = model.buildValueRanges(specOf(world), renderOpts('SERIAL'));
  var broken = {
    'response=null': null,
    'valueRanges無し': {},
    'valueRangesが1件': { valueRanges: [good.valueRanges[0]] },
    'range名の不一致': { valueRanges: [good.valueRanges[1], good.valueRanges[0]] },
    'valuesが配列でない': { valueRanges: [Object.assign({}, good.valueRanges[0], { values: 'x' }), good.valueRanges[1]] },
    '行が配列でない': { valueRanges: [Object.assign({}, good.valueRanges[0], { values: [['bookingId'], 'x'] }), good.valueRanges[1]] }
  };
  Object.keys(broken).forEach(function (name) {
    var plan = model.planLedgerRead({ batchGet: function () { return broken[name]; } }, 'ss1', naiveSerial(), {});
    assert.strictEqual(plan.source, 'legacy', name);
  });
});

test('障害分離: OptionOrdersの読取だけが失敗 → Bookings一覧は返し、Studio XだけUNKNOWN（batchGetが失敗しても同じ）', function () {
  function failOptionsRead(world) {
    var sheet = world.byId.ss1.OptionOrders;
    sheet.getDataRange = function () { return { getValues: function () { throw new Error('read failed'); } }; };
  }
  var legacyWorld = createWorld();
  failOptionsRead(legacyWorld);
  var legacy = normalize(legacyWorld.sandbox.getAdminBookings());
  var studioX = legacy.bookings.filter(function (b) { return b.optionSummary; });
  assert.ok(studioX.length > 0 && studioX.every(function (b) { return b.optionSummary.state === 'UNKNOWN' && b.optionSummary.available === false; }));
  assert.strictEqual(legacy.bookings.length, 78);

  var world = createWorld();
  failOptionsRead(world);
  var api = { batchGet: function () { var e = new Error('boom'); e.code = 500; throw e; } };
  var candidate = runCandidate(world, api, naiveSerial());
  assert.strictEqual(candidate.plan.source, 'legacy');
  assert.deepStrictEqual(normalize(candidate.result), legacy);
});

test('障害分離: Bookingsの読取失敗 → 従来どおり一覧全体が失敗し、エラー内容も一致する', function () {
  function failBookingsRead(world) {
    world.byId.ss1.Bookings.getDataRange = function () { return { getValues: function () { throw new Error('bookings read failed'); } }; };
  }
  var legacyWorld = createWorld();
  failBookingsRead(legacyWorld);
  var legacyError;
  try { legacyWorld.sandbox.getAdminBookings(); } catch (e) { legacyError = e; }
  assert.ok(legacyError);

  var world = createWorld();
  failBookingsRead(world);
  var api = { batchGet: function () { var e = new Error('boom'); e.code = 503; throw e; } };
  var candidateError;
  try { runCandidate(world, api, naiveSerial()); } catch (e) { candidateError = e; }
  assert.ok(candidateError);
  assert.strictEqual(candidateError.message, legacyError.message);
});

test('既存の初期化副作用: OptionOrdersシート未存在 → batchGetは全体失敗扱いでレガシーへ戻り、ensureSheet_が従来どおり作成・ヘッダー追記する', function () {
  var legacyWorld = createWorld({ withOptionOrders: false });
  var legacy = normalize(legacyWorld.sandbox.getAdminBookings());
  assert.ok(legacyWorld.byId.ss1.OptionOrders, '従来経路はシートを作る');
  assert.strictEqual(legacyWorld.byId.ss1.OptionOrders._rows.length, 1, 'ヘッダーだけ追記');

  var world = createWorld({ withOptionOrders: false });
  var api = { batchGet: function () { var e = new Error('Unable to parse range: OptionOrders'); e.code = 400; throw e; } };
  var candidate = runCandidate(world, api, naiveSerial());
  assert.strictEqual(candidate.plan.reason, 'API_ERROR_400');
  assert.deepStrictEqual(normalize(candidate.result), legacy);
  assert.deepStrictEqual(sheetsState(world), sheetsState(legacyWorld));
});

test('既存の初期化副作用: 空シート（valuesなし）はUNINITIALIZED_SHEETとしてレガシーへ戻し、作成・初期化を省略しない', function () {
  var world = createWorld({ withOptionOrders: false });
  world.byId.ss1.OptionOrders = stubs.createSpreadsheetAppStub({ x: {} }).openById('x').insertSheet('OptionOrders'); // 空の既存シート
  var legacyWorld = createWorld({ withOptionOrders: false });
  legacyWorld.byId.ss1.OptionOrders = stubs.createSpreadsheetAppStub({ x: {} }).openById('x').insertSheet('OptionOrders');
  var legacy = normalize(legacyWorld.sandbox.getAdminBookings());

  var response = model.buildValueRanges([
    { range: "'Bookings'!A1:CZ", grid: world.grid('Bookings') },
    { range: "'OptionOrders'!A1:AC", grid: [[]] }
  ], renderOpts('SERIAL'));
  var candidate = runCandidate(world, { batchGet: function () { return response; } }, naiveSerial());
  assert.strictEqual(candidate.plan.reason, 'UNINITIALIZED_SHEET');
  assert.deepStrictEqual(normalize(candidate.result), legacy);
  assert.deepStrictEqual(sheetsState(world), sheetsState(legacyWorld));
  assert.strictEqual(world.byId.ss1.OptionOrders._rows.length, 1);
});

test('構造互換: ヘッダーのみ・余剰列・途中空行・末尾空セル省略でも、getValues()と同じrowNumber・件数・値になる（Date非含有の台帳）', function () {
  function mutate(sheets) {
    var rows = sheets.Bookings._rows;
    rows.length = 6; /* ヘッダー＋5件に縮める */
    rows.splice(3, 0, rows[0].map(function () { return ''; })); /* 途中の空行 */
    rows.forEach(function (r, i) { if (i > 0) r.length = r.length; r.push(i === 0 ? 'extraColumn' : ''); }); /* 余剰列（行ごとに末尾へ） */
    rows[1][rows[1].length - 1] = 'extra-value';
    for (var i = 1; i < rows.length; i++) {
      for (var c = 0; c < rows[i].length; c++) if (model.isDate(rows[i][c])) rows[i][c] = rows[i][c].toISOString();
    }
  }
  var world = createWorld({ mutate: mutate, withOptionOrders: false });
  world.byId.ss1.OptionOrders = null; delete world.byId.ss1.OptionOrders;
  var legacyWorld = createWorld({ mutate: mutate, withOptionOrders: false });
  var legacy = normalize(legacyWorld.sandbox.getAdminBookings());

  var spec = [
    { range: "'Bookings'", grid: world.grid('Bookings') },
    { range: "'OptionOrders'", grid: [['optionOrderId', 'bookingId']] }
  ];
  var response = model.buildValueRanges(spec, renderOpts('SERIAL'));
  assert.ok(response.valueRanges[0].values.some(function (r) { return r.length === 0; }), '途中空行は [] として返る');
  var plan = model.planLedgerRead({ batchGet: function () { return response; } }, 'ss1', model.failClosedSerialAdapter, {});
  assert.strictEqual(plan.source, 'batchGet', 'Dateなし台帳だけはfail-closedでも成功する');
  assert.deepStrictEqual(describeGrid(plan.bookings), describeGrid(world.grid('Bookings')), '矩形化後の形・rowNumberの対応が一致');
  assert.strictEqual(plan.bookings.length, world.grid('Bookings').length);
});

test('読取途中の変更: 現行は2回の読取が逐次で、台帳間のスナップショットは保証されない（batchGetも原子性を主張しない）', function () {
  var world = createWorld();
  var bookingsSheet = world.byId.ss1.Bookings;
  var optionsSheet = world.byId.ss1.OptionOrders;
  var originalRead = optionsSheet.getDataRange;
  var mutated = false;
  optionsSheet.getDataRange = function () {
    var range = originalRead.call(optionsSheet);
    return { getValues: function () {
      var values = range.getValues();
      if (!mutated) { mutated = true; bookingsSheet._rows.pop(); } /* OptionOrders読取の直後にBookingsが変わる */
      return values;
    } };
  };
  var result = normalize(world.sandbox.getAdminBookings());
  assert.strictEqual(result.bookings.length, 77, '現行はOptionOrders読取→Bookings読取の順で、後から読むBookingsの変更を反映する');
});

/* ---------- 7. 本番経路・配布・権限は変更していない ---------- */

test('ガード: 本番のgasコードはSheets API(Advanced Service/REST)を使っておらず、Adminの必須OAuthスコープも増えていない', function () {
  var root = path.join(__dirname, '..', 'gas', 'booking');
  var offenders = [];
  ['shared', 'public', 'admin', 'webhook'].forEach(function (dir) {
    fs.readdirSync(path.join(root, dir)).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (file) {
      var source = fs.readFileSync(path.join(root, dir, file), 'utf8');
      if (/Sheets\.Spreadsheets|values:batchGet|sheets\.googleapis\.com|\.batchGet\(/.test(source)) offenders.push(dir + '/' + file);
    });
  });
  assert.deepStrictEqual(offenders, []);
  assert.deepStrictEqual(prepare.ADMIN_REQUIRED_OAUTH_SCOPES, ['https://www.googleapis.com/auth/script.external_request']);
  deployment.BOOKING_ADMIN_FILES.forEach(function (file) {
    assert.ok(!/batchget|sheets-model/i.test(file), '検証ヘルパーはGASへ配布されない: ' + file);
  });
});
