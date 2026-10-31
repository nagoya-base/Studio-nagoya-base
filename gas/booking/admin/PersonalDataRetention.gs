/*
 * PersonalDataRetention.gs — Bookings台帳の個人情報を、通常保存期間（180日）の経過後に毎日自動で
 * 消去する運用基盤（Issue #680 PR-1。対象は`Bookings`シートのみ）。
 *
 * 【デプロイ先】Booking Admin（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）専用。公開Web App・
 * Webhookプロジェクトへは配布しない（削除実行APIを公開側へ置かない）。エディタ・時間主導トリガーから
 * 呼ぶ関数だけで、`BookingAdminWeb.gs`（管理画面）には配線していない。
 *
 * 【初期状態は無効】Script Propertiesの有効化フラグと方針バージョンが両方そろい、かつ同じ方針バージョンで
 * dry-runを実行済みのときだけ消去する。未設定・不正値・方針不一致では何も消さず、無効／設定不備として
 * 件数だけを記録する（無効状態の呼び出しを成功日時として扱わない）。
 * - PERSONAL_DATA_RETENTION_ENABLED: 'true'のときだけ有効（enablePersonalDataRetentionが設定）。
 * - PERSONAL_DATA_RETENTION_POLICY_VERSION: 有効化時に書く。コードのPOLICY_VERSIONと一致しなければ消去しない。
 * - PERSONAL_DATA_RETENTION_DRY_RUN_VERSION: dry-run実行時に書く。POLICY_VERSIONと一致しなければ有効化できない。
 * - PERSONAL_DATA_RETENTION_LAST_RUN / _LAST_SUCCESS_AT: 直近の実行結果（件数のみ。個人情報・ID・行内容なし）。
 * 対象列・起算点・除外条件を変えるときはPOLICY_VERSIONを更新する。更新すると有効化とdry-run確認がやり直しになる。
 *
 * 【消去の方式】対象列のセルだけを1セルずつ空にする。行全体や連続範囲は書き戻さない（読み込み済みの古い
 * 値で他の更新を巻き戻さないため）。行は削除せず、予約ID・日時・金額・状態・決済ID等は残す。残る情報は照合
 * 可能であり、匿名データではない。
 *
 * 【版の履歴は消えない】セルを空にしても、スプレッドシートの版の履歴には旧値が残る。履歴対策は編集権限を
 * 必要最小限にする運用で、消去の完了を意味しない。結果は「現行セルの消去」のみを表す（README参照）。
 *
 * 【排他と限界】消去はバッチ（BATCH_SIZE_行）ごとにAdminのスクリプトロックを取り、バッチ内で対象行を
 * 予約IDで読み直して同じ判定をやり直してから書く。ロックを共有するのは同じAdminプロジェクト内の処理
 * （予約確定・失効・取消・Webhook処理トリガー等）だけで、公開Web Appとはロックを共有できない。再読込は
 * 別プロジェクトとの原子的な排他にはならない（README「Issue #680」節の残存リスク参照）。
 *
 * 【保留】`RetentionHolds`シート（無ければdry-run・自動実行では作らない）に、予約ID・理由区分・担当・
 * 見直し期限を持つ保留を置ける。有効な保留（resolvedAtが空）がある予約は期限にかかわらず消さない。保留の
 * 解決後は、解決日時から180日を経過するまで消さない（通常の期限と遅い方）。見直し期限の超過は件数で
 * 通知するだけで、自動解除はしない。
 *
 * ログ・記録には件数と区分コードだけを出す。氏名・メール・予約ID・行番号・セル内容は出さない。
 */
'use strict';

var PersonalDataRetention = (function () {
  var POLICY_VERSION = '2026-10-31.1';
  var RETENTION_DAYS = 180;
  var DAY_MS_ = 24 * 60 * 60 * 1000;
  var RETENTION_MS_ = RETENTION_DAYS * DAY_MS_;

  var PROP_ENABLED_ = 'PERSONAL_DATA_RETENTION_ENABLED';
  var PROP_POLICY_VERSION_ = 'PERSONAL_DATA_RETENTION_POLICY_VERSION';
  var PROP_DRY_RUN_VERSION_ = 'PERSONAL_DATA_RETENTION_DRY_RUN_VERSION';
  var PROP_LAST_RUN_ = 'PERSONAL_DATA_RETENTION_LAST_RUN';
  var PROP_LAST_SUCCESS_AT_ = 'PERSONAL_DATA_RETENTION_LAST_SUCCESS_AT';

  var HANDLER_FUNCTION_ = 'purgeExpiredPersonalData';
  var TRIGGER_HOUR_ = 4;
  var TRIGGER_TIMEZONE_ = 'Asia/Tokyo';

  var BATCH_SIZE_ = 20;
  var MAX_ROWS_DEFAULT_ = 200;
  var TIME_BUDGET_MS_DEFAULT_ = 4 * 60 * 1000;
  var LOCK_TIMEOUT_MS_ = 10000;
  /* 有効化中に、これを超えて実行記録が無ければ「継続的な未実行」として知らせる。 */
  var STALE_RUN_MS_ = 36 * 60 * 60 * 1000;

  /*
   * 180日後に空にするBookingsの列（仕様案: Issue #680 コメント「対象列と起算点の仕様案」C節）。
   * 列名はBookingsSchemaの正本と照合し、列番号の固定や部分一致では消去しない。
   * checkoutAccessToken（決済開始の認証値）はこの段階では扱わない。
   */
  var BOOKINGS_ERASE_COLUMNS_ = [
    'name', 'email', 'phone', 'purpose', 'note',
    'paymentLinkSentTo',
    'lastMailErrorMessage', 'paymentLinkLastErrorMessage',
    'feeSettlementNote', 'feeRecoveryReason',
    'paymentLastErrorMessage', 'paymentRecoveryReason',
    'refundReason',
    'stripeCheckoutRequestSnapshot'
  ];

  var HOLDS_SHEET_ = 'RetentionHolds';
  var HOLDS_HEADERS_ = ['bookingId', 'reasonCode', 'owner', 'createdAt', 'reviewBy', 'resolvedAt'];
  var HOLD_REASONS_ = ['DISPUTE', 'INQUIRY', 'REFUND', 'UNPAID', 'OTHER'];

  var OPEN_FEE_SETTLEMENT_STATES_ = ['PENDING_CHARGE', 'PENDING_REFUND', 'PENDING_DECISION'];
  var KNOWN_FEE_SETTLEMENT_STATES_ = ['', 'SETTLED'].concat(OPEN_FEE_SETTLEMENT_STATES_);
  var OPEN_CHECKOUT_CANCEL_STATES_ = ['EXPIRE_REQUESTED', 'UNKNOWN', 'PAYMENT_RECEIVED'];
  var KNOWN_CHECKOUT_CANCEL_STATES_ = ['', 'EXPIRED', 'NO_SESSION'].concat(OPEN_CHECKOUT_CANCEL_STATES_);

  var VERDICT = {
    ELIGIBLE: 'ELIGIBLE',
    NOT_DUE: 'NOT_DUE',
    ALREADY_CLEAR: 'ALREADY_CLEAR',
    PENDING: 'PENDING',
    HELD: 'HELD',
    REVIEW: 'REVIEW'
  };

  var ISO_WITH_OFFSET_ = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function isBlank_(value) {
    return value === undefined || value === null || String(value).trim() === '';
  }

  /*
   * 起算点・保留に使う日時は、有効なDate、またはタイムゾーンを明示したISO 8601文字列だけを受け付ける。
   * 空欄・不正・タイムゾーン不明の文字列・数値は暗黙変換せずNaN（＝要確認）にする。
   */
  function parseStrictMillis_(value) {
    if (isDateLike_(value)) return value.getTime();
    if (typeof value === 'string' && ISO_WITH_OFFSET_.test(value.trim())) {
      var parsed = Date.parse(value.trim());
      return isNaN(parsed) ? NaN : parsed;
    }
    return NaN;
  }

  function increment_(map, key) {
    map[key] = (map[key] || 0) + 1;
  }

  function newCounts_() {
    return {
      scanned: 0, eligible: 0, notDue: 0, alreadyClear: 0, pending: 0,
      held: {}, review: {}, holdReviewOverdue: 0,
      erasedRows: 0, cellsCleared: 0, recheckSkipped: 0, failed: 0, truncated: false
    };
  }

  function indexOfColumns_(headers, names) {
    return names.map(function (name) { return headers.indexOf(name); });
  }

  /* シートのヘッダー行がBookingsSchemaの正本の先頭一致で、対象列をすべて含むかを返す。 */
  function checkBookingsHeader_(headerRow) {
    var expected = BookingsSchema.HEADERS;
    var actual = (headerRow || []).map(function (cell) { return String(cell === undefined || cell === null ? '' : cell); });
    while (actual.length > 0 && actual[actual.length - 1] === '') actual.pop();
    if (actual.length > expected.length) return { ok: false, code: 'HEADER_UNKNOWN_COLUMNS' };
    for (var i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) return { ok: false, code: 'HEADER_MISMATCH' };
    }
    for (var c = 0; c < BOOKINGS_ERASE_COLUMNS_.length; c++) {
      var index = expected.indexOf(BOOKINGS_ERASE_COLUMNS_[c]);
      if (index === -1) return { ok: false, code: 'HEADER_SCHEMA_MISSING_TARGET' };
      if (index >= actual.length) return { ok: false, code: 'HEADER_MISSING_TARGET' };
    }
    return { ok: true, columnCount: actual.length };
  }

  function rowToRecord_(row, columnCount) {
    var record = {};
    BookingsSchema.HEADERS.forEach(function (header, index) {
      record[header] = index < columnCount ? row[index] : '';
    });
    return record;
  }

  /*
   * 保留シートの行を予約IDごとにまとめる。resolvedAtが空の保留は有効（active）。resolvedAtが
   * あっても解釈できない場合は有効扱い（invalid）にして消さない。
   * 戻り値: { byBookingId: { id: { active, invalid, latestResolvedMs, overdue } }, overdueCount }
   */
  function summarizeHolds_(holdRows, nowMs) {
    var byBookingId = {};
    var overdueCount = 0;
    holdRows.forEach(function (row) {
      var id = String(row[0] === undefined || row[0] === null ? '' : row[0]).trim();
      if (!id) return;
      var entry = byBookingId[id] || (byBookingId[id] = { active: false, invalid: false, latestResolvedMs: NaN });
      if (isBlank_(row[5])) {
        entry.active = true;
        var reviewMs = parseStrictMillis_(row[4]);
        if (isNaN(reviewMs) || reviewMs < nowMs) overdueCount++;
        return;
      }
      var resolvedMs = parseStrictMillis_(row[5]);
      if (isNaN(resolvedMs)) {
        entry.active = true;
        entry.invalid = true;
        return;
      }
      if (isNaN(entry.latestResolvedMs) || resolvedMs > entry.latestResolvedMs) entry.latestResolvedMs = resolvedMs;
    });
    return { byBookingId: byBookingId, overdueCount: overdueCount };
  }

  /*
   * 1行の判定。純粋関数（シート・時刻に触れない）。
   * ctx: { nowMs, holdsByBookingId, duplicateIds }
   * 戻り値: { verdict, reason?, clearColumns? }。reasonは件数集計用の区分コード。
   */
  function classifyBookingRecord(record, ctx) {
    var bookingId = isBlank_(record.bookingId) ? '' : String(record.bookingId).trim();
    if (!bookingId) return { verdict: VERDICT.REVIEW, reason: 'INVALID_BOOKING_ID' };
    if (ctx.duplicateIds && ctx.duplicateIds[bookingId]) return { verdict: VERDICT.REVIEW, reason: 'DUPLICATE_BOOKING_ID' };

    var status = String(record.status === undefined || record.status === null ? '' : record.status).trim();
    if (status === Booking.STATUS.PENDING) return { verdict: VERDICT.PENDING, reason: 'PENDING_STATUS' };
    var basisColumn = status === Booking.STATUS.CONFIRMED ? 'endAt'
      : status === Booking.STATUS.CANCELLED ? 'cancelledAt'
        : status === Booking.STATUS.EXPIRED ? 'expiredAt' : '';
    if (!basisColumn) return { verdict: VERDICT.REVIEW, reason: 'UNKNOWN_STATUS' };

    var clearColumns = BOOKINGS_ERASE_COLUMNS_.filter(function (column) { return !isBlank_(record[column]); });
    if (clearColumns.length === 0) return { verdict: VERDICT.ALREADY_CLEAR, reason: 'ALREADY_CLEAR' };

    var basisMs = parseStrictMillis_(record[basisColumn]);
    if (isNaN(basisMs)) {
      return { verdict: VERDICT.REVIEW, reason: isBlank_(record[basisColumn]) ? 'BASIS_MISSING' : 'BASIS_INVALID' };
    }
    var dueMs = basisMs + RETENTION_MS_;

    var hold = ctx.holdsByBookingId ? ctx.holdsByBookingId[bookingId] : null;
    if (hold && !isNaN(hold.latestResolvedMs)) dueMs = Math.max(dueMs, hold.latestResolvedMs + RETENTION_MS_);
    if (ctx.nowMs < dueMs) return { verdict: VERDICT.NOT_DUE, reason: 'NOT_DUE' };

    if (hold && hold.invalid) return { verdict: VERDICT.HELD, reason: 'HOLD_RECORD_INVALID' };
    if (hold && hold.active) return { verdict: VERDICT.HELD, reason: 'HOLD_ACTIVE' };

    var dependency = checkDependencies_(record);
    if (dependency) return dependency;
    return { verdict: VERDICT.ELIGIBLE, reason: 'ELIGIBLE', clearColumns: clearColumns };
  }

  /* 期限を過ぎていても、決済・返金・精算・復旧が終わっていない予約は消さない。 */
  function checkDependencies_(record) {
    var paymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    if (paymentStatus === null) return { verdict: VERDICT.REVIEW, reason: 'PAYMENT_STATUS_UNKNOWN' };
    if (paymentStatus === Booking.PAYMENT_STATUS.CHECKOUT_PENDING || paymentStatus === Booking.PAYMENT_STATUS.REFUND_PENDING) {
      return { verdict: VERDICT.HELD, reason: 'PAYMENT_UNRESOLVED' };
    }
    if (!isBlank_(record.paymentAttemptId) && isBlank_(record.paymentAttemptResolvedAt)) {
      return { verdict: VERDICT.HELD, reason: 'PAYMENT_ATTEMPT_UNRESOLVED' };
    }
    if (!isBlank_(record.paymentRecoveryRequiredAt)) return { verdict: VERDICT.HELD, reason: 'PAYMENT_RECOVERY_OPEN' };
    if (!isBlank_(record.feeRecoveryRequiredAt)) return { verdict: VERDICT.HELD, reason: 'FEE_RECOVERY_OPEN' };
    if (!isBlank_(record.paymentLinkSendUnconfirmedAt) || !isBlank_(record.paymentLinkMetadataInconsistentAt)) {
      return { verdict: VERDICT.HELD, reason: 'PAYMENT_LINK_INCONSISTENT' };
    }

    var settlement = isBlank_(record.feeSettlementState) ? '' : String(record.feeSettlementState).trim();
    if (KNOWN_FEE_SETTLEMENT_STATES_.indexOf(settlement) === -1) return { verdict: VERDICT.REVIEW, reason: 'FEE_SETTLEMENT_STATE_UNKNOWN' };
    if (OPEN_FEE_SETTLEMENT_STATES_.indexOf(settlement) !== -1) return { verdict: VERDICT.HELD, reason: 'FEE_SETTLEMENT_PENDING' };

    var checkoutCancel = isBlank_(record.checkoutCancelState) ? '' : String(record.checkoutCancelState).trim();
    if (KNOWN_CHECKOUT_CANCEL_STATES_.indexOf(checkoutCancel) === -1) return { verdict: VERDICT.REVIEW, reason: 'CHECKOUT_CANCEL_STATE_UNKNOWN' };
    if (OPEN_CHECKOUT_CANCEL_STATES_.indexOf(checkoutCancel) !== -1) return { verdict: VERDICT.HELD, reason: 'CHECKOUT_CANCEL_UNRESOLVED' };

    /* 返金: 試行があるなら、Stripeが受け付けて返金完了日時が有効なときだけ解決済み。決定済み（全額・一部）なのに
       試行が始まっていない場合も未解決。 */
    var refundAttempt = isBlank_(record.refundAttemptState) ? '' : String(record.refundAttemptState).trim();
    var refundCompleted = !isNaN(parseStrictMillis_(record.refundedAt));
    if (refundAttempt) {
      if (!(refundAttempt === 'SUBMITTED' && refundCompleted)) return { verdict: VERDICT.HELD, reason: 'REFUND_UNRESOLVED' };
    } else if ((record.refundDecision === 'FULL' || record.refundDecision === 'PARTIAL') && !refundCompleted) {
      return { verdict: VERDICT.HELD, reason: 'REFUND_UNRESOLVED' };
    }
    return null;
  }

  function addToCounts_(counts, outcome) {
    switch (outcome.verdict) {
      case VERDICT.ELIGIBLE: counts.eligible++; break;
      case VERDICT.NOT_DUE: counts.notDue++; break;
      case VERDICT.ALREADY_CLEAR: counts.alreadyClear++; break;
      case VERDICT.PENDING: counts.pending++; break;
      case VERDICT.HELD: increment_(counts.held, outcome.reason); break;
      default: increment_(counts.review, outcome.reason);
    }
  }

  function findDuplicateIds_(rows) {
    var seen = {};
    var duplicates = {};
    rows.forEach(function (row) {
      var id = isBlank_(row[0]) ? '' : String(row[0]).trim();
      if (!id) return;
      if (seen[id]) duplicates[id] = true;
      seen[id] = true;
    });
    return duplicates;
  }

  function openSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  /* 保留シートの本体行を返す。シートが無ければ保留なし。ヘッダーが想定と異なれば保留を判定できないため例外。 */
  function readHoldRows_(spreadsheet) {
    var sheet = spreadsheet.getSheetByName(HOLDS_SHEET_);
    if (!sheet || sheet.getLastRow() < 1) return [];
    var values = sheet.getDataRange().getValues();
    for (var h = 0; h < HOLDS_HEADERS_.length; h++) {
      if (values[0][h] !== HOLDS_HEADERS_[h]) throw new Error('HOLDS_HEADER_MISMATCH');
    }
    return values.slice(1);
  }

  /* 読み取りだけで全行を判定する（dry-runと実行の共通部）。書き込みはしない。 */
  function evaluate_(nowMs, spreadsheet) {
    var sheet = spreadsheet.getSheetByName(BookingsSchema.SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 1) return { ok: false, code: 'BOOKINGS_SHEET_MISSING' };
    var values = sheet.getDataRange().getValues();
    var header = checkBookingsHeader_(values[0]);
    if (!header.ok) return { ok: false, code: header.code };
    var holdRows;
    try {
      holdRows = readHoldRows_(spreadsheet);
    } catch (error) {
      return { ok: false, code: 'HOLDS_SHEET_INVALID' };
    }
    var holds = summarizeHolds_(holdRows, nowMs);
    var rows = values.slice(1);
    var duplicateIds = findDuplicateIds_(rows);
    var counts = newCounts_();
    counts.holdReviewOverdue = holds.overdueCount;
    var candidates = [];
    rows.forEach(function (row) {
      counts.scanned++;
      var outcome = classifyBookingRecord(rowToRecord_(row, header.columnCount), {
        nowMs: nowMs, holdsByBookingId: holds.byBookingId, duplicateIds: duplicateIds
      });
      addToCounts_(counts, outcome);
      if (outcome.verdict === VERDICT.ELIGIBLE) candidates.push(String(row[0]).trim());
    });
    return { ok: true, counts: counts, candidates: candidates };
  }

  function getProperties_() {
    return PropertiesService.getScriptProperties();
  }

  function readConfig_() {
    var properties = getProperties_();
    var enabledRaw = properties.getProperty(PROP_ENABLED_);
    return {
      enabled: enabledRaw === 'true',
      enabledRaw: enabledRaw,
      policyVersion: properties.getProperty(PROP_POLICY_VERSION_),
      dryRunVersion: properties.getProperty(PROP_DRY_RUN_VERSION_)
    };
  }

  /* 実行してよい設定か。戻り値: 'OK' | 'DISABLED' | 'CONFIG_INVALID'。 */
  function gateStatus_(config) {
    if (config.enabledRaw === null || config.enabledRaw === undefined || config.enabledRaw === 'false') return 'DISABLED';
    if (config.enabledRaw !== 'true') return 'CONFIG_INVALID';
    if (config.policyVersion !== POLICY_VERSION || config.dryRunVersion !== POLICY_VERSION) return 'CONFIG_INVALID';
    return 'OK';
  }

  function summarizeForRecord_(status, at, counts) {
    var summary = { status: status, ranAt: at.toISOString(), policyVersion: POLICY_VERSION };
    if (counts) {
      Object.keys(counts).forEach(function (key) { summary[key] = counts[key]; });
    }
    return summary;
  }

  /* 実行結果の記録は付随処理。失敗しても消去結果は変えない（記録できなかったことだけLoggerへ残す）。 */
  function recordRun_(summary, markSuccess) {
    try {
      var properties = getProperties_();
      properties.setProperty(PROP_LAST_RUN_, JSON.stringify(summary));
      if (markSuccess) properties.setProperty(PROP_LAST_SUCCESS_AT_, summary.ranAt);
    } catch (error) {
      Logger.log('PersonalDataRetention: 実行結果の記録に失敗');
    }
    Logger.log('PersonalDataRetention: ' + JSON.stringify(summary));
  }

  function toNow_(now) {
    return isDateLike_(now) ? now : new Date();
  }

  /*
   * dry-run: 何も書かない（セル消去・マーカー更新・保留シート作成をしない）。対象件数・除外理由・要確認件数を返す。
   * ヘッダーを読めた場合に限り、確認済みの方針バージョンを記録する（有効化の前提）。
   */
  function dryRun(now) {
    var at = toNow_(now);
    var spreadsheet = openSpreadsheet_();
    var evaluation = evaluate_(at.getTime(), spreadsheet);
    if (!evaluation.ok) {
      var invalid = { status: 'SHEET_INVALID', code: evaluation.code, ranAt: at.toISOString(), policyVersion: POLICY_VERSION };
      Logger.log('PersonalDataRetention.dryRun: ' + JSON.stringify(invalid));
      return invalid;
    }
    var summary = summarizeForRecord_('DRY_RUN', at, evaluation.counts);
    try {
      getProperties_().setProperty(PROP_DRY_RUN_VERSION_, POLICY_VERSION);
    } catch (error) {
      summary.status = 'DRY_RUN_NOT_RECORDED';
    }
    Logger.log('PersonalDataRetention.dryRun: ' + JSON.stringify(summary));
    return summary;
  }

  /* 1セルずつ空にする。行全体・連続範囲は書き戻さない。戻り値: 空にしたセル数。 */
  function clearCells_(sheet, rowNumber, columns) {
    var cleared = 0;
    columns.forEach(function (column) {
      var columnNumber = BookingsSchema.HEADERS.indexOf(column) + 1;
      sheet.getRange(rowNumber, columnNumber, 1, 1).setValue('');
      cleared++;
    });
    return cleared;
  }

  /*
   * 1バッチ分（ロック保持下）。対象行を予約IDで読み直し、全体を再判定して、まだ対象のものだけ消す。
   * 戻り値: { stop?: code }。stopがあれば以降のバッチへ進まない。
   */
  function processBatch_(spreadsheet, ids, nowMs, counts) {
    var sheet = spreadsheet.getSheetByName(BookingsSchema.SHEET_NAME);
    if (!sheet) return { stop: 'BOOKINGS_SHEET_MISSING' };
    var values = sheet.getDataRange().getValues();
    var header = checkBookingsHeader_(values[0]);
    if (!header.ok) return { stop: header.code };
    var holdRows;
    try {
      holdRows = readHoldRows_(spreadsheet);
    } catch (error) {
      return { stop: 'HOLDS_SHEET_INVALID' };
    }
    var holds = summarizeHolds_(holdRows, nowMs);
    var rows = values.slice(1);
    var duplicateIds = findDuplicateIds_(rows);
    var rowNumberById = {};
    rows.forEach(function (row, index) {
      var id = isBlank_(row[0]) ? '' : String(row[0]).trim();
      if (id && !rowNumberById[id]) rowNumberById[id] = { rowNumber: index + 2, row: row };
    });

    for (var i = 0; i < ids.length; i++) {
      var found = rowNumberById[ids[i]];
      if (!found) { counts.recheckSkipped++; continue; }
      var outcome = classifyBookingRecord(rowToRecord_(found.row, header.columnCount), {
        nowMs: nowMs, holdsByBookingId: holds.byBookingId, duplicateIds: duplicateIds
      });
      if (outcome.verdict !== VERDICT.ELIGIBLE) { counts.recheckSkipped++; continue; }
      try {
        counts.cellsCleared += clearCells_(sheet, found.rowNumber, outcome.clearColumns);
        counts.erasedRows++;
      } catch (error) {
        counts.failed++;
        return { stop: 'WRITE_FAILED' };
      }
    }
    return {};
  }

  /*
   * 実行（時間主導トリガー・エディタ共通）。options: { maxRows, timeBudgetMs, clock }（テスト・調整用）。
   * status: DISABLED | CONFIG_INVALID | SHEET_INVALID | LOCK_TIMEOUT | STOPPED | OK | TRUNCATED | PARTIAL_FAILURE
   */
  function run(now, options) {
    var opts = options || {};
    var maxRows = opts.maxRows > 0 ? opts.maxRows : MAX_ROWS_DEFAULT_;
    var budgetMs = opts.timeBudgetMs > 0 ? opts.timeBudgetMs : TIME_BUDGET_MS_DEFAULT_;
    var clock = typeof opts.clock === 'function' ? opts.clock : function () { return Date.now(); };
    var startedAt = clock();
    var at = toNow_(now);
    var nowMs = at.getTime();

    var gate = gateStatus_(readConfig_());
    if (gate !== 'OK') {
      var gated = { status: gate };
      recordRun_(summarizeForRecord_(gate, at, null), false);
      return gated;
    }

    var spreadsheet = openSpreadsheet_();
    var evaluation = evaluate_(nowMs, spreadsheet);
    if (!evaluation.ok) {
      var invalid = summarizeForRecord_('SHEET_INVALID', at, null);
      invalid.code = evaluation.code;
      recordRun_(invalid, false);
      return invalid;
    }

    var counts = evaluation.counts;
    var targets = evaluation.candidates;
    if (targets.length > maxRows) {
      targets = targets.slice(0, maxRows);
      counts.truncated = true;
    }

    var status = 'OK';
    for (var start = 0; start < targets.length; start += BATCH_SIZE_) {
      if (clock() - startedAt >= budgetMs) { counts.truncated = true; break; }
      /* 停止フラグ・方針バージョンは各バッチの書き込み前にも確認する（新たな消去の開始を止める）。 */
      if (gateStatus_(readConfig_()) !== 'OK') { status = 'STOPPED'; break; }
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(LOCK_TIMEOUT_MS_)) { status = 'LOCK_TIMEOUT'; break; }
      var batchResult;
      try {
        batchResult = processBatch_(spreadsheet, targets.slice(start, start + BATCH_SIZE_), nowMs, counts);
      } finally {
        try { lock.releaseLock(); } catch (releaseError) { /* ロック未取得時は何もしない */ }
      }
      if (batchResult.stop) {
        status = batchResult.stop === 'WRITE_FAILED' ? 'PARTIAL_FAILURE' : 'SHEET_INVALID';
        break;
      }
    }
    if (status === 'OK' && counts.truncated) status = 'TRUNCATED';

    var summary = summarizeForRecord_(status, at, counts);
    recordRun_(summary, status === 'OK' || status === 'TRUNCATED');
    return summary;
  }

  /* 有効化: 同じ方針バージョンでdry-run済みのときだけ。設定を変えるだけでトリガーは作成・削除しない。 */
  function enable() {
    var config = readConfig_();
    if (config.dryRunVersion !== POLICY_VERSION) {
      throw new Error('PERSONAL_DATA_RETENTION_DRY_RUN_REQUIRED');
    }
    var properties = getProperties_();
    properties.setProperty(PROP_POLICY_VERSION_, POLICY_VERSION);
    properties.setProperty(PROP_ENABLED_, 'true');
    Logger.log('PersonalDataRetention: enabled policyVersion=' + POLICY_VERSION);
    return { enabled: true, policyVersion: POLICY_VERSION };
  }

  /* 停止: 日次トリガーは残し、整理処理だけを止める。進行中のバッチは巻き戻さない。 */
  function disable() {
    getProperties_().setProperty(PROP_ENABLED_, 'false');
    Logger.log('PersonalDataRetention: disabled');
    return { enabled: false };
  }

  function countHandlerTriggers_() {
    return ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === HANDLER_FUNCTION_;
    }).length;
  }

  /* 管理者が状態を確認する。個人情報・ID・行内容は含まない。 */
  function getStatus(now) {
    var at = toNow_(now);
    var config = readConfig_();
    var properties = getProperties_();
    var lastRun = null;
    var rawLastRun = properties.getProperty(PROP_LAST_RUN_);
    if (rawLastRun) {
      try { lastRun = JSON.parse(rawLastRun); } catch (error) { lastRun = { status: 'UNREADABLE' }; }
    }
    var lastSuccessAt = properties.getProperty(PROP_LAST_SUCCESS_AT_) || '';
    var lastRunMs = lastRun && lastRun.ranAt ? Date.parse(lastRun.ranAt) : NaN;
    var triggerCount = countHandlerTriggers_();
    var gate = gateStatus_(config);

    var attention = [];
    if (gate === 'CONFIG_INVALID') attention.push('CONFIG_INVALID');
    if (triggerCount === 0) attention.push('NO_TRIGGER');
    if (triggerCount > 1) attention.push('MULTIPLE_TRIGGERS');
    if (gate === 'OK') {
      if (isNaN(lastRunMs)) attention.push('NEVER_RUN');
      else if (at.getTime() - lastRunMs > STALE_RUN_MS_) attention.push('STALE_RUN');
      if (lastRun && ['PARTIAL_FAILURE', 'SHEET_INVALID', 'LOCK_TIMEOUT', 'CONFIG_INVALID', 'DISABLED'].indexOf(lastRun.status) !== -1) {
        attention.push('LAST_RUN_NOT_SUCCESSFUL');
      }
    }
    if (lastRun && lastRun.holdReviewOverdue > 0) attention.push('HOLD_REVIEW_OVERDUE');
    if (lastRun && lastRun.review && Object.keys(lastRun.review).length > 0) attention.push('REVIEW_ROWS_EXIST');

    return {
      codePolicyVersion: POLICY_VERSION,
      retentionDays: RETENTION_DAYS,
      gate: gate,
      enabled: config.enabled,
      configuredPolicyVersion: config.policyVersion || '',
      dryRunPolicyVersion: config.dryRunVersion || '',
      triggerCount: triggerCount,
      lastRun: lastRun,
      lastSuccessAt: lastSuccessAt,
      attention: attention
    };
  }

  function sanitizeOwner_(owner) {
    var text = String(owner === undefined || owner === null ? '' : owner).trim().slice(0, 40);
    return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  }

  /*
   * 保留を追加する（Adminのスクリプトロック下）。理由は区分コードのみで自由記述は持たない。
   * 保留シートが無ければここで作成する（dry-run・自動実行は作成しない）。
   */
  function addHold(bookingId, reasonCode, owner, reviewBy, now) {
    var at = toNow_(now);
    var id = String(bookingId === undefined || bookingId === null ? '' : bookingId).trim();
    if (!id) throw new Error('HOLD_INVALID_BOOKING_ID');
    if (HOLD_REASONS_.indexOf(reasonCode) === -1) throw new Error('HOLD_INVALID_REASON');
    var ownerText = sanitizeOwner_(owner);
    if (!ownerText) throw new Error('HOLD_OWNER_REQUIRED');
    var reviewMs = parseStrictMillis_(reviewBy);
    if (isNaN(reviewMs) || reviewMs <= at.getTime()) throw new Error('HOLD_REVIEW_BY_INVALID');
    if (!SpreadsheetRepository.findRowByBookingId(id)) throw new Error('HOLD_BOOKING_NOT_FOUND');

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) throw new Error('LOCK_UNAVAILABLE');
    try {
      var spreadsheet = openSpreadsheet_();
      var sheet = spreadsheet.getSheetByName(HOLDS_SHEET_);
      if (!sheet) sheet = spreadsheet.insertSheet(HOLDS_SHEET_);
      if (sheet.getLastRow() < 1) sheet.appendRow(HOLDS_HEADERS_);
      var values = sheet.getDataRange().getValues();
      for (var h = 0; h < HOLDS_HEADERS_.length; h++) {
        if (values[0][h] !== HOLDS_HEADERS_[h]) throw new Error('HOLDS_HEADER_MISMATCH');
      }
      for (var i = 1; i < values.length; i++) {
        if (String(values[i][0]).trim() === id && values[i][1] === reasonCode && isBlank_(values[i][5])) {
          return { added: false, alreadyHeld: true };
        }
      }
      sheet.appendRow([id, reasonCode, ownerText, at, new Date(reviewMs), '']);
    } finally {
      try { lock.releaseLock(); } catch (releaseError) { /* ロック未取得時は何もしない */ }
    }
    Logger.log('PersonalDataRetention: hold added reason=' + reasonCode);
    return { added: true, alreadyHeld: false };
  }

  /* 保留を解決する。解決日時から180日を経過するまで、その予約は消去対象にならない。戻り値: 解決した件数。 */
  function resolveHold(bookingId, now) {
    var at = toNow_(now);
    var id = String(bookingId === undefined || bookingId === null ? '' : bookingId).trim();
    if (!id) throw new Error('HOLD_INVALID_BOOKING_ID');
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) throw new Error('LOCK_UNAVAILABLE');
    var resolved = 0;
    try {
      var sheet = openSpreadsheet_().getSheetByName(HOLDS_SHEET_);
      if (!sheet || sheet.getLastRow() < 1) return { resolved: 0 };
      var values = sheet.getDataRange().getValues();
      for (var h = 0; h < HOLDS_HEADERS_.length; h++) {
        if (values[0][h] !== HOLDS_HEADERS_[h]) throw new Error('HOLDS_HEADER_MISMATCH');
      }
      var resolvedColumn = HOLDS_HEADERS_.indexOf('resolvedAt') + 1;
      for (var i = 1; i < values.length; i++) {
        if (String(values[i][0]).trim() === id && isBlank_(values[i][5])) {
          sheet.getRange(i + 1, resolvedColumn, 1, 1).setValue(at);
          resolved++;
        }
      }
    } finally {
      try { lock.releaseLock(); } catch (releaseError) { /* ロック未取得時は何もしない */ }
    }
    Logger.log('PersonalDataRetention: holds resolved count=' + resolved);
    return { resolved: resolved };
  }

  /* 日次トリガーを1本だけ作る補助。既存の同ハンドラのトリガーがあれば作らない。 */
  function createDailyTrigger() {
    var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
      return trigger.getHandlerFunction() === HANDLER_FUNCTION_;
    });
    if (existing.length > 0) {
      Logger.log('トリガーは既に存在します: ' + HANDLER_FUNCTION_);
      return existing[0];
    }
    return ScriptApp.newTrigger(HANDLER_FUNCTION_)
      .timeBased().everyDays(1).atHour(TRIGGER_HOUR_).inTimezone(TRIGGER_TIMEZONE_).create();
  }

  /* 廃止・障害対応用。通常の停止はdisable()（トリガーは残す）。 */
  function removeDailyTriggers() {
    var removed = 0;
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getHandlerFunction() === HANDLER_FUNCTION_) {
        ScriptApp.deleteTrigger(trigger);
        removed++;
      }
    });
    return { removed: removed };
  }

  return {
    POLICY_VERSION: POLICY_VERSION,
    RETENTION_DAYS: RETENTION_DAYS,
    HANDLER_FUNCTION: HANDLER_FUNCTION_,
    BOOKINGS_ERASE_COLUMNS: BOOKINGS_ERASE_COLUMNS_.slice(),
    HOLDS_SHEET: HOLDS_SHEET_,
    HOLDS_HEADERS: HOLDS_HEADERS_.slice(),
    HOLD_REASONS: HOLD_REASONS_.slice(),
    PROPERTY_KEYS: {
      ENABLED: PROP_ENABLED_,
      POLICY_VERSION: PROP_POLICY_VERSION_,
      DRY_RUN_VERSION: PROP_DRY_RUN_VERSION_,
      LAST_RUN: PROP_LAST_RUN_,
      LAST_SUCCESS_AT: PROP_LAST_SUCCESS_AT_
    },
    VERDICT: VERDICT,
    classifyBookingRecord: classifyBookingRecord,
    checkBookingsHeader: checkBookingsHeader_,
    dryRun: dryRun,
    run: run,
    enable: enable,
    disable: disable,
    getStatus: getStatus,
    addHold: addHold,
    resolveHold: resolveHold,
    createDailyTrigger: createDailyTrigger,
    removeDailyTriggers: removeDailyTriggers
  };
})();

/* 時間主導トリガーのハンドラ（引数不要）。now/optionsはテストから固定するための任意引数。 */
function purgeExpiredPersonalData(now, options) {
  var outcome = PersonalDataRetention.run(now, options);
  if (outcome.status === 'PARTIAL_FAILURE' || outcome.status === 'SHEET_INVALID') {
    throw new Error('purgeExpiredPersonalData: ' + outcome.status);
  }
  return outcome;
}

/* 以下はGASエディタから管理者が実行する関数（README「Issue #680」節）。 */
function dryRunPersonalDataRetention(now) {
  return PersonalDataRetention.dryRun(now);
}

function enablePersonalDataRetention() {
  return PersonalDataRetention.enable();
}

function disablePersonalDataRetention() {
  return PersonalDataRetention.disable();
}

function getPersonalDataRetentionStatus(now) {
  return PersonalDataRetention.getStatus(now);
}

function addPersonalDataRetentionHold(bookingId, reasonCode, owner, reviewBy, now) {
  return PersonalDataRetention.addHold(bookingId, reasonCode, owner, reviewBy, now);
}

function resolvePersonalDataRetentionHold(bookingId, now) {
  return PersonalDataRetention.resolveHold(bookingId, now);
}

/* GASエディタから、運用担当の単一アカウントで初回に1回だけ実行する補助関数。 */
function createPersonalDataRetentionTrigger() {
  return PersonalDataRetention.createDailyTrigger();
}

function removePersonalDataRetentionTriggers() {
  return PersonalDataRetention.removeDailyTriggers();
}
