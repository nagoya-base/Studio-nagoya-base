/*
 * BookingRepository.createBooking の統合テスト（Issue #268）。
 * Config/CalendarRepository/Availability/Booking/RateLimiter/SpreadsheetRepository/
 * RecoveryRepository/AdminNotifier/BookingRepository をまとめてvm実行し、
 * 実際にCalendar・Spreadsheetへ書き込む処理順・部分失敗補償・rate limit・LockServiceの
 * 使用を検証する。CalendarApp/SpreadsheetApp/LockService/CacheService/MailAppはすべてスタブ。
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
  'BookingRepository.gs'
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
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, calendarsById: calendarsById, globals: globals };
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

test('createBooking: 正常な入力でPENDINGの予約が作成される（送信即CONFIRMEDにならない）', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'PENDING');
  assert.ok(result.bookingId);
});

test('createBooking: bookingIdはCalendarイベントのタグとSheets行の両方に同じ値で保存される', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());
  assert.strictEqual(result.success, true);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.ok(found, 'Sheetsにbooking行が保存されているべき');
  assert.strictEqual(found.record.status, 'PENDING');

  var calendarEvent = ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); })[0];
  assert.strictEqual(calendarEvent.getTag('bookingId'), result.bookingId);
  assert.strictEqual(calendarEvent.getTag('status'), 'PENDING');
  assert.strictEqual(found.record.calendarEventId, calendarEvent.getId());
});

test('createBooking: Calendarイベントのタイトル・説明に氏名・メール等のPIIを含めない', function () {
  var ctx = setup();
  ctx.sandbox.BookingRepository.createBooking(validPayload({ name: '極秘太郎', email: 'himitsu@example.com' }));
  var event = ctx.calendarsById.cal1.events[0];
  assert.strictEqual(event.getTitle().indexOf('極秘太郎'), -1);
  assert.strictEqual(event.getTitle().indexOf('himitsu@example.com'), -1);
});

test('createBooking: studio_x以外のbrandは作成を拒否し、Calendar/Sheetsに何も作らない', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ brand: 'snb' }));

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_BRAND');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
});

test('createBooking: 入力不正（不正な日付）はCalendar再取得すら行わずに拒否する', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ date: 'invalid' }));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_DATE');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
});

test('#267との境界: getAvailabilityでは空きだったのに、その後Calendarに別予定(スペースマーケット由来含む)が入った場合、createBooking直前の再確認で検出して拒否し、PENDINGイベント・Sheets行のどちらも作らない', function () {
  var ctx = setup();

  /* 1. フロントでgetAvailability相当を呼んだ時点では空き（イベント無し） */
  var busyBefore = ctx.sandbox.CalendarRepository.getBusyIntervalsForDate(CALENDAR_ID, '2026-10-01', 'Asia/Tokyo');
  assert.strictEqual(busyBefore.length, 0);

  /* 2. その後、スペースマーケット由来の同一Calendar上の予定が直接追加される
        （タイトルに一切依存しないことを示すため、あえてSM専用の接頭辞を付けない） */
  ctx.calendarsById.cal1.events.push(
    stubs.createEventStub({
      start: new Date('2026-10-01T10:30:00+09:00'),
      end: new Date('2026-10-01T11:30:00+09:00'),
      isAllDay: false,
      title: '【予約完了】スペースマーケット由来の予定'
    })
  );

  /* 3〜4. createBooking実行。Lock取得後の再取得でこの予定を検出するはず */
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ startTime: '10:00', durationMinutes: 120 }));

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'SLOT_CONFLICT');

  /* 7〜8. PENDINGイベント・Sheets行のどちらも作られていない（元々あった1件のみ） */
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 1, 'スペースマーケット予定以外に新規イベントが作られてはいけない');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
});

test('#267との境界: 管理者手入力・自社予約由来の占有もタイトルに関わらず同様に競合として検出する', function () {
  ['予約あり 手入力', 'その他の予定', ''].forEach(function (title) {
    var ctx = setup();
    ctx.calendarsById.cal1.events.push(
      stubs.createEventStub({
        start: new Date('2026-10-01T10:30:00+09:00'),
        end: new Date('2026-10-01T11:30:00+09:00'),
        isAllDay: false,
        title: title
      })
    );
    var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ startTime: '10:00', durationMinutes: 120 }));
    assert.strictEqual(result.success, false, JSON.stringify(title));
    assert.strictEqual(result.error.code, 'SLOT_CONFLICT');
  });
});

test('LockService: createBooking中はLockを取得し、成功・失敗いずれの場合も最終的に解放する', function () {
  var lockService = stubs.createLockServiceStub();
  var ctx = setup({ lockService: lockService });

  ctx.sandbox.BookingRepository.createBooking(validPayload());
  assert.strictEqual(lockService._isHeld(), false, '成功後はLockが解放されているべき');

  ctx.calendarsById.cal1.events.push(
    stubs.createEventStub({ start: new Date('2026-10-01T10:30:00+09:00'), end: new Date('2026-10-01T11:30:00+09:00'), isAllDay: false })
  );
  ctx.sandbox.BookingRepository.createBooking(validPayload({ startTime: '10:00', durationMinutes: 120, email: 'other@example.com' }));
  assert.strictEqual(lockService._isHeld(), false, '競合で失敗した場合もLockが解放されているべき');
});

test('LockService: Lock取得に失敗した場合はLOCK_TIMEOUTを返し、Calendar/Sheetsへ何も作らない（同時createBooking対策）', function () {
  var lockService = stubs.createLockServiceStub({ forceTryLockFail: true });
  var ctx = setup({ lockService: lockService });

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
});

test('同時createBooking: 同時刻・重複する2件を続けて送ると、2件目はLock取得後の再確認で競合検出され拒否される（二重予約防止）', function () {
  var ctx = setup();
  var first = ctx.sandbox.BookingRepository.createBooking(validPayload({ email: 'a@example.com' }));
  var second = ctx.sandbox.BookingRepository.createBooking(validPayload({ email: 'b@example.com' }));

  assert.strictEqual(first.success, true);
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.error.code, 'SLOT_CONFLICT');
  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 1);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 1);
});

test('rate limit: 同一メール10分以内3件を超えるとRATE_LIMITEDで拒否する', function () {
  var ctx = setup();
  var now = Date.parse('2026-09-20T00:00:00+09:00');
  var originalNow = Date.now;
  var dates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
  try {
    for (var i = 0; i < 3; i++) {
      Date.now = function () { return now + i * 1000; };
      /* 日付を毎回変えてスロット競合(SLOT_CONFLICT)を避け、rate limit判定のみを検証する */
      var r = ctx.sandbox.BookingRepository.createBooking(validPayload({ date: dates[i], email: 'same@example.com' }));
      assert.strictEqual(r.success, true, '1〜3件目は許可されるべき (i=' + i + ')');
    }
    Date.now = function () { return now + 4000; };
    var fourth = ctx.sandbox.BookingRepository.createBooking(validPayload({ date: dates[3], email: 'same@example.com' }));
    assert.strictEqual(fourth.success, false);
    assert.strictEqual(fourth.error.code, 'RATE_LIMITED');
    assert.strictEqual(fourth.error.reason, 'EMAIL_RATE_LIMIT');
  } finally {
    Date.now = originalNow;
  }
});

test('rate limit: 全体で1分あたり20件を超えると異なるメールでもRATE_LIMITEDで拒否する', function () {
  var ctx = setup();
  var now = Date.parse('2026-09-20T00:00:00+09:00');
  var originalNow = Date.now;
  try {
    for (var i = 0; i < 20; i++) {
      Date.now = function () { return now + i; };
      var r = ctx.sandbox.BookingRepository.createBooking(
        validPayload({ startTime: '08:00', durationMinutes: 120, email: 'user' + i + '@example.com', brand: 'studio_x' })
      );
      /* 実際の空き競合は無視し、rate limitのみに注目する（durationMinutes固定・startTime固定で
         2件目以降はSLOT_CONFLICTになりうるため、rate limit自体はCalendar確認より前段の
         RateLimiter.evaluateで先に判定されることだけを確認する） */
      assert.notStrictEqual(r.error && r.error.code, 'RATE_LIMITED', '20件目まではグローバル制限に達しないはず (i=' + i + ')');
    }
    Date.now = function () { return now + 21; };
    var overLimit = ctx.sandbox.BookingRepository.createBooking(
      validPayload({ startTime: '08:00', durationMinutes: 120, email: 'user21@example.com' })
    );
    assert.strictEqual(overLimit.success, false);
    assert.strictEqual(overLimit.error.code, 'RATE_LIMITED');
    assert.strictEqual(overLimit.error.reason, 'GLOBAL_RATE_LIMIT');
  } finally {
    Date.now = originalNow;
  }
});

test('rate limit: 同一内容(email+date+startTime+durationMinutes)の連投はDUPLICATE_SUBMISSIONで拒否する', function () {
  var ctx = setup();
  var payload = validPayload({ email: 'dup@example.com' });
  var first = ctx.sandbox.BookingRepository.createBooking(payload);
  assert.strictEqual(first.success, true);

  var duplicate = ctx.sandbox.BookingRepository.createBooking(payload);
  assert.strictEqual(duplicate.success, false);
  assert.strictEqual(duplicate.error.code, 'RATE_LIMITED');
  assert.strictEqual(duplicate.error.reason, 'DUPLICATE_SUBMISSION');
});

test('部分失敗補償: Calendar成功・Sheets失敗時はCalendarイベントを補償削除し、recoveryへCOMPENSATED記録を残す', function () {
  var ctx = setup();
  /* SpreadsheetRepository.appendBookingを強制的に失敗させる */
  var originalAppend = ctx.sandbox.SpreadsheetRepository.appendBooking;
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('simulated sheets failure');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');
  assert.strictEqual(
    ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length,
    0,
    'Sheets失敗時はCalendarイベントが補償削除されているべき'
  );

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE');
  assert.strictEqual(recovered[0].recoveryState, 'RESOLVED');

  ctx.sandbox.SpreadsheetRepository.appendBooking = originalAppend;
});

test('部分失敗補償: Calendar成功・Sheets失敗・Calendar補償削除も失敗した場合はNEEDS_MANUAL_RECOVERYとしてrecoveryへ残す', function () {
  var ctx = setup();
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('simulated sheets failure');
  };
  ctx.sandbox.CalendarRepository.deleteEventById = function () {
    throw new Error('simulated calendar delete failure');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'SHEETS_FAILURE_CALENDAR_ORPHANED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.match(recovered[0].errorMessage, /simulated sheets failure/);
  assert.match(recovered[0].errorMessage, /simulated calendar delete failure/);
});

test('通知失敗: 管理者通知が失敗しても予約自体は成功のままであり、recoveryへ情報として記録される', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('mail server down') });
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, true, '通知失敗は予約失敗として扱わない');
  assert.strictEqual(result.status, 'PENDING');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'ADMIN_NOTIFICATION_FAILED');
});

test('管理者通知: ADMIN_NOTIFICATION_EMAIL未設定なら通知を送らないが、予約自体は成功する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());
  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('管理者通知: ADMIN_NOTIFICATION_EMAIL設定時は氏名・メール等のPIIを含まないメールを送る', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  ctx.sandbox.BookingRepository.createBooking(validPayload({ name: '極秘太郎', email: 'himitsu@example.com' }));

  assert.strictEqual(mailApp._sentEmails.length, 1);
  var sent = mailApp._sentEmails[0];
  assert.strictEqual(sent.to, 'admin@example.com');
  assert.strictEqual(sent.body.indexOf('極秘太郎'), -1);
  assert.strictEqual(sent.body.indexOf('himitsu@example.com'), -1);
});
