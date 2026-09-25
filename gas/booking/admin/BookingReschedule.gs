/* Issue #344: Booking Admin専用。公開Booking Web Appへ配置しない。
 * 料金は現行Bookingsに金額列がないため変更しない。料金差額は管理者の別途精算。
 */
'use strict';

var BookingReschedule = (function () {
  var HISTORY_SHEET_ = 'BookingChanges';
  var HISTORY_HEADERS_ = [
    'changeId', 'bookingId', 'changedAt', 'oldDate', 'oldStartAt', 'oldEndAt',
    'newDate', 'newStartAt', 'newEndAt', 'reason', 'feeNote', 'mailState', 'mailAt', 'mailError'
  ];

  function error_(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  function isDate_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
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

  function preview(bookingId, input, expectedVersion) {
    try {
      var check = parse_(bookingId, input, expectedVersion, new Date());
      if (!check.success) return check;
      return {
        success: true, bookingId: bookingId, expectedVersion: check.version,
        oldDate: BookingAvailability.formatDateInTimezone(check.record.startAt, check.timezone),
        oldStartTime: BookingAvailability.formatTimeInTimezone(check.record.startAt, check.timezone),
        oldEndTime: BookingAvailability.formatTimeInTimezone(check.record.endAt, check.timezone),
        newDate: check.date, newStartTime: input.startTime, newEndTime: input.endTime,
        durationMinutes: check.durationMinutes,
        feeNotice: '料金差額は自動計算されません。変更確定前に管理者が確認してください。'
      };
    } catch (e) {
      return error_('PREVIEW_FAILED', '空き状況の確認に失敗しました。');
    }
  }

  /* 日時・予約IDを保持する。変更記録の生成失敗時には予定と台帳を戻す。
   * Web AppのcreateBookingとはscript lock非共有のため、確定直前にもCalendarを取得する。
   */
  function commit(bookingId, input, expectedVersion, reason, feeNote) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) return error_('LOCK_TIMEOUT', '処理中です。再試行してください。');
    var outcome;
    try {
      var check = parse_(bookingId, input, expectedVersion, new Date());
      if (!check.success) return check;
      var record = check.record;
      var oldDate = BookingAvailability.formatDateInTimezone(record.startAt, check.timezone);
      var oldStartAt = record.startAt;
      var oldEndAt = record.endAt;
      var changeId = Utilities.getUuid();
      var sheet = history_(); // 変更前に履歴記録先を確保
      var rowNumber = sheet.getLastRow() + 1;
      var safeReason = String(reason || '').slice(0, 500);
      var safeFeeNote = String(feeNote || '料金差額がある場合は運営から別途ご案内します。').slice(0, 500);
      sheet.appendRow([
        changeId, bookingId, new Date(), oldDate, oldStartAt, oldEndAt,
        check.date, check.startAt, check.endAt, safeReason, safeFeeNote, 'PREPARED', '', ''
      ]);
      try {
        check.own.setTime(check.startAt, check.endAt);
      } catch (calendarError) {
        sheet.getRange(rowNumber, 12).setValue('CHANGE_FAILED');
        return error_('CALENDAR_UPDATE_FAILED', 'Calendar更新に失敗しました。');
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
        sheet.getRange(rowNumber, 12).setValue('PENDING');
      } catch (historyError) {
        logFailure_(bookingId, 'RESCHEDULE_HISTORY_UPDATE_FAILED', record.status);
        return { success: true, bookingId: bookingId, changeId: changeId,
          mailSent: false, warning: '日時は変更されましたが履歴更新に失敗しました。通知は送らずRecoveryを確認してください。' };
      }
      outcome = { success: true, bookingId: bookingId, changeId: changeId, mailSent: false };
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
      var mail = {
        to: found.record.email,
        subject: '【' + brand + '】予約日時変更のお知らせ',
        body: [
          found.record.name + ' 様', '', 'ご予約の日時変更が確定しました。',
          '予約ID: ' + row[1],
          '変更前: ' + oldDateText + ' ' + oldStart + '〜' + oldEnd,
          '変更後: ' + newDateText + ' ' + newStart + '〜' + newEnd,
          '利用時間: ' + Math.round((row[8].getTime() - row[7].getTime()) / 60000) + '分',
          '料金・精算: ' + row[10], '', 'お問い合わせ: ' + config.contactEmail
        ].join('\n'),
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
        feeNote: row[10]
      };
    }).reverse();
  }

  return { preview: preview, commit: commit, sendMail: sendMail, getChanges: getChanges };
})();

/* Booking Admin Web App専用のgoogle.script.run公開関数。 */
function adminPreviewBookingReschedule(bookingId, input, expectedVersion) {
  return BookingReschedule.preview(bookingId, input, expectedVersion);
}
function adminRescheduleBooking(bookingId, input, expectedVersion, reason, feeNote) {
  return BookingReschedule.commit(bookingId, input, expectedVersion, reason, feeNote);
}
function adminResendRescheduleMail(changeId) {
  return BookingReschedule.sendMail(changeId, true);
}
function adminGetBookingChanges(bookingId) {
  return BookingReschedule.getChanges(bookingId);
}
