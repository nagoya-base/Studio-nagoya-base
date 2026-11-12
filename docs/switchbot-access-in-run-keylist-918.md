# commandIdなし鍵の同期内keyList高速確認（Issue #918）

正本は Issue #918（親 #915、調査 #916／PR #917、#893 の同期内確認の拡張）。本書は実装の範囲・設定・安全条件との対応・最悪負荷・ロールバックの記録（PIN・トークン・予約ID・宛先・完全deviceIdは記載しない）。

**本書とPRは、マージ・GAS本番デプロイ・Script Properties変更・トリガー変更・SwitchBot実機操作・実予約の作成・実メール送信を許可しない。** いずれも PR レビュー完了後にオーナーが個別に判断する。

## 目的と効果の限界

実測で、createKey の成功応答が即時（0〜1秒）でも `commandId` がなく、直後の keyList 初回読取に鍵が見えないと、**次の5分周期まで再確認しない**ことが、予約確定→PINメール送信までの長さの一因と考えられる。SwitchBot 自体の反映に約5分かかった証拠ではない。

本変更は、`commandId` がない発行だけ、**同じ同期 run 内で keyList を追加読取し、確認できた場合だけ**確定・配送を早める。確認できなければ従来どおり次の5分周期（安全網）で確認する。

- **反映時間の分布は未計測。** 45秒以内に鍵が反映される場合に限り、最大約5分の待ちを縮められる。「3〜5分短縮」は保証しない。
- 静穏時間（`quietSec=60`）・予約確定→初観測の待ちは対象外（別工程）。
- 導入後は、下記の測定指標で +10/+25/+45秒の初期値を見直す。

## 動作

`infra.inRunConfirmMaxSec`（#893 の既存枠。0〜60。**0 なら完全無効＝従来動作**。初期推奨45）を共用する。新規の設定項目・トリガー・永続状態キーは**作らない**。

| 項目 | 仕様 |
| --- | --- |
| 対象 | **今回の run で createKey を送信**（`sentAtSec >= 同期開始`、かつ今回 `engine.sync` した予約）し、`ACCEPTED_NO_COMMAND_ID` のまま未確認の**発行** OP のみ。過去 run の OP、削除 OP、`UNKNOWN`／`FAILED`／`commandId` あり（Webhook 経路）は対象外 |
| 通常読取（維持） | API 応答直後の通常読取1回（従来どおり。`reads=1`）。ここで見えれば待機も追加読取もない |
| 追加確認 | 同期内の待機ループ開始（t0）から **+10、+25、+45秒**に最大3回。設定秒数を超える回は予定しない（30秒設定なら +10/+25 の2回） |
| API | 各回の `listDevices` は**1呼出**。取得した1スナップショットで対象鍵を**まとめて**照合する。追加APIは最大**3回／run**（鍵数に比例しない）。見つかった鍵がすべて確定すれば後続の回は行わない |
| 確定 | `Core.confirmIssueFromSnapshot`。既存の `inspectKeyList`＋`judgeIssued` を再利用し、**厳密に1件・ID あり・属性矛盾なし**のときだけ `ISSUED_CONFIRMED`。証拠は `KEYLIST_CONFIRMED`、履歴 `basis` は固定列挙 `IN_RUN_T1/T2/T3` |
| 未確認・異常 | 未検出・重複・ID欠損・属性矛盾・端末欠落・API失敗・不正応答は**何も変更しない**（`UNKNOWN`／`FAILED` への遷移・通知を新設しない）。次周期の通常読取（#2、#3、`READ_LIMIT`、異常停止）が従来どおり判定する |
| `reads` | 追加確認は `rec.reads` を増減しない。`maxReads`（現行3）・`readWaitSec`・削除側の読取に影響しない。高速失敗が原因の早期 `READ_LIMIT` はない |
| 配送 | 今回 `ISSUED_CONFIRMED` になった鍵だけ、`infra.inRunDeliver=true` のときに既存の同期内配送（台帳再読込・決済／revision／取消・配送ゲート・送信直前確認・`SENDING` 先行永続化）を通る。未確認 PIN の配送・二重送信なし。`DELIVERED` はメール API 成功であり、受信の保証ではない |

### 見送り条件（読まずに従来周期へ戻す）

次の回は**実施せず、その回（と、解消しない種類のものは後続の回）のために待たない**。`inRun.fast.skipped` に固定コードを残す。

| コード | 条件 |
| --- | --- |
| `TIME_BUDGET` | 予定時刻＋15秒が同期の実行時間上限（`runBudgetSec`）を超える（後段の通常処理に時間を残す）。予定時刻が期限（設定秒数／`runBudgetSec`）を超える回はそもそも予定しない |
| `API_BUDGET_LOW` / `API_BUDGET_UNKNOWN` | 日次API使用量が `apiDailyBudget`（設計値8,000）の80%以上、または残量を判定できない（既存の通常業務へ予算を残す）。枯渇時は従来どおり同期自体を実行しない |
| `LOCK_NOT_HELD` | スクリプトロックを保持していない（通常は起こらない防御） |
| `TICK_LATE` | 予定時刻より5秒を超えて遅れて起きた（期限境界で無理に呼ばない） |
| `LIST_FAILED` | `listDevices` が例外・`ok:false`・不正応答（その回は消費し、連打しない） |
| `SLEEP_UNAVAILABLE` / `SLEEP_FAILED`（`waitSkipped`） | `sleep` 未注入・例外 |

状態の保存失敗など、確定処理で例外が起きた場合は `SYNC_ERROR` を通知し（隠さない）、その鍵は未確認のまま次周期の通常読取に任せる。

### 既存の45秒 Webhook 待ち（#893）との共存

同じ待機ループ・同じ期限（`min(t0+設定秒数, 同期開始+runBudgetSec)`）を共用する。Webhook 待ちがある間は従来の3秒間隔で `drainInbox`＋照合し、高速確認の予定時刻にも起きる。待機時間は**加算されない**（最大 `inRunConfirmMaxSec`）。Webhook 経路の挙動・`reads=0` の待機・90秒 `WEBHOOK_TIMEOUT` は変更しない。

## 変更箇所

| ファイル | 内容 |
| --- | --- |
| `gas/switchbot-access/SwitchBotAccessCore.gs` | `confirmIssueFromSnapshot`（新規。API を呼ばずスナップショットだけで確認）、`IN_RUN_BASIS`（固定列挙）、エクスポート |
| `gas/switchbot-access/SwitchBotAccessInfra.gs` | `inRunFollowUp` の待機ループ拡張、`runFastTick`／`fastBlocked`（新規）、タイムライン診断へ `hasCommandId`・`reads`・`evidence`・`basis` を追加 |
| `test/switchbot-access-in-run-keylist-918.test.js` | 36件（仮想時計・モック。実API・実機・実メールなし） |

変更しないもの: `quietSec=60`、`syncIntervalSec=300`、`priorityRetryLeadSec`、発行窓（前日12:00）／配送ゲート（前日18:00）、`maxReads`、`readWaitSec`、createKey の自動再送禁止、`SENDING` 先行永続化、`UNKNOWN`／`FAILED` からの再送禁止、確認前PIN配送禁止、取消・決済・予約改訂チェック、予約GAS。

## 最悪負荷（追加分）

| 項目 | 最悪値 |
| --- | --- |
| 追加 SwitchBot API | **3回／run**（鍵数・予約数に依存しない）。日次の理論上限は 3 × 288（5分周期の全 run が `ACCEPTED_NO_COMMAND_ID` の発行を含む場合）＝864 だが、実運用は発行を含む run のみ。日次使用量が設計値の80%に達したら追加確認を止める |
| 追加の同期実行時間 | **最大45秒／run**（設定45秒の場合）。既存の #893 の待機と共存し加算しない。`runBudgetSec`（既定240秒）・GAS上限6分の内側。残りが15秒未満の回は実施しない |
| ロック保持 | 待機中もスクリプトロックを保持（#893 と同じ）。他ジョブ（配送・清掃）は `lockWaitMs`（20秒）で `LOCK_UNAVAILABLE`（次周期で再実行。連続3回で通知）、Webhook 受信は8秒で INBOX へ退避し次の `drainInbox` で取り込む |
| 永続状態 | 追加なし。履歴1件（`ISSUED_CONFIRMED` 遷移の `basis`）の値が変わるだけ |

## ロールバック

- **設定のみで戻る**: `infra.inRunConfirmMaxSec` を外す（または 0）→ 次の同期から従来動作（待機も追加読取もなし）。Webhook 経路の同期内確認（#893）も同じ設定で止まる点に注意。#893 の Webhook 待ちだけ残したい場合は、コードを戻す。
- 新しい状態キー・状態遷移・設定項目は追加していないため、**状態ストアの移行・掃除は不要**。`basis` が `IN_RUN_T1〜T3` の履歴が残っても、既存コードは発行 OP の履歴 `basis` を判断に使わない（記録と診断表示のみ）ため無害。
- コードを戻す場合は、前の正常版を再デプロイする（本PRのコードは設定が無効なら挙動不変）。

## 効果測定（運営承認後の本番導入時）

反映時間分布は未計測。診断（管理者ローカルの `accessTimelineDiag`。公開 Issue へは固定列挙と相対秒だけを転記）の次の値で測る。

| 指標 | 見方 |
| --- | --- |
| 高速確定率 | 行の `basis` が `IN_RUN_T1/T2/T3` の件数 ÷ `hasCommandId=false` の確定件数。`PERIODIC` は従来の周期確定 |
| 初回確認ティック | `basis` の T1/T2/T3（反映が +10/+25/+45秒のどこで見えたか）。T3 が多く未確認も多ければ設定秒数・間隔を見直す |
| 確認根拠 | `evidence`（`KEYLIST_CONFIRMED`）。`reads` は通常読取の回数で、高速確認では増えない |
| `confirmedAt→送信処理完了` | 既存の `confirmed` と `sendCall`／`sendStart` |
| 負荷 | `HB_SYNC` の所要時間、配送・清掃の `LOCK_UNAVAILABLE` 通知の有無、`apiCallsToday`（`accessAdminStatus`） |

## 本番導入の手順（運営の別途承認が必要。本PRでは実施しない）

1. 現状の設定・デプロイ版・`infra` の値を、秘匿情報なしで記録する。
2. 本番デプロイ（承認後）。`inRunConfirmMaxSec=0` のままなら挙動不変。
3. 承認後に `inRunConfirmMaxSec=45`（#893 の `inRunDeliver` と併せて段階的に）。
4. 限定した検証予約で、発行→追加確認→メール受信→解錠→回収→通知を確認し、上記指標を記録して +10/+25/+45秒を見直す。
5. 問題があれば上記ロールバック。既存の代替入室（`docs/switchbot-access-infra-754.md` §10）を利用する。
