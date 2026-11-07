# 本番Googleアカウントの確認（Issue #804）

「Booking本番の更新に使うGoogleアカウントが、想定したアカウントか」を確認する手動の入口です
（GitHub **Actions > Confirm booking-production Google account**）。
このリポジトリは公開なので、**実行ログにメールアドレスなどの個人情報は一切表示しません**。結果は固定のコードだけです。

## 使うとき（運営向け）

### 最初に一度だけ
1. GitHubの **Settings > Environments > `booking-production` > Environment secrets** に、
   想定するGoogleアカウントのメールアドレスを `BOOKING_EXPECTED_GOOGLE_ACCOUNT` として登録します。
   （メールアドレスをIssue・PR・チャットに書かないでください。Secretsの登録は運営者が行います。この変更では自動登録しません。）

### 確認するとき
1. **Actions > Confirm booking-production Google account > Run workflow** を実行します。
2. `booking-production` の承認が求められたら承認します。
3. 結果の行 `Account confirmation: <コード>` を見ます。

### 結果と対応
| コード | 意味 | 対応 |
| --- | --- | --- |
| `ACCOUNT_MATCH` | 想定のアカウントです | 対応不要 |
| `ACCOUNT_MISMATCH` | **別のアカウント**です | 更新作業を止め、接続情報を登録し直す（`docs/booking-gas-production-deploy.md` の「初回設定: Google認証」） |
| `EXPECTED_ACCOUNT_NOT_CONFIGURED` | 想定アカウントが未登録 | 上の「最初に一度だけ」を行う |
| `CLASPRC_NOT_CONFIGURED` / `CREDENTIAL_INVALID` | 接続情報が未登録・形式が違う | 接続情報を登録し直す |
| `AUTHENTICATION_FAILED` | 接続の期限切れ・取り消し | 接続情報を登録し直す |
| `SCOPE_INSUFFICIENT` | メールを読む権限がなく確認できない | 担当者に連絡（権限の追加はこの手順では行わない） |
| `LOOKUP_FAILED` / `UNEXPECTED_ERROR` | Google側の一時障害など | 時間をおいて再実行。直らなければ担当者へコードを伝える |

直したら同じ手順で最初から再実行します。**ログにメールアドレスを表示して確認する方法はありません**（行わないでください）。

### 過去のログについて
この変更より前の版は、成功した実行でメールアドレスをログへ出す作りでした。**新しいコードで過去の実行ログを消すことはできません**。
過去の実行（2026-09-25の2件）は、どちらも失敗で終了しており、メールを出す成功経路は通っていないとみられますが、
ログの中身はここでは確認していません。心配な場合は、運営者がGitHubの該当runを開いて確認し、必要ならそのrunのログを**運営者の操作で**削除してください。

## 技術者向け詳細
- 実装: `scripts/confirm-booking-production-account.js`（`confirmAccount(env, fetch)`。テストは `test/confirm-booking-production-account.test.js`、ネットワークはモック）。
- 対象は `CLASPRC_JSON` の `tokens.default`（Booking Admin用）だけ。refresh tokenとuserは `tokens.default` に限定し、他userへはfallbackしない。client ID/secretは、現行clasp形式（`tokens.default`内）に加え、旧実装が参照した `oauth2ClientSettings` とルートの項目も受け入れる（既存のSecretを貼り直さずに使える）。Public用(`booking-owner`)・Webhook用は対象外。
- `refresh_token` でアクセストークンを取得し、`oauth2/v3/userinfo` のメールを `BOOKING_EXPECTED_GOOGLE_ACCOUNT` と大文字小文字を無視して比較する。
  任意のアカウントでログインできただけでは成功にしない。平文メールの固定ハッシュ比較は行わない。
- メール取得に必要なscopeが無い場合は `SCOPE_INSUFFICIENT` で停止し、**新しいOAuth scopeは追加しない**。
- 出力は固定コードと固定文言のみ（stdout/stderr/summary/artifact/cacheへメール・ID・token・client情報・OAuth応答・生エラーを出さない）。
- 手動実行・`booking-production` 承認・`contents: read` を維持。
- Booking本番preflight（#805）は認証が有効かを確認するが、**どのアカウントか**は識別しないため、この入口はpreflightでは置き換えず維持する。
