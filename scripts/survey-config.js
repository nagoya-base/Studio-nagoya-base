/*
 * scripts/survey-config.js — アンケート（Issue #374）が呼び出すGAS Web AppのURL設定。
 *
 * BASE_URL には公開アンケートWeb App（gas/survey/public/。Execute as: Me / Anyone）の
 * `/exec` URLを設定する。URL自体は公開情報（Spreadsheet ID等の秘密情報は含まない）。
 * 未設定（空文字）の間は、画面は表示されるが送信時に「準備中」と案内して保存しない。
 * デプロイ手順は gas/survey/README.md を参照。
 */
window.SurveyApiConfig = {
  BASE_URL: 'https://script.google.com/macros/s/AKfycby0xcPlMcQmFzKQ7GiR3Ka34XJzR3BAO1TZZOXPHGys3uY-6dmlmkxdb54apIpFy7Cc/exec'
};
