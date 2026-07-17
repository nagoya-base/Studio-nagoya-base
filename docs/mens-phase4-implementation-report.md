# /mens/ 改修 Phase 4：実装報告書

対象ページ：`mens/index.html`（公開URL: https://nagoya-base.github.io/Studio-nagoya-base/mens/）

本書はPhase 4（実装）の成果物であり、Phase 1（`docs/mens-phase1-copy-proposal.md`）・Phase 2（`docs/mens-phase2-structure-proposal.md`）・Phase 3（`docs/mens-phase3-assets-seo-proposal.md`）で確定した文言・構成・画像・SEO仕様を `mens/index.html` / `styles/mens.css` に実装した内容を記録する。

本書は「Phase 4 最優先修正指示書」に基づき、初版実装（PR #186）を最新のPhase 3成果物と再照合し、不一致箇所を修正した内容を反映した改訂版である。

---

## 1. Phase 3成果物の取り込み状況

PR #186の初回実装（コミット `d85cd33`）は、作業ブランチの分岐元（`c9e5c1b`）の時点でPhase 3成果物 `docs/mens-phase3-assets-seo-proposal.md` を追加するPR #185（ブランチ `claude/mens-phase3-assets-seo-qdxgld`）がまだmainにマージされていなかったため、Phase 3の確定内容を参照できないまま実装された。そのため初版の実装報告書には「Phase 3提案書はリポジトリ内に存在しなかった」という、当時の事実を反映した記述があった。

その後、PR #185・PR #186は共にmainへマージされ、両ブランチの変更は非破壊的にマージされたため、現在のmainには以下がすべて揃っている。

* `docs/mens-phase1-copy-proposal.md`
* `docs/mens-phase2-structure-proposal.md`
* `docs/mens-phase3-assets-seo-proposal.md`
* `docs/mens-phase4-implementation-report.md`（初版）
* Phase 4で実装した `mens/index.html` / `styles/mens.css`

本修正では、最新のmainから作業ブランチを作り直し（`git fetch origin main && git checkout -B claude/mens-phase4-implementation-jvxoqu origin/main`）、`docs/mens-phase3-assets-seo-proposal.md` を全文確認したうえで、現在の実装と項目ごとに再照合した（2章）。「Phase 3提案書が存在しなかった」という記述は事実と異なるため本書から削除し、上記の経緯に置き換えた。

---

## 2. Phase 3と実装の照合表

| 項目 | Phase 3確定内容 | 現在のPhase 4実装 | 一致／不一致 | 対応 |
|---|---|---|---|---|
| ヒーロー画像 | 第1候補 `gallery_man02_1200.webp` を元に横長トリミングした新規ファイル `hero_mens_1600.webp`／`.jpeg` を作成して使用（6章） | `gallery_man02_1200.webp` をそのまま `.hero.mens-hero` のCSS背景として使用。新規トリミングファイルは未作成 | 一部一致（採用元画像は完全一致。専用トリミングファイルは未作成） | 元画像選定はPhase3第1候補と一致するため変更なし。専用ファイルの新規作成は本修正で変更を許可されたファイル範囲（`mens/index.html`・`styles/mens.css`・本報告書）の外にあるため対応せず、残課題として記録（7章） |
| ギャラリー画像・掲載順 1〜4枚目 | `gallery_man01`→`gallery_man02`→`gallery_man03`→`hero_mens_1200`（7-2章） | 同一 | 一致 | 対応不要 |
| ギャラリー画像・掲載順 5〜10枚目 | `gallery_lighting02`→`gallery_lighting05`→`gallery_white06`→`gallery_white01`→`IMG_2309_1200`→`gallery_lighting01`（7-2章） | 修正前：`gallery_lighting01`／`03`／`04`・`gallery_white01`・`IMG_2309`・`IMG_8519`・`IMG_8520`（Phase3指定と異なる組み合わせ・順序） | 不一致 | Phase3確定の6枚・順序に修正。`IMG_8519`／`IMG_8520` はPhase3が「予備候補（上限15枚以内で追加採用可）」と位置付けているため、確定10枚の後に追加候補として残した（合計12枚、上限15枚以内） |
| alt文（`gallery_man01〜03`・`hero_mens_1200`） | 11章確定文言（例：「野球ユニフォーム姿の男性モデルの床縄作品」） | 修正前：独自文言（内容は妥当だがPhase3確定文言と不一致） | 不一致 | Phase3確定文言にすべて置換 |
| alt文（`gallery_lighting01・02・05`） | 「木組みの吊り設備を照らすフルカラー照明サンプル N」 | 修正前：独自文言 | 不一致 | Phase3確定文言に置換 |
| alt文（`gallery_white01・06`） | 「白ホリ・カラーバリエーション N - Studio Nagoya Base」（既存alt・変更なし） | 修正前：独自文言 | 不一致 | 既存サイト共通のalt文（Phase3が「変更なし」と確認済み）に置換 |
| alt文（`IMG_2309` gallery内） | 「スタジオ内観（通常照明・木組みフレームと置き畳）」（変更なし） | 修正前：「スタジオ全景（…）」で文言差異 | 不一致（軽微） | Phase3確定文言に置換 |
| title | `男性同士の緊縛・フェティッシュ撮影向けレンタルスペース｜名古屋・上前津`（12章） | 同一 | 一致 | 対応不要 |
| meta description | 13章確定文言 | 同一 | 一致 | 対応不要 |
| og:title | `男性同士の緊縛・フェティッシュ撮影を、完全個室で。`（14章） | 同一 | 一致 | 対応不要 |
| og:description | 14章確定文言 | 同一 | 一致 | 対応不要 |
| og:image | 新規ファイル `ogp-mens-v2-1200x630.jpg`（8〜9章・未制作） | `ogp_IMG_2309_1200.jpeg`（中立・一般トップページと共有の既存画像）を暫定使用 | 不一致（ただしPhase3・指示書双方が許容する暫定運用） | Phase3 8-3「合成・書き出し作業はPhase4以降（画像実制作の指示が出た段階）で行う」を踏まえ、実画像制作は本修正の対象外。指示書6章が定める「専用OGP画像が仕様のみ確定・未制作の場合は暫定画像利用を許容する」に従い、既存の中立画像を維持 |
| twitter:title / twitter:description | 15章確定文言 | 同一 | 一致 | 対応不要 |
| twitter:image | og:imageと同じ新規ファイル（未制作） | 同上（暫定画像） | 不一致（許容） | og:imageと同様の理由で維持 |
| canonical | 現行実装で条件を満たす・変更不要（16章） | 変更なし | 一致 | 対応不要 |
| hreflang | `x-default` の追加を推奨（16章） | 追加済み | 一致 | 対応不要 |
| LocalBusiness.description | 19-1確定文言（「講習会」を含む旧文言から差し替え。手配なし文言は含まない） | 修正前：Phase1の別案由来の追加文（「緊縛師・モデル・カメラマンの手配や緊縛指導は行っていません」）を付加していた | 不一致 | Phase3確定文言に一致させ、追加文を削除 |
| LocalBusiness.image | 新規ファイル `ogp-mens-v2-1200x630.jpg` への変更を推奨（19-3章・未制作） | `gallery_man02_1200.webp`（新OGP画像の指定元ソース画像そのもの）を使用 | 一部一致（元画像はPhase3が指定するOGP合成元画像と同一。専用ファイルは未制作） | 新OGP画像が未制作の間の代替として、Phase3が合成元に指定した画像を直接使用する判断を維持。理由を4章に明記 |
| FAQ（「男性同士での利用はできますか」「縛り方を教えるサービスはありますか」の回答文言） | 20-1確定文言 | 同一 | 一致 | 対応不要 |
| FAQ（新規3問：ゲイ・バイ男性／緊縛師・モデル手配／フェティッシュ衣装） | 20-2確定文言 | 同一 | 一致 | 対応不要 |
| FAQ（「ユニフォーム・コスプレ撮影」と「フェティッシュ衣装で撮影」の重複） | 「両方掲載する」か「ユニフォーム・コスプレ側に統合する」かをPhase4の判断事項として保留（20-2章末） | 両方掲載し、「ユニフォーム・コスプレ撮影はできますか」を「ユニフォーム・スポーツウェア撮影は可能ですか」に改題 | Phase3が許容する選択肢の範囲内 | 変更なし。判断内容を4章に明記 |
| FAQ（「当日延長は可能ですか」） | 20-3「文言変更なしのFAQ（既存のまま）」として維持を想定 | 画面・構造化データから削除済み | 不一致（意図的な逸脱） | Phase4指示書が指定するFAQ優先表示順16項目に「当日延長」が含まれていないため、意図的に削除した。理由を4章に明記し、この判断を維持 |
| FAQ質問文の軽微な表記差（例：「男性同士での利用はできますか」→「男性同士で利用できますか」、「縛り方を教えるサービスはありますか」→「縛り方を教えてもらえますか」） | Phase3の表記 | Phase4指示書が指定した表記 | 表記差のみ・意味/対象者/検索意図は同一 | 指示書7章「文言が完全一致しない場合でも、意味・対象者・検索意図が同じなら変更不要としてよい」の規定により変更不要と判断 |

---

## 3. 不一致と修正内容（まとめ）

本修正で実際にコードを変更した項目は以下の3点。

1. **ギャラリー5〜10枚目の画像・順序**：Phase3確定の `gallery_lighting02`→`gallery_lighting05`→`gallery_white06`→`gallery_white01`→`IMG_2309`→`gallery_lighting01` に修正。`IMG_8519`／`IMG_8520` は予備候補として10枚の後に維持。
2. **ギャラリーalt文**：`gallery_man01〜03`・`hero_mens_1200`・`gallery_lighting01・02・05`・`gallery_white01・06`・`IMG_2309` のalt文をPhase3の11章確定文言に置換。
3. **LocalBusiness.description**：Phase1由来の追加文（手配・指導を行っていない旨の一文）を削除し、Phase3 19-1の確定文言に一致させた。

上記以外（title / meta description / OGPコピー / canonical / hreflang / FAQ回答文言 等）はPhase3確定内容と初版実装がすでに一致していたため、変更していない。

---

## 4. 代替判断した項目（Phase3指定アセットが未制作のもの）

指示書5章の判断順に従い、以下は「Phase3指定のファイルが実在しないため、既存アセットで代替する」第2優先の判断を維持した。理由をここに明記する。

### 4-1. ヒーロー背景画像

* **Phase3の記載**：`gallery_man02_1200.webp` を元に、ヒーロー用に横長トリミングした新規ファイル `hero_mens_1600.webp`／`.jpeg` を書き出す（Phase3自身も「本フェーズでは画像加工を行わない」と明記し、トリミング作業をPhase4実装者に委ねている）。
* **未制作の理由**：本修正で変更を許可されたファイルは `mens/index.html`・`styles/mens.css`・本報告書の3点のみであり（指示書11章）、`images/` への新規ファイル追加は許可範囲外。また実際の画像トリミング・書き出しには画像編集作業が必要で、本セッションでは実施しなかった。
* **採用した代替案**：Phase3が第1候補に指定した元画像 `gallery_man02_1200.webp` を、トリミング済みファイルを介さずCSS背景（`background-size: cover` 相当の `.hero` 実装）として直接使用。表示結果としてはブラウザ側で自動的に画面比率に合わせてクロップされるため、視覚的な意図（男性モデル・麻縄・宙吊りが分かるヒーロー背景）はPhase3の第1候補と一致する。

### 4-2. OGP画像（`og:image` / `twitter:image` / `LocalBusiness.image`）

* **Phase3の記載**：新規ファイル `ogp-mens-v2-1200x630.jpg` を、ヒーロー候補画像とコピー・スタジオ名・地名のテキスト合成によって新規制作する（8章）。「この合成・書き出し作業はPhase4以降（画像実制作の指示が出た段階）で行う」と明記されている。
* **未制作の理由**：4-1と同様、画像の新規合成はファイル変更許可範囲外であり、実施していない。
* **採用した代替案**：
  * `og:image` / `twitter:image` は、指示書6章が明示的に許容する「専用OGP画像の仕様のみ確定・実画像未制作の場合は既存の中立的なスタジオ内観画像を暫定使用してよい」という規定に従い、現行の `ogp_IMG_2309_1200.jpeg`（人物なし・一般トップページと共有の既存画像）を維持した。ポートレート比率の男性モデル写真をそのままSNSカードに使うとプラットフォーム側の自動クロップで顔や結び目が欠ける懸念があるため、既存の横長比率（1200×675）画像を暫定的に優先した。
  * `LocalBusiness.image`（schema.orgの代表画像。SNSカードのような自動クロップの影響を受けにくい）は、Phase3が新OGP画像の合成元に指定した `gallery_man02_1200.webp` を直接使用した。Phase3 19-3が求める「男性向けページであることをより明確に示す」方針を、専用ファイルが用意できるまでの間、最も近い形で満たすための判断。

---

## 5. SEO・画像・構造化データの最終状態

| 項目 | 最終状態 |
|---|---|
| title | 男性同士の緊縛・フェティッシュ撮影向けレンタルスペース｜名古屋・上前津 |
| meta description | 名古屋・上前津の完全個室レンタルスペース。男性同士の緊縛練習、吊り撮影、ユニフォーム・スポーツウェア・フェティッシュ衣装の作品撮りに対応。無人入室、最大4名、スマホ撮影可。 |
| canonical | https://nagoya-base.github.io/Studio-nagoya-base/mens/（変更なし） |
| hreflang | ja／x-default の2件 |
| og:title / twitter:title | 男性同士の緊縛・フェティッシュ撮影を、完全個室で。 |
| og:description | 名古屋・上前津の完全個室レンタルスペース。男性同士の緊縛練習、吊り撮影、ユニフォームやフェティッシュ衣装の作品撮りに対応しています。 |
| twitter:description | 名古屋・上前津の完全個室レンタルスペース。男性同士の緊縛練習、吊り撮影、ユニフォームやフェティッシュ衣装の作品撮りに対応。 |
| og:image / twitter:image | `ogp_IMG_2309_1200.jpeg`（暫定・中立画像。4-2章参照） |
| ヒーロー背景（CSS） | `gallery_man02_1200.webp`（男性モデル・麻縄・宙吊り。4-1章参照） |
| LocalBusiness.description | 名古屋・上前津の完全個室レンタルスペース。男性同士の緊縛練習、吊り撮影、ユニフォーム・スポーツウェア・フェティッシュ衣装の作品撮りに対応。無人入室、最大4名、スマホ撮影可。（Phase3 19-1と完全一致） |
| LocalBusiness.image | `gallery_man02_1200.webp`（4-2章参照） |
| FAQPage.mainEntity | 16項目。画面表示（`#faq`）と完全一致（2〜3章参照） |
| ギャラリー掲載画像 | 12枚（Phase3確定の10枚＋予備候補2枚）。女性モデル画像は0件 |

---

## 6. テスト結果

### Git・ファイル確認
* 最新main（`docs/mens-phase3-assets-seo-proposal.md` を含む）を作業ブランチへ取り込み済み（`git checkout -B claude/mens-phase4-implementation-jvxoqu origin/main`）
* `docs/mens-phase1-copy-proposal.md`／`mens-phase2-structure-proposal.md`／`mens-phase3-assets-seo-proposal.md`／`mens-phase4-implementation-report.md` がすべて存在することを確認
* コンフリクトマーカー（`<<<<<<<` 等）の残存なし
* `git diff --check` で空白関連の警告なし

### Jekyll
* `jekyll build` 成功（Liquidエラー・ビルドエラーなし）
* 生成HTML中に未展開のLiquidタグ（`{{ }}`）なし

### SEO・構造化データ
* title / meta description / canonical / OGP / Twitter Card：5章の最終状態と一致することを目視確認
* JSON-LD 2ブロック（LocalBusiness・FAQPage）を `json.loads()` で構文検証し、いずれも有効なJSON
* FAQ画面表示件数（16）とJSON-LD `mainEntity` 件数（16）が一致
* H1タグ数：1

### 画像
* 参照画像16点（`images/` 配下のギャラリー・ヒーロー・OGP・favicon・apple-touch-icon）すべてが実在することを確認
* 女性モデル画像（`gallery_bondage01/02`・`hero_bondage_1200`・`hero_studio_1200`）への参照が残っていないことを確認
* 汎用alt文（`gallery image N`）の残存なし
* preload画像（`gallery_man02_1200.webp`）とヒーロー背景画像が一致

### 内容
* 講習会・ワークショップの訴求文言なし（残存箇所は共通の利用規約・料金除外条件内のみで、いずれも禁止・対象外を説明する文脈）
* 外部緊縛師個人セッションへの誘導（`ataru` 等）への参照なし
* 料金・予約方法・利用規約・安全ルール・GA4・一般トップページ・`bondage/`・`studio-x/`・`en/`・共通ヘッダー/フッター・ロゴ・メールアドレス・Xアカウントは無変更

---

## 7. 残課題

1. **`hero_mens_1600.webp`／`.jpeg`（ヒーロー専用トリミング画像）が未制作**：`gallery_man02_1200.webp` を元にした横長トリミング・書き出しが必要（Phase3 6・9章）。実制作は画像編集作業を伴うため、別途実施すること。
2. **`ogp-mens-v2-1200x630.jpg`（男性向け専用OGP画像）が未制作**：ヒーロー候補画像とコピー・スタジオ名・地名のテキスト合成が必要（Phase3 8〜9章）。現状は中立画像で暫定運用（4-2章）。
3. **男性ペア・男性グループが同時に写った写真が0点**：Phase3 3章が明記する制約。「男性同士」を画像で直接示す写真がなく、現在のギャラリーは単独モデルの写真のみで構成されている。
4. **学校机・黒板を使った男性作例が0点**：設備としては備品リストに存在するが、撮影例の写真がない。
5. **ユニフォーム以外の衣装（制服・スポーツウェア単体・レザー等）を主題にした写真が0点**：現行の人物写真はすべて同一モデル・野球ユニフォームまたはヒーローコスチュームである。
6. **実ブラウザでのスマホ表示・アクセシビリティ実機確認が未実施**：320〜768px幅での目視確認、FAQ・ギャラリーモーダルの実機動作確認、キーボード操作・コントラストの確認を推奨。
7. **「利用の流れ」の共通include化**：Phase 2の16章が示す将来課題として未着手（`mens/index.html` に個別記述のまま）。

---

## 8. 実装概要（変更ファイル一覧）

| ファイル | 変更内容 |
|---|---|
| `mens/index.html` | ヒーロー・SEO/OGP・構造化データ・セクション構成・FAQを実装（初版）。本修正でギャラリー画像・順序・alt文・LocalBusiness.descriptionをPhase3確定内容に一致させた |
| `styles/mens.css` | 新規コンポーネントのスタイルを追加（既存クラスの変更なし、本修正での変更なし） |
| `docs/mens-phase4-implementation-report.md` | 本修正で全面改訂（Phase3再照合の反映） |

`styles/common.css`・`_includes/*.html`・`_data/news_ja.yml`・一般トップページ (`index.html`)・`bondage/`・`studio-x/`・`en/`・GA4・Formspree・カレンダー・共通ヘッダー/フッター・ロゴ・メールアドレス・Xアカウントは変更していない。

セクション構成（ヒーロー／男性向けページの説明／予約カレンダー／予約CTA／利用シーン／特徴／ギャラリー／設備・備品／料金／安全ルール／利用の流れ／お客様の声／アクセス・営業時間／FAQ／最終CTA／法的事項）、削除した要素（講習会・ワークショップ訴求、外部緊縛師個人セッションへの誘導、お知らせセクション、汎用alt文、重複CTA）、追加した要素（男性向け案内文、ヒーロー安心バッジ、安全ルールセクション、利用の流れ、最終CTA、FAQ新規2項目）は初版実装時から変更していない。
