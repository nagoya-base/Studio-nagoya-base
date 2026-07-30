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
│   └── bondage.css
├── scripts/
│   └── main.js         共通 JavaScript
├── mens/
│   └── index.html      メンズ向けページ
├── bondage/
│   └── index.html      緊縛・吊り床ページ
└── studio-x/
    ├── index.html          Studio X ページ
    ├── style.css           Studio X 専用スタイル
    └── reservation/
        ├── index.html      Studio X 予約・撮影相談フォーム
        ├── style.css       予約フォーム専用スタイル
        └── form.js         予約フォームのバリデーション・送信制御
```

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
