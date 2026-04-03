# Studio Nagoya Base - 親リポジトリ イシュー追跡

> 最終更新: 2026-04-04
> 親リポジトリと子リポジトリ（Studio-nagoya-base/）の変更内容を統合管理

---

## 実施済み変更（後追いイシュー化）

### Issue A: STRATEGY.md - 集客戦略ドキュメントの作成

**作成日**: 2026-03-28  
**関連Issue**: #16「LPが緊縛寄りすぎて新規流入を取りこぼしている問題」

**概要**:
市場分析に基づいた集客戦略ドキュメント（171行）が作成されました。

**主要な分析内容**:
- 緊縛需要の構造的天井分析：月5〜7件が現実的な上限と推定
- 上前津駅の立地価値：大須商店街の玄関口、平日3万人/日、土日7万人/日
- 世界コスプレサミット（毎年8月）：25万人超、大須がメイン会場
- コスプレイヤー70.2%が「撮影場所がない」と不満
- 当スタジオの時間単価（¥3,250/時間）は市場平均（¥1,313/時間）の2.5倍

**顧客セグメント戦略**:
- 緊縛セグメント：供給制約（縄師不足）が最大障壁
- コスプレセグメント：月複数回のリピーター型利用、市場規模が大きい
- 高価格帯プレミアム化：差別化要素の明確化が必須

**ファイル**: [STRATEGY.md](STRATEGY.md)

**完了条件**:
- [ ] STRATEGY.md が版管理される
- [ ] 戦略に基づくLP改修案の検討
- [ ] 顧客セグメント別マーケティング計画の作成
- [ ] 価格戦略の再評価

---

### Issue B: ataru/ ブランド - 新規プロジェクトの追加

**追加日**: 2026-04-04  
**独立リポジトリ**: https://github.com/nagoya-base/ataru-nagoya.git

**概要**:
新規ブランド「ataru」のWebサイトと関連コンテンツが追加されました。独立したプロジェクトとして管理され、別リポジトリにsubtree pushされています。

**ファイル構成**:
```
ataru/
├── index.html             - ランディング/入り口ページ（231行）
├── main.html              - メインコンテンツページ（1002行）
├── profile.html           - プロフィール/紹介ページ（26行）
└── images/
    ├── 224A2715.jpeg      - 製品/サービス画像
    ├── 224A2815.jpeg
    ├── 224A3035.jpeg
    ├── 224A3124.jpeg
    ├── 224A3127.jpeg
    ├── 224A3130.jpeg
    ├── 224A3133.jpeg
    ├── DSC03598.jpeg
    ├── DSC03600.jpeg
    ├── IMG_3149.jpeg
    ├── IMG_3771.jpeg
    ├── IMG_5723.jpeg
    ├── IMG_7264.jpeg
    ├── IMG_7268.jpeg
    ├── IMG_7269.jpeg
    ├── IMG_7276.jpeg
    ├── IMG_7278.jpeg
    └── IMG_7741.jpeg      （計18枚）
```

**最近の変更（親リポジトリのコミット履歴）**:
1. **Set profile.html background to black to prevent white flash on redirect** (8591c6e)
   - UX改善：リダイレクト中の白いフラッシュを防止
   
2. **Make all redirects instant: profile→cushion and cushion OK→main** (bbba73b)
   - ページ遷移の高速化
   
3. **Add safe X-shareable entrance page and fix cushion exit to Google** (d32de31)
   - X（Twitter）で安全に共有可能なエントランスページを追加
   
4. **Fix ataru/main.html: add missing </style> tag before age-check script** (6d1a320)
   - HTMLバグ修正

**確認項目**:
- [ ] ataru の事業目的とstudio-nagoya-baseとの関係性の明確化
- [ ] age-check（年齢確認）スクリプトの実装目的確認
- [ ] X（Twitter）シェアリング機能の動作確認
- [ ] 独立リポジトリ（ataru-nagoya.git）の運用方針確認
- [ ] SEO設定（robots.txt, sitemap.xml）の確認
- [ ] 公開ステータス（プライベート/パブリック）の決定

---

### Issue C: ギャラリー画像の更新と整理

**実施日**: 2026-04-04

**概要**:
メインサイト（index.html, en.html）のギャラリー画像が更新され、images/ ディレクトリが整理されました。

**変更内容**:
```
【追加/新規画像】
- images/224A3274.jpg
- images/224A3294.jpg
- images/224A3295.jpg
- images/224A3299.jpg
- images/IMG_2263.jpeg
- images/IMG_2264.jpeg
- images/IMG_2265.jpeg
- images/IMG_2310.jpeg
- images/IMG_2311.jpeg
- images/IMG_2312.jpeg

【ファイル移動（ディレクトリ整理）】
224a3228.jpeg → images/224a3228.jpeg
224a3237.jpeg → images/224a3237.jpeg
224a3254.jpeg → images/224a3254.jpeg
IMG_7421.jpeg → images/IMG_7421.jpeg
logo.svg      → images/logo.svg

【ファイル削除】
なし（全て保残）
```

**HTMLファイル更新**:
- **index.html**: 102行変更（ギャラリーセクション、画像パス更新）
- **en.html**: 117行変更（英語版の同期更新）

**完了条件**:
- [x] 新規画像ファイルがimages/に配置された
- [x] 既存画像がimages/に移動された
- [x] index.html と en.html が更新された
- [ ] ギャラリー表示が正常に動作することをブラウザテスト
- [ ] 画像最適化（圧縮）の検討
- [ ] alt テキストの適切性確認

---

### Issue D: キャッシュバスティング・リダイレクト・UX改善（ataru）

**実施日**: 2026-04-03  
**実装者**: Claude

**概要**:
ataru（新規ブランド）で複数のUX改善と技術最適化が実施されました。

**実装内容**:

#### 1. リダイレクト高速化（bbba73b）
- profile → cushion（クッション）ページへの即座リダイレクト
- cushion「OK」ボタン → main ページへの即座リダイレクト
- UX改善：ページ遷移の遅延を排除

#### 2. X（Twitter）シェアリング対応（d32de31）
- **新機能**: 年齢確認後、セキュアなX共有エントランスページを提供
- **実装**: `ataru/profile.html` に年齢確認ロジックを追加
- **機能**: クッションボタン「OK」押下後、Xで自由に共有可能な状態へ遷移

#### 3. CSS/HTMLバグ修正（6d1a320）
- **Issue**: `ataru/main.html` に `</style>` タグ不足
- **修正**: age-check スクリプト実行前に正しい構文に修正

#### 4. UXポーランド（8591c6e）
- **Issue**: profile.html → cushion リダイレクト時、白いフラッシュが発生
- **修正**: `profile.html` の背景色を `black` に設定し、背景色でマスキング
- **効果**: ページ遷移時の視覚的な違和感を排除

**技術スタック**:
- JavaScript: age-check スクリプト（組み込み）
- HTML/CSS: 画面遷移フロー最適化

**確認項目**:
- [ ] ataru/main.html の年齢確認スクリプトが正常に動作
- [ ] profile.html のリダイレクト動作確認
- [ ] X シェア機能の動作テスト
- [ ] モバイル端末での表示確認（背景色フラッシュの排除確認）
- [ ] ブラウザ互換性確認

---

## 管理メモ

**リポジトリ構成対応**:
- 親リポジトリ（Studio-nagoya-base/）：メインサイト + ataru/
- 子リポジトリ（Studio-nagoya-base/Studio-nagoya-base/）：イシュー追跡用
- 独立リポジトリ（ataru-nagoya/）：ataru ブランドの独立管理

**Subtree Push設定**:
```bash
git subtree push --prefix=ataru https://github.com/nagoya-base/ataru-nagoya.git main
```

**同期ワークフロー**:
1. 親リポジトリで変更 → git add/commit/push
2. ataru/ に対する変更は自動で ataru-nagoya.git にsubtree push
3. 子リポジトリ（Studio-nagoya-base/）でイシュー化・ドキュメント化

**次回実施予定**:
- [ ] STRATEGY.md に基づくLP改修
- [ ] ataru ブランドの事業目的書の作成
- [ ] SEO最適化（sitemap.xml, robots.txt の検証）
- [ ] 画像最適化とCDN配信検討
