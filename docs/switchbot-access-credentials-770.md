# 鍵管理用・独立GAS 資格情報3件の初期登録手順（Issue #770）

独立GAS「SwitchBot Access Production」（#754）の **User Properties**（デプロイ実行者本人）へ、次の3件を**ローカルの非表示入力CLI + Apps Script Execution API 経由で**登録・差し替えする。

| 名前 | 内容 |
| --- | --- |
| `SWITCHBOT_TOKEN` | SwitchBot API Token（運営者が所持） |
| `SWITCHBOT_SECRET` | SwitchBot API Secret（運営者が所持） |
| `WEBHOOK_SHARED_TOKEN` | Webhook共有トークン（24文字以上の乱数。ローカルで新規生成） |

既存の Script Properties（`ACCESS_*` / `LEDGER_*` / 状態）、トリガー、Webhook登録、SwitchBot端末APIには**触れない**。`ACCESS_ENABLED` は未設定（OFF）のまま、`SWITCHBOT_ACCESS_AUTODEPLOY` も未設定のまま。
**このPRのマージは登録の実行を意味しない**。登録・デプロイ・フラグ変更は運営者が別途、別証跡で行う。

## 1. 採用した経路と根拠（実現性の検証結果）

結論: **ローカルの非表示入力CLI → Apps Script Execution API（`scripts.run`、`devMode: true`）→ GAS の `accessSetupCredentialsApi`**。

```
運営者のPC（TTY非表示入力）──HTTPS本文──▶ script.googleapis.com scripts.run ──▶ accessSetupCredentialsApi
   scripts/switchbot-access-setup-credentials.js           （呼び出した本人として実行 → その本人の User Properties）
```

- `scripts.run` は**呼び出した OAuth ユーザー本人**として関数を実行する。`PropertiesService.getUserProperties()` はその本人の領域で、Webアプリ（`executeAs=USER_DEPLOYING`）が読むのも**デプロイ者の領域**。よって「呼び出し者 = デプロイ者」ならそのまま Webアプリが読める。
- `devMode: true`（スクリプトのオーナーが、最新の保存済みコードを実行）を使うため、**API実行可能Deploymentは作らない**（既存Webアプリ Deployment・`/exec` URL・#768 の方針を変えない）。`appsscript.json` も無変更。
- 秘密は「PCの端末入力 → HTTPS本文 → GAS」のみ。コマンドライン引数・環境変数・ファイル・ソース・GitHub・CIを通らない。

| 候補 | 判定 | 理由 |
| --- | --- | --- |
| **ローカルCLI + Execution API（採用）** | ○ | 上記。ローカルで非表示入力でき、画面の映り込み・クリップボードを避けられる |
| エディタ実行 + `Browser.inputBox` | ✕ 不採用 | Google公式リファレンスでは `Browser` は**スプレッドシート文脈でのみ**利用可能（PR #771 のレビュー指摘）。独立GASでは動作しない可能性が高く、スプレッドシートスコープも要る |
| Webアプリの `doPost` で受ける | ✕ 禁止 | 匿名到達の公開エンドポイントで秘密を受けることになる |
| 関数本文へ直書きして実行 | ✕ | エディタ・版履歴・`clasp pull` に秘密が残る |
| Script Properties へ置く | ✕ 禁止 | プロジェクト編集者が閲覧できる |
| `clasp run` | ✕ 不採用 | 引数が**コマンドライン引数**になり、シェル履歴・プロセス一覧に残る |
| 非公開スプレッドシート経由 | ✕ 不採用 | シートの版履歴に秘密が残る（完全削除が手順の必須条件になり漏えい面が増える） |
| ローカル一時ファイル経由（秘密の入力として） | ✕ 不採用 | 入力にはTTYを使うためファイルは不要。唯一のファイル出力は `--generate-webhook-token-to`（§2） |

### 前提条件（運営者が整える・**本環境では未検証**）
本PRの開発環境には実GAS・実Googleアカウント・Google APIへの到達がなく、`scripts.run` の実機動作は**未確認**。設計は Google の Execution API の仕様（`scripts.run` はオーナー/編集者のOAuthトークンで実行、`devMode` はオーナーのみ）に基づく。実行できる条件は次のとおりで、**満たせなければ中止し、Issue #770 に結果を報告する（別経路を推測で試さない）**:

1. 鍵管理GASを**独自のGoogle Cloudプロジェクト**（標準プロジェクト）に紐付ける（プロジェクトの設定 > Google Cloud Platform プロジェクト）。clasp 既定のOAuthクライアントでは `scripts.run` できない。
2. そのCloudプロジェクトで **Apps Script API を有効化**し、OAuth同意画面とOAuthクライアント（デスクトップ）を作る（認証情報JSONを一時的にローカルに置く）。
3. `clasp login --use-project-scopes --creds <認証情報JSON>` で、**実行者本人のアカウント**でログインし直す（`appsscript.json` の全スコープを含む。`~/.clasprc.json` の `tokens.default` に `client_id/client_secret/refresh_token` が入る。CLIが読むのはこのファイル）。認証情報JSONは用が済んだら削除する。
4. [Apps Script API設定](https://script.google.com/home/usersettings) で「Google Apps Script API」がオン（#768 §2 で済み）。

最初の `--dry-run` で `API_AUTH_FAILED` / `API_NOT_FOUND` / `SCRIPT_ERROR` になる場合、上記の未達が原因（詳細は意図的に表示されない）。

### アカウントの整合（fail closed）
コードが確認できること: 実行者が `ACCESS_ADMIN_ACTORS`（許可リスト）の管理者であること、`Session.getActiveUser()` と `getEffectiveUser()` が一致すること（不一致・取得不可は `NOT_AUTHORIZED` / `IDENTITY_UNAVAILABLE` / `ACCOUNT_MISMATCH` で、**値を聞く前に**停止）。
コードが確認**できない**こと: 実行者が既存Webアプリの「次のユーザーとして実行」のデプロイ者と同一か（#768 §段階ゲートと同じ運用ゲート）。次の3者が**同一アカウント**であることを、登録前に運営者が確認する: ①`clasp login` の認証主体（=CLIの呼び出し者） ②Webアプリのデプロイ者 ③`SWITCHBOT_ACCESS_CLASPRC_JSON` の発行アカウント。違えば実行しない。別アカウントで登録しても、Webアプリはデプロイ者の領域（MISSINGのまま）を読むので動作しない。

## 2. 事前準備（ローカル）

1. 上記§1の前提条件を整え、`SBA_SCRIPT_ID`（スクリプトID。公開Issue・PRには書かない）を用意する。
2. **Webhook共有トークン**: 次のどちらか。
   - パスワードマネージャ等で24文字以上のURL安全文字（`A-Za-z0-9_-`）のランダム値を作っておき、CLIの入力に貼る。
   - CLIに生成させる: `--generate-webhook-token-to <新規ファイル>`。**画面には出さず**、指定パスへ新規作成（モード0600、既存ファイルは上書きせず中止）。パスワードマネージャへ移した後、ファイルを削除する（これが唯一のローカル残存点）。
3. SwitchBot の Token / Secret はパスワードマネージャ等から貼り付ける。**TTYの非表示入力**（エコーなし）のため画面共有・録画があっても映らないが、クリップボード履歴ツールを使っている場合は登録後に該当エントリを削除する。
4. シェル履歴に残るのはコマンド（フラグ・`SBA_SCRIPT_ID`）だけ。秘密は含まれない。

## 3. 初回登録手順（運営者が実施）

TTYのターミナルで（パイプ・リダイレクトからは拒否される）:

1. **動作確認（何も保存しない）**: ダミー文字列で通す。
   ```bash
   SBA_SCRIPT_ID=<スクリプトID> node scripts/switchbot-access-setup-credentials.js --dry-run
   ```
   `result: DRY_RUN_OK` と各項目の `MISSING`。失敗なら中止（§1の前提条件を確認）。
2. **登録**:
   ```bash
   SBA_SCRIPT_ID=<スクリプトID> node scripts/switchbot-access-setup-credentials.js
   ```
   （共有トークンをCLIに生成させるなら `--generate-webhook-token-to <新規ファイル>` を付ける）
   聞かれた項目（未設定のものだけ）を順に貼り付ける。`result: OK` と3件 `SET`。
3. **確認**: GASエディタで `accessCheckSetup` を実行 → 3件 `SET`、`ACCESS_ENABLED` は `OFF` のまま（値は表示されない）。
4. クリップボードをクリアし、必要なら認証情報JSON・（生成した場合は）トークンファイルを削除する。

登録後の**読取診断**（`accessAdminStatus`、1回の手動 `accessSyncJob` で `FLAG_OFF`）、**Webhook URLの登録・更新**、トリガー設置は本Issueの範囲外で、運営者が別作業・別証跡で行う。#754 は読取診断成功までOPENのまま。

## 4. 戻り値・ログ（固定コードのみ）

関数の戻り値と実行ログは `{ok, code, status{名前:SET|MISSING}, changed[名前]}` のみ。入力値・既存値・例外メッセージは含まない（例外は捕捉して固定コードに変換）。

| code | 意味 | 変更 |
| --- | --- | --- |
| `OK` | 登録/差し替え成功 | あり |
| `DRY_RUN_OK` | 確認のみ成功 | なし |
| `NOT_AUTHORIZED` / `IDENTITY_UNAVAILABLE` / `ACCOUNT_MISMATCH` | 許可リスト外・実行者を確認できない・実行者と有効ユーザーが不一致 | なし（入力画面も出さない） |
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
| ローカルの残存 | `~/.clasprc.json`（既存のclasp認証。秘密の入力値ではない）、`--generate-webhook-token-to` で出力した場合のそのファイル（用後に削除） |

## 8. テスト
`test/switchbot-access-credentials-770.test.js`（実GAS・実API・実秘密なし。ダミー値のみ）: 正常登録／dryRunは無保存／欠損・部分設定の補完／上書き拒否／差し替え確認語／入力検証・重複／誤アカウント（許可リスト外・未取得・不一致）／途中失敗のロールバック／読戻し照合失敗／取消／戻り値・ログ・CLI出力・HTTP URLへの非漏えい／CLIの引数拒否（値を引数で渡す・非TTY）・API失敗の固定コード化・`--generate-webhook-token-to`（新規0600・既存拒否）／3キー以外・Script Properties・トリガー・外部通信・メールに触れないこと／manifest無変更。
