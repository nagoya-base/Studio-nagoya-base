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

      /*
       * PR #354レビュー対応（Issue #341 PR-B）: bookingIdだけでCheckout Sessionの発行・
       * 再取得ができてしまう脆弱性を修正するため、カード決済のみ推測困難な決済開始
       * トークン（Utilities.getUuid()。bookingId生成用のuuidとは別に発行する。bookingId
       * 自体はuuidの一部8桁のみを使うため単独では強度が足りない）を発行し、台帳へ保存する。
       * このトークンはcreateBookingのレスポンスで一度だけ本人（送信したブラウザ）へ返し、
       * BookingRepository.beginCardCheckoutが呼び出し元の主張する値と一致することを
       * 必須で検証する（tokensMatch_参照）。現金・PayPayは常に空文字のまま
       * （空文字同士は絶対に一致させない設計。tokensMatch_参照）。
       */
      var checkoutAccessToken = Booking.isCardPaymentMethod(input.paymentMethod) ? Utilities.getUuid() : '';

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
        priceComputedAt: now,
        checkoutAccessToken: checkoutAccessToken
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
       * PR #354レビュー対応: startCardCheckoutを呼ぶ権限を証明するための決済開始
       * トークン。カード決済のみ非空文字（上記checkoutAccessToken参照）。このレスポンスは
       * 送信した本人のブラウザにのみ返る値であり、これ以外の経路（Bookings台帳の閲覧権限を
       * 持たない一般の第三者）へは公開しない。
       */
      checkoutAccessToken: checkoutAccessToken,
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
  /*
   * Issue #341 PR-B「5. 仮押さえと期限切れ」: checkout_pending（Stripe Checkout Session
   * 発行済み）のカード予約が仮押さえ期限（paymentHoldExpiresAt）を過ぎた場合、
   * expirePendingBookings（枠解放）がそのまま従来のTTL計算・削除処理へ進む前に、
   * Stripe側の実際のSession状態を確認する。「Stripe側で決済できるSessionが残っている間に
   * GASだけが枠を解放しない」「決済が成立している可能性がある場合は、未払いと決めつけて
   * 枠を解放しない」を満たすための唯一のゲート。
   *
   * 戻り値のsafeToExpire:trueだけが、この後の既存の枠解放処理（Calendar削除→
   * status:EXPIRED）へ進んでよいことを意味する。false（Stripe側がopen＝まだ決済可能、
   * complete/paid＝決済済みの可能性、API失敗・解析不能のいずれか）の場合、このトリガー
   * 実行ではこの予約をスキップする（次回のトリガー実行で再評価する。README「仮押さえの
   * 解放とStripe側の失効確認」参照）。
   */
  function verifyCheckoutHoldSafeToExpire_(record, now) {
    if (!record.stripeCheckoutSessionId) {
      recordPaymentEvidenceAuditBestEffort_(
        record.bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
        '仮押さえ期限を過ぎたcheckout_pending予約にstripeCheckoutSessionIdが記録されていません。枠を解放せずスキップしました。',
        now
      );
      return { safeToExpire: false };
    }

    var stripeConfig = BookingConfig.getStripeConfig();
    var result = StripeGateway.retrieveCheckoutSession(stripeConfig, record.stripeCheckoutSessionId);
    if (!result.ok) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: record.bookingId,
          failureType: 'EXPIRE_STRIPE_SESSION_STATUS_UNKNOWN',
          occurredAt: now,
          calendarEventId: record.calendarEventId || '',
          status: record.status || '',
          errorMessage: '仮押さえ期限を過ぎたCheckout Sessionの状態確認に失敗しました（' + result.errorType + '）: ' + (result.message || ''),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return { safeToExpire: false };
    }

    var session = result.session;
    if (session.status === 'expired' && session.paymentStatus === 'unpaid') {
      return { safeToExpire: true };
    }
    if (session.status === 'complete' || session.paymentStatus === 'paid') {
      recordPaymentRecoveryBestEffort_(
        record.bookingId, record, 'CHECKOUT_HOLD_EXPIRY_PAYMENT_MAYBE_SUCCEEDED',
        '仮押さえ期限を過ぎたためこの予約の枠解放を検討しましたが、Stripe Checkout Session（' +
          record.stripeCheckoutSessionId + '）が決済済みと報告されたため、枠を解放せず自動処理を停止しました。' +
          '至急Stripe管理画面で入金を確認してください。',
        now
      );
      return { safeToExpire: false };
    }
    /*
     * session.status==='open'（Stripe実際のexpires_atにはSTRIPE_SESSION_EXPIRY_BUFFER_
     * MINUTES分の安全マージンが乗っているため、GAS側のpaymentHoldExpiresAtを過ぎていても
     * Stripe側ではまだ数分間open=決済可能な場合がある。README「仮押さえの解放とStripe側の
     * 失効確認」参照）を含め、上記いずれにも該当しない場合は安全側に倒し、次回トリガーで
     * 再評価する。
     */
    if (session.status !== 'open') {
      try {
        RecoveryRepository.recordFailure({
          bookingId: record.bookingId,
          failureType: 'EXPIRE_STRIPE_SESSION_STATUS_UNKNOWN',
          occurredAt: now,
          calendarEventId: record.calendarEventId || '',
          status: record.status || '',
          errorMessage: 'Checkout Sessionの状態を判定できませんでした（status=' + session.status + ', payment_status=' + session.paymentStatus + '）。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    }
    return { safeToExpire: false };
  }

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
    /* Issue #341 PR-B: 仮押さえ失効によりEXPIREDへ進めたcheckout_pending予約のbookingId。
       Lock解放後にapplyPaymentStateUpdate(FAILED)をまとめて呼ぶ（上記コメント参照）。 */
    var newlyFailedCheckoutHoldBookingIds = [];

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

      /*
       * Issue #341 PR-B: Stripe Checkout Session発行済み（paymentStatus===checkout_pending）
       * のカード予約は、旧来のCARD_TTL_HOURS（72時間・受付起点）ではなく、実際にStripeへ
       * 送ったexpires_atを保存し直したpaymentHoldExpiresAt（仮押さえ期限。目安30分）を
       * 使う別クロックで判定する（Issue #341本文「旧『申込+72時間』のTTLはこのPENDINGには
       * 適用しない」）。Checkout Sessionを一度も発行していないカード予約（paymentStatusが
       * not_started/failedのまま。新フロー自体が無効・未使用の場合を含む）は、以下の
       * elseブロックで従来どおりCARD_TTL_HOURSのまま扱う（既存予約・旧Payment Link方式との
       * 互換性維持）。
       */
      var isCheckoutPendingHold = isCard &&
        Booking.normalizePaymentStatus(record.paymentStatus) === Booking.PAYMENT_STATUS.CHECKOUT_PENDING &&
        isDateLike_(record.paymentHoldExpiresAt);

      if (isCheckoutPendingHold) {
        /*
         * Issue #341 PR-Cレビュー対応・1回目: paymentHoldExpiresAtを過ぎてすぐには
         * 失効対象にせず、CardPayment.WEBHOOK_RACE_GRACE_MINUTES分の追加猶予を待つ
         * （Webhook処理は別プロジェクト・別LockServiceのため、Stripeでの決済完了直後の
         * ごく短い時間はWebhookの到達を待つ。CardPayment.gsのWEBHOOK_RACE_GRACE_MINUTES
         * コメント参照）。
         */
        if (now.getTime() < CardPayment.computeExpireSweepEligibleMillis(record.paymentHoldExpiresAt.getTime())) {
          return; /* まだ仮押さえ有効、またはWebhook到達を待つ猶予期間中 */
        }
        /*
         * Stripe側の確認はLock取得前（ネットワーク呼び出しをLockの外で行う。
         * reservePaymentAttempt_と同じ理由）。verifyCheckoutHoldSafeToExpire_が
         * safeToExpire:falseを返した場合はこの回のトリガー実行ではスキップし、次回の
         * トリガー実行で再評価する（Stripe側がまだopenの場合や、API呼び出し自体が
         * 失敗した場合を含む。「決済できるSessionが残っている間にGASだけが枠を解放
         * しない」「決済結果が不明な場合は無条件に解放しない」を満たす）。
         */
        var verification = verifyCheckoutHoldSafeToExpire_(record, now);
        if (!verification.safeToExpire) {
          skippedCount++;
          return;
        }
      } else {
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

        /*
         * Issue #341 PR-B: Lock取得前のStripe確認（verifyCheckoutHoldSafeToExpire_）から
         * Lock取得までの間に、他プロセス（将来のWebhookハンドラ等）がpaymentStatusを
         * 進めている可能性がある。Lock内で最新のpaymentStatusを再確認し、既に
         * checkout_pendingでなくなっていれば（PAID等へ進んでいれば）枠を解放せず処理を
         * スキップする（README「仮押さえの解放とStripe側の失効確認」の3条件どおり、
         * 仮押さえ解放とpaymentStatus遷移は別物だが、解放前の最終確認としてここで見る）。
         */
        if (isCheckoutPendingHold && Booking.normalizePaymentStatus(latest.record.paymentStatus) !== Booking.PAYMENT_STATUS.CHECKOUT_PENDING) {
          return;
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
          /*
           * Issue #341 PR-B: 仮押さえ解放（status側）とpaymentStatus遷移は別物のまま
           * （README「仮押さえの解放とStripe側の失効確認」参照）。applyPaymentStateUpdate
           * 自体もLockService.getScriptLock()を取得するため、この関数（expirePendingBookings）
           * が既に保持しているlockの内側から呼ぶと同一スクリプト内で二重にロックを取ろうと
           * してしまう。そのためbookingIdだけを集め、この候補のlock解放後（finally節の外）に
           * まとめて呼び出す（notifyCustomerExpiredBestEffort_と同じパターン）。
           */
          if (isCheckoutPendingHold) {
            newlyFailedCheckoutHoldBookingIds.push(record.bookingId);
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

    /*
     * Issue #341 PR-B: 仮押さえ失効で枠を解放したcheckout_pending予約のpaymentStatusを
     * failedへ進める（best effort。失敗してもexpirePendingBookings自体の戻り値
     * ―expiredCount等―には影響させない。枠解放自体は既に完了しているため、この遷移が
     * 失敗してもEXPIREDを取り消さない。次回このbookingIdへ新しい決済試行が行われる際は
     * reservePaymentAttempt_がpaymentStatus:not_startedのまま残っていた場合と同様に安全に
     * 扱われる想定だが、paymentStatusがcheckout_pendingのまま残ってしまうため、この
     * best effort呼び出し自体の失敗はLoggerで検知できるようにする）。
     *
     * PR #354レビュー対応・3回目: この予約が持つ（失効したSessionの）paymentAttemptIdを
     * ここで同時にpaymentAttemptResolvedAtへ確定させる。これを怠ると、次回この予約へ
     * 新しい決済試行を予約するreservePaymentAttempt_が、失効済みの古いpaymentAttemptIdを
     * 「まだ未解決」と誤認して再利用してしまい（古い期限切れのexpires_atのまま新しい
     * Checkout Sessionを作ろうとする等）、新しい仮押さえが正しく発行されない事故になる。
     */
    newlyFailedCheckoutHoldBookingIds.forEach(function (bookingId) {
      var failResult = applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.FAILED, { paymentAttemptResolvedAt: now }, now);
      if (!failResult.success) {
        Logger.log('expirePendingBookings: 仮押さえ失効後のpaymentStatus:failed遷移に失敗しました: ' + bookingId + ' ' + JSON.stringify(failResult.error));
      }
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
   * 決済付随情報（paymentAttemptId〜paymentRecoveryReasonの17列）を更新することを想定する
   * （SpreadsheetRepository.updateBookingPaymentStateAtomic/updateBookingFieldsを個別に
   * 直接呼ばせない）。PR-A時点ではこの関数を呼び出す実際の決済処理（Checkout Session発行・
   * Webhook確認・自動返金）は存在しない。
   *
   * 設計上の要点:
   * 1. LockService.getScriptLock()で排他制御する（confirmBooking等と同じ
   *    LOCK_TIMEOUT_MS_=10秒。呼び出し元のGASプロジェクトのLockと共有される）。
   * 2. 更新順序を固定する：**先に決済付随情報の17列（updateBookingPaymentStateAtomic。
   *    HEADERS_上で連続する1回のRange.setValues）、その後にpaymentStatus単独
   *    （updateBookingFields）の順**。paymentStatus（30列目）は17列の範囲と連続して
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
   * fields: SpreadsheetRepository.updateBookingPaymentStateAtomicが受け付ける17列の
   *   部分集合（省略・空オブジェクト可。例えばFAILED→CHECKOUT_PENDINGの再試行のように
   *   付随情報を伴わない遷移もある）。
   * 戻り値: { success: true } / { success: true, alreadyApplied: true } /
   *   { success: false, error: { code, message } }
   *
   * 2回目レビュー対応で追加した冪等性・証跡検証:
   * 5. **alreadyAppliedの判定は決済状態の一致だけに頼らない**。IDENTITY_FIELDS_
   *    （paymentAttemptId/stripeCheckoutSessionId/stripePaymentIntentId）のうち、
   *    呼び出し元が`fields`で明示的に主張した項目を、台帳の現在値と突き合わせる。
   *    現在のpaymentStatusが既にtoPaymentStatusと一致していても、主張した識別子の
   *    いずれかが台帳の値と食い違えば「別の決済試行が同じ目標状態を主張している」
   *    可能性があるため、alreadyApplied:trueで安全側に丸めず、要復旧として停止する
   *    （PAYMENT_IDENTITY_MISMATCH）。呼び出し元が識別子を何も主張しない場合
   *    （fieldsを省略、またはIDENTITY_FIELDS_に該当するキーを含まない）は、従来どおり
   *    状態の一致のみでalreadyApplied:trueとする（判定材料が無い以上、状態の一致を
   *    信頼する以外にできることがないため）。
   * 6. **決済証跡の整合性検証**：toPaymentStatusごとに、PR-B/PR-Cが実際にその遷移で
   *    得るはずの識別子（REQUIRED_EVIDENCE_FOR_STATUS_）を定義し、`fields`とその時点の
   *    台帳の値を合わせても必須項目が揃わない場合は、遷移を許可された組（
   *    canTransitionPaymentStatus）であっても書き込みを行わず拒否する
   *    （PAYMENT_EVIDENCE_MISSING）。「PAIDと主張されているのにStripeの決済識別子が
   *    一つも無い」といった証跡の欠落した成功報告を無条件に信用しない。
   *    PR-A時点では実際にStripe APIを呼ばないため、ここでの「必須」はPR-B/PR-Cが
   *    その状態に遷移する際に実際に得られるはずの値をコード上の約束として先取りした
   *    ものであり、値そのものの真正性（Stripe側との実照合）はPR-C側の署名検証・
   *    verifyPaymentAgainstSnapshotの責務のまま変わらない。
   *
   * 3回目レビュー対応で追加した検証（「同一状態への再実行」経路の強化）:
   * 7. **「既に目的の状態」の経路でも証跡検証を回避できないようにする**。2回目対応時点
   *    では、currentPaymentStatus===toPaymentStatusの分岐がfindMissingPaymentEvidence_を
   *    一切経由しないままalreadyApplied:trueに到達できてしまっていた（台帳が既に'paid'を
   *    名乗っていても、必須の決済識別子が一つも記録されていない場合に、識別子を指定
   *    しない再実行が無条件に成功扱いになる抜け穴）。この分岐でも同じ
   *    findMissingPaymentEvidence_を先に通し、証跡が欠けていればPAYMENT_EVIDENCE_MISSING
   *    として拒否する。
   * 8. **資金移動を伴う状態（paid/refund_pending/refunded）は、識別子を主張しない
   *    呼び出しを無条件に同一処理とみなさない**（paymentIdentityConfirmed_）。
   *    paymentIdentityMatches_は「主張された値が食い違わないか」だけを見るため、呼び出し
   *    元が識別子を一つも主張しなければ素通りしてしまう。これらの状態への再確認では、
   *    その状態を裏付ける識別子（MONETARY_IDENTITY_CONFIRMATION_FIELDS_。
   *    REQUIRED_EVIDENCE_FOR_STATUSと同じ集合）を呼び出し元が実際に主張し、かつ台帳と
   *    一致して初めて「同一の決済・返金処理」と認める。確認できなければ
   *    PAYMENT_IDENTITY_UNCONFIRMEDで停止する。**このためPR-B/PR-Cは、paid/
   *    refund_pending/refundedへの呼び出し（初回・再送を問わず）で、対応する識別子を
   *    毎回必ずfieldsに含めること**（下記の契約表参照。省略すると再送のたびに拒否
   *    される）。
   *
   * 要復旧ゲート（PAYMENT_RECOVERY_REQUIRED）を立てるかどうかは検知内容ごとに分ける:
   * - PAYMENT_IDENTITY_MISMATCH／PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT／
   *   UNKNOWN_PAYMENT_STATUS／**「既に目的の状態」の経路で検知したPAYMENT_EVIDENCE_
   *   MISSING**は、台帳側の記録そのものが既に不整合（または不整合の疑いがある）状態の
   *   ため、恒久ゲートを立てて以後の自動呼び出しをすべて拒否し、管理者の確認を必須に
   *   する。
   * - **新規遷移時**に検知したPAYMENT_EVIDENCE_MISSINGと、PAYMENT_IDENTITY_UNCONFIRMEDは、
   *   この回の呼び出しを拒否した時点で台帳を一切変更しておらず（検証はBookingsへの
   *   書き込みより前に行う）、単に今回の呼び出しが証跡・識別子を渡し忘れただけの可能性が
   *   高いため、恒久ゲートは立てない。RecoveryRepositoryへは監査記録として残す
   *   （recordPaymentEvidenceAuditBestEffort_）が、正しい証跡を添えれば同じbookingIdへ
   *   即座に再試行できる。
   *
   * ## PR-B/PR-Cが守るべき契約（fieldsに含めるべき識別子）
   *
   * | toPaymentStatus | 初回遷移・再送のいずれでも毎回fieldsに含めること |
   * | --- | --- |
   * | checkout_pending | paymentAttemptId, stripeCheckoutSessionId |
   * | paid | stripePaymentIntentId, lastStripeEventId |
   * | refund_pending | stripeRefundId |
   * | refunded | stripeRefundId |
   * | failed | （必須項目なし。ただし判明していればpaymentAttemptId等を含めてよい） |
   *
   * paid/refund_pending/refundedは「既に到達済みの状態を裏付ける識別子」でもあるため、
   * Webhookの重複配信やリトライで同じ状態へ再度呼び出す場合も、これらの識別子を
   * 省略しないこと。省略すると（項目8のとおり）PAYMENT_IDENTITY_UNCONFIRMEDで拒否される。
   */
  function applyPaymentStateUpdate(bookingId, toPaymentStatus, fields, now) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    try {
      return applyPaymentStateUpdateLocked_(bookingId, toPaymentStatus, fields, now);
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * applyPaymentStateUpdateの本体。呼び出し元が既にLockService.getScriptLock()を
   * 取得済みであることを前提とし、この関数自身はLockを取得・解放しない
   * （PR #354レビュー対応・4回目）。
   *
   * handleCheckoutCreateFailure_のSTRIPE_ERROR分岐（確定的失敗）は、「対象の
   * paymentAttemptIdが現在の決済試行と一致することの検証」「paymentAttemptResolvedAtの
   * 更新」「paymentStatusのFAILEDへの遷移」の3つを、他のリクエストのreservePaymentAttempt_
   * が割り込めない一続きの処理として実行する必要がある（failConfirmedCheckoutAttempt_
   * 参照）。3回目レビュー対応では、この3つ目（FAILEDへの遷移）を通常の
   * applyPaymentStateUpdate呼び出しに任せていたため、1〜2つ目のLock取得・解放と
   * 3つ目のLock取得・解放が別々になり、その間に別のリクエストが割り込める隙間が
   * 生じていた。この内部関数を切り出すことで、failConfirmedCheckoutAttempt_は自身が
   * 既に取得しているLockをそのまま使ってpaymentStatusの遷移まで完了させられる
   * （同じLockService.getScriptLock()を二重取得しない）。
   *
   * 通常の呼び出し元（PR-B/PR-Cの大半）は、この関数を直接呼ばず、必ず自分でLockを
   * 取得・解放する公開版のapplyPaymentStateUpdateを使うこと。
   */
  function applyPaymentStateUpdateLocked_(bookingId, toPaymentStatus, fields, now) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var safeFields = fields || {};
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
        /*
         * 3回目レビュー対応・項目1: 「既に目的の状態」というだけでalreadyApplied:trueに
         * せず、まずこの状態に必要な証跡が**台帳に保存済みの値だけで**揃っているかを
         * 確認する。台帳が既に'paid'等を名乗っていても、必須の決済識別子が一つも
         * 記録されていなければ、それ自体が台帳側の不整合（正しく記録されないまま状態
         * だけが進んだ疑い）であるため、恒久の要復旧ゲートを立てて停止する。
         *
         * 4回目レビュー対応: findMissingPaymentEvidence_（fieldsを台帳より優先して
         * マージする、新規遷移用の関数）をここでも流用していたため、この分岐では
         * 何もBookingsへ書き込まないにもかかわらず、今回の呼び出しがfieldsへ正しい値
         * （例: lastStripeEventId）を渡しさえすれば検証を通過し、台帳自体の証跡欠落を
         * 見逃したままalreadyApplied:trueに到達できてしまう抜け穴があった。「既に
         * 目的の状態」の経路は台帳を更新しないため、判定は必ず台帳に**現に保存されている
         * 値だけ**（findMissingPaymentEvidenceAtRest_。fieldsを一切見ない）で行う。
         * 新規遷移（このifブロックの外、これから書き込みを行う経路）では、書き込み後の
         * 状態を予測するfindMissingPaymentEvidence_（fields優先のマージ）を従来どおり使う。
         */
        var missingEvidenceAtRest = findMissingPaymentEvidenceAtRest_(record, toPaymentStatus);
        if (missingEvidenceAtRest.length > 0) {
          recordPaymentRecoveryBestEffort_(
            bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
            '決済状態は既に' + toPaymentStatus + 'ですが、必須の決済証跡（' + missingEvidenceAtRest.join('、') +
              '）が台帳に記録されていません。証跡の無いまま状態だけが進んだ疑いがあるため、' +
              '識別子を指定しない再実行であっても成功扱いにせず自動処理を停止しました。' +
              '実際のStripe側の記録を確認し、不足している識別子を台帳へ補ってから復旧して' +
              'ください。',
            effectiveNow
          );
          return {
            success: false,
            error: {
              code: 'PAYMENT_EVIDENCE_MISSING',
              message: '決済状態は既に' + toPaymentStatus + 'ですが、必須の決済証跡（' + missingEvidenceAtRest.join('、') + '）が記録されていません。'
            }
          };
        }

        if (!paymentIdentityMatches_(record, safeFields)) {
          recordPaymentRecoveryBestEffort_(
            bookingId, record, 'PAYMENT_IDENTITY_MISMATCH',
            '決済状態は既に' + toPaymentStatus + 'ですが、今回の呼び出しが主張する決済試行ID・' +
              'Stripe識別子が台帳の記録と一致しません。別の決済試行を同一予約の完了済み処理と' +
              '誤認しないよう自動処理を停止しました。実際のStripe側の記録（決済試行ごとの' +
              'PaymentIntent/Checkout Session）を確認し、二重決済や取り違えがないか調査した' +
              'うえで復旧してください。',
            effectiveNow
          );
          return {
            success: false,
            error: {
              code: 'PAYMENT_IDENTITY_MISMATCH',
              message: '決済状態は既に' + toPaymentStatus + 'ですが、決済試行の識別子が一致しないため処理を停止しました。管理者の確認が必要です。'
            }
          };
        }

        /*
         * 3回目レビュー対応・項目2: paid/refund_pending/refunded（資金移動を伴う状態。
         * MONETARY_IDENTITY_CONFIRMATION_FIELDS_）については、識別子を一つも主張しない
         * 呼び出しを「食い違いが無いから同一処理だろう」と安全側に丸めない。paymentIdentity
         * Matches_は「主張された値が食い違わないか」しか見ないため、何も主張しない呼び出しは
         * 素通りしてしまう。資金移動を伴う状態の再確認では、呼び出し元が該当する識別子を
         * 積極的に一致させて初めて「同一の決済・返金処理である」とみなす
         * （paymentIdentityConfirmed_）。確認できない場合はPAYMENT_IDENTITY_UNCONFIRMEDで
         * 停止する。証跡自体は揃っている（直前のfindMissingPaymentEvidence_を通過済み）ため
         * 台帳側の不整合ではなく、単に今回の呼び出しが同一性の証明を怠っただけの可能性が
         * 高く、恒久ゲートは立てない（PAYMENT_EVIDENCE_MISSINGの新規遷移時と同じ扱い。
         * recordPaymentEvidenceAuditBestEffort_で監査記録のみ行う）。
         */
        if (!paymentIdentityConfirmed_(record, safeFields, toPaymentStatus)) {
          recordPaymentEvidenceAuditBestEffort_(
            bookingId, record, 'PAYMENT_IDENTITY_UNCONFIRMED',
            '決済状態は既に' + toPaymentStatus + 'ですが、今回の呼び出しは同一の決済・返金処理で' +
              'あることを示す識別子（' + (MONETARY_IDENTITY_CONFIRMATION_FIELDS_[toPaymentStatus] || []).join('、') +
              '）を何も主張していません。資金移動を伴う状態の再確認は、識別子の一致を確認できない' +
              '限り自動的に同一処理とはみなしません（台帳は未変更）。正しい識別子を添えて再試行' +
              'してください。',
            effectiveNow
          );
          return {
            success: false,
            error: {
              code: 'PAYMENT_IDENTITY_UNCONFIRMED',
              message: '決済状態は既に' + toPaymentStatus + 'ですが、同一の決済・返金処理であることを識別子で確認できないため処理を停止しました。'
            }
          };
        }

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

      var missingEvidence = findMissingPaymentEvidence_(record, safeFields, toPaymentStatus);
      if (missingEvidence.length > 0) {
        /*
         * ここでは何もBookingsへ書き込んでいない（このifブロックに到達した時点で台帳は
         * 未変更）ため、recordPaymentRecoveryBestEffort_（paymentRecoveryRequiredAtの
         * 恒久ゲートを立てる）ではなく、監査記録のみのrecordPaymentEvidenceAuditBestEffort_
         * を使う。証跡欠落は「呼び出し元がこの回の呼び出しで必要な情報を渡し忘れた」
         * だけの可能性が高く、正しい証跡を添えて再試行すれば足りるため、以後この
         * bookingIdへのすべての呼び出しを恒久的に禁止するのは過剰（PAYMENT_IDENTITY_
         * MISMATCH・PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMITとは異なり、台帳側は
         * 何も不整合を起こしていない）。それでも「証跡の無い決済成功・返金の報告」自体は
         * 監査に値するためRecoveryへは記録する。
         */
        recordPaymentEvidenceAuditBestEffort_(
          bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
          '決済状態を' + toPaymentStatus + 'へ進めるために必要な決済証跡（' + missingEvidence.join('、') +
            '）が揃っていないため、この回の呼び出しを拒否しました（台帳は未変更）。証跡の無い' +
            '決済成功・返金の報告を無条件に信用しないための検証です。正しい識別子を添えて' +
            '再試行してください。',
          effectiveNow
        );
        return {
          success: false,
          error: {
            code: 'PAYMENT_EVIDENCE_MISSING',
            message: '決済状態を' + toPaymentStatus + 'へ進めるために必要な決済証跡（' + missingEvidence.join('、') + '）が不足しています。'
          }
        };
      }

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

  /*
   * PAYMENT_EVIDENCE_MISSING専用（2回目レビュー対応・項目2）：Bookingsへは何も書き込んで
   * いない（この回の呼び出しを拒否しただけ）ため、paymentRecoveryRequiredAtの恒久ゲートは
   * 立てず、RecoveryRepositoryへの監査記録のみをbest effortで行う。呼び出し元は正しい
   * 証跡を添えて同じbookingIdへ再試行できる。
   */
  function recordPaymentEvidenceAuditBestEffort_(bookingId, record, failureType, reason, now) {
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

  /*
   * applyPaymentStateUpdateの冪等性判定（2回目レビュー対応・項目1）が参照する識別子。
   * 呼び出し元が`fields`でこれらのキーを明示的に主張した場合のみ、台帳の現在値と
   * 突き合わせる（主張していないキーは判定に使わない＝比較対象にしない）。
   *
   * 原則としてREQUIRED_EVIDENCE_FOR_STATUS_に登場する全フィールドの和集合にすること
   * （3回目レビュー対応で判明した不具合の修正：stripeRefundIdがここに含まれていなかった
   * ため、異なるstripeRefundIdを主張する呼び出しがpaymentIdentityMatches_のミスマッチ
   * 判定をすり抜け、paymentIdentityConfirmed_のPAYMENT_IDENTITY_UNCONFIRMED側に誤って
   * 落ちていた。「値を主張しているのに食い違う」場合は必ずこちらのPAYMENT_IDENTITY_
   * MISMATCHで検出できるよう、判定対象のフィールド集合をREQUIRED_EVIDENCE_FOR_STATUS_と
   * 同期させる）。
   *
   * **例外: lastStripeEventIdはここに含めない**（Issue #341 PR-Cレビュー対応・1回目）。
   * Stripeは同一の決済・返金について、異なるイベントID（例:
   * checkout.session.completedとcheckout.session.async_payment_succeeded、あるいは
   * Stripe側の重複配信）で複数回通知することがある。「決済・返金として同一かどうか」は
   * stripePaymentIntentId/stripeCheckoutSessionId/paymentAttemptId/stripeRefundIdという
   * **決済・返金そのものを表す識別子**で判定すべきであり、「どのイベント配信が最後に
   * 触れたか」を表すだけのlastStripeEventIdを同一性の判定材料に含めると、同一入金への
   * 異なるイベントIDでの正当な通知のたびにPAYMENT_IDENTITY_MISMATCH（恒久の要復旧ゲート）
   * を誤発生させてしまう。StripeWebhookHandler.gsは、同一イベントの重複配信自体は
   * 別途StripeEventRepository.gsのイベント台帳（eventId単位）で防いでいるため、
   * ここでlastStripeEventIdの一致まで要求する必要はない。
   */
  var IDENTITY_FIELDS_ = [
    'paymentAttemptId', 'stripeCheckoutSessionId', 'stripePaymentIntentId', 'stripeRefundId'
  ];

  /*
   * 現在のpaymentStatusが既にtoPaymentStatusと一致している場合に、今回の呼び出しが
   * 「本当に同じ決済試行の重複処理（冪等な再送）」か、「別の決済試行が同じ目標状態を
   * 主張している」かを判定する。
   *
   * safeFieldsがIDENTITY_FIELDS_のいずれのキーも含まない場合（呼び出し元が識別子を
   * 何も主張していない）は、判定材料が無いためtrue（同一とみなす）を返す。含む場合は、
   * 主張された値すべてが台帳の現在値と一致して初めてtrueを返す。1つでも食い違えば
   * false（別の決済試行の可能性あり）。
   */
  function paymentIdentityMatches_(record, safeFields) {
    return !IDENTITY_FIELDS_.some(function (key) {
      if (!Object.prototype.hasOwnProperty.call(safeFields, key)) return false;
      var claimed = safeFields[key];
      if (claimed === undefined || claimed === null || claimed === '') return false;
      return record[key] !== claimed;
    });
  }

  /*
   * toPaymentStatusへ遷移するために最低限揃っているべき決済証跡（2回目レビュー対応・
   * 項目2）。PR-A時点ではStripe APIを呼ばないため、ここでの「必須」はPR-B/PR-Cが
   * その状態へ実際に遷移する際に得られるはずの値をコード上の約束として先取りしたもの。
   * - CHECKOUT_PENDING: Checkout Session発行時にPR-Bが必ず持つはずの決済試行ID・
   *   Session id。
   * - PAID: Webhookが伝えるPaymentIntent id、および同一イベントの重複処理を防ぐ
   *   lastStripeEventId（Issue #341本文「イベントID・決済試行IDで重複処理を防ぐ」）。
   * - REFUND_PENDING / REFUNDED: Stripe返金APIの呼び出しで得られる返金id
   *   （Issue #341本文の運用フローでは、REFUND_PENDINGは返金APIを呼び出した直後に
   *   遷移する想定であり、その時点で既にStripeからidが返っているはず）。
   * - FAILED: 追加の必須証跡なし（Session期限切れ等、PaymentIntentが発行される前に
   *   失敗する経路もあるため）。
   */
  var REQUIRED_EVIDENCE_FOR_STATUS_ = {};
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.CHECKOUT_PENDING] = ['paymentAttemptId', 'stripeCheckoutSessionId'];
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.PAID] = ['stripePaymentIntentId', 'lastStripeEventId'];
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.REFUND_PENDING] = ['stripeRefundId'];
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.REFUNDED] = ['stripeRefundId'];
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.FAILED] = [];

  /*
   * **新規遷移専用**（currentPaymentStatus !== toPaymentStatusで、これから
   * updateBookingPaymentStateAtomicへの書き込みを行う経路のみで使うこと）。今回のfields
   * と台帳の現在値を合わせても、toPaymentStatusに必要な証跡（REQUIRED_EVIDENCE_FOR_
   * STATUS_）が揃わないキーの一覧を返す（空配列なら不足なし）。fieldsで指定された値を
   * 優先し、指定が無いキーは台帳の現在値を見る（前段のcheckout_pending遷移で記録済みの
   * 識別子を、後段のpaid遷移で再送させる必要はないため）。ここでの判定はこの直後に
   * fieldsを実際に書き込むことが前提であり、fieldsを書き込まない「既に目的の状態」の
   * 経路（currentPaymentStatus===toPaymentStatus）では絶対に使わないこと
   * （findMissingPaymentEvidenceAtRest_を使う。4回目レビュー対応で発覚した抜け穴の
   * 原因はまさにこの関数をその経路へ誤用していたことだった）。
   */
  function findMissingPaymentEvidence_(record, safeFields, toPaymentStatus) {
    var required = REQUIRED_EVIDENCE_FOR_STATUS_[toPaymentStatus] || [];
    return required.filter(function (key) {
      var merged = Object.prototype.hasOwnProperty.call(safeFields, key) ? safeFields[key] : record[key];
      return merged === undefined || merged === null || merged === '';
    });
  }

  /*
   * **「既に目的の状態」専用**（4回目レビュー対応で追加）。currentPaymentStatus===
   * toPaymentStatusの経路はBookingsへ一切書き込まないため、toPaymentStatusに必要な証跡
   * （REQUIRED_EVIDENCE_FOR_STATUS_）が揃っているかどうかは、**台帳に現に保存されている
   * 値だけ**で判定しなければならない。今回の呼び出しのfieldsに正しい値が含まれていても、
   * それは書き込まれない（＝台帳の状態は変わらない）ため判定材料にしない。
   * findMissingPaymentEvidence_（fieldsを台帳より優先してマージする、新規遷移専用）を
   * この経路で使うと、fieldsさえ渡せば台帳自体の証跡欠落を隠したままalreadyApplied:true
   * に到達できてしまう（4回目レビュー対応で修正した抜け穴）。
   */
  function findMissingPaymentEvidenceAtRest_(record, toPaymentStatus) {
    var required = REQUIRED_EVIDENCE_FOR_STATUS_[toPaymentStatus] || [];
    return required.filter(function (key) {
      var value = record[key];
      return value === undefined || value === null || value === '';
    });
  }

  /*
   * 3回目レビュー対応・項目2: 資金移動を伴う状態（paid/refund_pending/refunded）へ
   * 「既に到達済み」の予約を再確認する際、呼び出し元が同一の決済・返金処理であることを
   * 積極的に証明することを要求する状態の一覧。checkout_pending/failedは資金移動を
   * 伴わないためここには含めない（paymentIdentityMatches_の「主張された値が食い違わ
   * ないか」だけの判定のままでよい）。
   *
   * PAIDについてはREQUIRED_EVIDENCE_FOR_STATUS_[PAID]（stripePaymentIntentId・
   * lastStripeEventId）をそのまま流用せず、**stripePaymentIntentIdのみ**を使う
   * （Issue #341 PR-Cレビュー対応・1回目）。lastStripeEventIdは「どのイベント配信が
   * 最後に触れたか」を表すだけで、決済そのものの同一性を表さない。Stripeが同一の
   * 決済について異なるイベントID（例: checkout.session.completedと
   * checkout.session.async_payment_succeeded、あるいは重複配信）で複数回通知しても、
   * PaymentIntent IDが同じであれば同一の決済とみなし、二重確定・二重メール送信を
   * 起こさず安全にalreadyApplied:trueへ収束させる（同一イベントIDの重複配信自体は
   * StripeEventRepository.gsのイベント台帳で別途防ぐ）。REFUND_PENDING/REFUNDEDは
   * lastStripeEventIdを含まないREQUIRED_EVIDENCE_FOR_STATUS_のままなので、そのまま
   * 流用してよい。
   */
  var MONETARY_IDENTITY_CONFIRMATION_FIELDS_ = {};
  MONETARY_IDENTITY_CONFIRMATION_FIELDS_[Booking.PAYMENT_STATUS.PAID] = ['stripePaymentIntentId'];
  MONETARY_IDENTITY_CONFIRMATION_FIELDS_[Booking.PAYMENT_STATUS.REFUND_PENDING] = REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.REFUND_PENDING];
  MONETARY_IDENTITY_CONFIRMATION_FIELDS_[Booking.PAYMENT_STATUS.REFUNDED] = REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.REFUNDED];

  /*
   * 現在のpaymentStatusが既にtoPaymentStatusと一致している場合に、toPaymentStatusが
   * MONETARY_IDENTITY_CONFIRMATION_FIELDS_に該当する（資金移動を伴う）状態であれば、
   * 呼び出し元がその状態を裏付ける識別子のすべてを主張し、かつそれらが台帳の現在値と
   * 一致することを要求する。paymentIdentityMatches_が「主張された値が食い違わないか」
   * （主張が無ければ素通り）しか見ないのに対し、こちらは「主張そのものがあるか」まで
   * 要求する（識別子を一つも主張しない呼び出しを、証拠が無いことを理由に安全側へ
   * 丸めない）。対象外の状態（checkout_pending/failed）は常にtrueを返す（従来どおり
   * paymentIdentityMatches_のみで判定する）。
   */
  function paymentIdentityConfirmed_(record, safeFields, toPaymentStatus) {
    var confirmationFields = MONETARY_IDENTITY_CONFIRMATION_FIELDS_[toPaymentStatus];
    if (!confirmationFields) return true;
    return confirmationFields.every(function (key) {
      if (!Object.prototype.hasOwnProperty.call(safeFields, key)) return false;
      var claimed = safeFields[key];
      if (claimed === undefined || claimed === null || claimed === '') return false;
      return claimed === record[key];
    });
  }

  /*
   * ============================================================================
   * Issue #341 PR-B: Stripe Checkout Sessionの発行・仮押さえ（CardPayment.gs/
   * StripeGateway.gs/applyPaymentStateUpdateを組み合わせるオーケストレーション本体）
   * ============================================================================
   *
   * beginCardCheckout(bookingId, now)がBooking Web App（Code.gs）から呼ばれる唯一の
   * 公開入口。PR-B/C/DはSpreadsheetRepositoryの低レベル関数を直接呼ばず、決済状態・
   * 決済付随情報の更新には必ずapplyPaymentStateUpdateを、決済試行IDの発行には必ず
   * reservePaymentAttempt_（このファイル内）を経由すること。
   *
   * ## 二重決済防止の設計（Issue #341本文「4. 二重決済の防止」）
   *
   * 「StripeでSession生成に成功した後、GASへのSession ID保存に失敗した場合でも、
   * 新しいSessionを無条件に発行しない」を満たすため、Stripe呼び出しの**前**に必ず
   * paymentAttemptId（Stripeへ渡すIdempotency-Keyそのもの）を台帳へ永続化してから
   * Stripeを呼ぶ（reservePaymentAttempt_）。
   *
   * - reservePaymentAttempt_は短時間のLockのみを保持し、Stripeへのネットワーク呼び出しは
   *   Lockの外で行う（LockService.getScriptLock()はスクリプト全体で共有される単一の
   *   ミューテックスであり、低速な外部HTTP呼び出しの間保持すると無関係な他の予約の処理まで
   *   直列化してしまうため）。
   * - 同一bookingIdへの並行呼び出し（二重クリック等）は、reservePaymentAttempt_のLock内で
   *   同じpaymentAttemptId（1つ目の呼び出しが発行・永続化した値）へ収束させ、以後は両方が
   *   同じIdempotency-KeyでStripeを呼ぶ。Stripe側のIdempotency-Key保証により、実際に
   *   作成されるCheckout Sessionは1つだけになる（GAS側でネットワーク呼び出しをまたぐ長い
   *   Lockを取らずに済む、Stripe推奨のパターン）。
   * - Stripe呼び出し後にapplyPaymentStateUpdateでのCHECKOUT_PENDINGへの証跡コミットが
   *   失敗した場合（PAYMENT_DETAIL_WRITE_FAILED等）も、既にpaymentAttemptIdは台帳に
   *   永続化済みのため、呼び出し元（利用者のフォーム再送信）は同じpaymentAttemptIdを
   *   再利用してStripeを再度呼び出せる。Stripeは同一Idempotency-Key・同一パラメータの
   *   再試行に対して、最初に作成したSessionをそのまま返す（新しいSessionを作らない）。
   * - Stripe呼び出し自体がタイムアウト・5xx等で結果不明（AMBIGUOUS/NETWORK）な場合は、
   *   新しい決済試行IDを発行せず、同じpaymentAttemptIdでの再試行のみを許可する
   *   （呼び出し元にエラーを返し、フロントから同じbookingIdで再試行させる）。
   */

  var CHECKOUT_LOCK_TIMEOUT_MS_ = 10000;

  /* isFinitePositiveInteger_はCardPayment.gsの同名の非公開ヘルパーと同じ判定
     （このファイルのIIFEからは直接参照できないためここに複製する）。 */
  function isFinitePositiveInteger_(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && Math.round(value) === value;
  }

  function safeJsonParse_(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
      return JSON.parse(text);
    } catch (parseError) {
      return null;
    }
  }

  /*
   * reservePaymentAttempt_が保存・復元するCheckout Session作成リクエストのスナップショット
   * （PR #354レビュー対応・2回目「Stripeへ送るリクエスト全体の固定」）が、Stripeへ安全に
   * 再送できる完全な内容かどうかを検証する。1つでも欠落・型不正・bookingId/
   * paymentAttemptIdの不一致があれば、この決済試行を安全に再照会できないとみなす
   * （呼び出し元はPAYMENT_EVIDENCE_MISSINGとして停止し、新しいSessionを発行しない）。
   */
  function isValidCheckoutRequestSnapshot_(params, bookingId, paymentAttemptId) {
    return !!params &&
      params.bookingId === bookingId &&
      params.paymentAttemptId === paymentAttemptId &&
      typeof params.brand === 'string' && !!params.brand &&
      isFinitePositiveInteger_(params.amountJpy) &&
      typeof params.currency === 'string' && !!params.currency &&
      isFinitePositiveInteger_(params.expiresAtSeconds) &&
      typeof params.successUrl === 'string' && !!params.successUrl &&
      typeof params.cancelUrl === 'string' && !!params.cancelUrl &&
      typeof params.lineItemName === 'string' && !!params.lineItemName &&
      typeof params.customerEmail === 'string';
  }

  /*
   * bookingIdの決済試行ID（Stripeへ渡すIdempotency-Key）と、Stripe Checkout Session作成
   * APIへ実際に送信するリクエスト内容一式（checkoutParams。金額・通貨・expires_at・
   * successUrl・cancelUrl・customerEmail・lineItemName等）を1回のRange.setValuesで
   * まとめて予約・永続化する（PR #354レビュー対応・2回目「Stripeへ送るリクエスト全体の
   * 固定」）。
   *
   * Stripeは同一Idempotency-Keyに対して異なるリクエスト内容が送られた場合、最初の
   * レスポンスを返さずidempotency_errorを返す。同じ決済試行IDの再試行が「初回呼び出し
   * 時点で確定した内容」と寸分違わず一致するようにするため、checkoutParams全体を
   * **この関数が呼ばれた最初の1回だけ**組み立ててJSON文字列のまま保存し、以後の再試行
   * （GAS保存失敗・APIタイムアウト・この間の料金修正やScript Properties変更等いずれの
   * 場合も）は必ずこの時点のスナップショットをそのまま復元して再利用する（呼び出し元の
   * startNewCheckoutAttempt_は独自にCardPayment.computeExpectedPaymentAmount等を
   * 呼び直さず、record.email・stripeConfig.successUrl/cancelUrlも再取得しない）。
   *
   * - 台帳に既にpaymentAttemptIdが記録されており、かつその決済試行が**まだ解決していない**
   *   （paymentAttemptResolvedAtが空。PR #354レビュー対応・3回目）場合は、currentPaymentStatus
   *   がNOT_STARTED・FAILEDのいずれであっても、その既存のスナップショット（checkoutParams
   *   全体）をそのまま再利用する（新しい値を発行・再計算しない）。**その間に管理者が料金を
   *   修正・Script Propertiesのsuccess/cancel URLを変更していても、この再試行では反映しない**
   *   （Stripeへは初回と同じ内容を送る必要があるため）。保存済みのスナップショットを安全に
   *   復元できない場合（JSON解析失敗・必須項目欠落・bookingId/paymentAttemptId不一致等）は、
   *   新しいSessionを発行せず要復旧として停止する。
   *
   *   3回目レビュー対応の要点: 以前はこの再利用判定をcurrentPaymentStatus===NOT_STARTED
   *   （+paymentAttemptId存在）に限定していた。しかしFAILEDから新しい試行を開始する処理
   *   （このファイルの後述のstartNewCheckoutAttempt_）は、Stripe呼び出しに成功して
   *   applyPaymentStateUpdateでCHECKOUT_PENDINGへコミットするまでの間、paymentStatusを
   *   FAILEDのまま変更しない。そのため、FAILEDの予約へ複数リクエストがほぼ同時に到達すると
   *   （1つ目がここで新しいpaymentAttemptId・スナップショットを予約してLockを解放した直後、
   *   まだStripeを呼んでいる／コミットが終わっていない間に2つ目がこの関数へ入る等）、
   *   旧判定ではcurrentPaymentStatusが依然FAILEDのままであるため2つ目も「新しい試行」の
   *   分岐へ入ってしまい、2つ目が1つ目の予約を上書きして**別のpaymentAttemptId・別の
   *   Idempotency-Keyで2回目のStripe呼び出し**を行ってしまう（二重のCheckout Session発行に
   *   つながる）。
   *
   *   paymentAttemptResolvedAtは、paymentStatusとは独立に「この決済試行が最終的な結果
   *   （failedへの確定、またはcheckout_pendingへの成功コミット）に到達したか」だけを表す
   *   フラグである。新しい決済試行を予約するたびに必ず空へ戻し（このLock内の1回の
   *   Range.setValuesでpaymentAttemptId等と同時に書く）、その決済試行のStripe呼び出しが
   *   確定的な結果に至った時点で初めてapplyPaymentStateUpdateの呼び出し元
   *   （handleCheckoutCreateFailure_のSTRIPE_ERROR分岐・startNewCheckoutAttempt_の成功時
   *   コミット）が現在時刻を書き込む。この結果、「新しく予約済みで未解決」（空のまま）と
   *   「以前の試行が確定的に終わった後の空き状態」（値が入っている）をpaymentStatusの値に
   *   関わらず区別できるようになり、Lockが本来意図するとおり「1つ目が予約を確定するまで
   *   2つ目は同じ予約を読む」という排他が正しく機能する。
   */
  function hasUnresolvedPaymentAttempt_(record) {
    return !!record.paymentAttemptId && !record.paymentAttemptResolvedAt;
  }

  function reservePaymentAttempt_(bookingId, stripeConfig, now) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CHECKOUT_LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
      }
      var record = found.record;
      if (record.paymentRecoveryRequiredAt) {
        return { success: false, error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約の決済状態は要復旧のため、自動処理を停止しています。' } };
      }
      if (hasUnresolvedPaymentAttempt_(record)) {
        var snapshot = safeJsonParse_(record.stripeCheckoutRequestSnapshot);
        if (!isValidCheckoutRequestSnapshot_(snapshot, bookingId, record.paymentAttemptId)) {
          /* 通常到達しない防御的分岐（このLock内で常にpaymentAttemptIdと同時に書くため）。
             スナップショットを安全に復元できないまま異なるリクエスト内容をStripeへ送って
             しまう事故を避け、要復旧として停止する（PR #354レビュー対応・2回目）。 */
          recordPaymentRecoveryBestEffort_(
            bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
            '決済試行の予約情報（Stripeへ送信するリクエスト内容一式のスナップショット）を' +
              '安全に復元できません。Bookingsを直接確認してください。',
            now
          );
          return { success: false, error: { code: 'PAYMENT_EVIDENCE_MISSING', message: '決済処理の準備状態が不整合のため停止しました。管理者の確認が必要です。' } };
        }
        return { success: true, reused: true, paymentAttemptId: record.paymentAttemptId, checkoutParams: snapshot };
      }

      var expected = CardPayment.computeExpectedPaymentAmount(record);
      if (!expected.valid) {
        return { success: false, error: expected.error };
      }
      var expiresAtSeconds = CardPayment.computeStripeSessionExpiresAtSeconds(now.getTime());
      var paymentAttemptId = CardPayment.generatePaymentAttemptId(bookingId, Utilities.getUuid());

      /*
       * このcheckoutParamsが、Stripeへ実際に送るリクエスト内容の唯一の正になる。
       * successUrl/cancelUrl（Script Properties由来）・customerEmail（record.email）を
       * ここで確定し、以後この決済試行が解決するまで一切再取得・再計算しない。
       */
      var checkoutParams = {
        amountJpy: expected.amountJpy,
        currency: expected.currency,
        bookingId: bookingId,
        brand: record.brand,
        paymentAttemptId: paymentAttemptId,
        expiresAtSeconds: expiresAtSeconds,
        successUrl: stripeConfig.successUrl,
        cancelUrl: stripeConfig.cancelUrl,
        customerEmail: record.email || '',
        lineItemName: Booking.getBrandLabel(record.brand) + ' ご利用料金（' + bookingId + '）'
      };

      try {
        SpreadsheetRepository.updateBookingPaymentStateAtomic(bookingId, {
          paymentAttemptId: paymentAttemptId,
          /* 前の決済試行の終端状態を引き継がない。この新しい試行が確定的な結果に
             至るまでは必ず空のままにする（PR #354レビュー対応・3回目）。 */
          paymentAttemptResolvedAt: '',
          stripeAmount: expected.amountJpy,
          stripeCurrency: expected.currency,
          paymentHoldExpiresAt: new Date(expiresAtSeconds * 1000),
          stripeCheckoutRequestSnapshot: JSON.stringify(checkoutParams)
        });
      } catch (writeError) {
        Logger.log('reservePaymentAttempt_: 決済試行の予約情報の保存に失敗しました: ' + bookingId + ' ' + describeError_(writeError));
        return { success: false, error: { code: 'PAYMENT_DETAIL_WRITE_FAILED', message: '決済処理の準備に失敗しました。もう一度お試しください。' } };
      }
      return { success: true, reused: false, paymentAttemptId: paymentAttemptId, checkoutParams: checkoutParams };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * Stripe Checkout Session作成呼び出し自体が失敗した場合の分岐（Issue #341本文
   * 「Stripe側で決済済みかどうか不明な場合は、新規発行を停止してRecoveryに記録」）。
   *
   * PR #354レビュー対応・2回目「Stripeの4xxエラー分類」: 4xxを一律に「確定的に失敗した」
   * とは扱わない。StripeGateway.classifyHttpError_が返すerrorTypeは3種類に分かれる:
   * - IDEMPOTENCY_CONFLICT: Stripeが「このIdempotency-Keyには既に異なるパラメータの
   *   リクエストが記録されている」と報告した。今回送った内容（保存済みスナップショット）
   *   がStripe側の記録と食い違っている＝台帳の保存内容自体が信頼できない可能性がある
   *   異常事態のため、自動再試行を続けても解決しない。**要復旧として恒久的に停止する**
   *   （新しいpaymentAttemptIdも発行しない。Stripe管理画面での確認が必須）。
   * - STRIPE_ERROR: Stripeが`invalid_request_error`/`authentication_error`/
   *   `permission_error`のいずれかを、明確な4xx（409を除く）で返した場合のみ。この回の
   *   リクエストがStripe側で一切処理されなかったと確信できるケースに限定する
   *   （StripeGateway.CONFIRMED_FAILURE_ERROR_TYPES_参照）。FAILEDへ進め、次回は新しい
   *   決済試行IDを発行させる。
   * - それ以外すべて（AMBIGUOUS/NETWORK/NOT_CONFIGURED。409・429・5xx・型が未知の4xx・
   *   応答解析不能を含む）: Stripe側で実際にSessionが作成された可能性を否定できない
   *   （あるいはそもそも呼び出せていない）。paymentStatusをFAILEDへ進めず、新しい決済
   *   試行IDも発行しない（＝次回もreservePaymentAttempt_が同じpaymentAttemptId・同じ
   *   スナップショットを再利用する）。監査記録のみ残して呼び出し元へ再試行を促す。
   *
   * paymentAttemptId: この呼び出しがStripeへ送った（＝reservePaymentAttempt_がこの回の
   *   呼び出しのために予約・返した）決済試行ID。PR #354レビュー対応・3回目: STRIPE_ERROR
   *   （確定的失敗）でpaymentStatusをFAILEDへ進める直前に、台帳の現在のpaymentAttemptId
   *   がまだこのIDのままかを確認したうえでpaymentAttemptResolvedAtへ現在時刻を書き込む。
   *   一致しない場合（この応答が発行された後に何らかの経路で既に新しい決済試行が予約
   *   されている等）は、ここでFAILEDへ進めると新しい試行の証跡を古い応答で上書きして
   *   しまう恐れがあるため、遷移を行わず要復旧として停止する（「以前の決済試行から遅れて
   *   届いた応答が、新しい試行の証跡を上書きしない」という設計要件）。
   *
   *   PR #354レビュー対応・4回目: 3回目の実装は、この確認・書き込みをsettlePaymentAttempt
   *   Resolved_（専用のLock取得→解放）で行った**後に**、paymentStatusのFAILEDへの遷移を
   *   applyPaymentStateUpdate（別のLock取得→解放）に任せていた。settlePaymentAttempt
   *   Resolved_がpaymentAttemptResolvedAtを書き込んだ時点で、reservePaymentAttempt_の
   *   再利用判定（hasUnresolvedPaymentAttempt_）はpaymentStatusを見ずこの列だけで
   *   判定するため、paymentStatusがまだfailedへ書き換わっていなくても「新しい決済試行を
   *   予約してよい」状態になってしまう。この2つのLock取得の間（前者のLockが解放されて
   *   から後者のLockが取得されるまで）に、他のリクエストがreservePaymentAttempt_で新しい
   *   決済試行を予約・Stripe呼び出し・コミットまで完了できてしまい、その後にこの古い
   *   呼び出しがpaymentStatusをFAILEDへ書き込むと、新しく予約された決済試行の状態を
   *   誤って巻き戻してしまう恐れがあった。failConfirmedCheckoutAttempt_で、この3つを
   *   1回のLock取得の中で完結させることでこの隙間を無くした。
   */
  /*
   * 「対象のpaymentAttemptIdが現在の決済試行と一致することの検証」「paymentAttempt
   * ResolvedAtの更新」「paymentStatusのFAILEDへの遷移」を、他のリクエストの
   * reservePaymentAttempt_による新しい決済試行の予約が割り込めない一続きの処理として
   * 実行する（PR #354レビュー対応・4回目）。LockService.getScriptLock()を1回だけ取得し、
   * その中で3つすべてを完了させてから解放する（applyPaymentStateUpdate自身のLock取得を
   * 経由せず、Lockを既に取得済みの状態で呼べるapplyPaymentStateUpdateLocked_を直接呼ぶ
   * ことで、同じLockを二重取得しない）。
   *
   * paymentAttemptResolvedAtの書き込みが失敗した場合は、成功したものとみなして
   * FAILEDへの遷移を続行せず、直ちにエラーを返す（Lockはこの関数の終了時にのみ解放する
   * ため、この間に他のリクエストが割り込むことはない）。
   *
   * 戻り値: { stale: true }（対象のpaymentAttemptIdが既に台帳の現在の決済試行ではない。
   * 台帳へは一切書き込んでいない） / { success: true }（FAILEDへの遷移まで完了） /
   * { success: false, error }（paymentAttemptResolvedAtの書き込み失敗、またはFAILEDへの
   * 遷移自体の失敗）。
   */
  function failConfirmedCheckoutAttempt_(bookingId, paymentAttemptId, now) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CHECKOUT_LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    try {
      var latest = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!latest || latest.record.paymentAttemptId !== paymentAttemptId) {
        return { stale: true };
      }
      try {
        SpreadsheetRepository.updateBookingPaymentStateAtomic(bookingId, { paymentAttemptResolvedAt: now });
      } catch (writeError) {
        Logger.log('failConfirmedCheckoutAttempt_: paymentAttemptResolvedAtの書き込みに失敗しました: ' + bookingId + ' ' + describeError_(writeError));
        return { success: false, error: { code: 'PAYMENT_DETAIL_WRITE_FAILED', message: '決済処理の記録に失敗しました。もう一度お試しください。' } };
      }
      return applyPaymentStateUpdateLocked_(bookingId, Booking.PAYMENT_STATUS.FAILED, {}, now);
    } finally {
      lock.releaseLock();
    }
  }

  function recordStalePaymentAttemptResponse_(bookingId, record, paymentAttemptId, context, now) {
    recordPaymentRecoveryBestEffort_(
      bookingId, record, 'STALE_CHECKOUT_ATTEMPT_RESPONSE',
      context + '（決済試行ID: ' + (paymentAttemptId || '不明') + '）が届いた時点で、台帳の' +
        '現在の決済試行は既に別のIDへ進んでいました。この応答をそのまま適用すると、新しい' +
        '決済試行の証跡を古い応答で上書きしてしまう恐れがあるため、自動処理を停止しました。' +
        'Stripe管理画面でこの決済試行IDに対応するCheckout Sessionの有無・内容を確認し、' +
        '台帳の現在の決済試行と重複や取り違えがないか調査したうえで復旧してください。',
      now
    );
    return {
      success: false,
      error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約の決済状態は要復旧のため、自動処理を停止しています。' }
    };
  }

  function handleCheckoutCreateFailure_(bookingId, record, createResult, paymentAttemptId, now) {
    if (createResult.errorType === 'IDEMPOTENCY_CONFLICT') {
      recordPaymentRecoveryBestEffort_(
        bookingId, record, 'STRIPE_IDEMPOTENCY_CONFLICT',
        'Checkout Session作成リクエストが、Stripe側に既に記録済みの内容と一致しないと' +
          '報告されました（idempotency_error）。台帳に保存された決済試行の内容（金額・通貨・' +
          'successUrl等のスナップショット）が、実際に最初にStripeへ送られた内容と食い違って' +
          'いる可能性があります。Stripe管理画面でこの決済試行ID（' + (record.paymentAttemptId || '不明') +
          '）に対応するCheckout Sessionの有無・内容を確認し、必要な補正を行ってから復旧して' +
          'ください。',
        now
      );
      return {
        success: false,
        error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約の決済状態は要復旧のため、自動処理を停止しています。' }
      };
    }

    if (createResult.errorType === 'STRIPE_ERROR') {
      /*
       * Stripeが明確にリクエストを拒否した（invalid_request_error/authentication_error/
       * permission_errorのいずれか）。この回のリクエストは処理されていないことが確定して
       * いるため、FAILEDへ進めて次回は新しい決済試行IDを発行させる（Booking.gs「新しい
       * paymentAttemptIdでの再試行時のみCHECKOUT_PENDINGへ戻れる」）。
       *
       * 「対象のpaymentAttemptIdが現在の決済試行と一致することの検証」
       * 「paymentAttemptResolvedAtの更新」「paymentStatusのFAILEDへの遷移」を、
       * failConfirmedCheckoutAttempt_が1回のLock取得の中で一続きに実行する
       * （PR #354レビュー対応・4回目。3回目時点の実装は、この3つを2回の別々のLock取得に
       * 分けていたため、その間に他のリクエストの新しい決済試行の予約が割り込めた）。
       */
      var failAttemptResult = failConfirmedCheckoutAttempt_(bookingId, paymentAttemptId, now);
      if (failAttemptResult.stale) {
        return recordStalePaymentAttemptResponse_(
          bookingId, record, paymentAttemptId,
          'Stripeからの確定的な失敗応答（' + createResult.errorType + '）', now
        );
      }
      if (!failAttemptResult.success) {
        return { success: false, error: failAttemptResult.error };
      }
      return {
        success: false,
        error: { code: 'STRIPE_REQUEST_ERROR', message: '決済処理を開始できませんでした。時間をおいて再度お試しください。' }
      };
    }

    /*
     * NETWORK/AMBIGUOUS/NOT_CONFIGURED: Stripe側で実際にSessionが作成された可能性を
     * 否定できない（あるいはそもそも呼び出せていない）。paymentStatusをFAILEDへ進めず
     * （＝次回もreservePaymentAttempt_が同じpaymentAttemptIdを再利用する）、監査記録のみ
     * 残して呼び出し元へ再試行を促す。
     */
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'STRIPE_CHECKOUT_SESSION_CREATE_UNKNOWN',
        occurredAt: now,
        calendarEventId: record.calendarEventId || '',
        status: record.status || '',
        errorMessage: 'Checkout Session作成の結果が確認できませんでした（' + createResult.errorType + '）: ' + (createResult.message || ''),
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }
    return {
      success: false,
      error: { code: 'PAYMENT_STATUS_UNKNOWN', message: '決済処理の状況を確認できませんでした。しばらくしてから再度お試しください。' },
      retryable: true
    };
  }

  /*
   * NOT_STARTED/FAILEDから新しい決済試行を開始する（Checkout Session発行→証跡コミット）。
   *
   * PR #354レビュー対応: Stripeへ送るリクエスト内容（checkoutParams）はreservePaymentAttempt_
   * が呼び出し時点で1回だけ確定・永続化したスナップショットをそのまま使う。ここで
   * CardPayment.computeExpectedPaymentAmount・record.email・stripeConfig.successUrl/
   * cancelUrl等を独自に取得し直さない（取得し直すと、同じpaymentAttemptId＝同じ
   * Idempotency-Keyのまま、料金修正・Script Properties変更等でStripeへ送る内容が初回と
   * 食い違ってしまう。Stripeは差異を検知するとidempotency_errorを返す）。
   */
  function startNewCheckoutAttempt_(bookingId, stripeConfig, now) {
    var reserveResult = reservePaymentAttempt_(bookingId, stripeConfig, now);
    if (!reserveResult.success) return reserveResult;
    var paymentAttemptId = reserveResult.paymentAttemptId;
    var checkoutParams = reserveResult.checkoutParams;

    var latest = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!latest) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
    }
    var record = latest.record;

    var createResult = StripeGateway.createCheckoutSession(stripeConfig, checkoutParams, paymentAttemptId);

    if (!createResult.ok) {
      return handleCheckoutCreateFailure_(bookingId, record, createResult, paymentAttemptId, now);
    }

    var session = createResult.session;
    /*
     * Issue #341本文「Session expires_atをこの仮押さえ期限と一致させる」を、Stripeの
     * レスポンスに含まれる実際のexpires_atをpaymentHoldExpiresAtへそのまま保存し直す
     * ことで実現する（CardPayment.gsファイル冒頭コメント・README「Issue #341」節参照。
     * 通常はcheckoutParams.expiresAtSecondsとStripeの応答は一致するはずだが、常に
     * Stripeの応答を正として保存する）。
     */
    var paymentHoldExpiresAt = new Date(session.expiresAtSeconds * 1000);

    /*
     * PR #354レビュー対応・3回目: Stripe呼び出しから結果が返るまでの間に、台帳の現在の
     * paymentAttemptIdが既に別の決済試行へ進んでいないかをcommit前に確認する（本来は
     * 起こらない想定だが、防御的に検知する）。確認せずCHECKOUT_PENDINGへコミットすると、
     * 新しい決済試行の証跡をこの古い応答（実際にはStripe側にSessionが作成済みで、
     * bookingId・paymentAttemptIdとしては孤立してしまう）で上書きしてしまう。stale
     * （既に別の決済試行IDへ進んでいる）の場合はコミットせず要復旧として停止する。
     */
    var latestBeforeCommit = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!latestBeforeCommit || latestBeforeCommit.record.paymentAttemptId !== paymentAttemptId) {
      return recordStalePaymentAttemptResponse_(
        bookingId, record, paymentAttemptId,
        'Checkout Session作成成功の応答（Stripe Session ID: ' + session.id + '）', now
      );
    }

    var commitResult = applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.CHECKOUT_PENDING, {
      paymentAttemptId: paymentAttemptId,
      /* この決済試行はcheckout_pendingへ進む結果に確定した。以後reservePaymentAttempt_が
         このIDを「未解決」として誤って再利用しないよう、コミットと同じ書き込みで確定させる
         （PR #354レビュー対応・3回目）。 */
      paymentAttemptResolvedAt: now,
      stripeCheckoutSessionId: session.id,
      paymentHoldExpiresAt: paymentHoldExpiresAt,
      stripeAmount: checkoutParams.amountJpy,
      stripeCurrency: checkoutParams.currency
    }, now);

    if (!commitResult.success) {
      /* paymentAttemptIdとスナップショット（checkoutParams全体）は既にreservePaymentAttempt_
         で永続化済みのため、呼び出し元の再試行は同じIdempotency-Key・同じリクエスト内容で
         Stripeへ到達し、同じSessionがそのまま返る（新しいSessionは作られない）。 */
      return { success: false, error: commitResult.error, retryable: true };
    }

    return {
      success: true,
      bookingId: bookingId,
      checkoutUrl: session.url,
      paymentHoldExpiresAt: paymentHoldExpiresAt,
      amount: checkoutParams.amountJpy,
      currency: checkoutParams.currency
    };
  }

  /*
   * currentPaymentStatus===CHECKOUT_PENDING（既にCheckout Sessionを発行済み）の予約への
   * 再アクセス。Issue #341本文「既存のSessionが有効なら再利用し、失効が確認できた場合
   * だけ、安全な新規試行を許可」「Stripe側で決済済みかどうか不明な場合は、新規発行を
   * 停止してRecoveryに記録」を、Stripe側の実際のSession状態を確認してから分岐することで
   * 満たす。
   */
  function resumeExistingCheckout_(record, stripeConfig, now) {
    var bookingId = record.bookingId;
    if (!record.stripeCheckoutSessionId) {
      /* applyPaymentStateUpdateの証跡検証によりCHECKOUT_PENDINGはstripeCheckoutSessionId
         を必ず伴うはずであり、通常到達しない防御的分岐。台帳側の不整合として扱う。 */
      recordPaymentRecoveryBestEffort_(
        bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
        '決済状態はcheckout_pendingですが、stripeCheckoutSessionIdが記録されていません。Bookingsを直接確認してください。',
        now
      );
      return { success: false, error: { code: 'PAYMENT_EVIDENCE_MISSING', message: '決済状態が不整合のため処理を停止しました。管理者の確認が必要です。' } };
    }

    var retrieveResult = StripeGateway.retrieveCheckoutSession(stripeConfig, record.stripeCheckoutSessionId);
    if (!retrieveResult.ok) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'STRIPE_SESSION_STATUS_UNKNOWN',
          occurredAt: now,
          calendarEventId: record.calendarEventId || '',
          status: record.status || '',
          errorMessage: 'Checkout Session状態の確認に失敗しました（' + retrieveResult.errorType + '）: ' + (retrieveResult.message || ''),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        success: false,
        error: { code: 'PAYMENT_STATUS_UNKNOWN', message: '決済状況を確認できませんでした。しばらくしてから再度お試しください。' },
        retryable: true
      };
    }

    var session = retrieveResult.session;

    if (session.status === 'open') {
      /* まだ決済可能なSessionが残っている。新しいSessionを発行せずこれを再利用する。 */
      return {
        success: true,
        bookingId: bookingId,
        checkoutUrl: session.url,
        paymentHoldExpiresAt: isDateLike_(record.paymentHoldExpiresAt) ? record.paymentHoldExpiresAt : new Date(session.expiresAtSeconds * 1000),
        reused: true
      };
    }

    if (session.status === 'complete' || session.paymentStatus === 'paid') {
      /*
       * 決済が完了している可能性がある。署名検証済みWebhookによる自動確定（PR-C）は
       * まだ存在しないため、ここで自動的に予約を確定させることはしない。新しいSessionも
       * 発行せず、恒久の要復旧ゲートを立てて管理者の確認を必須にする（Issue #341本文
       * 「決済が成立している可能性がある場合は、未払いと決めつけて枠を解放しない」の
       * 精神を、Session再利用の場面にも適用する）。
       */
      recordPaymentRecoveryBestEffort_(
        bookingId, record, 'CHECKOUT_SESSION_ALREADY_COMPLETED',
        'Stripe Checkout Session（' + record.stripeCheckoutSessionId + '）が既に完了/決済済みと報告されましたが、' +
          'Webhookによる自動確定（PR-C）が未実装のため自動処理を停止しました。Stripe管理画面で入金を確認し、' +
          '必要であれば手動で予約を確定してください。',
        now
      );
      return {
        success: false,
        error: { code: 'PAYMENT_POSSIBLY_COMPLETED', message: '決済が完了している可能性があります。しばらくしてからページを再読み込みいただくか、当店へお問い合わせください。' }
      };
    }

    if (session.status === 'expired' && session.paymentStatus === 'unpaid') {
      /*
       * Stripe側で確実に未払いのまま失効したことを確認できた。安全に新しい試行へ進める。
       *
       * PR #354レビュー対応・3回目（その1）: この失効したSessionのpaymentAttemptIdを、
       * failedへの遷移と同時にpaymentAttemptResolvedAtへ確定させる。これをしないと、
       * 直後に呼ぶstartNewCheckoutAttempt_（reservePaymentAttempt_）が、この古い
       * paymentAttemptIdを「まだ未解決」と誤認してそのまま再利用してしまう
       * （expirePendingBookings側の同種の失効遷移と同じ理由）。
       *
       * PR #354レビュー対応・3回目（その2）: 同一予約への2件のリクエストがほぼ同時に
       * ここへ到達し、両方がこの同じ古いSessionをStripeへ確認して両方とも「確実に
       * 未払いのまま失効」と判定するケースがある。retrieveCheckoutSessionの呼び出しから
       * 応答が返るまでの間に、もう一方が既にこの予約をfailedへ進めて新しい決済試行を
       * 開始・成功させている可能性があるため、failedへ遷移する直前に台帳の現在の
       * stripeCheckoutSessionId・paymentAttemptIdが、この応答の元になった値のまま
       * （＝まだ誰も先に進めていない）ことを確認する。既に変わっていた場合、ここで
       * failedへ進めると、もう一方が新しく開始した決済試行の証跡をこの古い確認結果で
       * 上書きしてしまう。何も書き込まずに呼び出し元へ再試行を促し、呼び出し元が最新の
       * 状態を読み直せば正しく分岐する（もう一方が開始した新しいSessionを再利用する等）。
       */
      var latestBeforeFail = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (
        !latestBeforeFail ||
        latestBeforeFail.record.stripeCheckoutSessionId !== record.stripeCheckoutSessionId ||
        latestBeforeFail.record.paymentAttemptId !== record.paymentAttemptId
      ) {
        return {
          success: false,
          error: { code: 'PAYMENT_STATUS_UNKNOWN', message: '決済状況を確認できませんでした。しばらくしてから再度お試しください。' },
          retryable: true
        };
      }

      var failResult = applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.FAILED, { paymentAttemptResolvedAt: now }, now);
      if (!failResult.success) {
        return { success: false, error: failResult.error };
      }
      return startNewCheckoutAttempt_(bookingId, stripeConfig, now);
    }

    /* 上記いずれにも該当しない（例: expiredだが決済状態が読み取れない）場合は安全側に倒し、
       新規発行を行わず監査記録のみ残す。 */
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'STRIPE_SESSION_STATUS_UNKNOWN',
        occurredAt: now,
        calendarEventId: record.calendarEventId || '',
        status: record.status || '',
        errorMessage: 'Checkout Sessionの状態を判定できませんでした（status=' + session.status + ', payment_status=' + session.paymentStatus + '）。',
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }
    return {
      success: false,
      error: { code: 'PAYMENT_STATUS_UNKNOWN', message: '決済状況を確認できませんでした。しばらくしてから再度お試しください。' },
      retryable: true
    };
  }

  /*
   * bookingIdだけでCheckout Sessionを開始・再取得できてしまう脆弱性を修正するための
   * 定数時間比較（PR #354レビュー対応・項目1）。文字列長で早期リターンする前段の比較は
   * 長さの違いというわずかな情報しか漏らさない（bookingId自体は既にURLやメールで
   * やり取りされる非機密の識別子であり、真に守るべきはトークンの中身であるため許容する）。
   * 空文字同士は絶対に一致させない（現金・PayPay予約はcheckoutAccessTokenが常に空文字の
   * ため、空文字を送るだけの攻撃で「トークン不要」な予約を偽装できてしまう事故を防ぐ）。
   */
  function tokensMatch_(claimed, expected) {
    if (typeof claimed !== 'string' || typeof expected !== 'string') return false;
    if (claimed.length === 0 || expected.length === 0) return false;
    if (claimed.length !== expected.length) return false;
    var diff = 0;
    for (var i = 0; i < claimed.length; i++) {
      diff |= claimed.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  }

  /*
   * beginCardCheckout(bookingId, checkoutAccessToken, now) — Booking Web App（Code.gs）
   * から呼ばれる、カード決済のCheckout Session発行の唯一の公開入口（Issue #341 PR-B）。
   *
   * 対象は既にcreateBookingでPENDING作成済みのカード決済予約のみ。フォーム送信自体
   * （PENDING作成）は既存のcreateBookingのまま変更しない（Issue #341本文の「既存予約との
   * 互換性確保」）。stripeConfig.checkoutEnabledが有効化されていない環境（既定＝本番）では
   * 常にCHECKOUT_DISABLEDを返し、呼び出し元（フロントエンド）は既存の「決済リンクを
   * 後日送付」フロー（Issue #334）へフォールバックする。
   *
   * checkoutAccessTokenはcreateBooking（カード決済のみ）が発行し、送信した本人のブラウザ
   * にのみ返す推測困難な値（PR #354レビュー対応・項目1）。bookingId・トークンのいずれかが
   * 一致しなければ、以降のいかなる予約情報（決済状態・金額等）も一切返さない。
   */
  function beginCardCheckout(bookingId, checkoutAccessToken, now) {
    now = isDateLike_(now) ? now : new Date();

    if (!bookingId || typeof bookingId !== 'string') {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }

    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.checkoutEnabled) {
      return { success: false, error: { code: 'CHECKOUT_DISABLED', message: '現在オンライン決済でのお申し込みは受け付けていません。' } };
    }
    if (!stripeConfig.secretKey || !stripeConfig.successUrl || !stripeConfig.cancelUrl) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: '決済機能が設定されていません。当店へお問い合わせください。' } };
    }

    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    /*
     * bookingIdが見つからない場合と、決済開始トークンが一致しない場合を、呼び出し元へは
     * 同じFORBIDDENとして返す（区別しない）。区別すると「このbookingIdは実在する/しない」
     * を推測できるオラクルになってしまう。
     */
    if (!found || !tokensMatch_(checkoutAccessToken, found.record.checkoutAccessToken)) {
      return { success: false, error: { code: 'FORBIDDEN', message: '予約が見つからないか、操作の権限がありません。' } };
    }
    var record = found.record;

    if (!Booking.isCardPaymentMethod(record.paymentMethod)) {
      return { success: false, error: { code: 'NOT_CARD_PAYMENT', message: 'カード決済の予約ではありません。' } };
    }
    if (record.status !== Booking.STATUS.PENDING) {
      return { success: false, error: { code: 'BOOKING_NOT_PENDING', message: 'この予約は決済待ちの状態ではありません。' } };
    }
    if (record.paymentRecoveryRequiredAt) {
      return { success: false, error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約は要復旧のため、自動処理を停止しています。当店へお問い合わせください。' } };
    }

    var currentPaymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    if (currentPaymentStatus === null) {
      recordPaymentRecoveryBestEffort_(
        bookingId, record, 'UNKNOWN_PAYMENT_STATUS',
        'paymentStatus列に既知のいずれの値とも一致しない値が入っています。Bookingsを直接確認してください。',
        now
      );
      return { success: false, error: { code: 'UNKNOWN_PAYMENT_STATUS', message: '決済状態が不明なため処理を停止しました。' } };
    }

    if (
      currentPaymentStatus === Booking.PAYMENT_STATUS.PAID ||
      currentPaymentStatus === Booking.PAYMENT_STATUS.REFUND_PENDING ||
      currentPaymentStatus === Booking.PAYMENT_STATUS.REFUNDED
    ) {
      return { success: false, error: { code: 'ALREADY_PAID', message: 'この予約は既に決済処理が完了しています。' } };
    }

    if (currentPaymentStatus === Booking.PAYMENT_STATUS.CHECKOUT_PENDING) {
      return resumeExistingCheckout_(record, stripeConfig, now);
    }

    /* NOT_STARTED または FAILED */
    return startNewCheckoutAttempt_(bookingId, stripeConfig, now);
  }

  return {
    createBooking: createBooking,
    confirmBooking: confirmBooking,
    expirePendingBookings: expirePendingBookings,
    reviveExpiredBooking: reviveExpiredBooking,
    cancelBookingAdmin: cancelBookingAdmin,
    updateBookingPrice: updateBookingPrice,
    applyPaymentStateUpdate: applyPaymentStateUpdate,
    beginCardCheckout: beginCardCheckout
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
