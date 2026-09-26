/*
 * StripeWebhookHandler.gs — Stripe Webhookイベント（署名検証・中継基盤認証済み）を実際に
 * 処理するオーケストレーション本体（Issue #341 PR-C。レビュー対応・1回目でデプロイ先を
 * 再設計）。
 *
 * 呼び出し元（gas/booking/webhook/Code.gs。独立したBooking Webhookプロジェクトの
 * 公開Web Appエントリポイント）は、StripeWebhookAuth.verifyRelayRequestで中継基盤からの
 * 呼び出し自体を認証した**後**にのみこのファイルのprocessEventを呼ぶこと。このファイル
 * 自身は認証を一切行わない（責務を分離する）。
 *
 * 【重要・デプロイ先について（レビュー対応・1回目で変更）】
 * このファイルは**独立した新しいBooking Webhookプロジェクト**（`gas/booking/webhook/`）
 * へデプロイし、Booking Admin・Booking Web Appのいずれにも追加しない。
 *
 * 初版（PR-C初回提出）ではBookingAdminWeb.gs（管理者専用UI。doGet）と同じBooking Admin
 * プロジェクトへ`doPost`を追加し、既存デプロイとは別の「Anyone」アクセスのデプロイを
 * 公開する設計にしていたが、レビュー指摘により撤回した：Apps Scriptの複数デプロイは
 * 同一プロジェクトの**同じコード**を異なるURL・異なるアクセス設定で公開するだけであり、
 * `doGet`/`google.script.run`で公開される関数はプロジェクト単位で共通である。そのため
 * Webhook用に新設した「Anyone」デプロイのURLへ**GETでアクセスするだけ**で、本来
 * 「Execute as: Me / Only myself」のはずの管理者専用UI（`BookingAdminWeb.gs`の
 * `doGet`が返すHTML、およびそのページが`google.script.run`で呼ぶ`getAdminBookings`/
 * `adminConfirmBooking`/`adminCancelBooking`等）が誰でも閲覧・実行できてしまう
 * （「Stripeの署名検証を済ませたことだけを理由に、GASの公開エンドポイントを無認証で
 * 呼べる設計にしない」以前の問題として、意図せず既存の管理者専用UIまで公開してしまう
 * 設計ミスだった）。
 *
 * 独立プロジェクト化により、このプロジェクトのコンパイル済みバンドルには`BookingAdmin.gs`/
 * `BookingAdminWeb.gs`/`BookingTriggers.gs`等の管理者向けファイルが一切含まれない
 * （`test/helpers/booking-deployment-manifest.js`の`BOOKING_WEBHOOK_FILES`参照）ため、
 * `doGet`自体が定義されず、管理者UI・確定・取消・メール送信等の関数はこのプロジェクトの
 * URLからは構造的に到達不可能になる（`test/booking-webhook-deployment.test.js`で検証）。
 *
 * 【失効処理（expirePendingBookings）との競合について（レビュー対応・1回目で再設計）】
 * このプロジェクトはBooking Adminプロジェクトとは別のスクリプトであるため、
 * `LockService.getScriptLock()`はBooking Adminの`expirePendingBookings`とは**共有されない**
 * （GASのLockServiceはスクリプトプロジェクト単位）。そのため「同一LockServiceによる
 * 完全な排他」はもはや前提にできない。代わりに以下の多層防御で競合の実害を防ぐ：
 *
 * 1. 双方とも、破壊的な書き込み（Calendar削除+EXPIRED確定 / Calendar更新+CONFIRMED確定）
 *    の直前に、自分のLock内で予約の最新状態を再読込する（`expirePendingBookings`・
 *    `confirmBookingLocked_`いずれも既存の設計のまま）。これにより、一方が完全に完了して
 *    から他方が読む限り、後発側は必ず先発側の結果を検知して安全側に倒れる。
 * 2. `expirePendingBookings`は、`paymentHoldExpiresAt`を過ぎてから追加の猶予
 *    （`CardPayment.WEBHOOK_RACE_GRACE_MINUTES`。既定10分）が経過するまで、
 *    checkout_pendingの仮押さえを失効対象にしない。Stripeへの決済完了直後にWebhookが
 *    届くまでの時間（通常は数秒〜数十秒）に対して十分な余裕を持たせることで、
 *    「支払い成立の直後に枠を解放してしまう」窓を実務上ほぼ消滅させる（BookingRepository.gs
 *    のexpirePendingBookingsコメント参照）。
 * 3. `Booking.PAYMENT_STATUS_TRANSITIONS_`は`failed→paid`を許可する。仮に
 *    `expirePendingBookings`が先に完了して`paymentStatus:failed`・`status:EXPIRED`へ
 *    進めてしまっていても、その後に届いたWebhookは入金の事実（`paymentStatus:paid`）を
 *    正しく記録できる（`status`は`EXPIRED`のまま変更しない。`confirmBooking`が
 *    `EXPIRED`を拒否するため自動確定はされず、`paymentRecoveryRequiredAt`を立てて
 *    Recoveryへ記録し運営者の確認を必須にする。「失効後の入金記録」節参照）。
 * 4. 上記1〜3をもってしても理論上ゼロにはならない、極めて狭い残存レース
 *    （両者のLock内再読込が数百ミリ秒未満の間隔で重なる場合）は、既存のcreateBooking対
 *    スペースマーケット外部書き込みと同種の「絶対に競合しないではなく、直前再確認と
 *    Recovery記録でリスクを最小化する」設計として受容する（README「Webhookと失効処理の
 *    競合（再設計）」参照）。
 *
 * 【処理方針】
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
 * 【Stripeへの成功応答の条件】processEventの戻り値ackSuccess:trueは「StripeEventsへの
 * 最終状態の書き込み（StripeEventRepository.finalize）まで完了した」場合にのみtrueになる
 * （finalize自体の書き込みが失敗した場合はackSuccess:falseを返し、行はRECEIVEDのまま
 * 残る。次回の配信で安全に再開できる）。呼び出し元は、ackSuccess:falseの場合は中継基盤
 * ・Stripeへエラー応答を返し、Stripeの自動再送に委ねること。GAS Web Appの制約上
 * doPost自体のHTTPステータスは常に200になるため、実際の成否はレスポンスJSONの
 * success相当のフィールドで中継基盤へ伝える（README参照）。
 */
'use strict';

var StripeWebhookHandler = (function () {
  var RELEVANT_SUCCESS_TYPES_ = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  var FAILURE_TYPES_ = ['checkout.session.async_payment_failed'];

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

  function outcome_(ackSuccess, code, message) {
    return { ackSuccess: ackSuccess, code: code, message: message };
  }

  /*
   * StripeEventRepository.finalizeの書き込み自体が失敗した場合は、成功したものとみなさず
   * ackSuccess:falseを返す（ファイル冒頭コメント「Stripeへの成功応答の条件」参照）。
   * fields.processingStateにはCOMPLETED/IGNORED/REJECTEDのいずれかを渡すこと。
   */
  function finalizeAndAck_(rowNumber, fields, now, ackCode, ackMessage) {
    try {
      StripeEventRepository.finalize(rowNumber, fields, now);
    } catch (finalizeError) {
      Logger.log('StripeWebhookHandler: イベント処理結果の永続化に失敗しました: ' + describeError_(finalizeError));
      return outcome_(false, 'LEDGER_WRITE_FAILED', 'イベント処理結果の永続化に失敗しました。再試行します。');
    }
    return outcome_(true, ackCode, ackMessage);
  }

  /* 予約に紐付けられない、または再送しても解決しない構造的な問題をRecoveryへ記録した上で
     REJECTEDとして確定する（Stripeへは成功応答。再送しても結果は変わらないため）。 */
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
    return finalizeAndAck_(rowNumber, {
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
    return finalizeAndAck_(rowNumber, {
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
      return finalizeAndAck_(rowNumber, {
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
      return finalizeAndAck_(rowNumber, {
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
    return finalizeAndAck_(rowNumber, {
      processingState: StripeEventRepository.STATE.COMPLETED,
      bookingId: bookingId, paymentAttemptId: paymentAttemptId,
      outcomeCode: 'MARKED_FAILED', outcomeMessage: '決済試行をfailedへ更新しました。'
    }, now, 'MARKED_FAILED', '決済試行をfailedへ更新しました。');
  }

  /*
   * rawBody: 中継基盤の認証を通過した後の、Stripe Webhookイベントの生JSON文字列
   *   （呼び出し元がStripeWebhookAuth.verifyRelayRequestで検証済みであること）。
   * now: テストからの固定時刻注入用（省略時はnew Date()）。
   * 戻り値: { ackSuccess, code, message }。ackSuccess:trueの場合のみ、呼び出し元は
   *   中継基盤・Stripeへ成功を伝えてよい。
   */
  function processEvent(rawBody, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();

    var parsed = safeJsonParse_(rawBody);
    if (!parsed || typeof parsed !== 'object') {
      return outcome_(false, 'INVALID_EVENT_JSON', 'イベント本文を解析できませんでした。');
    }
    var eventId = typeof parsed.id === 'string' ? parsed.id : '';
    var eventType = typeof parsed.type === 'string' ? parsed.type : '';
    if (!eventId || !eventType) {
      return outcome_(false, 'INVALID_EVENT_SHAPE', 'イベントid/typeが指定されていません。');
    }

    var claimResult = StripeEventRepository.claim(eventId, eventType, effectiveNow);
    if (claimResult.outcome === 'LOCK_TIMEOUT') {
      return outcome_(false, 'LOCK_TIMEOUT', '一時的に混み合っています。再試行します。');
    }
    if (claimResult.outcome === 'IN_PROGRESS') {
      /* 同一イベントの並行配信。もう一方の処理に委ね、二重実行しない
         （Issue #341本文「同じイベントが同時に2件届いても...二重実行されないように」）。 */
      return outcome_(false, 'IN_PROGRESS', '同一イベントを処理中です。再試行します。');
    }
    if (claimResult.outcome === 'ALREADY_TERMINAL') {
      /* 同一イベントの再送。既に確定した結果をそのまま成功として返す（二重処理しない）。 */
      return outcome_(true, 'ALREADY_' + claimResult.record.processingState, 'このイベントは処理済みです。');
    }

    var rowNumber = claimResult.rowNumber;
    var objectData = parsed.data && parsed.data.object;

    var isSuccessType = RELEVANT_SUCCESS_TYPES_.indexOf(eventType) !== -1;
    var isFailureType = FAILURE_TYPES_.indexOf(eventType) !== -1;
    if (!isSuccessType && !isFailureType) {
      return finalizeAndAck_(rowNumber, {
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
     * 決めつけず、finalizeせずにRECEIVEDのまま再試行可能な状態で終える
     * （Issue #341本文「Stripeへの照会が失敗した場合は、未払いと決めつけず再試行可能な
     * 状態で記録してください」）。
     */
    var stripeConfig = BookingConfig.getStripeConfig();
    var sessionResult = StripeGateway.retrieveCheckoutSession(stripeConfig, objectData.id);
    if (!sessionResult.ok) {
      Logger.log('StripeWebhookHandler: Checkout Session再取得に失敗しました eventId=' + eventId + ' errorType=' + sessionResult.errorType);
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
      return finalizeAndAck_(rowNumber, {
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
    var record = found.record;

    if (record.paymentRecoveryRequiredAt) {
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
    if (record.brand !== brand || record.paymentAttemptId !== paymentAttemptId || record.stripeCheckoutSessionId !== session.id) {
      recordPaymentRecoveryGate_(
        bookingId, record, 'STRIPE_WEBHOOK_IDENTITY_MISMATCH',
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
      Logger.log('StripeWebhookHandler: PaymentIntent再取得に失敗しました eventId=' + eventId + ' errorType=' + piResult.errorType);
      return outcome_(false, 'STRIPE_LOOKUP_FAILED', 'Stripeへの照会に失敗しました。再試行します。');
    }
    var paymentIntent = piResult.paymentIntent;

    if (paymentIntent.status !== 'succeeded') {
      recordPaymentRecoveryGate_(
        bookingId, record, 'PAYMENT_INTENT_STATUS_MISMATCH',
        'Checkout Session（' + session.id + '）はpayment_status=paidと報告していますが、対応するPaymentIntent（' +
          paymentIntent.id + '）のstatusはsucceededではありません（' + paymentIntent.status + '）。Session完了と' +
          '入金完了を同一視せず、自動処理を停止しました。',
        effectiveNow
      );
      return rejectFinalizeOnly_(rowNumber, bookingId, 'PAYMENT_INTENT_STATUS_MISMATCH', 'PaymentIntentのstatusが一致しないため要復旧としました。', effectiveNow);
    }

    /* 金額照合はCheckout Session発行時点のスナップショット基準（現在の料金を再計算しない）。 */
    var verify = CardPayment.verifyPaymentAgainstSnapshot(record, paymentIntent.amountReceived, paymentIntent.currency);
    if (!verify.valid) {
      recordPaymentRecoveryGate_(
        bookingId, record, 'STRIPE_WEBHOOK_AMOUNT_MISMATCH',
        '決済成功イベント（eventId=' + eventId + '）の金額・通貨（' + paymentIntent.amountReceived + ' ' + paymentIntent.currency +
          '）が、Checkout Session発行時点のスナップショット（' + record.stripeAmount + ' ' + record.stripeCurrency +
          '）と一致しません（' + verify.error.code + '）。入金の事実は保持したまま自動処理を停止しました。',
        effectiveNow
      );
      return rejectFinalizeOnly_(rowNumber, bookingId, verify.error.code, '金額・通貨が一致しないため要復旧としました。', effectiveNow);
    }

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
       * Stripe側では実際に入金が完了しているため、無条件に無視してはならない
       * （Issue #341本文「仮押さえが既に失効している」場合の自動確定停止・Recovery記録）。
       */
      recordPaymentRecoveryGate_(
        bookingId, record, 'STRIPE_WEBHOOK_PAYMENT_UPDATE_REJECTED',
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
       * 一切書き戻さず、運営者が確認できるようRecoveryへ記録する（Issue #341本文
       * 「決済済みでも予約を確定できない場合は、入金を消さずRecoveryへ記録し、運営者が
       * 確認できるようにする」）。自動返金の判断はPR-Dへ引き継ぐ。
       */
      recordPaymentRecoveryGate_(
        bookingId, record, 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED',
        '決済は完了しました（eventId=' + eventId + '）が、予約の自動確定ができませんでした（' +
          (confirmResult.error && confirmResult.error.code) + '）。入金は保持したまま自動処理を停止しました。' +
          '運営者による確認・対応が必要です（枠を確保できない場合の返金判断を含む）。',
        effectiveNow
      );
    }

    return finalizeAndAck_(rowNumber, {
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

  return {
    processEvent: processEvent
  };
})();
