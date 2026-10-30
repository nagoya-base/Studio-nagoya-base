/*
 * BookingsSchema.gs — Bookingsシートのヘッダー定義の唯一の正本（Issue #671）。
 *
 * SpreadsheetRepository.gs（GAS実行時）と admin/BookingsSchemaMigration.gs
 * （管理者がApps Scriptエディタから手動実行する `migrateBookingsSchema`。Issue #673）の双方が
 * このファイルだけを参照する。ヘッダーを別の場所へ複製したり、ソースを正規表現で
 * 解析して推測したりしないこと。
 *
 * 列を増やす場合はHEADERS_の末尾へ追記するだけでよい。本番Bookingsシートへは、反映後に
 * 管理者が `migrateBookingsSchema` を1回実行して不足列を末尾追加する（手順は
 * gas/booking/README.md冒頭。実行したことは production workflow の `schema_migrated=true` で明示する）。
 * 途中への挿入・並べ替え・削除は禁止。
 * 追加列は新旧コード混在時にも壊れない後方互換が必須（gas/booking/README.md参照）。
 */
'use strict';

var BookingsSchema = (function () {
  var SHEET_NAME_ = 'Bookings';

  /*
   * 列を追加する場合は必ずこの配列の末尾へ追記すること（Issue #270のcustomerType追加時の方針）。
   * rowToRecord_は行の配列インデックスをこのHEADERS_の並び順で読むため、途中に挿入すると
   * 既存行（過去にappendBookingした実際のセルの並び）の列がずれて誤読される。末尾追記であれば、
   * 既存行はcustomerType列が空（undefined→rowToRecord_で''相当）になるだけで、他の列は
   * これまでどおり正しく読める。
   */
  var HEADERS_ = [
    'bookingId',
    'createdAt',
    'date',
    'startAt',
    'endAt',
    'brand',
    'name',
    'email',
    'phone',
    'people',
    'purpose',
    'paymentMethod',
    'status',
    'calendarEventId',
    'source',
    'note',
    'confirmedAt',
    'expiredAt',
    'cancelledAt',
    'updatedAt',
    'customerType',
    /*
     * ここから先はIssue #271（予約通知メール自動送信）で追加した列。
     * HEADERS_の並びどおり末尾へ追記する方針はcustomerType追加時（Issue #270）と同じ。
     */
    'pendingMailSentAt',
    'confirmedMailSentAt',
    'cancelMailSentAt',
    'reminderSentAt',
    'accessGuideSentAt',
    'lastMailErrorAt',
    'lastMailErrorType',
    'lastMailErrorMessage',
    'paymentStatus',
    /*
     * ここから先はIssue #334（カード決済の期限・失効通知・手動復活）で追加した列。
     * customerType/mail列追加時と同じく末尾追記の方針を踏襲する。
     */
    'expiredMailSentAt',
    /*
     * ここから先はIssue #334 PR-C（Booking AdminからのStripe決済リンク送信）で追加した列。
     * 同じく末尾追記の方針を踏襲する（本番反映時は既存Bookingsシートのヘッダー行へ
     * 手動で追記が必要。README.md「Spreadsheet構成」参照）。
     * - stripePaymentLinkUrl: 管理者が最後に入力・送信したStripe Payment Link URL。
     * - paymentLinkSentAt: 決済リンクメールの送信に成功した直近の日時。他のSentAt列と
     *   同じ方式で、空の場合だけ「通常送信」の対象になる（二重送信防止。明示的な再送は
     *   force指定でこの値の有無を無視する）。送信するたびに最新の送信時刻へ更新する。
     * - paymentLinkSentTo: 直近の送信に成功した宛先メールアドレス（送信時点の
     *   record.emailをそのまま記録。予約者のメールアドレスが後で変わっても送信時点の
     *   宛先を追跡できるようにするため）。
     * - paymentLinkSendCount: 決済リンクメールの送信成功回数（初回送信・明示的な再送の
     *   いずれも成功するたびに1加算する）。
     * - paymentLinkLastErrorAt / paymentLinkLastErrorMessage: 決済リンクメールの直近の
     *   送信失敗時刻・エラー内容（sanitizeErrorMessage_で redaction済み）。既存の
     *   lastMailError*（他のメール種別と共有）とは別の専用列とする。決済リンク送信は
     *   Booking Admin予約詳細で専用の送信状態（未送信/送信済み・送信回数・最終送信
     *   エラー）を表示する要件があり、他メール種別のエラーと混在させると誤表示になるため。
     *   次回の送信に成功すると自動的に空へ戻す（既存のlastMailError*と同じ方針）。
     * - paymentLinkSendUnconfirmedAt（PRレビュー対応で追加）: MailApp.sendEmailには
     *   成功したが、直後のpaymentLinkSentAt単独更新が失敗し、送信済みかどうかを
     *   確定できない場合の日時。空でない間は、他のSentAt列と同じ二重送信防止の
     *   仕組みにより通常送信（forceなし）を拒否する（BookingMailer.gsの
     *   evaluatePaymentLinkEligibility_のSEND_UNCONFIRMED判定）。次に送信履行が
     *   確定（paymentLinkSentAtの単独更新に成功）すると自動的に空へ戻す。
     * - paymentLinkMetadataInconsistentAt（第2回PRレビュー対応で追加）:
     *   paymentLinkSentAtの単独更新には成功した（＝送信履行は確定済み。二重送信の
     *   おそれはない）が、続くstripePaymentLinkUrl/paymentLinkSentTo/
     *   paymentLinkSendCount等の2回目の更新が失敗し、これらの記録内容が古い・不正確な
     *   状態のまま残っている可能性がある場合の日時。**空でない間は通常送信・明示的な
     *   再送のいずれも送信可否の判定でforceでも拒否される**（第3回PRレビュー対応。
     *   BookingMailer.gsのevaluatePaymentLinkEligibility_のMETADATA_INCONSISTENT判定。
     *   送信履行そのものの二重送信防止はpaymentLinkSentAt/paymentLinkSendUnconfirmedAtで
     *   別途確定済みだが、送信回数等の記録が信頼できるまでは追加の送信自体を止める）。
     *   **他の送信が成功しただけでは自動的にクリアされない**（第3回PRレビュー対応。
     *   以前は次の送信成功時に自動的に空へ戻していたが、これだと送信回数の食い違いを
     *   解消せずに隠してしまうため廃止した）。クリアできるのは、管理者が実際の送信履歴と
     *   照合したstripePaymentLinkUrl・paymentLinkSentTo・paymentLinkSendCountの3項目を
     *   確認したうえで呼び出す専用の補正関数
     *   BookingMailer.resolvePaymentLinkMetadataInconsistencyのみ（第5回PRレビュー対応で
     *   補正対象をpaymentLinkSendCountのみから3項目へ拡張した。URL・送信先が古いまま
     *   このフラグだけが解除されることを防ぐため）。この関数は3項目の補正とこの列の
     *   クリアを**それぞれ別のupdateBookingFields呼び出しで順に行い、都度最新レコードを
     *   再取得して実際に反映されたかを検証する**（第4回PRレビュー対応。1回の呼び出しに
     *   複数フィールドを渡すと内部でループして順に書き込むため、途中の書き込みだけが
     *   失敗すると補正が反映されていないのにこのフラグだけが先にクリアされてしまう
     *   恐れがある。検証に失敗した場合はこのフラグを維持し、Recoveryへ
     *   `PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`として記録する）。このクリア操作後の
     *   最終確認の再取得自体が失敗した場合（第5回PRレビュー対応）は、クリア操作自体が
     *   実際には成功していた可能性があり、このフラグが今どちらの状態かを断定できない
     *   ため、「維持されている」と断定せず確認不能として案内する
     *   （`RESOLVE_RESULT_UNKNOWN`。この場合も`PAYMENT_LINK_METADATA_RESOLVE_INCOMPLETE`を
     *   Recoveryへ記録する）。
     */
    'stripePaymentLinkUrl',
    'paymentLinkSentAt',
    'paymentLinkSentTo',
    'paymentLinkSendCount',
    'paymentLinkLastErrorAt',
    'paymentLinkLastErrorMessage',
    'paymentLinkSendUnconfirmedAt',
    'paymentLinkMetadataInconsistentAt',
    /*
     * ここから先はIssue #342（予約料金の自動計算・仮予約時表示）で追加した列。
     * customerType/mail列追加時と同じく末尾追記の方針を踏襲する（本番反映時は既存
     * Bookingsシートのヘッダー行へ手動で追記が必要。README.md「Spreadsheet構成」参照）。
     * 料金データを持たない過去の予約はこれらの列が空のままになるが、
     * Booking.getEffectivePriceAmount等の読み取り側はnull/空文字を前提にエラーにしない。
     * - priceAmount: createBooking時点でBookingPricing.computeBookingPriceが計算した
     *   利用料金（税込・円）。後日の料金表変更で自動的に再計算・上書きされることはない
     *   （Issue #342本文「既存予約の金額が変動しないようにする」）。
     * - priceTier: 適用された料金区分（'GENERAL'|'MEMBER'）。
     * - priceDayType: 適用された曜日区分（'WEEKDAY'|'WEEKEND_HOLIDAY'）。
     * - priceIsMember: 実際に適用された会員区分（true/false。mensでは予約者の自己申告を
     *   無視して常にtrueに固定される。snb/studio_xは自己申告どおり。BookingPricing.gs参照）。
     * - priceComputedAt: priceAmountを計算した日時（createBooking時のnowと同じ）。
     * - priceOverrideAmount / priceOverrideAt: 管理者がBooking
     *   Admin（BookingRepository.updateBookingPrice。PENDING限定。またはIssue #344の
     *   BookingReschedule.commit。CONFIRMED予約の日程変更に伴う再計算）で金額を修正した
     *   場合の修正後の金額・修正日時。priceAmount自体は上書きしない（自動計算値と修正後の
     *   値を区別できるようにするため）。「案内すべき実効金額」はBooking.
     *   getEffectivePriceAmount（priceOverrideAtが空でなければpriceOverrideAmountを
     *   優先）で一元的に判定する。BookingReschedule側もこの関数を再利用し、日程変更専用の
     *   「現在の確定金額」列を別途持たない（Issue #344追記レビュー対応: PR #343の料金基盤と
     *   同じ列を再利用し、料金の二重管理を避ける）。
     * - priceUpdateMailSentAt（PR #343レビュー対応で追加）: 管理者による金額修正
     *   （priceOverrideAt）を利用者へ案内するメール（BookingMailer.
     *   sendPriceUpdateMailForBooking）の直近の送信成功日時。他のメールSentAt列と同じ
     *   「空＝未送信」の慣習に従う。needsPriceUpdateNotice/priceUpdateNeeded_はPENDINGの
     *   予約にのみ適用されるため、BookingReschedule（CONFIRMED予約のみ対象）が
     *   priceOverrideAt/priceOverrideAmountを更新してもこの案内フローとは干渉しない。
     */
    'priceAmount',
    'priceTier',
    'priceDayType',
    'priceIsMember',
    'priceComputedAt',
    'priceOverrideAmount',
    'priceOverrideAt',
    'priceUpdateMailSentAt',
    /*
     * ここから先はIssue #344追記（管理者による日程変更時の料金差額自動計算。PR #345
     * レビュー対応で再設計）で追加した列。customerType/mail列追加時と同じく末尾追記の
     * 方針を踏襲する（本番反映時は既存Bookingsシートのヘッダー行へ手動で追記が必要）。
     * 「現在の確定金額・価格区分・曜日区分」は独自の列を持たず、上記のPR #343料金基盤
     * （priceAmount/priceTier/priceDayType/priceIsMember/priceOverrideAmount/
     * priceOverrideAt/Booking.getEffectivePriceAmount）をそのまま再利用する
     * （二重管理の解消。旧設計のpriceCategory/confirmedFeeAmount/feeMasterVersion/
     * feeInitializedAt/feeBreakdownJsonは廃止した）。
     * - scheduleChangeCount: この予約でこれまでに確定した日程変更の回数。「前日まで1回無料、
     *   2回目以降はキャンセル扱い」の判定に使う（FeeCalculator.assessScheduleChangeFee）。
     * - feePaidAmount / feeRefundedAmount: 実際に入金済み・返金済みの累計額（円）。
     *   自動請求・自動返金は行わないため、これらは常に管理者の手入力・確認による更新のみ
     *   （Stripe・PayPay・現金の入出金を確認した後にBookingReschedule.recordFeeSettlement
     *   経由で更新する。冪等性・精算履歴はFeeSettlementsシート＝FeeSettlementRepository.gs
     *   側で管理する）。
     * - feeSettlementState: ''|'SETTLED'|'PENDING_CHARGE'|'PENDING_REFUND'|'PENDING_DECISION'。
     *   料金の確定と資金移動を分離するための精算状態。
     * - feeSettlementNote / feeSettlementUpdatedAt: 精算状態の備考・最終更新日時。
     * - feeRecoveryRequiredAt / feeRecoveryReason: 日時更新後の料金関連フィールド更新が
     *   途中失敗し、Bookingsの状態（価格・変更回数・精算状態）の整合性が保証できない
     *   場合に設定する（PR #345レビュー対応「復旧が必要な予約は、次の日時変更・精算操作を
     *   停止してください」）。空でない間はBookingReschedule.commit/recordFeeSettlementの
     *   いずれも新規の変更を拒否する。既存のpaymentLinkMetadataInconsistentAtと同じ
     *   「明示的な補正関数でのみクリアできる」設計（BookingReschedule.resolveFeeRecovery）。
     * - scheduleChangeCount/feePaidAmount/feeRefundedAmount/feeSettlementState/
     *   feeSettlementNote/feeSettlementUpdatedAt/feeRecoveryRequiredAt/feeRecoveryReasonは
     *   priceOverrideAmount/priceOverrideAtと合わせて、BookingReschedule.commitが
     *   updateBookingRescheduleFeeAtomicで**1回のRange.setValues呼び出しとして**書き込む
     *   （priceUpdateMailSentAtも範囲を連続させるため現在値のまま含めて書き込む）。
     *   このため上記の列はHEADERS_内で連続している必要がある（途中に他の列を挿入しない）。
     */
    'scheduleChangeCount',
    'feePaidAmount',
    'feeRefundedAmount',
    'feeSettlementState',
    'feeSettlementNote',
    'feeSettlementUpdatedAt',
    'feeRecoveryRequiredAt',
    'feeRecoveryReason',
    /*
     * ここから先はIssue #341（Stripe API即時決済による予約自動確定・自動返金・鍵承認
     * ゲートへ移行。PR-A: 決済状態の設計・台帳移行）で追加した列。customerType/mail列
     * 追加時と同じく末尾追記の方針を踏襲する（本番反映時は既存Bookingsシートのヘッダー
     * 行へ手動で追記が必要。README.md「Spreadsheet構成」参照）。
     *
     * 'paymentAttemptId'〜'paymentRecoveryReason'の17列（PR #354レビュー対応・2回目でstripeCheckoutRequestSnapshot、
     * 3回目でpaymentAttemptResolvedAtを追加）はHEADERS_上で連続させ、
     * updateBookingPaymentStateAtomicによる1回のRange.setValuesでの一括更新を可能にする
     * （updateBookingCancellationStateAtomic/updateBookingRescheduleFeeAtomicと同じ
     * パターン）。'accessApprovedAt'だけはこの連続範囲に含めない（Issue #341本文
     * 「鍵承認は予約確定とは独立させる」ため、決済状態の一括更新とは別の書き込み経路
     * （通常のupdateBookingFields）を使う設計とする）。
     *
     * このPR-A時点では、CardPayment.gs（純粋ロジック）とこれらの列・
     * updateBookingPaymentStateAtomicのみを追加し、実際にこれらの列へ値を書き込む
     * 処理（Checkout Session発行・Webhook受信・自動確定・自動返金。PR-B/PR-C/PR-D）は
     * 実装しない。既存予約（この列が空の行）は「カード決済フローを一度も開始していない」
     * として扱われ、読み取り側もこれを前提にfail-closedに解釈すること
     * （paymentStatus自体は既存どおりBooking.normalizePaymentStatusで正規化する）。
     *
     * - paymentAttemptId: 現在（または直近）の決済試行の一意なID
     *   （CardPayment.generatePaymentAttemptId）。Stripe Checkout Session発行時の
     *   冪等キーやWebhook metadataとの照合に使う想定（PR-B/PR-C）。再試行のたびに
     *   新しいIDへ更新される。
     * - paymentAttemptResolvedAt（PR #354レビュー対応・3回目。Issue #341 PR-B）:
     *   paymentAttemptIdが指す決済試行が「これ以上自動的には動かない」終端の結果
     *   （Stripeが明確に拒否＝failedへの遷移、またはCheckout Session発行成功＝
     *   checkout_pendingへの遷移）に到達した日時。**paymentStatusとは独立**に持つ
     *   （BookingRepository.reservePaymentAttempt_のコメント参照）。空＝この
     *   paymentAttemptIdはまだ未解決（Stripe呼び出し中、または結果不明で保留中）で
     *   あることを意味し、reservePaymentAttempt_は空である限りpaymentStatusが
     *   not_started/failedのどちらであっても新しいIDを発行せずこのIDとスナップショットを
     *   再利用する。これにより、failedの予約へ複数リクエストがほぼ同時に到達しても
     *   （1つ目がpaymentStatusをfailedへ進める前に新しい試行を予約した直後など）、
     *   後続のリクエストは同じ未解決の試行へ収束する（1つ目のリクエストがpaymentStatusを
     *   変えずに決済試行だけを予約する設計のため、paymentStatus単体では「新しく予約済みで
     *   未解決」と「以前の試行が確定的に終わった後の空き状態」を区別できないことに対応する）。
     *   新しい決済試行を予約する（reservePaymentAttempt_が新しいpaymentAttemptIdを発行する）
     *   たびに、この列は必ず空へ戻してから予約する（前の試行の終端状態を引き継がない）。
     * - stripeCheckoutSessionId / stripePaymentIntentId: Stripe側の識別子（PR-Bで
     *   Checkout Session発行時に記録）。
     * - paymentHoldExpiresAt: 決済中の仮押さえ期限（CardPayment.
     *   computeCheckoutHoldExpiryMillis。既定30分。既存のカードTTL
     *   Booking.CARD_TTL_HOURS=72hとは別クロック。詳細はCardPayment.gs参照）。
     * - stripeAmount / stripeCurrency: **Checkout Session発行時点（PR-B）に確定した
     *   請求金額・通貨のスナップショット**（Issue #341 PR-Aレビュー対応・項目3）。
     *   単なる監査記録ではなく、PR-CのWebhook検証が参照する金額の正となる。PR-Bは
     *   CardPayment.verifyPaymentAmount（その時点のBooking.getEffectivePriceAmount）で
     *   検証した金額をそのままこの列へ保存し、PR-CはCardPayment.
     *   verifyPaymentAgainstSnapshotでWebhookの金額とこの列を突き合わせる（Webhook到達
     *   時点の「現在の」確定金額を再計算して比較しない）。Session発行**後**に管理者が
     *   料金を修正しても、既に発行済みのSession・既に処理された決済の検証結果には
     *   一切影響しない（料金変更後のWebhookで正常な決済が誤ってAMOUNT_MISMATCHになる
     *   事故を防ぐ設計。詳細はCardPayment.gsのverifyPaymentAgainstSnapshotコメントおよび
     *   README「Issue #341」節参照）。
     * - stripeCheckoutRequestSnapshot（PR #354レビュー対応・2回目。Issue #341 PR-B）:
     *   Stripe Checkout Session作成APIへ実際に送信するリクエスト内容一式
     *   （amountJpy/currency/bookingId/brand/paymentAttemptId/expiresAtSeconds/
     *   successUrl/cancelUrl/customerEmail/lineItemName）をJSON文字列として保存した
     *   スナップショット。決済試行ID（Idempotency-Key）を発行するのと**同じタイミング・
     *   同じRange.setValues呼び出し**で確定・保存する（BookingRepository.
     *   reservePaymentAttempt_）。GAS保存失敗・APIタイムアウト後の再試行、またはその間の
     *   料金修正・Script Properties変更（successUrl/cancelUrl等）があっても、未解決の
     *   決済試行はこのスナップショットを**そのまま**再利用し、Stripeへ送るリクエスト内容を
     *   常に初回と完全に一致させる（Stripeは同一Idempotency-Keyに異なる内容が送られると
     *   idempotency_errorを返すため）。安全に復元できない場合（JSON解析失敗・必須項目
     *   欠落・paymentAttemptId不一致等）は新しいSessionを発行せず要復旧として停止する。
     * - paymentConfirmedAt: 署名検証済みWebhookで決済成功を確認した日時。予約確定
     *   （confirmedAt）とは独立した列として持つ（Issue #341本文「決済状態を独立して
     *   扱う」。通常は自動確定と同時刻になるが、遅延Webhookで枠が埋まっていた場合は
     *   confirmedAtが付かないままpaymentConfirmedAtだけが記録され得る）。
     * - lastStripeEventId: この予約に対して最後に適用したStripe Webhookイベントの
     *   id。イベントの重複配信・順序逆転の検出に使う想定（PR-C）。
     * - stripeRefundId / refundRequestedAt / refundedAt: 自動返金の識別子・返金API
     *   呼び出し日時・返金完了確認日時。
     * - paymentLastErrorAt / paymentLastErrorMessage: Stripe関連処理（Checkout Session
     *   発行・Webhook処理・返金）の直近の失敗記録。既存のlastMailError*（メール専用）・
     *   paymentLinkLastError*（決済リンク送信専用）とは別の専用列とする（Booking
     *   AdminのStripe決済状態表示で、メール送信の失敗と混同させないため。
     *   BookingMailer.gsの既存の専用エラー列の方針を踏襲）。
     * - paymentRecoveryRequiredAt / paymentRecoveryReason: 決済状態の更新処理が途中
     *   失敗し、この17列の整合性が保証できない場合に設定する（PR #345レビュー対応の
     *   feeRecoveryRequiredAt/feeRecoveryReasonと同じ「明示的な補正関数でのみ
     *   クリアできる」設計を踏襲する想定。空でない間は以後の自動的な決済状態遷移を
     *   停止する。実際の遷移処理自体はPR-B/PR-Cで実装する）。
     * - accessApprovedAt: 旧・鍵承認ゲート（Issue #341 PR-D）の承認日時。Issue #414で鍵承認を廃止したため
     *   未使用（来場案内の送信判定・Booking Adminの表示・操作のいずれにも使わない）。既存台帳の列と
     *   値は後方互換のため残し、読み取りと既存データには影響しない（破壊的な列削除はしない）。
     */
    'paymentAttemptId',
    'paymentAttemptResolvedAt',
    'stripeCheckoutSessionId',
    'stripePaymentIntentId',
    'paymentHoldExpiresAt',
    'stripeAmount',
    'stripeCurrency',
    'stripeCheckoutRequestSnapshot',
    'paymentConfirmedAt',
    'lastStripeEventId',
    'stripeRefundId',
    'refundRequestedAt',
    'refundedAt',
    'paymentLastErrorAt',
    'paymentLastErrorMessage',
    'paymentRecoveryRequiredAt',
    'paymentRecoveryReason',
    'accessApprovedAt',
    /*
     * PR #354レビュー対応（Issue #341 PR-B）で追加。カード決済予約のcreateBooking時に
     * 発行する、推測困難な決済開始トークン（Utilities.getUuid()。現金・PayPay予約は
     * 常に空文字のまま）。bookingId（ブランド+日付+uuidの一部8桁のみで構成され、
     * 総当たりに対して十分な強度を持たない）だけではCheckout Sessionの発行・取得を
     * 一切許可しない設計にするため、BookingRepository.beginCardCheckoutは必ずこの列と
     * 呼び出し元が渡す値が一致することを要求する（tokensMatch_。定数時間比較）。
     * createBookingのレスポンスで一度だけ本人（送信したブラウザ）へ返し、以後は
     * ブラウザ側が保持する。台帳・ログ・PRには実値を記載しない。
     */
    'checkoutAccessToken',
    /*
     * ここから先はIssue #341 PR-D（管理者の取消・返金）で追加した列。末尾追記の方針は
     * 既存どおり（本番反映時は既存Bookingsシートのヘッダー行へ手動で追記が必要。
     * README「Issue #341 PR-D」節参照）。返金試行の予約・結果の保存は
     * updateBookingRefundStateAtomicで'refundAttemptId'〜'refundCheckedAt'の連続8列を
     * 1回のRange.setValuesで更新する（この8列はHEADERS_上で連続させること）。
     * 'refundMailSentAt'は返金完了メールのSentAt（他のメールSentAt列と同じ「空＝未送信」の
     * 慣習。BookingMailer.sendRefundedMailForBookingが単独で更新するため、上の連続範囲に
     * 含めない）。
     *
     * - refundAttemptId: 返金試行ID（Stripe返金APIへのIdempotency-Keyそのもの。
     *   'RFD-<bookingId>-<uuid12桁>'）。Stripeを呼ぶ**前**に台帳へ永続化する
     *   （PR-BのpaymentAttemptIdと同じ設計）。
     * - refundAttemptState: 'RESERVED'（試行IDを確保しStripe呼び出し中）|'SUBMITTED'
     *   （Stripeが返金を受け付け、stripeRefundIdを記録済み）|'UNKNOWN'（Stripeの応答が
     *   不明。照会が必要）|'FAILED'（Stripeが返金を作らずに拒否した、または作られた返金が
     *   failed/canceledになった）。空＝返金試行なし。
     * - refundDecision: 管理者が取消時に選んだ返金方法（'FULL'|'PARTIAL'|'NONE'）。
     *   キャンセル料・返金額はシステムが自動計算しない（Issue #344と同じ方針。オーナー
     *   確認済み）。
     * - refundAmount: 返金額（円・整数）。NONEの場合は0。
     * - refundReason: 管理者が入力した取消・返金の理由（管理者専用の記録。利用者向け
     *   メールには含めない）。
     * - refundDecidedAt: 管理者が取消・返金を実行した日時。
     * - refundStripeStatus / refundCheckedAt: Stripeで最後に確認した返金のstatusと確認日時。
     */
    'refundAttemptId',
    'refundAttemptState',
    'refundDecision',
    'refundAmount',
    'refundReason',
    'refundDecidedAt',
    'refundStripeStatus',
    'refundCheckedAt',
    'refundMailSentAt',
    /*
     * PR-Dレビュー対応・1回目で追加。未入金のStripe Checkout予約を「返金なし」で取り消した
     * ときの、発行済みCheckout Session（決済URL）の失効状況（BookingRefund.gs参照）。
     * - checkoutCancelState: 'EXPIRE_REQUESTED'（取消済み・失効をStripeへ依頼する前後で
     *   結果未記録）|'EXPIRED'（Stripe上で失効を確認）|'NO_SESSION'（発行済みSessionなし）|
     *   'UNKNOWN'（失効APIの応答・Sessionの状態を確認できない。未決済・失効済みと断定しない）|
     *   'PAYMENT_RECEIVED'（取消と同時期にSessionの決済が成立していた）。空＝この経路の取消なし。
     * - checkoutCancelCheckedAt: 上記を最後に確認した日時。
     */
    'checkoutCancelState',
    'checkoutCancelCheckedAt',
    /*
     * Issue #470で追加した列（末尾追記。本番反映時は既存Bookingsシートのヘッダー行へ手動で追記が必要）。
     * - priceGeneration: 予約作成時に固定した料金世代（'V1'=2026/11/30まで|'V2'=2026/12/1から）。
     *   日程変更でも更新しない。空は列追加前の予約でV1として扱う（BookingPricing.normalizeGeneration）。
     */
    'priceGeneration',
    /*
     * Issue #471で追加した列（末尾追記。本番反映時は既存Bookingsシートのヘッダー行へ手動で追記が必要）。
     * - membershipStatus: 予約作成時に確認したSNB MEMBERの実会員資格（利用日の属する月の支払い事実）。
     *   'ACTIVE'（資格あり）|'INACTIVE'（確認したが資格なし）|'NOT_CHECKED'（確認対象外。V1・mens・
     *   studio_x、または空）。価格優遇フラグ priceIsMember とは別概念で、mensがMEMBER料金でも
     *   'ACTIVE'にはならない。日程変更でも更新しない（作成時点の事実）。
     */
    'membershipStatus',
    /*
     * Issue #478で追加した列（末尾追記。本番反映時は既存Bookingsシートのヘッダー行の末尾（membershipStatusの
     * 右隣）へ手動で `planCode` を追記が必要）。
     * - planCode: 独立プラン識別子。'member_pair_3h'＝会員限定2名ペアパック。空＝通常料金（列追加前の予約も空）。
     *   通常料金tier（priceTier）とは別に保持し、日程変更でも更新しない（BookingReschedule・FeeCalculatorは
     *   この値を見て変更先の曜日区分でプラン料金を再計算する）。
     */
    'planCode',
    /*
     * Issue #667で追加した列（末尾追記。本番反映時は既存Bookingsシートのヘッダー行の末尾（planCodeの右隣）へ
     * 下記6列を同じ並びで手動追記が必要）。作品撮りサポートプラン（planCode='mens_photo_support'）以外では常に空。
     * - supportServices: スタッフ対応の種別。'SETUP'（事前設営）|'CLEANUP'（片付け）|'BOTH'（事前設営＋片付け）。
     * - supportRoomAmount / supportStaffAmount: 申込時に確定した金額内訳（部屋料金・スタッフ対応料金。合計がpriceAmount）。
     * - supportApprovedAt: 運営が承認した日時。空＝承認待ち（この間は決済不可）。
     * - supportPaymentDueAt: 承認後の支払い期限（承認から24時間）。この時刻までに支払いが完了しなければ不成立（EXPIRED）で枠を解放する。
     * - supportApprovalMailSentAt: 承認・支払い案内メールの送信日時（空＝未送信。送信失敗時に管理画面から再送できる）。
     * - supportEquipment / supportEquipmentAmount: 付けた有料機材と機材料金（下記。末尾の2列）。
     */
    'supportServices',
    'supportRoomAmount',
    'supportStaffAmount',
    'supportApprovedAt',
    'supportPaymentDueAt',
    'supportApprovalMailSentAt',
    /* - supportEquipment: 作品撮りサポートに付けた有料機材の項目（'EQ:<機材コード>:<数量>[:F<セット無料数>]'のカンマ区切り。空＝機材なし）。
       - supportEquipmentAmount: 有料機材料金（円。共通機材カタログ由来。priceAmountに含む。空＝0円）。 */
    'supportEquipment',
    'supportEquipmentAmount',
    /*
     * Issue #668で追加した列（末尾追記。本番反映時は既存Bookingsシートのヘッダー行の末尾（planCodeの
     * 右隣）へ、#667の列（supportEquipmentAmountまで）に続けて次の順で手動追記が必要）。SNB mens大人数利用（5〜7名）の保存項目。予約人数そのものは people 列
     * （料金計算の正本）。会員資格の確認結果は既存の membershipStatus 列（'ACTIVE'が確認済み）、仮押さえはstatus=PENDING。
     * - largeParty: 5〜7名の大人数利用なら TRUE。空は通常予約。
     * - partySurcharge: 人数加算額（円。予約1件につき1回。5名=1000/6名=2000/7名=3000）。通常予約は空。
     * - largePartyApprovalStatus: 'PENDING_APPROVAL'（承認待ち）|'APPROVED'|'REJECTED'。空は通常予約。
     * - largePartyApprovedAt / largePartyPaymentDueAt: 承認日時と、その24時間後の支払期限。
     */
    'largeParty',
    'partySurcharge',
    'largePartyApprovalStatus',
    'largePartyApprovedAt',
    'largePartyPaymentDueAt',
    /*
     * Issue #679で追加した列（末尾追記。本番Bookingsシートへは、反映後に管理者が migrateBookingsSchema を1回実行して末尾追加する。
     * gas/booking/README.md冒頭の手順: scope=admin-only → migrateBookingsSchema → scope=full, schema_migrated=true）。
     * - supportBackdrop: 作品撮りサポートプランで利用者が希望した背景の識別コード1件
     *   （BACKDROP_CLOTH_WHITE|BACKDROP_CLOTH_BLACK|BACKDROP_TSURU_BLACK|BACKDROP_ASANOHA_INDIGO|BACKDROP_GRUNGE。品目定義の正本は
     *   _data/studio_x_equipment.json の supportBackdrops）。空＝背景の希望なし（旧予約・作品撮りサポート以外もすべて空）。
     *   料金計算用の supportEquipment には混ぜない。背景の選択は金額に影響せず、保存済みの料金・選択・料金世代も変更しない。
     */
    'supportBackdrop'
  ];

  return {
    SHEET_NAME: SHEET_NAME_,
    HEADERS: HEADERS_.slice()
  };
})();
