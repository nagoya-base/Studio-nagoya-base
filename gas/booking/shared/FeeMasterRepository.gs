/*
 * FeeMasterRepository.gs — 料金マスタ（Issue #344追記: 料金差額自動計算のPhase 0/1）。
 *
 * SNB / SNB mens / Studio X の直接予約向け料金表を、有効開始日付きのバージョンとして
 * 専用Spreadsheet内の「FeeMaster」シートへ保存する。ハードコードではなくシートに
 * 置くのは、今後の料金改定を管理者がコード変更なしに（新しいversion行を追記する形で）
 * 反映できるようにするため（Issue本文Phase 0「サーバー側単一料金マスタ」）。
 *
 * バージョニング方針:
 * - 同一version番号の行は同じeffectiveAt（'YYYY-MM-DD'）を持つ「1つの料金表のスナップショット」。
 *   brand×priceCategory×dayTypeの組み合わせごとに1行。
 * - ある時点で「有効な料金表」は、effectiveAt <= 対象日付 を満たす行の中でversionが
 *   最大のものすべて（同一version番号の行一式）。
 * - 変更確定（BookingReschedule.commit）はpreview時に見たversionと、確定直前に
 *   再計算したversionが一致することを必須とする（Issue本文「料金マスタの版がpreview後に
 *   変更された場合は確定拒否・再計算」）。新しい料金表を追加してもeffectiveAtが未来なら
 *   即座には有効化されない。
 * - 未定義の組み合わせ（例: mens×general、studio_x×member）は、現行の公開ページに
 *   料金表が存在しないため、意図的に行を追加しない。該当する組み合わせの見積りは
 *   findEntry()がnullを返し、呼び出し側（FeeCalculator）はfail-closedに「自動算定不可・
 *   管理者確認が必要」として扱う（Phase 0「対応外のプランや元料金不明は自動算定せず
 *   管理者確認を要求する」）。
 *
 * v1の金額は、2026-09-25時点で公開されている以下のページの「通常価格／会員価格」表を
 * そのまま転記したもの（30分・2.5h・3.5h・4h超はここには含まれない。実際の中間値の
 * 算出はFeeCalculator.gsの「暫定案」補間式が行う。この補間式自体はissue #344追記が
 * 「確認し、承認後に固定する」としていた暫定案を、2026-09-25にv1として承認・実装したもの
 * （最終ユーザー承認の記録はissueコメント参照）:
 * - index.html#pricing （SNB 通常価格・会員価格）
 * - mens/index.html#pricing （SNB mens 会員価格。同ページに非会員向け表は無いため
 *   mens×generalは未定義のまま。会員以外での予約は管理者が個別確認する）
 * - studio-x/index.html#price （Studio X 通常価格。会員価格ページが無いため
 *   studio_x×memberは未定義のまま）
 */
'use strict';

var FeeMasterRepository = (function () {
  var SHEET_NAME_ = 'FeeMaster';
  var HEADERS_ = [
    'version', 'effectiveAt', 'brand', 'priceCategory', 'dayType',
    'hour2Amount', 'hour3Amount', 'hour4Amount', 'extensionHourAmount', 'note'
  ];

  var SEED_EFFECTIVE_AT_ = '2020-01-01';
  var SEED_ROWS_ = [
    ['snb', 'general', 'weekday', 4000, 6000, 8000, 2000, 'index.html#pricing 通常価格・平日'],
    ['snb', 'general', 'weekend_holiday', 5000, 7500, 10000, 2500, 'index.html#pricing 通常価格・土日祝'],
    ['snb', 'member', 'weekday', 4000, 5500, 7000, 1500, 'index.html#pricing 会員価格・平日'],
    ['snb', 'member', 'weekend_holiday', 5000, 7000, 9000, 2000, 'index.html#pricing 会員価格・土日祝'],
    ['mens', 'member', 'weekday', 4000, 5500, 7000, 1500, 'mens/index.html#pricing 会員価格・平日'],
    ['mens', 'member', 'weekend_holiday', 5000, 7000, 9000, 2000, 'mens/index.html#pricing 会員価格・土日祝'],
    ['studio_x', 'general', 'weekday', 4000, 6000, 8000, 2000, 'studio-x/index.html#price 平日'],
    ['studio_x', 'general', 'weekend_holiday', 5000, 7500, 10000, 2500, 'studio-x/index.html#price 土日祝']
  ];

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  function ensureSheet_() {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME_);
    if (sheet.getLastRow() < 1) sheet.appendRow(HEADERS_);
    if (sheet.getLastRow() < 2) {
      SEED_ROWS_.forEach(function (row) {
        sheet.appendRow([1, SEED_EFFECTIVE_AT_].concat(row));
      });
    }
    return sheet;
  }

  function entryKey_(brand, priceCategory, dayType) {
    return brand + '|' + priceCategory + '|' + dayType;
  }

  function readAllRows_() {
    var sheet = ensureSheet_();
    var values = sheet.getDataRange().getValues();
    var rows = [];
    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      if (!r[0] && r[0] !== 0) continue;
      rows.push({
        version: Number(r[0]),
        effectiveAt: String(r[1]),
        brand: r[2],
        priceCategory: r[3],
        dayType: r[4],
        hour2Amount: Number(r[5]),
        hour3Amount: Number(r[6]),
        hour4Amount: Number(r[7]),
        extensionHourAmount: Number(r[8]),
        note: r[9]
      });
    }
    return rows;
  }

  /*
   * asOfDateString（'YYYY-MM-DD'）時点で有効なversion一式を返す。
   * effectiveAt <= asOfDateString を満たす行のうち、versionが最大のものだけを集めて返す
   * （ISO日付文字列は辞書順比較でそのまま日付順になる）。該当行が無い場合は例外を投げる
   * （v1のeffectiveAtが2020-01-01固定のため、通常到達しないfail-closadパス）。
   */
  function getActiveTable(asOfDateString) {
    var rows = readAllRows_().filter(function (row) { return row.effectiveAt <= asOfDateString; });
    if (!rows.length) {
      throw new Error('FeeMaster: ' + asOfDateString + '時点で有効な料金表がありません。');
    }
    var version = rows.reduce(function (max, row) { return Math.max(max, row.version); }, 0);
    var activeRows = rows.filter(function (row) { return row.version === version; });
    var entries = {};
    activeRows.forEach(function (row) { entries[entryKey_(row.brand, row.priceCategory, row.dayType)] = row; });
    return { version: version, effectiveAt: activeRows[0].effectiveAt, entries: entries };
  }

  /* 該当する組み合わせの料金表エントリを返す。定義が無ければnull（fail-closed）。 */
  function findEntry(asOfDateString, brand, priceCategory, dayType) {
    var table = getActiveTable(asOfDateString);
    var entry = table.entries[entryKey_(brand, priceCategory, dayType)] || null;
    return { version: table.version, effectiveAt: table.effectiveAt, entry: entry };
  }

  return {
    getActiveTable: getActiveTable,
    findEntry: findEntry
  };
})();
