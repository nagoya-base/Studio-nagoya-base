# SNB MEMBER Subscription作成失敗の修正と既存失敗分の復旧（Issue #528）

## 原因

`POST /v1/subscriptions` の `items[0][price_data]` に `product_data[name]` を渡していた。Stripeの
Subscription作成APIの `price_data` は `product`（既存のProduct ID）を要求し、`product_data` を受け付けない
（Checkout Sessionの `line_items[].price_data` とは仕様が異なる）。このため初回500円のCheckoutは成功する一方、
Subscription作成が `invalid_request_error`（`STRIPE_ERROR`）となり `MEMBERSHIP_SUBSCRIPTION_CREATE_FAILED` で
終了していた。

> 上記はStripe公式APIリファレンスとの照合に基づく原因特定。本番のリクエストログ
> （Developers > Logs の `POST /v1/subscriptions`、HTTP status・`error.code`・`error.param`）で
> 同じ指摘（`param` が `items[0][price_data][product_data]` 等）になっていることを、マージ後の確認で必ず突き合わせる。

## 修正内容

- `price_data` に `product` を渡す。Productの運用方針:
  - **本番は既存Product `prod_VVis8VOblDg2Pg` を使う**。Script Property `STRIPE_MEMBER_PRODUCT_ID` に設定する
    （設定時はそのProductを取得するのみで自動作成しない。存在しなければ要復旧として停止）。
  - 未設定の環境（テストモード等）は固定ID `snb_member_monthly` を取得し、無ければ作成する（`ensureMembershipProduct`）。
    テストモードと本番でProduct IDは異なるため、IDはコードに埋め込まない。
  - **本番反映前に `STRIPE_MEMBER_PRODUCT_ID=prod_VVis8VOblDg2Pg` を設定すること。** 未設定のまま反映すると
    別Product `snb_member_monthly` が本番に新設される。
- Subscription作成の前に、同じCustomerの `metadata.memberId` 一致・非キャンセルのSubscriptionをStripeで確認し、
  あれば作成せず台帳へ紐付ける（`findMembershipSubscription`）。**採用前に自動更新条件を検証**し
  （status が active/trialing、`orderType=membership`、cancel予約・一時停止なし、数量1・500円・JPY・毎月1回・
  上記Product、次回請求の期間終了が未来）、不一致なら新規作成も採用もせず `MEMBERSHIP_EXISTING_SUBSCRIPTION_INVALID`
  （要復旧・Recovery記録）で停止する。この場合はStripeで該当Subscriptionを修正または解約し、手順3で再処理する。台帳保存失敗後の再処理、手動作成済み、
  ペイロード変更後の冪等キー不一致でも二重作成しない。一覧を取得できない場合は作成せず再試行する。
- 冪等キーを `snb-membership-sub-v2-<Checkout Session ID>` に変更（旧キーは別パラメータで衝突し得るため）。
- 失敗時のGASログに `httpStatus` / `stripeErrorType` / `stripeErrorCode` / `stripeErrorParam` と、ID・URL・秘密鍵を
  伏せた `message` を記録（レスポンス全文は出さない）。
- 初回500円の支払済み事実（MemberMonths）と #490 の有効期間は一切変えない。再課金や資格取消は行わない。

## 既存の失敗済み入会の復旧手順

対象: StripeEvents シートで `outcomeCode = MEMBERSHIP_SUBSCRIPTION_CREATE_FAILED`（processingState=REJECTED）の
`checkout.session.completed` 行。**本修正のデプロイ後**に1件ずつ行う。

1. **照合（Stripe Dashboard）**
   - 該当Checkout Sessionの Payment Intent が `succeeded`・500円であること。
   - **返金済みか**: 全額返金済みなら復旧しない（自動更新を復活させない）。台帳の MemberRefunds にも
     `(checkout_session, <Session ID>)` があれば同様。
   - **既存Subscription**: Customerの Subscriptions に既に有効なものがあるか。ある場合は次の手順2へ（再作成しない）。
   - 応答不明の疑い（Stripe側に作成済みだが台帳に未紐付け）も、このSubscription一覧で判別できる。
2. **台帳照合（Members / MemberMonths）**
   - 会員行があり、入会月（プレスタートは10月・11月）の MemberMonths が各1件のみであること。
   - `stripeSubscriptionId` が空であること（入っていれば復旧不要）。
3. **再処理**
   - StripeEvents の該当行の `processingState` を `RECEIVED` に戻す（`rawBody` はそのまま）。次回のトリガー実行
     （または `processPendingStripeWebhookEvents` の手動実行）で再処理される。
   - 再処理は既存Subscriptionがあれば紐付けのみ、無ければ作成する。会員・MemberMonthsは冪等で、
     Checkoutの再作成・再課金は行わない。
   - `MEMBERSHIP_EXISTING_SUBSCRIPTION_INVALID` になった行は、メッセージの不一致項目（status / product / amount /
     interval / cancel_scheduled / paused / next_billing 等）をStripeで直してから再処理する。
   - 手動作成したSubscriptionを紐付けたい場合は `metadata[memberId]` に台帳の memberId を設定しておく。
4. **アンカー経過済み**: 入会月を過ぎ、アンカー（プレスタートは 2026-12-01 00:00 UTC）から60秒以内または
   経過後に再処理すると `MEMBERSHIP_JOIN_MONTH_ELAPSED` になりSubscriptionは作られない。この場合は
   運営が次の請求日を決めて手動でSubscriptionを作成する（初回分は請求しない。`proration_behavior=none`）。
   Stripeで作成後、手順3の紐付け（metadata設定→再処理）を行う。12/1までに全件の復旧を完了させること。

## マージ後の本番確認（テストモード→本番）

0. （未完了・マージ後に必須）本番Stripeログの `POST /v1/subscriptions` で、失敗時の `error.param` が
   `product_data` 起因であることの照合。CIとモックのテストだけでは本番不具合の解消とは判断しない。
1. テストモードで入会し、Subscriptionが1件作成され、`billing_cycle_anchor` が 2026-12-01 00:00 UTC、
   月額500円、`metadata.memberId` が付いていること。
2. Members の `stripeSubscriptionId` / 状態 / 期間が正しく紐付いていること。
3. Test Clock で12/1まで進め、更新invoice（500円）の成功で12月が有効、失敗で `past_due`・12月が無効になること。
4. 本番反映後、実入会1件で「初回500円決済」だけでなく「Subscription作成・台帳紐付け・次回請求日（12/1）」まで確認する。
5. 反映は既存運用どおり main から Booking GAS target を更新する（PRブランチからのデプロイ・Deployment作り直し・
   `STRIPE_CHECKOUT_ENABLED` の変更はしない）。
