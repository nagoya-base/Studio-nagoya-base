# 検証用GAS「SwitchBot Access Test」自動コード反映 手順（Issue #787）

`gas/switchbot-access/` の**同一管理対象コード**を、検証専用の独立GAS **`SwitchBot Access Test`** だけへ GitHub Actions + `clasp` で反映する。#756（自宅検証Keypad・識別子末尾37DD）の限定検証準備用。
**本番（#768/#778 `switchbot-access-gas-deploy.yml`）・Booking・旧検証GAS（#723 `switchbot-verify`）とは別系統**で、workflow／Environment／Secrets／concurrencyを共有しない。本番側は一切変更していない。

- 実装: `.github/workflows/switchbot-access-test-gas-deploy.yml` / `scripts/deploy-switchbot-access-test-gas.sh` / `scripts/switchbot-access-test-gas-deploy-lib.js` / テスト `test/switchbot-access-test-gas-deploy-787.test.js`
- 配布物: `node scripts/prepare-switchbot-access-gas-project.js <出力先>`（本番と同じ6ファイル）

## 起動条件

| 契機 | 動作 |
| --- | --- |
| PR | 何も反映しない。`booking-pr-tests.yml` が秘密・外部通信なしでモック／静的テストを実行するだけ |
| `main` へのpush（対象パスの変更時のみ） | テスト → 成功時のみ検証GASへソース反映 |
| `workflow_dispatch`（`main`のみ） | 再反映（停止後の復旧も同じ）または `rollback` |
| 対象パス以外の変更 | 起動しない |

対象パス: `gas/switchbot-access/**` / `gas/booking/shared/AccessKeySnapshot.gs` / `scripts/prepare-switchbot-access-gas-project.js` / 検証用の配布スクリプト・lib・workflow。
`concurrency: switchbot-access-test-gas-deploy`（`cancel-in-progress: false`）で同一Scriptへの並行更新を禁止する。後着のmainが対象を変更済みの古いrunは `git diff` で検知して**反映せずスキップ**する。

## ジョブの流れ

`gate`（起動条件・入力検証。秘密/Environmentなし）→ `test`（`node --test test/switchbot-*.test.js` と配布物検査。秘密なし）→ `deploy`（Environment `switchbot-access-test`）。`rollback` は `gate` の後に単独で動く。**テストが失敗したらデプロイしない。**

`deploy` は**更新前に、すべて読取りで**次を検査し、1つでも違えば何も変更せず安全停止する:

1. kill switch（`SWITCHBOT_ACCESS_TEST_DEPLOY_ENABLED` が `true`）／実行主体の宣言／`main`
2. 認証JSONの形式、Script IDの形式、**拒否リストとの不一致**（本番・Booking・旧verify・Surveyの Script/Deployment ID。未登録は停止）
3. `clasp pull` で対象GASを同定: 空の新規GAS（`Code.gs`のみ・小）または鍵管理GAS。`Booking*`/`Survey*`/`SwitchBotVerify*`や未知のファイルがあれば停止（**末尾37DDだけで対象を特定しない**）
4. 配布物の完全性（過不足なし・承認済みAdvanced Service＝Sheets v4のみ）
5. リモートmanifestのwebapp設定（実行ユーザー・アクセス権）が配布物と一致、リモートの依存が除去されないこと（実行ユーザーは `USER_DEPLOYING`＝期待する実行ユーザー）

その後 `clasp push --force` → pullし直して内容照合。ログ・Step Summaryにはtoken・ID・clasp生出力を出さない（固定メッセージ・版番号のみ。認証ファイルは必ず削除）。

## 2段階の分離設計（Webアプリ公開は別ゲート）

| 段階 | 条件 | 自動で行うこと |
| --- | --- | --- |
| **段階1: ソース反映のみ（既定）** | `SWITCHBOT_ACCESS_TEST_DEPLOYMENT_ID` **未設定** | ソースpush＋照合のみ。**Webアプリ公開・Deployment作成/更新はしない** |
| 段階2: 固定Deployment更新 | 運営者が**手動で作成したWebアプリDeploymentのID**をSecretに設定 | 既存の固定Deploymentを新版へ更新（1回のみ・再実行しない）。**新規Deploymentは決して作らない** |

初回のWebアプリDeployment作成と `/exec` 公開は自動化しない。Webhook受信が必要になった時点で、運営者が別ゲートとして手動作成する（#756の個別GOの後）。
自動デプロイが触れてよいのは検証GASのソースと承認済み固定Deploymentのみ。**Script/User Properties・`ACCESS_ENABLED`・`deliveryConfigured`・時間主導トリガー・Webhook登録・SwitchBot API（createKey/deleteKey/keyList/解錠）・MailApp・台帳書込み・`clasp run` は一切行わない**（テストで固定）。

初期状態は `ACCESS_ENABLED` 未設定/OFF・`deliveryConfigured=false`・トリガー0・実利用者メール0。反映成功＝GAS診断成功＝37DD API成功＝#756試験GO**ではない**。

## 運営者の設定手順（1回に1ステップ）

1. **ステップ1 Environment作成**: GitHub → Settings → Environments → `switchbot-access-test` を新規作成（本番Environmentとは別）。
2. **ステップ2 Secrets（Environment secrets）**: `SWITCHBOT_ACCESS_TEST_SCRIPT_ID`（検証GAS `SwitchBot Access Test` のScript ID）。
3. **ステップ3 拒否リスト**: `SWITCHBOT_ACCESS_TEST_FORBIDDEN_IDS` に、本番・Booking・旧switchbot-verify・Surveyの Script ID/Deployment IDを空白かカンマ区切りで登録（誤接続の検出用。未登録だと停止）。
4. **ステップ4 clasp認証**: `SWITCHBOT_ACCESS_TEST_CLASPRC_JSON` に、**検証GASを所有する同一アカウント**の `clasp login` 認証JSONを登録。
5. **ステップ5 実行主体の宣言**: Environment変数 `SWITCHBOT_ACCESS_TEST_EXECUTOR_CONFIRMED=true`（clasp実行者・Webアプリ実行者・User Properties設定者が同一アカウントであることの確認。dispatchでは入力の `executor_confirmed` で毎回宣言）。
6. **ステップ6 有効化**: Environment変数 `SWITCHBOT_ACCESS_TEST_DEPLOY_ENABLED=true`。
7. **ステップ7 初回コード反映**: Actions → `Deploy SwitchBot Access Test GAS` → Run workflow（`deployment_action=deploy`、`executor_confirmed` をON、Branch=main）。Step Summaryで「ソース反映のみ」「成功」を確認。
8. **ステップ8 必要な権限承認**: 検証GASのエディタで、承認が必要なscope（スプレッドシート読取・外部リクエスト・メール送信 等）を**運営者本人が手動承認**。自動化しない。
9. **ステップ9 読取診断**: 下記「診断の注意」のとおり、別レビューを経て読取診断を行う。
10. **ステップ10 #756の試験GO**: 実施日時・操作回数・後片付けを#756で運営者が個別にGO。

## 診断の注意（別レビューが必要）

現行 `accessReadOnlyDiagnostics()` は **PRODUCTION専用**（`ACCESS_ENVIRONMENT` が `production` 以外は `ENV_NOT_PRODUCTION` で停止）で、**検証GASでは使えない**。本Issueは診断・認可基準を変更していない（本番の基準を緩めない）。検証用の読取診断への安全な対応は**別Issue・別レビュー**で扱う。それまで検証GASの `ACCESS_ENVIRONMENT` は `verify`、`allowedLast4` は検証専用（本番端末01FDを含めない）、台帳・状態領域は本番と分離し、本番台帳・01FD・本番ユーザーデータへ接続する設定は拒否する。

## 停止・失敗・ロールバック

- **停止（kill switch）**: Environment変数 `SWITCHBOT_ACCESS_TEST_DEPLOY_ENABLED` を `true` 以外にする。以後のpush/dispatchは何も変更せず終了する。**復旧**: `true` に戻し、`workflow_dispatch`（`deploy`）で再反映。さらに止めるにはEnvironment Secretsを削除する。
- **失敗・通信切断**: 更新前の失敗は何も変更していない。push後の照合失敗や更新結果不明は `UNKNOWN_STATE` として失敗にし、**無条件の再デプロイも本番側へのフォールバックもしない**。GASエディタで実際のソース・版を確認してから判断する。
- **ソースのロールバック**: 該当コミットをrevertするPRをmainへマージ → 自動で検証GASへ反映（または `workflow_dispatch`）。
- **固定Deploymentのロールバック**（段階2のみ）: `workflow_dispatch` で `deployment_action=rollback`、`rollback_version` に既存の版番号。同じDeploymentを既存版へ戻す（削除・再作成なし）。
- 受入の証跡: Step Summary（対象SHA・更新前後の版）に初回・更新・停止・復旧を残す。秘密は残さない。

## verify専用の読取診断 `accessTestReadOnlyDiagnostics`（Issue #789）

検証GAS（SwitchBot Access Test）では、本番用の `accessReadOnlyDiagnostics` ではなく **`accessTestReadOnlyDiagnostics`** を手動で1回だけ実行する。本番診断の挙動・基準は変えていない（別関数）。

**fail-closed 条件（すべて満たす場合のみ台帳へ進む）**: 操作主体が `ACCESS_ADMIN_ACTORS` 本人（active/effective 一致）／`ACCESS_ENABLED` が**明示 `false`**（未設定・空・`true`・想定外値は拒否）／`ACCESS_ENVIRONMENT` と `ACCESS_CONFIG.environment` がともに `verify`／`allowedLast4` と `keypads` 末尾4桁が `37DD` のみ（`01FD` 混入は `LAST4_FORBIDDEN`）。

**確認内容**: `LEDGER_SPREADSHEET_ID` の専用台帳に Sheets API の **GET のみ**で到達し、`Bookings` シートの存在・必須14列・シートのタイムゾーンが JST であること（空データ行は許容）。権限/404/スキーマ/時刻は既存の固定コード（`LEDGER_ACCESS_DENIED` / `LEDGER_NOT_FOUND` / `LEDGER_SCHEMA_INVALID` / `LEDGER_TIMEZONE_UNSUPPORTED` 等）で報告する。

**しないこと**: SwitchBot実機API・Webhook・メール・トリガー作成・鍵発行・状態ストア変更・Properties書込み・ロック取得。User Properties（SwitchBot秘密情報）と状態ストアは読まない（未設定でも失敗しない）。

**出力**: `TEST_DIAGNOSTICS_OK` または固定エラーコード、`SET/MISSING/UNKNOWN`、`VERIFY/NOT_VERIFY`、`JST/NOT_JST/UNKNOWN`、行数・検査行数のみ。完全deviceId・スプレッドシートID・アカウント/メール・予約内容・トークン・例外原文は出さない。ログは戻り値と同一の固定JSON1行。

**手順**: GASエディタの関数選択で `accessTestReadOnlyDiagnostics` を選び1回だけ実行 → 実行ログのJSONで `ok=true`・`environment=VERIFY`・`accessEnabled=OFF`・`ledger.headers=COMPLETE`・`ledger.timezone=JST` を確認する。診断のために `production` へ変更しない。この診断だけでは実機テスト・秘密情報登録・トリガー作成・production ON は許可されない。
