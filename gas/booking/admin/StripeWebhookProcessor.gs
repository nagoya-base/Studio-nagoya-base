/*
 * StripeWebhookProcessor.gs — Booking Adminプロジェクトの時間主導トリガーから呼ばれる、
 * Stripe Webhookイベントの決済照合・予約自動確定オーケストレーション本体
 * （Issue #341 PR-C。レビュー対応・4回目で新設。旧`gas/booking/webhook/
 * StripeWebhookHandler.gs`から移動・再設計）。
 *
 * 【レビュー対応・4回目でのアーキテクチャ変更】1〜3回目までは、この処理を独立した
 * Booking WebhookプロジェクトのdoPost内で、Stripeからの1リクエストにつき1回、同期的に
 * 実行していた。Booking WebhookとexpirePendingBookingsを実行するBooking Adminは別々の
 * LockService.getScriptLock()を持つため、両者が同じ予約を並行して変更しないよう、予約
 * 単位の分散ロック（BookingLockRepository。共有Spreadsheet上のappendRow＋read-back方式）を
 * 3回目まで作り込んだ。しかし「ロックの有効性を確認してから実際にCalendar/Bookingsへ
 * 書き込むまでの間に、別の実行が新しいロックを取得して先に書き込みを完了させる可能性は
 * 残る（TOCTOU）。確認箇所を増やしてもこの種の競合は解消できない」という指摘を受け、
 * ロックの精緻化ではなくアーキテクチャ自体を見直した：
 *
 * - Booking Webhookプロジェクト（`gas/booking/webhook/`）は、署名検証済みイベントを
 *   `StripeEventRepository`（Booking Adminと共有するSpreadsheet上の「StripeEvents」
 *   シート）へ**安全に永続化するだけ**にする（決済照合・予約自動確定は一切行わない）。
 * - **この処理本体（`processPendingStripeWebhookEvents`）はBooking Adminプロジェクトの
 *   時間主導トリガーから呼ばれ**、`StripeEventRepository`から未処理（RECEIVED）の
 *   イベントを取り出し、決済照合〜予約自動確定まで行う。
 *
 * これにより、この処理と既存の`expirePendingBookings`はどちらもBooking Admin
 * プロジェクト内で実行され、**同じLockService.getScriptLock()を共有する**。
 * `BookingRepository.applyPaymentStateUpdate`・`confirmBooking`はいずれも内部で
 * このLockを取得・解放し、`expirePendingBookings`も候補ごとに同じLockを取得・解放する
 * ため、confirmBooking（既存の管理者手動確定）とexpirePendingBookingsが既に共有している
 * のと全く同じ仕組みで、Webhook由来の確定と失効処理が同じ予約を同時に処理することは
 * 構造的に発生しない（GAS公式のLockServiceの排他保証だけに依存し、Sheetsのappend順序
 * 整列のような未保証の前提には一切依存しない）。この2つの操作それぞれが元々持つ
 * 「書き込み直前の最新状態再読込」（`confirmBooking`のEXPIRED拒否・`expirePendingBookings`
 * のpaymentStatus再読込）と組み合わさることで、一方がLockを保持して書き込みを完了させた
 * 後にもう一方がLockを取得しても、後発側は必ず先発側の結果を検知して安全側に倒れる
 * （詳細はREADME「Webhookと失効処理の競合」節・`BookingRepository.gs`の
 * expirePendingBookingsコメント参照）。
 *
 * 【処理の流れ】`processPendingStripeWebhookEvents(now)`が`BookingTriggers.gs`の時間主導
 * トリガー（既定1分間隔）から呼ばれ、`StripeEventRepository.listPendingWithBody()`で
 * 処理対象（RECEIVED・rawBody保存済み）を一覧し、候補ごとに
 * `StripeEventRepository.claimForProcessing()`で着手権を確保してから`processSingleEvent_`を
 * 呼ぶ。`claimForProcessing()`はBooking Admin側のトリガー実行が重複した場合の二重処理を
 * 防ぐ（Webhook側の重複受信防止に使う`claim()`とは意図的に別の名前空間を持つ。
 * `StripeEventRepository.gs`冒頭コメント参照）。
 *
 * 【処理方針（変更なし）】
 * - Session完了（event.data.objectのpayment_status）とPaymentIntentの入金完了
 *   （StripeGateway.retrievePaymentIntentで改めて取得したstatus==='succeeded'）を
 *   同一視しない（Issue #341本文「4. Stripeイベント種別」）。
 * - Webhookイベント本文だけで完結させず、Checkout Session・PaymentIntentともに
 *   Stripe APIから改めて取得した最新状態を正として使う（イベント本文のmetadataではなく
 *   再取得したsession.metadataを使う。同一イベントの古い/新しい配信の違いを問わず、
 *   常に「今のStripeの実際の状態」で判定する）。
 * - 金額照合にはCardPayment.verifyPaymentAgainstSnapshot（Checkout Session発行時点の
 *   スナップショット基準）を使う。現在の料金を再計算しない。
 * - paidへの状態更新にはBookingRepository.applyPaymentStateUpdateのみを使う
 *   （stripePaymentIntentId・lastStripeEventIdを必ず添える）。
 * - 予約の自動確定には既存のBookingRepository.confirmBookingをそのまま再利用する
 *   （確定メール送信・冪等性・Recovery記録は既存実装に委ねる。新しい確定ロジックを
 *   作らない）。
 * - 決済済みでも確定できない場合は、paymentStatus=paidを維持したまま
 *   paymentRecoveryRequiredAtを立て、運営者が確認できるようにする（入金の事実を
 *   消さない。自動返金はPR-Dの対象）。
 *
 * 【Stripeへの応答との関係】この関数はStripeへの応答とは無関係（Stripeへの応答は
 * Booking Webhookプロジェクトが受信した時点で完結している。冒頭コメント参照）。
 * ここでの処理結果（COMPLETED/IGNORED/REJECTED、または未完了のままRECEIVED維持）は
 * StripeEventRepositoryとRecoveryにのみ記録され、運営者が確認する。
 */
'use strict';

var StripeWebhookProcessor = (function () {
  var RELEVANT_SUCCESS_TYPES_ = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  var FAILURE_TYPES_ = ['checkout.session.async_payment_failed'];

  /*
   * Booking Admin側のトリガー実行が重複した場合の二重処理防止に使う
   * claimForProcessing()のstaleAfterMs。Webhook側の新規受信の重複防止に使うclaim()の
   * staleAfterMs（既定5分。StripeEventRepository.DEFAULT_STALE_AFTER_MS_相当）とは
   * 別の名前空間（processingClaimedAt/processingClaimCount）を使うため、この値の大小が
   * Webhook側の挙動へ影響することはない（詳細はStripeEventRepository.gs冒頭コメント
   * 「なぜ2つの関数に分けたか」参照）。トリガー間隔（既定1分。BookingTriggers.gs参照）より
   * 少し長い程度にすることで、(a) 前回のトリガー実行がまだ処理中の間は再claimさせず
   * 二重処理を防ぎつつ、(b) 一時的な失敗（Stripe API障害等）で終わった候補も数分以内に
   * 再試行できるようにする。
   */
  var ADMIN_CLAIM_STALE_AFTER_MS_ = 2 * 60 * 1000;

  /* BookingRepository.applyPaymentStateUpdateが失敗時に自分自身で既にRecoveryRepositoryへ
     記録済み（recordPaymentRecoveryBestEffort_/recordPaymentEvidenceAuditBestEffort_）の
     エラーコード一覧。これらについてはこのファイル側で重複記録しない。ここに無いコード
     （代表例: INVALID_PAYMENT_TRANSITION）はapplyPaymentStateUpdate側が記録しないため、
     Stripe側で実際に入金が完了している可能性を踏まえてこのファイル側で必ず記録する。 */
  var SELF_RECORDING_PAYMENT_UPDATE_ERROR_CODES_ = [
    'UNKNOWN_PAYMENT_STATUS', 'PAYMENT_IDENTITY_MISMATCH', 'PAYMENT_IDENTITY_UNCONFIRMED',
    'PAYMENT_EVIDENCE_MISSING', 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT'
  ];

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function describeError_(error) {
    return String((error && error.message) || error);
  }

  function safeJsonParse_(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
      return JSON.parse(text);
    } catch (parseError) {
      return null;
    }
  }

  function outcome_(finalized, code, message) {
    return { finalized: finalized, code: code, message: message };
  }

  /*
   * StripeEventRepository.finalizeの書き込み自体が失敗した場合、行はRECEIVEDのまま残り、
   * 次回のトリガー実行で（ADMIN_CLAIM_STALE_AFTER_MS_経過後に）安全に再開できる。
   * fields.processingStateにはCOMPLETED/IGNORED/REJECTEDのいずれかを渡すこと。
   */
  function finalizeOutcome_(rowNumber, fields, now, code, message) {
    try {
      StripeEventRepository.finalize(rowNumber, fields, now);
    } catch (finalizeError) {
      Logger.log('StripeWebhookProcessor: イベント処理結果の永続化に失敗しました: ' + describeError_(finalizeError));
      return outcome_(false, 'LEDGER_WRITE_FAILED', 'イベント処理結果の永続化に失敗しました。再試行します。');
    }
    return outcome_(true, code, message);
  }

  /* 予約に紐付けられない、または再送しても解決しない構造的な問題をRecoveryへ記録した上で
     REJECTEDとして確定する。 */
  function rejectAndFinalize_(rowNumber, bookingId, code, message, now) {
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId || '',
        failureType: 'STRIPE_WEBHOOK_' + code,
        occurredAt: now,
        calendarEventId: '',
        status: '',
        errorMessage: message,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }
    return finalizeOutcome_(rowNumber, {
      processingState: StripeEventRepository.STATE.REJECTED,
      bookingId: bookingId || '',
      outcomeCode: code,
      outcomeMessage: message
    }, now, code, message);
  }

  /* rejectAndFinalize_からRecoveryRepository呼び出しを除いた版。呼び出し元が
     recordPaymentRecoveryGate_で既にRecovery記録・恒久ゲートを立てている場合に使う
     （二重記録を避ける）。 */
  function rejectFinalizeOnly_(rowNumber, bookingId, code, message, now) {
    return finalizeOutcome_(rowNumber, {
      processingState: StripeEventRepository.STATE.REJECTED,
      bookingId: bookingId || '',
      outcomeCode: code,
      outcomeMessage: message
    }, now, code, message);
  }

  /*
   * 予約に対する恒久の要復旧ゲート（BookingRepository.applyPaymentStateUpdateが内部で使う
   * recordPaymentRecoveryBestEffort_と同じ設計。異なるファイルのprivateヘルパーを直接
   * 共有できないため、CardPayment.gs冒頭コメントの方針どおりここに複製する）。以後、この
   * bookingIdへのapplyPaymentStateUpdate/beginCardCheckoutの呼び出しはすべて
   * PAYMENT_RECOVERY_REQUIREDとして拒否されるようになる（confirmBooking/
   * cancelBookingAdmin/reviveExpiredBookingはこのゲートの対象外のため、管理者は引き続き
   * 手動でこれらの操作を行える）。
   */
  function recordPaymentRecoveryGate_(bookingId, record, failureType, reason, now) {
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        paymentRecoveryRequiredAt: now,
        paymentRecoveryReason: reason
      });
    } catch (writeError) {
      Logger.log('paymentRecoveryRequiredAtの記録に失敗しました: ' + bookingId + ' ' + describeError_(writeError));
    }
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: failureType,
        occurredAt: now,
        calendarEventId: (record && record.calendarEventId) || '',
        status: (record && record.status) || '',
        errorMessage: reason,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + bookingId + ' ' + failureType + ' ' + describeError_(recoveryError));
    }
  }

  /*
   * checkout.session.async_payment_failed（非同期決済方法が有効な場合に備えた設計。
   * Issue #341本文「非同期決済が有効になり得る場合はasync_payment_succeeded等の扱いも
   * 設計してください」）。対象の決済試行がまだ現在の決済試行のままCHECKOUT_PENDINGで
   * ある場合のみFAILEDへ進め、次回の申込で新しい決済試行IDを発行できるようにする。
   */
  function handleAsyncPaymentFailed_(rowNumber, eventId, session, bookingId, paymentAttemptId, now) {
    if (session.paymentStatus === 'paid') {
      /* 既に別の成功イベントでpaidへ進んでいる（順序逆転で失敗通知が後から届いた）。
         成功を巻き戻さない。 */
      return finalizeOutcome_(rowNumber, {
        processingState: StripeEventRepository.STATE.IGNORED,
        bookingId: bookingId, paymentAttemptId: paymentAttemptId,
        outcomeCode: 'SUPERSEDED_BY_SUCCESS', outcomeMessage: '決済は既に成功しているため失敗通知を無視しました。'
      }, now, 'SUPERSEDED_BY_SUCCESS', '決済は既に成功しています。');
    }
    if (!bookingId) {
      return rejectAndFinalize_(rowNumber, '', 'METADATA_MISSING', '非同期決済失敗イベントにmetadata.bookingIdがありません。sessionId=' + session.id, now);
    }
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return rejectAndFinalize_(rowNumber, bookingId, 'BOOKING_NOT_FOUND', '対応する予約が見つかりません。bookingId=' + bookingId, now);
    }
    var record = found.record;
    var currentPaymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    var isCurrentAttempt = record.paymentAttemptId === paymentAttemptId && record.stripeCheckoutSessionId === session.id;
    if (!isCurrentAttempt || currentPaymentStatus !== Booking.PAYMENT_STATUS.CHECKOUT_PENDING) {
      /* 既に別の決済試行へ進んでいる、または既に解決済み（failed/paid等）。何もしない。 */
      return finalizeOutcome_(rowNumber, {
        processingState: StripeEventRepository.STATE.IGNORED,
        bookingId: bookingId, paymentAttemptId: paymentAttemptId,
        outcomeCode: 'STALE_OR_ALREADY_RESOLVED', outcomeMessage: '既に別の決済試行へ進んでいるか解決済みのため何もしませんでした。'
      }, now, 'STALE_OR_ALREADY_RESOLVED', '対応不要です。');
    }

    var failResult = BookingRepository.applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.FAILED, { paymentAttemptResolvedAt: now }, now);
    if (!failResult.success) {
      var failCode = failResult.error && failResult.error.code;
      if (failCode === 'LOCK_TIMEOUT' || failCode === 'PAYMENT_DETAIL_WRITE_FAILED') {
        return outcome_(false, failCode, '一時的に決済状態を更新できませんでした。再試行します。');
      }
      if (failCode === 'PAYMENT_RECOVERY_REQUIRED') {
        /* 既に別の理由で恒久ゲートが立っている。ここで重複してRecoveryへ記録しない。 */
        return rejectFinalizeOnly_(rowNumber, bookingId, failCode, '既に要復旧のため何もしませんでした。', now);
      }
      return rejectAndFinalize_(rowNumber, bookingId, failCode || 'PAYMENT_UPDATE_FAILED', '決済失敗状態への更新に失敗しました: ' + failCode, now);
    }
    return finalizeOutcome_(rowNumber, {
      processingState: StripeEventRepository.STATE.COMPLETED,
      bookingId: bookingId, paymentAttemptId: paymentAttemptId,
      outcomeCode: 'MARKED_FAILED', outcomeMessage: '決済試行をfailedへ更新しました。'
    }, now, 'MARKED_FAILED', '決済試行をfailedへ更新しました。');
  }

  /*
   * rowNumber/record: StripeEventRepository.claimForProcessing()が返したもの（record.rawBodyに
   * Stripe Webhookイベントの生JSON文字列が保存済み）。
   * now: テストからの固定時刻注入用（省略時はnew Date()）。
   * 戻り値: { finalized, code, message }。finalized:trueの場合、StripeEventsは終端状態
   *   （COMPLETED/IGNORED/REJECTED）まで書き込まれている。falseの場合は行がRECEIVEDの
   *   まま残り、次回のトリガー実行で安全に再試行される。
   */
  function processSingleEvent_(rowNumber, record, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var eventId = record.eventId;
    var eventType = record.eventType;

    var parsed = safeJsonParse_(record.rawBody);
    if (!parsed || typeof parsed !== 'object') {
      /* 通常は起こり得ない（受信時にBooking Webhook側でJSON.parseが成功した本文だけを
         保存するため）。台帳の破損等、想定外の事態として構造的な問題扱いにする。 */
      return rejectAndFinalize_(rowNumber, '', 'INVALID_STORED_EVENT_JSON', '保存済みのイベント本文を解析できませんでした。eventId=' + eventId, effectiveNow);
    }

    var objectData = parsed.data && parsed.data.object;

    var isSuccessType = RELEVANT_SUCCESS_TYPES_.indexOf(eventType) !== -1;
    var isFailureType = FAILURE_TYPES_.indexOf(eventType) !== -1;
    if (!isSuccessType && !isFailureType) {
      return finalizeOutcome_(rowNumber, {
        processingState: StripeEventRepository.STATE.IGNORED,
        outcomeCode: 'UNHANDLED_EVENT_TYPE', outcomeMessage: 'このイベント種別は対象外です: ' + eventType
      }, effectiveNow, 'IGNORED_EVENT_TYPE', '対象外のイベント種別です。');
    }

    if (!objectData || typeof objectData.id !== 'string' || !objectData.id) {
      return rejectAndFinalize_(rowNumber, '', 'INVALID_EVENT_OBJECT', 'イベント本文にCheckout Session IDが含まれていません。eventId=' + eventId, effectiveNow);
    }

    /*
     * イベント本文だけで完結させず、常にStripe APIから最新のCheckout Session状態を
     * 再取得する（ファイル冒頭コメント参照）。再取得自体が失敗した場合は未払いと
     * 決めつけず、finalizeせずにRECEIVEDのまま再試行可能な状態で終える。
     */
    var stripeConfig = BookingConfig.getStripeConfig();
    var sessionResult = StripeGateway.retrieveCheckoutSession(stripeConfig, objectData.id);
    if (!sessionResult.ok) {
      Logger.log('StripeWebhookProcessor: Checkout Session再取得に失敗しました eventId=' + eventId + ' errorType=' + sessionResult.errorType);
      return outcome_(false, 'STRIPE_LOOKUP_FAILED', 'Stripeへの照会に失敗しました。再試行します。');
    }
    var session = sessionResult.session;
    var metadata = session.metadata || {};
    var bookingId = typeof metadata.bookingId === 'string' ? metadata.bookingId : '';
    var paymentAttemptId = typeof metadata.paymentAttemptId === 'string' ? metadata.paymentAttemptId : '';
    var brand = typeof metadata.brand === 'string' ? metadata.brand : '';

    if (isFailureType) {
      return handleAsyncPaymentFailed_(rowNumber, eventId, session, bookingId, paymentAttemptId, effectiveNow);
    }

    /*
     * Session完了とPaymentIntentの入金完了を同一視しない（Issue #341本文）。
     * session.paymentStatusが'paid'でない間は、まだ支払いが確定していない
     * （非同期決済方法が有効な場合の中間状態を含む）ため自動確定しない。
     */
    if (session.paymentStatus !== 'paid') {
      return finalizeOutcome_(rowNumber, {
        processingState: StripeEventRepository.STATE.IGNORED,
        bookingId: bookingId, paymentAttemptId: paymentAttemptId,
        outcomeCode: 'PAYMENT_NOT_YET_COMPLETE',
        outcomeMessage: 'Checkout Sessionの支払いはまだ完了していません（payment_status=' + session.paymentStatus + '）。'
      }, effectiveNow, 'PAYMENT_NOT_YET_COMPLETE', '決済はまだ完了していません。');
    }

    if (!bookingId || !paymentAttemptId || !brand) {
      return rejectAndFinalize_(rowNumber, bookingId, 'METADATA_MISSING', 'Checkout Sessionのmetadataが不足しています（bookingId/paymentAttemptId/brand）。sessionId=' + session.id, effectiveNow);
    }

    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return rejectAndFinalize_(rowNumber, bookingId, 'BOOKING_NOT_FOUND', '対応する予約が見つかりません。bookingId=' + bookingId + ' sessionId=' + session.id, effectiveNow);
    }
    var record2 = found.record;

    if (record2.paymentRecoveryRequiredAt) {
      /* 既に別の理由で恒久の要復旧ゲートが立っている予約。無駄なStripe API呼び出し・
         重複したRecovery記録を避けるためここで打ち切る（後段のapplyPaymentStateUpdateも
         同じ理由でPAYMENT_RECOVERY_REQUIREDを返すが、PaymentIntent再取得等を省略できる）。 */
      return rejectFinalizeOnly_(rowNumber, bookingId, 'PAYMENT_RECOVERY_REQUIRED', '既に要復旧のため何もしませんでした。', effectiveNow);
    }

    /*
     * 予約ID・ブランド・Checkout Session ID・決済試行IDのすべてが台帳の記録と一致する
     * ことを確認する（Issue #341本文「5. 予約・決済試行・金額の照合」）。1つでも
     * 食い違えば、既にこの予約が別の決済試行へ進んでいる（古いSessionの遅延配信）か、
     * 深刻な取り違えの可能性があるため、自動確定せず恒久の要復旧ゲートを立てる。
     */
    if (record2.brand !== brand || record2.paymentAttemptId !== paymentAttemptId || record2.stripeCheckoutSessionId !== session.id) {
      recordPaymentRecoveryGate_(
        bookingId, record2, 'STRIPE_WEBHOOK_IDENTITY_MISMATCH',
        '決済成功イベント（eventId=' + eventId + ', sessionId=' + session.id + '）の識別子（brand/決済試行ID/Session ID）が' +
          '台帳の記録と一致しません。二重決済・取り違えの可能性があるため、入金の事実は保持したまま自動処理を停止しました。' +
          'Stripe管理画面で実際の入金内容を確認してください。',
        effectiveNow
      );
      return rejectFinalizeOnly_(rowNumber, bookingId, 'IDENTITY_MISMATCH', '識別子が一致しないため要復旧としました。', effectiveNow);
    }

    /*
     * Session完了の事実と、PaymentIntentの入金完了を別々に確認する（同一視しない）。
     * session.paymentStatus==='paid'に加えて、Stripe APIから改めて取得した
     * PaymentIntent.status==='succeeded'も必須とする。
     */
    var piResult = StripeGateway.retrievePaymentIntent(stripeConfig, session.paymentIntentId);
    if (!piResult.ok) {
      Logger.log('StripeWebhookProcessor: PaymentIntent再取得に失敗しました eventId=' + eventId + ' errorType=' + piResult.errorType);
      return outcome_(false, 'STRIPE_LOOKUP_FAILED', 'Stripeへの照会に失敗しました。再試行します。');
    }
    var paymentIntent = piResult.paymentIntent;

    if (paymentIntent.status !== 'succeeded') {
      recordPaymentRecoveryGate_(
        bookingId, record2, 'PAYMENT_INTENT_STATUS_MISMATCH',
        'Checkout Session（' + session.id + '）はpayment_status=paidと報告していますが、対応するPaymentIntent（' +
          paymentIntent.id + '）のstatusはsucceededではありません（' + paymentIntent.status + '）。Session完了と' +
          '入金完了を同一視せず、自動処理を停止しました。',
        effectiveNow
      );
      return rejectFinalizeOnly_(rowNumber, bookingId, 'PAYMENT_INTENT_STATUS_MISMATCH', 'PaymentIntentのstatusが一致しないため要復旧としました。', effectiveNow);
    }

    /* 金額照合はCheckout Session発行時点のスナップショット基準（現在の料金を再計算しない）。 */
    var verify = CardPayment.verifyPaymentAgainstSnapshot(record2, paymentIntent.amountReceived, paymentIntent.currency);
    if (!verify.valid) {
      recordPaymentRecoveryGate_(
        bookingId, record2, 'STRIPE_WEBHOOK_AMOUNT_MISMATCH',
        '決済成功イベント（eventId=' + eventId + '）の金額・通貨（' + paymentIntent.amountReceived + ' ' + paymentIntent.currency +
          '）が、Checkout Session発行時点のスナップショット（' + record2.stripeAmount + ' ' + record2.stripeCurrency +
          '）と一致しません（' + verify.error.code + '）。入金の事実は保持したまま自動処理を停止しました。',
        effectiveNow
      );
      return rejectFinalizeOnly_(rowNumber, bookingId, verify.error.code, '金額・通貨が一致しないため要復旧としました。', effectiveNow);
    }

    /*
     * Issue #341 PR-Cレビュー対応・4回目: applyPaymentStateUpdate・confirmBookingは
     * いずれもBooking Admin自身のLockService.getScriptLock()を内部で取得・解放する
     * （BookingRepository.gs参照）。この関数自体がBooking Adminプロジェクトの一部として
     * 実行されるため、expirePendingBookingsと同じLockを自然に共有する。予約単位の
     * 分散ロックは一切不要（ファイル冒頭コメント参照）。
     */
    var paidResult = BookingRepository.applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.PAID, {
      stripePaymentIntentId: paymentIntent.id,
      lastStripeEventId: eventId,
      paymentConfirmedAt: effectiveNow
    }, effectiveNow);

    if (!paidResult.success) {
      var paidErrorCode = paidResult.error && paidResult.error.code;
      if (paidErrorCode === 'LOCK_TIMEOUT' || paidErrorCode === 'PAYMENT_DETAIL_WRITE_FAILED') {
        /* 何も書き込まれていない失敗のため、finalizeせず安全に再試行させる。 */
        return outcome_(false, paidErrorCode, '一時的に決済状態を更新できませんでした。再試行します。');
      }
      if (paidErrorCode === 'PAYMENT_RECOVERY_REQUIRED') {
        return rejectFinalizeOnly_(rowNumber, bookingId, paidErrorCode, '既に要復旧のため何もしませんでした。', effectiveNow);
      }
      if (SELF_RECORDING_PAYMENT_UPDATE_ERROR_CODES_.indexOf(paidErrorCode) !== -1) {
        /* PAYMENT_IDENTITY_MISMATCH・UNKNOWN_PAYMENT_STATUS・PAYMENT_STATUS_WRITE_FAILED_
           AFTER_DETAIL_COMMIT・PAYMENT_IDENTITY_UNCONFIRMED・PAYMENT_EVIDENCE_MISSING等は
           applyPaymentStateUpdate自身が既にRecoveryへ記録済み（BookingRepository.gs参照）。
           ここで重複記録はしない。 */
        return rejectFinalizeOnly_(rowNumber, bookingId, paidErrorCode || 'PAYMENT_UPDATE_FAILED', '決済状態の更新に失敗しました: ' + paidErrorCode, effectiveNow);
      }
      /*
       * INVALID_PAYMENT_TRANSITION（例: 仮押さえ失効・キャンセル等で既にpaymentStatusが
       * failedへ進んでいた後に、遅れて届いた決済成功イベント）等、applyPaymentStateUpdate
       * 自身は台帳側の不整合とみなさずRecoveryへ記録しないコードは、ここで明示的に記録する。
       * Stripe側では実際に入金が完了しているため、無条件に無視してはならない。
       */
      recordPaymentRecoveryGate_(
        bookingId, record2, 'STRIPE_WEBHOOK_PAYMENT_UPDATE_REJECTED',
        '決済成功イベント（eventId=' + eventId + '）を受信しましたが、決済状態を' + Booking.PAYMENT_STATUS.PAID +
          'へ更新できませんでした（' + paidErrorCode + '）。Stripe側では入金が完了している可能性が高いため、' +
          '入金の事実を消さず自動処理を停止しました。運営者による確認が必要です。',
        effectiveNow
      );
      return rejectFinalizeOnly_(rowNumber, bookingId, paidErrorCode || 'PAYMENT_UPDATE_FAILED', '決済状態の更新に失敗しました: ' + paidErrorCode, effectiveNow);
    }

    /*
     * 予約の最新状態を読み直したうえで、既存の予約確定処理をそのまま再利用する
     * （Issue #341本文「7. 決済成功後の予約自動確定」。confirmBookingLocked_自身が
     * Lock取得直後に最新のstatus・Calendarイベントの有無を再確認するため、ここで
     * 個別に再読込・再確認を重複実装しない）。
     */
    var confirmResult = BookingRepository.confirmBooking(bookingId);
    if (!confirmResult.success) {
      /*
       * 決済済みでも予約を確定できない（仮押さえ失効・キャンセル済み・Calendarイベント
       * 消失・料金訂正案内未送信・保存失敗等）。入金の事実（paymentStatus=paid）は
       * 一切書き戻さず、運営者が確認できるようRecoveryへ記録する。自動返金の判断は
       * PR-Dへ引き継ぐ。
       */
      recordPaymentRecoveryGate_(
        bookingId, record2, 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED',
        '決済は完了しました（eventId=' + eventId + '）が、予約の自動確定ができませんでした（' +
          (confirmResult.error && confirmResult.error.code) + '）。入金は保持したまま自動処理を停止しました。' +
          '運営者による確認・対応が必要です（枠を確保できない場合の返金判断を含む）。',
        effectiveNow
      );
    }

    return finalizeOutcome_(rowNumber, {
      processingState: StripeEventRepository.STATE.COMPLETED,
      bookingId: bookingId,
      paymentAttemptId: paymentAttemptId,
      stripePaymentIntentId: paymentIntent.id,
      outcomeCode: confirmResult.success ? 'CONFIRMED' : 'PAID_CONFIRM_BLOCKED',
      outcomeMessage: confirmResult.success
        ? '決済確認・予約自動確定が完了しました。'
        : ('決済は完了しましたが予約は自動確定できませんでした: ' + (confirmResult.error && confirmResult.error.code))
    }, effectiveNow, confirmResult.success ? 'CONFIRMED' : 'PAID_CONFIRM_BLOCKED',
      confirmResult.success ? '予約を自動確定しました。' : '決済は完了しましたが予約は自動確定できませんでした。');
  }

  /*
   * BookingTriggers.gsの時間主導トリガーから呼ばれるエントリポイント。
   * now: テストからの固定時刻注入用（省略時はnew Date()）。
   * 戻り値: { candidateCount, processedCount, skippedCount, results }。
   *   processedCount: 今回の実行で終端状態（COMPLETED/IGNORED/REJECTED）まで到達した件数。
   *   skippedCount: 着手権を取得できなかった（他の実行が処理中）、または今回は未完了に
   *     終わり次回のトリガー実行に委ねた件数。
   */
  function processPendingStripeWebhookEvents(now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var pending = StripeEventRepository.listPendingWithBody();
    var processedCount = 0;
    var skippedCount = 0;
    var results = [];

    pending.forEach(function (item) {
      var claimResult = StripeEventRepository.claimForProcessing(item.record.eventId, item.record.eventType, effectiveNow, ADMIN_CLAIM_STALE_AFTER_MS_);
      if (claimResult.outcome !== 'CLAIMED') {
        /* IN_PROGRESS: 別のトリガー実行が処理中（重複実行防止）。
           ALREADY_TERMINAL: listPendingWithBody取得後、別の実行が既に完了させた。
           LOCK_TIMEOUT: 一時的な混雑。 */
        skippedCount++;
        return;
      }
      var result = processSingleEvent_(claimResult.rowNumber, claimResult.record, effectiveNow);
      results.push(Object.assign({ eventId: item.record.eventId }, result));
      if (result.finalized) {
        processedCount++;
      } else {
        skippedCount++;
      }
    });

    return {
      candidateCount: pending.length,
      processedCount: processedCount,
      skippedCount: skippedCount,
      results: results
    };
  }

  return {
    processPendingStripeWebhookEvents: processPendingStripeWebhookEvents
  };
})();
