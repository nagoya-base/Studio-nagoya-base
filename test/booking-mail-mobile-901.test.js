/*
 * Issue #901: 予約確定メール・来場案内メールのスマホ向け再設計。
 * 純粋関数のテスト（GAS組み込みサービス不要）。実メールでの見え方はPR本文の確認手順で別途確認する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

var T = loadBookingSandbox(['Availability.gs', 'Booking.gs', 'BookingMailTemplates.gs'], {}).BookingMailTemplates;
var CONFIG = { timezone: 'Asia/Tokyo', contactEmail: 'contact@example.com' };

function rec(overrides) {
  return Object.assign({
    bookingId: 'SX-20261112-AAAAAAAA',
    date: '2026-11-12',
    startAt: new Date('2026-11-12T09:30:00+09:00'),
    endAt: new Date('2026-11-12T10:30:00+09:00'),
    brand: 'snb', name: '山田太郎', email: 'taro@example.com', people: '2名', paymentMethod: '現金'
  }, overrides || {});
}

var GUIDE = {
  address: '愛知県名古屋市中区テスト1-2-3', building: 'テストビル', room: '101',
  entrance: '正面入口から入って左', keyboxLocation: 'エレベーター脇の壁面',
  entryMethod: 'キーボックスの鍵で解錠', keyboxNumber: 'KB-DUMMY-1', unlockCode: 'OLD-DUMMY-2',
  url: 'https://example.com/how-to/', pdfUrl: 'https://example.com/guide.pdf'
};
var JST = function (iso) { return new Date(iso + '+09:00'); };

test('確定メール: 件名に予約確定と日時（11/12(木) 9:30–10:30）。3ブランド共通でブランド名のみ変わる', function () {
  [['snb', 'SNB'], ['mens', 'SNB mens'], ['studio_x', 'Studio X']].forEach(function (c) {
    var m = T.buildConfirmedMail(rec({ brand: c[0] }), CONFIG);
    assert.strictEqual(m.subject, '【' + c[1] + '】予約確定｜11/12(木) 9:30–10:30');
  });
});

test('確定メール: 冒頭（本文の先頭〜最初の見出しまで）に日時・ブランド・人数・支払方法がある', function () {
  var m = T.buildConfirmedMail(rec(), CONFIG);
  var head = m.body.split('■')[0];
  assert.match(head, /ご予約が確定しました/);
  assert.match(head, /利用日時: 2026年11月12日（木）9:30〜10:30/);
  assert.match(head, /ブランド: SNB/);
  assert.match(head, /利用人数: 2名/);
  assert.match(head, /支払方法: 現金/);
});

test('確定メール: キーボックス・設備の長文を繰り返さず、本文は短い', function () {
  var m = T.buildConfirmedMail(rec({ date: '2026-11-20', startAt: JST('2026-11-20T09:30:00'), endAt: JST('2026-11-20T10:30:00') }), CONFIG, { perBookingCode: true, now: JST('2026-11-12T10:00:00') });
  assert.doesNotMatch(m.body, /設備・備品の取り扱い/);
  assert.ok(m.body.split('\n').length < 32, 'lines=' + m.body.split('\n').length);
  assert.doesNotMatch(m.body, /KB-DUMMY|OLD-DUMMY/);
});

test('確定メール: 暗証番号の別送案内は予約状況に応じて動的（当日・前日18時以降・通常）', function () {
  var opts = function (nowIso) { return { perBookingCode: true, now: JST(nowIso) }; };
  /* 当日直前予約（11/12 8:53確定、9:30開始）: 「前日18時以降」を出さない */
  var sameDay = T.buildConfirmedMail(rec(), CONFIG, opts('2026-11-12T08:53:00')).body;
  assert.doesNotMatch(sameDay, /前日/);
  assert.match(sameDay, /別のメールでお送りします/);
  assert.match(sameDay, /発行でき次第/);
  assert.match(sameDay, /すでに届いている場合は/, 'メール順序が逆転しても矛盾しない');
  /* 営業時間外確定: 前日23:30に確定した翌日朝の予約。18時の配信開始を過ぎている */
  var lateNight = T.buildConfirmedMail(rec(), CONFIG, opts('2026-11-11T23:30:00')).body;
  assert.doesNotMatch(lateNight, /お届けは利用日前日の18時以降です/);
  assert.match(lateNight, /配信開始時刻を過ぎている/);
  /* 前日17時台: 従来どおり前日18時以降 */
  var normal = T.buildConfirmedMail(rec(), CONFIG, opts('2026-11-11T17:00:00')).body;
  assert.match(normal, /お届けは利用日前日の18時以降です/);
  /* 数日先 */
  var far = T.buildConfirmedMail(rec({ date: '2026-11-30' }), CONFIG, opts('2026-11-12T10:00:00')).body;
  assert.match(far, /お届けは利用日前日の18時以降です/);
});

test('確定メール: 方式OFFの予約には暗証番号の別送案内を出さない', function () {
  var m = T.buildConfirmedMail(rec({ date: '2026-11-30' }), CONFIG, { now: JST('2026-11-12T10:00:00') });
  assert.doesNotMatch(m.body, /入室用の暗証番号/);
});

test('来場案内: 件名は「本日/明日の来場案内｜日付 開始時刻」。当日は前日18時以降を出さない', function () {
  var today = T.buildReminderMail(rec(), CONFIG, GUIDE, { now: JST('2026-11-12T08:53:00'), perBookingCode: true });
  assert.strictEqual(today.subject, '【SNB】本日の来場案内｜11/12(木) 9:30');
  assert.doesNotMatch(today.body, /前日/);
  assert.doesNotMatch(today.body, /18時以降/);
  var tomorrow = T.buildReminderMail(rec(), CONFIG, GUIDE, { now: JST('2026-11-11T18:00:00'), perBookingCode: true });
  assert.strictEqual(tomorrow.subject, '【SNB】明日の来場案内｜11/12(木) 9:30');
  assert.match(tomorrow.body, /お届けは利用日前日の18時以降です/);
});

test('来場案内: 住所・建物・部屋・地図・3ステップ・退室・詳細リンクが揃い、キーボックス番号はラベル付きで入室暗証番号と区別される', function () {
  var m = T.buildReminderMail(rec(), CONFIG, GUIDE, { now: JST('2026-11-12T08:53:00'), perBookingCode: true });
  ['住所: 愛知県名古屋市中区テスト1-2-3', '建物: テストビル', '部屋番号: 101', '1. 建物の正面入口へ', '2. 指定位置のキーボックスを開ける',
    '3. 鍵で解錠して入室', 'キーボックス位置: エレベーター脇の壁面', 'キーボックス番号: KB-DUMMY-1', '入室方法: キーボックスの鍵で解錠',
    '利用案内ページ: https://example.com/how-to/', '案内PDF: https://example.com/guide.pdf', '施錠して鍵をキーボックスへ戻し'
  ].forEach(function (s) { assert.ok(m.body.indexOf(s) !== -1, s); });
  assert.match(m.body, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&query=/);
  assert.match(m.body, /これは鍵を保管する箱の番号です。入室用の暗証番号（別メール）とは別の番号です。/);
  assert.doesNotMatch(m.body, /OLD-DUMMY|解錠コード/, '予約別暗証番号の方式では旧共通コードを出さない');
});

test('来場案内: 旧方式では解錠コードを別ラベルで出し、キーボックス番号と区別する', function () {
  var m = T.buildReminderMail(rec(), CONFIG, GUIDE, { now: JST('2026-11-11T18:00:00') });
  assert.match(m.body, /キーボックス番号: KB-DUMMY-1/);
  assert.match(m.body, /解錠コード: OLD-DUMMY-2/);
  assert.match(m.body, /入室用の暗証番号・解錠コードとは別の番号/);
});

test('来場案内: ACCESS_GUIDE_MAP_URL（https）を優先し、住所が無ければ地図リンクを作らない', function () {
  var withMap = T.buildReminderMail(rec(), CONFIG, Object.assign({}, GUIDE, { mapUrl: 'https://maps.example.com/p/1' }), { now: JST('2026-11-11T18:00:00') });
  assert.match(withMap.body, /▼ 地図を開く\nhttps:\/\/maps\.example\.com\/p\/1/);
  assert.doesNotMatch(withMap.body, /google\.com\/maps/);
  var noAddr = T.buildReminderMail(rec(), CONFIG, { keyboxNumber: 'K', mapUrl: 'javascript:alert(1)' }, { now: JST('2026-11-11T18:00:00') });
  assert.doesNotMatch(noAddr.body, /地図を開く/);
  assert.doesNotMatch(noAddr.htmlBody, /javascript:/);
});

test('HTML: 1列・表組み・16px・viewport・ダーク対応・プレヘッダー。外部画像/スクリプトなし', function () {
  [T.buildConfirmedMail(rec(), CONFIG, { perBookingCode: true }), T.buildReminderMail(rec(), CONFIG, GUIDE, { now: JST('2026-11-12T08:53:00'), perBookingCode: true })].forEach(function (m) {
    var h = m.htmlBody;
    assert.match(h, /^<!DOCTYPE html>/);
    assert.match(h, /name="viewport"/);
    assert.match(h, /color-scheme/);
    assert.match(h, /prefers-color-scheme: dark/);
    assert.match(h, /font-size:16px/);
    assert.match(h, /max-width:600px/);
    assert.match(h, /display:none;max-height:0/);
    assert.doesNotMatch(h, /<img|<script|<link|@import|url\(/i);
  });
});

test('HTML: 長いURLを本文に貼らず、リンク文言にする。プレーンテキストには全文URLが残る', function () {
  var m = T.buildReminderMail(rec(), CONFIG, GUIDE, { now: JST('2026-11-12T08:53:00'), perBookingCode: true });
  assert.match(m.htmlBody, /href="https:\/\/example\.com\/how-to\/"/);
  assert.doesNotMatch(m.htmlBody.replace(/href="[^"]*"/g, ''), /https:\/\/example\.com/);
  assert.match(m.body, /https:\/\/example\.com\/how-to\//);
});

test('HTML: 差し込み値をエスケープする（氏名・住所・案内文のタグ/引用符）。http/javascriptリンクは出さない', function () {
  var m = T.buildReminderMail(rec({ name: '<b>山田</b>"&' }), CONFIG, Object.assign({}, GUIDE, { address: '<script>x</script>', url: 'http://insecure.example.com/', pdfUrl: 'javascript:alert(1)' }), { now: JST('2026-11-11T18:00:00') });
  assert.doesNotMatch(m.htmlBody, /<script>x/);
  assert.match(m.htmlBody, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(m.htmlBody, /href="http:|href="javascript:/);
});

test('HTMLとプレーンテキストで必要事項が揃う（日時・予約ID・住所・手順・キーボックス番号）', function () {
  var m = T.buildReminderMail(rec(), CONFIG, GUIDE, { now: JST('2026-11-12T08:53:00'), perBookingCode: true });
  ['2026年11月12日（木）', '9:30〜10:30', 'SX-20261112-AAAAAAAA', '愛知県名古屋市中区テスト1-2-3', 'テストビル', '101', 'キーボックス番号', 'KB-DUMMY-1',
    '建物の正面入口へ', '指定位置のキーボックスを開ける', '鍵で解錠して入室', '入室用の暗証番号は別メールです'].forEach(function (s) {
    assert.ok(m.htmlBody.indexOf(s) !== -1, 'html: ' + s);
    assert.ok(m.body.indexOf(s) !== -1, 'text: ' + s);
  });
});

test('秘密値: 確定メールはHTMLにもキーボックス番号・旧共通コードを出さない', function () {
  var m = T.buildConfirmedMail(rec(), CONFIG, { perBookingCode: true, keyboxNumber: 'KB-DUMMY-1', unlockCode: 'OLD-DUMMY-2' });
  assert.doesNotMatch(m.body + m.htmlBody, /KB-DUMMY|OLD-DUMMY/);
});

test('日付が解釈できない予約でも件名が壊れない（日時部分を省く）', function () {
  var m = T.buildConfirmedMail(rec({ date: 'invalid', startAt: '', endAt: '' }), CONFIG);
  assert.strictEqual(m.subject, '【SNB】予約確定');
  assert.doesNotMatch(m.body + m.htmlBody, /undefined|NaN|GMT/);
});
