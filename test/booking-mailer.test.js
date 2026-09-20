/*
 * BookingMailer.gs のテスト（Issue #271）。SpreadsheetApp/LockService/MailAppはすべてスタブ。
 * BookingRepository（createBooking/confirmBooking）からの呼び出し配線は
 * test/booking-create-booking.test.js・test/booking-confirm-expire.test.jsで検証する。
 * ここではBookingMailer単体の送信制御（SentAt確認・status再確認・二重送信防止・
 * fail-closed設定確認・手動再送force）に絞って検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'Availability.gs', 'Booking.gs', 'SpreadsheetRepository.gs', 'RecoveryRepository.gs', 'BookingMailTemplates.gs', 'BookingMailer.gs'];

var SPREADSHEET_ID = 'ss1';

var COMPLETE_MAIL_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

var COMPLETE_ACCESS_GUIDE_PROPERTIES = Object.assign({}, COMPLETE_MAIL_PROPERTIES, {
  ACCESS_GUIDE_ADDRESS: '愛知県名古屋市...',
  ACCESS_GUIDE_BUILDING: 'テストビル',
  ACCESS_GUIDE_ROOM: '101',
  ACCESS_GUIDE_ENTRANCE: '正面入口から左手',
  ACCESS_GUIDE_KEYBOX_LOCATION: '玄関脇',
  ACCESS_GUIDE_KEYBOX_NUMBER: 'TEST-KEYBOX',
  ACCESS_GUIDE_UNLOCK_CODE: 'TEST-CODE',
  ACCESS_GUIDE_URL: 'https://example.com/how-to',
  ACCESS_GUIDE_PDF_URL: 'https://example.com/guide.pdf'
});

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign({ SPREADSHEET_ID: SPREADSHEET_ID }, opts.properties || {});

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox };
}

/* 全HEADERS_項目を埋めた予約レコードをSheetsへ直接投入する（createBooking自体はここでは
   検証対象外のため、Mailer単体テストではSpreadsheetRepository.appendBookingで直接種を撒く）。 */
function seedBooking(ctx, overrides) {
  var record = Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      createdAt: new Date('2026-09-30T10:00:00+09:00'),
      date: '2026-10-01',
      startAt: new Date('2026-10-01T10:00:00+09:00'),
      endAt: new Date('2026-10-01T12:00:00+09:00'),
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

/* ---------- PENDING ---------- */

test('sendPendingMailForBooking: PENDING予約に1通送り、pendingMailSentAtを記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.strictEqual(mailApp._sentEmails[0].to, 'taro@example.com');
  assert.match(mailApp._sentEmails[0].subject, /未確定/);
  assert.strictEqual(mailApp._sentEmails[0].body.indexOf('TEST-KEYBOX'), -1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.pendingMailSentAt));
});

test('sendPendingMailForBooking: 再実行では送らない（pendingMailSentAtがあればskip）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  var second = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);

  assert.strictEqual(second.success, true);
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(mailApp._sentEmails.length, 1, '2回目は送信されない');
});

test('sendPendingMailForBooking: PENDING以外の予約には送らない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_STATUS');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendPendingMailForBooking: MailApp送信失敗時はbooking statusを変えず、lastMailError*とRecoveryへ記録する', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('mail quota exceeded') });
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'MAIL_SEND_FAILED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING', 'メール送信失敗でも予約状態は維持される');
  assert.strictEqual(found.record.pendingMailSentAt, '', '失敗時はSentAtを記録しない');
  assert.ok(stubs.isDateLike(found.record.lastMailErrorAt));
  assert.strictEqual(found.record.lastMailErrorType, 'PENDING');
  assert.match(found.record.lastMailErrorMessage, /mail quota exceeded/);

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'MAIL_PENDING_FAILED');
  assert.strictEqual(recovered[0].bookingId, bookingId);
});

test('sendPendingMailForBooking: display name / reply-to / 問い合わせ先の設定が不足している場合はfail-closedに失敗扱いにする', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: {}, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(mailApp._sentEmails.length, 0, '設定不足時はメールを送らない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
  assert.ok(stubs.isDateLike(found.record.lastMailErrorAt));
});

/* ---------- CONFIRMED ---------- */

test('sendConfirmedMailForBooking: CONFIRMED予約に1通送り、confirmedMailSentAtを記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendConfirmedMailForBooking(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.match(mailApp._sentEmails[0].subject, /確定/);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.confirmedMailSentAt));
});

test('sendConfirmedMailForBooking: 二重実行しても再送しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  ctx.sandbox.BookingMailer.sendConfirmedMailForBooking(bookingId);
  var second = ctx.sandbox.BookingMailer.sendConfirmedMailForBooking(bookingId);

  assert.strictEqual(second.skipped, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
});

test('sendConfirmedMailForBooking: MailApp失敗でもCONFIRMED状態は維持される', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('mail server down') });
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendConfirmedMailForBooking(bookingId);
  assert.strictEqual(result.success, false);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CONFIRMED');
});

/* ---------- CANCELLED ---------- */

test('sendCancelledMailForBooking: CANCELLED予約にのみ送信でき、cancelMailSentAtを記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CANCELLED' });

  var result = ctx.sandbox.BookingMailer.sendCancelledMailForBooking(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.cancelMailSentAt));
});

test('sendCancelledMailForBooking: 二重送信しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CANCELLED' });

  ctx.sandbox.BookingMailer.sendCancelledMailForBooking(bookingId);
  var second = ctx.sandbox.BookingMailer.sendCancelledMailForBooking(bookingId);
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
});

test('sendCancelledMailForBooking: PENDING/CONFIRMED/EXPIREDには送らない', function () {
  ['PENDING', 'CONFIRMED', 'EXPIRED'].forEach(function (status) {
    var mailApp = stubs.createMailAppStub();
    var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
    var bookingId = seedBooking(ctx, { status: status, bookingId: 'SX-' + status });

    var result = ctx.sandbox.BookingMailer.sendCancelledMailForBooking(bookingId);
    assert.strictEqual(result.success, false, status);
    assert.strictEqual(result.error.code, 'INVALID_STATUS', status);
    assert.strictEqual(mailApp._sentEmails.length, 0, status);
  });
});

test('#271ではキャンセルへの状態遷移自体（cancelBooking相当）は実装しない', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  assert.strictEqual(ctx.sandbox.BookingRepository, undefined, 'このテストファイルではBookingRepository.gsを読み込んでいない（Mailer単体テストのため）');
  assert.strictEqual(typeof ctx.sandbox.cancelBooking, 'undefined');
});

/* ---------- REMINDER ---------- */

test('sendReminderMailForBooking: CONFIRMED予約に1通送り、reminderSentAtとaccessGuideSentAtを同時に記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.match(mailApp._sentEmails[0].body, /TEST-KEYBOX/);
  assert.match(mailApp._sentEmails[0].body, /TEST-CODE/);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.reminderSentAt));
  assert.ok(stubs.isDateLike(found.record.accessGuideSentAt));
  assert.strictEqual(found.record.reminderSentAt.getTime(), found.record.accessGuideSentAt.getTime());
});

test('sendReminderMailForBooking: reminderSentAt/accessGuideSentAtのいずれかがあれば再送しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED', reminderSentAt: new Date('2026-09-30T18:00:00+09:00') });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendReminderMailForBooking: CONFIRMED以外（PENDING/CANCELLED/EXPIRED）には送らない', function () {
  ['PENDING', 'CANCELLED', 'EXPIRED'].forEach(function (status) {
    var mailApp = stubs.createMailAppStub();
    var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
    var bookingId = seedBooking(ctx, { status: status, bookingId: 'SX-' + status });

    var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);
    assert.strictEqual(result.success, false, status);
    assert.strictEqual(mailApp._sentEmails.length, 0, status);
  });
});

test('sendReminderMailForBooking: 解錠コード/キーボックス番号が未設定の場合は送信せず、成功扱いにしない。CONFIRMED状態は維持し、lastMailErrorへ記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var propertiesWithoutSecrets = Object.assign({}, COMPLETE_MAIL_PROPERTIES, {
    ACCESS_GUIDE_ADDRESS: '住所のみ設定'
  });
  var ctx = setup({ properties: propertiesWithoutSecrets, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(mailApp._sentEmails.length, 0, '秘密値不足時はメールを送らない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'CONFIRMED');
  assert.strictEqual(found.record.reminderSentAt, '');
  assert.strictEqual(found.record.accessGuideSentAt, '');
  assert.ok(stubs.isDateLike(found.record.lastMailErrorAt));
  assert.strictEqual(found.record.lastMailErrorType, 'REMINDER');
});

/* ---------- 再送（force） ---------- */

test('force resend: SentAtが既にあってもforce:trueなら再送でき、SentAtは新しい時刻へ更新される', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var first = ctx.sandbox.BookingMailer.sendConfirmedMailForBooking(bookingId);
  assert.strictEqual(first.success, true);
  var firstSentAt = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.confirmedMailSentAt;

  var forced = ctx.sandbox.BookingMailer.sendConfirmedMailForBooking(bookingId, { force: true });
  assert.strictEqual(forced.success, true);
  assert.strictEqual(forced.skipped, undefined, 'forceの場合はskipされない');
  assert.strictEqual(mailApp._sentEmails.length, 2, 'forceなら2回目も送信される');

  var secondSentAt = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record.confirmedMailSentAt;
  assert.ok(secondSentAt.getTime() >= firstSentAt.getTime());
});

test('force resend: SentAtを事前に消す方式ではなく、force:trueのみで再送する（自動呼び出しでは送らない前提の再確認）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.pendingMailSentAt), 'SentAtは消されずに残っている');

  var normalRetry = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(normalRetry.skipped, true, '自動呼び出し相当（forceなし）では再送しない');
});

test('force resend: forceでもstatus不一致なら送らない（状態条件は無視しない）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendConfirmedMailForBooking(bookingId, { force: true });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_STATUS');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

/* ---------- Lock ---------- */

test('LockService: 送信中はLockを取得し、成功・失敗いずれの場合も最終的に解放する', function () {
  var lockService = stubs.createLockServiceStub();
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp, lockService: lockService });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(lockService._isHeld(), false);
});

test('LockService: Lock取得に失敗した場合はLOCK_TIMEOUTを返し、メールを送らない', function () {
  var lockService = stubs.createLockServiceStub({ forceTryLockFail: true });
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp, lockService: lockService });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking('SX-NOT-EXIST');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});
