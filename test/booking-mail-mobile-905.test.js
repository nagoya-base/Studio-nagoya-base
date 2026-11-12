/*
 * Issue #905: 仮受付・キャンセル通知を#901のスマホ向けHTMLデザインへ統一。
 * 純粋関数のテスト（GAS組み込みサービス不要）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var T = loadBookingSandbox(['Availability.gs', 'Booking.gs', 'BookingMailTemplates.gs'], {}).BookingMailTemplates;
var CONFIG = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };
var BRANDS = [['snb', 'SNB'], ['mens', 'SNB mens'], ['studio_x', 'Studio X']];

function rec(overrides) {
  return Object.assign({
    bookingId: 'SX-20261112-AAAAAAAA',
    date: '2026-11-12',
    startAt: new Date('2026-11-12T08:00:00+09:00'),
    endAt: new Date('2026-11-12T09:00:00+09:00'),
    brand: 'snb', name: '山田太郎', email: 'taro@example.com', people: '2名', paymentMethod: '現金', priceAmount: 3000
  }, overrides || {});
}

test('仮受付: 件名に未確定と日時。3ブランド共通でブランド名のみ変わる', function () {
  BRANDS.forEach(function (c) {
    var m = T.buildPendingMail(rec({ brand: c[0] }), CONFIG);
    assert.strictEqual(m.subject, '【' + c[1] + '】予約を受け付けました（未確定）｜11/12(木) 8:00');
  });
});

test('仮受付: HTMLとtextの両方で最上部に『未確定』と日時・ブランド・人数・料金・支払方法がある', function () {
  BRANDS.forEach(function (c) {
    var m = T.buildPendingMail(rec({ brand: c[0] }), CONFIG);
    var head = m.body.split('■')[0];
    assert.match(head, /予約確認中・まだ未確定です/);
    assert.match(head, /利用日時: 2026年11月12日（木）8:00〜9:00/);
    assert.match(head, new RegExp('ブランド: ' + c[1]));
    assert.match(head, /利用人数: 2名/);
    assert.match(head, /利用料金: 3,000円（税込）/);
    assert.match(head, /支払方法: 現金/);
    assert.match(m.htmlBody, /予約確認中・まだ未確定です/);
    assert.match(m.htmlBody, /2026年11月12日（木）/);
    assert.match(m.htmlBody, /3,000円/);
    assert.match(m.htmlBody, /<meta name="viewport"/);
  });
});

test('仮受付: 入室できると誤解させず、確定通知を待つ旨・予約ID・問い合わせ・案内リンクをテキストにも載せる', function () {
  var m = T.buildPendingMail(rec(), CONFIG);
  assert.match(m.body, /確定のご連絡が届くまでは、ご利用（入室）いただけません/);
  assert.match(m.body, /当方で内容を確認のうえ、確定のご連絡を改めてお送りします/);
  assert.match(m.body, /予約ID: SX-20261112-AAAAAAAA/);
  assert.match(m.body, /お問い合わせ: contact@example.com/);
  assert.match(m.body, /ご利用案内: https:\/\//);
  assert.doesNotMatch(m.body, /解錠|暗証番号|キーボックス番号/);
});

test('仮受付(カード): 決済完了で確定・失効し得る旨を維持し、HTMLにもカード案内がある', function () {
  var m = T.buildPendingMail(rec({ paymentMethod: 'オンラインクレジットカード' }), CONFIG);
  assert.match(m.subject, /予約申込を受け付けました（決済完了で確定）｜11\/12\(木\) 8:00/);
  assert.match(m.body, /お支払いが完了しておらず、ご予約はまだ確定しておりません/);
  assert.match(m.body, /30分以内にお支払いを完了してください/);
  assert.match(m.body, /クレジットカード決済のご案内/);
  assert.match(m.htmlBody, /クレジットカード決済のご案内/);
  assert.match(m.htmlBody, /30分以内/);
  assert.doesNotMatch(m.body, /管理者/);
});

test('仮受付(5〜7名・作品撮りサポート): 承認待ち・未確定を最上部に出し、既存の注意書きを維持する', function () {
  var large = T.buildPendingMail(rec({ brand: 'mens', people: '6名', priceAmount: 12000, partySurcharge: 2000, largeParty: true, largePartyApprovalStatus: 'PENDING_APPROVAL' }), CONFIG);
  assert.match(large.subject, /運営の承認待ち・未確定）｜11\/12\(木\) 8:00/);
  assert.match(large.body.split('■')[0], /運営の承認待ち・まだ未確定です/);
  assert.match(large.body, /お支払いも不要です/);
  assert.match(large.htmlBody, /運営の承認待ち・まだ未確定です/);
  var photo = T.buildPendingMail(rec({ brand: 'mens', planCode: 'mens_photo_support', supportServices: 'SETUP_CLEANUP', supportRoomAmount: 3000, supportStaffAmount: 2000, priceAmount: 5000 }), CONFIG);
  assert.match(photo.subject, /承認待ち・未確定）｜11\/12\(木\) 8:00/);
  assert.match(photo.body.split('■')[0], /承認待ち・まだ未確定です/);
  assert.match(photo.body, /承認前はお支払いできません/);
  assert.match(photo.body, /通常のSNB mens料金へは自動で切り替えません/);
  assert.match(photo.htmlBody, /承認待ち・まだ未確定です/);
});

test('キャンセル: 件名に日時、最上部に『キャンセル済み』と元の利用日時。3ブランドでブランド別再予約リンク', function () {
  var urls = {
    snb: 'https://nagoya-base.github.io/Studio-nagoya-base/booking/',
    mens: 'https://nagoya-base.github.io/Studio-nagoya-base/mens/booking/',
    studio_x: 'https://nagoya-base.github.io/Studio-nagoya-base/studio-x/booking/'
  };
  BRANDS.forEach(function (c) {
    var r = rec({ brand: c[0], startAt: new Date('2026-11-12T14:15:00+09:00'), endAt: new Date('2026-11-12T15:15:00+09:00') });
    var m = T.buildCancelledMail(r, CONFIG);
    assert.strictEqual(m.subject, '【' + c[1] + '】予約キャンセルのお知らせ｜11/12(木) 14:15');
    var head = m.body.split('■')[0];
    assert.match(head, /キャンセル済み/);
    assert.match(head, /利用日時: 2026年11月12日（木）14:15〜15:15/);
    assert.match(m.body, /予約ID: SX-20261112-AAAAAAAA/);
    assert.match(m.body, /お問い合わせ: contact@example.com/);
    assert.ok(m.body.indexOf(urls[c[0]]) !== -1, 'text link');
    assert.ok(m.htmlBody.indexOf('href="' + urls[c[0]] + '"') !== -1, 'html link');
    assert.match(m.htmlBody, /キャンセル済み/);
  });
});

test('キャンセル: 返金は取消と区別し、既存の返金状況文言を維持（HTML/text同内容）。返金完了とは書かない', function () {
  var base = { paymentMethod: 'オンラインクレジットカード', paymentStatus: 'refund_pending', stripeCheckoutSessionId: 'cs_x', refundDecision: 'FULL', refundAttemptState: 'SUBMITTED', refundAmount: 3000 };
  var m = T.buildCancelledMail(rec(base), CONFIG);
  assert.match(m.body, /お支払い・返金について/);
  assert.match(m.body, /3,000円について、クレジットカードへの返金手続きを開始しました/);
  assert.match(m.body, /返金の完了は改めてメールでお知らせします/);
  assert.match(m.htmlBody, /返金手続きを開始しました/);
  assert.doesNotMatch(m.body, /返金手続きが完了/);
  var none = T.buildCancelledMail(rec(Object.assign({}, base, { refundDecision: 'NONE', refundAmount: '' })), CONFIG);
  assert.match(none.body, /返金はございません/);
  assert.match(none.htmlBody, /返金はございません/);
  var cash = T.buildCancelledMail(rec(), CONFIG);
  assert.doesNotMatch(cash.body, /返金/);
});

test('キャンセル(承認できませんでした系): 状態を最上部に出し、お支払い未発生の既存文言を維持', function () {
  var photo = T.buildCancelledMail(rec({ brand: 'mens', planCode: 'mens_photo_support' }), CONFIG);
  assert.strictEqual(photo.subject, '【SNB mens】作品撮りサポートプランを承認できませんでした');
  assert.match(photo.body.split('■')[0], /承認できませんでした（不成立）/);
  assert.match(photo.body, /お支払いは発生していません/);
  assert.match(photo.body, /通常のSNB mens料金へは自動で切り替わりません/);
  assert.ok(photo.htmlBody);
});

test('エスケープ: 氏名・予約IDなどの差し込み値はHTMLで無害化され、http(s)以外のリンクは出さない', function () {
  var m = T.buildPendingMail(rec({ bookingId: 'X<script>alert(1)</script>"&' }), CONFIG);
  assert.doesNotMatch(m.htmlBody, /<script>alert/);
  assert.match(m.htmlBody, /&lt;script&gt;/);
  assert.doesNotMatch(m.htmlBody, /href="http:\/\//);
  var c = T.buildCancelledMail(rec({ bookingId: '<b>x</b>' }), CONFIG);
  assert.doesNotMatch(c.htmlBody, /<b>x<\/b>/);
});
