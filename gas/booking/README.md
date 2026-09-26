
## Issue #344: 管理者による確定済み予約の日時変更（実装レビュー中）

- 対象は **Booking Adminプロジェクトのみ**（管理者用Web App: Execute as Me / Only myself）。
  `gas/booking/admin/BookingReschedule.gs`を同プロジェクトへ追加し、
  `gas/booking/shared/SpreadsheetRepository.gs`と
  `gas/booking/admin/BookingAdminWeb.gs`を更新する。
  GitHub Pages側の`admin/booking/booking-admin.js`・`booking-admin.css`も同時に反映する。
  **GASコード追加時は既存Booking Adminのデプロイを更新し、現在の`/exec` URLを維持する。**
  公開Booking Web Appへ`BookingReschedule.gs`を追加しない。
- 予約詳細から変更日・開始・終了を入力し、空き確認→変更前後の比較→管理者確認→変更確定。
  既存の予約ID、決済状態、CalendarイベントIDを維持し、Calendarイベントの開始・終了と
  Bookingsのdate/startAt/endAtを更新する。対象はCONFIRMEDのみ。
  当日変更は変更後の開始が現在より未来の場合のみ許可する。
- 変更対象自身のみ重複判定から除外し、他のCalendarイベントとの前後バッファを確認する。
  確定時はLock内で再確認する。ただし公開Booking Web Appや外部Calendar書き込みとは
  スクリプトLockが共有されないため、完全な競合排除は保証しない。
- `BookingChanges`シートを自動作成し、変更前後の日時、変更理由（任意）、管理者入力の
  精算案内、変更日時、メール送信状態を保存する。変更メールは変更後の状態を再確認して送る。
  失敗が確認されたメール（FAILED）のみ管理画面から明示的に再送できる。
  SENDING等の結果不明状態は二重送信防止のため自動再送しない。
- 変更後の日付が変わった場合、前日リマインドと来場案内のSentAtをクリアする。
  元の確定メールSentAtや支払履歴は変更しない。
- テスト: `node --test test/booking-reschedule.test.js`。
  本番GAS・Calendar・Stripeへの接続テストは行わず、レビューと管理者の本番テスト後に反映する。

### Issue #344追記: 料金差額の自動計算（PR #345レビュー対応で再設計。実装レビュー中）

上記の日程変更機能に、料金差額の自動計算を追加した。**初版（レビュー前）はここに独自の
料金表・祝日判定（`FeeMasterRepository.gs`のバージョン付き`FeeMaster`シート・
`JapanHolidays.gs`）を持っていたが、PR #345レビューで次の指摘を受け、再設計した:**

- Issue #344とは別に、Issue #342/#343（新規予約の料金自動計算）・Issue #346/#347
  （日本の祝日・振替休日・国民の休日判定）が並行してmainへマージされており、
  `gas/booking/shared/BookingPricing.gs`・`gas/booking/shared/JapaneseHolidays.gs`という
  レビュー済み・テスト済みの正本が既に存在していた。日程変更専用に別の料金表・祝日判定を
  持つことは「料金表はここ1箇所のみに定義する」というBookingPricing.gsの設計方針に反し、
  改定時に食い違うリスクがある（`FeeMasterRepository`と`JapaneseHolidays`との重複）。
- 旧`FeeMasterRepository`の`effectiveAt='2020-01-01'`は、実際にいつから有効だったか
  確認できないのに2020年からと決め打ちしていた、根拠のない偽装だった。

**再設計の結果、`FeeMasterRepository.gs`・`JapanHolidays.gs`は削除し、料金の正本は
`BookingPricing.gs`・祝日判定の正本は`JapaneseHolidays.gs`に一本化した。** この2ファイルを
Booking Adminにも追加し（従来はBooking Web App専用）、新規ファイル
`gas/booking/shared/FeeCalculator.gs`（30分刻みへの丸め・差額判定・キャンセル規定との突合の
純粋関数のみ）・`gas/booking/shared/FeeSettlementRepository.gs`（精算の冪等性台帳。
`FeeSettlements`シート）を追加し、`BookingReschedule.gs`・`SpreadsheetRepository.gs`
（Bookings末尾に列を追加）・`BookingAdminWeb.gs`・`admin/booking/booking-admin.js`/`.css`を
拡張した。**いずれもBooking Adminプロジェクトのみ（公開Booking Web Appには追加しない。
ただしBookingPricing.gs/JapaneseHolidays.gsは既存どおりBooking Web Appにも必要）。**

**現在の確定金額・価格区分は独自の列を持たず、Issue #342/#343の料金基盤
（`priceAmount`/`priceTier`/`priceOverrideAmount`/`priceOverrideAt`/
`Booking.getEffectivePriceAmount`）をそのまま再利用する。** 日程変更で価格が変わった場合は
`priceOverrideAmount`/`priceOverrideAt`を更新する（PENDING予約の確定前金額修正
[`updateBookingPrice`]と同じ「現在の実効金額」の仕組みを、CONFIRMED予約の日程変更にも
再利用する形。`needsPriceUpdateNotice`はPENDING限定の判定のため干渉しない）。

- **30分刻みの丸めは承認済みの方針（30分単位で計算・変更確定時点の最新料金表を適用）
  だが、2.5h/3.5h等の半端な時間の具体的な金額をどう補間するかは未承認のまま。**
  `FeeCalculator.quoteFee`は、丸め後の時間が整数時間（2h/3h/4h、またはそれを超える整数時間）
  に一致する場合のみ`BookingPricing.computeBookingPrice`（唯一の正本）へ委譲して金額を返す。
  半端な30分単位になる場合は`HALF_HOUR_RATE_UNCONFIRMED`を返し、**金額を一切自動算出しない**
  （管理者が`manualNewFeeAmount`/`manualNewFeeNote`で金額と理由を明示しない限り確定できない）。
  料金表に定義が無い組み合わせ（mens×通常・studio_x×会員等）も同じ扱い。
- **既存予約は金額が未記録のため（Issue #342以前に作成された予約）、日程変更を確定する前に
  必ず`backfillOriginalPrice`（`adminBackfillOriginalPrice`）で元の確定料金・価格区分
  （会員/通常）を管理者が照合して入力する必要がある。** `Booking.getEffectivePriceAmount`が
  nullを返す間は`commit`（`adminRescheduleBooking`）自体が`FEE_BASELINE_REQUIRED`で失敗する
  （Web UIの「基準料金」欄から入力する）。Issue #342以降に作成された予約は`priceAmount`が
  自動的に記録済みのため、この手順は不要。
- 差額の扱い（`FeeCalculator.assessScheduleChangeFee`）は変更なし: 増額は単純な追加請求。
  「初めての日程変更」かつ「変更前利用日の前日まで」の減額のみキャンセル料なしの返金候補を
  自動算出する。それ以外の減額（2回目以降・当日）は、規約上どちらとも決められないため
  **自動では一切金額を作らず**、管理者が金額（0〜差額/未返金額の範囲）と理由を明示的に
  入力しない限り`commit`は`FEE_REFUND_DECISION_REQUIRED`で失敗する。
- **料金マスタの「版」概念は廃止した。** `BookingPricing.gs`の料金表はデプロイされた
  コードに焼き込まれた定数であり、実行時にスプレッドシート等を編集して書き換える経路が
  無いため、「previewで見た版と確定直前の版が食い違う」という事態はコード構造上
  発生し得ない（新しい価格を反映するには新しいコードのデプロイが必要で、GASは
  デプロイ後の全実行に新バージョンを一貫して適用する）。旧`expectedFeeMasterVersion`・
  `FEE_VERSION_MISMATCH`は削除した。
- **日時更新後の料金関連フィールド（現在の確定金額・変更回数・精算状態）は
  `SpreadsheetRepository.updateBookingRescheduleFeeAtomic`で1回の`Range.setValues`として
  更新する（PR #345レビュー必須修正1）。** この書き込みが失敗した場合、`commit`は
  `success:false`（`FEE_UPDATE_FAILED_RECOVERY_REQUIRED`）を返し、`feeRecoveryRequiredAt`を
  立てて以降の`commit`/`recordFeeSettlement`を一律ブロックする（「成功扱いで握りつぶす」
  「変更回数だけ旧値のまま残る」ことを構造的に禁止する）。日時自体の変更（Calendar/
  Bookingsのdate/startAt/endAt）はこの障害が起きても元に戻さない（既に完了した物理的な
  予定変更を、料金台帳の失敗を理由に再度ロールバックするとさらなる失敗のリスクを重ねる
  ため）。ブロックされた予約は`resolveFeeRecovery`（`adminResolveFeeRecovery`）で、管理者が
  Bookings・BookingChanges・Google Calendarを直接確認したうえで正しい値を入力し、
  復旧する。
- **`recordFeeSettlement`にLock・精算ID（`settlementId`）・精算履歴
  （`FeeSettlementRepository.gs`の`FeeSettlements`シート）を追加した（PR #345レビュー
  必須修正2）。** 同一`settlementId`の再送・二重クリック・通信エラー後の再実行は、内容が
  完全一致する限り安全（二重加算しない。既存のFeeSettlements行の結果をそのまま返す）。
  内容が異なれば`SETTLEMENT_ID_CONFLICT`で拒否する。`changeId`を指定した場合はそれが
  対象の`bookingId`に属することを検証する（`INVALID_CHANGE_ID`）。返金額は未返金の実入金額
  （`feePaidAmount - feeRefundedAmount`）を超えられない（`REFUND_EXCEEDS_UNREFUNDED`）。
  Bookings側への反映に失敗した場合はFeeSettlements行を`FAILED_NEEDS_RECOVERY`にし、
  `feeRecoveryRequiredAt`で予約をロックする（精算履歴と台帳の片方だけが更新された状態を
  放置しない）。
- 料金の確定と資金移動は引き続き分離している。Stripe等への自動請求・自動返金は一切行わない。
- 変更通知メールに、元料金・新料金・差額・返金/追加請求の状況（試算か承認済みかを明記）を
  追記した。
- テスト: `node --test`（`test/japanese-holidays.test.js`・`test/booking-pricing.test.js`
  ・`test/fee-calculator.test.js`・`test/fee-settlement-repository.test.js`・
  `test/booking-reschedule.test.js`・`test/booking-admin-page-client.test.js`に今回分を
  含む）。本番GAS・Calendar・Stripeへの接続テスト、既存予約への一括金額埋めは
  別途指示まで行わない。
- 実装前の規約上の未決定事項（30分料金の正式な数値、2回目以降の日程変更・当日短縮への
  キャンセル料の掛け方、有料機材・キャンペーン・会員パスの返金取扱い）は、上記の
  フェイルクローズな仕組みで「管理者が都度判断する」形にとどめており、コード側で
  仮の事業ルールとして決定していない。

#### PR #345再レビュー対応（複合障害・冪等性の強化）

上記の必須修正1・2に対する再レビューで、想定より深刻な複合障害（片方の永続化に成功し、
もう片方が失敗するケース）が繰り返し指摘され、そのたびに以下を追加で対応した:

- **`recordFeeSettlement`のPENDING_APPLY/ABANDONEDからの再適用は、実際にBookingsへ
  反映される直前に必ず`FeeSettlementRepository.markPendingApply`で状態を
  「反映結果未確定」に戻してから進む。** Bookingsへの書き込みに成功した直後、精算履歴の
  状態遷移・`feeRecoveryRequiredAt`の保存が両方失敗しても、この行はABANDONEDのまま
  （＝未反映を騙ったまま）残らず、無条件の自動再試行を禁止する既存のPENDING_APPLY
  安全策がそのまま働く。
- **`feeRecoveryRequiredAt`（Bookings側）の保存自体が失敗しても、`commit`・
  `recordFeeSettlement`・`backfillOriginalPrice`は`FeeSettlementRepository.
  hasUnresolvedSettlement`（未確定精算の有無）を独立した第二の停止条件として必ず確認する
  （`isBlockedForFeeRecovery_`）。** `resolveFeeRecovery`の受付判定もこれと同じ基準に
  統一し、フラグが立っていないケースで復旧要求そのものが拒否される
  （＝ブロックされているのに誰も解除できない）デッドロックを防いでいる。
- **`resolveFeeRecovery`の`settlementResolution`は、対象`settlementId`が既に
  `APPLIED`/`ABANDONED`の場合、反対の結果へ変更する操作を`SETTLEMENT_STATE_MISMATCH`で
  拒否する。** 既に確定済みの精算を復旧操作で書き換えられると、その後の再送で二重計上に
  つながるため。ただし「精算履歴の確定には成功したがBookingsの反映が失敗し、同じ内容で
  `resolveFeeRecovery`を再実行する」という正規の複合障害リカバリ経路は、同一outcome・
  同一確定累計値の冪等な再実行として引き続き許可する。
- **精算金額（`recordFeeSettlement`のdelta、`resolveFeeRecovery`の累計額）は、有限・
  整数（円単位）・安全な整数範囲内であることに加え、返金済み額が支払済み額を超えないことを
  検証する。** 既存の累計額自体が壊れている（非整数・返金超過）場合は0円扱いにして計算を
  続けず、`FEE_RECOVERY_REQUIRED`で止めて人による照合を要求する。

#### 基準料金5列の書込み結果が不明になる複合障害への対応（「書く前にintentを確保する」設計）

`backfillOriginalPrice`（基準料金5列: `priceAmount`/`priceTier`/`priceDayType`/
`priceIsMember`/`priceComputedAt`の一括書込み）は、Lock保護・`isBlockedForFeeRecovery_`
によるガード・`updateBookingPriceBaselineAtomic`（`SpreadsheetRepository.gs`。5列を
1回の`Range.setValues`で更新）を使う。**最初の実装では「書込みが失敗してから復旧記録を
残す」順序だったため、Bookings側の`feeRecoveryRequiredAt`保存まで失敗する複合障害では
どこにも痕跡が残らず、次回リクエストを自動でブロックできない問題があった。さらにその場を
「失敗後にRecoveryへ記録し、それも失敗したらScript Propertiesへ退避する」という
多段フォールバックで塞ごうとしたが、レビューで「同じ障害への対処を何層も増やすのではなく、
更新前に復旧記録を確保する順序へ設計を変更する」よう指摘され、そちらへ置き換えた。**

現在の設計は次の順序で進む（`RecoveryRepository.gs`の既存`Recovery`シート・`HEADERS_`を
そのまま使う。列は変更しない）:

1. **基準料金5列に一切触れる前に**、`RecoveryRepository.recordFailure`で
   `failureType: 'BASELINE_WRITE_UNCERTAIN'`, `recoveryState: 'OPEN'`の行（intent）を
   記録する。`appendRow`の応答を信頼せず、`hasOpenBaselineRecovery`で読み直して
   確認する。
2. intentの記録・確認ができなければ、**危険な書込みそのものを開始せず**Bookingsを
   一切変更しないまま`RECOVERY_INTENT_UNCONFIRMED`で中止する。
3. intentが確認できた場合のみ、`updateBookingPriceBaselineAtomic`で5列を書き込み、
   再取得して5列すべてが期待値と一致するか検証する。書込みが例外を投げた場合・
   一致しない場合は、intent（Recovery OPEN）をそのまま残す（`feeRecoveryRequiredAt`の
   設定は管理画面表示用にbest effortで試みるが、ブロック判定の必須条件ではない）。
4. 書込み・検証に成功した場合のみ、`RecoveryRepository.resolveBaselineRecovery`で
   intentを`RESOLVED`にする。この解消自体が失敗した場合もOPENを残し、要復旧のまま
   維持する（`updateBookingPriceBaselineAtomic`は絶対値の上書きなので、同じ内容で
   `resolveBaselinePriceRecovery`を再実行すれば安全に解消できる）。

この設計により、「基準料金の書込み結果が不明、かつ復旧記録も残せない」という組合せは
発生し得ない（intentを先に確保・確認できなければ、そもそも危険な書込みを始めないため）。
`isBlockedForFeeRecovery_`は`feeRecoveryRequiredAt`／`FeeSettlements`の未確定精算／
`RecoveryRepository.hasOpenBaselineRecovery`のいずれかが真であればブロックし、これらの
判定自体が例外を投げた場合もフェイルクローズ（ブロックする）で返す。`commit`・
`recordFeeSettlement`・`backfillOriginalPrice`・`resolveFeeRecovery`の全ガードをこれに
揃えている。

復旧は`resolveFeeRecovery`（`priceOverrideAmount`等、日程変更専用のBookings列）とは別の
専用API`resolveBaselinePriceRecovery`（`adminResolveBaselinePriceRecovery`）で行う。
`backfillOriginalPrice`は基準料金5列と確認済み入出金額2列（`feePaidAmount`/
`feeRefundedAmount`）を別々のRangeへ書き込むため、片方だけが保存された状態が起こり得る。
そのため復旧APIも`backfillOriginalPrice`と同じ入力（価格区分・金額・確認根拠`note`・
`confirmedPaidAmount`（必須）・`confirmedRefundedAmount`（省略時0円））を必須とし、
7項目を再書込み（絶対値の上書き）・再取得して**7項目すべての一致**を確認し、さらに
確認根拠の監査行（`BASELINE_PRICE_CONFIRMED`）の保存を読み戻して確認できた場合に
のみ`RecoveryRepository.resolveBaselineRecovery`でintentを解消する（基準料金5列だけが
一致しても、入出金額が未反映のままなら`UPDATE_FAILED`で要復旧のまま維持する）。基準料金の要復旧が
唯一の原因で`feeRecoveryRequiredAt`が立っていた場合は、これに合わせてクリアする（他に
未確定精算が残っていれば触らない）。

テスト: `test/booking-reschedule.test.js`（intentの記録前にBookingsへ触れないこと、
intent確認前に書込みを開始しないこと、書込み失敗・不一致時にintentがOPENのまま残ること、
Recovery読取自体の例外に対するフェイルクローズ、`resolveBaselinePriceRecovery`の
正常系・異常系、基準料金は保存済みで入出金額の保存だけが失敗した場合に入出金額を照合する
まで解消しないこと、入出金額・確認根拠の必須検証）・`test/booking-spreadsheet-repository.test.js`（`RecoveryRepository.
hasOpenBaselineRecovery`/`resolveBaselineRecovery`の単体テスト）・
`test/booking-admin-web.test.js`（`getAdminBookingDetail`の`baselineRecoveryNeedsAttention`）。

#### previewとcommitの料金算出結果の照合（`feeQuoteToken`）

管理画面は`preview`（`adminPreviewBookingReschedule`）で料金差額・返金候補を表示し、
管理者が内容を確認してから`commit`（`adminRescheduleBooking`）で確定する2段階の流れに
なっている。この間に他の変更（別の日程変更・精算記録・基準料金の復旧など）が入ると、
画面に表示されていた料金情報と実際に確定される料金情報がずれてしまう可能性があった。

これを防ぐため、`buildFeeQuoteToken_`が料金判定に使う主要な値（`feeReady`/`feeStatus`/
`priceTier`/`oldFeeAmount`/`scheduleChangeCount`、算出できた場合は`newFeeAmount`/
`dayType`/`roundedMinutes`/`feeDifference`/`refundStatus`/`refundCandidateAmount`/
`cancellationPolicyCategory`）だけをJSON文字列化した「見積りトークン」を組み立てる。
`preview`はこのトークンを`feeQuoteToken`として結果に含め、管理画面はこれを保持したまま
`commit`（`adminRescheduleBooking`の7番目の引数`expectedFeeQuoteToken`）へ渡す。
`commit`はコミット直前に同じ入力から`feeQuoteToken`を再計算し、渡された値と完全一致
（文字列比較）しなければ、Calendar・Bookings・履歴のいずれにも触れずに
`FEE_QUOTE_MISMATCH`で拒否する（手動の料金/返金決定が併せて渡されていても同様に拒否する。
古い前提のまま決定を通してしまわないため）。`expectedFeeQuoteToken`はサーバー側でも
必須で、省略・空文字・文字列以外の場合は照合をスキップせず、Calendar・Bookings・履歴の
いずれにも触れずに`FEE_QUOTE_TOKEN_REQUIRED`で拒否する（previewを経ない呼び出し経路を
塞ぐため）。暗号学的なハッシュではなく、
あくまで「プレビュー時点と同じ計算結果か」を確認するための一致チェックである。

管理画面（`admin/booking/booking-admin.js`）は`preview.feeQuoteToken`を保持し、確定操作の
たびに渡す。`FEE_QUOTE_MISMATCH`を受け取った場合は「プレビュー時点から料金情報が変わった」
旨を表示し、確定ボタンを無効化して再プレビューを促す。

テスト: `test/booking-reschedule.test.js`（`feeQuoteToken`を伴う正常なcommit、
プレビュー後に料金コンテキストが変化した場合の`FEE_QUOTE_MISMATCH`、手動の料金/返金決定が
併せて渡されていても古いトークンでは拒否されること、トークン省略時の
`FEE_QUOTE_TOKEN_REQUIRED`）。

#### `backfillOriginalPrice`の確認済み支払済み/返金済み額の必須化と監査ログ

`backfillOriginalPrice`は元々、基準料金5列（確定料金・区分・日タイプ等）だけを設定し、
支払済み額・返金済み額は別途「精算の記録」（`recordFeeSettlement`）で入力する想定だった。
しかし、旧仕様の予約（基準料金・入出金額とも未設定のまま残っている既存予約）を移行する際、
`recordFeeSettlement`は差分（delta）方式のため、実際にはすでに支払われている額を
「今回新たに入金された額」として計上してしまうと二重計上になる。かといって基準料金だけ
設定して支払済み額を0円のまま放置すると、その後の日程変更で「未確認のまま0円として扱う」
ことになり、実際に支払われた金額が返金候補の計算から漏れてしまう。

このため、`backfillOriginalPrice`は`confirmedPaidAmount`（必須）・
`confirmedRefundedAmount`（省略時は0円）を新たな引数として受け取るようにした:

- `confirmedPaidAmount`は0以上の安全な整数（円単位）であることを必須とする
  （`CONFIRMED_PAID_AMOUNT_REQUIRED`）。省略・不正値を「未確認＝0円」と黙って
  解釈することはない。
- `confirmedRefundedAmount`（省略時0円）も0以上の整数であることを検証し、
  `confirmedPaidAmount`を超える場合は`REFUND_EXCEEDS_UNREFUNDED`で拒否する。
- 検証済みの2値は、基準料金5列と同じLock・同じRecovery intentの下で
  `updateBookingRescheduleFeeAtomic`（`feePaidAmount`/`feeRefundedAmount`の絶対値上書き）
  により書き込む。`recordFeeSettlement`/`FeeSettlementRepository.appendPending`は経由
  しないため、この移行操作によってFeeSettlementsに「新たな入金があった」かのような行が
  作られることはない。
- 基準料金5列・`feePaidAmount`・`feeRefundedAmount`の計7項目すべてが再取得後に一致した
  場合のみ成功とする（一方の書込みが例外を投げても、もう一方は独立して試行したうえで、
  最終的な検証は7項目すべてを対象にする）。不一致の場合は既存の複合障害対応と同じ経路で
  `feeRecoveryRequiredAt`のbest effort設定・Recovery intent（OPEN）維持により後続操作を
  ブロックする。
- 保存が成功した場合、管理者が入力した確認根拠（`note`）と確認した金額を
  `RecoveryRepository.recordFailure`へ`failureType: 'BASELINE_PRICE_CONFIRMED'`,
  `recoveryState: 'INFO'`として記録する（ブロックには使わない、監査用の追記のみ）。
  検証が終わったからといってこの根拠を捨てず、誰が・いつ・何を根拠にいくらと確認したかを
  Recoveryシートに残す。**監査行は`RecoveryRepository.hasRecord`で読み戻して保存を
  確認し、確認できるまでは処理を完了扱いにしない。** 保存を確認できない場合（書込みの
  例外、例外なしで保存されない、読み戻し自体の失敗）は`AUDIT_RECORD_UNCONFIRMED`を返し、
  保存済みの基準料金・入出金額は取り消さずに、書込み前に確保したRecovery intent（OPEN）を
  残して後続操作をブロックする。管理者は`resolveBaselinePriceRecovery`へ同じ内容と
  確認根拠を渡して記録を再試行し、監査行の保存を確認できた時点でintentが解消される。

管理画面（`admin/booking/booking-admin.js`の`renderFeeBaselineSection_`）は基準料金の
設定・修正フォームに「確認した支払済み額」「確認した返金済み額」の入力欄を追加し、
`adminBackfillOriginalPrice`へ渡す。基準料金の要復旧フォーム（`renderBaselineRecoverySection_`）
にも同じ「確認した支払済み額」「確認した返金済み額」「確認根拠」の入力欄を設け、
`adminResolveBaselinePriceRecovery`へ渡す（支払済み額の空欄は0円ではなく未入力として
サーバー側で拒否させる）。

テスト: `test/booking-reschedule.test.js`（`confirmedPaidAmount`省略・負数・小数の拒否、
`confirmedRefundedAmount`が`confirmedPaidAmount`を超える場合の拒否、省略時に0円扱いに
なること、書込み後の`feePaidAmount`/`feeRefundedAmount`確認、`BASELINE_PRICE_CONFIRMED`
監査行の記録内容、基準料金移行後の予約が次回日程変更の返金候補計算に正しく反映されること、
監査行の保存失敗・例外なしの未保存・読み戻し失敗で`AUDIT_RECORD_UNCONFIRMED`になり
要復旧のまま維持されること、`resolveBaselinePriceRecovery`での監査記録の再試行）。

# gas/booking（自社予約システム）

Epic #265の一部として以下を実装済み。

- **Issue #266**: `getAvailability`（読み取り専用の空き判定）
- **Issue #268**: `createBooking`（Studio X限定の仮予約作成）・予約台帳（Spreadsheet）・
  PENDING/CONFIRMED/CANCELLED/EXPIRED状態管理・部分失敗補償・TTL失効・レート制限・
  Spreadsheetカスタムメニューからの予約確定
- **Issue #269**: `createBooking`をSNB / SNB mens / Studio Xの3ブランドへ正式拡張し、
  3ブランド共通の予約UI（`booking/` / `mens/booking/` / `studio-x/booking/`）から
  実際にPENDING予約を作成できるようにした（詳細は「Issue #269: 3ブランド対応と
  共通予約UI」参照）
- **Issue #270**: 当日予約の可否を「会員かどうか」ではなく「この施設（SNB / SNB mens /
  Studio Xは同一施設）の利用経験があるか」で判定するようにした。利用区分
  （`first_time`/`returning`）を共通予約UI・createBooking・Sheets台帳に追加し、
  GAS側でも「当日＋初回利用」を`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`で拒否する。
  さらにレビュー対応として、`getAvailability`/`createBooking`の両方で「当日の
  過去開始時刻」を拒否し（`SAME_DAY_START_TIME_PASSED`）、PENDING TTLも
  「当日受付・開始2時間未満」の予約が作成直後に即EXPIREDにならず、かつ利用開始後まで
  PENDINGが残らないよう調整した（詳細は「Issue #270: 当日利用ルールと利用経験判定」参照）
- **Issue #271**: 予約通知メール（仮予約受付・確定・前日リマインド+来場案内）の自動送信、
  キャンセルメールの送信ロジック（呼び出し配線自体は#272）、送信履歴・エラーの
  Spreadsheet記録、SentAtによる二重送信防止、管理者による個別再送、前日リマインド用
  時間主導トリガー作成関数を実装した。実メール送信・本番Script Properties設定・
  本番トリガー作成はこのPRでは行わない（詳細は「Issue #271: 予約通知メール自動送信」参照）
- **Issue #272**: 管理者キャンセル（`cancelBookingAdmin(bookingId)`）を実装し、
  PENDING/CONFIRMED→CANCELLEDの状態遷移・Calendarイベント削除による枠の再開放・
  Sheets台帳の`cancelledAt`/`updatedAt`更新・#271の`sendCancelledMailForBooking`への
  接続・Spreadsheetカスタムメニューからのキャンセル操作（YES/NO確認付き）・
  Calendar/Sheetsの部分失敗のRecovery記録・Sheets行が無い場合のCalendar診断を
  実装した。Booking Admin側のみに追加し、公開Web Appにはキャンセルエンドポイントを
  一切公開しない（詳細は「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」参照）
- **Issue #305**: Booking Adminを個人用のシンプルなWeb UI（`BookingAdminWeb.gs` +
  `BookingAdminPage.html`）化した。新しい予約管理ロジックは作らず、既存の
  `confirmBooking(bookingId)`/`cancelBookingAdmin(bookingId)`（いずれも変更なし）への
  薄いラッパーのみを追加し、一覧・詳細はSpreadsheetRepository.gsの読み取り専用関数
  （新規`getAllBookings()`）を使う。Booking Adminプロジェクトを従来のSpreadsheet UI拡張＋
  時間主導トリガーに加えてWeb Appとしてもデプロイする（Execute as: Me / Only myself。
  詳細は「Issue #305: Booking Admin Web UI化（個人用シンプルMVP）」参照）
- **Issue #317**: Booking Admin Web UIのフロントエンド（CSS/JavaScript）をGitHub Pages
  （`admin/booking/booking-admin.css` / `admin/booking/booking-admin.js`）へ外部化し、
  `gas/booking/admin/BookingAdminPage.html`を薄いローダーにした。通常のフロントエンド
  変更（表示文言・カードUI・ソートUI等）はGitHub Pages側の更新のみで反映でき、GAS Web App
  の再デプロイは不要になった。バックエンド（`BookingAdminWeb.gs`・既存4つの
  `google.script.run` API・confirm/cancel/expire/reminder等の業務ロジック）は無変更。
  `customerType`の表示（`first_time`→「初回利用」/`returning`→「利用経験あり」）も
  あわせて修正した（詳細は「Booking Adminフロントエンドの外部化（Issue #317）」参照）

このディレクトリは自社予約システム専用のApps Scriptプロジェクトの元になるソース一式
（複数プロジェクトへ配布するファイル群）として運用し、`gas/ataru_survey_public` 等の
既存GASプロジェクトとは完全に分離する（互いのコードを参照・importしない）。

**このディレクトリのファイルは、2つの独立したApps Scriptプロジェクトへ配布する。**
Googleの仕様上、Spreadsheetのカスタムメニュー（`SpreadsheetApp.getUi()`）は
対象Spreadsheetへコンテナバインドしたスクリプトからしか作成できないため、
Web App本体とは別にコンテナバインドの管理用プロジェクトを用意する（詳細は
「GASプロジェクトへのデプロイ対象ファイル」節を参照）。

| プロジェクト | 種別 | 役割 |
| --- | --- | --- |
| **Booking Web App** | スタンドアロン | `getAvailability`（`doGet`）・`createBooking`（`doPost`）・管理者通知 |
| **Booking Admin** | `SPREADSHEET_ID`のSpreadsheetへコンテナバインド | カスタムメニュー（`onOpen`）・`confirmBooking(bookingId)`・`cancelBookingAdmin(bookingId)`（Issue #272）・PENDING TTL失効（`expirePendingBookings`の時間主導トリガー） |

`confirmBooking`と`expirePendingBookings`は、いずれもBooking Adminプロジェクトに
配置し、同じ`LockService.getScriptLock()`を共有させることで、PENDING→CONFIRMEDと
PENDING→EXPIREDが同時に進んでCalendar/Sheetsが不整合になる競合を構造的に排除している
（3回目レビュー指摘対応。詳細は「PRレビュー（3回目）指摘への追加対応」参照）。
`cancelBookingAdmin`（Issue #272）も同じBooking Adminプロジェクト・同じLockServiceに
加えたため、この3関数の間では常に1つの状態遷移だけが成立する（詳細は
「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」参照）。

## ディレクトリ構成

このリポジトリ内で、`gas/booking/`配下は配布先のGASプロジェクトごとに
サブディレクトリへ分けて管理している。

```text
gas/booking/
  shared/   Booking Web App・Booking Adminの両方が使う共通コード
  public/   Booking Web App（利用者向け・スタンドアロン）固有のコード
  admin/    Booking Admin（コンテナバインド）固有のコード
  README.md
```

| プロジェクト | 配布元 | 配置先 |
| --- | --- | --- |
| **Booking Web App** | `public/` + `shared/`の指定ファイル | 同一のGASプロジェクトへまとめて配置 |
| **Booking Admin** | `admin/` + `shared/`の指定ファイル | 同一のGASプロジェクトへまとめて配置 |

**注意: Apps Scriptエディタ内にはGitHubのフォルダ構造は再現されない。**
`clasp`等のデプロイ自動化は本リポジトリに未導入で、現状はいずれも手動コピーで
デプロイしており、各GASプロジェクト内ではファイル名の重複さえなければ
`shared/`・`public/`・`admin/`という区別に関わらずファイルがフラットに
（サブフォルダなしで）並ぶ。このリポジトリ側のディレクトリ分けは、あくまで
「どのファイルをどちらのGASプロジェクトへコピーするか」を管理しやすくするための
ソース管理上の整理であり、GAS側の実行結果・ファイル名・関数名には一切影響しない
（具体的な配布ファイル一覧は次節「GASプロジェクトへのデプロイ対象ファイル」参照）。

## このIssue（#268）で実装した範囲

- `createBooking`（Studio Xのみ。POST専用API）
  - サーバー側入力検証 → abuse/rate limit確認 → LockService取得 → Calendar再確認 →
    競合チェック → bookingId発行 → CalendarにPENDINGイベント作成 → Spreadsheet台帳へ保存
    → Lock解除 → 管理者通知（Lockの外・失敗しても予約は成功のまま）
  - 利用者送信時は必ずPENDING（送信即CONFIRMEDにはならない）
  - Lock取得後にCalendarを再取得し、直前の占有状況を再確認してから予約を作る
    （#267との境界。スペースマーケット由来・管理者手入力・その他の時間指定イベントを
    タイトルで区別せず、すべて占有として扱う）
- Spreadsheet予約台帳（`Bookings`シート）・部分失敗記録（`Recovery`シート）
- PENDING TTL失効（`expirePendingBookings()`。時間主導トリガー用）。
  Spreadsheetカスタムメニューからの予約確定（`confirmBooking(bookingId)`）と同じ
  コンテナバインドの別GASプロジェクト（Booking Admin）から実行し、同じLockServiceを共有する
- レート制限（同一メール・全体・同一内容連投）

## このIssueで実装していないもの（非対象。#268時点）

- Studio Nagoya Base / SNB mensでの予約作成（Phase 1はStudio Xのみ。**#269で解消。
  下記「Issue #269: 3ブランド対応と共通予約UI」を参照**）
- `#269` 以降の共通予約UI実装（フロントエンドからcreateBookingを呼ぶ画面。**#269で実装**）
- `#271` 利用者向けメール通知（仮予約受付・確定・キャンセル・前日リマインド・来場案内）。
  本Issueで送るのは管理者向けの最低限の内部通知のみ
- `#272` 管理者キャンセル機能（**#272で実装済み**。詳細は
  「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」参照）
- `#273` 本番切替（既存予約フォーム・`_includes/calendar_embed.html`の撤去、
  Studio Nagoya Base / SNB mens側の予約導線切替を含む）
- 料金自動計算・決済・会員DB照合
- 既存予約フォーム（`studio-x/reservation/`）・`_includes/calendar_embed.html`の変更/撤去

## Issue #269: 3ブランド対応と共通予約UI

Issue #268で `studio_x` 限定だった`createBooking`を、SNB（緊縛スタジオ本体） / SNB mens /
Studio Xの3ブランドへ正式に拡張し、3ブランド共通の予約UIから実際にPENDING予約を
作成できるようにした。

### 採用したbrand識別子・bookingId prefix・表示名

既存コードに正式なbrand識別子が無かったため、Issue #269本文の指定どおり
`snb` / `mens` / `studio_x` を採用した（`gas/booking/Availability.gs`のコメントで
Issue #265/#266時点から既にこの3値が前提として書かれていたことも確認済み）。
brand文字列・prefix・表示名は`Booking.gs`の`ALLOWED_BOOKING_BRANDS` /
`BRAND_ID_PREFIX_` / `BRAND_LABELS_`（`Booking.getBrandLabel`）に一元管理し、
他ファイル（`CalendarRepository.gs` / `AdminNotifier.gs`等）はbrand文字列や
表示名を直接持たない。

| brand識別子 | 表示名（Calendar/管理者通知） | bookingId prefix | 例 |
| --- | --- | --- | --- |
| `snb` | SNB | `SNB` | `SNB-20261001-3F2A9B1C` |
| `mens` | SNB mens | `MENS` | `MENS-20261001-3F2A9B1C` |
| `studio_x` | Studio X | `SX`（**Issue #268から変更なし**） | `SX-20261001-3F2A9B1C` |

未知のbrandは従来どおり`INVALID_BRAND`で拒否する（`ALLOWED_BOOKING_BRANDS`にない
文字列は一切許可しない。brand偽装対策）。

### サーバー側（GAS）の変更点

- `Booking.gs`: `ALLOWED_BOOKING_BRANDS`を3ブランドへ拡張。`BRAND_ID_PREFIX_`に
  `snb`/`mens`のprefixを追加（`studio_x`の`SX`は変更しない）。ブランド表示名を返す
  `Booking.getBrandLabel(brand)`を追加。
- `CalendarRepository.gs`: Calendarイベントのタイトルを`[ブランド表示名 状態] bookingId`
  の形式に一般化し、`Booking.getBrandLabel`経由でブランド名を取得するようにした
  （以前は`[Studio X ...]`にハードコードしていた）。`setEventStatus`はイベント作成時に
  `setTag('brand', ...)`済みのタグから表示名を再取得するため、呼び出し側の
  シグネチャは変更していない。**空き判定・状態判定のロジック自体はタイトル文字列にも
  brandにも一切依存しない**（3ブランドとも同一Calendar・同一室のため、Availability.gsは
  Issue #265/#266時点から変更していない）。
- `AdminNotifier.gs`: 管理者通知メールの件名を`[ブランド表示名] 仮予約を受け付けました: ...`
  に一般化した（以前は`[Studio X] ...`固定）。
- `BookingRepository.gs` / `SpreadsheetRepository.gs` / `Availability.gs` / `Config.gs` /
  `RateLimiter.gs`は**変更なし**（brandはすでに`input.brand`としてパイプライン全体を
  透過しており、Sheetsの`brand`列・CalendarEventの`brand`タグへも元から正しいbrandが
  保存されていた。Issue #268時点の制約は`ALLOWED_BOOKING_BRANDS`の一覧のみだったため）。

### 変更していないこと（#269の意図的なスコープ外）

- **Calendarはbrandごとに分けない。** 3ブランドとも同一室のため、引き続き
  `CALENDAR_ID`ひとつだけを共有する（Web App・Calendar・Spreadsheetともに1つのまま。
  ブランド別API・別Web Appも作らない）。
- **空き判定ロジックをbrandで分岐させない。** `Availability.gs`は無変更。SNBで作られた
  予約はmens/Studio Xの`getAvailability`でも塞がり、mens/Studio Xの予約もSNBから見て
  塞がる（相互に競合する。テストは「テストの実行」節参照）。
- `#271`（利用者向けメール）・`#272`（管理者キャンセル）・`#273`（本番切替・
  旧導線撤去）はこのIssue（#269）時点ではいずれも実装していない（`#270`は
  「Issue #270: 当日利用ルールと利用経験判定」、`#271`は「Issue #271: 予約通知メール
  自動送信」、`#272`は「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」
  でそれぞれ実装済み）。

### 共通予約UI（フロントエンド）

3ブランドともHTML/JSをコピーせず、以下を共通で使う。

| ファイル | 役割 |
| --- | --- |
| `_includes/booking_app_ja.html` | 予約ウィザードの共通マークアップ（日時→空き時間→利用者情報→確認→完了の5ステップ） |
| `scripts/booking-logic.js` | DOM非依存の共通ロジック（エラーメッセージ変換・入力検証・ペイロード組み立て等。`test/booking-logic.test.js`でテスト） |
| `scripts/booking-app.js` | DOM配線・`getAvailability`/`createBooking`の呼び出し |
| `styles/booking.css` | 共通スタイル（SNB/mensの`styles/common.css`とStudio Xの`studio-x/style.css`、テーマ変数名が異なる両方をCSS変数のフォールバック連鎖で吸収し、ブランドごとにCSSを複製しない） |
| `scripts/booking-config.js` | **Booking Web AppのURLを設定する唯一の場所**（3ブランド共通。`BASE_URL`が空の間はAPIを呼ばず「準備中」の案内を表示する） |

ブランドごとに変わるのは、ページ側（`booking/index.html` / `mens/booking/index.html` /
`studio-x/booking/index.html`）が`_includes/booking_app_ja.html`へ渡す
`brand` / `back_url` / `back_label` / `intro_note`のみ。空き判定・最低利用時間・
15分刻み・競合判定のような業務ルールはフロント側に複製せず、`getAvailability`/
`createBooking`の応答をそのまま表示する（GASを正とする）。

`createBooking`へのPOSTは`Content-Type: text/plain;charset=utf-8`で送る
（本文は引き続きJSON文字列）。Apps ScriptのWeb Appは`doOptions`を実装していないため、
`application/json`を指定するとブラウザのCORSプリフライト(OPTIONS)が失敗する。
`text/plain`はCORSセーフリストに含まれるためプリフライトが発生せず、
`Code.gs`の`handleCreateBooking_`はContent-Typeの値に関わらず`e.postData.contents`を
常に`JSON.parse`するため、この送り方でサーバー側の処理は変わらない。

**本番デプロイ・本番URLへの接続はこのPR（#269）では行っていない。**
`scripts/booking-config.js`の`BASE_URL`は空文字のままで、共通予約UIは
「オンライン予約準備中」の案内を表示するのみ（実際のCalendar/Spreadsheetへは
一切書き込まない）。本番デプロイ後にこの1ファイルのURLを差し替えることで
3ブランドとも接続される（本番デプロイ自体は`#273`の責務）。

### 既存導線との関係

`studio-x/reservation/`（Formspreeの予約・撮影相談フォーム）・
`_includes/calendar_embed.html`・トップページ/mensページの既存予約カレンダー導線は
**このPRでは一切変更・撤去していない**。共通予約UIは新しいURL
（`/booking/` `/mens/booking/` `/studio-x/booking/`）を追加しただけで、既存ページから
このURLへリンクする変更もこのPRには含めていない（本番切替・旧導線撤去は`#273`）。

## Issue #270: 当日利用ルールと利用経験判定

当日予約の可否を、**「会員かどうか」ではなく「SNB / SNB mens / Studio Xという同一施設を
過去に利用した経験があるか」**で判定するようにした。3ブランドとも同一施設のため、
どのブランドで利用した経験でも「利用経験あり」として扱う（自己申告。DB照合はしない）。

### 最終仕様

| 利用区分 | 当日予約 | 翌日以降の予約 |
| --- | --- | --- |
| 初回利用 | 不可 | 可（通常フロー） |
| 利用経験あり | 可（通常フロー。PENDINGのまま） | 可（通常フロー） |

- 当日予約も送信時点では従来どおりPENDINGであり、送信即CONFIRMEDにはしない
  （管理者確認後に`confirmBooking`でCONFIRMEDへ遷移させる、という#268からの仕組みは
  一切変更していない）。
- 当日判定は必ず`availabilityConfig.timezone`（既定`Asia/Tokyo`）基準で行う。
  ブラウザのローカルtimezoneには依存しない（`BookingAvailability.formatDateInTimezone`参照）。
- **利用経験あり＋当日でも、開始時刻が現在時刻より後であることを必須とする**
  （現在時刻ちょうども不可。レビュー対応で追加）。今日の空き候補（`getAvailability`）は
  現在時刻より後だけを返し、`createBooking`もCalendar書き込み前に同じ判定を
  再検証する（`SAME_DAY_START_TIME_PASSED`。「当日の過去開始時刻を防ぐ」参照）。
- brandでこのルールを分岐させない。snb/mens/studio_xのいずれでも同じ判定になる。

### 採用した利用区分の内部値

既存コードにこの区分の正式名称が無かったため、Issue #270本文の例示どおり
`first_time`（初回利用） / `returning`（利用経験あり）を採用した。表示文言と
内部値は常に区別し、`gas/booking/Booking.gs`の`CUSTOMER_TYPES`
（`getCustomerTypeLabel`）と`scripts/booking-logic.js`の`CUSTOMER_TYPES`
（`customerTypeLabel`）にのみラベル変換ロジックを持たせている
（フロントstate・createBooking payload・サーバー側validation・Sheets台帳のすべてで
この2値のみを共通利用する）。

### GAS側の変更点

- **`Availability.gs`**: `formatDateInTimezone`（Dateを指定timezone基準の
  `'YYYY-MM-DD'`へ変換）と`getCurrentMinutesInTimezone`（Dateを指定timezone基準の
  「00:00からの経過分」0〜1439へ変換）を追加。どちらもGAS組み込みサービスに
  依存しない純粋関数で、timezoneが不正な場合はnullを返しfail-closedに扱う
  （`Booking.gs`は`BookingAvailability.formatDateInTimezone`を再利用し、
  `Booking.formatDateInTimezone`として薄いエイリアスを公開する）。
  `computeBookableStartTimes`に第4引数`minimumStartMinutes`（省略可）を追加し、
  指定した場合はそれ以前（ちょうど含む）の候補を除外する。`getAvailability`自体も
  第4引数`now`（省略時は現在時刻）を受け取り、`todayString`算出直後に
  **過去日（`date < todayString`）を`INVALID_DATE`で拒否**するようにした
  （2回目レビュー指摘対応。それまでは当日の現在時刻フィルタのみで、過去日自体は
  拒否していなかった）。利用日が当日の場合だけ`getCurrentMinutesInTimezone`で
  現在時刻を求めて`minimumStartMinutes`として渡す（**customerTypeルールは
  getAvailabilityに一切持ち込まない**。当日+初回利用の可否判定は引き続き
  `createBooking`のみの責務）。
- **`Code.gs`**: `handleGetAvailability_`に、Calendarへ問い合わせる前の過去日拒否を
  追加した（`BookingAvailability.formatDateInTimezone`を再利用し、判定ロジックを
  重複実装しない）。`BookingAvailability.getAvailability`内でも同じ判定を行うため
  二重の安全網になるが、過去日リクエストで不要なCalendar API呼び出しを避けるための
  追加（2回目レビュー指摘対応）。
- **`Booking.gs`**: `CUSTOMER_TYPES` / `ALLOWED_CUSTOMER_TYPES` /
  `isAllowedCustomerType` / `getCustomerTypeLabel`を追加。
  `validateCreateBookingInput`に`customerType`の必須検証（未指定・未知の値は
  `INVALID_CUSTOMER_TYPE`でfail-closedに拒否）と、当日判定・同日+初回利用の拒否
  （`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`）、**当日の過去開始時刻の拒否**
  （`SAME_DAY_START_TIME_PASSED`。開始時刻が現在時刻より後であることを必須とする。
  Calendar書き込み前の`validateCreateBookingInput`内で検証するため、フロントや
  `getAvailability`だけに依存しない）を追加した。`validateCreateBookingInput`は
  新たに第3引数`now`（受付時刻）を受け取る（省略時は現在時刻）。
- **`BookingRepository.gs`**: `createBooking`が`validateCreateBookingInput`へ
  `now`を渡すよう変更。Sheets保存用の`record`へ`customerType`を追加。
  `expirePendingBookings`にTTL調整（後述）を追加。
- **`Config.gs`**: `getTtlConfig()`へ`minHoldHours`（`PENDING_TTL_MIN_HOLD_HOURS`。
  既定2。意味は「TTLの変更内容と理由」参照）と`timezone`（`TIMEZONE`と共有）を追加。
- **`SpreadsheetRepository.gs`**: `Bookings`シートのヘッダーへ`customerType`を
  **末尾に追記**（既存行の列を一切ずらさない。詳細は「Sheets変更」参照）。
- **`BookingTriggers.gs`**: グローバル関数`expirePendingBookings()`が`now`引数を
  受け取れるようにした（時間主導トリガーからは引数なしで呼ばれるため本番動作に
  影響しない。テストから受付時刻を固定してTTLを検証できるようにするための変更）。

### createBooking payloadへの追加項目

```json
{
  "brand": "studio_x",
  "customerType": "returning",
  "date": "2026-10-01",
  "startTime": "10:00",
  ...
}
```

`customerType`は`"first_time"`または`"returning"`のいずれか必須。省略・未知の値は
`INVALID_CUSTOMER_TYPE`で拒否する（「API仕様」節参照）。

### 当日の過去開始時刻を防ぐ

当日は「利用経験あり」であっても、開始時刻が現在時刻より後であることを必須とする
（現在時刻ちょうども不可）。判定は`availabilityConfig.timezone`（既定`Asia/Tokyo`）
基準で行い、ブラウザのtimezone・GAS実行環境timezoneのいずれにも依存しない。
過去日（`date < today`）はgetAvailability・createBookingの両方で`INVALID_DATE`
として拒否する（2回目レビュー指摘対応。判定ルールのまとめ:
`date < today` → `INVALID_DATE` / `date === today` → 現在時刻より後の候補・開始時刻のみ許可
/ `date > today` → 従来どおり）。

- `getAvailability`: 過去日は`INVALID_DATE`で拒否する（`handleGetAvailability_`
  （`Code.gs`）でも同じ判定を行い、過去日はCalendarへ問い合わせる前に拒否する）。
  利用日が当日の場合だけ、`getCurrentMinutesInTimezone`で求めた現在時刻（分）より
  後の候補開始時刻のみを返す（`computeBookableStartTimes`の`minimumStartMinutes`）。
  例: JST 10:07に問い合わせた場合、09:00・10:00は候補に出ず、10:15・10:30は
  Calendar競合がなければ候補に出る。
- `createBooking`: Calendar書き込み前の`validateCreateBookingInput`で同じ判定を
  必ず再検証する。フロントの`getAvailability`が過去時刻を除外していても、
  フロント改変や、空き取得から送信までの間に時刻が経過したケースに備え、
  サーバー側で独立して検証する（`SAME_DAY_START_TIME_PASSED`）。
- 当日＋初回利用は、開始時刻が現在時刻より後であっても
  `SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`が先に返る（`SAME_DAY_START_TIME_PASSED`の
  判定に到達するのは実質的に当日＋利用経験ありのみ）。
- 翌日以降はこの判定を一切行わない（現在時刻に関わらず、日付が異なれば従来どおり）。

### 新規error.code

| error.code | 意味 |
| --- | --- |
| `INVALID_CUSTOMER_TYPE` | `customerType`が未指定、または`first_time`/`returning`以外の値 |
| `SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME` | 利用日が当日（Asia/Tokyo基準）かつ`customerType`が`first_time` |
| `SAME_DAY_START_TIME_PASSED` | 利用日が当日かつ開始時刻が現在時刻以前（ちょうど含む） |

いずれも`scripts/booking-logic.js`の`messageForErrorCode`/`recoveryActionForErrorCode`へ
対応する日本語メッセージと回復導線を追加済み。`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`/
`INVALID_CUSTOMER_TYPE`は`reselect-date`（日付・利用区分の選び直しへ誘導）、
`SAME_DAY_START_TIME_PASSED`は`reselect-time`（Step2へ戻り`getAvailability`を
再取得。当日の過去時刻は`getAvailability`側で既に除外されるため、再取得すれば
現在時刻より後の候補のみが表示される）。API直叩きでこれらのエラーが返っても、
フロントは意味不明な`INTERNAL_ERROR`表示にはしない。

### UI側の変更点（共通予約UI）

- Step1（利用日・利用時間）に利用区分の選択（ラジオボタン。「初回利用」/
  「利用経験あり（SNB／SNB mens／Studio Xのいずれかで利用したことがある）」）を追加した。
- 「初回利用」＋当日の組み合わせで「空き時間を確認する」を押すと、`getAvailability`を
  呼ばずにStep1へ留まり、日付欄に理由（「初回利用の方は当日のご予約を受け付けていません。
  翌日以降の日付を選択してください。」）を表示する。翌日以降の日付を選び直せば
  通常どおり進める。
- 「利用経験あり」＋当日は通常どおりStep2（空き開始時刻）へ進み、`getAvailability`を
  呼んで空き時間を表示し、`createBooking`まで進められる。
- Step4（内容確認）に「利用区分」の行を追加し、送信前に選択内容を確認できるようにした。
- 完了画面の「まだ予約は確定していない」「管理者確認後に確定」の文言は変更していない
  （当日予約でも自動確定しない）。
- **これらはすべてUX目的の一次チェックであり、セキュリティ・業務ルールの正はGAS側。**
  フロントを改変してcustomerTypeを省略・改ざんしても、`createBooking`のサーバー側
  検証（`INVALID_CUSTOMER_TYPE`/`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`）で当日制限を
  突破できない。

### Sheets変更

`Bookings`シートのヘッダーへ`customerType`列を**末尾に追記**した（既存の
`bookingId`〜`updatedAt`の19列はそのまま、20列目として追加）。列を追加する際は
必ず末尾へ追記すること。`rowToRecord_`は行の配列インデックスをヘッダーの並び順で
読むため、途中へ挿入すると既存行（過去に`appendBooking`した実際のセルの並び）が
ずれて誤読される。末尾追記であれば、既存行は`customerType`が空（未入力扱い）に
なるだけで、他の列はこれまでどおり正しく読める。`appendBooking` /
`findRowByBookingId` / `updateBookingFields` / `getAllPendingBookings`は
`HEADERS_`定義を経由するため、この追記のみで自動的に整合する
（`SpreadsheetRepository.gs`本体・テストとも追加のロジック変更は不要だった）。

管理者は`Bookings`シートの`customerType`列で「初回利用」/「利用経験あり」
（内部値`first_time`/`returning`。表示ラベル自体は列に保存しない。将来的に
シート側で見やすくしたい場合は`Booking.getCustomerTypeLabel`を使う運用を検討）を
確認できる。

### PENDING TTLの変更内容と理由

**背景（#268時点の課題）**: PENDING TTLは「受付から`PENDING_TTL_HOURS`時間後」と
「利用開始時刻の`PENDING_TTL_MIN_HOURS_BEFORE_START`時間前」の早い方
（`normalExpiry = min(受付+ttlHours, 開始-minHoursBeforeStart)`）。利用経験ありの
当日予約で利用開始まで`PENDING_TTL_MIN_HOURS_BEFORE_START`（既定2時間）未満しか
ない場合、`normalExpiry`が受付時刻以前になり、**失効時刻が受付時刻より前になる＝
作成直後に即EXPIREDになる**可能性があった。

**最初の実装（1回目レビューで指摘・修正）**: 「受付から少なくともminHoldHours時間は
保持する」下限を単純に足す設計にしたところ、例えば09:00受付・09:30開始の予約が
11:00までPENDINGとして残り得る（**利用開始後もPENDINGが残ってしまう**）という
指摘を受けた。

**採用した設計（レビュー対応後）**: `minHoldHours`は「受付から少なくともこの時間は
保持する」という単純な下限ではなく、**「通常TTL計算式（`normalExpiry`）が受付時刻
以前になってしまう直前当日予約にだけ使う最大猶予（grace）」**として再定義し、
**利用開始時刻（`startAt`）を必ず上限とする**（`expiry <= startAt`を保証する）。

```js
var ttlExpiry = createdAtMillis + ttlHours * 3600000;
var normalStartLimit = startAtMillis - minHoursBeforeStart * 3600000;
var normalExpiry = Math.min(ttlExpiry, normalStartLimit);

if (!minHoldHours || minHoldHours <= 0 || normalExpiry > createdAtMillis) {
  return normalExpiry;
}

var graceExpiry = createdAtMillis + minHoldHours * 3600000;
return Math.min(ttlExpiry, graceExpiry, startAtMillis);
```

`normalExpiry`が受付時刻より後（＝開始まで十分な余裕がある）であればgraceを使わず
`normalExpiry`をそのまま返す＝#268時点の計算式とビット単位で完全に同じ値になる。
`minHoldHours`を渡さない場合も同様（`normalExpiry`をそのまま返す）。

`BookingRepository.expirePendingBookings`は、候補行ごとに**受付時刻（`createdAt`）の
暦日（Asia/Tokyo基準）と、その予約の利用日（`date`列）が一致する場合のみ**
（＝当日受付の予約のときだけ）`minHoldHours`（`BookingConfig.getTtlConfig().minHoldHours`。
新規Script Property `PENDING_TTL_MIN_HOLD_HOURS`。既定2時間）を渡す。一致しない
（翌日以降に通常の余裕を持って受け付けた）予約は`minHoldHours=0`のまま、#268時点と
完全に同じTTL計算になる。

**なぜこの設計にしたか**:

- 営業時間（08:00〜23:00）の制約上、「利用日が受付日の翌日以降」の予約は、
  実際には受付から開始まで少なくとも数時間以上の余裕が生じる（日をまたいで
  すぐに開始する翌日予約は構造的に存在し得ない）。そのため「受付日と利用日が
  一致する予約だけ」に対象を絞っても、当日予約の救済という目的を過不足なく
  達成でき、かつ既存の翌日以降予約のTTL計算には数学的に一切影響しない
  （`record.date !== 受付日`の予約は常に`minHoldHours=0`で呼ばれるため）。
- 利用開始時刻を必ず上限とすることで、**当日PENDINGが利用開始後までCalendar/
  Sheets上に残ってしまう事故を防ぐ**（1回目レビュー指摘への対応）。
- `minHoldHours`・brand・customerTypeのいずれもTTL計算式を分岐させない
  （GAS側のみで完結し、フロントの当日判定`isSameDayFirstTimeBlocked`とは独立）。

**当日直前予約のTTLの扱い（09:00受付を例に）**:

| 開始時刻 | 通常式（開始-2h） | 実際のexpiry | 備考 |
| --- | --- | --- | --- |
| 09:30 | 07:30（受付前） | **09:30**（開始時刻） | graceを使うが開始時刻が上限 |
| 10:30 | 08:30（受付前） | **10:30**（開始時刻） | 同上 |
| 11:30 | 09:30（受付後） | **09:30**（通常式のまま） | graceは使わない |
| 12:00 | 10:00（受付後） | **10:00**（通常式のまま） | graceは使わない |

いずれのケースも`expiry <= startAt`（利用開始後までPENDINGが残らない）かつ
`expiry > createdAt`（正常に作成できた予約が作成直後に即EXPIREDにはならない）を
満たす。それでも`PENDING_TTL_HOURS`（既定24時間）による上限（`Math.min`）は
維持されるため、**PENDINGを無期限にはしない**。管理者が利用開始前に確認・
`confirmBooking`すれば、当日予約も通常の予約と同じ手順で確定できる。

**要件との対応**:

- 当日予約が作成直後に即EXPIREDにならない → graceにより`expiry > createdAt`を満たす
- 当日PENDINGが利用開始後まで残らない → graceは`startAtMillis`を必ず上限とする
  ため`expiry <= startAt`を満たす
- 翌日以降の既存TTLを壊さない → 「受付日と利用日が一致する場合のみ」という
  ガードにより、既存のTTL計算式をビット単位で保つ
- PENDINGを無期限にしない → `PENDING_TTL_HOURS`による上限（`Math.min`）は
  従来どおり維持される
- expiry判定をフロントに持たせない → `computeTtlExpiryMillis`/`isExpired`は
  引き続き`gas/booking/Booking.gs`のみに存在し、フロントは一切この判定を行わない
- `expirePendingBookings`のCalendar削除・Sheets EXPIRED更新・recovery記録・
  LockService・`confirmBooking`との排他はいずれも変更していない

### 3ブランド共通であることの確認

当日利用ルール・TTL調整のいずれも、`brand`や`Booking.getBrandLabel`を一切参照しない
（`Availability.gs`と同じ「brandで分岐させない」方針を踏襲）。
`test/booking-model.test.js`・`test/booking-create-booking.test.js`で
snb/mens/studio_xの3ブランドすべてが同じ挙動になることを検証している。

### #271/#272/#273との境界

- `#271`（利用者向けメール通知: 仮予約受付・確定・キャンセル・前日リマインド・
  来場案内）は**実装済み**（詳細は「Issue #271: 予約通知メール自動送信」参照）。
  #268からの管理者向け内部通知（`AdminNotifier.gs`）はこのIssueで変更していない
  （利用者向けメールとは別ファイル・別責務のまま維持）。
- `#272`（管理者キャンセル機能。PENDING/CONFIRMED→CANCELLEDの状態遷移・Calendar削除・
  キャンセルメール呼び出し配線）は**実装済み**（詳細は「Issue #272: 管理者キャンセルで
  Calendar / Sheetsを一貫更新する」参照）。
- `#273`（本番GASデプロイ・本番Web App URL差替・旧フォーム撤去・Calendar embed撤去・
  本番切替・ロールバック実施）は実装していない。`scripts/booking-config.js`の
  `BASE_URL`は引き続き空文字のまま。

### 料金・会員料金との切り分け

「利用経験あり」は当日予約可否の判定にのみ使う。会員料金・割引判定を自動化する
ものではない（Issue #270の非対象）。特にmensページの会員料金表示・「メンズページを
見た」申告等の既存運用は、このIssueでは一切変更していない。

## Issue #271: 予約通知メール自動送信

予約に関する利用者向けメール（仮予約受付・確定・前日リマインド+来場案内）をGASから
自動送信するようにした。キャンセルメールは**送信ロジックのみ**を実装し、実際に
`CANCELLED`成功後に呼ぶ配線は`#272`（管理者キャンセル機能）の責務とした
（**#272で実装済み**。詳細は「Issue #272: 管理者キャンセルでCalendar / Sheetsを
一貫更新する」参照）。

### このIssueで実装した範囲

1. `createBooking`成功後（Calendar/Sheets保存・booking Lock解除後）の、利用者向け
   PENDINGメール（best effort。失敗しても`createBooking`は成功のまま）
2. `confirmBooking`成功後（Calendar/Sheets確定・Lock解除後）の、利用者向けCONFIRMED
   メール（best effort。既にCONFIRMED済みで`confirmedMailSentAt`が空の場合は
   メールだけ再試行する）
3. `CANCELLED`状態の予約に送れるキャンセルメール送信関数（`BookingMailer.sendCancelledMailForBooking`）。
   **呼び出し配線は#272**（このIssueでは状態遷移自体もCalendar削除も実装しない。#272で実装済み）
4. 翌日の`CONFIRMED`予約への前日リマインド（`sendNextDayReminders(now)`）
5. 前日リマインドへ同梱する来場案内（住所・建物・部屋・入口案内・キーボックス位置・
   キーボックス番号・解錠コード・利用案内URL・案内PDF URL）
6. `Bookings`シートへの送信履歴・エラー記録（8列追加。「Sheets変更（Issue #271）」参照）
7. SentAtによる二重送信防止（`LockService`での直列化を含む）
8. 管理者による明示的な個別再送（`{ force: true }`。SentAtを先に消す運用はしない）
9. 前日リマインド用の時間主導トリガー作成関数（`createNextDayReminderTrigger()`。
   本番トリガー作成自体はこのPRでは行わない）
10. ブランド共通のメールテンプレート（`BookingMailTemplates.gs`。SNB/mens/Studio X
    で本文生成ロジックを複製しない）

### このIssueで実装していないもの（非対象）

- `PENDING`/`CONFIRMED` → `CANCELLED`の状態遷移そのもの、Calendar予約削除を伴う
  キャンセル処理、`#272`の管理者キャンセルUI（このIssueでは`sendCancelledMailForBooking`
  という送信関数とテストまでを用意する。いずれも**#272で実装済み**）
- 本番GASデプロイ・本番Script Properties設定・本番トリガー作成・実メール送信
- LINE/SMS通知・Stripe決済メール・PayPay API・外部媒体（スペースマーケット）予約者への
  自社メール送信・会員DB自動照合・動的なスマートロックAPI連携・解錠コードの自動生成/変更

### メール種別とSentAtの対応

| mail type | 送信条件（status） | 対応するSentAt | 二重送信防止 |
| --- | --- | --- | --- |
| `PENDING` | `PENDING` | `pendingMailSentAt` | SentAtが空の場合のみ送信 |
| `CONFIRMED` | `CONFIRMED` | `confirmedMailSentAt` | 同上（既にCONFIRMEDでもSentAt空なら再試行可） |
| `CANCELLED` | `CANCELLED` | `cancelMailSentAt` | 同上（#271では送信関数のみ。呼び出しは#272の`cancelBookingAdmin`で実装済み） |
| `REMINDER` | `CONFIRMED`かつ利用日が翌日（`SpreadsheetRepository.getConfirmedBookingsForDate`で抽出） | `reminderSentAt`と`accessGuideSentAt`（同時記録） | 上記2列のいずれかが空の場合のみ送信 |

`BookingMailer.gs`の`withBookingLock_`が全メール種別共通で以下の順序を守る
（`LockService.getScriptLock()`で直列化）:

```text
Lock取得 → bookingIdで最新レコード再読込 → status確認 → 対応SentAt確認 →
テンプレート生成（設定不足はここでfail-closedに失敗させる） → MailApp送信 →
送信成功 → SentAt更新・lastMailError*クリア → Lock解除
```

`MailApp`と`Spreadsheet`は1つの原子的トランザクションにできないため、「メール送信成功
直後にプロセスが異常終了しSentAtだけ書けない」という理論上の完全なexactly-onceは
保証できない。ただし通常の二重クリック・トリガー重複・再実行・`confirmBooking`の
再実行では、SentAt確認とLockにより二重送信を防ぐ。

### エラー処理（メール送信失敗は予約状態を壊さない）

**最重要**: メール送信の失敗（`BOOKING_MAIL_DISPLAY_NAME`等の設定不足・`TIMEZONE`が
不正でIntlが解釈できない場合のfail-closedな拒否を含む）は、`createBooking`/
`confirmBooking`の成否・`Bookings`シートの`status`のいずれにも影響しない。失敗時は:

- `Bookings`シートの該当行へ`lastMailErrorAt`/`lastMailErrorType`/`lastMailErrorMessage`
  をbest effortで記録する
- `RecoveryRepository.recordFailure`へ`failureType: 'MAIL_<TYPE>_FAILED'`
  （`MAIL_PENDING_FAILED`/`MAIL_CONFIRMED_FAILED`/`MAIL_CANCELLED_FAILED`/
  `MAIL_REMINDER_FAILED`）・`recoveryState: 'OPEN'`で記録する（詳細は
  「Recoveryシート（部分失敗・不整合記録）列構成」参照）
- 次回同種メールの送信に成功すると、`lastMailErrorAt`等は自動的に空へ戻す
- Recovery記録自体・`lastMailError*`更新自体が失敗した場合はLoggerへ最小限記録するのみ
  （利用者への応答・予約処理自体を失敗させない）
- エラーメッセージは例外の`message`のみを`RecoveryRepository`/`lastMailErrorMessage`へ
  記録し、メール本文全文は含めない。**PRレビュー対応（2回目）で、`BookingMailer.gs`の
  `sanitizeErrorMessage_`がメールアドレス形式（正規表現）を`[REDACTED_EMAIL]`へ、
  REMINDER送信時は`ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`の実値が
  万一例外メッセージへ混入した場合も`[REDACTED]`へ置換してから記録するようにした**
  （`BookingMailer.sanitizeErrorMessage`として公開し、`BookingRepository.gs`の
  `notifyCustomerPendingBestEffort_`/`notifyCustomerConfirmedBestEffort_`・
  `BookingReminderTriggers.gs`の`sendNextDayReminders`のLogger出力にも同じ関数を
  適用している）。`sendNextDayReminders`のLoggerには送信失敗時に`bookingId`と
  `error.code`のみを記録し、生のエラーオブジェクトを`JSON.stringify`しない

**fail-safe（来場案内の必須項目）**: `ACCESS_GUIDE_ADDRESS`/`ACCESS_GUIDE_BUILDING`/
`ACCESS_GUIDE_ROOM`/`ACCESS_GUIDE_ENTRANCE`/`ACCESS_GUIDE_KEYBOX_LOCATION`/
`ACCESS_GUIDE_ENTRY_METHOD`/`ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`/
`ACCESS_GUIDE_URL`のいずれか1つでも未設定の場合、前日リマインド（`REMINDER`）を
「成功扱い」にせず送信自体を行わない（`reminderSentAt`/`accessGuideSentAt`は更新
しない。PRレビュー対応で、当初は秘密値2項目のみの検証だったものを来場案内の
必須項目全体へ拡張した）。予約の`status`はCONFIRMEDのまま維持し、`lastMailError*`へ
記録する。`ACCESS_GUIDE_PDF_URL`のみ「必要に応じて」のため必須にしない。

### 手動再送

Booking Adminプロジェクトの「予約管理」メニューへ「予約メールを再送
（予約ID指定・強制再送）」を追加した（`BookingAdmin.gs`の
`resendBookingMailByPrompt_`）。bookingId・メール種別（`PENDING`/`CONFIRMED`/
`CANCELLED`/`REMINDER`）をそれぞれ別のダイアログで入力し、
`BookingMailer.send*ForBooking(bookingId, { force: true })`を呼ぶ。

- `force: true`はSentAtが既にあっても送信する明示的な再送であり、SentAtを事前に
  消す運用はしない（誤送信を避けるため）
- ただし**状態条件（status一致）はforceでも無視しない**。例えば`PENDING`のメールを
  `CONFIRMED`の予約へforce送信しようとしても`INVALID_STATUS`で拒否する
- `REMINDER`の手動再送も、来場案内の必須項目（秘密値の`ACCESS_GUIDE_KEYBOX_NUMBER`/
  `ACCESS_GUIDE_UNLOCK_CODE`を含む）が1つでも未設定なら送信しない
  （fail-safe自体はforceでも解除しない）

### 前日リマインド用トリガーの作成

`sendNextDayReminders`・そのトリガーは**Booking Adminプロジェクト**
（`BookingReminderTriggers.gs`）に属する。本PRでは本番の時間主導トリガー作成
そのものは行わない（コードのみ実装）。運用開始時は、Booking Adminプロジェクトの
スクリプトエディタから`createNextDayReminderTrigger`を一度だけ実行する（毎日18時台に
1回、`sendNextDayReminders`を実行するトリガーが作成される。同名トリガーが既にある
場合は重複作成しない）。GASの時間主導トリガーは分単位の完全一致を保証しないため、
「18:00ちょうど」ではなく「18時台に1回」を業務要件とする。

`sendNextDayReminders(now)`の処理:

1. `now`（省略時は現在時刻）を`BookingConfig.getAvailabilityConfig().timezone`
   （既定`Asia/Tokyo`）基準の「今日」に変換し、翌日の`YYYY-MM-DD`を計算する
2. `SpreadsheetRepository.getConfirmedBookingsForDate`で翌日の`CONFIRMED`予約を取得する
3. 1件ずつ`BookingMailer.sendReminderMailForBooking`へ委譲し、内部で最新status/SentAtを
   再確認してから送信する
4. 1件が失敗（MailApp例外・秘密値未設定等）しても、残りの予約の処理を継続する
   （バッチ内の障害分離）
5. `{ processedCount, sentCount, skippedCount, failedCount }`を返す

ブランド（snb/mens/studio_x）で抽出ロジック・送信ロジックを分岐させない。

### PENDING TTL失効の遅延についての注記

「Issue #270: 当日利用ルールと利用経験判定」に記載のとおり、PENDING TTLの失効時刻
（`expiry`）自体は利用開始時刻を超えないよう設計しているが、**実際にCalendarイベントを
削除しSheetsの`status`を`EXPIRED`へ更新する処理は、15分間隔の`expirePendingBookings`
トリガーの次回実行時になる**ため、TTL上の失効期限を迎えてから実際のSheets更新・
Calendar削除までに最大約15分の遅延があり得る（Issue #271でメール送信の設計を
見直す過程で改めて明記する）。前日リマインド（`sendNextDayReminders`）は
`status === 'CONFIRMED'`のみを対象とするため、この遅延はリマインド送信対象の
判定には影響しない。

### セキュリティ・個人情報

- キーボックス番号・解錠コード等の秘密値はScript Propertiesでのみ管理し、GitHubへは
  実値を一切コミットしない（README・PRにもキー名と「何を入れるか」のみを記載する）
- `buildPendingMail`/`buildConfirmedMail`は構造上`accessGuide`を引数に取らないため、
  実装ミスで仮予約・確定直後メールに秘密値が混入することを防いでいる
  （`test/booking-mail-templates.test.js`で検証）
- テストでは実秘密値・実メールアドレスを使わず、`test@example.com`・`TEST-KEYBOX`/
  `TEST-CODE`等のダミー値のみを使う
- エラーメッセージ（`lastMailErrorMessage`・Recoveryの`errorMessage`）にはメール本文
  全文・秘密値・利用者のメールアドレスを含めない
- 公開Web APIレスポンス（`getAvailability`/`createBooking`）へ、メール送信状況・
  来場案内・解錠コードを追加していない

### 共通化（3ブランド）

`BookingMailTemplates.gs`の全関数は`record.brand`から`Booking.getBrandLabel`で
表示名を取得するのみで、SNB/mens/Studio Xごとにテンプレート関数・送信ロジックを
複製していない（`test/booking-mail-templates.test.js`で3ブランド共通であることを検証）。

## Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する

管理者が予約をキャンセルしたとき、Google CalendarとSpreadsheet（`Bookings`シート）の
状態をbookingId単位で一貫して更新する正式関数`cancelBookingAdmin(bookingId)`を実装した。
Calendarだけ削除・Sheetsだけ`CANCELLED`という片落ちを許さず、部分失敗は必ず`Recovery`
シートへ記録する。専用のWeb管理画面は作らず、Phase 1で導入したSpreadsheetの「予約管理」
メニューからbookingId単位でキャンセルを実行できるようにした。`statusセルを直接手編集する
運用は正式手順にしない`（確定と同じ方針）。

### このIssueで実装した範囲

1. 正式関数`cancelBookingAdmin(bookingId)`（`BookingAdmin.gs`の薄いグローバル関数から
   `BookingRepository.cancelBookingAdmin`へ委譲。実ロジックは`BookingRepository.gs`）
2. `PENDING` → `CANCELLED`、`CONFIRMED` → `CANCELLED`の状態遷移
3. Calendarイベントの**削除**による枠の再開放（タイトルを「キャンセル」へ変更して残す
   方式は採用しない。理由は「Calendarイベントの扱い」参照）
4. Sheetsの`status`を`CANCELLED`へ更新し、`cancelledAt`/`updatedAt`を記録
5. #271の`BookingMailer.sendCancelledMailForBooking(bookingId)`への接続（Lock解除後・
   best effort）
6. 二重実行時の冪等性（`alreadyCancelled: true`。Calendar再削除・`cancelledAt`上書きを
   しない）
7. Calendar/Sheetsの部分失敗のRecovery記録（`failureType`一覧は後述）
8. Spreadsheet「予約管理」メニューからのキャンセル操作（confirmと対称の2導線＋
   実行直前のYES/NO確認）
9. Calendarイベントが既に存在しない場合の収束処理（枠は既に空いているとみなし、
   SheetsをCANCELLEDへ進める）
10. Sheets行が存在しない場合のCalendar診断とRecovery記録（Calendarは自動削除しない）

### このIssueで実装していないもの（非対象）

- 利用者自身が押すキャンセルURL・公開Web APIからのキャンセル（`cancelBookingAdmin`は
  **Booking Admin側のみ**に公開し、公開Web App（`Code.gs`）には一切追加しない）
- キャンセル料の自動計算・返金API・決済API
- SpaceMarket側のキャンセル操作
- メールテンプレートの全面変更（#271の`sendCancelledMailForBooking`をそのまま呼ぶだけ）
- `#273`の本番切替（本番GASデプロイ・本番Calendar/Spreadsheet操作・実メール送信は
  このPRでは行わない）
- `status`セル直接編集を正式運用にすること

### 状態遷移の更新

`Booking.gs`の`ALLOWED_TRANSITIONS`を、CONFIRMEDを終端状態から外す形へ変更した。

```js
var ALLOWED_TRANSITIONS = {
  PENDING: [STATUS.CONFIRMED, STATUS.CANCELLED, STATUS.EXPIRED],
  CONFIRMED: [STATUS.CANCELLED]
};
```

| 遷移 | 可否 |
| --- | --- |
| `PENDING` → `CANCELLED` | 可 |
| `CONFIRMED` → `CANCELLED` | 可（**#272で追加**） |
| `CANCELLED` → `CANCELLED` | 冪等扱い（`canTransition`ではなく`cancelBookingAdmin`側で`alreadyCancelled`として処理） |
| `EXPIRED` → `CANCELLED` | 不可（`INVALID_TRANSITION`） |
| `CANCELLED` → `CONFIRMED` / `EXPIRED` → `CONFIRMED` | 不可（従来どおり変更なし） |

`confirmBooking`/`expirePendingBookings`の既存仕様（PENDING→CONFIRMED/EXPIREDの遷移・
TTL計算・二重実行時の冪等性）はいずれも変更していない。

### Lock取得順序（Issue本文より安全側に実装）

Issue本文は「Sheets取得→status確認→Lock取得」の順だが、実装では必ず次の順序にした。

```text
bookingId基本検証
↓
Lock取得
↓
Sheetsをbookingidで最新再読込
↓
最新status確認
↓
Calendar状態確認・削除
↓
Sheets CANCELLED更新
↓
Lock解除
↓
キャンセルメール best effort
```

`confirmBooking`/`expirePendingBookings`/`cancelBookingAdmin`が同時に動いても、Lock取得前に
読んだ古いstatusで処理してしまわないよう、**status判定は必ずLock取得後に最新行を
再読込して行う**（`BookingRepository.cancelBookingAdminLocked_`参照）。

### 正常キャンセルフロー

対象status: `PENDING` / `CONFIRMED`。

```text
Lock取得
↓
最新Sheets行取得（PENDING/CONFIRMEDであることを確認）
↓
calendarEventId取得・Calendarイベント存在確認
↓
Calendarイベント削除
↓
Sheets: status=CANCELLED, cancelledAt=now, updatedAt=now
↓
Lock解除
↓
BookingMailer.sendCancelledMailForBooking(bookingId)
↓
return { success: true, bookingId, status: 'CANCELLED' }
```

**Calendarイベントは削除する。** タイトルを「キャンセル」へ変更して残す方式は採用しない。
理由: 現行`Availability.gs`は「時間指定Calendarイベントはタイトル・statusに関係なく塞ぐ」
実装のため、残すとCANCELLED後も同じ枠が予約不可能なまま残ってしまう。正常キャンセル後は、
同じ時間枠が`getAvailability`で再び候補になり、同時間で新しい`createBooking`も成功する
（`test/booking-cancel.test.js`で検証）。

### cancelledAt / updatedAt

初回キャンセル成功時に同一の`now`を使って`status`/`cancelledAt`/`updatedAt`を保存する。
二重実行時（既に`CANCELLED`）は`cancelledAt`を上書きしない（最初にキャンセルが成立した
日時を保持する）。

**この3項目は必ず1回のSpreadsheet書き込みで反映する**（PRレビュー対応）。既存の
`SpreadsheetRepository.updateBookingFields`はフィールドごとに`getRange().setValues()`を
個別に呼ぶため、複数フィールドを更新する途中で例外が起きると、例えば`status`だけ
`CANCELLED`になり`cancelledAt`が空のまま、という部分更新が起こり得る。部分更新が
起きると、次回再実行時に`record.status === 'CANCELLED'`の分岐（二重実行の冪等処理）へ
入ってしまい、空のままの`cancelledAt`/`updatedAt`を修復する経路が無くなってしまう。

そのため`cancelBookingAdmin`は専用の`SpreadsheetRepository.updateBookingCancellationStateAtomic
(bookingId, fields)`を使う。**PRレビュー2回目対応**: 当初は行全体（全29列）を
`getRange(rowNumber, 1, 1, HEADERS_.length).setValues([...])`で1回だけ書き込む
`updateBookingFieldsAtomic`を実装したが、これは新たな競合を生むと指摘された。
Booking Web App（`createBooking`）とBooking Admin（`confirmBooking`/
`expirePendingBookings`/`cancelBookingAdmin`）は別々のGASプロジェクトで
`LockService.getScriptLock()`を共有しないため、Web App側がキャンセル処理の直前・直後に
`pendingMailSentAt`等（21列目以降のメール関連列）を更新していた場合、Admin側が古い行
全体を書き戻すとその更新を空値で巻き戻してしまう恐れがあった（#271はメール列のSentAtを
二重送信防止の冪等性の基準にしているため、これは二重送信事故につながり得る）。

現在の`updateBookingCancellationStateAtomic`は、`status`/`cancelledAt`/`updatedAt`の
3項目**だけ**を、`HEADERS_`上で連続する`'status'`（13列目）〜`'updatedAt'`（20列目）の
**8列の範囲**に対する1回の`getRange(rowNumber, 13, 1, 8).setValues([...])`で更新する
（範囲内だが指定していない`calendarEventId`/`source`/`note`/`confirmedAt`/`expiredAt`は
既存値のまま書き戻す）。21列目以降（`customerType`・mail SentAt各列・
`lastMailError*`）は読み書きの対象に一切含まれないため、Web App側がその前後に
更新していても巻き戻されない。`confirmBooking`/`expirePendingBookings`の呼び出し方や
既存の`updateBookingFields`自体は変更していない。

### 既にCANCELLEDの場合（冪等性）

最新Sheets statusが`CANCELLED`の場合:

- Calendar削除を再実行しない
- `cancelledAt`を書き換えない
- `success: true, alreadyCancelled: true`を返す
- `cancelMailSentAt`が空ならLock解除後にキャンセルメールだけ再試行する
  （#271の`BookingMailer`のSentAt冪等性をそのまま再利用。既送信なら二重送信しない）

### EXPIRED等の不正な遷移

`EXPIRED`（またはその他`canTransition`が許可しない状態）をキャンセルしようとした場合、
`success: false, error.code: 'INVALID_TRANSITION'`を返し、Calendar/Sheets/メールのいずれも
変更しない。

### Calendarの読み取り自体が失敗した場合（PRレビュー対応）

`CalendarRepository.getEventById(calendarId, record.calendarEventId)`は、イベントが
無い場合は`null`を返すが、`CALENDAR_ID`不正・Calendarアクセス障害等では**例外を
投げる**。この2つは区別しなければならない。この呼び出し自体を`try/catch`し、例外の
場合は以下のように扱う（当初の実装ではここが未catchで、Lockはfinallyで解除される
ものの`Recovery`に何も残らないまま抜けていた）。

- `Recovery`へ`failureType: 'CANCEL_CALENDAR_LOOKUP_FAILED'`, `recoveryState: 'OPEN'`で記録
  （`errorMessage`は`BookingMailer.sanitizeErrorMessage`を通す）
- Sheets/Calendarのいずれも変更しない（Calendar削除を試みない）
- キャンセルメールは送らない
- `success: false, error.code: 'CANCEL_CALENDAR_LOOKUP_FAILED'`を返す

### Calendarイベントが既に存在しない場合

`getEventById`が例外を投げずに`null`を返した場合（＝SheetsはPENDING/CONFIRMEDだが
対応するCalendarイベントが本当に存在しない場合）、Calendar側は既に非占有
（＝枠は既に空いている）とみなし、**キャンセル処理を収束させる**方向で扱う。

1. `Recovery`へ`failureType: 'CANCEL_CALENDAR_EVENT_MISSING'`, `recoveryState: 'OPEN'`で記録
2. SheetsをCANCELLEDへ更新（`cancelledAt`/`updatedAt`を記録）
3. Lock解除
4. キャンセルメールをbest effort送信
5. `success: true`だが補助情報`calendarAlreadyMissing: true`を返す

「なぜCalendarだけ先に無かったか」は`Recovery`で人が確認できるよう、自動ではRESOLVEDに
しない（`recoveryState`はOPENのまま）。メールはSheetsがCANCELLEDへ更新できた場合のみ送る。

### Calendar削除自体が失敗した場合

イベントは存在するが`deleteEventById`が例外を投げた場合、Calendarがまだ占有している
可能性があるため、Sheetsは元statusのまま進めず、メールも送らない。

- `Recovery`へ`failureType: 'CANCEL_CALENDAR_DELETE_FAILED'`, `recoveryState: 'OPEN'`で記録
- `success: false, error.code: 'CANCEL_CALENDAR_FAILED'`を返す

### Calendar削除成功 → Sheets更新失敗（最重要の部分失敗）

Calendar側は削除済み（枠は空き）だが、Sheets側がPENDING/CONFIRMEDのまま更新できない
最も重要な部分失敗ケース。**Calendarイベントを無理に再作成して補償しない**
（再作成するとeventIdが変わり、Sheets更新障害中に書き戻せず、二次的不整合を増やすため）。

「Sheets側がPENDING/CONFIRMEDのまま更新できない」とは、`updateBookingCancellationStateAtomic`
（前述「cancelledAt / updatedAt」参照）の**1回の書き込みそのもの**が失敗すること。
`status`だけ更新できて`cancelledAt`が空、という中途半端な状態にはならない
（1回の`setValues`が成功するか、行がまったく変化しないかのどちらかしかない）。

- `Recovery`へ`failureType: 'CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED'`,
  `recoveryState: 'OPEN'`（`status`はSheetsに残っている現在status）で記録
- キャンセルメールは送らない
- `success: false, error.code: 'CANCEL_SAVE_FAILED'`を返す
- **次回同じbookingIdで`cancelBookingAdmin`を再実行すれば**、Calendarは既に無いため
  「Calendarイベントが既に存在しない場合」の経路からSheetsがCANCELLEDへ収束する
  （`test/booking-cancel.test.js`のケースA/B（障害分離テスト）で、1回目の失敗時に
  `status`/`cancelledAt`/`updatedAt`がいずれも書き込み前の値のまま残ること、
  再実行によりCANCELLEDへ収束すること・2回目の実行で`CANCEL_CALENDAR_EVENT_MISSING`が
  追加記録されることをそれぞれ検証済み）

### Recovery記録自体の失敗

Recovery書き込みもbest effortであり、失敗しても元の例外を上書きしない。Loggerへ
`bookingId`/`failureType`/エラー概要のみを最小限記録する（メールアドレス・秘密値は
Loggerへ出さない。既存の`confirmBooking`/`expirePendingBookings`と同じ方針）。

### Sheets行が存在しない場合のCalendar診断

`bookingId`でSheets行が見つからない場合、単にNOT_FOUNDで終わらせず、bookingId形式
（`SNB-YYYYMMDD-XXXXXXXX` / `MENS-YYYYMMDD-XXXXXXXX` / `SX-YYYYMMDD-XXXXXXXX`）から
利用日を復元し、対象日のCalendarを`bookingId`タグで診断する
（`BookingRepository.parseBookingDateFromId_` / `CalendarRepository.findBookingEventsByBookingId`）。

`findBookingEventsByBookingId(calendarId, bookingId, dateString, timezone)`は対象日の
Calendarイベントのうち`event.getTag('bookingId') === bookingId`で一致するものだけを返す
（タイトル文字列検索には依存しない。PII・brandは検索条件に使わない。SpaceMarket等の
外部イベントはbookingIdタグを持たないため対象外になる）。**この診断は異常時のRecovery
支援のためだけに使う。通常のキャンセル処理では引き続きSheetsの`calendarEventId`を
正として使う。**

| 診断結果 | failureType | 挙動 |
| --- | --- | --- |
| bookingId形式が不正で日付を復元できない | `CANCEL_BOOKING_NOT_FOUND` | Calendar走査自体をスキップして記録 |
| `findBookingEventsByBookingId`自体が例外を投げた（PRレビュー対応） | `CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED` | 診断そのものが失敗。Calendarは変更しない |
| Calendarに1件だけ見つかった | `CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT` | `calendarEventId`を記録。**Calendarは自動削除しない**（正式台帳が無い状態で破壊的変更をするのは危険なため） |
| Calendarに複数件見つかった | `CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND` | 同上。自動削除しない |
| Calendarに0件 | `CANCEL_BOOKING_NOT_FOUND` | `calendarEventId`/`status`は空で記録 |

`findBookingEventsByBookingId`自体の例外（診断走査中のCalendarアクセス障害等）も
`try/catch`し、生例外のまま処理を抜けないようにしている（当初の実装ではここも
未catchだった）。この場合の戻り値は`success: false, error.code:
'CANCEL_DIAGNOSTIC_FAILED'`（診断そのものの失敗であることを`NOT_FOUND`と区別する）。
それ以外の診断結果（0/1/複数件）では、`cancelBookingAdmin`の戻り値は
`success: false, error.code: 'NOT_FOUND'`になる。

### キャンセルメールの接続位置

#271の`BookingMailer.sendCancelledMailForBooking(bookingId)`を、**必ずLock解除後**に
best effortで呼ぶ（`Calendar削除→Sheets CANCELLED→Lock解除→cancel mail best effort`）。
メール失敗時は`cancelBookingAdmin`自体は`success: true`のまま、`CANCELLED`を元へ戻さず
Calendarも復元しない（`BookingMailer`側の`lastMailErrorAt`/`lastMailErrorType`/
`lastMailErrorMessage`・`Recovery`（`MAIL_CANCELLED_FAILED`）へ任せる）。戻り値へ補助情報
`mailSent`/`mailError`を追加した。既にCANCELLED＋メール未送信（`cancelMailSentAt`が空）の
状態で再実行した場合も、状態変更・Calendar操作は行わずメールだけ再試行する
（#271のSentAt冪等性・`{ force: true }`不要の自動再試行）。

### confirm / expireとの競合

`cancelBookingAdmin`は`confirmBooking`/`expirePendingBookings`と同じBooking Adminプロジェクトに
置き、同じ`LockService.getScriptLock()`を使う。Lock取得後に必ず最新statusを読むため、
3関数のうちどれが同時に実行されても1つの状態遷移だけが成立する。

| 先に実行 | 後から実行 | 結果 |
| --- | --- | --- |
| `cancelBookingAdmin`（→CANCELLED） | `confirmBooking` | `INVALID_TRANSITION` |
| `expirePendingBookings`（→EXPIRED） | `cancelBookingAdmin` | `INVALID_TRANSITION` |
| `confirmBooking`（→CONFIRMED） | `cancelBookingAdmin` | 成功（CONFIRMED→CANCELLEDとして続行） |

（`test/booking-cancel.test.js`の競合テストで検証。Lock共有自体のテストも同ファイルに
`test/booking-confirm-expire.test.js`と同じ方式で用意した）

### Spreadsheet管理メニュー

既存「予約管理」メニューへ、`confirmBooking`と対称の2項目を追加した。

- 「アクティブ行のbookingIdをキャンセル（cancelBookingAdmin）」
- 「bookingIdを入力してキャンセル（cancelBookingAdmin）」

**誤操作防止**として、実行直前に必ずYES/NO確認ダイアログを挟む（`ui.alert(message,
ui.ButtonSet.YES_NO)`）。

```text
予約 SX-20261001-XXXXXXXX をキャンセルします。
Calendarから予約枠を削除し、利用者へキャンセルメールを送信します。
よろしいですか？
```

NOなら`cancelBookingAdmin`自体を呼ばず、何も変更しない。結果表示:

- 初回成功: `キャンセルしました: <bookingId>`
- 再実行（`alreadyCancelled`）: `すでにキャンセル済みです: <bookingId>`
- Calendar既に無（`calendarAlreadyMissing`）: `キャンセルしました。Calendarイベントは
  既に存在しなかったためRecoveryへ記録しました: <bookingId>`
- 失敗: `result.error.message`を表示

`status`セルの手編集は案内しない（confirmと同じ方針）。

### PII・セキュリティ

キャンセル処理のCalendarイベント・Recovery記録・管理メニューのダイアログのいずれにも、
氏名・メールアドレス・電話番号・解錠情報等のPIIを追加していない。Recoveryは`bookingId`/
`calendarEventId`/`status`で追跡する。

### 3ブランド共通であることの確認

`cancelBookingAdmin`・`findBookingEventsByBookingId`のいずれも`brand`を一切参照しない
（`Availability.gs`と同じ「brandで分岐させない」方針）。`test/booking-cancel.test.js`で
snb/mens/studio_xの3ブランドすべてが同じ挙動になることを検証している。

### 変更したファイル

- `Booking.gs` — `ALLOWED_TRANSITIONS`へ`CONFIRMED: [STATUS.CANCELLED]`を追加
- `BookingRepository.gs` — `cancelBookingAdmin`本体（Lock・状態遷移・部分失敗補償・
  Recovery記録・キャンセルメール接続）、`CalendarRepository.findBookingEventsByBookingId`
  を使ったSheets行なし診断を追加。**PRレビュー対応で追加**: `CalendarRepository.
  getEventById`/`findBookingEventsByBookingId`の呼び出しをそれぞれ`try/catch`し、
  例外時は`CANCEL_CALENDAR_LOOKUP_FAILED`/`CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED`
  をRecoveryへ記録するようにした（詳細は「Calendarの読み取り自体が失敗した場合」
  「Sheets行が存在しない場合のCalendar診断」参照）。**PRレビュー2回目対応**:
  `finalizeCancelledSheetsUpdate_`が
  `SpreadsheetRepository.updateBookingCancellationStateAtomic`を使うよう変更（詳細は
  「cancelledAt / updatedAt」参照）
- `BookingAdmin.gs` — グローバル関数`cancelBookingAdmin(bookingId)`、メニュー2項目、
  YES/NO確認・結果表示のハンドラを追加
- `CalendarRepository.gs` — 診断用`findBookingEventsByBookingId(calendarId, bookingId,
  dateString, timezone)`を追加（既存の`getEventById`/`deleteEventById`は変更なし）
- `SpreadsheetRepository.gs`（**PRレビュー対応で追加・2回目対応で置き換え**） —
  `updateBookingCancellationStateAtomic(bookingId, fields)`を追加。`status`/
  `cancelledAt`/`updatedAt`の3項目**だけ**を、`HEADERS_`上で連続する`'status'`
  （13列目）〜`'updatedAt'`（20列目）の8列範囲に対する1回の`getRange().setValues()`で
  更新し、21列目以降（`customerType`・mail SentAt各列・`lastMailError*`）には一切
  書き込まない（1回目対応で実装した、行全体（全29列）を丸ごと書き戻す
  `updateBookingFieldsAtomic`は、Booking Web App側が別GASプロジェクト・別
  LockServiceで更新するメール列を巻き戻す競合リスクがあると2回目レビューで指摘され、
  この列範囲限定版へ置き換えた）。既存の`updateBookingFields`・列構成（`HEADERS_`）・
  他の関数は変更していない（新しいSheets列も追加していない）
- `RecoveryRepository.gs` — ファイル冒頭コメントへ新規failureTypeの説明を追加
  （列構成・`recordFailure`/`listAll`自体は変更なし。新しい列も追加していない）
- `BookingMailer.gs` — **変更なし**（#271の`sendCancelledMailForBooking`をそのまま呼ぶだけ。
  新規failureTypeのerrorMessageサニタイズには既存の`BookingMailer.sanitizeErrorMessage`を
  そのまま再利用した）
- `test/booking-cancel.test.js`（新規・PRレビュー対応で追加検証） — 状態遷移・正常キャンセル・
  二重実行・メール失敗・Calendar既に無い・Calendar削除失敗・
  Calendar削除成功→Sheets失敗（ケースA: atomic write失敗時に`status`/`cancelledAt`/
  `updatedAt`がいずれも書き込み前のまま残ること／ケースB: 障害解消後の再実行で収束し
  キャンセルメールも送信されること）・cancelledAtとupdatedAtが同一書き込みで同じDate値に
  なること（ケースC）・**Calendar読み取り自体の失敗**（`getEventById`が例外を投げた場合の
  `CANCEL_CALENDAR_LOOKUP_FAILED`）・**Sheets行なし診断中のCalendar読み取り失敗**
  （`findBookingEventsByBookingId`が例外を投げた場合の
  `CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED`/`CANCEL_DIAGNOSTIC_FAILED`）・
  **（PRレビュー2回目対応で追加）キャンセルのSpreadsheet書き込みがstatus〜updatedAtの
  8列だけに限定され、事前に設定した`pendingMailSentAt`/`customerType`（21列目以降）が
  書き換わらないこと・書き込み先rangeの`col`/`numCols`が13/8であること**・
  Sheets行なし診断（0/1/複数件）・confirm/expireとの競合・Reminder対象外・管理メニュー・
  3ブランド共通を検証
- `test/booking-spreadsheet-repository.test.js`（PRレビュー対応で追加・2回目対応で更新） —
  `updateBookingCancellationStateAtomic`の単体テスト。status/cancelledAt/updatedAtの
  3列だけを1回の書き込みで更新し、範囲内の他フィールド（`calendarEventId`等）・
  mail SentAt列・`customerType`が変化しないこと、書き込み先rangeが`col: 13, numCols: 8`
  であることを`_setValuesCalls`で直接assert、存在しないbookingId/許可されていない
  フィールド名での例外・例外時に行を書き換えないことを検証
- `test/helpers/gas-stubs.js` — `SpreadsheetApp.getUi()`スタブの`alert(message, buttonSet)`
  2引数形式（YES/NO確認ダイアログ）に対応。既存の1引数`alert(message)`呼び出しの挙動は
  変更していない。**PRレビュー2回目対応で追加**: シートスタブの`getRange().setValues()`
  呼び出しを`{row, col, numRows, numCols}`として`_setValuesCalls`へ記録するようにした
  （書き込み対象rangeをテストから直接assertできるようにするため。既存の挙動には
  影響しない）

## Issue #305: Booking Admin Web UI化（個人用シンプルMVP）

現在Spreadsheetのカスタムメニューから行っていたBooking Admin操作（`confirmBooking`/
`cancelBookingAdmin`）を、スマホから使いやすい**管理者本人専用**のWeb UIでも行えるように
した。個人管理ツールのため、高機能化・過剰な抽象化・将来拡張前提の複雑な設計は避け、
新しい予約管理ロジックは一切作らず、既存の正式処理をそのまま再利用している。

### このIssueで実装した範囲

- `BookingAdminWeb.gs`（新規） — Web Appエントリポイント`doGet()`と、既存処理への
  薄いラッパー4関数（`getAdminBookings()` / `getAdminBookingDetail(bookingId)` /
  `adminConfirmBooking(bookingId)` / `adminCancelBooking(bookingId)`）。
  `adminConfirmBooking`/`adminCancelBooking`は、それぞれ既存の正式関数
  `confirmBooking(bookingId)`/`cancelBookingAdmin(bookingId)`（BookingAdmin.gs。
  いずれも本Issueで変更していない）を1行で呼ぶだけで、業務ロジック・Lock・Calendar/
  Sheets/Mail/Recovery処理は一切コピーしていない。`getAdminBookings()`/
  `getAdminBookingDetail()`は、Bookingsシート上のDate値をgoogle.script.run越しに
  そのまま渡さず、既存の`BookingAvailability.formatDateInTimezone`/
  `formatTimeInTimezone`（Availability.gs。メール本文生成等でも使っている既存の
  純粋関数）でAsia/Tokyo基準の文字列へ正規化してから返す。`getAdminBookings()`は
  一覧と一緒に、同じくAsia/Tokyo基準で計算した`todayJst`（今日の日付文字列）も返し、
  クライアント側の「今日/今後」判定が端末のtimezone設定に依存しないようにしている。
  `getAdminBookingDetail()`は`lastMailErrorAt`/`lastMailErrorType`/
  `lastMailErrorMessage`の詳細は返さず、`hasMailError`（あり/なし）のみ返す
  （障害調査はSpreadsheetを直接確認する運用のまま）
- `BookingAdminPage.html`（新規） — 1ページのみのモバイル優先UI。今日/今後/キャンセル/すべて
  タブ・カード形式の一覧・モーダルでの詳細表示・確定/キャンセルボタンを持つ。CSS/JSはすべて
  インラインで、別ファイルへは分割していない
- `SpreadsheetRepository.gs`（拡張） — 一覧取得用に読み取り専用の`getAllBookings()`を
  追加（既存の`getAllPendingBookings()`と同じ「全行取得→呼び出し側で絞り込む」方針。
  `HEADERS_`・他の既存関数は無変更）
- Booking Adminプロジェクトを、従来の「Spreadsheet UI拡張＋時間主導トリガー」に加えて
  **Web Appとしてもデプロイする**（Execute as: Me / Who has access: Only myself。
  管理者本人のみアクセス可能。詳細は「Booking Admin Web UI（Issue #305）のセットアップ・
  使い方」参照）

### 現行READMEとの関係（実装前の確認事項）

このIssue以前のREADMEには「Booking Adminプロジェクト（コンテナバインド）はWeb App
としてデプロイしない（Spreadsheetを開いたときのUI拡張として動くだけでよい）」という
記述があった（Issue #268〜#272時点ではBooking AdminをWeb App化する要件が無かったため）。
本Issueはこの記述を明示的に更新するものであり、既存バックエンドのロジック
（`confirmBooking`/`cancelBookingAdmin`/`expirePendingBookings`本体・状態遷移・
Lock/Calendar/Sheets/Mail/Recovery処理）自体には一切手を入れていない。

Web App化してもLock設計は変わらない: `LockService.getScriptLock()`はスクリプト
プロジェクト単位の排他であり、呼び出し元が`onOpen`メニューだろうとWeb App
（`doGet`/`google.script.run`）だろうと同じLockを取得する。そのため
`confirmBooking`/`cancelBookingAdmin`/`expirePendingBookings`の3者間の排他は
今までどおり保たれる。

### 意図的にMVP非対象としたもの（Issue本文どおり）

新規予約作成・予約内容編集・statusの直接編集・COMPLETED/paymentStatus追加・売上集計・
金額管理・支払確認・管理メモ編集・Recovery/trigger/Script Properties管理UI・
Calendar直接編集・メールforce resend・一括確定/一括キャンセル・ページネーション・
複雑な検索・過剰なダッシュボード・新規DBは実装していない。EXPIREDへの手動変更ボタンも
作らず、`expirePendingBookings()`と時間主導トリガーの責務をそのまま維持している。
一覧はカード表示に必要な最小フィールドのみを返し、`email`/`phone`/`note`等のPIIは
詳細取得（`getAdminBookingDetail`）でのみ返す。

### 追加: 一覧ソート機能（日付順 / 予約順）

Booking Admin Web UIの各タブ（今日/今後/キャンセル/すべて）の一覧に、「日付順 / 予約順」の
並び替えを追加した。タブ構成・フィルタ条件（today/upcoming/cancelled/allの絞り込み仕様）・
confirm/cancel/Calendar/Mail/trigger/Script Propertiesはこの変更で一切変更していない。
新しいAPI・Spreadsheet列も追加していない。

- **日付順（デフォルト）**: `date`昇順、同一日は`startAt`昇順
- **予約順**: `createdAt`降順（新しく予約されたものを上）。`createdAt`が同値の場合は
  `bookingId`昇順で安定させる
- `getAdminBookings()`のレスポンスへ`createdAt`を追加した（既存の`bookingId`/`date`/
  `startAt`/`endAt`/`brand`/`name`/`people`/`customerType`/`purpose`/`paymentMethod`/
  `status`に加えて返す）。他のDate値と同じくgoogle.script.run越しにDateオブジェクトの
  まま返さない。正規化には`normalizeAdminCreatedAt_`（本機能で新規追加。
  `BookingAdminWeb.gs`）を使う。`date`/`startAt`/`endAt`が使う既存の`formatAdminDate_`/
  `formatAdminTime_`/`formatAdminDateTime_`はDate値のみを変換し文字列はそのまま
  素通りさせる（カード表示用途では、Bookingsシートの列が元々文字列である前提のため
  それで十分だった）が、`createdAt`は予約順ソートのキーとして使うため文字列で
  渡ってきた場合も必ず比較可能な形式へ揃える必要がある。そのため`normalizeAdminCreatedAt_`
  はDate値・既に`'YYYY-MM-DD HH:mm'`形式の文字列・それ以外でDateとして解釈可能な文字列
  （ISO文字列等）のいずれも同じ`'YYYY-MM-DD HH:mm'`形式へ統一し、解釈不能な値
  （空文字列・null/undefined・解釈不能な文字列等）は形式を推測せず`''`へ安全に落とす
  （例外は投げない）。カード表示には使わず、ソート専用のフィールドとして扱う
- `BookingAdminPage.html`側は`state.sort`（`'date'` | `'reservation'`、既定`'date'`）を
  追加し、タブ切り替え時のフィルタ結果（`filteredBookings()`）に対して
  `sortBookings()`を適用してから描画する（要件どおりfilter→sortの順）。ソートUIは
  ヘッダーの`<select id="sort-select">`のみの最小構成で、既存のタブUI・カードデザインは
  変更していない

## Issue #318: 月間空き状況カレンダー

共通予約UI（SNB / SNB mens / Studio X）のStep 1の日付選択を、単一日付入力から
1か月表示の空き状況カレンダーへ変更した。3ブランドとも別実装を作らず、既存の
共通予約UI（`_includes/booking_app_ja.html` / `_includes/booking_app_en.html` /
`scripts/booking-app.js` / `scripts/booking-logic.js` / `styles/booking.css`）を
拡張しただけで、Booking Admin・決済・Spreadsheet構造・予約ステータス設計は
一切変更していない。既存のGAS `/exec` URL（`scripts/booking-config.js`）もそのまま。

### API/GAS側

- `gas/booking/shared/CalendarRepository.gs`: `getBusyIntervalsForRange(calendarId,
  startDate, endDate, timezone)`を追加。対象月全体を`calendar.getEvents()`の
  呼び出し**1回**だけで取得し、日ごとのbusyIntervalsへ振り分ける（1日ごとに
  `getEvents()`を呼ぶ実装は不可）。既存の`getBusyIntervalsForDate`は無変更。
- `gas/booking/shared/Availability.gs`: `DAY_STATUS`（5値のenum。
  `AVAILABLE_HIGH`/`AVAILABLE`/`LIMITED`/`FULL`/`OUT_OF_RANGE`）と
  `getMonthlyAvailability(request, busyIntervalsByDate, config, now)`を追加。
  日ごとのステータスは既存の`computeBookableStartTimes`（`getAvailability`と
  同一関数）の結果件数を閾値でバケット分けするだけで求め、スロット生成ロジック
  自体は一切再実装していない（閾値の定義は「API仕様」節参照）。既存の
  `getAvailability`・`computeBookableStartTimes`は無変更。
- `gas/booking/public/Code.gs`: `doGet`に`action=monthly`の分岐を追加し、
  `handleGetMonthlyAvailability_`から`CalendarRepository.getBusyIntervalsForRange`→
  `BookingAvailability.getMonthlyAvailability`へ配線した。`action`未指定時は
  従来どおり`handleGetAvailability_`（単日`getAvailability`）のまま（後方互換）。

### durationを月間取得のパラメータに含める（追記レビュー対応）

`getMonthlyAvailability`は`durationMinutes`必須（`getMonthlyAvailability(year, month,
durationMinutes, brand)`）。共通予約UIのStep 1は「利用時間・利用区分を先に確定 →
その値でカレンダーを描画・取得」という順序にし、日付入力を最初に置かない（duration
未確定のままでは「何時間分の空き状況か」が定義できず、日別空き判定と表示が
食い違うため）。利用時間を変更した場合は、表示中の月だけを再取得する
（`scripts/booking-app.js`のキャッシュキーに`durationMinutes`を含めるため、
duration変更時は自然に該当月だけがキャッシュミスして再取得され、他の月を
先読みし直すことはしない）。

### Calendar APIは月内で1回に集約する

`getBusyIntervalsForRange`が対象月全体を1回の`calendar.getEvents()`で取得してから
日ごとに振り分ける（GAS内部でも1日ごとに`getEvents()`を呼ぶ実装は不可というレビュー
指摘への対応）。`test/booking-calendar-repository.test.js`・
`test/booking-code-runtime.test.js`で、月間取得時のgetEvents()呼び出し回数が
1回であることを直接検証している。

### スロット判定ロジックは再利用する

日ごとのステータスは`Availability.gs`の既存`computeBookableStartTimes`を日ごとの
busyIntervalsに対して呼び出し、件数を閾値でバケット分けするだけ。スロット生成
ロジックの再実装はしていない（`test/booking-monthly-availability.test.js`の
「日ごとの空き判定は、月間表示でも単日getAvailabilityと一致する」で、月間表示と
単日`getAvailability`の件数が一致することを直接検証している）。

### 祝日表示はスコープ外

`package.json`はゼロ依存が方針のため、祝日ライブラリ追加・静的リストの保守は
このIssueでは行っていない。日曜（赤系）・土曜（青系）・平日（通常色）の3色のみ
実装した。

**Issue #346で追記:** 予約料金の曜日区分判定（`BookingPricing.gs`。「Issue #346:
予約料金の日本の祝日・振替休日判定」節参照）には、`JapaneseHolidays.gs`による
祝日・振替休日・国民の休日の判定を実装済み。ただし本節が指す月間カレンダーの
日セル色分け（このセクションの対象）は依然として日曜/土曜/平日の3色のみで、
祝日を別色で強調する表示は行っていない（表示上の強調はスコープ外のまま。
料金計算自体は祝日を正しく土日祝料金へ分類する）。

### フロントエンド（共通予約UI）

- `scripts/booking-logic.js`: DOM非依存の純粋ロジックとして、`DAY_STATUSES`・
  `dayStatusSymbol`/`dayStatusLabel`（記号とaria-label文言。記号・色だけに依存しない
  アクセシビリティ対応）・`isCalendarDaySelectable`（GASのstatusに加えて、当日＋
  初回利用はフロント側でも選択不可にする。getAvailability自体はcustomerTypeを
  見ないため）・`buildMonthMatrix`（7列×週の2次元配列。月初の曜日位置・
  28〜31日の月・年またぎを実行環境のtimezoneに依存せず計算）・`shiftMonth`
  （前月/翌月の年またぎ計算）等を追加した。
- `scripts/booking-app.js`: Step 1の`#ba-date`（`type="hidden"`のまま維持）を、
  カレンダーの日セルクリックが書き込む形にした。Step 1「次へ」の検証・
  `SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`チェック・Step 2以降（開始時刻選択・
  `getAvailability`呼び出し・確認・送信）は一切変更していない（既存フローの再利用）。
  duration・利用区分が両方確定してから`action=monthly`のGETリクエストを送り、
  表示月ごとに結果をキャッシュする（取得済みの月へ戻る場合は再取得しない）。
  取得失敗時はグリッドを描画せずエラー表示のみとし、どの日も選択できない状態にする
  （fail-open禁止）。
- `_includes/booking_app_ja.html` / `_includes/booking_app_en.html`: Step 1の
  順序を「利用時間 → 利用区分 → カレンダー」に変更し、単一の`<input type="date">`を
  カレンダー（`<table>` + 日セルの`<button>`。前月/翌月ボタン・ローディング表示・
  エラー表示・凡例を含む）に置き換えた。日本語版・英語版でDOM契約（id）を一致させている。
- `styles/booking.css`: `table-layout: fixed`で7列を固定幅にし、スマートフォン幅
  （375px前後）でも横スクロールを必要としない。日曜・土曜の曜日ヘッダーに色分けを
  追加し、選択不可の日セルは`disabled`＋破線枠で視覚的に区別する（色だけに依存しない
  よう、選択可否・状態自体は各日セルの`aria-label`で示す）。

### テスト

- `test/booking-calendar-repository.test.js`: `getBusyIntervalsForRange`の
  getEvents()呼び出し回数（1回）・日ごとの振り分け・日をまたぐイベントのクランプ・
  終日イベントの扱いを検証。
- `test/booking-monthly-availability.test.js`: `getMonthlyAvailability`の
  ステータス分類・過去日/当日の扱い・28/29/30/31日の月・年またぎ・不正入力・
  単日`getAvailability`との整合性を検証。
- `test/booking-code-runtime.test.js`: `doGet`の`action=monthly`配線・
  getEvents()呼び出し回数・バリデーションを検証。
- `test/booking-logic.test.js`: カレンダー用の純粋ロジック（記号・aria-label・
  選択可否・月マトリクス生成・月移動）を検証。
- `test/booking-calendar-ui.test.js`: `scripts/booking-app.js`のDOM配線
  （duration/利用区分確定後のfetch・グリッド描画・当日＋初回利用のガード・
  取得失敗時のfail-open禁止・前月/翌月・duration変更時の再取得・既存の
  開始時刻選択フローへの接続）を検証。

## Issue #324: 月間カレンダー希望時間帯フィルタ

「Issue #318: 月間空き状況カレンダー」の月間カレンダーへ、希望時間帯フィルタ
（指定なし/午前/昼/夜）を追加した。3ブランド（SNB / SNB mens / Studio X）とも
既存の共通予約UIをそのまま拡張しただけで、別実装は作っていない。Booking Admin・
決済・Spreadsheet構造・Calendar構造・Script Properties・既存の単日`getAvailability`/
`createBooking`の仕様はいずれも変更していない。既存のGAS `/exec` URL
（`scripts/booking-config.js`）もそのまま。

### 時間帯定義（開始時刻基準）

- `all`: 指定なし（絞り込みなし）
- `morning`: 08:00〜11:45開始
- `daytime`: 12:00〜17:45開始
- `evening`: 18:00以降開始

最終的な開始可能時刻は、既存の営業時間・利用時間・バッファ・予約重複判定
（`computeBookableStartTimes`）を正とする。例えば6時間利用で夜を選び、営業時間内に
収まる開始候補が0件なら`FULL`（×）になる。

### API/GAS側

- `gas/booking/shared/Availability.gs`: `TIME_BANDS`（4値のenum）・
  `normalizeTimeBand(value)`（未指定・不正値はallへフォールバック）・
  `filterStartTimesByTimeBand(startTimes, timeBand)`（`computeBookableStartTimes`が
  返す`'HH:mm'`配列を開始時刻基準で絞り込む）を追加した。`getMonthlyAvailability`は
  `count`・`maxPossible`の両方に`filterStartTimesByTimeBand`を適用してから
  `classifyDayStatus_`へ渡す（分母のmaxPossibleも同じtimeBandで絞り込む。分母を
  絞らないと記号判定が実態より悪く出るため）。`computeBookableStartTimes`自体・
  スロット生成/重複判定ロジックは一切変更していない。
- `gas/booking/public/Code.gs`: `handleGetMonthlyAvailability_`が`params.timeBand`を
  そのまま`BookingAvailability.getMonthlyAvailability`へ渡すだけの配線を追加した
  （バリデーション・正規化は`normalizeTimeBand`側で行うため重複実装しない）。
  単日`getAvailability`（`handleGetAvailability_`）は無変更。

### フロントエンド（共通予約UI）

- `scripts/booking-logic.js`: DOM非依存の純粋ロジックとして、GAS側と同じ4値・
  同じ境界値の`TIME_BANDS`・`normalizeTimeBand`・`timeBandLabel`（ja/en表示文言）・
  `filterStartTimesByTimeBand`（Step2の開始時刻一覧を月間カレンダーと同じtimeBandで
  絞り込むための純粋関数）を追加した。GASとブラウザは別ランタイムのため、
  `DAY_STATUSES`等の既存機能と同じ方針で定義を複製している（判定結果の正はGAS側）。
- `scripts/booking-app.js`: Step 1に希望時間帯ラジオ（`input[name="timeBand"]`。
  既定`all`がchecked）を追加した。`durationMinutes`をキー生成・URL生成・現在性判定に
  使っていた既存箇所（`calendarCacheKey_`・`calendarMonthlyUrl_`・
  `isCalendarKeyCurrent_`・`renderCalendarGridIfCurrent_`・
  `ensureCalendarMonthLoaded_`内のkey生成・`ba-calendar-retry`クリックハンドラ）の
  すべてへ、同じ`timeBand`を漏れなく追加している（`ba-calendar-retry`も含め、
  既存どおり共通の`calendarCacheKey_`を経由し、インライン重複実装はしていない）。
  `timeBand`変更時は表示中の月だけを再取得する（duration変更時と同じ仕組みを
  そのまま再利用。`isCalendarReady_`の判定条件自体は変更しない＝時間帯未選択でも
  利用時間・利用区分が揃っていればカレンダーは表示する）。以前選択した日付が
  新しいtimeBandで予約不可になった場合の選択解除は、既存のIssue #318のロジック
  （`renderCalendarGrid_`内の再判定）がそのまま働く（timeBand専用の分岐は追加して
  いない）。Step2（`fetchAvailability`）は、GAS側の単日`getAvailability`レスポンス
  （`bookableStartTimes`）を`Logic.filterStartTimesByTimeBand`でStep1と同じtimeBandに
  絞り込んでから`renderStartTimes`へ渡す（単日`getAvailability`へのリクエストURL・
  GAS側仕様は変更しない。フロント側フィルタのみ）。
- `_includes/booking_app_ja.html` / `_includes/booking_app_en.html`: Step 1の順序を
  「利用時間 → 利用区分 → 希望時間帯 → 月間カレンダー」にし、希望時間帯の
  ラジオボタン（指定なし/午前/昼/夜。日本語版・英語版でDOM契約(id/name/value)を
  一致させている）を追加した。既存の`.ba-fieldset`/`.ba-choices`（`styles/booking.css`。
  `flex-wrap: wrap`で既にモバイル幅に対応済み）をそのまま再利用しており、
  スタイルの追加・変更は行っていない。

### `all`の後方互換性

`timeBand=all`（またはtimeBand未指定・不正値からのフォールバック後）は、
`filterStartTimesByTimeBand`が絞り込みを行わずそのまま返すため、
`getMonthlyAvailability`のcount/maxPossible/日別ステータスは、timeBand導入前と
完全に同一の結果になる（`test/booking-monthly-availability.test.js`の
「timeBand=allは現在の月間判定（timeBand未指定）と完全に一致する」で直接検証）。

### テスト

- `test/booking-monthly-availability.test.js`: `all`の後方互換性・timeBand未指定/
  不正値のallフォールバック・morning/daytime/eveningそれぞれの絞り込み・
  境界値（11:45/12:00, 17:45/18:00）・maxPossible側も同じtimeBandで絞られること・
  長時間利用でband内候補が0件の場合のFULL・当日かつ選択中の時間帯が過ぎている
  場合のFULL・`filterStartTimesByTimeBand`/`normalizeTimeBand`の単体動作を検証。
- `test/booking-code-runtime.test.js`: `doGet`の`action=monthly`が`timeBand`クエリ
  パラメータを配線すること・timeBand未指定/不正値のallフォールバックを検証。
- `test/booking-logic.test.js`: `normalizeTimeBand`/`timeBandLabel`（ja/en）/
  `filterStartTimesByTimeBand`（境界値・all後方互換・未指定/不正値のフォールバック）を検証。
- `test/booking-calendar-ui.test.js`: 既定timeBand(all)がURLへ含まれること・
  timeBand変更時に表示中の月だけを再取得すること・cache keyがtimeBand別になること・
  timeBand変更後に選択済み日付がFULLになれば選択解除されること・duration/利用区分
  未確定時はtimeBand変更でもfetchしないこと・再読み込みボタンが現在のtimeBandの
  キャッシュを削除して再取得することを検証。
- `test/booking-app.test.js`: Step1で選んだtimeBandがStep2の開始時刻一覧の絞り込みに
  反映されること・timeBand未選択時はallとして全開始時刻が表示されること（後方互換）・
  該当候補が無い場合は既存の「開始時刻がありません」表示になることを検証。

## Issue #330: 前日リマインドの任意時刻デバッグ・管理者宛テスト送信

前日リマインドの定期実行は毎日18時台の1回のみのため、メール本文・送信対象判定の
修正結果を確認するには翌日まで待つか、本番予約データを使って手動で確認するしか
なかった。Booking Admin Web UI（Issue #305/#317/#322）へ「前日リマインド診断」を
追加し、既存予約IDと基準日（今日扱い）を指定するだけで、任意の時刻に対象判定・
本番テンプレートのプレビュー・管理者宛テスト送信を確認できるようにした。
予約者への手動送信・一括送信・送信済みフラグのリセットは対象外。

### 対象判定・設定不足判定の共通化

本番の前日リマインドは、翌日日付計算（`sendNextDayReminders`）・status/SentAt判定
（`BookingMailer.gs`の`withBookingLock_`）・メール設定/来場案内の設定検証
（`buildTemplateFn`内の`ensureMailConfigComplete_`/`ensureAccessGuideComplete_`）に
分散していた。これらを次の2つの共通関数へ集約し、**本番の実送信経路（`sendReminderMailForBooking`）
と診断の両方が実際に同じ関数を呼ぶ**ようにした（PRレビュー対応。初版では診断からしか
`evaluateReminderEligibility`を呼んでおらず、この受入条件が未達だった）。

- `computeNextDayDateString_(baseDate, timezone)`（`BookingReminderTriggers.gs`） —
  `baseDate`の翌日を`timezone`基準の`'YYYY-MM-DD'`へ変換する。元は
  `sendNextDayReminders`内のインライン計算だったものを抽出しただけで、計算式自体は
  変更していない。本番は`now`（実行時刻）を、診断は管理者が指定した基準日を渡す。
- `BookingMailer.evaluateReminderEligibility(record, options)`
  （`BookingMailer.gs`） — 副作用のない判定関数。`options = { targetDateString, force }`。
  `targetDateString`を渡した場合のみ`NOT_NEXT_DAY`を判定し（省略時はスキップ）、続けて
  `evaluateStatusAndSentAt_`（`withBookingLock_`の既定の事前判定から抽出した純粋関数。
  本番の4メール種別すべてがここを通る）を`force`付きで呼んで`INVALID_STATUS`/
  `ALREADY_SENT`を判定し、その後`EMAIL_MISSING`（予約者メール未登録）、最後に本番と
  同じ`ensureMailConfigComplete_`/`ensureAccessGuideComplete_`（例外をtry/catchして
  `MAIL_NOT_READY`へ変換するのみで検証条件自体は複製しない）で設定不足を判定する。
  すべて通れば`ELIGIBLE`を返す。`record.date`がSheetsの自動型変換でDate値になっていても
  timezone基準の`'YYYY-MM-DD'`へ正規化してから比較する（`normalizeReminderDate_`）。

判定コード・優先順位（上から順に判定し、最初に一致したものを返す）:

| 優先順位 | コード | 意味 |
| --- | --- | --- |
| 1 | `NOT_NEXT_DAY` | 利用日が指定した基準日の翌日ではない（`targetDateString`省略時は判定しない） |
| 2 | `INVALID_STATUS` | 予約statusがCONFIRMEDではない |
| 3 | `ALREADY_SENT` | `reminderSentAt`/`accessGuideSentAt`のいずれかが送信済み（`force`指定時は無視） |
| 4 | `EMAIL_MISSING` | 予約者のメールアドレスが未登録 |
| 5 | `MAIL_NOT_READY` | メール送信設定・来場案内の設定不足 |
| - | `ELIGIBLE` | 上記いずれにも該当しない（送信対象） |

**本番`sendReminderMailForBooking`は、`withBookingLock_`の事前判定（第8引数
`eligibilityCheckFn`）へ`reminderEligibilityCheck_`（`evaluateReminderEligibility`を
使う判定）を渡すことで、実際にこの共通関数を経由する。**
`withBookingLock_`自体は、Lock取得・最新レコード再読込・事前判定・
（`buildTemplateFn`によるテンプレート生成・`MailApp`送信・SentAt更新）という配線
（`withLockedBookingRecord_`）を、事前判定を差し替え可能にしただけで、PENDING/
CONFIRMED/CANCELLEDの3種別は従来どおり`defaultMailEligibilityCheck_`
（status/SentAtのみを見る、Issue #330より前と全く同じ判定＋レスポンス）を使うため
挙動は変わらない。

- `NOT_NEXT_DAY`・`INVALID_STATUS`・`ALREADY_SENT`は、既存のwithBookingLock_と
  完全に同じレスポンス形（`skipped:true`等）へ変換する。`INVALID_STATUS`/
  `ALREADY_SENT`は失敗記録（`recordMailFailure_`）を呼ばない、という既存の扱いも
  そのまま維持する。
- `EMAIL_MISSING`/`MAIL_NOT_READY`は、実際に送信できない状態を表す失敗として、
  既存の`MAIL_NOT_READY`/`MAIL_SEND_FAILED`と同じく`recordMailFailure_`で
  `lastMailError*`・`Recovery`へ記録する（`EMAIL_MISSING`はIssue #330で新規に
  追加した失敗理由のため、記録するかどうかは既存挙動になかった判断だが、
  他の送信失敗と同じ扱いに揃えた）。
- `sendNextDayReminders`は`targetDateString`（計算済みの翌日日付）を
  `sendReminderMailForBooking`へ渡す。候補抽出（`getConfirmedBookingsForDate`）の
  時点で既に翌日のCONFIRMED予約だけに絞り込まれているため、通常は`NOT_NEXT_DAY`に
  なることはなく、ロック取得後の最新レコードに対する防御的な再確認という位置づけ。
- 既存の管理者個別再送（`BookingAdmin.gs`「予約メールを再送」メニュー。
  `force:true`）は`targetDateString`を渡さない（＝`NOT_NEXT_DAY`判定を経由しない）。
  この既存機能は特定の日付だけを対象にしない仕様のため、ここへ`NOT_NEXT_DAY`判定を
  持ち込むと壊れてしまうことを確認したうえで、意図的に対象外とした。

`test/booking-reminders.test.js`・`test/booking-mailer.test.js`は無改変のまま全件
通過することを確認済み（外部挙動が変わっていないことの回帰確認）。

### 診断専用のサーバー側処理（`BookingReminderDiagnostics.gs`。新規）

Booking Adminプロジェクト専用の新規ファイル。以下の3関数のみを公開する。

- `diagnoseReminderEligibility(bookingId, baseDateString)` — 対象判定のみ
  （`SpreadsheetRepository.findRowByBookingId`による読み取りのみ。副作用なし）。
  `baseDateString`は必須（後述）。
- `previewReminderMail(bookingId, { baseDateString, reveal })` — 本番と同じ
  `BookingMailTemplates.buildReminderMail`を使い、件名・本文をプレビューする。
  `baseDateString`は必須（後述）。`reveal`が`false`（既定）の間はキーボックス番号・
  解錠コードをマスクした来場案内を渡して生成し、`reveal:true`のときだけ実値で
  生成する（テンプレート関数自体は複製していない。マスクの有無に関わらず本番と
  同じScript Propertiesの値を使うため、実際に管理者宛テスト送信した場合と
  同じ内容になる）。対象外（`eligible:false`）の予約でもプレビュー自体は生成して
  返す（件名・本文を確認したい診断ニーズのため）。「プレビューの生成に成功したこと」
  （`success`）と「本番なら実際に送信対象であること」（`eligible`/`reasonCode`）は
  別物のため、レスポンスは両方を別項目で返し、UIも両者を区別して表示する
  （PRレビュー対応③）。
- `sendReminderTestMail(bookingId, baseDateString)` — `evaluateReminderEligibility`
  が`eligible:true`を返した場合のみ、`MailApp.sendEmail`をこのファイルから直接呼び、
  件名の先頭に`[TEST] `を付けてScript Property `ADMIN_NOTIFICATION_EMAIL`固定の
  宛先へ送信する。`ADMIN_NOTIFICATION_EMAIL`が未設定・形式不正の場合は送信しない
  （fail-closed）。宛先を画面から入力・変更する機能は設けていない。

**基準日（`baseDateString`）は3関数とも必須**（PRレビュー対応③）。未入力・不正な
形式（例: `2026/10/01`）・実在しない日付（例: `2026-02-30`）はいずれも
`INVALID_BASE_DATE`として処理を止める（`previewReminderMail`も以前は不正値を
無視して`targetDateString`なしのまま判定し、成功扱いになり得たため修正した）。
`TIMEZONE`設定自体が不正で翌日計算に失敗した場合は`INVALID_CONFIG`を返す。
この検証（`resolveDiagnosticsTargetDate_`）は3関数で共有し、複製していない。

**この3関数はいずれも次の本番専用の関数を一切呼ばない**（診断から本番データ更新
経路を分離するIssue #330の必須要件）: `BookingMailer.gs`内部の`withBookingLock_`
（非公開のため呼びようがない）、`SpreadsheetRepository.updateBookingFields`、
`RecoveryRepository.recordFailure`。読み取りは`SpreadsheetRepository.
findRowByBookingId`のみ。そのため、診断・プレビュー・テスト送信のいずれを何度
実行しても、予約行（`status`/`SentAt`系/`lastMailError*`）・`Recovery`シートは
一切変化しない（`test/booking-reminder-diagnostics.test.js`で成功・失敗いずれの
パターンも検証している）。

`sendReminderTestMail`は既存の管理者個別再送（`force:true`）と異なり、`eligible`が
`false`の対象を強制送信する経路を持たない。「本番なら実際に送信されるはずの
組み合わせだけをテスト送信できる」という設計にすることで、対象外の予約を無視して
送ってしまう事故を防いでいる。

### 想定外の例外の境界（PRレビュー対応②）

`diagnoseReminderEligibility`/`previewReminderMail`/`sendReminderTestMail`は、
それぞれ本体を`_impl_`関数へ分離し、`findRowByBookingId`・`BookingConfig.get*Config`・
`BookingMailer.evaluateReminderEligibility`等が想定外の例外を投げた場合、公開関数側の
`try/catch`でこれを捕捉し、固定の安全なメッセージ（`DIAGNOSTICS_GENERIC_ERROR_MESSAGE_`。
例外のmessageは一切含めない）と`INTERNAL_ERROR`コードのみを返す。Loggerにも例外の
message/stackを出さず、関数名とbookingIdのみを残す。既知のエラー（`NOT_FOUND`/
`INVALID_BASE_DATE`/`INVALID_STATUS`等）は例外を投げず通常の戻り値として返している
ため、この境界の影響を受けない。

これは、想定外の例外がgoogle.script.runの`withFailureHandler`へ生の`error.message`
として渡ると、クライアント側でHTMLエスケープしても秘密値のredactionにはならない
（エスケープは表示上の安全対策であって値の削除ではない）ため。クライアント側
（`admin/booking/booking-admin.js`）でも、3つの`withFailureHandler`は`error`を
描画に使わず、固定の安全な文言（`REMINDER_DIAG_GENERIC_FAILURE_RESULT_`）のみを
表示する（二重の防御）。

### 解錠情報の保護

- 診断ログは**Apps ScriptのLogger.logのみ**（別シート・Recoveryシート・新規永続
  ストアは作らない）。記録するのは`bookingId`・基準日/対象日・判定コード・送信成否
  のみで、メール本文・キーボックス番号・解錠コード・予約者のメールアドレスは一切
  記録しない。
- 画面プレビュー（`previewReminderMail`）は既定でキーボックス番号・解錠コードを
  `••••••（「表示する」を選択すると表示されます）`へマスクする。管理者が明示的に
  「解錠コードを表示する」を選んだ場合のみ実値を表示する。マスク状態に関わらず、
  管理者宛テストメール（`sendReminderTestMail`）は常に本番相当（実値）の内容で
  送信する。
- 表示・ログ・返却するエラーメッセージは既存の`BookingMailer.sanitizeErrorMessage`
  （メールアドレス形式を自動redactする）を使い、`ACCESS_GUIDE_KEYBOX_NUMBER`/
  `ACCESS_GUIDE_UNLOCK_CODE`の実値を`extraRedactions`として追加でredactする。
  例外オブジェクトの生の`message`をそのままUI/ログへ出す箇所はない（想定内の
  失敗経路。想定外の例外は前述「想定外の例外の境界」のとおり固定文言のみ返す）。
- 予約IDを変更したとき・診断モーダルを閉じたときは、前回の判定・プレビュー結果
  （解錠コードを表示していた場合はその本文も含む）を画面から消し、「解錠コードを
  表示する」チェックも既定（オフ＝マスク）へ戻す（`resetReminderDiagDisplay_`。
  PRレビュー「追加確認」対応）。

### 診断モーダルの非同期レスポンス制御・二重実行防止（PRレビュー追加対応）

`google.script.run`は応答順序を保証しないため、判定・プレビュー・テスト送信を
連続して実行したり、応答待ちの間に予約ID・基準日・「解錠コードを表示する」
チェックを変更したりすると、後から発行したリクエストより先に古いリクエストの
応答が返ってくることがあり得る。これをそのまま`resultEl`へ反映すると、最新の
入力に対する結果を古い結果で上書きしてしまう事故につながる。

- `reminderDiagRequestSeq_`（一覧取得の`loadRequestSeq`と同じ方針の連番）を
  診断モーダル専用に持ち、判定/プレビュー/テスト送信を実行するたび、また
  予約ID・基準日・「解錠コードを表示する」チェックの変更・モーダルを閉じる
  操作のいずれかが起きるたびに1つ進める。
- 3つの`google.script.run`呼び出しはいずれも、発行時点の連番値を`requestId`として
  クロージャに保持し、`withSuccessHandler`/`withFailureHandler`の両方で、応答が
  返ってきた時点の連番と一致する場合のみ`resultEl`を更新する（一致しない＝
  その後に別の変更・別のリクエストがあった＝古い応答のため無視する）。
- 基準日・「解錠コードを表示する」チェックの変更は連番だけを進め、表示中の
  結果はその場では消さない（次の判定/プレビュー/テスト送信の結果で自然に
  上書きされる）。予約IDの変更・モーダルを閉じる操作は、従来どおり
  `resetReminderDiagDisplay_`で表示自体もクリアしたうえで連番を進める。
- テスト送信（`sendReminderTestMail`）は実際にメールを送信するため、二重実行を
  避ける必要がある。応答が返るまで`reminderDiagState_.sendTestInFlight`を`true`にし
  ボタンを`disabled`にすることでクリックを無視し、成功・失敗（想定外の例外を
  含む）のいずれでも必ず`sendTestInFlight`とボタンの`disabled`を解除して、次回
  実行できる状態へ戻す。このbusy状態の解除は、`resultEl`への反映（連番判定）とは
  独立して常に行う（そうしないと、他の操作で連番が進んだ場合にテスト送信
  ボタンが永久にdisabledのままになってしまうため）。

### サーバー側の認可について

Booking Adminの既存Web App（`BookingAdminWeb.gs`。`getAdminBookings`/
`adminConfirmBooking`/`adminCancelBooking`等）を調査した結果、**呼び出しユーザーを
コード内で識別・比較するチェックは存在しない**。認可はデプロイ設定
（Execute as: Me / Who has access: Only myself）にのみ依存しており、これはGoogle側の
ログイン認証がアクセス制御そのものを担う設計になっているため。`Session.
getEffectiveUser()`は「Execute as: Me」でデプロイされたWeb Appでは常にスクリプト
所有者を返すだけで、実際にリクエストを送ってきた個人を識別する用途には使えない
（Issue #330本文の指摘どおり）。

このIssueで追加した3関数（`diagnoseReminderEligibility`/`previewReminderMail`/
`sendReminderTestMail`）も、既存関数と全く同じBooking Admin Web Appデプロイの内側に
追加するグローバル関数であり、新たなSession判定・新たな公開エンドポイント
（別プロジェクトとしてのデプロイ、匿名アクセス可能な`doGet`パラメータでの分岐等）は
一切追加していない。既存の認可（デプロイ設定への依存）をそのまま引き継ぐ形にした。
これにより、Only myselfのデプロイ設定が維持されている限り、管理者以外がこの3関数を
呼び出す経路は存在しない。

### Script Propertiesの追加要件

新しいScript Propertyは追加していない。既存の`ADMIN_NOTIFICATION_EMAIL`
（Config.gs）をテスト送信先として再利用する。ただしScript Propertiesは
プロジェクトごとに独立しているため、これまで`ADMIN_NOTIFICATION_EMAIL`を
Booking Web App側にしか設定していない場合、**Booking Adminプロジェクト側にも
別途同じ値を設定する必要がある**（詳細は「Script Properties」節を参照）。

### テスト

- `test/booking-reminder-diagnostics.test.js`（新規） — 診断3関数の正常系
  （ELIGIBLE）・異常系（NOT_NEXT_DAY/INVALID_STATUS/ALREADY_SENT/EMAIL_MISSING/
  MAIL_NOT_READY/NOT_FOUND/INVALID_BASE_DATE/ADMIN_EMAIL_NOT_CONFIGURED）、
  基準日の検証（空文字・不正形式・実在しない日付・有効な日付）、プレビューの
  マスク/reveal・対象外予約でも生成できること、テスト送信の宛先固定・
  fail-closed・[TEST]件名、診断のいずれの経路でも予約行・Recoveryシートが
  変化しないことに加え、**本番`sendReminderMailForBooking`が
  `evaluateReminderEligibility`を実際に使うこと**（NOT_NEXT_DAY/EMAIL_MISSING/
  MAIL_NOT_READY/通常送信/force再送/status不一致の各ケースで既存のレスポンス形・
  失敗記録が維持されること）、`record.date`がDate値でも実Repository経由で正しく
  比較できること、診断と本番が同一レコードで同じ理由コードへたどり着くこと、
  想定外の例外（`findRowByBookingId`/`BookingConfig.getAccessGuideConfig`/
  `BookingMailer.evaluateReminderEligibility`/`MailApp.sendEmail`が秘密値を含む
  例外を投げるケース）でUI・レスポンス・Loggerに秘密値が漏れず、`SentAt`/
  `lastMailError*`/Recoveryが不変であることを検証する。
- `test/booking-mailer.test.js`・`test/booking-reminders.test.js` — **無改変のまま**
  全件通過することを確認済み（本番の外部挙動が変わっていないことの回帰確認）。
- `test/booking-admin-page-client.test.js`（拡張） — 前日リマインド診断UIの純粋関数
  （`reminderReasonLabel`/`renderReminderDiagnosisResult_`/
  `renderReminderPreviewResult_`/`renderReminderSendResult_`）、プレビュー結果で
  「プレビュー成功」と「送信対象可否」を区別して表示すること、想定外失敗時に
  固定の安全な文言（`REMINDER_DIAG_GENERIC_FAILURE_RESULT_`）のみを表示すること、
  `resetReminderDiagDisplay_`/`closeReminderDiagnostics_`が表示状態・解錠コード
  表示チェックをリセットすること、診断モーダルの初回生成が例外を投げないことに加え、
  **リクエスト連番による非同期レスポンス制御**（判定/プレビューで古いリクエストの
  成功・失敗いずれの応答も新しいリクエストの表示を上書きしないこと、予約ID/基準日/
  「解錠コードを表示する」チェックの変更やモーダルを閉じた後の古い応答が無視される
  こと）と、**テスト送信の二重実行防止**（応答が返るまでボタンがdisabledになり
  連打しても1回しか実行されないこと、成功・失敗いずれでもbusy状態が解除され
  再実行できる状態へ戻ること、確認ダイアログでキャンセルした場合はリクエスト自体を
  発行しないこと）を検証する。これらのテストのため、テストヘルパーの
  `google.script.run`スタブを、応答を任意の順序で明示的に解決できる仕組み
  （`calls`/`resolveCall`/`rejectCall`）へ、`document.createElement`が返す
  スタブ要素を実際にイベント発火できる仕組み（`fire`）へ、それぞれ拡張した。
- `test/booking-deployment-manifest-sync.test.js`・
  `test/booking-admin-deployment.test.js` — `BookingReminderDiagnostics.gs`を
  manifest/README表へ追加した後も、Booking Admin配布ファイルセットが
  ReferenceErrorなく動作することを確認済み。

## Issue #334: カード決済の期限・失効通知・手動復活・Stripeリンク送信UI（PR-A）

Booking AdminからStripe決済リンクを送信してカード決済を案内する運用（PR-C）・
利用者向け文言（PR-B）に先立ち、まずGAS側の期限管理・失効通知・手動復活を実装した
（このREADME追記はPR-Aの範囲のみ。PR-C/PR-Bは別PRで追記する）。

**注意（重要）**: Issue #326（PR #328。未マージ）は本Issue #334と重なる領域
（PENDING TTL・Admin表示）を扱っているが、TTL計算式・現金/PayPay/未定のTTL値
（#326案では48時間）が#334本文と異なる。#334本文が最新仕様として優先されるため、
本PR-Aは#326/PR #328のアプローチを採用せず、#334本文どおりに実装した。

PR #335（本PR-A）のレビュー対応で調査した結果、PR #328は以下の点で本PR-Aと
具体的に競合する（現時点でも`mergeable_state: dirty`＝現在のmainに対して
そのままはマージできない状態）:

- `gas/booking/shared/Booking.gs`: 両PRとも`Booking.isCardPaymentMethod`という
  同名関数を追加している（値は同じ`'オンラインクレジットカード'`判定だが、実装・
  内部定数名が異なる）。挿入位置が異なるため単純なgit mergeではテキスト衝突には
  ならないが、同一スコープに同名の関数宣言が2つ並ぶ状態になり、後勝ちで
  片方が黙って上書きされる（構文エラーにならないため気付きにくい）。
- `gas/booking/shared/BookingRepository.gs`: `expirePendingBookings`内の
  失効判定の同一行（`if (!Booking.isExpired(...))` を、本PR-Aは支払方法別TTL分岐へ、
  PR #328は`Booking.isPendingExpired(...)`へ、それぞれ書き換えている。ここは
  git上も明確な行レベルの衝突になる。
- `gas/booking/shared/Config.gs`: PR #328は`PENDING_TTL_HOURS`を廃止し
  `PENDING_TTL_CARD_HOURS_FROM_CREATED`/`PENDING_TTL_CARD_HOURS_BEFORE_START`/
  `PENDING_TTL_CASH_HOURS`へ置き換える。本PR-AはConfig.gsを変更していないが、
  `expirePendingBookings`の現金/PayPay/未定側は`BookingConfig.getTtlConfig().ttlHours`
  （＝`PENDING_TTL_HOURS`）に依存しているため、PR #328のConfig.gs変更が先に
  マージされると本PR-Aのロジックが壊れる。
- 同じ理由で`gas/booking/README.md`・`test/booking-model.test.js`・
  `test/booking-confirm-expire.test.js`・`test/booking-mail-templates.test.js`・
  `test/booking-mailer.test.js`・`admin/booking/booking-admin.js`も両PRが重ねて
  編集しており、特にテストファイルは「#326案の計算式を前提にしたテスト」と
  「#334本文の計算式を前提にしたテスト」が同居すると、実装がどちらか一方に
  決まった時点でもう一方のテスト集合が必ず失敗する。

**必要な対応（オーナー判断が必要なため、本PR-Aではコード変更していない）**: 本PR-A
（Issue #334本文どおりの実装）がマージされた後、PR #328／Issue #326は#334に
実質的に包含・上書きされるため、オーナーの判断でPR #328をクローズするか、
#334の確定仕様（カード72h固定・96時間受付条件・現金等24h維持）に合わせて
全面的に書き直す必要がある。少なくとも、PR #328を先に（あるいは無調整のまま）
マージすることは避けるべきである。

### 確定仕様（PR-A）

- カード決済（`paymentMethod === 'オンラインクレジットカード'`。`Booking.PAYMENT_METHOD_CARD`
  として一元管理）のPENDINGのみ、失効時刻を**受付（`createdAt`）+ 72時間固定**
  （`Booking.CARD_TTL_HOURS`）とする。既存の「利用開始の
  `PENDING_TTL_MIN_HOURS_BEFORE_START`時間前を超えない」上限（Script Properties由来。
  既定2時間）は維持する。当日受付グレース（`minHoldHours`）はカードには適用しない
  （96時間ルールにより通常発生しないため）。
- 現金/PayPay/未定のTTL（Script Properties `PENDING_TTL_HOURS`。既定24時間）・
  当日受付グレードの挙動は一切変更していない。
- カード決済は**利用開始まで96時間（4日）未満の申込を`createBooking`（GAS側）で拒否**する。
  しきい値は`Booking.CARD_MIN_HOURS_BEFORE_START = 96`として1か所で管理し、
  `validateCreateBookingInput`が新エラーコード`CARD_PAYMENT_TOO_CLOSE_TO_START`を返す
  （日本語・英語メッセージは`scripts/booking-logic.js`の`ERROR_MESSAGES`に追加）。
  96時間ちょうどは許可、96時間未満は拒否する境界仕様。
- Script Propertiesは変更していない（カードTTL・96時間しきい値はいずれも
  `Booking.gs`のコード定数）。

### 自動失効通知（EXPIRED専用メール）

- `expirePendingBookings`（`BookingRepository.gs`）は、支払方法ごとにTTLを分岐する
  （カード=72h固定、それ以外=既存どおり）。その回の実行で実際にPENDING→EXPIREDへ
  更新した**カード決済の行のみ**を対象に、Lock外・best effortで`sendExpiredMailForBooking`
  （`BookingMailer.gs`。新規）を呼ぶ。送信失敗でもEXPIRED状態は取り消さない。
- `expiredMailSentAt`（Bookings台帳の末尾列。新規）が空の行にのみ送信し、二重送信を防ぐ
  （他のメール種別と同じSentAt方式）。過去にEXPIREDだった行（このループのcandidatesに
  含まれない）へ遡って送ることはない。
- 件名・本文は`BookingMailTemplates.buildExpiredMail`（新規。管理者キャンセル用
  `buildCancelledMail`は流用しない）。「期限までに承認が確認できず失効したこと」
  「予約ページから再申し込み」「支払い済みの場合は運営へ連絡・再申込みや二重決済はしない」
  の3点を含み、入金の有無をシステムが自動確認したかのような断定表現は使わない
  （失効判定は入金の自動検知ではなく管理者による承認の有無に基づくため）。
- `BookingAdmin.gs`の`RESEND_MAIL_HANDLERS_`に`EXPIRED`を追加し、既存の個別再送導線
  （bookingId・メール種別指定・強制再送）から失効通知も再送できるようにした。

### 手動復活（`reviveExpiredBooking`）

- `BookingRepository.reviveExpiredBooking(bookingId, now)`（新規。`now`は省略可・
  テスト用）。既存`confirmBooking`は変更せず、EXPIREDの拒否を維持する
  （`Booking.ALLOWED_TRANSITIONS`にEXPIRED→CONFIRMEDを追加したが、
  `confirmBookingLocked_`に明示ガードを追加し、この遷移を実行できるのは
  `reviveExpiredBooking`のみとした）。
- 処理順: Lock取得 → 最新レコード再読込（status===EXPIRED・利用開始前を確認）→
  Lock内で`BookingAvailability.isStartTimeBookable`により枠の競合を再確認 →
  空きがあればCalendarへCONFIRMEDイベントを新規作成（失効時に旧イベントは削除済みの
  ため、`createBooking`と同様に新規作成する。`confirmBooking`のような既存イベントの
  status更新ではない）→ 台帳のstatus/calendarEventId/confirmedAt/updatedAtを更新
  （`expiredAt`は履歴として保持し上書きしない）→ Lock解除 → Lock外で
  `sendConfirmedMailForBooking`（既存）による確定メール送信。メール失敗で確定を
  巻き戻さない。
- 枠が埋まっている場合は`SLOT_UNAVAILABLE`、利用開始後は`REVIVE_AFTER_START_NOT_ALLOWED`
  で拒否する。
- **Calendarイベント新規作成（`createBookingEvent`）とCONFIRMEDへのステータス変更
  （`setEventStatus`）は別のtry/catchで扱う**（PRレビュー対応）。`createBookingEvent`
  自体の失敗はイベント未作成のため補償対象が無く、`REVIVE_CALENDAR_FAILED`で拒否する
  （`REVIVE_CALENDAR_CREATE_FAILED`をRecoveryへ記録）。`createBookingEvent`成功後に
  `setEventStatus`が失敗した場合は、この時点でSheetsを一切更新していないため予約を
  EXPIREDのまま維持し、`REVIVE_CALENDAR_STATUS_FAILED`で拒否する。新規作成した
  イベントの補償削除を試み、成功すれば`REVIVE_CALENDAR_STATUS_FAILED_ROLLED_BACK`
  （RESOLVED）、削除にも失敗し孤立イベントが残る場合は
  `REVIVE_CALENDAR_STATUS_FAILED_ORPHANED`（OPEN）としてRecoveryへ記録する
  （いずれもSheetsは更新せず、確定メールも送信しない）。
- Calendar成功（`setEventStatus`まで成功）・Sheets失敗の部分失敗は、新規作成した
  Calendarイベントを補償削除し、既存の`CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE`/
  `SHEETS_FAILURE_CALENDAR_ORPHANED`（Recoveryの既存failureType）で記録する
  （`createBooking`のCalendar成功/Sheets失敗補償と同じ形）。
- `BookingAdmin.gs`のSpreadsheetメニューに「アクティブ行のbookingIdを復活」
  「bookingIdを入力して復活」を追加し、実行前にYES/NO確認を必須にした
  （キャンセルと同じ誤操作防止の方針）。`BookingAdminWeb.gs`の
  `adminReviveExpiredBooking(bookingId)`が同じ関数へ委譲し、Web UI（EXPIRED行の
  「復活」ボタン。`admin/booking/booking-admin.js`）からも呼べる。

### Booking Adminのカード支払期限表示

- `BookingAdminWeb.gs`の`getAdminBookings`/`getAdminBookingDetail`が、カード決済のみ
  `cardPaymentDueAt`（読み取り専用。`YYYY-MM-DD HH:mm`のJST文字列）を返す。
  `expirePendingBookings`の失効判定と同じ`Booking.computeCardPaymentDueMillis`
  （`computeTtlExpiryMillis`をCARD_TTL_HOURS固定・minHoldHours=0で呼ぶ薄いラッパー）
  から計算するため、表示用と判定用で計算がずれない。現金/PayPay/未定は常に空文字列。
- `admin/booking/booking-admin.js`／`booking-admin.css`がカード予約カードへ支払期限行を、
  詳細モーダルへ`カード支払期限`項目を追加した（GAS Web Appの再デプロイ不要。
  「Booking Adminフロントエンドの外部化（Issue #317）」参照）。

### テスト（PR-A）

- `test/booking-model.test.js` — カード96時間ルールの境界（ちょうど96時間は許可、
  1分未満は拒否）、現金/PayPay/未定は96時間ルールの対象外（回帰）、
  `computeCardPaymentDueMillis`が`computeTtlExpiryMillis`（CARD_TTL_HOURS固定・
  minHoldHours=0）と一致すること、`canTransition('EXPIRED','CONFIRMED')`が
  trueになったこと（`booking-model.test.js:399`付近を更新）。
- `test/booking-confirm-expire.test.js` — カードPENDINGの72時間TTL境界、現金/PayPay/
  未定が24時間TTLのまま変わらないこと（回帰）、新規失効したカード予約のみへの
  EXPIRED通知・二重送信防止・送信失敗時もEXPIRED維持・過去のEXPIRED行への不通知、
  `reviveExpiredBooking`の成功/枠競合(`SLOT_UNAVAILABLE`)/開始後拒否/
  対象外status拒否/Calendar成功・Sheets失敗のRecovery記録、既存`confirmBooking`が
  引き続きEXPIREDを拒否すること、Spreadsheetメニューへの復活項目追加を検証する。
- `test/booking-mail-templates.test.js`・`test/booking-mailer.test.js` —
  `buildExpiredMail`の文面（キャンセルメールを流用しないこと・入金自動確認を
  断定しないこと）、`sendExpiredMailForBooking`のstatus限定・二重送信防止・
  送信失敗時のlastMailError記録・force再送を検証する。
- `test/booking-admin-web.test.js` — `cardPaymentDueAt`がカードのみ非空で
  一覧・詳細で同一値になること、`adminReviveExpiredBooking`が
  `reviveExpiredBooking`へ委譲していることを検証する。
- `test/booking-logic.test.js` — `CARD_PAYMENT_TOO_CLOSE_TO_START`のja/en専用メッセージ・
  `recoveryActionForErrorCode`の振り分けを検証する。
- 全テスト（`npm test`）は本番メール送信・本番予約・実Calendar/Sheetsを一切使わず、
  既存のGASサービススタブ（`test/helpers/gas-stubs.js`）のみで完結する。

### 未検証事項・本番反映時の注意（PR-A）

- 本番の時間主導トリガー（`expirePendingBookings`の実行間隔）の実稼働はリポジトリから
  確認できないため、運営が別途確認すること。
- 台帳に新規列（`expiredMailSentAt`）を追加したため、本番反映時は既存Booking Admin
  デプロイをnew versionで更新し、既存`/exec` URLを維持したうえで、**本番Bookingsシートの
  ヘッダー行へ`expiredMailSentAt`を手動で追記**すること（ヘッダー行はシートが空のときしか
  自動で書かれないため）。既存のScript Properties・実予約データ・トリガー・デプロイ設定は
  このPRでは一切変更していない。
- 本PR-Aは`Closes #334`を付けていない（Issue #334本文どおり、最後にマージするPRのみ
  `Closes`を付ける）。

### フォーム表示・仮受付メールの文言（PR-B）

PR-Aの期限管理・失効通知・手動復活の業務ロジックはこのPRでは一切変更していない。

- `_includes/booking_app_ja.html`／`scripts/booking-logic.js`／`scripts/booking-app.js`に、
  カード決済（`Booking.PAYMENT_METHOD_CARD`と同じ内部value）の**利用開始96時間未満は
  選択不可**にするフロント側の事前チェックを追加した（`Logic.CARD_MIN_HOURS_BEFORE_START`
  =96・`Logic.isCardPaymentEligible`）。しきい値はGAS側の`Booking.CARD_MIN_HOURS_BEFORE_START`
  と値を一致させているが、正はあくまでGAS側の`validateCreateBookingInput`
  （`CARD_PAYMENT_TOO_CLOSE_TO_START`）であり、フロント側はUXのための事前ガードに過ぎない。
  Step2→Step3遷移のたびに再評価するため、一度カードを選んだ後に日時を変更して96時間未満に
  なった場合も選択が解除される。
- カード選択時のみ、支払方法欄付近・予約確認画面（`#ba-confirm-payment`の下）・完了画面に
  支払期限つきの注意書き（決済リンクの送信予定・支払期限・自動失効・再申し込み方法・
  二重決済防止の連絡先）を表示する。フォーム上の支払期限は「今、送信したら」の目安
  （申込時点+72時間。`Logic.cardPaymentDueDisplay`）であり、実際の期限はGAS側の
  `createdAt`起点で計算され仮受付メールに記載される。
- `BookingMailTemplates.gs`の`buildPendingMail`は、カード決済のときのみ
  `Booking.computeCardPaymentDueMillis`（Booking Admin表示と同じ1関数）で計算した実際の
  支払期限を本文へ追加する。呼び出し元の`BookingMailer.sendPendingMailForBooking`が
  `BookingConfig.getTtlConfig()`の`minHoursBeforeStart`を`config.ttlConfig`として渡す
  （`buildPendingMail(record, config)`の引数は2つのまま変更していない）。冒頭の既存仮受付案内
  （「このメールの時点では…」）と重複する「※お申し込み時点では仮受付です…」の行は、
  メール本文では省いている（フォーム・確認画面側は省いていない）。現金・PayPay・未定には
  この案内を一切追加しない。
- `_includes/legal_ja.html`／`studio-x/legal/index.html`／`how-to/index.html`／
  `mens/how-to/index.html`／`index.html`／`mens/index.html`／`studio-x/booking/index.html`の、
  カード決済の支払タイミングが「予約確定後」であるかのような矛盾した旧文言、および
  「通常24時間以内にご連絡します」がカードの確定連絡タイミングとして誤解されうる箇所を
  更新した。現金・PayPay・未定の24時間ルールの文言・挙動は変更していない。対象は
  SNB／SNB mens／Studio Xの直接予約ページのみで、相談フォーム・スペースマーケット経由・
  英語版ページ（`booking_app_en.html`等）は対象外。
- Stripeの決済リンクそのものはメールに含めない（PR-Cで運営がBooking Adminから別途送信する）。

## Issue #334: Booking AdminからのStripe決済リンク送信（PR-C）

PR-A（GAS側の期限管理・失効通知・手動復活）・PR-B（利用者向け文言・フォーム表示）に
続く、Issue #334最後のPR。**Issue #334本文のPR分割計画（PR-A→PR-C→PR-B）どおり、
本文が確定仕様として優先される。** 台帳の列追加はPR-Aの`expiredMailSentAt`の**後ろ**に
末尾追記した。

**PR #337レビュー対応（4点。1回目）を本節に反映済み**: ①メール送信後の送信履歴（Sheets）
保存失敗時の扱い（履行未確認の二重送信防止）、②同時再送の競合防止（画面のバージョンと
Lock取得後の最新履歴の比較）、③支払期限の設定（`BookingConfig.getTtlConfig()`）の
受け渡し漏れの修正、④Stripe URLの前後空白の扱いの統一（GAS側と同じfail-closedな
検証へ統一）。**2回目**: ①の競合検知（`expectedSendCount`のみの比較）が送信履歴の
2回目の書き込みだけが失敗するケースをすり抜ける問題の修正（`expectedSentAtVersion`の
追加）。**3回目**: 2回目対応で導入した`paymentLinkMetadataInconsistentAt`が、その後の
送信成功だけでクリアされてしまい記録の食い違いが隠れる問題の修正（送信履歴の照合・
補正が完了するまで送信自体を禁止し、専用の補正操作でのみ解消する）。詳細は各節参照。

### 確定仕様（PR-C）

- 対象は**支払方法がオンラインクレジットカード（`Booking.PAYMENT_METHOD_CARD`）かつ
  status=PENDINGの予約のみ**。現金・PayPay・未定にはBooking Admin側でStripeリンク送信UI
  自体を表示しない（`admin/booking/booking-admin.js`の`canSendPaymentLink`）。
  CONFIRMED・CANCELLED・EXPIREDなどPENDING以外へは送信できない。
- UIでの表示制御に依存せず、**GAS側（`BookingMailer.sendPaymentLinkMailForBooking`）が
  送信直前に予約状態・支払方法・支払期限未到来・予約者メールアドレスの有無を再検証する**
  （`evaluatePaymentLinkEligibility_`）。判定順序: status（PENDINGのみ）→支払方法（カード
  のみ）→二重送信（送信済みかつforceでない場合はALREADY_SENT）→メールアドレス有無→
  支払期限（`Booking.computeCardPaymentDueMillis`。期限を過ぎていればPAYMENT_DUE_PASSED）。
- 管理者がStripe Dashboardで作成したPayment Link URLを、Booking Admin Web UIの予約詳細
  （既存の`#modal-overlay`/`#modal`。`admin/booking/booking-admin.js`が
  `initPaymentLinkUi_`で1回だけDOM生成する専用セクション）へ貼り付け、
  「決済リンクを送信」ボタンを押すとGASが利用者宛に決済案内メールを送信する。
  Stripe APIによるリンク自動生成・Stripe Webhookは実装していない。

### URL検証（GAS側で必須。フロント側は事前チェックのみ）

- `Booking.isValidStripePaymentLinkUrl`（`gas/booking/shared/Booking.gs`）が
  `^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_-]+$`に**完全一致**するURLのみを許可する。
  クエリ・フラグメント・ポート・userinfo・他ホスト（`buy.stripe.com`のサブドメイン偽装・
  ドメイン内に文字列として含むだけの他ホスト等）はいずれも拒否する。
- 前後の空白は、既存の`email`検証（`Booking.gs`の`isValidEmail_`。`^...$`のまま空白を
  許可しない正規表現）と同じ方針で、**trimしてから緩く検証するのではなく、生の値を
  そのまま`^...$`へ通すfail-closedな検証**にした。空白を含む入力はGAS側で
  `INVALID_PAYMENT_LINK_URL`として拒否される。
- **PR #337レビュー対応（前後の空白の扱いを統一）**: フロント側（`admin/booking/
  booking-admin.js`の`isValidStripePaymentLinkUrlClient`／`runSendPaymentLink_`）も、
  以前は入力値を`trim()`してから検証・送信していたため、前後に空白を含む入力が
  黙って除去されたうえで送信されてしまい、GAS側の「trimせずに検証する」方針と
  食い違っていた。これを修正し、フロント側も**trimせず生の入力値のまま**検証する
  よう統一した。前後に空白を含む入力・空文字（空白のみを含む）は、そのまま送信せず
  それぞれ専用の案内文で入力エラーとして案内する（空文字・空白のみ→「URLを入力
  してください」、空白を含む・形式不一致→「URLの形式が正しくありません。前後に
  空白が入っていないか確認し…」）。送信可否の正は変わらずGAS側の
  `sendPaymentLinkMailForBooking`とする（フロント側のチェックをバイパスしても
  GAS側で必ず拒否される）。
- Stripe APIによるリンク生成・Stripe Webhookの実装はこのPRの対象外。

### 決済案内メール

- `BookingMailTemplates.buildPaymentLinkMail`（新規）。管理者キャンセル・仮受付・確定・
  失効通知のいずれのテンプレートも流用しない専用テンプレート。予約者名・予約ID・
  利用日・開始/終了時刻・Stripe決済リンク・実際の支払期限日時・「期限までに支払い、
  確定の連絡を待つ旨（このメールの送信だけでは予約は確定しない）」・「支払い済みなのに
  失効した場合は二重決済・再申し込みをせず運営へ連絡する旨」・問い合わせ先を含む。
- 支払期限は`Booking.computeCardPaymentDueMillis`のみを正として計算する
  （`BookingAdminWeb.gs`の`computeAdminCardPaymentDueAt_`・`BookingMailTemplates.
  buildPendingMail`の仮受付カード案内と同じ1関数。表示用・判定用・メール文面用で
  別計算・別定数を持たない）。**PR #337レビュー対応（設定の受け渡し漏れの修正）**:
  当初、`BookingMailer.sendPaymentLinkMailForBooking`が`ensureMailConfigComplete_()`の
  戻り値（displayName/replyTo/contactEmail/timezoneのみ）をそのまま
  `BookingMailTemplates.buildPaymentLinkMail`へ渡し、`sendPendingMailForBooking`が行っている
  `config.ttlConfig = BookingConfig.getTtlConfig();`の1行を渡し忘れていた。この結果、
  `buildPaymentLinkMail`側で`ttlConfig.minHoursBeforeStart`が`undefined`になり支払期限が
  計算できず、本文が常に「支払期限:（お問い合わせください）」になってしまう不具合が
  あった（送信可否判定の`evaluatePaymentLinkEligibility_`は独自に
  `BookingConfig.getTtlConfig()`を呼ぶため影響を受けず、この回帰はテストで見つかりに
  くかった）。`sendPaymentLinkMailForBooking`にも同じ1行を追加し、送信可否判定・
  Booking Admin表示・仮受付メール・決済リンクメールのすべてが同じ
  `Booking.computeCardPaymentDueMillis`と`BookingConfig.getTtlConfig()`を使う状態に
  揃えた（`test/booking-mailer.test.js`に配線の回帰確認テストを追加）。
- 料金は表示しない（Bookings台帳に確定料金列がないため。Stripeの決済リンク自体の画面で
  確認する運用）。文面は日本語で、既存Bookingメールテンプレート（`joinNonEmpty_`・
  `contactLine_`・曜日表示等）の構造をそのまま使う。

### 二重送信防止と明示的な再送

- `BookingMailer.sendPaymentLinkMailForBooking`は、既存の`withLockedBookingRecord_`
  （`LockService.getScriptLock()`取得→最新レコード再読込→Lock解除。他の全メール種別と
  共通）をそのまま再利用し、独自のLock実装を持たない。
- 二重送信防止は既存のSentAt方式を踏襲する: `paymentLinkSentAt`が空の場合だけ通常送信の
  対象になり、送信成功のたびに最新の送信時刻へ更新する。**初回送信が成功した予約では
  通常の送信操作を無効化する**（`paymentLinkSentAt`が非空かつ`force`未指定はALREADY_SENT
  としてスキップし、実際には送信しない。Booking Admin側もボタンラベルを
  「決済リンクを再送」へ変え、確認ダイアログで明示的な再送であることを示す）。
- 明示的な再送は管理者が`force:true`を指定した場合のみ許可する（`adminSendCardPaymentLink`
  の第3引数）。ただしforceでもstatus/支払方法/期限切れの不一致は無視しない
  （`reminderEligibilityCheck_`と同じ方針）。SentAtを先に消す方式は使わない。
- 連打・同時操作による重複送信は、クライアント側（送信中はボタンを`disabled`にする
  `sendInFlight`ガード）とGAS側（`LockService`による直列化＋`paymentLinkSentAt`の
  二重送信防止）の両方で防ぐ。送信成否が不明な状態での自動再送は行わない
  （失敗時に予約statusを変更しないため、原因解消後は管理者が明示的な再送操作で
  再試行する）。

#### PR #337レビュー対応①: メール送信後の送信履歴（Sheets）保存失敗時の扱い（履行未確認の二重送信防止）

当初の実装は、`MailApp.sendEmail`成功後に`stripePaymentLinkUrl`/`paymentLinkSentAt`/
`paymentLinkSentTo`/`paymentLinkSendCount`/エラー系列クリアの6フィールドを1回の
`updateBookingFields`呼び出しでまとめて更新し、その呼び出し自体が失敗した場合は
Loggerへ記録するだけで`success:true`を返していた。これには次の問題があった:

- メールは送信済みなのに、二重送信防止の要となる`paymentLinkSentAt`が空のまま残る。
- 次に管理者が「通常の送信」ボタン（forceなし）を押すと、`ALREADY_SENT`判定に
  引っかからずにそのまま再送してしまい、二重送信になり得る。
- 失敗が起きたこと自体がBooking Admin側からは分からない（ログのみ）。

これを修正し、`sendPaymentLinkMailForBooking`は次の手順で書き込む:

1. `paymentLinkSentAt`のみを**単独**の`updateBookingFields`呼び出しで先に更新する
   （他のフィールドと同じ呼び出しにまとめない。1回の`updateBookingFields`呼び出しは
   複数フィールドを順に書き込む実装のため、途中のフィールドで例外が起きると
   `paymentLinkSentAt`の書き込み成否があいまいになるのを避けるため）。
2. この単独更新が**失敗**した場合、「メールは送信された可能性があるが、履行を確定
   できない」状態と判断し、`paymentLinkSendUnconfirmedAt`（新規列。後述）へ同じ送信
   時刻を記録（このフォールバック書き込み自体が失敗してもLoggerへ記録して処理は
   続ける）し、Recoveryへ`failureType: 'PAYMENT_LINK_SEND_HISTORY_UPDATE_FAILED'`で
   記録する。呼び出し元には`success:false`・`mailSent:true`・
   `requiresManualConfirmation:true`（`error.code: 'PAYMENT_LINK_HISTORY_UPDATE_FAILED'`）
   を返し、Booking Adminは「送信結果を確認できませんでした（メールは送信された
   可能性があります）」と案内する。
3. `paymentLinkSendUnconfirmedAt`が空でない間は、`evaluatePaymentLinkEligibility_`が
   `SEND_UNCONFIRMED`として**通常送信（forceなし）を拒否する**（`ALREADY_SENT`と同じ
   優先順位・同じくforceで無視できる）。つまり履行未確認の予約は、他のSentAt列と
   同じ「空の場合だけ通常送信の対象になる」二重送信防止の仕組みにそのまま乗る。
4. この単独更新が**成功**した場合のみ、URL・送信先・送信回数・
   `paymentLinkSendUnconfirmedAt`のクリア・エラー系列のクリアを2回目の
   `updateBookingFields`呼び出しでまとめて更新する。この2回目が失敗しても、二重送信
   防止の要となる`paymentLinkSentAt`は既に記録済みのため、Loggerへ記録するのみで
   `success:true`を返す（送信回数等の付随情報が更新されないだけで、二重送信には
   つながらない）。
5. 明示的な再送（force）に成功すると、`paymentLinkSendUnconfirmedAt`は自動的に空へ
   戻る。

`test/booking-mailer.test.js`に、`SpreadsheetRepository.updateBookingFields`を
`paymentLinkSentAt`単独呼び出し時にのみ失敗させるスタブ（`stubCriticalSentAtWriteFailure_`）
を使った部分失敗テストを追加した（履行未確認状態への遷移・Recovery記録・通常送信の
拒否・明示的な再送での復旧の4点を検証）。

#### PR #337レビュー対応②: 同時再送の競合防止

別タブ・別端末から同じ予約に対して同時に操作した場合、`LockService`はGAS実行の直列化
（互いに待たせる）はするが、それぞれが独立に「送信してよい」と判断して`force:true`を
渡してくる場合まではブロックしない（例: 両方が同じ`paymentLinkSendCount`を見た状態で
明示的な再送を選ぶと、直列化はされるが両方とも実際に送信されてしまう）。

これを防ぐため、Booking Adminの画面が最後に取得した`paymentLinkSendCount`
（＝「画面が知っている送信履歴のバージョン」）を`expectedSendCount`としてサーバーへ渡し、
`BookingMailer.gs`の`checkSendHistoryVersion_`が、Lock取得後に再読込した最新の
`paymentLinkSendCount`と比較する。一致しない場合は、別タブ・別端末が既に送信操作を
行ったと判断し、`error.code: 'SEND_HISTORY_CONFLICT'`として拒否する（メール送信・
Sheets更新のいずれも行わない）。この競合チェックは**通常送信・明示的な再送の両方に
適用する**（`force`は「送信済みでも送る」ことの許可であり、「古い前提のまま送る」
ことの許可ではないため、`force`でもこの競合チェックは無視しない）。
`expectedSendCount`を渡さない呼び出し（省略時）は、この競合チェック自体を行わない
（新しいクライアントのみが検知できる追加の安全策のため、省略時に既存挙動を壊さない）。

配線: `admin/booking/booking-admin.js`の`runSendPaymentLink_`が、開いている詳細
（`currentDetailBooking_.paymentLinkSendCount`）をそのまま`adminSendCardPaymentLink`の
第4引数へ渡す → `BookingAdminWeb.gs`の`adminSendCardPaymentLink(bookingId, paymentLinkUrl,
force, expectedSendCount)`が`options.expectedSendCount`としてそのまま
`sendCardPaymentLinkMail`（`BookingAdmin.gs`）→`BookingMailer.sendPaymentLinkMailForBooking`
へ渡す（いずれも値を変換・検証せずそのまま中継するだけで、競合判定自体は
`checkSendHistoryVersion_`の1箇所に集約する）。

`test/booking-mailer.test.js`・`test/booking-admin-web.test.js`の両方に、通常送信・
明示的な再送それぞれについて「タブA（先行）は成功し、タブB（画面を再取得していない
古い前提）は`SEND_HISTORY_CONFLICT`で拒否される」形の競合テストを追加した。

#### 第2回レビュー対応: 送信履歴の部分失敗が競合検知をすり抜ける問題の修正

`sendPaymentLinkMailForBooking`は`paymentLinkSentAt`を単独で先に書き込み、
`stripePaymentLinkUrl`/`paymentLinkSentTo`/`paymentLinkSendCount`等は2回目の
`updateBookingFields`呼び出しでまとめて書き込む（「PR #337レビュー対応①」参照）。
**この2回目の呼び出しだけが失敗すると、`paymentLinkSentAt`は新しい送信時刻に更新される
一方で`paymentLinkSendCount`は古い値のまま残る。** この状態で、2回目の失敗が起きる
**前**の画面（古い`paymentLinkSentAt`・かつ古い`paymentLinkSendCount`を見ている）から
明示的な再送を行うと、`paymentLinkSendCount`だけを比較する版の競合チェック
（「PR #337レビュー対応②」）では一致してしまい（実際にはcountが変化していないため）、
競合を検知できずに通過してしまう。この問題を次の2点で修正した:

1. **`paymentLinkSentAt`も送信履歴のバージョンとして比較する**: `checkSendHistoryVersion_`
   が`expectedSendCount`に加えて`expectedSentAtVersion`（`paymentLinkSentAt`の内部表現。
   epoch ms。未送信は0）を受け取り、それぞれ独立に最新値と比較する。
   `paymentLinkSendCount`が変わっていなくても、`paymentLinkSentAt`が変わっていれば
   `SEND_HISTORY_CONFLICT`として拒否する（`expectedSendCount`と同じく、通常送信・
   明示的な再送の両方に適用し、`force`でも無視しない）。表示用の`paymentLinkSentAt`
   文字列（`'YYYY-MM-DD HH:mm'`。分単位）ではなく、`getAdminBookingDetail`が新たに返す
   `paymentLinkSentAtVersion`（epoch ms）を使う。分単位の文字列では同一分内の複数回の
   書き込みを区別できないため。クライアントはこの値を解釈・加工せず、
   `adminSendCardPaymentLink`の第5引数へそのまま往復させるだけの内部トークンとして扱う。
2. **2回目の書き込み失敗自体を管理者が気付けるようにする**: 2回目の`updateBookingFields`
   呼び出しが失敗した場合、単にLoggerへ記録するだけでは（1回目のレビュー対応前と同じ
   問題が別の形で残ってしまうため）不十分と判断し、新規列
   `paymentLinkMetadataInconsistentAt`への記録（フォールバックの単独書き込み）と
   Recoveryへの記録（`failureType: 'PAYMENT_LINK_METADATA_UPDATE_FAILED'`）を追加した。
   呼び出し元には`success:true`のまま（送信履行自体は確定しているため）
   `metadataInconsistent:true`・`sendCount`（実際に記録されている古い値）・
   `intendedSendCount`（本来記録されるはずだった値）を返す。**メール自体の再送は
   自動実行しない**（送信は既に完了しているため）。Booking Adminはこの状態を
   「記録不整合」として表示し、`paymentLinkSendCount`の表示が実際の送信回数より
   少ない可能性があることを管理者へ案内する。

配線: `admin/booking/booking-admin.js`の`runSendPaymentLink_`が、開いている詳細
（`currentDetailBooking_.paymentLinkSentAtVersion`）をそのまま`adminSendCardPaymentLink`
の第5引数へ渡す → `BookingAdminWeb.gs`の`adminSendCardPaymentLink(bookingId,
paymentLinkUrl, force, expectedSendCount, expectedSentAtVersion)`が
`options.expectedSentAtVersion`としてそのまま`sendCardPaymentLinkMail`
（`BookingAdmin.gs`）→`BookingMailer.sendPaymentLinkMailForBooking`へ渡す。

`test/booking-mailer.test.js`・`test/booking-admin-web.test.js`の両方に、
「`paymentLinkSentAt`だけを直接進めて`paymentLinkSendCount`を変えない」ことで
2回目書き込み失敗後の状態を模擬し、`expectedSendCount`が実際の値と一致していても
`expectedSentAtVersion`が古い場合は競合として拒否されることを検証するテストを追加した。
さらに、2回目の書き込みだけを失敗させるスタブ（`stubMetadataWriteFailure_`）を使い、
**要件どおり「2回目の保存だけが失敗した状態」を実際に再現したうえで**、その状態を
見ていない別タブの古い前提（送信前と同じ`expectedSendCount`・`expectedSentAtVersion`）
からの明示的な再送が`SEND_HISTORY_CONFLICT`で拒否されることを検証した
（既存の通常送信・明示的な再送のテストは変更せずすべて維持している）。

#### 第3回レビュー対応: 記録不整合フラグが送信成功だけでクリアされてしまう問題の修正

第2回対応で導入した`paymentLinkMetadataInconsistentAt`（送信履行は確定しているが、続く
URL/送信先/送信回数の記録に失敗した状態）には、次の問題が残っていた: **その後の
明示的な再送が（両方の書き込みに）成功しただけで、このフラグが自動的にクリアされてしまう。**
このとき`paymentLinkSendCount`は「直前の記録値+1」として更新されるが、直前の記録値
自体が既に実際の送信回数より少ないまま（不整合の原因そのものは未解消）だったため、
台帳上の送信回数は実際の送信回数より少ないまま固定され、しかも不整合を示す手がかり
（フラグ）が消えてしまうため、この食い違いに誰も気付けなくなる。

これを次の3点で修正した:

1. **記録不整合の間は送信自体を禁止する**: `evaluatePaymentLinkEligibility_`に
   `METADATA_INCONSISTENT`判定を追加し、`paymentLinkMetadataInconsistentAt`が空でない
   間は通常送信・明示的な再送のいずれも拒否する。**`force`でも無視しない**（他の拒否
   理由と異なり、送信履歴の照合・補正が完了するまでは、管理者の「送信済みでも送る」
   という意思表示だけでは通過させてはいけないため）。
2. **送信成功だけでフラグをクリアしない**: `sendPaymentLinkMailForBooking`の成功パスの
   `updateBookingFields`呼び出しから`paymentLinkMetadataInconsistentAt: ''`を削除した
   （そもそも1.の判定により、この書き込みに到達する時点でこの列は既に空であることが
   保証されている）。このフラグをクリアできるのは、次の専用の補正関数のみとする。
3. **専用の補正操作を新設する**: `BookingMailer.resolvePaymentLinkMetadataInconsistency
   (bookingId, confirmedSendCount)`。管理者がBookingsシート・Recoveryシート
   （`PAYMENT_LINK_METADATA_UPDATE_FAILED`）・実際のメール送信状況を確認し、正しい
   送信回数を確認したうえで呼び出す、Sheetsの記録のみを補正する関数（メール送信・
   Calendar操作は行わない）。

**対象・操作権限・確認手順の限定**（既存の履歴を誤って上書きしないための制約）:

- **対象の限定**: `paymentLinkMetadataInconsistentAt`が現在記録されている予約のみを
  受け付ける。空の予約に対しては`NOT_INCONSISTENT`として拒否し、無関係な予約の送信
  履歴を誤って書き換えられないようにする。
- **書き込み方向の限定**: `confirmedSendCount`は0以上の整数のみ許可し（`INVALID_
  CONFIRMED_SEND_COUNT`）、**現在記録されている`paymentLinkSendCount`より小さい値へは
  補正できない**（`CONFIRMED_SEND_COUNT_TOO_LOW`）。記録不整合は常に「実際の送信回数を
  過少に記録する」方向にのみ発生するため、正しい補正値は現在値以上になるはずであり、
  それより小さい値の指定は入力ミス・既存履歴の意図しない消去である可能性が高いため
  fail-closedに拒否する。（3回目対応時点では`confirmedSendCount`のみが補正対象だった。
  5回目対応で`confirmedUrl`・`confirmedSentTo`を追加し、URL・送信先も併せて確認・補正
  できるよう拡張した。詳細は「第5回レビュー対応」参照。）
- **操作権限の限定**: `resolveCardPaymentLinkMetadataInconsistency`
  （`BookingAdmin.gs`）・`adminResolvePaymentLinkMetadataInconsistency`
  （`BookingAdminWeb.gs`）ともBooking Admin側のみで公開し、Booking Web Appには追加
  しない。Booking Adminプロジェクト自体が「Execute as: Me / Who has access: Only
  myself」で運用する前提（「Booking Admin Web UI（Issue #305）のセットアップ」参照）
  であり、この補正操作もその単一管理者アクセスの範囲内でのみ実行できる。Spreadsheet
  カスタムメニューへは追加していない（Booking Admin予約詳細のUIからのみ実行する）。
- **確認手順の限定**: 実行前の内容確認（現在の送信回数の表示・`window.prompt`での
  補正値の入力・`window.confirm`での最終確認）はすべてHTML側（クライアント）で行う
  （他の管理操作と同じ方針）。クライアント側の`parseConfirmedSendCount_`が0以上の
  整数形式・現在値以上であることを事前チェックするが、送信可否の正はあくまでGAS側の
  検証とする。

補正に成功すると、`paymentLinkMetadataInconsistentAt`が空へ戻り送信が再び許可される
ことに加え、補正の実施自体をRecoveryへ`failureType: 'PAYMENT_LINK_METADATA_RESOLVED'`・
`recoveryState: 'RESOLVED'`として記録する（元の`PAYMENT_LINK_METADATA_UPDATE_FAILED`
のOPEN行自体は、既存の他の失敗記録と同じく運用者が手動で`recoveryState`/`resolvedAt`を
記録する方針のまま変更しない。この`RESOLVED`行は補正操作が実際に行われたことを示す
別の記録）。

Booking Admin UIには、記録不整合の間だけ表示される専用の「送信履歴を補正」ボタン
（`admin/booking/booking-admin.js`の`initPaymentLinkUi_`/`renderPaymentLinkSection_`/
`runResolvePaymentLinkMetadataInconsistency_`）を追加した。送信ボタン・URL入力欄は
記録不整合の間は無効化され、ボタンの文言も「送信不可（記録不整合。補正が必要）」に
変わる。

`test/booking-mailer.test.js`・`test/booking-admin-web.test.js`・
`test/booking-admin-page-client.test.js`に、（a）2回目の履歴保存失敗後、画面を最新化
した（stale判定には引っかからない）操作であっても通常送信・明示的な再送のいずれも
`METADATA_INCONSISTENT`で拒否されること、（b）`resolvePaymentLinkMetadataInconsistency`
による補正後は送信が再び許可されること、（c）対象外の予約・不正な補正値・現在値より
小さい補正値がそれぞれ適切に拒否され既存の記録を書き換えないこと、を検証するテストを
追加した。

#### 第4回レビュー対応: resolvePaymentLinkMetadataInconsistency自体の部分失敗対策

第3回対応で新設した`resolvePaymentLinkMetadataInconsistency`には、次の問題が残っていた:
送信回数の補正（`paymentLinkSendCount`）と不整合フラグのクリア（
`paymentLinkMetadataInconsistentAt: ''`）を、1回の`updateBookingFields`呼び出しへ
まとめて渡していた。`updateBookingFields`は渡されたフィールドを内部でループして
1つずつ書き込む実装のため（このファイルの他の箇所と同じ制約。「送信履歴・エラー管理」節
参照）、途中の書き込みだけが失敗すると「送信回数の補正が反映されていないのに、
不整合フラグだけが先に（またはたまたま）クリアされてしまう」おそれがあった。これは
第3回対応が防いだはずの「食い違いを隠す方向の失敗」を、補正操作自体が新たに持ち込んで
しまうことになる。

これを次のように修正した:

1. **書き込みを分離する**: `paymentLinkSendCount`の更新と`paymentLinkMetadataInconsistentAt`
   のクリアを、それぞれ単独の`updateBookingFields`呼び出しに分離した（送信回数の
   補正を先に行い、不整合フラグはまだ触らない）。
2. **実際に保存されたことを確認してから次へ進む**: 送信回数の更新後、`findRowByBookingId`で
   最新レコードを再取得し、`paymentLinkSendCount`が確認済みの値どおりに反映された
   ことを検証する。この検証は、更新呼び出しが例外を投げた場合だけでなく、**例外が
   起きなかった場合にも同様に行う**（Sheets側が例外を投げずに書き込みに失敗する
   可能性もゼロではないため、例外の有無だけを信用しない。このファイルの他の箇所
   （`criticalWriteFailed`等）と同じ方針）。反映を確認できて初めて、続く
   `paymentLinkMetadataInconsistentAt`のクリアへ進む。
3. **途中で失敗した場合は不整合の警告を維持する**: 送信回数の更新が反映されたことを
   確認できない場合は`RESOLVE_SEND_COUNT_NOT_CONFIRMED`、送信回数の反映は確認できたが
   続くフラグのクリアが反映されたことを確認できない場合は`RESOLVE_FLAG_CLEAR_NOT_
   CONFIRMED`として失敗を返す。いずれの場合も`paymentLinkMetadataInconsistentAt`は
   維持され（クリアされていないことを再取得で確認済み）、送信は
   `evaluatePaymentLinkEligibility_`のMETADATA_INCONSISTENT判定により引き続き拒否
   される（既存の96時間受付条件・72時間支払期限・送信履歴の競合検知・Stripe URL検証
   はいずれも変更していない）。呼び出し元には`requiresManualConfirmation: true`を
   返し、補正が完了していないことを伝える。
4. **補正の試行状況をRecoveryへ記録する**: 上記のいずれかで補正が完了しなかった場合、
   `recordPaymentLinkResolveIncomplete_`が`failureType: 'PAYMENT_LINK_METADATA_
   RESOLVE_INCOMPLETE'`・`recoveryState: 'OPEN'`としてRecoveryへ記録する（元の
   `PAYMENT_LINK_METADATA_UPDATE_FAILED`のOPEN行＝送信時点で発生した最初の不整合とは
   別の記録。「補正を試みたが完了しなかった」ことを区別できるようにする）。
   `failureType: 'PAYMENT_LINK_METADATA_RESOLVED'`（成功）は、送信回数の反映・
   フラグのクリアの両方を再取得で確認できた場合のみ記録される。

`SpreadsheetRepository.gs`の`paymentLinkMetadataInconsistentAt`列の説明コメントも、
「次に両方の更新が成功すると自動的に空へ戻る」という古い（第3回対応より前の）記述を、
現在の「補正完了（送信回数の反映確認→フラグのクリア確認の両方）まで送信を拒否し続け、
専用の補正関数のみがクリアできる」という仕様に合わせて更新した。

`test/booking-mailer.test.js`に、送信回数の補正書き込みが（a）例外で失敗した場合、
（b）例外を投げずに反映されなかった場合（silentな失敗。再取得による検証が必要である
ことの確認）、（c）送信回数の補正は保存できたが続くフラグのクリアだけが失敗した場合、
のそれぞれについて、`resolvePaymentLinkMetadataInconsistency`が適切なエラーコードを
返し不整合フラグを維持したままRecoveryへ記録し、その後の通常送信・明示的な再送
（force）とも依然`METADATA_INCONSISTENT`で拒否されることを検証するテストを追加した。

#### 第5回レビュー対応: 補正対象の不足（URL・送信先）と、最終再取得不能時の断定的な案内の修正

第4回対応までの`resolvePaymentLinkMetadataInconsistency`には、次の2つの問題が残っていた。

**1. 補正対象の整合性**: `paymentLinkMetadataInconsistentAt`が立つ原因（
`PAYMENT_LINK_METADATA_UPDATE_FAILED`）となる2回目の書き込みは
`stripePaymentLinkUrl`/`paymentLinkSentTo`/`paymentLinkSendCount`の3項目を対象と
するのに対し、`resolvePaymentLinkMetadataInconsistency`は`paymentLinkSendCount`
（送信回数）のみを補正すればフラグをクリアできる設計になっていた。このため、
管理者が送信回数だけを確認・補正すると、URL・送信先が実際に送信したものと食い違った
まま（古いまま）不整合フラグだけが解除されてしまう恐れがあった。

これを修正し、`resolvePaymentLinkMetadataInconsistency(bookingId, confirmedSendCount,
confirmedUrl, confirmedSentTo)`へ引数を拡張した。`confirmedUrl`は`Booking.
isValidStripePaymentLinkUrl`（送信時と同じ正規表現・trimなしのfail-closedな検証）で
検証し、不正な形式は`INVALID_CONFIRMED_URL`として拒否する。`confirmedSentTo`は
`Booking.isValidEmail`（`validateCreateBookingInput`のメールアドレス検証と同じ形式
検証。この検証用に`isValidEmail_`を`Booking.isValidEmail`として新たに公開した）で
検証し、不正な形式は`INVALID_CONFIRMED_SENT_TO`として拒否する。既存の96時間受付
条件・72時間支払期限・送信履歴の競合検知・Stripe URL検証（送信時のもの）は変更して
いない。

書き込みの分離・検証も3項目へ拡張した（第4回対応の設計を維持したまま対象を広げた）:
1. `stripePaymentLinkUrl`・`paymentLinkSentTo`・`paymentLinkSendCount`の3項目を
   まとめて更新する（不整合フラグはまだ触らない）。
2. 最新レコードを再取得し、**3項目すべて**が確認済みの値どおりに反映されたことを
   検証する。1項目でも確認できない場合は`RESOLVE_FIELDS_NOT_CONFIRMED`として失敗を
   返す（第4回対応の`RESOLVE_SEND_COUNT_NOT_CONFIRMED`を置き換えた。この時点では
   まだ不整合フラグのクリアを試みていないため、「フラグは維持されている」と断定して
   よい）。
3. 3項目すべての反映を確認できてから、`paymentLinkMetadataInconsistentAt`のみを
   単独で空へ更新する。
4. 再度最新レコードを再取得し、フラグが実際に空になったことを検証する
   （`RESOLVE_FLAG_CLEAR_NOT_CONFIRMED`。次項2.参照）。

**2. 最終再取得に失敗した場合の断定的な案内**: 上記4.の再取得自体が失敗した場合、
第4回対応の実装は「フラグは維持されている」と断定して案内していたが、これは正確では
なかった。3.のクリア操作自体は実際には成功していた可能性があり、その直後の再取得
だけが失敗した場合、フラグが実際にクリアされているか維持されているかは**確認でき
ない**。「維持されている」と断定した案内を返すと、実際の台帳の状態と食い違う可能性
がある。

これを修正し、4.の再取得自体が失敗した場合（クリア操作の`updateBookingFields`呼び出し
自体が例外を投げた場合だけでなく、その後の`findRowByBookingId`だけが失敗した場合も
含む）は`RESOLVE_RESULT_UNKNOWN`として失敗を返し、「フラグが実際にクリアされている
かどうかは不明です。Bookingsシートを直接確認してください」と案内する（「維持されて
いる」とは述べない）。再取得に**成功**し、その内容からフラグがまだ空になっていない
ことを確認できた場合のみ、確定的な`RESOLVE_FLAG_CLEAR_NOT_CONFIRMED`を返す。
`RESOLVE_RESULT_UNKNOWN`・`RESOLVE_FLAG_CLEAR_NOT_CONFIRMED`のいずれも
`PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`としてRecoveryへ記録する（3項目の補正
自体はいずれの場合も2.で確認済みであるため、`errorMessage`にその旨も含める）。

Booking Admin UIの「送信履歴を補正」操作（`runResolvePaymentLinkMetadataInconsistency_`）
も、送信回数の確認・入力に加えて、URL・送信先メールアドレスの確認・入力を求める
`window.prompt`をそれぞれ追加した（既定値は現在Bookingsシートに記録されている値。
実際の送信履歴と一致していればそのまま確定でよい）。クライアント側の事前チェックは
既存の`isValidStripePaymentLinkUrlClient`と、新設した`isValidEmailClient_`
（GAS側の`Booking.isValidEmail`と同じ正規表現）で行うが、送信可否の正はあくまで
GAS側の検証とする（他の入力と同じ方針）。確認ダイアログにもURL・送信先を含めて表示
する。

`test/booking-mailer.test.js`に、URL・送信先は既に正しく送信回数だけが古い状態で
送信回数の補正書き込みだけが失敗するケース（3項目のうち1項目だけが古いまま残る
状態の再現。補正完了前に不整合フラグが解除されないことを確認）、不整合フラグのクリア
操作後の最終確認の再取得自体だけが失敗するケース（`RESOLVE_RESULT_UNKNOWN`。断定的な
文言を含まないことを確認）、`confirmedUrl`/`confirmedSentTo`の形式検証
（`INVALID_CONFIRMED_URL`/`INVALID_CONFIRMED_SENT_TO`）を追加した。
`test/booking-admin-web.test.js`・`test/booking-admin-page-client.test.js`にも、
Web UI層・クライアント層でのURL・送信先の配線・検証・プロンプトのキャンセル/
不正入力時の挙動を検証するテストを追加した。

### 送信履歴・エラー管理（Bookingsシートへの列追加）

`SpreadsheetRepository.gs`の`HEADERS_`へ、`expiredMailSentAt`（Issue #334 PR-A）の
**後ろ**に次の8列を末尾追記した（既存列の順番は変更していない。7列目
`paymentLinkSendUnconfirmedAt`はPR #337レビュー対応（1回目）、8列目
`paymentLinkMetadataInconsistentAt`はPR #337レビュー対応（2回目）で追加した）:

- `stripePaymentLinkUrl`: 管理者が最後に入力・送信したStripe Payment Link URL。
- `paymentLinkSentAt`: 決済リンクメールの送信に成功し、かつその履行を記録できた直近の
  日時。空の場合だけ通常送信の対象になる（二重送信防止の基準列。他のSentAt列と同じ方式）。
- `paymentLinkSentTo`: 直近の送信に成功した宛先メールアドレス（送信時点の`record.email`）。
- `paymentLinkSendCount`: 決済リンクメールの送信成功回数（初回送信・明示的な再送を問わず、
  履行を確定できた送信が成功するたびに1加算する）。Booking Admin画面が「送信履歴の
  バージョン」として保持し、同時再送の競合検知（`expectedSendCount`）にも使う
  （「二重送信防止と明示的な再送」節「PR #337レビュー対応②」参照）。
- `paymentLinkLastErrorAt` / `paymentLinkLastErrorMessage`: 決済リンクメールの直近の送信
  失敗時刻・エラー内容（`BookingMailer.sanitizeErrorMessage`でredaction済み）。**既存の
  `lastMailErrorAt`/`lastMailErrorType`/`lastMailErrorMessage`（他のメール種別が共有する
  列）とは別の専用列とする。** Booking Admin予約詳細で決済リンク送信専用の送信状態
  （未送信/送信済み・送信回数・最終送信エラー）を表示する要件があり、他メール種別の
  エラーと混在させると誤表示になるため。次回の送信に成功すると自動的に空へ戻す。
- `paymentLinkSendUnconfirmedAt`（PR #337レビュー対応・1回目で追加）: MailApp.sendEmailは
  成功したが、直後の`paymentLinkSentAt`単独更新が失敗し、送信済みかどうかを確定できない
  場合の日時。空でない間は、`paymentLinkSentAt`と同じ二重送信防止の仕組みにより
  **通常送信（forceなし）を拒否する**（詳細は「二重送信防止と明示的な再送」節
  「PR #337レビュー対応①」参照）。次に送信履行が確定すると自動的に空へ戻る。
- `paymentLinkMetadataInconsistentAt`（PR #337レビュー対応・2回目で追加）:
  `paymentLinkSentAt`の単独更新には成功した（＝送信履行・二重送信防止は確定済み）が、
  続く`stripePaymentLinkUrl`/`paymentLinkSentTo`/`paymentLinkSendCount`等の2回目の
  更新が失敗し、これらの記録内容が古い・不正確なままの可能性がある場合の日時。
  **空でない間は通常送信・明示的な再送のいずれも`METADATA_INCONSISTENT`として拒否する
  （`force`でも無視しない。3回目対応。詳細は「二重送信防止と明示的な再送」節
  「第3回レビュー対応」参照）。** 他の送信が成功しただけでは自動的にクリアされない。
  クリアできるのは専用の補正関数`resolvePaymentLinkMetadataInconsistency`のみ。
- 送信失敗時はRecoveryシートへ`failureType: 'PAYMENT_LINK_MAIL_FAILED'`（メール送信
  自体の失敗）・`'PAYMENT_LINK_SEND_HISTORY_UPDATE_FAILED'`（メール送信は成功したが
  `paymentLinkSentAt`単独更新の失敗で履行の記録に失敗）・
  `'PAYMENT_LINK_METADATA_UPDATE_FAILED'`（`paymentLinkSentAt`単独更新は成功したが
  続く2回目の更新に失敗）のいずれかとして記録する（`status`列には呼び出し時点の
  予約status＝PENDINGを記録する。他の`MAIL_*_FAILED`と同じ記録方式）。
- いずれの失敗でも予約statusを一切変更しない（PENDINGのまま維持する）。管理者が
  `paymentLinkLastErrorMessage`・`paymentLinkSendUnconfirmedAt`・Recoveryシートで内容を
  確認し、原因解消後・実際の到達確認後にBooking Admin予約詳細から安全に再試行
  （明示的な再送）できる。

**本番反映時の注意（本PRでは実施しない）**: 台帳に新規列（`stripePaymentLinkUrl`〜
`paymentLinkMetadataInconsistentAt`の8列）を追加したため、本番反映時は既存Booking Admin
デプロイをnew versionで更新し、既存`/exec` URLを維持したうえで、**本番Bookingsシートの
ヘッダー行へこの8列を`expiredMailSentAt`の後ろに手動で追記**すること（ヘッダー行は
シートが空のときしか自動で書かれないため。詳細は「Spreadsheet構成」節参照）。

### Booking Admin UIの変更

- `BookingAdminWeb.gs`の`getAdminBookingDetail`が、決済リンク送信欄の表示制御・送信状態
  表示用に`isCardPayment`（`Booking.isCardPaymentMethod`と同じ判定の真偽値）・
  `stripePaymentLinkUrl`・`paymentLinkSentAt`・`paymentLinkSentTo`・`paymentLinkSendCount`・
  `paymentLinkLastErrorAt`・`paymentLinkLastErrorMessage`・`paymentLinkSendUnconfirmedAt`
  （PR #337レビュー対応・1回目で追加）・`paymentLinkMetadataInconsistentAt`・
  `paymentLinkSentAtVersion`（いずれもPR #337レビュー対応・2回目で追加。後者は
  `paymentLinkSentAt`の内部表現＝epoch ms。同時再送の競合検知専用の内部トークンで、
  表示には使わない）を追加で返す。既存の`getAdminBookings`（一覧）・`hasMailError`の
  扱い（詳細フィールドを一覧へ出さない方針）は変更していない。
- `BookingAdmin.gs`に正式関数`sendCardPaymentLinkMail(bookingId, paymentLinkUrl, options)`
  （`BookingMailer.sendPaymentLinkMailForBooking`へそのまま委譲）を追加した。
  `BookingAdminWeb.gs`の`adminSendCardPaymentLink(bookingId, paymentLinkUrl, force,
  expectedSendCount, expectedSentAtVersion)`（第4引数はPR #337レビュー対応・1回目、
  第5引数は2回目で追加。いずれも同時再送の競合検知用）がWeb UIから同じ関数へ委譲する
  （confirm/cancel/reviveと同じ「独自ロジックを持たない薄いラッパー」の方針）。
  Spreadsheetカスタムメニューへは追加していない（Issue #334本文が対象とするのは
  Booking Admin予約詳細のUIのみのため）。
- `admin/booking/booking-admin.js`／`booking-admin.css`（GitHub Pages配信。
  `BookingAdminPage.html`自体は変更していないためGAS Web Appの再デプロイは不要
  ・「Booking Adminフロントエンドの外部化（Issue #317）」参照）が、既存の詳細モーダル
  （`#modal-overlay`/`#modal`）内へ決済リンク送信欄（URL入力・送信状態表示・送信ボタン）
  を追加した。送信前には`window.confirm`で予約者名・メールアドレス・利用日時・支払期限・
  送信するStripe URLを表示して確認する（`buildPaymentLinkConfirmMessage_`）。
  「送信結果未確認（要確認）」「記録不整合」のいずれの状態も専用の強調行で表示する
  （`payment-link-status-row-warning`）。既存の一覧・詳細・確定・キャンセル・復活・
  診断モーダルの挙動は変更していない。

### テスト（PR-C）

- `test/booking-model.test.js` — `Booking.isValidStripePaymentLinkUrl`の許可/拒否パターン
  （正しい形式・http・他ホスト・サブドメイン偽装・userinfo・ポート・クエリ・フラグメント・
  前後空白・空文字・非文字列）。
- `test/booking-mail-templates.test.js` — `buildPaymentLinkMail`の必須内容（予約者名・
  予約ID・利用日時・URL・支払期限・確定連絡待ちの旨・二重決済防止の連絡案内）・料金を
  表示しないこと・日時データ欠損時にも例外を投げないことを検証する。
- `test/booking-mailer.test.js` — `sendPaymentLinkMailForBooking`のカード×PENDING限定・
  現金/PayPay/未定拒否・PENDING以外拒否・不正URL拒否・支払期限切れ拒否・二重送信防止・
  明示的な再送（force）・force下でもstatus等の不一致は無視しないこと・メール送信失敗時に
  status不変かつ専用のpaymentLinkLastError*へ記録されRecoveryへも記録されること・送信
  成功でエラーがクリアされること・メールアドレス未登録拒否・LockService連携を検証する。
  **PR #337レビュー対応・1回目で追加**: `paymentLinkSentAt`単独更新の失敗（履行未確認）
  時に`requiresManualConfirmation:true`を返しRecoveryへ記録すること・履行未確認の間は
  通常送信を拒否し明示的な再送でのみ復旧できること（部分失敗テスト）、通常送信・明示的な
  再送それぞれについて`expectedSendCount`が古い場合に`SEND_HISTORY_CONFLICT`で拒否する
  こと（競合テスト）、`buildPaymentLinkMail`へ`BookingConfig.getTtlConfig()`が実際に
  渡り、Booking Admin表示・仮受付メールと同じ支払期限が本文に入ること（配線の回帰確認）。
  **2回目で追加**: `expectedSendCount`が一致していても`expectedSentAtVersion`が
  古い場合は通常送信・明示的な再送のいずれもSEND_HISTORY_CONFLICTで拒否すること、
  2回目の書き込みだけを失敗させるスタブ（`stubMetadataWriteFailure_`）で
  「2回目の保存だけが失敗した状態」を実際に再現し、`metadataInconsistent:true`・
  実際の送信回数（`sendCount`）・本来の送信回数（`intendedSendCount`）・
  `paymentLinkMetadataInconsistentAt`・Recovery記録を検証したうえで、その状態を
  見ていない別タブの古い前提からの明示的な再送がSEND_HISTORY_CONFLICTで拒否される
  ことを検証する。既存の通常送信・明示的な再送のテストは変更せず維持している。
- `test/booking-admin-web.test.js` — `getAdminBookingDetail`の`isCardPayment`・決済リンク
  関連フィールド（`paymentLinkSendUnconfirmedAt`・`paymentLinkMetadataInconsistentAt`・
  `paymentLinkSentAtVersion`を含む）の初期値、`adminSendCardPaymentLink`が
  `sendCardPaymentLinkMail`へ委譲していること（送信成功・二重送信防止・明示的な再送・
  対象外拒否・不正URL拒否）を検証する。**PR #337レビュー対応・1回目で追加**:
  `expectedSendCount`（第4引数）を渡した競合検知（通常送信・明示的な再送の両方）、
  履行未確認状態がWeb UI層まで正しく伝わること（`requiresManualConfirmation`・
  `paymentLinkSendUnconfirmedAt`・通常送信の拒否）。**2回目で追加**:
  `expectedSentAtVersion`（第5引数）による競合検知、2回目の履歴保存だけが失敗した
  状態のWeb UI層での再現・別タブの古い前提からの明示的な再送の拒否。
- `test/booking-admin-page-client.test.js` — `canSendPaymentLink`・
  `isValidStripePaymentLinkUrlClient`・`paymentLinkStatusLabel_`・
  `paymentLinkRequiresExplicitResend_`（PR #337レビュー対応で追加）・
  `buildPaymentLinkConfirmMessage_`（純粋関数）、`showDetailModal`での送信欄の表示制御
  （カード以外は非表示、PENDING以外は入力・送信を無効化、履行未確認でも「再送」表示に
  なること、記録不整合を強調行で表示すること）、`runSendPaymentLink_`の入力検証
  （**PR #337レビュー対応・1回目**: 前後に空白を含む・空白のみの入力を、trimして
  送信せず入力エラーとして拒否すること）・確認ダイアログキャンセル時の非送信・送信中の
  連打防止・成功時のbusy解除・`expectedSendCount`を第4引数へ渡すこと・
  `requiresManualConfirmation`/`SEND_HISTORY_CONFLICT`応答時の案内文言を検証する。
  **2回目で追加**: `expectedSentAtVersion`を第5引数へ渡すこと、`metadataInconsistent:
  true`の成功応答時に「記録更新に失敗した」旨を案内し、メール自体を自動で再送しないこと。
- 全テスト（`npm test`）は本番メール送信・本番予約・実Calendar/Sheets・実Stripe APIを
  一切使わず、既存のGASサービススタブ（`test/helpers/gas-stubs.js`）とフロントエンド用
  スタブ（`test/booking-admin-page-client.test.js`内の`createScriptRunStub`等）のみで
  完結する。

### 未検証事項・本番反映時の注意（PR-C）

- 本番の時間主導トリガー・実際のStripe Payment Link発行・実際のメール送信キューは
  リポジトリのテストからは確認できない（PR-Aと同様、運営が別途本番環境で確認すること）。
- 台帳に新規列（`stripePaymentLinkUrl`〜`paymentLinkMetadataInconsistentAt`の8列）を
  追加したため、本番反映時は「送信履歴・エラー管理」節の手順（既存デプロイのnew version
  更新・本番Bookingsシートのヘッダー行への手動追記）が必要（本PRでは実施しない）。
- **PR #337レビュー対応で解消**: 同一予約に対する同時の明示的な再送は、
  `expectedSendCount`・`expectedSentAtVersion`による競合検知（「二重送信防止と明示的な
  再送」節「PR #337レビュー対応②」「第2回レビュー対応」参照）により、画面を再取得
  していない古いタブ・端末からの再送は`SEND_HISTORY_CONFLICT`で拒否されるようになった
  （送信履歴の2回目の書き込みだけが失敗し送信回数が変化しないケースを含む）。ただし、
  画面を再取得して`expectedSendCount`・`expectedSentAtVersion`を最新化した**別々の
  明示的な再送操作**は、それぞれ独立した管理者の判断による操作として引き続き成立し
  得る（これは「連打・同時操作による重複送信の防止」ではなく、Issue #334本文が許容する
  「明示的な再送は管理者の判断による操作」の範囲内）。
- `paymentLinkMetadataInconsistentAt`が記録された場合、`stripePaymentLinkUrl`/
  `paymentLinkSentTo`/`paymentLinkSendCount`の表示が実際の送信履歴と食い違っている
  可能性がある（`paymentLinkSendCount`は実際より少ない可能性。5回目対応でURL・送信先も
  同様に古いままの可能性があることを明示した）。空でない間は通常送信・明示的な再送とも
  拒否される（3回目対応。「二重送信防止と明示的な再送」節「第3回レビュー対応」参照）。
  正確な値はRecoveryシートの`PAYMENT_LINK_METADATA_UPDATE_FAILED`記録（`errorMessage`に
  本来の送信回数を含む）と実際のメール送信履歴（利用者への到達確認等）から手動で確認した
  うえで、Booking Admin予約詳細の「送信履歴を補正」操作（`resolvePaymentLinkMetadataInconsistency`。
  「部分失敗・recoveryの確認手順」節項18参照）で3項目まとめて解消すること。この補正操作
  自体も内部で書き込みを段階分けし（URL・送信先・送信回数の3項目の補正→不整合フラグの
  クリア）、それぞれ再取得で反映を確認する（4回目対応。5回目で対象を3項目へ拡張）。
  3項目のいずれかの反映を確認できない場合は`PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`
  としてRecoveryへ記録され、不整合フラグは維持されたまま（誤って解除されない）補正を
  再試行できる。フラグのクリア後の最終確認の再取得自体が失敗した場合（5回目対応）は、
  クリア操作自体は成功していた可能性があるため「維持されている」とは断定せず、
  `RESOLVE_RESULT_UNKNOWN`としてBookingsシートを直接確認するよう案内する。
- `paymentLinkSentAt`単独更新の失敗時のフォールバック書き込み（`paymentLinkSendUnconfirmedAt`
  または`paymentLinkMetadataInconsistentAt`）自体が失敗した場合
  （Spreadsheet全体へのアクセスが完全に失われている等）は、
  Recoveryへの記録も失敗する可能性があり、その場合はLoggerのみに記録が残る
  （既存の他の失敗記録経路と同じ限界。「部分失敗・recoveryの確認手順」節参照）。
- Stripe APIによる決済リンク自動生成・Stripe Webhookによる入金確認・予約の自動確定は
  実装していない（Issue #334本文の対象外）。

## Issue #346: 予約料金の日本の祝日・振替休日判定

Issue #342（予約料金の自動計算）・PR #343時点では、`BookingPricing.gs`の
`resolveDayType_`が土曜・日曜のみを`WEEKEND_HOLIDAY`に分類しており、**月〜金の
日本の祝日・振替休日・国民の休日には平日料金が適用される**既知の制限があった
（旧README「祝日対応は別Issueで扱う」）。本Issueでこの制限を解消した。

### 実装方針

- `gas/booking/shared/JapaneseHolidays.gs`を新設し、祝日・振替休日・国民の休日の
  判定ロジックをここへ分離した（`BookingPricing.gs`の`resolveDayType_`が土曜/日曜
  以外の日について`JapaneseHolidays.classify(dateString)`へ委譲する）。
- **データソース・アルゴリズム**（`package.json`のゼロ依存方針を維持するため、npm
  パッケージは追加していない。GAS実行環境にnpm依存を持ち込む構成変更自体が本Issueの
  対象外でもある）:
  - 根拠法令は「国民の祝日に関する法律」（内閣府 https://www8.cao.go.jp/shukujitsu/gaiyou.html ）。
  - 固定日の祝日（元日・建国記念の日・天皇誕生日・昭和の日・憲法記念日・みどりの日・
    こどもの日・山の日・文化の日・勤労感謝の日）は日付を直接列挙する。
  - ハッピーマンデー対象（成人の日・海の日・敬老の日・スポーツの日）は年ごとの日付を
    列挙せず、「第n月曜」を毎年計算で求める。
  - 春分の日・秋分の日は、平均太陽年の長さとグレゴリオ暦のうるう年周期から導かれる
    天文計算の近似式（1980〜2099年の範囲で有効）で算出する（年ごとの手書きテーブル
    ではない）。国立天文台は毎年2月1日に「暦要項」で**翌年分**の確定日のみを公示する
    ため、本Issueの対応年（2020〜2099年）のほとんどは政府がまだ公式に確定日を発表
    していない将来年であり、この式が返す値は**天文計算に基づく予測**であって法的な
    確定日そのものではない。式の算出結果は、既に公示済みの年（2000年・2020年・
    2021年・2023年・2024年など）については実際の公示日と一致することを確認している
    が、未公示の将来年については想定する周期性が今後も変わらない前提での外挿である
    ため、暦要項の公示のたびに当年・翌年分を照合し、食い違いがあれば個別の例外として
    追加すること（詳細・保守手順は`JapaneseHolidays.gs`ファイル冒頭コメント参照）。
  - 2020年・2021年の海の日・スポーツの日・山の日のみ、東京オリンピック・パラリンピック
    特別措置法による一回限りの法改正のため、アルゴリズムで導出できず明示的な例外として
    個別に列挙している。
  - 振替休日（祝日が日曜のとき、その後の最初の非祝日を休日とする。2007年改正による
    祝日連続時のカスケードも含む）・国民の休日（前後を祝日に挟まれた祝日でない平日）は、
    法律の定義どおりのアルゴリズムで計算する（固定リストの手書き列挙で済ませていない）。
  - 実装の詳細・保守方法は`JapaneseHolidays.gs`ファイル冒頭のコメントに記載。
- **対応年の範囲**: 2020〜2099年（`JapaneseHolidays.MIN_SUPPORTED_YEAR`/
  `MAX_SUPPORTED_YEAR`）。下限は天皇誕生日が2/23（令和）になった年、上限は春分・秋分
  近似式が前提とするグレゴリオ暦のうるう年周期が単純に成り立つ範囲の上限（2100年は
  「100で割り切れ400で割り切れない」うるう年の例外に当たり式の前提が崩れる。2099年
  まで政府が確定日を公示済みという意味ではない）。予約は将来日付のみが対象のため、
  現行の運用では問題にならない。国立天文台の暦要項公示のたびに近似式の算出結果と
  照合し、2090年代に入ったらうるう年周期の前提が引き続き成り立つか・上限の延伸要否を
  判断すること。国会が祝日法を改正した場合（2020/2021のような一時的特例、恒久的な
  祝日の追加・変更のいずれも）は、`JapaneseHolidays.gs`内の該当箇所を追記・修正すること。
- **タイムゾーン**: 施設タイムゾーン（`Asia/Tokyo`）基準に正規化済みの`YYYY-MM-DD`
  文字列を前提とする（`BookingPricing.gs`の既存方針をそのまま踏襲。ブラウザ/GAS実行
  環境のローカルタイムゾーンには依存しない）。
- **判定不能時はfail-closed（PR #347レビュー対応で強化）**: 対応年の範囲外など、
  `JapaneseHolidays.classify`が祝日区分を確定できない場合、`resolveDayType_`は黙って
  `WEEKDAY`にフォールバックせず、`computeBookingPrice`が`valid: false`を返す。この
  検証は**曜日を問わず必ず先に**行う（`resolveDayType_`が先に土曜/日曜判定を済ませて
  しまうと、対応年範囲外の土曜・日曜だけが祝日判定の検証を経由せず「たまたま」成功し、
  同じ範囲外の月〜金だけがエラーになるという非対称なfail-closedになってしまうため）。
  `estimatePrice`（Code.gs）・`createBooking`（BookingRepository.gs）はいずれも既存の
  `priceResult.valid`チェックがそのままこのエラーを見積り・予約作成エラーとして扱う
  （過少請求を避ける。新しい分岐を追加する必要はなかった）。
- 料金表の正本は引き続き`BookingPricing.gs`1箇所のみ。フロントエンド側に祝日・料金表の
  別実装は作っていない。`estimatePrice`と`createBooking`は同じ`computeBookingPrice`→
  `resolveDayType_`→`JapaneseHolidays.classify`を呼ぶため、見積り金額と仮予約保存金額の
  曜日区分・金額は常に一致する。
- 既存予約の`priceAmount`・`priceDayType`は再計算・書き換えしていない（本Issueの対象外。
  管理者の金額修正・訂正案内フローは無変更）。

### デプロイ対象ファイル

`JapaneseHolidays.gs`は`BookingPricing.gs`のresolveDayType_内でのみ参照される依存
ファイルのため、`BookingPricing.gs`と同じくBooking Web App専用として追加した
（「GASプロジェクトへのデプロイ対象ファイル」節の表・
`test/helpers/booking-deployment-manifest.js`を同期済み）。

### テスト

- `test/japanese-holidays.test.js`: `JapaneseHolidays.classify`単体のテスト。固定日の
  祝日・ハッピーマンデー・2020/2021年特例・春分/秋分・振替休日（カスケード含む）・
  国民の休日・年またぎ・対応年範囲の境界・範囲外のfail-closedエラーを検証する。
- `test/booking-pricing.test.js`: `computeBookingPrice`が祝日・振替休日・国民の休日を
  `WEEKEND_HOLIDAY`へ正しく反映すること、判定不能時にfail-closedでエラーを返すことを
  検証する（祝日判定アルゴリズム自体の網羅的な検証は上記`japanese-holidays.test.js`側）。
  対応年範囲外は土曜・日曜であってもエラーになること（PR #347レビュー対応。曜日判定を
  祝日判定より先に済ませて非対称なfail-closedにならないことの回帰テスト）も含む。
- 既存の`test/booking-estimate-price.test.js`・`test/booking-create-booking.test.js`等は
  `JapaneseHolidays.gs`を依存ファイルとして読み込むよう更新した（ロジック自体は無変更）。

## 固定仕様（空き判定。Issue #265/#266から変更なし）

| 項目 | 値 |
| --- | --- |
| 営業時間 | 08:00〜23:00 |
| 最低利用時間 | 120分 |
| 開始時刻の刻み | 15分（`SLOT_STEP_MINUTES`） |
| 予約同士の間隔（マージン） | 15分以上 |
| タイムゾーン | Asia/Tokyo |
| 終日イベント | 空き枠を占有しない |

`createBooking`も開始時刻が`SLOT_STEP_MINUTES`（既定15分）刻みであることをサーバー側で
必須とする（例: `10:00`/`10:15`/`10:30`/`10:45`は許可、`10:07`は`START_TIME_NOT_ALIGNED`
で拒否）。getAvailabilityが提示する候補開始時刻と、実際にcreateBookingできる開始時刻を
一致させるハード制約であり、フロントのUI都合ではない（`Booking.gs`の
`validateCreateBookingInput`参照）。

## ファイル構成

### Issue #266（getAvailability。変更なし）

- `Code.gs` — Web Appエントリポイント（`doGet`/`doPost`両方をここに置く）
- `Availability.gs` — 空き判定ロジック本体（GAS組み込みサービス非依存）
- `CalendarRepository.gs` — Google Calendarアクセス（読み取り専用部分は#266のまま）
- `Config.gs` — Script Propertiesの読み出しと固定仕様のデフォルト値

### Issue #268（createBookingで追加）

- `Booking.gs` — 予約状態（STATUS）・状態遷移（canTransition）・入力検証
  （validateCreateBookingInput）・bookingId発行（generateBookingId）・TTL失効時刻計算
  （computeTtlExpiryMillis/isExpired）。GAS組み込みサービス非依存の純粋ロジック
- `RateLimiter.gs` — CacheServiceを使ったスライディングウィンドウ方式のrate limit
  （同一メール・全体・同一内容連投）
- `CalendarRepository.gs`（拡張） — `createBookingEvent`/`getEventById`/
  `deleteEventById`/`setEventStatus`を追加。PENDINGイベントにはbookingId/status/brandを
  `CalendarEvent.setTag`で保存し、タイトル・説明にはPIIを一切書き込まない
- `SpreadsheetRepository.gs` — 予約台帳（`Bookings`シート）の読み書き
- `RecoveryRepository.gs` — 部分失敗記録（`Recovery`シート）の読み書き
- `BookingRepository.gs` — `createBooking`/`confirmBooking`/`expirePendingBookings`の
  オーケストレーション本体（Lock・補償・recovery記録を含む）
- `AdminNotifier.gs` — 管理者向け最低限の通知フック（`ADMIN_NOTIFICATION_EMAIL`未設定時は
  何もしない）
- `BookingAdmin.gs` — Spreadsheetのカスタムメニュー（`onOpen`）と正式関数
  `confirmBooking(bookingId)`。**Booking Adminプロジェクト（コンテナバインド）専用**
- `BookingTriggers.gs` — 時間主導トリガー用の正式関数`expirePendingBookings()`と、
  トリガー作成の補助関数`createExpirePendingBookingsTrigger()`。
  **Booking Adminプロジェクト（コンテナバインド）専用**（`confirmBooking`と同じ
  プロジェクトに置き、LockServiceを共有させるため。3回目レビュー指摘対応）
- `Code.gs`（拡張） — `doPost`を追加（`createBooking`用。POST専用）。
  **Booking Web Appプロジェクト（スタンドアロン）専用**

### Issue #271（予約通知メール自動送信で追加）

- `BookingMailTemplates.gs` — 件名・本文生成のみの純粋関数
  （`buildPendingMail`/`buildConfirmedMail`/`buildCancelledMail`/`buildReminderMail`）。
  `MailApp`/`SpreadsheetApp`等のGAS組み込みサービスに一切依存せず、`node --test`で
  vm実行できる。ブランド差分は`Booking.getBrandLabel`のみで吸収し、SNB/mens/Studio X
  で本文生成ロジックを複製しない
- `BookingMailer.gs` — 送信制御本体。`LockService`で直列化しつつ、bookingIdで最新
  レコードを再読込→status確認→対応するSentAt確認→`BookingMailTemplates`でテンプレート
  生成→`MailApp.sendEmail`呼び出し→成功時SentAt更新/失敗時`lastMailError*`・
  `RecoveryRepository`記録、を行う。`sendPendingMailForBooking`/
  `sendConfirmedMailForBooking`/`sendCancelledMailForBooking`/
  `sendReminderMailForBooking`をそれぞれ公開し、`{ force: true }`を渡すと
  管理者の明示的な再送として、SentAt済みでも状態条件（status一致）は無視せず再送する
- `BookingReminderTriggers.gs` — 前日リマインド用の正式関数`sendNextDayReminders(now)`と、
  時間主導トリガー作成の補助関数`createNextDayReminderTrigger()`。
  **Booking Adminプロジェクト（コンテナバインド）専用**（`BookingTriggers.gs`と同じ
  理由。`confirmBooking`と同じLockServiceを共有する`BookingMailer`を使うため）
- `SpreadsheetRepository.gs`（拡張） — `Bookings`シートのヘッダーへ送信履歴・
  エラー記録用の8列を**末尾に追記**（後述「Spreadsheet変更（Issue #271）」参照）。
  翌日のCONFIRMED予約抽出用に`getConfirmedBookingsForDate(dateString)`を追加
- `Availability.gs`（拡張） — メールテンプレートの開始/終了時刻表示用に
  `formatTimeInTimezone(date, timezone)`を追加（`formatDateInTimezone`/
  `getCurrentMinutesInTimezone`と同じIntl.DateTimeFormatベースの純粋関数）
- `Config.gs`（拡張） — `getMailConfig()`（`BOOKING_MAIL_DISPLAY_NAME`/
  `BOOKING_MAIL_REPLY_TO`/`BOOKING_CONTACT_EMAIL`）と`getAccessGuideConfig()`
  （`ACCESS_GUIDE_*`。来場案内・秘密値を含む）を追加
- `BookingRepository.gs`（拡張） — `createBooking`はbooking Lock解除後・best effortで
  利用者向けPENDINGメール（`BookingMailer.sendPendingMailForBooking`）を送るようにした
  （管理者通知より先。どちらが失敗しても`createBooking`は`success:true`のまま）。
  `confirmBooking`はCalendar/Sheets確定・Lock解除後・best effortで利用者向けCONFIRMED
  メールを送るようにし、戻り値へ補助情報`mailSent`/`mailError`を追加した（メール失敗でも
  `success:false`にはしない）。既にCONFIRMED済みで`confirmedMailSentAt`が空の場合も、
  状態は変更せずメール送信だけ再試行する
- `BookingAdmin.gs`（拡張） — 「予約管理」メニューへ「予約メールを再送
  （予約ID指定・強制再送）」を追加。bookingIdとメール種別（PENDING/CONFIRMED/
  CANCELLED/REMINDER）をダイアログで入力させ、`{ force: true }`で
  `BookingMailer.send*ForBooking`を呼ぶ

### Issue #272（管理者キャンセルで追加・拡張）

- `Booking.gs`（拡張） — `ALLOWED_TRANSITIONS`へ`CONFIRMED: [STATUS.CANCELLED]`を追加し、
  CONFIRMEDを終端状態から外した
- `BookingRepository.gs`（拡張） — 正式ロジック`cancelBookingAdmin(bookingId)`を追加
  （Lock取得→Sheets最新再読込→status確認→Calendar確認・削除→Sheets CANCELLED更新→
  Lock解除→キャンセルメールbest effort。部分失敗のRecovery記録、Sheets行なし時の
  Calendar診断（`parseBookingDateFromId_`/`findBookingEventsByBookingId`利用）を含む）。
  **PRレビュー対応で追加**: `CalendarRepository.getEventById`/
  `findBookingEventsByBookingId`の呼び出し自体の例外を`try/catch`しRecoveryへ記録
  （`CANCEL_CALENDAR_LOOKUP_FAILED`/`CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED`）。
  Sheetsの`status`/`cancelledAt`/`updatedAt`更新は`SpreadsheetRepository.
  updateBookingCancellationStateAtomic`による単一書き込みへ変更（**PRレビュー2回目対応**）
- `CalendarRepository.gs`（拡張） — 診断用`findBookingEventsByBookingId(calendarId,
  bookingId, dateString, timezone)`を追加（既存関数は変更なし）
- `BookingAdmin.gs`（拡張） — グローバル関数`cancelBookingAdmin(bookingId)`、「予約管理」
  メニューへキャンセル用2項目（アクティブ行／bookingId入力）、実行直前のYES/NO確認・
  結果表示ハンドラを追加
- `SpreadsheetRepository.gs`（拡張。**PRレビュー対応で追加・2回目対応で置き換え**） —
  `updateBookingCancellationStateAtomic(bookingId, fields)`を追加。`status`/
  `cancelledAt`/`updatedAt`の3項目だけを、`HEADERS_`上で連続する`'status'`〜
  `'updatedAt'`の8列範囲に対する1回の`setValues()`で更新し、フィールドごとの
  個別書き込み（既存の`updateBookingFields`）で起こり得る部分更新を防ぐ。1回目対応の
  `updateBookingFieldsAtomic`（行全体を丸ごと書き戻す版）は、Booking Web App側が
  別GASプロジェクト・別LockServiceで更新するメール列（21列目以降）を巻き戻す
  競合リスクがあると2回目レビューで指摘され、この列範囲限定版へ置き換えた。
  列構成（`HEADERS_`）・既存関数（`updateBookingFields`含む）は変更していない
- `RecoveryRepository.gs`（拡張） — ファイル冒頭コメントへ新規failureType
  （`CANCEL_CALENDAR_EVENT_MISSING`等、および**PRレビュー対応で追加**した
  `CANCEL_CALENDAR_LOOKUP_FAILED`/`CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED`）の
  説明を追加。列構成・`recordFailure`/`listAll`自体・列追加は無し
- `BookingMailer.gs` — **変更なし**（既存の`sendCancelledMailForBooking`をそのまま利用。
  新規failureTypeのerrorMessageサニタイズにも既存の`sanitizeErrorMessage`を再利用）

### Issue #305（Booking Admin Web UI化で追加）

- `BookingAdminWeb.gs`（新規） — `doGet()`・`getAdminBookings()`・
  `getAdminBookingDetail(bookingId)`・`adminConfirmBooking(bookingId)`・
  `adminCancelBooking(bookingId)`。confirm/cancelは既存の`confirmBooking`/
  `cancelBookingAdmin`への1行の委譲のみ。**Booking Adminプロジェクト
  （コンテナバインド）専用**
- `BookingAdminPage.html`（新規） — Web UI本体（1ページ）。**Booking Adminプロジェクト
  （コンテナバインド）専用**。`.gs`ファイルではないため「GASプロジェクトへの
  デプロイ対象ファイル」表には含めない（次節の注記を参照）
- `SpreadsheetRepository.gs`（拡張） — 一覧取得用の`getAllBookings()`を追加
  （既存関数・`HEADERS_`は無変更）

### Issue #330（前日リマインドの任意時刻デバッグ・管理者宛テスト送信で追加）

- `BookingMailer.gs`（拡張） — `withBookingLock_`の事前判定を差し替え可能にし
  （第8引数`eligibilityCheckFn`。省略時は従来どおりの`defaultMailEligibilityCheck_`）、
  Lock取得〜レコード再読込の配線を`withLockedBookingRecord_`として抽出。
  `sendReminderMailForBooking`は`reminderEligibilityCheck_`（`evaluateReminderEligibility`
  を使う事前判定）を渡すようになり、**本番のREMINDER送信も実際に共通判定関数を
  経由する**（PRレビュー対応。初版では診断からのみ呼ばれていた）。
  `evaluateReminderEligibility(record, options)`・`REMINDER_SENT_AT_FIELDS`・
  `REMINDER_REASON_CODES`を新たに公開。`sendPendingMailForBooking`/
  `sendConfirmedMailForBooking`/`sendCancelledMailForBooking`・
  `ensureMailConfigComplete_`/`ensureAccessGuideComplete_`自体・PENDING/CONFIRMED/
  CANCELLEDの事前判定（`defaultMailEligibilityCheck_`）は無変更
- `BookingReminderTriggers.gs`（拡張） — 翌日日付計算を`computeNextDayDateString_
  (baseDate, timezone)`として抽出し、`sendNextDayReminders`はこれを呼ぶように
  変更（計算式・戻り値は無変更）
- `BookingReminderDiagnostics.gs`（新規） — `diagnoseReminderEligibility(bookingId,
  baseDateString)`・`previewReminderMail(bookingId, options)`・
  `sendReminderTestMail(bookingId, baseDateString)`。**Booking Adminプロジェクト
  （コンテナバインド）専用**。詳細は「Issue #330」節を参照
- `BookingAdminPage.html`（無変更） — 前日リマインド診断のUI（起動用ボタン・
  モーダル）は既存のBookingAdminPage.html自体を変更せず、`admin/booking/
  booking-admin.js`が起動時にDOM生成する（Issue #322のヘッダー/検索欄追加と
  同じ方針。「Booking Adminフロントエンドの外部化（Issue #317）」節参照）
- `admin/booking/booking-admin.js`（拡張。GitHub Pages配信） —
  「前日リマインド診断」ボタン・診断モーダルのDOM生成とイベント配線
  （`buildReminderDiagnosticsModal_`/`openReminderDiagnostics_`）、
  `diagnoseReminderEligibility`/`previewReminderMail`/`sendReminderTestMail`への
  `google.script.run`呼び出し、結果表示の純粋関数（`reminderReasonLabel`/
  `renderReminderDiagnosisResult_`/`renderReminderPreviewResult_`/
  `renderReminderSendResult_`）を追加。**PRレビュー追加対応** — 診断モーダル専用の
  リクエスト連番（`reminderDiagRequestSeq_`/`bumpReminderDiagRequestSeq_`）による
  非同期レスポンス制御と、テスト送信の二重実行防止（`sendTestInFlight`）を追加
  （詳細は「診断モーダルの非同期レスポンス制御・二重実行防止」節を参照）。
  既存のgoogle.script.run API（`getAdminBookings`等）・一覧/確定/キャンセルの
  ロジックは無変更
- `admin/booking/booking-admin.css`（拡張。GitHub Pages配信） — 診断モーダル用の
  スタイル（`#reminder-diag-*`/`.reminder-diag-*`）を追加。既存クラスは無変更

### Issue #349（前日リマインドの確定予約抽出でDate型の利用日を正規化）

- **障害の原因**: `SpreadsheetRepository.getConfirmedBookingsForDate(dateString)`が
  `record.date === dateString`という文字列の完全一致で候補を絞り込んでいたが、
  Google SheetsのSpreadsheetApp `getValues()`は日付らしい文字列を書き込んだセルを
  読み込み時に`Date`オブジェクトとして返すことがある（`BookingMailer.gs`の
  `normalizeReminderDate_`が既に対処していた既知の注意点と同じ）。このため
  `record.date`が`Date`型の行は、実際には同じ利用日でも型の違いだけで常に不一致となり、
  本番の時間主導トリガー`sendNextDayReminders`が翌日のCONFIRMED予約を0件としてしまい、
  前日リマインドメールが送信されなかった（Booking Adminの診断・管理者宛テスト送信は
  別経路で正常に動作していたため、この不具合には気付きにくかった）。
- `SpreadsheetRepository.gs`（修正） — `getConfirmedBookingsForDate`内に
  `normalizeBookingDateForComparison_(value, timezone)`を追加。`record.date`が
  `Date`値（`typeof value.getTime === 'function' && !isNaN(value.getTime())`で判定。
  無効な`Date`はこの分岐に該当せず後段で比較しても一致しないため自動的に除外される）の
  場合は`BookingConfig.getAvailabilityConfig().timezone`（既定`Asia/Tokyo`）基準の
  `'YYYY-MM-DD'`へ正規化してから`dateString`と比較し、それ以外（既存の`yyyy-MM-dd`文字列・
  空欄）はそのまま比較する。`record`自体・Sheetの実際のセル値は書き換えない（比較用の
  一時変数としてのみ使う）。ステータスを`CONFIRMED`に限定する既存条件、戻り値
  `{rowNumber, record}`・行番号・元のレコード値、`sendNextDayReminders`側の
  二重送信防止（`evaluateReminderEligibility_`のALREADY_SENT判定）・1件失敗時の
  バッチ内障害分離は無変更
- テスト（`test/booking-spreadsheet-repository.test.js`・`test/booking-reminders.test.js`）
  — `getConfirmedBookingsForDate`単体に対して、Date型の利用日を持つCONFIRMED予約2件が
  取得できること、既存の文字列型も引き続き取得できること、別日・CONFIRMED以外の
  ステータス・無効な`Date`・空欄は対象外になること、UTC日付とJST日付がずれる日付境界
  （`2026-09-25T15:30:00Z` = JST `2026-09-26T00:30:00`）でJST基準に正しく判定することを
  追加。`sendNextDayReminders`側にも、Date型の利用日を持つ予約2件に実際にメールが
  送信されるところまでの回帰テストを追加（修正前はこのテストが`processedCount=0`で
  失敗することを確認済み）
- 調査時に一時的に追加していた「全確定予約の日付・型を逐次ログ出力する」デバッグ用の
  `Logger.log`は正式反映にあたって削除した（メールアドレス・氏名・解錠情報等の
  個人情報・秘密値をログへ残さない既存方針に合わせる）
- **本番反映時の注意**: 2026-09-26利用分の確定予約2件は、本番Apps Script
  エディタ上で本修正相当の暫定コードを一時的に実行した際に既に前日リマインドを
  送信済みのため、本修正の反映・デプロイに伴って再送しないこと。また前日リマインドの
  時間主導トリガー（`createNextDayReminderTrigger`）は既存のものをそのまま使い、
  作り直す（削除して再作成する）必要はない

## GASプロジェクトへのデプロイ対象ファイル

上記の理由（カスタムメニューはコンテナバインドスクリプトでしか作成できない）により、
このディレクトリの`.gs`ファイルは、**Booking Web App**（スタンドアロン）と
**Booking Admin**（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）という
2つの独立したApps Scriptプロジェクトへ配布する。

| ファイル | Booking Web App（スタンドアロン） | Booking Admin（コンテナバインド） | このリポジトリでの配置 |
| --- | :---: | :---: | --- |
| `Code.gs` | ✓ | – | `gas/booking/public/Code.gs` |
| `Availability.gs` | ✓ | ✓ | `gas/booking/shared/Availability.gs` |
| `Config.gs` | ✓ | ✓ | `gas/booking/shared/Config.gs` |
| `CalendarRepository.gs` | ✓ | ✓ | `gas/booking/shared/CalendarRepository.gs` |
| `Booking.gs` | ✓ | ✓ | `gas/booking/shared/Booking.gs` |
| `CardPayment.gs`（Issue #341 PR-A） | ✓ | ✓ | `gas/booking/shared/CardPayment.gs` |
| `StripeGateway.gs`（Issue #341 PR-B。Stripe REST APIへのUrlFetchApp呼び出し。PR-Cで`retrievePaymentIntent`を追加。Booking Adminは`expirePendingBookings`の仮押さえ失効確認・Webhook処理でのみ使用） | ✓ | ✓ | `gas/booking/shared/StripeGateway.gs` |
| `StripeWebhookAuth.gs`（Issue #341 PR-C。中継基盤からGASへの呼び出し認証。Booking Adminのみ） | – | ✓ | `gas/booking/shared/StripeWebhookAuth.gs` |
| `StripeEventRepository.gs`（Issue #341 PR-C。Stripe Webhookイベントの冪等性台帳。Booking Adminのみ） | – | ✓ | `gas/booking/shared/StripeEventRepository.gs` |
| `JapaneseHolidays.gs`（Issue #346／Issue #344追記でBooking Adminにも追加） | ✓ | ✓ | `gas/booking/shared/JapaneseHolidays.gs` |
| `BookingPricing.gs`（Issue #342／Issue #346で祝日判定を追加／Issue #344追記でBooking Adminにも追加） | ✓ | ✓ | `gas/booking/shared/BookingPricing.gs` |
| `RateLimiter.gs` | ✓ | – | `gas/booking/public/RateLimiter.gs` |
| `SpreadsheetRepository.gs` | ✓ | ✓ | `gas/booking/shared/SpreadsheetRepository.gs` |
| `RecoveryRepository.gs` | ✓ | ✓ | `gas/booking/shared/RecoveryRepository.gs` |
| `BookingRepository.gs` | ✓ | ✓ | `gas/booking/shared/BookingRepository.gs` |
| `StripeWebhookHandler.gs`（Issue #341 PR-C。署名検証済みWebhookイベントの処理本体。confirmBooking/expirePendingBookingsとLockServiceを共有する必要があるためBooking Adminのみ） | – | ✓ | `gas/booking/shared/StripeWebhookHandler.gs` |
| `AdminNotifier.gs` | ✓ | – | `gas/booking/public/AdminNotifier.gs` |
| `BookingMailTemplates.gs`（Issue #271） | ✓ | ✓ | `gas/booking/shared/BookingMailTemplates.gs` |
| `BookingMailer.gs`（Issue #271） | ✓ | ✓ | `gas/booking/shared/BookingMailer.gs` |
| `BookingTriggers.gs` | – | ✓ | `gas/booking/admin/BookingTriggers.gs` |
| `BookingAdmin.gs` | – | ✓ | `gas/booking/admin/BookingAdmin.gs` |
| `BookingAdminWeb.gs`（Issue #305） | – | ✓ | `gas/booking/admin/BookingAdminWeb.gs` |
| `BookingWebhook.gs`（Issue #341 PR-C。Stripe Webhook中継基盤を受け付ける`doPost`。既存の管理者専用デプロイとは別デプロイで公開する） | – | ✓ | `gas/booking/admin/BookingWebhook.gs` |
| `BookingReminderTriggers.gs`（Issue #271） | – | ✓ | `gas/booking/admin/BookingReminderTriggers.gs` |
| `BookingReminderDiagnostics.gs`（Issue #330） | – | ✓ | `gas/booking/admin/BookingReminderDiagnostics.gs` |
| `FeeCalculator.gs`（Issue #344追記） | – | ✓ | `gas/booking/shared/FeeCalculator.gs` |
| `FeeSettlementRepository.gs`（Issue #344追記） | – | ✓ | `gas/booking/shared/FeeSettlementRepository.gs` |
| `BookingReschedule.gs`（Issue #344） | – | ✓ | `gas/booking/admin/BookingReschedule.gs` |
| `appsscript.json` | ✓（Web App設定を含む） | 不要（新規プロジェクト作成時の既定のままでよい。ただしWeb App自体のデプロイ設定は必要。後述） | `gas/booking/public/appsscript.json` |

**このリポジトリでの配置（`shared/`/`public/`/`admin/`）は、あくまでソース管理上の
整理であり、各GASプロジェクトへコピーする際はファイルをフラットに配置する
（「ディレクトリ構成」節参照）。**

**`BookingAdminPage.html`（Issue #305。`gas/booking/admin/BookingAdminPage.html`）は
`.gs`ファイルではないため、上表には含めない。**
Booking AdminプロジェクトのスクリプトエディタからHTMLファイルとして`BookingAdminPage.html`を
追加し、内容をそのままコピーする（`test/booking-deployment-manifest-sync.test.js`は
README.mdの上表を機械的にパースして`test/helpers/booking-deployment-manifest.js`の
`BOOKING_ADMIN_FILES`/`BOOKING_WEB_APP_FILES`（いずれも`.gs`ファイル名のみを保持する）と
突き合わせるため、`.html`ファイルを誤って上表の✓行に追加すると、このテストが機械的に
失敗する。HTMLファイルの配布は上表ではなく、この段落での案内のみとすること）。

**Issue #317でBookingAdminPage.htmlは薄いローダーになった。** 実際のCSS/JavaScript
（`admin/booking/booking-admin.css` / `admin/booking/booking-admin.js`）はGitHub Pages側で
管理し、上記の`.gs`ファイル一式・GASプロジェクトへのコピー対象には含まれない。
**通常のフロントエンド変更（表示文言・カードUI・ソートUI等）はGitHub Pages側のJS/CSS更新の
みで反映され、GAS Web App再デプロイは不要。GAS側コードまたはローダー
（`BookingAdminPage.html`）変更時のみWeb App更新が必要。**詳細は
「Booking Adminフロントエンドの外部化（Issue #317）」節を参照。

**Booking AdminプロジェクトをWeb Appとしてデプロイする場合は、コードを更新するたびに
新しいバージョンとして再デプロイすること（Issue #305）。**「予約管理」カスタムメニュー・
時間主導トリガー（`expirePendingBookings`/`sendNextDayReminders`）は常に最新の保存済み
コードで動く一方、Web Appのデプロイは「デプロイした時点のコードのスナップショット」を
固定して配信する。再デプロイを忘れると、スマホのWeb UIだけ古いバージョンの
`BookingAdminWeb.gs`/`BookingAdminPage.html`のまま動き続ける不整合が起こり得る。

**`Availability.gs`はBooking Adminプロジェクトへの配布が必須。**
`BookingRepository.gs`の`expirePendingBookings`は、候補ごとに`Booking.formatDateInTimezone`
（実体は`BookingAvailability.formatDateInTimezone`）を無条件に呼んで受付日と利用日が
一致するか判定する（Issue #270のTTL grace判定）ため、PENDINGの予約が1件でもある状態で
時間主導トリガーが実行されると`Availability.gs`を読み込んでいなければ即座に失敗する。
`BookingMailTemplates.gs`（`formatTimeInTimezone`）・`BookingReminderTriggers.gs`
（`formatDateInTimezone`）も同様に`BookingAvailability`を参照するため、`BookingAdmin.gs`
の「予約メールを再送」メニューからのPENDING/CONFIRMED/CANCELLED/REMINDER再送も同じ理由で
失敗する。**（Issue #273で発覚・修正。それまでは`confirmBooking`/`cancelBookingAdmin`
自体が直接参照するファイルだけを基準に「`Availability.gs`は`createBooking`専用で
Booking Adminには不要」と誤って判断しており、上表・本節からAvailability.gsが漏れていた。
本番Booking Adminで、既存PENDINGメールの再送を実行すると
`ReferenceError: BookingAvailability is not defined`になっていた。
`test/booking-admin-deployment.test.js`で、上表のBooking Admin列が✓の全ファイル
（`test/helpers/booking-deployment-manifest.js`のBOOKING_ADMIN_FILES）だけを読み込んで
再送・TTL失効の両方を実行し、この回帰を検証している）。**
`RateLimiter.gs`/`AdminNotifier.gs`/`Code.gs`は`createBooking`（Booking Web App専用）
でのみ使うため、引き続きBooking Adminプロジェクトには配布しない。
コピー漏れによる将来の機能追加時の事故を避けるため、上表のとおり
「`Code.gs`/`RateLimiter.gs`/`AdminNotifier.gs`以外の全ファイル」をBooking Admin
プロジェクトへ配布することを推奨する。**`cancelBookingAdmin`はBooking Admin側の
みで公開し、Booking Web Appプロジェクト（`Code.gs`）にはキャンセル用エンドポイントを
一切追加しない**（`BookingRepository.gs`自体は両プロジェクトへ配布されるが、
`cancelBookingAdmin`を呼び出すグローバル関数は`BookingAdmin.gs`側にしか無いため、
Booking Web App側からは呼び出せない）。

両プロジェクトは**同一の`.gs`ファイル**（このリポジトリの`gas/booking/`）を元にしており、
コード自体を複製・分岐させているわけではない（clasp等のデプロイ自動化は本リポジトリに
未導入のため、現状はいずれも手動コピーでのデプロイになる。ファイルを更新した際は、
変更が影響する側のプロジェクトへ再度手動でコピーし直すこと）。

## Script Properties

| プロパティ名 | 必須 | 内容 |
| --- | --- | --- |
| `CALENDAR_ID` | ○ | 空き判定・予約の正とするGoogle Calendarのカレンダーid（#266から変更なし） |
| `SPREADSHEET_ID` | ○（#268で追加） | 予約台帳・recovery記録を保存する専用Spreadsheetのid |
| `TIMEZONE` | - | 省略時 `Asia/Tokyo` |
| `OPEN_TIME` | - | 省略時 `08:00` |
| `CLOSE_TIME` | - | 省略時 `23:00` |
| `MIN_BOOKING_MINUTES` | - | 省略時 `120` |
| `BUFFER_MINUTES` | - | 省略時 `15`（予約間マージン） |
| `SLOT_STEP_MINUTES` | - | 省略時 `15`（getAvailabilityの候補生成刻み） |
| `PENDING_TTL_HOURS` | - | 省略時 `24`。PENDINGを受付から何時間保持するか |
| `PENDING_TTL_MIN_HOURS_BEFORE_START` | - | 省略時 `2`。利用開始の何時間前を超えて保持しないか |
| `PENDING_TTL_MIN_HOLD_HOURS`（Issue #270で追加） | - | 省略時 `2`。当日受付の予約について、受付から少なくとも何時間はPENDINGを保持するか（「PENDING TTLの変更内容と理由」参照） |
| `RATE_LIMIT_EMAIL_COUNT` | - | 省略時 `3` |
| `RATE_LIMIT_EMAIL_WINDOW_MINUTES` | - | 省略時 `10` |
| `RATE_LIMIT_GLOBAL_COUNT` | - | 省略時 `20` |
| `RATE_LIMIT_GLOBAL_WINDOW_MINUTES` | - | 省略時 `1` |
| `RATE_LIMIT_DUPLICATE_WINDOW_MINUTES` | - | 省略時 `2`。同一内容の連投とみなす時間窓 |
| `ADMIN_NOTIFICATION_EMAIL` | - | 省略時は管理者通知を送らない（未設定でもcreateBooking自体は失敗しない） |
| `BOOKING_ADMIN_URL`（Issue #311） | - | 管理者通知メールに載せるBooking Adminへのリンク先URL。`createBooking`（**Booking Web App側**）でのみ使うため`ADMIN_NOTIFICATION_EMAIL`と同じく**Booking Web AppプロジェクトのScript Propertiesに設定する**（Booking Adminプロジェクト側に設定しても効果がない）。値は**Booking Adminプロジェクトの**デプロイ（`/exec`）URL（別プロジェクトの値をコピーしてくる点に注意）。省略時はメール本文にBooking Adminリンクを出さず、従来どおりSpreadsheetの管理メニューへの案内のまま（未設定でもcreateBooking・管理者通知自体は失敗しない） |
| `BOOKING_MAIL_DISPLAY_NAME`（Issue #271） | - | 利用者向けメールの送信者表示名。**未設定の場合、PENDING/CONFIRMED/CANCELLED/REMINDERいずれのメールもfail-closedに送信失敗として扱う**（予約状態は維持） |
| `BOOKING_MAIL_REPLY_TO`（Issue #271） | - | 利用者向けメールのreply-toアドレス。未設定時の扱いは`BOOKING_MAIL_DISPLAY_NAME`と同じ |
| `BOOKING_CONTACT_EMAIL`（Issue #271） | - | 利用者向けメール本文に載せる問い合わせ先。未設定時の扱いは`BOOKING_MAIL_DISPLAY_NAME`と同じ |
| `ACCESS_GUIDE_ADDRESS`（Issue #271） | - | 前日リマインドに載せる施設住所。**未設定の場合、前日リマインド（REMINDER）を成功扱いにせず送信しない**（PRレビュー対応。以下`ACCESS_GUIDE_PDF_URL`を除く全項目が同じ扱い） |
| `ACCESS_GUIDE_BUILDING`（Issue #271） | - | 建物名。同上（未設定なら送信しない） |
| `ACCESS_GUIDE_ROOM`（Issue #271） | - | 部屋番号。同上 |
| `ACCESS_GUIDE_ENTRANCE`（Issue #271） | - | 建物入口から部屋までの案内。同上 |
| `ACCESS_GUIDE_KEYBOX_LOCATION`（Issue #271） | - | キーボックス設置位置。同上 |
| `ACCESS_GUIDE_ENTRY_METHOD`（Issue #271。PRレビュー対応で追加） | - | 入室方法（前日リマインドの必須内容）。同上（未設定なら送信しない） |
| `ACCESS_GUIDE_KEYBOX_NUMBER`（Issue #271。秘密値） | - | キーボックス番号。同上。実値はGitHubへコミットしない |
| `ACCESS_GUIDE_UNLOCK_CODE`（Issue #271。秘密値） | - | 解錠コード。同上 |
| `ACCESS_GUIDE_URL`（Issue #271） | - | 利用案内ページURL。同上 |
| `ACCESS_GUIDE_PDF_URL`（Issue #271） | - | キーボックス案内PDF等のURL。**これだけは任意**（「必要に応じて」の項目のため未設定でも送信は失敗にしない） |
| `STRIPE_SECRET_KEY`（Issue #341 PR-B。秘密値） | - | StripeのAPI秘密鍵。**未設定または`STRIPE_CHECKOUT_ENABLED`が`'true'`でない限り、`beginCardCheckout`は`CHECKOUT_DISABLED`/`STRIPE_NOT_CONFIGURED`を返し、Stripe APIを一切呼ばない**（fail-closed。本番はオーナーの明示承認まで意図的に未設定/無効のままにする）。実値はGitHub・台帳・ログへ一切記載しない。テスト時はStripeのテストモードのキー（`sk_test_...`）のみ使用する |
| `STRIPE_CHECKOUT_ENABLED`（Issue #341 PR-B） | - | 新しいCheckout即時決済導線のキルスイッチ。**値が厳密に`'true'`の文字列である場合のみ有効化**（他のいずれの値・未設定も無効。`BookingConfig.getStripeConfig`）。本番でこれを`true`にするのは、PR-C（Webhook自動確定）と連携可能になった後、オーナーの明示承認を得てから行う運用上の切り替えであり、**本PR-Bの実装自体はこの値を変更しない** |
| `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL`（Issue #341 PR-B） | - | Checkout Session（`success_url`/`cancel_url`）の戻り先URL。いずれか未設定の場合も`beginCardCheckout`は`STRIPE_NOT_CONFIGURED`でfail-closedに拒否する |
| `STRIPE_WEBHOOK_RELAY_SECRET`（Issue #341 PR-C。秘密値） | - | 中継基盤（Cloud Run等）とBooking Adminプロジェクトの間だけで共有するHMAC鍵。**Stripeの`STRIPE_WEBHOOK_SECRET`（中継基盤側のみに設定し、GASには一切渡さない）とは別物**。未設定の場合、`StripeWebhookAuth.verifyRelayRequest`はすべてのリクエストをfail-closedに拒否する（空文字同士を一致させない）。「Stripe Webhookエンドポイントのシークレット管理」節参照 |
| `STRIPE_WEBHOOK_RELAY_TOLERANCE_SECONDS`（Issue #341 PR-C） | - | 中継基盤が署名したタイムスタンプとGAS側の現在時刻との許容誤差（秒）。省略時 `300`（Stripe公式SDKの既定タイムスタンプ許容誤差と同じ） |

これら4つ（`STRIPE_SECRET_KEY`/`STRIPE_CHECKOUT_ENABLED`/`STRIPE_CHECKOUT_SUCCESS_URL`/
`STRIPE_CHECKOUT_CANCEL_URL`）は`beginCardCheckout`（`Code.gs`のdoPost経由）が使うため
**Booking Web AppプロジェクトのScript Propertiesに設定する**。`STRIPE_SECRET_KEY`は
`expirePendingBookings`（Booking Adminプロジェクト）の仮押さえ失効確認（`StripeGateway.
retrieveCheckoutSession`）、およびPR-Cの`StripeWebhookHandler.gs`（Checkout Session・
PaymentIntentの再取得）でも使うため、**Booking Adminプロジェクト側にも同じ値を設定する**
（Booking Web App側の値は自動的には共有されない。他のScript Propertiesと同じ注意）。
`STRIPE_CHECKOUT_ENABLED`/`STRIPE_CHECKOUT_SUCCESS_URL`/`STRIPE_CHECKOUT_CANCEL_URL`は
Booking Admin側の失効確認処理・Webhook処理では使わないため、Booking Admin側には設定不要。
**`STRIPE_WEBHOOK_RELAY_SECRET`/`STRIPE_WEBHOOK_RELAY_TOLERANCE_SECONDS`はWebhookを
受け付けるBooking Adminプロジェクト側にのみ設定する**（Booking Web App側には不要。
中継基盤側にも同じ`STRIPE_WEBHOOK_RELAY_SECRET`を環境変数として設定すること）。

TTL・レート制限の数値プロパティは、誤設定（数値以外・0以下）の場合でも例外にせず
安全な既定値へフォールバックする（fail-openでレート制限が無効化される事故を防ぐため。
`Config.gs`のコメント参照）。

一方、`OPEN_TIME`/`CLOSE_TIME`/`MIN_BOOKING_MINUTES`/`BUFFER_MINUTES`/`SLOT_STEP_MINUTES`
（Availability設定）が誤設定の場合は、フォールバックせず`createBooking`・`getAvailability`
の両方をfail-closedに`INVALID_CONFIG`で拒否する。例えば`BUFFER_MINUTES=abc`のまま
既存予約との重複判定（`isStartTimeBookable`）へ進むと、NaNを含む比較が常にfalseになり
既存予約との競合を見落とす恐れがあるため、`createBooking`は`Booking.validateCreateBookingInput`
の冒頭で`BookingAvailability.validateInput`（getAvailabilityと同じ設定検証）を通し、
Calendarへ問い合わせる前に必ず設定の妥当性を確認する。

**Script PropertiesはApps Scriptプロジェクトごとに独立している。** Booking Web Appと
Booking Adminは別プロジェクトのため、`CALENDAR_ID`・`SPREADSHEET_ID`は
**両方のプロジェクトに同じ値を設定する必要がある**（片方だけ設定・値がずれている場合、
`createBooking`/`confirmBooking`/`expirePendingBookings`のいずれかが誤ったCalendar/
Spreadsheetを参照してしまう）。

`PENDING_TTL_HOURS`/`PENDING_TTL_MIN_HOURS_BEFORE_START`/`PENDING_TTL_MIN_HOLD_HOURS`は
`expirePendingBookings`が使うため、**Booking Adminプロジェクト側に設定する**
（Booking Web App側は不要）。`RATE_LIMIT_*`/`BOOKING_ADMIN_URL`（Issue #311）は
`createBooking`のみが使うため、**Booking Web App側に設定する**（Booking Admin側は不要）。
`BOOKING_ADMIN_URL`の値自体はBooking Adminプロジェクトのデプロイ URLだが、それを
読み出すのは`createBooking`（Booking Web App側）であることに注意。

**`ADMIN_NOTIFICATION_EMAIL`はIssue #330から両方のプロジェクトで使われ得る。**
`createBooking`（Booking Web App側。管理者への新規予約通知）に加えて、Booking Admin
プロジェクト側の前日リマインド診断（`sendReminderTestMail`。「Issue #330」節参照）が
管理者宛テストメールの固定送信先として同じプロパティ名を読む。**Script Properties は
Apps Scriptプロジェクトごとに独立している**（本節冒頭）ため、診断のテスト送信を
使うにはBooking Adminプロジェクト側にも`ADMIN_NOTIFICATION_EMAIL`を別途設定する
必要がある（Booking Web App側の値は自動的には共有されない）。診断のテスト送信は
未設定・形式不正の場合は送信しない（fail-closed）。

**`BOOKING_MAIL_DISPLAY_NAME`/`BOOKING_MAIL_REPLY_TO`/`BOOKING_CONTACT_EMAIL`（Issue #271）は
両方のプロジェクトに設定する。** Booking Web App側は`createBooking`のPENDINGメールで、
Booking Admin側は`confirmBooking`のCONFIRMEDメール・`sendNextDayReminders`のREMINDERメール・
`resendBookingMailByPrompt_`の手動再送で、それぞれ利用者向けメールを送るため。
`ACCESS_GUIDE_*`（来場案内。秘密値の`ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`を
含む）は前日リマインド（`sendNextDayReminders`）でのみ使うため、**Booking Adminプロジェクト側
にのみ設定する**（Booking Web App側は不要）。秘密値はいずれもGitHubへ直書きせず、
Script Propertiesにのみ設定すること（README・PRにも実値は記載しない）。

**`TIMEZONE`はIssue #270から両方のプロジェクトで必要になった。** `expirePendingBookings`
（Booking Adminプロジェクト）が「当日受付の予約かどうか」を判定するために
`BookingConfig.getTtlConfig().timezone`を参照するようになったため（「PENDING TTLの
変更内容と理由」参照）、`TIMEZONE`を独自に設定している場合はBooking Adminプロジェクト
側にも同じ値を設定すること（既定`Asia/Tokyo`のまま変更していなければ、両プロジェクトとも
未設定でよく、対応不要）。**Issue #271のPRレビュー対応で、`BookingConfig.getMailConfig()`
にも同じ`TIMEZONE`をそのまま含めるようにした**（新しいScript Propertyは追加していない）。
利用者向けメール本文の開始/終了時刻表示はこの値を使うため、`TIMEZONE`を独自設定している
場合は両プロジェクトで値を揃えないと、メール本文の時刻表示とCalendar/`Bookings`シートの
実際の時刻がずれる可能性がある。`TIMEZONE`が不正でIntlが解釈できない場合、PENDING/
CONFIRMED/CANCELLED/REMINDERいずれのメールもfail-closedに送信失敗として扱う。

## Spreadsheet構成

1. 新規のGoogle Spreadsheetを1つ作成し、そのidを`SPREADSHEET_ID`に設定する。
2. シート（タブ）は初回アクセス時に自動作成される（`Bookings`・`Recovery`とも、
   存在しなければ`SpreadsheetRepository`/`RecoveryRepository`が作成しヘッダー行を書く）。
   手動でシートを作る必要はない。

### `Bookings`シート（予約台帳）列構成

`bookingId` / `createdAt` / `date` / `startAt` / `endAt` / `brand` / `name` / `email` /
`phone` / `people` / `purpose` / `paymentMethod` / `status` / `calendarEventId` /
`source` / `note` / `confirmedAt` / `expiredAt` / `cancelledAt` / `updatedAt` /
`customerType`（Issue #270で追加。`first_time`または`returning`） /
`pendingMailSentAt` / `confirmedMailSentAt` / `cancelMailSentAt` / `reminderSentAt` /
`accessGuideSentAt` / `lastMailErrorAt` / `lastMailErrorType` / `lastMailErrorMessage`
（いずれもIssue #271で追加） / `paymentStatus`（Issue #314で追加。Issue #334時点までは
未使用のまま`unpaid`固定。**Issue #341 PR-AでStripe決済状態を表す列へ転用した**。
下記「Issue #341」節参照） / `expiredMailSentAt`（Issue #334 PR-Aで追加） /
`stripePaymentLinkUrl` / `paymentLinkSentAt` / `paymentLinkSentTo` / `paymentLinkSendCount` /
`paymentLinkLastErrorAt` / `paymentLinkLastErrorMessage` / `paymentLinkSendUnconfirmedAt` /
`paymentLinkMetadataInconsistentAt`（いずれもIssue #334 PR-Cで追加。`paymentLinkSendUnconfirmedAt`
はPR #337レビュー対応・1回目、`paymentLinkMetadataInconsistentAt`は2回目で追加） /
`priceAmount` / `priceTier` / `priceDayType` / `priceIsMember` / `priceComputedAt` /
`priceOverrideAmount` / `priceOverrideAt` / `priceUpdateMailSentAt`（Issue #342・PR #343で追加） /
`scheduleChangeCount` / `feePaidAmount` / `feeRefundedAmount` / `feeSettlementState` /
`feeSettlementNote` / `feeSettlementUpdatedAt` / `feeRecoveryRequiredAt` / `feeRecoveryReason`
（いずれもIssue #344追記・PR #345/#352で追加。日程変更に伴う料金差額精算専用の列で、
下記「Issue #341」節が追加する決済関連列とは別の仕組み。混同しないこと） /
`paymentAttemptId` / `stripeCheckoutSessionId` / `stripePaymentIntentId` /
`paymentHoldExpiresAt` / `stripeAmount` / `stripeCurrency` / `paymentConfirmedAt` /
`lastStripeEventId` / `stripeRefundId` / `refundRequestedAt` / `refundedAt` /
`paymentLastErrorAt` / `paymentLastErrorMessage` / `paymentRecoveryRequiredAt` /
`paymentRecoveryReason` / `accessApprovedAt`（いずれもIssue #341 PR-Aで追加。詳細は
下記「Issue #341: Stripe API即時決済移行」節参照） /
`checkoutAccessToken`（PR #354レビュー対応・Issue #341 PR-Bで追加。詳細は下記
「Issue #341: Stripe API即時決済移行（PR-B）」節「PRレビュー対応」参照）

- `customerType`はIssue #270で20列目として**末尾に追記**した。既存行との互換性を保つため
  途中に挿入していない（既存行はこの列が空のまま＝利用区分不明として扱われる）。
- `pendingMailSentAt`〜`lastMailErrorMessage`の8列はIssue #271で21〜28列目として、同じ
  「末尾に追記」の方針で追加した（既存行はこれらの列が空のまま読める。`rowToRecord_`/
  `recordToRow_`/`appendBooking`/`updateBookingFields`の互換性は壊していない）。
  - `pendingMailSentAt`/`confirmedMailSentAt`/`cancelMailSentAt`/`reminderSentAt`/
    `accessGuideSentAt`はそれぞれのメール種別を送信した日時。**空の場合だけ自動送信の
    対象になる**（二重送信防止。詳細は「Issue #271: 予約通知メール自動送信」参照）。
    `reminderSentAt`と`accessGuideSentAt`は前日リマインドを1通にまとめて送るため、
    成功時に同じ時刻で同時に記録する。
  - `lastMailErrorAt`/`lastMailErrorType`/`lastMailErrorMessage`は直近のメール送信失敗
    （設定不足によるfail-closedな拒否を含む）の記録。次回同種メールの送信に成功すると
    自動的に空へ戻す。
  - `expiredMailSentAt`（Issue #334 PR-A）はカード決済PENDINGの失効通知メールを送信した
    日時。他のSentAt列と同じく空の場合だけ自動送信の対象になる（二重送信防止）。詳細は
    「Issue #334: カード決済の期限・失効通知・手動復活」参照。
  - `stripePaymentLinkUrl`/`paymentLinkSentAt`/`paymentLinkSentTo`/`paymentLinkSendCount`/
    `paymentLinkLastErrorAt`/`paymentLinkLastErrorMessage`/`paymentLinkSendUnconfirmedAt`/
    `paymentLinkMetadataInconsistentAt`（Issue #334 PR-C。末尾2列はPR #337レビュー対応
    ・1回目・2回目でそれぞれ追加）は、Booking AdminからのStripe決済リンク送信の履歴・
    エラー記録用の列。`paymentLinkLastError*`は他のメール種別が共有する`lastMailError*`
    とは別の専用列（決済リンク送信専用の送信状態をBooking Admin予約詳細で表示するため）。
    `paymentLinkSendUnconfirmedAt`は、メール送信自体は成功したが`paymentLinkSentAt`の
    記録に失敗し履行が未確定な状態を表し、空でない間は`paymentLinkSentAt`と同じく
    通常送信（forceなし）を拒否する。`paymentLinkMetadataInconsistentAt`は、
    `paymentLinkSentAt`の記録には成功したが続くURL/送信先/送信回数の記録に失敗し、
    これらの内容が古いままの可能性がある状態を表す（送信可否には影響しない表示専用）。
    詳細は「Issue #334: Booking AdminからのStripe決済リンク送信（PR-C）」参照。
- `status`は`PENDING` / `CONFIRMED` / `CANCELLED` / `EXPIRED`のいずれか。
  **このセルを直接手編集するのは正式運用ではない。** 確定は必ず`confirmBooking(bookingId)`
  （カスタムメニュー経由）を使うこと。TTL失効・キャンセルも将来的に専用関数経由のみとする。
- Issue #342・PR #343で末尾に追加した8列の用途:
  - `priceAmount`は仮予約作成時にGASが計算・保存した税込金額（円）。後の料金表変更では再計算しない。
  - `priceTier`（`GENERAL`/`MEMBER`）、`priceDayType`（`WEEKDAY`/`WEEKEND_HOLIDAY`）、
    `priceIsMember`（実際に適用した会員区分）、`priceComputedAt`（計算日時）は計算時点の条件。
  - `priceOverrideAmount`と`priceOverrideAt`はPENDING中の管理者による金額修正値・修正日時。
    自動計算値は上書きしない。実際の案内額は`Booking.getEffectivePriceAmount`で判定する。
  - `priceUpdateMailSentAt`は訂正案内メールの送信成功日時。未送信または送信後に料金を再修正した場合は
    `Booking.needsPriceUpdateNotice`により未案内と判定し、訂正案内が完了するまで予約確定を拒否する。
  - 料金関連列が空の既存予約は「未計算」として扱う。確定メール・Stripe決済リンクメールには、
    引き続き料金を表示しない（訂正案内メールは別途送信する）。

### Issue #342・PR #343 本番`Bookings`シートのヘッダー追記手順

**既存の本番シートはヘッダーが自動更新されない。** Web App・Booking Admin両方の更新前に、
本番`Bookings`シートの1行目と`SpreadsheetRepository.gs`の`HEADERS_`を照合すること。

1. 既存データをバックアップする。`paymentLinkMetadataInconsistentAt`が現在の最終ヘッダーであることを確認する。
   もし既に今回の列が一部存在する場合は、重複追加せず`HEADERS_`の順序と突き合わせて不足分のみを補う。
2. **既存列の途中へ挿入せず**、`paymentLinkMetadataInconsistentAt`の右隣から、次の8列を
   **この順番のまま**1行目へ追記する（列名は完全一致させる）。

   ```text
   priceAmount
   priceTier
   priceDayType
   priceIsMember
   priceComputedAt
   priceOverrideAmount
   priceOverrideAt
   priceUpdateMailSentAt
   ```

3. 既存行の新規8列は空欄のままにする。値を一括補完・再計算しない。
   1行目に列名の重複・欠落・順序違いがないことを、`HEADERS_`と照合して確認する。
4. その後に既存のBooking Web AppとBooking Adminの**両プロジェクト**へ対象ファイルを反映する。
   本番デプロイを更新する場合は既存デプロイID・`/exec` URLを維持する。
   新規予約の金額保存、管理画面の料金表示、金額修正→訂正案内→予約確定の動作を確認する。

この手順は本番反映時の作業指示であり、PR #343では本番のシート編集・GASデプロイを行わない。

### Issue #341 PR-A 本番`Bookings`シートのヘッダー追記手順

**既存の本番シートはヘッダーが自動更新されない。** Web App・Booking Admin両方の更新前に、
本番`Bookings`シートの1行目と`SpreadsheetRepository.gs`の`HEADERS_`を照合すること。

1. 既存データをバックアップする。実際の本番ヘッダーの最終列を確認し、この手順時点で
   `feeRecoveryReason`（Issue #344追記・PR #345/#352）までしか反映されていないか、
   `paymentLinkMetadataInconsistentAt`（Issue #334 PR-C）までしか反映されていないかを
   `HEADERS_`の順序と突き合わせて確認する。もし`scheduleChangeCount`〜`feeRecoveryReason`
   （Issue #344追記の8列）が未反映の場合は、本手順の前にそちらを先に追記すること
   （このリポジトリのREADMEには現時点でその8列専用の追記手順節が無い。`HEADERS_`の
   実際の並び順どおりに追記すれば足りる）。
2. **既存列の途中へ挿入せず**、本番シートの現在の最終列（通常は`feeRecoveryReason`）の
   右隣から、次の18列を**この順番のまま**1行目へ追記する（列名は完全一致させる。
   `stripeCheckoutRequestSnapshot`はPR #354レビュー対応・2回目、`paymentAttemptResolvedAt`は
   同・3回目で追加した列）。

   ```text
   paymentAttemptId
   paymentAttemptResolvedAt
   stripeCheckoutSessionId
   stripePaymentIntentId
   paymentHoldExpiresAt
   stripeAmount
   stripeCurrency
   stripeCheckoutRequestSnapshot
   paymentConfirmedAt
   lastStripeEventId
   stripeRefundId
   refundRequestedAt
   refundedAt
   paymentLastErrorAt
   paymentLastErrorMessage
   paymentRecoveryRequiredAt
   paymentRecoveryReason
   accessApprovedAt
   ```

3. 既存行の新規18列は空欄のままにする。値を一括補完・再計算しない。
   1行目に列名の重複・欠落・順序違いがないことを、`HEADERS_`と照合して確認する。
4. **既存の`paymentStatus`列（30列目）はこの手順では追加しない（既存列を転用するのみ）。**
   ただし本番の既存行はすべて`unpaid`のまま保存されているため、`Booking.
   normalizePaymentStatus`が読み取り時に`NOT_STARTED`へ正規化する前提を崩さないこと
   （新しい文字列表現へ本番シートの既存値を一括置換する必要はない）。
5. その後に既存のBooking Web AppとBooking Adminの**両プロジェクト**へ対象ファイル
   （`CardPayment.gs`を含む）を反映する。本番デプロイを更新する場合は既存デプロイID・
   `/exec` URLを維持する。

この手順は本番反映時の作業指示であり、PR-Aでは本番のシート編集・GAS/Cloud Runデプロイ・
Stripe本番APIキー設定のいずれも行わない（オーナーの明示的な承認を得てから、本Issueの
後続PRの反映と合わせて実施する）。

### PR #354レビュー対応（Issue #341 PR-B）本番`Bookings`シートのヘッダー追記手順

PR-Bの初版（マージ済みPR #353後）に対するレビュー対応で、bookingIdだけでのCheckout
Session取得を防ぐ決済開始トークン用に1列（`checkoutAccessToken`）を追加した。上記
「Issue #341 PR-A」の18列がすでに反映済みであることを前提に、その右隣へ追記する。

1. 本番シートの現在の最終列が`accessApprovedAt`（Issue #341 PR-Aの18列の末尾）であることを
   確認する。
2. その右隣へ、次の1列を追記する。

   ```text
   checkoutAccessToken
   ```

3. 既存行のこの列は空欄のままにする（現金・PayPay予約は将来にわたって常に空文字のまま。
   カード決済の既存行もこの列が空である限り`beginCardCheckout`は必ずFORBIDDENで拒否する
   ため、既存のカード決済PENDING予約についてはオーナーの確認後、必要であれば個別に
   トークンを払い出す運用を検討すること。この列が空のままでも、既存の失効処理・確定処理・
   旧Payment Link送信にはいずれも影響しない）。
4. 既存の両プロジェクトへ対象ファイル（`BookingRepository.gs`・`Code.gs`・
   `SpreadsheetRepository.gs`を含む）を反映する。本番デプロイを更新する場合は既存
   デプロイID・`/exec` URLを維持する。

この手順は本番反映時の作業指示であり、本PRでは本番のシート編集・GASデプロイのいずれも
行わない。

## Issue #341: Stripe API即時決済による予約自動確定・自動返金・鍵承認ゲートへ移行（PR-A）

**従来の「カード決済後に管理者が予約確定する方式」（Issue #334）から、「Stripe Checkout
即時決済→署名検証済みWebhookで自動確定」方式へ移行する。本PR-Aは調査・状態設計・
サーバー側の料金検証・台帳移行・モックテストのみを行い、Checkout Session発行・
Webhook受信・自動返金・鍵承認UI（いずれもPR-B/C/D）は実装しない。**

### 実装前調査で判明した事項

- **Issue #326／PR #328（旧TTL案）はCLOSEDのままMERGEDされていない。** 現行コードは
  Issue #334方式（`Booking.CARD_TTL_HOURS`固定72h等）のみで統一されており、#326の
  別TTL計算式（`min(createdAt+72h, startAt-24h)`等）と衝突する実装は存在しない。
- **`paymentStatus`列（Issue #314で追加）は事実上使われていない死んだ列だった。**
  書き込み箇所は`BookingRepository.createBooking`の1箇所のみで、常に`'unpaid'`固定。
  `'paid'`へ更新する箇所はコードベース全体に存在せず、Web UI（`getAdminBookingDetail`/
  `getAdminBookings`）にも一切露出していなかった。このためIssue #341本文が指示する
  「既存paymentStatus列の転用」は、実質的に空の列へ新しい意味を持たせる作業であり、
  読み取り側の互換性を壊す既存利用箇所は無い（このPRでの変更範囲・影響範囲の調査結論）。
- **Issue #344/#345（日程変更の料金差額精算）とは列・ロジックを分離した。**
  `scheduleChangeCount`/`feePaidAmount`/`feeRefundedAmount`/`feeSettlementState`等
  （Issue #344追記）は「金額は計算するが資金移動は人間が確認する」設計であり、本Issueの
  「Stripe自動決済・自動返金」とは別の仕組みとして併存させる（Issue #341本文の指示どおり、
  台帳列・精算ロジックを統合しない）。
- `gas/booking/public/appsscript.json`に`script.external_request`スコープが無いことを
  確認した。UrlFetchAppでStripe APIを呼ぶPR-Bで追加する（本PR-Aでは追加しない。
  下記「本PR-Aで意図的に行わなかったこと」参照）。

### 決済状態（`paymentStatus`）の設計

既存の`paymentStatus`列を、予約状態（`status`）とは完全に独立した決済状態の管理に転用した
（`gas/booking/shared/Booking.gs`）。

| 値 | 意味 |
| --- | --- |
| `not_started` | 決済フロー未着手。現金・PayPayの予約は常にこのまま。カード予約もCheckout Session発行前はこの状態 |
| `checkout_pending` | Stripe Checkout Sessionを発行済み・決済結果待ち（PR-B） |
| `paid` | 署名検証済みWebhookで決済成功を確認済み（PR-C） |
| `refund_pending` | 返金APIを呼び出し済み・完了確認待ち |
| `refunded` | 返金完了を確認済み（終端状態） |
| `failed` | 決済不成立（カード拒否・Session期限切れ等）。新しい決済試行IDでのみ`checkout_pending`へ戻れる |

許可された遷移は`Booking.canTransitionPaymentStatus`で判定する（`Booking.canTransition`
（予約状態用）と同じ設計方針。「制度として存在する遷移」の一覧であり、実際にどの関数が
実行するかはPR-B/C/Dが個別に絞り込む）。返金失敗はこの表では遷移として表現せず、
`refund_pending`に留まったまま専用のエラー列（`paymentLastErrorAt`/
`paymentLastErrorMessage`）と要復旧フラグ（`paymentRecoveryRequiredAt`/
`paymentRecoveryReason`）で追跡する想定（`FeeSettlementRepository`の
`FAILED_NEEDS_RECOVERY`と同じ設計思想）。

既存本番行はすべて`'unpaid'`のまま保存されているため、読み取り側は必ず
`Booking.normalizePaymentStatus(rawValue)`を経由すること。空文字・未設定・旧`'unpaid'`は
後方互換のため`not_started`へ正規化されるが、**それ以外の未知の値は`not_started`へ
丸めず`null`を返す**（PR-Aレビュー対応・項目2。「読み取れない値だから未決済だろう」と
決めつけて処理を進めると、決済処理の途中で想定外の値が書き込まれた異常を握りつぶし、
二重決済や誤った自動確定につながりかねないため）。決済処理系（後述の
`applyPaymentStateUpdate`）はこの`null`を検知したら必ず処理を停止し、要復旧として扱う。

### 決済状態の整合性保証（`applyPaymentStateUpdate`。PR-Aレビュー対応・項目1）

`paymentAttemptId`〜`paymentRecoveryReason`（15列。`updateBookingPaymentStateAtomic`）と
`paymentStatus`（30列目。`updateBookingFields`）は、既存の無関係な25列を巻き込まないため
意図的に別々のRange.setValues呼び出しへ分けている（前述の設計どおり変更しない）。
2回に分かれる書き込みが片方だけ成功する部分失敗に備え、`BookingRepository.
applyPaymentStateUpdate(bookingId, toPaymentStatus, fields, now)`という共通処理を追加した。
PR-B/PR-C/PR-Dは、決済状態・決済付随情報を更新する際に`SpreadsheetRepository.
updateBookingPaymentStateAtomic`/`updateBookingFields({paymentStatus: ...})`を直接
呼ばず、必ずこの関数を経由すること。

設計:

1. **排他制御**: `LockService.getScriptLock()`（`LOCK_TIMEOUT_MS_=10秒`。`confirmBooking`
   等と共通）。
2. **更新順序の固定**: 決済付随情報15列（1回のRange.setValues）を**先に**、
   `paymentStatus`単独を**後に**書き込む。詳細情報（Stripeの識別子・`lastStripeEventId`
   等の証跡）が先に確定してから状態のまとめ（`paymentStatus`）が最後に確定する向きに
   することで、後半の書き込みだけが失敗しても「詳細情報はあるのに状態だけ古い」という
   検出しやすい不整合にとどまる（逆向きだと、証跡を伴わないまま`paymentStatus`だけが
   決済成功を騙る状態になり、同一Webhookイベントの重複配信を`lastStripeEventId`で
   検出できないまま`paymentStatus`側の遷移チェックだけに頼る不安定な設計になる）。
3. **部分失敗時のRecovery記録**: 決済付随情報の書き込み自体が失敗した場合はこの呼び出しで
   何も変化していないため、要復旧フラグは立てず`PAYMENT_DETAIL_WRITE_FAILED`を返す
   （呼び出し元が最初からやり直せばよい）。決済付随情報の書き込みには成功したのに
   `paymentStatus`側の書き込みだけが失敗した場合は、`paymentRecoveryRequiredAt`/
   `paymentRecoveryReason`を立て、`RecoveryRepository`にも記録し、以後この関数への
   すべての呼び出しを`PAYMENT_RECOVERY_REQUIRED`として拒否する
   （`PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT`。`feeRecoveryRequiredAt`と同じ
   「要復旧フラグが立っている間は自動処理を止め、明示的な補正を待つ」設計を踏襲する。
   実際に管理者が確認・解除する手段（`resolveFeeRecovery`相当）はPR-D側で用意する）。
4. **再実行時の整合性検証**: 現在の`paymentStatus`が`Booking.normalizePaymentStatus`で
   `null`（未知の値）と判定された場合は「未決済だろう」と決めつけず即座に停止する
   （`UNKNOWN_PAYMENT_STATUS`。前述の項目2と対応）。要復旧フラグが既に立っている予約は、
   遷移の妥当性を判定するまでもなく先頭で即座に拒否する。
5. **alreadyAppliedの判定は決済状態の一致だけに頼らない**（2回目レビュー対応）。現在の
   `paymentStatus`が既に`toPaymentStatus`と一致していても、呼び出し元が`fields`で
   `IDENTITY_FIELDS_`（`paymentAttemptId`/`stripeCheckoutSessionId`/`stripePaymentIntentId`/
   `lastStripeEventId`/`stripeRefundId`）のいずれかを主張しており、かつその値が台帳の
   現在値と食い違う場合は、alreadyApplied:trueへ丸めず`PAYMENT_IDENTITY_MISMATCH`として
   要復旧フラグを立てる（別の決済試行が同じ目標状態を主張している＝二重決済等の可能性が
   あるため）。
6. **決済証跡の整合性検証**（2回目レビュー対応、3回目・4回目レビュー対応で「既に目的の
   状態」の経路の検証方法を修正）: `toPaymentStatus`ごとに、PR-B/PR-Cが実際にその遷移で
   得るはずの識別子（`REQUIRED_EVIDENCE_FOR_STATUS_`）を定義し、必須項目が揃わない場合は
   書き込み（または冪等成功扱い）を拒否する（`PAYMENT_EVIDENCE_MISSING`。「`paid`と
   主張されているのにStripeの決済識別子が一つも無い」といった証跡の欠落した成功報告を
   無条件に信用しない）。ただし**検証対象は経路によって異なる**（4回目レビュー対応で
   明確化。3回目対応時点では両方の経路が同じ関数を使っており、後述の抜け穴があった）:

   - **新規遷移**（`currentPaymentStatus !== toPaymentStatus`。これから
     `updateBookingPaymentStateAtomic`で`fields`を書き込む経路）: `findMissingPaymentEvidence_`
     が`fields`（これから書き込む値）を台帳の現在値より優先してマージした結果で判定する
     （前段の遷移で記録済みの識別子を、後段の遷移で再送させる必要はないため）。
   - **「既に目的の状態」**（`currentPaymentStatus === toPaymentStatus`。台帳を一切
     書き込まない経路）: `findMissingPaymentEvidenceAtRest_`が**台帳に現に保存されている
     値だけ**で判定する。`fields`は一切見ない。**2回目対応時点ではこの分岐がどんな証跡
     検証も経由せずalreadyApplied:trueへ到達できる抜け穴があり、3回目レビュー対応で
     検証を追加したが、その際に新規遷移用の`findMissingPaymentEvidence_`（`fields`優先の
     マージ）を誤って流用してしまっていた。この経路は`fields`を書き込まないため、
     今回の呼び出しが`fields`に正しい値（例：`lastStripeEventId`）を渡しさえすれば
     検証を通過でき、台帳自体の証跡欠落（本当に修正すべき不整合）を検出できないまま
     隠してしまう抜け穴が残っていた。4回目レビュー対応で`findMissingPaymentEvidenceAtRest_`
     （台帳の値のみを見る、別関数）に切り替えて修正した。**

   | 目標状態 | 必須の決済証跡 |
   | --- | --- |
   | `checkout_pending` | `paymentAttemptId`, `stripeCheckoutSessionId` |
   | `paid` | `stripePaymentIntentId`, `lastStripeEventId` |
   | `refund_pending` | `stripeRefundId` |
   | `refunded` | `stripeRefundId` |
   | `failed` | （追加の必須証跡なし。Session期限切れ等、PaymentIntent発行前に失敗する経路もあるため） |

7. **資金移動を伴う状態の同一性確認**（3回目レビュー対応）: `paid`/`refund_pending`/
   `refunded`（`MONETARY_IDENTITY_CONFIRMATION_FIELDS_`）へ「既に到達済み」の予約を
   再確認する場合、項目5の食い違いチェック（`paymentIdentityMatches_`。主張された値が
   食い違わないかだけを見る）に加えて、呼び出し元がその状態を裏付ける識別子
   （上表の必須証跡と同じ集合）を**実際に主張し、かつ台帳と一致すること**まで要求する
   （`paymentIdentityConfirmed_`）。識別子を一つも主張しない呼び出しは、証跡自体が
   台帳に揃っていても`PAYMENT_IDENTITY_UNCONFIRMED`で拒否する。**「食い違いが無い」ことと
   「同一の処理であると確認できる」ことは異なる**という考え方（前者は主張が無ければ
   自動的に満たされてしまうが、後者は主張そのものを要求する）。`checkout_pending`/
   `failed`は資金移動を伴わないため対象外とし、従来どおり項目5の食い違いチェックのみで
   判定する（識別子を主張しない呼び出しは状態の一致のみで`alreadyApplied:true`）。

   **PR-B/PR-Cの契約**: `paid`/`refund_pending`/`refunded`への呼び出しは、初回遷移・
   同じ状態への再送のいずれであっても、上表の必須証跡を毎回`fields`へ含めること。
   省略すると（証跡自体は台帳にあっても）`PAYMENT_IDENTITY_UNCONFIRMED`で拒否される。
   実務上はWebhookペイロードから得られる`stripePaymentIntentId`/`lastStripeEventId`/
   `stripeRefundId`をそのまま渡せば足りる。

   要復旧ゲート（`PAYMENT_RECOVERY_REQUIRED`）を立てるかどうかは検知内容ごとに分ける:
   - `PAYMENT_IDENTITY_MISMATCH`／`UNKNOWN_PAYMENT_STATUS`／`PAYMENT_STATUS_WRITE_FAILED_
     AFTER_DETAIL_COMMIT`／**「既に目的の状態」の経路で検知した`PAYMENT_EVIDENCE_
     MISSING`**は、台帳側の記録そのものが既に不整合（またはその疑いがある）状態のため、
     恒久ゲートを立てて以後の自動呼び出しをすべて拒否する。
   - **新規遷移時**に検知した`PAYMENT_EVIDENCE_MISSING`と、`PAYMENT_IDENTITY_UNCONFIRMED`
     は、この回の呼び出しを拒否した時点で台帳を一切変更しておらず、単に今回の呼び出しが
     証跡・識別子を渡し忘れただけの可能性が高いため、恒久ゲートは立てない
     （`RecoveryRepository`への監査記録のみ）。正しい証跡・識別子を添えれば同じ
     `bookingId`へ即座に再試行できる。

PR-A時点ではこの関数を呼び出す実際の決済処理（Checkout Session発行・Webhook確認・
自動返金）は存在しない。`test/booking-payment-state.test.js`で、LockService/Recovery記録・
更新順序・部分失敗・冪等な再実行（同一決済試行IDでの重複処理・異なる決済試行IDの拒否）・
未知の`paymentStatus`検知・決済証跡欠落の検知・要復旧ゲート後の自動処理停止をモックで
検証している。

### サーバー側の料金検証

`gas/booking/shared/CardPayment.gs`（新規）が、`Booking.getEffectivePriceAmount`
（Issue #342/#343の既存料金基盤）を経由してStripeへ請求すべき金額を一意に決定する
（`computeExpectedPaymentAmount`）。**この関数・および現在値との照合を行う
`verifyPaymentAmount`は、Checkout Session発行時点（PR-B）専用**である（後述の理由で
Webhook検証には使わない）。

**Checkout発行時点の金額の確定・保存とWebhook検証の照合方法（PR-Aレビュー対応・項目3）**:
Session発行**後**・Webhook到達**前**に管理者が料金を修正した場合（`priceOverrideAmount`の
更新等）、Webhook処理時点で「現在の」確定金額を再計算してStripeの決済結果と比較すると、
Stripeが実際に請求・収受した金額（Session発行時点のまま）と食い違い、**正常に完了した
決済が誤ってAMOUNT_MISMATCHになり、自動確定が止まってしまう事故**が起こり得る。これを
防ぐため、次の2段階で金額の正を分離する:

1. **PR-B（Checkout発行時点）**: `verifyPaymentAmount`でその時点の確定金額を検証した後、
   その値を`stripeAmount`/`stripeCurrency`列へ**スナップショットとして保存**する
   （`updateBookingPaymentStateAtomic`経由）。以後、料金が修正されてもこの列は変化しない。
2. **PR-C（Webhook検証時点）**: `CardPayment.verifyPaymentAgainstSnapshot(record,
   claimedAmountJpy, claimedCurrency)`で、Webhookの金額を**この列（スナップショット）**と
   突き合わせる。`verifyPaymentAmount`（現在の確定金額と照合する関数）を使わない。
   スナップショットが記録されていない（PR-Bが未実行）予約は`SNAPSHOT_NOT_AVAILABLE`で
   fail-closedに拒否する。

`test/card-payment.test.js`に、同一の「Session発行後に料金が9000円へ修正された」入力を
`verifyPaymentAmount`（誤ってAMOUNT_MISMATCHになる）と`verifyPaymentAgainstSnapshot`
（スナップショット8000円と一致するため正しくvalid:trueになる）の両方に通す対比テストを
含めた。

### Stripe Checkout SessionのTTL・仮押さえ時間について（要確認事項への回答）

Issue #341本文は仮押さえ時間の目安を30分としている。Stripe Checkout Session
（`mode=payment`）の`expires_at`は、公式ドキュメント上「Session作成時刻から30分後〜
24時間後」の範囲でのみ指定できる。**この実装作業を行ったサンドボックス環境では、
ネットワークポリシーにより`docs.stripe.com`へのアウトバウンド接続がブロックされており、
公式ドキュメントでの最終確認ができなかった。** 既知の仕様として記載しているが、
**PR-B着手前に、ネットワークアクセス可能な環境で必ず公式ドキュメントを再確認すること。**

30分「ちょうど」をそのまま仮押さえ時間として採用すると、PENDING作成からCheckout Session
発行までの処理遅延（Lock待ち・リトライ・ネットワーク往復）により、Stripeへ送る
`expires_at`が実際のSession作成時刻から30分未満になり、Stripe API側のバリデーション
エラーになるおそれがある。そのため`CardPayment.gs`では:

- 内部の仮押さえ期限（PENDING保持・空き枠ロック解除の基準）を計算する
  `computeCheckoutHoldExpiryMillis`（`CHECKOUT_HOLD_MINUTES=30`固定）と、
- Stripeへ実際に送る`expires_at`を計算する`computeStripeSessionExpiresAtSeconds`
  （`CHECKOUT_HOLD_MINUTES`に`STRIPE_SESSION_EXPIRY_BUFFER_MINUTES=5`分の安全マージンを
  上乗せ）

を別関数として分離した。さらに、PR-B側はCheckout Session作成に**成功した後**、
Stripeのレスポンスに含まれる実際の`expires_at`を内部の仮押さえ期限として**保存し直す**
実装にすること（Issue #341本文「Session expires_atをこの仮押さえ期限と一致させる」を、
2つの期限を別々に計算して後から突き合わせるのではなく、常に一致する構造で実現する）。

#### 仮押さえの解放とStripe側の失効確認（PR-Aレビュー対応・項目4）

`computeStripeSessionExpiresAtSeconds`はStripeの30分下限に対する安全マージンとして
`STRIPE_SESSION_EXPIRY_BUFFER_MINUTES=5`分を上乗せする。**この上乗せ分だけ、Stripeの
Checkout Sessionは「GASが素朴に計算した仮押さえ期限（`CHECKOUT_HOLD_MINUTES=30`分）」を
過ぎた後も、最大で数分間は決済可能なまま残り得る。** 前述のとおりPR-B側が
Stripe実際の`expires_at`を`paymentHoldExpiresAt`へ保存し直すことで、GAS側の仮押さえ期限
自体はStripe側の実際の境界と一致させられるが、それでもなお次の理由でズレは残り得る:

- 失効判定・枠解放を行うバッチ処理（既存`expirePendingBookings`と同様、一定間隔の
  時間主導トリガーになる見込み）は、`paymentHoldExpiresAt`ちょうどではなく**次回の
  トリガー実行時刻**まで遅延して枠を解放する（既存の15分間隔トリガーと同じ性質の遅延）。
- 逆に、Stripe側の実際の期限直前に利用者が決済操作を開始していた場合、GAS側が
  ほぼ同時刻に枠を解放しても、Stripe側では決済処理が完了して**Webhookが後から**届く
  ことがある。

これらはIssue #341本文が既に想定している正常系（「仮押さえ期限を過ぎてからの遅延
Webhookは、枠の空き有無で分岐する」「空いていれば自動でCONFIRMED化」「埋まっていれば
自動返金」）で吸収する設計になっているが、PR-B/PR-Cの実装が満たすべき条件として
明文化する:

1. **仮押さえ期限を過ぎて枠を解放する処理（PENDING→EXPIRED等）は、`paymentAttemptId`・
   `stripeCheckoutSessionId`・`stripePaymentIntentId`・`stripeAmount`/`stripeCurrency`
   等の決済付随情報列を消去・上書きしてはならない。** 後から届くWebhookがこの予約行を
   再び特定し、金額照合（`verifyPaymentAgainstSnapshot`）を行うために必要な情報である。
2. **Webhookハンドラは、対象予約の現在の`status`（PENDING/EXPIRED/CONFIRMED/CANCELLED）を
   「この決済は無視してよいか」の判定に使ってはならない。** 常に「現在の空き枠の有無」
   （既存の空き判定ロジック）を再確認し、空いていれば自動確定、埋まっていれば自動返金という
   Issue #341本文の分岐へ進むこと。`status===EXPIRED`だからといって決済成功のWebhookを
   黙って捨てると、Stripe側は実際に入金しているのに予約もCalendarも確保されず、返金も
   実行されない「回収不能な入金」が発生する。
3. 上記の整理から、**仮押さえ解放処理と決済状態（`paymentStatus`）の遷移は別物である**
   ことを改めて明確にする：仮押さえ解放は予約状態（`status`）側の処理であり、
   `paymentStatus`は`applyPaymentStateUpdate`が管理する別クロックのまま
   （`CHECKOUT_PENDING`のままでよい）。遅延Webhookが到達した時点で初めて
   `applyPaymentStateUpdate`により`paymentStatus`を`PAID`→（枠が埋まっていれば）
   `REFUND_PENDING`→`REFUNDED`へ進める。

### 本PR-Aで意図的に行わなかったこと（PR-B/C/Dへの引き継ぎ）

- Checkout Session生成・仮押さえ処理の実配線・フォーム遷移（PR-B）。PR-Bは決済状態・
  決済付随情報の更新に必ず`BookingRepository.applyPaymentStateUpdate`を経由し、
  Checkout発行時点の金額確定には`CardPayment.verifyPaymentAmount`を使って
  `stripeAmount`/`stripeCurrency`へスナップショット保存すること。
- `script.external_request`スコープの追加（UrlFetchAppを実際に呼ぶPR-Bで追加する。
  本PR-Aは一切のStripe API呼び出しを行わないため、未使用のスコープを先行追加しない）。
- 署名検証Webhook受信基盤（Cloud Run等の中継）・自動確定・遅延Webhookの分岐処理・
  Stripeイベントの冪等性台帳（`FeeSettlementRepository.gs`の設計パターンを踏襲した
  専用シートを想定）・Recovery連携（PR-C）。PR-CはWebhookの金額照合に
  `CardPayment.verifyPaymentAgainstSnapshot`（`verifyPaymentAmount`ではない）を使い、
  決済状態の更新には`applyPaymentStateUpdate`を経由すること。
- `paymentRecoveryRequiredAt`が立った予約を管理者が確認・解除する手段（
  `BookingReschedule.resolveFeeRecovery`相当の関数・Booking Admin UI）は用意していない。
  この列は`applyPaymentStateUpdate`が立てるのみで、解除する経路は現状存在しない
  （PR-D。実際の解除条件は、PR-B/PR-Cで決済処理の実装が固まってから設計する）。
- Booking Adminの「取消（自動返金）」ボタン・「鍵承認」ボタン・「来場案内を再送」ボタン・
  前日リマインドの鍵承認ゲート条件・メール文言更新（PR-D）。
- `expirePendingBookings`を新しい`paymentHoldExpiresAt`クロックへ対応させる変更
  （既存のカードTTL`Booking.CARD_TTL_HOURS`＝72hによる失効処理は本PR-Aでは変更しない。
  Issue #341本文の「既存予約や旧Payment Link利用中予約は旧方式で完了できる移行期間」を
  どう設計するかは、実際にCheckout Sessionフローを導入するPR-Bで判断する。仮押さえ解放
  処理を新設する際は、前述「仮押さえの解放とStripe側の失効確認」の3条件を満たすこと）。
- 本番Bookingsシートの列追加・Stripe本番APIキー設定・GAS/Cloud Run本番デプロイ・
  既存`/exec` URLの変更（いずれもオーナーの明示的な承認後、別途実施）。

### `Recovery`シート（部分失敗・不整合記録）列構成

`bookingId` / `failureType` / `occurredAt` / `calendarEventId` / `status` /
`errorMessage` / `recoveryState` / `resolvedAt`

`failureType`の主な値:

| failureType | 意味 |
| --- | --- |
| `CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE` | createBooking: Calendar作成成功→Sheets保存失敗→Calendarを補償削除できた |
| `SHEETS_FAILURE_CALENDAR_ORPHANED` | createBooking: 上記でCalendarの補償削除も失敗（**要手動対応**。Calendar側にPENDINGイベントが残っている） |
| `CALENDAR_ROLLED_BACK_AFTER_CONFIRM_SHEETS_FAILURE` | confirmBooking: CalendarをCONFIRMEDへ更新成功→Sheets更新失敗→CalendarをPENDINGへ補償できた |
| `CONFIRM_SHEETS_FAILURE_CALENDAR_ORPHANED` | confirmBooking: 上記でCalendarの補償（PENDINGへ戻す）も失敗（**要手動対応**。CalendarはCONFIRMED・SheetsはPENDINGのまま不整合） |
| `CONFIRM_CALENDAR_EVENT_MISSING` | confirmBooking時に対応するCalendarイベントが見つからない（Sheets側はPENDINGのまま） |
| `EXPIRE_CALENDAR_DELETE_FAILED` | expirePendingBookings: Calendarイベント削除が失敗（Sheets側はEXPIREDへ進めている） |
| `EXPIRE_SHEETS_UPDATE_FAILED` | expirePendingBookings: Calendarイベント削除成功→Sheets側のEXPIRED更新が失敗（**要手動対応**。CalendarはPENDINGのイベントが既に削除済み・SheetsはPENDING表示のまま不整合） |
| `ADMIN_NOTIFICATION_FAILED` | 管理者通知メール送信に失敗（予約自体は成功のまま。情報用途） |
| `MAIL_PENDING_FAILED`（Issue #271） | 利用者向けPENDINGメールの送信に失敗（設定不足によるfail-closedな拒否を含む。予約自体・`status`は変更しない。`Bookings`シートの`lastMailError*`にも同時記録） |
| `MAIL_CONFIRMED_FAILED`（Issue #271） | 利用者向けCONFIRMEDメールの送信に失敗。同上（`confirmBooking`自体の成否には影響しない） |
| `MAIL_CANCELLED_FAILED`（Issue #271） | 利用者向けCANCELLEDメールの送信に失敗。同上（#271では送信関数のみ。呼び出し配線は#272の`cancelBookingAdmin`で実装済み） |
| `CANCEL_CALENDAR_EVENT_MISSING`（Issue #272） | cancelBookingAdmin時にCalendarイベントが既に存在しなかった（SheetsはCANCELLEDへ収束させる。「Issue #272」参照） |
| `CANCEL_CALENDAR_DELETE_FAILED`（Issue #272） | cancelBookingAdmin時のCalendarイベント削除自体が失敗（Sheetsは元statusのまま進めない・**要手動対応**） |
| `CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED`（Issue #272） | Calendar削除成功→Sheets側のCANCELLED更新が失敗（**要手動対応**。同じbookingIdで再実行すればCalendar既に無い経路から収束できる） |
| `CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT`（Issue #272） | Sheets行が無いが、Calendarに対象日・bookingIdタグ一致のイベントが1件見つかった（Calendarは自動削除しない・**要手動対応**） |
| `CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND`（Issue #272） | 同上でCalendarに複数件見つかった（**要手動対応**。Calendarは自動削除しない） |
| `CANCEL_BOOKING_NOT_FOUND`（Issue #272） | Sheets行が無く、Calendarにも該当イベントが見つからない（またはbookingId形式が不正で診断自体をスキップした） |
| `CANCEL_CALENDAR_LOOKUP_FAILED`（Issue #272 PRレビュー対応） | cancelBookingAdmin時に`CalendarRepository.getEventById`自体が例外を投げた（イベントが無いのではなくCALENDAR_ID不正・Calendarアクセス障害等。Sheets/Calendarとも変更しない・**要手動対応**） |
| `CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED`（Issue #272 PRレビュー対応） | Sheets行なし診断中に`findBookingEventsByBookingId`自体が例外を投げた（診断そのものが失敗。Calendarは変更しない・**要手動対応**） |
| `MAIL_REMINDER_FAILED`（Issue #271） | 前日リマインド（来場案内含む）の送信に失敗。解錠コード等の秘密値未設定によるfail-safeな拒否もここに含む。`status`はCONFIRMEDのまま変更しない |
| `PAYMENT_LINK_MAIL_FAILED`（Issue #334 PR-C） | Booking AdminからのStripe決済リンク送信メールに失敗（設定不足によるfail-closedな拒否を含む）。予約自体・`status`（PENDING）は変更しない。`Bookings`シートの`paymentLinkLastErrorAt`/`paymentLinkLastErrorMessage`（他メール種別と共有する`lastMailError*`とは別の専用列）にも同時記録する |
| `PAYMENT_LINK_SEND_HISTORY_UPDATE_FAILED`（PR #337レビュー対応・1回目） | Booking AdminからのStripe決済リンク送信で、MailApp.sendEmail自体は成功したが、直後の`paymentLinkSentAt`（二重送信防止の要となる列）の記録に失敗した（メールが届いている可能性がある。要確認）。予約自体・`status`（PENDING）は変更しない。`Bookings`シートの`paymentLinkSendUnconfirmedAt`にも同時記録し、この値が空でない間は通常送信（forceなし）を拒否する |
| `PAYMENT_LINK_METADATA_UPDATE_FAILED`（PR #337レビュー対応・2回目） | Booking AdminからのStripe決済リンク送信で、MailApp.sendEmail・`paymentLinkSentAt`の記録には成功した（＝送信履行・二重送信防止は確定済み）が、続く`stripePaymentLinkUrl`/`paymentLinkSentTo`/`paymentLinkSendCount`の記録に失敗した。`paymentLinkSendCount`の表示が実際の送信回数より少ない可能性がある（`errorMessage`に本来の送信回数を記載）。予約自体・`status`（PENDING）は変更せず、メール自体の再送も自動実行しない。`Bookings`シートの`paymentLinkMetadataInconsistentAt`にも同時記録し、この値が空でない間は通常送信・明示的な再送とも`force`でも拒否する（3回目対応。他の送信が成功しただけでは自動的にクリアされない。解消手順は「部分失敗・recoveryの確認手順」項18参照） |
| `PAYMENT_LINK_METADATA_RESOLVED`（PR #337レビュー対応・3回目。5回目でURL・送信先も対象に） | 運用者がBooking Admin予約詳細の「送信履歴を補正」操作（`resolvePaymentLinkMetadataInconsistency`）で`stripePaymentLinkUrl`/`paymentLinkSentTo`/`paymentLinkSendCount`を確認済みの値へ補正し、`paymentLinkMetadataInconsistentAt`を解消したことを示す記録。`recoveryState: 'RESOLVED'`で即時記録される（元の`PAYMENT_LINK_METADATA_UPDATE_FAILED`のOPEN行とは別の記録で、そちらの`recoveryState`/`resolvedAt`は運用者が別途手動記録する）。`errorMessage`に補正前後の送信回数・確認済みのURL・送信先を記載する |
| `PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`（PR #337レビュー対応・4回目。5回目で対象・案内文言を拡張） | `resolvePaymentLinkMetadataInconsistency`実行時、URL・送信先・送信回数の補正、または不整合フラグのクリアのいずれかが実際に反映されたことを確認できず、補正の試行自体が完了しなかった。`paymentLinkMetadataInconsistentAt`は原則維持されており、送信（通常送信・明示的な再送）は引き続き`METADATA_INCONSISTENT`で拒否される。ただし不整合フラグのクリア操作後の最終確認の再取得自体が失敗した場合（`RESOLVE_RESULT_UNKNOWN`。5回目対応）は、クリア操作自体は成功していた可能性があり、`errorMessage`も「フラグが実際にクリアされているかどうかは不明」である旨を記載する（「維持されている」と断定しない）。それ以外の場合（`RESOLVE_FIELDS_NOT_CONFIRMED`/`RESOLVE_FLAG_CLEAR_NOT_CONFIRMED`）は`errorMessage`に、どの段階（URL・送信先・送信回数の反映／不整合フラグのクリアの反映）を確認できなかったかを文章で記載する |
| `STRIPE_CHECKOUT_SESSION_CREATE_UNKNOWN`（Issue #341 PR-B） | `beginCardCheckout`: Checkout Session作成APIの呼び出し結果が不明（タイムアウト・5xx・409・解析不能な応答・種別を確認できない4xxを含む）。**要手動対応ではない**（`paymentRecoveryRequiredAt`は立てない）。台帳には既に`paymentAttemptId`（Idempotency-Key）とリクエスト内容のスナップショットが永続化済みのため、利用者が再試行すれば同じ決済試行として安全に再開できる |
| `STRIPE_IDEMPOTENCY_CONFLICT`（PR #354レビュー対応・2回目） | `beginCardCheckout`: Checkout Session作成APIがidempotency_errorを返した。台帳に保存された決済試行のリクエスト内容（金額・通貨・successUrl等のスナップショット）が、実際に最初にStripeへ送られた内容と食い違っている可能性がある異常事態。**要手動対応**（`paymentRecoveryRequiredAt`を立てる。新しい決済試行IDも発行しない）。Stripe管理画面で該当のIdempotency-Key（`paymentAttemptId`）に対応するCheckout Sessionの有無・内容を確認し、必要な補正を行ってから復旧すること |
| `STRIPE_SESSION_STATUS_UNKNOWN`（Issue #341 PR-B） | `beginCardCheckout`（checkout_pending再開時）: 既存Checkout SessionのStripe側の状態確認（`retrieveCheckoutSession`）に失敗。同上、要手動対応ではなく利用者の再試行で解決し得る |
| `EXPIRE_STRIPE_SESSION_STATUS_UNKNOWN`（Issue #341 PR-B） | `expirePendingBookings`: checkout_pendingの仮押さえ失効確認でStripe側の状態確認に失敗、またはStripeがopen/expired/complete以外の判定不能な状態を返した。この回のトリガー実行では枠を解放せずスキップし、次回のトリガー実行で再評価する（要手動対応ではない） |
| `CHECKOUT_SESSION_ALREADY_COMPLETED`（Issue #341 PR-B） | `beginCardCheckout`（checkout_pending再開時）: Stripe Checkout Sessionが既に完了/決済済みと報告された。署名検証済みWebhookによる自動確定（PR-C）が未実装のため自動処理を停止し、**要手動対応**（`paymentRecoveryRequiredAt`を立てる）。Stripe管理画面で入金を確認し、必要であれば手動で予約を確定すること |
| `CHECKOUT_HOLD_EXPIRY_PAYMENT_MAYBE_SUCCEEDED`（Issue #341 PR-B） | `expirePendingBookings`: 仮押さえ期限を過ぎた予約の枠解放を検討したが、Stripe Checkout Sessionが決済済みと報告されたため枠を解放せず停止した。**要手動対応**。至急Stripe管理画面で入金を確認すること |
| `STALE_CHECKOUT_ATTEMPT_RESPONSE`（PR #354レビュー対応・3回目） | `beginCardCheckout`: Checkout Session作成応答（確定的な失敗、または作成成功）を受け取った時点で、台帳の現在の`paymentAttemptId`が既に別の決済試行へ進んでいた（この応答が発行された後に、何らかの経路で新しい決済試行が予約・解決済みになっていた）。この古い応答をそのまま適用すると新しい決済試行の証跡を上書きしてしまうため、**要手動対応**として停止した（`paymentRecoveryRequiredAt`を立てる。この応答は一切書き込んでいない）。Stripe管理画面で`errorMessage`記載の決済試行ID（Idempotency-Key）に対応するCheckout Sessionの有無・内容を確認し、台帳の現在の決済試行と重複や取り違えがないか調査したうえで復旧すること |

## Issue #341: Stripe API即時決済による予約自動確定・自動返金・鍵承認ゲートへ移行（PR-B）

**PR-A（決済状態の設計・サーバー側料金検証・台帳移行）を土台に、Stripe Checkout Session生成・
決済中の枠の仮押さえ・決済画面への遷移・Checkoutの中断・期限切れ処理・既存予約との互換性確保を
実装した。署名検証済みWebhookによる決済成功確認・予約自動確定・自動返金・鍵承認ゲート・Booking
Adminの新UIは対象外（PR-C/PR-D）。**

### 実装内容

- `gas/booking/shared/StripeGateway.gs`（新規） — Stripe REST API（Checkout Session作成・
  取得）へのUrlFetchApp呼び出しのみを行う薄いラッパー。金額の正当性検証・冪等性の判断・台帳
  更新は一切行わない。Stripeからの応答を`NOT_CONFIGURED`/`INVALID_REQUEST`/`NETWORK`/
  `STRIPE_ERROR`/`AMBIGUOUS`の5種類に分類し、呼び出し元（`BookingRepository.gs`）が
  「新しいSessionを発行してよいか」を判断できるようにする。
- `gas/booking/shared/BookingRepository.gs` — `beginCardCheckout(bookingId, now)`（Booking
  Web Appから呼ばれる唯一の公開入口）・`reservePaymentAttempt_`（決済試行ID＝Stripe
  Idempotency-Keyの予約・永続化）・`startNewCheckoutAttempt_`・`resumeExistingCheckout_`・
  `handleCheckoutCreateFailure_`を追加。`expirePendingBookings`にcheckout_pendingの仮押さえ
  失効分岐（`verifyCheckoutHoldSafeToExpire_`）を追加した（既存の72h TTL経路は無変更）。
- `gas/booking/shared/Booking.gs` — `PAYMENT_STATUS_TRANSITIONS_`に`NOT_STARTED→FAILED`を
  追加（下記「PR-Aとの差分」参照）。
- `gas/booking/shared/Config.gs` — `getStripeConfig()`（`STRIPE_SECRET_KEY`/
  `STRIPE_CHECKOUT_ENABLED`/`STRIPE_CHECKOUT_SUCCESS_URL`/`STRIPE_CHECKOUT_CANCEL_URL`。
  「Script Properties」節参照）。
- `gas/booking/public/Code.gs` — `doPost`に`action=startCardCheckout`を追加（既存の
  action未指定=createBookingは無変更）。`handleStartCardCheckout_`は`{bookingId}`のみを
  受け取り、`BookingRepository.beginCardCheckout`へ委譲する。
- `gas/booking/public/appsscript.json` — `script.external_request`スコープを追加
  （UrlFetchAppを実際に呼ぶのはこのPR-Bから）。
- `scripts/booking-logic.js`／`scripts/booking-app.js`／`_includes/booking_app_ja.html`／
  `_includes/booking_app_en.html` — フォーム側の配線（下記「利用者向けフォーム」参照）。

### 二重決済の防止（本PRの最重要条件）

Issue #341本文「StripeでSession生成に成功した後、GASへのSession ID保存に失敗した場合でも、
新しいSessionを無条件に発行しない」を、次の設計で満たす。

1. **Stripe呼び出しの前に、必ず決済試行ID（`paymentAttemptId`）を台帳へ永続化する**
   （`reservePaymentAttempt_`）。この`paymentAttemptId`をStripeへ送る`Idempotency-Key`
   としてそのまま使う。永続化のみの短時間Lock（`LockService.getScriptLock()`。
   `CHECKOUT_LOCK_TIMEOUT_MS_=10秒`）を使い、**低速な外部HTTP呼び出しはLockの外**で行う
   （スクリプト全体で共有される単一のミューテックスを、ネットワーク呼び出しの間保持して
   無関係な他予約の処理まで直列化する事故を避けるため）。
2. **Stripe呼び出しに成功した後の証跡コミット（`applyPaymentStateUpdate`によるCHECKOUT_
   PENDINGへの遷移）が失敗しても、`paymentAttemptId`は既に台帳にある。** 呼び出し元
   （利用者のフォーム再送信）が同じ`bookingId`へ再試行すると、`reservePaymentAttempt_`が
   既存の`paymentAttemptId`を再利用し、Stripeを**同じIdempotency-Key**で再度呼ぶ。
   Stripeは同一キー・同一パラメータの再試行に対して、最初に作成したSessionをそのまま返す
   （新しいSessionを作らない）。
3. **同一bookingIdへの並行呼び出し（二重クリック）も同じ仕組みで収束する**: 両方の呼び出しが
   `reservePaymentAttempt_`のLock内で同じ`paymentAttemptId`を得るため、両方が同じ
   Idempotency-KeyでStripeを呼び、実際に作成されるSessionは1つだけになる（GAS側で
   ネットワーク呼び出しをまたぐ長いLockを取らずに済む、Stripe推奨のパターン）。
4. **Stripe呼び出し自体がタイムアウト・5xx等で結果不明（`AMBIGUOUS`/`NETWORK`）な場合は、
   新しい決済試行IDを発行せず、監査記録のみ残して同じ`paymentAttemptId`での再試行のみを
   許可する。** Stripeが明確に4xxを返した場合（`STRIPE_ERROR`。この回のリクエストが
   処理されていないと確定できる）は`paymentStatus:failed`へ進め、次回は新しい決済試行IDを
   発行する。
5. `test/booking-card-checkout.test.js`に、Stripe Session生成成功後にGAS保存
   （`applyPaymentStateUpdate`の証跡コミット）が失敗しても再試行が同じIdempotency-Keyを
   再利用すること、二重クリックが同じキーへ収束すること、結果不明な失敗が新しいSessionを
   発行しないことのモックテストを追加した。

### PR-Aとの差分（`Booking.PAYMENT_STATUS_TRANSITIONS_`への`NOT_STARTED→FAILED`追加）

PR-Aが設計した遷移表は`NOT_STARTED→CHECKOUT_PENDING`のみを許可していた（`FAILED`は
`CHECKOUT_PENDING`からのみ到達可能）。実際にStripe呼び出しを実装したところ、Checkout
Session作成そのものがStripe側に明確に拒否された場合（不正なリクエスト等。`CHECKOUT_
PENDING`へは一度も到達していない）に、`FAILED`へ進めて次回の決済試行に新しい
`paymentAttemptId`を発行させる必要があることが判明した（`NOT_STARTED`のまま同じ
Idempotency-Keyを無条件に再利用し続けると、Stripe側の同じエラーを繰り返すだけになる）。
`REQUIRED_EVIDENCE_FOR_STATUS_[FAILED]`は変更していない（追加の必須証跡なしのまま）。

### 仮押さえと期限切れ

- `CardPayment.CHECKOUT_HOLD_MINUTES=30`・`STRIPE_SESSION_EXPIRY_BUFFER_MINUTES=5`
  （PR-Aで確定済み）をそのまま使う。`startNewCheckoutAttempt_`はCheckout Session作成に
  **成功した後**、Stripeのレスポンスに含まれる実際の`expires_at`を`paymentHoldExpiresAt`へ
  保存し直す（2つの期限を別々に計算して後から突き合わせるのではなく、常に一致する構造）。
- `expirePendingBookings`は、`paymentStatus===checkout_pending`かつ`paymentHoldExpiresAt`が
  設定されているカード予約についてのみ、旧`CARD_TTL_HOURS`（72h）ではなく
  `paymentHoldExpiresAt`を基準に判定する（**旧Payment Link方式の予約
  ―`paymentStatus`が`not_started`のまま―は引き続き旧TTLで失効する。既存互換性を維持**）。
- `paymentHoldExpiresAt`を過ぎても、Stripe側の実際のSession状態
  （`verifyCheckoutHoldSafeToExpire_`）を確認するまで枠を解放しない:
  - Stripe側が`status===open`（`STRIPE_SESSION_EXPIRY_BUFFER_MINUTES`分の安全マージンにより、
    GAS側の期限を過ぎてもまだ数分間open=決済可能な場合がある）→ この回のトリガー実行では
    スキップし、次回のトリガー実行で再評価する。
  - Stripe側が`status===expired && payment_status===unpaid`（確実に未払いで失効）→
    枠を解放し（Calendar削除→`status:EXPIRED`）、決済付随情報列（`paymentAttemptId`・
    `stripeCheckoutSessionId`等）は消去・上書きしない。`paymentStatus`を`failed`へ進める
    （Lock解放後のbest effort。枠解放自体（`status`側）とは別クロックのまま）。
  - Stripe側が`status===complete`または`payment_status===paid`（決済済みの可能性）→
    未払いと決めつけず枠を解放しない。**要手動対応**として`paymentRecoveryRequiredAt`を
    立てる（`CHECKOUT_HOLD_EXPIRY_PAYMENT_MAYBE_SUCCEEDED`）。
  - Stripe API呼び出し自体が失敗・応答が解析不能→ 未払いと決めつけず枠を解放しない（次回の
    トリガー実行で再評価。要手動対応ではない）。
- `test/booking-card-checkout.test.js`に、上記すべての分岐（open/expired-unpaid/complete/
  API失敗）・決済付随情報が消去されないこと・旧方式のカード予約と現地払い予約が
  Stripeを一切呼ばずに既存どおり失効することのモックテストを追加した。

### 利用者向けフォーム

- `scripts/booking-app.js`: `createBooking`（既存。無変更）が成功した後、カード決済の
  場合のみ追加で`action=startCardCheckout`（`{bookingId}`のみ）を呼ぶ（`attemptCardCheckout_`。
  ネットワーク障害・`success:false`はすべてnullへ丸め、rejectしない）。`checkoutUrl`が
  得られた場合のみ、既存の「決済リンクを後日送付」案内を、Checkoutへの遷移導線
  （案内文＋ボタン。`Logic.cardCheckoutRedirectNoticeLines`/`cardCheckoutButtonLabel`）へ
  差し替える。得られなかった場合（本番の既定状態を含む）は既存の案内文のままフォールバック
  する。
- 予約内容・料金は既存の完了画面（`ba-complete-summary`。createBookingのレスポンスの値。
  Issue #342）でそのまま確認できるため、Checkoutへの遷移導線もこの画面に追加した
  （別画面を新設していない）。
- **Checkoutから戻った際の成功画面では、ブラウザの戻り先だけで決済済み・予約確定と判断
  しない設計にしている。** 本PRは`success_url`/`cancel_url`（`STRIPE_CHECKOUT_SUCCESS_URL`/
  `STRIPE_CHECKOUT_CANCEL_URL`）の戻り先ページ自体は実装していない（Script Propertiesで
  設定する任意のURL。本PR-Bのスコープは「Checkoutへ遷移させる」ことまでであり、戻り先での
  表示はPR-Cが自動確定を実装した後に設計する）。遷移前の案内文（`cardCheckoutRedirectNotice
  Lines`）自体も「決済ページでの操作が完了しても、その画面だけでは予約確定とはなりません。
  当店にて内容を確認のうえ、あらためて予約確定のご連絡をいたします。」と明記し、未実装の
  自動確定を利用者に約束しない。
- PayPay・現金は`Logic.isCardPaymentMethodValue`がfalseのため`attemptCardCheckout_`自体を
  呼ばず、従来の予約受付フローを維持する（無変更）。
- `test/booking-app.test.js`・`test/booking-code-checkout.test.js`に、`checkoutUrl`が
  返った場合のボタン表示・返らなかった場合の既存フォールバック・クライアントが送った
  `amount`/`currency`が無視されることのテストを追加した。

### 本番で新しいカード決済導線を有効化しない設計（キルスイッチ）

`STRIPE_CHECKOUT_ENABLED`が厳密に`'true'`でない限り（既定＝未設定＝無効）、
`beginCardCheckout`は`CHECKOUT_DISABLED`を返しStripe APIを一切呼ばない。本PR-Bのマージ・
デプロイ自体はこの値を変更しないため、**本番では従来どおり旧Payment Link方式（Issue #334）
のみが動作し続ける**。新しいカード決済導線を有効化するのは、PR-C（署名検証済みWebhookに
よる自動確定）と連携可能になった後、オーナーの明示承認を得てからの別作業とする。

### 旧Payment Link方式・現地払いとの互換性

- カード決済の受付条件（利用開始96時間以上前のみ）・PayPay・現金の受付・管理者承認・
  失効条件はいずれも変更していない（`Booking.CARD_MIN_HOURS_BEFORE_START`等、PR-Aから
  変更なし）。
- 既存の`createBooking`（PENDING作成・Calendar/Sheets保存・仮受付メール）は無変更。
  `beginCardCheckout`は既存のPENDING行に対して追加で呼ばれる別ステップであり、
  `createBooking`自体の入出力・検証ロジックには一切手を入れていない。
- 旧Payment Link方式で受付済みの予約（`paymentStatus`が`not_started`のまま）は、
  `expirePendingBookings`の分岐（上記「仮押さえと期限切れ」）により引き続き旧TTL
  （`CARD_TTL_HOURS=72h`）・既存の失効通知メールで処理される。管理者によるStripe決済
  リンク送信（Issue #334 PR-C。`BookingAdmin.gs`/`BookingAdminWeb.gs`）も無変更のまま
  利用できる。

### 本PR-Bで意図的に行わなかったこと（PR-C/PR-Dへの引き継ぎ）

- 署名検証済みWebhook受信基盤（Cloud Run等の中継）・自動確定・遅延Webhookの分岐処理・
  Stripeイベントの冪等性台帳・Recovery連携（PR-C）。PR-Cは決済状態の更新に必ず
  `applyPaymentStateUpdate`を、金額照合に`CardPayment.verifyPaymentAgainstSnapshot`を
  使うこと（PR-A/PR-Bの契約と同じ）。
- `paymentRecoveryRequiredAt`が立った予約（`CHECKOUT_SESSION_ALREADY_COMPLETED`/
  `CHECKOUT_HOLD_EXPIRY_PAYMENT_MAYBE_SUCCEEDED`/`STRIPE_IDEMPOTENCY_CONFLICT`/
  `STALE_CHECKOUT_ATTEMPT_RESPONSE`を含む）を管理者が確認・解除する手段は未実装（PR-D）。
- Stripe返金API・「取消（自動返金）」ボタン・鍵承認ゲート・「来場案内を再送」ボタン・
  前日リマインドの鍵承認ゲート条件・メール文言更新（PR-D）。
- `success_url`/`cancel_url`の戻り先ページの実装（本PR-Bはこれらの遷移先URLをScript
  Propertiesで設定できるようにしたのみ）。
- 本番Bookingsシートの列追加・Stripe本番APIキー設定・GAS/Cloud Run本番デプロイ・
  既存`/exec` URLの変更・`STRIPE_CHECKOUT_ENABLED`の本番有効化（いずれもオーナーの
  明示的な承認後、別途実施）。

### Booking AdminプロジェクトのOAuthスコープ追加（手動対応が必要）

`expirePendingBookings`（Booking Adminプロジェクト）が仮押さえ失効確認で`StripeGateway.
retrieveCheckoutSession`（UrlFetchApp）を呼ぶようになったため、**Booking Adminプロジェクト
側にも`script.external_request`スコープの許可が必要**になる。Booking Adminはコンテナ
バインドのスクリプトで、このリポジトリには`appsscript.json`をコミットしていない
（`clasp`等のデプロイ自動化を導入していないため、マニフェストはApps Scriptエディタ上で
手動管理している。「GASプロジェクトへのデプロイ対象ファイル」節冒頭参照）。デプロイ時は
Apps Scriptエディタの「プロジェクトの設定」→「'appsscript.json' マニフェスト ファイルを
エディタで表示する」を有効化し、`oauthScopes`へ`https://www.googleapis.com/auth/
script.external_request`を追記した上で、次回の関数実行時に追加のOAuth認可を承認すること。

### PRレビュー対応（PR #354・1回目）

マージ保留のまま、オーナーから3点の指摘を受けて対応した。

#### 1. startCardCheckoutの呼び出し認証

**指摘**: `bookingId`だけでCheckout Sessionの発行・再取得ができてしまい、`bookingId`
自体（ブランド+日付+uuidの一部8桁のみで構成）は総当たりへの耐性が高くないため、第三者が
他人の予約のCheckout URLを取得できてしまう。

**対応**: カード決済の`createBooking`時にのみ、推測困難な決済開始トークン
（`checkoutAccessToken`。`Utilities.getUuid()`。bookingId生成用のuuidとは別に発行）を
新設し、Bookings台帳へ末尾の新規列として保存する（本番シートへの反映手順は上記
「PR #354レビュー対応 本番Bookingsシートのヘッダー追記手順」参照）。このトークンは
`createBooking`のレスポンスで送信した本人のブラウザにのみ一度だけ返る。

`BookingRepository.beginCardCheckout(bookingId, checkoutAccessToken, now)`は、
`tokensMatch_`（長さが一致する場合のみ全文字をXORで比較する定数時間比較）でこの一致を
必須検証し、以下をすべて満たす設計にした:

- bookingIdが存在しない場合と、トークンが一致しない場合を**区別せず同じ`FORBIDDEN`**で
  返す（区別すると「このbookingIdは実在するか」を推測できるオラクルになるため）。
- 空文字同士は絶対に一致させない（現金・PayPay予約は`checkoutAccessToken`が常に空文字の
  ため、空文字を送るだけの攻撃で「トークン不要」な予約を偽装できないようにするため）。
- 認可チェックはこの関数の先頭（他のあらゆる業務ロジック分岐より前）で行い、認可されて
  いない呼び出しには決済状態・金額等いかなる情報も一切返さない。

`test/booking-card-checkout.test.js`・`test/booking-code-checkout.test.js`に、トークン
省略・誤ったトークン・他の予約のトークン・空文字トークン（現地払いを装う）・
bookingId不在とトークン不一致が同一のエラーになることのテストを追加した。

#### 2. Stripe冪等キーとリクエスト内容の一致

**指摘**: 決済試行IDだけを先に保存し、金額・通貨・`expires_at`は呼び出しのたびに
再計算していたため、GAS保存失敗・APIタイムアウト後の再試行や、その間の料金修正によって、
同じIdempotency-Keyに対して初回と異なるリクエスト内容をStripeへ送ってしまう可能性があった
（Stripeは差異を検知するとidempotency_errorを返す。当時のエラー分類ではこれを
`STRIPE_ERROR`＝「明確な拒否」と誤判定し、実際にはまだ有効かもしれない決済試行を
`FAILED`にして新しい試行を始めてしまう恐れがあった）。

**対応**: `reservePaymentAttempt_`が決済試行ID（Idempotency-Key）を発行する**その場で**、
請求金額・通貨・`expires_at`も1回だけ計算し、`updateBookingPaymentStateAtomic`の
**同じ1回のRange.setValues呼び出し**でまとめて永続化するよう再設計した。

- 新規発行（`NOT_STARTED`/`FAILED`から）: その時点の`CardPayment.
  computeExpectedPaymentAmount`/`computeStripeSessionExpiresAtSeconds`の結果を確定・
  保存する。
- 再利用（`NOT_STARTED`のまま前回の決済試行IDが残っている場合。GAS保存失敗・APIタイムアウト
  後の再試行に相当）: **再計算せず**、保存済みの`stripeAmount`/`stripeCurrency`/
  `paymentHoldExpiresAt`をそのまま返す。その間に管理者が料金を修正していても、この
  未解決の決済試行の再試行には反映しない（Stripeへ送るリクエスト内容を常に初回と
  一致させるため。料金修正を反映した新しい決済試行は、この試行が`FAILED`等で終わって
  からのみ行われる）。
- `startNewCheckoutAttempt_`はこの関数が返した値のみを使い、独自に金額・`expires_at`を
  計算し直すことをやめた。

`test/booking-card-checkout.test.js`に、(a)予約時点で決済試行ID・金額・通貨・期限が
1回のRange.setValuesでまとめて保存されること、(b)GAS保存（証跡コミット）失敗後の再試行が
初回と完全に同一の金額・通貨・`expires_at`をStripeへ送ること、(c)APIタイムアウト後の
再試行も同様であること、(d)未解決の決済試行が残っている間に料金が修正されても再試行は
予約時点のスナップショット額を使い続けること、(e)`FAILED`確定後の新しい決済試行では
その時点の最新料金を使ってよいこと、をそれぞれテストで検証した。

#### 3. 旧Payment Link方式へのフォールバック

**指摘**: `startCardCheckout`が失敗した場合、原因を問わずすべて既存の「決済リンクを
後日送付」案内へフォールバックしていたため、Session作成結果が不明・台帳保存失敗・
決済済みの可能性がある場合でも「これから決済リンクを送ります」と案内してしまい、
実際にはStripe側で決済が進んでいる予約に対し、後日さらに別経路（旧Payment Link）でも
支払わせてしまう＝二重決済につながる恐れがあった。

**対応**: `scripts/booking-app.js`の`attemptCardCheckout_`を、`CHECKOUT_DISABLED`・
`STRIPE_NOT_CONFIGURED`という「Stripeを一切呼んでいないとGAS側で確定できるコード」
だけを`fallback`（旧方式表示可）として扱い、それ以外のすべて（`PAYMENT_STATUS_UNKNOWN`・
`PAYMENT_DETAIL_WRITE_FAILED`・`PAYMENT_POSSIBLY_COMPLETED`・`FORBIDDEN`・
`STRIPE_REQUEST_ERROR`等の既知のエラーコード、および`fetch`自体の失敗・応答解析失敗を
含む未知のケース）を`uncertain`として扱うよう再設計した。`uncertain`の場合は新設の
`ba-complete-checkout-uncertain-notice`（「決済手続きの開始状況を確認できませんでした。
…新しいお申し込みや別の決済方法でのお支払いをされないよう」の専用案内。`ba-banner--error`
スタイル）を表示し、旧「決済リンクを後日送付」案内（`ba-complete-card-payment-notice`）は
**一切表示しない**。

`test/booking-app.test.js`に、`CHECKOUT_DISABLED`/`STRIPE_NOT_CONFIGURED`（fallback）と
`PAYMENT_STATUS_UNKNOWN`/`PAYMENT_DETAIL_WRITE_FAILED`/`PAYMENT_POSSIBLY_COMPLETED`/
`FORBIDDEN`/`STRIPE_REQUEST_ERROR`（uncertain）のエラーコードごとの画面分岐、および
`fetch`自体が失敗した場合も`uncertain`扱いになることのテストを追加した。

### テスト結果（1回目レビュー対応後）

`node --test`: 総計1119件すべてpass（PR #354初版1098件＋1回目レビュー対応で追加した21件。
`test/booking-card-checkout.test.js`に項目1・2のテスト10件、`test/booking-code-checkout.
test.js`に項目1のテスト3件、`test/booking-app.test.js`に項目3のテスト8件を追加。既存
テストのうち、`beginCardCheckout`のシグネチャ変更（`checkoutAccessToken`引数の追加）に
伴う呼び出し側の更新、および`createBooking`のモック応答に`checkoutAccessToken`を追加した
更新を含む）。既存の管理者承認・Calendar・日程変更精算・Booking Admin・現地払い・旧
Payment Link方式の回帰テストもすべてpass。実際の本番決済を伴う自動テストは行っていない。

### PRレビュー対応（PR #354・2回目）

1回目対応後、オーナーから追加で2点の指摘を受けて対応した。

#### 4. Stripeへ送るリクエスト全体の固定

**指摘**: 決済試行ID・金額・通貨・`expires_at`は保存していたが、`customerEmail`・
`successUrl`・`cancelUrl`等は再試行のたびに`record.email`・Script Propertiesから再取得
していたため、GAS保存失敗・APIタイムアウト後の再試行の間に予約者のメールアドレスが
変わる、あるいは管理者が`STRIPE_CHECKOUT_SUCCESS_URL`/`STRIPE_CHECKOUT_CANCEL_URL`を
変更すると、同じIdempotency-Keyに対して初回と異なるリクエスト内容をStripeへ送って
しまう可能性が残っていた。

**対応**: `reservePaymentAttempt_`が決済試行IDを発行するその場で、Stripe Checkout
Session作成APIへ実際に送信するリクエスト内容一式（`checkoutParams`。金額・通貨・
`expires_at`・`successUrl`・`cancelUrl`・`customerEmail`・`lineItemName`）を組み立て、
JSON文字列として`stripeCheckoutRequestSnapshot`列（新設。決済試行ID・金額・通貨・期限と
**同じ1回のRange.setValues**でまとめて保存）へ確定・永続化するよう再設計した。

- 新規発行時のみ`checkoutParams`を組み立てる。未解決の決済試行の再試行（GAS保存失敗・
  APIタイムアウト後を含む）は、その間にメールアドレス・料金・Script Propertiesが
  変更されても**再計算・再取得せず**、保存済みの`checkoutParams`をJSON解析してそのまま
  再利用する。
- `startNewCheckoutAttempt_`は`reservePaymentAttempt_`が返した`checkoutParams`のみを
  `StripeGateway.createCheckoutSession`へ渡し、`record.email`・
  `stripeConfig.successUrl`/`cancelUrl`を独自に読み直さない。
- 保存済みのスナップショットを安全に復元できない場合（JSON解析失敗・必須項目欠落・
  `bookingId`/`paymentAttemptId`の不一致）は、新しいSessionを発行せず
  `PAYMENT_EVIDENCE_MISSING`として要復旧で停止する。

`test/booking-card-checkout.test.js`に、メールアドレス・`successUrl`/`cancelUrl`が
変更されても未解決の決済試行の再試行が初回と完全に同一のリクエストを送ること、送信する
form-urlencoded文字列・HTTPヘッダそのものが初回と完全に一致すること、破損した
スナップショットは要復旧として停止することのテストを追加した。

#### 5. Stripeの4xxエラー分類

**指摘**: 4xxを一律に「確定的に失敗した」と扱っていたため、`idempotency_error`・`409`・
その他の処理結果が不明なエラーでも`FAILED`へ進めて新しい決済試行IDを発行してしまう
恐れがあった。

**対応**: `StripeGateway.classifyHttpError_`を許可リスト方式に再設計した。デフォルトは
常に`AMBIGUOUS`（安全側）とし、Stripeの`error.type`が`invalid_request_error`/
`authentication_error`/`permission_error`のいずれかで、かつHTTPステータスが409を除く
4xxである場合に**限り**`STRIPE_ERROR`（確定的な失敗）に分類する。`error.type`が
`idempotency_error`の場合は新設の`IDEMPOTENCY_CONFLICT`に分類し、`BookingRepository.
handleCheckoutCreateFailure_`はこれを検知すると、`STRIPE_IDEMPOTENCY_CONFLICT`として
**要復旧で恒久的に停止**する（新しい決済試行IDも発行しない。台帳の保存内容がStripe側の
記録と食い違っている可能性がある異常事態のため、Stripe管理画面での確認を必須にする）。
`409`・`429`・`5xx`・種別を確認できない4xxはいずれも従来どおり`AMBIGUOUS`（新しい決済
試行IDを発行せず、同じキーでの再試行のみ許可）のまま変更していない。

`test/stripe-gateway.test.js`・`test/booking-card-checkout.test.js`に、
`invalid_request_error`/`authentication_error`のみが`STRIPE_ERROR`に分類されること、
`error.type`を読み取れない4xxは`STRIPE_ERROR`へ丸めず`AMBIGUOUS`になること、
`idempotency_error`は`IDEMPOTENCY_CONFLICT`に分類され`beginCardCheckout`が要復旧として
恒久的に停止し新しい決済試行IDを発行しないこと、`409`は新しい決済試行IDを発行せず
同じキーでの再試行のみ許可すること、`invalid_request_error`のみが安全な新規試行（新しい
決済試行ID）へ進めることのテストを追加した。

### テスト結果（2回目レビュー対応後）

`node --test`: 総計1130件すべてpass（1回目対応後1119件＋2回目レビュー対応で追加した
11件。`test/stripe-gateway.test.js`に項目5のテスト4件、`test/booking-card-checkout.
test.js`に項目4・5のテスト7件を追加。既存テストのうち、`stripeCheckoutRequestSnapshot`
列の追加に伴い`updateBookingPaymentStateAtomic`のatomic書き込み範囲が15列→16列に
広がったことを反映した既存テスト2件の期待値更新、および4xxのモック応答へ`error.type`を
追加した既存テスト2件の更新を含む）。既存の管理者承認・Calendar・日程変更精算・Booking
Admin・現地払い・旧Payment Link方式の回帰テストもすべてpass。実際の本番決済を伴う
自動テストは行っていない。

### PRレビュー対応（PR #354・3回目）

2回目対応後、オーナーから`reservePaymentAttempt_`のFAILED状態における並行再試行について
追加で指摘を受けて対応した。

#### 6. reservePaymentAttempt_のFAILED状態における並行再試行

**指摘**: FAILEDの予約について、決済試行IDを新しく保存した後も`paymentStatus`が
`failed`のままなので、後続のリクエストが再度新しいIDを発行できてしまう。

**原因**: `reservePaymentAttempt_`の「既存の決済試行を再利用するか、新しく発行するか」の
判定が`currentPaymentStatus===NOT_STARTED && record.paymentAttemptId`という条件だけに
限定されていた。`startNewCheckoutAttempt_`はStripe呼び出しに成功して
`applyPaymentStateUpdate`で`checkout_pending`へコミットするまでの間、`paymentStatus`を
`failed`のまま変更しない。そのため、FAILEDの予約へ複数のリクエストがほぼ同時に到達すると
（1つ目が新しい`paymentAttemptId`・スナップショットを予約してLockを解放した直後、
まだStripe呼び出し・コミットが終わっていない間に2つ目が到達する等）、
`currentPaymentStatus`は依然`failed`のままであるため2つ目も「新しい試行」の分岐へ入って
しまい、1つ目の予約を上書きして**別の`paymentAttemptId`・別のIdempotency-Keyで2回目の
Stripe呼び出し**を行ってしまう（二重のCheckout Session発行につながる）。

**対応**: `paymentStatus`とは独立した、決済試行そのものの「未解決／解決済み」を表す
新しい列`paymentAttemptResolvedAt`を追加した。

- 空＝この`paymentAttemptId`はまだ未解決（Stripe呼び出し中、または結果不明で保留中）。
  `reservePaymentAttempt_`はこの列が空である限り、`currentPaymentStatus`が
  `not_started`／`failed`のどちらであっても新しいIDを発行せず、既存の
  `paymentAttemptId`とスナップショットをそのまま再利用する
  （`hasUnresolvedPaymentAttempt_`。旧来の`NOT_STARTED`限定の条件を置き換えた）。
- 新しい決済試行を予約する（`reservePaymentAttempt_`が新しい`paymentAttemptId`を発行する）
  たびに、この列を必ず空へ戻してから予約する（前の試行の終端状態を引き継がない）。
- ある決済試行が確定的な結果（Stripeが明確に拒否＝`failed`への遷移、または
  Checkout Session発行成功＝`checkout_pending`への遷移）に到達した時点で、
  この列へ現在時刻を書き込んで解決済みにする。書き込み箇所は次の4か所：
  1. `handleCheckoutCreateFailure_`の`STRIPE_ERROR`分岐（`settlePaymentAttemptResolved_`
     による専用のLock付き書き込み。`applyPaymentStateUpdate`が`failed→failed`の
     「既に目的の状態」経路（fields書き込みをスキップする設計）に入るケース―
     `resumeExistingCheckout_`が明示的に`failed`へ進めた直後に`startNewCheckoutAttempt_`
     が呼ばれ、その新しい試行も`STRIPE_ERROR`になる場合―でも確実に書き込むため、
     `applyPaymentStateUpdate`のfields経由ではなく専用の書き込みにした）。
  2. `startNewCheckoutAttempt_`の成功コミット（`checkout_pending`への新規遷移のfieldsに
     `paymentAttemptResolvedAt`を含め、既存の1回のRange.setValuesにまとめた）。
  3. `expirePendingBookings`の仮押さえ失効による`failed`遷移（新規遷移のfieldsに含める）。
  4. `resumeExistingCheckout_`のexpired/unpaid確認による`failed`遷移（新規遷移のfieldsに
     含める）。
- **前回のFAILED試行と、新たに予約済みの未解決試行の区別**: 2.〜4.のいずれで解決済みに
  するかに関わらず、`paymentAttemptId`が変わらない限り同じ決済試行として扱われる。新しい
  決済試行を予約する時点で必ず新しい`paymentAttemptId`とともにこの列を空へリセットする
  ため、「新しく予約済みで未解決」（空）と「以前の試行が確定的に終わった後の空き状態」
  （値が入っている）が`paymentStatus`の値に関わらず区別できる。
- **以前の決済試行から遅れて届いた応答が、新しい試行の証跡を上書きしない**: 上記1.（`
  handleCheckoutCreateFailure_`）と`startNewCheckoutAttempt_`の成功コミットの直前で、
  台帳の現在の`paymentAttemptId`がこの呼び出しがStripeへ送ったIDのままかを確認する
  （`settlePaymentAttemptResolved_`のLock内チェック、または直前の`findRowByBookingId`に
  よる読み取りチェック）。一致しない場合（応答を受け取るまでの間に、別のリクエストが既に
  新しい決済試行を予約・解決していた）は、`failed`への遷移も`checkout_pending`への
  コミットも行わず、`STALE_CHECKOUT_ATTEMPT_RESPONSE`として要復旧で停止する。
  `resumeExistingCheckout_`のexpired/unpaid確認分岐についても同様に、`failed`へ進める
  直前に台帳の現在の`stripeCheckoutSessionId`・`paymentAttemptId`がこの確認の元になった
  値のままかを確認し、既に変わっていた場合は何も書き込まず、呼び出し元へ再試行を促す
  `PAYMENT_STATUS_UNKNOWN`（retryable）を返す（こちらは、もう一方のリクエストが既に
  新しい決済試行を開始・成功させている可能性が高い平常のケースであり、記録先を要復旧に
  限定せず、呼び出し元の再試行で正しい最新状態へ自然に収束させる設計にした）。
- **試行予約状態の導入と既存の整合性**: `paymentAttemptResolvedAt`は`paymentStatus`とは
  完全に独立な列とし、`Booking.PAYMENT_STATUS_TRANSITIONS_`・`REQUIRED_EVIDENCE_FOR_
  STATUS_`・Recoveryの設計（`applyPaymentStateUpdate`が唯一の決済状態更新の入口である
  という既存の原則）はいずれも変更していない。`paymentAttemptResolvedAt`の読み書きは
  すべて`BookingRepository.gs`内に閉じており（`updateBookingPaymentStateAtomic`が
  受け付ける17列の一部として追加）、決済状態の遷移そのものはこれまでどおり
  `applyPaymentStateUpdate`を経由する。

これに伴い、Bookings台帳のヘッダーに`paymentAttemptResolvedAt`列を追加した（既存の決済
状態アトミック書き込み範囲内・`paymentAttemptId`の右隣に挿入。書き込み範囲は列名から
動的に算出されるため、追加による他コードへの影響はない）。README「PR-A本番移行手順」の
列挙を17列→18列へ更新済み。**本番Bookingsシートへの列追加が別途必要**（README参照）。

`test/booking-card-checkout.test.js`に、FAILEDから2件のリクエストがほぼ同時に到達しても
同じ決済試行ID・同じリクエスト内容へ収束すること（1つ目がLockを解放しStripe呼び出し中の
間に2つ目が到達するケースを、Stripeモックの応答コールバック内で2つ目の呼び出しを入れ子に
実行することで再現）、および`resumeExistingCheckout_`で同一予約への2件のリクエストが
ほぼ同時にexpired/unpaidを確認しても片方だけが新しい決済試行を開始し、もう片方は古い
確認結果でその証跡を上書きしない（安全な再試行可能エラーで停止する）ことのテストを
2件追加した。

### テスト結果（3回目レビュー対応後）

`node --test`: 総計1132件すべてpass（2回目対応後1130件＋3回目レビュー対応で追加した
2件。`test/booking-card-checkout.test.js`に項目6のテスト2件を追加。既存テストのうち、
`paymentAttemptResolvedAt`列の追加に伴い`updateBookingPaymentStateAtomic`のatomic
書き込み範囲が16列→17列に広がったことを反映した既存テスト3件の期待値更新を含む）。
既存の管理者承認・Calendar・日程変更精算・Booking Admin・現地払い・旧Payment Link方式の
回帰テストもすべてpass。実際の本番決済を伴う自動テストは行っていない。

### PRレビュー対応（PR #354・4回目）

3回目対応後、オーナーから`handleCheckoutCreateFailure_`の確定的失敗処理におけるLock取得の
分割について追加で指摘を受けて対応した。

#### 7. handleCheckoutCreateFailure_の確定的失敗処理におけるLockの二重取得

**指摘**: 3回目の修正で、FAILEDからの並行再試行は改善されたが、確定的失敗の処理で、
`paymentAttemptResolvedAt`の更新と`paymentStatus`のFAILEDへの遷移が別々のLock取得に
なっており、両者の間に新しい決済試行が割り込める。

**原因**: 3回目レビュー対応の実装は、「対象の`paymentAttemptId`が現在の決済試行と一致する
ことの検証」「`paymentAttemptResolvedAt`の更新」を`settlePaymentAttemptResolved_`（専用の
Lock取得→解放）で行った**後に**、「`paymentStatus`のFAILEDへの遷移」を通常の
`applyPaymentStateUpdate`呼び出し（別のLock取得→解放）に任せていた。
`settlePaymentAttemptResolved_`が`paymentAttemptResolvedAt`を書き込んだ時点で、
`reservePaymentAttempt_`の再利用判定（`hasUnresolvedPaymentAttempt_`）は`paymentStatus`
を見ずこの列だけで判定するため、`paymentStatus`がまだ`failed`へ書き換わっていなくても
「新しい決済試行を予約してよい」状態になってしまう。この2つのLock取得の間（前者のLockが
解放されてから後者のLockが取得されるまで）に、他のリクエストが`reservePaymentAttempt_`で
新しい決済試行を予約・Stripe呼び出し・コミットまで完了できてしまい、その後にこの古い
呼び出しが`paymentStatus`をFAILEDへ書き込むと、新しく予約された決済試行の状態を誤って
巻き戻してしまう恐れがあった。

**対応**: `applyPaymentStateUpdate`を、Lockを取得・解放する公開版と、Lockを取得済みで
あることを前提とする内部版`applyPaymentStateUpdateLocked_`に分割した。その上で、
`settlePaymentAttemptResolved_`と`handleCheckoutCreateFailure_`側の`applyPaymentStateUpdate`
呼び出しを統合した新しい関数`failConfirmedCheckoutAttempt_`を追加し、次の3つを
**1回のLock取得の中**で一続きに実行するようにした。

1. 台帳の現在の`paymentAttemptId`が、この呼び出しがStripeへ送った`paymentAttemptId`と
   まだ一致することの検証（一致しない場合はここで台帳へ一切書き込まず`stale:true`を返す）。
2. `paymentAttemptResolvedAt`への現在時刻の書き込み。
3. 既にLockを取得済みの状態で呼べる`applyPaymentStateUpdateLocked_`を直接呼び出し、
   `paymentStatus`をFAILEDへ遷移させる（`applyPaymentStateUpdate`自身のLock取得を経由
   しないため、同じ`LockService.getScriptLock()`を二重取得しない）。

`paymentAttemptResolvedAt`の書き込み（2.）が失敗した場合は、**成功したものとみなして
FAILEDへの遷移（3.）を続行せず、直ちに`PAYMENT_DETAIL_WRITE_FAILED`を返す**（Lockは
この関数の終了時にのみ解放するため、この間に他のリクエストが割り込むことはない。書き込みが
失敗した場合も`paymentAttemptId`自体は既に予約済みのまま残るため、次回の呼び出しは同じ
決済試行で安全に再試行できる）。

なお、`startNewCheckoutAttempt_`の成功コミット（`checkout_pending`への遷移）と
`resumeExistingCheckout_`のexpired/unpaid確認による`failed`遷移（3回目レビュー対応・
項目6で対応済み）は、いずれも`paymentAttemptResolvedAt`を遷移先の状態への**同じ1回の
`applyPaymentStateUpdate`呼び出しのfields**に含めており、もともとLockの分割が発生して
いなかったため、今回の対応対象には含まれない。

`test/booking-card-checkout.test.js`に、Lock取得の回数を数える専用のLockServiceスタブ
（`createLockCycleCountingStub`）を使い、確定的失敗時のLock取得サイクルが（決済試行の
予約1回＋確定的失敗処理1回の）計2回であること（3回になっていた3回目時点の実装を検知
できることを、あえてこの回のレビュー対応前の構造へ一時的に戻して確認済み）、
`paymentAttemptResolvedAt`の保存直後に別リクエストが到達しても同じLockを保持し続けて
いるため新しい決済試行を予約できないこと、`paymentAttemptResolvedAt`の書き込みに失敗した
場合はFAILEDへの遷移を無条件に継続しない（かつ同じ決済試行IDのまま安全に再試行できる）
ことのテストを3件追加した。3回目レビュー対応で追加した「FAILEDからの2件の並行再試行は
同一の決済試行へ収束する」テストは無変更のまま引き続きpassすることを確認した。

### テスト結果（4回目レビュー対応後）

`node --test`: **総計1135件すべてpass**（3回目対応後1132件＋今回のレビュー対応で追加した
3件）。既存の管理者承認・Calendar・日程変更精算・Booking Admin・現地払い・旧Payment Link
方式の回帰テスト、および3回目レビュー対応で追加したCheckout成功・期限切れ・Recovery関連の
並行再試行テストもすべてpass。実際の本番決済を伴う自動テストは行っていない。

## Issue #341: Stripe API即時決済による予約自動確定・自動返金・鍵承認ゲートへ移行（PR-C）

**PR-A（決済状態の設計・料金検証・台帳移行）・PR-B（Checkout Session発行・仮押さえ）を
土台に、署名検証済みWebhook受信基盤・イベントの冪等性台帳・決済成功後の予約自動確定・
遅延Webhookの分岐処理を実装した。管理者の取消（自動返金）・鍵承認ゲート・来場案内再送
ボタン・メール文言更新はPR-Dの対象。本番のCloud Runサービス・Stripe Webhook Endpoint・
GASデプロイは一切作成・更新していない。**

### 受信基盤の構成（なぜCloud Run中継が必要か）

GAS Web Appの`doPost(e)`は、`e.postData.contents`（本文）は読めるが**リクエストヘッダーを
取得できない**。Stripeの署名検証（`Stripe-Signature`ヘッダー）はGAS単体では不可能なため
（Issue #341本文の既知の制約）、Stripeの署名検証だけを行う軽量な中継（`cloud-run/
stripe-webhook-relay/`。Node.js製）を新設した。

```
Stripe ──(Stripe-Signature付きWebhook)──▶ Cloud Run中継
                                            │ stripe.webhooks.constructEvent()で署名検証
                                            │ 失敗（不正・欠落・許容時刻外）→ 転送せず拒否
                                            ▼
                                  HMAC署名付きJSONをPOST
                                            ▼
                          Booking Adminプロジェクトの doPost（新デプロイ）
                                            │ StripeWebhookAuth.verifyRelayRequestで認証
                                            ▼
                                 StripeWebhookHandler.processEvent
                                            │ StripeEventRepositoryで冪等性確保
                                            │ BookingRepository.applyPaymentStateUpdate/confirmBooking
                                            ▼
                              Bookings / Calendar / Recovery / 確認メール
```

中継自体はStripeの署名検証**専用**であり、予約・決済の業務ロジックを一切持たない
（薄い中継に徹する。StripeGateway.gsと対称的な役割）。実際のイベント処理・冪等性判定・
自動確定は既存のGAS実装（BookingRepository.gs等）に一元化し、中継側に業務ロジックを
複製しない。

### 中継→GASの認証（「署名検証済みを理由に無認証で呼べる」設計にしない）

Issue #341本文は「Stripeの署名検証を済ませたことだけを理由に、GASの公開エンドポイントを
無認証で呼べる設計にしない」ことを明示的に要求している。これを満たすため:

1. 中継基盤とBooking Adminプロジェクトの間だけで共有する秘密鍵
   （`STRIPE_WEBHOOK_RELAY_SECRET`。Stripeの`STRIPE_WEBHOOK_SECRET`とは別物）を用意する。
2. 中継基盤は、Stripeの署名検証に成功した**生の本文（rawBody）そのもの**に対して、
   `HMAC-SHA256(secret, timestamp + '.' + rawBody)`を計算し、次の形のJSONをGASへPOSTする。
   ```json
   { "timestamp": 1893456000, "signature": "<16進文字列>", "body": "<Stripeの生イベント本文>" }
   ```
   署名・タイムスタンプを**ヘッダーではなく本文に含める**のは、GASの`doPost`がヘッダーを
   読めない制約に合わせるため（`gas/booking/shared/StripeWebhookAuth.gs`冒頭コメント参照）。
3. GAS側（`StripeWebhookAuth.verifyRelayRequest`）は同じHMACを`Utilities.
   computeHmacSha256Signature`で再計算し、定数時間比較で一致を確認する。あわせて
   タイムスタンプがGAS側の現在時刻から`STRIPE_WEBHOOK_RELAY_TOLERANCE_SECONDS`
   （既定300秒）以内であることも確認する（キャプチャ済みリクエストの無期限な再送への
   多層防御）。
4. **イベントID・本文は中継の途中で差し替えられない。** GASはeventId/eventTypeを
   中継が別途主張するフィールドとしては受け取らず、必ず**HMACで整合性が保証された
   rawBodyそのものをJSON.parseして**取り出す（`StripeWebhookHandler.processEvent`）。
   本文とは別の「主張フィールド」を一切作らないことで、本文とID/種別が食い違う余地を
   構造的に無くしている。
5. 認証に失敗した場合、GASはStripe側・中継側の実装詳細を一切外部へ返さず、一律
   `FORBIDDEN`とする（失敗理由の詳細はLoggerにのみ記録し、存在確認のオラクルにしない）。

**APIキー・Webhook署名シークレット・中継用シークレットは、いずれもリポジトリ・ログへ
記載しない。** `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_RELAY_SECRET`はいずれもBooking Admin
プロジェクトのScript Propertiesにのみ設定し、`STRIPE_WEBHOOK_SECRET`（Stripeの署名検証鍵）
はCloud Runサービスの環境変数（Secret Manager等）にのみ設定し、GASへは一切渡さない。

### Stripe Webhookエンドポイントのシークレット管理・ローテーション手順

| シークレット | 設定場所 | ローテーション手順 |
| --- | --- | --- |
| `STRIPE_WEBHOOK_SECRET`（Stripeの署名検証鍵） | Cloud Runサービスの環境変数のみ（GASには一切渡さない） | Stripe Dashboardの当該Webhook Endpointで新しい署名シークレットを発行 → Cloud Runサービスの環境変数を更新・再デプロイ → 旧シークレットをStripe Dashboardで無効化する（Stripeは移行期間中、新旧いずれの署名でも検証可能な猶予を提供する。詳細はStripe公式ドキュメントで最新の手順を確認すること） |
| `STRIPE_WEBHOOK_RELAY_SECRET`（中継⇄GAS共有鍵） | Cloud Runサービスの環境変数 **と** Booking AdminプロジェクトのScript Properties（両方に同じ値） | 新しい値を生成 → まずBooking Admin側のScript Propertiesを新しい値へ更新 → 続けてCloud Run側の環境変数を同じ新しい値へ更新・再デプロイする（**この順序を守ること**。逆順にすると、Cloud Run更新後・GAS更新前の間に送られたWebhookがすべて認証失敗になり、Stripeの再送に頼ることになる。この順序でも新シークレット反映直後の一瞬は同様の再送依存が生じ得るが、窓を最小化できる） |
| `STRIPE_SECRET_KEY`（StripeのAPI秘密鍵） | Booking Web AppプロジェクトとBooking Adminプロジェクトの両方のScript Properties（PR-B「Script Properties」節参照） | Stripe Dashboardで新しいキーを発行 → 両プロジェクトのScript Propertiesを更新 → 旧キーをStripe Dashboardで失効させる |

いずれのシークレットも、値そのものをPR・Issue・コミットメッセージ・Loggerへ記載しない
（本READMEにもキー名のみを記載し、実値は記載しない）。

### Stripeイベントの取り扱い（Session完了とPaymentIntent入金完了を同一視しない）

`StripeWebhookHandler.gs`が処理するイベント種別:

| イベント種別 | 扱い |
| --- | --- |
| `checkout.session.completed` | `session.payment_status==='paid'`の場合のみ決済確認パイプラインへ進む。`'unpaid'`（非同期決済方法が完了待ちの中間状態）の場合は`IGNORED`として何もしない |
| `checkout.session.async_payment_succeeded` | 同上。非同期決済方法（Issue #341本文が言及する「非同期決済が有効になり得る場合」）が実際に完了した時点で届く |
| `checkout.session.async_payment_failed` | 対象の決済試行がまだ現在の決済試行のまま`checkout_pending`である場合のみ`failed`へ進める（新しい決済試行での再申込を可能にする）。既に成功済み・既に別の決済試行へ進んでいる場合は何もしない（成功を巻き戻さない） |
| 上記以外すべて（`checkout.session.expired`を含む） | `IGNORED`。仮押さえの失効判定は既存の`expirePendingBookings`（Stripe APIへの能動的な問い合わせ）に一元化しており、Webhookイベント駆動の失効処理を別途持たない（同じ予約に対して2つの失効経路を持たないため） |

`session.payment_status==='paid'`だけで確定させず、Stripe APIから**改めて取得した**
PaymentIntentの`status==='succeeded'`も必須とする（`StripeGateway.retrievePaymentIntent`。
「Session完了の事実」と「実際の入金完了」を混同しない。一致しない場合は自動確定せず
`PAYMENT_INTENT_STATUS_MISMATCH`としてRecoveryへ記録する）。またCheckout Session・
PaymentIntentともに、Webhookイベント本文のフィールドをそのまま信用せず、常にStripe API
から再取得した最新状態を正として使う。

### 予約・決済試行・金額の照合

`StripeWebhookHandler.processEvent`は、自動確定を許可する前に次のすべてを検証する
（1つでも欠ければ自動確定せずRecoveryへ記録し、`paymentRecoveryRequiredAt`で以後の
自動処理を停止する。入金の事実（`paymentStatus`）は消さない）:

- WebhookイベントID（`StripeEventRepository`の冪等性台帳のキー）
- Checkout Session ID（`record.stripeCheckoutSessionId`と一致すること）
- PaymentIntent ID（`applyPaymentStateUpdate`の`stripePaymentIntentId`として記録）
- 決済試行ID（`record.paymentAttemptId`と一致すること）
- 予約ID・ブランド（`record.brand`と一致すること）
- 支払金額・通貨（`CardPayment.verifyPaymentAgainstSnapshot`。Checkout Session発行時点の
  スナップショット基準。現在の料金を再計算しない）
- 実際の支払い完了状態（Session `payment_status==='paid'` **かつ** PaymentIntent
  `status==='succeeded'`）

`paid`への更新は`BookingRepository.applyPaymentStateUpdate`のみを使い、
`stripePaymentIntentId`・`lastStripeEventId`を必ず添える（PR-Aで定めた契約どおり）。

### イベントの冪等性（StripeEventRepository.gs）

`FeeSettlementRepository.gs`（日程変更精算の冪等性台帳）と同じ設計パターンで、専用の
「StripeEvents」シートへイベントごとに1行の処理状態を記録する。

| processingState | 意味 |
| --- | --- |
| `RECEIVED` | 処理に着手した（claim済み）が最終結果が未確定。`claimedAt`/`claimCount`で着手時刻・回数を追跡する |
| `COMPLETED` | 処理が完了した（自動確定の試行まで完了。自動確定自体が失敗しRecoveryへ回った場合も含む） |
| `IGNORED` | 対象外・まだ支払い未完了等、何も行う必要がなかった |
| `REJECTED` | 識別子・金額の不一致等、構造的に処理できないと判断した（Recoveryへ記録済み） |

- **同一イベントの再送を二重処理しない**: `processingState`が終端（`COMPLETED`/
  `IGNORED`/`REJECTED`）の行は再処理せず、記録済みの結果をそのまま成功として返す。
- **同一イベントの同時到達（並行配信）を二重実行しない**: `claim()`は
  `LockService.getScriptLock()`で保護された短時間の排他区間内で「既存行の有無」
  「`RECEIVED`のまま十分新しいか」を判定する。直近でclaimされたばかり（既定5分未満）の
  `RECEIVED`行が見つかった場合は、別の呼び出しが処理中とみなし`IN_PROGRESS`を返す
  （この回は何もせず、Stripeの自動再送に委ねる。二重に予約確定・Calendar更新・
  確認メール送信が実行されることはない）。
- **処理途中で失敗したイベントを「受信済みだから処理不要」として捨てない**: `RECEIVED`の
  まま一定時間（既定5分）を超えて放置された行は、前回の実行がクラッシュ・タイムアウト
  したとみなして安全に再claimし、最初から処理をやり直す。これが安全な理由は、
  再実行する`applyPaymentStateUpdate`/`confirmBooking`/確認メール送信のいずれも、
  それ自体が冪等（PR-A/PR-B/Issue #271で確立済み）であるため、途中まで進んでいても
  やり直して安全に同じ最終状態へ収束できるから。
- **Stripeへの成功応答の条件**: `StripeEventRepository.finalize()`（最終状態の永続化）が
  実際に成功した場合にのみ、`processEvent`は`ackSuccess:true`を返す。この書き込み自体が
  失敗した場合は、予約確定・決済状態の更新が既に成功していても`ackSuccess:false`を返し、
  行は`RECEIVED`のまま残る（次回の配信で安全に再claim・再確認できる。予約確定・メール
  送信は既に完了しているため二重実行はしない）。GAS Web Appの制約上`doPost`自体の
  HTTPステータスは常に200になるため、実際の成否はレスポンスJSONの`success`フィールドで
  中継基盤へ伝え、中継基盤が`success:false`の場合にStripeへ5xxを返して自動再送を促す
  （`cloud-run/stripe-webhook-relay/`参照）。

### Webhookと失効処理（expirePendingBookings）の競合

**この節がIssue #341本文「8. 失効処理との競合」への回答の核心。**

Webhook処理本体（`StripeWebhookHandler.gs`）と、その入口（`BookingWebhook.gs`の
`doPost`）は、**`confirmBooking`/`expirePendingBookings`と同じBooking Adminプロジェクト**
へデプロイする（Booking Web Appプロジェクトには追加しない）。これにより、Webhook処理が
呼ぶ`BookingRepository.applyPaymentStateUpdate`/`confirmBooking`と、
`expirePendingBookings`は、**同一の`LockService.getScriptLock()`（同一スクリプトプロジェクト
内でのみ実際に排他が効く、GASの既存の制約どおり）を取り合う**ことになる。

もしWebhook処理を（PR-Bの`beginCardCheckout`のように）公開Booking Web Appプロジェクトへ
置いていた場合、`expirePendingBookings`とは**別のLockService**（別スクリプトプロジェクト
のため）になり、以下のような事故が構造的に起こり得た:

1. `expirePendingBookings`がStripe側の状態を確認（Lockの外。Stripe呼び出し中に長時間
   Lockを保持しない既存方針）→ 安全に失効させてよいと判断。
2. その直後、Webhookが届き、**別のLockService**の下でCalendarを確定・`status:CONFIRMED`・
   `paymentStatus:paid`まで書き込む。
3. `expirePendingBookings`が（Webhookとは別のLockのため何にも待たされず）Lockを取得し、
   Calendar削除・`status:EXPIRED`を書き込んでしまう（Webhookが既に確定した内容を
   丸ごと上書き・破壊する）。

同一プロジェクト・同一LockServiceに揃えることで、この2つの臨界区間
（`expirePendingBookings`のLock取得〜Calendar削除〜EXPIRED書き込み、と
`applyPaymentStateUpdate`/`confirmBooking`の各Lock区間）は、GASの実行時に**絶対に
重ならない**（一方がLockを保持している間、他方は取得できるまで待つか、
`LOCK_TIMEOUT`で安全に失敗する）。さらに、以下の既存の安全策（多くはPR-Bで実装済み）が
「どちらが先に完了したか」を問わず正しい結果に収束させる:

- `expirePendingBookings`は、Lock取得**直後**に予約の最新状態を再読込し、
  `status !== PENDING`または`paymentStatus !== checkout_pending`であれば
  枠を解放せずスキップする（Webhookが先に完了していた場合、これで自動的に検知される。
  `BookingRepository.gs`の該当コメント参照）。
- `confirmBooking`（Webhookから呼ぶ側）自体が、Lock取得直後に予約の最新状態を再読込し、
  `status===EXPIRED`を明示的に拒否する（`expirePendingBookings`が先に完了していた場合、
  これで自動的に検知される）。
- `applyPaymentStateUpdate`が`paid`へ進めるのは`paymentStatus`列のみで、予約の`status`
  （PENDING/CONFIRMED/CANCELLED/EXPIRED）には一切影響しない。そのため
  `expirePendingBookings`が先に完了していた場合でも、決済成功の事実
  （`paymentStatus:paid`）は正しく記録できる一方、`confirmBooking`は
  `status===EXPIRED`により確定を拒否する。この場合、決済は完了しているが予約は
  確定できないため、`paymentRecoveryRequiredAt`を立ててRecoveryへ記録し、
  運営者の確認を必須にする（次節参照。**枠を確保できない決済の返金判断はPR-Dへ
  引き継ぐ**）。
- 外部Stripe API呼び出し（Checkout Session/PaymentIntent再取得）はいずれもLockの外で
  行う（PR-Bのreservepayment_パターンを踏襲。Lock保持中に低速な外部HTTP呼び出しを
  行わない）。

`test/stripe-webhook-handler.test.js`に、この競合を再現する2件の統合テストを追加した
（「Webhookが先に確定 → 失効処理は枠を解放しない」「失効処理が先に完了 → 遅延した
決済成功はRecoveryへ送られ入金は保持される」）。いずれもPR-B時点のテストが確立した
「Stripeモックの応答コールバック内でもう一方の処理を入れ子に実行し、実際の並行到達を
再現する」パターンを踏襲している。

### 決済済みでも予約を確定できない場合の扱い（Recovery・運用）

次のいずれかに該当する場合、`paymentStatus`は`paid`のまま**変更せず**（入金の事実を
消さない）、`paymentRecoveryRequiredAt`を立ててRecoveryへ記録し、以後この予約への
`applyPaymentStateUpdate`/`beginCardCheckout`の自動呼び出しをすべて停止する
（`confirmBooking`/`cancelBookingAdmin`/`reviveExpiredBooking`はこのゲートの対象外の
ため、管理者は引き続き手動でこれらの操作を行える）:

| Recovery `failureType` | 発生条件 |
| --- | --- |
| `STRIPE_WEBHOOK_IDENTITY_MISMATCH` | Session ID・決済試行ID・ブランドのいずれかが台帳の記録と一致しない |
| `PAYMENT_INTENT_STATUS_MISMATCH` | SessionはpaidだがPaymentIntentがsucceededでない |
| `STRIPE_WEBHOOK_AMOUNT_MISMATCH` | 金額・通貨がCheckout Session発行時点のスナップショットと一致しない |
| `STRIPE_WEBHOOK_PAYMENT_UPDATE_REJECTED` | `applyPaymentStateUpdate`が`INVALID_PAYMENT_TRANSITION`等、自身では記録しないコードで`paid`への更新を拒否した（例: 仮押さえ失効・別経路で既に`failed`へ進んでいた後の遅延成功イベント） |
| `PAYMENT_SUCCEEDED_BOOKING_CONFIRM_BLOCKED` | 決済確認後、`confirmBooking`が失敗した（仮押さえ失効・キャンセル済み・Calendarイベント消失・料金訂正案内未送信・保存失敗等） |

`applyPaymentStateUpdate`自身が内部で既にRecoveryへ記録済みのコード
（`UNKNOWN_PAYMENT_STATUS`/`PAYMENT_IDENTITY_MISMATCH`/`PAYMENT_IDENTITY_UNCONFIRMED`/
`PAYMENT_EVIDENCE_MISSING`/`PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT`）は
`StripeWebhookHandler.gs`側で重複記録しない（`SELF_RECORDING_PAYMENT_UPDATE_ERROR_CODES_`
参照）。

決済は完了しているが予約を確定できない場合の利用者向け案内（返金確約・予約確定の
誤案内を避ける文言）・自動返金・鍵承認ゲート・「来場案内を再送」ボタンはPR-Dの対象。
本PRでは利用者向けの新しい自動メールを追加していない（確定できた場合の確認メールは
既存の`sendConfirmedMailForBooking`をそのまま再利用する）。

### Stripeへの照会失敗時の扱い

Checkout Session/PaymentIntentの再取得（`StripeGateway.retrieveCheckoutSession`/
`retrievePaymentIntent`）自体が失敗した場合（ネットワークエラー・Stripe側5xx等）、
未払いと決めつけず、StripeEventsの行を`RECEIVED`のまま確定させない
（`ackSuccess:false`を返し、Stripeの自動再送に委ねる。次回の配信で改めて照会する）。

### テスト結果

`node --test`: **総計1187件すべてpass**（PR-Cで新規に追加した48件を含む。
`test/stripe-webhook-auth.test.js`9件・`test/stripe-event-repository.test.js`8件・
`test/stripe-webhook-handler.test.js`20件・`cloud-run/stripe-webhook-relay/test/
handler.test.js`11件）。既存の管理者承認・Calendar・日程変更精算・Booking Admin・現地払い・
旧Payment Link方式・PR-A/PR-Bの回帰テストもすべてpass。実際の本番決済・本番Webhook
配信を伴う自動テストは行っていない。

受入条件との照合（PR-Cの範囲内のもののみ）:
- [x] 正しい署名のイベントのみ受け付ける（中継基盤のStripe署名検証＋中継→GASのHMAC認証）
- [x] 不正署名・期限外署名・改ざんされた本文を拒否する
- [x] 同一イベントの重複配信・並行配信で二重確定・二重メールが起きない
- [x] イベント処理途中の失敗後、安全に再試行できる
- [x] 未払いのSession完了イベントでは予約確定しない
- [x] 金額・通貨・予約ID・Session ID・決済試行IDの不一致を拒否する
- [x] 決済成功と仮押さえ失効が競合しても、枠の解放と予約確定が二重に成立しない
- [x] 失効済み・キャンセル済み・枠を失った予約への遅延決済をRecoveryへ送る
- [x] 決済状態の保存後に予約確定が失敗しても、入金済みの記録を保持する
- [x] Webhook再送で確認メールを二重送信しない
- [x] PR-BのCheckout発行・旧Payment Link・PayPay・現金・管理者承認・日程変更精算の既存テストが通る

### Stripe Webhookエンドポイントのデプロイ（オーナー承認後に実施すること）

`BookingWebhook.gs`の`doPost(e)`は、既存のBooking Admin Web UI
（`BookingAdminWeb.gs`の`doGet()`。Execute as: Me / Who has access: Only myself）と
**同一のApps Scriptプロジェクト**のコードだが、Googleは1プロジェクトに対して複数の
独立したWeb Appデプロイ（別URL・別アクセス設定）を許可している。この性質を利用し、
既存の管理者専用デプロイの設定は一切変更せず、Webhook受信専用の**新しい別デプロイ**を
追加する。

1. Booking AdminプロジェクトのGASエディタで「デプロイ」→「新しいデプロイ」を選択する
   （既存デプロイの「編集」ではなく、必ず新規デプロイを作成すること。既存デプロイの
   アクセス設定を変更すると、管理者本人用UIの認可境界が変わってしまう）。
2. 種類は「ウェブアプリ」、**Execute as: 自分（Me）**、**Who has access: 全員（Anyone）**
   を選択する（Stripe中継基盤からの匿名POSTを受け付ける必要があるため。認証は
   `STRIPE_WEBHOOK_RELAY_SECRET`によるアプリケーションレベルのHMAC認証で行う。
   「中継→GASの認証」節参照）。
3. 発行された新しいデプロイURLを、中継基盤（Cloud Run）の環境変数
   （`GAS_WEBHOOK_URL`。`cloud-run/stripe-webhook-relay/`参照）に設定する。
4. Booking AdminプロジェクトのScript Propertiesに`STRIPE_WEBHOOK_RELAY_SECRET`
   （中継基盤と共有する値）・`STRIPE_SECRET_KEY`（未設定ならPR-Bの手順で設定済みのはず）
   を設定する。
5. コード更新のたびに、この新デプロイも既存デプロイと同様に「デプロイを管理」から
   新しいバージョンへ更新すること（既存デプロイのURL維持の運用方針と同じ）。

### PR-Dへの引き継ぎ事項

- `paymentRecoveryRequiredAt`が立った予約（本PRで追加した5種類のfailureTypeを含む）を
  管理者が確認・解除する手段（`resolveFeeRecovery`相当）は未実装。
- Booking Adminの「取消（自動返金）」ボタン・Stripe返金API・冪等キー付き返金実行。
- 「鍵承認」ボタン・`accessApprovedAt`列・前日リマインドの鍵承認ゲート条件。
- 「来場案内を再送」ボタン（`adminResendReminderMail`）。
- 決済は完了したが予約を確定できない場合の利用者向け案内文言（返金確約・予約確定の
  誤案内を避ける）。既存のPENDING/CONFIRMED/CANCELLED/REMINDERメール文言の更新。
- 中継基盤（Cloud Run）・Stripe Webhook Endpoint・Booking Adminの新規Web Appデプロイの
  実際の作成・本番Script Properties設定・本番Stripe Webhook設定はオーナーの明示承認後に
  別途行う（本PRはコードの提供のみ）。

PR-Cには自動着手しません。レビューをお待ちします。

## 部分失敗・recoveryの確認手順（運用者向け）

1. `Recovery`シートを開き、`recoveryState`が`OPEN`の行を確認する
   （`RESOLVED`は自動補償済み、`INFO`は通知失敗など予約自体に影響のない記録）。
2. `failureType`が`SHEETS_FAILURE_CALENDAR_ORPHANED`の場合、`calendarEventId`を
   Google Calendarで直接開いて確認し、不要であれば手動で削除する。
3. `failureType`が`CONFIRM_CALENDAR_EVENT_MISSING`の場合、`bookingId`を`Bookings`
   シートで確認し、Calendar側に該当イベントが本当にないかを確認する。運用判断で
   利用者へ連絡するか、Calendarへ手動でイベントを作り直してから再度
   `confirmBooking(bookingId)`を実行する。
4. `failureType`が`CONFIRM_SHEETS_FAILURE_CALENDAR_ORPHANED`の場合、`calendarEventId`を
   Calendarで開いて確定表示（`[Studio X 確定]`）になっているか確認する。`Bookings`
   シート側は`PENDING`のままなので、Sheets側の`status`を手動で`CONFIRMED`に直接書き換える
   のではなく、Calendar側の表示を`[Studio X 仮予約]`へ手動で戻すか、Sheets保存先の
   一時的な障害が解消したことを確認したうえで再度`confirmBooking(bookingId)`を実行する
   （`getEventById`はCalendarイベントが現存する限り再実行を妨げない）。
5. `failureType`が`EXPIRE_SHEETS_UPDATE_FAILED`の場合、`calendarEventId`のCalendarイベントは
   既に削除済みだが、`Bookings`シート側は`status`が`PENDING`のまま残っている。
   Sheets保存先の一時的な障害が解消したことを確認できれば、`statusセルの直接編集はしない`
   （`expirePendingBookings`を再実行すれば、このbookingIdはまだ`PENDING`のため再び候補として
   抽出され、Calendar側は既に削除済みのため`EXPIRE_CALENDAR_DELETE_FAILED`が追加記録される
   ものの、続くSheets更新が今度は成功すれば`status`が正しく`EXPIRED`になる。この経路は
   `test/booking-confirm-expire.test.js`の障害分離テストと同じ仕組みで安全に再実行できる）。
6. 対応が完了したら、`Recovery`シートの`recoveryState`・`resolvedAt`列へ手動で
   記録する（このシートはBookings台帳と異なり、運用者が直接編集してよい）。
7. `failureType`が`MAIL_PENDING_FAILED`/`MAIL_CONFIRMED_FAILED`/`MAIL_CANCELLED_FAILED`/
   `MAIL_REMINDER_FAILED`（Issue #271）の場合、予約自体の`status`・Calendar/Sheetsの
   予約データは正常なまま（メール送信のみが失敗している）。`Bookings`シートの該当行の
   `lastMailErrorAt`/`lastMailErrorType`/`lastMailErrorMessage`で発生日時・種別・
   エラー概要を確認し、原因（`BOOKING_MAIL_DISPLAY_NAME`等の設定不足、
   `ACCESS_GUIDE_KEYBOX_NUMBER`/`ACCESS_GUIDE_UNLOCK_CODE`の未設定、MailAppの
   日次クォータ超過等）を解消したうえで、Booking Adminプロジェクトの「予約管理」
   メニュー→「予約メールを再送（予約ID指定・強制再送）」からbookingIdとメール種別を
   指定して再送する（詳細は「Issue #271: 予約通知メール自動送信」の「手動再送」参照）。
   自動処理は対応するSentAtが既にある場合は再送しないため、原因解消後の再送は
   必ずこの手動再送機能を使うこと（SentAtを直接消す運用はしない）。
8. `failureType`が`CANCEL_CALENDAR_EVENT_MISSING`（Issue #272）の場合、`cancelBookingAdmin`
   実行時点でCalendarイベントが既に無かったことを示す（Sheetsは`CANCELLED`へ収束済み。
   予約処理自体は完了している）。`bookingId`を`Bookings`シートで確認し、いつ・なぜ
   Calendar側だけ先に消えたか（手動削除・スペースマーケット側の操作等）を調査する。
   調査が完了したら`recoveryState`・`resolvedAt`を手動で記録する（自動ではRESOLVEDに
   ならない。詳細は「Issue #272: 管理者キャンセルでCalendar / Sheetsを一貫更新する」参照）。
9. `failureType`が`CANCEL_CALENDAR_DELETE_FAILED`（Issue #272）の場合、`calendarEventId`は
   まだCalendar上に残っている可能性が高い（`Bookings`シートの`status`は元のまま）。
   Calendar側の一時的な障害（API制限等）が解消したことを確認したうえで、同じbookingIdで
   再度`cancelBookingAdmin(bookingId)`を実行する。
10. `failureType`が`CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED`（Issue #272）の場合、
    `calendarEventId`のCalendarイベントは既に削除済みだが、`Bookings`シート側は`status`が
    `PENDING`/`CONFIRMED`のまま残っている。**Calendarイベントを手動で作り直して補償しない**
    （eventIdが変わり二次的不整合を増やすため）。Sheets保存先の一時的な障害が解消したことを
    確認できれば、同じbookingIdで再度`cancelBookingAdmin(bookingId)`を実行する
    （Calendar側は既に無いため`CANCEL_CALENDAR_EVENT_MISSING`の経路から`Bookings`の`status`が
    正しく`CANCELLED`へ収束し、キャンセルメールも送信される。`test/booking-cancel.test.js`の
    障害分離テストと同じ仕組みで安全に再実行できる）。
11. `failureType`が`CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT`/
    `CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND`（Issue #272）の場合、`Bookings`シートに
    正式な予約台帳の行が無いまま、Calendarにだけ`bookingId`タグ一致のイベントが1件/複数件
    残っている。**この診断ではCalendarを自動削除しない**（正式台帳が無い状態で破壊的変更を
    行うのは危険なため）。`calendarEventId`をCalendarで直接確認し、利用者情報・支払い状況を
    運用側の記録（メール等）から復元したうえで、Google Calendar UIから手動で削除するか、
    運用判断でそのまま残すかを決める。
12. `failureType`が`CANCEL_BOOKING_NOT_FOUND`（Issue #272）の場合、`Bookings`シートにも
    Calendarにも該当する予約が見つからない（bookingIdの入力ミス、または既に別の方法で
    削除済みの可能性がある）。`bookingId`の入力内容を確認し、心当たりがなければ対応不要
    （記録のみで実害はない）。
13. `failureType`が`CANCEL_CALENDAR_LOOKUP_FAILED`（Issue #272 PRレビュー対応）の場合、
    `cancelBookingAdmin`実行時に`CalendarRepository.getEventById`自体が例外を投げている
    （イベントが無いのではなく、`CALENDAR_ID`設定不正・Calendar APIの一時的な障害等）。
    `Bookings`シートの`status`・Calendarはいずれも変更されていない。原因
    （`CALENDAR_ID`の設定・Calendar APIのクォータ/権限等）を解消したうえで、同じ
    bookingIdで再度`cancelBookingAdmin(bookingId)`を実行する。
14. `failureType`が`CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED`（Issue #272 PRレビュー対応）
    の場合、`Bookings`シートにbookingId行が無い状態でのCalendar診断
    （`findBookingEventsByBookingId`）自体が例外で失敗している（診断結果が0/1/複数件のいずれ
    でもない）。Calendarは変更されていない。原因を解消したうえで、同じbookingIdで
    再度`cancelBookingAdmin(bookingId)`を実行し、診断が正常に完了することを確認する。
15. `failureType`が`PAYMENT_LINK_MAIL_FAILED`（Issue #334 PR-C）の場合、予約自体の
    `status`（PENDING）・Calendar/Sheetsの予約データは正常なまま（決済リンクメール送信のみ
    失敗している）。`Bookings`シートの該当行の`paymentLinkLastErrorAt`/
    `paymentLinkLastErrorMessage`（他メール種別と共有する`lastMailErrorAt`等とは別の専用列）
    で発生日時・エラー概要を確認し、原因（`BOOKING_MAIL_DISPLAY_NAME`等の設定不足、
    MailAppの日次クォータ超過等）を解消したうえで、Booking Admin予約詳細の決済リンク送信欄
    から**明示的な再送**として再試行する（自動では再送されない。`stripePaymentLinkUrl`は
    前回入力したURLが入力欄へ復元されるため、そのまま再送するか、必要なら新しいURLへ
    差し替えてから送信する）。
16. `failureType`が`PAYMENT_LINK_SEND_HISTORY_UPDATE_FAILED`（PR #337レビュー対応・
    1回目）の場合、MailApp.sendEmail自体は成功しているため、**利用者へ決済リンクメールが
    実際に届いている可能性がある**（送信直後のSheets書き込みだけが失敗している）。まず
    `stripePaymentLinkUrl`・利用者への問い合わせ等でメールが実際に届いているかを確認する。
    - 届いている場合: 重複してリンクを再送する必要はない。`Bookings`シートの
      `paymentLinkSentAt`・`paymentLinkSendCount`を運用判断で手動修正するか、そのまま
      `paymentLinkSendUnconfirmedAt`を残し、次に必要になった時点でBooking Admin予約詳細
      から**明示的な再送**（force）を行う（このAtが空でない間は通常送信が拒否されるため、
      誤って重複送信される心配はない）。
    - 届いていない場合、または確認できない場合: Sheets保存先の一時的な障害が解消した
      ことを確認したうえで、Booking Admin予約詳細から**明示的な再送**を行う
      （`paymentLinkSendUnconfirmedAt`が空でなくても、明示的な再送はforceで実行できる）。
    - いずれの場合も`Bookings`シートの`status`（PENDING）・Calendar/Sheetsの予約データ
      本体は変更されていない。
17. `failureType`が`PAYMENT_LINK_METADATA_UPDATE_FAILED`（PR #337レビュー対応・2回目）
    の場合、MailApp.sendEmail・`paymentLinkSentAt`の記録はいずれも成功しているため
    **送信履行・二重送信防止は確定済み**（前項16と異なり、届いているかどうかの確認は
    不要）。問題は`stripePaymentLinkUrl`/`paymentLinkSentTo`/`paymentLinkSendCount`の
    記録だけが古いままになっていること。
    - Recoveryの`errorMessage`に記載された本来の送信回数（`intendedSendCount`相当）と、
      `Bookings`シートの`paymentLinkSendCount`の表示を突き合わせ、必要であれば
      `paymentLinkSendCount`・`stripePaymentLinkUrl`・`paymentLinkSentTo`を運用判断で
      手動修正する（Sheets保存先の一時的な障害が解消していることを確認したうえで行う）。
    - `paymentLinkMetadataInconsistentAt`が記録されている間、Booking Admin予約詳細では
      「記録不整合」と表示され、**通常送信・明示的な再送とも送信ボタン自体が無効化される**
      （3回目対応。`force`でも通過しない。他の予約への通常の送信操作は影響を受けない）。
      送信履行自体は既に確定しているため、メール自体を重複して再送する必要はない。
    - このフラグは、次に別の送信が成功しただけでは**自動的にクリアされない**（3回目対応。
      これは送信回数の食い違いを隠さないための意図的な仕様）。解消するには次項18の手順で
      専用の補正操作を実行する。
    - `Bookings`シートの`status`（PENDING）・Calendar/Sheetsの予約データ本体は
      変更されていない。
18. `failureType`が`PAYMENT_LINK_METADATA_UPDATE_FAILED`を`paymentLinkMetadataInconsistentAt`
    経由で解消する場合（PR #337レビュー対応・3回目で新設・5回目で対象をURL・送信先へ拡張
    した手順）:
    - まずRecoveryの`errorMessage`に記載された本来の送信回数（`intendedSendCount`相当）と、
      実際のメール送信履歴（利用者への到達確認・MailAppの送信ログ等）を突き合わせ、
      正しい送信回数・実際に送信したStripe決済リンクURL・送信先メールアドレスを確認する
      （前項17と同じ確認作業。ここまでは`Bookings`シートを直接編集しない）。
    - 正しい値を確認できたら、Booking Admin予約詳細の決済リンク送信欄に表示される
      「送信履歴を補正」ボタン（記録不整合の間のみ表示される）を押し、`window.prompt`で
      確認済みの送信回数・URL・送信先メールアドレスを順に入力し、`window.confirm`で
      最終確認する（5回目対応でURL・送信先の入力を追加した。既定値は現在Bookingsシートに
      記録されている値で、実際の送信履歴と一致していればそのまま確定でよい。Booking Admin
      プロジェクト自体が「Execute as: Me / Who has access: Only myself」運用のため、
      この操作もその単一管理者アクセスの範囲内に限られる）。
    - 内部的には`resolvePaymentLinkMetadataInconsistency(bookingId, confirmedSendCount,
      confirmedUrl, confirmedSentTo)`が呼ばれ、`paymentLinkMetadataInconsistentAt`が現在
      記録されている予約のみを受け付け（対象外は`NOT_INCONSISTENT`で拒否）、
      `confirmedSendCount`が0以上の整数かつ現在の`paymentLinkSendCount`以上であること
      （`INVALID_CONFIRMED_SEND_COUNT`/`CONFIRMED_SEND_COUNT_TOO_LOW`で拒否）、
      `confirmedUrl`がStripe決済リンクURLの形式（`INVALID_CONFIRMED_URL`で拒否）、
      `confirmedSentTo`がメールアドレスの形式（`INVALID_CONFIRMED_SENT_TO`で拒否）を
      それぞれ検証する。
    - 検証を通過すると、**まず`stripePaymentLinkUrl`・`paymentLinkSentTo`・
      `paymentLinkSendCount`の3項目をまとめて補正値へ更新し、最新レコードを再取得して
      3項目すべてが実際に反映されたことを確認したうえで、続けて
      `paymentLinkMetadataInconsistentAt`のみを空へ更新し、再度最新レコードを再取得して
      フラグが実際に空になったことを確認する**（PR #337レビュー対応・4回目の設計を
      5回目で対象へ拡張。3項目のいずれかの反映を確認できない場合は
      `RESOLVE_FIELDS_NOT_CONFIRMED`として失敗を返し、`paymentLinkMetadataInconsistentAt`
      は維持される＝送信は引き続き拒否される。Sheetsの記録のみを補正する。メール送信・
      Calendar操作は行わない）。
    - フラグのクリア後の最終確認の再取得**自体が失敗**した場合（5回目対応）は、クリア
      操作自体は成功していた可能性があり、フラグが実際にクリアされているかどうかは
      **不明**なため`RESOLVE_RESULT_UNKNOWN`として失敗を返す（「維持されている」とは
      断定しない）。この場合、`Bookings`シートの`paymentLinkMetadataInconsistentAt`列を
      直接確認すること（3項目の補正自体はこの時点で確認済みのため、再確認の必要はない）。
      再取得に成功し、その内容からフラグがまだ空になっていないことを確認できた場合のみ
      `RESOLVE_FLAG_CLEAR_NOT_CONFIRMED`（確定的な未解消）を返す。
    - 補正が完了する（3項目の反映・フラグのクリアの両方を確認できる）と、Recoveryへ
      `failureType: 'PAYMENT_LINK_METADATA_RESOLVED'`・`recoveryState: 'RESOLVED'`として
      補正の実施内容（補正前後の送信回数・確認済みのURL・送信先）が記録される（元の
      `PAYMENT_LINK_METADATA_UPDATE_FAILED`のOPEN行自体は、他の失敗記録と同じく運用者が
      手動で`recoveryState`/`resolvedAt`を記録する。前項6参照）。補正後は送信（通常送信・
      明示的な再送）が再び許可される。
    - `failureType`が`PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`（PR #337レビュー対応・
      4回目・5回目）として記録された場合、上記の補正の試行自体が完了しなかった
      （`RESOLVE_FIELDS_NOT_CONFIRMED`/`RESOLVE_FLAG_CLEAR_NOT_CONFIRMED`）か、結果を確認
      できなかった（`RESOLVE_RESULT_UNKNOWN`）ことを示す。`errorMessage`に記載された
      内容（どの段階を確認できなかったか）を確認し、`Bookings`シートの実際の値と食い違いが
      ないかを直接確認する。Sheets保存先の一時的な障害が解消したことを確認できれば、
      同じ`bookingId`・確認済みの送信回数・URL・送信先で「送信履歴を補正」を再試行する
      （`confirmedSendCount`は現在の`paymentLinkSendCount`以上であれば再実行できるため、
      3項目の反映が一部だけ確認できなかった場合も安全に再試行できる。`RESOLVE_RESULT_
      UNKNOWN`の場合も、フラグが実際にはクリアされていれば次の再試行は`NOT_INCONSISTENT`
      で拒否され、まだ残っていれば通常どおり補正できる）。
    - `Bookings`シートの`status`（PENDING）・Calendar/Sheetsの予約データ本体は
      変更されていない。

## API仕様

### `GET ?date=YYYY-MM-DD&durationMinutes=120&brand=studio_x`（getAvailability。
#266から拡張、Issue #270レビュー対応で「過去日の拒否」「当日の過去開始時刻を除外」を追加）

`brand`には`snb` / `mens` / `studio_x`のいずれかを指定できる（getAvailabilityは元から
brandで判定を分岐させないため、この値は表示・流入元識別以外に使われない）。
`customerType`はgetAvailabilityの入力・応答のいずれにも登場しない（当日+初回利用の
可否判定は`createBooking`のみの責務。「当日の過去開始時刻を防ぐ」参照）。

`date`は`Asia/Tokyo`基準の「今日」（`today`）と比較する:

- `date < today` → `INVALID_DATE`（`過去の日付は指定できません。`）で拒否する。
  `handleGetAvailability_`（`Code.gs`）でも同じ判定を行い、過去日はCalendarへ
  問い合わせる前に拒否する（不要なCalendar API呼び出しを避けるため。
  `BookingAvailability.getAvailability`内でも同じ判定を行うため二重の安全網になる）
- `date === today` → `bookableStartTimes`には現在時刻より後の開始時刻のみを含める
  （現在時刻ちょうども除外）
- `date > today` → 現在時刻に関わらず従来どおり全候補を返す

`createBooking`の`INVALID_DATE`（過去日拒否）と同じerror.code・同じメッセージで統一する。

成功時：

```json
{
  "success": true,
  "date": "2026-10-01",
  "durationMinutes": 120,
  "brand": "studio_x",
  "bookableStartTimes": ["08:00", "08:15", "..."]
}
```

### `GET ?action=monthly&year=2026&month=10&durationMinutes=120&brand=studio_x&timeBand=all`
（getMonthlyAvailability。Issue #318で追加、Issue #324で`timeBand`を追加）

月間空き状況カレンダー用。対象月の全日付ぶんのステータスを1回のリクエストで返す
（31日分を1日ごとにリクエストする実装は不可。「Issue #318: 月間空き状況カレンダー」参照）。
`year`/`month`/`durationMinutes`は`getAvailability`の`durationMinutes`と同じ形式
（先頭0を持たない正の整数の文字列のみ受理。`month`に`09`のような先頭0付き文字列は
渡さないこと）。`durationMinutes`は必須（利用時間によって日ごとの空き判定結果が
変わるため。「Step 1のUI順序」参照）。`brand`は表示・流入元識別のみに使い、
判定ロジックはbrandで分岐させない（`getAvailability`と同じ方針）。

`timeBand`（Issue #324で追加。任意）は、日別ステータスの判定対象となる開始時刻候補を
開始時刻基準で絞り込む希望時間帯フィルタ。有効値は以下の4種類:

| timeBand | 意味 | 開始時刻の範囲 |
| --- | --- | --- |
| `all` | 指定なし（絞り込みなし） | — |
| `morning` | 午前 | 08:00〜11:45開始 |
| `daytime` | 昼 | 12:00〜17:45開始 |
| `evening` | 夜 | 18:00以降開始 |

未指定、またはこの4値以外の値（例: 空文字・大文字・タイプミス）を受け取った場合は
エラーにせず`all`へフォールバックする（`BookingAvailability.normalizeTimeBand`）。
GitHub PagesとBooking GASは別々にデプロイされるため、デプロイ過渡期に「`timeBand`を
送らない旧フロント」×「新GAS」の組み合わせが一時的に発生し得ることへの対応。
単日`getAvailability`（`action`未指定のリクエスト）の仕様・パラメータは変更していない
（`timeBand`は`action=monthly`のみで使う）。

成功時：

```json
{
  "success": true,
  "month": "2026-10",
  "durationMinutes": 120,
  "brand": "studio_x",
  "days": {
    "2026-10-01": { "status": "AVAILABLE_HIGH", "availableStartTimes": 53 },
    "2026-10-02": { "status": "LIMITED", "availableStartTimes": 4 },
    "2026-10-03": { "status": "FULL", "availableStartTimes": 0 },
    "2026-09-30": { "status": "OUT_OF_RANGE", "availableStartTimes": 0 }
  }
}
```

`days`は対象月の全日付ぶんのキーを必ず含む。`status`は5値のenum
（`gas/booking/shared/Availability.gs`の`BookingAvailability.DAY_STATUS`）:

| status | 意味 | フロント表示 |
| --- | --- | --- |
| `AVAILABLE_HIGH` | 空き時間が十分ある | ◎ |
| `AVAILABLE` | 空きあり | ○ |
| `LIMITED` | 残り枠が少ない | △ |
| `FULL` | 予約可能枠なし（既存予約で埋まっている、またはその利用時間では元々1件も入らない） | × |
| `OUT_OF_RANGE` | 予約対象外（過去日） | － |

`FULL`/`LIMITED`/`AVAILABLE`/`AVAILABLE_HIGH`の判定は、既存の`computeBookableStartTimes`
（`getAvailability`と同一関数。スロット生成ロジックの再実装はしていない）を日ごとの
busyIntervalsへ適用した結果を、`timeBand`で絞り込んだうえで件数を以下の閾値で
バケット分けするだけで求める（`Availability.gs`の`classifyDayStatus_`にのみ定義。
他ファイルへ分散させていない）:

- `count`: その日にcomputeBookableStartTimesで実際に得られた開始時刻を、
  `filterStartTimesByTimeBand`で`timeBand`により絞り込んだ後の件数
- `maxPossible`: 同じ日・同じduration・同じ当日フィルタ条件で、既存予約が一切
  無かった場合に得られる開始時刻を、**同じ`timeBand`で絞り込んだ後**の件数
  （＝その日・そのtimeBandにおける理論上の最大件数。分母も同じ`timeBand`で
  絞り込むこと。分母を絞らずに1日分のままにすると、band選択時の記号判定が
  実態より悪く出てしまう）
- `ratio = count / maxPossible`
- `count === 0`（または`maxPossible === 0`。その利用時間・timeBandでは1件も
  入らない日）→ `FULL`
- `ratio <= 1/3` → `LIMITED`
- `ratio >= 2/3` → `AVAILABLE_HIGH`
- それ以外 → `AVAILABLE`

絶対件数ではなく理論上の最大件数に対する割合で判定するのは、利用時間が長いほど
1日に入り得る枠数自体が少なくなり、絶対件数だけで閾値を決めると利用時間ごとに
「十分空いている」の意味が変わってしまうため。`timeBand=all`（既定）は絞り込みを
行わないため、現在の全日判定（timeBand導入前と同一のcount/maxPossible）と完全に
一致する。

当日（Asia/Tokyo基準）は`getAvailability`と同じく、現在時刻以前（ちょうど含む）の
開始時刻を候補から除外したうえで`count`/`maxPossible`を計算する（`minimumStartMinutes`）。
選択中の時間帯がすでに過ぎている場合（例: 現在14:00に`timeBand=morning`を指定）は、
`count`・`maxPossible`の両方が0件になり`FULL`になる。過去日は`computeBookableStartTimes`を
呼ばず、常に`OUT_OF_RANGE`・`availableStartTimes: 0`を返す。`customerType`はgetAvailabilityと
同じくここにも一切登場しない（「今日＋初回利用」のカレンダー上のガードはフロント側の責務。
「Issue #318: 月間空き状況カレンダー」参照）。

失敗時のerror.codeは`getAvailability`と共通のもの（`INVALID_CONFIG`/`INVALID_DURATION`/
`DURATION_TOO_SHORT`）に加えて、`INVALID_MONTH`（`year`/`month`が不正）を返す。
`timeBand`が不正・未指定の場合はエラーにせず`all`へフォールバックするため、
`timeBand`単独でエラーになることはない。

Calendar側は`CalendarRepository.getBusyIntervalsForRange(calendarId, startDate, endDate,
timezone)`が対象月全体を`calendar.getEvents()`の呼び出し1回だけで取得し、日ごとの
busyIntervalsへ振り分ける（`getBusyIntervalsForDate`と同じ「日をまたぐイベントは対象日の
範囲へクランプする」「終日イベントはisAllDay:trueにする」規則を、区間全体に対して適用する）。

### `POST`（createBooking。#268でstudio_x限定として追加、#269でsnb/mensへ拡張、
#270でcustomerTypeを必須項目として追加）

リクエストボディ（JSON。`Content-Type`は共通予約UIから`text/plain;charset=utf-8`で
送る。理由は「共通予約UI（フロントエンド）」節を参照）:

```json
{
  "brand": "studio_x",
  "customerType": "returning",
  "date": "2026-10-01",
  "startTime": "10:00",
  "durationMinutes": 120,
  "name": "山田太郎",
  "email": "taro@example.com",
  "phone": "090-1234-5678",
  "people": "2名",
  "purpose": "緊縛の自主練習",
  "paymentMethod": "現金",
  "note": "",
  "source": "studio-x-booking-app"
}
```

`brand`には`snb` / `mens` / `studio_x`のいずれかを指定する。`customerType`には
`first_time`（初回利用）または`returning`（利用経験あり）のいずれかを指定する
（Issue #270で必須項目として追加。省略・未知の値は`INVALID_CUSTOMER_TYPE`で拒否する）。
`date`が当日（Asia/Tokyo基準）かつ`customerType`が`first_time`の場合は
`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`で拒否する。当日かつ`startTime`が現在時刻以前
（ちょうど含む。Asia/Tokyo基準）の場合は`SAME_DAY_START_TIME_PASSED`で拒否する
（「Issue #270: 当日利用ルールと利用経験判定」参照）。`source`は共通予約UIが
ブランドごとに自動設定する値で、`snb-booking-app` / `mens-booking-app` /
`studio-x-booking-app`のいずれかになる（`scripts/booking-logic.js`の
`BRAND_META`参照）。

成功時：

```json
{
  "success": true,
  "bookingId": "SX-20261001-3F2A9B1C",
  "status": "PENDING",
  "date": "2026-10-01",
  "startTime": "10:00",
  "durationMinutes": 120,
  "brand": "studio_x"
}
```

呼び出した本人が送った内容の要約のみを返し、他の予約のイベント詳細・PIIは一切含まない。

失敗時：

```json
{ "success": false, "error": { "code": "SLOT_CONFLICT", "message": "..." } }
```

`error.code`の主な値: `INVALID_BRAND` / `INVALID_CUSTOMER_TYPE`（Issue #270で追加。
`customerType`が未指定・未知の値） / `INVALID_CONFIG`（Availability設定自体が不正。
fail-closed） / `INVALID_DATE`（過去日を含む） /
`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`（Issue #270で追加。当日＋`first_time`の組み合わせ）/
`SAME_DAY_START_TIME_PASSED`（Issue #270レビュー対応で追加。当日＋開始時刻が現在時刻
以前）/ `INVALID_DURATION` / `DURATION_TOO_SHORT` /
`INVALID_START_TIME` / `START_TIME_NOT_ALIGNED`（開始時刻が`SLOT_STEP_MINUTES`刻みでない）/
`INVALID_NAME` / `INVALID_EMAIL` / `INVALID_PHONE` / `INVALID_PEOPLE` / `INVALID_PURPOSE` /
`INVALID_PAYMENT_METHOD` / `INVALID_NOTE` / `INVALID_SOURCE` /
`CARD_PAYMENT_TOO_CLOSE_TO_START`（Issue #334で追加。`paymentMethod`が
`オンラインクレジットカード`かつ利用開始まで`CARD_MIN_HOURS_BEFORE_START`（96時間）
未満の申込を拒否する） / `RATE_LIMITED`
（`error.reason`に`EMAIL_RATE_LIMIT`/`GLOBAL_RATE_LIMIT`/`DUPLICATE_SUBMISSION`のいずれか）/
`LOCK_TIMEOUT` / `SLOT_CONFLICT` / `BOOKING_SAVE_FAILED` / `INVALID_JSON` /
`INTERNAL_ERROR`

Issue #269時点で`brand`に指定できるのは`snb` / `mens` / `studio_x`の3つのみで、
それ以外の文字列を指定した場合はサーバー側で`INVALID_BRAND`として拒否する
（フロント表示に関わらずbrand偽装で未許可のbrandからの予約は作れない）。同様に
Issue #270時点で`customerType`に指定できるのは`first_time` / `returning`の2つのみ。

## 管理メニュー用GASプロジェクト（Booking Admin）のセットアップ

**背景**: Googleの仕様上、`SpreadsheetApp.getUi()`によるカスタムメニュー作成は、
対象Spreadsheetへコンテナバインドしたスクリプト（Spreadsheetの「拡張機能 → Apps Script」
から作成するプロジェクト）からしか使えない。スタンドアロンスクリプトが対象Spreadsheetに
対するinstallable onOpenトリガーを作成しても、そのスクリプト自体がbound scriptになる
わけではなく、`getUi()`は利用できない（1回目レビューでは
`installBookingAdminMenuTrigger()`によるinstallable onOpenトリガー方式を採用したが、
この理由により2回目レビューで指摘を受け撤回した。Web App本体は変更していない）。

そのため、カスタムメニュー（`BookingAdmin.gs`）と、PENDING TTL失効
（`BookingTriggers.gs`／`expirePendingBookings`）は、Web App本体（スタンドアロン。
`createBooking`/`getAvailability`専用）とは別の、`SPREADSHEET_ID`のSpreadsheetへ
コンテナバインドした専用のApps Scriptプロジェクト（Booking Admin）へデプロイする。
`confirmBooking`と`expirePendingBookings`を同一プロジェクトに置くのは、GASの
`LockService.getScriptLock()`がスクリプトプロジェクト単位でしか排他を提供しないため
であり、この2つを同一プロジェクトにまとめることで**同じLockを共有し、PENDING→CONFIRMED
とPENDING→EXPIREDが同時に進む競合を構造的に排除する**（3回目レビュー指摘対応。
当初はexpirePendingBookingsをWeb App側に置いていたが、Lock非共有によるCalendar/Sheets
不整合の可能性を指摘され、この設計に変更した）。

### セットアップ手順

1. `SPREADSHEET_ID`で指定したGoogle Spreadsheetを開く。
2. メニュー「拡張機能」→「Apps Script」を選択する（このSpreadsheetにコンテナバインドした
   新規プロジェクトが作成される）。
3. 「GASプロジェクトへのデプロイ対象ファイル」の表にある**Booking Admin列が✓の
   ファイルすべて**（`Availability.gs`を含む。実体は`gas/booking/admin/`と
   `gas/booking/shared/`の指定ファイル）をコピーする。個別のファイル名は
   上表を参照し、ここには重複して書き出さない（この手順側のリストだけを更新して
   上表の更新を忘れる、という依存ファイル追加漏れを防ぐため）。上表と
   `test/helpers/booking-deployment-manifest.js`の`BOOKING_ADMIN_FILES`/
   `BOOKING_WEB_APP_FILES`が一致していることは`test/booking-deployment-manifest-sync.test.js`
   が機械的に検証し、その配布ファイルセットで実際に既存PENDINGメール再送・PENDING TTL失効が
   ReferenceErrorなく動くことは`test/booking-admin-deployment.test.js`が検証している。
4. このプロジェクトのScript Propertiesに `CALENDAR_ID` / `SPREADSHEET_ID` /
   `PENDING_TTL_HOURS` / `PENDING_TTL_MIN_HOURS_BEFORE_START` /
   `PENDING_TTL_MIN_HOLD_HOURS`（Issue #270で追加） / `BOOKING_MAIL_DISPLAY_NAME` /
   `BOOKING_MAIL_REPLY_TO` / `BOOKING_CONTACT_EMAIL` / `ACCESS_GUIDE_*`一式
   （Issue #271で追加。「Script Properties」節参照）を設定する
   （`CALENDAR_ID`/`SPREADSHEET_ID`/`BOOKING_MAIL_*`はBooking Web App側と同じ値。
   `TIMEZONE`を既定値`Asia/Tokyo`から変更している場合はここにも同じ値を設定すること）。
5. 保存してSpreadsheetを再読み込みする。コンテナバインドスクリプトの`onOpen()`単純トリガーが
   自動的に発火し、「予約管理」メニューが表示される（installable trigger等の追加設定は
   一切不要。これがcontainer-bound scriptの標準的な挙動）。
6. 「PENDING TTL失効トリガーの作成手順」に従って、このBooking Adminプロジェクトの
   スクリプトエディタから`createExpirePendingBookingsTrigger`を実行する
   （または手動でトリガーを作成する）。前日リマインドを運用する場合は、同様に
   「前日リマインド用トリガーの作成」（Issue #271）に従って`createNextDayReminderTrigger`
   も実行する。
7. **（Issue #305以降）** スマホからの確定・キャンセル用Web UIを使う場合は、この
   Booking AdminプロジェクトをWeb Appとしてもデプロイする。手順は「Booking Admin
   Web UI（Issue #305）のセットアップ・使い方」を参照（`BookingAdminPage.html`の追加コピー・
   Execute as: Me / Only myselfでのデプロイが必要）。Web UIを使わない場合、この手順は
   スキップしてよい（Spreadsheetカスタムメニューだけで従来どおり運用できる）。

### LockServiceの共有について

`confirmBooking`・`expirePendingBookings`・`cancelBookingAdmin`（Issue #272）はいずれも
このBooking Adminプロジェクトに属し、同じ`LockService.getScriptLock()`を取得する。
そのため、いずれか1つがLockを保持している間は他の`tryLock`が失敗（`LOCK_TIMEOUT`、
または`expirePendingBookings`側は該当候補をスキップして次回トリガーへ持ち越し）し、
PENDING→CONFIRMED、PENDING→EXPIRED、PENDING/CONFIRMED→CANCELLEDが同時に進んで
Calendar/Sheetsが不整合になることはない（`test/booking-confirm-expire.test.js`・
`test/booking-cancel.test.js`のLock共有テストで検証済み）。

なお、`createBooking`（Booking Web Appプロジェクト）とこの3関数（Booking Admin
プロジェクト）は別々のプロジェクトのため、Lockは共有されない。ただし
`createBooking`は常に新しいbookingIdの行を追加するだけで既存行を書き換えないため、
`confirmBooking`/`expirePendingBookings`/`cancelBookingAdmin`（既存行の状態遷移のみを
扱う）と競合する余地はそもそもない。

## 管理メニューからの予約確定（confirmBooking）手順

1. Booking Adminプロジェクトのセットアップが完了していれば、`SPREADSHEET_ID`で
   指定したSpreadsheetを開くだけで「予約管理」メニューが自動的に表示される
   （追加のトリガー設定は不要）。
2. 確定したい予約の内容を`Bookings`シートで確認する。
3. 次のいずれかの方法で確定する。
   - **アクティブ行を確定**: `Bookings`シート上で対象の行（bookingIdの行）を選択してから、
     メニュー「予約管理」→「アクティブ行のbookingIdを確定（confirmBooking）」を実行する。
   - **bookingIdを入力して確定**: メニュー「予約管理」→「bookingIdを入力して確定
     （confirmBooking）」を実行し、ダイアログにbookingIdを入力する。
4. 結果はダイアログで表示される。成功時は`status`が`CONFIRMED`になり、`confirmedAt`が
   記録され、対応するCalendarイベントのタイトルが`[Studio X 確定]`へ更新される。
5. Booking Adminプロジェクトのスクリプトエディタから`confirmBooking("SX-...")`を
   直接実行することもできる（Issue #268本文の正式関数名）。
6. **`status`セルを直接編集して確定させる運用はしないこと。** 必ずこの手順（＝
   `confirmBooking`経由）で行う。二重実行しても壊れない（2回目は「すでに確定済みです」と
   表示されるだけで安全）。

## 管理メニューからの予約キャンセル（cancelBookingAdmin）手順（Issue #272）

1. Booking Adminプロジェクトのセットアップが完了していれば、`SPREADSHEET_ID`で
   指定したSpreadsheetを開くだけで「予約管理」メニューが自動的に表示される
   （追加のトリガー設定は不要）。
2. キャンセルしたい予約の内容を`Bookings`シートで確認する（利用者への連絡が
   必要な場合は、このタイミングで運用側の記録・利用者への通知方針を確認しておく）。
3. 次のいずれかの方法でキャンセルを実行する。
   - **アクティブ行をキャンセル**: `Bookings`シート上で対象の行（bookingIdの行）を
     選択してから、メニュー「予約管理」→「アクティブ行のbookingIdをキャンセル
     （cancelBookingAdmin）」を実行する。
   - **bookingIdを入力してキャンセル**: メニュー「予約管理」→「bookingIdを入力して
     キャンセル（cancelBookingAdmin）」を実行し、ダイアログにbookingIdを入力する。
4. **実行直前に必ずYES/NO確認ダイアログが表示される。** 「Calendarから予約枠を
   削除し、利用者へキャンセルメールを送信します。よろしいですか？」に対してNOを
   選ぶと何も変更されない（`cancelBookingAdmin`自体を呼ばない）。YESを選んで初めて
   実行される。
5. 結果はダイアログで表示される。
   - 初回成功: `キャンセルしました: <bookingId>`（`status`が`CANCELLED`になり、
     `cancelledAt`が記録され、対応するCalendarイベントが**削除**される）
   - 再実行（既にCANCELLED）: `すでにキャンセル済みです: <bookingId>`
   - Calendarイベントが既に存在しなかった場合: `キャンセルしました。Calendarイベントは
     既に存在しなかったためRecoveryへ記録しました: <bookingId>`（`Recovery`シートに
     `CANCEL_CALENDAR_EVENT_MISSING`が記録される。詳細は「部分失敗・recoveryの確認手順」参照）
   - 失敗時: エラーメッセージが表示される（`Recovery`シートを確認する）
6. Booking Adminプロジェクトのスクリプトエディタから`cancelBookingAdmin("SX-...")`を
   直接実行することもできる（Issue #272本文の正式関数名）。
7. **`status`セルを直接編集してキャンセルさせる運用はしないこと。** 必ずこの手順
   （＝`cancelBookingAdmin`経由）で行う。二重実行しても壊れない（2回目は「すでに
   キャンセル済みです」と表示されるだけで安全。Calendarを再削除したり`cancelledAt`を
   上書きしたりしない）。
8. **公開Web App（利用者向けURL）にはキャンセル機能を一切公開していない。** 利用者
   自身がキャンセルできる導線は#272の非対象であり、このメニュー（Booking Admin側）
   からのみキャンセルできる。

## PENDING TTL失効トリガーの作成手順

`expirePendingBookings`・そのトリガーは**Booking Adminプロジェクト**（`BookingTriggers.gs`。
「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」参照）に属する。
Booking Web Appプロジェクトのスクリプトエディタではない点に注意。

本PRでは本番の時間主導トリガー作成そのものは行わない（コードのみ実装）。以下の
いずれかの方法で運用開始時に設定する。

- **方法A（推奨・補助関数を使う）**: Booking Adminプロジェクトのスクリプトエディタで
  `createExpirePendingBookingsTrigger`を選択し、一度だけ実行する。`expirePendingBookings`
  を15分おきに実行するトリガーが作成される（同名トリガーが既にある場合は重複作成しない）。
- **方法B（Apps Script UIから手動作成）**: Booking Adminプロジェクトのスクリプトエディタ
  左メニューの「トリガー」→「トリガーを追加」→ 実行する関数: `expirePendingBookings` /
  イベントのソース: 時間主導型 / 時間ベースのタイマー: 分ベースのタイマー（例: 15分おき）を
  選択して保存する。

失効判定は「受付から`PENDING_TTL_HOURS`時間後」と「利用開始時刻の
`PENDING_TTL_MIN_HOURS_BEFORE_START`時間前」の早い方。ただし当日受付の予約
（受付日と利用日`date`が一致する予約）については、受付から少なくとも
`PENDING_TTL_MIN_HOLD_HOURS`時間はPENDINGを保持する下限が働く（Issue #270。
詳細は「Issue #270: 当日利用ルールと利用経験判定」の「PENDING TTLの変更内容と理由」
参照。翌日以降に受け付けた予約の判定式は#268時点から変更していない）。
失効したPENDINGはCalendarイベントを削除し、Sheets側の`status`を`EXPIRED`にして
`expiredAt`を記録する。Calendar削除に失敗した場合も`Recovery`シートへ記録した上で
Sheets側はEXPIREDへ進める（PENDINGのまま放置しない）。

## Booking Admin Web UI（Issue #305）のセットアップ・使い方

「1人で使うBooking Adminを、スマホから確定・キャンセルしやすくする最低限のUI」。
一般公開のWebアプリではなく、管理者本人専用。公開Booking Web App（利用者向け予約UI）
とは完全に別物で、公開側から本UIへのリンクも追加していない。

### セットアップ手順

1. 「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」の手順1〜6を
   先に完了させる（`.gs`ファイル一式のコピー・Script Properties設定・
   カスタムメニュー・PENDING TTL失効トリガー）。
2. Booking Adminプロジェクトのスクリプトエディタで、ファイル追加 → HTML を選択し、
   ファイル名には `BookingAdminPage`（`.html`は入力しない）と入力する。Apps Script側で
   `BookingAdminPage.html`として作成される。このリポジトリの
   `gas/booking/admin/BookingAdminPage.html`の内容をそのままコピーする。
3. 「デプロイ」→「新しいデプロイ」→種類「ウェブアプリ」を選択する。
4. デプロイ設定を以下のとおりにする（管理者本人のみアクセス可能にするため）。
   - **実行ユーザー（Execute as）**: Me（自分）
   - **アクセスできるユーザー（Who has access）**: Only myself
     （個人のGoogleアカウントでも設定できる。Google Workspace限定の設定ではない）
5. デプロイ後に発行されるWeb App URLを、自分のスマホのホーム画面等に保存しておく
   （公開サイトのどこにもリンクを置かない）。
6. コードを更新した場合は、手順3のデプロイ画面から「新しいバージョン」として
   再デプロイすること（「GASプロジェクトへのデプロイ対象ファイル」節の注記を参照。
   再デプロイを忘れるとWeb UIだけ古いコードのまま動き続ける）。

### 画面構成

1ページのみ。上部に「今日 / 今後 / キャンセル / すべて」タブ、その下に予約一覧をカード形式で
表示する（`getAdminBookings()`で全件取得し、タブの絞り込みはクライアント側で行う。個人管理
用途で件数が小規模な前提のため、専用の検索APIは作っていない。「今日」の判定は
`getAdminBookings()`が一緒に返すAsia/Tokyo基準の`todayJst`を使い、端末のtimezone設定には
依存しない）。「今日」「今後」はCANCELLEDを除外して表示し、CANCELLEDは日付を問わず
「キャンセル」タブへ集約する（EXPIREDは「キャンセル」には含めず、従来どおり「すべて」で
確認する）。「すべて」はstatus・日付を問わず全件表示する。カードから「詳細」を押すと
モーダルで全項目を表示する
（`getAdminBookingDetail(bookingId)`。メール送信失敗の詳細（内容・種別・日時）は表示せず、
「メールエラー: あり/なし」のみ表示する）。

- PENDING: 「詳細」「確定」「キャンセル」
- CONFIRMED: 「詳細」「キャンセル」
- CANCELLED / EXPIRED: 「詳細」のみ（読み取り専用）

「確定」は`adminConfirmBooking(bookingId)`（内部で既存`confirmBooking(bookingId)`を
そのまま呼ぶ）、「キャンセル」は実行前に確認ダイアログを挟んだうえで
`adminCancelBooking(bookingId)`（内部で既存`cancelBookingAdmin(bookingId)`をそのまま
呼ぶ）を実行する。いずれも処理中はボタンをdisableして二重操作を防ぎ、完了後は必ず
サーバーから一覧を再取得する（クライアント側でstatusを推測して書き換えない）。
ボタンのdisableは確定/キャンセルの処理自体が終わっただけでは解除せず、その後の一覧再取得・
再描画が完了するまで維持する（再取得中に古い一覧のまま同じ予約を再操作できてしまう隙を
なくすため）。一覧の再取得はタブ切替や確定/キャンセルのたびに都度呼ばれるため、連打等で
複数の呼び出しが重なった場合は、それぞれの呼び出しに採番したIDで「今なお最新の呼び出しか」
を確認し、後から返ってきた古い応答で新しい表示を上書きしないようにしている。

### このWeb UIでできないこと（意図的にMVP非対象）

新規予約作成・予約内容編集・statusの直接編集・EXPIREDへの手動変更・メールforce resend・
一括確定/一括キャンセル・売上集計・金額管理・支払確認・管理メモ編集は、このWeb UIからは
できない。これらが必要な場合は、従来どおりSpreadsheetカスタムメニュー（またはSpreadsheet
を直接確認すること）を使う。既存のカスタムメニューはこのIssueでも削除・変更していない。

## Booking Adminフロントエンドの外部化（Issue #317）

Issue #305時点では、Booking Admin Web UIの表示文言・カードUI・ソートUI等の
フロントエンドだけの変更でも、`gas/booking/admin/BookingAdminPage.html`に
HTML/CSS/JavaScriptを内包していたため、GAS Web Appの新バージョン再デプロイが
必要だった（例: `customerType`の表示を`first_time`→「初回利用」へ直す程度の変更でも
再デプロイが必要）。Issue #317でこれを解消し、Booking Adminのフロントエンドを
GitHub Pages側へ分離した。

**通常のフロントエンド変更はGitHub Pages側のJS/CSS更新のみで反映され、GAS Web App
再デプロイは不要。GAS側コードまたはローダー（`BookingAdminPage.html`）変更時のみ
Web App更新が必要。**

### 構成

| ファイル | 役割 | 配置先 |
| --- | --- | --- |
| `gas/booking/admin/BookingAdminPage.html` | 薄いbootstrap/loader。DOM（header/tabs/sort-select/main/list/modal-overlay等）と、外部CSS/JSを動的に読み込むインラインローダー<script>のみを持つ | Booking AdminプロジェクトへHTMLファイルとしてコピー（従来と同じ手順。「Booking Admin Web UI（Issue #305）のセットアップ・使い方」参照） |
| `admin/booking/booking-admin.css` | 見た目・レイアウト（Issue #305時点のインラインCSSをそのまま外部化） | GitHub Pagesで配信（`https://nagoya-base.github.io/Studio-nagoya-base/admin/booking/booking-admin.css`） |
| `admin/booking/booking-admin.js` | クライアント側ロジック（フィルタ・ソート・render・詳細モーダル・`google.script.run`呼び出し配線・`customerType`表示ラベル変換等。Issue #305時点のインラインJavaScriptをそのまま外部化） | GitHub Pagesで配信（`https://nagoya-base.github.io/Studio-nagoya-base/admin/booking/booking-admin.js`） |

`BookingAdminPage.html`はJekyllのビルド対象外（GAS HtmlServiceが配信する）のため、
外部CSS/JSのURLは相対パス・`{{ site.baseurl }}`ではなく絶対URL固定で参照する。

### キャッシュ対策

フロントエンド更新後に古いJS/CSSが長時間残らないよう、`BookingAdminPage.html`末尾の
インラインローダー<script>が、`<link>`/`<script>`タグを実行時に動的生成し、`src`/`href`へ
リクエストごとに変わるクエリ文字列（`?t=` + `Date.now()`）を付与してからDOM
（`document.head`/`document.body`）へ挿入する。固定の`<script src="...">`/
`<link href="...">`をHTMLに直書きしないため、キャッシュバスターの値を変えるためだけに
`BookingAdminPage.html`自体を変更する必要はない。

外部JSの読み込み・DOM操作・`google.script.run`呼び出しは、Issue #305時点から変わらず
`<body>`末尾（`</body>`直前）で行う（`<head>`側での読み込みは不可。DOM未生成／
初期化タイミングの問題のため）。

### 変更していないこと

- `BookingAdminWeb.gs`・既存の`google.script.run` 4 API（`getAdminBookings()` /
  `getAdminBookingDetail(bookingId)` / `adminConfirmBooking(bookingId)` /
  `adminCancelBooking(bookingId)`）は無変更。
- confirm/cancel/expire/reminder・Calendar・Spreadsheet・Mail・Recoveryの業務ロジックは
  無変更。Spreadsheetの列構成・Script Properties・trigger仕様も無変更。
- 管理者Web Appの本人限定アクセス（Execute as: Me / Who has access: Only myself）は維持。
- GitHub Pagesから管理APIを直接`fetch`する方式には変更していない（`google.script.run`の
  実行コンテキストはHtmlService内のままで、認証を回避する仕組みは作っていない）。
- APIキー・Script Properties・秘密値は`admin/booking/booking-admin.css`/
  `booking-admin.js`のいずれにも含めていない。

### `customerType`表示修正

一覧カード・詳細モーダルの利用区分表示を、内部値・保存値・API値は変更せず表示時のみ
以下へ変換する（`admin/booking/booking-admin.js`の`customerTypeLabel`）。

- `first_time` → `初回利用`
- `returning` → `利用経験あり`

未知の値は例外にせず、元値をそのまま表示する。

### 移行時の注意（最初の1回のみ）

この構成へ移行する最初の1回のみ、薄いローダー版`BookingAdminPage.html`を含む
GAS Web Appの新バージョン反映が必要（既存のBooking Adminプロジェクトへ、
更新後の`BookingAdminPage.html`の内容を上書きコピーし、新しいデプロイとして
再デプロイする）。以後は、通常のフロントエンド変更はGitHub Pages側
（`admin/booking/`）の更新だけで反映できる。

### テスト

`test/booking-admin-page-client.test.js`は`admin/booking/booking-admin.js`を直接
vmへ読み込んでテストする（`test/helpers/frontend-sandbox.js`と同じ、実際に配信する
ファイルそのものを実行する方針）。Issue #305時点にあった、`BookingAdminPage.html`内の
インライン`<script>...</script>`を正規表現で抽出する方式は廃止した。

## デプロイ設定（Booking Web Appプロジェクト）

Booking Adminプロジェクト（コンテナバインド）はWeb Appとしてデプロイしない
（Spreadsheetを開いたときのUI拡張として動くだけでよい）。以下はBooking Web App
プロジェクトのみに適用する設定。

- **実行ユーザー（Execute as）**: Me（自分）
- **アクセスできるユーザー（Who has access）**: Anyone（匿名を含む全員）
  - `doGet`（getAvailability）は読み取り専用のため元々匿名アクセス前提。
  - `doPost`（createBooking）は個人情報を書き込むが、Web App URLの秘匿を
    セキュリティ要件にせず、サーバー側の入力検証・rate limit・LockServiceで防御する
    方針（Issue #268本文の「Web App URLの秘匿をセキュリティ要件にしない」を踏襲）。

## セットアップ手順

1. **Booking Web App**: 新規のスタンドアロンGoogle Apps Scriptプロジェクトを作成し、
   「GASプロジェクトへのデプロイ対象ファイル」表の**Booking Web App列が✓のファイル
   すべて**（`appsscript.json`を含む。実体は`gas/booking/public/`と`gas/booking/shared/`の
   指定ファイル）をコピーする。個別のファイル名は上表を参照する。
2. Script Propertiesを設定する（最低限 `CALENDAR_ID` / `SPREADSHEET_ID`。
   利用者向けPENDINGメールを送る場合は`BOOKING_MAIL_DISPLAY_NAME` /
   `BOOKING_MAIL_REPLY_TO` / `BOOKING_CONTACT_EMAIL`もここに設定する（Issue #271）。
   `PENDING_TTL_*`/`ACCESS_GUIDE_*`はBooking Admin側の設定のためここでは不要）。
3. Webアプリとして新規デプロイし、上記の「デプロイ設定」の通りに設定する。
4. デプロイ後のWeb App URLは、本Issueでは既存フォーム・既存サイトのどこからも
   参照しない（#269以降の共通予約UI実装時に接続する）。
5. **Booking Admin**: 「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」に
   従って別途セットアップする（`CALENDAR_ID` / `SPREADSHEET_ID`をこのプロジェクトにも
   同じ値で設定することを忘れないこと。PENDING TTL失効トリガーの作成もこの手順に含まれる）。

## ロールバック方法

このPRはコード追加のみで、本番デプロイ・実Calendarへの書き込み・Spreadsheet運用開始を
一切行っていない。マージ後に問題が見つかった場合:

- **本番デプロイ前に気づいた場合**: そのままPRをrevertする、またはこのブランチのマージ
  コミットをrevertすれば元の状態（#266のgetAvailabilityのみ）に戻る。
- **Web Appを新デプロイ済みの場合**: Apps Scriptのデプロイ管理から、`doPost`を含まない
  古いバージョン（#266時点のデプロイ）へロールバックする、または新デプロイを無効化する。
  `doGet`（getAvailability）の挙動はこのIssueで変更していないため、ロールバックしても
  既存フォーム・既存の空き判定表示には影響しない。
- **Booking Adminプロジェクトを作成済みの場合**: そのプロジェクト自体を削除するか、
  対象Spreadsheetへの紐付け（コンテナバインド）を解除すれば「予約管理」メニューは
  表示されなくなる。時間主導トリガー（`expirePendingBookings`）もこのプロジェクトの
  スクリプトエディタ「トリガー」画面から削除できる（プロジェクト自体を削除すれば
  トリガーも合わせて失効する）。
- **Spreadsheet運用を開始済みの場合**: `Bookings`/`Recovery`シートはBooking Web App /
  Booking Adminの2プロジェクト以外から書き込まれないため、両方のGASデプロイ・
  スクリプトを止めれば新規の自動書き込みは止まる
  （既存の行データ自体を削除する必要はない）。
- **Issue #271（予約通知メール自動送信）分**: このPRでは実メール送信・本番Script
  Properties設定（`BOOKING_MAIL_*`/`ACCESS_GUIDE_*`）・本番トリガー作成のいずれも
  行っていないため、コードをrevertするだけで元の状態（管理者向け内部通知のみ）に戻る。
  既にScript Propertiesを設定・`createNextDayReminderTrigger`を実行済みの場合は、
  該当プロパティの削除とBooking Adminプロジェクトの「トリガー」画面から
  `sendNextDayReminders`のトリガーを削除する。
- **Issue #272（管理者キャンセル）分**: このPRでは本番Calendarイベントの削除・本番
  Spreadsheetの`status`変更・実キャンセルメール送信のいずれも行っていないため、
  コードをrevertするだけで元の状態（PENDING/CONFIRMED→CANCELLEDへの正式な手段が
  無い状態）に戻る。既にBooking Adminプロジェクトへ本PRのファイルを反映済みの場合は、
  反映前のファイル（`Booking.gs`の`ALLOWED_TRANSITIONS`にCONFIRMEDが無い版・
  `BookingAdmin.gs`にキャンセルメニューが無い版等）へ手動で戻すか、Booking Admin
  プロジェクト自体を削除する。`cancelBookingAdmin`は新しいScript Propertyを追加
  していないため、ロールバック時にプロパティの削除は不要。
- **Issue #305（Booking Admin Web UI化）分**: このPRは`BookingAdminWeb.gs`/
  `BookingAdminPage.html`の追加と`SpreadsheetRepository.gs`への読み取り専用関数追加のみで、
  既存の`confirmBooking`/`cancelBookingAdmin`/`expirePendingBookings`本体・状態遷移・
  Script Properties・Bookings列は一切変更していないため、コードをrevertするだけで
  元の状態（Spreadsheetカスタムメニューのみ）に戻る。Booking AdminプロジェクトをWeb App
  としてデプロイ済みの場合は、Apps Scriptのデプロイ管理からそのデプロイを無効化するか
  削除すればWeb UIへアクセスできなくなる（カスタムメニュー・時間主導トリガーには
  影響しない。同一プロジェクト内でも別々に管理できる）。新しいScript Propertyは
  追加していないため、ロールバック時にプロパティの削除は不要。

## 設計判断メモ（レビュー時にご確認ください）

Issue本文で「実装前に確認してほしい」とされた設計ポイントについて、今回採用した方針。
仕様変更が必要な場合はご連絡ください。

1. **Calendar成功→Sheets失敗時の補償方法**: `createBooking`はCalendarイベントの削除を試み、
   成功すれば`CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE`、削除も失敗すれば
   `SHEETS_FAILURE_CALENDAR_ORPHANED`として`Recovery`シートへ記録する
   （`BookingRepository.gs`の`handleSheetsSaveFailure_`）。同じ考え方を状態遷移にも適用し、
   `confirmBooking`（Calendar確定成功→Sheets更新失敗→CalendarをPENDINGへ補償）・
   `expirePendingBookings`（Calendar削除成功→Sheets更新失敗→次回再実行で自動的に整合を取り戻せる）
   にもrecovery記録と対応方針を用意している（レビュー指摘を受けて追加）。
2. **bookingIdをCalendarへどう保持するか**: `CalendarEvent.setTag('bookingId', ...)`/
   `setTag('status', ...)`で保持し、タイトルには`[Studio X 仮予約] <bookingId>`のように
   人が一覧で読める形でも重複して載せている（判定ロジックはタグのみを見る。タイトルは
   表示用）。氏名・メール・電話等のPIIはCalendar側に一切書き込まない。
3. **Lockの範囲**: `createBooking`は「Calendar再取得〜Sheets保存」のみをLockで保護し、
   入力検証・rate limit確認・管理者通知はLockの外。`confirmBooking`・
   `expirePendingBookings`の各候補処理もそれぞれ短時間のLockで保護している。
   `confirmBooking`と`expirePendingBookings`は同じBooking Adminプロジェクトに属し、
   同じ`LockService.getScriptLock()`を取得するため、PENDING→CONFIRMEDと
   PENDING→EXPIREDが同時に進む競合は発生しない（3回目レビュー指摘を受け、両関数を
   同一プロジェクトへ統合。詳細は「管理メニュー用GASプロジェクト（Booking Admin）の
   セットアップ」内「LockServiceの共有について」を参照）。`createBooking`
   （Booking Web Appプロジェクト）はこの2つとLockを共有しないが、常に新規行を追加する
   だけで既存行を書き換えないため、そもそも競合しない。
4. **PENDING TTLとEXPIRED状態遷移**: 「受付+24h」と「開始-2h」の早い方を失効時刻とし、
   Booking Adminプロジェクトの時間主導トリガー（`expirePendingBookings`）が候補を
   抽出→Lock取得→status再確認→Calendar削除→Sheets更新の順で処理する。
5. **rate limitの保存方式**: `CacheService`にスライディングウィンドウ（タイムスタンプ配列の
   JSON）を保存する方式を採用。PropertiesServiceより高頻度カウンタ用途に向いている一方、
   CacheServiceの性質上、複数インスタンス間で常に完全同期しているとは限らない
   「概ね閾値を超えたら拒否する」ゆるい防御として位置づけている。
6. **SpreadsheetカスタムメニューからのbookingId指定方法・実運用方式**: 「アクティブ行を確定」
   （選択中の行のA列=bookingIdを読む）と「bookingIdを入力して確定」（プロンプト入力）の
   2通りを用意した。カスタムメニュー（`SpreadsheetApp.getUi()`）はGoogleの仕様上
   コンテナバインドスクリプトからしか作成できないため、`BookingAdmin.gs`は`SPREADSHEET_ID`
   のSpreadsheetへコンテナバインドした別プロジェクト（Booking Admin）へデプロイする方式を
   正式手順とした。1回目レビューでは、スタンドアロンのWeb Appプロジェクトから
   installable onOpenトリガーを作成する方式（`installBookingAdminMenuTrigger()`）を
   採用したが、installable triggerを作ってもスクリプト自体がbound scriptにはならず
   `getUi()`は使えないという2回目レビューの指摘を受けて撤回し、コンテナバインド
   プロジェクトへの分離に設計変更した（詳細は「管理メニュー用GASプロジェクト
   （Booking Admin）のセットアップ」を参照）。
7. **createBooking APIのPOST方式**: `doPost`を新設し、`e.postData.contents`をJSONとして
   パースする。GETクエリパラメータでは個人情報を送らせない。
8. **doGet/getAvailabilityとdoPost/createBookingの共存**: 同一`Code.gs`内で`doGet`
   （#266のまま変更なし）と`doPost`（#268で追加）を分離して定義しており、GAS Web Appは
   同一デプロイでこの両方を配信できる。

### PRレビュー（1回目）指摘への追加対応

1回目のレビューで以下4点の指摘を受け、対応した。

- **開始時刻の15分刻みをcreateBookingでも必須化**: `Booking.validateCreateBookingInput`に
  `START_TIME_NOT_ALIGNED`判定を追加（例: `10:07`は拒否、`10:00`/`10:15`/`10:30`/`10:45`は許可）。
- **Availability設定全体のfail-closed検証をcreateBookingにも適用**: `BookingAvailability.validateInput`
  （getAvailabilityと同じ設定検証）を`createBooking`の入力検証冒頭で呼び出し、
  `BUFFER_MINUTES`等の誤設定時にNaNのまま競合判定へ進んで既存予約の見落としが起きないようにした。
- **Spreadsheetカスタムメニューの実運用方式を明確化**: `installBookingAdminMenuTrigger()`を追加した
  （※この対応は2回目レビューで撤回・再設計。下記参照）。
- **confirmBooking/expirePendingBookingsの部分失敗もrecoveryへ記録**: 上記1.のとおり両関数に
  補償・recovery記録を追加した。

### PRレビュー（2回目）指摘への追加対応

2回目のレビューで、1回目の管理メニュー対応（`installBookingAdminMenuTrigger()`による
installable onOpenトリガー方式）が「Googleの仕様上、カスタムメニューを作成できるのは
bound scriptのみであり、installable triggerを作ってもstandalone scriptがbound script
になるわけではない」という理由で不成立である、との指摘を受けた。指摘の通りであるため、
以下のとおり設計を変更した。

- `installBookingAdminMenuTrigger()`を`BookingAdmin.gs`から削除し、関連するテスト
  （`test/booking-confirm-expire.test.js`のinstallable trigger作成/重複防止テスト）・
  README記述（旧「管理メニューのセットアップ（installable onOpenトリガー）」節）も削除した。
- `BookingAdmin.gs`（カスタムメニュー・`confirmBooking`）を、Web App本体
  （スタンドアロンのまま維持）とは別の、`SPREADSHEET_ID`のSpreadsheetへコンテナバインドした
  専用プロジェクト（Booking Admin）へデプロイする設計に変更した。単純トリガーの`onOpen()`は
  そのままで、コンテナバインドスクリプトとしてデプロイすれば追加設定なしで機能する。
  ファイル構成・セットアップ手順・confirmBooking実行方法は「GASプロジェクトへの
  デプロイ対象ファイル」「管理メニュー用GASプロジェクト（Booking Admin）のセットアップ」
  「管理メニューからの予約確定（confirmBooking）手順」の各節に明記した。
- 副作用として、`confirmBooking`（Booking Adminプロジェクト）と`expirePendingBookings`
  （当時はBooking Web Appプロジェクトに配置）が別プロジェクトになったことで、LockService
  による相互排他が効かなくなる点を認識し、「既知の制約」として文書化した上で、Calendarを
  実際に変更する直前にもう一度statusを再確認する緩和策（`CONFLICTING_STATUS_CHANGE`）を
  `confirmBooking`に追加した（`test/booking-confirm-expire.test.js`で検証）。
  **この「既知の制約」自体は3回目レビューでさらに指摘を受け、根本解消した（下記参照）。**

### PRレビュー（3回目）指摘への追加対応

2回目レビューで対応した「confirmBookingとexpirePendingBookingsが別プロジェクトになり
LockServiceを共有できない」という既知の制約について、3回目のレビューで
「status再確認を追加しても“再確認→Calendar変更→Sheets更新”の間に別プロジェクト側が
同じbookingIdを処理できるため、confirmとexpireの同時実行でCalendar/Sheets不整合が
起こり得る。この競合は既知の制約として残さず#268内で解消してほしい」との指摘を受けた。
指摘の通り、再確認による緩和では競合windowを狭めるだけで根本解決にはならないため、
以下のとおり設計を変更した。

- `expirePendingBookings`とそのトリガー（`BookingTriggers.gs`）を、Booking Web App
  プロジェクトからBooking Adminプロジェクトへ移した。これにより`confirmBooking`と
  `expirePendingBookings`が同一Apps Scriptプロジェクトに属し、同じ
  `LockService.getScriptLock()`を共有するようになり、PENDING→CONFIRMEDと
  PENDING→EXPIREDが同時に進む競合が構造的に発生しなくなった。
- 上記により不要になった`confirmBooking`内のCalendar変更直前のstatus再確認
  （`CONFLICTING_STATUS_CHANGE`）を削除し、2回目レビュー以前のシンプルな実装に戻した
  （同一Lockで直列化されるため、この緩和策はもはや意味を持たないため）。
- Booking Web Appプロジェクトの役割を`getAvailability`・`createBooking`・管理者通知の
  みに整理し、Booking Adminプロジェクトの役割にカスタムメニュー・`confirmBooking`・
  `expirePendingBookings`（TTL失効トリガー含む）をまとめた。
- README「GASプロジェクトへのデプロイ対象ファイル」「管理メニュー用GASプロジェクト
  （Booking Admin）のセットアップ」「Script Properties」「PENDING TTL失効トリガーの
  作成手順」の各節を更新し、旧「既知の制約」節は「LockServiceの共有について」（両者が
  同じLockを共有し安全に直列化される旨の説明）に置き換えた。
- `test/booking-confirm-expire.test.js`の`CONFLICTING_STATUS_CHANGE`テストを、
  「同一LockServiceを共有するため片方がLock保持中はもう片方がLOCK_TIMEOUT/スキップに
  なる」ことを検証するテストに置き換えた。

## テスト結果について

このREADME・PRに記載する「node --testが全件pass」は、**ローカルで`node --test`を実行した
結果**であり、GitHub Actions等のCIが本リポジトリに設定されている、またはそのCIが通過した
ことを意味しない（本リポジトリには現時点でCIが登録されていない）。実Calendar・実Spreadsheet・
実デプロイへの検証はいずれも「デプロイ後の手動確認」節に委ねている。

## テストの実行

```
node --test
```

**Issue #341 PR-C以降の注意**: リポジトリ直下の`node --test`は再帰的にテストファイルを
探索するため、`cloud-run/stripe-webhook-relay/test/`配下のテスト（Stripe公式`stripe`
パッケージに依存）も自動的に対象になる。このリポジトリ本体（ルートの`package.json`）は
「依存パッケージなし」の方針だが、`cloud-run/stripe-webhook-relay/`はStripeの署名検証
（`stripe.webhooks.constructEvent`）のために`stripe`パッケージに依存する**別プロジェクト**
（独立した`package.json`）である。初回・依存更新後は先に
`cd cloud-run/stripe-webhook-relay && npm install`を実行しておくこと
（`node_modules`が無い状態でルートの`node --test`を実行すると、このディレクトリの
テストだけが`MODULE_NOT_FOUND`で失敗する）。

Issue #266関連（変更なし）:

- `test/booking-availability.test.js` — `Availability.gs` の空き判定ロジック
- `test/booking-calendar-repository.test.js` — `CalendarRepository.gs` の読み取り部分
- `test/booking-config.test.js` — `Config.gs` のデフォルト値・Script Properties上書き
- `test/booking-code-runtime.test.js` — `doGet`配線全体の検証（`doPost`が追加されている
  ことの確認も含む）

Issue #268で追加:

- `test/booking-model.test.js` — `Booking.gs`（入力検証・15分刻み判定・Availability設定の
  fail-closed検証・bookingId発行・状態遷移・TTL計算）
- `test/booking-rate-limiter.test.js` — `RateLimiter.gs`（同一メール/全体/連投のスライディング
  ウィンドウ制限）
- `test/booking-spreadsheet-repository.test.js` — `SpreadsheetRepository.gs` /
  `RecoveryRepository.gs`（台帳read/write・recovery記録）
- `test/booking-create-booking.test.js` — `BookingRepository.createBooking`の統合テスト
  （正常系・15分刻み拒否・設定fail-closed拒否・#267境界の競合検出・LockService・rate limit・
  部分失敗補償・管理者通知失敗など）
- `test/booking-confirm-expire.test.js` — `confirmBooking`/`expirePendingBookings`の
  統合テスト（状態遷移・TTL・二重実行・部分失敗補償/recovery記録・障害分離・両関数が
  同一LockServiceを共有し直列化されることの検証・container-boundスクリプトのonOpen
  単純トリガーによる管理メニューの配線）

Issue #269で追加・更新:

- `test/booking-model.test.js`（更新） — snb/mens/studio_xの3ブランドすべてを許可し、
  未知のbrandは引き続き`INVALID_BRAND`になること、brand別bookingId prefix
  （`SNB-`/`MENS-`/`SX-`）、`Booking.getBrandLabel`の表示名を追加検証
- `test/booking-create-booking.test.js`（更新） — 3ブランドすべてでcreateBooking成功・
  PENDING作成・Sheetsのbrand列保存・Calendarのbrandタグ保存・bookingId prefix・
  Calendarタイトルへのブランド表示名反映・管理者通知件名へのブランド表示名反映・
  未知brandの拒否・**SNB/mens/Studio Xは同一Calendarのため、いずれかのブランドで
  作った予約が他の2ブランドから見てSLOT_CONFLICTになること**（6パターン総当たり）を追加
- `test/booking-logic.test.js`（新規） — 共通予約UIのDOM非依存ロジック
  （`scripts/booking-logic.js`）。ブランド別表示名・error.code→日本語メッセージ変換・
  エラー種別ごとの回復導線（時間の選び直し/入力の修正/再試行）振り分け・入力検証・
  createBookingペイロード組み立て・JST「明日」計算
- `test/helpers/frontend-sandbox.js`（新規） — `test/helpers/gas-sandbox.js`と同じ方針で
  `scripts/`配下のDOM非依存JSをvm実行するテストヘルパー

Issue #270で追加・更新:

- `test/booking-model.test.js`（更新） — `customerType`の必須検証（未指定・未知の値は
  `INVALID_CUSTOMER_TYPE`）、過去日の拒否（`INVALID_DATE`）、当日+初回利用の拒否
  （`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`）、当日+利用経験ありの許可、翌日以降は
  両方許可、snb/mens/studio_xで同じ挙動になること、`Booking.formatDateInTimezone`の
  タイムゾーン変換・不正timezoneのfail-closedを追加。**レビュー対応で追加**:
  当日+利用経験ありで開始時刻が現在時刻以前（ちょうど含む）は
  `SAME_DAY_START_TIME_PASSED`で拒否、現在時刻より後なら許可、当日+初回利用は
  過去開始時刻でも`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`が優先、翌日以降は
  過去開始時刻判定を行わないこと、snb/mens/studio_xで同じ挙動になること。
  `computeTtlExpiryMillis`/`isExpired`の`minHoldHours`引数をレビュー指摘の
  最低限のTTLテスト（09:00受付/09:30・10:30・11:30・12:00開始、翌日、ttlHours=1、
  当日直前予約すべてで`expiry<=startAt`かつ`expiry>createdAt`）に置き換え
- `test/booking-availability.test.js`（更新） — `computeBookableStartTimes`の
  `minimumStartMinutes`引数、`getAvailability`が当日は現在時刻以前（ちょうど含む）の
  候補を除外し翌日以降は従来どおり全候補を返すこと、`now`省略時のデフォルト、
  `getAvailability`の応答にcustomerType関連キーが一切含まれないこと、
  `getCurrentMinutesInTimezone`/`formatDateInTimezone`の不正timezoneのfail-closedを追加
  （Issue #270レビュー対応）。**2回目レビュー対応で追加**: `getAvailability`が
  過去日（`date < today`）を`INVALID_DATE`（`過去の日付は指定できません。`）で
  拒否すること
- `test/booking-code-runtime.test.js`（更新） — doGetの配線が当日フィルタ追加後も
  壊れていないこと（実行時の現在日付と一致しない固定日付では従来どおり全候補が
  返ること）を追加。**2回目レビュー対応で追加**: doGetに過去日を指定すると
  `INVALID_DATE`を返し`bookableStartTimes`を含まないこと、かつCalendarへ
  問い合わせる前に拒否すること（`handleGetAvailability_`のCalendar呼び出し前チェック）
- `test/booking-config.test.js`（更新） — `getTtlConfig()`の既定値
  （`minHoldHours`/`timezone`を含む）、`PENDING_TTL_MIN_HOLD_HOURS`の
  Script Properties上書き・誤設定時のフォールバックを追加
- `test/booking-create-booking.test.js`（更新） — `createBooking`が受け取る`now`引数を
  使い、当日+初回利用の拒否（Calendar/Sheetsに何も作らずbookingIdも返さないことを含む）・
  当日+利用経験ありのPENDING作成成功（Sheetsの`customerType`列保存を含む）・
  翌日以降は両方成功・snb/mens/studio_xで同じ挙動になること・`customerType`未指定/
  不正値の拒否・過去日の拒否を追加。**レビュー対応で追加**: 当日+利用経験ありで
  開始時刻が現在時刻以前はAPI直呼びでも`SAME_DAY_START_TIME_PASSED`で拒否し
  Calendar/Sheetsに何も作らないこと、現在時刻より後なら成功すること、当日+初回利用は
  過去開始時刻でも優先順位どおり`SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`が返ること、
  snb/mens/studio_xで同じ挙動になること
- `test/booking-confirm-expire.test.js`（更新） — 当日受付・開始2時間未満の予約が
  作成直後の`expirePendingBookings`実行で即EXPIREDにならないこと、受付日と利用日が
  一致しない（＝当日受付でない）予約は対象外のまま#268時点と同じTTL計算になることを
  追加（`BookingTriggers.gs`のグローバル関数`expirePendingBookings(now)`が受付時刻を
  受け取れるようにした変更に対応）。**レビュー対応で更新**: 「minHoldHoursを過ぎれば
  EXPIREDになる」テストを「利用開始時刻の1分前はまだPENDING・1分後にはEXPIREDになる」
  テストに置き換え、当日PENDINGが利用開始後まで残らないことを直接検証
- `test/booking-logic.test.js`（更新） — 利用区分の内部値（`isAllowedCustomerType`/
  `customerTypeLabel`）、当日+初回利用の検出（`isSameDayFirstTimeBlocked`）、新規
  error.codeの日本語メッセージ・回復導線（`reselect-date`/`reselect-time`）、
  `buildCreateBookingPayload`への`customerType`追加を追加

Issue #271で追加・更新:

- `test/booking-mail-templates.test.js`（新規） — `BookingMailTemplates.gs`の純粋関数
  （件名・本文生成）。PENDING/CONFIRMEDに「未確定」/「確定」の明記・解錠コード/
  キーボックス番号を含まないこと、**CONFIRMEDに利用上の基本注意（原状回復の案内）が
  含まれること**、CANCELLEDの必須内容、REMINDERの来場案内一式（**入室方法を含む**）・
  ダミー秘密値の表示・秘密値未設定時のプレースホルダ、snb/mens/studio_xで表示名のみ
  変わることを検証
- `test/booking-mailer.test.js`（新規） — `BookingMailer.gs`の送信制御。PENDING/
  CONFIRMED/CANCELLED/REMINDERそれぞれについて、正常送信・SentAt記録・二重送信防止・
  status不一致時の拒否・MailApp失敗時の予約状態維持とlastMailError*/Recovery記録・
  設定不足のfail-closed拒否・force resend（SentAtありでも送信・status不一致は無視
  しない）・LockServiceの取得/解放を検証。**PRレビュー対応で追加**:
  `config.timezone`が実際にテンプレートへ渡り、JST 10:00の予約が本文でも10:00に
  なること・`TIMEZONE`をUTC等へ変更すると表示も追従すること・`TIMEZONE`が不正な
  文字列の場合はMailAppを呼ばずfail-closedに失敗すること、来場案内の必須項目
  （住所/建物/部屋/入口案内/キーボックス位置/入室方法/URL/キーボックス番号/解錠コード）
  が1項目ずつ欠けても送信しないこと、`ACCESS_GUIDE_PDF_URL`のみ任意で欠けても送信
  できること、メール送信失敗時に`RecoveryRepository`の`status`へメール種別
  （例: `REMINDER`）ではなく予約の現在status（例: `CONFIRMED`）が記録されることを検証。
  **PRレビュー対応（2回目）で追加**: MailApp例外にメールアドレスが含まれても
  `lastMailErrorMessage`/`Recovery.errorMessage`が`[REDACTED_EMAIL]`へ置換される
  こと、REMINDER失敗時に解錠コード/キーボックス番号の実値が例外文言に混入しても
  `[REDACTED]`へ置換されること、`BookingMailer.sanitizeErrorMessage`が公開関数として
  再利用できること
- `test/booking-reminders.test.js`（新規） — `BookingReminderTriggers.gs`。JST基準で
  翌日のCONFIRMED予約だけを抽出すること、PENDING/CANCELLED/EXPIREDは対象外、
  reminderSentAt/accessGuideSentAt済みはskip、1件の失敗（設定不足・MailApp例外）が
  他の予約の送信を妨げないこと（バッチ内の障害分離）、`createNextDayReminderTrigger`の
  トリガー二重作成防止を検証。**PRレビュー対応（2回目）で追加**: MailApp例外に
  利用者メールアドレスが含まれても、Loggerには`bookingId`と`error.code`のみが
  残り、メールアドレス・キーボックス番号・解錠コード・メール本文が残らないこと、
  `BookingMailer`側で想定外の例外が発生した場合もLoggerへ生のメールアドレスを
  残さないことを検証
- `test/booking-create-booking.test.js`・`test/booking-confirm-expire.test.js`
  （更新。**PRレビュー対応（2回目）で追加**） — `notifyCustomerPendingBestEffort_`/
  `notifyCustomerConfirmedBestEffort_`（`BookingRepository.gs`）でBookingMailerが
  想定外の例外を投げても、Loggerへ生のメールアドレスを残さないことを検証
- `test/booking-config.test.js`（更新。**PRレビュー対応で追加**） — `getMailConfig()`が
  `timezone`を含み既定値`Asia/Tokyo`になること、`TIMEZONE`上書きが
  `getAvailabilityConfig`/`getTtlConfig`と同じ値でmail configにも反映されること、
  `getAccessGuideConfig()`に`entryMethod`（`ACCESS_GUIDE_ENTRY_METHOD`）を含む
  全項目が正しく読めることを追加
- `test/booking-create-booking.test.js`（更新） — `createBooking`がbooking Lock解除後に
  利用者向けPENDINGメールをbest effortで送ること、メール設定不足時も`createBooking`は
  成功しlastMailError*が記録されること、管理者通知とPENDINGメールの両方が失敗しても
  `createBooking`は成功しRecoveryへ両方の`failureType`（`ADMIN_NOTIFICATION_FAILED`/
  `MAIL_PENDING_FAILED`）が記録されることを追加
- `test/booking-confirm-expire.test.js`（更新） — `FILES`へ`BookingMailTemplates.gs`/
  `BookingMailer.gs`/`BookingReminderTriggers.gs`を追加し、`confirmBooking`が
  利用者向けメールを試行するようになった後も既存の状態遷移・部分失敗補償・recovery件数の
  検証が壊れないよう、既定のScript Propertiesへ完全なメール設定値を追加（メール自体の
  挙動検証は`test/booking-mailer.test.js`に委ねる）
- `test/helpers/gas-stubs.js`（更新） — `MailApp.sendEmail`をオブジェクト引数形式
  （`{to, subject, body, name, replyTo}`）にも対応させ、`ScriptApp`の時間主導トリガー
  builderへ`everyDays`/`atHour`/`nearMinute`を追加（前日リマインドトリガー用）

Issue #272で追加・更新:

- `test/booking-cancel.test.js`（新規・PRレビュー対応で追加検証） — `cancelBookingAdmin`の
  統合テスト。状態遷移（PENDING/CONFIRMED→CANCELLED成功、EXPIREDからの拒否、
  `Booking.canTransition`がCONFIRMED→CANCELLEDを許可すること）、正常キャンセル
  （Calendar削除・Sheets CANCELLED・`cancelledAt`/`updatedAt`が同一書き込みで同じDate値に
  なること・同時間枠が`getAvailability`で再度空くこと・同時間での新規`createBooking`成功・
  キャンセルメール1通・`cancelMailSentAt`）、二重実行時の冪等性（Calendar再削除なし・
  `cancelledAt`上書きなし・メール二重送信なし）、キャンセルメール送信失敗時も
  `success:true`を維持し再実行でメールだけ再試行できること、Calendarイベントが既に
  存在しない場合の収束（`CANCEL_CALENDAR_EVENT_MISSING`・`calendarAlreadyMissing`）、
  **Calendar読み取り自体が例外を投げた場合**（`getEventById`が例外→
  `CANCEL_CALENDAR_LOOKUP_FAILED`。Sheets/Calendar/メールいずれも変更しないこと）、
  Calendar削除失敗時のrecovery記録、**Calendar削除成功→Sheets更新失敗
  （`updateBookingCancellationStateAtomic`自体の失敗）時にstatus/cancelledAt/updatedAtが
  いずれも書き込み前のまま残ること（ケースA）、障害解消後の再実行でCalendar既に無い経路から
  status/cancelledAt/updatedAtが収束しキャンセルメールも送信されること（ケースB）**、
  **（PRレビュー2回目対応で追加）キャンセルのSpreadsheet書き込みがstatus〜updatedAt
  （13〜20列目）の8列だけに限定され、事前に設定した`pendingMailSentAt`/`customerType`
  （21列目以降）が書き換わらないこと・書き込み先rangeの`col`/`numCols`が13/8であること**、
  Sheets行が無い場合のCalendar診断（0/1/複数件それぞれの`failureType`と自動削除しない
  こと）、**Sheets行なし診断中にCalendar走査自体が例外を投げた場合**
  （`findBookingEventsByBookingId`が例外→`CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED`・
  `error.code: 'CANCEL_DIAGNOSTIC_FAILED'`）、bookingId形式不正時の扱い、
  `confirmBooking`/`expirePendingBookings`とのLock共有・競合規則（cancel→confirmは
  INVALID_TRANSITION、expire→cancelはINVALID_TRANSITION、confirm→cancelは成功）、
  CANCELLED後は`sendNextDayReminders`がリマインドを送らないこと、Spreadsheet管理メニューの
  キャンセル導線（メニュー2項目・YES/NO確認・アクティブ行/prompt入力の両方）、
  snb/mens/studio_xの3ブランドで同一挙動になることを検証
- `test/booking-confirm-expire.test.js`（更新） — `Booking.gs`の`ALLOWED_TRANSITIONS`
  変更（CONFIRMEDを終端から除外）後も、既存のconfirm/expireの状態遷移・部分失敗補償・
  recovery件数の検証が壊れていないことを確認（既存テスト自体の変更は無し。
  `node --test`全件で回帰が無いことを担保）
- `test/booking-spreadsheet-repository.test.js`（更新。PRレビュー対応で追加・2回目対応で
  更新） — `SpreadsheetRepository.updateBookingCancellationStateAtomic`の単体テスト。
  status/cancelledAt/updatedAtの3列だけを1回の書き込みで更新し、範囲内の他フィールド
  （`calendarEventId`等）・mail SentAt列・`customerType`が変化しないこと、書き込み先
  rangeが`col: 13, numCols: 8`であることを`_setValuesCalls`で直接assert、存在しない
  bookingId/許可されていないフィールド名（mail列等）で例外を投げること、例外時は行自体を
  書き換えないこと（範囲書き込み前にフィールド名を検証するため）を検証
- `test/helpers/gas-stubs.js`（更新） — `SpreadsheetApp.getUi()`スタブの
  `alert(message, buttonSet)`2引数形式を追加し、`options.alertResponses`から
  `Button.YES`/`Button.NO`を順番に返せるようにした（キャンセル誤操作防止の
  YES/NO確認ダイアログ用）。既存の1引数`alert(message)`呼び出しは影響を受けない
  （`Button`に`YES`/`NO`、`ButtonSet`に`YES_NO`を追加。既存の`OK`/`CANCEL`/`OK_CANCEL`は変更なし）。
  **PRレビュー2回目対応で追加**: シートスタブに`_setValuesCalls`（`{row, col, numRows,
  numCols}`の呼び出し履歴）を追加し、`updateBookingCancellationStateAtomic`の書き込み
  range自体をテストからassertできるようにした（既存の`setValues`の挙動には影響しない）

Issue #273で追加（`Availability.gs`がBooking Admin配布ファイル一覧から漏れていた
不具合の修正）:

- `test/helpers/booking-deployment-manifest.js`（新規） — README.mdの「GASプロジェクトへの
  デプロイ対象ファイル」表と同期させる、Booking Admin / Booking Web Appそれぞれの実際の
  配布ファイル名一覧（`BOOKING_ADMIN_FILES`/`BOOKING_WEB_APP_FILES`）。テスト専用（GASへは
  配布しない）
- `test/booking-admin-deployment.test.js`（新規） — `BOOKING_ADMIN_FILES`（`Availability.gs`
  を含む、上表のBooking Admin列が✓の全ファイル）だけをvmへ読み込み、本番のBooking Admin
  プロジェクトと同じ実行セットで、(1) `BookingAdmin.gs`の「予約メールを再送」メニュー経由の
  PENDINGメール再送、(2) 時間主導トリガーの`expirePendingBookings`によるPENDING TTL失効の
  両方がReferenceErrorなく成功することを検証する。`Availability.gs`を一覧から意図的に
  除くとこの2つがいずれも`ReferenceError: BookingAvailability is not defined`で失敗する
  ことを確認済み（回帰テストとして機能することの確認）
- `test/booking-deployment-manifest-sync.test.js`（新規・PRレビュー対応で追加） —
  README.mdの「GASプロジェクトへのデプロイ対象ファイル」表をパースし、Booking Admin列/
  Booking Web App列がそれぞれ✓の`.gs`ファイル集合が`BOOKING_ADMIN_FILES`/
  `BOOKING_WEB_APP_FILES`と一致することを検証する。表とmanifestを「同期させる」という
  人手ルールだけでは、今回のように片方だけの更新漏れ（表側からの`Availability.gs`漏れ）を
  検出できないため、このテストで両者のドリフトを機械的に検出する。`appsscript.json`は
  `.gs`ファイルではなくmanifest側も`.gs`専用のため、比較対象から明示的に除外する。
  表側・manifest側それぞれを個別に改変し、両方向のドリフトで実際にこのテストが失敗する
  ことを確認済み

Issue #305（Booking Admin Web UI化）で追加:

- `test/booking-admin-web.test.js`（新規） — `BookingAdminWeb.gs`の統合テスト。
  `adminConfirmBooking`/`adminCancelBooking`が実際に既存`confirmBooking`/
  `cancelBookingAdmin`（Calendar/Sheets/Lockを含む本物の処理）を実行し、独自の状態遷移
  ロジックを持たないこと、`getAdminBookings()`が`{ todayJst, bookings }`を返し
  一覧の各要素が最小フィールドのみで`email`/`phone`/`note`等のPIIを含まないこと、
  `getAdminBookingDetail(bookingId)`が詳細フィールド一式を返すこと・存在しない
  bookingIdで`NOT_FOUND`を返すことを検証。**PRレビュー対応で追加**:
  `getAdminBookings`/`getAdminBookingDetail`の`date`/`startAt`/`endAt`・各SentAt系
  フィールドがDateオブジェクトではなく正規化された文字列で返ること（`date`が
  Spreadsheet側の挙動でDate値として保存されているケースを含む）、`todayJst`が
  Asia/Tokyo基準で計算されること、メール送信に失敗した場合は`hasMailError:true`になり
  `lastMailErrorAt`/`lastMailErrorType`/`lastMailErrorMessage`の詳細はレスポンスに
  含まれないことを検証。**再レビュー対応で追加**: `loadBookings()`の応答が
  `loadRequestSeq`比較で古いと判定されstateへの反映をスキップした場合でも、
  呼び出し元へ渡された`onDone`コールバック（busy解除用）は必ず実行されること
  （BookingAdminPage.html側の修正。連続してconfirm/cancelを実行した際に一部の
  bookingIdのボタンが解除されないまま残る不具合の修正）
- `test/helpers/booking-deployment-manifest.js`（更新） — `BOOKING_ADMIN_FILES`へ
  `BookingAdminWeb.gs`を追加（`test/booking-admin-deployment.test.js`/
  `test/booking-deployment-manifest-sync.test.js`が引き続き通ることで、本番Booking
  Adminへの配布ファイルセットとして矛盾がないことを機械的に確認している）

Issue #318で追加・更新:

- `test/booking-calendar-repository.test.js`（更新） — `CalendarRepository.gs`の
  `getBusyIntervalsForRange`（対象月全体でgetEvents()呼び出しが1回だけであること・
  区間内の全日付ぶんのキーを返すこと・日をまたぐイベントのクランプ・終日イベントの
  扱い・存在しないCalendar IDでの例外）を追加
- `test/booking-monthly-availability.test.js`（新規） — `Availability.gs`の
  `getMonthlyAvailability`/`DAY_STATUS`。閾値どおりのステータス分類（FULL/LIMITED/
  AVAILABLE/AVAILABLE_HIGH）・過去日のOUT_OF_RANGE・当日のminimumStartMinutes適用・
  28/29/30/31日の月・年またぎ（12月→1月）・不正な年月/duration/configの拒否・
  応答にPIIを含めないこと・単日`getAvailability`との判定一致を検証
- `test/booking-code-runtime.test.js`（更新） — `doGet`の`action=monthly`配線
  （`handleGetMonthlyAvailability_`）。calendar.getEvents()呼び出しが月内で1回だけ
  であること・バリデーションエラー時にCalendarへ問い合わせないこと・JSON出力を追加
- `test/booking-logic.test.js`（更新） — カレンダー用の純粋ロジック
  （`isBookableDayStatus`/`dayStatusSymbol`/`dayStatusLabel`/`isCalendarDaySelectable`
  （初回利用＋当日のガード再現を含む）/`dayAriaLabel`/`monthLabel`/
  `formatCalendarDayLabel`/`buildMonthMatrix`（月初の曜日位置・28〜31日の月・
  5〜6週の範囲）/`shiftMonth`（年またぎ）/`yearMonthFromDateValue`/
  `weekdayColumnClass`）を追加
- `test/booking-calendar-ui.test.js`（新規） — `scripts/booking-app.js`の
  カレンダーDOM配線。duration/利用区分が両方確定するまでfetchしないこと・
  `action=monthly`へのリクエストが1回であること・グリッド描画と日付選択の
  `#ba-date`への反映・初回利用＋当日のセルが選択不可になること（利用経験ありへの
  切り替えは再取得なしで選択可能になること）・取得失敗時にグリッドを描画せず
  エラー表示のみにすること（fail-open禁止）・前月/翌月ボタンでの再取得とキャッシュ・
  duration変更時の再取得・カレンダー選択後に既存のStep1「次へ」→Step2の開始時刻
  取得フローへ接続できることを検証

Issue #324で追加・更新:

- `test/booking-monthly-availability.test.js`（更新） — 希望時間帯フィルタ
  （`timeBand`）。`all`が現在の月間判定（timeBand未指定）と完全に一致すること・
  timeBand未指定/不正値のallフォールバック・morning/daytime/eveningそれぞれの
  絞り込み・境界値（11:45/12:00開始、17:45/18:00開始）・maxPossible（分母）も
  同じtimeBandで絞られること・長時間利用でband内候補が0件の場合のFULL・当日かつ
  選択中の時間帯が過ぎている場合のFULL・`filterStartTimesByTimeBand`/
  `normalizeTimeBand`の単体動作を追加
- `test/booking-code-runtime.test.js`（更新） — `doGet`の`action=monthly`が
  `timeBand`クエリパラメータを`getMonthlyAvailability`へ配線すること・timeBand
  未指定/不正値のallフォールバックを追加
- `test/booking-logic.test.js`（更新） — `normalizeTimeBand`（allへのフォールバック）・
  `timeBandLabel`（ja/en）・`filterStartTimesByTimeBand`（境界値・all後方互換・
  未指定/不正値のフォールバック）を追加
- `test/booking-calendar-ui.test.js`（更新） — 既定timeBand(all)がURLへ含まれること・
  timeBand変更時に表示中の月だけを再取得すること・cache keyがtimeBand別になること・
  timeBand変更後に選択済み日付がFULLになれば選択解除されること・duration/利用区分
  未確定時はtimeBand変更でもfetchしないこと・再読み込みボタンが現在のtimeBandの
  キャッシュを削除して再取得することを追加
- `test/booking-app.test.js`（更新） — Step1で選んだtimeBandがStep2の開始時刻一覧の
  絞り込みに反映されること・timeBand未選択時はallとして全開始時刻が表示されること
  （後方互換）・該当候補が無い場合は既存の「開始時刻がありません」表示になることを追加

CalendarApp / PropertiesService / Utilities / ContentService / LockService /
CacheService / SpreadsheetApp / MailApp / ScriptApp はいずれもテスト用スタブに
差し替えており、実際のGoogle Calendar・Spreadsheet・Script Propertiesにはアクセスしない
（`test/helpers/gas-stubs.js`）。実Calendarへ直接書き込むテストは、通常の自動テストとして
実装していない（Issue #268本文の要件どおり）。

共通予約UIのDOM配線（`scripts/booking-app.js`）は、大部分がnode --testの対象外で
Playwright（Chromium）を使ったローカルブラウザでの手動確認で検証している
（3ブランドとも375px幅で横スクロールなし・ステップ遷移・`getAvailability`/
`createBooking`のモック応答に対するSLOT_CONFLICT/RATE_LIMITED/INTERNAL_ERROR等の
表示・二重送信防止・成功後の再送信不可を確認済み。実Calendar/Spreadsheetへは
アクセスしていない）。Issue #318のカレンダー配線のみ、素朴なDOMスタブ
（`test/booking-calendar-ui.test.js`）でnode --testからも検証できるようにした
うえで、上記と同じ方針でPlaywright（日本語/英語・モバイル幅375px/デスクトップ幅・
初回利用＋当日のセル無効化・duration変更・月移動・選択日のStep2への接続）でも
実ブラウザ表示を確認済み。

## デプロイ後の手動確認（実Calendar・実Spreadsheet・実デプロイが前提のため、コードレビュー時点では確認不能）

- [ ] Web Appが「Anyone」設定で、ログインなしでも`doGet`/`doPost`ができること
- [ ] `doPost`で送信した予約が、実際にCalendarへPENDINGイベントとして作成されること
- [ ] 同じ予約が`Bookings`シートに同じbookingIdで保存されること
- [ ] getAvailabilityで空きだった枠が、スペースマーケット予約で埋まった直後に
      `createBooking`すると`SLOT_CONFLICT`になり、CalendarにもSheetsにも何も作られないこと
- [ ] Booking Adminプロジェクト（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）を
      セットアップ後、そのSpreadsheetを開くと追加設定なしで実際に「予約管理」メニューが
      表示されること（container-bound scriptのonOpen単純トリガーの実地確認）
- [ ] Spreadsheetのカスタムメニューから`confirmBooking`が実行できること
- [ ] `expirePendingBookings`のトリガーが実際に15分おきに動作すること
- [ ] 既存の`_includes/calendar_embed.html`および`studio-x/reservation/`の予約フォームが
      これまで通り動作すること（本Issueでは一切変更していない）

Issue #269（3ブランド対応・共通予約UI）の追加確認:

- [ ] `scripts/booking-config.js`の`BASE_URL`を実際のBooking Web App URLへ差し替えること
      （3ブランド共通・この1ファイルのみでよい）
- [ ] `/booking/`（SNB） / `/mens/booking/`（SNB mens） / `/studio-x/booking/`（Studio X）
      それぞれから実際にPENDING予約を作成できること
- [ ] 3ブランドのbookingIdがそれぞれ`SNB-` / `MENS-` / `SX-`で始まること
- [ ] `Bookings`シートのbrand列・Calendarイベントのbrandタグに正しいbrandが保存されること
- [ ] いずれかのブランドで作った予約が、他の2ブランドの予約フォーム・
      `getAvailability`から見て塞がっていること（同一Calendarであることの実地確認）
- [ ] 完了画面で「まだ予約は確定していない」ことが明示されていること

Issue #270（当日利用ルールと利用経験判定）の追加確認:

- [ ] 共通予約UIで利用区分（初回利用/利用経験あり）を選択できること
- [ ] 初回利用＋当日で「空き時間を確認する」を押すと、`getAvailability`を呼ばずに
      理由（当日予約不可）が表示され、翌日以降の日付を選び直せること
- [ ] 利用経験あり＋当日は通常どおり空き時間が表示され、`createBooking`まで進めること
- [ ] 初回利用＋当日のペイロードでcreateBooking APIを直接呼んでも
      `SAME_DAY_NOT_ALLOWED_FOR_FIRST_TIME`で拒否され、CalendarイベントもSheets行も
      作られないこと
- [ ] 利用経験あり＋当日で実際にPENDING予約を作成し、`Bookings`シートの
      `customerType`列に`returning`が保存されること
- [ ] 当日・利用開始まで2時間未満の予約が、作成直後にEXPIREDにならないこと
      （graceにより`expiry > createdAt`が保たれる）
- [ ] 当日・利用開始まで2時間未満の予約が、利用開始時刻を過ぎればEXPIREDになること
      （graceは利用開始時刻を上限とするため`expiry <= startAt`。利用開始後まで
      PENDINGが残らないことの実地確認。Calendarイベント削除・Sheets側`status`更新を含む）
- [ ] 翌日以降の通常予約のPENDING失効タイミングが、このIssue導入前と変わっていないこと
- [ ] `getAvailability`に当日の日付を指定した場合、現在時刻より前の開始時刻が
      候補に含まれないこと（現在時刻ちょうども除外）。翌日以降は現在時刻に関わらず
      従来どおり全候補が返ること
- [ ] 利用経験あり＋当日で、現在時刻以前の開始時刻を指定してcreateBooking APIを
      直接呼んでも`SAME_DAY_START_TIME_PASSED`で拒否され、CalendarイベントもSheets行も
      作られないこと
- [ ] 共通予約UIで、空き時間取得後に時間が経過し送信時点で開始時刻が過去になった場合、
      `SAME_DAY_START_TIME_PASSED`を受けてStep2（空き開始時刻）へ戻り、
      `getAvailability`が再取得されること

Issue #271（予約通知メール自動送信）の追加確認:

- [ ] Booking Web App / Booking Adminの両プロジェクトへ`BOOKING_MAIL_DISPLAY_NAME` /
      `BOOKING_MAIL_REPLY_TO` / `BOOKING_CONTACT_EMAIL`を設定し、Booking Admin側にのみ
      `ACCESS_GUIDE_*`一式（住所・建物・部屋・入口案内・キーボックス位置・入室方法
      `ACCESS_GUIDE_ENTRY_METHOD`・利用案内URL・秘密値の`ACCESS_GUIDE_KEYBOX_NUMBER`/
      `ACCESS_GUIDE_UNLOCK_CODE`を含む）を設定すること
- [ ] `TIMEZONE`を独自設定している場合、Booking Web App/Adminの両方に同じ値を設定し、
      メール本文の開始/終了時刻表示が実際の予約時刻（JST）と一致すること
- [ ] テスト予約でPENDINGを作成し、仮予約受付メールが1通だけ届くこと（「未確定」の
      明記・解錠コード/キーボックス番号を含まないことを含む）
- [ ] 管理者が`confirmBooking`で確定した際、確定メールが1通だけ届くこと（利用上の
      基本注意の文言を含む）。`confirmBooking`を再実行しても二重送信されないこと
- [ ] Booking Adminプロジェクトのスクリプトエディタから`createNextDayReminderTrigger`を
      実行し、毎日18時台に`sendNextDayReminders`が実際に1回動作すること
- [ ] 翌日にCONFIRMED予約がある状態で前日リマインドが1通だけ届き、来場方法（住所・
      建物・部屋・入口案内・キーボックス位置・入室方法・利用案内URL）・
      （設定していれば）解錠コードが正しく記載されていること
- [ ] 来場案内の必須項目（秘密値を含む）のいずれか1つでも未設定のまま前日リマインドの
      送信を試みると、送信されず`lastMailError*`に記録されること（fail-safeの実地確認）
- [ ] メール送信を意図的に失敗させても（例: 一時的にScript Propertiesを空にする）、
      予約自体（Calendar/Sheetsの`status`）が壊れず、`lastMailError*`に記録されること
- [ ] 「予約管理」メニューの「予約メールを再送（予約ID指定・強制再送）」から、
      設定不足解消後に実際にメールを再送できること
- [ ] 既存の管理者向け内部通知（`AdminNotifier.gs`。新しい予約が入ったことの通知）が
      このIssueの変更後も従来どおり届くこと

Issue #272（管理者キャンセルでCalendar / Sheetsを一貫更新する）の追加確認:

- [ ] 「予約管理」メニューに「アクティブ行のbookingIdをキャンセル（cancelBookingAdmin）」
      「bookingIdを入力してキャンセル（cancelBookingAdmin）」の2項目が表示されること
- [ ] PENDING予約に対してキャンセルを実行すると、YES/NO確認ダイアログが表示され、
      NOを選ぶと何も変更されないこと
- [ ] YESを選ぶと、対応するCalendarイベントが実際に**削除**され、`Bookings`シートの
      `status`が`CANCELLED`・`cancelledAt`/`updatedAt`が記録されること
- [ ] CONFIRMED予約に対しても同様にキャンセルできること（CONFIRMED→CANCELLED）
- [ ] キャンセル後、同じ日時が実際の共通予約UI（`getAvailability`）で再び候補として
      表示され、同じ時間帯で新しい予約を作成できること
- [ ] キャンセル完了後、利用者へキャンセルメールが1通だけ届くこと
      （`cancelMailSentAt`が記録されること）
- [ ] 同じbookingIdでもう一度キャンセルを実行すると「すでにキャンセル済みです」と
      表示され、Calendar操作もキャンセルメールの再送信も行われないこと
- [ ] Calendarイベントを手動で削除した状態でキャンセルを実行すると、「Calendarイベントは
      既に存在しなかったためRecoveryへ記録しました」と表示され、`Recovery`シートに
      `CANCEL_CALENDAR_EVENT_MISSING`が記録され、`Bookings`シートの`status`は
      `CANCELLED`へ進むこと
- [ ] EXPIRED予約に対してキャンセルを実行すると失敗し、Calendar/Sheets/メールの
      いずれも変更されないこと
- [ ] 既存の`confirmBooking`・`expirePendingBookings`が、この変更後も従来どおり
      動作すること（特にCONFIRMED→CANCELLED追加後もPENDING→CONFIRMED/EXPIREDの
      既存挙動が壊れていないこと）
- [ ]（PRレビュー対応）`CALENDAR_ID`を一時的に不正な値へ変更した状態でキャンセルを
      実行すると、失敗メッセージが表示され、`Recovery`シートに
      `CANCEL_CALENDAR_LOOKUP_FAILED`が記録され、`Bookings`シートの`status`・
      Calendarのいずれも変更されないこと（設定を元に戻してから同じbookingIdで
      再実行すれば正常にキャンセルできること）

Issue #305（Booking Admin Web UI化）の追加確認:

- [ ] Booking AdminプロジェクトをWeb Appとしてデプロイし、「Execute as: Me / Only
      myself」設定で、管理者本人以外のGoogleアカウントからアクセスすると認可エラーに
      なること
- [ ] iPhone Safariから管理者本人のURLを開くと、横スクロールなしで予約一覧が
      カード表示されること
- [ ] 「今日 / 今後 / すべて」タブでそれぞれ絞り込めること
- [ ] カードの「詳細」から、Bookingsの値がそのまま（編集不可で）表示されること
- [ ] PENDING予約の「確定」を実行すると、実際に`confirmBooking`と同じ結果（Calendar
      確定・Sheets `CONFIRMED`・確定メール）になり、完了後に一覧が最新状態へ
      再取得されること
- [ ] PENDING/CONFIRMED予約の「キャンセル」で確認ダイアログが表示され、キャンセルすると
      実際に`cancelBookingAdmin`と同じ結果（Calendar削除・Sheets `CANCELLED`・
      キャンセルメール）になること
- [ ] 確定・キャンセル処理中はボタンがdisableされ、連打しても二重実行されないこと
- [ ] CANCELLED/EXPIREDの予約には「確定」「キャンセル」ボタンが表示されないこと
- [ ] Web UIからの操作後も、Spreadsheetカスタムメニュー（「予約管理」）が従来どおり
      表示・動作すること
- [ ] 公開Booking Web App（利用者向け予約UI）に、確定・キャンセル等の管理機能が
      一切追加されていないこと

Phase 0のゲート確認（スペースマーケットとの同一Calendar共存の実環境確認）は
Issue #267で完了（PASS, 2026-09-19）。確認手順・記録は
[`docs/phase0-issue267-spacemarket-coexistence.md`](../../docs/phase0-issue267-spacemarket-coexistence.md)
を参照。
