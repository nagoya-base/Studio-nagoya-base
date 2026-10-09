/*
 * test/helpers/future-date.js（実行日から独立した未来日／未来月の生成。Issue #393）のテスト。
 * 年またぎ・JST日付境界・月末を固定のbaseMillisで検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var futureDate = require('./helpers/future-date');

test('futureJstMonth: 12月の2ヶ月先は翌年2月、11月の2ヶ月先は翌年1月（年またぎ）', function () {
  var dec = futureDate.futureJstMonth(2, Date.parse('2026-12-15T12:00:00+09:00'));
  assert.deepStrictEqual(
    { year: dec.year, month: dec.month, monthString: dec.monthString, firstDay: dec.firstDay, yearParam: dec.yearParam, monthParam: dec.monthParam },
    { year: 2027, month: 2, monthString: '2027-02', firstDay: '2027-02-01', yearParam: '2027', monthParam: '2' }
  );
  var nov = futureDate.futureJstMonth(2, Date.parse('2026-11-30T23:00:00+09:00'));
  assert.strictEqual(nov.monthString, '2027-01');
  assert.strictEqual(nov.monthParam, '1', 'doGetのクエリ用monthはゼロ埋めしない');
});

test('futureJstMonth: 12月の1ヶ月先は翌年1月、offset 0は当月、12ヶ月先は翌年の同月', function () {
  var base = Date.parse('2026-12-31T20:00:00+09:00');
  assert.strictEqual(futureDate.futureJstMonth(1, base).monthString, '2027-01');
  assert.strictEqual(futureDate.futureJstMonth(0, base).monthString, '2026-12');
  assert.strictEqual(futureDate.futureJstMonth(12, base).monthString, '2027-12');
});

test('futureJstMonth: daysInMonthは月ごとの日数（2月は平年28・閏年29、年またぎの1月は31）', function () {
  assert.strictEqual(futureDate.futureJstMonth(2, Date.parse('2026-12-15T12:00:00+09:00')).daysInMonth, 28);
  assert.strictEqual(futureDate.futureJstMonth(2, Date.parse('2027-12-15T12:00:00+09:00')).daysInMonth, 29);
  assert.strictEqual(futureDate.futureJstMonth(2, Date.parse('2026-11-30T23:00:00+09:00')).daysInMonth, 31);
});

test('futureJstMonth: UTCでは前月でもJSTで翌月になる時刻はJSTの月を基準にする', function () {
  /* 2026-11-30T16:00Z = JST 2026-12-01 01:00 */
  var m = futureDate.futureJstMonth(0, Date.parse('2026-11-30T16:00:00Z'));
  assert.strictEqual(m.monthString, '2026-12');
});

test('futureJstDate: 年またぎ・月末をまたいでJSTの日付を返す', function () {
  var base = Date.parse('2026-12-15T12:00:00+09:00');
  assert.strictEqual(futureDate.futureJstDate(30, base), '2027-01-14');
  assert.strictEqual(futureDate.futureJstDate(0, Date.parse('2026-11-30T16:00:00Z')), '2026-12-01');
});
