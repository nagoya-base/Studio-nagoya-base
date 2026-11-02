# SwitchBot 期間限定パスコード検証 手順書（Issue #713）

技術検証専用。予約・決済・既存本番コード・通常パスコードは変更しない。
実装: `gas/switchbot-verify/`（独立 GAS プロジェクト。既存の本番反映ワークフローの対象外）。

## 商用利用ゲート
SwitchBot Open API は公式に personal uses 向け。**予約連携・メール自動掲載・本番常用は、SwitchBot へ商用利用可否を確認する別判断を通過するまで実施しない。** 本検証の完了条件は「実機で技術的に発行・失効できる」まで。

## 準備
1. SwitchBot アプリ → プロフィール → 設定 → 開発者向けオプションから Token / Secret を取得。
2. 新規の**独立** GAS プロジェクトを作り、`gas/switchbot-verify/` の `.gs` と `appsscript.json` を貼る（clasp 自動デプロイはしない）。
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
   - `read -rs SWITCHBOT_TOKEN SWITCHBOT_SECRET` 等で環境変数に入れる（引数・ソース・ファイルに書かない）。`KEYPAD_LAST4` にアプリ等で確認した末尾4桁を指定。
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
| 1 | `webhook-setup`（`SETUP-WEBHOOK`） | 既存Webhook設定がある場合は上書きせず中断。無ければ今回分を登録 |
| 2 | `create-key`（`CREATE-ONE-TEST-KEY`） | 開始 3〜30 分後・有効 10〜15 分で1件。claim で重複防止、今回の commandId+createKey の Webhook success で APPLIED、keyList から passcode ID を解決。結果不明は再送せず UNKNOWN 停止 |
| 3 | 実機 | 開始前=不可 / 有効中=解錠 / 終了後=不可 |
| 4 | `delete-key`（`DELETE-TEST-KEY`） | 今回のキーのみ削除。deleteKey の Webhook success と keyList からの消失（対象デバイスが1件で keyList が配列の完全な応答に限る）を確認後に保持データを破棄。送信した deleteKey の commandId を保存するため、通信断などで中断しても次の `delete-key` が再削除せず確認だけを再開する（Webhook結果の保持は24時間） |
| 5 | 実機 | 削除後も同じコードで解錠不可 |
| 6 | `webhook-remove`（`REMOVE-WEBHOOK`） | 今回登録した Webhook だけ撤去（既存設定は触らない）。GAS の `verifyCleanupLocal()` も実行 |

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
