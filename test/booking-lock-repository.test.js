/*
 * BookingLockRepository.gs の単体テスト（Issue #341 PR-Cレビュー対応・2回目）。
 *
 * このロックは、独立したBooking Webhook・Booking Adminの両プロジェクトが共有する
 * Bookings台帳と同じSpreadsheet上の「BookingLocks」シートへのappendRow＋直後の全件
 * 読み直しで実現する（BookingLockRepository.gs冒頭コメント参照）。ここでは実際の
 * プロジェクト間競合を、同一bookingIdへ異なるholderIdでacquireを呼ぶことで再現する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'BookingLockRepository.gs'];
var SPREADSHEET_ID = 'ss1';

function setup() {
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var globals = {
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    Utilities: stubs.createUtilitiesStub(),
    Logger: stubs.createLoggerStub(),
    PropertiesService: stubs.createPropertiesServiceStub({
      SPREADSHEET_ID: SPREADSHEET_ID,
      CALENDAR_ID: 'cal1'
    })
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  return { sandbox: sandbox, spreadsheetsById: spreadsheetsById };
}

test('acquire: 誰も保持していないbookingIdは即座に取得できる', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var result = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'webhook', now);
  assert.strictEqual(result.acquired, true);
  assert.strictEqual(typeof result.rowNumber, 'number');
});

test('acquire: 有効な他者のチケットが存在する間は取得できない（別プロジェクトからの競合を模擬）', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-admin', 'admin-expire', now);
  assert.strictEqual(first.acquired, true);

  var second = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-webhook', 'webhook', now);
  assert.strictEqual(second.acquired, false, '既に有効なチケットを持つ別のholderがいる間は取得できてはならない');
});

test('acquire: 無関係な別のbookingIdには影響しない', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  assert.strictEqual(first.acquired, true);

  var other = ctx.sandbox.BookingLockRepository.acquire('bk-2', 'holder-B', 'webhook', now);
  assert.strictEqual(other.acquired, true, '別のbookingIdは無関係に取得できる必要がある');
});

test('release後は同じbookingIdを別のholderが取得できる', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  assert.strictEqual(first.acquired, true);

  var blocked = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-B', 'webhook', now);
  assert.strictEqual(blocked.acquired, false);

  ctx.sandbox.BookingLockRepository.release(first.rowNumber, now);

  var afterRelease = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-C', 'webhook', now);
  assert.strictEqual(afterRelease.acquired, true, 'releaseされた後は新しいholderが取得できる必要がある');
});

test('取得に失敗したholder自身のチケットは自動的に解放され、後続の取得を無用にブロックしない', function () {
  var ctx = setup();
  var now = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', now);
  assert.strictEqual(first.acquired, true);

  var blocked = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-B', 'webhook', now);
  assert.strictEqual(blocked.acquired, false);

  /* holder-Aが解放すれば、blockedになったholder-B自身の失敗チケットが残っていても
     新しいholder-Cは正しく取得できる（失敗したholder-Bのチケットが誤ってholder-Cを
     ブロックしないことを確認する）。 */
  ctx.sandbox.BookingLockRepository.release(first.rowNumber, now);
  var third = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-C', 'webhook', now);
  assert.strictEqual(third.acquired, true);
});

test('TTL経過後は解放されていないチケットも自動的に失効し、他のholderが取得できる（クラッシュ復旧）', function () {
  var ctx = setup();
  var acquiredAt = new Date('2026-10-01T10:00:00+09:00');
  var first = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-A', 'admin-expire', acquiredAt, 1000);
  assert.strictEqual(first.acquired, true);

  var stillWithinTtl = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-B', 'webhook', new Date(acquiredAt.getTime() + 500));
  assert.strictEqual(stillWithinTtl.acquired, false, 'TTL内はholder-Aのチケットがまだ有効なため取得できてはならない');

  var afterTtl = ctx.sandbox.BookingLockRepository.acquire('bk-1', 'holder-C', 'webhook', new Date(acquiredAt.getTime() + 1500));
  assert.strictEqual(afterTtl.acquired, true, 'TTL経過後はholder-Aが解放していなくても取得できる必要がある（クラッシュ復旧）');
});

test('acquire: bookingId未指定は例外を投げる', function () {
  var ctx = setup();
  assert.throws(function () {
    ctx.sandbox.BookingLockRepository.acquire('', 'holder-A', 'webhook', new Date());
  });
});

test('acquire: holderId未指定は例外を投げる', function () {
  var ctx = setup();
  assert.throws(function () {
    ctx.sandbox.BookingLockRepository.acquire('bk-1', '', 'webhook', new Date());
  });
});
