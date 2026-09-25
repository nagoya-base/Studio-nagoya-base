/*
 * gas/booking/shared/Booking.gs（予約状態・入力検証・bookingId・TTL算出の純粋ロジック）のテスト。
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

/* Asia/Tokyo基準で実行時刻からdaysAhead日後の'YYYY-MM-DD'を返す。validInput()の既定dateに
   使う（Issue #270 3回目レビュー指摘対応）。validateCreateBookingInputはnow省略時に
   実時刻を使って過去日拒否を行うため、既定dateを固定文字列にすると実行日がその日付を
   過ぎた時点でnow省略の呼び出しが一斉にINVALID_DATEへ変わり自然故障する。 */
function futureDateJst_(daysAhead) {
  var d = new Date(Date.now() + daysAhead * 24 * 3600000);
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d);
  var out = {};
  parts.forEach(function (part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

/* 「当日/翌日/過去日」という時間条件そのものを検証していない一般テスト用の既定日付。
   実行時刻から60日後（Asia/Tokyo基準）を動的に算出し、固定日付に依存しない。 */
var DEFAULT_FUTURE_DATE = futureDateJst_(60);

function validInput(overrides) {
  return Object.assign(
    {
      brand: 'studio_x',
      customerType: 'returning',
      date: DEFAULT_FUTURE_DATE,
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

/*
 * 当日利用ルール（Issue #270）。当日判定はnow引数（受付時刻）をavailabilityConfig.timezone
 * （既定Asia/Tokyo）基準の暦日へ変換して行う。ブラウザのローカルtimezoneには依存しない。
 * NOWを固定してJST 2026-10-01 12:00に受付したことにし、'2026-10-01'を当日、
 * '2026-10-02'を翌日、'2026-09-30'を過去日として扱う。
 */
var NOW = new Date('2026-10-01T12:00:00+09:00');

test('validateCreateBookingInput: customerTypeが未指定・未知の値はINVALID_CUSTOMER_TYPEでfail-closedに拒否する（Issue #270）', function () {
  var Booking = loadBooking();
  [undefined, null, '', 'member', 'FIRST_TIME', 'first-time', ' returning'].forEach(function (customerType) {
    var result = Booking.validateCreateBookingInput(validInput({ customerType: customerType, date: '2026-10-05' }), DEFAULT_CONFIG, NOW);
    assert.strictEqual(result.valid, false, JSON.stringify(customerType) + ' は拒否されるべき');
    assert.strictEqual(result.error.code, 'INVALID_CUSTOMER_TYPE');
  });
});

test('validateCreateBookingInput: 過去日はcustomerTypeを問わずINVALID_DATEで拒否する（当日判定はAsia/Tokyo基準）', function () {
  var Booking = loadBooking();
  ['first_time', 'returning'].forEach(function (customerType) {
    var result = Booking.validateCreateBookingInput(
      validInput({ customerType: customerType, date: '2026-09-30' }),
      DEFAULT_CONFIG,
      NOW
    );
    assert.strictEqual(result.valid, false, customerType);
    assert.strictEqual(result.error.code, 'INVALID_DATE');
  });
});

test('validateCreateBookingInput: 当日(2026-10-01) + 初回利用(first_time)はSAME_DAY_NOT_ALLOWED_FOR_FIRST_TIMEで拒否する（Issue #270最終仕様）', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(
    validInput({ customerType: 'first_time', date: '2026-10-01' }),
    DEFAULT_CONFIG,
    NOW
  );
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME');
});

test('validateCreateBookingInput: 当日(2026-10-01) + 利用経験あり(returning) + 現在時刻より後の開始時刻は通常どおり許可する', function () {
  var Booking = loadBooking();
  /* NOWはJST 12:00。開始時刻13:00は現在時刻より後のため許可されるべき。 */
  var result = Booking.validateCreateBookingInput(
    validInput({ customerType: 'returning', date: '2026-10-01', startTime: '13:00' }),
    DEFAULT_CONFIG,
    NOW
  );
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.normalized.customerType, 'returning');
});

test('validateCreateBookingInput: 翌日以降(2026-10-02)は初回利用/利用経験ありのどちらも許可する', function () {
  var Booking = loadBooking();
  ['first_time', 'returning'].forEach(function (customerType) {
    var result = Booking.validateCreateBookingInput(
      validInput({ customerType: customerType, date: '2026-10-02' }),
      DEFAULT_CONFIG,
      NOW
    );
    assert.strictEqual(result.valid, true, customerType);
  });
});

test('validateCreateBookingInput: 当日+初回利用の拒否ルールはsnb/mens/studio_xのいずれのbrandでも同じ（brandで分岐させない。Issue #270）', function () {
  var Booking = loadBooking();
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var blocked = Booking.validateCreateBookingInput(
      validInput({ brand: brand, customerType: 'first_time', date: '2026-10-01' }),
      DEFAULT_CONFIG,
      NOW
    );
    assert.strictEqual(blocked.valid, false, brand);
    assert.strictEqual(blocked.error.code, 'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME', brand);

    var allowed = Booking.validateCreateBookingInput(
      validInput({ brand: brand, customerType: 'returning', date: '2026-10-01', startTime: '13:00' }),
      DEFAULT_CONFIG,
      NOW
    );
    assert.strictEqual(allowed.valid, true, brand);
  });
});

test('validateCreateBookingInput: nowを省略した場合は現在時刻を使う（デフォルト引数）', function () {
  var Booking = loadBooking();
  var farFuture = new Date(Date.now() + 30 * 24 * 3600000).toISOString().slice(0, 10);
  var result = Booking.validateCreateBookingInput(validInput({ customerType: 'first_time', date: farFuture }), DEFAULT_CONFIG);
  assert.strictEqual(result.valid, true, '30日後は当日ではないため初回利用でも許可されるべき');
});

/*
 * 当日の過去開始時刻の拒否（Issue #270レビュー対応）。
 * NOW_1007はJST 2026-10-01 10:07に受付したことにする（レビューコメントの具体例に合わせる）。
 */
var NOW_1007 = new Date('2026-10-01T10:07:00+09:00');

test('validateCreateBookingInput: 当日+利用経験あり(returning)で、開始時刻が現在時刻以前（ちょうど含む）はSAME_DAY_START_TIME_PASSEDで拒否する', function () {
  var Booking = loadBooking();
  ['09:00', '10:00'].forEach(function (startTime) {
    var result = Booking.validateCreateBookingInput(
      validInput({ customerType: 'returning', date: '2026-10-01', startTime: startTime }),
      DEFAULT_CONFIG,
      NOW_1007
    );
    assert.strictEqual(result.valid, false, startTime + 'は10:07より前後なので拒否されるべき');
    assert.strictEqual(result.error.code, 'SAME_DAY_START_TIME_PASSED', startTime);
  });
});

test('validateCreateBookingInput: 当日+利用経験ありで、開始時刻が現在時刻より後なら他の入力が正常な限り許可する', function () {
  var Booking = loadBooking();
  ['10:15', '10:30'].forEach(function (startTime) {
    var result = Booking.validateCreateBookingInput(
      validInput({ customerType: 'returning', date: '2026-10-01', startTime: startTime }),
      DEFAULT_CONFIG,
      NOW_1007
    );
    assert.strictEqual(result.valid, true, startTime + 'は10:07より後なので許可されるべき');
  });
});

test('validateCreateBookingInput: 当日+初回利用は、開始時刻が現在時刻より後であってもSAME_DAY_NOT_ALLOWED_FOR_FIRST_TIMEが先に返る（優先順位の確認）', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(
    validInput({ customerType: 'first_time', date: '2026-10-01', startTime: '10:30' }),
    DEFAULT_CONFIG,
    NOW_1007
  );
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME');
});

test('validateCreateBookingInput: 翌日以降は現在時刻に関わらず開始時刻の過去判定を行わない（従来どおり）', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(
    validInput({ customerType: 'returning', date: '2026-10-02', startTime: '08:00' }),
    DEFAULT_CONFIG,
    NOW_1007
  );
  assert.strictEqual(result.valid, true, '翌日08:00は受付時刻(当日10:07)より前の時刻表記だが、日付が異なるため拒否されるべきではない');
});

test('validateCreateBookingInput: snb/mens/studio_xのいずれのbrandでも当日の過去開始時刻拒否は同じ挙動になる（brandで分岐させない）', function () {
  var Booking = loadBooking();
  ['snb', 'mens', 'studio_x'].forEach(function (brand) {
    var blocked = Booking.validateCreateBookingInput(
      validInput({ brand: brand, customerType: 'returning', date: '2026-10-01', startTime: '09:00' }),
      DEFAULT_CONFIG,
      NOW_1007
    );
    assert.strictEqual(blocked.valid, false, brand);
    assert.strictEqual(blocked.error.code, 'SAME_DAY_START_TIME_PASSED', brand);
  });
});

test('formatDateInTimezone: Asia/Tokyo基準の暦日を返し、不正なtimezoneはnullを返す（fail-closed）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.formatDateInTimezone(new Date('2026-10-01T15:30:00Z'), 'Asia/Tokyo'), '2026-10-02', 'UTC 15:30はJST翌日0:30');
  assert.strictEqual(Booking.formatDateInTimezone(new Date('2026-10-01T00:00:00Z'), 'Asia/Tokyo'), '2026-10-01', 'UTC 0:00はJST同日9:00');
  assert.strictEqual(Booking.formatDateInTimezone(new Date(), 'Not/A_Timezone'), null);
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
  assert.strictEqual(Booking.canTransition('PENDING', 'PENDING'), false);
});

/*
 * Issue #334: EXPIRED→CONFIRMED（手動復活）はALLOWED_TRANSITIONSの一般的な表としては
 * 許可されるようになったが、実際にこの遷移を実行できるのはBookingRepository.
 * reviveExpiredBookingのみ（既存confirmBookingは引き続き拒否する。
 * test/booking-confirm-expire.test.jsの
 * 「confirmBooking: CANCELLED/EXPIREDからの確定は不正な状態遷移として拒否する」で
 * confirmBooking側の拒否は別途検証している）。
 */
test('canTransition: EXPIREDからCONFIRMEDへの遷移は許可される（Issue #334の手動復活のため。実行できるのはreviveExpiredBookingのみ）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.canTransition('EXPIRED', 'CONFIRMED'), true);
  assert.strictEqual(Booking.canTransition('EXPIRED', 'CANCELLED'), false);
  assert.strictEqual(Booking.canTransition('EXPIRED', 'PENDING'), false);
  assert.strictEqual(Booking.canTransition('EXPIRED', 'EXPIRED'), false);
});

/*
 * Issue #341 PR-A: paymentStatus転用の状態設計。予約状態（STATUS）とは独立した
 * PAYMENT_STATUS/canTransitionPaymentStatus/normalizePaymentStatusを検証する。
 */
test('PAYMENT_STATUS: 6つの決済状態が公開されている（Issue #341）', function () {
  var Booking = loadBooking();
  /* Booking.PAYMENT_STATUSはvmサンドボックス（別realm）由来のオブジェクトのため、
     assert.deepStrictEqualではなくキー・値を個別に比較する（cross-realmな
     プレーンオブジェクトはプロトタイプが異なりdeepStrictEqualが失敗するため。
     test/booking-monthly-availability.test.jsのDAY_STATUS比較と同じ方針）。 */
  assert.deepStrictEqual(Object.keys(Booking.PAYMENT_STATUS).sort(), [
    'CHECKOUT_PENDING', 'FAILED', 'NOT_STARTED', 'PAID', 'REFUNDED', 'REFUND_PENDING'
  ]);
  assert.strictEqual(Booking.PAYMENT_STATUS.NOT_STARTED, 'not_started');
  assert.strictEqual(Booking.PAYMENT_STATUS.CHECKOUT_PENDING, 'checkout_pending');
  assert.strictEqual(Booking.PAYMENT_STATUS.PAID, 'paid');
  assert.strictEqual(Booking.PAYMENT_STATUS.REFUND_PENDING, 'refund_pending');
  assert.strictEqual(Booking.PAYMENT_STATUS.REFUNDED, 'refunded');
  assert.strictEqual(Booking.PAYMENT_STATUS.FAILED, 'failed');
});

test('canTransitionPaymentStatus: NOT_STARTED→CHECKOUT_PENDING→PAID→REFUND_PENDING→REFUNDEDの正常系が許可される（Issue #341）', function () {
  var Booking = loadBooking();
  var S = Booking.PAYMENT_STATUS;
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.NOT_STARTED, S.CHECKOUT_PENDING), true);
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.CHECKOUT_PENDING, S.PAID), true);
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.PAID, S.REFUND_PENDING), true);
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.REFUND_PENDING, S.REFUNDED), true);
});

test('canTransitionPaymentStatus: CHECKOUT_PENDING→FAILED、FAILEDからの再試行（→CHECKOUT_PENDING）が許可される（Issue #341）', function () {
  var Booking = loadBooking();
  var S = Booking.PAYMENT_STATUS;
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.CHECKOUT_PENDING, S.FAILED), true);
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.FAILED, S.CHECKOUT_PENDING), true);
});

test('canTransitionPaymentStatus: REFUNDEDは終端状態で、NOT_STARTEDからPAID/REFUNDEDへの直接遷移など不正な遷移は不可（Issue #341）', function () {
  var Booking = loadBooking();
  var S = Booking.PAYMENT_STATUS;
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.REFUNDED, S.NOT_STARTED), false);
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.REFUNDED, S.PAID), false);
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.NOT_STARTED, S.PAID), false, 'CHECKOUT_PENDINGを経由せずPAIDへは遷移できない');
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.NOT_STARTED, S.REFUNDED), false);
  assert.strictEqual(Booking.canTransitionPaymentStatus(S.PAID, S.FAILED), false, '決済成功後にFAILEDへ戻ることはない');
  assert.strictEqual(Booking.canTransitionPaymentStatus('unknown', S.CHECKOUT_PENDING), false, '未知の状態からの遷移表引きはfalseを返す（例外にしない）');
});

test('normalizePaymentStatus: 新定義の6値はそのまま通す（Issue #341）', function () {
  var Booking = loadBooking();
  Object.keys(Booking.PAYMENT_STATUS).forEach(function (key) {
    var value = Booking.PAYMENT_STATUS[key];
    assert.strictEqual(Booking.normalizePaymentStatus(value), value);
  });
});

test('normalizePaymentStatus: 空文字・未設定・旧unpaid・未知の値はすべてfail-closedにNOT_STARTEDへ正規化される（Issue #341）', function () {
  var Booking = loadBooking();
  [undefined, null, '', 'unpaid', 'UNPAID', 'garbage', 0].forEach(function (raw) {
    assert.strictEqual(
      Booking.normalizePaymentStatus(raw), Booking.PAYMENT_STATUS.NOT_STARTED,
      JSON.stringify(raw) + ' はNOT_STARTEDへ正規化されるべき'
    );
  });
});

test('normalizePaymentStatus: 旧paid（書き込まれた実績はないが念のため）はPAIDへ通す（Issue #341）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.normalizePaymentStatus('paid'), Booking.PAYMENT_STATUS.PAID);
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

/*
 * computeTtlExpiryMillis: minHoldHours（Issue #270レビュー対応で再設計）は
 * 「受付から少なくともminHoldHours時間は保持する」下限ではなく、通常TTL計算式
 * （min(受付+ttlHours, 開始-minHoursBeforeStart)）が受付時刻以前になってしまう
 * 直前当日予約にだけ使う最大猶予（grace）。利用開始時刻(startAtMillis)を必ず上限とし、
 * `expiry <= startAt` を保証する（当日PENDINGが利用開始後まで残らないようにするため）。
 * レビューコメント記載の最低限のTTLテストをそのまま反映する。
 */
test('computeTtlExpiryMillis: 09:00受付/09:30開始/minHoldHours=2 → expiry 09:30（開始時刻を上限とする）', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  var startAt = new Date('2026-10-01T09:30:00+09:00').getTime();
  var expiry = Booking.computeTtlExpiryMillis(createdAt, startAt, 24, 2, 2);
  assert.strictEqual(expiry, startAt);
});

test('computeTtlExpiryMillis: 09:00受付/10:30開始/minHoldHours=2 → expiry 10:30（開始時刻を上限とする）', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  var startAt = new Date('2026-10-01T10:30:00+09:00').getTime();
  var expiry = Booking.computeTtlExpiryMillis(createdAt, startAt, 24, 2, 2);
  assert.strictEqual(expiry, startAt);
});

test('computeTtlExpiryMillis: 09:00受付/11:30開始/minHoldHours=2 → 通常式(開始-2h=09:30)がそのまま使われる（graceは受付以前になる場合のみ）', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  var startAt = new Date('2026-10-01T11:30:00+09:00').getTime();
  var expiry = Booking.computeTtlExpiryMillis(createdAt, startAt, 24, 2, 2);
  assert.strictEqual(expiry, new Date('2026-10-01T09:30:00+09:00').getTime());
});

test('computeTtlExpiryMillis: 09:00受付/12:00開始/minHoldHours=2 → 通常式(開始-2h=10:00)がそのまま使われる', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  var startAt = new Date('2026-10-01T12:00:00+09:00').getTime();
  var expiry = Booking.computeTtlExpiryMillis(createdAt, startAt, 24, 2, 2);
  assert.strictEqual(expiry, new Date('2026-10-01T10:00:00+09:00').getTime());
});

test('computeTtlExpiryMillis: 翌日12:00開始/minHoldHours=0 → #268時点と同じ計算式（min(受付+ttlHours, 開始-minHoursBeforeStart)）', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  var startAt = new Date('2026-10-02T12:00:00+09:00').getTime();
  var expiry = Booking.computeTtlExpiryMillis(createdAt, startAt, 24, 2, 0);
  assert.strictEqual(expiry, Math.min(createdAt + 24 * 3600000, startAt - 2 * 3600000));
});

test('computeTtlExpiryMillis: ttlHours=1/09:00受付/12:00開始/minHoldHours=2 → 10:00(受付+1h)を超えない', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  var startAt = new Date('2026-10-01T12:00:00+09:00').getTime();
  var expiry = Booking.computeTtlExpiryMillis(createdAt, startAt, 1, 2, 2);
  assert.strictEqual(expiry, createdAt + 1 * 3600000);
  assert.ok(expiry <= createdAt + 1 * 3600000);
});

test('computeTtlExpiryMillis: 当日直前予約のすべてのケースでexpiry <= startAtが成り立つ（利用開始後までPENDINGが残らない）', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  [15, 30, 60, 90, 119, 120, 121, 180].forEach(function (minutesUntilStart) {
    var startAt = createdAt + minutesUntilStart * 60000;
    var expiry = Booking.computeTtlExpiryMillis(createdAt, startAt, 24, 2, 2);
    assert.ok(expiry <= startAt, minutesUntilStart + '分後開始: expiry(' + expiry + ') <= startAt(' + startAt + ')であるべき');
    assert.ok(expiry > createdAt, minutesUntilStart + '分後開始: expiry(' + expiry + ') > createdAt(' + createdAt + ')であるべき（作成直後に即失効しない）');
  });
});

test('computeTtlExpiryMillis: minHoldHoursを渡しても、開始まで十分な余裕がある通常の予約は#268時点と同じ結果になる（翌日以降の既存TTLへの影響なし）', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  var farStart = new Date('2026-10-04T09:00:00+09:00').getTime();

  var withoutMinHold = Booking.computeTtlExpiryMillis(createdAt, farStart, 24, 2);
  var withMinHold = Booking.computeTtlExpiryMillis(createdAt, farStart, 24, 2, 2);
  assert.strictEqual(withMinHold, withoutMinHold, '開始まで余裕がある場合はminHoldHoursの有無で結果が変わらないべき');
  assert.strictEqual(withMinHold, createdAt + 24 * 3600000);
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

test('isAllowedCustomerType/getCustomerTypeLabel: first_time/returningのみ許可し、Sheets/管理者表示用のラベルを返す（Issue #270）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isAllowedCustomerType('first_time'), true);
  assert.strictEqual(Booking.isAllowedCustomerType('returning'), true);
  assert.strictEqual(Booking.isAllowedCustomerType('member'), false);
  assert.strictEqual(Booking.isAllowedCustomerType(''), false);
  assert.strictEqual(Booking.isAllowedCustomerType(undefined), false);

  assert.strictEqual(Booking.getCustomerTypeLabel('first_time'), '初回利用');
  assert.strictEqual(Booking.getCustomerTypeLabel('returning'), '利用経験あり');

  assert.deepEqual(Booking.CUSTOMER_TYPES, { FIRST_TIME: 'first_time', RETURNING: 'returning' });
});

/*
 * ---------- Issue #334: カード決済の96時間ルール・カード専用TTL定数 ----------
 * NOW_CARD = JST 2026-10-01 12:00固定。96時間後はJST 2026-10-05 12:00ちょうど。
 */
var NOW_CARD = new Date('2026-10-01T12:00:00+09:00');

test('Booking定数: PAYMENT_METHOD_CARD/CARD_TTL_HOURS/CARD_MIN_HOURS_BEFORE_STARTが公開されている（Issue #334）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.PAYMENT_METHOD_CARD, 'オンラインクレジットカード');
  assert.strictEqual(Booking.CARD_TTL_HOURS, 72);
  assert.strictEqual(Booking.CARD_MIN_HOURS_BEFORE_START, 96);
});

test('isCardPaymentMethod: カード決済の文字列のみtrue。前後空白はtrim、他の支払方法・空値はfalse（Issue #334）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isCardPaymentMethod('オンラインクレジットカード'), true);
  assert.strictEqual(Booking.isCardPaymentMethod(' オンラインクレジットカード '), true);
  assert.strictEqual(Booking.isCardPaymentMethod('現金'), false);
  assert.strictEqual(Booking.isCardPaymentMethod('PayPay'), false);
  assert.strictEqual(Booking.isCardPaymentMethod('未定'), false);
  assert.strictEqual(Booking.isCardPaymentMethod(''), false);
  assert.strictEqual(Booking.isCardPaymentMethod(undefined), false);
  assert.strictEqual(Booking.isCardPaymentMethod(null), false);
});

test('validateCreateBookingInput: カード決済×利用開始ちょうど96時間前は許可される（境界。Issue #334）', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(
    validInput({ paymentMethod: 'オンラインクレジットカード', date: '2026-10-05', startTime: '12:00' }),
    DEFAULT_CONFIG,
    NOW_CARD
  );
  assert.strictEqual(result.valid, true, JSON.stringify(result.error));
  assert.strictEqual(result.normalized.paymentMethod, 'オンラインクレジットカード');
});

test('validateCreateBookingInput: カード決済×利用開始96時間前を1分でも切ると拒否される（境界。Issue #334）', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(
    validInput({ paymentMethod: 'オンラインクレジットカード', date: '2026-10-05', startTime: '11:45' }),
    DEFAULT_CONFIG,
    NOW_CARD
  );
  assert.strictEqual(result.valid, false);
  assert.strictEqual(result.error.code, 'CARD_PAYMENT_TOO_CLOSE_TO_START');
});

test('validateCreateBookingInput: カード決済×利用開始96時間前を1分でも超えれば許可される（境界。Issue #334）', function () {
  var Booking = loadBooking();
  var result = Booking.validateCreateBookingInput(
    validInput({ paymentMethod: 'オンラインクレジットカード', date: '2026-10-05', startTime: '12:15' }),
    DEFAULT_CONFIG,
    NOW_CARD
  );
  assert.strictEqual(result.valid, true, JSON.stringify(result.error));
});

test('validateCreateBookingInput: カード決済×利用開始まで97時間・95時間の境界外テスト（Issue #334受入条件）', function () {
  var Booking = loadBooking();
  /* 97時間後（2026-10-05 13:00）は許可される */
  var allowed = Booking.validateCreateBookingInput(
    validInput({ paymentMethod: 'オンラインクレジットカード', date: '2026-10-05', startTime: '13:00' }),
    DEFAULT_CONFIG,
    NOW_CARD
  );
  assert.strictEqual(allowed.valid, true, JSON.stringify(allowed.error));

  /* 95時間後（2026-10-05 11:00）は拒否される */
  var rejected = Booking.validateCreateBookingInput(
    validInput({ paymentMethod: 'オンラインクレジットカード', date: '2026-10-05', startTime: '11:00' }),
    DEFAULT_CONFIG,
    NOW_CARD
  );
  assert.strictEqual(rejected.valid, false);
  assert.strictEqual(rejected.error.code, 'CARD_PAYMENT_TOO_CLOSE_TO_START');
});

/*
 * PRレビュー対応（Issue #334 PR-B #336）: 以前の実装は「今日からの暦日差×1440分＋
 * 分単位に丸めたstartMinutes/現在時刻」という分単位の中間表現で96時間ルールを判定して
 * いたため、96時間ちょうど付近の秒・ミリ秒単位の境界でフロント側
 * （scripts/booking-logic.jsのisCardPaymentEligible。ミリ秒精度）とずれうる不具合が
 * あった。ここではinput.startTime（'HH:mm'。秒は表現できない）を固定し、receivedAt
 * （now引数）側をミリ秒単位でずらすことで、96時間ちょうど・1秒前・1秒後・1ミリ秒未満の
 * 境界をBookingAvailability.zonedDateTimeToUtcMillis経由のミリ秒比較で検証する。
 */
test('validateCreateBookingInput: カード決済×96時間の境界をミリ秒単位で判定する（96時間ちょうど／1秒前／1秒後／1ミリ秒未満。PRレビュー対応）', function () {
  var Booking = loadBooking();
  var input = validInput({ paymentMethod: 'オンラインクレジットカード', date: '2026-10-05', startTime: '12:00' });
  var startAtMillis = new Date('2026-10-05T12:00:00+09:00').getTime();
  var exactly96hBeforeMillis = startAtMillis - 96 * 3600000;

  var exactly96h = Booking.validateCreateBookingInput(input, DEFAULT_CONFIG, new Date(exactly96hBeforeMillis));
  assert.strictEqual(exactly96h.valid, true, '96時間ちょうどは許可される（境界を含む）: ' + JSON.stringify(exactly96h.error));

  var oneSecondOfExtraMargin = Booking.validateCreateBookingInput(
    input, DEFAULT_CONFIG, new Date(exactly96hBeforeMillis - 1000)
  );
  assert.strictEqual(oneSecondOfExtraMargin.valid, true, '96時間より1秒余裕がある（96時間+1秒前）は許可される');

  var oneSecondShort = Booking.validateCreateBookingInput(
    input, DEFAULT_CONFIG, new Date(exactly96hBeforeMillis + 1000)
  );
  assert.strictEqual(oneSecondShort.valid, false, '96時間に1秒足りない（96時間-1秒前）は拒否される');
  assert.strictEqual(oneSecondShort.error.code, 'CARD_PAYMENT_TOO_CLOSE_TO_START');

  var oneMillisecondShort = Booking.validateCreateBookingInput(
    input, DEFAULT_CONFIG, new Date(exactly96hBeforeMillis + 1)
  );
  assert.strictEqual(oneMillisecondShort.valid, false, '96時間に1ミリ秒足りない場合も拒否される');
  assert.strictEqual(oneMillisecondShort.error.code, 'CARD_PAYMENT_TOO_CLOSE_TO_START');

  var oneMillisecondOfExtraMargin = Booking.validateCreateBookingInput(
    input, DEFAULT_CONFIG, new Date(exactly96hBeforeMillis - 1)
  );
  assert.strictEqual(oneMillisecondOfExtraMargin.valid, true, '96時間より1ミリ秒でも余裕があれば許可される');
});

test('validateCreateBookingInput: 現金/PayPay/未定は96時間ルールの対象外（直前でも通常どおり許可される。Issue #334の回帰要件）', function () {
  var Booking = loadBooking();
  ['現金', 'PayPay', '未定'].forEach(function (paymentMethod) {
    var result = Booking.validateCreateBookingInput(
      /* 開始まで15分後（96時間はおろか2時間の下限にも満たない極端な直前値）。
         96時間ルールがカード以外へ誤って波及していないことを確認する。 */
      validInput({ paymentMethod: paymentMethod, customerType: 'returning', date: '2026-10-01', startTime: '12:15' }),
      DEFAULT_CONFIG,
      NOW_CARD
    );
    assert.strictEqual(result.valid, true, paymentMethod + ': ' + JSON.stringify(result.error));
  });
});

test('computeCardPaymentDueMillis: computeTtlExpiryMillisをCARD_TTL_HOURS(72)固定・minHoldHours=0で呼び出した結果と一致する（Issue #334）', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  var startAt = new Date('2026-10-10T09:00:00+09:00').getTime();

  var due = Booking.computeCardPaymentDueMillis(createdAt, startAt, 2);
  var expected = Booking.computeTtlExpiryMillis(createdAt, startAt, 72, 2, 0);
  assert.strictEqual(due, expected);
  assert.strictEqual(due, createdAt + 72 * 3600000);
});

test('computeCardPaymentDueMillis: 「利用開始のminHoursBeforeStart時間前を超えない」上限は維持される（Issue #334）', function () {
  var Booking = loadBooking();
  var createdAt = new Date('2026-10-01T09:00:00+09:00').getTime();
  /* 開始が受付+72hより前（受付+10h後）の極端なケース。上限(開始-2h)が72h側より先に来る。 */
  var startAt = createdAt + 10 * 3600000;
  var due = Booking.computeCardPaymentDueMillis(createdAt, startAt, 2);
  assert.strictEqual(due, startAt - 2 * 3600000);
  assert.ok(due <= startAt);
});

/* ---------- isValidStripePaymentLinkUrl（Issue #334 PR-C） ---------- */

test('isValidStripePaymentLinkUrl: buy.stripe.com配下の英数字・アンダースコア・ハイフンのみのパスは許可する', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com/test_a1B2c3'), true);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com/a-b_c-D9'), true);
});

test('isValidStripePaymentLinkUrl: http（httpsでない）は拒否する', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('http://buy.stripe.com/test_a1B2c3'), false);
});

test('isValidStripePaymentLinkUrl: buy.stripe.com以外のホスト（他ドメイン・サブドメイン偽装含む）は拒否する', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://stripe.com/test_a1B2c3'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com.evil.example/test_a1B2c3'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://evil.example/buy.stripe.com/test_a1B2c3'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://notbuy.stripe.com/test_a1B2c3'), false);
});

test('isValidStripePaymentLinkUrl: userinfo・ポート指定は拒否する（ホスト部分の偽装対策）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://user@buy.stripe.com/test_a1B2c3'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com:443/test_a1B2c3'), false);
});

test('isValidStripePaymentLinkUrl: クエリ・フラグメント・末尾スラッシュ・パス無しは拒否する', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com/test_a1B2c3?foo=bar'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com/test_a1B2c3#section'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com/test_a1B2c3/'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com/'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com'), false);
});

test('isValidStripePaymentLinkUrl: 前後に空白を含む・空文字・非文字列は拒否する（fail-closed。emailと同じ方針でtrimしてから緩く検証しない）', function () {
  var Booking = loadBooking();
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl(' https://buy.stripe.com/test_a1B2c3'), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl('https://buy.stripe.com/test_a1B2c3 '), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl(''), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl(null), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl(undefined), false);
  assert.strictEqual(Booking.isValidStripePaymentLinkUrl(123), false);
});
