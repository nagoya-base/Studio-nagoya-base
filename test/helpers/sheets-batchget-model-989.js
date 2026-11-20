'use strict';
/*
 * Issue #989 検証専用ヘルパー（テストからだけ使う。gas/ には置かず、GASへは配布されない）。
 *
 * Sheets API v4 の `spreadsheets.values.batchGet` と `spreadsheets.get`(grid data) の「公式仕様に基づく
 * 合成レスポンス」を作り、SpreadsheetApp の `getDataRange().getValues()` と比べるためのモデル。
 * 実API・実Spreadsheet・Advanced Service には一切接続しない。ここで再現しているのは公式ドキュメントに
 * 書かれた表現規則だけであり、実際のSheets側の挙動（ロケール・暗黙の型変換・タイムゾーン解決）の
 * 証明ではない。実環境での確認が必要な点は docs/booking-admin-batchget-989.md に「未確認」として列挙する。
 *
 * モデルの前提（公式: values#ValueRenderOption / DateTimeRenderOption / guides/values）:
 * - FORMATTED_VALUE: セルの表示書式どおりの「文字列」。数値・真偽値・日付はすべて文字列になる。
 * - UNFORMATTED_VALUE + SERIAL_NUMBER: 数値・真偽値・文字列は型を保つが、日付/日時/時刻は数値(シリアル値)。
 * - UNFORMATTED_VALUE + FORMATTED_STRING: 日付/日時/時刻だけ書式付き文字列、他は型を保つ。
 * - 行末の空セル・末尾の空行は省略される（途中の空行は [] として返る）。
 * - シリアル値はスプレッドシートのタイムゾーンの壁時計（1899-12-30 起点の日数）。
 */

var DAY_MS = 86400000;
var SERIAL_EPOCH_OFFSET = 25569; // 1970-01-01 のシリアル値

function pad(n, width) {
  var s = String(n);
  while (s.length < (width || 2)) s = '0' + s;
  return s;
}

/* 指定オフセット（ミリ秒。固定オフセットのみ）の壁時計へ寄せたシリアル値。 */
function serialFromDate(date, offsetMs) {
  return (date.getTime() + offsetMs) / DAY_MS + SERIAL_EPOCH_OFFSET;
}

/* シリアル値 → Date（固定オフセット前提。DST地域の壁時計→瞬間の解決は別関数）。 */
function dateFromSerial(serial, offsetMs) {
  return new Date(Math.round((serial - SERIAL_EPOCH_OFFSET) * DAY_MS) - offsetMs);
}

function wallClockParts(date, offsetMs) {
  var d = new Date(date.getTime() + offsetMs);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds()
  };
}

/* セル書式（DATE / DATE_TIME / TIME）ごとの FORMATTED 表現。ミリ秒は表示書式に無いので失われる。 */
function formatDateCell(date, fmt, offsetMs) {
  var p = wallClockParts(date, offsetMs);
  if (fmt === 'DATE') return p.y + '/' + pad(p.mo) + '/' + pad(p.d);
  if (fmt === 'TIME') return pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s);
  return p.y + '/' + pad(p.mo) + '/' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s);
}

function isDate(value) {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/* 日付セルの書式は列単位の既定（dateFormatByHeader）で与える。未指定のDateは DATE_TIME。 */
function cellFormat(header, opts) {
  return (opts.dateFormatByHeader && opts.dateFormatByHeader[header]) || 'DATE_TIME';
}

function trimRow(row) {
  var out = row.slice();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out;
}

/*
 * grid: getValues() 相当の2次元配列（1行目がヘッダー。Date/number/boolean/string/''）。
 * 戻り値: values.batchGet の valueRanges[i].values 相当（末尾空セル・末尾空行を省略）。
 * 全セルが空のとき実APIは `values` キー自体を返さないため undefined を返す。
 */
function renderValues(grid, opts) {
  var offsetMs = opts.offsetMs === undefined ? 9 * 3600000 : opts.offsetMs;
  var headers = grid[0] || [];
  var out = grid.map(function (row, rowIndex) {
    return trimRow(row.map(function (value, col) {
      if (isDate(value)) {
        var fmt = cellFormat(headers[col], opts);
        if (opts.valueRenderOption === 'FORMATTED_VALUE') return formatDateCell(value, fmt, offsetMs);
        if (opts.dateTimeRenderOption === 'FORMATTED_STRING') return formatDateCell(value, fmt, offsetMs);
        return serialFromDate(value, offsetMs);
      }
      if (opts.valueRenderOption === 'FORMATTED_VALUE') {
        if (value === true) return 'TRUE';
        if (value === false) return 'FALSE';
        return String(value);
      }
      return value;
    }));
  });
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out.length ? out : undefined;
}

function buildValueRanges(spec, opts) {
  return {
    spreadsheetId: 'model',
    valueRanges: spec.map(function (item) {
      var range = { range: item.range, majorDimension: 'ROWS' };
      var values = renderValues(item.grid, opts);
      if (values) range.values = values;
      return range;
    })
  };
}

/*
 * spreadsheets.get(ranges, fields=sheets(properties.title,data.rowData.values(effectiveValue,
 * effectiveFormat.numberFormat.type,formattedValue)),properties.timeZone) 相当の合成レスポンス。
 * effectiveValue は numberValue / stringValue / boolValue のいずれか、数値書式は numberFormat.type で区別できる。
 * 空セルも `{}` として含まれる（fields指定でもrowData.valuesは範囲の列数ぶん返るものとして保守的に見積もる）。
 */
function buildGridData(spec, opts) {
  var offsetMs = opts.offsetMs === undefined ? 9 * 3600000 : opts.offsetMs;
  return {
    properties: { timeZone: opts.timeZone || 'Asia/Tokyo' },
    sheets: spec.map(function (item) {
      var headers = item.grid[0] || [];
      var width = item.grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
      return {
        properties: { title: item.title },
        data: [{
          startRow: 0, startColumn: 0,
          rowData: item.grid.map(function (row) {
            var values = [];
            for (var c = 0; c < width; c++) {
              var value = row[c] === undefined ? '' : row[c];
              if (value === '') { values.push({}); continue; }
              if (isDate(value)) {
                var fmt = cellFormat(headers[c], opts);
                values.push({
                  effectiveValue: { numberValue: serialFromDate(value, offsetMs) },
                  formattedValue: formatDateCell(value, fmt, offsetMs),
                  effectiveFormat: { numberFormat: { type: fmt } }
                });
              } else if (typeof value === 'number') {
                values.push({ effectiveValue: { numberValue: value }, formattedValue: String(value), effectiveFormat: { numberFormat: { type: 'NUMBER' } } });
              } else if (typeof value === 'boolean') {
                values.push({ effectiveValue: { boolValue: value }, formattedValue: value ? 'TRUE' : 'FALSE' });
              } else {
                values.push({ effectiveValue: { stringValue: String(value) }, formattedValue: String(value) });
              }
            }
            return { values: values };
          })
        }]
      };
    })
  };
}

/* ---- 候補アダプタ（すべてテスト専用。本番コードには置かない） ---- */

var REFUSED = 'REFUSED';

function refusal(reason) {
  return { ok: false, reason: reason };
}

function isDateLikeHeader(header) {
  return header === 'date' || /At$/.test(String(header));
}

function rectangularize(rows) {
  var width = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
  return rows.map(function (row) {
    var out = row.slice();
    while (out.length < width) out.push('');
    return out;
  });
}

/*
 * 「列名から日付列を推測し、数値をDateへ変換する」素朴な契約型アダプタ（UNFORMATTED_VALUE + SERIAL_NUMBER 前提）。
 * Issue #989 が禁じている「列ごとの型の推測」そのもの。反証用（これが旧データで壊れることをテストで示す）。
 */
function naiveSerialAdapter(values, opts) {
  var offsetMs = opts.offsetMs === undefined ? 9 * 3600000 : opts.offsetMs;
  var rows = rectangularize(values || []);
  if (!rows.length) return rows;
  var headers = rows[0];
  return rows.map(function (row, r) {
    if (r === 0) return row;
    return row.map(function (value, c) {
      return typeof value === 'number' && isDateLikeHeader(headers[c]) ? dateFromSerial(value, offsetMs) : value;
    });
  });
}

/*
 * 「FORMATTED_VALUE の文字列を、日付列だけ解析してDateへ戻す」素朴な契約型アダプタ。反証用。
 */
function naiveFormattedAdapter(values, opts) {
  var offsetMs = opts.offsetMs === undefined ? 9 * 3600000 : opts.offsetMs;
  var rows = rectangularize(values || []);
  if (!rows.length) return rows;
  var headers = rows[0];
  return rows.map(function (row, r) {
    if (r === 0) return row;
    return row.map(function (value, c) {
      if (typeof value !== 'string' || !isDateLikeHeader(headers[c])) return value;
      var m = /^(\d{4})\/(\d{2})\/(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/.exec(value);
      if (!m) return value;
      return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)) - offsetMs);
    });
  });
}

/*
 * fail-closed アダプタ（UNFORMATTED_VALUE + SERIAL_NUMBER）。
 * SERIAL表現ではDateセルが「ただの数値」と区別できないため、**列名・ヘッダーに依存せず**、データ行の数値セルを
 * 1つでも見つけたら変換せず拒否する（Dateが日付名ではない列・余剰列にあっても成功扱いにしない）。
 * 数値が1つも無く（文字列・真偽値・空セルだけ）、書式なし文字列がそのまま getValues() と同じ値になる台帳だけ成功する。
 * 実運用の Bookings／OptionOrders は料金・人数・Dateなどの数値セルを日常的に含むため、実質的に常にレガシーへ戻る。
 */
function failClosedSerialAdapter(values) {
  var rows = rectangularize(values || []);
  if (!rows.length) return refusal('EMPTY_SHEET');
  for (var r = 1; r < rows.length; r++) {
    for (var c = 0; c < rows[r].length; c++) {
      if (typeof rows[r][c] === 'number') return refusal('AMBIGUOUS_NUMERIC_CELL');
    }
  }
  return { ok: true, values: rows };
}

/*
 * grid data（型メタデータ付き）アダプタ。effectiveFormat.numberFormat.type が DATE / DATE_TIME / TIME のセルだけを
 * Dateへ戻す。その他の数値書式・文字列・真偽値は型どおり。固定オフセットのタイムゾーン前提で、
 * DST地域（壁時計が曖昧になる時刻）は拒否する。
 */
function gridDataAdapter(sheetData, properties, opts) {
  var tz = properties && properties.timeZone;
  if (opts.fixedOffsetByTimeZone && !Object.prototype.hasOwnProperty.call(opts.fixedOffsetByTimeZone, tz)) {
    return refusal('TIMEZONE_NOT_FIXED_OFFSET');
  }
  var offsetMs = opts.fixedOffsetByTimeZone ? opts.fixedOffsetByTimeZone[tz] : 9 * 3600000;
  var rowData = (sheetData && sheetData.data && sheetData.data[0] && sheetData.data[0].rowData) || [];
  var rows = rowData.map(function (row) {
    return (row.values || []).map(function (cell) {
      var ev = cell.effectiveValue;
      if (!ev) return '';
      var type = cell.effectiveFormat && cell.effectiveFormat.numberFormat && cell.effectiveFormat.numberFormat.type;
      if (ev.numberValue !== undefined) {
        if (type === 'DATE' || type === 'DATE_TIME' || type === 'TIME') return dateFromSerial(ev.numberValue, offsetMs);
        return ev.numberValue;
      }
      if (ev.boolValue !== undefined) return ev.boolValue;
      if (ev.stringValue !== undefined) return ev.stringValue;
      return REFUSED;
    });
  });
  if (rows.some(function (r) { return r.indexOf(REFUSED) !== -1; })) return refusal('UNKNOWN_EFFECTIVE_VALUE');
  return { ok: true, values: rectangularize(rows) };
}

/* ---- 失敗時に「最大1回だけレガシーへ戻す」読取計画（再試行なし） ---- */

var BOOKINGS_RANGE = "'Bookings'";
var OPTIONS_RANGE = "'OptionOrders'";

/*
 * api: { batchGet(args) } を持つ（未登録なら undefined）。戻り値:
 *   { source:'batchGet', bookings, options }  … 両方を検証つきで再現できた
 *   { source:'legacy', reason }               … 何かひとつでも検証できない → 呼び出し側は従来の読取に任せる（フォールバックは1回だけ）
 * 例外は呼び出し側へ出さない（フォールバックの理由として握り潰さず reason に分類して残す）。
 * 検証できない値を成功として返すことは無い。再試行（batchGetの再実行）もしない。
 */
function planLedgerRead(api, spreadsheetId, adapter, adapterOpts) {
  var response;
  try {
    if (!api || typeof api.batchGet !== 'function') return { source: 'legacy', reason: 'SERVICE_UNAVAILABLE' };
    response = api.batchGet(spreadsheetId, {
      ranges: [BOOKINGS_RANGE, OPTIONS_RANGE],
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    });
  } catch (e) {
    var code = e && e.code;
    return { source: 'legacy', reason: code ? 'API_ERROR_' + code : 'API_THROW' };
  }
  if (!response || !Array.isArray(response.valueRanges) || response.valueRanges.length !== 2) {
    return { source: 'legacy', reason: 'MALFORMED_RESPONSE' };
  }
  var decoded = [];
  for (var i = 0; i < 2; i++) {
    var vr = response.valueRanges[i];
    if (!vr || typeof vr.range !== 'string' || vr.range.indexOf(i === 0 ? 'Bookings' : 'OptionOrders') === -1) {
      return { source: 'legacy', reason: 'RANGE_MISMATCH' };
    }
    /* `values` が無い＝空シート。従来の ensure*（シート作成・ヘッダー追記）が必要なためレガシーへ。 */
    if (!Array.isArray(vr.values) || vr.values.length === 0) return { source: 'legacy', reason: 'UNINITIALIZED_SHEET' };
    if (!vr.values.every(Array.isArray)) return { source: 'legacy', reason: 'MALFORMED_ROWS' };
    var result;
    try {
      result = adapter(vr.values, adapterOpts || {});
    } catch (adapterError) {
      /* 例外の内容（ユーザー値を含み得る）は保持せず、固定コードだけ返す。 */
      return { source: 'legacy', reason: 'ADAPTER_EXCEPTION' };
    }
    if (!result || result.ok !== true) return { source: 'legacy', reason: typeof (result && result.reason) === 'string' && /^[A-Z_]{1,40}$/.test(result.reason) ? result.reason : 'ADAPTER_REFUSED' };
    if (!Array.isArray(result.values) || !result.values.every(Array.isArray)) return { source: 'legacy', reason: 'ADAPTER_MALFORMED_RESULT' };
    decoded.push(result.values);
  }
  return { source: 'batchGet', bookings: decoded[0], options: decoded[1] };
}

/*
 * 既存の SpreadsheetApp スタブを包み、指定シートの getDataRange().getValues() だけを注入値へ差し替える。
 * 注入値の無いシートは元のスタブへ委譲する。getSheetByName・insertSheet・getLastRow・appendRow は
 * 元のスタブのまま（従来の ensure* とその副作用を変えない）。
 */
function wrapSpreadsheetApp(base, injectedByName, counters) {
  return {
    openById: function (id) {
      var ss = base.openById(id);
      return {
        getId: ss.getId,
        insertSheet: ss.insertSheet,
        getSheetByName: function (name) {
          var sheet = ss.getSheetByName(name);
          if (!sheet || !injectedByName || !injectedByName[name]) return sheet;
          return Object.create(sheet, {
            getDataRange: {
              value: function () {
                return { getValues: function () { if (counters) counters.injectedReads = (counters.injectedReads || 0) + 1; return injectedByName[name]; } };
              }
            }
          });
        }
      };
    }
  };
}

module.exports = {
  DAY_MS: DAY_MS,
  serialFromDate: serialFromDate,
  dateFromSerial: dateFromSerial,
  renderValues: renderValues,
  buildValueRanges: buildValueRanges,
  buildGridData: buildGridData,
  rectangularize: rectangularize,
  naiveSerialAdapter: naiveSerialAdapter,
  naiveFormattedAdapter: naiveFormattedAdapter,
  failClosedSerialAdapter: failClosedSerialAdapter,
  gridDataAdapter: gridDataAdapter,
  planLedgerRead: planLedgerRead,
  wrapSpreadsheetApp: wrapSpreadsheetApp,
  isDate: isDate
};
