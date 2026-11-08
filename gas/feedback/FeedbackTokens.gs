/*
 * FeedbackTokens.gs — 本番回答用トークンの検証インターフェース（Issue #835 第1段階）。
 *
 * 第1段階では Booking（予約・送信・消費台帳）と結合しない。既定の実装は常に TOKEN_NOT_CONNECTED を返すため、
 * 一般公開フォームから本番回答（is_test=0）は保存できない（fail closed）。
 * 第3段階 #834 で、このオブジェクトを Booking 側の台帳に接続した実装へ差し替える。
 *
 * 実装が満たす契約（第3段階向け。テストではモックで検証している）:
 *   verify(token, brand, now)  → { ok:true } / { ok:false, code }   台帳を変更しない
 *   consume(token, brand, now) → { ok:true } / { ok:false, code }   未使用を再確認して使用済みにする
 *   release(token, brand)      → 回答保存に失敗したとき consume を取り消す（未使用へ戻す）
 *   code: TOKEN_INVALID / TOKEN_USED / TOKEN_EXPIRED / TOKEN_BRAND_MISMATCH / TOKEN_NOT_CONNECTED
 * 予定ルール: 予約ごと1回答、利用終了後14日有効、トークンのブランドとフォームのブランドが一致すること。
 * 回答シートにはトークン・予約ID・ダイジェストを書かない（呼び出し側 FeedbackWebApp.gs も渡さない）。
 */
'use strict';

var FEEDBACK_TOKEN_ERROR_CODES = ['TOKEN_INVALID', 'TOKEN_USED', 'TOKEN_EXPIRED', 'TOKEN_BRAND_MISMATCH', 'TOKEN_NOT_CONNECTED'];

var FeedbackTokens = {
  verify: function () { return { ok: false, code: 'TOKEN_NOT_CONNECTED' }; },
  consume: function () { return { ok: false, code: 'TOKEN_NOT_CONNECTED' }; },
  release: function () {}
};
