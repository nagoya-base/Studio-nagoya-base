'use strict';
/* Issue #609: how-to の予約・決済説明が現行予約アプリ（scripts/booking-logic.js）の仕様と一致していること。 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function textOf(html) { return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' '); }

var Logic = require('../scripts/booking-logic.js');
var PAGES = ['how-to/index.html', 'mens/how-to/index.html'];

PAGES.forEach(function (p) {
  var t = textOf(read(p));

  test('#609 ' + p + ': カード決済は申込後に決済ページへ進み、30分以内の支払い完了で確定と案内する', function () {
    assert.ok(t.indexOf('オンラインクレジットカード決済：申込後、そのまま決済ページへ進みます') !== -1);
    assert.ok(t.indexOf('申込後30分以内にお支払いを完了すると予約確定') !== -1);
    assert.ok(t.indexOf('未決済・期限切れの場合、予約は確定しません') !== -1);
  });

  test('#609 ' + p + ': 現金・PayPayは仮受付で、通常24時間以内の確定連絡で成立と案内する', function () {
    assert.ok(t.indexOf('現金・PayPay：送信時点では仮受付') !== -1);
    assert.ok(t.indexOf('通常24時間以内に当方から確定のご連絡') !== -1);
    assert.ok(t.indexOf('その連絡をもって予約成立') !== -1);
  });

  test('#609 ' + p + ': 初回利用はカード決済のみと案内する', function () {
    assert.ok(t.indexOf('はじめてご利用の方：お支払いはオンラインクレジットカード決済のみ') !== -1);
  });

  test('#609 ' + p + ': 旧フロー文言（決済リンク送付・承認で確定・全員一律の仮予約送信）が残っていない', function () {
    assert.ok(!/決済リンク/.test(t), '決済リンク');
    assert.ok(!/お支払い確認後の承認/.test(t), '支払い確認後の承認');
    assert.ok(!/承認をもって予約確定/.test(t), '承認をもって予約確定');
    assert.ok(!/24時間以内に決済/.test(t), '24時間以内に決済');
    assert.ok(!/仮予約を送信/.test(t), '仮予約を送信');
    assert.ok(!/予約確定連絡を受け取る/.test(t), '旧ステップ見出し');
  });
});

test('#609: how-to の30分は予約アプリの支払い猶予と一致している', function () {
  var copy = Logic.bookingFlowCopy('オンラインクレジットカード', 'ja');
  assert.ok(copy.banner.body.indexOf('30分以内') !== -1);
  assert.ok(Logic.bookingFlowCopy('現金', 'ja').banner.title.indexOf('仮受付') !== -1);
});

test('#609: SNB関連ページ（Studio X・英語版を除く）に旧決済リンクフローの案内が残っていない', function () {
  ['index.html', 'mens/index.html', 'booking/index.html', 'mens/booking/index.html', 'membership/index.html',
    'mens/membership/index.html', 'legal/index.html', '_includes/phase2_trust_ja.html', '_includes/booking_app_ja.html',
    '_includes/reservation_form_ja.html'].forEach(function (p) {
    var t = textOf(read(p));
    assert.ok(!/24時間以内に決済リンク/.test(t), p);
    assert.ok(!/お支払い確認後の承認をもって予約確定/.test(t), p);
  });
});
