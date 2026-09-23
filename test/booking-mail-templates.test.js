/*
 * BookingMailTemplates.gs のテスト（Issue #271）。
 * 純粋関数のみを扱うため、GAS組み込みサービスのスタブは不要（Availability.gs/Booking.gs
 * と同じくvmでそのまま実行できる）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var FILES = ['Availability.gs', 'Booking.gs', 'BookingMailTemplates.gs'];

function loadTemplates() {
  return loadBookingSandbox(FILES, {}).BookingMailTemplates;
}

/* Issue #326のテストがBooking.computeCardPendingExpiryMillis/BookingAvailability.
   formatDateTimeInTimezoneを期待値の計算に使うための共有サンドボックス
   （buildPendingMail自体はこれらを直接エクスポートしないため）。 */
var SHARED_SANDBOX = loadBookingSandbox(FILES, {});

var CONFIG = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };

function sampleRecord(overrides) {
  return Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      date: '2026-10-01',
      createdAt: new Date('2026-09-30T10:00:00+09:00'),
      startAt: new Date('2026-10-01T10:00:00+09:00'),
      endAt: new Date('2026-10-01T12:00:00+09:00'),
      brand: 'studio_x',
      name: '山田太郎',
      email: 'taro@example.com',
      people: '2名',
      paymentMethod: '現金'
    },
    overrides || {}
  );
}

/* ダミーの来場案内（Issue #271「16. 来場案内」テンプレートテストでは実秘密値を使わない）。 */
var DUMMY_ACCESS_GUIDE = {
  address: '愛知県名古屋市...',
  building: 'テストビル',
  room: '101',
  entrance: '正面入口から左手',
  keyboxLocation: '玄関脇',
  entryMethod: '玄関の暗証番号を入力して解錠',
  keyboxNumber: 'TEST-KEYBOX',
  unlockCode: 'TEST-CODE',
  url: 'https://example.com/how-to',
  pdfUrl: 'https://example.com/guide.pdf'
};

test('buildPendingMail: 件名/本文に「未確定」が明記される', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord(), CONFIG);
  assert.match(mail.subject + mail.body, /未確定/);
});

test('buildPendingMail: 予約ID/氏名/利用日/開始/終了/利用時間/人数/支払方法/問い合わせ先を含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord(), CONFIG);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /山田太郎/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /10:00/);
  assert.match(mail.body, /12:00/);
  assert.match(mail.body, /120分/);
  assert.match(mail.body, /2名/);
  assert.match(mail.body, /現金/);
  assert.match(mail.body, /contact@example\.com/);
});

test('buildPendingMail: キーボックス番号・解錠コードを一切含まない（accessGuideを引数に取らない構造）', function () {
  var templates = loadTemplates();
  var mail = templates.buildPendingMail(sampleRecord(), CONFIG);
  assert.strictEqual(mail.body.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(mail.body.indexOf('TEST-CODE'), -1);
  assert.strictEqual(typeof templates.buildPendingMail.length, 'number');
  assert.strictEqual(templates.buildPendingMail.length, 2, 'buildPendingMailはrecordとconfigの2引数のみを取る（accessGuideを受け取らない）');
});

/* ---------- オンラインクレジットカードの支払い期限表示（Issue #326） ---------- */

var TTL_CONFIG = { cardHoursFromCreated: 72, cardHoursBeforeStart: 24, cashHours: 48, minHoursBeforeStart: 2, minHoldHours: 2 };

function cardConfig(overrides) {
  return Object.assign({}, CONFIG, { ttlConfig: TTL_CONFIG }, overrides || {});
}

test('buildPendingMail: オンラインクレジットカードのPENDINGメールには、EXPIRED判定と同じBooking.computeCardPendingExpiryMillisで計算した支払い期限がJST（分単位切り捨て）で表示される', function () {
  var templates = loadTemplates();
  var createdAt = new Date('2026-09-30T10:00:00+09:00');
  var startAt = new Date('2026-10-05T10:00:00+09:00'); /* 十分先の開始のため、受付72時間後が支払い期限になる */
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード', createdAt: createdAt, startAt: startAt });

  var mail = templates.buildPendingMail(record, cardConfig());

  var expectedMillis = SHARED_SANDBOX.Booking.computeCardPendingExpiryMillis(createdAt.getTime(), startAt.getTime(), 72, 24, 2);
  var expectedText = SHARED_SANDBOX.BookingAvailability.formatDateTimeInTimezone(new Date(expectedMillis), 'Asia/Tokyo');
  assert.match(mail.body, /お支払い期限: /);
  assert.ok(mail.body.indexOf('お支払い期限: ' + expectedText) !== -1, mail.body);
});

test('buildPendingMail: オンラインクレジットカードのPENDINGメールに「お支払い方法は別途ご案内します」が1行追加される', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード' });
  var mail = templates.buildPendingMail(record, cardConfig());
  assert.match(mail.body, /お支払い方法は別途ご案内します/);
});

['現金', 'PayPay', '未定'].forEach(function (paymentMethod) {
  test('buildPendingMail: paymentMethod=' + JSON.stringify(paymentMethod) + ' には「クレジットカード支払い期限」としては表示しない（お支払い期限行を出さない）', function () {
    var templates = loadTemplates();
    var record = sampleRecord({ paymentMethod: paymentMethod });
    var mail = templates.buildPendingMail(record, cardConfig());
    assert.strictEqual(mail.body.indexOf('お支払い期限'), -1, mail.body);
    assert.strictEqual(mail.body.indexOf('お支払い方法は別途ご案内します'), -1, mail.body);
  });
});

test('buildPendingMail: メールに表示する支払い期限とEXPIRED判定の期限は、同一のrecord.createdAt/startAtから同一の純粋関数(Booking.computeCardPendingExpiryMillis)で計算され、ミリ秒値として一致する', function () {
  var templates = loadTemplates();
  var createdAt = new Date('2026-10-01T15:00:00+09:00');
  var startAt = new Date('2026-10-02T10:00:00+09:00'); /* 前日受付・翌日開始（floorが効くケース） */
  var record = sampleRecord({ paymentMethod: 'オンラインクレジットカード', createdAt: createdAt, startAt: startAt });

  /* メール側の計算（buildPendingMail内部）と、EXPIRED判定側の計算を、
     同じttlConfig値を使って独立に呼び出し、millis値が一致することを確認する。 */
  var expiryForMail = SHARED_SANDBOX.Booking.computeCardPendingExpiryMillis(createdAt.getTime(), startAt.getTime(), 72, 24, 2);
  var expiryForExpireCheck = SHARED_SANDBOX.Booking.computePendingExpiryMillis(
    'オンラインクレジットカード', createdAt.getTime(), startAt.getTime(), TTL_CONFIG, false
  );
  assert.strictEqual(expiryForMail, expiryForExpireCheck, 'メール表示用とEXPIRED判定用の期限計算は同一ミリ秒値であるべき');

  var mail = templates.buildPendingMail(record, cardConfig());
  var expectedText = SHARED_SANDBOX.BookingAvailability.formatDateTimeInTimezone(new Date(expiryForMail), 'Asia/Tokyo');
  assert.ok(mail.body.indexOf('お支払い期限: ' + expectedText) !== -1, mail.body);
});

test('buildConfirmedMail: 件名で予約確定が分かる', function () {
  var templates = loadTemplates();
  var mail = templates.buildConfirmedMail(sampleRecord(), CONFIG);
  assert.match(mail.subject, /確定/);
});

test('buildConfirmedMail: 必須内容を含み、来場詳細は前日案内で送る旨が書かれる。料金は含めない', function () {
  var templates = loadTemplates();
  var mail = templates.buildConfirmedMail(sampleRecord(), CONFIG);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /10:00/);
  assert.match(mail.body, /12:00/);
  assert.match(mail.body, /前日/);
  assert.strictEqual(mail.body.indexOf('料金'), -1, '現行Bookingsに確定料金列がないため料金を出さない');
});

test('buildConfirmedMail: 利用上の基本注意を含む（PRレビュー対応。Issue #271本文の必須内容）', function () {
  var templates = loadTemplates();
  var mail = templates.buildConfirmedMail(sampleRecord(), CONFIG);
  assert.match(mail.body, /原状回復/);
});

test('buildConfirmedMail: キーボックス番号・解錠コードを含まない（直後メールには来場秘密値を出さない）', function () {
  var templates = loadTemplates();
  var mail = templates.buildConfirmedMail(sampleRecord(), CONFIG);
  assert.strictEqual(mail.body.indexOf('TEST-KEYBOX'), -1);
  assert.strictEqual(mail.body.indexOf('TEST-CODE'), -1);
  assert.strictEqual(templates.buildConfirmedMail.length, 2);
});

test('buildCancelledMail: キャンセル済みであること・予約ID・元の利用日時・ブランドを含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildCancelledMail(sampleRecord(), CONFIG);
  assert.match(mail.subject, /キャンセル/);
  assert.match(mail.body, /キャンセル/);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /Studio X/);
});

test('buildReminderMail: 「明日」の案内であることが分かり、来場方法一式を含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildReminderMail(sampleRecord(), CONFIG, DUMMY_ACCESS_GUIDE);
  assert.match(mail.body, /明日/);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.ok(mail.body.indexOf(DUMMY_ACCESS_GUIDE.address) !== -1);
  assert.match(mail.body, /テストビル/);
  assert.match(mail.body, /101/);
  assert.match(mail.body, /正面入口/);
  assert.match(mail.body, /玄関脇/);
  assert.match(mail.body, /入室方法/);
  assert.match(mail.body, /how-to/);
  assert.match(mail.body, /guide\.pdf/);
});

test('buildReminderMail: ダミーのキーボックス番号・解錠コードが含まれる（実秘密値はテストで使わない）', function () {
  var templates = loadTemplates();
  var mail = templates.buildReminderMail(sampleRecord(), CONFIG, DUMMY_ACCESS_GUIDE);
  assert.match(mail.body, /TEST-KEYBOX/);
  assert.match(mail.body, /TEST-CODE/);
});

test('buildReminderMail: 秘密値が未設定の場合はプレースホルダを出す（値の要否判定・成功可否はBookingMailer側の責務）', function () {
  var templates = loadTemplates();
  var mail = templates.buildReminderMail(sampleRecord(), CONFIG, { address: '住所のみ設定' });
  assert.match(mail.body, /未設定/);
  assert.strictEqual(mail.body.indexOf('TEST-KEYBOX'), -1);
});

test('brandラベル: snb/mens/studio_xで同じロジックを使い、表示名だけが変わる（3ブランドのコピー実装を作らない）', function () {
  var templates = loadTemplates();
  var expectedLabels = { snb: 'SNB', mens: 'SNB mens', studio_x: 'Studio X' };
  Object.keys(expectedLabels).forEach(function (brand) {
    var record = sampleRecord({ brand: brand, bookingId: brand + '-BOOKING' });
    var pending = templates.buildPendingMail(record, CONFIG);
    var confirmed = templates.buildConfirmedMail(record, CONFIG);
    var cancelled = templates.buildCancelledMail(record, CONFIG);
    var reminder = templates.buildReminderMail(record, CONFIG, DUMMY_ACCESS_GUIDE);
    [pending, confirmed, cancelled, reminder].forEach(function (mail) {
      assert.match(mail.subject + mail.body, new RegExp(expectedLabels[brand].replace(/ /g, '\\s')), brand);
    });
  });
});

/*
 * 利用日の曜日表示（Issue #311）。BookingAvailability.formatDateWithWeekday（Availability.gs）
 * を共通で使い、'YYYY-MM-DD（曜）'形式で表示することを、利用者向け4テンプレート
 * （仮予約受付・予約確定・キャンセル・前日リマインド）すべてで確認する。
 * sampleRecord()の既定date '2026-10-01' は木曜日。
 */
test('利用日の曜日表示: buildPendingMail/buildConfirmedMail/buildCancelledMail/buildReminderMailすべてで利用日に曜日が付く', function () {
  var templates = loadTemplates();
  var record = sampleRecord();

  var pending = templates.buildPendingMail(record, CONFIG);
  var confirmed = templates.buildConfirmedMail(record, CONFIG);
  var cancelled = templates.buildCancelledMail(record, CONFIG);
  var reminder = templates.buildReminderMail(record, CONFIG, DUMMY_ACCESS_GUIDE);

  [pending, confirmed, cancelled, reminder].forEach(function (mail) {
    assert.match(mail.body, /利用日: 2026-10-01（木）/);
  });
});

test('利用日の曜日表示: 別の曜日（2026-10-05は月曜日）でも正しく表示される', function () {
  var templates = loadTemplates();
  var record = sampleRecord({ date: '2026-10-05' });

  var mail = templates.buildConfirmedMail(record, CONFIG);
  assert.match(mail.body, /利用日: 2026-10-05（月）/);
});
