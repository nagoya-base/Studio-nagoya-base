# SwitchBot 本番展開｜運営者向け実行手順（Issue #757）

**正本は Issue #757。** 本書はその3工程を、運営者（デプロイ実行者本人）が迷わず実施するための手順書で、コード・設定・デプロイ・トリガー・機能ONのいずれも**実行しない**（マージ＝本番反映ではない）。秘密・完全deviceId・予約ID・暗証番号・連絡先は、Issueにも本書にも書かない。

## 現状（2026-11-07 時点、読取りで確認できた範囲）

| 項目 | 状態 |
| --- | --- |
| PR #820（`pilotBookingIds`＋`limitedRollout`） | main にマージ済み（`5ed9e44`） |
| 最後の本番Accessデプロイ（Actions run #11） | mainの `bc2962f`（PR #803）。**PR #820 より前**のため、#820版は本番に**未反映** |
| `ACCESS_ENABLED` / `deliveryConfigured` / トリガー | 直近既知: OFF / false / 0件（本番の実値は運営者が確認） |

## 工程1｜最新版を本番Accessだけへ反映（発行OFFのまま）

1. GitHub → Actions → **Deploy SwitchBot access GAS** → Run workflow。Branch は `main`（対象SHAは `5ed9e44` 以降の main 先頭）。
2. 入力: `deployment_action=deploy` / `safety_confirmed=true` / `access_state=OFF_CONFIRMED` / `executor_confirmed=true`（clasp実行者・Webアプリ実行者・User Properties設定者が同一アカウントであることを**今回**確認してから）。`ON_CHANGE_APPROVED` は使わない（本番はOFF）。
3. 成功条件: runが success、ログの `Preflight passed` 後に公開版の説明が `main <SHA>` へ更新され、版番号が増えている。`UNKNOWN_STATE` / `NOT applied` なら**再実行せず**、版を読取りで確認して [デプロイ手順 #768](switchbot-access-gas-deploy-768.md) のロールバック節に従う。
4. 報告は **版番号・SHA・成否のみ**を #757 に記録する。

触れないもの: Booking本番、検証37DD GAS、既存Webhook、通常キー。

## 工程1b｜限定設定（OFFのまま・GASエディタ、運営者本人）

Script Properties の `ACCESS_CONFIG`（JSON）に次を設定（既存キーは変えず、追加・更新のみ）。

| キー | 値 |
| --- | --- |
| `limitedRollout` | `true` |
| `pilotBookingIds` | 管理者管理のテスト予約IDを**ちょうど1件**の配列（`["<予約ID>"]`） |
| `eligibleBrands` | `["snb"]` |
| `allowedLast4` / `keypads` | 01FDのみ（完全deviceIdは非公開） |
| `delivery` | `senderName` / `facilityLabel` / `inquiryNote`（任意で運営の `replyTo`）。**`deliveryConfigured` は工程2の直前まで true にしない** |

- テスト予約の台帳 `email` 列は**管理者管理の受信箱**にする（実顧客宛にしない）。
- `ACCESS_ENABLED` は設定しない（OFFのまま）。

確認: `accessCheckSetup` → `accessReadOnlyDiagnostics` を各1回。**合格条件**は、診断 `ok=true`（`DIAGNOSTICS_OK`）、設定 `VALID`（`PILOT_REQUIRED` / `PILOT_BOOKING_IDS_INVALID` が出ない）、環境・台帳・ストアPASS、ACCESS OFF。NGならONしない。結果は固定コードのみ #757 に記録。

## 工程2・3｜一連確認と限定稼働（運営者のGAS操作 5ステップ）

事前: 現地に管理者と通常キー・代替入室（手動解錠／管理者パスコード／物理キー）を確保。他の利用者に影響しない時間帯を選ぶ。

1. `accessInstallTriggers`（`accessSyncJob` 5分 / `accessSweepJob` 1時間 / `accessWatchdogJob` 15分、配送設定時は `accessDeliverJob` 5分）。OFFの間はジョブは `FLAG_OFF` で何もしない。
2. 配送を使う場合は `ACCESS_CONFIG` の配送設定を有効（`deliveryConfigured=true`）にし、`accessInstallTriggers` をもう一度実行して `accessDeliverJob` を作る。
3. `ACCESS_ENABLED='true'`（Script Properties）。発行はテスト予約1件のみ（前日12:00 JST以降の発行窓。配送は前日18:00 JST以降）。
4. 確認: キー発行・存在確認 → 管理者受信箱に**別メール**（暗証番号以外に場所・番号が出ない）と返信先 → 01FDで解錠 → 試験終了後に試験キーの回収（`accessAdminInventory` → 必要なら `accessAdminDelete`）、通常キーが残っていること。
5. 最初の通常周期で、想定外の予約に発行・通知が出ていないこと、通知の受け手が正しいことを確認し、運用開始の日時・版・実施者を #757 に記録（値・IDなし）。

不明・失敗時は自動再発行／再削除せず、手動解錠・手動コード・物理キーで対応する。秒境界の観測・繰返し試験・延長の実機試験は不要（#757 の確定仕様）。

### 即時停止・復旧

- 停止: ① `ACCESS_ENABLED` を `true` 以外へ ② `accessRemoveTriggers`。OFFでもキーは消えない。
- 残存キー: `accessAdminInventory` → 必要なら `accessAdminDelete`（OFFでも利用可）→ 代替入室。状態データは消さない。
- コードの戻し: workflow の `deployment_action=rollback`（[#768手順](switchbot-access-gas-deploy-768.md)）。

## 拡大について

全予約への拡大は、限定運用の実績を見た運営者の**別の設定変更**（`limitedRollout` を意図して外す）。意図なく外さない。
