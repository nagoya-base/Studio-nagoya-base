/*
 * BookingRepository.confirmBooking / expirePendingBookings の統合テスト（Issue #268）。
 * 併せてBookingAdmin.gs / BookingTriggers.gsのグローバル関数配線（confirmBooking(bookingId) /
 * expirePendingBookings()という正式関数名）も検証する。
 *
 * この2つはいずれもBooking Adminプロジェクト（SPREADSHEET_IDのSpreadsheetへコンテナ
 * バインド）へデプロイする前提のため、このテストファイルでは同一sandbox・同一LockService
 * モックを共有させて検証している（3回目レビュー指摘を受け、confirmBookingと
 * expirePendingBookingsを同一プロジェクトへ統合した設計変更を反映）。
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
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'BookingRepository.gs',
  'BookingAdmin.gs',
  'BookingTriggers.gs',
  'BookingReminderTriggers.gs'
];

var CALENDAR_ID = 'cal1';
var SPREADSHEET_ID = 'ss1';

/* Issue #271でcreateBooking/confirmBookingへ配線した利用者向けメール送信のデフォルト設定値。
   このファイルはメール送信そのものの挙動を検証対象にしていないため、既定で送信成功させ、
   設定不足によるlastMailError系フィールドやRecovery記録が既存のconfirmBooking/
   expirePendingBookingsテストの想定件数へ意図せず混入しないようにする
   （メール自体の検証はtest/booking-mailer.test.js・test/booking-create-booking.test.jsで行う）。 */
var DEFAULT_MAIL_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

/* Asia/Tokyo基準で実行時刻からdaysAhead日後の'YYYY-MM-DD'を返す（Issue #270 3回目
   レビュー指摘対応）。createBookingはnow省略時に実時刻で過去日拒否を行うため、
   validPayload()の既定dateを固定文字列にすると実行日がその日付を過ぎた時点で
   now省略呼び出し（createPending経由を含む）が一斉にINVALID_DATEへ変わり自然故障する。 */
function futureDateJst_(daysAhead) {
  var d = new Date(Date.now() + daysAhead * 24 * 3600000);
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  var out = {};
  parts.forEach(function (part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

/* 「当日/翌日/過去日」という時間条件そのものを検証していない一般テスト用の既定日付。 */
var DEFAULT_FUTURE_DATE = futureDateJst_(60);

function setup(options) {
  var opts = options || {};
  var calendarsById = opts.calendarsById || { cal1: { events: [] } };
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign(
    { CALENDAR_ID: CALENDAR_ID, SPREADSHEET_ID: SPREADSHEET_ID },
    DEFAULT_MAIL_PROPERTIES,
    opts.properties || {}
  );

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    CacheService: opts.cacheService || stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById, { ui: opts.ui, activeSheet: opts.activeSheet }),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    ScriptApp: opts.scriptApp || stubs.createScriptAppStub(),
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, calendarsById: calendarsById, globals: globals };
}

function validPayload(overrides) {
  return Object.assign(
    {
      brand: 'studio_x',
      customerType: 'returning',
      date: DEFAULT_FUTURE_DATE,
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

test('confirmBooking（PRレビュー2回目対応）: BookingMailer.sendConfirmedMailForBookingが想定外の例外を投げても、Loggerへ生のメールアドレスを残さない', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, { email: 'secret@example.com' });

  ctx.sandbox.BookingMailer.sendConfirmedMailForBooking = function () {
    throw new Error('unexpected failure for secret@example.com');
  };

  var result = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(result.success, true, 'CONFIRMEDメール送信中の想定外例外でもconfirmBooking自体は成功する');
  assert.strictEqual(result.mailSent, false);
  assert.strictEqual(result.mailError.message.indexOf('secret@example.com'), -1, '戻り値のmailError.messageにも生のメールアドレスを残さない');

  var logs = ctx.globals.Logger._logs;
  var confirmedMailLogs = logs.filter(function (line) { return line.indexOf('CONFIRMEDメール送信中') !== -1; });
  assert.strictEqual(confirmedMailLogs.length, 1);
  assert.strictEqual(confirmedMailLogs[0].indexOf('secret@example.com'), -1, 'Loggerに生のメールアドレスを残してはいけない');
  assert.match(confirmedMailLogs[0], /\[REDACTED_EMAIL\]/);
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

test('confirmBookingとexpirePendingBookingsは同一Booking AdminプロジェクトのLockServiceを共有するため、片方がLockを保持している間はもう片方がLOCK_TIMEOUTになる（3回目レビュー指摘対応: 別プロジェクト分離によるLock非共有を解消）', function () {
  var lockService = stubs.createLockServiceStub();
  var ctx = setup({ lockService: lockService });
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 25 * 3600000) });

  /* 別プロセス(例えば同時に実行された時間主導トリガー)がLockを保持している状況を模擬する */
  var externalLock = lockService.getScriptLock();
  assert.strictEqual(externalLock.tryLock(), true);

  var confirmResult = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(confirmResult.success, false);
  assert.strictEqual(confirmResult.error.code, 'LOCK_TIMEOUT', 'confirmBookingはexpirePendingBookings側が保持するLockを奪えないべき');

  var expireResult = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(expireResult.expiredCount, 0, 'expirePendingBookingsもLockが空くまで候補を処理できないべき');
  assert.strictEqual(expireResult.skippedCount, 1);

  externalLock.releaseLock();

  /* Lockが解放されれば、どちらも通常どおり処理を進められる */
  var confirmAfterRelease = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(confirmAfterRelease.success, true);
});

test('confirmBooking: Calendar成功(CONFIRMED)・Sheets更新失敗時はCalendarをPENDINGへ補償し、recoveryへRESOLVED記録を残す', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var originalUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function () {
    throw new Error('simulated sheets update failure');
  };

  var result = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CONFIRM_SAVE_FAILED');

  var event = ctx.calendarsById.cal1.events[0];
  assert.strictEqual(event.getTag('status'), 'PENDING', 'Sheets更新失敗時はCalendar側もPENDINGへ補償されているべき');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CALENDAR_ROLLED_BACK_AFTER_CONFIRM_SHEETS_FAILURE');
  assert.strictEqual(recovered[0].recoveryState, 'RESOLVED');

  ctx.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdate;
  /* 元のupdateBookingFieldsに戻した上で、Sheets側が実際にPENDINGのままであることも確認する */
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
});

test('confirmBooking: Calendar成功(CONFIRMED)・Sheets更新失敗・Calendar補償(PENDINGへ戻す)も失敗した場合、Calendar=CONFIRMED/Sheets=PENDINGの不整合をrecoveryへOPENで記録する', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function () {
    throw new Error('simulated sheets update failure');
  };
  ctx.sandbox.CalendarRepository.setEventStatus = function (calendarId, eventId, status) {
    if (status === 'PENDING') throw new Error('simulated calendar revert failure');
    /* CONFIRMEDへの最初の更新自体は成功させる */
    var event = ctx.calendarsById.cal1.events.filter(function (e) { return e.getId() === eventId; })[0];
    event.setTag('status', status);
  };

  var result = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CONFIRM_SAVE_FAILED');

  var event = ctx.calendarsById.cal1.events[0];
  assert.strictEqual(event.getTag('status'), 'CONFIRMED', '補償にも失敗した場合、Calendar側はCONFIRMEDのまま残る（Sheets側はPENDINGのまま不整合）');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CONFIRM_SHEETS_FAILURE_CALENDAR_ORPHANED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.match(recovered[0].errorMessage, /simulated sheets update failure/);
  assert.match(recovered[0].errorMessage, /simulated calendar revert failure/);
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
  var bookingId = createPending(ctx, { date: futureDateJst_(65), startTime: '10:00' });

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
    date: futureDateJst_(70),
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

/* ---------- PENDING TTLと当日予約の整合（Issue #270） ---------- */

test('expirePendingBookings: 当日受付・利用開始まで2時間未満の予約は、作成直後にexpirePendingBookingsを実行しても即EXPIREDにならない（graceによる猶予）', function () {
  var ctx = setup();
  /* JST 2026-10-01 20:00に受付。開始は21:00（1時間後 < minHoursBeforeStart既定2時間）で、
     利用日(date)も受付と同じ2026-10-01（＝当日受付）。 */
  var receivedAt = new Date('2026-10-01T20:00:00+09:00');
  var created = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ customerType: 'returning', date: '2026-10-01', startTime: '21:00', durationMinutes: 120 }),
    receivedAt
  );
  assert.strictEqual(created.success, true, '当日+利用経験ありはPENDING作成に成功する前提');

  /* 受付5分後にTTL失効処理を実行しても、まだEXPIREDにならないべき
     （#268時点の計算式のままだと、開始2時間前(19:00)は受付時刻より過去のため即EXPIREDになっていた）。 */
  var justAfter = new Date(receivedAt.getTime() + 5 * 60000);
  var result = ctx.sandbox.expirePendingBookings(justAfter);
  assert.strictEqual(result.expiredCount, 0, '作成直後に即EXPIREDになってはいけない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(created.bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 1);
});

test('expirePendingBookings: 当日受付・利用開始まで2時間未満の予約は、利用開始時刻を過ぎればEXPIREDになる（graceは利用開始時刻を上限とするため、開始後までPENDINGが残らない）', function () {
  var ctx = setup();
  var receivedAt = new Date('2026-10-01T20:00:00+09:00');
  var startAt = new Date('2026-10-01T21:00:00+09:00');
  var created = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ customerType: 'returning', date: '2026-10-01', startTime: '21:00', durationMinutes: 120 }),
    receivedAt
  );
  assert.strictEqual(created.success, true);

  /* 利用開始（21:00）の1分前はまだPENDINGのままであるべき */
  var justBeforeStart = new Date(startAt.getTime() - 60000);
  var beforeResult = ctx.sandbox.expirePendingBookings(justBeforeStart);
  assert.strictEqual(beforeResult.expiredCount, 0, '利用開始前はまだEXPIREDにしてはいけない');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(created.bookingId).record.status, 'PENDING');

  /* 利用開始（21:00）の1分後にはEXPIREDになっているべき（利用開始後までPENDINGが残らない） */
  var justAfterStart = new Date(startAt.getTime() + 60000);
  var afterResult = ctx.sandbox.expirePendingBookings(justAfterStart);
  assert.strictEqual(afterResult.expiredCount, 1, '利用開始後はEXPIREDになるべき（無期限PENDINGにも利用開始後残留にもしない）');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(created.bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');
});

test('expirePendingBookings: 受付日と利用日(date)が一致しない予約（＝当日受付ではない）はPENDING_TTL_MIN_HOLD_HOURSの対象外のまま、#268時点と同じ計算式でTTLが決まる（既存の翌日以降TTLへの影響なし）', function () {
  var ctx = setup();
  /* 営業時間（08:00〜23:00）の制約上、実際の「翌日以降」予約は受付から開始まで
     必ず数時間以上の余裕がある（当日をまたいで直後に開始する翌日予約は存在し得ない）ため、
     ここでは既存のTTLテスト（このファイルの他のテスト）と同じ方法で、createdAt/startAtを
     直接上書きして「date列と受付日が一致しない」状態を作る。 */
  var bookingId = createPending(ctx, { date: futureDateJst_(120), startTime: '10:00', durationMinutes: 120 });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, {
    createdAt: new Date('2026-11-05T10:00:00+09:00'),
    startAt: new Date('2026-11-05T10:30:00+09:00') /* 受付から30分後に開始（2時間未満） */
  });

  /* record.date（futureDateJst_(120)。実行時刻から120日後のため2026-11-05とは一致しない）と
     受付日(2026-11-05)が一致しないため isSameDayBooking=false。
     #268時点と同じ計算式のまま（開始2時間前 < 受付時刻）で、受付1分後にはもうEXPIREDになる。 */
  var result = ctx.sandbox.expirePendingBookings(new Date('2026-11-05T10:01:00+09:00'));
  assert.strictEqual(result.expiredCount, 1, '当日受付でない場合はminHoldHoursの保護対象外のまま（既存仕様どおり）');
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

test('expirePendingBookings: Calendar削除成功・Sheets EXPIRED更新失敗の場合はrecoveryへ記録し、Sheets側はPENDINGのまま残す', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 25 * 3600000) });

  var originalUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (fields.status === 'EXPIRED') throw new Error('simulated sheets expire update failure');
    return originalUpdate(id, fields);
  };

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 0, 'Sheets更新に失敗した候補はexpiredCountへ数えない');
  assert.strictEqual(result.skippedCount, 1);

  assert.strictEqual(
    ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length,
    0,
    'Calendarイベント自体は削除済みのはず（Sheets更新失敗より前に成功している）'
  );

  ctx.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdate;
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING', 'Sheets更新が失敗したためstatusは更新前のまま残る（Calendar削除済みとの不整合）');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'EXPIRE_SHEETS_UPDATE_FAILED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.match(recovered[0].errorMessage, /simulated sheets expire update failure/);
});

test('expirePendingBookings: EXPIRE_SHEETS_UPDATE_FAILED後、Sheets保存先の障害が解消してから再実行すると、Calendarは既に削除済みとして再記録しつつSheets側は正しくEXPIREDになる（README「部分失敗・recoveryの確認手順」記載の再実行手順の裏付け）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 25 * 3600000) });

  var originalUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (fields.status === 'EXPIRED') throw new Error('simulated sheets expire update failure');
    return originalUpdate(id, fields);
  };
  var first = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(first.expiredCount, 0);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdate; /* 障害解消をシミュレート */

  var second = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(second.expiredCount, 1, '再実行時にSheets保存が復旧していれば正しくEXPIREDへ進むべき');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 2, '1回目のEXPIRE_SHEETS_UPDATE_FAILEDに加え、2回目はCalendarが既に削除済みのためEXPIRE_CALENDAR_DELETE_FAILEDも記録される');
  /* recoveredはvmサンドボックス（別realm）内で生成された配列のため、非strict deepEqualで
     比較する（test/booking-config.test.js・test/booking-spreadsheet-repository.test.jsと同じ理由）。 */
  var failureTypes = [];
  recovered.forEach(function (r) { failureTypes.push(r.failureType); });
  assert.deepEqual(failureTypes.sort(), ['EXPIRE_CALENDAR_DELETE_FAILED', 'EXPIRE_SHEETS_UPDATE_FAILED']);
});

test('expirePendingBookings: 1件のSheets更新失敗が他の失効対象の処理を止めない（バッチ内の障害分離）', function () {
  var ctx = setup();
  var failingBookingId = createPending(ctx, { date: futureDateJst_(80), startTime: '10:00', email: 'a@example.com' });
  var okBookingId = createPending(ctx, { date: futureDateJst_(81), startTime: '10:00', email: 'b@example.com' });

  var oldCreatedAt = new Date(Date.now() - 25 * 3600000);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(failingBookingId, { createdAt: oldCreatedAt });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(okBookingId, { createdAt: oldCreatedAt });

  var originalUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (id === failingBookingId && fields.status === 'EXPIRED') {
      throw new Error('simulated sheets expire update failure');
    }
    return originalUpdate(id, fields);
  };

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 1, '失敗した1件を除く、もう1件は正常にEXPIREDへ進むべき');
  assert.strictEqual(result.skippedCount, 1);

  ctx.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdate;
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(failingBookingId).record.status, 'PENDING');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(okBookingId).record.status, 'EXPIRED');
});

/* ---------- Issue #334: カード決済専用TTL（72時間）・現地決済の回帰 ---------- */

test('expirePendingBookings: カード決済のPENDINGは受付から72時間経過でEXPIREDになる（受付+72hが利用開始-2hより早いケース）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  var createdAt73hAgo = new Date(Date.now() - 73 * 3600000);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: createdAt73hAgo });

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');
});

test('expirePendingBookings: カード決済のPENDINGは受付から72時間経過前はEXPIREDにならない（71時間経過時点ではまだ有効）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  var createdAt71hAgo = new Date(Date.now() - 71 * 3600000);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: createdAt71hAgo });

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 0, '72時間に達していないカードPENDINGを失効させてはいけない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
});

test('expirePendingBookings: 現金/PayPay/未定は引き続き24時間でEXPIREDになる（カードの72時間TTLへ引きずられない回帰確認）', function () {
  var ctx = setup();
  ['現金', 'PayPay', '未定'].forEach(function (paymentMethod, index) {
    var bookingId = createPending(ctx, {
      paymentMethod: paymentMethod,
      date: futureDateJst_(30 + index),
      startTime: '10:00',
      email: 'regression-' + index + '@example.com'
    });
    /* 30時間前＝24時間は超えているが72時間には遠く満たない。カードTTLが漏れ込んでいれば
       まだPENDINGのままになってしまう。 */
    ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 30 * 3600000) });

    var result = ctx.sandbox.expirePendingBookings();
    var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
    assert.strictEqual(found.record.status, 'EXPIRED', paymentMethod + ' は24時間TTLのままEXPIREDになるべき');
    void result;
  });
});

/* ---------- Issue #334: カード決済失効通知メール ---------- */

test('expirePendingBookings: カード決済が新規に失効した回だけEXPIRED専用メールを1通送る。現金等は送らない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });

  var cardId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00',
    email: 'card@example.com'
  });
  var cashId = createPending(ctx, {
    paymentMethod: '現金',
    date: futureDateJst_(31),
    startTime: '10:00',
    email: 'cash@example.com'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(cardId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(cashId, { createdAt: new Date(Date.now() - 25 * 3600000) });
  /* createPending()自体がPENDINGメールを送るため、失効通知の検証対象からは除外する
     （ここから先に送られるメールだけを数える）。 */
  mailApp._sentEmails.length = 0;

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 2);

  assert.strictEqual(mailApp._sentEmails.length, 1, 'EXPIRED通知はカード決済の1通のみであるべき');
  assert.strictEqual(mailApp._sentEmails[0].to, 'card@example.com');
  assert.match(mailApp._sentEmails[0].subject, /期限切れ/);

  var cardRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(cardId).record;
  assert.ok(stubs.isDateLike(cardRecord.expiredMailSentAt), 'カード予約はexpiredMailSentAtが記録されるべき');

  var cashRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(cashId).record;
  assert.ok(!cashRecord.expiredMailSentAt, '現金予約にはEXPIRED通知を送らない（expiredMailSentAtは空のまま）');
});

test('expirePendingBookings: expiredMailSentAtが空の過去のEXPIRED行には遡って通知しない（今回の実行でPENDING→EXPIREDへ更新した行のみが対象）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });

  /* 事前にEXPIRED状態の行を直接作る（=このexpirePendingBookings呼び出しより前に
     何らかの理由で失効していた想定。expiredMailSentAtは空のまま）。 */
  var pastExpiredId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00',
    email: 'past-expired@example.com'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(pastExpiredId, {
    status: 'EXPIRED',
    expiredAt: new Date(Date.now() - 100 * 3600000),
    createdAt: new Date(Date.now() - 200 * 3600000)
  });
  /* createPending()自体が送ったPENDINGメールを検証対象から除外する。 */
  mailApp._sentEmails.length = 0;

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 0, '既にEXPIREDの行はcandidatesに含まれない（getAllPendingBookingsはstatus===PENDINGのみ）');
  assert.strictEqual(mailApp._sentEmails.length, 0, '過去のEXPIRED行には遡って通知してはいけない');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(pastExpiredId).record;
  assert.ok(!record.expiredMailSentAt);
});

test('expirePendingBookings: EXPIRED通知メールの送信失敗でもEXPIRED状態は維持される', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('simulated mail send failure') });
  var ctx = setup({ mailApp: mailApp });

  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });

  var result = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(result.expiredCount, 1, 'メール送信が失敗してもexpirePendingBookings自体は失効処理を完了しているべき');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'EXPIRED', 'メール送信失敗でEXPIRED状態を取り消してはいけない');
  assert.ok(!record.expiredMailSentAt, '送信に失敗した場合はexpiredMailSentAtを記録しない');
});

test('expirePendingBookings→sendExpiredMailForBooking(手動再送): 二重送信しない（同一実行内でのSentAt冪等性）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });

  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  /* createPending()自体が送ったPENDINGメールを検証対象から除外する。 */
  mailApp._sentEmails.length = 0;

  ctx.sandbox.expirePendingBookings();
  assert.strictEqual(mailApp._sentEmails.length, 1);

  /* BookingAdmin.gsの個別再送導線と同じforce無しの手動呼び出し。expiredMailSentAtが
     既にあるため再送されないべき（他のメール種別と同じSentAt方式の二重送信防止）。 */
  var resendResult = ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId);
  assert.strictEqual(resendResult.skipped, true);
  assert.strictEqual(resendResult.reason, 'ALREADY_SENT');
  assert.strictEqual(mailApp._sentEmails.length, 1, '二重送信してはいけない');

  /* 明示的なforce:true（管理者の個別再送）でのみ再送できる。 */
  var forced = ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId, { force: true });
  assert.strictEqual(forced.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 2);
});

/* ---------- Issue #334: reviveExpiredBooking（手動復活） ---------- */

test('reviveExpiredBooking: EXPIRED→CONFIRMEDへ復活し、Calendarへ新規CONFIRMEDイベントを作成し、確定メールを送る', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });

  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00',
    durationMinutes: 120,
    email: 'revive@example.com'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  var expireResult = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(expireResult.expiredCount, 1);
  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 0, '失効時に旧イベントは削除されている前提');

  var beforeExpiredAt = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.expiredAt;
  /* createPending()のPENDINGメール・expirePendingBookings()のEXPIRED通知メールを
     検証対象から除外し、reviveExpiredBookingが送る確定メールだけを数える。 */
  mailApp._sentEmails.length = 0;

  var result = ctx.sandbox.reviveExpiredBooking(bookingId);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.status, 'CONFIRMED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'CONFIRMED');
  assert.ok(stubs.isDateLike(record.confirmedAt));
  assert.strictEqual(String(record.expiredAt), String(beforeExpiredAt), 'expiredAtは履歴として残すべき（上書きしない）');

  var liveEvents = ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); });
  assert.strictEqual(liveEvents.length, 1, 'Calendarに新規CONFIRMEDイベントが作成されるべき');
  assert.strictEqual(liveEvents[0].getTag('status'), 'CONFIRMED');
  assert.strictEqual(record.calendarEventId, liveEvents[0].getId(), '台帳のcalendarEventIdは新しいイベントIDへ更新されるべき');

  /* 確定メール（既存sendConfirmedMailForBookingをそのまま使う）がLock外で送られる。 */
  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.strictEqual(mailApp._sentEmails[0].to, 'revive@example.com');
});

test('reviveExpiredBooking: 枠が別予約で埋まっている場合はSLOT_UNAVAILABLEで拒否し、EXPIREDのまま変更しない', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00',
    durationMinutes: 120
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  ctx.sandbox.expirePendingBookings();

  /* 失効で枠が空いた後、別の予約が同じ時間帯を埋める（RateLimiterの重複送信検知を
     避けるため、emailを変えて別内容の送信として扱わせる）。 */
  createPending(ctx, {
    date: futureDateJst_(30),
    startTime: '10:00',
    durationMinutes: 120,
    paymentMethod: '現金',
    email: 'other-booking@example.com'
  });

  var result = ctx.sandbox.reviveExpiredBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'SLOT_UNAVAILABLE');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'EXPIRED', '復活に失敗した場合はEXPIREDのまま変更しない');
});

test('reviveExpiredBooking: 利用開始時刻を過ぎている場合は拒否する', function () {
  var ctx = setup();
  var startAt = new Date('2026-10-01T10:00:00+09:00');
  var created = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ paymentMethod: 'オンラインクレジットカード', date: '2026-10-01', startTime: '10:00', durationMinutes: 120 }),
    new Date('2026-09-20T09:00:00+09:00')
  );
  assert.strictEqual(created.success, true);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(created.bookingId, {
    status: 'EXPIRED',
    expiredAt: new Date('2026-09-27T09:00:00+09:00')
  });

  var afterStart = new Date(startAt.getTime() + 60000);
  var result = ctx.sandbox.reviveExpiredBooking(created.bookingId, afterStart);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REVIVE_AFTER_START_NOT_ALLOWED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(created.bookingId).record;
  assert.strictEqual(record.status, 'EXPIRED');
});

test('reviveExpiredBooking: PENDING/CONFIRMED/CANCELLEDはINVALID_TRANSITIONで拒否する（EXPIREDのみ対象）', function () {
  var ctx = setup();
  ['PENDING', 'CONFIRMED', 'CANCELLED'].forEach(function (status, index) {
    var bookingId = createPending(ctx, { date: futureDateJst_(40 + index), startTime: '10:00' });
    ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { status: status });

    var result = ctx.sandbox.reviveExpiredBooking(bookingId);
    assert.strictEqual(result.success, false, status);
    assert.strictEqual(result.error.code, 'INVALID_TRANSITION', status);

    var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
    assert.strictEqual(record.status, status, status + 'のまま変更されないべき');
  });
});

test('confirmBooking: reviveExpiredBookingではなく既存confirmBookingを直接呼んだ場合、EXPIREDは引き続き拒否される（Issue #334の回帰要件）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  ctx.sandbox.expirePendingBookings();

  var result = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'EXPIRED', 'confirmBooking経由での復活は起きないべき（reviveExpiredBooking専用）');
});

/*
 * ---------- PRレビュー対応: reviveExpiredBookingのCalendar作成・ステータス変更・
 * 補償削除それぞれの失敗ケース ----------
 */

test('reviveExpiredBooking: Calendarイベントの新規作成自体が失敗した場合はREVIVE_CALENDAR_FAILEDで拒否し、EXPIREDのまま変更しない（補償対象なし）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  ctx.sandbox.expirePendingBookings();

  ctx.calendarsById.cal1.failCreateEvent = new Error('simulated calendar create failure');
  mailApp._sentEmails.length = 0;

  var result = ctx.sandbox.reviveExpiredBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REVIVE_CALENDAR_FAILED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'EXPIRED', 'Calendar作成自体が失敗した場合、台帳はEXPIREDのまま変更しない');
  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 0, 'イベントは作成されていないため補償削除の対象は無い');
  assert.strictEqual(mailApp._sentEmails.length, 0, '確定メールを送信してはいけない');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'REVIVE_CALENDAR_CREATE_FAILED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
});

test('reviveExpiredBooking: Calendarイベント新規作成成功後にsetEventStatusが失敗した場合、新規作成したイベントを補償削除し、EXPIREDのまま維持してrecoveryへRESOLVED記録する（Sheetsは更新しない）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  ctx.sandbox.expirePendingBookings();

  var originalSetEventStatus = ctx.sandbox.CalendarRepository.setEventStatus;
  ctx.sandbox.CalendarRepository.setEventStatus = function () {
    throw new Error('simulated setEventStatus failure');
  };
  var originalUpdateBookingFields = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  var sheetsUpdateCalled = false;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    sheetsUpdateCalled = true;
    return originalUpdateBookingFields(id, fields);
  };
  mailApp._sentEmails.length = 0;

  var result = ctx.sandbox.reviveExpiredBooking(bookingId);
  ctx.sandbox.CalendarRepository.setEventStatus = originalSetEventStatus;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdateBookingFields;

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REVIVE_CALENDAR_STATUS_FAILED');
  assert.strictEqual(sheetsUpdateCalled, false, 'setEventStatus失敗時点ではSheetsへの更新を一切実行してはいけない');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'EXPIRED', 'setEventStatus失敗時は予約をEXPIREDのまま維持する');
  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 0, '新規作成したCalendarイベントは補償削除されるべき');
  assert.strictEqual(mailApp._sentEmails.length, 0, '確定メールを送信してはいけない');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'REVIVE_CALENDAR_STATUS_FAILED_ROLLED_BACK');
  assert.strictEqual(recovered[0].recoveryState, 'RESOLVED');
  assert.strictEqual(recovered[0].status, 'EXPIRED');
});

test('reviveExpiredBooking: setEventStatus失敗＋補償削除も失敗した場合は孤立イベントとしてrecoveryへOPEN記録し、EXPIREDのまま維持する（Sheetsは更新しない）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  ctx.sandbox.expirePendingBookings();

  ctx.sandbox.CalendarRepository.setEventStatus = function () {
    throw new Error('simulated setEventStatus failure');
  };
  ctx.sandbox.CalendarRepository.deleteEventById = function () {
    throw new Error('simulated compensation delete failure');
  };
  var originalUpdateBookingFields = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  var sheetsUpdateCalled = false;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    sheetsUpdateCalled = true;
    return originalUpdateBookingFields(id, fields);
  };
  mailApp._sentEmails.length = 0;

  var result = ctx.sandbox.reviveExpiredBooking(bookingId);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdateBookingFields;

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REVIVE_CALENDAR_STATUS_FAILED');
  assert.strictEqual(sheetsUpdateCalled, false, '補償削除にも失敗した場合もSheetsへの更新を実行してはいけない');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'EXPIRED', '補償削除に失敗した場合も予約をEXPIREDのまま維持する');
  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 1, '補償削除に失敗した場合、孤立イベントがCalendarに残る');
  assert.strictEqual(mailApp._sentEmails.length, 0, '確定メールを送信してはいけない');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'REVIVE_CALENDAR_STATUS_FAILED_ORPHANED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.strictEqual(recovered[0].status, 'EXPIRED');
});

test('reviveExpiredBooking: Calendar成功・Sheets失敗の場合は新規作成したCalendarイベントを補償削除し、recoveryへ記録する（既存Recovery方式と同じ形）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, {
    paymentMethod: 'オンラインクレジットカード',
    date: futureDateJst_(30),
    startTime: '10:00'
  });
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  ctx.sandbox.expirePendingBookings();

  var originalUpdate = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (id === bookingId && fields.status === 'CONFIRMED') {
      throw new Error('simulated sheets confirm update failure');
    }
    return originalUpdate(id, fields);
  };

  var result = ctx.sandbox.reviveExpiredBooking(bookingId);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = originalUpdate;

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'REVIVE_SAVE_FAILED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'EXPIRED', 'Sheets更新に失敗した場合、台帳側はEXPIREDのまま（誤ってCONFIRMEDと表示させない）');

  assert.strictEqual(ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length, 0, '新規作成したCalendarイベントは補償削除されるべき');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE');
});

test('reviveExpiredBooking: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup();
  var result = ctx.sandbox.reviveExpiredBooking('SX-NOT-EXIST');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

test('createExpirePendingBookingsTrigger: トリガーを作成し、二重作成しない', function () {
  var scriptApp = stubs.createScriptAppStub();
  var ctx = setup({ scriptApp: scriptApp });

  ctx.sandbox.createExpirePendingBookingsTrigger();
  ctx.sandbox.createExpirePendingBookingsTrigger();

  var triggers = scriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'expirePendingBookings'; });
  assert.strictEqual(triggers.length, 1, '同じハンドラのトリガーを重複作成しない');
});

/*
 * ---------- 管理メニュー: container-boundスクリプトのonOpen単純トリガー ----------
 *
 * BookingAdmin.gsはSPREADSHEET_IDのSpreadsheetへコンテナバインドした専用のApps Script
 * プロジェクト（Booking Admin。README「管理メニュー用GASプロジェクトのセットアップ」参照）
 * へデプロイする前提。コンテナバインドスクリプトではonOpen単純トリガーがSpreadsheetを
 * 開くたびに自動発火するため、（1回目レビューで採用したinstallable onOpenトリガーの
 * 手動作成とは異なり）追加のトリガー設定は不要。ここではonOpen/addBookingAdminMenuの
 * メニュー構築配線のみを検証する。
 */

test('addBookingAdminMenu: 「予約管理」メニューにconfirmBooking用の2項目を追加する', function () {
  var ui = stubs.createSpreadsheetUiStub();
  var ctx = setup({ ui: ui });

  ctx.sandbox.addBookingAdminMenu();

  assert.strictEqual(ui._menus.length, 1);
  assert.strictEqual(ui._menus[0].name, '予約管理');
  var functionNames = ui._menus[0].items.map(function (item) { return item.functionName; });
  assert.ok(functionNames.indexOf('confirmActiveRowBooking_') !== -1);
  assert.ok(functionNames.indexOf('confirmBookingByPrompt_') !== -1);
});

test('addBookingAdminMenu: 「予約管理」メニューにreviveExpiredBooking用の2項目を追加する（Issue #334）', function () {
  var ui = stubs.createSpreadsheetUiStub();
  var ctx = setup({ ui: ui });

  ctx.sandbox.addBookingAdminMenu();

  var functionNames = ui._menus[0].items.map(function (item) { return item.functionName; });
  assert.ok(functionNames.indexOf('reviveActiveRowBooking_') !== -1);
  assert.ok(functionNames.indexOf('reviveBookingByPrompt_') !== -1);
});

test('onOpen: container-boundスクリプトの単純トリガーとしてaddBookingAdminMenuと同じメニューを追加する（このファイルをSpreadsheetへコンテナバインドしたときの唯一の正式手順）', function () {
  var ui = stubs.createSpreadsheetUiStub();
  var ctx = setup({ ui: ui });

  ctx.sandbox.onOpen();

  assert.strictEqual(ui._menus.length, 1);
  assert.strictEqual(ui._menus[0].name, '予約管理');
});
