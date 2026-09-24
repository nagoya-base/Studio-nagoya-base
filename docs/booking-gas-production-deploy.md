# Booking GAS 本番デプロイ手順

GitHub `main`を唯一のソースとして、既存のBooking GASプロジェクトと既存デプロイを
`clasp`で更新する。新しいGASプロジェクトや新しいデプロイは作成しない。

対象は次の2プロジェクトで、事故範囲を分けるため1回の実行につき片方だけを更新する。

- `public`: Booking Web App（利用者向け。既存`/exec` URLを維持）
- `admin`: Booking Admin（既存のコンテナバインドGAS／既存デプロイ）

ワークフローはGASコードと`appsscript.json`だけを更新する。公開Web Appのmanifestは
mainの`gas/booking/public/appsscript.json`を正とし、コンテナ固有設定を持つBooking Adminの
manifestは既存プロジェクトから取得して維持する。Script Properties、
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

## 本番反映の実行方法

このPRをmainへマージし、上記初回設定を完了した後にのみ実行する。

1. GitHubの **Actions > Deploy Booking GAS to production > Run workflow** を開く。
2. Branchは`main`を選ぶ。
3. 先に`public`または`admin`の片方を選んで実行する。
4. テスト成功後、`booking-production`の承認待ちになる。差分と対象を確認して承認する。
5. 片方の成功と既存デプロイIDが更新されたことを確認してから、必要ならもう片方を実行する。

ワークフローは指定したデプロイIDが対象プロジェクトに実在することを先に確認する。
一致しない場合はGASコードをpushする前に停止する。デプロイ時は既存IDを必須引数にした
`clasp update-deployment`だけを使い、新規デプロイ作成コマンドは実行しない。

## 初回本番反映後の確認

- 公開Booking Web Appの`/exec` URLが変更されていないこと
- `getAvailability`の安全な読み取りsmoke testが成功すること
- Booking Adminへ管理者本人だけがアクセスできること
- Script Propertiesと既存トリガーが従来どおりであること
- 実予約、Calendarイベント、Bookings/Recoveryシートを変更していないこと

実予約を作成する`createBooking`の正常系テストは、専用テスト日時と後処理の合意がある
別作業として行う。このワークフローの初回実行と同時には行わない。
