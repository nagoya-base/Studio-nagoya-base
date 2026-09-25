/*
 * Code.gs（Issue #342: doGet action=estimatePrice）の配線テスト。
 * 料金表そのもののロジックはtest/booking-pricing.test.js（BookingPricing.gs単体）で
 * 検証済みのため、ここではCode.gsの配線（action分岐・パラメータ解析・入力検証・
 * JSON出力・Calendar/Sheetsへ一切アクセスしないこと）だけを確認する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

var FILES = ['Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'BookingPricing.gs', 'Code.gs'];

function loadCode(properties) {
  return loadBookingSandbox(FILES, {
    PropertiesService: stubs.createPropertiesServiceStub(properties || {}),
    CalendarApp: stubs.createCalendarAppStub({}),
    Utilities: stubs.createUtilitiesStub(),
    ContentService: stubs.createContentServiceStub()
  });
}

function callDoGet(sandbox, params) {
  var output = sandbox.doGet({ parameter: params || {} });
  return JSON.parse(output.text);
}

var FIXED_WEEKDAY_DATE = '2099-01-05'; /* 月曜（date -d で確認済み。test/booking-pricing.test.jsと同じ固定日付） */
var FIXED_SATURDAY_DATE = '2099-01-03';

test('doGet: action=estimatePriceは料金計算を返す（studio_x・平日3時間）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' });
  var body = callDoGet(sandbox, { action: 'estimatePrice', brand: 'studio_x', date: FIXED_WEEKDAY_DATE, durationMinutes: '180' });

  assert.strictEqual(body.success, true);
  assert.strictEqual(body.price.amount, 6000);
  assert.strictEqual(body.price.tier, 'GENERAL');
  assert.strictEqual(body.price.dayType, 'WEEKDAY');
});

test('doGet: action=estimatePriceはisMember=1のときstudio_xも会員料金にする（PR #343レビュー対応: ブランド分離基準書v1.1）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' });
  var member = callDoGet(sandbox, { action: 'estimatePrice', brand: 'studio_x', date: FIXED_WEEKDAY_DATE, durationMinutes: '180', isMember: '1' });
  assert.strictEqual(member.price.tier, 'MEMBER');
  assert.strictEqual(member.price.amount, 5500);
  var general = callDoGet(sandbox, { action: 'estimatePrice', brand: 'studio_x', date: FIXED_WEEKDAY_DATE, durationMinutes: '180' });
  assert.strictEqual(general.price.tier, 'GENERAL');
});

test('doGet: action=estimatePriceはisMember=1のときsnbを会員料金にする。0/未指定/不正値はGENERALのまま', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' });

  var member = callDoGet(sandbox, { action: 'estimatePrice', brand: 'snb', date: FIXED_WEEKDAY_DATE, durationMinutes: '180', isMember: '1' });
  assert.strictEqual(member.price.tier, 'MEMBER');
  assert.strictEqual(member.price.amount, 5500);

  ['0', '', 'yes', undefined].forEach(function (rawIsMember) {
    var params = { action: 'estimatePrice', brand: 'snb', date: FIXED_WEEKDAY_DATE, durationMinutes: '180' };
    if (rawIsMember !== undefined) params.isMember = rawIsMember;
    var body = callDoGet(sandbox, params);
    assert.strictEqual(body.price.tier, 'GENERAL', JSON.stringify(rawIsMember) + ' はGENERALのままであるべき（"true"文字列のみ許可）');
  });

  var trueString = callDoGet(sandbox, { action: 'estimatePrice', brand: 'snb', date: FIXED_WEEKDAY_DATE, durationMinutes: '180', isMember: 'true' });
  assert.strictEqual(trueString.price.tier, 'MEMBER', '"true"文字列も受理するべき');
});

test('doGet: action=estimatePriceはmensブランドで常に会員料金を返す', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' });
  var body = callDoGet(sandbox, { action: 'estimatePrice', brand: 'mens', date: FIXED_SATURDAY_DATE, durationMinutes: '240' });
  assert.strictEqual(body.price.tier, 'MEMBER');
  assert.strictEqual(body.price.amount, 9000);
  assert.strictEqual(body.price.dayType, 'WEEKEND_HOLIDAY');
});

test('doGet: action=estimatePriceは不正なbrandをINVALID_BRANDとして拒否する', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' });
  var body = callDoGet(sandbox, { action: 'estimatePrice', brand: 'ataru', date: FIXED_WEEKDAY_DATE, durationMinutes: '120' });
  assert.strictEqual(body.success, false);
  assert.strictEqual(body.error.code, 'INVALID_BRAND');
});

test('doGet: action=estimatePriceは不正な日付・利用時間をバリデーションエラーとして返す', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' });

  var badDate = callDoGet(sandbox, { action: 'estimatePrice', brand: 'snb', date: 'invalid-date', durationMinutes: '120' });
  assert.strictEqual(badDate.success, false);
  assert.strictEqual(badDate.error.code, 'INVALID_DATE');

  var shortDuration = callDoGet(sandbox, { action: 'estimatePrice', brand: 'snb', date: FIXED_WEEKDAY_DATE, durationMinutes: '60' });
  assert.strictEqual(shortDuration.success, false);
  assert.strictEqual(shortDuration.error.code, 'DURATION_TOO_SHORT');

  var missingDuration = callDoGet(sandbox, { action: 'estimatePrice', brand: 'snb', date: FIXED_WEEKDAY_DATE });
  assert.strictEqual(missingDuration.success, false);
  assert.strictEqual(missingDuration.error.code, 'INVALID_DURATION');
});

test('doGet: action=estimatePriceはCalendar APIへ一切問い合わせない（見積りのみで空き判定はしない）', function () {
  var calendarQueried = false;
  var sandbox = loadBookingSandbox(FILES, {
    PropertiesService: stubs.createPropertiesServiceStub({ CALENDAR_ID: 'cal1' }),
    CalendarApp: {
      getCalendarById: function () {
        return { getEvents: function () { calendarQueried = true; return []; } };
      }
    },
    Utilities: stubs.createUtilitiesStub(),
    ContentService: stubs.createContentServiceStub()
  });

  var body = callDoGet(sandbox, { action: 'estimatePrice', brand: 'snb', date: FIXED_WEEKDAY_DATE, durationMinutes: '120' });
  assert.strictEqual(body.success, true);
  assert.strictEqual(calendarQueried, false);
});

test('doGet: action=estimatePriceのレスポンスはJSON MIMEタイプで返す', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' });
  var output = sandbox.doGet({ parameter: { action: 'estimatePrice', brand: 'snb', date: FIXED_WEEKDAY_DATE, durationMinutes: '120' } });
  assert.strictEqual(output.mimeType, 'JSON');
});

test('doGet: action=estimatePriceはPIIを一切含まないレスポンスを返す（許可されたキーのみ）', function () {
  var sandbox = loadCode({ CALENDAR_ID: 'cal1' });
  var body = callDoGet(sandbox, { action: 'estimatePrice', brand: 'snb', date: FIXED_WEEKDAY_DATE, durationMinutes: '120' });
  var allowedKeys = ['success', 'brand', 'date', 'durationMinutes', 'price'];
  Object.keys(body).forEach(function (key) {
    assert.ok(allowedKeys.indexOf(key) !== -1, '想定外のキーが含まれている: ' + key);
  });
});
