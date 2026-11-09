# 画像アセット棚卸しレポート（Issue #852 Phase 1）

> **本書は調査結果と「提案」のみ。画像の移動・削除・リネーム、参照の書き換えは一切行っていない。** 削除・移動の可否は先輩（オーナー）のレビューで決定し、実施は Phase 2 の別PRで行う。

- 調査基準: main `92e5af553e8b9bd8bd040f418b439234a3f136b6`（Git tree `a0902d1ed135f71cee7e6124fc91544790771c66`）
- 対象: `images/`（55件）＋ `studio-x/images/`（30件）＝ **85件 / 8,797,915 bytes**。リポジトリ内の他の画像は `studio-x/touch-icon.svg` のみ（対象外・維持）。
- 再現手順: `node scripts/image-inventory-852.js`（Markdown表）／ `--json`（参照箇所の行番号まで全件）。読み取り専用。

## 調査方法

1. **一覧**: `git ls-tree -r -l` で path / bytes / blob SHA、ヘッダ解析で形式・寸法を取得。Pillow で85件すべてデコードできることを確認（破損ファイルなし）。
2. **参照の横断検索**: Git 管理下の全テキスト（HTML / Markdown / CSS / JS / JSON / YAML / GAS / XML / テスト / docs / README / workflows）を対象に、各画像のファイル名を含むトークンを抽出し、パスとして解決して画像と突き合わせた。
   - 相対パス（`../images/x`）はそのファイルのディレクトリ起点、絶対URL・`/`始まり・Liquid（`{{ site.baseurl }}`）はサイトルート起点で解決。`studio-x/images/` と `images/` の取り違えを防ぐため、ファイル名一致だけでは計上しない。
   - URLエンコード・`?v=` 等のクエリは除去。`data-src` などの属性、`srcset`、CSS `url()` / `image-set()`、JSON-LD、`og:image` / `twitter:image` も対象。
   - **動的生成**: `_includes/equipment_photo_cards.html` は `{{ include.image_path }}/equipment-*.webp`、`_data/studio_x_worlds.yml` はファイル名のみを持ち、テンプレートで連結される。これらは「ファイル名のみ」として、同名画像が1件しかないことを確認したうえで計上した。文字列連結・テンプレートリテラルによる画像パス生成（`'gallery_' + n` 等）は検索した範囲で見つからなかった。
   - 名前が見つからなかった画像は、拡張子・サイズ接尾辞を外した語幹（`studiox_lighting` 等）でも再検索した。
3. **重複**: blob SHA 一致で完全一致を、縮小グレースケールの差分ハッシュ（dHash 256bit、ハミング距離 ≤5）で「同一写真の別形式・別寸法」を検出し、近似ペアは目視で確認した。
4. **経緯**: 参照ゼロの画像は、直前に削除された旧ページ（#837 の `archive/`）の差分を確認し、どこから使われていたかを特定した。

## 結論（要約）

| 区分 | 件数 | bytes | 内容 |
|---|---:|---:|---|
| 維持（現行利用） | 58 | — | ページ・CSS・データ・GASから参照あり |
| 維持（外部公開URL） | 12 | — | `og:image` / `twitter:image` / JSON-LD に絶対URLで掲載。SNS・検索のキャッシュがあるため URL を変えない |
| 維持（固定URL） | 2 | — | `favicon.svg` / `apple-touch-icon.png`（ブックマーク・ホーム画面） |
| 維持（テスト保護） | 1 | 164,985 | `ogp-mens-v2-1200x630.jpg`（#662 で「旧画像は削除しない」と決定済み。テストが存在を要求） |
| **削除候補** | 9 | 1,364,943 | いずれも `studio-x/images/`。現行参照なし（#837 で削除した旧 `archive/` からのみ参照） |
| **要判断** | 3 | 388,470 | `studio-x/images/` の未使用だが再利用価値のありそうな素材 |

- **完全一致の重複は1組のみ**（`interior-rigging-frame_1200.jpeg` ＝ `ogp-interior-rigging-frame_1200x675.jpg`）。**共通化せず維持を推奨**（後述）。
- **フォルダの再配置（移動）は、既存画像については行わない案（案A）を推奨**。新規画像から用途別フォルダを使う（後述の命名・配置ルール案）。
- 削除候補9件をすべて削除した場合の削減は **1,364,943 bytes（約1.3MB、全体の15.5%）**。要判断3件も削除すると 1,753,413 bytes（約1.7MB、19.9%）。

## 全85件の一覧

凡例: 参照 = 参照元ファイル（テストは件数のみ）。重複 = 完全一致（blob SHA）または同一写真（dHash＋目視）。移動案B = 案Bを採る場合の移動先（`images/` 配下、`—` は移動しない）。

| path | bytes | 形式・寸法 | blob SHA | 参照 | 重複・同一写真 | 判定（提案） | 移動案B |
|---|---:|---|---|---|---|---|---|
| `images/apple-touch-icon.png` | 1,285 | png 180×180 | `70955f2db5` | `booking/en.html`, `booking/index.html`, `booking/option-payment-complete.html` ほか計28件 | — | 維持（固定URL） | — |
| `images/backdrop-color-blue_1200.webp` | 30,334 | webp 1200×675 | `d21ab9e314` | `mens/index.html`, `mens/preview-633.html` | — | 維持（現行利用） | backdrops/ |
| `images/backdrop-color-orange_1200.webp` | 39,600 | webp 1200×675 | `7486b76f52` | `mens/index.html`, `mens/preview-633.html` | — | 維持（現行利用） | backdrops/ |
| `images/backdrop-color-purple_1200.webp` | 31,040 | webp 1200×675 | `99adb7d0c0` | `mens/index.html`, `mens/preview-633.html` | — | 維持（現行利用） | backdrops/ |
| `images/backdrop-color-red_1200.webp` | 25,494 | webp 1200×675 | `9aa1072740` | `mens/index.html`, `mens/preview-633.html` | — | 維持（現行利用） | backdrops/ |
| `images/backdrop-color-white_1200.webp` | 42,178 | webp 1200×675 | `2b9309e0a9` | `mens/index.html`, `mens/preview-633.html` | 同一写真（ブランド違い）: studio-x/images/studiox_white* | 維持（現行利用） | backdrops/ |
| `images/backdrop-tiedye-gray_1200.webp` | 206,026 | webp 675×1200 | `35369e0665` | `_data/studio_x_equipment.json`, `gas/booking/shared/EquipmentCatalog.gs`, `mens/index.html`, `mens/preview-633.html`／test 2件 | — | 維持（現行利用） | backdrops/ |
| `images/equipment/equipment-cob-light-bicolor.webp` | 24,282 | webp 900×1600 | `6f528dea10` | `_includes/equipment_photo_cards.html` | — | 維持（現行利用） | — |
| `images/equipment/equipment-cob-light-fullcolor.webp` | 39,554 | webp 900×1600 | `50cec0d5b5` | `_includes/equipment_photo_cards.html` | — | 維持（現行利用） | — |
| `images/equipment/equipment-led-panel-light.webp` | 94,484 | webp 900×1600 | `9088dff088` | `_includes/equipment_photo_cards.html` | — | 維持（現行利用） | — |
| `images/equipment/equipment-monoblock-strobe.webp` | 35,964 | webp 900×1600 | `54d917b615` | `_includes/equipment_photo_cards.html` | — | 維持（現行利用） | — |
| `images/equipment/equipment-mount-bracket.webp` | 244,656 | webp 900×1600 | `edbf790fe1` | `_includes/equipment_photo_cards.html` | — | 維持（現行利用） | — |
| `images/equipment/equipment-portable-strobe.webp` | 31,378 | webp 900×1600 | `5cd7356e8a` | `_includes/equipment_photo_cards.html` | — | 維持（現行利用） | — |
| `images/equipment/equipment-reflector-5in1.webp` | 347,140 | webp 1600×900 | `a87c9a85b5` | `_includes/equipment_photo_cards.html` | — | 維持（現行利用） | — |
| `images/equipment/equipment-wireless-commander.webp` | 198,272 | webp 1600×900 | `36d23491c5` | `_includes/equipment_photo_cards.html`, `equipment/index.html`, `studio-x/equipment/index.html` | — | 維持（外部公開URL） | — |
| `images/favicon.svg` | 274 | svg 64×64 | `bfa531a36d` | `booking/en.html`, `booking/index.html`, `booking/option-payment-complete.html` ほか計32件 | — | 維持（固定URL） | — |
| `images/gallery_bondage01_1200.webp` | 50,044 | webp 876×1200 | `e642a04d2e` | `index.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_bondage02_1200.webp` | 53,106 | webp 1200×1118 | `900b24805d` | `index.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_lighting01_1200.webp` | 62,554 | webp 1200×675 | `c3208dab52` | `en.html`, `index.html`, `mens/index.html`, `mens/preview-633.html`／test 1件 | — | 維持（現行利用） | gallery/ |
| `images/gallery_lighting02_1200.webp` | 47,164 | webp 1200×675 | `a7d8a1f50b` | `index.html`, `mens/index.html`, `mens/preview-633.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_lighting03_1200.webp` | 44,152 | webp 1200×675 | `5ae94b1adb` | `index.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_lighting04_1200.webp` | 29,688 | webp 1200×675 | `6dcb8517e7` | `index.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_lighting05_1200.webp` | 35,852 | webp 1200×675 | `9aebf77d72` | `index.html`, `mens/index.html`, `mens/preview-633.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_man01_1200.webp` | 42,304 | webp 800×1200 | `b51fd4b558` | `index.html`, `mens/index.html`, `mens/preview-633.html`／test 1件 | — | 維持（現行利用） | gallery/ |
| `images/gallery_man02_1200.webp` | 41,006 | webp 800×1200 | `bfafc6a085` | `index.html`, `mens/index.html`, `mens/preview-633.html`／test 1件 | — | 維持（現行利用） | gallery/ |
| `images/gallery_man03_1200.webp` | 94,576 | webp 1200×800 | `ec24b8b5e0` | `index.html`, `mens/index.html`, `mens/preview-633.html`／test 1件 | — | 維持（現行利用） | gallery/ |
| `images/gallery_man04_1200.webp` | 125,844 | webp 800×1200 | `1d2a4772c5` | `mens/index.html`, `mens/preview-633.html`／test 1件 | — | 維持（現行利用） | gallery/ |
| `images/gallery_man05_1200.webp` | 35,102 | webp 800×1200 | `2331a58fcd` | `mens/index.html`, `mens/preview-633.html`／test 1件 | — | 維持（現行利用） | gallery/ |
| `images/gallery_white01_1200.webp` | 34,102 | webp 675×1200 | `6d40385aad` | `en.html`, `index.html`, `mens/index.html`, `mens/preview-633.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_white02_1200.webp` | 30,112 | webp 675×1200 | `6260225a35` | `index.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_white03_1200.webp` | 43,978 | webp 675×1200 | `e1f2f9f183` | `index.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_white04_1200.webp` | 33,984 | webp 675×1200 | `704ae9720e` | `index.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_white05_1200.webp` | 46,334 | webp 675×1200 | `c3024b9ae6` | `index.html` | — | 維持（現行利用） | gallery/ |
| `images/gallery_white06_1200.webp` | 48,096 | webp 675×1200 | `d6483a0995` | `index.html`, `mens/index.html`, `mens/preview-633.html` | — | 維持（現行利用） | gallery/ |
| `images/hero_bondage_1200.webp` | 34,688 | webp 800×1200 | `96932664ff` | `index.html` | — | 維持（現行利用） | hero/ |
| `images/hero_mens_1200.webp` | 44,568 | webp 800×1200 | `acd93b9f2d` | `mens/index.html`, `mens/preview-633.html`／test 1件 | — | 維持（現行利用） | hero/ |
| `images/hero_mens_survey_1200.webp` | 44,018 | webp 1200×630 | `499650ec9c` | `mens/survey/index.html`／test 1件 | 同一写真: ogp-mens-survey-1200x630.jpg | 維持（現行利用） | hero/ |
| `images/hero_studio_1200.webp` | 35,628 | webp 877×1200 | `e1bb5f45b3` | `en.html`, `index.html` | — | 維持（現行利用） | hero/ |
| `images/hero_survey_1200.webp` | 84,828 | webp 1200×630 | `1c1bb417e9` | `survey/index.html` | 同一写真: ogp-survey-1200x630.jpg | 維持（現行利用） | hero/ |
| `images/interior-classroom_1200.webp` | 76,014 | webp 1200×675 | `dd26369281` | `mens/index.html`, `mens/preview-633.html`／test 1件 | — | 維持（現行利用） | interior/ |
| `images/interior-rigging-frame_1200.jpeg` | 130,489 | jpeg 1200×675 | `4eb694c3a2` | `en.html`, `index.html`, `mens/index.html`, `mens/preview-633.html`／test 1件 | 完全一致: ogp-interior-rigging-frame_1200x675.jpg／同一写真: _1200.webp・_1600.* | 維持（外部公開URL） | — |
| `images/interior-rigging-frame_1200.webp` | 86,214 | webp 1200×675 | `4ee9cab931` | `en.html`, `index.html`, `mens/index.html`, `mens/preview-633.html`／test 1件 | 同一写真（別形式・寸法） | 維持（現行利用） | interior/ |
| `images/interior-rigging-frame_1600.jpeg` | 221,478 | jpeg 1600×900 | `faa7fb9a4c` | `styles/common.css` | 同一写真（別形式・寸法） | 維持（現行利用） | interior/ |
| `images/interior-rigging-frame_1600.webp` | 143,452 | webp 1600×900 | `e279ec865c` | `en.html`, `styles/common.css` | 同一写真（別形式・寸法） | 維持（現行利用） | interior/ |
| `images/logo.svg` | 998 | svg 206×156 | `b40cbd0b42` | `feedback/mens/index.html`, `feedback/snb/index.html`／test 1件 | — | 維持（現行利用） | branding/ |
| `images/mens-preview-hero.webp` | 84,806 | webp 1600×841 | `a826fe07f1` | `mens/index.html`, `mens/membership/index.html`, `mens/preview-633.html`／test 3件 | 同一デザイン: mens-preview-ogp-1200x630.jpg（寸法違い） | 維持（現行利用） | — |
| `images/mens-preview-ogp-1200x630.jpg` | 113,624 | jpeg 1200×630 | `ef957a0e8e` | `feedback/mens/index.html`, `mens/how-to/index.html`, `mens/index.html` ほか計6件／test 3件 | 同一デザイン: mens-preview-hero.webp | 維持（外部公開URL） | — |
| `images/ogp-interior-rigging-frame_1200x675.jpg` | 130,489 | jpeg 1200×675 | `4eb694c3a2` | `en.html`, `how-to/en.html`, `how-to/index.html` ほか計6件 | 完全一致: interior-rigging-frame_1200.jpeg | 維持（外部公開URL） | — |
| `images/ogp-mens-survey-1200x630.jpg` | 108,182 | jpeg 1200×630 | `aa321529ab` | `mens/survey/index.html`／test 1件 | 同一写真: hero_mens_survey_1200.webp | 維持（外部公開URL） | — |
| `images/ogp-mens-v2-1200x630.jpg` | 164,985 | jpeg 1200×630 | `fe9c2cad41` | なし／test 3件 | — | 維持（テストが存在を要求・旧OGP） | — |
| `images/ogp-survey-1200x630.jpg` | 163,787 | jpeg 1200×630 | `13e21e762b` | `survey/index.html` | 同一写真: hero_survey_1200.webp | 維持（外部公開URL） | — |
| `images/pattern-asanoha-indigo_1200.webp` | 355,538 | webp 675×1200 | `98fc69f445` | `_data/studio_x_equipment.json`, `gas/booking/shared/EquipmentCatalog.gs`, `index.html` ほか計5件／test 2件 | — | 維持（現行利用） | backdrops/ |
| `images/pattern-tsuru-black_1200.webp` | 278,184 | webp 675×1200 | `fac22797cb` | `_data/studio_x_equipment.json`, `gas/booking/shared/EquipmentCatalog.gs`, `index.html` ほか計5件／test 2件 | — | 維持（現行利用） | backdrops/ |
| `images/studio-nagoya-base-hero-ogp.jpg` | 155,214 | jpeg 1200×630 | `c8e67e0c4c` | `feedback/snb/index.html`, `index.html`, `membership/index.html`／test 1件 | 同一写真: .webp（表示用） | 維持（外部公開URL） | — |
| `images/studio-nagoya-base-hero-ogp.webp` | 109,004 | webp 1200×630 | `eb882dd922` | `index.html`, `membership/index.html` | 同一写真: .jpg（OGP用） | 維持（現行利用） | — |
| `studio-x/images/ogp_hero.jpg` | 103,335 | jpeg 1200×630 | `db29169898` | `studio-x/how-to/index.html`, `studio-x/legal/index.html` | 同一デザイン: studio-x-exterior_1000.* | 維持（外部公開URL） | — |
| `studio-x/images/sample_01_blackboard_1200.webp` | 127,714 | webp 1200×1800 | `e59aecae32` | なし | — | **要判断** | — |
| `studio-x/images/sample_02_four_color_collage_1200.webp` | 111,360 | webp 1200×1800 | `4a21baa468` | `_data/studio_x_worlds.yml`, `studio-x/index.html` | 同一写真: studio-x-event-0905-classroom-gallery-01.webp（名前と内容が不一致: 実際は教室写真） | 維持（現行利用） | — |
| `studio-x/images/sample_03_slant_light_1200.webp` | 139,254 | webp 1200×1800 | `12433c9357` | `studio-x/index.html`, `studio-x/membership/index.html`／test 1件 | — | 維持（現行利用） | — |
| `studio-x/images/sample_04_neon_1200.webp` | 157,516 | webp 1200×1887 | `be622d41bb` | `_data/studio_x_worlds.yml`, `studio-x/index.html`, `studio-x/membership/index.html` | — | 維持（現行利用） | — |
| `studio-x/images/sample_05_blue_purple_full_body_1200.webp` | 96,224 | webp 1200×1800 | `1e11d53830` | `studio-x/index.html`, `studio-x/membership/index.html` | — | 維持（現行利用） | — |
| `studio-x/images/sample_06_backlight_1200.webp` | 156,622 | webp 1200×1800 | `1bf66365b2` | `studio-x/style.css` | — | 維持（現行利用） | — |
| `studio-x/images/studio-x-base-plan-ogp.jpg` | 146,741 | jpeg 1200×630 | `e7777aefca` | `studio-x/base-plan/index.html` | — | 維持（外部公開URL） | — |
| `studio-x/images/studio-x-event-0905-classroom-gallery-01.webp` | 139,928 | webp 1200×1800 | `708b2014bd` | `studio-x/events/2026-09-05-classroom/index.html` | 同一写真: sample_02_four_color_collage_1200.webp | 維持（現行利用） | — |
| `studio-x/images/studio-x-event-0905-classroom-hero.webp` | 79,154 | webp 1200×800 | `1c5463d045` | `studio-x/events/2026-09-05-classroom/index.html` | — | 維持（現行利用） | — |
| `studio-x/images/studio-x-event-0905-classroom-ogp.jpg` | 126,096 | jpeg 1200×630 | `a559f3871f` | `studio-x/events/2026-09-05-classroom/index.html` | — | 維持（外部公開URL） | — |
| `studio-x/images/studio-x-event-0912-cosplay-hero-v2.webp` | 73,286 | webp 900×1125 | `2e36ab4f50` | `studio-x/events/2026-09-12-cosplay/index.html` | — | 維持（現行利用） | — |
| `studio-x/images/studio-x-event-0912-cosplay-ogp-v2.jpg` | 101,424 | jpeg 1200×630 | `21a069f6ee` | `studio-x/events/2026-09-12-cosplay/index.html` | — | 維持（外部公開URL） | — |
| `studio-x/images/studio-x-exterior_1000.jpg` | 79,757 | jpeg 1000×525 | `670b627dc1` | なし | 同一デザイン: ogp_hero.jpg（名前と内容が不一致: 外観ではなく旧バナー） | **削除候補** | — |
| `studio-x/images/studio-x-exterior_1000.webp` | 47,268 | webp 1000×525 | `917b237b32` | なし | 同一デザイン: ogp_hero.jpg | **削除候補** | — |
| `studio-x/images/studio-x-ogp.jpg` | 118,439 | jpeg 1200×630 | `5f781312dc` | `feedback/studio-x/index.html`, `studio-x/index.html`, `studio-x/membership/index.html`, `studio-x/reservation/index.html`／test 1件 | — | 維持（外部公開URL） | — |
| `studio-x/images/studiox_black.jpeg` | 131,177 | jpeg 675×1200 | `fd7baeb4b8` | なし | 同一写真: studiox_black_1200.webp | **削除候補** | — |
| `studio-x/images/studiox_black_1200.webp` | 84,664 | webp 675×1200 | `a31e741ac6` | `_data/studio_x_worlds.yml`, `studio-x/index.html` | — | 維持（現行利用） | — |
| `studio-x/images/studiox_classroom.jpeg` | 248,857 | jpeg 1200×1800 | `ebd256d5e5` | なし | 同一写真: studiox_classroom_1200.webp | **削除候補** | — |
| `studio-x/images/studiox_classroom_1200.webp` | 124,404 | webp 1200×1800 | `f28c31a0c8` | `studio-x/index.html` | — | 維持（現行利用） | — |
| `studio-x/images/studiox_guide.webp` | 134,742 | webp 708×1000 | `d3060e9307` | なし | — | **要判断** | — |
| `studio-x/images/studiox_lighting.jpeg` | 213,496 | jpeg 1200×1200 | `b3ef252c36` | なし | 同一写真: studiox_lighting_1200.webp | **削除候補** | — |
| `studio-x/images/studiox_lighting_1200.webp` | 126,014 | webp 1200×1200 | `f93194bf75` | なし | — | **要判断** | — |
| `studio-x/images/studiox_oiran.jpeg` | 291,538 | jpeg 1200×675 | `31529203f3` | なし | 同一写真: studiox_oiran_1200.webp | **削除候補** | — |
| `studio-x/images/studiox_oiran_1200.webp` | 233,638 | webp 1200×675 | `6ffb9011d9` | `_data/studio_x_worlds.yml`, `studio-x/index.html` | — | 維持（現行利用） | — |
| `studio-x/images/studiox_ruins.jpeg` | 199,160 | jpeg 1200×675 | `e4752fa6fc` | なし | 同一写真: studiox_ruins_1200.webp | **削除候補** | — |
| `studio-x/images/studiox_ruins_1200.webp` | 154,320 | webp 1200×675 | `51986804af` | `_data/studio_x_worlds.yml`, `studio-x/index.html` | — | 維持（現行利用） | — |
| `studio-x/images/studiox_sample01.jpeg` | 71,541 | jpeg 1200×564 | `4eabeb760e` | なし | — | **削除候補** | — |
| `studio-x/images/studiox_white.jpeg` | 82,149 | jpeg 1200×675 | `4024ddaec3` | なし | 同一写真: studiox_white_1200.webp | **削除候補** | — |
| `studio-x/images/studiox_white_1200.webp` | 41,950 | webp 1200×675 | `f52995a208` | `_data/studio_x_worlds.yml`, `studio-x/index.html`, `studio-x/membership/index.html` | 同一写真（ブランド違い）: images/backdrop-color-white_1200.webp | 維持（現行利用） | — |

## 削除候補（9件・1,364,943 bytes）

すべて `studio-x/images/`。現行の公開ページ・CSS・データ・GAS・テストからの参照はなく、#837（`0d8d1ec`）で削除した旧 `archive/index.html`（旧Studio Xトップ）からのみ使われていた。

| path | bytes | 旧用途（`archive/index.html`） | 根拠 |
|---|---:|---|---|
| `studio-x/images/studiox_white.jpeg` | 82,149 | `<picture>` の JPEG フォールバック | 現行は同一写真の `studiox_white_1200.webp` のみ参照 |
| `studio-x/images/studiox_black.jpeg` | 131,177 | 同上 | 現行は `studiox_black_1200.webp` のみ |
| `studio-x/images/studiox_classroom.jpeg` | 248,857 | 同上 | 現行は `studiox_classroom_1200.webp` のみ。`test/mens-preview-633.test.js:524` は「参照しないこと」を検査しているだけ |
| `studio-x/images/studiox_lighting.jpeg` | 213,496 | 同上 | WebP 版も現行未使用（下の要判断） |
| `studio-x/images/studiox_oiran.jpeg` | 291,538 | 同上 | 現行は `studiox_oiran_1200.webp` のみ |
| `studio-x/images/studiox_ruins.jpeg` | 199,160 | 同上 | 現行は `studiox_ruins_1200.webp` のみ |
| `studio-x/images/studiox_sample01.jpeg` | 71,541 | 作例画像の `onerror` 代替 | 旧ブランド表記（CYBERPUNK PHOTO STUDIO）のバナー |
| `studio-x/images/studio-x-exterior_1000.jpg` | 79,757 | 旧ヒーロー `<img>`・旧 JSON-LD `image`（絶対URL） | 名前は「外観」だが中身は旧 STUDIO X バナー（`ogp_hero.jpg` と同デザイン）。旧ページは削除済み |
| `studio-x/images/studio-x-exterior_1000.webp` | 47,268 | 旧ヒーロー `preload` / `<source>` | 同上 |

**影響範囲**: 参照の書き換えは不要（現行参照ゼロ）。外部影響は、旧 `archive/` ページの共有・画像検索経由でこれらの URL を直接開いた場合に 404 になる点のみ。旧ページ自体が既に 404 のため追加の実害は小さい。

## 要判断（3件・388,470 bytes）

現行参照はないが、写真素材として再利用の可能性があるため、先輩の判断を仰ぎたい。

| path | bytes | 中身 | 提案 |
|---|---:|---|---|
| `studio-x/images/sample_01_blackboard_1200.webp` | 127,714 | 黒板に「放課後アイドル撮影 Studio X」と書く作例（1200×1800） | 今後の作例・イベント告知で使うなら維持、予定がなければ削除 |
| `studio-x/images/studiox_guide.webp` | 134,742 | 「STUDIO X 紹介図鑑」インフォグラフィック（708×1000） | SNS・掲示物など**サイト外で使っていれば維持**（サイト外利用は本調査で確認できない） |
| `studio-x/images/studiox_lighting_1200.webp` | 126,014 | 4色照明のコラージュ（1200×1200） | 現行「サイバー・ネオン」は `sample_04_neon_1200.webp` を使用。予定がなければ削除 |

## 完全一致の2件（`interior-rigging-frame_1200.jpeg` ＝ `ogp-interior-rigging-frame_1200x675.jpg`）

blob SHA `4eb694c3a2d1fa5a5c110dfd8960a21e496adaac`、各 130,489 bytes、1200×675。

| ファイル | 用途 | 参照箇所 |
|---|---|---|
| `interior-rigging-frame_1200.jpeg` | ギャラリー `<picture>` の JPEG フォールバック、`en.html` の JSON-LD `image`（絶対URL） | `index.html:317`、`en.html:51`・`:207`、`mens/index.html:312`、`mens/preview-633.html:304`、`test/mens-preview-633.test.js:335`・`:351`（ファイル実寸も検査） |
| `ogp-interior-rigging-frame_1200x675.jpg` | `og:image` / `twitter:image`（絶対URL） | `en.html:33,37`、`how-to/index.html:35,39`、`how-to/en.html:33,37`、`legal/index.html:36,40`、`legal/en.html:34,38`、`news/index.html:33,37`（6ページ12箇所） |

**提案: 共通化せず、用途違いの意図的な重複として維持する。**

- どちらも外部公開URL（OGP と JSON-LD）。片方に寄せると、消える側の URL は SNS のカード・検索エンジンのキャッシュで 404 になる。GitHub Pages では任意の画像URLにリダイレクトを設定できない。
- 削減は 130,489 bytes（全体の1.5%）にとどまり、URL を壊すリスクに見合わない。
- 画質は同一（完全一致）のため、どちらを正本にしても見た目は変わらない。

共通化する場合の正本と修正対象（参考）:
- **正本を `ogp-interior-rigging-frame_1200x675.jpg` にする**場合: 上表の `interior-rigging-frame_1200.jpeg` 側（ページ4ファイル・JSON-LD 1か所・テスト2か所）を書き換える。OGP の URL は変わらない。ただしギャラリー画像に `ogp-` 名のファイルを使うことになり、命名の意味がずれる。
- **正本を `interior-rigging-frame_1200.jpeg` にする**場合: 6ページ12箇所の `og:image` / `twitter:image` を書き換える。SNS 側は再クロールまで旧 URL（404）を参照し続け、シェアカードの画像が出ない期間が生じうる。

付記（本Issueの範囲外・参考）: この OGP 画像は 1200×675（16:9）で、推奨の 1.91:1（1200×630）ではない。差し替えるなら新しいファイル名で追加し、旧ファイルは残すのが安全。

## 同一写真の別形式・別寸法（すべて維持）

用途が違うため維持する。ファイルの同一性だけで配信用途を無視しない。

| グループ | 使い分け |
|---|---|
| `interior-rigging-frame_1200.{webp,jpeg}` / `_1600.{webp,jpeg}` / `ogp-interior-…` | 1200: ギャラリー（WebP＋JPEGフォールバック）、1600: `styles/common.css` の背景 `image-set()` と `en.html` の preload、ogp: SNSカード |
| `studio-nagoya-base-hero-ogp.{webp,jpg}` | WebP: トップのヒーロー表示、JPG: OGP（SNSはWebP非対応のサービスがある） |
| `hero_survey_1200.webp` ＝ `ogp-survey-1200x630.jpg` | アンケートページのヒーロー表示 / OGP |
| `hero_mens_survey_1200.webp` ＝ `ogp-mens-survey-1200x630.jpg` | mens アンケートのヒーロー / OGP |
| `mens-preview-hero.webp`（1600×841）≒ `mens-preview-ogp-1200x630.jpg` | mens ヒーロー / OGP（13箇所） |
| `images/backdrop-color-white_1200.webp` ＝ `studio-x/images/studiox_white_1200.webp` | 同じ白背景の写真を mens と Studio X がそれぞれのブランド配下で保持。ブランド境界（`test/member-benefits-web.test.js` は他ブランド画像の流用を禁止）を守るため統合しない |
| `studio-x/images/sample_02_four_color_collage_1200.webp` ＝ `studio-x-event-0905-classroom-gallery-01.webp` | Studio X トップ「教室セット」/ 9/5 イベントページ。前者は**名前（4色コラージュ）と中身（教室の写真）が一致していない**が、URL維持を優先してリネームしない |

## 配置（移動）の評価

### 案A（推奨）: 既存画像は場所を維持し、新規画像から用途別フォルダを使う

- 移動ゼロ。公開URL・テスト・GAS に影響しない。
- `images/` 直下の混在は残るが、下記の命名規則でファイル名の接頭辞から用途が判別できる（既存もおおむね `gallery_` / `hero_` / `backdrop-` / `pattern-` / `interior-` / `ogp-` で揃っている）。

### 案B: 外部公開URLを持たない `images/` 直下の画像だけ用途別フォルダへ移動（36件）

上表「移動案B」列の36件（`gallery/` 18、`backdrops/` 8、`hero/` 5、`interior/` 4、`branding/` 1。OGP・favicon・equipment・Studio X は移動しない）。

- 書き換えは **約120箇所・15ファイル**: `index.html`、`en.html`、`mens/index.html`、`mens/preview-633.html`、`mens/survey/index.html`、`survey/index.html`、`feedback/{snb,mens}/index.html`、`styles/common.css`、`_data/studio_x_equipment.json`、`gas/booking/shared/EquipmentCatalog.gs`、テスト4本。
- **`backdrop-tiedye-gray` / `pattern-*` は `_data/studio_x_equipment.json` から生成される予約GAS（`EquipmentCatalog.gs`）にパスが入っている**ため、移動すると予約システムの再生成・GAS本番デプロイが必要になる。予約ロジック・本番設定を変えないという本Issueの制約に抵触するため、案Bを採る場合もこの3件は移動対象から外すべき。
- 画像検索・外部サイトからの直リンクは確認できないため、旧URLの404化リスクはゼロとは言えない。

### `images/equipment/` と `studio-x/images/`

- `images/equipment/`（8件）: 既に用途別フォルダ。`/equipment/` と `/studio-x/equipment/` の共通 include から参照され、`equipment-wireless-commander.webp` は両ページの OGP 絶対URL。**維持**。
- `studio-x/images/`（30件）: ブランド配下の公開アセット。参照される18件は Studio X ページ・`_data/studio_x_worlds.yml` から相対パスで使われ、OGP 絶対URLが5件ある。**場所は維持し、削除候補の整理のみ**を提案。細分化は件数（整理後18〜21件）に対して効果が小さい。

## 命名・配置ルール案（Phase 2 で README に記載する想定）

新しく追加する画像に適用する。既存ファイルはリネームしない（URL互換性を優先）。

| 用途 | 置き場所 | 命名 | 例 |
|---|---|---|---|
| ロゴ・favicon | `images/`（既存のまま） | 固定名 | `logo.svg` |
| ヒーロー | `images/hero/` | `hero-<ページ>_<長辺>.webp` | `hero-booking_1200.webp` |
| ギャラリー作例 | `images/gallery/` | `gallery-<テーマ><連番2桁>_<長辺>.webp` | `gallery-lighting06_1200.webp` |
| 内観 | `images/interior/` | `interior-<被写体>_<長辺>.<形式>` | `interior-shower_1200.webp` |
| 背景・柄見本 | `images/backdrops/` | `backdrop-<種類>-<色>_<長辺>.webp` / `pattern-…` | `backdrop-color-green_1200.webp` |
| 機材 | `images/equipment/` | `equipment-<機材>.webp` | 既存どおり |
| OGP / SNS | `images/ogp/` | `ogp-<ページ>-1200x630.jpg`（JPEG・1200×630） | `ogp-news-1200x630.jpg` |
| Studio X | `studio-x/images/` | `studio-x-<用途>-<被写体>.<形式>` | `studio-x-event-1010-halloween-hero.webp` |

- 表示用は WebP。OGP は JPEG（SNS の WebP 非対応対策）。`<picture>` の JPEG フォールバックは、使うときだけ追加する。
- **ファイル名は中身と一致させる**（`sample_02_four_color_collage` のような不一致を作らない）。
- 差し替えは**上書きせず新しいファイル名**（`-v2` 等）で追加し、OGP など外部公開URLの旧ファイルは残す。
- `preview` / `v2` / 連番などの名前だけで不要と判断しない。削除前に `node scripts/image-inventory-852.js` で参照ゼロを確認する。

## Phase 2 で行う確認（承認後の別PR）

- 承認された削除・移動のみ実施し、`node scripts/image-inventory-852.js` で「現行参照のある画像が消えていない」「公開ページ（HTML / CSS）の未解決参照ゼロ」を確認（`npm test` の `test/image-inventory-852.test.js` が同じ条件を検証する）。
- Jekyll ビルド前後の出力URL一覧の差分、全画像のデコード確認、OGP表示確認、PC/SP表示、`npm test`。
- 予約・決済・会員・個人情報・SwitchBot/GAS のロジックと本番設定は変更しない。Git履歴の書き換えはしない。

## 復元方法

削除した場合でも、基準SHA `92e5af553e8b9bd8bd040f418b439234a3f136b6` から `git checkout 92e5af5 -- <path>` で復元できる。

## 先輩に判断いただきたい点

1. 削除候補9件（`studio-x/images/` の旧 `archive/` 用素材）を Phase 2 で削除してよいか。
2. 要判断3件（`sample_01_blackboard_1200.webp`・`studiox_guide.webp`・`studiox_lighting_1200.webp`）を残すか削除するか。特に `studiox_guide.webp` のサイト外利用の有無。
3. 完全一致の2件は「共通化せず維持」でよいか。
4. 配置は案A（既存は移動しない・新規から用途別フォルダ）でよいか。案Bを採る場合、予約GASに入っている背景3件は除外する。
5. 上の命名・配置ルール案を README に載せてよいか（Phase 2 で記載）。
