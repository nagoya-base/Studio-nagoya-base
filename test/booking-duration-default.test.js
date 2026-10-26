/*
 * Issue #494: 予約フォームの利用時間は全ブランド共通で初期3時間のプルダウン。
 * 料金ロジックは変更しないため、ここではフォーム構造・初期値・貸切プラン解除時の復帰・
 * durationMinutesへの変換を検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var Logic = require('../scripts/booking-logic.js');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }

[['ja', '_includes/booking_app_ja.html'], ['en', '_includes/booking_app_en.html']].forEach(function (c) {
  test(c[0] + ': 利用時間は<select>で、3時間のみがselectedの初期値', function () {
    var m = read(c[1]).match(/<select id="ba-duration"[^>]*>([\s\S]*?)<\/select>/);
    assert.ok(m, '#ba-durationはselect');
    var options = m[1].match(/<option value="\d+"[^>]*>/g);
    assert.deepStrictEqual(options.map(function (o) { return o.match(/value="(\d+)"/)[1]; }),
      ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']);
    var selected = options.filter(function (o) { return o.indexOf('selected') !== -1; });
    assert.strictEqual(selected.length, 1);
    assert.ok(selected[0].indexOf('value="3"') !== -1, '初期値は3時間');
    assert.ok(/<label for="ba-duration">/.test(read(c[1])), 'labelが紐づく');
  });
});

test('SNB / SNB mens / Studio Xは同じ共通includeを使い、ブランド別の初期値を持たない', function () {
  ['booking/index.html', 'mens/booking/index.html', 'studio-x/booking/index.html'].forEach(function (rel) {
    assert.ok(read(rel).indexOf('booking_app_ja.html') !== -1, rel);
  });
  ['ja', 'en'].forEach(function (l) {
    var html = read('_includes/booking_app_' + l + '.html');
    var block = html.match(/<select id="ba-duration"[\s\S]*?<\/select>/)[0];
    assert.ok(block.indexOf('include.brand') === -1 && block.indexOf('{%') === -1);
  });
});

test('初期値定数は3時間で、選択値は180分のdurationMinutesになる', function () {
  assert.strictEqual(Logic.DEFAULT_DURATION_HOURS, 3);
  assert.strictEqual(Logic.durationHoursToMinutes(Logic.DEFAULT_DURATION_HOURS), 180);
  assert.strictEqual(Logic.durationHoursToMinutes('4'), 240);
});

test('貸切プランは6時間固定、解除すると3時間へ戻り選択可能になる', function () {
  var app = read('scripts/booking-app.js');
  assert.ok(app.indexOf('els.duration.value = String(Logic.EVENT_BASE_PLAN_HOURS)') !== -1);
  assert.ok(app.indexOf('els.duration.disabled = true') !== -1);
  assert.ok(app.indexOf('els.duration.value = String(Logic.DEFAULT_DURATION_HOURS || 3)') !== -1);
  assert.ok(app.indexOf('els.duration.disabled = false') !== -1);
});
