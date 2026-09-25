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
   * 基準料金5列（backfillOriginalPrice）の書込み結果が不明な場合の、Bookingsの
   * feeRecoveryRequiredAtとは独立した停止条件（PR #345再レビュー対応・8回目/9回目）。
   * 9回目の全体設計レビューで、「書込み失敗後にRecovery、さらにScript Propertiesへ
   * 退避する」という多段フォールバック（8回目）は置き換えた。危険な基準料金5列の
   * 書込みを始める前に、必ずこのRecovery OPEN行（intent）を先に確保・確認し
   * （backfillOriginalPrice参照）、それ自体が確認できない場合は書込みそのものを
   * 開始しない設計にすることで、「複数の保存先が全て失敗した場合にどう倒すか」という
   * 際限のないフォールバックの積み増しを不要にした。判定自体が例外を投げた場合は
   * 「未検出」ではなくフェイルクローズ（true=ブロックする）で返す。
   */
  function isBaselineRecoveryBlocking_(bookingId) {
    try {
      return RecoveryRepository.hasOpenBaselineRecovery(bookingId);
    } catch (e) {
      return true;
    }
  }

  /*
   * feeRecoveryRequiredAtに加えて、FeeSettlementsに未確定（PENDING_APPLY/
   * FAILED_NEEDS_RECOVERY）の行が残っていないか、基準料金の書込み結果が不明なまま
   * 残っていないかも確認する（PR #345再レビュー対応・3回目/8回目）。
   * feeRecoveryRequiredAtの保存自体が失敗する複合障害が起きると、フラグが立たない
   * まま未確定の精算・基準料金だけが残ることがある。その状態でcommit/
   * recordFeeSettlementが別のsettlementId・別の日程変更を通してしまうと、未確定分の
   * 照合前に残高や確定料金・変更回数が変わってしまい、後から復旧するときの判断材料が
   * 壊れる。commit・recordFeeSettlement・backfillOriginalPriceの冒頭（Lock取得後）から
   * 必ずこちらを呼ぶこと。判定自体（FeeSettlements/Recoveryの読取）が例外を投げた場合も
   * 「未検出」として素通りさせず、フェイルクローズ（true=ブロックする）で返す。
   */
  function isBlockedForFeeRecovery_(bookingId, record) {
    try {
      return isInFeeRecovery_(record) ||
        FeeSettlementRepository.hasUnresolvedSettlement(bookingId, null) ||
        isBaselineRecoveryBlocking_(bookingId);
    } catch (e) {
      return true;
    }
  }

  /* 円単位の金額として安全か（有限・整数・安全な整数範囲内）。GASのNumber.isSafeInteger
     互換性を気にせず書けるよう、isFiniteNumber_とMath.floorの組み合わせで判定する
     （PR #345再レビュー対応・7回目）。 */
  function isSafeMoneyInteger_(value) {
    return isFiniteNumber_(value) && Math.floor(value) === value && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  }

  /*
   * 精算の入出金計算（recordFeeSettlement／applySettlement_）で、実際にBookingsへ
   * 書き込む前に必ず通す検証（PR #345再レビュー対応・7回目）。
   * 1. 現在の累計額（record.feePaidAmount/feeRefundedAmount）自体が「安全な整数・
   *    0以上・返金済み<=支払済み」でなければ、0扱いにして計算を続けたりせず、
   *    既存台帳が壊れているとみなしてFEE_RECOVERY_REQUIRED（要・人の照合）で止める。
   * 2. 今回のdelta（呼び出し側で既に安全な整数・0以上であることを検証済み）を
   *    足した結果（newPaid/newRefunded）も同じ基準（安全な整数・返金済み<=支払済み）を
   *    満たさなければ拒否する。
   * 新規精算・ABANDONEDからの再適用・applySettlement_の書込み直前のいずれからも、
   * 常にこの関数を通して同じ基準で検証すること。
   */
  function validateSettlementArithmetic_(record, paidDelta, refundedDelta) {
    var currentPaid = record.feePaidAmount === '' || record.feePaidAmount === undefined || record.feePaidAmount === null
      ? 0 : Number(record.feePaidAmount);
    var currentRefunded = record.feeRefundedAmount === '' || record.feeRefundedAmount === undefined || record.feeRefundedAmount === null
      ? 0 : Number(record.feeRefundedAmount);
    if (!isSafeMoneyInteger_(currentPaid) || currentPaid < 0 ||
        !isSafeMoneyInteger_(currentRefunded) || currentRefunded < 0 || currentRefunded > currentPaid) {
      return {
        ok: false, code: 'FEE_RECOVERY_REQUIRED',
        message: 'この予約の入出金累計額（支払済み額・返金済み額）が不正です（整数円でない、または返金済み額が支払済み額を超えています）。resolveFeeRecoveryで台帳を確認・修正してから精算を記録してください。'
      };
    }
    var newPaid = currentPaid + paidDelta;
    var newRefunded = currentRefunded + refundedDelta;
    if (!isSafeMoneyInteger_(newPaid) || !isSafeMoneyInteger_(newRefunded) || newRefunded > newPaid) {
      return {
        ok: false, code: 'REFUND_EXCEEDS_UNREFUNDED',
        message: '返金額は未返金の入金額（' + Math.max(0, currentPaid - currentRefunded) + '円）を超えられません。'
      };
    }
    return { ok: true, currentPaid: currentPaid, currentRefunded: currentRefunded, newPaid: newPaid, newRefunded: newRefunded };
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

  /* 基準料金の登録（backfillOriginalPrice）・復旧（resolveBaselinePriceRecovery）で共通の
     入力検証。どちらも同じ7項目（基準料金5列＋確認済み支払済み額・返金済み額）と
     確認根拠を必須にする（PR #345再レビュー対応・完了条件A/C）。 */
  function validateBaselineInput_(priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount) {
    if (VALID_PRICE_TIERS_.indexOf(priceTier) === -1) {
      return { error: error_('INVALID_PRICE_TIER', '価格区分はGENERAL/MEMBERのいずれかで指定してください。') };
    }
    if (!isFiniteNumber_(amount) || amount <= 0 || Math.floor(amount) !== amount) {
      return { error: error_('INVALID_AMOUNT', '確定料金は1円以上の整数で指定してください。') };
    }
    if (typeof note !== 'string' || !note.trim()) {
      return { error: error_('BASIS_REQUIRED', '価格区分・金額の確認根拠を入力してください。') };
    }
    if (!isSafeMoneyInteger_(confirmedPaidAmount) || confirmedPaidAmount < 0) {
      return { error: error_('CONFIRMED_PAID_AMOUNT_REQUIRED', '実際に確認した支払済み額を0以上の整数（円単位）で指定してください。未確認のまま0円として扱ってはいけません。') };
    }
    var normalizedRefunded = confirmedRefundedAmount === undefined || confirmedRefundedAmount === null ? 0 : confirmedRefundedAmount;
    if (!isSafeMoneyInteger_(normalizedRefunded) || normalizedRefunded < 0) {
      return { error: error_('INVALID_AMOUNT', '確認した返金済み額は0以上の整数（円単位）で指定してください。') };
    }
    if (normalizedRefunded > confirmedPaidAmount) {
      return { error: error_('REFUND_EXCEEDS_UNREFUNDED', '確認した返金済み額（' + normalizedRefunded + '円）が支払済み額（' + confirmedPaidAmount + '円）を超えています。') };
    }
    return { error: null, confirmedRefundedAmount: normalizedRefunded };
  }

  /*
   * 基準料金5列と確認済み入出金額2列を書き込み、再取得して7項目すべてが期待値と一致するかを
   * 返す。2つの書込みは別々のRange宛てのため、片方が例外を投げてももう片方は独立して試行する
   * （でなければ、実際には成功していたはずの書込みまで未反映のまま検証されてしまう）。
   * 書込みが実際に反映されたかは断定せず、再取得による照合結果のみで判定する。
   * 入出金額はrecordFeeSettlement/appendPendingを経由しない絶対値の上書きのため、
   * FeeSettlementsに新たな入金が発生したかのような行は作らない。
   */
  function writeAndVerifyBaseline_(bookingId, expected) {
    try {
      SpreadsheetRepository.updateBookingPriceBaselineAtomic(bookingId, {
        priceAmount: expected.priceAmount, priceTier: expected.priceTier, priceDayType: expected.priceDayType,
        priceIsMember: expected.priceIsMember, priceComputedAt: expected.priceComputedAt
      });
    } catch (writeError) {
      // 下の再取得検証に委ねる
    }
    try {
      SpreadsheetRepository.updateBookingRescheduleFeeAtomic(bookingId, {
        feePaidAmount: expected.feePaidAmount, feeRefundedAmount: expected.feeRefundedAmount
      });
    } catch (writeError2) {
      // 下の再取得検証に委ねる
    }
    var verifiedRecord = null;
    try {
      var reFound = SpreadsheetRepository.findRowByBookingId(bookingId);
      verifiedRecord = reFound ? reFound.record : null;
    } catch (verifyError) {
      verifiedRecord = null;
    }
    var matches = !!verifiedRecord &&
      verifiedRecord.priceAmount === expected.priceAmount &&
      verifiedRecord.priceTier === expected.priceTier &&
      verifiedRecord.priceDayType === expected.priceDayType &&
      verifiedRecord.priceIsMember === expected.priceIsMember &&
      isDate_(verifiedRecord.priceComputedAt) &&
      verifiedRecord.priceComputedAt.getTime() === expected.priceComputedAt.getTime() &&
      isSafeMoneyInteger_(Number(verifiedRecord.feePaidAmount)) && verifiedRecord.feePaidAmount !== '' &&
      Number(verifiedRecord.feePaidAmount) === expected.feePaidAmount &&
      isSafeMoneyInteger_(Number(verifiedRecord.feeRefundedAmount)) && verifiedRecord.feeRefundedAmount !== '' &&
      Number(verifiedRecord.feeRefundedAmount) === expected.feeRefundedAmount;
    return { matches: matches, verifiedRecord: verifiedRecord };
  }

  /*
   * 確認根拠（note）と確認した7項目をRecoveryへBASELINE_PRICE_CONFIRMED（INFO）として記録し、
   * 読み戻して保存を確認できた場合のみtrueを返す（完了条件C）。appendRowの応答は信頼しない。
   * errorMessageには確認時刻（priceComputedAt）を含めて一意にし、完全一致で照合する。
   */
  function recordBaselineConfirmation_(bookingId, record, expected, note, source) {
    var message = '基準料金確認（' + source + '）: priceTier=' + expected.priceTier + ', amount=' + expected.priceAmount +
      '円, 確認済み支払済み額=' + expected.feePaidAmount + '円, 確認済み返金済み額=' + expected.feeRefundedAmount +
      '円, 確認時刻=' + expected.priceComputedAt.toISOString() + '。確認根拠: ' + note.trim().slice(0, 400);
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId, failureType: BASELINE_PRICE_CONFIRMED_TYPE_, occurredAt: new Date(),
        calendarEventId: record.calendarEventId || '', status: record.status,
        errorMessage: message, recoveryState: 'INFO', resolvedAt: ''
      });
    } catch (auditError) {
      // 下の読み戻しで確認する
    }
    try {
      return RecoveryRepository.hasRecord(bookingId, BASELINE_PRICE_CONFIRMED_TYPE_, message);
    } catch (readError) {
      return false;
    }
  }

  var BASELINE_PRICE_CONFIRMED_TYPE_ = 'BASELINE_PRICE_CONFIRMED';

  /*
   * 7項目の照合と確認根拠の監査記録がともに確認できた後にのみ、書込み前に確保した
   * Recovery intent（BASELINE_WRITE_UNCERTAIN）を解消する。解消できなければ要復旧のまま
   * 維持する（同じ内容でresolveBaselinePriceRecoveryを再実行すれば、書込みは絶対値の
   * 上書き・監査行は追記のため安全に完了できる）。
   */
  function resolveBaselineIntent_(bookingId) {
    try {
      RecoveryRepository.resolveBaselineRecovery(bookingId);
    } catch (resolveError) {
      return error_('RECOVERY_UPDATE_FAILED', '基準料金・入出金額・確認根拠は保存できましたが、要復旧状態の解消に失敗しました。同じ内容でresolveBaselinePriceRecoveryを実行してください（書込みは絶対値の上書きのため安全です）。');
    }
    if (isBaselineRecoveryBlocking_(bookingId)) {
      return error_('RECOVERY_UPDATE_FAILED', '基準料金・入出金額・確認根拠は保存できましたが、要復旧状態の解消を確認できません。同じ内容でresolveBaselinePriceRecoveryを実行してください。');
    }
    return null;
  }

  var AUDIT_UNCONFIRMED_MESSAGE_ = '基準料金と確認済み入出金額は保存できましたが、確認根拠の監査記録を確認できません。' +
    '処理は完了していません（要復旧のまま操作をブロックします）。同じ内容と確認根拠でresolveBaselinePriceRecoveryを実行し、記録を完了してください。';

  /*
   * Issue #344追記: 元の確定料金・価格区分（会員/通常）を管理者が照合して入力する
   * （既存予約は金額が未記録のため必須）。何度でも呼び直して補正できる。日程変更そのものは
   * 行わない。PR #343の料金基盤（priceAmount/priceTier/priceDayType/priceIsMember/
   * priceComputedAt）をそのまま書き込む（日程変更専用の列は持たない）。
   *
   * 再レビュー対応（9回目。全体設計レビューで8回目の多段フォールバックを置き換え）:
   * - 入力値の静的検証（tier・正の整数円・根拠メモ）を済ませてからLockを取得し、
   *   isBlockedForFeeRecovery_（feeRecoveryRequiredAtの有無、FeeSettlementsの未確定
   *   精算の有無、Recovery OPENの有無のいずれか）で予約を再取得・再判定する。
   * - **基準料金5列に一切触れる前に、必ずRecoveryへOPENなintent行を先に記録し、
   *   その永続化をhasOpenBaselineRecoveryで読み戻して確認する。** intentの記録・確認に
   *   失敗した場合は、危険な書込みそのものを一切開始せずBookingsを変更しないまま
   *   中止する（8回目にあった「書込み失敗後にRecoveryへ記録し、それも失敗したら
   *   Script Propertiesへ退避する」という事後対応の多段フォールバックは、想定される
   *   障害の組合せが際限なく増えるため廃止した）。
   * - intentの確認ができた後にのみ、1回のRange.setValuesでまとめて書き込む
   *   updateBookingPriceBaselineAtomic（SpreadsheetRepository.gs）を呼ぶ。書込みが
   *   例外を投げた場合、または再取得した5列が期待値と一致しない場合は、
   *   feeRecoveryRequiredAtの設定をbest effortで試みつつ、既に確保済みのRecovery
   *   OPENをそのまま残す（＝isBlockedForFeeRecovery_が確実にブロックし続ける）。
   * - 書込み・検証に成功した場合は、確保しておいたRecovery intentをRESOLVEDにする。
   *   この解消自体に失敗した場合もOPENを残し、要復旧のまま維持する（同じ内容で
   *   resolveBaselinePriceRecoveryを再実行すれば、書込みは絶対値の上書きなので
   *   安全に解消できる）。
   *
   * 完了条件C（PR #345再レビュー対応・9回目）: 既存予約は`feePaidAmount`/
   * `feeRefundedAmount`も未記録（空文字）であり、`feeBaseline_`は空欄を0円として扱う。
   * 「入出金の確認が済んでいて実際に0円だった」のか「単に未確認で記録が無いだけ」なのかを
   * 区別できないと、初回の日程変更でこの空欄をそのまま「未返金額0円」として扱ってしまい、
   * 本来自動算出されるべき返金候補が常に0円に潰れる（＝正しく計算できない）。
   * `confirmedPaidAmount`（必須）・`confirmedRefundedAmount`（任意。省略時は0円＝
   * 「まだ何も返金していないことを確認した」の意味）で、管理者が実際に確認した入出金の
   * 累計額をこの基準料金確定と同じタイミング・同じLock内で記録する
   * （`updateBookingRescheduleFeeAtomic`による絶対値の上書き。`recordFeeSettlement`は
   * 経由しないため、`FeeSettlements`に新たな入金が発生したかのような行は作らない）。
   * 確認根拠（`note`）は検証するだけで捨てず、`RecoveryRepository`へ
   * `BASELINE_PRICE_CONFIRMED`として監査ログに残す（誰が・いつ・どの金額を確認したかを
   * 追跡できるようにする）。監査行は読み戻して保存を確認し、確認できるまでは
   * Recovery intentを解消せず処理を完了扱いにしない（`AUDIT_RECORD_UNCONFIRMED`。
   * 保存済みの基準料金・入出金額は取り消さず、resolveBaselinePriceRecoveryで記録を
   * 再試行する）。
   */
  function backfillOriginalPrice(bookingId, priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount) {
    var validation = validateBaselineInput_(priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount);
    if (validation.error) return validation.error;
    var normalizedRefunded = validation.confirmedRefundedAmount;

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
      var record = found.record;
      if (record.status !== Booking.STATUS.CONFIRMED) {
        return error_('INVALID_STATUS', '確定済みの予約のみ基準料金を設定できます。');
      }
      if (isBlockedForFeeRecovery_(bookingId, record)) {
        return error_('FEE_RECOVERY_REQUIRED', 'この予約は料金の整合性確認が必要な状態です。resolveFeeRecoveryで解消してから操作してください。');
      }
      var timezone = BookingConfig.getAvailabilityConfig().timezone;
      var dateString = dateStringOf_(record.date, timezone);
      var dayTypeResult = FeeCalculator.resolveDayType(dateString);
      if (!dayTypeResult.ok) {
        return error_(dayTypeResult.error.code, dayTypeResult.error.message);
      }

      // 危険な基準料金5列の書込みを始める前に、Recovery intentを先に確保・確認する。
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: RecoveryRepository.BASELINE_WRITE_UNCERTAIN_FAILURE_TYPE,
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId || '',
          status: record.status,
          errorMessage: '基準料金5列・確認済み入出金額の書込みを開始しました（priceTier=' + priceTier + ', amount=' + amount + '円）。' +
            'この行がRESOLVEDにならないまま残っている場合、実際の書込み結果または確認根拠の記録が未完了であることを示します。',
          recoveryState: 'OPEN', resolvedAt: ''
        });
      } catch (intentError) {
        /* 下のhasOpenBaselineRecoveryで確認する。ここでは無視する。 */
      }
      if (!RecoveryRepository.hasOpenBaselineRecovery(bookingId)) {
        // intentの記録自体を確認できない場合は、Bookingsを一切変更せずに中止する。
        return error_('RECOVERY_INTENT_UNCONFIRMED', '復旧記録の準備に失敗したため、基準料金の更新を中止しました。Bookingsは変更していません。もう一度実行してください。');
      }

      var expected = {
        priceAmount: amount, priceTier: priceTier, priceDayType: dayTypeResult.dayType,
        priceIsMember: priceTier === 'MEMBER', priceComputedAt: new Date(),
        feePaidAmount: confirmedPaidAmount, feeRefundedAmount: normalizedRefunded
      };
      var written = writeAndVerifyBaseline_(bookingId, expected);
      if (!written.matches) {
        try {
          SpreadsheetRepository.updateBookingFields(bookingId, {
            feeRecoveryRequiredAt: new Date(),
            feeRecoveryReason: '基準料金または確認済み入出金額の保存結果が確認できません。Bookingsを直接確認し、resolveBaselinePriceRecoveryで復旧してから操作してください。'
          });
        } catch (flagError) {
          logFailure_(bookingId, 'RESCHEDULE_FEE_RECOVERY_FLAG_FAILED', record.status);
        }
        return error_('BASELINE_RECOVERY_REQUIRED', '基準料金または確認済み入出金額の保存結果が確認できません。台帳を確認し、resolveBaselinePriceRecoveryで復旧してから再度実行してください。');
      }

      // 確認根拠の監査記録を確認できるまでは完了扱いにしない（完了条件C）。記録できなければ
      // intentをOPENのまま残し、resolveBaselinePriceRecoveryで記録を再試行できるようにする
      // （保存済みの基準料金・入出金額は取り消さない）。
      if (!recordBaselineConfirmation_(bookingId, record, expected, note, '登録')) {
        return error_('AUDIT_RECORD_UNCONFIRMED', AUDIT_UNCONFIRMED_MESSAGE_);
      }
      var resolveError = resolveBaselineIntent_(bookingId);
      if (resolveError) return resolveError;
      return { success: true, bookingId: bookingId, priceTier: priceTier, amount: amount, confirmedPaidAmount: confirmedPaidAmount, confirmedRefundedAmount: normalizedRefunded };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * 基準料金5列・確認済み入出金額（feePaidAmount/feeRefundedAmount）の書込み結果、または
   * 確認根拠の監査記録が未完了のまま残った予約専用の復旧パス（PR #345再レビュー対応・
   * 8回目/9回目/完了条件A・C）。resolveFeeRecoveryのcorrections（priceOverrideAmount等、
   * 日程変更に伴う「現在の確定金額」用のBookings列）を基準料金の復旧に代用しない。
   *
   * backfillOriginalPriceは基準料金5列と入出金額2列を別々のRangeへ書き込むため、
   * 片方だけが保存された状態が起こり得る。基準料金5列だけを照合してRecoveryを解消すると、
   * 入出金額が未反映（例: 空欄＝0円扱い）のまま通常操作を再開でき、次回の日程変更で
   * 返金候補が誤って計算される。そのためこの復旧でも、管理者が照合した価格区分・金額に
   * 加えて確認済み支払済み額・返金済み額と確認根拠を必須とし、Lock下で7項目を
   * 再書込み（絶対値の上書き）・再取得して全項目の一致を確認し、さらに確認根拠の
   * 監査記録を読み戻して確認できた場合にのみRecoveryのOPEN行を解消する。いずれかが
   * 確認できなければ要復旧のまま維持し、同じ内容でもう一度実行するよう促す。
   */
  function resolveBaselinePriceRecovery(bookingId, priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount) {
    var validation = validateBaselineInput_(priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount);
    if (validation.error) return validation.error;
    var normalizedRefunded = validation.confirmedRefundedAmount;

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
      var record = found.record;
      if (record.status !== Booking.STATUS.CONFIRMED) {
        return error_('INVALID_STATUS', '確定済みの予約のみ基準料金を設定できます。');
      }
      if (!isBaselineRecoveryBlocking_(bookingId)) {
        return error_('NOT_IN_RECOVERY', 'この予約に基準料金の要復旧はありません。');
      }
      var timezone = BookingConfig.getAvailabilityConfig().timezone;
      var dateString = dateStringOf_(record.date, timezone);
      var dayTypeResult = FeeCalculator.resolveDayType(dateString);
      if (!dayTypeResult.ok) {
        return error_(dayTypeResult.error.code, dayTypeResult.error.message);
      }
      var expected = {
        priceAmount: amount, priceTier: priceTier, priceDayType: dayTypeResult.dayType,
        priceIsMember: priceTier === 'MEMBER', priceComputedAt: new Date(),
        feePaidAmount: confirmedPaidAmount, feeRefundedAmount: normalizedRefunded
      };
      var written = writeAndVerifyBaseline_(bookingId, expected);
      if (!written.matches) {
        return error_('UPDATE_FAILED', '基準料金または確認済み入出金額の復旧結果が確認できません。要復旧のまま維持します。同じ内容でもう一度実行してください。');
      }
      if (!recordBaselineConfirmation_(bookingId, record, expected, note, '復旧')) {
        return error_('AUDIT_RECORD_UNCONFIRMED', '基準料金と確認済み入出金額は復旧できましたが、確認根拠の監査記録を確認できません。要復旧のまま維持します。同じ内容でもう一度実行してください。');
      }
      var resolveError = resolveBaselineIntent_(bookingId);
      if (resolveError) return resolveError;
      // 基準料金の要復旧が唯一の原因でfeeRecoveryRequiredAtが立っていた場合は、
      // ここで合わせてクリアする（best effort）。他にまだ未確定の精算が残っている場合は
      // 触らない（そちらはresolveFeeRecoveryで解消する）。失敗してもここでは
      // エラーにしない（Recovery・停止マーカーは既に解消済みで、7項目と確認根拠の
      // 整合性は確認済みのため）。
      if (isInFeeRecovery_(written.verifiedRecord) && !FeeSettlementRepository.hasUnresolvedSettlement(bookingId, null)) {
        try {
          SpreadsheetRepository.updateBookingFields(bookingId, { feeRecoveryRequiredAt: '', feeRecoveryReason: '' });
        } catch (flagClearError) {
          logFailure_(bookingId, 'RESCHEDULE_FEE_RECOVERY_FLAG_FAILED', record.status);
        }
      }
      return { success: true, bookingId: bookingId, priceTier: priceTier, amount: amount, confirmedPaidAmount: confirmedPaidAmount, confirmedRefundedAmount: normalizedRefunded };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * previewが表示した料金算出結果と、commit確定直前に再計算した結果が食い違っていないかを
   * 照合するためのトークン（PR #345再レビュー対応・9回目、完了条件B）。
   * BookingPricing.gsの料金表はコードに焼き込まれた定数だが、「previewからcommitまでの
   * 間にコードのデプロイが切り替わる」「日付が変わって適用日・キャンセル規定の判定が
   * 変わる」といった可能性までは排除できない。暗号学的なハッシュではなく、preview時点の
   * 料金・基準料金・価格区分・適用日・返金判定等をそのままJSON化した文字列を、
   * commit側で同じ入力から再計算した結果と厳密一致で比較するだけで十分
   * （秘匿性は不要。改ざん検知ではなく「同じ状況か」の確認が目的）。
   */
  function buildFeeQuoteToken_(feeCtx) {
    var payload = {
      feeReady: feeCtx.ready,
      feeStatus: feeCtx.status,
      priceTier: feeCtx.baseline.priceTier,
      oldFeeAmount: feeCtx.baseline.oldAmount,
      scheduleChangeCount: feeCtx.baseline.scheduleChangeCount
    };
    if (feeCtx.ready) {
      payload.newFeeAmount = feeCtx.quote.amount;
      payload.dayType = feeCtx.quote.dayType;
      payload.roundedMinutes = feeCtx.quote.roundedMinutes;
      payload.feeDifference = feeCtx.assessment.feeDifference;
      payload.refundStatus = feeCtx.assessment.refundStatus;
      payload.refundCandidateAmount = feeCtx.assessment.refundCandidateAmount;
      payload.cancellationPolicyCategory = feeCtx.cancellationCategory;
    }
    return JSON.stringify(payload);
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
      result.feeQuoteToken = buildFeeQuoteToken_(feeCtx);
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
   *
   * 完了条件B（PR #345再レビュー対応・9回目）: expectedFeeQuoteTokenが指定された場合、
   * previewが返したfeeQuoteToken（buildFeeQuoteToken_参照）と、ここで再計算した結果から
   * 作った同じトークンを比較する。不一致であれば、履歴・Calendar・Bookingsのいずれにも
   * 触れる前に再プレビューを要求して拒否する（previewからcommitまでの間にコードの
   * デプロイが切り替わる、日付が変わって適用日・キャンセル規定の判定が変わる、といった
   * 事態を検出するため）。トークンはサーバー側でも必須とし、省略された場合（未指定・
   * 空文字・文字列以外）は照合をスキップせずFEE_QUOTE_TOKEN_REQUIREDで拒否する
   * （管理画面以外の呼び出し経路からpreviewを経ずに確定されることを防ぐ）。
   */
  function commit(bookingId, input, expectedVersion, reason, feeNote, feeConfirmation, expectedFeeQuoteToken) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    var outcome;
    try {
      var check = parse_(bookingId, input, expectedVersion, new Date());
      if (!check.success) return check;
      var record = check.record;
      if (isBlockedForFeeRecovery_(bookingId, record)) {
        return error_('FEE_RECOVERY_REQUIRED', 'この予約は料金の整合性確認が必要な状態です。resolveFeeRecoveryで解消してから操作してください。');
      }
      var today = BookingAvailability.formatDateInTimezone(new Date(), check.timezone);
      var feeCtx = computeFeeContext_(record, check.durationMinutes, check.date, today, check.timezone);
      if (typeof expectedFeeQuoteToken !== 'string' || !expectedFeeQuoteToken) {
        return error_('FEE_QUOTE_TOKEN_REQUIRED', 'プレビューで確認した料金情報が指定されていません。プレビューを取得し、表示された内容を確認してから確定してください。');
      }
      if (buildFeeQuoteToken_(feeCtx) !== expectedFeeQuoteToken) {
        return error_('FEE_QUOTE_MISMATCH', 'プレビュー時点の料金情報が古くなっています。再度プレビューを取得し、表示された内容を確認してから確定してください。');
      }
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

      /* 再レビュー対応（必須修正3）: 料金更新が失敗した変更は、通知メールに確定した
         料金・返金情報を載せない（feeDetailsJson.feeConfirmed=falseとしてsendMail側へ
         伝える。BookingChangesの列構成は変えず、append時点で確定していなかった
         「料金が実際に確定したか」だけをここで確定させて書き戻す）。 */
      feeDetails.feeConfirmed = !feeUpdateFailed;
      try {
        sheet.getRange(rowNumber, 12).setValue('PENDING');
        sheet.getRange(rowNumber, HISTORY_HEADERS_.indexOf('feeDetailsJson') + 1).setValue(JSON.stringify(feeDetails));
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

  /* feeDetailsJson（最終列）を安全にパースする。壊れている/古い形式（feeConfirmedが
     無い）行はfeeConfirmed:trueとして扱う（再レビュー対応前に確定した既存行の挙動を
     変えないため）。 */
  function parseFeeDetails_(row) {
    try {
      var parsed = JSON.parse(row[row.length - 1]);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function feeSummaryLines_(row) {
    var oldFee = row[14];
    var newFee = row[15];
    var diff = row[16];
    var refundStatus = row[18];
    var refundCandidate = row[19];
    var refundApproved = row[20];
    if (!isFiniteNumber_(oldFee) || !isFiniteNumber_(newFee)) return [];
    /* 再レビュー対応（必須修正3）: 日時更新後の料金・変更回数・精算状態の更新が失敗した
       変更は、金額・返金状況が台帳に正しく反映されているか確認できていないため、確定
       したかのような文言を利用者へ送らない。 */
    if (parseFeeDetails_(row).feeConfirmed === false) {
      return ['料金の確定処理は現在確認中です。確定次第、運営から別途ご案内します。'];
    }
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
    if (!isSafeMoneyInteger_(paidDelta) || paidDelta < 0 || !isSafeMoneyInteger_(refundedDelta) || refundedDelta < 0) {
      return error_('INVALID_AMOUNT', '入出金額は0以上の整数（円単位）で指定してください。');
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
      if (isInFeeRecovery_(found.record)) {
        return error_('FEE_RECOVERY_REQUIRED', 'この予約は料金の整合性確認が必要な状態です。resolveFeeRecoveryで解消してから精算を記録してください。');
      }
      // 基準料金5列の書込み結果が不明なまま残っている場合も、feeRecoveryRequiredAtの
      // 保存自体が失敗していれば見た目上はブロックされない。Recovery/停止マーカーの
      // どちらかが残っていれば拒否する（PR #345再レビュー対応・8回目）。
      if (isBaselineRecoveryBlocking_(bookingId)) {
        return error_('FEE_RECOVERY_REQUIRED', 'この予約は基準料金の整合性確認が必要な状態です。resolveBaselinePriceRecoveryで解消してから精算を記録してください。');
      }
      // feeRecoveryRequiredAtの保存自体が失敗する複合障害が起きると、フラグが立たない
      // まま未確定の精算だけが残ることがある。今回のsettlementId以外にまだ「反映済み／
      // 未反映」を確定していない精算が残っている場合は、フラグの有無によらずここで
      // 拒否する（PR #345再レビュー対応・3回目。この精算ID自身の再送は除外し、下の
      // 既存ロジックにそのまま処理させる）。
      if (FeeSettlementRepository.hasUnresolvedSettlement(bookingId, settlementId)) {
        return error_('FEE_RECOVERY_REQUIRED', 'この予約には確認が完了していない別の精算IDが残っています。resolveFeeRecoveryで解消してから精算を記録してください。');
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
        if (existing.record.applyStatus === 'ABANDONED') {
          // 管理者がresolveFeeRecoveryで「この精算IDは未反映」と確認・確定した後の再送。
          // 同じ行を使って初めて適用する。ただし、確定から今回の再送までの間に別の
          // 精算が記録され、未返金額が変わっている可能性があるため、新規精算と
          // 同じ金額整合性チェック（安全な整数・返金済み<=支払済み）を必ず通す
          // （PR #345再レビュー対応）。
          var abandonedArithmetic = validateSettlementArithmetic_(found.record, paidDelta, refundedDelta);
          if (!abandonedArithmetic.ok) {
            return error_(abandonedArithmetic.code, abandonedArithmetic.message);
          }
          // ABANDONEDのまま直接適用を試みると、Bookingsへの書き込みに成功した直後に
          // markApplied自体が失敗する複合障害で、この行がABANDONEDのまま（＝「未反映」に
          // 見えたまま）残ってしまい、次の再送が再びここに入って二重加算しかねない
          // （PR #345再レビュー対応・3回目）。適用を試みる前に必ずPENDING_APPLYへ
          // 戻しておけば、以降どこで失敗しても既存のPENDING_APPLY処理（無条件の自動
          // 再試行を禁止しFAILED_NEEDS_RECOVERYへ倒す）がそのまま安全に働く。
          try {
            FeeSettlementRepository.markPendingApply(existing.rowNumber);
          } catch (e) {
            return error_('SETTLEMENT_UPDATE_FAILED', '精算履歴の更新に失敗しました。Bookingsは更新していません。');
          }
          return applySettlement_(found, existing.rowNumber, settlementState, paidDelta, refundedDelta, note);
        }
        // PENDING_APPLY: Bookingsへの反映結果が確定していない（前回、Bookings書き込み後に
        // 状態遷移の記録自体が失敗した可能性がある。PR #345再レビュー対応）。反映済みかどうか
        // 確認せずに再適用すると二重加算の恐れがあるため、絶対に自動再試行しない。
        try { FeeSettlementRepository.markFailedNeedsRecovery(existing.rowNumber); } catch (e) { /* best effort */ }
        try {
          SpreadsheetRepository.updateBookingFields(bookingId, {
            feeRecoveryRequiredAt: new Date(),
            feeRecoveryReason: '精算ID「' + settlementId + '」が反映済みかどうか確定できない状態で中断されました。実際の入出金とBookingsの累計額を確認し、resolveFeeRecoveryでこの精算IDの状態（反映済み／未反映）を確定してください。'
          });
        } catch (flagError) {
          logFailure_(bookingId, 'RESCHEDULE_FEE_RECOVERY_FLAG_FAILED', found.record.status);
        }
        return error_('SETTLEMENT_RECOVERY_REQUIRED', 'この精算IDは前回の処理が中断され、反映済みかどうか確定できません。台帳とFeeSettlementsシートを確認し、resolveFeeRecoveryで復旧してから再度実行してください。');
      }

      var newSettlementArithmetic = validateSettlementArithmetic_(found.record, paidDelta, refundedDelta);
      if (!newSettlementArithmetic.ok) {
        return error_(newSettlementArithmetic.code, newSettlementArithmetic.message);
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
    /* 呼び出し元（recordFeeSettlement）で既に検証済みのはずだが、書込み直前にも
       同じ基準で再検証する（PR #345再レビュー対応・7回目。将来的にこの関数が
       recordFeeSettlement以外から呼ばれても、Bookingsへ壊れた金額を書き込まない
       ための防御）。失敗時はappendPending／markPendingApplyで既に作られた
       PENDING_APPLY行を残したまま、Bookingsには一切書き込まない。 */
    var arithmetic = validateSettlementArithmetic_(record, paidDelta, refundedDelta);
    if (!arithmetic.ok) {
      return error_(arithmetic.code, arithmetic.message);
    }
    var newPaid = arithmetic.newPaid;
    var newRefunded = arithmetic.newRefunded;
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
   * Issue #344追記（PR #345レビュー対応。再レビュー対応でsettlementResolutionを追加）:
   * commit/recordFeeSettlementの部分失敗でfeeRecoveryRequiredAtが立った予約を、管理者が
   * 実際の台帳・Calendar・FeeSettlementsを確認したうえで復旧する。correctionsに指定した
   * フィールドだけを上書きし、それ以外は現在値を維持する（既存の
   * paymentLinkMetadataInconsistentAt系の補正関数と同じ設計）。
   *
   * settlementResolution（任意）: { settlementId, outcome }。要復旧の原因が特定の
   * FeeSettlements行（PENDING_APPLY/FAILED_NEEDS_RECOVERY）にある場合、管理者が実際の
   * 入出金・Bookingsの累計額を照合して確認した結果をここで確定する
   * （再レビュー対応「復旧処理がFeeSettlementsの状態を解消しない」への対応。Bookings側の
   * 数値だけ補正してFeeSettlements側を放置すると、その精算IDが二度と使えなくなる、
   * または将来同じIDが再送されたときの扱いが不定になる）。
   * - outcome: 'CONFIRMED_APPLIED'（実際にBookingsへ反映済みだったと確認した）。
   *   corrections.feePaidAmount/feeRefundedAmountが必須（確認した反映後の累計額を
   *   そのままFeeSettlements側のresult*にも記録する）。
   * - outcome: 'CONFIRMED_NOT_APPLIED'（実際にはBookingsへ反映されていなかったと確認した）。
   *   FeeSettlements行をABANDONEDにし、同じsettlementIdでの再送を今後は初めての適用として
   *   扱えるようにする。
   * FeeSettlementsの更新はBookings側の更新より先に行い、それが失敗した場合はBookingsを
   * 一切書き換えずに返す（部分的な復旧状態を作らない）。
   *
   * 再レビュー対応（2回目）:
   * - 全体をLockで保護する。resolveFeeRecoveryとrecordFeeSettlement/commitが並行実行され、
   *   復旧の途中経過を他の処理が読んでしまうことを防ぐ。
   * - FeeSettlementsの確定（markApplied/markAbandoned）に成功した直後、Bookings側の
   *   atomic更新が失敗した場合はfeeRecoveryRequiredAtを維持したまま（＝ブロック状態を
   *   保ったまま）エラーを返す。corrections/settlementResolutionが同じ内容である限り、
   *   Bookings側のatomic更新は絶対値での上書きであり、markApplied/markAbandonedも
   *   同じ内容の再実行なら冪等なため、同じ呼び出しを再実行すれば安全に両方が揃う。
   * - 指定したsettlementIdを確定した後、この予約に他にもまだ「反映済み／未反映」を
   *   確定していない精算（PENDING_APPLY/FAILED_NEEDS_RECOVERY）が残っている場合は、
   *   Bookings側の復旧（feeRecoveryRequiredAtの解除）を完了させない。これを許すと、
   *   見落とした精算が実際にBookingsへ反映されているかどうか不明なまま復旧完了と
   *   見なしてしまい、後から見落としたsettlementIdが再送されたときに「反映済み」を
   *   騙って（あるいは未反映のまま）台帳とBookingsの不一致を隠してしまう。1回の呼び出しで
   *   確定できるのは1件のsettlementIdのみなので、複数残っている場合は1件ずつ確定し、
   *   最後の1件を確定した呼び出しでBookingsの復旧が完了する。
   *
   * 再レビュー対応（4回目）:
   * - feeRecoveryRequiredAtの保存自体が失敗する複合障害が起きると、フラグが立たない
   *   まま未確定の精算（PENDING_APPLY/FAILED_NEEDS_RECOVERY）だけが残ることがある。
   *   commit/recordFeeSettlementはisBlockedForFeeRecovery_によりフラグの有無に
   *   かかわらずこの状態をブロックするが、resolveFeeRecovery側がisInFeeRecovery_
   *   だけで「復旧対象かどうか」を判定していると、admin自身がNOT_IN_RECOVERYで
   *   弾かれてしまい、誰も復旧できなくなる（ブロックされているのに復旧手段がない
   *   デッドロック）。そのためresolveFeeRecoveryへの入り口も、isInFeeRecovery_に加えて
   *   FeeSettlementRepository.hasUnresolvedSettlementを確認し、どちらか一方でも
   *   真であれば復旧対象として受け付ける。
   */
  function resolveFeeRecovery(bookingId, corrections, settlementResolution) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) return error_('NOT_FOUND', '予約が見つかりません。');
      // 判定はisBlockedForFeeRecovery_と同じ基準（フラグ／未確定精算／基準料金の
      // 停止条件のいずれか）に統一する（PR #345再レビュー対応・8回目）。
      if (!isBlockedForFeeRecovery_(bookingId, found.record)) {
        return error_('NOT_IN_RECOVERY', 'この予約は要復旧の状態ではありません。');
      }
      corrections = corrections || {};

      var settlementRow = null;
      var settlementId = null;
      if (settlementResolution) {
        settlementId = settlementResolution.settlementId;
        var outcome = settlementResolution.outcome;
        if (typeof settlementId !== 'string' || !settlementId.trim()) {
          return error_('SETTLEMENT_ID_REQUIRED', '精算IDを指定してください。');
        }
        if (outcome !== 'CONFIRMED_APPLIED' && outcome !== 'CONFIRMED_NOT_APPLIED') {
          return error_('INVALID_SETTLEMENT_OUTCOME', 'settlementResolution.outcomeはCONFIRMED_APPLIED/CONFIRMED_NOT_APPLIEDのいずれかで指定してください。');
        }
        settlementRow = FeeSettlementRepository.findBySettlementId(settlementId);
        if (!settlementRow || settlementRow.record.bookingId !== bookingId) {
          return error_('SETTLEMENT_NOT_FOUND', '指定した精算IDがこの予約に見つかりません。');
        }
        if (outcome === 'CONFIRMED_APPLIED' &&
            (corrections.feePaidAmount === undefined || corrections.feeRefundedAmount === undefined)) {
          return error_('INVALID_AMOUNT', 'この精算を「反映済み」として確定するには、支払済み額・返金済み額の両方を指定してください。');
        }
        /*
         * 再レビュー対応（5回目）: settlementResolutionは「反映結果が確定していない
         * （PENDING_APPLY/FAILED_NEEDS_RECOVERY）」精算を確定するためのものであり、
         * 既に確定済み（APPLIED/ABANDONED）の精算を反対の結果へ書き換える手段では
         * ない。既にAPPLIEDの精算をCONFIRMED_NOT_APPLIEDでABANDONEDに書き換えられると、
         * その後の同一settlementIdの再送がABANDONED分岐から「初めての適用」として
         * 再加算し、二重計上になる（ABANDONEDをCONFIRMED_APPLIEDで戻す場合も同様に
         * 危険）。ただし「FeeSettlementsの確定には成功したがBookingsのatomic更新が
         * 失敗し、同じ内容でresolveFeeRecoveryを再実行する」既存の復旧経路は、
         * 直前の呼び出しで既にAPPLIED/ABANDONEDへ遷移済みの状態から再送されるため、
         * 同一outcome・同一確定値の冪等な再実行だけは許可する。
         */
        if (settlementRow.record.applyStatus === 'APPLIED') {
          var sameApplied = outcome === 'CONFIRMED_APPLIED' &&
            Number(settlementRow.record.resultPaidAmount) === Number(corrections.feePaidAmount) &&
            Number(settlementRow.record.resultRefundedAmount) === Number(corrections.feeRefundedAmount);
          if (!sameApplied) {
            return error_('SETTLEMENT_STATE_MISMATCH', 'この精算IDは既に「反映済み」として確定されています。異なる確定結果へは変更できません。内容に誤りがある場合はFeeSettlementsシートを直接確認し、手動で照合してください。');
          }
        } else if (settlementRow.record.applyStatus === 'ABANDONED') {
          if (outcome !== 'CONFIRMED_NOT_APPLIED') {
            return error_('SETTLEMENT_STATE_MISMATCH', 'この精算IDは既に「未反映」として確定されています。異なる確定結果へは変更できません。内容に誤りがある場合はFeeSettlementsシートを直接確認し、手動で照合してください。');
          }
        }
      }

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
        if (!isSafeMoneyInteger_(corrections.feePaidAmount) || corrections.feePaidAmount < 0) {
          return error_('INVALID_AMOUNT', '支払済み額は0以上の整数（円単位）で指定してください。');
        }
        fields.feePaidAmount = corrections.feePaidAmount;
      }
      if (corrections.feeRefundedAmount !== undefined) {
        if (!isSafeMoneyInteger_(corrections.feeRefundedAmount) || corrections.feeRefundedAmount < 0) {
          return error_('INVALID_AMOUNT', '返金済み額は0以上の整数（円単位）で指定してください。');
        }
        fields.feeRefundedAmount = corrections.feeRefundedAmount;
      }
      /*
       * 再レビュー対応（6回目）: feePaidAmount/feeRefundedAmountはそれぞれ単独では
       * 「0以上の整数」として妥当でも、両者の関係（返金済み額は支払済み額を超えては
       * いけない）は検証していなかった。指定されなかった項目は現在のBookingsの値を
       * そのまま使う（updateBookingRescheduleFeeAtomicの挙動と同じ）ため、復旧後に
       * 実際にBookingsへ書き込まれる「最終的な累計額」を組み立てたうえで検証する。
       * CONFIRMED_APPLIEDの場合、corrections.feePaidAmount/feeRefundedAmountは
       * FeeSettlementsのresultPaidAmount/resultRefundedAmountにもそのまま記録される
       * ため、この検証は精算履歴側の整合性も同時に保証する。検証に失敗した場合は
       * Bookings・FeeSettlementsのどちらにも一切書き込まない（要復旧状態を維持する）。
       */
      var finalPaidAmount = corrections.feePaidAmount !== undefined
        ? corrections.feePaidAmount
        : (isFiniteNumber_(found.record.feePaidAmount) ? found.record.feePaidAmount : 0);
      var finalRefundedAmount = corrections.feeRefundedAmount !== undefined
        ? corrections.feeRefundedAmount
        : (isFiniteNumber_(found.record.feeRefundedAmount) ? found.record.feeRefundedAmount : 0);
      if (finalRefundedAmount > finalPaidAmount) {
        return error_('REFUND_EXCEEDS_PAID', '返金済み額（' + finalRefundedAmount + '円）が支払済み額（' + finalPaidAmount + '円）を超えています。支払済み額・返金済み額を見直してから復旧してください。');
      }
      if (settlementRow) {
        // FeeSettlementsの確定はBookingsの更新より先に行う。ここが失敗した場合はBookingsを
        // 一切書き換えず、feeRecoveryRequiredAtも維持する（部分的な復旧状態を作らない）。
        try {
          if (settlementResolution.outcome === 'CONFIRMED_APPLIED') {
            FeeSettlementRepository.markApplied(settlementRow.rowNumber, corrections.feePaidAmount, corrections.feeRefundedAmount);
          } else {
            FeeSettlementRepository.markAbandoned(settlementRow.rowNumber);
          }
        } catch (e) {
          return error_('SETTLEMENT_UPDATE_FAILED', '精算履歴の復旧に失敗しました。Bookingsは更新していません。');
        }
      }

      // 今回指定した精算は確定できたが、この予約に他にもまだ「反映済み／未反映」を
      // 確定していない精算、または基準料金の書込み結果が不明なまま残っている場合は、
      // Bookings側の復旧（feeRecoveryRequiredAtの解除）を完了させない（再レビュー対応。
      // 8回目：基準料金の復旧は専用のresolveBaselinePriceRecoveryで行う。ここの
      // corrections.priceOverrideAmount等では基準料金5列を代用しない）。指定した精算
      // 自体の確定は既に反映済みなので、残りの精算をsettlementResolutionで確定し、
      // 基準料金が未確定ならresolveBaselinePriceRecoveryで確定してから、最後にこの
      // 関数を呼べば復旧が完了する。
      if (FeeSettlementRepository.hasUnresolvedSettlement(bookingId, null) || isBaselineRecoveryBlocking_(bookingId)) {
        return error_('OTHER_SETTLEMENT_UNRESOLVED', settlementRow
          ? '指定した精算ID「' + settlementId + '」は確定しましたが、この予約には確認が完了していない別の精算ID、または基準料金の未確定がまだ残っています。残りの精算IDはsettlementResolutionで、基準料金はresolveBaselinePriceRecoveryで確定してから、最後にBookingsの復旧を完了してください。'
          : 'この予約には、確認が完了していない精算ID、または基準料金の未確定が残っています。settlementResolution／resolveBaselinePriceRecoveryでそれぞれ確定してから、Bookingsの復旧を完了してください。');
      }

      try {
        SpreadsheetRepository.updateBookingRescheduleFeeAtomic(bookingId, fields);
      } catch (e) {
        // 精算履歴側は既に確定済みの可能性があるが、Bookings側の復旧が完了するまでは
        // feeRecoveryRequiredAtを解除しない（＝ブロック状態を維持する）。この呼び出しを
        // 同じ内容で再実行すれば、精算履歴側は冪等に上書きされるだけなので安全に
        // やり直せる。
        return error_('UPDATE_FAILED', 'Bookingsの復旧保存に失敗しました（精算履歴側は既に更新済みの可能性があります）。予約は要復旧のままです。同じ内容でもう一度実行してください。');
      }
      return { success: true, bookingId: bookingId };
    } finally {
      lock.releaseLock();
    }
  }

  return {
    preview: preview, commit: commit, sendMail: sendMail, getChanges: getChanges,
    backfillOriginalPrice: backfillOriginalPrice, recordFeeSettlement: recordFeeSettlement,
    resolveFeeRecovery: resolveFeeRecovery, resolveBaselinePriceRecovery: resolveBaselinePriceRecovery,
    /* getAdminBookingDetail（BookingAdminWeb.gs）専用。基準料金5列の書込み結果が
       不明な予約かどうかを、feeRecoveryRequiredAtの有無とは独立に判定する
       （PR #345再レビュー対応・8回目）。 */
    isBaselineRecoveryBlocked: isBaselineRecoveryBlocking_
  };
})();

/* Booking Admin Web App専用のgoogle.script.run公開関数。 */
function adminPreviewBookingReschedule(bookingId, input, expectedVersion) {
  return BookingReschedule.preview(bookingId, input, expectedVersion);
}
function adminRescheduleBooking(bookingId, input, expectedVersion, reason, feeNote, feeConfirmation, expectedFeeQuoteToken) {
  return BookingReschedule.commit(bookingId, input, expectedVersion, reason, feeNote, feeConfirmation, expectedFeeQuoteToken);
}
function adminResendRescheduleMail(changeId) {
  return BookingReschedule.sendMail(changeId, true);
}
function adminGetBookingChanges(bookingId) {
  return BookingReschedule.getChanges(bookingId);
}
function adminBackfillOriginalPrice(bookingId, priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount) {
  return BookingReschedule.backfillOriginalPrice(bookingId, priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount);
}
function adminRecordRescheduleFeeSettlement(bookingId, changeId, settlementId, settlementState, paidAmountDelta, refundedAmountDelta, note) {
  return BookingReschedule.recordFeeSettlement(bookingId, changeId, settlementId, settlementState, paidAmountDelta, refundedAmountDelta, note);
}
function adminResolveFeeRecovery(bookingId, corrections, settlementResolution) {
  return BookingReschedule.resolveFeeRecovery(bookingId, corrections, settlementResolution);
}
function adminResolveBaselinePriceRecovery(bookingId, priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount) {
  return BookingReschedule.resolveBaselinePriceRecovery(bookingId, priceTier, amount, note, confirmedPaidAmount, confirmedRefundedAmount);
}
