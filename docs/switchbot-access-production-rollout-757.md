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

## 3ブランド化（SNB／Mens／Studio X）｜非公開の設定手順（Issue #824 → #757へ引き継ぎ）

運営者決定（2026-11-07）: 自動鍵発行の対象は **SNB・Mens・Studio X の3ブランド**。#824のコード修正（台帳候補・FREEZE判定）の**反映後**にだけ、次を行う。**コードはScript Propertiesを書き換えない**（設定は運営者が非公開で変更）。

コードの挙動（#824）:
- 台帳の照合候補は、利用日(JST)が当日・翌日の `snb` / `mens` / `studio_x`（正本は `AccessKeySnapshot.TARGET_BRANDS`）。空brandは従来どおり `BRAND_UNKNOWN` で安全側停止、未知のブランドは候補にしない。追跡済み（trackedIds）の予約は利用日を問わず読む。
- 候補になることと、発行されることは別。発行可否は `eligibleBrands`（設定）と、`resolveKeypad` の `brand + facility + room` **完全一致**が決める。
- 支払未確認・延長追加料金未了・要復旧などの凍結（`FREEZE`）は、`eligibleBrands` に含まれる既知ブランドに適用される（拡大前の現行設定 `["snb"]` では、Mens/Studio Xは凍結も発行もせず従来どおり対象外）。取消・対象外ブランドへの変更では凍結せず、既存キーの回収へ進む。

運営者の設定手順（**反映後・ON中の変更は `ON_CHANGE_APPROVED` の承認条件に従う。`OFF_CONFIRMED` をON中に使わない**）:
1. 各ブランドの**実際の物理入口**を確認する。**01FDが3ブランド共通の入口かは未確認**。確認できるまで同一端末を流用しない。
2. `ACCESS_CONFIG.keypads` に、ブランドごとに `brand` / `facility` / `room` と、その入口の完全deviceIdを**完全一致**で設定する（完全IDは非公開）。未設定・曖昧なブランドは `eligibleBrands` に入れない（発行停止のまま）。
3. `allowedLast4` が、設定した全端末の末尾4桁を含むことを確認する（含まれない端末は `KEYPAD_NOT_ALLOWED_IN_ENV`）。利用者・他端末・通常キーには触れない。
4. `eligibleBrands` を、端末対応を確認できたブランドだけ（最終形 `["snb","mens","studio_x"]`）に更新する。`ledgerTarget` の `facility`/`room` が各ブランドの対応表と一致していること。
5. **限定モードは維持**: `limitedRollout=true`、`pilotBookingIds` は管理者管理の予約ID**1件**。一般予約への拡大は別の運営判断。試験対象を変えるときもIDや個人情報をIssueに書かない。
6. `accessReadOnlyDiagnostics` で設定 `VALID` と発行OFF/ON状態を確認し、固定コードのみ #757 に記録する。

注意: PRのマージだけでは本番GASは更新されない。反映は工程1の workflow に従い、**現行ONのまま `eligibleBrands` だけを先行拡大しない**。

## 拡大について

全予約への拡大は、限定運用の実績を見た運営者の**別の設定変更**。`limitedRollout` と `pilotBookingIds` の**両方**を外す（`pilotBookingIds` が残ると、`limitedRollout` を外しても許可リスト外の予約は `NOT_PILOT_TARGET` で発行されない）。意図なく外さない。
