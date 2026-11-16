/*
 * OpsApi.gs — バックエンドの要求処理（Issue #936）。読み取り専用。通信方式に依存しない。
 *
 * handle(request, ctx) が共通の接続契約の入口:
 *   request: { op: 'list', params } | { op: 'detail', id }
 *   ctx:     { authenticate, readLedger }（省略時は GAS Session 認証器 / Sheets API 読み取り）
 *   戻り値:  { ok: true, ...} | { ok: false, error: { code, message } }（codeは OpsContract.ERROR_CODES）
 * 全要求で毎回認可し、拒否時は予約情報を一切返さない。ログは件数と固定コードのみ。
 * GAS専用の入口（doGet / opsListReservations / opsGetReservation）はこのファイル末尾の薄いアダプターで、
 * 業務ロジックは持たない。
 */
'use strict';

var OpsApi = (function () {
  var FETCH_ERRORS_ = {
    SHEET_NOT_FOUND: '予約台帳のシートが見つかりません。',
    TOO_LARGE: '予約台帳の行数が上限を超えています（一部だけを全件のように表示しないため停止しました）。',
    TIMEZONE_UNSUPPORTED: '予約台帳のタイムゾーンに対応していません。',
    SCHEMA_DUPLICATE: '予約台帳のヘッダーに同名の列が複数あります。どの列が正か判断できないため停止しました',
    FETCH_FAILED: '予約台帳の取得に失敗しました。時間をおいて再取得してください。'
  };
  var AUTH_MESSAGES_ = { UNAUTHENTICATED: '利用者を確認できません。', FORBIDDEN: '権限がありません。' };

  function error_(code, message) { return { ok: false, error: { code: code, message: message } }; }

  function serviceStates_(records) {
    return OpsContract.SERVICES.map(function (s) {
      if (!s.connected) return { service: s.id, label: s.label, state: 'not_connected' };
      var n = records.filter(function (r) { return r.service === s.id; }).length;
      return { service: s.id, label: s.label, state: n === 0 ? 'no_data' : 'connected' };
    });
  }

  /* 既定の台帳読み取り（GAS）。deps を差し替えれば他の実行基盤でも同じ検証・正規化を使える。 */
  function readLedgerGas_() {
    var id = PropertiesService.getScriptProperties().getProperty('OPS_SPREADSHEET_ID');
    if (!id) return { notConnected: true };
    return {
      values: OpsSource.readBookings({
        spreadsheetId: id,
        fetch: function (url, options) { return UrlFetchApp.fetch(url, options); },
        getToken: function () { return ScriptApp.getOAuthToken(); }
      })
    };
  }

  function load_(ctx) {
    var read;
    try {
      read = ctx.readLedger();
    } catch (e) {
      var code = e && FETCH_ERRORS_[e.opsCode] ? e.opsCode : 'FETCH_FAILED';
      Logger.log('ops: read failed ' + code);
      var detail = code === 'SCHEMA_DUPLICATE' && e.opsColumns ? ': ' + e.opsColumns.join(', ') : '';
      return error_(code, FETCH_ERRORS_[code] + detail);
    }
    if (read.notConnected) return error_('NOT_CONNECTED', '予約台帳が未接続です（接続先が未設定）。');
    var normalized = OpsNormalizer.normalize(read.values);
    if (normalized.schemaError) {
      if (normalized.schemaError.duplicated) {
        return error_('SCHEMA_DUPLICATE', FETCH_ERRORS_.SCHEMA_DUPLICATE + ': ' + normalized.schemaError.duplicated.join(', '));
      }
      return error_('SCHEMA_MISMATCH', '予約台帳に必要な列がありません: ' + normalized.schemaError.missing.join(', '));
    }
    return { ok: true, normalized: normalized };
  }

  function list_(params, ctx, nowMs) {
    var today = OpsContract.formatJstDate(nowMs);
    var resolved = OpsQuery.resolve(params, today);
    if (resolved.error) return error_('INVALID_PARAMS', '条件が不正です: ' + resolved.error);
    var criteria = resolved.value;
    var loaded = load_(ctx);
    if (!loaded.ok) return loaded;
    var n = loaded.normalized;
    var rows = OpsQuery.select(n.records, criteria);
    Logger.log('ops list rows=' + n.totalRows + ' valid=' + n.records.length + ' matched=' + rows.length + ' issues=' + n.issues.length);
    var selected = OpsContract.serviceById(criteria.service);
    return {
      ok: true,
      contractVersion: OpsContract.CONTRACT_VERSION,
      fetchedAt: OpsContract.toIso(nowMs),
      todayJst: today,
      applied: criteria,
      /* 台帳全体を1回で読み切っている（部分取得ではない）。 */
      complete: true,
      counts: { sheetRows: n.totalRows, valid: n.records.length, matched: rows.length, issues: n.issues.length },
      serviceStates: serviceStates_(n.records),
      notConnectedSelected: !!selected && !selected.connected,
      items: rows.map(function (r) { return OpsQuery.toListItem(r, nowMs); }),
      issues: n.issues.map(function (i) {
        return { row: i.row, bookingId: i.bookingId, severity: i.severity, reasons: i.codes.map(OpsNormalizer.reasonText) };
      })
    };
  }

  function detail_(id, ctx, nowMs) {
    var key = typeof id === 'string' ? id.trim() : '';
    if (!key) return error_('INVALID_PARAMS', '予約IDが指定されていません。');
    var loaded = load_(ctx);
    if (!loaded.ok) return loaded;
    var n = loaded.normalized;
    /* 重複IDは「不存在」と区別する（どの行が正かは判断せず、別予約の詳細も返さない）。 */
    if (n.duplicateIds.indexOf(key) !== -1) return error_('DUPLICATE_ID', '同じ予約IDの行が複数あるため表示できません。');
    var found = n.records.filter(function (r) { return r.bookingId === key; });
    if (found.length !== 1) return error_('NOT_FOUND', '該当する予約が見つかりません（空欄・不正な行は表示対象外です）。');
    return { ok: true, contractVersion: OpsContract.CONTRACT_VERSION, fetchedAt: OpsContract.toIso(nowMs), reservation: OpsQuery.toDetail(found[0], nowMs) };
  }

  /* 共通契約の入口。ctx.nowMs は検証用（省略時は現在時刻）。 */
  function handle(request, ctx) {
    var context = ctx || {};
    var authenticate = context.authenticate || OpsAuth.createGasSessionAuthenticator();
    var auth = authenticate();
    if (!auth || auth.ok !== true) {
      var code = auth && auth.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNAUTHENTICATED';
      return error_(code, AUTH_MESSAGES_[code]);
    }
    var full = { authenticate: authenticate, readLedger: context.readLedger || readLedgerGas_ };
    var nowMs = typeof context.nowMs === 'number' ? context.nowMs : Date.now();
    var op = request && request.op;
    if (op === 'list') return list_(request.params, full, nowMs);
    if (op === 'detail') return detail_(request.id, full, nowMs);
    return error_('INVALID_PARAMS', '要求の種類が不正です。');
  }

  return { handle: handle };
})();

/* ---- 以下はGAS専用の薄いアダプター（業務ロジックなし） ---- */
function doGet() {
  var auth = OpsAuth.createGasSessionAuthenticator()();
  if (!auth.ok) return HtmlService.createHtmlOutput('<p>権限がありません。</p>').setTitle('Ops');
  return HtmlService.createHtmlOutputFromFile('OpsPage')
    .setTitle('予約確認')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* google.script.run から呼ぶ公開関数（読み取り専用）。 */
function opsListReservations(params) { return OpsApi.handle({ op: 'list', params: params }); }
function opsGetReservation(bookingId) { return OpsApi.handle({ op: 'detail', id: bookingId }); }
