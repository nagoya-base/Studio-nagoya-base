# Studio Nagoya Base

Studio Nagoya Base の静的サイト一式です。GitHub Pages で公開する前提の構成です。

公開 URL:
- Japanese: `https://nagoya-base.github.io/Studio-nagoya-base/`
- English: `https://nagoya-base.github.io/Studio-nagoya-base/en.html`

## ファイル構成

- `index.html`
  日本語トップページ
- `en.html`
  英語ページ
- `224a3228.jpeg`
- `224a3237.jpeg`
- `224a3254.jpeg`
- `IMG_7421.jpeg`
  ギャラリー画像と OGP 用画像
- `logo.svg`
  ロゴ画像
- `sitemap.xml`
  検索エンジン向けサイトマップ
- `robots.txt`
  クローラー向け設定

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

### 3. 画像を差し替える

画像ファイルをリポジトリ直下に配置し、HTML 内の `src` と `href` を差し替えます。

現在のギャラリー画像:
- `224a3228.jpeg`
- `224a3237.jpeg`
- `224a3254.jpeg`
- `IMG_7421.jpeg`

ギャラリーは画像クリックで元画像を開く仕様です。

### 4. OGP を更新する

OGP は SNS に URL を貼ったときのカード表示用メタ情報です。

更新箇所:
- `index.html`
- `en.html`

主な設定:
- `og:title`
- `og:description`
- `og:url`
- `og:image`
- `twitter:card`
- `twitter:image`

画像を差し替えた場合は `og:image` も合わせて更新してください。

### 5. 規約や料金を更新したとき

利用規約や料金表を更新した場合は、`index.html` のニュース欄にも必ず告知を追加してください。

対応の目安:
- 規約改定: 効力発生日の 14 日前までにニュース掲載
- 料金改定: 効力発生日の 30 日前までにニュース掲載

今回の反映例:
- 利用規約の新ルール有効日: `2026/4/15`
- 新料金の適用開始日: `2026/5/1`

ニュースに入れる内容の例:
- 改定した内容の要点
- いつから有効か
- 詳細は `料金` または `利用規約` を確認する案内

## GitHub Pages 公開

このサイトは GitHub Pages での公開を前提にしています。

想定公開先:
- `nagoya-base/Studio-nagoya-base`

基本の流れ:
1. ローカルで `index.html` などを編集
2. 変更内容を確認
3. Git にコミット
4. GitHub に push
5. GitHub Pages 側で反映を確認

反映後の確認ポイント:
- 日本語ページが開く
- `EN` から `en.html` に遷移できる
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
- 画像ファイル名に誤りがないか
- OGP の URL と画像が実在するか
- `sitemap.xml` の URL が最新か
- 外部リンクや予約導線が正しいか

## メモ

- このリポジトリはビルド不要の静的 HTML サイトです
- CSS と JavaScript は各 HTML ファイル内にインラインで記述しています
- ページ追加時はナビゲーションとフッター導線も合わせて更新すると運用しやすいです
