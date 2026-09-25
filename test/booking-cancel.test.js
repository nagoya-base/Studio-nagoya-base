/*
 * BookingRepository.cancelBookingAdmin の統合テスト（Issue #272）。
 * 併せてBookingAdmin.gsのグローバル関数配線（cancelBookingAdmin(bookingId)という
 * 正式関数名）・カスタムメニューのキャンセル導線（YES/NO確認を含む）も検証する。
 *
 * cancelBookingAdminはconfirmBooking / expirePendingBookingsと同じBooking Admin
 * プロジェクト（SPREADSHEET_IDのSpreadsheetへコンテナバインド）へデプロイする前提のため、
 * このテストファイルでも同一sandbox・同一LockServiceモックを共有させて検証している
 * （test/booking-confirm-expire.test.jsと同じ方針）。
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
  'JapaneseHolidays.gs',
  'BookingPricing.gs',
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

/* test/booking-confirm-expire.test.jsと同じ理由（メール送信自体はこのファイルの検証対象外のため
   既定で送信成功させ、lastMailError系・Recovery件数がキャンセル固有の検証へ混入しないようにする）。 */
var DEFAULT_MAIL_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

/* Asia/Tokyo基準で実行時刻からdaysAhead日後の'YYYY-MM-DD'を返す（#270/#279と同じ理由。
   固定日付だと実行日が過ぎた時点でnow省略呼び出しが一斉にINVALID_DATEへ変わり自然故障する）。 */
function futureDateJst_(daysAhead) {
  var d = new Date(Date.now() + daysAhead * 24 * 3600000);
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  var out = {};
  parts.forEach(function (part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

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

function activeEventCount(ctx) {
  return ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length;
}

/* ---------- 状態遷移 ---------- */

test('cancelBookingAdmin: PENDING → CANCELLEDへ遷移し、Calendarイベントが削除される', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'CANCELLED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.ok(stubs.isDateLike(found.record.cancelledAt));
  assert.ok(stubs.isDateLike(found.record.updatedAt));
  assert.strictEqual(
    found.record.cancelledAt.getTime(),
    found.record.updatedAt.getTime(),
    'status/cancelledAt/updatedAtは同一nowを使った1回の書き込みで反映されるため、cancelledAtとupdatedAtは同じDate値になる（PRレビュー対応）'
  );
  assert.strictEqual(activeEventCount(ctx), 0, 'Calendarイベントは削除されている');
});

test('cancelBookingAdmin: キャンセルのSpreadsheet書き込みはstatus〜updatedAt（13〜20列目）の8列だけに限定され、mail SentAt/lastMailError*/customerType（21列目以降）は一切書き換えない（PRレビュー2回目対応）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  /*
   * Booking Web App（別GASプロジェクト）が先にメール関連列を更新済み、という状況を再現する。
   * lastMailError*はキャンセルメール送信成功時にBookingMailer側で正当にクリアされるため
   * （どのメール種別でも共通の挙動）、ここではその影響を受けないpendingMailSentAt/
   * customerTypeで「cancelBookingAdmin自身の書き込みが21列目以降を巻き戻さないこと」を検証する。
   */
  var pendingMailSentAt = new Date('2026-10-01T08:00:00+09:00');
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, {
    pendingMailSentAt: pendingMailSentAt,
    customerType: 'returning'
  });

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, true);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.strictEqual(
    found.record.pendingMailSentAt.getTime(),
    pendingMailSentAt.getTime(),
    'Web App側が書いたpendingMailSentAtをcancelBookingAdminの書き込みが巻き戻さない'
  );
  assert.strictEqual(found.record.customerType, 'returning');

  /*
   * この後にキャンセルメール送信（BookingMailer.withBookingLock_）がcancelMailSentAt等を
   * 1セルずつ個別に書き込むため、_setValuesCallsの最後の要素はそちらになる。ここでは
   * 「8列まとめて書く」cancellation atomic write自体を範囲の広さ（numCols===8）で特定する。
   */
  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  var cancellationWrites = sheet._setValuesCalls.filter(function (call) { return call.numCols === 8; });
  assert.strictEqual(cancellationWrites.length, 1, 'status〜updatedAtをまとめて書き込む呼び出しがちょうど1回だけ記録されているはず');
  assert.strictEqual(cancellationWrites[0].col, 13, 'statusは13列目から始まる');
  assert.strictEqual(cancellationWrites[0].numCols, 8, 'status(13)〜updatedAt(20)の8列だけを1回で書く（21列目以降のmail列は範囲外）');
});

test('cancelBookingAdmin: CONFIRMED → CANCELLEDへ遷移できる（Issue #272でCONFIRMEDを終端から外した）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  var confirmResult = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(confirmResult.success, true);

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'CANCELLED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.strictEqual(activeEventCount(ctx), 0);
});

test('cancelBookingAdmin: EXPIREDからのキャンセルはINVALID_TRANSITIONで拒否し、Calendar/Sheets/メールを変更しない', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { status: 'EXPIRED', expiredAt: new Date() });
  ctx.globals.MailApp._sentEmails.length = 0; /* createPending自体が送るPENDINGメール分をリセットする */

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');
  assert.strictEqual(activeEventCount(ctx), 1, 'EXPIREDの場合はCalendarを変更しない');
  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 0);
});

test('cancelBookingAdmin: 二重実行しても壊れない（2回目はalreadyCancelled:trueで成功扱い。Calendar再削除・cancelledAt上書きをしない）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.globals.MailApp._sentEmails.length = 0; /* createPending自体が送るPENDINGメール分をリセットする */

  var first = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(first.success, true);
  var firstCancelledAt = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.cancelledAt;

  var second = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.alreadyCancelled, true);
  assert.strictEqual(second.status, 'CANCELLED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.strictEqual(found.record.cancelledAt.getTime(), firstCancelledAt.getTime(), 'cancelledAtは初回キャンセル時刻のまま上書きされない');
  assert.strictEqual(activeEventCount(ctx), 0);
  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 1, 'キャンセルメールは1通だけ');
});

test('cancelBookingAdmin: 正式関数名 cancelBookingAdmin(bookingId) がグローバルに存在する（Issue #272本文の要件）', function () {
  var ctx = setup();
  assert.strictEqual(typeof ctx.sandbox.cancelBookingAdmin, 'function');
});

test('cancelBookingAdmin: 存在しないbookingId・不正形式はNOT_FOUNDを返す', function () {
  var ctx = setup();
  var result = ctx.sandbox.cancelBookingAdmin('SX-NOT-EXIST');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

test('cancelBookingAdmin: bookingIdが空の場合はINVALID_BOOKING_IDを返す', function () {
  var ctx = setup();
  var result = ctx.sandbox.cancelBookingAdmin('');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_BOOKING_ID');
});

test('cancelBookingAdmin: Lock取得に失敗した場合はLOCK_TIMEOUTを返す', function () {
  var lockService = stubs.createLockServiceStub({ forceTryLockFail: true });
  var ctx = setup({ lockService: lockService });
  var result = ctx.sandbox.cancelBookingAdmin('SX-anything');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
});

/* ---------- 正常キャンセル ---------- */

test('cancelBookingAdmin: 正常キャンセル後、同じ時間枠がgetAvailabilityで再度候補になり、同時間で新しいcreateBookingが成功する', function () {
  var ctx = setup();
  var date = futureDateJst_(95);
  var bookingId = createPending(ctx, { date: date, startTime: '13:00', durationMinutes: 120, email: 'a@example.com' });

  var cancelResult = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(cancelResult.success, true);
  assert.strictEqual(activeEventCount(ctx), 0);

  var busyIntervals = ctx.sandbox.CalendarRepository.getBusyIntervalsForDate(CALENDAR_ID, date, 'Asia/Tokyo');
  assert.strictEqual(busyIntervals.length, 0, 'キャンセル後は同日のbusyIntervalsに含まれない');

  var rebooked = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ date: date, startTime: '13:00', durationMinutes: 120, email: 'b@example.com' })
  );
  assert.strictEqual(rebooked.success, true, 'キャンセル後は同じ時間枠で新規予約が作成できる');
});

test('cancelBookingAdmin: キャンセルメールが1通だけ送信され、cancelMailSentAtが記録される', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, { email: 'cancel-target@example.com' });
  ctx.globals.MailApp._sentEmails.length = 0; /* createPending自体が送るPENDINGメール分をリセットする */

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.mailSent, true);

  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 1);
  assert.strictEqual(ctx.globals.MailApp._sentEmails[0].to, 'cancel-target@example.com');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.cancelMailSentAt));
});

/* ---------- メール失敗 ---------- */

test('cancelBookingAdmin: キャンセルメール送信自体が失敗しても、Calendar削除・Sheets CANCELLEDは成功状態のまま維持する', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('mail down') });
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx);

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, true, 'メール送信失敗でもcancelBookingAdmin自体は成功扱い');
  assert.strictEqual(result.status, 'CANCELLED');
  assert.strictEqual(result.mailSent, false);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.strictEqual(activeEventCount(ctx), 0, 'Calendar削除は成功済みのまま');
  assert.strictEqual(found.record.cancelMailSentAt, '', 'メール失敗時はcancelMailSentAtを記録しない');
  assert.strictEqual(found.record.lastMailErrorType, 'CANCELLED');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  var mailFailures = recovered.filter(function (r) { return r.failureType === 'MAIL_CANCELLED_FAILED'; });
  assert.strictEqual(mailFailures.length, 1);

  /* 障害解消後に再実行すれば、状態は変更せずメールだけ再試行できる */
  var retryMailApp = stubs.createMailAppStub();
  ctx.sandbox.MailApp = retryMailApp; /* vmサンドボックスのグローバルMailAppを差し替える */
  var retry = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(retry.success, true);
  assert.strictEqual(retry.alreadyCancelled, true);
  assert.strictEqual(retry.mailSent, true);
  assert.strictEqual(retryMailApp._sentEmails.length, 1);

  var foundAfterRetry = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(foundAfterRetry.record.cancelMailSentAt));
});

/* ---------- Calendarイベントが既に存在しない ---------- */

test('cancelBookingAdmin: Calendarイベントが既に存在しない場合、Recoveryへ記録した上でSheetsをCANCELLEDへ収束させ、calendarAlreadyMissingを返す', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  var event = ctx.calendarsById.cal1.events[0];
  event.deleteEvent(); /* Calendar側だけ何らかの理由で既に消えてしまったケースを再現 */

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.calendarAlreadyMissing, true);
  assert.strictEqual(result.status, 'CANCELLED');
  assert.strictEqual(result.mailSent, true, 'Calendar既に無い場合もキャンセルメール送信対象');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.ok(stubs.isDateLike(found.record.cancelledAt));

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_CALENDAR_EVENT_MISSING');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
});

/* ---------- Calendar読み取り失敗（PRレビュー対応。イベントが無いのではなく例外） ---------- */

test('cancelBookingAdmin: CalendarRepository.getEventById自体が例外を投げた場合、success:falseでrecoveryへCANCEL_CALENDAR_LOOKUP_FAILEDを記録し、Sheets/Calendar/メールのいずれも変更しない', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.globals.MailApp._sentEmails.length = 0; /* createPending自体が送るPENDINGメール分をリセットする */

  ctx.sandbox.CalendarRepository.getEventById = function () {
    throw new Error('simulated calendar lookup failure');
  };

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CANCEL_CALENDAR_LOOKUP_FAILED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING', 'Calendar読み取り自体が失敗したためSheetsは元statusのまま');
  assert.strictEqual(found.record.cancelledAt, '');
  assert.strictEqual(activeEventCount(ctx), 1, 'Calendar削除は試みない（読み取りで例外が起きているため）');
  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 0, 'メールも送らない');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_CALENDAR_LOOKUP_FAILED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.strictEqual(recovered[0].status, 'PENDING');
  assert.match(recovered[0].errorMessage, /simulated calendar lookup failure/);
});

/* ---------- Calendar削除失敗 ---------- */

test('cancelBookingAdmin: Calendarイベント削除自体が失敗した場合、Sheetsは元statusのまま進めず、メールも送らずrecoveryへ記録する', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.globals.MailApp._sentEmails.length = 0; /* createPending自体が送るPENDINGメール分をリセットする */

  ctx.sandbox.CalendarRepository.deleteEventById = function () {
    throw new Error('simulated calendar delete failure');
  };

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CANCEL_CALENDAR_FAILED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING', 'Calendar削除失敗時はSheetsを元statusのまま維持する');
  assert.strictEqual(found.record.cancelledAt, '', 'cancelledAtは記録しない');
  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 0, 'メールも送らない');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_CALENDAR_DELETE_FAILED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.match(recovered[0].errorMessage, /simulated calendar delete failure/);
});

/* ---------- Calendar削除成功 → Sheets更新失敗 ---------- */

test('cancelBookingAdmin ケースA: atomic write失敗時はrecoveryへ記録し、Sheets側は元statusのまま・cancelledAt空・updatedAtも元値のまま残す。メールも送らない', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.globals.MailApp._sentEmails.length = 0; /* createPending自体が送るPENDINGメール分をリセットする */
  var beforeUpdatedAt = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.updatedAt;

  var originalUpdateAtomic = ctx.sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic;
  ctx.sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic = function () {
    throw new Error('simulated atomic sheets update failure');
  };

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CANCEL_SAVE_FAILED');

  assert.strictEqual(activeEventCount(ctx), 0, 'Calendar側は削除済みのはず');
  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 0, 'Sheets更新が失敗しているためメールは送らない');

  ctx.sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic = originalUpdateAtomic;
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING', 'atomic write失敗のためstatusは更新前のまま残る（Calendar削除済みとの不整合）');
  assert.strictEqual(found.record.cancelledAt, '', 'atomic write自体が失敗しているためcancelledAtは空のまま');
  assert.strictEqual(found.record.updatedAt, beforeUpdatedAt, 'atomic write自体が失敗しているためupdatedAtも元値のまま（部分更新が起きない）');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.strictEqual(recovered[0].status, 'PENDING', 'Recovery.statusはSheetsに残っている現在statusを記録する');
  assert.match(recovered[0].errorMessage, /simulated atomic sheets update failure/);
});

test('cancelBookingAdmin ケースB: ケースAの障害解消後に再実行すると、Calendarは既に無い経路からSheetsがCANCELLED・cancelledAt・updatedAtへ収束し、キャンセルメールも送信される', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.globals.MailApp._sentEmails.length = 0;

  var originalUpdateAtomic = ctx.sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic;
  ctx.sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic = function () {
    throw new Error('simulated atomic sheets update failure');
  };
  var first = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(first.success, false);
  ctx.sandbox.SpreadsheetRepository.updateBookingCancellationStateAtomic = originalUpdateAtomic; /* 障害解消をシミュレート */

  var second = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(second.success, true, '再実行時にSheets保存が復旧していれば正しくCANCELLEDへ進むべき');
  assert.strictEqual(second.calendarAlreadyMissing, true, 'Calendarは1回目の実行で既に削除済みのため、2回目はこの経路から収束する');
  assert.strictEqual(second.mailSent, true, '収束時にキャンセルメールも送信される');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.ok(stubs.isDateLike(found.record.cancelledAt), '収束時にcancelledAtが設定される');
  assert.ok(stubs.isDateLike(found.record.updatedAt), '収束時にupdatedAtも設定される');
  assert.strictEqual(ctx.globals.MailApp._sentEmails.length, 1);

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  var failureTypes = [];
  recovered.forEach(function (r) { failureTypes.push(r.failureType); });
  assert.deepEqual(
    failureTypes.sort(),
    ['CANCEL_CALENDAR_EVENT_MISSING', 'CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED'],
    '1回目のCANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVEDに加え、2回目はCalendarが既に削除済みのためCANCEL_CALENDAR_EVENT_MISSINGも記録される'
  );
});

/* ---------- Sheets行が存在しない ---------- */

test('cancelBookingAdmin: Sheets行が無く、Calendarに対象日のbookingIdイベントが1件見つかる場合はCANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENTを記録し、Calendarを自動削除しない', function () {
  var ctx = setup();
  var date = futureDateJst_(100);
  var bookingId = 'SX-' + date.replace(/-/g, '') + '-ABCDEF12';
  var eventId = ctx.sandbox.CalendarRepository.createBookingEvent(CALENDAR_ID, {
    date: date, startTime: '10:00', durationMinutes: 120, timezone: 'Asia/Tokyo', bookingId: bookingId, brand: 'studio_x'
  });

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT');
  assert.strictEqual(recovered[0].calendarEventId, eventId);
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');

  assert.strictEqual(activeEventCount(ctx), 1, 'Sheets行が無い状態からのCalendar自動削除はしない');
});

test('cancelBookingAdmin: Sheets行が無く、Calendarに対象日のbookingIdイベントが複数見つかる場合はCANCEL_MULTIPLE_CALENDAR_EVENTS_FOUNDを記録する', function () {
  var ctx = setup();
  var date = futureDateJst_(101);
  var bookingId = 'SX-' + date.replace(/-/g, '') + '-ABCDEF34';
  ctx.sandbox.CalendarRepository.createBookingEvent(CALENDAR_ID, {
    date: date, startTime: '09:00', durationMinutes: 60, timezone: 'Asia/Tokyo', bookingId: bookingId, brand: 'studio_x'
  });
  ctx.sandbox.CalendarRepository.createBookingEvent(CALENDAR_ID, {
    date: date, startTime: '15:00', durationMinutes: 60, timezone: 'Asia/Tokyo', bookingId: bookingId, brand: 'studio_x'
  });

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.strictEqual(activeEventCount(ctx), 2, 'Calendarを自動削除しない');
});

test('cancelBookingAdmin: Sheets行が無く、Calendarにも対象日のbookingIdイベントが見つからない場合はCANCEL_BOOKING_NOT_FOUNDを記録する', function () {
  var ctx = setup();
  var date = futureDateJst_(102);
  var bookingId = 'SX-' + date.replace(/-/g, '') + '-00000000';

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_BOOKING_NOT_FOUND');
  assert.strictEqual(recovered[0].calendarEventId, '');
});

test('cancelBookingAdmin: bookingId形式が不正で日付を復元できない場合、Calendar走査をせずCANCEL_BOOKING_NOT_FOUNDを記録する', function () {
  var ctx = setup();
  var result = ctx.sandbox.cancelBookingAdmin('not-a-valid-booking-id');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_BOOKING_NOT_FOUND');
});

test('cancelBookingAdmin: Sheets行なし診断中にfindBookingEventsByBookingId自体が例外を投げた場合、CANCEL_DIAGNOSTIC_FAILEDを返しCANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILEDをrecoveryへ記録する。Calendarは変更しない', function () {
  var ctx = setup();
  var date = futureDateJst_(103);
  var bookingId = 'SX-' + date.replace(/-/g, '') + '-DEADBEEF';

  ctx.sandbox.CalendarRepository.findBookingEventsByBookingId = function () {
    throw new Error('simulated diagnostic calendar lookup failure');
  };

  var result = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CANCEL_DIAGNOSTIC_FAILED');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.strictEqual(recovered[0].calendarEventId, '');
  assert.strictEqual(recovered[0].status, '');
  assert.match(recovered[0].errorMessage, /simulated diagnostic calendar lookup failure/);
  assert.strictEqual(activeEventCount(ctx), 0, '診断そのものが失敗しているためCalendarには何も作られていない');
});

/* ---------- confirm / expireとの競合 ---------- */

test('cancelBookingAdminとconfirmBooking/expirePendingBookingsは同一Booking AdminプロジェクトのLockServiceを共有するため、片方がLockを保持している間はもう片方がLOCK_TIMEOUTになる', function () {
  var lockService = stubs.createLockServiceStub();
  var ctx = setup({ lockService: lockService });
  var bookingId = createPending(ctx);

  var externalLock = lockService.getScriptLock();
  assert.strictEqual(externalLock.tryLock(), true);

  var cancelResult = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(cancelResult.success, false);
  assert.strictEqual(cancelResult.error.code, 'LOCK_TIMEOUT');

  externalLock.releaseLock();

  var cancelAfterRelease = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(cancelAfterRelease.success, true);
});

test('競合: cancelが先にCANCELLED → confirmはINVALID_TRANSITIONを返す', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var cancelResult = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(cancelResult.success, true);

  var confirmResult = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(confirmResult.success, false);
  assert.strictEqual(confirmResult.error.code, 'INVALID_TRANSITION');
});

test('競合: expireが先にEXPIRED → cancelはINVALID_TRANSITIONを返す', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 25 * 3600000) });

  var expireResult = ctx.sandbox.expirePendingBookings();
  assert.strictEqual(expireResult.expiredCount, 1);

  var cancelResult = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(cancelResult.success, false);
  assert.strictEqual(cancelResult.error.code, 'INVALID_TRANSITION');
});

test('競合: confirmが先にCONFIRMED → cancelはCONFIRMED→CANCELLEDとして続行できる', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var confirmResult = ctx.sandbox.confirmBooking(bookingId);
  assert.strictEqual(confirmResult.success, true);

  var cancelResult = ctx.sandbox.cancelBookingAdmin(bookingId);
  assert.strictEqual(cancelResult.success, true);
  assert.strictEqual(cancelResult.status, 'CANCELLED');
});

/* ---------- Reminder ---------- */

test('cancelBookingAdmin: CONFIRMED→CANCELLED後にsendNextDayRemindersを実行してもリマインドは送られない', function () {
  var ctx = setup();
  var tomorrow = new Date(Date.now() + 24 * 3600000);
  var receivedAt = new Date(tomorrow.getTime() - 24 * 3600000);
  var tomorrowDateString = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(tomorrow).replace(/\//g, '-');

  var created = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ date: tomorrowDateString, startTime: '10:00', durationMinutes: 120 }),
    receivedAt
  );
  assert.strictEqual(created.success, true);

  var confirmResult = ctx.sandbox.confirmBooking(created.bookingId);
  assert.strictEqual(confirmResult.success, true);

  var cancelResult = ctx.sandbox.cancelBookingAdmin(created.bookingId);
  assert.strictEqual(cancelResult.success, true);

  var reminderResult = ctx.sandbox.sendNextDayReminders(receivedAt);
  assert.strictEqual(reminderResult.sentCount, 0, 'CANCELLED予約には前日リマインドを送らない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(created.bookingId);
  assert.strictEqual(found.record.reminderSentAt, '');
});

/* ---------- 管理メニュー ---------- */

test('addBookingAdminMenu: 「予約管理」メニューにcancelBookingAdmin用の2項目を追加する', function () {
  var ui = stubs.createSpreadsheetUiStub();
  var ctx = setup({ ui: ui });

  ctx.sandbox.addBookingAdminMenu();

  var functionNames = ui._menus[0].items.map(function (item) { return item.functionName; });
  assert.ok(functionNames.indexOf('cancelActiveRowBooking_') !== -1);
  assert.ok(functionNames.indexOf('cancelBookingByPrompt_') !== -1);
});

test('cancelBookingByPrompt_: bookingIdを入力しYESで確認すると、cancelBookingAdminが実行される', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var ui = stubs.createSpreadsheetUiStub({ alertResponses: ['YES'] });
  ui.prompt = function () {
    return { getSelectedButton: function () { return ui.Button.OK; }, getResponseText: function () { return bookingId; } };
  };
  ctx.globals.SpreadsheetApp.getUi = function () { return ui; };

  ctx.sandbox.cancelBookingByPrompt_();

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
  assert.ok(ui._alerts.some(function (a) { return a.indexOf('キャンセルしました') !== -1; }));
});

test('cancelBookingByPrompt_: YES/NO確認でNOを選ぶと何も変更しない', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var ui = stubs.createSpreadsheetUiStub({ alertResponses: ['NO'] });
  ui.prompt = function () {
    return { getSelectedButton: function () { return ui.Button.OK; }, getResponseText: function () { return bookingId; } };
  };
  ctx.globals.SpreadsheetApp.getUi = function () { return ui; };

  ctx.sandbox.cancelBookingByPrompt_();

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING', 'NOを選んだ場合はstatusを変更しない');
  assert.strictEqual(activeEventCount(ctx), 1, 'NOを選んだ場合はCalendarも変更しない');
});

test('cancelActiveRowBooking_: アクティブ行のbookingIdをYESで確認するとcancelBookingAdminが実行される', function () {
  var ctx0 = setup();
  var bookingId = createPending(ctx0);

  var sheetStub = stubs.createSheetStub('Bookings');
  sheetStub.getRange = function (row) {
    return { getValue: function () { return bookingId; } };
  };
  sheetStub.getActiveRange = function () { return { getRow: function () { return 2; } }; };

  var ui = stubs.createSpreadsheetUiStub({ alertResponses: ['YES'] });
  ctx0.globals.SpreadsheetApp.getActiveSheet = function () { return sheetStub; };
  ctx0.globals.SpreadsheetApp.getUi = function () { return ui; };

  ctx0.sandbox.cancelActiveRowBooking_();

  var found = ctx0.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CANCELLED');
});

/* ---------- 3ブランド ---------- */

['snb', 'mens', 'studio_x'].forEach(function (brand) {
  test('cancelBookingAdmin: brand=' + brand + 'でもキャンセルロジックは同一（brand分岐なし）', function () {
    var ctx = setup();
    var bookingId = createPending(ctx, { brand: brand, date: futureDateJst_(110) });

    var result = ctx.sandbox.cancelBookingAdmin(bookingId);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.status, 'CANCELLED');
    assert.strictEqual(activeEventCount(ctx), 0);
  });
});
