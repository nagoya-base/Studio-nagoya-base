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

## 接続確認の手順（Issue #715）
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
