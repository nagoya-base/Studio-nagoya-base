/*
 * BookingRepository.gs — createBooking / confirmBooking / expirePendingBookingsの
 * オーケストレーション（Issue #268）。CalendarRepository・SpreadsheetRepository・
 * RecoveryRepository・RateLimiter・Bookingを組み合わせる、GAS実行環境依存の本体。
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
 * リスクを最小化する」設計）。
 */
'use strict';

var BookingRepository = (function () {
  var LOCK_TIMEOUT_MS_ = 10000;
  var EXPIRE_LOCK_TIMEOUT_MS_ = 5000;

  function createBooking(rawInput, now) {
    now = isDateLike_(now) ? now : new Date();

    var availabilityConfig = BookingConfig.getAvailabilityConfig();
    var validation = Booking.validateCreateBookingInput(rawInput, availabilityConfig);
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
   * confirmBooking(bookingId) — Spreadsheetのカスタムメニュー（BookingAdmin.gs）から呼ばれる
   * 正式な確定手順。PENDINGのみCONFIRMEDへ遷移できる。既にCONFIRMED済みなら
   * 何もせず成功扱いにする（二重実行しても壊れない）。
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

    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
      }

      var record = found.record;
      if (record.status === Booking.STATUS.CONFIRMED) {
        return { success: true, alreadyConfirmed: true, bookingId: bookingId, status: Booking.STATUS.CONFIRMED };
      }
      if (!Booking.canTransition(record.status, Booking.STATUS.CONFIRMED)) {
        return {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CONFIRMED へは遷移できません。' }
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
          success: false,
          error: { code: 'CALENDAR_EVENT_MISSING', message: '対応するCalendarイベントが見つかりません。Recoveryシートを確認してください。' }
        };
      }

      CalendarRepository.setEventStatus(calendarId, record.calendarEventId, Booking.STATUS.CONFIRMED, bookingId);

      var confirmedAt = new Date();
      SpreadsheetRepository.updateBookingFields(bookingId, {
        status: Booking.STATUS.CONFIRMED,
        confirmedAt: confirmedAt,
        updatedAt: confirmedAt
      });

      return { success: true, bookingId: bookingId, status: Booking.STATUS.CONFIRMED };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * expirePendingBookings() — 時間主導トリガーから呼ばれるTTL失効処理（BookingTriggers.gs参照）。
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

      if (!Booking.isExpired(createdAtMillis, startAtMillis, ttlConfig.ttlHours, ttlConfig.minHoursBeforeStart, now.getTime())) {
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
        SpreadsheetRepository.updateBookingFields(record.bookingId, {
          status: Booking.STATUS.EXPIRED,
          expiredAt: expiredAt,
          updatedAt: expiredAt
        });
        expiredCount++;
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
