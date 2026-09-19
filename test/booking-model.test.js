/*
 * gas/booking/Booking.gs（予約状態・入力検証・bookingId・TTL算出の純粋ロジック）のテスト。
 * Availability.gs（BookingAvailability）に依存するため、両方をvmへ読み込む。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var DEFAULT_CONFIG = {
  timezone: 'Asia/Tokyo',
  openTime: '08:00',
  closeTime: '23:00',
  minBookingMinutes: 120,
  bufferMinutes: 15,
  slotStepMinutes: 15
};

function loadBooking() {
  var sandbox = loadBookingSandbox(['Availability.gs', 'Booking.gs'], {});
  return sandbox.Booking;
}

function validInput(overrides) {
  return Object.assign(
    {
      brand: 'studio_x',
      date: '2026-10-01',
      startTime: '10:00',
      durationMinutes: 120,
      name: '山田太郎',
      email: 'taro@example.com',
      phone: '090-1234-5678',
      people: '2名',
      purpose: '緊縛の自主練習',
      paymentMethod: '現金',
      note: '',
      source: 'test'
    },
    overrides || {}
  );
}

test('validateCreateBookingInput: 正常な入力は valid:true でnormalizedを返す', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(validInput(), DEFAULT_CONFIG);
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.normalized.brand, 'studio_x');
  assert.strictEqual(result.normalized.durationMinutes, 120);
});

test('validateCreateBookingInput: snb/mens/studio_xの3ブランドはいずれも許可される（Issue #269）', function () {
  var Booking = loadBooking();
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var result = Booking.validateCreateBookingInput(validInput({ brand: brand }), DEFAULT_CONFIG);
    assert.strictEqual(result.valid, true, JSON.stringify(brand) + ' は許可されるべき');
    assert.strictEqual(result.normalized.brand, brand);
  });
});

test('validateCreateBookingInput: 未知のbrandはINVALID_BRANDで拒否する（brand偽装対策）', function () {
  var Booking = loadBooking();
  ['STUDIO_X', 'SNB', 'Mens', 'studio-x', 'ataru', '', ' ', 'snb ', undefined, null].forEach(function (brand) {
    var result = Booking.validateCreateBookingInput(validInput({ brand: brand }), DEFAULT_CONFIG);
    assert.strictEqual(result.valid, false, JSON.stringify(brand) + ' は拒否されるべき');
    assert.strictEqual(result.error.code, 'INVALID_BRAND');
  });
});

test('validateCreateBookingInput: 不正な日付はINVALID_DATE', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(validInput({ date: '2026/10/01' }), DEFAULT_CONFIG);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'INVALID_DATE');
});

test('validateCreateBookingInput: durationMinutesが数値以外・0以下はINVALID_DURATION', function () {
  var Booking = loadBooking();
  [0, -10, '120', null, undefined, 1.5].forEach(function (duration) {
    var result = Booking.validateCreateBookingInput(validInput({ durationMinutes: duration }), DEFAULT_CONFIG);
    assert.strictEqual(result.valid, false, JSON.stringify(duration));
    assert.strictEqual(result.error.code, 'INVALID_DURATION');
  });
});

test('validateCreateBookingInput: 最低利用時間未満はDURATION_TOO_SHORT', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(validInput({ durationMinutes: 60 }), DEFAULT_CONFIG);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'DURATION_TOO_SHORT');
});

test('validateCreateBookingInput: startTimeの形式不正はINVALID_START_TIME', function () {
  var Booking = loadBooking();
  ['10:5', '25:00', '10-00', '', undefined].forEach(function (startTime) {
    var result = Booking.validateCreateBookingInput(validInput({ startTime: startTime }), DEFAULT_CONFIG);
    assert.strictEqual(result.valid, false, JSON.stringify(startTime));
    assert.strictEqual(result.error.code, 'INVALID_START_TIME');
  });
});

test('validateCreateBookingInput: 営業時間外（開始が早すぎる/終了が遅すぎる）はINVALID_START_TIME', function () {
  var Booking = loadBooking();
  var tooEarly = Booking.validateCreateBookingInput(validInput({ startTime: '07:45' }), DEFAULT_CONFIG);
  assert.strictEqual(tooEarly.error.code, 'INVALID_START_TIME');

  var tooLate = Booking.validateCreateBookingInput(validInput({ startTime: '22:00', durationMinutes: 120 }), DEFAULT_CONFIG);
  assert.strictEqual(tooLate.error.code, 'INVALID_START_TIME', '22:00+120分は23:00を超えるため拒否されるべき');

  var justFits = Booking.validateCreateBookingInput(validInput({ startTime: '21:00', durationMinutes: 120 }), DEFAULT_CONFIG);
  assert.strictEqual(justFits.valid, true, '21:00+120分はちょうど23:00に収まるため許可されるべき');
});

test('validateCreateBookingInput: 開始時刻はslotStepMinutes（既定15分）刻みでなければSTART_TIME_NOT_ALIGNEDで拒否する（#265/#266固定仕様）', function () {
  var Booking = loadBooking();

  ['10:00', '10:15', '10:30', '10:45'].forEach(function (startTime) {
    var result = Booking.validateCreateBookingInput(validInput({ startTime: startTime }), DEFAULT_CONFIG);
    assert.strictEqual(result.valid, true, startTime + ' は15分刻みなので許可されるべき');
  });

  ['10:07', '10:01', '10:14', '10:44', '10:59'].forEach(function (startTime) {
    var result = Booking.validateCreateBookingInput(validInput({ startTime: startTime }), DEFAULT_CONFIG);
    assert.strictEqual(result.valid, false, startTime + ' は15分刻みでないため拒否されるべき');
    assert.strictEqual(result.error.code, 'START_TIME_NOT_ALIGNED');
  });
});

test('validateCreateBookingInput: SLOT_STEP_MINUTESが変更されていれば、その刻みで判定する', function () {
  var Booking = loadBooking();
  var config30 = Object.assign({}, DEFAULT_CONFIG, { slotStepMinutes: 30 });

  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ startTime: '10:30' }), config30).valid, true);
  var result = Booking.validateCreateBookingInput(validInput({ startTime: '10:15' }), config30);
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'START_TIME_NOT_ALIGNED');
});

test('validateCreateBookingInput: Availability設定が不正（fail-closed）な場合はINVALID_CONFIGで拒否し、開始時刻の判定まで進まない', function () {
  var Booking = loadBooking();

  var invalidConfigs = [
    Object.assign({}, DEFAULT_CONFIG, { bufferMinutes: NaN }), /* BUFFER_MINUTES=abc相当 */
    Object.assign({}, DEFAULT_CONFIG, { slotStepMinutes: 0 }), /* SLOT_STEP_MINUTES=0相当 */
    Object.assign({}, DEFAULT_CONFIG, { openTime: '23:00', closeTime: '08:00' }), /* OPEN>=CLOSE */
    Object.assign({}, DEFAULT_CONFIG, { minBookingMinutes: NaN })
  ];

  invalidConfigs.forEach(function (config) {
    var result = Booking.validateCreateBookingInput(validInput(), config);
    assert.strictEqual(result.valid, false, JSON.stringify(config));
    assert.strictEqual(result.error.code, 'INVALID_CONFIG', JSON.stringify(config));
  });
});

test('validateCreateBookingInput: 氏名・メール・電話・人数・目的・支払方法の入力不正をそれぞれ拒否する', function () {
  var Booking = loadBooking();

  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ name: '' }), DEFAULT_CONFIG).error.code, 'INVALID_NAME');
  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ name: '  ' }), DEFAULT_CONFIG).error.code, 'INVALID_NAME');
  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ name: 'a'.repeat(101) }), DEFAULT_CONFIG).error.code, 'INVALID_NAME');

  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ email: 'not-an-email' }), DEFAULT_CONFIG).error.code, 'INVALID_EMAIL');
  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ email: '' }), DEFAULT_CONFIG).error.code, 'INVALID_EMAIL');

  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ phone: 'abc-defg' }), DEFAULT_CONFIG).error.code, 'INVALID_PHONE');
  assert.strictEqual(
    Booking.validateCreateBookingInput(validInput({ phone: undefined }), DEFAULT_CONFIG).valid,
    true,
    '電話番号は任意項目'
  );

  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ people: '' }), DEFAULT_CONFIG).error.code, 'INVALID_PEOPLE');
  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ purpose: '' }), DEFAULT_CONFIG).error.code, 'INVALID_PURPOSE');
  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ paymentMethod: '' }), DEFAULT_CONFIG).error.code, 'INVALID_PAYMENT_METHOD');
});

test('validateCreateBookingInput: noteは1000文字を超えるとINVALID_NOTE、空・未指定は許可', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ note: 'a'.repeat(1001) }), DEFAULT_CONFIG).error.code, 'INVALID_NOTE');
  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ note: '' }), DEFAULT_CONFIG).valid, true);
  assert.strictEqual(Booking.validateCreateBookingInput(validInput({ note: undefined }), DEFAULT_CONFIG).valid, true);
});

test('generateBookingId: brand/date/uuidからstudio_x用の一意なIDを生成する（Issue #268からprefix "SX" を変更しない）', function () {
  var Booking = loadBooking();
  var id1 = Booking.generateBookingId('studio_x', '2026-10-01', '3f2a9b1c-aaaa-bbbb-cccc-111122223333');
  assert.strictEqual(id1, 'SX-20261001-3F2A9B1C');

  var id2 = Booking.generateBookingId('studio_x', '2026-10-01', 'different-uuid-0000-0000-000000000000');
  assert.notStrictEqual(id1, id2, '異なるuuidからは異なるbookingIdが生成されるべき');
});

test('generateBookingId: snb/mensはそれぞれ専用のbookingId prefixを持つ（Issue #269）', function () {
  var Booking = loadBooking();
  var uuid = '3f2a9b1c-aaaa-bbbb-cccc-111122223333';
  assert.strictEqual(Booking.generateBookingId('snb', '2026-10-01', uuid), 'SNB-20261001-3F2A9B1C');
  assert.strictEqual(Booking.generateBookingId('mens', '2026-10-01', uuid), 'MENS-20261001-3F2A9B1C');
});

test('getBrandLabel: 3ブランドそれぞれの表示名を返す（Calendar/管理者通知の表示専用）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.getBrandLabel('snb'), 'SNB');
  assert.strictEqual(Booking.getBrandLabel('mens'), 'SNB mens');
  assert.strictEqual(Booking.getBrandLabel('studio_x'), 'Studio X');
});

test('canTransition: PENDINGからのみ CONFIRMED/CANCELLED/EXPIRED へ遷移でき、それ以外は不可', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.canTransition('PENDING', 'CONFIRMED'), true);
  assert.strictEqual(Booking.canTransition('PENDING', 'EXPIRED'), true);
  assert.strictEqual(Booking.canTransition('PENDING', 'CANCELLED'), true);
  assert.strictEqual(Booking.canTransition('CONFIRMED', 'CONFIRMED'), false, '確定済みからの再確定は特別扱い(呼び出し側で判定)。canTransition自体はfalseを返す');
  assert.strictEqual(Booking.canTransition('CANCELLED', 'CONFIRMED'), false);
  assert.strictEqual(Booking.canTransition('EXPIRED', 'CONFIRMED'), false);
  assert.strictEqual(Booking.canTransition('PENDING', 'PENDING'), false);
});

test('computeTtlExpiryMillis: 受付24時間後と開始2時間前の早い方を採用する', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();

  /* 開始が3日後 → 24時間後の方が早い */
  var farStart = new Date('2026-10-04T09:00:00+09:00').getTime();
  var expiry1 = Booking.computeTtlExpiryMillis(createdAt, farStart, 24, 2);
  assert.strictEqual(expiry1, createdAt + 24 * 3600000);

  /* 開始が3時間後 → 開始2時間前の方が早い */
  var soonStart = createdAt + 3 * 3600000;
  var expiry2 = Booking.computeTtlExpiryMillis(createdAt, soonStart, 24, 2);
  assert.strictEqual(expiry2, soonStart - 2 * 3600000);
});

test('isExpired: 失効時刻ちょうど・その後はtrue、前はfalse', function () {
  var Booking = loadBooking();
  var createdAt = Date.now();
  var startAt = createdAt + 5 * 3600000;
  var expiryMillis = Booking.computeTtlExpiryMillis(createdAt, startAt, 24, 2);

  assert.strictEqual(Booking.isExpired(createdAt, startAt, 24, 2, expiryMillis - 1), false);
  assert.strictEqual(Booking.isExpired(createdAt, startAt, 24, 2, expiryMillis), true);
  assert.strictEqual(Booking.isExpired(createdAt, startAt, 24, 2, expiryMillis + 1), true);
});

test('isAllowedBrand: Issue #269でsnb/mens/studio_xの3ブランドを許可し、未知のbrandは拒否する', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isAllowedBrand('studio_x'), true);
  assert.strictEqual(Booking.isAllowedBrand('snb'), true);
  assert.strictEqual(Booking.isAllowedBrand('mens'), true);
  assert.strictEqual(Booking.isAllowedBrand('ataru'), false);
  assert.strictEqual(Booking.isAllowedBrand(''), false);
});
