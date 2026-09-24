/*
 * カード決済の96時間受付条件（Issue #334）が、GAS側（gas/booking/shared/Booking.gsの
 * validateCreateBookingInput）とフロント側（scripts/booking-logic.jsのisCardPaymentEligible）で
 * 一致することを検証する（PR #336レビュー対応）。
 *
 * 以前はGAS側が「暦日差×1440分＋分単位に丸めた現在時刻」、フロント側がミリ秒精度という
 * 異なる粒度で判定しており、96時間ちょうど付近の秒・ミリ秒単位の境界で結果がずれうる
 * 不具合があった。ここでは同じ固定時刻（now）をGAS側・フロント側の両方へそのまま渡し、
 * 判定結果（true/false）が常に一致することを1つのテストファイルで直接比較する
 * （test/booking-model.test.jsのGAS単体境界テスト・test/booking-logic.test.jsのフロント
 * 単体境界テストは、それぞれの実装内の回帰検証として別途維持する）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

var DEFAULT_CONFIG = {
  timezone: 'Asia/Tokyo',
  openTime: '08:00',
  closeTime: '23:00',
  minBookingMinutes: 120,
  bufferMinutes: 15,
  slotStepMinutes: 15
};

function loadBooking() {
  return loadBookingSandbox(['Availability.gs', 'Booking.gs'], {}).Booking;
}

function loadLogic() {
  return loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
}

/* test/booking-model.test.jsのvalidInput()と同じ形。ここでは日付・開始時刻・支払方法を
   固定し、nowだけをケースごとに変える。 */
function cardInput(date, startTime) {
  return {
    brand: 'studio_x',
    customerType: 'returning',
    date: date,
    startTime: startTime,
    durationMinutes: 120,
    name: '山田太郎',
    email: 'taro@example.com',
    phone: '090-1234-5678',
    people: '2名',
    purpose: '緊縛の自主練習',
    paymentMethod: 'オンラインクレジットカード',
    note: '',
    source: 'test'
  };
}

var DATE = '2026-10-05';
var START_TIME = '12:00';
var START_AT_MILLIS = new Date('2026-10-05T12:00:00+09:00').getTime();
var EXACTLY_96H_BEFORE_MILLIS = START_AT_MILLIS - 96 * 3600000;

var CASES = [
  { label: '96時間ちょうど前（境界を含む→許可）', offsetMs: 0, expected: true },
  { label: '96時間+1秒前（余裕がある→許可）', offsetMs: -1000, expected: true },
  { label: '96時間+1ミリ秒前（余裕がある→許可）', offsetMs: -1, expected: true },
  { label: '96時間-1秒前（1秒足りない→拒否）', offsetMs: 1000, expected: false },
  { label: '96時間-1ミリ秒前（1ミリ秒足りない→拒否）', offsetMs: 1, expected: false },
  { label: '96時間より十分先（余裕がある→許可）', offsetMs: -3600000, expected: true },
  { label: '96時間よりかなり後（大幅に不足→拒否）', offsetMs: 3600000, expected: false }
];

test('カード決済の96時間受付条件: GAS側（Booking.validateCreateBookingInput）とフロント側（Logic.isCardPaymentEligible）が同じ固定時刻で同じ結果になる', function () {
  var Booking = loadBooking();
  var Logic = loadLogic();

  CASES.forEach(function (testCase) {
    var now = new Date(EXACTLY_96H_BEFORE_MILLIS + testCase.offsetMs);

    var gasResult = Booking.validateCreateBookingInput(cardInput(DATE, START_TIME), DEFAULT_CONFIG, now);
    var logicEligible = Logic.isCardPaymentEligible(DATE, START_TIME, now);

    assert.strictEqual(gasResult.valid, testCase.expected, 'GAS: ' + testCase.label + '（' + JSON.stringify(gasResult.error) + '）');
    assert.strictEqual(logicEligible, testCase.expected, 'フロント: ' + testCase.label);
    assert.strictEqual(
      gasResult.valid,
      logicEligible,
      'GASとフロントの判定が一致しない: ' + testCase.label + '（now=' + now.toISOString() + '）'
    );
    if (!gasResult.valid) {
      assert.strictEqual(gasResult.error.code, 'CARD_PAYMENT_TOO_CLOSE_TO_START');
    }
  });
});

test('カード決済の96時間受付条件: 異なるタイムゾーン設定（Asia/Tokyo以外）でも、GAS側の絶対時刻換算がフロント側の想定（常にAsia/Tokyo基準）とずれないことを確認する', function () {
  /*
   * フロント側（scripts/booking-logic.js）は常にAsia/Tokyo（JST固定）で利用開始日時を
   * 解釈する実装のため、GAS側のavailabilityConfig.timezoneがAsia/Tokyo以外に設定される
   * ことは現状の運用では想定していない（Script PropertiesのTIMEZONEは既定Asia/Tokyoで
   * 固定運用。README参照）。ただしGAS側の新しいBookingAvailability.zonedDateTimeToUtcMillis
   * はtimezone値をハードコードしていないため、この前提が万一崩れて別timezoneが設定
   * された場合にGAS側だけが誤動作しないことを確認しておく（フロントとのズレそのものは
   * 別問題として、GAS単体の変換が指定timezoneを正しく尊重することの回帰確認）。
   */
  var Booking = loadBooking();
  var utcConfig = Object.assign({}, DEFAULT_CONFIG, { timezone: 'UTC' });
  var input = cardInput(DATE, START_TIME);

  /* UTC設定の場合、'2026-10-05 12:00'はUTCの壁時計時刻として解釈されるため、
     絶対時刻はAsia/Tokyo解釈より9時間遅くなる（2026-10-05T12:00:00Z）。 */
  var startAtUtcMillis = new Date('2026-10-05T12:00:00Z').getTime();
  var exactly96hBefore = Booking.validateCreateBookingInput(
    input, utcConfig, new Date(startAtUtcMillis - 96 * 3600000)
  );
  assert.strictEqual(exactly96hBefore.valid, true, JSON.stringify(exactly96hBefore.error));

  var oneSecondShort = Booking.validateCreateBookingInput(
    input, utcConfig, new Date(startAtUtcMillis - 96 * 3600000 + 1000)
  );
  assert.strictEqual(oneSecondShort.valid, false);
  assert.strictEqual(oneSecondShort.error.code, 'CARD_PAYMENT_TOO_CLOSE_TO_START');
});
