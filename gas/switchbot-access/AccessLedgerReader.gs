/**
 * 予約台帳（Bookings）の読取（Issue #754）— 独立GAS用。純粋ロジック＋最小列の選択。
 *
 * 読む列は鍵連携に必要な最小限のみ（氏名・メール・電話・目的・人数は読まない）。
 * 台帳の列構成が想定と違う（必須列が無い）場合は LEDGER_SCHEMA_INVALID として照合を止める
 * （revision 列の移行前に動かさない）。AccessKeySnapshot.build が参照する Booking.isCardPaymentMethod は
 * 予約GASのモジュールを持ち込まないため、同じ判定を最小の shim で提供する（値の一致はテストで固定）。
 */
var Booking = (typeof Booking !== 'undefined') ? Booking : {
  isCardPaymentMethod: function (paymentMethod) { return String(paymentMethod || '').trim() === 'オンラインクレジットカード'; }
};

var AccessLedgerReader = (function () {
  'use strict';

  var SHEET_NAME = 'Bookings';
  var REQUIRED_COLUMNS = [
    'bookingId', 'startAt', 'endAt', 'brand', 'status', 'paymentMethod', 'paymentStatus', 'paymentConfirmedAt',
    'confirmedAt', 'expiredAt', 'feeSettlementState', 'feeRecoveryRequiredAt', 'paymentRecoveryRequiredAt', 'revision'
  ];
  var JST_OFFSET_MS = 9 * 3600 * 1000;
  /** 台帳読取の失敗を表す固定コード（診断・アラートへ出してよいのはこれだけ。例外本文は出さない）。 */
  var KNOWN_ERROR_CODES = [
    'LEDGER_READ_FAILED', 'LEDGER_SCHEMA_INVALID', 'LEDGER_SCOPE_INCOMPATIBLE', 'LEDGER_AUTH_REQUIRED', 'LEDGER_ACCESS_DENIED',
    'LEDGER_API_DISABLED', 'LEDGER_NOT_FOUND', 'LEDGER_RATE_LIMITED', 'LEDGER_TOO_LARGE', 'LEDGER_TIMEZONE_UNSUPPORTED'
  ];

  function jstDay(ms) {
    var d = new Date(ms + JST_OFFSET_MS);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function toMs(v) {
    if (v && typeof v.getTime === 'function') { var t = v.getTime(); return isNaN(t) ? null : t; }
    if (typeof v === 'string' && v.trim() !== '') { var p = Date.parse(v); return isNaN(p) ? null : p; }
    return null;
  }

  /** 必須列がヘッダーにすべて存在するか。 */
  function checkHeaders(headerRow) {
    var missing = REQUIRED_COLUMNS.filter(function (c) { return headerRow.indexOf(c) === -1; });
    return missing.length ? { ok: false, error: 'LEDGER_SCHEMA_INVALID', missing: missing } : { ok: true };
  }

  /**
   * 列ごとの値（columns[name] = 配列、行順）から、通常の照合対象を選ぶ。
   * 対象 = ① 利用日(JST)が当日・翌日のSNB予約 ∪ ② trackedIds（鍵操作記録が残る予約。利用日を問わない）。
   * 時刻が読めない行はSNBの可能性を捨てず候補に含め、AccessKeySnapshot が TIME_INVALID で止める。
   */
  function select(columns, nowMs, trackedIds) {
    var ids = columns.bookingId || [];
    var tracked = {};
    (trackedIds || []).forEach(function (id) { tracked[String(id)] = true; });
    var today = jstDay(nowMs);
    var tomorrow = today + 24 * 3600 * 1000;
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i] === undefined || ids[i] === null ? '' : ids[i]);
      if (!id) continue;
      var rec = {};
      REQUIRED_COLUMNS.forEach(function (c) { rec[c] = (columns[c] || [])[i]; });
      var inTracked = !!tracked[id];
      var ms = toMs(rec.startAt);
      var isSnb = String(rec.brand || '') === 'snb' || String(rec.brand || '') === '';
      var inWindow = false;
      if (isSnb) {
        if (ms === null) inWindow = true;
        else { var d = jstDay(ms); inWindow = d === today || d === tomorrow; }
      }
      if (inTracked || inWindow) out.push(rec);
    }
    return out;
  }

  /**
   * シート本体から読む（GAS専用）。ヘッダー行で列を解決し、必須列だけを列単位で読む。
   * sheet: Sheets API アダプター（SpreadsheetApp のシート互換）。失敗は { ok:false } で返し、例外を呼出側へ漏らさない。
   */
  function readFromSheet(sheet, nowMs, trackedIds) {
    try {
      var lastCol = sheet.getLastColumn();
      var lastRow = sheet.getLastRow();
      if (lastCol < 1) return { ok: false, error: 'LEDGER_SCHEMA_INVALID' };
      var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
      var chk = checkHeaders(header);
      if (!chk.ok) return { ok: false, error: chk.error };
      if (lastRow < 2) return { ok: true, records: [] };
      var columns = {};
      if (typeof sheet.getColumns === 'function') {
        // Sheets API 経路: 必須列を1回のバッチ読取（ページ単位）にまとめる（呼出回数とクォータを抑える）
        var colNums = REQUIRED_COLUMNS.map(function (c) { return header.indexOf(c) + 1; });
        var got = sheet.getColumns(colNums, 2, lastRow - 1);
        REQUIRED_COLUMNS.forEach(function (c, i) { columns[c] = got[i]; });
      } else {
        REQUIRED_COLUMNS.forEach(function (c) {
          var col = header.indexOf(c) + 1;
          columns[c] = sheet.getRange(2, col, lastRow - 1, 1).getValues().map(function (r) { return r[0]; });
        });
      }
      return { ok: true, records: select(columns, nowMs, trackedIds) };
    } catch (e) {
      return { ok: false, error: classifyError(e) }; // 固定コードのみ（例外本文・スタックは保持しない）
    }
  }

  /** 受渡し先として使える単一のメールアドレスの形（複数宛先・表示名・制御文字を拒否）。配送側の検証と同じ形。 */
  var RECIPIENT_EMAIL_RE = /^[^\s@<>",;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

  /**
   * 配送（Issue #752）専用: 暗証番号案内メールを送る直前に、指定した予約1件の宛先メールだけを読む。
   * 通常の照合（readFromSheet）はメール列を読まない。ここでも読むのは bookingId 列と、一致した1行の email セルだけ。
   * 0件・複数件・列欠落・不正な形式は、推測や補完をせず ok:false（呼出側は送信せず管理者へ引き継ぐ）。
   * 戻り値・例外にメールアドレスを残さない（返すのは ok:true のときの to だけ。呼出側が保存・ログしない）。
   */
  function readRecipient(sheet, bookingId) {
    try {
      var want = String(bookingId === undefined || bookingId === null ? '' : bookingId);
      if (!want) return { ok: false, error: 'RECIPIENT_NOT_FOUND' };
      var lastCol = sheet.getLastColumn();
      var lastRow = sheet.getLastRow();
      if (lastCol < 1) return { ok: false, error: 'RECIPIENT_COLUMN_MISSING' };
      var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
      if (header.indexOf('bookingId') === -1 || header.indexOf('email') === -1) return { ok: false, error: 'RECIPIENT_COLUMN_MISSING' };
      if (header.indexOf('bookingId') !== header.lastIndexOf('bookingId') || header.indexOf('email') !== header.lastIndexOf('email')) return { ok: false, error: 'RECIPIENT_COLUMN_INVALID' };
      if (lastRow < 2) return { ok: false, error: 'RECIPIENT_NOT_FOUND' };
      var ids = sheet.getRange(2, header.indexOf('bookingId') + 1, lastRow - 1, 1).getValues();
      var rows = [];
      for (var i = 0; i < ids.length; i++) if (String(ids[i][0] === undefined || ids[i][0] === null ? '' : ids[i][0]) === want) rows.push(i + 2);
      if (rows.length === 0) return { ok: false, error: 'RECIPIENT_NOT_FOUND' };
      if (rows.length > 1) return { ok: false, error: 'RECIPIENT_AMBIGUOUS' };
      var raw = sheet.getRange(rows[0], header.indexOf('email') + 1, 1, 1).getValues()[0][0];
      var to = typeof raw === 'string' ? raw.trim() : '';
      if (!RECIPIENT_EMAIL_RE.test(to)) return { ok: false, error: 'RECIPIENT_INVALID' };
      return { ok: true, to: to };
    } catch (e) {
      return { ok: false, error: classifyError(e) };
    }
  }

  var INSPECT_SAMPLE_ROWS = 200;

  /**
   * 例外を固定コードに分類する（本文は返さない）。GASの権限承認が必要な場合と、文書への権限が無い場合を区別する。
   * 分類に使うだけで、メッセージは保持・出力しない。
   */
  function classifyError(e) {
    if (e && typeof e.ledgerCode === 'string' && KNOWN_ERROR_CODES.indexOf(e.ledgerCode) !== -1) return e.ledgerCode;
    var m = '';
    try { m = String(e && e.message !== undefined ? e.message : e); } catch (x) { m = ''; }
    // 宣言スコープでは呼べないサービス（例: spreadsheets.readonly のみで SpreadsheetApp.openById）。権限不足(ACCESS_DENIED)より先に判定する
    if (/required permissions?|required scopes?|insufficient (authentication )?scopes?|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(m)) return 'LEDGER_SCOPE_INCOMPATIBLE';
    if (/authorization is required|authorisation is required|承認が必要|認可が必要/i.test(m)) return 'LEDGER_AUTH_REQUIRED';
    if (/do not have permission|permission denied|access denied|アクセス権|権限がありません/i.test(m)) return 'LEDGER_ACCESS_DENIED';
    return 'LEDGER_READ_FAILED';
  }

  /** Sheets API のHTTPエラーを固定コードへ。本文は分類にだけ使い、保持・出力しない。 */
  function classifyHttp(status, bodyText) {
    var b = String(bodyText || '');
    if (status === 401) return 'LEDGER_AUTH_REQUIRED';
    if (status === 403) {
      if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(b)) return 'LEDGER_SCOPE_INCOMPATIBLE';
      if (/SERVICE_DISABLED|accessNotConfigured|has not been used in project|API has not been enabled/i.test(b)) return 'LEDGER_API_DISABLED';
      return 'LEDGER_ACCESS_DENIED';
    }
    if (status === 404) return 'LEDGER_NOT_FOUND';
    if (status === 429) return 'LEDGER_RATE_LIMITED';
    return 'LEDGER_READ_FAILED';
  }

  function ledgerError(code) { var e = new Error(code); e.ledgerCode = code; return e; }

  // ── Sheets API v4 経由の読取（Issue #776）──
  // SpreadsheetApp.openById の承認スコープは spreadsheets（書込み可）のみで、spreadsheets.readonly では呼べない。
  // 読取専用スコープを維持するため、REST の values.get / values:batchGet を GET だけで使う（書込み系エンドポイントは呼ばない）。
  // 診断（inspectSheet）と本番照合（readFromSheet）は、ここで作る同じ「シート互換アダプター」を通る。
  var API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var MAX_ROWS = 20000; // 台帳行数の上限。超えたら黙って切り捨てず LEDGER_TOO_LARGE で止める
  var PAGE_ROWS = 2000; // 1回のAPI呼出で読む最大行数
  var DATE_COLUMNS = ['startAt', 'endAt', 'paymentConfirmedAt', 'confirmedAt', 'expiredAt', 'feeRecoveryRequiredAt', 'paymentRecoveryRequiredAt'];

  function colLetter(n) {
    var s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  /** 既定のタイムゾーン解決（DSTなしの固定オフセットのみ）。他は deps.tzOffsetMs で注入し、未対応なら止める。 */
  function defaultTzOffsetMs(tz) {
    if (tz === 'Asia/Tokyo') return JST_OFFSET_MS;
    if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT' || tz === 'Etc/GMT') return 0;
    return null;
  }

  /**
   * シリアル値（1899-12-30 起点の日数。スプレッドシートのタイムゾーンの壁時計）→ Date。
   * 秒未満の浮動小数誤差は秒単位に丸める。タイムゾーン未対応は LEDGER_TIMEZONE_UNSUPPORTED。
   */
  function serialToDate(serial, tz, tzOffsetMs) {
    var wallMs = Math.round((serial - 25569) * 86400) * 1000;
    // DSTのない既知ゾーンは固定値を優先し、それ以外だけ注入された解決関数（GASでは Utilities.formatDate）に任せる
    var resolve = function (z, ms) {
      var d = defaultTzOffsetMs(z);
      if (typeof d === 'number') return d;
      return tzOffsetMs ? tzOffsetMs(z, ms) : null;
    };
    var off1 = resolve(tz, wallMs);
    if (typeof off1 !== 'number') throw ledgerError('LEDGER_TIMEZONE_UNSUPPORTED');
    var off2 = resolve(tz, wallMs - off1);
    if (typeof off2 !== 'number') throw ledgerError('LEDGER_TIMEZONE_UNSUPPORTED');
    return new Date(wallMs - off2);
  }

  /**
   * deps: { spreadsheetId, fetch(url, options), getToken(), tzOffsetMs?(tz, ms) }
   * 戻り値: Sheet 互換（getLastColumn / getLastRow / getRange().getValues() / getColumns）。Bookings シートが無ければ null。
   */
  function openApiSheet(deps) {
    var id = deps.spreadsheetId;
    var base = API_BASE + encodeURIComponent(id);
    var RENDER = 'majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';

    function get(urlTail) {
      var res;
      try {
        res = deps.fetch(base + urlTail, { method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + deps.getToken(), Accept: 'application/json' } });
      } catch (e) {
        throw ledgerError(classifyError(e));
      }
      var status = res.getResponseCode();
      if (status !== 200) throw ledgerError(classifyHttp(status, status === 403 ? res.getContentText() : ''));
      try { return JSON.parse(res.getContentText()); } catch (e2) { throw ledgerError('LEDGER_READ_FAILED'); }
    }
    function q(a1) { return encodeURIComponent("'" + SHEET_NAME + "'!" + a1); }

    var meta = get('?fields=' + encodeURIComponent('properties.timeZone,sheets.properties.title'));
    var found = (meta && meta.sheets || []).some(function (s) { return s && s.properties && s.properties.title === SHEET_NAME; });
    if (!found) return null;
    var tz = meta.properties && meta.properties.timeZone;

    var headerCache = null;
    function header() {
      if (headerCache) return headerCache;
      var r = get('/values/' + q('1:1') + '?' + RENDER);
      headerCache = ((r.values && r.values[0]) || []).map(String);
      return headerCache;
    }
    var lastRowCache = null;
    function lastRow() {
      if (lastRowCache !== null) return lastRowCache;
      var h = header(), idCol = h.indexOf('bookingId') + 1;
      if (!idCol) { lastRowCache = 1; return lastRowCache; }
      var L = colLetter(idCol);
      var r = get('/values/' + q(L + '2:' + L) + '?' + RENDER);
      var n = (r.values || []).length;
      if (n > MAX_ROWS) throw ledgerError('LEDGER_TOO_LARGE');
      lastRowCache = 1 + n;
      return lastRowCache;
    }
    function convert(name, v) {
      if (typeof v === 'number' && isFinite(v) && DATE_COLUMNS.indexOf(name) !== -1) return serialToDate(v, tz, deps.tzOffsetMs);
      return v;
    }
    function cellAt(rows, i, j, name) {
      var row = rows[i];
      var v = row && row[j] !== undefined && row[j] !== null ? row[j] : '';
      return convert(name, v);
    }
    // 列ごと（colNums）に、firstRow から n 行分を読む。PAGE_ROWS 単位でバッチ取得し、ページを連結する。
    function getColumns(colNums, firstRow, n) {
      var h = header(), out = colNums.map(function () { return []; });
      if (n > MAX_ROWS) throw ledgerError('LEDGER_TOO_LARGE');
      for (var off = 0; off < n; off += PAGE_ROWS) {
        var cnt = Math.min(PAGE_ROWS, n - off), r1 = firstRow + off, r2 = r1 + cnt - 1;
        var ranges = colNums.map(function (c) { var L = colLetter(c); return 'ranges=' + q(L + r1 + ':' + L + r2); }).join('&');
        var r = get('/values:batchGet?' + ranges + '&' + RENDER);
        var vr = r.valueRanges || [];
        colNums.forEach(function (c, k) {
          var vals = (vr[k] && vr[k].values) || [];
          for (var i = 0; i < cnt; i++) out[k].push(cellAt(vals, i, 0, h[c - 1]));
        });
      }
      return out;
    }
    return {
      getTimeZone: function () { return typeof tz === 'string' ? tz : ''; },
      getLastColumn: function () { return header().length; },
      getLastRow: lastRow,
      getColumns: getColumns,
      getRange: function (r, c, nr, nc) {
        return {
          getValues: function () {
            if (r === 1) { // ヘッダー行（変換なし）
              var hh = header(), line = [];
              for (var j = 0; j < nc; j++) line.push(hh[c - 1 + j] === undefined ? '' : hh[c - 1 + j]);
              return [line];
            }
            var cols = [];
            for (var k = 0; k < nc; k++) cols.push(c + k);
            var data = getColumns(cols, r, nr), res = [];
            for (var i = 0; i < nr; i++) res.push(cols.map(function (_, k2) { return data[k2][i]; }));
            return res;
          }
        };
      }
    };
  }

  /**
   * 診断用の読取専用検査（Issue #774）。
   * 読むのはヘッダー行と、末尾最大200行の bookingId / startAt / endAt 列のみ（氏名・メール・電話等の列は読まない）。
   * これらの値は空行除外と日時の形式判定のためにメモリ内で扱うだけで、ログ・戻り値には出さない
   * （返すのは行数・検査行数の集計と固定コードのみ）。全レコードの整合性ではなく、末尾最大200行のサンプル診断。
   * 書込みは行わない。例外は本文を漏らさず固定コードにする。
   */
  function inspectSheet(sheet) {
    var res = { code: 'LEDGER_READ_FAILED', headers: 'NOT_CHECKED', columnFormat: 'NOT_CHECKED', rows: 0, sampled: 0 };
    try {
      if (!sheet) { res.code = 'LEDGER_SCHEMA_INVALID'; res.headers = 'SHEET_MISSING'; return res; }
      var lastCol = sheet.getLastColumn();
      var lastRow = sheet.getLastRow();
      if (lastCol < 1) { res.code = 'LEDGER_SCHEMA_INVALID'; res.headers = 'EMPTY'; return res; }
      var header = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
      var chk = checkHeaders(header);
      if (!chk.ok) { res.code = 'LEDGER_SCHEMA_INVALID'; res.headers = 'MISSING'; return res; }
      var dup = REQUIRED_COLUMNS.some(function (c) { return header.indexOf(c) !== header.lastIndexOf(c); });
      if (dup) { res.code = 'LEDGER_SCHEMA_INVALID'; res.headers = 'DUPLICATE'; return res; }
      res.headers = 'COMPLETE';
      res.rows = Math.max(0, lastRow - 1);
      if (res.rows === 0) { res.code = 'LEDGER_ACCESS_OK'; res.columnFormat = 'NO_DATA'; return res; }
      var n = Math.min(res.rows, INSPECT_SAMPLE_ROWS);
      var first = lastRow - n + 1;
      var idCol = header.indexOf('bookingId') + 1;
      var ids = sheet.getRange(first, idCol, n, 1).getValues();
      var bad = false;
      ['startAt', 'endAt'].forEach(function (c) {
        var vals = sheet.getRange(first, header.indexOf(c) + 1, n, 1).getValues();
        for (var i = 0; i < n; i++) {
          var id = ids[i][0];
          if (id === undefined || id === null || String(id) === '') continue; // 空行は対象外
          if (toMs(vals[i][0]) === null) bad = true;
        }
      });
      res.sampled = n;
      res.columnFormat = bad ? 'INVALID' : 'OK';
      res.code = bad ? 'LEDGER_SCHEMA_INVALID' : 'LEDGER_ACCESS_OK';
      return res;
    } catch (e) {
      res.code = classifyError(e);
      return res;
    }
  }

  /**
   * verify環境専用の検査（Issue #789）。inspectSheet（本番診断と共通・挙動不変）の結果に、シートのタイムゾーンがJSTかの確認を足す。
   * スプレッドシートのタイムゾーン文字列は戻り値に出さず、JST / NOT_JST / UNKNOWN の固定語のみ返す。読取のみ。
   */
  function inspectTestSheet(sheet) {
    var res = inspectSheet(sheet);
    res.timezone = 'NOT_CHECKED';
    if (res.code !== 'LEDGER_ACCESS_OK' && res.code !== 'LEDGER_TIMEZONE_UNSUPPORTED') return res;
    var tz = '';
    try { tz = typeof sheet.getTimeZone === 'function' ? sheet.getTimeZone() : ''; } catch (e) { tz = ''; }
    if (tz === 'Asia/Tokyo') { res.timezone = 'JST'; return res; }
    res.timezone = tz ? 'NOT_JST' : 'UNKNOWN';
    res.code = 'LEDGER_TIMEZONE_UNSUPPORTED';
    return res;
  }

  return { SHEET_NAME: SHEET_NAME, REQUIRED_COLUMNS: REQUIRED_COLUMNS.slice(), checkHeaders: checkHeaders, select: select, readFromSheet: readFromSheet, readRecipient: readRecipient, inspectSheet: inspectSheet, inspectTestSheet: inspectTestSheet, classifyError: classifyError,
    classifyHttp: classifyHttp, openApiSheet: openApiSheet, serialToDate: serialToDate, colLetter: colLetter,
    KNOWN_ERROR_CODES: KNOWN_ERROR_CODES.slice(), DATE_COLUMNS: DATE_COLUMNS.slice(), MAX_ROWS: MAX_ROWS, PAGE_ROWS: PAGE_ROWS };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AccessLedgerReader;
}
