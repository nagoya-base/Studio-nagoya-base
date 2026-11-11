# 個別コードの高速化（Issue #893）

正本は Issue #893。本書は実装の範囲・設定・安全条件との対応・ロールバック手順の記録（PIN・トークン・予約ID・宛先は記載しない）。

**本書とPRは、マージ・GASデプロイ・Script Properties変更・トリガー変更・SwitchBot実機操作・実顧客メール送信を許可しない。** それぞれ運営の別途承認が必要。Access GAS の本番の反映版・トリガー・設定は**未確認**として扱う。

## 目的と観測

2026-11-11 の実地テストで、当日案内メール 17:13 → 個別コードメール 17:27（**受信間隔14分**）。予約確定の正確な時刻と14分の内訳は未確認。
目標は「予約確定から個別コード案内まで、通常時5分以内を目指す」こと。**SwitchBot／Webhook／GASトリガー／メールの外部遅延があるため、5分以内は保証しない。**

## 変更内容（a+b+c。ジョブ周期・トリガーは変更しない）

| | 内容 | 変更箇所 | 既定 |
| --- | --- | --- | --- |
| a | 開始60分以内の未発行予約を優先処理（静穏時間・ゲート待機を省き毎周期再評価） | **コード変更なし**。既存の `infra.priorityRetryLeadSec` を 3600 にする設定 | 900（現行のまま） |
| b | 同じ同期実行内で、今回発行した鍵のWebhook/keyList反映確認を短時間待つ | `SwitchBotAccessInfra.gs` `inRunFollowUp`（新規）／`SwitchBotAccessCore.gs` `reconcileIssueOnly`（新規）／`SwitchBotAccessApp.gs` 実行基盤に `sleep` 依存 | `infra.inRunConfirmMaxSec` = 0（無効） |
| c | 同じ実行で `ISSUED_CONFIRMED` になった鍵だけ、既存と同じ安全な配送処理で即時配送 | `SwitchBotAccessInfra.gs` `deliverRecords`（`deliverCycle` から抽出して共通化）／`inRunFollowUp` | `infra.inRunDeliver` = false（無効） |

**b・c は既定で無効**で、コードをデプロイしただけでは挙動は変わらない（`syncCycle` の結果にも `inRun` は出ない）。有効化は運営の承認後に設定する（ロールバックは設定を外すだけ）。

### 設定（`ACCESS_CORE_CONFIG` の `infra`。サンプル。**本番へは投入しない**）

```json
{ "infra": { "priorityRetryLeadSec": 3600, "inRunConfirmMaxSec": 45, "inRunDeliver": true } }
```

- `priorityRetryLeadSec`（既存）: 警告（既定600）・緊急（既定300）より大きい正の数。不正値は既定へ戻り、計画に `KEY_READINESS_LEAD_INVALID`。**警告10分・緊急5分の閾値は変更しない。**
- `inRunConfirmMaxSec`: 0〜60。0・負・非数・非有限は 0（無効）、60超は 60 へ丸める。無制限の待機は設定できない。
- `inRunDeliver`: `true`（真偽値）のときだけ有効。`deliveryConfigured !== true`（配送が未承認・未設定）の間は、有効にしても同期内では送らない。

### 待機時間の設計根拠（推奨 45 秒、上限 60 秒）

- 同期は**ロックを保持したまま**待つ。`doPost`（Webhook受信）は同じロックを `webhookLockWaitMs`（8秒）待ち、取れなければ受信箱（INBOX）へ退避する（既存設計）。退避された Webhook は待機ループの `drainInbox`（3秒間隔）で、**到着時刻を保ったまま**取り込む（`receivedAtSec` は到着時刻。取込時刻にしない）。
- 他ジョブ（配送5分・清掃1時間）の `lockWaitMs`（20秒）を超えると、そのジョブはその周期だけ `LOCK_UNAVAILABLE` になり次周期に再実行される（既存の失敗連続通知は3回連続で発火）。待機は常に上限つき・発行した予約がある周期だけなので、連続失敗は想定しないが、**実測で確認する**（下記）。
- GAS実行時間上限（6分）と `runBudgetSec`（既定240秒）に対し、待機の終わりは「設定秒数」と「`runBudgetSec` の残り」の早いほう。
- 待機中のポーリングは状態ストアの読取のみ。SwitchBot API は Webhook 着後の keyList 読取1回だけ（API日次予算への影響は小）。

## 安全条件との対応（Issue #893／タケルのレビュー必須条件）

| 条件 | 対応 |
| --- | --- |
| 凍結判定を通過した予約のみ優先 | `readinessOf` は `toCoreInput` が `SYNC` を返した確定済み適格予約（支払・承認・凍結・取消・対象外を既存どおり判定）だけを対象にする。承認待ち・決済未完了・返金・取消・利用終了後・対象外ブランドは createKey しない（テスト済） |
| FAILED/UNKNOWN へ createKey を再送しない | 今回の変更で createKey の呼び出し箇所は増えていない。待機中の再照合は `reconcileIssueOnly`（読取のみ） |
| 登録結果不明・タイムアウト・API障害を成功扱いしない | 待機で確認できなければ何もせず従来の次回同期へ。90秒を超える未着は既存どおり `WEBHOOK_TIMEOUT`→UNKNOWN＋通知。keyList不一致は UNKNOWN。keyList読取失敗は待機を打ち切り（reads=1）、短時間に読取を使い切らない |
| 二重 createKey を防ぐ | 待機対象は「今回の実行で送信した `SENT_WAIT_WEBHOOK` の発行 record」のみ。同じ予約全体の `engine.sync` を繰り返さない（旧鍵の削除照合の `reads` を短時間で消費しないため。Issue 本文の「既存の冪等な `engine.sync`」から、発行 record だけを再照合する `reconcileIssueOnly` に絞った変更点） |
| `ISSUED_CONFIRMED` 以外の暗証番号を送らない | 同期内配送の対象は、**今回の実行で** `ISSUED_CONFIRMED` に変わった鍵のみ。前回以前から確認済みの鍵は従来の配送ジョブの責務のまま |
| 送信直前の台帳再確認・`deliveryGate`・`SENDING` 先行永続化・`DELIVERED`/`UNKNOWN` 非再送・排他 | 配送処理は `engine.deliver` をそのまま使う（`deliverCycle` と同じ共通関数 `deliverRecords`）。待機の後に台帳を**改めて1回読み**、読めなければ送らず配送ジョブに任せる（fail closed）。同期と配送ジョブは同じスクリプトロックで排他 |
| 予約GASの当日案内本文・別メール | 変更しない。暗証番号は既存の別メール |
| #891 未発行警告・通知不達・代替入室 | 変更しない（回帰テスト通過） |
| ACCESS_ENABLED=OFF・限定ロールアウト | `FLAG_OFF` では待機も発行もしない（テスト済） |
| PIN・トークン・完全deviceId・予約ID・宛先 | ログ・通知・本書・テスト出力に出さない。秘密は既存の秘密領域のまま |

## 想定待ち時間（**モックの仮想時計による比較。保証値ではない**）

テスト `test/switchbot-access-fast-issue-893.test.js` の「計測(モック)」。5分周期の同期・配送トリガーの位相を変え、Webhook到着遅延 W を仮定して「確定→コード案内メール送信」を測る。外部の実遅延（実Webhook・GASトリガーのずれ・メール配送）は含まない。

| 構成（W=20秒、同期位相 1〜299秒） | 最小〜最大 |
| --- | --- |
| 現行 | 約12〜17分（実測14分と整合） |
| a のみ | 約7〜12分 |
| a+b | 約2〜7分 |
| **a+b+c** | **約0.4〜5.3分**（初回待ち最大5分＋W＋数秒） |
| a+b+c で W=70秒（待機上限45秒より遅い） | 約5〜10分（同期内では確認できず、次回同期で安全に確認・配送） |

- 通常時の目安は **1〜6分**。W が待機上限より遅い、GASトリガーが遅れる、SwitchBot・メールが遅い場合は5分を超える。**5分以内を保証したものではない。**
- 例外時の上限／復帰: 待機は最大 `inRunConfirmMaxSec`（≤60秒）。それを超えたら従来の次回同期（5分後）に戻り、90秒の `WEBHOOK_TIMEOUT` 判定は従来のまま。

### 本番切替時の実測（運営の承認後）

予約台帳の `confirmedAt`／`accessGuideSentAt`、Apps Script「実行数」の同期・配送ジョブの開始時刻と所要時間、暗証番号メールの受信時刻で突き合わせる。Webhook到着時刻の確定が必要なら、状態ストアの時刻だけを出す読取専用診断を**別Issue／別PRで**提案する（本PRの範囲外）。待機中のロック競合は、`HB_SYNC` の所要時間と配送・清掃ジョブの `LOCK_UNAVAILABLE` 通知の有無で確認する。

## 本番切替の手順（運営の別途承認が必要。本PRでは実施しない）

1. 現状の設定・デプロイ版・既知の正常動作を、秘匿情報なしで記録する（`accessAdminStatus`、`infra` の現在値）。Access GAS の最新版反映・トリガー・対象ブランド・通知先は**未確認**として事前照合する。
2. 本番デプロイ（承認後）。この時点では b・c は無効で挙動は変わらない。
3. 必要なら `priorityRetryLeadSec=3600` を設定（承認後）。次に `inRunConfirmMaxSec` と `inRunDeliver` を段階的に有効化する。
4. 対象を限定したテスト予約（`pilotBookingIds`／限定ロールアウト）で、発行→反映確認→メール受信→解錠→回収→通知を確認し、実測と異常時の戻し方を記録する。
5. 問題があれば下記ロールバック。既存の代替入室（`docs/switchbot-access-infra-754.md` §10）を利用する。

## ロールバック

- **設定のみで戻る**: `infra.inRunDeliver` と `infra.inRunConfirmMaxSec` を外す（または 0／false）→ 次の同期周期から従来動作。`priorityRetryLeadSec` を外す（既定900へ）。
- 新しい状態キー・状態遷移は追加していないため、**状態ストアの移行・掃除は不要**。待機・同期内配送の途中状態（`SENT_WAIT_WEBHOOK`／配送記録）はすべて既存の状態で、従来の同期・配送ジョブがそのまま引き継ぐ。
- コードを戻す場合は、前の正常版を再デプロイする（本PRのコードは設定が無効なら挙動不変）。

## 非対象

`accessSyncJob` の1分周期化、トリガーの追加・再作成、監視機構の全面改造、別GAS間の秘密の受け渡し、日次バックアップコード、予約GASの当日案内本文の変更。#885（30分前締切）・#758・#888・#757・#832 は変更しない。
