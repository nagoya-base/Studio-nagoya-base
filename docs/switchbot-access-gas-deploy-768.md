# 鍵管理用・独立GAS 自動デプロイ手順（Issue #768）

`gas/switchbot-access/`（#754）の鍵管理用・独立GASを、GitHub Actions + `clasp` で**既存のWebアプリDeploymentのまま**更新する。`/exec` URL・実行者・アクセス設定は変わらない。
#723（`docs/switchbot-verify-gas-deploy-723.md`）を参考にした**別実装**で、検証GAS・Booking GASとはEnvironment／Secrets／workflow／concurrencyを共有しない。

- 実装: `.github/workflows/switchbot-access-gas-deploy.yml` / `scripts/deploy-switchbot-access-gas.sh` / `scripts/switchbot-access-gas-deploy-lib.js` / テスト `test/switchbot-access-gas-deploy-768.test.js`
- 配布物: `node scripts/prepare-switchbot-access-gas-project.js <出力先>`（組み立てのみ。共有の `gas/booking/shared/AccessKeySnapshot.gs` を含む）

## 絶対に行わないこと（コード・テストで固定）

`ACCESS_ENABLED` の変更（**OFFのまま**）／Script・User Propertiesの書換え／時間主導トリガーの作成・変更・削除／Webhookの登録・更新・削除／SwitchBotの `createKey`・`deleteKey`・解錠その他の実API／Deploymentの新規作成・削除／`clasp run`。
コード反映の成功は、資格情報・Webhook・台帳読取・鍵APIの稼働確認を**意味しない**（それらは運営者の別作業・別証跡）。

## 動作の概要

| 契機 | 動作 |
| --- | --- |
| PR | `booking-pr-tests.yml` が秘密なしでテストするだけ。デプロイjob・Environmentは使わない |
| mainへのpush | 対象パス（`gas/switchbot-access/**`、`gas/booking/shared/AccessKeySnapshot.gs`、`scripts/prepare-switchbot-access-gas-project.js`、本デプロイのscript/lib、本workflow）の変更時のみ。**docs・README・testsのみの変更では起動しない** |
| `workflow_dispatch`（`rollback_version`空欄） | mainのコードを同じ手順で再反映 |
| `workflow_dispatch`（`rollback_version`指定） | 同じDeploymentを既存の版へ戻す（後述） |

ジョブ: `gate`（秘密・Environmentなし）→ `test`（秘密なし）→ `deploy`（Environment `switchbot-access-production`）。`rollback` は `gate` 後に単独で動く。
`test` は `node --test test/switchbot-*.test.js` と配布物の組立・検査。**失敗したらデプロイしない**。資格情報はdeploy／rollbackの実行ステップにのみ渡す。

deployの流れ（「更新」ステップまで公開中Deploymentの参照先は変わらない）:

1. mainの新鮮度確認: `origin/main`の対象パス（共有スナップショット・配布スクリプト含む）がrunのSHAと異なれば、新しいrunに任せてスキップ
2. Secrets・認証JSON形式の検査 → `list-deployments`で`DEPLOYMENT_ID`が**1件だけ**存在し固定版（@HEADでない）であることを確認、更新前の公開版を記録
3. 配布物を組み立て、**完全性・純度を検査**（下記）
4. `clasp pull`で対象が鍵管理GAS（`SwitchBotAccessApp.gs`/`SwitchBotAccessCore.gs`を含み、`Booking*`/`Survey*`/`SwitchBotVerify*`を含まない）であることを確認
5. manifest検査: `webapp.access/executeAs`がリモートと一致、新しい`oauthScopes`が無いこと（新scopeは手動承認が先）
6. `clasp push --force` → pullし直して内容照合（ソース反映の確認）
7. `clasp update-deployment <DEPLOYMENT_ID> --description "main <SHA>"`（新版作成＋既存Deployment更新。**1回だけ・再実行しない**）
8. `list-deployments`を最大5回読み直し、版番号が増え説明が`main <SHA>`になったことを確認

更新APIが失敗扱いでも、読取り照合で「反映済み」なら成功、「旧版のまま」なら`NOT applied`で失敗、それ以外は`UNKNOWN_STATE`で失敗し、成功扱いにも自動再実行にもしない。未設定・ID不一致・権限不足・認証失敗はいずれも更新前に安全停止し、ID・資格情報・clasp生出力は出さない。

### 配布対象の完全性

配布物は次の6ファイルと**過不足なく一致**すること（`check-bundle`。`test`がprepareの出力と同期を検証）:
`SwitchBotAccessCore.gs` / `AccessKeySnapshot.gs` / `AccessLedgerReader.gs` / `SwitchBotAccessInfra.gs` / `SwitchBotAccessApp.gs` / `appsscript.json`。
Booking GAS本体、秘密設定（`.clasprc.json`・`.env`等）、テスト、実行ログ、他GASのファイルは含まれない。`.gs`は空でなく、manifestは`executeAs=USER_DEPLOYING`。

## 段階ゲート（マージしても環境未準備なら本番に触れない）

環境準備、初回GAS作成、初回Deployment作成、自動デプロイ有効化は**別段階**で、最初の3つは運営の明示的承認による手動作業。
`gate`ジョブは次の**リポジトリ変数**（Settings > Secrets and variables > Actions > Variables。秘密ではない）だけを読み、Environment・Secretsへは触れない。

| 変数 | 値 | 意味 |
| --- | --- | --- |
| `SWITCHBOT_ACCESS_AUTODEPLOY` | 未設定 | **無効**（既定）。push・dispatchともデプロイ／ロールバックを試みない |
| 〃 | `FLAG_OFF` | 運営宣言: 対象GASの`ACCESS_ENABLED`はOFF。自動デプロイ有効 |
| 〃 | `FLAG_ON_APPROVED` | 運営宣言: 本番で`ACCESS_ENABLED=true`だが、稼働中のコード更新を**事前承認済み** |
| 〃 | 上記以外 | 安全停止（gateが失敗、デプロイしない） |
| `SWITCHBOT_ACCESS_EXECUTOR_CONFIRMED` | `true` | 上記の有効化に必須。下記3者の同一性を運営が確認済み |

**実行アカウントの同一性**: Webアプリと時間主導トリガーはデプロイ実行者として動き、SwitchBot資格情報・Webhook共有トークンは**実行者のUser Properties**にある。次の3者が同一アカウントであることを有効化前に運営が確認する: ①Actionsのclasp認証主体（`SWITCHBOT_ACCESS_CLASPRC_JSON`の発行アカウント） ②既存Webアプリの「次のユーザーとして実行」（デプロイ者） ③Propertiesを手動設定した者。違えば有効化しない（変数を設定しない）。コードからは他者のUser Propertiesも実行者も確定できないため、この確認は運用ゲートとし、コードは`manifest`の`executeAs`差異と対象ファイルの取り違えを機械的に止める。
**`ACCESS_ENABLED`の読取り**: Script Propertiesの読取りには実行権限・秘密上の制約があり、自動デプロイからは読まない（書き換えも一切しない）。そのため上記変数の宣言と、Environmentの**Required reviewers**（推奨）で、ON状態でのコード更新を人が止められるようにする。`ACCESS_ENABLED`をONにする運用に切り替える時は、先に変数を`FLAG_ON_APPROVED`へ更新するか削除（無効化）する。

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

### 4. 自動デプロイの有効化（先輩・運営の判断後）
上記「段階ゲート」の2変数を設定する。設定した時点から、対象パスのmain pushでデプロイが走る。初回は`workflow_dispatch`（`main`、`rollback_version`空欄）での手動実行を推奨。

### 5. 再デプロイ
mainへマージ（対象パス変更時に自動）、またはActions > "Deploy SwitchBot access GAS" > Run workflow（`main`、`rollback_version`空欄）。
反映確認: Step Summaryの`@旧 → @新`と「デプロイ管理」で同じデプロイ・同じURLであること。**読取り診断（`accessCheckSetup`※設定値は表示されない／`accessAdminStatus`／1回の手動`accessSyncJob`で`FLAG_OFF`／台帳schema・read-only接続）は運営者が別作業・別証跡で行う**。成功前に#754をCloseしない。診断のために`accessInstallTriggers`・createKey/deleteKey等を実行しない。

### 6. ロールバック
1. Actions > "Deploy SwitchBot access GAS" > Run workflow（`main`）で`rollback_version`に**既存の版番号**、`rollback_compat_confirmed`をチェック。チェックは、戻し先の版のコードが現在の本番状態（状態ストア・User/Script Properties・台帳schema・既存キー）と互換であることを運営が確認した証。互換でない旧版へは戻さない。
2. 更新前に、deployと同じ読取りのみの対象照合（`clasp pull`で鍵管理GASであることを確認。Booking／検証／Surveyのプロジェクトなら停止、manifestのwebapp設定の不一致・manifest欠落も停止）を行う。通れば同じ`DEPLOYMENT_ID`を既存版へ`update-deployment -V`で戻すだけ（Deploymentの削除・再作成なし）。状態ストア・Properties・既存キー・Webhook登録は削除／上書きしない。ロールバックを契機にcreateKey/deleteKeyを再送しない。
3. Step Summaryに「更新前の版→戻し先の版」と戻し先の説明（非秘密）、互換性確認の有無、SHAが残る。`clasp push`済みの編集用ソース（HEAD）と公開版は別管理。必要ならmainを`git revert`し、レビュー・CI後に整合させる（revertのマージで再デプロイが走るため、変数を一時的に削除して無効化してから行うこと）。
4. `UNKNOWN_STATE`の時は再実行せず、`list-versions`と「デプロイを管理」で現状を確認してから本手順へ。

### 7. 撤去・運用者交代
撤去: 変数`SWITCHBOT_ACCESS_AUTODEPLOY`を削除（またはworkflowを無効化）→ `docs/switchbot-access-infra-754.md` §11の撤去手順（`ACCESS_ENABLED`を外す→`accessRemoveTriggers`→棚卸し→Webhook解除は別手順）。
運用者交代: 旧実行者の接続済みアプリでclasp権限を取り消す → 新実行者が`clasp login`・Properties再設定・Webアプリ再デプロイ（別証跡）→ **新しいDeployment IDと実行者**で`SWITCHBOT_ACCESS_CLASPRC_JSON`・`SWITCHBOT_ACCESS_DEPLOYMENT_ID`を更新 → 3者同一性を再確認 → 変数を再設定。実行者が変わると`/exec` URLとWebhook登録先が変わり得るため、Webhook再登録は別手順。

## 秘密の扱い
認証ファイルは`$RUNNER_TEMP`に0600で生成し、成功・失敗・中断いずれでもtrapで削除。claspの出力は全てファイルへ退避して表示せず、`set -x`・artifact・cacheは使わない。Step Summaryに出すのは版番号・commit SHA・方式・検証範囲・（ロールバック時の）非秘密の版説明のみ。ID・トークン・パスコード・状態レコードのダンプは出さない。

## 証跡の分離（それぞれ別に記録）
| 区分 | 記録する内容 | 本PR |
|---|---|---|
| Issue・PR・CI | PR番号・head・CI結果 | ✔ |
| 環境準備（GAS・Properties・Secrets・Environment） | 実施判断・日時・結果 | ✘ 未実施 |
| 初回実デプロイ | 実施判断・日時・版・run URL | ✘ 未実施 |
| 初回読取診断（`FLAG_OFF`・台帳schema/read-only） | 日時・版・結果（秘密なし） | ✘ 未実施 |
| 自動化の有効化（変数設定） | 判断・日時 | ✘ 未実施 |
| 鍵の自動発行ON | #756/#757の判断後のみ | ✘ **禁止** |

## テスト
`test/switchbot-access-gas-deploy-768.test.js`: workflowの静的検査（トリガー・パス・Environment分離・ゲート・concurrency・固定clasp・禁止操作の不在）、配布物の完全性、偽claspによる成功／認証失敗／ID不一致／他プロジェクト取り違え／push失敗／更新未反映／`UNKNOWN_STATE`／二重実行／ロールバック（未知版・同一版・互換性未確認）／秘密の非漏えい。実GAS・実APIへは接続しない。
