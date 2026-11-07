# リポジトリ整理 棚卸しレポート（Issue #837）

> **本書は調査結果と削除「提案」のみ。ファイルの削除・移動・本番操作は一切行っていない。** 削除可否は先輩（オーナー）のレビューで決定する。

- 調査基準: main `50fbe4632e5dbfd78e567642ff69c7a453fc1c05`
- 調査方法: 全ファイルに対する文字列参照検索（`grep -r`、`.git` 除外）、`_config.yml`・`sitemap.xml`・`README.md`・`test/`・`.github/workflows/` の確認、各 README の記載確認。ファイル名だけでの未使用判定はしていない。

## 判定区分

`削除可` / `GitHub外へ保管後に削除` / `整理・注記` / `維持` / `要判断`

## 一覧

| 候補 | 容量 | 参照状況（根拠） | 判定（提案） |
|---|---|---|---|
| `_evidence-633` | 5.9MB / 18件 | 外部（workflows・test・scripts・`_config.yml`・`sitemap.xml`）からの参照なし。ただし `_evidence-656/check-compare-width.js` が `mens/preview-633.html` を参照（スクリプト内のみ） | GitHub外へ保管後に削除 |
| `_evidence-651` | 11MB / 25件 | 外部参照なし。README に「証跡のみ・マージ不要」 | GitHub外へ保管後に削除 |
| `_evidence-653` | 6.0MB / 28件 | 外部参照なし | GitHub外へ保管後に削除 |
| `_evidence-656` | 0.4MB / 5件 | 外部参照なし。計測JS（`check-compare-width.js`）を含む。`test/mens-preview-633.test.js` は別ファイルで独立 | GitHub外へ保管後に削除 |
| `_evidence-658` | 1.8MB / 11件 | 外部参照なし | GitHub外へ保管後に削除 |
| `_evidence-660` | 8.2MB / 49件 | 外部参照なし。計測JS4本（`check-*.js`、`measure-scroll.js`）を含む。再現テストとして使われているか未確認 | 要判断（JSのみ維持、画像は保管後削除が候補） |
| `_evidence-662` | 4.8MB / 27件 | 外部参照なし。印刷確認PDF（`after-print-*.pdf`）を含む | GitHub外へ保管後に削除 |
| `_evidence-665` | 1.7MB / 11件 | 外部参照なし。README なし | GitHub外へ保管後に削除 |
| `_evidence-679` | 1.8MB / 3件 | 外部参照なし。README なし | GitHub外へ保管後に削除 |
| `archive/`（3件） | 約0.1MB | 公開URL `/archive/`・`/archive/how-to/` として配信中。`noindex,nofollow` 設定済み。`sitemap.xml` には非掲載。参照は `README.md:330`（GA測定ID一覧）と `docs/privacy-retention-notice-690.md:26`（対象外の記載）のみ。トップ等からの導線なし | 要判断（旧URLの継続要否。削除するなら README の記載更新も必要） |
| `docs/mens-phase1〜4` | 約0.2MB | `test/membership-web-copy.test.js:324` が4ファイルを参照（存在・注記の検証）。Phase4 は冒頭に旧制度の無効注記あり | 整理・注記（削除不可。削除するとテストが落ちる。移動する場合はテスト更新が必要） |
| `ISSUE_tracking.md` | 7.8KB | 参照なし。2026-04-04 時点の旧追跡文書。`STRATEGY.md` を参照 | 要判断（現行運用で使っていなければ削除可） |
| `ISSUE_update_gallery.md` | 6.2KB | 参照なし。旧Issue本文の転記 | 要判断（削除可の可能性が高い） |
| `STRIPE_INTEGRATION_TODO.md` | 6.9KB | 他からの参照なし。ただし #516 の残作業の「単一正本」と自己申告 | 維持（決済関連・保護対象。Stripe作業の完了確認後に再判断） |
| `deep-research-report 4.md` | 19KB | 参照なし。ファイル名に空白あり。SpaceMarket集客分析（出典マーカー `citeturn…` が残存） | GitHub外へ保管後に削除（または `docs/` へ整理） |
| `STRATEGY.md` / `REVIEW_CHECKLIST.md` | 8.7KB / 9.5KB | `REVIEW_CHECKLIST.md` は `test/member-benefits-web.test.js` 等が内容を検証 | 維持（削除すると既存テストが落ちる） |
| `pdf/`（11件） | — | 利用者向けマニュアル | 維持（原則保護） |

## 補足事項

1. **`_evidence-*` は Jekyll の標準仕様（先頭 `_`）でビルド出力に含まれない。** 削除してもGitHub Pagesの公開物には影響しない。一方、repo のクローン容量は約41.9MBぶん減る。
2. 画像・PDFは Git 履歴に残るため、削除してもコミット履歴から復元できる（下記）。「GitHub外へ保管」は、履歴取得が不便になる場合の保険として提案している。
3. `docs/` の SwitchBot / booking 系文書（`docs/switchbot-*` など）は本調査の対象外。保護対象として維持する。

## 保護対象（今回触らない）

`gas/`, `booking/`, `admin/`, `cloud-run/`, `_data/`, `_includes/`, `test/`, `.github/workflows/`, 現行公開ページ・画像・CSS・法務文書、`pdf/`、予約・決済・会員・SwitchBot関連一式。

## 復元方法（削除を実施した場合）

- 削除PRのマージ前コミットから復元: `git checkout <削除前のSHA> -- <path>`
- 現時点の基準SHA `50fbe4632e5dbfd78e567642ff69c7a453fc1c05` から復元可能。
- history rewrite / force-push は行わない。

## 次のステップ（レビュー後）

1. 先輩が上表の判定を確認し、削除対象を確定する（特に `要判断` 行）。
2. 確定後に**別PR**で削除し、削除一覧・差分・復元方法を記載する。
3. その PR では次を確認する: 既存テスト・CI、Jekyll ビルド、公開ルート、`README.md` の記載、予約・会員・料金表示、決済・個人情報保持、管理画面・SwitchBot連携への非影響。

## 先輩に判断いただきたい点

- `archive/` の旧URL（`/archive/`）は不要か。
- `_evidence-660` の計測JS（4本）を再現用に残すか。
- `ISSUE_tracking.md` / `ISSUE_update_gallery.md` / `deep-research-report 4.md` は不要か。
- 「GitHub外へ保管」は Git 履歴で足りるか、別途アーカイブ（zip等）を作るか。
