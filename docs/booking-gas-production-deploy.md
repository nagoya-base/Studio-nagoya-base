# Booking GAS 本番デプロイ手順

GitHub `main`を唯一のソースとして、既存のBooking GASプロジェクトと既存デプロイを
`clasp`で更新する。新しいGASプロジェクトや新しいデプロイは作成しない。

対象は次の2プロジェクトで、通常は1回のworkflow実行（承認1回）で`Admin → Public →
post-check`を同一jobで順に実行する（`scope=full`）。Bookings schema変更時だけ、
`scope=admin-only` → 管理者がApps Scriptエディタで`migrateBookingsSchema`を実行 →
`scope=full`＋`schema_migrated=true`の二段階にする（Issue #673。承認は2回）。
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

## Bookings schema migration（Issue #673）

Bookings schema migrationはGitHub Actionsから行わない。Sheets API用のサービスアカウントJSON鍵・
Spreadsheet ID Secret・WIF/OIDCは使わず、`booking-production`に登録するSecretも増やさない。
管理者がBooking AdminのApps Scriptエディタで`migrateBookingsSchema`
（`gas/booking/admin/BookingsSchemaMigration.gs`）を明示実行し、`Bookings`の不足している末尾列だけを追加する。
関数の安全条件・手順は[`gas/booking/README.md`](../gas/booking/README.md)冒頭を参照。

## 本番反映の実行方法

上記初回設定を完了した後にのみ実行する。

### 通常時（Bookings schema変更なし）

1. GitHubの **Actions > Deploy Booking GAS to production > Run workflow** を開く。
2. Branchは`main`、`scope=full`（既定）を選ぶ。`schema_migrated`は指定しない。
3. テスト成功後、`booking-production`の承認待ちになる。対象SHAを確認して**1回だけ**承認する。
4. 承認後、同一job内で`schema差分ガード → Booking Admin → Booking Web App → post-check`を順に実行する。
   失敗した時点で後続は実行しない。Admin成功・Web App失敗の場合はworkflowが失敗し、Adminだけ新mainである旨が
   ログに出る。原因を解消して同じworkflowを再実行する（自動rollbackはない）。

### Bookings schema変更時・初回bootstrap

1. schema変更を含むPRを`main`へマージする。
2. `scope=admin-only`で起動し、`booking-production`を承認する（1回目）。Booking Adminだけを更新して停止する。
3. Apps Scriptエディタ（Booking Admin）で`migrateBookingsSchema`を1回実行し、成功ログ
   （`BOOKINGS_SCHEMA_MIGRATION_OK` / `BOOKINGS_SCHEMA_ALREADY_CURRENT`）を確認する。
4. `scope=full`、`schema_migrated=true`で起動し、`booking-production`を承認する（2回目）。
5. Booking Admin → Booking Web App → post-checkの成功を確認する。

エディタへのコード手動コピーは行わない。既存Deployment / Script IDは作り直さない。

### schema差分ガード

`scope=full`では、承認後・Admin更新前に、Booking Web App（Public）の既存Deployment descriptionの
`main <SHA>`（前回full反映のSHA。Adminは基準にしない）と今回のSHAとの間で
`gas/booking/shared/BookingsSchema.gs`の差分を判定する。差分がある（前回SHAにファイルが無い初回bootstrapを含む）
場合は`schema_migrated=true`がなければAdmin更新前に停止する。前回SHAを特定できない場合も停止する。
そのため`actions/checkout`は`fetch-depth: 0`で全履歴を取得する。

ワークフローは指定したデプロイIDが対象プロジェクトに実在することを先に確認する。
一致しない場合はGASコードをpushする前に停止する。デプロイ時は既存IDを必須引数にした
`clasp update-deployment`だけを使い、新規デプロイ作成コマンドは実行しない。
clasp部分は`scripts/deploy-booking-gas-target.sh`（`admin`/`public`、第2引数`verify`で更新なしの確認）。

`update-deployment`成功後は更新済みmarkerを残し、descriptionへの今回SHAの反映を最大5回確認する。
対象IDが一意に存在してSHAがまだ一致しない場合だけ5秒待機する（待機は最大4回、合計20秒）。
この間にpushやupdate-deploymentは再実行しない。最終回まで不一致なら失敗とする。
対象IDが消えた・一意に確認できない場合や一覧取得のAPIエラーは即時停止し、APIエラーは既存の固定カテゴリで示す。
`verify`は従来どおり更新も待機もせず、1回の読み取りでIDの一意性と今回SHAを確認する。

post-checkは、既存DeploymentのID（`full`はAdminとPublic、`admin-only`はAdminのみ）が存在し
descriptionに今回のmain SHAが出ていることを確認する（`Bookings`ヘッダーの照合は行わない。
migrationは管理者が`migrateBookingsSchema`で実行し、差分ガードが実行漏れを防ぐ）。
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
