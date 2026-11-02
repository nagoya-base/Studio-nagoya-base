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

## 手順（エディタから手動実行）
| # | 関数 | 確認すること |
|---|------|--------------|
| 1 | `verifyListDevices()` | 認証成功・キーパッド特定。下4桁で照合し `SWITCHBOT_DEVICE_ID` を設定 |
| 2 | `verifySetupWebhook('<exec URL>')` | Webhook 登録（共有トークンはクエリ `t`） |
| 3 | `verifyAbnormalCases()` | 不正認証・不正 deviceId・start>=end が成功扱いにならない |
| 4 | `verifyCreateTimeLimitKey(5, 15)` | 5分後開始・15分有効のコードを1件作成。`commandId` 記録、Webhook で `APPLIED` |
| 5 | 実機 | 開始前=不可 / 有効中=解錠 / 終了後=不可（営業時間外・既存利用者に影響しない時間帯） |
| 6 | `verifyDeleteKey()` | 削除→Webhook `APPLIED`→削除後に解錠不可 |
| 7 | `verifyCleanupLocal()` | テストコード等のローカル保存を削除 |

重複 name は、作成済みテスト名で再度 `createKey` し Webhook が `failed` になることを手動確認する。

## 結果状態の扱い
| 状態 | 意味 |
|------|------|
| `ACCEPTED_PENDING` | API が受理しただけ。**鍵への反映成功とは扱わない** |
| `APPLIED` | Webhook `result=success` を確認 |
| `FAILED` | API 拒否 / Webhook `result=failed` |
| `UNKNOWN` | Webhook 未着 or `timeout`（反映有無を断定しない。実機で確認） |

## 要確認事項（実機で判明するもの）
- **公式 Webhook ペイロードに passcode ID は含まれない**（`eventName` / `commandId` / `result` / `timeOfSample` のみ）。`createKey` の応答 body に ID が入るかは未確認。取得できない場合、`deleteKey` に必要な ID の取得方法（アプリ側確認等）が本番化の課題になる。ランナーは応答から取れた場合のみ `TEST_PASSCODE_ID` に保存し、無ければ `verifyDeleteKey(<id>)` に手入力する。
- 検証結果は Issue へ秘密情報を伏せて記録する（deviceId は下4桁、テストコード・Token・Secret は記載しない）。

## セキュリティ
- Token/Secret/テストコードはコード・ログに出さない。ログ出力は `redact()` 経由（token/secret/sign/password は `[REDACTED]`、ID は下4桁）。API 応答は丸ごと出力しない。
- Webhook は GAS がヘッダを読めないため共有トークン（クエリ）で簡易認証。ペイロード全体は保存せず `commandId` 単位の結果のみ保存。
- テスト: `node --test test/switchbot-verify-core.test.js`（実 API には接続しない）。
