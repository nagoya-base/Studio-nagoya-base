/*
 * OpsTasksStore.gs — メモ（Tasks表）の保存先アダプター（Issue #941）。
 *
 * 保存先は「このアプリ自身が Sheets API で作成した専用スプレッドシート」1つだけ。予約台帳とは別のファイル。
 * 書込み権限は drive.file（このアプリが作成したファイルだけ）。予約台帳（別途作成されたファイル）には、
 * このスコープでは書込みも閲覧も届かない。さらにコードでも次を固定する（静的テストで検査）:
 *   - 書込み先は Script Property OPS_TASKS_SPREADSHEET_ID のIDだけ。端末（ブラウザー）からIDや範囲は受け取らない。
 *   - そのIDが予約台帳のID（OPS_SPREADSHEET_ID）と同じなら、読み書きせず停止する。
 *   - 書込みは Tasks シートの固定範囲（A:K）だけ。valueInputOption=RAW（"=..." を式として評価させない）。
 * 失敗時の例外は本文を保持せず、固定コード（e.opsCode='STORE_FAILED', e.opsReason）だけを持つ。
 *
 * deps: { getSpreadsheetId(), setSpreadsheetId(id), getLedgerId(), fetch(url, options), getToken() }
 * UrlFetchApp / PropertiesService / ScriptApp はこのファイルでは参照しない（GAS専用アダプターが注入する）。
 */
'use strict';

var OpsTasksStore = (function () {
  var API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
  var SHEET = 'Tasks';
  var LAST_COL = 'K';
  var TITLE = '運営アプリ メモ（専用・予約台帳ではありません）';
  var ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

  function fail_(reason, http) {
    var e = new Error('store');
    e.opsCode = 'STORE_FAILED';
    e.opsReason = reason + (typeof http === 'number' ? '/' + http : '');
    return e;
  }

  function create(deps) {
    function headers_() { return OpsTasks.HEADERS; }

    /* 書込み先IDの検証。未設定は null（未作成）。不正・台帳と同一は停止。 */
    function targetId_() {
      var id = deps.getSpreadsheetId();
      if (!id) return null;
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw fail_('TARGET_INVALID');
      var ledger = deps.getLedgerId();
      if (ledger && ledger === id) throw fail_('TARGET_IS_LEDGER');
      return id;
    }

    function request_(method, url, body, reason) {
      var token;
      try { token = deps.getToken(); } catch (e0) { throw fail_(reason + '_TOKEN'); }
      var options = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } };
      if (body !== undefined) { options.contentType = 'application/json'; options.payload = JSON.stringify(body); }
      var res;
      try { res = deps.fetch(url, options); } catch (e1) { throw fail_(reason + '_NETWORK'); }
      var status = res.getResponseCode();
      if (status !== 200) throw fail_(reason + '_HTTP', status);
      try { return JSON.parse(res.getContentText()); } catch (e2) { throw fail_(reason + '_PARSE'); }
    }

    function requireId_() {
      var id = targetId_();
      if (!id) throw fail_('NOT_CREATED');
      return id;
    }

    function range_(a1) { return encodeURIComponent(SHEET + '!' + a1); }

    return {
      state: function () { return { ready: targetId_() !== null }; },

      /* 専用スプレッドシートを1つ作る（ヘッダー行つき・1回のAPI呼び出し）。IDはScript Propertyへ保存。 */
      create: function () {
        if (targetId_() !== null) return;
        var cells = headers_().map(function (h) { return { userEnteredValue: { stringValue: h } }; });
        var made = request_('post', API_BASE, {
          properties: { title: TITLE, locale: 'ja_JP', timeZone: 'Asia/Tokyo' },
          sheets: [{ properties: { title: SHEET, gridProperties: { frozenRowCount: 1 } }, data: [{ startRow: 0, startColumn: 0, rowData: [{ values: cells }] }] }]
        }, 'CREATE');
        var id = made && made.spreadsheetId;
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw fail_('CREATE_BAD_RESPONSE');
        var ledger = deps.getLedgerId();
        if (ledger && ledger === id) throw fail_('TARGET_IS_LEDGER');
        try { deps.setSpreadsheetId(id); } catch (e) { throw fail_('CREATE_PROPERTY'); }
      },

      readAll: function () {
        var id = requireId_();
        var res = request_('get', API_BASE + '/' + encodeURIComponent(id) + '/values/' + range_('A1:' + LAST_COL) + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE', undefined, 'READ');
        var values = (res && res.values) || [];
        if (values.length > OpsTasks.MAX_TASKS + 2) throw fail_('READ_TOO_LARGE');
        return { header: values[0] || [], rows: values.slice(1) };
      },

      append: function (cells) {
        var id = requireId_();
        var res = request_('post', API_BASE + '/' + encodeURIComponent(id) + '/values/' + range_('A1:' + LAST_COL) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
          { majorDimension: 'ROWS', values: [cells] }, 'APPEND');
        if (!res || !res.updates || res.updates.updatedRows !== 1) throw fail_('APPEND_NOT_CONFIRMED');
      },

      updateRow: function (rowNumber, cells) {
        var id = requireId_();
        if (!(rowNumber >= 2) || Math.floor(rowNumber) !== rowNumber) throw fail_('ROW_INVALID');
        var res = request_('put', API_BASE + '/' + encodeURIComponent(id) + '/values/' + range_('A' + rowNumber + ':' + LAST_COL + rowNumber) + '?valueInputOption=RAW',
          { majorDimension: 'ROWS', values: [cells] }, 'UPDATE');
        if (!res || res.updatedRows !== 1) throw fail_('UPDATE_NOT_CONFIRMED');
      },

      /* 行削除（保持期限・所有者の削除）。大きい行番号から順に消す。ヘッダー行は消さない。 */
      removeRows: function (rowNumbers) {
        var id = requireId_();
        var rows = rowNumbers.filter(function (n, i) { return n >= 2 && Math.floor(n) === n && rowNumbers.indexOf(n) === i; }).sort(function (a, b) { return b - a; });
        if (!rows.length || rows.length !== rowNumbers.length) throw fail_('ROW_INVALID');
        var meta = request_('get', API_BASE + '/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent('sheets.properties(sheetId,title)'), undefined, 'META');
        var sheetId = null;
        ((meta && meta.sheets) || []).forEach(function (s) { if (s && s.properties && s.properties.title === SHEET) sheetId = s.properties.sheetId; });
        if (typeof sheetId !== 'number') throw fail_('SHEET_NOT_FOUND');
        request_('post', API_BASE + '/' + encodeURIComponent(id) + ':batchUpdate', {
          requests: rows.map(function (n) { return { deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: n - 1, endIndex: n } } }; })
        }, 'DELETE');
      }
    };
  }

  return { create: create, SHEET: SHEET, TITLE: TITLE };
})();
