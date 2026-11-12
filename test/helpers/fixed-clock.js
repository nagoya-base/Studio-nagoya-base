/*
 * 予約フォーム画面テスト用の固定時計（Issue #903）。
 *
 * 画面テストは「今日の10:00枠」を選ぶため、実行時刻が JST 09:30 を過ぎると Issue #895 の
 * 直前予約ガード（利用開始まで30分以下は確認チェックが必要）が正しく作動し、
 * 「次へ進む」で進めなくなる＝テストが実行時刻に依存して落ちていた。
 * サンドボックス内の Date だけを「JST 当日 06:00」に固定して、実行時刻に左右されないようにする。
 * 画面ロジック（#895 のガード）自体は無変更。ガードの検証は booking-short-lead-notice-895.test.js が担う。
 */
'use strict';

var RealDate = Date;

function jstTodayAtSix() {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new RealDate());
  var r = {};
  parts.forEach(function (p) { if (p.type !== 'literal') r[p.type] = p.value; });
  return new RealDate(r.year + '-' + r.month + '-' + r.day + 'T06:00:00+09:00').getTime();
}

/* 引数なしの new Date() / Date.now() だけを固定し、他の使い方は本物のDateへ委譲する。 */
function createFixedDate(nowMs) {
  var fixed = nowMs === undefined ? jstTodayAtSix() : nowMs;
  function FixedDate() {
    if (arguments.length === 0) return new RealDate(fixed);
    var a = Array.prototype.slice.call(arguments);
    return new (Function.prototype.bind.apply(RealDate, [null].concat(a)))();
  }
  FixedDate.now = function () { return fixed; };
  FixedDate.UTC = RealDate.UTC;
  FixedDate.parse = RealDate.parse;
  FixedDate.prototype = RealDate.prototype;
  return FixedDate;
}

module.exports = { createFixedDate: createFixedDate };
