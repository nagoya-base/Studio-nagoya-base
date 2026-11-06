# 37DD keyList.id 型のみの読取専用診断 手順（Issue #795 / 親 #793・#756）

独立GAS `SwitchBot Access Test` の37DDだけを対象に、`keyList.id` の**型だけ**を固定コードで把握する手動入口。**コード作成・マージ・デプロイをもって実機診断GOとはしない。** 実行は #756 でオーナーが「37DD型読取診断1回」へ個別GOを記録してから。

## 証拠の限界（必ず併記）

- 読めるのは**現存する通常キー**の `id` の型。11/6に手動削除済みの試験キーの過去の型を再現・証明するものではない。
- 通常キーが数値でも文字列でも、11/6試験キーが同型だったとは断定しない。診断結果は #793 の原因確定ではない（仮説の一つの切り分け材料）。
- GASの `JSON.parse` は 2^53 を超える整数の精度を失う。型判定（数値か文字列か）には影響しないが、数値IDの値の再現性はこの診断の対象外。

## 安全設計

| 項目 | 内容 |
| --- | --- |
| 入口 | `accessIdTypeDiagStatus`（通信なし） / `accessIdTypeDiagRun`（GET 1回）。引数なし・手動実行のみ。トリガーは作らない |
| 通信 | `GET /v1.1/devices` を永続予算**1回**。deps には `listDevices` のみ渡し、createKey/deleteKey は到達不能。POST・Webhook・再試行なし |
| 対象 | `ACCESS_ENVIRONMENT=verify`、`allowedLast4=['37DD']` かつ keypads 1件。端末は**完全ID一致**で1件のみ。0件・重複は `TARGET_NOT_UNIQUE` |
| 必須条件 | `ACCESS_ENABLED` 明示 `false` / 実行者が `ACCESS_ADMIN_ACTORS` 本人（active=effective） / トリガー0件 / `ACCESS_TEST_KEY_STATE` が `STOPPED` / `ACCESS_TEST_KEY_ARMED` 未設定 / `ACCESS_TEST_KEY_APPROVAL` 未設定。読取不能は不明として停止 |
| 承認 | `ACCESS_ID_TYPE_DIAG_APPROVAL=ID_TYPE_READ_ONCE` のときだけ。**通信前に消費**。診断状態 `ACCESS_ID_TYPE_DIAG_STATE=SENT` も通信前に永続し、失敗なら通信しない |
| 1回予算 | `ACCESS_ID_TYPE_DIAG_STATE` が存在すれば再実行しない（`DIAG_ALREADY_USED`）。GET失敗・不明でも自動再試行なし。再実行はオーナー判断で当該プロパティを削除してからで、#756 に記録 |
| 既存状態の不変 | `ACCESS_TEST_KEY_STATE`（STOPPED・callsUsed=5/5）は読むだけで書換・削除・リセットしない。User Properties も書込禁止（書込関数は例外） |
| 出力 | 固定列挙コードと真偽・状態のみ。値・桁数・前後数桁・名前・件数・パスコード・passcodeId・deviceId・Token/Secret・生レスポンス・ハッシュを出さない。通常キーを保持・返却しない（型フラグへ集約） |

## 結果コード

| コード | 意味 |
| --- | --- |
| `ID_TYPE_NUMBER` / `ID_TYPE_STRING` / `ID_TYPE_MIXED` | 全IDが数値 / 全IDが文字列 / 両方が混在 |
| `ID_TYPE_UNKNOWN` | keyListが空、または数値・非空文字列以外のIDを含む（型を判定できない） |
| `KEYLIST_INVALID` | 端末は1件一致したが keyList が配列でない・要素が不正 |
| `TARGET_NOT_UNIQUE` | 完全一致する端末が0件または複数 |
| `LIST_API_ERROR` / `LIST_COMM_ERROR` | GET失敗（再試行しない・予算は消費済み） |
| `DIAG_NOT_APPROVED` / `DIAG_ALREADY_USED` / ゲート系コード | 通信前に停止（通信ゼロ） |

## 当日の操作（オーナーが #756 に個別GOを記録した後のみ）

1. `accessIdTypeDiagStatus` を実行 → `gates=PASS`、`prerequisites=PASS`、`diagState=NOT_USED`、`approved=OFF` を確認（通信ゼロ）。
2. Script Properties に `ACCESS_ID_TYPE_DIAG_APPROVAL=ID_TYPE_READ_ONCE` を設定。
3. `accessIdTypeDiagRun` を**1回**実行し、結果コードのみを #756 に記録（秘密・ID・名前は書かない）。
4. `accessIdTypeDiagStatus` で `diagState` と `approved=OFF` を確認。

## 本Issueの範囲外

実機診断の実行、キー削除の修正、#793 の原因確定、本番GO、01FD・予約・決済・本番GASへのアクセス。

## 追加提案（通信なし・別作業）

#713 の GitHub Actions 実行ログから、当日の入力値（開始オフセット・有効分数）・キー状態・ID型に関する非秘密の証跡を**復元できるか**を、ログ閲覧のみ（API実行なし）で確認する。ログに秘密やIDが含まれている場合は転記しない。本PRには含めない。

## 検証

`test/switchbot-access-id-type-diag-795.test.js`（モック）: 型判定、完全一致、必須条件、承認の通信前消費、1回予算、GETエラー時の不明停止、変更系API未呼出、既存STATE不変、User Properties不変、0トリガー、出力秘匿、静的参照確認、GASシェル経由（GETは1回のみ）。
