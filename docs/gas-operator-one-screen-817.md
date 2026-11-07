# GAS本番更新 運営者向け一画面ガイド（Issue #817 段階2）

通常更新・失敗時・承認の流れを、この1枚で追えるようにまとめたものです。詳細は各手順書へ（末尾の一覧）。
**秘密値（Secrets・clasp認証JSON・ID・メール・トークン）はこの文書にも、Issue・PR・チャットにも書かない。**
Issueの起票・マージは更新の許可ではありません。**更新は運営者がActionsで毎回明示的に起動し、承認して初めて動きます。**
検証のためだけの本番更新はしません（次の正規更新で確認します）。

## 1. 共通の流れ（どの対象も同じ）

1. **Actions → 対象workflow → Run workflow**。Branchは必ず `main`。
2. `test`（秘密なし）が緑になるのを待つ。赤なら何も更新されない。
3. **Environmentの承認待ち**になる。更新内容を確認して承認。
4. **更新前の確認（preflight）**＝読取りのみ。ここで止まれば**何も更新されていない**。
5. 更新 → **更新後の確認**（`main <SHA>` の自動照合。40桁を目で比べる必要はない）。
6. 実行画面（Step Summary）で結果を確認し、実行URL・結果だけを #804 / #817 に記録。

## 2. 対象別：どこから・どの承認・何を入れる

| 対象 | workflow | Environment（承認） | 入力 | 通常更新の入力 |
| --- | --- | --- | --- | --- |
| Booking Admin＋Public | Deploy Booking GAS to production | `booking-production` | `scope` / `schema_migrated` | `scope=full`、チェックなし |
| Booking Webhook | Update Booking Webhook GAS | `booking-production` | なし | そのまま実行 |
| Survey | Deploy Survey GAS to production | `survey-production` | `target`（`public` / `admin`） | 更新する側を選び、**2回に分けて**実行 |
| SwitchBot 鍵管理（Access） | Deploy SwitchBot access GAS | `switchbot-access-production`（ON宣言時は先に `switchbot-access-on-approval`） | 必須入力が複数 | 手順書 #768 の入力例どおり。**毎回の確認入力が必要** |
| SwitchBot 検証 | Deploy SwitchBot verify GAS | `switchbot-verify` | `rollback_version`（空欄で反映） | 対象パスをmainへマージすると**自動起動**。再反映は手動 |

- 同じ対象は直列実行（同時に2本は走らない）。実行中のrunを強制キャンセルしない。
- Access は **マージしても更新されない**（手動起動のみ）。`access_state` は運営者の宣言で、実測ではない。
- SwitchBot 読取り診断（**SwitchBot read-only diagnostics (manual)**）は更新ではなく確認用。鍵発行・削除・解錠・Webhook変更はしない。

## 3. 承認・接続情報（Secrets）の前提

| 対象 | 承認者が見るもの | 必要な登録（名前のみ・値は書かない） |
| --- | --- | --- |
| Booking | 更新範囲（`full` / `admin-only`）と対象main | `CLASPRC_JSON`、`BOOKING_PUBLIC_*`、`BOOKING_ADMIN_*`（SCRIPT_ID / DEPLOYMENT_ID） |
| Webhook | 対象main | `BOOKING_WEBHOOK_CLASPRC_JSON` / `_SCRIPT_ID` / `_DEPLOYMENT_ID`（Booking本体と別GAS） |
| Survey | 選んだ `target` | `CLASPRC_JSON`、選んだ側の `SURVEY_<PUBLIC\|ADMIN>_SCRIPT_ID` / `_DEPLOYMENT_ID`（もう片方は不要・代用しない） |
| Access | 入力の宣言内容。ON中の更新は**別の承認者**が `change_approval_reference` を確認 | `SWITCHBOT_ACCESS_CLASPRC_JSON` / `_SCRIPT_ID` / `_DEPLOYMENT_ID` |
| 検証 | 対象main | `SWITCHBOT_VERIFY_CLASPRC_JSON` / `_SCRIPT_ID` / `_DEPLOYMENT_ID` |

- 登録場所は **Settings → Environments → 各Environment**。Googleログイン・権限同意は**パソコンで事前に**行う（実行中の同意画面はない）。
- 担当交代・Google側の接続切れ・権限範囲の変更があれば再ログインして再登録。旧担当のclasp権限は取り消す。
- SwitchBotのToken/SecretはGASのScript Propertiesだけに置き、GitHubには登録しない。

## 4. 失敗したとき（まず「何も更新されていないか」を見る）

### 4-1 更新前に止まった（`... failed: role=… stage=… code=… No deployment was updated.`）

→ **何も更新されていない。直して、同じ手順で最初から再実行。** 伝えるのは `role` `stage` `code` の3つだけ。

| stage | 意味 | 対応 |
| --- | --- | --- |
| `SECRETS`（`SECRET_MISSING`） | 登録が足りない | 対象Environmentの登録名を確認して追加。Surveyは選んだ側だけ見る |
| `CREDENTIAL`（`CLASP_CREDENTIAL_OR_USER_MISMATCH`） | 接続情報の形式・ユーザー違い | 接続情報を登録し直す（Adminは`default`、Web/Webhookは`booking-owner`） |
| `PROJECT`（`WEBHOOK_NOT_INDEPENDENT`） | WebhookがBooking本体と同じGAS | Webhook用のScript IDを確認 |
| `LIST` | Googleに接続できない | `AUTHENTICATION_FAILED`＝期限切れ→再登録。`TRANSIENT_API_OR_NETWORK_ERROR`＝時間をおいて再実行 |
| `DEPLOYMENT`（`DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE`） | 更新先が無い／重複 | Apps Scriptの「デプロイを管理」でデプロイIDを確認 |
| `PULL` / `BUILD` | 更新先の取得・配布物の準備に失敗 | 担当者へ（`code`を伝える） |

Bookingで `PREVIOUS_SHA_UNKNOWN` ／ schema関連で止まった場合は §5。Accessの入力検証（`gate`）が赤なら入力を直して再実行（Step Summaryに停止理由）。

### 4-2 更新の途中・後で止まった／未確認（`UNKNOWN_STATE`、`GAS post-update verification failed`、`未確認（stage=… code=…）`）

→ **更新は適用済みかもしれない。再実行・巻き戻しを決める前に、まず現状を読取りで確認する。自動の再実行・巻き戻しはしない。**

1. Apps Script「デプロイを管理」で、対象デプロイの**説明文が `main <今回のSHA>`** か、公開版番号が上がっているかを見る。
2. 反映済み → 結果を記録して完了。旧版のまま → 原因を直して最初から再実行（`NOT applied` で失敗した場合も同じ）。判断できない → 担当者へ。
3. 戻す場合は同じデプロイIDを既存の版へ戻す（作り直さない。URLは変わらない）。入口は Access / 検証の `rollback`（`rollback_version`）。Accessは互換確認（`rollback_compat_confirmed`）が別途必要。
4. 更新後は**読取り専用**の確認だけを行う（確認のために鍵発行・削除・Webhook変更は実行しない）。

## 5. Bookingだけの注意：予約シートの列が変わるとき

- 普通の更新は `scope=full`・`schema_migrated` チェックなし。自動でONにはならない。
- `BookingsSchema.gs` に実変更がある、または前回の本番版を読み取れない（`PREVIOUS_SHA_UNKNOWN`）ときだけ、次の順:
  1. `scope=admin-only` で実行・承認（承認1回目）
  2. Booking Adminのエディタで `migrateBookingsSchema` を実行し成功を確認（不足列を足すだけ。何度でも安全）
  3. `scope=full` ＋ `schema_migrated=true` で実行・承認（承認2回目）
- 以後は説明文が読み取れる形になり、通常手順に戻る。

## 6. 運営者の判断が別に必要なもの（自動では動かさない）

- 各更新の**実行GO**、Google/GASの実環境操作、ログ削除は、それぞれ個別に判断。
- SwitchBot 37DD期限境界試験（#756）は**別件**。Test GASのデプロイGOと実機API/解錠GOは分け、01FDや本番Access ONの許可と混同しない。
- 未検証事項（次の正規更新で確認）: Webhook／Surveyのpreflight・post-update成功の実証跡、Booking Admin/PublicのSHA自動照合・Step Summary・schema guard。

## 7. 詳細（技術者向け）

| 内容 | 文書 |
| --- | --- |
| Booking更新・schema・Secrets | `docs/booking-gas-production-deploy.md` / `gas/booking/README.md` |
| Access更新・ロールバック | `docs/switchbot-access-gas-deploy-768.md` |
| 検証GAS更新・ロールバック | `docs/switchbot-verify-gas-deploy-723.md` |
| 読取り診断 | `docs/switchbot-verify-readonly-804.md` |
| Survey | `gas/survey/README.md` |
