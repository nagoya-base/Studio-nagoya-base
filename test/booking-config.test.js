/*
 * gas/booking/Config.gs のテスト。PropertiesServiceはスタブする。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');

function loadConfig(properties) {
  var sandbox = loadBookingSandbox(['Config.gs'], {
    PropertiesService: stubs.createPropertiesServiceStub(properties || {})
  });
  return sandbox.BookingConfig;
}

test('Script Propertiesが空でも固定仕様のデフォルト値が使われる', function () {
  var BookingConfig = loadConfig({});
  var config = BookingConfig.getAvailabilityConfig();
  /* config はvmサンドボックス（別realm）で生成されたオブジェクトのため、非strict deepEqualで比較する。 */
  assert.deepEqual(config, {
    timezone: 'Asia/Tokyo',
    openTime: '08:00',
    closeTime: '23:00',
    minBookingMinutes: 120,
    bufferMinutes: 15,
    slotStepMinutes: 15
  });
});

test('Script Propertiesの値がデフォルトより優先される', function () {
  var BookingConfig = loadConfig({ OPEN_TIME: '09:00', BUFFER_MINUTES: '20' });
  var config = BookingConfig.getAvailabilityConfig();
  assert.strictEqual(config.openTime, '09:00');
  assert.strictEqual(config.bufferMinutes, 20);
  assert.strictEqual(config.closeTime, '23:00', '未設定の項目はデフォルトのまま');
});

test('CALENDAR_IDが未設定の場合はエラーを投げる', function () {
  var BookingConfig = loadConfig({});
  assert.throws(function () {
    BookingConfig.getCalendarId();
  });
});

test('CALENDAR_IDが設定されていれば取得できる', function () {
  var BookingConfig = loadConfig({ CALENDAR_ID: 'test-calendar-id@group.calendar.google.com' });
  assert.strictEqual(BookingConfig.getCalendarId(), 'test-calendar-id@group.calendar.google.com');
});

/* getBookingAdminUrl（Issue #311）: AdminNotifier.gsが管理者通知メールへBooking Adminリンクを
   載せるかどうかの判定に使う。ADMIN_NOTIFICATION_EMAIL等と同じくfail-closed（未設定なら空文字）。 */
test('getBookingAdminUrl: BOOKING_ADMIN_URLが未設定なら空文字を返す', function () {
  var BookingConfig = loadConfig({});
  assert.strictEqual(BookingConfig.getBookingAdminUrl(), '');
});

test('getBookingAdminUrl: BOOKING_ADMIN_URLが設定されていればそのまま返す', function () {
  var BookingConfig = loadConfig({
    BOOKING_ADMIN_URL: 'https://script.google.com/macros/s/EXAMPLE_ADMIN_DEPLOY_ID/exec'
  });
  assert.strictEqual(
    BookingConfig.getBookingAdminUrl(),
    'https://script.google.com/macros/s/EXAMPLE_ADMIN_DEPLOY_ID/exec'
  );
});

test('数値項目の誤設定はConfig.gs自体では例外にせずNaNとして返す（fail-closed判定はAvailability.gs側のvalidateInputが担う）', function () {
  var BookingConfig = loadConfig({ BUFFER_MINUTES: 'abc', SLOT_STEP_MINUTES: '0' });
  var config = BookingConfig.getAvailabilityConfig();
  assert.ok(isNaN(config.bufferMinutes));
  assert.strictEqual(config.slotStepMinutes, 0);
});

test('数値項目は文字列全体が厳密な整数のときだけ数値化し、末尾・先頭に余計な文字があればNaNにする（"15abc"を15として通さない）', function () {
  var invalidValues = ['15abc', '120foo', '15xyz', '15.5', ' 15', '15 ', '1e3', '0x0F', '十五', ''];
  invalidValues.forEach(function (rawValue) {
    var BookingConfig = loadConfig({
      MIN_BOOKING_MINUTES: rawValue,
      BUFFER_MINUTES: rawValue,
      SLOT_STEP_MINUTES: rawValue
    });
    var config = BookingConfig.getAvailabilityConfig();
    if (rawValue === '') {
      // 空文字はプロパティ未設定と同じ扱いでデフォルト値になる（readProperty_の既存仕様）。
      assert.strictEqual(config.minBookingMinutes, 120, JSON.stringify(rawValue));
      assert.strictEqual(config.bufferMinutes, 15, JSON.stringify(rawValue));
      assert.strictEqual(config.slotStepMinutes, 15, JSON.stringify(rawValue));
      return;
    }
    assert.ok(isNaN(config.minBookingMinutes), 'MIN_BOOKING_MINUTES=' + JSON.stringify(rawValue) + ' はNaNになるべき');
    assert.ok(isNaN(config.bufferMinutes), 'BUFFER_MINUTES=' + JSON.stringify(rawValue) + ' はNaNになるべき');
    assert.ok(isNaN(config.slotStepMinutes), 'SLOT_STEP_MINUTES=' + JSON.stringify(rawValue) + ' はNaNになるべき');
  });
});

test('数値項目は先頭0を持たない/持つ通常の整数文字列なら正しく数値化する', function () {
  var BookingConfig = loadConfig({ MIN_BOOKING_MINUTES: '90', BUFFER_MINUTES: '0', SLOT_STEP_MINUTES: '30' });
  var config = BookingConfig.getAvailabilityConfig();
  assert.strictEqual(config.minBookingMinutes, 90);
  assert.strictEqual(config.bufferMinutes, 0);
  assert.strictEqual(config.slotStepMinutes, 30);
});

test('getTtlConfig: Script Propertiesが空でも固定仕様のデフォルト値が使われる（Issue #270でminHoldHours/timezoneを追加）', function () {
  var BookingConfig = loadConfig({});
  var config = BookingConfig.getTtlConfig();
  assert.deepEqual(config, {
    ttlHours: 24,
    minHoursBeforeStart: 2,
    minHoldHours: 2,
    timezone: 'Asia/Tokyo'
  });
});

test('getTtlConfig: PENDING_TTL_MIN_HOLD_HOURSはScript Propertiesで変更でき、誤設定（数値以外・0以下）は例外にせずデフォルトへフォールバックする（Issue #270）', function () {
  var overridden = loadConfig({ PENDING_TTL_MIN_HOLD_HOURS: '3' }).getTtlConfig();
  assert.strictEqual(overridden.minHoldHours, 3);

  ['abc', '0', '-1', ''].forEach(function (rawValue) {
    var config = loadConfig({ PENDING_TTL_MIN_HOLD_HOURS: rawValue }).getTtlConfig();
    assert.strictEqual(config.minHoldHours, 2, JSON.stringify(rawValue) + ' はデフォルト値(2)へフォールバックするべき');
  });
});

test('getTtlConfig: timezoneはTIMEZONEプロパティと共有される（expirePendingBookingsの当日判定に使う）', function () {
  var BookingConfig = loadConfig({ TIMEZONE: 'Asia/Tokyo' });
  assert.strictEqual(BookingConfig.getTtlConfig().timezone, 'Asia/Tokyo');
  assert.strictEqual(BookingConfig.getAvailabilityConfig().timezone, 'Asia/Tokyo');
});

/* Issue #271: 利用者向けメール設定（PRレビュー対応でtimezoneを追加）。 */

test('getMailConfig: Script Propertiesが空でも既定値(timezone=Asia/Tokyo・他は空文字)を返す', function () {
  var BookingConfig = loadConfig({});
  var config = BookingConfig.getMailConfig();
  assert.deepEqual(config, {
    displayName: '',
    replyTo: '',
    contactEmail: '',
    timezone: 'Asia/Tokyo'
  });
});

test('getMailConfig: 設定した値がそのまま返る', function () {
  var BookingConfig = loadConfig({
    BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
    BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
    BOOKING_CONTACT_EMAIL: 'contact@example.com'
  });
  var config = BookingConfig.getMailConfig();
  assert.strictEqual(config.displayName, 'Studio Nagoya Base');
  assert.strictEqual(config.replyTo, 'noreply@example.com');
  assert.strictEqual(config.contactEmail, 'contact@example.com');
});

test('getMailConfig: TIMEZONEを上書きすると、getAvailabilityConfig/getTtlConfigと同じ値がmail configにも反映される（PRレビュー対応。新しいScript Propertyは追加しない）', function () {
  var BookingConfig = loadConfig({ TIMEZONE: 'UTC' });
  assert.strictEqual(BookingConfig.getMailConfig().timezone, 'UTC');
  assert.strictEqual(BookingConfig.getAvailabilityConfig().timezone, 'UTC');
  assert.strictEqual(BookingConfig.getTtlConfig().timezone, 'UTC');
});

test('getAccessGuideConfig: Script Propertiesが空ならすべて空文字（entryMethodを含む）', function () {
  var BookingConfig = loadConfig({});
  var config = BookingConfig.getAccessGuideConfig();
  assert.deepEqual(config, {
    address: '',
    building: '',
    room: '',
    entrance: '',
    keyboxLocation: '',
    keyboxNumber: '',
    unlockCode: '',
    entryMethod: '',
    url: '',
    pdfUrl: ''
  });
});

test('getAccessGuideConfig: ACCESS_GUIDE_ENTRY_METHOD（PRレビュー対応で追加）を含む全項目が設定値どおりに返る', function () {
  var BookingConfig = loadConfig({
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
  var config = BookingConfig.getAccessGuideConfig();
  assert.strictEqual(config.entryMethod, '玄関の暗証番号を入力して解錠');
  assert.strictEqual(config.keyboxNumber, 'TEST-KEYBOX');
  assert.strictEqual(config.unlockCode, 'TEST-CODE');
  assert.strictEqual(config.url, 'https://example.com/how-to');
  assert.strictEqual(config.pdfUrl, 'https://example.com/guide.pdf');
});
