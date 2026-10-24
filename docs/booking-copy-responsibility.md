# 予約機能のバックエンド／フロントエンド責務（Issue #465）

公開予約画面（`/studio-x/booking/`）の利用者向け表示について、バックエンド（GAS）とフロントエンドの責務を分ける。

## バックエンド（`gas/booking/shared/BookingOptions.gs` ほか）の責務

- 料金・在庫・有料／無料区分・必須依存関係・決済可否・予約成立条件
- 内部の承認／確認状態（`PENDING_APPROVAL` 等の状態名は内部で維持してよい）
- API 向けの安定した **コード・フラグ・enum**
  - 公開カタログ（`optionCatalog`）の `policy`（`BookingOptions.PUBLIC_POLICY`）
  - 注文の `status` / `requiresApproval` / `payable`、エラーの `error.code`
- **利用者向けの日本語の文章は公開 API に載せない**（`catalog.notices` は廃止。`NOTICES` はメール本文用）

## フロントエンド（`scripts/booking-options.js` ほか）の責務

- 利用者向けコピー・説明文・注記・ボタン文言（`copyFor(catalog)` / `ERROR_COPY` / `describeOrderStatus`）
- `policy` や `status` などの意味を、利用者の行動（「確認後にご案内」「ご利用可能な場合のみお支払い」）に翻訳して表示する
- サーバーの `error.message` は表示しない。`error.code` から `ERROR_COPY` を引く（未知のコードは汎用文）
- 公開画面に出さない語: `Admin` / `管理者` / `承認` / `利用許可` / `PENDING_APPROVAL` 等の内部状態名

## 新しい条件・エラーを足すとき

1. GAS: `PUBLIC_POLICY_` にフラグ／enum を足す（文章は足さない）。新しい `error.code` を返すなら code を決める。
2. フロント: `copyFor` / `ERROR_COPY` に利用者向け文言を足す。
3. `test/booking-public-copy.test.js` が、レンダリング結果・公開 HTML・フロント文言の内部用語 0 件と、
   GAS の全 `error.code` に文言があることを検査する。

## 非対象

GAS 内部のコメント・変数名・状態名、管理画面、管理者宛メールは内部用語のままでよい。
