/*
 * BookingRepository.applyPaymentStateUpdate のテスト（Issue #341 PR-Aレビュー対応）。
 *
 * 実際のStripe API・Webhookは呼ばない（PR-B/PR-Cの責務）。ここではLockServiceによる
 * 排他制御・更新順序（決済付随情報15列→paymentStatus単独の順）・部分失敗時のRecovery
 * 記録・要復旧ゲート・冪等な再実行（既に目的の状態ならalreadyApplied:trueで成功扱い）・
 * 未知のpaymentStatus値の検知で処理を停止する挙動を、モックのLockService/SpreadsheetApp
 * を使って検証する。
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
  'SpreadsheetRepository.gs',
  'RecoveryRepository.gs',
  'BookingRepository.gs'
];

var SPREADSHEET_ID = 'ss1';

function setup(options) {
  var opts = options || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = opts.sheetsByName || {};
  var properties = Object.assign({ SPREADSHEET_ID: SPREADSHEET_ID }, opts.properties || {});

  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    LockService: opts.lockService || stubs.createLockServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    Logger: stubs.createLoggerStub()
  };

  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, globals: globals };
}

function sampleRecord(overrides) {
  return Object.assign(
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
      paymentMethod: 'オンラインクレジットカード',
      status: 'PENDING',
      calendarEventId: 'event-1',
      source: 'test',
      note: '',
      paymentStatus: 'not_started'
    },
    overrides || {}
  );
}

function createBookingRow(ctx, overrides) {
  ctx.sandbox.SpreadsheetRepository.appendBooking(sampleRecord(overrides));
  return 'SX-20261001-AAAAAAAA';
}

test('applyPaymentStateUpdate: NOT_STARTED→CHECKOUT_PENDINGへ、決済付随情報→paymentStatusの順で1回ずつ書き込む', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', {
    paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1', paymentHoldExpiresAt: new Date('2026-10-01T09:30:00+09:00')
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.alreadyApplied, undefined);

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending');
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-1');
  assert.strictEqual(found.record.stripeCheckoutSessionId, 'cs_1');

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  var calls = sheet._setValuesCalls;
  assert.strictEqual(calls.length, 2, '決済付随情報の一括書き込みとpaymentStatus単独書き込みの2回だけ');
  assert.strictEqual(calls[0].numCols, 15, '1回目は決済付随情報15列の一括書き込み');
  assert.strictEqual(
    calls[0].col, ctx.sandbox.SpreadsheetRepository.HEADERS.indexOf('paymentAttemptId') + 1,
    '1回目はpaymentAttemptIdから始まる'
  );
  assert.strictEqual(calls[1].numCols, 1, '2回目はpaymentStatus単独の書き込み');
  assert.strictEqual(
    calls[1].col, ctx.sandbox.SpreadsheetRepository.HEADERS.indexOf('paymentStatus') + 1,
    '2回目はpaymentStatus列だけを書く'
  );
});

test('applyPaymentStateUpdate: fieldsを渡さない遷移（例: FAILED→CHECKOUT_PENDINGの再試行）はpaymentStatusのみ1回書き込む', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'failed' });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  assert.strictEqual(result.success, true);

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  assert.strictEqual(sheet._setValuesCalls.length, 1, 'fields省略時は決済付随情報の書き込みをスキップする');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'checkout_pending');
});

/*
 * 再実行時の整合性検証（Issue #341 PR-Aレビュー対応・項目1）: 既に目的の状態へ到達済みの
 * 場合は書き込みを一切行わずalreadyApplied:trueで成功を返す。Stripe Webhookの重複配信・
 * 呼び出し元の重複リトライを安全に吸収する。
 */
test('applyPaymentStateUpdate: 既にtoPaymentStatusと同じ場合は何も書き込まずalreadyApplied:trueで冪等に成功する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'paid' });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', { paymentConfirmedAt: new Date() });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.alreadyApplied, true);

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  assert.strictEqual(sheet._setValuesCalls.length, 0, '既に目的の状態なら一切書き込まない');
});

test('applyPaymentStateUpdate: Booking.canTransitionPaymentStatusで許可されない遷移はINVALID_PAYMENT_TRANSITIONを返し、何も書き込まない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'not_started' });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', { paymentConfirmedAt: new Date() });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'INVALID_PAYMENT_TRANSITION');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'not_started');
});

test('applyPaymentStateUpdate: 存在しないbookingIdはNOT_FOUNDを返す', function () {
  var ctx = setup();
  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate('NOT-EXIST', 'checkout_pending');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'NOT_FOUND');
});

test('applyPaymentStateUpdate: LockServiceがtryLockに失敗した場合はLOCK_TIMEOUTを返し、何も読み書きしない', function () {
  var ctx = setup({ lockService: stubs.createLockServiceStub({ forceTryLockFail: true }) });
  var bookingId = createBookingRow(ctx);

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'LOCK_TIMEOUT');
});

/*
 * 要復旧ゲート（Issue #341 PR-Aレビュー対応・項目1）: paymentRecoveryRequiredAtが
 * 既に設定されている予約は、遷移の妥当性を判定するまでもなく即座に拒否する
 * （feeRecoveryRequiredAtと同じ設計方針）。
 */
test('applyPaymentStateUpdate: paymentRecoveryRequiredAtが設定済みの予約はPAYMENT_RECOVERY_REQUIREDで即座に拒否し、何も書き込まない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, {
    paymentStatus: 'checkout_pending',
    paymentRecoveryRequiredAt: new Date('2026-09-30T12:00:00+09:00'),
    paymentRecoveryReason: 'TEST_SEED'
  });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'paid', { paymentConfirmedAt: new Date() });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_RECOVERY_REQUIRED');

  var sheet = ctx.globals.SpreadsheetApp.openById(SPREADSHEET_ID).getSheetByName('Bookings');
  assert.strictEqual(sheet._setValuesCalls.length, 0);
});

/*
 * 未知のpaymentStatusの扱い（Issue #341 PR-Aレビュー対応・項目2）: normalizePaymentStatusが
 * nullを返す（旧unpaid・既知の6値のいずれでもない）値は「未決済」とみなさず、
 * 決済処理を停止する。要復旧フラグを立て、Recoveryにも記録する。
 */
test('applyPaymentStateUpdate: 未知のpaymentStatus値が混入している場合はUNKNOWN_PAYMENT_STATUSで処理を停止し、要復旧フラグとRecovery記録を残す', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'some_unexpected_value' });

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'UNKNOWN_PAYMENT_STATUS');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'some_unexpected_value', '不明な値そのものは書き換えない（上書きして証跡を消さない）');
  assert.ok(found.record.paymentRecoveryRequiredAt, '要復旧フラグが立つ');
  assert.ok(
    /paymentStatus/.test(found.record.paymentRecoveryReason),
    'paymentRecoveryReasonには管理者向けの説明文が入る（Recovery.failureTypeとは別にBookings上でも状況が分かるように）'
  );

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'UNKNOWN_PAYMENT_STATUS');
  assert.strictEqual(recovery[0].bookingId, bookingId);
});

test('applyPaymentStateUpdate: 未知のpaymentStatus値で一度要復旧になった予約は、以後の呼び出しもPAYMENT_RECOVERY_REQUIREDで即座に拒否される', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx, { paymentStatus: 'some_unexpected_value' });

  ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  var second = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending');
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.error.code, 'PAYMENT_RECOVERY_REQUIRED');
});

/*
 * 部分失敗時のRecovery記録（Issue #341 PR-Aレビュー対応・項目1、更新順序の裏付け）:
 * 決済付随情報の書き込み自体が失敗した場合、この呼び出しでは何も変化していないため
 * 要復旧フラグは立てない（呼び出し元が最初からやり直せば足りる）。
 */
test('applyPaymentStateUpdate: 決済付随情報の書き込みが失敗した場合はPAYMENT_DETAIL_WRITE_FAILEDを返し、paymentStatus・要復旧フラグとも変化しない', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  ctx.sandbox.SpreadsheetRepository.updateBookingPaymentStateAtomic = function () {
    throw new Error('simulated sheets failure');
  };

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', { paymentAttemptId: 'PAY-1' });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_DETAIL_WRITE_FAILED');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentStatus, 'not_started', '書き込みが失敗した呼び出しではpaymentStatusを変更しない');
  assert.strictEqual(found.record.paymentRecoveryRequiredAt, '', '何も反映されていないため要復旧フラグは立てない（最初からやり直せる）');
  assert.strictEqual(ctx.sandbox.RecoveryRepository.listAll().length, 0);
});

/*
 * これがこのレビュー対応の核心テスト：決済付随情報は書き込みに成功したのに、
 * paymentStatus単独の書き込みだけが失敗した場合、台帳は「詳細情報は新しいが状態は古い」
 * という不整合のまま残る。この状態を検出し、要復旧フラグ・Recovery記録を残して
 * 以後の自動処理を止めることを検証する。
 */
test('applyPaymentStateUpdate: 決済付随情報は成功しpaymentStatusの書き込みだけ失敗した場合、不整合を検知して要復旧フラグ・Recoveryを記録する', function () {
  var ctx = setup();
  var bookingId = createBookingRow(ctx);

  var originalUpdateBookingFields = ctx.sandbox.SpreadsheetRepository.updateBookingFields;
  ctx.sandbox.SpreadsheetRepository.updateBookingFields = function (id, fields) {
    if (Object.prototype.hasOwnProperty.call(fields, 'paymentStatus')) {
      throw new Error('simulated sheets failure on paymentStatus write');
    }
    return originalUpdateBookingFields(id, fields);
  };

  var result = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', {
    paymentAttemptId: 'PAY-1', stripeCheckoutSessionId: 'cs_1'
  });
  assert.strictEqual(result.success, false);
  assert.strictEqual(result.error.code, 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT');

  var found = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(found.record.paymentAttemptId, 'PAY-1', '決済付随情報は既に反映されている');
  assert.strictEqual(found.record.stripeCheckoutSessionId, 'cs_1');
  assert.strictEqual(found.record.paymentStatus, 'not_started', 'paymentStatusは古いまま（不整合が可視化される）');
  assert.ok(found.record.paymentRecoveryRequiredAt, '不整合を検知して要復旧フラグを立てる');
  assert.ok(
    /paymentStatus/.test(found.record.paymentRecoveryReason) && /checkout_pending/.test(found.record.paymentRecoveryReason),
    'paymentRecoveryReasonには目標状態を含む管理者向けの説明文が入る'
  );

  var recovery = ctx.sandbox.RecoveryRepository.listAll();
  assert.strictEqual(recovery.length, 1);
  assert.strictEqual(recovery[0].failureType, 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT');
  assert.strictEqual(recovery[0].bookingId, bookingId);

  // 以後の呼び出しは要復旧ゲートで即座に拒否される（自動リトライで二重に付随情報を書かない）。
  var second = ctx.sandbox.BookingRepository.applyPaymentStateUpdate(bookingId, 'checkout_pending', { paymentAttemptId: 'PAY-2' });
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.error.code, 'PAYMENT_RECOVERY_REQUIRED');
  var foundAfter = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId);
  assert.strictEqual(foundAfter.record.paymentAttemptId, 'PAY-1', '要復旧ゲートにより2回目の呼び出しでは付随情報も書き換わらない');
});
