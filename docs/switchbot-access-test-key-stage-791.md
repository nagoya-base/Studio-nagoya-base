# 37DD 段階承認型 API 単体試験 手順（Issue #791 / #756 第1段階）

検証専用GAS `SwitchBot Access Test` の手動入口。**コード作成・マージ・デプロイ・ARMED設定をもって実API操作GOとはしない。** 実機試験GOは #756 でオーナーが別に決裁する。第2段階（予約連携・境界時刻）はこの試験の対象外。

## 安全設計

| 項目 | 内容 |
| --- | --- |
| 対象 | `ACCESS_ENVIRONMENT=verify` かつ `ACCESS_CONFIG.environment=verify`、`allowedLast4=['37DD']` のみ・keypads 1件で末尾37DD。01FD・他端末・複数端末は通信前に拒否 |
| 本人確認 | `ACCESS_ADMIN_ACTORS` 本人かつ active/effective 一致（不明は拒否） |
| 既存フラグ維持 | `ACCESS_ENABLED` は明示 `false` のときだけ進む。トリガーが1件でもあれば停止。本番ジョブ・配送・Webhook・台帳・メールは使わない |
| 初期状態 | `ACCESS_TEST_KEY_ARMED` 未設定 = 全入口が通信ゼロで停止（`NOT_ARMED`） |
| 段階承認 | `ACCESS_TEST_KEY_APPROVAL` にその段階名が入っているときだけ実行。**通信の前に消費**（再実行・二重押下では通信しない） |
| 回数上限 | SwitchBot API 合計5回（list / createKey / list / deleteKey / list）。呼出し前に永続カウント。自動再送・自動復旧なし |
| 重複防止 | 状態 `ACCESS_TEST_KEY_STATE`（Script Properties）に送信済みマーカーを通信前に永続。永続に失敗したら通信しない。LockService で同時実行を排他 |
| 既存キー保全 | 手順1で既存keyListの件数と指紋(sha256。ID・名前・種別・有効期間の正規化表現)を保存。手順3・5で「試験キー以外が不変」を照合。削除対象は発行確認済みの試験キーIDのみ |
| 対象端末の固定 | 手順1で対象端末の完全IDのハッシュのみ保存。以降の段階で設定の端末が変わっていれば通信前に停止（`TARGET_DEVICE_CHANGED`） |
| 秘匿 | 出力は固定コード・件数・真偽のみ。完全deviceId・パスコード・トークン・passcode ID・キー名・commandId は出さない。試験キーIDは実行者本人の User Properties（`TESTKEY_ID`）にのみ保持し、完了時に削除 |
| 試験キー | 名前 `TST`+8桁英数、`timeLimit`、有効1時間（自然失効の保険）。パスコードは8桁乱数で保存・出力しない |

## 入口関数（エディタから引数なしで1回ずつ）

`accessTestKeyStatus`（通信なし・状態確認） / `accessTestKeyStep1List` / `Step2Issue` / `Step3VerifyIssued` / `Step4Delete` / `Step5VerifyDeleted`

| 段階 | 承認値 | 通信 | 成功条件 |
| --- | --- | --- | --- |
| 1 | `LIST` | list 1回 | 端末が完全IDで1件一致・keyList完全・試験キー形式の残骸なし |
| 2 | `ISSUE` | createKey 1回 | 受理（commandIdなしでも可。証跡区分 `API_ACCEPTED_NO_COMMAND_ID` を分ける）。容量ゲート通過 |
| 3 | `VERIFY_ISSUED` | list 1回 | 試験名が厳密1件・件数=基準+1・既存キー不変・返却された種別/有効期間が要求(timeLimit・手順2で永続した開始/終了)と矛盾しない（根拠は keyList） |
| 4 | `DELETE` | deleteKey 1回 | 受理 |
| 5 | `VERIFY_DELETED` | list 1回 | 試験キーのID・名前が不在・既存キー不変 → `COMPLETE` |

## 当日の操作（オーナー）

0. 事前（通信ゼロで点検可）: `accessTestKeyStatus` を実行 → `gates=PASS`、`armed=OFF`、`state=INIT`、`callsUsed=0` を確認。資格情報の登録は #770 の別承認ステップ（このIssueでは実値入力なし）。
1. 当日GO後、Script Properties に `ACCESS_TEST_KEY_ARMED=true`。
2. 段階ごとに `ACCESS_TEST_KEY_APPROVAL=<段階名>` を設定 → 対応する Step 関数を1回実行 → 結果コードを確認 → 次へ。
3. 完了（`TEST_KEY_VERIFY_DELETED_OK` / `state=COMPLETE`）後、`ACCESS_TEST_KEY_ARMED` を削除。

## 停止・手動復旧

結果が `STOPPED_MANUAL_RECOVERY` / `INTERRUPTED_MANUAL_RECOVERY` / 各エラーコードのとき、**以後の変更操作は自動で止まる**（再送・自動削除なし）。
1. `ACCESS_TEST_KEY_ARMED` を削除し、公式アプリで37DDのキー一覧を確認する。
2. 名前が `TST` で始まる試験キーが残っていれば、**公式アプリで手動削除**。既存の通常キーは触らない。端末に依存しない代替解錠手段を確保したうえで行う。
3. 状態をレビューしてから、再試験する場合は `ACCESS_TEST_KEY_STATE` を削除（回数カウントも初期化されるため、再試験はオーナー判断として #756 に記録）。
4. `UNKNOWN`/不整合の発生時は、結果コード・回数・時刻のみを #756 に記録する（秘密情報・ID・キー名は書かない）。

## 検証

`test/switchbot-access-test-key-stage-791.test.js`（モック）: 正常5回、ARMED未設定、段階承認、二重押下、ロック競合、認可失敗、OFF維持・verify不一致、01FD混入、トリガー有無、資格情報欠落、タイムアウト/結果不明、受理済み拒否、commandIdなし、既発行・容量、対象外削除拒否、削除未反映、中断マーカー、永続失敗、回数上限、ログ秘匿、シェル経由の通し、既存診断の回帰。
