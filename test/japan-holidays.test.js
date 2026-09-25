'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;

function load() {
  return loadBookingSandbox(['JapanHolidays.gs'], {});
}

test('fixed-date holidays', function () {
  var h = load().JapanHolidays;
  assert.equal(h.isHoliday('2026-01-01'), true);
  assert.equal(h.holidayName('2026-01-01'), '元日');
  assert.equal(h.isHoliday('2026-04-29'), true);
  assert.equal(h.isHoliday('2026-11-23'), true);
  assert.equal(h.isHoliday('2026-06-15'), false);
});

test('happy-monday holidays (nth Monday of month)', function () {
  var h = load().JapanHolidays;
  /* 2026年1月の第2月曜日は1/12（成人の日）。 */
  assert.equal(h.isHoliday('2026-01-12'), true);
  assert.equal(h.holidayName('2026-01-12'), '成人の日');
  assert.equal(h.isHoliday('2026-01-05'), false);
  assert.equal(h.isHoliday('2026-01-19'), false);
});

test('substitute holiday (振替休日) when a fixed holiday falls on Sunday', function () {
  var h = load().JapanHolidays;
  /* 2024年: 2/11(建国記念の日)は日曜 → 2/12が振替休日。 */
  assert.equal(h.isHoliday('2024-02-11'), true);
  assert.equal(h.isHoliday('2024-02-12'), true);
  assert.equal(h.holidayName('2024-02-12'), '振替休日');
  /* 2024年: 8/11(山の日)は日曜 → 8/12が振替休日。 */
  assert.equal(h.isHoliday('2024-08-12'), true);
  /* 2024年: 11/3(文化の日)は日曜 → 11/4が振替休日。 */
  assert.equal(h.isHoliday('2024-11-04'), true);
});

test('substitute holiday cascades past already-holiday days (2024/2026 Golden Week pattern)', function () {
  var h = load().JapanHolidays;
  /* 2024年: 5/5(こどもの日)は日曜 → 5/6が振替休日。 */
  assert.equal(h.isHoliday('2024-05-06'), true);
  assert.equal(h.holidayName('2024-05-06'), '振替休日');
});

test('equinox days fall within the expected range', function () {
  var h = load().JapanHolidays;
  var vernalFound = false;
  var autumnalFound = false;
  for (var day = 19; day <= 22; day++) {
    var d = '2026-03-' + (day < 10 ? '0' + day : day);
    if (h.holidayName(d) === '春分の日') vernalFound = true;
  }
  for (day = 21; day <= 24; day++) {
    d = '2026-09-' + (day < 10 ? '0' + day : day);
    if (h.holidayName(d) === '秋分の日') autumnalFound = true;
  }
  assert.equal(vernalFound, true);
  assert.equal(autumnalFound, true);
});

test('national bridge holiday (国民の休日) between two holidays', function () {
  var h = load().JapanHolidays;
  /* 2015年: 9/21(敬老の日・第3月曜)と9/23(秋分の日)に挟まれた9/22が国民の休日
     （いわゆるシルバーウィークの実例）。 */
  assert.equal(h.isHoliday('2015-09-21'), true);
  assert.equal(h.isHoliday('2015-09-22'), true);
  assert.equal(h.holidayName('2015-09-22'), '国民の休日');
  assert.equal(h.isHoliday('2015-09-23'), true);
});

test('isWeekendOrHoliday covers Saturday, Sunday and holidays only', function () {
  var h = load().JapanHolidays;
  assert.equal(h.isWeekendOrHoliday('2026-09-25'), false); // 金曜（祝日でも週末でもない）
  assert.equal(h.isWeekendOrHoliday('2026-09-26'), true); // 土曜
  assert.equal(h.isWeekendOrHoliday('2026-09-27'), true); // 日曜
  assert.equal(h.isWeekendOrHoliday('2026-01-01'), true); // 元日（木曜）
});

test('invalid input fails closed to false', function () {
  var h = load().JapanHolidays;
  assert.equal(h.isHoliday('not-a-date'), false);
  assert.equal(h.isHoliday('2026-13-40'), false);
  assert.equal(h.isHoliday(''), false);
  assert.equal(h.isHoliday(null), false);
});
