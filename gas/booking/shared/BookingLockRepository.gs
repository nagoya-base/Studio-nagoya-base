/*
 * BookingLockRepository.gs — 予約単位の排他制御（Issue #341 PR-Cレビュー対応・2回目）。
 *
 * 【背景】レビュー対応・1回目でBooking Webhookプロジェクトを独立させた結果、Webhookによる
 * 予約確定（StripeWebhookHandler.processEvent → applyPaymentStateUpdate + confirmBooking）と、
 * Booking AdminプロジェクトのexpirePendingBookings（枠解放）は、もはや同じ
 * LockService.getScriptLock()を共有しない（GASのLockServiceはスクリプトプロジェクト単位）。
 * 1回目の対応では「各々が破壊的書き込み直前に最新状態を再読込する」「猶予時間を置く」
 * 「failed→paidの遷移を許可する」という多層防御で実害を最小化したが、2回目レビューの
 * 指摘どおり、これらは「一方が最新状態を読み終えた直後に他方が状態を変更する」という
 * 狭いレース自体を排除できない（両プロジェクトのLock内再読込が数百ミリ秒未満の間隔で
 * 重なった場合、Calendar側は削除、Sheets側は一方の書き込みが他方を上書きする、といった
 * 「両方が成功したと判断する」不整合が理論上起こり得た）。
 *
 * 【この仕組みが提供するもの】GASのLockServiceはスクリプトプロジェクトをまたいで共有
 * できないが、Booking Webhook・Booking Adminの両プロジェクトは同じSpreadsheet（Bookings
 * 台帳と同じSpreadsheetId）を共有している。この共有Spreadsheet自体を、プロジェクトを
 * またぐ排他制御の実体として使う。専用の「BookingLocks」シートへ、予約IDごとの
 * 「所有権主張（チケット）」を1行ずつappendRowで追加し、追加直後に全件を読み直して
 * 「自分より前に追加された、まだ有効な（release/期限切れでない）チケットが無いか」を
 * 確認する。無ければロック取得成功、あれば失敗（他方が既に処理中）とみなす。
 *
 * 【なぜこれで正しいと言えるか（重要な前提）】Google Sheetsは単一のドキュメントであり、
 * 複数のクライアント（人間のブラウザ編集・Sheets API・Apps Script、プロジェクトが違っても
 * 同じSpreadsheetへの操作はすべて）からの書き込みをバックエンド側で単一の直列順序へ
 * 整列させる（同時編集时でも最終的に矛盾のない1つの版数列に収束する、複数ユーザーの
 * 同時編集を安全に扱うGoogle Sheetsの基本動作と同じ仕組み）。この前提のもとでは、
 * 「appendRowで自分の行を追加した直後に全件を読み直す」という手順は、比較不能な2者が
 * 同時に「自分が最も早い」と誤認することを論理的に排除できる：2つの実行A・Bについて、
 * A_append→A_read（Aの手順内の順序）、B_append→B_read（Bの手順内の順序）という制約の
 * もとで、「A_readがB_appendを見ない」かつ「B_readがA_appendを見ない」が両立するには
 * B_append<A_append（1つ目の制約から）とA_append<B_append（2つ目の制約から）が同時に
 * 必要になり矛盾する。したがって少なくとも一方は相手の行を必ず見ることになり、
 * 両者が同時に「自分が最も早い（＝ロック取得成功）」と判定することはあり得ない。
 *
 * 【Stripeへの外部HTTP呼び出しとの関係】このロックはBookings/Calendarへの確定的な
 * 変更（Webhook側はapplyPaymentStateUpdate〜confirmBooking、Admin側はCalendar削除〜
 * status:EXPIRED書き込み）の直前でのみ取得し、Stripe API呼び出し（署名検証済みイベントの
 * 再照会・金額照合等、いずれもロック取得前に完了させる）の最中には保持しない。
 *
 * 【TTL（既定60秒）について】保持したまま実行がクラッシュ・タイムアウトした場合に
 * 永久に相手をブロックしないための保険。このロックが保護する区間はSheets/Calendarへの
 * 数回のAPI呼び出しのみ（外部HTTP呼び出しを含まない）で、実運用でも数秒以内に完了する
 * 想定のため、60秒は十分すぎる安全マージンを持たせた値である。**この猶予は
 * 「クラッシュからの回復用」であり、レビュー対応・1回目のCardPayment.
 * WEBHOOK_RACE_GRACE_MINUTES（10分）のように「これ自体が競合を防ぐ根拠」ではない**
 * （競合を実際に防ぐのは上記のappend-then-read-back方式そのもの）。
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
  var EXPIRES_AT_INDEX_ = HEADERS_.indexOf('expiresAt');
  var RELEASED_AT_INDEX_ = HEADERS_.indexOf('releasedAt');

  /*
   * bookingId単位のロックを取得する。holderIdは呼び出し元が試行のたびに新しく発行する
   * 一意な値であること（例: Utilities.getUuid()。同じ呼び出し元が同じbookingIdへ複数回
   * acquireする場合も毎回新しいholderIdを使う。チケットの追加順＝行番号だけを比較材料に
   * するため、holderId自体の値そのものに意味はなく一意性だけが必要）。
   *
   * 戻り値: { acquired: true, rowNumber } / { acquired: false }
   * acquired:trueの場合、呼び出し元は処理完了後に必ずrelease(rowNumber)を呼ぶこと
   * （try/finallyで保護する。呼ばなくてもexpiresAt経過後は他の呼び出しから見て自動的に
   * 失効扱いになるが、それまで相手を無駄にブロックし続ける）。
   */
  function acquire(bookingId, holderId, ownerTag, now, ttlMs) {
    if (!bookingId) throw new Error('bookingIdを指定してください。');
    if (!holderId) throw new Error('holderIdを指定してください。');
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var effectiveTtlMs = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : DEFAULT_TTL_MS_;
    var expiresAt = new Date(effectiveNow.getTime() + effectiveTtlMs);

    var sheet = ensureSheet_();
    sheet.appendRow([bookingId, holderId, ownerTag || '', effectiveNow, expiresAt, '']);
    var myRowNumber = sheet.getLastRow();

    var values = sheet.getDataRange().getValues();
    var earliestActiveRowNumber = null;
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (row[BOOKING_ID_INDEX_] !== bookingId) continue;
      if (row[RELEASED_AT_INDEX_]) continue; /* 既にrelease済み */
      var expiresAtMillis = toMillis_(row[EXPIRES_AT_INDEX_]);
      if (isNaN(expiresAtMillis) || expiresAtMillis <= effectiveNow.getTime()) continue; /* 期限切れ */
      var rowNumber = i + 1;
      if (earliestActiveRowNumber === null || rowNumber < earliestActiveRowNumber) {
        earliestActiveRowNumber = rowNumber;
      }
    }

    if (earliestActiveRowNumber === myRowNumber) {
      return { acquired: true, rowNumber: myRowNumber };
    }

    /* 取得できなかった: 自分のチケットは無用に相手をブロックしないよう直ちに解放する
       （best effort。失敗してもexpiresAt経過で自然に失効するため致命的ではない）。 */
    try {
      release(myRowNumber, effectiveNow);
    } catch (releaseError) {
      Logger.log('BookingLockRepository: 取得失敗チケットの解放に失敗しました: ' + bookingId + ' ' + releaseError);
    }
    return { acquired: false };
  }

  /* acquireが返したrowNumberに対応するチケットを解放する。呼び出し元が保持していた
     排他区間の処理が成功・失敗いずれで終わった場合もfinallyから呼ぶこと。 */
  function release(rowNumber, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var sheet = ensureSheet_();
    sheet.getRange(rowNumber, RELEASED_AT_INDEX_ + 1, 1, 1).setValue(effectiveNow);
  }

  return {
    DEFAULT_TTL_MS: DEFAULT_TTL_MS_,
    acquire: acquire,
    release: release
  };
})();
