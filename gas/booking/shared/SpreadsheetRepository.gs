/*
 * SpreadsheetRepository.gs — 予約台帳（Issue #268）のSpreadsheet読み書き。
 *
 * Script Propertiesの SPREADSHEET_ID で指定した専用Spreadsheet内に
 * 「Bookings」シートを作成・使用する（存在しなければ自動作成しヘッダー行を書く）。
 *
 * 列構成は固定（Issue #268 v1仕様 + 監査用カラム）。列を増やす場合はBookingsSchema.gsの
 * HEADERS_とREADME.mdの両方を更新すること。
 */
'use strict';

var SpreadsheetRepository = (function () {
  var SHEET_NAME_ = BookingsSchema.SHEET_NAME;
  /* ヘッダー定義の正本はBookingsSchema.gs（Issue #671）。列追加はそちらの末尾へ。 */
  var HEADERS_ = BookingsSchema.HEADERS;

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

  /*
   * record.dateをtimezone基準の'YYYY-MM-DD'へ正規化してから比較できるようにする
   * （Issue #349）。Sheetsの`getValues()`は日付らしい文字列をセルへ書き込むと読み込み時に
   * Date値として返すことがあり（BookingMailer.gsのnormalizeReminderDate_と同じ既知の
   * 注意点）、record.dateがDate値の場合に文字列のdateStringとの`===`比較が型の違いだけで
   * 常にfalseになり、CONFIRMED予約が0件と誤検知される事故（前日リマインド未送信）を防ぐ。
   * 無効なDate・空欄はどちらの分岐でも元の値のままdateStringと一致しないため対象外になる。
   * record自体（戻り値・Sheetのセル）は書き換えない（比較用の一時変数としてのみ使う）。
   */
  function normalizeBookingDateForComparison_(value, timezone) {
    if (value && typeof value.getTime === 'function' && !isNaN(value.getTime())) {
      return BookingAvailability.formatDateInTimezone(value, timezone) || '';
    }
    return value || '';
  }

  /* status===CONFIRMEDかつdate===dateStringの全行を返す（前日リマインド抽出用。Issue #271）。
     reminderSentAt等の判定はBookingMailer側の責務とし、ここではstatus/dateのみで絞り込む。
     dateの比較はnormalizeBookingDateForComparison_で正規化してから行う（Issue #349）。 */
  function getConfirmedBookingsForDate(dateString) {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var result = [];
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (
        record.status === 'CONFIRMED' &&
        normalizeBookingDateForComparison_(record.date, timezone) === dateString
      ) {
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

  /* Issue #344: 日時3列だけを1回のsetValuesで更新する。メール・決済・status列は触れない。 */
  function updateBookingScheduleAtomic(bookingId, date, startAt, endAt) {
    var found = findRowByBookingId(bookingId);
    if (!found) throw new Error('bookingIdが見つかりません: ' + bookingId);
    if (!startAt || !endAt || typeof startAt.getTime !== 'function' ||
        typeof endAt.getTime !== 'function' || startAt.getTime() >= endAt.getTime()) {
      throw new Error('予約日時が不正です。');
    }
    var sheet = ensureBookingsSheet_();
    sheet.getRange(found.rowNumber, HEADERS_.indexOf('date') + 1, 1, 3)
      .setValues([[date, startAt, endAt]]);
    return found.rowNumber;
  }

  /*
   * BookingReschedule.commit/recordFeeSettlement専用のatomic更新（Issue #344追記
   * PR #345レビュー対応）。HEADERS_上で連続する'priceOverrideAmount'〜'feeRecoveryReason'
   * の列範囲（priceUpdateMailSentAt/priceOverrideAt含む）に対する1回のsetValuesで、
   * 日程変更に伴う「現在の確定金額（priceOverrideAmount/priceOverrideAt）・変更回数・
   * 精算状態・要復旧フラグ」をまとめて更新する。updateBookingCancellationStateAtomicと
   * 同じ設計（呼び出し元が指定しないキーは既存値のまま書き戻す。範囲外の列は一切触らない）。
   * この関数が「1回のRange.setValues呼び出し」であること自体が、日時更新後に料金側の
   * 一部フィールドだけが更新される中途半端な状態（変更回数だけ旧値のまま残る等）を
   * 構造的に防ぐ（PR #345レビュー対応「Bookingsの日時・確定料金・料金版・変更回数・
   * 精算状態を一貫して更新」）。書き込み自体が失敗した場合は、呼び出し元
   * （BookingReschedule.gs）がfeeRecoveryRequiredAtを立てて以降の操作をブロックする。
   */
  var RESCHEDULE_FEE_ATOMIC_FIELDS_ = [
    'priceOverrideAmount', 'priceOverrideAt', 'priceUpdateMailSentAt',
    'scheduleChangeCount', 'feePaidAmount', 'feeRefundedAmount',
    'feeSettlementState', 'feeSettlementNote', 'feeSettlementUpdatedAt',
    'feeRecoveryRequiredAt', 'feeRecoveryReason'
  ];

  function updateBookingRescheduleFeeAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }
    Object.keys(fields).forEach(function (key) {
      if (RESCHEDULE_FEE_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('日程変更の料金atomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('priceOverrideAmount');
    var endIndex = HEADERS_.indexOf('feeRecoveryReason');
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

  /*
   * BookingReschedule.backfillOriginalPrice専用のatomic更新（PR #345再レビュー対応・
   * 7回目）。HEADERS_上で連続する'priceAmount'〜'priceComputedAt'の5列（基準料金：
   * 自動計算値・価格区分・曜日区分・会員区分・計算日時）に対する1回のsetValuesで
   * まとめて更新する。updateBookingRescheduleFeeAtomicと同じ設計（呼び出し元が
   * 指定しないキーは既存値のまま書き戻す。範囲外の列——priceOverrideAmount等の
   * 日程変更専用フィールドや精算累計額——には一切触れない）。この関数が「1回の
   * Range.setValues呼び出し」であることが、途中失敗による「価格区分だけ新しいが
   * 金額は古いまま」のような半端な基準料金状態を構造的に防ぐ。
   */
  var PRICE_BASELINE_ATOMIC_FIELDS_ = ['priceAmount', 'priceTier', 'priceDayType', 'priceIsMember', 'priceComputedAt'];

  function updateBookingPriceBaselineAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }
    Object.keys(fields).forEach(function (key) {
      if (PRICE_BASELINE_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('基準料金のatomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('priceAmount');
    var endIndex = HEADERS_.indexOf('priceComputedAt');
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

  var PAYMENT_STATE_ATOMIC_FIELDS_ = [
    'paymentAttemptId', 'paymentAttemptResolvedAt', 'stripeCheckoutSessionId', 'stripePaymentIntentId',
    'paymentHoldExpiresAt', 'stripeAmount', 'stripeCurrency', 'stripeCheckoutRequestSnapshot',
    'paymentConfirmedAt',
    'lastStripeEventId', 'stripeRefundId', 'refundRequestedAt', 'refundedAt',
    'paymentLastErrorAt', 'paymentLastErrorMessage', 'paymentRecoveryRequiredAt',
    'paymentRecoveryReason'
  ];

  /*
   * Issue #341 PR-A: Stripe決済状態の付随情報のatomic更新（updateBookingCancellationStateAtomic/
   * updateBookingRescheduleFeeAtomicと同じパターン）。HEADERS_上で実際に連続する
   * 'paymentAttemptId'〜'paymentRecoveryReason'（末尾17列。PR #354レビュー対応・2回目で
   * 'stripeCheckoutRequestSnapshot'、3回目で'paymentAttemptResolvedAt'を追加）の範囲に対する
   * 1回のsetValuesでまとめて更新する。
   *
   * 既存の'paymentStatus'（30列目。Issue #271由来の既存列を転用）はこの17列と
   * HEADERS_上で連続していない（間にexpiredMailSentAt〜feeRecoveryReasonという無関係な
   * 既存25列が挟まる）ため、意図的にこの関数の対象に含めない。同じRange.setValuesへ
   * 含めてしまうと、その25列を他プロセス（決済リンク送信・料金修正・日程変更等）が
   * 並行更新した直後にこの関数がfound.record（呼び出し開始時点のスナップショット）の
   * 古い値で丸ごと書き戻し、その更新を消してしまう恐れがある（updateBookingCancellation
   * StateAtomicが「21列目以降には触れない」設計にした理由と同種の事故。このファイルの
   * 同関数のコメント参照）。'paymentStatus'自体の更新は呼び出し側が別途
   * updateBookingFields(bookingId, {paymentStatus: ...})で単独更新する（2回の書き込みに
   * 分かれるため呼び出し間で一瞬だけ不整合な組み合わせが観測され得るが、無関係な25列を
   * 巻き込むより安全という判断。将来的に両者の完全な同時更新が必要になれば、台帳側の
   * 列順を見直すか専用の復旧フラグで補う）。
   *
   * 実際にこの関数を呼び出して決済状態一式を遷移させる処理（Checkout Session発行・
   * Webhook確認・自動返金）はPR-B/PR-C/PR-Dで実装する。本PR-Aでは関数の提供と
   * モックテストによる書き込み範囲の検証のみを行う。
   *
   * PAYMENT_STATE_ATOMIC_FIELDS_以外のキーが渡された場合は例外を投げる（mail列・
   * 予約日時列等への誤用を防ぐfail-closed）。bookingIdが見つからない場合も例外を投げる。
   */
  function updateBookingPaymentStateAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }

    Object.keys(fields).forEach(function (key) {
      if (PAYMENT_STATE_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('決済状態atomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('paymentAttemptId');
    var endIndex = HEADERS_.indexOf('paymentRecoveryReason');
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

  var REFUND_STATE_ATOMIC_FIELDS_ = [
    'refundAttemptId', 'refundAttemptState', 'refundDecision', 'refundAmount',
    'refundReason', 'refundDecidedAt', 'refundStripeStatus', 'refundCheckedAt'
  ];

  /*
   * Issue #341 PR-D: 返金試行の状態のatomic更新（updateBookingPaymentStateAtomicと同じ
   * パターン）。HEADERS_上で連続する'refundAttemptId'〜'refundCheckedAt'の8列だけを
   * 1回のsetValuesで更新し、呼び出し元が指定しないキーは既存値のまま書き戻す。
   * 範囲外の列（paymentStatus・決済付随情報・メールSentAt等）には一切触れない。
   */
  function updateBookingRefundStateAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }
    Object.keys(fields).forEach(function (key) {
      if (REFUND_STATE_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('返金状態atomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('refundAttemptId');
    var endIndex = HEADERS_.indexOf('refundCheckedAt');
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
    updateBookingRefundStateAtomic: updateBookingRefundStateAtomic,
    findRowByBookingId: findRowByBookingId,
    getAllBookings: getAllBookings,
    getAllPendingBookings: getAllPendingBookings,
    getConfirmedBookingsForDate: getConfirmedBookingsForDate,
    updateBookingFields: updateBookingFields,
    updateBookingScheduleAtomic: updateBookingScheduleAtomic,
    updateBookingRescheduleFeeAtomic: updateBookingRescheduleFeeAtomic,
    updateBookingPriceBaselineAtomic: updateBookingPriceBaselineAtomic,
    updateBookingCancellationStateAtomic: updateBookingCancellationStateAtomic,
    updateBookingPaymentStateAtomic: updateBookingPaymentStateAtomic
  };
})();
