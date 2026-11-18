# 運営アプリ「鍵・案内の状況」（読み取り専用）設計・設定・検証メモ（Issue #942）

**正本は Issue #942（親 #935）。** 本書の内容は、PRのマージ・GASデプロイ・Script Properties設定を**許可するものではありません**（マージ＝本番反映ではありません）。
**Access GAS（鍵管理）の本番デプロイは、PRマージ後であっても先輩の別途明示承認があるまで行いません。** 運営アプリ側だけを先に反映した場合、鍵状態は「**未接続**」と表示され、実利用確認済みとは扱いません。

## 1. 何ができるか（できないか）

- 運営アプリの予約詳細に、予約ごとの **発行／登録確認／案内／失効** の記録を**読み取り専用**で表示する。正本は既存 Access GAS（Script Properties の `BK_`/`OP_`/`DLV_`）。
- 鍵の発行・更新・延長・削除・解錠・通知送信の操作・API・UI は**持たない**。Access側の `appsscript.json`（スコープ・Webアプリ設定）、既存トリガー、`ACCESS_ENABLED`、既存の鍵処理・Webhook処理は**変更しない**。
- 表示は「参考表示」。実際に解錠できるかは確認していない（SwitchBot側の確認・現地確認・既存の管理者手順による）。

## 2. 構成

```
運営アプリ画面 → 運営GAS(OpsApi key_status) ──POST(本文にトークン)──▶ Access GAS doPost ?a=opsStatus
                  │ 台帳(Bookings)と突合(OpsKeyStatus)                  │ AccessOpsStatus（状態ストアは get のみ）
                  ▼                                                      ▼
            画面へは許可リストの射影だけ                      BK_/OP_/DLV_/HB_ の読取り（ロックなし・書込みなし）
```

| 場所 | 変更 |
| --- | --- |
| `gas/switchbot-access/AccessOpsStatus.gs`（新規） | 認証・入力検証・許可リスト射影（純粋ロジック） |
| `gas/switchbot-access/SwitchBotAccessApp.gs` | `doPost` 先頭の入口振り分け（`sba_routeOf_`）と薄いアダプター（`sba_opsStatusPost_`）のみ |
| `gas/ops-reservations/OpsKeyStatus.gs`（新規）／`OpsApi.gs`／`OpsNormalizer.gs` | 取得（リダイレクト安全）・照合・`key_status` 要求・台帳の許可列に `revision` を追加（個人情報ではない） |
| `_ops-app/frontend/` | 予約詳細の「鍵・案内の状況」ブロック。モックに `?key=ok\|not_connected\|failed\|denied` |

### 2.1 入口の振り分け（既存Webhookへの非干渉）
- クエリ `a` が**無い**要求だけが従来の Webhook 経路へ進む（SwitchBot の Webhook URL は `t` のみ）。従来経路のコード・応答（`{"ok":true|false}`）は無変更。
- `a=opsStatus`（完全一致・1つだけ）→ 状態参照。**それ以外の `a`、`a` の重複、判定で例外が出た場合は Webhook 経路へ落とさず固定拒否** `{"ok":false,"code":"NOT_AVAILABLE"}`（fail-closed）。
- 状態参照の経路は `sba_runtime_`／`handleWebhook`／`runLocked` を呼ばず、Webhook 経路は状態参照のコードを呼ばない。`doGet` は `{"ok":true}` のまま（状態参照にGETは使わない＝トークンをURLに載せない）。

### 2.2 サーバー間認証
- 共有トークン（32〜128文字・乱数）は運営GAS→Access GAS間のみ。**POST本文**で送り、URL・クエリ・ヘッダー・ログには出さない。ブラウザーには渡らない。
- Access側は **SHA-256ダイジェストだけ**を保存（Script Properties `ACCESS_OPS_STATUS_TOKEN_SHA256`。`ACCESS_` 接頭辞は状態ストア・回収の対象外）。比較は定数時間。
- 認証前の処理順: 本文サイズ上限（2048文字）→ JSON → `v` → トークン形式 → ダイジェスト比較。**ここまで状態ストアに触れない**（認証前のProperties列挙も禁止）。失敗はすべて同一の固定応答で、予約の存在・状態・設定の有無を漏らさない。
- 通過後: 予約ID（`^[A-Z]{2,4}-[0-9]{8}-[0-9A-F]{8}$`＝`Booking.generateBookingId` の形）・最大10件・重複除去。不正は要求全体を固定拒否。
- 濫用対策: GASは送信元IP制限ができない。(a)認証前は安い拒否のみ、(b)高エントロピー、(c)ロックを取らないため鍵ジョブを待たせない、(d)キルスイッチ=ダイジェストの削除（全拒否）。失敗カウンター等の**書込みは作らない**（運営の締め出しにも使われうるため）。

### 2.3 応答（許可リスト）
`{ ok, v, readAtSec, consistency: STABLE|CHANGED_DURING_READ, jobs:{SYNC,SWEEP,DELIVER,CLEANUP: 経過秒|null}, items:[{ ref, record: NONE|FOUND|AMBIGUOUS|INVALID_INDEX, truncated, opCount, ops:[{ rev, kind: ISSUE|REVOKE, state, validFromSec, validToSec, updatedAtSec, delivery }] }] }`
- 生の OP/DLV/BK を返さない。**PIN・passcodeId・commandId・完全deviceId・keyName・証跡・履歴・メール・秘密は型として出力不能**（記録内の文字列は返さず、列挙値と整数のみ。`ref` は要求した検証済みIDのみ）。未知の列挙値は `UNRECOGNIZED`。
- **8件上限**: 1予約あたり読む OP は最新8件。BK索引（`ops` 配列）の長さは正確に分かるため、超過は `truncated=true`＋`opCount`（索引上の総数）で**確実に検出**できる（古い記録の中身は読まない）。
- 読取り一貫性: ロックを取らず、読んだ生値を再読して比較。変化があれば1回だけ読み直し、なお変わる場合は `CHANGED_DURING_READ`（運営側は要確認）。

## 3. 照合と表示（運営側 `OpsKeyStatus.evaluate`）

台帳の `status`／`revision`／`startAt`／`endAt` と、現行改訂（台帳の `revision` と一致する ISSUE OP）を突合する。**確認不能・取得失敗・不一致・要確認は互いに別の表示**。

| 表示 | 主な条件 |
| --- | --- |
| 未接続 | 運営GASにURL/トークン未設定（鍵状態は何も主張しない） |
| 未取得 | 通信/HTTP/リダイレクト拒否/応答不正/鍵管理側の拒否（認証不一致と設定誤りは区別できない旨を表示） |
| 確認不能 | 鍵管理側に記録なし（**未発行・回収済み・対象外を区別できない**ため「未発行」と言わない）／ID形式非対応 |
| 要確認 | 索引不整合・複数候補・読取中の更新・**8件超（truncated）**・認識できない記録・台帳の改訂/状態/時刻が不明、または**終了が開始と同時刻・開始以前（逆転）**・案内状態が確定しない |
| 不一致 | 現行改訂の鍵が無く旧改訂のみ／旧改訂の鍵が残存／取消・失効なのに鍵が有効・発行中／有効時間が予約時間を覆っていない（延長・変更の反映漏れ）／予約有効なのに鍵が失効済み・失効処理中 |
| 発行待ち／登録未確認／案内未送信／失効未確認 | OPの状態と案内（DLV）状態から実際の状態を区別 |
| 登録確認済み・案内済み／失効確認済み | 上記の異常がすべて無い場合のみ（案内済みは「送信呼出し成功」。利用者への到達は別） |

- **truncated の予約は、見えている記録がすべて正常でも「登録確認済み／案内済み／失効確認済み」にしない**（要確認を優先）。
- ジョブ稼働（`HB_*`）は予約別の鍵の成功ではないため**別枠**（折りたたみ）で、「何分前に実行」のみ表示する。
- 有効時間が予約時間より**長い**分は、猶予設定（`graceBefore/After`）を安全に読めないため判定しない（画面に明記）。
- 台帳の `revision` が整数で読めない場合は、推測で一致させず要確認。

## 4. 取得時のリダイレクト（トークンを再送しない）
- 接続先は `https://script.google.com/(a/macros/<domain>/|macros/)s/<ID>/exec` だけ（形式不一致は通信せず `CONFIG_INVALID`）。`followRedirects:false`。
- 302/303 で `Location` が `https://script.googleusercontent.com/` のときだけ、**本文なしのGET**（トークンなし・ヘッダーなし）で結果を読む。それ以外の3xx・別ホスト・追加のリダイレクトは `REDIRECT_REJECTED` で中止。応答は64KBまで、許可リストの形へ検証・複写（余分な項目は捨てる）。

## 5. 設定手順（先輩の作業・本PRでは実施しない）
1. トークンを作成（端末内のみ・どこにも貼らない）: `T=$(openssl rand -hex 32); printf %s "$T" | sha256sum`（`$T` が運営側、出力の64桁が Access 側のダイジェスト）。
2. **Access GAS**（検証GAS→承認後に本番）: Script Properties に `ACCESS_OPS_STATUS_TOKEN_SHA256`＝ダイジェスト（小文字64桁）。
3. **運営GAS**: Script Properties に `OPS_ACCESS_STATUS_URL`（Access Webアプリの `/exec` URL）と `OPS_ACCESS_STATUS_TOKEN`（`$T`）。
4. 停止: Access側のダイジェストを削除（全拒否）。ローテーション: 新トークンを作り両側を差し替え。いずれも公開の場に値を書かない。
5. 反映の順序: ①（承認済みなら）運営アプリ側を先に反映 → 画面は「未接続」 → ②検証GASで架空データ確認 → ③**先輩の明示承認後**に本番Accessを反映・設定 → ④実利用URLで読取り確認。

## 6. 検証
- 自動（架空データ・`node --test`）: `test/switchbot-access-ops-status-942.test.js`（入口の非干渉・分岐例外のfail-closed・認証前に状態ストア非接触・固定応答・許可リスト・秘密非露出・書込み/ロック/メール/トリガー/外部通信0・索引不整合・複数候補・8件超・読取中の更新）、`test/ops-key-status-942.test.js`（取得とリダイレクト・照合の全状態・認可・未接続/未取得/確認不能/要確認/不一致の別表示・画面・モックと実応答の契約一致）。既存のAccess/運営アプリのテストと配布物・manifest検査も通過。
- **検証GASでの確認（先輩の許可後・実鍵発行なし）**: 架空の予約ID・OPで、(1) POSTが302→`script.googleusercontent.com` で結果を返し、運営側が読み取れること、(2) 誤トークンが固定応答になること、(3) 既存Webhookの正常/不正が従来どおりであること。
- **実データの読取り**: 許可後に読取りのみ。値は公開コメントに転載しない。

## 7. 未確認（断定しない）
- 実GASでの POST→リダイレクトの挙動・所要時間（検証GASで確認）。本番の保持状況・実データの分布・猶予設定の値。
- Access側は `ANYONE_ANONYMOUS` のURLに認証付き入口が増える（トークンは本文・定数時間比較・固定応答で緩和）。実運用でのトークン管理は運営者の作業に依存する。
- 取消後に BK 索引が早期回収された予約は「記録なし」になり、「失効済み」とは区別できない（確認不能として表示）。

## 8. 個別鍵の実状態の主表示（Issue #969）

メール送信記録（#967）は個別鍵の結果ではない。画面の主表示は `lifecycle` で、**鍵管理側の記録（OPの state / revision / 整合性）から直接求める**（`verdict` からの変換はしない）。予約との矛盾・案内メールの不明は `verdict` と `lifecycle.alert`（主表示直下の警告）に分離し、鍵の明示的な証拠を隠さない。**Access GAS・Bookings・保存形式は無変更**（読み取り専用）。

- 信頼性ゲート: 読取中の更新・索引不整合・複数候補・8件超（truncated）・認識できない記録・台帳の改訂不明・現在の改訂の鍵記録なしは「判定保留」（鍵の状態を主張しない）。`NONE` は「鍵の履歴なし（判別不可）」。
- 優先順位（残っている鍵を隠さない）: `UNKNOWN` ＞ `ISSUED_CONFIRMED`（利用終了後は「利用終了後・失効未確認」）＞ 発行処理中 ＞ `DELETE_*`（失効処理中）＞ `EXPIRED`（**期限切れ・失効未確認**。失効処理中とは別）＞ 失効確認済み（`DELETED_CONFIRMED`/`ALREADY_ABSENT`/`ARCHIVED_EXPIRED`）＞ 失敗のみ。
- 失敗のみ: 取消/失効の予約は「未発行（根拠付き）」、確定予約は「発行失敗」。`ABANDONED` のみ・`FAILED` との混在は「発行中止・要確認」（未送信の計画の不要化も含むため、発行失敗・鍵の不在を断定しない）。
- 対象の改訂: 取消/失効は全改訂、確定・仮予約は現在の改訂（古い改訂の残存は verdict の警告）。
- 取消なのに鍵が有効、予約中なのに鍵が失効確認済み、有効時間の不一致、案内状態の不明は、lifecycle を変えず警告（alert＋verdict）で示す。
- 履歴回収後も正確に出すための最小保持案（Access側に結果コードのみ保持）は**未実装・オーナー承認待ち**（Issue #969 の報告コメント参照）。
- テスト: `test/ops-key-status-942.test.js` の `#969` 系。
