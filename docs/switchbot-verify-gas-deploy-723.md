# 独立SwitchBot検証GAS 自動デプロイ手順（Issue #723）

`gas/switchbot-verify/` の独立GASを、GitHub Actions + `clasp` で**既存のWebアプリDeploymentのまま**
更新する。`/exec` URLは変わらない。Script Properties・Webhook設定・トリガーには触れない。

- 対象: 独立SwitchBot検証GASのみ。予約GAS・決済・メール・他ブランドとは別のEnvironment／Secrets／workflowを使う。
- 対象外: `createKey` / `deleteKey` / 解錠 / Webhook登録変更 / トリガー作成 / 予約連携。#718の実機操作は引き続き**手動のみ**で、デプロイを契機に実行しない。
- 実装: `.github/workflows/switchbot-verify-gas-deploy.yml` / `scripts/deploy-switchbot-verify-gas.sh` / `scripts/switchbot-verify-gas-deploy-lib.js`

## 動作の概要

| 契機 | 動作 |
| --- | --- |
| PR | `booking-pr-tests.yml` が秘密なしでテストするだけ。デプロイjob・認証情報は使わない（forkも不可） |
| mainへのpush（`gas/switchbot-verify/**`・本デプロイ用ファイルの変更時） | test → deploy |
| `workflow_dispatch`（空欄） | mainのコードを同じ手順で再反映 |
| `workflow_dispatch`（`rollback_version` 指定） | 同じDeploymentを既存の版へ戻す（後述） |

deployジョブの流れ（どこで失敗しても、公開中Deploymentの参照先は「更新」ステップまで変わらない）:

1. 認証JSON形式・必須Secretsの検査（欠落は即失敗）
2. `list-deployments`で`DEPLOYMENT_ID`が**1件だけ**存在し固定版であることを確認。更新前の公開版番号を記録
3. `clasp pull`で対象が独立SwitchBot検証GAS（`SwitchBotVerify.gs`を含み`Booking*`等を含まない）であることを確認
4. manifest検査: `webapp.access/executeAs`がリモートと一致、新しい`oauthScopes`が無いこと（新scopeは手動承認が先）
5. `clasp push --force`（`.gs`と`appsscript.json`のみ）→ **pull し直して内容を照合**（①ソース反映の確認）
6. `clasp update-deployment <DEPLOYMENT_ID> --description "main <SHA>"`（新バージョン作成＋既存Deployment更新。1回だけ実行、再実行しない）
7. `list-deployments`を最大5回読み直し、版番号が増え、説明が`main <SHA>`になったことを確認（②公開版更新の確認）

更新APIが失敗扱いでも、読取り照合で「反映済み」なら成功、「未反映（旧版のまま）」なら失敗（公開版は無変更）、
それ以外は`UNKNOWN_STATE`で失敗し、**成功扱いにも自動再実行にもしない**。

古いrunの上書き防止: runの時点で`origin/main`の`gas/switchbot-verify`がそのrunのSHAと異なる場合は、
新しいrunに任せてスキップする。同一対象のデプロイは`concurrency`で直列化し、実行中のrunはキャンセルしない
（待機は最新の1件に置き換わる）。

## 初回設定（手動）

1. 新規の**独立**GASプロジェクトを作り、`gas/switchbot-verify/` の`.gs`（`SwitchBotVerify.gs`を必須）と`appsscript.json`を貼る
   （#713/#715の手順）。Script Propertiesを設定する。**予約GAS・既存のBooking用プロジェクトは使わない。**
2. 実行ユーザー・アクセス権（現在のmanifest: `executeAs=USER_DEPLOYING` / `access=ANYONE_ANONYMOUS`）で
   「新しいデプロイ」→「ウェブアプリ」を作成し、必要な権限を承認する。このデプロイの`/exec` URLが以後不変。
3. [Apps Script API設定](https://script.google.com/home/usersettings)で「Google Apps Script API」を有効にする。
4. 専用のGoogleアカウント（またはこのGASを編集できる最小権限のアカウント）で `npm i -g @google/clasp@3.4.1` →
   `clasp login`（ユーザー名は`default`のまま）。作成された`~/.clasprc.json`の全文を次項のSecretへ登録する。
5. スクリプトIDは「プロジェクトの設定」、デプロイIDは「デプロイを管理」（URLの`/s/<ID>/exec`の`<ID>`と一致）で確認する。
6. 新しい`oauthScopes`を`appsscript.json`へ追加する場合は、**先に**エディタ上で手動実行して承認する（自動デプロイは検出して停止する）。

### GitHub Environment `switchbot-verify`

**Settings > Environments** で作成し、Deployment branches を`main`のみに限定する（Required reviewers は任意）。
次を**Environment secrets**に登録する（Repository secretsに重複登録しない。他のEnvironmentのSecretsは流用しない）:

| Secret | 内容 | 最小権限 |
| --- | --- | --- |
| `SWITCHBOT_VERIFY_CLASPRC_JSON` | `clasp login`で作った`.clasprc.json`全文 | このGASの編集権限だけを持つアカウント |
| `SWITCHBOT_VERIFY_SCRIPT_ID` | 独立GASのスクリプトID | — |
| `SWITCHBOT_VERIFY_DEPLOYMENT_ID` | 既存WebアプリのデプロイID | — |

更新: 値を差し替えて保存するだけ。漏えい・担当変更時は、Googleアカウントの「接続済みアプリ」でclaspの権限を取り消し、
再`clasp login`して`SWITCHBOT_VERIFY_CLASPRC_JSON`を更新する。SwitchBotのToken/Secret/Webhook共有トークンは
GASのScript Propertiesにのみ置き、GitHubには登録しない。

### 秘密の扱い

認証ファイルは`$RUNNER_TEMP`に0600で生成し、成功・失敗・中断いずれでもtrapで削除する。claspの出力は全てファイルへ
退避して表示せず（pushエラーのみ既存の分類器で固定カテゴリ化）、`set -x`・デバッグ出力・artifact・cacheは使わない。
Step Summaryに出すのは版番号とcommit SHAのみ。Script/Deployment IDの完全値は出さない。

## 運用

- 通常: `gas/switchbot-verify/`の変更をPR → CI → mainマージ。マージ後に自動で反映される。
- 再反映: Actions > "Deploy SwitchBot verify GAS" > Run workflow（ブランチは`main`、`rollback_version`は空欄）。
- 反映確認: Step Summaryの`@旧 → @新`と、Apps Scriptエディタの「デプロイを管理」で同じデプロイ・同じURLであること。
  さらに更新された**読み取り専用**関数（例: `verifyCheckSetup`）をエディタで実行して確認する。
  `verifyCreateTimeLimitKey` / `verifyDeleteKey` 等は**デプロイ確認のために実行しない**。
- 停止: Environment `switchbot-verify`の保護ルールで`main`以外を許可しない／workflowを無効化（Actions > Disable workflow）。

## 失敗時の挙動

| 状況 | 動作 | 公開版 |
| --- | --- | --- |
| Secrets欠落／認証JSON不正 | 更新前に失敗 | 無変更 |
| Deployment ID不在・複数一致・@HEAD | 更新前に失敗（新規作成・推測更新はしない） | 無変更 |
| 対象プロジェクト不一致／manifest差異 | 更新前に失敗 | 無変更 |
| push失敗／ソース照合失敗 | 更新前に失敗（編集用ソースだけ変わり得る） | 無変更 |
| update失敗で旧版のまま | `NOT applied`で失敗 | 無変更 |
| 結果不明（読取り不能・想定外の版） | `UNKNOWN_STATE`で失敗。再実行せずロールバック手順の2〜へ | 要確認 |
| 同時実行 | 直列化。古いrunは新しい公開版を上書きしない | — |

## ロールバック手順

1. 後続の自動デプロイを止める（Actions > Disable workflow）。実行中runがないことを確認する。
2. 失敗runのStep Summaryで「更新前の公開バージョン `@N`」を確認し、Apps Scriptの「デプロイを管理」で
   現在の公開版を秘密を表示せず照合する（`clasp list-versions`で版の存在も確認できる）。
3. **同じDEPLOYMENT_ID**を`@N`へ戻す（Deploymentは削除・再作成しない。URLは不変）。次のどちらか:
   - Actions > "Deploy SwitchBot verify GAS" > Run workflow（`main`）、`rollback_version`に`N`を入力
   - ローカル: `clasp update-deployment <DEPLOYMENT_ID> -V N --description "rollback to vN"`
4. 非破壊の方法で動作確認する（`verifyCheckSetup`等の読み取り専用関数）。Script PropertiesとWebhook設定が
   維持されていることも確認する。
5. `clasp push`済みの編集用ソース（HEAD）と公開バージョンは**別管理**。必要ならmainを`git revert`し、
   レビュー・CI後にソースも整合させる。revertのマージで意図しない再デプロイが走るため、手順1の停止を解除する前に
   内容を確認する。
6. 秘密を含まないrun URL・commit SHA・成否・復旧結果を#723またはPRに記録し、安全確認後に自動デプロイを再開する。

## 完了確認チェックリスト（実環境・手動）

実GASへの反映は実装PRのマージ後にこの手順で確認する。CI成功だけでは完了にしない。

- [ ] mainマージ後、対象変更が独立GASへ反映された（run URL／SHA）
- [ ] ソース反映と公開版更新が別々に成功し、同じ`/exec` URLで新バージョンが公開された
- [ ] 読み取り専用関数がGAS上で実行できた（キー発行・削除は未実行）
- [ ] Secrets欠落・対象不一致・結果不明・同時実行の停止／復旧を確認した
- [ ] 同じDeployment・URLのまま直前の版へ戻せた
- [ ] ログ・Step Summaryに秘密値・認証ファイルが残っていない
- [ ] 予約・決済・本番GAS・他ブランド・既存Webhook設定へ影響がない
