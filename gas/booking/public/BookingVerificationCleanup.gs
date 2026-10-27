/*
 * BookingVerificationCleanup.gs — 期限切れOTP・確認済み証明（BookingMemberVerifications）の定期削除（Issue #557）。
 *
 * 【デプロイ先】Booking Web App（スタンドアロン）。OTP・証明を発行/検証する BookingMemberVerification.gs と同じ
 * プロジェクトに置くことで、同じ LockService.getScriptLock() で requestCode / verifyCode と直列化される
 * （Booking Adminは別プロジェクト＝別のスクリプトロックのため、そこに置くと排他にならない）。
 * 配布対象は Web App のみ。Admin・Webhookへは配布しない。
 *
 * 時間主導トリガー（日次）のハンドラ関数名として cleanupExpiredBookingVerifications をそのまま指定する（引数不要）。
 * トリガーは自動作成しない。GASエディタのトリガー画面から手動で1本だけ作成する（README「Issue #557」節）。
 * ScriptApp.newTrigger には script.scriptapp スコープが要り、公開Web Appのmanifestを変えると再承認が必要に
 * なるため、本Issueではトリガー作成用の補助関数を置かない。
 *
 * ログは実行時刻・件数・結果区分のみ。メールアドレス・OTP・証明・ハッシュ・行内容は記録しない。
 */
'use strict';

var BookingVerificationCleanup = (function () {
  var LOCK_TIMEOUT_MS_ = 10000;

  function run(now, options) {
    var at = now && typeof now.getTime === 'function' && !isNaN(now.getTime()) ? now : new Date();
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      var busy = { status: 'LOCK_TIMEOUT', ranAt: at.toISOString(), deleted: 0 };
      Logger.log('cleanupExpiredBookingVerifications: ' + JSON.stringify(busy));
      return busy;
    }
    var outcome;
    try {
      var purged = MemberRepository.purgeExpiredBookingVerifications(at, options);
      outcome = {
        status: purged.failed ? 'PARTIAL_FAILURE' : (purged.truncated ? 'TRUNCATED' : 'OK'),
        ranAt: at.toISOString(),
        scanned: purged.scanned, deleted: purged.deleted, retained: purged.retained,
        skippedUndecidable: purged.skippedUndecidable, candidates: purged.candidates
      };
    } catch (error) {
      /* 例外メッセージは行内容を含み得ないが、念のため固定文言だけを残す。 */
      Logger.log('cleanupExpiredBookingVerifications: ' + JSON.stringify({ status: 'ERROR', ranAt: at.toISOString() }));
      throw new Error('cleanupExpiredBookingVerifications failed');
    } finally {
      lock.releaseLock();
    }
    Logger.log('cleanupExpiredBookingVerifications: ' + JSON.stringify(outcome));
    return outcome;
  }

  return { run: run };
})();

/* 時間主導トリガーのハンドラ（引数不要）。now/optionsはテストから固定するための任意引数。 */
function cleanupExpiredBookingVerifications(now, options) {
  var outcome = BookingVerificationCleanup.run(now, options);
  if (outcome.status === 'PARTIAL_FAILURE') throw new Error('cleanupExpiredBookingVerifications partially failed');
  return outcome;
}
