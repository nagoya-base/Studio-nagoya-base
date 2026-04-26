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
    ├── index.html      Studio X ページ
    └── style.css       Studio X 専用スタイル
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
- `index.html`
- `en.html`
- `mens/index.html`
- `bondage/index.html`
- `studio-x/index.html`

### 確認できる主な指標

- **ページビュー数**：各ページへのアクセス数
- **ユーザー数**：サイトへの訪問者数（実訪問者）
- **セッション数**：訪問回数
- **流入元**：検索エンジン / SNS / 直接アクセス などの内訳
- **デバイス**：スマートフォン / PC / タブレットの比率
- **地域**：アクセス元の地域情報

## メモ

- このリポジトリはビルド不要の静的 HTML サイトです
- CSS は `styles/` フォルダに、JavaScript は `scripts/main.js` に分離されています（Studio X は `studio-x/style.css` を使用）
- 画像は `images/` フォルダにまとめて管理しています（Studio X サブページの画像を除く）
- 新しいページを追加した場合は、ナビゲーション・フッター導線・GA4 トラッキングコードも合わせて追加してください
