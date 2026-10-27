/*
 * SNB / SNB mensの料金世代判定（BookingGenerationMode.gs）とテスト資格（BookingTestCredential.gs）のテスト（Issue #559）。
 *
 * - 優先順位: 緊急停止 ＞ 12/1前のTEST / LEGACY設定 ＞ サーバー時刻。2026/11/30 23:59:59 JSTと12/1 0:00:00 JSTの境界。
 * - モード未設定・空値・不正値はLIVE（現行mainと同じ時刻判定）。緊急停止はENABLEDの完全一致のみ。
 * - テスト資格: 署名・用途・期限・失効・許可メールの拘束。メール入力だけではTESTに入れない。改ざん・期限切れ・失効・鍵ローテーション。
 * - Studio X（2026/10/26）の世代判定は変わらない。Adminはテスト資格を検証せず、緊急停止と時刻だけで判定する。
 * - Web Appのエンドポイント（POST testMonthly / testEstimatePrice / bookingMemberStatus）とcreateBookingが同じ判定を使う。
 * 本番へは一切アクセスしない（Sheets・Calendar・MailApp・PropertiesServiceはすべてスタブ）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var manifest = require('./helpers/booking-deployment-manifest');
var proofHelper = require('./helpers/booking-member-proof');

var FILES = [
  'Config.gs', 'CalendarRepository.gs', 'Availability.gs', 'Booking.gs', 'JapaneseHolidays.gs', 'BookingPricing.gs',
  'FeeCalculator.gs', 'CardPayment.gs', 'MembershipRules.gs', 'MemberRepository.gs', 'EquipmentCatalog.gs',
  'BookingOptions.gs', 'StripeGateway.gs', 'RateLimiter.gs', 'SpreadsheetRepository.gs', 'OptionOrderRepository.gs',
  'RecoveryRepository.gs', 'FeeSettlementRepository.gs', 'StripeEventRepository.gs', 'BookingMailTemplates.gs',
  'BookingMailer.gs', 'OptionMailTemplates.gs', 'OptionOrderService.gs', 'BookingRepository.gs', 'AdminNotifier.gs',
  'BookingAdminAlerts.gs', 'MembershipService.gs', 'BookingMemberVerification.gs', 'BookingTestCredential.gs', 'Code.gs'
];

var KEY = 'unit-test-signing-key-0123456789abcdef-not-a-secret';
var ADMIN = 'admin@example.com';
var TESTER = 'tester@example.com';
var STRANGER = 'stranger@example.com';
var MEMBER = 'member@example.com';
var SPREADSHEET_ID = 'ss1';
var DAY = 24 * 60 * 60 * 1000;

var NOV = new Date('2026-11-15T12:00:00+09:00');
var BEFORE_SWITCH = new Date('2026-11-30T23:59:59+09:00');
var AT_SWITCH = new Date('2026-12-01T00:00:00+09:00');
var AFTER_SWITCH = new Date('2026-12-05T12:00:00+09:00');

function plain(v) { return JSON.parse(JSON.stringify(v)); }

/*
 * opts.properties: 追加のScript Properties。opts.now: 現在時刻（Code.gsのnew Date()が返す）。
 * 既定はTEST設定・許可メール2件・署名鍵あり。
 */
function setup(opts) {
  var o = opts || {};
  var spreadsheetsById = {};
  spreadsheetsById[SPREADSHEET_ID] = {};
  var properties = Object.assign({
    CALENDAR_ID: 'cal1', SPREADSHEET_ID: SPREADSHEET_ID,
    BOOKING_MAIL_DISPLAY_NAME: 'SNB', BOOKING_MAIL_REPLY_TO: 'noreply@example.com', BOOKING_CONTACT_EMAIL: 'contact@example.com',
    ADMIN_NOTIFICATION_EMAIL: 'admin-notify@example.com',
    RATE_LIMIT_EMAIL_COUNT: '100', RATE_LIMIT_GLOBAL_COUNT: '1000',
    BOOKING_AUTH_MODE: 'TEST',
    BOOKING_TEST_CREDENTIAL_KEY: KEY,
    BOOKING_TEST_ALLOWED_EMAILS: ADMIN + ', ' + TESTER
  }, o.properties || {});
  var propertiesService = stubs.createPropertiesServiceStub(properties);
  var mailApp = stubs.createMailAppStub(o.mail);
  var logger = stubs.createLoggerStub();
  var clock = stubs.createControllableClock(o.now || NOV);
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
  var ctx = {
    sandbox: sandbox, mailApp: mailApp, logger: logger, clock: clock, properties: properties,
    sheets: spreadsheetsById[SPREADSHEET_ID], members: o.members || {}, lookups: [], proofCache: {}
  };
  sandbox.MemberRepository.isMemberOnDate = function (email, date) {
    ctx.lookups.push({ email: email, date: date });
    return (ctx.members[String(email).toLowerCase()] || []).indexOf(String(date).substring(0, 7)) !== -1;
  };
  /* PropertiesServiceスタブはオブジェクトを共有するため、テスト側からも設定を書き換えられる。 */
  ctx.setProperty = function (name, value) {
    if (value === undefined) propertiesService.getScriptProperties().deleteProperty(name);
    else propertiesService.getScriptProperties().setProperty(name, value);
  };
  ctx.setNow = function (date) { clock.advanceByMillis(date.getTime() - clock.currentDate().getTime()); };
  return ctx;
}

function issue(ctx, email, ttlMinutes, at) {
  return ctx.sandbox.BookingTestCredential.issue(email || ADMIN, ttlMinutes, at || ctx.clock.currentDate());
}

function decide(ctx, now, brand, context) {
  return plain(ctx.sandbox.BookingGenerationMode.decide(now, brand, context));
}

function withCredential(token, email) { return { testCredential: token, email: email || ADMIN }; }

// ============================================================================
// 優先順位・日付境界・モード設定
// ============================================================================

test('境界: モード未設定の一般利用者は2026/11/30 23:59:59 JSTまでV1、2026/12/1 00:00:00 JSTからV2（SNB・mens）', function () {
  var ctx = setup({ properties: { BOOKING_AUTH_MODE: undefined } });
  ['snb', 'mens'].forEach(function (brand) {
    assert.strictEqual(decide(ctx, BEFORE_SWITCH, brand).generation, 'V1', brand + ' 11/30 23:59:59');
    assert.strictEqual(decide(ctx, AT_SWITCH, brand).generation, 'V2', brand + ' 12/1 00:00:00');
    assert.strictEqual(decide(ctx, AT_SWITCH, brand).source, 'TIME');
  });
});

test('TEST: 検証済みの資格を持つリクエストだけ12/1前でもV2。それ以外はV1', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 60);
  ['snb', 'mens'].forEach(function (brand) {
    var withCred = decide(ctx, NOV, brand, withCredential(issued.token));
    assert.strictEqual(withCred.generation, 'V2');
    assert.strictEqual(withCred.source, 'TEST_CREDENTIAL');
    assert.strictEqual(withCred.testCredential, 'VALID');
    assert.strictEqual(decide(ctx, NOV, brand).generation, 'V1', '資格なしの一般利用者はV1');
    assert.strictEqual(decide(ctx, NOV, brand).testCredential, 'NONE');
  });
});

test('TEST: メールアドレスの入力だけ（許可メールを第三者が入力）ではTESTに入れない', function () {
  var ctx = setup();
  issue(ctx, ADMIN, 60);
  /* 許可メールを入力しただけ・資格なし／空の資格 → V1のまま。 */
  [undefined, { email: ADMIN }, { email: ADMIN, testCredential: '' }, { email: ADMIN, testCredential: 12345 }].forEach(function (context) {
    var d = decide(ctx, NOV, 'snb', context);
    assert.strictEqual(d.generation, 'V1');
    assert.strictEqual(d.testCredential, 'NONE');
  });
  /* 他人が作った資格文字列の推測・でたらめな文字列も通らない。 */
  ['t1.' + '0'.repeat(16) + '.1700000000.1900000000.' + '0'.repeat(32) + '.' + '0'.repeat(64), 'dummy', 't1.x'].forEach(function (token) {
    var d = decide(ctx, NOV, 'snb', withCredential(token));
    assert.strictEqual(d.generation, 'V1');
    assert.strictEqual(d.testCredential, 'INVALID');
  });
});

test('TESTの終了期限: 資格が有効でも11/30 23:59:59まで。12/1 00:00:00以降はTEST設定が残っていても通常LIVE（資格は不要＝INACTIVE）', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 7 * 24 * 60, new Date('2026-11-30T20:00:00+09:00'));
  assert.strictEqual(decide(ctx, BEFORE_SWITCH, 'snb', withCredential(issued.token)).source, 'TEST_CREDENTIAL', '23:59:59はまだTEST');
  var after = decide(ctx, AT_SWITCH, 'snb', withCredential(issued.token));
  assert.strictEqual(after.generation, 'V2');
  assert.strictEqual(after.source, 'TIME', '12/1 0:00からは時刻判定（通常LIVE）');
  assert.strictEqual(after.testCredential, 'INACTIVE');
  /* TESTのまま・LEGACYのまま残っていても、12/1以降は一般利用者もV2（延長できない）。 */
  ['TEST', 'LEGACY'].forEach(function (mode) {
    ctx.setProperty('BOOKING_AUTH_MODE', mode);
    assert.strictEqual(decide(ctx, AT_SWITCH, 'snb').generation, 'V2', mode + 'が残っても12/1にLIVE相当');
    assert.strictEqual(decide(ctx, AFTER_SWITCH, 'mens').generation, 'V2');
  });
});

test('資格の期限は発行時に12/1 0:00 JSTで打ち切る（長いTTLを指定しても超えない）。既定480分・最大7日', function () {
  var ctx = setup();
  var nearEnd = new Date('2026-11-30T20:00:00+09:00');
  var issued = issue(ctx, ADMIN, 7 * 24 * 60, nearEnd);
  assert.strictEqual(issued.expiresAt.getTime(), AT_SWITCH.getTime());
  var normal = issue(ctx, ADMIN, undefined, NOV);
  assert.strictEqual(normal.expiresAt.getTime() - NOV.getTime(), 480 * 60000, '既定480分');
  assert.throws(function () { issue(ctx, ADMIN, 7 * 24 * 60 + 1, NOV); }, /有効分数/);
  assert.throws(function () { issue(ctx, ADMIN, 0, NOV); }, /有効分数/);
  assert.throws(function () { issue(ctx, ADMIN, 1.5, NOV); }, /有効分数/);
  assert.throws(function () { issue(ctx, ADMIN, 60, AT_SWITCH); }, /12\/1/, '12/1以降は発行できない');
});

test('モード未設定・空値・不正値はLIVE（現行mainと同じ時刻判定）。設定不備でV1へ倒さない', function () {
  ['', 'live', 'Live', 'test', 'Test', ' TEST', 'TEST ', 'LEGACY ', 'legacy', 'garbage', '0', 'true'].concat([undefined]).forEach(function (value) {
    var ctx = setup({ properties: { BOOKING_AUTH_MODE: value } });
    assert.strictEqual(ctx.sandbox.BookingGenerationMode.configuredMode(), 'LIVE', JSON.stringify(value));
    assert.strictEqual(decide(ctx, AT_SWITCH, 'snb').generation, 'V2', JSON.stringify(value) + ' → 12/1にV2');
    assert.strictEqual(decide(ctx, BEFORE_SWITCH, 'snb').generation, 'V1');
    /* 大文字小文字違いのtestでは資格があってもTESTにならない。 */
    var issued = issue(ctx, ADMIN, 60);
    assert.strictEqual(decide(ctx, NOV, 'snb', withCredential(issued.token)).generation, 'V1');
  });
});

test('LEGACY: 12/1前は全員V1（資格があってもV2にならない）。12/1以降は通常LIVEで、LEGACYの選択が意図せず残らない', function () {
  var ctx = setup({ properties: { BOOKING_AUTH_MODE: 'LEGACY' } });
  var issued = issue(ctx, ADMIN, 60);
  var before = decide(ctx, NOV, 'snb', withCredential(issued.token));
  assert.strictEqual(before.generation, 'V1');
  assert.strictEqual(before.testCredential, 'INVALID', 'モード変更で資格は無効（フォームは破棄して通常フローへ）');
  assert.strictEqual(decide(ctx, NOV, 'snb').generation, 'V1');
  assert.strictEqual(decide(ctx, AT_SWITCH, 'snb').generation, 'V2');
  assert.strictEqual(decide(ctx, AT_SWITCH, 'mens').generation, 'V2');
});

test('緊急停止: BOOKING_AUTH_EMERGENCY_LEGACYがENABLEDと完全一致のときだけ有効（12/1前後ともV1）', function () {
  var ctx = setup({ properties: { BOOKING_AUTH_EMERGENCY_LEGACY: 'ENABLED' } });
  assert.strictEqual(ctx.sandbox.BookingGenerationMode.isEmergencyLegacy(), true);
  ['snb', 'mens'].forEach(function (brand) {
    [NOV, BEFORE_SWITCH, AT_SWITCH, AFTER_SWITCH].forEach(function (when) {
      var d = decide(ctx, when, brand);
      assert.strictEqual(d.generation, 'V1', brand + ' ' + when.toISOString());
      assert.strictEqual(d.source, 'EMERGENCY_LEGACY');
    });
  });
});

test('緊急停止: 類似値（大小文字違い・前後の空白・その他の値・空文字・未設定）では停止しない', function () {
  ['enabled', 'Enabled', 'ENABLED ', ' ENABLED', 'ENABLED\n', 'ENABLE', 'ENABLED1', 'true', 'TRUE', '1', 'on', 'yes', 'LEGACY', ''].concat([undefined]).forEach(function (value) {
    var ctx = setup({ properties: { BOOKING_AUTH_EMERGENCY_LEGACY: value } });
    assert.strictEqual(ctx.sandbox.BookingGenerationMode.isEmergencyLegacy(), false, JSON.stringify(value));
    assert.strictEqual(decide(ctx, AT_SWITCH, 'snb').generation, 'V2', JSON.stringify(value) + 'では12/1にV2のまま');
    assert.strictEqual(decide(ctx, AT_SWITCH, 'snb').source, 'TIME');
  });
});

test('優先順位: 緊急停止は有効なテスト資格・TEST設定より優先する。12/1以降に古い資格が残っていても緊急停止ならV1', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 60);
  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', 'ENABLED');
  var before = decide(ctx, NOV, 'snb', withCredential(issued.token));
  assert.strictEqual(before.generation, 'V1');
  assert.strictEqual(before.testCredential, 'INVALID', '12/1前にV2だった入力は黙ってV1へ変えず、拒否側に倒す');
  var after = decide(ctx, AFTER_SWITCH, 'snb', withCredential(issued.token));
  assert.strictEqual(after.generation, 'V1');
  assert.strictEqual(after.testCredential, 'INACTIVE');
  /* 復帰: フラグを外せば12/1以降は通常V2。 */
  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', undefined);
  assert.strictEqual(decide(ctx, AFTER_SWITCH, 'snb').generation, 'V2');
});

test('Studio X: 2026/10/26 0:00 JSTのV2判定は、モード・緊急停止・資格の有無に関わらず一切変わらない。外部予約等の対象外ブランドも同様', function () {
  var cases = [
    {},
    { BOOKING_AUTH_MODE: 'TEST' },
    { BOOKING_AUTH_MODE: 'LEGACY' },
    { BOOKING_AUTH_EMERGENCY_LEGACY: 'ENABLED' },
    { BOOKING_AUTH_MODE: 'TEST', BOOKING_AUTH_EMERGENCY_LEGACY: 'ENABLED' }
  ];
  cases.forEach(function (properties) {
    var ctx = setup({ properties: Object.assign({ BOOKING_AUTH_MODE: undefined }, properties) });
    var issued = issue(ctx, ADMIN, 60);
    var label = JSON.stringify(properties);
    assert.strictEqual(decide(ctx, new Date('2026-10-25T23:59:59+09:00'), 'studio_x').generation, 'V1', label);
    assert.strictEqual(decide(ctx, new Date('2026-10-26T00:00:00+09:00'), 'studio_x').generation, 'V2', label);
    assert.strictEqual(decide(ctx, NOV, 'studio_x').generation, 'V2', label);
    assert.strictEqual(decide(ctx, NOV, 'studio_x').source, 'TIME');
    assert.strictEqual(decide(ctx, NOV, 'studio_x').mode, null);
    assert.strictEqual(decide(ctx, NOV, 'studio_x', withCredential(issued.token)).generation, 'V2', '資格を送ってもStudio Xは時刻判定のまま');
    assert.strictEqual(decide(ctx, NOV, 'studio_x', withCredential(issued.token)).testCredential, 'INACTIVE');
    assert.strictEqual(decide(ctx, NOV, 'external', undefined).source, 'TIME');
    /* 時刻だけの純粋関数は従来のまま。 */
    assert.strictEqual(ctx.sandbox.BookingPricing.generationAt(new Date('2026-10-26T00:00:00+09:00'), 'studio_x'), 'V2');
    assert.strictEqual(ctx.sandbox.BookingPricing.generationAt(BEFORE_SWITCH, 'snb'), 'V1');
    assert.strictEqual(ctx.sandbox.BookingPricing.generationAt(AT_SWITCH, 'snb'), 'V2');
  });
});

// ============================================================================
// テスト資格の検証
// ============================================================================

function flipLastHex(token) {
  var last = token.charAt(token.length - 1);
  return token.substring(0, token.length - 1) + (last === '0' ? '1' : '0');
}

test('資格の検証: 正当な資格は通り、改ざん（署名・ID・期限・メールタグ）は通らない', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 60);
  var verify = function (token, email) { return plain(ctx.sandbox.BookingTestCredential.verify(token, email || ADMIN, ctx.clock.currentDate())); };
  assert.strictEqual(verify(issued.token).ok, true);
  assert.strictEqual(verify(issued.token).id, issued.id);

  var parts = issued.token.split('.');
  assert.strictEqual(parts.length, 6);
  var variants = {
    署名の改ざん: flipLastHex(issued.token),
    期限の延長: [parts[0], parts[1], parts[2], String(Number(parts[3]) + 86400), parts[4], parts[5]].join('.'),
    IDの差し替え: [parts[0], 'f'.repeat(16), parts[2], parts[3], parts[4], parts[5]].join('.'),
    メールタグの差し替え: [parts[0], parts[1], parts[2], parts[3], '0'.repeat(32), parts[5]].join('.'),
    バージョン違い: ['t2'].concat(parts.slice(1)).join('.'),
    余分な区切り: issued.token + '.00',
    空: '',
    前後の空白: ' ' + issued.token
  };
  Object.keys(variants).forEach(function (name) {
    assert.strictEqual(verify(variants[name]).ok, false, name + 'は通らない');
  });
  assert.strictEqual(verify(null).ok, false);
  assert.strictEqual(verify(undefined).ok, false);
  assert.strictEqual(verify({ toString: function () { return issued.token; } }).ok, false, '文字列以外は通らない');
});

test('資格の検証: 期限切れ・失効・鍵のローテーション・鍵未設定・許可メールからの削除は通らない', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 30);
  var verifyAt = function (when, email) { return plain(ctx.sandbox.BookingTestCredential.verify(issued.token, email || ADMIN, when)); };
  var start = ctx.clock.currentDate().getTime();
  assert.strictEqual(verifyAt(new Date(start + 29 * 60000)).ok, true);
  assert.strictEqual(verifyAt(new Date(start + 30 * 60000)).reason, 'EXPIRED', '期限ちょうどから無効');
  assert.strictEqual(verifyAt(new Date(start + 31 * 60000)).ok, false);

  /* 失効リスト */
  assert.strictEqual(verifyAt(new Date(start)).ok, true);
  ctx.sandbox.BookingTestCredential.revoke(issued.id);
  assert.strictEqual(verifyAt(new Date(start)).reason, 'REVOKED');
  assert.strictEqual(ctx.sandbox.PropertiesService.getScriptProperties().getProperty('BOOKING_TEST_REVOKED_IDS'), issued.id);
  assert.throws(function () { ctx.sandbox.BookingTestCredential.revoke('not-an-id'); }, /形式/);

  /* 失効は他の資格に影響しない／鍵ローテーションで全資格が無効 */
  var other = issue(ctx, TESTER, 30);
  assert.strictEqual(plain(ctx.sandbox.BookingTestCredential.verify(other.token, TESTER, ctx.clock.currentDate())).ok, true);
  ctx.setProperty('BOOKING_TEST_CREDENTIAL_KEY', 'a-completely-different-rotated-signing-key-123456');
  assert.strictEqual(plain(ctx.sandbox.BookingTestCredential.verify(other.token, TESTER, ctx.clock.currentDate())).reason, 'SIGNATURE');

  /* 鍵が未設定・短すぎる場合は発行も検証もできない（fail-closed）。 */
  ctx.setProperty('BOOKING_TEST_CREDENTIAL_KEY', 'short');
  assert.strictEqual(plain(ctx.sandbox.BookingTestCredential.verify(other.token, TESTER, ctx.clock.currentDate())).reason, 'NOT_CONFIGURED');
  assert.throws(function () { issue(ctx, TESTER, 30); }, /BOOKING_TEST_CREDENTIAL_KEY/);
  ctx.setProperty('BOOKING_TEST_CREDENTIAL_KEY', undefined);
  assert.strictEqual(plain(ctx.sandbox.BookingTestCredential.verify(other.token, TESTER, ctx.clock.currentDate())).ok, false);
});

test('資格の拘束: 発行先の許可メール以外では通らない（別の許可メール・許可外メール・許可リストから外したメール）。メールの表記ゆれは正規化する', function () {
  var ctx = setup();
  var forAdmin = issue(ctx, ADMIN, 60);
  var verify = function (token, email) { return plain(ctx.sandbox.BookingTestCredential.verify(token, email, ctx.clock.currentDate())); };
  assert.strictEqual(verify(forAdmin.token, ADMIN).ok, true);
  assert.strictEqual(verify(forAdmin.token, '  Admin@Example.com ').ok, true, '大文字・前後の空白は正規化');
  assert.strictEqual(verify(forAdmin.token, TESTER).reason, 'EMAIL_MISMATCH', '別の許可メールでは使えない');
  assert.strictEqual(verify(forAdmin.token, STRANGER).reason, 'EMAIL_NOT_ALLOWED');
  assert.strictEqual(verify(forAdmin.token, '').ok, false);
  assert.strictEqual(verify(forAdmin.token, 'not-an-email').ok, false);
  assert.strictEqual(verify(forAdmin.token, undefined).ok, false);

  /* 許可リストから外したら、発行済みの資格も使えなくなる。 */
  ctx.setProperty('BOOKING_TEST_ALLOWED_EMAILS', TESTER);
  assert.strictEqual(verify(forAdmin.token, ADMIN).reason, 'EMAIL_NOT_ALLOWED');

  /* 許可外のメールには発行できない。資格にメールそのものを含めない。 */
  assert.throws(function () { issue(ctx, STRANGER, 60); }, /登録されていません/);
  assert.throws(function () { issue(ctx, 'bad', 60); }, /形式/);
  assert.strictEqual(forAdmin.token.indexOf('admin'), -1);
  assert.strictEqual(forAdmin.token.indexOf('example'), -1);
  assert.ok(/^t1\.[0-9a-f]{16}\.\d{10}\.\d{10}\.[0-9a-f]{32}\.[0-9a-f]{64}$/.test(forAdmin.token));
});

test('資格は会員資格・OTP確認済み証明の代用にならない（TESTでもOTP・証明・メール拘束・actual membershipを緩和しない）', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] }, properties: { BOOKING_TEST_ALLOWED_EMAILS: MEMBER + ',' + ADMIN } });
  var issued = issue(ctx, MEMBER, 60);
  /* 資格だけでは会員料金・特典・先行予約を使えない（証明が必要）。 */
  var noProof = plain(ctx.sandbox.BookingRepository.createBooking({
    brand: 'snb', customerType: 'returning', date: '2026-12-14', startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: MEMBER, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', isMember: true, plan: 'member_pair_3h', testCredential: issued.token
  }, NOV));
  assert.strictEqual(noProof.success, false);
  assert.strictEqual(noProof.error.code, 'MEMBER_VERIFICATION_REQUIRED', 'ペアパックは確認済み証明が無ければ会員台帳を見ずに拒否');
  assert.strictEqual(ctx.lookups.length, 0, '資格だけで会員台帳を参照しない');

  /* 資格付きだが証明なしの一般予約は、自己申告isMemberを無視した一般料金（V2）。 */
  var general = plain(ctx.sandbox.BookingRepository.createBooking({
    brand: 'snb', customerType: 'returning', date: '2026-12-14', startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: MEMBER, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', isMember: true, testCredential: issued.token
  }, NOV));
  assert.strictEqual(general.success, true);
  assert.strictEqual(general.price.tier, 'GENERAL', 'メールが会員台帳にあっても証明が無ければ一般料金');
  var saved = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(general.bookingId).record;
  assert.strictEqual(saved.priceGeneration, 'V2', 'TESTで作った予約はV2として保存される（12/1前のV2＝テスト予約の識別子）');
  assert.strictEqual(saved.membershipStatus, 'UNVERIFIED');

  /* 本物のOTP→証明を通せば、通常のV2と同じく会員料金になる。 */
  var proof = proofHelper.issueProof(ctx.sandbox, ctx.mailApp, MEMBER, NOV);
  var member = plain(ctx.sandbox.BookingRepository.createBooking({
    brand: 'snb', customerType: 'returning', date: '2026-12-15', startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: MEMBER, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', memberProof: proof, testCredential: issued.token
  }, NOV));
  assert.strictEqual(member.success, true);
  assert.strictEqual(member.price.tier, 'MEMBER');
});

// ============================================================================
// createBooking
// ============================================================================

function bookingPayload(overrides) {
  return Object.assign({
    brand: 'snb', customerType: 'returning', date: '2026-12-14', startTime: '10:00', durationMinutes: 180,
    name: '山田太郎', email: STRANGER, phone: '090-1234-5678', people: '2名', purpose: '緊縛の自主練習',
    paymentMethod: '現金', note: '', source: 'test', isMember: false
  }, overrides || {});
}

function create(ctx, overrides, now) {
  return plain(ctx.sandbox.BookingRepository.createBooking(bookingPayload(overrides), now || NOV, 'req-559'));
}

function bookingRows(ctx) {
  return ctx.sheets.Bookings ? ctx.sheets.Bookings._rows.length - 1 : 0;
}

test('createBooking: 通常の一般利用者は12/1前はV1。V1の自己申告isMemberが従来どおり効く（既存V1互換）', function () {
  var ctx = setup();
  var result = create(ctx, { isMember: true });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.price.tier, 'MEMBER', 'V1は自己申告のまま');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record.priceGeneration, 'V1');
  assert.strictEqual(ctx.logger._logs.filter(function (m) { return m.indexOf('generation=') !== -1; }).length, 0, '通常（時刻判定）は監査ログを増やさない');
});

test('createBooking: 許可メールが資格なしで送ってもV1（メール入力だけでTESTにならない）。クライアントの世代・モード指定は無視する', function () {
  var ctx = setup();
  var result = create(ctx, {
    email: ADMIN, isMember: true, priceGeneration: 'V2', generation: 'V2', mode: 'TEST', authMode: 'TEST', BOOKING_AUTH_MODE: 'TEST', testMode: true, verified: true
  });
  assert.strictEqual(result.success, true);
  assert.strictEqual(result.price.tier, 'MEMBER', 'V1のまま');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record.priceGeneration, 'V1');
});

test('createBooking: 有効なテスト資格ならV2で作成。資格が無効（期限切れ・失効・改ざん・他メール・モード変更・緊急停止）ならTEST_CREDENTIAL_INVALIDで何も作らない', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 30);
  var ok = create(ctx, { email: ADMIN, testCredential: issued.token });
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(ok.bookingId).record.priceGeneration, 'V2');
  assert.ok(ctx.logger._logs.some(function (m) { return m.indexOf('requestId=req-559 generation=V2 source=TEST_CREDENTIAL testCredential=VALID') !== -1; }), '世代の決まり方を非機密の監査ログに残す');
  var rows = bookingRows(ctx);

  var cases = [
    ['改ざん', function () { return { email: ADMIN, testCredential: flipLastHex(issued.token) }; }, NOV],
    ['他人のメール', function () { return { email: STRANGER, testCredential: issued.token }; }, NOV],
    ['別の許可メール', function () { return { email: TESTER, testCredential: issued.token }; }, NOV],
    ['期限切れ', function () { return { email: ADMIN, testCredential: issued.token }; }, new Date(NOV.getTime() + 31 * 60000)]
  ];
  cases.forEach(function (c) {
    var result = create(ctx, c[1](), c[2]);
    assert.strictEqual(result.success, false, c[0]);
    assert.strictEqual(result.error.code, 'TEST_CREDENTIAL_INVALID', c[0]);
  });

  ctx.sandbox.BookingTestCredential.revoke(issued.id);
  assert.strictEqual(create(ctx, { email: ADMIN, testCredential: issued.token }).error.code, 'TEST_CREDENTIAL_INVALID', '失効');
  ctx.setProperty('BOOKING_TEST_CREDENTIAL_KEY', undefined);
  assert.strictEqual(create(ctx, { email: ADMIN, testCredential: issued.token }).error.code, 'TEST_CREDENTIAL_INVALID', '鍵なし');
  ctx.setProperty('BOOKING_TEST_CREDENTIAL_KEY', KEY);
  var fresh = issue(ctx, ADMIN, 30);
  ctx.setProperty('BOOKING_AUTH_MODE', 'LIVE');
  assert.strictEqual(create(ctx, { email: ADMIN, testCredential: fresh.token }).error.code, 'TEST_CREDENTIAL_INVALID', 'モード変更');
  ctx.setProperty('BOOKING_AUTH_MODE', 'TEST');
  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', 'ENABLED');
  assert.strictEqual(create(ctx, { email: ADMIN, testCredential: fresh.token }).error.code, 'TEST_CREDENTIAL_INVALID', '緊急停止');
  assert.strictEqual(bookingRows(ctx), rows, '無効な資格では予約を1件も作らない（黙ってV1の料金・特典へ変えない）');
  assert.ok(ctx.logger._logs.every(function (m) { return m.indexOf(issued.token) === -1 && m.indexOf(fresh.token) === -1 && m.indexOf(ADMIN) === -1; }), 'ログに資格・メールを出さない');
});

test('createBooking: 12/1 00:00:00以降は資格が残っていても無視して通常V2（TEST_CREDENTIAL_INVALIDにしない）', function () {
  var ctx = setup({ now: AT_SWITCH });
  var issued = issue(ctx, ADMIN, 30, NOV);
  var result = create(ctx, { email: ADMIN, testCredential: issued.token }, AT_SWITCH);
  assert.strictEqual(result.success, true);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record.priceGeneration, 'V2');
  /* 一般利用者（資格なし）も12/1からV2 */
  var general = create(ctx, { email: STRANGER, isMember: true, date: '2026-12-15' }, AT_SWITCH);
  assert.strictEqual(general.success, true);
  assert.strictEqual(general.price.tier, 'GENERAL', 'V2は自己申告の会員料金を受け付けない');
});

test('createBooking: 緊急停止（ENABLED完全一致）で12/1以降もV1の会員自己申告に戻る。類似値では停止しない。復帰後は既存データを書き換えずV2', function () {
  var ctx = setup({ now: AFTER_SWITCH, properties: { BOOKING_AUTH_MODE: undefined } });
  var v2 = create(ctx, { email: STRANGER, isMember: true, date: '2026-12-14' }, AFTER_SWITCH);
  assert.strictEqual(v2.price.tier, 'GENERAL');
  var v2Record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(v2.bookingId).record;
  assert.strictEqual(v2Record.priceGeneration, 'V2');

  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', 'enabled');
  assert.strictEqual(create(ctx, { email: STRANGER, isMember: true, date: '2026-12-15' }, AFTER_SWITCH).price.tier, 'GENERAL', '小文字では停止しない');

  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', 'ENABLED');
  var legacy = create(ctx, { email: STRANGER, isMember: true, date: '2026-12-16' }, AFTER_SWITCH);
  assert.strictEqual(legacy.success, true);
  assert.strictEqual(legacy.price.tier, 'MEMBER', '緊急停止中はV1の会員自己申告（既知のリスク。READMEで事後確認を運用）');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(legacy.bookingId).record.priceGeneration, 'V1');
  assert.ok(ctx.logger._logs.some(function (m) { return m.indexOf('generation=V1 source=EMERGENCY_LEGACY') !== -1; }));

  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', undefined);
  assert.strictEqual(create(ctx, { email: STRANGER, isMember: true, date: '2026-12-17' }, AFTER_SWITCH).price.tier, 'GENERAL', '復帰後はV2');
  /* 切替前後で既存予約は書き換わらない。 */
  var after = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(v2.bookingId).record;
  assert.strictEqual(after.priceGeneration, 'V2');
  assert.strictEqual(after.priceAmount, v2Record.priceAmount);
});

test('createBooking: Studio Xの新規予約はモード・緊急停止・資格に影響されない（2026/10/26 V2のまま）', function () {
  var ctx = setup({ properties: { BOOKING_AUTH_EMERGENCY_LEGACY: 'ENABLED' } });
  var issued = issue(ctx, ADMIN, 30);
  var result = create(ctx, { brand: 'studio_x', email: ADMIN, testCredential: issued.token, date: '2026-12-14' });
  assert.strictEqual(result.success, true, JSON.stringify(result));
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(result.bookingId).record.priceGeneration, 'V2');
});

test('createBooking: 管理者の新規予約（ADMIN window）はテスト資格を扱わない。緊急停止と時刻だけで判定する', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 30);
  var adminTier = ctx.sandbox.BookingWindow.TIER.ADMIN;
  var withCredential = plain(ctx.sandbox.BookingRepository.createBooking(bookingPayload({ email: ADMIN, testCredential: issued.token, isMember: true }), NOV, 'req-admin', adminTier));
  assert.strictEqual(withCredential.success, true);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(withCredential.bookingId).record.priceGeneration, 'V1', '資格があってもAdminはV1（時刻どおり）');
  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', 'ENABLED');
  var emergency = plain(ctx.sandbox.BookingRepository.createBooking(bookingPayload({ email: ADMIN, isMember: true, date: '2026-12-15' }), AFTER_SWITCH, 'req-admin', adminTier));
  assert.strictEqual(emergency.success, true);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(emergency.bookingId).record.priceGeneration, 'V1', '緊急停止はAdminにも効く');
});

// ============================================================================
// Booking Admin: 検証コード・署名鍵を持たない
// ============================================================================

test('Booking Admin: BookingTestCredential.gsを配布せず、署名鍵・資格検証のコードを含まない。緊急停止と時刻だけで判定する', function () {
  assert.ok(manifest.BOOKING_ADMIN_FILES.indexOf('BookingGenerationMode.gs') !== -1, '世代判定はAdminにも配布');
  assert.strictEqual(manifest.BOOKING_ADMIN_FILES.indexOf('BookingTestCredential.gs'), -1, 'テスト資格はAdminへ配布しない');
  assert.ok(manifest.BOOKING_WEB_APP_FILES.indexOf('BookingTestCredential.gs') !== -1);
  assert.strictEqual(manifest.BOOKING_WEBHOOK_FILES.indexOf('BookingTestCredential.gs'), -1);
  assert.strictEqual(manifest.BOOKING_WEBHOOK_FILES.indexOf('BookingGenerationMode.gs'), -1);

  var gasDir = path.join(__dirname, '..', 'gas', 'booking');
  manifest.BOOKING_ADMIN_FILES.forEach(function (file) {
    var found = ['shared', 'admin', 'public'].map(function (dir) { return path.join(gasDir, dir, file); }).filter(function (p) { return fs.existsSync(p); })[0];
    var source = fs.readFileSync(found, 'utf8');
    assert.ok(!/BOOKING_TEST_CREDENTIAL_KEY|BOOKING_TEST_ALLOWED_EMAILS|BOOKING_TEST_REVOKED_IDS|BookingTestCredential\.(verify|issue|revoke)/.test(source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')) ||
      file === 'BookingGenerationMode.gs', file + 'にテスト資格の鍵・設定を持たない');
  });
  /* Adminで資格を渡されても検証器が存在しないため必ずINVALID（V1のまま）。緊急停止は効く。 */
  var adminFiles = ['Config.gs', 'BookingPricing.gs', 'BookingGenerationMode.gs'];
  var properties = { BOOKING_AUTH_MODE: 'TEST', BOOKING_TEST_CREDENTIAL_KEY: KEY, BOOKING_TEST_ALLOWED_EMAILS: ADMIN };
  var propertiesService = stubs.createPropertiesServiceStub(properties);
  var sandbox = loadBookingSandbox(adminFiles, { PropertiesService: propertiesService });
  assert.strictEqual(typeof sandbox.BookingTestCredential, 'undefined');
  var d = plain(sandbox.BookingGenerationMode.decide(NOV, 'snb', { testCredential: 't1.' + 'a'.repeat(16) + '.1700000000.1900000000.' + 'b'.repeat(32) + '.' + 'c'.repeat(64), email: ADMIN }));
  assert.strictEqual(d.generation, 'V1');
  assert.strictEqual(d.testCredential, 'INVALID');
  assert.strictEqual(plain(sandbox.BookingGenerationMode.describe(NOV)).credentialVerifierPresent, false);
  assert.strictEqual(plain(sandbox.BookingGenerationMode.decide(AT_SWITCH, 'snb')).generation, 'V2');
  propertiesService.getScriptProperties().setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', 'ENABLED');
  assert.strictEqual(plain(sandbox.BookingGenerationMode.decide(AT_SWITCH, 'snb')).generation, 'V1');
  assert.strictEqual(plain(sandbox.BookingGenerationMode.decide(AT_SWITCH, 'studio_x')).generation, 'V2');
});

// ============================================================================
// 既存予約は保存済みpriceGenerationが正本
// ============================================================================

test('既存予約の変更・再見積り・オプション判定は、保存済みpriceGenerationを正本とし、現在のモードや緊急停止を参照しない', function () {
  var gasDir = path.join(__dirname, '..', 'gas', 'booking');
  var strip = function (source) { return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''); };
  ['admin/BookingReschedule.gs', 'admin/BookingAdminWeb.gs', 'admin/BookingRefund.gs', 'shared/OptionOrderService.gs', 'shared/FeeCalculator.gs'].forEach(function (file) {
    var source = strip(fs.readFileSync(path.join(gasDir, file), 'utf8'));
    assert.ok(!/BookingGenerationMode|generationAt\(/.test(source), file + 'は現在の世代判定を使わず保存済みの世代を使う');
  });
  /* 新規予約の世代を決めるのはBookingRepository.createBookingとCode.gsの入口だけ。 */
  var repo = strip(fs.readFileSync(path.join(gasDir, 'shared', 'BookingRepository.gs'), 'utf8'));
  assert.strictEqual((repo.match(/BookingGenerationMode\.decide\(/g) || []).length, 1, 'createBookingの1か所だけ');
  assert.ok(!/BookingPricing\.generationAt\(/.test(repo));
  var code = strip(fs.readFileSync(path.join(gasDir, 'public', 'Code.gs'), 'utf8'));
  assert.ok(!/BookingPricing\.generationAt\(/.test(code), 'Code.gsの入口はすべてBookingGenerationModeを通す');

  /* 実行: 保存済みV1の予約は、緊急停止・TEST設定・12/1以降でも日程変更の再見積りでV1の料金表を使い続ける。 */
  var ctx = setup({ properties: { BOOKING_AUTH_EMERGENCY_LEGACY: undefined } });
  var created = create(ctx, { email: STRANGER, isMember: true, date: '2026-12-14' }, BEFORE_SWITCH);
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(created.bookingId).record.priceGeneration, 'V1');
  ctx.setNow(AFTER_SWITCH);
  var record = ctx.sandbox.SpreadsheetRepository.findRowByBookingId(created.bookingId).record;
  assert.strictEqual(ctx.sandbox.BookingPricing.normalizeGeneration(record.priceGeneration), 'V1', '12/1以降に読んでも保存済みのV1');
  ctx.setProperty('BOOKING_AUTH_EMERGENCY_LEGACY', 'ENABLED');
  assert.strictEqual(ctx.sandbox.SpreadsheetRepository.findRowByBookingId(created.bookingId).record.priceGeneration, 'V1');
});

// ============================================================================
// Web App: POST（text/plainのJSON本文）と通常GETの一致
// ============================================================================

function postJson(ctx, action, body) {
  var out = ctx.sandbox.doPost({ parameter: { action: action }, postData: { contents: JSON.stringify(body), type: 'text/plain' } });
  return JSON.parse(out.text);
}

function getJson(ctx, params) {
  return JSON.parse(ctx.sandbox.doGet({ parameter: params }).text);
}

test('POST testMonthly / testEstimatePrice: 有効な資格はV2（priceGeneration・見積り・UI）。同じ条件の匿名GETは従来どおりV1。応答は矛盾しない', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 60);
  var monthlyBody = { year: 2026, month: 12, durationMinutes: 180, brand: 'snb', timeBand: 'all', email: ADMIN, testCredential: issued.token };

  var viaPost = postJson(ctx, 'testMonthly', monthlyBody);
  assert.strictEqual(viaPost.success, true, JSON.stringify(viaPost));
  assert.strictEqual(viaPost.priceGeneration, 'V2');
  assert.strictEqual(viaPost.testCredentialStatus, 'VALID');
  var viaGet = getJson(ctx, { action: 'monthly', year: '2026', month: '12', durationMinutes: '180', brand: 'snb', timeBand: 'all' });
  assert.strictEqual(viaGet.success, true);
  assert.strictEqual(viaGet.priceGeneration, 'V1', '匿名GETはV1');
  assert.strictEqual(viaGet.testCredentialStatus, undefined, '資格を送っていないGETの応答形は変えない');
  assert.deepStrictEqual(plain(viaPost.days), plain(viaGet.days), '空き状況（日ごとの結果）は同じ');

  var estimateBody = { brand: 'snb', date: '2026-12-14', durationMinutes: '180', isMember: '1', plan: '', email: ADMIN, testCredential: issued.token };
  var estimatePost = postJson(ctx, 'testEstimatePrice', estimateBody);
  assert.strictEqual(estimatePost.success, true, JSON.stringify(estimatePost));
  assert.strictEqual(estimatePost.priceGeneration, 'V2');
  assert.strictEqual(estimatePost.price.tier, 'GENERAL', 'V2のSNBは見積りで自己申告の会員料金を受け付けない');
  assert.strictEqual(estimatePost.testCredentialStatus, 'VALID');
  var estimateGet = getJson(ctx, { action: 'estimatePrice', brand: 'snb', date: '2026-12-14', durationMinutes: '180', isMember: '1' });
  assert.strictEqual(estimateGet.priceGeneration, 'V1');
  assert.strictEqual(estimateGet.price.tier, 'MEMBER', '匿名GETはV1の自己申告のまま');
  assert.strictEqual(estimateGet.testCredentialStatus, undefined);
});

test('POST testMonthly / testEstimatePrice: 無効な資格（改ざん・他メール・期限切れ・失効・モード変更）はINVALIDでV1。URLクエリ・GETの資格は無視する', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 30);
  var base = { year: '2026', month: '12', durationMinutes: '180', brand: 'snb', timeBand: 'all' };
  var invalidCases = [
    ['改ざん', Object.assign({}, base, { email: ADMIN, testCredential: flipLastHex(issued.token) })],
    ['他人のメール', Object.assign({}, base, { email: STRANGER, testCredential: issued.token })]
  ];
  invalidCases.forEach(function (c) {
    var body = postJson(ctx, 'testMonthly', c[1]);
    assert.strictEqual(body.success, true, c[0]);
    assert.strictEqual(body.priceGeneration, 'V1', c[0]);
    assert.strictEqual(body.testCredentialStatus, 'INVALID', c[0]);
    assert.strictEqual(JSON.stringify(body).indexOf(issued.token), -1, '応答に資格を含めない');
  });
  ctx.clock.advanceByMillis(31 * 60000);
  assert.strictEqual(postJson(ctx, 'testMonthly', Object.assign({}, base, { email: ADMIN, testCredential: issued.token })).testCredentialStatus, 'INVALID', '期限切れ');
  ctx.clock.advanceByMillis(-31 * 60000);
  ctx.sandbox.BookingTestCredential.revoke(issued.id);
  assert.strictEqual(postJson(ctx, 'testEstimatePrice', { brand: 'snb', date: '2026-12-14', durationMinutes: '180', email: ADMIN, testCredential: issued.token }).testCredentialStatus, 'INVALID', '失効');

  /* GETのクエリに資格・世代・モードを載せても無視する（メール入力だけでも昇格しない）。 */
  var viaQuery = getJson(ctx, Object.assign({ action: 'monthly', email: ADMIN, testCredential: issued.token, priceGeneration: 'V2', mode: 'TEST' }, base));
  assert.strictEqual(viaQuery.priceGeneration, 'V1');
  assert.strictEqual(viaQuery.testCredentialStatus, undefined);
  var viaQueryEstimate = getJson(ctx, { action: 'estimatePrice', brand: 'snb', date: '2026-12-14', durationMinutes: '180', email: ADMIN, testCredential: issued.token, generation: 'V2' });
  assert.strictEqual(viaQueryEstimate.priceGeneration, 'V1');
});

test('POST testMonthly: 形式不正のJSONはINVALID_JSON。想定外の例外は汎用INTERNAL_ERROR（資格・メール・本文をログに出さない）', function () {
  var ctx = setup();
  var issued = issue(ctx, ADMIN, 30);
  var bad = JSON.parse(ctx.sandbox.doPost({ parameter: { action: 'testMonthly' }, postData: { contents: '{not json' } }).text);
  assert.strictEqual(bad.success, false);
  assert.strictEqual(bad.error.code, 'INVALID_JSON');
  /* 空き状況が取得できない構成でも、スタックトレースや内部文言を返さない。 */
  var ctx2 = setup({ properties: { CALENDAR_ID: undefined } });
  var body = postJson(ctx2, 'testMonthly', { year: '2026', month: '12', durationMinutes: '180', brand: 'snb', email: ADMIN, testCredential: issued.token });
  assert.strictEqual(body.success, false);
  assert.ok(body.error && /^[A-Z_]+$/.test(body.error.code));
  assert.ok(ctx.logger._logs.concat(ctx2.logger._logs).every(function (m) { return m.indexOf(issued.token) === -1 && m.indexOf(ADMIN) === -1; }));
});

test('POST bookingMemberStatus: 有効なテスト資格なら12/1前でも会員確認（V2）の応答。資格なしは従来どおりMEMBER_VERIFICATION_NOT_REQUIRED。確認済み証明は緩和しない', function () {
  var ctx = setup({ members: { [MEMBER]: ['2026-12'] }, properties: { BOOKING_TEST_ALLOWED_EMAILS: MEMBER } });
  var issued = issue(ctx, MEMBER, 60);
  var without = postJson(ctx, 'bookingMemberStatus', { brand: 'snb', email: MEMBER, proof: 'x'.repeat(40), date: '2026-12-14' });
  assert.strictEqual(without.success, false);
  assert.strictEqual(without.error.code, 'MEMBER_VERIFICATION_NOT_REQUIRED');
  assert.strictEqual(without.priceGeneration, 'V1');

  var noProof = postJson(ctx, 'bookingMemberStatus', { brand: 'snb', email: MEMBER, date: '2026-12-14', testCredential: issued.token });
  assert.strictEqual(noProof.success, false, '資格だけでは会員情報を返さない');
  assert.ok(['MEMBER_VERIFICATION_REQUIRED', 'MEMBER_REVERIFY_REQUIRED'].indexOf(noProof.error.code) !== -1, noProof.error.code);
  assert.strictEqual(ctx.lookups.length, 0);

  var proof = proofHelper.issueProof(ctx.sandbox, ctx.mailApp, MEMBER, NOV);
  var status = postJson(ctx, 'bookingMemberStatus', {
    brand: 'snb', email: MEMBER, proof: proof, date: '2026-12-14', durationMinutes: 180, testCredential: issued.token
  });
  assert.strictEqual(status.success, true, JSON.stringify(status));
  assert.strictEqual(status.priceGeneration, 'V2');
  assert.strictEqual(status.testCredentialStatus, 'VALID');
  assert.strictEqual(status.memberOnDate, true);
  assert.strictEqual(status.price.tier, 'MEMBER');

  /* 他人の証明・メール不一致では通らない。 */
  var wrongEmail = postJson(ctx, 'bookingMemberStatus', { brand: 'snb', email: STRANGER, proof: proof, date: '2026-12-14', testCredential: issued.token });
  assert.strictEqual(wrongEmail.success, false);
  assert.strictEqual(wrongEmail.priceGeneration, 'V1', '他人のメール＋資格はTESTにならない');
});

// ============================================================================
// 発行関数（エディタ実行）・失効・監査
// ============================================================================

test('issueBookingTestLink: 許可メール宛に3ページ分のフラグメント付きリンクをメール送信。戻り値・ログに資格・メールを出さない。公開APIからは呼べない', function () {
  var ctx = setup();
  var result = plain(ctx.sandbox.issueBookingTestLink(ADMIN, 120));
  assert.deepStrictEqual(Object.keys(result).sort(), ['credentialId', 'expiresAt']);
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
  var mail = ctx.mailApp._sentEmails[0];
  assert.strictEqual(mail.to, ADMIN);
  var tokens = mail.body.match(/#bt=(t1\.[0-9a-f.]+)/g);
  assert.strictEqual(tokens.length, 3, 'SNB・mens・英語版の3リンク');
  assert.ok(/\/Studio-nagoya-base\/booking\/#bt=/.test(mail.body));
  assert.ok(/\/Studio-nagoya-base\/mens\/booking\/#bt=/.test(mail.body));
  assert.ok(/\/Studio-nagoya-base\/booking\/en\.html#bt=/.test(mail.body));
  assert.ok(mail.body.split('\n').every(function (line) { return line.indexOf('#bt=') === -1 || line.indexOf('?') === -1; }), '資格はクエリ文字列に載せない（フラグメントのみ）');
  var token = tokens[0].substring(4);
  assert.strictEqual(plain(ctx.sandbox.BookingTestCredential.verify(token, ADMIN, ctx.clock.currentDate())).ok, true);
  ctx.logger._logs.forEach(function (m) {
    assert.strictEqual(m.indexOf(token), -1, 'ログに資格を出さない');
    assert.strictEqual(m.indexOf(ADMIN), -1, 'ログにメールを出さない');
    assert.strictEqual(m.indexOf(KEY), -1);
  });
  assert.ok(ctx.logger._logs.some(function (m) { return m.indexOf('id=' + result.credentialId) !== -1; }), '資格IDは監査ログに残す');

  /* 許可外メールは発行もメール送信もしない。 */
  assert.throws(function () { ctx.sandbox.issueBookingTestLink(STRANGER); }, /登録されていません/);
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
  /* doGet / doPostにはissue・revoke・statusのルートが無い（action指定でも呼べない）。 */
  ['issueBookingTestLink', 'revokeBookingTestCredential', 'showBookingAuthModeStatus', 'issue', 'revoke'].forEach(function (action) {
    var out = JSON.parse(ctx.sandbox.doPost({ parameter: { action: action }, postData: { contents: JSON.stringify({ email: ADMIN }) } }).text);
    assert.strictEqual(out.success, false, action);
  });
  assert.strictEqual(ctx.mailApp._sentEmails.length, 1);
});

test('issueBookingTestLink: メール送信枠が予約通知用の残り以下なら送らない', function () {
  var ctx = setup({ mail: { remainingQuota: 50 } });
  assert.throws(function () { ctx.sandbox.issueBookingTestLink(ADMIN, 60); }, /残枠/);
  assert.strictEqual(ctx.mailApp._sentEmails.length, 0);
});

test('revokeBookingTestCredential / showBookingAuthModeStatus: 失効を失効リストへ追記。状態は機密情報を含まない監査ログに出す', function () {
  var ctx = setup({ properties: { BOOKING_AUTH_EMERGENCY_LEGACY: 'ENABLED' } });
  var issued = issue(ctx, ADMIN, 60);
  assert.strictEqual(ctx.sandbox.revokeBookingTestCredential(issued.id), 1);
  assert.strictEqual(plain(ctx.sandbox.BookingTestCredential.verify(issued.token, ADMIN, ctx.clock.currentDate())).reason, 'REVOKED');

  var status = plain(ctx.sandbox.showBookingAuthModeStatus());
  assert.strictEqual(status.mode, 'TEST');
  assert.strictEqual(status.emergencyLegacy, true);
  assert.strictEqual(status.testDeadline, '2026-11-30T15:00:00.000Z', '12/1 0:00 JST');
  assert.strictEqual(status.beforeSwitch, true);
  assert.strictEqual(status.credentialVerifierPresent, true);
  assert.deepStrictEqual(status.generalUser, { snb: 'V1', mens: 'V1', studio_x: 'V2' });
  var logged = ctx.logger._logs.filter(function (m) { return m.indexOf('BookingGenerationMode:') === 0; });
  assert.strictEqual(logged.length, 1);
  [KEY, ADMIN, TESTER, issued.token].forEach(function (secret) {
    assert.strictEqual(logged[0].indexOf(secret), -1);
  });
});
