/*
 * OpsTasksStore.gs — メモ（Tasks表）の保存先アダプター（Issue #941）。
 *
 * 保存先は「所有者が用意した、予約台帳とは別の専用スプレッドシート」1つだけ。このアプリはファイルを作成しない
 * （drive.file は“このアプリが作成したファイル”にしか届かず、手動で用意したファイルには使えないため）。
 * 手動作成ファイルへ読み書きできる最小のスコープは spreadsheets（ファイル単位で絞れない）なので、権限の代わりにコードで次を固定する（静的テストで検査）:
 *   - 書込み先は Script Property OPS_TASKS_SPREADSHEET_ID のIDだけ。端末（ブラウザー）からIDや範囲は受け取らない。
 *   - そのIDが予約台帳のID（OPS_SPREADSHEET_ID）と同じなら、読み書きせず停止する。
 *   - 読み書きは Tasks シートの固定範囲（A:K）だけ。valueInputOption=RAW（"=..." を式として評価させない）。
 *   - 保存先が未設定のときに別ファイルを作らない。Tasksタブ・ヘッダーが無い/不一致なら書かずに停止（初期化は手順書の手動）。
 * 失敗時の例外は本文を保持せず、固定コード（e.opsCode='STORE_FAILED', e.opsReason）だけを持つ。
 *
 * deps: { getSpreadsheetId(), getLedgerId(), fetch(url, options), getToken() }
 * UrlFetchApp / PropertiesService / ScriptApp はこのファイルでは参照しない（GAS専用アダプターが注入する）。
 */
'use strict';

var OpsTasksStore = (function () {
  var API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
  var SHEET = 'Tasks';
  var LAST_COL = 'K';
  var ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

  /*
   * HTTPエラーの原因分類（Issue #941 / #953と同じ方針）。応答本文は**判定にだけ使い**、保持・出力しない。
   * 結果は許可リストの固定語（reasonコードの末尾）だけ。判定できなければ付けない（原因を断定しない）。
   */
  var REASON_CLASSES = {
    ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'SCOPE_INSUFFICIENT', insufficientPermissions: 'PERMISSION_DENIED',
    SERVICE_DISABLED: 'API_DISABLED', accessNotConfigured: 'API_DISABLED',
    rateLimitExceeded: 'RATE_LIMITED', userRateLimitExceeded: 'RATE_LIMITED', RATE_LIMIT_EXCEEDED: 'RATE_LIMITED'
  };
  var STATUS_CLASSES = { PERMISSION_DENIED: 'PERMISSION_DENIED', FAILED_PRECONDITION: 'PRECONDITION', RESOURCE_EXHAUSTED: 'RATE_LIMITED' };
  function own_(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null; }
  function classifyBody_(text) {
    var body;
    try { body = JSON.parse(text); } catch (e) { return null; }
    var err = body && typeof body === 'object' ? body.error : null;
    if (!err || typeof err !== 'object') return null;
    var found = null;
    [].concat(Array.isArray(err.details) ? err.details : [], Array.isArray(err.errors) ? err.errors : []).forEach(function (d) {
      if (!found && d && typeof d === 'object') found = own_(REASON_CLASSES, d.reason);
    });
    /* 保護された範囲への書込み拒否は、メッセージの既知の言い回しだけで識別する（本文は出さない）。 */
    if (!found && typeof err.message === 'string' && /protected cell or object/i.test(err.message)) found = 'PROTECTED_RANGE';
    if (!found && typeof err.message === 'string' && /operation is not supported for this document/i.test(err.message)) found = 'UNSUPPORTED_FILE';
    return found || own_(STATUS_CLASSES, err.status);
  }

  function fail_(reason, http, cls) {
    var e = new Error('store');
    e.opsCode = 'STORE_FAILED';
    e.opsReason = reason + (typeof http === 'number' ? '/' + http : '') + (typeof cls === 'string' && /^[A-Z_]{1,24}$/.test(cls) ? '/' + cls : '');
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
      if (status !== 200) {
        var cls = null;
        try { cls = classifyBody_(res.getContentText()); } catch (e3) { cls = null; }
        throw fail_(reason + '_HTTP', status, cls);
      }
      try { return JSON.parse(res.getContentText()); } catch (e2) { throw fail_(reason + '_PARSE'); }
    }

    function requireId_() {
      var id = targetId_();
      if (!id) throw fail_('NOT_CONFIGURED');
      return id;
    }

    function range_(a1) { return encodeURIComponent(SHEET + '!' + a1); }

    return {
      state: function () { return { ready: targetId_() !== null }; },

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

  return { create: create, SHEET: SHEET };
})();
