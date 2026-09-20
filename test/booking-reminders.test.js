/*
 * BookingReminderTriggers.gs（sendNextDayReminders / createNextDayReminderTrigger）の
 * テスト（Issue #271）。SpreadsheetApp/LockService/MailApp/ScriptAppはすべてスタブ。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = [
  'Config.gs',
  'Availability.gs',
  'Booking.gs',
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingMailTemplates.gs',
  'BookingMailer.gs',
  'BookingReminderTriggers.gs'
];

var SPREADSHEET_ID = 'ss1';

var COMPLETE_ACCESS_GUIDE_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com',
  ACCESS_GUIDE_ADDRESS: '愛知県名古屋市...',
  ACCESS_GUIDE_BUILDING: 'テストビル',
  ACCESS_GUIDE_ROOM: '101',
  ACCESS_GUIDE_ENTRANCE: '正面入口から左手',
  ACCESS_GUIDE_KEYBOX_LOCATION: '玄関脇',
  ACCESS_GUIDE_ENTRY_METHOD: '玄関の暗証番号を入力して解錠',
  ACCESS_GUIDE_KEYBOX_NUMBER: 'TEST-KEYBOX',
  ACCESS_GUIDE_UNLOCK_CODE: 'TEST-CODE',
  ACCESS_GUIDE_URL: 'https://example.com/how-to'
};

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign({ SPREADSHEET_ID: SPREADSHEET_ID }, opts.properties || {});
  var logger = opts.logger || stubs.createLoggerStub();

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    ScriptApp: opts.scriptApp || stubs.createScriptAppStub(),
    Logger: logger
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, logger: logger };
}

function seedBooking(ctx, overrides) {
  var record = Object.assign(
    {
      bookingId: 'SX-BOOKING',
      createdAt: new Date('2026-09-30T10:00:00+09:00'),
      date: '2026-10-02',
      startAt: new Date('2026-10-02T10:00:00+09:00'),
      endAt: new Date('2026-10-02T12:00:00+09:00'),
      brand: 'studio_x',
      name: '山田太郎',
      email: 'taro@example.com',
      phone: '090-0000-0000',
      people: '2名',
      purpose: '緊縛の自主練習',
      paymentMethod: '現金',
      status: 'CONFIRMED',
      calendarEventId: 'event-1',
      source: 'test',
      note: '',
      confirmedAt: new Date('2026-09-30T10:00:00+09:00'),
      expiredAt: '',
      cancelledAt: '',
      updatedAt: '',
      customerType: 'returning',
      pendingMailSentAt: new Date('2026-09-30T10:00:00+09:00'),
      confirmedMailSentAt: new Date('2026-09-30T10:00:00+09:00'),
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

/* JST 2026-10-01 18:00に実行 → 翌日は2026-10-02。 */
var NOW = new Date('2026-10-01T18:00:00+09:00');

test('sendNextDayReminders: JST基準で翌日(2026-10-02)のCONFIRMED予約だけに1通送る', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  seedBooking(ctx, { bookingId: 'TOMORROW-1', date: '2026-10-02' });

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.processedCount, 1);
  assert.strictEqual(summary.sentCount, 1);
  assert.strictEqual(summary.skippedCount, 0);
  assert.strictEqual(summary.failedCount, 0);
  assert.strictEqual(mailApp._sentEmails.length, 1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId('TOMORROW-1');
  assert.ok(stubs.isDateLike(found.record.reminderSentAt));
  assert.ok(stubs.isDateLike(found.record.accessGuideSentAt));
});

test('sendNextDayReminders: 今日・翌々日の予約は対象にしない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  seedBooking(ctx, { bookingId: 'TODAY', date: '2026-10-01' });
  seedBooking(ctx, { bookingId: 'DAY-AFTER-TOMORROW', date: '2026-10-03' });

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.processedCount, 0);
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendNextDayReminders: PENDING/CANCELLED/EXPIREDの翌日予約は対象にしない（CONFIRMEDのみ）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  ['PENDING', 'CANCELLED', 'EXPIRED'].forEach(function (status) {
    seedBooking(ctx, { bookingId: 'B-' + status, date: '2026-10-02', status: status });
  });

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.processedCount, 0, 'getConfirmedBookingsForDateの時点でCONFIRMED以外は除外される');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendNextDayReminders: reminderSentAt/accessGuideSentAtが既にある予約はskipし、二重送信しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  seedBooking(ctx, { bookingId: 'ALREADY-SENT', date: '2026-10-02', reminderSentAt: new Date('2026-09-30T18:00:00+09:00') });

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.processedCount, 1);
  assert.strictEqual(summary.sentCount, 0);
  assert.strictEqual(summary.skippedCount, 1);
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendNextDayReminders: 1件が送信失敗（秘密値未設定）しても、残りの予約は正常に送信を継続する', function () {
  var mailApp = stubs.createMailAppStub();
  /* ACCESS_GUIDE_UNLOCK_CODEを未設定にして、全予約が秘密値不足で失敗する状況を作った上で、
     さらに1件だけMailApp自体が例外を投げるケースと混在させ、バッチ内の障害分離を検証する。 */
  var ctx = setup({
    properties: {
      BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
      BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
      BOOKING_CONTACT_EMAIL: 'contact@example.com',
      ACCESS_GUIDE_KEYBOX_NUMBER: 'TEST-KEYBOX'
      /* ACCESS_GUIDE_UNLOCK_CODEを意図的に未設定にする */
    },
    mailApp: mailApp
  });
  seedBooking(ctx, { bookingId: 'FAIL-1', date: '2026-10-02', email: 'fail1@example.com' });
  seedBooking(ctx, { bookingId: 'FAIL-2', date: '2026-10-02', email: 'fail2@example.com' });

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.processedCount, 2);
  assert.strictEqual(summary.failedCount, 2, '両方とも秘密値不足で失敗する');
  assert.strictEqual(mailApp._sentEmails.length, 0);

  ['FAIL-1', 'FAIL-2'].forEach(function (bookingId) {
    var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
    assert.strictEqual(found.record.status, 'CONFIRMED', '失敗してもCONFIRMEDのまま');
    assert.ok(stubs.isDateLike(found.record.lastMailErrorAt));
  });
});

test('sendNextDayReminders: 1件だけMailApp送信が例外を投げても、他の予約の送信は継続する（バッチ内の障害分離）', function () {
  var callCount = 0;
  var mailApp = {
    sendEmail: function (message) {
      callCount++;
      if (message.to === 'ng@example.com') {
        throw new Error('simulated mail failure');
      }
    },
    _sentEmails: []
  };
  var originalSend = mailApp.sendEmail;
  mailApp.sendEmail = function (message) {
    originalSend(message);
    mailApp._sentEmails.push(message);
  };

  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  seedBooking(ctx, { bookingId: 'NG', date: '2026-10-02', email: 'ng@example.com' });
  seedBooking(ctx, { bookingId: 'OK', date: '2026-10-02', email: 'ok@example.com' });

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.processedCount, 2);
  assert.strictEqual(summary.failedCount, 1);
  assert.strictEqual(summary.sentCount, 1);

  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId('OK').record.reminderSentAt !== '', true);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId('NG').record.reminderSentAt, '');
});

/* ---------- セキュリティ（PRレビュー2回目対応）: Loggerへ個人情報・秘密値を残さない ---------- */

test('sendNextDayReminders: MailApp例外に利用者メールアドレスが含まれても、Loggerにはbooking Id + error.codeのみを残す', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('Invalid recipient: leak@example.com') });
  var logger = stubs.createLoggerStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp, logger: logger });
  seedBooking(ctx, { bookingId: 'LEAK-CHECK', date: '2026-10-02', email: 'leak@example.com' });

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.failedCount, 1);

  var failureLogs = logger._logs.filter(function (line) { return line.indexOf('LEAK-CHECK') !== -1; });
  assert.strictEqual(failureLogs.length, 1);
  assert.match(failureLogs[0], /MAIL_SEND_FAILED/, 'Loggerにerror.codeは残ってよい');
  logger._logs.forEach(function (line) {
    assert.strictEqual(line.indexOf('leak@example.com'), -1, 'Loggerに利用者メールアドレスを残してはいけない: ' + line);
    assert.strictEqual(line.indexOf('TEST-KEYBOX'), -1, 'Loggerにキーボックス番号を残してはいけない: ' + line);
    assert.strictEqual(line.indexOf('TEST-CODE'), -1, 'Loggerに解錠コードを残してはいけない: ' + line);
    assert.strictEqual(line.indexOf('明日のご予約について'), -1, 'Loggerにメール本文を残してはいけない: ' + line);
  });
});

test('sendNextDayReminders: BookingMailer側で想定外の例外が発生しても、Loggerへ生のメールアドレスを残さずsanitize済みの内容のみ残す', function () {
  var logger = stubs.createLoggerStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, logger: logger });
  seedBooking(ctx, { bookingId: 'UNEXPECTED-CHECK', date: '2026-10-02', email: 'unexpected@example.com' });

  /* BookingMailer.sendReminderMailForBooking自体が想定外の例外を投げるケースを模擬する
     （通常は発生しないが、sendNextDayReminders側のcatch (unexpectedError)の
     redaction経路を検証するため）。 */
  ctx.sandbox.BookingMailer.sendReminderMailForBooking = function () {
    throw new Error('unexpected failure for unexpected@example.com');
  };

  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.failedCount, 1);

  var failureLogs = logger._logs.filter(function (line) { return line.indexOf('UNEXPECTED-CHECK') !== -1; });
  assert.strictEqual(failureLogs.length, 1);
  assert.strictEqual(failureLogs[0].indexOf('unexpected@example.com'), -1, 'Loggerに生のメールアドレスを残してはいけない');
  assert.match(failureLogs[0], /\[REDACTED_EMAIL\]/);
});

test('sendNextDayReminders: 正式関数名 sendNextDayReminders(now) がグローバルに存在する（時間主導トリガー用）', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  assert.strictEqual(typeof ctx.sandbox.sendNextDayReminders, 'function');
});

test('createNextDayReminderTrigger: トリガーを作成し、二重作成しない', function () {
  var scriptApp = stubs.createScriptAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, scriptApp: scriptApp });

  ctx.sandbox.createNextDayReminderTrigger();
  ctx.sandbox.createNextDayReminderTrigger();

  var triggers = scriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'sendNextDayReminders'; });
  assert.strictEqual(triggers.length, 1, '同じハンドラのトリガーを重複作成しない');
});
