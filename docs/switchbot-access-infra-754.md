# 独立GAS基盤・鍵管理（Issue #754 PR-B）— 構成・権限・容量・保持・運用手順

実装: `gas/switchbot-access/SwitchBotAccessInfra.gs`（純粋ロジック）／`SwitchBotAccessApp.gs`（GASシェル）／`AccessLedgerReader.gs`（台帳の最小列読取）／`appsscript.json`。コアは `SwitchBotAccessCore.gs`。
テスト: `test/switchbot-access-infra-754.test.js`・`test/switchbot-access-gas-shell-754.test.js`。配布物の組み立て: `node scripts/prepare-switchbot-access-gas-project.js <出力先>`（**組み立てのみ。デプロイしない**）。

**本書とPRは「コード/構成」の証跡。** マージ・生成物の作成は、デプロイ・トリガー作成・Webhook登録・Script Properties設定・機能ONの許可ではない（それぞれ別の実施判断・別証跡。末尾「証跡の分離」）。実APIはPR/CIから呼ばない（テストはフェイクのみ）。契約の正本は `docs/switchbot-access-key-748.md`（#750）。

## 1. 構成と責務

| 要素 | 内容 |
|---|---|
| 独立GAS | 予約GAS・`switchbot-verify`（検証）とは別プロジェクト。既存Webhookを置換・削除しない（本基盤用に新しい常設受信先を別に持つ） |
| 入口 | ① Webアプリ `doPost`（SwitchBot Webhook、共有トークン認証）② 時間主導トリガー（照合5分／期限切れ・回収1時間／監視15分／配送5分※）③ 管理者関数（エディタ実行・認可必須） ※配送は #752 接続後のみ |
| 台帳 | Bookingsを**読み取り専用スコープ**で最小列のみ読む（氏名・メール・電話・目的・人数は読まない）。必須列は `AccessLedgerReader.REQUIRED_COLUMNS`。列が欠ければ照合を止めて通知（revision未migrationで動かさない） |
| 照合対象 | 当日・翌日(JST)のSNB予約 ∪ 鍵操作記録（未解決OP）が残る予約（日付を問わない）。日付が動いても旧キーの削除確認を継続（#750の和集合） |
| 状態機械 | コア（`createEngine`）。本基盤はロック・認証・容量・保持・通知・監視を被せる |

### 照合サイクル（`syncCycle`）
`ロック取得 → 環境名確認 → 受信箱取込 → 未送達通知の再送 → フラグ確認 → API予算確認 → 台帳読取 → 予約ごとに build/toCoreInput → FREEZE(通知のみ)/digest不一致(停止)/triggers判定 → 静穏時間 → engine.sync`。
- **静穏時間**: 同じ(revision, digest)を `quietSec`(既定60秒)以上前から観測している場合のみ `sync`（日時変更直後の料金精算など中間状態で発行しない）。5分周期なので変更は通常2周期で反映。
- **実行時間予算**: `runBudgetSec`(既定240秒＝GAS上限6分に余裕)を超えたら残りを次周期へ。未解決予約を先に処理。
- **発行ゲート停止（容量・保存・API予算）**: OPを作れなかった予約は revision・発行窓を「未処理」のまま保持し、`gateRetrySec`(既定600秒)間隔でゲートを再評価する。停止が続く間は発行せず通知も重複しない。解消後の次の照合で同revisionのまま1件だけ発行する（発行対象から脱落しない）。進行中OPの照合は保留しない。
- 例外は握りつぶさず `SYNC_ERROR`（固定分類・詳細非公開）で中断して通知。**予約・決済・返金の処理へは何も伝播しない**（独立GASであり予約GASへの書込み経路を持たない）。

## 2. 認証・認可・相関

- **Webhook**: URLクエリ `t` を定数時間比較で `WEBHOOK_SHARED_TOKEN` と照合。期待値が24文字未満/未設定なら**全拒否**。未認証は何も保存せず、応答は固定 `{"ok":false}`。
- **相関**（認証後）: 最小項目へ正規化（生ペイロード・未知項目は保存しない）→ ① Keypad系イベント ② `deviceMac` が対応表の端末 ③ 操作(createKey/deleteKey)＋commandId が**進行中の操作（SENT_WAIT_WEBHOOK／DELETE_SENT）と一致**、の全てを満たす場合のみ保存。重複は初回維持、食い違う重複は矛盾印（成功根拠にしない）。到着時刻を保存し、コアが期限内/前後関係を判定（削除側にも「送信前に受信した古いイベントは不採用」を追加＝commandId再利用・残存イベントの誤流用防止）。
- **フラグOFFでも**、進行中操作の確認に必要なWebhookは相関つきで取り込む（ロールバック中の削除確認を止めない）。
- **管理者操作**: エディタ実行で `Session.getActiveUser()` のメールを許可リスト `ACCESS_ADMIN_ACTORS`（メール→非個人情報ラベル）と照合。**操作者はサーバー側でラベルとして確定**し、クライアント指定の actor は存在しない（関数引数にも無い）。メール自体は状態・履歴・通知に残さない。変更系(reconcile/resolveUnknown/delete)は**監査の事前記録(ATTEMPT)に失敗したら実行しない**。結果(OK/固定エラー)を事後記録。履歴は `ADMINLOG_*`（保持90日）。
- トリガーの設置/撤去（`accessInstallTriggers`/`accessRemoveTriggers`）も同じ認可。

## 3. 排他（単一ロック領域）

- sync / deliver / sweep / Webhook取込 / 管理者復旧 は**すべて同一のScriptLock**の下でのみ状態を更新する（`createLockDomain`）。コアの `deps.lock` は「外側の単一ロック保持を確認するだけ」で別ロックを取らない（保持していなければ例外＝排他外の更新を禁止）。
- **別GASプロジェクト間のScriptLock共有は仮定しない。** 予約GASは鍵状態を書かない（台帳の読取のみ）ため、状態の更新者は独立GASに集約される。
- 取得失敗/`tryLock`例外時は**何も送信せず見送り**。取得後は**キャッシュなし**のストアから再読込（コアは毎回 `load`）。連続3回の取得失敗で `LOCK_UNAVAILABLE` を通知。
- Webhookのロック取得待ち(8秒)に失敗した場合のみ、同じ認証・対象検証を満たした最小項目を**受信箱(`INBOX_*`)**へ退避（単一キー書込み・上限50件・TTL15分・到着時刻つき）。次のロック下の照合で相関して取り込み、不一致は期限後に回収。上限超過は `WEBHOOK_INBOX_FULL` を通知（該当操作は期限後にUNKNOWNとして安全停止）。

## 4. 保存先・権限（秘密と状態の分離）

| 領域 | 内容 | 実効アクセス |
|---|---|---|
| **Script Properties** | 設定 `ACCESS_CONFIG`(JSON・秘密なし)、`ACCESS_ENABLED`、`ACCESS_ENVIRONMENT`、`LEDGER_SPREADSHEET_ID`、`ACCESS_ADMIN_ACTORS`、状態（`OP_/BK_/EVT_/ALERT_/TRK_/INBOX_/IALERT_/ADMINLOG_/HB_`…） | プロジェクトの編集者が閲覧可。完全deviceIdは設定/状態に含むため**非公開環境でのみ閲覧** |
| **User Properties**（デプロイ実行者本人） | `SWITCHBOT_TOKEN`、`SWITCHBOT_SECRET`、`WEBHOOK_SHARED_TOKEN`、パスコード(`SECRET_*`) | 実行者本人のみ。Webアプリ/時間主導トリガーは実行者として動くため読めるが、**他の編集者は読めない** |

- 帰結: SwitchBot資格情報を使う操作（管理者の個別削除など）は**デプロイ実行者のアカウントでのみ**実行可能。管理者不在時の引継ぎは §10。
- 状態に出さないもの: パスコード・Token/Secret・共有トークン・メールアドレス・Webhook生ペイロード・例外詳細。通知/棚卸し/status は末尾4桁までの端末表示。
- 漏洩時: `WEBHOOK_SHARED_TOKEN` は新値へ更新→SwitchBot側Webhook URL更新（別手順・別証跡）。API資格情報はSwitchBotアプリで再発行→User Propertiesを更新。発行済みコードは `inventory` で棚卸し→個別削除。
- 環境分離: 検証用と本番用は**別のGASプロジェクト・別のProperties**。`ACCESS_ENVIRONMENT`＝設定の`environment`、`allowedLast4`（環境ごと）外の端末が対応表にあれば起動しない（本番に自宅検証機37DD、検証に本番機01FDを載せられない）。状態ストアに環境名(`META_ENV`)を刻み、別環境のストアを開いた場合は `ENV_MISMATCH` で停止。

## 5. 容量

### 5.1 Keypad登録件数（新規発行の安全ゲート）
- 判定は発行直前に対象端末の `keyList` 全件数（期限切れ未削除を含む）を読む。**閾値(`capacity.stopAt`)は設定必須でコードに既定値を持たない。** 未設定/不正/`officialLimit`超過/件数取得不能は**すべて新規発行停止**＋管理者通知（予約・決済は取り消さない。管理者の代替入室へ引き渡す）。削除・照合は止めない。
- **80件・90件は推奨案/未確認の前提であり、本PRは採用しない**（運営承認後に `ACCESS_CONFIG.capacity` へ設定）。01FDの機種別公式上限・登録19件の区分内訳・期限切れ3件の棚卸し（非公開環境で1件ずつ。一括削除しない）・繁忙期ピークは**未確認**で #756 前に確認する。

### 5.2 状態保存（Script Properties）
- 公式クォータ（デプロイ前に最新値を再確認）: 1値 9KB／全体 500KB（`PROPERTIES_LIMITS`、設定で上書き可）。
- ゲート: 全体の使用量(キー名+値のUTF-8)が70%、または1値が80%に達したら**新規発行停止**＋通知（`STORAGE_NEAR_LIMIT`/`STORAGE_VALUE_NEAR_LIMIT`）。`status` で接頭辞別内訳を確認。設定プロパティ分(数KB)は計測外のため閾値の余裕で吸収する。
- 見積もり（テスト内、実測レコードから算出）: OP平均 約0.6KB。予約**4件/月**・変更1回/予約・未解決OP 20件の想定で、保持30日 約**9%**／月12件(3倍負荷)で約**16%**／保持180日(4件/月)で約**26%**（停止閾値70%に対して余裕）。実測した1値の最大は約0.6KB（9KB上限の1割未満）。**試算であり実測運用値ではない**。不足が見込まれる場合は権限を限定した専用ストア（別シート等）へ移す（本PRは移行しない）。
- 予約数・履歴・未解決滞留・索引(BK/TRK)・EVT/ALERT・通知記録・管理ログを見積もりの項目に含む（`estimateStorage`）。

## 6. 保持・回収（`garbageCollect`、sweep時にロック下で実行）

| 対象 | 回収条件 | 保護 |
|---|---|---|
| OP | コア `sweep`: 終端状態かつ `retentionSec`(既定30日)超過 | 未解決(UNKNOWN/送信中/配送待ちISSUED等)は無期限保持 |
| BK索引 | 参照切れOP項目を除去。OPが無くなり未解決もなく `touchedAt` から30日超過で削除。年齢不明は今から起算 | OPが残る間・未解決OPがある予約 |
| EVT(Webhook) | `receivedAtSec` から30日超過かつ**未解決OPのcommandIdを参照していない** | 未解決OPが待つcommandIdのイベント |
| ALERT(重複抑止) | 参照元OPが存在しない（孤立） | OPがある間（OP破棄時にコアが連動削除＝ID再利用時に通知を抑止しない） |
| SECRET(パスコード) | OPが無い／終端OP。ロック下のため送信中の秘密は存在しない | 未解決・配送待ちOPの秘密 |
| TRK(照合観測) | 最終観測から30日超過 | 未解決OPのある予約 |
| INBOX | TTL(15分)超過 | — |
| IALERT(基盤通知) | **送達済み**から30日超過 | 未送達は保持 |
| ADMINLOG | 90日超過 | — |

- **#680の180日方針との関係**: 本基盤の保持は予約IDの参照・固定コード・時刻のみで、氏名等の個人情報を持たない。各保持は#680の上限(180日)以内（既定30日／管理ログ90日）で、**#680への適合を本実装の証跡とはしない**（個人情報消去は予約GA側の責務）。コアの終端OP既定30日を保存全体の期限とも扱わない（表のとおり種別ごとに定義）。
- 古いWebhook・ID再利用: 回収されるまで残る古いイベントは、コアが「送信前受信／期限後」を理由に不採用→UNKNOWNへ安全停止（成功扱いにしない）。回収後は新しいイベントを受け付ける（テストで固定）。

## 7. ジョブ周期・読取上限・API制限（**設計値。実測値ではない**）

`planJobs(cfg)` が整合を検証して決める（`basis` に根拠区分）。

| 項目 | 値 | 根拠区分 |
|---|---|---|
| 照合周期 | 5分 | DESIGN |
| `maxReads` | 3 | UNMEASURED_DEFAULT |
| `webhookWaitSec` | 90 | UNMEASURED_DEFAULT（#718の1分タイムアウトに余裕。実測は#756） |
| `readWaitSec`（commandIdなし削除の読取窓） | `(maxReads-1)×周期+120秒`＝**720秒** | DERIVED_FROM_CYCLE |
| 静穏時間／実行予算 | 60秒／240秒 | DESIGN |
| API日次予算 | 8,000回/日（公式上限10,000回に対する余裕） | DESIGN_MARGIN |

- **重要な導出**: 読取は照合ジョブの周期でしか進まないため、コア既定の600秒では3回目の読取前に `READ_LIMIT` で停止し得る（5分周期＋ばらつき）。周期から導出した720秒ではテストで3回目の読取で確定できることを確認。`readWaitSec` を短く設定すると `READ_WINDOW_TOO_SHORT_FOR_CYCLE` を警告。
- API呼び出しは日次カウンタ(JST日)で永続化。予算到達で**読取もfail-closed**＝変更APIに進まず見送り＋通知。通常運用では発行・削除・確認時のみ呼ぶ（1日10,000回に対し十分小さい見込み）。**実測は #718 の得られる計測根拠＋#756の限定検証で行い、未計測の値は未計測と記録する。**

## 8. 通知・監視

- **固定分類**（`CATALOG`: 未解決/残存キー/失敗/容量/配送/基盤/凍結）。コアが出す全コードが分類済みであることをテストで固定。本文は固定文言＋検証済み識別子（予約参照・revision・末尾4桁・状態・環境）のみ。自由文・例外メッセージ・秘密・完全ID・個人情報は出さない。
- 重複抑止: コアは record×code、基盤通知は事象キー×`notifyRepeatSec`(24時間)。**通知失敗は記録せず次周期で再試行**（コア）／基盤通知は指数バックオフで再送（`IALERT_*`）。連続失敗は `status.notifyFailingSince`／`notifyOutbox.pending` で確認できる（通知経路そのものの故障はメールでは届かないため、管理者が `accessAdminStatus` を定期確認する運用で拾う。定期確認の担当・頻度は運営が決める）。
- 監視（`accessWatchdogJob`、ロック不要の読取のみ）: 有効時に照合ハートビートが15分以上止まれば `JOB_STALE`。`accessAdminStatus` で件数・未解決・保存使用率・ハートビート・API使用数・未送達通知を確認（秘密なし）。
- 通知先は設定 `adminMailTo`（非公開）。**公開の通知・Issue・PRに個人情報を含めない。**

## 9. OFF時の管理（ロールバック）

- `ACCESS_ENABLED` を `true` 以外にすると、新規発行・自動削除・台帳読取・配送が止まる。**既存キーは消えない。**
- OFFでも使える: `accessAdminStatus`／`accessAdminInventory`（棚卸し）／`accessAdminInspect`（読取）／`accessAdminReconcile`（読取のみの再開）／`accessAdminResolveUnknown`（keyListで検証して確定/放棄）／`accessAdminDelete`（個別削除）、進行中操作のWebhook取込、`sweep`/回収。
- 手順: ① `ACCESS_ENABLED` を外す → ② `inventory` で未解決を棚卸し → ③ 期限・残存を確認、必要な個別削除 → ④ 代替入室を案内 → ⑤ 直前の正常版へコード復旧（**状態データは削除しない**。ロールバックを契機に createKey/deleteKey を再送しない）→ ⑥ `status` で整合を確認。トリガーの撤去は `accessRemoveTriggers`（状態は残る）。

## 10. 障害時の代替入室と引継ぎ（秘密は本書・公開面に書かない）

代替手段の**存在**は運営確認済み: ① 管理者による手動解錠 ② 管理者による手動パスコード発行 ③ キーボックス内のバックアップ物理キー。**存在を確認しただけで運用体制・試験完了とは扱わない**（#756/#757で限定検証）。

| 手順 | 内容 |
|---|---|
| 一次対応 | UNKNOWN/FAILED/残存/容量/JOB_STALE の通知を管理者が受け、`accessAdminStatus` で確認。管理者が本人・予約・対象施設・安全性を確認して代替入室を案内（自動公開・無差別通知しない） |
| 管理操作の認可 | §2。実行者はサーバー確定ラベル＋`ADMINLOG` |
| 自動鍵操作がUNKNOWNでも | 予約・決済は巻き戻さない。管理者が代替対応を行った**事実**を、秘密なしで `ADMINLOG`／Issueの証跡に残す |
| 管理者不在時の引継ぎ | 許可リストに2名以上のラベルを登録（運営判断）。SwitchBot資格情報を使う操作は**デプロイ実行者のアカウント**に依存するため、実行者不在時は運営者が新しい実行者でProperties再設定・再デプロイ（別手順・別証跡）。引継ぎ先は運営が個別に伝達 |
| バックアップキー | 貸出/返却の記録（日時・貸出先ラベル・理由・返却確認）を非公開の運営記録に残す。紛失/未返却時は発行済みコードの失効・錠の交換要否を運営が判断 |
| **載せてはいけない情報** | キーボックスの所在地・開錠コード・鍵の詳細・手動発行パスコード等は、GitHub・CI・管理者向け一般通知・予約確認/暗証番号案内メールに**一切載せない**。許可された担当が必要時に個別かつ安全に提供する |

## 11. デプロイ・撤去手順（実施は別判断・別証跡）

**組み立て**: `node scripts/prepare-switchbot-access-gas-project.js .gas-deploy/switchbot-access`（コミットしない）。GitHub Actionsによるデプロイ・ロールバックは `docs/switchbot-access-gas-deploy-768.md`（#768/#778。手動起動＋毎回の確認入力のみ。自動デプロイなし）。
**必要権限**: 新規GASプロジェクトのオーナー（=デプロイ実行者）、台帳スプレッドシートの**閲覧権限**（読取専用スコープ）、通知用メール送信（MailApp）、Webアプリ公開（実行者権限・匿名到達）。OAuthスコープは `appsscript.json` を参照（書込み権限なし）。
**準備**（デプロイ前）: ①検証/本番を別プロジェクトで作成 ②User Propertiesに資格情報3種（登録手順: `docs/switchbot-access-credentials-770.md`） ③Script Propertiesに設定一式（`accessCheckSetup` で SET/MISSING のみ確認） ④`ACCESS_ENABLED` は**設定しない（OFF）** ⑤管理者許可リスト登録。
**デプロイ後の読取診断**: `accessCheckSetup`（値を出さない）→ **`accessReadOnlyDiagnostics`（#774。副作用なしの真正の読取専用。下記 §11.1）**（`accessAdminStatus` は状態を書き込むため、初期確認には使わない）→ 1回だけ手動で `accessSyncJob`（OFFのため `FLAG_OFF`）→ トリガー設置（`accessInstallTriggers`）。Webhook URLの登録は検証用（37DD）から別手順で行い、**既存Webhookを自動で上書き・削除しない**。
**撤去**: `ACCESS_ENABLED` を外す → `accessRemoveTriggers` → 未解決の棚卸し/個別削除 → Webhook登録の解除（別手順）→ プロジェクト削除は状態の棚卸し完了後。

### 11.1 読取専用診断 `accessReadOnlyDiagnostics`（Issue #774）

**目的**: 本番の独立GAS（SwitchBot Access Production）の初期設定が正常かを、**鍵発行OFF・トリガーなし・SwitchBot API通信なし・秘密/個人情報の表示なし**で確認する。コードを反映しただけでは何も起きない。運営者がエディタから手動で1回実行する（マージ・本節は、デプロイ・機能ON・実機通信・Webhook登録・トリガー作成の承認ではない）。

**`accessAdminStatus` との違い**: `accessAdminStatus` は内部で排他ロックを取り、環境刻印（`META_ENV`）・ハートビート等を**書き込む**ため純粋な読取りではなく、戻り値もログに出ない（「実行完了」のみ）。本診断は書込み・ロック取得をせず、結果の固定JSONを必ずログに出す。初期確認には `accessReadOnlyDiagnostics` を使い、`accessAdminStatus` は管理者復旧用として使い分ける。

**手順（Windows・ブラウザ。1操作ずつ）**
1. ブラウザで、デプロイ実行者本人のGoogleアカウントにログインした状態で、スタンドアロンGAS「SwitchBot Access Production」を開く。
2. 左メニュー「プロジェクトの設定」で、反映済みのファイル（`SwitchBotAccessApp.gs` 等）に今回の版が入っていることを確認する（反映は別途レビュー後に運営者が手動で行う）。
3. 左メニュー「エディタ」を開き、上部の関数選択プルダウンで **`accessReadOnlyDiagnostics`** を選ぶ。
4. 「実行」を1回だけ押す。初回のみ権限の承認画面が出ることがある（台帳の読取り権限。**書込み権限は求められない**）。内容を確認し、本人アカウントで許可する。資格情報の再入力は求められない。
5. 画面下部の「実行ログ」に1行のJSONが出る。**出ない場合・「実行完了」だけの場合は異常**として止め、手順を繰り返さず運営担当へ連絡する。

**成功の見方**: ログの先頭付近が `"ok":true,"code":"DIAGNOSTICS_OK","failures":[]` で、次の状態になっている。
- `identity`=`AUTHORIZED`、`accessEnabled`=`OFF`、`environment`=`PRODUCTION`
- `config.state`=`VALID`、`config.envMatch`=`MATCH`
- `settings` の4件と `credentials` の3件がすべて `SET`
- `ledger.state`=`LEDGER_ACCESS_OK`（`headers`=`COMPLETE`、`columnFormat`=`OK` か `NO_DATA`）
- `store.state`=`EMPTY_UNINITIALIZED`（まだ一度も動かしていない正常な空）または `INITIALIZED`、`store.gate`=`OK`
- `notes` に `CREDENTIAL_VALIDITY_NOT_VERIFIED`: **資格情報が実APIで有効か・実機に通じるかは確認していない**（確認対象外。#756の限定実機で扱う）。

**失敗時の止め方**: `ok`が`false`なら、`code`（最初の失敗）と`failures`（全件）を控えて**そこで止める**。トリガー作成・`ACCESS_ENABLED` のON・Webhook登録へ進まない。設定を直す前に値を調べてログ・チャットに貼らない（診断結果自体は秘密を含まないので共有してよい）。
| コード | 意味と対処 |
|---|---|
| `IDENTITY_UNAVAILABLE` / `NOT_AUTHORIZED` / `ACCOUNT_MISMATCH` | 実行者が `ACCESS_ADMIN_ACTORS` の許可された本人ではない（または取得できない）。他の情報は一切表示しない。本人のアカウントで開き直す |
| `ACCESS_NOT_OFF` / `ACCESS_STATE_UNKNOWN` | `ACCESS_ENABLED` が明示OFF（未設定または`false`）ではない。以降の診断は実施しない。ONなら運営判断で停止、想定外の値は設定を確認 |
| `SETTINGS_INCOMPLETE` / `CREDENTIALS_INCOMPLETE` | 設定4件または資格情報3件のどれかが `MISSING`/`UNKNOWN`。`UNKNOWN`は読取失敗（未設定とは別）。`accessCheckSetup`で再確認 |
| `ENV_NOT_PRODUCTION` / `CONFIG_INVALID` / `CONFIG_PARSE_ERROR` / `CONFIG_NOT_OBJECT` | 環境が本番でない、設定JSONが不正、設定の環境名と `ACCESS_ENVIRONMENT` の不一致。`config.errors` の固定コードで原因を絞る |
| `LEDGER_AUTH_REQUIRED` | GASの権限承認が未完了。手順4の承認画面で許可して再実行 |
| `LEDGER_ACCESS_DENIED` | 台帳スプレッドシートの閲覧権限がない。台帳の所有者に閲覧権限を依頼 |
| `LEDGER_SCOPE_INCOMPATIBLE` | 呼んだサービスが宣言済みOAuthスコープで承認されない（#776）。**スコープを自分で広げない**。運営担当へ連絡（§11.2） |
| `LEDGER_API_DISABLED` | Google Sheets API が、このGASの紐づくGoogle Cloudプロジェクトで有効でない（#776）。§11.2 の手動確認手順へ |
| `LEDGER_NOT_FOUND` | 台帳IDが存在しない（#776）。Script Propertiesの `LEDGER_SPREADSHEET_ID` を運営担当が確認（値は共有しない） |
| `LEDGER_RATE_LIMITED` / `LEDGER_TOO_LARGE` / `LEDGER_TIMEZONE_UNSUPPORTED` | クォータ制限（時間をおいて1回だけ再実行）／台帳が20000行を超えた（切り捨てず停止）／台帳のタイムゾーンを解釈できない（日時を誤読しないため停止）（#776） |
| `LEDGER_ID_MISSING` / `LEDGER_READ_FAILED` | 台帳IDの未設定、またはその他の読取失敗（本文は表示しない） |
| `LEDGER_SCHEMA_INVALID` | `Bookings` シートが無い、必須列の不足/重複、または末尾最大200行の `startAt`/`endAt` が日時として読めない。台帳の改変を確認（予約者名・メール等の列は読まない。予約ID・日時は検査のためメモリ内で読むが表示しない） |
| `STORE_ENV_MISMATCH` / `STORE_INCONSISTENT` / `STORE_RECORD_INVALID` | 状態ストアの環境刻印が本番と違う／刻印なしでデータだけある／操作記録が壊れている。触らず運営担当へ |
| `STORAGE_NEAR_LIMIT` / `STORAGE_VALUE_NEAR_LIMIT` / `STORE_READ_FAILED` | 保存容量が上限に近い／状態の読取失敗 |
| `UNEXPECTED_ERROR` | 想定外の例外（本文は出さない）。再実行せず連絡 |

**守っていること**: 出力は固定キー・固定コード・`SET`/`MISSING`/`UNKNOWN`・集計値のみ（ホワイトリストで検証し、自由文・ID・URL・メールは`INVALID_VALUE`に置換）。台帳は、ヘッダーと末尾最大200行の `bookingId`・`startAt`・`endAt` の3列だけを検査のためにメモリ内で読み（空行の除外と日時形式の判定）、値は表示・記録せず、行数・検査行数と固定コードだけを返す（氏名・メール・電話等の列は読まない）。**検査は末尾最大200行のサンプル診断であり、全レコードの整合性を保証しない**。状態ストアは接頭辞別の件数（許可リスト外は`OTHER`）と未解決の操作件数だけで、個別キー名・内容・履歴は出さない（`ACCESS_*`/`LEDGER_*`/`BOOTSTRAP_*` は件数に含めない）。`setProperty`/`deleteProperty`、`LockService`、`MailApp`、`ScriptApp`（トリガー）、Sheets書込み、SwitchBot API、鍵の発行/削除、ジョブ実行、Deployment変更、機能ONは行わない（テストで0件を確認）。

### 11.2 台帳読取の方式と権限（Issue #776）

**原因（コードと公式仕様から特定。実機での確定は未了）**: `appsscript.json` は `spreadsheets.readonly` のみ宣言しているが、従来の `SpreadsheetApp.openById` の承認スコープは公式仕様上 `https://www.googleapis.com/auth/spreadsheets`（書込み可）のみで、読取専用スコープでは呼べない。例外は固定コードへ潰していたため、診断は `LEDGER_READ_FAILED` としか出なかった。台帳IDの一致は確認済みなので、スコープ不一致が最有力。ただし**実機で例外を確認したわけではない**。

**対応**: スコープを広げず、台帳の読取を **Sheets API v4 の REST（`values.get` / `values:batchGet`、GETのみ）**へ変更した。`UrlFetchApp`（既存の `script.external_request`）と `ScriptApp.getOAuthToken()`（`spreadsheets.readonly` を含む承認トークン）を使い、`appsscript.json` の `oauthScopes` は**変更していない**（#768 の新スコープ手動承認ゲートの対象外）。診断（`accessReadOnlyDiagnostics`）と本番照合（`syncCycle`）は同じ入口 `sba_openLedgerSheet_` を通るため、「診断だけ成功・本番だけ失敗」は構造上起きない。

| 項目 | 設計 |
|---|---|
| 読取範囲 | ヘッダー行（`1:1`）、`bookingId` 列（最終行の決定）、必須14列のみ（個人情報列は取得しない）。列はヘッダー名で解決（列の追加・入替に耐える） |
| ページング・上限 | 2000行単位のバッチ読取。**20000行**を超える台帳は切り捨てず `LEDGER_TOO_LARGE` で止める |
| 値の型 | 書式なし値＋日時はシリアル値で要求（ロケール依存の表示文字列に頼らない）。日時列の数値は、スプレッドシートのタイムゾーンの壁時計として `Date` に変換（`Asia/Tokyo`/UTC は固定、他は `Utilities.formatDate` で解決、解釈不能は `LEDGER_TIMEZONE_UNSUPPORTED` で停止）。ISO文字列で保存された日時はそのまま渡し、既存の `AccessKeySnapshot` の契約（`Date`/ISO文字列）を保つ |
| 失敗の分類 | `LEDGER_SCOPE_INCOMPATIBLE` / `LEDGER_AUTH_REQUIRED` / `LEDGER_ACCESS_DENIED` / `LEDGER_API_DISABLED` / `LEDGER_NOT_FOUND` / `LEDGER_RATE_LIMITED` / `LEDGER_TOO_LARGE` / `LEDGER_TIMEZONE_UNSUPPORTED` / `LEDGER_SCHEMA_INVALID` / `LEDGER_READ_FAILED`。HTTP本文・例外本文・ID・スタックは保持も出力もしない。本番の通知も同じ固定コードを使う |
| 書込み | GET以外を呼ばない（静的テストで `post/put/patch/delete`・`:append`・`:batchUpdate` 等の不在を検査）。実台帳は更新しない |
| 回帰防止 | 静的テスト: `spreadsheets` スコープが無い限り `SpreadsheetApp`/`openById` 等を `.gs` から呼べない（呼ぶとCIが落ちる） |

**残る不確実性（運営者の手動確認が必要。コードでは確定できない）**
1. **Google Sheets API の有効化**: REST 呼出は、GASが紐づくGoogle Cloudプロジェクトで Sheets API が有効であることを求める。標準の既定プロジェクトでは無効の場合があり、その場合は診断が `LEDGER_API_DISABLED` になる。有効化にはプロジェクトの設定（GCP側での API 有効化、または標準GCPプロジェクトへの切替）が必要で、これは**運営者の判断・操作**（本PRのマージでは実施されない）。有効化できない場合は代替案（Advanced Sheets Service など。`appsscript.json` の変更と、必要スコープ・書込みリスクの明記、運営者承認が必要）を別途レビューする。
2. **`ScriptApp.getOAuthToken()` が `spreadsheets.readonly` を含むこと**: 公式仕様上は宣言スコープが含まれるが、実機で未確認。含まれない場合は `LEDGER_SCOPE_INCOMPATIBLE`/`LEDGER_ACCESS_DENIED` になる。
3. 診断の結果は、実台帳を使った実機確認までは「テスト上のフェイク」での検証に留まる。

**手動確認手順（Windows・ブラウザ。本PR反映後。反映は #768 のゲートに従い運営者が判断）**
1. §11.1 の手順で `accessReadOnlyDiagnostics` を1回実行する（`ACCESS_ENABLED` はOFFのまま。トリガー作成・自動デプロイON・機能ONは行わない）。
2. ログの `ledger.state` を確認する。`LEDGER_ACCESS_OK` なら読取成功（`headers`=`COMPLETE`、`rows` は台帳の件数と概ね一致）。
3. `LEDGER_API_DISABLED` なら上記不確実性1の対応を運営者が判断する。`LEDGER_SCOPE_INCOMPATIBLE`/`LEDGER_ACCESS_DENIED`/`LEDGER_AUTH_REQUIRED` は結果コードを控えて止める（権限を広げて回避しない）。
4. 結果が `LEDGER_ACCESS_OK` になるまで、#754 / #756 / #757 のゲートは維持する（診断失敗の保持）。

### 証跡の分離（本PRの範囲外・別記録）
| 区分 | 記録する内容 | 本PR |
|---|---|---|
| コード/構成のPR・CI | PR番号・head・CI結果 | ✔（PR本文） |
| 環境準備 | 実施判断・日時・実施者ラベル・結果（検証/本番別） | ✘ 未実施 |
| デプロイ | 実施判断・日時・版（コミット）・結果 | ✘ 未実施 |
| 読取診断 | 日時・版・結果（秘密なし） | ✘ 未実施 |
| 実機・本番有効化 | #756／#757 | ✘ 未実施 |

## 12. 未実施・後続
- 配送(#752)の接続（`deliveryConfigured` は未接続でfalse。配送は前日18:00以降・別メール）。
- 環境準備・デプロイ・読取診断・Webhook登録（別証跡）。revision列の本番migration（#753）。
- Keypad機種別上限・停止閾値の運営承認（80件は未承認の推奨案）、既存19件の棚卸し。
- ジョブ周期・読取上限・API予算の実測（#718の根拠＋#756）。入室中延長の方式。
- 管理者の2名体制・バックアップキー運用の運営確定。
