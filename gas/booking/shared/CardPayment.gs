/*
 * CardPayment.gs — Stripeカード決済（Issue #341）に関する、GAS組み込みサービスへ一切
 * 依存しない純粋ロジック。Booking.gs/BookingPricing.gsと同方針でnode --testからvmで
 * そのまま実行して検証できる。
 *
 * このファイルはPR-A（決済状態の設計・サーバー側の料金検証・台帳移行）の範囲のみを扱う。
 * 実際のStripe API呼び出し（UrlFetchAppでのCheckout Session発行・署名検証Webhook受信・
 * 返金実行）は一切含まない（PR-B/PR-Cの責務。gas/booking/README.md
 * 「Issue #341: Stripe API即時決済移行」節参照）。
 *
 * Availability.gs/Booking.gsと同じ依存順を前提とする（BookingがBookingAvailabilityに
 * 依存するのと同様、このファイルはBooking.gs（Booking.getEffectivePriceAmount）に
 * 依存するため、テスト・GASプロジェクトいずれでもBooking.gsより後に読み込むこと。
 * test/helpers/booking-deployment-manifest.jsのBOOKING_WEB_APP_FILES/
 * BOOKING_ADMIN_FILES、gas/booking/README.mdのデプロイ対象ファイル表を参照）。
 *
 * ## Stripe Checkout SessionのTTL・仮押さえ時間について（実装前の必須確認事項への回答）
 *
 * Issue #341本文は「決済中の枠を短時間（目安30分）仮押さえ」「Session expires_atを
 * この仮押さえ期限と一致させる」としている。Stripe Checkout Session（mode=payment）の
 * `expires_at`は、公式ドキュメント上「Session作成時刻から30分後〜24時間後」の範囲でしか
 * 指定できない（この実装作業時点では、このサンドボックス環境のネットワークポリシーが
 * docs.stripe.comへのアウトバウンド接続をブロックしており、公式ドキュメントで最終確認
 * できなかった。既知の仕様として記載しているが、PR-B着手前に必ず公式ドキュメントで
 * 再確認すること）。
 *
 * 30分「ちょうど」を仮押さえ時間としてそのまま採用すると、次の事故につながり得るため
 * 修正案を採る:
 * - PENDING作成時刻とCheckout Session作成時刻の間に処理遅延（Lock待ち・リトライ・
 *   ネットワーク往復）があると、Stripeへ送るexpires_atが実際のSession作成時刻から
 *   30分未満になり、Stripe API側のバリデーションエラーになるおそれがある。
 * - そのため、内部の仮押さえ期限（`computeCheckoutHoldExpiryMillis`。PENDING保持・
 *   空き枠ロック解除の基準）と、Stripeへ実際に送るexpires_at
 *   （`computeStripeSessionExpiresAtSeconds`。安全マージンを載せた値）を別の関数として
 *   分離して提供する。
 * - さらに、内部の仮押さえ期限を先に確定させてそれに`expires_at`を後から合わせるのではなく、
 *   PR-B側はCheckout Session作成に**成功した後**、Stripeのレスポンスに含まれる実際の
 *   `expires_at`を内部の仮押さえ期限として保存し直すこと（Issue #341本文
 *   「Session expires_atをこの仮押さえ期限と一致させる」を、常に一致する構造で実現する。
 *   別々に計算した2つの期限を後から突き合わせて一致を祈る設計にしない）。
 */
'use strict';

var CardPayment = (function () {
  var CURRENCY_ = 'JPY';

  /*
   * 内部の仮押さえ時間（Issue #341本文の目安どおり30分）。expirePendingBookings等の
   * 既存カードTTL（Booking.CARD_TTL_HOURS=72h。旧Issue #334の「管理者承認待ち」運用向け）
   * とは別クロックとして扱う（Issue #341本文「旧『申込+72時間』のTTLはこのPENDINGには
   * 適用しない（専用の短いTTLを設ける）」）。PR-B/PR-Cで実際にこの値を使って
   * Stripe決済待ちPENDINGの失効処理を行う想定（本PR-Aではこの値を使った失効処理自体は
   * 実装しない）。
   */
  var CHECKOUT_HOLD_MINUTES = 30;

  /*
   * StripeのCheckout Session（mode=payment）は作成時刻から30分未満のexpires_atを
   * 受け付けない（ファイル冒頭コメント参照）。Session発行処理自体の遅延を吸収するため、
   * CHECKOUT_HOLD_MINUTESそのものではなく、この安全マージン分を上乗せした分数で
   * Stripeへ送るexpires_atを計算する。
   */
  var STRIPE_SESSION_EXPIRY_BUFFER_MINUTES = 5;

  /* PENDING（決済待ち）作成時刻から内部の仮押さえ期限（ミリ秒epoch）を計算する。 */
  function computeCheckoutHoldExpiryMillis(createdAtMillis) {
    return createdAtMillis + CHECKOUT_HOLD_MINUTES * 60000;
  }

  /*
   * PR-BがCheckout Session作成直前に呼ぶことを想定した、Stripeへ送るexpires_at
   * （Unix秒。Stripe APIの仕様に合わせて秒単位）。実際にStripeから返る値をこの計算値と
   * 食い違わせないよう、PR-B側はSession作成のレスポンスに含まれるexpires_atを内部の
   * 仮押さえ期限として保存し直すこと（ファイル冒頭コメント参照）。ここではあくまで
   * 送信用の計算値のみを提供する。
   */
  function computeStripeSessionExpiresAtSeconds(sessionCreationAtMillis) {
    var minutes = CHECKOUT_HOLD_MINUTES + STRIPE_SESSION_EXPIRY_BUFFER_MINUTES;
    return Math.floor((sessionCreationAtMillis + minutes * 60000) / 1000);
  }

  function isFinitePositiveInteger_(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && Math.round(value) === value;
  }

  function err_(code, message) {
    return { code: code, message: message };
  }

  /*
   * サーバー側の料金検証（Issue #341本文「クライアント送信の金額は信用しない」）。
   * Bookings台帳のrecordから、Stripeへ実際に請求すべき金額をBooking.
   * getEffectivePriceAmount（Issue #342/#343の既存料金基盤。管理者による確定前修正が
   * あればそちらを優先）経由で一意に決定する。料金が未計算（過去の予約や
   * BookingPricing側のエラー等でnullの場合）や整数円でない場合はfail-closedに
   * valid:falseを返す（金額不明・不正な金額のままCheckout Session発行やWebhook確認へ
   * 進めない）。
   */
  function computeExpectedPaymentAmount(record) {
    var amount = Booking.getEffectivePriceAmount(record);
    if (amount === null || !isFinitePositiveInteger_(amount)) {
      return { valid: false, error: err_('PRICE_NOT_AVAILABLE', '確定金額が計算されていないため、決済処理を開始できません。') };
    }
    return { valid: true, amountJpy: amount, currency: CURRENCY_ };
  }

  /*
   * **Checkout Session発行時点（PR-B）専用**の金額検証。渡された金額・通貨が、その時点の
   * サーバー側の確定金額（computeExpectedPaymentAmount。Booking.getEffectivePriceAmountの
   * 現在値）と一致するかを検証する。PR-BがStripeへ送信する金額を決定・防御的に再確認する
   * 用途であり、**PR-CのWebhook検証にはこの関数を使わないこと**（下記
   * verifyPaymentAgainstSnapshotのコメント参照。Issue #341 PR-Aレビュー対応・項目3）。
   */
  function verifyPaymentAmount(record, claimedAmountJpy, claimedCurrency) {
    var expected = computeExpectedPaymentAmount(record);
    if (!expected.valid) return expected;
    if (claimedCurrency !== expected.currency) {
      return { valid: false, error: err_('CURRENCY_MISMATCH', '決済通貨が' + expected.currency + 'と一致しません。') };
    }
    if (Number(claimedAmountJpy) !== expected.amountJpy) {
      return { valid: false, error: err_('AMOUNT_MISMATCH', '決済金額がサーバー計算額と一致しません。') };
    }
    return { valid: true, amountJpy: expected.amountJpy, currency: expected.currency };
  }

  /*
   * **Webhook受信時点（PR-C）専用**の金額検証（Issue #341 PR-Aレビュー対応・項目3）。
   *
   * verifyPaymentAmount/computeExpectedPaymentAmountは常に「その時点で」有効な確定金額
   * （priceAmount/priceOverrideAmount）を参照する。もしPR-Cのwebhook処理がこれを
   * そのまま使って決済結果を検証すると、Checkout Session発行**後**・Webhook到達**前**に
   * 管理者が料金を修正した場合（priceOverrideAmountの更新等）、Stripeが実際に請求・
   * 収受した金額（Session発行時点の金額のまま）と、Webhook処理時点で再計算した「現在の」
   * 確定金額が食い違い、**正常に完了した決済が誤ってAMOUNT_MISMATCHになってしまう**
   * （正当な決済を拒否し、自動確定を止めてしまう事故）。
   *
   * これを防ぐため、金額の正はCheckout Session発行**時点**で1回だけ確定し、
   * その値をBookings台帳の`stripeAmount`/`stripeCurrency`列へスナップショットとして
   * 保存する（PR-Bの責務。verifyPaymentAmountで検証した直後の値をそのまま
   * updateBookingPaymentStateAtomicで保存する）。PR-CのWebhook検証は、**その時点の
   * 確定金額を再計算するのではなく**、この関数でスナップショット（`record.stripeAmount`/
   * `record.stripeCurrency`）とWebhookの金額を突き合わせる。料金がその後修正されても、
   * 既に発行済みのSession・既に処理された決済の検証結果には一切影響しない。
   *
   * スナップショットが記録されていない予約（PR-Bがまだ実装されていない、または
   * Checkout Session発行前の予約）はfail-closedにvalid:falseを返す。
   */
  function verifyPaymentAgainstSnapshot(record, claimedAmountJpy, claimedCurrency) {
    var r = record || {};
    var snapshotAmount = r.stripeAmount;
    var snapshotCurrency = r.stripeCurrency;
    if (snapshotAmount === '' || snapshotAmount === null || snapshotAmount === undefined ||
        !snapshotCurrency || !isFinitePositiveInteger_(Number(snapshotAmount))) {
      return { valid: false, error: err_('SNAPSHOT_NOT_AVAILABLE', 'Checkout Session発行時点の金額スナップショットが記録されていません。') };
    }
    if (claimedCurrency !== snapshotCurrency) {
      return { valid: false, error: err_('CURRENCY_MISMATCH', '決済通貨がCheckout Session発行時点のスナップショットと一致しません。') };
    }
    if (Number(claimedAmountJpy) !== Number(snapshotAmount)) {
      return { valid: false, error: err_('AMOUNT_MISMATCH', '決済金額がCheckout Session発行時点のスナップショットと一致しません。') };
    }
    return { valid: true, amountJpy: Number(snapshotAmount), currency: snapshotCurrency };
  }

  /*
   * 決済試行ID（Issue #341本文「予約IDと一意な決済試行IDを発行し」）。bookingIdと同じく
   * uuidの一部を混ぜる方式（Booking.generateBookingIdと同方針。同時発行時の衝突可能性を
   * 下げつつ、人が見てbookingIdとの対応を追跡しやすい形にする）。Checkout Session発行時の
   * Stripe冪等キー（Idempotency-Key）や、Webhookのmetadataに含めて予約行との照合に使う
   * 想定（PR-B/PR-C）。再試行（FAILED→CHECKOUT_PENDING）のたびに新しいIDを発行し、
   * 同一IDでの二重Session発行を防ぐのはPR-B側のUrlFetchApp呼び出し時の責務とする
   * （このファイルはID発行のみを提供し、冪等性の実行そのものは持たない）。
   */
  function generatePaymentAttemptId(bookingId, uuid) {
    var uuidPart = String(uuid || '').replace(/-/g, '').slice(0, 12).toUpperCase();
    return 'PAY-' + String(bookingId || '') + '-' + uuidPart;
  }

  return {
    CHECKOUT_HOLD_MINUTES: CHECKOUT_HOLD_MINUTES,
    STRIPE_SESSION_EXPIRY_BUFFER_MINUTES: STRIPE_SESSION_EXPIRY_BUFFER_MINUTES,
    computeCheckoutHoldExpiryMillis: computeCheckoutHoldExpiryMillis,
    computeStripeSessionExpiresAtSeconds: computeStripeSessionExpiresAtSeconds,
    computeExpectedPaymentAmount: computeExpectedPaymentAmount,
    verifyPaymentAmount: verifyPaymentAmount,
    verifyPaymentAgainstSnapshot: verifyPaymentAgainstSnapshot,
    generatePaymentAttemptId: generatePaymentAttemptId
  };
})();
