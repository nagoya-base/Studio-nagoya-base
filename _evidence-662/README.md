# Issue #662 確認画像（before=main 6224ccd / after=PR #664）
Jekyllビルド＋Chromium（外部通信遮断）で取得。実予約・実決済・実加入は発生させていません。
- `*-membership-pc|sp390|sp320`：会員案内（文字入りヒーロー1600x841とH1の併存）
- `*-howto-steps-pc`：利用ガイドの手順1〜6（青地は白文字）
- `*-legal-sp390`：規約
- `*-booking-pc`、`*-booking-mock-pc`：予約フォームと、モックで表示した空きあり／選択中／満席／先行枠／見積／入力エラー／エラー／送信中（モックは確認用に注入した表示）
- `*-join-form-states`：会員加入フォームの入力フォーカス・エラー・成功・送信中
- `*-payment-complete-pc`、`*-member-complete-pc`：完了ページ
横はみ出し：8ページ×PC/390/320pxで0。唯一 legal の320pxは7pxだが変更前（main）も同じ7px（既存・本PRで悪化なし）。
