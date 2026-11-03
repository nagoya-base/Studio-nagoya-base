# 予約連携: SwitchBot 期間限定キー自動発行・削除（Issue #748）

実装: `gas/switchbot-access/SwitchBotAccessCore.gs`（純粋ロジック）/ テスト: `test/switchbot-access-core.test.js`。
**本PRはコア（状態機械・照合・安全停止）とモックテストまで。予約GASへの結線・常設受信先・実機検証・本番有効化は含まない（下記「未実施」）。** 機能フラグ `enabled` は既定OFF。OFF時は変更APIを呼ばず、状態も書かない。

## 商用利用ゲート
`config.commercialUseApproved === true`（#713/#718の商用利用条件確認と運用判断の記録後に管理者が設定）でなければ、`enabled` でも対象外（`COMMERCIAL_USE_NOT_APPROVED`）。#718完了は許可を意味しない。

## 設計判断（Issue「実装前に固定する設計」への回答）
| 論点 | 判断 |
|---|---|
| 発行対象 | `status=CONFIRMED` かつ `paymentStatus ∈ config.eligiblePaymentStatuses` かつ `brand ∈ config.eligibleBrands`。受付・未確定・取消・失効は発行しない。現地払いを含めるかは管理者設定（既定は空＝発行しない） |
| 期間 | JST入力を+9hで変換。`start = 利用開始 − graceBeforeSec`、`end = 利用終了 + graceAfterSec`。猶予は**必須設定**（未設定は停止。推測値なし） |
| 変更 | 改訂/期間/Keypadが変わったら旧キーを削除→削除確認後に新キー。旧キーが未確定（UNKNOWN等）の間は新規発行しない。入室中の併存方針は未決（下記） |
| 取消 | 旧キー削除を追跡。削除失敗でも予約取消・返金は巻き戻さない（本モジュールは例外を予約側へ伝播させない前提のアダプタで呼ぶ）。残存は管理者通知 |
| 期限切れ | `EXPIRED`（削除と区別）→ keyList残存確認 → 0件で `ARCHIVED_EXPIRED`、残存は通知＋`adminDelete`。終端状態のみ `retentionSec`（既定30日）後に破棄。未解決は破棄しない |
| Keypad | `config.keypads` の brand/facility/room→完全deviceId対応表のみ。0件/複数件は送信前停止、フォールバックなし |
| 受渡し | `deliverCode` 注入点。`ISSUED_CONFIRMED` 後のみ・1回のみ。既存予約メールへの掲載は**別設計・レビュー対象**（本PRでは結線しない） |
| 実行基盤 | 予約GASから直接呼ばず、独立GAS（`switchbot-verify` と同型）へ引き渡す案を推奨。永続キュー=独立GASのScript Properties（状態）＋別Properties/Secret Manager相当（秘密）。常設受信=独立Webアプリ（Webhook, 共有トークン）。実行上限=`maxReads`(既定3)・`webhookWaitSec`(既定90) |

## 状態機械と二重発行防止
- 識別子: `予約ID:改訂:Keypad末尾4桁:ISSUE#attempt`。SwitchBot上の名前は `SNB-` + sha256(予約ID|改訂|deviceId|操作|attempt)先頭16桁（個人情報なし）。
- 送信前に `PLANNED`→`SENDING` を永続化。保存失敗なら送信しない。`SENDING` で再開したら**送信済みか不明**として `UNKNOWN`（再送しない）。
- 排他: `lock([予約, Keypad])` を注入（GAS: LockService）。同一イベントの再配信・ジョブ再実行・別インスタンス交互実行でも1件。
- `UNKNOWN`/`DELETE_SENDING` からの変更API自動再送は無い。復旧は `adminInspect`（読み取り）→ `adminResolveUnknown`（`CONFIRM_PRESENT`=keyList厳密1件のみ／`ABANDON_ABSENT`=0件のみ。いずれもkeyListで検証、操作者必須）。`ABANDONED` 後のみ新 attempt。

## 反映確認
- API受理(`httpCode=200 && statusCode=100`) ≠ 反映。
- commandIdあり: 認証済みWebhook(`createKey`/`deleteKey`・Keypad種別・commandId一致)の success **かつ** keyList厳密1件。evidence に `WEBHOOK_SUCCESS` と `KEYLIST_CONFIRMED` を別々に保存。Webhook成功でもkeyListに無ければ矛盾として `UNKNOWN`。failed→`FAILED`。重複Webhookは初回維持（巻き戻さない）。90秒未着は `UNKNOWN`。
- commandIdなし: `ACCEPTED_NO_COMMAND_ID` で変更APIを再送せず、読み取り専用keyListを最大 `maxReads` 回（再実行間隔=ジョブ周期）。0件のまま上限→`UNKNOWN`。複数件/ID欠落/属性矛盾/形式不正は即 `UNKNOWN`。
- 削除: 保存済みIDとkeyListで一意解決したIDの一致を確認して1回だけ送信。不在なら `ALREADY_ABSENT`（削除成功を捏造しない）。送信後はkeyListから対象名の消失で `DELETED_CONFIRMED`、残存/照会不能は `UNKNOWN`。

## 秘密・通知・監査
- passcode は `secrets` 注入先（状態ストアと別領域）のみ。状態・通知・棚卸し・履歴に出さない。確定削除/拒否/放棄で破棄。
- 管理者通知は `{code, 予約ID, 改訂, Keypad末尾4桁, state}` のみ。同一 record×code は成功時のみ記録し重複抑止、通知失敗は次回再通知。
- 状態ストア（権限限定）には操作に必要な完全deviceIdを保持する。公開面（通知/棚卸し/Issue/PR/ログ）は末尾4桁まで。
- 履歴は `{時刻, from, to, 根拠}` のみ。

## ロールバック手順
1. `enabled=false`（新規発行・自動削除の停止）。発行済みキーは**消えない**。
2. `inventory()` で `unresolved=true` の record（PLANNED/UNKNOWN/送信済/ISSUED等）を棚卸し。
3. 期限・残存を `sweep()`/`adminInspect` で確認。必要な個別削除は `adminDelete`（フラグOFFでも可）。UNKNOWNは `adminResolveUnknown`。
4. 利用者へ代替入室手段を案内。
5. 直前の正常版へコード復旧。**状態データは削除しない。ロールバックを契機に createKey/deleteKey を再送しない。**
6. 状態整合を再確認。

## 未実施（受け入れ条件との対応）
- [ ] 予約GAS結線・独立GASへのデプロイ・常設Webhook受信（フラグOFFでの結線PRを別途レビュー）
- [ ] 商用利用条件確認と本番有効化判断の記録
- [ ] 非利用時間・現地確認者・代替入室手段を確保した限定実機検証（開始前不可/期間内可/期限後不可/削除後不可/変更/取消）
- [ ] 入室中の期間変更時の併存方針（現状は「削除確認後に新規」のみ）
- [ ] CI・デプロイ・本番有効化・実機確認の個別記録
