/*
 * StripeEventRepository.gs — Stripe Webhookイベントの永続的な処理台帳（Issue #341 PR-C
 * 「6. イベントの冪等性」）。FeeSettlementRepository.gs（日程変更精算の冪等性台帳）と
 * 同じ設計パターン：専用の「StripeEvents」シートへ、イベントごとに1行の処理状態を記録する。
 *
 * なぜ単にBookings台帳のlastStripeEventIdだけでは不十分か（Issue #341本文）:
 * - lastStripeEventIdは「予約1件に対して最後に確定した1つのイベントID」しか記録できず、
 *   過去のイベントの再送や、同じPaymentIntentに対する別イベント（例:
 *   checkout.session.completedとcheckout.session.async_payment_succeededが両方届く場合）を
 *   区別できない。
 * - 処理途中で失敗したイベント（Stripe再照会成功後・Bookings書き込み前にGASが例外で
 *   中断した等）を、「イベントIDだけは記録されている」状態と「本当に完了した」状態とで
 *   区別できないと、再送されたときに「受信済みだから処理不要」と誤って握りつぶしてしまう。
 *
 * 状態遷移（processingState）:
 * - RECEIVED: このeventIdの処理に着手した（claim済み）が、まだ最終結果が確定していない。
 *   claimedAt/claimCountで「いつ・何回目に着手したか」を追跡する。
 * - COMPLETED: 処理が完了した（決済状態の更新・予約自動確定の試行まで完了。自動確定
 *   自体が失敗してRecoveryへ回った場合も、Webhookイベントとしての処理は完了している
 *   ためCOMPLETEDとする。Stripeへは成功応答を返してよい）。
 * - IGNORED: このイベントに対して何も行う必要がなかった（対象外のイベント種別、
 *   まだ支払いが完了していないcheckout.session.completed等）。Stripeへは成功応答を
 *   返してよい。
 * - REJECTED: 識別子・金額の不一致等、構造的に処理できないと判断した（Recoveryへ記録
 *   済み）。再送されても結果は変わらないため、Stripeへは成功応答を返してよい
 *   （再送を促す必要がない）。
 *
 * 同一イベントが同時に2件届いた場合の排他はclaim()内のLockService.getScriptLock()で
 * 保証する（reservePaymentAttempt_と同じ「永続化のみの短時間Lock。外部Stripe API呼び出しは
 * Lockの外で行う」方針）。RECEIVEDのまま一定時間（staleAfterMs）を超えて放置された行は
 * 「前回の処理がクラッシュ・タイムアウトした」とみなし、再度claimして安全に再開できる
 * （StripeWebhookHandler.gsが呼ぶBookingRepository.applyPaymentStateUpdate/confirmBookingは
 * いずれもそれ自体が冪等なため、同じ処理を最初からやり直しても安全に収束する）。
 */
'use strict';

var StripeEventRepository = (function () {
  var SHEET_NAME_ = 'StripeEvents';
  var HEADERS_ = [
    'eventId', 'eventType', 'receivedAt', 'claimedAt', 'claimCount',
    'processingState', 'bookingId', 'paymentAttemptId', 'stripePaymentIntentId',
    'outcomeCode', 'outcomeMessage', 'updatedAt'
  ];

  var STATE = { RECEIVED: 'RECEIVED', COMPLETED: 'COMPLETED', IGNORED: 'IGNORED', REJECTED: 'REJECTED' };
  var TERMINAL_STATES_ = [STATE.COMPLETED, STATE.IGNORED, STATE.REJECTED];

  var CLAIM_LOCK_TIMEOUT_MS_ = 10000;
  /* RECEIVEDのまま放置されたら「前回の実行がクラッシュ/タイムアウトした」とみなし
     再claimしてよい猶予（既定5分）。GAS Web Appの1リクエストが現実的にこれより
     長く動き続けることは想定しない。 */
  var DEFAULT_STALE_AFTER_MS_ = 5 * 60 * 1000;

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  function ensureSheet_() {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) sheet = spreadsheet.insertSheet(SHEET_NAME_);
    if (sheet.getLastRow() < 1) sheet.appendRow(HEADERS_);
    return sheet;
  }

  function rowToRecord_(row) {
    var record = {};
    HEADERS_.forEach(function (header, index) { record[header] = row[index]; });
    return record;
  }

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function toMillis_(value) {
    if (isDateLike_(value)) return value.getTime();
    var parsed = new Date(value).getTime();
    return isNaN(parsed) ? NaN : parsed;
  }

  /* eventIdで1行検索する。見つからなければnull。Lockの外からも使える読み取り専用ヘルパー
     （claim()自身はLock内で改めて検索し直す。ここでの結果は参考情報にのみ使うこと）。 */
  function findByEventId(eventId) {
    var sheet = ensureSheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === eventId) {
        return { rowNumber: i + 1, record: rowToRecord_(values[i]) };
      }
    }
    return null;
  }

  /*
   * このeventIdの処理に着手してよいかを排他的に判定・記録する。
   * 戻り値:
   * - { outcome: 'CLAIMED', rowNumber, record, isRetry }: 処理を進めてよい
   *   （isRetry:trueは、前回RECEIVEDのまま停止していた行を再claimしたことを示す）。
   * - { outcome: 'ALREADY_TERMINAL', rowNumber, record }: 既に最終結果が確定済み。
   *   呼び出し元は再処理せず、記録済みの結果をそのまま返してよい。
   * - { outcome: 'IN_PROGRESS', rowNumber, record }: 別の呼び出し（同時到達した同一
   *   イベントの並行配信）が処理中の可能性が高い。呼び出し元は処理を行わず、
   *   Stripe側の自動再送に委ねる（エラー応答を返し、再送を待つ）。
   */
  function claim(eventId, eventType, now, staleAfterMs) {
    if (!eventId) {
      throw new Error('eventIdを指定してください。');
    }
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var effectiveStaleAfterMs = typeof staleAfterMs === 'number' && staleAfterMs > 0 ? staleAfterMs : DEFAULT_STALE_AFTER_MS_;

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CLAIM_LOCK_TIMEOUT_MS_)) {
      return { outcome: 'LOCK_TIMEOUT' };
    }
    try {
      var sheet = ensureSheet_();
      var values = sheet.getDataRange().getValues();
      for (var i = 1; i < values.length; i++) {
        if (values[i][0] === eventId) {
          var rowNumber = i + 1;
          var record = rowToRecord_(values[i]);
          if (TERMINAL_STATES_.indexOf(record.processingState) !== -1) {
            return { outcome: 'ALREADY_TERMINAL', rowNumber: rowNumber, record: record };
          }
          /* processingState === RECEIVED（前回の試行が最終状態へ到達していない）。 */
          var claimedAtMillis = toMillis_(record.claimedAt);
          var ageMillis = isNaN(claimedAtMillis) ? Infinity : effectiveNow.getTime() - claimedAtMillis;
          if (ageMillis < effectiveStaleAfterMs) {
            return { outcome: 'IN_PROGRESS', rowNumber: rowNumber, record: record };
          }
          var nextClaimCount = (Number(record.claimCount) || 0) + 1;
          var claimedAtIndex = HEADERS_.indexOf('claimedAt');
          sheet.getRange(rowNumber, claimedAtIndex + 1, 1, 2).setValues([[effectiveNow, nextClaimCount]]);
          record.claimedAt = effectiveNow;
          record.claimCount = nextClaimCount;
          return { outcome: 'CLAIMED', rowNumber: rowNumber, record: record, isRetry: true };
        }
      }
      /* 見つからなかった: 新規イベント。RECEIVEDとして1行追加する。 */
      var newRow = [
        eventId, eventType || '', effectiveNow, effectiveNow, 1,
        STATE.RECEIVED, '', '', '', '', '', effectiveNow
      ];
      sheet.appendRow(newRow);
      return {
        outcome: 'CLAIMED',
        rowNumber: sheet.getLastRow(),
        record: rowToRecord_(newRow),
        isRetry: false
      };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * claim()が返したrowNumberに対して最終結果を記録する。processingState〜updatedAtの
   * 6列（HEADERS_上で連続）を1回のsetValuesで更新する（FeeSettlementRepository.markApplied
   * と同じ「複数列の部分更新を必ず1回のRange.setValuesにまとめる」方針。処理結果と
   * 識別子だけが更新され、statusだけ新しいが識別子は古いという半端な状態を防ぐ）。
   *
   * fields: { processingState（必須。STATE定数のいずれか）, bookingId?, paymentAttemptId?,
   *   stripePaymentIntentId?, outcomeCode?, outcomeMessage? }
   *
   * この呼び出し自体が失敗した場合（Sheets書き込みエラー）、呼び出し元
   * （StripeWebhookHandler.gs）はStripeへ成功応答を返してはならない（Issue #341本文
   * 「永続化できていないイベントを成功扱いにしない」）。行はRECEIVEDのまま残るため、
   * 次回の配信でclaim()が（staleAfterMs経過後に）安全に再claimできる。
   */
  function finalize(rowNumber, fields, now) {
    if (TERMINAL_STATES_.indexOf(fields.processingState) === -1) {
      throw new Error('finalizeにはCOMPLETED/IGNORED/REJECTEDのいずれかを指定してください: ' + fields.processingState);
    }
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var sheet = ensureSheet_();
    var startIndex = HEADERS_.indexOf('processingState');
    var values = [
      fields.processingState,
      fields.bookingId || '',
      fields.paymentAttemptId || '',
      fields.stripePaymentIntentId || '',
      fields.outcomeCode || '',
      fields.outcomeMessage || '',
      effectiveNow
    ];
    sheet.getRange(rowNumber, startIndex + 1, 1, values.length).setValues([values]);
  }

  return {
    STATE: STATE,
    findByEventId: findByEventId,
    claim: claim,
    finalize: finalize
  };
})();
