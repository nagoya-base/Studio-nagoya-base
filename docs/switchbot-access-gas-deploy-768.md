# 鍵管理用・独立GAS デプロイ手順（Issue #768 / #778：毎回の手動承認式）

`gas/switchbot-access/`（#754）の鍵管理用・独立GASを、GitHub Actions + `clasp` で**既存のWebアプリDeploymentのまま**更新する。**#778以降は自動デプロイしない**。運営者がActionsから `workflow_dispatch` を起動し、毎回の確認入力を通過したときだけ更新する。`/exec` URL・実行者・アクセス設定は変わらない。
#723（`docs/switchbot-verify-gas-deploy-723.md`）を参考にした**別実装**で、検証GAS・Booking GASとはEnvironment／Secrets／workflow／concurrencyを共有しない。

- 実装: `.github/workflows/switchbot-access-gas-deploy.yml` / `scripts/deploy-switchbot-access-gas.sh` / `scripts/switchbot-access-gas-deploy-lib.js` / テスト `test/switchbot-access-gas-deploy-768.test.js`
- 配布物: `node scripts/prepare-switchbot-access-gas-project.js <出力先>`（組み立てのみ。共有の `gas/booking/shared/AccessKeySnapshot.gs` を含む）

## 絶対に行わないこと（コード・テストで固定）

自動デプロイ（push・マージ契機）／リポジトリ変数での有効化／`ACCESS_ENABLED` の変更（**OFFのまま**）／Script・User Propertiesの書換え／時間主導トリガーの作成・変更・削除／Webhookの登録・更新・削除／SwitchBotの `createKey`・`deleteKey`・解錠その他の実API／Deploymentの新規作成・削除／`clasp run`。
コード反映の成功は、資格情報・Webhook・台帳読取・鍵APIの稼働確認を**意味しない**（それらは運営者の別作業・別証跡）。

## 動作の概要

| 契機 | 動作 |
| --- | --- |
| PR | `booking-pr-tests.yml` が秘密なしでテストするだけ。デプロイjob・Environmentは使わない |
| mainへのpush・マージ | **何も起動しない**（#778でpushトリガーを廃止）。マージ＝デプロイ許可ではない |
| `workflow_dispatch`（`main`、`deployment_action=deploy`） | gateの入力検証を通れば、mainのコードを同じ手順で再反映 |
| `workflow_dispatch`（`main`、`deployment_action=rollback`） | gateの入力検証を通れば、同じDeploymentを既存の版へ戻す（後述） |

ジョブ: `gate`（入力検証・秘密もEnvironmentもなし）→ `test`（秘密なし。deployのみ）→ `approve_on`（ON宣言時のみ。独立承認用Environment・秘密なし）→ `deploy`（Environment `switchbot-access-production`）。`rollback` は `gate`（と、ON宣言時は `approve_on`）の後に単独で動く。
`test` は `node --test test/switchbot-*.test.js` と配布物の組立・検査。**失敗したらデプロイしない**。資格情報はdeploy／rollbackの実行ステップにのみ渡す。

deployの流れ（「更新」ステップまで公開中Deploymentの参照先は変わらない）:

1. mainの新鮮度確認: `origin/main`の対象パス（共有スナップショット・配布スクリプト含む）がrunのSHAと異なれば、新しいrunに任せてスキップ
2. Secrets・認証JSON形式の検査 → `list-deployments`で`DEPLOYMENT_ID`が**1件だけ**存在し固定版（@HEADでない）であることを確認、更新前の公開版を記録
3. 配布物を組み立て、**完全性・純度を検査**（下記）
4. `clasp pull`で対象が鍵管理GAS（`SwitchBotAccessApp.gs`/`SwitchBotAccessCore.gs`を含み、`Booking*`/`Survey*`/`SwitchBotVerify*`を含まない）であることを確認
5. manifest検査: `webapp.access/executeAs`がリモートと一致、新しい`oauthScopes`が無いこと（新scopeは手動承認が先）、Advanced Google Services依存が承認済み（Sheets API v4のみ）で、リモートにあって配布側に無い依存が無いこと（#780。違えば配布せず停止）
6. `clasp push --force` → pullし直して内容照合（ソース反映の確認）
7. `clasp update-deployment <DEPLOYMENT_ID> --description "main <SHA>"`（新版作成＋既存Deployment更新。**1回だけ・再実行しない**）
8. `list-deployments`を最大5回読み直し、版番号が増え説明が`main <SHA>`になったことを確認

更新APIが失敗扱いでも、読取り照合で「反映済み」なら成功、「旧版のまま」なら`NOT applied`で失敗、それ以外は`UNKNOWN_STATE`で失敗し、成功扱いにも自動再実行にもしない。未設定・ID不一致・権限不足・認証失敗はいずれも更新前に安全停止し、ID・資格情報・clasp生出力は出さない。

### 配布対象の完全性

配布物は次の6ファイルと**過不足なく一致**すること（`check-bundle`。`test`がprepareの出力と同期を検証）:
`SwitchBotAccessCore.gs` / `AccessKeySnapshot.gs` / `AccessLedgerReader.gs` / `SwitchBotAccessInfra.gs` / `SwitchBotAccessApp.gs` / `appsscript.json`。
Booking GAS本体、秘密設定（`.clasprc.json`・`.env`等）、テスト、実行ログ、他GASのファイルは含まれない。`.gs`は空でなく、manifestは`executeAs=USER_DEPLOYING`。

## 手動起動ゲート（#778。リポジトリ変数は使わない）

`gate` ジョブがjobの先頭で全入力を検証する（UIのチェック表示や選択肢に頼らない。GitHub API経由の `workflow_dispatch` も同じ検証を通る）。1つでも不正なら**安全停止**（デプロイ・Environment・Secretsへ進まない）。

| 入力 | 必須 | 受理する値 | 備考 |
| --- | --- | --- | --- |
| `deployment_action` | ✔ | `deploy` / `rollback` | 既定 `NOT_SELECTED` は拒否 |
| `safety_confirmed` | ✔ | `true` | 今回は**既存独立GASのコード更新のみ**。実機の鍵発行・削除や設定更新はしない、という確認 |
| `access_state` | ✔ | `OFF_CONFIRMED` / `ON_CHANGE_APPROVED` | 既定 `NOT_SELECTED` は拒否。**運営者の宣言**であり、GASプロパティの実測ではない |
| `executor_confirmed` | ✔ | `true` | Actionsのclasp実行者・Webアプリ実行者・User Properties設定者が同一アカウントと**今回**確認済み |
| `change_approval_reference` | `ON_CHANGE_APPROVED` のみ | 承認済みIssue/記録番号（例 `#999`）。英数字と `# . _ : / -` のみ・64文字まで | 秘密・個人情報・URLを書かない。空・不正形式は停止 |
| `rollback_version` | `rollback` のみ | 正の整数（既存の版） | `deploy` で指定すると**矛盾として停止** |
| `rollback_compat_confirmed` | `rollback` のみ | `true` | 戻し先が現在の本番状態と互換と確認済み。`deploy` で `true` にすると矛盾として停止 |

加えて `main` 以外のブランチ（Run workflowのBranch選択）、`workflow_dispatch` 以外の契機、**実行時点のmain先頭と異なるSHA（古いコミット）**はすべて停止。Environment（`switchbot-access-production`）の取り違え・Secrets欠落は、deploy／rollbackの更新前に既存の検査で停止する。

### 自己申告と独立承認は別物
入力チェックは**GitHub実行者本人の自己申告**で、Environmentの Required reviewers のような**独立承認ではない**。1人運営では Required reviewers を使えないため、次のとおり運用を分ける。

| 状態 | 通過条件 |
| --- | --- |
| `OFF_CONFIRMED`（`ACCESS_ENABLED`がOFF＝本番の鍵操作停止） | 実行者の自己確認 ＋ 既存の自動テスト ＋ 既存の安全ゲート（#768の防護） |
| `ON_CHANGE_APPROVED`（本番ON中の更新） | 上記に加え、`change_approval_reference`（独立承認またはレビュー済みGo/No-Go証跡）が必須、**かつ** `approve_on` ジョブのEnvironment承認を通ること |

`approve_on` は Environment **`switchbot-access-on-approval`**（Secretsは登録しない）を使う。ON中の更新を行う前に、このEnvironmentへ**実行者本人以外**の Required reviewers を設定しておくこと。**未設定のEnvironmentは待たずに通過する**ため、reviewers未設定のままONで更新してはならない（workflowからはreviewersの有無を検証できないため、運用ゲート）。独立承認者を用意できない間は `ON_CHANGE_APPROVED` を使わない。単なるチェックだけでON時の更新を許可する設計にはしていない。

**実行アカウントの同一性**: Webアプリと時間主導トリガーはデプロイ実行者として動き、SwitchBot資格情報・Webhook共有トークンは**実行者のUser Properties**にある。次の3者が同一アカウントであることを、`executor_confirmed` を`true`にする**たびに**確認する: ①Actionsのclasp認証主体（`SWITCHBOT_ACCESS_CLASPRC_JSON`の発行アカウント） ②既存Webアプリの「次のユーザーとして実行」（デプロイ者） ③Propertiesを手動設定した者。違えば起動しない。コードからは他者のUser Propertiesも実行者も確定できないため運用ゲートとし、コードは`manifest`の`executeAs`差異と対象ファイルの取り違えを機械的に止める。
**`ACCESS_ENABLED`の読取り**: Script Propertiesの読取りには実行権限・秘密上の制約があり、デプロイからは読まない（書き換えも一切しない）。`access_state` は宣言値として扱い、実測値ではない。

### 旧リポジトリ変数の扱い
`SWITCHBOT_ACCESS_AUTODEPLOY` と `SWITCHBOT_ACCESS_EXECUTOR_CONFIRMED` は**#778以降どこからも参照されない（不要）**。残っていても、pushでもdispatchでも本番deployには影響しない。混乱を避けるため、運営者がマージ後の任意のタイミングで削除してよい（削除しなくても安全。作成する必要は今後ない）。

## 配備手順（初回〜撤去）

### 1. 初回: 専用GASの作成（手動・運営承認後）
新規の**独立**GASプロジェクトを作成（検証用・本番用は別プロジェクト・別Properties）。`node scripts/prepare-switchbot-access-gas-project.js .gas-deploy/switchbot-access`（コミットしない）の出力を貼る／`clasp push`する。Booking・検証GASのプロジェクトは使わない。Propertiesの設定は`docs/switchbot-access-infra-754.md` §11の準備に従う（`ACCESS_ENABLED`は設定しない＝OFF）。

### 2. OAuth権限・既存Deployment作成（手動）
`appsscript.json`のスコープを手動実行で承認し、「実行ユーザー＝自分（USER_DEPLOYING）／アクセス＝全員（匿名可）」でWebアプリの「新しいデプロイ」を**1回だけ**作成する。この`/exec` URLが以後不変。[Apps Script API設定](https://script.google.com/home/usersettings)で「Google Apps Script API」を有効にする。新しい`oauthScopes`を追加するときも、**先に**手動で承認する（自動デプロイは検出して停止）。

### 3. GitHub Secrets / Environment
**Settings > Environments** で `switchbot-access-production` を作成し、Deployment branchesを`main`のみに限定、Required reviewersを推奨設定。次を**Environment secrets**に登録（Repository secretsに置かない。検証GAS・予約GASのSecretsは流用しない。値はログ・PR・成果物に出さない）:

| Secret | 内容 |
| --- | --- |
| `SWITCHBOT_ACCESS_CLASPRC_JSON` | 実行者アカウントで`clasp login`（`@google/clasp@3.4.1`、ユーザー名`default`）した`.clasprc.json`全文 |
| `SWITCHBOT_ACCESS_SCRIPT_ID` | 鍵管理GASのスクリプトID |
| `SWITCHBOT_ACCESS_DEPLOYMENT_ID` | 手順2で作成した既存WebアプリのデプロイID |

検証環境へも自動デプロイする場合は、別Environment・別Secrets・別workflowを用意する（本workflowは本番専用。検証機末尾37DDを本番へ混入させない。環境ごとの`allowedLast4`はGAS側設定で別管理）。SwitchBotのToken/Secret/Webhook共有トークンはGASのProperties（User Properties）にのみ置き、GitHubへは登録しない。

### 4. 手動デプロイの前提（先輩・運営の判断後）
変数の設定は不要。上記「手動起動ゲート」の入力を満たして `Run workflow` するだけで、**起動のたびに**更新される。初回・再実行とも同じ。ON中の更新を行う場合のみ、先に `switchbot-access-on-approval` Environment（独立のRequired reviewers）を用意する。

### 5. 再デプロイ（スマホのGitHubアプリ／ブラウザ）
1. GitHub > Actions > **"Deploy SwitchBot access GAS"** > **Run workflow**
2. **Branch は `main`**（それ以外は停止）
3. 入力例（OFF時のコード更新）:

   | 入力 | 値 |
   | --- | --- |
   | `deployment_action` | `deploy` |
   | `safety_confirmed` | ON（チェック） |
   | `access_state` | `OFF_CONFIRMED` |
   | `executor_confirmed` | ON（チェック） |
   | `change_approval_reference` | 空欄 |
   | `rollback_version` | 空欄 |
   | `rollback_compat_confirmed` | OFFのまま |

   ON中の更新: `access_state=ON_CHANGE_APPROVED`、`change_approval_reference=#<承認済みIssue番号>`（独立承認者がEnvironmentで承認する）。
4. 失敗時の停止: `gate` が赤なら入力を直して再度 Run workflow（Step Summaryに停止理由の語が出る）。`test` や更新手順が赤ならデプロイされない／`UNKNOWN_STATE` は後述の手順。**自動再試行はしない**。
5. **Success判定**: `gate`・`test`・`deploy` がすべて緑、**かつ**deployジョブで "Push source and update the existing deployment" ステップが実際に実行されている（"Skip if a newer main commit…" で `current=false` のスキップは**成功ではない**）。Step Summaryに `@旧 → @新`（同一Deployment・同一URL）が出ていること。
6. デプロイ後、**読取り診断 `accessReadOnlyDiagnostics` を運営者が別作業・別証跡で手動実行**する（`accessCheckSetup`※設定値は表示されない／`accessAdminStatus`／1回の手動`accessSyncJob`で`FLAG_OFF`／台帳schema・read-only接続）。診断のために`accessInstallTriggers`・createKey/deleteKey等を実行しない。成功前に#754をCloseしない。
7. ログ・Issue・PRには**鍵・各種ID・個人情報を貼らない**（Step Summaryは版番号・SHA・方式のみ）。

### 6. ロールバック
1. Run workflow（`main`）で `deployment_action=rollback`、`rollback_version` に**既存の版番号**、`rollback_compat_confirmed` をチェック、ほかの必須入力（`safety_confirmed`／`access_state`／`executor_confirmed`）も上記のとおり入力。互換確認は、戻し先の版のコードが現在の本番状態（状態ストア・User/Script Properties・台帳schema・既存キー）と互換であることを運営が確認した証。互換でない旧版へは戻さない。
2. 更新前に、deployと同じ読取りのみの対象照合（`clasp pull`で鍵管理GASであることを確認。Booking／検証／Surveyのプロジェクトなら停止、manifestのwebapp設定の不一致・manifest欠落も停止）を行う。通れば同じ`DEPLOYMENT_ID`を既存版へ`update-deployment -V`で戻すだけ（Deploymentの削除・再作成なし）。状態ストア・Properties・既存キー・Webhook登録は削除／上書きしない。ロールバックを契機にcreateKey/deleteKeyを再送しない。
3. Step Summaryに「更新前の版→戻し先の版」と戻し先の説明（非秘密）、互換性確認の有無、SHAが残る。`clasp push`済みの編集用ソース（HEAD）と公開版は別管理。必要ならmainを`git revert`し、レビュー・CI後に整合させる（mainへのrevertのマージは**デプロイを起動しない**。反映は手動で `deploy` を起動する）。
4. `UNKNOWN_STATE`の時は再実行せず、`list-versions`と「デプロイを管理」で現状を確認してから本手順へ。

### 7. 撤去・運用者交代
撤去: workflowを無効化（Actions > Disable workflow）→ `docs/switchbot-access-infra-754.md` §11の撤去手順（`ACCESS_ENABLED`を外す→`accessRemoveTriggers`→棚卸し→Webhook解除は別手順）。
運用者交代: 旧実行者の接続済みアプリでclasp権限を取り消す → 新実行者が`clasp login`・Properties再設定・Webアプリ再デプロイ（別証跡）→ **新しいDeployment IDと実行者**で`SWITCHBOT_ACCESS_CLASPRC_JSON`・`SWITCHBOT_ACCESS_DEPLOYMENT_ID`を更新 → 3者同一性を再確認 → 次回の手動起動で`executor_confirmed`を確認のうえ入力。実行者が変わると`/exec` URLとWebhook登録先が変わり得るため、Webhook再登録は別手順。

## 秘密の扱い
認証ファイルは`$RUNNER_TEMP`に0600で生成し、成功・失敗・中断いずれでもtrapで削除。claspの出力は全てファイルへ退避して表示せず、`set -x`・artifact・cacheは使わない。Step Summaryに出すのは版番号・commit SHA・方式・検証範囲・（ロールバック時の）非秘密の版説明のみ。ID・トークン・パスコード・状態レコードのダンプは出さない。

## 証跡の分離（それぞれ別に記録）
| 区分 | 記録する内容 | 本PR |
|---|---|---|
| Issue・PR・CI | PR番号・head・CI結果 | ✔ |
| 環境準備（GAS・Properties・Secrets・Environment） | 実施判断・日時・結果 | ✘ 未実施 |
| 実デプロイ（#776マージ済みコードの本番反映を含む。#778のレビュー完了と運営者の明示的な手動実行後） | 実施判断・日時・版・run URL | ✘ 未実施 |
| 初回読取診断（`FLAG_OFF`・台帳schema/read-only） | 日時・版・結果（秘密なし） | ✘ 未実施 |
| 手動デプロイの実行（Run workflow） | 実行者・日時・入力値（`access_state`／承認参照）・run URL。#778のIssue/PR作成とマージはデプロイ許可ではない | ✘ 未実施 |
| 鍵の自動発行ON | #756/#757の判断後のみ | ✘ **禁止** |

## テスト
`test/switchbot-access-gas-deploy-768.test.js`: workflowの静的検査（`workflow_dispatch`のみ・push/PR経路なし・旧変数に非依存・必須入力と安全な既定値・gateのenv経由検証・Environment分離・ON時の独立承認job・concurrency・固定clasp・禁止操作の不在）、入力ゲートの網羅検査（未入力・未選択・未確認・OFF宣言・ON承認参照なし・rollback入力の矛盾・branch違い・push/PR契機）、配布物の完全性、偽claspによる成功／認証失敗／ID不一致／他プロジェクト取り違え／push失敗／更新未反映／`UNKNOWN_STATE`／二重実行／ロールバック（未知版・同一版・互換性未確認）／秘密の非漏えい。実GAS・実APIへは接続しない。

## Sheets API v4 サービス依存とmanifest同期（Issue #780）

- **実績**: 独立本番GASは、デフォルトGCPプロジェクトのまま、GASエディタの「サービス」へ Google Sheets API v4 を手動追加した後、`accessReadOnlyDiagnostics()` が `LEDGER_ACCESS_OK` で成功した（標準GCPへの切替なし）。これが成功の唯一の原因だと断定はしない。
- **なぜソース管理するか**: エディタでサービスを追加するとリモート `appsscript.json` の `dependencies.enabledAdvancedServices` が変わる。配布は `clasp push --force` でmanifestも同期するため、リポジトリ側に無いと次回デプロイで除去され、再び `LEDGER_API_DISABLED` に戻るおそれがある。そこで `gas/switchbot-access/appsscript.json` に `{userSymbol:"Sheets", serviceId:"sheets", version:"v4"}` を宣言した。コードは従来どおりREST GET（`spreadsheets.readonly`）を使い、Advancedサービス（`Sheets.`）は実行コードから呼ばない。
- **デプロイ検査**: 承認済みSheets v4は同期できる。未承認のサービス／ライブラリの追加、リモートにあって配布側に無い依存（除去されるもの）は `MANIFEST_UNAPPROVED_DEPENDENCY` / `MANIFEST_REMOTE_DEPENDENCY_WOULD_BE_REMOVED` で配布前に停止する。pushの後はリモートmanifestとの照合（`compare-sources`）も行う。
- **検証待ち**: 実際のリモートmanifest値の読取り比較は本PRでは未実施（ID等を出さない読取り専用調査は運営者側）。差分が想定と違えば、本PRのmanifestを調整してから配布する。
- **運用上の注意**: 今後GASエディタ側で設定を変えたら、同じ変更をGitHubへ反映する。差異に気づかないままデプロイしない（検査が止める）。
- **反映手順**: PRマージでは本番に反映されない。レビュー後に運営者が手動デプロイし、`accessReadOnlyDiagnostics()` を再実行して `LEDGER_ACCESS_OK`（行数は変動しうる）を確認する。これはSwitchBot実機・Webhook・鍵発行の確認ではなく、#756の前提整理とは別。

## 更新前の確認と更新後の確認（運営向け・Issue #804 PR-C2）

本番Accessのコード更新（`Deploy SwitchBot access GAS`）は、**書き込みを始める前に**、接続情報・更新先・配布物を読み取りだけで確認します。
問題があれば何も更新せずに止まります。実行ログの `Preflight passed` の行が、「ここまでは何も書き込んでいない」境界です。

- 使い方・承認（本番ON中は独立承認が必須）は従来どおりです。入力の確認は自己申告で、実際の状態の測定や独立承認の代わりにはなりません。
- 入力の誤り（戻し先の版番号、確認チェックなど）は、Googleに接続する前に止まります。
- 更新後は、更新先の「公開バージョン」と説明文（`main <今回のSHA>`）が**完全に一致**するか読み取りで確認します。
  一致しない・確認できないときは `UNKNOWN_STATE` で止まります。**自動で再実行や巻き戻しはしません**。更新先の状態を読み取りで確認し、手順書（ロールバック）に従って判断してください。
- 確認が通っても、更新の成功やGAS実行時の権限、鍵の発行・削除の動作までは保証しません。ACCESS_ENABLED、各種設定値、トリガー、Webhook、SwitchBotの実機は操作しません。
