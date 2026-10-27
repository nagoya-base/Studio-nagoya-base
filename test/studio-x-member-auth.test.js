/*
 * Studio X 正式V2（共通OTP・認証フェーズ）のテスト（Issue #563）。Stripe・Sheets・Calendar・MailAppはすべてスタブで、本番へは一切アクセスしない。
 *
 * - 認証フェーズ（STUDIO_X_BOOKING_AUTH_PHASE）: 既定LEGACY（台帳照合・本番OFF）。TEST（資格付きのみOTP）。OTP（全員OTP）。不正値はLEGACY。
 * - 料金世代と認証フェーズの分離: 切替・切戻しでV2料金・オプション価格・既存予約の料金は不変。SNB / mensの緊急停止・モード・12/1は無関係。
 * - 予約期間: 一般30日・OTP認証済み会員90日（31日目・90日目・91日目・JST日付跨ぎ・OTP失効・他メールの証明・直接API）。
 * - 既存予約（切替前に作成）への後付けオプション: 切替後も旧台帳照合のまま。OTPフェーズで作成した予約はOTP確認済みだけ。
 * - ブランド分離: OTPメール・エラー文言にSNB MEMBERを出さない。SNB / mensは従来どおり。
 * - テストモード: 資格はメール・許可リストに拘束。12/1に縛られない。資格・OTPをログ・予約へ残さない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var proofHelper = require('./helpers/booking-member-proof');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs',
  'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'EquipmentCatalog.gs',
  'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs',
  'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs', 'BookingMailTemplates.gs',
  'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs', 'BookingRepository.gs', 'AdminNotifier.gs',
  'BookingAdminAlerts.gs', 'MembershipService.gs', 'BookingMemberVerification.gs', 'BookingTestCredential.gs', 'Code.gs'
];

var PHASE = 'STUDIO_X_BOOKING_AUTH_PHASE';
var KEY = 'unit-test-signing-key-0123456789abcdef-not-a-secret';
var SPREADSHEET_ID = 'ss1';
var MEMBER = 'member@example.com';
var STRANGER = 'stranger@example.com';
var TESTER = 'tester@example.com';

/* Studio Xの料金世代V2は2026/10/26 0:00 JSTから。SNB / mensのV2（12/1）より前。 */
var NOW = new Date('2026-11-10T12:00:00+09:00');
var AFTER_DEC1 = new Date('2026-12-05T12:00:00+09:00');
/* NOWから30日後=12/10（一般の最終日）、31日後=12/11（先行予約の初日）、90日後=2027-02-08、91日後=2027-02-09。 */
var DAY30 = '2026-12-10';
var DAY31 = '2026-12-11';
var DAY90 = '2027-02-08';
var DAY91 = '2027-02-09';

function plain(v) { return JSON.parse(JSON.stringify(v)); }

function setup(opts) {
  var o = opts || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = Object.assign({
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID,
    BOOKING_MAIL_DISPLAY_NAME: 'Studio X', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    ADMIN_NOTIFICATION_EMAIL: 'admin-notify@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000',
    BOOKING_TEST_CREDENTIAL_KEY: KEY, BOOKING_TEST_ALLOWED_EMAILS: TESTER
  }, o.properties || {});
  var propertiesService = stubs.createPropertiesServiceStub(properties);
  var mailApp = stubs.createMailAppStub(o.mail);
  var logger = stubs.createLoggerStub();
  var clock = stubs.createControllableClock(o.now || NOW);
  var globals = {
    PropertiesService: propertiesService,
    CalendarApp: stubs.createCalendarAppStub({ cal1: { events: [] } }),
    Utilities: stubs.createUtilitiesStub(), LockService: stubs.createLockServiceStub(),
    CacheService: stubs.createCacheServiceStub(),
    SpreadsheetApp: stubs.createSpreadsheetAppStub(spreadsheetsById),
    MailApp: mailApp, UrlFetchApp: stubs.createUrlFetchAppStub(function () { throw new Error('Stripeは呼ばない'); }),
    Logger: logger, ContentService: stubs.createContentServiceStub(), Date: clock.Date
  };
  var sandbox = loadBookingSandbox(FILES, globals);
  var ctx = { sandbox: sandbox, mailApp: mailApp, logger: logger, clock: clock, sheets: spreadsheetsById[SPREADSHEET_ID], members: o.members || {}, lookups: [], proofCache: {} };
  sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    ctx.lookups.push({ email: email, date: date });
    return (ctx.members[String(email).toLowerCase()] || []).indexOf(String(date).substring(0, 7)) !== -1;
  };
  ctx.setProperty = function (name, value) {
    if (value === undefined) propertiesService.getScriptProperties().deleteProperty(name);
    else propertiesService.getScriptProperties().setProperty(name, value);
  };
  ctx.setNow = function (date) { clock.advanceByMillis(date.getTime() - clock.currentDate().getTime()); };
  return ctx;
}

function payload(overrides) {
  return Object.assign({
    brand: 'studio_x', customerType: 'returning', date: DAY30, startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: MEMBER, phone: '090-1234-5678', people: '2名', purpose: '撮影',
    paymentMethod: '現金', note: '', source: 'test', isMember: false
  }, overrides || {});
}

/* 同じメール・日付・開始時刻の連投は重複送信として拒否され、同じ時間帯は埋まるため、予約のたびに(日付ごとに)開始時刻をずらす。 */
var START_SLOTS = ['09:00', '12:00', '15:00', '18:00'];

function book(ctx, overrides, now) {
  var body = Object.assign({}, overrides || {});
  var date = body.date || DAY30;
  ctx.slotCounters = ctx.slotCounters || {};
  var n = ctx.slotCounters[date] || 0;
  ctx.slotCounters[date] = n + 1;
  assert.ok(n < START_SLOTS.length, 'テスト用の開始時刻を使い切りました: ' + date);
  body.startTime = START_SLOTS[n];
  body.durationMinutes = 120;
  var result = plain(ctx.sandbox.BookingRepository.createBooking(payload(body), now || ctx.clock.currentDate()));
  if (process.env.DBG && !result.success) console.log('BOOKFAIL', JSON.stringify(body), JSON.stringify(result.error));
  return result;
}

function proof(ctx, email, now) {
  return proofHelper.proofFor(ctx.proofCache, ctx.sandbox, ctx.mailApp, email, now || ctx.clock.currentDate());
}

function record(ctx, bookingId) {
  return ctx.sandbox.SpreadsheetRepository.findRowByBookingId(bookingId).record;
}

function post(ctx, action, body) {
  var out = ctx.sandbox.doPost({ parameter: { action: action }, postData: { contents: JSON.stringify(body) } });
  return JSON.parse(out.text);
}

function get(ctx, params) {
  return JSON.parse(ctx.sandbox.doGet({ parameter: params }).text);
}

function noSnbMember(value) {
  assert.ok(!/SNB MEMBER/.test(typeof value === 'string' ? value : JSON.stringify(value)), 'Studio Xの応答にSNB MEMBERを出さない: ' + JSON.stringify(value));
}

// ============================================================================
// 認証フェーズの既定・不正値・料金世代との分離
// ============================================================================

test('既定（未設定）はLEGACY: OTPを要求せず、31〜90日先は会員台帳で最終判定する（現状維持）。予約はNOT_CHECKEDで記録される', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12', '2027-01', '2027-02', '2026-11'] } });
  assert.strictEqual(ctx.sandbox.StudioXMemberAuth.configuredPhase(), 'LEGACY');
  var general = book(ctx, { date: DAY30, email: STRANGER });
  assert.strictEqual(general.success, true);
  assert.strictEqual(record(ctx, general.bookingId).membershipStatus, 'NOT_CHECKED');
  assert.strictEqual(record(ctx, general.bookingId).priceGeneration, 'V2');

  var advance = book(ctx, { date: DAY31, email: MEMBER, startTime: '13:00' });
  assert.strictEqual(advance.success, true, 'OTPなしで台帳照合の会員は31日先を予約できる（現状維持）');
  assert.strictEqual(record(ctx, advance.bookingId).membershipStatus, 'NOT_CHECKED');

  var stranger = book(ctx, { date: DAY31, email: STRANGER, startTime: '16:00' });
  assert.strictEqual(stranger.success, false);
  assert.strictEqual(stranger.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
  noSnbMember(stranger.error.message);
});

test('不正値・小文字・前後空白・SNB用の値はすべてLEGACY（安全側。OTPを誤って有効化しない）', function () {
  var ctx = setup();
  ['', 'otp', ' OTP', 'OTP ', 'ENABLED', 'true', 'LIVE', 'V2', 'test', 'Test'].forEach(function (value) {
    ctx.setProperty(PHASE, value);
    assert.strictEqual(ctx.sandbox.StudioXMemberAuth.configuredPhase(), 'LEGACY', JSON.stringify(value));
    var d = plain(ctx.sandbox.BookingGenerationMode.decide(NOW, 'studio_x'));
    assert.strictEqual(d.memberAuthRequired, false);
  });
  ctx.setProperty(PHASE, 'OTP');
  assert.strictEqual(ctx.sandbox.StudioXMemberAuth.configuredPhase(), 'OTP');
  ctx.setProperty(PHASE, 'TEST');
  assert.strictEqual(ctx.sandbox.StudioXMemberAuth.configuredPhase(), 'TEST');
});

test('料金世代は認証フェーズから独立: LEGACY / OTP のどちらでもStudio XはV2（2026/10/26）。V1の日は認証を要求しない', function () {
  var ctx = setup();
  ['LEGACY', 'OTP'].forEach(function (phase) {
    ctx.setProperty(PHASE, phase);
    var d = plain(ctx.sandbox.BookingGenerationMode.decide(NOW, 'studio_x'));
    assert.strictEqual(d.generation, 'V2');
    assert.strictEqual(d.source, 'TIME');
  });
  ctx.setProperty(PHASE, 'OTP');
  var beforeV2 = plain(ctx.sandbox.BookingGenerationMode.decide(new Date('2026-10-25T23:59:59+09:00'), 'studio_x'));
  assert.strictEqual(beforeV2.generation, 'V1');
  assert.strictEqual(beforeV2.memberAuthRequired, false, '料金世代がV1の予約には認証フェーズを適用しない');
});

test('SNB / mensの設定（緊急停止・BOOKING_AUTH_MODE・12/1）はStudio Xの料金・認証へ波及しない。逆も同じ', function () {
  var ctx = setup({ properties: { BOOKING_AUTH_EMERGENCY_LEGACY: 'ENABLED', BOOKING_AUTH_MODE: 'LEGACY' } });
  ctx.setProperty(PHASE, 'OTP');
  var studioX = plain(ctx.sandbox.BookingGenerationMode.decide(NOW, 'studio_x'));
  assert.strictEqual(studioX.generation, 'V2', 'SNB / mensの緊急停止でStudio XのV2料金は戻らない');
  assert.strictEqual(studioX.memberAuthRequired, true, 'SNB / mensの緊急停止でStudio XのOTPは止まらない');
  assert.strictEqual(studioX.source, 'TIME');
  /* 逆: Studio XをOTPにしても、SNB / mensは12/1前はV1のまま・OTP不要。 */
  var snb = plain(ctx.sandbox.BookingGenerationMode.decide(NOW, 'snb'));
  assert.strictEqual(snb.generation, 'V1');
  assert.strictEqual(snb.memberAuthRequired, undefined);
  assert.strictEqual(plain(ctx.sandbox.BookingGenerationMode.decide(NOW, 'mens')).generation, 'V1');
  /* 監査表示にStudio Xの認証フェーズが出る（機密は含まない）。 */
  var status = plain(ctx.sandbox.BookingGenerationMode.describe(NOW));
  assert.strictEqual(status.studioXAuthPhase, 'OTP');
  assert.strictEqual(status.generalUser.studio_x, 'V2');
});

// ============================================================================
// OTPフェーズ: 予約期間・OTP失効・直接API
// ============================================================================

function otpSetup(extra) {
  var ctx = setup(Object.assign({ members: { [MEMBER]: ['2026-11', '2026-12', '2027-01', '2027-02'] } }, extra || {}));
  ctx.setProperty(PHASE, 'OTP');
  return ctx;
}

test('OTP: 一般は30日先まで（OTPなし）。31日目はOTPなしでは会員でも拒否（確認要求。台帳は参照しない）。91日目は認証済み会員でも範囲外', function () {
  var ctx = otpSetup();
  var day30 = book(ctx, { date: DAY30, email: STRANGER });
  assert.strictEqual(day30.success, true, '一般の30日目はOTPなしで予約できる');
  assert.strictEqual(record(ctx, day30.bookingId).membershipStatus, 'UNVERIFIED', 'OTPなしの予約はUNVERIFIEDで記録（NOT_CHECKEDにしない）');

  ctx.lookups.length = 0;
  var noProof = book(ctx, { date: DAY31, email: MEMBER, startTime: '13:00' });
  assert.strictEqual(noProof.success, false);
  assert.strictEqual(noProof.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  noSnbMember(noProof.error.message);
  assert.strictEqual(ctx.lookups.length, 0, 'OTP証明なしでは会員台帳を参照しない（会員の有無を探れない）');

  var p = proof(ctx, MEMBER);
  var day31 = book(ctx, { date: DAY31, email: MEMBER, memberProof: p, startTime: '13:00' });
  assert.strictEqual(day31.success, true, '認証済み会員の31日目');
  assert.strictEqual(record(ctx, day31.bookingId).membershipStatus, 'ACTIVE');
  var day90 = book(ctx, { date: DAY90, email: MEMBER, memberProof: p, startTime: '16:00' });
  assert.strictEqual(day90.success, true, '認証済み会員の90日目');
  var day91 = book(ctx, { date: DAY91, email: MEMBER, memberProof: p });
  assert.strictEqual(day91.success, false);
  assert.strictEqual(day91.error.code, 'DATE_OUT_OF_RANGE');
});

test('OTP: 認証済みでも非会員は31日目以降を予約できない（ADVANCE_BOOKING_MEMBER_ONLY・Studio X文言）。他人のメールの証明は使えない', function () {
  var ctx = otpSetup();
  var strangerProof = proof(ctx, STRANGER);
  var denied = book(ctx, { date: DAY31, email: STRANGER, memberProof: strangerProof });
  assert.strictEqual(denied.success, false);
  assert.strictEqual(denied.error.code, 'ADVANCE_BOOKING_MEMBER_ONLY');
  noSnbMember(denied.error.message);
  assert.ok(/会員限定/.test(denied.error.message));

  /* 他人（STRANGER）の証明を、会員のメールで使う → 再確認要求。会員料金・先行予約を黙って通さない。 */
  var wrongEmail = book(ctx, { date: DAY31, email: MEMBER, memberProof: strangerProof });
  assert.strictEqual(wrongEmail.success, false);
  assert.strictEqual(wrongEmail.error.code, 'MEMBER_REVERIFY_REQUIRED');
  noSnbMember(wrongEmail.error.message);
});

test('OTP: 直接APIで isMember=true・会員自己申告・でたらめな証明を送っても31日目は通らない', function () {
  var ctx = otpSetup();
  assert.strictEqual(book(ctx, { date: DAY31, email: MEMBER, isMember: true }).error.code, 'MEMBER_VERIFICATION_REQUIRED');
  var forged = book(ctx, { date: DAY31, email: MEMBER, memberProof: 'a'.repeat(64) });
  assert.strictEqual(forged.success, false);
  assert.strictEqual(forged.error.code, 'MEMBER_REVERIFY_REQUIRED');
  assert.strictEqual(book(ctx, { date: DAY31, email: MEMBER, memberProof: 'x' }).error.code, 'MEMBER_REVERIFY_REQUIRED');
});

test('OTP: 証明が失効（60分）したら黙って一般扱いにせず再確認を要求。再認証すれば予約できる', function () {
  var ctx = otpSetup();
  var p = proof(ctx, MEMBER);
  ctx.setNow(new Date(NOW.getTime() + 59 * 60000));
  assert.strictEqual(book(ctx, { date: DAY31, email: MEMBER, memberProof: p }).success, true, '59分後はまだ有効');
  ctx.setNow(new Date(NOW.getTime() + 61 * 60000));
  var expired = book(ctx, { date: DAY31, email: MEMBER, memberProof: p, startTime: '13:00' });
  assert.strictEqual(expired.success, false);
  assert.strictEqual(expired.error.code, 'MEMBER_REVERIFY_REQUIRED');
  var again = proof(ctx, MEMBER);
  assert.notStrictEqual(again, p, '再認証で新しい証明');
  assert.strictEqual(book(ctx, { date: DAY31, email: MEMBER, memberProof: again, startTime: '13:00' }).success, true);
});

test('OTP: JSTの日付跨ぎ。23:59:59 JSTでは31日目は翌日扱いにならず、0:00 JSTからは前日の31日目が30日目になる', function () {
  var ctx = otpSetup();
  var p = proof(ctx, MEMBER, new Date('2026-11-10T23:00:00+09:00'));
  /* 2026-11-10 23:59:59 JST: 12/10は30日先（一般）、12/11は31日先（会員のみ）。 */
  var late = new Date('2026-11-10T23:59:59+09:00');
  ctx.setNow(late);
  assert.strictEqual(book(ctx, { date: DAY30, email: STRANGER }, late).success, true);
  assert.strictEqual(book(ctx, { date: DAY31, email: STRANGER, startTime: '13:00' }, late).error.code, 'MEMBER_VERIFICATION_REQUIRED');
  /* 2026-11-11 00:00:00 JST: 12/11が30日先になり、一般でも予約できる。12/12が31日先。 */
  var midnight = new Date('2026-11-11T00:00:00+09:00');
  ctx.setNow(midnight);
  assert.strictEqual(book(ctx, { date: DAY31, email: STRANGER, startTime: '13:00' }, midnight).success, true);
  assert.strictEqual(book(ctx, { date: '2026-12-12', email: STRANGER, startTime: '16:00' }, midnight).error.code, 'MEMBER_VERIFICATION_REQUIRED');
  assert.ok(p);
});

test('OTP: 料金・V2世代はLEGACYと同じ（認証フェーズで料金が変わらない）。会員かどうかでもStudio Xの料金は変わらない', function () {
  var legacy = setup({ members: { [MEMBER]: ['2026-12'] } });
  var legacyBooking = book(legacy, { date: DAY30, email: MEMBER });
  var otp = otpSetup();
  var otpBooking = book(otp, { date: DAY30, email: MEMBER, memberProof: proof(otp, MEMBER) });
  var strangerBooking = book(otp, { date: DAY30, email: STRANGER, startTime: '14:00' });
  assert.strictEqual(legacyBooking.success && otpBooking.success && strangerBooking.success, true);
  assert.deepStrictEqual(otpBooking.price, legacyBooking.price);
  assert.deepStrictEqual(strangerBooking.price, legacyBooking.price);
  assert.strictEqual(otpBooking.price.isMember, false);
  assert.strictEqual(record(otp, otpBooking.bookingId).priceGeneration, 'V2');
});

test('OTPフェーズの予約は membershipStatus が必ず ACTIVE / INACTIVE / UNVERIFIED のいずれか（NOT_CHECKEDにならない）', function () {
  var ctx = otpSetup();
  var active = book(ctx, { date: DAY30, email: MEMBER, memberProof: proof(ctx, MEMBER) });
  var inactive = book(ctx, { date: DAY30, email: STRANGER, memberProof: proof(ctx, STRANGER), startTime: '14:00' });
  var unverified = book(ctx, { date: DAY30, email: 'x@example.com', startTime: '17:00' });
  assert.strictEqual(record(ctx, active.bookingId).membershipStatus, 'ACTIVE');
  assert.strictEqual(record(ctx, inactive.bookingId).membershipStatus, 'INACTIVE');
  assert.strictEqual(record(ctx, unverified.bookingId).membershipStatus, 'UNVERIFIED');
});

test('管理者の新規予約（ADMIN window）はOTP対象外。OTPフェーズでも従来どおり31日先を作成でき、NOT_CHECKEDで記録される（旧台帳照合の扱い）', function () {
  var ctx = otpSetup();
  var body = payload({ date: DAY31, email: STRANGER, startTime: '09:00', durationMinutes: 120 });
  var admin = plain(ctx.sandbox.BookingRepository.createBooking(body, ctx.clock.currentDate(), undefined, ctx.sandbox.BookingWindow.TIER.ADMIN));
  assert.strictEqual(admin.success, true, JSON.stringify(admin));
  assert.strictEqual(record(ctx, admin.bookingId).membershipStatus, 'NOT_CHECKED');
});

// ============================================================================
// 切替前に作成した予約への後付けオプション（ADDON）互換
// ============================================================================

var STAFF_ADDON = { layouts: ['JAPANESE'], setupService: 'STAFF', cleanupService: 'SELF' };

function addon(ctx, bookingId, email) {
  return plain(ctx.sandbox.OptionOrderService.submitAddonOptions(bookingId, email, STAFF_ADDON));
}

test('ADDON互換: 切替前（LEGACY）に作成した予約は、正式V2（OTP）切替後も旧台帳照合で後付けできる。非会員は拒否。V2料金世代だけでOTPを要求しない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-11', '2026-12'] } });
  var member = book(ctx, { date: DAY30, email: MEMBER });
  var stranger = book(ctx, { date: DAY30, email: STRANGER, startTime: '14:00' });
  assert.strictEqual(record(ctx, member.bookingId).membershipStatus, 'NOT_CHECKED');
  assert.strictEqual(record(ctx, member.bookingId).priceGeneration, 'V2');

  ctx.setProperty(PHASE, 'OTP');
  var memberAddon = addon(ctx, member.bookingId, MEMBER);
  assert.strictEqual(memberAddon.success, true, '切替前の既存会員予約は、切替後もOTPなしで後付けできる: ' + JSON.stringify(memberAddon));
  var strangerAddon = addon(ctx, stranger.bookingId, STRANGER);
  assert.strictEqual(strangerAddon.success, false, '非会員は既存ルールどおり拒否');
  noSnbMember(strangerAddon.error);
});

test('ADDON互換: 切替前の予約でも会員台帳は必ず確認する（認証を無条件に免除しない）。NOT_CHECKEDだけで拒否もしない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] } });
  var booking = book(ctx, { date: DAY30, email: MEMBER });
  ctx.setProperty(PHASE, 'OTP');
  ctx.lookups.length = 0;
  assert.strictEqual(addon(ctx, booking.bookingId, MEMBER).success, true);
  assert.ok(ctx.lookups.some(function (l) { return l.email === MEMBER; }), '会員台帳を照合している');
});

test('ADDON: OTPフェーズで作成した予約は、OTP確認済み（ACTIVE / INACTIVE）だけが後付けできる。未確認（UNVERIFIED）は拒否', function () {
  var ctx = otpSetup();
  var verified = book(ctx, { date: DAY30, email: MEMBER, memberProof: proof(ctx, MEMBER) });
  var unverified = book(ctx, { date: DAY30, email: MEMBER, startTime: '14:00' });
  assert.strictEqual(record(ctx, verified.bookingId).membershipStatus, 'ACTIVE');
  assert.strictEqual(record(ctx, unverified.bookingId).membershipStatus, 'UNVERIFIED');
  assert.strictEqual(addon(ctx, verified.bookingId, MEMBER).success, true);
  var denied = addon(ctx, unverified.bookingId, MEMBER);
  assert.strictEqual(denied.success, false, 'OTP未確認で作った予約には会員限定オプションを後付けできない');
  noSnbMember(denied.error);
});

test('ADDON: OTP確認済みだが予約時に会員資格が無かった予約（INACTIVE）は、後付け時点で会員なら通る（所有確認は済み。既存会員を不当に拒否しない）', function () {
  var ctx = otpSetup({ members: {} });
  var booking = book(ctx, { date: DAY30, email: MEMBER, memberProof: proof(ctx, MEMBER) });
  assert.strictEqual(record(ctx, booking.bookingId).membershipStatus, 'INACTIVE');
  assert.strictEqual(addon(ctx, booking.bookingId, MEMBER).success, false, '台帳に会員資格が無い間は拒否');
  ctx.members[MEMBER] = ['2026-12'];
  assert.strictEqual(addon(ctx, booking.bookingId, MEMBER).success, true, '会員資格が確認できれば通る');
});

test('ADDON互換: 切戻し（OTP→LEGACY）後も、OTPフェーズで作成した予約の区別は変わらず、切戻し後の新規予約は台帳照合（NOT_CHECKED）', function () {
  var ctx = otpSetup();
  var otpBooking = book(ctx, { date: DAY30, email: MEMBER, startTime: '10:00' });
  ctx.setProperty(PHASE, 'LEGACY');
  assert.strictEqual(addon(ctx, otpBooking.bookingId, MEMBER).success, false, 'OTPフェーズで未確認の予約は切戻し後も区別される');
  var legacyBooking = book(ctx, { date: DAY30, email: MEMBER, startTime: '14:00' });
  assert.strictEqual(record(ctx, legacyBooking.bookingId).membershipStatus, 'NOT_CHECKED');
  assert.strictEqual(addon(ctx, legacyBooking.bookingId, MEMBER).success, true);
});

test('createBooking同時申込: OTPフェーズで会員限定のスタッフ対応は証明が必要（Studio X文言）。LEGACYでは従来どおり台帳照合だけ', function () {
  var legacy = setup({ members: { [MEMBER]: ['2026-12'] } });
  var okLegacy = book(legacy, { date: DAY30, email: MEMBER, options: STAFF_ADDON });
  assert.strictEqual(okLegacy.success, true, 'LEGACYは従来どおり');

  var ctx = otpSetup();
  var noProof = book(ctx, { date: DAY30, email: MEMBER, options: STAFF_ADDON });
  assert.strictEqual(noProof.success, false);
  assert.strictEqual(noProof.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  noSnbMember(noProof.error.message);
  var withProof = book(ctx, { date: DAY30, email: MEMBER, options: STAFF_ADDON, memberProof: proof(ctx, MEMBER) });
  assert.strictEqual(withProof.success, true);
  /* 会員限定でないオプション（セルフ設営・片付け）はOTPなしでそのまま。 */
  var selfOnly = book(ctx, { date: DAY30, email: STRANGER, startTime: '14:00', options: { setupService: 'SELF', cleanupService: 'SELF' } });
  assert.strictEqual(selfOnly.success, true);
});

// ============================================================================
// Web Appエンドポイント・メール文言・ブランド分離
// ============================================================================

test('確認コードメール: Studio Xは「SNB MEMBER」「Studio Nagoya Base」を出さず、会員限定のオプション・先行予約として案内する。SNBは従来どおり', function () {
  var ctx = otpSetup();
  var before = ctx.mailApp._sentEmails.length;
  var result = post(ctx, 'requestBookingMemberCode', { email: MEMBER, brand: 'studio_x' });
  assert.strictEqual(result.success, true);
  var mail = ctx.mailApp._sentEmails[before];
  assert.ok(mail && /確認コード：\d{6}/.test(mail.body));
  noSnbMember(mail.body);
  noSnbMember(mail.subject);
  assert.ok(!/Studio Nagoya Base/.test(mail.subject), '件名にSNBのブランド名を出さない');
  assert.ok(/Studio X/.test(mail.subject));
  assert.ok(/会員限定/.test(mail.body));

  var snbCtx = setup();
  var snbBefore = snbCtx.mailApp._sentEmails.length;
  assert.strictEqual(post(snbCtx, 'requestBookingMemberCode', { email: MEMBER }).success, true);
  var snbMail = snbCtx.mailApp._sentEmails[snbBefore];
  assert.ok(/SNB MEMBER/.test(snbMail.body), 'SNB（brand未指定）の本文は変えない');
  assert.ok(/Studio Nagoya Base/.test(snbMail.subject));
});

test('確認コード送信（requestBookingMemberCode）: Studio XはLEGACYの間は送らない（MEMBER_VERIFICATION_NOT_REQUIRED）。OTPフェーズでは同一応答で送る', function () {
  var ctx = setup();
  var before = ctx.mailApp._sentEmails.length;
  var res = post(ctx, 'requestBookingMemberCode', { email: MEMBER, brand: 'studio_x' });
  assert.strictEqual(res.success, false);
  assert.strictEqual(res.error.code, 'MEMBER_VERIFICATION_NOT_REQUIRED');
  assert.strictEqual(ctx.mailApp._sentEmails.length, before, 'メールを送らない');

  ctx.setProperty(PHASE, 'OTP');
  var member = post(ctx, 'requestBookingMemberCode', { email: MEMBER, brand: 'studio_x' });
  var stranger = post(ctx, 'requestBookingMemberCode', { email: STRANGER, brand: 'studio_x' });
  assert.strictEqual(member.success, true);
  assert.strictEqual(stranger.message, member.message, '会員・非会員で同一の応答');
  assert.strictEqual(ctx.lookups.length, 0, '台帳を参照しない');
});

test('月間空き状況・見積りの応答: Studio Xだけ memberAuthRequired を返す（LEGACY=false / OTP=true）。SNB / mensの応答は変えない', function () {
  var ctx = setup();
  var monthly = { action: 'monthly', year: '2026', month: '12', durationMinutes: '180', brand: 'studio_x' };
  var legacyMonthly = get(ctx, monthly);
  assert.strictEqual(legacyMonthly.priceGeneration, 'V2');
  assert.strictEqual(legacyMonthly.memberAuthRequired, false);
  ctx.setProperty(PHASE, 'OTP');
  assert.strictEqual(get(ctx, monthly).memberAuthRequired, true);
  var estimate = get(ctx, { action: 'estimatePrice', brand: 'studio_x', date: DAY30, durationMinutes: '180' });
  assert.strictEqual(estimate.success, true);
  assert.strictEqual(estimate.memberAuthRequired, true);
  assert.strictEqual(estimate.priceGeneration, 'V2');

  ['snb', 'mens'].forEach(function (brand) {
    var res = get(ctx, Object.assign({}, monthly, { brand: brand }));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(res, 'memberAuthRequired'), false, brand + 'の応答は変えない');
  });
});

test('bookingMemberStatus（Studio X）: LEGACYはNOT_REQUIRED。OTPフェーズでは証明が有効なときだけ先行予約資格を返し、会員情報の無い証明は返さない。文言にSNB MEMBERを出さない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-11', '2026-12'] } });
  var legacy = post(ctx, 'bookingMemberStatus', { brand: 'studio_x', email: MEMBER, proof: 'a'.repeat(64) });
  assert.strictEqual(legacy.error.code, 'MEMBER_VERIFICATION_NOT_REQUIRED');

  ctx.setProperty(PHASE, 'OTP');
  var noProof = post(ctx, 'bookingMemberStatus', { brand: 'studio_x', email: MEMBER });
  assert.strictEqual(noProof.success, false);
  assert.strictEqual(noProof.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  noSnbMember(noProof.error.message);
  var bad = post(ctx, 'bookingMemberStatus', { brand: 'studio_x', email: MEMBER, proof: 'a'.repeat(64) });
  assert.strictEqual(bad.error.code, 'MEMBER_REVERIFY_REQUIRED');
  noSnbMember(bad.error.message);

  var ok = post(ctx, 'bookingMemberStatus', { brand: 'studio_x', email: MEMBER, proof: proof(ctx, MEMBER), date: DAY30, durationMinutes: 180 });
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.verified, true);
  assert.strictEqual(ok.advanceEligible, true);
  assert.strictEqual(ok.priceGeneration, 'V2');
  var other = post(ctx, 'bookingMemberStatus', { brand: 'studio_x', email: STRANGER, proof: proof(ctx, STRANGER), date: DAY30, durationMinutes: 180 });
  assert.strictEqual(other.advanceEligible, false);
  assert.deepStrictEqual(plain(ok.price), plain(other.price), 'Studio Xの料金は会員かどうかで変わらない');
  /* 貸切ベースプラン（Studio Xの既存プラン）の見積りも通る。ペアパック（SNB / mens専用）は不可。 */
  var eventPlan = post(ctx, 'bookingMemberStatus', { brand: 'studio_x', email: MEMBER, proof: proof(ctx, MEMBER), date: DAY30, durationMinutes: 360, startTime: '09:00', plan: 'osu_cosplay_base_6h' });
  assert.strictEqual(eventPlan.success, true, JSON.stringify(eventPlan));
  assert.strictEqual(eventPlan.price.plan, 'osu_cosplay_base_6h');
  var pair = post(ctx, 'bookingMemberStatus', { brand: 'studio_x', email: MEMBER, proof: proof(ctx, MEMBER), date: DAY30, durationMinutes: 180, plan: 'member_pair_3h' });
  assert.strictEqual(pair.success, false);
  assert.strictEqual(pair.error.code, 'INVALID_PLAN');
});

// ============================================================================
// テストモード（TEST）: 資格付きのみOTP。12/1に縛られない。隔離
// ============================================================================

function testCredential(ctx, email, now) {
  return ctx.sandbox.BookingTestCredential.issue(email || TESTER, 60, now || ctx.clock.currentDate(), { studioX: true });
}

test('TEST: 資格を持つリクエストだけOTP必須。一般利用者・資格なしは台帳照合のまま（本番へ波及しない）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-11', '2026-12'] } });
  ctx.setProperty(PHASE, 'TEST');
  var issued = testCredential(ctx);
  var ctxOf = function (token, email) { return { testCredential: token, email: email }; };

  var withCred = plain(ctx.sandbox.BookingGenerationMode.decide(NOW, 'studio_x', ctxOf(issued.token, TESTER)));
  assert.strictEqual(withCred.memberAuthRequired, true);
  assert.strictEqual(withCred.testCredential, 'VALID');
  assert.strictEqual(withCred.generation, 'V2');
  var general = plain(ctx.sandbox.BookingGenerationMode.decide(NOW, 'studio_x'));
  assert.strictEqual(general.memberAuthRequired, false);
  assert.strictEqual(general.testCredential, 'NONE');

  /* 一般利用者（資格なし）は台帳照合で従来どおり31日目を予約できる。 */
  var advance = book(ctx, { date: DAY31, email: MEMBER });
  assert.strictEqual(advance.success, true);
  assert.strictEqual(record(ctx, advance.bookingId).membershipStatus, 'NOT_CHECKED');
});

test('TEST: 資格付きcreateBookingはOTP必須（証明が必要）。資格はメールに拘束され、他のメール・改ざん・失効は予約を拒否する', function () {
  var ctx = setup({ properties: { BOOKING_TEST_ALLOWED_EMAILS: TESTER + ',' + MEMBER }, members: { [MEMBER]: ['2026-11', '2026-12'], [TESTER]: ['2026-11', '2026-12'] } });
  ctx.setProperty(PHASE, 'TEST');
  var issued = testCredential(ctx, TESTER);

  var noProof = book(ctx, { email: TESTER, date: DAY31, testCredential: issued.token });
  assert.strictEqual(noProof.success, false);
  assert.strictEqual(noProof.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  var ok = book(ctx, { email: TESTER, date: DAY31, testCredential: issued.token, memberProof: proof(ctx, TESTER) });
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.dryRun, true, 'TESTの資格付き予約はドライラン（実予約を作らない）');
  assert.strictEqual(ok.memberVerified, true);

  /* 他のメールで同じ資格を使う → 資格が無効。黙って台帳照合へ落とさない。 */
  var otherEmail = book(ctx, { email: MEMBER, date: '2026-12-12', startTime: '13:00', testCredential: issued.token });
  assert.strictEqual(otherEmail.success, false);
  assert.strictEqual(otherEmail.error.code, 'TEST_CREDENTIAL_INVALID');
  var tampered = book(ctx, { email: TESTER, date: '2026-12-12', startTime: '13:00', testCredential: issued.token.slice(0, -2) + '00' });
  assert.strictEqual(tampered.error.code, 'TEST_CREDENTIAL_INVALID');
  ctx.sandbox.BookingTestCredential.revoke(issued.id);
  var revoked = book(ctx, { email: TESTER, date: '2026-12-12', startTime: '13:00', testCredential: issued.token });
  assert.strictEqual(revoked.error.code, 'TEST_CREDENTIAL_INVALID');
});

test('TEST: 資格はSNB / mensの12/1に縛られない（Studio X用の発行は12/1以降も可。SNB用の発行は従来どおり不可）。資格の期限は守る', function () {
  var ctx = setup({ now: AFTER_DEC1 });
  ctx.setProperty(PHASE, 'TEST');
  assert.throws(function () { ctx.sandbox.BookingTestCredential.issue(TESTER, 60, AFTER_DEC1); }, /2026\/12\/1/);
  var issued = testCredential(ctx, TESTER, AFTER_DEC1);
  var d = plain(ctx.sandbox.BookingGenerationMode.decide(AFTER_DEC1, 'studio_x', { testCredential: issued.token, email: TESTER }));
  assert.strictEqual(d.memberAuthRequired, true, '12/1以降もStudio XのTESTは資格の期限内なら使える');
  var later = new Date(AFTER_DEC1.getTime() + 61 * 60000);
  var expired = plain(ctx.sandbox.BookingGenerationMode.decide(later, 'studio_x', { testCredential: issued.token, email: TESTER }));
  assert.strictEqual(expired.memberAuthRequired, false);
  assert.strictEqual(expired.testCredential, 'INVALID');
  /* SNB側の判定は、Studio X用に発行した資格があっても12/1以降は通常LIVE（資格は不要・INACTIVE）。 */
  var snb = plain(ctx.sandbox.BookingGenerationMode.decide(AFTER_DEC1, 'snb', { testCredential: issued.token, email: TESTER }));
  assert.strictEqual(snb.source, 'TIME');
  assert.strictEqual(snb.testCredential, 'INACTIVE');
});

test('TEST: 許可メール以外には資格を発行できない。資格・メールアドレス・OTPをログや予約記録へ残さない。Studio X用リンクはStudio Xのページだけ', function () {
  var ctx = setup();
  ctx.setProperty(PHASE, 'TEST');
  assert.throws(function () { ctx.sandbox.BookingTestCredential.issue(STRANGER, 60, NOW, { studioX: true }); }, /登録されていません/);
  var issued = testCredential(ctx, TESTER);
  var before = ctx.mailApp._sentEmails.length;
  ctx.sandbox.BookingTestCredential.sendLinks(TESTER, issued.token, issued.expiresAt, { studioX: true });
  var mail = ctx.mailApp._sentEmails[before];
  assert.ok(/\/studio-x\/booking\/#bt=/.test(mail.body));
  assert.ok(!/\/mens\/booking|\/booking\/en\.html|SNB/.test(mail.body), 'SNB / mens / 英語版のリンクを混ぜない');

  var booked = book(ctx, { email: TESTER, date: DAY30, testCredential: issued.token, memberProof: proof(ctx, TESTER) });
  assert.strictEqual(booked.success, true);
  var dump = JSON.stringify(ctx.sheets.Bookings ? ctx.sheets.Bookings._rows : []) + JSON.stringify(ctx.logger._messages || []);
  assert.strictEqual(dump.indexOf(issued.token), -1, '資格を保存・ログへ出さない');
  assert.strictEqual(JSON.stringify(booked).indexOf(issued.token), -1);
});

test('TEST: testMonthlyは資格付きだけOTP必須を返す。LEGACY・OTPフェーズでは資格はINACTIVEとして破棄させる', function () {
  var ctx = setup();
  var body = { year: '2026', month: '12', durationMinutes: '180', brand: 'studio_x', timeBand: 'all', email: TESTER };
  ctx.setProperty(PHASE, 'TEST');
  var issued = testCredential(ctx, TESTER);
  var valid = post(ctx, 'testMonthly', Object.assign({ testCredential: issued.token }, body));
  assert.strictEqual(valid.memberAuthRequired, true);
  assert.strictEqual(valid.testCredentialStatus, 'VALID');
  assert.strictEqual(get(ctx, Object.assign({ action: 'monthly' }, body)).memberAuthRequired, false, '資格なしの一般利用者はfalse');

  ctx.setProperty(PHASE, 'LEGACY');
  var legacy = post(ctx, 'testMonthly', Object.assign({ testCredential: issued.token }, body));
  assert.strictEqual(legacy.memberAuthRequired, false);
  assert.strictEqual(legacy.testCredentialStatus, 'INACTIVE');
  ctx.setProperty(PHASE, 'OTP');
  assert.strictEqual(post(ctx, 'testMonthly', Object.assign({ testCredential: issued.token }, body)).testCredentialStatus, 'INACTIVE');
});

// ============================================================================
// 切戻し・SNB / mens回帰
// ============================================================================

test('切戻し: OTP→LEGACYでV2料金・オプション価格・既存予約の料金・世代は変わらない（認証方式だけが戻る）', function () {
  var ctx = otpSetup();
  var optionsPayload = { options: { setupService: 'SELF', cleanupService: 'SELF', equipment: { COB_FULLCOLOR: 1 } } };
  var inOtp = book(ctx, Object.assign({ date: DAY30, email: STRANGER }, optionsPayload));
  assert.strictEqual(inOtp.success, true, JSON.stringify(inOtp));
  ctx.setProperty(PHASE, 'LEGACY');
  var inLegacy = book(ctx, Object.assign({ date: DAY30, email: STRANGER, startTime: '14:00' }, optionsPayload));
  assert.strictEqual(inLegacy.success, true, JSON.stringify(inLegacy));
  assert.deepStrictEqual(inLegacy.price, inOtp.price, '部屋料金は切戻しで変わらない');
  function optionPrices(result) {
    return plain(result.options).orders.map(function (o) { return { category: o.category, items: o.items, amountJpy: o.amountJpy, payable: o.payable }; });
  }
  assert.deepStrictEqual(optionPrices(inLegacy), optionPrices(inOtp), 'オプション価格・内訳は切戻しで変わらない');
  assert.strictEqual(record(ctx, inOtp.bookingId).priceGeneration, 'V2');
  assert.strictEqual(record(ctx, inLegacy.bookingId).priceGeneration, 'V2', 'V1へ退避しない');
  assert.strictEqual(record(ctx, inLegacy.bookingId).priceAmount, record(ctx, inOtp.bookingId).priceAmount, '保存済みの料金も同じ');
  /* SNB / mens専用の緊急停止フラグはStudio Xの切戻しに使われない（設定してもStudio Xの認証・世代は変わらない）。 */
  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', 'ENABLED');
  ctx.setProperty(PHASE, 'OTP');
  var d = plain(ctx.sandbox.BookingGenerationMode.decide(NOW, 'studio_x'));
  assert.strictEqual(d.generation, 'V2');
  assert.strictEqual(d.memberAuthRequired, true);
});

test('SNB / mens回帰: Studio XをOTPにしても、SNB / mensの12/1前のV1・会員台帳フロー・12/1以降のOTP必須は従来どおり', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-11', '2026-12'] } });
  ctx.setProperty(PHASE, 'OTP');
  /* 12/1前のSNB: V1で台帳照合の会員が先行予約できる（現行main）。 */
  var snb = book(ctx, { brand: 'snb', date: DAY31, email: MEMBER, isMember: true });
  assert.strictEqual(snb.success, true);
  assert.strictEqual(record(ctx, snb.bookingId).priceGeneration, 'V1');
  /* 12/1以降のSNB: OTP必須（従来どおり）。 */
  ctx.setNow(AFTER_DEC1);
  var after = book(ctx, { brand: 'snb', date: '2027-01-12', email: MEMBER }, AFTER_DEC1);
  assert.strictEqual(after.success, false);
  assert.strictEqual(after.error.code, 'MEMBER_VERIFICATION_REQUIRED');
  assert.ok(/SNB MEMBER|会員料金/.test(after.error.message), 'SNBの文言は変えない');
  var snbProof = proof(ctx, MEMBER, AFTER_DEC1);
  assert.strictEqual(book(ctx, { brand: 'snb', date: '2027-01-12', email: MEMBER, memberProof: snbProof }, AFTER_DEC1).success, true);
});

test('管理画面の確認表示（showBookingAuthModeStatus）にStudio Xの認証フェーズが出るが、機密は含まない', function () {
  var ctx = setup();
  ctx.setProperty(PHASE, 'TEST');
  var status = plain(ctx.sandbox.showBookingAuthModeStatus());
  assert.strictEqual(status.studioXAuthPhase, 'TEST');
  assert.ok(JSON.stringify(status).indexOf(KEY) === -1);
});

test('TEST（ドライラン）: 資格付きの予約は検証だけ本番と同じに行い、Calendar・Bookings・オプション注文・通知メールへ一切書かない。一般利用者は影響を受けない', function () {
  var ctx = setup({ members: { [TESTER]: ['2026-11', '2026-12'] } });
  ctx.setProperty(PHASE, 'TEST');
  var issued = testCredential(ctx, TESTER);
  var calendar = ctx.sandbox.CalendarApp.getCalendarById('cal1');
  var eventsBefore = calendar.getEvents(new Date('2026-12-01T00:00:00+09:00'), new Date('2027-03-01T00:00:00+09:00')).length;
  var mailsBefore = ctx.mailApp._sentEmails.length;
  var p = proof(ctx, TESTER);
  var mailsAfterOtp = ctx.mailApp._sentEmails.length;

  var dry = book(ctx, { email: TESTER, date: DAY31, testCredential: issued.token, memberProof: p, options: STAFF_ADDON });
  assert.strictEqual(dry.success, true, JSON.stringify(dry));
  assert.strictEqual(dry.dryRun, true);
  assert.ok(/^DRYRUN-/.test(dry.bookingId));
  assert.strictEqual(dry.status, 'TEST_DRY_RUN');
  assert.strictEqual(dry.checkoutAccessToken, '');
  assert.strictEqual(dry.options, undefined, 'オプション注文を作らない');
  assert.strictEqual(ctx.sheets.Bookings, undefined, 'Bookings台帳へ書かない');
  assert.strictEqual(ctx.sheets.OptionOrders, undefined, 'OptionOrdersへ書かない');
  assert.strictEqual(calendar.getEvents(new Date('2026-12-01T00:00:00+09:00'), new Date('2027-03-01T00:00:00+09:00')).length, eventsBefore, 'Calendarへ書かない');
  assert.strictEqual(ctx.mailApp._sentEmails.length, mailsAfterOtp, '予約受付・運営通知メールを送らない（送るのはOTPのみ）');
  assert.ok(mailsAfterOtp > mailsBefore);

  /* 検証は本番と同じ: 非会員の31日目・証明なし・91日目・資格なしの一般利用者は通常どおり。 */
  assert.strictEqual(book(ctx, { email: TESTER, date: DAY91, testCredential: issued.token, memberProof: p }).error.code, 'DATE_OUT_OF_RANGE');
  assert.strictEqual(book(ctx, { email: TESTER, date: DAY31, testCredential: issued.token }).error.code, 'MEMBER_VERIFICATION_REQUIRED');
  var real = book(ctx, { email: TESTER, date: DAY30 });
  assert.strictEqual(real.success, true);
  assert.strictEqual(real.dryRun, undefined, '資格なしの一般利用者は通常の実予約');
  assert.strictEqual(record(ctx, real.bookingId).membershipStatus, 'NOT_CHECKED');
});

test('OTPフェーズ（本番）ではドライランにならない。資格を送っても実予約（資格はINACTIVEで破棄される）', function () {
  var ctx = otpSetup();
  ctx.setProperty(PHASE, 'TEST');
  var issued = testCredential(ctx, TESTER);
  ctx.setProperty(PHASE, 'OTP');
  var res = book(ctx, { email: MEMBER, date: DAY30, testCredential: issued.token });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.dryRun, undefined);
  assert.strictEqual(record(ctx, res.bookingId).membershipStatus, 'UNVERIFIED');
});
