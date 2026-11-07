# GAS本番更新 運営者向け一画面ガイド（Issue #817 段階2）

通常更新・失敗時・承認の流れを、この1枚で追えるようにまとめたものです。詳細は各手順書へ（末尾の一覧）。
**秘密値（Secrets・clasp認証JSON・ID・メール・トークン）はこの文書にも、Issue・PR・チャットにも書かない。**
Issueの起票は更新の許可ではありません。**原則は、運営者がActionsで明示的に起動し、Required reviewers を設定したEnvironmentでは承認を経て更新が動きます**（Booking／Webhook／Survey／Access。マージだけでは更新されません）。
**例外：SwitchBot verify は、対象ファイルを `main` へ push（マージ）すると自動起動します。Environment `switchbot-verify` に Required reviewers が未設定なら、承認待ちなしで更新されます**（詳細は §1・§2）。
検証のためだけの本番更新はしません（次の正規更新で確認します）。

## 1. 共通の流れ（SwitchBot verify を除く全対象）

> **例外：SwitchBot verify は、対象ファイルを `main` へマージ（push）するだけで自動起動します。** マージ＝更新が始まり得ます。**承認の一時停止があるのは、Environment `switchbot-verify` に Required reviewers を設定している場合だけです**（手順書 #723 では任意）。未設定なら承認待ちなしでそのまま更新されるため、マージ前に設定の有無を確認してください（止めたいときはworkflowを無効化）。失敗時の確認（§4）は他と同じく必要です。「毎回手動起動」が前提なのは、それ以外の対象（Booking／Webhook／Survey／Access）です。

1. **Actions → 対象workflow → Run workflow**（verifyは自動起動もあり、再反映は手動）。Branchは必ず `main`。
2. `test`（秘密なし）が緑になるのを待つ。赤なら何も更新されない。
3. **Environmentの承認待ち**になる（**Required reviewers を設定したEnvironmentだけ**。未設定のEnvironmentは待たずに通過する。Accessの `OFF_CONFIRMED` も、reviewers未設定なら承認の停止はない）。待ちになったら更新内容を確認して承認。**更新前に、対象Environmentの Required reviewers が設定済みか必ず確認する**（Bookingは必須、Accessは推奨、verifyは任意＝手順書どおり）。
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
| SwitchBot 検証 | Deploy SwitchBot verify GAS | `switchbot-verify` | `rollback_version`（空欄で反映） | 対象パスをmainへマージすると**自動起動**（承認の停止は Required reviewers 設定時のみ）。再反映は手動 |

- 同じ対象は直列実行（同時に2本は走らない）。実行中のrunを強制キャンセルしない。
- Access は **マージしても更新されない**（手動起動のみ）。`access_state` は運営者の宣言で、実測ではない。
- SwitchBot 読取り診断（**SwitchBot read-only diagnostics (manual)**）は更新ではなく確認用。鍵発行・削除・解錠・Webhook変更はしない。

## 3. 承認・接続情報（Secrets）の前提

| 対象 | 承認者が見るもの | 必要な登録（名前のみ・値は書かない） |
| --- | --- | --- |
| Booking | 更新範囲（`full` / `admin-only`）と対象main | Admin用: `CLASPRC_JSON`、`BOOKING_ADMIN_SCRIPT_ID` / `_DEPLOYMENT_ID`。Public用（`full`で必須）: **別の** `BOOKING_PUBLIC_CLASPRC_JSON`、`BOOKING_PUBLIC_SCRIPT_ID` / `_DEPLOYMENT_ID` |
| Webhook | 対象main | `BOOKING_WEBHOOK_CLASPRC_JSON` / `_SCRIPT_ID` / `_DEPLOYMENT_ID`（Booking本体と別GAS） |
| Survey | 選んだ `target` | `CLASPRC_JSON`、選んだ側の `SURVEY_<PUBLIC\|ADMIN>_SCRIPT_ID` / `_DEPLOYMENT_ID`（もう片方は不要・代用しない） |
| Access | 入力の宣言内容。ON中の更新は**別の承認者**が `change_approval_reference` を確認 | `SWITCHBOT_ACCESS_CLASPRC_JSON` / `_SCRIPT_ID` / `_DEPLOYMENT_ID` |
| 検証 | 対象main | `SWITCHBOT_VERIFY_CLASPRC_JSON` / `_SCRIPT_ID` / `_DEPLOYMENT_ID` |

- 登録場所は **Settings → Environments → 各Environment**。Googleログイン・権限同意は**パソコンで事前に**行う（実行中の同意画面はない）。
- 担当交代・Google側の接続切れ・権限範囲の変更があれば再ログインして再登録。旧担当のclasp権限は取り消す。
- SwitchBotのToken/SecretはGitHubには登録せず、GAS側のPropertiesだけに置く。置き場所は対象で違う: **Access＝デプロイ実行者のUser Properties**（Script Propertiesは代用されず、無いと `AUTH_CREDENTIALS_MISSING`。実行者交代時は新実行者で再設定）／**検証GAS＝Script Properties**。

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

1. Apps Script「デプロイを管理」で、**操作に応じた基準**で現状を確認する。
   - **通常の更新（deploy）**：**公開版番号が更新前より上がっている**ことと、**説明文が正確に `main <今回のSHA>`** であることを、**両方**確認する。
   - **ロールバック（Access／verifyの `rollback`）**：**公開版が、指定した戻し先の版番号 `N` になっている**ことを確認する（説明文は `main <SHA>` ではなく `rollback to vN (run …)` になる。更新前より版番号が下がるのは正常）。
2. 基準がそろった → 反映済み。結果を記録して完了。**deployで版番号だけ上がってSHAが違う・ロールバックで戻し先の版になっていない・どちらも判断できない場合は未解決のまま**、再実行も完了扱いもせず担当者へ。
   - 更新前のpreflight停止（§4-1）とは**区別する**。§4-1は何も更新されていないので「直して最初から再実行」でよい。ここ（更新の途中・後）は、現状を確認するまで再実行しない。
   - **Booking `scope=full` で途中まで更新された可能性があるとき（例：Adminは更新済み・Publicだけ未反映）**は、AdminとPublicを**別々に**、更新前後の版・説明文の `main <対象SHA>`・schema整合（`BookingsSchema.gs` の差分と `migrateBookingsSchema` の実施状況）を読取りで確認する。**途中更新・状態不明のまま `full` を一括で再実行しない。** 管理者判断と正規手順書（`docs/booking-gas-production-deploy.md`）の復旧方針が確定してから進める。
   - 「旧版のまま」（`NOT applied` を含む）で、**その対象が実際に未更新と読取りで確認できた**場合に限り、原因を直して再実行を検討する（Bookingは上記の対象別確認を先に行う）。
3. 戻す場合は同じデプロイIDを既存の版へ戻す（作り直さない。URLは変わらない）。**SwitchBot verify は先に、後続の自動デプロイを止める**（Actions > Disable workflow）**ことと、実行中のrunがないことを確認する**。止めないと、回復中に別のmain pushが自動デプロイを起動し、戻した版が上書きされる。手順の正本は `docs/switchbot-verify-gas-deploy-723.md` の「ロールバック手順」。戻し終えたらworkflowを再有効化する判断も運営者が行う。入口は Access / 検証の `rollback`（`rollback_version`）。Accessは互換確認（`rollback_compat_confirmed`）が別途必要。
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
