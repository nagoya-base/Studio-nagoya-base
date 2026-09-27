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
 *
 * 【レビュー対応・5回目: 処理権の世代管理とハートビートによる生存確認】4回目までは
 * `claimForProcessing()`のstaleAfterMs（既定2分）判定だけに頼っており、1件のイベント
 * 処理がstaleAfterMsを超えて実行中なだけでも、別のトリガー実行が「クラッシュした」と
 * 誤判定して処理権を奪い、二重処理につながる恐れがあった（正常に実行中の処理権を、
 * 時間経過だけで別の実行に渡してはならないという指摘）。対応として:
 *
 * - `StripeEventRepository.renewProcessingLease(rowNumber, generation, now)`を、
 *   外部Stripe API呼び出し・Bookings/Calendarへの書き込みの直前に呼ぶ（本ファイル内の
 *   3箇所。下記processSingleEvent_/handleAsyncPaymentFailed_参照）。実際に処理を
 *   続けている実行はこれによりprocessingClaimedAt（ハートビート）を更新し続けるため、
 *   claimForProcessing()のage判定は常に短く保たれ、時間経過だけで処理権が渡ることは
 *   ない。
 * - renewProcessingLeaseが`{renewed:false}`を返した場合（既に別の実行が世代を
 *   進めている＝処理権を引き継いでいる）は、直ちにこの実行の処理を中断し
 *   （SUPERSEDED_BY_NEWER_ATTEMPT）、以後Bookings/Calendarへの書き込み・
 *   StripeEvents.finalizeForProcessing呼び出しを一切行わない。
 * - `StripeEventRepository.finalizeForProcessing(rowNumber, generation, fields, now)`は
 *   書き込み直前に世代番号（processingClaimCount）を再確認してから書き込む
 *   （fencing token）。renewProcessingLeaseの確認から実際の書き込みまでのわずかな
 *   間隙で世代が進んでいた場合でも、古い実行の遅延した書き込みが新しい実行の処理
 *   結果を上書きすることを構造的に防ぐ。
 *
 * BookingRepository.applyPaymentStateUpdate/confirmBookingはそれ自体が冪等なため、
 * 処理権を引き継いだ新しい実行がprocessSingleEvent_を最初からやり直しても、既に
 * 完了した決済状態更新・予約確定・確認メール送信を二重実行することはない（詳細は
 * README「Webhookと失効処理の競合」節参照）。
 *
 * （7回目の注記: 上記の「時間経過だけで処理権が渡ることはない」は、応答待ち中に
 * ハートビートを更新できないため成り立っていなかった。7回目で`renewProcessingLease`は
 * `confirmProcessingClaim`へ、`renewOrSupersededOutcome_`は
 * `confirmClaimOrSupersededOutcome_`へ改名し、処理権の再取得は有効期限だけで判定する
 * ようにした。下記「レビュー対応・7回目」参照。）
 *
 * 【レビュー対応・6回目: ハートビートの時刻管理を修正】5回目の実装は
 * `renewOrSupersededOutcome_`の呼び出しに`processSingleEvent_`冒頭で確定した
 * `effectiveNow`（イベント処理開始時刻。監査ログ・テストの固定日時と共用）をそのまま
 * 渡していたため、実際に外部Stripe API呼び出しで時間が経過していても、
 * `renewProcessingLease`が書き込む`processingClaimedAt`は常にイベント処理開始時刻の
 * ままで、ハートビートが実質的に機能していなかった（正常に実行中でも2分経過時点で
 * 別のトリガーに処理権を奪われる不具合が残っていた）。修正として、
 * `renewOrSupersededOutcome_`は`now`引数を受け取らず、必ず呼び出しの瞬間の実時間
 * （`new Date()`）をハートビートとして書き込むよう変更した。処理権の生存確認に使う
 * 実時間と、イベント処理の監査時刻・テスト用の固定日時（`effectiveNow`/`now`）は
 * 完全に分離されている。
 *
 * 【レビュー対応・7回目: 処理権の有効期限をApps Scriptの最大実行時間から決める】
 * 6回目までの再取得判定は「最後のハートビートから2分」だった。しかしハートビートは
 * Stripe API（UrlFetchApp.fetch）の応答待ち中には更新できず、UrlFetchAppには
 * タイムアウトを指定するオプションも無い（fetchのparamsはcontentType/headers/method/
 * payload/useIntranet/validateHttpsCertificates/followRedirects/muteHttpExceptions/
 * escapingのみ）。応答待ちが2分を超えると、生きている実行から処理権を奪い得た。
 * また、トリガー開始時に1度だけ取った時刻を全候補のclaim時刻に使っていたため、
 * 先行イベントに時間がかかると後続イベントの処理権が実際より古い時刻で記録されていた。
 * 7回目では次のとおりにした。
 *
 * - 処理権の有効期限（processingLeaseExpiresAt）＝この実行の開始時刻（実時間）＋
 *   Apps Scriptの1実行あたりの最大実行時間（GAS_MAX_EXECUTION_MS_＝6分）＋余裕
 *   （CLAIM_TAKEOVER_MARGIN_MS_＝1分）。Apps Scriptは上限を超えた実行を強制終了する
 *   ため、この時刻を過ぎれば元の実行は動いていない。したがって、正常に動いている
 *   実行が応答待ちの長さに関係なく処理権を奪われることはない（この保証はApps Script側の
 *   実行時間上限が守られることに依存する。README「処理権の有効期限とfencing」節参照）。
 * - 各候補の着手時刻（processingClaimedAt）は、その候補をclaimする瞬間の`new Date()`。
 *   業務上の監査時刻（`now`引数。paymentConfirmedAt等に使う。テストでは固定日時）とは
 *   別に扱う。
 * - 上限の前提が崩れた場合でも古い実行が書き込まないよう、Bookings（決済状態・予約
 *   確定）・Calendar（予約確定）・Recovery・StripeEventsへの書き込みは、すべて
 *   書き込み側が保持するLockService.getScriptLock()の中で世代を再確認してから行う
 *   （BookingRepositoryのoptions.writeGuard・runFenced_・finalizeForProcessing）。
 *   処理権の再取得も同じLockの中で世代を進めるため、確認と書き込みの間に世代が
 *   変わることはない。
 * - 未完了のまま終えた候補（Stripe照会失敗・Lock混雑・想定外の例外）は処理権を
 *   手放し（releaseProcessingClaim）、次のトリガー実行ですぐ再試行できるようにする。
 *   想定外の例外はその候補だけで止め、同じ実行の後続候補の処理は続ける。
 * - 実行開始からCLAIM_BUDGET_MS_（4分）を過ぎたら新しい候補には着手せず、次のトリガー
 *   実行に残す（着手した直後に実行時間の上限で打ち切られ、その候補が有効期限まで
 *   待たされることを避ける）。
 */
'use strict';

var StripeWebhookProcessor = (function () {
  var RELEVANT_SUCCESS_TYPES_ = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  var FAILURE_TYPES_ = ['checkout.session.async_payment_failed'];

  /*
   * 処理権の有効期限（レビュー対応・7回目。6回目までのADMIN_CLAIM_STALE_AFTER_MS_＝
   * 「最後のハートビートから2分」を置き換えた。ファイル冒頭コメント参照）。
   * - GAS_MAX_EXECUTION_MS_: Apps Scriptの1実行あたりの最大実行時間（Apps Scriptの
   *   割り当て表「Script runtime: 6 min / execution」）。時間主導トリガーの実行はこれを
   *   超えると強制終了される。Google側の上限が変わった場合はこの値を合わせること。
   * - CLAIM_TAKEOVER_MARGIN_MS_: 実行開始時刻の記録のずれ・強制終了にかかる時間の余裕。
   * - CLAIM_BUDGET_MS_: 実行開始からこれを過ぎたら新しい候補に着手しない。
   * 実行が異常停止した候補は、最長で実行開始から7分後に次のトリガー実行が再取得する。
   */
  var GAS_MAX_EXECUTION_MS_ = 6 * 60 * 1000;
  var CLAIM_TAKEOVER_MARGIN_MS_ = 60 * 1000;
  var CLAIM_BUDGET_MS_ = 4 * 60 * 1000;
  var FENCED_WRITE_LOCK_TIMEOUT_MS_ = 10000;

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
   * StripeEventRepository.finalizeForProcessingの書き込み自体が失敗した場合、行はRECEIVEDの
   * まま残り、次回のトリガー実行で（処理権を手放した後、または有効期限の経過後に）安全に再開できる。
   * fields.processingStateにはCOMPLETED/IGNORED/REJECTEDのいずれかを渡すこと。
   *
   * generation（claimForProcessing()が返したrecord.processingClaimCount）が既に古くなって
   * いた場合（STALE_GENERATION/ALREADY_TERMINAL）、この書き込みは行わない。既に別の実行が
   * このイベントの処理を引き継いでいるため、この実行の結果を破棄してSUPERSEDED_BY_
   * NEWER_ATTEMPTを返す（レビュー対応・5回目。「Webhookと失効処理の競合」節参照）。
   */
  function finalizeOutcome_(rowNumber, generation, fields, now, code, message) {
    var result;
    try {
      result = StripeEventRepository.finalizeForProcessing(rowNumber, generation, fields, now);
    } catch (finalizeError) {
      Logger.log('StripeWebhookProcessor: イベント処理結果の永続化に失敗しました: ' + describeError_(finalizeError));
      return outcome_(false, 'LEDGER_WRITE_FAILED', 'イベント処理結果の永続化に失敗しました。再試行します。');
    }
    if (!result.written) {
      if (result.reason === 'STALE_GENERATION' || result.reason === 'ALREADY_TERMINAL') {
        Logger.log('StripeWebhookProcessor: 別の実行に処理権が引き継がれていたため、この実行の結果は破棄しました: rowNumber=' + rowNumber + ' reason=' + result.reason);
        return outcome_(false, 'SUPERSEDED_BY_NEWER_ATTEMPT', 'この処理権は別の実行に引き継がれています。');
      }
      return outcome_(false, 'LEDGER_WRITE_FAILED', 'イベント処理結果の永続化に失敗しました。再試行します。');
    }
    return outcome_(true, code, message);
  }

  function supersededOutcome_() {
    return outcome_(false, 'SUPERSEDED_BY_NEWER_ATTEMPT', 'この処理権は別の実行に引き継がれています。');
  }

  /*
   * 処理の区切り（外部Stripe API呼び出しの後、Bookings/Calendarへの書き込みの前）で、
   * この実行がまだ処理権を保持しているかを確認し、生存記録を残す
   * （StripeEventRepository.confirmProcessingClaim）。処理権が移っていれば
   * SUPERSEDED_BY_NEWER_ATTEMPTのoutcomeを返すので、呼び出し元はそれをそのまま返し、
   * 以後何も書き込まないこと。確認そのものがLock混雑で行えなかった場合はLOCK_TIMEOUTの
   * outcomeを返す（処理権を手放して次回再試行する）。
   *
   * 生存記録の時刻は常にこの呼び出しの瞬間の実時間（`new Date()`）を使う（6回目の修正）。
   * 7回目以降、この記録は処理権の有効期限を延長しない（StripeEventRepository.
   * confirmProcessingClaim参照）。この確認は早めに打ち切るための最適化であり、
   * 書き込みの安全性自体は書き込み側のLock内の世代確認（writeGuardFor_・runFenced_・
   * finalizeForProcessing）が担う。
   */
  function confirmClaimOrSupersededOutcome_(rowNumber, generation) {
    var confirmation = StripeEventRepository.confirmProcessingClaim(rowNumber, generation, new Date());
    if (confirmation.confirmed) return null;
    if (confirmation.reason === 'LOCK_TIMEOUT') {
      return outcome_(false, 'LOCK_TIMEOUT', '処理権を確認できませんでした。再試行します。');
    }
    Logger.log('StripeWebhookProcessor: 処理中に別の実行へ処理権が引き継がれたため中断しました: rowNumber=' + rowNumber);
    return supersededOutcome_();
  }

  /* BookingRepository.applyPaymentStateUpdate/confirmBookingへ渡すwriteGuard。
     BookingRepositoryが保持するLockの中で呼ばれるため、Lockを取得しない版を使う。 */
  function writeGuardFor_(rowNumber, generation) {
    return function () {
      return StripeEventRepository.isProcessingClaimCurrentLocked(rowNumber, generation);
    };
  }

  function isWriteGuardRejected_(result) {
    return !!(result && !result.success && result.error && result.error.code === 'WRITE_GUARD_REJECTED');
  }

  /*
   * BookingRepositoryを経由しない書き込み（恒久の要復旧ゲート・Recovery記録）を、
   * LockService.getScriptLock()の中で世代を確認してから行う（レビュー対応・7回目）。
   * 戻り値: null（書き込んだ）、または中断すべきoutcome（SUPERSEDED/LOCK_TIMEOUT）。
   * fnの中でLockを取得する関数を呼んではならない。
   */
  function runFenced_(rowNumber, generation, fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(FENCED_WRITE_LOCK_TIMEOUT_MS_)) {
      return outcome_(false, 'LOCK_TIMEOUT', '一時的に混み合っています。再試行します。');
    }
    try {
      if (!StripeEventRepository.isProcessingClaimCurrentLocked(rowNumber, generation)) {
        Logger.log('StripeWebhookProcessor: 別の実行に処理権が引き継がれていたため書き込みを中止しました: rowNumber=' + rowNumber);
        return supersededOutcome_();
      }
      fn();
      return null;
    } finally {
      lock.releaseLock();
    }
  }

  function recordRecoveryFailureBestEffort_(entry) {
    try {
      RecoveryRepository.recordFailure(entry);
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + (entry.bookingId || '') + ' ' + entry.failureType + ' ' + describeError_(recoveryError));
    }
  }

  /* 予約に紐付けられない、または再送しても解決しない構造的な問題をRecoveryへ記録した上で
     REJECTEDとして確定する。 */
  function rejectAndFinalize_(rowNumber, generation, bookingId, code, message, now) {
    var fenced = runFenced_(rowNumber, generation, function () {
      recordRecoveryFailureBestEffort_({
        bookingId: bookingId || '',
        failureType: 'STRIPE_WEBHOOK_' + code,
        occurredAt: now,
        calendarEventId: '',
        status: '',
        errorMessage: message,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    });
    if (fenced) return fenced;
    return finalizeOutcome_(rowNumber, generation, {
      processingState: StripeEventRepository.STATE.REJECTED,
      bookingId: bookingId || '',
      outcomeCode: code,
      outcomeMessage: message
    }, now, code, message);
  }

  /* rejectAndFinalize_からRecoveryRepository呼び出しを除いた版。呼び出し元が
     recordPaymentRecoveryGate_で既にRecovery記録・恒久ゲートを立てている場合に使う
     （二重記録を避ける）。 */
  function rejectFinalizeOnly_(rowNumber, generation, bookingId, code, message, now) {
    return finalizeOutcome_(rowNumber, generation, {
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
  function recordPaymentRecoveryGate_(rowNumber, generation, bookingId, record, failureType, reason, now) {
    /* レビュー対応・7回目: 世代を確認してから書き込む（runFenced_参照）。戻り値は
       null（記録した）または中断すべきoutcome。 */
    return runFenced_(rowNumber, generation, function () {
      try {
        SpreadsheetRepository.updateBookingFields(bookingId, {
          paymentRecoveryRequiredAt: now,
          paymentRecoveryReason: reason
        });
      } catch (writeError) {
        Logger.log('paymentRecoveryRequiredAtの記録に失敗しました: ' + bookingId + ' ' + describeError_(writeError));
      }
      recordRecoveryFailureBestEffort_({
        bookingId: bookingId,
        failureType: failureType,
        occurredAt: now,
        calendarEventId: (record && record.calendarEventId) || '',
        status: (record && record.status) || '',
        errorMessage: reason,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    });
  }

  /*
   * checkout.session.async_payment_failed（非同期決済方法が有効な場合に備えた設計。
   * Issue #341本文「非同期決済が有効になり得る場合はasync_payment_succeeded等の扱いも
   * 設計してください」）。対象の決済試行がまだ現在の決済試行のままCHECKOUT_PENDINGで
   * ある場合のみFAILEDへ進め、次回の申込で新しい決済試行IDを発行できるようにする。
   */
  function handleAsyncPaymentFailed_(rowNumber, generation, eventId, session, bookingId, paymentAttemptId, now) {
    if (session.paymentStatus === 'paid') {
      /* 既に別の成功イベントでpaidへ進んでいる（順序逆転で失敗通知が後から届いた）。
         成功を巻き戻さない。 */
      return finalizeOutcome_(rowNumber, generation, {
        processingState: StripeEventRepository.STATE.IGNORED,
        bookingId: bookingId, paymentAttemptId: paymentAttemptId,
        outcomeCode: 'SUPERSEDED_BY_SUCCESS', outcomeMessage: '決済は既に成功しているため失敗通知を無視しました。'
      }, now, 'SUPERSEDED_BY_SUCCESS', '決済は既に成功しています。');
    }
    if (!bookingId) {
      return rejectAndFinalize_(rowNumber, generation, '', 'METADATA_MISSING', '非同期決済失敗イベントにmetadata.bookingIdがありません。sessionId=' + session.id, now);
    }
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return rejectAndFinalize_(rowNumber, generation, bookingId, 'BOOKING_NOT_FOUND', '対応する予約が見つかりません。bookingId=' + bookingId, now);
    }
    var record = found.record;
    var currentPaymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    var isCurrentAttempt = record.paymentAttemptId === paymentAttemptId && record.stripeCheckoutSessionId === session.id;
    if (!isCurrentAttempt || currentPaymentStatus !== Booking.PAYMENT_STATUS.CHECKOUT_PENDING) {
      /* 既に別の決済試行へ進んでいる、または既に解決済み（failed/paid等）。何もしない。 */
      return finalizeOutcome_(rowNumber, generation, {
        processingState: StripeEventRepository.STATE.IGNORED,
        bookingId: bookingId, paymentAttemptId: paymentAttemptId,
        outcomeCode: 'STALE_OR_ALREADY_RESOLVED', outcomeMessage: '既に別の決済試行へ進んでいるか解決済みのため何もしませんでした。'
      }, now, 'STALE_OR_ALREADY_RESOLVED', '対応不要です。');
    }

    /* Bookingsへの書き込み直前に処理権がまだ有効か再確認する（レビュー対応・5回目）。
       書き込み自体もLock内で世代を再確認する（writeGuard。レビュー対応・7回目）。 */
    var superseded = confirmClaimOrSupersededOutcome_(rowNumber, generation);
    if (superseded) return superseded;

    var failResult = BookingRepository.applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.FAILED, { paymentAttemptResolvedAt: now }, now, {
      writeGuard: writeGuardFor_(rowNumber, generation)
    });
    if (isWriteGuardRejected_(failResult)) return supersededOutcome_();
    if (!failResult.success) {
      var failCode = failResult.error && failResult.error.code;
      if (failCode === 'LOCK_TIMEOUT' || failCode === 'PAYMENT_DETAIL_WRITE_FAILED') {
        return outcome_(false, failCode, '一時的に決済状態を更新できませんでした。再試行します。');
      }
      if (failCode === 'PAYMENT_RECOVERY_REQUIRED') {
        /* 既に別の理由で恒久ゲートが立っている。ここで重複してRecoveryへ記録しない。 */
        return rejectFinalizeOnly_(rowNumber, generation, bookingId, failCode, '既に要復旧のため何もしませんでした。', now);
      }
      return rejectAndFinalize_(rowNumber, generation, bookingId, failCode || 'PAYMENT_UPDATE_FAILED', '決済失敗状態への更新に失敗しました: ' + failCode, now);
    }
    return finalizeOutcome_(rowNumber, generation, {
      processingState: StripeEventRepository.STATE.COMPLETED,
      bookingId: bookingId, paymentAttemptId: paymentAttemptId,
      outcomeCode: 'MARKED_FAILED', outcomeMessage: '決済試行をfailedへ更新しました。'
    }, now, 'MARKED_FAILED', '決済試行をfailedへ更新しました。');
  }

  /*
   * rowNumber/record: StripeEventRepository.claimForProcessing()が返したもの（record.rawBodyに
   * Stripe Webhookイベントの生JSON文字列が保存済み）。
   * generation: claimForProcessing()が返したrecord.processingClaimCount（レビュー対応・5回目
   *   で追加。処理権の世代番号。Bookings/Calendarへの書き込み直前の再確認・
   *   StripeEvents.finalizeForProcessingの書き込み直前の再確認に使う）。
   * now: 業務上の監査時刻（paymentConfirmedAt・Recoveryの発生時刻等）。テストからの固定時刻
   *   注入用（省略時はこのイベントに着手した時点のnew Date()）。処理権の管理には使わない。
   * 戻り値: { finalized, code, message }。finalized:trueの場合、StripeEventsは終端状態
   *   （COMPLETED/IGNORED/REJECTED）まで書き込まれている。falseの場合は行がRECEIVEDの
   *   まま残り、次回のトリガー実行で安全に再試行される（code:'SUPERSEDED_BY_NEWER_ATTEMPT'
   *   の場合は、既に別の実行がこのイベントの処理を引き継いでいるため、この実行の結果は
   *   破棄されている。呼び出し元はこれを異常とはみなさない）。
   */
  function processSingleEvent_(rowNumber, record, now, generation) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var eventId = record.eventId;
    var eventType = record.eventType;

    var parsed = safeJsonParse_(record.rawBody);
    if (!parsed || typeof parsed !== 'object') {
      /* 通常は起こり得ない（受信時にBooking Webhook側でJSON.parseが成功した本文だけを
         保存するため）。台帳の破損等、想定外の事態として構造的な問題扱いにする。 */
      return rejectAndFinalize_(rowNumber, generation, '', 'INVALID_STORED_EVENT_JSON', '保存済みのイベント本文を解析できませんでした。eventId=' + eventId, effectiveNow);
    }

    var objectData = parsed.data && parsed.data.object;

    var isSuccessType = RELEVANT_SUCCESS_TYPES_.indexOf(eventType) !== -1;
    var isFailureType = FAILURE_TYPES_.indexOf(eventType) !== -1;
    if (!isSuccessType && !isFailureType) {
      return finalizeOutcome_(rowNumber, generation, {
        processingState: StripeEventRepository.STATE.IGNORED,
        outcomeCode: 'UNHANDLED_EVENT_TYPE', outcomeMessage: 'このイベント種別は対象外です: ' + eventType
      }, effectiveNow, 'IGNORED_EVENT_TYPE', '対象外のイベント種別です。');
    }

    if (!objectData || typeof objectData.id !== 'string' || !objectData.id) {
      return rejectAndFinalize_(rowNumber, generation, '', 'INVALID_EVENT_OBJECT', 'イベント本文にCheckout Session IDが含まれていません。eventId=' + eventId, effectiveNow);
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
      return handleAsyncPaymentFailed_(rowNumber, generation, eventId, session, bookingId, paymentAttemptId, effectiveNow);
    }

    /*
     * Session完了とPaymentIntentの入金完了を同一視しない（Issue #341本文）。
     * session.paymentStatusが'paid'でない間は、まだ支払いが確定していない
     * （非同期決済方法が有効な場合の中間状態を含む）ため自動確定しない。
     */
    if (session.paymentStatus !== 'paid') {
      return finalizeOutcome_(rowNumber, generation, {
        processingState: StripeEventRepository.STATE.IGNORED,
        bookingId: bookingId, paymentAttemptId: paymentAttemptId,
        outcomeCode: 'PAYMENT_NOT_YET_COMPLETE',
        outcomeMessage: 'Checkout Sessionの支払いはまだ完了していません（payment_status=' + session.paymentStatus + '）。'
      }, effectiveNow, 'PAYMENT_NOT_YET_COMPLETE', '決済はまだ完了していません。');
    }

    if (!bookingId || !paymentAttemptId || !brand) {
      return rejectAndFinalize_(rowNumber, generation, bookingId, 'METADATA_MISSING', 'Checkout Sessionのmetadataが不足しています（bookingId/paymentAttemptId/brand）。sessionId=' + session.id, effectiveNow);
    }

    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return rejectAndFinalize_(rowNumber, generation, bookingId, 'BOOKING_NOT_FOUND', '対応する予約が見つかりません。bookingId=' + bookingId + ' sessionId=' + session.id, effectiveNow);
    }
    var record2 = found.record;
    var gateStopped = null;

    if (record2.paymentRecoveryRequiredAt) {
      /* 既に別の理由で恒久の要復旧ゲートが立っている予約。無駄なStripe API呼び出し・
         重複したRecovery記録を避けるためここで打ち切る（後段のapplyPaymentStateUpdateも
         同じ理由でPAYMENT_RECOVERY_REQUIREDを返すが、PaymentIntent再取得等を省略できる）。 */
      return rejectFinalizeOnly_(rowNumber, generation, bookingId, 'PAYMENT_RECOVERY_REQUIRED', '既に要復旧のため何もしませんでした。', effectiveNow);
    }

    /*
     * 予約ID・ブランド・Checkout Session ID・決済試行IDのすべてが台帳の記録と一致する
     * ことを確認する（Issue #341本文「5. 予約・決済試行・金額の照合」）。1つでも
     * 食い違えば、既にこの予約が別の決済試行へ進んでいる（古いSessionの遅延配信）か、
     * 深刻な取り違えの可能性があるため、自動確定せず恒久の要復旧ゲートを立てる。
     */
    if (record2.brand !== brand || record2.paymentAttemptId !== paymentAttemptId || record2.stripeCheckoutSessionId !== session.id) {
      gateStopped = recordPaymentRecoveryGate_(
        rowNumber, generation, bookingId, record2, 'STRIPE_WEBHOOK_IDENTITY_MISMATCH',
        '決済成功イベント（eventId=' + eventId + ', sessionId=' + session.id + '）の識別子（brand/決済試行ID/Session ID）が' +
          '台帳の記録と一致しません。二重決済・取り違えの可能性があるため、入金の事実は保持したまま自動処理を停止しました。' +
          'Stripe管理画面で実際の入金内容を確認してください。',
        effectiveNow
      );
      if (gateStopped) return gateStopped;
      return rejectFinalizeOnly_(rowNumber, generation, bookingId, 'IDENTITY_MISMATCH', '識別子が一致しないため要復旧としました。', effectiveNow);
    }

    /*
     * ここまででCheckout Sessionの再取得（外部HTTP呼び出し）が1回完了している。
     * 次のPaymentIntent再取得（外部HTTP呼び出し）へ進む前に、処理権がまだ有効か
     * 再確認する（レビュー対応・5回目。7回目以降、処理権が移るのは有効期限の経過後だけ）。
     */
    var supersededBeforePi = confirmClaimOrSupersededOutcome_(rowNumber, generation);
    if (supersededBeforePi) return supersededBeforePi;

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
      gateStopped = recordPaymentRecoveryGate_(
        rowNumber, generation, bookingId, record2, 'PAYMENT_INTENT_STATUS_MISMATCH',
        'Checkout Session（' + session.id + '）はpayment_status=paidと報告していますが、対応するPaymentIntent（' +
          paymentIntent.id + '）のstatusはsucceededではありません（' + paymentIntent.status + '）。Session完了と' +
          '入金完了を同一視せず、自動処理を停止しました。',
        effectiveNow
      );
      if (gateStopped) return gateStopped;
      return rejectFinalizeOnly_(rowNumber, generation, bookingId, 'PAYMENT_INTENT_STATUS_MISMATCH', 'PaymentIntentのstatusが一致しないため要復旧としました。', effectiveNow);
    }

    /* 金額照合はCheckout Session発行時点のスナップショット基準（現在の料金を再計算しない）。 */
    var verify = CardPayment.verifyPaymentAgainstSnapshot(record2, paymentIntent.amountReceived, paymentIntent.currency);
    if (!verify.valid) {
      gateStopped = recordPaymentRecoveryGate_(
        rowNumber, generation, bookingId, record2, 'STRIPE_WEBHOOK_AMOUNT_MISMATCH',
        '決済成功イベント（eventId=' + eventId + '）の金額・通貨（' + paymentIntent.amountReceived + ' ' + paymentIntent.currency +
          '）が、Checkout Session発行時点のスナップショット（' + record2.stripeAmount + ' ' + record2.stripeCurrency +
          '）と一致しません（' + verify.error.code + '）。入金の事実は保持したまま自動処理を停止しました。',
        effectiveNow
      );
      if (gateStopped) return gateStopped;
      return rejectFinalizeOnly_(rowNumber, generation, bookingId, verify.error.code, '金額・通貨が一致しないため要復旧としました。', effectiveNow);
    }

    /*
     * Issue #341 PR-Cレビュー対応・4回目: applyPaymentStateUpdate・confirmBookingは
     * いずれもBooking Admin自身のLockService.getScriptLock()を内部で取得・解放する
     * （BookingRepository.gs参照）。この関数自体がBooking Adminプロジェクトの一部として
     * 実行されるため、expirePendingBookingsと同じLockを自然に共有する。予約単位の
     * 分散ロックは一切不要（ファイル冒頭コメント参照）。
     *
     * レビュー対応・5回目: PaymentIntent再取得（外部HTTP呼び出し）が完了した直後・
     * Bookingsへの実際の書き込みを行う直前に、処理権がまだ有効か再確認する。
     *
     * レビュー対応・7回目: 上の確認だけでは、確認とapplyPaymentStateUpdateのLock取得の
     * 間に世代が進む余地が残る。そのためapplyPaymentStateUpdate/confirmBookingには
     * writeGuardを渡し、BookingRepositoryがLockを取得した後、Bookings/Calendarを
     * 読み書きする前に世代を再確認させる（WRITE_GUARD_REJECTEDなら何も書き込まれて
     * いない）。
     */
    var supersededBeforePaid = confirmClaimOrSupersededOutcome_(rowNumber, generation);
    if (supersededBeforePaid) return supersededBeforePaid;

    var paidResult = BookingRepository.applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.PAID, {
      stripePaymentIntentId: paymentIntent.id,
      lastStripeEventId: eventId,
      paymentConfirmedAt: effectiveNow
    }, effectiveNow, { writeGuard: writeGuardFor_(rowNumber, generation) });

    if (isWriteGuardRejected_(paidResult)) return supersededOutcome_();
    if (!paidResult.success) {
      var paidErrorCode = paidResult.error && paidResult.error.code;
      if (paidErrorCode === 'LOCK_TIMEOUT' || paidErrorCode === 'PAYMENT_DETAIL_WRITE_FAILED') {
        /* 何も書き込まれていない失敗のため、finalizeせず安全に再試行させる。 */
        return outcome_(false, paidErrorCode, '一時的に決済状態を更新できませんでした。再試行します。');
      }
      if (paidErrorCode === 'PAYMENT_RECOVERY_REQUIRED') {
        return rejectFinalizeOnly_(rowNumber, generation, bookingId, paidErrorCode, '既に要復旧のため何もしませんでした。', effectiveNow);
      }
      if (SELF_RECORDING_PAYMENT_UPDATE_ERROR_CODES_.indexOf(paidErrorCode) !== -1) {
        /* PAYMENT_IDENTITY_MISMATCH・UNKNOWN_PAYMENT_STATUS・PAYMENT_STATUS_WRITE_FAILED_
           AFTER_DETAIL_COMMIT・PAYMENT_IDENTITY_UNCONFIRMED・PAYMENT_EVIDENCE_MISSING等は
           applyPaymentStateUpdate自身が既にRecoveryへ記録済み（BookingRepository.gs参照）。
           ここで重複記録はしない。 */
        return rejectFinalizeOnly_(rowNumber, generation, bookingId, paidErrorCode || 'PAYMENT_UPDATE_FAILED', '決済状態の更新に失敗しました: ' + paidErrorCode, effectiveNow);
      }
      /*
       * INVALID_PAYMENT_TRANSITION（例: 仮押さえ失効・キャンセル等で既にpaymentStatusが
       * failedへ進んでいた後に、遅れて届いた決済成功イベント）等、applyPaymentStateUpdate
       * 自身は台帳側の不整合とみなさずRecoveryへ記録しないコードは、ここで明示的に記録する。
       * Stripe側では実際に入金が完了しているため、無条件に無視してはならない。
       */
      gateStopped = recordPaymentRecoveryGate_(
        rowNumber, generation, bookingId, record2, 'STRIPE_WEBHOOK_PAYMENT_UPDATE_REJECTED',
        '決済成功イベント（eventId=' + eventId + '）を受信しましたが、決済状態を' + Booking.PAYMENT_STATUS.PAID +
          'へ更新できませんでした（' + paidErrorCode + '）。Stripe側では入金が完了している可能性が高いため、' +
          '入金の事実を消さず自動処理を停止しました。運営者による確認が必要です。',
        effectiveNow
      );
      if (gateStopped) return gateStopped;
      return rejectFinalizeOnly_(rowNumber, generation, bookingId, paidErrorCode || 'PAYMENT_UPDATE_FAILED', '決済状態の更新に失敗しました: ' + paidErrorCode, effectiveNow);
    }

    /*
     * confirmBooking直前にも処理権を再確認する（レビュー対応・5回目）。
     * applyPaymentStateUpdate自体は既に成功済み（入金の事実は記録済み）のため、
     * ここで処理権を失っていても入金記録が失われることはない
     * （BookingRepository.applyPaymentStateUpdate自身の冪等性により、この後の実行
     * ―別の実行が再claimして再度processSingleEvent_をやり直す、または既にpaidの
     * ままconfirmBookingへ進む―が安全に引き継ぐ）。
     */
    var supersededBeforeConfirm = confirmClaimOrSupersededOutcome_(rowNumber, generation);
    if (supersededBeforeConfirm) return supersededBeforeConfirm;

    /*
     * 予約の最新状態を読み直したうえで、既存の予約確定処理をそのまま再利用する
     * （Issue #341本文「7. 決済成功後の予約自動確定」。confirmBookingLocked_自身が
     * Lock取得直後に最新のstatus・Calendarイベントの有無を再確認するため、ここで
     * 個別に再読込・再確認を重複実装しない）。
     */
    var confirmResult = BookingRepository.confirmBooking(bookingId, { writeGuard: writeGuardFor_(rowNumber, generation) });
    if (isWriteGuardRejected_(confirmResult)) return supersededOutcome_();
    if (!confirmResult.success) {
      /*
       * 決済済みでも予約を確定できない（仮押さえ失効・キャンセル済み・Calendarイベント
       * 消失・料金訂正案内未送信・保存失敗等）。入金の事実（paymentStatus=paid）は
       * 一切書き戻さず、運営者が確認できるようRecoveryへ記録する。自動返金の判断は
       * PR-Dへ引き継ぐ。
       */
      gateStopped = recordPaymentRecoveryGate_(
        rowNumber, generation, bookingId, record2, 'PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED',
        '決済は完了しました（eventId=' + eventId + '）が、予約の自動確定ができませんでした（' +
          (confirmResult.error && confirmResult.error.code) + '）。入金は保持したまま自動処理を停止しました。' +
          '運営者による確認・対応が必要です（枠を確保できない場合の返金判断を含む）。',
        effectiveNow
      );
      if (gateStopped) return gateStopped;
    }

    return finalizeOutcome_(rowNumber, generation, {
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
   * now: 業務上の監査時刻（テストからの固定時刻注入用。省略時は各イベントに着手した時点の
   *   new Date()）。処理権の管理（着手時刻・有効期限）には一切使わない（レビュー対応・
   *   7回目。処理権の管理は常に実時間`new Date()`で行う）。
   * 戻り値: { candidateCount, processedCount, skippedCount, deferredCount, results }。
   *   processedCount: 今回の実行で終端状態（COMPLETED/IGNORED/REJECTED）まで到達した件数。
   *   skippedCount: 着手権を取得できなかった（他の実行が処理中）、今回は未完了に
   *     終わり次回のトリガー実行に委ねた、またはdeferredCountに数えた件数。
   *   deferredCount: 実行時間の予算（CLAIM_BUDGET_MS_）を使い切ったため、着手せずに
   *     次回のトリガー実行へ残した件数（skippedCountにも含む）。
   */
  function processPendingStripeWebhookEvents(now) {
    /* この実行の開始時刻（実時間）。処理権の有効期限はここから決める。Apps Scriptが
       実際に実行を開始したのはこれより少し前のため、有効期限は安全側（遅め）にずれる。 */
    var executionStartedAt = new Date();
    var leaseExpiresAt = new Date(executionStartedAt.getTime() + GAS_MAX_EXECUTION_MS_ + CLAIM_TAKEOVER_MARGIN_MS_);
    var auditNow = isDateLike_(now) ? now : null;
    var pending = StripeEventRepository.listPendingWithBody();
    var processedCount = 0;
    var skippedCount = 0;
    var deferredCount = 0;
    var results = [];

    for (var i = 0; i < pending.length; i++) {
      var item = pending[i];
      /* 各候補の着手時刻は、その候補をclaimする瞬間の実時間（先行候補の処理時間を
         含めた実際の時刻）を使う。トリガー開始時刻を使い回さない。 */
      var claimStartedAt = new Date();
      if (claimStartedAt.getTime() - executionStartedAt.getTime() >= CLAIM_BUDGET_MS_) {
        deferredCount = pending.length - i;
        skippedCount += deferredCount;
        break;
      }
      var claimResult = StripeEventRepository.claimForProcessing(item.record.eventId, item.record.eventType, claimStartedAt, leaseExpiresAt);
      if (claimResult.outcome !== 'CLAIMED') {
        /* IN_PROGRESS: 別のトリガー実行が処理権を保持している（有効期限内）。
           ALREADY_TERMINAL: listPendingWithBody取得後、別の実行が既に完了させた。
           LOCK_TIMEOUT: 一時的な混雑。 */
        skippedCount++;
        continue;
      }
      var rowNumber = claimResult.rowNumber;
      var generation = Number(claimResult.record.processingClaimCount);
      var result;
      try {
        result = processSingleEvent_(rowNumber, claimResult.record, auditNow, generation);
      } catch (unexpectedError) {
        /* 1件の想定外の例外で、同じ実行の後続候補まで止めない。 */
        Logger.log('StripeWebhookProcessor: イベント処理中に想定外の例外が発生しました eventId=' + item.record.eventId + ' ' + describeError_(unexpectedError));
        result = outcome_(false, 'UNEXPECTED_ERROR', '想定外のエラーが発生しました。再試行します。');
      }
      if (!result.finalized && result.code !== 'SUPERSEDED_BY_NEWER_ATTEMPT') {
        /* 未完了のまま終えた候補は処理権を手放し、次のトリガー実行ですぐ再試行させる
           （手放せなくても、有効期限の経過後に再取得される）。 */
        try {
          StripeEventRepository.releaseProcessingClaim(rowNumber, generation, new Date());
        } catch (releaseError) {
          Logger.log('StripeWebhookProcessor: 処理権の解放に失敗しました eventId=' + item.record.eventId + ' ' + describeError_(releaseError));
        }
      }
      results.push(Object.assign({ eventId: item.record.eventId }, result));
      if (result.finalized) {
        processedCount++;
      } else {
        skippedCount++;
      }
    }

    return {
      candidateCount: pending.length,
      processedCount: processedCount,
      skippedCount: skippedCount,
      deferredCount: deferredCount,
      results: results
    };
  }

  return {
    processPendingStripeWebhookEvents: processPendingStripeWebhookEvents
  };
})();
