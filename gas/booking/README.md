# gas/booking（自社予約システム・Phase 0: getAvailability）

Issue #266（Epic #265の子Issue）で追加する、**読み取り専用**の空き判定API。

このディレクトリは自社予約システム専用のApps Scriptプロジェクトとして運用し、
`gas/ataru_survey_public` 等の既存GASプロジェクトとは完全に分離する
（互いのコードを参照・importしない）。

## このIssue（#266）で実装した範囲

- `getAvailability`（GET専用。`doGet`経由）
  - 指定日・利用時間・brandを受け取り、予約可能な開始時刻の一覧を返す
  - Google Calendarを空き判定の正として、対象日のイベントを一括取得しメモリ上で判定する
  - SNB / mens / Studio Xは同一室のため、brandでロジックを分岐しない

## このIssueで実装していないもの（非対象）

- `createBooking`（予約作成・書き込み）
- 利用者情報の入力・Spreadsheet保存
- 料金計算・会員判定・キャンセル・決済
- 既存の予約フォーム（`studio-x/reservation/`）や `_includes/calendar_embed.html` の変更・撤去

## 固定仕様

| 項目 | 値 |
| --- | --- |
| 営業時間 | 08:00〜23:00 |
| 最低利用時間 | 120分 |
| 開始時刻の刻み | 15分 |
| 予約同士の間隔（マージン） | 15分以上 |
| 営業開始・終業の前後マージン | 不要（08:00開始可・23:00終了可） |
| タイムゾーン | Asia/Tokyo |
| 終日イベント | 空き枠を占有しない（メモ用途。終日ブロックしたい場合は08:00〜23:00の時間指定イベントを使う） |

これらの値はScript Propertiesで上書き可能だが、デフォルト値としてIssue #265/#266の
固定仕様をそのまま埋め込んでいる（`Config.gs`）。

## ファイル構成

- `Code.gs` — Web Appエントリポイント。`doGet` が `getAvailability` を提供する
- `Availability.gs` — 空き判定ロジック本体。CalendarApp等のGAS組み込みサービスに
  一切依存しない純粋なロジックのみを置き、vmで直接テストできるようにしている
- `CalendarRepository.gs` — Google Calendarからの読み取り専用アクセス。対象日のイベントを
  1回のAPI呼び出しでまとめて取得し、当日00:00からの経過分（分単位）へ変換する
- `Config.gs` — Script Propertiesの読み出しと固定仕様のデフォルト値
- `appsscript.json` — マニフェスト（Web Appアクセス設定を含む）

## Script Properties

| プロパティ名 | 必須 | 内容 |
| --- | --- | --- |
| `CALENDAR_ID` | ○ | 空き判定・予約の正とするGoogle Calendarのカレンダーid |
| `TIMEZONE` | - | 省略時 `Asia/Tokyo` |
| `OPEN_TIME` | - | 省略時 `08:00` |
| `CLOSE_TIME` | - | 省略時 `23:00` |
| `MIN_BOOKING_MINUTES` | - | 省略時 `120` |
| `BUFFER_MINUTES` | - | 省略時 `15`（予約間マージン） |
| `SLOT_STEP_MINUTES` | - | 省略時 `15`（開始時刻の刻み） |

フロントエンド（今後実装予定の共通予約UI等）はCalendar IDを一切知らない。

## API仕様

### `GET ?date=YYYY-MM-DD&durationMinutes=120&brand=studio_x`

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

`bookableStartTimes` は当日の予約可能な開始時刻（`HH:mm`）のみ。
イベントタイトル・説明・参加者・氏名・メール等のPIIは一切返さない。

入力エラー時：

```json
{ "success": false, "error": { "code": "INVALID_DATE", "message": "..." } }
```

`error.code` は `INVALID_DATE` / `INVALID_DURATION` / `DURATION_TOO_SHORT` / `INVALID_CONFIG` のいずれか。

`durationMinutes` が営業時間の幅（デフォルトでは900分）を超える場合はエラーにはせず、
`bookableStartTimes: []`（空き枠0件）を返す。

## デプロイ設定

- **実行ユーザー（Execute as）**: Me（自分）
- **アクセスできるユーザー（Who has access）**: Anyone（匿名を含む全員。読み取り専用のため）

## セットアップ手順

1. 新規のGoogle Apps Scriptプロジェクトを作成し、このディレクトリ配下のファイル
   （`Code.gs`, `Availability.gs`, `CalendarRepository.gs`, `Config.gs`, `appsscript.json`）
   をコピーする。
2. 上記のScript Propertiesを設定する（最低限 `CALENDAR_ID`）。
3. Webアプリとして新規デプロイし、上記の「デプロイ設定」の通りに設定する。
4. デプロイ後のWeb App URLは、本Issueでは既存フォーム・既存サイトのどこからも
   参照しない（#268以降の共通予約UI実装時に接続する）。

## テストの実行

```
node --test
```

- `test/booking-availability.test.js` — `Availability.gs` の空き判定ロジック
  （Issue #266の受入条件・テスト観点を1:1でカバー）
- `test/booking-calendar-repository.test.js` — `CalendarRepository.gs` の
  Calendarイベント→占有区間変換（終日イベント・日またぎイベントのクランプ等）
- `test/booking-config.test.js` — `Config.gs` のデフォルト値・Script Properties上書き
- `test/booking-code-runtime.test.js` — 4ファイルをまとめてvm実行し、`doGet` の
  配線全体（レスポンス形式・PII非露出・入力検証の順序）を検証

CalendarApp / PropertiesService / Utilities / ContentService はいずれもテスト用スタブに
差し替えており、実際のGoogle Calendar・Script Propertiesにはアクセスしない
（`test/helpers/gas-stubs.js`）。

## デプロイ後の手動確認（実Calendar・実デプロイが前提のため、コードレビュー時点では確認不能）

- [ ] Web Appが「Anyone」設定で、ログインなしでも `GET` できること
- [ ] 実際のCalendarに入っている予定（時間指定・終日・スペースマーケット由来・管理者手入力）に対して、
      想定通りに空き/不可が判定されること
- [ ] レスポンスにイベントタイトル・参加者等のPIIが含まれていないこと
- [ ] 既存の `_includes/calendar_embed.html` および `studio-x/reservation/` の予約フォームが
      これまで通り動作すること（本Issueでは一切変更していない）

Phase 0のゲート確認（スペースマーケットとの同一Calendar共存の実環境確認）はIssue #267で行う。
#267がPASSするまで、#268（仮予約createBooking）には着手しない。
