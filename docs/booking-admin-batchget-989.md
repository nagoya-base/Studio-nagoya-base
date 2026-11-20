# Booking Admin 一覧: Sheets API `batchGet` 一括読取の検証結果（Issue #989）

> 検証専用。**本番の `getAdminBookings` 実行経路・manifest・OAuthスコープ・Advanced Service は一切変更していない。**
> 実API・実Spreadsheet・実予約には接続していない。速度効果は**未確認**（ローカルNodeスタブは本番速度の証拠にならない）。

関連: #989 / #981 / #979 / #983 / PR #984（保留）。成果物は `test/booking-admin-batchget-feasibility-989.test.js`
と `test/helpers/sheets-batchget-model-989.js`（どちらもGASへ配布されない）。

## 判定: **NO-GO（`values.batchGet` 単独の採用は不可）／追加検証が必要なのは grid data 方式のみ**

| 観点 | 結果 |
|---|---|
| `values.batchGet` の3表現（FORMATTED_VALUE／UNFORMATTED+SERIAL／UNFORMATTED+FORMATTED_STRING） | いずれも `getValues()` の `Date` と「同じ値・型」を復元できない具体例をテストで再現（下表） |
| Date列の型推測アダプタ | 列名から日付列を推測する方式は、過去データ（日付列の通常数値）で誤変換し一覧の戻り値が変わる。変異テスト（列取り違え・数値列の誤変換・TZ取り違え）は全て `deepStrictEqual` で検出される |
| fail-closed アダプタ | SERIAL表現ではDateが「ただの数値」と区別できないため、**列名に依存せず、数値セルが1つでもあれば拒否**する（Dateが `name` や余剰列にあっても成功扱いにしない。回帰テストあり）。成功するのは数値セルが皆無（文字列・真偽値・空セルのみ）の台帳だけ。実運用の Bookings／OptionOrders は料金・金額・Dateなどの数値を日常的に含むため、**実質すべてレガシーへフォールバック**＝実用的な高速経路は存在しない |
| grid data（`spreadsheets.get`＋`fields`） | 型メタデータ（`effectiveValue`／`numberFormat.type`）でモデル上は型ごと復元可。ただしペイロードは約5倍（このフィクスチャ: values 41,953B／grid 213,770B。空セル `{}` を含む概算）。実Sheetsでの数値書式の扱い・ミリ秒・DST地域の壁時計解決は**未確認**のため採用しない |
| 障害境界 | 1回のAPI失敗は両台帳の失敗になる。**どんな失敗・欠損・不整合でも最大1回だけレガシーへ戻す**設計（再試行なし）なら、OptionOrdersだけ失敗→Studio XのみUNKNOWN、Bookings失敗→全体失敗、シート作成・ヘッダー追記の副作用も従来と一致することをテストで確認 |
| 権限／配布 | 下記。設定変更は行っていない |

## 値表現の非互換（テストで再現）

| 表現 | Date／数値／真偽値の扱い | 再現した非互換 |
|---|---|---|
| `FORMATTED_VALUE` | すべて表示書式の文字列 | Dateと日付形式の文字列セル、数値`123`と`"123"`、`true`と`"TRUE"`が同一応答。ミリ秒が消える（23:59:59.999 → 23:59:59） |
| `UNFORMATTED_VALUE`+`SERIAL_NUMBER` | 日付だけ数値（スプレッドシートTZの壁時計） | Dateセルと「ただの数値セル」が同一応答（型を復元不能）。DST地域では壁時計が2つの瞬間に対応（例 NY 2026-11-01 01:30） |
| `UNFORMATTED_VALUE`+`FORMATTED_STRING` | 日付だけ書式付き文字列 | Dateセルと文字列セルが同一応答。ミリ秒が消える |

注: 一覧の戻り値JSONは分単位の文字列へ整形されるため、型やミリ秒の差が最終JSONに現れず**偶然一致することがある**。互換判定は
JSON化**前**にDateの型名と `getTime()` を比較する（テストの `describeGrid`）。

## 構造・失敗・副作用の互換（テスト済み）

- 末尾の空セル・空行の省略、途中の空行（`[]`）、余剰列、ヘッダーのみ、行番号は、シート名のみのrange＋矩形化で `getValues()` と同じ**形**になる（形状のみの確認。型互換の証明ではない）。
- 空シート（`values` なし）・シート未存在（API 400/404）は**レガシーへ戻す**。従来の `ensureSheet_`／`ensureBookingsSheet_`（`insertSheet`・`appendRow`）の副作用を省略しない。
- 403／404／429／500／503／Advanced Service未登録（`ReferenceError`）／ネットワーク例外／応答欠損・`valueRanges`数・range名・行形式の不整合 → 成功として流さずレガシー（フォールバック1回、`batchGet` 1回、再試行なし）。型変換アダプタの例外・不正な戻り値も同様に固定reason（`ADAPTER_EXCEPTION` 等）でレガシーへ戻し、エラーメッセージやセル値は保持しない（例外注入テストあり）。
- 現行は2回の読取が逐次実行で台帳間スナップショットは保証されない。`batchGet` も完全同時スナップショットとは主張しない。

## 権限・配布（読取と設計のみ。**設定変更は禁止・未実施**）

- Admin の `appsscript.json` の正本はGitHubに無く、`scripts/prepare-booking-gas-project.js` が既存コンテナのmanifestを維持する。コードが保証する必須scopeは `script.external_request` のみ。
- **未確認（リポジトリだけでは証明不能）**: 現在のAdmin実プロジェクトに Advanced Sheets Service v4 が登録済みか、`oauthScopes` に `spreadsheets` 系が含まれるか。他のGAS（SwitchBot等）の登録状況はAdminの証拠にならない。
- Advanced Service（`Sheets.Spreadsheets.Values.batchGet`）を使う場合: manifestの `dependencies.enabledAdvancedServices` 追加、必要なら `oauthScopes` 追加と再認可、関連Cloud projectのSheets API有効化が必要。`UrlFetchApp` REST（`ScriptApp.getOAuthToken()`）の場合は `script.external_request`（既存）に加え `spreadsheets(.readonly)` scope が必要で、いずれもmanifest差分と運営者承認・preflightが前提。**独立承認ゲート**を置き、暗黙に通さない。
- 本PRでは `prepare-booking-gas-project.js`・`BOOKING_ADMIN_FILES`・必須scopeを変更していない（テストで固定）。

## 代替案比較

| 案 | 改善幅 | 安全性・互換 | 保守コスト |
|---|---|---|---|
| ① 現状維持（v115基準） | なし | 互換・権限とも既知 | 最小 |
| ② PR #984（`getLastRow`最大2回省略） | 小幅・未確定 | 例外順序が変わる既知リスク（保留継続） | 小 |
| ③ `batchGet`＋変換 | **未確認**（応答時間の律速がネットワーク往復かは不明） | 型互換を証明できず**不採用**。fail-closedだと常時レガシー | 大（Advanced Service・scope・障害分離） |
| ③' grid data | **未確認**（ペイロード約5倍） | モデル上は型復元可、実環境で未確認の点が多い | 大 |

## 次の判断（本PRの範囲外・別承認）

- 現時点の推奨: **③は採用しない**。意味のある高速化の証拠なく本番採用しない。
- grid data方式を続行する場合のみ、**隔離した架空Spreadsheet＋独立GASプロジェクト**で `SpreadsheetApp` 版との同件数・同列数・同値データの計測が必要（プロジェクト新設・サービス/Cloud設定・実API呼出しは明示承認後）。
- 速度は #983（未計測の基盤側遅延）、#981（現行I/O）、#979（3秒目標）で継続。
