/*
 * SpreadsheetRepository.gs — 予約台帳（Issue #268）のSpreadsheet読み書き。
 *
 * Script Propertiesの SPREADSHEET_ID で指定した専用Spreadsheet内に
 * 「Bookings」シートを作成・使用する（存在しなければ自動作成しヘッダー行を書く）。
 *
 * 列構成は固定（Issue #268 v1仕様 + 監査用カラム）。列を増やす場合はHEADERS_と
 * README.mdの両方を更新すること。
 */
'use strict';

var SpreadsheetRepository = (function () {
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
     * 'paymentAttemptId'〜'paymentRecoveryReason'の15列はHEADERS_上で連続させ、
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
     *   失敗し、この15列の整合性が保証できない場合に設定する（PR #345レビュー対応の
     *   feeRecoveryRequiredAt/feeRecoveryReasonと同じ「明示的な補正関数でのみ
     *   クリアできる」設計を踏襲する想定。空でない間は以後の自動的な決済状態遷移を
     *   停止する。実際の遷移処理自体はPR-B/PR-Cで実装する）。
     * - accessApprovedAt: 鍵・来場案内の開示承認日時（Issue #341本文の鍵承認ゲート）。
     *   空＝未承認。status・paymentStatusのいずれとも独立しており、この列の更新だけでは
     *   予約状態を一切変更しない。カード決済かつ当日予約でない予約にのみ意味を持つ
     *   （対象外の予約では常に空のまま）。この列を承認済みにする操作自体はメール送信を
     *   一切トリガーしない（Issue #341受入条件）。
     */
    'paymentAttemptId',
    'stripeCheckoutSessionId',
    'stripePaymentIntentId',
    'paymentHoldExpiresAt',
    'stripeAmount',
    'stripeCurrency',
    'paymentConfirmedAt',
    'lastStripeEventId',
    'stripeRefundId',
    'refundRequestedAt',
    'refundedAt',
    'paymentLastErrorAt',
    'paymentLastErrorMessage',
    'paymentRecoveryRequiredAt',
    'paymentRecoveryReason',
    'accessApprovedAt'
  ];

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  /* シートが存在しない、またはヘッダー行が未設定の場合はヘッダー行を書く（冪等）。 */
  function ensureBookingsSheet_() {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(SHEET_NAME_);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_NAME_);
    }
    if (sheet.getLastRow() < 1) {
      sheet.appendRow(HEADERS_);
    }
    return sheet;
  }

  function rowToRecord_(row) {
    var record = {};
    HEADERS_.forEach(function (header, index) {
      record[header] = row[index];
    });
    return record;
  }

  function recordToRow_(record) {
    return HEADERS_.map(function (header) {
      return record[header] !== undefined && record[header] !== null ? record[header] : '';
    });
  }

  /* record: HEADERS_のキーを持つオブジェクト（未指定のフィールドは空文字で埋める）。 */
  function appendBooking(record) {
    var sheet = ensureBookingsSheet_();
    sheet.appendRow(recordToRow_(record));
  }

  /* 戻り値: { rowNumber, record } または見つからない場合はnull。
     rowNumberは1始まり・ヘッダー行込みのSpreadsheet実際の行番号（getRange等にそのまま使える）。 */
  function findRowByBookingId(bookingId) {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === bookingId) {
        return { rowNumber: i + 1, record: rowToRecord_(values[i]) };
      }
    }
    return null;
  }

  /* 全行をstatus問わず返す（Issue #305 Booking Admin Web UIの一覧表示用）。
     個人管理用途で件数が小規模な前提のため、getAllPendingBookings等と同じ
     「全行取得してから絞り込む」方針をそのまま踏襲する（専用の検索APIは作らない）。 */
  function getAllBookings() {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      result.push({ rowNumber: i + 1, record: rowToRecord_(values[i]) });
    }
    return result;
  }

  /* status===PENDINGの全行を返す（expirePendingBookings用）。件数が多くなる想定は
     Phase 1ではないため、全行取得→フィルタというシンプルな実装にしている。 */
  function getAllPendingBookings() {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var result = [];
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (record.status === 'PENDING') {
        result.push({ rowNumber: i + 1, record: record });
      }
    }
    return result;
  }

  /*
   * record.dateをtimezone基準の'YYYY-MM-DD'へ正規化してから比較できるようにする
   * （Issue #349）。Sheetsの`getValues()`は日付らしい文字列をセルへ書き込むと読み込み時に
   * Date値として返すことがあり（BookingMailer.gsのnormalizeReminderDate_と同じ既知の
   * 注意点）、record.dateがDate値の場合に文字列のdateStringとの`===`比較が型の違いだけで
   * 常にfalseになり、CONFIRMED予約が0件と誤検知される事故（前日リマインド未送信）を防ぐ。
   * 無効なDate・空欄はどちらの分岐でも元の値のままdateStringと一致しないため対象外になる。
   * record自体（戻り値・Sheetのセル）は書き換えない（比較用の一時変数としてのみ使う）。
   */
  function normalizeBookingDateForComparison_(value, timezone) {
    if (value && typeof value.getTime === 'function' && !isNaN(value.getTime())) {
      return BookingAvailability.formatDateInTimezone(value, timezone) || '';
    }
    return value || '';
  }

  /* status===CONFIRMEDかつdate===dateStringの全行を返す（前日リマインド抽出用。Issue #271）。
     reminderSentAt等の判定はBookingMailer側の責務とし、ここではstatus/dateのみで絞り込む。
     dateの比較はnormalizeBookingDateForComparison_で正規化してから行う（Issue #349）。 */
  function getConfirmedBookingsForDate(dateString) {
    var sheet = ensureBookingsSheet_();
    var values = sheet.getDataRange().getValues();
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var result = [];
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(values[i]);
      if (
        record.status === 'CONFIRMED' &&
        normalizeBookingDateForComparison_(record.date, timezone) === dateString
      ) {
        result.push({ rowNumber: i + 1, record: record });
      }
    }
    return result;
  }

  /*
   * fields: { [HEADERS_のいずれか]: value } の部分更新。statusセルの直接編集を
   * 正式運用にしないため、statusを含む更新は必ずこの関数（＝confirmBooking /
   * expirePendingBookings）経由でのみ行う。
   * bookingIdが見つからない場合は例外を投げる。
   */
  function updateBookingFields(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }
    var sheet = ensureBookingsSheet_();
    Object.keys(fields).forEach(function (key) {
      var columnIndex = HEADERS_.indexOf(key);
      if (columnIndex === -1) {
        throw new Error('未知のbookingフィールドです: ' + key);
      }
      sheet.getRange(found.rowNumber, columnIndex + 1, 1, 1).setValues([[fields[key]]]);
    });
    return found.rowNumber;
  }

  /* Issue #344: 日時3列だけを1回のsetValuesで更新する。メール・決済・status列は触れない。 */
  function updateBookingScheduleAtomic(bookingId, date, startAt, endAt) {
    var found = findRowByBookingId(bookingId);
    if (!found) throw new Error('bookingIdが見つかりません: ' + bookingId);
    if (!startAt || !endAt || typeof startAt.getTime !== 'function' ||
        typeof endAt.getTime !== 'function' || startAt.getTime() >= endAt.getTime()) {
      throw new Error('予約日時が不正です。');
    }
    var sheet = ensureBookingsSheet_();
    sheet.getRange(found.rowNumber, HEADERS_.indexOf('date') + 1, 1, 3)
      .setValues([[date, startAt, endAt]]);
    return found.rowNumber;
  }

  /*
   * BookingReschedule.commit/recordFeeSettlement専用のatomic更新（Issue #344追記
   * PR #345レビュー対応）。HEADERS_上で連続する'priceOverrideAmount'〜'feeRecoveryReason'
   * の列範囲（priceUpdateMailSentAt/priceOverrideAt含む）に対する1回のsetValuesで、
   * 日程変更に伴う「現在の確定金額（priceOverrideAmount/priceOverrideAt）・変更回数・
   * 精算状態・要復旧フラグ」をまとめて更新する。updateBookingCancellationStateAtomicと
   * 同じ設計（呼び出し元が指定しないキーは既存値のまま書き戻す。範囲外の列は一切触らない）。
   * この関数が「1回のRange.setValues呼び出し」であること自体が、日時更新後に料金側の
   * 一部フィールドだけが更新される中途半端な状態（変更回数だけ旧値のまま残る等）を
   * 構造的に防ぐ（PR #345レビュー対応「Bookingsの日時・確定料金・料金版・変更回数・
   * 精算状態を一貫して更新」）。書き込み自体が失敗した場合は、呼び出し元
   * （BookingReschedule.gs）がfeeRecoveryRequiredAtを立てて以降の操作をブロックする。
   */
  var RESCHEDULE_FEE_ATOMIC_FIELDS_ = [
    'priceOverrideAmount', 'priceOverrideAt', 'priceUpdateMailSentAt',
    'scheduleChangeCount', 'feePaidAmount', 'feeRefundedAmount',
    'feeSettlementState', 'feeSettlementNote', 'feeSettlementUpdatedAt',
    'feeRecoveryRequiredAt', 'feeRecoveryReason'
  ];

  function updateBookingRescheduleFeeAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }
    Object.keys(fields).forEach(function (key) {
      if (RESCHEDULE_FEE_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('日程変更の料金atomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('priceOverrideAmount');
    var endIndex = HEADERS_.indexOf('feeRecoveryReason');
    var values = [];
    for (var i = startIndex; i <= endIndex; i++) {
      var header = HEADERS_[i];
      var hasOverride = Object.prototype.hasOwnProperty.call(fields, header);
      var value = hasOverride ? fields[header] : found.record[header];
      values.push(value !== undefined && value !== null ? value : '');
    }

    var sheet = ensureBookingsSheet_();
    sheet.getRange(found.rowNumber, startIndex + 1, 1, endIndex - startIndex + 1).setValues([values]);
    return found.rowNumber;
  }

  /*
   * BookingReschedule.backfillOriginalPrice専用のatomic更新（PR #345再レビュー対応・
   * 7回目）。HEADERS_上で連続する'priceAmount'〜'priceComputedAt'の5列（基準料金：
   * 自動計算値・価格区分・曜日区分・会員区分・計算日時）に対する1回のsetValuesで
   * まとめて更新する。updateBookingRescheduleFeeAtomicと同じ設計（呼び出し元が
   * 指定しないキーは既存値のまま書き戻す。範囲外の列——priceOverrideAmount等の
   * 日程変更専用フィールドや精算累計額——には一切触れない）。この関数が「1回の
   * Range.setValues呼び出し」であることが、途中失敗による「価格区分だけ新しいが
   * 金額は古いまま」のような半端な基準料金状態を構造的に防ぐ。
   */
  var PRICE_BASELINE_ATOMIC_FIELDS_ = ['priceAmount', 'priceTier', 'priceDayType', 'priceIsMember', 'priceComputedAt'];

  function updateBookingPriceBaselineAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }
    Object.keys(fields).forEach(function (key) {
      if (PRICE_BASELINE_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('基準料金のatomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('priceAmount');
    var endIndex = HEADERS_.indexOf('priceComputedAt');
    var values = [];
    for (var i = startIndex; i <= endIndex; i++) {
      var header = HEADERS_[i];
      var hasOverride = Object.prototype.hasOwnProperty.call(fields, header);
      var value = hasOverride ? fields[header] : found.record[header];
      values.push(value !== undefined && value !== null ? value : '');
    }

    var sheet = ensureBookingsSheet_();
    sheet.getRange(found.rowNumber, startIndex + 1, 1, endIndex - startIndex + 1).setValues([values]);
    return found.rowNumber;
  }

  /* cancelBookingAdminのatomic更新で触ってよいフィールドのみを列挙する（下記参照）。 */
  var CANCELLATION_ATOMIC_FIELDS_ = ['status', 'cancelledAt', 'updatedAt'];

  /*
   * cancelBookingAdmin専用のatomic更新（Issue #272 PRレビュー2回目対応）。
   * status/cancelledAt/updatedAtの3項目**だけ**を、HEADERS_上で連続する
   * 'status'（13列目）〜'updatedAt'（20列目）の列範囲に対する1回のsetValuesで更新する
   * （途中のcalendarEventId/source/note/confirmedAt/expiredAtは呼び出し元が指定しない限り
   * 既存値のまま書き戻す。'status'〜'updatedAt'が連続列であるためこの範囲書き込みが成立する）。
   *
   * 初回対応（レビュー1回目）ではBookings行の全29列を丸ごと`setValues`する
   * `updateBookingFieldsAtomic`を用意したが、これは以下の競合を生む恐れがあると
   * 2回目レビューで指摘された:
   * - Booking Web App（createBooking等）とBooking Admin（confirmBooking/
   *   expirePendingBookings/cancelBookingAdmin）は別々のGASプロジェクトであり、
   *   LockService.getScriptLock()を共有しない
   * - Web App側がpendingMailSentAt等（22列目以降）を更新した直後に、Admin側が
   *   古い行全体を書き戻すと、Web App側の更新を空値で巻き戻してしまう
   * - #271はメール列のSentAtを二重送信防止の冪等性の基準にしているため、これは
   *   実運用で二重送信事故につながり得る
   *
   * そのためこの関数は21列目以降（customerType・mail SentAt・lastMailError*）は
   * 一切読み書きしない（そもそも書き込み範囲に含めない）。confirmBooking/
   * expirePendingBookings/cancelBookingAdminは同一Booking AdminプロジェクトのLockで
   * 直列化されるため、13〜20列の範囲内で複数呼び出しが競合することもない。
   *
   * status/cancelledAt/updatedAt以外のキーが渡された場合は例外を投げる（mail列等への
   * 誤用を防ぐfail-closed）。bookingIdが見つからない場合も例外を投げる。
   */
  function updateBookingCancellationStateAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }

    Object.keys(fields).forEach(function (key) {
      if (CANCELLATION_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('キャンセルatomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('status');
    var endIndex = HEADERS_.indexOf('updatedAt');
    var values = [];
    for (var i = startIndex; i <= endIndex; i++) {
      var header = HEADERS_[i];
      var hasOverride = Object.prototype.hasOwnProperty.call(fields, header);
      var value = hasOverride ? fields[header] : found.record[header];
      values.push(value !== undefined && value !== null ? value : '');
    }

    var sheet = ensureBookingsSheet_();
    sheet.getRange(found.rowNumber, startIndex + 1, 1, endIndex - startIndex + 1).setValues([values]);
    return found.rowNumber;
  }

  var PAYMENT_STATE_ATOMIC_FIELDS_ = [
    'paymentAttemptId', 'stripeCheckoutSessionId', 'stripePaymentIntentId',
    'paymentHoldExpiresAt', 'stripeAmount', 'stripeCurrency', 'paymentConfirmedAt',
    'lastStripeEventId', 'stripeRefundId', 'refundRequestedAt', 'refundedAt',
    'paymentLastErrorAt', 'paymentLastErrorMessage', 'paymentRecoveryRequiredAt',
    'paymentRecoveryReason'
  ];

  /*
   * Issue #341 PR-A: Stripe決済状態の付随情報のatomic更新（updateBookingCancellationStateAtomic/
   * updateBookingRescheduleFeeAtomicと同じパターン）。HEADERS_上で実際に連続する
   * 'paymentAttemptId'〜'paymentRecoveryReason'（末尾15列）の範囲に対する1回のsetValuesで
   * まとめて更新する。
   *
   * 既存の'paymentStatus'（30列目。Issue #271由来の既存列を転用）はこの15列と
   * HEADERS_上で連続していない（間にexpiredMailSentAt〜feeRecoveryReasonという無関係な
   * 既存25列が挟まる）ため、意図的にこの関数の対象に含めない。同じRange.setValuesへ
   * 含めてしまうと、その25列を他プロセス（決済リンク送信・料金修正・日程変更等）が
   * 並行更新した直後にこの関数がfound.record（呼び出し開始時点のスナップショット）の
   * 古い値で丸ごと書き戻し、その更新を消してしまう恐れがある（updateBookingCancellation
   * StateAtomicが「21列目以降には触れない」設計にした理由と同種の事故。このファイルの
   * 同関数のコメント参照）。'paymentStatus'自体の更新は呼び出し側が別途
   * updateBookingFields(bookingId, {paymentStatus: ...})で単独更新する（2回の書き込みに
   * 分かれるため呼び出し間で一瞬だけ不整合な組み合わせが観測され得るが、無関係な25列を
   * 巻き込むより安全という判断。将来的に両者の完全な同時更新が必要になれば、台帳側の
   * 列順を見直すか専用の復旧フラグで補う）。
   *
   * 実際にこの関数を呼び出して決済状態一式を遷移させる処理（Checkout Session発行・
   * Webhook確認・自動返金）はPR-B/PR-C/PR-Dで実装する。本PR-Aでは関数の提供と
   * モックテストによる書き込み範囲の検証のみを行う。
   *
   * PAYMENT_STATE_ATOMIC_FIELDS_以外のキーが渡された場合は例外を投げる（mail列・
   * 予約日時列等への誤用を防ぐfail-closed）。bookingIdが見つからない場合も例外を投げる。
   */
  function updateBookingPaymentStateAtomic(bookingId, fields) {
    var found = findRowByBookingId(bookingId);
    if (!found) {
      throw new Error('bookingIdが見つかりません: ' + bookingId);
    }

    Object.keys(fields).forEach(function (key) {
      if (PAYMENT_STATE_ATOMIC_FIELDS_.indexOf(key) === -1) {
        throw new Error('決済状態atomic更新で許可されていないフィールドです: ' + key);
      }
    });

    var startIndex = HEADERS_.indexOf('paymentAttemptId');
    var endIndex = HEADERS_.indexOf('paymentRecoveryReason');
    var values = [];
    for (var i = startIndex; i <= endIndex; i++) {
      var header = HEADERS_[i];
      var hasOverride = Object.prototype.hasOwnProperty.call(fields, header);
      var value = hasOverride ? fields[header] : found.record[header];
      values.push(value !== undefined && value !== null ? value : '');
    }

    var sheet = ensureBookingsSheet_();
    sheet.getRange(found.rowNumber, startIndex + 1, 1, endIndex - startIndex + 1).setValues([values]);
    return found.rowNumber;
  }

  return {
    HEADERS: HEADERS_,
    appendBooking: appendBooking,
    findRowByBookingId: findRowByBookingId,
    getAllBookings: getAllBookings,
    getAllPendingBookings: getAllPendingBookings,
    getConfirmedBookingsForDate: getConfirmedBookingsForDate,
    updateBookingFields: updateBookingFields,
    updateBookingScheduleAtomic: updateBookingScheduleAtomic,
    updateBookingRescheduleFeeAtomic: updateBookingRescheduleFeeAtomic,
    updateBookingPriceBaselineAtomic: updateBookingPriceBaselineAtomic,
    updateBookingCancellationStateAtomic: updateBookingCancellationStateAtomic,
    updateBookingPaymentStateAtomic: updateBookingPaymentStateAtomic
  };
})();
