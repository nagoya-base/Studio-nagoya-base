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
 * 【失効処理（expirePendingBookings）との競合について（レビュー対応・2回目で導入、
 * 3回目でバグ修正・前提の見直し）】
 * このプロジェクトはBooking Adminプロジェクトとは別のスクリプトであるため、
 * `LockService.getScriptLock()`はBooking Adminの`expirePendingBookings`とは**共有されない**
 * （GASのLockServiceはスクリプトプロジェクト単位）。
 *
 * レビュー対応・1回目の多層防御（最新状態再読込・追加猶予・`failed→paid`遷移の許可）では
 * 「一方が最新状態を読み終えた直後に他方が状態を変更する」レースを排除できないという
 * 指摘を受け、2回目で`BookingLockRepository`（Booking Webhook・Booking Adminの両プロジェクトが
 * 共有するBookings台帳と同じSpreadsheet上の予約単位ロック）を導入した。3回目のレビューで、
 * この実装に「チケット行の取り違え」「TTL経過後も古い保持者が書き込みを続けられる」という
 * 実装バグと、「Sheetsのappend順序整列を公式に保証された契約として前提にしている」という
 * 設計上の指摘を受け、両方を修正した（詳細は`BookingLockRepository.gs`冒頭コメント参照）。
 *
 * `processEvent`は、`applyPaymentStateUpdate`（paid）〜`confirmBooking`の一連
 * （Stripe API呼び出しはすべてこれより前に完了済み）を`BookingLockRepository`で保護する。
 * 取得できない場合は短い間隔で数回だけ再試行し（`acquireBookingLockWithRetry_`）、それでも
 * 取得できなければStripeの自動再送に委ねる（`BOOKING_LOCK_CONTENDED`。イベント台帳は
 * RECEIVEDのまま残る）。**保護区間内でも、実際にBookings/Calendarへ書き込む直前
 * （`applyPaymentStateUpdate`の直前・`confirmBooking`の直前の2箇所）で必ず
 * `BookingLockRepository.isHeld`を再検証し、TTLが経過していれば書き込みを行わず中断する**
 * （3回目レビュー対応。ロックを取得した「つもり」のままTTL超過後も書き込みを続けることを
 * 防ぐ）。
 *
 * `Booking.PAYMENT_STATUS_TRANSITIONS_`の`failed→paid`許可は引き続き維持する。ロックは
 * 「同時に処理させない」ことを目指すが、「どちらが先に完了するか」は制御しないため、
 * `expirePendingBookings`が先に完了して`paymentStatus:failed`・`status:EXPIRED`へ進めた
 * **後**にWebhookがロックを取得した場合でも、入金の事実（`paymentStatus:paid`）を正しく
 * 記録できる必要がある（`status`は`EXPIRED`のまま変更しない。`confirmBooking`が`EXPIRED`を
 * 拒否するため自動確定はされず、`paymentRecoveryRequiredAt`を立ててRecoveryへ記録し運営者の
 * 確認を必須にする。「失効後の入金記録」節参照）。`CardPayment.WEBHOOK_RACE_GRACE_MINUTES`
 * （既定10分）は補助策として維持するが、競合を防ぐ根拠ではなく、決済完了直後に即座に
 * Stripe再照会・ロック取得を試みる無駄を減らす効率化のためだけに位置づけている。
 *
 * **保証範囲について**: `BookingLockRepository`は、Sheetsのappend順序整列を「公式に
 * 保証された原子的ロック」として前提にしていない（3回目レビュー対応。詳細は
 * `BookingLockRepository.gs`冒頭コメント）。実際に「両プロジェクトが同じ予約について
 * 両方とも成功したと判断する状態」を防いでいるのは、(1)このロック（ベストエフォート）、
 * (2)`isHeld`による書き込み直前の再検証、(3)`confirmBooking`/`expirePendingBookings`/
 * `applyPaymentStateUpdate`が元々持つ「書き込み直前の最新状態再読込」（通常の読み書き
 * 整合性にしか依存しない）の3層の組み合わせであり、この3層構成とその障害時の挙動は
 * README「Webhookと失効処理の競合」節に記載する。
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
   * Issue #341 PR-Cレビュー対応・2回目: BookingLockRepository.acquireを短い間隔で数回だけ
   * 再試行する。この関数が呼ばれる時点でStripe API呼び出し（署名検証済みイベントの
   * 再照会・金額照合）はすべて完了しているため、待機してもStripeへの応答を大きく
   * 遅らせない（BOOKING_LOCK_MAX_ATTEMPTS_ * BOOKING_LOCK_RETRY_DELAY_MS_はミリ秒単位）。
   *
   * Issue #341 PR-Cレビュー対応・3回目: このロックのTTL/有効性判定は、意図的に
   * processEventのeffectiveNow（イベントの発生時刻等、テストから固定できるビジネス上の
   * 日時）を一切使わず、実時間（`new Date()`。BookingLockRepository.acquire/isHeldの
   * now引数を省略した既定値）だけに基づかせる。TTLは「実際にどれだけ実時間が経過したか」
   * を測るためのものであり、テストが固定する過去・未来のeffectiveNowと実時間を混同すると、
   * 実行のたびに正しく機能しなくなる（例えばテストが2026-09-20を指定していても、実際の
   * テスト実行はそれとは無関係な実時間で行われる）。本番ではeffectiveNowを指定せずに
   * processEventを呼ぶため、この使い分けは本番の挙動に一切影響しない。
   */
  var BOOKING_LOCK_MAX_ATTEMPTS_ = 3;
  var BOOKING_LOCK_RETRY_DELAY_MS_ = 200;

  function acquireBookingLockWithRetry_(bookingId, eventId) {
    for (var attempt = 1; attempt <= BOOKING_LOCK_MAX_ATTEMPTS_; attempt++) {
      var holderId = 'webhook:' + eventId + ':' + attempt + ':' + Utilities.getUuid();
      var result = BookingLockRepository.acquire(bookingId, holderId, 'webhook');
      if (result.acquired) return result;
      if (attempt < BOOKING_LOCK_MAX_ATTEMPTS_) {
        Utilities.sleep(BOOKING_LOCK_RETRY_DELAY_MS_);
      }
    }
    return { acquired: false };
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

    /*
     * Issue #341 PR-Cレビュー対応・2回目: applyPaymentStateUpdate（paid）〜confirmBookingの
     * 一連（Bookings/Calendarへの確定的な変更を含む区間。Stripe API呼び出しはここより前で
     * 完了済み）を、Booking AdminプロジェクトのexpirePendingBookingsと共有する予約単位
     * ロックで保護する（BookingLockRepository.gs冒頭コメント・BookingRepository.gsの
     * expirePendingBookingsコメント参照）。取得できない場合はAdmin側が同時にこの予約を
     * 処理中とみなし、短い間隔で数回だけ再試行する（外部HTTP呼び出しは行わないため、この
     * 待機はStripeへの応答を大きく遅らせない）。それでも取得できなければStripeの自動再送に
     * 委ねる（イベント台帳はRECEIVEDのまま残るため、次回の配信で安全に再開できる）。
     */
    var bookingLock = acquireBookingLockWithRetry_(bookingId, eventId);
    if (!bookingLock.acquired) {
      return outcome_(false, 'BOOKING_LOCK_CONTENDED', '一時的に他の処理と競合しています。再試行します。');
    }

    try {
      /*
       * Issue #341 PR-Cレビュー対応・3回目: 実際にapplyPaymentStateUpdateを呼ぶ直前に、
       * 予約ロックがまだ有効（TTLが切れていない）ことを再検証する（BookingLockRepository.gs
       * 「3回目レビュー対応で修正した実装バグ・項目2」参照）。ここまでの間にTTLが経過し
       * 他プロセスが既にこの予約のロックを再取得している可能性があり、その場合はこの
       * 実行がBookings/Calendarへ書き込んではならない。何も書き込んでいないため、
       * finalizeせず安全に再試行させる。
       */
      if (!BookingLockRepository.isHeld(bookingLock.rowNumber, bookingLock.holderId, new Date())) {
        Logger.log('StripeWebhookHandler: applyPaymentStateUpdate直前に予約ロックの有効期限が切れていたため中断しました: ' + bookingId);
        return outcome_(false, 'BOOKING_LOCK_EXPIRED', '一時的に他の処理と競合しています。再試行します。');
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
       *
       * Issue #341 PR-Cレビュー対応・3回目: confirmBookingを呼ぶ直前にも予約ロックの
       * 有効性を再検証する（applyPaymentStateUpdateに時間を要し、その間にTTLが切れた
       * 場合を含む）。ここで失効していた場合、paymentStatus:paidは既に書き込み済みだが
       * （入金の事実は保持される）、Calendar/Bookingsのstatus側は変更せずRecoveryへ記録し、
       * 運営者の確認を必須にする（「決済済みでも予約を確定できない場合の扱い」と同じ
       * PAID_CONFIRM_BLOCKED経路に合流させる。confirmResultを直接呼ばずに合成する）。
       */
      var confirmResult;
      if (!BookingLockRepository.isHeld(bookingLock.rowNumber, bookingLock.holderId, new Date())) {
        Logger.log('StripeWebhookHandler: confirmBooking直前に予約ロックの有効期限が切れていたため確定を中断しました: ' + bookingId);
        confirmResult = {
          success: false,
          error: { code: 'BOOKING_LOCK_EXPIRED_BEFORE_CONFIRM', message: '予約ロックの有効期限切れにより確定処理を中断しました。' }
        };
      } else {
        confirmResult = BookingRepository.confirmBooking(bookingId);
      }
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
    } finally {
      try {
        BookingLockRepository.release(bookingLock.rowNumber, bookingLock.holderId, new Date());
      } catch (releaseError) {
        Logger.log('BookingLockRepository.release failed: ' + bookingId + ' ' + describeError_(releaseError));
      }
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
