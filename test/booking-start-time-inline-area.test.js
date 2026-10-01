/*
 * 日付クリック後もカレンダーを残し、その直下に開始時刻を表示するUX（Step1内エリア）の
 * HTML/CSS構造テスト。挙動（loading→一覧・古い応答の破棄等）はbooking-calendar-ui.test.jsで検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

[['ja', '_includes/booking_app_ja.html', '予約できる時間を検索しています…'],
 ['en', '_includes/booking_app_en.html', 'Searching available start times…']].forEach(function (c) {
  var html = read(c[1]);
  test(c[0] + ': 開始時刻エリアはStep1最下部（利用料金の後ろ）にあり、独立したStep2セクションは存在しない', function () {
    assert.ok(html.indexOf('id="ba-step-start-time"') === -1, '旧Step2セクションは無い');
    assert.ok(html.indexOf('id="ba-step-start-time-back"') === -1, '戻るボタンは不要');
    var step1Start = html.indexOf('id="ba-step-datetime"');
    var step1End = html.indexOf('id="ba-step-details"');
    var calendar = html.indexOf('id="ba-calendar-selected"');
    var area = html.indexOf('id="ba-start-time-area"');
    var price = html.indexOf('id="ba-price-box"');
    var step1Close = html.lastIndexOf('</section>', step1End);
    assert.ok(step1Start < calendar && calendar < price && price < area && area < step1Close && step1Close < step1End, 'カレンダー→料金→開始時刻エリアの順でStep1最下部にある');
    assert.ok(html.slice(area, step1Close).indexOf('ba-field') === -1, 'エリア後ろに入力欄は無い');
    assert.ok(html.indexOf('ba-start-time-price-line') === -1 && html.indexOf('ba-start-time-price-note') === -1, '開始時刻側の料金DOMは無い');
    assert.strictEqual(html.split('id="ba-price-line"').length - 1, 1, '料金表示は1か所');
    ['ba-start-time-loading', 'ba-start-time-grid', 'ba-start-time-empty', 'ba-start-time-error', 'ba-step-start-time-next']
      .forEach(function (id) { var i = html.indexOf('id="' + id + '"'); assert.ok(i > area && i < step1End, id); });
    assert.ok(html.indexOf(c[2]) !== -1, '検索中文言');
  });
});

test('375px幅: 開始時刻グリッドは折り返し（auto-fill）で、横スクロールを生む固定幅を持たない', function () {
  var css = read('styles/booking.css');
  assert.ok(/\.ba-time-grid \{ grid-template-columns: repeat\(auto-fill, minmax\(76px, 1fr\)\); \}/.test(css));
  assert.ok(/\.ba-start-time-area \{[^}]*min-width: 0;/.test(css));
});

test('JS: 開始時刻側の料金DOM参照とstart-timeへのscrollIntoViewが無い', function () {
  var js = read('scripts/booking-app.js');
  assert.ok(js.indexOf('startTimePrice') === -1 && js.indexOf('ba-start-time-price') === -1);
  assert.ok(!/scrollIntoView[^\n]*startTimeArea|startTimeArea[^\n]*scrollIntoView/.test(js));
});
