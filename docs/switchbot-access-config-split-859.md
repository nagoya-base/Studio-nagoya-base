# SwitchBot Access 設定の分離（split-v1）と設定ミス防止・診断強化（Issue #859）

対象: 独立GAS `gas/switchbot-access/`（本番・検証とも）。関連: #757（本番Go/No-Go・正本）、#768（デプロイ）、#824、#857/#858。

> **このPRのマージ＝本番反映・稼働許可ではありません。** 11/11 Mens限定試験は現行の `ACCESS_CONFIG`（旧形式）のまま実施し、
> 試験前に本番GASの設定構造の変更・デプロイはしません。移行は運営者承認後、`ACCESS_ENABLED` OFF の状態で別途行います。
> 鍵の発行・削除・メール配送の機能、予約ルール、`limitedRollout=true` は予約ID**ちょうど1件**という仕様は変わりません。

## 1. 読み取り仕様（契約）

設定の**正本は一箇所**で、`ACCESS_CONFIG_FORMAT` の値で決まります。

| `ACCESS_CONFIG_FORMAT` | 正本 | もう一方の形式のプロパティが残っている場合 |
| --- | --- | --- |
| 未設定（空） | 旧形式: `ACCESS_CONFIG`（JSON一括。従来どおり） | 分割プロパティが1つでもあれば `CONFIG_SOURCE_MIXED` で停止 |
| `split-v1` | 分割形式（下表の10プロパティ） | `ACCESS_CONFIG` が残っていれば `CONFIG_SOURCE_MIXED` で停止 |
| それ以外 / 読取不能 | なし | `CONFIG_FORMAT_INVALID` / `CONFIG_FORMAT_UNREADABLE` で停止（旧形式にも倒さない） |

- 旧・新の**暗黙マージや上書き優先順位はありません**。例: 旧形式のまま `ACCESS_ELIGIBLE_BRANDS` を足しても読まれず、混在として停止します（2026-11-09 の「独立プロパティを設定しても効かない」状態を、黙って通さず明示エラーにする）。
- 読込エラーが1つでもあると `enabled=false` になり、`validateConfig` も失敗します（全ジョブ `CONFIG_INVALID`。fail-closed）。移行の途中で一部だけ更新した状態では発行しません。
- `ACCESS_ENABLED`（停止スイッチ。最後にONにする）と `ACCESS_ENVIRONMENT` は**従来どおり独立プロパティ**。環境名は二重に持ち、分割形式では `ACCESS_DEVICES.environment` と `ACCESS_ENVIRONMENT` が一致しなければ起動しません。
- 実装: `SwitchBotAccessInfra.loadConfig(read)`（読取のみ）。シェル `sba_config_()` はこれを呼ぶだけです。

## 2. 分割形式（split-v1）の運営者向け設定表

値はすべて Script Properties。**秘密値はここに置きません**（SwitchBot トークン等は従来どおり User Properties）。サンプルはダミーです。

### 高頻度（独立プロパティ。1項目ずつ変更できる）

| プロパティ | 書式 | サンプル | 拒否される例（停止コード） |
| --- | --- | --- | --- |
| `ACCESS_ELIGIBLE_BRANDS` | JSON配列。`snb` / `mens` / `studio_x` のみ。空・重複不可 | `["mens"]` | `mens`（括弧なし）→ `ELIGIBLE_BRANDS_PARSE_ERROR` / `[]` → `_EMPTY` / `["SNB"]` → `_INVALID` / `["snb","snb"]` → `_DUPLICATE` |
| `ACCESS_LIMITED_ROLLOUT` | `true` または `false`（小文字・前後空白なし） | `true` | `TRUE` / `1` / `yes` → `LIMITED_ROLLOUT_INVALID`、未設定 → `_MISSING` |
| `ACCESS_PILOT_BOOKING_IDS` | JSON配列。限定モード（`true`）では**ちょうど1件**必須。限定モード `false` では**設定しない** | `["<管理者管理の予約ID>"]` | 未設定 → `PILOT_REQUIRED` / 2件 → `PILOT_BOOKING_IDS_NOT_SINGLE` / 限定OFFで残置 → `PILOT_WITHOUT_LIMITED_ROLLOUT` |
| `ACCESS_GRACE_BEFORE_SEC` | 整数秒 `0`〜`86400`（先頭0・小数・空白不可） | `960` | `-1` / `1.5` / `01` / `86401` → `GRACE_BEFORE_INVALID` |
| `ACCESS_GRACE_AFTER_SEC` | 同上 | `900` | 同上（`GRACE_AFTER_*`） |

予約IDは英数字で始まる英数字・`.`・`_`・`-` の64文字以内。**実予約IDをIssue/PR/ログに書かない**。

### 低頻度（小さなJSON。許可されたキーだけ。未知キーは `*_CONFIG_UNKNOWN_KEY`）

| プロパティ | 必須キー | 任意キー | サンプル |
| --- | --- | --- | --- |
| `ACCESS_CORE_CONFIG` | `commercialUseApproved`（真偽値）, `eligiblePaymentStatuses`（`STRIPE_PAID`/`ADMIN_APPROVED` のみ・空重複不可）, `ledgerTarget` | `capacity`, `storageLimits`, `infra`, `maxReads`, `webhookWaitSec`, `readWaitSec`, `dailyCleanupMaxDeletes`, `autoDeleteExpired`, `expiredDeleteMaxPerSweep`, `retentionSec`, `deleteFreshSec` | `{"commercialUseApproved":true,"eligiblePaymentStatuses":["STRIPE_PAID","ADMIN_APPROVED"],"ledgerTarget":{"facility":"main","room":null},"capacity":{"stopAt":80,"officialLimit":90}}` |
| `ACCESS_DEVICES` | `environment`, `allowedLast4`, `keypads` | — | `{"environment":"production","allowedLast4":["01FD"],"keypads":[{"brand":"mens","facility":"main","deviceId":"<非公開の完全ID>"}]}` |
| `ACCESS_DELIVERY` | `adminMailTo`, `deliveryConfigured`（真偽値） | `delivery`（`deliveryConfigured=true` なら必須）, `maxDeliveryAttempts`, `deliveryRetrySec`, `maxReguides` | `{"adminMailTo":["<運営の通知先>"],"deliveryConfigured":false}` |

- 旧 `ACCESS_CONFIG` で使っている運用パラメータは**すべてそのまま移せます**（未設定時の既定値は旧形式と同じ）。特に `autoDeleteExpired:false` を設定している場合は、`ACCESS_CORE_CONFIG` に必ず移すこと（落とすと期限切れキーの自動削除が有効に戻る）。
- 高頻度の項目（`eligibleBrands` / `limitedRollout` / `pilotBookingIds` / `graceBeforeSec` / `graceAfterSec`）と `enabled` は**JSONに書けません**（二重管理の禁止）。
- `keypads` の各要素は `brand`（既知ブランド）・`facility`（必須）・`room`（任意。指定するなら空でない文字列）・`deviceId` のみ。`brand+facility+room` の重複は `KEYPAD_DUPLICATE`。`allowedLast4` 外の端末は従来どおり `KEYPAD_NOT_ALLOWED_IN_ENV`。端末は**完全一致**で解決し、フォールバックしません。
- 支払根拠は `AccessKeySnapshot` の判定結果（`STRIPE_PAID` / `ADMIN_APPROVED`）。台帳の生値（`not_started` 等）や `UNVERIFIED` は設定できません。現金/PayPay は従来どおり `ADMIN_APPROVED` 判定に従います。

## 3. 診断（読取のみ）

`accessCheckSetup` と `accessReadOnlyDiagnostics` は、キー作成/削除・メール送信・台帳/状態ストアへの書込みをしません。出力は固定コード・SET/MISSING・件数のみ（秘密・予約ID・完全deviceId・宛先は出しません）。

- `config.source`: `LEGACY` / `SPLIT_V1` / `UNKNOWN`。`config.splitProps`: 分割プロパティと `ACCESS_CONFIG_FORMAT` の SET/MISSING/UNKNOWN。
- `config.state`: 基本妥当性（`VALID`/`INVALID` と `errors`）。分割形式では `ACCESS_CONFIG` の MISSING を不足扱いしません。
- **`issuance`（新設）**: 実際の発行前提。`state`（`READY`/`NOT_READY`）、`problems`、`commercialUse`、`paymentStatuses`（件数）、`brands`（件数）、`limitedRollout`（ON/OFF）、`pilotBookingIds`（件数）、`keypads`（件数）、`grace`、`delivery`。
  - 主な `problems`: `COMMERCIAL_USE_NOT_APPROVED` / `PAYMENT_STATUSES_MISSING` / `PAYMENT_STATUS_NOT_ALLOWED` / `ELIGIBLE_BRANDS_MISSING` / `PILOT_BOOKING_IDS_NOT_SINGLE` / `PILOT_WITHOUT_LIMITED_ROLLOUT` / `GRACE_NOT_CONFIGURED` / `GRACE_INVALID` / `LEDGER_TARGET_MISSING` / `KEYPAD_MISSING_FOR_BRAND`（対象ブランドについて、`ledgerTarget` の facility/room と brand の**完全一致**で端末を解決できない。コアの `resolveKeypad` と同じ判定）/ `KEYPAD_AMBIGUOUS_FOR_BRAND`（同じ組合せに端末が複数）/ `KEYPAD_FOR_NON_TARGET_BRAND`（対象外ブランドの端末が残る）/ `DELIVERY_CONFIG_INVALID`。
- `ok`（`DIAGNOSTICS_OK`）は従来どおり基盤（設定・資格情報・台帳・ストア）の合否です。**ON前の合格条件は `ok=true` かつ `issuance.state=READY`** とします。`config=VALID` だけで「発行可能」と判断しないでください。
- 旧形式でも `issuance` は出ます。旧JSONに `eligibleBrands` が無ければ `ELIGIBLE_BRANDS_MISSING` が見えます。
- verify 環境専用の試験関数（#789/#791/#797/#756）は従来どおり旧形式の `ACCESS_CONFIG` だけを読みます（分割形式では `SETTINGS_INCOMPLETE` で止まる。安全側）。

## 4. 移行手順（運営者本人・本番OFFで実施。#757 の別承認後）

前提: このPRがマージされ、#768 の workflow で **`access_state=OFF_CONFIRMED`** でデプロイ済み。`ACCESS_ENABLED` は `true` 以外。

1. **非公開バックアップ**: 現行 `ACCESS_CONFIG` の値を、運営者だけが見られる場所（パスワード管理ツール等）へ日時付きで保存。Issue/PR/チャットに貼らない。
2. `ACCESS_ENABLED` が `true` でないこと、`accessCheckSetup` で `configSource=LEGACY`・`config=VALID` を確認。
3. 分割プロパティ10件のうち、`ACCESS_CONFIG_FORMAT` **以外**の値を用意する（上表。旧JSONの各キーを該当プロパティへ移す。値は変えない）。
4. Script Properties に `ACCESS_CORE_CONFIG` / `ACCESS_DEVICES` / `ACCESS_DELIVERY` / `ACCESS_ELIGIBLE_BRANDS` / `ACCESS_LIMITED_ROLLOUT` / `ACCESS_PILOT_BOOKING_IDS`（限定モード時のみ）/ `ACCESS_GRACE_BEFORE_SEC` / `ACCESS_GRACE_AFTER_SEC` を追加。
   この時点では旧形式＋分割プロパティの**混在**なので、`accessCheckSetup` は `CONFIG_SOURCE_MIXED` を返します（想定どおり。OFFなので影響なし）。
5. `ACCESS_CONFIG` を削除し、`ACCESS_CONFIG_FORMAT=split-v1` を設定。
6. 確認: `accessCheckSetup` → `accessReadOnlyDiagnostics` を各1回。合格条件は `configSource=SPLIT_V1`、`config=VALID`、`ok=true`、`issuance.state=READY`（件数が移行前の意図どおり。例: 限定モードなら `pilotBookingIds=1`）、台帳・ストアPASS、ACCESS OFF。固定コードのみ #757 に記録。
7. 実際の本番ONと限定試験は **#757 の別承認**に従う（このPRの範囲外）。

手順4〜5の途中で中断しても、混在・欠落はすべて停止側になります（発行されない）。

## 5. ロールバック

設定のロールバック（OFFで実施）:
1. `ACCESS_ENABLED` を `true` 以外にする。
2. `ACCESS_CONFIG_FORMAT` を削除し、バックアップの `ACCESS_CONFIG` を戻す。
3. 分割プロパティ（`ACCESS_CORE_CONFIG` / `ACCESS_DEVICES` / `ACCESS_DELIVERY` / `ACCESS_ELIGIBLE_BRANDS` / `ACCESS_LIMITED_ROLLOUT` / `ACCESS_PILOT_BOOKING_IDS` / `ACCESS_GRACE_BEFORE_SEC` / `ACCESS_GRACE_AFTER_SEC`）をすべて削除する（1つでも残ると `CONFIG_SOURCE_MIXED`）。
4. `accessCheckSetup` で `configSource=LEGACY`・`config=VALID`。

コードのロールバック（このPRより前の版へ戻す）は #768 の `deployment_action=rollback`。**旧コードは分割形式を読めない**ため、コードを戻す前に必ず上の設定ロールバックを済ませること（旧コードは `ACCESS_CONFIG` が無いと `CONFIG_INVALID` で停止する＝安全側）。

状態ストア（OP_/BK_/EVT_ 等）・既存キー・通常キー・Webhook には、移行・ロールバックとも触れません。

## 6. 限定モードの解除（全件への拡大。別の運営判断）

`ACCESS_LIMITED_ROLLOUT=false` にし、`ACCESS_PILOT_BOOKING_IDS` を**削除**します。片方だけでは `PILOT_WITHOUT_LIMITED_ROLLOUT` / `PILOT_REQUIRED` で停止します（意図しない全件発行・全件停止の取り違えを防ぐ）。

## 7. テスト

`test/switchbot-access-config-split-859.test.js`（モック。実GAS・実API・実秘密に接続しない）: 正規1件限定、全件モード、二重設定（両方向）、二重管理（JSONに高頻度項目）、形式不正、欠落、無効型、未知ブランド、複数予約ID、端末不一致、決済未承認、猶予欠落、発行前提診断、読取専用診断（書込み0・値非表示）、分割形式での発行と通常キー保全・読込エラー時の無通信。既存の #754/#774 等の回帰は `npm test`（CI）で実行。
