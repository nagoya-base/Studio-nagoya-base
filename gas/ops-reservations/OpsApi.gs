/*
 * OpsApi.gs — バックエンドの要求処理（Issue #936 / #941）。通信方式に依存しない。
 * 予約台帳はコード上、読み取りのみ（#936。#941で権限は spreadsheets になり、OAuthレベルの読み取り専用ではない）。書込みはメモ（#941）の専用保存先と、
 * 管理者が明示実行する個別鍵の最終状態の保存（#971。runKeyFinalSave。予約台帳の accessKeyFinalStatus 列の1セルだけ）に限る。handle（画面・一覧・詳細・鍵状態）からは書かない。
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
    SCOPE_INSUFFICIENT: '承認済みの権限が不足しています。所有者本人のアカウントで専用URLを開き直し、Googleスプレッドシートの表示・編集の承認画面が出たら承認してください（#941で権限が「読み取り専用」から「スプレッドシートの表示・編集」へ変わっています。予約台帳へはコード上、読み取りしか行いません）。',
    EXCEPTION_AUTH_REQUIRED: 'GASの外部通信（script.external_request）またはスプレッドシート権限（表示・編集）の承認が済んでいない可能性があります。所有者本人で専用URLを開き直し、承認画面が出たら承認してください。',
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

  /*
   * 鍵状態（Issue #942）の接続設定（GAS）。接続先URLと共有トークンはサーバー側のScript Propertiesだけ。
   * どちらかが無ければ未接続（null）。値はログ・戻り値・画面へ出さない。
   */
  function accessConfigGas_() {
    var props = PropertiesService.getScriptProperties();
    var url = props.getProperty('OPS_ACCESS_STATUS_URL');
    var token = props.getProperty('OPS_ACCESS_STATUS_TOKEN');
    if (!url || !token) return null;
    return {
      url: url, token: token,
      fetch: function (u, options) { return UrlFetchApp.fetch(u, options); }
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

  /*
   * 鍵・案内の状況（Issue #942。読み取り専用）。予約の詳細とは別の要求で、取得に失敗しても詳細を壊さない。
   * 取得失敗・未接続・確認不能・不一致は keyStatus の中で別々に表す（エラー応答にしない）。予約自体の認可・不存在は詳細と同じ。
   */
  function keyStatus_(id, ctx, nowMs) {
    var key = typeof id === 'string' ? id.trim() : '';
    if (!key) return error_('INVALID_PARAMS', '予約IDが指定されていません。');
    var loaded = load_(ctx);
    if (!loaded.ok) return loaded;
    var n = loaded.normalized;
    if (n.duplicateIds.indexOf(key) !== -1) return error_('DUPLICATE_ID', '同じ予約IDの行が複数あるため表示できません。');
    var found = n.records.filter(function (r) { return r.bookingId === key; });
    if (found.length !== 1) return error_('NOT_FOUND', '該当する予約が見つかりません（空欄・不正な行は表示対象外です）。');
    var rec = found[0];
    var view;
    var cfg = null;
    try { cfg = ctx.accessConfig(); } catch (e) { cfg = undefined; }
    if (cfg === undefined) {
      view = OpsKeyStatus.unavailable('FETCH_FAILED', 'CONFIG_INVALID');
    } else if (!cfg) {
      view = OpsKeyStatus.unavailable('NOT_CONNECTED', null);
    } else if (!OpsKeyStatus.BOOKING_ID_RE.test(rec.bookingId)) {
      view = OpsKeyStatus.unavailable('UNVERIFIABLE', 'UNSUPPORTED_ID');
    } else {
      var got = OpsKeyStatus.fetchAccess(cfg, rec.bookingId);
      view = got.ok ? OpsKeyStatus.evaluate(rec, got.data, nowMs) : OpsKeyStatus.unavailable('FETCH_FAILED', got.reason);
      /* #971: Access が正常に NONE を返し、保存値が現在の台帳と一致する場合だけ、保存済みの過去の最終確認を補助表示する（読み取りのみ）。 */
      if (got.ok) {
        view.savedFinal = OpsKeyFinal.display(rec, got.data, nowMs);
        /* 予約直後・発行予定前の説明（#971）。Accessが正常にNONEで保存結果もないときだけ、「鍵の履歴なし（判別不可）」に代えて予約状態による説明を主表示にする。 */
        if (!view.savedFinal && view.lifecycle && view.lifecycle.code === 'NO_HISTORY') {
          var sched = OpsKeyFinal.scheduleView(rec, got.data, nowMs);
          if (sched) {
            view.lifecycle = { code: sched.code, label: sched.label + '：' + sched.note, tone: sched.tone, alert: false };
            /* 下段の判定の説明も、予約前の利用者が混乱しないよう「操作履歴がないことの説明」に区別する（判定そのものは変えない）。 */
            view.reasons = [{ code: 'NO_OPERATION_HISTORY_YET', text: '操作履歴がないことの説明: 鍵管理側にこの予約の操作記録がまだありません（予約状態・発行予定時刻に基づく説明は上の「個別鍵の状態」を参照）。未発行・失効済みの確認結果ではありません。' }];
          }
        }
      }
    }
    if (view.savedFinal === undefined) view.savedFinal = null;
    Logger.log('ops key_status ' + view.verdict.code + (view.failure ? ' ' + view.failure.code : ''));
    return { ok: true, contractVersion: OpsContract.CONTRACT_VERSION, fetchedAt: OpsContract.toIso(nowMs), bookingId: rec.bookingId, keyStatus: view };
  }

  /*
   * 売上集計の追加ソース（Issue #990 PR-B）の既定の読み取り（GAS）。同じ台帳ファイルの別シートを、金額・日付・識別子の列だけ読む。
   * シートが無い→'not_connected'、その他の失敗→'error'（どちらも0円として足さない）。
   */
  var REVENUE_SHEETS_ = {
    options: [{ key: 'rows', sheet: 'OptionOrders', columns: ['bookingId', 'amountJpy', 'paymentStatus', 'status'], dates: [] }],
    members: [
      { key: 'periods', sheet: 'MemberPeriods', columns: ['sourceType', 'sourceId', 'amount', 'paidAt'], dates: ['paidAt'] },
      { key: 'months', sheet: 'MemberMonths', columns: ['sourceType', 'sourceId', 'amount', 'paidAt'], dates: ['paidAt'] },
      { key: 'refunds', sheet: 'MemberRefunds', columns: ['sourceType', 'sourceId'], dates: [] }
    ]
  };
  function rowsOf_(values) {
    var header = (values && values[0]) || [];
    return (values || []).slice(1).map(function (row) {
      var o = {};
      header.forEach(function (h, i) { o[h] = row[i] === undefined ? '' : row[i]; });
      return o;
    });
  }
  function readRevenueSourcesGas_() {
    var id = PropertiesService.getScriptProperties().getProperty('OPS_SPREADSHEET_ID');
    function sourceOf_(specs) {
      var out = { state: 'ready' };
      for (var i = 0; i < specs.length; i++) {
        try {
          out[specs[i].key] = rowsOf_(OpsSource.readSheet({
            spreadsheetId: id,
            fetch: function (url, options) { return UrlFetchApp.fetch(url, options); },
            getToken: function () { return ScriptApp.getOAuthToken(); }
          }, { sheetName: specs[i].sheet, columns: specs[i].columns, dateColumns: specs[i].dates, required: specs[i].columns }));
        } catch (e) {
          return { state: e && e.opsCode === 'SHEET_NOT_FOUND' ? 'not_connected' : 'error' };
        }
      }
      return out;
    }
    return { options: sourceOf_(REVENUE_SHEETS_.options), members: sourceOf_(REVENUE_SHEETS_.members) };
  }

  function revenue_(params, ctx, nowMs) {
    var p = params && typeof params === 'object' ? params : {};
    var curYear = Number(OpsContract.formatJstDate(nowMs).slice(0, 4));
    var year = p.year === undefined || p.year === '' || p.year === null ? curYear : p.year;
    if (typeof year !== 'number' || Math.floor(year) !== year || year < 2020 || year > curYear + 1) return error_('INVALID_PARAMS', '対象年が不正です。');
    var loaded = load_(ctx);
    if (!loaded.ok) return loaded;
    var extra;
    try { extra = ctx.readRevenueSources(); } catch (e) { extra = { options: { state: 'error' }, members: { state: 'error' } }; }
    var result = OpsRevenue.compute({ bookings: loaded.normalized.records, options: extra && extra.options, members: extra && extra.members }, year, nowMs);
    Logger.log('ops revenue year=' + year + ' bookings=' + loaded.normalized.records.length + ' options=' + result.sources.options.state + ' members=' + result.sources.members.state);
    return {
      ok: true, contractVersion: OpsContract.CONTRACT_VERSION, fetchedAt: OpsContract.toIso(nowMs), revenue: result,
      /* 台帳の読めない行（除外）があれば集計は不完全。件数のみ返す。 */
      excludedRows: loaded.normalized.issues.filter(function (i) { return i.severity === 'error'; }).length
    };
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
    var full = { authenticate: authenticate, readLedger: context.readLedger || readLedgerGas_, accessConfig: context.accessConfig || accessConfigGas_, readRevenueSources: context.readRevenueSources || readRevenueSourcesGas_ };
    var nowMs = typeof context.nowMs === 'number' ? context.nowMs : Date.now();
    var op = request && request.op;
    if (op === 'list') return list_(request.params, full, nowMs);
    if (op === 'detail') return detail_(request.id, full, nowMs);
    if (op === 'key_status') return keyStatus_(request.id, full, nowMs);
    if (op === 'revenue') return revenue_(request.params, full, nowMs);
    /* メモ（Issue #941）。認可は上で済み。予約台帳（readLedger）には触れず、専用の保存先だけを使う。 */
    if (op === 'tasks_list' || op === 'task_save' || op === 'task_delete') {
      return OpsTasks.handle(request, context.tasks || tasksGas_(), nowMs);
    }
    return error_('INVALID_PARAMS', '要求の種類が不正です。');
  }

  /*
   * 個別鍵の最終状態の保存（Issue #971 Phase 1）。管理者が Apps Script エディタから明示実行する。handle からは到達できない。
   * 固定設定 OPS_KEY_FINAL_STATUS_WRITE が ON のときだけ動く。戻り値・ログは件数と固定コードだけ（予約ID・値を出さない）。
   * ctx は検証用の差し替え（authenticate / readLedger / accessConfig / fetchAccess / store / getFlag / withLock / nowMs）。
   */
  function runKeyFinalSave(ctx) {
    var context = ctx || {};
    var props = null;
    function prop_(name) { props = props || PropertiesService.getScriptProperties(); return props.getProperty(name); }
    var result = OpsKeyFinal.run({
      authenticate: context.authenticate || OpsAuth.createGasSessionAuthenticator(),
      getFlag: context.getFlag || function () { return prop_(OpsKeyFinal.FLAG_PROPERTY); },
      accessConfig: context.accessConfig || accessConfigGas_,
      readLedger: context.readLedger || readLedgerGas_,
      fetchAccess: context.fetchAccess || OpsKeyStatus.fetchAccess,
      store: context.store || OpsKeyFinalStore.create({
        spreadsheetId: prop_('OPS_SPREADSHEET_ID'),
        fetch: function (url, options) { return UrlFetchApp.fetch(url, options); },
        getToken: function () { return ScriptApp.getOAuthToken(); }
      }),
      withLock: context.withLock || function (fn) {
        var lock = LockService.getScriptLock();
        if (!lock.tryLock(15000)) return { busy: true };
        try { return fn(); } finally { lock.releaseLock(); }
      },
      offset: context.offset,
      nowMs: typeof context.nowMs === 'number' ? context.nowMs : Date.now()
    });
    Logger.log('ops key_final_save ' + result.code + (result.ok ? ' candidates=' + result.candidates + ' processed=' + result.processed + ' saved=' + result.saved + ' deferred=' + result.deferred + skippedLog_(result.skipped) + (result.stoppedBy ? ' stoppedBy=' + fixedCode_(result.stoppedBy) : '') : ''));
    return result;
  }

  /* 保存しなかった理由の「固定コード→件数」だけをログ用に整形する（#971）。コードの昇順・最大 SKIPPED_LOG_MAX 種類。
     固定コード（大文字英字・数字・アンダースコア）と整数の件数以外は出さない（予約ID・保存値・行番号等の混入を構造的に防ぐ）。 */
  var SKIPPED_LOG_MAX = 20;
  function skippedLog_(skipped) {
    if (!skipped || typeof skipped !== 'object') return '';
    var parts = Object.keys(skipped).filter(function (k) {
      return /^[A-Z][A-Z0-9_]{0,39}$/.test(k) && typeof skipped[k] === 'number' && Math.floor(skipped[k]) === skipped[k] && skipped[k] > 0 && skipped[k] <= 9999;
    }).sort().slice(0, SKIPPED_LOG_MAX).map(function (k) { return k + ':' + skipped[k]; });
    return parts.length ? ' skipped=' + parts.join(',') : '';
  }

  /*
   * 自動保存の入口（#971 Phase 2）。オーナーが Apps Script の「トリガー」画面で登録した15分間隔の時間主導トリガーから呼ぶ。
   * 保存処理は runKeyFinalSave（= OpsKeyFinal.run、offset 0・1回最大10件・保存条件は手動実行と同一）をそのまま使う。
   * - 設定 OPS_KEY_FINAL_STATUS_WRITE が ON 以外: 認可・台帳・Access に触れず即スキップ（例外にしない）。
   * - BUSY（手動実行と重複）: 次回再試行でよいので正常スキップ。
   * - それ以外の ok:false、および ok:true でも stoppedBy がある場合: 固定コードだけの例外を投げる
   *   （Apps Script 標準のトリガー失敗通知は、トリガー関数が例外で終わったときだけ送られるため）。
   * 例外文・ログに予約ID・氏名・保存値・行番号・URL・トークン・API生応答は含めない。
   * ctx は検証用の差し替え（runKeyFinalSave の ctx と同じ。authenticate 未指定ならトリガー用の認証器）。
   */
  var SCHEDULED_ERROR_PREFIX = 'OPS_KEY_FINAL_SCHEDULED_FAILED:';
  function fixedCode_(code) {
    return typeof code === 'string' && /^[A-Z_\/0-9]{1,60}$/.test(code) ? code : 'UNKNOWN';
  }
  function runKeyFinalSaveScheduled(ctx) {
    var context = Object.assign({}, ctx || {});
    context.offset = 0;
    context.authenticate = context.authenticate || OpsAuth.createGasTriggerAuthenticator();
    context.getFlag = context.getFlag || function () { return PropertiesService.getScriptProperties().getProperty(OpsKeyFinal.FLAG_PROPERTY); };
    if (context.getFlag() !== 'ON') {
      Logger.log('ops key_final_save SCHEDULED SKIPPED WRITE_DISABLED');
      return { ok: true, skipped: true, code: 'WRITE_DISABLED' };
    }
    var result = runKeyFinalSave(context);
    if (!result || result.ok !== true) {
      var code = fixedCode_(result && result.code);
      if (code === 'BUSY') return { ok: true, skipped: true, code: 'BUSY' };
      throw new Error(SCHEDULED_ERROR_PREFIX + code);
    }
    if (result.stoppedBy) throw new Error(SCHEDULED_ERROR_PREFIX + fixedCode_(result.stoppedBy));
    return result;
  }

  return { handle: handle, runKeyFinalSave: runKeyFinalSave, runKeyFinalSaveScheduled: runKeyFinalSaveScheduled };
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
/* 鍵・案内の状況（Issue #942）。読み取り専用。接続先・トークンは画面へ渡さない。 */
function opsGetKeyStatus(bookingId) { return OpsApi.handle({ op: 'key_status', id: bookingId }); }

/* 年商・月次の売上集計（Issue #990 PR-B）。読み取り専用。所有者認可は handle で毎回。 */
function opsGetRevenue(params) { return OpsApi.handle({ op: 'revenue', params: params }); }

/* 個別鍵の最終状態の保存（Issue #971 Phase 1）。管理者が Apps Script エディタから明示実行する（画面からは呼ばない・トリガーなし）。 */
function opsSaveKeyFinalStatuses() { return OpsApi.runKeyFinalSave(); }
/* 保存できない候補が先頭を占めるときの再実行用（状態を持たず、候補の11〜20件目・21〜30件目へ進む）。 */
function opsSaveKeyFinalStatusesNext10() { return OpsApi.runKeyFinalSave({ offset: 10 }); }
function opsSaveKeyFinalStatusesNext20() { return OpsApi.runKeyFinalSave({ offset: 20 }); }
/* 自動保存の入口（#971 Phase 2）。オーナーが Apps Script の「トリガー」画面で15分間隔の時間主導トリガーを1本だけ登録して呼ぶ。コードからはトリガーを作成・削除しない。 */
function opsSaveKeyFinalStatusesScheduled() { return OpsApi.runKeyFinalSaveScheduled(); }

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
