/*
 * JapanHolidays.gs — 日本の祝日判定（Issue #344追記: 料金差額自動計算の「祝日判定」）。
 *
 * 「土日祝」料金区分に使う祝日判定のみが目的。休日給与計算・官公庁休業日等の他用途は
 * 対象外。2000年〜2099年の現行祝日法（2000年のハッピーマンデー制度導入後、
 * 天皇誕生日=2/23（2020年〜）・スポーツの日（2020年〜。旧体育の日）を含む現行の
 * 固定運用）を前提に、以下の3種類を計算する（東京オリンピック特例による2020/2021年限りの
 * 祝日移動は対象外。本システムが扱うのは今日以降の予約のみのため）。
 * - 固定日祝日（元日・建国記念の日等）
 * - ハッピーマンデー（第2月曜日・第3月曜日で決まる祝日）
 * - 春分の日／秋分の日（1980〜2099年に有効な近似式で算出。国立天文台の官報告知と
 *   ほぼ一致することが知られている広く使われた近似式）
 * - 国民の休日（前後を祝日に挟まれた祝日でない日）
 * - 振替休日（祝日が日曜日と重なった場合、その日以降で祝日でない直近の日）
 *
 * 日付はすべて'YYYY-MM-DD'のカレンダー日付として扱う（タイムゾーン変換は行わない。
 * 呼び出し側が既にAsia/Tokyo基準の日付文字列へ正規化していることを前提とする）。
 * 曜日計算はAvailability.gsのisValidDateString/formatDateWithWeekdayと同じ
 * Date.UTC(y, m-1, d) + getUTCDay()方式を使う（実行環境のtimezoneに依存しない）。
 */
'use strict';

var JapanHolidays = (function () {
  var MONTH_DAY_HOLIDAYS_ = [
    { month: 1, day: 1, name: '元日' },
    { month: 2, day: 11, name: '建国記念の日' },
    { month: 2, day: 23, name: '天皇誕生日' },
    { month: 4, day: 29, name: '昭和の日' },
    { month: 5, day: 3, name: '憲法記念日' },
    { month: 5, day: 4, name: 'みどりの日' },
    { month: 5, day: 5, name: 'こどもの日' },
    { month: 8, day: 11, name: '山の日' },
    { month: 11, day: 3, name: '文化の日' },
    { month: 11, day: 23, name: '勤労感謝の日' }
  ];

  /* 第N月曜日で決まる祝日（ハッピーマンデー制度。2000年〜）。 */
  var NTH_MONDAY_HOLIDAYS_ = [
    { month: 1, nth: 2, name: '成人の日' },
    { month: 7, nth: 3, name: '海の日' },
    { month: 9, nth: 3, name: '敬老の日' },
    { month: 10, nth: 2, name: 'スポーツの日' }
  ];

  function toUtcDays_(year, month, day) {
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  function utcDaysToDateString_(utcDays) {
    var d = new Date(utcDays * 86400000);
    var year = d.getUTCFullYear();
    var month = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    return year + '-' + (month < 10 ? '0' + month : month) + '-' + (day < 10 ? '0' + day : day);
  }

  function weekdayOf_(utcDays) {
    return new Date(utcDays * 86400000).getUTCDay();
  }

  function nthMondayOfMonth_(year, month, nth) {
    var firstWeekday = weekdayOf_(toUtcDays_(year, month, 1));
    var firstMonday = 1 + ((8 - firstWeekday) % 7);
    return firstMonday + (nth - 1) * 7;
  }

  /* 春分の日／秋分の日（1980〜2099年有効の近似式）。 */
  function vernalEquinoxDay_(year) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }
  function autumnalEquinoxDay_(year) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  /* year年の「基本祝日」（固定日・ハッピーマンデー・春分秋分）をutcDays→nameのMapで返す。
     振替休日・国民の休日はここには含めない（baseHolidaysMap_だけを見て判定するため）。 */
  function baseHolidaysMap_(year) {
    var map = {};
    MONTH_DAY_HOLIDAYS_.forEach(function (h) {
      map[toUtcDays_(year, h.month, h.day)] = h.name;
    });
    NTH_MONDAY_HOLIDAYS_.forEach(function (h) {
      map[toUtcDays_(year, h.month, nthMondayOfMonth_(year, h.month, h.nth))] = h.name;
    });
    map[toUtcDays_(year, 3, vernalEquinoxDay_(year))] = '春分の日';
    map[toUtcDays_(year, 9, autumnalEquinoxDay_(year))] = '秋分の日';
    return map;
  }

  /*
   * 指定年について、国民の休日・振替休日まで含めた祝日Map（utcDays→name）を返す。
   * 前後の年境界（1/1前後・12/31後）の振替休日発生は現行の祝日配置では起こらないため
   * （最も年末に近い固定祝日は11/23で、その直後に日曜が続いても振替休日は12月中に収まる）、
   * 単年度内で閉じて計算する。
   */
  function holidaysMapForYear_(year) {
    var base = baseHolidaysMap_(year);

    /* 国民の休日: 祝日でない日の前後が両方とも祝日（base基準）で、かつ日曜でない日。 */
    var yearStart = toUtcDays_(year, 1, 1);
    var yearEnd = toUtcDays_(year, 12, 31);
    for (var d = yearStart + 1; d < yearEnd; d += 1) {
      if (base[d]) continue;
      if (weekdayOf_(d) === 0) continue;
      if (base[d - 1] && base[d + 1]) {
        base[d] = '国民の休日';
      }
    }

    /* 振替休日: 祝日が日曜日の場合、その日以降で祝日でない直近の日を振替休日とする。
       複数の祝日が連続するケース（例: 5/4・5/5が祝日で5/3が日曜）にも対応するため、
       日付昇順に処理し、都度その時点のbaseを見て「祝日でない日」を探す。 */
    var sundayHolidayDays = Object.keys(base)
      .map(function (key) { return parseInt(key, 10); })
      .filter(function (d) { return weekdayOf_(d) === 0; })
      .sort(function (a, b) { return a - b; });
    sundayHolidayDays.forEach(function (sunday) {
      var candidate = sunday + 1;
      while (base[candidate]) candidate += 1;
      base[candidate] = '振替休日';
    });

    return base;
  }

  var CACHE_ = {};
  function holidaysMapForYearCached_(year) {
    if (!CACHE_[year]) CACHE_[year] = holidaysMapForYear_(year);
    return CACHE_[year];
  }

  /* dateString: 'YYYY-MM-DD'。不正な形式・不正な日付はfalseを返す（fail-closedに
     「祝日ではない」扱いにする。呼び出し側でisValidDateString等を通した後に使う想定）。 */
  function isHoliday(dateString) {
    if (typeof dateString !== 'string') return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!m) return false;
    var year = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    var day = parseInt(m[3], 10);
    var utcDays = toUtcDays_(year, month, day);
    if (utcDaysToDateString_(utcDays) !== dateString) return false;
    return !!holidaysMapForYearCached_(year)[utcDays];
  }

  function holidayName(dateString) {
    if (!isHoliday(dateString)) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    var year = parseInt(m[1], 10);
    var utcDays = toUtcDays_(year, parseInt(m[2], 10), parseInt(m[3], 10));
    return holidaysMapForYearCached_(year)[utcDays] || '';
  }

  function isWeekend_(dateString) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString);
    if (!m) return false;
    var weekday = weekdayOf_(toUtcDays_(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)));
    return weekday === 0 || weekday === 6;
  }

  /* 料金区分の「土日祝」判定（Issue #344追記）。土曜・日曜・祝日のいずれか。 */
  function isWeekendOrHoliday(dateString) {
    return isWeekend_(dateString) || isHoliday(dateString);
  }

  return {
    isHoliday: isHoliday,
    holidayName: holidayName,
    isWeekendOrHoliday: isWeekendOrHoliday
  };
})();
