/*
 * Issue #832: 前日リマインドの新方式（予約別パスコードを独立Access GASが別メールで送る）。
 * 新方式対象予約から旧固定「解錠コード」行（ラベル・値）を除去し、運営指定の一文を
 * 句読点まで一致で出す。オートロック用キーボックス位置・番号は保持する。
 * 設定: ACCESS_PER_BOOKING_CODE_MODE(OFF/PILOT/ALL) / ACCESS_PER_BOOKING_CODE_PILOT_IDS。
 * 予約ID・コード実値は架空のテスト値のみ。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var BOOKING_ADMIN_FILES = require('./helpers/booking-deployment-manifest').BOOKING_ADMIN_FILES;

var SPREADSHEET_ID = 'ss1';
/* Issue #881: 予約別暗証番号の別送案内（配送時期・未着時の返信案内つき）。#832の一文は置き換え済み。 */
var NOTICE = [
  '入室用の暗証番号は、ご予約ごとに専用の番号を発行し、このメールとは別のメールでお送りします。',
  'お届けは利用日前日の18時以降です（それ以降に確定したご予約は、確定後に順次お送りします）。',
  '暗証番号のメールが届かない場合は、このメールにご返信ください。'
].join('\n');
var NOTICE_832 = 'パスコードは別途お送りするメールでお知らせします';
var OLD_NOTICE = '入室用の暗証番号は、別のメールでお送りします。';
var NOW = new Date('2026-10-01T18:00:00+09:00');

var BASE_PROPS = {
  SPREADSHEET_ID: SPREADSHEET_ID,
  CALENDAR_ID: 'cal1',
  BOOKING_MAIL_DISPLAY_NAME: 'Studio Nagoya Base',
  BOOKING_MAIL_REPLY_TO: 'noreply@example.com',
  BOOKING_CONTACT_EMAIL: 'contact@example.com',
  ADMIN_NOTIFICATION_EMAIL: 'admin@example.com',
  ACCESS_GUIDE_ADDRESS: '愛知県名古屋市...',
  ACCESS_GUIDE_BUILDING: 'テストビル',
  ACCESS_GUIDE_ROOM: '101',
  ACCESS_GUIDE_ENTRANCE: '正面入口から左手',
  ACCESS_GUIDE_KEYBOX_LOCATION: '玄関脇',
  ACCESS_GUIDE_ENTRY_METHOD: '玄関の暗証番号を入力して解錠',
  ACCESS_GUIDE_KEYBOX_NUMBER: 'TEST-KEYBOX',
  ACCESS_GUIDE_UNLOCK_CODE: 'TEST-OLD-FIXED-CODE',
  ACCESS_GUIDE_URL: 'https://example.com/how-to'
};

function setup(props) {
  var properties = Object.assign({}, BASE_PROPS, props || {});
  var mailApp = stubs.createMailAppStub();
  var logger = stubs.createLoggerStub();
  var sandbox = loadBookingSandbox(BOOKING_ADMIN_FILES, {
    PropertiesService: stubs.createPropertiesServiceStub(properties),
    SpreadsheetApp: stubs.createSpreadsheetAppStub({ ss1: {} }),
    LockService: stubs.createLockServiceStub(),
    MailApp: mailApp,
    ScriptApp: stubs.createScriptAppStub(),
    Logger: logger
  });
  return { sandbox: sandbox, mailApp: mailApp, logger: logger };
}

function seed(ctx, id, brand) {
  ctx.sandbox.SpreadsheetRepository.appendBooking({
    bookingId: id, createdAt: new Date('2026-09-30T10:00:00+09:00'), date: '2026-10-02',
    startAt: new Date('2026-10-02T10:00:00+09:00'), endAt: new Date('2026-10-02T12:00:00+09:00'),
    brand: brand || 'snb', name: '山田太郎', email: 'taro@example.com', phone: '090-0000-0000',
    people: '2名', purpose: '練習', paymentMethod: '現金', status: 'CONFIRMED',
    calendarEventId: 'e1', source: 'test', note: '', confirmedAt: new Date('2026-09-30T10:00:00+09:00'),
    expiredAt: '', cancelledAt: '', updatedAt: '', customerType: 'returning',
    pendingMailSentAt: new Date('2026-09-30T10:00:00+09:00'),
    confirmedMailSentAt: new Date('2026-09-30T10:00:00+09:00'),
    cancelMailSentAt: '', reminderSentAt: '', accessGuideSentAt: '',
    lastMailErrorAt: '', lastMailErrorType: '', lastMailErrorMessage: ''
  });
  return id;
}

function sendBody(ctx, id, extra) {
  var r = ctx.sandbox.BookingMailer.sendReminderMailForBooking(id, Object.assign({ targetDateString: '2026-10-02', now: NOW }, extra || {}));
  var mails = ctx.mailApp._sentEmails;
  return { result: r, body: mails.length ? mails[mails.length - 1].body : null };
}

function assertNew(body) {
  assert.ok(body.indexOf(NOTICE + '\n') !== -1 || body.endsWith(NOTICE), '予約別暗証番号の別送案内がそのまま入る');
  assert.strictEqual(body.indexOf(NOTICE_832), -1, '#832の旧一文は使わない');
  assert.strictEqual(body.indexOf('解錠コード'), -1, '解錠コードのラベルなし');
  assert.strictEqual(body.indexOf('TEST-OLD-FIXED-CODE'), -1, '旧固定値なし');
  assert.strictEqual(body.indexOf(OLD_NOTICE), -1, '旧文言なし');
  assert.ok(body.indexOf('キーボックス位置: 玄関脇') !== -1, 'キーボックス位置は保持');
  assert.ok(body.indexOf('キーボックス番号: TEST-KEYBOX') !== -1, 'キーボックス番号は保持');
  assert.ok(body.indexOf('住所: 愛知県名古屋市...') !== -1);
  assert.ok(body.indexOf('利用案内を見る:') !== -1);
}

function assertOld(body) {
  assert.ok(body.indexOf('解錠コード: TEST-OLD-FIXED-CODE') !== -1, '旧方式は既存どおり');
  assert.strictEqual(body.indexOf(NOTICE), -1, '新文言なし');
}

test('既定(未設定/OFF): 旧方式のまま・警告なし', function () {
  ['undefined', 'OFF', 'off', ' '].forEach(function (mode) {
    var props = mode === 'undefined' ? {} : { ACCESS_PER_BOOKING_CODE_MODE: mode };
    var ctx = setup(props);
    seed(ctx, 'B-1');
    var r = sendBody(ctx, 'B-1');
    assert.strictEqual(r.result.success, true, mode);
    assertOld(r.body);
    assert.strictEqual(ctx.logger._logs ? ctx.logger._logs.filter(function (l) { return /警告/.test(String(l)); }).length : 0, 0);
  });
});

test('PILOT: 一致する予約だけ新方式、他の通常予約は旧方式', function () {
  var props = { ACCESS_PER_BOOKING_CODE_MODE: 'PILOT', ACCESS_PER_BOOKING_CODE_PILOT_IDS: 'B-1, B-9' };
  var ctx = setup(props);
  seed(ctx, 'B-1'); seed(ctx, 'B-2'); seed(ctx, 'B-1X');
  assertNew(sendBody(ctx, 'B-1').body);
  assertOld(sendBody(ctx, 'B-2').body);
  assertOld(sendBody(ctx, 'B-1X').body); // 前方一致は不可（完全一致のみ）
});

test('ALL: 3ブランドすべて新方式', function () {
  var ctx = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL' });
  ['snb', 'mens', 'studio_x'].forEach(function (brand, i) {
    var id = seed(ctx, 'A-' + i, brand);
    assertNew(sendBody(ctx, id).body);
  });
});

test('ALL/PILOT でも対象3ブランド以外(空/不明ブランド)は旧方式', function () {
  var ctx = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL' });
  seed(ctx, 'X-1', 'other');
  assertOld(sendBody(ctx, 'X-1').body);
});

test('不正設定はOFFへフォールバックし警告(ID・実値なし)。ALLと解釈しない', function () {
  var cases = [
    { ACCESS_PER_BOOKING_CODE_MODE: 'all-ish' },
    { ACCESS_PER_BOOKING_CODE_MODE: 'PILOT' },
    { ACCESS_PER_BOOKING_CODE_MODE: 'PILOT', ACCESS_PER_BOOKING_CODE_PILOT_IDS: ' , ' },
    { ACCESS_PER_BOOKING_CODE_MODE: 'PILOT', ACCESS_PER_BOOKING_CODE_PILOT_IDS: 'B-1,*' },
    { ACCESS_PER_BOOKING_CODE_MODE: 'PILOT', ACCESS_PER_BOOKING_CODE_PILOT_IDS: 'B-1;B-2' }
  ];
  cases.forEach(function (props) {
    var ctx = setup(props);
    seed(ctx, 'B-1');
    var r = sendBody(ctx, 'B-1');
    assertOld(r.body);
    var d = ctx.sandbox.BookingConfig.resolveAccessCodeDelivery({ bookingId: 'B-1', brand: 'snb' });
    assert.strictEqual(d.mode, 'OFF');
    assert.ok(d.warning, JSON.stringify(props));
    var logs = JSON.stringify(ctx.logger._logs || []);
    assert.strictEqual(logs.indexOf('B-1'), -1, 'ログに予約IDを出さない');
    assert.strictEqual(logs.indexOf('TEST-OLD-FIXED-CODE'), -1);
  });
});

test('ACCESS_KEY_NOTICE_ENABLEDは新方式の判定に影響せず、新方式で旧文言を二重に出さない', function () {
  var ctx = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL', ACCESS_KEY_NOTICE_ENABLED: 'true' });
  seed(ctx, 'N-1');
  assertNew(sendBody(ctx, 'N-1').body);
  var off = setup({ ACCESS_KEY_NOTICE_ENABLED: 'true' });
  seed(off, 'N-2');
  var b = sendBody(off, 'N-2').body;
  assert.ok(b.indexOf(OLD_NOTICE) !== -1, '旧方式+旧フラグは従来どおり');
  assert.ok(b.indexOf('解錠コード: TEST-OLD-FIXED-CODE') !== -1);
});

test('必須情報ゲート: 新方式のみunlockCode不要。keyboxNumberは必須のまま', function () {
  var noUnlock = { ACCESS_GUIDE_UNLOCK_CODE: '' };
  var ctx = setup(Object.assign({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL' }, noUnlock));
  seed(ctx, 'G-1');
  var r = sendBody(ctx, 'G-1');
  assert.strictEqual(r.result.success, true);
  assertNew(r.body.replace('TEST-OLD-FIXED-CODE', ''));

  var old = setup(noUnlock);
  seed(old, 'G-2');
  var ro = sendBody(old, 'G-2');
  assert.strictEqual(ro.result.success, false, '旧方式はunlockCode必須のまま');
  assert.strictEqual(old.mailApp._sentEmails.length, 0);

  var noBox = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL', ACCESS_GUIDE_KEYBOX_NUMBER: '', ACCESS_GUIDE_UNLOCK_CODE: '' });
  seed(noBox, 'G-3');
  var rb = sendBody(noBox, 'G-3');
  assert.strictEqual(rb.result.success, false, '新方式でもkeyboxNumberは必須');
  assert.strictEqual(noBox.mailApp._sentEmails.length, 0);

  var noAddr = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL', ACCESS_GUIDE_ADDRESS: '' });
  seed(noAddr, 'G-4');
  assert.strictEqual(sendBody(noAddr, 'G-4').result.success, false, '住所などの必須は維持');
});

test('補完/即時/手動再送の各経路も同じ判定を通る', function () {
  var ctx = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL' });
  seed(ctx, 'R-1');
  var summary = ctx.sandbox.sendNextDayReminders(NOW);
  assert.strictEqual(summary.sentCount, 1);
  assertNew(ctx.mailApp._sentEmails[0].body);

  var forced = sendBody(ctx, 'R-1', { force: true });
  assert.strictEqual(forced.result.success, true);
  assertNew(forced.body);

  var imm = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL' });
  seed(imm, 'R-2');
  var r = imm.sandbox.BookingMailer.sendImmediateAccessGuideForBooking('R-2', { now: new Date('2026-10-01T19:30:00+09:00') });
  assert.strictEqual(r.success, true);
  assertNew(imm.mailApp._sentEmails[0].body);
});

test('管理画面プレビュー/テスト送信: 実際の方式を表示し本文は送信と一致、秘密値を含まない', function () {
  var ctx = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'PILOT', ACCESS_PER_BOOKING_CODE_PILOT_IDS: 'P-1' });
  seed(ctx, 'P-1'); seed(ctx, 'P-2');
  var p1 = ctx.sandbox.previewReminderMail('P-1', { baseDateString: '2026-10-01', reveal: true });
  assert.strictEqual(p1.success, true);
  assert.strictEqual(p1.mailMethod, 'PER_BOOKING_CODE');
  assert.strictEqual(p1.codeMode, 'PILOT');
  assertNew(p1.body);
  assert.strictEqual(JSON.stringify(p1).indexOf('TEST-OLD-FIXED-CODE'), -1, '旧固定値をプレビューに出さない');

  var masked = ctx.sandbox.previewReminderMail('P-1', { baseDateString: '2026-10-01' });
  assert.strictEqual(masked.body.indexOf('解錠コード'), -1);

  var p2 = ctx.sandbox.previewReminderMail('P-2', { baseDateString: '2026-10-01', reveal: true });
  assert.strictEqual(p2.mailMethod, 'LEGACY');
  assertOld(p2.body);

  var t = ctx.sandbox.sendReminderTestMail('P-1', '2026-10-01');
  assert.strictEqual(t.success, true);
  assertNew(ctx.mailApp._sentEmails[0].body.replace('[TEST] ', ''));

  var bad = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'bogus' });
  seed(bad, 'P-3');
  var pb = bad.sandbox.previewReminderMail('P-3', { baseDateString: '2026-10-01', reveal: true });
  assert.strictEqual(pb.mailMethod, 'LEGACY');
  assert.strictEqual(pb.codeModeWarning, 'INVALID_MODE');
});

test('旧固定コードへのフォールバック禁止: 新方式対象はテンプレート直呼びでもunlockCodeを出さない', function () {
  var ctx = setup({});
  var rec = { bookingId: 'T-1', brand: 'mens', name: 'A', email: 'a@example.com', date: '2026-10-02',
    startAt: new Date('2026-10-02T10:00:00+09:00'), endAt: new Date('2026-10-02T12:00:00+09:00') };
  var guide = ctx.sandbox.BookingConfig.getAccessGuideConfig();
  var cfg = ctx.sandbox.BookingConfig.getMailConfig();
  var m = ctx.sandbox.BookingMailTemplates.buildReminderMail(rec, cfg, guide, { now: NOW, perBookingCode: true });
  assertNew(m.body);
  var strict = ctx.sandbox.BookingMailTemplates.buildReminderMail(rec, cfg, guide, { now: NOW, perBookingCode: 'true' });
  assertOld(strict.body); // 真偽値true以外は新方式にしない
});

/* Issue #901: 来場案内はHTML＋text/plainのマルチパートで送られ、両方に同じ必須事項がある。 */
test('Issue #901: 来場案内メールはhtmlBody付きで送信され、HTMLにもキーボックス番号の取り違え防止の注記がある', function () {
  var ctx = setup({ ACCESS_PER_BOOKING_CODE_MODE: 'ALL' });
  var id = seed(ctx, 'H-1', 'snb');
  var r = sendBody(ctx, id);
  assert.strictEqual(r.result.success, true, JSON.stringify(r.result));
  var mail = ctx.mailApp._sentEmails[ctx.mailApp._sentEmails.length - 1];
  assert.ok(typeof mail.htmlBody === 'string' && mail.htmlBody.indexOf('<!DOCTYPE html>') === 0);
  assert.ok(mail.htmlBody.indexOf('TEST-KEYBOX') !== -1);
  assert.ok(mail.htmlBody.indexOf('入室用の暗証番号（別メール）とは別の番号です') !== -1);
  assert.strictEqual(mail.htmlBody.indexOf('TEST-OLD-FIXED-CODE'), -1);
  assert.match(mail.subject, /^【SNB】明日の来場案内｜10\/2\(金\) 10:00$/);
});
