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

test('#758: お知らせに告知日2026.11.04の項目（予約ルール改定／予約開始時刻）があり、規約表記整備(11/16)と別告知と明記する', function () {
  var t = read('_data/news_ja.yml');
  assert.ok(t.indexOf('- date: "2026.11.04"') === t.indexOf('- date'), '先頭');
  var entries = t.split('\n- date: ').map(function (e) { return e; });
  var rules = entries.filter(function (e) { return e.indexOf('予約ルール改定のお知らせ】告知日') !== -1; })[0];
  var slot = entries.filter(function (e) { return e.indexOf('予約開始時刻のお知らせ】') !== -1; })[0];
  assert.ok(rules && slot);
  ['2026年11月19日', '30分', '60分前を過ぎると、延長できない場合があります', '従前の条件', '別の告知'].forEach(function (w) { assert.ok(rules.indexOf(w) !== -1, w); });
  ['2026年11月4日', '2026年11月19日 0:00', '毎時00分・30分', '1時間単位', '従前の開始候補（15分刻み）', '自動で変更・取消しすることはありません'].forEach(function (w) { assert.ok(slot.indexOf(w) !== -1, w); });
});

test('#758: 開始時刻30分刻みの告知が規約3種・英語規約・予約画面にあり、FAQの当日延長にも予告がある', function () {
  ['_includes/legal_ja.html', 'studio-x/legal/index.html'].forEach(function (f) {
    var t = read(f);
    ['毎時00分・30分', '15分・45分の開始は選べなくなります', '1時間単位'].forEach(function (w) { assert.ok(t.indexOf(w) !== -1, f + ' ' + w); });
  });
  var en = read('legal/en.html');
  ['top and half of each hour', '1-hour units', ':15 or :45 remain valid'].forEach(function (w) { assert.ok(en.indexOf(w) !== -1, w); });
  assert.ok(read('_includes/booking_app_ja.html').indexOf('毎時00分・30分') !== -1);
  assert.ok(read('_includes/booking_app_en.html').indexOf(':00 and :30') !== -1);
  ['how-to/index.html', 'mens/how-to/index.html'].forEach(function (f) {
    var t = read(f);
    var phrase = '2026年11月19日0:00（日本時間）以降は、利用当日に開始時刻を変えず終了のみ延ばす延長について、終了時刻の60分前を過ぎると、延長できない場合があります（11月18日までは従前のとおりです）。';
    assert.strictEqual(t.split(phrase).length - 1, 2, f + ': 画面表示とFAQPage JSON-LDの両方');
    assert.ok(t.indexOf('次の予約が空いている場合のみ可能です。当日は連絡がつかない場合もあるため、延長をご希望の場合は事前にご相談ください。') !== -1, '既存の事前相談・空き枠条件を保持');
  });
  assert.ok(read('studio-x/how-to/index.html').indexOf('11月18日までは従前のとおりです') !== -1);
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
