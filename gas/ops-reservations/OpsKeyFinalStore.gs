/*
 * OpsKeyFinalStore.gs — Bookings の accessKeyFinalStatus 1セルへの保存（Issue #971 Phase 1）。
 *
 * 書込みは「予約台帳（OPS_SPREADSHEET_ID）の Bookings シートの accessKeyFinalStatus 列の1セル」だけ。書込み先のシート・列・行は
 * 端末（ブラウザー）から受け取らない。列は1行目のヘッダー名で特定し（0件・複数件は書かずに停止）、行は予約IDの一致を
 * 書込み直前に再確認する。他の列・他のシートへは書かない。valueInputOption=RAW（"=..." を式として評価させない）。
 * 書込み後に同じセルを読み戻して一致を確認し、一致しなければ未保存として失敗にする。
 * 失敗時の例外は本文を保持せず、固定コード（e.opsCode='FINAL_STORE_FAILED', e.opsReason）だけを持つ。
 *
 * deps: { spreadsheetId, fetch(url, options), getToken() }
 * UrlFetchApp / PropertiesService / ScriptApp はこのファイルでは参照しない（GAS専用アダプター OpsApi.gs が注入する）。
 */
'use strict';

var OpsKeyFinalStore = (function () {
  var API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var SHEET_NAME = 'Bookings';
  var COLUMN = 'accessKeyFinalStatus';
  var ID_COLUMN = 'bookingId';
  var ID_RE = /^[A-Za-z0-9_-]{20,100}$/;
  var VALUE_RE = /^(REVOKED_CONFIRMED|NOT_ISSUED_CONFIRMED)@r[0-9]{1,6}@h[0-9a-f]{16}$/;
  var READ = 'majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE';

  function fail_(reason, http) {
    var e = new Error('final-store');
    e.opsCode = 'FINAL_STORE_FAILED';
    e.opsReason = reason + (typeof http === 'number' ? '/' + http : '');
    return e;
  }

  function colLetter_(n) {
    var s = '';
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  }

  function create(deps) {
    function request_(method, tail, body, reason) {
      var token;
      try { token = deps.getToken(); } catch (e0) { throw fail_(reason + '_TOKEN'); }
      var options = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
      if (body !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
      var res;
      try { res = deps.fetch(API_BASE + encodeURIComponent(deps.spreadsheetId) + tail, options); } catch (e1) { throw fail_(reason + '_NETWORK'); }
      var status = res.getResponseCode();
      if (status !== 200) throw fail_(reason + '_HTTP', status);
      try { return JSON.parse(res.getContentText()); } catch (e2) { throw fail_(reason + '_PARSE'); }
    }

    function cell_(a1) { return encodeURIComponent("'" + SHEET_NAME + "'!" + a1); }

    function readCell_(a1, reason) {
      var res = request_('get', '/values/' + cell_(a1) + '?' + READ, undefined, reason);
      var v = res && res.values && res.values[0] ? res.values[0][0] : '';
      return v === undefined || v === null ? '' : v;
    }

    return {
      /*
       * input: { rowNumber(2以上の整数), bookingId, value }。value は保存値の形式（OpsKeyFinal.encode の出力）だけを受理する。
       * 成功時は何も返さない（失敗は例外）。
       */
      write: function (input) {
        if (typeof deps.spreadsheetId !== 'string' || !ID_RE.test(deps.spreadsheetId)) throw fail_('TARGET_INVALID');
        if (!input || !(input.rowNumber >= 2) || Math.floor(input.rowNumber) !== input.rowNumber || typeof input.bookingId !== 'string' || !input.bookingId) throw fail_('INPUT_INVALID');
        if (typeof input.value !== 'string' || !VALUE_RE.test(input.value)) throw fail_('VALUE_INVALID');
        var header = request_('get', '/values/' + cell_('1:1') + '?' + READ, undefined, 'HEADER');
        var names = ((header && header.values && header.values[0]) || []).map(function (h) { return String(h).trim(); });
        var finalIdx = -1, idIdx = -1, finalCount = 0, idCount = 0;
        names.forEach(function (h, i) {
          if (h === COLUMN) { finalIdx = i; finalCount++; }
          if (h === ID_COLUMN) { idIdx = i; idCount++; }
        });
        if (finalCount !== 1) throw fail_(finalCount === 0 ? 'COLUMN_MISSING' : 'COLUMN_DUPLICATE');
        if (idCount !== 1) throw fail_('ID_COLUMN_INVALID');
        var row = input.rowNumber;
        var idCell = colLetter_(idIdx + 1) + row;
        if (String(readCell_(idCell, 'IDCHECK')).trim() !== input.bookingId) throw fail_('ROW_MISMATCH');
        var target = colLetter_(finalIdx + 1) + row;
        var res = request_('put', '/values/' + cell_(target) + '?valueInputOption=RAW', { majorDimension: 'ROWS', values: [[input.value]] }, 'WRITE');
        if (!res || res.updatedCells !== 1) throw fail_('WRITE_NOT_CONFIRMED');
        if (String(readCell_(target, 'READBACK')).trim() !== input.value) throw fail_('READBACK_MISMATCH');
      }
    };
  }

  return { create: create, SHEET_NAME: SHEET_NAME, COLUMN: COLUMN };
})();
