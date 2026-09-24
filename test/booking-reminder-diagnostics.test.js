/*
 * BookingReminderDiagnostics.gs（Issue #330: 前日リマインドの任意時刻デバッグ・
 * 管理者宛テスト送信）と、それが依存するBookingMailer.gsの共通判定
 * （evaluateReminderEligibility）のテスト。SpreadsheetApp/MailAppはすべてスタブ。
 *
 * 検証観点:
 * - diagnoseReminderEligibility: 対象判定の正常系（ELIGIBLE）・異常系
 *   （NOT_NEXT_DAY/INVALID_STATUS/ALREADY_SENT/EMAIL_MISSING/MAIL_NOT_READY）
 * - previewReminderMail: 本番テンプレートを使ったプレビュー・解錠コードの既定マスク・
 *   reveal:trueでの表示・基準日必須（PRレビュー対応）
 * - sendReminderTestMail: ADMIN_NOTIFICATION_EMAIL固定送信・fail-closed・[TEST]件名・
 *   実予約者へ届かないこと
 * - 診断経路（3関数いずれも）が禁止された本番データ更新関数
 *   （SpreadsheetRepository.updateBookingFields / RecoveryRepository.recordFailure）を
 *   一切呼ばず、booking行・Recoveryシートを変更しないこと（副作用ゼロの確認）
 * - 想定外の例外（findRowByBookingId/getAccessGuideConfig/evaluateReminderEligibility/
 *   MailApp.sendEmailが秘密値を含む例外を投げる場合を含む）がUI・レスポンス・Loggerに
 *   漏れず、固定の安全な文言のみを返すこと（PRレビュー対応①②）
 * - BookingMailer.evaluateReminderEligibilityが、本番のsendReminderMailForBooking
 *   （withBookingLock_経由）と診断の両方から実際に呼ばれ、同じ判定結果になること
 *   （PRレビュー対応①。以前は診断からのみ呼ばれていた）
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
    LockService: opts.lockService || stubs.createLockServiceStub(),
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

function assertRecordAndRecoveryUnchanged_(ctx, bookingId) {
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.reminderSentAt, '', 'reminderSentAtが更新されている');
  assert.strictEqual(found.record.accessGuideSentAt, '', 'accessGuideSentAtが更新されている');
  assert.strictEqual(found.record.lastMailErrorAt, '', 'lastMailErrorAtが更新されている');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().length, 0, 'Recoveryへ記録されている');
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

  assertRecordAndRecoveryUnchanged_(ctx, bookingId);
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

/* ---------- 基準日の検証（PRレビュー対応③） ---------- */

['diagnoseReminderEligibility', 'sendReminderTestMail'].forEach(function (fnName) {
  test(fnName + ': 基準日が未入力（空文字）の場合はINVALID_BASE_DATEを返す', function () {
    var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
    var bookingId = seedBooking(ctx, { date: '2026-10-02' });

    var result = ctx.sandbox[fnName](bookingId, '');

    assert.strictEqual(result.success, false, fnName);
    assert.strictEqual(result.error.code, 'INVALID_BASE_DATE', fnName);
  });

  test(fnName + ': 基準日の形式が不正（2026/10/01）な場合はINVALID_BASE_DATEを返す', function () {
    var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
    var bookingId = seedBooking(ctx, { date: '2026-10-02' });

    var result = ctx.sandbox[fnName](bookingId, '2026/10/01');

    assert.strictEqual(result.success, false, fnName);
    assert.strictEqual(result.error.code, 'INVALID_BASE_DATE', fnName);
  });

  test(fnName + ': 実在しない日付（2026-02-30）の場合はINVALID_BASE_DATEを返す', function () {
    var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
    var bookingId = seedBooking(ctx, { date: '2026-10-02' });

    var result = ctx.sandbox[fnName](bookingId, '2026-02-30');

    assert.strictEqual(result.success, false, fnName);
    assert.strictEqual(result.error.code, 'INVALID_BASE_DATE', fnName);
  });

  test(fnName + ': 有効な基準日であれば通常どおり判定へ進む', function () {
    var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
    var bookingId = seedBooking(ctx, { date: '2026-10-02' });

    var result = ctx.sandbox[fnName](bookingId, BASE_DATE);

    assert.notStrictEqual(result.error && result.error.code, 'INVALID_BASE_DATE', fnName);
  });
});

test('previewReminderMail: 基準日が未入力の場合はプレビューを生成せずINVALID_BASE_DATEを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.previewReminderMail(bookingId, {});

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_BASE_DATE');
  assert.strictEqual(result.subject, undefined, '不正な基準日のときはプレビュー自体を生成しない');
});

test('previewReminderMail: 実在しない日付（2026-02-30）の場合はプレビューを生成せずINVALID_BASE_DATEを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.previewReminderMail(bookingId, { baseDateString: '2026-02-30' });

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

/* ---------- 想定外の例外の境界（PRレビュー対応②） ---------- */

test('diagnoseReminderEligibility: findRowByBookingIdが秘密値を含む例外を投げても、固定の安全な文言のみを返しLogger/レスポンスに秘密値を残さない', function () {
  var logger = stubs.createLoggerStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, logger: logger });
  ctx.sandbox.SpreadsheetRepository.findRowByBookingId = function () {
    throw new Error('unexpected failure leaking keybox=TEST-KEYBOX code=TEST-CODE user@example.com');
  };

  var result = ctx.sandbox.diagnoseReminderEligibility('SX-ANY', BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(result.error.message.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(result.error.message.indexOf('TEST-CODE'), -1);
  assert.strictEqual(result.error.message.indexOf('user@example.com'), -1);
  logger._logs.forEach(function (line) {
    assert.strictEqual(line.indexOf('TEST-KEYBOX'), -1, 'Loggerに秘密値を残してはいけない: ' + line);
    assert.strictEqual(line.indexOf('unexpected failure'), -1, 'Loggerに生の例外メッセージを残してはいけない: ' + line);
  });
});

test('previewReminderMail: BookingConfig.getAccessGuideConfigが秘密値を含む例外を投げても、固定の安全な文言のみを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });
  ctx.sandbox.BookingConfig.getAccessGuideConfig = function () {
    throw new Error('config load failed keybox=TEST-KEYBOX code=TEST-CODE');
  };

  var result = ctx.sandbox.previewReminderMail(bookingId, { baseDateString: BASE_DATE });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(result.error.message.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(result.error.message.indexOf('TEST-CODE'), -1);

  assertRecordAndRecoveryUnchanged_(ctx, bookingId);
});

test('sendReminderTestMail: BookingMailer.evaluateReminderEligibilityが秘密値を含む例外を投げても、固定の安全な文言のみを返し送信しない', function () {
  var mailApp = stubs.createMailAppStub();
  var logger = stubs.createLoggerStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp, logger: logger });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });
  ctx.sandbox.BookingMailer.evaluateReminderEligibility = function () {
    throw new Error('eligibility check failed keybox=TEST-KEYBOX code=TEST-CODE');
  };

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(result.error.message.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(mailApp._sentEmails.length, 0, '想定外の例外時は送信しない');
  logger._logs.forEach(function (line) {
    assert.strictEqual(line.indexOf('TEST-KEYBOX'), -1, 'Loggerに秘密値を残してはいけない: ' + line);
  });

  assertRecordAndRecoveryUnchanged_(ctx, bookingId);
});

test('sendReminderTestMail: MailApp.sendEmailが秘密値を含む例外を投げても（想定内の失敗経路）、既存どおりsanitize済みのメッセージのみ返しRecovery/lastMailErrorへは記録しない', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('smtp failure keybox=TEST-KEYBOX code=TEST-CODE') });
  var logger = stubs.createLoggerStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp, logger: logger });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.sendReminderTestMail(bookingId, BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'MAIL_SEND_FAILED');
  assert.strictEqual(result.error.message.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(result.error.message.indexOf('TEST-CODE'), -1);

  assertRecordAndRecoveryUnchanged_(ctx, bookingId);
});

/* ---------- previewReminderMail ---------- */

test('previewReminderMail: 本番テンプレートで件名・本文を生成し、既定では解錠コード/キーボックス番号をマスクする', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', brand: 'mens' });

  var result = ctx.sandbox.previewReminderMail(bookingId, { baseDateString: BASE_DATE });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.targetDate, '2026-10-02');
  assert.match(result.subject, /明日のご利用案内/);
  assert.match(result.subject, /SNB mens/);
  assert.strictEqual(result.body.indexOf('TEST-KEYBOX'), -1, '既定ではキーボックス番号をマスクする');
  assert.strictEqual(result.body.indexOf('TEST-CODE'), -1, '既定では解錠コードをマスクする');
  assert.strictEqual(result.recipientEmail, 'taro@example.com');
  assert.strictEqual(result.testRecipientEmail, 'admin@example.com');
  assert.strictEqual(result.revealed, false);
  assert.strictEqual(result.eligible, true, '対象日と一致するCONFIRMED予約は送信対象と分かるべき');
  assert.strictEqual(result.reasonCode, 'ELIGIBLE');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.reminderSentAt, '', 'プレビューはSentAtを更新しない');
});

test('previewReminderMail: reveal:trueの場合は本番相当の解錠コード/キーボックス番号を表示する', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02' });

  var result = ctx.sandbox.previewReminderMail(bookingId, { baseDateString: BASE_DATE, reveal: true });

  assert.strictEqual(result.success, true);
  assert.match(result.body, /TEST-KEYBOX/);
  assert.match(result.body, /TEST-CODE/);
  assert.strictEqual(result.revealed, true);
});

test('previewReminderMail: 対象外（翌日ではない）予約でもプレビュー自体は成功し、eligible:falseで区別できる', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-12-25' });

  var result = ctx.sandbox.previewReminderMail(bookingId, { baseDateString: BASE_DATE });

  assert.strictEqual(result.success, true, 'プレビューの生成自体は成功する');
  assert.strictEqual(result.eligible, false, 'しかし送信対象ではないと分かる');
  assert.strictEqual(result.reasonCode, 'NOT_NEXT_DAY');
  assert.ok(result.subject && result.body, '対象外でも件名・本文は返す');
});

test('previewReminderMail: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });

  var result = ctx.sandbox.previewReminderMail('NOT-EXIST', { baseDateString: BASE_DATE });

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

  assertRecordAndRecoveryUnchanged_(ctx, bookingId);
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

  assertRecordAndRecoveryUnchanged_(ctx, bookingId);
});

test('sendReminderTestMail: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });

  var result = ctx.sandbox.sendReminderTestMail('NOT-EXIST', BASE_DATE);

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

/* ---------- BookingMailer.evaluateReminderEligibility 単体（PRレビュー対応①④） ---------- */

test('BookingMailer.evaluateReminderEligibility: 翌日候補（date一致・CONFIRMED・未送信）に対してELIGIBLEを返す', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED' });
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);

  var evaluation = ctx.sandbox.BookingMailer.evaluateReminderEligibility(found.record, { targetDateString: '2026-10-02' });

  assert.strictEqual(evaluation.eligible, true);
  assert.strictEqual(evaluation.reasonCode, 'ELIGIBLE');
});

test('BookingMailer.evaluateReminderEligibility: targetDateStringを省略するとNOT_NEXT_DAY判定をスキップする（既存の管理者個別再送との互換のため）', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2020-01-01', status: 'CONFIRMED' });
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);

  var evaluation = ctx.sandbox.BookingMailer.evaluateReminderEligibility(found.record, {});

  assert.strictEqual(evaluation.reasonCode, 'ELIGIBLE', 'targetDateStringなしではdateを問わない');
});

test('BookingMailer.evaluateReminderEligibility: record.dateがDate型で保存されていても、timezone基準で正規化して比較する（実RepositoryでSheetsの自動型変換を再現）', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: new Date('2026-10-02T00:00:00+09:00'), status: 'CONFIRMED' });
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.notStrictEqual(typeof found.record.date, 'string', '前提: record.dateがDate値であること');

  var evaluation = ctx.sandbox.BookingMailer.evaluateReminderEligibility(found.record, { targetDateString: '2026-10-02' });

  assert.strictEqual(evaluation.eligible, true, 'record.dateがDate値でも文字列と正しく比較できるべき');
  assert.strictEqual(evaluation.reasonCode, 'ELIGIBLE');
});

/* ---------- 本番送信（sendReminderMailForBooking）が共通判定関数を実際に使うことの確認（PRレビュー対応①） ---------- */

test('本番sendReminderMailForBooking: targetDateStringを渡すとNOT_NEXT_DAYで対象外スキップになり、送信・失敗記録のいずれもしない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-12-25', status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId, { targetDateString: '2026-10-02' });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.error.code, 'NOT_NEXT_DAY');
  assert.strictEqual(mailApp._sentEmails.length, 0);
  assertRecordAndRecoveryUnchanged_(ctx, bookingId);
});

test('本番sendReminderMailForBooking: メールアドレス未登録（EMAIL_MISSING）の場合は送信せず、既存のMAIL_NOT_READY等と同じくlastMailError*・Recoveryへ記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED', email: '' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId, { targetDateString: '2026-10-02' });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'EMAIL_MISSING');
  assert.strictEqual(mailApp._sentEmails.length, 0);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CONFIRMED', 'EMAIL_MISSINGでも予約状態は維持する');
  assert.ok(stubs.isDateLike(found.record.lastMailErrorAt), '既存のMAIL_NOT_READY等と同じくlastMailErrorAtを記録する');
  assert.strictEqual(found.record.lastMailErrorType, 'REMINDER');

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'MAIL_REMINDER_FAILED');
  assert.strictEqual(recovered[0].status, 'CONFIRMED');
});

test('本番sendReminderMailForBooking: 通常呼び出し（targetDateStringなし）でCONFIRMED・未送信・メール設定完備なら送信しSentAtを更新する（既存挙動）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);

  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.reminderSentAt));
  assert.ok(stubs.isDateLike(found.record.accessGuideSentAt));
});

test('本番sendReminderMailForBooking: force:trueなら日付を問わずSentAt済みでも再送でき、targetDateStringを渡さない管理者個別再送の既存挙動を維持する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  /* 「特定の日付を対象にしない」既存挙動の確認のため、意図的に翌日ではない日付・
     送信済みのブッキングでforce再送する。 */
  var bookingId = seedBooking(ctx, {
    date: '2099-01-01',
    status: 'CONFIRMED',
    reminderSentAt: new Date('2026-09-30T18:00:00+09:00'),
    accessGuideSentAt: new Date('2026-09-30T18:00:00+09:00')
  });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId, { force: true });

  assert.strictEqual(result.success, true, 'force:trueならALREADY_SENTを無視して送信できる');
  assert.strictEqual(result.skipped, undefined);
  assert.strictEqual(mailApp._sentEmails.length, 1);
});

test('本番sendReminderMailForBooking: forceでもstatus不一致（INVALID_STATUS）なら送らない（既存挙動を維持）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId, { force: true });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_STATUS');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('本番sendReminderMailForBooking: 秘密値未設定（MAIL_NOT_READY）の場合、事前判定を経由しても既存どおりlastMailError*・Recoveryへ記録し失敗を返す', function () {
  var mailApp = stubs.createMailAppStub();
  var properties = Object.assign({}, COMPLETE_ACCESS_GUIDE_PROPERTIES);
  delete properties.ACCESS_GUIDE_UNLOCK_CODE;
  var ctx = setup({ properties: properties, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId, { targetDateString: '2026-10-02' });

  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'MAIL_NOT_READY');
  assert.strictEqual(mailApp._sentEmails.length, 0);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CONFIRMED');
  assert.ok(stubs.isDateLike(found.record.lastMailErrorAt));
  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'MAIL_REMINDER_FAILED');
});

test('診断（diagnoseReminderEligibility）と本番（sendReminderMailForBooking）が同一レコード・同一対象日に対して同じ理由コードへたどり着く', function () {
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES });
  var bookingId = seedBooking(ctx, { date: '2026-10-02', status: 'PENDING' });

  var diagnosis = ctx.sandbox.diagnoseReminderEligibility(bookingId, BASE_DATE);
  var productionResult = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId, { targetDateString: '2026-10-02' });

  assert.strictEqual(diagnosis.reasonCode, 'INVALID_STATUS');
  assert.strictEqual(productionResult.error.code, 'INVALID_STATUS');
});
