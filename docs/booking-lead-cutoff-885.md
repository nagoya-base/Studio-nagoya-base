# 新規予約の開始30分前締切とキー未発行対策（Issue #885）

正本は Issue #885。このファイルは調査結果・実装範囲・運営判断待ちを記録する（PIN・トークン・個人情報は記載しない）。

## 調査で確認できたこと（コード読取りのみ。本番ログ・実機は未確認）

| 項目 | 現状（コード上） |
| --- | --- |
| 当日予約の下限 | `Booking.validateCreateBookingInput` が「開始が現在時刻より後」だけを要求（`SAME_DAY_START_TIME_PASSED`）。**締切の余裕は0分** |
| 候補表示 | `Availability.getAvailability` / 月間は同じ「現在分」を下限に使う |
| 鍵の発行開始 | `AccessKeySnapshot.issueWindow`：**利用日の前日12:00 JST**から発行対象（当日確定は確定後の最初の照合で発行） |
| 同期周期 | `accessSyncJob`：5分。ロック付き `runLocked`、静穏時間 `quietSec`、ゲート停止時の再評価間隔 `gateRetrySec` |
| 発行条件 | `Core.evaluateEligibility`：`endSec <= now` のみ `ALREADY_ENDED`。**開始後〜終了前の未発行は対象に残る**（graceBefore/After を含む） |
| ジョブ成功の意味 | `HB_SYNC` は `runLocked` が返した `ok` で記録。**個別キー作成成功とは別**（OP状態 `ISSUED_CONFIRMED` 等が鍵単位の状態） |
| 通知 | `infraAlert` / outbox。**「開始15分前に未発行」「開始5分前に緊急通知」を判定する処理は無い**（未実装） |

## 本PRの範囲（Issue要件 2 項目目の入口部分）

- 新規予約の確定締切＝利用開始30分前。開始ちょうど30:00は可、29:59は不可（秒・ミリ秒の端数は切り上げて不可側）。
- サーバー時刻を正本とし、`createBooking` と `getAvailability`（日別・月間）が同じ下限（`BookingAvailability.getMinimumStartMinutes`）を使う。
- **施行日時ゲート** Script Property `BOOKING_LEAD_2026_EFFECTIVE_AT`（オフセット付きISO 8601）。未設定・不正値は従来ルール。#758 の `BOOKING_RULES_2026_11_EFFECTIVE_AT` / `BOOKING_SLOT_STEP_2026_11_EFFECTIVE_AT` とは**連動しない**。
- 施行前に確定した予約は変更・取消しない。当日延長の60分前締切（#758）は変更しない。
- 管理者経路（Booking Admin の手動作成・日程変更）は本PRでは変更しない。

## 本PRに含めないもの（後続PR／運営判断）

1. **決済の境界**：締切前に開始した Checkout が締切後に完了した場合（予約成立／取消・返金／案内）。現行の PENDING TTL は当日grace（`minHoldHours`）で開始後まで保持され得るため、方針の決定が必要。
2. **キー未発行の再試行・通知**：開始15分前の優先再試行、開始5分前の運営者緊急通知、開始後の安全な再試行と代替入室。通知先・責任者・遅延の決定が必要。
3. 予約単位のキー状態（未発行／発行中／発行済／失敗／失効）の監視・監査表示。
4. 予約画面／FAQ／規約／日英の文言。規約改定の告知期間（既存資料上14日前）を満たす日付を運営が決める。

## 施行手順（運営の明示承認が必要）

1. 告知（規約・予約画面・FAQ・日英）を公開し、公開時刻を記録する。
2. 告知期間を満たした日時を `BOOKING_LEAD_2026_EFFECTIVE_AT` に設定（GAS デプロイは別途承認）。
3. 反映後、`BookingConfig.getLeadCutoffStatus()` が `EFFECTIVE` になることと、当日枠の候補が30分以内で消えることを確認。
4. ロールバック：Script Property を削除（または空に）すると従来ルールへ戻る。
