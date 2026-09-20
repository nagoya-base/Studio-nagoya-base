/*
 * BookingRepository.gs — createBooking / confirmBooking / expirePendingBookingsの
 * オーケストレーション（Issue #268）。CalendarRepository・SpreadsheetRepository・
 * RecoveryRepository・RateLimiter・Bookingを組み合わせる、GAS実行環境依存の本体。
 *
 * このファイル自体は1つだが、実際にどの関数がどのGASプロジェクトから呼ばれるかは
 * プロジェクトによって異なる（README「GASプロジェクトへのデプロイ対象ファイル」参照）:
 * - createBooking: Booking Web Appプロジェクト（Code.gsのdoPostから）
 * - confirmBooking / expirePendingBookings: Booking Adminプロジェクト
 *   （BookingAdmin.gs / BookingTriggers.gsから。両方とも同じプロジェクト内で動くため、
 *   LockService.getScriptLock()を共有し、互いに直列化される。3回目レビューで
 *   confirmBookingとexpirePendingBookingsを同一プロジェクトへ統合し、この2つの間の
 *   Lock非共有によるCalendar/Sheets不整合の可能性を構造的に解消した）
 *
 * createBookingの処理順（Issue #268本文どおり）:
 *   1. サーバー側入力検証        → Booking.validateCreateBookingInput
 *   2. abuse / rate limit確認    → RateLimiter.evaluate（Lockの外。ここで弾けばLock不要なため）
 *   3. LockService取得
 *   4. Calendarを最新状態で再取得 → CalendarRepository.getBusyIntervalsForDate
 *   5. 競合チェック              → BookingAvailability.isStartTimeBookable
 *   6. bookingId発行
 *   7. CalendarにPENDINGイベント作成
 *   8. Spreadsheet台帳へ保存
 *   9. Lock解除
 *  10. 管理者通知（Lockの外。通知失敗は予約失敗として扱わない）
 *
 * クリティカルセクション（Lockで保護する範囲）は4〜8のみ。入力検証・rate limit確認・
 * 通知はLockの外。
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

  function createBooking(rawInput, now) {
    now = isDateLike_(now) ? now : new Date();

    var availabilityConfig = BookingConfig.getAvailabilityConfig();
    var validation = Booking.validateCreateBookingInput(rawInput, availabilityConfig, now);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    var input = validation.normalized;

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
        status: Booking.STATUS.PENDING,
        calendarEventId: eventId,
        source: input.source,
        note: input.note
      };

      try {
        SpreadsheetRepository.appendBooking(record);
      } catch (sheetsError) {
        return handleSheetsSaveFailure_(calendarId, bookingId, eventId, sheetsError);
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
      brand: input.brand
    };
  }

  /* 送信失敗はcreateBooking自体の成否に影響させない（BookingMailer側で既にSentAt確認・
     lastMailError記録まで行うため、ここでは想定外の例外だけをLoggerへ残す）。 */
  function notifyCustomerPendingBestEffort_(record) {
    try {
      BookingMailer.sendPendingMailForBooking(record.bookingId);
    } catch (mailError) {
      Logger.log('BookingRepository: PENDINGメール送信中に予期しない例外: ' + describeError_(mailError));
    }
  }

  /* Calendar成功 / Sheets失敗の部分失敗補償。Calendarイベントの削除を試み、
     成功/失敗いずれの場合もrecoveryへ記録して人が追跡できるようにする。 */
  function handleSheetsSaveFailure_(calendarId, bookingId, eventId, sheetsError) {
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
        status: compensated ? 'COMPENSATED' : 'NEEDS_MANUAL_RECOVERY',
        errorMessage: describeError_(sheetsError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
    } catch (recoveryError) {
      /* recovery記録自体の失敗は最後の砦としてLoggerへ残すのみ（ここで例外を投げると
         利用者への応答自体が失敗するため、必ず握りつぶす）。 */
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }

    return {
      success: false,
      error: { code: 'BOOKING_SAVE_FAILED', message: '予約の保存に失敗しました。しばらくしてから再度お試しください。' }
    };
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
    if (!Booking.canTransition(record.status, Booking.STATUS.CONFIRMED)) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CONFIRMED へは遷移できません。' }
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
      Logger.log('BookingRepository: CONFIRMEDメール送信中に予期しない例外: ' + describeError_(mailError));
      response.mailSent = false;
      response.mailError = { code: 'UNEXPECTED_ERROR', message: describeError_(mailError) };
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
      var minHoldHours = isSameDayBooking ? ttlConfig.minHoldHours : 0;

      if (!Booking.isExpired(createdAtMillis, startAtMillis, ttlConfig.ttlHours, ttlConfig.minHoursBeforeStart, now.getTime(), minHoldHours)) {
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

    return { expiredCount: expiredCount, skippedCount: skippedCount, candidateCount: candidates.length };
  }

  return {
    createBooking: createBooking,
    confirmBooking: confirmBooking,
    expirePendingBookings: expirePendingBookings
  };
})();
