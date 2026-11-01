# プライバシーポリシー改定予告（180日自動消去）— Issue #690 第1段階

親Issue #680 / 実施Issue #690。コードの配布と自動消去の開始は別。**この変更は自動消去を有効化しない**（トリガー作成・有効化・実データ消去なし）。

## 方式（#608と同じ二段階）
| 段階 | 内容 | 時期 |
| --- | --- | --- |
| 第1段階（本PR） | お知らせ（`_data/news_ja.yml`）に改定予告を掲載。ポリシー本文は**変更しない** | 公開（マージ）日 = 告知日 |
| 第2段階（別PR） | 下記「差替え案」で各版のポリシー本文を差し替え、最終改定日を更新 | 効力発生日（告知日から14日以上後） |

## 日付の扱い
- 告知日 `2026年11月1日`、効力発生日 `2026年11月15日` は**候補**。実際の公開（マージ）が11月1日を過ぎる場合は、`_data/news_ja.yml` の日付・本文の日付・`test/privacy-retention-notice-690.test.js` の定数を公開日に合わせて更新する（バックデートしない）。
- 現行ポリシー11項の「効力発生日の14日前まで」を満たすこと（テストで検査）。
- 効力発生日は規約の適用日であり、**自動消去の開始日ではない**。開始は #690 の条件（技術確認・Stripe条件確認・告知期間経過・開始直前のdry-run）完了後。

## 各版への告知（第1段階で届ける面）
お知らせ（`news_ja`）は `index.html`・`news/index.html` にしか描画されないため、各版に次を追加した（ポリシー本文は現行のまま）。
| 版 | 予告本文 | 入口のリンク |
| --- | --- | --- |
| SNB／SNB mens（日本語） | `_includes/legal_ja.html` の `#privacy-notice`（`legal/`・`mens/legal/` 共通） | `mens/index.html` の法的事項欄から `/mens/legal/#privacy-notice` |
| 英語 | `legal/en.html` の `#privacy-notice`（英語で内容を記載。日本語のお知らせへのリンク付き） | `en.html` の Legal 欄から `legal/en.html#privacy-notice` |
| Studio X | `studio-x/legal/index.html` の `#privacy-notice` | `studio-x/index.html` フッターから `legal/#privacy-notice` |

## 14日の数え方（手順）
1. 全版（上記＋お知らせ）が**実際に公開（デプロイ完了・表示確認）された日**を告知日とする。マージ時刻ではない。
2. 効力発生日 ≥ 全版の公開確認日 + 14日。1つでも公開が遅れた版があれば、その公開確認日から数え直し、全版の日付を揃えて直す（バックデートしない）。
3. 第2段階のPRで本文を差し替えるとき、`.legal-notice`（予告ボックス）と入口リンクを削除する。テストはその時に更新する。

## 適用される版の棚卸し（本文の差替え対象 = 第2段階）
| 版 | ファイル | 該当項 |
| --- | --- | --- |
| SNB（日本語） | `_includes/legal_ja.html` → `legal/index.html` | プライバシーポリシー6項「管理と保管」、10項、最終改定日 |
| SNB mens（日本語） | `mens/legal/index.html`（同じ `legal_ja.html` を include） | 同上（共通） |
| 英語 | `legal/en.html`（`#privacy` 4項「Management and Retention」） | 4項 |
| Studio X | `studio-x/legal/index.html`（`#privacy` 4項「管理と保管」） | 4項 |

`how-to/`・予約フォーム等はポリシーへのリンクのみで本文を持たない。英語のお知らせデータはないため、英語利用者には `legal/en.html` と `en.html` で直接予告する（上記）。`archive/` はアーカイブのため対象外。

## 第2段階の差替え案（レビュー用・未公開）
最終文面は、実装（`gas/booking/README.md` Issue #680節）と一致することを確認して確定する。

### 日本語（SNB / SNB mens / Studio X 共通の趣旨）
> 予約・会員等の台帳（スプレッドシート）に記録した氏名・メールアドレス・電話番号・連絡事項等の個人情報は、利用終了・取消確定・退会後の資格終了等、情報ごとに定める起算日時から180日が経過した後、対象条件を満たしたものを日次処理で消去します（セルの内容を空にします。予約の識別番号、日時、金額、状態、決済の識別情報など、取引の照合に必要な情報は残ります）。次の情報は対象から除外します：有効な会員情報、将来の予約、未精算・返金・紛争等の対応中の情報、起算日時や予約・会員との紐付けを確認できない記録。取引の照合・会計等に必要な限定記録は、別に保持します。台帳の版の履歴、メール、カレンダー、Stripe等の外部サービスに残る情報は、この処理の消去対象に含まれません。

### 英語（`legal/en.html` 4項）
> Personal information recorded in our booking and membership ledgers (such as name, email address, phone number and messages) is erased by a daily process once 180 days have passed from a start date defined for each type of information (for example, the end of use, confirmed cancellation, or the end of eligibility after membership withdrawal), provided the record meets the eligibility conditions. Active membership information, future bookings, information related to unsettled payments, refunds or disputes, and records whose start date or link cannot be verified are excluded. A limited set of transaction records needed for reconciliation and accounting is retained separately. Version history of the ledgers, email, calendar, and information remaining in external services such as Stripe is not covered by this process.

### 書かないこと
- 「すべての情報が180日で消える」「匿名化済み」（台帳には照合可能なIDが残る。README明記）。
- 「540日で必ず消える」「稼働済み」。540日保持は運営方針として採用済みだが、**540日後の限定記録の消去は現コードでは未実装**。第2段階の文面で期間の数字を載せるかは、後続実装との整合をレビューで確定する（本PRのお知らせは数字を載せない）。
- 実ファイルURL・ID・顧客情報・予約ID・決済ID・メール本文。

## 本PRの範囲外（#690の残り）
- 2. 書き戻し競合の検証（独立ロック・合成データ。実装が必要なら別PR）
- 3. Stripe固有条件の運営者確認
- 4. 開始操作（告知期間経過後、運用担当の単一アカウント）
