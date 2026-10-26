# サイト コードレビュー チェックリスト

対象リポジトリ:
- `nagoya-base/Studio-nagoya-base` … SNB（緊縛）+ Studio X（コスプレ）
- `nagoya-base/ataru-nagoya` … アタル緊縛事業（成人向け・年齢ゲート）
- `nagoya-base/snb-community` … 3柱コミュニティ（野球緑 / 交流赤 / 撮影青）

使い方:
- **軽量セット（観点1〜3）** = 毎回・小改修後に回す。事故が集中する領域。
- **精密セット（観点4〜8）** = 四半期ごと・大改修後に回す。
- 依頼時は「軽量セットで」「観点5だけ」のように指定する。

---

## 【軽量セット】

### 観点1: ブランド分離の整合性 ★最優先

- [ ] SNB配下に SpaceMarket リンクが無い（スペマは Studio X 専任）
- [ ] Studio X 配下に「緊縛・吊り床・縄」等の語が無い
- [ ] SNB ↔ Studio X の相互送客リンクが無い（分離方針・送客不要で確定）
- [ ] 3柱（baseball/community/portrait）から緊縛(ataru)へのリンクがゼロ
- [ ] 緊縛(ataru)→コミュニティは「snb-community トップ1点のみ」に集約
- [ ] ataru の `noindex,nofollow` と年齢確認ゲート(index.html)が生存
- [ ] 成人向けコンテンツが SNB / 3柱側に漏れていない

### 観点2: デプロイ健全性（GitHub Pages）

- [ ] 全HTMLの先頭に front matter（`---`）が混入していない
      （`.nojekyll`環境では `---` が画面に文字表示されるため致命的）
- [ ] 各リポジトリ直下に `.nojekyll` が存在する
- [ ] 公開URL（fetch）とリポジトリのコードが一致（デプロイ遅延/失敗の検出）
- [ ] リダイレクトページのmeta refresh + canonical が生存
      （ataru: snbc/ baseball/ community/ portrait/ + main/profile/portrait/studio-visit）
- [ ] リダイレクトが実際に機能している（公開URLをfetchしてリダイレクト先のコンテンツが返ること）

### 観点3: 情報の正確性・鮮度

- [ ] 料金：サイト表示 / 料金表PDF / 規約 の三者が一致
- [ ] 会員料金の定義が全ページで統一（2026/12/1以降は「SNB MEMBER＝月額1,000円の会員。予約メールと会員登録メールが一致し、利用日の属する月の会費が支払済み」が正。旧「承認した会員のみ」の記述が残っていない）
- [ ] SNB mensは「料金優遇」であり「会員資格の付与」ではないと明記されている
- [ ] Studio Xは2026/12/1以降の会員料金区分が無く（現行MEMBER料金を一般料金へスライド）、有料オプション全般（rental全件 + staffService全件。0円化された品も）が会員限定。セルフ設営・原状復帰等の無料利用は非会員でも可（#478で#469/#472の「機材レンタルは会員限定ではない」を上書き）
- [ ] 料金表は `docs/membership-pricing-2026-12.md`、サイト表示・規約・特商法・FAQと一致
- [ ] 会員限定特典（#478）: 2名ペアパック（平日5,000円/土日祝6,000円・3時間・1〜2名）とシャワー（1予約1回1,000円・SNB/mensのみ）が `/membership/`・`/mens/membership/`・規約・特商法・FAQ・JSON-LDで一致し、Studio Xにシャワーを出していない
- [ ] 会員限定特典は2026/12/1以降の新規作成分のみ。11/30までに作成済みの予約・OptionOrderは旧ルールのまま（grandfather）
- [ ] actual membershipの再確認箇所（予約作成・OptionOrder作成・Checkout・日程変更・Admin承認・0円確定・手動確定・現地精算）がfail-closed。見積りAPI・決済済みWebhookでは会員照会/巻き戻しをしない
- [ ] 3つの会員ページ（`/membership/`・`/mens/membership/`・`/studio-x/membership/`）のog:title/description/url・canonical・twitterメタがページ固有で、各ブランドトップの画像資産を使い他ブランドの画像を流用していない
- [ ] 各トップ（SNB・mens・Studio X）から対応する会員ページへの導線がある（Studio Xのヒーローは「SNB MEMBER」を前面に出さない）
- [ ] 終了済みキャンペーンが残っていない（例: SNSレビュー割 6/30 期限）
- [ ] 過去日付のイベント告知・「新規オープン」表示の賞味期限切れが無い
- [ ] 営業時間・住所・最寄駅・連絡先がページ間で矛盾しない
- [ ] 確定済みの文言変更の取り残しが無い（例: 箪笥→クローゼット）

---

## 【精密セット】

### 観点4: SEO・構造化データ

- [ ] title / meta description / og / twitter が各ページ最適化・重複なし
- [ ] canonical / hreflang / sitemap.xml が整合（x-default の妥当性含む）
- [ ] JSON-LD（LocalBusiness / FAQPage）が存在し検証を通過
- [ ] h1 が各ページに1つだけ存在、見出し階層が正しい

### 観点5: パフォーマンス

- [ ] 画像が WebP 化されている
- [ ] 全 `<img>` に width / height 属性（CLS対策）
- [ ] ヒーロー(LCP)に preload + fetchpriority="high"、lazyを付けない
- [ ] ファーストビュー外の画像に loading="lazy" + decoding="async"
- [ ] LCP対象が正しく、過剰解像度・重量級ファイルが無い
- [ ] CSS/JS の読み込み位置が適切、scrollリスナーが passive

### 観点6: アクセシビリティ

- [ ] 全テーマでコントラスト比 WCAG AA（SNB: kuro/kinari、3柱: 緑赤青）
- [ ] alt属性 / aria-label / skip-link が適切
- [ ] モーダルのフォーカス管理・ESC・オーバーレイ閉じが機能
- [ ] color-scheme 指定で埋め込みカレンダーのダークモード化を防止

### 観点7: 保守性・コード衛生

- [ ] 3ページ共通部分が includes 化され重複していない
- [ ] CSS変数をバイパスしたハードコード色が無い
- [ ] 未使用CSSが無い
- [ ] マージ済み・実験用リモートブランチが滞留していない
- [ ] 画像のファイル名と内容が一致（リネーム事故の予防）
- [ ] リダイレクトを除く全HTMLから参照されていない孤立コンテンツ（HTML/CSS）が無い
- [ ] OGP・twitter:image・ヒーロー画像を除く全画像が WebP で実装されている
- [ ] OGP（og:image）と twitter:image は JPEG（.jpg）で実装されている
      （TwitterはWebP非対応のため。ファイル名末尾が `.jpg` であること）
- [ ] ヒーロー画像は `<picture>` 要素で WebP 優先・JPEG フォールバックが実装されている
- [ ] 未参照の画像ファイルが images/ 配下に残っていない
      （全HTMLからの参照一覧と images/ の実在ファイルを突き合わせて確認）
- [ ] 画像ファイル名が内容を示す命名になっている
      （UUID・カメラ連番（IMG_XXXX / DSC_XXXX）はNG。例: `hero_bondage.webp` `event_soccer_vol1.webp`）
- [ ] 画像が適切なサイズに縮小されている
      （ヒーロー: 長辺1600px以内 / ギャラリーサムネ: 長辺1200px以内 / OGP: 1200×630px）
      （1ファイル500KB超は要確認。ページ合計10MB超は改善対象）

### 観点8: 事業目標との適合（132万プラン）

- [ ] 予約導線の摩擦が最小（SNB=直販の即レス設計 / Studio X=即時予約）
- [ ] 社会的証明（レビュー/ご利用者の声）が表示されている
- [ ] 主訴求がヒーローからブレていない
      （SNB=体験価値 / SNBC=名古屋×仲間の希少性 / Studio X=照明で世界が変わる）
- [ ] before/after 等「人間の変化」を見せる転換コンテンツの有無

---

## レビュー実行時のルール

- レビューは**実コードと公開URL(fetch)の両方**を確認する。コードだけ・表示だけは不可。
- 指摘は「観点番号 + 優先度(🔴高/🟡中/🟢低) + 該当ファイル」を明記する。
- 修正指示はリポジトリごとに別mdに分ける。
- 数値（料金・コントラスト比等）は推測せず実測・実ファイル照合する。
