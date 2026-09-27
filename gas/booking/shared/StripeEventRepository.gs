/*
 * StripeEventRepository.gs — Stripe Webhookイベントの永続的な受信・処理台帳
 * （Issue #341 PR-C「6. イベントの冪等性」。レビュー対応・4回目で受信キューへ再設計）。
 * FeeSettlementRepository.gs（日程変更精算の冪等性台帳）と同じ設計パターン：専用の
 * 「StripeEvents」シートへ、イベントごとに1行の処理状態を記録する。
 *
 * 【レビュー対応・4回目での再設計】1〜3回目までは、独立したBooking Webhookプロジェクトの
 * doPost内でこの台帳への記録と、決済照合・予約自動確定までを一括して行っていた。
 * Booking WebhookとBooking Adminは別々のLockService.getScriptLock()を持つため、両者が
 * 同じ予約を並行して変更する可能性を排除するために予約単位の分散ロック
 * （BookingLockRepository）を作り込んだが、「ロックの有効性確認から実際の書き込みまでの
 * 間に競合が起こり得る（TOCTOU）」という指摘を受けた。ロックの確認箇所を増やしても
 * この種の競合はなくならないため、根本的にアーキテクチャを見直した：
 *
 * - **Booking Webhookプロジェクト**は、署名検証済みイベントをこの台帳へ**安全に永続化する
 *   だけ**にする（決済照合・予約自動確定は一切行わない）。Stripeへの成功応答は
 *   「イベントを安全に記録できたこと」だけを条件にする。
 * - **Booking Adminプロジェクト**の時間主導トリガー（`processPendingStripeWebhookEvents`。
 *   `BookingTriggers.gs`参照）が、この台帳から未処理のイベントを取り出し、決済照合・
 *   予約自動確定まで行う（`StripeWebhookProcessor.gs`）。
 *
 * これにより、Webhook由来の予約確定（Booking Adminプロジェクト内で実行）と、既存の
 * `expirePendingBookings`（同じくBooking Adminプロジェクト）が**同じ
 * LockService.getScriptLock()を共有する**ようになり、独自の分散ロックを一切必要とせず
 * （＝Sheetsのappend順序整列のような未保証の前提に一切依存せずに）、GAS公式の
 * LockServiceだけで確実な排他を実現できる（詳細はREADME「Webhookと失効処理の競合」節・
 * `BookingRepository.gs`のexpirePendingBookingsコメント参照）。
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
 * - RECEIVED: Booking Webhookが受信・永続化した（`rawBody`列に生のイベント本文を保存
 *   済み）が、Booking Admin側でまだ最終結果が確定していない。
 * - COMPLETED: Booking Admin側の処理が完了した（決済状態の更新・予約自動確定の試行まで
 *   完了。自動確定自体が失敗してRecoveryへ回った場合もCOMPLETEDとする）。
 * - IGNORED: このイベントに対して何も行う必要がなかった（対象外のイベント種別、
 *   まだ支払いが完了していないcheckout.session.completed等）。
 * - REJECTED: 識別子・金額の不一致等、構造的に処理できないと判断した（Recoveryへ記録
 *   済み）。再送されても結果は変わらない。
 *
 * `claim()`（Webhook側の同一イベント同時受信の弾き。claimedAt/claimCount列）と
 * `claimForProcessing()`（Admin側のトリガー重複実行時の二重処理防止。
 * processingClaimedAt/processingClaimCount列）は、意図的に別の名前空間を持つ
 * （呼び出し元プロジェクトのLockService.getScriptLock()。台帳への読み書きだけを保護する
 * 短時間Lockで、外部Stripe API呼び出しはLockの外で行う既存方針を踏襲）。
 *
 * 【なぜ2つの関数に分けたか（レビュー対応・4回目で発覚した設計バグの修正）】
 * 当初は両方が同じclaimedAt/claimCountを共有していたが、それだとWebhookが受信した
 * 直後（＝claimedAtが「たった今」に更新された直後）を、Admin側が「最近claimされた＝
 * 処理中の疑いがある」と誤判定してしまい、Admin側のstaleAfterMs（既定2分）が経過する
 * まで新規受信イベントに一切着手できないバグがあった。名前空間を分離したことで、
 * Admin側は「一度もAdmin自身が着手していない行」を常に即座に着手対象にできる。
 *
 * RECEIVEDのまま一定時間（staleAfterMs）を超えて放置された行は「前回の処理が
 * クラッシュ・タイムアウトした」とみなし、再度claimして安全に再開できる（Admin側が呼ぶ
 * BookingRepository.applyPaymentStateUpdate/confirmBookingはいずれもそれ自体が冪等な
 * ため、同じ処理を最初からやり直しても安全に収束する）。
 *
 * 【レビュー対応・5回目で追加】claimForProcessing()のstaleAfterMs判定だけでは、
 * 正常に実行中の処理（Stripe再照会に時間がかかっている等）がstaleAfterMsを超えた
 * 時点で「クラッシュした」と誤判定され、別のトリガー実行に処理権を奪われる恐れが
 * あった。これを防ぐため:
 * - `renewProcessingLease()`（7回目で`confirmProcessingClaim()`へ改名し、有効期限を
 *   延長しない確認へ役割を変更。下記参照）: 処理を続けている実行が定期的に呼び、
 *   processingClaimedAt（ハートビート）だけを更新する（processingClaimCountという
 *   「世代番号」は変えない）。実行中である限りage判定は常に短く保たれ、時間経過
 *   だけで処理権が渡ることはない。
 * - `finalizeForProcessing()`: 書き込み直前に現在の世代番号を再確認してから書き込む
 *   （fencing token）。confirmProcessingClaim()の確認から実際の書き込みまでの間に
 *   別の実行へ処理権が移っていた場合でも、古い実行の書き込みが新しい実行の結果を
 *   上書きすることを防ぐ。
 * 採用方式の保証範囲はREADME「Webhookと失効処理の競合」節に明記した。
 *
 * 【レビュー対応・7回目で再設計】ハートビートはStripe API（UrlFetchApp.fetch）の応答待ち
 * 中には更新できない（UrlFetchAppにはタイムアウトを指定するオプションが無く、応答が
 * いつ戻るかを呼び出し側で制御できない）。そのため「ハートビートが2分途絶えたら停止と
 * みなす」方式では、応答待ちが2分を超えた正常な実行から処理権を奪い得た。7回目では:
 * - 処理権の再取得判定を、ハートビートではなく`processingLeaseExpiresAt`（処理権の
 *   有効期限）だけで行う。有効期限は「その実行の開始時刻（実時間）＋Apps Scriptの
 *   1実行あたりの最大実行時間（6分）＋余裕」として呼び出し元が決める。Apps Scriptは
 *   上限を超えた実行を強制終了するため、有効期限が過ぎた時点で元の実行は（Apps Scriptの
 *   上限が守られる限り）もう動いていない。ハートビートで有効期限を延長することはしない。
 * - ハートビート（`confirmProcessingClaim`）は生存記録（processingHeartbeatAt）と
 *   世代確認のためだけに残す。processingClaimedAtは「その世代が着手した時刻」として
 *   claim時にだけ書き、以後上書きしない。
 * - 上限の前提が崩れた場合（Google側の仕様変更等）に備え、Bookings・Calendar・Recoveryへの
 *   書き込みは、書き込み処理自身が保持するLockService.getScriptLock()の中で
 *   `isProcessingClaimCurrentLocked`により世代を再確認してから行う（fencing）。処理権の
 *   再取得（claimForProcessing）も同じLockの中で世代を進めるため、確認と書き込みの間に
 *   世代が進むことはない。
 * - 処理が未完了のまま終わった（Stripe照会失敗等）場合は`releaseProcessingClaim`で
 *   有効期限を即座に失効させ、次回のトリガー実行ですぐ再試行できるようにする。
 */
'use strict';

var StripeEventRepository = (function () {
  var SHEET_NAME_ = 'StripeEvents';
  var HEADERS_ = [
    'eventId', 'eventType', 'receivedAt', 'claimedAt', 'claimCount',
    'processingState', 'bookingId', 'paymentAttemptId', 'stripePaymentIntentId',
    'outcomeCode', 'outcomeMessage', 'updatedAt', 'rawBody',
    'processingClaimedAt', 'processingClaimCount',
    /* レビュー対応・7回目で追加（既存列の位置は変えず末尾へ追加）。 */
    'processingHeartbeatAt', 'processingLeaseExpiresAt'
  ];

  var STATE = { RECEIVED: 'RECEIVED', COMPLETED: 'COMPLETED', IGNORED: 'IGNORED', REJECTED: 'REJECTED' };
  var TERMINAL_STATES_ = [STATE.COMPLETED, STATE.IGNORED, STATE.REJECTED];

  var CLAIM_LOCK_TIMEOUT_MS_ = 10000;
  /* RECEIVEDのまま放置されたら「前回の実行がクラッシュ/タイムアウトした」とみなし
     再claimしてよい猶予（既定5分）。GAS Web App/トリガーの1回の実行が現実的にこれより
     長く動き続けることは想定しない。 */
  var DEFAULT_STALE_AFTER_MS_ = 5 * 60 * 1000;
  var RAW_BODY_INDEX_ = HEADERS_.indexOf('rawBody');
  /* processingLeaseExpiresAtが空のまま処理権だけ記録された行（7回目より前の形式）に
     適用する有効期限。StripeWebhookProcessorが通常渡す有効期限（6分＋余裕）と同じ長さ。 */
  var LEGACY_PROCESSING_LEASE_MS_ = 7 * 60 * 1000;

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
   * このeventIdをBooking Webhookが受け付けてよいかを排他的に判定・記録する
   * （呼び出し元プロジェクトのLockService.getScriptLock()を使う）。同一イベントの
   * 並行受信・重複配信の弾きに使う（claimedAt/claimCount列を使う。この2列は
   * このclaim()専用の名前空間であり、下記claimForProcessing専用の
   * processingClaimedAt/processingClaimCountとは別管理）。
   *
   * 【レビュー対応・4回目の設計変更】当初はAdmin側の処理着手（トリガー重複実行時の
   * 二重処理防止）もこの同じclaimedAt/claimCountを使って行っていたが、Webhookが
   * イベントを受信した直後（＝claimedAtが「たった今」に更新された直後）は、Admin側の
   * トリガーがまだ一度も着手していなくても「最近claimされた＝処理中の疑いがある」と
   * 誤判定してしまい、staleAfterMs（既定2分）が経過するまで一切処理に着手できない
   * バグがあった。Admin側の処理着手判定は必ずclaimForProcessing（別名前空間）を使うこと。
   *
   * 戻り値:
   * - { outcome: 'CLAIMED', rowNumber, record, isRetry }: 受け付けてよい
   *   （isRetry:trueは、前回RECEIVEDのまま停止していた行を再claimしたことを示す）。
   * - { outcome: 'ALREADY_TERMINAL', rowNumber, record }: 既に最終結果が確定済み。
   *   呼び出し元は再処理せず、記録済みの結果をそのまま返してよい。
   * - { outcome: 'IN_PROGRESS', rowNumber, record }: 同一イベントの並行受信が処理中の
   *   可能性が高い。呼び出し元は処理を行わず、Stripe側の自動再送に委ねる。
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
      /* 見つからなかった: 新規イベント。RECEIVEDとして1行追加する（rawBodyは空。
         Webhook側がclaim()直後にstoreRawBody()で埋める）。processingClaimedAt/
         processingClaimCountはclaimForProcessing専用の別名前空間のため空のまま
         （下記claimForProcessing冒頭コメント参照）。 */
      var newRow = [
        eventId, eventType || '', effectiveNow, effectiveNow, 1,
        STATE.RECEIVED, '', '', '', '', '', effectiveNow, '', '', '', '', ''
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
   * このeventIdの処理にBooking Admin側のトリガー実行が着手してよいかを排他的に
   * 判定・記録する（レビュー対応・4回目で新設。呼び出し元プロジェクトの
   * LockService.getScriptLock()を使う）。トリガー実行が重複した場合の二重処理防止に使う。
   *
   * claim()とは別のprocessingClaimedAt/processingClaimCount列を使う（claim()冒頭コメント
   * 参照）。この行がまだ一度もAdmin側に着手されていない場合は即座にCLAIMEDを返す。
   *
   * 【レビュー対応・7回目で引数と判定を変更】
   * - claimedAt: このイベントに着手する瞬間の実時間（呼び出し元が`new Date()`で取る）。
   *   トリガー開始時刻や業務上の監査時刻を渡してはならない。processingClaimedAtへ
   *   そのまま記録され、以後ハートビートで上書きされない。
   * - leaseExpiresAt: この処理権の有効期限。呼び出し元の実行がApps Scriptの最大実行時間
   *   によって確実に終了している時刻を渡す（StripeWebhookProcessor参照）。
   * - 既存の処理権は、processingLeaseExpiresAtを過ぎるまで再取得させない（ハートビートの
   *   新旧は見ない。Stripe APIの応答待ち中はハートビートを更新できないため）。
   *
   * 戻り値: CLAIMED/ALREADY_TERMINAL/IN_PROGRESS/LOCK_TIMEOUT/NOT_FOUND
   * （NOT_FOUNDは通常起こらない。呼び出し元はlistPendingWithBody()の結果を使うため）。
   */
  function claimForProcessing(eventId, eventType, claimedAt, leaseExpiresAt) {
    if (!eventId) {
      throw new Error('eventIdを指定してください。');
    }
    if (!isDateLike_(claimedAt) || !isDateLike_(leaseExpiresAt) || leaseExpiresAt.getTime() <= claimedAt.getTime()) {
      throw new Error('claimForProcessingには着手時刻（実時間）と、それより後の処理権の有効期限を指定してください。');
    }

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
          var currentLeaseExpiresAtMillis = currentLeaseExpiresAtMillis_(record);
          if (!isNaN(currentLeaseExpiresAtMillis) && claimedAt.getTime() < currentLeaseExpiresAtMillis) {
            return { outcome: 'IN_PROGRESS', rowNumber: rowNumber, record: record };
          }
          var nextProcessingClaimCount = (Number(record.processingClaimCount) || 0) + 1;
          var processingClaimedAtIndex = HEADERS_.indexOf('processingClaimedAt');
          sheet.getRange(rowNumber, processingClaimedAtIndex + 1, 1, 4).setValues([[
            claimedAt, nextProcessingClaimCount, '', leaseExpiresAt
          ]]);
          record.processingClaimedAt = claimedAt;
          record.processingClaimCount = nextProcessingClaimCount;
          record.processingHeartbeatAt = '';
          record.processingLeaseExpiresAt = leaseExpiresAt;
          return { outcome: 'CLAIMED', rowNumber: rowNumber, record: record, isRetry: nextProcessingClaimCount > 1 };
        }
      }
      return { outcome: 'NOT_FOUND' };
    } finally {
      lock.releaseLock();
    }
  }

  /* 現在の処理権の有効期限（ミリ秒）。まだ一度も着手されていなければNaN。 */
  function currentLeaseExpiresAtMillis_(record) {
    var leaseMillis = toMillis_(record.processingLeaseExpiresAt);
    if (record.processingLeaseExpiresAt !== '' && record.processingLeaseExpiresAt !== null &&
        record.processingLeaseExpiresAt !== undefined && !isNaN(leaseMillis)) {
      return leaseMillis;
    }
    var claimedMillis = toMillis_(record.processingClaimedAt);
    if (record.processingClaimedAt === '' || record.processingClaimedAt === null ||
        record.processingClaimedAt === undefined || isNaN(claimedMillis)) {
      return NaN;
    }
    return claimedMillis + LEGACY_PROCESSING_LEASE_MS_;
  }

  /* 呼び出し元がLockService.getScriptLock()を保持していることを前提に、rowNumberの行が
     まだ終端状態でなく、処理権の世代がgenerationのままかを返す（Lockは取得しない）。 */
  function isProcessingClaimCurrentLocked(rowNumber, generation) {
    var sheet = ensureSheet_();
    var row = sheet.getRange(rowNumber, 1, 1, HEADERS_.length).getValues()[0];
    if (!row || !row[0]) return false;
    var record = rowToRecord_(row);
    if (TERMINAL_STATES_.indexOf(record.processingState) !== -1) return false;
    return Number(record.processingClaimCount) === Number(generation);
  }

  /*
   * claimForProcessing()で処理権を得た実行が、処理の区切り（外部Stripe API呼び出しの
   * 後・Bookings/Calendarへの書き込みの前）で呼ぶ確認（レビュー対応・5回目で
   * renewProcessingLeaseとして新設し、7回目で役割を変更・改名）。
   *
   * 世代（processingClaimCount）がgenerationのままで終端状態でもなければ、
   * processingHeartbeatAtへnow（呼び出し元が取る実時間）を記録して{confirmed:true}を
   * 返す。記録は運用上の生存確認（どこまで進んだか）のためだけに使い、処理権の有効期限
   * （processingLeaseExpiresAt）は延長しない。有効期限を延ばせるのは、延ばした時点で
   * 実行がまだ確実に動いていると言える場合だけだが、Apps Scriptの実行は最大実行時間で
   * 打ち切られるため、実行開始時に決めた有効期限より後まで動き続けることはない。
   *
   * {confirmed:false}の場合（世代が進んでいる・終端状態・Lock取得失敗）、呼び出し元は
   * 直ちに処理を中断し、以後Bookings/Calendar/StripeEventsへ書き込んではならない。
   */
  function confirmProcessingClaim(rowNumber, generation, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CLAIM_LOCK_TIMEOUT_MS_)) {
      return { confirmed: false, reason: 'LOCK_TIMEOUT' };
    }
    try {
      if (!isProcessingClaimCurrentLocked(rowNumber, generation)) {
        return { confirmed: false, reason: 'STALE_GENERATION' };
      }
      var sheet = ensureSheet_();
      var heartbeatIndex = HEADERS_.indexOf('processingHeartbeatAt');
      sheet.getRange(rowNumber, heartbeatIndex + 1, 1, 1).setValue(effectiveNow);
      return { confirmed: true };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * 処理を未完了のまま終える実行（Stripe照会失敗・Lock混雑・想定外の例外等）が、自分の
   * 処理権を手放す（レビュー対応・7回目で新設）。世代がgenerationのままの場合にのみ
   * processingLeaseExpiresAtをnowへ書き換え、次回のトリガー実行が有効期限を待たずに
   * 再取得できるようにする。失敗しても安全（有効期限の経過後に再取得される）。
   */
  function releaseProcessingClaim(rowNumber, generation, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CLAIM_LOCK_TIMEOUT_MS_)) {
      return { released: false };
    }
    try {
      if (!isProcessingClaimCurrentLocked(rowNumber, generation)) {
        return { released: false };
      }
      var sheet = ensureSheet_();
      var leaseIndex = HEADERS_.indexOf('processingLeaseExpiresAt');
      sheet.getRange(rowNumber, leaseIndex + 1, 1, 1).setValue(effectiveNow);
      return { released: true };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * Webhook側が、claim()でCLAIMEDされた行へ生のイベント本文を保存する
   * （レビュー対応・4回目で新設）。この呼び出しが成功して初めて、Webhookは
   * Stripeへ成功応答を返してよい（「イベントを安全に永続化できたこと」＝rawBodyまで
   * 含めて保存できたこと）。
   */
  function storeRawBody(rowNumber, rawBody, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var sheet = ensureSheet_();
    sheet.getRange(rowNumber, RAW_BODY_INDEX_ + 1, 1, 1).setValue(rawBody || '');
    var updatedAtIndex = HEADERS_.indexOf('updatedAt');
    sheet.getRange(rowNumber, updatedAtIndex + 1, 1, 1).setValue(effectiveNow);
  }

  /*
   * Admin側の時間主導トリガーが処理すべき候補（processingState===RECEIVED、かつ
   * rawBodyが既に保存済み＝Webhook側の永続化が完了している行）を一覧する
   * （レビュー対応・4回目で新設）。rawBodyが空のRECEIVED行（Webhook側でstoreRawBody
   * まで到達せずクラッシュした行）は候補に含めない（claim()のstaleAfterMs経過後に
   * Webhook側の次回配信で再claim・再保存されるまで待つ。空のrawBodyのまま処理を
   * 試みてもStripeイベントの中身を復元できないため）。
   */
  function listPendingWithBody() {
    var sheet = ensureSheet_();
    var values = sheet.getDataRange().getValues();
    var pending = [];
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.processingState === STATE.RECEIVED && record.rawBody) {
        pending.push({ rowNumber: i + 1, record: record });
      }
    }
    return pending;
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
   * 【レビュー対応・5回目】本番のBooking Admin処理経路（StripeWebhookProcessor.gs）は
   * この関数を直接使わず、世代（processingClaimCount）の一致を書き込み直前に再確認する
   * `finalizeForProcessing`を使うこと（下記参照）。この`finalize`はfencingを行わない
   * ため、既に別の実行が処理を引き継いでいても無条件に上書きしてしまう。テストの
   * フィクスチャ構築（終端状態の行を直接作る等）や、世代管理が不要な用途にのみ使う。
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

  /*
   * finalize()のBooking Admin処理専用版（レビュー対応・5回目で新設）。書き込み前に
   * 現在の行のprocessingClaimCountを読み直し、呼び出し元のgeneration（claimForProcessing()
   * が返したrecord.processingClaimCount）と一致する場合にのみ書き込む（fencing token
   * パターン）。読み直し・世代確認・書き込みは同じLockService.getScriptLock()の
   * クリティカルセクション内で行うため、確認と書き込みの間に別の実行が割り込む余地はない。
   *
   * 【なぜ必要か】confirmProcessingClaim()による確認だけでは、直近の確認から実際の
   * finalize呼び出しまでの間にわずかな競合の余地が残る。例えば、直前の確認には成功した
   * 実行が、Stripe再照会やBookings書き込みでさらに時間を要し、その間に別の実行が
   * 処理権の有効期限の経過を検知してclaimForProcessingで世代を進めてしまうケース。
   * finalizeForProcessing自身が書き込み直前に世代を再確認することで、こうした
   * 「古い実行の遅延応答が新しい実行の処理結果を上書きする」事態を、確認と書き込みを
   * 1つのLock区間にまとめることで構造的に防ぐ（TOCTOUを再導入しない）。
   *
   * 戻り値:
   * - { written: true }: 書き込み成功。
   * - { written: false, reason: 'STALE_GENERATION' }: 既に別の実行が世代を進めている。
   *   呼び出し元はこの結果を破棄し、何もログ以外の対応をしてはならない（別の実行が
   *   この予約の処理を引き継いでいる）。
   * - { written: false, reason: 'ALREADY_TERMINAL' }: 既に終端状態に到達済み（別の実行が
   *   既にfinalizeForProcessingを完了させた）。
   * - { written: false, reason: 'LOCK_TIMEOUT' }: Lock取得に失敗した。行はRECEIVEDのまま
   *   残るため、次回のトリガー実行で安全に再開できる。
   */
  function finalizeForProcessing(rowNumber, generation, fields, now) {
    if (TERMINAL_STATES_.indexOf(fields.processingState) === -1) {
      throw new Error('finalizeForProcessingにはCOMPLETED/IGNORED/REJECTEDのいずれかを指定してください: ' + fields.processingState);
    }
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CLAIM_LOCK_TIMEOUT_MS_)) {
      return { written: false, reason: 'LOCK_TIMEOUT' };
    }
    try {
      var sheet = ensureSheet_();
      var row = sheet.getRange(rowNumber, 1, 1, HEADERS_.length).getValues()[0];
      var record = rowToRecord_(row);
      if (TERMINAL_STATES_.indexOf(record.processingState) !== -1) {
        return { written: false, reason: 'ALREADY_TERMINAL' };
      }
      if (Number(record.processingClaimCount) !== Number(generation)) {
        return { written: false, reason: 'STALE_GENERATION' };
      }
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
      return { written: true };
    } finally {
      lock.releaseLock();
    }
  }

  return {
    STATE: STATE,
    findByEventId: findByEventId,
    claim: claim,
    claimForProcessing: claimForProcessing,
    isProcessingClaimCurrentLocked: isProcessingClaimCurrentLocked,
    confirmProcessingClaim: confirmProcessingClaim,
    releaseProcessingClaim: releaseProcessingClaim,
    storeRawBody: storeRawBody,
    listPendingWithBody: listPendingWithBody,
    finalize: finalize,
    finalizeForProcessing: finalizeForProcessing
  };
})();
