# 37DD 数値型ID維持 createKey→deleteKey 最小再試験 手順（Issue #797 / 親 #756・原因調査 #793）

独立GAS `SwitchBot Access Test` の37DDだけで、**取得した `keyList.id` の型を保ったまま `deleteKey` を送る**最小の再試験を行う手動入口。**コード作成・PRマージ・デプロイ・ARMED設定をもって実機GOとはしない。** 起票・マージだけで #791 の予算(5/5)のリセットや実機実行を許可した扱いにもしない。このPRは**実機通信ゼロ**で、モック検証のみ。

## 証拠の限界（必ず併記）

- モックが示せるのは「`JSON.stringify` で数値は数値・文字列は文字列のままワイヤに載る」ことと、安全ゲート・予算・停止条件の動作まで。**SwitchBot側が数値IDだけを受理すること、および 11/6 の削除残存の因果は証明しない。**
- #795 の診断結果（`ID_TYPE_NUMBER`）は**現存する通常キー**の型であり、11/6に手動削除済みの試験キー自身の過去の型を示すものではない。
- この再試験で削除が反映されても、単発の成功は再現性・原因の一般化の根拠にならない。反映されなくても「型が原因でない」とは言い切れない（有効期間・端末状態などは未確定）。

## 11/6（#791）との比較表（交絡要因を含む）

| 項目 | 11/6 #791（失敗） | 本試験 #797 | 扱い |
| --- | --- | --- | --- |
| 送る `parameter.id` | `String(hits[0].id)` を User Properties 経由で送信（型を失う） | 削除直前に取得した `keyList.id` を**型付きのまま**保存し、そのまま送信 | **意図した変更点**（`ID_TYPE_PRESERVED`） |
| 削除直前の再照合 | なし（約2分前の保存値を使用） | `PRE_DELETE_LIST` で完全deviceId・試験キーの一意性・通常キー不変・属性を再照合 | **変更点**（`PRE_DELETE_RELIST_ADDED`）。型維持との**交絡**になりうる |
| 削除後GETまでの間隔 | 約5分 | 最短300秒を強制 | **変更点**（`OBSERVATION_MIN_300S`）。条件を揃える方向 |
| キー種別 | `timeLimit` | 同じ | 同一 |
| 開始 | 実行時の60秒前（開始済み） | 同じ | 同一 |
| 有効期間 | 3600秒 | 同じ | 同一 |
| 発行→削除の所要 | 約7分 | 実測秒数を `issueToDeleteSec` に固定コード形式で記録 | 比較用に記録（実値は秘密ではない） |
| 通信基盤 | GAS `UrlFetchApp` | 同じ | 同一 |

出力・状態には `validityProfile=SAME_AS_791` と `changes=[ID_TYPE_PRESERVED, PRE_DELETE_RELIST_ADDED, OBSERVATION_MIN_300S]` を**常に併記**する。有効期間などの値を変える場合は、新たな交絡として #756 に明記したうえで別途GOを得る（この実装は値を変えない）。

## 通信計画（合計6回・各段階1回・再送なし）

| 段階 | 承認値 | 通信 | 成功条件 |
| --- | --- | --- | --- |
| 1 | `LIST` | GET 1回 | 完全deviceIdで端末1件一致・keyList完全・試験キー形式の残骸なし。基準（件数・指紋・ID型）を保存 |
| 2 | `ISSUE` | createKey 1回 | 受理（commandIdなしでも可）。容量ゲート通過 |
| 3 | `VERIFY_ISSUED` | GET 1回 | 試験名が厳密1件・件数=基準+1・通常キー不変・種別/有効期間が要求と矛盾しない・IDの型が数値/文字列のいずれか |
| 4 | `PRE_DELETE_LIST` | GET 1回（**削除の直前**） | 手順3と同じ契約を再照合。ID型が手順3から変化していない・安全な整数。取得した生IDを**型付きのまま**保存 |
| 5 | `DELETE` | deleteKey 1回 | 受理（API受理≠削除成功）。再照合から600秒以内。通常キーIDと一致しない。`parameter.id` は型変換なし |
| 6 | `VERIFY_DELETED` | GET 1回 | 削除受理から300秒以上後。試験キーのID・名前が不在・通常キーの件数/指紋が不変 → `API_ABSENT_APP_PENDING` |
| 7 | `APP_ABSENT` / `APP_PRESENT` | **通信なし** | オーナーが公式アプリで試験キーが消えていることを目視 → `COMPLETE`（残存なら `STOPPED`） |

- 上限は6回で固定（`NID_MAX_CALLS=6`）。**追加の反映確認GETはこの実装に含まれない。** 必要になった場合は、上限・時点・理由を #756 に記録して**別PR・別GO**で扱う。
- 削除後GETの時点で残存していれば、その場で停止（追加GETなし）。以後は公式アプリでオーナーが手動撤去。

## 安全設計

| 項目 | 内容 |
| --- | --- |
| 対象 | `ACCESS_ENVIRONMENT=verify`、`allowedLast4=['37DD']`、keypads 1件で末尾37DD、完全ID一致。**01FD**・他端末・複数端末は通信前に拒否。本番・予約・決済・通知には接続しない |
| 実行者 | `ACCESS_ADMIN_ACTORS` 本人（active=effective）。不明は拒否 |
| 既存フラグ維持 | `ACCESS_ENABLED` は明示 `false` のときだけ進む。トリガー0件。`ACCESS_TEST_KEY_ARMED` / `ACCESS_TEST_KEY_APPROVAL` は**未設定**、`ACCESS_TEST_KEY_STATE` は **`STOPPED`（5/5）のまま**であることを読んで確認する。**書換・削除・リセットはしない** |
| 独立した予算・状態 | `ACCESS_NUMID_TEST_STATE`（Script Properties）。#791 の状態とは別。通信前に回数と送信済みマーカーを永続（永続に失敗したら通信しない） |
| 計画との合致 | `ACCESS_NUMID_TEST_ARMED` は値 `NUMID_PLAN_V1_6CALLS` のときだけ有効（#756 に記録した6回計画との合致の目印。`true` などは `ARMED_PLAN_MISMATCH`） |
| 段階承認 | `ACCESS_NUMID_TEST_APPROVAL` にその段階名が入っているときだけ実行。**通信の前に消費**（再実行・二重押下では通信しない） |
| 型維持 | `PRE_DELETE_LIST` が取得した生ID（数値は数値、文字列は文字列）を `{n, id}` のJSONで User Properties `NUMID_TARGET` に保存し、`DELETE` はそれを**変換せず**に `deleteKey` へ渡す。数値は正の安全な整数のみ（精度を失う値は `ID_NOT_SAFE_INTEGER` で停止） |
| 通常キー保護 | 削除対象は「発行・再照合済みの試験キー」のみ。通常キーのID（基準ハッシュ）と一致すれば `TARGET_IS_BASELINE_KEY` で通信せず停止。名前不一致・型不一致・欠落・再照合から600秒超も通信せず停止。**通常キーを削除する経路は存在しない** |
| 成功判定 | API受理を成功扱いにしない。削除後GETで対象不在＋通常キー保全、さらに**公式アプリの表示確認**（手順7）を経て初めて `COMPLETE` |
| 失敗時 | 失敗・曖昧・タイムアウト・不受理・残存はすべて `STOPPED`（`manualRecovery=true`）。自動再送・自動削除なし。削除対象IDは即消去 |
| 秘匿 | 出力は固定コード・件数・真偽・秒数のみ。完全deviceId・パスコード・トークン・passcode ID・キー名・commandId・例外本文を出さない。試験キーの名前（`TST`+8桁）はキー名として出力しない |

## 入口関数（エディタから引数なしで1回ずつ）

`accessNumIdStatus`（通信なし） / `accessNumIdStep1List` / `Step2Issue` / `Step3VerifyIssued` / `Step4PreDeleteList` / `Step5Delete` / `Step6VerifyDeleted` / `accessNumIdAppCheck`（通信なし）

## 当日の操作（オーナー現地立会い・代替解錠手段あり。**#756 で個別GOが記録されたあとのみ**）

0. 事前に **#756 へ通信回数（6回）・コマンド（GET×4・createKey×1・deleteKey×1）・停止条件を記録**し、この手順書と合致していることを確認する。GO前に Script Properties へ ARMED / APPROVAL を入れない。
1. `accessNumIdStatus`（通信ゼロ）で `gates=PASS`・`prerequisites=PASS`・`state=INIT`・`callsUsed=0`・`legacyState=STOPPED` を確認。**`ok=true` はゲート通過のみで、GOでも実行可能の判定でもない。**
2. GO後、`ACCESS_NUMID_TEST_ARMED=NUMID_PLAN_V1_6CALLS` を設定。
3. 段階ごとに `ACCESS_NUMID_TEST_APPROVAL=<段階名>` を設定 → 対応する関数を1回実行 → 結果コードを #756 に時刻と固定コードのみで記録 → 次へ。`VERIFY_DELETED` は削除受理から5分以上あける（それ未満は `OBSERVATION_WINDOW_NOT_ELAPSED` で通信せず、承認・回数は消費しない）。
4. 公式アプリで試験キーの表示を確認し、`ACCESS_NUMID_TEST_APPROVAL=APP_ABSENT`（消えている）または `APP_PRESENT`（残っている）で `accessNumIdAppCheck` を実行。
5. 終了後（成功・停止とも）`ACCESS_NUMID_TEST_ARMED` を削除。

## 停止・手動復旧

`STOPPED_MANUAL_RECOVERY` / `INTERRUPTED_MANUAL_RECOVERY` / 各エラーコードのとき、以後の変更操作は自動で止まる（再送・自動削除なし）。

1. `ACCESS_NUMID_TEST_ARMED` を削除し、公式アプリで37DDのキー一覧を確認する。
2. 名前が `TST` で始まる試験キーが残っていれば、**オーナーが公式アプリで手動削除**。通常キーは触らない。代替解錠手段を確保したうえで行う。
3. 結果コード・回数・時刻のみを #756 に記録する（秘密情報・ID・キー名は書かない）。
4. **`ACCESS_NUMID_TEST_STATE` を削除・編集して予算を戻す操作は運用上禁止**。#791 の `ACCESS_TEST_KEY_STATE` も同様に触らない。再々試験が必要な場合は、#756 での新たな個別GOと別途の安全レビューを前提とする。

## 結果コード（抜粋）

| コード | 意味 |
| --- | --- |
| `NUMID_<段階>_OK` | その段階が成功（`VERIFY_DELETED` の成功は API 上の不在のみ。`appCheck=PENDING_OWNER`） |
| `NUMID_APP_CHECK_OK` | 公式アプリでも不在を確認（`COMPLETE`） |
| `TEST_KEY_STILL_PRESENT` | 削除後GETで残存（`STOPPED`・手動撤去） |
| `APP_STILL_PRESENT` | API上は不在だが公式アプリに残存（矛盾。`STOPPED`・手動撤去） |
| `DELETE_RESULT_UNKNOWN` / `ISSUE_RESULT_UNKNOWN` | 例外・タイムアウト・不受理（再送しない・`STOPPED`） |
| `ID_TYPE_CHANGED` / `ID_NOT_SAFE_INTEGER` / `TARGET_ID_INVALID` | ID型が途中で変わった／数値が安全でない／対象IDが不正（削除せず `STOPPED`） |
| `TARGET_IS_BASELINE_KEY` | 削除対象が通常キーと一致（通信せず `STOPPED`） |
| `PRE_DELETE_STALE` | 削除直前の再照合から600秒超（通信せず `STOPPED`） |
| `OBSERVATION_WINDOW_NOT_ELAPSED` | 削除受理から300秒未満（通信せず・承認も回数も消費しない） |
| `NOT_ARMED` / `ARMED_PLAN_MISMATCH` / `STAGE_NOT_APPROVED` / ゲート系 | 通信前に停止（通信ゼロ） |

## 本Issueの範囲外

実機での実行、#793 の原因確定（#793 は実機完了まで閉じない）、本番01FD・予約・決済・通知への接続、第2段階（予約連携）、#791/#795 の入口・状態の変更。

## 検証

`test/switchbot-access-numeric-id-retest-797.test.js`（モック・実機通信ゼロ）: 6回・各1回の通し（数値/文字列ID）、`deleteKey` のワイヤ型（GASシェルで `JSON.stringify` 後の `parameter.id` が数値）、新旧経路のJSON型比較、#791と同一の発行条件、安全ゲート（ARMED/計画ID/承認/#791状態/01FD/トリガー/実行者/資格情報）、通信前の永続・消費、予算上限、通信失敗・不受理・タイムアウトの停止、削除直前再照合の不一致9種、通常キー保護（対象改竄6種・期限・古い再照合）、削除後の残存・通常キー変化・観測間隔、公式アプリ確認、ログ/状態の秘匿、静的確認（変換なし・#791状態を書かない・変更系は各1箇所）、既存入口の回帰。
