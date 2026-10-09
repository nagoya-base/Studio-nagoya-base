/*
 * 実行日から独立した「未来の予約日／未来月」を生成するテスト用ヘルパー（Issue #393）。
 *
 * doGet / doPost（Code.gs）はnowを注入できず、実行時の実時刻(new Date())を基準に
 * 過去日を拒否する。テストの利用日を固定文字列（例: '2026-10-05'）にすると、実行日が
 * その日付を過ぎた時点で一斉にINVALID_DATE / OUT_OF_RANGEへ変わり自然故障する
 * （2026-10-09に顕在化）。実行時刻から動的に算出した日付を使い、実行日から独立させる。
 * すべてAsia/Tokyo（JST）基準で、月の計算は年またぎ（12月→翌年1月）を正しく扱う。
 */
'use strict';

var DAY_MILLIS = 24 * 3600000;

/* DateをJSTの'YYYY-MM-DD'へ変換する。 */
function formatJstDate(date) {
  var parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  var out = {};
  parts.forEach(function (part) { if (part.type !== 'literal') out[part.type] = part.value; });
  return out.year + '-' + out.month + '-' + out.day;
}

/* 現在のJST日付からoffsetDays日後の'YYYY-MM-DD'。 */
function futureJstDate(offsetDays, baseMillis) {
  var base = typeof baseMillis === 'number' ? baseMillis : Date.now();
  return formatJstDate(new Date(base + offsetDays * DAY_MILLIS));
}

/*
 * 現在のJST月からoffsetMonthsヶ月後の月を返す。
 * { year: 2027, month: 1, yearParam: '2027', monthParam: '1', monthString: '2027-01', firstDay: '2027-01-01', daysInMonth: 31 }
 * yearParam / monthParamはdoGetのクエリ（文字列。月はゼロ埋めなし）にそのまま使える。
 */
function futureJstMonth(offsetMonths, baseMillis) {
  var base = typeof baseMillis === 'number' ? baseMillis : Date.now();
  var today = formatJstDate(new Date(base)).split('-');
  var total = parseInt(today[0], 10) * 12 + (parseInt(today[1], 10) - 1) + offsetMonths;
  var year = Math.floor(total / 12);
  var month = (total % 12) + 1;
  var monthString = year + '-' + (month < 10 ? '0' : '') + month;
  return {
    year: year,
    month: month,
    yearParam: String(year),
    monthParam: String(month),
    monthString: monthString,
    firstDay: monthString + '-01',
    daysInMonth: new Date(Date.UTC(year, month, 0)).getUTCDate()
  };
}

module.exports = {
  formatJstDate: formatJstDate,
  futureJstDate: futureJstDate,
  futureJstMonth: futureJstMonth
};
