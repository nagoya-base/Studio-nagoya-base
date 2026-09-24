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
 * すべて`BookingMailer.evaluateReminderEligibility(record, targetDateString)`
 * （BookingMailer.gs。本番の`withBookingLock_`/`ensureMailConfigComplete_`/
 * `ensureAccessGuideComplete_`と同じ内部関数を経由する）と、翌日日付計算
 * `computeNextDayDateString_`（BookingReminderTriggers.gs。`sendNextDayReminders`と
 * 共有）をそのまま呼ぶ。
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
 * デプロイ先はBookingAdmin.gs等と同じBooking Adminプロジェクト（`SPREADSHEET_ID`の
 * Spreadsheetへコンテナバインド）。公開Booking Web App（Code.gs）には配置しない。
 */
'use strict';

/*
 * 'YYYY-MM-DD'の基準日文字列を、UTC正午のDateへ変換する（Issue #330）。
 * UTC正午を使うのは、Availability.gsのdaysInMonth_/formatDateWithWeekdayと同じ
 * 「Date.UTC(year, month-1, day)で暦日を組み立てる」方針を踏襲しつつ、
 * その後の`+24時間`（computeNextDayDateString_）でJST等の日付境界をまたぐ事故を
 * 避けるため（UTC正午はJSTでは21:00であり、暦日の前後にずれる余地がない）。
 * 不正な形式の場合はnullを返す（呼び出し側でfail-closedに扱う）。
 */
function parseDiagnosticsBaseDate_(dateString) {
  if (!BookingAvailability.isValidDateString(dateString)) return null;
  var parts = dateString.split('-');
  return new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0));
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
   duck-typing方針）。診断結果の表示専用で、判定ロジックには使わない。 */
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
 * baseDateString: 管理者が指定する「基準日（今日扱い）」（'YYYY-MM-DD'）。
 *   本番の時計・トリガーには一切影響しない（この呼び出し内だけで使う値）。
 *
 * 戻り値のbooking.emailは、既存のgetAdminBookingDetail同様、予約者のメールアドレスを
 * 含む（Booking Admin Web UIの既存詳細表示と同じ扱いのPII。宛先表示で予約者宛と
 * テスト送信先を区別する要件のため）。メール本文・秘密値はここでは一切返さない。
 */
function diagnoseReminderEligibility(bookingId, baseDateString) {
  var baseDate = parseDiagnosticsBaseDate_(baseDateString);
  if (!baseDate) {
    return { success: false, error: { code: 'INVALID_BASE_DATE', message: '基準日の形式が正しくありません（YYYY-MM-DD）。' } };
  }

  var timezone = BookingConfig.getAvailabilityConfig().timezone;
  var targetDateString = computeNextDayDateString_(baseDate, timezone);
  if (!targetDateString) {
    return { success: false, error: { code: 'INVALID_CONFIG', message: 'TIMEZONE設定が不正なため翌日を計算できませんでした。' } };
  }

  var found = SpreadsheetRepository.findRowByBookingId(bookingId);
  if (!found) {
    Logger.log('diagnoseReminderEligibility: NOT_FOUND bookingId=' + bookingId);
    return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
  }
  var record = found.record;

  var evaluation = BookingMailer.evaluateReminderEligibility(record, targetDateString);

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

/*
 * 本番テンプレートによる件名・本文のプレビュー（Issue #330 受入条件3）。
 * BookingMailTemplates.buildReminderMail（本番のsendReminderMailForBookingが使うのと
 * 同じ純粋関数）をそのまま呼ぶだけで、テンプレート自体は複製しない。
 * reveal（省略時false）がfalseの間は解錠コード・キーボックス番号をマスクする。
 * マスクの有無に関わらず、生成に使うrecord/mailConfig/timezoneは本番と同一のもの
 * （Booking Adminプロジェクト自身のScript Properties）を使うため、実際に管理者宛
 * テスト送信した場合と同じ内容になる（プレビューはマスクのみが差分）。
 *
 * baseDateStringは省略可（プレビュー自体は基準日が無くても生成できるが、指定した
 * 場合はeligible/reasonCodeもあわせて返す。指定しない場合はNOT_NEXT_DAY判定を
 * 行わない＝targetDateStringを渡さない扱いになる。BookingMailer.
 * evaluateReminderEligibilityのコメント参照）。
 */
function previewReminderMail(bookingId, options) {
  var opts = options || {};

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

  var targetDateString = null;
  if (opts.baseDateString) {
    var baseDate = parseDiagnosticsBaseDate_(opts.baseDateString);
    if (baseDate) {
      targetDateString = computeNextDayDateString_(baseDate, BookingConfig.getAvailabilityConfig().timezone);
    }
  }
  var evaluation = BookingMailer.evaluateReminderEligibility(record, targetDateString);

  return {
    success: true,
    subject: mail.subject,
    body: mail.body,
    recipientEmail: record.email || '',
    testRecipientEmail: BookingConfig.getAdminNotificationEmail(),
    revealed: !!opts.reveal,
    eligible: evaluation.eligible,
    reasonCode: evaluation.reasonCode
  };
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
function sendReminderTestMail(bookingId, baseDateString) {
  var baseDate = parseDiagnosticsBaseDate_(baseDateString);
  if (!baseDate) {
    return { success: false, error: { code: 'INVALID_BASE_DATE', message: '基準日の形式が正しくありません（YYYY-MM-DD）。' } };
  }

  var timezone = BookingConfig.getAvailabilityConfig().timezone;
  var targetDateString = computeNextDayDateString_(baseDate, timezone);
  if (!targetDateString) {
    return { success: false, error: { code: 'INVALID_CONFIG', message: 'TIMEZONE設定が不正なため翌日を計算できませんでした。' } };
  }

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

  var evaluation = BookingMailer.evaluateReminderEligibility(record, targetDateString);
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
