/*
 * scripts/feedback-config.js — 利用後アンケート（Issue #835）が呼び出す公開GAS Web AppのURL設定。
 *
 * BASE_URL には gas/feedback/（Execute as: Me / Anyone）の `/exec` URLを設定する。URL自体は公開情報。
 * 既存 /survey/ の scripts/survey-config.js とは別のURL（別プロジェクト）で、共有しない。
 * 未設定（空文字）の間は画面は表示されるが、送信時に「準備中」と案内して保存しない。
 * 手順は gas/feedback/README.md を参照（オーナー承認前にデプロイ・設定しない）。
 */
window.FeedbackApiConfig = {
  BASE_URL: 'https://script.google.com/macros/s/AKfycbx58zdSmueqRqE36stH03gYjbiRmHQJxmXYGZEuixLRvMeAPrIoipGIzoB6LAOGq0Jh/exec'
};
