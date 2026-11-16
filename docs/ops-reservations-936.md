# 運営アプリ 段階1「予約一覧・詳細」（読み取り専用）調査・設計・運用メモ（Issue #936）

**正本は Issue #936（親 #935）。** 本書は調査結果と実装の説明であり、デプロイ・Script Properties設定・本番接続・公開は**行っていません**（マージ＝本番反映ではありません）。実在の予約・個人情報・秘密値は記載していません。

## 0. 位置づけ（完了判定）

#936「フロントエンドとバックエンドの責務」に従い、段階1を3つに分けて記録します。**片方だけで段階1全体を完了としません。**

| 区分 | 状態 | 場所 |
| --- | --- | --- |
| ① バックエンド単体（共通契約・台帳アダプター・検証/正規化・認可と拒否テスト） | **本PRで実装・自動テスト済み**（実データ・実デプロイでは未検証） | `gas/ops-reservations/` |
| ② フロントエンド（Sites向け画面ロジック）のモック検証 | **本PRで実装・自動テスト済み**。**モック（架空）のみ**。実バックエンド未接続 | `_ops-app/frontend/` |
| ③ 結合（採用した認証付き経路で、所有者の閲覧成功・非所有者の拒否・失敗/未接続表示を実環境で確認） | **未実施**（Sites→バックエンドの接続方式が未確定。§7） | — |

- `gas/ops-reservations/OpsPage.html` は **GASバックエンド検証用の最小画面**であり、Sitesフロントではありません（Sitesフロント完成の代替にしない）。`google.script.run` を使うのはこのGAS専用アダプターだけです。
- 実データ接続・公開・設定変更・デプロイは**未実施**。既存の予約・決済・Access GAS・本番設定は変更していません。

## 1. 調査結果（確認済み事実／未確認／提案）

### 確認済み事実（コードで確認。**本番の観測ではない**）
| 項目 | 事実 | 根拠 |
| --- | --- | --- |
| 読み取り元 | 予約台帳は `Bookings` シート。列定義の正本は `BookingsSchema.HEADERS`（予約ID=`bookingId`、利用日=`date`、開始/終了=`startAt`/`endAt`、状態=`status`、ブランド=`brand` ほか） | `gas/booking/shared/BookingsSchema.gs` |
| 予約状態 | コード上の定義は `PENDING` / `CONFIRMED` / `CANCELLED` / `EXPIRED` | `gas/booking/shared/Booking.gs` の `STATUS` |
| コード上で定義されたブランド値 | 予約作成を許可するブランドは `snb` / `mens` / `studio_x`（`ALLOWED_BOOKING_BRANDS`）。予約作成時に検証され（`isAllowedBrand`→不許可は `INVALID_BRAND`）、`brand` 列へ書き込まれる。表示名は `BRAND_LABELS_`（`SNB` / `SNB mens` / `Studio X`） | `gas/booking/shared/Booking.gs`（`ALLOWED_BOOKING_BRANDS`、`isAllowedBrand`、予約レコード生成） |
| `PER_BOOKING_CODE_BRANDS_` の位置づけ | 名称・用途とも**予約ごとの鍵（暗証番号）発行の対象ブランド定義**であり、予約のブランド正本としては使わない。ブランド区分の根拠は `Booking.ALLOWED_BOOKING_BRANDS` | `gas/booking/shared/Config.gs`（`resolveAccessCodeDelivery` 周辺のコメント） |
| 過去データの扱いの差 | 既存の予約処理は「brandが空・未知の過去データはSNBとして扱う（後方互換）」（`getBrandProfile`）。**本アプリは #936 の要件に従い、空・未知は「未分類」とし、SNBへ丸めない**（元の値を詳細に表示）。両者の扱いの違いは意図的 | `Booking.gs`（`getBrandProfile` のコメント）、#936 |
| 日付型の揺れ | `date` 等はシートの書式によりDate値または文字列で読まれる。JST（`Asia/Tokyo`）で扱う | `SpreadsheetRepository.gs`（`normalizeBookingDateForComparison_`）、`BookingAdminWeb.gs` |
| 既存の一覧取得 | Booking Adminが `getAdminBookings()` を持つ。同一プロジェクトに確定/取消などの**変更操作**（`adminConfirmBooking` 等）が同居しているため、新アプリへは持ち込まない | `gas/booking/admin/BookingAdminWeb.gs` |
| 既存Adminの認証 | Web App「自分のみ」（Execute as: Me / Only myself） | 同ファイル冒頭コメント |
| 読み取り専用での台帳アクセス | `SpreadsheetApp.openById` は `spreadsheets`（書込み可）スコープが必要。読み取り専用は Sheets API v4 の GET＋`ScriptApp.getOAuthToken()` の先例がある | `gas/switchbot-access/AccessLedgerReader.gs` |
| #864（一覧性能・クローズ済み） | Booking Adminの一覧は全件取得→全行変換の設計で、設定読み込みのN+1が第一候補だった。本アプリは既存Adminを改変せず、許可列のみを列単位で取得し、台帳を1回で読み切る。**行数上限（20,000）を超えたら切り捨てず停止**。実測性能は未計測 | Issue #864 |
| #930（スマホ表示・クローズ済み） | 既存Adminのモバイル向けUI改善（表示切替トグルの収納、44px以上の操作領域、`aria-expanded`等）。本アプリでも操作領域44px以上・横はみ出しなしを踏襲。既存Adminは改変しない | Issue #930 |

### 未確認
- 本番Bookingsの実際の列順・書式・行数・ブランド値の実在分布（本番を読んでいない）。
- Community の台帳の所在と構造（別リポジトリ側）。段階1では**未接続**と明示する。
- 「Sites」の具体的な実行基盤・認証方式・公開機能（§7）。
- 実測の取得時間・上限（20,000行）の妥当性。

## 2. バックエンド仕様

### 認可
- 認証器（`OpsAuth.gs`）は**サーバーが検証した利用者本人**だけを判定材料にする（ブラウザーが申告したメール・パラメーター・ヘッダーは使わない。テストで確認）。全要求で毎回実行し、拒否時は台帳へアクセスしない。
- 本人を確認できない（空・取得例外）→ `UNAUTHENTICATED`。本人は確認できたが所有者でない／所有者設定（`OPS_OWNER_EMAIL`）が無い → `FORBIDDEN`（fail-closed）。
- 現在の認証器は `Session.getActiveUser()` と `OPS_OWNER_EMAIL` の照合（GAS Web App「自分のみ」用）。デプロイ制限（Only myself）とアプリの認可は**別の層**で、それぞれ別に確認する（デプロイ設定は運営者作業のため未確認。アプリの認可は拒否テスト済み）。他の認証器（§7案B）は同じ形で追加できる。
- **所有者本人でのアクセス成功は未検証**（未デプロイのため）。

### 台帳読み取り（許可列をSheets APIの要求範囲で限定）
1. 見出し行（1行目）だけを取得（列名のみ。データではない）。
2. **元の見出しの段階で、許可項目の列名の重複を検出**し、`SCHEMA_DUPLICATE` で停止（どの列が正かを判断しない）。必須列（`bookingId`・`date`・`startAt`・`brand`・`status`）が無ければ `SCHEMA_MISMATCH`。列順は名前で対応づけるため、列順変更でも同じ結果。
3. **許可列だけ**を列単位（`values:batchGet`）で取得する。メール・電話・備考・決済トークン・Stripe ID・カレンダーID・メール送信エラー文は、データとして取得しない（「取得後に削除」ではなく要求範囲で除外。テストで検証）。
- 外部アクセスは Sheets API v4 の GET のみ。スコープ: `spreadsheets.readonly` / `script.external_request` / `userinfo.email`。

### 検証・正規化
- 予約IDは台帳の値を保持し再採番しない。空欄・重複（不正な行と同じIDも含む）・不正日付・開始不正は一覧/詳細から除外し、「確認が必要な行」に行番号と理由を返す（生の行データは返さない）。詳細では重複IDを `DUPLICATE_ID`、不存在を `NOT_FOUND` と区別する。
- サービス対応: `snb→SNB`、`studio_x→Studio X`、`mens→SNB Mens`、`snb_community→SNB Community（未接続）`、その他→「未分類」。
- 値: `0`（数値）と空欄（未入力）を区別。元データで区別できない値は推測で補完しない。終了が開始以前でも**翌日へ補正せず警告**（同日逆転=`end_before_start`、同時刻=`end_equals_start`）。日またぎは、終了が完全な日時（翌日）で入っている場合のみ正式に扱う。

### 期間・並び順・当日の分類（JST）
- **期間の始端**=`from` の 0:00（含む）、**終端**=`to` の翌日 0:00（含まない）。既定は「今日から30日間」（今日0:00〜30日後0:00）。過去は「昨日までの30日間」。
- 予約の時間帯 `[開始, 終了)` が期間と**重なれば**対象にする（日付ではなく時間帯で判定）。したがって:
  - 日付またぎ予約（前日夜〜当日未明）は、当日が期間に入っていれば表示される（前日側の期間にも表示される）。
  - 当日に終了済みの予約・利用中の予約も、当日を含む期間では表示される。
  - 終了がちょうど 0:00 の予約は、その日には含めない。終了が空欄・開始以前（不整合）の予約は、開始時刻の一点として判定する（終了を推測しない）。
- 各予約に **`phase`**（現在時刻に対する分類）を付ける: `upcoming`（開始前）/ `in_progress`（利用中）/ `ended`（終了済み）/ `unknown`（開始済みだが終了不明）。
- 並び順: 今後=開始の昇順、過去=降順。同時刻は終了→予約IDで安定。取消・失効も削除せず状態を明示。
- 台帳は1回で全件読み切る（部分取得を全件と誤表示しない）。

## 3. ファイル構成
| 場所 | 役割 |
| --- | --- |
| `gas/ops-reservations/OpsContract.gs` | 共通契約（サービス区分・JST日時・エラーコード・契約バージョン） |
| `OpsNormalizer.gs` / `OpsQuery.gs` / `OpsSource.gs` | 検証・正規化／絞り込み・並び順・フェーズ・項目射影／台帳アダプター（Sheets API GETのみ） |
| `OpsAuth.gs` / `OpsApi.gs` | 認証器／通信方式に依存しない入口 `OpsApi.handle(request, ctx)`。GAS専用の入口（`doGet`・`opsListReservations`・`opsGetReservation`）は末尾の薄いアダプター |
| `OpsPage.html` | GASバックエンド**検証用**の最小画面（共通契約の応答をそのまま表示。Sitesフロントではない） |
| `_ops-app/frontend/ops-client.js` | フロント画面ロジック。契約アダプター `{list, detail}` だけに依存（GAS・Sheets・SwitchBotへ直接接続しない・秘密を持たない） |
| `_ops-app/frontend/mock-adapter.js` / `index.html` | **架空データ**のモックアダプターとモック画面（`?scenario=ok\|empty\|error\|not_connected\|denied\|flaky`） |
| `test/ops-reservations.test.js` / `test/ops-frontend.test.js` / `test/helpers/ops-contract.js` | バックエンド単体／フロント（モック）＋契約適合／契約の検証関数 |

## 4. 運営者が行う作業（未実施・本PRに含まない）
**接続方式（§7）の採否が決まるまで、デプロイしない。**
1. 新規のスタンドアロンGASプロジェクトを作成し、`gas/ops-reservations/` のファイルを配置（自動デプロイ用のworkflowは追加していない）。
2. Script Properties: `OPS_OWNER_EMAIL`（所有者のGoogleアカウント）、`OPS_SPREADSHEET_ID`（予約台帳のID。リポジトリには置かない）。
3. Web Appとしてデプロイ（Execute as: Me／Who has access: Only myself）し、読み取り専用スコープを承認。**この設定だけでは外部のSitesから呼べない**（§7）。
4. 実データでの所有者アクセス成功・非所有者の拒否を確認（実データはリポジトリ・Issue・PRに貼らない）。

## 5. 検証と制約
- `node --test test/ops-reservations.test.js test/ops-frontend.test.js`（架空データ）: 境界日・JST日付境界・期間の重なり（日付またぎ・当日終了済み・利用中・0:00終了）・同時刻の並び・0件・未知サービス/状態・ID空欄/重複（不正行との組み合わせ含む）・重複ヘッダー・列順変更・認可（本人確認不能/不一致/所有者未設定/申告値の無視）・認可失敗時に台帳へアクセスしない・取得失敗/シート無し/列不足/行数超過/タイムゾーン未対応・Community未接続と正常0件の区別・応答競合・再取得時の詳細更新・XSS・0と未入力・読み取り専用の静的検査・フロントのGAS/外部システム非依存・既存workflow/Booking配布表/公開サイトへの非混在・**バックエンド実応答とモック応答が同じ契約検証を通ること**。
- 制約: 本番Bookingsの実データでの動作は未確認。Communityは未接続。メール/電話/備考は非表示（段階1では追加必須としない）。端末への保存なし。ログは件数と固定コードのみ。
- **公開経路の分離**: フロント（モック画面を含む）は `_ops-app/frontend/` に置く。`_` 始まりのディレクトリは既存のGitHub Pagesビルド（Jekyll）が標準で除外するため、既存の設定・workflowを変更せずに公開物へ含まれない（実ビルドの生成物にモックHTML/JSが無いことを手動と自動テストで確認）。Sites用の成果物は、この配置から独立して用意する（未実施）。なお `gas/` 配下のバックエンドのソース（`OpsPage.html` を含む）は、既存の `gas/booking/` 等と同様にリポジトリのファイルとして配信対象に含まれる（データ・秘密は含まない。GAS用のため単独では動作しない）。

## 6. 共通接続契約（通信方式に依存しない）
`google.script.run` を共通契約にしない。通信方式固有の処理はアダプターに閉じ込める（GAS: `OpsPage.html` / `opsListReservations` 等、フロント: `{list, detail}` アダプター）。契約の機械的な検証は `test/helpers/ops-contract.js`。

- **一覧要求**: `{ op:'list', params:{ service, status, scope, from, to } }`（`service`=`all|snb|studio_x|snb_mens|snb_community|unclassified`、`status`=`all|PENDING|CONFIRMED|CANCELLED|EXPIRED|UNKNOWN`、`scope`=`upcoming|past`、`from`/`to`=`YYYY-MM-DD`）。
- **一覧応答**: `{ ok, contractVersion, fetchedAt, todayJst, applied{scope,service,status,from,to,order}, complete, counts{sheetRows,valid,matched,issues}, serviceStates[{service,label,state}], notConnectedSelected, items[], issues[{row,bookingId,severity,reasons}] }`。`items[]`=`{bookingId, service, serviceLabel, status, statusLabel, date, startAt, endAt, phase, name, people}`。
- **詳細要求**: `{ op:'detail', id }`（正本の予約ID）。**詳細応答**: `{ ok, contractVersion, fetchedAt, reservation }`（許可項目のみ。シート全列は返さない）。
- **日時**: `startAt`/`endAt`/`fetchedAt`/作成・更新・確定等は**タイムゾーン付きISO 8601（日本時間 `+09:00`）**。`date`（利用日）は日付のみ（`YYYY-MM-DD`）で別項目。表示は日本時間に固定（フロントは端末のタイムゾーンに依存しない）。`0`と`null`（未入力）は区別する。
- **エラー**: `{ ok:false, error:{ code, message } }`。`code` は固定: `UNAUTHENTICATED` / `FORBIDDEN`（認証・認可失敗）、`NOT_CONNECTED`（未接続）、`FETCH_FAILED` / `SHEET_NOT_FOUND` / `TOO_LARGE` / `TIMEZONE_UNSUPPORTED`（取得失敗）、`SCHEMA_MISMATCH` / `SCHEMA_DUPLICATE`（スキーマ不整合）、`INVALID_PARAMS`（不正条件）、`NOT_FOUND` / `DUPLICATE_ID`（詳細: 不存在／ID重複）。メッセージに秘密・生の行データ・内部情報は含めない。
- **認証の伝達とサーバー検証**: フロントが認証画面/セッションを担当してよいが、所有者かどうかの最終判定はバックエンドが毎回行う（フロントの申告は使わない）。

## 7. Sites→バックエンドの認証付き接続方式の調査（**未確定・未検証**）
**結論: 「Only myself」でデプロイしたGAS URLを用意しただけでは、外部のSitesフロントから呼べると仮定できない。採用方式は未確定。**

### 根拠と限界
- マニフェストの `access: MYSELF` は、デプロイしたユーザー本人だけが実行できる設定（[Apps Script マニフェスト](https://developers.google.com/apps-script/manifest/web-app-api-executable)）。`Session.getActiveUser()` は、認可モードが `AuthMode.FULL` 以外ではエラーになる場合がある（[Troubleshooting](https://developers.google.com/apps-script/guides/support/troubleshooting)）。「Only myself」＋`USER_DEPLOYING` で `getActiveUser().getEmail()` が常に得られるかを一つに確認できる公式ページは見つけられなかった（**要・実機確認**）。
- 他オリジンのブラウザーからGAS Webアプリを呼ぶ場合、`doOptions` はプリフライトで実行されず、GAS側でCORSヘッダーを設定する手段が無い、という報告が多数ある（コミュニティ情報。公式文書ではない。[例](https://groups.google.com/g/google-apps-script-community/c/zJpevovcFLA)、[Stack Overflow ミラー](https://kaweah.freedombox.rocks/kiwix/content/stackoverflow.com_en_all_2023-11/questions/56502086/google-app-script-web-app-get-and-post-request-blocked-by-cors-policy)）。プリフライトを避ける `text/plain` のPOSTでもモバイルChromeでCORSエラーになった報告があり、確実ではない。
- 「Only myself」はGoogleのログインが必要で、未ログインの他オリジンからの `fetch` はログイン画面へのリダイレクトになるため、Sitesからの直接呼び出しは成立しない可能性が高い（**未検証**）。

### 候補（いずれも未検証・未採用。未検証の基盤は増設しない）
| 案 | 概要 | 認証/所有者限定 | 主な懸念 |
| --- | --- | --- | --- |
| A | GAS検証画面と同じGoogle認証コンテキストでフロントを提供（GAS HtmlServiceでフロントを配信、またはiframe埋め込み） | Google認証＋`Session`（現行の認証器そのまま） | 「Sitesフロント」との関係が変わる（Sitesでの提供ではなくなる）。iframe埋め込みの可否（X-Frame-Options）も要確認 |
| B | フロントがGoogleのIDトークンを取得し、バックエンドがサーバー側でトークンを検証して所有者を判定（Web Appは匿名到達可能になり、全要求でトークン検証。`UNAUTHENTICATED`/`FORBIDDEN`） | 検証可能な利用者情報（IDトークン、`aud`・有効期限・メール確認済み・所有者一致をサーバー検証） | 匿名到達可能なエンドポイントが増える。上記のCORS/リダイレクトの制約。認証器は `OpsAuth` と同じ形で追加できる（未実装） |
| C | 認証付きの中継（既存の Cloud Run 運用の先例あり）経由でバックエンドを呼ぶ | 中継側で認証、バックエンドは中継の資格情報を検証 | 新規インフラの増設・運用が必要（未検証の基盤を無断で増設しないため未提案のまま） |

次の一手: 案A/Bの最小PoC（デプロイが必要なため運営者の承認が必要）で、(1) Sitesの実行基盤の確認、(2) 認証・セッション伝達、(3) CORS/リダイレクト、(4) 所有者限定の成立、を実機で確認する。それまで結合（③）は未実施として扱う。
