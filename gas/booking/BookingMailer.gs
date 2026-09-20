/*
 * BookingMailer.gs — 利用者向けメールの送信制御（Issue #271）。
 *
 * 責務:
 * - SentAt確認 / status再確認による冪等性（二重送信防止）
 * - LockService.getScriptLock()による同一プロジェクト内の直列化
 * - MailApp呼び出しとSheets送信履歴（SentAt）の更新
 * - 送信失敗時のlastMailError* / RecoveryRepositoryへの記録（予約状態は一切変更しない）
 * - 管理者による明示的な個別再送（force）
 *
 * 件名・本文の組み立てはBookingMailTemplates.gs（純粋関数）に委譲し、ここでは
 * 「送るかどうか」「送った結果をどう記録するか」の制御のみを行う。
 *
 * 重要（Issue #271本文どおり）:
 * - メール送信失敗（設定不足によるfail-closedな拒否を含む）はbooking自体のstatusを
 *   一切変更しない。Calendar/Sheetsのbooking状態はこのファイルからは触らない
 *   （lastMailError*とRecoveryのみ更新する）。
 * - キャンセルメール（sendCancelledMailForBooking）は、この#271では「CANCELLED状態の
 *   予約に送れる関数」を用意するのみ。実際にキャンセル成功後に呼ぶ配線は#272の責務であり、
 *   このファイルからCalendar/Sheetsのキャンセル処理を開始することはない。
 */
'use strict';

var BookingMailer = (function () {
  var LOCK_TIMEOUT_MS_ = 10000;

  var MAIL_TYPES = {
    PENDING: 'PENDING',
    CONFIRMED: 'CONFIRMED',
    CANCELLED: 'CANCELLED',
    REMINDER: 'REMINDER'
  };

  function describeError_(error) {
    return String((error && error.message) || error);
  }

  /* Recovery/lastMailErrorへ残すメッセージは、例外のmessageのみを使い、メール本文全文や
     秘密値（解錠コード等）を含めない。念のため長さも制限する（Issue #271「セキュリティ」節）。 */
  function sanitizeErrorMessage_(message) {
    return String(message || '').slice(0, 500);
  }

  /* メール失敗はbooking状態を一切壊さない。lastMailError*への記録・Recoveryへの記録は
     いずれもbest effortとし、ここでの失敗はLoggerへ残すだけで上位へ例外を投げない。
     status（PRレビュー対応）: Recoveryシートのstatus列は予約状態の監査情報のため、
     mailType（メール種別）を入れず、必ずbookingIdの現在の予約status（呼び出し側が
     再読込済みのrecord.status）を渡すこと。 */
  function recordMailFailure_(bookingId, mailType, error, status) {
    var now = new Date();
    var message = sanitizeErrorMessage_(describeError_(error));
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        lastMailErrorAt: now,
        lastMailErrorType: mailType,
        lastMailErrorMessage: message
      });
    } catch (sheetsError) {
      Logger.log('BookingMailer: lastMailError更新に失敗しました: ' + describeError_(sheetsError));
    }
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'MAIL_' + mailType + '_FAILED',
        occurredAt: now,
        status: status,
        errorMessage: message,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('BookingMailer: RecoveryRepository.recordFailure失敗: ' + describeError_(recoveryError));
    }
  }

  /*
   * PRレビュー対応: displayName/replyTo/contactEmailの3項目だけでなく、timezoneも
   * 実際にIntlで解釈可能であることを確認する（fail-closed）。timezoneが未設定・
   * 不正な文字列のままメールを送ると、Intl.DateTimeFormatがGAS実行環境の既定
   * timezoneへフォールバックし、開始/終了時刻の表示がJSTからずれる事故につながるため、
   * 単に空文字でないことのチェックに留めず、BookingAvailability.formatDateInTimezone
   * （既存の空き判定・当日判定と同じtimezone解釈ロジック）で実際に解釈できることまで確認する。
   */
  function ensureMailConfigComplete_() {
    var config = BookingConfig.getMailConfig();
    if (!config.displayName || !config.replyTo || !config.contactEmail) {
      throw new Error(
        'Script PropertiesにBOOKING_MAIL_DISPLAY_NAME / BOOKING_MAIL_REPLY_TO / BOOKING_CONTACT_EMAILが未設定です。'
      );
    }
    if (!BookingAvailability.formatDateInTimezone(new Date(), config.timezone)) {
      throw new Error('Script PropertiesのTIMEZONEが不正です: ' + config.timezone);
    }
    return config;
  }

  /*
   * PRレビュー対応: 秘密値（keyboxNumber/unlockCode）だけでなく、Issue #271の
   * 前日リマインド必須内容（住所・建物・部屋・入口案内・キーボックス位置・入室方法・
   * 利用案内URL）もすべて設定済みであることを確認する（fail-closed。前日案内を
   * 「来場方法を含む案内」として成立させるための必須項目一式）。
   * ACCESS_GUIDE_PDF_URLは「必要に応じて」のため必須にしない。
   */
  var REQUIRED_ACCESS_GUIDE_FIELDS_ = {
    address: 'ACCESS_GUIDE_ADDRESS',
    building: 'ACCESS_GUIDE_BUILDING',
    room: 'ACCESS_GUIDE_ROOM',
    entrance: 'ACCESS_GUIDE_ENTRANCE',
    keyboxLocation: 'ACCESS_GUIDE_KEYBOX_LOCATION',
    entryMethod: 'ACCESS_GUIDE_ENTRY_METHOD',
    keyboxNumber: 'ACCESS_GUIDE_KEYBOX_NUMBER',
    unlockCode: 'ACCESS_GUIDE_UNLOCK_CODE',
    url: 'ACCESS_GUIDE_URL'
  };

  function ensureAccessGuideComplete_(guide) {
    var missing = [];
    Object.keys(REQUIRED_ACCESS_GUIDE_FIELDS_).forEach(function (key) {
      if (!guide[key]) missing.push(REQUIRED_ACCESS_GUIDE_FIELDS_[key]);
    });
    if (missing.length) {
      throw new Error('来場案内に必要なScript Propertiesが未設定です: ' + missing.join(', '));
    }
  }

  /*
   * mailType: MAIL_TYPESのいずれか
   * requiredStatus: このstatusの予約にだけ送信できる（Booking.STATUS参照）
   * sentAtFields: 送信済み判定・成功時に同時更新するSheetsフィールド名の配列
   *   （REMINDERのみ['reminderSentAt', 'accessGuideSentAt']の2つ。他は1つ）
   * force: true の場合、SentAtが既にあっても送信する（管理者の明示的な再送のみで使う）。
   *   ただしstatus不一致は force でも無視しない。
   * buildTemplateFn(record): { subject, body } を返す。設定不足等で送信できない場合は
   *   例外を投げる（この関数側でrecordMailFailure_・fail-closedな結果へ変換する）。
   *
   * 処理順序（Issue #271「9. 自動送信と二重送信防止」どおり）:
   *   Lock取得 → 最新レコード再読込 → status確認 → SentAt確認 → テンプレート生成 →
   *   MailApp送信 → 送信成功 → SentAt更新 → lastMailError*クリア → Lock解除
   */
  function withBookingLock_(mailType, bookingId, requiredStatus, sentAtFields, force, buildTemplateFn) {
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

      if (record.status !== requiredStatus) {
        return {
          success: false,
          skipped: true,
          bookingId: bookingId,
          mailType: mailType,
          error: {
            code: 'INVALID_STATUS',
            message: record.status + ' の予約には' + mailType + 'メールを送信できません（' + requiredStatus + 'のみ対象）。'
          }
        };
      }

      var alreadySent = sentAtFields.some(function (field) { return !!record[field]; });
      if (alreadySent && !force) {
        return { success: true, skipped: true, reason: 'ALREADY_SENT', bookingId: bookingId, mailType: mailType };
      }

      var mail;
      try {
        mail = buildTemplateFn(record);
      } catch (buildError) {
        recordMailFailure_(bookingId, mailType, buildError, record.status);
        return { success: false, error: { code: 'MAIL_NOT_READY', message: describeError_(buildError) } };
      }

      var mailConfig = BookingConfig.getMailConfig();
      try {
        MailApp.sendEmail({
          to: record.email,
          subject: mail.subject,
          body: mail.body,
          name: mailConfig.displayName,
          replyTo: mailConfig.replyTo
        });
      } catch (sendError) {
        recordMailFailure_(bookingId, mailType, sendError, record.status);
        return { success: false, error: { code: 'MAIL_SEND_FAILED', message: describeError_(sendError) } };
      }

      var sentAt = new Date();
      var updateFields = { lastMailErrorAt: '', lastMailErrorType: '', lastMailErrorMessage: '' };
      sentAtFields.forEach(function (field) { updateFields[field] = sentAt; });
      try {
        SpreadsheetRepository.updateBookingFields(bookingId, updateFields);
      } catch (sheetsError) {
        /* メール送信自体は成功済み。SentAt記録に失敗しても、少なくとも例外は投げず
           Loggerへ残す（実際上は次回自動送信が再送を試み、二重送信の可能性が残る旨は
           README「制約」節に明記する）。 */
        Logger.log('BookingMailer: SentAt更新に失敗しました（メール送信自体は成功）: ' + describeError_(sheetsError));
      }

      return { success: true, bookingId: bookingId, mailType: mailType, sentAt: sentAt };
    } finally {
      lock.releaseLock();
    }
  }

  function sendPendingMailForBooking(bookingId, options) {
    var opts = options || {};
    return withBookingLock_(MAIL_TYPES.PENDING, bookingId, Booking.STATUS.PENDING, ['pendingMailSentAt'], !!opts.force, function (record) {
      var config = ensureMailConfigComplete_();
      return BookingMailTemplates.buildPendingMail(record, config);
    });
  }

  function sendConfirmedMailForBooking(bookingId, options) {
    var opts = options || {};
    return withBookingLock_(MAIL_TYPES.CONFIRMED, bookingId, Booking.STATUS.CONFIRMED, ['confirmedMailSentAt'], !!opts.force, function (record) {
      var config = ensureMailConfigComplete_();
      return BookingMailTemplates.buildConfirmedMail(record, config);
    });
  }

  /*
   * #271では「CANCELLED状態の予約に送れる」共通関数を用意するのみ。
   * PENDING → CANCELLED の状態遷移自体（Calendar削除等）は#272がキャンセル処理完了後に
   * この関数を呼ぶ前提で、ここでは一切の状態遷移を行わない。
   */
  function sendCancelledMailForBooking(bookingId, options) {
    var opts = options || {};
    return withBookingLock_(MAIL_TYPES.CANCELLED, bookingId, Booking.STATUS.CANCELLED, ['cancelMailSentAt'], !!opts.force, function (record) {
      var config = ensureMailConfigComplete_();
      return BookingMailTemplates.buildCancelledMail(record, config);
    });
  }

  /*
   * 前日リマインド + 来場案内を1通にまとめて送る。reminderSentAt/accessGuideSentAtの
   * 両方が空の場合のみ送信対象とし、成功時は両方を同じ時刻で更新する。
   * 「利用日 === 翌日」の判定はBookingReminderTriggers.sendNextDayReminders側の責務
   * （抽出はSpreadsheetRepository.getConfirmedBookingsForDateで行う）。ここでは
   * status===CONFIRMEDであることのみを再確認する。
   */
  function sendReminderMailForBooking(bookingId, options) {
    var opts = options || {};
    return withBookingLock_(
      MAIL_TYPES.REMINDER,
      bookingId,
      Booking.STATUS.CONFIRMED,
      ['reminderSentAt', 'accessGuideSentAt'],
      !!opts.force,
      function (record) {
        var config = ensureMailConfigComplete_();
        var guide = BookingConfig.getAccessGuideConfig();
        ensureAccessGuideComplete_(guide);
        return BookingMailTemplates.buildReminderMail(record, config, guide);
      }
    );
  }

  return {
    MAIL_TYPES: MAIL_TYPES,
    sendPendingMailForBooking: sendPendingMailForBooking,
    sendConfirmedMailForBooking: sendConfirmedMailForBooking,
    sendCancelledMailForBooking: sendCancelledMailForBooking,
    sendReminderMailForBooking: sendReminderMailForBooking
  };
})();
