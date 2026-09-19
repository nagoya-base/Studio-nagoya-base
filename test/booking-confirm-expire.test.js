/*
 * BookingRepository.confirmBooking / expirePendingBookings の統合テスト（Issue #268）。
 * 併せてBookingAdmin.gs / BookingTriggers.gsのグローバル関数配線（confirmBooking(bookingId) /
 * expirePendingBookings()という正式関数名）も検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs',
  'CalendarRepository.gs',
  'Availability.gs',
  'Booking.gs',
  'RateLimiter.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'AdminNotifier.gs',
  'BookingRepository.gs',
  'BookingAdmin.gs',
  'BookingTriggers.gs'
];

var CALENDAR_ID = 'cal1';
var SPREADSHEET_ID = 'ss1';

function setup(options) {
  var opts = options || {};
  var calendarsById = opts.calendarsById || { cal1: { events: [] } };
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign({ CALENDAR_ID: CALENDAR_ID, SPREADSHEET_ID: SPREADSHEET_ID }, opts.properties || {});

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    CacheService: opts.cacheService || stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    ScriptApp: opts.scriptApp || stubs.createScriptAppStub(),
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, calendarsById: calendarsById };
}

function validPayload(overrides) {
  return Object.assign(
    {
      brand: 'studio_x',
      date: '2026-10-01',
      startTime: '10:00',
      durationMinutes: 120,
      name: '山田太郎',
      email: 'taro@example.com',
      phone: '090-1234-5678',
      people: '2名',
      purpose: '緊縛の自主練習',
      paymentMethod: '現金',
      note: '',
      source: 'test'
    },
    overrides || {}
  );
}

function createPending(ctx, overrides) {
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload(overrides));
  assert.strictEqual(result.success, true, 'テスト前提としてPENDING作成に成功しているべき');
  return result.bookingId;
}

/* ---------- confirmBooking ---------- */

test('confirmBooking: PENDING → CONFIRMEDへ遷移し、Calendar/Sheets双方が更新される', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var result = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'CONFIRMED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CONFIRMED');
  assert.ok(stubs.isDateLike(found.record.confirmedAt));

  var event = ctx.calendarsById.cal1.events[0];
  assert.strictEqual(event.getTag('status'), 'CONFIRMED');
});

test('confirmBooking: 正式関数名 confirmBooking(bookingId) がグローバルに存在する（Issue #268本文の要件）', function () {
  var ctx = setup();
  assert.strictEqual(typeof ctx.sandbox.confirmBooking, 'function');
});

test('confirmBooking: 二重実行しても壊れない（2回目はalreadyConfirmed:trueで成功扱い）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var first = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(first.success, true);

  var second = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.alreadyConfirmed, true);
  assert.strictEqual(second.status, 'CONFIRMED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CONFIRMED');
});

test('confirmBooking: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup();
  var result = ctx.sandbox.confirmBooking('SX-NOT-EXIST');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

test('confirmBooking: CANCELLED/EXPIREDからの確定は不正な状態遷移として拒否する', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { status: 'EXPIRED', expiredAt: new Date() });

  var result = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
});

test('confirmBooking: 対応するCalendarイベントが見つからない場合はCONFIRMEDにせずrecoveryへ記録する', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  var event = ctx.calendarsById.cal1.events[0];
  event.deleteEvent(); /* Calendar側だけ何らかの理由で消えてしまったケースを再現 */

  var result = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CALENDAR_EVENT_MISSING');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING', '確定できなかった場合はPENDINGのまま');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CONFIRM_CALENDAR_EVENT_MISSING');
});

test('confirmBooking: Lock取得に失敗した場合はLOCK_TIMEOUTを返す', function () {
  var lockService = stubs.createLockServiceStub({ forceTryLockFail: true });
  var ctx = setup({ lockService: lockService });
  var result = ctx.sandbox.BookingRepository.confirmBooking('SX-anything');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
});

/* ---------- expirePendingBookings ---------- */

test('expirePendingBookings: 受付から24時間経過したPENDINGはEXPIREDになり、Calendarイベントも削除される', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, { date: '2026-10-05', startTime: '10:00' });

  var justBefore = new Date(Date.now());
  /* createdAtを25時間前に書き換えて「24時間経過」をシミュレートする */
  var createdAt25hAgo = new Date(Date.now() - 25 * 3600000);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: createdAt25hAgo });

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');
  assert.ok(stubs.isDateLike(found.record.expiredAt));

  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 0);
  void justBefore;
});

test('expirePendingBookings: 24時間未満でも、利用開始2時間前を過ぎたPENDINGはEXPIREDになる（start-2h上限）', function () {
  var ctx = setup();
  /* 開始時刻を1時間後に設定（TTL24h未満だが「開始2時間前」を過ぎている） */
  var soonStart = new Date(Date.now() + 3600000);
  /* date/startTimeは営業時間内の値であれば何でもよい（後でstartAtを直接上書きするため）。
     実際の判定に使うのはstartAt（更新後の値）。 */
  var bookingId = createPending(ctx, {
    date: '2026-12-01',
    startTime: '10:00',
    durationMinutes: 120
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, {
    startAt: soonStart,
    createdAt: new Date(Date.now() - 3600000) /* 受付は1時間前。24hには遠く満たない */
  });

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 1, '開始2時間前を過ぎているためTTL24h未満でも失効するべき');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');
});

test('expirePendingBookings: TTL・開始2時間前のいずれにも該当しないPENDINGはそのまま残す', function () {
  var ctx = setup();
  var farFutureDate = new Date(Date.now() + 10 * 24 * 3600000).toISOString().slice(0, 10);
  var bookingId = createPending(ctx, { date: farFutureDate, startTime: '10:00' });

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 0);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 1);
});

test('expirePendingBookings: 正式関数名 expirePendingBookings() がグローバルに存在する（時間主導トリガー用）', function () {
  var ctx = setup();
  assert.strictEqual(typeof ctx.sandbox.expirePendingBookings, 'function');
});

test('expirePendingBookings: 二重実行しても壊れない（2回目は対象0件で冪等）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 25 * 3600000) });

  var first = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(first.expiredCount, 1);

  var second = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(second.expiredCount, 0, '既にEXPIRED化された行を再度処理してはいけない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');
});

test('expirePendingBookings: Calendarイベント削除に失敗してもSheets側はEXPIREDへ進め、recoveryへ記録する', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 25 * 3600000) });

  ctx.sandbox.CalendarRepository.deleteEventById = function () {
    throw new Error('simulated calendar delete failure');
  };

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 1, 'Calendar削除失敗でもSheets側はEXPIREDへ進めるべき');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'EXPIRE_CALENDAR_DELETE_FAILED');
});

test('createExpirePendingBookingsTrigger: トリガーを作成し、二重作成しない', function () {
  var scriptApp = stubs.createScriptAppStub();
  var ctx = setup({ scriptApp: scriptApp });

  ctx.sandbox.createExpirePendingBookingsTrigger();
  ctx.sandbox.createExpirePendingBookingsTrigger();

  var triggers = scriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'expirePendingBookings'; });
  assert.strictEqual(triggers.length, 1, '同じハンドラのトリガーを重複作成しない');
});
