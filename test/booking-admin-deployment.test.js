/*
 * Issue #273回帰テスト。
 *
 * 本番Booking Adminで、既存PENDINGメールの再送（BookingAdmin.gsの「予約メールを再送」
 * メニュー）を実行すると「BookingAvailability is not defined」が発生していた。原因は
 * README.md「GASプロジェクトへのデプロイ対象ファイル」表でBooking Admin列が✓の一覧に
 * `Availability.gs`が含まれておらず、READMEどおりにBooking Adminプロジェクトを構築すると
 * `BookingMailTemplates.gs`（`formatTimeInTimezone`）・`BookingReminderTriggers.gs`
 * （`formatDateInTimezone`）・`BookingRepository.gs`の`expirePendingBookings`内部
 * （`Booking.formatDateInTimezone`経由）が参照する`Availability.gs`のグローバル
 * `BookingAvailability`が未定義になっていたため。
 *
 * 他の単体テスト（test/booking-mailer.test.js等）は検証対象のロジックに必要な.gsファイルを
 * 個別に列挙して読み込んでいるため、この「実際にBooking Adminへ配布するファイルセット
 * そのものの不整合」には気づけない。このファイルは、
 * test/helpers/booking-deployment-manifest.jsのBOOKING_ADMIN_FILES（README.mdの表と
 * 同期させる一覧）だけをvmへ読み込み、実際の本番構成と同じ実行セットで
 * ReferenceErrorが起きないことを検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var BOOKING_ADMIN_FILES = require('./helpers/booking-deployment-manifest').BOOKING_ADMIN_FILES;

var CALENDAR_ID = 'cal1';
var SPREADSHEET_ID = 'ss1';

var COMPLETE_MAIL_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

function setup(options) {
  var opts = options || {};
  var calendarsById = opts.calendarsById || { cal1: { events: [] } };
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign(
    { CALENDAR_ID: CALENDAR_ID, SPREADSHEET_ID: SPREADSHEET_ID },
    COMPLETE_MAIL_PROPERTIES,
    opts.properties || {}
  );

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub(calendarsById),
    Utilities: stubs.createUtilitiesStub(),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById, { ui: opts.ui, activeSheet: opts.activeSheet }),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    ScriptApp: opts.scriptApp || stubs.createScriptAppStub(),
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(BOOKING_ADMIN_FILES, globals);
  return { sandbox: sandbox, calendarsById: calendarsById, globals: globals };
}

function seedBooking(ctx, overrides) {
  var record = Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      createdAt: new Date('2026-10-01T09:00:00+09:00'),
      date: '2026-10-01',
      startAt: new Date('2026-10-01T09:30:00+09:00'),
      endAt: new Date('2026-10-01T11:30:00+09:00'),
      brand: 'studio_x',
      name: '山田太郎',
      email: 'taro@example.com',
      phone: '090-0000-0000',
      people: '2名',
      purpose: '緊縛の自主練習',
      paymentMethod: '現金',
      status: 'PENDING',
      calendarEventId: 'event-1',
      source: 'test',
      note: '',
      confirmedAt: '',
      expiredAt: '',
      cancelledAt: '',
      updatedAt: '',
      customerType: 'returning',
      pendingMailSentAt: '',
      confirmedMailSentAt: '',
      cancelMailSentAt: '',
      reminderSentAt: '',
      accessGuideSentAt: '',
      lastMailErrorAt: '',
      lastMailErrorType: '',
      lastMailErrorMessage: ''
    },
    overrides || {}
  );
  ctx.sandbox.SpreadsheetRepository.appendBooking(record);
  return record.bookingId;
}

test('Booking Admin配布ファイルセット: 既存PENDINGメールの再送がReferenceErrorなく成功する（Issue #273回帰）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result;
  assert.doesNotThrow(function () {
    result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId, { force: true });
  }, 'Availability.gsが配布ファイルセットに含まれていないと、BookingMailTemplates.buildPendingMailの' +
    'formatTimeInTimezone呼び出しでReferenceError: BookingAvailability is not definedになる');

  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
});

test('Booking Admin配布ファイルセット: BookingAdmin.gsの「予約メールを再送」メニュー配線（runResendMailAndAlert_）経由でも同様に成功する', function () {
  var mailApp = stubs.createMailAppStub();
  var ui = stubs.createSpreadsheetUiStub();
  var ctx = setup({ mailApp: mailApp, ui: ui });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  assert.doesNotThrow(function () {
    ctx.sandbox.runResendMailAndAlert_(bookingId, 'PENDING');
  });

  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.ok(
    ui._alerts.some(function (message) { return message.indexOf('再送しました') !== -1; }),
    '再送成功のアラートが表示されるべき（エラーで握りつぶされていないことの確認）'
  );
});

/*
 * PRレビュー対応の追加確認（Issue #334）: EXPIRED通知メールの送信失敗が、既存の
 * 管理者向けエラー確認（Booking Admin Web UIのhasMailError表示）・再送導線
 * （BookingAdmin.gsの「予約メールを再送」メニュー。RESEND_MAIL_HANDLERS_.EXPIRED）で
 * 扱えることを、実際の配布ファイルセット・実際の配線（runResendMailAndAlert_）を通して
 * 確認する。PENDING等の既存メール種別と同じ経路・同じ表示になることを検証し、
 * EXPIRED専用の別処理を作っていないことを保証する。
 */
test('Booking Admin配布ファイルセット: EXPIRED通知メールの送信失敗はhasMailErrorとして管理者に見え、既存の再送メニュー（RESEND_MAIL_HANDLERS_.EXPIRED）から再送できる（Issue #334 PRレビュー対応）', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('simulated mail send failure') });
  var ui = stubs.createSpreadsheetUiStub();
  var ctx = setup({ mailApp: mailApp, ui: ui });
  var bookingId = seedBooking(ctx, {
    status: 'EXPIRED',
    paymentMethod: 'オンラインクレジットカード',
    expiredAt: new Date('2026-10-01T09:30:00+09:00')
  });

  /* 1. 自動失効通知相当の送信が失敗する（expirePendingBookings自身の配線は
        test/booking-confirm-expire.test.jsで検証済みのため、ここでは送信関数を
        直接呼んで失敗を再現する）。 */
  var sendResult;
  assert.doesNotThrow(function () {
    sendResult = ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId);
  });
  assert.strictEqual(sendResult.success, false);
  assert.strictEqual(sendResult.error.code, 'MAIL_SEND_FAILED');

  var beforeRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.ok(beforeRecord.lastMailErrorAt, '他のメール種別と同じくlastMailError*へ記録されるべき');
  assert.strictEqual(beforeRecord.lastMailErrorType, 'EXPIRED');

  /* 2. 既存の管理者向けエラー確認（Booking Admin Web UIの詳細表示）に、他のメール種別と
        同じくhasMailError:trueとして表れる（EXPIRED専用の別フィールドは無い）。 */
  var detail = ctx.sandbox.getAdminBookingDetail(bookingId);
  assert.strictEqual(detail.booking.hasMailError, true);

  /* 3. 管理者側の送信環境が復旧した想定で、既存の個別再送メニュー配線
        （runResendMailAndAlert_→RESEND_MAIL_HANDLERS_.EXPIRED→force:true）から
        再送できることを確認する（PENDING等と同じ配線・同じ成功時アラート文言）。 */
  mailApp.sendEmail = function (message) {
    mailApp._sentEmails.push({ to: message.to, subject: message.subject, body: message.body });
  };

  assert.doesNotThrow(function () {
    ctx.sandbox.runResendMailAndAlert_(bookingId, 'EXPIRED');
  });

  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.match(mailApp._sentEmails[0].subject, /期限切れ/);
  assert.ok(
    ui._alerts.some(function (message) { return message.indexOf('再送しました') !== -1; }),
    '再送成功のアラートが表示されるべき（EXPIREDが未知のメール種別として扱われていないことの確認）'
  );

  var afterRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.ok(stubs.isDateLike(afterRecord.expiredMailSentAt), '再送成功でexpiredMailSentAtが記録されるべき');
  assert.strictEqual(afterRecord.lastMailErrorAt, '', '再送成功でlastMailError*はクリアされるべき');
});

test('Booking Admin配布ファイルセット: PENDING TTL失効（時間主導トリガーのexpirePendingBookings）がReferenceErrorなく成功する（Issue #273回帰）', function () {
  var event = stubs.createEventStub({
    id: 'event-1',
    start: new Date('2026-10-01T09:30:00+09:00'),
    end: new Date('2026-10-01T11:30:00+09:00'),
    isAllDay: false
  });
  var ctx = setup({ calendarsById: { cal1: { events: [event] } } });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  /* 受付日と利用日が一致する当日予約のため、expirePendingBookings内部で
     Booking.formatDateInTimezone（BookingAvailability.formatDateInTimezoneの薄い委譲）を
     必ず通る（Issue #270のgrace判定）。now=開始時刻より後にして確実に失効させる。 */
  var now = new Date('2026-10-01T10:00:00+09:00');
  var result;
  assert.doesNotThrow(function () {
    result = ctx.sandbox.expirePendingBookings(now);
  }, 'Availability.gsが配布ファイルセットに含まれていないと、expirePendingBookings内部の' +
    'Booking.formatDateInTimezone呼び出しでReferenceError: BookingAvailability is not definedになる');

  assert.strictEqual(result.expiredCount, 1);
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED');
});
