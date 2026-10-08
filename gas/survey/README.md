# 利用・市場調査アンケート（Issue #374）

Studio Nagoya Base の利用・市場調査アンケート（匿名）と管理者画面。Google Spreadsheet をデータストアに、
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

設問文・選択肢・条件分岐はJSONの1か所だけです。ブラウザは `survey-schema.json` を読み、GASへは
`prepare-survey-gas-project.js` が同じJSONを `SurveySchema.gs` として埋め込みます（コミットしない生成物）。
`responses` の列もschemaから生成され、ヘッダがschemaと異なるシートへは書き込みません。

> **schemaを変更したら** `survey/survey-schema.json` の `version` を上げ、公開・管理者の両GASを再デプロイしてください。
> クライアントとGASの版が違うと、サーバーは `SCHEMA_VERSION_MISMATCH` で保存を拒否します。
> 列が増減した場合は、`responses` / `events` シートの旧ヘッダとの不一致で書き込みが止まるため、
> 旧シートを退避してから `setupSurveySpreadsheet()` を実行してください。

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

## 公開Web Appのデプロイ（アンケート回答の受け口）

1. 新規GASプロジェクトへ `.gas-deploy/survey-public/` の全ファイル（`appsscript.json` を含む）を配置。
2. 「デプロイ → 新しいデプロイ → ウェブアプリ」
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員（匿名ユーザーを含む）**（Xアプリ内ブラウザでGoogleログインを出さないため必須）
3. 発行された `/exec` URL を `scripts/survey-config.js` の `BASE_URL` に設定してmain へ反映。
4. 配布チャネルを確定し、流入元は `https://nagoya-base.github.io/Studio-nagoya-base/survey/?src=<英数字・-・_ 32文字まで>` で識別
   （`survey_path` 列に保存。例: `?src=x_snb`）。

## 管理者Web Appのデプロイ

1. 別のGASプロジェクトへ `.gas-deploy/survey-admin/` の全ファイルを配置。
2. 「デプロイ → ウェブアプリ」
   - 次のユーザーとして実行: **ウェブアプリケーションにアクセスしているユーザー**
   - アクセスできるユーザー: **自分のみ**
   - 回答Spreadsheetを閲覧できるアカウントでアクセスし、`SURVEY_ADMIN_EMAILS` に同アカウントを登録。
3. 管理画面は集計結果だけを返します（個別回答行・`respondent_hash`・日時は返さない。自由記述は日付単位）。

## テスト

```sh
npm test                              # 全体（survey-*.test.js が本機能）
node --test test/survey-*.test.js     # アンケートのみ
```

GASコードは `prepare-survey-gas-project.js` が出力する配布物をそのままvmで実行して検証しています。

### 実機確認チェックリスト（デプロイ後に実施）

- [ ] iOS の X アプリ内ブラウザで `survey/` を開き、最後まで回答・送信できる
- [ ] Android の X アプリ内ブラウザで同上
- [ ] 公開Web Appの `/exec` をシークレットウィンドウ（未ログイン）で開いても、ログイン要求が出ず JSON が返る
- [ ] 管理者Web Appを許可外アカウント／未ログインで開くとアクセス拒否になる
- [ ] 送信後、`responses` に1行・`events` に各ステップ到達が記録される
