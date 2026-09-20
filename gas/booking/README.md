# gas/booking（自社予約システム）

Epic #265の一部として以下を実装済み。

- **Issue #266**: `getAvailability`（読み取り専用の空き判定）
- **Issue #268**: `createBooking`（Studio X限定の仮予約作成）・予約台帳（Spreadsheet）・
  PENDING/CONFIRMED/CANCELLED/EXPIRED状態管理・部分失敗補償・TTL失効・レート制限・
  Spreadsheetカスタムメニューからの予約確定
- **Issue #269**: `createBooking`をSNB / SNB mens / Studio Xの3ブランドへ正式拡張し、
  3ブランド共通の予約UI（`booking/` / `mens/booking/` / `studio-x/booking/`）から
  実際にPENDING予約を作成できるようにした（詳細は「Issue #269: 3ブランド対応と
  共通予約UI」参照）
- **Issue #270**: 当日予約の可否を「会員かどうか」ではなく「この施設（SNB / SNB mens /
  Studio Xは同一施設）の利用経験があるか」で判定するようにした。利用区分
  （`first_time`/`returning`）を共通予約UI・createBooking・Sheets台帳に追加し、
  GAS側でも「当日＋初回利用」を`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`で拒否する。
  さらにレビュー対応として、`getAvailability`/`createBooking`の両方で「当日の
  過去開始時刻」を拒否し（`SAME_DAY_START_TIME_PASSED`）、PENDING TTLも
  「当日受付・開始2時間未満」の予約が作成直後に即EXPIREDにならず、かつ利用開始後まで
  PENDINGが残らないよう調整した（詳細は「Issue #270: 当日利用ルールと利用経験判定」参照）
- **Issue #271**: 予約通知メール（仮予約受付・確定・前日リマインド+来場案内）の自動送信、
  キャンセルメールの送信ロジック（呼び出し配線自体は#272）、送信履歴・エラーの
  Spreadsheet記録、SentAtによる二重送信防止、管理者による個別再送、前日リマインド用
  時間主導トリガー作成関数を実装した。実メール送信・本番Script Properties設定・
  本番トリガー作成はこのPRでは行わない（詳細は「Issue #271: 予約通知メール自動送信」参照）
- **Issue #272**: 管理者キャンセル（`cancelBookingAdmin(bookingId)`）を実装し、
  PENDING/CONFIRMED→CANCELLEDの状態遷移・Calendarイベント削除による枠の再開放・
  Sheets台帳の`cancelledAt`/`updatedAt`更新・#271の`sendCancelledMailForBooking`への
  接続・Spreadsheetカスタムメニューからのキャンセル操作（YES/NO確認付き）・
  Calendar/Sheetsの部分失敗のRecovery記録・Sheets行が無い場合のCalendar診断を
  実装した。Booking Admin側のみに追加し、公開Web Appにはキャンセルエンドポイントを
  一切公開しない（詳細は「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」参照）

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
| **Booking Web App** | スタンドアロン | `getAvailability`（`doGet`）・`createBooking`（`doPost`）・管理者通知 |
| **Booking Admin** | `SPREADSHEET_ID`のSpreadsheetへコンテナバインド | カスタムメニュー（`onOpen`）・`confirmBooking(bookingId)`・`cancelBookingAdmin(bookingId)`（Issue #272）・PENDING TTL失効（`expirePendingBookings`の時間主導トリガー） |

`confirmBooking`と`expirePendingBookings`は、いずれもBooking Adminプロジェクトに
配置し、同じ`LockService.getScriptLock()`を共有させることで、PENDING→CONFIRMEDと
PENDING→EXPIREDが同時に進んでCalendar/Sheetsが不整合になる競合を構造的に排除している
（3回目レビュー指摘対応。詳細は「PRレビュー（3回目）指摘への追加対応」参照）。
`cancelBookingAdmin`（Issue #272）も同じBooking Adminプロジェクト・同じLockServiceに
加えたため、この3関数の間では常に1つの状態遷移だけが成立する（詳細は
「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」参照）。

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
- PENDING TTL失効（`expirePendingBookings()`。時間主導トリガー用）。
  Spreadsheetカスタムメニューからの予約確定（`confirmBooking(bookingId)`）と同じ
  コンテナバインドの別GASプロジェクト（Booking Admin）から実行し、同じLockServiceを共有する
- レート制限（同一メール・全体・同一内容連投）

## このIssueで実装していないもの（非対象。#268時点）

- Studio Nagoya Base / SNB mensでの予約作成（Phase 1はStudio Xのみ。**#269で解消。
  下記「Issue #269: 3ブランド対応と共通予約UI」を参照**）
- `#269` 以降の共通予約UI実装（フロントエンドからcreateBookingを呼ぶ画面。**#269で実装**）
- `#271` 利用者向けメール通知（仮予約受付・確定・キャンセル・前日リマインド・来場案内）。
  本Issueで送るのは管理者向けの最低限の内部通知のみ
- `#272` 管理者キャンセル機能（**#272で実装済み**。詳細は
  「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」参照）
- `#273` 本番切替（既存予約フォーム・`_includes/calendar_embed.html`の撤去、
  Studio Nagoya Base / SNB mens側の予約導線切替を含む）
- 料金自動計算・決済・会員DB照合
- 既存予約フォーム（`studio-x/reservation/`）・`_includes/calendar_embed.html`の変更/撤去

## Issue #269: 3ブランド対応と共通予約UI

Issue #268で `studio_x` 限定だった`createBooking`を、SNB（緊縛スタジオ本体） / SNB mens /
Studio Xの3ブランドへ正式に拡張し、3ブランド共通の予約UIから実際にPENDING予約を
作成できるようにした。

### 採用したbrand識別子・bookingId prefix・表示名

既存コードに正式なbrand識別子が無かったため、Issue #269本文の指定どおり
`snb` / `mens` / `studio_x` を採用した（`gas/booking/Availability.gs`のコメントで
Issue #265/#266時点から既にこの3値が前提として書かれていたことも確認済み）。
brand文字列・prefix・表示名は`Booking.gs`の`ALLOWED_BOOKING_BRANDS` /
`BRAND_ID_PREFIX_` / `BRAND_LABELS_`（`Booking.getBrandLabel`）に一元管理し、
他ファイル（`CalendarRepository.gs` / `AdminNotifier.gs`等）はbrand文字列や
表示名を直接持たない。

| brand識別子 | 表示名（Calendar/管理者通知） | bookingId prefix | 例 |
| --- | --- | --- | --- |
| `snb` | SNB | `SNB` | `SNB-20261001-3F2A9B1C` |
| `mens` | SNB mens | `MENS` | `MENS-20261001-3F2A9B1C` |
| `studio_x` | Studio X | `SX`（**Issue #268から変更なし**） | `SX-20261001-3F2A9B1C` |

未知のbrandは従来どおり`INVALID_BRAND`で拒否する（`ALLOWED_BOOKING_BRANDS`にない
文字列は一切許可しない。brand偽装対策）。

### サーバー側（GAS）の変更点

- `Booking.gs`: `ALLOWED_BOOKING_BRANDS`を3ブランドへ拡張。`BRAND_ID_PREFIX_`に
  `snb`/`mens`のprefixを追加（`studio_x`の`SX`は変更しない）。ブランド表示名を返す
  `Booking.getBrandLabel(brand)`を追加。
- `CalendarRepository.gs`: Calendarイベントのタイトルを`[ブランド表示名 状態] bookingId`
  の形式に一般化し、`Booking.getBrandLabel`経由でブランド名を取得するようにした
  （以前は`[Studio X ...]`にハードコードしていた）。`setEventStatus`はイベント作成時に
  `setTag('brand', ...)`済みのタグから表示名を再取得するため、呼び出し側の
  シグネチャは変更していない。**空き判定・状態判定のロジック自体はタイトル文字列にも
  brandにも一切依存しない**（3ブランドとも同一Calendar・同一室のため、Availability.gsは
  Issue #265/#266時点から変更していない）。
- `AdminNotifier.gs`: 管理者通知メールの件名を`[ブランド表示名] 仮予約を受け付けました: ...`
  に一般化した（以前は`[Studio X] ...`固定）。
- `BookingRepository.gs` / `SpreadsheetRepository.gs` / `Availability.gs` / `Config.gs` /
  `RateLimiter.gs`は**変更なし**（brandはすでに`input.brand`としてパイプライン全体を
  透過しており、Sheetsの`brand`列・CalendarEventの`brand`タグへも元から正しいbrandが
  保存されていた。Issue #268時点の制約は`ALLOWED_BOOKING_BRANDS`の一覧のみだったため）。

### 変更していないこと（#269の意図的なスコープ外）

- **Calendarはbrandごとに分けない。** 3ブランドとも同一室のため、引き続き
  `CALENDAR_ID`ひとつだけを共有する（Web App・Calendar・Spreadsheetともに1つのまま。
  ブランド別API・別Web Appも作らない）。
- **空き判定ロジックをbrandで分岐させない。** `Availability.gs`は無変更。SNBで作られた
  予約はmens/Studio Xの`getAvailability`でも塞がり、mens/Studio Xの予約もSNBから見て
  塞がる（相互に競合する。テストは「テストの実行」節参照）。
- `#271`（利用者向けメール）・`#272`（管理者キャンセル）・`#273`（本番切替・
  旧導線撤去）はこのIssue（#269）時点ではいずれも実装していない（`#270`は
  「Issue #270: 当日利用ルールと利用経験判定」、`#271`は「Issue #271: 予約通知メール
  自動送信」、`#272`は「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」
  でそれぞれ実装済み）。

### 共通予約UI（フロントエンド）

3ブランドともHTML/JSをコピーせず、以下を共通で使う。

| ファイル | 役割 |
| --- | --- |
| `_includes/booking_app_ja.html` | 予約ウィザードの共通マークアップ（日時→空き時間→利用者情報→確認→完了の5ステップ） |
| `scripts/booking-logic.js` | DOM非依存の共通ロジック（エラーメッセージ変換・入力検証・ペイロード組み立て等。`test/booking-logic.test.js`でテスト） |
| `scripts/booking-app.js` | DOM配線・`getAvailability`/`createBooking`の呼び出し |
| `styles/booking.css` | 共通スタイル（SNB/mensの`styles/common.css`とStudio Xの`studio-x/style.css`、テーマ変数名が異なる両方をCSS変数のフォールバック連鎖で吸収し、ブランドごとにCSSを複製しない） |
| `scripts/booking-config.js` | **Booking Web AppのURLを設定する唯一の場所**（3ブランド共通。`BASE_URL`が空の間はAPIを呼ばず「準備中」の案内を表示する） |

ブランドごとに変わるのは、ページ側（`booking/index.html` / `mens/booking/index.html` /
`studio-x/booking/index.html`）が`_includes/booking_app_ja.html`へ渡す
`brand` / `back_url` / `back_label` / `intro_note`のみ。空き判定・最低利用時間・
15分刻み・競合判定のような業務ルールはフロント側に複製せず、`getAvailability`/
`createBooking`の応答をそのまま表示する（GASを正とする）。

`createBooking`へのPOSTは`Content-Type: text/plain;charset=utf-8`で送る
（本文は引き続きJSON文字列）。Apps ScriptのWeb Appは`doOptions`を実装していないため、
`application/json`を指定するとブラウザのCORSプリフライト(OPTIONS)が失敗する。
`text/plain`はCORSセーフリストに含まれるためプリフライトが発生せず、
`Code.gs`の`handleCreateBooking_`はContent-Typeの値に関わらず`e.postData.contents`を
常に`JSON.parse`するため、この送り方でサーバー側の処理は変わらない。

**本番デプロイ・本番URLへの接続はこのPR（#269）では行っていない。**
`scripts/booking-config.js`の`BASE_URL`は空文字のままで、共通予約UIは
「オンライン予約準備中」の案内を表示するのみ（実際のCalendar/Spreadsheetへは
一切書き込まない）。本番デプロイ後にこの1ファイルのURLを差し替えることで
3ブランドとも接続される（本番デプロイ自体は`#273`の責務）。

### 既存導線との関係

`studio-x/reservation/`（Formspreeの予約・撮影相談フォーム）・
`_includes/calendar_embed.html`・トップページ/mensページの既存予約カレンダー導線は
**このPRでは一切変更・撤去していない**。共通予約UIは新しいURL
（`/booking/` `/mens/booking/` `/studio-x/booking/`）を追加しただけで、既存ページから
このURLへリンクする変更もこのPRには含めていない（本番切替・旧導線撤去は`#273`）。

## Issue #270: 当日利用ルールと利用経験判定

当日予約の可否を、**「会員かどうか」ではなく「SNB / SNB mens / Studio Xという同一施設を
過去に利用した経験があるか」**で判定するようにした。3ブランドとも同一施設のため、
どのブランドで利用した経験でも「利用経験あり」として扱う（自己申告。DB照合はしない）。

### 最終仕様

| 利用区分 | 当日予約 | 翌日以降の予約 |
| --- | --- | --- |
| 初回利用 | 不可 | 可（通常フロー） |
| 利用経験あり | 可（通常フロー。PENDINGのまま） | 可（通常フロー） |

- 当日予約も送信時点では従来どおりPENDINGであり、送信即CONFIRMEDにはしない
  （管理者確認後に`confirmBooking`でCONFIRMEDへ遷移させる、という#268からの仕組みは
  一切変更していない）。
- 当日判定は必ず`availabilityConfig.timezone`（既定`Asia/Tokyo`）基準で行う。
  ブラウザのローカルtimezoneには依存しない（`BookingAvailability.formatDateInTimezone`参照）。
- **利用経験あり＋当日でも、開始時刻が現在時刻より後であることを必須とする**
  （現在時刻ちょうども不可。レビュー対応で追加）。今日の空き候補（`getAvailability`）は
  現在時刻より後だけを返し、`createBooking`もCalendar書き込み前に同じ判定を
  再検証する（`SAME_DAY_START_TIME_PASSED`。「当日の過去開始時刻を防ぐ」参照）。
- brandでこのルールを分岐させない。snb/mens/studio_xのいずれでも同じ判定になる。

### 採用した利用区分の内部値

既存コードにこの区分の正式名称が無かったため、Issue #270本文の例示どおり
`first_time`（初回利用） / `returning`（利用経験あり）を採用した。表示文言と
内部値は常に区別し、`gas/booking/Booking.gs`の`CUSTOMER_TYPES`
（`getCustomerTypeLabel`）と`scripts/booking-logic.js`の`CUSTOMER_TYPES`
（`customerTypeLabel`）にのみラベル変換ロジックを持たせている
（フロントstate・createBooking payload・サーバー側validation・Sheets台帳のすべてで
この2値のみを共通利用する）。

### GAS側の変更点

- **`Availability.gs`**: `formatDateInTimezone`（Dateを指定timezone基準の
  `'YYYY-MM-DD'`へ変換）と`getCurrentMinutesInTimezone`（Dateを指定timezone基準の
  「00:00からの経過分」0〜1439へ変換）を追加。どちらもGAS組み込みサービスに
  依存しない純粋関数で、timezoneが不正な場合はnullを返しfail-closedに扱う
  （`Booking.gs`は`BookingAvailability.formatDateInTimezone`を再利用し、
  `Booking.formatDateInTimezone`として薄いエイリアスを公開する）。
  `computeBookableStartTimes`に第4引数`minimumStartMinutes`（省略可）を追加し、
  指定した場合はそれ以前（ちょうど含む）の候補を除外する。`getAvailability`自体も
  第4引数`now`（省略時は現在時刻）を受け取り、`todayString`算出直後に
  **過去日（`date < todayString`）を`INVALID_DATE`で拒否**するようにした
  （2回目レビュー指摘対応。それまでは当日の現在時刻フィルタのみで、過去日自体は
  拒否していなかった）。利用日が当日の場合だけ`getCurrentMinutesInTimezone`で
  現在時刻を求めて`minimumStartMinutes`として渡す（**customerTypeルールは
  getAvailabilityに一切持ち込まない**。当日+初回利用の可否判定は引き続き
  `createBooking`のみの責務）。
- **`Code.gs`**: `handleGetAvailability_`に、Calendarへ問い合わせる前の過去日拒否を
  追加した（`BookingAvailability.formatDateInTimezone`を再利用し、判定ロジックを
  重複実装しない）。`BookingAvailability.getAvailability`内でも同じ判定を行うため
  二重の安全網になるが、過去日リクエストで不要なCalendar API呼び出しを避けるための
  追加（2回目レビュー指摘対応）。
- **`Booking.gs`**: `CUSTOMER_TYPES` / `ALLOWED_CUSTOMER_TYPES` /
  `isAllowedCustomerType` / `getCustomerTypeLabel`を追加。
  `validateCreateBookingInput`に`customerType`の必須検証（未指定・未知の値は
  `INVALID_CUSTOMER_TYPE`でfail-closedに拒否）と、当日判定・同日+初回利用の拒否
  （`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`）、**当日の過去開始時刻の拒否**
  （`SAME_DAY_START_TIME_PASSED`。開始時刻が現在時刻より後であることを必須とする。
  Calendar書き込み前の`validateCreateBookingInput`内で検証するため、フロントや
  `getAvailability`だけに依存しない）を追加した。`validateCreateBookingInput`は
  新たに第3引数`now`（受付時刻）を受け取る（省略時は現在時刻）。
- **`BookingRepository.gs`**: `createBooking`が`validateCreateBookingInput`へ
  `now`を渡すよう変更。Sheets保存用の`record`へ`customerType`を追加。
  `expirePendingBookings`にTTL調整（後述）を追加。
- **`Config.gs`**: `getTtlConfig()`へ`minHoldHours`（`PENDING_TTL_MIN_HOLD_HOURS`。
  既定2。意味は「TTLの変更内容と理由」参照）と`timezone`（`TIMEZONE`と共有）を追加。
- **`SpreadsheetRepository.gs`**: `Bookings`シートのヘッダーへ`customerType`を
  **末尾に追記**（既存行の列を一切ずらさない。詳細は「Sheets変更」参照）。
- **`BookingTriggers.gs`**: グローバル関数`expirePendingBookings()`が`now`引数を
  受け取れるようにした（時間主導トリガーからは引数なしで呼ばれるため本番動作に
  影響しない。テストから受付時刻を固定してTTLを検証できるようにするための変更）。

### createBooking payloadへの追加項目

```json
{
  "brand": "studio_x",
  "customerType": "returning",
  "date": "2026-10-01",
  "startTime": "10:00",
  ...
}
```

`customerType`は`"first_time"`または`"returning"`のいずれか必須。省略・未知の値は
`INVALID_CUSTOMER_TYPE`で拒否する（「API仕様」節参照）。

### 当日の過去開始時刻を防ぐ

当日は「利用経験あり」であっても、開始時刻が現在時刻より後であることを必須とする
（現在時刻ちょうども不可）。判定は`availabilityConfig.timezone`（既定`Asia/Tokyo`）
基準で行い、ブラウザのtimezone・GAS実行環境timezoneのいずれにも依存しない。
過去日（`date < today`）はgetAvailability・createBookingの両方で`INVALID_DATE`
として拒否する（2回目レビュー指摘対応。判定ルールのまとめ:
`date < today` → `INVALID_DATE` / `date === today` → 現在時刻より後の候補・開始時刻のみ許可
/ `date > today` → 従来どおり）。

- `getAvailability`: 過去日は`INVALID_DATE`で拒否する（`handleGetAvailability_`
  （`Code.gs`）でも同じ判定を行い、過去日はCalendarへ問い合わせる前に拒否する）。
  利用日が当日の場合だけ、`getCurrentMinutesInTimezone`で求めた現在時刻（分）より
  後の候補開始時刻のみを返す（`computeBookableStartTimes`の`minimumStartMinutes`）。
  例: JST 10:07に問い合わせた場合、09:00・10:00は候補に出ず、10:15・10:30は
  Calendar競合がなければ候補に出る。
- `createBooking`: Calendar書き込み前の`validateCreateBookingInput`で同じ判定を
  必ず再検証する。フロントの`getAvailability`が過去時刻を除外していても、
  フロント改変や、空き取得から送信までの間に時刻が経過したケースに備え、
  サーバー側で独立して検証する（`SAME_DAY_START_TIME_PASSED`）。
- 当日＋初回利用は、開始時刻が現在時刻より後であっても
  `SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`が先に返る（`SAME_DAY_START_TIME_PASSED`の
  判定に到達するのは実質的に当日＋利用経験ありのみ）。
- 翌日以降はこの判定を一切行わない（現在時刻に関わらず、日付が異なれば従来どおり）。

### 新規error.code

| error.code | 意味 |
| --- | --- |
| `INVALID_CUSTOMER_TYPE` | `customerType`が未指定、または`first_time`/`returning`以外の値 |
| `SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME` | 利用日が当日（Asia/Tokyo基準）かつ`customerType`が`first_time` |
| `SAME_DAY_START_TIME_PASSED` | 利用日が当日かつ開始時刻が現在時刻以前（ちょうど含む） |

いずれも`scripts/booking-logic.js`の`messageForErrorCode`/`recoveryActionForErrorCode`へ
対応する日本語メッセージと回復導線を追加済み。`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`/
`INVALID_CUSTOMER_TYPE`は`reselect-date`（日付・利用区分の選び直しへ誘導）、
`SAME_DAY_START_TIME_PASSED`は`reselect-time`（Step2へ戻り`getAvailability`を
再取得。当日の過去時刻は`getAvailability`側で既に除外されるため、再取得すれば
現在時刻より後の候補のみが表示される）。API直叩きでこれらのエラーが返っても、
フロントは意味不明な`INTERNAL_ERROR`表示にはしない。

### UI側の変更点（共通予約UI）

- Step1（利用日・利用時間）に利用区分の選択（ラジオボタン。「初回利用」/
  「利用経験あり（SNB／SNB mens／Studio Xのいずれかで利用したことがある）」）を追加した。
- 「初回利用」＋当日の組み合わせで「空き時間を確認する」を押すと、`getAvailability`を
  呼ばずにStep1へ留まり、日付欄に理由（「初回利用の方は当日のご予約を受け付けていません。
  翌日以降の日付を選択してください。」）を表示する。翌日以降の日付を選び直せば
  通常どおり進める。
- 「利用経験あり」＋当日は通常どおりStep2（空き開始時刻）へ進み、`getAvailability`を
  呼んで空き時間を表示し、`createBooking`まで進められる。
- Step4（内容確認）に「利用区分」の行を追加し、送信前に選択内容を確認できるようにした。
- 完了画面の「まだ予約は確定していない」「管理者確認後に確定」の文言は変更していない
  （当日予約でも自動確定しない）。
- **これらはすべてUX目的の一次チェックであり、セキュリティ・業務ルールの正はGAS側。**
  フロントを改変してcustomerTypeを省略・改ざんしても、`createBooking`のサーバー側
  検証（`INVALID_CUSTOMER_TYPE`/`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`）で当日制限を
  突破できない。

### Sheets変更

`Bookings`シートのヘッダーへ`customerType`列を**末尾に追記**した（既存の
`bookingId`〜`updatedAt`の19列はそのまま、20列目として追加）。列を追加する際は
必ず末尾へ追記すること。`rowToRecord_`は行の配列インデックスをヘッダーの並び順で
読むため、途中へ挿入すると既存行（過去に`appendBooking`した実際のセルの並び）が
ずれて誤読される。末尾追記であれば、既存行は`customerType`が空（未入力扱い）に
なるだけで、他の列はこれまでどおり正しく読める。`appendBooking` /
`findRowByBookingId` / `updateBookingFields` / `getAllPendingBookings`は
`HEADERS_`定義を経由するため、この追記のみで自動的に整合する
（`SpreadsheetRepository.gs`本体・テストとも追加のロジック変更は不要だった）。

管理者は`Bookings`シートの`customerType`列で「初回利用」/「利用経験あり」
（内部値`first_time`/`returning`。表示ラベル自体は列に保存しない。将来的に
シート側で見やすくしたい場合は`Booking.getCustomerTypeLabel`を使う運用を検討）を
確認できる。

### PENDING TTLの変更内容と理由

**背景（#268時点の課題）**: PENDING TTLは「受付から`PENDING_TTL_HOURS`時間後」と
「利用開始時刻の`PENDING_TTL_MIN_HOURS_BEFORE_START`時間前」の早い方
（`normalExpiry = min(受付+ttlHours, 開始-minHoursBeforeStart)`）。利用経験ありの
当日予約で利用開始まで`PENDING_TTL_MIN_HOURS_BEFORE_START`（既定2時間）未満しか
ない場合、`normalExpiry`が受付時刻以前になり、**失効時刻が受付時刻より前になる＝
作成直後に即EXPIREDになる**可能性があった。

**最初の実装（1回目レビューで指摘・修正）**: 「受付から少なくともminHoldHours時間は
保持する」下限を単純に足す設計にしたところ、例えば09:00受付・09:30開始の予約が
11:00までPENDINGとして残り得る（**利用開始後もPENDINGが残ってしまう**）という
指摘を受けた。

**採用した設計（レビュー対応後）**: `minHoldHours`は「受付から少なくともこの時間は
保持する」という単純な下限ではなく、**「通常TTL計算式（`normalExpiry`）が受付時刻
以前になってしまう直前当日予約にだけ使う最大猶予（grace）」**として再定義し、
**利用開始時刻（`startAt`）を必ず上限とする**（`expiry <= startAt`を保証する）。

```js
var ttlExpiry = createdAtMillis + ttlHours * 3600000;
var normalStartLimit = startAtMillis - minHoursBeforeStart * 3600000;
var normalExpiry = Math.min(ttlExpiry, normalStartLimit);

if (!minHoldHours || minHoldHours <= 0 || normalExpiry > createdAtMillis) {
  return normalExpiry;
}

var graceExpiry = createdAtMillis + minHoldHours * 3600000;
return Math.min(ttlExpiry, graceExpiry, startAtMillis);
```

`normalExpiry`が受付時刻より後（＝開始まで十分な余裕がある）であればgraceを使わず
`normalExpiry`をそのまま返す＝#268時点の計算式とビット単位で完全に同じ値になる。
`minHoldHours`を渡さない場合も同様（`normalExpiry`をそのまま返す）。

`BookingRepository.expirePendingBookings`は、候補行ごとに**受付時刻（`createdAt`）の
暦日（Asia/Tokyo基準）と、その予約の利用日（`date`列）が一致する場合のみ**
（＝当日受付の予約のときだけ）`minHoldHours`（`BookingConfig.getTtlConfig().minHoldHours`。
新規Script Property `PENDING_TTL_MIN_HOLD_HOURS`。既定2時間）を渡す。一致しない
（翌日以降に通常の余裕を持って受け付けた）予約は`minHoldHours=0`のまま、#268時点と
完全に同じTTL計算になる。

**なぜこの設計にしたか**:

- 営業時間（08:00〜23:00）の制約上、「利用日が受付日の翌日以降」の予約は、
  実際には受付から開始まで少なくとも数時間以上の余裕が生じる（日をまたいで
  すぐに開始する翌日予約は構造的に存在し得ない）。そのため「受付日と利用日が
  一致する予約だけ」に対象を絞っても、当日予約の救済という目的を過不足なく
  達成でき、かつ既存の翌日以降予約のTTL計算には数学的に一切影響しない
  （`record.date !== 受付日`の予約は常に`minHoldHours=0`で呼ばれるため）。
- 利用開始時刻を必ず上限とすることで、**当日PENDINGが利用開始後までCalendar/
  Sheets上に残ってしまう事故を防ぐ**（1回目レビュー指摘への対応）。
- `minHoldHours`・brand・customerTypeのいずれもTTL計算式を分岐させない
  （GAS側のみで完結し、フロントの当日判定`isSameDayFirstTimeBlocked`とは独立）。

**当日直前予約のTTLの扱い（09:00受付を例に）**:

| 開始時刻 | 通常式（開始-2h） | 実際のexpiry | 備考 |
| --- | --- | --- | --- |
| 09:30 | 07:30（受付前） | **09:30**（開始時刻） | graceを使うが開始時刻が上限 |
| 10:30 | 08:30（受付前） | **10:30**（開始時刻） | 同上 |
| 11:30 | 09:30（受付後） | **09:30**（通常式のまま） | graceは使わない |
| 12:00 | 10:00（受付後） | **10:00**（通常式のまま） | graceは使わない |

いずれのケースも`expiry <= startAt`（利用開始後までPENDINGが残らない）かつ
`expiry > createdAt`（正常に作成できた予約が作成直後に即EXPIREDにはならない）を
満たす。それでも`PENDING_TTL_HOURS`（既定24時間）による上限（`Math.min`）は
維持されるため、**PENDINGを無期限にはしない**。管理者が利用開始前に確認・
`confirmBooking`すれば、当日予約も通常の予約と同じ手順で確定できる。

**要件との対応**:

- 当日予約が作成直後に即EXPIREDにならない → graceにより`expiry > createdAt`を満たす
- 当日PENDINGが利用開始後まで残らない → graceは`startAtMillis`を必ず上限とする
  ため`expiry <= startAt`を満たす
- 翌日以降の既存TTLを壊さない → 「受付日と利用日が一致する場合のみ」という
  ガードにより、既存のTTL計算式をビット単位で保つ
- PENDINGを無期限にしない → `PENDING_TTL_HOURS`による上限（`Math.min`）は
  従来どおり維持される
- expiry判定をフロントに持たせない → `computeTtlExpiryMillis`/`isExpired`は
  引き続き`gas/booking/Booking.gs`のみに存在し、フロントは一切この判定を行わない
- `expirePendingBookings`のCalendar削除・Sheets EXPIRED更新・recovery記録・
  LockService・`confirmBooking`との排他はいずれも変更していない

### 3ブランド共通であることの確認

当日利用ルール・TTL調整のいずれも、`brand`や`Booking.getBrandLabel`を一切参照しない
（`Availability.gs`と同じ「brandで分岐させない」方針を踏襲）。
`test/booking-model.test.js`・`test/booking-create-booking.test.js`で
snb/mens/studio_xの3ブランドすべてが同じ挙動になることを検証している。

### #271/#272/#273との境界

- `#271`（利用者向けメール通知: 仮予約受付・確定・キャンセル・前日リマインド・
  来場案内）は**実装済み**（詳細は「Issue #271: 予約通知メール自動送信」参照）。
  #268からの管理者向け内部通知（`AdminNotifier.gs`）はこのIssueで変更していない
  （利用者向けメールとは別ファイル・別責務のまま維持）。
- `#272`（管理者キャンセル機能。PENDING/CONFIRMED→CANCELLEDの状態遷移・Calendar削除・
  キャンセルメール呼び出し配線）は**実装済み**（詳細は「Issue #272: 管理者キャンセルで
  Calendar / Sheetsを一貫更新する」参照）。
- `#273`（本番GASデプロイ・本番Web App URL差替・旧フォーム撤去・Calendar embed撤去・
  本番切替・ロールバック実施）は実装していない。`scripts/booking-config.js`の
  `BASE_URL`は引き続き空文字のまま。

### 料金・会員料金との切り分け

「利用経験あり」は当日予約可否の判定にのみ使う。会員料金・割引判定を自動化する
ものではない（Issue #270の非対象）。特にmensページの会員料金表示・「メンズページを
見た」申告等の既存運用は、このIssueでは一切変更していない。

## Issue #271: 予約通知メール自動送信

予約に関する利用者向けメール（仮予約受付・確定・前日リマインド+来場案内）をGASから
自動送信するようにした。キャンセルメールは**送信ロジックのみ**を実装し、実際に
`CANCELLED`成功後に呼ぶ配線は`#272`（管理者キャンセル機能）の責務とした
（**#272で実装済み**。詳細は「Issue #272: 管理者キャンセルでCalendar / Sheetsを
一貫更新する」参照）。

### このIssueで実装した範囲

1. `createBooking`成功後（Calendar/Sheets保存・booking Lock解除後）の、利用者向け
   PENDINGメール（best effort。失敗しても`createBooking`は成功のまま）
2. `confirmBooking`成功後（Calendar/Sheets確定・Lock解除後）の、利用者向けCONFIRMED
   メール（best effort。既にCONFIRMED済みで`confirmedMailSentAt`が空の場合は
   メールだけ再試行する）
3. `CANCELLED`状態の予約に送れるキャンセルメール送信関数（`BookingMailer.sendCancelledMailForBooking`）。
   **呼び出し配線は#272**（このIssueでは状態遷移自体もCalendar削除も実装しない。#272で実装済み）
4. 翌日の`CONFIRMED`予約への前日リマインド（`sendNextDayReminders(now)`）
5. 前日リマインドへ同梱する来場案内（住所・建物・部屋・入口案内・キーボックス位置・
   キーボックス番号・解錠コード・利用案内URL・案内PDF URL）
6. `Bookings`シートへの送信履歴・エラー記録（8列追加。「Sheets変更（Issue #271）」参照）
7. SentAtによる二重送信防止（`LockService`での直列化を含む）
8. 管理者による明示的な個別再送（`{ force: true }`。SentAtを先に消す運用はしない）
9. 前日リマインド用の時間主導トリガー作成関数（`createNextDayReminderTrigger()`。
   本番トリガー作成自体はこのPRでは行わない）
10. ブランド共通のメールテンプレート（`BookingMailTemplates.gs`。SNB/mens/Studio X
    で本文生成ロジックを複製しない）

### このIssueで実装していないもの（非対象）

- `PENDING`/`CONFIRMED` → `CANCELLED`の状態遷移そのもの、Calendar予約削除を伴う
  キャンセル処理、`#272`の管理者キャンセルUI（このIssueでは`sendCancelledMailForBooking`
  という送信関数とテストまでを用意する。いずれも**#272で実装済み**）
- 本番GASデプロイ・本番Script Properties設定・本番トリガー作成・実メール送信
- LINE/SMS通知・Stripe決済メール・PayPay API・外部媒体（スペースマーケット）予約者への
  自社メール送信・会員DB自動照合・動的なスマートロックAPI連携・解錠コードの自動生成/変更

### メール種別とSentAtの対応

| mail type | 送信条件（status） | 対応するSentAt | 二重送信防止 |
| --- | --- | --- | --- |
| `PENDING` | `PENDING` | `pendingMailSentAt` | SentAtが空の場合のみ送信 |
| `CONFIRMED` | `CONFIRMED` | `confirmedMailSentAt` | 同上（既にCONFIRMEDでもSentAt空なら再試行可） |
| `CANCELLED` | `CANCELLED` | `cancelMailSentAt` | 同上（#271では送信関数のみ。呼び出しは#272の`cancelBookingAdmin`で実装済み） |
| `REMINDER` | `CONFIRMED`かつ利用日が翌日（`SpreadsheetRepository.getConfirmedBookingsForDate`で抽出） | `reminderSentAt`と`accessGuideSentAt`（同時記録） | 上記2列のいずれかが空の場合のみ送信 |

`BookingMailer.gs`の`withBookingLock_`が全メール種別共通で以下の順序を守る
（`LockService.getScriptLock()`で直列化）:

```text
Lock取得 → bookingIdで最新レコード再読込 → status確認 → 対応SentAt確認 →
テンプレート生成（設定不足はここでfail-closedに失敗させる） → MailApp送信 →
送信成功 → SentAt更新・lastMailError*クリア → Lock解除
```

`MailApp`と`Spreadsheet`は1つの原子的トランザクションにできないため、「メール送信成功
直後にプロセスが異常終了しSentAtだけ書けない」という理論上の完全なexactly-onceは
保証できない。ただし通常の二重クリック・トリガー重複・再実行・`confirmBooking`の
再実行では、SentAt確認とLockにより二重送信を防ぐ。

### エラー処理（メール送信失敗は予約状態を壊さない）

**最重要**: メール送信の失敗（`BOOKING_MAIL_DISPLAY_NAME`等の設定不足・`TIMEZONE`が
不正でIntlが解釈できない場合のfail-closedな拒否を含む）は、`createBooking`/
`confirmBooking`の成否・`Bookings`シートの`status`のいずれにも影響しない。失敗時は:

- `Bookings`シートの該当行へ`lastMailErrorAt`/`lastMailErrorType`/`lastMailErrorMessage`
  をbest effortで記録する
- `RecoveryRepository.recordFailure`へ`failureType: 'MAIL_<TYPE>_FAILED'`
  （`MAIL_PENDING_FAILED`/`MAIL_CONFIRMED_FAILED`/`MAIL_CANCELLED_FAILED`/
  `MAIL_REMINDER_FAILED`）・`recoveryState: 'OPEN'`で記録する（詳細は
  「Recoveryシート（部分失敗・不整合記録）列構成」参照）
- 次回同種メールの送信に成功すると、`lastMailErrorAt`等は自動的に空へ戻す
- Recovery記録自体・`lastMailError*`更新自体が失敗した場合はLoggerへ最小限記録するのみ
  （利用者への応答・予約処理自体を失敗させない）
- エラーメッセージは例外の`message`のみを`RecoveryRepository`/`lastMailErrorMessage`へ
  記録し、メール本文全文は含めない。**PRレビュー対応（2回目）で、`BookingMailer.gs`の
  `sanitizeErrorMessage_`がメールアドレス形式（正規表現）を`[REDACTED_EMAIL]`へ、
  REMINDER送信時は`ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`の実値が
  万一例外メッセージへ混入した場合も`[REDACTED]`へ置換してから記録するようにした**
  （`BookingMailer.sanitizeErrorMessage`として公開し、`BookingRepository.gs`の
  `notifyCustomerPendingBestEffort_`/`notifyCustomerConfirmedBestEffort_`・
  `BookingReminderTriggers.gs`の`sendNextDayReminders`のLogger出力にも同じ関数を
  適用している）。`sendNextDayReminders`のLoggerには送信失敗時に`bookingId`と
  `error.code`のみを記録し、生のエラーオブジェクトを`JSON.stringify`しない

**fail-safe（来場案内の必須項目）**: `ACCESS_GUIDE_ADDRESS`/`ACCESS_GUIDE_BUILDING`/
`ACCESS_GUIDE_ROOM`/`ACCESS_GUIDE_ENTRANCE`/`ACCESS_GUIDE_KEYBOX_LOCATION`/
`ACCESS_GUIDE_ENTRY_METHOD`/`ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`/
`ACCESS_GUIDE_URL`のいずれか1つでも未設定の場合、前日リマインド（`REMINDER`）を
「成功扱い」にせず送信自体を行わない（`reminderSentAt`/`accessGuideSentAt`は更新
しない。PRレビュー対応で、当初は秘密値2項目のみの検証だったものを来場案内の
必須項目全体へ拡張した）。予約の`status`はCONFIRMEDのまま維持し、`lastMailError*`へ
記録する。`ACCESS_GUIDE_PDF_URL`のみ「必要に応じて」のため必須にしない。

### 手動再送

Booking Adminプロジェクトの「予約管理」メニューへ「予約メールを再送
（予約ID指定・強制再送）」を追加した（`BookingAdmin.gs`の
`resendBookingMailByPrompt_`）。bookingId・メール種別（`PENDING`/`CONFIRMED`/
`CANCELLED`/`REMINDER`）をそれぞれ別のダイアログで入力し、
`BookingMailer.send*ForBooking(bookingId, { force: true })`を呼ぶ。

- `force: true`はSentAtが既にあっても送信する明示的な再送であり、SentAtを事前に
  消す運用はしない（誤送信を避けるため）
- ただし**状態条件（status一致）はforceでも無視しない**。例えば`PENDING`のメールを
  `CONFIRMED`の予約へforce送信しようとしても`INVALID_STATUS`で拒否する
- `REMINDER`の手動再送も、来場案内の必須項目（秘密値の`ACCESS_GUIDE_KEYBOX_NUMBER`/
  `ACCESS_GUIDE_UNLOCK_CODE`を含む）が1つでも未設定なら送信しない
  （fail-safe自体はforceでも解除しない）

### 前日リマインド用トリガーの作成

`sendNextDayReminders`・そのトリガーは**Booking Adminプロジェクト**
（`BookingReminderTriggers.gs`）に属する。本PRでは本番の時間主導トリガー作成
そのものは行わない（コードのみ実装）。運用開始時は、Booking Adminプロジェクトの
スクリプトエディタから`createNextDayReminderTrigger`を一度だけ実行する（毎日18時台に
1回、`sendNextDayReminders`を実行するトリガーが作成される。同名トリガーが既にある
場合は重複作成しない）。GASの時間主導トリガーは分単位の完全一致を保証しないため、
「18:00ちょうど」ではなく「18時台に1回」を業務要件とする。

`sendNextDayReminders(now)`の処理:

1. `now`（省略時は現在時刻）を`BookingConfig.getAvailabilityConfig().timezone`
   （既定`Asia/Tokyo`）基準の「今日」に変換し、翌日の`YYYY-MM-DD`を計算する
2. `SpreadsheetRepository.getConfirmedBookingsForDate`で翌日の`CONFIRMED`予約を取得する
3. 1件ずつ`BookingMailer.sendReminderMailForBooking`へ委譲し、内部で最新status/SentAtを
   再確認してから送信する
4. 1件が失敗（MailApp例外・秘密値未設定等）しても、残りの予約の処理を継続する
   （バッチ内の障害分離）
5. `{ processedCount, sentCount, skippedCount, failedCount }`を返す

ブランド（snb/mens/studio_x）で抽出ロジック・送信ロジックを分岐させない。

### PENDING TTL失効の遅延についての注記

「Issue #270: 当日利用ルールと利用経験判定」に記載のとおり、PENDING TTLの失効時刻
（`expiry`）自体は利用開始時刻を超えないよう設計しているが、**実際にCalendarイベントを
削除しSheetsの`status`を`EXPIRED`へ更新する処理は、15分間隔の`expirePendingBookings`
トリガーの次回実行時になる**ため、TTL上の失効期限を迎えてから実際のSheets更新・
Calendar削除までに最大約15分の遅延があり得る（Issue #271でメール送信の設計を
見直す過程で改めて明記する）。前日リマインド（`sendNextDayReminders`）は
`status === 'CONFIRMED'`のみを対象とするため、この遅延はリマインド送信対象の
判定には影響しない。

### セキュリティ・個人情報

- キーボックス番号・解錠コード等の秘密値はScript Propertiesでのみ管理し、GitHubへは
  実値を一切コミットしない（README・PRにもキー名と「何を入れるか」のみを記載する）
- `buildPendingMail`/`buildConfirmedMail`は構造上`accessGuide`を引数に取らないため、
  実装ミスで仮予約・確定直後メールに秘密値が混入することを防いでいる
  （`test/booking-mail-templates.test.js`で検証）
- テストでは実秘密値・実メールアドレスを使わず、`test@example.com`・`TEST-KEYBOX`/
  `TEST-CODE`等のダミー値のみを使う
- エラーメッセージ（`lastMailErrorMessage`・Recoveryの`errorMessage`）にはメール本文
  全文・秘密値・利用者のメールアドレスを含めない
- 公開Web APIレスポンス（`getAvailability`/`createBooking`）へ、メール送信状況・
  来場案内・解錠コードを追加していない

### 共通化（3ブランド）

`BookingMailTemplates.gs`の全関数は`record.brand`から`Booking.getBrandLabel`で
表示名を取得するのみで、SNB/mens/Studio Xごとにテンプレート関数・送信ロジックを
複製していない（`test/booking-mail-templates.test.js`で3ブランド共通であることを検証）。

## Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する

管理者が予約をキャンセルしたとき、Google CalendarとSpreadsheet（`Bookings`シート）の
状態をbookingId単位で一貫して更新する正式関数`cancelBookingAdmin(bookingId)`を実装した。
Calendarだけ削除・Sheetsだけ`CANCELLED`という片落ちを許さず、部分失敗は必ず`Recovery`
シートへ記録する。専用のWeb管理画面は作らず、Phase 1で導入したSpreadsheetの「予約管理」
メニューからbookingId単位でキャンセルを実行できるようにした。`statusセルを直接手編集する
運用は正式手順にしない`（確定と同じ方針）。

### このIssueで実装した範囲

1. 正式関数`cancelBookingAdmin(bookingId)`（`BookingAdmin.gs`の薄いグローバル関数から
   `BookingRepository.cancelBookingAdmin`へ委譲。実ロジックは`BookingRepository.gs`）
2. `PENDING` → `CANCELLED`、`CONFIRMED` → `CANCELLED`の状態遷移
3. Calendarイベントの**削除**による枠の再開放（タイトルを「キャンセル」へ変更して残す
   方式は採用しない。理由は「Calendarイベントの扱い」参照）
4. Sheetsの`status`を`CANCELLED`へ更新し、`cancelledAt`/`updatedAt`を記録
5. #271の`BookingMailer.sendCancelledMailForBooking(bookingId)`への接続（Lock解除後・
   best effort）
6. 二重実行時の冪等性（`alreadyCancelled: true`。Calendar再削除・`cancelledAt`上書きを
   しない）
7. Calendar/Sheetsの部分失敗のRecovery記録（`failureType`一覧は後述）
8. Spreadsheet「予約管理」メニューからのキャンセル操作（confirmと対称の2導線＋
   実行直前のYES/NO確認）
9. Calendarイベントが既に存在しない場合の収束処理（枠は既に空いているとみなし、
   SheetsをCANCELLEDへ進める）
10. Sheets行が存在しない場合のCalendar診断とRecovery記録（Calendarは自動削除しない）

### このIssueで実装していないもの（非対象）

- 利用者自身が押すキャンセルURL・公開Web APIからのキャンセル（`cancelBookingAdmin`は
  **Booking Admin側のみ**に公開し、公開Web App（`Code.gs`）には一切追加しない）
- キャンセル料の自動計算・返金API・決済API
- SpaceMarket側のキャンセル操作
- メールテンプレートの全面変更（#271の`sendCancelledMailForBooking`をそのまま呼ぶだけ）
- `#273`の本番切替（本番GASデプロイ・本番Calendar/Spreadsheet操作・実メール送信は
  このPRでは行わない）
- `status`セル直接編集を正式運用にすること

### 状態遷移の更新

`Booking.gs`の`ALLOWED_TRANSITIONS`を、CONFIRMEDを終端状態から外す形へ変更した。

```js
var ALLOWED_TRANSITIONS = {
  PENDING: [STATUS.CONFIRMED, STATUS.CANCELLED, STATUS.EXPIRED],
  CONFIRMED: [STATUS.CANCELLED]
};
```

| 遷移 | 可否 |
| --- | --- |
| `PENDING` → `CANCELLED` | 可 |
| `CONFIRMED` → `CANCELLED` | 可（**#272で追加**） |
| `CANCELLED` → `CANCELLED` | 冪等扱い（`canTransition`ではなく`cancelBookingAdmin`側で`alreadyCancelled`として処理） |
| `EXPIRED` → `CANCELLED` | 不可（`INVALID_TRANSITION`） |
| `CANCELLED` → `CONFIRMED` / `EXPIRED` → `CONFIRMED` | 不可（従来どおり変更なし） |

`confirmBooking`/`expirePendingBookings`の既存仕様（PENDING→CONFIRMED/EXPIREDの遷移・
TTL計算・二重実行時の冪等性）はいずれも変更していない。

### Lock取得順序（Issue本文より安全側に実装）

Issue本文は「Sheets取得→status確認→Lock取得」の順だが、実装では必ず次の順序にした。

```text
bookingId基本検証
↓
Lock取得
↓
Sheetsをbookingidで最新再読込
↓
最新status確認
↓
Calendar状態確認・削除
↓
Sheets CANCELLED更新
↓
Lock解除
↓
キャンセルメール best effort
```

`confirmBooking`/`expirePendingBookings`/`cancelBookingAdmin`が同時に動いても、Lock取得前に
読んだ古いstatusで処理してしまわないよう、**status判定は必ずLock取得後に最新行を
再読込して行う**（`BookingRepository.cancelBookingAdminLocked_`参照）。

### 正常キャンセルフロー

対象status: `PENDING` / `CONFIRMED`。

```text
Lock取得
↓
最新Sheets行取得（PENDING/CONFIRMEDであることを確認）
↓
calendarEventId取得・Calendarイベント存在確認
↓
Calendarイベント削除
↓
Sheets: status=CANCELLED, cancelledAt=now, updatedAt=now
↓
Lock解除
↓
BookingMailer.sendCancelledMailForBooking(bookingId)
↓
return { success: true, bookingId, status: 'CANCELLED' }
```

**Calendarイベントは削除する。** タイトルを「キャンセル」へ変更して残す方式は採用しない。
理由: 現行`Availability.gs`は「時間指定Calendarイベントはタイトル・statusに関係なく塞ぐ」
実装のため、残すとCANCELLED後も同じ枠が予約不可能なまま残ってしまう。正常キャンセル後は、
同じ時間枠が`getAvailability`で再び候補になり、同時間で新しい`createBooking`も成功する
（`test/booking-cancel.test.js`で検証）。

### cancelledAt / updatedAt

初回キャンセル成功時に同一の`now`を使って`status`/`cancelledAt`/`updatedAt`を保存する。
二重実行時（既に`CANCELLED`）は`cancelledAt`を上書きしない（最初にキャンセルが成立した
日時を保持する）。

### 既にCANCELLEDの場合（冪等性）

最新Sheets statusが`CANCELLED`の場合:

- Calendar削除を再実行しない
- `cancelledAt`を書き換えない
- `success: true, alreadyCancelled: true`を返す
- `cancelMailSentAt`が空ならLock解除後にキャンセルメールだけ再試行する
  （#271の`BookingMailer`のSentAt冪等性をそのまま再利用。既送信なら二重送信しない）

### EXPIRED等の不正な遷移

`EXPIRED`（またはその他`canTransition`が許可しない状態）をキャンセルしようとした場合、
`success: false, error.code: 'INVALID_TRANSITION'`を返し、Calendar/Sheets/メールのいずれも
変更しない。

### Calendarイベントが既に存在しない場合

SheetsはPENDING/CONFIRMEDだが`CalendarRepository.getEventById`が`null`を返す場合、
Calendar側は既に非占有（＝枠は既に空いている）とみなし、**キャンセル処理を収束させる**
方向で扱う。

1. `Recovery`へ`failureType: 'CANCEL_CALENDAR_EVENT_MISSING'`, `recoveryState: 'OPEN'`で記録
2. SheetsをCANCELLEDへ更新（`cancelledAt`/`updatedAt`を記録）
3. Lock解除
4. キャンセルメールをbest effort送信
5. `success: true`だが補助情報`calendarAlreadyMissing: true`を返す

「なぜCalendarだけ先に無かったか」は`Recovery`で人が確認できるよう、自動ではRESOLVEDに
しない（`recoveryState`はOPENのまま）。メールはSheetsがCANCELLEDへ更新できた場合のみ送る。

### Calendar削除自体が失敗した場合

イベントは存在するが`deleteEventById`が例外を投げた場合、Calendarがまだ占有している
可能性があるため、Sheetsは元statusのまま進めず、メールも送らない。

- `Recovery`へ`failureType: 'CANCEL_CALENDAR_DELETE_FAILED'`, `recoveryState: 'OPEN'`で記録
- `success: false, error.code: 'CANCEL_CALENDAR_FAILED'`を返す

### Calendar削除成功 → Sheets更新失敗（最重要の部分失敗）

Calendar側は削除済み（枠は空き）だが、Sheets側がPENDING/CONFIRMEDのまま更新できない
最も重要な部分失敗ケース。**Calendarイベントを無理に再作成して補償しない**
（再作成するとeventIdが変わり、Sheets更新障害中に書き戻せず、二次的不整合を増やすため）。

- `Recovery`へ`failureType: 'CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED'`,
  `recoveryState: 'OPEN'`（`status`はSheetsに残っている現在status）で記録
- キャンセルメールは送らない
- `success: false, error.code: 'CANCEL_SAVE_FAILED'`を返す
- **次回同じbookingIdで`cancelBookingAdmin`を再実行すれば**、Calendarは既に無いため
  「Calendarイベントが既に存在しない場合」の経路からSheetsがCANCELLEDへ収束する
  （`test/booking-cancel.test.js`の障害分離テストで、再実行によりCANCELLEDへ収束すること・
  2回目の実行で`CANCEL_CALENDAR_EVENT_MISSING`が追加記録されることの両方を検証済み）

### Recovery記録自体の失敗

Recovery書き込みもbest effortであり、失敗しても元の例外を上書きしない。Loggerへ
`bookingId`/`failureType`/エラー概要のみを最小限記録する（メールアドレス・秘密値は
Loggerへ出さない。既存の`confirmBooking`/`expirePendingBookings`と同じ方針）。

### Sheets行が存在しない場合のCalendar診断

`bookingId`でSheets行が見つからない場合、単にNOT_FOUNDで終わらせず、bookingId形式
（`SNB-YYYYMMDD-XXXXXXXX` / `MENS-YYYYMMDD-XXXXXXXX` / `SX-YYYYMMDD-XXXXXXXX`）から
利用日を復元し、対象日のCalendarを`bookingId`タグで診断する
（`BookingRepository.parseBookingDateFromId_` / `CalendarRepository.findBookingEventsByBookingId`）。

`findBookingEventsByBookingId(calendarId, bookingId, dateString, timezone)`は対象日の
Calendarイベントのうち`event.getTag('bookingId') === bookingId`で一致するものだけを返す
（タイトル文字列検索には依存しない。PII・brandは検索条件に使わない。SpaceMarket等の
外部イベントはbookingIdタグを持たないため対象外になる）。**この診断は異常時のRecovery
支援のためだけに使う。通常のキャンセル処理では引き続きSheetsの`calendarEventId`を
正として使う。**

| 診断結果 | failureType | 挙動 |
| --- | --- | --- |
| bookingId形式が不正で日付を復元できない | `CANCEL_BOOKING_NOT_FOUND` | Calendar走査自体をスキップして記録 |
| Calendarに1件だけ見つかった | `CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT` | `calendarEventId`を記録。**Calendarは自動削除しない**（正式台帳が無い状態で破壊的変更をするのは危険なため） |
| Calendarに複数件見つかった | `CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND` | 同上。自動削除しない |
| Calendarに0件 | `CANCEL_BOOKING_NOT_FOUND` | `calendarEventId`/`status`は空で記録 |

いずれの診断結果でも、`cancelBookingAdmin`の戻り値は`success: false, error.code: 'NOT_FOUND'`
になる。

### キャンセルメールの接続位置

#271の`BookingMailer.sendCancelledMailForBooking(bookingId)`を、**必ずLock解除後**に
best effortで呼ぶ（`Calendar削除→Sheets CANCELLED→Lock解除→cancel mail best effort`）。
メール失敗時は`cancelBookingAdmin`自体は`success: true`のまま、`CANCELLED`を元へ戻さず
Calendarも復元しない（`BookingMailer`側の`lastMailErrorAt`/`lastMailErrorType`/
`lastMailErrorMessage`・`Recovery`（`MAIL_CANCELLED_FAILED`）へ任せる）。戻り値へ補助情報
`mailSent`/`mailError`を追加した。既にCANCELLED＋メール未送信（`cancelMailSentAt`が空）の
状態で再実行した場合も、状態変更・Calendar操作は行わずメールだけ再試行する
（#271のSentAt冪等性・`{ force: true }`不要の自動再試行）。

### confirm / expireとの競合

`cancelBookingAdmin`は`confirmBooking`/`expirePendingBookings`と同じBooking Adminプロジェクトに
置き、同じ`LockService.getScriptLock()`を使う。Lock取得後に必ず最新statusを読むため、
3関数のうちどれが同時に実行されても1つの状態遷移だけが成立する。

| 先に実行 | 後から実行 | 結果 |
| --- | --- | --- |
| `cancelBookingAdmin`（→CANCELLED） | `confirmBooking` | `INVALID_TRANSITION` |
| `expirePendingBookings`（→EXPIRED） | `cancelBookingAdmin` | `INVALID_TRANSITION` |
| `confirmBooking`（→CONFIRMED） | `cancelBookingAdmin` | 成功（CONFIRMED→CANCELLEDとして続行） |

（`test/booking-cancel.test.js`の競合テストで検証。Lock共有自体のテストも同ファイルに
`test/booking-confirm-expire.test.js`と同じ方式で用意した）

### Spreadsheet管理メニュー

既存「予約管理」メニューへ、`confirmBooking`と対称の2項目を追加した。

- 「アクティブ行のbookingIdをキャンセル（cancelBookingAdmin）」
- 「bookingIdを入力してキャンセル（cancelBookingAdmin）」

**誤操作防止**として、実行直前に必ずYES/NO確認ダイアログを挟む（`ui.alert(message,
ui.ButtonSet.YES_NO)`）。

```text
予約 SX-20261001-XXXXXXXX をキャンセルします。
Calendarから予約枠を削除し、利用者へキャンセルメールを送信します。
よろしいですか？
```

NOなら`cancelBookingAdmin`自体を呼ばず、何も変更しない。結果表示:

- 初回成功: `キャンセルしました: <bookingId>`
- 再実行（`alreadyCancelled`）: `すでにキャンセル済みです: <bookingId>`
- Calendar既に無（`calendarAlreadyMissing`）: `キャンセルしました。Calendarイベントは
  既に存在しなかったためRecoveryへ記録しました: <bookingId>`
- 失敗: `result.error.message`を表示

`status`セルの手編集は案内しない（confirmと同じ方針）。

### PII・セキュリティ

キャンセル処理のCalendarイベント・Recovery記録・管理メニューのダイアログのいずれにも、
氏名・メールアドレス・電話番号・解錠情報等のPIIを追加していない。Recoveryは`bookingId`/
`calendarEventId`/`status`で追跡する。

### 3ブランド共通であることの確認

`cancelBookingAdmin`・`findBookingEventsByBookingId`のいずれも`brand`を一切参照しない
（`Availability.gs`と同じ「brandで分岐させない」方針）。`test/booking-cancel.test.js`で
snb/mens/studio_xの3ブランドすべてが同じ挙動になることを検証している。

### 変更したファイル

- `Booking.gs` — `ALLOWED_TRANSITIONS`へ`CONFIRMED: [STATUS.CANCELLED]`を追加
- `BookingRepository.gs` — `cancelBookingAdmin`本体（Lock・状態遷移・部分失敗補償・
  Recovery記録・キャンセルメール接続）、`CalendarRepository.findBookingEventsByBookingId`
  を使ったSheets行なし診断を追加
- `BookingAdmin.gs` — グローバル関数`cancelBookingAdmin(bookingId)`、メニュー2項目、
  YES/NO確認・結果表示のハンドラを追加
- `CalendarRepository.gs` — 診断用`findBookingEventsByBookingId(calendarId, bookingId,
  dateString, timezone)`を追加（既存の`getEventById`/`deleteEventById`は変更なし）
- `RecoveryRepository.gs` — ファイル冒頭コメントへ新規failureTypeの説明を追加
  （列構成・`recordFailure`/`listAll`自体は変更なし。新しい列も追加していない）
- `SpreadsheetRepository.gs` — **変更なし**（既存の`status`/`cancelledAt`/`updatedAt`/
  `cancelMailSentAt`列をそのまま利用。新しいSheets列は追加していない）
- `BookingMailer.gs` — **変更なし**（#271の`sendCancelledMailForBooking`をそのまま呼ぶだけ）
- `test/booking-cancel.test.js`（新規） — 状態遷移・正常キャンセル・二重実行・メール失敗・
  Calendar既に無い・Calendar削除失敗・Calendar削除成功→Sheets失敗とその再実行収束・
  Sheets行なし診断（0/1/複数件）・confirm/expireとの競合・Reminder対象外・管理メニュー・
  3ブランド共通を検証
- `test/helpers/gas-stubs.js` — `SpreadsheetApp.getUi()`スタブの`alert(message, buttonSet)`
  2引数形式（YES/NO確認ダイアログ）に対応。既存の1引数`alert(message)`呼び出しの挙動は
  変更していない

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
  **Booking Adminプロジェクト（コンテナバインド）専用**（`confirmBooking`と同じ
  プロジェクトに置き、LockServiceを共有させるため。3回目レビュー指摘対応）
- `Code.gs`（拡張） — `doPost`を追加（`createBooking`用。POST専用）。
  **Booking Web Appプロジェクト（スタンドアロン）専用**

### Issue #271（予約通知メール自動送信で追加）

- `BookingMailTemplates.gs` — 件名・本文生成のみの純粋関数
  （`buildPendingMail`/`buildConfirmedMail`/`buildCancelledMail`/`buildReminderMail`）。
  `MailApp`/`SpreadsheetApp`等のGAS組み込みサービスに一切依存せず、`node --test`で
  vm実行できる。ブランド差分は`Booking.getBrandLabel`のみで吸収し、SNB/mens/Studio X
  で本文生成ロジックを複製しない
- `BookingMailer.gs` — 送信制御本体。`LockService`で直列化しつつ、bookingIdで最新
  レコードを再読込→status確認→対応するSentAt確認→`BookingMailTemplates`でテンプレート
  生成→`MailApp.sendEmail`呼び出し→成功時SentAt更新/失敗時`lastMailError*`・
  `RecoveryRepository`記録、を行う。`sendPendingMailForBooking`/
  `sendConfirmedMailForBooking`/`sendCancelledMailForBooking`/
  `sendReminderMailForBooking`をそれぞれ公開し、`{ force: true }`を渡すと
  管理者の明示的な再送として、SentAt済みでも状態条件（status一致）は無視せず再送する
- `BookingReminderTriggers.gs` — 前日リマインド用の正式関数`sendNextDayReminders(now)`と、
  時間主導トリガー作成の補助関数`createNextDayReminderTrigger()`。
  **Booking Adminプロジェクト（コンテナバインド）専用**（`BookingTriggers.gs`と同じ
  理由。`confirmBooking`と同じLockServiceを共有する`BookingMailer`を使うため）
- `SpreadsheetRepository.gs`（拡張） — `Bookings`シートのヘッダーへ送信履歴・
  エラー記録用の8列を**末尾に追記**（後述「Spreadsheet変更（Issue #271）」参照）。
  翌日のCONFIRMED予約抽出用に`getConfirmedBookingsForDate(dateString)`を追加
- `Availability.gs`（拡張） — メールテンプレートの開始/終了時刻表示用に
  `formatTimeInTimezone(date, timezone)`を追加（`formatDateInTimezone`/
  `getCurrentMinutesInTimezone`と同じIntl.DateTimeFormatベースの純粋関数）
- `Config.gs`（拡張） — `getMailConfig()`（`BOOKING_MAIL_DISPLAY_NAME`/
  `BOOKING_MAIL_REPLY_TO`/`BOOKING_CONTACT_EMAIL`）と`getAccessGuideConfig()`
  （`ACCESS_GUIDE_*`。来場案内・秘密値を含む）を追加
- `BookingRepository.gs`（拡張） — `createBooking`はbooking Lock解除後・best effortで
  利用者向けPENDINGメール（`BookingMailer.sendPendingMailForBooking`）を送るようにした
  （管理者通知より先。どちらが失敗しても`createBooking`は`success:true`のまま）。
  `confirmBooking`はCalendar/Sheets確定・Lock解除後・best effortで利用者向けCONFIRMED
  メールを送るようにし、戻り値へ補助情報`mailSent`/`mailError`を追加した（メール失敗でも
  `success:false`にはしない）。既にCONFIRMED済みで`confirmedMailSentAt`が空の場合も、
  状態は変更せずメール送信だけ再試行する
- `BookingAdmin.gs`（拡張） — 「予約管理」メニューへ「予約メールを再送
  （予約ID指定・強制再送）」を追加。bookingIdとメール種別（PENDING/CONFIRMED/
  CANCELLED/REMINDER）をダイアログで入力させ、`{ force: true }`で
  `BookingMailer.send*ForBooking`を呼ぶ

### Issue #272（管理者キャンセルで追加・拡張）

- `Booking.gs`（拡張） — `ALLOWED_TRANSITIONS`へ`CONFIRMED: [STATUS.CANCELLED]`を追加し、
  CONFIRMEDを終端状態から外した
- `BookingRepository.gs`（拡張） — 正式ロジック`cancelBookingAdmin(bookingId)`を追加
  （Lock取得→Sheets最新再読込→status確認→Calendar確認・削除→Sheets CANCELLED更新→
  Lock解除→キャンセルメールbest effort。部分失敗のRecovery記録、Sheets行なし時の
  Calendar診断（`parseBookingDateFromId_`/`findBookingEventsByBookingId`利用）を含む）
- `CalendarRepository.gs`（拡張） — 診断用`findBookingEventsByBookingId(calendarId,
  bookingId, dateString, timezone)`を追加（既存関数は変更なし）
- `BookingAdmin.gs`（拡張） — グローバル関数`cancelBookingAdmin(bookingId)`、「予約管理」
  メニューへキャンセル用2項目（アクティブ行／bookingId入力）、実行直前のYES/NO確認・
  結果表示ハンドラを追加
- `RecoveryRepository.gs`（拡張） — ファイル冒頭コメントへ新規failureType
  （`CANCEL_CALENDAR_EVENT_MISSING`等）の説明を追加。列構成・`recordFailure`/`listAll`
  自体・列追加は無し
- `SpreadsheetRepository.gs` / `BookingMailer.gs` — **変更なし**（既存の
  `status`/`cancelledAt`/`updatedAt`/`cancelMailSentAt`列と#271の
  `sendCancelledMailForBooking`をそのまま利用）

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
| `BookingMailTemplates.gs`（Issue #271） | ✓ | ✓ |
| `BookingMailer.gs`（Issue #271） | ✓ | ✓ |
| `BookingTriggers.gs` | – | ✓ |
| `BookingAdmin.gs` | – | ✓ |
| `BookingReminderTriggers.gs`（Issue #271） | – | ✓ |
| `appsscript.json` | ✓（Web App設定を含む） | 不要（新規プロジェクト作成時の既定のままでよい） |

`BookingRepository.gs`の`confirmBooking`・`expirePendingBookings`・`cancelBookingAdmin`
（Issue #272）が実際に参照するファイルは`Config.gs`/`Booking.gs`/`CalendarRepository.gs`/
`SpreadsheetRepository.gs`/`RecoveryRepository.gs`/`BookingMailTemplates.gs`/
`BookingMailer.gs`のみ（`createBooking`が使う`Availability.gs`/`RateLimiter.gs`/
`AdminNotifier.gs`はBooking Adminプロジェクトでは呼び出されない）。ただし、コピー漏れに
よる将来の機能追加時の事故を避けるため、上表のとおり
「`Code.gs`/`Availability.gs`/`RateLimiter.gs`/`AdminNotifier.gs`/`BookingReminderTriggers.gs`
以外の全ファイル」をBooking Adminプロジェクトにも配布することを推奨する
（`BookingMailTemplates.gs`/`BookingMailer.gs`はcreateBooking側のPENDINGメール送信でも
使うため、両プロジェクトへの配布が必須）。**`cancelBookingAdmin`はBooking Admin側の
みで公開し、Booking Web Appプロジェクト（`Code.gs`）にはキャンセル用エンドポイントを
一切追加しない**（`BookingRepository.gs`自体は両プロジェクトへ配布されるが、
`cancelBookingAdmin`を呼び出すグローバル関数は`BookingAdmin.gs`側にしか無いため、
Booking Web App側からは呼び出せない）。

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
| `PENDING_TTL_MIN_HOLD_HOURS`（Issue #270で追加） | - | 省略時 `2`。当日受付の予約について、受付から少なくとも何時間はPENDINGを保持するか（「PENDING TTLの変更内容と理由」参照） |
| `RATE_LIMIT_EMAIL_COUNT` | - | 省略時 `3` |
| `RATE_LIMIT_EMAIL_WINDOW_MINUTES` | - | 省略時 `10` |
| `RATE_LIMIT_GLOBAL_COUNT` | - | 省略時 `20` |
| `RATE_LIMIT_GLOBAL_WINDOW_MINUTES` | - | 省略時 `1` |
| `RATE_LIMIT_DUPLICATE_WINDOW_MINUTES` | - | 省略時 `2`。同一内容の連投とみなす時間窓 |
| `ADMIN_NOTIFICATION_EMAIL` | - | 省略時は管理者通知を送らない（未設定でもcreateBooking自体は失敗しない） |
| `BOOKING_MAIL_DISPLAY_NAME`（Issue #271） | - | 利用者向けメールの送信者表示名。**未設定の場合、PENDING/CONFIRMED/CANCELLED/REMINDERいずれのメールもfail-closedに送信失敗として扱う**（予約状態は維持） |
| `BOOKING_MAIL_REPLY_TO`（Issue #271） | - | 利用者向けメールのreply-toアドレス。未設定時の扱いは`BOOKING_MAIL_DISPLAY_NAME`と同じ |
| `BOOKING_CONTACT_EMAIL`（Issue #271） | - | 利用者向けメール本文に載せる問い合わせ先。未設定時の扱いは`BOOKING_MAIL_DISPLAY_NAME`と同じ |
| `ACCESS_GUIDE_ADDRESS`（Issue #271） | - | 前日リマインドに載せる施設住所。**未設定の場合、前日リマインド（REMINDER）を成功扱いにせず送信しない**（PRレビュー対応。以下`ACCESS_GUIDE_PDF_URL`を除く全項目が同じ扱い） |
| `ACCESS_GUIDE_BUILDING`（Issue #271） | - | 建物名。同上（未設定なら送信しない） |
| `ACCESS_GUIDE_ROOM`（Issue #271） | - | 部屋番号。同上 |
| `ACCESS_GUIDE_ENTRANCE`（Issue #271） | - | 建物入口から部屋までの案内。同上 |
| `ACCESS_GUIDE_KEYBOX_LOCATION`（Issue #271） | - | キーボックス設置位置。同上 |
| `ACCESS_GUIDE_ENTRY_METHOD`（Issue #271。PRレビュー対応で追加） | - | 入室方法（前日リマインドの必須内容）。同上（未設定なら送信しない） |
| `ACCESS_GUIDE_KEYBOX_NUMBER`（Issue #271。秘密値） | - | キーボックス番号。同上。実値はGitHubへコミットしない |
| `ACCESS_GUIDE_UNLOCK_CODE`（Issue #271。秘密値） | - | 解錠コード。同上 |
| `ACCESS_GUIDE_URL`（Issue #271） | - | 利用案内ページURL。同上 |
| `ACCESS_GUIDE_PDF_URL`（Issue #271） | - | キーボックス案内PDF等のURL。**これだけは任意**（「必要に応じて」の項目のため未設定でも送信は失敗にしない） |

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
Booking Adminは別プロジェクトのため、`CALENDAR_ID`・`SPREADSHEET_ID`は
**両方のプロジェクトに同じ値を設定する必要がある**（片方だけ設定・値がずれている場合、
`createBooking`/`confirmBooking`/`expirePendingBookings`のいずれかが誤ったCalendar/
Spreadsheetを参照してしまう）。

`PENDING_TTL_HOURS`/`PENDING_TTL_MIN_HOURS_BEFORE_START`/`PENDING_TTL_MIN_HOLD_HOURS`は
`expirePendingBookings`が使うため、**Booking Adminプロジェクト側に設定する**
（Booking Web App側は不要）。`RATE_LIMIT_*`/`ADMIN_NOTIFICATION_EMAIL`は
`createBooking`のみが使うため、**Booking Web App側に設定する**（Booking Admin側は不要）。

**`BOOKING_MAIL_DISPLAY_NAME`/`BOOKING_MAIL_REPLY_TO`/`BOOKING_CONTACT_EMAIL`（Issue #271）は
両方のプロジェクトに設定する。** Booking Web App側は`createBooking`のPENDINGメールで、
Booking Admin側は`confirmBooking`のCONFIRMEDメール・`sendNextDayReminders`のREMINDERメール・
`resendBookingMailByPrompt_`の手動再送で、それぞれ利用者向けメールを送るため。
`ACCESS_GUIDE_*`（来場案内。秘密値の`ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`を
含む）は前日リマインド（`sendNextDayReminders`）でのみ使うため、**Booking Adminプロジェクト側
にのみ設定する**（Booking Web App側は不要）。秘密値はいずれもGitHubへ直書きせず、
Script Propertiesにのみ設定すること（README・PRにも実値は記載しない）。

**`TIMEZONE`はIssue #270から両方のプロジェクトで必要になった。** `expirePendingBookings`
（Booking Adminプロジェクト）が「当日受付の予約かどうか」を判定するために
`BookingConfig.getTtlConfig().timezone`を参照するようになったため（「PENDING TTLの
変更内容と理由」参照）、`TIMEZONE`を独自に設定している場合はBooking Adminプロジェクト
側にも同じ値を設定すること（既定`Asia/Tokyo`のまま変更していなければ、両プロジェクトとも
未設定でよく、対応不要）。**Issue #271のPRレビュー対応で、`BookingConfig.getMailConfig()`
にも同じ`TIMEZONE`をそのまま含めるようにした**（新しいScript Propertyは追加していない）。
利用者向けメール本文の開始/終了時刻表示はこの値を使うため、`TIMEZONE`を独自設定している
場合は両プロジェクトで値を揃えないと、メール本文の時刻表示とCalendar/`Bookings`シートの
実際の時刻がずれる可能性がある。`TIMEZONE`が不正でIntlが解釈できない場合、PENDING/
CONFIRMED/CANCELLED/REMINDERいずれのメールもfail-closedに送信失敗として扱う。

## Spreadsheet構成

1. 新規のGoogle Spreadsheetを1つ作成し、そのidを`SPREADSHEET_ID`に設定する。
2. シート（タブ）は初回アクセス時に自動作成される（`Bookings`・`Recovery`とも、
   存在しなければ`SpreadsheetRepository`/`RecoveryRepository`が作成しヘッダー行を書く）。
   手動でシートを作る必要はない。

### `Bookings`シート（予約台帳）列構成

`bookingId` / `createdAt` / `date` / `startAt` / `endAt` / `brand` / `name` / `email` /
`phone` / `people` / `purpose` / `paymentMethod` / `status` / `calendarEventId` /
`source` / `note` / `confirmedAt` / `expiredAt` / `cancelledAt` / `updatedAt` /
`customerType`（Issue #270で追加。`first_time`または`returning`） /
`pendingMailSentAt` / `confirmedMailSentAt` / `cancelMailSentAt` / `reminderSentAt` /
`accessGuideSentAt` / `lastMailErrorAt` / `lastMailErrorType` / `lastMailErrorMessage`
（いずれもIssue #271で追加）

- `customerType`はIssue #270で20列目として**末尾に追記**した。既存行との互換性を保つため
  途中に挿入していない（既存行はこの列が空のまま＝利用区分不明として扱われる）。
- `pendingMailSentAt`〜`lastMailErrorMessage`の8列はIssue #271で21〜28列目として、同じ
  「末尾に追記」の方針で追加した（既存行はこれらの列が空のまま読める。`rowToRecord_`/
  `recordToRow_`/`appendBooking`/`updateBookingFields`の互換性は壊していない）。
  - `pendingMailSentAt`/`confirmedMailSentAt`/`cancelMailSentAt`/`reminderSentAt`/
    `accessGuideSentAt`はそれぞれのメール種別を送信した日時。**空の場合だけ自動送信の
    対象になる**（二重送信防止。詳細は「Issue #271: 予約通知メール自動送信」参照）。
    `reminderSentAt`と`accessGuideSentAt`は前日リマインドを1通にまとめて送るため、
    成功時に同じ時刻で同時に記録する。
  - `lastMailErrorAt`/`lastMailErrorType`/`lastMailErrorMessage`は直近のメール送信失敗
    （設定不足によるfail-closedな拒否を含む）の記録。次回同種メールの送信に成功すると
    自動的に空へ戻す。
- `status`は`PENDING` / `CONFIRMED` / `CANCELLED` / `EXPIRED`のいずれか。
  **このセルを直接手編集するのは正式運用ではない。** 確定は必ず`confirmBooking(bookingId)`
  （カスタムメニュー経由）を使うこと。TTL失効・キャンセルも将来的に専用関数経由のみとする。
- 料金列は持たない（Phase 1では自動料金計算をしないため。Issue #271の確定メールでも
  料金は本文へ出さない）。

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
| `MAIL_PENDING_FAILED`（Issue #271） | 利用者向けPENDINGメールの送信に失敗（設定不足によるfail-closedな拒否を含む。予約自体・`status`は変更しない。`Bookings`シートの`lastMailError*`にも同時記録） |
| `MAIL_CONFIRMED_FAILED`（Issue #271） | 利用者向けCONFIRMEDメールの送信に失敗。同上（`confirmBooking`自体の成否には影響しない） |
| `MAIL_CANCELLED_FAILED`（Issue #271） | 利用者向けCANCELLEDメールの送信に失敗。同上（#271では送信関数のみ。呼び出し配線は#272の`cancelBookingAdmin`で実装済み） |
| `CANCEL_CALENDAR_EVENT_MISSING`（Issue #272） | cancelBookingAdmin時にCalendarイベントが既に存在しなかった（SheetsはCANCELLEDへ収束させる。「Issue #272」参照） |
| `CANCEL_CALENDAR_DELETE_FAILED`（Issue #272） | cancelBookingAdmin時のCalendarイベント削除自体が失敗（Sheetsは元statusのまま進めない・**要手動対応**） |
| `CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED`（Issue #272） | Calendar削除成功→Sheets側のCANCELLED更新が失敗（**要手動対応**。同じbookingIdで再実行すればCalendar既に無い経路から収束できる） |
| `CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT`（Issue #272） | Sheets行が無いが、Calendarに対象日・bookingIdタグ一致のイベントが1件見つかった（Calendarは自動削除しない・**要手動対応**） |
| `CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND`（Issue #272） | 同上でCalendarに複数件見つかった（**要手動対応**。Calendarは自動削除しない） |
| `CANCEL_BOOKING_NOT_FOUND`（Issue #272） | Sheets行が無く、Calendarにも該当イベントが見つからない（またはbookingId形式が不正で診断自体をスキップした） |
| `MAIL_REMINDER_FAILED`（Issue #271） | 前日リマインド（来場案内含む）の送信に失敗。解錠コード等の秘密値未設定によるfail-safeな拒否もここに含む。`status`はCONFIRMEDのまま変更しない |

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
7. `failureType`が`MAIL_PENDING_FAILED`/`MAIL_CONFIRMED_FAILED`/`MAIL_CANCELLED_FAILED`/
   `MAIL_REMINDER_FAILED`（Issue #271）の場合、予約自体の`status`・Calendar/Sheetsの
   予約データは正常なまま（メール送信のみが失敗している）。`Bookings`シートの該当行の
   `lastMailErrorAt`/`lastMailErrorType`/`lastMailErrorMessage`で発生日時・種別・
   エラー概要を確認し、原因（`BOOKING_MAIL_DISPLAY_NAME`等の設定不足、
   `ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`の未設定、MailAppの
   日次クォータ超過等）を解消したうえで、Booking Adminプロジェクトの「予約管理」
   メニュー→「予約メールを再送（予約ID指定・強制再送）」からbookingIdとメール種別を
   指定して再送する（詳細は「Issue #271: 予約通知メール自動送信」の「手動再送」参照）。
   自動処理は対応するSentAtが既にある場合は再送しないため、原因解消後の再送は
   必ずこの手動再送機能を使うこと（SentAtを直接消す運用はしない）。
8. `failureType`が`CANCEL_CALENDAR_EVENT_MISSING`（Issue #272）の場合、`cancelBookingAdmin`
   実行時点でCalendarイベントが既に無かったことを示す（Sheetsは`CANCELLED`へ収束済み。
   予約処理自体は完了している）。`bookingId`を`Bookings`シートで確認し、いつ・なぜ
   Calendar側だけ先に消えたか（手動削除・スペースマーケット側の操作等）を調査する。
   調査が完了したら`recoveryState`・`resolvedAt`を手動で記録する（自動ではRESOLVEDに
   ならない。詳細は「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」参照）。
9. `failureType`が`CANCEL_CALENDAR_DELETE_FAILED`（Issue #272）の場合、`calendarEventId`は
   まだCalendar上に残っている可能性が高い（`Bookings`シートの`status`は元のまま）。
   Calendar側の一時的な障害（API制限等）が解消したことを確認したうえで、同じbookingIdで
   再度`cancelBookingAdmin(bookingId)`を実行する。
10. `failureType`が`CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED`（Issue #272）の場合、
    `calendarEventId`のCalendarイベントは既に削除済みだが、`Bookings`シート側は`status`が
    `PENDING`/`CONFIRMED`のまま残っている。**Calendarイベントを手動で作り直して補償しない**
    （eventIdが変わり二次的不整合を増やすため）。Sheets保存先の一時的な障害が解消したことを
    確認できれば、同じbookingIdで再度`cancelBookingAdmin(bookingId)`を実行する
    （Calendar側は既に無いため`CANCEL_CALENDAR_EVENT_MISSING`の経路から`Bookings`の`status`が
    正しく`CANCELLED`へ収束し、キャンセルメールも送信される。`test/booking-cancel.test.js`の
    障害分離テストと同じ仕組みで安全に再実行できる）。
11. `failureType`が`CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT`/
    `CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND`（Issue #272）の場合、`Bookings`シートに
    正式な予約台帳の行が無いまま、Calendarにだけ`bookingId`タグ一致のイベントが1件/複数件
    残っている。**この診断ではCalendarを自動削除しない**（正式台帳が無い状態で破壊的変更を
    行うのは危険なため）。`calendarEventId`をCalendarで直接確認し、利用者情報・支払い状況を
    運用側の記録（メール等）から復元したうえで、Google Calendar UIから手動で削除するか、
    運用判断でそのまま残すかを決める。
12. `failureType`が`CANCEL_BOOKING_NOT_FOUND`（Issue #272）の場合、`Bookings`シートにも
    Calendarにも該当する予約が見つからない（bookingIdの入力ミス、または既に別の方法で
    削除済みの可能性がある）。`bookingId`の入力内容を確認し、心当たりがなければ対応不要
    （記録のみで実害はない）。

## API仕様

### `GET ?date=YYYY-MM-DD&durationMinutes=120&brand=studio_x`（getAvailability。
#266から拡張、Issue #270レビュー対応で「過去日の拒否」「当日の過去開始時刻を除外」を追加）

`brand`には`snb` / `mens` / `studio_x`のいずれかを指定できる（getAvailabilityは元から
brandで判定を分岐させないため、この値は表示・流入元識別以外に使われない）。
`customerType`はgetAvailabilityの入力・応答のいずれにも登場しない（当日+初回利用の
可否判定は`createBooking`のみの責務。「当日の過去開始時刻を防ぐ」参照）。

`date`は`Asia/Tokyo`基準の「今日」（`today`）と比較する:

- `date < today` → `INVALID_DATE`（`過去の日付は指定できません。`）で拒否する。
  `handleGetAvailability_`（`Code.gs`）でも同じ判定を行い、過去日はCalendarへ
  問い合わせる前に拒否する（不要なCalendar API呼び出しを避けるため。
  `BookingAvailability.getAvailability`内でも同じ判定を行うため二重の安全網になる）
- `date === today` → `bookableStartTimes`には現在時刻より後の開始時刻のみを含める
  （現在時刻ちょうども除外）
- `date > today` → 現在時刻に関わらず従来どおり全候補を返す

`createBooking`の`INVALID_DATE`（過去日拒否）と同じerror.code・同じメッセージで統一する。

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

### `POST`（createBooking。#268でstudio_x限定として追加、#269でsnb/mensへ拡張、
#270でcustomerTypeを必須項目として追加）

リクエストボディ（JSON。`Content-Type`は共通予約UIから`text/plain;charset=utf-8`で
送る。理由は「共通予約UI（フロントエンド）」節を参照）:

```json
{
  "brand": "studio_x",
  "customerType": "returning",
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
  "source": "studio-x-booking-app"
}
```

`brand`には`snb` / `mens` / `studio_x`のいずれかを指定する。`customerType`には
`first_time`（初回利用）または`returning`（利用経験あり）のいずれかを指定する
（Issue #270で必須項目として追加。省略・未知の値は`INVALID_CUSTOMER_TYPE`で拒否する）。
`date`が当日（Asia/Tokyo基準）かつ`customerType`が`first_time`の場合は
`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`で拒否する。当日かつ`startTime`が現在時刻以前
（ちょうど含む。Asia/Tokyo基準）の場合は`SAME_DAY_START_TIME_PASSED`で拒否する
（「Issue #270: 当日利用ルールと利用経験判定」参照）。`source`は共通予約UIが
ブランドごとに自動設定する値で、`snb-booking-app` / `mens-booking-app` /
`studio-x-booking-app`のいずれかになる（`scripts/booking-logic.js`の
`BRAND_META`参照）。

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

`error.code`の主な値: `INVALID_BRAND` / `INVALID_CUSTOMER_TYPE`（Issue #270で追加。
`customerType`が未指定・未知の値） / `INVALID_CONFIG`（Availability設定自体が不正。
fail-closed） / `INVALID_DATE`（過去日を含む） /
`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`（Issue #270で追加。当日＋`first_time`の組み合わせ）/
`SAME_DAY_START_TIME_PASSED`（Issue #270レビュー対応で追加。当日＋開始時刻が現在時刻
以前）/ `INVALID_DURATION` / `DURATION_TOO_SHORT` /
`INVALID_START_TIME` / `START_TIME_NOT_ALIGNED`（開始時刻が`SLOT_STEP_MINUTES`刻みでない）/
`INVALID_NAME` / `INVALID_EMAIL` / `INVALID_PHONE` / `INVALID_PEOPLE` / `INVALID_PURPOSE` /
`INVALID_PAYMENT_METHOD` / `INVALID_NOTE` / `INVALID_SOURCE` / `RATE_LIMITED`
（`error.reason`に`EMAIL_RATE_LIMIT`/`GLOBAL_RATE_LIMIT`/`DUPLICATE_SUBMISSION`のいずれか）/
`LOCK_TIMEOUT` / `SLOT_CONFLICT` / `BOOKING_SAVE_FAILED` / `INVALID_JSON` /
`INTERNAL_ERROR`

Issue #269時点で`brand`に指定できるのは`snb` / `mens` / `studio_x`の3つのみで、
それ以外の文字列を指定した場合はサーバー側で`INVALID_BRAND`として拒否する
（フロント表示に関わらずbrand偽装で未許可のbrandからの予約は作れない）。同様に
Issue #270時点で`customerType`に指定できるのは`first_time` / `returning`の2つのみ。

## 管理メニュー用GASプロジェクト（Booking Admin）のセットアップ

**背景**: Googleの仕様上、`SpreadsheetApp.getUi()`によるカスタムメニュー作成は、
対象Spreadsheetへコンテナバインドしたスクリプト（Spreadsheetの「拡張機能 → Apps Script」
から作成するプロジェクト）からしか使えない。スタンドアロンスクリプトが対象Spreadsheetに
対するinstallable onOpenトリガーを作成しても、そのスクリプト自体がbound scriptになる
わけではなく、`getUi()`は利用できない（1回目レビューでは
`installBookingAdminMenuTrigger()`によるinstallable onOpenトリガー方式を採用したが、
この理由により2回目レビューで指摘を受け撤回した。Web App本体は変更していない）。

そのため、カスタムメニュー（`BookingAdmin.gs`）と、PENDING TTL失効
（`BookingTriggers.gs`／`expirePendingBookings`）は、Web App本体（スタンドアロン。
`createBooking`/`getAvailability`専用）とは別の、`SPREADSHEET_ID`のSpreadsheetへ
コンテナバインドした専用のApps Scriptプロジェクト（Booking Admin）へデプロイする。
`confirmBooking`と`expirePendingBookings`を同一プロジェクトに置くのは、GASの
`LockService.getScriptLock()`がスクリプトプロジェクト単位でしか排他を提供しないため
であり、この2つを同一プロジェクトにまとめることで**同じLockを共有し、PENDING→CONFIRMED
とPENDING→EXPIREDが同時に進む競合を構造的に排除する**（3回目レビュー指摘対応。
当初はexpirePendingBookingsをWeb App側に置いていたが、Lock非共有によるCalendar/Sheets
不整合の可能性を指摘され、この設計に変更した）。

### セットアップ手順

1. `SPREADSHEET_ID`で指定したGoogle Spreadsheetを開く。
2. メニュー「拡張機能」→「Apps Script」を選択する（このSpreadsheetにコンテナバインドした
   新規プロジェクトが作成される）。
3. 「GASプロジェクトへのデプロイ対象ファイル」の表にある**Booking Admin列が✓のファイル**
   （`Config.gs` / `CalendarRepository.gs` / `Booking.gs` / `SpreadsheetRepository.gs` /
   `RecoveryRepository.gs` / `BookingRepository.gs` / `BookingMailTemplates.gs` /
   `BookingMailer.gs` / `BookingAdmin.gs` / `BookingTriggers.gs` /
   `BookingReminderTriggers.gs`）をコピーする。
4. このプロジェクトのScript Propertiesに `CALENDAR_ID` / `SPREADSHEET_ID` /
   `PENDING_TTL_HOURS` / `PENDING_TTL_MIN_HOURS_BEFORE_START` /
   `PENDING_TTL_MIN_HOLD_HOURS`（Issue #270で追加） / `BOOKING_MAIL_DISPLAY_NAME` /
   `BOOKING_MAIL_REPLY_TO` / `BOOKING_CONTACT_EMAIL` / `ACCESS_GUIDE_*`一式
   （Issue #271で追加。「Script Properties」節参照）を設定する
   （`CALENDAR_ID`/`SPREADSHEET_ID`/`BOOKING_MAIL_*`はBooking Web App側と同じ値。
   `TIMEZONE`を既定値`Asia/Tokyo`から変更している場合はここにも同じ値を設定すること）。
5. 保存してSpreadsheetを再読み込みする。コンテナバインドスクリプトの`onOpen()`単純トリガーが
   自動的に発火し、「予約管理」メニューが表示される（installable trigger等の追加設定は
   一切不要。これがcontainer-bound scriptの標準的な挙動）。
6. 「PENDING TTL失効トリガーの作成手順」に従って、このBooking Adminプロジェクトの
   スクリプトエディタから`createExpirePendingBookingsTrigger`を実行する
   （または手動でトリガーを作成する）。前日リマインドを運用する場合は、同様に
   「前日リマインド用トリガーの作成」（Issue #271）に従って`createNextDayReminderTrigger`
   も実行する。
7. Web Appとしてのデプロイは不要（このプロジェクトはSpreadsheetのUI拡張＋時間主導
   トリガーとしてのみ使う）。

### LockServiceの共有について

`confirmBooking`・`expirePendingBookings`・`cancelBookingAdmin`（Issue #272）はいずれも
このBooking Adminプロジェクトに属し、同じ`LockService.getScriptLock()`を取得する。
そのため、いずれか1つがLockを保持している間は他の`tryLock`が失敗（`LOCK_TIMEOUT`、
または`expirePendingBookings`側は該当候補をスキップして次回トリガーへ持ち越し）し、
PENDING→CONFIRMED、PENDING→EXPIRED、PENDING/CONFIRMED→CANCELLEDが同時に進んで
Calendar/Sheetsが不整合になることはない（`test/booking-confirm-expire.test.js`・
`test/booking-cancel.test.js`のLock共有テストで検証済み）。

なお、`createBooking`（Booking Web Appプロジェクト）とこの3関数（Booking Admin
プロジェクト）は別々のプロジェクトのため、Lockは共有されない。ただし
`createBooking`は常に新しいbookingIdの行を追加するだけで既存行を書き換えないため、
`confirmBooking`/`expirePendingBookings`/`cancelBookingAdmin`（既存行の状態遷移のみを
扱う）と競合する余地はそもそもない。

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

## 管理メニューからの予約キャンセル（cancelBookingAdmin）手順（Issue #272）

1. Booking Adminプロジェクトのセットアップが完了していれば、`SPREADSHEET_ID`で
   指定したSpreadsheetを開くだけで「予約管理」メニューが自動的に表示される
   （追加のトリガー設定は不要）。
2. キャンセルしたい予約の内容を`Bookings`シートで確認する（利用者への連絡が
   必要な場合は、このタイミングで運用側の記録・利用者への通知方針を確認しておく）。
3. 次のいずれかの方法でキャンセルを実行する。
   - **アクティブ行をキャンセル**: `Bookings`シート上で対象の行（bookingIdの行）を
     選択してから、メニュー「予約管理」→「アクティブ行のbookingIdをキャンセル
     （cancelBookingAdmin）」を実行する。
   - **bookingIdを入力してキャンセル**: メニュー「予約管理」→「bookingIdを入力して
     キャンセル（cancelBookingAdmin）」を実行し、ダイアログにbookingIdを入力する。
4. **実行直前に必ずYES/NO確認ダイアログが表示される。** 「Calendarから予約枠を
   削除し、利用者へキャンセルメールを送信します。よろしいですか？」に対してNOを
   選ぶと何も変更されない（`cancelBookingAdmin`自体を呼ばない）。YESを選んで初めて
   実行される。
5. 結果はダイアログで表示される。
   - 初回成功: `キャンセルしました: <bookingId>`（`status`が`CANCELLED`になり、
     `cancelledAt`が記録され、対応するCalendarイベントが**削除**される）
   - 再実行（既にCANCELLED）: `すでにキャンセル済みです: <bookingId>`
   - Calendarイベントが既に存在しなかった場合: `キャンセルしました。Calendarイベントは
     既に存在しなかったためRecoveryへ記録しました: <bookingId>`（`Recovery`シートに
     `CANCEL_CALENDAR_EVENT_MISSING`が記録される。詳細は「部分失敗・recoveryの確認手順」参照）
   - 失敗時: エラーメッセージが表示される（`Recovery`シートを確認する）
6. Booking Adminプロジェクトのスクリプトエディタから`cancelBookingAdmin("SX-...")`を
   直接実行することもできる（Issue #272本文の正式関数名）。
7. **`status`セルを直接編集してキャンセルさせる運用はしないこと。** 必ずこの手順
   （＝`cancelBookingAdmin`経由）で行う。二重実行しても壊れない（2回目は「すでに
   キャンセル済みです」と表示されるだけで安全。Calendarを再削除したり`cancelledAt`を
   上書きしたりしない）。
8. **公開Web App（利用者向けURL）にはキャンセル機能を一切公開していない。** 利用者
   自身がキャンセルできる導線は#272の非対象であり、このメニュー（Booking Admin側）
   からのみキャンセルできる。

## PENDING TTL失効トリガーの作成手順

`expirePendingBookings`・そのトリガーは**Booking Adminプロジェクト**（`BookingTriggers.gs`。
「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」参照）に属する。
Booking Web Appプロジェクトのスクリプトエディタではない点に注意。

本PRでは本番の時間主導トリガー作成そのものは行わない（コードのみ実装）。以下の
いずれかの方法で運用開始時に設定する。

- **方法A（推奨・補助関数を使う）**: Booking Adminプロジェクトのスクリプトエディタで
  `createExpirePendingBookingsTrigger`を選択し、一度だけ実行する。`expirePendingBookings`
  を15分おきに実行するトリガーが作成される（同名トリガーが既にある場合は重複作成しない）。
- **方法B（Apps Script UIから手動作成）**: Booking Adminプロジェクトのスクリプトエディタ
  左メニューの「トリガー」→「トリガーを追加」→ 実行する関数: `expirePendingBookings` /
  イベントのソース: 時間主導型 / 時間ベースのタイマー: 分ベースのタイマー（例: 15分おき）を
  選択して保存する。

失効判定は「受付から`PENDING_TTL_HOURS`時間後」と「利用開始時刻の
`PENDING_TTL_MIN_HOURS_BEFORE_START`時間前」の早い方。ただし当日受付の予約
（受付日と利用日`date`が一致する予約）については、受付から少なくとも
`PENDING_TTL_MIN_HOLD_HOURS`時間はPENDINGを保持する下限が働く（Issue #270。
詳細は「Issue #270: 当日利用ルールと利用経験判定」の「PENDING TTLの変更内容と理由」
参照。翌日以降に受け付けた予約の判定式は#268時点から変更していない）。
失効したPENDINGはCalendarイベントを削除し、Sheets側の`status`を`EXPIRED`にして
`expiredAt`を記録する。Calendar削除に失敗した場合も`Recovery`シートへ記録した上で
Sheets側はEXPIREDへ進める（PENDINGのまま放置しない）。

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
   （`BookingAdmin.gs`・`BookingTriggers.gs`・`BookingReminderTriggers.gs`を除く全
   `.gs`ファイルと`appsscript.json`）をコピーする。
2. Script Propertiesを設定する（最低限 `CALENDAR_ID` / `SPREADSHEET_ID`。
   利用者向けPENDINGメールを送る場合は`BOOKING_MAIL_DISPLAY_NAME` /
   `BOOKING_MAIL_REPLY_TO` / `BOOKING_CONTACT_EMAIL`もここに設定する（Issue #271）。
   `PENDING_TTL_*`/`ACCESS_GUIDE_*`はBooking Admin側の設定のためここでは不要）。
3. Webアプリとして新規デプロイし、上記の「デプロイ設定」の通りに設定する。
4. デプロイ後のWeb App URLは、本Issueでは既存フォーム・既存サイトのどこからも
   参照しない（#269以降の共通予約UI実装時に接続する）。
5. **Booking Admin**: 「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」に
   従って別途セットアップする（`CALENDAR_ID` / `SPREADSHEET_ID`をこのプロジェクトにも
   同じ値で設定することを忘れないこと。PENDING TTL失効トリガーの作成もこの手順に含まれる）。

## ロールバック方法

このPRはコード追加のみで、本番デプロイ・実Calendarへの書き込み・Spreadsheet運用開始を
一切行っていない。マージ後に問題が見つかった場合:

- **本番デプロイ前に気づいた場合**: そのままPRをrevertする、またはこのブランチのマージ
  コミットをrevertすれば元の状態（#266のgetAvailabilityのみ）に戻る。
- **Web Appを新デプロイ済みの場合**: Apps Scriptのデプロイ管理から、`doPost`を含まない
  古いバージョン（#266時点のデプロイ）へロールバックする、または新デプロイを無効化する。
  `doGet`（getAvailability）の挙動はこのIssueで変更していないため、ロールバックしても
  既存フォーム・既存の空き判定表示には影響しない。
- **Booking Adminプロジェクトを作成済みの場合**: そのプロジェクト自体を削除するか、
  対象Spreadsheetへの紐付け（コンテナバインド）を解除すれば「予約管理」メニューは
  表示されなくなる。時間主導トリガー（`expirePendingBookings`）もこのプロジェクトの
  スクリプトエディタ「トリガー」画面から削除できる（プロジェクト自体を削除すれば
  トリガーも合わせて失効する）。
- **Spreadsheet運用を開始済みの場合**: `Bookings`/`Recovery`シートはBooking Web App /
  Booking Adminの2プロジェクト以外から書き込まれないため、両方のGASデプロイ・
  スクリプトを止めれば新規の自動書き込みは止まる
  （既存の行データ自体を削除する必要はない）。
- **Issue #271（予約通知メール自動送信）分**: このPRでは実メール送信・本番Script
  Properties設定（`BOOKING_MAIL_*`/`ACCESS_GUIDE_*`）・本番トリガー作成のいずれも
  行っていないため、コードをrevertするだけで元の状態（管理者向け内部通知のみ）に戻る。
  既にScript Propertiesを設定・`createNextDayReminderTrigger`を実行済みの場合は、
  該当プロパティの削除とBooking Adminプロジェクトの「トリガー」画面から
  `sendNextDayReminders`のトリガーを削除する。
- **Issue #272（管理者キャンセル）分**: このPRでは本番Calendarイベントの削除・本番
  Spreadsheetの`status`変更・実キャンセルメール送信のいずれも行っていないため、
  コードをrevertするだけで元の状態（PENDING/CONFIRMED→CANCELLEDへの正式な手段が
  無い状態）に戻る。既にBooking Adminプロジェクトへ本PRのファイルを反映済みの場合は、
  反映前のファイル（`Booking.gs`の`ALLOWED_TRANSITIONS`にCONFIRMEDが無い版・
  `BookingAdmin.gs`にキャンセルメニューが無い版等）へ手動で戻すか、Booking Admin
  プロジェクト自体を削除する。`cancelBookingAdmin`は新しいScript Propertyを追加
  していないため、ロールバック時にプロパティの削除は不要。

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
   `confirmBooking`と`expirePendingBookings`は同じBooking Adminプロジェクトに属し、
   同じ`LockService.getScriptLock()`を取得するため、PENDING→CONFIRMEDと
   PENDING→EXPIREDが同時に進む競合は発生しない（3回目レビュー指摘を受け、両関数を
   同一プロジェクトへ統合。詳細は「管理メニュー用GASプロジェクト（Booking Admin）の
   セットアップ」内「LockServiceの共有について」を参照）。`createBooking`
   （Booking Web Appプロジェクト）はこの2つとLockを共有しないが、常に新規行を追加する
   だけで既存行を書き換えないため、そもそも競合しない。
4. **PENDING TTLとEXPIRED状態遷移**: 「受付+24h」と「開始-2h」の早い方を失効時刻とし、
   Booking Adminプロジェクトの時間主導トリガー（`expirePendingBookings`）が候補を
   抽出→Lock取得→status再確認→Calendar削除→Sheets更新の順で処理する。
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
  （当時はBooking Web Appプロジェクトに配置）が別プロジェクトになったことで、LockService
  による相互排他が効かなくなる点を認識し、「既知の制約」として文書化した上で、Calendarを
  実際に変更する直前にもう一度statusを再確認する緩和策（`CONFLICTING_STATUS_CHANGE`）を
  `confirmBooking`に追加した（`test/booking-confirm-expire.test.js`で検証）。
  **この「既知の制約」自体は3回目レビューでさらに指摘を受け、根本解消した（下記参照）。**

### PRレビュー（3回目）指摘への追加対応

2回目レビューで対応した「confirmBookingとexpirePendingBookingsが別プロジェクトになり
LockServiceを共有できない」という既知の制約について、3回目のレビューで
「status再確認を追加しても“再確認→Calendar変更→Sheets更新”の間に別プロジェクト側が
同じbookingIdを処理できるため、confirmとexpireの同時実行でCalendar/Sheets不整合が
起こり得る。この競合は既知の制約として残さず#268内で解消してほしい」との指摘を受けた。
指摘の通り、再確認による緩和では競合windowを狭めるだけで根本解決にはならないため、
以下のとおり設計を変更した。

- `expirePendingBookings`とそのトリガー（`BookingTriggers.gs`）を、Booking Web App
  プロジェクトからBooking Adminプロジェクトへ移した。これにより`confirmBooking`と
  `expirePendingBookings`が同一Apps Scriptプロジェクトに属し、同じ
  `LockService.getScriptLock()`を共有するようになり、PENDING→CONFIRMEDと
  PENDING→EXPIREDが同時に進む競合が構造的に発生しなくなった。
- 上記により不要になった`confirmBooking`内のCalendar変更直前のstatus再確認
  （`CONFLICTING_STATUS_CHANGE`）を削除し、2回目レビュー以前のシンプルな実装に戻した
  （同一Lockで直列化されるため、この緩和策はもはや意味を持たないため）。
- Booking Web Appプロジェクトの役割を`getAvailability`・`createBooking`・管理者通知の
  みに整理し、Booking Adminプロジェクトの役割にカスタムメニュー・`confirmBooking`・
  `expirePendingBookings`（TTL失効トリガー含む）をまとめた。
- README「GASプロジェクトへのデプロイ対象ファイル」「管理メニュー用GASプロジェクト
  （Booking Admin）のセットアップ」「Script Properties」「PENDING TTL失効トリガーの
  作成手順」の各節を更新し、旧「既知の制約」節は「LockServiceの共有について」（両者が
  同じLockを共有し安全に直列化される旨の説明）に置き換えた。
- `test/booking-confirm-expire.test.js`の`CONFLICTING_STATUS_CHANGE`テストを、
  「同一LockServiceを共有するため片方がLock保持中はもう片方がLOCK_TIMEOUT/スキップに
  なる」ことを検証するテストに置き換えた。

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
  統合テスト（状態遷移・TTL・二重実行・部分失敗補償/recovery記録・障害分離・両関数が
  同一LockServiceを共有し直列化されることの検証・container-boundスクリプトのonOpen
  単純トリガーによる管理メニューの配線）

Issue #269で追加・更新:

- `test/booking-model.test.js`（更新） — snb/mens/studio_xの3ブランドすべてを許可し、
  未知のbrandは引き続き`INVALID_BRAND`になること、brand別bookingId prefix
  （`SNB-`/`MENS-`/`SX-`）、`Booking.getBrandLabel`の表示名を追加検証
- `test/booking-create-booking.test.js`（更新） — 3ブランドすべてでcreateBooking成功・
  PENDING作成・Sheetsのbrand列保存・Calendarのbrandタグ保存・bookingId prefix・
  Calendarタイトルへのブランド表示名反映・管理者通知件名へのブランド表示名反映・
  未知brandの拒否・**SNB/mens/Studio Xは同一Calendarのため、いずれかのブランドで
  作った予約が他の2ブランドから見てSLOT_CONFLICTになること**（6パターン総当たり）を追加
- `test/booking-logic.test.js`（新規） — 共通予約UIのDOM非依存ロジック
  （`scripts/booking-logic.js`）。ブランド別表示名・error.code→日本語メッセージ変換・
  エラー種別ごとの回復導線（時間の選び直し/入力の修正/再試行）振り分け・入力検証・
  createBookingペイロード組み立て・JST「明日」計算
- `test/helpers/frontend-sandbox.js`（新規） — `test/helpers/gas-sandbox.js`と同じ方針で
  `scripts/`配下のDOM非依存JSをvm実行するテストヘルパー

Issue #270で追加・更新:

- `test/booking-model.test.js`（更新） — `customerType`の必須検証（未指定・未知の値は
  `INVALID_CUSTOMER_TYPE`）、過去日の拒否（`INVALID_DATE`）、当日+初回利用の拒否
  （`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`）、当日+利用経験ありの許可、翌日以降は
  両方許可、snb/mens/studio_xで同じ挙動になること、`Booking.formatDateInTimezone`の
  タイムゾーン変換・不正timezoneのfail-closedを追加。**レビュー対応で追加**:
  当日+利用経験ありで開始時刻が現在時刻以前（ちょうど含む）は
  `SAME_DAY_START_TIME_PASSED`で拒否、現在時刻より後なら許可、当日+初回利用は
  過去開始時刻でも`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`が優先、翌日以降は
  過去開始時刻判定を行わないこと、snb/mens/studio_xで同じ挙動になること。
  `computeTtlExpiryMillis`/`isExpired`の`minHoldHours`引数をレビュー指摘の
  最低限のTTLテスト（09:00受付/09:30・10:30・11:30・12:00開始、翌日、ttlHours=1、
  当日直前予約すべてで`expiry<=startAt`かつ`expiry>createdAt`）に置き換え
- `test/booking-availability.test.js`（更新） — `computeBookableStartTimes`の
  `minimumStartMinutes`引数、`getAvailability`が当日は現在時刻以前（ちょうど含む）の
  候補を除外し翌日以降は従来どおり全候補を返すこと、`now`省略時のデフォルト、
  `getAvailability`の応答にcustomerType関連キーが一切含まれないこと、
  `getCurrentMinutesInTimezone`/`formatDateInTimezone`の不正timezoneのfail-closedを追加
  （Issue #270レビュー対応）。**2回目レビュー対応で追加**: `getAvailability`が
  過去日（`date < today`）を`INVALID_DATE`（`過去の日付は指定できません。`）で
  拒否すること
- `test/booking-code-runtime.test.js`（更新） — doGetの配線が当日フィルタ追加後も
  壊れていないこと（実行時の現在日付と一致しない固定日付では従来どおり全候補が
  返ること）を追加。**2回目レビュー対応で追加**: doGetに過去日を指定すると
  `INVALID_DATE`を返し`bookableStartTimes`を含まないこと、かつCalendarへ
  問い合わせる前に拒否すること（`handleGetAvailability_`のCalendar呼び出し前チェック）
- `test/booking-config.test.js`（更新） — `getTtlConfig()`の既定値
  （`minHoldHours`/`timezone`を含む）、`PENDING_TTL_MIN_HOLD_HOURS`の
  Script Properties上書き・誤設定時のフォールバックを追加
- `test/booking-create-booking.test.js`（更新） — `createBooking`が受け取る`now`引数を
  使い、当日+初回利用の拒否（Calendar/Sheetsに何も作らずbookingIdも返さないことを含む）・
  当日+利用経験ありのPENDING作成成功（Sheetsの`customerType`列保存を含む）・
  翌日以降は両方成功・snb/mens/studio_xで同じ挙動になること・`customerType`未指定/
  不正値の拒否・過去日の拒否を追加。**レビュー対応で追加**: 当日+利用経験ありで
  開始時刻が現在時刻以前はAPI直呼びでも`SAME_DAY_START_TIME_PASSED`で拒否し
  Calendar/Sheetsに何も作らないこと、現在時刻より後なら成功すること、当日+初回利用は
  過去開始時刻でも優先順位どおり`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`が返ること、
  snb/mens/studio_xで同じ挙動になること
- `test/booking-confirm-expire.test.js`（更新） — 当日受付・開始2時間未満の予約が
  作成直後の`expirePendingBookings`実行で即EXPIREDにならないこと、受付日と利用日が
  一致しない（＝当日受付でない）予約は対象外のまま#268時点と同じTTL計算になることを
  追加（`BookingTriggers.gs`のグローバル関数`expirePendingBookings(now)`が受付時刻を
  受け取れるようにした変更に対応）。**レビュー対応で更新**: 「minHoldHoursを過ぎれば
  EXPIREDになる」テストを「利用開始時刻の1分前はまだPENDING・1分後にはEXPIREDになる」
  テストに置き換え、当日PENDINGが利用開始後まで残らないことを直接検証
- `test/booking-logic.test.js`（更新） — 利用区分の内部値（`isAllowedCustomerType`/
  `customerTypeLabel`）、当日+初回利用の検出（`isSameDayFirstTimeBlocked`）、新規
  error.codeの日本語メッセージ・回復導線（`reselect-date`/`reselect-time`）、
  `buildCreateBookingPayload`への`customerType`追加を追加

Issue #271で追加・更新:

- `test/booking-mail-templates.test.js`（新規） — `BookingMailTemplates.gs`の純粋関数
  （件名・本文生成）。PENDING/CONFIRMEDに「未確定」/「確定」の明記・解錠コード/
  キーボックス番号を含まないこと、**CONFIRMEDに利用上の基本注意（原状回復の案内）が
  含まれること**、CANCELLEDの必須内容、REMINDERの来場案内一式（**入室方法を含む**）・
  ダミー秘密値の表示・秘密値未設定時のプレースホルダ、snb/mens/studio_xで表示名のみ
  変わることを検証
- `test/booking-mailer.test.js`（新規） — `BookingMailer.gs`の送信制御。PENDING/
  CONFIRMED/CANCELLED/REMINDERそれぞれについて、正常送信・SentAt記録・二重送信防止・
  status不一致時の拒否・MailApp失敗時の予約状態維持とlastMailError*/Recovery記録・
  設定不足のfail-closed拒否・force resend（SentAtありでも送信・status不一致は無視
  しない）・LockServiceの取得/解放を検証。**PRレビュー対応で追加**:
  `config.timezone`が実際にテンプレートへ渡り、JST 10:00の予約が本文でも10:00に
  なること・`TIMEZONE`をUTC等へ変更すると表示も追従すること・`TIMEZONE`が不正な
  文字列の場合はMailAppを呼ばずfail-closedに失敗すること、来場案内の必須項目
  （住所/建物/部屋/入口案内/キーボックス位置/入室方法/URL/キーボックス番号/解錠コード）
  が1項目ずつ欠けても送信しないこと、`ACCESS_GUIDE_PDF_URL`のみ任意で欠けても送信
  できること、メール送信失敗時に`RecoveryRepository`の`status`へメール種別
  （例: `REMINDER`）ではなく予約の現在status（例: `CONFIRMED`）が記録されることを検証。
  **PRレビュー対応（2回目）で追加**: MailApp例外にメールアドレスが含まれても
  `lastMailErrorMessage`/`Recovery.errorMessage`が`[REDACTED_EMAIL]`へ置換される
  こと、REMINDER失敗時に解錠コード/キーボックス番号の実値が例外文言に混入しても
  `[REDACTED]`へ置換されること、`BookingMailer.sanitizeErrorMessage`が公開関数として
  再利用できること
- `test/booking-reminders.test.js`（新規） — `BookingReminderTriggers.gs`。JST基準で
  翌日のCONFIRMED予約だけを抽出すること、PENDING/CANCELLED/EXPIREDは対象外、
  reminderSentAt/accessGuideSentAt済みはskip、1件の失敗（設定不足・MailApp例外）が
  他の予約の送信を妨げないこと（バッチ内の障害分離）、`createNextDayReminderTrigger`の
  トリガー二重作成防止を検証。**PRレビュー対応（2回目）で追加**: MailApp例外に
  利用者メールアドレスが含まれても、Loggerには`bookingId`と`error.code`のみが
  残り、メールアドレス・キーボックス番号・解錠コード・メール本文が残らないこと、
  `BookingMailer`側で想定外の例外が発生した場合もLoggerへ生のメールアドレスを
  残さないことを検証
- `test/booking-create-booking.test.js`・`test/booking-confirm-expire.test.js`
  （更新。**PRレビュー対応（2回目）で追加**） — `notifyCustomerPendingBestEffort_`/
  `notifyCustomerConfirmedBestEffort_`（`BookingRepository.gs`）でBookingMailerが
  想定外の例外を投げても、Loggerへ生のメールアドレスを残さないことを検証
- `test/booking-config.test.js`（更新。**PRレビュー対応で追加**） — `getMailConfig()`が
  `timezone`を含み既定値`Asia/Tokyo`になること、`TIMEZONE`上書きが
  `getAvailabilityConfig`/`getTtlConfig`と同じ値でmail configにも反映されること、
  `getAccessGuideConfig()`に`entryMethod`（`ACCESS_GUIDE_ENTRY_METHOD`）を含む
  全項目が正しく読めることを追加
- `test/booking-create-booking.test.js`（更新） — `createBooking`がbooking Lock解除後に
  利用者向けPENDINGメールをbest effortで送ること、メール設定不足時も`createBooking`は
  成功しlastMailError*が記録されること、管理者通知とPENDINGメールの両方が失敗しても
  `createBooking`は成功しRecoveryへ両方の`failureType`（`ADMIN_NOTIFICATION_FAILED`/
  `MAIL_PENDING_FAILED`）が記録されることを追加
- `test/booking-confirm-expire.test.js`（更新） — `FILES`へ`BookingMailTemplates.gs`/
  `BookingMailer.gs`/`BookingReminderTriggers.gs`を追加し、`confirmBooking`が
  利用者向けメールを試行するようになった後も既存の状態遷移・部分失敗補償・recovery件数の
  検証が壊れないよう、既定のScript Propertiesへ完全なメール設定値を追加（メール自体の
  挙動検証は`test/booking-mailer.test.js`に委ねる）
- `test/helpers/gas-stubs.js`（更新） — `MailApp.sendEmail`をオブジェクト引数形式
  （`{to, subject, body, name, replyTo}`）にも対応させ、`ScriptApp`の時間主導トリガー
  builderへ`everyDays`/`atHour`/`nearMinute`を追加（前日リマインドトリガー用）

Issue #272で追加・更新:

- `test/booking-cancel.test.js`（新規） — `cancelBookingAdmin`の統合テスト。
  状態遷移（PENDING/CONFIRMED→CANCELLED成功、EXPIREDからの拒否、
  `Booking.canTransition`がCONFIRMED→CANCELLEDを許可すること）、正常キャンセル
  （Calendar削除・Sheets CANCELLED・`cancelledAt`/`updatedAt`・同時間枠が
  `getAvailability`で再度空くこと・同時間での新規`createBooking`成功・キャンセルメール
  1通・`cancelMailSentAt`）、二重実行時の冪等性（Calendar再削除なし・`cancelledAt`
  上書きなし・メール二重送信なし）、キャンセルメール送信失敗時も`success:true`を維持し
  再実行でメールだけ再試行できること、Calendarイベントが既に存在しない場合の収束
  （`CANCEL_CALENDAR_EVENT_MISSING`・`calendarAlreadyMissing`）、Calendar削除失敗時の
  recovery記録、Calendar削除成功→Sheets更新失敗時のrecovery記録と再実行による収束、
  Sheets行が無い場合のCalendar診断（0/1/複数件それぞれの`failureType`と自動削除しない
  こと）、bookingId形式不正時の扱い、`confirmBooking`/`expirePendingBookings`との
  Lock共有・競合規則（cancel→confirmはINVALID_TRANSITION、expire→cancelは
  INVALID_TRANSITION、confirm→cancelは成功）、CANCELLED後は`sendNextDayReminders`が
  リマインドを送らないこと、Spreadsheet管理メニューのキャンセル導線
  （メニュー2項目・YES/NO確認・アクティブ行/prompt入力の両方）、snb/mens/studio_xの
  3ブランドで同一挙動になることを検証
- `test/booking-confirm-expire.test.js`（更新） — `Booking.gs`の`ALLOWED_TRANSITIONS`
  変更（CONFIRMEDを終端から除外）後も、既存のconfirm/expireの状態遷移・部分失敗補償・
  recovery件数の検証が壊れていないことを確認（既存テスト自体の変更は無し。
  `node --test`全件で回帰が無いことを担保）
- `test/helpers/gas-stubs.js`（更新） — `SpreadsheetApp.getUi()`スタブの
  `alert(message, buttonSet)`2引数形式を追加し、`options.alertResponses`から
  `Button.YES`/`Button.NO`を順番に返せるようにした（キャンセル誤操作防止の
  YES/NO確認ダイアログ用）。既存の1引数`alert(message)`呼び出しは影響を受けない
  （`Button`に`YES`/`NO`、`ButtonSet`に`YES_NO`を追加。既存の`OK`/`CANCEL`/`OK_CANCEL`は変更なし）

CalendarApp / PropertiesService / Utilities / ContentService / LockService /
CacheService / SpreadsheetApp / MailApp / ScriptApp はいずれもテスト用スタブに
差し替えており、実際のGoogle Calendar・Spreadsheet・Script Propertiesにはアクセスしない
（`test/helpers/gas-stubs.js`）。実Calendarへ直接書き込むテストは、通常の自動テストとして
実装していない（Issue #268本文の要件どおり）。

共通予約UIのDOM配線（`scripts/booking-app.js`）自体はnode --testの対象外で、
Playwright（Chromium）を使ったローカルブラウザでの手動確認で検証した
（3ブランドとも375px幅で横スクロールなし・ステップ遷移・`getAvailability`/
`createBooking`のモック応答に対するSLOT_CONFLICT/RATE_LIMITED/INTERNAL_ERROR等の
表示・二重送信防止・成功後の再送信不可を確認済み。実Calendar/Spreadsheetへは
アクセスしていない）。

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

Issue #269（3ブランド対応・共通予約UI）の追加確認:

- [ ] `scripts/booking-config.js`の`BASE_URL`を実際のBooking Web App URLへ差し替えること
      （3ブランド共通・この1ファイルのみでよい）
- [ ] `/booking/`（SNB） / `/mens/booking/`（SNB mens） / `/studio-x/booking/`（Studio X）
      それぞれから実際にPENDING予約を作成できること
- [ ] 3ブランドのbookingIdがそれぞれ`SNB-` / `MENS-` / `SX-`で始まること
- [ ] `Bookings`シートのbrand列・Calendarイベントのbrandタグに正しいbrandが保存されること
- [ ] いずれかのブランドで作った予約が、他の2ブランドの予約フォーム・
      `getAvailability`から見て塞がっていること（同一Calendarであることの実地確認）
- [ ] 完了画面で「まだ予約は確定していない」ことが明示されていること

Issue #270（当日利用ルールと利用経験判定）の追加確認:

- [ ] 共通予約UIで利用区分（初回利用/利用経験あり）を選択できること
- [ ] 初回利用＋当日で「空き時間を確認する」を押すと、`getAvailability`を呼ばずに
      理由（当日予約不可）が表示され、翌日以降の日付を選び直せること
- [ ] 利用経験あり＋当日は通常どおり空き時間が表示され、`createBooking`まで進めること
- [ ] 初回利用＋当日のペイロードでcreateBooking APIを直接呼んでも
      `SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`で拒否され、CalendarイベントもSheets行も
      作られないこと
- [ ] 利用経験あり＋当日で実際にPENDING予約を作成し、`Bookings`シートの
      `customerType`列に`returning`が保存されること
- [ ] 当日・利用開始まで2時間未満の予約が、作成直後にEXPIREDにならないこと
      （graceにより`expiry > createdAt`が保たれる）
- [ ] 当日・利用開始まで2時間未満の予約が、利用開始時刻を過ぎればEXPIREDになること
      （graceは利用開始時刻を上限とするため`expiry <= startAt`。利用開始後まで
      PENDINGが残らないことの実地確認。Calendarイベント削除・Sheets側`status`更新を含む）
- [ ] 翌日以降の通常予約のPENDING失効タイミングが、このIssue導入前と変わっていないこと
- [ ] `getAvailability`に当日の日付を指定した場合、現在時刻より前の開始時刻が
      候補に含まれないこと（現在時刻ちょうども除外）。翌日以降は現在時刻に関わらず
      従来どおり全候補が返ること
- [ ] 利用経験あり＋当日で、現在時刻以前の開始時刻を指定してcreateBooking APIを
      直接呼んでも`SAME_DAY_START_TIME_PASSED`で拒否され、CalendarイベントもSheets行も
      作られないこと
- [ ] 共通予約UIで、空き時間取得後に時間が経過し送信時点で開始時刻が過去になった場合、
      `SAME_DAY_START_TIME_PASSED`を受けてStep2（空き開始時刻）へ戻り、
      `getAvailability`が再取得されること

Issue #271（予約通知メール自動送信）の追加確認:

- [ ] Booking Web App / Booking Adminの両プロジェクトへ`BOOKING_MAIL_DISPLAY_NAME` /
      `BOOKING_MAIL_REPLY_TO` / `BOOKING_CONTACT_EMAIL`を設定し、Booking Admin側にのみ
      `ACCESS_GUIDE_*`一式（住所・建物・部屋・入口案内・キーボックス位置・入室方法
      `ACCESS_GUIDE_ENTRY_METHOD`・利用案内URL・秘密値の`ACCESS_GUIDE_KEYBOX_NUMBER`/
      `ACCESS_GUIDE_UNLOCK_CODE`を含む）を設定すること
- [ ] `TIMEZONE`を独自設定している場合、Booking Web App/Adminの両方に同じ値を設定し、
      メール本文の開始/終了時刻表示が実際の予約時刻（JST）と一致すること
- [ ] テスト予約でPENDINGを作成し、仮予約受付メールが1通だけ届くこと（「未確定」の
      明記・解錠コード/キーボックス番号を含まないことを含む）
- [ ] 管理者が`confirmBooking`で確定した際、確定メールが1通だけ届くこと（利用上の
      基本注意の文言を含む）。`confirmBooking`を再実行しても二重送信されないこと
- [ ] Booking Adminプロジェクトのスクリプトエディタから`createNextDayReminderTrigger`を
      実行し、毎日18時台に`sendNextDayReminders`が実際に1回動作すること
- [ ] 翌日にCONFIRMED予約がある状態で前日リマインドが1通だけ届き、来場方法（住所・
      建物・部屋・入口案内・キーボックス位置・入室方法・利用案内URL）・
      （設定していれば）解錠コードが正しく記載されていること
- [ ] 来場案内の必須項目（秘密値を含む）のいずれか1つでも未設定のまま前日リマインドの
      送信を試みると、送信されず`lastMailError*`に記録されること（fail-safeの実地確認）
- [ ] メール送信を意図的に失敗させても（例: 一時的にScript Propertiesを空にする）、
      予約自体（Calendar/Sheetsの`status`）が壊れず、`lastMailError*`に記録されること
- [ ] 「予約管理」メニューの「予約メールを再送（予約ID指定・強制再送）」から、
      設定不足解消後に実際にメールを再送できること
- [ ] 既存の管理者向け内部通知（`AdminNotifier.gs`。新しい予約が入ったことの通知）が
      このIssueの変更後も従来どおり届くこと

Issue #272（管理者キャンセルでCalendar / Sheetsを一貫更新する）の追加確認:

- [ ] 「予約管理」メニューに「アクティブ行のbookingIdをキャンセル（cancelBookingAdmin）」
      「bookingIdを入力してキャンセル（cancelBookingAdmin）」の2項目が表示されること
- [ ] PENDING予約に対してキャンセルを実行すると、YES/NO確認ダイアログが表示され、
      NOを選ぶと何も変更されないこと
- [ ] YESを選ぶと、対応するCalendarイベントが実際に**削除**され、`Bookings`シートの
      `status`が`CANCELLED`・`cancelledAt`/`updatedAt`が記録されること
- [ ] CONFIRMED予約に対しても同様にキャンセルできること（CONFIRMED→CANCELLED）
- [ ] キャンセル後、同じ日時が実際の共通予約UI（`getAvailability`）で再び候補として
      表示され、同じ時間帯で新しい予約を作成できること
- [ ] キャンセル完了後、利用者へキャンセルメールが1通だけ届くこと
      （`cancelMailSentAt`が記録されること）
- [ ] 同じbookingIdでもう一度キャンセルを実行すると「すでにキャンセル済みです」と
      表示され、Calendar操作もキャンセルメールの再送信も行われないこと
- [ ] Calendarイベントを手動で削除した状態でキャンセルを実行すると、「Calendarイベントは
      既に存在しなかったためRecoveryへ記録しました」と表示され、`Recovery`シートに
      `CANCEL_CALENDAR_EVENT_MISSING`が記録され、`Bookings`シートの`status`は
      `CANCELLED`へ進むこと
- [ ] EXPIRED予約に対してキャンセルを実行すると失敗し、Calendar/Sheets/メールの
      いずれも変更されないこと
- [ ] 既存の`confirmBooking`・`expirePendingBookings`が、この変更後も従来どおり
      動作すること（特にCONFIRMED→CANCELLED追加後もPENDING→CONFIRMED/EXPIREDの
      既存挙動が壊れていないこと）

Phase 0のゲート確認（スペースマーケットとの同一Calendar共存の実環境確認）は
Issue #267で完了（PASS, 2026-09-19）。確認手順・記録は
[`docs/phase0-issue267-spacemarket-coexistence.md`](../../docs/phase0-issue267-spacemarket-coexistence.md)
を参照。
