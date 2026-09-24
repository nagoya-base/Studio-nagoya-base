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
  ACCESS_GUIDE_ENTRY_METHOD: '玄関の暗証番号を入力して解錠',
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
  /* PRレビュー対応: JST 10:00開始/12:00終了の予約が、実行環境のローカルtimezoneに
     依存せず本文でも10:00/12:00のまま表示されること（config.timezoneが渡っていないと
     Intl.DateTimeFormatが環境既定timezoneへフォールバックし、ここが例えば01:00等の
     UTC時刻表示に化けてしまう）。 */
  assert.match(mailApp._sentEmails[0].body, /開始時刻: 10:00/);
  assert.match(mailApp._sentEmails[0].body, /終了時刻: 12:00/);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.pendingMailSentAt));
});

test('sendPendingMailForBooking: カード決済は、Booking.computeCardPaymentDueMillisで計算した実際の支払期限日時が本文に入る（Issue #334 PR-B。フォーム側の目安表示ではなくサーバー側の値）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, true);
  var body = mailApp._sentEmails[0].body;
  assert.match(body, /【クレジットカード決済のご案内】/);
  /* createdAt=2026-09-30T10:00+09:00・startAt=2026-10-01T10:00+09:00・
     PENDING_TTL_MIN_HOURS_BEFORE_START未設定（既定2時間）のとき、
     Booking.computeTtlExpiryMillisはmin(createdAt+72h, startAt-2h)=2026-10-01 08:00となる
     （gas/booking/shared/Booking.gsのcomputeCardPaymentDueMillisと同じ計算。ここを
     複製せず実際にBookingMailer経由で正しく呼ばれていることを確認する）。 */
  assert.match(body, /お支払い期限：お申し込みから72時間後（2026-10-01（木） 08:00）/);
});

test('sendPendingMailForBooking: 現金・PayPay・未定にはカード専用の注意書きが混入しない（既存の仮受付メールとの回帰確認）', function () {
  ['現金', 'PayPay', '未定'].forEach(function (paymentMethod) {
    var mailApp = stubs.createMailAppStub();
    var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
    var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: paymentMethod });

    var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
    assert.strictEqual(result.success, true);
    var body = mailApp._sentEmails[0].body;
    assert.strictEqual(body.indexOf('クレジットカード決済のご案内'), -1, paymentMethod + 'にカード案内が混入しないこと');
  });
});

test('sendPendingMailForBooking: TIMEZONEをUTC等へ変更しても、その設定に従って本文の時刻表示が変わる（config.timezoneが実際にBookingMailTemplatesへ渡っていることの確認）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: Object.assign({}, COMPLETE_MAIL_PROPERTIES, { TIMEZONE: 'UTC' }), mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, true);
  /* startAt=2026-10-01T10:00:00+09:00はUTCでは01:00になる */
  assert.match(mailApp._sentEmails[0].body, /開始時刻: 01:00/);
});

test('sendPendingMailForBooking: TIMEZONEが不正な文字列の場合はfail-closedにMAIL_NOT_READYとしてメールを送らず、lastMailError*へ記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: Object.assign({}, COMPLETE_MAIL_PROPERTIES, { TIMEZONE: 'Not/AValidZone' }), mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'MAIL_NOT_READY');
  assert.strictEqual(mailApp._sentEmails.length, 0, '不正timezoneのときはMailAppを呼ばない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
  assert.ok(stubs.isDateLike(found.record.lastMailErrorAt));
  assert.strictEqual(found.record.lastMailErrorType, 'PENDING');
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
  assert.strictEqual(recovered[0].status, 'PENDING', 'Recoveryのstatusはメール種別ではなく予約状態を記録する');
});

test('sendReminderMailForBooking失敗時: RecoveryのstatusはmailType(REMINDER)ではなく予約status(CONFIRMED)を記録する（PRレビュー対応）', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('mail server down') });
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);
  assert.strictEqual(result.success, false);

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].failureType, 'MAIL_REMINDER_FAILED');
  assert.strictEqual(recovered[0].status, 'CONFIRMED', 'Recoveryのstatusに"REMINDER"というメール種別を入れてはいけない');
});

/* ---------- セキュリティ（PRレビュー2回目対応）: エラーメッセージのredaction ---------- */

test('sendPendingMailForBooking: MailApp例外にメールアドレスが含まれる場合、lastMailErrorMessage/Recovery.errorMessageともに生のメールアドレスを残さず[REDACTED_EMAIL]へ置換する', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('Invalid recipient: user@example.com') });
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', email: 'user@example.com' });

  var result = ctx.sandbox.BookingMailer.sendPendingMailForBooking(bookingId);
  assert.strictEqual(result.success, false);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.lastMailErrorMessage.indexOf('user@example.com'), -1, 'lastMailErrorMessageに生のメールアドレスを残してはいけない');
  assert.match(found.record.lastMailErrorMessage, /\[REDACTED_EMAIL\]/);

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].errorMessage.indexOf('user@example.com'), -1, 'Recovery.errorMessageに生のメールアドレスを残してはいけない');
  assert.match(recovered[0].errorMessage, /\[REDACTED_EMAIL\]/);
});

test('sendReminderMailForBooking: MailApp例外に解錠コード/キーボックス番号の実値が偶然含まれても、lastMailErrorMessage/Recovery.errorMessageに残さず[REDACTED]へ置換する', function () {
  var mailApp = stubs.createMailAppStub({
    throwError: new Error('send failed for keybox=TEST-KEYBOX code=TEST-CODE')
  });
  var ctx = setup({ properties: COMPLETE_ACCESS_GUIDE_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);
  assert.strictEqual(result.success, false);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.lastMailErrorMessage.indexOf('TEST-KEYBOX'), -1, 'lastMailErrorMessageにキーボックス番号を残してはいけない');
  assert.strictEqual(found.record.lastMailErrorMessage.indexOf('TEST-CODE'), -1, 'lastMailErrorMessageに解錠コードを残してはいけない');
  assert.match(found.record.lastMailErrorMessage, /\[REDACTED\]/);

  var recovered = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovered.length, 1);
  assert.strictEqual(recovered[0].errorMessage.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(recovered[0].errorMessage.indexOf('TEST-CODE'), -1);
});

test('BookingMailer.sanitizeErrorMessage: 他ファイル（BookingRepository.gs等）が再利用できるよう公開されており、メールアドレスをredactする', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var sanitized = ctx.sandbox.BookingMailer.sanitizeErrorMessage('failed to notify admin@example.com');
  assert.strictEqual(sanitized.indexOf('admin@example.com'), -1);
  assert.match(sanitized, /\[REDACTED_EMAIL\]/);
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
  /* PRレビュー対応（Blocker 3）: 確定メールに「利用上の基本注意」に相当する文言が
     含まれること。 */
  assert.match(mailApp._sentEmails[0].body, /原状回復/);

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

/* ---------- EXPIRED（Issue #334: カード決済PENDING失効通知） ---------- */

test('sendExpiredMailForBooking: EXPIRED予約にのみ送信でき、expiredMailSentAtを記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'EXPIRED', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.match(mailApp._sentEmails[0].subject, /期限切れ/);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.expiredMailSentAt));
});

test('sendExpiredMailForBooking: 二重送信しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'EXPIRED', paymentMethod: 'オンラインクレジットカード' });

  ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId);
  var second = ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId);
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(second.reason, 'ALREADY_SENT');
  assert.strictEqual(mailApp._sentEmails.length, 1);
});

test('sendExpiredMailForBooking: PENDING/CONFIRMED/CANCELLEDには送らない', function () {
  ['PENDING', 'CONFIRMED', 'CANCELLED'].forEach(function (status) {
    var mailApp = stubs.createMailAppStub();
    var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
    var bookingId = seedBooking(ctx, { status: status, bookingId: 'SX-' + status, paymentMethod: 'オンラインクレジットカード' });

    var result = ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId);
    assert.strictEqual(result.success, false, status);
    assert.strictEqual(result.error.code, 'INVALID_STATUS', status);
    assert.strictEqual(mailApp._sentEmails.length, 0, status);
  });
});

test('sendExpiredMailForBooking: MailApp失敗でもEXPIRED状態は維持され、lastMailError*に記録される', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('simulated mail send failure') });
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'EXPIRED', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'MAIL_SEND_FAILED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'EXPIRED', 'メール送信失敗でEXPIRED状態を書き換えてはいけない');
  assert.ok(!found.record.expiredMailSentAt);
  assert.ok(found.record.lastMailErrorAt, 'lastMailError*へ記録されるべき');
});

test('sendExpiredMailForBooking: force:trueならexpiredMailSentAtが既にあっても再送できる', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'EXPIRED', paymentMethod: 'オンラインクレジットカード' });

  ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId);
  var forced = ctx.sandbox.BookingMailer.sendExpiredMailForBooking(bookingId, { force: true });
  assert.strictEqual(forced.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 2);
});

/* ---------- PAYMENT_LINK（Issue #334 PR-C: Booking AdminからのStripe決済リンク送信） ---------- */

var SAMPLE_PAYMENT_LINK_URL = 'https://buy.stripe.com/test_ABC123';

/* seedBookingの既定createdAt=2026-09-30T10:00+09:00・startAt=2026-10-01T10:00+09:00の場合、
   支払期限(computeCardPaymentDueMillis)は2026-10-01 08:00になる（buildPendingMailの
   カード案内テストと同じ計算）。期限判定を実行時刻に依存させないため、各テストでは
   期限前/期限後の`now`を明示的に指定する。 */
var PAYMENT_LINK_DUE_MILLIS = new Date('2026-10-01T08:00:00+09:00').getTime();
var BEFORE_DUE = { now: new Date(PAYMENT_LINK_DUE_MILLIS - 3600000) };
var AFTER_DUE = { now: new Date(PAYMENT_LINK_DUE_MILLIS + 1) };

test('sendPaymentLinkMailForBooking: カード決済PENDINGに送信でき、URL・送信日時・送信先・送信回数を記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.sendCount, 1);
  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.strictEqual(mailApp._sentEmails[0].to, 'taro@example.com');
  assert.match(mailApp._sentEmails[0].subject, /お支払い/);
  assert.match(mailApp._sentEmails[0].body, /buy\.stripe\.com\/test_ABC123/);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.stripePaymentLinkUrl, SAMPLE_PAYMENT_LINK_URL);
  assert.ok(stubs.isDateLike(found.record.paymentLinkSentAt));
  assert.strictEqual(found.record.paymentLinkSentTo, 'taro@example.com');
  assert.strictEqual(found.record.paymentLinkSendCount, 1);
  assert.strictEqual(found.record.status, 'PENDING', '送信のみでは予約statusを変更しない');
});

test('sendPaymentLinkMailForBooking: 現金・PayPay・未定にはNOT_CARD_PAYMENTで送信できない', function () {
  ['現金', 'PayPay', '未定'].forEach(function (paymentMethod) {
    var mailApp = stubs.createMailAppStub();
    var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
    var bookingId = seedBooking(ctx, { status: 'PENDING', bookingId: 'SX-' + paymentMethod, paymentMethod: paymentMethod });

    var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
    assert.strictEqual(result.success, false, paymentMethod);
    assert.strictEqual(result.error.code, 'NOT_CARD_PAYMENT', paymentMethod);
    assert.strictEqual(mailApp._sentEmails.length, 0, paymentMethod);
  });
});

test('sendPaymentLinkMailForBooking: CONFIRMED/CANCELLED/EXPIREDのカード予約にはINVALID_STATUSで送信できない', function () {
  ['CONFIRMED', 'CANCELLED', 'EXPIRED'].forEach(function (status) {
    var mailApp = stubs.createMailAppStub();
    var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
    var bookingId = seedBooking(ctx, { status: status, bookingId: 'SX-' + status, paymentMethod: 'オンラインクレジットカード' });

    var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
    assert.strictEqual(result.success, false, status);
    assert.strictEqual(result.error.code, 'INVALID_STATUS', status);
    assert.strictEqual(mailApp._sentEmails.length, 0, status);
  });
});

test('sendPaymentLinkMailForBooking: buy.stripe.com形式に一致しないURLはINVALID_PAYMENT_LINK_URLで拒否し、Sheets/MailAppに触れない', function () {
  var invalidUrls = [
    '',
    'http://buy.stripe.com/test_ABC123',
    'https://evil.example/buy.stripe.com/test_ABC123',
    'https://buy.stripe.com/test_ABC123?foo=bar',
    'https://buy.stripe.com/test_ABC123 '
  ];
  invalidUrls.forEach(function (url) {
    var mailApp = stubs.createMailAppStub();
    var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
    var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

    var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, url, BEFORE_DUE);
    assert.strictEqual(result.success, false, JSON.stringify(url));
    assert.strictEqual(result.error.code, 'INVALID_PAYMENT_LINK_URL', JSON.stringify(url));
    assert.strictEqual(mailApp._sentEmails.length, 0, JSON.stringify(url));

    var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
    assert.ok(!found.record.stripePaymentLinkUrl, JSON.stringify(url));
  });
});

test('sendPaymentLinkMailForBooking: 支払期限を過ぎている場合はPAYMENT_DUE_PASSEDで送信できない（期限未到来の再検証）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, AFTER_DUE);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_DUE_PASSED');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendPaymentLinkMailForBooking: 初回送信成功後の通常送信（forceなし）はALREADY_SENTでスキップし、二重送信しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  var second = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);

  assert.strictEqual(second.skipped, true);
  assert.strictEqual(second.reason, 'ALREADY_SENT');
  assert.strictEqual(mailApp._sentEmails.length, 1, '連打・同時操作でも二重送信しない');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentLinkSendCount, 1);
});

test('sendPaymentLinkMailForBooking: 明示的な再送（force:true）は送信でき、送信回数が増える', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  var resendOptions = Object.assign({ force: true }, BEFORE_DUE);
  var forced = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, resendOptions);

  assert.strictEqual(forced.success, true, JSON.stringify(forced));
  assert.strictEqual(forced.sendCount, 2);
  assert.strictEqual(mailApp._sentEmails.length, 2);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentLinkSendCount, 2);
});

test('sendPaymentLinkMailForBooking: forceでもstatus/支払方法/期限の不一致は無視しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED', paymentMethod: 'オンラインクレジットカード' });

  var forceOptions = Object.assign({ force: true }, BEFORE_DUE);
  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, forceOptions);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_STATUS');
});

test('sendPaymentLinkMailForBooking: MailApp失敗時はPENDING状態を維持し、専用のpaymentLinkLastError*（既存の他メール種別共有のlastMailError*とは別列）へ記録する', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('simulated mail send failure taro@example.com') });
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'MAIL_SEND_FAILED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING', 'メール送信失敗でstatusを書き換えてはいけない');
  assert.ok(!found.record.paymentLinkSentAt, '送信失敗時はpaymentLinkSentAtを記録しない');
  assert.ok(found.record.paymentLinkLastErrorAt, '専用のpaymentLinkLastErrorAtへ記録されるべき');
  assert.ok(found.record.paymentLinkLastErrorMessage.indexOf('[REDACTED_EMAIL]') !== -1, 'メールアドレスはredactされるべき');
  assert.ok(!found.record.lastMailErrorAt, '他メール種別と共有するlastMailErrorAtは変更しない（専用列に分離する）');

  var recoveries = ctx.sandbox.RecoveryRepository.listAll();
  var recovery = recoveries.filter(function (r) { return r.bookingId === bookingId; })[0];
  assert.ok(recovery, 'Recoveryへ記録されるべき');
  assert.strictEqual(recovery.failureType, 'PAYMENT_LINK_MAIL_FAILED');
  assert.strictEqual(recovery.status, 'PENDING');
});

test('sendPaymentLinkMailForBooking: 送信に成功すると直前のpaymentLinkLastError*をクリアする', function () {
  var callCount = 0;
  var sentEmails = [];
  var mailApp = {
    _sentEmails: sentEmails,
    sendEmail: function (message) {
      callCount += 1;
      if (callCount === 1) throw new Error('simulated failure');
      sentEmails.push(message);
    }
  };
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var firstAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(firstAttempt.success, false);
  var retry = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(retry.success, true, JSON.stringify(retry));
  assert.strictEqual(sentEmails.length, 1);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(!found.record.paymentLinkLastErrorAt);
  assert.ok(!found.record.paymentLinkLastErrorMessage);
});

test('sendPaymentLinkMailForBooking: 予約者のメールアドレスが未登録の場合はEMAIL_MISSINGで送信できない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード', email: '' });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'EMAIL_MISSING');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendPaymentLinkMailForBooking: LockService.getScriptLock()を取得し、既存メール送信と同じくLock取得失敗時はLOCK_TIMEOUTを返す', function () {
  var lockService = stubs.createLockServiceStub({ forceTryLockFail: true });
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, lockService: lockService });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
});

/*
 * PRレビュー対応①: 送信履行未確認（MailApp送信は成功したが、直後のpaymentLinkSentAtの
 * 記録が失敗した）状態の二重送信防止。SpreadsheetRepository.updateBookingFieldsを
 * paymentLinkSentAtのみの呼び出し時にだけ失敗させ、その他の呼び出しは元の実装へ委譲する
 * ラッパーで模擬する（BookingMailer.gsが「paymentLinkSentAtを単独で先に書き込む」設計に
 * なっているため、この1フィールド呼び出しだけを失敗させれば「メール送信成功→履行未確認」の
 * 部分失敗を再現できる）。
 */
function stubCriticalSentAtWriteFailure_(ctx) {
  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    var keys = Object.keys(fields);
    if (keys.length === 1 && keys[0] === 'paymentLinkSentAt') {
      throw new Error('simulated Sheets outage while recording paymentLinkSentAt');
    }
    return original(id, fields);
  };
  return function restore() {
    ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;
  };
}

test('sendPaymentLinkMailForBooking: MailApp送信成功後にpaymentLinkSentAtの記録が失敗した場合、success:false・mailSent:true・requiresManualConfirmation:trueを返し、Recoveryへ記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });
  var restore = stubCriticalSentAtWriteFailure_(ctx);

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restore();

  assert.strictEqual(result.success, false, JSON.stringify(result));
  assert.strictEqual(result.mailSent, true, 'メール自体は送信されているため、admin側に「送信された可能性がある」ことを伝える必要がある');
  assert.strictEqual(result.requiresManualConfirmation, true);
  assert.strictEqual(result.error.code, 'PAYMENT_LINK_HISTORY_UPDATE_FAILED');
  assert.strictEqual(mailApp._sentEmails.length, 1, 'メール自体は1通送信されているべき');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(!found.record.paymentLinkSentAt, '記録に失敗したためpaymentLinkSentAtは空のまま');
  assert.ok(found.record.paymentLinkSendUnconfirmedAt, 'paymentLinkSendUnconfirmedAtへ未確認の送信時刻が記録されるべき');

  var recoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) { return r.bookingId === bookingId; });
  assert.strictEqual(recoveries.length, 1);
  assert.strictEqual(recoveries[0].failureType, 'PAYMENT_LINK_SEND_HISTORY_UPDATE_FAILED');
  assert.strictEqual(recoveries[0].status, 'PENDING');
  assert.strictEqual(recoveries[0].recoveryState, 'OPEN');
});

test('sendPaymentLinkMailForBooking: 送信履行が未確認の予約は、通常送信（forceなし）では無条件に再送できない（二重送信防止）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });
  var restore = stubCriticalSentAtWriteFailure_(ctx);
  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restore();
  assert.strictEqual(mailApp._sentEmails.length, 1, '前提: 1回目でメールは送信済み');

  var retryNormal = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(retryNormal.skipped, true);
  assert.strictEqual(retryNormal.error.code, 'SEND_UNCONFIRMED');
  assert.strictEqual(mailApp._sentEmails.length, 1, '履行未確認の状態では通常送信で再送してはいけない');
});

test('sendPaymentLinkMailForBooking: 送信履行が未確認の予約でも、明示的な再送（force:true）なら送信でき、成功時にpaymentLinkSendUnconfirmedAtをクリアする', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });
  var restore = stubCriticalSentAtWriteFailure_(ctx);
  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restore();

  var forceOptions = Object.assign({ force: true }, BEFORE_DUE);
  var forced = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, forceOptions);
  assert.strictEqual(forced.success, true, JSON.stringify(forced));
  assert.strictEqual(mailApp._sentEmails.length, 2);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(found.record.paymentLinkSentAt, '再送成功後はpaymentLinkSentAtが記録される');
  assert.ok(!found.record.paymentLinkSendUnconfirmedAt, '再送成功後は未確認フラグがクリアされるべき');
});

/*
 * PRレビュー対応②: 同時再送の競合防止。管理画面が最後に取得したpaymentLinkSendCount
 * （expectedSendCount）と、Lock取得後の最新値が一致しない場合はSEND_HISTORY_CONFLICTで
 * 拒否する。通常送信・明示的な再送の両方について検証する。
 */
test('sendPaymentLinkMailForBooking: 通常送信でも、expectedSendCountが別タブの先行送信で古くなっている場合はSEND_HISTORY_CONFLICTで拒否し、二重送信しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  /* タブA: expectedSendCount:0（未送信の前提）で送信し、成功する。 */
  var tabA = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ expectedSendCount: 0 }, BEFORE_DUE)
  );
  assert.strictEqual(tabA.success, true, JSON.stringify(tabA));

  /* タブB: 画面を再取得しておらず、依然expectedSendCount:0のまま送信しようとする。 */
  var tabB = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ expectedSendCount: 0 }, BEFORE_DUE)
  );
  assert.strictEqual(tabB.success, false);
  assert.strictEqual(tabB.error.code, 'SEND_HISTORY_CONFLICT');
  assert.strictEqual(mailApp._sentEmails.length, 1, '競合したタブBからは送信されないべき');
});

test('sendPaymentLinkMailForBooking: 明示的な再送（force:true）でも、expectedSendCountが別タブの先行再送で古くなっている場合はSEND_HISTORY_CONFLICTで拒否する（forceは古い前提での送信までは許可しない）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  /* 前提: 1回目の送信（count 0→1）を両タブが把握している。 */
  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ expectedSendCount: 0 }, BEFORE_DUE)
  );

  /* タブA: expectedSendCount:1（両タブ共通の前提）で明示的な再送を行い、成功する（count 1→2）。 */
  var tabA = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ force: true, expectedSendCount: 1 }, BEFORE_DUE)
  );
  assert.strictEqual(tabA.success, true, JSON.stringify(tabA));
  assert.strictEqual(tabA.sendCount, 2);

  /* タブB: 画面を再取得しておらず、依然expectedSendCount:1のまま明示的な再送を行おうとする。 */
  var tabB = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ force: true, expectedSendCount: 1 }, BEFORE_DUE)
  );
  assert.strictEqual(tabB.success, false);
  assert.strictEqual(tabB.error.code, 'SEND_HISTORY_CONFLICT');
  assert.strictEqual(mailApp._sentEmails.length, 2, '競合したタブBからのforce再送では送信されないべき（forceは古い前提での送信までは許可しない）');
});

test('sendPaymentLinkMailForBooking: expectedSendCountを渡さない場合は競合チェック自体を行わない（既存挙動を維持。省略時は省略前と同じ結果になる）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(result.success, true, JSON.stringify(result));
});

/*
 * PRレビュー対応③: 支払期限の設定統一。buildPaymentLinkMailへBookingConfig.getTtlConfig()を
 * 渡し忘れていたため、決済リンクメール本文の支払期限が常に「（お問い合わせください）」に
 * なってしまう不具合があった（送信可否判定自体はevaluatePaymentLinkEligibility_が独自に
 * BookingConfig.getTtlConfig()を呼ぶため影響を受けず、この回帰は見つかりにくかった）。
 * Booking Admin表示（computeAdminCardPaymentDueAt_）・仮受付メール（buildPendingMail）と
 * 同じ実際の支払期限日時が本文に入ることを確認する。
 */
test('sendPaymentLinkMailForBooking: buildPaymentLinkMailへBookingConfig.getTtlConfig()を渡し、Booking Admin表示・仮受付メールと同じ実際の支払期限日時が本文に入る（設定の受け渡し漏れの回帰確認）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    paymentMethod: 'オンラインクレジットカード',
    createdAt: new Date('2026-09-28T10:00:00+09:00'),
    startAt: new Date('2026-10-05T10:00:00+09:00')
  });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, { now: new Date('2026-09-28T12:00:00+09:00') }
  );
  assert.strictEqual(result.success, true, JSON.stringify(result));
  /* createdAt+72h = 2026-10-01 10:00（buildPendingMailの同条件テスト・
     booking-mail-templates.test.jsのbuildPaymentLinkMailテストと同じ計算結果）。 */
  assert.match(mailApp._sentEmails[0].body, /お支払い期限: 2026-10-01（木） 10:00/);
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
  /* PRレビュー対応（Blocker 2）: 「入室方法」が本文に含まれること。 */
  assert.match(mailApp._sentEmails[0].body, /入室方法/);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.reminderSentAt));
  assert.ok(stubs.isDateLike(found.record.accessGuideSentAt));
  assert.strictEqual(found.record.reminderSentAt.getTime(), found.record.accessGuideSentAt.getTime());
});

test('sendReminderMailForBooking: ACCESS_GUIDE_PDF_URLは「必要に応じて」のため未設定でも送信できる（必須ではない）', function () {
  var mailApp = stubs.createMailAppStub();
  var propertiesWithoutPdf = Object.assign({}, COMPLETE_ACCESS_GUIDE_PROPERTIES);
  delete propertiesWithoutPdf.ACCESS_GUIDE_PDF_URL;
  var ctx = setup({ properties: propertiesWithoutPdf, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'CONFIRMED' });

  var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);
  assert.strictEqual(result.success, true, 'ACCESS_GUIDE_PDF_URLは必須項目ではない');
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

/*
 * PRレビュー対応（Blocker 2）: 秘密値（keyboxNumber/unlockCode）だけでなく、
 * 前日リマインドの必須内容（住所・建物・部屋・入口案内・キーボックス位置・入室方法・
 * 利用案内URL）がいずれか1つでも欠けていれば送信しない・成功扱いにしないことを
 * 1項目ずつ検証する。
 */
test('sendReminderMailForBooking: 来場案内の必須項目（住所/建物/部屋/入口案内/キーボックス位置/入室方法/URL/キーボックス番号/解錠コード）が1つでも欠けると送信せず、CONFIRMED状態を維持する', function () {
  var REQUIRED_KEYS = [
    'ACCESS_GUIDE_ADDRESS',
    'ACCESS_GUIDE_BUILDING',
    'ACCESS_GUIDE_ROOM',
    'ACCESS_GUIDE_ENTRANCE',
    'ACCESS_GUIDE_KEYBOX_LOCATION',
    'ACCESS_GUIDE_ENTRY_METHOD',
    'ACCESS_GUIDE_KEYBOX_NUMBER',
    'ACCESS_GUIDE_UNLOCK_CODE',
    'ACCESS_GUIDE_URL'
  ];

  REQUIRED_KEYS.forEach(function (missingKey) {
    var mailApp = stubs.createMailAppStub();
    var properties = Object.assign({}, COMPLETE_ACCESS_GUIDE_PROPERTIES);
    delete properties[missingKey];
    var ctx = setup({ properties: properties, mailApp: mailApp });
    var bookingId = seedBooking(ctx, { status: 'CONFIRMED', bookingId: 'SX-MISSING-' + missingKey });

    var result = ctx.sandbox.BookingMailer.sendReminderMailForBooking(bookingId);
    assert.strictEqual(result.success, false, missingKey + ' が欠けた場合は送信失敗にするべき');
    assert.strictEqual(mailApp._sentEmails.length, 0, missingKey + ' 欠落時はメールを送らない');

    var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
    assert.strictEqual(found.record.status, 'CONFIRMED', missingKey + ' 欠落でもstatusは変更しない');
    assert.strictEqual(found.record.reminderSentAt, '', missingKey);
    assert.strictEqual(found.record.accessGuideSentAt, '', missingKey);
  });
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
