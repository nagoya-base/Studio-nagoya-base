/*
 * BookingReminderDiagnostics.gs（Issue #330: 前日リマインドの任意時刻デバッグ・
 * 管理者宛テスト送信）のテスト。SpreadsheetApp/MailAppはすべてスタブ。
 *
 * 検証観点:
 * - diagnoseReminderEligibility: 対象判定の正常系（ELIGIBLE）・異常系
 *   （NOT_NEXT_DAY/INVALID_STATUS/ALREADY_SENT/EMAIL_MISSING/MAIL_NOT_READY）
 * - previewReminderMail: 本番テンプレートを使ったプレビュー・解錠コードの既定マスク・
 *   reveal:trueでの表示
 * - sendReminderTestMail: ADMIN_NOTIFICATION_EMAIL固定送信・fail-closed・[TEST]件名・
 *   実予約者へ届かないこと
 * - 診断経路（3関数いずれも）が禁止された本番データ更新関数
 *   （SpreadsheetRepository.updateBookingFields / RecoveryRepository.recordFailure）を
 *   一切呼ばず、booking行・Recoveryシートを変更しないこと（副作用ゼロの確認）
 * - BookingMailer.evaluateReminderEligibilityが本番のwithBookingLock_と同じ
 *   evaluateStatusAndSentAt_を共有していること（診断専用の判定ロジックを複製していない
 *   ことの間接的な確認）
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var BOOKING_ADMIN_FILES = require('./helpers/booking-deployment-manifest').BOOKING_ADMIN_FILES;

var SPREADSHEET_ID = 'ss1';
var CALENDAR_ID = 'cal1';

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
  ACCESS_GUIDE_URL: 'https://example.com/how-to',
  ADMIN_NOTIFICATION_EMAIL: 'admin@example.com'
};

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign(
    { SPREADSHEET_ID: SPREADSHEET_ID, CALENDAR_ID: CALENDAR_ID },
    opts.properties || {}
  );
  var logger = opts.logger || stubs.createLoggerStub();

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    LockService: stubs.createLockServiceStub(),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    ScriptApp: stubs.createScriptAppStub(),
    Logger: logger
  };

  var sandbox = loadBookingSandbox(BOOKING_ADMIN_FILES, globals);
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

var BASE_DATE = '2026-10-01'; /* 翌日は2026-10-02 */

/* ---------- diagnoseReminderEligibility ---------- */

test('diagnoseReminderEligibility: 翌日のCONFIRMED予約はELIGIBLEを返す（副作用なし）', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED' });

  var result = ctx.sandbox.diagnoseReminderEligibility(bookingId, BASE_DATE);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.reasonCode, 'ELIGIBLE');
  assert.strictEqual(result.targetDate, '2026-10-02');
  assert.strictEqual(result.booking.email, 'taro@example.com');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.reminderSentAt, '', '診断だけではreminderSentAtを更新しない');
  assert.strictEqual(found.record.lastMailErrorAt, '', '診断だけではlastMailErrorAtを更新しない');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().length, 0, '診断だけではRecoveryへ記録しない');
});

test('diagnoseReminderEligibility: 翌日以外の日付はNOT_NEXT_DAYを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-05', status: 'CONFIRMED' });

  var result = ctx.sandbox.diagnoseReminderEligibility(bookingId, BASE_DATE);

  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reasonCode, 'NOT_NEXT_DAY');
});

test('diagnoseReminderEligibility: CONFIRMED以外はINVALID_STATUSを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'PENDING' });

  var result = ctx.sandbox.diagnoseReminderEligibility(bookingId, BASE_DATE);

  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reasonCode, 'INVALID_STATUS');
});

test('diagnoseReminderEligibility: reminderSentAt/accessGuideSentAt送信済みはALREADY_SENTを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, {
    date: '2026-10-02',
    status: 'CONFIRMED',
    reminderSentAt: new Date('2026-09-30T18:00:00+09:00')
  });

  var result = ctx.sandbox.diagnoseReminderEligibility(bookingId, BASE_DATE);

  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reasonCode, 'ALREADY_SENT');
});

test('diagnoseReminderEligibility: メールアドレス未登録はEMAIL_MISSINGを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED', email: '' });

  var result = ctx.sandbox.diagnoseReminderEligibility(bookingId, BASE_DATE);

  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reasonCode, 'EMAIL_MISSING');
});

test('diagnoseReminderEligibility: 来場案内の秘密値未設定はMAIL_NOT_READYを返す', function () {
  var properties = Object.assign({}, COMPLETE_ACCESS_GUIDE_PROPERTIES);
  delete properties.ACCESS_GUIDE_UNLOCK_CODE;
  var ctx = setup({ properties: properties });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED' });

  var result = ctx.sandbox.diagnoseReminderEligibility(bookingId, BASE_DATE);

  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reasonCode, 'MAIL_NOT_READY');
});

test('diagnoseReminderEligibility: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });

  var result = ctx.sandbox.diagnoseReminderEligibility('NOT-EXIST', BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

test('diagnoseReminderEligibility: 不正な基準日はINVALID_BASE_DATEを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.diagnoseReminderEligibility(bookingId, '2026/10/01');

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_BASE_DATE');
});

test('diagnoseReminderEligibility: Loggerにはbooking Id・reasonCodeのみを残し、メールアドレス等を残さない', function () {
  var logger = stubs.createLoggerStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, logger: logger });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', email: 'leak-check@example.com' });

  ctx.sandbox.diagnoseReminderEligibility(bookingId, BASE_DATE);

  var lines = logger._logs.filter(function (line) { return line.indexOf(bookingId) !== -1; });
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /ELIGIBLE/);
  logger._logs.forEach(function (line) {
    assert.strictEqual(line.indexOf('leak-check@example.com'), -1, 'Loggerに予約者のメールアドレスを残してはいけない');
  });
});

/* ---------- previewReminderMail ---------- */

test('previewReminderMail: 本番テンプレートで件名・本文を生成し、既定では解錠コード/キーボックス番号をマスクする', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', brand: 'mens' });

  var result = ctx.sandbox.previewReminderMail(bookingId, {});

  assert.strictEqual(result.success, true);
  assert.match(result.subject, /明日のご利用案内/);
  assert.match(result.subject, /SNB mens/);
  assert.strictEqual(result.body.indexOf('TEST-KEYBOX'), -1, '既定ではキーボックス番号をマスクする');
  assert.strictEqual(result.body.indexOf('TEST-CODE'), -1, '既定では解錠コードをマスクする');
  assert.strictEqual(result.recipientEmail, 'taro@example.com');
  assert.strictEqual(result.testRecipientEmail, 'admin@example.com');
  assert.strictEqual(result.revealed, false);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.reminderSentAt, '', 'プレビューはSentAtを更新しない');
});

test('previewReminderMail: reveal:trueの場合は本番相当の解錠コード/キーボックス番号を表示する', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.previewReminderMail(bookingId, { reveal: true });

  assert.strictEqual(result.success, true);
  assert.match(result.body, /TEST-KEYBOX/);
  assert.match(result.body, /TEST-CODE/);
  assert.strictEqual(result.revealed, true);
});

test('previewReminderMail: baseDateStringを渡すとeligible/reasonCodeもあわせて返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED' });

  var result = ctx.sandbox.previewReminderMail(bookingId, { baseDateString: BASE_DATE });

  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.reasonCode, 'ELIGIBLE');
});

test('previewReminderMail: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });

  var result = ctx.sandbox.previewReminderMail('NOT-EXIST', {});

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

/* ---------- sendReminderTestMail ---------- */

test('sendReminderTestMail: ELIGIBLEな予約はADMIN_NOTIFICATION_EMAIL固定宛先へ[TEST]付きで送信し、booking行・Recoveryを一切変更しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', email: 'real-guest@example.com' });

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.sentTo, 'admin@example.com');
  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.strictEqual(mailApp._sentEmails[0].to, 'admin@example.com', '実予約者(real-guest@example.com)へは送らない');
  assert.match(mailApp._sentEmails[0].subject, /^\[TEST\] /);
  assert.match(mailApp._sentEmails[0].body, /TEST-KEYBOX/, 'テスト送信は本番相当の内容で生成する（マスクしない）');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.reminderSentAt, '', 'テスト送信でreminderSentAtを更新してはいけない');
  assert.strictEqual(found.record.accessGuideSentAt, '', 'テスト送信でaccessGuideSentAtを更新してはいけない');
  assert.strictEqual(found.record.lastMailErrorAt, '', 'テスト送信でlastMailErrorAtを更新してはいけない');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().length, 0, 'テスト送信でRecoveryへ記録してはいけない');
});

test('sendReminderTestMail: ADMIN_NOTIFICATION_EMAIL未設定の場合はfail-closedで送信しない', function () {
  var properties = Object.assign({}, COMPLETE_ACCESS_GUIDE_PROPERTIES);
  delete properties.ADMIN_NOTIFICATION_EMAIL;
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: properties, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'ADMIN_EMAIL_NOT_CONFIGURED');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendReminderTestMail: ADMIN_NOTIFICATION_EMAILの形式が不正な場合はfail-closedで送信しない', function () {
  var properties = Object.assign({}, COMPLETE_ACCESS_GUIDE_PROPERTIES, { ADMIN_NOTIFICATION_EMAIL: 'not-an-email' });
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: properties, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'ADMIN_EMAIL_NOT_CONFIGURED');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendReminderTestMail: 対象外（ALREADY_SENT等）の場合は送信せず理由コードを返す', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, {
    date: '2026-10-02',
    reminderSentAt: new Date('2026-09-30T18:00:00+09:00')
  });

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.reasonCode, 'ALREADY_SENT');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendReminderTestMail: 翌日以外の予約は対象外（NOT_NEXT_DAY）として送信しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-11-01' });

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.reasonCode, 'NOT_NEXT_DAY');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendReminderTestMail: MailApp送信が例外を投げてもRecovery/lastMailErrorへは記録せず、sanitizeしたメッセージのみ返す', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('mail server down for real-guest@example.com') });
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', email: 'real-guest@example.com' });

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'MAIL_SEND_FAILED');
  assert.strictEqual(result.error.message.indexOf('real-guest@example.com'), -1);
  assert.match(result.error.message, /\[REDACTED_EMAIL\]/);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.lastMailErrorAt, '');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().length, 0);
});

test('sendReminderTestMail: MailApp例外にキーボックス番号/解錠コードの実値が偶然含まれても、返却メッセージ・Loggerに残さない', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('send failed for keybox=TEST-KEYBOX code=TEST-CODE') });
  var logger = stubs.createLoggerStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp, logger: logger });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.message.indexOf('TEST-KEYBOX'), -1, '返却メッセージにキーボックス番号を残してはいけない');
  assert.strictEqual(result.error.message.indexOf('TEST-CODE'), -1, '返却メッセージに解錠コードを残してはいけない');
  assert.match(result.error.message, /\[REDACTED\]/);

  logger._logs.forEach(function (line) {
    assert.strictEqual(line.indexOf('TEST-KEYBOX'), -1, 'Loggerにキーボックス番号を残してはいけない: ' + line);
    assert.strictEqual(line.indexOf('TEST-CODE'), -1, 'Loggerに解錠コードを残してはいけない: ' + line);
  });
});

test('sendReminderTestMail: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });

  var result = ctx.sandbox.sendReminderTestMail('NOT-EXIST', BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

/* ---------- 本番との共通化の確認 ---------- */

test('BookingMailer.evaluateReminderEligibility: 本番sendNextDayRemindersと同じ翌日候補（date一致・CONFIRMED・未送信）に対してELIGIBLEを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED' });
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);

  var evaluation = ctx.sandbox.BookingMailer.evaluateReminderEligibility(found.record, '2026-10-02');

  assert.strictEqual(evaluation.eligible, true);
  assert.strictEqual(evaluation.reasonCode, 'ELIGIBLE');
});

test('BookingMailer.evaluateReminderEligibility: targetDateStringを省略するとNOT_NEXT_DAY判定をスキップする（既存の管理者個別再送との互換のため）', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2020-01-01', status: 'CONFIRMED' });
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);

  var evaluation = ctx.sandbox.BookingMailer.evaluateReminderEligibility(found.record, null);

  assert.strictEqual(evaluation.reasonCode, 'ELIGIBLE', 'targetDateStringなしではdateを問わない');
});
