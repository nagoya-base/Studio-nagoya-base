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

/* ---------- PRICE_UPDATE（管理者による金額修正の利用者案内。PR #343レビュー対応） ---------- */

test('sendPriceUpdateMailForBooking: 金額修正済み（priceOverrideAt非空）のPENDING予約に1通送り、priceUpdateMailSentAtを記録する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    priceAmount: 4000,
    priceOverrideAmount: 3500,
    priceOverrideAt: new Date('2026-09-30T12:00:00+09:00')
  });

  var result = ctx.sandbox.BookingMailer.sendPriceUpdateMailForBooking(bookingId);
  assert.strictEqual(result.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);
  assert.match(mailApp._sentEmails[0].subject, /訂正/);
  assert.match(mailApp._sentEmails[0].body, /3,500円（税込）/);
  assert.doesNotMatch(mailApp._sentEmails[0].body, /4,000円/, '訂正前の自動計算額ではなく修正後の実効金額を案内するべき');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.priceUpdateMailSentAt));
});

test('sendPriceUpdateMailForBooking: 金額修正がまだない予約（priceOverrideAtが空）はNO_PRICE_OVERRIDEでスキップし、メールを送らない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING' });

  var result = ctx.sandbox.BookingMailer.sendPriceUpdateMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.skipped, true);
  assert.strictEqual(result.error.code, 'NO_PRICE_OVERRIDE');
  assert.strictEqual(mailApp._sentEmails.length, 0);
});

test('sendPriceUpdateMailForBooking: PENDING以外（CONFIRMED/CANCELLED/EXPIRED）には送らない（updateBookingPrice自体がPENDING限定のため）', function () {
  var mailApp = stubs.createMailAppStub();
  ['CONFIRMED', 'CANCELLED', 'EXPIRED'].forEach(function (status) {
    var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
    var bookingId = seedBooking(ctx, {
      status: status,
      priceAmount: 4000,
      priceOverrideAmount: 3500,
      priceOverrideAt: new Date('2026-09-30T12:00:00+09:00')
    });

    var result = ctx.sandbox.BookingMailer.sendPriceUpdateMailForBooking(bookingId);
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error.code, 'INVALID_STATUS', status + ' には送れないべき');
  });
});

test('sendPriceUpdateMailForBooking: 二重実行しても再送しない。force:trueなら再送できる', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    priceAmount: 4000,
    priceOverrideAmount: 3500,
    priceOverrideAt: new Date('2026-09-30T12:00:00+09:00')
  });

  ctx.sandbox.BookingMailer.sendPriceUpdateMailForBooking(bookingId);
  var second = ctx.sandbox.BookingMailer.sendPriceUpdateMailForBooking(bookingId);
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(mailApp._sentEmails.length, 1);

  var forced = ctx.sandbox.BookingMailer.sendPriceUpdateMailForBooking(bookingId, { force: true });
  assert.strictEqual(forced.success, true);
  assert.strictEqual(mailApp._sentEmails.length, 2);
});

test('sendPriceUpdateMailForBooking: MailApp失敗でも予約状態は変更されず、priceUpdateMailSentAtも記録されない', function () {
  var mailApp = stubs.createMailAppStub({ throwError: new Error('mail server down') });
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    priceAmount: 4000,
    priceOverrideAmount: 3500,
    priceOverrideAt: new Date('2026-09-30T12:00:00+09:00')
  });

  var result = ctx.sandbox.BookingMailer.sendPriceUpdateMailForBooking(bookingId);
  assert.strictEqual(result.success, false);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.status, 'PENDING');
  assert.strictEqual(found.record.priceUpdateMailSentAt, '');
});

test('sendPriceUpdateMailForBooking: 設定不足（BOOKING_MAIL_*未設定）はfail-closedに拒否し、メールを送らない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: {}, mailApp: mailApp });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    priceAmount: 4000,
    priceOverrideAmount: 3500,
    priceOverrideAt: new Date('2026-09-30T12:00:00+09:00')
  });

  var result = ctx.sandbox.BookingMailer.sendPriceUpdateMailForBooking(bookingId);
  assert.strictEqual(result.success, false);
  assert.strictEqual(mailApp._sentEmails.length, 0);
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

/* resolvePaymentLinkMetadataInconsistency（第5回PRレビュー対応）が確認済みの補正値
   として渡すStripe URL・送信先メールアドレス。実際に送信したURL・宛先を管理者が
   確認したうえで入力する値を想定し、記録済みのSAMPLE_PAYMENT_LINK_URL・
   予約者メールアドレス（'taro@example.com'）とは別の値にしている（補正操作が実際に
   これらの値へ書き換えることをテストで確認できるようにするため）。 */
var CONFIRMED_PAYMENT_LINK_URL = 'https://buy.stripe.com/test_CONFIRMED456';
var CONFIRMED_SENT_TO = 'confirmed-sent-to@example.com';

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

/*
 * PRレビュー対応②（第2回。送信履歴の部分失敗が競合検知をすり抜ける問題の修正）:
 * sendPaymentLinkMailForBookingはpaymentLinkSentAtを単独で先に書き込み、
 * paymentLinkSendCount等は2回目の呼び出しで書き込む。2回目だけが失敗すると
 * paymentLinkSentAtは新しくなるがpaymentLinkSendCountは古いまま残るため、
 * expectedSendCountだけの比較では、この状態を見ていない古い画面からの再送を
 * 検知できない。expectedSentAtVersion（paymentLinkSentAtのepoch ms）も独立に
 * 比較することで、送信回数が変わっていなくても送信日時が変わっていれば
 * SEND_HISTORY_CONFLICTとして拒否できることを確認する。
 */
test('sendPaymentLinkMailForBooking: expectedSendCountが一致していても、expectedSentAtVersionがpaymentLinkSentAtの最新値と一致しない場合は通常送信・明示的な再送のいずれもSEND_HISTORY_CONFLICTで拒否する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var first = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ expectedSendCount: 0, expectedSentAtVersion: 0 }, BEFORE_DUE)
  );
  assert.strictEqual(first.success, true, JSON.stringify(first));
  var staleSentAtVersion = first.sentAt.getTime();

  /* paymentLinkSentAtだけを直接進める（paymentLinkSendCountは変えない）。2回目の
     書き込みだけが失敗した状態を、この時点までの結果として模擬する。 */
  ctx.sandbox.SpreadsheetRepository.updateBookingFields(bookingId, { paymentLinkSentAt: new Date(staleSentAtVersion + 5000) });

  var normalAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL,
    Object.assign({ expectedSendCount: 1, expectedSentAtVersion: staleSentAtVersion }, BEFORE_DUE)
  );
  assert.strictEqual(normalAttempt.success, false);
  assert.strictEqual(normalAttempt.error.code, 'SEND_HISTORY_CONFLICT', '送信回数(expectedSendCount:1)は一致していても、送信日時が変わっているため競合として拒否するべき');

  var forcedAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL,
    Object.assign({ force: true, expectedSendCount: 1, expectedSentAtVersion: staleSentAtVersion }, BEFORE_DUE)
  );
  assert.strictEqual(forcedAttempt.success, false);
  assert.strictEqual(forcedAttempt.error.code, 'SEND_HISTORY_CONFLICT', 'forceでも、送信日時の古い前提での再送は拒否するべき');
  assert.strictEqual(mailApp._sentEmails.length, 1, '競合したリクエストからは送信されないべき');
});

/*
 * PRレビュー対応①・③（第2回。2回目の履歴保存失敗時の記録不整合と、それによる
 * 競合検知のすり抜けを再現するテスト）: paymentLinkSentAtの単独更新には成功するが、
 * 続くstripePaymentLinkUrl/paymentLinkSentTo/paymentLinkSendCount等の2回目の
 * updateBookingFields呼び出しだけを失敗させるスタブ（stubMetadataWriteFailure_）を
 * 使う。paymentLinkSendCountを一意に識別できる呼び出しのみを対象にすることで、
 * paymentLinkSentAt単独呼び出し・paymentLinkSendUnconfirmedAt/
 * paymentLinkMetadataInconsistentAtの単独フォールバック呼び出しには影響しない。
 */
function stubMetadataWriteFailure_(ctx) {
  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'paymentLinkSendCount')) {
      throw new Error('simulated Sheets outage while recording paymentLinkSendCount/URL/sentTo');
    }
    return original(id, fields);
  };
  return function restore() {
    ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;
  };
}

test('sendPaymentLinkMailForBooking: 2回目の履歴保存（URL/送信先/送信回数）だけが失敗した場合、success:trueのまま実際に記録された送信回数を返し、metadataInconsistent:true・paymentLinkMetadataInconsistentAt・Recoveryへ記録し、メール自体は再送しない', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });
  var restore = stubMetadataWriteFailure_(ctx);

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restore();

  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(result.metadataInconsistent, true);
  assert.strictEqual(result.sendCount, 0, '2回目の書き込みが失敗しているため、実際に記録された（従来からの）送信回数を返すべき');
  assert.strictEqual(result.intendedSendCount, 1, '本来記録されるはずだった送信回数も併せて返す');
  assert.strictEqual(mailApp._sentEmails.length, 1, 'メール自体は1通のみ送信されるべき（自動再送しない）');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.ok(stubs.isDateLike(found.record.paymentLinkSentAt), '二重送信防止の要となるpaymentLinkSentAtは記録済みであるべき');
  assert.strictEqual(Number(found.record.paymentLinkSendCount) || 0, 0, 'paymentLinkSendCountは実際には更新されていないはず');
  assert.ok(found.record.paymentLinkMetadataInconsistentAt, 'paymentLinkMetadataInconsistentAtへ記録されるべき');

  var recoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) { return r.bookingId === bookingId; });
  assert.strictEqual(recoveries.length, 1);
  assert.strictEqual(recoveries[0].failureType, 'PAYMENT_LINK_METADATA_UPDATE_FAILED');
});

test('sendPaymentLinkMailForBooking: 2回目の履歴保存だけが失敗した状態を再現し、その状態を見ていない別タブの古いpaymentLinkSentAtVersion・paymentLinkSendCountからの明示的な再送はSEND_HISTORY_CONFLICTで拒否される（part4: 競合検知のすり抜け防止の再現テスト）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  /* タブA・タブBともに、まだ何も送信されていない状態（expectedSendCount:0・
     expectedSentAtVersion:0）を見ている。 */
  var restore = stubMetadataWriteFailure_(ctx);
  var firstAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ expectedSendCount: 0, expectedSentAtVersion: 0 }, BEFORE_DUE)
  );
  restore();
  assert.strictEqual(firstAttempt.success, true, JSON.stringify(firstAttempt));
  assert.strictEqual(firstAttempt.metadataInconsistent, true, '前提: 2回目の履歴保存が失敗しているべき');
  assert.strictEqual(mailApp._sentEmails.length, 1);

  /* タブB: 2回目の履歴保存の失敗を知らず、送信前と同じ古い前提
     （expectedSendCount:0・expectedSentAtVersion:0）のまま明示的な再送を試みる。
     paymentLinkSendCountは実際には更新されていないため0のままだが、
     paymentLinkSentAtは既に更新されているため、expectedSentAtVersionの不一致で
     競合として検知されるべき（expectedSendCountだけの比較ではすり抜けてしまう）。 */
  var staleTabBForced = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ force: true, expectedSendCount: 0, expectedSentAtVersion: 0 }, BEFORE_DUE)
  );
  assert.strictEqual(staleTabBForced.success, false);
  assert.strictEqual(staleTabBForced.error.code, 'SEND_HISTORY_CONFLICT', 'expectedSendCountが実際の値(0)と一致していても、送信日時が変わっているため競合として拒否するべき');
  assert.strictEqual(mailApp._sentEmails.length, 1, '競合したタブBからは送信されないべき（二重送信していない）');
});

/*
 * 第3回PRレビュー対応: paymentLinkMetadataInconsistentAtが記録されている間は、
 * 送信履歴の照合・補正（resolvePaymentLinkMetadataInconsistency）が完了するまで、
 * 通常送信・明示的な再送のいずれも拒否する（METADATA_INCONSISTENT。forceでも
 * 無視しない）。以前は「別の送信が成功しただけ」で不整合フラグがクリアされてしまい、
 * 実際の送信回数と台帳上の送信回数の差が隠れる問題があったため、これを修正した。
 */
test('sendPaymentLinkMailForBooking: paymentLinkMetadataInconsistentAtが記録された予約は、画面を最新化した（stale判定に引っかからない）通常送信・明示的な再送のいずれもMETADATA_INCONSISTENTで拒否する（不整合の解消が完了するまで）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var restore = stubMetadataWriteFailure_(ctx);
  var firstAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restore();
  assert.strictEqual(firstAttempt.success, true, JSON.stringify(firstAttempt));
  assert.strictEqual(firstAttempt.metadataInconsistent, true, '前提: 2回目の履歴保存が失敗しているべき');

  /* 「画面を最新化した」＝expectedSendCount/expectedSentAtVersionのstale判定には
     引っかからない、最新の状態を正しく見ている操作を想定する。それでも
     METADATA_INCONSISTENTで拒否されるべき（SEND_HISTORY_CONFLICTとは別の理由）。 */
  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  var freshOptions = {
    expectedSendCount: Number(found.record.paymentLinkSendCount) || 0,
    expectedSentAtVersion: found.record.paymentLinkSentAt.getTime()
  };

  var normalAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({}, freshOptions, BEFORE_DUE)
  );
  assert.strictEqual(normalAttempt.success, false);
  assert.strictEqual(normalAttempt.skipped, true);
  assert.strictEqual(normalAttempt.error.code, 'METADATA_INCONSISTENT');

  var forcedAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ force: true }, freshOptions, BEFORE_DUE)
  );
  assert.strictEqual(forcedAttempt.success, false);
  assert.strictEqual(forcedAttempt.error.code, 'METADATA_INCONSISTENT', 'forceでも記録不整合の間は送信できないべき');

  assert.strictEqual(mailApp._sentEmails.length, 1, '不整合が解消されていない間は追加の送信が起きてはいけない');

  var afterAttempts = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.ok(afterAttempts.paymentLinkMetadataInconsistentAt, '不整合フラグはこの拒否によって変化しない');
});

/*
 * resolvePaymentLinkMetadataInconsistency（送信履歴の補正。第5回PRレビュー対応で
 * confirmedUrl・confirmedSentToを追加）。
 */
test('resolvePaymentLinkMetadataInconsistency: 記録不整合の予約に対し、確認済みの送信回数・URL・送信先へ補正し、paymentLinkMetadataInconsistentAtをクリアして送信を再び許可する', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var restore = stubMetadataWriteFailure_(ctx);
  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restore();
  var beforeResolve = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.ok(beforeResolve.paymentLinkMetadataInconsistentAt, '前提: 記録不整合が発生しているべき');
  assert.strictEqual(Number(beforeResolve.paymentLinkSendCount) || 0, 0);
  assert.strictEqual(beforeResolve.stripePaymentLinkUrl, '', '前提: 2回目の書き込みが失敗しているためURLも記録されていないべき');
  assert.strictEqual(beforeResolve.paymentLinkSentTo, '', '前提: 2回目の書き込みが失敗しているため送信先も記録されていないべき');

  /* 管理者が実際の送信状況（送信回数・実際に送信したURL・宛先）を確認し、補正する。 */
  var resolveResult = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(
    bookingId, 1, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO
  );
  assert.strictEqual(resolveResult.success, true, JSON.stringify(resolveResult));
  assert.strictEqual(resolveResult.paymentLinkSendCount, 1);
  assert.strictEqual(resolveResult.stripePaymentLinkUrl, CONFIRMED_PAYMENT_LINK_URL);
  assert.strictEqual(resolveResult.paymentLinkSentTo, CONFIRMED_SENT_TO);

  var afterResolve = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(Number(afterResolve.paymentLinkSendCount) || 0, 1);
  assert.strictEqual(afterResolve.stripePaymentLinkUrl, CONFIRMED_PAYMENT_LINK_URL, 'URLも確認済みの値へ補正されるべき');
  assert.strictEqual(afterResolve.paymentLinkSentTo, CONFIRMED_SENT_TO, '送信先も確認済みの値へ補正されるべき');
  assert.ok(!afterResolve.paymentLinkMetadataInconsistentAt, '3項目すべての補正を確認できたので不整合フラグがクリアされるべき');

  var resolvedRecoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) {
    return r.bookingId === bookingId && r.failureType === 'PAYMENT_LINK_METADATA_RESOLVED';
  });
  assert.strictEqual(resolvedRecoveries.length, 1);
  assert.strictEqual(resolvedRecoveries[0].recoveryState, 'RESOLVED');

  /* 補正後は送信が再び許可される（明示的な再送でなくてもよい。paymentLinkSentAtは
     既に記録済みのため通常送信はALREADY_SENTになるが、force resendは成功するべき）。 */
  var forcedAfterResolve = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ force: true }, BEFORE_DUE)
  );
  assert.strictEqual(forcedAfterResolve.success, true, JSON.stringify(forcedAfterResolve));
  assert.strictEqual(mailApp._sentEmails.length, 2);
});

test('resolvePaymentLinkMetadataInconsistency: 記録不整合ではない予約に対してはNOT_INCONSISTENTで拒否し、送信履歴を書き換えない（対象の限定）', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, 5, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_INCONSISTENT');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(Number(found.paymentLinkSendCount) || 0, 0);
});

test('resolvePaymentLinkMetadataInconsistency: 補正値が現在の記録より小さい場合はCONFIRMED_SEND_COUNT_TOO_LOWで拒否し、既存の送信履歴を消してしまわない', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    paymentMethod: 'オンラインクレジットカード',
    paymentLinkSendCount: 3,
    paymentLinkMetadataInconsistentAt: new Date('2026-10-01T10:00:00+09:00')
  });

  var result = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, 2, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO);
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'CONFIRMED_SEND_COUNT_TOO_LOW');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(Number(found.record.paymentLinkSendCount) || 0, 3, '拒否された場合は既存の記録を変更しない');
  assert.ok(found.record.paymentLinkMetadataInconsistentAt, '拒否された場合は不整合フラグもクリアしない');
});

test('resolvePaymentLinkMetadataInconsistency: 補正値が0以上の整数でない場合はINVALID_CONFIRMED_SEND_COUNTで拒否する', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    paymentMethod: 'オンラインクレジットカード',
    paymentLinkMetadataInconsistentAt: new Date('2026-10-01T10:00:00+09:00')
  });

  [-1, 1.5, NaN, 'abc'].forEach(function (invalidValue) {
    var result = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, invalidValue, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO);
    assert.strictEqual(result.success, false, JSON.stringify(invalidValue));
    assert.strictEqual(result.error.code, 'INVALID_CONFIRMED_SEND_COUNT', JSON.stringify(invalidValue));
  });
});

/*
 * 第5回PRレビュー対応: 補正対象がpaymentLinkSendCountだけでは不十分で、この不整合フラグの
 * 原因となった書き込みが対象とするstripePaymentLinkUrl・paymentLinkSentToも補正・確認
 * できなければ、URL・送信先が古いままフラグだけが解除されてしまう。confirmedUrl・
 * confirmedSentToの形式検証を追加した。
 */
test('resolvePaymentLinkMetadataInconsistency: confirmedUrlがStripe決済リンクURLの形式でない場合はINVALID_CONFIRMED_URLで拒否し、既存の記録を書き換えない', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    paymentMethod: 'オンラインクレジットカード',
    stripePaymentLinkUrl: SAMPLE_PAYMENT_LINK_URL,
    paymentLinkSentTo: 'taro@example.com',
    paymentLinkSendCount: 1,
    paymentLinkMetadataInconsistentAt: new Date('2026-10-01T10:00:00+09:00')
  });

  ['not-a-url', 'https://example.com/not-stripe', ' ' + CONFIRMED_PAYMENT_LINK_URL, ''].forEach(function (invalidUrl) {
    var result = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, 1, invalidUrl, CONFIRMED_SENT_TO);
    assert.strictEqual(result.success, false, JSON.stringify(invalidUrl));
    assert.strictEqual(result.error.code, 'INVALID_CONFIRMED_URL', JSON.stringify(invalidUrl));
  });

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(found.stripePaymentLinkUrl, SAMPLE_PAYMENT_LINK_URL, '拒否された場合は既存のURLを書き換えない');
  assert.ok(found.paymentLinkMetadataInconsistentAt, '拒否された場合は不整合フラグもクリアしない');
});

test('resolvePaymentLinkMetadataInconsistency: confirmedSentToがメールアドレスの形式でない場合はINVALID_CONFIRMED_SENT_TOで拒否し、既存の記録を書き換えない', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    paymentMethod: 'オンラインクレジットカード',
    stripePaymentLinkUrl: SAMPLE_PAYMENT_LINK_URL,
    paymentLinkSentTo: 'taro@example.com',
    paymentLinkSendCount: 1,
    paymentLinkMetadataInconsistentAt: new Date('2026-10-01T10:00:00+09:00')
  });

  ['not-an-email', 'missing-domain@', ' ' + CONFIRMED_SENT_TO, ''].forEach(function (invalidSentTo) {
    var result = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, 1, CONFIRMED_PAYMENT_LINK_URL, invalidSentTo);
    assert.strictEqual(result.success, false, JSON.stringify(invalidSentTo));
    assert.strictEqual(result.error.code, 'INVALID_CONFIRMED_SENT_TO', JSON.stringify(invalidSentTo));
  });

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(found.paymentLinkSentTo, 'taro@example.com', '拒否された場合は既存の送信先を書き換えない');
  assert.ok(found.paymentLinkMetadataInconsistentAt, '拒否された場合は不整合フラグもクリアしない');
});

/*
 * 第4回PRレビュー対応: resolvePaymentLinkMetadataInconsistency自体が、補正対象の書き込みと
 * 不整合フラグのクリアという2つの書き込みを1回のupdateBookingFields呼び出しに
 * まとめていたため、片方だけが失敗すると「補正が反映されていないのにフラグだけが
 * クリアされる」おそれがあった。以下のスタブは、補正対象（URL/送信先/送信回数の3項目）
 * の更新・フラグのクリアのそれぞれを単独で狙って失敗させる（resolvePaymentLinkMetadataInconsistencyが
 * この2つを別々のupdateBookingFields呼び出しに分離した場合のみ、それぞれを個別に
 * 制御できる）。
 */
function isFieldsCorrectionCall_(fields) {
  var keys = Object.keys(fields);
  return keys.indexOf('stripePaymentLinkUrl') !== -1 &&
    keys.indexOf('paymentLinkSentTo') !== -1 &&
    keys.indexOf('paymentLinkSendCount') !== -1;
}

function stubResolveFieldsWriteFailure_(ctx) {
  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (isFieldsCorrectionCall_(fields)) {
      throw new Error('simulated Sheets outage while writing corrected stripePaymentLinkUrl/paymentLinkSentTo/paymentLinkSendCount');
    }
    return original(id, fields);
  };
  return function restore() {
    ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;
  };
}

/* 例外を投げずに「書き込んだつもりだが実際には反映されない」silentな失敗を再現する
   （try/catchの成否だけでなく、再取得による検証が必要であることを確認するため）。 */
function stubResolveFieldsSilentFailure_(ctx) {
  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (isFieldsCorrectionCall_(fields)) {
      return id;
    }
    return original(id, fields);
  };
  return function restore() {
    ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;
  };
}

function stubResolveFlagClearWriteFailure_(ctx) {
  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    var keys = Object.keys(fields);
    if (keys.length === 1 && keys[0] === 'paymentLinkMetadataInconsistentAt' && fields.paymentLinkMetadataInconsistentAt === '') {
      throw new Error('simulated Sheets outage while clearing paymentLinkMetadataInconsistentAt');
    }
    return original(id, fields);
  };
  return function restore() {
    ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;
  };
}

/*
 * 第5回PRレビュー対応: URL・送信先・送信回数の3項目のうち1項目（ここではpaymentLinkSendCount）
 * だけの書き込みが失敗するケースを再現する。updateBookingFieldsは渡されたフィールドを
 * 内部でループして1つずつ書き込む実装のため、複数フィールドを1回の呼び出しに渡した場合、
 * 途中の1項目だけが失敗し他の項目は実際に書き込まれる、という部分的な失敗が起こり得る
 * （このファイルの他のスタブ（stubMetadataWriteFailure_等）は呼び出し全体を即座に失敗させる
 * だけなので、この「一部の項目だけが古いまま」という状態は再現できない）。
 */
function stubResolveFieldsPartialWriteFailure_(ctx, failOnKey) {
  var original = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (!isFieldsCorrectionCall_(fields)) {
      return original(id, fields);
    }
    var keys = Object.keys(fields);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (key === failOnKey) {
        throw new Error('simulated partial write failure while writing: ' + key);
      }
      var singleKeyFields = {};
      singleKeyFields[key] = fields[key];
      original(id, singleKeyFields);
    }
    return id;
  };
  return function restore() {
    ctx.sandbox.SpreadsheetRepository.updateBookingFields = original;
  };
}

/*
 * 第5回PRレビュー対応: 不整合フラグのクリア操作（Step 3のupdateBookingFields）自体は
 * 実際に成功するが、その直後の最終確認の再取得（Step 4のfindRowByBookingId）だけが
 * 失敗するケースを再現する。呼び出し回数ではなく「フラグが実際に空になった直後の
 * 読み取りかどうか」で判定するため、内部の呼び出し順序（updateBookingFields自体も
 * 内部でfindRowByBookingIdを呼ぶ）が変わっても、意図した箇所だけを狙って失敗させられる。
 */
function stubFinalRefetchFailureAfterFlagCleared_(ctx) {
  var original = ctx.sandbox.SpreadsheetRepository.findRowByBookingId;
  ctx.sandbox.SpreadsheetRepository.findRowByBookingId = function (id) {
    var found = original(id);
    if (found && !found.record.paymentLinkMetadataInconsistentAt) {
      throw new Error('simulated Sheets outage while re-fetching right after clearing paymentLinkMetadataInconsistentAt');
    }
    return found;
  };
  return function restore() {
    ctx.sandbox.SpreadsheetRepository.findRowByBookingId = original;
  };
}

test('resolvePaymentLinkMetadataInconsistency: URL・送信先・送信回数の補正書き込みが例外で失敗した場合、RESOLVE_FIELDS_NOT_CONFIRMEDを返し不整合フラグを維持したままRecoveryへ記録する（補正が未反映のままフラグが誤って解除されない）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var restoreMetadataFailure = stubMetadataWriteFailure_(ctx);
  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restoreMetadataFailure();
  var beforeResolve = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.ok(beforeResolve.paymentLinkMetadataInconsistentAt, '前提: 記録不整合が発生しているべき');

  var restoreResolveFailure = stubResolveFieldsWriteFailure_(ctx);
  var resolveResult = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, 1, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO);
  restoreResolveFailure();

  assert.strictEqual(resolveResult.success, false, JSON.stringify(resolveResult));
  assert.strictEqual(resolveResult.error.code, 'RESOLVE_FIELDS_NOT_CONFIRMED');
  assert.strictEqual(resolveResult.requiresManualConfirmation, true);

  var afterResolve = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(Number(afterResolve.paymentLinkSendCount) || 0, 0, '送信回数の補正は反映されていないべき');
  assert.strictEqual(afterResolve.stripePaymentLinkUrl, '', 'URLの補正も反映されていないべき');
  assert.ok(afterResolve.paymentLinkMetadataInconsistentAt, '補正が確認できない間は不整合フラグを維持するべき（誤って解除されない）');

  var incompleteRecoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) {
    return r.bookingId === bookingId && r.failureType === 'PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE';
  });
  assert.strictEqual(incompleteRecoveries.length, 1);
  assert.strictEqual(incompleteRecoveries[0].recoveryState, 'OPEN');

  var resolvedRecoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) {
    return r.bookingId === bookingId && r.failureType === 'PAYMENT_LINK_METADATA_RESOLVED';
  });
  assert.strictEqual(resolvedRecoveries.length, 0, '補正が完了していないためRESOLVEDは記録されないべき');

  /* 不整合フラグが維持されている間は、通常送信・明示的な再送とも依然拒否されるべき。 */
  var forcedAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ force: true }, BEFORE_DUE)
  );
  assert.strictEqual(forcedAttempt.success, false);
  assert.strictEqual(forcedAttempt.error.code, 'METADATA_INCONSISTENT');
  assert.strictEqual(mailApp._sentEmails.length, 1, '不整合が解消されていない間は追加の送信が起きてはいけない');
});

test('resolvePaymentLinkMetadataInconsistency: URL・送信先・送信回数の補正書き込みが例外を投げずに反映されなかった場合（silentな失敗）でも、再取得による検証でRESOLVE_FIELDS_NOT_CONFIRMEDとして拒否し不整合フラグを維持する', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var restoreMetadataFailure = stubMetadataWriteFailure_(ctx);
  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restoreMetadataFailure();

  var restoreSilentFailure = stubResolveFieldsSilentFailure_(ctx);
  var resolveResult = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, 1, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO);
  restoreSilentFailure();

  assert.strictEqual(resolveResult.success, false, JSON.stringify(resolveResult));
  assert.strictEqual(resolveResult.error.code, 'RESOLVE_FIELDS_NOT_CONFIRMED', '例外が起きなくても、再取得した実際の値が確認済みの値と一致しない場合は失敗として扱うべき');

  var afterResolve = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(Number(afterResolve.paymentLinkSendCount) || 0, 0);
  assert.ok(afterResolve.paymentLinkMetadataInconsistentAt, '不整合フラグは維持されるべき');
});

test('resolvePaymentLinkMetadataInconsistency: URL・送信先はすでに正しく、送信回数だけが古い状態でも、送信回数の補正書き込みが失敗した場合は不整合フラグを解除せず、再試行で正しく解除できる（一部フィールドだけが古い状態の再現）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    paymentMethod: 'オンラインクレジットカード',
    stripePaymentLinkUrl: CONFIRMED_PAYMENT_LINK_URL,
    paymentLinkSentTo: CONFIRMED_SENT_TO,
    paymentLinkSendCount: 1,
    paymentLinkMetadataInconsistentAt: new Date('2026-10-01T10:00:00+09:00')
  });

  /* URL・送信先はすでに確認済みの値と一致しているが、送信回数（1回→2回）だけがまだ
     古い。この補正の書き込み中、paymentLinkSendCountの更新だけが失敗する状況を再現する
     （URL・送信先は既に同じ値のため書き込み自体は成功するが、送信回数だけが反映されない）。 */
  var restorePartialFailure = stubResolveFieldsPartialWriteFailure_(ctx, 'paymentLinkSendCount');
  var firstAttempt = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(
    bookingId, 2, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO
  );
  restorePartialFailure();

  assert.strictEqual(firstAttempt.success, false, JSON.stringify(firstAttempt));
  assert.strictEqual(firstAttempt.error.code, 'RESOLVE_FIELDS_NOT_CONFIRMED');

  var afterFirstAttempt = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(Number(afterFirstAttempt.paymentLinkSendCount) || 0, 1, '送信回数の補正はまだ反映されていないべき');
  assert.strictEqual(afterFirstAttempt.stripePaymentLinkUrl, CONFIRMED_PAYMENT_LINK_URL);
  assert.strictEqual(afterFirstAttempt.paymentLinkSentTo, CONFIRMED_SENT_TO);
  assert.ok(afterFirstAttempt.paymentLinkMetadataInconsistentAt, 'URL・送信先は既に正しくても、送信回数の反映を確認できない間は不整合フラグを維持するべき（補正完了前にフラグが解除されない）');

  var forcedAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ force: true }, BEFORE_DUE)
  );
  assert.strictEqual(forcedAttempt.success, false);
  assert.strictEqual(forcedAttempt.error.code, 'METADATA_INCONSISTENT');
  assert.strictEqual(mailApp._sentEmails.length, 0, '不整合が解消されていない間は送信できてはいけない');

  /* 部分失敗を起こさずに再試行すると、3項目すべての反映を確認できて不整合が解消される。 */
  var retryResult = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(
    bookingId, 2, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO
  );
  assert.strictEqual(retryResult.success, true, JSON.stringify(retryResult));

  var finalRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(Number(finalRecord.paymentLinkSendCount) || 0, 2);
  assert.ok(!finalRecord.paymentLinkMetadataInconsistentAt, '補正完了後は不整合フラグが解除されるべき');
});

test('resolvePaymentLinkMetadataInconsistency: URL・送信先・送信回数の補正は保存できたが、続く不整合フラグのクリアだけが失敗した場合、RESOLVE_FLAG_CLEAR_NOT_CONFIRMEDを返し不整合フラグを維持したまま送信を拒否し続ける', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var restoreMetadataFailure = stubMetadataWriteFailure_(ctx);
  ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  restoreMetadataFailure();

  var restoreFlagFailure = stubResolveFlagClearWriteFailure_(ctx);
  var resolveResult = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(bookingId, 1, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO);
  restoreFlagFailure();

  assert.strictEqual(resolveResult.success, false, JSON.stringify(resolveResult));
  assert.strictEqual(resolveResult.error.code, 'RESOLVE_FLAG_CLEAR_NOT_CONFIRMED');
  assert.strictEqual(resolveResult.requiresManualConfirmation, true);
  assert.strictEqual(resolveResult.paymentLinkSendCount, 1, '送信回数自体の補正は保存できているはず');
  assert.strictEqual(resolveResult.stripePaymentLinkUrl, CONFIRMED_PAYMENT_LINK_URL);
  assert.strictEqual(resolveResult.paymentLinkSentTo, CONFIRMED_SENT_TO);

  var afterResolve = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.strictEqual(Number(afterResolve.paymentLinkSendCount) || 0, 1, '送信回数の補正は保存されているべき');
  assert.strictEqual(afterResolve.stripePaymentLinkUrl, CONFIRMED_PAYMENT_LINK_URL);
  assert.ok(afterResolve.paymentLinkMetadataInconsistentAt, '不整合フラグのクリアが確認できない間はフラグを維持するべき（誤って解除されない）');

  var incompleteRecoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) {
    return r.bookingId === bookingId && r.failureType === 'PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE';
  });
  assert.strictEqual(incompleteRecoveries.length, 1);
  assert.strictEqual(incompleteRecoveries[0].recoveryState, 'OPEN');

  var resolvedRecoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) {
    return r.bookingId === bookingId && r.failureType === 'PAYMENT_LINK_METADATA_RESOLVED';
  });
  assert.strictEqual(resolvedRecoveries.length, 0, '補正が完了していないためRESOLVEDは記録されないべき');

  /* フラグのクリアが確認できていない間は、補正対象の値が既に正しく保存済みであっても、
     通常送信・明示的な再送とも依然拒否されるべき。 */
  var normalAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(normalAttempt.success, false);
  assert.strictEqual(normalAttempt.error.code, 'METADATA_INCONSISTENT');

  var forcedAttempt = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ force: true }, BEFORE_DUE)
  );
  assert.strictEqual(forcedAttempt.success, false);
  assert.strictEqual(forcedAttempt.error.code, 'METADATA_INCONSISTENT');
  assert.strictEqual(mailApp._sentEmails.length, 1, '不整合が解消されていない間は追加の送信が起きてはいけない');
});

/*
 * 第5回PRレビュー対応: 不整合フラグのクリア操作自体は成功しているが、その直後の
 * 最終確認の再取得だけが失敗した場合、resolvePaymentLinkMetadataInconsistencyは
 * 「フラグは維持されている」と断定してはいけない（実際にはクリアされている可能性が
 * あるため）。この場合はRESOLVE_RESULT_UNKNOWNを返し、Bookingsシートを直接確認するよう
 * 案内する。
 */
test('resolvePaymentLinkMetadataInconsistency: 不整合フラグのクリア操作後、最終確認の再取得自体が失敗した場合はRESOLVE_RESULT_UNKNOWNを返し、フラグが維持されているとは断定しない', function () {
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES });
  var bookingId = seedBooking(ctx, {
    status: 'PENDING',
    paymentMethod: 'オンラインクレジットカード',
    paymentLinkSendCount: 1,
    paymentLinkMetadataInconsistentAt: new Date('2026-10-01T10:00:00+09:00')
  });

  var restore = stubFinalRefetchFailureAfterFlagCleared_(ctx);
  var resolveResult = ctx.sandbox.BookingMailer.resolvePaymentLinkMetadataInconsistency(
    bookingId, 2, CONFIRMED_PAYMENT_LINK_URL, CONFIRMED_SENT_TO
  );
  restore();

  assert.strictEqual(resolveResult.success, false, JSON.stringify(resolveResult));
  assert.strictEqual(resolveResult.error.code, 'RESOLVE_RESULT_UNKNOWN');
  assert.doesNotMatch(resolveResult.error.message, /フラグは維持されて/, '再取得自体が失敗した場合は、フラグが維持されていると断定する文言を含めるべきではない');
  assert.match(resolveResult.error.message, /不明/, '確認できない状態であることを案内するべき');

  /* 実際にはクリア操作自体は成功しており（再取得だけが失敗した状況を再現したもの）、
     Bookingsシート上のフラグは既にクリアされている。resolvePaymentLinkMetadataInconsistencyの
     戻り値だけからは「維持されている」と断定できないことを裏付ける（台帳の実際の状態は
     戻り値の推測と異なり得るため、案内文は「確認できない」で止めるべきという設計）。 */
  var actualRecord = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
  assert.ok(!actualRecord.paymentLinkMetadataInconsistentAt, '実際にはフラグはクリアされているはず（再取得の失敗だけを再現したため）');
  assert.strictEqual(Number(actualRecord.paymentLinkSendCount) || 0, 2);
  assert.strictEqual(actualRecord.stripePaymentLinkUrl, CONFIRMED_PAYMENT_LINK_URL);

  var incompleteRecoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) {
    return r.bookingId === bookingId && r.failureType === 'PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE';
  });
  assert.strictEqual(incompleteRecoveries.length, 1);
  assert.strictEqual(incompleteRecoveries[0].recoveryState, 'OPEN');

  var resolvedRecoveries = ctx.sandbox.RecoveryRepository.listAll().filter(function (r) {
    return r.bookingId === bookingId && r.failureType === 'PAYMENT_LINK_METADATA_RESOLVED';
  });
  assert.strictEqual(resolvedRecoveries.length, 0, '結果を確認できていないためRESOLVEDは記録されないべき');
});

test('sendPaymentLinkMailForBooking: expectedSendCount・expectedSentAtVersionのいずれも渡さない場合は競合チェック自体を行わない（既存挙動を維持。省略時は省略前と同じ結果になる）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(bookingId, SAMPLE_PAYMENT_LINK_URL, BEFORE_DUE);
  assert.strictEqual(result.success, true, JSON.stringify(result));
});

test('sendPaymentLinkMailForBooking: expectedSendCountのみ渡した場合はexpectedSentAtVersionの不一致チェックを行わない（各項目は独立に省略できる）', function () {
  var mailApp = stubs.createMailAppStub();
  var ctx = setup({ properties: COMPLETE_MAIL_PROPERTIES, mailApp: mailApp });
  var bookingId = seedBooking(ctx, { status: 'PENDING', paymentMethod: 'オンラインクレジットカード' });

  var result = ctx.sandbox.BookingMailer.sendPaymentLinkMailForBooking(
    bookingId, SAMPLE_PAYMENT_LINK_URL, Object.assign({ expectedSendCount: 0 }, BEFORE_DUE)
  );
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
