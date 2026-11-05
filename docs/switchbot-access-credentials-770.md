# 鍵管理用・独立GAS 資格情報3件の初期登録手順（Issue #770）

独立GAS「SwitchBot Access Production」（#754）の **User Properties**（デプロイ実行者本人）へ、次の3件を**ローカルの非表示入力CLI + Apps Script Execution API 経由で**登録・差し替えする。

| 名前 | 内容 |
| --- | --- |
| `SWITCHBOT_TOKEN` | SwitchBot API Token（運営者が所持） |
| `SWITCHBOT_SECRET` | SwitchBot API Secret（運営者が所持） |
| `WEBHOOK_SHARED_TOKEN` | Webhook共有トークン（24文字以上の乱数。ローカルで新規生成） |

既存の Script Properties（`ACCESS_*` / `LEDGER_*` / 状態）、トリガー、Webhook登録、SwitchBot端末APIには**触れない**。`ACCESS_ENABLED` は未設定（OFF）のまま、自動デプロイは行わない（#778以降は手動起動のみ。`SWITCHBOT_ACCESS_AUTODEPLOY` は参照されない）。
**このPRのマージは登録の実行を意味しない**。登録・デプロイ・フラグ変更は運営者が別途、別証跡で行う。

## 1. 採用した経路と根拠（実現性の検証結果）

結論: **ローカルの非表示入力CLI → Apps Script Execution API（`scripts.run`）→ GAS の `accessSetupCredentialsApi`**。実行には、**既存Webアプリとは別の「API実行可能（API Executable）Deployment」を運営者が明示的に作る**必要がある（PR #771 レビューで指摘。`devMode` でも不要にはならない前提で設計する）。

```
運営者のPC（TTY非表示入力）──HTTPS本文──▶ script.googleapis.com/v1/scripts/<API実行可能DeploymentのID>:run ──▶ accessSetupCredentialsApi
   scripts/switchbot-access-setup-credentials.js                      （呼び出した本人として実行 → その本人の User Properties）
```

- `scripts.run` は**呼び出した OAuth ユーザー本人**として関数を実行する。`PropertiesService.getUserProperties()` はその本人の領域で、Webアプリ（`executeAs=USER_DEPLOYING`）が読むのも**デプロイ者の領域**。よって「呼び出し者 = デプロイ者」ならそのまま Webアプリが読める。
- REST の path には**API実行可能DeploymentのID**を指定し、`devMode: false`（デプロイ済みの版を実行）。CLIは環境変数 `SBA_API_DEPLOYMENT_ID` から読む。
- 秘密は「PCの端末入力 → HTTPS本文 → GAS」のみ。コマンドライン引数・環境変数・ファイル・ソース・GitHub・CIを通らない（`SBA_API_DEPLOYMENT_ID` はIDであり秘密ではないが、公開Issue/PRには書かない）。
- 参照: [Execution API の使い方](https://developers.google.com/apps-script/api/how-tos/execute) / [scripts.run](https://developers.google.com/apps-script/api/reference/rest/v1/scripts/run)

| 候補 | 判定 | 理由 |
| --- | --- | --- |
| **ローカルCLI + Execution API（採用）** | ○ | 上記。ローカルで非表示入力でき、画面の映り込み・クリップボードを避けられる。**別のAPI実行可能Deploymentの作成が必要** |
| エディタ実行 + `Browser.inputBox` | ✕ 不採用 | `Browser` はスプレッドシート文脈でのみ利用可能。独立GASでは動作しない |
| Webアプリの `doPost` で受ける | ✕ 禁止 | 匿名到達の公開エンドポイントで秘密を受けることになる |
| 関数本文へ直書きして実行 | ✕ | エディタ・版履歴・`clasp pull` に秘密が残る |
| Script Properties へ置く | ✕ 禁止 | プロジェクト編集者が閲覧できる |
| `clasp run` | ✕ 不採用 | 引数が**コマンドライン引数**になり、シェル履歴・プロセス一覧に残る |
| 非公開スプレッドシート経由 | ✕ 不採用 | シートの版履歴に秘密が残る |
| ローカル一時ファイル経由（秘密の入力として） | ✕ 不採用 | 入力にはTTYを使うためファイルは不要。唯一のファイル出力は `--generate-webhook-token-to`（§2） |

### 別Deploymentについて（運営者が明示的に作成・停止する）
- 既存のWebアプリDeployment（`/exec` URL、`SWITCHBOT_ACCESS_DEPLOYMENT_ID`）は**変更しない**。API実行可能Deploymentは**別のDeployment**として作る。#768 の自動デプロイは `SWITCHBOT_ACCESS_DEPLOYMENT_ID` を完全一致で選ぶので、別Deploymentがあっても影響しない（自動デプロイは未有効のまま）。
- 作成（運営者が手動）: 登録用関数（`accessCredentialStatusApi` / `accessSetupCredentialsApi`）を含むコードを反映した版を用意 → エディタの「デプロイ > 新しいデプロイ」で種類 **API Executable**、アクセスできるユーザーは**自分のみ**、説明に「#770 credential setup（用後に削除）」。**Webアプリのデプロイは触らない・新規作成もしない**。
- **停止/撤去**: 登録が済んだら、「デプロイを管理」で**このAPI実行可能Deploymentをアーカイブ（削除）**する。以後 `scripts.run` で関数は呼べない。Webアプリ・`/exec` URL・トリガーへの影響はない。差し替え（ローテーション）の時だけ同じ手順で作り直す。
- 未検証: ①API実行可能Deploymentを作る際に manifest へ `executionApi` が付く場合の、#768 の `check-manifest`（webapp設定の照合）・`clasp push --force` との相互作用 ②デプロイ済みの版に登録用関数が含まれること。**自動デプロイを有効化する前に**、運営者が manifest の差分を確認し、必要なら本PRの範囲外で別途調整する。

### 前提条件（運営者が整える・**本環境では未検証**）
本PRの開発環境には実GAS・実Googleアカウント・Google APIへの到達がなく、`scripts.run` の実機動作は**未確認**。**実GASでの確認（§3 手順1の `--dry-run`）が成功するまで、秘密を入力してはならない**（`--dry-run` は値を一切聞かない）。未達なら中止し、Issue #770 に結果を報告する（別経路を推測で試さない）:

1. 鍵管理GASを**独自のGoogle Cloudプロジェクト**（標準プロジェクト）に紐付ける（プロジェクトの設定 > Google Cloud Platform プロジェクト）。clasp 既定のOAuthクライアントでは `scripts.run` できない。
2. そのCloudプロジェクトで **Apps Script API を有効化**し、OAuth同意画面とOAuthクライアント（デスクトップ）を作る（認証情報JSONを一時的にローカルに置く）。
3. `clasp login --use-project-scopes --creds <認証情報JSON>` で、**実行者本人のアカウント**でログインし直す（`appsscript.json` の全スコープを含む。`.clasprc.json` の `tokens.default` に `client_id/client_secret/refresh_token` が入る。CLIはこのファイルを読む）。認証情報JSONは用が済んだら削除する。
4. 上記の別Deployment（API Executable、アクセス＝自分のみ）を作り、そのIDを `SBA_API_DEPLOYMENT_ID` に設定する。
5. [Apps Script API設定](https://script.google.com/home/usersettings) で「Google Apps Script API」がオン（#768 §2 で済み）。

`--dry-run` が `API_AUTH_FAILED` / `API_NOT_FOUND` / `SCRIPT_ERROR` になる場合は上記の未達が原因（詳細は意図的に表示されない）。

### 標準Cloudプロジェクトへの切替え・clasp再ログイン後の `SWITCHBOT_ACCESS_CLASPRC_JSON`
手順3の再ログインで `.clasprc.json` の内容（OAuthクライアント・リフレッシュトークン）が変わる。以前GitHub Environment `switchbot-access-production` に登録した `SWITCHBOT_ACCESS_CLASPRC_JSON` は**古い認証になる可能性がある**（別クライアントで発行されたトークンは、失効・無効化されることがある）。次を行ってから自動デプロイを有効化する（本Issueでは更新・有効化しない）:
1. デプロイは**手動起動のみ**（#778。変数による有効化は廃止）。確認が済むまで Run workflow を起動しない。
2. 再ログイン後の `.clasprc.json` で `SWITCHBOT_ACCESS_CLASPRC_JSON` を更新（運営者が値をEnvironment Secretに登録。値はPR・ログに出さない）。
3. 有効化前に、最初の `workflow_dispatch` 実行（#768 §4）で認証が通ることを再検証する。失敗したら有効化しない。

### アカウントの整合（fail closed）
コードが確認できること: 実行者が `ACCESS_ADMIN_ACTORS`（許可リスト）の管理者であること、`Session.getActiveUser()` と `getEffectiveUser()` が**双方とも取得でき**一致すること（どちらかが取得できなければ `IDENTITY_UNAVAILABLE`、不一致は `ACCOUNT_MISMATCH`、許可リスト外は `NOT_AUTHORIZED`。いずれも**値を聞く前・書込み前**に停止し、未認可には状態（SET/MISSING）も見せない）。
コードが確認**できない**こと: 実行者が既存Webアプリの「次のユーザーとして実行」のデプロイ者と同一か（#768 §段階ゲートと同じ運用ゲート）。次の3者が**同一アカウント**であることを、登録前に運営者が確認する: ①`clasp login` の認証主体（=CLIの呼び出し者） ②Webアプリのデプロイ者 ③`SWITCHBOT_ACCESS_CLASPRC_JSON` の発行アカウント。違えば実行しない。別アカウントで登録しても、Webアプリはデプロイ者の領域（MISSINGのまま）を読むので動作しない。

## 2. 事前準備（ローカル）

1. 上記§1の前提条件を整え、`SBA_API_DEPLOYMENT_ID`（API実行可能DeploymentのID）を用意する。
2. **Webhook共有トークン**: 次のどちらか。
   - パスワードマネージャ等で24文字以上のURL安全文字（`A-Za-z0-9_-`）のランダム値を作っておき、CLIの入力に貼る。
   - CLIに生成させる: `--generate-webhook-token-to <新規ファイル>`。**画面には出さず**、指定パスへ新規作成（POSIXではモード0600、既存ファイルは上書きせず中止。Windowsではユーザープロファイル配下など他ユーザーが読めない場所を指定する）。パスワードマネージャへ移した後、ファイルを削除する（これが唯一のローカル残存点）。
3. SwitchBot の Token / Secret はパスワードマネージャ等から貼り付ける。**TTYの非表示入力**（エコーなし）のため画面共有・録画があっても映らないが、クリップボード履歴ツール（Windowsのクリップボード履歴 `Win+V` を含む）を使っている場合は登録後に該当エントリを削除する。
4. シェル履歴に残るのはコマンド（フラグ・`SBA_API_DEPLOYMENT_ID`）だけ。秘密は含まれない。
5. `.clasprc.json` の場所は `os.homedir()` 配下（Windowsでは `%USERPROFILE%`、macOS/Linuxでは `$HOME`）。別の場所なら環境変数 `CLASPRC_PATH` で指定する。

## 3. 初回登録手順（運営者が実施）

TTYのターミナルで（パイプ・リダイレクトからは拒否される）。環境変数の設定構文はシェルごとに異なる。

**macOS / Linux（bash / zsh）**
```bash
SBA_API_DEPLOYMENT_ID=<API実行可能DeploymentのID> node scripts/switchbot-access-setup-credentials.js --dry-run
```
**Windows PowerShell**
```powershell
$env:SBA_API_DEPLOYMENT_ID = "<API実行可能DeploymentのID>"; node scripts/switchbot-access-setup-credentials.js --dry-run
```
以降のコマンドも同じ形式（`--dry-run` を外す／付け替える）。PowerShell では先に `$env:SBA_API_DEPLOYMENT_ID` を設定したセッションを使い回してよい。作業後は `Remove-Item Env:SBA_API_DEPLOYMENT_ID` で消す。

1. **実GASでの確認（値は一切聞かない・何も保存しない）**: `--dry-run`。`result: STATUS_OK` と各項目の `SET`/`MISSING` が出ること。失敗なら中止（§1の前提条件を確認）。**これが成功するまで秘密を入力しない。**
2. **登録**: `--dry-run` を外して実行（共有トークンをCLIに生成させるなら `--generate-webhook-token-to <新規ファイル>` を付ける）。聞かれた項目（未設定のものだけ）を順に貼り付ける。`result: OK` と3件 `SET`。
3. **確認**: GASエディタで `accessCheckSetup` を実行 → 3件 `SET`、`ACCESS_ENABLED` は `OFF` のまま（値は表示されない）。
4. クリップボードをクリアし、認証情報JSON・（生成した場合は）トークンファイルを削除し、**API実行可能Deploymentをアーカイブ**する（§1「停止/撤去」）。

登録後の**読取診断**（`accessAdminStatus`、1回の手動 `accessSyncJob` で `FLAG_OFF`）、**Webhook URLの登録・更新**、トリガー設置は本Issueの範囲外で、運営者が別作業・別証跡で行う。#754 は読取診断成功までOPENのまま。

## 4. 戻り値・ログ（固定コードのみ）

関数の戻り値と実行ログは `{ok, code, status{名前:SET|MISSING|UNKNOWN}, changed[名前]}` のみ。入力値・既存値・例外メッセージは含まない（例外は捕捉して固定コードに変換）。

| code | 意味 | 変更 |
| --- | --- | --- |
| `OK` | 登録/差し替え成功 | あり |
| `STATUS_OK` | 状態確認（`--dry-run`）成功。値は聞かず保存もしない | なし |
| `NOT_AUTHORIZED` / `IDENTITY_UNAVAILABLE` / `ACCOUNT_MISMATCH` | 許可リスト外 / 実行者または有効ユーザーのいずれかを確認できない / 両者が不一致 | なし（値も聞かない） |
| `READ_FAILED` | User Properties の読取が失敗（1件でも）。状態は `UNKNOWN` と表示し、**`MISSING` 扱いにしない**。CLIは秘密入力前に停止 | なし |
| `STATE_CHANGED` | 状態確認後〜書込み直前に設定状況が変わった（競合・他経路の更新）。既存値は上書きしない | なし |
| `LOCK_BUSY` / `LOCK_UNAVAILABLE` | 同時実行中 / ロックを取得できない | なし |
| `ALREADY_SET` | 3件とも設定済み（初回登録は上書きしない） | なし |
| `NOT_INITIALIZED` | 差し替え対象がない（先に初回登録） | なし |
| `REPLACE_NOT_CONFIRMED` | 確認語 `REPLACE` が一致しない | なし |
| `CANCELLED` | 入力の取消（CLI側 `error: CANCELLED` も同様） | なし |
| `INPUT_INVALID` | 形式不備（`invalid` に項目名のみ）。1件でも不備なら全件書かない | なし |
| `INPUT_DUPLICATE` | 3種のうち同じ値がある（使い回し禁止） | なし |
| `NOTHING_TO_CHANGE` | 差し替えで全項目が空（据え置き） | なし |
| `WRITE_FAILED` / `VERIFY_FAILED` | 書込み/読戻し照合の失敗。今回の分を元に戻す | 元に戻る |
| `UNEXPECTED_ERROR` | 想定外の例外 | 不明（`accessCheckSetup` で状態確認） |

形式: Token/Secret は空白・制御文字なしの16〜512文字。共有トークンは `A-Za-z0-9_-` のみ・24〜128文字・異なる文字8種以上（Webhook URLのクエリで使うため）。

## 5. 部分設定・入力不備の復旧

- **`WRITE_FAILED` / `VERIFY_FAILED` / `UNEXPECTED_ERROR` の直後は、必ず状態を再確認する**: ロールバック自体が失敗した場合、コードだけでは元の状態を保証できない。直後にCLIの `--dry-run`（または GASエディタの `accessCheckSetup`）で3件の `SET`/`MISSING`/`UNKNOWN` を確認し、**不明（`UNKNOWN`・想定と異なる状態）なら操作を停止**して、原因の確認とSwitchBot側のToken/Secret再発行の要否判断（必要なら無効化してから初回登録をやり直す）を行う。

- `INPUT_INVALID` / `INPUT_DUPLICATE` / `CANCELLED`: 何も書かれていない。もう一度CLIを実行する。
- 一部だけ `SET`（過去の手動設定・`UNEXPECTED_ERROR` 等）: CLIを（`--replace` なしで）実行すると**未設定の項目だけ**入力を求め、設定済みは変更しない。
- 全項目が `SET` で誤りがある場合は §6 の差し替えを使う。

## 6. 差し替え（ローテーション）・削除

- **差し替え**: CLIを `--replace` 付きで実行 → `REPLACE` と入力 → 項目ごとに新値（**空のままEnterで据え置き**）。確認語が違う・取消の場合は何も変更しない。
- `WEBHOOK_SHARED_TOKEN` を差し替えたら、SwitchBot側のWebhook URL（`?t=` の値）の更新が必要（別手順・別証跡。本Issue範囲外）。更新までWebhookは認証失敗で拒否される。
- SwitchBot の Token/Secret は SwitchBotアプリで再発行→ `--replace` で差し替え。漏えいが疑われるときは先に再発行して旧値を無効化する。
- **削除（撤去・実行者交代）**: 専用の削除関数は設けない（秘密に触れる操作を増やさないため）。User Properties は**所有者本人のみ**が操作でき、他の編集者は読み書き・削除できない。撤去・実行者交代時は、新実行者が初回登録手順で再登録し、旧実行者の領域は旧実行者本人のアカウントで失効させる（SwitchBot側でToken/Secretを再発行して旧値を無効化するのが確実）。運用者交代の全体手順は `docs/switchbot-access-gas-deploy-768.md` §7。
- 保持される User Properties は**実行者アカウントに紐づく**。実行者が変わる/アカウントが削除されると読めなくなる（`accessCheckSetup` が `MISSING` になる）。

## 7. 漏えい面の整理

| 経路 | 状況 |
| --- | --- |
| ソース・GitHub・PR・CI・履歴 | 値を持たない（テストはすべてダミー値で、実行ログ・戻り値への非出力をテストで固定） |
| コマンドライン引数・シェル履歴 | 使わない（`clasp run` 不採用）。§2の生成コマンドに秘密は含まれない |
| ブラウザ履歴 | ブラウザを使わない（ローカルCLI） |
| コマンドライン引数・環境変数 | 使わない。CLIは引数にフラグ以外（値っぽい文字列を含む）が来ると、内容を表示せず `BAD_ARGS` で拒否。非TTYも拒否 |
| 実行ログ（Executions / Logger） | 固定コード・SET/MISSINGのみ出力 |
| 画面・クリップボード | 入力はエコーなし。**残存リスク**は貼り付け元のクリップボード（履歴ツール）。§2の3.で対策（運営者の運用） |
| 通信 | `scripts.run` へのHTTPS本文のみ（Googleの通信経路）。URLには含まれない |
| Googleサーバ内 | User Propertiesとして保存（Webアプリと同じ保管。他の編集者は読めない） |
| ローカルの残存 | `.clasprc.json`（既存のclasp認証。秘密の入力値ではない）、`--generate-webhook-token-to` で出力した場合のそのファイル（用後に削除） |

## 8. テスト
`test/switchbot-access-credentials-770.test.js`（実GAS・実API・実秘密なし。ダミー値のみ）: 正常登録／--dry-run=状態確認のみ（値を聞かない）／欠損・部分設定の補完／上書き拒否／差し替え確認語／入力検証・重複／誤アカウント（許可リスト外・未取得・不一致）／途中失敗のロールバック／読取失敗（1〜3件目）の fail closed・保存直前の状態変化（`STATE_CHANGED`）・既存値の誤上書き防止・ロック競合／読戻し照合失敗／取消／戻り値・ログ・CLI出力・HTTP URLへの非漏えい／CLIの引数拒否（値を引数で渡す・非TTY）・API失敗の固定コード化・`--generate-webhook-token-to`（新規0600・既存拒否）／3キー以外・Script Properties・トリガー・外部通信・メールに触れないこと／manifest無変更。
