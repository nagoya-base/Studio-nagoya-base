/*
 * Issue #881: 個別暗証番号を3ブランド（SNB / Mens / Studio X）の新規予約へ正式適用する切替の最小テスト。
 *  - 予約別暗証番号の通知メール（Access GAS）: 冒頭2行のみ。別送の括弧書きを出さない。
 *  - 予約確定メール（Booking）: 新方式対象予約だけ別送案内を足し、旧共通コードは出さない。対象外・OFFは本文不変。
 *  - Access GASの正式運用設定（eligibleBrands 3件・limitedRollout=false・pilotBookingIds キー削除）が
 *    現行の旧形式 ACCESS_CONFIG の契約・バリデーションに合致し、非承認・不適格予約には発行しないこと。
 * 予約ID・コード・deviceId・宛先はすべて架空のテスト値。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var BOOKING_ADMIN_FILES = require('./helpers/booking-deployment-manifest').BOOKING_ADMIN_FILES;
var Infra = require('../gas/switchbot-access/SwitchBotAccessInfra.gs');
var Core = require('../gas/switchbot-access/SwitchBotAccessCore.gs');
var H = require('./helpers/switchbot-access-world');

var NOTICE = [
  '入室用の暗証番号は、ご予約ごとに専用の番号を発行し、このメールとは別のメールでお送りします。',
  'お届けは利用日前日の18時以降です（それ以降に確定したご予約は、確定後に順次お送りします）。',
  '暗証番号のメールが届かない場合は、このメールにご返信ください。'
].join('\n');

// ---------- 予約別暗証番号の通知メール（Access GAS） ----------

test('通知メール: 冒頭は2行のみで、別送である旨の括弧書きを出さない。暗証番号以下は従来どおり', function () {
  var st = Infra.deliverySettings({ delivery: Object.assign({}, H.DELIVERY_CFG, { senderName: 'スタジオ名古屋ベース' }) });
  var start = Core.jstToEpochSec('2030-01-11', '09:44'), end = Core.jstToEpochSec('2030-01-11', '12:15');
  var m = Infra.renderCodeMail({ code: '12345678', startSec: start, endSec: end, kind: 'INITIAL', bookingRef: 'SNB-1', settings: st });
  var lines = m.body.split('\n');
  assert.deepStrictEqual(lines.slice(0, 3), ['スタジオ名古屋ベースです。', 'ご予約の入室用の暗証番号をお送りします。', '']);
  assert.ok(!/予約確認メールとは別/.test(m.body));
  assert.ok(!/（この暗証番号は/.test(m.body));
  assert.strictEqual(lines[3], '■ 暗証番号: 12345678');
  assert.ok(/^■ ご利用可能な時間: /.test(lines[4]));
  assert.ok(/^■ 対象: /.test(lines[5]));
  assert.ok(m.body.indexOf('【ご利用にあたって】') !== -1);
  assert.ok(m.body.indexOf('【お問い合わせ】') !== -1);
  var c = Infra.renderCodeMail({ code: '12345678', startSec: start, endSec: end, kind: 'CHANGE', previousInvalidated: true, bookingRef: 'SNB-1', settings: st });
  assert.ok(!/予約確認メールとは別/.test(c.body), '変更案内でも括弧書きを出さない');
});

// ---------- 予約確定メール（Booking） ----------

var BASE_PROPS = {
  SPREADSHEET_ID: 'ss1', CALENDAR_ID: 'cal1',
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base', BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com', ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
  ACCESS_GUIDE_KEYBOX_NUMBER: 'TEST-KEYBOX', ACCESS_GUIDE_UNLOCK_CODE: 'TEST-OLD-FIXED-CODE'
};

function setup(props) {
  var mailApp = stubs.createMailAppStub();
  var sandbox = loadBookingSandbox(BOOKING_ADMIN_FILES, {
    PropertiesService: stubs.createPropertiesServiceStub(Object.assign({}, BASE_PROPS, props || {})),
    SpreadsheetApp: stubs.createSpreadsheetAppStub({ ss1: {} }),
    LockService: stubs.createLockServiceStub(),
    MailApp: mailApp,
    ScriptApp: stubs.createScriptAppStub(),
    Logger: stubs.createLoggerStub()
  });
  return { sandbox: sandbox, mailApp: mailApp };
}

function confirmedBody(ctx, id, brand) {
  ctx.sandbox.SpreadsheetRepository.appendBooking({
    bookingId: id, createdAt: new Date('2030-01-05T10:00:00+09:00'), date: '2030-01-11',
    startAt: new Date('2030-01-11T10:00:00+09:00'), endAt: new Date('2030-01-11T12:00:00+09:00'),
    brand: brand, name: '山田太郎', email: 'taro@example.com', phone: '090-0000-0000',
    people: '2名', purpose: '練習', paymentMethod: '現金', status: 'CONFIRMED',
    calendarEventId: 'e1', source: 'test', note: '', confirmedAt: new Date('2030-01-05T10:00:00+09:00'),
    expiredAt: '', cancelledAt: '', updatedAt: '', customerType: 'returning',
    pendingMailSentAt: new Date('2030-01-05T10:00:00+09:00'), confirmedMailSentAt: '',
    cancelMailSentAt: '', reminderSentAt: '', accessGuideSentAt: '',
    lastMailErrorAt: '', lastMailErrorType: '', lastMailErrorMessage: ''
  });
  var r = ctx.sandbox.BookingMailer.sendConfirmedMailForBooking(id);
  assert.strictEqual(r.success, true, JSON.stringify(r));
  var mails = ctx.mailApp._sentEmails;
  return mails[mails.length - 1].body;
}

function assertNoSecrets(body) {
  assert.strictEqual(body.indexOf('TEST-OLD-FIXED-CODE'), -1, '旧共通コードを載せない');
  assert.strictEqual(body.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(body.indexOf('解錠コード'), -1);
}

test('確定メール ALL: 3ブランドの新規予約は個別暗証番号の別送を案内し、旧共通コードを載せない', function () {
  var ctx = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL' });
  ['snb', 'mens', 'studio_x'].forEach(function (brand, i) {
    var body = confirmedBody(ctx, 'C-' + i, brand);
    assert.ok(body.indexOf(NOTICE) !== -1, brand);
    assert.ok(body.indexOf('来場方法・キーボックス等の詳細案内は') !== -1, '来場案内の一文は従来どおり');
    assertNoSecrets(body);
  });
});

test('確定メール: OFF（既定）・PILOT対象外・対象外ブランドは本文不変（別送案内なし）', function () {
  var off = setup({});
  var b1 = confirmedBody(off, 'O-1', 'snb');
  assert.strictEqual(b1.indexOf('入室用の暗証番号'), -1);
  assertNoSecrets(b1);
  var pilot = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'PILOT', ACCESS_PER_BOOKING_CODE_PILOT_IDS: 'P-1' });
  assert.ok(confirmedBody(pilot, 'P-1', 'snb').indexOf(NOTICE) !== -1);
  assert.strictEqual(confirmedBody(pilot, 'P-2', 'snb').indexOf('入室用の暗証番号'), -1);
  var all = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL' });
  assert.strictEqual(confirmedBody(all, 'X-1', 'other').indexOf('入室用の暗証番号'), -1);
});

// ---------- Access GAS の正式運用設定（旧形式 ACCESS_CONFIG） ----------

var DEV = H.DEV;
var NOW = Math.floor(Date.parse('2030-01-10T13:00:00+09:00') / 1000);

function prodCfg(over) {
  var c = H.baseCfg(Object.assign({
    eligibleBrands: ['snb', 'mens', 'studio_x'],
    limitedRollout: false,
    keypads: [
      { brand: 'snb', facility: 'main', deviceId: DEV },
      { brand: 'mens', facility: 'main', deviceId: DEV },
      { brand: 'studio_x', facility: 'main', deviceId: DEV }
    ]
  }, over || {}));
  delete c.enabled;
  return c;
}

function loadLegacy(cfg) {
  var props = { ACCESS_CONFIG: JSON.stringify(cfg), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'true' };
  return Infra.loadConfig(function (k) { return props[k] === undefined ? null : props[k]; });
}

function booking(over) {
  return Object.assign({
    bookingId: 'ANY-0001', revision: 1, status: 'CONFIRMED', paymentStatus: 'STRIPE_PAID', brand: 'snb',
    facility: 'main', room: null, date: '2030-01-11', startTime: '10:00', endTime: '12:00'
  }, over || {});
}

test('正式運用設定（3ブランド・limitedRollout=false・pilotBookingIdsキーなし）は旧形式のまま VALID / READY', function () {
  var r = loadLegacy(prodCfg());
  assert.strictEqual(r.source, 'LEGACY');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(Infra.validateConfig(r.cfg).ok, true);
  var rd = Infra.issuanceReadiness(r.cfg);
  assert.strictEqual(rd.state, 'READY', JSON.stringify(rd.problems));
  assert.strictEqual(rd.limitedRollout, 'OFF');
  assert.strictEqual(rd.pilotBookingIds, 0);
  assert.strictEqual(rd.brands, 3);
  // limitedRollout キー自体を削除しても同じ（未設定＝通常モード）
  var noKey = prodCfg(); delete noKey.limitedRollout;
  assert.strictEqual(Infra.issuanceReadiness(loadLegacy(noKey).cfg).state, 'READY');
});

test('正式運用設定: 3ブランドの承認済み予約は予約IDを問わず発行対象、非承認・不適格予約は発行しない', function () {
  var cfg = loadLegacy(prodCfg()).cfg;
  ['snb', 'mens', 'studio_x'].forEach(function (brand, i) {
    var ok = Core.evaluateEligibility(booking({ bookingId: 'ANY-' + i, brand: brand }), cfg, NOW);
    assert.strictEqual(ok.eligible, true, brand);
  });
  var no = function (over) { return Core.evaluateEligibility(booking(over), cfg, NOW).reason; };
  assert.strictEqual(no({ status: 'PENDING' }), 'NOT_CONFIRMED');
  assert.strictEqual(no({ paymentStatus: 'UNPAID' }), 'PAYMENT_NOT_ELIGIBLE');
  assert.strictEqual(no({ brand: 'other' }), 'BRAND_NOT_TARGET');
  assert.strictEqual(no({ date: '2030-01-09' }), 'ALREADY_ENDED');
  // ACCESS_ENABLED が true 以外なら停止
  var props = { ACCESS_CONFIG: JSON.stringify(prodCfg()), ACCESS_ENVIRONMENT: 'production', ACCESS_ENABLED: 'false' };
  var offCfg = Infra.loadConfig(function (k) { return props[k] === undefined ? null : props[k]; }).cfg;
  assert.strictEqual(Core.evaluateEligibility(booking(), offCfg, NOW).reason, 'FLAG_OFF');
});

test('pilotBookingIds=[] を残したまま限定解除すると全件停止・診断NG（キーごと削除が正）', function () {
  var cfg = loadLegacy(prodCfg({ pilotBookingIds: [] })).cfg;
  assert.strictEqual(Core.evaluateEligibility(booking(), cfg, NOW).reason, 'NOT_PILOT_TARGET');
  var rd = Infra.issuanceReadiness(cfg);
  assert.notStrictEqual(rd.state, 'READY');
  assert.ok(rd.problems.indexOf('PILOT_WITHOUT_LIMITED_ROLLOUT') !== -1);
  // 1件許可リストのまま limitedRollout=false にしても『正式運用』にはならない（診断NG・他予約は発行しない）
  var still = loadLegacy(prodCfg({ pilotBookingIds: ['PILOT-1'] })).cfg;
  assert.ok(Infra.issuanceReadiness(still).problems.indexOf('PILOT_WITHOUT_LIMITED_ROLLOUT') !== -1);
  assert.strictEqual(Core.evaluateEligibility(booking(), still, NOW).reason, 'NOT_PILOT_TARGET');
});
