# SwitchBot deleteKey: ID型保持＋削除直前再照合（Issue #799）

親 #756 / 関連 #793 #797 #798。**実装とモック検証のみ。** 実機API通信・試験予算のリセット・GAS設定変更・トリガー追加・マージ・デプロイは含まない。

## 採用する方針

1. `deleteKey` の `parameter.id` には、**削除直前に取得した `keyList` の生の `id`**（数値は数値、文字列は文字列）を**型変換せずに**渡す。
2. 削除直前に必ず `keyList` を再取得し、下表の項目を再照合する。**不一致・不明では API を送らず停止**（`UNKNOWN`、運営者通知、手動撤去）。
3. API受理は削除成功ではない。**後続の `keyList` で対象ID・対象名の両方が不在**のときだけ `DELETED_CONFIRMED`。残存・タイムアウト・不明は `UNKNOWN`。
4. 変更系 API（createKey / deleteKey）の自動再送はしない。
5. 通知・通常ログ・Issue/PRには実IDの値を出さず、固定の型コード（`ID_TYPE_NUMBER` / `ID_TYPE_STRING` / `ID_NOT_SAFE_INTEGER` / `ID_TYPE_UNKNOWN`）だけを残す。内部の `OP_` レコードには、削除直前の照合のために対象キーのID値を保持する（既存フロー上必要。アクセスと保持期間は既存の制限に従う）。

## 事実と未確定の区別

| 区分 | 内容 |
| --- | --- |
| 確定した事実 | #795：現存する通常キーのIDはNUMBER。#797：新規試験キーのIDもNUMBER。型を保持し、削除直前に再GETして再照合したうえで送った deleteKey は、削除後GET・公式アプリの両方で不在（COMPLETE 6/6）。#791：文字列化したIDの deleteKey は受理されたが試験キーが残存し手動撤去（STOPPED 5/5）。 |
| **未確定** | #797 は「型保持」と「削除直前の再照合」を**同時に**変更した。**文字列化だけが単独原因とは確定していない。** 本PRは原因の確定ではなく、成功した経路を正式な安全方針として採用するものである。 |

既存の試験記録 STOPPED 5/5（#791）と COMPLETE 6/6（#797）は保持し、再実行しない。

## 削除経路の監査

| # | 箇所 | 問題 | 本PRでの扱い |
| --- | --- | --- | --- |
| 1 | `Core.judgeIssued`（発行確認） | `return { id: String(k.id) }` で**型を失う** | 生の `id` と型コードを返す。数値は正の安全な整数のみ。 |
| 2 | `Core.executeDelete` | `deps.api.deleteKey(rec.deviceId, String(rec.passcodeId))` で**再度文字列化**。保存済み（古い）IDを使用 | 削除直前に取得した `keyList` の生IDを、変換せずに送る。 |
| 3 | record 保存（`save` = `JSON.stringify`） | JSON は number を number のまま往復するため型は消えない。ただし #1 で文字列化されていたため保存値が文字列だった | #1 の修正で数値のまま保存。`passcodeIdType` を併記し、削除直前に型変化を検出。 |
| 4 | 旧形式 record（`passcodeId` が文字列・型未記録） | 型が不明 | 型未記録のときのみ、今回取得した生の型を採用（互換）。型が記録済みで変化していれば停止。 |
| 5 | `Core.adminResolveUnknown`（CONFIRM_PRESENT） | `judgeIssued` の `String()` を引き継ぐ | #1 の修正で解消。 |
| 6 | `Core.inspectAbsence` / `reconcileDelete` の ID 比較 | `String()` で比較 | **比較専用**であり送信値ではないため維持（型違いでも「残存」を見逃さない保守側の比較）。 |
| 7 | `SwitchBotAccessApp.gs` の `api.deleteKey` | `parameter: { id: id }` | 変換なし。変更不要。 |
| 8 | `Infra` #797 試験（`numIdStage`） | 型保持・直前再照合済み | 変更なし（記録保持）。 |
| 9 | `Infra` #791 試験（`testKeyStage`）の `deleteKey(g.deviceId, String(keyId))` と User Properties への `String` 保存 | 型が失われる旧経路 | **変更しない**（#791 の記録を保持するための凍結コード）。`ACCESS_TEST_KEY_STATE=STOPPED`（5/5）のため到達不能で、再実行しない。今後この経路を再利用してはならない。 |
| 10 | `scripts/switchbot-verify-*.js` / `gas/switchbot-verify/*` | 検証用リレー側。別系統 | 本PRの対象外（本番コアの削除経路ではない）。 |

## 削除直前の再照合

`Core.executeDelete` は、送信直前に取得した `keyList` で次を確認する。

| 項目 | 不一致時のコード |
| --- | --- |
| 対象デバイスが一意（keypad 1件・keyList配列あり） | `DEVICE_NOT_FOUND` / `DEVICE_AMBIGUOUS` / `KEYLIST_INVALID` |
| 保存名と保存IDが**同一の1要素**に対応し、他に名前・IDの残存がない（同名複数・別名同ID・同名別IDを拒否） | `KEY_NAME_AMBIGUOUS` / `ID_MISMATCH` |
| 保存名が運用キー形式 `SNB-<hex16>`（通常キーを削除対象にしない） | `NOT_SERVICE_KEY` |
| 種別 `timeLimit`・開始/終了が発行時の記録と矛盾しない（通常キー不変の担保） | `KEY_ATTR_MISMATCH` |
| IDの型が数値（正の安全な整数）または非空文字列 | `ID_NOT_SAFE_INTEGER` / `TARGET_ID_INVALID` |
| 記録済みのID型から変化していない | `ID_TYPE_CHANGED` |
| 鮮度：`keyList` 取得開始から送信直前まで `deleteFreshSec`（既定60秒）以内 | `PRE_DELETE_STALE` |
| `keyList` 取得の通信失敗・API異常 | `LIST_COMM_ERROR` / `LIST_API_ERROR` |

「期限」について：運用キー自体の期限切れ後の削除（`EXPIRED`）は正規の経路であり拒否しない。ここでの期限は照合結果の鮮度（上記）である。

## 本番01FD・安全境界

- `ACCESS_ENABLED=false` のまま。本PRは本番コアのコードとモックテストのみで、実機通信・設定変更・デプロイはしない。
- 検証環境は 37DD のみ許可（`validateConfig` の `KEYPAD_NOT_ALLOWED_IN_ENV`、#797 試験の `LAST4_FORBIDDEN`）。01FD の本番運用・予約連携の GO は別途必要。
- 本PRのマージ・デプロイ・本番反映は別判断。

## テスト（モックのみ）

`test/switchbot-access-core.test.js`（#799 セクション）。旧実装に対しては11件が失敗し、本実装で全件成功することを確認済み。

| 観点 | テスト |
| --- | --- |
| NUMBER / STRING | 数値は数値、文字列は文字列のまま送信され、後続 keyList で不在確認して確定 |
| 型変換の旧経路差 | 数値IDを `String()` で送ると端末は受理しても残存 → 成功にせず `UNKNOWN`・通知・再送なし |
| 型の往復 | record の保存・再読込で数値が文字列化しない |
| 削除直前のID変化 | 型変化（NUMBER→STRING）・値変化はどちらも送信せず停止 |
| 不正ID | 安全でない整数・小数・負数・0 は送信しない |
| 同名複数 | 送信しない |
| 通常キー衝突 | 通常キーが同IDを持つ／名前が運用キー形式でない → 送信せず、通常キーは保持 |
| 属性矛盾・鮮度 | 種別矛盾、取得から送信までの超過で送信しない |
| 通信失敗・残存 | 取得失敗は送信しない。deleteKey 通信断・残存は `UNKNOWN`、自動再送なし |
| 秘匿 | 通知・履歴・理由にIDの値を出さず型コードのみ（内部 `OP_` レコードの `passcodeId` は照合のため保持） |
| 互換 | 型未記録の旧 record でも、今回取得した生の型で送信 |
| 01FDブロック | 既存：`switchbot-access-numeric-id-retest-797.test.js`（`LAST4_FORBIDDEN`）、`switchbot-access-infra-754.test.js`（`KEYPAD_NOT_ALLOWED_IN_ENV`） |
