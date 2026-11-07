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

## 開始前の確認（運営向け）

> 全対象（Booking／Webhook／Survey／SwitchBot）の通常更新・失敗時・承認の流れは、[運営者向け一画面ガイド](gas-operator-one-screen-817.md)にまとめています。

本番の更新は、GitHubの画面から始めます。**更新が始まる前に**、必要な接続情報と更新対象の設定がそろっているかを
自動でまとめて確認し、問題があれば**何も更新せずに止まります**。途中まで更新して止まることを減らすための仕組みです。

### 最初にしておく設定（一度だけ。担当交代・接続切れのときは再設定）

1. 更新に使うGoogleアカウントの接続情報を、GitHubに登録します。
   Googleへのログインと権限の許可は、この登録の前に**パソコンで行います**（下の「初回設定: Google認証」）。
   更新の実行中にブラウザでGoogleログインや権限の同意をする画面は出ません。
2. 更新する対象（Booking Web App／Booking Admin）の設定値を、GitHubの **Settings > Environments > `booking-production`** に登録します
   （下の「初回設定: 既存IDの確認」「初回設定: GitHub EnvironmentとSecrets」）。値そのものをチャット・Issue・PRに貼らないでください。

### 使い始めるとき

1. GitHubの **Actions > Deploy Booking GAS to production > Run workflow** を開きます。
2. 更新の範囲を選びます。
   - `full`（全体更新・既定）: Booking AdminとBooking Web Appの両方を更新します。
   - `admin-only`（管理用だけ更新）: Booking Adminだけを更新して止まります。予約データの列を変えるときに使います（下の「Bookings schema変更時」）。
3. テストが通ると `booking-production` の承認待ちになります。更新内容を確認して、**承認します**。
4. 承認後、最初に**更新に必要な接続情報と設定を、更新する対象すべてについて確認**します（読み取りだけで、何も書き換えません）。
   `full` ではAdminとWeb Appの両方、`admin-only` ではAdminだけを確認します。
5. 確認が通ったら、更新を始めます。通らなければ何も更新せずに止まります。

### 結果の見方（SHAの確認は不要です）

更新が終わると、実行画面（Step Summary）に次のように表示されます。**40桁のコードを自分で見比べる必要はありません**（システムが自動で照合します）。

- `Booking Admin: 反映確認OK` / `Booking Web App: 反映確認OK` … 更新先が今回の内容になったことを確認できました。
- `Booking Admin: 未確認（stage=… code=…）` … 更新は適用済みの可能性がありますが、最終確認ができていません。**再実行する前に**、更新先（Apps Scriptの「デプロイを管理」）の状態を確認してください。自動で再実行・巻き戻しはしません。
- 普通の更新では `scope` は `full`、`schema_migrated` はチェックなしのままで実行できます。`schema_migrated` はSHAのための入力ではなく、予約シートの列を変える変更（`BookingsSchema.gs` の実変更）があるときだけ、「Apps Scriptで`migrateBookingsSchema`を実行して成功を確認した」ことを運営者が伝えるためのものです。自動でONにはなりません。

### 初めての更新だけ、`schema_migrated` が必要になることがあります

更新先（Booking Web App）の説明文から「前回の本番版」が読み取れない場合（古い形式など）は、予約シートの列が変わったかどうかを判定できないため、**安全のため止まります**（`PREVIOUS_SHA_UNKNOWN`）。その場合は、次の順に進めてください。

1. `scope=admin-only` で実行して承認する。
2. Booking AdminのApps Scriptエディタで `migrateBookingsSchema` を実行し、成功を確認する（不足している列を足すだけで、何度実行しても安全です）。
3. `scope=full`、`schema_migrated` にチェックを入れて実行して承認する。

この `full` のあとは、更新先の説明文が読み取れる形になり、次回からは通常どおり（チェックなし）で実行できます。

### エラーが出たとき

止まった画面（Actionsの実行ログ）に `Booking preflight failed: role=… stage=… code=…` と表示されます。
`role` は対象（`admin`＝管理用、`public`＝Web App）、`stage` は止まった段階です。次の順に対応してください。

1. **何も更新されていないこと**を確認します（このメッセージが出たときは、更新前に止まっています）。
2. 表示された `stage` に合わせて、確認する場所を見ます。

   | stage | 意味 | 確認する場所・対応 |
   | --- | --- | --- |
   | `SECRETS` | 必要な設定値が未登録 | Settings > Environments > `booking-production` の登録名がそろっているか確認し、足りないものを登録 |
   | `CREDENTIAL` | 接続情報の形式・ユーザーが違う | 接続情報を登録し直す（下の「初回設定: Google認証」。Adminは`default`、Webは`booking-owner`） |
   | `LIST` | Googleに接続できない（接続切れ・権限なし・一時的な障害） | `code` が `AUTHENTICATION_FAILED` なら接続情報の期限切れなので登録し直す。`TRANSIENT_API_OR_NETWORK_ERROR` はしばらくしてから再実行 |
   | `DEPLOYMENT` | 登録した更新先が見つからない／重複 | デプロイIDの登録値を、Apps Scriptの「デプロイを管理」で確認 |
   | `PULL` / `BUILD` | 更新先の設定を取得・準備できない | 担当者に連絡（ログの `code` を伝える） |

3. 設定を直したら、**同じ手順で最初から再実行**します。接続情報の値はログや画面に出ません。貼り付けもしないでください。
4. 直らないときは、`role` `stage` `code` の3つだけを担当者に伝えます。

### この確認でわからないこと（注意）

- 「初回に一度ログインすれば以降ずっと不要」とは限りません。Google側で接続が切れたとき、担当が替わったとき、権限の範囲が変わったときは、再ログイン・再登録が必要です。
- この確認が通っても、**更新の成功は保証されません**（更新に必要な権限や、その後の通信の成功までは事前に確かめられません）。更新中に止まった場合は、下の手順書とログの案内に従ってください。
- Googleスクリプト実行時の権限の同意や、SwitchBotの接続情報の有効性は、この確認の対象外です。

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
4. 承認後、同一job内で`preflight（Admin→Public、読取りのみ） → schema差分ガード → Booking Admin → Booking Web App → post-check`を順に実行する。
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
`verify`（post-check）も同じ共通の読取り検証を使う。先頭の一覧取得を1回目として、今回SHAが見えない間だけ
最大5回・5秒間隔（待機は合計20秒）で`list-deployments`を読み直す。`verify`は読取り専用で、再試行中にも
push・update-deployment・新規version/Deployment作成を行わない。比較基準は実行開始時の`GITHUB_SHA`のままで、
部分SHA・別Deployment・古いSHAは成功扱いにしない。
ID不在・非一意、認証／一覧取得エラーは再試行せず即時停止し、最終回まで不一致なら`SHA_MISMATCH`で停止する
（ログは固定分類と試行回数のみで、一覧そのもの・ID・認証情報は出さない）。
更新済みmarkerがあるのにpost-checkが失敗した場合は、「更新は成功済み・最終確認は未完了」とログに出る。
この場合は更新全体を無条件に再実行せず、まずDeploymentの実状態を読取りで確認する（Issue #684）。

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

## 技術者向け詳細: 開始時のpreflight（Issue #804）

承認直後・最初の書込み（Admin更新）の前に、更新対象すべての認証と配布物を**読取りだけ**で確認する
（`scripts/deploy-booking-gas-target.sh <admin|public> preflight`）。

- `scope=full`: Admin（`default`）とPublic（`booking-owner`）の**両方**。Publicが失敗した場合、Adminは1回も更新されない。
- `scope=admin-only`: Adminだけ。Public用Secretsは要求しない。
- 確認内容: 必須Secrets → clasp資格情報JSON/user → 選択GASへの`list-deployments` → 既存Deploymentの完全一致・一意性 → `pull`とmanifest → 配布物の組立て。`push`/`update-deployment`は呼ばない。
- 失敗は `Booking preflight failed: role=<admin|public> stage=<SECRETS|CREDENTIAL|LIST|DEPLOYMENT|PULL|BUILD> code=<固定コード>. No deployment was updated.` の形式。Secret・ID・メール・clasp生出力は出さない。
- 認証失効（`CREDENTIAL` / `LIST`）の場合は、Secretsを貼らず`booking-production`のEnvironment secretsを再登録して再実行する。
- preflightは更新権限や将来のAPI成功、GAS実行権限を保証しない。更新step自体の認証エラーは従来どおり固定コードで停止する。
- GAS実行時の権限同意、SwitchBot Token/Secretの有効性はpreflightの対象外（別ゲート）。

補足: preflightの「配布物の組立て」は、Publicについてリモートmanifestの存在を確認したうえでGit管理のPublic manifestで組み立てる（後続のdeployと同じ）。
リモート設定との差分、`show-file-status`、push権限、将来のAPI成功は事前に保証しない。preflight成功は本番デプロイ成功の保証ではない。

## Webhook / Survey の更新前確認（Issue #804 PR-C1）

Booking Webhook（`Update Booking Webhook GAS`）とSurvey（`Deploy Survey GAS to production`）も、承認後・最初の書込みの前に、
**選択した対象だけ**の接続情報と更新先を読取りで確認します。問題があれば何も更新せずに停止します（承認は従来どおり1回）。

- Webhook: 接続情報（`booking-owner`）、Booking本体と別のGASであること、更新先の登録、配布物。
- Survey: 選んだ `public` または `admin` の更新先だけ（もう一方の設定値は要求しません）。
- 失敗は `GAS preflight failed: role=<booking-webhook|survey-public|survey-admin> stage=<SECRETS|CREDENTIAL|PROJECT|LIST|DEPLOYMENT|PULL|BUILD> code=<固定コード>. No deployment was updated.` の1行です。
  対応は上の「開始前の確認（運営向け）」の表と同じです（設定値の登録→接続情報の登録し直し→更新先IDの確認→再実行）。値をログに出して確認しないでください。
- 技術メモ: `scripts/preflight-gas-project.sh <role>`（許可リストの固定 roleのみ）。`list-deployments`と`pull`だけを呼び、更新先IDは一覧のID欄の完全一致・一意で照合します。
  確認は更新権限や将来のAPI成功を保証せず、本番更新の成功保証ではありません。更新stepの既存の防護（pull/manifest/push/update後の確認）は変更していません。
- 更新後の確認（Webhook / Survey）: `update-deployment` のあと、`scripts/verify-gas-deployment-sha.sh <role>` が読取りだけで、
  一覧の**ID欄が完全一致・一意**で、**同じ行のdescriptionが正確に`main <今回のSHA>`である**ことを確認します（前置き・追記・別記載のSHAを含む部分一致は成功にしません）（最大5回・5秒間隔。push・updateは再実行しません）。
  確認できない場合は `GAS post-update verification failed: role=… stage=VERIFY code=…` と表示され、
  「更新は適用済みの可能性があり、最終確認は未完了」です。再実行や巻き戻しを決める前に、更新先の状態を読取りで確認してください。

## 技術者向け詳細: SHA照合（Issue #804 PR-D1a）

- 今回のSHAは `GITHUB_SHA`（40桁小文字16進）から自動取得します。入力・Secret・Environment変数は追加していません。40桁でなければ、clasp呼出しの前に停止します。
- 更新後の確認と post-check は、**ID欄の完全一致・一意**の行の説明文全体が正確に `main <今回の40桁SHA>` のときだけ「反映確認OK」です。部分一致、前置き・追記、旧SHAの混在、別行のSHAは成功にしません。読取りだけの再試行（最大5回・5秒間隔）と `UNKNOWN_STATE` 方針は従来どおりです。
- schemaガードは、既存のPublic本番Deploymentの**一意な行の説明文が正確に `main <40桁SHA>`** のときだけ前回本番SHAとして採用し、Git履歴で `BookingsSchema.gs` の差分を判定します。AdminのSHAやPublicの編集用HEADは公開版の代用にしません。Deploymentの行そのものを特定できない場合（ID不明・重複・部分一致）や、前回SHAがGit履歴にない場合は、`schema_migrated=true` でも停止します。
- 説明文が追記つき・前置きつき・複数SHA・旧形式（SHAなし）・空のときは「前回SHA不明（`PREVIOUS_SHA_UNKNOWN`）」です。**不明を「変更なし」とは仮定しません**。`schema_migrated=true` がなければ停止し、運営が `admin-only` → `migrateBookingsSchema`（手動・不足列の追加のみ）→ `full(schema_migrated=true)` を行った場合に限り、「変更あり」と同じ扱いで通します（初回ベースライン・Issue #804 案P1）。この `full` で説明文が `main <SHA>` に更新され、以後は通常の判定に戻ります。新しい入力・Secretはありません。

## Webhook / Survey のSecrets受け渡し最小化（Issue #804 PR-D2）

運営者の操作は変わりません（Environment承認・入力・Secrets名・再実行方法はそのままです）。変わったのは、Secretsを**渡す範囲**だけです。

- 以前: `deploy` job全体の環境変数にSecretsが載り、リポジトリ取得・Node準備・claspの導入stepにも渡っていました。
- 現在: Secretsは「更新前の確認（preflight）」と「更新」の2 stepだけに渡します。それ以外のstepには渡しません。
- Survey: 選んだ `public` または `admin` の更新先IDだけを渡します。選ばれなかった側は空になり、Secret値は環境変数に載りません。
  選んだ側が未登録の場合も、もう一方へ代用せず `SECRET_MISSING` で更新前に停止します。
- 技術メモ: 選択は `${{ inputs.target == 'public' && secrets.… || '' }}` の形です。`inputs.target` はshell本文へ直接展開せず、環境変数 `SURVEY_TARGET` 経由で参照します。
  `test/gas-workflow-secrets-scope.test.js` が「job全体のenvにSecretsが無い」「Secretsを使うstepはpreflightと更新の2つだけ」「Surveyの選択式が対象と一致」「clasp偽物で選択側のIDだけが使われる」を確認します。
- 対象外: Secretsの値・保管先・Environment・承認回数・更新手順・更新後の確認は変更していません。Booking本番・Access・旧verifyなどは、すでにstep単位の受け渡しです。
- 実Googleでの動作は未検証です（CI・模擬試験は本番成功の証明ではありません）。

## 共通部品（Issue #804 PR-E1・技術メモ）

Webhook／Survey の更新前確認（`scripts/preflight-gas-project.sh`）と更新後確認（`scripts/verify-gas-deployment-sha.sh`）で重複していた
「clasp の一覧を読む処理」（失敗の固定コード分類・ID欄の完全一致の件数・同じ行の説明文の取得）を
`scripts/gas-deployment-list-lib.sh` にまとめました。読取りだけの部品で、push／update-deployment は呼びません。
運営者の操作・Secrets・Environment・承認・出力形式は変わりません。Booking 本番（`deploy-booking-gas-target.sh`）は
既存テストが関数を直接取り出して検査しているため、今回は共通部品へ移していません。
