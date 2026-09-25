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

  /* Issue #334: cardPaymentDueAtは一覧レスポンスの許可フィールドに追加された
     読み取り専用項目（カード予約のみ非空。ここでは支払方法が現金のためcardPaymentDueAtは
     空文字になることをこのテスト自体では検証しないが、キー自体は常に含まれる）。 */
  var allowedKeys = ['bookingId', 'createdAt', 'date', 'startAt', 'endAt', 'brand', 'name', 'people', 'customerType', 'purpose', 'paymentMethod', 'status', 'cardPaymentDueAt'];
  assert.deepStrictEqual(Object.keys(item).sort(), allowedKeys.slice().sort());
  assert.strictEqual(item.cardPaymentDueAt, '', '現金等カード以外の支払方法ではcardPaymentDueAtは空文字であるべき');

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

/*
 * createdAtの正規化（PRレビュー対応: normalizeAdminCreatedAt_）。formatAdminDateTime_は
 * Date値以外（文字列）をそのまま素通りさせるため、Sheetsの読み込み結果がDate値ではなく
 * 不揃いな文字列だった場合に予約順ソートが崩れうる。normalizeAdminCreatedAt_はDate値・
 * 既に正規形式の文字列・別形式だが解釈可能な文字列のいずれも同じ'YYYY-MM-DD HH:mm'形式へ
 * 揃え、解釈不能な値は例外を投げず''へ落とすことを確認する。
 */
function appendBookingWithCreatedAt_(ctx, bookingId, createdAt) {
  ctx.sandbox.SpreadsheetRepository.appendBooking({
    bookingId: bookingId,
    createdAt: createdAt,
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
    calendarEventId: 'event-' + bookingId,
    source: 'test',
    note: '',
    customerType: 'returning'
  });
}

function createdAtOf_(ctx, bookingId) {
  var result = ctx.sandbox.getAdminBookings();
  var item = result.bookings.filter(function (b) { return b.bookingId === bookingId; })[0];
  assert.ok(item, bookingId + 'が一覧に見つかるべき');
  return item.createdAt;
}

test('getAdminBookings: createdAtが既に"YYYY-MM-DD HH:mm"形式の文字列ならそのまま返る', function () {
  var ctx = setup();
  appendBookingWithCreatedAt_(ctx, 'SX-20261001-CCCCCCCC', '2026-09-01 09:30');

  assert.strictEqual(createdAtOf_(ctx, 'SX-20261001-CCCCCCCC'), '2026-09-01 09:30');
});

test('getAdminBookings: createdAtが別形式の文字列（ISO 8601）でも比較可能な"YYYY-MM-DD HH:mm"へ統一される', function () {
  var ctx = setup();
  appendBookingWithCreatedAt_(ctx, 'SX-20261001-DDDDDDDD', '2026-09-01T09:30:00+09:00');

  assert.strictEqual(createdAtOf_(ctx, 'SX-20261001-DDDDDDDD'), '2026-09-01 09:30');
});

test('getAdminBookings: createdAtが解釈不能な値でも例外にならず、安全な空文字列を返す', function () {
  var ctx = setup();
  appendBookingWithCreatedAt_(ctx, 'SX-20261001-EEEEEEEE', 'not-a-date');
  appendBookingWithCreatedAt_(ctx, 'SX-20261001-FFFFFFFF', '');
  appendBookingWithCreatedAt_(ctx, 'SX-20261001-GGGGGGGG', undefined);

  assert.doesNotThrow(function () { ctx.sandbox.getAdminBookings(); });
  assert.strictEqual(createdAtOf_(ctx, 'SX-20261001-EEEEEEEE'), '', '解釈不能な文字列はcreatedAtの形式を推測せず空文字列へ落とすべき');
  assert.strictEqual(createdAtOf_(ctx, 'SX-20261001-FFFFFFFF'), '');
  assert.strictEqual(createdAtOf_(ctx, 'SX-20261001-GGGGGGGG'), '');
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

  /* confirm/cancel/失効/リマインドはまだ行っていないため、これらは未送信のまま空文字列のはず。 */
  ['confirmedMailSentAt', 'cancelMailSentAt', 'expiredMailSentAt', 'reminderSentAt', 'accessGuideSentAt'].forEach(function (key) {
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

/* ---------- Issue #334: カード支払期限の読み取り専用表示 ---------- */

test('getAdminBookings/getAdminBookingDetail: カード決済のみcardPaymentDueAtが非空になり、Booking.computeCardPaymentDueMillisと同じ値をJST文字列で返す', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });

  var listResult = ctx.sandbox.getAdminBookings();
  var listItem = listResult.bookings.find(function (b) { return b.bookingId === bookingId; });
  assert.ok(listItem.cardPaymentDueAt, '一覧でもカード予約はcardPaymentDueAtが非空であるべき');
  assert.match(listItem.cardPaymentDueAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

  var detailResult = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(detailResult.booking.cardPaymentDueAt, listItem.cardPaymentDueAt, '一覧と詳細で同じ値であるべき（同一関数由来）');

  /* expirePendingBookingsの失効判定と同じBooking.computeCardPaymentDueMillisから計算した
     期待値と一致することを確認する（表示用と判定用で別計算・別定数を持たない）。 */
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  var ttlConfig = ctx.sandbox.BookingConfig.getTtlConfig();
  var expectedMillis = ctx.sandbox.Booking.computeCardPaymentDueMillis(record.createdAt.getTime(), record.startAt.getTime(), ttlConfig.minHoursBeforeStart);
  var expectedString = ctx.sandbox.BookingAvailability.formatDateInTimezone(new Date(expectedMillis), 'Asia/Tokyo') + ' ' +
    ctx.sandbox.BookingAvailability.formatTimeInTimezone(new Date(expectedMillis), 'Asia/Tokyo');
  assert.strictEqual(listItem.cardPaymentDueAt, expectedString);
});

test('getAdminBookings/getAdminBookingDetail: 現金/PayPay/未定はcardPaymentDueAtが常に空文字列', function () {
  var ctx = setup();
  var startTimes = ['10:00', '13:00', '16:00'];
  ['現金', 'PayPay', '未定'].forEach(function (paymentMethod, index) {
    var bookingId = createPending(ctx, { paymentMethod: paymentMethod, email: 'due-' + index + '@example.com', startTime: startTimes[index] });

    var listItem = ctx.sandbox.getAdminBookings().bookings.find(function (b) { return b.bookingId === bookingId; });
    assert.strictEqual(listItem.cardPaymentDueAt, '', paymentMethod);

    var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
    assert.strictEqual(detail.booking.cardPaymentDueAt, '', paymentMethod);
  });
});

/* ---------- Issue #334: adminReviveExpiredBooking ---------- */

test('adminReviveExpiredBooking: 既存reviveExpiredBookingと同じ結果になる（EXPIRED→CONFIRMED、独自ロジックを持たない）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  /* status列を直接書き換えるだけでは失効時のCalendarイベント削除が再現できず、
     復活時に自分自身の旧イベントとSLOT_UNAVAILABLEで衝突してしまう。実際の
     expirePendingBookings（Calendar削除を含む）を通す。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { createdAt: new Date(Date.now() - 73 * 3600000) });
  var expireResult = ctx.sandbox.BookingRepository.expirePendingBookings();
  assert.strictEqual(expireResult.expiredCount, 1, 'テスト前提としてEXPIRED化に成功しているべき');

  var result = ctx.sandbox.adminReviveExpiredBooking(bookingId);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.status, 'CONFIRMED');

  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(record.status, 'CONFIRMED');
});

test('adminReviveExpiredBooking: PENDINGからの復活はreviveExpiredBookingと同じくINVALID_TRANSITIONで拒否される', function () {
  var ctx = setup();
  var bookingId = createPending(ctx);

  var result = ctx.sandbox.adminReviveExpiredBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_TRANSITION');
});

/* ---------- Issue #334 PR-C: Stripe決済リンク送信欄 ---------- */

test('getAdminBookingDetail: カード決済PENDINGはisCardPayment:trueで、決済リンク送信欄用のフィールドは未送信の初期状態（空文字/0）を返す', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(result.booking.isCardPayment, true);
  assert.strictEqual(result.booking.stripePaymentLinkUrl, '');
  assert.strictEqual(result.booking.paymentLinkSentAt, '');
  assert.strictEqual(result.booking.paymentLinkSentTo, '');
  assert.strictEqual(result.booking.paymentLinkSendCount, 0);
  assert.strictEqual(result.booking.paymentLinkLastErrorAt, '');
  assert.strictEqual(result.booking.paymentLinkLastErrorMessage, '');
  assert.strictEqual(result.booking.paymentLinkSendUnconfirmedAt, '');
  assert.strictEqual(result.booking.paymentLinkMetadataInconsistentAt, '');
  assert.strictEqual(result.booking.paymentLinkSentAtVersion, 0, '未送信のpaymentLinkSentAtVersionは0であるべき');
});

test('getAdminBookingDetail: 現金・PayPay・未定はisCardPayment:falseを返す（決済リンク送信欄を表示しないための判定用）', function () {
  var ctx = setup();
  var startTimes = ['10:00', '13:00', '16:00'];
  ['現金', 'PayPay', '未定'].forEach(function (paymentMethod, index) {
    var bookingId = createPending(ctx, { paymentMethod: paymentMethod, email: 'not-card-' + index + '@example.com', startTime: startTimes[index] });
    var result = ctx.sandbox.getAdminBookingDetail(bookingId);
    assert.strictEqual(result.booking.isCardPayment, false, paymentMethod);
  });
});

test('adminSendCardPaymentLink: 既存sendCardPaymentLinkMailと同じ結果になり、送信後のgetAdminBookingDetailに送信状態が反映される（独自ロジックを持たない）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード', email: 'payer@example.com' });

  var result = ctx.sandbox.adminSendCardPaymentLink(bookingId, 'https://buy.stripe.com/test_ABC123');
  assert.strictEqual(result.success, true, JSON.stringify(result));

  var paymentLinkMails = mailApp._sentEmails.filter(function (mail) { return mail.subject && mail.subject.indexOf('お支払い') !== -1; });
  assert.strictEqual(paymentLinkMails.length, 1, '決済リンクメールが1通送られるべき（sendCardPaymentLinkMailへの委譲が実際に効いていることの確認）');

  var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(detail.booking.stripePaymentLinkUrl, 'https://buy.stripe.com/test_ABC123');
  assert.ok(detail.booking.paymentLinkSentAt, 'paymentLinkSentAtが記録されるべき');
  assert.strictEqual(detail.booking.paymentLinkSentTo, 'payer@example.com');
  assert.strictEqual(detail.booking.paymentLinkSendCount, 1);
});

test('adminSendCardPaymentLink: forceなしの2回目はスキップされ、二重送信しない。forceを明示的に渡した場合のみ再送でき、送信回数が増える', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  ctx.sandbox.adminSendCardPaymentLink(bookingId, url);
  var second = ctx.sandbox.adminSendCardPaymentLink(bookingId, url);
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(second.reason, 'ALREADY_SENT');

  var afterSecond = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(afterSecond.booking.paymentLinkSendCount, 1, '明示的な再送でなければ送信回数は増えない');

  var forced = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, true);
  assert.strictEqual(forced.success, true, JSON.stringify(forced));

  var afterForced = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(afterForced.booking.paymentLinkSendCount, 2, '明示的な再送では送信回数が増える');
});

test('adminSendCardPaymentLink: カード決済以外・PENDING以外には送信できない（sendCardPaymentLinkMail/BookingMailer側の再検証がそのまま効く）', function () {
  var ctx = setup();
  var cashBookingId = createPending(ctx);
  var cashResult = ctx.sandbox.adminSendCardPaymentLink(cashBookingId, 'https://buy.stripe.com/test_ABC123');
  assert.strictEqual(cashResult.success, false);
  assert.strictEqual(cashResult.error.code, 'NOT_CARD_PAYMENT');

  var confirmedBookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード', email: 'confirmed@example.com', startTime: '13:00' });
  ctx.sandbox.adminConfirmBooking(confirmedBookingId);
  var confirmedResult = ctx.sandbox.adminSendCardPaymentLink(confirmedBookingId, 'https://buy.stripe.com/test_ABC123');
  assert.strictEqual(confirmedResult.success, false);
  assert.strictEqual(confirmedResult.error.code, 'INVALID_STATUS');
});

test('adminSendCardPaymentLink: 不正なURLはINVALID_PAYMENT_LINK_URLで拒否される（GAS側の検証が必須で、クライアント側の事前チェックに依存しない）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.adminSendCardPaymentLink(bookingId, 'https://evil.example/not-stripe');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_PAYMENT_LINK_URL');
});

/*
 * PRレビュー対応: 同時再送の競合防止（同時再送の競合防止）。adminSendCardPaymentLinkの
 * 第4引数expectedSendCountが、そのままBookingMailer.sendPaymentLinkMailForBookingの
 * checkSendHistoryVersion_へ渡っていることをWeb UI層で確認する（独自ロジックを持たない）。
 */
test('adminSendCardPaymentLink: expectedSendCountが最新のpaymentLinkSendCountと一致しない場合、通常送信でもSEND_HISTORY_CONFLICTで拒否する（別タブでの先行送信を検知）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  var tabA = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, false, 0);
  assert.strictEqual(tabA.success, true, JSON.stringify(tabA));

  var staleTabB = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, false, 0);
  assert.strictEqual(staleTabB.success, false);
  assert.strictEqual(staleTabB.error.code, 'SEND_HISTORY_CONFLICT');

  var paymentLinkMails = mailApp._sentEmails.filter(function (mail) { return mail.subject && mail.subject.indexOf('お支払い') !== -1; });
  assert.strictEqual(paymentLinkMails.length, 1, '競合したタブからは決済リンクメールが送信されないべき');
});

test('adminSendCardPaymentLink: 明示的な再送でもexpectedSendCountが古い場合はSEND_HISTORY_CONFLICTで拒否する（同時再送の競合防止）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  ctx.sandbox.adminSendCardPaymentLink(bookingId, url, false, 0);

  var tabAForced = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, true, 1);
  assert.strictEqual(tabAForced.success, true, JSON.stringify(tabAForced));

  var staleTabBForced = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, true, 1);
  assert.strictEqual(staleTabBForced.success, false);
  assert.strictEqual(staleTabBForced.error.code, 'SEND_HISTORY_CONFLICT');

  var paymentLinkMails = mailApp._sentEmails.filter(function (mail) { return mail.subject && mail.subject.indexOf('お支払い') !== -1; });
  assert.strictEqual(paymentLinkMails.length, 2, '競合したタブからのforce再送では決済リンクメールが送信されないべき');
});

/*
 * PRレビュー対応: メール送信後の履行未確認状態が、Web UI層（getAdminBookingDetail/
 * adminSendCardPaymentLink）まで正しく伝わることを確認する。BookingMailer.gs単体の
 * 詳細な検証はtest/booking-mailer.test.jsで行うため、ここでは配線の確認に留める。
 */
test('adminSendCardPaymentLink→getAdminBookingDetail: 送信履行が未確認の場合はrequiresManualConfirmation:trueを返し、詳細にpaymentLinkSendUnconfirmedAtが反映される', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    var keys = Object.keys(fields);
    if (keys.length === 1 && keys[0] === 'paymentLinkSentAt') {
      throw new Error('simulated Sheets outage while recording paymentLinkSentAt');
    }
    return original(id, fields);
  };

  var result = ctx.sandbox.adminSendCardPaymentLink(bookingId, url);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.mailSent, true);
  assert.strictEqual(result.requiresManualConfirmation, true);

  var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(detail.booking.paymentLinkSentAt, '');
  assert.ok(detail.booking.paymentLinkSendUnconfirmedAt, 'paymentLinkSendUnconfirmedAtが詳細へ反映されるべき');

  var retryNormal = ctx.sandbox.adminSendCardPaymentLink(bookingId, url);
  assert.strictEqual(retryNormal.skipped, true);
  assert.strictEqual(retryNormal.error.code, 'SEND_UNCONFIRMED', '履行未確認の間は通常送信を無効化する');
});

/*
 * 第2回PRレビュー対応: 送信履歴の2回目の書き込み（URL/送信先/送信回数）だけが失敗すると、
 * paymentLinkSentAtは新しくなるがpaymentLinkSendCountは古いまま残るため、
 * expectedSendCountだけの比較では、この状態を見ていない古い画面からの再送を検知
 * できない。adminSendCardPaymentLinkの第5引数expectedSentAtVersionが
 * BookingMailer.gsのcheckSendHistoryVersion_へ正しく伝わっていることをWeb UI層で
 * 確認する（独自ロジックを持たない）。
 */
test('adminSendCardPaymentLink: expectedSendCountが一致していても、expectedSentAtVersion（第5引数）がpaymentLinkSentAtVersionと一致しない場合はSEND_HISTORY_CONFLICTで拒否する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  var first = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, false, 0, 0);
  assert.strictEqual(first.success, true, JSON.stringify(first));
  var staleSentAtVersion = ctx.sandbox.getAdminBookingDetail(bookingId).booking.paymentLinkSentAtVersion;

  /* paymentLinkSentAtだけを直接進める（paymentLinkSendCountは変えない）。2回目の
     書き込みだけが失敗した状態を模擬する。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { paymentLinkSentAt: new Date(staleSentAtVersion + 5000) });

  var staleTabForced = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, true, 1, staleSentAtVersion);
  assert.strictEqual(staleTabForced.success, false);
  assert.strictEqual(staleTabForced.error.code, 'SEND_HISTORY_CONFLICT', 'expectedSendCount(1)は実際の値と一致していても、送信日時が変わっているため競合として拒否するべき');

  var paymentLinkMails = mailApp._sentEmails.filter(function (mail) { return mail.subject && mail.subject.indexOf('お支払い') !== -1; });
  assert.strictEqual(paymentLinkMails.length, 1, '競合したリクエストからは送信されないべき');
});

/*
 * 第2回PRレビュー対応（part4の再現テスト）: 2回目の履歴保存だけが失敗した状態を
 * adminSendCardPaymentLink経由で再現し、その状態を見ていない別タブの古い前提
 * （expectedSendCount・expectedSentAtVersionのいずれも送信前の値のまま）からの
 * 明示的な再送がSEND_HISTORY_CONFLICTで拒否されることを確認する。
 */
test('adminSendCardPaymentLink: 2回目の履歴保存だけが失敗した状態を再現し、別タブの古い詳細画面（expectedSendCount・expectedSentAtVersionとも送信前の値）からの明示的な再送はSEND_HISTORY_CONFLICTで拒否される', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'paymentLinkSendCount')) {
      throw new Error('simulated Sheets outage while recording paymentLinkSendCount/URL/sentTo');
    }
    return original(id, fields);
  };
  var firstAttempt = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, false, 0, 0);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;

  assert.strictEqual(firstAttempt.success, true, JSON.stringify(firstAttempt));
  assert.strictEqual(firstAttempt.metadataInconsistent, true, '前提: 2回目の履歴保存が失敗しているべき');

  var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(detail.booking.paymentLinkSendCount, 0, '2回目の書き込みが失敗しているため送信回数は更新されていないはず');
  assert.ok(detail.booking.paymentLinkMetadataInconsistentAt, 'paymentLinkMetadataInconsistentAtが詳細へ反映されるべき');

  /* 別タブ: 送信前と同じ古い前提（expectedSendCount:0・expectedSentAtVersion:0）のまま
     明示的な再送を試みる。paymentLinkSendCountは実際にも0のままだが、
     paymentLinkSentAtVersionは既に更新されているため競合として検知されるべき。 */
  var staleTabForced = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, true, 0, 0);
  assert.strictEqual(staleTabForced.success, false);
  assert.strictEqual(staleTabForced.error.code, 'SEND_HISTORY_CONFLICT');

  var paymentLinkMails = mailApp._sentEmails.filter(function (mail) { return mail.subject && mail.subject.indexOf('お支払い') !== -1; });
  assert.strictEqual(paymentLinkMails.length, 1, '競合したタブからは送信されないべき（二重送信していない）');
});

/*
 * 第3回PRレビュー対応: paymentLinkMetadataInconsistentAtが記録されている間は、
 * 画面を最新化した（stale判定には引っかからない）操作であっても、通常送信・
 * 明示的な再送のいずれもMETADATA_INCONSISTENTで拒否されることをWeb UI層で確認する。
 */
test('adminSendCardPaymentLink: paymentLinkMetadataInconsistentAtが記録された予約は、最新のexpectedSendCount・expectedSentAtVersionを渡しても通常送信・明示的な再送のいずれもMETADATA_INCONSISTENTで拒否する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'paymentLinkSendCount')) {
      throw new Error('simulated Sheets outage while recording paymentLinkSendCount/URL/sentTo');
    }
    return original(id, fields);
  };
  ctx.sandbox.adminSendCardPaymentLink(bookingId, url, false, 0, 0);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;

  var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.ok(detail.booking.paymentLinkMetadataInconsistentAt, '前提: 記録不整合が発生しているべき');

  var freshNormal = ctx.sandbox.adminSendCardPaymentLink(
    bookingId, url, false, detail.booking.paymentLinkSendCount, detail.booking.paymentLinkSentAtVersion
  );
  assert.strictEqual(freshNormal.success, false);
  assert.strictEqual(freshNormal.error.code, 'METADATA_INCONSISTENT');

  var freshForced = ctx.sandbox.adminSendCardPaymentLink(
    bookingId, url, true, detail.booking.paymentLinkSendCount, detail.booking.paymentLinkSentAtVersion
  );
  assert.strictEqual(freshForced.success, false);
  assert.strictEqual(freshForced.error.code, 'METADATA_INCONSISTENT', '最新の前提でもforceは記録不整合を無視できないべき');

  var paymentLinkMails = mailApp._sentEmails.filter(function (mail) { return mail.subject && mail.subject.indexOf('お支払い') !== -1; });
  assert.strictEqual(paymentLinkMails.length, 1, '記録不整合が解消されるまで追加の送信は起きないべき');
});

/*
 * adminResolvePaymentLinkMetadataInconsistency（送信履歴の補正）。既存の正式関数
 * resolveCardPaymentLinkMetadataInconsistency（BookingAdmin.gs）へそのまま委譲していることを
 * 確認する（独自ロジックを持たない）。
 */
test('adminResolvePaymentLinkMetadataInconsistency: 記録不整合を補正すると、送信回数が更新され、送信が再び許可される', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'paymentLinkSendCount')) {
      throw new Error('simulated Sheets outage while recording paymentLinkSendCount/URL/sentTo');
    }
    return original(id, fields);
  };
  ctx.sandbox.adminSendCardPaymentLink(bookingId, url, false, 0, 0);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;

  var beforeResolve = ctx.sandbox.getAdminBookingDetail(bookingId).booking;
  assert.ok(beforeResolve.paymentLinkMetadataInconsistentAt);
  assert.strictEqual(beforeResolve.paymentLinkSendCount, 0);

  var resolveResult = ctx.sandbox.adminResolvePaymentLinkMetadataInconsistency(bookingId, 1, url, 'confirmed-sent-to@example.com');
  assert.strictEqual(resolveResult.success, true, JSON.stringify(resolveResult));

  var afterResolve = ctx.sandbox.getAdminBookingDetail(bookingId).booking;
  assert.strictEqual(afterResolve.paymentLinkSendCount, 1);
  assert.strictEqual(afterResolve.stripePaymentLinkUrl, url, '補正後は詳細でもURLが補正済みの値になっているべき');
  assert.strictEqual(afterResolve.paymentLinkSentTo, 'confirmed-sent-to@example.com', '補正後は詳細でも送信先が補正済みの値になっているべき');
  assert.strictEqual(afterResolve.paymentLinkMetadataInconsistentAt, '', '補正後は詳細でも不整合フラグが解消されているべき');

  var forcedAfterResolve = ctx.sandbox.adminSendCardPaymentLink(bookingId, url, true);
  assert.strictEqual(forcedAfterResolve.success, true, JSON.stringify(forcedAfterResolve));
});

test('adminResolvePaymentLinkMetadataInconsistency: 記録不整合ではない予約に対してはNOT_INCONSISTENTで拒否する（対象の限定。無関係な予約の送信履歴を書き換えられない）', function () {
  var ctx = setup();
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.adminResolvePaymentLinkMetadataInconsistency(bookingId, 5, 'https://buy.stripe.com/test_ABC123', 'confirmed-sent-to@example.com');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_INCONSISTENT');

  var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(detail.booking.paymentLinkSendCount, 0, '拒否された場合は送信履歴を書き換えない');
});

/*
 * 第5回PRレビュー対応: 補正対象がpaymentLinkSendCountのみから、URL・送信先を含む
 * 3項目に拡張されたことをWeb UI層でも確認する（confirmedUrl/confirmedSentToの検証を
 * 素通りさせず、GAS側のBooking.isValidStripePaymentLinkUrl/Booking.isValidEmailまで
 * 正しく配線されていること）。
 */
test('adminResolvePaymentLinkMetadataInconsistency: confirmedUrl・confirmedSentToが不正な形式の場合はそれぞれINVALID_CONFIRMED_URL・INVALID_CONFIRMED_SENT_TOで拒否し、既存の記録を書き換えない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = createPending(ctx, { paymentMethod: 'オンラインクレジットカード' });
  var url = 'https://buy.stripe.com/test_ABC123';

  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'paymentLinkSendCount')) {
      throw new Error('simulated Sheets outage while recording paymentLinkSendCount/URL/sentTo');
    }
    return original(id, fields);
  };
  ctx.sandbox.adminSendCardPaymentLink(bookingId, url, false, 0, 0);
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;

  var beforeResolve = ctx.sandbox.getAdminBookingDetail(bookingId).booking;
  assert.ok(beforeResolve.paymentLinkMetadataInconsistentAt, '前提: 記録不整合が発生しているべき');

  var invalidUrlResult = ctx.sandbox.adminResolvePaymentLinkMetadataInconsistency(bookingId, 1, 'not-a-stripe-url', 'confirmed-sent-to@example.com');
  assert.strictEqual(invalidUrlResult.success, false);
  assert.strictEqual(invalidUrlResult.error.code, 'INVALID_CONFIRMED_URL');

  var invalidSentToResult = ctx.sandbox.adminResolvePaymentLinkMetadataInconsistency(bookingId, 1, url, 'not-an-email');
  assert.strictEqual(invalidSentToResult.success, false);
  assert.strictEqual(invalidSentToResult.error.code, 'INVALID_CONFIRMED_SENT_TO');

  var afterInvalidAttempts = ctx.sandbox.getAdminBookingDetail(bookingId).booking;
  assert.strictEqual(afterInvalidAttempts.paymentLinkSendCount, 0, '拒否された場合は送信回数を書き換えない');
  assert.ok(afterInvalidAttempts.paymentLinkMetadataInconsistentAt, '拒否された場合は不整合フラグもクリアしない');
});
