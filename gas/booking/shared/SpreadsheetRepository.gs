/*
 * SpreadsheetRepository.gs — 予約台帳（Issue #268）のSpreadsheet読み書き。
 *
 * Script Propertiesの SPREADSHEET_ID で指定した専用Spreadsheet内に
 * 「Bookings」シートを作成・使用する（存在しなければ自動作成しヘッダー行を書く）。
 *
 * 列構成は固定（Issue #268 v1仕様 + 監査用カラム）。列を増やす場合はHEADERS_と
 * README.mdの両方を更新すること。
 */
'use strict';

var SpreadsheetRepository = (function () {
  var SHEET_NAME_ = 'Bookings';

  /*
   * 列を追加する場合は必ずこの配列の末尾へ追記すること（Issue #270のcustomerType追加時の方針）。
   * rowToRecord_は行の配列インデックスをこのHEADERS_の並び順で読むため、途中に挿入すると
   * 既存行（過去にappendBookingした実際のセルの並び）の列がずれて誤読される。末尾追記であれば、
   * 既存行はcustomerType列が空（undefined→rowToRecord_で''相当）になるだけで、他の列は
   * これまでどおり正しく読める。
   */
  var HEADERS_ = [
    'bookingId',
    'createdAt',
    'date',
    'startAt',
    'endAt',
    'brand',
    'name',
    'email',
    'phone',
    'people',
    'purpose',
    'paymentMethod',
    'status',
    'calendarEventId',
    'source',
    'note',
    'confirmedAt',
    'expiredAt',
    'cancelledAt',
    'updatedAt',
    'customerType',
    /*
     * ここから先はIssue #271（予約通知メール自動送信）で追加した列。
     * HEADERS_の並びどおり末尾へ追記する方針はcustomerType追加時（Issue #270）と同じ。
     */
    'pendingMailSentAt',
    'confirmedMailSentAt',
    'cancelMailSentAt',
    'reminderSentAt',
    'accessGuideSentAt',
    'lastMailErrorAt',
    'lastMailErrorType',
    'lastMailErrorMessage',
    'paymentStatus',
    /*
     * ここから先はIssue #334（カード決済の期限・失効通知・手動復活）で追加した列。
     * customerType/mail列追加時と同じく末尾追記の方針を踏襲する。
     */
    'expiredMailSentAt',
    /*
     * ここから先はIssue #334 PR-C（Booking AdminからのStripe決済リンク送信）で追加した列。
     * 同じく末尾追記の方針を踏襲する（本番反映時は既存Bookingsシートのヘッダー行へ
     * 手動で追記が必要。README.md「Spreadsheet構成」参照）。
     * - stripePaymentLinkUrl: 管理者が最後に入力・送信したStripe Payment Link URL。
     * - paymentLinkSentAt: 決済リンクメールの送信に成功した直近の日時。他のSentAt列と
     *   同じ方式で、空の場合だけ「通常送信」の対象になる（二重送信防止。明示的な再送は
     *   force指定でこの値の有無を無視する）。送信するたびに最新の送信時刻へ更新する。
     * - paymentLinkSentTo: 直近の送信に成功した宛先メールアドレス（送信時点の
     *   record.emailをそのまま記録。予約者のメールアドレスが後で変わっても送信時点の
     *   宛先を追跡できるようにするため）。
     * - paymentLinkSendCount: 決済リンクメールの送信成功回数（初回送信・明示的な再送の
     *   いずれも成功するたびに1加算する）。
     * - paymentLinkLastErrorAt / paymentLinkLastErrorMessage: 決済リンクメールの直近の
     *   送信失敗時刻・エラー内容（sanitizeErrorMessage_で redaction済み）。既存の
     *   lastMailError*（他のメール種別と共有）とは別の専用列とする。決済リンク送信は
     *   Booking Admin予約詳細で専用の送信状態（未送信/送信済み・送信回数・最終送信
     *   エラー）を表示する要件があり、他メール種別のエラーと混在させると誤表示になるため。
     *   次回の送信に成功すると自動的に空へ戻す（既存のlastMailError*と同じ方針）。
     * - paymentLinkSendUnconfirmedAt（PRレビュー対応で追加）: MailApp.sendEmailには
     *   成功したが、直後のpaymentLinkSentAt単独更新が失敗し、送信済みかどうかを
     *   確定できない場合の日時。空でない間は、他のSentAt列と同じ二重送信防止の
     *   仕組みにより通常送信（forceなし）を拒否する（BookingMailer.gsの
     *   evaluatePaymentLinkEligibility_のSEND_UNCONFIRMED判定）。次に送信履行が
     *   確定（paymentLinkSentAtの単独更新に成功）すると自動的に空へ戻す。
     * - paymentLinkMetadataInconsistentAt（第2回PRレビュー対応で追加）:
     *   paymentLinkSentAtの単独更新には成功した（＝送信履行は確定済み。二重送信の
     *   おそれはない）が、続くstripePaymentLinkUrl/paymentLinkSentTo/
     *   paymentLinkSendCount等の2回目の更新が失敗し、これらの記録内容が古い・不正確な
     *   状態のまま残っている可能性がある場合の日時。**空でない間は通常送信・明示的な
     *   再送のいずれも送信可否の判定でforceでも拒否される**（第3回PRレビュー対応。
     *   BookingMailer.gsのevaluatePaymentLinkEligibility_のMETADATA_INCONSISTENT判定。
     *   送信履行そのものの二重送信防止はpaymentLinkSentAt/paymentLinkSendUnconfirmedAtで
     *   別途確定済みだが、送信回数等の記録が信頼できるまでは追加の送信自体を止める）。
     *   **他の送信が成功しただけでは自動的にクリアされない**（第3回PRレビュー対応。
     *   以前は次の送信成功時に自動的に空へ戻していたが、これだと送信回数の食い違いを
     *   解消せずに隠してしまうため廃止した）。クリアできるのは、管理者が実際の送信履歴と
     *   照合したstripePaymentLinkUrl・paymentLinkSentTo・paymentLinkSendCountの3項目を
     *   確認したうえで呼び出す専用の補正関数
     *   BookingMailer.resolvePaymentLinkMetadataInconsistencyのみ（第5回PRレビュー対応で
     *   補正対象をpaymentLinkSendCountのみから3項目へ拡張した。URL・送信先が古いまま
     *   このフラグだけが解除されることを防ぐため）。この関数は3項目の補正とこの列の
     *   クリアを**それぞれ別のupdateBookingFields呼び出しで順に行い、都度最新レコードを
     *   再取得して実際に反映されたかを検証する**（第4回PRレビュー対応。1回の呼び出しに
     *   複数フィールドを渡すと内部でループして順に書き込むため、途中の書き込みだけが
     *   失敗すると補正が反映されていないのにこのフラグだけが先にクリアされてしまう
     *   恐れがある。検証に失敗した場合はこのフラグを維持し、Recoveryへ
     *   `PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`として記録する）。このクリア操作後の
     *   最終確認の再取得自体が失敗した場合（第5回PRレビュー対応）は、クリア操作自体が
     *   実際には成功していた可能性があり、このフラグが今どちらの状態かを断定できない
     *   ため、「維持されている」と断定せず確認不能として案内する
     *   （`RESOLVE_RESULT_UNKNOWN`。この場合も`PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`を
     *   Recoveryへ記録する）。
     */
    'stripePaymentLinkUrl',
    'paymentLinkSentAt',
    'paymentLinkSentTo',
    'paymentLinkSendCount',
    'paymentLinkLastErrorAt',
    'paymentLinkLastErrorMessage',
    'paymentLinkSendUnconfirmedAt',
    'paymentLinkMetadataInconsistentAt'
  ];

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  /* シートが存在しない、またはヘッダー行が未設定の場合はヘッダー行を書く（冪等）。 */
  function ensureBookingsSheet_() {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_NAME_);
    }
    if (sheet.getLastRow() < 1) {
      sheet.appendRow(HEADERS_);
    }
    return sheet;
  }

  function rowToRecord_(row) {
    var record = {};
    HEADERS_.forEach(function (header, index) {
      record[header] = row[index];
    });
    return record;
  }

  function recordToRow_(record) {
    return HEADERS_.map(function (header) {
      return record[header] !== undefined && record[header] !== null ? record[header] : '';
    });
  }

  /* record: HEADERS_のキーを持つオブジェクト（未指定のフィールドは空文字で埋める）。 */
  function appendBooking(record) {
    var sheet = ensureBookingsSheet_();
    sheet.appendRow(recordToRow_(record));
  }

  /* 戻り値: { rowNumber, record } または見つからない場合はnull。
     rowNumberは1始まり・ヘッダー行込みのSpreadsheet実際の行番号（getRange等にそのまま使える）。 */
  function findRowByBookingId(bookingId) {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === bookingId) {
        return { rowNumber: i + 1, record: rowToRecord_(values[i]) };
      }
    }
    return null;
  }

  /* 全行をstatus問わず返す（Issue #305 Booking Admin Web UIの一覧表示用）。
     個人管理用途で件数が小規模な前提のため、getAllPendingBookings等と同じ
     「全行取得してから絞り込む」方針をそのまま踏襲する（専用の検索APIは作らない）。 */
  function getAllBookings() {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      result.push({ rowNumber: i + 1, record: rowToRecord_(values[i]) });
    }
    return result;
  }

  /* status===PENDINGの全行を返す（expirePendingBookings用）。件数が多くなる想定は
     Phase 1ではないため、全行取得→フィルタというシンプルな実装にしている。 */
  function getAllPendingBookings() {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.status === 'PENDING') {
        result.push({ rowNumber: i + 1, record: record });
      }
    }
    return result;
  }

  /* status===CONFIRMEDかつdate===dateStringの全行を返す（前日リマインド抽出用。Issue #271）。
     reminderSentAt等の判定はBookingMailer側の責務とし、ここではstatus/dateのみで絞り込む。 */
  function getConfirmedBookingsForDate(dateString) {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.status === 'CONFIRMED' && record.date === dateString) {
        result.push({ rowNumber: i + 1, record: record });
      }
    }
    return result;
  }

  /*
   * fields: { [HEADERS_のいずれか]: value } の部分更新。statusセルの直接編集を
   * 正式運用にしないため、statusを含む更新は必ずこの関数（＝confirmBooking /
   * expirePendingBookings）経由でのみ行う。
   * bookingIdが見つからない場合は例外を投げる。
   */
  function updateBookingFields(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }
    var sheet = ensureBookingsSheet_();
    Object.keys(fields).forEach(function (key) {
      var columnIndex = HEADERS_.indexOf(key);
      if (columnIndex === -1) {
        throw new Error('未知のbookingフィールドです: ' + key);
      }
      sheet.getRange(found.rowNumber, columnIndex + 1, 1, 1).setValues([[fields[key]]]);
    });
    return found.rowNumber;
  }

  /* cancelBookingAdminのatomic更新で触ってよいフィールドのみを列挙する（下記参照）。 */
  var CANCELLATION_ATOMIC_FIELDS_ = ['status', 'cancelledAt', 'updatedAt'];

  /*
   * cancelBookingAdmin専用のatomic更新（Issue #272 PRレビュー2回目対応）。
   * status/cancelledAt/updatedAtの3項目**だけ**を、HEADERS_上で連続する
   * 'status'（13列目）〜'updatedAt'（20列目）の列範囲に対する1回のsetValuesで更新する
   * （途中のcalendarEventId/source/note/confirmedAt/expiredAtは呼び出し元が指定しない限り
   * 既存値のまま書き戻す。'status'〜'updatedAt'が連続列であるためこの範囲書き込みが成立する）。
   *
   * 初回対応（レビュー1回目）ではBookings行の全29列を丸ごと`setValues`する
   * `updateBookingFieldsAtomic`を用意したが、これは以下の競合を生む恐れがあると
   * 2回目レビューで指摘された:
   * - Booking Web App（createBooking等）とBooking Admin（confirmBooking/
   *   expirePendingBookings/cancelBookingAdmin）は別々のGASプロジェクトであり、
   *   LockService.getScriptLock()を共有しない
   * - Web App側がpendingMailSentAt等（22列目以降）を更新した直後に、Admin側が
   *   古い行全体を書き戻すと、Web App側の更新を空値で巻き戻してしまう
   * - #271はメール列のSentAtを二重送信防止の冪等性の基準にしているため、これは
   *   実運用で二重送信事故につながり得る
   *
   * そのためこの関数は21列目以降（customerType・mail SentAt・lastMailError*）は
   * 一切読み書きしない（そもそも書き込み範囲に含めない）。confirmBooking/
   * expirePendingBookings/cancelBookingAdminは同一Booking AdminプロジェクトのLockで
   * 直列化されるため、13〜20列の範囲内で複数呼び出しが競合することもない。
   *
   * status/cancelledAt/updatedAt以外のキーが渡された場合は例外を投げる（mail列等への
   * 誤用を防ぐfail-closed）。bookingIdが見つからない場合も例外を投げる。
   */
  function updateBookingCancellationStateAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }

    Object.keys(fields).forEach(function (key) {
      if (CANCELLATION_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('キャンセルatomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('status');
    var endIndex = HEADERS_.indexOf('updatedAt');
    var values = [];
    for (var i = startIndex; i <= endIndex; i++) {
      var header = HEADERS_[i];
      var hasOverride = Object.prototype.hasOwnProperty.call(fields, header);
      var value = hasOverride ? fields[header] : found.record[header];
      values.push(value !== undefined && value !== null ? value : '');
    }

    var sheet = ensureBookingsSheet_();
    sheet.getRange(found.rowNumber, startIndex + 1, 1, endIndex - startIndex + 1).setValues([values]);
    return found.rowNumber;
  }

  return {
    HEADERS: HEADERS_,
    appendBooking: appendBooking,
    findRowByBookingId: findRowByBookingId,
    getAllBookings: getAllBookings,
    getAllPendingBookings: getAllPendingBookings,
    getConfirmedBookingsForDate: getConfirmedBookingsForDate,
    updateBookingFields: updateBookingFields,
    updateBookingCancellationStateAtomic: updateBookingCancellationStateAtomic
  };
})();
