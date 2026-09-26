/*
 * BookingLockRepository.gs — 予約単位の排他制御（Issue #341 PR-Cレビュー対応・2回目で新設、
 * 3回目で実装バグを修正し設計の前提を見直した）。
 *
 * 【背景】レビュー対応・1回目でBooking Webhookプロジェクトを独立させた結果、Webhookによる
 * 予約確定（StripeWebhookHandler.processEvent → applyPaymentStateUpdate + confirmBooking）と、
 * Booking AdminプロジェクトのexpirePendingBookings（枠解放）は、もはや同じ
 * LockService.getScriptLock()を共有しない（GASのLockServiceはスクリプトプロジェクト単位）。
 * 1回目の対応（各々の最新状態再読込・猶予時間・failed→paid遷移の許可）は「一方が最新状態を
 * 読み終えた直後に他方が状態を変更する」という狭いレースを排除できず、2回目の対応で
 * このファイルを新設し、共有Spreadsheet上の「BookingLocks」シートへのappendRow＋直後の
 * 全件読み直しで予約単位の排他制御を実装した。
 *
 * 【3回目レビュー対応で修正した実装バグ】
 * 1. **チケット行の取り違え**: 2回目時点の実装は`appendRow`直後に`sheet.getLastRow()`を
 *    呼んで「自分の行番号」としていたが、並行して別の実行が同時にappendしていれば
 *    `getLastRow()`は相手の行番号を返し得る（`appendRow`自体は書き込んだ行番号を返さない
 *    ため、位置に頼るこの実装は原理的に誤り）。修正: 追加直後の全件読み直しで、
 *    一意な`holderId`が一致する行を**内容で検索**して自分の行を特定する（`acquire`参照）。
 *    `release`も同様に、指定された`holderId`が実際にその行の保持者であることを確認して
 *    からのみ`releasedAt`を書き込む（他者の行を誤って解放しない）。
 * 2. **期限切れ後も古い保持者が書き込める**: 2回目時点の実装は、TTL経過後に**別の**
 *    呼び出しがチケットを再取得できることしか保証しておらず、TTLを過ぎた**元の保持者**
 *    自身がCalendar/Bookingsへの書き込みを続けることを妨げていなかった（`acquire`の
 *    成否判定はクリティカルセクションの**開始時**に1回行うだけで、区間の途中でTTLが
 *    切れても誰も検知しなかった）。修正: `isHeld(rowNumber, holderId, now)`を追加し、
 *    呼び出し元（StripeWebhookHandler.gs・BookingRepository.gsのexpirePendingBookings）は
 *    実際に破壊的な書き込み（Calendar削除・setEventStatus、Bookingsのstatus/paymentStatus
 *    書き込み）を行う**直前**に必ずこれを呼び、falseならその書き込みを行わずに中断する
 *    ことを必須の契約とした。これによりTTLは「クラッシュ後に他者が再取得できるまでの
 *    猶予」であると同時に「自分自身がその後は書き込んではならない締切」として機能する。
 *
 * 【採用方式の保証範囲（3回目レビュー対応で明記）】
 * **この排他制御は、Google SheetsのappendRow・read-backだけを「複数のGASプロジェクトを
 * またぐ、公式に保証された原子的ロック」として前提にしていない**。Googleは、異なる
 * クライアント（プロジェクトが違っても同じSpreadsheetへの操作を含む）からの並行した
 * appendRowが単一の直列順序へ整列されることを、Sheets API/Apps Scriptの正式なAPI契約
 * として文書化していない（実運用上は概ねその通りに振る舞うと考えられるが、これは
 * 観測された挙動であって保証された契約ではない）。したがって本実装は、この整列を
 * 「ベストエフォートで競合の発生確率を大きく下げる手段」として位置づけ、**それだけを
 * 唯一の安全装置にはしない**。
 *
 * 実際に「両プロジェクトが同じ予約に対してそれぞれ成功したと判断する状態」を防いでいる
 * のは、以下の3層の組み合わせである（上から順に、それぞれ独立して機能する）:
 * 1. 本ファイルのappend-then-read-back方式によるロック取得（ベストエフォート。上記の
 *    とおり公式に保証された契約ではない）。
 * 2. **`isHeld`による書き込み直前の再検証**（このファイルの契約。3回目で追加）。
 *    ロックを取得したつもりでも、TTLが切れていれば実際の書き込みは行われない。
 * 3. **呼び出し側に既存の、通常の読み書き整合性だけに依存する再確認**
 *    （`confirmBooking`が書き込み直前にBookings台帳を再読込しstatus===EXPIREDを拒否する、
 *    `expirePendingBookings`が書き込み直前にpaymentStatusを再読込する、等。いずれも
 *    「直前に書き込まれた値を直後の読み込みが見る」という、Spreadsheetが単一の
 *    ドキュメントである以上ほぼ確実に成り立つ、遥かに弱く自明な前提にしか依存しない。
 *    並行するappendの順序整列のような強い前提を必要としない）。
 *
 * **障害時の挙動**: 仮に1のappend順序整列という前提が何らかの理由で崩れ、2つの実行が
 * 一時的に「自分がロックを取得した」と誤認したとしても、2（isHeld）がその後の書き込みを
 * 早期に食い止める可能性があり、さらに3（呼び出し側の既存の再読込）が両者の最終的な
 * 書き込みの順序に関わらず「後から書き込む側」に相手の結果を確実に検知させる。この結果、
 * 最悪の場合でも「両方が成功したと判断する」状態には至らず、一方が安全側（Recoveryへの
 * 記録・自動処理停止）に倒れる。これは、このコードベースが既存のcreateBooking対
 * スペースマーケット外部書き込みの競合で採用している「絶対に競合しないではなく、直前
 * 再確認とRecovery記録でリスクを最小化する」設計方針と同種のものである。
 *
 * 【保護する範囲】このロックはBookings/Calendarへの確定的な変更（Webhook側は
 * applyPaymentStateUpdate〜confirmBooking、Admin側はCalendar削除〜status:EXPIRED書き込み）
 * の直前でのみ取得し、Stripe API呼び出し（署名検証済みイベントの再照会・金額照合等、
 * いずれもロック取得前に完了させる）の最中には保持しない。
 *
 * 【TTL（既定60秒）について】保護区間はSheets/Calendarへの数回のAPI呼び出しのみ
 * （外部HTTP呼び出しを含まない）で、実運用でも数秒以内に完了する想定のため、60秒は
 * 十分すぎる安全マージンを持たせた値である。この猶予は「クラッシュ・異常終了からの
 * 回復用」であり、レビュー対応・1回目のCardPayment.WEBHOOK_RACE_GRACE_MINUTES
 * （10分）のように「これ自体が競合を防ぐ根拠」ではない（実際に競合を防ぐのは上記の
 * 3層の組み合わせ）。
 *
 * 【一方が取得できなかった場合】呼び出し元の責務とする。expirePendingBookingsは
 * 1回の候補処理で1回だけ試行し、取得できなければこの回はスキップして次回のトリガー
 * 実行に委ねる（バックグラウンド処理のため急ぐ必要がない）。StripeWebhookHandlerは
 * 短い間隔で数回だけ再試行し、それでも取得できなければStripeへ再送を促す一時失敗
 * として返す（Stripe側の自動再送に委ねる。イベント台帳はRECEIVEDのまま残る）。
 *
 * 【既知の限界】BookingLocksシートは行を追加し続ける一方で自動削除しない
 * （StripeEventsシートと同じ設計判断。運用上肥大化した場合は手動アーカイブを検討する）。
 */
'use strict';

var BookingLockRepository = (function () {
  var SHEET_NAME_ = 'BookingLocks';
  var HEADERS_ = ['bookingId', 'holderId', 'ownerTag', 'acquiredAt', 'expiresAt', 'releasedAt'];
  var DEFAULT_TTL_MS_ = 60 * 1000;

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

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function toMillis_(value) {
    if (isDateLike_(value)) return value.getTime();
    if (!value) return NaN;
    var parsed = new Date(value).getTime();
    return isNaN(parsed) ? NaN : parsed;
  }

  var BOOKING_ID_INDEX_ = HEADERS_.indexOf('bookingId');
  var HOLDER_ID_INDEX_ = HEADERS_.indexOf('holderId');
  var EXPIRES_AT_INDEX_ = HEADERS_.indexOf('expiresAt');
  var RELEASED_AT_INDEX_ = HEADERS_.indexOf('releasedAt');

  function isActiveRow_(row, nowMillis) {
    if (row[RELEASED_AT_INDEX_]) return false; /* 既にrelease済み */
    var expiresAtMillis = toMillis_(row[EXPIRES_AT_INDEX_]);
    return !isNaN(expiresAtMillis) && expiresAtMillis > nowMillis;
  }

  /*
   * bookingId単位のロックを取得する。holderIdは呼び出し元が試行のたびに新しく発行する
   * 一意な値であること（例: Utilities.getUuid()。同じ呼び出し元が同じbookingIdへ複数回
   * acquireする場合も毎回新しいholderIdを使う）。この一意性が、並行するappendの中から
   * 自分自身の行を取り違えなく特定するための唯一の手がかりになる（`sheet.getLastRow()`は
   * 使わない。3回目レビュー対応・項目1参照）。
   *
   * 戻り値: { acquired: true, rowNumber, holderId } / { acquired: false }
   * acquired:trueの場合、呼び出し元は:
   *   (a) 実際に破壊的な書き込みを行う直前に必ずisHeld(rowNumber, holderId, now)を確認し、
   *       falseならその書き込みを行わずに中断すること（3回目レビュー対応・項目2の必須契約）。
   *   (b) 処理完了後（成功・失敗を問わず）に必ずrelease(rowNumber, holderId)を呼ぶこと
   *       （try/finallyで保護する）。
   */
  function acquire(bookingId, holderId, ownerTag, now, ttlMs) {
    if (!bookingId) throw new Error('bookingIdを指定してください。');
    if (!holderId) throw new Error('holderIdを指定してください。');
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var nowMillis = effectiveNow.getTime();
    var effectiveTtlMs = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS_;
    var expiresAt = new Date(nowMillis + effectiveTtlMs);

    var sheet = ensureSheet_();
    sheet.appendRow([bookingId, holderId, ownerTag || '', effectiveNow, expiresAt, '']);

    /*
     * 追加直後に全件を読み直す。自分の行は「一意なholderIdが一致する行」として検索する
     * （sheet.getLastRow()に頼らない。並行して別の実行が同時にappendしていた場合、
     * getLastRow()は相手の行番号を返し得るため）。
     */
    var values = sheet.getDataRange().getValues();
    var myRowNumber = null;
    var earliestActiveRowNumber = null;
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (row[BOOKING_ID_INDEX_] !== bookingId) continue;
      var rowNumber = i + 1;
      if (myRowNumber === null && row[HOLDER_ID_INDEX_] === holderId) {
        myRowNumber = rowNumber;
      }
      if (!isActiveRow_(row, nowMillis)) continue;
      if (earliestActiveRowNumber === null || rowNumber < earliestActiveRowNumber) {
        earliestActiveRowNumber = rowNumber;
      }
    }

    if (myRowNumber === null) {
      /* 直前にappendした自分の行が読み直しで見つからないのは通常起こり得ない
         （ensureSheet_/appendRow自体が想定外の状態になっている場合のみ）。安全側に倒し
         取得失敗として扱う。 */
      Logger.log('BookingLockRepository: 追加した自分のチケットが読み直しで見つかりませんでした: ' + bookingId + ' ' + holderId);
      return { acquired: false };
    }

    if (earliestActiveRowNumber !== myRowNumber) {
      /* 取得できなかった: 自分のチケットは無用に相手をブロックしないよう直ちに解放する
         （best effort。失敗してもexpiresAt経過で自然に失効するため致命的ではない）。 */
      try {
        releaseRow_(sheet, myRowNumber, holderId, effectiveNow);
      } catch (releaseError) {
        Logger.log('BookingLockRepository: 取得失敗チケットの解放に失敗しました: ' + bookingId + ' ' + releaseError);
      }
      return { acquired: false };
    }

    return { acquired: true, rowNumber: myRowNumber, holderId: holderId };
  }

  /*
   * 実際に破壊的な書き込み（Calendar削除・setEventStatus、Bookingsのstatus/paymentStatus
   * 書き込み等）を行う直前に必ず呼ぶこと。acquireが返したrowNumber・holderIdの組が
   * 「今なお有効（release済みでなく、TTLも経過していない）」ことを再検証する
   * （3回目レビュー対応・項目2）。falseが返った場合、呼び出し元はその書き込みを
   * 一切行わず、ロックを失ったものとして安全側の経路（スキップ・Recovery記録等）へ
   * 進むこと。
   */
  function isHeld(rowNumber, holderId, now) {
    if (!rowNumber || !holderId) return false;
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var sheet = ensureSheet_();
    if (rowNumber > sheet.getLastRow()) return false;
    var row = sheet.getRange(rowNumber, 1, 1, HEADERS_.length).getValues()[0];
    if (row[HOLDER_ID_INDEX_] !== holderId) return false;
    return isActiveRow_(row, effectiveNow.getTime());
  }

  function releaseRow_(sheet, rowNumber, holderId, effectiveNow) {
    if (rowNumber > sheet.getLastRow()) {
      throw new Error('BookingLockRepository.release: 存在しない行番号が指定されました（rowNumber=' + rowNumber + '）。');
    }
    var row = sheet.getRange(rowNumber, 1, 1, HEADERS_.length).getValues()[0];
    if (row[HOLDER_ID_INDEX_] !== holderId) {
      /* 他者のチケットを誤って解放しない（3回目レビュー対応・項目1）。行番号の取り違えが
         万一起きても、この確認により他者の有効なロックを誤って失効させることはない。 */
      throw new Error('BookingLockRepository.release: 指定されたholderIdが行の保持者と一致しません（rowNumber=' + rowNumber + '）。');
    }
    if (row[RELEASED_AT_INDEX_]) return; /* 既に解放済み（release自体の重複呼び出しは冪等） */
    sheet.getRange(rowNumber, RELEASED_AT_INDEX_ + 1, 1, 1).setValue(effectiveNow);
  }

  /* acquireが返したrowNumber・holderIdの組に対応するチケットを解放する。呼び出し元が
     保持していた排他区間の処理が成功・失敗いずれで終わった場合もfinallyから呼ぶこと。 */
  function release(rowNumber, holderId, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var sheet = ensureSheet_();
    releaseRow_(sheet, rowNumber, holderId, effectiveNow);
  }

  return {
    DEFAULT_TTL_MS: DEFAULT_TTL_MS_,
    acquire: acquire,
    isHeld: isHeld,
    release: release
  };
})();
