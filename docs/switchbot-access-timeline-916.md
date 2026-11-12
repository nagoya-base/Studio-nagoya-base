# 発行タイムライン診断（Issue #916）

正本は Issue #916（親: #915）。遅延原因を実測するための**読取専用・一時的な計測ツール**。判断や是正は行わない。
**本書とPRは、マージ・GASデプロイ・Script Properties変更・トリガー変更・SwitchBot実機操作・実メール送信・本番データ抽出を許可しない。** 実測の実施は運営の別途承認が必要。

## 使い方（管理者のみ・手動）

1. Access GAS のエディタで `accessTimelineDiag` を選び、引数なしで実行する（`ACCESS_ADMIN_ACTORS` に載ったアカウントのみ。それ以外は `NOT_AUTHORIZED`）。
2. 実行ログの `accessTimelineDiag {...}` の1行JSONを読む。**管理者ローカルのみ。GitHubへは行番号・層・相対秒・理由コードだけを転記する。**
3. 実測は予約の利用当日〜翌日の早い時間までに行う（台帳の窓が「利用日がJSTで当日・翌日」のため。#912 の早期回収で終了後の記録は消えうる）。

## 対象と選択

- 台帳リーダーが返す行（利用日がJSTで当日・翌日、対象ブランド）のうち `confirmedAt` が有効なものを、**確定の新しい順に先頭10件**。
- 窓の外の予約は**取得していない**（「記録なし」とは表示しない）。`windowTotal`（窓内の行数）、`excludedNoConfirmedAt`、`shown` を併記する。
- 予約IDは入力しない。結合は内部で `bookingId` の厳密一致（`BK_` → `OP_` → `EVT_`/`DLV_`、`TRK_`）。
- 突合は**確定の新しい順の順位 `rank`**で行う（手元の台帳で同じ条件の行を `confirmedAt` 降順に並べて `rank` 番目を見る）。同一秒は `tie: true`（順序を確定扱いにしない）。絶対日時は出力しない。

## 出力（相対秒のみ）

| 項目 | 意味 |
| --- | --- |
| `rank` / `tie` / `branch` | 順位 / 同一秒の確定 / 同一予約に複数の操作がある場合の枝番（a, b…） |
| `brand` / `pay` / `ledgerStatus` | `snb`・`mens`・`studio_x`（他は `OTHER`） / `card`・`other` / 台帳の状態 |
| `tier` / `leadSec` | `A`=直前（C以外で開始まで60分以内）、`B`=その他、`C`=配送ゲート対象（前日18:00相当より前に確定）、`UNKNOWN_TIER`=設定が読めない / 開始までの余裕（秒） |
| `state` / `delivery` | 発行・配送の状態コード |
| `obs` | t0→初観測（追跡記録 `obsAt`。現在の revision の観測のみ） |
| `sent` | t0→createKey送信 |
| `webhook` | t0→Webhook到着（`receivedAtSec`） |
| `confirmed` | t0→ISSUED_CONFIRMED |
| `sendStart` | t0→配送の送信呼出の開始（`DLV` の `SENDING`） |
| `sendCall` | 送信呼出の所要（`SENDING`→`DELIVERED`）。**利用者への到達時刻ではない**。受信はGmailで別途確認 |
| `gateOpen` / `postGateDelay` | 層Cのみ。t0→配送ゲートが開く時刻 / ゲートが開いてから配送処理が始まるまでの遅延 |
| `sendCycles` | 送信が複数回あった場合の回数。**最初の送信だけを計測**し、再送は集計に混ぜない |
| `reasons` | 下記の理由コード |

t0 は `confirmedAt` のみ。欠ければ行ごと対象外（`paymentConfirmedAt` で代用しない）。精度は秒（±1秒）、`readConsistency: BEST_EFFORT`（複数キーの読取間に同期が状態を進めうる）。

### 理由コード（`null` の理由。原因は断定しない）

`NO_RECORD`（状態ストアに記録が無い。未観測か回収済みかは区別できない）／`REVISION_MISMATCH`／`ORDER_VIOLATION`（確定より前の時刻＝誤結合の検出）／`LEDGER_AMBIGUOUS`（台帳に同じIDが複数）／`DELIVERED_BY_ADMIN`（管理者の確認時刻を送信時刻と誤読しない）。

### エラー（これ以外は返さない）

`NOT_AUTHORIZED` / `LEDGER_*`（既存の固定コード）/ `UNEXPECTED_ERROR`。例外本文・HTTP本文は出さない。

## 安全条件（テストで固定: `test/switchbot-access-timeline-916.test.js`）

- 書込0（Properties・台帳・状態）、ロック0、メール0、SwitchBot API 0、トリガー0。外部への読取は台帳（Sheets API v4 の GET、4〜13回）のみ。
- 状態ストアは `get` のみ（`set`/`del`/`keys` は例外）。既存の `admin()`／`runLocked`／`drainInbox`／`createRuntime` は通らない（`HB_ADMIN` 等を書くため）。
- 出力に**載せない**もの: 予約ID・recId・氏名・メール・PIN・deviceId・commandId・秘密・管理者ラベル・絶対日時・epoch秒・`HH:MM`。
- 保存・集計・通知・監視・定期実行・Web画面・CLI・Execution API は作らない。既存の鍵発行・配送ロジック、トリガー、manifest は変更しない。

## 未確認（実行時に分かる）

- エディタ手動実行時の台帳読取権限（デプロイ実行者本人のトークン）。権限が無ければ `LEDGER_ACCESS_DENIED` 等で終了する。
- 実行ログ（Cloud Logging を含む）の閲覧者・保持期間は環境依存。出力は相対値・種別・固定コードのみとしている。
- 1回の実行時間と、個人アカウントの90分/日（トリガー総実行時間）に手動実行が含まれるか。
