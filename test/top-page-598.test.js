/*
 * Issue #598: SNBトップのスマホ表示を再圧縮する（長文の常時表示を要約＋アコーディオンへ）。
 * 情報は削除せず、常時表示を減らす。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function textOf(html) { return html.replace(/<[^>]+>/g, ''); }

var top = read('index.html');
var form = read('_includes/reservation_form_ja.html');

test('#598: 予約CTA直下は要約のみ常時表示し、支払い・期限・当日予約の詳細はアコーディオンに保持する', function () {
  var m = top.match(/<p class="calendar-note">(予約ページから日時を選んで[\s\S]*?)<\/p>\s*<details class="note-details">([\s\S]*?)<\/details>/);
  assert.ok(m, '要約＋予約・支払いの詳細');
  assert.ok(textOf(m[1]).length <= 120, '常時表示は2〜3行程度');
  ['予約未確定', '確定連絡', 'オンラインクレジットカード決済のみ'].forEach(function (w) { assert.ok(m[1].indexOf(w) !== -1, '要約: ' + w); });
  assert.ok(/<summary>予約・支払いの詳細/.test(m[2]));
  ['送信だけでは予約確定ではありません', '24時間以内', '現金・PayPay', 'はじめてご利用の方はオンラインクレジットカード決済のみ', '決済ページの有効期限',
    '期限切れ・決済未完了の場合、予約は確定しません', '当日のご予約', '会員登録の有無は当日予約の条件ではありません'].forEach(function (w) {
    assert.ok(m[2].indexOf(w) !== -1, '詳細に保持: ' + w);
  });
  assert.ok(!/<details[^>]*\sopen/.test(m[0]), '初期は閉じている');
});

test('#598: 問い合わせフォームの必須同意は維持し、注意書きは圧縮する', function () {
  ['reservation-terms', 'reservation-safety', 'reservation-carrier-mail'].forEach(function (id) {
    assert.ok(new RegExp('id="' + id + '"[^>]*required').test(form), id + ' は必須のまま');
  });
  var carrier = form.slice(form.indexOf('reservation-carrier-notice'), form.indexOf('<div class="reservation-consents">', form.indexOf('reservation-carrier-notice')));
  assert.ok(/<details class="note-details">/.test(carrier) && !/\sopen/.test(carrier), 'キャリアメール注意の詳細は閉じたアコーディオン');
  assert.ok(carrier.indexOf('Gmailからのメールを受信できる設定') !== -1, '詳細の文言を保持');
  assert.strictEqual(form.indexOf('reservation-review-note'), -1, '送信前注意の独立カードは持たない');
  var privacy = form.match(/<p class="reservation-privacy">([\s\S]*?)<\/p>/)[1];
  assert.ok(privacy.indexOf('#privacy') !== -1 && privacy.indexOf('Formspree') !== -1 && privacy.indexOf('送信前に入力内容とメールアドレスをご確認ください') !== -1);
  assert.ok(textOf(privacy).length <= 110, 'プライバシー説明は短く');
});

test('#598: SNB MEMBERの常時表示は要点のみで、契約条件・割引額は詳細に1回だけ保持する', function () {
  var cta = top.slice(top.indexOf('<div class="snb-member-cta"'), top.indexOf('</details>', top.indexOf('<div class="snb-member-cta"')));
  var visible = cta.slice(0, cta.indexOf('<details'));
  ['月額500円', '3時間以上のご利用で一般料金より安く', '差額が月会費500円相当'].forEach(function (w) { assert.ok(visible.indexOf(w) !== -1, w); });
  assert.ok(textOf(visible).length < 150, '常時表示本文が短い');
  assert.ok(visible.indexOf('1〜2時間') === -1 && visible.indexOf('延長1時間ごとに500円') === -1, '詳細は常時表示しない');
  var details = cta.slice(cta.indexOf('<details'));
  ['3時間で500円、4時間で1,000円、延長1時間ごとに500円', '1〜2時間のご利用では一般料金との差はありません', '自動更新（Stripe）', '2名ペアパック'].forEach(function (w) {
    assert.strictEqual(top.split(w).length - 1, 1, w + ' は1回だけ');
    assert.ok(details.indexOf(w) !== -1, '詳細内: ' + w);
  });
});

test('#598: 平日6時間パスは閉じたアコーディオンで、トップでは長文展開しない', function () {
  var m = top.match(/<details class="faq-item pricing-details">\s*<summary>📅 平日6時間パス[^<]*<\/summary>/);
  assert.ok(m && m[0].indexOf(' open') === -1);
});
