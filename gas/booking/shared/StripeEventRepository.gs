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
 * - `renewProcessingLease()`: 処理を続けている実行が定期的に呼び、
 *   processingClaimedAt（ハートビート）だけを更新する（processingClaimCountという
 *   「世代番号」は変えない）。実行中である限りage判定は常に短く保たれ、時間経過
 *   だけで処理権が渡ることはない。
 * - `finalizeForProcessing()`: 書き込み直前に現在の世代番号を再確認してから書き込む
 *   （fencing token）。renewProcessingLease()の確認から実際の書き込みまでの間に
 *   別の実行へ処理権が移っていた場合でも、古い実行の書き込みが新しい実行の結果を
 *   上書きすることを防ぐ。
 * 採用方式の保証範囲はREADME「Webhookと失効処理の競合」節に明記した。
 */
'use strict';

var StripeEventRepository = (function () {
  var SHEET_NAME_ = 'StripeEvents';
  var HEADERS_ = [
    'eventId', 'eventType', 'receivedAt', 'claimedAt', 'claimCount',
    'processingState', 'bookingId', 'paymentAttemptId', 'stripePaymentIntentId',
    'outcomeCode', 'outcomeMessage', 'updatedAt', 'rawBody',
    'processingClaimedAt', 'processingClaimCount'
  ];

  var STATE = { RECEIVED: 'RECEIVED', COMPLETED: 'COMPLETED', IGNORED: 'IGNORED', REJECTED: 'REJECTED' };
  var TERMINAL_STATES_ = [STATE.COMPLETED, STATE.IGNORED, STATE.REJECTED];

  var CLAIM_LOCK_TIMEOUT_MS_ = 10000;
  /* RECEIVEDのまま放置されたら「前回の実行がクラッシュ/タイムアウトした」とみなし
     再claimしてよい猶予（既定5分）。GAS Web App/トリガーの1回の実行が現実的にこれより
     長く動き続けることは想定しない。 */
  var DEFAULT_STALE_AFTER_MS_ = 5 * 60 * 1000;
  var RAW_BODY_INDEX_ = HEADERS_.indexOf('rawBody');

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
        STATE.RECEIVED, '', '', '', '', '', effectiveNow, '', '', ''
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
   * 参照）。この行がまだ一度もAdmin側に着手されていない場合（processingClaimedAtが空）は
   * 即座にCLAIMEDを返す。Webhookが受信した直後かどうかは一切見ない（claimedAtは見ない）
   * ため、受信直後の初回ポーリングが不当にIN_PROGRESS扱いされることはない。
   *
   * 戻り値の意味はclaim()と同じ（CLAIMED/ALREADY_TERMINAL/IN_PROGRESS/LOCK_TIMEOUT）。
   * 対象の行が見つからない場合はNOT_FOUNDを返す
   * （通常起こらない。呼び出し元はlistPendingWithBody()の結果を使うため）。
   */
  function claimForProcessing(eventId, eventType, now, staleAfterMs) {
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
          var processingClaimedAtMillis = toMillis_(record.processingClaimedAt);
          var ageMillis = isNaN(processingClaimedAtMillis) ? Infinity : effectiveNow.getTime() - processingClaimedAtMillis;
          if (ageMillis < effectiveStaleAfterMs) {
            return { outcome: 'IN_PROGRESS', rowNumber: rowNumber, record: record };
          }
          var nextProcessingClaimCount = (Number(record.processingClaimCount) || 0) + 1;
          var processingClaimedAtIndex = HEADERS_.indexOf('processingClaimedAt');
          sheet.getRange(rowNumber, processingClaimedAtIndex + 1, 1, 2).setValues([[effectiveNow, nextProcessingClaimCount]]);
          record.processingClaimedAt = effectiveNow;
          record.processingClaimCount = nextProcessingClaimCount;
          return { outcome: 'CLAIMED', rowNumber: rowNumber, record: record, isRetry: nextProcessingClaimCount > 1 };
        }
      }
      return { outcome: 'NOT_FOUND' };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * claimForProcessing()で処理権を得た実行が、まだ生きて処理を続けていることを示す
   * ハートビート（レビュー対応・5回目で新設）。processingClaimedAtだけを更新し、
   * processingClaimCount（世代番号）は変更しない。呼び出し元プロジェクトの
   * LockService.getScriptLock()を使う。
   *
   * generationにはclaimForProcessing()が返したrecord.processingClaimCountをそのまま
   * 渡すこと。現在の行のprocessingClaimCountがこのgenerationと一致する場合にのみ
   * 更新する（一致しない場合は、既に別の実行が再claimして世代が進んでいる、または
   * 既に終端状態へ進んでいるため、更新してはならない）。
   *
   * 【なぜ必要か（レビュー対応・5回目）】4回目まではclaimForProcessing()の
   * staleAfterMs判定だけに頼っていたため、1件のイベント処理がstaleAfterMs
   * （既定2分）を超えて実行中なだけでも、別のトリガー実行が「クラッシュした」と
   * 誤判定して処理権を奪ってしまい、二重処理につながる恐れがあった。実際に処理を
   * 続けている実行がこれを定期的に呼んでprocessingClaimedAtを更新し続ける限り、
   * claimForProcessing()のage判定は常に短く保たれ、時間経過だけで処理権が奪われる
   * ことはない（詳細はStripeWebhookProcessor.gs・README「Webhookと失効処理の競合」節
   * 参照）。
   *
   * 戻り値: { renewed: true } / { renewed: false }（世代が既に進んでいる、行が
   * 見つからない、または終端状態に到達済み。呼び出し元は直ちにこの回の処理を中断し、
   * 以後Bookings/Calendarへの書き込み・finalizeForProcessing呼び出しを一切
   * 行ってはならない。別の実行が既にこのイベントの処理を引き継いでいる）。
   */
  function renewProcessingLease(rowNumber, generation, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CLAIM_LOCK_TIMEOUT_MS_)) {
      return { renewed: false };
    }
    try {
      var sheet = ensureSheet_();
      var row = sheet.getRange(rowNumber, 1, 1, HEADERS_.length).getValues()[0];
      if (!row || !row[0]) {
        return { renewed: false };
      }
      var record = rowToRecord_(row);
      if (TERMINAL_STATES_.indexOf(record.processingState) !== -1) {
        return { renewed: false };
      }
      if (Number(record.processingClaimCount) !== Number(generation)) {
        return { renewed: false };
      }
      var processingClaimedAtIndex = HEADERS_.indexOf('processingClaimedAt');
      sheet.getRange(rowNumber, processingClaimedAtIndex + 1, 1, 1).setValue(effectiveNow);
      return { renewed: true };
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
   * 【なぜ必要か】renewProcessingLease()による生存確認だけでは、直近の確認から実際の
   * finalize呼び出しまでの間にわずかな競合の余地が残る。例えば、直前のrenewには成功した
   * 実行が、Stripe再照会やBookings書き込みでさらに時間を要し、その間に別の実行が
   * staleAfterMsの経過を検知してclaimForProcessingで世代を進めてしまうケース。
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
    renewProcessingLease: renewProcessingLease,
    storeRawBody: storeRawBody,
    listPendingWithBody: listPendingWithBody,
    finalize: finalize,
    finalizeForProcessing: finalizeForProcessing
  };
})();
