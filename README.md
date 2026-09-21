# Studio Nagoya Base

Studio Nagoya Base の静的サイト一式です。GitHub Pages で公開する前提の構成です。

公開 URL:
- 日本語トップ: `https://nagoya-base.github.io/Studio-nagoya-base/`
- 英語: `https://nagoya-base.github.io/Studio-nagoya-base/en.html`
- メンズ向け: `https://nagoya-base.github.io/Studio-nagoya-base/mens/`
- 緊縛・吊り床: `https://nagoya-base.github.io/Studio-nagoya-base/bondage/`
- Studio X: `https://nagoya-base.github.io/Studio-nagoya-base/studio-x/`

## ファイル構成

```
/
├── index.html          日本語トップページ
├── en.html             英語ページ
├── sitemap.xml         検索エンジン向けサイトマップ
├── robots.txt          クローラー向け設定
├── images/             画像ファイル一式（ギャラリー・OGP・ロゴ・ファビコン）
├── styles/             共通・ページ別 CSS
│   ├── common.css
│   ├── home.css
│   ├── en.css
│   ├── mens.css
│   ├── bondage.css
│   └── booking.css     共通予約UI（Issue #269）専用スタイル。3ブランド共通
├── scripts/
│   ├── main.js             共通 JavaScript
│   ├── booking-logic.js    共通予約UIのDOM非依存ロジック（node --testで検証）
│   ├── booking-app.js      共通予約UIのDOM配線・API呼び出し
│   └── booking-config.js   共通予約UIが呼ぶBooking Web AppのURL設定（3ブランド共通）
├── booking/
│   └── index.html      SNB（Studio Nagoya Base）の共通予約UI（仮予約フォーム）
├── mens/
│   ├── index.html      メンズ向けページ
│   └── booking/
│       └── index.html  SNB mensの共通予約UI（仮予約フォーム）
├── bondage/
│   └── index.html      緊縛・吊り床ページ
└── studio-x/
    ├── index.html          Studio X ページ
    ├── style.css           Studio X 専用スタイル
    ├── reservation/
    │   ├── index.html      Studio X 予約・撮影相談フォーム（Formspree・既存導線）
    │   ├── style.css       予約フォーム専用スタイル
    │   └── form.js         予約フォームのバリデーション・送信制御
    └── booking/
        └── index.html      Studio Xの共通予約UI（仮予約フォーム）
```

### 共通予約UI（Issue #269）について

`booking/` / `mens/booking/` / `studio-x/booking/` は、SNB / SNB mens / Studio X の
3ブランドが同じ予約基盤（`gas/booking/`のGAS Web App）へ接続する共通の仮予約フォームです。
3ページとも `_includes/booking_app_ja.html`（共通マークアップ）・
`scripts/booking-logic.js` / `scripts/booking-app.js`（共通ロジック）・
`styles/booking.css`（共通スタイル）をそのまま共有しており、ブランドごとの差分は
ブランド識別子・戻り先URL・案内文のみです。詳細は
[`gas/booking/README.md`](gas/booking/README.md) を参照してください。

**このIssue（#269）時点では、`studio-x/reservation/`（既存の予約・撮影相談フォーム）や
トップページの予約カレンダー導線は撤去していません。** 本番切替・旧導線撤去は`#273`の責務です。

### Issue #273: 本番切替・ロールバック（Stage A / Stage B）

`#273`は「コード切替準備」（Stage A）と「本番導入・実地確認」（Stage B）の2段階で進めます。

#### Stage A（このリポジトリのコード変更）

- 3ブランドの**直接予約**CTA（「空き確認・予約を申し込む」等）を、それぞれの共通予約UI
  （`/booking/` / `/mens/booking/` / `/studio-x/booking/`）へ切り替えた。
- 「利用内容を事前に相談する」「予約前に相談したい方」「撮影内容を相談する」「見学・下見」
  「当日利用の確認」など、**相談・下見・問い合わせ系の導線は旧フォームのまま**とした
  （`_includes/reservation_form_ja.html` / `studio-x/reservation/`）。
- 旧フォーム本体・Formspree送信先（`studio-x/reservation/`）はいずれも削除していない。
  問題があれば主要CTAのhrefを旧フォームへ戻すだけでロールバックできるよう、Stage Aの
  CTA切替・`BASE_URL`設定は1つのcutover commitへまとめている。
- `_includes/calendar_embed.html`（旧Calendar埋め込み）は削除していない。Stage Aの
  時点では3箇所（`index.html` / `mens/index.html` / `studio-x/reservation/index.html`）
  とも維持し、埋め込み直下に新しい予約ページへの案内文を追加した（後日、下記
  「Calendar embedの最終方針」のとおり通常公開導線からは撤去している）。
- 当日予約に関する古い文言（「ご予約は前日まで」「当日利用は会員のお客様に限り」等、
  `#270`と矛盾する記述）を、`#270`の仕様（初回利用は当日不可・利用経験があれば当日可・
  会員登録の有無では判定しない）に合わせて修正した。
- `scripts/booking-config.js`の`BASE_URL`は、Issue #267の実環境確認コメントに記録済みの
  既存Booking Web Appプロジェクトの本番`/exec` URLを設定した（新規デプロイはしていない）。

#### Stage B（オペレーターが実施。backend-first。**PR #282は、下記1〜5のbackend本番反映・
API ready確認が完了するまでmainへマージしない**）

> **重要（切替順序）**: `scripts/booking-config.js`の`BASE_URL`はStage AのPRに既に本番
> `/exec` URLが入っている。しかし、そのデプロイ先GASプロジェクトへ`#268`〜`#272`の最新
> コード（`createBooking`・#270の当日利用ルール・#271の通知メール等）が反映されている
> 保証はまだない。**先にPR #282をmainへマージしてGitHub Pagesで新CTAを公開してしまうと、
> バックエンドが未更新のまま一般利用者が新UIに接続できてしまう**（`getAvailability`は
> 動くが`createBooking`が未対応、等の中間状態）。これを避けるため、必ずbackendを
> readyにしてから、PRマージ（frontend公開）を行う順序で進める。

1. **（PRレビュー完了・mainマージ前）** Booking Web Appを、既存`/exec`のGASプロジェクトへ
   最新main（`#272`まで）の`gas/booking/`で本番反映する。新規GASプロジェクトは作らない
2. **（mainマージ前）** Booking Adminも同様に、既存GASプロジェクトへ最新mainで本番反映する
3. **（mainマージ前）** 両プロジェクトのScript Properties（`CALENDAR_ID` / `SPREADSHEET_ID` /
   `TIMEZONE`等）を確認する
4. **（mainマージ前）** `expirePendingBookings` / `sendNextDayReminders`のtriggerを確認する
   （重複作成しない。既存triggerがあれば新規作成しない）
5. **（mainマージ前）** 既存`/exec`を直接叩いて最小smoke testを行い、**API readyを確認する**
   （実予約作成は不要）:
   - `GET`で`getAvailability`が成功すること
   - `POST`で`createBooking`のendpointが存在し、安全な不正入力に対する想定どおりの
     validation errorを返すこと（関数として動作することの確認。実Calendarへの書き込みは
     まだ行わない）
   - この時点では一般サイトのCTAはまだ旧導線のまま（PR #282は未マージ）なので、利用者へ
     の影響はない
6. **API ready確認後、ここではじめてPR #282をmainへマージする**（frontendの新CTA公開は
   backendの動作確認が取れてから）
7. GitHub Pages側への反映を確認する（新UIが実際に公開され、旧フォーム・calendar embedも
   従来どおり表示されること）
8. 3ブランドのUI経由での実地受入テスト（専用テスト日時を使用。本予約・SpaceMarket予約は
   削除・変更しない）
9. ロールバック実地確認（新UI停止→旧フォーム復帰→再度新UIへ戻す。`#289`で実施、`#290`で
   新UIへロールフォワード確認済み）
10. 旧Calendar embedの最終方針を確定（下記「Calendar embedの最終方針」参照。通常公開導線
    からは撤去し、ロールバック資産としてファイルのみ保持する方針で確定）
11. 上記すべてが完了した時点で、Issue #273へ結果を記録し、`Closes #273`を付けたPRまたは
    cutover完了commitでclose

#### Calendar embedの最終方針（確定）

- 新予約UI（`/booking/` / `/mens/booking/` / `/studio-x/booking/`）を、通常時の**唯一の
  正式な空き確認・直接予約導線**とする
- `_includes/calendar_embed.html`を利用していた3箇所（`index.html` / `mens/index.html` /
  `studio-x/reservation/index.html`）は、通常公開導線からCalendar embedの表示を撤去した
- `_includes/calendar_embed.html`自体は削除せず、本番障害時のロールバック資産として
  リポジトリに残す（通常ページからはincludeしない）
- 旧予約フォーム（`_includes/reservation_form_ja.html` / `studio-x/reservation/`）は、
  相談・問い合わせ導線、および障害時ロールバック用として引き続き保持する
- ロールバック実地確認（`#289`）・ロールフォワード確認（`#290`）は完了済み

#### 本番導入チェックリスト（PR #282をmainへマージする前に、上記1〜6の完了として確認）

- [ ] Booking Web App `/exec` URLが本番想定のものであること（`/dev`でないこと）
- [ ] Booking Web App / Booking Adminの両方に、mainの`gas/booking/`最新版（`#272`まで）が
      反映されていること（**PR #282のマージより前に完了していること**）
- [ ] Script Propertiesが両プロジェクトで正しく設定されていること（実値はGitHubへ書かない）
- [ ] `expirePendingBookings` / `sendNextDayReminders`のtriggerが重複なく設定されていること
- [ ] 既存`/exec`への直接smoke testで、`getAvailability`が成功すること
- [ ] 既存`/exec`への直接smoke testで、`createBooking` endpointが存在し、想定どおりの
      validation errorを返すこと（＝API ready）
- [ ] 上記API ready確認が完了して**初めて**PR #282をmainへマージすること
- [ ] （マージ後）GitHub Pages側の反映・3ブランドとも新UIからの`getAvailability`疎通を確認
- [ ] SpaceMarket予約・既存自社予約の時間帯が空きとして出ないこと
- [ ] 旧Calendar埋め込みにPII（氏名・連絡先・解錠情報等）が表示されないこと
- [ ] ロールバック手順（CTAを旧フォームへ戻す）を実地確認済みであること

#### ロールバック手順（本番切替後に問題が発生した場合）

1. 3ブランドの直接予約CTAのhrefを、Stage Aのcutover commitをrevertして旧フォーム
   （`#reservation-form` / `studio-x/reservation/`）へ戻す
2. `scripts/booking-config.js`の`BASE_URL`を空文字へ戻す、または新UIへの主要CTAを
   一時的に非公開導線へ戻す
3. Calendar / Sheetsに既に作成済みの予約は削除・変更しない
4. Booking Adminの既存CONFIRMED/CANCELLED管理・通知メールはそのまま維持する
5. SpaceMarket側には一切変更を加えない
6. 旧Formspreeフォーム（Studio X）・旧`reservation_form_ja.html`フォームが送信可能な
   ままであることを確認する
7. `_includes/calendar_embed.html`はファイルとして保持されているため、必要であれば
   `index.html` / `mens/index.html` / `studio-x/reservation/index.html`へ
   `{% include calendar_embed.html %}`を再度追加することで表示を復元できる（Calendar
   embed最終方針により、通常運用では公開導線から撤去済みのため、CTA差し戻しだけでは
   自動的に復元されない）

## 編集ポイント

### 1. 日本語ページを編集する

`index.html` を編集します。

主な更新箇所:
- タイトルや説明文: `<head>` 内の `title` と `meta`
- ナビゲーション: `nav.site-nav`
- 料金、設備、アクセス、FAQ: 各 `section`
- ニュース: `#news`
- ギャラリー画像: `#gallery`
- 予約導線: `#calendar`

### 2. 英語ページを編集する

`en.html` を編集します。

日本語ページの内容変更に合わせて、必要な範囲で英語ページも更新してください。

### 3. サブページを編集する

| ページ | ファイル | 内容 |
|--------|----------|------|
| メンズ向け | `mens/index.html` | ユニフォーム×ロープ表現・男性向け撮影 |
| 緊縛・吊り床 | `bondage/index.html` | 緊縛・吊り床（高さ2350mm）対応スタジオ |
| Studio X | `studio-x/index.html` | カラー照明・無人レンタルスタジオ |

### 4. 画像を差し替える

画像ファイルは `images/` フォルダに配置し、HTML 内の `src` と `href` を差し替えます。

ギャラリーは画像クリックで元画像を開く仕様です。

### 5. OGP を更新する

OGP は SNS に URL を貼ったときのカード表示用メタ情報です。

更新対象ファイル:
- `index.html`
- `en.html`
- `mens/index.html`
- `bondage/index.html`
- `studio-x/index.html`

主な設定:
- `og:title`
- `og:description`
- `og:url`
- `og:image`
- `twitter:card`
- `twitter:image`

画像を差し替えた場合は `og:image` も合わせて更新してください。

### 6. 規約や料金を更新したとき

利用規約や料金表を更新した場合は、`index.html` のニュース欄にも必ず告知を追加してください。

対応の目安:
- 規約改定: 効力発生日の 14 日前までにニュース掲載
- 料金改定: 効力発生日の 30 日前までにニュース掲載

ニュースに入れる内容の例:
- 改定した内容の要点
- いつから有効か
- 詳細は `料金` または `利用規約` を確認する案内

## GitHub Pages 公開

このサイトは GitHub Pages での公開を前提にしています。

想定公開先:
- `nagoya-base/Studio-nagoya-base`

基本の流れ:
1. ローカルで HTML / CSS / 画像などを編集
2. 変更内容を確認
3. Git にコミット
4. GitHub に push
5. GitHub Pages 側で反映を確認

反映後の確認ポイント:
- 日本語ページが開く
- `EN` から `en.html` に遷移できる
- 各サブページ（mens / bondage / studio-x）が開く
- ギャラリー画像が表示される
- 画像クリックで元画像が開く
- OGP が正しい画像とタイトルで出る

## SEO / 多言語対応

設定済み内容:
- `canonical`
- `hreflang`
- `sitemap.xml`
- `robots.txt`

言語ページの対応:
- 日本語: `index.html`
- 英語: `en.html`

新しい言語ページを増やす場合は、各ページの `hreflang` と `sitemap.xml` も更新してください。

## 更新時のチェックリスト

- 規約や料金を更新した場合、ニュース欄にも告知を追加したか
- 文言変更が日本語ページと英語ページでずれていないか
- 画像ファイルが `images/` フォルダに配置されているか
- 画像ファイル名に誤りがないか
- OGP の URL と画像が実在するか
- `sitemap.xml` の URL が最新か
- 外部リンクや予約導線が正しいか
- 新しいページを追加した場合、ナビゲーション・フッター・`sitemap.xml` も更新したか

## アクセス数の計測（Google Analytics 4）

各ページに Google Analytics 4 (GA4) のトラッキングコードを設定済みです（測定 ID: `G-6TWDLEFWJT`）。

[GA4 管理画面](https://analytics.google.com/) の「レポート」→「リアルタイム」でアクセスを確認できます。

測定 ID を変更する場合は、以下のファイルの `G-6TWDLEFWJT` をすべて置き換えてください:
- `index.html` / `en.html` / `mens/index.html`
- `how-to/index.html` / `how-to/en.html` / `mens/how-to/index.html`
- `legal/index.html` / `legal/en.html` / `mens/legal/index.html`（`_includes/legal_ja.html` 経由で共通化）
- `studio-x/index.html` / `studio-x/legal/index.html` / `studio-x/reservation/index.html`
- `archive/index.html` / `archive/how-to/index.html`

### 確認できる主な指標

- **ページビュー数**：各ページへのアクセス数
- **ユーザー数**：サイトへの訪問者数（実訪問者）
- **セッション数**：訪問回数
- **流入元**：検索エンジン / SNS / 直接アクセス などの内訳
- **デバイス**：スマートフォン / PC / タブレットの比率
- **地域**：アクセス元の地域情報

### 成果イベント（キーイベント）

計測しているイベントは「成果イベント」と「分析用イベント」に分かれます。
3リポジトリ（snb-community / Studio-nagoya-base / ataru-nagoya）共通のイベント
設計に統一しています。新規にイベント名を追加する場合は、共通設計から外れて
いないか確認してください。

#### GA4 管理画面でキーイベントとして ON にするもの

| イベント名 | 発火条件 |
| --- | --- |
| `generate_lead`（`lead_type: studio_reservation`） | Studio本体の予約申込フォームの POST が**成功した時だけ** 1 回 |
| `generate_lead`（`lead_type: studio_x_reservation` / `studio_x_consultation`） | Studio Xの予約・撮影相談フォームの POST が成功した時だけ 1 回 |

設定手順：GA4 管理画面 →「管理」→「データの表示」→「イベント」→ 一覧から
`generate_lead` を探し、「キーイベントとしてマークを付ける」を ON にします。
イベントが一覧に出てくるのは、実際に 1 回以上計測された後です（最大 24 時間程度）。
予約の種別は `lead_type` パラメータで区別するため、レポート側でセグメントして
ください。

`generate_lead` はコード上 `scripts/analytics.js` の `StudioAnalytics.trackGenerateLead()`、
`studio-x/analytics.js` の `StudioXAnalytics.trackGenerateLead()` からのみ送信され、
以下では発火しません。

- 送信ボタンを押しただけの時
- 入力内容にバリデーションエラーがある時
- 送信は試みたがサーバー・通信エラーで失敗した時（`form_error` を送信）

二重計測は、送信操作ごとに採番するトークンで防いでいます。以前は POST 成功時に
`reservation_submit` と `reservation_request_complete` の両方を発火しており、
1件の申込を二重に計上していました。`generate_lead` 1本に統一し解消しています。

#### 実装していない成果イベント

| イベント名 | 実装しない理由 |
| --- | --- |
| `entry_complete` | 完了ページが存在しない。フォーム送信は「申込」であり、当方からの確定連絡をもって成立となるため、サイト側で完了を判定できない |

将来、予約確定を通知する完了ページを追加した場合に、はじめてこのイベントを
実装してください。

#### 使用してよいイベント名（これ以外を新規に作らない）

`page_view` / `scroll` / `section_view` / `cta_click` / `faq_open` /
`form_start` / `form_error` / `generate_lead` / `booking_platform_click` /
`outbound_contact_click`

このうち成果イベントは `generate_lead`（主成果）と `booking_platform_click` /
`outbound_contact_click`（補助成果）。他はすべて分析用イベントで、キーイベント
には設定しない。

`outbound_contact_click` は現在、問い合わせ・予約導線をフォームへ一元化した
ため発火箇所がありません。メール・X DM等の外部連絡手段を新設する場合にのみ、
`channel` パラメータとあわせて再度使用してください。

#### 共通パラメータ

個人情報（氏名・メールアドレス・電話番号・希望日時・自由記述）は一切送信しません。
送信するのはカテゴリ値のみです。

- `site_brand`：`studio` 固定
- `site_section`：`studio_main` / `mens` / `studio_x`
- `page_type`：`<body data-page-type>` の値（`top` / `guide` / `policy` など）
- `form_name`：`studio_reservation` / `studio_x_reservation` / `reservation_form_en`
- `provider`：`stripe`（`booking_platform_click`）

### 発火確認の手順

1. 確認したいページを `?debug_mode=true` 付きで開きます
   （例：`https://nagoya-base.github.io/Studio-nagoya-base/?debug_mode=true`）
2. ブラウザの開発者ツールのコンソールを開きます。`[Analytics]` から始まるログに
   イベント名とパラメータが出力されます
3. GA4 管理画面 →「管理」→「DebugView」を開くと、同じイベントがリアルタイムで
   表示されます
4. `generate_lead` の確認は、フォームを実際に送信して成功メッセージが
   表示されることまで確認してください。バリデーションエラーの状態で送信ボタンを
   押しても発火しないことも合わせて確認します

`file://` での直接表示と `localhost` では、誤計測を防ぐため送信されません
（`?debug_mode=true` を付けた場合を除く）。

## メモ

- このリポジトリはビルド不要の静的 HTML サイトです
- CSS は `styles/` フォルダに、JavaScript は `scripts/main.js` に分離されています（Studio X は `studio-x/style.css` を使用）
- 画像は `images/` フォルダにまとめて管理しています（Studio X サブページの画像を除く）
- 新しいページを追加した場合は、ナビゲーション・フッター導線・GA4 トラッキングコードも合わせて追加してください
