/*
 * BookingRepository.gs — createBooking / confirmBooking / expirePendingBookingsの
 * オーケストレーション（Issue #268）。CalendarRepository・SpreadsheetRepository・
 * RecoveryRepository・RateLimiter・Bookingを組み合わせる、GAS実行環境依存の本体。
 *
 * このファイル自体は1つだが、実際にどの関数がどのGASプロジェクトから呼ばれるかは
 * プロジェクトによって異なる（README「GASプロジェクトへのデプロイ対象ファイル」参照）:
 * - createBooking: Booking Web Appプロジェクト（Code.gsのdoPostから）
 * - confirmBooking / expirePendingBookings / cancelBookingAdmin / updateBookingPrice:
 *   Booking Adminプロジェクト（BookingAdmin.gs / BookingTriggers.gsから。各関数とも同じ
 *   プロジェクト内で動くため、LockService.getScriptLock()を共有し、互いに直列化される。
 *   3回目レビューでconfirmBookingとexpirePendingBookingsを同一プロジェクトへ統合し、
 *   この2つの間のLock非共有によるCalendar/Sheets不整合の可能性を構造的に解消した。
 *   Issue #272でcancelBookingAdminも同じプロジェクト・同じLockServiceへ加えた。
 *   Issue #342で追加したupdateBookingPriceも同様（Calendar操作は行わないが、金額の
 *   読み取り→書き込みの一貫性のためLockを使う）。公開Web App側にはcancelBookingAdmin・
 *   updateBookingPriceのいずれも公開しない）
 *
 * createBookingの処理順（Issue #268本文どおり。Issue #342で料金計算を追加）:
 *   1. サーバー側入力検証        → Booking.validateCreateBookingInput
 *   2. 利用料金の自動計算        → BookingPricing.computeBookingPrice（Lockの外。
 *      副作用が一切ない時点で行うことで、失敗時にCalendar/Sheetsへ何も作らずに済む）
 *   3. abuse / rate limit確認    → RateLimiter.evaluate（Lockの外。ここで弾けばLock不要なため）
 *   4. LockService取得
 *   5. Calendarを最新状態で再取得 → CalendarRepository.getBusyIntervalsForDate
 *   6. 競合チェック              → BookingAvailability.isStartTimeBookable
 *   7. bookingId発行
 *   8. CalendarにPENDINGイベント作成
 *   9. Spreadsheet台帳へ保存（計算済みの料金を含む）
 *  10. Lock解除
 *  11. 管理者通知（Lockの外。通知失敗は予約失敗として扱わない）
 *
 * クリティカルセクション（Lockで保護する範囲）は5〜9のみ。入力検証・料金計算・
 * rate limit確認・通知はLockの外。
 *
 * 注意（README/PRにも明記）: LockServiceはこのGASプロジェクト内の同時実行同士の排他
 * だけを提供する。スペースマーケット側からの外部Calendar書き込みまではロックできない。
 * そのためLock取得後に必ずCalendarを再取得し、直前の空き状況を再確認してから
 * PENDINGイベントを作成する（「絶対に競合しない」ではなく「同一Calendarと直前再確認で
 * リスクを最小化する」設計）。この注意はcreateBooking（Booking Web App）対
 * スペースマーケット側の外部書き込みについてのみ当てはまる。confirmBooking対
 * expirePendingBookings（いずれもBooking Admin内）は同一LockServiceで直列化されるため、
 * この種の非同期な外部書き込みの問題は生じない。
 */
'use strict';

var BookingRepository = (function () {
  var LOCK_TIMEOUT_MS_ = 10000;
  var EXPIRE_LOCK_TIMEOUT_MS_ = 5000;

  function createBooking(rawInput, now, requestId) {
    now = isDateLike_(now) ? now : new Date();

    var availabilityConfig = BookingConfig.getAvailabilityConfig();
    var validation = Booking.validateCreateBookingInput(rawInput, availabilityConfig, now);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    var input = validation.normalized;

    /*
     * 利用料金の自動計算（Issue #342）。フロントエンドから金額が送られてきても一切
     * 信用せず、GAS側でBookingPricingを使って必ず再計算する（input.isMemberは
     * validateCreateBookingInputで既にfail-closed正規化済みの真偽値）。
     * Lock取得・Calendar/Sheets書き込みより前（副作用が一切ない時点）で行うことで、
     * 想定外の不整合（brand/date/durationMinutesはBooking.validateCreateBookingInputで
     * 既に検証済みのため通常は発生しない）で失敗した場合でもCalendarイベント等を
     * 一切作らずに済む。
     */
    var priceResult = BookingPricing.computeBookingPrice({
      brand: input.brand,
      date: input.date,
      durationMinutes: input.durationMinutes,
      isMember: input.isMember
    });
    if (!priceResult.valid) {
      return { success: false, error: priceResult.error };
    }

    var rateLimitConfig = BookingConfig.getRateLimitConfig();
    var rateLimitResult = RateLimiter.evaluate(input, rateLimitConfig, now.getTime());
    if (!rateLimitResult.allowed) {
      return {
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。',
          reason: rateLimitResult.reason
        }
      };
    }

    var calendarId = BookingConfig.getCalendarId();
    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return {
        success: false,
        error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' }
      };
    }

    var bookingId;
    var eventId;
    var record;
    try {
      var busyIntervals = CalendarRepository.getBusyIntervalsForDate(calendarId, input.date, availabilityConfig.timezone);
      var startMinutes = BookingAvailability.parseTimeToMinutes(input.startTime);
      var bookable = BookingAvailability.isStartTimeBookable(
        startMinutes,
        input.durationMinutes,
        busyIntervals,
        availabilityConfig.bufferMinutes
      );
      if (!bookable) {
        return {
          success: false,
          error: { code: 'SLOT_CONFLICT', message: '指定の時間帯はすでに埋まっています。空き状況を確認して再度お試しください。' }
        };
      }

      bookingId = Booking.generateBookingId(input.brand, input.date, Utilities.getUuid());

      eventId = CalendarRepository.createBookingEvent(calendarId, {
        date: input.date,
        startTime: input.startTime,
        durationMinutes: input.durationMinutes,
        timezone: availabilityConfig.timezone,
        bookingId: bookingId,
        brand: input.brand
      });

      var startAt = CalendarRepository.parseDateTime(input.date, input.startTime, availabilityConfig.timezone);
      var endAt = new Date(startAt.getTime() + input.durationMinutes * 60000);

      record = {
        bookingId: bookingId,
        createdAt: now,
        date: input.date,
        startAt: startAt,
        endAt: endAt,
        brand: input.brand,
        customerType: input.customerType,
        name: input.name,
        email: input.email,
        phone: input.phone,
        people: input.people,
        purpose: input.purpose,
        paymentMethod: input.paymentMethod,
        /* Issue #341でpaymentStatusの意味を転用。作成直後はカード・現地払いいずれも
           決済フロー未着手のためNOT_STARTED（カードのみPR-B以降でCHECKOUT_PENDING等へ
           遷移し得る。現地払いは以後もこの列を更新しない）。 */
        paymentStatus: Booking.PAYMENT_STATUS.NOT_STARTED,
        status: Booking.STATUS.PENDING,
        calendarEventId: eventId,
        source: input.source,
        note: input.note,
        priceAmount: priceResult.price.amount,
        priceTier: priceResult.price.tier,
        priceDayType: priceResult.price.dayType,
        priceIsMember: priceResult.price.isMember,
        priceComputedAt: now
      };

      try {
        SpreadsheetRepository.appendBooking(record);
      } catch (sheetsError) {
        return handleSheetsSaveFailure_(calendarId, bookingId, eventId, sheetsError, requestId, input);
      }
    } finally {
      lock.releaseLock();
    }

    /*
     * 利用者向けPENDINGメール・管理者通知はいずれもbooking Lockの外・best effortで行う
     * （Issue #271「11. createBookingへの接続」）。どちらかが失敗してもcreateBooking自体は
     * success:trueのまま返す。
     */
    notifyCustomerPendingBestEffort_(record);
    notifyAdminBestEffort_(record);

    return {
      success: true,
      bookingId: bookingId,
      status: Booking.STATUS.PENDING,
      date: input.date,
      startTime: input.startTime,
      durationMinutes: input.durationMinutes,
      brand: input.brand,
      people: input.people,
      paymentMethod: input.paymentMethod,
      /*
       * 仮予約完了画面（Issue #342）はこのpriceを使う。フォーム側が送信直前に取得した
       * 見積り値ではなく、GASがcreateBooking内で確定・保存した金額（record.priceAmount
       * と同じ値）を必ず返す。
       */
      price: {
        amount: priceResult.price.amount,
        currency: priceResult.price.currency,
        tier: priceResult.price.tier,
        isMember: priceResult.price.isMember,
        dayType: priceResult.price.dayType
      }
    };
  }

  /* 送信失敗はcreateBooking自体の成否に影響させない（BookingMailer側で既にSentAt確認・
     lastMailError記録まで行うため、ここでは想定外の例外だけをLoggerへ残す）。 */
  function notifyCustomerPendingBestEffort_(record) {
    try {
      BookingMailer.sendPendingMailForBooking(record.bookingId);
    } catch (mailError) {
      /* PRレビュー対応: 例外messageをそのままLoggerへ出さず、BookingMailer.gsと同じ
         redaction方針（メールアドレス等をマスク）を適用してから記録する。 */
      Logger.log('BookingRepository: PENDINGメール送信中に予期しない例外: ' + BookingMailer.sanitizeErrorMessage(describeError_(mailError)));
    }
  }

  /* Calendar成功 / Sheets失敗の部分失敗補償。Calendarイベントの削除を試み、
     成功/失敗いずれの場合もrecoveryへ記録して人が追跡できるようにする。 */
  function handleSheetsSaveFailure_(calendarId, bookingId, eventId, sheetsError, requestId, input) {
    var safeRequestId = sanitizeRequestId_(requestId);
    var diagnosticRedactions = buildDiagnosticRedactions_(calendarId, bookingId, eventId, input);
    var sanitizedSheetsError = sanitizeDiagnosticError_(sheetsError, diagnosticRedactions);
    var bookingDiagnostic = {
      requestId: safeRequestId,
      occurredAt: new Date().toISOString(),
      sheetsError: sanitizedSheetsError,
      calendarCompensation: 'not_attempted',
      recoveryRecord: 'not_attempted'
    };
    persistBookingDiagnosticBestEffort_(safeRequestId, bookingDiagnostic);
    Logger.log(
      'requestId=' + safeRequestId +
      ' handleSheetsSaveFailure sheetsError=' + sanitizedSheetsError
    );

    var compensated = false;
    var compensationError = null;
    try {
      CalendarRepository.deleteEventById(calendarId, eventId);
      compensated = true;
    } catch (deleteError) {
      compensationError = deleteError;
    }
    Logger.log(
      'requestId=' + safeRequestId +
      ' handleSheetsSaveFailure calendarCompensation=' + (compensated ? 'success' : 'failure') +
      (compensationError ? ' error=' + sanitizeDiagnosticError_(compensationError, diagnosticRedactions) : '')
    );
    bookingDiagnostic.calendarCompensation = compensated ? 'success' : 'failure';
    persistBookingDiagnosticBestEffort_(safeRequestId, bookingDiagnostic);

    var recoveryRecorded = false;
    var recoveryError = null;
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: compensated ? 'CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE' : 'SHEETS_FAILURE_CALENDAR_ORPHANED',
        occurredAt: new Date(),
        calendarEventId: eventId,
        status: compensated ? 'COMPENSATED' : 'NEEDS_MANUAL_RECOVERY',
        errorMessage: describeError_(sheetsError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
      recoveryRecorded = true;
    } catch (recordFailureError) {
      recoveryError = recordFailureError;
      /* recovery記録自体の失敗は最後の砦としてLoggerへ残すのみ（ここで例外を投げると
         利用者への応答自体が失敗するため、必ず握りつぶす）。 */
      Logger.log(
        'requestId=' + safeRequestId +
        ' handleSheetsSaveFailure recoveryRecord=failure error=' +
        sanitizeDiagnosticError_(recordFailureError, diagnosticRedactions)
      );
    }
    if (recoveryRecorded) {
      Logger.log('requestId=' + safeRequestId + ' handleSheetsSaveFailure recoveryRecord=success');
    }

    bookingDiagnostic.recoveryRecord = recoveryRecorded ? 'success' : 'failure';
    if (recoveryError) {
      bookingDiagnostic.recoveryError = sanitizeDiagnosticError_(recoveryError, diagnosticRedactions);
    }
    persistBookingDiagnosticBestEffort_(safeRequestId, bookingDiagnostic);

    return {
      success: false,
      error: { code: 'BOOKING_SAVE_FAILED', message: '予約の保存に失敗しました。しばらくしてから再度お試しください。' }
    };
  }

  /* Issue #273の一時診断。保存失敗は予約処理へ影響させず、Loggerにも内部値を出さない。 */
  function persistBookingDiagnosticBestEffort_(safeRequestId, diagnostic) {
    if (safeRequestId === 'invalid' || safeRequestId === 'unavailable') return;
    try {
      var value = {
        requestId: diagnostic.requestId,
        occurredAt: diagnostic.occurredAt,
        sheetsError: diagnostic.sheetsError,
        calendarCompensation: diagnostic.calendarCompensation,
        recoveryRecord: diagnostic.recoveryRecord
      };
      if (diagnostic.recoveryError) value.recoveryError = diagnostic.recoveryError;
      PropertiesService.getScriptProperties().setProperty(
        'BOOKING_DIAG_' + safeRequestId,
        JSON.stringify(value)
      );
    } catch (diagnosticSaveError) {
      /* best effort: BOOKING_SAVE_FAILEDの既存レスポンスと補償処理を変えない。 */
    }
  }

  function notifyAdminBestEffort_(record) {
    try {
      AdminNotifier.notifyNewPendingBooking(record);
    } catch (notifyError) {
      Logger.log('AdminNotifier.notifyNewPendingBooking failed: ' + describeError_(notifyError));
      try {
        RecoveryRepository.recordFailure({
          bookingId: record.bookingId,
          failureType: 'ADMIN_NOTIFICATION_FAILED',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: describeError_(notifyError),
          recoveryState: 'INFO',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    }
  }

  function describeError_(error) {
    return String((error && error.message) || error);
  }

  /* requestIdはWeb App入口でUtilities.getUuid()から生成した値だけを想定する。
     診断関数を直接呼ばれた場合も、任意文字列をログへ流さない。 */
  function sanitizeRequestId_(requestId) {
    var value = String(requestId || 'unavailable');
    return /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : 'invalid';
  }

  /* Sheets/Calendar例外に入力値や内部IDが含まれてもログへ残さないため、今回の
     リクエストで把握できるPII・識別子を追加redaction対象にする。 */
  function buildDiagnosticRedactions_(calendarId, bookingId, eventId, input) {
    var values = [calendarId, bookingId, eventId];
    if (input) {
      values = values.concat([
        input.name,
        input.email,
        input.phone,
        input.people,
        input.purpose,
        input.paymentMethod,
        input.note,
        input.source
      ]);
    }
    try {
      values.push(BookingConfig.getSpreadsheetId());
    } catch (ignoredError) {
      /* 元のSheets失敗原因を診断する経路なので、設定再取得の失敗は無視する。 */
    }
    return values.filter(function (value) { return value !== null && value !== undefined && String(value) !== ''; });
  }

  function sanitizeDiagnosticError_(error, extraRedactions) {
    return BookingMailer.sanitizeErrorMessage(describeError_(error), extraRedactions);
  }

  /* instanceof Dateではなくダックタイピングで判定する。Spreadsheetの日時セルは
     常にDateを返す想定だが、vm等の別realmをまたぐ場合instanceof Dateが偽陰性になり得るため。 */
  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  /*
   * confirmBooking(bookingId) — Spreadsheetのカスタムメニュー（BookingAdmin.gs。
   * Booking Adminプロジェクト）から呼ばれる正式な確定手順。PENDINGのみCONFIRMEDへ
   * 遷移できる。既にCONFIRMED済みなら何もせず成功扱いにする（二重実行しても壊れない）。
   * expirePendingBookingsも同じBooking Adminプロジェクトに属し、同じ
   * LockService.getScriptLock()を取得するため、この2つが同時に同じbookingIdを
   * 処理することはない（一方がLockを保持している間、他方はtryLockが失敗するかLockが
   * 解放されるまで待つ）。
   */
  function confirmBooking(bookingId) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }

    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    var outcome;
    try {
      outcome = confirmBookingLocked_(bookingId);
    } finally {
      lock.releaseLock();
    }

    /*
     * 利用者向けCONFIRMEDメールはbooking状態変更のLockの外で送る（Issue #271
     * 「12. confirmBookingへの接続」）。メール送信の成否はconfirmBookingの成否に
     * 影響させず、success:falseにはしない（補助情報としてmailSent/mailErrorを添える）。
     */
    if (outcome.shouldTryMail) {
      notifyCustomerConfirmedBestEffort_(bookingId, outcome.response);
    }

    return outcome.response;
  }

  /* confirmBookingのLock保持区間の本体。戻り値: { response, shouldTryMail }。
     shouldTryMailは「CalendarとSheetsが正常な状態（新規確定 or 確定済みでメール未送信）」
     の場合のみtrueにし、確定処理自体が失敗した場合はfalseにする（Lockを保持したまま
     メール送信を行わないための分離）。 */
  function confirmBookingLocked_(bookingId) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return {
        response: { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } },
        shouldTryMail: false
      };
    }

    var record = found.record;
    if (record.status === Booking.STATUS.CONFIRMED) {
      /* 既にCONFIRMED済みでも、confirmedMailSentAtが空ならメールだけ再試行させる
         （Issue #271本文どおり。状態自体はここでは一切変更しない）。 */
      return {
        response: { success: true, alreadyConfirmed: true, bookingId: bookingId, status: Booking.STATUS.CONFIRMED },
        shouldTryMail: !record.confirmedMailSentAt
      };
    }
    /*
     * Issue #334: Booking.ALLOWED_TRANSITIONSにEXPIRED→CONFIRMEDを追加したが、
     * それを実行できるのは専用のreviveExpiredBooking（このファイル下部）のみとする。
     * confirmBookingは既存どおりEXPIREDを拒否し続ける（reviveExpiredBookingはLock内での
     * 枠競合再確認・Calendarイベント新規作成・expiredAt保持等、confirmBookingLocked_には
     * 無い専用の復活処理を行うため、canTransitionの表が一般にtrueを返すようになったことを
     * 理由にこの関数へその処理を委ねさせない）。
     */
    if (record.status === Booking.STATUS.EXPIRED) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CONFIRMED へは遷移できません。' }
        },
        shouldTryMail: false
      };
    }
    if (!Booking.canTransition(record.status, Booking.STATUS.CONFIRMED)) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CONFIRMED へは遷移できません。' }
        },
        shouldTryMail: false
      };
    }

    /*
     * 料金修正の訂正案内が未完了なら、Calendar/Sheetsを変更する前に確定を止める。
     * Web管理画面とSpreadsheetメニューは同じconfirmBookingを経由する。
     */
    if (Booking.needsPriceUpdateNotice(record)) {
      return {
        response: {
          success: false,
          error: {
            code: 'PRICE_UPDATE_NOTICE_REQUIRED',
            message: '修正後の利用料金をまだ案内していません。訂正案内メールを送信してから予約を確定してください。'
          }
        },
        shouldTryMail: false
      };
    }

    var calendarId = BookingConfig.getCalendarId();
    var event = CalendarRepository.getEventById(calendarId, record.calendarEventId);
    if (!event) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CONFIRM_CALENDAR_EVENT_MISSING',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: 'confirmBooking時にCalendarイベントが見つかりませんでした。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'CALENDAR_EVENT_MISSING', message: '対応するCalendarイベントが見つかりません。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    CalendarRepository.setEventStatus(calendarId, record.calendarEventId, Booking.STATUS.CONFIRMED, bookingId);

    var confirmedAt = new Date();
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        status: Booking.STATUS.CONFIRMED,
        confirmedAt: confirmedAt,
        updatedAt: confirmedAt
      });
    } catch (sheetsError) {
      return { response: handleConfirmSheetsUpdateFailure_(calendarId, bookingId, record.calendarEventId, sheetsError), shouldTryMail: false };
    }

    return { response: { success: true, bookingId: bookingId, status: Booking.STATUS.CONFIRMED }, shouldTryMail: true };
  }

  /* response（confirmBookingの戻り値オブジェクト）へmailSent/mailErrorを補助情報として
     追加する。メール失敗はここでもconfirmBooking自体の成功可否には影響させない。 */
  function notifyCustomerConfirmedBestEffort_(bookingId, response) {
    try {
      var mailResult = BookingMailer.sendConfirmedMailForBooking(bookingId);
      response.mailSent = !!(mailResult && mailResult.success && !mailResult.skipped);
      if (!mailResult || !mailResult.success) {
        response.mailError = mailResult && mailResult.error;
      }
    } catch (mailError) {
      /* PRレビュー対応: 例外messageをそのままLoggerへ出さず、BookingMailer.gsと同じ
         redaction方針（メールアドレス等をマスク）を適用してから記録する。 */
      var sanitizedMessage = BookingMailer.sanitizeErrorMessage(describeError_(mailError));
      Logger.log('BookingRepository: CONFIRMEDメール送信中に予期しない例外: ' + sanitizedMessage);
      response.mailSent = false;
      response.mailError = { code: 'UNEXPECTED_ERROR', message: sanitizedMessage };
    }
  }

  /*
   * Calendar成功（CONFIRMEDへの更新）→ Sheets失敗（statusをCONFIRMEDへ更新できない）の
   * 部分失敗補償。createBooking時のCalendar成功/Sheets失敗補償と対称に、Calendar側の
   * 状態をPENDINGへ戻すことを試み、成否をrecoveryへ記録する（#268「Calendar成功/Sheets
   * 失敗を検知」「部分失敗はrecoveryへ」を状態遷移にも適用。レビュー指摘対応）。
   */
  function handleConfirmSheetsUpdateFailure_(calendarId, bookingId, eventId, sheetsError) {
    var compensated = false;
    var compensationError = null;
    try {
      CalendarRepository.setEventStatus(calendarId, eventId, Booking.STATUS.PENDING, bookingId);
      compensated = true;
    } catch (revertError) {
      compensationError = revertError;
    }

    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: compensated ? 'CALENDAR_ROLLED_BACK_AFTER_CONFIRM_SHEETS_FAILURE' : 'CONFIRM_SHEETS_FAILURE_CALENDAR_ORPHANED',
        occurredAt: new Date(),
        calendarEventId: eventId,
        status: compensated ? 'PENDING' : 'CONFIRMED',
        errorMessage: describeError_(sheetsError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }

    return {
      success: false,
      error: { code: 'CONFIRM_SAVE_FAILED', message: '確定内容の保存に失敗しました。Recoveryシートを確認してください。' }
    };
  }

  /*
   * expirePendingBookings() — Booking Adminプロジェクトの時間主導トリガーから呼ばれる
   * TTL失効処理（BookingTriggers.gs参照）。confirmBookingと同じBooking Adminプロジェクトに
   * 属し、同じLockService.getScriptLock()を使うため、confirmBookingとの間で
   * PENDING→CONFIRMEDとPENDING→EXPIREDが同時に進んでしまう競合はLockにより直列化される。
   * 候補行ごとにLockを取得し、Lock取得後に最新statusを再確認してから処理する（他プロセスとの
   * 二重処理を防ぐ）。Calendarイベント削除に失敗した場合もrecoveryへ記録した上でSheets側は
   * EXPIREDへ進める（削除失敗を理由にPENDINGのまま放置しない）。
   */
  function expirePendingBookings(now) {
    now = isDateLike_(now) ? now : new Date();
    var ttlConfig = BookingConfig.getTtlConfig();
    var calendarId = BookingConfig.getCalendarId();
    var candidates = SpreadsheetRepository.getAllPendingBookings();
    var expiredCount = 0;
    var skippedCount = 0;
    /* Issue #334: 今回の実行でPENDING→EXPIREDへ実際に更新したカード予約のbookingIdだけを
       集め、forEachループ（＝全候補のLock取得・解放）が終わったあとにLock外でまとめて
       通知する。expiredMailSentAtが空の過去のEXPIRED行（＝このループのcandidatesに
       含まれない、既にstatus!==PENDINGな行）はここに入らないため、過去分へ遡って
       送ることはない。 */
    var newlyExpiredCardBookingIds = [];

    candidates.forEach(function (item) {
      var record = item.record;
      var createdAtMillis = isDateLike_(record.createdAt) ? record.createdAt.getTime() : NaN;
      var startAtMillis = isDateLike_(record.startAt) ? record.startAt.getTime() : NaN;
      if (isNaN(createdAtMillis) || isNaN(startAtMillis)) {
        Logger.log('expirePendingBookings: createdAt/startAtが不正なためスキップ: ' + record.bookingId);
        skippedCount++;
        return;
      }

      /*
       * Issue #334: カード決済のPENDINGのみCARD_TTL_HOURS（72時間・受付起点）を使う。
       * 現金/PayPay/未定はScript Properties由来のttlConfig.ttlHours（既定24時間）のまま
       * 一切変更しない（Issue #334本文「現金・PayPay・未定の失効挙動（24時間）は変更しない」）。
       * カードはvalidateCreateBookingInputで96時間未満の申込自体を拒否しているため、
       * 「利用開始まで2時間未満で受け付けた当日予約」のgrace（minHoldHours）は通常発生しない。
       * 96時間ルール導入前に作成された既存のカードPENDING行に対する安全策として
       * minHoldHoursは適用せず0固定にし、「利用開始の2時間前を超えない」上限
       * （minHoursBeforeStart。既存のPENDING_TTL_MIN_HOURS_BEFORE_START）だけは
       * 維持する（Booking.computeCardPaymentDueMillis参照）。
       */
      var isCard = Booking.isCardPaymentMethod(record.paymentMethod);
      var ttlHours = isCard ? Booking.CARD_TTL_HOURS : ttlConfig.ttlHours;
      var minHoldHours;
      if (isCard) {
        minHoldHours = 0;
      } else {
        /*
         * Issue #270（レビュー対応）: 「利用開始まで2時間未満で受け付けた当日予約」が
         * 作成直後に即EXPIREDになる事故を防ぐため、受付時刻(createdAt)の暦日(Asia/Tokyo基準)と
         * 予約の利用日(date)が一致する場合のみ、Booking.computeTtlExpiryMillisのgrace
         * （通常TTLが受付時刻以前になる直前当日予約にだけ使う最大猶予。利用開始時刻を
         * 必ず上限とする＝expiry<=startAtを保証する）を適用する。一致しない（＝翌日以降に
         * 通常の余裕を持って受け付けた）予約はminHoldHours=0のまま#268時点と完全に同じ
         * TTL計算になる（既存の翌日以降予約のTTLへの影響なし）。
         */
        var createdDateString = Booking.formatDateInTimezone(new Date(createdAtMillis), ttlConfig.timezone);
        var isSameDayBooking = !!createdDateString && record.date === createdDateString;
        minHoldHours = isSameDayBooking ? ttlConfig.minHoldHours : 0;
      }

      if (!Booking.isExpired(createdAtMillis, startAtMillis, ttlHours, ttlConfig.minHoursBeforeStart, now.getTime(), minHoldHours)) {
        return; /* まだ有効 */
      }

      var lock = LockService.getScriptLock();
      var gotLock = lock.tryLock(EXPIRE_LOCK_TIMEOUT_MS_);
      if (!gotLock) {
        Logger.log('expirePendingBookings: lock取得失敗のためスキップ（次回トリガーで再試行）: ' + record.bookingId);
        skippedCount++;
        return;
      }

      try {
        var latest = SpreadsheetRepository.findRowByBookingId(record.bookingId);
        if (!latest || latest.record.status !== Booking.STATUS.PENDING) {
          return; /* confirmBooking等で既に処理済み */
        }

        try {
          CalendarRepository.deleteEventById(calendarId, latest.record.calendarEventId);
        } catch (deleteError) {
          try {
            RecoveryRepository.recordFailure({
              bookingId: record.bookingId,
              failureType: 'EXPIRE_CALENDAR_DELETE_FAILED',
              occurredAt: new Date(),
              calendarEventId: latest.record.calendarEventId,
              status: 'PENDING',
              errorMessage: describeError_(deleteError),
              recoveryState: 'OPEN',
              resolvedAt: ''
            });
          } catch (recoveryError) {
            Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
          }
        }

        var expiredAt = new Date();
        try {
          SpreadsheetRepository.updateBookingFields(record.bookingId, {
            status: Booking.STATUS.EXPIRED,
            expiredAt: expiredAt,
            updatedAt: expiredAt
          });
          expiredCount++;
          /* Issue #334: Sheets側のEXPIRED更新が実際に成功した行だけを通知対象にする
             （Sheets更新が失敗した行はPENDINGのまま残り、次回トリガーで再評価されるため、
             ここで通知してしまうと台帳の状態と矛盾する）。 */
          if (isCard) {
            newlyExpiredCardBookingIds.push(record.bookingId);
          }
        } catch (sheetsError) {
          /* Calendar側は削除済み（または削除失敗をrecovery記録済み）だが、Sheets側の
             statusをEXPIREDへ更新できなかった場合の不整合をrecoveryへ記録する。
             ここで例外を外へ投げるとforEachの以降の候補が処理されなくなるため、
             このcatchで必ず握りつぶし、他の候補の処理を継続する（レビュー指摘対応:
             1件のSheets更新失敗で他の候補まで巻き込んで未処理にしない）。 */
          try {
            RecoveryRepository.recordFailure({
              bookingId: record.bookingId,
              failureType: 'EXPIRE_SHEETS_UPDATE_FAILED',
              occurredAt: new Date(),
              calendarEventId: latest.record.calendarEventId,
              status: 'PENDING',
              errorMessage: describeError_(sheetsError),
              recoveryState: 'OPEN',
              resolvedAt: ''
            });
          } catch (recoveryError) {
            Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
          }
          skippedCount++;
        }
      } finally {
        lock.releaseLock();
      }
    });

    /*
     * Issue #334: 失効通知メールはLock外・best effortで送る（送信失敗でもEXPIRED状態は
     * 取り消さない。既にSheets側はEXPIREDへ更新済みのため、ここで例外が起きても
     * expiredCount/skippedCountの集計・関数の戻り値には影響させない）。
     */
    newlyExpiredCardBookingIds.forEach(function (bookingId) {
      notifyCustomerExpiredBestEffort_(bookingId);
    });

    return { expiredCount: expiredCount, skippedCount: skippedCount, candidateCount: candidates.length };
  }

  /* 送信失敗はexpirePendingBookings自体の成否・戻り値に影響させない（Issue #334本文
     「送信失敗でもEXPIREDを維持する」）。createBooking側のnotifyCustomerPendingBestEffort_と
     同じredaction方針でLoggerへ記録する。 */
  function notifyCustomerExpiredBestEffort_(bookingId) {
    try {
      BookingMailer.sendExpiredMailForBooking(bookingId);
    } catch (mailError) {
      Logger.log('BookingRepository: EXPIREDメール送信中に予期しない例外: ' + BookingMailer.sanitizeErrorMessage(describeError_(mailError)));
    }
  }

  /*
   * reviveExpiredBooking(bookingId) — EXPIRED予約の手動復活（Issue #334）。
   * 入金確認後の承認が期限に間に合わずEXPIREDになったが、実際には支払い済みだったと
   * 判明した場合に、Booking Admin（Spreadsheetメニュー／Web UI）から呼ぶ専用の復活手順。
   *
   * 既存confirmBookingは変更せず（EXPIREDを引き続き拒否する。confirmBookingLocked_の
   * 明示ガード参照）、この専用関数でのみEXPIRED→CONFIRMEDを行う。confirmBooking/
   * expirePendingBookings/cancelBookingAdminと同じBooking Adminプロジェクトに属し、
   * 同じLockService.getScriptLock()を取得するため、これらと同時に同じbookingIdを
   * 処理することはない。
   *
   * 処理順（Issue #334本文どおり）:
   *   1. Lock取得
   *   2. 最新レコード再読込 → status===EXPIRED かつ 利用開始時刻より前であることを確認
   *   3. Lock内で枠の競合を再確認（BookingAvailability.isStartTimeBookable）
   *   4. 空きがあればCalendarにCONFIRMEDイベントを新規作成
   *      （失効時に旧イベントは削除済みのため、confirmBookingのようにイベントのstatusを
   *      更新するのではなく、createBooking同様に新規作成する）
   *   5. 台帳のstatus/calendarEventId/confirmedAt/updatedAtを更新（expiredAtは履歴として残す）
   *   6. Lock解除
   *   7. Lock外で確定メール（既存sendConfirmedMailForBookingをそのまま使う。
   *      confirmBookingのnotifyCustomerConfirmedBestEffort_を再利用し、メール処理を複製しない）
   *
   * now引数は省略可能（Booking Adminメニュー・Web UIからは常に引数なしで呼ばれ、現在時刻へ
   * フォールバックする）。expirePendingBookings(now)と同じく、テストから「利用開始時刻を
   * 過ぎているか」を固定時刻で検証できるようにするためだけの引数。
   */
  function reviveExpiredBooking(bookingId, now) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    now = isDateLike_(now) ? now : new Date();

    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    var outcome;
    try {
      outcome = reviveExpiredBookingLocked_(bookingId, now);
    } finally {
      lock.releaseLock();
    }

    /* confirmBookingと同じくLockの外・best effortで確定メールを送る。メールの成否は
       reviveExpiredBooking自体の成否には影響させない（Issue #334本文
       「メール失敗で予約確定を巻き戻さない」）。既存のnotifyCustomerConfirmedBestEffort_を
       そのまま再利用する（メール送信処理を複製しない）。 */
    if (outcome.shouldTryMail) {
      notifyCustomerConfirmedBestEffort_(bookingId, outcome.response);
    }

    return outcome.response;
  }

  function reviveExpiredBookingLocked_(bookingId, now) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return {
        response: { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } },
        shouldTryMail: false
      };
    }

    var record = found.record;

    /* 復活の対象はEXPIREDのみ（支払方法は問わない。Issue #334本文どおり）。
       PENDING/CONFIRMED/CANCELLEDはここでは一切扱わない（それぞれ既存の
       confirmBooking/cancelBookingAdminの対象）。 */
    if (record.status !== Booking.STATUS.EXPIRED) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CONFIRMED への復活はできません（EXPIREDのみ対象）。' }
        },
        shouldTryMail: false
      };
    }

    var startAtMillis = isDateLike_(record.startAt) ? record.startAt.getTime() : NaN;
    if (isNaN(startAtMillis) || now.getTime() >= startAtMillis) {
      return {
        response: {
          success: false,
          error: { code: 'REVIVE_AFTER_START_NOT_ALLOWED', message: '利用開始時刻を過ぎているため復活できません。' }
        },
        shouldTryMail: false
      };
    }

    /*
     * Lock内で枠の競合を再確認する（Issue #334本文「Lock内で枠の競合を再確認し」）。
     * 失効時にCalendarイベントは削除済みのため自分自身のイベントと衝突することはなく、
     * createBookingと同じisStartTimeBookableをそのまま使える。dateString/startTimeString/
     * durationMinutesはSheets台帳のstartAt/endAt（実データ）から復元する
     * （record.dateの型ゆれに依存しない。BookingAdminWeb.gsのformatAdminDate_と同じ注意点）。
     */
    var availabilityConfig = BookingConfig.getAvailabilityConfig();
    var calendarId = BookingConfig.getCalendarId();
    var dateString = BookingAvailability.formatDateInTimezone(record.startAt, availabilityConfig.timezone);
    var startTimeString = BookingAvailability.formatTimeInTimezone(record.startAt, availabilityConfig.timezone);
    if (!dateString || !startTimeString || !isDateLike_(record.endAt)) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_CONFIG', message: '予約データの日時が不正なため復活できません。' }
        },
        shouldTryMail: false
      };
    }
    var durationMinutes = Math.round((record.endAt.getTime() - record.startAt.getTime()) / 60000);
    var startMinutes = BookingAvailability.parseTimeToMinutes(startTimeString);

    var busyIntervals = CalendarRepository.getBusyIntervalsForDate(calendarId, dateString, availabilityConfig.timezone);
    var bookable = BookingAvailability.isStartTimeBookable(startMinutes, durationMinutes, busyIntervals, availabilityConfig.bufferMinutes);
    if (!bookable) {
      return {
        response: {
          success: false,
          error: { code: 'SLOT_UNAVAILABLE', message: 'この枠は既に埋まっているため復活できません。' }
        },
        shouldTryMail: false
      };
    }

    /* 空きがあればCONFIRMEDのCalendarイベントを新規作成する（Issue #334本文どおり）。
       createBookingEventは常にPENDINGタイトル/タグで作成するため、直後にsetEventStatusで
       CONFIRMEDへ更新する（CalendarRepository.gs自体は変更しない）。
       createBookingEvent自体の失敗（イベント未作成）とsetEventStatusの失敗（イベントは
       作成済みだがCONFIRMEDへ更新できない）は、補償対象・記録すべき内容が異なるため
       別のtry/catchに分ける（PRレビュー対応）。 */
    var eventId;
    try {
      eventId = CalendarRepository.createBookingEvent(calendarId, {
        date: dateString,
        startTime: startTimeString,
        durationMinutes: durationMinutes,
        timezone: availabilityConfig.timezone,
        bookingId: bookingId,
        brand: record.brand
      });
    } catch (createError) {
      /* イベント自体が作成されていないため、補償（削除）対象は無い。 */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'REVIVE_CALENDAR_CREATE_FAILED',
          occurredAt: new Date(),
          calendarEventId: '',
          status: record.status,
          errorMessage: describeError_(createError),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'REVIVE_CALENDAR_FAILED', message: 'Calendarへの復活登録に失敗しました。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    try {
      CalendarRepository.setEventStatus(calendarId, eventId, Booking.STATUS.CONFIRMED, bookingId);
    } catch (statusError) {
      /* イベントは新規作成済み（PENDINGタイトル/タグのまま）だが、CONFIRMEDへの更新に
         失敗した状態（PRレビュー対応: Calendarイベント新規作成成功後にsetEventStatusが
         失敗した場合の補償）。この時点ではSheetsを一切更新していないため、予約は
         EXPIREDのまま維持し、新規作成したイベントの補償削除を試みる。 */
      return { response: handleReviveEventStatusFailure_(calendarId, bookingId, eventId, statusError, record.status), shouldTryMail: false };
    }

    var confirmedAt = new Date();
    try {
      /* expiredAtは履歴として残す（Issue #334本文どおり。ここでは触らない）。 */
      SpreadsheetRepository.updateBookingFields(bookingId, {
        status: Booking.STATUS.CONFIRMED,
        calendarEventId: eventId,
        confirmedAt: confirmedAt,
        updatedAt: confirmedAt
      });
    } catch (sheetsError) {
      return { response: handleReviveSheetsUpdateFailure_(calendarId, bookingId, eventId, sheetsError), shouldTryMail: false };
    }

    return { response: { success: true, bookingId: bookingId, status: Booking.STATUS.CONFIRMED }, shouldTryMail: true };
  }

  /*
   * Calendarイベント新規作成成功 → setEventStatus（CONFIRMEDへの更新）失敗の部分失敗補償
   * （PRレビュー対応）。この時点でSheetsは一切更新していない（Sheets書き込みより前段階の
   * 失敗のため）ため、Sheetsへの更新は行わず、予約はEXPIREDのまま維持する。新規作成した
   * イベントの補償削除を試み、成功すれば「作成しなかった状態」へ完全に戻る（イベントは
   * 存在しない・SheetsはEXPIREDのまま＝復活試行前と同じ状態）。削除にも失敗した場合は
   * PENDINGタイトル/タグのまま残る孤立イベントとしてRecoveryへOPENで記録する
   * （handleReviveSheetsUpdateFailure_と対になる、より早い段階の失敗ケース）。
   */
  function handleReviveEventStatusFailure_(calendarId, bookingId, eventId, statusError, bookingStatus) {
    var compensated = false;
    var compensationError = null;
    try {
      CalendarRepository.deleteEventById(calendarId, eventId);
      compensated = true;
    } catch (deleteError) {
      compensationError = deleteError;
    }

    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: compensated ? 'REVIVE_CALENDAR_STATUS_FAILED_ROLLED_BACK' : 'REVIVE_CALENDAR_STATUS_FAILED_ORPHANED',
        occurredAt: new Date(),
        calendarEventId: eventId,
        /* Sheetsは一切更新していないため、予約の実際のstatusは常にEXPIREDのまま。 */
        status: bookingStatus,
        errorMessage: describeError_(statusError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }

    return {
      success: false,
      error: { code: 'REVIVE_CALENDAR_STATUS_FAILED', message: 'Calendarの確定状態への更新に失敗しました。Recoveryシートを確認してください。' }
    };
  }

  /*
   * Calendar成功（新規CONFIRMEDイベント作成）→ Sheets失敗（statusをCONFIRMEDへ更新できない）の
   * 部分失敗補償（Issue #334本文「Calendar成功／Sheets失敗時は既存Recovery方式に合わせる」）。
   * confirmBookingのhandleConfirmSheetsUpdateFailure_はイベントのstatusをPENDINGへ戻す
   * （元々PENDINGのイベントだったため）が、reviveExpiredBookingは失効時に削除済みだった
   * イベントを新規作成しているため、「無かった状態」へ戻すには削除が正しい補償である。
   * これはcreateBookingのhandleSheetsSaveFailure_（Calendar成功→Sheets失敗→Calendar補償削除）と
   * 同じ形であり、RecoveryRepository.gsに既存のfailureType定数
   * （CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE / SHEETS_FAILURE_CALENDAR_ORPHANED）を
   * そのまま再利用する（新規のfailureTypeを増やさない）。
   */
  function handleReviveSheetsUpdateFailure_(calendarId, bookingId, eventId, sheetsError) {
    var compensated = false;
    var compensationError = null;
    try {
      CalendarRepository.deleteEventById(calendarId, eventId);
      compensated = true;
    } catch (deleteError) {
      compensationError = deleteError;
    }

    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: compensated ? 'CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE' : 'SHEETS_FAILURE_CALENDAR_ORPHANED',
        occurredAt: new Date(),
        calendarEventId: eventId,
        status: compensated ? 'EXPIRED' : 'CONFIRMED',
        errorMessage: describeError_(sheetsError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }

    return {
      success: false,
      error: { code: 'REVIVE_SAVE_FAILED', message: '復活内容の保存に失敗しました。Recoveryシートを確認してください。' }
    };
  }

  /*
   * cancelBookingAdmin(bookingId) — Spreadsheetのカスタムメニュー（BookingAdmin.gs。
   * Booking Adminプロジェクト）から呼ばれる正式なキャンセル手順（Issue #272）。
   * PENDING/CONFIRMEDのいずれからもCANCELLEDへ遷移できる。Booking Web App側には
   * このキャンセル機能を一切公開しない（利用者自身のキャンセルURLは非対象）。
   *
   * confirmBooking / expirePendingBookingsと同じBooking Adminプロジェクトに属し、
   * 同じLockService.getScriptLock()を取得するため、この3関数の間では常に1つの
   * 状態遷移だけが成立する（Lock取得後に必ずSheetsを再読込し、Lock取得前の古い
   * statusで判定しない）。
   */
  function cancelBookingAdmin(bookingId) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }

    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    var outcome;
    try {
      outcome = cancelBookingAdminLocked_(bookingId);
    } finally {
      lock.releaseLock();
    }

    /*
     * キャンセルメール（#271のBookingMailer.sendCancelledMailForBooking）はbooking Lockの
     * 外・best effortで送る。Calendar/Sheetsのキャンセル処理自体が成功した場合のみ
     * 試行する（Sheetsを更新できていない部分失敗ではメールを送らない）。
     */
    if (outcome.shouldTryMail) {
      notifyCustomerCancelledBestEffort_(bookingId, outcome.response);
    }

    return outcome.response;
  }

  /* cancelBookingAdminのLock保持区間の本体。戻り値: { response, shouldTryMail }。
     Issue #272本文どおり、Lock取得後に必ずSheetsを最新再読込してからstatusを判定する。 */
  function cancelBookingAdminLocked_(bookingId) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return { response: handleCancelSheetsRowMissing_(bookingId), shouldTryMail: false };
    }

    var record = found.record;

    if (record.status === Booking.STATUS.CANCELLED) {
      /* 二重実行しても壊れない: Calendar削除・cancelledAt上書きのいずれも行わず、
         cancelMailSentAtが空の場合だけメール送信を再試行する（#271のSentAt冪等性を再利用）。 */
      return {
        response: { success: true, alreadyCancelled: true, bookingId: bookingId, status: Booking.STATUS.CANCELLED },
        shouldTryMail: !record.cancelMailSentAt
      };
    }

    if (!Booking.canTransition(record.status, Booking.STATUS.CANCELLED)) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CANCELLED へは遷移できません。' }
        },
        shouldTryMail: false
      };
    }

    var calendarId = BookingConfig.getCalendarId();
    var event;
    try {
      event = CalendarRepository.getEventById(calendarId, record.calendarEventId);
    } catch (lookupError) {
      /*
       * getEventById()はイベントが無い場合はnullを返すが、CALENDAR_ID不正・Calendar
       * アクセス障害等では例外を投げる（PRレビュー対応）。この例外を捕捉せずに
       * 抜けると、Lockはfinallyで解除されるものの、Recoveryに何も記録されず
       * 部分失敗が追跡できなくなる。Sheets/Calendarのいずれも変更せず、メールも
       * 送らずにfail-closedで返す。
       */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_CALENDAR_LOOKUP_FAILED',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: BookingMailer.sanitizeErrorMessage(describeError_(lookupError)),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'CANCEL_CALENDAR_LOOKUP_FAILED', message: 'Calendarの予約状態を確認できませんでした。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    if (!event) {
      /*
       * Calendar側が既に非占有（＝枠は既に空いている）なので、SheetsをCANCELLEDへ
       * 進めてキャンセル処理を収束させる。「なぜCalendarだけ無かったか」はRecoveryで
       * 人が確認できるようにOPENのまま記録する（自動ではRESOLVEDにしない）。
       */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_CALENDAR_EVENT_MISSING',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: 'cancelBookingAdmin時にCalendarイベントが既に存在しませんでした。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return finalizeCancelledSheetsUpdate_(bookingId, record, true);
    }

    try {
      CalendarRepository.deleteEventById(calendarId, record.calendarEventId);
    } catch (deleteError) {
      /*
       * イベントは存在したが削除自体が失敗した場合、Calendarがまだ占有している
       * 可能性があるため、Sheetsは元statusのまま進めない（メールも送らない）。
       */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_CALENDAR_DELETE_FAILED',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: describeError_(deleteError),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'CANCEL_CALENDAR_FAILED', message: 'Calendarのキャンセル処理に失敗しました。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    return finalizeCancelledSheetsUpdate_(bookingId, record, false);
  }

  /*
   * Calendar側の非占有化（削除成功、または元から既に無かった）が確定した後、Sheetsを
   * CANCELLEDへ進める共通処理。ここでSheets更新自体が失敗した場合は、Calendarイベントを
   * 無理に再作成して補償しない（再作成するとeventIdが変わり、Sheets更新障害中に
   * 書き戻せないため二次的不整合を増やす）。次回同じbookingIdでcancelBookingAdminを
   * 再実行すれば、Calendarが既に無い経路（#9）からSheetsをCANCELLEDへ収束できる。
   */
  function finalizeCancelledSheetsUpdate_(bookingId, record, calendarAlreadyMissing) {
    var now = new Date();
    try {
      /*
       * status/cancelledAt/updatedAtの3項目は必ず1回のSpreadsheet書き込みで反映する
       * （PRレビュー対応）。updateBookingFieldsのようにフィールドごとに個別書き込みすると、
       * 途中で例外が起きた場合にstatusだけCANCELLEDになりcancelledAtが空、という
       * 部分更新が起こり得る。部分更新が起きると、次回再実行時にstatus===CANCELLEDの
       * 分岐（二重実行の冪等処理）へ入ってしまい、空のままのcancelledAt/updatedAtを
       * 修復する経路が無くなるため、この関数では単一書き込みの
       * updateBookingCancellationStateAtomicを使う。
       *
       * この関数はstatus/cancelledAt/updatedAt（HEADERS_上で連続する13〜20列目）だけを
       * 書き込み対象にし、21列目以降（customerType・mail SentAt・lastMailError*）には
       * 一切触れない（PRレビュー2回目対応）。Booking Web App（別GASプロジェクト・
       * 別LockService）がこの直前直後にpendingMailSentAt等を更新していても、その値を
       * 古い状態で巻き戻すことはない。
       */
      SpreadsheetRepository.updateBookingCancellationStateAtomic(bookingId, {
        status: Booking.STATUS.CANCELLED,
        cancelledAt: now,
        updatedAt: now
      });
    } catch (sheetsError) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: describeError_(sheetsError),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'CANCEL_SAVE_FAILED', message: 'Calendar側はキャンセルされましたが、予約台帳の更新に失敗しました。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    var response = { success: true, bookingId: bookingId, status: Booking.STATUS.CANCELLED };
    if (calendarAlreadyMissing) {
      response.calendarAlreadyMissing = true;
    }
    return { response: response, shouldTryMail: true };
  }

  /*
   * Sheets行が見つからない場合の診断（Issue #272「13. Sheets行が存在しない場合」）。
   * bookingId形式から利用日を復元し、対象日のCalendarをbookingIdタグで走査する。
   * 通常キャンセルではこの経路は使わない（異常時のRecovery支援専用）。Calendarは
   * いずれのケースも自動削除しない（Sheetsという正式台帳が無い状態で破壊的変更を
   * 行うのは危険なため）。
   */
  function handleCancelSheetsRowMissing_(bookingId) {
    var notFoundResponse = { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
    var dateString = parseBookingDateFromId_(bookingId);
    if (!dateString) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_BOOKING_NOT_FOUND',
          occurredAt: new Date(),
          calendarEventId: '',
          status: '',
          errorMessage: 'bookingIdの形式が不正なため、Calendar診断をスキップしました。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return notFoundResponse;
    }

    var calendarId = BookingConfig.getCalendarId();
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var matches;
    try {
      matches = CalendarRepository.findBookingEventsByBookingId(calendarId, bookingId, dateString, timezone);
    } catch (lookupError) {
      /* 診断自体のCalendar走査が失敗した場合も、生例外で処理を抜けずRecoveryへ記録する
         （PRレビュー対応）。Calendarは変更しない。 */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED',
          occurredAt: new Date(),
          calendarEventId: '',
          status: '',
          errorMessage: BookingMailer.sanitizeErrorMessage(describeError_(lookupError)),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        success: false,
        error: { code: 'CANCEL_DIAGNOSTIC_FAILED', message: 'Calendarの診断中にエラーが発生しました。Recoveryシートを確認してください。' }
      };
    }

    if (matches.length === 1) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT',
          occurredAt: new Date(),
          calendarEventId: matches[0].getId(),
          status: '',
          errorMessage: 'Sheets台帳にbookingId行が無く、Calendarには対応するイベントが1件見つかりました。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    } else if (matches.length > 1) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND',
          occurredAt: new Date(),
          calendarEventId: matches.map(function (e) { return e.getId(); }).join(', '),
          status: '',
          errorMessage: 'Sheets台帳にbookingId行が無く、Calendarには対応するイベントが複数見つかりました。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    } else {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_BOOKING_NOT_FOUND',
          occurredAt: new Date(),
          calendarEventId: '',
          status: '',
          errorMessage: 'Sheets台帳にもCalendarにも該当するbookingIdが見つかりませんでした。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    }

    return notFoundResponse;
  }

  /* bookingId（例: 'SX-20261001-3F2A9B1C'）から利用日'YYYY-MM-DD'を復元する。
     形式が不正な場合はnullを返す（呼び出し側はCalendar走査をせずNOT_FOUNDにする）。 */
  function parseBookingDateFromId_(bookingId) {
    var match = /^[A-Za-z]+-(\d{4})(\d{2})(\d{2})-[0-9A-Za-z]{8}$/.exec(String(bookingId || ''));
    if (!match) return null;
    return match[1] + '-' + match[2] + '-' + match[3];
  }

  /* response（cancelBookingAdminの戻り値オブジェクト）へmailSent/mailErrorを補助情報として
     追加する。メール失敗はcancelBookingAdmin自体の成功可否には影響させない
     （Calendar/Sheetsの状態はメール失敗を理由に元へ戻さない）。 */
  function notifyCustomerCancelledBestEffort_(bookingId, response) {
    try {
      var mailResult = BookingMailer.sendCancelledMailForBooking(bookingId);
      response.mailSent = !!(mailResult && mailResult.success && !mailResult.skipped);
      if (!mailResult || !mailResult.success) {
        response.mailError = mailResult && mailResult.error;
      }
    } catch (mailError) {
      var sanitizedMessage = BookingMailer.sanitizeErrorMessage(describeError_(mailError));
      Logger.log('BookingRepository: CANCELLEDメール送信中に予期しない例外: ' + sanitizedMessage);
      response.mailSent = false;
      response.mailError = { code: 'UNEXPECTED_ERROR', message: sanitizedMessage };
    }
  }

  /*
   * 予約確定前の金額修正（Issue #342 管理者向け機能）。管理者が確認した金額が
   * priceAmount（予約時点の自動計算値）と異なる場合に使う（例: 自己申告の会員区分が
   * 実際には誤っていた等）。priceAmount自体は上書きせず、priceOverrideAmount/
   * priceOverrideAtへ別途記録することで、自動計算値と修正後の値を区別できるようにする
   * （Issue #342本文「元の自動計算金額と修正後の金額を区別できるようにする」）。
   * 実際に案内すべき金額（自動計算値 or 上書き値）はBooking.getEffectivePriceAmountに
   * 一元化する（ここでは書き込みのみを行い、読み取り側の判定ロジックを複製しない）。
   *
   * 対象はPENDINGのみ（Issue #342本文「予約確定前に金額を修正できる」）。CONFIRMED/
   * CANCELLED/EXPIREDでは拒否する（fail-closed。確定後の金額変更は既存の確定メール・
   * 決済案内との整合が取れなくなるため、この関数の対象外とする）。
   * confirmBooking/cancelBookingAdmin等と異なりCalendar操作・メール送信を一切行わない
   * ため、Lockは金額の読み取り→書き込みの一貫性を保証するためだけに保持する。
   */
  var MAX_PRICE_OVERRIDE_JPY_ = 1000000;

  function updateBookingPrice(bookingId, newAmountJpy, now) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var amount = Number(newAmountJpy);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0 || amount > MAX_PRICE_OVERRIDE_JPY_) {
      return {
        success: false,
        error: {
          code: 'INVALID_PRICE_AMOUNT',
          message: '金額は1円以上' + MAX_PRICE_OVERRIDE_JPY_ + '円以下の整数で指定してください。'
        }
      };
    }

    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
      }
      var record = found.record;
      if (record.status !== Booking.STATUS.PENDING) {
        return {
          success: false,
          error: {
            code: 'INVALID_STATUS_FOR_PRICE_OVERRIDE',
            message: '予約確定前（PENDING）の予約のみ金額を修正できます（現在のstatus: ' + record.status + '）。'
          }
        };
      }

      var effectiveNow = isDateLike_(now) ? now : new Date();
      /* 同一ミリ秒に送信→再修正しても、最新の修正を送信済みと誤判定しない。 */
      if (record.priceUpdateMailSentAt) {
        var previousSentAt = new Date(record.priceUpdateMailSentAt).getTime();
        if (Number.isFinite(previousSentAt) && effectiveNow.getTime() <= previousSentAt) {
          effectiveNow = new Date(previousSentAt + 1);
        }
      }
      SpreadsheetRepository.updateBookingFields(bookingId, {
        priceOverrideAmount: amount,
        priceOverrideAt: effectiveNow
      });

      return {
        success: true,
        bookingId: bookingId,
        priceAmount: record.priceAmount,
        priceOverrideAmount: amount
      };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * Issue #341 PR-Aレビュー対応: 決済状態（paymentStatus）の整合性を保証する共通更新処理。
   * 実際にStripe API・Webhookを呼ぶPR-B/PR-Cが、この関数を経由してのみpaymentStatus・
   * 決済付随情報（paymentAttemptId〜paymentRecoveryReasonの15列）を更新することを想定する
   * （SpreadsheetRepository.updateBookingPaymentStateAtomic/updateBookingFieldsを個別に
   * 直接呼ばせない）。PR-A時点ではこの関数を呼び出す実際の決済処理（Checkout Session発行・
   * Webhook確認・自動返金）は存在しない。
   *
   * 設計上の要点:
   * 1. LockService.getScriptLock()で排他制御する（confirmBooking等と同じ
   *    LOCK_TIMEOUT_MS_=10秒。呼び出し元のGASプロジェクトのLockと共有される）。
   * 2. 更新順序を固定する：**先に決済付随情報の15列（updateBookingPaymentStateAtomic。
   *    HEADERS_上で連続する1回のRange.setValues）、その後にpaymentStatus単独
   *    （updateBookingFields）の順**。paymentStatus（30列目）は15列の範囲と連続して
   *    いないため、レビュー対応前は「無関係な既存25列を巻き込む1回の書き込み」に
   *    まとめる案もあったが、それは他プロセスの並行更新を上書きする事故を招くため採用
   *    しない（PR-Aの元設計のまま。updateBookingPaymentStateAtomicのコメント参照）。
   *    2回に分かれる書き込みの順序をこの向きに固定する理由：詳細情報（Stripeの
   *    PaymentIntent id・lastStripeEventId等の証跡）が先に確定してからpaymentStatusという
   *    「状態のまとめ」が最後に確定する向きにすることで、万一paymentStatus側の書き込みだけが
   *    失敗しても「詳細情報はあるのに状態だけ古い」という検出しやすい不整合にとどまる。
   *    逆向き（先にpaymentStatusをPAID等へ進めてから詳細情報を書く）だと、詳細情報
   *    （特にlastStripeEventId）が伴わないままpaymentStatusだけが「決済成功」を騙る状態が
   *    生じ、同一Webhookイベントの重複配信をlastStripeEventIdで検出できないまま
   *    paymentStatus側の遷移チェックだけがそれを弾こうとする不安定な状態になる。
   * 3. 部分失敗時のRecovery記録：詳細情報の書き込み自体が失敗した場合は、この呼び出しでは
   *    何も変化していないため（1回のRange.setValuesが失敗すれば部分列だけ反映される
   *    ことはない）、要復旧フラグは立てず、呼び出し元が最初からやり直せばよいという
   *    扱いにする（PAYMENT_DETAIL_WRITE_FAILED）。一方、詳細情報の書き込みには成功した
   *    のにpaymentStatus側の書き込みだけが失敗した場合は、台帳が「詳細情報は新しいが
   *    状態は古い」という不整合な状態のまま残るため、paymentRecoveryRequiredAt/
   *    paymentRecoveryReasonを立て、RecoveryRepositoryにも記録し、以後のこの関数の呼び出し
   *    をすべて拒否する（PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT。
   *    BookingReschedule.commit/feeRecoveryRequiredAtと同じ「要復旧フラグが立っている間は
   *    自動処理を止め、明示的な補正を待つ」設計を踏襲する。実際の補正手段（管理者による
   *    確認・解除）はPR-D側で用意する）。
   * 4. 再実行時の整合性検証：この関数自体は「現在のpaymentStatusが既にtoPaymentStatusと
   *    一致している」場合、何も書き込まずalreadyApplied:trueで成功を返す（Stripeの
   *    Webhook再送・呼び出し元の重複リトライを安全に吸収する）。現在のpaymentStatusが
   *    未知の値（Booking.normalizePaymentStatusがnullを返す）の場合は「未決済だろう」と
   *    決めつけて処理を進めず、即座に要復旧として停止する（Issue #341 PR-Aレビュー対応・
   *    項目2）。要復旧フラグが既に立っている予約は、詳細を再判定するまでもなく先頭で
   *    即座に拒否する。
   *
   * fields: SpreadsheetRepository.updateBookingPaymentStateAtomicが受け付ける15列の
   *   部分集合（省略・空オブジェクト可。例えばFAILED→CHECKOUT_PENDINGの再試行のように
   *   付随情報を伴わない遷移もある）。
   * 戻り値: { success: true } / { success: true, alreadyApplied: true } /
   *   { success: false, error: { code, message } }
   */
  function applyPaymentStateUpdate(bookingId, toPaymentStatus, fields, now) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var effectiveNow = isDateLike_(now) ? now : new Date();

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
      }
      var record = found.record;

      if (record.paymentRecoveryRequiredAt) {
        return {
          success: false,
          error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約の決済状態は要復旧のため、自動処理を停止しています。管理者の確認が必要です。' }
        };
      }

      var currentPaymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
      if (currentPaymentStatus === null) {
        recordPaymentRecoveryBestEffort_(
          bookingId, record, 'UNKNOWN_PAYMENT_STATUS',
          'paymentStatus列に既知のいずれの値とも一致しない値が入っています（生値は診断のため' +
            'Loggerにのみ出力）。Bookingsを直接確認し、実際の決済状況（Stripe管理画面等）と' +
            '照合したうえで、正しいpaymentStatus値へ手動で修正し、この復旧フラグを解除して' +
            'ください。',
          effectiveNow
        );
        Logger.log('applyPaymentStateUpdate: 未知のpaymentStatus値を検出しました: ' + bookingId + ' rawValue=' + JSON.stringify(record.paymentStatus));
        return {
          success: false,
          error: { code: 'UNKNOWN_PAYMENT_STATUS', message: '決済状態が不明なため処理を停止しました。管理者の確認が必要です。' }
        };
      }

      if (currentPaymentStatus === toPaymentStatus) {
        return { success: true, alreadyApplied: true };
      }

      if (!Booking.canTransitionPaymentStatus(currentPaymentStatus, toPaymentStatus)) {
        return {
          success: false,
          error: {
            code: 'INVALID_PAYMENT_TRANSITION',
            message: '決済状態を' + currentPaymentStatus + 'から' + toPaymentStatus + 'へ変更することはできません。'
          }
        };
      }

      var safeFields = fields || {};
      if (Object.keys(safeFields).length > 0) {
        try {
          SpreadsheetRepository.updateBookingPaymentStateAtomic(bookingId, safeFields);
        } catch (detailError) {
          Logger.log('applyPaymentStateUpdate: 決済付随情報の書き込みに失敗しました: ' + bookingId + ' ' + detailError);
          return {
            success: false,
            error: { code: 'PAYMENT_DETAIL_WRITE_FAILED', message: '決済付随情報の保存に失敗しました。最初からやり直してください。' }
          };
        }
      }

      try {
        SpreadsheetRepository.updateBookingFields(bookingId, { paymentStatus: toPaymentStatus });
      } catch (statusError) {
        recordPaymentRecoveryBestEffort_(
          bookingId, record, 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT',
          '決済付随情報（paymentAttemptId等）の保存後、paymentStatus（目標値: ' + toPaymentStatus +
            '）の更新に失敗しました: ' + describeError_(statusError) + '。台帳の決済付随情報と' +
            '実際のStripe側の状況を確認し、paymentStatusを手動で正しい値へ修正してから' +
            'この復旧フラグを解除してください。',
          effectiveNow
        );
        return {
          success: false,
          error: {
            code: 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT',
            message: '決済付随情報は保存されましたが、決済状態の更新に失敗しました。管理者の確認が必要です。'
          }
        };
      }

      return { success: true };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * paymentRecoveryRequiredAt/paymentRecoveryReasonの設定とRecoveryRepositoryへの記録を
   * best effortで行う（既存のRecovery記録と同じ方針：記録自体の失敗はLoggerにのみ残し、
   * 呼び出し元へは投げない）。この関数の呼び出し後、applyPaymentStateUpdateは以後この
   * bookingIdへのすべての呼び出しをPAYMENT_RECOVERY_REQUIREDとして拒否する。
   */
  function recordPaymentRecoveryBestEffort_(bookingId, record, failureType, reason, now) {
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        paymentRecoveryRequiredAt: now,
        paymentRecoveryReason: reason
      });
    } catch (e) {
      Logger.log('paymentRecoveryRequiredAtの記録に失敗しました: ' + bookingId + ' ' + e);
    }
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: failureType,
        occurredAt: now,
        calendarEventId: (record && record.calendarEventId) || '',
        status: (record && record.status) || '',
        errorMessage: reason,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (e) {
      Logger.log('Recovery記録に失敗しました: ' + bookingId + ' ' + failureType + ' ' + e);
    }
  }

  return {
    createBooking: createBooking,
    confirmBooking: confirmBooking,
    expirePendingBookings: expirePendingBookings,
    reviveExpiredBooking: reviveExpiredBooking,
    cancelBookingAdmin: cancelBookingAdmin,
    updateBookingPrice: updateBookingPrice,
    applyPaymentStateUpdate: applyPaymentStateUpdate
  };
})();

/* Issue #273の診断終了後に削除する一時関数。
   指定requestIdに対応する診断プロパティだけをLoggerへ出す。 */
function debugReadBookingDiagnostic(requestId) {
  var safeRequestId = String(requestId || '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(safeRequestId)) {
    throw new Error('有効なrequestIdを指定してください。');
  }
  var value = PropertiesService.getScriptProperties().getProperty('BOOKING_DIAG_' + safeRequestId);
  Logger.log(value || 'BOOKING_DIAGNOSTIC_NOT_FOUND');
}
