# サービス改善フィードバック（Issue #374）

Studio Nagoya Base のサービス改善フィードバック（匿名）と管理者画面。Google Spreadsheet をデータストアに、
Google Apps Script（GAS）の **公開Web App** と **管理者Web App** の2プロジェクトで動かします。
予約システム（`gas/booking/`）とはプロジェクト・グローバル関数とも完全に分離しています。

## 構成

| 役割 | 場所 |
| --- | --- |
| **設問定義の正本（JSON）** | `survey/survey-schema.json`（設問文・選択肢・必須/任意・表示条件・排他・再コード・ファネル・クロス集計・ダッシュボード項目） |
| 回答画面（GitHub Pages） | `survey/index.html` / `scripts/survey-app.js` / `scripts/survey-config.js` / `styles/survey.css` |
| 共通コア（ブラウザ＝GAS同一ファイル） | `scripts/survey-core.js`（表示条件評価・正規化・検証・列生成） |
| 集計ロジック | `scripts/survey-analytics.js`（管理者Web Appが利用） |
| 公開Web App | `gas/survey/public/SurveyWebApp.gs` |
| 管理者Web App | `gas/survey/admin/SurveyAdmin.gs` / `SurveyAdminPage.html` |
| Spreadsheet入出力（共有） | `gas/survey/shared/SurveyRepository.gs` |
| 配布物の組み立て | `scripts/prepare-survey-gas-project.js` |
| 本番GAS更新 | `.github/workflows/survey-gas-production.yml` |

設問文・選択肢・条件分岐はJSONの1か所だけです。ブラウザは `survey-schema.json` を読み、GASへは
`prepare-survey-gas-project.js` が同じJSONを `SurveySchema.gs` として埋め込みます（コミットしない生成物）。
`responses` の列もschemaから生成され、ヘッダがschemaと異なるシートへは書き込みません。

> **schemaを変更したら** `survey/survey-schema.json` の `version` を上げ、公開・管理者の両GASを再デプロイしてください。
> クライアントとGASの版が違うと、サーバーは `SCHEMA_VERSION_MISMATCH` で保存を拒否します。
> 末尾の `is_test` 以外で列が増減した場合は、`responses` / `events` シートの旧ヘッダとの不一致で書き込みが止まるため、
> 旧シートを退避してから `setupSurveySpreadsheet()` を実行してください。

## 重複回答防止と `?test=1` テストモード（Issue #381）

匿名性を保つため、厳密な「1人1回答」ではなく **「同一ブラウザ環境で1回答」** を実装しています
（別端末・別ブラウザ・シークレットモード等は防げません。氏名・メール・IP・フィンガープリントは使いません）。

| 項目 | 内容 |
| --- | --- |
| respondent_id | 初回表示時に `crypto.randomUUID()`（無ければフォールバック）で生成し、`localStorage`（`studio_nagoya_base_survey_respondent_id_v1`）へ保存。既存の `respondent_hash` をそのまま再利用（二重管理なし） |
| 重複判定（正） | GAS側。`responses` の**本番行**（`is_test` が 1 でない行）に同じ `respondent_hash` があれば保存せず `DUPLICATE_RESPONSE`。既存行は上書きしない |
| 完了フラグ | 送信成功時に `studio_nagoya_base_survey_completed_v1=1`。回答済み画面を先出しするUX用で、localStorageを消されてもサーバー判定で止まる |
| テストモード | URLが厳密に `?test=1` のときだけ。上部に `TEST MODE：この回答は本番集計に含まれません` を常時表示。重複判定・完了フラグを無視し、`is_test=1` で送信（`events` も同様） |
| 検証 | テストモードでも年齢制限・必須・選択肢・hidden値破棄・rate limit・schema版は通常どおり。`is_test` は認証ではない |

- 使い方: `/survey/?test=1`（`test=true` 等は通常モード）。テスト送信は完了フラグを立てないため、同じブラウザで続けて通常回答もできます。
- 除外: `is_test=1` の回答・イベントは、`SurveyAnalytics.buildDashboard`（件数・分布・ファネル・クロス集計・WTP・セグメント比較・日別・自由記述・step reach）の入口で除外します。Spreadsheet上には残り、`is_test` 列で識別できます。
- 既存Spreadsheetの移行: `responses` / `events` の**末尾**に `is_test` 列を追加しました。旧ヘッダ（`is_test` 無し）のシートは、新規回答の保存時（または `setupSurveySpreadsheet()`）にヘッダ行へ列名が追記されるだけで、既存行は変更されません。既存行の空欄は本番（0相当）として扱います。末尾以外のヘッダ不一致は従来どおり `SCHEMA_MISMATCH` で保存を止めます。
- 旧 `duplicate:true` 応答は廃止しました（同一IDの再送は `DUPLICATE_RESPONSE`）。公開GASとGitHub Pagesの両方をデプロイしてください。

## 初期設定

1. 空のGoogle Spreadsheetを作成（回答データ用）。IDを控える（**Gitへは書かない**）。
2. 配布物を組み立てる（`.gas-deploy/` は `.gitignore` 済み）:

   ```sh
   node scripts/prepare-survey-gas-project.js public .gas-deploy/survey-public
   node scripts/prepare-survey-gas-project.js admin  .gas-deploy/survey-admin
   ```

3. Script Properties（値はここに書かない。各プロジェクトの「プロジェクトの設定」で登録）:

   | プロジェクト | キー | 内容 |
   | --- | --- | --- |
   | 公開・管理者 共通 | `SURVEY_SPREADSHEET_ID` | 回答Spreadsheetの ID |
   | 公開 | `SURVEY_RATE_LIMIT_PER_MINUTE` | 任意。1分あたりの受付上限（既定 120） |
   | 管理者 | `SURVEY_ADMIN_EMAILS` | 閲覧を許可するGoogleアカウント（カンマ区切り）。未設定だと全員拒否 |

4. いずれかのプロジェクトのエディタから `setupSurveySpreadsheet()` を1回実行
   （`responses` / `events` / `questions` / `settings` シートを作成。冪等）。

## 初回のGAS Web App作成

GitHub Actions は **既存のGASプロジェクト／既存のWeb Appデプロイを更新する** 方式です。
そのため、公開用・管理者用とも最初の1回だけGASプロジェクトとWeb Appデプロイを作成し、
Script ID / Deployment ID をGitHub Secretsへ登録します。

### 公開Web App

1. 新規GASプロジェクトへ `.gas-deploy/survey-public/` の全ファイル（`appsscript.json` を含む）を配置。
2. 「デプロイ → 新しいデプロイ → ウェブアプリ」
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員（匿名ユーザーを含む）**
3. Script ID と Web App Deployment ID を控える。
4. 発行された `/exec` URL を `scripts/survey-config.js` の `BASE_URL` に設定してmainへ反映。

### 管理者Web App

1. 別のGASプロジェクトへ `.gas-deploy/survey-admin/` の全ファイルを配置。
2. 「デプロイ → 新しいデプロイ → ウェブアプリ」
   - 次のユーザーとして実行: **ウェブアプリケーションにアクセスしているユーザー**
   - アクセスできるユーザー: **自分のみ**
3. Script ID と Web App Deployment ID を控える。
4. 回答Spreadsheetを閲覧できるアカウントを `SURVEY_ADMIN_EMAILS` に登録する。

管理画面は集計結果だけを返します（個別回答行・`respondent_hash`・日時は返さない。自由記述は日付単位）。

## GitHub Actionsで本番GASを更新

Workflow: **Actions → Deploy Survey GAS to production**

`main` のコードだけをデプロイします。`public` / `admin` を選択して実行すると、アンケート用テストを通した後、
対象GASプロジェクトへ `clasp push --force` を行い、指定済みの既存Deployment IDを `clasp update-deployment` で更新します。
Deployment IDが対象Script IDに属していない場合は更新せず失敗します。

### GitHub Secrets

Environment `survey-production`（またはrepository secrets）に以下を設定します。
値はGitへコミットしないでください。

| Secret | 内容 |
| --- | --- |
| `CLASPRC_JSON` | `clasp login` で生成された `.clasprc.json` 全文 |
| `SURVEY_PUBLIC_SCRIPT_ID` | 公開アンケートGASのScript ID |
| `SURVEY_PUBLIC_DEPLOYMENT_ID` | 公開アンケートWeb AppのDeployment ID |
| `SURVEY_ADMIN_SCRIPT_ID` | 管理者GASのScript ID |
| `SURVEY_ADMIN_DEPLOYMENT_ID` | 管理者Web AppのDeployment ID |

`.clasprc.json` はGASプロジェクトにアクセスできるGoogleアカウントで取得します。チャットやIssueへ貼らず、GitHub Secretとしてのみ保存します。

### 実行手順

1. PRをmainへマージする。
2. GitHubの **Actions → Deploy Survey GAS to production → Run workflow** を開く。
3. Branchは `main` を選択する。
4. `target` で `public` または `admin` を選んで実行する。
5. schemaや共通ロジックを変更した場合は、**public / adminの両方**を順に更新する。

workflowはScript IDとDeployment IDをログへ出力せず、`clasp push` の生エラーもそのまま出力しません。

## 流入元

配布チャネルは `https://nagoya-base.github.io/Studio-nagoya-base/survey/?src=<英数字・-・_ 32文字まで>` で識別します
（`survey_path` 列に保存。例: `?src=x_snb`）。

## テスト

```sh
npm test                              # 全体（survey-*.test.js が本機能）
node --test test/survey-*.test.js     # アンケートのみ
```

GASコードは `prepare-survey-gas-project.js` が出力する配布物をそのままvmで実行して検証しています。
GitHub Actions本番更新では既知の予約系テスト失敗に巻き込まれないよう、`test/survey-*.test.js` のみをゲートにします。

### 実機確認チェックリスト（デプロイ後に実施）

- [ ] iOS の X アプリ内ブラウザで `survey/` を開き、最後まで回答・送信できる
- [ ] Android の X アプリ内ブラウザで同上
- [ ] 公開Web Appの `/exec` をシークレットウィンドウ（未ログイン）で開いても、ログイン要求が出ず JSON が返る
- [ ] 管理者Web Appを許可外アカウント／未ログインで開くとアクセス拒否になる
- [ ] 送信後、`responses` に1行・`events` に各ステップ到達が記録される
