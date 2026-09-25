/* Issue #344: Booking Admin専用。公開Booking Web Appへ配置しない。
 *
 * Issue #344追記（料金差額の自動計算。PR #345レビュー対応で再設計）:
 * - 料金の正本はBookingPricing.gs（Issue #342/#343）・祝日判定の正本はJapaneseHolidays.gs
 *   （Issue #346/#347）に一本化した。「現在の確定金額・価格区分」は独自の列を持たず、
 *   Booking.getEffectivePriceAmount/record.priceTier（PR #343の料金基盤）をそのまま
 *   再利用する。既存予約は金額が未記録のため、日程変更を確定する前に必ず
 *   backfillOriginalPrice()で「元の確定料金・価格区分」を管理者が照合・入力しておく必要が
 *   ある（未確認のままではcommit()自体が失敗する）。
 * - 料金差額の扱い（FeeCalculator.assessScheduleChangeFee参照）: 新料金が高い場合は単純な
 *   追加請求。新料金が安く、かつ「今回が初めての日程変更」かつ「変更前利用日の前日まで」の
 *   場合のみ、キャンセル料なしの返金候補を自動算出する。それ以外の減額（2回目以降・当日）と
 *   30分刻みの端数（2.5h/3.5h等。未承認の補間ルール）は、規約上・料金表上どちらとも
 *   決められないため自動では一切金額を作らず、管理者が金額と理由を明示的に入力しない限り
 *   確定できない。
 * - 日時更新後の料金関連フィールド（現在の確定金額・変更回数・精算状態）は
 *   updateBookingRescheduleFeeAtomicで1回のRange.setValuesとして更新する。この書き込みが
 *   失敗した場合はfeeRecoveryRequiredAtを立てて以降のcommit/recordFeeSettlementを
 *   ブロックし、「成功扱いで握りつぶす」ことを構造的に防ぐ（PR #345レビュー対応）。
 * - 資金移動（実際の入出金）は料金確定とは別。recordFeeSettlementは、Lock・精算ID
 *   （settlementId）・FeeSettlementRepository.gsの精算履歴により、同一精算IDの再送・
 *   二重クリック・通信エラー後の再実行で入金額・返金額を二重加算しない（PR #345レビュー
 *   対応）。
 */
'use strict';

var BookingReschedule = (function () {
  var HISTORY_SHEET_ = 'BookingChanges';
  var HISTORY_HEADERS_ = [
    'changeId', 'bookingId', 'changedAt', 'oldDate', 'oldStartAt', 'oldEndAt',
    'newDate', 'newStartAt', 'newEndAt', 'reason', 'feeNote', 'mailState', 'mailAt', 'mailError',
    'oldFeeAmount', 'newFeeAmount', 'feeDifference', 'cancellationPolicyCategory',
    'refundStatus', 'refundCandidateAmount', 'refundApprovedAmount', 'refundApprovedAt',
    'refundPendingReason', 'settlementStateAtChange', 'feeDetailsJson'
  ];
  var VALID_PRICE_TIERS_ = ['GENERAL', 'MEMBER'];
  var VALID_SETTLEMENT_STATES_ = ['SETTLED', 'PENDING_CHARGE', 'PENDING_REFUND', 'PENDING_DECISION'];

  function error_(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  function isDate_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function isFiniteNumber_(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function history_() {
    var book = SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
    var sheet = book.getSheetByName(HISTORY_SHEET_) || book.insertSheet(HISTORY_SHEET_);
    if (!sheet.getLastRow()) sheet.appendRow(HISTORY_HEADERS_);
    var current = sheet.getRange(1, 1, 1, HISTORY_HEADERS_.length).getValues()[0];
    if (HISTORY_HEADERS_.some(function (key, i) { return key !== current[i]; })) {
      throw new Error('BookingChangesのヘッダーが想定と異なります。');
    }
    return sheet;
  }

  function logFailure_(bookingId, type, status) {
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId, failureType: type, occurredAt: new Date(),
        status: status, errorMessage: 'BookingChangesと予約台帳・Calendarの整合性を管理者が確認してください。',
        recoveryState: 'OPEN', resolvedAt: ''
      });
    } catch (e) {
      Logger.log('BookingReschedule: Recovery記録失敗');
    }
  }

  function dateStringOf_(value, timezone) {
    if (isDate_(value)) return BookingAvailability.formatDateInTimezone(value, timezone);
    return value;
  }

  function parse_(bookingId, input, expectedVersion, now) {
    if (typeof bookingId !== 'string' || !bookingId.trim()) return error_('INVALID_ID', '予約IDが必要です。');
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
    var record = found.record;
    if (record.status !== Booking.STATUS.CONFIRMED) {
      return error_('INVALID_STATUS', '日時変更は確定済みの予約のみ対応します。');
    }
    if (!isDate_(record.startAt) || !isDate_(record.endAt)) return error_('INVALID_RECORD', '元の予約日時を確認できません。');
    var version = record.startAt.getTime() + ':' + record.endAt.getTime();
    if (expectedVersion !== undefined && expectedVersion !== version) {
      return error_('STALE_BOOKING', '別の画面で予約が変更されています。詳細を再読み込みしてください。');
    }
    var config = BookingConfig.getAvailabilityConfig();
    input = input || {};
    var date = input.date;
    var startTime = input.startTime;
    var endTime = input.endTime;
    if (!BookingAvailability.isValidTimeString(startTime) || !BookingAvailability.isValidTimeString(endTime)) {
      return error_('INVALID_TIME', '開始・終了はHH:mm形式で指定してください。');
    }
    var startMinutes = BookingAvailability.parseTimeToMinutes(startTime);
    var endMinutes = BookingAvailability.parseTimeToMinutes(endTime);
    var duration = endMinutes - startMinutes;
    var validation = BookingAvailability.validateInput(date, duration, config);
    if (validation) return { success: false, error: validation };
    if (startMinutes < BookingAvailability.parseTimeToMinutes(config.openTime) ||
        endMinutes > BookingAvailability.parseTimeToMinutes(config.closeTime) ||
        (startMinutes - BookingAvailability.parseTimeToMinutes(config.openTime)) % config.slotStepMinutes !== 0) {
      return error_('OUTSIDE_HOURS', '営業時間外、または開始時刻が予約刻みに合っていません。');
    }
    var startAt = CalendarRepository.parseDateTime(date, startTime, config.timezone);
    var endAt = CalendarRepository.parseDateTime(date, endTime, config.timezone);
    if (!isDate_(startAt) || !isDate_(endAt) || endAt.getTime() - startAt.getTime() !== duration * 60000) {
      return error_('INVALID_DATE', '日時を解釈できません。');
    }
    if (startAt.getTime() <= now.getTime()) return error_('PAST_START', '現在時刻以前へは変更できません。');
    if (startAt.getTime() === record.startAt.getTime() && endAt.getTime() === record.endAt.getTime()) {
      return error_('UNCHANGED', '変更前と同じ日時です。');
    }
    var calendarId = BookingConfig.getCalendarId();
    var own = CalendarRepository.getEventById(calendarId, record.calendarEventId);
    if (!own || own.getTag('bookingId') !== bookingId || own.getTag('status') !== record.status ||
        own.getStartTime().getTime() !== record.startAt.getTime() ||
        own.getEndTime().getTime() !== record.endAt.getTime()) {
      return error_('EVENT_MISMATCH', '台帳とCalendarが一致しません。Recoveryで確認してください。');
    }
    var from = new Date(startAt.getTime() - config.bufferMinutes * 60000);
    var to = new Date(endAt.getTime() + config.bufferMinutes * 60000);
    var calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) return error_('CALENDAR_NOT_FOUND', 'Calendarが見つかりません。');
    var conflicts = calendar.getEvents(from, to).some(function (event) {
      if (event.getId() === own.getId() || event.isAllDayEvent()) return false;
      return event.getStartTime().getTime() < to.getTime() && event.getEndTime().getTime() > from.getTime();
    });
    if (conflicts) return error_('SLOT_CONFLICT', '変更先の時間帯は空いていません。');
    return {
      success: true, found: found, record: record, own: own, date: date,
      startAt: startAt, endAt: endAt, version: version,
      timezone: config.timezone, durationMinutes: duration
    };
  }

  /* Issue #344追記: 「現在の確定金額・価格区分」はPR #343の料金基盤
     （Booking.getEffectivePriceAmount/record.priceTier）をそのまま読む。 */
  function feeBaseline_(record) {
    return {
      oldAmount: Booking.getEffectivePriceAmount(record),
      priceTier: record.priceTier || '',
      scheduleChangeCount: isFiniteNumber_(record.scheduleChangeCount) ? Number(record.scheduleChangeCount) : 0,
      feePaidAmount: isFiniteNumber_(record.feePaidAmount) ? Number(record.feePaidAmount) : 0,
      feeRefundedAmount: isFiniteNumber_(record.feeRefundedAmount) ? Number(record.feeRefundedAmount) : 0,
      feeSettlementState: record.feeSettlementState || ''
    };
  }

  function isInFeeRecovery_(record) {
    return isDate_(record.feeRecoveryRequiredAt);
  }

  /*
   * Issue #344追記: 新しい日時の料金見積り・差額判定をまとめて行う。
   * baseline未確認・料金算出不可の場合はready:falseで返し、金額は一切作らない
   * （呼び出し側=commit()が、その状態のまま確定させるかどうかを判断する）。
   */
  function computeFeeContext_(record, newDurationMinutes, newDateString, todayDateString, timezone) {
    var baseline = feeBaseline_(record);
    if (baseline.oldAmount === null || !baseline.priceTier) {
      return { ready: false, status: 'BASELINE_REQUIRED', baseline: baseline };
    }
    var quote = FeeCalculator.quoteFee({
      brand: record.brand, priceTier: baseline.priceTier,
      durationMinutes: newDurationMinutes, dateString: newDateString
    });
    if (!quote.supported) {
      return { ready: false, status: quote.reason, message: quote.message, baseline: baseline, quote: quote };
    }
    var oldDateString = dateStringOf_(record.startAt, timezone);
    var cancellationCategory = FeeCalculator.classifyCancellationPolicy(oldDateString, todayDateString);
    var unrefunded = Math.max(0, baseline.feePaidAmount - baseline.feeRefundedAmount);
    var assessment = FeeCalculator.assessScheduleChangeFee({
      oldAmount: baseline.oldAmount, newAmount: quote.amount, unrefundedPaidAmount: unrefunded,
      scheduleChangeCount: baseline.scheduleChangeCount, cancellationPolicyCategory: cancellationCategory
    });
    return {
      ready: true, status: 'READY', baseline: baseline, quote: quote,
      cancellationCategory: cancellationCategory, unrefunded: unrefunded, assessment: assessment
    };
  }

  function feeStatusMessage_(status, fallbackMessage) {
    if (status === 'BASELINE_REQUIRED') return '元の確定料金が未確認です。先に基準料金を設定してください。';
    if (fallbackMessage) return fallbackMessage;
    return '新しい日時の料金を自動算出できません。管理者が確認してください。';
  }

  /*
   * Issue #344追記: 元の確定料金・価格区分（会員/通常）を管理者が照合して入力する
   * （既存予約は金額が未記録のため必須）。何度でも呼び直して補正できる。日程変更そのものは
   * 行わない。PR #343の料金基盤（priceAmount/priceTier/priceDayType/priceIsMember/
   * priceComputedAt）をそのまま書き込む（日程変更専用の列は持たない）。
   */
  function backfillOriginalPrice(bookingId, priceTier, amount, note) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
    var record = found.record;
    if (record.status !== Booking.STATUS.CONFIRMED) {
      return error_('INVALID_STATUS', '確定済みの予約のみ基準料金を設定できます。');
    }
    if (isInFeeRecovery_(record)) {
      return error_('FEE_RECOVERY_REQUIRED', 'この予約は料金の整合性確認が必要な状態です。resolveFeeRecoveryで解消してから操作してください。');
    }
    if (VALID_PRICE_TIERS_.indexOf(priceTier) === -1) {
      return error_('INVALID_PRICE_TIER', '価格区分はGENERAL/MEMBERのいずれかで指定してください。');
    }
    if (!isFiniteNumber_(amount) || amount <= 0 || Math.floor(amount) !== amount) {
      return error_('INVALID_AMOUNT', '確定料金は1円以上の整数で指定してください。');
    }
    if (typeof note !== 'string' || !note.trim()) {
      return error_('BASIS_REQUIRED', '価格区分・金額の確認根拠を入力してください。');
    }
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var dateString = dateStringOf_(record.date, timezone);
    var dayTypeResult = FeeCalculator.resolveDayType(dateString);
    if (!dayTypeResult.ok) {
      return error_(dayTypeResult.error.code, dayTypeResult.error.message);
    }
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        priceAmount: amount, priceTier: priceTier, priceDayType: dayTypeResult.dayType,
        priceIsMember: priceTier === 'MEMBER', priceComputedAt: new Date()
      });
    } catch (e) {
      return error_('UPDATE_FAILED', '基準料金の保存に失敗しました。');
    }
    return { success: true, bookingId: bookingId, priceTier: priceTier, amount: amount };
  }

  function preview(bookingId, input, expectedVersion) {
    try {
      var check = parse_(bookingId, input, expectedVersion, new Date());
      if (!check.success) return check;
      if (isInFeeRecovery_(check.record)) {
        return error_('FEE_RECOVERY_REQUIRED', 'この予約は料金の整合性確認が必要な状態です。resolveFeeRecoveryで解消してから操作してください。');
      }
      var today = BookingAvailability.formatDateInTimezone(new Date(), check.timezone);
      var feeCtx = computeFeeContext_(check.record, check.durationMinutes, check.date, today, check.timezone);
      var result = {
        success: true, bookingId: bookingId, expectedVersion: check.version,
        oldDate: BookingAvailability.formatDateInTimezone(check.record.startAt, check.timezone),
        oldStartTime: BookingAvailability.formatTimeInTimezone(check.record.startAt, check.timezone),
        oldEndTime: BookingAvailability.formatTimeInTimezone(check.record.endAt, check.timezone),
        newDate: check.date, newStartTime: input.startTime, newEndTime: input.endTime,
        durationMinutes: check.durationMinutes,
        feeReady: feeCtx.ready,
        feeStatus: feeCtx.status,
        feeStatusMessage: feeCtx.ready ? '' : feeStatusMessage_(feeCtx.status, feeCtx.message),
        priceTier: feeCtx.baseline.priceTier,
        oldFeeAmount: feeCtx.baseline.oldAmount,
        feeSettlementState: feeCtx.baseline.feeSettlementState,
        scheduleChangeCount: feeCtx.baseline.scheduleChangeCount
      };
      if (feeCtx.ready) {
        result.newFeeAmount = feeCtx.quote.amount;
        result.dayType = feeCtx.quote.dayType;
        result.roundedMinutes = feeCtx.quote.roundedMinutes;
        result.feeDifference = feeCtx.assessment.feeDifference;
        result.refundStatus = feeCtx.assessment.refundStatus;
        result.refundCandidateAmount = feeCtx.assessment.refundCandidateAmount;
        result.refundPendingReason = feeCtx.assessment.pendingReason;
        result.cancellationPolicyCategory = feeCtx.cancellationCategory;
        result.unrefundedPaidAmount = feeCtx.unrefunded;
        result.requiresManualRefundDecision = feeCtx.assessment.refundStatus === 'PENDING_POLICY_DECISION';
      } else {
        result.requiresManualNewFee = feeCtx.status !== 'BASELINE_REQUIRED';
      }
      return result;
    } catch (e) {
      return error_('PREVIEW_FAILED', '空き状況の確認に失敗しました。');
    }
  }

  /* Issue #344追記: feeConfirmationで渡された手動決定を検証し、確定に使う最終的な
     料金・返金情報を組み立てる。自動算出できない/未確定のケースを確定前にブロックする。 */
  function resolveFeeForCommit_(feeCtx, feeConfirmation) {
    feeConfirmation = feeConfirmation || {};
    if (!feeCtx.ready) {
      if (feeCtx.status === 'BASELINE_REQUIRED') {
        return { blocked: error_('FEE_BASELINE_REQUIRED', feeStatusMessage_('BASELINE_REQUIRED')) };
      }
      var manualAmount = feeConfirmation.manualNewFeeAmount;
      var manualNote = feeConfirmation.manualNewFeeNote;
      if (!isFiniteNumber_(manualAmount) || manualAmount < 0 ||
          typeof manualNote !== 'string' || !manualNote.trim()) {
        return { blocked: error_('FEE_NOT_AVAILABLE', feeStatusMessage_(feeCtx.status, feeCtx.message)) };
      }
      var baseline = feeCtx.baseline;
      var unrefunded = Math.max(0, baseline.feePaidAmount - baseline.feeRefundedAmount);
      var assessment = FeeCalculator.assessScheduleChangeFee({
        oldAmount: baseline.oldAmount, newAmount: manualAmount, unrefundedPaidAmount: unrefunded,
        scheduleChangeCount: baseline.scheduleChangeCount, cancellationPolicyCategory: 'SAME_DAY'
      });
      /* 料金を自動算出できない組み合わせ・端数のため、キャンセル規定の「前日まで無料」
         判定も安全側（SAME_DAY扱い＝要決定）に倒す。減額の場合は下のPENDING_POLICY_DECISION
         処理へ必ず合流させ、manualRefundDecisionも必須にする。 */
      return finalizeFeeDecision_(
        {
          dayType: feeCtx.quote && feeCtx.quote.dayType, roundedMinutes: feeCtx.quote && feeCtx.quote.roundedMinutes,
          amount: manualAmount, manual: true, manualNote: manualNote.trim().slice(0, 500)
        },
        assessment, feeConfirmation, unrefunded, 'MANUAL_UNSUPPORTED'
      );
    }
    return finalizeFeeDecision_(feeCtx.quote, feeCtx.assessment, feeConfirmation, feeCtx.unrefunded, feeCtx.cancellationCategory);
  }

  function finalizeFeeDecision_(quote, assessment, feeConfirmation, unrefunded, cancellationCategory) {
    var refundStatus = assessment.refundStatus;
    var refundAmount = assessment.refundCandidateAmount;
    var refundApprovedAmount = null;
    var refundApprovedAt = null;
    var pendingReason = assessment.pendingReason;
    if (refundStatus === 'PENDING_POLICY_DECISION') {
      var decision = feeConfirmation.manualRefundDecision;
      var cap = Math.min(Math.max(0, -assessment.feeDifference), unrefunded);
      if (!decision || typeof decision.note !== 'string' || !decision.note.trim() ||
          !isFiniteNumber_(decision.approvedAmount) || decision.approvedAmount < 0 || decision.approvedAmount > cap) {
        return { blocked: error_('FEE_REFUND_DECISION_REQUIRED', '返金額の取り扱いが規約上未確定です。管理者が金額（0〜' + cap + '円）と理由を入力してください。') };
      }
      refundStatus = 'APPROVED';
      refundApprovedAmount = decision.approvedAmount;
      refundAmount = decision.approvedAmount;
      refundApprovedAt = new Date();
      pendingReason = decision.note.trim().slice(0, 500);
    }
    return {
      blocked: null, quote: quote, assessment: assessment, cancellationCategory: cancellationCategory,
      refundStatus: refundStatus, refundCandidateAmount: refundAmount,
      refundApprovedAmount: refundApprovedAmount, refundApprovedAt: refundApprovedAt, pendingReason: pendingReason
    };
  }

  /*
   * 日時・予約IDを保持する。変更記録の生成失敗時には予定と台帳を戻す。
   * Web AppのcreateBookingとはscript lock非共有のため、確定直前にもCalendarを取得する。
   *
   * 更新順序（PR #345レビュー対応: CalendarとSheetsは完全な分散トランザクションに
   * できないため、順序・コミット状態・復旧方法を明示する）:
   *   1. BookingChanges履歴行を作成（旧料金・新料金は既にこの時点で確定済みの値を書く。
   *      以降のCalendar/Sheets更新の成否に関わらずここは変えない）。
   *   2. Calendarイベントの開始・終了を更新。失敗したら旧日時へロールバックを試み、
   *      失敗の場合はCALENDAR_UPDATE_FAILED（Recoveryへ記録）で確定を中止する。
   *   3. Bookingsのdate/startAt/endAtを更新。失敗したらCalendarを旧日時へロールバックし、
   *      SHEETS_UPDATE_FAILEDで確定を中止する。ここまで成功すれば「日時変更」自体は完了。
   *   4. Bookingsのメタデータ（updatedAt・前日リマインド等のクリア）を更新。失敗しても
   *      日時変更自体は成立済みのため確定は中止しない（Recoveryへ記録し処理を続ける）。
   *   5. Bookingsの料金関連フィールド（現在の確定金額・変更回数・精算状態）を
   *      updateBookingRescheduleFeeAtomicで1回のRange.setValuesとして更新する。
   *      **ここが失敗した場合はロールバックしない**（3の日時変更を再度ロールバックすると
   *      別の失敗を重ねるリスクがあるため）。代わりにfeeRecoveryRequiredAtを立てて
   *      この予約の以降のcommit/recordFeeSettlementを一律ブロックし、戻り値の
   *      successをfalseにする（「成功扱いで握りつぶす」ことを構造的に禁止する。
   *      変更回数が更新されないまま次回も「初回変更」と誤判定される事故を防ぐ）。
   *   6. 変更通知メールを送信（日時変更の事実は5の成否に関わらず利用者へ知らせる必要が
   *      あるため、5が失敗していても送信は試みる）。
   */
  function commit(bookingId, input, expectedVersion, reason, feeNote, feeConfirmation) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    var outcome;
    try {
      var check = parse_(bookingId, input, expectedVersion, new Date());
      if (!check.success) return check;
      var record = check.record;
      if (isInFeeRecovery_(record)) {
        return error_('FEE_RECOVERY_REQUIRED', 'この予約は料金の整合性確認が必要な状態です。resolveFeeRecoveryで解消してから操作してください。');
      }
      var today = BookingAvailability.formatDateInTimezone(new Date(), check.timezone);
      var feeCtx = computeFeeContext_(record, check.durationMinutes, check.date, today, check.timezone);
      var feeResolution = resolveFeeForCommit_(feeCtx, feeConfirmation);
      if (feeResolution.blocked) return feeResolution.blocked;

      var oldDate = dateStringOf_(record.startAt, check.timezone);
      var oldStartAt = record.startAt;
      var oldEndAt = record.endAt;
      var changeId = Utilities.getUuid();
      var sheet = history_(); // 変更前に履歴記録先を確保
      var rowNumber = sheet.getLastRow() + 1;
      var safeReason = String(reason || '').slice(0, 500);
      var safeFeeNote = String(feeNote || '料金差額がある場合は運営から別途ご案内します。').slice(0, 500);
      var feeDetails = {
        priceTier: feeCtx.baseline.priceTier,
        brand: record.brand,
        dayType: feeResolution.quote.dayType,
        roundedMinutes: feeResolution.quote.roundedMinutes,
        manual: !!feeResolution.quote.manual,
        manualNote: feeResolution.quote.manualNote || '',
        pendingReason: feeResolution.pendingReason || ''
      };
      sheet.appendRow([
        changeId, bookingId, new Date(), oldDate, oldStartAt, oldEndAt,
        check.date, check.startAt, check.endAt, safeReason, safeFeeNote, 'PREPARED', '', '',
        feeCtx.baseline.oldAmount, feeResolution.quote.amount, feeResolution.assessment.feeDifference,
        feeResolution.cancellationCategory,
        feeResolution.refundStatus, feeResolution.refundCandidateAmount,
        feeResolution.refundApprovedAmount, feeResolution.refundApprovedAt,
        feeResolution.pendingReason, '', JSON.stringify(feeDetails)
      ]);
      try {
        check.own.setTime(check.startAt, check.endAt);
      } catch (calendarError) {
        var calendarRollbackOK = false;
        try {
          check.own.setTime(oldStartAt, oldEndAt);
          calendarRollbackOK = true;
        } catch (rollbackError) {
          logFailure_(bookingId, 'RESCHEDULE_CALENDAR_ROLLBACK_FAILED', record.status);
        }
        try {
          sheet.getRange(rowNumber, 12).setValue(calendarRollbackOK ? 'CHANGE_FAILED' : 'RECOVERY_REQUIRED');
        } catch (historyError) {
          logFailure_(bookingId, 'RESCHEDULE_HISTORY_UPDATE_FAILED', record.status);
        }
        return error_('CALENDAR_UPDATE_FAILED', calendarRollbackOK
          ? 'Calendar更新に失敗したため元の日時を再設定しました。台帳を確認してください。'
          : 'Calendar更新結果が不明です。Recoveryと台帳を確認し、再実行しないでください。');
      }
      try {
        SpreadsheetRepository.updateBookingScheduleAtomic(bookingId, check.date, check.startAt, check.endAt);
      } catch (sheetsError) {
        var rollbackOK = false;
        try {
          check.own.setTime(oldStartAt, oldEndAt);
          rollbackOK = true;
        } catch (rollbackError) {
          logFailure_(bookingId, 'RESCHEDULE_ROLLBACK_FAILED', record.status);
        }
        try { sheet.getRange(rowNumber, 12).setValue(rollbackOK ? 'ROLLED_BACK' : 'RECOVERY_REQUIRED'); } catch (e) {
          logFailure_(bookingId, 'RESCHEDULE_HISTORY_UPDATE_FAILED', record.status);
        }
        return error_('SHEETS_UPDATE_FAILED', rollbackOK
          ? '台帳の更新に失敗したためCalendarを元に戻しました。台帳を確認してください。'
          : '台帳とCalendarの整合性が不明です。Recoveryを確認し、再実行しないでください。');
      }
      try {
        SpreadsheetRepository.updateBookingFields(bookingId, { updatedAt: new Date() });
        if (oldDate !== check.date) {
          SpreadsheetRepository.updateBookingFields(bookingId, { reminderSentAt: '', accessGuideSentAt: '' });
        }
      } catch (metadataError) {
        logFailure_(bookingId, 'RESCHEDULE_METADATA_UPDATE_FAILED', record.status);
      }

      var settlementState = feeResolution.refundStatus === 'ADDITIONAL_CHARGE_REQUIRED' ? 'PENDING_CHARGE'
        : (feeResolution.refundCandidateAmount > 0 ? 'PENDING_REFUND' : feeCtx.baseline.feeSettlementState);
      var feeUpdateFailed = false;
      try {
        SpreadsheetRepository.updateBookingRescheduleFeeAtomic(bookingId, {
          priceOverrideAmount: feeResolution.quote.amount,
          priceOverrideAt: new Date(),
          scheduleChangeCount: feeCtx.baseline.scheduleChangeCount + 1,
          feeSettlementState: settlementState
        });
      } catch (feeUpdateError) {
        feeUpdateFailed = true;
        logFailure_(bookingId, 'RESCHEDULE_FEE_ATOMIC_UPDATE_FAILED', record.status);
        try {
          SpreadsheetRepository.updateBookingFields(bookingId, {
            feeRecoveryRequiredAt: new Date(),
            feeRecoveryReason: '日時変更確定後の料金・変更回数・精算状態の更新に失敗しました。台帳を確認し、resolveFeeRecoveryで復旧してから次の日時変更・精算操作を行ってください。'
          });
        } catch (flagError) {
          logFailure_(bookingId, 'RESCHEDULE_FEE_RECOVERY_FLAG_FAILED', record.status);
        }
      }

      try {
        sheet.getRange(rowNumber, 12).setValue('PENDING');
      } catch (historyError) {
        logFailure_(bookingId, 'RESCHEDULE_HISTORY_UPDATE_FAILED', record.status);
        return { success: true, bookingId: bookingId, changeId: changeId,
          mailSent: false, warning: '日時は変更されましたが履歴更新に失敗しました。通知は送らずRecoveryを確認してください。' };
      }
      outcome = {
        success: !feeUpdateFailed, bookingId: bookingId, changeId: changeId, mailSent: false,
        oldFeeAmount: feeCtx.baseline.oldAmount, newFeeAmount: feeResolution.quote.amount,
        feeDifference: feeResolution.assessment.feeDifference, refundStatus: feeResolution.refundStatus,
        refundAmount: feeResolution.refundApprovedAmount !== null ? feeResolution.refundApprovedAmount : feeResolution.refundCandidateAmount
      };
      if (feeUpdateFailed) {
        outcome.error = {
          code: 'FEE_UPDATE_FAILED_RECOVERY_REQUIRED',
          message: '日時の変更自体は完了しましたが、料金・変更回数・精算状態の更新に失敗しました。台帳とRecoveryを確認し、resolveFeeRecoveryで復旧してください。復旧するまでこの予約の日時変更・精算操作はブロックされます。'
        };
      }
    } catch (e) {
      return error_('RESCHEDULE_FAILED', '日時変更に失敗しました。Recoveryと予約台帳を確認してください。');
    } finally {
      lock.releaseLock();
    }
    var mail = sendMail(outcome.changeId, false);
    outcome.mailSent = !!mail.success;
    if (!mail.success) outcome.warning = mail.error && mail.error.message;
    return outcome;
  }

  function findChange_(changeId) {
    var sheet = history_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === changeId) return { sheet: sheet, rowNumber: i + 1, row: values[i] };
    }
    return null;
  }

  function feeSummaryLines_(row) {
    var oldFee = row[14];
    var newFee = row[15];
    var diff = row[16];
    var refundStatus = row[18];
    var refundCandidate = row[19];
    var refundApproved = row[20];
    if (!isFiniteNumber_(oldFee) || !isFiniteNumber_(newFee)) return [];
    var lines = ['元料金: ' + oldFee + '円', '新料金: ' + newFee + '円', '差額: ' + diff + '円'];
    if (refundStatus === 'ADDITIONAL_CHARGE_REQUIRED') {
      lines.push('追加のご請求が必要です。別途ご案内します。');
    } else if (refundStatus === 'CANDIDATE' || refundStatus === 'APPROVED') {
      var amount = isFiniteNumber_(refundApproved) ? refundApproved : refundCandidate;
      lines.push(refundStatus === 'APPROVED'
        ? '返金額（承認済み・試算ではありません）: ' + amount + '円。別途ご案内します。'
        : '返金試算額（要確認）: ' + amount + '円。運営から確定のご案内をお送りします。');
    } else if (refundStatus === 'PENDING_POLICY_DECISION') {
      lines.push('返金の要否・金額は運営で確認のうえ、別途ご案内します。');
    }
    return lines;
  }

  /* メール前にSENDINGを記録。送信結果が不明なときは自動再送しない。 */
  function sendMail(changeId, force) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '通知処理中です。');
    try {
      var change = findChange_(changeId);
      if (!change) return error_('CHANGE_NOT_FOUND', '変更履歴が見つかりません。');
      var row = change.row;
      if (row[11] !== 'PENDING' && !(force && row[11] === 'FAILED')) {
        return error_('MAIL_STATE_INVALID', 'この通知は再送できません。送信履歴を確認してください。');
      }
      var found = SpreadsheetRepository.findRowByBookingId(row[1]);
      if (!found || found.record.status !== Booking.STATUS.CONFIRMED ||
          !isDate_(found.record.startAt) || found.record.startAt.getTime() !== row[7].getTime() ||
          !isDate_(found.record.endAt) || found.record.endAt.getTime() !== row[8].getTime()) {
        return error_('BOOKING_CHANGED_AGAIN', '予約日時が再変更されています。古い通知は送信しません。');
      }
      var config = BookingConfig.getMailConfig();
      if (!config.displayName || !config.replyTo || !config.contactEmail ||
          !BookingAvailability.formatDateInTimezone(new Date(), config.timezone) || !found.record.email) {
        change.sheet.getRange(change.rowNumber, 12).setValue('FAILED');
        return error_('MAIL_NOT_READY', 'メール設定または宛先が未設定です。');
      }
      var oldDateText = BookingAvailability.formatDateInTimezone(row[4], config.timezone);
      var newDateText = BookingAvailability.formatDateInTimezone(row[7], config.timezone);
      var oldStart = BookingAvailability.formatTimeInTimezone(row[4], config.timezone);
      var oldEnd = BookingAvailability.formatTimeInTimezone(row[5], config.timezone);
      var newStart = BookingAvailability.formatTimeInTimezone(row[7], config.timezone);
      var newEnd = BookingAvailability.formatTimeInTimezone(row[8], config.timezone);
      var brand = Booking.getBrandLabel(found.record.brand);
      var bodyLines = [
        found.record.name + ' 様', '', 'ご予約の日時変更が確定しました。',
        '予約ID: ' + row[1],
        '変更前: ' + oldDateText + ' ' + oldStart + '〜' + oldEnd,
        '変更後: ' + newDateText + ' ' + newStart + '〜' + newEnd,
        '利用時間: ' + Math.round((row[8].getTime() - row[7].getTime()) / 60000) + '分'
      ].concat(feeSummaryLines_(row)).concat([
        '料金・精算: ' + row[10], '', 'お問い合わせ: ' + config.contactEmail
      ]);
      var mail = {
        to: found.record.email,
        subject: '【' + brand + '】予約日時変更のお知らせ',
        body: bodyLines.join('\n'),
        name: config.displayName, replyTo: config.replyTo
      };
      change.sheet.getRange(change.rowNumber, 12).setValue('SENDING');
      try {
        MailApp.sendEmail(mail);
      } catch (e) {
        try {
          change.sheet.getRange(change.rowNumber, 12).setValue('FAILED');
          change.sheet.getRange(change.rowNumber, 14).setValue('メール送信エラー。宛先と送信履歴を確認してください。');
        } catch (historyError) {
          logFailure_(row[1], 'RESCHEDULE_MAIL_STATE_UNKNOWN', found.record.status);
        }
        return error_('MAIL_SEND_FAILED', '日時は変更されましたが通知に失敗しました。管理画面から再送してください。');
      }
      try {
        change.sheet.getRange(change.rowNumber, 13, 1, 2).setValues([[new Date(), '']]);
        change.sheet.getRange(change.rowNumber, 12).setValue('SENT');
      } catch (e) {
        logFailure_(row[1], 'RESCHEDULE_MAIL_STATE_UNKNOWN', found.record.status);
        return error_('MAIL_STATE_UNKNOWN', 'メール送信済みの可能性があります。再送せず履歴を確認してください。');
      }
      return { success: true, changeId: changeId };
    } catch (e) {
      return error_('MAIL_FAILED', '通知処理に失敗しました。履歴を確認してください。');
    } finally {
      lock.releaseLock();
    }
  }

  function getChanges(bookingId) {
    var sheet = history_();
    var values = sheet.getDataRange().getValues();
    return values.slice(1).filter(function (row) { return row[1] === bookingId; }).map(function (row) {
      return {
        changeId: row[0], changedAt: isDate_(row[2]) ? row[2].toISOString() : '',
        oldDate: isDate_(row[4]) ? BookingAvailability.formatDateInTimezone(row[4], BookingConfig.getAvailabilityConfig().timezone) : '',
        newDate: isDate_(row[7]) ? BookingAvailability.formatDateInTimezone(row[7], BookingConfig.getAvailabilityConfig().timezone) : '',
        mailState: row[11],
        feeNote: row[10],
        oldFeeAmount: isFiniteNumber_(row[14]) ? row[14] : null,
        newFeeAmount: isFiniteNumber_(row[15]) ? row[15] : null,
        feeDifference: isFiniteNumber_(row[16]) ? row[16] : null,
        refundStatus: row[18] || '',
        refundCandidateAmount: isFiniteNumber_(row[19]) ? row[19] : null,
        refundApprovedAmount: isFiniteNumber_(row[20]) ? row[20] : null,
        refundPendingReason: row[22] || '',
        settlementStateAtChange: row[23] || ''
      };
    }).reverse();
  }

  /*
   * Issue #344追記（精算の冪等性。PR #345レビュー対応）: 実際のStripe/PayPay/現金の
   * 入出金を管理者が確認した後にのみ呼び出す。自動決済・自動判定は一切行わない。
   * settlementIdは呼び出し側（Web UI）が生成・保持する冪等性キー。同一IDの再送は
   * 内容が完全一致する限り安全（二重加算しない）。内容が異なれば拒否する。changeIdを
   * 指定した場合は、それがbookingIdに属することを検証する。
   */
  function recordFeeSettlement(bookingId, changeId, settlementId, settlementState, paidAmountDelta, refundedAmountDelta, note) {
    if (typeof settlementId !== 'string' || !settlementId.trim()) {
      return error_('SETTLEMENT_ID_REQUIRED', '精算IDを指定してください。');
    }
    if (VALID_SETTLEMENT_STATES_.indexOf(settlementState) === -1) {
      return error_('INVALID_STATE', '精算状態が不正です。');
    }
    var paidDelta = Number(paidAmountDelta);
    var refundedDelta = Number(refundedAmountDelta);
    if (!isFiniteNumber_(paidDelta) || paidDelta < 0 || !isFiniteNumber_(refundedDelta) || refundedDelta < 0) {
      return error_('INVALID_AMOUNT', '入出金額は0以上の数値で指定してください。');
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
      if (isInFeeRecovery_(found.record)) {
        return error_('FEE_RECOVERY_REQUIRED', 'この予約は料金の整合性確認が必要な状態です。resolveFeeRecoveryで解消してから精算を記録してください。');
      }
      if (changeId) {
        var change = findChange_(changeId);
        if (!change || change.row[1] !== bookingId) {
          return error_('INVALID_CHANGE_ID', '指定した変更IDはこの予約のものではありません。');
        }
      }

      var existing = FeeSettlementRepository.findBySettlementId(settlementId);
      if (existing) {
        var sameRequest = existing.record.bookingId === bookingId &&
          String(existing.record.changeId || '') === String(changeId || '') &&
          existing.record.settlementState === settlementState &&
          Number(existing.record.paidDelta) === paidDelta &&
          Number(existing.record.refundedDelta) === refundedDelta;
        if (!sameRequest) {
          return error_('SETTLEMENT_ID_CONFLICT', 'この精算IDは既に異なる内容で使用されています。新しい精算IDを発行してください。');
        }
        if (existing.record.applyStatus === 'APPLIED') {
          return {
            success: true, bookingId: bookingId, settlementState: settlementState,
            resultPaidAmount: Number(existing.record.resultPaidAmount),
            resultRefundedAmount: Number(existing.record.resultRefundedAmount),
            replay: true
          };
        }
        if (existing.record.applyStatus === 'FAILED_NEEDS_RECOVERY') {
          return error_('SETTLEMENT_RECOVERY_REQUIRED', 'この精算は前回反映に失敗しました。台帳とFeeSettlementsシートを確認し、resolveFeeRecoveryで復旧してから再度実行してください。');
        }
        // PENDING_APPLY: 前回試行がBookings反映前に中断された可能性がある。同じ内容の
        // リクエストなので、同じ行を使ってBookingsへの反映だけを再試行する。
        return applySettlement_(found, existing.rowNumber, settlementState, paidDelta, refundedDelta, note);
      }

      var currentPaid = isFiniteNumber_(found.record.feePaidAmount) ? found.record.feePaidAmount : 0;
      var currentRefunded = isFiniteNumber_(found.record.feeRefundedAmount) ? found.record.feeRefundedAmount : 0;
      var unrefunded = Math.max(0, currentPaid - currentRefunded);
      if (refundedDelta > unrefunded) {
        return error_('REFUND_EXCEEDS_UNREFUNDED', '返金額は未返金の入金額（' + unrefunded + '円）を超えられません。');
      }
      var rowNumber = FeeSettlementRepository.appendPending({
        settlementId: settlementId, bookingId: bookingId, changeId: changeId || '',
        settlementState: settlementState, paidDelta: paidDelta, refundedDelta: refundedDelta, note: note || ''
      });
      return applySettlement_(found, rowNumber, settlementState, paidDelta, refundedDelta, note);
    } finally {
      lock.releaseLock();
    }
  }

  /* 精算リクエストをBookingsへ反映する。FeeSettlements行は既に（PENDING_APPLYとして）
     記録済みであることが前提。反映の成否をFeeSettlements行にも書き戻す。 */
  function applySettlement_(found, settlementRowNumber, settlementState, paidDelta, refundedDelta, note) {
    var record = found.record;
    var currentPaid = isFiniteNumber_(record.feePaidAmount) ? record.feePaidAmount : 0;
    var currentRefunded = isFiniteNumber_(record.feeRefundedAmount) ? record.feeRefundedAmount : 0;
    var newPaid = currentPaid + paidDelta;
    var newRefunded = currentRefunded + refundedDelta;
    try {
      SpreadsheetRepository.updateBookingRescheduleFeeAtomic(record.bookingId, {
        feePaidAmount: newPaid, feeRefundedAmount: newRefunded,
        feeSettlementState: settlementState, feeSettlementNote: String(note || '').slice(0, 500),
        feeSettlementUpdatedAt: new Date()
      });
    } catch (e) {
      try { FeeSettlementRepository.markFailedNeedsRecovery(settlementRowNumber); } catch (e2) { /* best effort */ }
      try {
        SpreadsheetRepository.updateBookingFields(record.bookingId, {
          feeRecoveryRequiredAt: new Date(),
          feeRecoveryReason: '精算記録（入出金）の台帳反映に失敗しました。FeeSettlementsシートとBookingsを確認し、resolveFeeRecoveryで復旧してください。'
        });
      } catch (e3) {
        logFailure_(record.bookingId, 'RESCHEDULE_FEE_RECOVERY_FLAG_FAILED', record.status);
      }
      logFailure_(record.bookingId, 'RESCHEDULE_SETTLEMENT_APPLY_FAILED', record.status);
      return error_('SETTLEMENT_APPLY_FAILED', '精算の記録に失敗しました。台帳を確認してください（要復旧の状態になっています）。');
    }
    try {
      FeeSettlementRepository.markApplied(settlementRowNumber, newPaid, newRefunded);
    } catch (e) {
      /* Bookings側は既に正しく反映されているが、FeeSettlements側の状態更新が失敗した。
         この行がPENDING_APPLYのまま残ると、同じsettlementIdの再送がBookingsへ差分を
         再度加算しかねない（二重計上）。それを避けるため、Bookings側をロックして
         管理者の手動確認を必須にする。 */
      logFailure_(record.bookingId, 'RESCHEDULE_SETTLEMENT_MARK_APPLIED_FAILED', record.status);
      try {
        SpreadsheetRepository.updateBookingFields(record.bookingId, {
          feeRecoveryRequiredAt: new Date(),
          feeRecoveryReason: '精算はBookingsへ反映されましたが、FeeSettlements台帳の状態更新に失敗しました。二重計上を避けるため操作をブロックしています。resolveFeeRecoveryで復旧してください。'
        });
      } catch (e2) {
        logFailure_(record.bookingId, 'RESCHEDULE_FEE_RECOVERY_FLAG_FAILED', record.status);
      }
      return error_('SETTLEMENT_STATE_UNKNOWN', '精算はおそらく記録されましたが、精算台帳の状態確認に失敗しました。二重実行を避けるため予約をロックしました。Recoveryを確認してください。');
    }
    return { success: true, bookingId: record.bookingId, settlementState: settlementState, resultPaidAmount: newPaid, resultRefundedAmount: newRefunded };
  }

  /*
   * Issue #344追記（PR #345レビュー対応）: commit/recordFeeSettlementの部分失敗で
   * feeRecoveryRequiredAtが立った予約を、管理者が実際の台帳・Calendar・FeeSettlementsを
   * 確認したうえで復旧する。correctionsに指定したフィールドだけを上書きし、それ以外は
   * 現在値を維持する（既存のpaymentLinkMetadataInconsistentAt系の補正関数と同じ設計）。
   */
  function resolveFeeRecovery(bookingId, corrections) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
    if (!isInFeeRecovery_(found.record)) return error_('NOT_IN_RECOVERY', 'この予約は要復旧の状態ではありません。');
    corrections = corrections || {};
    var fields = { feeRecoveryRequiredAt: '', feeRecoveryReason: '' };
    if (corrections.priceOverrideAmount !== undefined) {
      if (!isFiniteNumber_(corrections.priceOverrideAmount) || corrections.priceOverrideAmount < 0) {
        return error_('INVALID_AMOUNT', '確定金額は0以上の数値で指定してください。');
      }
      fields.priceOverrideAmount = corrections.priceOverrideAmount;
      fields.priceOverrideAt = new Date();
    }
    if (corrections.scheduleChangeCount !== undefined) {
      if (!isFiniteNumber_(corrections.scheduleChangeCount) || corrections.scheduleChangeCount < 0) {
        return error_('INVALID_AMOUNT', '変更回数は0以上の整数で指定してください。');
      }
      fields.scheduleChangeCount = corrections.scheduleChangeCount;
    }
    if (corrections.feeSettlementState !== undefined) {
      if (corrections.feeSettlementState !== '' && VALID_SETTLEMENT_STATES_.indexOf(corrections.feeSettlementState) === -1) {
        return error_('INVALID_STATE', '精算状態が不正です。');
      }
      fields.feeSettlementState = corrections.feeSettlementState;
    }
    if (corrections.feePaidAmount !== undefined) {
      if (!isFiniteNumber_(corrections.feePaidAmount) || corrections.feePaidAmount < 0) {
        return error_('INVALID_AMOUNT', '支払済み額は0以上の数値で指定してください。');
      }
      fields.feePaidAmount = corrections.feePaidAmount;
    }
    if (corrections.feeRefundedAmount !== undefined) {
      if (!isFiniteNumber_(corrections.feeRefundedAmount) || corrections.feeRefundedAmount < 0) {
        return error_('INVALID_AMOUNT', '返金済み額は0以上の数値で指定してください。');
      }
      fields.feeRefundedAmount = corrections.feeRefundedAmount;
    }
    try {
      SpreadsheetRepository.updateBookingRescheduleFeeAtomic(bookingId, fields);
    } catch (e) {
      return error_('UPDATE_FAILED', '復旧の保存に失敗しました。');
    }
    return { success: true, bookingId: bookingId };
  }

  return {
    preview: preview, commit: commit, sendMail: sendMail, getChanges: getChanges,
    backfillOriginalPrice: backfillOriginalPrice, recordFeeSettlement: recordFeeSettlement,
    resolveFeeRecovery: resolveFeeRecovery
  };
})();

/* Booking Admin Web App専用のgoogle.script.run公開関数。 */
function adminPreviewBookingReschedule(bookingId, input, expectedVersion) {
  return BookingReschedule.preview(bookingId, input, expectedVersion);
}
function adminRescheduleBooking(bookingId, input, expectedVersion, reason, feeNote, feeConfirmation) {
  return BookingReschedule.commit(bookingId, input, expectedVersion, reason, feeNote, feeConfirmation);
}
function adminResendRescheduleMail(changeId) {
  return BookingReschedule.sendMail(changeId, true);
}
function adminGetBookingChanges(bookingId) {
  return BookingReschedule.getChanges(bookingId);
}
function adminBackfillOriginalPrice(bookingId, priceTier, amount, note) {
  return BookingReschedule.backfillOriginalPrice(bookingId, priceTier, amount, note);
}
function adminRecordRescheduleFeeSettlement(bookingId, changeId, settlementId, settlementState, paidAmountDelta, refundedAmountDelta, note) {
  return BookingReschedule.recordFeeSettlement(bookingId, changeId, settlementId, settlementState, paidAmountDelta, refundedAmountDelta, note);
}
function adminResolveFeeRecovery(bookingId, corrections) {
  return BookingReschedule.resolveFeeRecovery(bookingId, corrections);
}
