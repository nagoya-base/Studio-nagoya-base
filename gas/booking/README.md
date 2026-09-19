# gas/booking（自社予約システム）

Epic #265の一部として以下を実装済み。

- **Issue #266**: `getAvailability`（読み取り専用の空き判定）
- **Issue #268**: `createBooking`（Studio X限定の仮予約作成）・予約台帳（Spreadsheet）・
  PENDING/CONFIRMED/CANCELLED/EXPIRED状態管理・部分失敗補償・TTL失効・レート制限・
  Spreadsheetカスタムメニューからの予約確定

このディレクトリは自社予約システム専用のApps Scriptプロジェクトの元になるソース一式
（複数プロジェクトへ配布するファイル群）として運用し、`gas/ataru_survey_public` 等の
既存GASプロジェクトとは完全に分離する（互いのコードを参照・importしない）。

**このディレクトリのファイルは、2つの独立したApps Scriptプロジェクトへ配布する。**
Googleの仕様上、Spreadsheetのカスタムメニュー（`SpreadsheetApp.getUi()`）は
対象Spreadsheetへコンテナバインドしたスクリプトからしか作成できないため、
Web App本体とは別にコンテナバインドの管理用プロジェクトを用意する（詳細は
「GASプロジェクトへのデプロイ対象ファイル」節を参照）。

| プロジェクト | 種別 | 役割 |
| --- | --- | --- |
| **Booking Web App** | スタンドアロン | `getAvailability`（`doGet`）・`createBooking`（`doPost`）・PENDING TTL失効（`expirePendingBookings`の時間主導トリガー） |
| **Booking Admin** | `SPREADSHEET_ID`のSpreadsheetへコンテナバインド | カスタムメニュー（`onOpen`）・`confirmBooking(bookingId)` |

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
- Spreadsheetカスタムメニューからの予約確定（`confirmBooking(bookingId)`）。
  コンテナバインドの別GASプロジェクト（Booking Admin）から実行する
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
  `confirmBooking(bookingId)`。**Booking Adminプロジェクト（コンテナバインド）専用**
- `BookingTriggers.gs` — 時間主導トリガー用の正式関数`expirePendingBookings()`と、
  トリガー作成の補助関数`createExpirePendingBookingsTrigger()`。
  **Booking Web Appプロジェクト（スタンドアロン）専用**
- `Code.gs`（拡張） — `doPost`を追加（`createBooking`用。POST専用）。
  **Booking Web Appプロジェクト（スタンドアロン）専用**

## GASプロジェクトへのデプロイ対象ファイル

上記の理由（カスタムメニューはコンテナバインドスクリプトでしか作成できない）により、
このディレクトリの`.gs`ファイルは、**Booking Web App**（スタンドアロン）と
**Booking Admin**（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）という
2つの独立したApps Scriptプロジェクトへ配布する。

| ファイル | Booking Web App（スタンドアロン） | Booking Admin（コンテナバインド） |
| --- | :---: | :---: |
| `Code.gs` | ✓ | – |
| `Availability.gs` | ✓ | – |
| `Config.gs` | ✓ | ✓ |
| `CalendarRepository.gs` | ✓ | ✓ |
| `Booking.gs` | ✓ | ✓ |
| `RateLimiter.gs` | ✓ | – |
| `SpreadsheetRepository.gs` | ✓ | ✓ |
| `RecoveryRepository.gs` | ✓ | ✓ |
| `BookingRepository.gs` | ✓ | ✓ |
| `AdminNotifier.gs` | ✓ | – |
| `BookingTriggers.gs` | ✓ | – |
| `BookingAdmin.gs` | – | ✓ |
| `appsscript.json` | ✓（Web App設定を含む） | 不要（新規プロジェクト作成時の既定のままでよい） |

`BookingRepository.gs`の`confirmBooking`が実際に参照するファイルは
`Config.gs`/`Booking.gs`/`CalendarRepository.gs`/`SpreadsheetRepository.gs`/
`RecoveryRepository.gs`のみ（`createBooking`/`expirePendingBookings`が使う
`Availability.gs`/`RateLimiter.gs`/`AdminNotifier.gs`/`BookingTriggers.gs`は
Booking Adminプロジェクトでは呼び出されない）。ただし、コピー漏れによる将来の
機能追加時の事故を避けるため、上表のとおり「`Code.gs`/`Availability.gs`/
`RateLimiter.gs`/`AdminNotifier.gs`/`BookingTriggers.gs`以外の全ファイル」を
Booking Adminプロジェクトにも配布することを推奨する。

両プロジェクトは**同一の`.gs`ファイル**（このリポジトリの`gas/booking/`）を元にしており、
コード自体を複製・分岐させているわけではない（clasp等のデプロイ自動化は本リポジトリに
未導入のため、現状はいずれも手動コピーでのデプロイになる。ファイルを更新した際は、
変更が影響する側のプロジェクトへ再度手動でコピーし直すこと）。

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

**Script PropertiesはApps Scriptプロジェクトごとに独立している。** Booking Web Appと
Booking Adminは別プロジェクトのため、`confirmBooking`が使う`CALENDAR_ID`・
`SPREADSHEET_ID`は、**両方のプロジェクトに同じ値を設定する必要がある**
（片方だけ設定・値がずれている場合、`confirmBooking`が誤ったCalendar/Spreadsheetを
参照してしまう）。`TTL_*`/`RATE_LIMIT_*`/`ADMIN_NOTIFICATION_EMAIL`はBooking Web App側
（`createBooking`/`expirePendingBookings`）でのみ使われるため、Booking Admin側には
設定不要。

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

## 管理メニュー用GASプロジェクト（Booking Admin）のセットアップ

**背景**: Googleの仕様上、`SpreadsheetApp.getUi()`によるカスタムメニュー作成は、
対象Spreadsheetへコンテナバインドしたスクリプト（Spreadsheetの「拡張機能 → Apps Script」
から作成するプロジェクト）からしか使えない。スタンドアロンスクリプトが対象Spreadsheetに
対するinstallable onOpenトリガーを作成しても、そのスクリプト自体がbound scriptになる
わけではなく、`getUi()`は利用できない（1回目レビューでは
`installBookingAdminMenuTrigger()`によるinstallable onOpenトリガー方式を採用したが、
この理由により2回目レビューで指摘を受け撤回した。Web App本体は変更していない）。

そのため、カスタムメニュー（`BookingAdmin.gs`）は、Web App本体（スタンドアロン）とは
別の、`SPREADSHEET_ID`のSpreadsheetへコンテナバインドした専用のApps Scriptプロジェクト
（Booking Admin）へデプロイする。

### セットアップ手順

1. `SPREADSHEET_ID`で指定したGoogle Spreadsheetを開く。
2. メニュー「拡張機能」→「Apps Script」を選択する（このSpreadsheetにコンテナバインドした
   新規プロジェクトが作成される）。
3. 「GASプロジェクトへのデプロイ対象ファイル」の表にある**Booking Admin列が✓のファイル**
   （`Config.gs` / `CalendarRepository.gs` / `Booking.gs` / `SpreadsheetRepository.gs` /
   `RecoveryRepository.gs` / `BookingRepository.gs` / `BookingAdmin.gs`）をコピーする。
4. このプロジェクトのScript Propertiesに `CALENDAR_ID` / `SPREADSHEET_ID` を設定する
   （Booking Web App側と同じ値。「Script Properties」節参照）。
5. 保存してSpreadsheetを再読み込みする。コンテナバインドスクリプトの`onOpen()`単純トリガーが
   自動的に発火し、「予約管理」メニューが表示される（installable trigger等の追加設定は
   一切不要。これがcontainer-bound scriptの標準的な挙動）。
6. Web Appとしてのデプロイは不要（このプロジェクトはSpreadsheetのUI拡張としてのみ使う）。

### 既知の制約（LockServiceがプロジェクトごとに独立している）

`LockService.getScriptLock()`が提供する排他は、**呼び出し元のApps Scriptプロジェクト内**
でのみ有効であり、別プロジェクト間では共有されない。`confirmBooking`はBooking Admin
プロジェクトで、`expirePendingBookings`はBooking Web Appプロジェクトでそれぞれ独立して
Lockを取得するため、この2つは互いを排他できない。

万一、ちょうど同じタイミングで管理者が`confirmBooking`を実行し、かつ時間主導トリガーが
同じbookingIdを失効処理しようとした場合、理論上は競合のwindowが残る。これを緩和するため、
`confirmBooking`はCalendarを実際に書き換える直前にもう一度Sheets上のstatusを読み直し、
その間にstatusが変化していれば（`CONFLICTING_STATUS_CHANGE`）Calendar/Sheetsのどちらも
変更せずに中断する（`BookingRepository.gs`参照。`test/booking-confirm-expire.test.js`で
検証済み）。同様に`expirePendingBookings`もCalendar削除・Sheets更新の直前にstatusを
再確認する。これにより競合windowは大幅に狭まるが、**理論上のwindowをゼロにはできない**
（「同一Calendarと直前再確認でリスクを最小化する設計」であり、「絶対に競合しない」とは
主張しない。#267のスペースマーケット共存と同じ考え方）。実運用上は、TTL失効の対象になる
ほど古いPENDINGを管理者が実際に確定しようとする状況自体が稀であり、影響は限定的と判断
している。

## 管理メニューからの予約確定（confirmBooking）手順

1. Booking Adminプロジェクトのセットアップが完了していれば、`SPREADSHEET_ID`で
   指定したSpreadsheetを開くだけで「予約管理」メニューが自動的に表示される
   （追加のトリガー設定は不要）。
2. 確定したい予約の内容を`Bookings`シートで確認する。
3. 次のいずれかの方法で確定する。
   - **アクティブ行を確定**: `Bookings`シート上で対象の行（bookingIdの行）を選択してから、
     メニュー「予約管理」→「アクティブ行のbookingIdを確定（confirmBooking）」を実行する。
   - **bookingIdを入力して確定**: メニュー「予約管理」→「bookingIdを入力して確定
     （confirmBooking）」を実行し、ダイアログにbookingIdを入力する。
4. 結果はダイアログで表示される。成功時は`status`が`CONFIRMED`になり、`confirmedAt`が
   記録され、対応するCalendarイベントのタイトルが`[Studio X 確定]`へ更新される。
5. Booking Adminプロジェクトのスクリプトエディタから`confirmBooking("SX-...")`を
   直接実行することもできる（Issue #268本文の正式関数名）。
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

## デプロイ設定（Booking Web Appプロジェクト）

Booking Adminプロジェクト（コンテナバインド）はWeb Appとしてデプロイしない
（Spreadsheetを開いたときのUI拡張として動くだけでよい）。以下はBooking Web App
プロジェクトのみに適用する設定。

- **実行ユーザー（Execute as）**: Me（自分）
- **アクセスできるユーザー（Who has access）**: Anyone（匿名を含む全員）
  - `doGet`（getAvailability）は読み取り専用のため元々匿名アクセス前提。
  - `doPost`（createBooking）は個人情報を書き込むが、Web App URLの秘匿を
    セキュリティ要件にせず、サーバー側の入力検証・rate limit・LockServiceで防御する
    方針（Issue #268本文の「Web App URLの秘匿をセキュリティ要件にしない」を踏襲）。

## セットアップ手順

1. **Booking Web App**: 新規のスタンドアロンGoogle Apps Scriptプロジェクトを作成し、
   「GASプロジェクトへのデプロイ対象ファイル」表のBooking Web App列が✓のファイル
   （`BookingAdmin.gs`を除く全`.gs`ファイルと`appsscript.json`）をコピーする。
2. Script Propertiesを設定する（最低限 `CALENDAR_ID` / `SPREADSHEET_ID`）。
3. Webアプリとして新規デプロイし、上記の「デプロイ設定」の通りに設定する。
4. デプロイ後のWeb App URLは、本Issueでは既存フォーム・既存サイトのどこからも
   参照しない（#269以降の共通予約UI実装時に接続する）。
5. 運用開始時に「PENDING TTL失効トリガーの作成手順」に従ってトリガーを作成する。
6. **Booking Admin**: 「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」に
   従って別途セットアップする（`CALENDAR_ID` / `SPREADSHEET_ID`をこのプロジェクトにも
   同じ値で設定することを忘れないこと）。

## ロールバック方法

このPRはコード追加のみで、本番デプロイ・実Calendarへの書き込み・Spreadsheet運用開始を
一切行っていない。マージ後に問題が見つかった場合:

- **本番デプロイ前に気づいた場合**: そのままPRをrevertする、またはこのブランチのマージ
  コミットをrevertすれば元の状態（#266のgetAvailabilityのみ）に戻る。
- **Web Appを新デプロイ済みの場合**: Apps Scriptのデプロイ管理から、`doPost`を含まない
  古いバージョン（#266時点のデプロイ）へロールバックする、または新デプロイを無効化する。
  `doGet`（getAvailability）の挙動はこのIssueで変更していないため、ロールバックしても
  既存フォーム・既存の空き判定表示には影響しない。
- **時間主導トリガーを作成済みの場合**: Booking Web Appプロジェクトのスクリプトエディタ
  「トリガー」画面から`expirePendingBookings`のトリガーを削除する。
- **Booking Adminプロジェクトを作成済みの場合**: そのプロジェクト自体を削除するか、
  対象Spreadsheetへの紐付け（コンテナバインド）を解除すれば「予約管理」メニューは
  表示されなくなる。
- **Spreadsheet運用を開始済みの場合**: `Bookings`/`Recovery`シートはBooking Web App /
  Booking Adminの2プロジェクト以外から書き込まれないため、両方のGASデプロイ・
  スクリプトを止めれば新規の自動書き込みは止まる
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
   ただし`confirmBooking`（Booking Adminプロジェクト）と`expirePendingBookings`
   （Booking Web Appプロジェクト）は別々のApps ScriptプロジェクトのためLockServiceが
   共有されない。「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」内
   「既知の制約」を参照（2回目レビュー指摘を受けて追記）。
4. **PENDING TTLとEXPIRED状態遷移**: 「受付+24h」と「開始-2h」の早い方を失効時刻とし、
   時間主導トリガー（`expirePendingBookings`）が候補を抽出→Lock取得→status再確認→
   Calendar削除→Sheets更新の順で処理する。
5. **rate limitの保存方式**: `CacheService`にスライディングウィンドウ（タイムスタンプ配列の
   JSON）を保存する方式を採用。PropertiesServiceより高頻度カウンタ用途に向いている一方、
   CacheServiceの性質上、複数インスタンス間で常に完全同期しているとは限らない
   「概ね閾値を超えたら拒否する」ゆるい防御として位置づけている。
6. **SpreadsheetカスタムメニューからのbookingId指定方法・実運用方式**: 「アクティブ行を確定」
   （選択中の行のA列=bookingIdを読む）と「bookingIdを入力して確定」（プロンプト入力）の
   2通りを用意した。カスタムメニュー（`SpreadsheetApp.getUi()`）はGoogleの仕様上
   コンテナバインドスクリプトからしか作成できないため、`BookingAdmin.gs`は`SPREADSHEET_ID`
   のSpreadsheetへコンテナバインドした別プロジェクト（Booking Admin）へデプロイする方式を
   正式手順とした。1回目レビューでは、スタンドアロンのWeb Appプロジェクトから
   installable onOpenトリガーを作成する方式（`installBookingAdminMenuTrigger()`）を
   採用したが、installable triggerを作ってもスクリプト自体がbound scriptにはならず
   `getUi()`は使えないという2回目レビューの指摘を受けて撤回し、コンテナバインド
   プロジェクトへの分離に設計変更した（詳細は「管理メニュー用GASプロジェクト
   （Booking Admin）のセットアップ」を参照）。
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
- **Spreadsheetカスタムメニューの実運用方式を明確化**: `installBookingAdminMenuTrigger()`を追加した
  （※この対応は2回目レビューで撤回・再設計。下記参照）。
- **confirmBooking/expirePendingBookingsの部分失敗もrecoveryへ記録**: 上記1.のとおり両関数に
  補償・recovery記録を追加した。

### PRレビュー（2回目）指摘への追加対応

2回目のレビューで、1回目の管理メニュー対応（`installBookingAdminMenuTrigger()`による
installable onOpenトリガー方式）が「Googleの仕様上、カスタムメニューを作成できるのは
bound scriptのみであり、installable triggerを作ってもstandalone scriptがbound script
になるわけではない」という理由で不成立である、との指摘を受けた。指摘の通りであるため、
以下のとおり設計を変更した。

- `installBookingAdminMenuTrigger()`を`BookingAdmin.gs`から削除し、関連するテスト
  （`test/booking-confirm-expire.test.js`のinstallable trigger作成/重複防止テスト）・
  README記述（旧「管理メニューのセットアップ（installable onOpenトリガー）」節）も削除した。
- `BookingAdmin.gs`（カスタムメニュー・`confirmBooking`）を、Web App本体
  （スタンドアロンのまま維持）とは別の、`SPREADSHEET_ID`のSpreadsheetへコンテナバインドした
  専用プロジェクト（Booking Admin）へデプロイする設計に変更した。単純トリガーの`onOpen()`は
  そのままで、コンテナバインドスクリプトとしてデプロイすれば追加設定なしで機能する。
  ファイル構成・セットアップ手順・confirmBooking実行方法は「GASプロジェクトへの
  デプロイ対象ファイル」「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」
  「管理メニューからの予約確定（confirmBooking）手順」の各節に明記した。
- 副作用として、`confirmBooking`（Booking Adminプロジェクト）と`expirePendingBookings`
  （Booking Web Appプロジェクト）が別プロジェクトになったことで、LockServiceによる
  相互排他が効かなくなる点を認識し、「既知の制約」として文書化した上で、Calendarを
  実際に変更する直前にもう一度statusを再確認する緩和策（`CONFLICTING_STATUS_CHANGE`）を
  `confirmBooking`に追加した（`test/booking-confirm-expire.test.js`で検証）。

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
  統合テスト（状態遷移・TTL・二重実行・部分失敗補償/recovery記録・障害分離・Calendar変更
  直前の再確認によるCONFLICTING_STATUS_CHANGE検出・container-boundスクリプトの
  onOpen単純トリガーによる管理メニューの配線）

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
- [ ] Booking Adminプロジェクト（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）を
      セットアップ後、そのSpreadsheetを開くと追加設定なしで実際に「予約管理」メニューが
      表示されること（container-bound scriptのonOpen単純トリガーの実地確認）
- [ ] Spreadsheetのカスタムメニューから`confirmBooking`が実行できること
- [ ] `expirePendingBookings`のトリガーが実際に15分おきに動作すること
- [ ] 既存の`_includes/calendar_embed.html`および`studio-x/reservation/`の予約フォームが
      これまで通り動作すること（本Issueでは一切変更していない）

Phase 0のゲート確認（スペースマーケットとの同一Calendar共存の実環境確認）は
Issue #267で完了（PASS, 2026-09-19）。確認手順・記録は
[`docs/phase0-issue267-spacemarket-coexistence.md`](../../docs/phase0-issue267-spacemarket-coexistence.md)
を参照。
