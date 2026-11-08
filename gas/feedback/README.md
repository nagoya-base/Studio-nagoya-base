# 3ブランド利用後アンケート（Issue #835 第1段階）

Studio Nagoya Base（SNB）・SNB mens・Studio X の利用後アンケートの **フォーム・回答保存・問題通知の基礎** です。
オーナー1人で運用する前提で、設定・操作はGASエディタとSpreadsheetだけで完結します。

> **第1段階では本番回答を受け付けません。** 本番用トークン（予約ごとのリンク）は第3段階 #834 で Booking と接続します。
> それまで `?test=1` のテスト回答だけが保存されます。アンケートメールの配信も第3段階まで行いません。
> 管理画面は第2段階 #849 です。

全3段階：①本Issue #835 → ②管理画面 #849 → ③予約連動・自動送信 #834

## 構成

| 役割 | 場所 |
| --- | --- |
| フォーム（GitHub Pages） | `feedback/snb/` ・ `feedback/mens/` ・ `feedback/studio-x/`（各 `index.html`） |
| 画面JS / 設定 / CSS | `scripts/feedback-app.js` ・ `scripts/feedback-config.js` ・ `styles/feedback.css` |
| 設問・検証・保存行・要確認判定（ブラウザ＝GAS同一ファイル） | `scripts/feedback-core.js` |
| 公開Web App（回答受付・通知・テスト通知） | `gas/feedback/FeedbackWebApp.gs` |
| トークン検証インターフェース（第1段階は常に拒否） | `gas/feedback/FeedbackTokens.gs` |
| Spreadsheet入出力・初期設定 | `gas/feedback/FeedbackRepository.gs` |
| 保持期間による月次削除 | `gas/feedback/FeedbackMaintenance.gs` |
| 配布物の組み立て | `scripts/prepare-feedback-gas-project.js` |

既存の `/survey/`・`/mens/survey/`（`survey-schema.json`・`survey-core.js`・`survey-app.js`・`gas/survey/`・その Spreadsheet）とは
**ファイル・GASプロジェクト・Script Properties・Spreadsheet をすべて分けています**。Booking（`gas/booking/`）とも無関係です。

## フォームURLと戻り先

| ブランド | フォーム | 完了・中断・エラー時の戻り先 |
| --- | --- | --- |
| SNB | `/Studio-nagoya-base/feedback/snb/` | `https://nagoya-base.github.io/Studio-nagoya-base/` |
| mens | `/Studio-nagoya-base/feedback/mens/` | `https://nagoya-base.github.io/Studio-nagoya-base/mens/` |
| Studio X | `/Studio-nagoya-base/feedback/studio-x/` | `https://nagoya-base.github.io/Studio-nagoya-base/studio-x/` |

- ブランドは **ページのパス** だけで決まります（クエリ等では変えられません）。サーバーも3ブランド以外を拒否します。
- `?test=1`（厳密にこの形）でテストモード。上部に `TEST MODE` を表示し、何度でも回答できます。
- 本番用リンクは `…/feedback/<brand>/#t=<token>` の形（第3段階で発行）。トークンは `#` 以降に置くのでサーバーのアクセスログやリファラに載らず、
  画面は読み込み直後にURLからトークンを消します。トークンが無い・無効・使用済み・期限切れのときはフォームを出さず、戻り先へ案内します。
- ページは GA4 等の解析タグを読み込まず、`<meta name="referrer" content="no-referrer">` と CSP（外部送信先は `script.google.com` のみ）を付けています。
  GitHub Pages はHTTPレスポンスヘッダを設定できないため、`Referrer-Policy` は meta で指定しています。

## 設問（必須は Q1 と Q6 だけ）

| 設問 | 保存列 | 値 |
| --- | --- | --- |
| Q1 総合満足度 | `q1_overall` | 1〜5（必須） |
| Q2 予約・事前案内 | `q2_website` `q2_booking` `q2_mail_timing` `q2_mail_clarity` | `ok`=問題なかった / `minor`=少し気になった / `trouble`=困った / `na`=該当なし・利用していない（任意） |
| Q3 現地利用 | `q3_location` `q3_lighting` `q3_aircon` `q3_equipment` `q3_cleanup` | 同上（任意。3ブランド同じ9項目） |
| Q4 スタッフ対応 | `q4_staff_contact` / `q4_staff_rating` | `yes` / `no` / `no_answer`。評価1〜5は「はい」のときだけ |
| Q5 気になる点 | `q5_issues` | `supplies`=消耗品不足 / `damage`=備品の破損・故障 / `cleanliness`=清掃・衛生面 / `other`=その他改善してほしいこと / `none`=特になし（排他）。カンマ区切り |
| 自由記述 | `comment` | 「気になった点・ご感想など」任意・500字以内 |
| Q6 再利用意向 | `q6_reuse` | `definitely` / `maybe` / `not_now`（必須） |

氏名・メール・予約番号は入力させず、保存もしません（「完全匿名」とは表記していません）。

## 回答Spreadsheet

`responses` シートの列：
`response_id, received_at(ISO/UTC), brand, is_test, form_version, q1_overall, q2_*, q3_*, q4_staff_contact, q4_staff_rating, q5_issues, q6_reuse, comment, status, memo, notify_failed`

- **予約ID・氏名・メール・トークン（生値・ダイジェストとも）は保存しません。**
- `status`：Q5で「特になし」以外を1つ以上選択、または自由記述あり → `未対応`。それ以外 → `対応不要`。
  第2段階 #849 で管理画面から更新できるようにする予定です。それまでは Spreadsheet 上で直接 `status`（未対応／対応済み／対応不要）と `memo` を編集してください。
- `is_test`：サーバーが確定します（payload の `test` が厳密に `1` のときだけ `1`）。テスト行は本番集計の対象外です。
- `notify_failed`：通知がONで送信に失敗した本番回答に `1`。再送はしません（Spreadsheetで確認）。
- 自由記述の先頭が `= + - @` の場合は `'` を付けて保存します（数式として解釈させない）。

## 管理者通知

| 項目 | 内容 |
| --- | --- |
| 送る条件 | **本番の有効回答の保存成功後だけ**。Q5で「特になし」以外を1つ以上選択、または自由記述あり。回答1件につき最大1回 |
| 送らない | テスト回答（`?test=1`）・検証エラー・保存失敗・トークン無効・要確認なし・通知OFF |
| 件名 | `【利用後アンケート】確認が必要な回答があります（<ブランド名>）` |
| 本文 | プレーンテキスト。ブランド・受信日時（JST・分単位）・回答ID・総合満足度・Q5カテゴリ・Q2/Q3で「少し気になった／困った」の項目・自由記述 |
| 載せない | 予約者情報・トークン・Spreadsheet ID |
| 失敗時 | 回答は維持し `notify_failed=1`。ログは `feedback notify failed: <例外名>` だけ（宛先・本文は残さない） |
| 初期状態 | **OFF**（`FEEDBACK_NOTIFY` が `on` のときだけ送信） |

## Script Properties（非公開設定。値はGitに書かない）

| キー | 内容 |
| --- | --- |
| `FEEDBACK_SPREADSHEET_ID` | 利用後アンケート専用の新規Spreadsheet ID。未設定なら保存しない |
| `FEEDBACK_NOTIFY` | `on` で通知を有効化。未設定・それ以外はOFF |
| `FEEDBACK_NOTIFY_EMAIL` | 通知先（オーナー） |
| `FEEDBACK_RATE_LIMIT_PER_MINUTE` | 任意。全体の受付上限/分（既定 30。テスト回答も同じ枠） |

保存先が未設定・誤設定のときは、Bookingや既存surveyへフォールバックせず保存を止めます
（`setupFeedbackSpreadsheet()` が書く識別マーカーが無いSpreadsheet、ヘッダが違うSpreadsheetには書き込みません）。
回答保存の失敗は予約・決済・解錠に影響しません（別プロジェクト・別Spreadsheetです）。

## 初期設定（オーナーの承認後に実施）

1. Googleドライブで **新規の空Spreadsheet** を作り、IDを控える（Booking・既存surveyのSpreadsheetは使わない）。
2. 配布物を組み立てる（`.gas-deploy/` は `.gitignore` 済み）：
   ```sh
   node scripts/prepare-feedback-gas-project.js .gas-deploy/feedback
   ```
3. **新しいGASプロジェクト**を作り、`.gas-deploy/feedback/` の全ファイル（`appsscript.json` を含む）を配置する。
4. 「プロジェクトの設定 → スクリプト プロパティ」に `FEEDBACK_SPREADSHEET_ID` を登録する（通知はまだOFFのまま）。
5. エディタで `setupFeedbackSpreadsheet` を実行する（`responses` / `settings` を作成。冪等。データ入りのSpreadsheetなら拒否して止まる）。
6. エディタで `installFeedbackRetentionTrigger` を1回実行する（毎月1日4時台に保持期間切れの行を削除）。
7. 「デプロイ → 新しいデプロイ → ウェブアプリ」：次のユーザーとして実行 **自分**、アクセスできるユーザー **全員（匿名ユーザーを含む）**。
8. 発行された `/exec` URL を `scripts/feedback-config.js` の `BASE_URL` に設定するPRを出す（既存 `survey-config.js` のURLとは別）。

## 手動試験

1. **自動テスト**：`node --test test/feedback-*.test.js`（本番データを使わずに受入テスト2〜6を検証）。
2. **テスト回答**（`BASE_URL` 設定後）：3ブランドの `…/feedback/<brand>/?test=1` で、Q1・Q6だけ／全設問／自由記述あり を送る。
   - `responses` に `is_test=1`・正しい `brand` で行が増えること、通知が **0通** であること。
   - Q4「はい」のときだけ評価欄が出る、Q5「特になし」が他と同時に選べない、501字で送れない、を確認。
   - 完了画面の「戻る」が各ブランドの戻り先であること。「回答をやめて戻る」も同じ戻り先。
   - `…/feedback/<brand>/`（`?test=1` なし・トークンなし）では回答画面が出ないこと（本番回答は保存できない）。
3. **通知経路**：`FEEDBACK_NOTIFY_EMAIL` を登録し、エディタで `sendTestNotificationSnb` / `sendTestNotificationMens` / `sendTestNotificationStudioX` を実行
   （`sendTestNotification(brand)` の引数なし入口）。初回は `script.send_mail` の認可を許可。
   - 合格：ログが `feedback test notification (<brand>): sent` で、件名 `[TEST] 【利用後アンケート】…（<ブランド名>）` のダミー通知が各1通届くこと。
   - `FEEDBACK_NOTIFY` がOFFでも送れます。公開フォーム（doPost）からは呼べません。
4. 実予約・本番トークンでの最終確認は第3段階 #834 で行います。

## 止め方

- **通知だけ止める**：`FEEDBACK_NOTIFY` を削除するか `off` にする。
- **受付を止める**：GASの「デプロイを管理」でウェブアプリのデプロイをアーカイブする（または `FEEDBACK_SPREADSHEET_ID` を削除すると保存が止まる）。
- **画面を止める**：`scripts/feedback-config.js` の `BASE_URL` を `''` に戻す（送信時「準備中」と表示し保存しない）。
- **月次削除を止める**：GASの「トリガー」から `purgeExpiredFeedbackResponses` を削除する。

## 保持期間

- 本番回答：受信から **180日**、テスト回答：**30日** を過ぎた行を、月1回 `purgeExpiredFeedbackResponses` が削除します。
- 受信日時が読めない行は削除しません（手で確認してください）。
- 自由記述に個人情報が書かれていた場合は、Spreadsheet上で直接削除・編集してください（変更履歴はGoogleの版の履歴に残ります）。

## 第1段階で未接続のこと

- Booking 予約とトークンの実結合・送信済み／期限／重複チェックの本番E2E・利用終了2時間後のメール送信 → **#834**
- 管理画面（概要・問題分析・コメント一覧・status/memo の画面内更新）→ **#849**
- 公開GASのデプロイ・`BASE_URL` 設定・本番通知ON → オーナー承認後に上記手順で実施（本PRでは行わない）
