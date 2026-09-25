/*
 * JapaneseHolidays.gs — 日本の国民の祝日・振替休日・国民の休日の判定（Issue #346）。
 *
 * BookingPricing.gsのresolveDayType_が、土曜・日曜に加えて祝日等も「土日祝」料金へ
 * 分類するために使う。GAS実行環境のAPIに依存しない純粋関数のみで構成する
 * （BookingPricing.gs・Availability.gs・Booking.gsの一部関数と同方針。node --testで
 * そのままvm実行して検証できる）。
 *
 * データソース・実装方針（Issue #346「固定日の手書き列挙だけで済ませない」要件への対応）:
 * - 根拠法令は「国民の祝日に関する法律」（内閣府サイト
 *   https://www8.cao.go.jp/shukujitsu/gaiyou.html に現行の祝日一覧・要件の解説がある）。
 *   固定日の祝日（元日・建国記念の日・天皇誕生日・昭和の日・憲法記念日・みどりの日・
 *   こどもの日・山の日・文化の日・勤労感謝の日）のみ日付を直接列挙する。
 * - ハッピーマンデー対象（成人の日=1月第2月曜・海の日=7月第3月曜・敬老の日=9月第3月曜・
 *   スポーツの日=10月第2月曜）は、年ごとの日付を手書き列挙せず、nthMondayDate_で
 *   毎年計算する。
 * - 春分の日・秋分の日は、国立天文台が毎年2月1日に官報の「暦要項」で**翌年分**の
 *   確定日を公示する（本稿執筆時点で公示済みなのは概ね直近1年先まで）。本Issueの
 *   対応年（2020〜2099年）のほとんどは、まだ政府が公式に確定日を発表していない
 *   将来年であるため、公示済みの日付をそのまま転記することはできない。
 *   vernalEquinoxDay_/autumnalEquinoxDay_は、平均太陽年（回帰年。1年 = 約365.2422日）
 *   の長さとグレゴリオ暦のうるう年周期（4年に1回、ただし100で割り切れ400で割り切れない
 *   年は除く）から導かれる天文計算式で、日本の祝日計算を扱う複数の実装で広く採用されて
 *   いる近似式である。この式が算出する日付は、政府が「暦要項」で公式に確定日を発表する
 *   までは**天文計算に基づく予測**であり、法的な確定日そのものではない。
 *   根拠・検証範囲: 式が算出する年月日を、国立天文台が既に「暦要項」で公示済みの年
 *   （例: 2000年・2020年・2021年・2023年・2024年など。本ファイルの
 *   test/japanese-holidays.test.jsで実際にテストしている年）について突き合わせ、
 *   一致することを確認している。未公示の将来年についても、想定する周期性（回帰年の
 *   長さ・グレゴリオ暦のうるう年規則）が今後も変わらない前提のもとでは、同じ式が
 *   引き続き正しい値を返すと期待できる。ただし、これはあくまで数学的な外挿であり、
 *   国が閏年規則や暦法自体を変更した場合や、天体現象の実測に基づく再定義を行った場合
 *   （過去に例はないが）は、この式による予測と実際の公示日が食い違う可能性がある。
 *   `暦要項`公示のたびに、当年・翌年分について式の算出結果と実際の公示日を照合し、
 *   食い違いがあればLAW_HOLIDAYS_FOR_YEAR_へ個別の例外を追加すること（保守方法の節も
 *   参照）。式の係数は年ごとの手書きテーブルではない。
 * - 2020年・2021年のみ、東京オリンピック・パラリンピック競技大会特別措置法による
 *   一時的な法改正で海の日・スポーツの日・山の日の日付が例年と異なる（この2年に限る
 *   一回限りの法改正のため、アルゴリズムで導出できず、明示的な例外として個別に列挙する
 *   ほかない）。
 * - 振替休日（祝日が日曜に当たる場合、その後の最初の非祝日を休日とする。2007年改正で
 *   祝日が連続する場合も対応）・国民の休日（前後を祝日に挟まれた祝日でない平日）は、
 *   法律の定義どおりのアルゴリズムで計算する（addSubstituteHolidays_/
 *   addCitizensHolidays_）。
 *
 * 対応年の範囲（MIN_SUPPORTED_YEAR〜MAX_SUPPORTED_YEAR）:
 * - 下限2020年: 天皇誕生日が2/23（令和）に変わった年。この年より前は天皇誕生日の日付・
 *   体育の日→スポーツの日への改称前後などで祝日の定義が異なり、別ルールが必要になる。
 *   予約は将来日付のみが対象のため、令和の現行ルール一本化で運用上問題ない。
 * - 上限2099年: 春分・秋分の近似式が前提とするグレゴリオ暦のうるう年周期が単純に
 *   成り立つ範囲の上限（2100年は「100で割り切れ400で割り切れない」うるう年の例外に
 *   当たり、式の前提が崩れるため対象外）。式そのものの妥当性を2099年まで政府が
 *   公示済みという意味ではない（詳細は上の「春分の日・秋分の日」節参照）。
 * - この範囲外の日付はclassify()が{ok:false}を返す。呼び出し側（BookingPricing.gs）は
 *   これを黙って平日料金にフォールバックさせず、見積り・予約作成を明示的なエラーに
 *   する（Issue #346要件）。
 *
 * 保守方法:
 * - 国会が国民の祝日に関する法律を改正した場合（2020/2021のような一時的特例、または
 *   恒久的な祝日の追加・変更）、LAW_HOLIDAYS_FOR_YEAR_内の該当箇所を追記・修正する。
 * - 国立天文台が毎年2月1日に「暦要項」で翌年分の春分の日・秋分の日を公示したら、
 *   当年・翌年についてvernalEquinoxDay_/autumnalEquinoxDay_の算出結果と公示日を
 *   照合すること。一致しない年が出た場合は、その年をlawHolidaysForYear_内へ
 *   2020/2021の東京五輪特例と同じ形で個別の例外として追加する。
 * - MAX_SUPPORTED_YEARが近づいてきたら（目安: 2090年代に入ったら）、うるう年周期の
 *   前提が引き続き成り立つか、上限の延伸要否・式の更新要否を再検討する。
 */
'use strict';

var JapaneseHolidays = (function () {
  var MIN_SUPPORTED_YEAR = 2020;
  var MAX_SUPPORTED_YEAR = 2099;

  function pad2_(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function toDateString_(year, month, day) {
    return year + '-' + pad2_(month) + '-' + pad2_(day);
  }

  function isSupportedYear_(year) {
    return Number.isInteger(year) && year >= MIN_SUPPORTED_YEAR && year <= MAX_SUPPORTED_YEAR;
  }

  /* Date.UTC構築方式で曜日を求める（BookingPricing.resolveDayType_と同方針。ブラウザ/GAS
     実行環境のローカルtimezoneに依存しない）。0=日曜〜6=土曜。 */
  function weekdayOfUtc_(year, month, day) {
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  }

  /* 指定月・第nMonday（nth）の日付を返す（1〜31）。ハッピーマンデー祝日の算出専用。 */
  function nthMondayDate_(year, month, nth) {
    var firstWeekday = weekdayOfUtc_(year, month, 1);
    var firstMonday = 1 + ((8 - firstWeekday) % 7);
    return firstMonday + (nth - 1) * 7;
  }

  /*
   * 春分の日・秋分の日の近似計算式（1980〜2099年の範囲で有効）。平均太陽年の長さと
   * グレゴリオ暦のうるう年周期から導かれる天文計算式で、国立天文台が「暦要項」で
   * 公示済みの年については実際の公示日と一致することを確認しているが、未公示の
   * 将来年についてはあくまで予測値である（ファイル冒頭コメント「春分の日・秋分の日」
   * 節・「保守方法」節を参照）。
   */
  function vernalEquinoxDay_(year) {
    return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }
  function autumnalEquinoxDay_(year) {
    return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  /*
   * 「国民の祝日に関する法律」が直接定める祝日（振替休日・国民の休日を適用する前の
   * ベース集合）。dateString -> 祝日名 のマップを1年分返す。
   */
  function lawHolidaysForYear_(year) {
    var map = {};
    function set(month, day, name) {
      map[toDateString_(year, month, day)] = name;
    }

    set(1, 1, '元日');
    set(2, 11, '建国記念の日');
    set(2, 23, '天皇誕生日');
    set(4, 29, '昭和の日');
    set(5, 3, '憲法記念日');
    set(5, 4, 'みどりの日');
    set(5, 5, 'こどもの日');
    set(11, 3, '文化の日');
    set(11, 23, '勤労感謝の日');

    set(1, nthMondayDate_(year, 1, 2), '成人の日');
    set(9, nthMondayDate_(year, 9, 3), '敬老の日');

    /* 東京オリンピック・パラリンピック特措法による一回限りの特例（2020年・2021年のみ）。
       通常のハッピーマンデー/固定日ルールを、この2年だけ明示的な日付で上書きする。 */
    if (year === 2020) {
      set(7, 23, '海の日');
      set(7, 24, 'スポーツの日');
      set(8, 10, '山の日');
    } else if (year === 2021) {
      set(7, 22, '海の日');
      set(7, 23, 'スポーツの日');
      set(8, 8, '山の日');
    } else {
      set(7, nthMondayDate_(year, 7, 3), '海の日');
      set(10, nthMondayDate_(year, 10, 2), 'スポーツの日');
      set(8, 11, '山の日');
    }

    set(3, vernalEquinoxDay_(year), '春分の日');
    set(9, autumnalEquinoxDay_(year), '秋分の日');

    return map;
  }

  function addDaysToDateString_(dateString, delta) {
    var parts = dateString.split('-');
    var year = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var day = parseInt(parts[2], 10);
    var next = new Date(Date.UTC(year, month - 1, day));
    next.setUTCDate(next.getUTCDate() + delta);
    return toDateString_(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  }

  function weekdayOfDateString_(dateString) {
    var parts = dateString.split('-');
    return weekdayOfUtc_(parseInt(parts[0], 10), parseInt(parts[1], 10), parseInt(parts[2], 10));
  }

  /*
   * 国民の休日（祝日法第3条2項）: その前日及び翌日がともに祝日（振替休日を含まない、
   * 法律が直接定める祝日）であり、その日自体が祝日でなく、かつ日曜でない日を休日とする。
   * holidayMap（dateString -> 名前）へ直接追記する。
   */
  function addCitizensHolidays_(holidayMap, sortedDates) {
    sortedDates.forEach(function (date) {
      var candidate = addDaysToDateString_(date, 1);
      var afterCandidate = addDaysToDateString_(candidate, 1);
      if (holidayMap[candidate]) return;
      if (!holidayMap[afterCandidate]) return;
      if (weekdayOfDateString_(candidate) === 0) return;
      holidayMap[candidate] = '国民の休日';
    });
  }

  /*
   * 振替休日（祝日法第3条3項）: 祝日が日曜に当たるとき、その日後においてその日に最も
   * 近い「祝日でない日」を休日とする（2007年改正により、祝日が連続する場合はその連続
   * する祝日群の直後まで振り替える）。日付の昇順に処理し、直前までの処理で追加した
   * 振替休日・国民の休日も「祝日でない日」の判定に含める（holidayMapを都度参照する）。
   */
  function addSubstituteHolidays_(holidayMap, sortedDates) {
    sortedDates.forEach(function (date) {
      if (weekdayOfDateString_(date) !== 0) return;
      var candidate = addDaysToDateString_(date, 1);
      while (holidayMap[candidate]) {
        candidate = addDaysToDateString_(candidate, 1);
      }
      holidayMap[candidate] = '振替休日';
    });
  }

  /*
   * centerYearの前後1年分を含めたベース祝日集合に対して国民の休日・振替休日を適用した、
   * 最終的な祝日集合（dateString -> 名前）を返す。年境界をまたぐ振替休日・国民の休日は
   * 実際には発生しない（年末年始付近に法定の祝日が隣接しないため）が、将来の法改正で
   * 前提が変わっても壊れないよう、前後の年も含めて計算する。範囲外の年はlawHolidaysForYear_
   * を呼ばずスキップする（範囲外年の近似式は精度未確認のため）。
   */
  function finalHolidayMapForYear_(centerYear) {
    var map = {};
    [centerYear - 1, centerYear, centerYear + 1].forEach(function (year) {
      if (!isSupportedYear_(year)) return;
      var yearMap = lawHolidaysForYear_(year);
      Object.keys(yearMap).forEach(function (date) {
        map[date] = yearMap[date];
      });
    });

    var baseDates = Object.keys(map).sort();
    addCitizensHolidays_(map, baseDates);

    /* 振替休日は、国民の休日を含めた祝日集合に対して日付昇順で処理する
       （国民の休日自体は日曜にならないため振替休日の対象にはならないが、後続の
       振替休日判定が「祝日でない日」を正しく参照できるよう、集合を揃えてから渡す）。 */
    var datesIncludingCitizens = Object.keys(map).sort();
    addSubstituteHolidays_(map, datesIncludingCitizens);

    return map;
  }

  /*
   * dateString（'YYYY-MM-DD'）が祝日等（法定の祝日・振替休日・国民の休日のいずれか）か
   * どうかを判定する。
   *
   * 戻り値:
   * - 対応年の範囲内: { ok: true, isHoliday: boolean, name: string|null }
   * - 対応年の範囲外: { ok: false, error: { code: 'HOLIDAY_YEAR_UNSUPPORTED', message } }
   *   （呼び出し側は、この場合を黙って平日扱いにしてはならない。BookingPricing.gs参照）
   */
  function classify(dateString) {
    var parts = dateString.split('-');
    var year = parseInt(parts[0], 10);

    if (!isSupportedYear_(year)) {
      return {
        ok: false,
        error: {
          code: 'HOLIDAY_YEAR_UNSUPPORTED',
          message: '祝日判定に対応していない年度の日付です（対応範囲: ' + MIN_SUPPORTED_YEAR + '〜' +
            MAX_SUPPORTED_YEAR + '年）。しばらくしてから再度お試しいただくか、運営までお問い合わせください。'
        }
      };
    }

    var holidayMap = finalHolidayMapForYear_(year);
    var name = holidayMap[dateString] || null;
    return { ok: true, isHoliday: !!name, name: name };
  }

  return {
    MIN_SUPPORTED_YEAR: MIN_SUPPORTED_YEAR,
    MAX_SUPPORTED_YEAR: MAX_SUPPORTED_YEAR,
    classify: classify
  };
})();
