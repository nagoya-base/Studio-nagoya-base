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
    REMINDER: 'REMINDER',
    EXPIRED: 'EXPIRED',
    /* Issue #334 PR-C: 管理者がBooking AdminからStripe決済リンクを送信するメール種別。 */
    PAYMENT_LINK: 'PAYMENT_LINK'
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

  /*
   * PENDING仮受付メール。カード決済のみ、支払期限日時の計算に必要な
   * minHoursBeforeStart（既存のPENDING_TTL_MIN_HOURS_BEFORE_START）をconfig.ttlConfigとして
   * 追加で渡す（Issue #334 PR-B。Booking Admin表示のcomputeAdminCardPaymentDueAt_
   * ―gas/booking/admin/BookingAdminWeb.gs―と同じくBooking.computeCardPaymentDueMillisのみを
   * 正として使い、期限の計算式をここで複製しない）。buildPendingMailの引数はrecordと
   * configの2つのみで変えない（既存テストの引数個数チェックに合わせる）。
   */
  function sendPendingMailForBooking(bookingId, options) {
    var opts = options || {};
    return withBookingLock_(MAIL_TYPES.PENDING, bookingId, Booking.STATUS.PENDING, ['pendingMailSentAt'], !!opts.force, function (record) {
      var config = ensureMailConfigComplete_();
      config.ttlConfig = BookingConfig.getTtlConfig();
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
   * EXPIRED（カード決済PENDING失効通知。Issue #334）。
   * expirePendingBookings（BookingRepository.gs）が、その回の実行でPENDING→EXPIREDへ
   * 更新した「カード決済の」行のみに対してLock外・best effortで呼ぶ想定。
   * requiredStatus=EXPIREDのため、過去にEXPIREDへ更新済みの行へ誤って複数回送っても
   * expiredMailSentAtの既存値がある限りALREADY_SENTでスキップされる（withBookingLock_の
   * 既定の事前判定＝defaultMailEligibilityCheck_をそのまま使う。他のメール種別と同じ
   * SentAt方式の二重送信防止をここでも複製しない）。
   */
  function sendExpiredMailForBooking(bookingId, options) {
    var opts = options || {};
    return withBookingLock_(MAIL_TYPES.EXPIRED, bookingId, Booking.STATUS.EXPIRED, ['expiredMailSentAt'], !!opts.force, function (record) {
      var config = ensureMailConfigComplete_();
      return BookingMailTemplates.buildExpiredMail(record, config);
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

  /*
   * PAYMENT_LINK（Booking AdminからのStripe決済リンク送信。Issue #334 PR-C）。
   *
   * 既存のwithBookingLock_（status/SentAtのみを見る汎用判定＋成功時にsentAtFieldsだけを
   * 更新する仕組み）は、この送信では次の理由により流用しない:
   * - 送信ごとに入力されるpaymentLinkUrl（可変の引数）を検証・記録する必要がある
   * - 成功時にstripePaymentLinkUrl/paymentLinkSentTo/paymentLinkSendCountという、
   *   他のメール種別にはない専用フィールドを合わせて更新する必要がある
   * - 失敗時の記録先が、他メール種別と共有するlastMailError*ではなく専用列
   *   （paymentLinkLastErrorAt/paymentLinkLastErrorMessage）である
   * そのため、Lock取得・最新レコード再読込・Lock解除という配線本体は既存の
   * withLockedBookingRecord_をそのまま再利用し（LockService.getScriptLock()を
   * 複製しない）、事前判定・送信・記録のみをこの関数専用に実装する。
   */
  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  var PAYMENT_LINK_REASON_CODES_ = {
    INVALID_STATUS: 'INVALID_STATUS',
    NOT_CARD_PAYMENT: 'NOT_CARD_PAYMENT',
    /*
     * 第3回PRレビュー対応: paymentLinkMetadataInconsistentAtが記録されている
     * （送信履行は確定しているが、続くURL/送信先/送信回数の記録に失敗し、記録内容が
     * 古い・不正確なままの可能性がある）間は、送信履歴の照合・補正
     * （BookingMailer.resolvePaymentLinkMetadataInconsistency）が完了するまで
     * **通常送信・明示的な再送のいずれも拒否する**。ALREADY_SENT/SEND_UNCONFIRMEDと
     * 異なり、forceでも無視しない（force resendが「不整合を抱えたまま送信回数を
     * さらに進めてしまう」ことを防ぐため。詳細はevaluatePaymentLinkEligibility_の
     * コメント参照）。
     */
    METADATA_INCONSISTENT: 'METADATA_INCONSISTENT',
    ALREADY_SENT: 'ALREADY_SENT',
    /* PRレビュー対応（履行未確認の二重送信防止）: MailApp送信自体は成功したが、
       その直後のpaymentLinkSentAt記録に失敗し、送信済みかどうかを確定できない状態。
       ALREADY_SENTと同じくforceがない限り通常送信を拒否する。詳細は
       sendPaymentLinkMailForBookingのコメント参照。 */
    SEND_UNCONFIRMED: 'SEND_UNCONFIRMED',
    EMAIL_MISSING: 'EMAIL_MISSING',
    PAYMENT_DUE_UNKNOWN: 'PAYMENT_DUE_UNKNOWN',
    PAYMENT_DUE_PASSED: 'PAYMENT_DUE_PASSED'
  };

  /*
   * 送信可否の判定（副作用なし）。判定順序（最初に一致したものを返す）:
   *   INVALID_STATUS → NOT_CARD_PAYMENT → METADATA_INCONSISTENT → ALREADY_SENT →
   *   SEND_UNCONFIRMED → EMAIL_MISSING → PAYMENT_DUE_UNKNOWN → PAYMENT_DUE_PASSED →
   *   eligible
   * - 対象は「支払方法がカードのPENDING予約」のみ（Issue #334本文）。UIでの表示制御に
   *   依存せず、送信時にここで必ず再検証する。
   * - METADATA_INCONSISTENTは**forceでも無視しない**（第3回PRレビュー対応。他の
   *   拒否理由と違い、送信履歴の照合・補正が完了するまで送信操作自体を止める必要が
   *   あるため）。ALREADY_SENT/SEND_UNCONFIRMEDはforce（管理者の明示的な再送）で
   *   無視できるが、status/paymentMethodの不一致もforceでも無視しない（既存の
   *   reminderEligibilityCheck_と同じ方針）。
   * - 支払期限（Booking.computeCardPaymentDueMillis）を過ぎている場合は送信を拒否する
   *   （Issue #334本文「期限未到来を再検証」）。createdAt/startAtが揃っていない
   *   （データ不備）場合は期限を計算できないためfail-closedに拒否する。
   */
  function evaluatePaymentLinkEligibility_(record, options) {
    var opts = options || {};

    if (record.status !== Booking.STATUS.PENDING) {
      return {
        eligible: false,
        reasonCode: PAYMENT_LINK_REASON_CODES_.INVALID_STATUS,
        message: (record.status || '未設定') + ' の予約には決済リンクメールを送信できません（PENDINGのみ対象）。'
      };
    }
    if (!Booking.isCardPaymentMethod(record.paymentMethod)) {
      return {
        eligible: false,
        reasonCode: PAYMENT_LINK_REASON_CODES_.NOT_CARD_PAYMENT,
        message: '支払方法がオンラインクレジットカードの予約のみ決済リンクを送信できます。'
      };
    }
    if (record.paymentLinkMetadataInconsistentAt) {
      return {
        eligible: false,
        reasonCode: PAYMENT_LINK_REASON_CODES_.METADATA_INCONSISTENT,
        message: '送信履歴に記録不整合があるため送信できません。Bookingsシート・Recoveryシート（PAYMENT_LINK_METADATA_UPDATE_FAILED）を確認し、Booking Admin予約詳細から送信履歴を補正してください。'
      };
    }
    if (record.paymentLinkSentAt && !opts.force) {
      return {
        eligible: false,
        reasonCode: PAYMENT_LINK_REASON_CODES_.ALREADY_SENT,
        message: '決済リンクは送信済みです。再送する場合は明示的に再送操作を選んでください。'
      };
    }
    if (record.paymentLinkSendUnconfirmedAt && !opts.force) {
      return {
        eligible: false,
        reasonCode: PAYMENT_LINK_REASON_CODES_.SEND_UNCONFIRMED,
        message: '前回の送信でメールが届いたか確認できていません。実際の送信状況を確認したうえで、必要であれば明示的に再送してください。'
      };
    }
    if (!record.email) {
      return {
        eligible: false,
        reasonCode: PAYMENT_LINK_REASON_CODES_.EMAIL_MISSING,
        message: '予約者のメールアドレスが登録されていません。'
      };
    }
    if (!isDateLike_(record.createdAt) || !isDateLike_(record.startAt)) {
      return {
        eligible: false,
        reasonCode: PAYMENT_LINK_REASON_CODES_.PAYMENT_DUE_UNKNOWN,
        message: '支払期限を計算できないため送信できません（申込日時・利用開始日時を確認してください）。'
      };
    }
    var ttlConfig = BookingConfig.getTtlConfig();
    var dueMillis = Booking.computeCardPaymentDueMillis(
      record.createdAt.getTime(),
      record.startAt.getTime(),
      ttlConfig.minHoursBeforeStart
    );
    var nowMillis = isDateLike_(opts.now) ? opts.now.getTime() : Date.now();
    if (nowMillis >= dueMillis) {
      return {
        eligible: false,
        reasonCode: PAYMENT_LINK_REASON_CODES_.PAYMENT_DUE_PASSED,
        message: '支払期限を過ぎているため送信できません。'
      };
    }

    return { eligible: true, dueMillis: dueMillis };
  }

  /*
   * 決済リンクメール専用の失敗記録（Issue #334 PR-C）。既存のrecordMailFailure_
   * （lastMailError*・他メール種別と共有）とは書き込み先を分ける（このファイル冒頭の
   * コメント参照）。Recoveryへの記録は既存と同じ形式（failureType/status/errorMessage/
   * recoveryState/resolvedAt）を使う。 */
  function recordPaymentLinkMailFailure_(bookingId, error, status) {
    var now = new Date();
    var message = sanitizeErrorMessage_(describeError_(error));
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        paymentLinkLastErrorAt: now,
        paymentLinkLastErrorMessage: message
      });
    } catch (sheetsError) {
      Logger.log('BookingMailer: paymentLinkLastError更新に失敗しました: ' + sanitizeErrorMessage_(describeError_(sheetsError)));
    }
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'PAYMENT_LINK_MAIL_FAILED',
        occurredAt: now,
        status: status,
        errorMessage: message,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('BookingMailer: RecoveryRepository.recordFailure失敗: ' + sanitizeErrorMessage_(describeError_(recoveryError)));
    }
  }

  /*
   * PRレビュー対応（履行未確認の二重送信防止）: MailApp.sendEmailは成功したが、直後の
   * paymentLinkSentAt記録（二重送信防止の要となる列）の書き込み自体が失敗し、
   * 「メールが届いている可能性があるが、その履行を記録できていない」状態になった場合の
   * Recovery記録。既存のrecordPaymentLinkMailFailure_（送信そのものの失敗。lastMailError*
   * 相当の専用列へ記録）とは意味が異なるため、別関数・別failureTypeとして分離する。
   */
  function recordPaymentLinkSendUnconfirmed_(bookingId, status) {
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'PAYMENT_LINK_SEND_HISTORY_UPDATE_FAILED',
        occurredAt: new Date(),
        status: status,
        errorMessage: 'MailApp.sendEmailは成功したが、直後のpaymentLinkSentAt（送信履歴）の記録に失敗した。メールが届いている可能性があるため、実際の到達を確認したうえで、必要であれば管理者が明示的に再送すること。',
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('BookingMailer: RecoveryRepository.recordFailure失敗（決済リンク送信の履行未確認記録）: ' + sanitizeErrorMessage_(describeError_(recoveryError)));
    }
  }

  /*
   * PRレビュー対応（同時再送の競合防止。第2回レビュー対応で拡張）: 管理画面が最後に
   * 取得した予約詳細のpaymentLinkSendCount・paymentLinkSentAt（=「画面が知っている
   * 送信履歴のバージョン」）と、Lock取得後に再読込した最新値をそれぞれ比較する。
   * いずれか一方でも一致しない場合、別タブ・別端末が管理画面を再取得しないうちに先に
   * 送信（通常送信・明示的な再送のいずれも）を行ったと判断し、古い画面からのこの
   * リクエストを拒否する。通常送信・明示的な再送（force）のいずれにも適用する
   * （forceは「送信済みでも送る」ことの許可であり、「古い前提のまま送る」ことの許可
   * ではないため、forceでもこの競合チェックは無視しない）。
   *
   * paymentLinkSentAtも比較する理由（第2回レビュー対応）: sendPaymentLinkMailForBookingは
   * paymentLinkSentAtを単独で先に書き込み、URL/送信先/paymentLinkSendCount等は2回目の
   * 呼び出しで書き込む（このファイルの他の箇所のコメント参照）。この2回目の書き込みだけが
   * 失敗すると、paymentLinkSentAtは新しい送信時刻に更新される一方でpaymentLinkSendCountは
   * 古い値のまま残る。この状態で、2回目の失敗が起きる**前**の画面（古いpaymentLinkSentAt・
   * かつ古いpaymentLinkSendCountを見ている）から明示的な再送を行うと、
   * paymentLinkSendCountだけを比較する版の競合チェックでは一致してしまい
   * （書き込みが failed のため実際にはcountが変化していないため）、競合を検知できずに
   * 通過してしまう。paymentLinkSentAtも独立して比較することで、この抜け道を防ぐ。
   *
   * expectedSendCount・expectedSentAtVersionはそれぞれ独立に判定する（両方渡された場合は
   * いずれか一方でも不一致ならSEND_HISTORY_CONFLICTとする）。省略した項目はその項目の
   * チェック自体を行わない（新しいクライアントのみが検知できる追加の安全策のため、
   * 省略時に既存挙動を壊さない）。
   *
   * expectedSentAtVersion: paymentLinkSentAtの内部表現（Dateのepoch ms。未送信は0）。
   * Booking Admin画面（getAdminBookingDetailのpaymentLinkSentAtVersion）が返す値を、
   * クライアントが変換・解釈せずそのまま往復させるだけの内部トークンとして扱う
   * （表示用の'YYYY-MM-DD HH:mm'文字列は分単位で丸められており、同一分内の複数回の
   * 書き込みを区別できないため、表示用文字列ではなくミリ秒精度の内部値を使う）。
   */
  function checkSendHistoryVersion_(record, expectedSendCount, expectedSentAtVersion) {
    if (expectedSendCount !== undefined && expectedSendCount !== null) {
      var actualCount = Number(record.paymentLinkSendCount) || 0;
      if (Number(expectedSendCount) !== actualCount) {
        return {
          ok: false,
          message: '他の画面から既にこの予約の決済リンクが送信された可能性があります（送信回数が変わっています）。最新の予約詳細を再取得してから、必要であれば改めて操作してください。'
        };
      }
    }
    if (expectedSentAtVersion !== undefined && expectedSentAtVersion !== null) {
      var actualSentAtVersion = isDateLike_(record.paymentLinkSentAt) ? record.paymentLinkSentAt.getTime() : 0;
      if (Number(expectedSentAtVersion) !== actualSentAtVersion) {
        return {
          ok: false,
          message: '他の画面から既にこの予約の決済リンクが送信された可能性があります（送信日時が変わっています）。最新の予約詳細を再取得してから、必要であれば改めて操作してください。'
        };
      }
    }
    return { ok: true };
  }

  /*
   * PRレビュー対応（第2回。送信履歴2回目の書き込み失敗の記録）: MailApp.sendEmailにも
   * paymentLinkSentAtの単独書き込みにも成功した（＝二重送信防止の要は確定済み）が、
   * 続くURL・送信先・送信回数（paymentLinkSendCount）等の2回目の書き込みが失敗し、
   * これらの記録が実際の送信回数より少ない・古いURL/宛先のままになっている可能性がある
   * 状態のRecovery記録。recordPaymentLinkSendUnconfirmed_（履行そのものが未確認）とは
   * 意味が異なる（履行は確定している。記録内容の一部が古いだけ）ため、別関数・
   * 別failureTypeとして分離する。
   */
  function recordPaymentLinkMetadataInconsistent_(bookingId, status, intendedSendCount) {
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'PAYMENT_LINK_METADATA_UPDATE_FAILED',
        occurredAt: new Date(),
        status: status,
        errorMessage: '決済リンクメールの送信自体・paymentLinkSentAtの記録には成功したが、続くstripePaymentLinkUrl/paymentLinkSentTo/paymentLinkSendCountの更新に失敗した。paymentLinkSendCountは実際より少ない値のまま残っている可能性がある（本来の送信回数: ' + intendedSendCount + '）。Bookingsシートの内容を確認し、必要であれば手動で補正すること。',
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('BookingMailer: RecoveryRepository.recordFailure失敗（決済リンク送信の記録不整合）: ' + sanitizeErrorMessage_(describeError_(recoveryError)));
    }
  }

  /*
   * 第4回PRレビュー対応: resolvePaymentLinkMetadataInconsistencyの書き込み
   * （送信回数の補正・不整合フラグのクリア）のいずれかが実際に反映されたことを
   * 確認できず、補正の試行自体が完了しなかった場合のRecovery記録。既存の
   * OPEN記録（recordPaymentLinkMetadataInconsistent_が書いた
   * PAYMENT_LINK_METADATA_UPDATE_FAILED。元の送信時点の不整合そのもの）とは別の
   * failureTypeとして分離し、「補正を試みたが完了しなかった」ことを区別できるように
   * する。不整合フラグはこの時点でも維持されており、送信は引き続き拒否される
   * （呼び出し元がこの状態でも通常送信・明示的な再送を試みても、
   * evaluatePaymentLinkEligibility_のMETADATA_INCONSISTENT判定で拒否される）。
   */
  function recordPaymentLinkResolveIncomplete_(bookingId, status, currentCount, confirmedCount, stage) {
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE',
        occurredAt: new Date(),
        status: status,
        errorMessage: '管理者による決済リンク送信回数の補正（' + currentCount + '回→' + confirmedCount + '回）の反映を確認できず、補正が完了しませんでした（未確認の書き込み: ' + stage + '）。記録不整合フラグは維持されており、送信は引き続き拒否されます。Bookingsシートの実際の値を確認し、必要であれば補正を再試行してください。',
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('BookingMailer: RecoveryRepository.recordFailure失敗（決済リンク記録不整合の補正未完了記録）: ' + sanitizeErrorMessage_(describeError_(recoveryError)));
    }
  }

  /*
   * options:
   *   force（省略可。既定false）: trueの場合、送信済み（paymentLinkSentAtが既にある）・
   *     履行未確認（paymentLinkSendUnconfirmedAtが既にある）でも送信する。管理者の
   *     明示的な再送操作からのみ渡すこと（Issue #334本文「再送は履歴と明示的な確認を
   *     伴う管理者操作に限る」）。status/paymentMethod不一致・期限切れ・
   *     expectedSendCountの不一致（後述）はforceでも無視しない。
   *   now（省略可。テスト用）: 期限判定の基準時刻。省略時は現在時刻。
   *   expectedSendCount（省略可。PRレビュー対応）: 呼び出し元（Booking Admin画面）が
   *     最後に取得した予約詳細のpaymentLinkSendCount。Lock取得後の最新値と一致しない
   *     場合はSEND_HISTORY_CONFLICTとして拒否する（checkSendHistoryVersion_参照）。
   *   expectedSentAtVersion（省略可。第2回レビュー対応）: 呼び出し元が最後に取得した
   *     予約詳細のpaymentLinkSentAtVersion（epoch ms。未送信は0）。expectedSendCountと
   *     独立に判定し、いずれか一方でも最新値と一致しなければSEND_HISTORY_CONFLICTとする
   *     （2回目の書き込みだけが失敗してpaymentLinkSendCountが変化しないケースを、
   *     expectedSendCountだけの比較では検知できないため。checkSendHistoryVersion_参照）。
   *
   * 処理順序: Lock取得 → 最新レコード再読込 → 競合チェック（checkSendHistoryVersion_）→
   *   事前判定（evaluatePaymentLinkEligibility_） → URL形式検証 → MailApp送信 →
   *   成功: まずpaymentLinkSentAtのみを単独で更新（二重送信防止の要となる列を
   *   isolateして書き込み、他フィールドの書き込み失敗に巻き込まれないようにする）→
   *   その書き込みに成功した場合のみstripePaymentLinkUrl/paymentLinkSentTo/
   *   paymentLinkSendCount/エラー系列を更新 → Lock解除。
   * 送信失敗（設定不足・MailApp例外のいずれも）でも予約のstatusは一切変更しない
   * （Issue #334本文どおり。PENDINGのまま維持し、管理者が原因解消後に再送できる）。
   *
   * PRレビュー対応（履行未確認の二重送信防止）: 従来はpaymentLinkSentAtを含む6フィールドを
   * 1回のupdateBookingFields呼び出しで更新し、その呼び出し全体が失敗した場合は
   * Loggerへ記録するだけでsuccess:trueを返していた。これには次の問題があった:
   * - MailApp.sendEmailに成功した直後にSheets書き込みが失敗すると、paymentLinkSentAtが
   *   空のまま残る。次回、管理者が「通常の送信」ボタン（forceなし）を押すと、
   *   ALREADY_SENT判定に引っかからずに再送してしまい、二重送信になり得る。
   * - 失敗が起きたこと自体もBooking Admin側からは分からない（ログのみ）。
   * そのため、paymentLinkSentAtの書き込みを他のフィールドから分離し、単独で失敗した
   * 場合は「送信済みかもしれないが未確認」の状態としてpaymentLinkSendUnconfirmedAtへ
   * 記録し、Recoveryにも記録する。この状態はALREADY_SENTと同じくforceがない限り
   * 通常送信を拒否する（evaluatePaymentLinkEligibility_のSEND_UNCONFIRMED判定）。
   * 呼び出し元にはsuccess:falseかつrequiresManualConfirmation:trueを返し、管理者に
   * 実際の到達確認を促す。
   */
  function sendPaymentLinkMailForBooking(bookingId, paymentLinkUrl, options) {
    var opts = options || {};

    if (!Booking.isValidStripePaymentLinkUrl(paymentLinkUrl)) {
      return {
        success: false,
        error: {
          code: 'INVALID_PAYMENT_LINK_URL',
          message: 'Stripeの決済リンクURL（https://buy.stripe.com/で始まる形式）を正しく入力してください。'
        }
      };
    }

    return withLockedBookingRecord_(bookingId, function (record) {
      var versionCheck = checkSendHistoryVersion_(record, opts.expectedSendCount, opts.expectedSentAtVersion);
      if (!versionCheck.ok) {
        return {
          success: false,
          skipped: true,
          bookingId: bookingId,
          mailType: MAIL_TYPES.PAYMENT_LINK,
          error: { code: 'SEND_HISTORY_CONFLICT', message: versionCheck.message }
        };
      }

      var evaluation = evaluatePaymentLinkEligibility_(record, { force: !!opts.force, now: opts.now });
      if (!evaluation.eligible) {
        var reasonCode = evaluation.reasonCode;
        if (reasonCode === PAYMENT_LINK_REASON_CODES_.ALREADY_SENT) {
          return { success: true, skipped: true, reason: 'ALREADY_SENT', bookingId: bookingId, mailType: MAIL_TYPES.PAYMENT_LINK };
        }
        return {
          success: false,
          skipped: true,
          bookingId: bookingId,
          mailType: MAIL_TYPES.PAYMENT_LINK,
          error: { code: reasonCode, message: evaluation.message }
        };
      }

      var mailConfig;
      var mail;
      try {
        mailConfig = ensureMailConfigComplete_();
        /* PRレビュー対応: sendPendingMailForBookingと同じく、支払期限の計算に必要な
           minHoursBeforeStartをconfig.ttlConfigとして追加で渡す（このコールを忘れると
           buildPaymentLinkMail側でttlConfig.minHoursBeforeStartがundefinedになり、
           支払期限が計算できず本文の期限表示が欠落する）。 */
        mailConfig.ttlConfig = BookingConfig.getTtlConfig();
        mail = BookingMailTemplates.buildPaymentLinkMail(record, mailConfig, paymentLinkUrl);
      } catch (buildError) {
        recordPaymentLinkMailFailure_(bookingId, buildError, record.status);
        return { success: false, error: { code: 'MAIL_NOT_READY', message: describeError_(buildError) } };
      }

      try {
        MailApp.sendEmail({
          to: record.email,
          subject: mail.subject,
          body: mail.body,
          name: mailConfig.displayName,
          replyTo: mailConfig.replyTo
        });
      } catch (sendError) {
        recordPaymentLinkMailFailure_(bookingId, sendError, record.status);
        return { success: false, error: { code: 'MAIL_SEND_FAILED', message: describeError_(sendError) } };
      }

      var sentAt = new Date();

      /* 二重送信防止の要となる列を単独で更新する。他のフィールド（URL/送信先/送信回数等）と
         同じ呼び出しにまとめないのは、1回のupdateBookingFields呼び出しが複数フィールドを
         順に書き込む実装のため、途中のフィールドで例外が起きるとpaymentLinkSentAtの書き込み
         成否があいまいになるのを避けるため（このファイル冒頭のコメント参照）。 */
      var criticalWriteFailed = false;
      try {
        SpreadsheetRepository.updateBookingFields(bookingId, { paymentLinkSentAt: sentAt });
      } catch (criticalError) {
        criticalWriteFailed = true;
      }

      if (criticalWriteFailed) {
        try {
          SpreadsheetRepository.updateBookingFields(bookingId, { paymentLinkSendUnconfirmedAt: sentAt });
        } catch (fallbackError) {
          Logger.log('BookingMailer: paymentLinkSendUnconfirmedAtの記録にも失敗しました: ' + sanitizeErrorMessage_(describeError_(fallbackError)));
        }
        recordPaymentLinkSendUnconfirmed_(bookingId, record.status);
        return {
          success: false,
          mailSent: true,
          requiresManualConfirmation: true,
          bookingId: bookingId,
          mailType: MAIL_TYPES.PAYMENT_LINK,
          error: {
            code: 'PAYMENT_LINK_HISTORY_UPDATE_FAILED',
            message: 'メールは送信された可能性がありますが、送信履歴の記録に失敗しました。実際に届いているか確認したうえで、必要であれば管理者が明示的に再送してください。'
          }
        };
      }

      var nextSendCount = (Number(record.paymentLinkSendCount) || 0) + 1;
      var metadataWriteFailed = false;
      try {
        /*
         * 第3回PRレビュー対応: ここではpaymentLinkMetadataInconsistentAtを書き込まない
         * （クリアしない）。この書き込みに到達する時点で、直前のevaluatePaymentLinkEligibility_
         * のMETADATA_INCONSISTENT判定により、既にこの列が空であることは保証されている
         * （空でなければここへ到達する前に拒否されている）ため、通常はクリア操作自体が
         * 意味を持たない。加えて、「別の送信が成功しただけで不整合フラグをクリアしない」
         * ことを明示するため、このフィールドをこの書き込みの対象から意図的に外している
         * （不整合の解消は、専用のresolvePaymentLinkMetadataInconsistencyのみが行う）。
         */
        SpreadsheetRepository.updateBookingFields(bookingId, {
          stripePaymentLinkUrl: paymentLinkUrl,
          paymentLinkSentTo: record.email,
          paymentLinkSendCount: nextSendCount,
          paymentLinkSendUnconfirmedAt: '',
          paymentLinkLastErrorAt: '',
          paymentLinkLastErrorMessage: ''
        });
      } catch (sheetsError) {
        /*
         * PRレビュー対応（第2回）: 二重送信防止の要となるpaymentLinkSentAtは既に
         * 記録済みのため、二重送信にはつながらない。しかしURL・送信先・送信回数
         * （paymentLinkSendCount）が更新されないまま残るため、「送信は完了しているが
         * 送信回数等の記録が実際より少ない・古いままになっている」という記録不整合が
         * 発生する。単にLoggerへ残すだけでは管理者が気付けないため、
         * paymentLinkMetadataInconsistentAt（フォールバックの単独書き込み）とRecoveryの
         * 両方へ記録し、呼び出し元にもmetadataInconsistent:trueで伝える。メール自体を
         * 自動で再送することはしない（成功済みの送信をここから再試行しない）。
         * 第3回PRレビュー対応: この不整合フラグは、以後この関数の通常の成功パスでは
         * 二度とクリアしない（上記の分岐参照）。専用のresolvePaymentLinkMetadataInconsistency
         * による明示的な補正のみがクリアする。
         */
        metadataWriteFailed = true;
        try {
          SpreadsheetRepository.updateBookingFields(bookingId, { paymentLinkMetadataInconsistentAt: sentAt });
        } catch (fallbackError) {
          Logger.log('BookingMailer: paymentLinkMetadataInconsistentAtの記録にも失敗しました: ' + sanitizeErrorMessage_(describeError_(fallbackError)));
        }
        recordPaymentLinkMetadataInconsistent_(bookingId, record.status, nextSendCount);
        Logger.log('BookingMailer: 決済リンク送信の付随情報（URL/送信先/送信回数/エラー系列のクリア）の更新に失敗しました（送信・二重送信防止用のpaymentLinkSentAtの記録自体は成功済み）: ' + sanitizeErrorMessage_(describeError_(sheetsError)));
      }

      /* metadataWriteFailedの場合、paymentLinkSendCountは実際には更新されていないため、
         「送信できた（と管理者が信じてよい）回数」としてsendCountには更新前の実際の値を
         返す（nextSendCountをそのまま返すと、実際には記録されていない値を成功扱いで
         伝えてしまう）。管理者へは意図した回数（intendedSendCount）も併せて伝える。 */
      return {
        success: true,
        bookingId: bookingId,
        mailType: MAIL_TYPES.PAYMENT_LINK,
        sentAt: sentAt,
        sentTo: record.email,
        sendCount: metadataWriteFailed ? (Number(record.paymentLinkSendCount) || 0) : nextSendCount,
        metadataInconsistent: metadataWriteFailed,
        intendedSendCount: metadataWriteFailed ? nextSendCount : undefined
      };
    });
  }

  /*
   * 第3回PRレビュー対応: paymentLinkMetadataInconsistentAtが記録された予約の、
   * 送信履歴（paymentLinkSendCount）の明示的な補正。管理者がBookingsシート・
   * Recoveryシート（PAYMENT_LINK_METADATA_UPDATE_FAILED）・実際のメール送信状況を
   * 確認し、正しい送信回数を確認したうえで呼び出す想定（Booking Admin予約詳細の
   * 「送信履歴を補正」操作からのみ呼ぶ。既存のconfirmBooking等と同じくメール送信・
   * Calendar操作は一切行わない、Sheetsの記録のみを補正する関数）。
   *
   * 対象・操作の限定（Issue #334 PR-C・PR #337レビュー対応）:
   * - 対象: `paymentLinkMetadataInconsistentAt`が現在記録されている予約のみ
   *   （空の予約に対しては`NOT_INCONSISTENT`として拒否し、無関係な予約の送信履歴を
   *   誤って書き換えられないようにする）。
   * - confirmedSendCountは0以上の整数のみ許可し、**現在記録されているpaymentLinkSendCount
   *   より小さい値へは補正できない**（`CONFIRMED_SEND_COUNT_TOO_LOW`。記録不整合は
   *   常に「実際の送信回数を過少に記録する」方向にのみ発生するため、正しい補正は
   *   現在値以上になるはずであり、それより小さい値の指定は入力ミス・既存履歴の
   *   意図しない消去である可能性が高いためfail-closedに拒否する）。
   * - 操作権限: Booking Adminプロジェクトは「Execute as: Me / Who has access:
   *   Only myself」で運用する前提（README「Booking Admin Web UI」参照）であり、
   *   この関数もBooking Adminプロジェクト内でのみ公開する（Booking Web Appには
   *   追加しない）。追加の権限チェックは設けていない。
   * - 確認手順: 実行前の内容確認（現在の送信回数・補正後の送信回数の表示・確認）は
   *   HTML側（クライアント）のwindow.prompt/window.confirmで行う（他の管理操作と
   *   同じ方針）。
   *
   * 補正に成功すると、paymentLinkMetadataInconsistentAtを空へ戻し、送信を再び
   * 許可する（evaluatePaymentLinkEligibility_のMETADATA_INCONSISTENT判定を通過する
   * ようになる）。補正の実施自体をRecoveryへ`recoveryState: 'RESOLVED'`として
   * 記録する（既存のOPEN記録＝`recordPaymentLinkMetadataInconsistent_`が書いた行は
   * 運用者が手動でrecoveryState/resolvedAtを記録する既存方針のまま変更しない。
   * このRESOLVED行は補正の実施そのものを示す別の記録）。
   *
   * 第4回PRレビュー対応（この関数自体の部分失敗対策）: 送信回数の補正
   * （paymentLinkSendCount）と不整合フラグのクリア（paymentLinkMetadataInconsistentAt）を、
   * 以前は1回のupdateBookingFields呼び出しにまとめて渡していた。updateBookingFieldsは
   * 渡されたフィールドを内部でループして1つずつ書き込む実装のため、途中の書き込みだけが
   * 失敗すると「送信回数の補正は反映されていないのに、不整合フラグだけが先に（または
   * たまたま）クリアされてしまう」おそれがあった。これは「送信成功だけでフラグを
   * クリアしない」という第3回対応の趣旨に反する（食い違いを隠す方向の失敗になるため）。
   * そのため次のように書き込みを分離し、要件どおり「実際に保存されたことを確認してから
   * 次へ進む」よう変更した:
   *   1. paymentLinkSendCountのみを単独で更新する（不整合フラグはまだ触らない）。
   *   2. 最新レコードを再取得し、paymentLinkSendCountが確認済みの値どおりに反映された
   *      ことを検証する（try/catchで例外を検知した場合だけでなく、例外が起きなかった
   *      場合も同様に再取得して検証する。Sheets側が例外を投げずに書き込みに失敗する
   *      可能性もゼロではないため、例外の有無だけを信用しない）。反映を確認できない場合は
   *      `RESOLVE_SEND_COUNT_NOT_CONFIRMED`として失敗を返し、不整合フラグは維持したまま
   *      Recoveryへ`PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`（OPEN）を記録する。
   *   3. 送信回数の反映を確認できてから、paymentLinkMetadataInconsistentAtのみを
   *      単独で空へ更新する。
   *   4. 再度最新レコードを再取得し、フラグが実際に空になったこと・送信回数が確認済みの
   *      値のままであることを検証する。確認できない場合は
   *      `RESOLVE_FLAG_CLEAR_NOT_CONFIRMED`として失敗を返す（送信回数自体は補正済みの
   *      可能性が高いが、不整合フラグは維持され送信は引き続き拒否される。この場合も
   *      `PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`をRecoveryへ記録する）。
   * `PAYMENT_LINK_METADATA_RESOLVED`（成功）を記録するのは、上記4.の検証まで通過した
   * 場合のみ。
   */
  function resolvePaymentLinkMetadataInconsistency(bookingId, confirmedSendCount) {
    return withLockedBookingRecord_(bookingId, function (record) {
      if (!record.paymentLinkMetadataInconsistentAt) {
        return {
          success: false,
          error: { code: 'NOT_INCONSISTENT', message: 'この予約は送信履歴の記録不整合の状態ではありません。' }
        };
      }

      var currentCount = Number(record.paymentLinkSendCount) || 0;
      var confirmed = Number(confirmedSendCount);
      if (!isFinite(confirmed) || Math.floor(confirmed) !== confirmed || confirmed < 0) {
        return {
          success: false,
          error: { code: 'INVALID_CONFIRMED_SEND_COUNT', message: '送信回数は0以上の整数で指定してください。' }
        };
      }
      if (confirmed < currentCount) {
        return {
          success: false,
          error: {
            code: 'CONFIRMED_SEND_COUNT_TOO_LOW',
            message: '送信回数は現在の記録（' + currentCount + '回）より小さい値へは補正できません（既存の送信履歴を誤って消してしまうことを防ぐため）。'
          }
        };
      }

      var now = new Date();

      /* Step 1: 送信回数のみを単独で更新する（不整合フラグはまだ触らない）。例外が
         起きても、実際に反映されたかどうかはStep 2の再取得で判定するため、ここでは
         即時returnしない（例外の有無だけを信用しない）。 */
      try {
        SpreadsheetRepository.updateBookingFields(bookingId, { paymentLinkSendCount: confirmed });
      } catch (countWriteError) {
        Logger.log('BookingMailer: resolvePaymentLinkMetadataInconsistency Step1（paymentLinkSendCount更新）で例外: ' + sanitizeErrorMessage_(describeError_(countWriteError)));
      }

      /* Step 2: 実際に反映されたかを再取得して検証する。 */
      var afterCountWrite;
      try {
        afterCountWrite = SpreadsheetRepository.findRowByBookingId(bookingId);
      } catch (refetchError) {
        Logger.log('BookingMailer: resolvePaymentLinkMetadataInconsistency Step2（再取得）で例外: ' + sanitizeErrorMessage_(describeError_(refetchError)));
      }
      if (!afterCountWrite || Number(afterCountWrite.record.paymentLinkSendCount) !== confirmed) {
        recordPaymentLinkResolveIncomplete_(bookingId, record.status, currentCount, confirmed, 'SEND_COUNT_WRITE');
        return {
          success: false,
          requiresManualConfirmation: true,
          bookingId: bookingId,
          error: {
            code: 'RESOLVE_SEND_COUNT_NOT_CONFIRMED',
            message: '送信回数の補正が実際に保存されたことを確認できませんでした。記録不整合の警告は維持されています。Bookingsシート・Recoveryシートを確認し、必要であれば補正を再試行してください。'
          }
        };
      }

      /* Step 3: 送信回数の反映を確認できてから、不整合フラグを単独で空へ更新する。 */
      try {
        SpreadsheetRepository.updateBookingFields(bookingId, { paymentLinkMetadataInconsistentAt: '' });
      } catch (clearError) {
        Logger.log('BookingMailer: resolvePaymentLinkMetadataInconsistency Step3（paymentLinkMetadataInconsistentAtクリア）で例外: ' + sanitizeErrorMessage_(describeError_(clearError)));
      }

      /* Step 4: フラグが実際にクリアされ、送信回数も確認済みの値のままであることを
         再取得して検証する。 */
      var afterClear;
      try {
        afterClear = SpreadsheetRepository.findRowByBookingId(bookingId);
      } catch (finalRefetchError) {
        Logger.log('BookingMailer: resolvePaymentLinkMetadataInconsistency Step4（再取得）で例外: ' + sanitizeErrorMessage_(describeError_(finalRefetchError)));
      }
      if (!afterClear || afterClear.record.paymentLinkMetadataInconsistentAt || Number(afterClear.record.paymentLinkSendCount) !== confirmed) {
        recordPaymentLinkResolveIncomplete_(bookingId, record.status, currentCount, confirmed, 'FLAG_CLEAR');
        return {
          success: false,
          requiresManualConfirmation: true,
          bookingId: bookingId,
          paymentLinkSendCount: confirmed,
          error: {
            code: 'RESOLVE_FLAG_CLEAR_NOT_CONFIRMED',
            message: '送信回数の補正は保存できましたが、記録不整合フラグのクリアが実際に保存されたことを確認できませんでした。フラグは維持されており、送信は引き続き拒否されます。Bookingsシート・Recoveryシートを確認し、必要であれば補正を再試行してください。'
          }
        };
      }

      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'PAYMENT_LINK_METADATA_RESOLVED',
          occurredAt: now,
          status: record.status,
          errorMessage: '管理者が決済リンクの送信回数を' + currentCount + '回から' + confirmed + '回へ手動補正し、記録不整合を解消した。',
          recoveryState: 'RESOLVED',
          resolvedAt: now
        });
      } catch (recoveryError) {
        Logger.log('BookingMailer: RecoveryRepository.recordFailure失敗（決済リンク記録不整合の解消記録）: ' + sanitizeErrorMessage_(describeError_(recoveryError)));
      }

      return { success: true, bookingId: bookingId, paymentLinkSendCount: confirmed };
    });
  }

  return {
    MAIL_TYPES: MAIL_TYPES,
    sendPendingMailForBooking: sendPendingMailForBooking,
    sendConfirmedMailForBooking: sendConfirmedMailForBooking,
    sendCancelledMailForBooking: sendCancelledMailForBooking,
    sendExpiredMailForBooking: sendExpiredMailForBooking,
    sendReminderMailForBooking: sendReminderMailForBooking,
    sendPaymentLinkMailForBooking: sendPaymentLinkMailForBooking,
    resolvePaymentLinkMetadataInconsistency: resolvePaymentLinkMetadataInconsistency,
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
