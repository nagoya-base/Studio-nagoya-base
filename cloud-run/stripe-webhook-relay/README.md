# stripe-webhook-relay

Stripe Webhookの署名検証**専用**の中継サービス（Issue #341 PR-C）。予約・決済の業務ロジック
（金額照合・冪等性判定・予約自動確定等）は一切持たない。それらはすべてGAS側
（`gas/booking/shared/StripeWebhookHandler.gs`）に一元化されている。

詳細な設計・認証チェーン・シークレット管理・ローテーション手順は
[`gas/booking/README.md`](../../gas/booking/README.md)の「Issue #341: Stripe API即時決済に
よる予約自動確定・自動返金・鍵承認ゲートへ移行（PR-C）」節を参照。

**このディレクトリのコードは、本番Cloud Runサービスとして未デプロイ。** オーナーの明示
承認後に、以下の手順でデプロイすること。

## 処理の流れ

1. Stripeから`Stripe-Signature`ヘッダー付きでWebhookイベントを受信する。
2. `stripe`公式SDKの`stripe.webhooks.constructEvent`で署名を検証する（自前のHMAC実装は
   使わない）。検証失敗（不正・欠落・許容時刻外）はここで拒否し、GASへは転送しない。
3. 検証済みの生の本文（`rawBody`）に対して、GASと共有する`GAS_WEBHOOK_RELAY_SECRET`で
   HMAC-SHA256を計算し、`{ timestamp, signature, body }`としてGASへPOSTする。
4. GASの応答JSON（`{ success: boolean, ... }`）を見て、Stripeへ返すHTTPステータスを決める。
   `success:true`のときのみ200、それ以外（`success:false`・GASへの到達自体の失敗）は
   5xx系を返し、Stripeの自動再送に委ねる。

## ローカル実行・テスト

```
npm install
npm test        # node --test（追加の依存パッケージ不要。stripe SDKのみ）
npm start       # ローカルでポート8080で起動（STRIPE_WEBHOOK_SECRET等の環境変数が必要）
```

## 環境変数

| 変数 | 必須 | 説明 |
| --- | --- | --- |
| `STRIPE_WEBHOOK_SECRET` | 必須 | Stripe DashboardのWebhook Endpointに対応する署名シークレット（`whsec_...`）。GASには一切渡さない |
| `GAS_WEBHOOK_RELAY_SECRET` | 必須 | GAS（Booking Adminプロジェクト）の`STRIPE_WEBHOOK_RELAY_SECRET`と同じ値 |
| `GAS_WEBHOOK_URL` | 必須 | Booking AdminプロジェクトのWebhook受信専用デプロイURL（管理者専用UIのデプロイとは別） |
| `STRIPE_API_KEY` | 任意 | 未設定でも署名検証は正しく動作する（ローカルHMAC演算のためAPIキー不要）。設定不要 |
| `PORT` | 任意 | 既定`8080`（Cloud Runの規約） |

## デプロイ（例。実行しない）

```
gcloud run deploy stripe-webhook-relay \
  --source . \
  --region asia-northeast1 \
  --no-allow-unauthenticated=false \
  --set-env-vars GAS_WEBHOOK_URL=https://script.google.com/macros/s/xxxxx/exec \
  --set-secrets STRIPE_WEBHOOK_SECRET=stripe-webhook-secret:latest,GAS_WEBHOOK_RELAY_SECRET=gas-webhook-relay-secret:latest
```

シークレットはCloud Runの環境変数へ直接埋め込まず、Secret Manager経由（`--set-secrets`）で
渡すこと。`--allow-unauthenticated`はStripeからの匿名POSTを受け付けるために必要だが
（IAM認証はStripe側でサポートされないため）、それだけを理由にGAS側を無認証にしない
（`GAS_WEBHOOK_RELAY_SECRET`によるアプリケーションレベルの認証は必須のまま）。
