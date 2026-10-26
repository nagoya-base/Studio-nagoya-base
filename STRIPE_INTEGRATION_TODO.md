# STRIPE_INTEGRATION_TODO（Issue #516）

Stripe Checkout Studioで設定したHosted CheckoutのUIパラメータを、既存のCheckout Session作成処理へ最小反映した作業の残作業の単一正本。

**Scenario A**（既存のCheckout Session作成処理あり）として実装した。新規のStripe基盤・route・endpoint・middleware・webhookは追加していない。

## Values to Replace

| ファイル | 項目 | 現在値 | 設定すべき値 |
| --- | --- | --- | --- |
| [gas/booking/shared/StripeGateway.gs](gas/booking/shared/StripeGateway.gs) | `mode` | 既存の実値（`payment`） | **置換不要**（Scenario A。既存実値を維持） |
| 同上 | `success_url` / `cancel_url` | 呼び出し元が渡す既存の実値（Script Properties由来） | **置換不要** |
| 同上 | `line_items` | 呼び出し元が渡す既存の実値（`price_data`方式） | **置換不要** |

サンプル値・プレースホルダーは残っていない。

## Configured Parameters

[gas/booking/shared/StripeGateway.gs](gas/booking/shared/StripeGateway.gs) の既存2箇所のSession作成payload（`buildCreateSessionPayload_` / `createMembershipCheckoutSession`）へ直接追加した（共通化・リファクタリングはしていない）。

| パラメータ | 値 |
| --- | --- |
| `ui_mode` | `hosted_page` |
| `billing_address_collection` | `auto` |
| `phone_number_collection[enabled]` | `false` |
| `automatic_tax[enabled]` | `false` |
| `allow_promotion_codes` | `false` |
| `submit_type` | `auto` |
| `name_collection[individual][enabled]` | `true` |
| `name_collection[individual][optional]` | `true` |
| `integration_identifier` | `hosted_web_0001` |
| `origin_context` | `web` |
| `payment_method_collection` | `always`（**mode=subscriptionの場合のみ**。現状、本リポジトリのSessionはすべてmode=paymentのため付与されない） |

### Checkout Session作成箇所（すべて確認済み）

`https://api.stripe.com/v1/checkout/sessions` へPOSTする箇所は `StripeGateway.gs` 内の2関数のみ（REST API直叩き。SDK未使用・`Stripe-Version`ヘッダ未指定のまま維持）。

| 関数 | 用途 | 呼び出し元 |
| --- | --- | --- |
| `createCheckoutSession`（`buildCreateSessionPayload_`） | 部屋予約のカード決済・追加オプション決済 | `BookingRepository.gs`、`OptionOrderService.gs` |
| `createMembershipCheckoutSession` | SNB MEMBER入会（mode=payment） | `MembershipService.gs` |

## Setup and next steps

### 既存設定の確認

- 追加のScript Properties・API keyは不要。既存の `STRIPE_SECRET_KEY` / `STRIPE_CHECKOUT_ENABLED` / `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` / `STRIPE_MEMBERSHIP_SUCCESS_URL` / `STRIPE_MEMBERSHIP_CANCEL_URL` をそのまま使う。
- Secret/API keyのコミット・ログ出力は行っていない。

### 変更ファイル構成

- `gas/booking/shared/StripeGateway.gs`: Checkout Studio固定値の定数と適用関数を追加し、上記2つのSession作成ペイロードへ適用
- `test/stripe-gateway.test.js`: 固定値・既存値維持・mode=paymentに `payment_method_collection` が付かないことのテストを追加
- `STRIPE_INTEGRATION_TODO.md`: 本ファイル

周辺ロジック（Webhook・Subscription作成・予約・会員ロジック）は変更していない。

### Checkoutフロー概要

1. 予約/入会/追加オプションの各処理が `StripeGateway.createCheckoutSession` または `createMembershipCheckoutSession` を呼ぶ。
2. ペイロード（既存パラメータ + Checkout Studio固定値）をform-urlencodedでStripeへPOST。
3. 返却された `url` へ利用者を遷移（Hosted Checkout）。
4. 決済完了はStripe Webhook（既存）→ `StripeWebhookProcessor` が Checkout Session / PaymentIntent を再取得して照合（変更なし）。

### `ui_mode` について

本リポジトリはStripe SDKを使わずREST APIを直接呼んでいるため、Issueの「SDK 21未満のみ `hosted`」は該当せず、`ui_mode=hosted_page` を使用する。`Stripe-Version` は固定していない。本番反映前に、テストモードでSession作成が成功することを必ず確認すること。

### 要注意: 未解決の決済試行とIdempotency-Key

予約のカード決済は `paymentAttemptId` をIdempotency-Keyにして再送できる設計。デプロイ前に送信され結果不明（`STRIPE_CHECKOUT_SESSION_CREATE_UNKNOWN`）の決済試行を、デプロイ後に同じキーで再送すると、ペイロードが変わっているためStripeが `idempotency_error` を返し得る（`STRIPE_IDEMPOTENCY_CONFLICT` として要手動対応扱い。Stripeのキー保持期間は約24時間）。デプロイは結果不明の決済試行が残っていない時間帯に行うこと。

### Stripeテストモードでの確認方法

1. テストキー（`sk_test_...`）のScript Propertiesで、Booking Web Appをテスト用デプロイに反映（PRブランチから本番デプロイは行わない）。
2. **正常系**: テスト予約→カード決済へ進み、Hosted Checkoutに氏名入力（任意）が表示され、電話番号・プロモーションコード入力が出ないことを確認。`4242 4242 4242 4242` で決済。
3. **キャンセル系**: Checkoutで戻る → `cancel_url` へ遷移し、予約が決済待ちのまま仮押さえ期限で失効することを確認。
4. **既存Webhook照合**: 決済完了後、Webhook処理で予約が確定し（Booking系）、金額・metadata照合が通ることを確認。追加オプション決済・SNB MEMBER入会でも同様に確認。
5. Stripe Dashboardのテストモード > ログで、Session作成リクエストに上記固定値が含まれ、`mode` / `success_url` / `cancel_url` / `line_items` が従来どおりであることを確認。

### SNB MEMBERに関する注意（本Issueの対象外）

SNB MEMBERは、初回Checkout（mode=payment）後に別途 `createMembershipSubscription()` でSubscriptionを作成する構成。以下は**別問題**であり、#516では一切変更していない。

- `POST /v1/subscriptions` の `STRIPE_ERROR`（Subscription作成失敗）の修正
- 返金後も会員資格が残る問題（返金後の会員資格取消ロジック）
- `createMembershipSubscription()` の修正

初回Checkoutの `customer_creation` / `payment_intent_data[setup_future_usage]` / `customer_email` / `metadata` / `client_reference_id` は、後続のSubscription作成が依存するため維持している。

### Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
