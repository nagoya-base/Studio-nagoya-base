# gas/booking（自社予約システム）

Epic #265の一部として以下を実装済み。

- **Issue #266**: `getAvailability`（読み取り専用の空き判定）
- **Issue #268**: `createBooking`（Studio X限定の仮予約作成）・予約台帳（Spreadsheet）・
  PENDING/CONFIRMED/CANCELLED/EXPIRED状態管理・部分失敗補償・TTL失効・レート制限・
  Spreadsheetカスタムメニューからの予約確定

このディレクトリは自社予約システム専用のApps Scriptプロジェクトとして運用し、
`gas/ataru_survey_public` 等の既存GASプロジェクトとは完全に分離する
（互いのコードを参照・importしない）。

## このIssue（#268）で実装した範囲

- `createBooking`（Studio Xのみ。POST専用API）
  - サーバー側入力検証 → abuse/rate limit確認 → LockService取得 → Calendar再確認 →
    競合チェック → bookingId発行 → CalendarにPENDINGイベント作成 → Spreadsheet台帳へ保存
    → Lock解除 → 管理者通知（Lockの外・失敗しても予約は成功のまま）
  - 利用者送信時は必ずPENDING（送信即CONFIRMEDにはならない）
  - Lock取得後にCalendarを再取得し、直前の占有状況を再確認してから予約を作る
    （#267との境界。スペースマーケット由来・管理者手入力・その他の時間指定イベントを
    タイトルで区別せず、すべて占有として扱う）
- Spreadsheet予約台帳（`Bookings`シート）・部分失敗記録（`Recovery`シート）
- PENDING TTL失効（`expirePendingBookings()`。時間主導トリガー用）
- Spreadsheetカスタムメニューからの予約確定（`confirmBooking(bookingId)`）
- レート制限（同一メール・全体・同一内容連投）

## このIssueで実装していないもの（非対象）

- Studio Nagoya Base / SNB mensでの予約作成（Phase 1はStudio Xのみ。brand偽装で
  他ブランドから予約できないようサーバー側でも`studio_x`のみ許可している）
- `#269` 以降の共通予約UI実装（フロントエンドからcreateBookingを呼ぶ画面）
- `#271` 利用者向けメール通知（仮予約受付・確定・キャンセル・前日リマインド・来場案内）。
  本Issueで送るのは管理者向けの最低限の内部通知のみ
- `#272` 管理者キャンセル機能
- `#273` 本番切替（既存予約フォーム・`_includes/calendar_embed.html`の撤去、
  Studio Nagoya Base / SNB mens側の予約導線切替を含む）
- 料金自動計算・決済・会員DB照合
- 既存予約フォーム（`studio-x/reservation/`）・`_includes/calendar_embed.html`の変更/撤去

## 固定仕様（空き判定。Issue #265/#266から変更なし）

| 項目 | 値 |
| --- | --- |
| 営業時間 | 08:00〜23:00 |
| 最低利用時間 | 120分 |
| 開始時刻の刻み | 15分（`SLOT_STEP_MINUTES`） |
| 予約同士の間隔（マージン） | 15分以上 |
| タイムゾーン | Asia/Tokyo |
| 終日イベント | 空き枠を占有しない |

`createBooking`も開始時刻が`SLOT_STEP_MINUTES`（既定15分）刻みであることをサーバー側で
必須とする（例: `10:00`/`10:15`/`10:30`/`10:45`は許可、`10:07`は`START_TIME_NOT_ALIGNED`
で拒否）。getAvailabilityが提示する候補開始時刻と、実際にcreateBookingできる開始時刻を
一致させるハード制約であり、フロントのUI都合ではない（`Booking.gs`の
`validateCreateBookingInput`参照）。

## ファイル構成

### Issue #266（getAvailability。変更なし）

- `Code.gs` — Web Appエントリポイント（`doGet`/`doPost`両方をここに置く）
- `Availability.gs` — 空き判定ロジック本体（GAS組み込みサービス非依存）
- `CalendarRepository.gs` — Google Calendarアクセス（読み取り専用部分は#266のまま）
- `Config.gs` — Script Propertiesの読み出しと固定仕様のデフォルト値

### Issue #268（createBookingで追加）

- `Booking.gs` — 予約状態（STATUS）・状態遷移（canTransition）・入力検証
  （validateCreateBookingInput）・bookingId発行（generateBookingId）・TTL失効時刻計算
  （computeTtlExpiryMillis/isExpired）。GAS組み込みサービス非依存の純粋ロジック
- `RateLimiter.gs` — CacheServiceを使ったスライディングウィンドウ方式のrate limit
  （同一メール・全体・同一内容連投）
- `CalendarRepository.gs`（拡張） — `createBookingEvent`/`getEventById`/
  `deleteEventById`/`setEventStatus`を追加。PENDINGイベントにはbookingId/status/brandを
  `CalendarEvent.setTag`で保存し、タイトル・説明にはPIIを一切書き込まない
- `SpreadsheetRepository.gs` — 予約台帳（`Bookings`シート）の読み書き
- `RecoveryRepository.gs` — 部分失敗記録（`Recovery`シート）の読み書き
- `BookingRepository.gs` — `createBooking`/`confirmBooking`/`expirePendingBookings`の
  オーケストレーション本体（Lock・補償・recovery記録を含む）
- `AdminNotifier.gs` — 管理者向け最低限の通知フック（`ADMIN_NOTIFICATION_EMAIL`未設定時は
  何もしない）
- `BookingAdmin.gs` — Spreadsheetのカスタムメニュー（`onOpen`）と正式関数
  `confirmBooking(bookingId)`
- `BookingTriggers.gs` — 時間主導トリガー用の正式関数`expirePendingBookings()`と、
  トリガー作成の補助関数`createExpirePendingBookingsTrigger()`
- `Code.gs`（拡張） — `doPost`を追加（`createBooking`用。POST専用）

## Script Properties

| プロパティ名 | 必須 | 内容 |
| --- | --- | --- |
| `CALENDAR_ID` | ○ | 空き判定・予約の正とするGoogle Calendarのカレンダーid（#266から変更なし） |
| `SPREADSHEET_ID` | ○（#268で追加） | 予約台帳・recovery記録を保存する専用Spreadsheetのid |
| `TIMEZONE` | - | 省略時 `Asia/Tokyo` |
| `OPEN_TIME` | - | 省略時 `08:00` |
| `CLOSE_TIME` | - | 省略時 `23:00` |
| `MIN_BOOKING_MINUTES` | - | 省略時 `120` |
| `BUFFER_MINUTES` | - | 省略時 `15`（予約間マージン） |
| `SLOT_STEP_MINUTES` | - | 省略時 `15`（getAvailabilityの候補生成刻み） |
| `PENDING_TTL_HOURS` | - | 省略時 `24`。PENDINGを受付から何時間保持するか |
| `PENDING_TTL_MIN_HOURS_BEFORE_START` | - | 省略時 `2`。利用開始の何時間前を超えて保持しないか |
| `RATE_LIMIT_EMAIL_COUNT` | - | 省略時 `3` |
| `RATE_LIMIT_EMAIL_WINDOW_MINUTES` | - | 省略時 `10` |
| `RATE_LIMIT_GLOBAL_COUNT` | - | 省略時 `20` |
| `RATE_LIMIT_GLOBAL_WINDOW_MINUTES` | - | 省略時 `1` |
| `RATE_LIMIT_DUPLICATE_WINDOW_MINUTES` | - | 省略時 `2`。同一内容の連投とみなす時間窓 |
| `ADMIN_NOTIFICATION_EMAIL` | - | 省略時は管理者通知を送らない（未設定でもcreateBooking自体は失敗しない） |

TTL・レート制限の数値プロパティは、誤設定（数値以外・0以下）の場合でも例外にせず
安全な既定値へフォールバックする（fail-openでレート制限が無効化される事故を防ぐため。
`Config.gs`のコメント参照）。

一方、`OPEN_TIME`/`CLOSE_TIME`/`MIN_BOOKING_MINUTES`/`BUFFER_MINUTES`/`SLOT_STEP_MINUTES`
（Availability設定）が誤設定の場合は、フォールバックせず`createBooking`・`getAvailability`
の両方をfail-closedに`INVALID_CONFIG`で拒否する。例えば`BUFFER_MINUTES=abc`のまま
既存予約との重複判定（`isStartTimeBookable`）へ進むと、NaNを含む比較が常にfalseになり
既存予約との競合を見落とす恐れがあるため、`createBooking`は`Booking.validateCreateBookingInput`
の冒頭で`BookingAvailability.validateInput`（getAvailabilityと同じ設定検証）を通し、
Calendarへ問い合わせる前に必ず設定の妥当性を確認する。

## Spreadsheet構成

1. 新規のGoogle Spreadsheetを1つ作成し、そのidを`SPREADSHEET_ID`に設定する。
2. シート（タブ）は初回アクセス時に自動作成される（`Bookings`・`Recovery`とも、
   存在しなければ`SpreadsheetRepository`/`RecoveryRepository`が作成しヘッダー行を書く）。
   手動でシートを作る必要はない。

### `Bookings`シート（予約台帳）列構成

`bookingId` / `createdAt` / `date` / `startAt` / `endAt` / `brand` / `name` / `email` /
`phone` / `people` / `purpose` / `paymentMethod` / `status` / `calendarEventId` /
`source` / `note` / `confirmedAt` / `expiredAt` / `cancelledAt` / `updatedAt`

- `status`は`PENDING` / `CONFIRMED` / `CANCELLED` / `EXPIRED`のいずれか。
  **このセルを直接手編集するのは正式運用ではない。** 確定は必ず`confirmBooking(bookingId)`
  （カスタムメニュー経由）を使うこと。TTL失効・キャンセルも将来的に専用関数経由のみとする。
- 料金列は持たない（Phase 1では自動料金計算をしないため）。

### `Recovery`シート（部分失敗・不整合記録）列構成

`bookingId` / `failureType` / `occurredAt` / `calendarEventId` / `status` /
`errorMessage` / `recoveryState` / `resolvedAt`

`failureType`の主な値:

| failureType | 意味 |
| --- | --- |
| `CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE` | createBooking: Calendar作成成功→Sheets保存失敗→Calendarを補償削除できた |
| `SHEETS_FAILURE_CALENDAR_ORPHANED` | createBooking: 上記でCalendarの補償削除も失敗（**要手動対応**。Calendar側にPENDINGイベントが残っている） |
| `CALENDAR_ROLLED_BACK_AFTER_CONFIRM_SHEETS_FAILURE` | confirmBooking: CalendarをCONFIRMEDへ更新成功→Sheets更新失敗→CalendarをPENDINGへ補償できた |
| `CONFIRM_SHEETS_FAILURE_CALENDAR_ORPHANED` | confirmBooking: 上記でCalendarの補償（PENDINGへ戻す）も失敗（**要手動対応**。CalendarはCONFIRMED・SheetsはPENDINGのまま不整合） |
| `CONFIRM_CALENDAR_EVENT_MISSING` | confirmBooking時に対応するCalendarイベントが見つからない（Sheets側はPENDINGのまま） |
| `EXPIRE_CALENDAR_DELETE_FAILED` | expirePendingBookings: Calendarイベント削除が失敗（Sheets側はEXPIREDへ進めている） |
| `EXPIRE_SHEETS_UPDATE_FAILED` | expirePendingBookings: Calendarイベント削除成功→Sheets側のEXPIRED更新が失敗（**要手動対応**。CalendarはPENDINGのイベントが既に削除済み・SheetsはPENDING表示のまま不整合） |
| `ADMIN_NOTIFICATION_FAILED` | 管理者通知メール送信に失敗（予約自体は成功のまま。情報用途） |

## 部分失敗・recoveryの確認手順（運用者向け）

1. `Recovery`シートを開き、`recoveryState`が`OPEN`の行を確認する
   （`RESOLVED`は自動補償済み、`INFO`は通知失敗など予約自体に影響のない記録）。
2. `failureType`が`SHEETS_FAILURE_CALENDAR_ORPHANED`の場合、`calendarEventId`を
   Google Calendarで直接開いて確認し、不要であれば手動で削除する。
3. `failureType`が`CONFIRM_CALENDAR_EVENT_MISSING`の場合、`bookingId`を`Bookings`
   シートで確認し、Calendar側に該当イベントが本当にないかを確認する。運用判断で
   利用者へ連絡するか、Calendarへ手動でイベントを作り直してから再度
   `confirmBooking(bookingId)`を実行する。
4. `failureType`が`CONFIRM_SHEETS_FAILURE_CALENDAR_ORPHANED`の場合、`calendarEventId`を
   Calendarで開いて確定表示（`[Studio X 確定]`）になっているか確認する。`Bookings`
   シート側は`PENDING`のままなので、Sheets側の`status`を手動で`CONFIRMED`に直接書き換える
   のではなく、Calendar側の表示を`[Studio X 仮予約]`へ手動で戻すか、Sheets保存先の
   一時的な障害が解消したことを確認したうえで再度`confirmBooking(bookingId)`を実行する
   （`getEventById`はCalendarイベントが現存する限り再実行を妨げない）。
5. `failureType`が`EXPIRE_SHEETS_UPDATE_FAILED`の場合、`calendarEventId`のCalendarイベントは
   既に削除済みだが、`Bookings`シート側は`status`が`PENDING`のまま残っている。
   Sheets保存先の一時的な障害が解消したことを確認できれば、`statusセルの直接編集はしない`
   （`expirePendingBookings`を再実行すれば、このbookingIdはまだ`PENDING`のため再び候補として
   抽出され、Calendar側は既に削除済みのため`EXPIRE_CALENDAR_DELETE_FAILED`が追加記録される
   ものの、続くSheets更新が今度は成功すれば`status`が正しく`EXPIRED`になる。この経路は
   `test/booking-confirm-expire.test.js`の障害分離テストと同じ仕組みで安全に再実行できる）。
6. 対応が完了したら、`Recovery`シートの`recoveryState`・`resolvedAt`列へ手動で
   記録する（このシートはBookings台帳と異なり、運用者が直接編集してよい）。

## API仕様

### `GET ?date=YYYY-MM-DD&durationMinutes=120&brand=studio_x`（getAvailability。#266から変更なし）

成功時：

```json
{
  "success": true,
  "date": "2026-10-01",
  "durationMinutes": 120,
  "brand": "studio_x",
  "bookableStartTimes": ["08:00", "08:15", "..."]
}
```

### `POST`（createBooking。#268で追加）

リクエストボディ（JSON。`Content-Type`はGAS Web Appの制約上テキストとして送る想定。
フロントエンド実装は#269の責務）:

```json
{
  "brand": "studio_x",
  "date": "2026-10-01",
  "startTime": "10:00",
  "durationMinutes": 120,
  "name": "山田太郎",
  "email": "taro@example.com",
  "phone": "090-1234-5678",
  "people": "2名",
  "purpose": "緊縛の自主練習",
  "paymentMethod": "現金",
  "note": "",
  "source": "studio-x-reservation-form"
}
```

成功時：

```json
{
  "success": true,
  "bookingId": "SX-20261001-3F2A9B1C",
  "status": "PENDING",
  "date": "2026-10-01",
  "startTime": "10:00",
  "durationMinutes": 120,
  "brand": "studio_x"
}
```

呼び出した本人が送った内容の要約のみを返し、他の予約のイベント詳細・PIIは一切含まない。

失敗時：

```json
{ "success": false, "error": { "code": "SLOT_CONFLICT", "message": "..." } }
```

`error.code`の主な値: `INVALID_BRAND` / `INVALID_CONFIG`（Availability設定自体が不正。
fail-closed） / `INVALID_DATE` / `INVALID_DURATION` / `DURATION_TOO_SHORT` /
`INVALID_START_TIME` / `START_TIME_NOT_ALIGNED`（開始時刻が`SLOT_STEP_MINUTES`刻みでない）/
`INVALID_NAME` / `INVALID_EMAIL` / `INVALID_PHONE` / `INVALID_PEOPLE` / `INVALID_PURPOSE` /
`INVALID_PAYMENT_METHOD` / `INVALID_NOTE` / `INVALID_SOURCE` / `RATE_LIMITED`
（`error.reason`に`EMAIL_RATE_LIMIT`/`GLOBAL_RATE_LIMIT`/`DUPLICATE_SUBMISSION`のいずれか）/
`LOCK_TIMEOUT` / `SLOT_CONFLICT` / `BOOKING_SAVE_FAILED` / `INVALID_JSON` /
`INTERNAL_ERROR`

Phase 1では`studio_x`以外の`brand`を指定してもサーバー側で拒否する
（フロント表示に関わらずbrand偽装で他ブランドの予約は作れない）。

## 管理メニューのセットアップ（installable onOpenトリガー）

このGASプロジェクトはスタンドアロンのWeb Appとして運用する（「デプロイ設定」参照）。
スタンドアロンスクリプトに単純トリガーの`onOpen()`を書くだけでは、`SPREADSHEET_ID`で
指定した対象Spreadsheetを開いても「予約管理」メニューは自動表示されない
（単純トリガーのonOpenは、このスクリプト自身が対象Spreadsheetに
コンテナバインドされている場合のみ発火するため）。

**正式な運用手順（この方式で動作確認する）**: 運用開始時に、スクリプトエディタで
`installBookingAdminMenuTrigger` を選択して一度だけ手動実行する。これにより、
`SPREADSHEET_ID`のSpreadsheetに対するinstallable onOpenトリガーが作成され
（実行には対象Spreadsheetへの編集権限が必要）、以降そのSpreadsheetを開くたびに
`addBookingAdminMenu`が呼ばれて「予約管理」メニューが自動的に追加されるようになる。
同一Spreadsheet・同一ハンドラのトリガーが既に存在する場合は重複作成しない。

（このスクリプトを将来コンテナバインド型へ分離・移行する場合に備え、単純トリガーの
`onOpen()`もフォールバックとして残しているが、上記のスタンドアロン運用では発火しない
ため、`installBookingAdminMenuTrigger`の実行が必須）。

## 管理メニューからの予約確定（confirmBooking）手順

1. 上記のセットアップ済みであることを確認し、`SPREADSHEET_ID`で指定したSpreadsheetを
   開くと「予約管理」メニューが表示される。
2. 確定したい予約の内容を`Bookings`シートで確認する。
3. 次のいずれかの方法で確定する。
   - **アクティブ行を確定**: `Bookings`シート上で対象の行（bookingIdの行）を選択してから、
     メニュー「予約管理」→「アクティブ行のbookingIdを確定（confirmBooking）」を実行する。
   - **bookingIdを入力して確定**: メニュー「予約管理」→「bookingIdを入力して確定
     （confirmBooking）」を実行し、ダイアログにbookingIdを入力する。
4. 結果はダイアログで表示される。成功時は`status`が`CONFIRMED`になり、`confirmedAt`が
   記録され、対応するCalendarイベントのタイトルが`[Studio X 確定]`へ更新される。
5. スクリプトエディタから`confirmBooking("SX-...")`を直接実行することもできる
   （Issue #268本文の正式関数名）。
6. **`status`セルを直接編集して確定させる運用はしないこと。** 必ずこの手順（＝
   `confirmBooking`経由）で行う。二重実行しても壊れない（2回目は「すでに確定済みです」と
   表示されるだけで安全）。

## PENDING TTL失効トリガーの作成手順

本PRでは本番の時間主導トリガー作成そのものは行わない（コードのみ実装）。以下の
いずれかの方法で運用開始時に設定する。

- **方法A（推奨・補助関数を使う）**: スクリプトエディタで`createExpirePendingBookingsTrigger`
  を選択し、一度だけ実行する。`expirePendingBookings`を15分おきに実行するトリガーが
  作成される（同名トリガーが既にある場合は重複作成しない）。
- **方法B（Apps Script UIから手動作成）**: スクリプトエディタ左メニューの「トリガー」→
  「トリガーを追加」→ 実行する関数: `expirePendingBookings` / イベントのソース:
  時間主導型 / 時間ベースのタイマー: 分ベースのタイマー（例: 15分おき）を選択して保存する。

失効判定は「受付から`PENDING_TTL_HOURS`時間後」と「利用開始時刻の
`PENDING_TTL_MIN_HOURS_BEFORE_START`時間前」の早い方。失効したPENDINGは
Calendarイベントを削除し、Sheets側の`status`を`EXPIRED`にして`expiredAt`を記録する。
Calendar削除に失敗した場合も`Recovery`シートへ記録した上でSheets側はEXPIREDへ進める
（PENDINGのまま放置しない）。

## デプロイ設定

- **実行ユーザー（Execute as）**: Me（自分）
- **アクセスできるユーザー（Who has access）**: Anyone（匿名を含む全員）
  - `doGet`（getAvailability）は読み取り専用のため元々匿名アクセス前提。
  - `doPost`（createBooking）は個人情報を書き込むが、Web App URLの秘匿を
    セキュリティ要件にせず、サーバー側の入力検証・rate limit・LockServiceで防御する
    方針（Issue #268本文の「Web App URLの秘匿をセキュリティ要件にしない」を踏襲）。

## セットアップ手順

1. 新規のGoogle Apps Scriptプロジェクトを作成し、このディレクトリ配下の全`.gs`ファイルと
   `appsscript.json`をコピーする（スタンドアロンスクリプトのままでよい。
   `SPREADSHEET_ID`のSpreadsheetへコンテナバインドする必要はない）。
2. 上記のScript Propertiesを設定する（最低限 `CALENDAR_ID` / `SPREADSHEET_ID`）。
3. Webアプリとして新規デプロイし、上記の「デプロイ設定」の通りに設定する。
4. デプロイ後のWeb App URLは、本Issueでは既存フォーム・既存サイトのどこからも
   参照しない（#269以降の共通予約UI実装時に接続する）。
5. 運用開始時に「PENDING TTL失効トリガーの作成手順」に従ってトリガーを作成する。
6. 運用開始時に「管理メニューのセットアップ（installable onOpenトリガー）」に従って
   `installBookingAdminMenuTrigger`を一度だけ手動実行する。

## ロールバック方法

このPRはコード追加のみで、本番デプロイ・実Calendarへの書き込み・Spreadsheet運用開始を
一切行っていない。マージ後に問題が見つかった場合:

- **本番デプロイ前に気づいた場合**: そのままPRをrevertする、またはこのブランチのマージ
  コミットをrevertすれば元の状態（#266のgetAvailabilityのみ）に戻る。
- **Web Appを新デプロイ済みの場合**: Apps Scriptのデプロイ管理から、`doPost`を含まない
  古いバージョン（#266時点のデプロイ）へロールバックする、または新デプロイを無効化する。
  `doGet`（getAvailability）の挙動はこのIssueで変更していないため、ロールバックしても
  既存フォーム・既存の空き判定表示には影響しない。
- **時間主導トリガーを作成済みの場合**: スクリプトエディタの「トリガー」画面から
  `expirePendingBookings`のトリガーを削除する。
- **管理メニュー用のinstallable onOpenトリガーを作成済みの場合**: 同じく「トリガー」画面から
  `addBookingAdminMenu`のトリガーを削除する。
- **Spreadsheet運用を開始済みの場合**: `Bookings`/`Recovery`シートはこのGASプロジェクト
  以外から書き込まれないため、GASのデプロイを止めれば新規の自動書き込みは止まる
  （既存の行データ自体を削除する必要はない）。

## 設計判断メモ（レビュー時にご確認ください）

Issue本文で「実装前に確認してほしい」とされた設計ポイントについて、今回採用した方針。
仕様変更が必要な場合はご連絡ください。

1. **Calendar成功→Sheets失敗時の補償方法**: `createBooking`はCalendarイベントの削除を試み、
   成功すれば`CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE`、削除も失敗すれば
   `SHEETS_FAILURE_CALENDAR_ORPHANED`として`Recovery`シートへ記録する
   （`BookingRepository.gs`の`handleSheetsSaveFailure_`）。同じ考え方を状態遷移にも適用し、
   `confirmBooking`（Calendar確定成功→Sheets更新失敗→CalendarをPENDINGへ補償）・
   `expirePendingBookings`（Calendar削除成功→Sheets更新失敗→次回再実行で自動的に整合を取り戻せる）
   にもrecovery記録と対応方針を用意している（レビュー指摘を受けて追加）。
2. **bookingIdをCalendarへどう保持するか**: `CalendarEvent.setTag('bookingId', ...)`/
   `setTag('status', ...)`で保持し、タイトルには`[Studio X 仮予約] <bookingId>`のように
   人が一覧で読める形でも重複して載せている（判定ロジックはタグのみを見る。タイトルは
   表示用）。氏名・メール・電話等のPIIはCalendar側に一切書き込まない。
3. **Lockの範囲**: `createBooking`は「Calendar再取得〜Sheets保存」のみをLockで保護し、
   入力検証・rate limit確認・管理者通知はLockの外。`confirmBooking`・
   `expirePendingBookings`の各候補処理もそれぞれ短時間のLockで保護している。
4. **PENDING TTLとEXPIRED状態遷移**: 「受付+24h」と「開始-2h」の早い方を失効時刻とし、
   時間主導トリガー（`expirePendingBookings`）が候補を抽出→Lock取得→status再確認→
   Calendar削除→Sheets更新の順で処理する。
5. **rate limitの保存方式**: `CacheService`にスライディングウィンドウ（タイムスタンプ配列の
   JSON）を保存する方式を採用。PropertiesServiceより高頻度カウンタ用途に向いている一方、
   CacheServiceの性質上、複数インスタンス間で常に完全同期しているとは限らない
   「概ね閾値を超えたら拒否する」ゆるい防御として位置づけている。
6. **SpreadsheetカスタムメニューからのbookingId指定方法・実運用方式**: 「アクティブ行を確定」
   （選択中の行のA列=bookingIdを読む）と「bookingIdを入力して確定」（プロンプト入力）の
   2通りを用意した。このGASプロジェクトはスタンドアロンWeb Appのため、単純トリガーの
   `onOpen()`だけでは対象Spreadsheetを開いてもメニューが出ない。そのため
   `installBookingAdminMenuTrigger()`でSPREADSHEET_IDに対するinstallable onOpenトリガーを
   明示的に作成する方式を正式手順とした（レビュー指摘を受けて、曖昧な「コンテナバインド
   推奨」から具体的な実装・セットアップ手順へ変更）。
7. **createBooking APIのPOST方式**: `doPost`を新設し、`e.postData.contents`をJSONとして
   パースする。GETクエリパラメータでは個人情報を送らせない。
8. **doGet/getAvailabilityとdoPost/createBookingの共存**: 同一`Code.gs`内で`doGet`
   （#266のまま変更なし）と`doPost`（#268で追加）を分離して定義しており、GAS Web Appは
   同一デプロイでこの両方を配信できる。

### PRレビュー（1回目）指摘への追加対応

1回目のレビューで以下4点の指摘を受け、対応した。

- **開始時刻の15分刻みをcreateBookingでも必須化**: `Booking.validateCreateBookingInput`に
  `START_TIME_NOT_ALIGNED`判定を追加（例: `10:07`は拒否、`10:00`/`10:15`/`10:30`/`10:45`は許可）。
- **Availability設定全体のfail-closed検証をcreateBookingにも適用**: `BookingAvailability.validateInput`
  （getAvailabilityと同じ設定検証）を`createBooking`の入力検証冒頭で呼び出し、
  `BUFFER_MINUTES`等の誤設定時にNaNのまま競合判定へ進んで既存予約の見落としが起きないようにした。
- **Spreadsheetカスタムメニューの実運用方式を明確化**: 上記6.の`installBookingAdminMenuTrigger()`を追加。
- **confirmBooking/expirePendingBookingsの部分失敗もrecoveryへ記録**: 上記1.のとおり両関数に
  補償・recovery記録を追加した。

## テスト結果について

このREADME・PRに記載する「node --testが全件pass」は、**ローカルで`node --test`を実行した
結果**であり、GitHub Actions等のCIが本リポジトリに設定されている、またはそのCIが通過した
ことを意味しない（本リポジトリには現時点でCIが登録されていない）。実Calendar・実Spreadsheet・
実デプロイへの検証はいずれも「デプロイ後の手動確認」節に委ねている。

## テストの実行

```
node --test
```

Issue #266関連（変更なし）:

- `test/booking-availability.test.js` — `Availability.gs` の空き判定ロジック
- `test/booking-calendar-repository.test.js` — `CalendarRepository.gs` の読み取り部分
- `test/booking-config.test.js` — `Config.gs` のデフォルト値・Script Properties上書き
- `test/booking-code-runtime.test.js` — `doGet`配線全体の検証（`doPost`が追加されている
  ことの確認も含む）

Issue #268で追加:

- `test/booking-model.test.js` — `Booking.gs`（入力検証・15分刻み判定・Availability設定の
  fail-closed検証・bookingId発行・状態遷移・TTL計算）
- `test/booking-rate-limiter.test.js` — `RateLimiter.gs`（同一メール/全体/連投のスライディング
  ウィンドウ制限）
- `test/booking-spreadsheet-repository.test.js` — `SpreadsheetRepository.gs` /
  `RecoveryRepository.gs`（台帳read/write・recovery記録）
- `test/booking-create-booking.test.js` — `BookingRepository.createBooking`の統合テスト
  （正常系・15分刻み拒否・設定fail-closed拒否・#267境界の競合検出・LockService・rate limit・
  部分失敗補償・管理者通知失敗など）
- `test/booking-confirm-expire.test.js` — `confirmBooking`/`expirePendingBookings`の
  統合テスト（状態遷移・TTL・二重実行・部分失敗補償/recovery記録・障害分離・installable
  onOpenトリガーの作成/重複防止・管理メニューの配線）

CalendarApp / PropertiesService / Utilities / ContentService / LockService /
CacheService / SpreadsheetApp / MailApp / ScriptApp はいずれもテスト用スタブに
差し替えており、実際のGoogle Calendar・Spreadsheet・Script Propertiesにはアクセスしない
（`test/helpers/gas-stubs.js`）。実Calendarへ直接書き込むテストは、通常の自動テストとして
実装していない（Issue #268本文の要件どおり）。

## デプロイ後の手動確認（実Calendar・実Spreadsheet・実デプロイが前提のため、コードレビュー時点では確認不能）

- [ ] Web Appが「Anyone」設定で、ログインなしでも`doGet`/`doPost`ができること
- [ ] `doPost`で送信した予約が、実際にCalendarへPENDINGイベントとして作成されること
- [ ] 同じ予約が`Bookings`シートに同じbookingIdで保存されること
- [ ] getAvailabilityで空きだった枠が、スペースマーケット予約で埋まった直後に
      `createBooking`すると`SLOT_CONFLICT`になり、CalendarにもSheetsにも何も作られないこと
- [ ] `installBookingAdminMenuTrigger`を実行後、`SPREADSHEET_ID`のSpreadsheetを開くと
      実際に「予約管理」メニューが表示されること（スタンドアロン運用での実地確認）
- [ ] Spreadsheetのカスタムメニューから`confirmBooking`が実行できること
- [ ] `expirePendingBookings`のトリガーが実際に15分おきに動作すること
- [ ] 既存の`_includes/calendar_embed.html`および`studio-x/reservation/`の予約フォームが
      これまで通り動作すること（本Issueでは一切変更していない）

Phase 0のゲート確認（スペースマーケットとの同一Calendar共存の実環境確認）は
Issue #267で完了（PASS, 2026-09-19）。確認手順・記録は
[`docs/phase0-issue267-spacemarket-coexistence.md`](../../docs/phase0-issue267-spacemarket-coexistence.md)
を参照。
