/*
 * BookingAccessApproval.gs — 鍵承認（Issue #341 PR-D「鍵・来場案内の開示ゲート」）。
 * Booking Adminプロジェクト専用（公開Web App・Webhookプロジェクトには配布しない。
 * 予約IDだけで公開Web Appから承認できる経路は作らない）。
 *
 * - 対象はBooking.requiresAccessApproval（Stripeカード決済かつ当日予約でない予約）のみ。
 *   対象外の予約（現地払い・旧Payment Link・当日予約）はACCESS_APPROVAL_NOT_REQUIREDで拒否する
 *   （承認しなくても従来どおり前日リマインドが送られる）。
 * - 承認できるのは、予約がCONFIRMED、かつBooking.evaluateAccessGate（前日リマインドの送信
 *   判定と同じ関数）が承認以外の条件をすべて満たす場合のみ（入金済み・要復旧なし・返金の
 *   判断や手続きが始まっていない）。未入金・取消済み・失効済み・Recovery未解消の予約は
 *   承認できない。
 * - 承認はaccessApprovedAtを記録するだけで、メール送信は一切トリガーしない（Issue #341
 *   受入条件）。送信は前日18時の自動送信、または「来場案内を再送」でのみ行う。
 * - 冪等: 既に承認済みなら何も書き込まずalreadyApproved:trueを返す（承認日時を上書きしない）。
 *   Lock取得後に最新行を再読込して判定するため、二重クリックでも書き込みは1回だけ。
 */
'use strict';

var BookingAccessApproval = (function () {
  var LOCK_TIMEOUT_MS_ = 10000;

  function fail_(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  function approveAccess(bookingId, now) {
    if (!bookingId) return fail_('INVALID_BOOKING_ID', 'bookingIdを指定してください。');
    var effectiveNow = now && typeof now.getTime === 'function' && !isNaN(now.getTime()) ? now : new Date();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return fail_('LOCK_TIMEOUT', '一時的に混み合っています。もう一度お試しください。');
    }
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) return fail_('NOT_FOUND', 'bookingIdが見つかりません: ' + bookingId);
      var record = found.record;
      var timezone = BookingConfig.getAvailabilityConfig().timezone;
      if (!Booking.requiresAccessApproval(record, timezone)) {
        return fail_('ACCESS_APPROVAL_NOT_REQUIRED', 'この予約は鍵承認の対象外です（現地払い・旧決済リンク・当日予約は従来どおり前日案内が送られます）。');
      }
      if (record.status !== Booking.STATUS.CONFIRMED) {
        return fail_('INVALID_STATUS', (record.status || '未設定') + ' の予約は鍵承認できません（CONFIRMEDのみ）。');
      }
      var gate = Booking.evaluateAccessGate(record, timezone, { ignoreApproval: true });
      if (!gate.ok) {
        return fail_(gate.reasonCode, gate.message.replace('鍵情報を含む来場案内を送信できません', '鍵承認できません'));
      }
      if (record.accessApprovedAt) {
        return { success: true, alreadyApproved: true, bookingId: bookingId, accessApprovedAt: record.accessApprovedAt };
      }
      SpreadsheetRepository.updateBookingFields(bookingId, { accessApprovedAt: effectiveNow });
      var saved = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!saved || !saved.record.accessApprovedAt) {
        return fail_('ACCESS_APPROVAL_SAVE_FAILED', '鍵承認を保存できませんでした。もう一度お試しください。');
      }
      return { success: true, bookingId: bookingId, accessApprovedAt: saved.record.accessApprovedAt };
    } catch (error) {
      Logger.log('BookingAccessApproval: 鍵承認の保存に失敗しました: ' + bookingId + ' ' + BookingMailer.sanitizeErrorMessage(String((error && error.message) || error)));
      return fail_('ACCESS_APPROVAL_SAVE_FAILED', '鍵承認を保存できませんでした。もう一度お試しください。');
    } finally {
      lock.releaseLock();
    }
  }

  return {
    approveAccess: approveAccess
  };
})();
