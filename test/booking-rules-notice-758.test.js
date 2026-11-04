/* Issue #758: 予約ルール改定（予約間30分・当日延長60分前）の告知。告知日・施行日・従前条件の明記を確認する。 */
'use strict';
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
function read(f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); }

var WORDS = ['2026年11月4日', '2026年11月19日', '30分', '60分前', '延長できない場合があります', '従前の条件', '11月16日施行'];

['_includes/legal_ja.html', 'studio-x/legal/index.html'].forEach(function (f) {
  test('#758: ' + f + ' に予約ルール改定の告知（告知日・施行日・従前条件・自動変更なし）がある', function () {
    var t = read(f);
    assert.ok(t.indexOf('id="booking-rules-notice"') !== -1);
    WORDS.forEach(function (w) { assert.ok(t.indexOf(w) !== -1, w); });
    assert.ok(t.indexOf('自動で移動・取消しすることはありません') !== -1);
  });
});

test('#758: お知らせに告知日2026.11.04の項目があり、規約表記整備(11/16)と別告知と明記する', function () {
  var t = read('_data/news_ja.yml');
  var i = t.indexOf('- date: "2026.11.04"');
  assert.ok(i === t.indexOf('- date'), '先頭');
  var body = t.slice(i, t.indexOf('- date', i + 5));
  ['2026年11月19日', '30分', '60分前を過ぎると、延長できない場合があります', '従前の条件', '別の告知'].forEach(function (w) { assert.ok(body.indexOf(w) !== -1, w); });
});

['_includes/booking_app_ja.html', '_includes/booking_app_en.html'].forEach(function (f) {
  test('#758: ' + f + ' の予約画面に予約ルール改定の案内がある', function () {
    var t = read(f);
    assert.ok(t.indexOf('id="ba-booking-rules-notice"') !== -1);
    assert.ok(/30-minute|30分/.test(t) && /60 minutes|60分/.test(t));
  });
});

test('#758: 英語規約(legal/en.html)に予約ルール改定の告知（告知日・施行日時JST・復活含む30分・当日延長・従前条件・自動変更なし）がある', function () {
  var t = read('legal/en.html');
  assert.ok(t.indexOf('id="booking-rules-notice"') !== -1);
  ['November 4, 2026', '00:00 (midnight) JST on November 19, 2026', '30-minute gap', 'restoration of expired bookings', 'exactly 30 minutes is allowed',
    '60 minutes remain before the end', 'start time and only lengthens the end time', 'current conditions apply until the effective date',
    'not moved or cancelled automatically', 'unchanged', 'separate from the terms wording update effective November 16'].forEach(function (w) { assert.ok(t.indexOf(w) !== -1, w); });
});
