# Booking GAS 本番デプロイ手順

GitHub `main`を唯一のソースとして、既存のBooking GASプロジェクトと既存デプロイを
`clasp`で更新する。新しいGASプロジェクトや新しいデプロイは作成しない。

対象は次の2プロジェクトで、1回のworkflow実行（承認1回）で`Bookingsシートのschema
migration → Admin → Public → post-check`を同一jobで順に実行する（Issue #671）。
正規手順は[`gas/booking/README.md`](../gas/booking/README.md)冒頭に記載する。

- `public`: Booking Web App（利用者向け。既存`/exec` URLを維持）
- `admin`: Booking Admin（既存のコンテナバインドGAS／既存デプロイ）

Admin配布物には`.gs`許可リストに加え、Web UIのエントリポイントである
`BookingAdminPage.html`を必ず含める。これは`BookingAdminWeb.gs`の
`HtmlService.createHtmlOutputFromFile('BookingAdminPage')`が参照する必須ファイルである。

ワークフローはGASコードと`appsscript.json`だけを更新する。公開Web Appのmanifestは
mainの`gas/booking/public/appsscript.json`を正とし、コンテナ固有設定を持つBooking Adminの
manifestは既存プロジェクトから取得して維持する。ただしBooking AdminはStripe API
（`UrlFetchApp`）を呼ぶため、`oauthScopes`に
`https://www.googleapis.com/auth/script.external_request`が必須である。欠けていると
`processPendingStripeWebhookEvents`のCheckout Session再取得が`errorType=NETWORK`で失敗し、
予約が`checkout_pending`／`pending`のまま止まる（Issue #404）。デプロイ時に
`scripts/prepare-booking-gas-project.js`が不足分だけを末尾へ追記し（既存scopeや他項目は
変更しない）、既存manifestに`oauthScopes`配列自体が無い場合は自動検出scopeを失わないよう
明示的に失敗させる。新scopeの追加後は、Apps Scriptエディタで一度関数を実行して再認可する。Script Properties、
トリガー、Calendar、Spreadsheet、予約実データを読み書きする処理は含まない。

## 初回設定: Google認証

以下は、両方の既存GASプロジェクトを編集できるGoogleアカウントで一度だけ行う。

1. [Apps Script API設定](https://script.google.com/home/usersettings)で
   「Google Apps Script API」を有効にする。
2. Node.js 22をインストールし、`npm install --global @google/clasp@3.4.1`を実行する。
3. `clasp login`を実行し、上記Googleアカウントで認可する。
4. 作成された`~/.clasprc.json`（Windowsでは通常`$HOME\.clasprc.json`）の内容を、
   後述のGitHub Environment secret `CLASPRC_JSON`へそのまま登録する。

`.clasprc.json`には更新権限を持つrefresh tokenが含まれる。リポジトリ、Issue、PR、
チャットへ貼らない。漏えい時や担当変更時はGoogleアカウントの接続済みアプリから
claspの権限を取り消し、再認証してsecretを更新する。

## 初回設定: 既存IDの確認

新規作成は行わず、Apps Script画面から既存IDを取得する。

1. Booking Web Appの既存プロジェクトを開く。
2. 「プロジェクトの設定」からスクリプトIDをコピーする。
3. 「デプロイを管理」で、現在の本番`/exec` URLに対応するデプロイを開き、
   デプロイIDをコピーする。URL中の`/s/<ID>/exec`の`<ID>`とも一致することを確認する。
4. Booking Adminの既存コンテナバインドプロジェクトでも、同様にスクリプトIDと
   現在使用中のデプロイIDを取得する。

## 初回設定: GitHub EnvironmentとSecrets

リポジトリの **Settings > Environments** で`booking-production`を作成する。

Deployment protection rulesで次を設定する。

- Required reviewersに本番承認者を1名以上指定する
- 可能ならPrevent self-reviewを有効にする
- Deployment branches and tagsはSelected branches and tagsとし、`main`だけを許可する

`booking-production`のEnvironment secretsへ以下を登録する。Repository secretsには
重複登録しない。

| Secret | 値 |
| --- | --- |
| `CLASPRC_JSON` | `clasp login`で作成された`.clasprc.json`全文 |
| `BOOKING_PUBLIC_SCRIPT_ID` | 既存Booking Web AppのスクリプトID |
| `BOOKING_PUBLIC_DEPLOYMENT_ID` | 現在の本番`/exec`に対応する既存デプロイID |
| `BOOKING_ADMIN_SCRIPT_ID` | 既存Booking AdminのスクリプトID |
| `BOOKING_ADMIN_DEPLOYMENT_ID` | 既存Booking Adminの既存デプロイID |
| `BOOKING_SHEETS_SERVICE_ACCOUNT_JSON` | Bookings schema migration専用サービスアカウントのJSON鍵（下記） |
| `BOOKING_SPREADSHEET_ID` | 本番Bookings台帳のSpreadsheet ID |
| `BOOKING_SPREADSHEET_ID_SHA256` | 本番GASのScript Property `SPREADSHEET_ID` から求めた指紋（下記） |

## 初回設定: Bookings schema migration用のSheets API認証（Issue #671）

migrationは、clasp認証とは**別の**専用サービスアカウントで行う。Booking GASの通常実行認証とは混用しない。

1. 専用のGoogle Cloudプロジェクトで「Google Sheets API」を有効にし、サービスアカウントを作成してJSON鍵を発行する。
2. 本番Bookings台帳のSpreadsheetを、そのサービスアカウントのメールアドレスへ**編集者**として共有する（このSpreadsheetだけ。他のファイルは共有しない）。
3. JSON鍵全文を`BOOKING_SHEETS_SERVICE_ACCOUNT_JSON`、Spreadsheet IDを`BOOKING_SPREADSHEET_ID`として、`booking-production`のEnvironment secretsへ登録する。
4. **対象取り違え防止の指紋を登録する（必須）**。migration対象が本番GASの実台帳と同一であることを、別経路の2値の照合で担保する。
   - `BOOKING_SPREADSHEET_ID` は、本番Bookings台帳のSpreadsheetのURL（`/d/<ID>/`）から取得して登録する。
   - 指紋は、**Booking Web App / Admin のApps Script「プロジェクトの設定 > スクリプト プロパティ」の `SPREADSHEET_ID` の値**から求める。ローカルで
     `read -rs ID; printf %s "$ID" | node scripts/booking-spreadsheet-fingerprint.js`
     を実行し、出力された64桁の16進を `BOOKING_SPREADSHEET_ID_SHA256` として登録する（IDは標準入力で渡すため履歴・引数に残らない）。
   - workflowは毎回、`BOOKING_SPREADSHEET_ID` のSHA-256が `BOOKING_SPREADSHEET_ID_SHA256` と一致しなければ、Sheets APIへ接続する前に停止する。Script Propertyを変更した場合は指紋も更新する。
5. 鍵・Spreadsheet IDをリポジトリ・Issue・PR・チャット・ログへ出さない。漏えい時は鍵を無効化して再発行し、secretを更新する。

指紋が未設定・不一致の間はmigrationもpost-checkも `SPREADSHEET_FINGERPRINT_MISMATCH` で停止し、何も更新されない。

サービスアカウント鍵は台帳（予約者情報を含む）の編集権限を持つため、担当変更時・漏えい疑い時・定期（目安: 年1回）にローテーションする（新しい鍵を発行 → secret更新 → 旧鍵を無効化）。組織ポリシーでサービスアカウント鍵の発行が禁止されている場合は、Workload Identity連携への置き換えを別Issueで検討する（それまでは本workflowのmigration stepで止まり、デプロイされない）。

migrationが読み書きするのは`Bookings`シートの1行目（ヘッダー）だけで、予約行は読まない。

## 本番反映の実行方法

上記初回設定を完了した後にのみ実行する。

1. GitHubの **Actions > Deploy Booking GAS to production > Run workflow** を開く。
2. Branchは`main`を選ぶ（`target`の選択はない）。
3. テスト成功後、`booking-production`の承認待ちになる。対象SHAを確認して**1回だけ**承認する。
4. 承認後、同一job内で次を順に実行する。失敗した時点で後続は実行しない。
   `Bookings schema migration → Booking Admin更新 → Booking Web App更新 → post-check`
5. 全step成功を確認する。Admin成功・Web App失敗の場合はworkflowが失敗し、Adminだけ新mainである旨が
   ログに出る。原因を解消して同じworkflowを再実行する（自動rollbackはない）。

ワークフローは指定したデプロイIDが対象プロジェクトに実在することを先に確認する。
一致しない場合はGASコードをpushする前に停止する。デプロイ時は既存IDを必須引数にした
`clasp update-deployment`だけを使い、新規デプロイ作成コマンドは実行しない。
clasp部分は`scripts/deploy-booking-gas-target.sh`（`admin`/`public`、第2引数`verify`で更新なしの確認）。

post-checkは、両既存DeploymentのIDが存在しdescriptionに今回のmain SHAが出ていること、
`Bookings`ヘッダーが正本（`gas/booking/shared/BookingsSchema.gs`）と完全一致することを確認する。
`list-deployments`の出力そのものはログへ出さない。本番予約作成・Stripe決済・実メール送信を伴う
smoke testは行わない（Web Appのhealth確認は専用URL secretを増やさないため自動化していない）。

## 初回本番反映後の確認

- 公開Booking Web Appの`/exec` URLが変更されていないこと
- `getAvailability`の安全な読み取りsmoke testが成功すること
- Booking Adminへ管理者本人だけがアクセスできること
- Script Propertiesと既存トリガーが従来どおりであること
- 実予約、Calendarイベント、Bookings/Recoveryシートを変更していないこと

実予約を作成する`createBooking`の正常系テストは、専用テスト日時と後処理の合意がある
別作業として行う。このワークフローの初回実行と同時には行わない。

## list-deployments失敗時の診断と復旧（Issue #400）

更新前・更新後ともstdout/stderrは権限を制限した一時ファイルへ保存し、終了時に
認証ファイルとともに削除する。Actionsへは固定カテゴリだけを出力する。
生ログの表示・artifact化・Issue/PRへの貼り付けは行わない。

| カテゴリ | 確認・対応 |
| --- | --- |
| `AUTHENTICATION_FAILED` | OAuth期限切れ・失効・invalid_grant等。下記の再認証を行う |
| `ACCESS_DENIED` | 選択アカウントの編集権限・OAuth scope・API設定を確認する |
| `SCRIPT_NOT_FOUND_OR_INACCESSIBLE` | 対象GASと既存Script ID・アカウントのアクセスを確認する。404だけではID誤りと権限による不可視を断定できない |
| `CLASP_CREDENTIAL_OR_USER_MISMATCH` | credential形式と選択userを確認する。Adminはdefault、Publicはbooking-owner |
| `TRANSIENT_API_OR_NETWORK_ERROR` | API障害・ネットワーク・quotaを確認して時間を置いて再実行する |
| `UNCLASSIFIED` | 原因未確定。承認された管理者のローカル環境で確認し、秘密情報を共有しない |

Adminで認証切れと判明した場合は、Admin GASを編集できる正しいGoogleアカウントで、
管理者のローカルPCから`@google/clasp@3.4.1`の`clasp login`をやり直す。
生成された最新`~/.clasprc.json`全文を、GitHubの
**Settings > Environments > booking-production > Environment secrets > CLASPRC_JSON**
へ直接登録する。認証情報をコード・ログ・チャットへ保存しない。
Public専用の`BOOKING_PUBLIC_CLASPRC_JSON`は変更しない。

診断改善PRのマージ前は本番実行しない。マージ後、最新mainを選びtarget=`admin`で
実行し、Environment承認後のカテゴリを確認する。必要な復旧後に同じ手順で再実行し、
list-deployments → pull → push --force → update-deployment → 更新後検証の成功を確認する。
既存Deploymentを再作成せず、`STRIPE_CHECKOUT_ENABLED`も変更しない。
実行URL・対象main SHA・カテゴリまたは成功結果を記録し、PR #399を含むmainの反映を確認する。

最後に管理者が旧Payment Link方式の対象カード予約を開き、Stripe Payment Link URL入力欄と
「決済リンクを送信」ボタンの表示を確認する。メール送信はこの表示確認には不要。
表示されない場合はIssue #398を完了扱いにせず、デプロイ世代と予約データを再確認する。
本番再実行・実原因・反映・表示確認は、マージ前の自動テストでは検証できないため別途記録する。
