'use strict';
// Issue #604: SNB平日6時間パスの廃止。Studio Xの「6時間貸切ベースプラン」は別制度のため維持する。
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }

test('#604: SNB公開ページ・規約に平日6時間パスの現行案内が残っていない', function () {
  ['index.html', 'mens/index.html', '_includes/legal_ja.html', 'legal/index.html', 'mens/legal/index.html', 'en.html', 'legal/en.html'].forEach(function (p) {
    if (!fs.existsSync(path.join(__dirname, '..', p))) return;
    var t = read(p);
    assert.ok(!/平日6時間パス|月6時間まで|¥9,800/.test(t), p);
  });
  assert.ok(!/17\. 平日6時間パス/.test(read('_includes/legal_ja.html')));
});

test('#604: 開始告知は履歴として残り、終了告知が追加されている', function () {
  var news = read('_data/news_ja.yml');
  assert.ok(news.indexOf('平日6時間パス（月額9,800円）の提供を開始しました') !== -1, '2026.06.17の開始告知は維持');
  var m = news.match(/- date: "2026\.10\.28"\n  type: "お知らせ"\n  body: "([^"]*)"/);
  assert.ok(m, '終了告知');
  ['平日6時間パスの提供を終了しました', '新規のお申し込み', '個別のご案内も終了', 'SNB MEMBER', '通常の時間料金に変更はありません'].forEach(function (w) {
    assert.ok(m[1].indexOf(w) !== -1, w);
  });
});

test('#604: GASコメントに旧制度参照が残っていない', function () {
  assert.ok(read('gas/booking/shared/BookingPricing.gs').indexOf('平日6時間パス') === -1);
});

test('#604: Studio Xの6時間貸切ベースプランは維持されている', function () {
  var app = read('_includes/booking_app_ja.html');
  assert.ok(app.indexOf('6時間貸切ベースプラン') !== -1);
  assert.ok(app.indexOf('osu_cosplay_base_6h') !== -1);
});
