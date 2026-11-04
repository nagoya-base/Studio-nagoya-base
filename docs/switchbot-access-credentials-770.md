# 鍵管理用・独立GAS 資格情報3件の初期登録手順（Issue #770）

独立GAS「SwitchBot Access Production」（#754）の **User Properties**（デプロイ実行者本人）へ、次の3件を**エディタの入力ダイアログ経由で**登録・差し替えする。

| 名前 | 内容 |
| --- | --- |
| `SWITCHBOT_TOKEN` | SwitchBot API Token（運営者が所持） |
| `SWITCHBOT_SECRET` | SwitchBot API Secret（運営者が所持） |
| `WEBHOOK_SHARED_TOKEN` | Webhook共有トークン（24文字以上の乱数。ローカルで新規生成） |

既存の Script Properties（`ACCESS_*` / `LEDGER_*` / 状態）、トリガー、Webhook登録、SwitchBot端末APIには**触れない**。`ACCESS_ENABLED` は未設定（OFF）のまま、`SWITCHBOT_ACCESS_AUTODEPLOY` も未設定のまま。
**このPRのマージは登録の実行を意味しない**。登録・デプロイ・フラグ変更は運営者が別途、別証跡で行う。

## 1. 採用した経路と根拠（実現性の検証結果）

結論: **Apps Script エディタで、運営者本人が関数を手動実行し、`Browser.inputBox` のダイアログへ貼り付ける**。

| 候補 | 判定 | 理由 |
| --- | --- | --- |
| **エディタ実行 + `Browser.inputBox`（採用）** | ○ | エディタで実行した関数は**実行した本人**として動き、`PropertiesService.getUserProperties()` はその本人の領域。Webアプリ（`executeAs=USER_DEPLOYING`）が読むのもデプロイ者の領域なので、**実行者=デプロイ者**ならそのまま読める。入力は「ブラウザ→Google」の通信のみで、ソース・コマンド引数・シェル履歴・GitHub・CIに残らない。新しいOAuthスコープ・Deployment・API公開は不要（`appsscript.json` は無変更） |
| Webアプリの `doPost` で受ける | ✕ 禁止 | 匿名到達の公開エンドポイントで秘密を受けることになる（本Issueで禁止） |
| 関数本文へ値を直書きして実行 | ✕ | エディタ・版履歴・`clasp pull` に秘密が残る |
| Script Properties へ置く | ✕ 禁止 | プロジェクト編集者が閲覧できる |
| `clasp run` / Execution API（`scripts.run`） | ✕ 不採用 | ①`clasp run` は引数が**コマンドライン引数**＝シェル履歴・プロセス一覧に残る ②API実行可能なDeployment・Cloud プロジェクトの紐付け・OAuthクライアントの用意が必要で、Deployment/スコープを変えない方針（#768）に反する ③clasp既定のOAuthクライアントでは実行できない見込み。②③は本環境では**検証できていない**ため、手順としては案内しない |
| ローカル一時ファイル経由 | ✕ 不採用 | ファイルをGASへ渡す安全な経路がなく、ローカルに秘密が残るだけで利点がない |

**未検証事項（運営者が最初に確認する）**: 本PRの開発環境には実GAS・実Googleアカウントがないため、`Browser.inputBox` がスタンドアロンGASのエディタ実行で表示されることは**実機未確認**（公式リファレンス上の挙動に基づく）。そのため§3の手順1で、何も保存しない `accessSetupCredentialsDryRun` を先に実行して確認する。`PROMPT_UNAVAILABLE` になった場合は本手順を中止し、Issue #770 へ報告する（別経路を推測で試さない）。

### アカウントの整合（fail closed）
コードが確認できること: 実行者が `ACCESS_ADMIN_ACTORS`（許可リスト）の管理者であること、`Session.getActiveUser()` と `getEffectiveUser()` が一致すること（不一致・取得不可は `NOT_AUTHORIZED` / `IDENTITY_UNAVAILABLE` / `ACCOUNT_MISMATCH` で、**入力ダイアログを出す前に**停止）。
コードが確認**できない**こと: 実行者が既存Webアプリの「次のユーザーとして実行」のデプロイ者と同一か（#768 §段階ゲートと同じ運用ゲート）。次の3者が**同一アカウント**であることを、登録前に運営者が確認する: ①エディタを開いて実行するアカウント ②Webアプリのデプロイ者 ③`clasp login` の認証主体。違えば実行しない。別アカウントで登録しても、Webアプリはデプロイ者の領域（MISSINGのまま）を読むので動作しない。

## 2. 事前準備（ローカル）

1. **Webhook共有トークンを生成**（出力は端末にのみ表示される。引数に秘密は含まれない）:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```
   43文字・URL安全文字になる。パスワードマネージャへ保管し、そこからコピーする（保管は運営者の管理下。GitHub・チャット・Issueには書かない）。生成後は端末をクリアする。
2. SwitchBot の Token / Secret は、SwitchBotアプリの開発者オプションを開き、パスワードマネージャ等からコピー。
3. 画面共有・録画・ミーティング・同席者がいない状態にする（ダイアログは**平文表示**で、`Browser.inputBox` はマスクできない）。クリップボード履歴ツールを使っている場合は、登録後に該当エントリを削除する。

## 3. 初回登録手順（運営者が実施）

エディタは、**対象GASをデプロイ者本人のアカウントで**開く。

1. **動作確認（何も保存しない）**: 関数 `accessSetupCredentialsDryRun` を実行 → 3つのダイアログに**ダミー文字列**（Token/Secretは16文字以上の適当な別々の文字列、共有トークンは24文字以上のURL安全文字）を入れる → 実行ログに `{"ok":true,"code":"DRY_RUN_OK",…}` が出ること。`PROMPT_UNAVAILABLE` / `NOT_AUTHORIZED` 等なら中止。
2. **登録**: 関数 `accessSetupCredentials` を実行 → 順に Token / Secret / 共有トークン を貼り付けてOK。ログに `"code":"OK"` と3件 `SET` が出ること。
3. **確認**: 関数 `accessCheckSetup` を実行 → `SWITCHBOT_TOKEN` / `SWITCHBOT_SECRET` / `WEBHOOK_SHARED_TOKEN` が `SET`、`ACCESS_ENABLED` が `OFF` のままであること（値は表示されない）。
4. 貼り付けに使ったクリップボードをクリアする。

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
| `CANCELLED` / `PROMPT_UNAVAILABLE` | ダイアログの取消 / 対話できない実行環境 | なし |
| `INPUT_INVALID` | 形式不備（`invalid` に項目名のみ）。1件でも不備なら全件書かない | なし |
| `INPUT_DUPLICATE` | 3種のうち同じ値がある（使い回し禁止） | なし |
| `NOTHING_TO_CHANGE` | 差し替えで全項目が空（据え置き） | なし |
| `WRITE_FAILED` / `VERIFY_FAILED` | 書込み/読戻し照合の失敗。今回の分を元に戻す | 元に戻る |
| `UNEXPECTED_ERROR` | 想定外の例外 | 不明（`accessCheckSetup` で状態確認） |

形式: Token/Secret は空白・制御文字なしの16〜512文字。共有トークンは `A-Za-z0-9_-` のみ・24〜128文字・異なる文字8種以上（Webhook URLのクエリで使うため）。

## 5. 部分設定・入力不備の復旧

- `INPUT_INVALID` / `INPUT_DUPLICATE` / `CANCELLED`: 何も書かれていない。もう一度 `accessSetupCredentials` を実行する。
- 一部だけ `SET`（過去の手動設定・`UNEXPECTED_ERROR` 等）: `accessSetupCredentials` を実行すると**未設定の項目だけ**入力を求め、設定済みは変更しない。
- 全項目が `SET` で誤りがある場合は §6 の差し替えを使う。

## 6. 差し替え（ローテーション）・削除

- **差し替え**: `accessReplaceCredentials` を実行 → 確認ダイアログに `REPLACE` と入力 → 項目ごとに新値（**空のままOKで据え置き**）。確認語が違う・取消の場合は何も変更しない。
- `WEBHOOK_SHARED_TOKEN` を差し替えたら、SwitchBot側のWebhook URL（`?t=` の値）の更新が必要（別手順・別証跡。本Issue範囲外）。更新までWebhookは認証失敗で拒否される。
- SwitchBot の Token/Secret は SwitchBotアプリで再発行→ `accessReplaceCredentials`。漏えいが疑われるときは先に再発行して旧値を無効化する。
- **削除（撤去・実行者交代）**: 専用の削除関数は設けない（秘密に触れる操作を増やさないため）。User Properties は**所有者本人のみ**が操作でき、他の編集者は読み書き・削除できない。撤去・実行者交代時は、新実行者が `accessSetupCredentials` で再登録し、旧実行者の領域は旧実行者本人のアカウントで失効させる（SwitchBot側でToken/Secretを再発行して旧値を無効化するのが確実）。運用者交代の全体手順は `docs/switchbot-access-gas-deploy-768.md` §7。
- 保持される User Properties は**実行者アカウントに紐づく**。実行者が変わる/アカウントが削除されると読めなくなる（`accessCheckSetup` が `MISSING` になる）。

## 7. 漏えい面の整理

| 経路 | 状況 |
| --- | --- |
| ソース・GitHub・PR・CI・履歴 | 値を持たない（テストはすべてダミー値で、実行ログ・戻り値への非出力をテストで固定） |
| コマンドライン引数・シェル履歴 | 使わない（`clasp run` 不採用）。§2の生成コマンドに秘密は含まれない |
| ブラウザ履歴 | 値はURLではなくダイアログ入力。URLクエリ・フォーム送信履歴には残らない見込み（実機確認は運営者） |
| 実行ログ（Executions / Logger） | 固定コード・SET/MISSINGのみ出力 |
| 画面・クリップボード | **残存リスク**。平文表示（マスク不可）と貼り付け元のクリップボード。§2の3.で対策（運営者の運用） |
| Googleサーバ内 | User Propertiesとして保存（エディタ・Webアプリと同じ保管。他の編集者は読めない） |

## 8. テスト
`test/switchbot-access-credentials-770.test.js`（実GAS・実API・実秘密なし。ダミー値のみ）: 正常登録／dryRunは無保存／欠損・部分設定の補完／上書き拒否／差し替え確認語／入力検証・重複／誤アカウント（許可リスト外・未取得・不一致）／途中失敗のロールバック／読戻し照合失敗／取消・ダイアログ不可／戻り値・ログ・ダイアログ文言への非漏えい／3キー以外・Script Properties・トリガー・外部通信・メールに触れないこと／manifest無変更。
