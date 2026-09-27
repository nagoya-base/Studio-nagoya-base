/*
 * BookingRefund.gs — Booking Adminの「取消・返金」「返金状態を照会」「決済Recoveryの解消」
 * （Issue #341 PR-D）。Booking Adminプロジェクト専用（公開Web App・Webhookプロジェクトには
 * 配布しない）。
 *
 * 【返金額の決め方】キャンセル料・返金額はシステムが自動計算しない。管理者が取消のたびに
 * 「全額返金（FULL）／一部返金（PARTIAL・金額入力）／返金なし（NONE）」を選び、理由を
 * 入力する（オーナー確認済み。Issue #344の日程変更精算と同じ「実装で返金額を決めない」方針）。
 * 一部返金の上限はCheckout Session発行時点の請求額スナップショット（stripeAmount）。
 * 1予約につき成立する返金は1回まで（返金済み・返金手続き中の予約へ追加の返金はしない）。
 *
 * 【二重返金を防ぐ設計（PR-BのCheckout Session発行と同じパターン）】
 * 1. Phase 0（Lockなし）: 台帳を読み、Stripeへ照会する（PaymentIntentが入金済みで台帳の
 *    金額と一致すること・このPaymentIntentに有効な返金がまだ無いこと）。Dashboard等で
 *    既に返金されていれば新しい返金を発行せず要復旧にする。
 * 2. Phase 1（Script Lock）: 最新行を再読込してPhase 0時点から決済・返金の列が変わって
 *    いないことを確認し、予約が有効なら既存の取消処理（Calendar削除→CANCELLED）を行い、
 *    返金試行ID（refundAttemptId＝Stripeへ渡すIdempotency-Key）と返金額を台帳へ
 *    永続化してからLockを解放する。
 * 3. Phase 2（Lockなし）: Stripe返金APIを呼ぶ（Script LockはStripeの応答待ちの間保持しない）。
 * 4. Phase 3（Script Lock）: 最新行を再読込し、refundAttemptIdが自分の試行のままである
 *    ことを確認してから結果を保存する。
 *
 * - 二重クリック・再送信: 2回目の呼び出しはPhase 0で「返金試行が進行中（RESERVED/UNKNOWN）」
 *   を検知してREFUND_IN_PROGRESSを返し、Stripeを呼ばない。Phase 0の後に並行して1回目が
 *   Phase 1を終えていた場合も、2回目のPhase 1が列の変化を検知してCONCURRENT_MODIFICATION
 *   で止まる（Phase 1はScript Lockで直列化される）。
 * - Stripeの応答不明（タイムアウト・5xx・409等）: 未返金と決めつけて新しい返金試行IDを
 *   発行しない。試行をUNKNOWNとして記録し、同じPaymentIntentの返金一覧からmetadata.
 *   refundAttemptIdが一致する返金を照会して採用する。見つからない場合は「返金状態を照会」
 *   （reconcileRefund）で**同じ返金試行ID（Idempotency-Key）・同じ金額**で再送する。
 *   RESERVEDのまま残った試行（GASの実行が途中で止まった等）は、最初の呼び出しが確実に
 *   終了している（Apps Scriptの最大実行時間6分＋余裕）まで照会のみを行い、再送しない。
 * - Stripeで返金成功後に台帳更新が失敗した場合: 返金の事実（stripeRefundId）をRecoveryへ
 *   記録し、要復旧ゲートを立てる（入金・返金・予約の事実は消さない）。台帳が回復した後、
 *   「返金状態を照会」で返金一覧から同じ返金を見つけて台帳へ記録する。
 *
 * 【返金の完了】Stripeの返金がsucceededになった時点でpaymentStatus=refundedとし、利用者へ
 * 返金完了メール（BookingMailer.sendRefundedMailForBooking）を送る。pendingの間は
 * refund_pendingのまま「返金完了」とは案内しない。取消メールには返金手続きの開始・返金なし・
 * 別途連絡のいずれかだけを書き、返金完了とは書かない（BookingMailTemplates参照）。
 *
 * 【Recoveryの解消】resolvePaymentRecoveryは、Stripeの実際の状態（PaymentIntent・返金一覧）
 * と台帳が整合していることを確認できた場合にのみ要復旧ゲートを外す。表示しただけで
 * 自動返金・自動確定・ゲート解除は行わない。
 */
'use strict';

var BookingRefund = (function () {
  var LOCK_TIMEOUT_MS_ = 10000;
  /* Phase 3（Stripe応答後の結果保存）は、Stripe側で既に起きた事実を記録する処理のため、
     一時的な混雑で諦めにくいよう長めに待つ。 */
  var RESULT_LOCK_TIMEOUT_MS_ = 30000;
  /* RESERVEDのまま残った試行へ同じIdempotency-Keyで再送してよいまでの時間
     （Apps Scriptの1実行の最大時間6分＋余裕1分。StripeWebhookProcessor.gsと同じ考え方）。
     それまでは照会のみを行う。 */
  var RESERVED_IN_FLIGHT_MS_ = 7 * 60 * 1000;
  var MAX_TEXT_LENGTH_ = 500;

  var DECISION = { FULL: 'FULL', PARTIAL: 'PARTIAL', NONE: 'NONE' };
  var ATTEMPT_STATE = { RESERVED: 'RESERVED', SUBMITTED: 'SUBMITTED', UNKNOWN: 'UNKNOWN', FAILED: 'FAILED' };
  var PS = Booking.PAYMENT_STATUS;
  var ACTIVE_REFUND_STATUSES_ = ['pending', 'requires_action', 'succeeded'];

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function describeError_(error) {
    return String((error && error.message) || error);
  }

  function fail_(code, message, extra) {
    return Object.assign({ success: false, error: { code: code, message: message } }, extra || {});
  }

  function isActiveRefund_(refund) {
    return ACTIVE_REFUND_STATUSES_.indexOf(refund.status) !== -1;
  }

  function withLock_(timeoutMs, fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(timeoutMs)) {
      return { lockTimeout: true };
    }
    try {
      return { value: fn() };
    } finally {
      lock.releaseLock();
    }
  }

  function lockTimeoutResponse_() {
    return fail_('LOCK_TIMEOUT', '一時的に混み合っています。もう一度お試しください。');
  }

  function findRecord_(bookingId) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    return found ? found.record : null;
  }

  /* 比較用に正規化した値（Date値は時刻、それ以外は文字列）。 */
  function key_(value) {
    if (isDateLike_(value)) return 'd:' + value.getTime();
    return 's:' + String(value === undefined || value === null ? '' : value);
  }

  /* Phase 0で読んだ行と、Lock取得後に再読込した行で、決済・返金・予約状態の列が
     変わっていないか（変わっていれば並行操作があったとみなして止める）。 */
  var SNAPSHOT_FIELDS_ = [
    'status', 'paymentStatus', 'stripePaymentIntentId', 'stripeAmount', 'stripeRefundId',
    'refundAttemptId', 'refundAttemptState', 'refundDecision', 'paymentRecoveryRequiredAt',
    /* PR-Dレビュー対応・1回目: 未入金の取消でCheckout Sessionを失効させるため、決済試行・
       Sessionの列も比較対象にする（Booking Web Appが並行して新しいSessionを発行していないか）。 */
    'paymentAttemptId', 'paymentAttemptResolvedAt', 'stripeCheckoutSessionId',
    /* PR-Dレビュー対応・2回目: 取消後の決済URL失効の記録も並行操作の検知に含める。 */
    'checkoutCancelState'
  ];

  function sameSnapshot_(a, b) {
    return SNAPSHOT_FIELDS_.every(function (field) { return key_(a[field]) === key_(b[field]); });
  }

  function concurrentModification_() {
    return fail_('CONCURRENT_MODIFICATION', '確認中に予約・決済の状態が変わりました。画面を更新して内容を確認してから、もう一度操作してください。');
  }

  function sanitize_(message) {
    return BookingMailer.sanitizeErrorMessage(String(message || '')).slice(0, MAX_TEXT_LENGTH_);
  }

  /* Recovery記録（best effort）。gate=trueの場合は要復旧ゲート（paymentRecoveryRequiredAt）も
     立てる。Lock保持中に呼ぶこと（Lockを取れなかった場合の記録はrecordRecoveryOnly_のみ）。 */
  function recordRecovery_(bookingId, record, failureType, message, now, gate) {
    var safeMessage = sanitize_(message);
    try {
      var fields = { paymentLastErrorAt: now, paymentLastErrorMessage: safeMessage };
      if (gate) {
        fields.paymentRecoveryRequiredAt = now;
        fields.paymentRecoveryReason = failureType + ': ' + safeMessage;
      }
      SpreadsheetRepository.updateBookingFields(bookingId, fields);
    } catch (writeError) {
      Logger.log('BookingRefund: 要対応フラグの記録に失敗しました: ' + bookingId + ' ' + failureType + ' ' + sanitize_(describeError_(writeError)));
    }
    recordRecoveryOnly_(bookingId, record, failureType, safeMessage, now);
  }

  function recordRecoveryOnly_(bookingId, record, failureType, message, now) {
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: failureType,
        occurredAt: now,
        calendarEventId: (record && record.calendarEventId) || '',
        status: (record && record.status) || '',
        errorMessage: sanitize_(message),
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('BookingRefund: Recovery記録に失敗しました: ' + bookingId + ' ' + failureType + ' ' + sanitize_(describeError_(recoveryError)));
    }
  }

  function gateWithLock_(bookingId, record, failureType, message, now) {
    var locked = withLock_(LOCK_TIMEOUT_MS_, function () {
      recordRecovery_(bookingId, findRecord_(bookingId) || record, failureType, message, now, true);
    });
    if (locked.lockTimeout) {
      recordRecoveryOnly_(bookingId, record, failureType, message + '（要復旧フラグはLock混雑のため未設定）', now);
    }
    BookingAdminAlerts.notifyRefundNeedsAttention(bookingId, failureType, message);
  }

  function generateRefundAttemptId_(bookingId) {
    var uuidPart = String(Utilities.getUuid() || '').replace(/-/g, '').slice(0, 12).toUpperCase();
    return 'RFD-' + bookingId + '-' + uuidPart;
  }

  function isFinitePositiveInteger_(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && Math.round(value) === value;
  }

  /* 返金試行が進行中（結果を台帳へ記録し終えていない）かどうか。 */
  function isRefundInFlight_(record) {
    if (!record.refundAttemptId) return false;
    var state = record.refundAttemptState;
    if (state === ATTEMPT_STATE.RESERVED || state === ATTEMPT_STATE.UNKNOWN) return true;
    /* SUBMITTEDなのにpaidのまま＝返金は受け付けられたが台帳のpaymentStatus更新が途中で
       失敗した。新しい返金を出さず、照会で記録を完了させる。 */
    if (state === ATTEMPT_STATE.SUBMITTED && Booking.normalizePaymentStatus(record.paymentStatus) === PS.PAID) return true;
    /* 状態が空・未知の値でも試行IDがある＝予約の書き込みが途中で失敗した可能性。 */
    return state !== ATTEMPT_STATE.SUBMITTED && state !== ATTEMPT_STATE.FAILED;
  }

  function normalizeRequest_(request) {
    var r = request || {};
    var decision = String(r.decision || '');
    if ([DECISION.FULL, DECISION.PARTIAL, DECISION.NONE].indexOf(decision) === -1) {
      return { error: fail_('INVALID_REFUND_DECISION', '返金方法（全額返金／一部返金／返金なし）を選択してください。') };
    }
    var reason = typeof r.reason === 'string' ? r.reason.trim() : '';
    if (!reason || reason.length > MAX_TEXT_LENGTH_) {
      return { error: fail_('INVALID_REASON', '取消・返金の理由を' + MAX_TEXT_LENGTH_ + '文字以内で入力してください。') };
    }
    var amount = null;
    if (decision === DECISION.PARTIAL) {
      amount = Number(r.amountJpy);
      if (!isFinitePositiveInteger_(amount)) {
        return { error: fail_('INVALID_REFUND_AMOUNT', '一部返金の金額は1円以上の整数で入力してください。') };
      }
    }
    return { decision: decision, reason: reason, amountJpy: amount };
  }

  function buildRefundParams_(bookingId, record) {
    return {
      paymentIntentId: record.stripePaymentIntentId,
      amountJpy: Number(record.refundAmount),
      bookingId: bookingId,
      refundAttemptId: record.refundAttemptId
    };
  }

  /*
   * 新しい返金試行の前にStripeの実際の状態を確認する（Lockなし）。
   * 戻り値: null（問題なし）またはレスポンス（呼び出し元はそのまま返す）。
   */
  function precheckStripe_(bookingId, record, stripeConfig, now) {
    var piResult = StripeGateway.retrievePaymentIntent(stripeConfig, record.stripePaymentIntentId);
    if (!piResult.ok) {
      return fail_('STRIPE_LOOKUP_FAILED', 'Stripeで決済状況を確認できませんでした。時間をおいてもう一度お試しください（台帳は変更していません）。');
    }
    var pi = piResult.paymentIntent;
    if (pi.id !== record.stripePaymentIntentId || pi.status !== 'succeeded' ||
        Number(pi.amountReceived) !== Number(record.stripeAmount) || pi.currency !== String(record.stripeCurrency || '').toUpperCase()) {
      var mismatch = 'Stripe上のPaymentIntent（status=' + pi.status + ', amount_received=' + pi.amountReceived +
        ', currency=' + pi.currency + '）が台帳の入金記録と一致しないため、返金を実行しませんでした。';
      gateWithLock_(bookingId, record, 'REFUND_PRECHECK_MISMATCH', mismatch, now);
      return fail_('REFUND_PRECHECK_MISMATCH', mismatch + ' Stripe管理画面と台帳を確認してください。');
    }
    var listResult = StripeGateway.listRefundsForPaymentIntent(stripeConfig, record.stripePaymentIntentId);
    if (!listResult.ok) {
      return fail_('STRIPE_LOOKUP_FAILED', 'Stripeで既存の返金を確認できませんでした。時間をおいてもう一度お試しください（台帳は変更していません）。');
    }
    var active = listResult.refunds.filter(isActiveRefund_);
    if (active.length > 0) {
      /* 事前照会の間に、別の操作（二重クリック等）がこの予約の返金試行を先に実行していた
         場合は、台帳に記録されたその返金試行の返金であり「台帳にない返金」ではない。
         要対応にせず、並行操作として止める（呼び出し元は画面を更新して結果を確認する）。 */
      var latest = findRecord_(bookingId);
      var ownConcurrent = !!latest && !!latest.refundAttemptId && latest.refundAttemptId !== record.refundAttemptId &&
        active.every(function (r) { return r.metadata && r.metadata.refundAttemptId === latest.refundAttemptId; });
      if (ownConcurrent) return concurrentModification_();
      var external = 'このPaymentIntentには既に有効な返金（' + active.map(function (r) { return r.id + ':' + r.status; }).join(', ') +
        '）がStripe上に存在します。台帳に記録の無い返金のため、新しい返金を実行しませんでした。';
      gateWithLock_(bookingId, record, 'REFUND_EXTERNAL_DETECTED', external, now);
      return fail_('REFUND_EXTERNAL_DETECTED', external + ' Stripe管理画面で確認してください。');
    }
    return null;
  }

  /*
   * cancelWithRefund(bookingId, request, now) — Booking Adminの「取消・返金」。
   * request: { decision: 'FULL'|'PARTIAL'|'NONE', amountJpy（PARTIALのみ）, reason }
   */
  function cancelWithRefund(bookingId, request, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    if (!bookingId) return fail_('INVALID_BOOKING_ID', 'bookingIdを指定してください。');
    var req = normalizeRequest_(request);
    if (req.error) return req.error;

    var snapshot = findRecord_(bookingId);
    if (!snapshot) return fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId);
    if (!Booking.isStripeCheckoutBooking(snapshot)) {
      return fail_('NOT_STRIPE_BOOKING', 'Stripe Checkoutで決済した予約ではありません。通常の「キャンセル」を使ってください。');
    }
    var paymentStatus = Booking.normalizePaymentStatus(snapshot.paymentStatus);
    if (paymentStatus === null) {
      return fail_('UNKNOWN_PAYMENT_STATUS', '決済状態が不明なため操作できません。Recoveryを確認してください。');
    }
    if (isRefundInFlight_(snapshot)) {
      return fail_('REFUND_IN_PROGRESS', 'この予約の返金処理が進行中、または結果の確認待ちです。「返金状態を照会」で結果を確認してください（新しい返金は実行しません）。');
    }
    if (paymentStatus === PS.REFUND_PENDING || paymentStatus === PS.REFUNDED) {
      return fail_('REFUND_ALREADY_REQUESTED', paymentStatus === PS.REFUNDED
        ? 'この予約は返金済みです。追加の返金は行えません。'
        : 'この予約は返金手続き中です。「返金状態を照会」で結果を確認してください。');
    }
    if (paymentStatus !== PS.PAID) {
      if (req.decision !== DECISION.NONE) {
        return fail_('NOT_PAID', '入金が確認されていない予約のため返金できません（決済状態: ' + paymentStatus + '）。「返金なし」を選ぶと取消のみ行います。');
      }
      return cancelUnpaidCheckout_(bookingId, snapshot, req, effectiveNow);
    }
    if (req.decision === DECISION.NONE) {
      return cancelOnly_(bookingId, snapshot, req, effectiveNow, true);
    }

    var stripeAmount = Number(snapshot.stripeAmount);
    if (!snapshot.stripePaymentIntentId || !isFinitePositiveInteger_(stripeAmount)) {
      return fail_('PAYMENT_EVIDENCE_MISSING', '台帳にPaymentIntentまたは請求額の記録が無いため返金できません。Recoveryを確認してください。');
    }
    var amount = req.decision === DECISION.FULL ? stripeAmount : req.amountJpy;
    if (amount > stripeAmount) {
      return fail_('INVALID_REFUND_AMOUNT', '返金額は請求額（' + stripeAmount + '円）以下で入力してください。');
    }
    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.secretKey) {
      return fail_('STRIPE_NOT_CONFIGURED', 'Stripeの秘密鍵が設定されていないため返金できません（台帳は変更していません）。');
    }

    var precheckError = precheckStripe_(bookingId, snapshot, stripeConfig, effectiveNow);
    if (precheckError) return precheckError;

    var phase1 = withLock_(LOCK_TIMEOUT_MS_, function () {
      var current = findRecord_(bookingId);
      if (!current) return { response: fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId) };
      if (!sameSnapshot_(snapshot, current)) return { response: concurrentModification_() };

      var cancelled = false;
      if (current.status === Booking.STATUS.PENDING || current.status === Booking.STATUS.CONFIRMED) {
        var cancelOutcome = BookingRepository.lockedInternals.cancelBookingAdminLocked(bookingId, { allowStripePaid: true });
        if (!cancelOutcome.response.success) {
          /* 取消（Calendar/Sheets）に失敗した予約へは返金しない（予約が有効なまま返金すると
             入金・予約の事実が食い違う）。取消の失敗自体は既存処理がRecoveryへ記録済み。 */
          return { response: cancelOutcome.response };
        }
        cancelled = true;
      }

      var attemptId = generateRefundAttemptId_(bookingId);
      try {
        SpreadsheetRepository.updateBookingRefundStateAtomic(bookingId, {
          refundAttemptId: attemptId,
          refundAttemptState: ATTEMPT_STATE.RESERVED,
          refundDecision: req.decision,
          refundAmount: amount,
          refundReason: req.reason,
          refundDecidedAt: effectiveNow,
          refundStripeStatus: '',
          refundCheckedAt: ''
        });
        SpreadsheetRepository.updateBookingPaymentStateAtomic(bookingId, {
          stripeRefundId: '',
          refundRequestedAt: effectiveNow,
          paymentLastErrorAt: '',
          paymentLastErrorMessage: ''
        });
      } catch (reserveError) {
        Logger.log('BookingRefund: 返金試行の予約に失敗しました: ' + bookingId + ' ' + sanitize_(describeError_(reserveError)));
      }
      var reserved = findRecord_(bookingId);
      if (!reserved || reserved.refundAttemptId !== attemptId || reserved.refundAttemptState !== ATTEMPT_STATE.RESERVED ||
          Number(reserved.refundAmount) !== amount) {
        recordRecovery_(bookingId, current, 'REFUND_RESERVATION_FAILED',
          '返金試行の記録を台帳へ保存できなかったため、Stripeへの返金は実行していません' +
            (cancelled ? '（予約の取消は完了済み）' : '') + '。台帳を確認し、もう一度「取消・返金」を実行してください。',
          effectiveNow, false);
        return {
          response: fail_('REFUND_RESERVATION_FAILED', '返金の準備（台帳への記録）に失敗したため、返金は実行していません' +
            (cancelled ? '（予約の取消は完了しています）' : '') + '。もう一度「取消・返金」を実行してください。', { cancelled: cancelled }),
          cancelled: cancelled
        };
      }
      return { attemptId: attemptId, cancelled: cancelled, record: reserved };
    });
    if (phase1.lockTimeout) return lockTimeoutResponse_();
    var reservation = phase1.value;
    if (reservation.response) {
      if (reservation.cancelled) notifyCancelledBestEffort_(bookingId, reservation.response);
      return reservation.response;
    }

    var createResult = StripeGateway.createRefund(stripeConfig, buildRefundParams_(bookingId, reservation.record), reservation.attemptId);
    var outcome = recordRefundResult_(bookingId, reservation.attemptId, createResult, effectiveNow);
    if (outcome.needsQuery) {
      var queried = queryAndAdopt_(bookingId, reservation.attemptId, stripeConfig, effectiveNow, false);
      if (queried) outcome = queried;
    }

    var response = toResponse_(bookingId, outcome, { cancelled: reservation.cancelled, refundAmount: amount, decision: req.decision });
    if (reservation.cancelled) notifyCancelledBestEffort_(bookingId, response);
    notifyRefundedBestEffort_(bookingId, response);
    return response;
  }

  /*
   * ==========================================================================
   * PR-Dレビュー対応・1回目: 未入金のStripe Checkout予約の取消と、発行済みCheckout
   * Session（決済URL）の失効。
   * ==========================================================================
   *
   * 取消だけでは、利用者が手元に残した決済URLから取消後に入金できてしまうため、発行済みの
   * 未決済Sessionを Stripe側でも失効させる。
   *
   * 1. Phase 0（Lockなし）: 決済試行の結果が未確定（試行IDはあるがSessionが未記録）の予約は、
   *    どのSessionを失効させればよいか分からないため取り消さない（CHECKOUT_ATTEMPT_UNRESOLVED）。
   * 2. Phase 1（Script Lock）: 最新行を再読込・比較し、既存の取消処理（Calendar削除→
   *    CANCELLED）を行い、checkoutCancelState=EXPIRE_REQUESTEDを記録する（枠は失効の結果を
   *    待たずに解放する）。
   * 3. Phase 2（Lockなし）: Stripeの失効APIを呼び、続けてSessionを再取得して実際の状態を
   *    確認する（Script Lockは保持しない）。
   * 4. Phase 3（Script Lock）: 確認できた状態（EXPIRED／PAYMENT_RECEIVED／UNKNOWN）を記録する。
   *
   * - 失効APIの応答が不明、かつSessionの状態も確認できない場合は、未決済・失効済みと断定せず
   *   UNKNOWNとしてRecoveryへ記録し、管理者へ通知する。「決済URLの失効を再確認」
   *   （reconcileCheckoutExpiry）で後から確認できる（失効は資金移動を伴わないため再実行してよい）。
   * - 失効と決済成功が競合した（Sessionが既にcomplete/paid）場合は、入金の事実をRecoveryへ
   *   記録して管理者へ通知する。入金そのもの（paymentStatus=paid）は既存のWebhook処理
   *   （StripeWebhookProcessor）が記録し、予約はCANCELLEDのため自動確定されず（予約を勝手に
   *   復活させない）、要復旧ゲート（PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED）で管理される。
   * - このためUNKNOWN・PAYMENT_RECEIVEDのいずれでも、ここでは要復旧ゲート
   *   （paymentRecoveryRequiredAt）を立てない。ゲートが立っているとWebhook処理が入金の記録
   *   自体を打ち切るため（StripeWebhookProcessorのPAYMENT_RECOVERY_REQUIRED分岐）、実際の
   *   入金を台帳へ記録する経路を塞がないようにする。
   */
  var CHECKOUT_CANCEL_STATE = {
    EXPIRE_REQUESTED: 'EXPIRE_REQUESTED',
    EXPIRED: 'EXPIRED',
    NO_SESSION: 'NO_SESSION',
    UNKNOWN: 'UNKNOWN',
    PAYMENT_RECEIVED: 'PAYMENT_RECEIVED'
  };

  /*
   * PR-Dレビュー対応・2回目: 取消と新しい決済試行（Booking Web AppのbeginCardCheckout）の競合。
   *
   * Booking Web AppとBooking AdminはScript Lockを共有しない。そのため、
   * (a) Phase 0（Lockなし）で読んだ後、Phase 1（取消）までの間に新しい決済試行・Sessionが
   *     記録される、
   * (b) 取消（Phase 1）の直前にWeb Appが「PENDINGである」と確認して決済試行を始めており、
   *     取消の後に新しいSessionが記録される、
   * の両方が起こり得る。(a)はPhase 1の再読込で決済試行ID・Session ID・解決状態を比較して検知し
   * （sameSnapshot_）、最新の状態を読み直して最初からやり直す（最大UNPAID_CANCEL_RETRIES_回）。
   * (b)は取消後の結果記録（settleCheckoutAfterCancel_）のLock内で、取消時点の決済試行と
   * 現在の決済試行を比較して検知する。新しいSessionが記録されていればそれも失効させて確認し、
   * 古いSessionを失効させただけで取消成功（EXPIRED）とはしない。新しい決済試行の結果を
   * 確認できない（試行IDはあるが未解決）場合は、未決済・失効済みと断定せずUNKNOWNとして
   * Recoveryで追跡する。Web App側も、取消済みの予約に対して作られたSessionのURLは利用者へ
   * 返さず、失効を試みたうえでRecoveryへ記録する（BookingRepository.gs参照）。
   */
  var UNPAID_CANCEL_RETRIES_ = 2;
  var SETTLE_MAX_ROUNDS_ = 3;
  var SESSION_MARKER_PATTERN_ = /sessionId=([A-Za-z0-9_]+)/g;

  /* 決済試行IDに結果が確定していない（試行IDはあるが解決日時が無い）。Session IDが残っていても
     それは前の試行のSessionであり、最新の試行のSessionはまだ分からない。 */
  function hasUnresolvedCheckoutAttempt_(record) {
    return !!record.paymentAttemptId && !record.paymentAttemptResolvedAt;
  }

  function checkoutIdentity_(record) {
    return {
      paymentAttemptId: record.paymentAttemptId || '',
      paymentAttemptResolvedAt: record.paymentAttemptResolvedAt || '',
      stripeCheckoutSessionId: record.stripeCheckoutSessionId || ''
    };
  }

  function sameCheckoutIdentity_(a, b) {
    return key_(a.paymentAttemptId) === key_(b.paymentAttemptId) &&
      key_(a.paymentAttemptResolvedAt) === key_(b.paymentAttemptResolvedAt) &&
      key_(a.stripeCheckoutSessionId) === key_(b.stripeCheckoutSessionId);
  }

  function cancelUnpaidCheckout_(bookingId, snapshot, req, now) {
    var current = snapshot;
    for (var attempt = 0; attempt <= UNPAID_CANCEL_RETRIES_; attempt++) {
      var outcome = cancelUnpaidCheckoutOnce_(bookingId, current, req, now);
      if (!outcome.retryWithLatest) return outcome.response;
      /* Phase 0の読込後に決済試行・Sessionが変わっていた。最新の行を読み直してやり直す
         （古いSessionを失効させて取消成功とはしない）。 */
      current = findRecord_(bookingId);
      if (!current) return fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId);
      var latestStatus = Booking.normalizePaymentStatus(current.paymentStatus);
      if (latestStatus === PS.PAID || latestStatus === PS.REFUND_PENDING || latestStatus === PS.REFUNDED || latestStatus === null) {
        return fail_('CONCURRENT_MODIFICATION', '確認中に決済状態が変わりました（' + (latestStatus || '不明') + '）。画面を更新して内容を確認してから、もう一度操作してください。');
      }
    }
    return concurrentModification_();
  }

  function cancelUnpaidCheckoutOnce_(bookingId, snapshot, req, now) {
    if (hasUnresolvedCheckoutAttempt_(snapshot)) {
      return {
        response: fail_('CHECKOUT_ATTEMPT_UNRESOLVED',
          '利用者の決済開始（Checkout Sessionの発行）の結果がまだ確定していないため、失効させる決済URLを特定できません。' +
            '数分後にもう一度お試しください（台帳・Stripeとも変更していません）。')
      };
    }
    var sessionId = snapshot.stripeCheckoutSessionId || '';
    var stripeConfig = BookingConfig.getStripeConfig();
    if (sessionId && !stripeConfig.secretKey) {
      return { response: fail_('STRIPE_NOT_CONFIGURED', 'Stripeの秘密鍵が設定されていないため、発行済みの決済URLを失効させられません。取消は行っていません。') };
    }

    var phase1 = withLock_(LOCK_TIMEOUT_MS_, function () {
      var current = findRecord_(bookingId);
      if (!current) return { response: fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId) };
      if (!sameSnapshot_(snapshot, current)) {
        /* 決済試行ID・Session ID・解決状態のいずれかが変わっていれば、読み直してやり直す。 */
        return sameCheckoutIdentity_(checkoutIdentity_(snapshot), checkoutIdentity_(current))
          ? { response: concurrentModification_() }
          : { retryWithLatest: true };
      }
      if (current.status !== Booking.STATUS.PENDING && current.status !== Booking.STATUS.CONFIRMED) {
        return { response: fail_('NOTHING_TO_CANCEL', 'この予約は既に' + current.status + 'のため、取り消す対象がありません。') };
      }
      var cancelOutcome = BookingRepository.lockedInternals.cancelBookingAdminLocked(bookingId, { allowStripePaid: true });
      if (!cancelOutcome.response.success) return { response: cancelOutcome.response };
      try {
        SpreadsheetRepository.updateBookingFields(bookingId, {
          checkoutCancelState: sessionId ? CHECKOUT_CANCEL_STATE.EXPIRE_REQUESTED : CHECKOUT_CANCEL_STATE.NO_SESSION,
          checkoutCancelCheckedAt: now
        });
        SpreadsheetRepository.updateBookingRefundStateAtomic(bookingId, { refundReason: req.reason });
      } catch (writeError) {
        /* 取消は完了済み。記録ができなくても失効の確認は続け、結果をRecoveryへ残す。 */
        Logger.log('BookingRefund: 決済URL失効の記録に失敗しました: ' + bookingId + ' ' + sanitize_(describeError_(writeError)));
      }
      /* 取消を確定した時点の決済試行。これ以降にWeb Appが新しい試行を記録したかを、結果の記録時に比較する。 */
      return { cancelled: true, identity: checkoutIdentity_(current) };
    });
    if (phase1.lockTimeout) return { response: lockTimeoutResponse_() };
    if (phase1.value.retryWithLatest) return { retryWithLatest: true };
    if (phase1.value.response) return { response: phase1.value.response };

    var settled = settleCheckoutAfterCancel_(bookingId, phase1.value.identity, stripeConfig, now, []);
    var response = {
      success: true, bookingId: bookingId, cancelled: true, refundDecision: '',
      checkoutExpireState: settled.state, message: settled.message
    };
    if (settled.state !== CHECKOUT_CANCEL_STATE.EXPIRED && settled.state !== CHECKOUT_CANCEL_STATE.NO_SESSION) {
      response.warning = { code: 'CHECKOUT_EXPIRE_' + settled.state, message: settled.message };
    }
    notifyCancelledBestEffort_(bookingId, response);
    return { response: response };
  }

  /* Phase 2（Lockなし）: 失効を依頼し、Sessionの実際の状態を確認して分類する。 */
  function observeExpiredSession_(stripeConfig, sessionId) {
    if (!stripeConfig.secretKey) {
      return { state: CHECKOUT_CANCEL_STATE.UNKNOWN, detail: 'Stripeの秘密鍵が未設定のため、決済URL（sessionId=' + sessionId + '）の失効を確認できません。' };
    }
    var expireResult = StripeGateway.expireCheckoutSession(stripeConfig, sessionId);
    var session = expireResult.ok ? expireResult.session : null;
    var retrieveError = '';
    if (!session || session.status !== 'expired') {
      /* 失効APIが拒否・応答不明だった場合も、成功と報告した場合も、expired以外なら
         再取得した実際の状態で判断する（応答だけで未決済・失効済みと断定しない）。 */
      var retrieved = StripeGateway.retrieveCheckoutSession(stripeConfig, sessionId);
      if (retrieved.ok) {
        session = retrieved.session;
      } else {
        session = null;
        retrieveError = retrieved.errorType || 'UNKNOWN';
      }
    }
    if (!session || session.id !== sessionId) {
      return {
        state: CHECKOUT_CANCEL_STATE.UNKNOWN,
        detail: '決済URL（sessionId=' + sessionId + '）が失効したか確認できませんでした（失効API: ' +
          (expireResult.ok ? 'ok' : (expireResult.errorType || 'UNKNOWN')) + '、再取得: ' + (retrieveError || 'ID不一致') + '）。'
      };
    }
    if (session.status === 'expired') {
      return { state: CHECKOUT_CANCEL_STATE.EXPIRED, detail: 'Stripe上で決済URL（sessionId=' + sessionId + '）の失効を確認しました。' };
    }
    if (session.status === 'complete' && (session.paymentStatus === 'paid' || session.paymentStatus === 'no_payment_required')) {
      return {
        state: CHECKOUT_CANCEL_STATE.PAYMENT_RECEIVED,
        detail: '取消と同時期に決済URL（sessionId=' + sessionId + '）の決済が成立していました（payment_intent=' +
          (session.paymentIntentId || '不明') + ', amount=' + session.amountTotal + '）。'
      };
    }
    return {
      state: CHECKOUT_CANCEL_STATE.UNKNOWN,
      detail: '決済URL（sessionId=' + sessionId + '）はまだ失効していません（status=' + session.status + ', payment_status=' + session.paymentStatus + '）。'
    };
  }

  var STATE_RANK_ = { NO_SESSION: 0, EXPIRED: 1, EXPIRE_REQUESTED: 2, UNKNOWN: 3, PAYMENT_RECEIVED: 4 };

  function worseState_(a, b) {
    return (STATE_RANK_[b] || 0) > (STATE_RANK_[a] || 0) ? b : a;
  }

  var CHECKOUT_TRACKING_FAILURE_TYPES_ = ['PAYMENT_CHECKOUT_EXPIRE_UNKNOWN', 'PAYMENT_CHECKOUT_AFTER_CANCEL'];

  /* このRecovery行（OPEN）が、指定したSessionについての記録か。 */
  function openRowMentions_(bookingId, failureTypes, needle) {
    try {
      return RecoveryRepository.listAll().some(function (row) {
        return row.bookingId === bookingId && row.recoveryState === 'OPEN' && failureTypes.indexOf(row.failureType) !== -1 &&
          String(row.errorMessage || '').indexOf(needle) !== -1;
      });
    } catch (e) {
      return false;
    }
  }

  /* 取消後の追跡が必要な（失効を確認できていない・取消後に発行された）SessionのID一覧。 */
  function openTrackedSessionIds_(bookingId) {
    var ids = [];
    try {
      RecoveryRepository.listAll().forEach(function (row) {
        if (row.bookingId !== bookingId || row.recoveryState !== 'OPEN' || CHECKOUT_TRACKING_FAILURE_TYPES_.indexOf(row.failureType) === -1) return;
        var text = String(row.errorMessage || '');
        var match;
        SESSION_MARKER_PATTERN_.lastIndex = 0;
        while ((match = SESSION_MARKER_PATTERN_.exec(text)) !== null) {
          if (ids.indexOf(match[1]) === -1) ids.push(match[1]);
        }
      });
    } catch (e) {
      Logger.log('BookingRefund: 追跡中の決済URLの取得に失敗しました: ' + bookingId);
    }
    return ids;
  }

  /*
   * 取消後の決済URLの失効確認と記録（Phase 2〜3）。expected: 取消を確定した時点（または
   * 前回確認した時点）の決済試行。extraSessionIds: 追跡中の他のSession（再確認時に使う）。
   *
   * PR-Dレビュー対応・3回目: 「最新の決済試行の確認」と「最終結果の書き込み」を同じLock区間で
   * 行う（以前は別々のLock区間だったため、その間にBooking Web Appが新しい決済試行・Sessionを
   * 記録すると見逃してEXPIREDと書き込み得た）。さらに、Booking Web AppとはScript Lockを
   * 共有しないため、書き込みの直後にも最新の決済試行を読み直し、変わっていればEXPIRED/
   * NO_SESSIONを残さずUNKNOWNへ戻す（writeSettledLocked_）。
   * - 確認済みでない新しいSessionが分かる場合は、失効・確認へ戻る（次の巡）。
   * - 新しい試行のSessionがまだ分からない場合は、UNKNOWNとしてRecoveryへ残して止める。
   * - 巡回はSETTLE_MAX_ROUNDS_回まで。それでも決済試行が動き続ける場合はUNKNOWNで止める。
   * 戻り値: { state, message }（台帳へ書き込んだ状態と同じもの）。
   */
  function settleCheckoutAfterCancel_(bookingId, expected, stripeConfig, now, extraSessionIds) {
    var checked = {};
    var order = [];
    function addSession(id) {
      if (id && order.indexOf(id) === -1) order.push(id);
    }
    addSession(expected.stripeCheckoutSessionId);
    (extraSessionIds || []).forEach(addSession);
    var ledgerIdentity = expected;

    for (var round = 0; round < SETTLE_MAX_ROUNDS_; round++) {
      order.forEach(function (id) {
        if (!checked[id]) checked[id] = observeExpiredSession_(stripeConfig, id);
      });
      var locked = withLock_(RESULT_LOCK_TIMEOUT_MS_, function () {
        var record = findRecord_(bookingId);
        if (!record) return { final: { state: CHECKOUT_CANCEL_STATE.UNKNOWN, detail: '予約行が見つかりません。', alert: true } };
        var inspection = inspectLatestAttemptLocked_(bookingId, record, ledgerIdentity, checked, now);
        if (inspection.newSessionId) return { again: true, latest: checkoutIdentity_(record), newSessionId: inspection.newSessionId };
        return writeSettledLocked_(bookingId, record, order, checked, inspection.extraUnknown, now);
      });
      if (locked.lockTimeout) {
        var timeoutDetail = order.map(function (id) { return checked[id] ? checked[id].detail : ''; }).join(' ');
        return finishSettle_(bookingId, { state: CHECKOUT_CANCEL_STATE.UNKNOWN, detail: timeoutDetail + '（Lock混雑のため台帳へは未記録）', alert: true, lockTimeout: true }, now);
      }
      var value = locked.value;
      if (value.again) {
        ledgerIdentity = value.latest;
        addSession(value.newSessionId);
        continue;
      }
      return finishSettle_(bookingId, value.final, now);
    }
    /* 何度確認しても決済試行が動き続けている。安全側のUNKNOWNで止める（確認済みのSessionの結果も記録する）。 */
    var exhausted = withLock_(RESULT_LOCK_TIMEOUT_MS_, function () {
      var record = findRecord_(bookingId);
      if (!record) return { final: { state: CHECKOUT_CANCEL_STATE.UNKNOWN, detail: '予約行が見つかりません。', alert: true } };
      return writeSettledLocked_(bookingId, record, order, checked,
        '確認中に決済試行が繰り返し更新されたため（' + SETTLE_MAX_ROUNDS_ + '回）、最新の決済URLの状態を確定できませんでした。', now);
    });
    if (exhausted.lockTimeout) {
      return finishSettle_(bookingId, { state: CHECKOUT_CANCEL_STATE.UNKNOWN, detail: 'Lock混雑のため確認結果を記録できませんでした。', alert: true, lockTimeout: true }, now);
    }
    if (exhausted.value.again) {
      /* 上限到達後の書き込み直後にもさらに新しいSessionが記録された。writeSettledLocked_が既に
         UNKNOWNへ戻し、Recoveryにも記録済み。これ以上は追わず、安全側のUNKNOWNで止める。 */
      return finishSettle_(bookingId, {
        state: CHECKOUT_CANCEL_STATE.UNKNOWN,
        detail: '確認中に決済試行が繰り返し更新されたため、最新の決済URL（sessionId=' + exhausted.value.newSessionId + '）の状態を確定できませんでした。',
        alert: true
      }, now);
    }
    return finishSettle_(bookingId, exhausted.value.final, now);
  }

  /*
   * Lock保持中専用。台帳の最新の決済試行が、前回確認した試行（ledgerIdentity）から変わって
   * いないかを確かめる。変わっていれば取消後の新しい決済試行としてRecoveryへ記録し、
   * - 解決済みで確認していないSessionがあれば { newSessionId } （失効・確認へ戻る）、
   * - 試行が未解決（Sessionが分からない）なら { extraUnknown }（UNKNOWNとして残す）を返す。
   */
  function inspectLatestAttemptLocked_(bookingId, record, ledgerIdentity, checked, now) {
    var latest = checkoutIdentity_(record);
    var unresolved = hasUnresolvedCheckoutAttempt_(record);
    var result = {};
    if (!sameCheckoutIdentity_(latest, ledgerIdentity)) {
      /* 取消の後に、Web Appが新しい決済試行・Sessionを記録した。 */
      var marker = latest.stripeCheckoutSessionId && !unresolved
        ? 'sessionId=' + latest.stripeCheckoutSessionId
        : 'paymentAttemptId=' + latest.paymentAttemptId;
      if (!openRowMentions_(bookingId, ['PAYMENT_CHECKOUT_AFTER_CANCEL'], marker)) {
        recordRecovery_(bookingId, record, 'PAYMENT_CHECKOUT_AFTER_CANCEL',
          '予約の取消後に新しい決済試行が記録されました（paymentAttemptId=' + (latest.paymentAttemptId || 'なし') + ', ' +
            (latest.stripeCheckoutSessionId && !unresolved ? marker : '決済URLは未記録') +
            '）。予約は取消済みのまま復活させません。決済URLの失効と入金の有無を確認してください。',
          now, false);
      }
    }
    if (!unresolved && latest.stripeCheckoutSessionId && !checked[latest.stripeCheckoutSessionId]) {
      result.newSessionId = latest.stripeCheckoutSessionId;
    } else if (unresolved) {
      result.extraUnknown = '取消後に始まった決済試行（paymentAttemptId=' + latest.paymentAttemptId +
        '）の結果（決済URL）をまだ確認できません。未決済・失効済みとは断定していません。';
    }
    return result;
  }

  /*
   * Lock保持中専用。確認できた各Sessionの結果と全体の状態を記録する（呼び出し元は直前に同じLock内で
   * inspectLatestAttemptLocked_を済ませていること）。書き込みの直後に最新の決済試行を読み直し、
   * 変わっていれば（Web AppはこのLockを共有しない）EXPIRED/NO_SESSIONを残さずUNKNOWNへ戻し、
   * 新しいSessionが分かれば確認へ戻るよう{ again }を返す。
   * 戻り値: { final: { state, detail, alert } } または { again, latest, newSessionId }。
   */
  function writeSettledLocked_(bookingId, record, order, checked, extraUnknown, now) {
    var aggregate = order.length === 0 ? CHECKOUT_CANCEL_STATE.NO_SESSION : CHECKOUT_CANCEL_STATE.EXPIRED;
    var details = [];
    var alert = false;
    order.forEach(function (id) {
      var observed = checked[id];
      if (!observed) {
        /* 巡回の上限に達し、まだStripeで確認していないSession。失効済みと断定しない。 */
        observed = { state: CHECKOUT_CANCEL_STATE.UNKNOWN, detail: '決済URL（sessionId=' + id + '）の失効をまだ確認していません。' };
      }
      aggregate = worseState_(aggregate, observed.state);
      details.push(observed.detail);
      if (observed.state === CHECKOUT_CANCEL_STATE.EXPIRED) {
        try {
          RecoveryRepository.resolveOpenRecordsOfTypesMentioning(bookingId, CHECKOUT_TRACKING_FAILURE_TYPES_, 'sessionId=' + id, now);
          /* このSessionが台帳の最新の決済試行（解決済み）のものなら、その試行が未解決だった間の記録も閉じる。 */
          if (record.stripeCheckoutSessionId === id && !hasUnresolvedCheckoutAttempt_(record) && record.paymentAttemptId) {
            RecoveryRepository.resolveOpenRecordsOfTypesMentioning(bookingId, CHECKOUT_TRACKING_FAILURE_TYPES_, 'paymentAttemptId=' + record.paymentAttemptId, now);
          }
        } catch (resolveError) {
          Logger.log('BookingRefund: 失効確認後のRecovery解消に失敗しました: ' + bookingId);
        }
      } else if (observed.state === CHECKOUT_CANCEL_STATE.PAYMENT_RECEIVED) {
        if (!openRowMentions_(bookingId, ['PAYMENT_RECEIVED_AFTER_CANCEL'], 'sessionId=' + id)) {
          recordRecovery_(bookingId, record, 'PAYMENT_RECEIVED_AFTER_CANCEL',
            observed.detail + ' 予約は取消済みのまま復活させません。入金はWebhook処理で台帳へ記録されます。' +
              '入金の記録後、「取消・返金」で返金方針（全額／一部／返金なし）を改めて判断してください。',
            now, false);
        }
        alert = true;
      } else {
        if (!openRowMentions_(bookingId, ['PAYMENT_CHECKOUT_EXPIRE_UNKNOWN'], 'sessionId=' + id)) {
          recordRecovery_(bookingId, record, 'PAYMENT_CHECKOUT_EXPIRE_UNKNOWN',
            observed.detail + ' 予約は取消済みです。未決済・失効済みとは断定していません。「決済URLの失効を再確認」で確認してください。' +
              'この間に入金が成立した場合はWebhook処理で記録され、要対応として管理されます。',
            now, false);
        }
        alert = true;
      }
    });
    /* 台帳の最新Sessionが確認済みの集合に無い（呼び出し元の見落とし防止の二重確認）。 */
    if (record.stripeCheckoutSessionId && !hasUnresolvedCheckoutAttempt_(record) && !checked[record.stripeCheckoutSessionId]) {
      extraUnknown = (extraUnknown ? extraUnknown + ' ' : '') + '台帳の最新の決済URL（sessionId=' + record.stripeCheckoutSessionId + '）の失効をまだ確認していません。';
    }
    if (extraUnknown) {
      aggregate = worseState_(aggregate, CHECKOUT_CANCEL_STATE.UNKNOWN);
      details.push(extraUnknown);
      alert = true;
      recordUnknownAttemptLocked_(bookingId, record, extraUnknown, now);
    }
    /* 一度記録した「入金あり」は、後の確認結果で上書きしない（入金の事実を消さない）。 */
    if (record.checkoutCancelState === CHECKOUT_CANCEL_STATE.PAYMENT_RECEIVED) {
      aggregate = CHECKOUT_CANCEL_STATE.PAYMENT_RECEIVED;
    }
    /* 解消済みでないSession（追跡中のRecovery行）が他に残っていれば、全体を失効済みとしない。 */
    if (aggregate === CHECKOUT_CANCEL_STATE.EXPIRED || aggregate === CHECKOUT_CANCEL_STATE.NO_SESSION) {
      var stillTracked = openTrackedSessionIds_(bookingId).filter(function (id) { return !checked[id]; });
      if (stillTracked.length > 0) {
        aggregate = CHECKOUT_CANCEL_STATE.UNKNOWN;
        details.push('他に失効を確認できていない決済URL（' + stillTracked.map(function (id) { return 'sessionId=' + id; }).join(', ') + '）があります。');
        alert = true;
      }
    }
    writeCheckoutCancelState_(bookingId, aggregate, now);

    /*
     * 書き込み直後の再確認。Booking Web AppはこのScript Lockを共有しないため、上の確認から
     * 書き込みまでの間に新しい決済試行・Sessionが記録された可能性を否定できない。
     */
    if (aggregate === CHECKOUT_CANCEL_STATE.EXPIRED || aggregate === CHECKOUT_CANCEL_STATE.NO_SESSION) {
      var after = findRecord_(bookingId);
      if (after && !sameCheckoutIdentity_(checkoutIdentity_(after), checkoutIdentity_(record))) {
        writeCheckoutCancelState_(bookingId, CHECKOUT_CANCEL_STATE.UNKNOWN, now);
        var inspection = inspectLatestAttemptLocked_(bookingId, after, checkoutIdentity_(record), checked, now);
        if (inspection.newSessionId) {
          return { again: true, latest: checkoutIdentity_(after), newSessionId: inspection.newSessionId };
        }
        var lateDetail = inspection.extraUnknown || '結果を記録した直後に決済試行が更新されました。';
        recordUnknownAttemptLocked_(bookingId, after, lateDetail, now);
        details.push(lateDetail);
        return { final: { state: CHECKOUT_CANCEL_STATE.UNKNOWN, detail: details.join(' '), alert: true } };
      }
    }
    return { final: { state: aggregate, detail: details.join(' '), alert: alert } };
  }

  function writeCheckoutCancelState_(bookingId, state, now) {
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, { checkoutCancelState: state, checkoutCancelCheckedAt: now });
    } catch (writeError) {
      Logger.log('BookingRefund: 決済URL失効の結果記録に失敗しました: ' + bookingId);
    }
  }

  /* Lock保持中専用。結果を確定できない最新の決済試行を、再確認の対象としてRecoveryへ残す
     （同じ試行・Sessionについて既にOPENの記録があれば重複させない）。Sessionが分かっていれば
     sessionId=を含め、「決済URLの失効を再確認」がそのSessionを確認対象に含められるようにする。 */
  function recordUnknownAttemptLocked_(bookingId, record, reason, now) {
    var markers = ['paymentAttemptId=' + (record.paymentAttemptId || 'なし')];
    if (record.stripeCheckoutSessionId && !hasUnresolvedCheckoutAttempt_(record)) {
      markers.push('sessionId=' + record.stripeCheckoutSessionId);
    }
    if (openRowMentions_(bookingId, ['PAYMENT_CHECKOUT_EXPIRE_UNKNOWN'], markers.join(', '))) return;
    recordRecovery_(bookingId, record, 'PAYMENT_CHECKOUT_EXPIRE_UNKNOWN',
      reason + '（' + markers.join(', ') + '）「決済URLの失効を再確認」で確認してください。', now, false);
  }

  /* Lockの外: 管理者通知と、呼び出し元へ返す結果（台帳へ書き込んだ状態と同じもの）の組み立て。 */
  function finishSettle_(bookingId, result, now) {
    if (result.lockTimeout) {
      recordRecoveryOnly_(bookingId, null, 'PAYMENT_CHECKOUT_EXPIRE_UNKNOWN', result.detail, now);
    }
    if (result.alert) BookingAdminAlerts.notifyRefundNeedsAttention(bookingId, 'CHECKOUT_' + result.state, result.detail);
    return { state: result.state, message: checkoutExpireMessage_(result.state, result.detail) };
  }

  function checkoutExpireMessage_(state, detail) {
    if (state === CHECKOUT_CANCEL_STATE.EXPIRED) return '発行済みの決済URLもStripe側で失効させました。';
    if (state === CHECKOUT_CANCEL_STATE.NO_SESSION) return '発行済みの決済URL（Checkout Session）はありませんでした。';
    if (state === CHECKOUT_CANCEL_STATE.PAYMENT_RECEIVED) {
      return '取消と同時期に決済が成立していました。予約は取消済みのままです。入金が台帳へ記録された後、「取消・返金」で返金方針を判断してください。（' + detail + '）';
    }
    return '予約は取り消しましたが、決済URLが失効したかを確認できませんでした（未決済・失効済みとは断定していません）。' +
      '「決済URLの失効を再確認」で確認してください。（' + detail + '）';
  }

  /*
   * reconcileCheckoutExpiry(bookingId, now) — Booking Adminの「決済URLの失効を再確認」。
   * 取消済みの予約について、台帳の最新の決済試行のSessionと、Recoveryで追跡中の（失効を確認
   * できていない・取消後に発行された）Sessionのすべてを失効させて状態を確認する。
   * 失効は資金移動を伴わないため何度実行してもよい。最新の決済試行の結果が未確定の間は
   * 断定せずUNKNOWNのまま残す。
   */
  function reconcileCheckoutExpiry(bookingId, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    if (!bookingId) return fail_('INVALID_BOOKING_ID', 'bookingIdを指定してください。');
    var record = findRecord_(bookingId);
    if (!record) return fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId);
    var state = record.checkoutCancelState;
    if (state !== CHECKOUT_CANCEL_STATE.UNKNOWN && state !== CHECKOUT_CANCEL_STATE.EXPIRE_REQUESTED) {
      return fail_('NO_CHECKOUT_EXPIRY_TO_CHECK', state === CHECKOUT_CANCEL_STATE.EXPIRED
        ? '決済URLの失効は確認済みです。'
        : (state === CHECKOUT_CANCEL_STATE.PAYMENT_RECEIVED
          ? '取消と同時期に決済が成立しています。入金の記録後、「取消・返金」で返金方針を判断してください。'
          : '失効を確認する決済URLはありません。'));
    }
    if (record.status === Booking.STATUS.PENDING || record.status === Booking.STATUS.CONFIRMED) {
      return fail_('NOT_CANCELLED', 'この予約は取り消されていません。');
    }
    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.secretKey) return fail_('STRIPE_NOT_CONFIGURED', 'Stripeの秘密鍵が設定されていないため確認できません。');
    var identity = checkoutIdentity_(record);
    if (hasUnresolvedCheckoutAttempt_(record)) {
      /* 最新の決済試行の結果が未確定。そのSessionは分からないため、既知のSessionだけ確認し、
         全体はUNKNOWNのまま残す（settleCheckoutAfterCancel_のextraUnknown）。 */
      identity = { paymentAttemptId: identity.paymentAttemptId, paymentAttemptResolvedAt: '', stripeCheckoutSessionId: '' };
    }
    var outcome = settleCheckoutAfterCancel_(bookingId, identity, stripeConfig, effectiveNow,
      [record.stripeCheckoutSessionId].concat(openTrackedSessionIds_(bookingId)));
    if (outcome.state === CHECKOUT_CANCEL_STATE.EXPIRED) {
      return { success: true, bookingId: bookingId, checkoutExpireState: outcome.state, message: outcome.message };
    }
    return fail_('CHECKOUT_EXPIRE_' + outcome.state, outcome.message, { checkoutExpireState: outcome.state });
  }

  /* 返金を伴わない取消（入金前の予約、または「返金なし」を選んだ入金済みの予約）。 */
  function cancelOnly_(bookingId, snapshot, req, now, recordDecision) {
    var locked = withLock_(LOCK_TIMEOUT_MS_, function () {
      var current = findRecord_(bookingId);
      if (!current) return { response: fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId) };
      if (!sameSnapshot_(snapshot, current)) return { response: concurrentModification_() };

      var cancelled = false;
      if (current.status === Booking.STATUS.PENDING || current.status === Booking.STATUS.CONFIRMED) {
        var cancelOutcome = BookingRepository.lockedInternals.cancelBookingAdminLocked(bookingId, { allowStripePaid: true });
        if (!cancelOutcome.response.success) return { response: cancelOutcome.response };
        cancelled = true;
      } else if (!recordDecision) {
        return { response: fail_('NOTHING_TO_CANCEL', 'この予約は既に' + current.status + 'のため、取り消す対象がありません。') };
      }

      var response = { success: true, bookingId: bookingId, cancelled: cancelled, refundDecision: recordDecision ? DECISION.NONE : '' };
      if (recordDecision) {
        try {
          SpreadsheetRepository.updateBookingRefundStateAtomic(bookingId, {
            refundAttemptId: '',
            refundAttemptState: '',
            refundDecision: DECISION.NONE,
            refundAmount: 0,
            refundReason: req.reason,
            refundDecidedAt: now,
            refundStripeStatus: '',
            refundCheckedAt: ''
          });
        } catch (writeError) {
          recordRecovery_(bookingId, current, 'REFUND_DECISION_WRITE_FAILED',
            '「返金なし」の判断を台帳へ記録できませんでした' + (cancelled ? '（予約の取消は完了済み）' : '') + ': ' + describeError_(writeError),
            now, false);
          response.warning = { code: 'REFUND_DECISION_WRITE_FAILED', message: '「返金なし」の記録に失敗しました。Recoveryを確認してください。' };
        }
      }
      return { response: response, cancelled: cancelled };
    });
    if (locked.lockTimeout) return lockTimeoutResponse_();
    if (locked.value.cancelled) notifyCancelledBestEffort_(bookingId, locked.value.response);
    return locked.value.response;
  }

  /*
   * Phase 3: Stripeの応答（createRefund/retrieveRefundの結果、または照会で見つけた返金）を
   * 台帳へ記録する。戻り値: { success, code, message, needsQuery?, refundStatus?, stripeRefundId? }
   */
  function recordRefundResult_(bookingId, attemptId, result, now) {
    var locked = withLock_(RESULT_LOCK_TIMEOUT_MS_, function () {
      var record = findRecord_(bookingId);
      if (!record) return { success: false, code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId };
      if (record.refundAttemptId !== attemptId) {
        if (result.ok) {
          /* 台帳の試行が置き換わった後に、古い試行の返金がStripeで作られていた。台帳の
             返金記録と食い違う資金移動のため、事実をRecoveryへ残して要対応にする。 */
          var staleMessage = '台帳の返金試行（' + (record.refundAttemptId || 'なし') + '）とは別の、古い返金試行（' + attemptId +
            '）の返金がStripeで作られていました（refundId=' + result.refund.id + ', status=' + result.refund.status + ', amount=' + result.refund.amount + '）。';
          recordRecovery_(bookingId, record, 'REFUND_STALE_ATTEMPT_REFUNDED', staleMessage, now, true);
          return { success: false, code: 'STALE_REFUND_ATTEMPT', message: staleMessage + ' 管理者の確認が必要です。', alert: true };
        }
        return { success: false, code: 'STALE_REFUND_ATTEMPT', message: 'この返金試行は既に別の試行に置き換わっているため、結果を記録しませんでした。' };
      }
      if (result.ok) return applyRefundObject_(bookingId, record, result.refund, now);

      var stripeMessage = sanitize_(result.message);
      if (result.errorType === 'STRIPE_ERROR' || result.errorType === 'INVALID_REQUEST' || result.errorType === 'NOT_CONFIGURED') {
        /* Stripeがこの返金を作らずに明確に拒否した（またはStripeへ到達していない）。 */
        if (record.refundAttemptState === ATTEMPT_STATE.SUBMITTED) {
          return { success: false, code: 'STALE_REFUND_ATTEMPT', message: '返金は既に受け付け済みとして記録されています。' };
        }
        writeAttemptState_(bookingId, { refundAttemptState: ATTEMPT_STATE.FAILED, refundCheckedAt: now });
        recordRecovery_(bookingId, record, 'REFUND_REJECTED', 'Stripeが返金を拒否しました（返金は行われていません）: ' + stripeMessage, now, true);
        return { success: false, code: 'REFUND_REJECTED', message: 'Stripeが返金を受け付けませんでした（返金は行われていません）: ' + stripeMessage, alert: true };
      }
      if (result.errorType === 'IDEMPOTENCY_CONFLICT') {
        if (record.refundAttemptState !== ATTEMPT_STATE.SUBMITTED) {
          writeAttemptState_(bookingId, { refundAttemptState: ATTEMPT_STATE.UNKNOWN, refundCheckedAt: now });
        }
        recordRecovery_(bookingId, record, 'REFUND_IDEMPOTENCY_CONFLICT',
          '同じ返金試行ID（Idempotency-Key）に異なる内容の返金リクエストが記録されています。台帳とStripeの返金を照合してください。', now, true);
        return { success: false, code: 'REFUND_IDEMPOTENCY_CONFLICT', message: 'Stripeが返金リクエストの重複を検知しました。管理者の確認が必要です（新しい返金は実行しません）。', alert: true };
      }
      /* NETWORK/AMBIGUOUS: 返金が作られたかどうか分からない。未返金と決めつけない。 */
      if (record.refundAttemptState === ATTEMPT_STATE.RESERVED || !record.refundAttemptState) {
        writeAttemptState_(bookingId, { refundAttemptState: ATTEMPT_STATE.UNKNOWN, refundCheckedAt: now });
      }
      recordRecovery_(bookingId, record, 'REFUND_RESULT_UNKNOWN',
        'Stripe返金APIの応答を確認できませんでした（' + (result.errorType || 'UNKNOWN') + '）。返金が作られたかは未確定です。' +
          '「返金状態を照会」で同じ返金試行IDの返金を確認してください（新しい返金IDでは再実行しません）。', now, false);
      return {
        success: false, code: 'REFUND_RESULT_UNKNOWN', needsQuery: true,
        message: 'Stripeの応答を確認できませんでした。返金が行われたかは未確定です。「返金状態を照会」で確認してください。'
      };
    });
    if (locked.lockTimeout) {
      /* Stripeの結果は得られたが台帳へ記録できない。事実だけはRecoveryへ残す。 */
      var detail = result.ok
        ? 'Stripeは返金を受け付けました（refundId=' + result.refund.id + ', status=' + result.refund.status + '）が、Lock混雑のため台帳へ記録できませんでした。'
        : 'Stripe返金APIの結果（' + (result.errorType || '') + '）をLock混雑のため台帳へ記録できませんでした。';
      recordRecoveryOnly_(bookingId, null, 'REFUND_RESULT_NOT_RECORDED', detail + ' 「返金状態を照会」で記録してください。', now);
      BookingAdminAlerts.notifyRefundNeedsAttention(bookingId, 'REFUND_RESULT_NOT_RECORDED', detail);
      return { success: false, code: 'REFUND_RESULT_NOT_RECORDED', message: detail + ' 数分後に「返金状態を照会」を実行してください。' };
    }
    var value = locked.value;
    if (value.alert) BookingAdminAlerts.notifyRefundNeedsAttention(bookingId, value.code, value.message);
    return value;
  }

  function writeAttemptState_(bookingId, fields) {
    try {
      SpreadsheetRepository.updateBookingRefundStateAtomic(bookingId, fields);
      return true;
    } catch (writeError) {
      Logger.log('BookingRefund: 返金試行の状態更新に失敗しました: ' + bookingId + ' ' + sanitize_(describeError_(writeError)));
      return false;
    }
  }

  /* Lock保持中専用。Stripeで確認した返金オブジェクトを台帳へ反映する。 */
  function applyRefundObject_(bookingId, record, refund, now) {
    var metadataAttemptId = refund.metadata && refund.metadata.refundAttemptId;
    if (refund.paymentIntentId !== record.stripePaymentIntentId || Number(refund.amount) !== Number(record.refundAmount) ||
        metadataAttemptId !== record.refundAttemptId || (record.stripeRefundId && record.stripeRefundId !== refund.id)) {
      var mismatch = 'Stripeの返金（refundId=' + refund.id + ', amount=' + refund.amount + ', payment_intent=' + refund.paymentIntentId +
        '）が台帳の返金試行（refundAttemptId=' + record.refundAttemptId + ', 返金額=' + record.refundAmount + '）と一致しません。';
      recordRecovery_(bookingId, record, 'REFUND_RESPONSE_MISMATCH', mismatch, now, true);
      return { success: false, code: 'REFUND_RESPONSE_MISMATCH', message: mismatch + ' 管理者の確認が必要です。', alert: true };
    }

    var paymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    var applyOptions = { allowWhileRecoveryRequired: true };
    var applyLocked = BookingRepository.lockedInternals.applyPaymentStateUpdateLocked;

    if (refund.status === 'failed' || refund.status === 'canceled') {
      if (paymentStatus === PS.PAID) {
        try {
          SpreadsheetRepository.updateBookingPaymentStateAtomic(bookingId, { stripeRefundId: refund.id });
        } catch (evidenceError) {
          Logger.log('BookingRefund: 失敗した返金IDの記録に失敗しました: ' + bookingId);
        }
      }
      writeAttemptState_(bookingId, { refundAttemptState: ATTEMPT_STATE.FAILED, refundStripeStatus: refund.status, refundCheckedAt: now });
      var failedMessage = 'Stripeの返金（refundId=' + refund.id + '）が' + refund.status + 'になりました（返金は完了していません）' +
        (refund.failureReason ? '。理由: ' + refund.failureReason : '') + '。';
      recordRecovery_(bookingId, record, 'REFUND_FAILED', failedMessage, now, true);
      return { success: false, code: 'REFUND_FAILED', message: failedMessage + ' Stripe管理画面で確認のうえ対応してください。', refundStatus: refund.status, stripeRefundId: refund.id, alert: true };
    }
    if (['pending', 'requires_action', 'succeeded'].indexOf(refund.status) === -1) {
      var unknownStatus = 'Stripeの返金（refundId=' + refund.id + '）のstatusが想定外の値（' + refund.status + '）です。';
      recordRecovery_(bookingId, record, 'REFUND_RESPONSE_MISMATCH', unknownStatus, now, true);
      return { success: false, code: 'REFUND_RESPONSE_MISMATCH', message: unknownStatus, alert: true };
    }

    var steps = [];
    if (paymentStatus === PS.PAID) steps.push({ to: PS.REFUND_PENDING, fields: { stripeRefundId: refund.id } });
    if (refund.status === 'succeeded') {
      steps.push({ to: PS.REFUNDED, fields: { stripeRefundId: refund.id, refundedAt: paymentStatus === PS.REFUNDED ? record.refundedAt : now } });
    } else if (paymentStatus === PS.REFUND_PENDING) {
      steps.push({ to: PS.REFUND_PENDING, fields: { stripeRefundId: refund.id } });
    }
    if (paymentStatus !== PS.PAID && paymentStatus !== PS.REFUND_PENDING && paymentStatus !== PS.REFUNDED) {
      var statusMismatch = '台帳の決済状態（' + paymentStatus + '）では、Stripeの返金（refundId=' + refund.id + '）を記録できません。';
      recordRecovery_(bookingId, record, 'REFUND_RESPONSE_MISMATCH', statusMismatch, now, true);
      return { success: false, code: 'REFUND_RESPONSE_MISMATCH', message: statusMismatch, alert: true };
    }

    for (var i = 0; i < steps.length; i++) {
      var stepResult;
      try {
        stepResult = applyLocked(bookingId, steps[i].to, steps[i].fields, now, applyOptions);
      } catch (applyError) {
        stepResult = { success: false, error: { code: 'UNEXPECTED_ERROR', message: describeError_(applyError) } };
      }
      if (!stepResult.success) {
        return ledgerUpdateFailed_(bookingId, record, refund, (stepResult.error && stepResult.error.code) || 'UNKNOWN', now);
      }
    }
    if (!writeAttemptState_(bookingId, { refundAttemptState: ATTEMPT_STATE.SUBMITTED, refundStripeStatus: refund.status, refundCheckedAt: now })) {
      return ledgerUpdateFailed_(bookingId, record, refund, 'REFUND_STATE_WRITE_FAILED', now);
    }
    return {
      success: true,
      code: refund.status === 'succeeded' ? 'REFUNDED' : 'REFUND_PENDING',
      refundStatus: refund.status,
      stripeRefundId: refund.id,
      message: refund.status === 'succeeded'
        ? 'Stripeで返金が完了しました。'
        : 'Stripeが返金を受け付けました（完了待ち）。完了後に「返金状態を照会」で確認できます。'
    };
  }

  function ledgerUpdateFailed_(bookingId, record, refund, code, now) {
    /* 照会で再開できるよう、試行状態だけでもUNKNOWNへ（これ自体が失敗してもRecoveryが正）。 */
    writeAttemptState_(bookingId, { refundAttemptState: ATTEMPT_STATE.UNKNOWN, refundStripeStatus: refund.status, refundCheckedAt: now });
    var message = 'Stripeは返金を受け付けました（refundId=' + refund.id + ', status=' + refund.status + ', amount=' + refund.amount +
      '）が、台帳への記録に失敗しました（' + code + '）。返金・入金・予約の事実は消していません。台帳の復旧後に「返金状態を照会」で記録してください。';
    recordRecovery_(bookingId, record, 'REFUND_SUCCEEDED_LEDGER_UPDATE_FAILED', message, now, true);
    return { success: false, code: 'REFUND_LEDGER_UPDATE_FAILED', message: message, stripeRefundId: refund.id, alert: true };
  }

  /*
   * 返金一覧を照会して、この返金試行（metadata.refundAttemptId一致）の返金を採用する。
   * 見つからない場合、allowResubmit=trueなら同じ返金試行ID（Idempotency-Key）・同じ金額で
   * 再送する（新しい返金試行IDは発行しない）。戻り値はrecordRefundResult_と同じ形、
   * 照会自体に失敗した場合はnullではなく失敗の結果を返す。
   */
  function queryAndAdopt_(bookingId, attemptId, stripeConfig, now, allowResubmit) {
    var record = findRecord_(bookingId);
    if (!record) return { success: false, code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId };
    var listResult = StripeGateway.listRefundsForPaymentIntent(stripeConfig, record.stripePaymentIntentId);
    if (!listResult.ok) {
      return { success: false, code: 'REFUND_RESULT_UNKNOWN', message: 'Stripeの返金一覧を確認できませんでした。返金が行われたかは未確定です。時間をおいて「返金状態を照会」を実行してください。' };
    }
    var ours = listResult.refunds.filter(function (r) { return r.metadata && r.metadata.refundAttemptId === attemptId; });
    var others = listResult.refunds.filter(function (r) {
      return !(r.metadata && r.metadata.refundAttemptId === attemptId) && isActiveRefund_(r) && r.id !== record.stripeRefundId;
    });
    if (others.length > 0 || ours.length > 1) {
      var message = 'このPaymentIntentに、台帳の返金試行（' + attemptId + '）以外の有効な返金、または重複した返金がStripe上に存在します（' +
        listResult.refunds.map(function (r) { return r.id + ':' + r.status; }).join(', ') + '）。';
      gateWithLock_(bookingId, record, 'REFUND_EXTERNAL_DETECTED', message, now);
      return { success: false, code: 'REFUND_EXTERNAL_DETECTED', message: message + ' Stripe管理画面で確認してください（新しい返金は実行しません）。' };
    }
    if (ours.length === 1) {
      return recordRefundResult_(bookingId, attemptId, { ok: true, refund: ours[0] }, now);
    }
    if (!allowResubmit) {
      return { success: false, code: 'REFUND_RESULT_UNKNOWN', message: 'Stripe上にこの返金試行の返金はまだ見つかりません。返金が行われたかは未確定です。「返金状態を照会」で確認・再送してください。' };
    }
    var resent = StripeGateway.createRefund(stripeConfig, buildRefundParams_(bookingId, record), attemptId);
    return recordRefundResult_(bookingId, attemptId, resent, now);
  }

  function toResponse_(bookingId, outcome, extra) {
    var base = Object.assign({ bookingId: bookingId }, extra || {});
    if (outcome.success) {
      return Object.assign(base, {
        success: true,
        refundResult: outcome.code,
        refundStatus: outcome.refundStatus || '',
        stripeRefundId: outcome.stripeRefundId || '',
        message: outcome.message
      });
    }
    return Object.assign(base, {
      success: false,
      error: { code: outcome.code, message: outcome.message },
      stripeRefundId: outcome.stripeRefundId || ''
    });
  }

  function notifyCancelledBestEffort_(bookingId, response) {
    try {
      var mailResult = BookingMailer.sendCancelledMailForBooking(bookingId);
      response.cancelMailSent = !!(mailResult && mailResult.success && !mailResult.skipped);
      if (!mailResult || !mailResult.success) response.cancelMailError = mailResult && mailResult.error;
    } catch (mailError) {
      response.cancelMailSent = false;
      response.cancelMailError = { code: 'UNEXPECTED_ERROR', message: sanitize_(describeError_(mailError)) };
    }
  }

  function notifyRefundedBestEffort_(bookingId, response) {
    try {
      var mailResult = BookingMailer.sendRefundedMailForBooking(bookingId);
      response.refundMailSent = !!(mailResult && mailResult.success && !mailResult.skipped);
      if (mailResult && !mailResult.success && !mailResult.skipped) response.refundMailError = mailResult.error;
    } catch (mailError) {
      response.refundMailSent = false;
      response.refundMailError = { code: 'UNEXPECTED_ERROR', message: sanitize_(describeError_(mailError)) };
    }
  }

  /*
   * reconcileRefund(bookingId, now) — Booking Adminの「返金状態を照会」。
   * 台帳の返金試行について、Stripeの実際の状態を確認して台帳へ記録する。
   * - SUBMITTED（refund_pending）: 返金を再取得し、succeededならrefundedへ進めて返金完了メールを送る。
   * - UNKNOWN／RESERVED／台帳更新の途中失敗: 返金一覧から同じ返金試行IDの返金を探して採用する。
   *   見つからない場合、UNKNOWN（最初の呼び出しの応答は既に返っている）またはRESERVEDのまま
   *   RESERVED_IN_FLIGHT_MS_を過ぎた試行に限り、同じ返金試行ID・同じ金額で再送する。
   * - FAILED: 何もしない（新しい返金は「取消・返金」から改めて実行する）。
   * 要復旧ゲートが立っていても実行できる（Stripeの事実を台帳へ記録するだけのため）。
   */
  function reconcileRefund(bookingId, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    if (!bookingId) return fail_('INVALID_BOOKING_ID', 'bookingIdを指定してください。');
    var record = findRecord_(bookingId);
    if (!record) return fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId);
    if (!record.refundAttemptId) {
      return fail_('NO_REFUND_ATTEMPT', record.refundDecision === DECISION.NONE
        ? 'この予約は「返金なし」で取り消されています。照会する返金はありません。'
        : 'この予約には照会する返金試行がありません。');
    }
    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.secretKey) {
      return fail_('STRIPE_NOT_CONFIGURED', 'Stripeの秘密鍵が設定されていないため照会できません。');
    }

    var state = record.refundAttemptState;
    var paymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    var outcome;
    if (state === ATTEMPT_STATE.FAILED) {
      return fail_('REFUND_FAILED', '前回の返金は失敗しています（返金は完了していません）。Stripe管理画面で確認し、必要なら「取消・返金」から改めて返金してください。');
    }
    if (state === ATTEMPT_STATE.SUBMITTED && paymentStatus === PS.REFUNDED) {
      outcome = { success: true, code: 'REFUNDED', refundStatus: 'succeeded', stripeRefundId: record.stripeRefundId, message: '返金は完了済みです。' };
    } else if (state === ATTEMPT_STATE.SUBMITTED && paymentStatus === PS.REFUND_PENDING && record.stripeRefundId) {
      var retrieved = StripeGateway.retrieveRefund(stripeConfig, record.stripeRefundId);
      outcome = retrieved.ok
        ? recordRefundResult_(bookingId, record.refundAttemptId, retrieved, effectiveNow)
        : { success: false, code: 'STRIPE_LOOKUP_FAILED', message: 'Stripeで返金の状態を確認できませんでした。時間をおいてもう一度お試しください。' };
    } else {
      var decidedAt = isDateLike_(record.refundDecidedAt) ? record.refundDecidedAt.getTime() : 0;
      var reservedLongAgo = effectiveNow.getTime() - decidedAt >= RESERVED_IN_FLIGHT_MS_;
      var allowResubmit = state === ATTEMPT_STATE.UNKNOWN || (state === ATTEMPT_STATE.RESERVED && reservedLongAgo);
      outcome = queryAndAdopt_(bookingId, record.refundAttemptId, stripeConfig, effectiveNow, allowResubmit);
      if (!outcome.success && outcome.code === 'REFUND_RESULT_UNKNOWN' && state === ATTEMPT_STATE.RESERVED && !reservedLongAgo) {
        outcome = {
          success: false, code: 'REFUND_IN_PROGRESS',
          message: '返金の実行を開始した直後のため、まだ結果を確定できません。数分後にもう一度「返金状態を照会」を実行してください。'
        };
      }
    }
    var response = toResponse_(bookingId, outcome, {});
    notifyRefundedBestEffort_(bookingId, response);
    return response;
  }

  /*
   * resolvePaymentRecovery(bookingId, note, now) — 決済の要復旧ゲートの解消。
   * Stripeの実際の状態と台帳が整合していると確認できた場合のみ、paymentRecoveryRequiredAtを
   * 外し、この予約のOPENな決済系Recovery行をRESOLVEDにする。解消できる状態:
   * - 入金済み（paid）・Stripe上に有効な返金なし、かつ予約がCONFIRMED（入金と確定が整合）
   * - 入金済み（paid）・有効な返金なし、かつ予約が取消・失効済みで管理者が「返金なし」を記録済み
   * - 返金済み（refunded）・Stripe上の返金が台帳の返金IDと一致してsucceeded、かつ予約が
   *   CONFIRMED/PENDINGでない
   * それ以外（返金手続き中・未入金・識別子の欠落・Stripeと不一致等）は解消しない。
   */
  function resolvePaymentRecovery(bookingId, note, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    if (!bookingId) return fail_('INVALID_BOOKING_ID', 'bookingIdを指定してください。');
    var safeNote = typeof note === 'string' ? note.trim() : '';
    if (!safeNote || safeNote.length > MAX_TEXT_LENGTH_) {
      return fail_('INVALID_NOTE', '確認した内容（解消メモ）を' + MAX_TEXT_LENGTH_ + '文字以内で入力してください。');
    }
    var snapshot = findRecord_(bookingId);
    if (!snapshot) return fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId);
    if (!snapshot.paymentRecoveryRequiredAt && !RecoveryRepository.hasOpenPaymentRecords(bookingId)) {
      return fail_('NOT_IN_RECOVERY', 'この予約には未解消の決済要対応がありません。');
    }
    if (snapshot.checkoutCancelState === CHECKOUT_CANCEL_STATE.UNKNOWN || snapshot.checkoutCancelState === CHECKOUT_CANCEL_STATE.EXPIRE_REQUESTED) {
      return fail_('CHECKOUT_EXPIRE_UNCONFIRMED', '取消した予約の決済URLが失効したかを確認できていません。先に「決済URLの失効を再確認」を実行してください。');
    }
    if (isRefundInFlight_(snapshot)) {
      return fail_('REFUND_IN_PROGRESS', '返金の結果が確定していません。先に「返金状態を照会」で返金の記録を完了させてください。');
    }
    var paymentStatus = Booking.normalizePaymentStatus(snapshot.paymentStatus);
    if (!snapshot.stripePaymentIntentId || (paymentStatus !== PS.PAID && paymentStatus !== PS.REFUNDED)) {
      return fail_('RECOVERY_NOT_VERIFIABLE', '台帳の決済状態（' + (paymentStatus || '不明') + '）とPaymentIntentの記録からは、Stripeとの整合を自動で確認できません。' +
        'Stripe管理画面と台帳を照合し、Spreadsheet上で手動対応してください。');
    }
    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.secretKey) return fail_('STRIPE_NOT_CONFIGURED', 'Stripeの秘密鍵が設定されていないため確認できません。');

    var piResult = StripeGateway.retrievePaymentIntent(stripeConfig, snapshot.stripePaymentIntentId);
    var listResult = piResult.ok ? StripeGateway.listRefundsForPaymentIntent(stripeConfig, snapshot.stripePaymentIntentId) : null;
    if (!piResult.ok || !listResult || !listResult.ok) {
      return fail_('STRIPE_LOOKUP_FAILED', 'Stripeで決済・返金の状態を確認できませんでした。時間をおいてもう一度お試しください。');
    }
    var pi = piResult.paymentIntent;
    if (pi.id !== snapshot.stripePaymentIntentId || pi.status !== 'succeeded' ||
        Number(pi.amountReceived) !== Number(snapshot.stripeAmount) || pi.currency !== String(snapshot.stripeCurrency || '').toUpperCase()) {
      return fail_('RECOVERY_VERIFICATION_FAILED', 'Stripe上のPaymentIntentが台帳の入金記録と一致しません。解消できません。');
    }
    var active = listResult.refunds.filter(isActiveRefund_);
    var verdict;
    if (paymentStatus === PS.PAID) {
      if (active.length > 0) {
        verdict = fail_('RECOVERY_VERIFICATION_FAILED', 'Stripe上に台帳へ未記録の返金があります。「返金状態を照会」または調査を先に行ってください。');
      } else if (snapshot.status === Booking.STATUS.CONFIRMED) {
        verdict = null;
      } else if (isNoneDecidedAfterPayment_(snapshot)) {
        verdict = null;
      } else if (snapshot.refundDecision === DECISION.NONE) {
        verdict = fail_('RECOVERY_REFUND_DECISION_REQUIRED', '「返金なし」の判断は入金の確認（' + describeDate_(snapshot.paymentConfirmedAt) +
          '）より前に記録されたもので、この入金を対象にしていません。入金の事実を確認のうえ、「取消・返金」で返金方針（全額／一部／返金なし）を改めて判断してください。');
      } else {
        verdict = fail_('RECOVERY_REFUND_DECISION_REQUIRED', '入金済みですが予約は' + snapshot.status +
          'です。「取消・返金」で返金方法（全額／一部／返金なし）を決めてから解消してください。');
      }
    } else {
      var ours = active.filter(function (r) { return r.id === snapshot.stripeRefundId; });
      if (active.length !== 1 || ours.length !== 1 || ours[0].status !== 'succeeded' ||
          (ours[0].metadata && ours[0].metadata.refundAttemptId) !== snapshot.refundAttemptId) {
        verdict = fail_('RECOVERY_VERIFICATION_FAILED', 'Stripe上の返金が台帳の返金記録と一致しません。解消できません。');
      } else if (snapshot.status === Booking.STATUS.CONFIRMED || snapshot.status === Booking.STATUS.PENDING) {
        verdict = fail_('RECOVERY_VERIFICATION_FAILED', '返金済みですが予約が' + snapshot.status + 'のままです。先に予約の取消を完了させてください。');
      } else {
        verdict = null;
      }
    }
    if (verdict) return verdict;

    var locked = withLock_(LOCK_TIMEOUT_MS_, function () {
      var current = findRecord_(bookingId);
      if (!current) return fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId);
      if (!sameSnapshot_(snapshot, current)) return concurrentModification_();
      try {
        SpreadsheetRepository.updateBookingFields(bookingId, { paymentRecoveryRequiredAt: '', paymentRecoveryReason: '' });
      } catch (clearError) {
        Logger.log('BookingRefund: 要復旧フラグの解除に失敗しました: ' + bookingId);
      }
      var after = findRecord_(bookingId);
      if (!after || after.paymentRecoveryRequiredAt) {
        return fail_('RECOVERY_RESOLVE_FAILED', '要対応フラグの解除を保存できませんでした。もう一度お試しください。');
      }
      var resolvedCount = 0;
      try {
        resolvedCount = RecoveryRepository.resolveOpenPaymentRecords(bookingId, effectiveNow);
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'PAYMENT_RECOVERY_RESOLVED',
          occurredAt: effectiveNow,
          calendarEventId: current.calendarEventId || '',
          status: current.status || '',
          errorMessage: sanitize_('Stripeとの整合を確認して解消（paymentStatus=' + paymentStatus + ', status=' + current.status + '）。メモ: ' + safeNote),
          recoveryState: 'RESOLVED',
          resolvedAt: effectiveNow
        });
      } catch (recoveryError) {
        Logger.log('BookingRefund: Recovery行の解消記録に失敗しました: ' + bookingId);
      }
      return { success: true, bookingId: bookingId, resolvedRecoveryRows: resolvedCount };
    });
    if (locked.lockTimeout) return lockTimeoutResponse_();
    return locked.value;
  }

  /*
   * listPaymentRecoveries() — 決済の要対応案件の一覧（Booking Admin表示用。読み取りのみ）。
   * 要復旧ゲートが立っている予約、返金の結果確認待ち・失敗の予約、OPENな決済系Recovery行が
   * ある予約を返す。表示するのは予約ID・予約状態・決済状態・Stripe識別子・理由・発生日時のみで、
   * 氏名・連絡先等は含めない（詳細は予約詳細で確認する）。
   */
  /*
   * 「返金なし」の判断が、この入金を認識した後（paymentConfirmedAtより後）に記録されたか。
   * 取消時点（入金前）の判断や、取消後に成立した遅延入金より前の判断では、Recoveryを解消できない
   * （PR-Dレビュー対応・1回目）。日時を読めない場合はfalse（解消しない側に倒す）。
   */
  function isNoneDecidedAfterPayment_(record) {
    if (record.refundDecision !== DECISION.NONE) return false;
    if (!isDateLike_(record.refundDecidedAt) || !isDateLike_(record.paymentConfirmedAt)) return false;
    return record.refundDecidedAt.getTime() > record.paymentConfirmedAt.getTime();
  }

  function describeDate_(value) {
    return isDateLike_(value) ? value.toISOString() : '日時不明';
  }

  function listPaymentRecoveries() {
    var openRows = {};
    RecoveryRepository.listAll().forEach(function (row) {
      if (row.recoveryState !== 'OPEN' || !RecoveryRepository.isPaymentFailureType(row.failureType)) return;
      if (!openRows[row.bookingId]) openRows[row.bookingId] = [];
      openRows[row.bookingId].push({ failureType: row.failureType, occurredAt: row.occurredAt, errorMessage: row.errorMessage });
    });
    var items = [];
    SpreadsheetRepository.getAllBookings().forEach(function (item) {
      var r = item.record;
      var rows = openRows[r.bookingId] || [];
      var refundAttention = !!r.refundAttemptId && r.refundAttemptState !== ATTEMPT_STATE.SUBMITTED;
      var refundPending = Booking.normalizePaymentStatus(r.paymentStatus) === PS.REFUND_PENDING;
      var checkoutAttention = r.checkoutCancelState === CHECKOUT_CANCEL_STATE.UNKNOWN ||
        r.checkoutCancelState === CHECKOUT_CANCEL_STATE.EXPIRE_REQUESTED || r.checkoutCancelState === CHECKOUT_CANCEL_STATE.PAYMENT_RECEIVED;
      if (!r.paymentRecoveryRequiredAt && !refundAttention && !refundPending && !checkoutAttention && rows.length === 0) return;
      delete openRows[r.bookingId];
      items.push({ record: r, openRecoveryRows: rows });
    });
    /* Bookings行が無いRecovery行（予約IDの無いWebhook記録等）も表示する。 */
    Object.keys(openRows).forEach(function (orphanId) {
      items.push({ record: { bookingId: orphanId }, openRecoveryRows: openRows[orphanId] });
    });
    return items;
  }

  return {
    DECISION: DECISION,
    ATTEMPT_STATE: ATTEMPT_STATE,
    RESERVED_IN_FLIGHT_MS: RESERVED_IN_FLIGHT_MS_,
    cancelWithRefund: cancelWithRefund,
    reconcileRefund: reconcileRefund,
    reconcileCheckoutExpiry: reconcileCheckoutExpiry,
    CHECKOUT_CANCEL_STATE: CHECKOUT_CANCEL_STATE,
    resolvePaymentRecovery: resolvePaymentRecovery,
    listPaymentRecoveries: listPaymentRecoveries,
    isRefundInFlight: isRefundInFlight_
  };
})();
