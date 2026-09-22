/*
 * BookingAdminWeb.gs の統合テスト（Issue #305 Booking Admin Web UI化）。
 *
 * adminConfirmBooking/adminCancelBookingが独自の状態遷移ロジックを持たず、既存の正式関数
 * confirmBooking(bookingId)/cancelBookingAdmin(bookingId)（BookingAdmin.gs）へ
 * そのまま委譲していることを、実際にCalendar/Sheets/Lockを動かして検証する
 * （wrapperの中身をモックせず、confirmBooking/cancelBookingAdmin単体テスト
 * （test/booking-confirm-expire.test.js・test/booking-cancel.test.js）と同じ結果に
 * なることを確認する統合テストという位置づけ）。
 *
 * あわせて、getAdminBookings()が一覧表示に不要なPII（email/phone/note等）を含まないこと、
 * getAdminBookingDetail(bookingId)が詳細表示に必要な全フィールドを返すことを検証する。
 *
 * PRレビュー対応で追加: getAdminBookings/getAdminBookingDetailがDateオブジェクトを
 * そのまま返さずWeb UI用の文字列へ正規化していること（google.script.run越しにDateを
 * そのまま渡さない）、「今日」判定に使うtodayJstがAsia/Tokyo基準で計算されていること、
 * lastMailError*の詳細（内容・種別・日時）を返さずhasMailError（あり/なし）のみ返すことを
 * 追加で検証する。
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
  'BookingAdminWeb.gs'
];

var CALENDAR_ID = 'cal1';
var SPREADSHEET_ID = 'ss1';

var DEFAULT_MAIL_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

/* Asia/Tokyo基準で実行時刻からdaysAhead日後の'YYYY-MM-DD'を返す（当日判定・過去日拒否の
   影響を受けない固定の未来日を作るため。test/booking-confirm-expire.test.jsと同じ方針）。 */
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
      note: 'テスト備考',
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

/* ---------- adminConfirmBooking ---------- */

test('adminConfirmBooking: 既存confirmBookingと同じ結果になる（PENDING→CONFIRMED、Calendar確定、確定メール送信）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx);

  var result = ctx.sandbox.adminConfirmBooking(bookingId);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'CONFIRMED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CONFIRMED', 'adminConfirmBookingはconfirmBookingと同じくstatusをCONFIRMEDへ進めるべき');
  assert.ok(found.record.confirmedAt, 'confirmedAtが記録されるべき（confirmBooking本体の挙動）');

  var confirmedMails = mailApp._sentEmails.filter(function (mail) { return mail.subject && mail.subject.indexOf('予約が確定しました') !== -1; });
  assert.strictEqual(confirmedMails.length, 1, '確定メールが1通送られるべき（confirmBookingへの委譲が実際に効いていることの確認）');
});

test('adminConfirmBooking: bookingId未指定・未存在の場合もconfirmBookingと同じエラーになる（独自エラー処理を持たない）', function () {
  var ctx = setup();

  var directResult = ctx.sandbox.confirmBooking('NOT-EXIST');
  var wrapperResult = ctx.sandbox.adminConfirmBooking('NOT-EXIST');

  assert.strictEqual(wrapperResult.success, false);
  assert.strictEqual(wrapperResult.error.code, directResult.error.code);
});

test('adminConfirmBooking: 二重実行してもconfirmBookingと同じくalreadyConfirmedで安全に返る', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  ctx.sandbox.adminConfirmBooking(bookingId);
  var second = ctx.sandbox.adminConfirmBooking(bookingId);

  assert.strictEqual(second.success, true);
  assert.strictEqual(second.alreadyConfirmed, true);
});

/* ---------- adminCancelBooking ---------- */

test('adminCancelBooking: 既存cancelBookingAdminと同じ結果になる（PENDING→CANCELLED、Calendar削除、実行前確認はクライアント側の責務）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx);
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  var eventId = found.record.calendarEventId;

  var result = ctx.sandbox.adminCancelBooking(bookingId);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'CANCELLED');

  var updated = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(updated.record.status, 'CANCELLED', 'adminCancelBookingはcancelBookingAdminと同じくstatusをCANCELLEDへ進めるべき');
  assert.ok(updated.record.cancelledAt, 'cancelledAtが記録されるべき（cancelBookingAdmin本体の挙動）');

  var calendar = ctx.calendarsById[CALENDAR_ID];
  var remaining = calendar.events.filter(function (e) { return e.getId() === eventId && !e.isDeleted(); });
  assert.strictEqual(remaining.length, 0, 'Calendarイベントが削除されているべき（cancelBookingAdmin本体の挙動）');

  var cancelMails = mailApp._sentEmails.filter(function (mail) { return mail.subject && mail.subject.indexOf('キャンセル') !== -1; });
  assert.strictEqual(cancelMails.length, 1, 'キャンセルメールが1通送られるべき（cancelBookingAdminへの委譲が実際に効いていることの確認）');
});

test('adminCancelBooking: CONFIRMED予約もキャンセルできる（cancelBookingAdminと同じ遷移規則）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.adminConfirmBooking(bookingId);

  var result = ctx.sandbox.adminCancelBooking(bookingId);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'CANCELLED');
});

test('adminCancelBooking: EXPIREDからのキャンセルはcancelBookingAdminと同じくINVALID_TRANSITIONで拒否される', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { status: 'EXPIRED', expiredAt: new Date() });

  var result = ctx.sandbox.adminCancelBooking(bookingId);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
});

/* ---------- getAdminBookings ---------- */

test('getAdminBookings: { todayJst, bookings }を返し、一覧の各要素は最小フィールドのみでemail/phone/note等のPIIを含まない', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var result = ctx.sandbox.getAdminBookings();

  assert.strictEqual(result.bookings.length, 1);
  var item = result.bookings[0];
  assert.strictEqual(item.bookingId, bookingId);
  assert.strictEqual(item.status, 'PENDING');
  assert.strictEqual(item.brand, 'studio_x');
  assert.strictEqual(item.customerType, 'returning');
  assert.strictEqual(typeof item.date, 'string', 'dateはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(item.date, DEFAULT_FUTURE_DATE);

  var allowedKeys = ['bookingId', 'createdAt', 'date', 'startAt', 'endAt', 'brand', 'name', 'people', 'customerType', 'purpose', 'paymentMethod', 'status'];
  assert.deepStrictEqual(Object.keys(item).sort(), allowedKeys.slice().sort());

  ['email', 'phone', 'note', 'pendingMailSentAt', 'lastMailErrorMessage'].forEach(function (piiField) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(item, piiField), false, '一覧レスポンスに' + piiField + 'を含めてはいけない');
  });
});

test('getAdminBookings: 複数件・複数statusをすべて返す（サーバー側では絞り込まない）', function () {
  var ctx = setup();
  var pendingId = createPending(ctx, { date: futureDateJst_(10) });
  var confirmedId = createPending(ctx, { date: futureDateJst_(20) });
  ctx.sandbox.adminConfirmBooking(confirmedId);

  var result = ctx.sandbox.getAdminBookings();
  /* Array.from()を明示的にmain realmのArrayコンストラクタで呼ぶことで、vmサンドボックス
     （別realm）から返った配列に対する.map()がそのrealmのArrayを返してしまい、
     assert.deepStrictEqualが「構造は同じだがreference-equalではない」で
     失敗する問題を避ける（test/helpers/gas-sandbox.jsのrealm分離による既知の注意点）。 */
  var ids = Array.from(result.bookings, function (item) { return item.bookingId; }).sort();

  assert.deepStrictEqual(ids, [confirmedId, pendingId].sort());
});

test('getAdminBookings: startAt/endAtはDateオブジェクトではなくWeb UI用の文字列（HH:mm）として返る', function () {
  var ctx = setup();
  createPending(ctx, { startTime: '19:00', durationMinutes: 120 });

  var result = ctx.sandbox.getAdminBookings();
  var item = result.bookings[0];

  assert.strictEqual(typeof item.startAt, 'string', 'startAtはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(typeof item.endAt, 'string', 'endAtはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(item.startAt, '19:00');
  assert.strictEqual(item.endAt, '21:00');
});

test('getAdminBookings/getAdminBookingDetail: dateがDate値として保存されていてもYYYY-MM-DDの文字列として返る（Sheetsが日付らしい文字列をDateへ自動変換した場合への備え）', function () {
  var ctx = setup();
  /* BookingRepository.createBookingは常にdateを文字列として保存するため、この
     ケース（dateがDateとして保存されている状態）はSpreadsheetRepository.appendBookingを
     直接呼んで模擬する。Google Sheetsは日付らしい文字列をセルへ書き込むと、読み込み時に
     Date値として返すことがあるため、record.dateが実際にDateになっていても
     formatAdminDate_が正しく'YYYY-MM-DD'へ正規化することを確認する。 */
  var record = {
    bookingId: 'SX-20261001-AAAAAAAA',
    createdAt: new Date('2026-09-01T09:00:00+09:00'),
    date: new Date('2026-10-01T00:00:00+09:00'),
    startAt: new Date('2026-10-01T19:00:00+09:00'),
    endAt: new Date('2026-10-01T21:00:00+09:00'),
    brand: 'studio_x',
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '090-0000-0000',
    people: '2名',
    purpose: 'テスト',
    paymentMethod: '現金',
    status: 'PENDING',
    calendarEventId: 'event-1',
    source: 'test',
    note: '',
    customerType: 'returning'
  };
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);

  var listResult = ctx.sandbox.getAdminBookings();
  assert.strictEqual(typeof listResult.bookings[0].date, 'string', 'getAdminBookingsのdateはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(listResult.bookings[0].date, '2026-10-01');

  var detailResult = ctx.sandbox.getAdminBookingDetail(record.bookingId);
  assert.strictEqual(typeof detailResult.booking.date, 'string', 'getAdminBookingDetailのdateはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(detailResult.booking.date, '2026-10-01');
});

test('getAdminBookings: createdAtはDateオブジェクトではなくWeb UI用の比較可能な文字列として返る（一覧の予約順ソート用）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var result = ctx.sandbox.getAdminBookings();
  var item = result.bookings[0];

  assert.strictEqual(item.bookingId, bookingId);
  assert.strictEqual(typeof item.createdAt, 'string', 'createdAtはDateオブジェクトのまま返してはいけない');
  assert.match(item.createdAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'createdAtは日付順で単純比較できる文字列であるべき');
});

test('getAdminBookings: createdAtがDate値として保存されていてもWeb UI用の文字列として返る', function () {
  var ctx = setup();
  var record = {
    bookingId: 'SX-20261001-BBBBBBBB',
    createdAt: new Date('2026-09-01T09:30:00+09:00'),
    date: futureDateJst_(30),
    startAt: new Date('2026-10-31T19:00:00+09:00'),
    endAt: new Date('2026-10-31T21:00:00+09:00'),
    brand: 'studio_x',
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '090-0000-0000',
    people: '2名',
    purpose: 'テスト',
    paymentMethod: '現金',
    status: 'PENDING',
    calendarEventId: 'event-2',
    source: 'test',
    note: '',
    customerType: 'returning'
  };
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);

  var result = ctx.sandbox.getAdminBookings();
  var item = result.bookings.filter(function (b) { return b.bookingId === record.bookingId; })[0];

  assert.strictEqual(typeof item.createdAt, 'string', 'createdAtはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(item.createdAt, '2026-09-01 09:30');
});

test('getAdminBookings: todayJstはAsia/Tokyo基準で計算される（端末timezoneに依存しない）', function () {
  var ctx = setup();

  var result = ctx.sandbox.getAdminBookings();

  assert.strictEqual(result.todayJst, futureDateJst_(0), 'todayJstはAsia/Tokyo基準の「今日」の日付文字列であるべき');
});

/* ---------- getAdminBookingDetail ---------- */

test('getAdminBookingDetail: 詳細表示に必要な全フィールド（email/phone/note等を含む）を返す。日時はWeb UI用の文字列へ正規化する', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, {
    email: 'detail@example.com',
    phone: '090-9999-9999',
    note: '詳細確認用備考',
    date: DEFAULT_FUTURE_DATE,
    startTime: '19:00',
    durationMinutes: 120
  });

  var result = ctx.sandbox.getAdminBookingDetail(bookingId);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.booking.bookingId, bookingId);
  assert.strictEqual(result.booking.email, 'detail@example.com');
  assert.strictEqual(result.booking.phone, '090-9999-9999');
  assert.strictEqual(result.booking.note, '詳細確認用備考');
  assert.strictEqual(result.booking.status, 'PENDING');

  assert.strictEqual(typeof result.booking.date, 'string', 'dateはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(result.booking.date, DEFAULT_FUTURE_DATE);
  assert.strictEqual(typeof result.booking.startAt, 'string', 'startAtはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(typeof result.booking.endAt, 'string', 'endAtはDateオブジェクトのまま返してはいけない');
  assert.strictEqual(result.booking.startAt, DEFAULT_FUTURE_DATE + ' 19:00');
  assert.strictEqual(result.booking.endAt, DEFAULT_FUTURE_DATE + ' 21:00');

  assert.strictEqual(result.booking.hasMailError, false, 'メール送信に失敗していなければhasMailErrorはfalse');
  ['lastMailErrorAt', 'lastMailErrorType', 'lastMailErrorMessage'].forEach(function (key) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.booking, key), false, key + 'はWeb UIレスポンスに含めてはいけない（hasMailErrorのみ返す）');
  });
});

test('getAdminBookingDetail: 未送信のSentAt系フィールドは空文字列のまま、送信済みのSentAt系フィールドはDateではなく文字列で返る', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var result = ctx.sandbox.getAdminBookingDetail(bookingId);

  /* createBooking自体が仮予約受付メールをbest effortで送るため、pendingMailSentAtは
     このテスト前提（完全なメール設定）では既に送信済みになる。Dateではなく
     'YYYY-MM-DD HH:mm'形式の文字列で返ることを確認する（Date正規化の検証）。 */
  assert.strictEqual(typeof result.booking.pendingMailSentAt, 'string');
  assert.match(result.booking.pendingMailSentAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  /* confirm/cancel/リマインドはまだ行っていないため、これらは未送信のまま空文字列のはず。 */
  ['confirmedMailSentAt', 'cancelMailSentAt', 'reminderSentAt', 'accessGuideSentAt'].forEach(function (key) {
    assert.strictEqual(result.booking[key], '', key + 'は未送信のため空文字列であるべき');
  });
});

test('getAdminBookingDetail: メール送信に失敗した場合はhasMailError:trueになり、lastMailError*の詳細はレスポンスに含めない', function () {
  var ctx = setup({
    properties: { BOOKING_MAIL_DISPLAY_NAME: '', BOOKING_MAIL_REPLY_TO: '', BOOKING_CONTACT_EMAIL: '' }
  });
  var bookingId = createPending(ctx);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(found.record.lastMailErrorAt, 'テスト前提としてメール設定不足でlastMailErrorAtが記録されているべき');

  var result = ctx.sandbox.getAdminBookingDetail(bookingId);

  assert.strictEqual(result.booking.hasMailError, true);
  ['lastMailErrorAt', 'lastMailErrorType', 'lastMailErrorMessage'].forEach(function (key) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(result.booking, key), false, key + 'はWeb UIレスポンスに含めてはいけない（hasMailErrorのみ返す）');
  });
});

test('getAdminBookingDetail: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup();

  var result = ctx.sandbox.getAdminBookingDetail('NOT-EXIST');

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});
