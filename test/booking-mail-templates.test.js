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

var CONFIG = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };

function sampleRecord(overrides) {
  return Object.assign(
    {
      bookingId: 'SX-20261001-AAAAAAAA',
      date: '2026-10-01',
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

/*
 * buildExpiredMail（Issue #334: カード決済PENDING失効通知）。
 * 管理者キャンセル文面（buildCancelledMail）を流用せず、失効判定が「入金の自動検知」ではなく
 * 「管理者による承認の有無」であることを前提に、支払い済みの可能性を否定しない文言のみを
 * 使う（「未払いのため」「お支払いが確認できなかったため」のような、入金を自動確認したかの
 * ような断定表現を含めない）。
 */
test('buildExpiredMail: 件名/本文に「期限切れ」「要再申込み」が明記され、キャンセルメールの文面（buildCancelledMail）を流用しない', function () {
  var templates = loadTemplates();
  var mail = templates.buildExpiredMail(sampleRecord({ paymentMethod: 'オンラインクレジットカード' }), CONFIG);
  assert.match(mail.subject, /期限切れ/);
  assert.match(mail.body, /予約ページから再度お申し込み/);
  assert.doesNotMatch(mail.body, /下記のご予約はキャンセルされました/, 'buildCancelledMailの文面を流用してはいけない');
});

test('buildExpiredMail: 予約ID/利用日/開始/終了/ブランドを含み、再申込み案内と支払い済みの場合の連絡案内の両方を含む', function () {
  var templates = loadTemplates();
  var mail = templates.buildExpiredMail(sampleRecord({ paymentMethod: 'オンラインクレジットカード' }), CONFIG);
  assert.match(mail.body, /SX-20261001-AAAAAAAA/);
  assert.match(mail.body, /2026-10-01/);
  assert.match(mail.body, /10:00/);
  assert.match(mail.body, /12:00/);
  assert.match(mail.body, /Studio X/);
  assert.match(mail.body, /再度お申し込み/, '再申込みの案内を含むべき');
  assert.match(mail.body, /二重のお支払い/, '支払い済みの場合は運営へ連絡し、再申込み・二重決済をしない旨を含むべき');
  assert.match(mail.body, /contact@example\.com/);
});

test('buildExpiredMail: 入金の有無をシステムが自動確認したかのような断定表現を含まない（Issue #334本文の必須要件）', function () {
  var templates = loadTemplates();
  var mail = templates.buildExpiredMail(sampleRecord({ paymentMethod: 'オンラインクレジットカード' }), CONFIG);
  assert.doesNotMatch(mail.body, /お支払いが確認できなかった/);
  assert.doesNotMatch(mail.body, /未払いのため/);
  assert.doesNotMatch(mail.body, /入金が確認できません/);
});

test('buildExpiredMail: キーボックス番号・解錠コードを一切含まない（accessGuideを引数に取らない構造。buildPendingMail/buildConfirmedMailと同方針）', function () {
  var templates = loadTemplates();
  assert.strictEqual(templates.buildExpiredMail.length, 2);
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
