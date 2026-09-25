/* Issue #344: Booking Admin専用。公開Booking Web Appへ配置しない。
 *
 * Issue #344追記（Phase 1/2）: 料金差額の自動計算を追加した。既存Bookingsに金額が
 * 記録されていない予約があるため、日程変更を確定するには必ず先にsetFeeBaseline()で
 * 「元の確定料金・支払額・適用区分（会員／通常）」を管理者が照合・入力しておく必要がある
 * （未確認のままでは確定ボタンに相当するcommit()自体が失敗する。Phase 2「元料金未確認は
 * 確定ボタンを無効にする」）。
 *
 * 料金差額そのものの扱い（FeeCalculator.assessScheduleChangeFee参照）:
 * - 新料金が高い場合は単純な追加請求（ADDITIONAL_CHARGE_REQUIRED）。
 * - 新料金が安く、かつ「今回が初めての日程変更」かつ「変更前利用日の前日まで」の場合のみ、
 *   キャンセル料なしの返金候補を自動算出する（CANDIDATE）。
 * - それ以外の減額（2回目以降・当日）は規約上どちらとも決められないため
 *   （PENDING_POLICY_DECISION）、管理者が金額と理由を明示的に入力しない限り確定できない
 *   （commit()のfeeConfirmation.manualRefundDecision。自動では一切金額を作らない）。
 * - 料金マスタに定義が無い組み合わせ（mens×general、studio_x×member等）も同様に、
 *   管理者がfeeConfirmation.manualNewFeeAmount/manualNewFeeNoteで金額と理由を明示しない
 *   限り確定できない。
 * - 資金移動（実際の入出金）は料金確定とは別。recordFeeSettlement()で、管理者が
 *   Stripe/PayPay/現金の入出金を確認した後にのみ反映する（自動決済は一切行わない）。
 */
'use strict';

var BookingReschedule = (function () {
  var HISTORY_SHEET_ = 'BookingChanges';
  var HISTORY_HEADERS_ = [
    'changeId', 'bookingId', 'changedAt', 'oldDate', 'oldStartAt', 'oldEndAt',
    'newDate', 'newStartAt', 'newEndAt', 'reason', 'feeNote', 'mailState', 'mailAt', 'mailError',
    /* Issue #344追記（Phase 1）で追加した列。末尾追記の方針は既存Bookings/BookingChanges列と同じ。 */
    'oldFeeAmount', 'newFeeAmount', 'feeDifference', 'feeMasterVersion', 'cancellationPolicyCategory',
    'refundStatus', 'refundCandidateAmount', 'refundApprovedAmount', 'refundApprovedAt',
    'refundPendingReason', 'settlementStateAtChange', 'feeDetailsJson'
  ];
  var VALID_PRICE_CATEGORIES_ = ['general', 'member'];

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

  /* Issue #344追記: Bookingsの料金関連フィールドを読み取り、既定値を補う。 */
  function feeBaseline_(record) {
    return {
      priceCategory: record.priceCategory || '',
      priceCategoryBasis: record.priceCategoryBasis || '',
      confirmedFeeAmount: isFiniteNumber_(record.confirmedFeeAmount) ? Number(record.confirmedFeeAmount) : null,
      feePaidAmount: isFiniteNumber_(record.feePaidAmount) ? Number(record.feePaidAmount) : 0,
      feeRefundedAmount: isFiniteNumber_(record.feeRefundedAmount) ? Number(record.feeRefundedAmount) : 0,
      feeMasterVersion: isFiniteNumber_(record.feeMasterVersion) ? Number(record.feeMasterVersion) : null,
      feeInitializedAt: isDate_(record.feeInitializedAt) ? record.feeInitializedAt : null,
      scheduleChangeCount: isFiniteNumber_(record.scheduleChangeCount) ? Number(record.scheduleChangeCount) : 0,
      feeSettlementState: record.feeSettlementState || ''
    };
  }

  /*
   * Issue #344追記: 新しい日時の料金見積り・差額判定をまとめて行う。
   * baseline未確認・料金表未定義の場合はready:falseで返し、金額は一切作らない
   * （呼び出し側=commit()が、その状態のまま確定させるかどうかを判断する）。
   */
  function computeFeeContext_(record, newDurationMinutes, newDateString, todayDateString, timezone) {
    var baseline = feeBaseline_(record);
    if (!baseline.feeInitializedAt || !baseline.priceCategory || baseline.confirmedFeeAmount === null) {
      return { ready: false, status: 'BASELINE_REQUIRED', baseline: baseline };
    }
    var quote = FeeCalculator.quoteFee({
      brand: record.brand, priceCategory: baseline.priceCategory,
      durationMinutes: newDurationMinutes, dateString: newDateString, asOfDateString: todayDateString
    });
    if (!quote.supported) {
      return { ready: false, status: quote.reason, baseline: baseline, quote: quote };
    }
    var oldDateString = BookingAvailability.formatDateInTimezone(record.startAt, timezone);
    var cancellationCategory = FeeCalculator.classifyCancellationPolicy(oldDateString, todayDateString);
    var unrefunded = Math.max(0, baseline.feePaidAmount - baseline.feeRefundedAmount);
    var assessment = FeeCalculator.assessScheduleChangeFee({
      oldAmount: baseline.confirmedFeeAmount, newAmount: quote.amount, unrefundedPaidAmount: unrefunded,
      scheduleChangeCount: baseline.scheduleChangeCount, cancellationPolicyCategory: cancellationCategory
    });
    return {
      ready: true, status: 'READY', baseline: baseline, quote: quote,
      cancellationCategory: cancellationCategory, unrefunded: unrefunded, assessment: assessment
    };
  }

  function feeStatusMessage_(status) {
    if (status === 'BASELINE_REQUIRED') return '元の確定料金が未確認です。先に基準料金を設定してください。';
    if (status === 'NO_PRICE_DATA') return 'この予約区分（ブランド×会員/通常）の料金表が未整備です。管理者が金額を確認してください。';
    if (status === 'DURATION_TOO_SHORT') return '利用時間が短すぎるため自動算出できません。';
    return '新しい日時の料金を自動算出できません。管理者が確認してください。';
  }

  /*
   * Issue #344追記: 元の確定料金・支払額・適用区分（会員/通常）を管理者が照合して入力する
   * （Phase 1「初回変更時に元の確定料金…を管理者が照合して入力する」）。既存予約は金額が
   * 未記録のため必須。何度でも呼び直して補正できる（誤入力の訂正用）。日程変更そのものは
   * 行わない。
   */
  function setFeeBaseline(bookingId, priceCategory, confirmedFeeAmount, paidAmount, basisNote) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
    if (found.record.status !== Booking.STATUS.CONFIRMED) {
      return error_('INVALID_STATUS', '確定済みの予約のみ基準料金を設定できます。');
    }
    if (VALID_PRICE_CATEGORIES_.indexOf(priceCategory) === -1) {
      return error_('INVALID_PRICE_CATEGORY', '価格区分はgeneral/memberのいずれかで指定してください。');
    }
    if (!isFiniteNumber_(confirmedFeeAmount) || confirmedFeeAmount < 0) {
      return error_('INVALID_AMOUNT', '確定料金は0以上の金額で指定してください。');
    }
    if (!isFiniteNumber_(paidAmount) || paidAmount < 0) {
      return error_('INVALID_AMOUNT', '支払済み額は0以上の金額で指定してください。');
    }
    if (typeof basisNote !== 'string' || !basisNote.trim()) {
      return error_('BASIS_REQUIRED', '価格区分の確認根拠を入力してください。');
    }
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var today = BookingAvailability.formatDateInTimezone(new Date(), timezone);
    var version;
    try {
      version = FeeMasterRepository.getActiveTable(today).version;
    } catch (e) {
      return error_('FEE_MASTER_UNAVAILABLE', '料金マスタを取得できません。');
    }
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        priceCategory: priceCategory,
        priceCategoryBasis: basisNote.trim().slice(0, 500),
        confirmedFeeAmount: confirmedFeeAmount,
        feePaidAmount: paidAmount,
        feeMasterVersion: version,
        feeInitializedAt: new Date()
      });
    } catch (e) {
      return error_('UPDATE_FAILED', '基準料金の保存に失敗しました。');
    }
    return { success: true, bookingId: bookingId, priceCategory: priceCategory, confirmedFeeAmount: confirmedFeeAmount };
  }

  function preview(bookingId, input, expectedVersion) {
    try {
      var check = parse_(bookingId, input, expectedVersion, new Date());
      if (!check.success) return check;
      var today = BookingAvailability.formatDateInTimezone(new Date(), check.timezone);
      var feeCtx = computeFeeContext_(check.record, check.durationMinutes, check.date, today, check.timezone);
      var result = {
        success: true, bookingId: bookingId, expectedVersion: check.version,
        oldDate: BookingAvailability.formatDateInTimezone(check.record.startAt, check.timezone),
        oldStartTime: BookingAvailability.formatTimeInTimezone(check.record.startAt, check.timezone),
        oldEndTime: BookingAvailability.formatTimeInTimezone(check.record.endAt, check.timezone),
        newDate: check.date, newStartTime: input.startTime, newEndTime: input.endTime,
        durationMinutes: check.durationMinutes,
        feeNotice: '料金差額は自動計算されません。変更確定前に管理者が確認してください。',
        feeReady: feeCtx.ready,
        feeStatus: feeCtx.status,
        feeStatusMessage: feeCtx.ready ? '' : feeStatusMessage_(feeCtx.status),
        priceCategory: feeCtx.baseline.priceCategory,
        oldFeeAmount: feeCtx.baseline.confirmedFeeAmount,
        feeSettlementState: feeCtx.baseline.feeSettlementState,
        scheduleChangeCount: feeCtx.baseline.scheduleChangeCount
      };
      if (feeCtx.ready) {
        result.newFeeAmount = feeCtx.quote.amount;
        result.feeMasterVersion = feeCtx.quote.version;
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
        result.requiresManualNewFee = feeCtx.status === 'NO_PRICE_DATA' || feeCtx.status === 'DURATION_TOO_SHORT';
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
        return { blocked: error_('FEE_NOT_AVAILABLE', feeStatusMessage_(feeCtx.status)) };
      }
      var baseline = feeCtx.baseline;
      var unrefunded = Math.max(0, baseline.feePaidAmount - baseline.feeRefundedAmount);
      var assessment = FeeCalculator.assessScheduleChangeFee({
        oldAmount: baseline.confirmedFeeAmount, newAmount: manualAmount, unrefundedPaidAmount: unrefunded,
        scheduleChangeCount: baseline.scheduleChangeCount, cancellationPolicyCategory: 'SAME_DAY'
      });
      /* 料金表が無い組み合わせは自動算出そのものが不可能なため、キャンセル規定の
         「前日まで無料」判定も安全側（SAME_DAY扱い＝要決定）に倒す。減額の場合は
         下のPENDING_POLICY_DECISION処理へ必ず合流させ、manualRefundDecisionも必須にする。 */
      return finalizeFeeDecision_(
        { version: null, dayType: null, roundedMinutes: null, amount: manualAmount, manual: true, manualNote: manualNote.trim().slice(0, 500) },
        assessment, feeConfirmation, unrefunded, 'MANUAL_NO_PRICE_DATA'
      );
    }
    return finalizeFeeDecision_(feeCtx.quote, feeCtx.assessment, feeConfirmation, feeCtx.unrefunded, feeCtx.cancellationCategory);
  }

  function finalizeFeeDecision_(quote, assessment, feeConfirmation, unrefunded, cancellationCategory) {
    if (feeConfirmation.expectedFeeMasterVersion !== undefined && quote.version !== null &&
        feeConfirmation.expectedFeeMasterVersion !== quote.version) {
      return { blocked: error_('FEE_VERSION_MISMATCH', '料金マスタが更新されています。内容を再確認してください。') };
    }
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

  /* 日時・予約IDを保持する。変更記録の生成失敗時には予定と台帳を戻す。
   * Web AppのcreateBookingとはscript lock非共有のため、確定直前にもCalendarを取得する。
   */
  function commit(bookingId, input, expectedVersion, reason, feeNote, feeConfirmation) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    var outcome;
    try {
      var check = parse_(bookingId, input, expectedVersion, new Date());
      if (!check.success) return check;
      var record = check.record;
      var today = BookingAvailability.formatDateInTimezone(new Date(), check.timezone);
      var feeCtx = computeFeeContext_(record, check.durationMinutes, check.date, today, check.timezone);
      var feeResolution = resolveFeeForCommit_(feeCtx, feeConfirmation);
      if (feeResolution.blocked) return feeResolution.blocked;

      var oldDate = BookingAvailability.formatDateInTimezone(record.startAt, check.timezone);
      var oldStartAt = record.startAt;
      var oldEndAt = record.endAt;
      var changeId = Utilities.getUuid();
      var sheet = history_(); // 変更前に履歴記録先を確保
      var rowNumber = sheet.getLastRow() + 1;
      var safeReason = String(reason || '').slice(0, 500);
      var safeFeeNote = String(feeNote || '料金差額がある場合は運営から別途ご案内します。').slice(0, 500);
      var feeDetails = {
        priceCategory: feeCtx.baseline.priceCategory,
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
        feeCtx.baseline.confirmedFeeAmount, feeResolution.quote.amount, feeResolution.assessment.feeDifference,
        feeResolution.quote.version, feeResolution.cancellationCategory,
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
      try {
        var settlementState = feeResolution.refundStatus === 'ADDITIONAL_CHARGE_REQUIRED' ? 'PENDING_CHARGE'
          : (feeResolution.refundCandidateAmount > 0 ? 'PENDING_REFUND' : feeCtx.baseline.feeSettlementState);
        SpreadsheetRepository.updateBookingFields(bookingId, {
          confirmedFeeAmount: feeResolution.quote.amount,
          feeMasterVersion: feeResolution.quote.version === null ? feeCtx.baseline.feeMasterVersion : feeResolution.quote.version,
          feeBreakdownJson: JSON.stringify(feeDetails),
          scheduleChangeCount: feeCtx.baseline.scheduleChangeCount + 1,
          feeSettlementState: settlementState
        });
      } catch (feeMetadataError) {
        logFailure_(bookingId, 'RESCHEDULE_FEE_METADATA_UPDATE_FAILED', record.status);
      }
      try {
        sheet.getRange(rowNumber, 12).setValue('PENDING');
      } catch (historyError) {
        logFailure_(bookingId, 'RESCHEDULE_HISTORY_UPDATE_FAILED', record.status);
        return { success: true, bookingId: bookingId, changeId: changeId,
          mailSent: false, warning: '日時は変更されましたが履歴更新に失敗しました。通知は送らずRecoveryを確認してください。' };
      }
      outcome = {
        success: true, bookingId: bookingId, changeId: changeId, mailSent: false,
        oldFeeAmount: feeCtx.baseline.confirmedFeeAmount, newFeeAmount: feeResolution.quote.amount,
        feeDifference: feeResolution.assessment.feeDifference, refundStatus: feeResolution.refundStatus,
        refundAmount: feeResolution.refundApprovedAmount !== null ? feeResolution.refundApprovedAmount : feeResolution.refundCandidateAmount
      };
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
    var refundStatus = row[19];
    var refundCandidate = row[20];
    var refundApproved = row[21];
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
        refundStatus: row[19] || '',
        refundCandidateAmount: isFiniteNumber_(row[20]) ? row[20] : null,
        refundApprovedAmount: isFiniteNumber_(row[21]) ? row[21] : null,
        refundPendingReason: row[23] || '',
        settlementStateAtChange: row[24] || ''
      };
    }).reverse();
  }

  /*
   * Issue #344追記（Phase 2「料金の確定と資金移動を分離」）: 実際のStripe/PayPay/現金の
   * 入出金を管理者が確認した後にのみ呼び出す。自動決済・自動判定は一切行わない。
   * paidAmountDelta/refundedAmountDeltaは今回の入出金額（累計への加算分）。
   */
  function recordFeeSettlement(bookingId, changeId, settlementState, paidAmountDelta, refundedAmountDelta, note) {
    var VALID_STATES = ['SETTLED', 'PENDING_CHARGE', 'PENDING_REFUND', 'PENDING_DECISION'];
    if (VALID_STATES.indexOf(settlementState) === -1) {
      return error_('INVALID_STATE', '精算状態が不正です。');
    }
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
    var paidDelta = isFiniteNumber_(paidAmountDelta) ? paidAmountDelta : 0;
    var refundedDelta = isFiniteNumber_(refundedAmountDelta) ? refundedAmountDelta : 0;
    if (paidDelta < 0 || refundedDelta < 0) {
      return error_('INVALID_AMOUNT', '入出金額は0以上で指定してください。');
    }
    var baseline = feeBaseline_(found.record);
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        feePaidAmount: baseline.feePaidAmount + paidDelta,
        feeRefundedAmount: baseline.feeRefundedAmount + refundedDelta,
        feeSettlementState: settlementState,
        feeSettlementNote: String(note || '').slice(0, 500),
        feeSettlementUpdatedAt: new Date()
      });
    } catch (e) {
      return error_('UPDATE_FAILED', '精算状態の保存に失敗しました。');
    }
    if (changeId) {
      try {
        var change = findChange_(changeId);
        if (change) change.sheet.getRange(change.rowNumber, 25).setValue(settlementState);
      } catch (e) {
        logFailure_(bookingId, 'RESCHEDULE_SETTLEMENT_HISTORY_UPDATE_FAILED', found.record.status);
      }
    }
    return { success: true, bookingId: bookingId, settlementState: settlementState };
  }

  return {
    preview: preview, commit: commit, sendMail: sendMail, getChanges: getChanges,
    setFeeBaseline: setFeeBaseline, recordFeeSettlement: recordFeeSettlement
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
function adminSetBookingFeeBaseline(bookingId, priceCategory, confirmedFeeAmount, paidAmount, basisNote) {
  return BookingReschedule.setFeeBaseline(bookingId, priceCategory, confirmedFeeAmount, paidAmount, basisNote);
}
function adminRecordRescheduleFeeSettlement(bookingId, changeId, settlementState, paidAmountDelta, refundedAmountDelta, note) {
  return BookingReschedule.recordFeeSettlement(bookingId, changeId, settlementState, paidAmountDelta, refundedAmountDelta, note);
}
