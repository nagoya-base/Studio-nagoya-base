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
 * 失敗時の例外は本文を保持せず、固定コード（e.opsCode / opsStage / opsReason / opsHttp）のみ（#953）。
 */
'use strict';

var OpsSource = (function () {
  var API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
  var SHEET_NAME = 'Bookings';
  var MAX_ROWS = 20000;
  /* シリアル値（日時セル）として返りうる列。他の数値列（people・料金）は変換しない。 */
  var DATE_COLUMNS = ['date', 'createdAt', 'startAt', 'endAt', 'confirmedAt', 'expiredAt', 'cancelledAt', 'updatedAt', 'priceOverrideAt', 'accessGuideSentAt', 'confirmedMailSentAt'];
  var RENDER = 'majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER';

  function fail_(code) { var e = new Error(code); e.opsCode = code; return e; }

  /*
   * ---- 取得失敗の診断（Issue #953） ----
   * 失敗の「段階」と「原因分類」を、許可リストの固定語彙だけに変換する。
   * Googleのエラー本文・例外メッセージ・reason/statusの生の文字列は保持も出力もしない
   * （既知の語を判定に使うだけで、結果は固定コードのみ）。判定できないものは断定せず UNKNOWN 系にする。
   */
  var STAGES = ['META', 'HEADER', 'DATA'];
  var KNOWN_HTTP = [400, 401, 403, 404, 429, 500, 502, 503, 504];
  /* Googleの error.status（正規の列挙値）→ 分類。 */
  var STATUS_REASONS = {
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    UNAUTHENTICATED: 'AUTH_REJECTED',
    NOT_FOUND: 'TARGET_NOT_FOUND',
    INVALID_ARGUMENT: 'BAD_REQUEST',
    FAILED_PRECONDITION: 'BAD_REQUEST',
    RESOURCE_EXHAUSTED: 'RATE_LIMITED',
    UNAVAILABLE: 'TRANSIENT',
    INTERNAL: 'TRANSIENT',
    DEADLINE_EXCEEDED: 'TRANSIENT'
  };
  /* ErrorInfo.reason / errors[].reason の既知語 → 分類（statusより優先。API未有効化と一般の403を分けるため）。 */
  var REASON_REASONS = {
    SERVICE_DISABLED: 'API_DISABLED',
    accessNotConfigured: 'API_DISABLED',
    ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'SCOPE_INSUFFICIENT',
    insufficientPermissions: 'PERMISSION_DENIED',
    rateLimitExceeded: 'RATE_LIMITED',
    userRateLimitExceeded: 'RATE_LIMITED',
    RATE_LIMIT_EXCEEDED: 'RATE_LIMITED',
    RESOURCE_EXHAUSTED: 'RATE_LIMITED',
    notFound: 'TARGET_NOT_FOUND',
    authError: 'AUTH_REJECTED'
  };

  function ownKey_(map, key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }

  /* 応答本文から既知の reason / status を探す（無ければnull）。本文そのものは返さない。 */
  function classifyBody_(text) {
    var body;
    try { body = JSON.parse(text); } catch (e) { return null; }
    var err = body && typeof body === 'object' ? body.error : null;
    if (!err || typeof err !== 'object') return null;
    var found = null;
    var details = Array.isArray(err.details) ? err.details : [];
    details.forEach(function (d) { if (!found && d && typeof d === 'object') found = ownKey_(REASON_REASONS, d.reason); });
    var errors = Array.isArray(err.errors) ? err.errors : [];
    errors.forEach(function (d) { if (!found && d && typeof d === 'object') found = ownKey_(REASON_REASONS, d.reason); });
    return found || ownKey_(STATUS_REASONS, err.status);
  }

  /* HTTPステータスだけからの分類（本文から判定できない場合）。403は一般の403として別扱い（API未有効化と断定しない）。 */
  function classifyHttp_(code) {
    if (code === 401) return 'AUTH_REJECTED';
    if (code === 403) return 'HTTP_403_UNCLASSIFIED';
    if (code === 404) return 'TARGET_NOT_FOUND';
    if (code === 400) return 'BAD_REQUEST';
    if (code === 429) return 'RATE_LIMITED';
    if (code >= 500 && code <= 599) return 'TRANSIENT';
    return 'HTTP_OTHER';
  }

  /* 通信例外: 例外メッセージは出力しない。承認不足を示す既知の型だけを内部判定して固定コードにする。 */
  function classifyException_(e) {
    var msg = e && typeof e.message === 'string' ? e.message : '';
    if (/authorization is required|permission to call|script\.external_request/i.test(msg)) return 'EXCEPTION_AUTH_REQUIRED';
    return 'NETWORK_EXCEPTION';
  }

  function diagFail_(stage, reason, http) {
    var e = fail_('FETCH_FAILED');
    e.opsStage = STAGES.indexOf(stage) !== -1 ? stage : null;
    e.opsReason = reason;
    e.opsHttp = KNOWN_HTTP.indexOf(http) !== -1 ? http : null;
    return e;
  }

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
    return readSheet(deps, { sheetName: SHEET_NAME, columns: OpsNormalizer.ALLOWED_COLUMNS, dateColumns: DATE_COLUMNS });
  }

  /*
   * 収益集計（Issue #990 PR-B）用に、同じ台帳ファイルの別シートを「列の許可リスト」だけ読む（金額・日付・識別子のみ。
   * メール・氏名・Stripe IDなどの列は取得しない）。仕組みは readBookings と同一（Sheets API v4 の GET のみ）。
   * spec: { sheetName, columns: [列名...], dateColumns: [列名...] }
   */
  function readSheet(deps, spec) {
    var SHEET_NAME = spec.sheetName;
    var base = API_BASE + encodeURIComponent(deps.spreadsheetId);
    function get(tail, stage) {
      var token;
      try { token = deps.getToken(); } catch (e0) { throw diagFail_(stage, 'TOKEN_UNAVAILABLE', null); }
      var res;
      try {
        res = deps.fetch(base + tail, { method: 'get', muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
      } catch (e) {
        throw diagFail_(stage, classifyException_(e), null);
      }
      var status = res.getResponseCode();
      var text;
      try { text = res.getContentText(); } catch (e1) { throw diagFail_(stage, 'PARSE_FAILED', status); }
      if (status !== 200) throw diagFail_(stage, classifyBody_(text) || classifyHttp_(status), status);
      try { return JSON.parse(text); } catch (e2) { throw diagFail_(stage, 'PARSE_FAILED', status); }
    }
    function q(a1) { return encodeURIComponent("'" + SHEET_NAME + "'!" + a1); }

    var meta = get('?fields=' + encodeURIComponent('properties.timeZone,sheets.properties.title'), 'META');
    var found = ((meta && meta.sheets) || []).some(function (s) { return s && s.properties && s.properties.title === SHEET_NAME; });
    if (!found) throw fail_('SHEET_NOT_FOUND');
    var offset = tzOffsetMs_(meta.properties && meta.properties.timeZone);
    if (offset === null) throw fail_('TIMEZONE_UNSUPPORTED');

    var headerRes = get('/values/' + q('1:1') + '?' + RENDER, 'HEADER');
    var header = ((headerRes.values && headerRes.values[0]) || []).map(function (h) { return String(h).trim(); });
    /* 射影する前の元ヘッダーで、許可項目の列名の重複を検出して停止する（射影後は重複が見えなくなる）。 */
    var duplicated = spec.columns.filter(function (name) {
      return header.filter(function (h) { return h === name; }).length > 1;
    });
    if (duplicated.length) {
      var dup = fail_('SCHEMA_DUPLICATE');
      dup.opsColumns = duplicated;
      throw dup;
    }
    var wanted = [];
    spec.columns.forEach(function (name) {
      var i = header.indexOf(name);
      if (i !== -1) wanted.push({ name: name, col: i + 1 });
    });
    if (!wanted.length) return [[]];

    var ranges = wanted.map(function (w) { var L = colLetter_(w.col); return 'ranges=' + q(L + '2:' + L); }).join('&');
    var data = get('/values:batchGet?' + ranges + '&' + RENDER, 'DATA');
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
        return typeof cell === 'number' && isFinite(cell) && spec.dateColumns.indexOf(w.name) !== -1 ? serialToDate_(cell, offset) : cell;
      }));
    }
    return out;
  }

  return { readBookings: readBookings, readSheet: readSheet, MAX_ROWS: MAX_ROWS, DATE_COLUMNS: DATE_COLUMNS, STAGES: STAGES };
})();
