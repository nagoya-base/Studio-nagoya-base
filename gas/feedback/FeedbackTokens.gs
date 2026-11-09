/*
 * FeedbackTokens.gs — 本番回答用トークンの検証（Issue #835 で定義した契約を、Issue #834 第3段階で実装）。
 *
 * トークンは Booking Admin が利用終了2時間後の案内メールで発行する（形式・署名は FeedbackTokenCore.gs）。
 * このプロジェクトは Booking の Spreadsheet を開かない。共有するのは Script Property `FEEDBACK_TOKEN_SECRET` だけ。
 * 秘密鍵が未設定・短すぎる場合は従来どおり常に TOKEN_NOT_CONNECTED（本番回答は保存できない＝fail closed）。
 *
 * 契約（FeedbackWebApp.gs から呼ぶ）:
 *   verify(token, brand, now)  → { ok:true } / { ok:false, code }   台帳を変更しない
 *   consume(token, brand, now) → { ok:true } / { ok:false, code }   未使用を再確認して使用済みにする
 *   release(token, brand)      → 回答保存に失敗したとき consume を取り消す（未使用へ戻す）
 *   code: TOKEN_INVALID / TOKEN_USED / TOKEN_EXPIRED / TOKEN_BRAND_MISMATCH / TOKEN_NOT_CONNECTED / STORAGE_UNAVAILABLE
 * consume / release は FeedbackWebApp.gs の回答保存と同じスクリプトロックの中で呼ばれる（同時送信でも1予約1回答）。
 *
 * 使用済み台帳は回答Spreadsheetの `token_uses` シート（列: token_key, expires_at）。
 * token_key は予約IDではなく 'tk_' + tokenId（秘密鍵なしに予約へ戻せない。接頭辞はSheetsが16進を数値と誤認しないため）。responses シートとは結び付けない
 * （response_id・回答日時を台帳へ書かない）。期限切れの行は purgeExpiredFeedbackTokenUses で削除できる。
 */
'use strict';

var FEEDBACK_TOKEN_ERROR_CODES = ['TOKEN_INVALID', 'TOKEN_USED', 'TOKEN_EXPIRED', 'TOKEN_BRAND_MISMATCH', 'TOKEN_NOT_CONNECTED', 'STORAGE_UNAVAILABLE'];

var FeedbackTokens = (function () {
  function secret_() {
    return String(PropertiesService.getScriptProperties().getProperty('FEEDBACK_TOKEN_SECRET') || '').trim();
  }

  function hmacHex_(key, message) {
    return FeedbackTokenCore.bytesToHex(Utilities.computeHmacSha256Signature(message, key, Utilities.Charset.UTF_8));
  }

  function ledgerKey_(tokenId) { return 'tk_' + tokenId; }

  function check_(token, brand, now) {
    return FeedbackTokenCore.check(token, brand, now.getTime(), secret_(), hmacHex_);
  }

  function verify(token, brand, now) {
    var checked = check_(token, brand, now);
    if (!checked.ok) return checked;
    var ledger = FeedbackRepository.openTokenLedger();
    if (ledger.error) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    if (FeedbackRepository.isTokenUsed(ledger.sheet, ledgerKey_(checked.tokenId))) return { ok: false, code: 'TOKEN_USED' };
    return { ok: true };
  }

  function consume(token, brand, now) {
    var checked = check_(token, brand, now);
    if (!checked.ok) return checked;
    var ledger = FeedbackRepository.openTokenLedger();
    if (ledger.error) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    if (FeedbackRepository.isTokenUsed(ledger.sheet, ledgerKey_(checked.tokenId))) return { ok: false, code: 'TOKEN_USED' };
    var appended = FeedbackRepository.appendTokenUse(ledger.sheet, ledgerKey_(checked.tokenId), new Date(checked.expiresAtMs).toISOString());
    if (!appended) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
    return { ok: true };
  }

  /* 失敗しても例外を投げない（呼び出し側は既に保存失敗を返すところ）。ログは固定文言だけ。 */
  function release(token) {
    try {
      var tokenId = FeedbackTokenCore.verifiedTokenId(token, secret_(), hmacHex_);
      if (!tokenId) return false;
      var ledger = FeedbackRepository.openTokenLedger();
      if (ledger.error) {
        Logger.log('feedback token release failed: ledger unavailable');
        return false;
      }
      return FeedbackRepository.removeTokenUse(ledger.sheet, ledgerKey_(tokenId));
    } catch (releaseError) {
      Logger.log('feedback token release failed: ' + String((releaseError && releaseError.name) || 'Error').slice(0, 40));
      return false;
    }
  }

  return { verify: verify, consume: consume, release: release };
})();

/*
 * 期限切れの使用済み記録を削除する（任意。GASエディタから実行するか、GASの「トリガー」画面で月1回の時間主導トリガーを作る）。
 * 期限（expires_at）から1日以上過ぎた行だけを消す。期限切れのトークンは台帳が無くても TOKEN_EXPIRED で拒否されるため、
 * 消しても再回答はできない。回答保存と同じスクリプトロック内で行う（行番号のずれを防ぐ）。
 * 戻り値・ログは件数だけ。
 */
var FEEDBACK_TOKEN_USE_PURGE_GRACE_MS = 24 * 60 * 60 * 1000;

function purgeExpiredFeedbackTokenUses(now) {
  var current = now && typeof now.getTime === 'function' ? now : new Date();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('feedback token purge: LOCK_TIMEOUT');
    return { status: 'LOCK_TIMEOUT', deleted: 0 };
  }
  try {
    var ledger = FeedbackRepository.openTokenLedger();
    if (ledger.error) {
      Logger.log('feedback token purge: ' + ledger.error);
      return { status: ledger.error, deleted: 0 };
    }
    var deleted = FeedbackRepository.purgeTokenUses(ledger.sheet, current.getTime() - FEEDBACK_TOKEN_USE_PURGE_GRACE_MS);
    Logger.log('feedback token purge: OK deleted=' + deleted);
    return { status: 'OK', deleted: deleted };
  } finally {
    lock.releaseLock();
  }
}
