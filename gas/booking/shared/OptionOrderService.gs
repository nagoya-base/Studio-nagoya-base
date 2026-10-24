/*
 * OptionOrderService.gs — 予約オプション（Issue #423）の業務フロー。
 *
 * 純粋ロジックはBookingOptions.gs、台帳はOptionOrderRepository.gsに分け、ここでは
 * Lock・Stripe・メールを組み合わせたオーケストレーションだけを行う。
 *
 * 【プロジェクトごとの利用箇所】
 * - Booking Web App: 申込（同時・後付け）・本人確認付きの照会・Stripe Checkout開始
 * - Booking Admin: 承認 / 不承認・資格付与・Webhook反映（決済成功・失敗）
 * どちらのプロジェクトにも同じファイルを配布する（README「デプロイ対象ファイル」参照）。
 *
 * 【原則】
 * - 親キーは既存のbookingId。新しい部屋予約は作らない・複製しない・ステータスを変更しない。
 *   部屋予約のstatus（Bookings）とオプション注文のstatus（OptionOrders）は完全に別。
 * - 後付けは「予約ID＋登録メールアドレス」の一致で本人確認する（予約IDだけでは操作できない）。
 *   不一致・未存在は区別せずFORBIDDEN（予約IDの存在確認に使わせない）。
 * - 金額はクライアントから受け取らない。注文作成時にサーバーが確定し、承認前のスタッフ対応
 *   には決してCheckoutを発行しない（isPayableがapprovalStatusを必ず見る）。
 * - 部屋予約がCONFIRMEDになるまでオプションのCheckoutは開始できない（部屋の初回Checkoutに
 *   オプション料金を混ぜない。部屋の決済スナップショット・Webhook金額照合と分離するため）。
 * - `STRIPE_CHECKOUT_ENABLED`を参照するだけで、変更・有効化は一切しない（無効ならfail-closed）。
 * - Webhook再送・二重承認・二重クリックでも二重反映・二重Checkoutにならない（冪等）。
 * - Recoveryへ記録するfailureTypeは必ず`OPTION_`で始める。`PAYMENT_`/`STRIPE_WEBHOOK_`で始めると
 *   RecoveryRepository.isPaymentFailureTypeに該当し、同じbookingIdの部屋予約の決済ゲート・
 *   来場案内判定に影響してしまうため。
 */
'use strict';

var OptionOrderService = (function () {
  var LOCK_TIMEOUT_MS_ = 10000;
  var MAX_ORDER_ID_RETRIES_ = 5;

  function isDateLike_(value) {
    return value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function nowOrDefault_(now) {
    return isDateLike_(now) ? now : new Date();
  }

  function fail_(code, message, extra) {
    var error = { code: code, message: message };
    if (extra) Object.keys(extra).forEach(function (k) { error[k] = extra[k]; });
    return { success: false, error: error };
  }

  var FORBIDDEN_ = function () { return fail_('FORBIDDEN', '予約が見つからないか、操作の権限がありません。'); };

  function normalizeEmail_(email) {
    return OptionOrderRepository.normalizeEmail(email);
  }

  /* 空文字同士は絶対に一致させない（BookingRepository.tokensMatch_と同方針）。 */
  function safeEquals_(a, b) {
    var x = String(a || '');
    var y = String(b || '');
    if (!x || !y || x.length !== y.length) return false;
    var diff = 0;
    for (var i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
    return diff === 0;
  }

  /* Bookings行のrecordを、BookingOptions・メールテンプレートが使う形に整える
     （record.dateはSheets上でDate値になり得るため文字列へ正規化する）。 */
  function toBookingView_(record) {
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var date = record.date;
    if (isDateLike_(date)) date = BookingAvailability.formatDateInTimezone(date, timezone) || '';
    return {
      bookingId: record.bookingId,
      brand: record.brand,
      status: record.status,
      name: record.name,
      email: record.email,
      date: date,
      startAt: record.startAt,
      endAt: record.endAt,
      timezone: timezone,
      /* 予約済みの部屋代。予約本体の正本（Booking.getEffectivePriceAmount）だけを使い、取得できなければnull。 */
      roomPriceJpy: Booking.getEffectivePriceAmount(record)
    };
  }

  function findBookingView_(bookingId) {
    if (typeof bookingId !== 'string' || !bookingId || bookingId.length > 64) return null;
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    return found ? toBookingView_(found.record) : null;
  }

  /* 予約IDと登録メールアドレスの両方が一致した場合のみ予約を返す。 */
  function verifyBookingIdentity_(bookingId, email) {
    var claimed = normalizeEmail_(email);
    if (!claimed || claimed.length > 254) return null;
    var view = findBookingView_(bookingId);
    if (!view || !safeEquals_(normalizeEmail_(view.email), claimed)) return null;
    return view;
  }

  /* 有料レンタル機材を含む申込か。含む場合だけ、Adminが付与した資格（管理者の利用許可）を照会する。 */
  function requiresEligibility_(normalized) {
    return Object.keys(normalized.equipment).some(function (code) {
      return BookingOptions.isLectureRequiredItem('EQ:' + code + ':1');
    });
  }

  /*
   * 機材コード単位の資格: **Adminが管理者が信用確認のうえ明示的に付与した利用許可のみ**を正とする
   * （Issue追加確定要件）。過去の利用履歴・支払い済み注文からは自動で資格ありと判定しない。
   * 別のビデオライト系機材の許可でも通さない。
   */
  function resolveEligibility_(email) {
    return {
      eligibleEquipmentCodes: BookingOptions.lectureRequiredEquipmentCodes().filter(function (code) {
        return OptionOrderRepository.hasEligibilityGrant(email, code);
      })
    };
  }

  /*
   * サーバー側の資格の再検証（Issue追加要件）。注文に含まれるビデオライト系機材のうち、現時点で
   * 管理者の利用許可（Admin付与）を確認できない機材コードを返す。申込時に通っていても、
   * 許可が取り消された・申込データが不正だった場合に、支払い・確定へ進ませないために使う。
   */
  function missingLectureCodes_(order) {
    var required = BookingOptions.lectureRequiredCodesOfItems(order.items);
    if (required.length === 0) return [];
    var eligible = resolveEligibility_(order.customerEmail).eligibleEquipmentCodes;
    return required.filter(function (code) { return eligible.indexOf(code) === -1; });
  }

  function notEligibleError_(codes) {
    return fail_('VIDEO_LIGHT_SELF_RENTAL_NOT_ELIGIBLE',
      codes.map(BookingOptions.equipmentLabel).join('・') + 'は施錠管理している有料レンタル機材のため、管理者の利用許可を得た方のみご利用いただけます。お支払いには進めません。メールでご相談ください。',
      { items: codes });
  }

  function activeExistingOrders_(bookingId) {
    return OptionOrderRepository.listByBookingId(bookingId).map(function (row) { return row.record; });
  }

  /* ---- カタログ・事前検証 ---- */

  function getCatalog(brand) {
    return BookingOptions.buildCatalog(brand, BookingConfig.getOptionsConfig());
  }

  /*
   * createBooking前の事前検証（副作用なし）。選択が不正・受付不可・資格なしなら、予約を作る
   * 前にエラーを返す（予約だけ作られてオプションが失敗する状況を減らす）。
   * options.allowEligibilityLookup(email): 資格の照会を行ってよいか（レート制限）を返す関数。
   *   Booking Web Appのみ渡す（RateLimiterはWeb App専用のため）。
   * 戻り値: { success:true, normalized, empty } | { success:false, error }
   */
  function preflightForNewBooking(brand, selection, email, options) {
    var normalizedResult = BookingOptions.normalizeSelection(selection);
    if (!normalizedResult.ok) return { success: false, error: normalizedResult.error };
    if (normalizedResult.empty) return { success: true, empty: true, normalized: normalizedResult.normalized };
    if (!BookingOptions.isBrandEnabled(brand)) {
      return fail_('OPTIONS_NOT_AVAILABLE', 'このブランドの予約ではオプションをお申し込みいただけません。');
    }
    var needsEligibility = requiresEligibility_(normalizedResult.normalized);
    var lookupAllowed = !needsEligibility || !options || typeof options.allowEligibilityLookup !== 'function' || options.allowEligibilityLookup(email) === true;
    if (!lookupAllowed) {
      return fail_('RATE_LIMITED', '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。');
    }
    var plan = BookingOptions.planOrders({
      normalized: normalizedResult.normalized,
      existingOrders: [],
      optionsConfig: BookingConfig.getOptionsConfig(),
      eligibility: needsEligibility ? resolveEligibility_(email) : { eligibleEquipmentCodes: [] }
    });
    if (!plan.ok) return { success: false, error: plan.error };
    return { success: true, empty: false, normalized: normalizedResult.normalized };
  }

  /* ---- 注文作成（同時申込・後付け共通） ---- */

  function newOptionOrderId_(usedIds) {
    for (var i = 0; i < MAX_ORDER_ID_RETRIES_; i++) {
      var candidate = BookingOptions.generateOptionOrderId(Utilities.getUuid());
      if (!usedIds[candidate]) return candidate;
    }
    return null;
  }

  function sendMailBestEffort_(booking, mail, label) {
    try {
      var mailConfig = BookingConfig.getMailConfig();
      MailApp.sendEmail({
        to: booking.email,
        subject: mail.subject,
        body: mail.body,
        name: mailConfig.displayName,
        replyTo: mailConfig.replyTo
      });
      return true;
    } catch (mailError) {
      /* 例外メッセージには宛先が含まれ得るため、種別のみ記録する。 */
      Logger.log('OptionOrderService: ' + label + 'メールの送信に失敗しました bookingId=' + booking.bookingId);
      return false;
    }
  }

  function notifyAdminPendingApprovalBestEffort_(booking, orders) {
    try {
      var adminEmail = BookingConfig.getAdminNotificationEmail();
      if (!adminEmail) return;
      var staff = orders.filter(function (o) {
        return o.category === BookingOptions.CATEGORY.STAFF_SERVICE || o.approvalStatus === BookingOptions.APPROVAL_STATUS.PENDING_APPROVAL;
      });
      if (staff.length === 0) return;
      var adminUrl = BookingConfig.getBookingAdminUrl();
      var lines = [
        '承認依頼が届きました（スタッフ対応の空き確認、または有料レンタル機材の利用許可の確認）。Booking Adminで承認（許可済みにして進める）または不承認にしてください。Checkoutは承認後にのみ発行されます。',
        '',
        'bookingId: ' + booking.bookingId,
        '利用日: ' + BookingAvailability.formatDateWithWeekday(booking.date)
      ];
      staff.forEach(function (o) {
        lines.push('optionOrderId: ' + o.optionOrderId + ' / ' + o.items.map(BookingOptions.describeItem).join('、') + ' / ' + o.amountJpy + '円');
      });
      if (adminUrl) { lines.push(''); lines.push('Booking Admin:'); lines.push(adminUrl); }
      lines.push('');
      lines.push('※お客様の氏名・連絡先は含めていません。');
      MailApp.sendEmail(adminEmail, '[' + Booking.getBrandLabel(booking.brand) + '] オプションの承認依頼: ' + booking.bookingId, lines.join('\n'));
    } catch (notifyError) {
      Logger.log('OptionOrderService: 管理者通知に失敗しました bookingId=' + booking.bookingId);
    }
  }

  /*
   * 注文の作成。bookingIdは既存（または直前に作成した）予約のもの。Lockを自分で取得する
   * （呼び出し側はLockを保持していないこと）。
   * source: BookingOptions.SOURCE.WITH_BOOKING / ADDON
   * 戻り値: { success:true, orders:[summary...] } | { success:false, error }
   */
  function createOrders(bookingId, normalized, source, now) {
    var effectiveNow = nowOrDefault_(now);
    var optionsConfig = BookingConfig.getOptionsConfig();

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return fail_('LOCK_TIMEOUT', '一時的に混み合っています。もう一度お試しください。');
    }
    var created;
    var booking;
    try {
      /* Lock内で予約の最新状態を読み直す（取消・利用開始との競合を避ける）。 */
      booking = findBookingView_(bookingId);
      var accepts = BookingOptions.checkBookingAcceptsOptions(booking, optionsConfig, effectiveNow);
      if (!accepts.ok) return { success: false, error: accepts.error };

      var existingRows = OptionOrderRepository.listAll();
      var existingForBooking = existingRows.map(function (r) { return r.record; }).filter(function (r) { return r.bookingId === bookingId; });
      var plan = BookingOptions.planOrders({
        normalized: normalized,
        existingOrders: existingForBooking,
        optionsConfig: optionsConfig,
        eligibility: requiresEligibility_(normalized) ? resolveEligibility_(booking.email) : { eligibleEquipmentCodes: [] }
      });
      if (!plan.ok) return { success: false, error: plan.error };
      if (plan.orders.length === 0) return fail_('NO_OPTIONS_SELECTED', '追加するオプションを選択してください。');

      var usedIds = {};
      existingRows.forEach(function (r) { usedIds[r.record.optionOrderId] = true; });
      var records = [];
      for (var i = 0; i < plan.orders.length; i++) {
        var order = plan.orders[i];
        var optionOrderId = newOptionOrderId_(usedIds);
        if (!optionOrderId) return fail_('INTERNAL_ERROR', '注文IDを発行できませんでした。もう一度お試しください。');
        usedIds[optionOrderId] = true;
        records.push({
          optionOrderId: optionOrderId,
          bookingId: bookingId,
          brand: booking.brand,
          category: order.category,
          source: source,
          items: order.items,
          amountJpy: order.amountJpy,
          currency: BookingOptions.CURRENCY,
          approvalStatus: order.approvalStatus,
          paymentStatus: order.paymentStatus,
          status: order.status,
          customerEmail: normalizeEmail_(booking.email),
          createdAt: effectiveNow,
          updatedAt: effectiveNow
        });
      }
      OptionOrderRepository.appendOrders(records);
      created = records;
    } finally {
      lock.releaseLock();
    }

    /* メール・管理者通知はLockの外・best effort（失敗しても申込自体は成立している）。 */
    var mail = OptionMailTemplates.buildOptionReceivedMail(booking, created, BookingConfig.getMailConfig());
    sendMailBestEffort_(booking, mail, '申込受付');
    notifyAdminPendingApprovalBestEffort_(booking, created);

    return { success: true, bookingId: bookingId, orders: created.map(BookingOptions.summarizeOrder), guidanceIncomplete: mail.guidanceIncomplete === true };
  }

  /* 本人確認付きの後付け申込。 */
  function submitAddonOptions(bookingId, email, selection, now) {
    var booking = verifyBookingIdentity_(bookingId, email);
    if (!booking) return FORBIDDEN_();
    var normalizedResult = BookingOptions.normalizeSelection(selection);
    if (!normalizedResult.ok) return { success: false, error: normalizedResult.error };
    if (normalizedResult.empty) return fail_('NO_OPTIONS_SELECTED', '追加するオプションを選択してください。');
    if (!BookingOptions.isBrandEnabled(booking.brand)) {
      return fail_('OPTIONS_NOT_AVAILABLE', 'この予約ではオプションをお申し込みいただけません。');
    }
    return createOrders(bookingId, normalizedResult.normalized, BookingOptions.SOURCE.ADDON, now);
  }

  /* 本人確認付きの照会（案内ページの表示用。氏名・メールアドレスは返さない）。 */
  function getCustomerSummary(bookingId, email, now) {
    var booking = verifyBookingIdentity_(bookingId, email);
    if (!booking) return FORBIDDEN_();
    var optionsConfig = BookingConfig.getOptionsConfig();
    var accepts = BookingOptions.checkBookingAcceptsOptions(booking, optionsConfig, nowOrDefault_(now));
    var orders = activeExistingOrders_(bookingId).map(BookingOptions.summarizeOrder);
    return {
      success: true,
      booking: {
        bookingId: booking.bookingId,
        brand: booking.brand,
        status: booking.status,
        date: booking.date,
        startTime: BookingAvailability.formatTimeInTimezone(booking.startAt, booking.timezone) || '',
        endTime: BookingAvailability.formatTimeInTimezone(booking.endAt, booking.timezone) || '',
        roomPriceJpy: booking.roomPriceJpy === undefined ? null : booking.roomPriceJpy
      },
      acceptsOptions: accepts.ok,
      acceptsOptionsReason: accepts.ok ? '' : accepts.error.code,
      /* 部屋予約が確定するまでオプションの決済は始められない。 */
      canPayNow: booking.status === 'CONFIRMED',
      orders: orders,
      catalog: BookingOptions.buildCatalog(booking.brand, optionsConfig)
    };
  }

  /* ---- Stripe Checkout（追加決済） ---- */

  function lineItemName_(order, bookingId) {
    var labels = (order.items || []).map(BookingOptions.describeItem).join('、');
    return ('オプション ' + labels + '（' + bookingId + '）').slice(0, 200);
  }

  function parseSnapshot_(json) {
    try {
      var parsed = JSON.parse(json);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function withLock_(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) return fail_('LOCK_TIMEOUT', '一時的に混み合っています。もう一度お試しください。');
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * addon用の戻り先URL。
   * - success: 部屋予約用の「予約はまだ確定していません」ページではなく、オプション専用の
   *   完了ページ（option-payment-complete.html）へ戻す。ブランド別URL（Issue #422）から
   *   導出し、導出できない場合（運営が独自パスを設定済み）はそのURLをそのまま使う。
   * - cancel: ブランドの予約ページ（…/booking/）配下のオプション案内ページへ戻す。
   * ブランド判定・導出不能時のfail-closedは既存のBooking.resolveCheckoutReturnUrlsに従う。
   */
  function deriveAddonReturnUrls_(brand, stripeConfig) {
    var base = Booking.resolveCheckoutReturnUrls(brand, stripeConfig);
    if (!base.ok) return base;
    var successUrl = base.successUrl.replace(/\/payment-complete\.html(?=$|[?#])/, '/option-payment-complete.html');
    var cancelUrl = base.cancelUrl;
    if (/\/booking\/$/.test(cancelUrl)) cancelUrl = cancelUrl + 'options/';
    return { ok: true, successUrl: successUrl, cancelUrl: cancelUrl };
  }

  /*
   * 追加決済のCheckout開始。本人確認（予約ID＋メール）→ 支払い可能な注文か → Stripe Session発行。
   * 戻り値: { success:true, checkoutUrl, optionOrderId } | { success:false, error }
   */
  function startOptionCheckout(bookingId, email, optionOrderId, now) {
    var effectiveNow = nowOrDefault_(now);
    var booking = verifyBookingIdentity_(bookingId, email);
    if (!booking) return FORBIDDEN_();
    if (typeof optionOrderId !== 'string' || !optionOrderId || optionOrderId.length > 40) return FORBIDDEN_();

    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.checkoutEnabled) {
      return fail_('CHECKOUT_DISABLED', '現在オンライン決済は受け付けていません。運営からの案内をお待ちください。');
    }
    if (!stripeConfig.secretKey) return fail_('CHECKOUT_NOT_CONFIGURED', '決済の設定が完了していません。');
    var returnUrls = deriveAddonReturnUrls_(booking.brand, stripeConfig);
    if (!returnUrls.ok) return fail_('CHECKOUT_NOT_CONFIGURED', '決済の設定が完了していません。');

    /* フェーズ1: 状態確認と、既存Sessionの再利用判断。 */
    var phase1 = withLock_(function () {
      var found = OptionOrderRepository.findByOptionOrderId(optionOrderId);
      if (!found || found.record.bookingId !== bookingId) return FORBIDDEN_();
      var order = found.record;
      var freshBooking = findBookingView_(bookingId);
      if (!freshBooking || freshBooking.status !== 'CONFIRMED') {
        return fail_('BOOKING_NOT_CONFIRMED', 'ご予約の確定後にお支払いいただけます。');
      }
      if (order.category === BookingOptions.CATEGORY.FREE) return fail_('NOT_PAYABLE', '無料のオプションはお支払い不要です。');
      if (order.status === BookingOptions.STATUS.CONFIRMED) return fail_('ALREADY_PAID', 'このオプションはお支払い済みです。');
      if (order.status === BookingOptions.STATUS.PENDING_APPROVAL) {
        return fail_('APPROVAL_REQUIRED', order.category === BookingOptions.CATEGORY.EQUIPMENT
          ? '有料レンタル機材は、管理者の利用許可の確認後にお支払いいただけます。確認をお待ちください。'
          : 'スタッフ対応は承認後にお支払いいただけます。承認をお待ちください。');
      }
      if (order.status === BookingOptions.STATUS.DECLINED) return fail_('ORDER_DECLINED', 'このスタッフ対応は対応できませんでした。');
      if (!BookingOptions.isPayable(order)) return fail_('NOT_PAYABLE', 'このオプションはお支払いの対象ではありません。');
      /* 資格の再検証: 許可を確認できないビデオライト系は、Stripeを呼ばず支払い不可（管理者が否認できる）。 */
      var missing1 = missingLectureCodes_(order);
      if (missing1.length > 0) return notEligibleError_(missing1);
      return { success: true, order: order };
    });
    if (!phase1.success) return phase1;
    var order1 = phase1.order;

    /* 既存の有効なSessionがあればそのURLを返す（二重Checkout生成防止）。 */
    if (order1.status === BookingOptions.STATUS.PAYMENT_PENDING && order1.stripeCheckoutSessionId) {
      var existing = StripeGateway.retrieveCheckoutSession(stripeConfig, order1.stripeCheckoutSessionId);
      if (!existing.ok) return fail_('CHECKOUT_LOOKUP_FAILED', '決済ページを確認できませんでした。しばらくしてから再度お試しください。');
      if (existing.session.paymentStatus === 'paid') {
        return fail_('ALREADY_PAID', 'お支払いは完了しています。確定のご案内メールをお待ちください。');
      }
      if (existing.session.status === 'open') {
        /* 有効なSessionが残っている間は新しいSessionを作らない（二重Checkout生成防止）。 */
        if (existing.session.url) return { success: true, checkoutUrl: existing.session.url, optionOrderId: optionOrderId };
        return fail_('CHECKOUT_LOOKUP_FAILED', '決済ページを確認できませんでした。しばらくしてから再度お試しください。');
      }
      /* 失効済み等（open以外）: 下の新規試行へ進む。 */
    }

    /* フェーズ2: 決済試行を台帳に予約する（Stripe呼び出しの前に。結果不明でも同じ試行を再利用できる）。 */
    var reserve = withLock_(function () {
      var found = OptionOrderRepository.findByOptionOrderId(optionOrderId);
      if (!found || found.record.bookingId !== bookingId || !BookingOptions.isPayable(found.record)) {
        return fail_('NOT_PAYABLE', 'このオプションはお支払いの対象ではありません。');
      }
      var order = found.record;
      var missing2 = missingLectureCodes_(order);
      if (missing2.length > 0) return notEligibleError_(missing2);
      /* 結果不明のまま残っている試行（Session ID未記録）は同じ試行ID・同じ要求内容で再送する
         （Stripeの冪等キーにより二重Sessionにならない）。 */
      var snapshot = order.paymentAttemptId && !order.stripeCheckoutSessionId ? parseSnapshot_(order.checkoutRequestJson) : null;
      var attemptId = order.paymentAttemptId;
      if (!snapshot) {
        attemptId = BookingOptions.generatePaymentAttemptId(optionOrderId, Utilities.getUuid());
        snapshot = {
          amountJpy: Number(order.amountJpy),
          currency: BookingOptions.CURRENCY,
          expiresAtSeconds: CardPayment.computeStripeSessionExpiresAtSeconds(effectiveNow.getTime()),
          successUrl: returnUrls.successUrl,
          cancelUrl: returnUrls.cancelUrl
        };
        OptionOrderRepository.updateOrder(optionOrderId, {
          paymentAttemptId: attemptId,
          checkoutRequestJson: JSON.stringify(snapshot),
          stripeCheckoutSessionId: '',
          stripePaymentIntentId: '',
          stripeAmount: snapshot.amountJpy,
          stripeCurrency: snapshot.currency,
          paymentStatus: BookingOptions.PAYMENT_STATUS.CHECKOUT_PENDING,
          status: BookingOptions.STATUS.PAYMENT_PENDING,
          updatedAt: effectiveNow
        });
      }
      return { success: true, order: order, attemptId: attemptId, snapshot: snapshot };
    });
    if (!reserve.success) return reserve;

    var reference = BookingOptions.buildCheckoutReference(
      { optionOrderId: optionOrderId, bookingId: bookingId }, reserve.attemptId, booking.brand);
    var createResult = StripeGateway.createCheckoutSession(stripeConfig, {
      bookingId: bookingId,
      brand: booking.brand,
      paymentAttemptId: reserve.attemptId,
      amountJpy: reserve.snapshot.amountJpy,
      currency: reserve.snapshot.currency,
      expiresAtSeconds: reserve.snapshot.expiresAtSeconds,
      successUrl: reserve.snapshot.successUrl,
      cancelUrl: reserve.snapshot.cancelUrl,
      customerEmail: booking.email,
      lineItemName: lineItemName_(reserve.order, bookingId),
      clientReferenceId: reference.clientReferenceId,
      extraMetadata: { orderType: reference.metadata.orderType, optionOrderId: reference.metadata.optionOrderId }
    }, 'optcheckout-' + reserve.attemptId);

    if (!createResult.ok) {
      var definitive = createResult.errorType === 'STRIPE_ERROR' || createResult.errorType === 'NOT_CONFIGURED';
      if (definitive) {
        /* 確定的な失敗: 試行を破棄して再試行可能な状態へ戻す。 */
        withLock_(function () {
          OptionOrderRepository.updateOrder(optionOrderId, {
            paymentAttemptId: '', checkoutRequestJson: '', stripeAmount: '', stripeCurrency: '',
            paymentStatus: BookingOptions.PAYMENT_STATUS.FAILED,
            status: BookingOptions.STATUS.AWAITING_PAYMENT,
            updatedAt: effectiveNow
          });
          return { success: true };
        });
        return fail_('CHECKOUT_FAILED', '決済ページを作成できませんでした。しばらくしてから再度お試しください。');
      }
      /* 結果不明: 試行は残す（次回同じ冪等キーで再送）。 */
      return fail_('CHECKOUT_UNCERTAIN', '決済ページの作成結果を確認できませんでした。しばらくしてから再度お試しください。二重にお支払いにならないよう、同じ手順で再度ご案内します。');
    }

    var session = createResult.session;
    var recorded = withLock_(function () {
      OptionOrderRepository.updateOrder(optionOrderId, {
        stripeCheckoutSessionId: session.id,
        updatedAt: effectiveNow
      });
      return { success: true };
    });
    if (!recorded.success) {
      /* Session自体は発行済み。Session ID未記録のままでも、Webhookはattempt IDで照合できる。 */
      Logger.log('OptionOrderService: Session IDの記録に失敗しました optionOrderId=' + optionOrderId);
    }
    return { success: true, checkoutUrl: session.url, optionOrderId: optionOrderId };
  }

  /* ---- Admin: 承認 / 不承認 / 資格付与 ---- */

  function adminView_(record) {
    var summary = BookingOptions.summarizeOrder(record);
    summary.bookingId = record.bookingId;
    summary.createdAt = record.createdAt;
    summary.approvedAt = record.approvedAt;
    summary.declinedAt = record.declinedAt;
    summary.declineReason = record.declineReason;
    summary.paidAt = record.paidAt;
    summary.paymentRecoveryRequiredAt = record.paymentRecoveryRequiredAt;
    summary.paymentRecoveryReason = record.paymentRecoveryReason;
    summary.stripePaymentIntentId = record.stripePaymentIntentId;
    summary.sourceLabel = record.source === BookingOptions.SOURCE.ADDON ? '後付け' : '予約と同時';
    summary.paidLabel = record.category === BookingOptions.CATEGORY.FREE ? '無料' : '有料';
    /* 管理者の利用許可を確認できない有料レンタル機材の未払い注文（Adminが否認できる）。 */
    var missing = (record.category === BookingOptions.CATEGORY.EQUIPMENT &&
      (record.status === BookingOptions.STATUS.PENDING_APPROVAL || record.status === BookingOptions.STATUS.AWAITING_PAYMENT || record.status === BookingOptions.STATUS.PAYMENT_PENDING))
      ? missingLectureCodes_(record) : [];
    summary.eligibilityMissing = missing.length > 0;
    summary.eligibilityMissingLabels = missing.map(BookingOptions.equipmentLabel);
    summary.canDeclineEligibility = summary.eligibilityMissing && record.status === BookingOptions.STATUS.AWAITING_PAYMENT;
    return summary;
  }

  function listForAdmin(bookingId) {
    var rows = OptionOrderRepository.listByBookingId(bookingId).map(function (r) { return adminView_(r.record); });
    var guidance = BookingOptions.renderSelfGuidance(
      OptionOrderRepository.listByBookingId(bookingId).filter(function (r) {
        return r.record.category === BookingOptions.CATEGORY.FREE && BookingOptions.isActiveStatus(r.record.status);
      }).reduce(function (acc, r) { return acc.concat(r.record.items); }, [])
    );
    return { orders: rows, guidanceIncomplete: guidance.incomplete };
  }

  function sendDecisionMail_(record, builder, label, now) {
    var booking = findBookingView_(record.bookingId);
    if (!booking) return;
    var mail = builder(booking, record, BookingConfig.getMailConfig());
    if (sendMailBestEffort_(booking, mail, label)) {
      try {
        OptionOrderRepository.updateOrder(record.optionOrderId, { decisionMailSentAt: now });
      } catch (e) {
        Logger.log('OptionOrderService: 通知済み時刻の記録に失敗しました optionOrderId=' + record.optionOrderId);
      }
    }
  }

  function decide_(optionOrderId, decision, reason, now) {
    var effectiveNow = nowOrDefault_(now);
    var outcome = withLock_(function () {
      var found = OptionOrderRepository.findByOptionOrderId(optionOrderId);
      if (!found) return fail_('ORDER_NOT_FOUND', '対象のオプション注文が見つかりません。');
      var order = found.record;
      var approving = decision === 'APPROVE';
      var isStaff = order.category === BookingOptions.CATEGORY.STAFF_SERVICE;
      var isEquipment = order.category === BookingOptions.CATEGORY.EQUIPMENT;
      /* 既に不承認済みの機材注文への再不承認は、何も変えずに現在の結果を返す（冪等）。 */
      if (!approving && isEquipment && order.status === BookingOptions.STATUS.DECLINED) {
        return { success: true, alreadyDecided: true, order: order };
      }
      /* 利用許可の確認待ちの機材注文（保留中）。承認＝許可済みにして進める。 */
      var isEligibilityHold = isEquipment && order.status === BookingOptions.STATUS.PENDING_APPROVAL;
      /* 承認済み／不承認済みの許可確認注文への再操作は、冪等な結果または状態遷移エラーを返す。 */
      var isApprovedHold = isEquipment && (order.approvalStatus === BookingOptions.APPROVAL_STATUS.APPROVED || order.approvalStatus === BookingOptions.APPROVAL_STATUS.DECLINED);
      /* 承認の対象はスタッフ対応と、許可確認待ちの機材注文。許可を確認できない未払いの機材注文
         （許可の取り消し等）は不承認のみできる。 */
      var isEligibilityDecline = !approving && isEquipment &&
        order.status === BookingOptions.STATUS.AWAITING_PAYMENT && missingLectureCodes_(order).length > 0;
      if (!isStaff && !isEligibilityHold && !isApprovedHold && !isEligibilityDecline) {
        return fail_('APPROVAL_NOT_REQUIRED', 'この注文は承認の対象ではありません。');
      }
      /* 請求額0円（セット無料の付帯機材のみ）の機材注文は、Adminの許可でそのまま確定する（Checkoutなし）。 */
      var freeOfCharge = approving && isEquipment && Number(order.amountJpy) === 0;
      var targetStatus = approving ? (freeOfCharge ? BookingOptions.STATUS.CONFIRMED : BookingOptions.STATUS.AWAITING_PAYMENT) : BookingOptions.STATUS.DECLINED;
      /* 二重承認・二重不承認は何も変えずに現在の結果を返す（冪等）。 */
      if (order.status === targetStatus) {
        return { success: true, alreadyDecided: true, order: order };
      }
      if (!BookingOptions.canTransition(order.status, targetStatus)) {
        return fail_('INVALID_TRANSITION', '現在の状態（' + order.status + '）からは' + (approving ? '承認' : '不承認') + 'できません。');
      }
      if (approving) {
        /* 承認の時点で部屋予約が取消・利用済みなら承認させない（決済に進めない注文を作らない）。 */
        var booking = findBookingView_(order.bookingId);
        var accepts = BookingOptions.checkBookingAcceptsOptions(booking, { addonDeadlineHoursBeforeStart: '' }, effectiveNow);
        if (!accepts.ok) return { success: false, error: accepts.error };
      }
      if (approving && isEligibilityHold) {
        /* 「許可済みにして進める」: 管理者の承認操作そのものが管理者の利用許可の付与。
           機材コード単位で許可を記録してから支払い可能な状態へ進める（二重付与しない）。 */
        missingLectureCodes_(order).forEach(function (code) {
          if (!OptionOrderRepository.hasEligibilityGrant(order.customerEmail, code)) {
            OptionOrderRepository.addEligibilityGrant(order.customerEmail, code, '管理者承認(オプション注文 ' + order.optionOrderId + ')', effectiveNow);
          }
        });
      }
      var fields = approving
        ? { approvalStatus: BookingOptions.APPROVAL_STATUS.APPROVED, status: targetStatus, approvedAt: effectiveNow }
        : { approvalStatus: BookingOptions.APPROVAL_STATUS.DECLINED, status: targetStatus, declinedAt: effectiveNow, declineReason: String(reason || '').slice(0, 200) };
      if (freeOfCharge) fields.paymentStatus = BookingOptions.PAYMENT_STATUS.NOT_REQUIRED;
      fields.updatedAt = effectiveNow;
      var updated = OptionOrderRepository.updateOrder(optionOrderId, fields);
      return { success: true, alreadyDecided: false, order: updated.record };
    });
    if (!outcome.success) return outcome;
    if (!outcome.alreadyDecided) {
      /* 通知は状態変更の成功後・Lockの外で1回だけ（再実行では送らない）。 */
      sendDecisionMail_(outcome.order,
        decision === 'APPROVE' ? OptionMailTemplates.buildOptionApprovedMail : OptionMailTemplates.buildOptionDeclinedMail,
        decision === 'APPROVE' ? '承認' : '不承認', effectiveNow);
    }
    return { success: true, alreadyDecided: outcome.alreadyDecided, order: adminView_(OptionOrderRepository.findByOptionOrderId(optionOrderId).record) };
  }

  function approveOrder(optionOrderId, now) {
    return decide_(optionOrderId, 'APPROVE', '', now);
  }

  function declineOrder(optionOrderId, reason, now) {
    return decide_(optionOrderId, 'DECLINE', reason, now);
  }

  /*
   * 有料レンタル機材のセルフレンタル許可。施錠管理のため、管理者が信用確認のうえセルフ利用可と
   * 確認した利用者にだけ、運営がAdminから付与する（これが資格の唯一の正本）。
   * 機材コード単位（例: COB_BICOLOR）。一括許可はしない。許可済みなら冪等。
   */
  function grantVideoLightEligibility(email, equipmentCode, note, now) {
    var normalized = normalizeEmail_(email);
    if (!Booking.isValidEmail(normalized)) return fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    if (BookingOptions.lectureRequiredEquipmentCodes().indexOf(equipmentCode) === -1) {
      return fail_('INVALID_EQUIPMENT', '許可の対象は有料レンタル機材の機材コードのみです。');
    }
    return withLock_(function () {
      if (OptionOrderRepository.hasEligibilityGrant(normalized, equipmentCode)) {
        return { success: true, alreadyGranted: true };
      }
      OptionOrderRepository.addEligibilityGrant(normalized, equipmentCode, note, nowOrDefault_(now));
      return { success: true, alreadyGranted: false };
    });
  }

  /* 許可の取り消し（機材コード単位）。取り消し後は申込・支払いの再検証で通らなくなる。 */
  function revokeVideoLightEligibility(email, equipmentCode) {
    var normalized = normalizeEmail_(email);
    if (!Booking.isValidEmail(normalized)) return fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    if (BookingOptions.lectureRequiredEquipmentCodes().indexOf(equipmentCode) === -1) {
      return fail_('INVALID_EQUIPMENT', '対象は有料レンタル機材の機材コードのみです。');
    }
    return withLock_(function () {
      return { success: true, revoked: OptionOrderRepository.removeEligibilityGrant(normalized, equipmentCode) };
    });
  }

  /* ---- Webhook反映（Booking Admin。StripeWebhookProcessorから呼ぶ） ---- */

  function recordOptionRecovery_(bookingId, failureType, status, message, now) {
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: failureType,
        occurredAt: now,
        calendarEventId: '',
        status: status || '',
        errorMessage: String(message || '').slice(0, 500),
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (e) {
      Logger.log('OptionOrderService: Recoveryへの記録に失敗しました bookingId=' + bookingId + ' failureType=' + failureType);
    }
  }

  function markRecoveryRequired_(optionOrderId, reason, now) {
    OptionOrderRepository.updateOrder(optionOrderId, {
      paymentRecoveryRequiredAt: now,
      paymentRecoveryReason: String(reason || '').slice(0, 300)
    });
  }

  /*
   * 追加決済の成功を注文へ反映する。session / paymentIntentはStripe APIから再取得済みの値。
   * 戻り値: { outcome, optionOrderId }
   *   outcome: 'CONFIRMED'（今回確定）/ 'ALREADY_APPLIED'（再送。何も変えない）/
   *            'ORDER_NOT_FOUND' / 'IDENTITY_MISMATCH' / 'AMOUNT_MISMATCH' / 'RECOVERY_REQUIRED' /
   *            'LOCK_TIMEOUT'（再試行すべき）
   */
  function applyAddonPaymentSucceeded(args) {
    var effectiveNow = nowOrDefault_(args.now);
    var session = args.session;
    var paymentIntent = args.paymentIntent;
    var metadata = (session && session.metadata) || {};
    var optionOrderId = typeof metadata.optionOrderId === 'string' ? metadata.optionOrderId : '';

    var result = withLock_(function () {
      var found = optionOrderId ? OptionOrderRepository.findByOptionOrderId(optionOrderId) : null;
      if (!found) return { outcome: 'ORDER_NOT_FOUND', optionOrderId: optionOrderId };
      var order = found.record;

      /* 「どの予約の、どの追加注文か」を、Session・metadata・台帳の三者で一意に照合する。 */
      var sessionMatches = !order.stripeCheckoutSessionId || order.stripeCheckoutSessionId === session.id;
      var identityOk = session.clientReferenceId === order.optionOrderId &&
        metadata.bookingId === order.bookingId &&
        metadata.orderType === BookingOptions.ORDER_TYPE_ADDON &&
        !!order.paymentAttemptId && metadata.paymentAttemptId === order.paymentAttemptId &&
        sessionMatches;
      if (!identityOk) {
        markRecoveryRequired_(order.optionOrderId, '決済成功イベントの識別子が注文の記録と一致しません。', effectiveNow);
        recordOptionRecovery_(order.bookingId, 'OPTION_IDENTITY_MISMATCH', '', 'optionOrderId=' + order.optionOrderId + ' sessionId=' + session.id, effectiveNow);
        return { outcome: 'IDENTITY_MISMATCH', optionOrderId: order.optionOrderId };
      }

      if (order.paymentStatus === BookingOptions.PAYMENT_STATUS.PAID) {
        if (order.stripePaymentIntentId === paymentIntent.id) {
          return { outcome: 'ALREADY_APPLIED', optionOrderId: order.optionOrderId };
        }
        markRecoveryRequired_(order.optionOrderId, '別のPaymentIntentで二重に支払われた可能性があります。', effectiveNow);
        recordOptionRecovery_(order.bookingId, 'OPTION_DUPLICATE_PAYMENT', '', 'optionOrderId=' + order.optionOrderId + ' paymentIntentId=' + paymentIntent.id, effectiveNow);
        return { outcome: 'RECOVERY_REQUIRED', optionOrderId: order.optionOrderId };
      }

      var verify = CardPayment.verifyPaymentAgainstSnapshot(
        { stripeAmount: order.stripeAmount, stripeCurrency: order.stripeCurrency }, paymentIntent.amountReceived, paymentIntent.currency);
      if (!verify.valid) {
        markRecoveryRequired_(order.optionOrderId, '決済金額がCheckout発行時点の金額と一致しません（' + verify.error.code + '）。', effectiveNow);
        recordOptionRecovery_(order.bookingId, 'OPTION_AMOUNT_MISMATCH', '', 'optionOrderId=' + order.optionOrderId + ' ' + verify.error.code, effectiveNow);
        return { outcome: 'AMOUNT_MISMATCH', optionOrderId: order.optionOrderId };
      }

      var paidFields = {
        paymentStatus: BookingOptions.PAYMENT_STATUS.PAID,
        stripePaymentIntentId: paymentIntent.id,
        stripeCheckoutSessionId: session.id,
        lastStripeEventId: args.eventId || '',
        paidAt: effectiveNow
      };

      /* 取消・不承認になった注文への遅延入金: 入金の事実は残し、確定にはせず運営へ回す。 */
      if (order.status === BookingOptions.STATUS.DECLINED || order.status === BookingOptions.STATUS.CANCELLED ||
          order.approvalStatus === BookingOptions.APPROVAL_STATUS.PENDING_APPROVAL) {
        OptionOrderRepository.updateOrder(order.optionOrderId, Object.assign(paidFields, {
          paymentRecoveryRequiredAt: effectiveNow,
          paymentRecoveryReason: '支払い対象外の状態（' + order.status + '）の注文に入金がありました。確認・返金判断が必要です。'
        }));
        recordOptionRecovery_(order.bookingId, 'OPTION_PAID_ORDER_NOT_PAYABLE', '', 'optionOrderId=' + order.optionOrderId + ' status=' + order.status, effectiveNow);
        return { outcome: 'RECOVERY_REQUIRED', optionOrderId: order.optionOrderId };
      }

      /* 資格の再検証: 支払い済みでも、管理者の利用許可を確認できない有料レンタル機材は確定にしない
         （入金の事実は保持して運営へ回す。自動確定・自動返金はしない）。 */
      var missingAtPayment = missingLectureCodes_(order);
      if (missingAtPayment.length > 0) {
        OptionOrderRepository.updateOrder(order.optionOrderId, Object.assign(paidFields, {
          paymentRecoveryRequiredAt: effectiveNow,
          paymentRecoveryReason: '有料レンタル機材の利用許可を確認できないため確定しませんでした: ' + missingAtPayment.join(',') + '。確認・返金判断が必要です。'
        }));
        recordOptionRecovery_(order.bookingId, 'OPTION_PAID_NOT_ELIGIBLE', '', 'optionOrderId=' + order.optionOrderId + ' codes=' + missingAtPayment.join(','), effectiveNow);
        return { outcome: 'RECOVERY_REQUIRED', optionOrderId: order.optionOrderId };
      }

      OptionOrderRepository.updateOrder(order.optionOrderId, Object.assign(paidFields, {
        status: BookingOptions.STATUS.CONFIRMED,
        updatedAt: effectiveNow
      }));

      /* 部屋予約が既に取消・期限切れの場合は、オプションは確定にするが運営へ知らせる。 */
      var booking = findBookingView_(order.bookingId);
      if (!booking || booking.status !== 'CONFIRMED') {
        recordOptionRecovery_(order.bookingId, 'OPTION_PAID_BOOKING_NOT_CONFIRMED', booking ? booking.status : '',
          'optionOrderId=' + order.optionOrderId + ' 部屋予約がCONFIRMEDではありません。返金要否を確認してください。', effectiveNow);
      }
      return { outcome: 'CONFIRMED', optionOrderId: order.optionOrderId };
    });

    if (result.success === false) {
      return { outcome: 'LOCK_TIMEOUT', optionOrderId: optionOrderId };
    }

    if (result.outcome === 'CONFIRMED') {
      /* 確定メールは1回だけ（confirmedMailSentAtで冪等化。再送では送らない）。 */
      var fresh = OptionOrderRepository.findByOptionOrderId(result.optionOrderId);
      if (fresh && !fresh.record.confirmedMailSentAt) {
        var booking = findBookingView_(fresh.record.bookingId);
        if (booking) {
          var mail = OptionMailTemplates.buildOptionConfirmedMail(booking, fresh.record, BookingConfig.getMailConfig());
          if (sendMailBestEffort_(booking, mail, '確定')) {
            try {
              OptionOrderRepository.updateOrder(result.optionOrderId, { confirmedMailSentAt: effectiveNow });
            } catch (e) {
              Logger.log('OptionOrderService: 確定通知済み時刻の記録に失敗しました optionOrderId=' + result.optionOrderId);
            }
          }
        }
      }
    }
    return result;
  }

  /* 非同期決済の失敗: 注文を再試行可能な状態へ戻す（確定にはしない）。 */
  function applyAddonPaymentFailed(args) {
    var effectiveNow = nowOrDefault_(args.now);
    var session = args.session;
    var metadata = (session && session.metadata) || {};
    var optionOrderId = typeof metadata.optionOrderId === 'string' ? metadata.optionOrderId : '';
    var result = withLock_(function () {
      var found = optionOrderId ? OptionOrderRepository.findByOptionOrderId(optionOrderId) : null;
      if (!found) return { outcome: 'ORDER_NOT_FOUND', optionOrderId: optionOrderId };
      var order = found.record;
      if (order.paymentStatus === BookingOptions.PAYMENT_STATUS.PAID) return { outcome: 'ALREADY_APPLIED', optionOrderId: optionOrderId };
      var isCurrent = order.paymentAttemptId && order.paymentAttemptId === metadata.paymentAttemptId &&
        order.status === BookingOptions.STATUS.PAYMENT_PENDING;
      if (!isCurrent) return { outcome: 'STALE', optionOrderId: optionOrderId };
      OptionOrderRepository.updateOrder(optionOrderId, {
        paymentStatus: BookingOptions.PAYMENT_STATUS.FAILED,
        status: BookingOptions.STATUS.AWAITING_PAYMENT,
        paymentAttemptId: '', checkoutRequestJson: '', stripeCheckoutSessionId: '',
        updatedAt: effectiveNow
      });
      return { outcome: 'MARKED_FAILED', optionOrderId: optionOrderId };
    });
    if (result.success === false) return { outcome: 'LOCK_TIMEOUT', optionOrderId: optionOrderId };
    return result;
  }

  return {
    getCatalog: getCatalog,
    preflightForNewBooking: preflightForNewBooking,
    createOrders: createOrders,
    submitAddonOptions: submitAddonOptions,
    getCustomerSummary: getCustomerSummary,
    startOptionCheckout: startOptionCheckout,
    listForAdmin: listForAdmin,
    approveOrder: approveOrder,
    declineOrder: declineOrder,
    grantVideoLightEligibility: grantVideoLightEligibility,
    revokeVideoLightEligibility: revokeVideoLightEligibility,
    applyAddonPaymentSucceeded: applyAddonPaymentSucceeded,
    applyAddonPaymentFailed: applyAddonPaymentFailed,
    verifyBookingIdentity_: verifyBookingIdentity_
  };
})();
