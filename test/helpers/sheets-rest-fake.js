'use strict';
/*
 * Google Sheets API v4 (REST) の最小フェイク（Issue #776）。実通信はしない。
 * 台帳の読取は SpreadsheetApp ではなく UrlFetchApp + ScriptApp.getOAuthToken() で行うため、
 * UrlFetchApp.fetch の代わりに注入する。GET のみ受け付け、書込み系は記録して失敗させる。
 *
 * state: { headers:[], rows:[{col:value}], tz, sheetName, noSheet, http:{code,body}|null, calls:[], writes:0 }
 * Date は書式なし(UNFORMATTED_VALUE)＋SERIAL_NUMBER のシリアル値(スプレッドシートのタイムゾーン壁時計)として返す。
 */
function serialOf(ms, offsetMs) { return (ms + offsetMs) / 86400000 + 25569; }

function create(state) {
  state.calls = state.calls || [];
  state.writes = state.writes || 0;
  var API = 'https://sheets.googleapis.com/v4/spreadsheets/';
  function colNum(L) { var n = 0; for (var i = 0; i < L.length; i++) n = n * 26 + (L.charCodeAt(i) - 64); return n; }
  function res(code, body) {
    return { getResponseCode: function () { return code; }, getContentText: function () { return typeof body === 'string' ? body : JSON.stringify(body); } };
  }
  function offset() { return state.tzOffsetMs === undefined ? 9 * 3600000 : state.tzOffsetMs; }
  function cell(r, name) {
    var v = r[name];
    if (v === undefined || v === null) return '';
    if (v instanceof Date) return state.dateAs === 'iso' ? v.toISOString() : serialOf(v.getTime(), offset());
    return v;
  }
  function grid() { return [state.headers.slice()].concat(state.rows.map(function (r) { return state.headers.map(function (h) { return cell(r, h); }); })); }
  function parseRange(a1) {
    var m = /^'([^']+)'!(?:([A-Z]+)(\d*):([A-Z]+)(\d*)|(\d+):(\d+))$/.exec(a1);
    if (!m) return null;
    if (m[6]) return { sheet: m[1], c1: 1, c2: state.headers.length, r1: Number(m[6]), r2: Number(m[7]) };
    return { sheet: m[1], c1: colNum(m[2]), c2: colNum(m[4]), r1: Number(m[3]), r2: m[5] ? Number(m[5]) : Infinity };
  }
  function values(a1) {
    var p = parseRange(a1);
    if (!p || p.sheet !== (state.sheetName || 'Bookings')) return null;
    var g = grid(), out = [];
    state.readCols = state.readCols || [];
    if (p.r1 >= 2) for (var cc = p.c1; cc <= p.c2; cc++) state.readCols.push(state.headers[cc - 1]); // データ行として読んだ列（ヘッダー行は除く）
    for (var r = p.r1; r <= Math.min(p.r2, g.length); r++) {
      var line = [];
      for (var c = p.c1; c <= p.c2; c++) { var v = g[r - 1][c - 1]; line.push(v === undefined ? '' : v); }
      while (line.length && line[line.length - 1] === '') line.pop();
      out.push(line);
    }
    while (out.length && out[out.length - 1].length === 0) out.pop();
    return out;
  }
  function fetch(url, options) {
    options = options || {};
    state.calls.push({ url: url, method: options.method, auth: !!(options.headers && /^Bearer .+/.test(options.headers.Authorization)) });
    if (state.fetchThrow) throw new Error(state.fetchThrow);
    if (options.method !== 'get') { state.writes++; return res(405, { error: { code: 405, status: 'METHOD_NOT_ALLOWED' } }); }
    if (url.indexOf(API) !== 0) return res(400, {});
    if (state.http) return res(state.http.code, state.http.body === undefined ? {} : state.http.body);
    var rest = url.slice(API.length);
    var q = rest.indexOf('?'), path = q === -1 ? rest : rest.slice(0, q), query = q === -1 ? '' : rest.slice(q + 1);
    var parts = path.split('/');
    if (parts.length === 1) {
      var title = state.sheetName || 'Bookings';
      return res(200, { properties: { timeZone: state.tz || 'Asia/Tokyo' },
        sheets: state.noSheet ? [{ properties: { title: 'Other' } }] : [{ properties: { title: title, gridProperties: { rowCount: Math.max(1000, state.rows.length + 1), columnCount: state.headers.length } } }] });
    }
    // 値の取得は書式なし・シリアル値で要求していること（ロケール依存の表示文字列に頼らない）
    state.lastQuery = query;
    if (!/valueRenderOption=UNFORMATTED_VALUE/.test(query) || !/dateTimeRenderOption=SERIAL_NUMBER/.test(query)) return res(400, { error: { message: 'render options required' } });
    if (parts[1] === 'values:batchGet') {
      var ranges = (query.match(/ranges=[^&]+/g) || []).map(function (s) { return decodeURIComponent(s.slice(7)); });
      var vr = ranges.map(function (a) { return { range: a, values: values(a) }; });
      if (vr.some(function (x) { return x.values === null; })) return res(400, { error: { message: 'Unable to parse range' } });
      return res(200, { valueRanges: vr.map(function (x) { return x.values.length ? { range: x.range, majorDimension: 'ROWS', values: x.values } : { range: x.range, majorDimension: 'ROWS' }; }) });
    }
    if (parts[1] === 'values' && parts.length === 3) {
      var v = values(decodeURIComponent(parts[2]));
      if (v === null) return res(400, { error: { message: 'Unable to parse range' } });
      return res(200, v.length ? { range: parts[2], majorDimension: 'ROWS', values: v } : { range: parts[2], majorDimension: 'ROWS' });
    }
    return res(404, {});
  }
  return { fetch: fetch, state: state };
}

module.exports = { create: create, serialOf: serialOf };
