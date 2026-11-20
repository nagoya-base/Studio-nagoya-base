/*
 * OpsRevenueStore.gs — SNBC実績・現地払い受領記録の保存先アダプター（Issue #995 PR-C）。
 *
 * OpsTasksStore.gs（#941）と同じ方針の、固定2タブ専用の薄いアダプター。汎用の台帳基盤ではない。
 *   - 書込み先は Script Property OPS_TASKS_SPREADSHEET_ID（既存のオーナー専用メモ保存先）のIDだけ。端末からID・タブ名・範囲は受け取らない。
 *   - そのIDが予約台帳のID（OPS_SPREADSHEET_ID）と同じなら、読み書きせず停止する。
 *   - 触るタブは SNBCEvents（A:I）と OnsiteReceipts（A:G）だけ。Tasks タブ・予約台帳へは書かない。valueInputOption=RAW。
 *   - タブ・ヘッダーが無い/不一致なら書かずに停止（作成は手動。このアプリはファイル・タブを作らない）。
 * 失敗時の例外は本文を保持せず、固定コード（e.opsCode='STORE_FAILED', e.opsReason）だけを持つ。
 *
 * deps: { getSpreadsheetId(), getLedgerId(), fetch(url, options), getToken() }
 */
'use strict';

var OpsRevenueStore = (function () {
  var API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
  var TABS = { snbc: { sheet: 'SNBCEvents', lastCol: 'I' }, onsite: { sheet: 'OnsiteReceipts', lastCol: 'G' } };
  var MAX_ROWS = 2000;
  var ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

  var REASON_CLASSES = {
    ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'SCOPE_INSUFFICIENT', insufficientPermissions: 'PERMISSION_DENIED',
    SERVICE_DISABLED: 'API_DISABLED', accessNotConfigured: 'API_DISABLED',
    rateLimitExceeded: 'RATE_LIMITED', userRateLimitExceeded: 'RATE_LIMITED', RATE_LIMIT_EXCEEDED: 'RATE_LIMITED'
  };
  var STATUS_CLASSES = { PERMISSION_DENIED: 'PERMISSION_DENIED', FAILED_PRECONDITION: 'PRECONDITION', RESOURCE_EXHAUSTED: 'RATE_LIMITED' };
  function own_(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null; }
  /* 応答本文は判定にだけ使い、保持・出力しない。結果は許可リストの固定語だけ。 */
  function classifyBody_(text) {
    var body;
    try { body = JSON.parse(text); } catch (e) { return null; }
    var err = body && typeof body === 'object' ? body.error : null;
    if (!err || typeof err !== 'object') return null;
    var found = null;
    [].concat(Array.isArray(err.details) ? err.details : [], Array.isArray(err.errors) ? err.errors : []).forEach(function (d) {
      if (!found && d && typeof d === 'object') found = own_(REASON_CLASSES, d.reason);
    });
    if (!found && typeof err.message === 'string' && /protected cell or object/i.test(err.message)) found = 'PROTECTED_RANGE';
    return found || own_(STATUS_CLASSES, err.status);
  }

  function fail_(reason, http, cls) {
    var e = new Error('store');
    e.opsCode = 'STORE_FAILED';
    e.opsReason = reason + (typeof http === 'number' ? '/' + http : '') + (typeof cls === 'string' && /^[A-Z_]{1,24}$/.test(cls) ? '/' + cls : '');
    return e;
  }

  function create(deps) {
    function targetId_() {
      var id = deps.getSpreadsheetId();
      if (!id) return null;
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw fail_('TARGET_INVALID');
      var ledger = deps.getLedgerId();
      if (ledger && ledger === id) throw fail_('TARGET_IS_LEDGER');
      return id;
    }
    function requireId_() {
      var id = targetId_();
      if (!id) throw fail_('NOT_CONFIGURED');
      return id;
    }
    function tab_(kind) {
      if (!Object.prototype.hasOwnProperty.call(TABS, kind)) throw fail_('TAB_INVALID');
      return TABS[kind];
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
    function range_(t, a1) { return encodeURIComponent(t.sheet + '!' + a1); }

    return {
      state: function () { return { ready: targetId_() !== null }; },

      readAll: function (kind) {
        var id = requireId_(), t = tab_(kind);
        var res = request_('get', API_BASE + '/' + encodeURIComponent(id) + '/values/' + range_(t, 'A1:' + t.lastCol) + '?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE', undefined, 'READ');
        var values = (res && res.values) || [];
        if (values.length > MAX_ROWS + 1) throw fail_('READ_TOO_LARGE');
        return { header: values[0] || [], rows: values.slice(1) };
      },

      append: function (kind, cells) {
        var id = requireId_(), t = tab_(kind);
        var res = request_('post', API_BASE + '/' + encodeURIComponent(id) + '/values/' + range_(t, 'A1:' + t.lastCol) + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
          { majorDimension: 'ROWS', values: [cells] }, 'APPEND');
        if (!res || !res.updates || res.updates.updatedRows !== 1) throw fail_('APPEND_NOT_CONFIRMED');
      },

      updateRow: function (kind, rowNumber, cells) {
        var id = requireId_(), t = tab_(kind);
        if (!(rowNumber >= 2) || Math.floor(rowNumber) !== rowNumber) throw fail_('ROW_INVALID');
        var res = request_('put', API_BASE + '/' + encodeURIComponent(id) + '/values/' + range_(t, 'A' + rowNumber + ':' + t.lastCol + rowNumber) + '?valueInputOption=RAW',
          { majorDimension: 'ROWS', values: [cells] }, 'UPDATE');
        if (!res || res.updatedRows !== 1) throw fail_('UPDATE_NOT_CONFIRMED');
      },

      /* 対象の1行だけを削除する（ヘッダー行は消さない）。 */
      removeRow: function (kind, rowNumber) {
        var id = requireId_(), t = tab_(kind);
        if (!(rowNumber >= 2) || Math.floor(rowNumber) !== rowNumber) throw fail_('ROW_INVALID');
        var meta = request_('get', API_BASE + '/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent('sheets.properties(sheetId,title)'), undefined, 'META');
        var sheetId = null;
        ((meta && meta.sheets) || []).forEach(function (s) { if (s && s.properties && s.properties.title === t.sheet) sheetId = s.properties.sheetId; });
        if (typeof sheetId !== 'number') throw fail_('SHEET_NOT_FOUND');
        request_('post', API_BASE + '/' + encodeURIComponent(id) + ':batchUpdate', {
          requests: [{ deleteDimension: { range: { sheetId: sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } }]
        }, 'DELETE');
      }
    };
  }

  return { create: create, TABS: TABS, MAX_ROWS: MAX_ROWS };
})();
