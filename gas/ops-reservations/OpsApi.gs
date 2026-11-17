/*
 * OpsApi.gs — バックエンドの要求処理（Issue #936 / #941）。通信方式に依存しない。
 * 予約台帳は読み取り専用（#936）。書込みはメモ（#941）の専用保存先だけで、予約台帳には書かない。
 *
 * handle(request, ctx) が共通の接続契約の入口:
 *   request: { op: 'list', params } | { op: 'detail', id } | { op: 'tasks_list' | 'task_save' | 'task_delete', ... }（OpsTasks.gs）
 *   ctx:     { authenticate, readLedger, tasks }（省略時は GAS Session 認証器 / Sheets API 読み取り / 専用保存先）
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
    FETCH_FAILED: '予約台帳の取得に失敗しました。'
  };
  /*
   * 取得失敗の診断（Issue #953）。OpsSource が付けた固定の段階・分類（許可リスト）だけを使い、
   * 画面へ「診断コード」と固定の対応案を返す。Googleの応答本文・例外メッセージ・ID・トークンは含めない。
   * 分類が許可リストに無い失敗は UNKNOWN とし、原因を断定しない。
   */
  var DIAG_STAGES_ = ['META', 'HEADER', 'DATA'];
  var DIAG_ADVICE_ = {
    API_DISABLED: 'Googleが「このGASのGCPプロジェクトでSheets APIが無効」と返しています。GCPの切替は不要です。GASにGoogle Sheets拡張サービス（Sheets v4）を追加するとAPIが自動で有効になります。正本のデプロイ（運営アプリ専用Actions）で更新後に再取得し、同じ診断コードが続く場合はコードを開発担当へ共有してください。',
    SCOPE_INSUFFICIENT: '承認済みの権限が不足しています。所有者本人のアカウントで専用URLを開き直し、読み取り専用の承認画面が出たら承認してください（権限の拡大は不要）。',
    EXCEPTION_AUTH_REQUIRED: 'GASの外部通信（script.external_request）または読み取り権限の承認が済んでいない可能性があります。所有者本人で専用URLを開き直し、承認画面が出たら承認してください。',
    TOKEN_UNAVAILABLE: 'GASの認証トークンを取得できませんでした。所有者本人で専用URLを開き直して承認状態を確認し、改善しなければ診断コードを開発担当へ共有してください。',
    AUTH_REJECTED: 'Googleが認証を受け付けませんでした。所有者本人で専用URLを開き直して再承認してください。繰り返す場合は診断コードを開発担当へ共有してください。',
    PERMISSION_DENIED: 'Googleがこのアカウントでの台帳アクセスを拒否しました（API未有効化とは限りません）。GASを実行しているアカウントが台帳を直接開けるアカウントと同一か確認し、診断コードを開発担当へ共有してください。',
    TARGET_NOT_FOUND: 'Googleが対象の台帳を見つけられませんでした。接続先ID（OPS_SPREADSHEET_ID）がURLではなくIDのみで、Googleスプレッドシート形式のファイルを指しているか確認してください。',
    BAD_REQUEST: 'Googleがリクエストを受け付けませんでした。台帳がGoogleスプレッドシート形式か（Excel形式のままではないか）確認し、診断コードを開発担当へ共有してください。',
    RATE_LIMITED: 'Googleの利用回数制限に達した可能性があります。数分あけて1回だけ再取得し、同じ診断コードが続く場合はコードを開発担当へ共有してください。',
    TRANSIENT: 'Google側の一時的な障害の可能性があります。数分あけて1回だけ再取得し、同じ診断コードが続く場合は一時障害とは断定できないため、コードを開発担当へ共有してください。',
    NETWORK_EXCEPTION: '通信中に例外が発生しました（原因は断定できません）。再取得して同じ診断コードが続く場合は、コードを開発担当へ共有してください。',
    PARSE_FAILED: 'Googleから応答を受け取りましたが、内容を解釈できませんでした。原因は断定できません。診断コードを開発担当へ共有してください。',
    HTTP_403_UNCLASSIFIED: 'Googleが403を返しましたが、理由を判別できませんでした。API未有効化とも権限拒否とも断定できません。診断コードを開発担当へ共有してください。',
    HTTP_OTHER: 'Googleが想定外のHTTP応答を返しました。原因は断定できません。診断コードを開発担当へ共有してください。',
    UNKNOWN: '失敗の原因を判別できませんでした。原因は断定できません。診断コードを開発担当へ共有してください。'
  };

  function diagnostic_(e) {
    var stage = e && DIAG_STAGES_.indexOf(e.opsStage) !== -1 ? e.opsStage : null;
    var reason = e && typeof e.opsReason === 'string' && Object.prototype.hasOwnProperty.call(DIAG_ADVICE_, e.opsReason) ? e.opsReason : null;
    var http = e && typeof e.opsHttp === 'number' && isFinite(e.opsHttp) ? e.opsHttp : null;
    if (!stage || !reason) { stage = null; reason = 'UNKNOWN'; http = null; }
    var code = (stage ? stage + '/' : '') + reason + (http !== null ? '/' + http : '');
    return { code: code, stage: stage, reason: reason, http: http, advice: DIAG_ADVICE_[reason] };
  }

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

  /*
   * メモ（Issue #941）の既定の保存先（GAS）。保存先IDはサーバー側のScript Property（OPS_TASKS_SPREADSHEET_ID）だけ。
   * 端末から受け取らない。排他はスクリプトロック（取れなければ busy）。ロックが使えない場合は例外→保存せず失敗扱い。
   */
  function tasksGas_() {
    var props = PropertiesService.getScriptProperties();
    return {
      store: OpsTasksStore.create({
        getSpreadsheetId: function () { return props.getProperty('OPS_TASKS_SPREADSHEET_ID'); },
        setSpreadsheetId: function (id) { props.setProperty('OPS_TASKS_SPREADSHEET_ID', id); },
        getLedgerId: function () { return props.getProperty('OPS_SPREADSHEET_ID'); },
        fetch: function (url, options) { return UrlFetchApp.fetch(url, options); },
        getToken: function () { return ScriptApp.getOAuthToken(); }
      }),
      withLock: function (fn) {
        var lock = LockService.getScriptLock();
        if (!lock.tryLock(15000)) return { busy: true };
        try { return fn(); } finally { lock.releaseLock(); }
      }
    };
  }

  function load_(ctx) {
    var read;
    try {
      read = ctx.readLedger();
    } catch (e) {
      var code = e && FETCH_ERRORS_[e.opsCode] ? e.opsCode : 'FETCH_FAILED';
      var detail = code === 'SCHEMA_DUPLICATE' && e.opsColumns ? ': ' + e.opsColumns.join(', ') : '';
      var failure = error_(code, FETCH_ERRORS_[code] + detail);
      if (code === 'FETCH_FAILED') {
        failure.error.diagnostic = diagnostic_(e);
        Logger.log('ops: read failed ' + code + ' ' + failure.error.diagnostic.code);
      } else {
        Logger.log('ops: read failed ' + code);
      }
      return failure;
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
    /* メモ（Issue #941）。認可は上で済み。予約台帳（readLedger）には触れず、専用の保存先だけを使う。 */
    if (op === 'tasks_list' || op === 'task_save' || op === 'task_delete') {
      return OpsTasks.handle(request, context.tasks || tasksGas_(), nowMs);
    }
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

/* google.script.run から呼ぶ公開関数。予約（opsListReservations / opsGetReservation）は読み取り専用。 */
function opsListReservations(params) { return OpsApi.handle({ op: 'list', params: params }); }
function opsGetReservation(bookingId) { return OpsApi.handle({ op: 'detail', id: bookingId }); }

/* メモ（Issue #941）。毎回、所有者認可を通す。書込み先は専用スプレッドシートのTasks表に固定。 */
function opsListTasks() { return OpsApi.handle({ op: 'tasks_list' }); }
function opsSaveTask(payload) {
  var p = payload && typeof payload === 'object' ? payload : {};
  return OpsApi.handle({ op: 'task_save', input: p.input, expectedRevision: p.expectedRevision });
}
function opsDeleteTask(payload) {
  var p = payload && typeof payload === 'object' ? payload : {};
  return OpsApi.handle({ op: 'task_delete', taskId: p.taskId, expectedRevision: p.expectedRevision });
}
