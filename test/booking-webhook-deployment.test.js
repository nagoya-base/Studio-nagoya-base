/*
 * Issue #341 PR-Cレビュー対応・1回目。
 *
 * 初回提出は、Stripe Webhook用の`doPost`をBooking Adminプロジェクト（管理者専用UI・
 * `getAdminBookings`/`adminConfirmBooking`/`adminCancelBooking`等を持つ）の2つ目の
 * デプロイ（Anyone公開）として追加していた。しかしApps Scriptの複数デプロイは同一
 * プロジェクトの同じコードを異なるURL・アクセス設定で公開するに過ぎず、`doGet`や
 * `google.script.run`で公開される関数はデプロイ単位ではなくプロジェクト単位で共通のため、
 * このAnyone公開デプロイのURLへアクセスするだけで、本来「Only myself」のはずの
 * 管理者専用UI・確定/取消・メール送信等まで公開されてしまう欠陥があった。
 *
 * このファイルは、実際にBooking Webhookプロジェクトへ配布するファイルセット
 * （test/helpers/booking-deployment-manifest.jsのBOOKING_WEBHOOK_FILES）だけをvmへ
 * 読み込み、そのグローバルスコープに管理者向けの関数・エントリポイントが一切存在しない
 * （＝構造的に公開されようがない）ことを検証する。BOOKING_ADMIN_FILESとの重複が万一
 * 発生しても、これらの関数名さえ含まれていなければ、このテストは検出できる限りにおいて
 * 安全側であることを保証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');

var CALENDAR_ID = 'cal1';
var SPREADSHEET_ID = 'ss1';

var COMPLETE_MAIL_PROPERTIES = {
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com'
};

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign(
    {
      CALENDAR_ID: CALENDAR_ID, SPREADSHEET_ID: SPREADSHEET_ID,
      STRIPE_SECRET_KEY: 'sk_test_dummy',
      STRIPE_WEBHOOK_RELAY_SECRET: 'relay-secret'
    },
    COMPLETE_MAIL_PROPERTIES,
    opts.properties || {}
  );
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: opts.events || [] } }),
    Utilities: stubs.createUtilitiesStub(),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    UrlFetchApp: opts.urlFetchApp || stubs.createUrlFetchAppStub(function () { return { responseCode: 200, body: {} }; }),
    MailApp: opts.mailApp || stubs.createMailAppStub(),
    Logger: stubs.createLoggerStub(),
    ContentService: stubs.createContentServiceStub()
  };
  var sandbox = loadBookingSandbox(manifest.BOOKING_WEBHOOK_FILES, globals);
  return { sandbox: sandbox, globals: globals };
}

test('Booking Webhookプロジェクトのファイルセットは、それだけでReferenceErrorなく読み込める', function () {
  assert.doesNotThrow(function () {
    setup();
  });
});

test('Booking Webhookプロジェクトには公開Web Appのエントリポイントとして doPost のみが定義され、doGet は定義されない', function () {
  var ctx = setup();
  assert.strictEqual(typeof ctx.sandbox.doPost, 'function');
  assert.strictEqual(
    typeof ctx.sandbox.doGet,
    'undefined',
    'doGetが定義されている。公開デプロイへのGETリクエストで何らかのページ・データが返ってしまう可能性があるため、Booking WebhookプロジェクトにdoGetを持たせてはならない。'
  );
});

test('Booking Webhookプロジェクトには管理者向けのサーバー関数（google.script.run経由で呼ばれ得るもの）が一切定義されない', function () {
  var ctx = setup();
  /* BookingAdmin.gs/BookingAdminWeb.gs/BookingTriggers.gs等が公開するグローバル関数。
     万一これらのファイル名がBOOKING_WEBHOOK_FILESへ紛れ込んでも、この関数名リストで
     検出できるようにする（多層防御）。 */
  var adminOnlyGlobalFunctionNames = [
    'getAdminBookings',
    'getAdminBookingDetail',
    'adminConfirmBooking',
    'adminCancelBooking',
    'adminResendReminderMail',
    'adminSendCardPaymentLink',
    'confirmBooking',
    'cancelBookingAdmin',
    'reviveExpiredBooking',
    'updateBookingPrice',
    'expirePendingBookings',
    'onOpen',
    'createExpirePendingBookingsTrigger',
    'createNextDayReminderTrigger',
    'sendNextDayReminders',
    'sendReminderTestMail'
  ];

  adminOnlyGlobalFunctionNames.forEach(function (name) {
    assert.strictEqual(
      typeof ctx.sandbox[name],
      'undefined',
      '管理者向け関数 ' + name + ' がBooking Webhookプロジェクトのグローバルスコープに存在する。' +
        'このプロジェクトはAnyoneアクセスで公開するため、管理者向け機能を一切含めてはならない。'
    );
  });
});

test('Booking Webhookプロジェクトが公開する唯一のHTTPエントリポイント（doPost）は、認証に失敗したリクエストの中身を一切解釈しない', function () {
  var ctx = setup();
  var request = {
    postData: { contents: JSON.stringify({ timestamp: Math.floor(Date.now() / 1000), signature: 'invalid', body: JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' }) }) }
  };
  var output = ctx.sandbox.doPost(request);
  var parsed = JSON.parse(output.text);
  assert.strictEqual(parsed.success, false);
  assert.strictEqual(parsed.error.code, 'FORBIDDEN');
});

test('BOOKING_WEBHOOK_FILESには管理者専用ファイルが1つも含まれない', function () {
  var adminOnlyFiles = [
    'BookingAdmin.gs', 'BookingAdminWeb.gs', 'BookingTriggers.gs',
    'BookingReminderTriggers.gs', 'BookingReminderDiagnostics.gs'
  ];
  adminOnlyFiles.forEach(function (fileName) {
    assert.strictEqual(
      manifest.BOOKING_WEBHOOK_FILES.indexOf(fileName), -1,
      'BOOKING_WEBHOOK_FILESに管理者専用ファイル' + fileName + 'が含まれている。'
    );
  });
});
