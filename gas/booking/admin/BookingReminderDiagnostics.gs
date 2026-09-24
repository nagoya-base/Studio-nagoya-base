/*
 * BookingReminderDiagnostics.gs — 前日リマインドの任意時刻デバッグ・管理者宛テスト送信
 * （Issue #330）。
 *
 * 目的: 前日リマインドの定期実行（`sendNextDayReminders`。毎日18時台）を待たずに、
 * 既存予約IDを指定して「翌日リマインド対象判定」「本番テンプレートのプレビュー」
 * 「管理者宛のテスト送信」を任意の時刻に確認できるようにする。本番予約データは
 * 一切変更しない（読み取り専用 + 管理者自身の受信箱への送信のみ）。
 *
 * 【重要・対象判定の共通化】ここでは対象判定・設定不足判定のロジックを一切複製しない。
 * すべて`BookingMailer.evaluateReminderEligibility(record, options)`
 * （BookingMailer.gs。本番の`sendReminderMailForBooking`・`withBookingLock_`・
 * `ensureMailConfigComplete_`/`ensureAccessGuideComplete_`と同じ内部関数を経由する。
 * PRレビュー対応でBooking Adminの本番送信からも実際に呼ばれるようになった）と、
 * 翌日日付計算`computeNextDayDateString_`（BookingReminderTriggers.gs。
 * `sendNextDayReminders`と共有）をそのまま呼ぶ。
 *
 * 【重要・本番データ更新関数を呼ばない】このファイルは次の関数を一切呼ばない:
 * `withBookingLock_`（BookingMailer.gs内部。非公開のため呼びようがない）、
 * `SpreadsheetRepository.updateBookingFields`、`RecoveryRepository.recordFailure`。
 * 呼ぶのは読み取り専用の`SpreadsheetRepository.findRowByBookingId`のみ。テスト送信は
 * `MailApp.sendEmail`をこのファイルから直接呼ぶ診断専用の経路とし、
 * `BookingMailer.sendReminderMailForBooking`（Lock取得・SentAt更新・失敗記録を伴う本番経路）
 * は呼ばない。
 *
 * 【重要・認可について】このファイルが公開するグローバル関数は、既存の
 * `getAdminBookings`/`adminConfirmBooking`等（BookingAdminWeb.gs）と全く同じ経路
 * （Booking AdminのWeb Appデプロイ。Execute as: Me / Who has access: Only myself）
 * でのみ呼び出せる。既存のBooking Admin Web UIには、呼び出しユーザーをコード内で
 * 識別するチェック（例: Session.getEffectiveUser()との比較）は存在しない
 * （調査済み。gas/booking/admin/BookingAdminWeb.gs参照）。これは、Execute as: Me
 * でデプロイされたWeb Appでは`Session.getEffectiveUser()`がスクリプト所有者
 * （実行者）を返すだけで、実際にHTTPリクエストを送ってきた個人を識別できないため
 * （Googleの仕様上、Only myselfでデプロイした時点でGoogle側のログイン認証が
 * アクセス制御そのものを担う）。そのため、ここでも新たなSession判定は追加しない
 * （不正確な判定を「認可した」ように見せることの方が危険なため）。既存機能と同じく、
 * 認可はBooking AdminのWeb Appデプロイ設定（Only myself）に依存する。この関数群は
 * 既存のBooking Admin Web App内に追加する関数であり、認可が別途成立しない新規の
 * 公開エンドポイント（例: 別プロジェクトとしてのデプロイ、doGetでの匿名公開等）は
 * 一切作らない。
 *
 * 【重要・秘密値の保護】診断ログはLogger.logのみ（別シート・Recoveryシート・新規
 * 永続ストアは作らない）。bookingId・診断日時・判定コード・送信成否のみを記録し、
 * メール本文・キーボックス番号・解錠コード・予約者のメールアドレスは一切記録しない。
 * エラーメッセージは既存の`BookingMailer.sanitizeErrorMessage`へ通し、
 * `ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`の実値を追加でredactする。
 *
 * 【重要・想定外例外の境界（Issue #330 PRレビュー対応）】findRowByBookingId・
 * BookingConfig.get*Config・BookingMailer.evaluateReminderEligibility等が想定外の
 * 例外を投げた場合、その生のerror.messageがgoogle.script.runのwithFailureHandlerへ
 * そのまま渡ってしまうと、クライアント側でHTMLエスケープしても秘密値のredaction
 * にはならない（エスケープは表示上の安全対策であって、値の削除ではないため）。
 * これを避けるため、3つの公開関数（diagnoseReminderEligibility/previewReminderMail/
 * sendReminderTestMail）は本体を`_impl_`関数へ分離し、想定外の例外はここで
 * catchして固定の安全なメッセージ（DIAGNOSTICS_GENERIC_ERROR_MESSAGE_）のみを
 * 返す。Loggerにも例外のmessage/stackを一切出さず、関数名とbookingIdのみを残す。
 * 既知のエラー（NOT_FOUND/INVALID_BASE_DATE/INVALID_STATUS等）は例外を投げず
 * 通常の戻り値として返しているため、この境界の影響を受けない。
 *
 * デプロイ先はBookingAdmin.gs等と同じBooking Adminプロジェクト（`SPREADSHEET_ID`の
 * Spreadsheetへコンテナバインド）。公開Booking Web App（Code.gs）には配置しない。
 */
'use strict';

/* 想定外の例外をキャッチした場合にのみ返す固定の安全なメッセージ（Issue #330
   PRレビュー対応）。例外のmessageを一切含めない（sanitizeErrorMessageによる
   redactionではなく、そもそも生成しない設計）。 */
var DIAGNOSTICS_GENERIC_ERROR_MESSAGE_ = '内部エラーが発生しました。しばらくしてから再度お試しください。';

/*
 * 'YYYY-MM-DD'の基準日文字列を、UTC正午のDateへ変換する（Issue #330）。
 * UTC正午を使うのは、Availability.gsのdaysInMonth_/formatDateWithWeekdayと同じ
 * 「Date.UTC(year, month-1, day)で暦日を組み立てる」方針を踏襲しつつ、
 * その後の`+24時間`（computeNextDayDateString_）でJST等の日付境界をまたぐ事故を
 * 避けるため（UTC正午はJSTでは21:00であり、暦日の前後にずれる余地がない）。
 * 不正な形式・実在しない日付（例: 2026-02-30）の場合はnullを返す
 * （BookingAvailability.isValidDateStringが暦日の実在まで確認する。
 * 呼び出し側でfail-closedに扱う）。
 */
function parseDiagnosticsBaseDate_(dateString) {
  if (!BookingAvailability.isValidDateString(dateString)) return null;
  var parts = dateString.split('-');
  return new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0));
}

/*
 * baseDateString（必須）を検証し、翌日日付（targetDateString）へ変換する共通処理
 * （Issue #330 PRレビュー対応。diagnoseReminderEligibility/previewReminderMail/
 * sendReminderTestMailの3関数がすべてこの関数を使い、基準日検証ロジックを複製
 * しない）。未入力・不正形式・実在しない日付はINVALID_BASE_DATE、TIMEZONE設定
 * 不正等で計算自体が失敗した場合はINVALID_CONFIGを返す。
 * 戻り値: { targetDateString } または { error: { code, message } }
 */
function resolveDiagnosticsTargetDate_(baseDateString) {
  if (!baseDateString) {
    return { error: { code: 'INVALID_BASE_DATE', message: '基準日を入力してください（YYYY-MM-DD）。' } };
  }
  var baseDate = parseDiagnosticsBaseDate_(baseDateString);
  if (!baseDate) {
    return { error: { code: 'INVALID_BASE_DATE', message: '基準日の形式が正しくないか、実在しない日付です（YYYY-MM-DD）。' } };
  }
  var timezone = BookingConfig.getAvailabilityConfig().timezone;
  var targetDateString = computeNextDayDateString_(baseDate, timezone);
  if (!targetDateString) {
    return { error: { code: 'INVALID_CONFIG', message: 'Script PropertiesのTIMEZONE設定が不正なため翌日を計算できませんでした。' } };
  }
  return { targetDateString: targetDateString };
}

/* Booking.gsのEMAIL_PATTERN_と同じ形式チェック（Booking.gsはisValidEmail_を公開して
   いないため、ADMIN_NOTIFICATION_EMAILの形式検証専用にここへ最小限だけ複製する。
   予約入力検証（Booking.validateCreateBookingInput）とは無関係の別用途のため、
   Booking.gs側の公開APIは変更しない）。 */
var DIAGNOSTICS_EMAIL_PATTERN_ = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidDiagnosticsEmail_(value) {
  return typeof value === 'string' && DIAGNOSTICS_EMAIL_PATTERN_.test(value);
}

/* record.dateがDate値の場合のみ'YYYY-MM-DD'へ変換する（Sheetsが日付らしい文字列を
   Date値として保存した場合への備え。BookingAdminWeb.gsのformatAdminDate_と同じ
   duck-typing方針）。診断結果の表示専用で、判定ロジックには使わない
   （判定側の正規化はBookingMailer.gsのnormalizeReminderDate_が別途行う）。 */
function formatDiagnosticsDate_(value, timezone) {
  if (!value || typeof value.getTime !== 'function' || isNaN(value.getTime())) {
    return value === undefined || value === null ? '' : value;
  }
  return BookingAvailability.formatDateInTimezone(value, timezone) || '';
}

/*
 * 解錠コード・キーボックス番号をマスクした来場案内を作る（Issue #330「解錠情報の保護」）。
 * reveal:trueの場合のみ実値をそのまま返す。マスク文字列はBookingMailTemplates.
 * secretLine_（`label + ': ' + (value ? value : '（未設定）')`）にそのまま渡せるよう、
 * 空文字ではなく人が読めるプレースホルダにする（空文字にすると「未設定」表示と
 * 区別がつかなくなるため）。
 */
var DIAGNOSTICS_SECRET_MASK_ = '••••••（「表示する」を選択すると表示されます）';

function maskDiagnosticsAccessGuide_(accessGuide, reveal) {
  if (reveal) return accessGuide;
  var masked = {};
  Object.keys(accessGuide).forEach(function (key) { masked[key] = accessGuide[key]; });
  if (masked.keyboxNumber) masked.keyboxNumber = DIAGNOSTICS_SECRET_MASK_;
  if (masked.unlockCode) masked.unlockCode = DIAGNOSTICS_SECRET_MASK_;
  return masked;
}

/*
 * 対象判定のみを行う（Issue #330 受入条件1）。副作用は一切ない
 * （SpreadsheetRepository.findRowByBookingIdによる読み取りのみ）。
 *
 * bookingId: 診断したい既存予約のID
 * baseDateString: 管理者が指定する「基準日（今日扱い）」（'YYYY-MM-DD'。必須）。
 *   本番の時計・トリガーには一切影響しない（この呼び出し内だけで使う値）。
 *
 * 戻り値のbooking.emailは、既存のgetAdminBookingDetail同様、予約者のメールアドレスを
 * 含む（Booking Admin Web UIの既存詳細表示と同じ扱いのPII。宛先表示で予約者宛と
 * テスト送信先を区別する要件のため）。メール本文・秘密値はここでは一切返さない。
 */
function diagnoseReminderEligibility_impl_(bookingId, baseDateString) {
  var dateResolution = resolveDiagnosticsTargetDate_(baseDateString);
  if (dateResolution.error) {
    return { success: false, error: dateResolution.error };
  }
  var targetDateString = dateResolution.targetDateString;

  var found = SpreadsheetRepository.findRowByBookingId(bookingId);
  if (!found) {
    Logger.log('diagnoseReminderEligibility: NOT_FOUND bookingId=' + bookingId);
    return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
  }
  var record = found.record;
  var timezone = BookingConfig.getAvailabilityConfig().timezone;

  var evaluation = BookingMailer.evaluateReminderEligibility(record, { targetDateString: targetDateString });

  Logger.log(
    'diagnoseReminderEligibility: bookingId=' + bookingId +
      ' baseDate=' + baseDateString +
      ' targetDate=' + targetDateString +
      ' reasonCode=' + evaluation.reasonCode
  );

  return {
    success: true,
    bookingId: bookingId,
    baseDate: baseDateString,
    targetDate: targetDateString,
    eligible: evaluation.eligible,
    reasonCode: evaluation.reasonCode,
    message: evaluation.message,
    booking: {
      brand: record.brand || '',
      status: record.status || '',
      date: formatDiagnosticsDate_(record.date, timezone),
      email: record.email || ''
    }
  };
}

function diagnoseReminderEligibility(bookingId, baseDateString) {
  try {
    return diagnoseReminderEligibility_impl_(bookingId, baseDateString);
  } catch (unexpectedError) {
    Logger.log('diagnoseReminderEligibility: 想定外の例外 bookingId=' + bookingId);
    return { success: false, error: { code: 'INTERNAL_ERROR', message: DIAGNOSTICS_GENERIC_ERROR_MESSAGE_ } };
  }
}

/*
 * 本番テンプレートによる件名・本文のプレビュー（Issue #330 受入条件3）。
 * BookingMailTemplates.buildReminderMail（本番のsendReminderMailForBookingが使うのと
 * 同じ純粋関数）をそのまま呼ぶだけで、テンプレート自体は複製しない。
 * reveal（省略時false）がfalseの間は解錠コード・キーボックス番号をマスクする。
 * マスクの有無に関わらず、生成に使うrecord/mailConfig/timezoneは本番と同一のもの
 * （Booking Adminプロジェクト自身のScript Properties）を使うため、実際に管理者宛
 * テスト送信した場合と同じ内容になる（プレビューはマスクのみが差分）。
 *
 * options.baseDateString（必須。Issue #330 PRレビュー対応）: 未入力・不正形式・
 * 実在しない日付はINVALID_BASE_DATEで停止し、プレビュー自体を生成しない
 * （以前は不正値を無視してtargetDateString=nullのまま判定し、成功扱いになり
 * 得た）。有効な日付はdiagnoseReminderEligibilityと同じ
 * resolveDiagnosticsTargetDate_/BookingMailer.evaluateReminderEligibilityへ渡し、
 * 戻り値のeligible/reasonCodeへ反映する。
 *
 * 「プレビューの生成に成功したこと」と「本番なら実際に送信対象であること」は別物
 * のため、対象外（eligible:false）の予約でもプレビュー自体は生成して返す
 * （件名・本文の見た目を確認したいという診断ニーズのため）。呼び出し側（UI）は
 * success（プレビュー生成の成否）とeligible（送信対象かどうか）を別項目として
 * 画面に表示し、区別すること。
 */
function previewReminderMail_impl_(bookingId, options) {
  var opts = options || {};

  var dateResolution = resolveDiagnosticsTargetDate_(opts.baseDateString);
  if (dateResolution.error) {
    return { success: false, error: dateResolution.error };
  }
  var targetDateString = dateResolution.targetDateString;

  var found = SpreadsheetRepository.findRowByBookingId(bookingId);
  if (!found) {
    return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
  }
  var record = found.record;

  var mailConfig = BookingConfig.getMailConfig();
  var accessGuide = BookingConfig.getAccessGuideConfig();
  var maskedGuide = maskDiagnosticsAccessGuide_(accessGuide, !!opts.reveal);

  var mail;
  try {
    mail = BookingMailTemplates.buildReminderMail(record, mailConfig, maskedGuide);
  } catch (buildError) {
    Logger.log('previewReminderMail: 生成失敗 bookingId=' + bookingId);
    return {
      success: false,
      error: {
        code: 'MAIL_NOT_READY',
        message: BookingMailer.sanitizeErrorMessage(
          String((buildError && buildError.message) || buildError),
          [accessGuide.keyboxNumber, accessGuide.unlockCode]
        )
      }
    };
  }

  var evaluation = BookingMailer.evaluateReminderEligibility(record, { targetDateString: targetDateString });

  return {
    success: true,
    targetDate: targetDateString,
    subject: mail.subject,
    body: mail.body,
    recipientEmail: record.email || '',
    testRecipientEmail: BookingConfig.getAdminNotificationEmail(),
    revealed: !!opts.reveal,
    eligible: evaluation.eligible,
    reasonCode: evaluation.reasonCode
  };
}

function previewReminderMail(bookingId, options) {
  try {
    return previewReminderMail_impl_(bookingId, options);
  } catch (unexpectedError) {
    Logger.log('previewReminderMail: 想定外の例外 bookingId=' + bookingId);
    return { success: false, error: { code: 'INTERNAL_ERROR', message: DIAGNOSTICS_GENERIC_ERROR_MESSAGE_ } };
  }
}

/*
 * 管理者宛テスト送信（Issue #330 受入条件4）。診断専用の別経路で、実予約者へは
 * 一切送信しない（宛先は常にScript Property `ADMIN_NOTIFICATION_EMAIL` 固定。
 * 画面からの宛先入力・変更機能は設けない）。
 *
 * 送信対象は、diagnoseReminderEligibilityと同じ`BookingMailer.
 * evaluateReminderEligibility`がeligible:trueを返した場合のみ（本番なら実際に
 * 送信されるはずの組み合わせだけをテスト送信できる、という設計。「対象外」を
 * 無視して強制送信する経路は用意しない。既存の管理者個別再送
 * （BookingAdmin.gsのforce）とは別物であり、本関数はforce相当の状態無視は行わない）。
 *
 * ADMIN_NOTIFICATION_EMAILが未設定・形式不正の場合はfail-closedで送信しない。
 * 成功・失敗いずれの場合も、SpreadsheetRepository.updateBookingFields /
 * RecoveryRepository.recordFailure / BookingMailer.withBookingLock_のいずれも呼ばない
 * （booking行・Recoveryシートは一切書き換えない）。
 */
function sendReminderTestMail_impl_(bookingId, baseDateString) {
  var dateResolution = resolveDiagnosticsTargetDate_(baseDateString);
  if (dateResolution.error) {
    return { success: false, error: dateResolution.error };
  }
  var targetDateString = dateResolution.targetDateString;

  var found = SpreadsheetRepository.findRowByBookingId(bookingId);
  if (!found) {
    Logger.log('sendReminderTestMail: NOT_FOUND bookingId=' + bookingId);
    return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
  }
  var record = found.record;

  var adminEmail = BookingConfig.getAdminNotificationEmail();
  if (!isValidDiagnosticsEmail_(adminEmail)) {
    Logger.log('sendReminderTestMail: ADMIN_NOTIFICATION_EMAIL未設定または不正 bookingId=' + bookingId);
    return {
      success: false,
      error: { code: 'ADMIN_EMAIL_NOT_CONFIGURED', message: 'Script PropertiesのADMIN_NOTIFICATION_EMAILが未設定、または形式が正しくありません。' }
    };
  }

  var evaluation = BookingMailer.evaluateReminderEligibility(record, { targetDateString: targetDateString });
  if (!evaluation.eligible) {
    Logger.log('sendReminderTestMail: 対象外 bookingId=' + bookingId + ' reasonCode=' + evaluation.reasonCode);
    return { success: false, eligible: false, reasonCode: evaluation.reasonCode, error: { code: evaluation.reasonCode, message: evaluation.message } };
  }

  var mailConfig = BookingConfig.getMailConfig();
  var accessGuide = BookingConfig.getAccessGuideConfig();
  var mail;
  try {
    mail = BookingMailTemplates.buildReminderMail(record, mailConfig, accessGuide);
  } catch (buildError) {
    Logger.log('sendReminderTestMail: 本文生成失敗 bookingId=' + bookingId);
    return {
      success: false,
      error: {
        code: 'MAIL_NOT_READY',
        message: BookingMailer.sanitizeErrorMessage(
          String((buildError && buildError.message) || buildError),
          [accessGuide.keyboxNumber, accessGuide.unlockCode]
        )
      }
    };
  }

  try {
    MailApp.sendEmail({
      to: adminEmail,
      subject: '[TEST] ' + mail.subject,
      body: mail.body,
      name: mailConfig.displayName,
      replyTo: mailConfig.replyTo
    });
  } catch (sendError) {
    var sanitized = BookingMailer.sanitizeErrorMessage(
      String((sendError && sendError.message) || sendError),
      [accessGuide.keyboxNumber, accessGuide.unlockCode]
    );
    Logger.log('sendReminderTestMail: 送信失敗 bookingId=' + bookingId + ' ' + sanitized);
    return { success: false, error: { code: 'MAIL_SEND_FAILED', message: sanitized } };
  }

  Logger.log('sendReminderTestMail: 送信成功 bookingId=' + bookingId);
  return { success: true, sentTo: adminEmail };
}

function sendReminderTestMail(bookingId, baseDateString) {
  try {
    return sendReminderTestMail_impl_(bookingId, baseDateString);
  } catch (unexpectedError) {
    Logger.log('sendReminderTestMail: 想定外の例外 bookingId=' + bookingId);
    return { success: false, error: { code: 'INTERNAL_ERROR', message: DIAGNOSTICS_GENERIC_ERROR_MESSAGE_ } };
  }
}
