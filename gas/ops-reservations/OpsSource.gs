/*
 * OpsSource.gs — 予約台帳（Bookingsシート）の読み取りアダプター（Issue #936）。
 *
 * SpreadsheetApp.openById は承認スコープが spreadsheets（書き込み可）で、spreadsheets.readonly では
 * 呼べない（既存の gas/switchbot-access/AccessLedgerReader.gs と同じ事情）。読み取り専用スコープを
 * 維持するため、Sheets API v4 の GET（values.get / values:batchGet）だけを ScriptApp.getOAuthToken()
 * で呼ぶ。書き込み系エンドポイント・GET以外のメソッドは使わない（静的テストで検査）。
 *
 * 読むのは OpsNormalizer.ALLOWED_COLUMNS の列だけ（メール・電話・備考・決済トークン等の列は
 * ネットワーク越しにも取得しない）。行数が上限を超えたら黙って切り捨てず TOO_LARGE で止める。
 * 失敗時の例外は本文を保持せず、固定コード（e.opsCode）のみ。
 */
'use strict';

var OpsSource = (function () {
  var API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var SHEET_NAME = 'Bookings';
  var MAX_ROWS = 20000;
  /* シリアル値（日時セル）として返りうる列。他の数値列（people・料金）は変換しない。 */
  var DATE_COLUMNS = ['date', 'createdAt', 'startAt', 'endAt', 'confirmedAt', 'expiredAt', 'cancelledAt', 'updatedAt', 'priceOverrideAt'];
  var RENDER = 'majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';

  function fail_(code) { var e = new Error(code); e.opsCode = code; return e; }

  function colLetter_(n) {
    var s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  /* DSTのないゾーンのみ対応。他は黙って誤変換せず止める。 */
  function tzOffsetMs_(tz) {
    if (tz === 'Asia/Tokyo') return 9 * 3600 * 1000;
    if (tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT' || tz === 'Etc/GMT') return 0;
    return null;
  }

  /* シリアル値（1899-12-30起点。シートのタイムゾーンの壁時計）→ Date。 */
  function serialToDate_(serial, offsetMs) {
    return new Date(Math.round((serial - 25569) * 86400) * 1000 - offsetMs);
  }

  /*
   * deps: { spreadsheetId, fetch(url, options), getToken() }
   * 戻り値: normalize()へそのまま渡せる2次元配列（1行目=取得した列名）。
   * シートが無ければ opsCode 'SHEET_NOT_FOUND'。
   */
  function readBookings(deps) {
    var base = API_BASE + encodeURIComponent(deps.spreadsheetId);
    function get(tail) {
      var res;
      try {
        res = deps.fetch(base + tail, { method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + deps.getToken(), Accept: 'application/json' } });
      } catch (e) {
        throw fail_('FETCH_FAILED');
      }
      if (res.getResponseCode() !== 200) throw fail_('FETCH_FAILED');
      try { return JSON.parse(res.getContentText()); } catch (e2) { throw fail_('FETCH_FAILED'); }
    }
    function q(a1) { return encodeURIComponent("'" + SHEET_NAME + "'!" + a1); }

    var meta = get('?fields=' + encodeURIComponent('properties.timeZone,sheets.properties.title'));
    var found = ((meta && meta.sheets) || []).some(function (s) { return s && s.properties && s.properties.title === SHEET_NAME; });
    if (!found) throw fail_('SHEET_NOT_FOUND');
    var offset = tzOffsetMs_(meta.properties && meta.properties.timeZone);
    if (offset === null) throw fail_('TIMEZONE_UNSUPPORTED');

    var headerRes = get('/values/' + q('1:1') + '?' + RENDER);
    var header = ((headerRes.values && headerRes.values[0]) || []).map(function (h) { return String(h).trim(); });
    var wanted = [];
    OpsNormalizer.ALLOWED_COLUMNS.forEach(function (name) {
      var i = header.indexOf(name);
      if (i !== -1) wanted.push({ name: name, col: i + 1 });
    });
    if (!wanted.length) return [[]];

    var ranges = wanted.map(function (w) { var L = colLetter_(w.col); return 'ranges=' + q(L + '2:' + L); }).join('&');
    var data = get('/values:batchGet?' + ranges + '&' + RENDER);
    var vr = data.valueRanges || [];
    var rowCount = 0;
    var columns = wanted.map(function (w, k) {
      var vals = (vr[k] && vr[k].values) || [];
      if (vals.length > MAX_ROWS) throw fail_('TOO_LARGE');
      if (vals.length > rowCount) rowCount = vals.length;
      return vals;
    });
    var out = [wanted.map(function (w) { return w.name; })];
    for (var i = 0; i < rowCount; i++) {
      out.push(wanted.map(function (w, k) {
        var cell = columns[k][i] && columns[k][i][0] !== undefined && columns[k][i][0] !== null ? columns[k][i][0] : '';
        return typeof cell === 'number' && isFinite(cell) && DATE_COLUMNS.indexOf(w.name) !== -1 ? serialToDate_(cell, offset) : cell;
      }));
    }
    return out;
  }

  return { readBookings: readBookings, MAX_ROWS: MAX_ROWS, DATE_COLUMNS: DATE_COLUMNS };
})();
