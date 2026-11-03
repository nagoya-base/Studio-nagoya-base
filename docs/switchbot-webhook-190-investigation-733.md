# Issue #733 調査: deleteWebhook 後に queryWebhook が statusCode=190 になる件

調査日: 2026-11-02 / 方針: コード変更・Webhook変更APIの送信は行わず、公式仕様・既知事例・現行実装を照合した。

## 前提の時系列（Issue #733 記載の事実）

1. `GET /v1.1/devices` 成功、Keypad 一意照合成功。
2. 削除前の `queryWebhook(queryUrl)`: HTTP 200 / statusCode=100 / 1件。
3. `deleteWebhook` を1回送信: HTTP 200（受理応答）。
4. 削除直後から `queryWebhook`: HTTP 200 / statusCode=190 が継続。`recover-delete-sent` も 190 → UNKNOWN で安全停止。

## 1. 公式仕様との照合（`OpenWonderLabs/SwitchBotAPI` README）

| 項目 | 公式 | 現行実装 | 判定 |
|---|---|---|---|
| 署名 | `base64(HMAC-SHA256(secret, token + t + nonce))` を大文字化。ヘッダ `Authorization` / `sign` / `t` / `nonce` | `SwitchBotVerifyCore.gs` `buildAuthHeaders`、`switchbot-verify-key.js` `hmac`（sha256→base64→`toUpperCase`）。t は13桁ms、nonce は `crypto.randomUUID()` | 概ね一致（大文字化のみ公式内で不統一。下記） |
| Content-Type | `application/json; charset=utf8` | 同左 | 一致 |
| queryWebhook | `POST /v1.1/webhook/queryWebhook`、body `{"action":"queryUrl"}` | 同左（`{ action: 'queryUrl' }` のみ） | 一致 |
| deleteWebhook | `POST /v1.1/webhook/deleteWebhook`、body `{"action":"deleteWebhook","url":...}` | 同左 | 一致 |
| 成功時 | `statusCode:100`、queryUrl は `body.urls` 配列 | `evaluateWebhookQuery` が 200+100+文字列配列のみ判定 | 一致 |
| statusCode=190 | 公式表では「System error / Device internal error due to device states not synchronized with server」。**Webhook API 固有の 190 の意味は公式に記載なし** | 190 は `UNKNOWN`（API_FAILED）として扱い、未登録・削除成功とは見なさない | 妥当 |

**公式内の不統一（大文字化）**: README の手順文・Go/PHP サンプルは「大文字化」を指示するが、JavaScript / Python / C# サンプルは base64 をそのまま（大文字化なし）送っている。Base64 は大文字小文字を区別するため、両者は同値ではない。現行実装は手順文に従い大文字化している。ただし同一方式で `GET /v1.1/devices` と削除前の `queryWebhook` が成功しており、サーバ側が大文字化版を受理していることは実績として確認済み。よって認証不備の原因とは考えにくいが、「公式サンプルと完全一致」とは言えず、公式側の記載の揺れとして記録する。

補足: 公式 README の署名手順文は「token + t」とだけ書かれ nonce が抜けているが、同 README の全サンプルコードは `token + t + nonce` で署名しており、実装はサンプルに一致する。かつ `GET /v1.1/devices` と削除前の `queryWebhook` が同一署名で成功しているため、署名不備は原因として成立しない。

## 2. 現行実装の確認結果

- `queryWebhook` は `{action:'queryUrl'}` のみ送信。method / path / API version / 末尾スラッシュにずれなし（`switchbot-verify-key.js` の全呼び出し箇所を確認）。
- 190 を「未登録」「削除成功」と誤解する経路なし。`NONE`（0件）になるのは HTTP200 + statusCode100 + `urls=[]` のときだけ。
- 結論: **ユーザー側実装の誤りを示す差異は見つからなかった。修正案なし。**（大文字化の揺れは公式側の記載差で、実績上は受理されている）

## 3. 既知事例（公式 GitHub Issues。URL・秘密値は記載しない）

- **#393 Webhook Setup fails with 190**（open / 回答なし）
  - 初回登録でも `setupWebhook` が 190 + `"webhook is exist"`、`queryWebhook` / `deleteWebhook` も 190（message 空）。他APIは正常。
  - SwitchBot 担当者は「再現できない」と返信のみで、原因・修正の説明なし。同症状の追加報告あり（Webhookの設定・削除不能）。
  - 2026年2月に「v1.1 では delete/update ができないが **V1 では成功した**」とのユーザー報告（非公式の回避策。公式見解ではない）。
- **#502**（open）: 登録・query は成功するのに実イベントが届かない別症状。190 の言及なし。
- 本件と完全に同じ「削除前 query=100 → 削除後 query=190」の報告は確認できなかった。ただし「Webhook API だけ 190 を返し、他APIは正常」という点は #393 と一致する。

注: Issue 本文・コメントの内容は WebFetch による要約で確認した。引用は要点のみで、原文との照合は未実施。

## 4. 切り分け結果

- **ユーザー側実装の誤り**: 可能性は低い（仕様一致、同一署名で他API・削除前queryが成功）。
- **SwitchBot側の状態不整合の疑い**: あり（#393 と同型）。ただし公式が 190 の意味を定義していないため **断定はしない**。旧Webhookが削除済みか残存かは現時点で不明のまま。
- `WEBHOOK_MIG` は `DELETE_SENT` を維持する。`REMOVED` への遷移は、`queryWebhook` が statusCode=100 かつ 0件で確認できた場合のみ（#731/#732 の `recover-delete-sent`）。

## 5. 安全に確認できる診断手段

- 読み取り専用の `webhook-query`（`queryUrl`）のみ。時間を置いて（例: 数時間〜翌日）1回ずつ実行し、HTTP / statusCode / 件数の固定分類だけを記録する。
- 100 に戻った場合のみ `recover-delete-sent` を1回実行する。190 の間は連打しない。
- SwitchBot アプリ側（Webhook設定画面等）に確認できる画面があるかは公式資料に記載がなく、本調査では未確認。
- `queryDetails` は公式 README に記載のある読み取り系操作（リクエスト/レスポンス例あり）で、診断候補になり得る。ただし本リポジトリでは未実装・未検証のため、本 Issue では実行しない（必要なら別 Issue で実装方針を決める）。
- V1 エンドポイントでの確認は、公式に記載がなく #393 の非公式報告に基づくのみで未検証のため、実行しない。

## 6. SwitchBot 問い合わせ用の再現手順（秘密なし）

1. 同一 Token/Secret で `GET /v1.1/devices` が HTTP200 / statusCode=100。
2. `POST /v1.1/webhook/queryWebhook` `{"action":"queryUrl"}` → HTTP200 / statusCode=100 / urls 1件。
3. `POST /v1.1/webhook/deleteWebhook` `{"action":"deleteWebhook","url":"<登録済みURL>"}` を1回 → HTTP200（受理）。
4. 直後から `queryWebhook` が継続して HTTP200 / statusCode=190。数時間後も同じ。
5. 依頼内容: 当該アカウントの Webhook 登録状態の確認、および 190 の意味（公式表の Device 系定義が Webhook API に適用されるのか）の回答。
6. 添付しないもの: Token、Secret、署名、Webhook URL、完全な deviceId、生レスポンス全文。

## 禁止事項の維持

`deleteWebhook` 再送、`setupWebhook` / `updateWebhook` の実行、`replace-single-webhook-remove` / `remove-old` / `setup-current` / `webhook-setup` / `webhook-remove` の実行は、原因確定まで行わない。

## 追記（Issue #739）: queryDetails 診断Action

- 公式 README（2026-11-03 再確認）: `POST /v1.1/webhook/queryWebhook`、body `{"action":"queryDetails","urls":["<Webhook URL>"]}`。応答は `statusCode:100` かつ `body` が配列（url / createTime / lastUpdateTime / deviceList / enable）。パラメータ表は `url`、例は `urls` と記載が揺れるため、例に合わせ `urls` 配列で送る。
- queryDetails は照会対象 URL の指定が必須。このため `SWITCHBOT_DEVICE_ID` は不要だが、`VERIFY_RELAY_URL` + `VERIFY_WEBHOOK_TOKEN`（target=current）または `VERIFY_OLD_WEBHOOK_URL`（target=old）が必要。URL は出力しない。
- 手動Action: `.github/workflows/switchbot-verify-webhook-details.yml` / `scripts/switchbot-verify-webhook-details.js`。1回のみ送信・再送なし・変更API なし。
- 読み分け: statusCode=100 → queryUrl だけが 190 の可能性 / 190 → Webhook 読み取り系全体の不整合の疑い / その他 → 追加調査（フォールバック・変更操作へは進まない）。
