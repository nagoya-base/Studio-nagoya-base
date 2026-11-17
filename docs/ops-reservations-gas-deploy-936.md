# 運営アプリ（予約確認）専用GAS：Actions手動デプロイ（Issue #936）

所有者が **Actions → 「Deploy ops reservations GAS」→ Run workflow** を押すだけで、mainの版を専用GASへ反映する。毎回のGAS手貼りは不要。**利用URLは変わらない**（同じDeploymentを更新する）。
実装: `.github/workflows/ops-reservations-gas-deploy.yml` / `scripts/deploy-ops-reservations-gas.sh` / `scripts/ops-reservations-gas-deploy-lib.js` / `scripts/prepare-ops-reservations-gas-project.js` / テスト `test/ops-reservations-gas-deploy.test.js`。
鍵管理GASの `docs/switchbot-access-gas-deploy-768.md` を参考にした**別実装**。多段承認や汎用基盤は持ち込まない。

## 通常更新（毎回）

1. Actions → **Deploy ops reservations GAS** → **Run workflow**。Branch は `main` のまま、**入力は空欄のまま**実行。
2. 実行ページの Summary を見る。成功なら次が表示される: 反映したmain SHA／公開版 `@旧 → @新`／処理日時（JST・UTC）／「URLは変わらない」。
3. スマホで（初回に控えた同じURLを）開き、一覧・詳細が出ることを確認。**Summaryの成功は機械的な更新成功で、画面の実利用確認とは別。**

処理の順序: main限定・手動のみのゲート → フロント生成物（`OpsPage.html`）が正本と一致 → 運営アプリのテスト → 配布物検査（ここまで秘密なし）→ 対象確認 → push → 反映照合 → 既存Deploymentを新版へ更新 → 同じDeployment IDの版・説明を読み直して照合。**PRブランチからは反映しない**（mainと異なるSHA・古いrunは停止/スキップ）。同時実行は1本に直列化。

### 守られること（テストで固定）

- 更新対象は専用GAS 1つ。**運営アプリのファイルを持つこと、予約・決済・鍵・Surveyのファイルを持たないこと**を書込み前に確認。違えば何も書かずに停止。
- Script ID／Deployment ID／認証が未設定・不一致・権限不足なら**書込み前に停止**。プロジェクトやDeploymentを**新規作成しない**。
- 既存の専用Deploymentを更新するので、**URLは作り直さない**。「自分のみ」「実行者=デプロイ者」と読み取り専用scopeは配布物のmanifestで検査し、変わるなら停止。
- Script Properties（`OPS_OWNER_EMAIL`・台帳ID）・トリガーは**触らない**。予約・決済・鍵・メールの処理は起動しない。
- 認証JSON・Script/Deployment ID・実予約情報・URLは、ログ・Summary・成果物に出さない（GitHubのマスクに加え、出力は固定メッセージと版番号のみ）。

## 初回だけ（一度きりの設定）

1. **専用GASを新規作成**（script.google.com。名前例「運営アプリ（予約確認）」）。**既存の予約・決済・鍵のGASは使わない**。中身は空（既定の `Code.gs`）のままでよい。
2. そのプロジェクトで **デプロイ → 新しいデプロイ → ウェブアプリ**（実行ユーザー=自分、アクセスできるユーザー=**自分のみ**）。これで版1が作られ、**Deployment ID**（`AKfycb…`）と利用URLが出る。**利用URLはここで控えてブックマーク**（以後ずっと同じ）。
3. **Script Properties** に `OPS_OWNER_EMAIL`（所有者のメール）と `OPS_SPREADSHEET_ID`（Bookingsの台帳ID）を設定（docs/ops-reservations-936.md §4。公開の場に書かない）。以後、通常更新では上書きされない。
4. **clasp認証**: 自分のPCで `npx @google/clasp@3.4.1 login` を実行し、できた認証ファイル（`~/.clasprc.json`）の中身を次のSecretに貼る。事前に [Apps Script API](https://script.google.com/home/usersettings) を有効化。
5. GitHub → Settings → **Environments** → `ops-reservations-production` を作成（Deployment branches は `main` のみを推奨）。Environment secrets に3件:
   - `OPS_RESERVATIONS_CLASPRC_JSON`（手順4の認証ファイルの中身）
   - `OPS_RESERVATIONS_SCRIPT_ID`（このプロジェクトのスクリプトID）
   - `OPS_RESERVATIONS_DEPLOYMENT_ID`（手順2のDeployment ID）
6. **Run workflow** を1回実行（空のプロジェクトへの初回配置になり、Summaryに「初回配置」と出る）。
7. **所有者本人が利用URLを一度開き、Googleの承認画面で権限（読み取り専用）を許可**する。スマホで一覧・詳細を確認。

この初回設定が済むまで、workflowは「初回設定が未完了」で書込み前に停止する（失敗しても何も変更しない）。

## 復旧（直前の版へ戻す）

1. Actions → 同じworkflow → Run workflow で **`rollback_version`** に戻したい既存の版番号を入れる（直前の版は、失敗した/不具合の出た更新のSummaryにある `@旧 → @新` の旧）。
2. 同じDeploymentがその版へ戻る（コードは再pushしない）。URLは同じ。Summaryで `@新 → @戻し先` を確認。

通常更新で `UNKNOWN_STATE` と出たら、成功扱いにも再実行にもせず、上の復旧で戻す。Script PropertiesはGAS側に残る。

## 停止

Apps Scriptの **デプロイを管理 → アーカイブ**でURLが即時に無効になる（完全撤去はプロジェクト削除）。Environment secretsを削除するとworkflowは書込み前に停止する。台帳は読み取りのみで影響しない。

## 報告上の区別

コードのマージ／初回設定／Run workflowの成功／スマホでの実利用確認は**別々に報告**する。このPRのマージだけでは利用開始とは扱わない。
