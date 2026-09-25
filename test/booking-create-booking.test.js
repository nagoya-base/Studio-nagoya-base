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
  'JapaneseHolidays.gs',
  'BookingPricing.gs',
  'RateLimiter.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'AdminNotifier.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'BookingRepository.gs',
  'Code.gs'
];

var CALENDAR_ID = 'cal1';
var SPREADSHEET_ID = 'ss1';

/* Asia/Tokyo基準で実行時刻からdaysAhead日後の'YYYY-MM-DD'を返す（Issue #270 3回目
   レビュー指摘対応）。createBookingはnow省略時に実時刻で過去日拒否を行うため、
   validPayload()の既定dateを固定文字列にすると実行日がその日付を過ぎた時点で
   now省略呼び出しが一斉にINVALID_DATEへ変わり自然故障する。 */
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

/* DEFAULT_FUTURE_DATE上の'HH:mm'をJSTのDateへ変換する（Calendarイベントのstart/end用）。 */
function atDefaultDate_(hhmm) {
  return new Date(DEFAULT_FUTURE_DATE + 'T' + hhmm + ':00+09:00');
}

function setup(options) {
  var opts = options || {};
  var calendarsById = opts.calendarsById || { cal1: { events: [] } };
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};

  var properties = Object.assign({ CALENDAR_ID: CALENDAR_ID, SPREADSHEET_ID: SPREADSHEET_ID }, opts.properties || {});

  var globals = {
    PropertiesService: opts.propertiesService || stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    CacheService: opts.cacheService || stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    Logger: stubs.createLoggerStub(),
    ContentService: stubs.createContentServiceStub()
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

function callDoPost(sandbox, payload) {
  var contents = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return JSON.parse(sandbox.doPost({ postData: { contents: contents } }).text);
}

/*
 * 当日利用ルール（Issue #270）のテスト用固定時刻。createBookingはnow引数を受け取れるため、
 * JST 2026-10-01 12:00に受け付けたことにし、'2026-10-01'を当日、'2026-10-02'を翌日として扱う。
 * ブラウザのローカルtimezoneではなく、availabilityConfig.timezone（既定Asia/Tokyo）基準で
 * 当日判定が行われることを、この固定時刻とテスト対象日を一致させることで検証する。
 */
var NOW = new Date('2026-10-01T12:00:00+09:00');

test('createBooking: 正常な入力でPENDINGの予約が作成される（送信即CONFIRMEDにならない）', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'PENDING');
  assert.ok(result.bookingId);
});

test('doPost診断: successレスポンスと開始・終了ログに同一requestIdを含める', function () {
  var ctx = setup();
  var result = callDoPost(ctx.sandbox, validPayload());

  assert.strictEqual(result.success, true);
  assert.match(result.requestId, /^[A-Za-z0-9-]+$/);
  assert.ok(ctx.globals.Logger._logs.indexOf('requestId=' + result.requestId + ' createBooking=start') !== -1);
  assert.ok(ctx.globals.Logger._logs.indexOf('requestId=' + result.requestId + ' createBooking=result success') !== -1);
});

test('doPost診断: validation failureレスポンスとログに同一requestId・error.codeを含める', function () {
  var ctx = setup();
  var result = callDoPost(ctx.sandbox, validPayload({ customerType: 'invalid' }));

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_CUSTOMER_TYPE');
  assert.ok(result.requestId);
  assert.ok(
    ctx.globals.Logger._logs.indexOf(
      'requestId=' + result.requestId + ' createBooking=result error.code=INVALID_CUSTOMER_TYPE'
    ) !== -1
  );
});

test('doPost診断: INVALID_JSONにもrequestIdを返し、同一IDをログへ残す', function () {
  var ctx = setup();
  var result = callDoPost(ctx.sandbox, '{invalid json');

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_JSON');
  assert.ok(result.requestId);
  assert.ok(
    ctx.globals.Logger._logs.indexOf(
      'requestId=' + result.requestId + ' createBooking=result error.code=INVALID_JSON'
    ) !== -1
  );
});

test('doPost診断: Repositoryがnullを返してもTypeErrorへ化けず、requestId付きINTERNAL_ERRORを返す', function () {
  var ctx = setup();
  ctx.sandbox.BookingRepository.createBooking = function () { return null; };

  var result = callDoPost(ctx.sandbox, validPayload());

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INTERNAL_ERROR');
  assert.ok(result.requestId);
  assert.ok(
    ctx.globals.Logger._logs.indexOf(
      'requestId=' + result.requestId + ' createBooking=result error.code=INTERNAL_ERROR'
    ) !== -1
  );
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

test('createBooking: 未知のbrandは作成を拒否し、Calendar/Sheetsに何も作らない（Issue #269でsnb/mens/studio_xの3ブランドを許可した後も同様）', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ brand: 'ataru' }));

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_BRAND');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
});

test('createBooking (Issue #269): snb/mens/studio_xの3ブランドすべてでPENDING予約を作成できる', function () {
  ['snb', 'mens', 'studio_x'].forEach(function (brand, index) {
    var ctx = setup();
    var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ brand: brand, email: brand + '@example.com' }));

    assert.strictEqual(result.success, true, brand + ' は作成に成功するべき');
    assert.strictEqual(result.status, 'PENDING');
    assert.strictEqual(result.brand, brand);

    var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
    assert.ok(found, brand + ' の予約がSheetsに保存されているべき');
    assert.strictEqual(found.record.brand, brand, 'Sheetsのbrand列に正しいbrandが保存されるべき');
    assert.strictEqual(found.record.status, 'PENDING');

    var calendarEvent = ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); })[0];
    assert.strictEqual(calendarEvent.getTag('brand'), brand, 'Calendarのbrandタグに正しいbrandが保存されるべき');
    assert.strictEqual(calendarEvent.getTag('bookingId'), result.bookingId);
  });
});

/*
 * ── 利用料金の自動計算・保存（Issue #342） ──
 * DEFAULT_FUTURE_DATEはテスト実行日から動的に算出されるため（実行日に応じて曜日が
 * 変わってしまう）、料金の平日/土日祝判定に依存するテストでは使わず、遠い未来の
 * 固定日付（2099-01-05=月曜/平日、2099-01-03=土曜/2099-01-04=日曜=いずれも土日祝。
 * date -d で確認済み）を使う。
 */
var FIXED_WEEKDAY_DATE = '2099-01-05';
var FIXED_SATURDAY_DATE = '2099-01-03';

test('createBooking: 利用料金をGAS側で計算し、Sheetsへ保存する（studio_x・平日3時間）', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'studio_x', date: FIXED_WEEKDAY_DATE, durationMinutes: 180 })
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.price.amount, 6000);
  assert.strictEqual(result.price.tier, 'GENERAL');
  assert.strictEqual(result.price.dayType, 'WEEKDAY');
  assert.strictEqual(result.price.currency, 'JPY');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.strictEqual(found.record.priceAmount, 6000, '保存された金額はレスポンスと一致するべき');
  assert.strictEqual(found.record.priceTier, 'GENERAL');
  assert.strictEqual(found.record.priceDayType, 'WEEKDAY');
  assert.strictEqual(found.record.priceIsMember, false);
  assert.ok(found.record.priceComputedAt, 'priceComputedAtが記録されるべき');
});

test('createBooking: mensはisMember未送信でも常に会員料金で保存される', function () {
  var mensCtx = setup();
  var mensResult = mensCtx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'mens', date: FIXED_WEEKDAY_DATE, durationMinutes: 180 })
  );
  assert.strictEqual(mensResult.price.amount, 5500, 'mensは常に会員料金（5,500円）');
  assert.strictEqual(mensResult.price.tier, 'MEMBER');
  var mensFound = mensCtx.sandbox.SpreadsheetRepository.findRowByBookingId(mensResult.bookingId);
  assert.strictEqual(mensFound.record.priceIsMember, true);
});

test('createBooking: studio_xの直接予約もisMember:trueで会員料金になる（PR #343レビュー対応: ブランド分離基準書v1.1）', function () {
  var studioCtx = setup();
  var studioMemberResult = studioCtx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'studio_x', date: FIXED_WEEKDAY_DATE, durationMinutes: 180, isMember: true })
  );
  assert.strictEqual(studioMemberResult.price.amount, 5500, 'studio_xもisMember:trueなら会員料金になるべき');
  assert.strictEqual(studioMemberResult.price.tier, 'MEMBER');
  var studioMemberFound = studioCtx.sandbox.SpreadsheetRepository.findRowByBookingId(studioMemberResult.bookingId);
  assert.strictEqual(studioMemberFound.record.priceIsMember, true);

  var studioGeneralCtx = setup();
  var studioGeneralResult = studioGeneralCtx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'studio_x', date: FIXED_WEEKDAY_DATE, durationMinutes: 180 })
  );
  assert.strictEqual(studioGeneralResult.price.amount, 6000, 'isMember未送信は一般料金のまま（fail-closed）');
  assert.strictEqual(studioGeneralResult.price.tier, 'GENERAL');
});

test('createBooking: snbはisMember:trueを送ると会員料金で保存される', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'snb', date: FIXED_WEEKDAY_DATE, durationMinutes: 180, isMember: true })
  );
  assert.strictEqual(result.price.amount, 5500);
  assert.strictEqual(result.price.tier, 'MEMBER');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.strictEqual(found.record.priceTier, 'MEMBER');
  assert.strictEqual(found.record.priceIsMember, true);
});

test('createBooking: 土曜・日曜はいずれも土日祝料金として保存される', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'studio_x', date: FIXED_SATURDAY_DATE, durationMinutes: 120 })
  );
  assert.strictEqual(result.price.amount, 5000);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');
});

test('createBooking: 平日に当たる祝日も土日祝料金として保存される（Issue #346）', function () {
  var ctx = setup();
  /* 2099-11-23（勤労感謝の日）は月曜（date -d で確認済み。他のテストと同じくFIXED_
     WEEKDAY_DATE/FIXED_SATURDAY_DATEに合わせて2099年を使い、実行時刻に依存しない）。 */
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'studio_x', date: '2099-11-23', durationMinutes: 120 })
  );
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.price.amount, 5000);
  assert.strictEqual(result.price.dayType, 'WEEKEND_HOLIDAY');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.strictEqual(found.record.priceAmount, 5000, '保存された金額は祝日料金であるべき');
  assert.strictEqual(found.record.priceDayType, 'WEEKEND_HOLIDAY');
});

test('createBooking: 祝日判定に対応していない年（対応範囲外）はCalendar/Sheetsに何も作らずエラーを返す（Issue #346。過少請求防止のfail-closed）', function () {
  var ctx = setup();
  /* 過去日拒否（Booking.validateCreateBookingInput）に引っかからないよう、
     対応範囲外の日付(2019-12-25)より前の時刻を受付時刻(now)として明示する。 */
  var pastNow = new Date('2019-12-01T00:00:00+09:00');
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'studio_x', date: '2019-12-25', durationMinutes: 120, customerType: 'returning' }),
    pastNow
  );

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'HOLIDAY_YEAR_UNSUPPORTED');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0, '祝日判定エラー時はCalendarに何も作らない');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0, '祝日判定エラー時はSheetsに何も保存しない');
});

test('createBooking: フロントエンドから送られた金額・料金関連フィールドは一切信用せず、常にGAS側で再計算する（改ざん対策）', function () {
  var ctx = setup();
  var tamperedPayload = validPayload({
    brand: 'studio_x',
    date: FIXED_WEEKDAY_DATE,
    durationMinutes: 180
  });
  /* フロントは本来これらのフィールドを送らないが、悪意ある呼び出し元が直接POSTした
     場合を想定し、それらしいキー名を混入させても結果に一切影響しないことを確認する。 */
  tamperedPayload.price = { amount: 1 };
  tamperedPayload.priceAmount = 1;
  tamperedPayload.amount = 1;

  var result = ctx.sandbox.BookingRepository.createBooking(tamperedPayload);
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.price.amount, 6000, '改ざんされた金額(1円)ではなく、サーバー計算値(6,000円)が使われるべき');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.strictEqual(found.record.priceAmount, 6000);
});

test('createBooking: 予約完了画面が使うレスポンスのpriceは、Sheetsへ保存された金額と一致する', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'mens', date: FIXED_SATURDAY_DATE, durationMinutes: 240 })
  );
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.strictEqual(result.price.amount, found.record.priceAmount);
  assert.strictEqual(result.people, found.record.people);
  assert.strictEqual(result.paymentMethod, found.record.paymentMethod);
});

test('createBooking (Issue #269): bookingId prefixはブランドごとに異なり、studio_xの既存prefix "SX" は変更しない', function () {
  var expectedPrefixes = { snb: 'SNB-', mens: 'MENS-', studio_x: 'SX-' };
  Object.keys(expectedPrefixes).forEach(function (brand) {
    var ctx = setup();
    var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ brand: brand }));
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.bookingId.indexOf(expectedPrefixes[brand]), 0, brand + ' のbookingIdは "' + expectedPrefixes[brand] + '" で始まるべき: ' + result.bookingId);
  });
});

test('createBooking (Issue #269): Calendarタイトルにもブランド表示名が入るが、空き判定・状態判定はこれに依存しない', function () {
  var ctx = setup();
  ctx.sandbox.BookingRepository.createBooking(validPayload({ brand: 'mens' }));
  var event = ctx.calendarsById.cal1.events[0];
  assert.match(event.getTitle(), /SNB mens/);
});

test('createBooking (Issue #269): SNB/mens/Studio Xは同一Calendarのため、いずれかのブランドで作った予約は他の2ブランドから見てもSLOT_CONFLICTになる', function () {
  var pairs = [
    ['snb', 'mens'],
    ['snb', 'studio_x'],
    ['mens', 'snb'],
    ['mens', 'studio_x'],
    ['studio_x', 'snb'],
    ['studio_x', 'mens']
  ];
  pairs.forEach(function (pair) {
    var firstBrand = pair[0];
    var secondBrand = pair[1];
    var ctx = setup();
    var first = ctx.sandbox.BookingRepository.createBooking(
      validPayload({ brand: firstBrand, email: firstBrand + '-a@example.com' })
    );
    assert.strictEqual(first.success, true, firstBrand + ' の1件目は成功するべき');

    var second = ctx.sandbox.BookingRepository.createBooking(
      validPayload({ brand: secondBrand, email: secondBrand + '-b@example.com' })
    );
    assert.strictEqual(second.success, false, firstBrand + '予約後の同時間' + secondBrand + '予約は拒否されるべき');
    assert.strictEqual(second.error.code, 'SLOT_CONFLICT');
    assert.strictEqual(
      ctx.calendarsById.cal1.events.filter(function (e) { return !e.isDeleted(); }).length,
      1,
      firstBrand + '/' + secondBrand + ': 競合時に新規イベントが作られてはいけない'
    );
  });
});

test('createBooking: 入力不正（不正な日付）はCalendar再取得すら行わずに拒否する', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ date: 'invalid' }));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_DATE');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
});

test('createBooking: 開始時刻が15分刻みでない場合はSTART_TIME_NOT_ALIGNEDで拒否し、Calendar/Sheetsに何も作らない', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ startTime: '10:07' }));
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'START_TIME_NOT_ALIGNED');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
});

test('createBooking: Availability設定（BUFFER_MINUTES等）が不正な場合はfail-closedにINVALID_CONFIGで拒否し、Calendarへ問い合わせない（既存予約との競合見落とし事故を防ぐ）', function () {
  var ctx = setup({ properties: { BUFFER_MINUTES: 'abc' } });
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_CONFIG');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0, 'BUFFER_MINUTESが不正な間はCalendarへ問い合わせてはいけない');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
});

test('createBooking: SLOT_STEP_MINUTES=0のような不正設定もfail-closedにINVALID_CONFIGで拒否する', function () {
  var ctx = setup({ properties: { SLOT_STEP_MINUTES: '0' } });
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_CONFIG');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
});

test('#267との境界: getAvailabilityでは空きだったのに、その後Calendarに別予定(スペースマーケット由来含む)が入った場合、createBooking直前の再確認で検出して拒否し、PENDINGイベント・Sheets行のどちらも作らない', function () {
  var ctx = setup();

  /* 1. フロントでgetAvailability相当を呼んだ時点では空き（イベント無し） */
  var busyBefore = ctx.sandbox.CalendarRepository.getBusyIntervalsForDate(CALENDAR_ID, DEFAULT_FUTURE_DATE, 'Asia/Tokyo');
  assert.strictEqual(busyBefore.length, 0);

  /* 2. その後、スペースマーケット由来の同一Calendar上の予定が直接追加される
        （タイトルに一切依存しないことを示すため、あえてSM専用の接頭辞を付けない） */
  ctx.calendarsById.cal1.events.push(
    stubs.createEventStub({
      start: atDefaultDate_('10:30'),
      end: atDefaultDate_('11:30'),
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
        start: atDefaultDate_('10:30'),
        end: atDefaultDate_('11:30'),
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
    stubs.createEventStub({ start: atDefaultDate_('10:30'), end: atDefaultDate_('11:30'), isAllDay: false })
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

/* ---------- 当日利用ルール（Issue #270） ---------- */

test('createBooking: 当日(2026-10-01) + 初回利用(first_time)はSAME_DAY_NOT_ALLOWED_FOR_FIRST_TIMEで拒否し、Calendar/Sheetsに何も作らず、bookingIdも発行・永続化しない', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ customerType: 'first_time', date: '2026-10-01', startTime: '13:00' }),
    NOW
  );

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME');
  assert.strictEqual(result.bookingId, undefined, '拒否時はbookingIdを返さない');
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0, 'Calendarイベントを作らない');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0, 'Sheets行を作らない');
});

test('createBooking: 当日(2026-10-01) + 利用経験あり(returning)は通常どおりPENDINGを作成できる', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ customerType: 'returning', date: '2026-10-01', startTime: '13:00' }),
    NOW
  );

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'PENDING', '当日予約も送信時点ではPENDINGのまま（自動確定しない）');
  assert.ok(result.bookingId);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
  assert.strictEqual(found.record.customerType, 'returning', 'SheetsのcustomerType列に正しい利用区分が保存されるべき');

  var event = ctx.calendarsById.cal1.events[0];
  assert.strictEqual(event.getTag('status'), 'PENDING');
});

test('createBooking: 翌日(2026-10-02)は初回利用/利用経験ありのどちらも通常どおり作成できる', function () {
  ['first_time', 'returning'].forEach(function (customerType) {
    var ctx = setup();
    var result = ctx.sandbox.BookingRepository.createBooking(
      validPayload({ customerType: customerType, date: '2026-10-02', startTime: '13:00', email: customerType + '@example.com' }),
      NOW
    );
    assert.strictEqual(result.success, true, customerType);
    assert.strictEqual(result.status, 'PENDING');
  });
});

test('createBooking: 当日+初回利用の拒否・当日+利用経験ありの許可は、snb/mens/studio_xのいずれのbrandでも同じ挙動になる（brandで分岐させない。Issue #270）', function () {
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var blockedCtx = setup();
    var blocked = blockedCtx.sandbox.BookingRepository.createBooking(
      validPayload({ brand: brand, customerType: 'first_time', date: '2026-10-01', startTime: '13:00' }),
      NOW
    );
    assert.strictEqual(blocked.success, false, brand + ': 当日+初回利用は拒否されるべき');
    assert.strictEqual(blocked.error.code, 'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME', brand);

    var allowedCtx = setup();
    var allowed = allowedCtx.sandbox.BookingRepository.createBooking(
      validPayload({ brand: brand, customerType: 'returning', date: '2026-10-01', startTime: '13:00' }),
      NOW
    );
    assert.strictEqual(allowed.success, true, brand + ': 当日+利用経験ありは許可されるべき');
    var found = allowedCtx.sandbox.SpreadsheetRepository.findRowByBookingId(allowed.bookingId);
    assert.strictEqual(found.record.brand, brand);
    assert.strictEqual(found.record.customerType, 'returning');
  });
});

test('createBooking: customerType未指定・不正値はINVALID_CUSTOMER_TYPEでfail-closedに拒否し、Calendar/Sheetsに何も作らない（フロント改変での当日制限回避を防ぐ）', function () {
  [undefined, null, '', 'member', 'FIRST_TIME'].forEach(function (customerType) {
    var ctx = setup();
    var payload = validPayload({ customerType: customerType, date: '2026-10-02' });
    var result = ctx.sandbox.BookingRepository.createBooking(payload, NOW);
    assert.strictEqual(result.success, false, JSON.stringify(customerType));
    assert.strictEqual(result.error.code, 'INVALID_CUSTOMER_TYPE');
    assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
    assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
  });
});

test('createBooking: 過去日はcustomerTypeを問わずINVALID_DATEで拒否する（当日判定はAsia/Tokyo基準。ブラウザのローカルtimezoneに依存しない）', function () {
  ['first_time', 'returning'].forEach(function (customerType) {
    var ctx = setup();
    var result = ctx.sandbox.BookingRepository.createBooking(
      validPayload({ customerType: customerType, date: '2026-09-30', startTime: '13:00' }),
      NOW
    );
    assert.strictEqual(result.success, false, customerType);
    assert.strictEqual(result.error.code, 'INVALID_DATE');
  });
});

test('createBooking: 当日+利用経験ありで、開始時刻が現在時刻以前（受付NOW=12:00に対し09:00開始）はAPI直呼びでもSAME_DAY_START_TIME_PASSEDで拒否し、Calendar/Sheetsに何も作らない', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ customerType: 'returning', date: '2026-10-01', startTime: '09:00' }),
    NOW
  );
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'SAME_DAY_START_TIME_PASSED');
  assert.strictEqual(result.bookingId, undefined);
  assert.strictEqual(ctx.calendarsById.cal1.events.length, 0);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.getAllPendingBookings().length, 0);
});

test('createBooking: 当日+利用経験ありで、開始時刻が現在時刻より後（受付NOW=12:00に対し13:00開始）なら他条件が正常な限り成功する', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ customerType: 'returning', date: '2026-10-01', startTime: '13:00' }),
    NOW
  );
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.status, 'PENDING');
});

test('createBooking: 当日+初回利用は、開始時刻が現在時刻より後であってもSAME_DAY_NOT_ALLOWED_FOR_FIRST_TIMEが先に返る（優先順位の確認）', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ customerType: 'first_time', date: '2026-10-01', startTime: '13:00' }),
    NOW
  );
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME');
});

test('createBooking: snb/mens/studio_xのいずれのbrandでも当日の過去開始時刻拒否は同じ挙動になる（brandで分岐させない）', function () {
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var ctx = setup();
    var result = ctx.sandbox.BookingRepository.createBooking(
      validPayload({ brand: brand, customerType: 'returning', date: '2026-10-01', startTime: '09:00' }),
      NOW
    );
    assert.strictEqual(result.success, false, brand);
    assert.strictEqual(result.error.code, 'SAME_DAY_START_TIME_PASSED', brand);
  });
});

test('rate limit: 同一メール10分以内3件を超えるとRATE_LIMITEDで拒否する', function () {
  var ctx = setup();
  var now = Date.parse('2026-09-20T00:00:00+09:00');
  var originalNow = Date.now;
  /* createBookingはnow省略時に実時刻を使うため、日付は固定文字列ではなく動的に算出する
     （Issue #270 3回目レビュー指摘対応）。日付を分けるのはSLOT_CONFLICTを避けるためだけで、
     具体的な値自体はテストの意図に無関係。 */
  var dates = [futureDateJst_(61), futureDateJst_(62), futureDateJst_(63), futureDateJst_(64)];
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

test('Issue #273診断: Sheets失敗時はrequestId・sanitized error・Calendar補償・Recovery記録の成否をログへ残す', function () {
  var ctx = setup();
  var payload = validPayload({
    name: '診断秘密太郎',
    email: 'diagnostic-secret@example.com',
    phone: '090-9999-9999',
    note: '診断秘密メモ'
  });
  var failedBookingId;
  ctx.sandbox.SpreadsheetRepository.appendBooking = function (record) {
    failedBookingId = record.bookingId;
    throw new Error([
      'simulated sheets failure',
      record.bookingId,
      payload.name,
      payload.email,
      payload.phone,
      payload.note,
      CALENDAR_ID,
      SPREADSHEET_ID
    ].join(' / '));
  };

  var result = ctx.sandbox.BookingRepository.createBooking(payload, undefined, 'request-273');

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');
  var logs = ctx.globals.Logger._logs.join('\n');
  assert.match(logs, /requestId=request-273 handleSheetsSaveFailure sheetsError=simulated sheets failure/);
  assert.match(logs, /requestId=request-273 handleSheetsSaveFailure calendarCompensation=success/);
  assert.match(logs, /requestId=request-273 handleSheetsSaveFailure recoveryRecord=success/);
  assert.ok(failedBookingId);
  assert.strictEqual(logs.indexOf(failedBookingId), -1, '診断ログへbookingIdを出してはいけない');
  [payload.name, payload.email, payload.phone, payload.note, CALENDAR_ID, SPREADSHEET_ID].forEach(function (secret) {
    assert.strictEqual(logs.indexOf(secret), -1, '診断ログへPII・設定値を出してはいけない: ' + secret);
  });
});

test('Issue #273診断: Recovery記録失敗も同じrequestIdでsanitizedログへ残す', function () {
  var ctx = setup();
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('simulated sheets failure');
  };
  ctx.sandbox.RecoveryRepository.recordFailure = function () {
    throw new Error('recovery failed for diagnostic-secret@example.com');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload(), undefined, 'request-recovery-failure');

  assert.strictEqual(result.success, false);
  var logs = ctx.globals.Logger._logs.join('\n');
  assert.match(
    logs,
    /requestId=request-recovery-failure handleSheetsSaveFailure recoveryRecord=failure error=recovery failed for \[REDACTED_EMAIL\]/
  );
  assert.strictEqual(logs.indexOf('diagnostic-secret@example.com'), -1);
});

test('Issue #273診断: Sheets失敗時はPII・内部IDを含まない診断プロパティを保存する', function () {
  var ctx = setup();
  var payload = validPayload({
    name: '診断秘密太郎',
    email: 'diagnostic-secret@example.com',
    phone: '090-9999-9999',
    note: '診断秘密メモ'
  });
  var failedBookingId;
  var failedEventId;
  ctx.sandbox.SpreadsheetRepository.appendBooking = function (record) {
    failedBookingId = record.bookingId;
    failedEventId = record.calendarEventId;
    throw new Error([
      'sheets failed for diagnostic-secret@example.com',
      record.bookingId,
      record.calendarEventId,
      CALENDAR_ID,
      SPREADSHEET_ID,
      payload.name,
      payload.phone,
      payload.note
    ].join(' / '));
  };

  var result = ctx.sandbox.BookingRepository.createBooking(payload, undefined, 'request-property-success');

  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');
  var raw = ctx.globals.PropertiesService.getScriptProperties()
    .getProperty('BOOKING_DIAG_request-property-success');
  var diagnostic = JSON.parse(raw);
  assert.deepStrictEqual(
    Object.keys(diagnostic).sort(),
    ['calendarCompensation', 'occurredAt', 'recoveryRecord', 'requestId', 'sheetsError'].sort()
  );
  assert.strictEqual(diagnostic.requestId, 'request-property-success');
  assert.match(diagnostic.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(diagnostic.calendarCompensation, 'success');
  assert.strictEqual(diagnostic.recoveryRecord, 'success');
  assert.match(diagnostic.sheetsError, /sheets failed for \[REDACTED_EMAIL\]/);
  [
    failedBookingId,
    failedEventId,
    CALENDAR_ID,
    SPREADSHEET_ID,
    payload.name,
    payload.email,
    payload.phone,
    payload.note
  ].forEach(function (secret) {
    assert.strictEqual(raw.indexOf(secret), -1, '診断プロパティへPII・内部IDを保存してはいけない: ' + secret);
  });
  assert.strictEqual(raw.indexOf('bookingId'), -1);
});

test('Issue #273診断: Sheets例外直後にCalendar補償前の暫定診断を保存する', function () {
  var propertiesService = stubs.createPropertiesServiceStub({
    CALENDAR_ID: CALENDAR_ID,
    SPREADSHEET_ID: SPREADSHEET_ID
  });
  var ctx = setup({ propertiesService: propertiesService });
  var diagnosticBeforeCalendar;
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('early sheets failure for diagnostic-secret@example.com');
  };
  ctx.sandbox.CalendarRepository.deleteEventById = function () {
    diagnosticBeforeCalendar = JSON.parse(propertiesService.getScriptProperties()
      .getProperty('BOOKING_DIAG_request-before-calendar'));
  };

  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload(), undefined, 'request-before-calendar'
  );

  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');
  assert.deepStrictEqual(diagnosticBeforeCalendar, {
    requestId: 'request-before-calendar',
    occurredAt: diagnosticBeforeCalendar.occurredAt,
    sheetsError: 'early sheets failure for [REDACTED_EMAIL]',
    calendarCompensation: 'not_attempted',
    recoveryRecord: 'not_attempted'
  });
  assert.match(diagnosticBeforeCalendar.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('Issue #273診断: 初回保存後に後続更新が停止してもsanitized暫定診断が残る', function () {
  var propertiesService = stubs.createPropertiesServiceStub(
    { CALENDAR_ID: CALENDAR_ID, SPREADSHEET_ID: SPREADSHEET_ID },
    {
      setPropertyError: new Error('simulated diagnostic update interruption'),
      setPropertyErrorAfter: 1
    }
  );
  var ctx = setup({ propertiesService: propertiesService });
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('interrupted sheets failure for diagnostic-secret@example.com');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload(), undefined, 'request-interrupted-after-initial'
  );

  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');
  var raw = propertiesService.getScriptProperties()
    .getProperty('BOOKING_DIAG_request-interrupted-after-initial');
  var diagnostic = JSON.parse(raw);
  assert.strictEqual(diagnostic.sheetsError, 'interrupted sheets failure for [REDACTED_EMAIL]');
  assert.strictEqual(diagnostic.calendarCompensation, 'not_attempted');
  assert.strictEqual(diagnostic.recoveryRecord, 'not_attempted');
  assert.strictEqual(raw.indexOf('diagnostic-secret@example.com'), -1);
});

test('Issue #273診断: Calendar補償失敗とRecovery成功を診断プロパティへ保存する', function () {
  var ctx = setup();
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('simulated sheets failure');
  };
  ctx.sandbox.CalendarRepository.deleteEventById = function () {
    throw new Error('simulated calendar delete failure');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload(), undefined, 'request-calendar-failure'
  );

  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');
  var diagnostic = JSON.parse(ctx.globals.PropertiesService.getScriptProperties()
    .getProperty('BOOKING_DIAG_request-calendar-failure'));
  assert.strictEqual(diagnostic.calendarCompensation, 'failure');
  assert.strictEqual(diagnostic.recoveryRecord, 'success');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(diagnostic, 'recoveryError'), false);
});

test('Issue #273診断: Recovery失敗とsanitize済みrecoveryErrorを診断プロパティへ保存する', function () {
  var ctx = setup();
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('simulated sheets failure');
  };
  ctx.sandbox.RecoveryRepository.recordFailure = function () {
    throw new Error('recovery failed for diagnostic-secret@example.com');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload(), undefined, 'request-recovery-property-failure'
  );

  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');
  var raw = ctx.globals.PropertiesService.getScriptProperties()
    .getProperty('BOOKING_DIAG_request-recovery-property-failure');
  var diagnostic = JSON.parse(raw);
  assert.strictEqual(diagnostic.calendarCompensation, 'success');
  assert.strictEqual(diagnostic.recoveryRecord, 'failure');
  assert.strictEqual(diagnostic.recoveryError, 'recovery failed for [REDACTED_EMAIL]');
  assert.strictEqual(raw.indexOf('diagnostic-secret@example.com'), -1);
});

test('Issue #273診断: 診断プロパティ保存失敗でも既存のBOOKING_SAVE_FAILEDを維持する', function () {
  var properties = { CALENDAR_ID: CALENDAR_ID, SPREADSHEET_ID: SPREADSHEET_ID };
  var failingPropertiesService = stubs.createPropertiesServiceStub(properties, {
    setPropertyError: new Error('diagnostic property write failed')
  });
  var ctx = setup({ propertiesService: failingPropertiesService });
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('simulated sheets failure');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload(), undefined, 'request-property-write-failure'
  );

  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), {
    success: false,
    error: {
      code: 'BOOKING_SAVE_FAILED',
      message: '予約の保存に失敗しました。しばらくしてから再度お試しください。'
    }
  });
  assert.strictEqual(
    failingPropertiesService.getScriptProperties().getProperty('BOOKING_DIAG_request-property-write-failure'),
    null
  );
});

test('Issue #273診断: debugReadBookingDiagnosticは指定requestIdの1キーだけをLoggerへ出す', function () {
  var ctx = setup();
  ctx.globals.PropertiesService.getScriptProperties().setProperty(
    'BOOKING_DIAG_request-to-read',
    '{"requestId":"request-to-read"}'
  );
  ctx.globals.PropertiesService.getScriptProperties().setProperty(
    'BOOKING_DIAG_other-request',
    '{"requestId":"other-request"}'
  );

  ctx.sandbox.debugReadBookingDiagnostic('request-to-read');

  assert.deepStrictEqual(ctx.globals.Logger._logs, ['{"requestId":"request-to-read"}']);
});

test('部分失敗補償: Calendar成功・Sheets失敗・Calendar補償削除も失敗した場合はNEEDS_MANUAL_RECOVERYとしてrecoveryへ残す', function () {
  var ctx = setup();
  ctx.sandbox.SpreadsheetRepository.appendBooking = function () {
    throw new Error('simulated sheets failure');
  };
  ctx.sandbox.CalendarRepository.deleteEventById = function () {
    throw new Error('simulated calendar delete failure');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload(), undefined, 'request-compensation-failure');

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'BOOKING_SAVE_FAILED');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'SHEETS_FAILURE_CALENDAR_ORPHANED');
  assert.strictEqual(recovered[0].recoveryState, 'OPEN');
  assert.match(recovered[0].errorMessage, /simulated sheets failure/);
  assert.match(recovered[0].errorMessage, /simulated calendar delete failure/);
  assert.match(
    ctx.globals.Logger._logs.join('\n'),
    /requestId=request-compensation-failure handleSheetsSaveFailure calendarCompensation=failure error=simulated calendar delete failure/
  );
});

test('通知失敗: 管理者通知が失敗しても予約自体は成功のままであり、recoveryへ情報として記録される', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('mail server down') });
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, true, '通知失敗は予約失敗として扱わない');
  assert.strictEqual(result.status, 'PENDING');

  /*
   * Issue #271でcreateBookingへ利用者向けPENDINGメールも配線したため、このテストのように
   * BOOKING_MAIL_*（表示名/reply-to/問い合わせ先）を設定していない場合、管理者通知に加えて
   * 利用者PENDINGメールもfail-closedに失敗し、recoveryへ2件記録される
   * （どちらの失敗もcreateBooking自体の成否には影響しない）。
   */
  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 2);
  var failureTypes = recovered.map(function (r) { return r.failureType; });
  assert.ok(failureTypes.indexOf('ADMIN_NOTIFICATION_FAILED') !== -1);
  assert.ok(failureTypes.indexOf('MAIL_PENDING_FAILED') !== -1);
});

test('通知失敗: 利用者向けPENDINGメール送信の設定・送信自体が失敗しても、createBookingは成功のままでlastMailError*が記録される', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, true, 'PENDINGメール設定不足でもcreateBooking自体は成功する');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
  assert.strictEqual(found.record.pendingMailSentAt, '');
  assert.ok(stubs.isDateLike(found.record.lastMailErrorAt));
  assert.strictEqual(found.record.lastMailErrorType, 'PENDING');
});

test('通知失敗（PRレビュー2回目対応）: BookingMailer.sendPendingMailForBookingが想定外の例外を投げても、Loggerへ生のメールアドレスを残さない', function () {
  var ctx = setup();
  ctx.sandbox.BookingMailer.sendPendingMailForBooking = function () {
    throw new Error('unexpected failure for secret@example.com');
  };

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload({ email: 'secret@example.com' }));
  assert.strictEqual(result.success, true, 'PENDINGメール送信中の想定外例外でもcreateBooking自体は成功する');

  var logs = ctx.globals.Logger._logs;
  var pendingMailLogs = logs.filter(function (line) { return line.indexOf('PENDINGメール送信中') !== -1; });
  assert.strictEqual(pendingMailLogs.length, 1);
  assert.strictEqual(pendingMailLogs[0].indexOf('secret@example.com'), -1, 'Loggerに生のメールアドレスを残してはいけない');
  assert.match(pendingMailLogs[0], /\[REDACTED_EMAIL\]/);
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

test('管理者通知 (Issue #342): 利用者向け仮予約受付メールと同じ利用料金を含む（PIIではないため表示してよい）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  var result = ctx.sandbox.BookingRepository.createBooking(
    validPayload({ brand: 'studio_x', date: FIXED_WEEKDAY_DATE, durationMinutes: 180 })
  );

  var adminMail = mailApp._sentEmails.filter(function (m) { return m.to === 'admin@example.com'; })[0];
  assert.ok(adminMail, '管理者通知メールが送られるべき');
  assert.match(adminMail.body, /利用料金: 6,000円（税込）/);
  assert.match(adminMail.body, new RegExp(result.bookingId));
});

test('管理者通知 (Issue #269): 通知件名にはbrandの表示名が入り、ブランドごとに区別できる', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  ctx.sandbox.BookingRepository.createBooking(validPayload({ brand: 'mens' }));

  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.match(mailApp._sentEmails[0].subject, /SNB mens/);
});

/*
 * 管理者通知メールの利用日・Calendar Event ID・Booking Adminリンク（Issue #311）。
 * DEFAULT_FUTURE_DATEは実行時刻依存で動的に算出される（このファイル冒頭のfutureDateJst_
 * 参照）ため、期待する曜日ラベルも固定文字列で決め打ちせず、AdminNotifier.gs本体と同じ
 * BookingAvailability.formatDateWithWeekdayで算出した値と比較する（曜日算出ロジック自体の
 * 正しさはtest/booking-availability.test.jsで別途検証済み）。
 */
test('管理者通知 (Issue #311): 利用日に「YYYY-MM-DD（曜）」形式で曜日が付与される（new Date(record.date).getDay()のようなtimezone依存実装は使わない）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(mailApp._sentEmails.length, 1);
  var expectedDateLine = '利用日: ' + ctx.sandbox.BookingAvailability.formatDateWithWeekday(DEFAULT_FUTURE_DATE);
  assert.ok(
    mailApp._sentEmails[0].body.indexOf(expectedDateLine) !== -1,
    '期待する利用日行が本文に見つからない: ' + JSON.stringify(mailApp._sentEmails[0].body)
  );
});

test('管理者通知 (Issue #311): 本文に「Calendar Event ID」という文字列が一切含まれない（calendarEventId自体の内部保持・Spreadsheet/Calendar連携ロジックは変更していない）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.strictEqual(mailApp._sentEmails[0].body.indexOf('Calendar Event ID'), -1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId);
  assert.ok(found.record.calendarEventId, 'calendarEventId自体はSpreadsheet台帳から削除していない');
});

test('管理者通知 (Issue #311): BOOKING_ADMIN_URL未設定時はBooking Adminリンク行が本文に出ず、従来どおりSpreadsheet案内のまま', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  ctx.sandbox.BookingRepository.createBooking(validPayload());

  var body = mailApp._sentEmails[0].body;
  assert.strictEqual(body.indexOf('Booking Admin'), -1);
  assert.match(body, /Spreadsheetの管理メニューから確定してください/);
});

test('管理者通知 (Issue #311): BOOKING_ADMIN_URL設定時はBooking Adminリンクが本文に出て、案内文もBooking Admin誘導に切り替わる', function () {
  var mailApp = stubs.createMailAppStub();
  var adminUrl = 'https://script.google.com/macros/s/EXAMPLE_ADMIN_DEPLOY_ID/exec';
  var ctx = setup({
    properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com', BOOKING_ADMIN_URL: adminUrl },
    mailApp: mailApp
  });

  ctx.sandbox.BookingRepository.createBooking(validPayload());

  var body = mailApp._sentEmails[0].body;
  assert.match(body, /Booking Admin:/);
  assert.ok(body.indexOf(adminUrl) !== -1);
  assert.match(body, /Booking Adminから確定してください/);
  assert.strictEqual(body.indexOf('Spreadsheetの管理メニューから確定してください'), -1);
});

test('管理者通知 (Issue #311): BOOKING_ADMIN_URL未設定でもcreateBooking・管理者通知自体は成功する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: { ADMIN_NOTIFICATION_EMAIL: 'admin@example.com' }, mailApp: mailApp });

  var result = ctx.sandbox.BookingRepository.createBooking(validPayload());

  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
});
