/*
 * OpsApi.gs — 運営アプリ段階1のWeb Appエントリ・API（Issue #936）。読み取り専用。
 *
 * 認可: Web App設定は「自分のみ」(access: MYSELF)。加えて全API・doGetでサーバー側の所有者照合を
 * 毎回行う（Script Propertiesの OPS_OWNER_EMAIL と実行ユーザーのメールが一致しなければ拒否。
 * 未設定・取得不能は拒否=fail-closed）。非公開URLだけを認証の代わりにしない。
 * 接続: Script Propertiesの OPS_SPREADSHEET_ID（既存の予約台帳）を、Sheets API v4のGET（OpsSource.gs。
 * spreadsheets.readonlyスコープ）で読むのみ。
 * 未設定なら「未接続」を返し、0件とは区別する。
 * ログ: 件数・理由コードだけ。予約ID・氏名・行データは出さない。
 */
'use strict';

var OpsApi = (function () {
    function props_() { return PropertiesService.getScriptProperties(); }

  function activeEmail_() {
    try {
      var email = Session.getActiveUser().getEmail();
      return typeof email === 'string' ? email.trim().toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  function isOwner_() {
    var owner = props_().getProperty('OPS_OWNER_EMAIL');
    owner = typeof owner === 'string' ? owner.trim().toLowerCase() : '';
    if (!owner) return false;
    var active = activeEmail_();
    return active !== '' && active === owner;
  }

  function error_(code, message) { return { ok: false, error: { code: code, message: message } }; }

  function serviceStates_(records) {
    return OpsContract.SERVICES.map(function (s) {
      if (!s.connected) return { service: s.id, label: s.label, state: 'not_connected' };
      var n = records.filter(function (r) { return r.service === s.id; }).length;
      return { service: s.id, label: s.label, state: n === 0 ? 'no_data' : 'connected' };
    });
  }

  var FETCH_ERRORS_ = {
    SHEET_NOT_FOUND: '予約台帳のシートが見つかりません。',
    TOO_LARGE: '予約台帳の行数が上限を超えています（一部だけを全件のように表示しないため停止しました）。',
    TIMEZONE_UNSUPPORTED: '予約台帳のタイムゾーンに対応していません。',
    SCHEMA_DUPLICATE: '予約台帳のヘッダーに同名の列が複数あります。どの列が正か判断できないため停止しました',
    FETCH_FAILED: '予約台帳の取得に失敗しました。時間をおいて再取得してください。'
  };

  /* 台帳の読み取り。戻り値: {ok:true, normalized} | {ok:false, error}。 */
  function load_() {
    var id = props_().getProperty('OPS_SPREADSHEET_ID');
    if (!id) return error_('NOT_CONNECTED', '予約台帳が未接続です（接続先が未設定）。');
    var values;
    try {
      values = OpsSource.readBookings({
        spreadsheetId: id,
        fetch: function (url, options) { return UrlFetchApp.fetch(url, options); },
        getToken: function () { return ScriptApp.getOAuthToken(); }
      });
    } catch (e) {
      var code = e && FETCH_ERRORS_[e.opsCode] ? e.opsCode : 'FETCH_FAILED';
      Logger.log('ops: read failed ' + code);
      var detail = code === 'SCHEMA_DUPLICATE' && e.opsColumns ? ': ' + e.opsColumns.join(', ') : '';
      return error_(code, FETCH_ERRORS_[code] + detail);
    }
    var normalized = OpsNormalizer.normalize(values);
    if (normalized.schemaError) {
      if (normalized.schemaError.duplicated) {
        return error_('SCHEMA_DUPLICATE', FETCH_ERRORS_.SCHEMA_DUPLICATE + ': ' + normalized.schemaError.duplicated.join(', '));
      }
      return error_('SCHEMA_MISMATCH', '予約台帳に必要な列がありません: ' + normalized.schemaError.missing.join(', '));
    }
    return { ok: true, normalized: normalized };
  }

  function todayJst_() { return OpsContract.formatJstDate(Date.now()); }

  function listReservations(params) {
    if (!isOwner_()) return error_('FORBIDDEN', '権限がありません。');
    var today = todayJst_();
    var resolved = OpsQuery.resolve(params, today);
    if (resolved.error) return error_('INVALID_PARAMS', '条件が不正です: ' + resolved.error);
    var criteria = resolved.value;
    var loaded = load_();
    if (!loaded.ok) return loaded;
    var n = loaded.normalized;
    var rows = OpsQuery.select(n.records, criteria);
    Logger.log('ops list rows=' + n.totalRows + ' valid=' + n.records.length + ' matched=' + rows.length + ' issues=' + n.issues.length);
    return {
      ok: true,
      fetchedAt: new Date().toISOString(),
      fetchedAtJst: OpsContract.formatJstDateTime(Date.now()) + ' JST',
      todayJst: today,
      applied: criteria,
      /* 台帳全体を1回で読み切っている（部分取得ではない）。 */
      complete: true,
      counts: { sheetRows: n.totalRows, valid: n.records.length, matched: rows.length, issues: n.issues.length },
      serviceStates: serviceStates_(n.records),
      notConnectedSelected: criteria.service !== 'all' && !(OpsContract.serviceById(criteria.service) || {}).connected,
      items: rows.map(OpsQuery.toListItem),
      issues: n.issues.map(function (i) {
        return { row: i.row, bookingId: i.bookingId, severity: i.severity, reasons: i.codes.map(OpsNormalizer.reasonText) };
      })
    };
  }

  function getReservation(bookingId) {
    if (!isOwner_()) return error_('FORBIDDEN', '権限がありません。');
    var key = typeof bookingId === 'string' ? bookingId.trim() : '';
    if (!key) return error_('INVALID_PARAMS', '予約IDが指定されていません。');
    var loaded = load_();
    if (!loaded.ok) return loaded;
    var found = loaded.normalized.records.filter(function (r) { return r.bookingId === key; });
    if (found.length !== 1) return error_('NOT_FOUND', '該当する予約が見つかりません（空欄・重複IDの行は表示対象外です）。');
    return { ok: true, fetchedAt: new Date().toISOString(), reservation: OpsQuery.toDetail(found[0]) };
  }

  return { isOwner: isOwner_, listReservations: listReservations, getReservation: getReservation };
})();

function doGet() {
  if (!OpsApi.isOwner()) {
    return HtmlService.createHtmlOutput('<p>権限がありません。</p>').setTitle('Ops');
  }
  return HtmlService.createHtmlOutputFromFile('OpsPage')
    .setTitle('予約確認')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* google.script.run から呼ぶ公開関数（読み取り専用）。 */
function opsListReservations(params) { return OpsApi.listReservations(params); }
function opsGetReservation(bookingId) { return OpsApi.getReservation(bookingId); }
