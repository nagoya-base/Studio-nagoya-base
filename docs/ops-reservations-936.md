# 運営アプリ 段階1「予約一覧・詳細」（読み取り専用）調査・設計・運用メモ（Issue #936）

**正本は Issue #936（親 #935）。** 本書は調査結果と実装の説明であり、デプロイ・Script Properties設定・本番接続・公開は**行っていません**（マージ＝本番反映ではありません）。実在の予約・個人情報・秘密値は本書にも記載していません。

## 1. 調査結果（確認済み事実／未確認／提案）

### 確認済み事実（コードで確認）
| 項目 | 事実 | 根拠 |
| --- | --- | --- |
| 読み取り元 | 予約台帳は `Bookings` シート。列定義の正本は `BookingsSchema.HEADERS`（予約ID=`bookingId`、利用日=`date`、開始/終了=`startAt`/`endAt`、状態=`status`、ブランド=`brand` ほか） | `gas/booking/shared/BookingsSchema.gs` |
| 予約状態 | `PENDING` / `CONFIRMED` / `CANCELLED` / `EXPIRED` | `gas/booking/shared/Booking.gs` の `STATUS` |
| 元のブランド値 | `snb` / `mens` / `studio_x`（Bookingsに存在するブランド） | `gas/booking/shared/Config.gs` の `PER_BOOKING_CODE_BRANDS_`、`BookingAdminWeb.gs` |
| 日付型の揺れ | `date` 等はシートの書式によりDate値または文字列で読まれる。JST（`Asia/Tokyo`）で扱う | `SpreadsheetRepository.gs`（`normalizeBookingDateForComparison_`）、`BookingAdminWeb.gs` |
| 既存の一覧取得 | Booking Adminが `getAdminBookings()`（全件取得→UI側で絞り込み、一覧には個人情報を最小化）を持つ。同一プロジェクトに確定/取消などの**変更操作**（`adminConfirmBooking` 等）も同居 | `gas/booking/admin/BookingAdminWeb.gs` |
| 既存Adminの認証 | Web App「自分のみ」（Execute as: Me / Only myself） | 同ファイル冒頭コメント |
| 読み取り専用での台帳アクセス | `SpreadsheetApp.openById` は `spreadsheets`（書込み可）スコープが必要。読み取り専用は Sheets API v4 の GET＋`ScriptApp.getOAuthToken()` で行う先例がある | `gas/switchbot-access/AccessLedgerReader.gs` |
| Community | Bookingsシートには `snb_community` に相当するブランド値が無く、このリポジトリに台帳もない。台帳は別リポジトリ（snb-community）側と推測されるが、**本調査では未確認** | リポジトリ全体の検索 |

### 未確認
- 本番Bookingsシートの実際の列の並び・書式・行数（本番を読んでいない）。
- Community の台帳の所在と構造（別リポジトリ側）。段階1では**未接続**と明示する。
- #864（一覧性能）・#930（スマホ表示）の内容。参照のみで、本書では読んでおらず、既存Adminは変更していない。
- 「Sites」（#935）の具体的な実行基盤と公開設定の機能。

### 提案（本実装の採用内容）
- **新規の独立GASプロジェクト `gas/ops-reservations/`**（Web App・自分のみ）。既存の予約・決済・認証・デプロイ経路・既存Adminへは変更なし。
- 台帳は**読み取り専用**（`spreadsheets.readonly` ＋ `script.external_request` ＋ `userinfo.email`）。Sheets API v4 の **GET のみ**（`OpsSource.gs`）。
- 取得は**許可列のみ**（メール・電話・備考・決済トークン・Stripe ID・カレンダーID・メール送信エラー文は、ネットワーク越しにも取得しない）。鍵の暗証番号はBookingsシートに存在しない。
- 認可は Web App設定（自分のみ）＋**全API・doGetでサーバー側の所有者照合**（`OPS_OWNER_EMAIL`。未設定は拒否=fail-closed）。
- 予約IDは台帳の値を保持し再採番しない。空欄・重複は一覧/詳細から除外し、画面の「確認が必要な行」に行番号と理由を出す。
- サービス対応: `snb→SNB`、`studio_x→Studio X`、`mens→SNB Mens`、`snb_community→SNB Community（未接続）`、その他→「未分類」（元の値を詳細に表示）。
- 初期期間: 今日から30日間（JST、今日を含む）。過去は直近30日。
- 表示許可項目（一覧）: 予約ID・サービス・状態・利用日・開始/終了時刻・氏名・人数。（詳細）上記に加え 利用者区分・利用目的・プラン・支払方法・決済状態・実効利用料金・大人数利用・受付経路・作成/更新/確定/キャンセル/失効日時。
  **メールアドレス・電話番号・備考は段階1では含めない**（所有者の判断が必要な項目。必要になれば別途承認の上で追加）。

## 2. 取得状態・並び順の仕様
- 取得状態: 取得中／成功／失敗／正常取得で0件／未接続を区別。失敗を成功や0件にしない。最終取得成功日時（JST）を表示。
- 前回取得分は「古いデータ」と最終成功日時を明示して残す（端末への永続キャッシュはしない）。
- 手動再取得可。連続操作で遅れて返った古い応答は破棄（最新リクエストのみ採用）。
- 並び順: 今後=開始日時の昇順、過去=降順。同時刻は終了日時→予約IDで安定。取消・失効も削除せず状態を明示。
- 台帳は1回で全件読み切る。行数が上限（20,000）を超えたら**切り捨てず停止**。
- 値: `0`（数値）と空欄（未入力）を区別して表示。元データで区別できない値は推測で補完しない。

## 3. ファイル構成（`gas/ops-reservations/`）
| ファイル | 役割 |
| --- | --- |
| `OpsContract.gs` | 共通契約（サービス区分・JST日時・暦日検証）。後続段階はここを参照して拡張 |
| `OpsNormalizer.gs` | 許可列だけの検証・正規化。予約ID/日時/重複の検出 |
| `OpsQuery.gs` | 絞り込み・並び順・一覧/詳細の項目射影 |
| `OpsSource.gs` | 取得アダプター（Sheets API v4 GETのみ） |
| `OpsApi.gs` | `doGet`・`opsListReservations`・`opsGetReservation`、所有者照合 |
| `OpsPage.html` | スマホ/PC対応の画面（取得状態・エスケープ描画） |
| `appsscript.json` | スコープ・Web App設定（自分のみ） |

取得アダプター／検証・正規化／画面を分離しており、後続モジュールは同じ契約の上に追加できます。

## 4. 運営者が行う作業（未実施・本PRに含まない）
1. 新規のスタンドアロンGASプロジェクトを作成し、`gas/ops-reservations/` のファイルを配置（clasp等の自動デプロイは**この変更では用意していない**。既存のdeploy workflowにも追加していない）。
2. Script Properties を設定:
   - `OPS_OWNER_EMAIL` … 所有者のGoogleアカウントのメール
   - `OPS_SPREADSHEET_ID` … 予約台帳のSpreadsheet ID（秘密値ではないがリポジトリには置かない）
3. Web Appとしてデプロイ（Execute as: Me／Who has access: Only myself）。初回に読み取り専用スコープを承認。
4. 承認後、スマホ/PCで実データの表示を確認（実データはリポジトリ・Issue・PRに貼らない）。

## 5. 検証と制約
- `node --test test/ops-reservations.test.js`（架空データ。境界日・JST日付境界・同時刻・0件・未知サービス・ID空欄/重複・認可拒否・応答競合・読み取り専用の静的検査）。スマホ幅（375px）・PC幅（1200px）の横はみ出しなしは、架空データでブラウザ（Chromium）を使い手動確認済み（自動テストには含めていない）。
- 制約: 本番Bookingsの実データでの動作は未確認。Communityは未接続。メール/電話/備考は非表示。端末への保存なし。ログは件数と固定コードのみ。
- 非干渉: 既存の予約・決済・デプロイ・認証設定・既存Adminは変更していない。`.github/workflows` と Booking のデプロイ対象表にも追加していない（静的テストで検査）。
