# SwitchBot 期間限定パスコード検証 手順書（Issue #713）

技術検証専用。予約・決済・既存本番コード・通常パスコードは変更しない。
実装: `gas/switchbot-verify/`（独立 GAS プロジェクト。既存の本番反映ワークフローの対象外）。

## 商用利用ゲート
SwitchBot Open API は公式に personal uses 向け。**予約連携・メール自動掲載・本番常用は、SwitchBot へ商用利用可否を確認する別判断を通過するまで実施しない。** 本検証の完了条件は「実機で技術的に発行・失効できる」まで。

## 準備
1. SwitchBot アプリ → プロフィール → 設定 → 開発者向けオプションから Token / Secret を取得。
2. 新規の**独立** GAS プロジェクトを作り、`gas/switchbot-verify/` の `.gs` と `appsscript.json` を貼る（初回のみ手動。以後の自動反映は [switchbot-verify-gas-deploy-723.md](switchbot-verify-gas-deploy-723.md) を参照）。
3. Script Properties に設定（ソース・Issue・ログに書かない）:
   - `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET`
   - `WEBHOOK_SHARED_TOKEN`（推測困難なランダム値）
4. Web アプリとしてデプロイし `/exec` URL を得る。

## 接続確認の手順（Issue #715・方針変更: GitHub Actions 手動実行）
独立GASは作らず、`.github/workflows/switchbot-verify-devices.yml`（`workflow_dispatch` のみ・自動実行なし）で `GET /v1.1/devices` だけを実行する。
1. Repository Secrets に `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` を登録（値はIssue・PR・チャットに貼らない）。
2. Actions → "SwitchBot devices check (manual)" → Run workflow。
3. ログで Keypad / Keypad Touch が1件以上、deviceId が末尾4桁のみであることを確認し、アプリの対象デバイスと照合。
`createKey` / `deleteKey` / Webhook登録 / 実機解錠は行わない。以下の GAS 手順は本番実行基盤を別途設計するまでの参考。

## 完全 deviceId の登録と登録後確認（Issue #720）
完全IDを表示・コピーせず、Environment `switchbot-verify` の Secret `SWITCHBOT_DEVICE_ID` へ直接登録する。実行は運用者のローカル端末（`gh` ログイン済みで当該 Environment の secrets 書き込み権限あり）。Actions の `GITHUB_TOKEN` では Secret を書けないため登録は Actions では行わない。

1. 登録（`scripts/switchbot-register-device-id.js`）:
   - `read -rs SWITCHBOT_TOKEN; read -rs SWITCHBOT_SECRET` で入力し（引数・ソース・ファイルに書かない）、`KEYPAD_LAST4=<アプリ等で確認した末尾4桁>` を設定したうえで、`export SWITCHBOT_TOKEN SWITCHBOT_SECRET KEYPAD_LAST4` で子プロセスへ渡す。
   - `node scripts/switchbot-register-device-id.js` … `GET /v1.1/devices` を呼び、Keypad / Keypad Touch の末尾4桁一致が**ちょうど1件**のときだけ `gh secret set SWITCHBOT_DEVICE_ID --env switchbot-verify` の標準入力へ渡す。0件・複数件・API失敗・応答不正・登録失敗では書き込まず終了コード1（gh の出力も破棄し、完全IDは一切表示しない）。
2. 登録後確認: Actions → "SwitchBot device ID check (manual)"（`switchbot-verify-device-id.yml`）に末尾4桁を入力して実行。Environment `switchbot-verify` の `SWITCHBOT_DEVICE_ID` を読み、deviceList 上の**完全ID一致1件**・Keypad種別・末尾4桁一致を確認する（`GET /v1.1/devices` のみ）。Secret未設定・不一致・0件/複数件・応答不正は失敗。
3. Issue には実施日時・保存先の種類と名前・登録成否・照合件数・末尾4桁・確認 run URL のみ記録する。

GAS 経路（`verifySelectKeypad(last4)`）で Script Properties に保存しても GitHub Environment Secret の登録にはならず、登録値を使う読み取り専用 workflow も未整備のため、本Issueの完了条件には使わない。

## テストキー1件の発行→削除（Issue #718・手動 Actions）
`.github/workflows/switchbot-verify-key.yml`（`workflow_dispatch` のみ）+ `scripts/switchbot-verify-key.js`。商用利用ゲートは維持（技術検証のみ。予約連携・メール掲載・本番常用は別判断）。

### 構成
- **リレー**: 独立 GAS Web アプリ（`gas/switchbot-verify/`）。SwitchBot Webhook（クエリ `t`=`WEBHOOK_SHARED_TOKEN`）の受信と、Actions からの管理 op（本文 `t`=`RELAY_ADMIN_TOKEN`）を処理。テストコード・passcode ID・Webhook 結果はリレーの Script Properties にのみ保持し、Actions のログ・成果物・キャッシュには出さない。Webhook 結果は24時間で自動削除、`clear` で即時破棄。
- **Environment `switchbot-verify`**（必須レビュアー設定を推奨）の Secrets: `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` / `SWITCHBOT_DEVICE_ID`（#715で特定した完全ID）/ `VERIFY_RELAY_URL`（GAS `/exec`）/ `VERIFY_RELAY_ADMIN_TOKEN`（= GAS の `RELAY_ADMIN_TOKEN`）/ `VERIFY_WEBHOOK_TOKEN`（= GAS の `WEBHOOK_SHARED_TOKEN`）。二つのトークンは別の推測困難な値にする。
- コードは実行 run が生成する。現地入力者へは GAS の Script Properties `TEST_STATE`（`password`）を見て、ログ以外の別経路で渡す。

### 実施順（営業時間外・現地確認者と代替入室手段を確保）
| # | action（確認文字列） | 内容 |
|---|------|------|
| 0 | `webhook-query`（`QUERY-WEBHOOK`） | **照会専用**。`queryWebhook(queryUrl)` だけを呼び、既存Webhook設定の状態を確認（下記）。登録・更新・削除はしない |
| 1 | `webhook-setup`（`SETUP-WEBHOOK`） | 既存Webhook設定がある場合は上書きせず中断。無ければ今回分を登録 |
| 2 | `create-key`（`CREATE-ONE-TEST-KEY`） | 開始 3〜30 分後・有効 10〜15 分で1件。claim で重複防止、今回の commandId+createKey の Webhook success で APPLIED、keyList から passcode ID を解決。結果不明は再送せず UNKNOWN 停止 |
| 3 | 実機 | 開始前=不可 / 有効中=解錠 / 終了後=不可 |
| 4 | `delete-key`（`DELETE-TEST-KEY`） | 今回のキーのみ削除。deleteKey の Webhook success と keyList からの消失（対象デバイスが1件で keyList が配列の完全な応答に限る）を確認後に保持データを破棄。送信した deleteKey の commandId を保存するため、通信断などで中断しても次の `delete-key` が再削除せず確認だけを再開する（Webhook結果の保持は24時間） |
| 5 | 実機 | 削除後も同じコードで解錠不可 |
| 6 | `webhook-remove`（`REMOVE-WEBHOOK`） | 今回登録した Webhook だけ撤去（既存設定は触らない）。GAS の `verifyCleanupLocal()` も実行 |

### 既存Webhook設定の照会（`webhook-query`）
`webhook-setup` が `statusCode 190` で FAILED になった等、登録の可否を判断する前に使う。HTTP 200 と API の `statusCode` は別で、190 だけから「既存登録あり」「認証正常」と断定しない。`webhook-setup` は未登録なら登録へ進むため、原因調査では実行しない。
- 呼ぶのは `POST /v1.1/webhook/queryWebhook`（`{"action":"queryUrl"}`）のみ。setup / update / delete・createKey / deleteKey は呼ばない。
- HTTP 200 かつ `statusCode 100` で `body.urls` が文字列の配列のときだけ判定する。欠落・非配列・API失敗・通信失敗は **UNKNOWN**（「登録なし」と見なさない）。
- 予定URL（`VERIFY_RELAY_URL` + 共有トークン）との完全一致比較は実行環境内で行い、ログに出すのは状態・件数・HTTP/API状態のみ（URL・トークン・生レスポンス・message・例外詳細は出さない）。必要な秘密は `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` / `VERIFY_RELAY_URL` / `VERIFY_WEBHOOK_TOKEN` のみ。

| 状態 | 意味 | 終了コード | 次の判断 |
|------|------|-----------|----------|
| `NONE` | 未登録（件数0） | 0 | `webhook-setup` で登録可 |
| `MATCH` | 予定URLと完全一致 | 0 | 再登録不要。到達性・キー反映成功の証拠にはならない |
| `MISMATCH` | 別URLのみ登録あり | 1 | 上書き・削除しない。既存設定の扱いを人が判断 |
| `UNKNOWN` | 応答不正・API失敗・通信失敗 | 1 | 断定せず停止。原因を別途切り分け |

#### 追加診断（Issue #725。`MISMATCH` の原因切り分け）
`queryWebhook` の結果が厳密に **1件** で、判定が `MATCH`/`MISMATCH` の場合だけ、実行環境内で URL を解析して固定分類名のみを `webhook-query 追加診断:` として出力する。URL・ベースURLの実値・クエリ・トークン・生レスポンス・message・解析エラー詳細は出さない（GitHub のマスクに依存せず固定文字列のみ）。

| 追加診断 | 意味 |
|----------|------|
| `BASE_URL_MATCH + TOKEN_MATCH` | scheme/host/path が一致し、`t` が1つで共有トークンと一致 |
| `BASE_URL_MATCH + TOKEN_MISMATCH` | ベースURLは一致、`t` はあるが値が違う（**空の `t` もここ**。欠落とは区別） |
| `BASE_URL_MATCH + TOKEN_MISSING` | ベースURLは一致、`t` パラメータがない |
| `BASE_URL_MISMATCH` | scheme / host(ポート含む) / path のいずれかが違う（末尾スラッシュ差も別物として扱う。クエリは比較に含めない） |
| `UNKNOWN` | 0件・複数件・応答不正・API/通信失敗・URL解析不能・`t` 重複・ユーザー情報付きURL等、安全に判定できない（推測しない） |

- 部分診断であり、完全一致の `MATCH`/`MISMATCH` と終了コードは変わらない。`TOKEN_MATCH` だけで成功扱いにしない（例: 余分なクエリがあれば `MISMATCH` のまま終了コード1）。0件の `NONE` は従来どおりで、追加診断成功とは扱わない。
- **照会専用**。診断結果から setup / update / delete 等の変更APIへは進まない。**MISMATCH の原因が特定できるまで既存Webhookを削除・上書きしない**。原因特定後の設定変更は本診断の対象外で、別途人が判断する。
- 診断が一致を示しても、Webhook の到達性・受信先の稼働・キー反映成功の証明にはならない。

### 旧Webhookの置換（`remove-old` → `setup-current`。Issue #727）
`webhook-query` が `MISMATCH 件数=1`（`BASE_URL_MISMATCH` 等）で、その1件が**今回の検証用Webhookだと人手で確認できた場合に限り**、旧Webhookを削除して現在のURLへ置き換える。ベースURL不一致・件数1・確認文字列の入力だけでは対象確認済みにならず、用途・管理主体を確認できなければ削除しない。`webhook-remove`（現在の期待URLの撤去）は旧URLの削除には使わない。

#### 人手による対象確認（実行前に必須。URLは公開しない）
1. 管理者が非公開環境で、管理下の検証用GASデプロイ情報（`/exec` URL）・過去の設定記録と照合し、旧Webhook URL（共有トークン付き完全URL）を特定する。Issue・PR・チャットにURLを書かない。
2. 旧URLを Environment secret `VERIFY_OLD_WEBHOOK_URL` に登録する。実行時、`queryWebhook` の既存1件と**完全一致**した場合だけ対象とみなす（推測しない）。
3. 結び付けの証跡（秘密を含まない）を作り、Environment secret `VERIFY_OLD_WEBHOOK_EVIDENCE` に登録する。形式は `<旧URLのSHA-256先頭12桁>@<確認時刻 UTC>`。
   ```bash
   printf %s "$OLD_URL" | sha256sum | cut -c1-12   # 例: 0123456789ab → 0123456789ab@2026-11-02T12:00:00Z
   ```
   実行時、旧URLの値と一致し、確認から24時間以内（未来でない）の証跡だけを有効とする。欠落・不一致・古い・形式不正は変更APIを呼ばず停止する。
4. 実施後、両Secretを削除する（旧URLは共有トークンを含むため残さない）。

#### 実行（いずれも `workflow_dispatch`・初回runのみ。URL・トークンはdispatch入力にしない）
| 順 | action（確認文字列） | 内容 |
|----|------|------|
| 1 | `remove-old`（`REMOVE-OLD-WEBHOOK`） | 証跡検証 → 進行記録なしを確認 → `queryWebhook`（厳密に1件・旧URLと完全一致）→ 削除直前に再照会 → 進行記録`DELETE_SENT`を保存 → `deleteWebhook`を**1回だけ** → `queryWebhook`で**0件**を確認して成功。`setupWebhook`は呼ばない |
| 2 | `setup-current`（`SETUP-CURRENT-WEBHOOK`） | 進行記録`REMOVED`（24時間以内）を確認 → 登録直前の`queryWebhook`で**0件** → 進行記録`SETUP_SENT`を保存 → `VERIFY_RELAY_URL`+エンコード済み`VERIFY_WEBHOOK_TOKEN`のURLで`setupWebhook`を**1回だけ** → `queryWebhook`で**厳密に1件かつ完全一致（`MATCH`）**を確認して完了。`deleteWebhook`は呼ばない |

- **段階の引き継ぎ**: 進行記録はリレー（GAS）の Script Properties `WEBHOOK_MIG`（`phase`/旧URLのSHA-256先頭12桁/時刻のみ。URL・トークンは保持しない）。遷移は `なし→DELETE_SENT→REMOVED→SETUP_SENT→DONE` の一方向で、巻き戻し・消去の操作は用意しない。`webhook-query`（`MATCH`）の再確認が最終確認。
- **再実行・同時実行**: 変更APIは送信**前**に進行記録を保存する。別runや「Re-run jobs」（`run_attempt>1`）、完了後の再実行は変更APIを送らず停止する。同一workflowの`concurrency`で競合runは直列化される。
- **停止の扱い**: 0件/複数件/対象不一致/証跡不備/秘密未設定/HTTP・API失敗/通信断/タイムアウト/応答不正/UNKNOWNはすべて停止（終了コード1）。送信後は再送・自動継続・ロールバック（旧URLへの戻し・再削除）をしない。通信ライブラリの自動リトライは使わず、送信済みか不明な状態もUNKNOWNとして停止する。
- **復旧**: `webhook-query`による照会と人手確認のみ。`WEBHOOK_MIG` が `DELETE_SENT`/`SETUP_SENT` のまま残った場合、元runの再送では復旧しない。管理者が照会結果を確認し、新たな判断のうえで `WEBHOOK_MIG` を手動で扱う（変更操作の再開には新たな状態照合と明示判断が必要）。
- **出力**: 固定の状態・件数・HTTP/APIコードのみ。旧/新URL・ベースURL・クエリ・共有トークン・生レスポンス・`message`・認証情報はログ/Step Summary/成果物に出さない（GitHubのマスクに依存しない）。
- **証跡の記録**: 公開してよいのは、各段階の固定状態・件数・実施時刻・run URL・秘密を含まない確認記録のみ。`MATCH`は設定一致のみの証明で、Webhook到達性やcreateKey/deleteKeyの反映成功は別途確認する。実装・CIの成功と、実際の置換・最終照会の確認は区別して記録する。
- **GAS更新**: リレーに進行記録のop（`migGet`等）を追加している。実行前に #723 の自動デプロイでリレーを更新済みにすること（未反映だと`remove-old`は進行記録を確認できず、変更APIを呼ばず停止する）。

### 例外: 初回接続・既存1件の簡略置換（`replace-single-webhook-remove` → `setup-current`。Issue #729）
旧完全URLを復元できないが、管理者が次を**明示確認できる場合に限る**例外運用。確認できなければ使わず、現行の厳格な `remove-old` を使う（旧完全URLを把握できる場合も `remove-old` を優先）。

> このSwitchBotアカウントでWebhookを他用途に使ったことはなく、現在の既存1件は今回の検証作業で作成されたものとして扱ってよい。

- 専用action `replace-single-webhook-remove`、確認文字列 `I-CONFIRM-SINGLE-WEBHOOK-IS-MINE`（入力するだけで上記確認の宣言になる）。`VERIFY_OLD_WEBHOOK_URL` / `VERIFY_OLD_WEBHOOK_EVIDENCE` は不要。`workflow_dispatch` 初回runのみ（Re-runは変更APIを送らない）。
- 流れ: 進行記録なしを確認 → `queryWebhook`で**厳密に1件**（0件/複数件/UNKNOWN/現在URLと一致は停止）→ 削除直前に再照会（同じ1件）→ 進行記録`DELETE_SENT`を保存 → 実行環境内で得た**その1件のみ**を`deleteWebhook`（**最大1回**・自動リトライなし）→ `queryWebhook`で**0件**確認して成功。`setupWebhook`は呼ばない。
- 登録は既存の `setup-current`（`REMOVED`記録が前提。0件確認後に`setupWebhook`1回→厳密1件`MATCH`確認）。`MISMATCH`/`UNKNOWN`/通信断では再送・自動ロールバックしない。
- 出力は固定状態・件数・HTTP/APIコードのみ（既存/新URL・トークン・生レスポンスは出さない）。現行 `remove-old` / `setup-current` の挙動は変更していない。

### 復旧: deleteWebhook送信後に照会不能となった場合（`recover-delete-sent`。Issue #731）
`replace-single-webhook-remove` が `deleteWebhook` 送信後に停止し、進行記録が `DELETE_SENT` のまま `queryWebhook` が `statusCode=190` 等で不明になった場合の専用復旧。**変更API（`deleteWebhook` / `setupWebhook` / `updateWebhook` / `createKey` / `deleteKey`）は一切呼ばない**。元runのRe-runや `deleteWebhook` の再送では復旧しない。

- action `recover-delete-sent`、確認文字列 `RECOVER-DELETE-SENT-IF-ZERO`。`workflow_dispatch` 初回runのみ（Re-runは何もせず停止）。必要なSecretsは `setup-current` と同じ。
- 流れ: リレーの `WEBHOOK_MIG` を `migGet` で読み、phase が**厳密に `DELETE_SENT`** であることを確認（`NONE` / `REMOVED` / `SETUP_SENT` / `DONE` / 不正形式は停止）→ `queryWebhook(queryUrl)` のみで現状を照合。
- 判定:

  | 照会結果 | 分類 | 動作 |
  | --- | --- | --- |
  | HTTP 200 かつ `statusCode=100` で `urls` が文字列配列、**厳密に0件** | `DELETED_CONFIRMED` | `migMarkRemoved`（`DELETE_SENT→REMOVED` のみ）。次は**別run**で `setup-current` |
  | 1件以上 | `STILL_PRESENT` | 状態変更なし。自動再削除しない（件数のみ表示。人手判断へ） |
  | `statusCode=190` / HTTP失敗 / 通信断 / 応答不正 | `UNKNOWN` | 状態変更なし。何も推測しない |

- 出力は固定分類・件数・理由コードのみ（URL・fp・トークン・生レスポンス・`message`・例外詳細は出さない）。新たな秘密は保存しない。リレー側に新opは追加せず、既存の `migGet` / `migMarkRemoved`（`DELETE_SENT→REMOVED` 以外を拒否）のみ使う。

#### `statusCode=190` の扱い
- `queryWebhook` が190を返した事実から「削除済み」「未登録」「残存」のいずれも**推測しない**。HTTP 200 とAPIの `statusCode` は別で、190は照会そのものが成立しなかったことしか示さない。
- 本リポジトリの実装・実測で確認できているのは、`webhook-setup` / `deleteWebhook` / `queryWebhook` の失敗応答として190が返り得ること、および #731 の2回連続の190事象のみ。190が返る条件の網羅的な公式仕様はここでは断定しない（SwitchBot公式APIドキュメントのstatusCode表を各自確認し、結果を秘密抜きでIssueに記録する）。
- 190が続く間は `UNKNOWN` のまま `recover-delete-sent` が状態を変えないため、時間を置いて読み取り専用の `webhook-query` / `recover-delete-sent` を別runで再実行する。それでも解消しない場合は、SwitchBotアプリ側の表示等、API以外の手段で人手確認する（確認できるまで `setup-current` は実行しない）。

JST = UTC+9。ログの有効期間は JST（HH:mm:ss）で表示される。UNKNOWN・削除未確認が残る場合は、アプリの keyList で今回の検証名（`SNB-API-TEST-<unix秒>`）のキーだけを特定して削除し、「API検証は未達」と分けて Issue に記録する。秘密が漏れた場合は Token/Secret を再発行し、該当テストキーを削除する。

### （参考・旧方針）独立GASでの手順
範囲は「独立GAS作成 → Token/Secret設定 → 接続確認 → 対象Keypad特定」まで。`createKey` / Webhook本登録 / 実機解錠 / `deleteKey` は行わない。自動トリガーは作らない。
1. 上記「準備」1〜3（`SWITCHBOT_DEVICE_ID` はまだ未設定でよい）。Web アプリのデプロイは不要。
2. `verifyCheckSetup()` … Token / Secret / 共有トークンが `SET` か確認（値は出ない）。初回は権限承認。
3. `verifyListDevices()` … 認証成功とKeypad件数1以上、ログのIDが末尾4桁のみであること。
4. SwitchBotアプリの対象デバイス末尾4桁と照合し、`verifySelectKeypad('<末尾4桁>')` を実行。完全な deviceId が `SWITCHBOT_DEVICE_ID` に保存される（0件/複数件一致は保存せず中断）。
5. `verifyCheckSetup()` で `SWITCHBOT_DEVICE_ID` が `SET` になったことを確認。
完全な deviceId・Token・Secret は Issue / PR / チャット / ログに貼らない。結果は「成功/失敗」と末尾4桁のみ Issue #715 に記録する。

## 手順（エディタから手動実行）
| # | 関数 | 確認すること |
|---|------|--------------|
| 1 | `verifyListDevices()` | 認証成功・キーパッド特定。下4桁で照合し `SWITCHBOT_DEVICE_ID` を設定 |
| 2 | `verifySetupWebhook('<exec URL>')` | Webhook 登録（共有トークンはクエリ `t`） |
| 3 | `verifyAbnormalCases()` | 不正認証・不正 deviceId・start>=end が成功扱いにならない |
| 4 | `verifyCreateTimeLimitKey(5, 15)` | 5分後開始・15分有効のコードを1件作成。`commandId` 記録、Webhook で `APPLIED`、続けて `keyList` から passcode ID を解決（`idResolveState` が `APPLIED`） |
| 5 | 実機 | 開始前=不可 / 有効中=解錠 / 終了後=不可（営業時間外・既存利用者に影響しない時間帯） |
| 6 | `verifyDeleteKey()` | 解決済み ID で削除→Webhook `APPLIED`→削除後に解錠不可 |
| 7 | `verifyCleanupLocal()` | テストコード等のローカル保存を削除 |

重複 name は、作成済みテスト名で再度 `createKey` し Webhook が `failed` になることを手動確認する。

## 結果状態の扱い
| 状態 | 意味 |
|------|------|
| `ACCEPTED_PENDING` | API が受理しただけ。**鍵への反映成功とは扱わない** |
| `APPLIED` | Webhook `result=success` を確認 |
| `FAILED` | API 拒否 / Webhook `result=failed` |
| `UNKNOWN` | Webhook 未着 or `timeout`（反映有無を断定しない。実機で確認） |

## passcode ID の取得
公式 Webhook ペイロードには passcode ID が含まれない（`eventName` / `commandId` / `result` / `timeOfSample` のみ）。そのため、`createKey` が Webhook で `APPLIED` になった後に `/v1.1/devices` を再取得し、対象デバイスの `keyList` から今回の一意な `TEST_NAME`（`SNB-API-TEST-<unix秒>`）と一致するエントリの `id` を `TEST_PASSCODE_ID` に保存する（通常経路）。
- 一致が 0 件・複数件、対象デバイス無し、`id` 欠落の場合は ID を保存せず `UNKNOWN`（成功扱いにしない）。再試行は `verifyResolvePasscodeId()`。
- `verifyDeleteKey()` は保存済み ID を使って削除まで完結する。未保存なら実行前に `keyList` から解決を試み、解決できなければ削除せず `UNKNOWN` で中断する。
- フォールバック（調査用）: `keyList` から ID を取得できなかった場合のみ、アプリ等で確認した ID を `verifyDeleteKey(<id>)` に渡す。この場合は「APIでID取得不能」を検証結果として Issue に記録する。

検証結果は Issue へ秘密情報を伏せて記録する（deviceId は下4桁、テストコード・Token・Secret・passcode ID は記載しない）。

## セキュリティ
- Token/Secret/テストコードはコード・ログに出さない。ログ出力は `redact()` 経由（token/secret/sign/password は `[REDACTED]`、ID は下4桁）。API 応答は丸ごと出力しない。
- Webhook は GAS がヘッダを読めないため共有トークン（クエリ）で簡易認証。ペイロード全体は保存せず `commandId` 単位の結果のみ保存。
- テスト: `node --test test/switchbot-verify-core.test.js`（実 API には接続しない）。
