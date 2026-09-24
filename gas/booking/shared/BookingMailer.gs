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

  /* MailApp/Gmail側の例外メッセージに受信者メールアドレスが含まれることがあるため、
     一般的なメールアドレス形式を検出して置換する（PRレビュー対応）。 */
  var EMAIL_REDACTION_PATTERN_ = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  /*
   * Recovery/lastMailErrorへ残すメッセージは、例外のmessageのみを使い、メール本文全文を
   * 含めない（Issue #271「セキュリティ」節）。加えて（PRレビュー対応）:
   * - メールアドレス形式は常に'[REDACTED_EMAIL]'へ置換する
   * - extraRedactions（呼び出し側が渡す解錠コード・キーボックス番号等の秘密値）が
   *   万一エラーメッセージへ混入していた場合も'[REDACTED]'へ置換する
   * 置換後に長さを制限する。
   */
  function sanitizeErrorMessage_(message, extraRedactions) {
    var sanitized = String(message || '').replace(EMAIL_REDACTION_PATTERN_, '[REDACTED_EMAIL]');
    (extraRedactions || []).forEach(function (secret) {
      if (!secret) return;
      sanitized = sanitized.split(secret).join('[REDACTED]');
    });
    return sanitized.slice(0, 500);
  }

  /* メール失敗はbooking状態を一切壊さない。lastMailError*への記録・Recoveryへの記録は
     いずれもbest effortとし、ここでの失敗はLoggerへ残すだけで上位へ例外を投げない。
     status（PRレビュー対応）: Recoveryシートのstatus列は予約状態の監査情報のため、
     mailType（メール種別）を入れず、必ずbookingIdの現在の予約status（呼び出し側が
     再読込済みのrecord.status）を渡すこと。
     extraRedactions（PRレビュー対応）: REMINDER送信時のkeyboxNumber/unlockCode等、
     エラーメッセージへ混入すると困る秘密値の配列。省略可（PENDING/CONFIRMED/
     CANCELLEDでは渡さない）。 */
  function recordMailFailure_(bookingId, mailType, error, status, extraRedactions) {
    var now = new Date();
    var message = sanitizeErrorMessage_(describeError_(error), extraRedactions);
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        lastMailErrorAt: now,
        lastMailErrorType: mailType,
        lastMailErrorMessage: message
      });
    } catch (sheetsError) {
      Logger.log('BookingMailer: lastMailError更新に失敗しました: ' + sanitizeErrorMessage_(describeError_(sheetsError), extraRedactions));
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
      Logger.log('BookingMailer: RecoveryRepository.recordFailure失敗: ' + sanitizeErrorMessage_(describeError_(recoveryError), extraRedactions));
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
   * status/SentAt確認のみを行う副作用のない判定（Issue #330）。withBookingLock_から
   * 抽出した純粋関数で、本番の4メール種別すべてがここを通る。record.statusが
   * requiredStatusと一致しない場合はINVALID_STATUS、sentAtFieldsのいずれかが
   * 既に埋まっていてforceでない場合はALREADY_SENTを返す。それ以外はok:trueを返す。
   * Issue #330の診断側（BookingReminderDiagnostics.gs）もevaluateReminderEligibility_
   * 経由でこの関数をそのまま再利用し、REMINDER向けの判定ロジックを複製しない。
   */
  function evaluateStatusAndSentAt_(record, requiredStatus, sentAtFields, force) {
    if (record.status !== requiredStatus) {
      return { ok: false, reasonCode: 'INVALID_STATUS' };
    }
    var alreadySent = sentAtFields.some(function (field) { return !!record[field]; });
    if (alreadySent && !force) {
      return { ok: false, reasonCode: 'ALREADY_SENT' };
    }
    return { ok: true };
  }

  /* REMINDERのsentAtFields（reminderSentAt/accessGuideSentAt）。sendReminderMailForBooking
     （本番）とevaluateReminderEligibility_（診断）の両方がこの1箇所だけを参照する
     （Issue #330。値を2箇所に書かない）。 */
  var REMINDER_SENT_AT_FIELDS_ = ['reminderSentAt', 'accessGuideSentAt'];

  /* Issue #330の診断UI・テストで固定して使う理由コード。ELIGIBLE以外はすべて
     「送信しない理由」を表す。優先順位（上から順に判定。複数該当する場合は最初に
     一致したものを返す）はevaluateReminderEligibility_のコメントを参照。 */
  var REMINDER_REASON_CODES = {
    NOT_NEXT_DAY: 'NOT_NEXT_DAY',
    INVALID_STATUS: 'INVALID_STATUS',
    ALREADY_SENT: 'ALREADY_SENT',
    EMAIL_MISSING: 'EMAIL_MISSING',
    MAIL_NOT_READY: 'MAIL_NOT_READY',
    ELIGIBLE: 'ELIGIBLE'
  };

  /*
   * record.dateがDate値として保存されていた場合に備え、timezone基準の'YYYY-MM-DD'へ
   * 正規化してから比較できるようにする（Issue #330 PRレビュー対応）。Sheetsは
   * 日付らしい文字列をセルへ書き込むと読み込み時にDate値として返すことがあるため
   * （BookingAdminWeb.gsのformatAdminDate_と同じ既知の注意点）、record.dateがDate値の
   * 場合に文字列のtargetDateStringとの`!==`比較が型の違いだけで常にtrueになり、
   * NOT_NEXT_DAYを誤検知してしまう事故を防ぐ。record.date自体は書き換えない
   * （比較用の一時変数としてのみ使う）。
   */
  function normalizeReminderDate_(value, timezone) {
    if (value && typeof value.getTime === 'function' && !isNaN(value.getTime())) {
      return BookingAvailability.formatDateInTimezone(value, timezone) || '';
    }
    return value || '';
  }

  /*
   * 前日リマインドの対象判定・設定不足判定を1箇所へ集約した副作用のない判定関数
   * （Issue #330本文「必須設計：本番判定との共通化」）。本番の自動送信・管理者個別
   * 再送・診断のすべてがこの関数を呼ぶ（Issue #330レビュー対応。以前は診断からのみ
   * 呼ばれ、本番のwithBookingLock_はevaluateStatusAndSentAt_しか呼んでいなかった）。
   *
   * options:
   *   targetDateString（省略可）: 指定した場合のみNOT_NEXT_DAYを判定する。本番の
   *     自動送信（sendNextDayReminders）は計算した翌日日付をそのまま渡す
   *     （SpreadsheetRepository.getConfirmedBookingsForDateで既に翌日のCONFIRMED
   *     予約だけに絞り込まれているため、通常はここで不一致にならない防御的な
   *     再確認になる）。既存の管理者個別再送（BookingAdmin.gsの「予約メールを
   *     再送」。force:true）は特定の日付を対象にしない既存機能のため省略する
   *     （＝この判定を経由しない。外部挙動を変更しないための対応）。診断
   *     （BookingReminderDiagnostics.gs）は必ず基準日から計算した翌日日付を渡す。
   *   force（省略可。既定false）: trueの場合、ALREADY_SENTを無視する
   *     （管理者個別再送と同じ意味。診断は常にforceを渡さない＝falseのまま）。
   *
   * 判定順序（優先順位。最初に一致したものを返す）:
   *   NOT_NEXT_DAY → INVALID_STATUS → ALREADY_SENT → EMAIL_MISSING → MAIL_NOT_READY → ELIGIBLE
   * - status/SentAt判定はevaluateStatusAndSentAt_（withBookingLock_の既定判定と共通）を使う。
   * - メール本文に予約者のメールアドレスが必須なため、EMAIL_MISSINGを判定に含める
   *   （本番のcreateBooking入力検証で通常は空にならないが、Sheetsの手動編集や
   *   診断の任意bookingId指定に備えたフェイルセーフ）。
   * - 設定不足判定は、既存のensureMailConfigComplete_/ensureAccessGuideComplete_を
   *   そのまま呼ぶ（例外をtry/catchしてMAIL_NOT_READYへ変換するのみで、判定条件
   *   自体は複製しない）。
   */
  function evaluateReminderEligibility_(record, options) {
    var opts = options || {};
    var timezone = BookingConfig.getAvailabilityConfig().timezone;

    if (opts.targetDateString && normalizeReminderDate_(record.date, timezone) !== opts.targetDateString) {
      return {
        eligible: false,
        reasonCode: REMINDER_REASON_CODES.NOT_NEXT_DAY,
        message: '利用日（' + (record.date || '未設定') + '）が翌日（' + opts.targetDateString + '）ではありません。'
      };
    }

    var basicEligibility = evaluateStatusAndSentAt_(record, Booking.STATUS.CONFIRMED, REMINDER_SENT_AT_FIELDS_, !!opts.force);
    if (!basicEligibility.ok && basicEligibility.reasonCode === 'INVALID_STATUS') {
      return {
        eligible: false,
        reasonCode: REMINDER_REASON_CODES.INVALID_STATUS,
        message: (record.status || '未設定') + ' の予約には前日リマインドを送信できません（CONFIRMEDのみ対象）。'
      };
    }
    if (!basicEligibility.ok && basicEligibility.reasonCode === 'ALREADY_SENT') {
      return {
        eligible: false,
        reasonCode: REMINDER_REASON_CODES.ALREADY_SENT,
        message: '前日リマインドは送信済みです。'
      };
    }

    if (!record.email) {
      return {
        eligible: false,
        reasonCode: REMINDER_REASON_CODES.EMAIL_MISSING,
        message: '予約者のメールアドレスが登録されていません。'
      };
    }

    try {
      ensureMailConfigComplete_();
    } catch (mailConfigError) {
      return {
        eligible: false,
        reasonCode: REMINDER_REASON_CODES.MAIL_NOT_READY,
        message: sanitizeErrorMessage_(describeError_(mailConfigError))
      };
    }

    var guide = BookingConfig.getAccessGuideConfig();
    try {
      ensureAccessGuideComplete_(guide);
    } catch (guideError) {
      return {
        eligible: false,
        reasonCode: REMINDER_REASON_CODES.MAIL_NOT_READY,
        message: sanitizeErrorMessage_(describeError_(guideError), [guide.keyboxNumber, guide.unlockCode])
      };
    }

    return { eligible: true, reasonCode: REMINDER_REASON_CODES.ELIGIBLE, message: '送信対象です。' };
  }

  /*
   * REMINDER専用の事前判定（Issue #330レビュー対応）。withBookingLock_の既定判定
   * （defaultMailEligibilityCheck_。status/SentAtのみ）の代わりにこちらを渡すことで、
   * 本番のsendReminderMailForBookingもevaluateReminderEligibility_（NOT_NEXT_DAY/
   * INVALID_STATUS/ALREADY_SENT/EMAIL_MISSING/MAIL_NOT_READY）を実際に使って
   * 送信可否を決める。戻り値の形（ok/outcome）はwithBookingLock_の契約に合わせる。
   *
   * - INVALID_STATUS/ALREADY_SENTは、既存のwithBookingLock_が返してきたレスポンスと
   *   完全に同じ形へ変換する（既存挙動を変更しないため）。
   * - NOT_NEXT_DAYは新規の理由コードのため、INVALID_STATUSと同じ「対象外スキップ」の
   *   形（success:false, skipped:true）で返す。既存のrecordMailFailure_は呼ばない
   *   （本番の自動送信では候補抽出時点で既に翌日のCONFIRMED予約に絞り込まれており
   *   実際にはほぼ発生しない防御的分岐のため、INVALID_STATUSと同じ「対象外」の
   *   スキップ扱いとし、障害記録は起こさない）。
   * - EMAIL_MISSING/MAIL_NOT_READYは、実際に送信できない状態を表す新規の失敗理由の
   *   ため、既存のMAIL_NOT_READY/MAIL_SEND_FAILEDと同じくrecordMailFailure_で記録し、
   *   lastMailError*・Recoveryへ既存と同じ形で残す。
   */
  function reminderEligibilityCheck_(mailType, bookingId, requiredStatus, sentAtFields, force, record, targetDateString) {
    var evaluation = evaluateReminderEligibility_(record, { targetDateString: targetDateString, force: force });
    if (evaluation.eligible) return { ok: true };

    if (evaluation.reasonCode === REMINDER_REASON_CODES.INVALID_STATUS) {
      return {
        ok: false,
        outcome: {
          success: false,
          skipped: true,
          bookingId: bookingId,
          mailType: mailType,
          error: {
            code: 'INVALID_STATUS',
            message: record.status + ' の予約には' + mailType + 'メールを送信できません（' + requiredStatus + 'のみ対象）。'
          }
        }
      };
    }
    if (evaluation.reasonCode === REMINDER_REASON_CODES.ALREADY_SENT) {
      return { ok: false, outcome: { success: true, skipped: true, reason: 'ALREADY_SENT', bookingId: bookingId, mailType: mailType } };
    }
    if (evaluation.reasonCode === REMINDER_REASON_CODES.NOT_NEXT_DAY) {
      return {
        ok: false,
        outcome: {
          success: false,
          skipped: true,
          bookingId: bookingId,
          mailType: mailType,
          error: { code: 'NOT_NEXT_DAY', message: evaluation.message }
        }
      };
    }

    /* EMAIL_MISSING / MAIL_NOT_READY: 既存のMAIL_NOT_READY等と同じ失敗記録経路を通す。 */
    var extraRedactions = [];
    try {
      var guide = BookingConfig.getAccessGuideConfig();
      extraRedactions = [guide.keyboxNumber, guide.unlockCode];
    } catch (redactionError) {
      extraRedactions = [];
    }
    recordMailFailure_(bookingId, mailType, new Error(evaluation.message), record.status, extraRedactions);
    return { ok: false, outcome: { success: false, error: { code: evaluation.reasonCode, message: evaluation.message } } };
  }

  /* withBookingLock_の既定の事前判定（PENDING/CONFIRMED/CANCELLED、および
     カスタム判定を渡さないREMINDER呼び出し用）。status/SentAtのみを見る、
     従来どおりの判定＋レスポンス組み立て（Issue #330より前と完全に同じ内容）。 */
  function defaultMailEligibilityCheck_(mailType, bookingId, requiredStatus, sentAtFields, force, record) {
    var basicEligibility = evaluateStatusAndSentAt_(record, requiredStatus, sentAtFields, force);
    if (!basicEligibility.ok && basicEligibility.reasonCode === 'INVALID_STATUS') {
      return {
        ok: false,
        outcome: {
          success: false,
          skipped: true,
          bookingId: bookingId,
          mailType: mailType,
          error: {
            code: 'INVALID_STATUS',
            message: record.status + ' の予約には' + mailType + 'メールを送信できません（' + requiredStatus + 'のみ対象）。'
          }
        }
      };
    }
    if (!basicEligibility.ok && basicEligibility.reasonCode === 'ALREADY_SENT') {
      return { ok: false, outcome: { success: true, skipped: true, reason: 'ALREADY_SENT', bookingId: bookingId, mailType: mailType } };
    }
    return { ok: true };
  }

  /* Lock取得 → 最新レコード再読込 → fn(record)呼び出し → Lock解除、という一連の
     配線だけを担う共通部分（Issue #330レビュー対応で抽出）。withBookingLock_の
     既存4メール種別と、sendReminderMailForBookingが渡すカスタム事前判定
     （reminderEligibilityCheck_）の両方がこの同じ配線を使う。 */
  function withLockedBookingRecord_(bookingId, fn) {
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
      return fn(found.record);
    } finally {
      lock.releaseLock();
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
   * getExtraRedactions（省略可。PRレビュー対応）: 呼び出し直前に評価する関数。
   *   REMINDERのkeyboxNumber/unlockCodeのように、万一エラーメッセージへ混入すると
   *   困る秘密値の配列を返す。取得自体が失敗しても送信フロー全体を壊さないよう、
   *   ここでtry/catchして空配列にフォールバックする。
   * eligibilityCheckFn（省略可。Issue #330で追加）: (mailType, bookingId, requiredStatus,
   *   sentAtFields, force, record) => { ok: true } | { ok: false, outcome } の形で
   *   事前判定を差し替える。省略時はdefaultMailEligibilityCheck_（従来どおりの
   *   status/SentAtのみの判定）を使う。sendReminderMailForBookingはここへ
   *   reminderEligibilityCheck_（evaluateReminderEligibility_を使う判定）を渡し、
   *   本番のREMINDER送信も診断と同じ共通判定関数を経由するようにする。
   *
   * 処理順序（Issue #271「9. 自動送信と二重送信防止」どおり）:
   *   Lock取得 → 最新レコード再読込 → 事前判定 → テンプレート生成 →
   *   MailApp送信 → 送信成功 → SentAt更新 → lastMailError*クリア → Lock解除
   */
  function withBookingLock_(mailType, bookingId, requiredStatus, sentAtFields, force, buildTemplateFn, getExtraRedactions, eligibilityCheckFn) {
    var checkFn = eligibilityCheckFn || defaultMailEligibilityCheck_;

    return withLockedBookingRecord_(bookingId, function (record) {
      var pre = checkFn(mailType, bookingId, requiredStatus, sentAtFields, force, record);
      if (!pre.ok) return pre.outcome;

      var extraRedactions = [];
      try {
        if (typeof getExtraRedactions === 'function') {
          extraRedactions = getExtraRedactions() || [];
        }
      } catch (redactionError) {
        extraRedactions = [];
      }

      var mail;
      try {
        mail = buildTemplateFn(record);
      } catch (buildError) {
        recordMailFailure_(bookingId, mailType, buildError, record.status, extraRedactions);
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
        recordMailFailure_(bookingId, mailType, sendError, record.status, extraRedactions);
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
        Logger.log('BookingMailer: SentAt更新に失敗しました（メール送信自体は成功）: ' + sanitizeErrorMessage_(describeError_(sheetsError), extraRedactions));
      }

      return { success: true, bookingId: bookingId, mailType: mailType, sentAt: sentAt };
    });
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
   *
   * 送信可否の判定は、事前判定にreminderEligibilityCheck_（evaluateReminderEligibility_
   * を使う）を渡すことで行う（Issue #330レビュー対応。本番も診断も同じ共通判定関数を
   * 経由する）。buildTemplateFn内のensureMailConfigComplete_/ensureAccessGuideComplete_
   * 自体は変更していない（事前判定で既にeligible=trueと確認済みのため、通常はここで
   * 再度throwすることはないが、二重防御として残す）。
   *
   * options.targetDateString（省略可）: 呼び出し側（sendNextDayReminders）が計算した
   * 翌日日付。渡すとNOT_NEXT_DAYの再確認が働く（候補抽出時点で既に絞り込み済みのため
   * 通常は一致するだけの防御的チェック）。管理者個別再送（BookingAdmin.gsの
   * 「予約メールを再送」）は渡さない＝この判定を経由しない（既存の「特定の日付を
   * 対象にしない」挙動を維持するため）。
   * options.force（省略可）: 既存どおり、SentAtが既にあっても送信する。
   */
  function sendReminderMailForBooking(bookingId, options) {
    var opts = options || {};
    return withBookingLock_(
      MAIL_TYPES.REMINDER,
      bookingId,
      Booking.STATUS.CONFIRMED,
      REMINDER_SENT_AT_FIELDS_,
      !!opts.force,
      function (record) {
        var config = ensureMailConfigComplete_();
        var guide = BookingConfig.getAccessGuideConfig();
        ensureAccessGuideComplete_(guide);
        return BookingMailTemplates.buildReminderMail(record, config, guide);
      },
      function () {
        var guide = BookingConfig.getAccessGuideConfig();
        return [guide.keyboxNumber, guide.unlockCode];
      },
      function (mailType, lockedBookingId, requiredStatus, sentAtFields, force, record) {
        return reminderEligibilityCheck_(mailType, lockedBookingId, requiredStatus, sentAtFields, force, record, opts.targetDateString || null);
      }
    );
  }

  return {
    MAIL_TYPES: MAIL_TYPES,
    sendPendingMailForBooking: sendPendingMailForBooking,
    sendConfirmedMailForBooking: sendConfirmedMailForBooking,
    sendCancelledMailForBooking: sendCancelledMailForBooking,
    sendReminderMailForBooking: sendReminderMailForBooking,
    /* BookingRepository.gs等、利用者メール経路の他ファイルからも同じredaction方針で
       Loggerへ出力できるよう公開する（PRレビュー対応）。 */
    sanitizeErrorMessage: sanitizeErrorMessage_,
    /* Issue #330: 前日リマインド診断（BookingReminderDiagnostics.gs。Booking Admin専用）が
       本番と同じ判定を再利用するための公開API。判定ロジック自体はここでのみ定義し、
       診断側では複製しない。 */
    REMINDER_SENT_AT_FIELDS: REMINDER_SENT_AT_FIELDS_,
    REMINDER_REASON_CODES: REMINDER_REASON_CODES,
    evaluateReminderEligibility: evaluateReminderEligibility_
  };
})();
