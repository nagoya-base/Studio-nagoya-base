# #658 本番 /mens/ の確認画像（通常Jekyllビルド・Chromium・GA4通信は遮断）

- top-pc / top-sp390 / top-sp320: 初期表示。390・320pxで横スクロールなし
- top-nojs: JS無効 / top-reduced: reduced-motion
- form-pc: 相談フォーム（有効）。`fieldset[disabled]` なし、無効な入力欄0件、カーソルは text、キーボードで入力可能、`meta robots` なし、`gtag` 読込済み
- 送信は行っていません（実申込なし）。作品切替のスクロール確認は未実施

## 作品切替・写真拡大（PC 1280 / SP 390、通常Jekyllビルドの本番 /mens/）
- スクロール中の表示作品は 1→2→3→4 の順に切り替わり（`is-active` 有効）、JSエラーなし
- 現在の作品の写真を押すと拡大モーダルが開き、閉じられる（works-*.png / zoom-*.png）
