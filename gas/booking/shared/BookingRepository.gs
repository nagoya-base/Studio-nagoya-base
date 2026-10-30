/*
 * BookingRepository.gs — createBooking / confirmBooking / expirePendingBookingsの
 * オーケストレーション（Issue #268）。CalendarRepository・SpreadsheetRepository・
 * RecoveryRepository・RateLimiter・Bookingを組み合わせる、GAS実行環境依存の本体。
 *
 * このファイル自体は1つだが、実際にどの関数がどのGASプロジェクトから呼ばれるかは
 * プロジェクトによって異なる（README「GASプロジェクトへのデプロイ対象ファイル」参照）:
 * - createBooking: Booking Web Appプロジェクト（Code.gsのdoPostから）
 * - confirmBooking / expirePendingBookings / cancelBookingAdmin / updateBookingPrice:
 *   Booking Adminプロジェクト（BookingAdmin.gs / BookingTriggers.gsから。各関数とも同じ
 *   プロジェクト内で動くため、LockService.getScriptLock()を共有し、互いに直列化される。
 *   3回目レビューでconfirmBookingとexpirePendingBookingsを同一プロジェクトへ統合し、
 *   この2つの間のLock非共有によるCalendar/Sheets不整合の可能性を構造的に解消した。
 *   Issue #272でcancelBookingAdminも同じプロジェクト・同じLockServiceへ加えた。
 *   Issue #342で追加したupdateBookingPriceも同様（Calendar操作は行わないが、金額の
 *   読み取り→書き込みの一貫性のためLockを使う）。公開Web App側にはcancelBookingAdmin・
 *   updateBookingPriceのいずれも公開しない）
 *
 * createBookingの処理順（Issue #268本文どおり。Issue #342で料金計算を追加）:
 *   1. サーバー側入力検証        → Booking.validateCreateBookingInput
 *   2. 利用料金の自動計算        → BookingPricing.computeBookingPrice（Lockの外。
 *      副作用が一切ない時点で行うことで、失敗時にCalendar/Sheetsへ何も作らずに済む）
 *   3. abuse / rate limit確認    → RateLimiter.evaluate（Lockの外。ここで弾けばLock不要なため）
 *   4. LockService取得
 *   5. Calendarを最新状態で再取得 → CalendarRepository.getBusyIntervalsForDate
 *   6. 競合チェック              → BookingAvailability.isStartTimeBookable
 *   7. bookingId発行
 *   8. CalendarにPENDINGイベント作成
 *   9. Spreadsheet台帳へ保存（計算済みの料金を含む）
 *  10. Lock解除
 *  11. 管理者通知（Lockの外。通知失敗は予約失敗として扱わない）
 *
 * クリティカルセクション（Lockで保護する範囲）は5〜9のみ。入力検証・料金計算・
 * rate limit確認・通知はLockの外。
 *
 * 注意（README/PRにも明記）: LockServiceはこのGASプロジェクト内の同時実行同士の排他
 * だけを提供する。スペースマーケット側からの外部Calendar書き込みまではロックできない。
 * そのためLock取得後に必ずCalendarを再取得し、直前の空き状況を再確認してから
 * PENDINGイベントを作成する（「絶対に競合しない」ではなく「同一Calendarと直前再確認で
 * リスクを最小化する」設計）。この注意はcreateBooking（Booking Web App）対
 * スペースマーケット側の外部書き込みについてのみ当てはまる。confirmBooking対
 * expirePendingBookings（いずれもBooking Admin内）は同一LockServiceで直列化されるため、
 * この種の非同期な外部書き込みの問題は生じない。
 */
'use strict';

var BookingRepository = (function () {
  var LOCK_TIMEOUT_MS_ = 10000;
  var EXPIRE_LOCK_TIMEOUT_MS_ = 5000;

  /*
   * windowTier（Issue #480）: サーバー内部の呼び出し元だけが渡す第4引数。BookingWindow.TIER.ADMINのときだけ
   * 予約可能期間の上限を解除する（Booking Adminの認証済み管理者関数adminCreateBooking専用）。公開Web App
   * （Code.gs）は渡さず、リクエストの内容（予約メールアドレス・payload）から導出することも決してない。
   * ADMIN以外の値はすべて通常判定（一般30日／会員90日）。管理者でも営業時間・重複予約・料金などの検証は同じ。
   */
  function createBooking(rawInput, now, requestId, windowTier) {
    now = isDateLike_(now) ? now : new Date();
    var isAdminWindow = windowTier === BookingWindow.TIER.ADMIN;

    var availabilityConfig = BookingConfig.getAvailabilityConfig();
    var validation = Booking.validateCreateBookingInput(rawInput, availabilityConfig, now, isAdminWindow ? BookingWindow.TIER.ADMIN : undefined);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    var input = validation.normalized;

    /*
     * 利用料金の自動計算（Issue #342）。フロントエンドから金額が送られてきても一切
     * 信用せず、GAS側でBookingPricingを使って必ず再計算する（input.isMemberは
     * validateCreateBookingInputで既にfail-closed正規化済みの真偽値）。
     * Lock取得・Calendar/Sheets書き込みより前（副作用が一切ない時点）で行うことで、
     * 想定外の不整合（brand/date/durationMinutesはBooking.validateCreateBookingInputで
     * 既に検証済みのため通常は発生しない）で失敗した場合でもCalendarイベント等を
     * 一切作らずに済む。
     */
    /*
     * Issue #559: 料金世代の判定はBookingGenerationModeへ一元化した（緊急停止 ＞ 12/1前のTEST / LEGACY設定 ＞ サーバー時刻）。
     * テスト資格（rawInput.testCredential。Web AppのPOST本文）は予約メールに拘束して検証する。管理者の新規予約（ADMIN window）は
     * 資格を扱わない（Booking AdminはTEST資格を検証せず、緊急停止と時刻だけで判定する）。クライアントが世代・モードを指定する口は無い。
     */
    var generationDecision = BookingGenerationMode.decide(now, input.brand, isAdminWindow ? undefined : {
      testCredential: rawInput && typeof rawInput.testCredential === 'string' ? rawInput.testCredential : '',
      email: input.email
    });
    var priceGeneration = generationDecision.generation;
    if (generationDecision.source !== BookingGenerationMode.SOURCE.TIME || generationDecision.testCredential === BookingGenerationMode.CREDENTIAL.INVALID) {
      /* 非機密の監査ログ（世代の決まり方だけ。メール・資格・OTPは出さない）。 */
      Logger.log('requestId=' + sanitizeRequestId_(requestId) + ' generation=' + priceGeneration + ' source=' + generationDecision.source + ' testCredential=' + generationDecision.testCredential);
    }
    if (generationDecision.testCredential === BookingGenerationMode.CREDENTIAL.INVALID) {
      /* テスト資格の期限切れ・失効・メール変更・モード変更。料金・特典を黙って変えず、世代を取り直して入力し直してもらう。 */
      return { success: false, error: { code: 'TEST_CREDENTIAL_INVALID', message: 'テスト用の資格が無効になりました。ページを開き直し、日程と内容を選び直してください。' } };
    }
    /*
     * Issue #548: V2（SNB / mensの2026/12/1 0:00 JST以降に作成する直接予約）の会員機能（会員料金・会員限定特典・31〜90日先行予約）は、
     * メールOTPで確認済みの証明が有効な場合だけ開放する。V1/V2はサーバー時刻（generationAt）だけで決め、クライアント指定では切り替えない。
     * 証明を送ってきたのに期限切れ・不正・メール不一致の場合は、会員利用中かどうかにかかわらず、黙って一般扱いにせず再確認を要求する
     * （一般予約へ戻すのは利用者自身が証明を外して再送する明示操作）。管理者の新規予約（ADMIN window）は対象外。
     */
    var memberAuth = newMemberAuth_(rawInput, input, priceGeneration, now, isAdminWindow, generationDecision);
    if (memberAuth.rejection) {
      return { success: false, error: memberAuth.rejection };
    }
    /*
     * Issue #478: 会員限定2名ペアパック（独立プラン）。プラン指定がある場合のみ、ブランド・人数・料金世代と
     * actual membership（利用日の属する月の支払い事実。priceIsMember・mens経路では代用しない）を
     * サーバー側で必ず確認する。確認できなければ（非会員・利用月不一致・台帳エラーすべて）同一の
     * 外部向けエラーで拒否し、通常料金へ黙って倒さない。自動適用を求める予約は、対象外なら通常料金で受け付ける。明示プランを使う従来クライアントの拒否条件は維持する。
     */
    var planResult = resolvePlanForNewBooking_(input, priceGeneration, now, memberAuth, rawInput.autoPairPack === true);
    if (!planResult.ok) {
      return { success: false, error: planResult.error };
    }
    /*
     * Issue #668: SNB mensの大人数利用（5〜7名）。8名以上・「5名以上・要相談」等はここで拒否する（mens以外は対象外で従来どおり）。
     * 5〜7名は予約代表者のSNB MEMBER資格（メールOTP確認済み＋利用日の実会員資格）・オンラインカード決済・提供開始後の利用日を必須とし、
     * 即時決済せず運営の事前承認待ち（Calendarは仮押さえ）で受け付ける。確認できなければ4名扱いへ倒さず拒否する。
     */
    var largePartyResult = resolveLargePartyForNewBooking_(input, planResult.plan, now, memberAuth, isAdminWindow);
    if (!largePartyResult.ok) {
      return { success: false, error: largePartyResult.error };
    }
    var isLargeParty = largePartyResult.largeParty === true;
    var membership = BookingPricing.isMemberPlan(planResult.plan)
      ? { isMember: true, status: 'ACTIVE' }
      : (isLargeParty ? { isMember: input.isMember, status: 'ACTIVE' } : resolveMembershipForPricing_(input, priceGeneration, memberAuth));
    var priceResult = BookingPricing.computeBookingPrice({
      people: input.people,
      brand: input.brand,
      date: input.date,
      durationMinutes: input.durationMinutes,
      isMember: membership.isMember,
      generation: priceGeneration,
      plan: planResult.plan,
      startTime: input.startTime,
      supportServices: input.supportServices,
      supportEquipment: input.supportEquipment
    });
    if (!priceResult.valid) {
      return { success: false, error: priceResult.error };
    }
    var isPhotoSupportBooking = BookingPricing.isPhotoSupport(planResult.plan);
    /* Issue #667: 有料機材（supportEquipment）は作品撮りサポートでだけ選べる。他のプラン・通常予約へは付けられない（黙って無視せず拒否）。 */
    if (!isPhotoSupportBooking && input.supportEquipment && Object.keys(input.supportEquipment).length > 0) {
      return { success: false, error: { code: 'OPTIONS_NOT_AVAILABLE', message: '有料機材は、作品撮りサポートプランでのみお申し込みいただけます。' } };
    }

    /*
     * 予約オプション（Issue #423。Studio X限定）の事前検証。payloadにoptionsが無い場合は
     * 何もせず、既存の予約作成の挙動・レスポンスは一切変わらない。選択が不正・受付不可・
     * 資格なし（ビデオライトの初回利用者等）の場合は、Calendar/Sheetsへ何も書く前に拒否する。
     * rate limitの計上より前に行う（オプションの選び直しで再送しても「連投」扱いにならないよう、
     * 拒否した申込は計上しない）。代わりに、有料レンタル機材の利用許可（管理者の利用許可）の照会だけは
     * メールアドレス単位で別枠に制限する（許可の有無を無制限に探られないようにするため）。
     */
    var hasOptionsPayload = !!rawInput && rawInput.options !== undefined && rawInput.options !== null;
    /* Issue #496: 6時間貸切ベースプランは追加オプションと併用できない。フロントの解除漏れがあっても、
       プランにオプションが紐づく予約を作らない（Calendar/Sheetsへ何も書く前に明示エラーで拒否する）。 */
    if (hasOptionsPayload && BookingPricing.isEventPlan(planResult.plan) && BookingPricing.hasOptionSelection(rawInput.options)) {
      return { success: false, error: BookingPricing.eventPlanOptionsError() };
    }
    /* Issue #667: 作品撮りサポートプランは部屋料金を置き換える商品のため、シャワー等の同時オプション申込とは併用しない
       （有料機材は共通機材カタログの別注文。承認後に申し込む）。 */
    if (hasOptionsPayload && isPhotoSupportBooking && BookingPricing.hasOptionSelection(rawInput.options)) {
      return { success: false, error: { code: 'PHOTO_SUPPORT_OPTIONS_NOT_ALLOWED', message: BookingPricing.PHOTO_SUPPORT_LABEL + 'では、予約と同時のオプション申込はできません。' } };
    }
    /* Issue #586: シャワーパックはシャワー1回込みの商品。シャワーの申込（連絡事項の確認を含む）が無い予約は作らない
       （シャワー込みの金額だけ請求して、シャワーの事前確認が始まらない状態を作らない）。 */
    if (BookingPricing.isShowerPack(planResult.plan) &&
        !(hasOptionsPayload && rawInput.options && rawInput.options.shower === true)) {
      return { success: false, error: { code: 'SHOWER_PACK_SHOWER_REQUIRED', message: BookingPricing.SHOWER_PACK_LABEL + 'には、シャワー利用の事前確認のお申し込みが必要です。' } };
    }
    if (isAdminWindow && hasOptionsPayload) {
      /* 管理者の新規予約はお部屋の予約のみ（オプションの申込・本人確認・rate limitは公開経路の仕組み）。 */
      return { success: false, error: { code: 'OPTIONS_NOT_SUPPORTED', message: '管理者の新規予約ではオプションを同時に申し込めません。' } };
    }
    var optionsPreflight = hasOptionsPayload
      ? OptionOrderService.preflightForNewBooking(input.brand, rawInput.options, input.email, {
        date: input.date,
        now: now,
        /* Issue #548: V2のSNB / mensは、会員限定オプション（シャワー等）にもメールOTPの確認済み証明が必須。 */
        memberVerificationRequired: memberAuth.required,
        memberVerified: memberAuth.verified,
        showerIncluded: BookingPricing.isShowerPack(planResult.plan),
        allowEligibilityLookup: function (email) {
          return RateLimiter.limitByKey('opt_elig_' + String(email).trim().toLowerCase(), 10, 5, now.getTime());
        }
      })
      : { success: true, empty: true };
    if (!optionsPreflight.success) {
      return { success: false, error: optionsPreflight.error };
    }

    var rateLimitConfig = BookingConfig.getRateLimitConfig();
    /* 認証済み管理者の操作は公開フォーム向けのrate limitの対象外（RateLimiter.gsは公開Web Appのみに配布）。 */
    var rateLimitResult = isAdminWindow ? { allowed: true } : RateLimiter.evaluate(input, rateLimitConfig, now.getTime());
    if (!rateLimitResult.allowed) {
      return {
        success: false,
        error: {
          code: 'RATE_LIMITED',
          message: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。',
          reason: rateLimitResult.reason
        }
      };
    }

    /*
     * 予約可能期間（Issue #480）。一般30日を超える日（〜90日）は、予約作成時点（JSTの当日）の当月
     * actual membershipがある場合のみ受け付ける。利用日の月ではない（90日前には利用月の会費がまだ無いため）。
     * priceIsMember・mens料金優遇・自己申告isMemberは使わない。台帳エラーはfail-closed（拒否）。
     * 会員有無を探られないよう、非会員・台帳エラーは同一のエラーを返し、判定はrate limit計上後に行う。
     * 予約成立後に退会しても、この予約自体は維持される（ここでしか判定しない）。
     */
    var windowResult = isAdminWindow ? { ok: true } : verifyBookingWindowForNewBooking_(input, availabilityConfig, now, memberAuth);
    if (!windowResult.ok) {
      return { success: false, error: windowResult.error };
    }

    /*
     * Issue #563: Studio Xの認証フェーズTEST（有効なテスト資格付き）は**ドライラン**。ここまでの検証（入力・料金・OTP証明・予約期間・オプション・
     * 会員資格・営業時間内の空き）はすべて本番と同じ判定で行い、Calendar・Bookings・オプション注文・メール・Stripeへは一切書かない
     * （テスト認証が本番の予約・通知・課金・特典へ流入しない）。応答は dryRun:true の模擬結果（bookingIdはDRYRUN-で始まり、実在しない）。
     * 予約後の機能（後付けオプション等）は実予約でしか検証できないため、本番切替後の確認項目（README）で行う。
     */
    if (!isAdminWindow && input.brand === 'studio_x' && generationDecision.testCredential === BookingGenerationMode.CREDENTIAL.VALID) {
      var dryBusy = CalendarRepository.getBusyIntervalsForDate(BookingConfig.getCalendarId(), input.date, availabilityConfig.timezone);
      if (!BookingAvailability.isStartTimeBookable(BookingAvailability.parseTimeToMinutes(input.startTime), input.durationMinutes, dryBusy, availabilityConfig.bufferMinutes)) {
        return { success: false, error: { code: 'SLOT_CONFLICT', message: '指定の時間帯はすでに埋まっています。空き状況を確認して再度お試しください。' } };
      }
      return {
        success: true,
        dryRun: true,
        bookingId: 'DRYRUN-' + Utilities.getUuid().replace(/-/g, '').substring(0, 8).toUpperCase(),
        status: 'TEST_DRY_RUN',
        date: input.date,
        startTime: input.startTime,
        durationMinutes: input.durationMinutes,
        brand: input.brand,
        people: input.people,
        paymentMethod: input.paymentMethod,
        checkoutAccessToken: '',
        memberAuthRequired: memberAuth.required,
        memberVerified: memberAuth.verified,
        price: {
          amount: priceResult.price.amount, currency: priceResult.price.currency, tier: priceResult.price.tier,
          isMember: priceResult.price.isMember, dayType: priceResult.price.dayType, plan: priceResult.price.plan
        }
      };
    }

    var calendarId = BookingConfig.getCalendarId();
    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return {
        success: false,
        error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' }
      };
    }

    var bookingId;
    var eventId;
    var record;
    try {
      var busyIntervals = CalendarRepository.getBusyIntervalsForDate(calendarId, input.date, availabilityConfig.timezone);
      var startMinutes = BookingAvailability.parseTimeToMinutes(input.startTime);
      var bookable = BookingAvailability.isStartTimeBookable(
        startMinutes,
        input.durationMinutes,
        busyIntervals,
        availabilityConfig.bufferMinutes
      );
      if (!bookable) {
        return {
          success: false,
          error: { code: 'SLOT_CONFLICT', message: '指定の時間帯はすでに埋まっています。空き状況を確認して再度お試しください。' }
        };
      }

      bookingId = Booking.generateBookingId(input.brand, input.date, Utilities.getUuid());

      /*
       * PR #354レビュー対応（Issue #341 PR-B）: bookingIdだけでCheckout Sessionの発行・
       * 再取得ができてしまう脆弱性を修正するため、カード決済のみ推測困難な決済開始
       * トークン（Utilities.getUuid()。bookingId生成用のuuidとは別に発行する。bookingId
       * 自体はuuidの一部8桁のみを使うため単独では強度が足りない）を発行し、台帳へ保存する。
       * このトークンはcreateBookingのレスポンスで一度だけ本人（送信したブラウザ）へ返し、
       * BookingRepository.beginCardCheckoutが呼び出し元の主張する値と一致することを
       * 必須で検証する（tokensMatch_参照）。現金・PayPayは常に空文字のまま
       * （空文字同士は絶対に一致させない設計。tokensMatch_参照）。
       */
      var checkoutAccessToken = Booking.isCardPaymentMethod(input.paymentMethod) ? Utilities.getUuid() : '';

      eventId = CalendarRepository.createBookingEvent(calendarId, {
        date: input.date,
        startTime: input.startTime,
        durationMinutes: input.durationMinutes,
        timezone: availabilityConfig.timezone,
        bookingId: bookingId,
        brand: input.brand,
        planCode: priceResult.price.plan
      });

      var startAt = CalendarRepository.parseDateTime(input.date, input.startTime, availabilityConfig.timezone);
      var endAt = new Date(startAt.getTime() + input.durationMinutes * 60000);

      record = {
        bookingId: bookingId,
        createdAt: now,
        date: input.date,
        startAt: startAt,
        endAt: endAt,
        brand: input.brand,
        customerType: input.customerType,
        name: input.name,
        email: input.email,
        phone: input.phone,
        people: input.people,
        purpose: input.purpose,
        paymentMethod: input.paymentMethod,
        /* Issue #341でpaymentStatusの意味を転用。作成直後はカード・現地払いいずれも
           決済フロー未着手のためNOT_STARTED（カードのみPR-B以降でCHECKOUT_PENDING等へ
           遷移し得る。現地払いは以後もこの列を更新しない）。 */
        paymentStatus: Booking.PAYMENT_STATUS.NOT_STARTED,
        status: Booking.STATUS.PENDING,
        calendarEventId: eventId,
        source: input.source,
        note: input.note,
        priceAmount: priceResult.price.amount,
        priceTier: priceResult.price.tier,
        priceDayType: priceResult.price.dayType,
        priceIsMember: priceResult.price.isMember,
        priceComputedAt: now,
        priceGeneration: priceResult.price.generation,
        membershipStatus: membership.status,
        planCode: priceResult.price.plan,
        checkoutAccessToken: checkoutAccessToken,
        largeParty: isLargeParty ? true : '',
        partySurcharge: isLargeParty ? priceResult.price.partySurcharge : '',
        largePartyApprovalStatus: isLargeParty ? Booking.LARGE_PARTY_APPROVAL.PENDING_APPROVAL : '',
        largePartyApprovedAt: '',
        largePartyPaymentDueAt: ''
      };
      if (isPhotoSupportBooking) {
        /* Issue #667: 申込時点で対象時間帯をPENDINGとして仮押さえ（Calendarイベント作成済み）。承認前は決済できない。 */
        record.supportServices = priceResult.price.supportServices;
        record.supportRoomAmount = priceResult.price.roomAmount;
        record.supportStaffAmount = priceResult.price.staffAmount;
        record.supportEquipment = priceResult.price.equipmentItems.join(',');
        record.supportEquipmentAmount = priceResult.price.equipmentAmount;
      }

      try {
        SpreadsheetRepository.appendBooking(record);
      } catch (sheetsError) {
        return handleSheetsSaveFailure_(calendarId, bookingId, eventId, sheetsError, requestId, input);
      }
    } finally {
      lock.releaseLock();
    }

    /*
     * 利用者向けPENDINGメール・管理者通知はいずれもbooking Lockの外・best effortで行う
     * （Issue #271「11. createBookingへの接続」）。どちらかが失敗してもcreateBooking自体は
     * success:trueのまま返す。
     */
    /*
     * Issue #445: オンラインクレジットカードでCheckoutが有効な場合は、この時点ではまだ
     * Checkout Session（checkoutUrl・paymentHoldExpiresAt）が存在しないため、受付メールを
     * ここでは送らない。Session作成成功後にbeginCardCheckoutが、実際の決済URL・支払期限入りの
     * 支払い案内メールを1通だけ送る（役割の重複を避ける）。Checkout無効・設定不足の場合は
     * Sessionが作られないため、従来どおりこの時点で受付メールを送る。
     */
    if (!shouldDeferPendingMailToCheckout_(record)) {
      notifyCustomerPendingBestEffort_(record);
    }
    /* 管理者自身が作成した予約は管理者通知メールを送らない（AdminNotifier.gsは公開Web Appのみに配布）。 */
    if (!isAdminWindow) notifyAdminBestEffort_(record);

    /*
     * オプション注文は既存のbookingIdを親キーとして紐付ける（Issue #423）。部屋予約はここまでで
     * 成立済みのため、注文の保存に失敗しても予約自体は成功のまま返し、結果をoptionsに載せる
     * （利用者は案内ページから同じ予約IDでオプションを追加し直せる）。オプションの決済は
     * 部屋予約のCheckoutとは別（部屋の確定後に追加Checkout）。
     */
    var optionsResponse = null;
    if (!optionsPreflight.empty) {
      optionsResponse = createOptionOrdersForNewBookingBestEffort_(bookingId, optionsPreflight.normalized, now);
    }

    var response = {
      success: true,
      bookingId: bookingId,
      status: Booking.STATUS.PENDING,
      date: input.date,
      startTime: input.startTime,
      durationMinutes: input.durationMinutes,
      brand: input.brand,
      people: input.people,
      paymentMethod: input.paymentMethod,
      /*
       * PR #354レビュー対応: startCardCheckoutを呼ぶ権限を証明するための決済開始
       * トークン。カード決済のみ非空文字（上記checkoutAccessToken参照）。このレスポンスは
       * 送信した本人のブラウザにのみ返る値であり、これ以外の経路（Bookings台帳の閲覧権限を
       * 持たない一般の第三者）へは公開しない。
       */
      checkoutAccessToken: checkoutAccessToken,
      /*
       * 仮予約完了画面（Issue #342）はこのpriceを使う。フォーム側が送信直前に取得した
       * 見積り値ではなく、GASがcreateBooking内で確定・保存した金額（record.priceAmount
       * と同じ値）を必ず返す。
       */
      price: {
        amount: priceResult.price.amount,
        currency: priceResult.price.currency,
        tier: priceResult.price.tier,
        isMember: priceResult.price.isMember,
        dayType: priceResult.price.dayType,
        plan: priceResult.price.plan
      }
    };
    if (isPhotoSupportBooking) {
      /* Issue #667: フロントが「承認待ち（決済はまだ）」を示すための段階。決済ページへは進めない。 */
      response.supportStage = Booking.photoSupportStage(record);
      response.price.supportServices = priceResult.price.supportServices;
      response.price.roomAmount = priceResult.price.roomAmount;
      response.price.staffAmount = priceResult.price.staffAmount;
      response.price.equipmentAmount = priceResult.price.equipmentAmount;
    }
    if (optionsResponse) response.options = optionsResponse;
    if (isLargeParty) {
      /* Issue #668: 承認待ち。まだ決済へ進まない（承認後に案内メールのリンクから24時間以内に支払う）。checkoutAccessTokenは返さない。 */
      response.largeParty = true;
      response.approvalRequired = true;
      response.approvalStatus = Booking.LARGE_PARTY_APPROVAL.PENDING_APPROVAL;
      response.checkoutAccessToken = '';
      response.price.baseAmount = priceResult.price.baseAmount;
      response.price.partySurcharge = priceResult.price.partySurcharge;
    }
    return response;
  }

  /*
   * SNB mens大人数利用（Issue #668）の申込検証。戻り値: { ok:true, largeParty:boolean } | { ok:false, error }。
   * 確認順: ブランド（mens以外は対象外） → 人数（8名以上・数値以外は拒否） → 5〜7名でなければ通常予約 →
   * 利用日（2026/12/1以降） → 独立プランとの併用不可 → オンラインカード決済 → 管理者の新規予約は不可 →
   * メールOTPの確認済み証明（V2） → 照会のレート制限 → actual membership。
   * 会員の有無を探れないよう、資格関連の失敗は常に同一のコード・メッセージで返す。同行者の会員資格は問わない。
   */
  function resolveLargePartyForNewBooking_(input, plan, now, memberAuth, isAdminWindow) {
    if (input.brand !== 'mens') return { ok: true, largeParty: false };
    if (!BookingPricing.isMensPartySizeAllowed(input.people)) {
      return { ok: false, error: { code: 'PARTY_SIZE_EXCEEDED', message: 'SNB mensのご利用人数は1〜' + BookingPricing.LARGE_PARTY_MAX_PEOPLE + '名です。' + (BookingPricing.LARGE_PARTY_MAX_PEOPLE + 1) + '名以上のご利用はお受けできません。' } };
    }
    if (!BookingPricing.isLargePartyPeople(input.people)) return { ok: true, largeParty: false };
    if (!BookingPricing.isLargePartyAvailableOnDate(input.date)) {
      return { ok: false, error: { code: 'LARGE_PARTY_NOT_AVAILABLE', message: '5〜7名でのご利用は2026年12月1日以降のご利用日からお申し込みいただけます。' } };
    }
    if (plan) {
      return { ok: false, error: { code: 'LARGE_PARTY_PLAN_NOT_COMBINABLE', message: '5〜7名のご利用は、他のプランとは併用できません。' } };
    }
    if (isAdminWindow) {
      return { ok: false, error: { code: 'LARGE_PARTY_ADMIN_NOT_SUPPORTED', message: '5〜7名の大人数利用は、利用者本人のお申し込みから承認の手続きで受け付けます。' } };
    }
    if (!Booking.isCardPaymentMethod(input.paymentMethod)) {
      return { ok: false, error: { code: 'LARGE_PARTY_CARD_REQUIRED', message: '5〜7名のご利用は、承認後のオンラインクレジットカード決済でのお支払いとなります。' } };
    }
    if (memberAuth && memberAuth.required && !memberAuth.verified) return { ok: false, error: memberAuth.requiredError };
    var lookupAllowed = RateLimiter.limitByKey('opt_elig_' + MembershipRules.normalizeEmail(input.email), 10, 5, now.getTime());
    if (lookupAllowed !== true) {
      return { ok: false, error: { code: 'RATE_LIMITED', message: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。' } };
    }
    if (actualMembershipStatus_(input) !== 'ACTIVE') {
      return { ok: false, error: { code: 'LARGE_PARTY_MEMBER_ONLY', message: '5〜7名でのご利用は、ご利用日にSNB MEMBER資格のある方（予約代表者）が対象です。会員登録と同じメールアドレスでお申し込みください。' } };
    }
    return { ok: true, largeParty: true };
  }

  /*
   * 会員限定2名ペアパック（Issue #478）の申込検証。戻り値: { ok:true, plan:'' | 'member_pair_3h' } | { ok:false, error }。
   * 確認順: プラン値 → ブランド/料金世代 → 人数（3名以上はサーバー側で拒否） → 照会のレート制限 → actual membership。
   * 会員の有無を任意のメールで探れないよう、資格関連の失敗は常に同一のコード・メッセージで返す。
   */
  function resolvePlanForNewBooking_(input, generation, now, memberAuth, automatic) {
    var plan = BookingPricing.normalizePlan(input.plan);
    if (plan === null) {
      return { ok: false, error: { code: 'INVALID_PLAN', message: 'プランの指定が正しくありません。' } };
    }
    if (automatic && !BookingPricing.isEventPlan(plan) && !BookingPricing.isShowerPack(plan) && !BookingPricing.isPhotoSupport(plan)) {
      if ((input.brand !== 'snb' && input.brand !== 'mens') ||
          !BookingPricing.isPairPackAvailableOnDate(input.date) ||
          !BookingPricing.isPairPackPeople(input.people) || Number(input.durationMinutes) < 180 ||
          (memberAuth && memberAuth.required && !memberAuth.verified)) {
        return { ok: true, plan: '' };
      }
      plan = BookingPricing.PLAN.MEMBER_PAIR_3H;
    }
    if (!plan) return { ok: true, plan: '' };
    if (BookingPricing.isEventPlan(plan)) return resolveEventPlanForNewBooking_(input, plan);
    if (BookingPricing.isShowerPack(plan)) return resolveShowerPackForNewBooking_(input, now, memberAuth);
    if (BookingPricing.isPhotoSupport(plan)) return resolvePhotoSupportForNewBooking_(input, now, memberAuth);
    /* Issue #539: 提供可否は予約作成日（料金世代）ではなく利用日（2026/12/1以降）で判定する。 */
    if ((input.brand !== 'snb' && input.brand !== 'mens') || !BookingPricing.isPairPackAvailableOnDate(input.date)) {
      return { ok: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
    }
    if (!BookingPricing.isPairPackPeople(input.people)) {
      return { ok: false, error: { code: 'PAIR_PACK_PEOPLE_EXCEEDED', message: '2名ペアパックのご利用は1〜2名までです。' } };
    }
    if (Number(input.durationMinutes) < BookingPricing.PAIR_PACK_BASE_HOURS * 60) {
      return { ok: false, error: { code: 'PLAN_DURATION_INVALID', message: '2名ペアパックは3時間以上でご利用ください。' } };
    }
    /* Issue #548: V2のSNB / mensは、メールOTPの確認済み証明が無ければ会員台帳を見ずに確認を要求する（V1は従来どおり）。 */
    if (memberAuth && memberAuth.required && !memberAuth.verified) return { ok: false, error: memberAuth.requiredError };
    var lookupAllowed = RateLimiter.limitByKey('opt_elig_' + MembershipRules.normalizeEmail(input.email), 10, 5, now.getTime());
    if (lookupAllowed !== true) {
      return { ok: false, error: { code: 'RATE_LIMITED', message: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。' } };
    }
    if (!MembershipRules.verifyActualMembership(input.email, input.date).ok) {
      if (automatic) return { ok: true, plan: '' };
      return { ok: false, error: { code: MembershipRules.MEMBER_BENEFIT_DENIED_CODE, message: MembershipRules.MEMBER_BENEFIT_DENIED_MESSAGE } };
    }
    return { ok: true, plan: plan };
  }


  /*
   * SNB mens限定の作品撮りサポートプラン（Issue #667）の申込検証。利用者が明示的に選んだときだけ成立する（自動適用しない）。
   * 確認順: ブランド（mensのみ）・利用日（効力発生日以降） → 1〜4名（5名以上は#668の大人数利用であり併用不可） → スタッフ対応の選択（必須） →
   * 申込期限（利用日の7日前まで。施設timezoneの暦日で判定） → お支払い方法（オンラインカードのみ。承認後に決済ページへ進む） →
   * メールOTPの確認済み証明（V2） → 照会のレート制限 → actual membership（利用日。予約代表者本人）。
   * 資格関連の失敗は、会員の有無を探れないよう常に同一のコード・メッセージで返す（ペアパック・シャワーパックと同じ）。
   * 通常のmens料金へ黙って倒さない（不成立は拒否として返す）。
   */
  function resolvePhotoSupportForNewBooking_(input, now, memberAuth) {
    if (input.brand !== 'mens' || !BookingPricing.isPhotoSupportAvailableOnDate(input.date)) {
      return { ok: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
    }
    if (!BookingPricing.isPhotoSupportPeople(input.people)) {
      return { ok: false, error: { code: 'PHOTO_SUPPORT_PEOPLE_EXCEEDED', message: BookingPricing.PHOTO_SUPPORT_LABEL + 'のご利用は1〜4名までです。' } };
    }
    if (BookingPricing.normalizeSupportServices(input.supportServices) === null) {
      return { ok: false, error: { code: 'PHOTO_SUPPORT_SERVICE_REQUIRED', message: BookingPricing.PHOTO_SUPPORT_LABEL + 'では、スタッフ対応（事前設営／片付け／事前設営＋片付け）を1つ選択してください。' } };
    }
    var todayString = BookingAvailability.formatDateInTimezone(now, BookingConfig.getAvailabilityConfig().timezone);
    if (!BookingPricing.isPhotoSupportApplyOpen(input.date, todayString)) {
      return { ok: false, error: { code: 'PHOTO_SUPPORT_DEADLINE_PASSED', message: BookingPricing.PHOTO_SUPPORT_LABEL + 'のお申し込みは、利用日の' + BookingPricing.PHOTO_SUPPORT_APPLY_DAYS_BEFORE + '日前までです。' } };
    }
    if (!Booking.isCardPaymentMethod(input.paymentMethod)) {
      return { ok: false, error: { code: 'PHOTO_SUPPORT_CARD_ONLY', message: BookingPricing.PHOTO_SUPPORT_LABEL + 'のお支払いは、運営の承認後にオンラインクレジットカードでお願いします。支払方法でカードを選択してください。' } };
    }
    if (memberAuth && memberAuth.required && !memberAuth.verified) return { ok: false, error: memberAuth.requiredError };
    var lookupAllowed = RateLimiter.limitByKey('opt_elig_' + MembershipRules.normalizeEmail(input.email), 10, 5, now.getTime());
    if (lookupAllowed !== true) {
      return { ok: false, error: { code: 'RATE_LIMITED', message: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。' } };
    }
    if (!MembershipRules.verifyActualMembership(input.email, input.date).ok) {
      return { ok: false, error: { code: MembershipRules.MEMBER_BENEFIT_DENIED_CODE, message: MembershipRules.MEMBER_BENEFIT_DENIED_MESSAGE } };
    }
    return { ok: true, plan: BookingPricing.PLAN.MENS_PHOTO_SUPPORT };
  }

  /*
   * SNB mens限定シャワーパック（Issue #586）の申込検証。必ず利用者が明示的に選んだときだけ成立する（自動適用しない）。
   * 確認順: ブランド（mensのみ）・利用日（2026/12/1以降） → 4時間ちょうど → 1〜2名 → 土日祝（BookingPricingが曜日区分で拒否） →
   * メールOTPの確認済み証明（V2） → 照会のレート制限 → actual membership。
   * 部屋料金の優遇（mensの通常MEMBER料金）は実会員資格ではないため、資格は必ず台帳（利用日）で確認する。
   * 資格関連の失敗は、会員の有無を探れないよう常に同一のコード・メッセージで返す（ペアパックと同じ）。
   */
  function resolveShowerPackForNewBooking_(input, now, memberAuth) {
    if (input.brand !== 'mens' || !BookingPricing.isShowerPackAvailableOnDate(input.date)) {
      return { ok: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
    }
    if (Number(input.durationMinutes) !== BookingPricing.SHOWER_PACK_HOURS * 60) {
      return { ok: false, error: { code: 'PLAN_DURATION_INVALID', message: BookingPricing.SHOWER_PACK_LABEL + 'は4時間でご利用ください。' } };
    }
    if (!BookingPricing.isShowerPackPeople(input.people)) {
      return { ok: false, error: { code: 'SHOWER_PACK_PEOPLE_EXCEEDED', message: BookingPricing.SHOWER_PACK_LABEL + 'のご利用は1〜2名までです。' } };
    }
    if (memberAuth && memberAuth.required && !memberAuth.verified) return { ok: false, error: memberAuth.requiredError };
    var lookupAllowed = RateLimiter.limitByKey('opt_elig_' + MembershipRules.normalizeEmail(input.email), 10, 5, now.getTime());
    if (lookupAllowed !== true) {
      return { ok: false, error: { code: 'RATE_LIMITED', message: '送信回数が多すぎます。しばらく時間を置いてから再度お試しください。' } };
    }
    if (!MembershipRules.verifyActualMembership(input.email, input.date).ok) {
      return { ok: false, error: { code: MembershipRules.MEMBER_BENEFIT_DENIED_CODE, message: MembershipRules.MEMBER_BENEFIT_DENIED_MESSAGE } };
    }
    return { ok: true, plan: BookingPricing.PLAN.MENS_WEEKEND_SHOWER_4H };
  }

  /*
   * 貸切ベースプラン（Issue #488 / #492。常設）の申込検証。会員資格は不要。
   * 確認順: ブランド（Studio Xのみ） → 人数（7名以上はサーバー側で拒否） → 利用時間（最低6時間・1時間単位・8:00〜21:00の範囲。Issue #510）。
   * Issue #492で対象イベント日の制限は廃止した。Studio Xの予約可能日であれば、利用者が明示的に選んだときだけ成立する。
   */
  function resolveEventPlanForNewBooking_(input, plan) {
    if (input.brand !== 'studio_x') {
      return { ok: false, error: { code: 'PLAN_NOT_AVAILABLE', message: 'このプランはご利用いただけません。' } };
    }
    if (!BookingPricing.isEventBasePlanPeople(input.people)) {
      return { ok: false, error: { code: 'EVENT_PLAN_PEOPLE_EXCEEDED', message: BookingPricing.EVENT_BASE_PLAN_LABEL + 'のご利用は1〜6名までです。' } };
    }
    var scheduleError = BookingPricing.eventPlanScheduleError(input.durationMinutes, input.startTime);
    if (scheduleError) return { ok: false, error: scheduleError };
    return { ok: true, plan: plan };
  }

  /*
   * SNB MEMBER料金の適用可否（Issue #471）。新料金世代（V2）のSNB予約では、フォームの自己申告
   * （isMember）を信用せず、予約メールアドレスと会員登録メールアドレスを正規化して照合し、
   * 「利用日（JST）」が支払済みPeriod（MemberPeriods）・旧MemberMonths・永久会員の有効範囲に入るときだけMEMBER料金にする
   * （予約を作った日ではない。未決済の未来Periodを推測しない。MemberRepository.isMemberOnDate参照）。
   * 照合できない・会員台帳を読めない場合はすべてfail-closedで一般料金。
   * V1（〜2026/11/30作成）・mens（価格優遇のみ。実会員資格は付与しない）・studio_x（V2は会員区分廃止）は
   * 従来どおり自己申告/固定の扱いで、会員台帳を参照しない（status='NOT_CHECKED'）。
   * 戻り値: { isMember: 料金計算へ渡す値, status: 'ACTIVE'|'INACTIVE'|'NOT_CHECKED' }
   */
  var ADVANCE_MEMBER_ONLY_ERROR_ = {
    code: 'ADVANCE_BOOKING_MEMBER_ONLY',
    message: '30日より先の日程は、SNB MEMBERの先行予約対象です。会員登録メールアドレスでのご予約をお願いします。'
  };

  function verifyBookingWindowForNewBooking_(input, availabilityConfig, now, memberAuth) {
    var todayString = BookingAvailability.formatDateInTimezone(now, availabilityConfig.timezone);
    var band = BookingWindow.classifyDate(input.date, todayString);
    if (band === BookingWindow.BAND.GENERAL) return { ok: true };
    if (band !== BookingWindow.BAND.MEMBER_ONLY) {
      return { ok: false, error: { code: 'DATE_OUT_OF_RANGE', message: '予約できるのは' + BookingWindow.MEMBER_DAYS + '日先までです。' } };
    }
    /* Issue #548: V2は確認済み証明が無ければ先行予約の資格照会に進まない（会員台帳の有無で結果を変えない）。 */
    if (memberAuth && memberAuth.required && !memberAuth.verified) return { ok: false, error: memberAuth.requiredError };
    var membership = MembershipRules.verifyAdvanceBookingMembership(input.email, todayString);
    if (!membership.ok) {
      if (membership.reason === 'LEDGER_ERROR') Logger.log('BookingRepository: 会員台帳を確認できないため先行予約を拒否しました');
      return { ok: false, error: { code: ADVANCE_MEMBER_ONLY_ERROR_.code, message: MembershipRules.advanceBookingMemberOnlyMessage(input.brand) } };
    }
    return { ok: true };
  }

  function resolveMembershipForPricing_(input, generation, memberAuth) {
    var gated = !!memberAuth && memberAuth.required;
    if (input.brand === 'studio_x' && gated) {
      /* Issue #563: Studio Xの正式V2（OTPフェーズ）で作成する予約は、membershipStatusへ必ず ACTIVE / INACTIVE（OTP確認済み）か UNVERIFIED（未確認）を記録する。
         NOT_CHECKEDにしない＝切替前（台帳照合）に作成した予約と、サーバー側で確実に区別できる（後付けオプションの本人確認で使う。OptionOrderService参照）。
         Studio XのV2は会員区分が無く、料金は会員資格で変わらない（isMemberはそのまま。tierはBookingPricingがGENERAL固定）。 */
      return { isMember: input.isMember, status: memberAuth.verified ? actualMembershipStatus_(input) : StudioXMemberAuth.STATUS.UNVERIFIED };
    }
    if (input.brand !== 'snb' || generation !== BookingPricing.GENERATION.V2) {
      /* mensの部屋料金優遇は実会員資格と別概念（常にMEMBER料金）。V2ではメールOTP確認済みかつ利用日に会員資格がある場合だけ
         membershipStatus=ACTIVEを記録する（後付けオプションの会員限定判定に使う。料金には影響しない）。それ以外は従来どおりNOT_CHECKED。 */
      if (gated && input.brand === 'mens' && memberAuth.verified && actualMembershipStatus_(input) === 'ACTIVE') {
        return { isMember: input.isMember, status: 'ACTIVE' };
      }
      return { isMember: input.isMember, status: 'NOT_CHECKED' };
    }
    /* Issue #548: V2のSNBは、メールOTPの確認済み証明が無ければメールが会員台帳にあっても一般料金（台帳は参照しない）。 */
    if (gated && !memberAuth.verified) return { isMember: false, status: 'UNVERIFIED' };
    /* 利用日（JST）が支払済みPeriod・旧MemberMonths・永久会員の有効範囲に入るか（Issue #532）。台帳エラーはfail-closed。 */
    var status = actualMembershipStatus_(input);
    return { isMember: status === 'ACTIVE', status: status };
  }

  /* 利用日のactual membership（'ACTIVE'|'INACTIVE'）。台帳エラー・例外はINACTIVE（fail-closed）。 */
  function actualMembershipStatus_(input) {
    var eligible = false;
    try {
      var verified = MembershipRules.verifyActualMembership(input.email, input.date);
      if (verified.reason === 'LEDGER_ERROR') Logger.log('BookingRepository: 会員資格の確認に失敗したため一般料金とします');
      eligible = verified.ok === true;
    } catch (lookupError) {
      Logger.log('BookingRepository: 会員資格の確認に失敗したため一般料金とします');
    }
    return eligible ? 'ACTIVE' : 'INACTIVE';
  }

  /*
   * V2会員機能のメールOTP確認状態（Issue #548）。
   * - required: V2（サーバー時刻で決まる料金世代）のSNB / mensの公開直接予約。管理者の新規予約は対象外。Studio Xは対象外。
   * - verified: required かつ、payloadのmemberProof（クライアント保持の証明トークン）が予約メール・用途に拘束された有効な証明であること。
   * - rejection: 証明を送ったのに無効（期限切れ・不正・メール不一致）なとき。再確認要求エラー（黙って一般扱いにしない）。
   * - requiredError: 証明が無いまま会員機能（先行予約・ペアパック・会員限定オプション）を使おうとしたときの確認要求エラー。
   * クライアントの verified / isMember 等は参照しない。
   */
  function newMemberAuth_(rawInput, input, generation, now, isAdminWindow, generationDecision) {
    /* Issue #563: Studio Xは料金世代と独立した認証フェーズ（StudioXMemberAuth。既定LEGACY=台帳照合）がOTPのときだけ必須。 */
    var required = !isAdminWindow && generation === BookingPricing.GENERATION.V2 &&
      ((input.brand === 'snb' || input.brand === 'mens') || (input.brand === 'studio_x' && !!generationDecision && generationDecision.memberAuthRequired === true));
    var auth = { required: required, verified: false, rejection: null, requiredError: null };
    if (!required) return auth;
    auth.requiredError = { code: MembershipRules.BOOKING_VERIFICATION_REQUIRED_CODE, message: MembershipRules.bookingVerificationRequiredMessage(input.brand) };
    var proof = rawInput && typeof rawInput.memberProof === 'string' ? rawInput.memberProof : '';
    if (!proof) return auth;
    var checked = BookingMemberVerification.checkProof(input.email, proof, now);
    if (checked.ok) {
      auth.verified = true;
    } else {
      auth.rejection = BookingMemberVerification.proofError(checked.reason === 'MISSING' ? 'INVALID' : checked.reason, input.brand);
    }
    return auth;
  }

  /* 予約作成後のオプション注文保存（失敗しても予約は成功のまま。例外は握りつぶして結果に載せる）。 */
  function createOptionOrdersForNewBookingBestEffort_(bookingId, normalizedSelection, now) {
    try {
      var created = OptionOrderService.createOrders(bookingId, normalizedSelection, BookingOptions.SOURCE.WITH_BOOKING, now);
      if (created && created.success) {
        return { success: true, orders: created.orders };
      }
      var code = created && created.error && created.error.code;
      return {
        success: false,
        error: {
          code: code || 'OPTIONS_PERSIST_FAILED',
          message: (created && created.error && created.error.message) || 'オプションのお申し込みを保存できませんでした。予約は受け付けています。案内ページから同じ予約IDでオプションを追加してください。'
        }
      };
    } catch (optionError) {
      Logger.log('BookingRepository: オプション注文の保存に失敗しました bookingId=' + bookingId);
      return {
        success: false,
        error: { code: 'OPTIONS_PERSIST_FAILED', message: 'オプションのお申し込みを保存できませんでした。予約は受け付けています。案内ページから同じ予約IDでオプションを追加してください。' }
      };
    }
  }

  /*
   * 「実際にCheckoutを開始できる」場合だけtrue（beginCardCheckoutの事前条件と同じ:
   * checkoutEnabled・secretKey・successUrl・cancelUrl、およびブランド別の戻り先解決）。
   * 条件を欠く場合はbeginCardCheckoutがSessionを作れず（CHECKOUT_DISABLED / STRIPE_NOT_CONFIGURED）
   * 支払い案内メールも送られないため、利用者へのメールが1通も届かない事態を避けて、
   * 従来どおりcreateBooking時に受付メールを送る。
   */
  function shouldDeferPendingMailToCheckout_(record) {
    /* Issue #667: 作品撮りサポートは承認前に決済ページへ進まないため、申込受付メール（承認待ちの案内）を必ずここで送る。 */
    if (Booking.photoSupportStage(record)) return false;
    if (!Booking.isCardPaymentMethod(record.paymentMethod)) return false;
    /* Issue #668: 大人数利用は承認前にCheckoutを作らない。承認待ちの受付メールを申込時に送る。 */
    if (Booking.isLargePartyRecord(record)) return false;
    try {
      var stripeConfig = BookingConfig.getStripeConfig();
      if (!stripeConfig.checkoutEnabled) return false;
      if (!stripeConfig.secretKey || !stripeConfig.successUrl || !stripeConfig.cancelUrl) return false;
      return !!Booking.resolveCheckoutReturnUrls(record.brand, stripeConfig).ok;
    } catch (configError) {
      return false;
    }
  }

  /*
   * Checkout Session作成（または有効なSessionの再利用）に成功した後の支払い案内メール（Issue #445）。
   * Lock・Stripe呼び出しの外でbest effortに行い、失敗してもbeginCardCheckoutの結果（Checkout作成成功）
   * は変えない。同一Sessionの二重送信はBookingMailer側が防ぐ。checkoutUrlはログへ出さない。
   */
  function notifyCardCheckoutBestEffort_(bookingId, result) {
    try {
      BookingMailer.sendCardCheckoutMailForBooking(bookingId, { url: result.checkoutUrl, expiresAt: result.paymentHoldExpiresAt });
    } catch (mailError) {
      Logger.log('BookingRepository: カード決済案内メール送信中に予期しない例外: ' + BookingMailer.sanitizeErrorMessage(describeError_(mailError), [String(result.checkoutUrl || '')]));
    }
  }

  /* 送信失敗はcreateBooking自体の成否に影響させない（BookingMailer側で既にSentAt確認・
     lastMailError記録まで行うため、ここでは想定外の例外だけをLoggerへ残す）。 */
  function notifyCustomerPendingBestEffort_(record) {
    try {
      BookingMailer.sendPendingMailForBooking(record.bookingId);
    } catch (mailError) {
      /* PRレビュー対応: 例外messageをそのままLoggerへ出さず、BookingMailer.gsと同じ
         redaction方針（メールアドレス等をマスク）を適用してから記録する。 */
      Logger.log('BookingRepository: PENDINGメール送信中に予期しない例外: ' + BookingMailer.sanitizeErrorMessage(describeError_(mailError)));
    }
  }

  /* Calendar成功 / Sheets失敗の部分失敗補償。Calendarイベントの削除を試み、
     成功/失敗いずれの場合もrecoveryへ記録して人が追跡できるようにする。 */
  function handleSheetsSaveFailure_(calendarId, bookingId, eventId, sheetsError, requestId, input) {
    var safeRequestId = sanitizeRequestId_(requestId);
    var diagnosticRedactions = buildDiagnosticRedactions_(calendarId, bookingId, eventId, input);
    var sanitizedSheetsError = sanitizeDiagnosticError_(sheetsError, diagnosticRedactions);
    var bookingDiagnostic = {
      requestId: safeRequestId,
      occurredAt: new Date().toISOString(),
      sheetsError: sanitizedSheetsError,
      calendarCompensation: 'not_attempted',
      recoveryRecord: 'not_attempted'
    };
    persistBookingDiagnosticBestEffort_(safeRequestId, bookingDiagnostic);
    Logger.log(
      'requestId=' + safeRequestId +
      ' handleSheetsSaveFailure sheetsError=' + sanitizedSheetsError
    );

    var compensated = false;
    var compensationError = null;
    try {
      CalendarRepository.deleteEventById(calendarId, eventId);
      compensated = true;
    } catch (deleteError) {
      compensationError = deleteError;
    }
    Logger.log(
      'requestId=' + safeRequestId +
      ' handleSheetsSaveFailure calendarCompensation=' + (compensated ? 'success' : 'failure') +
      (compensationError ? ' error=' + sanitizeDiagnosticError_(compensationError, diagnosticRedactions) : '')
    );
    bookingDiagnostic.calendarCompensation = compensated ? 'success' : 'failure';
    persistBookingDiagnosticBestEffort_(safeRequestId, bookingDiagnostic);

    var recoveryRecorded = false;
    var recoveryError = null;
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: compensated ? 'CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE' : 'SHEETS_FAILURE_CALENDAR_ORPHANED',
        occurredAt: new Date(),
        calendarEventId: eventId,
        status: compensated ? 'COMPENSATED' : 'NEEDS_MANUAL_RECOVERY',
        errorMessage: describeError_(sheetsError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
      recoveryRecorded = true;
    } catch (recordFailureError) {
      recoveryError = recordFailureError;
      /* recovery記録自体の失敗は最後の砦としてLoggerへ残すのみ（ここで例外を投げると
         利用者への応答自体が失敗するため、必ず握りつぶす）。 */
      Logger.log(
        'requestId=' + safeRequestId +
        ' handleSheetsSaveFailure recoveryRecord=failure error=' +
        sanitizeDiagnosticError_(recordFailureError, diagnosticRedactions)
      );
    }
    if (recoveryRecorded) {
      Logger.log('requestId=' + safeRequestId + ' handleSheetsSaveFailure recoveryRecord=success');
    }

    bookingDiagnostic.recoveryRecord = recoveryRecorded ? 'success' : 'failure';
    if (recoveryError) {
      bookingDiagnostic.recoveryError = sanitizeDiagnosticError_(recoveryError, diagnosticRedactions);
    }
    persistBookingDiagnosticBestEffort_(safeRequestId, bookingDiagnostic);

    return {
      success: false,
      error: { code: 'BOOKING_SAVE_FAILED', message: '予約の保存に失敗しました。しばらくしてから再度お試しください。' }
    };
  }

  /* Issue #273の一時診断。保存失敗は予約処理へ影響させず、Loggerにも内部値を出さない。 */
  function persistBookingDiagnosticBestEffort_(safeRequestId, diagnostic) {
    if (safeRequestId === 'invalid' || safeRequestId === 'unavailable') return;
    try {
      var value = {
        requestId: diagnostic.requestId,
        occurredAt: diagnostic.occurredAt,
        sheetsError: diagnostic.sheetsError,
        calendarCompensation: diagnostic.calendarCompensation,
        recoveryRecord: diagnostic.recoveryRecord
      };
      if (diagnostic.recoveryError) value.recoveryError = diagnostic.recoveryError;
      PropertiesService.getScriptProperties().setProperty(
        'BOOKING_DIAG_' + safeRequestId,
        JSON.stringify(value)
      );
    } catch (diagnosticSaveError) {
      /* best effort: BOOKING_SAVE_FAILEDの既存レスポンスと補償処理を変えない。 */
    }
  }

  function notifyAdminBestEffort_(record) {
    try {
      AdminNotifier.notifyNewPendingBooking(record);
    } catch (notifyError) {
      Logger.log('AdminNotifier.notifyNewPendingBooking failed: ' + describeError_(notifyError));
      try {
        RecoveryRepository.recordFailure({
          bookingId: record.bookingId,
          failureType: 'ADMIN_NOTIFICATION_FAILED',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: describeError_(notifyError),
          recoveryState: 'INFO',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    }
  }

  function describeError_(error) {
    return String((error && error.message) || error);
  }

  /* requestIdはWeb App入口でUtilities.getUuid()から生成した値だけを想定する。
     診断関数を直接呼ばれた場合も、任意文字列をログへ流さない。 */
  function sanitizeRequestId_(requestId) {
    var value = String(requestId || 'unavailable');
    return /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : 'invalid';
  }

  /* Sheets/Calendar例外に入力値や内部IDが含まれてもログへ残さないため、今回の
     リクエストで把握できるPII・識別子を追加redaction対象にする。 */
  function buildDiagnosticRedactions_(calendarId, bookingId, eventId, input) {
    var values = [calendarId, bookingId, eventId];
    if (input) {
      values = values.concat([
        input.name,
        input.email,
        input.phone,
        input.people,
        input.purpose,
        input.paymentMethod,
        input.note,
        input.source
      ]);
    }
    try {
      values.push(BookingConfig.getSpreadsheetId());
    } catch (ignoredError) {
      /* 元のSheets失敗原因を診断する経路なので、設定再取得の失敗は無視する。 */
    }
    return values.filter(function (value) { return value !== null && value !== undefined && String(value) !== ''; });
  }

  function sanitizeDiagnosticError_(error, extraRedactions) {
    return BookingMailer.sanitizeErrorMessage(describeError_(error), extraRedactions);
  }

  /* instanceof Dateではなくダックタイピングで判定する。Spreadsheetの日時セルは
     常にDateを返す想定だが、vm等の別realmをまたぐ場合instanceof Dateが偽陰性になり得るため。 */
  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  /*
   * confirmBooking(bookingId) — Spreadsheetのカスタムメニュー（BookingAdmin.gs。
   * Booking Adminプロジェクト）から呼ばれる正式な確定手順。PENDINGのみCONFIRMEDへ
   * 遷移できる。既にCONFIRMED済みなら何もせず成功扱いにする（二重実行しても壊れない）。
   * expirePendingBookingsも同じBooking Adminプロジェクトに属し、同じ
   * LockService.getScriptLock()を取得するため、この2つが同時に同じbookingIdを
   * 処理することはない（一方がLockを保持している間、他方はtryLockが失敗するかLockが
   * 解放されるまで待つ）。
   */
  function confirmBooking(bookingId, options) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }

    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    var outcome;
    try {
      var guardRejection = writeGuardRejection_(options);
      outcome = guardRejection
        ? { response: guardRejection, shouldTryMail: false }
        : confirmBookingLocked_(bookingId, !!(options && typeof options.writeGuard === 'function'));
    } finally {
      lock.releaseLock();
    }

    /*
     * 利用者向けCONFIRMEDメールはbooking状態変更のLockの外で送る（Issue #271
     * 「12. confirmBookingへの接続」）。メール送信の成否はconfirmBookingの成否に
     * 影響させず、success:falseにはしない（補助情報としてmailSent/mailErrorを添える）。
     */
    if (outcome.shouldTryMail) {
      notifyCustomerConfirmedBestEffort_(bookingId, outcome.response);
    }

    return outcome.response;
  }


  /*
   * 作品撮りサポートプランの承認（Issue #667）。Booking Admin専用（公開Web Appには出さない）。
   * 申込時に仮押さえ済み（PENDING＋Calendarイベント）の予約について、運営がスタッフ対応の可否・機材・予約枠を確認したうえで呼ぶ。
   * 承認すると supportApprovedAt を記録し、支払い期限 supportPaymentDueAt を承認から24時間後に設定する。以後は決済ページ（beginCardCheckout）で
   * お支払いできる。承認前は決済不可。期限内に支払いが完了しなければ expirePendingBookings が不成立（EXPIRED）として枠を解放する。
   * 二重承認は冪等（支払い期限を延長しない・メールだけ未送信なら再送を試みる）。承認時点でも会員資格を再確認する（fail-closed）。
   * 不承認は cancelBookingAdmin（仮押さえ解除＋承認できなかった旨のメール）で行う。
   * 戻り値: { success, bookingId, status, supportStage, supportPaymentDueAt, alreadyApproved?, mailSent?, mailError? }
   */
  function approvePhotoSupport(bookingId, now) {
    now = isDateLike_(now) ? now : new Date();
    if (!bookingId || typeof bookingId !== 'string') {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    var response;
    try {
      response = approvePhotoSupportLocked_(bookingId, now);
    } finally {
      lock.releaseLock();
    }
    if (response.success && response.shouldTryMail) {
      delete response.shouldTryMail;
      try {
        var mailResult = BookingMailer.sendSupportApprovedMailForBooking(bookingId);
        response.mailSent = !!(mailResult && mailResult.success && !mailResult.skipped);
        if (mailResult && !mailResult.success && !mailResult.skipped) {
          response.mailError = mailResult.error || null;
        }
      } catch (mailError) {
        response.mailSent = false;
        response.mailError = { code: 'MAIL_SEND_FAILED', message: BookingMailer.sanitizeErrorMessage(describeError_(mailError)) };
      }
    } else {
      delete response.shouldTryMail;
    }
    return response;
  }

  function approvePhotoSupportLocked_(bookingId, now) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
    }
    var record = found.record;
    var stage = Booking.photoSupportStage(record);
    if (!stage) {
      return { success: false, error: { code: 'NOT_PHOTO_SUPPORT', message: '作品撮りサポートプランの予約ではありません。' } };
    }
    if (stage === 'AWAITING_PAYMENT') {
      /* 承認済み（冪等）。支払い期限は延長しない。承認案内メールが未送信なら再送を試みる。 */
      return {
        success: true, alreadyApproved: true, bookingId: bookingId, status: record.status, supportStage: stage,
        supportPaymentDueAt: record.supportPaymentDueAt, shouldTryMail: !record.supportApprovalMailSentAt
      };
    }
    if (stage !== 'AWAITING_APPROVAL') {
      return { success: false, error: { code: 'INVALID_TRANSITION', message: record.status + ' の予約は承認できません。' } };
    }
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var dateString = isDateLike_(record.startAt) ? BookingAvailability.formatDateInTimezone(record.startAt, timezone) : '';
    if (!MembershipRules.verifyActualMembership(record.email, dateString).ok) {
      return { success: false, error: { code: MembershipRules.MEMBER_BENEFIT_DENIED_CODE, message: MembershipRules.MEMBER_BENEFIT_DENIED_MESSAGE } };
    }
    if (!isDateLike_(record.startAt) || now.getTime() >= record.startAt.getTime()) {
      return { success: false, error: { code: 'START_TIME_PASSED', message: '利用開始時刻を過ぎているため承認できません。' } };
    }
    if (Booking.getEffectivePriceAmount(record) === null) {
      return { success: false, error: { code: 'PRICE_NOT_AVAILABLE', message: '確定金額が計算されていないため承認できません。' } };
    }
    var calendarId = BookingConfig.getCalendarId();
    if (!CalendarRepository.getEventById(calendarId, record.calendarEventId)) {
      return { success: false, error: { code: 'CALENDAR_EVENT_MISSING', message: '仮押さえのCalendarイベントが見つかりません。Recoveryシートを確認してください。' } };
    }
    var dueAt = new Date(now.getTime() + BookingPricing.PHOTO_SUPPORT_PAYMENT_DUE_HOURS * 3600000);
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, { supportApprovedAt: now, supportPaymentDueAt: dueAt, updatedAt: now });
    } catch (sheetsError) {
      Logger.log('approvePhotoSupport: 台帳の更新に失敗しました bookingId=' + bookingId);
      return { success: false, error: { code: 'SHEETS_UPDATE_FAILED', message: '承認を台帳へ記録できませんでした。もう一度お試しください。' } };
    }
    return {
      success: true, bookingId: bookingId, status: record.status, supportStage: 'AWAITING_PAYMENT',
      supportPaymentDueAt: dueAt, shouldTryMail: true
    };
  }

  /*
   * options.writeGuard（任意。Issue #341 PR-Cレビュー対応・7回目）: Lockを取得した直後、
   * Calendar/Sheetsを読み書きする前に呼ぶ関数。falseを返した場合は何も書き込まずに
   * WRITE_GUARD_REJECTEDを返す。StripeWebhookProcessorが「この実行の処理権（StripeEventsの
   * 世代）がまだ有効か」の確認に使う。処理権の再取得（StripeEventRepository.
   * claimForProcessing）も同じLockService.getScriptLock()の中で行われるため、この確認と
   * 続く書き込みの間に処理権が移ることはない。writeGuardの中でLockを取得してはならない
   * （既にこの関数がLockを保持している）。管理者操作等、optionsを渡さない既存の呼び出しの
   * 挙動は変わらない。
   */
  function writeGuardRejection_(options) {
    if (!options || typeof options.writeGuard !== 'function') return null;
    if (options.writeGuard() === true) return null;
    return {
      success: false,
      error: { code: 'WRITE_GUARD_REJECTED', message: '書き込みの前提条件（処理権）が失われていたため、何も変更しませんでした。' }
    };
  }

  /*
   * 会員限定2名ペアパック（Issue #478）の、管理者操作による確定時のactual membership再確認（fail-closed）。
   * 対象は管理者の手動確定（confirmBooking）・EXPIRED復活（reviveExpiredBooking）。Stripe決済済みとして
   * Webhookが確定する経路（options.writeGuardあり）は呼び出し側が除外する＝決済済みを後から会員資格不足で覆さない。
   * プラン付きでない予約・日付を決められない予約は対象外（従来どおり）。資格が確認できなければ全理由を同一コードで拒否する。
   */
  function pairPackMembershipRejection_(record) {
    if (!record || !BookingPricing.isMemberPlan(record.planCode)) return null;
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var dateString = isDateLike_(record.startAt) ? BookingAvailability.formatDateInTimezone(record.startAt, timezone) : '';
    if (MembershipRules.verifyActualMembership(record.email, dateString).ok) return null;
    return {
      response: {
        success: false,
        error: { code: MembershipRules.MEMBER_BENEFIT_DENIED_CODE, message: MembershipRules.MEMBER_BENEFIT_DENIED_MESSAGE }
      },
      shouldTryMail: false
    };
  }

  /* confirmBookingのLock保持区間の本体。戻り値: { response, shouldTryMail }。
     shouldTryMailは「CalendarとSheetsが正常な状態（新規確定 or 確定済みでメール未送信）」
     の場合のみtrueにし、確定処理自体が失敗した場合はfalseにする（Lockを保持したまま
     メール送信を行わないための分離）。 */
  function confirmBookingLocked_(bookingId, viaStripeWebhook) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return {
        response: { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } },
        shouldTryMail: false
      };
    }

    var record = found.record;
    if (record.status === Booking.STATUS.CONFIRMED) {
      /* 既にCONFIRMED済みでも、confirmedMailSentAtが空ならメールだけ再試行させる
         （Issue #271本文どおり。状態自体はここでは一切変更しない）。 */
      return {
        response: { success: true, alreadyConfirmed: true, bookingId: bookingId, status: Booking.STATUS.CONFIRMED },
        shouldTryMail: !record.confirmedMailSentAt
      };
    }
    /*
     * Issue #334: Booking.ALLOWED_TRANSITIONSにEXPIRED→CONFIRMEDを追加したが、
     * それを実行できるのは専用のreviveExpiredBooking（このファイル下部）のみとする。
     * confirmBookingは既存どおりEXPIREDを拒否し続ける（reviveExpiredBookingはLock内での
     * 枠競合再確認・Calendarイベント新規作成・expiredAt保持等、confirmBookingLocked_には
     * 無い専用の復活処理を行うため、canTransitionの表が一般にtrueを返すようになったことを
     * 理由にこの関数へその処理を委ねさせない）。
     */
    if (record.status === Booking.STATUS.EXPIRED) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CONFIRMED へは遷移できません。' }
        },
        shouldTryMail: false
      };
    }
    if (!Booking.canTransition(record.status, Booking.STATUS.CONFIRMED)) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CONFIRMED へは遷移できません。' }
        },
        shouldTryMail: false
      };
    }

    if (!viaStripeWebhook) {
      var memberRejection = pairPackMembershipRejection_(record);
      if (memberRejection) return memberRejection;
    }
    /* Issue #668: 大人数利用は運営承認前に確定できない（Webhook・管理者いずれも）。 */
    if (Booking.isLargePartyRecord(record) && Booking.largePartyApprovalStatus(record) !== Booking.LARGE_PARTY_APPROVAL.APPROVED) {
      return {
        response: { success: false, error: { code: 'LARGE_PARTY_APPROVAL_REQUIRED', message: '5〜7名の大人数利用は、運営の承認前には確定できません。' } },
        shouldTryMail: false
      };
    }

    /* Issue #667: 作品撮りサポートは承認前・未払いのまま確定できない（Web管理画面・Spreadsheetメニュー・Webhookの全経路のサーバー側最終ガード）。
       確定できるのは「承認済み＋Stripeで支払い完了(PAID)」だけ。 */
    if (Booking.photoSupportStage(record)) {
      if (Booking.photoSupportStage(record) !== 'AWAITING_PAYMENT') {
        return {
          response: { success: false, error: { code: 'SUPPORT_NOT_APPROVED', message: '作品撮りサポートプランは運営の承認前には確定できません。先に承認してください。' } },
          shouldTryMail: false
        };
      }
      if (Booking.normalizePaymentStatus(record.paymentStatus) !== Booking.PAYMENT_STATUS.PAID) {
        return {
          response: { success: false, error: { code: 'SUPPORT_PAYMENT_REQUIRED', message: '作品撮りサポートプランは、承認後のお支払いが完了するまで確定できません。' } },
          shouldTryMail: false
        };
      }
    }

    /*
     * Issue #396: 旧Payment Link方式のカード予約は、決済リンクを1回も送信していない間は
     * 確定できない（未収金のままCONFIRMEDへ進めない）。UIの出し分けとは独立した
     * サーバー側の最終ガードで、Web管理画面・Spreadsheetメニューの双方に効く。
     * Stripe Checkout方式（Webhook確定を含む）・PayPay・現金は対象外。
     */
    if (Booking.isLegacyPaymentLinkBooking(record) && !Booking.hasPaymentLinkBeenSent(record)) {
      return {
        response: {
          success: false,
          error: { code: 'PAYMENT_LINK_NOT_SENT', message: 'カード決済の予約は、Stripe決済リンクを送信するまで確定できません。' }
        },
        shouldTryMail: false
      };
    }

    /*
     * 料金修正の訂正案内が未完了なら、Calendar/Sheetsを変更する前に確定を止める。
     * Web管理画面とSpreadsheetメニューは同じconfirmBookingを経由する。
     */
    if (Booking.needsPriceUpdateNotice(record)) {
      return {
        response: {
          success: false,
          error: {
            code: 'PRICE_UPDATE_NOTICE_REQUIRED',
            message: '修正後の利用料金をまだ案内していません。訂正案内メールを送信してから予約を確定してください。'
          }
        },
        shouldTryMail: false
      };
    }

    var calendarId = BookingConfig.getCalendarId();
    var event = CalendarRepository.getEventById(calendarId, record.calendarEventId);
    if (!event) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CONFIRM_CALENDAR_EVENT_MISSING',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: 'confirmBooking時にCalendarイベントが見つかりませんでした。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'CALENDAR_EVENT_MISSING', message: '対応するCalendarイベントが見つかりません。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    CalendarRepository.setEventStatus(calendarId, record.calendarEventId, Booking.STATUS.CONFIRMED, bookingId);

    var confirmedAt = new Date();
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        status: Booking.STATUS.CONFIRMED,
        confirmedAt: confirmedAt,
        updatedAt: confirmedAt
      });
    } catch (sheetsError) {
      return { response: handleConfirmSheetsUpdateFailure_(calendarId, bookingId, record.calendarEventId, sheetsError), shouldTryMail: false };
    }

    return { response: { success: true, bookingId: bookingId, status: Booking.STATUS.CONFIRMED }, shouldTryMail: true };
  }

  /* response（confirmBookingの戻り値オブジェクト）へmailSent/mailErrorを補助情報として
     追加する。メール失敗はここでもconfirmBooking自体の成功可否には影響させない。 */
  function notifyCustomerConfirmedBestEffort_(bookingId, response) {
    try {
      var mailResult = BookingMailer.sendConfirmedMailForBooking(bookingId);
      response.mailSent = !!(mailResult && mailResult.success && !mailResult.skipped);
      if (mailResult && mailResult.success && mailResult.skipped && mailResult.reason === 'ALREADY_SENT') {
        response.mailAlreadySent = true;
      }
      if (!mailResult || !mailResult.success) {
        response.mailError = (mailResult && mailResult.error) || { code: 'UNEXPECTED_ERROR', message: '確定メールの送信結果を取得できませんでした。' };
        /* Issue #418: 失敗理由コードのみ残す（メールアドレス・本文・鍵情報は残さない）。 */
        Logger.log('BookingRepository: CONFIRMEDメール未送信 ' + bookingId + ' code=' + response.mailError.code);
      }
    } catch (mailError) {
      /* PRレビュー対応: 例外messageをそのままLoggerへ出さず、BookingMailer.gsと同じ
         redaction方針（メールアドレス等をマスク）を適用してから記録する。 */
      var sanitizedMessage = BookingMailer.sanitizeErrorMessage(describeError_(mailError));
      Logger.log('BookingRepository: CONFIRMEDメール送信中に予期しない例外: ' + sanitizedMessage);
      response.mailSent = false;
      response.mailError = { code: 'UNEXPECTED_ERROR', message: sanitizedMessage };
    }
    notifyImmediateAccessGuideBestEffort_(bookingId, response);
  }

  /*
   * Issue #412: 利用日当日にCONFIRMEDになった予約へ来場案内を即時送信する（前日18時台の
   * sendNextDayReminders対象外のため）。当日判定・各種ゲート・二重送信防止は
   * BookingMailer.sendImmediateAccessGuideForBookingに委ね、ここでは呼ぶだけ。
   * 確定メールの成否に関わらず試み、失敗してもconfirmBooking自体の成否は変えない。
   * ログにはbookingIdとエラーコードのみ残す（メールアドレス・鍵情報・本文は残さない）。
   */
  function notifyImmediateAccessGuideBestEffort_(bookingId, response) {
    try {
      var result = BookingMailer.sendImmediateAccessGuideForBooking(bookingId);
      response.accessGuideSent = !!(result && result.success && !result.skipped);
      if (result && !result.success && !result.skipped) {
        response.accessGuideError = result.error;
        Logger.log('BookingRepository: 即時来場案内の送信失敗 ' + bookingId + ' code=' + (result.error && result.error.code));
      }
    } catch (guideError) {
      response.accessGuideSent = false;
      response.accessGuideError = { code: 'UNEXPECTED_ERROR' };
      Logger.log('BookingRepository: 即時来場案内送信中に予期しない例外 ' + bookingId + ' ' +
        BookingMailer.sanitizeErrorMessage(describeError_(guideError)));
    }
  }

  /*
   * Calendar成功（CONFIRMEDへの更新）→ Sheets失敗（statusをCONFIRMEDへ更新できない）の
   * 部分失敗補償。createBooking時のCalendar成功/Sheets失敗補償と対称に、Calendar側の
   * 状態をPENDINGへ戻すことを試み、成否をrecoveryへ記録する（#268「Calendar成功/Sheets
   * 失敗を検知」「部分失敗はrecoveryへ」を状態遷移にも適用。レビュー指摘対応）。
   */
  function handleConfirmSheetsUpdateFailure_(calendarId, bookingId, eventId, sheetsError) {
    var compensated = false;
    var compensationError = null;
    try {
      CalendarRepository.setEventStatus(calendarId, eventId, Booking.STATUS.PENDING, bookingId);
      compensated = true;
    } catch (revertError) {
      compensationError = revertError;
    }

    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: compensated ? 'CALENDAR_ROLLED_BACK_AFTER_CONFIRM_SHEETS_FAILURE' : 'CONFIRM_SHEETS_FAILURE_CALENDAR_ORPHANED',
        occurredAt: new Date(),
        calendarEventId: eventId,
        status: compensated ? 'PENDING' : 'CONFIRMED',
        errorMessage: describeError_(sheetsError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }

    return {
      success: false,
      error: { code: 'CONFIRM_SAVE_FAILED', message: '確定内容の保存に失敗しました。Recoveryシートを確認してください。' }
    };
  }

  /*
   * expirePendingBookings() — Booking Adminプロジェクトの時間主導トリガーから呼ばれる
   * TTL失効処理（BookingTriggers.gs参照）。confirmBookingと同じBooking Adminプロジェクトに
   * 属し、同じLockService.getScriptLock()を使うため、confirmBookingとの間で
   * PENDING→CONFIRMEDとPENDING→EXPIREDが同時に進んでしまう競合はLockにより直列化される。
   * 候補行ごとにLockを取得し、Lock取得後に最新statusを再確認してから処理する（他プロセスとの
   * 二重処理を防ぐ）。Calendarイベント削除に失敗した場合もrecoveryへ記録した上でSheets側は
   * EXPIREDへ進める（削除失敗を理由にPENDINGのまま放置しない）。
   *
   * 【Booking Webhookプロジェクトとの競合について（Issue #341 PR-Cレビュー対応の変遷）】
   * 1回目のレビュー対応時点では、独立したBooking Webhookプロジェクトが決済照合〜予約
   * 自動確定まで自分自身のLockService.getScriptLock()の下で行っており、Booking Admin
   * プロジェクトのこの関数とは別々のLockServiceだったため、両者が同じ予約を並行して
   * 変更する競合を排除できなかった。2〜3回目では、共有Spreadsheet上の予約単位の分散
   * ロック（BookingLockRepository）でこれを塞ごうとしたが、「ロックの有効性確認から
   * 実際の書き込みまでの間に競合が起こり得る（TOCTOU）。確認箇所を増やしても解消しない」
   * という指摘を4回目のレビューで受けた。
   *
   * 4回目のレビュー対応で、独立したBooking Webhookプロジェクトの責務を「署名検証済み
   * イベントをStripeEventRepositoryへ安全に永続化するだけ」に縮小し、決済照合〜予約
   * 自動確定（StripeWebhookProcessor.processPendingStripeWebhookEvents。
   * `gas/booking/admin/StripeWebhookProcessor.gs`）をBooking Adminプロジェクトの時間主導
   * トリガーへ移した。これにより、Webhook由来の予約確定はこの関数（expirePendingBookings）
   * と**同じBooking Adminプロジェクト・同じLockService.getScriptLock()**の下で実行される
   * ようになり、confirmBooking（管理者手動確定）とexpirePendingBookingsが既に共有している
   * のと全く同じ仕組みで直列化される。予約単位の分散ロックは一切不要になった
   * （BookingLockRepositoryは削除。詳細はREADME「Webhookと失効処理の競合」節・
   * StripeWebhookProcessor.gs冒頭コメント参照）。
   */
  /*
   * Issue #341 PR-B「5. 仮押さえと期限切れ」: checkout_pending（Stripe Checkout Session
   * 発行済み）のカード予約が仮押さえ期限（paymentHoldExpiresAt）を過ぎた場合、
   * expirePendingBookings（枠解放）がそのまま従来のTTL計算・削除処理へ進む前に、
   * Stripe側の実際のSession状態を確認する。「Stripe側で決済できるSessionが残っている間に
   * GASだけが枠を解放しない」「決済が成立している可能性がある場合は、未払いと決めつけて
   * 枠を解放しない」を満たすための唯一のゲート。
   *
   * 戻り値のsafeToExpire:trueだけが、この後の既存の枠解放処理（Calendar削除→
   * status:EXPIRED）へ進んでよいことを意味する。false（Stripe側がopen＝まだ決済可能、
   * complete/paid＝決済済みの可能性、API失敗・解析不能のいずれか）の場合、このトリガー
   * 実行ではこの予約をスキップする（次回のトリガー実行で再評価する。README「仮押さえの
   * 解放とStripe側の失効確認」参照）。
   */
  function verifyCheckoutHoldSafeToExpire_(record, now) {
    if (!record.stripeCheckoutSessionId) {
      recordPaymentEvidenceAuditBestEffort_(
        record.bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
        '仮押さえ期限を過ぎたcheckout_pending予約にstripeCheckoutSessionIdが記録されていません。枠を解放せずスキップしました。',
        now
      );
      return { safeToExpire: false };
    }

    var stripeConfig = BookingConfig.getStripeConfig();
    var result = StripeGateway.retrieveCheckoutSession(stripeConfig, record.stripeCheckoutSessionId);
    if (!result.ok) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: record.bookingId,
          failureType: 'EXPIRE_STRIPE_SESSION_STATUS_UNKNOWN',
          occurredAt: now,
          calendarEventId: record.calendarEventId || '',
          status: record.status || '',
          errorMessage: '仮押さえ期限を過ぎたCheckout Sessionの状態確認に失敗しました（' + result.errorType + '）: ' + (result.message || ''),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return { safeToExpire: false };
    }

    var session = result.session;
    if (session.status === 'expired' && session.paymentStatus === 'unpaid') {
      return { safeToExpire: true };
    }
    if (session.status === 'complete' || session.paymentStatus === 'paid') {
      recordPaymentRecoveryBestEffort_(
        record.bookingId, record, 'CHECKOUT_HOLD_EXPIRY_PAYMENT_MAYBE_SUCCEEDED',
        '仮押さえ期限を過ぎたためこの予約の枠解放を検討しましたが、Stripe Checkout Session（' +
          record.stripeCheckoutSessionId + '）が決済済みと報告されたため、枠を解放せず自動処理を停止しました。' +
          '至急Stripe管理画面で入金を確認してください。',
        now
      );
      return { safeToExpire: false };
    }
    /*
     * session.status==='open'（Stripe実際のexpires_atにはSTRIPE_SESSION_EXPIRY_BUFFER_
     * MINUTES分の安全マージンが乗っているため、GAS側のpaymentHoldExpiresAtを過ぎていても
     * Stripe側ではまだ数分間open=決済可能な場合がある。README「仮押さえの解放とStripe側の
     * 失効確認」参照）を含め、上記いずれにも該当しない場合は安全側に倒し、次回トリガーで
     * 再評価する。
     */
    if (session.status !== 'open') {
      try {
        RecoveryRepository.recordFailure({
          bookingId: record.bookingId,
          failureType: 'EXPIRE_STRIPE_SESSION_STATUS_UNKNOWN',
          occurredAt: now,
          calendarEventId: record.calendarEventId || '',
          status: record.status || '',
          errorMessage: 'Checkout Sessionの状態を判定できませんでした（status=' + session.status + ', payment_status=' + session.paymentStatus + '）。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    }
    return { safeToExpire: false };
  }

  function expirePendingBookings(now) {
    now = isDateLike_(now) ? now : new Date();
    var ttlConfig = BookingConfig.getTtlConfig();
    var calendarId = BookingConfig.getCalendarId();
    var candidates = SpreadsheetRepository.getAllPendingBookings();
    var expiredCount = 0;
    var skippedCount = 0;
    /* Issue #334: 今回の実行でPENDING→EXPIREDへ実際に更新したカード予約のbookingIdだけを
       集め、forEachループ（＝全候補のLock取得・解放）が終わったあとにLock外でまとめて
       通知する。expiredMailSentAtが空の過去のEXPIRED行（＝このループのcandidatesに
       含まれない、既にstatus!==PENDINGな行）はここに入らないため、過去分へ遡って
       送ることはない。 */
    var newlyExpiredCardBookingIds = [];
    /* Issue #341 PR-B: 仮押さえ失効によりEXPIREDへ進めたcheckout_pending予約のbookingId。
       Lock解放後にapplyPaymentStateUpdate(FAILED)をまとめて呼ぶ（上記コメント参照）。 */
    var newlyFailedCheckoutHoldBookingIds = [];

    candidates.forEach(function (item) {
      var record = item.record;
      var createdAtMillis = isDateLike_(record.createdAt) ? record.createdAt.getTime() : NaN;
      var startAtMillis = isDateLike_(record.startAt) ? record.startAt.getTime() : NaN;
      if (isNaN(createdAtMillis) || isNaN(startAtMillis)) {
        Logger.log('expirePendingBookings: createdAt/startAtが不正なためスキップ: ' + record.bookingId);
        skippedCount++;
        return;
      }

      /*
       * Issue #668: 大人数利用（5〜7名）は、運営承認後は承認から24時間（largePartyPaymentDueAt）が支払期限。
       * 期限内は、Checkout Sessionの仮押さえ（約30分）が切れても枠を保持する（利用者はメールのリンクから何度でも決済を開始できる）。
       * 期限を過ぎた未払いは、受付起点のカードTTL（72時間）を待たず不成立（EXPIRED・枠解放）にする。
       * 承認待ち（PENDING_APPROVAL）は運営の判断まで保持する（利用開始時刻を過ぎた未判断のものだけ失効）。
       */
      var largePartyDueMillis = NaN;
      if (Booking.isLargePartyRecord(record) && Booking.largePartyApprovalStatus(record) === Booking.LARGE_PARTY_APPROVAL.APPROVED) {
        largePartyDueMillis = isDateLike_(record.largePartyPaymentDueAt) ? record.largePartyPaymentDueAt.getTime() : NaN;
        if (!isNaN(largePartyDueMillis) && now.getTime() < largePartyDueMillis) {
          return; /* 承認後24時間以内。まだ有効 */
        }
      }
      var largePartyPaymentOverdue = !isNaN(largePartyDueMillis) && now.getTime() >= largePartyDueMillis;
      /* 承認待ちの仮押さえには、Issue #668に定めのない自動失効期限（受付からNN時間）を置かない。運営の判断（承認／不承認）まで保持し、
         利用開始時刻を過ぎた未判断のものだけ、残らないよう不成立にする（承認前TTLの要否はIssue #668へ確認中）。 */
      if (Booking.isLargePartyRecord(record) && Booking.largePartyApprovalStatus(record) === Booking.LARGE_PARTY_APPROVAL.PENDING_APPROVAL) {
        if (now.getTime() < startAtMillis) return;
        largePartyPaymentOverdue = true;
      }

      /*
       * Issue #334: カード決済のPENDINGのみCARD_TTL_HOURS（72時間・受付起点）を使う。
       * 現金/PayPay/未定はScript Properties由来のttlConfig.ttlHours（既定24時間）のまま
       * 一切変更しない（Issue #334本文「現金・PayPay・未定の失効挙動（24時間）は変更しない」）。
       * Issue #406: 当日予約のカードのみ、現金等と同じgrace（minHoldHours）を使う（下記）。
       */
      var isCard = Booking.isCardPaymentMethod(record.paymentMethod);

      /*
       * Issue #341 PR-B: Stripe Checkout Session発行済み（paymentStatus===checkout_pending）
       * のカード予約は、旧来のCARD_TTL_HOURS（72時間・受付起点）ではなく、実際にStripeへ
       * 送ったexpires_atを保存し直したpaymentHoldExpiresAt（仮押さえ期限。目安30分）を
       * 使う別クロックで判定する（Issue #341本文「旧『申込+72時間』のTTLはこのPENDINGには
       * 適用しない」）。Checkout Sessionを一度も発行していないカード予約（paymentStatusが
       * not_started/failedのまま。新フロー自体が無効・未使用の場合を含む）は、以下の
       * elseブロックで従来どおりCARD_TTL_HOURSのまま扱う（既存予約・旧Payment Link方式との
       * 互換性維持）。
       */
      var isCheckoutPendingHold = isCard &&
        Booking.normalizePaymentStatus(record.paymentStatus) === Booking.PAYMENT_STATUS.CHECKOUT_PENDING &&
        isDateLike_(record.paymentHoldExpiresAt);

      if (isCheckoutPendingHold) {
        /*
         * Issue #341 PR-Cレビュー対応・1回目: paymentHoldExpiresAtを過ぎてすぐには
         * 失効対象にせず、CardPayment.WEBHOOK_RACE_GRACE_MINUTES分の追加猶予を待つ
         * （Webhook処理は別プロジェクト・別LockServiceのため、Stripeでの決済完了直後の
         * ごく短い時間はWebhookの到達を待つ。CardPayment.gsのWEBHOOK_RACE_GRACE_MINUTES
         * コメント参照）。
         */
        if (now.getTime() < CardPayment.computeExpireSweepEligibleMillis(record.paymentHoldExpiresAt.getTime())) {
          return; /* まだ仮押さえ有効、またはWebhook到達を待つ猶予期間中 */
        }
        /*
         * Stripe側の確認はLock取得前（ネットワーク呼び出しをLockの外で行う。
         * reservePaymentAttempt_と同じ理由）。verifyCheckoutHoldSafeToExpire_が
         * safeToExpire:falseを返した場合はこの回のトリガー実行ではスキップし、次回の
         * トリガー実行で再評価する（Stripe側がまだopenの場合や、API呼び出し自体が
         * 失敗した場合を含む。「決済できるSessionが残っている間にGASだけが枠を解放
         * しない」「決済結果が不明な場合は無条件に解放しない」を満たす）。
         */
        var verification = verifyCheckoutHoldSafeToExpire_(record, now);
        if (!verification.safeToExpire) {
          skippedCount++;
          return;
        }
      } else {
        /*
         * Issue #334: カード決済のPENDINGのみCARD_TTL_HOURS（72時間・受付起点）を使う。
         * 現金/PayPay/未定はScript Properties由来のttlConfig.ttlHours（既定24時間）のまま
         * 一切変更しない（Issue #334本文「現金・PayPay・未定の失効挙動（24時間）は変更しない」）。
         */
        if (Booking.photoSupportStage(record)) {
          /* Issue #667: 作品撮りサポートは72時間/24時間のTTLではなく、承認前＝利用開始の前（運営の確認待ち）、承認後＝支払い期限（承認から24時間）で失効する。 */
          if (now.getTime() < Booking.computePhotoSupportExpiryMillis(record, startAtMillis, ttlConfig.minHoursBeforeStart)) {
            return; /* まだ有効 */
          }
        } else {
        var ttlHours = isCard ? Booking.CARD_TTL_HOURS : ttlConfig.ttlHours;
        /*
         * Issue #406: 当日予約のカードもgrace（minHoldHours）を使う。現金等と同じく、受付時刻
         * (createdAt)の暦日(Asia/Tokyo基準)と利用日(date)が一致する場合のみ。カードで
         * 通常TTL（利用開始-minHoursBeforeStart）が受付時刻以前になる直前の当日予約が、
         * 作成直後（決済開始前）に即EXPIREDになる事故を防ぐ。一致しない（翌日以降）は
         * minHoldHours=0のままで従来のTTL計算と完全に同じ。
         *
         * Issue #270（レビュー対応）: 「利用開始まで2時間未満で受け付けた当日予約」が
         * 作成直後に即EXPIREDになる事故を防ぐため、受付時刻(createdAt)の暦日(Asia/Tokyo基準)と
         * 予約の利用日(date)が一致する場合のみ、Booking.computeTtlExpiryMillisのgrace
         * （通常TTLが受付時刻以前になる直前当日予約にだけ使う最大猶予。利用開始時刻を
         * 必ず上限とする＝expiry<=startAtを保証する）を適用する。一致しない（＝翌日以降に
         * 通常の余裕を持って受け付けた）予約はminHoldHours=0のまま#268時点と完全に同じ
         * TTL計算になる（既存の翌日以降予約のTTLへの影響なし）。
         */
        var createdDateString = Booking.formatDateInTimezone(new Date(createdAtMillis), ttlConfig.timezone);
        var isSameDayBooking = !!createdDateString && record.date === createdDateString;
        var minHoldHours = isSameDayBooking ? ttlConfig.minHoldHours : 0;

        if (!largePartyPaymentOverdue &&
            !Booking.isExpired(createdAtMillis, startAtMillis, ttlHours, ttlConfig.minHoursBeforeStart, now.getTime(), minHoldHours)) {
          return; /* まだ有効 */
        }
        }
      }

      var lock = LockService.getScriptLock();
      var gotLock = lock.tryLock(EXPIRE_LOCK_TIMEOUT_MS_);
      if (!gotLock) {
        Logger.log('expirePendingBookings: lock取得失敗のためスキップ（次回トリガーで再試行）: ' + record.bookingId);
        skippedCount++;
        return;
      }

      try {
        var latest = SpreadsheetRepository.findRowByBookingId(record.bookingId);
        if (!latest || latest.record.status !== Booking.STATUS.PENDING) {
          return; /* confirmBooking等で既に処理済み */
        }
        /* Issue #667: Lock取得前後に承認された作品撮りサポートは、承認で延びた支払い期限で再判定する（承認直後に枠を解放しない）。 */
        if (Booking.photoSupportStage(latest.record) && !isCheckoutPendingHold &&
            now.getTime() < Booking.computePhotoSupportExpiryMillis(latest.record, latest.record.startAt.getTime(), ttlConfig.minHoursBeforeStart)) {
          return;
        }

        /*
         * Issue #341 PR-B: Lock取得前のStripe確認（verifyCheckoutHoldSafeToExpire_）から
         * Lock取得までの間に、他プロセス（Booking Adminプロジェクト内の
         * StripeWebhookProcessor.processPendingStripeWebhookEvents等）がpaymentStatusを
         * 進めている可能性がある。Lock内で最新のpaymentStatusを再確認し、既に
         * checkout_pendingでなくなっていれば（PAID等へ進んでいれば）枠を解放せず処理を
         * スキップする（README「仮押さえの解放とStripe側の失効確認」の3条件どおり、
         * 仮押さえ解放とpaymentStatus遷移は別物だが、解放前の最終確認としてここで見る）。
         */
        if (isCheckoutPendingHold && Booking.normalizePaymentStatus(latest.record.paymentStatus) !== Booking.PAYMENT_STATUS.CHECKOUT_PENDING) {
          return;
        }

        try {
          CalendarRepository.deleteEventById(calendarId, latest.record.calendarEventId);
        } catch (deleteError) {
          try {
            RecoveryRepository.recordFailure({
              bookingId: record.bookingId,
              failureType: 'EXPIRE_CALENDAR_DELETE_FAILED',
              occurredAt: new Date(),
              calendarEventId: latest.record.calendarEventId,
              status: 'PENDING',
              errorMessage: describeError_(deleteError),
              recoveryState: 'OPEN',
              resolvedAt: ''
            });
          } catch (recoveryError) {
            Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
          }
        }

        var expiredAt = new Date();
        try {
          SpreadsheetRepository.updateBookingFields(record.bookingId, {
            status: Booking.STATUS.EXPIRED,
            expiredAt: expiredAt,
            updatedAt: expiredAt
          });
          expiredCount++;
          /* Issue #334: Sheets側のEXPIRED更新が実際に成功した行だけを通知対象にする
             （Sheets更新が失敗した行はPENDINGのまま残り、次回トリガーで再評価されるため、
             ここで通知してしまうと台帳の状態と矛盾する）。 */
          if (isCard) {
            newlyExpiredCardBookingIds.push(record.bookingId);
          }
          /*
           * Issue #341 PR-B: 仮押さえ解放（status側）とpaymentStatus遷移は別物のまま
           * （README「仮押さえの解放とStripe側の失効確認」参照）。applyPaymentStateUpdate
           * 自体もLockService.getScriptLock()を取得するため、この関数（expirePendingBookings）
           * が既に保持しているlockの内側から呼ぶと同一スクリプト内で二重にロックを取ろうと
           * してしまう。そのためbookingIdだけを集め、この候補のlock解放後（finally節の外）に
           * まとめて呼び出す（notifyCustomerExpiredBestEffort_と同じパターン）。
           */
          if (isCheckoutPendingHold) {
            newlyFailedCheckoutHoldBookingIds.push(record.bookingId);
          }
        } catch (sheetsError) {
          /* Calendar側は削除済み（または削除失敗をrecovery記録済み）だが、Sheets側の
             statusをEXPIREDへ更新できなかった場合の不整合をrecoveryへ記録する。
             ここで例外を外へ投げるとforEachの以降の候補が処理されなくなるため、
             このcatchで必ず握りつぶし、他の候補の処理を継続する（レビュー指摘対応:
             1件のSheets更新失敗で他の候補まで巻き込んで未処理にしない）。 */
          try {
            RecoveryRepository.recordFailure({
              bookingId: record.bookingId,
              failureType: 'EXPIRE_SHEETS_UPDATE_FAILED',
              occurredAt: new Date(),
              calendarEventId: latest.record.calendarEventId,
              status: 'PENDING',
              errorMessage: describeError_(sheetsError),
              recoveryState: 'OPEN',
              resolvedAt: ''
            });
          } catch (recoveryError) {
            Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
          }
          skippedCount++;
        }
      } finally {
        lock.releaseLock();
      }
    });

    /*
     * Issue #334: 失効通知メールはLock外・best effortで送る（送信失敗でもEXPIRED状態は
     * 取り消さない。既にSheets側はEXPIREDへ更新済みのため、ここで例外が起きても
     * expiredCount/skippedCountの集計・関数の戻り値には影響させない）。
     */
    newlyExpiredCardBookingIds.forEach(function (bookingId) {
      notifyCustomerExpiredBestEffort_(bookingId);
    });

    /*
     * Issue #341 PR-B: 仮押さえ失効で枠を解放したcheckout_pending予約のpaymentStatusを
     * failedへ進める（best effort。失敗してもexpirePendingBookings自体の戻り値
     * ―expiredCount等―には影響させない。枠解放自体は既に完了しているため、この遷移が
     * 失敗してもEXPIREDを取り消さない。次回このbookingIdへ新しい決済試行が行われる際は
     * reservePaymentAttempt_がpaymentStatus:not_startedのまま残っていた場合と同様に安全に
     * 扱われる想定だが、paymentStatusがcheckout_pendingのまま残ってしまうため、この
     * best effort呼び出し自体の失敗はLoggerで検知できるようにする）。
     *
     * PR #354レビュー対応・3回目: この予約が持つ（失効したSessionの）paymentAttemptIdを
     * ここで同時にpaymentAttemptResolvedAtへ確定させる。これを怠ると、次回この予約へ
     * 新しい決済試行を予約するreservePaymentAttempt_が、失効済みの古いpaymentAttemptIdを
     * 「まだ未解決」と誤認して再利用してしまい（古い期限切れのexpires_atのまま新しい
     * Checkout Sessionを作ろうとする等）、新しい仮押さえが正しく発行されない事故になる。
     */
    newlyFailedCheckoutHoldBookingIds.forEach(function (bookingId) {
      var failResult = applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.FAILED, { paymentAttemptResolvedAt: now }, now);
      if (!failResult.success) {
        Logger.log('expirePendingBookings: 仮押さえ失効後のpaymentStatus:failed遷移に失敗しました: ' + bookingId + ' ' + JSON.stringify(failResult.error));
      }
    });

    return { expiredCount: expiredCount, skippedCount: skippedCount, candidateCount: candidates.length };
  }

  /* 送信失敗はexpirePendingBookings自体の成否・戻り値に影響させない（Issue #334本文
     「送信失敗でもEXPIREDを維持する」）。createBooking側のnotifyCustomerPendingBestEffort_と
     同じredaction方針でLoggerへ記録する。 */
  function notifyCustomerExpiredBestEffort_(bookingId) {
    try {
      BookingMailer.sendExpiredMailForBooking(bookingId);
    } catch (mailError) {
      Logger.log('BookingRepository: EXPIREDメール送信中に予期しない例外: ' + BookingMailer.sanitizeErrorMessage(describeError_(mailError)));
    }
  }

  /*
   * reviveExpiredBooking(bookingId) — EXPIRED予約の手動復活（Issue #334）。
   * 入金確認後の承認が期限に間に合わずEXPIREDになったが、実際には支払い済みだったと
   * 判明した場合に、Booking Admin（Spreadsheetメニュー／Web UI）から呼ぶ専用の復活手順。
   *
   * 既存confirmBookingは変更せず（EXPIREDを引き続き拒否する。confirmBookingLocked_の
   * 明示ガード参照）、この専用関数でのみEXPIRED→CONFIRMEDを行う。confirmBooking/
   * expirePendingBookings/cancelBookingAdminと同じBooking Adminプロジェクトに属し、
   * 同じLockService.getScriptLock()を取得するため、これらと同時に同じbookingIdを
   * 処理することはない。
   *
   * 処理順（Issue #334本文どおり）:
   *   1. Lock取得
   *   2. 最新レコード再読込 → status===EXPIRED かつ 利用開始時刻より前であることを確認
   *   3. Lock内で枠の競合を再確認（BookingAvailability.isStartTimeBookable）
   *   4. 空きがあればCalendarにCONFIRMEDイベントを新規作成
   *      （失効時に旧イベントは削除済みのため、confirmBookingのようにイベントのstatusを
   *      更新するのではなく、createBooking同様に新規作成する）
   *   5. 台帳のstatus/calendarEventId/confirmedAt/updatedAtを更新（expiredAtは履歴として残す）
   *   6. Lock解除
   *   7. Lock外で確定メール（既存sendConfirmedMailForBookingをそのまま使う。
   *      confirmBookingのnotifyCustomerConfirmedBestEffort_を再利用し、メール処理を複製しない）
   *
   * now引数は省略可能（Booking Adminメニュー・Web UIからは常に引数なしで呼ばれ、現在時刻へ
   * フォールバックする）。expirePendingBookings(now)と同じく、テストから「利用開始時刻を
   * 過ぎているか」を固定時刻で検証できるようにするためだけの引数。
   */
  function reviveExpiredBooking(bookingId, now) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    now = isDateLike_(now) ? now : new Date();

    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    var outcome;
    try {
      outcome = reviveExpiredBookingLocked_(bookingId, now);
    } finally {
      lock.releaseLock();
    }

    /* confirmBookingと同じくLockの外・best effortで確定メールを送る。メールの成否は
       reviveExpiredBooking自体の成否には影響させない（Issue #334本文
       「メール失敗で予約確定を巻き戻さない」）。既存のnotifyCustomerConfirmedBestEffort_を
       そのまま再利用する（メール送信処理を複製しない）。 */
    if (outcome.shouldTryMail) {
      notifyCustomerConfirmedBestEffort_(bookingId, outcome.response);
    }

    return outcome.response;
  }

  function reviveExpiredBookingLocked_(bookingId, now) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return {
        response: { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } },
        shouldTryMail: false
      };
    }

    var record = found.record;

    /* 復活の対象はEXPIREDのみ（支払方法は問わない。Issue #334本文どおり）。
       PENDING/CONFIRMED/CANCELLEDはここでは一切扱わない（それぞれ既存の
       confirmBooking/cancelBookingAdminの対象）。 */
    if (record.status !== Booking.STATUS.EXPIRED) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CONFIRMED への復活はできません（EXPIREDのみ対象）。' }
        },
        shouldTryMail: false
      };
    }

    var reviveMemberRejection = pairPackMembershipRejection_(record);
    if (reviveMemberRejection) return reviveMemberRejection;

    var startAtMillis = isDateLike_(record.startAt) ? record.startAt.getTime() : NaN;
    if (isNaN(startAtMillis) || now.getTime() >= startAtMillis) {
      return {
        response: {
          success: false,
          error: { code: 'REVIVE_AFTER_START_NOT_ALLOWED', message: '利用開始時刻を過ぎているため復活できません。' }
        },
        shouldTryMail: false
      };
    }

    /*
     * Lock内で枠の競合を再確認する（Issue #334本文「Lock内で枠の競合を再確認し」）。
     * 失効時にCalendarイベントは削除済みのため自分自身のイベントと衝突することはなく、
     * createBookingと同じisStartTimeBookableをそのまま使える。dateString/startTimeString/
     * durationMinutesはSheets台帳のstartAt/endAt（実データ）から復元する
     * （record.dateの型ゆれに依存しない。BookingAdminWeb.gsのformatAdminDate_と同じ注意点）。
     */
    var availabilityConfig = BookingConfig.getAvailabilityConfig();
    var calendarId = BookingConfig.getCalendarId();
    var dateString = BookingAvailability.formatDateInTimezone(record.startAt, availabilityConfig.timezone);
    var startTimeString = BookingAvailability.formatTimeInTimezone(record.startAt, availabilityConfig.timezone);
    if (!dateString || !startTimeString || !isDateLike_(record.endAt)) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_CONFIG', message: '予約データの日時が不正なため復活できません。' }
        },
        shouldTryMail: false
      };
    }
    var durationMinutes = Math.round((record.endAt.getTime() - record.startAt.getTime()) / 60000);
    var startMinutes = BookingAvailability.parseTimeToMinutes(startTimeString);

    var busyIntervals = CalendarRepository.getBusyIntervalsForDate(calendarId, dateString, availabilityConfig.timezone);
    var bookable = BookingAvailability.isStartTimeBookable(startMinutes, durationMinutes, busyIntervals, availabilityConfig.bufferMinutes);
    if (!bookable) {
      return {
        response: {
          success: false,
          error: { code: 'SLOT_UNAVAILABLE', message: 'この枠は既に埋まっているため復活できません。' }
        },
        shouldTryMail: false
      };
    }

    /* 空きがあればCONFIRMEDのCalendarイベントを新規作成する（Issue #334本文どおり）。
       createBookingEventは常にPENDINGタイトル/タグで作成するため、直後にsetEventStatusで
       CONFIRMEDへ更新する（CalendarRepository.gs自体は変更しない）。
       createBookingEvent自体の失敗（イベント未作成）とsetEventStatusの失敗（イベントは
       作成済みだがCONFIRMEDへ更新できない）は、補償対象・記録すべき内容が異なるため
       別のtry/catchに分ける（PRレビュー対応）。 */
    var eventId;
    try {
      eventId = CalendarRepository.createBookingEvent(calendarId, {
        date: dateString,
        startTime: startTimeString,
        durationMinutes: durationMinutes,
        timezone: availabilityConfig.timezone,
        bookingId: bookingId,
        brand: record.brand
      });
    } catch (createError) {
      /* イベント自体が作成されていないため、補償（削除）対象は無い。 */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'REVIVE_CALENDAR_CREATE_FAILED',
          occurredAt: new Date(),
          calendarEventId: '',
          status: record.status,
          errorMessage: describeError_(createError),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'REVIVE_CALENDAR_FAILED', message: 'Calendarへの復活登録に失敗しました。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    try {
      CalendarRepository.setEventStatus(calendarId, eventId, Booking.STATUS.CONFIRMED, bookingId);
    } catch (statusError) {
      /* イベントは新規作成済み（PENDINGタイトル/タグのまま）だが、CONFIRMEDへの更新に
         失敗した状態（PRレビュー対応: Calendarイベント新規作成成功後にsetEventStatusが
         失敗した場合の補償）。この時点ではSheetsを一切更新していないため、予約は
         EXPIREDのまま維持し、新規作成したイベントの補償削除を試みる。 */
      return { response: handleReviveEventStatusFailure_(calendarId, bookingId, eventId, statusError, record.status), shouldTryMail: false };
    }

    var confirmedAt = new Date();
    try {
      /* expiredAtは履歴として残す（Issue #334本文どおり。ここでは触らない）。 */
      SpreadsheetRepository.updateBookingFields(bookingId, {
        status: Booking.STATUS.CONFIRMED,
        calendarEventId: eventId,
        confirmedAt: confirmedAt,
        updatedAt: confirmedAt
      });
    } catch (sheetsError) {
      return { response: handleReviveSheetsUpdateFailure_(calendarId, bookingId, eventId, sheetsError), shouldTryMail: false };
    }

    return { response: { success: true, bookingId: bookingId, status: Booking.STATUS.CONFIRMED }, shouldTryMail: true };
  }

  /*
   * Calendarイベント新規作成成功 → setEventStatus（CONFIRMEDへの更新）失敗の部分失敗補償
   * （PRレビュー対応）。この時点でSheetsは一切更新していない（Sheets書き込みより前段階の
   * 失敗のため）ため、Sheetsへの更新は行わず、予約はEXPIREDのまま維持する。新規作成した
   * イベントの補償削除を試み、成功すれば「作成しなかった状態」へ完全に戻る（イベントは
   * 存在しない・SheetsはEXPIREDのまま＝復活試行前と同じ状態）。削除にも失敗した場合は
   * PENDINGタイトル/タグのまま残る孤立イベントとしてRecoveryへOPENで記録する
   * （handleReviveSheetsUpdateFailure_と対になる、より早い段階の失敗ケース）。
   */
  function handleReviveEventStatusFailure_(calendarId, bookingId, eventId, statusError, bookingStatus) {
    var compensated = false;
    var compensationError = null;
    try {
      CalendarRepository.deleteEventById(calendarId, eventId);
      compensated = true;
    } catch (deleteError) {
      compensationError = deleteError;
    }

    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: compensated ? 'REVIVE_CALENDAR_STATUS_FAILED_ROLLED_BACK' : 'REVIVE_CALENDAR_STATUS_FAILED_ORPHANED',
        occurredAt: new Date(),
        calendarEventId: eventId,
        /* Sheetsは一切更新していないため、予約の実際のstatusは常にEXPIREDのまま。 */
        status: bookingStatus,
        errorMessage: describeError_(statusError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }

    return {
      success: false,
      error: { code: 'REVIVE_CALENDAR_STATUS_FAILED', message: 'Calendarの確定状態への更新に失敗しました。Recoveryシートを確認してください。' }
    };
  }

  /*
   * Calendar成功（新規CONFIRMEDイベント作成）→ Sheets失敗（statusをCONFIRMEDへ更新できない）の
   * 部分失敗補償（Issue #334本文「Calendar成功／Sheets失敗時は既存Recovery方式に合わせる」）。
   * confirmBookingのhandleConfirmSheetsUpdateFailure_はイベントのstatusをPENDINGへ戻す
   * （元々PENDINGのイベントだったため）が、reviveExpiredBookingは失効時に削除済みだった
   * イベントを新規作成しているため、「無かった状態」へ戻すには削除が正しい補償である。
   * これはcreateBookingのhandleSheetsSaveFailure_（Calendar成功→Sheets失敗→Calendar補償削除）と
   * 同じ形であり、RecoveryRepository.gsに既存のfailureType定数
   * （CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE / SHEETS_FAILURE_CALENDAR_ORPHANED）を
   * そのまま再利用する（新規のfailureTypeを増やさない）。
   */
  function handleReviveSheetsUpdateFailure_(calendarId, bookingId, eventId, sheetsError) {
    var compensated = false;
    var compensationError = null;
    try {
      CalendarRepository.deleteEventById(calendarId, eventId);
      compensated = true;
    } catch (deleteError) {
      compensationError = deleteError;
    }

    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: compensated ? 'CALENDAR_ROLLED_BACK_AFTER_SHEETS_FAILURE' : 'SHEETS_FAILURE_CALENDAR_ORPHANED',
        occurredAt: new Date(),
        calendarEventId: eventId,
        status: compensated ? 'EXPIRED' : 'CONFIRMED',
        errorMessage: describeError_(sheetsError) + (compensationError ? ' / compensation error: ' + describeError_(compensationError) : ''),
        recoveryState: compensated ? 'RESOLVED' : 'OPEN',
        resolvedAt: compensated ? new Date() : ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }

    return {
      success: false,
      error: { code: 'REVIVE_SAVE_FAILED', message: '復活内容の保存に失敗しました。Recoveryシートを確認してください。' }
    };
  }

  /*
   * cancelBookingAdmin(bookingId) — Spreadsheetのカスタムメニュー（BookingAdmin.gs。
   * Booking Adminプロジェクト）から呼ばれる正式なキャンセル手順（Issue #272）。
   * PENDING/CONFIRMEDのいずれからもCANCELLEDへ遷移できる。Booking Web App側には
   * このキャンセル機能を一切公開しない（利用者自身のキャンセルURLは非対象）。
   *
   * confirmBooking / expirePendingBookingsと同じBooking Adminプロジェクトに属し、
   * 同じLockService.getScriptLock()を取得するため、この3関数の間では常に1つの
   * 状態遷移だけが成立する（Lock取得後に必ずSheetsを再読込し、Lock取得前の古い
   * statusで判定しない）。
   */
  function cancelBookingAdmin(bookingId) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }

    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    var outcome;
    try {
      outcome = cancelBookingAdminLocked_(bookingId, null);
    } finally {
      lock.releaseLock();
    }

    /*
     * キャンセルメール（#271のBookingMailer.sendCancelledMailForBooking）はbooking Lockの
     * 外・best effortで送る。Calendar/Sheetsのキャンセル処理自体が成功した場合のみ
     * 試行する（Sheetsを更新できていない部分失敗ではメールを送らない）。
     */
    if (outcome.shouldTryMail) {
      notifyCustomerCancelledBestEffort_(bookingId, outcome.response);
    }

    return outcome.response;
  }

  /* cancelBookingAdminのLock保持区間の本体。戻り値: { response, shouldTryMail }。
     Issue #272本文どおり、Lock取得後に必ずSheetsを最新再読込してからstatusを判定する。 */
  function cancelBookingAdminLocked_(bookingId, options) {
    var opts = options || {};
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) {
      return { response: handleCancelSheetsRowMissing_(bookingId), shouldTryMail: false };
    }

    var record = found.record;

    if (record.status === Booking.STATUS.CANCELLED) {
      /* 二重実行しても壊れない: Calendar削除・cancelledAt上書きのいずれも行わず、
         cancelMailSentAtが空の場合だけメール送信を再試行する（#271のSentAt冪等性を再利用）。 */
      return {
        response: { success: true, alreadyCancelled: true, bookingId: bookingId, status: Booking.STATUS.CANCELLED },
        shouldTryMail: !record.cancelMailSentAt
      };
    }

    if (!Booking.canTransition(record.status, Booking.STATUS.CANCELLED)) {
      return {
        response: {
          success: false,
          error: { code: 'INVALID_TRANSITION', message: record.status + ' から CANCELLED へは遷移できません。' }
        },
        shouldTryMail: false
      };
    }

    /*
     * Issue #341 PR-D: Stripeで入金済み（paid）・返金処理中（refund_pending）・決済状態不明の
     * 予約は、返金方法（全額/一部/返金なし）の判断を伴う専用の取消（BookingRefund.
     * cancelWithRefund。Booking Adminの「取消・返金」）からのみ取り消せる。従来の
     * キャンセル（Spreadsheetメニュー・一覧のキャンセルボタン）から実行すると、返金の
     * 判断・記録が無いまま入金済みの予約だけが取り消されるため、Calendar/Sheetsに触れる
     * 前に拒否する。現金・PayPay・旧Payment Link方式の予約、決済前（checkout_pending等）の
     * カード予約は従来どおり（opts.allowStripePaidはBookingRefund.gsのみが指定する）。
     */
    /*
     * PR-Dレビュー対応・1回目: 決済待ち（checkout_pending）・決済開始の結果が未確定の予約も
     * 同様に「取消・返金」からのみ取り消す。従来のキャンセルは発行済みのCheckout Session
     * （決済URL）を失効させないため、取消後に利用者が入金できてしまう。「取消・返金」の
     * 「返金なし」はSessionをStripe側でも失効させる（BookingRefund.cancelUnpaidCheckout_）。
     */
    if (!opts.allowStripePaid && Booking.isStripeCheckoutBooking(record)) {
      var currentPaymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
      var paidOrRefunding = currentPaymentStatus === null ||
        currentPaymentStatus === Booking.PAYMENT_STATUS.PAID ||
        currentPaymentStatus === Booking.PAYMENT_STATUS.REFUND_PENDING;
      var checkoutMayBeOpen = currentPaymentStatus === Booking.PAYMENT_STATUS.CHECKOUT_PENDING ||
        (!!record.paymentAttemptId && !record.paymentAttemptResolvedAt);
      if (paidOrRefunding || checkoutMayBeOpen) {
        return {
          response: {
            success: false,
            error: {
              code: 'REFUND_DECISION_REQUIRED',
              message: paidOrRefunding
                ? 'Stripeで入金済みの予約です。Booking Adminの予約詳細「取消・返金」から、返金方法を選んで取り消してください。'
                : 'Stripeの決済URLを発行済みの予約です。Booking Adminの予約詳細「取消・返金」の「返金なし（取消のみ）」から取り消してください（決済URLもStripe側で失効させます）。'
            }
          },
          shouldTryMail: false
        };
      }
    }

    var calendarId = BookingConfig.getCalendarId();
    var event;
    try {
      event = CalendarRepository.getEventById(calendarId, record.calendarEventId);
    } catch (lookupError) {
      /*
       * getEventById()はイベントが無い場合はnullを返すが、CALENDAR_ID不正・Calendar
       * アクセス障害等では例外を投げる（PRレビュー対応）。この例外を捕捉せずに
       * 抜けると、Lockはfinallyで解除されるものの、Recoveryに何も記録されず
       * 部分失敗が追跡できなくなる。Sheets/Calendarのいずれも変更せず、メールも
       * 送らずにfail-closedで返す。
       */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_CALENDAR_LOOKUP_FAILED',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: BookingMailer.sanitizeErrorMessage(describeError_(lookupError)),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'CANCEL_CALENDAR_LOOKUP_FAILED', message: 'Calendarの予約状態を確認できませんでした。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    if (!event) {
      /*
       * Calendar側が既に非占有（＝枠は既に空いている）なので、SheetsをCANCELLEDへ
       * 進めてキャンセル処理を収束させる。「なぜCalendarだけ無かったか」はRecoveryで
       * 人が確認できるようにOPENのまま記録する（自動ではRESOLVEDにしない）。
       */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_CALENDAR_EVENT_MISSING',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: 'cancelBookingAdmin時にCalendarイベントが既に存在しませんでした。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return finalizeCancelledSheetsUpdate_(bookingId, record, true);
    }

    try {
      CalendarRepository.deleteEventById(calendarId, record.calendarEventId);
    } catch (deleteError) {
      /*
       * イベントは存在したが削除自体が失敗した場合、Calendarがまだ占有している
       * 可能性があるため、Sheetsは元statusのまま進めない（メールも送らない）。
       */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_CALENDAR_DELETE_FAILED',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: describeError_(deleteError),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'CANCEL_CALENDAR_FAILED', message: 'Calendarのキャンセル処理に失敗しました。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    return finalizeCancelledSheetsUpdate_(bookingId, record, false);
  }

  /*
   * Calendar側の非占有化（削除成功、または元から既に無かった）が確定した後、Sheetsを
   * CANCELLEDへ進める共通処理。ここでSheets更新自体が失敗した場合は、Calendarイベントを
   * 無理に再作成して補償しない（再作成するとeventIdが変わり、Sheets更新障害中に
   * 書き戻せないため二次的不整合を増やす）。次回同じbookingIdでcancelBookingAdminを
   * 再実行すれば、Calendarが既に無い経路（#9）からSheetsをCANCELLEDへ収束できる。
   */
  function finalizeCancelledSheetsUpdate_(bookingId, record, calendarAlreadyMissing) {
    var now = new Date();
    try {
      /*
       * status/cancelledAt/updatedAtの3項目は必ず1回のSpreadsheet書き込みで反映する
       * （PRレビュー対応）。updateBookingFieldsのようにフィールドごとに個別書き込みすると、
       * 途中で例外が起きた場合にstatusだけCANCELLEDになりcancelledAtが空、という
       * 部分更新が起こり得る。部分更新が起きると、次回再実行時にstatus===CANCELLEDの
       * 分岐（二重実行の冪等処理）へ入ってしまい、空のままのcancelledAt/updatedAtを
       * 修復する経路が無くなるため、この関数では単一書き込みの
       * updateBookingCancellationStateAtomicを使う。
       *
       * この関数はstatus/cancelledAt/updatedAt（HEADERS_上で連続する13〜20列目）だけを
       * 書き込み対象にし、21列目以降（customerType・mail SentAt・lastMailError*）には
       * 一切触れない（PRレビュー2回目対応）。Booking Web App（別GASプロジェクト・
       * 別LockService）がこの直前直後にpendingMailSentAt等を更新していても、その値を
       * 古い状態で巻き戻すことはない。
       */
      SpreadsheetRepository.updateBookingCancellationStateAtomic(bookingId, {
        status: Booking.STATUS.CANCELLED,
        cancelledAt: now,
        updatedAt: now
      });
    } catch (sheetsError) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_SHEETS_UPDATE_FAILED_CALENDAR_REMOVED',
          occurredAt: new Date(),
          calendarEventId: record.calendarEventId,
          status: record.status,
          errorMessage: describeError_(sheetsError),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        response: {
          success: false,
          error: { code: 'CANCEL_SAVE_FAILED', message: 'Calendar側はキャンセルされましたが、予約台帳の更新に失敗しました。Recoveryシートを確認してください。' }
        },
        shouldTryMail: false
      };
    }

    var response = { success: true, bookingId: bookingId, status: Booking.STATUS.CANCELLED };
    if (calendarAlreadyMissing) {
      response.calendarAlreadyMissing = true;
    }
    return { response: response, shouldTryMail: true };
  }

  /*
   * Sheets行が見つからない場合の診断（Issue #272「13. Sheets行が存在しない場合」）。
   * bookingId形式から利用日を復元し、対象日のCalendarをbookingIdタグで走査する。
   * 通常キャンセルではこの経路は使わない（異常時のRecovery支援専用）。Calendarは
   * いずれのケースも自動削除しない（Sheetsという正式台帳が無い状態で破壊的変更を
   * 行うのは危険なため）。
   */
  function handleCancelSheetsRowMissing_(bookingId) {
    var notFoundResponse = { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
    var dateString = parseBookingDateFromId_(bookingId);
    if (!dateString) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_BOOKING_NOT_FOUND',
          occurredAt: new Date(),
          calendarEventId: '',
          status: '',
          errorMessage: 'bookingIdの形式が不正なため、Calendar診断をスキップしました。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return notFoundResponse;
    }

    var calendarId = BookingConfig.getCalendarId();
    var timezone = BookingConfig.getAvailabilityConfig().timezone;
    var matches;
    try {
      matches = CalendarRepository.findBookingEventsByBookingId(calendarId, bookingId, dateString, timezone);
    } catch (lookupError) {
      /* 診断自体のCalendar走査が失敗した場合も、生例外で処理を抜けずRecoveryへ記録する
         （PRレビュー対応）。Calendarは変更しない。 */
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_DIAGNOSTIC_CALENDAR_LOOKUP_FAILED',
          occurredAt: new Date(),
          calendarEventId: '',
          status: '',
          errorMessage: BookingMailer.sanitizeErrorMessage(describeError_(lookupError)),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        success: false,
        error: { code: 'CANCEL_DIAGNOSTIC_FAILED', message: 'Calendarの診断中にエラーが発生しました。Recoveryシートを確認してください。' }
      };
    }

    if (matches.length === 1) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_SHEETS_ROW_MISSING_CALENDAR_PRESENT',
          occurredAt: new Date(),
          calendarEventId: matches[0].getId(),
          status: '',
          errorMessage: 'Sheets台帳にbookingId行が無く、Calendarには対応するイベントが1件見つかりました。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    } else if (matches.length > 1) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_MULTIPLE_CALENDAR_EVENTS_FOUND',
          occurredAt: new Date(),
          calendarEventId: matches.map(function (e) { return e.getId(); }).join(', '),
          status: '',
          errorMessage: 'Sheets台帳にbookingId行が無く、Calendarには対応するイベントが複数見つかりました。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    } else {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'CANCEL_BOOKING_NOT_FOUND',
          occurredAt: new Date(),
          calendarEventId: '',
          status: '',
          errorMessage: 'Sheets台帳にもCalendarにも該当するbookingIdが見つかりませんでした。',
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
    }

    return notFoundResponse;
  }

  /* bookingId（例: 'SX-20261001-3F2A9B1C'）から利用日'YYYY-MM-DD'を復元する。
     形式が不正な場合はnullを返す（呼び出し側はCalendar走査をせずNOT_FOUNDにする）。 */
  function parseBookingDateFromId_(bookingId) {
    var match = /^[A-Za-z]+-(\d{4})(\d{2})(\d{2})-[0-9A-Za-z]{8}$/.exec(String(bookingId || ''));
    if (!match) return null;
    return match[1] + '-' + match[2] + '-' + match[3];
  }

  /* response（cancelBookingAdminの戻り値オブジェクト）へmailSent/mailErrorを補助情報として
     追加する。メール失敗はcancelBookingAdmin自体の成功可否には影響させない
     （Calendar/Sheetsの状態はメール失敗を理由に元へ戻さない）。 */
  function notifyCustomerCancelledBestEffort_(bookingId, response) {
    try {
      var mailResult = BookingMailer.sendCancelledMailForBooking(bookingId);
      response.mailSent = !!(mailResult && mailResult.success && !mailResult.skipped);
      if (!mailResult || !mailResult.success) {
        response.mailError = mailResult && mailResult.error;
      }
    } catch (mailError) {
      var sanitizedMessage = BookingMailer.sanitizeErrorMessage(describeError_(mailError));
      Logger.log('BookingRepository: CANCELLEDメール送信中に予期しない例外: ' + sanitizedMessage);
      response.mailSent = false;
      response.mailError = { code: 'UNEXPECTED_ERROR', message: sanitizedMessage };
    }
  }

  /*
   * 予約確定前の金額修正（Issue #342 管理者向け機能）。管理者が確認した金額が
   * priceAmount（予約時点の自動計算値）と異なる場合に使う（例: 自己申告の会員区分が
   * 実際には誤っていた等）。priceAmount自体は上書きせず、priceOverrideAmount/
   * priceOverrideAtへ別途記録することで、自動計算値と修正後の値を区別できるようにする
   * （Issue #342本文「元の自動計算金額と修正後の金額を区別できるようにする」）。
   * 実際に案内すべき金額（自動計算値 or 上書き値）はBooking.getEffectivePriceAmountに
   * 一元化する（ここでは書き込みのみを行い、読み取り側の判定ロジックを複製しない）。
   *
   * 対象はPENDINGのみ（Issue #342本文「予約確定前に金額を修正できる」）。CONFIRMED/
   * CANCELLED/EXPIREDでは拒否する（fail-closed。確定後の金額変更は既存の確定メール・
   * 決済案内との整合が取れなくなるため、この関数の対象外とする）。
   * confirmBooking/cancelBookingAdmin等と異なりCalendar操作・メール送信を一切行わない
   * ため、Lockは金額の読み取り→書き込みの一貫性を保証するためだけに保持する。
   */
  var MAX_PRICE_OVERRIDE_JPY_ = 1000000;

  function updateBookingPrice(bookingId, newAmountJpy, now) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var amount = Number(newAmountJpy);
    if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0 || amount > MAX_PRICE_OVERRIDE_JPY_) {
      return {
        success: false,
        error: {
          code: 'INVALID_PRICE_AMOUNT',
          message: '金額は1円以上' + MAX_PRICE_OVERRIDE_JPY_ + '円以下の整数で指定してください。'
        }
      };
    }

    var lock = LockService.getScriptLock();
    var gotLock = lock.tryLock(LOCK_TIMEOUT_MS_);
    if (!gotLock) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }

    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
      }
      var record = found.record;
      if (record.status !== Booking.STATUS.PENDING) {
        return {
          success: false,
          error: {
            code: 'INVALID_STATUS_FOR_PRICE_OVERRIDE',
            message: '予約確定前（PENDING）の予約のみ金額を修正できます（現在のstatus: ' + record.status + '）。'
          }
        };
      }

      var effectiveNow = isDateLike_(now) ? now : new Date();
      /* 同一ミリ秒に送信→再修正しても、最新の修正を送信済みと誤判定しない。 */
      if (record.priceUpdateMailSentAt) {
        var previousSentAt = new Date(record.priceUpdateMailSentAt).getTime();
        if (Number.isFinite(previousSentAt) && effectiveNow.getTime() <= previousSentAt) {
          effectiveNow = new Date(previousSentAt + 1);
        }
      }
      SpreadsheetRepository.updateBookingFields(bookingId, {
        priceOverrideAmount: amount,
        priceOverrideAt: effectiveNow
      });

      return {
        success: true,
        bookingId: bookingId,
        priceAmount: record.priceAmount,
        priceOverrideAmount: amount
      };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * Issue #341 PR-Aレビュー対応: 決済状態（paymentStatus）の整合性を保証する共通更新処理。
   * 実際にStripe API・Webhookを呼ぶPR-B/PR-Cが、この関数を経由してのみpaymentStatus・
   * 決済付随情報（paymentAttemptId〜paymentRecoveryReasonの17列）を更新することを想定する
   * （SpreadsheetRepository.updateBookingPaymentStateAtomic/updateBookingFieldsを個別に
   * 直接呼ばせない）。PR-A時点ではこの関数を呼び出す実際の決済処理（Checkout Session発行・
   * Webhook確認・自動返金）は存在しない。
   *
   * 設計上の要点:
   * 1. LockService.getScriptLock()で排他制御する（confirmBooking等と同じ
   *    LOCK_TIMEOUT_MS_=10秒。呼び出し元のGASプロジェクトのLockと共有される）。
   * 2. 更新順序を固定する：**先に決済付随情報の17列（updateBookingPaymentStateAtomic。
   *    HEADERS_上で連続する1回のRange.setValues）、その後にpaymentStatus単独
   *    （updateBookingFields）の順**。paymentStatus（30列目）は17列の範囲と連続して
   *    いないため、レビュー対応前は「無関係な既存25列を巻き込む1回の書き込み」に
   *    まとめる案もあったが、それは他プロセスの並行更新を上書きする事故を招くため採用
   *    しない（PR-Aの元設計のまま。updateBookingPaymentStateAtomicのコメント参照）。
   *    2回に分かれる書き込みの順序をこの向きに固定する理由：詳細情報（Stripeの
   *    PaymentIntent id・lastStripeEventId等の証跡）が先に確定してからpaymentStatusという
   *    「状態のまとめ」が最後に確定する向きにすることで、万一paymentStatus側の書き込みだけが
   *    失敗しても「詳細情報はあるのに状態だけ古い」という検出しやすい不整合にとどまる。
   *    逆向き（先にpaymentStatusをPAID等へ進めてから詳細情報を書く）だと、詳細情報
   *    （特にlastStripeEventId）が伴わないままpaymentStatusだけが「決済成功」を騙る状態が
   *    生じ、同一Webhookイベントの重複配信をlastStripeEventIdで検出できないまま
   *    paymentStatus側の遷移チェックだけがそれを弾こうとする不安定な状態になる。
   * 3. 部分失敗時のRecovery記録：詳細情報の書き込み自体が失敗した場合は、この呼び出しでは
   *    何も変化していないため（1回のRange.setValuesが失敗すれば部分列だけ反映される
   *    ことはない）、要復旧フラグは立てず、呼び出し元が最初からやり直せばよいという
   *    扱いにする（PAYMENT_DETAIL_WRITE_FAILED）。一方、詳細情報の書き込みには成功した
   *    のにpaymentStatus側の書き込みだけが失敗した場合は、台帳が「詳細情報は新しいが
   *    状態は古い」という不整合な状態のまま残るため、paymentRecoveryRequiredAt/
   *    paymentRecoveryReasonを立て、RecoveryRepositoryにも記録し、以後のこの関数の呼び出し
   *    をすべて拒否する（PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT。
   *    BookingReschedule.commit/feeRecoveryRequiredAtと同じ「要復旧フラグが立っている間は
   *    自動処理を止め、明示的な補正を待つ」設計を踏襲する。実際の補正手段（管理者による
   *    確認・解除）はPR-D側で用意する）。
   * 4. 再実行時の整合性検証：この関数自体は「現在のpaymentStatusが既にtoPaymentStatusと
   *    一致している」場合、何も書き込まずalreadyApplied:trueで成功を返す（Stripeの
   *    Webhook再送・呼び出し元の重複リトライを安全に吸収する）。現在のpaymentStatusが
   *    未知の値（Booking.normalizePaymentStatusがnullを返す）の場合は「未決済だろう」と
   *    決めつけて処理を進めず、即座に要復旧として停止する（Issue #341 PR-Aレビュー対応・
   *    項目2）。要復旧フラグが既に立っている予約は、詳細を再判定するまでもなく先頭で
   *    即座に拒否する。
   *
   * fields: SpreadsheetRepository.updateBookingPaymentStateAtomicが受け付ける17列の
   *   部分集合（省略・空オブジェクト可。例えばFAILED→CHECKOUT_PENDINGの再試行のように
   *   付随情報を伴わない遷移もある）。
   * 戻り値: { success: true } / { success: true, alreadyApplied: true } /
   *   { success: false, error: { code, message } }
   *
   * 2回目レビュー対応で追加した冪等性・証跡検証:
   * 5. **alreadyAppliedの判定は決済状態の一致だけに頼らない**。IDENTITY_FIELDS_
   *    （paymentAttemptId/stripeCheckoutSessionId/stripePaymentIntentId）のうち、
   *    呼び出し元が`fields`で明示的に主張した項目を、台帳の現在値と突き合わせる。
   *    現在のpaymentStatusが既にtoPaymentStatusと一致していても、主張した識別子の
   *    いずれかが台帳の値と食い違えば「別の決済試行が同じ目標状態を主張している」
   *    可能性があるため、alreadyApplied:trueで安全側に丸めず、要復旧として停止する
   *    （PAYMENT_IDENTITY_MISMATCH）。呼び出し元が識別子を何も主張しない場合
   *    （fieldsを省略、またはIDENTITY_FIELDS_に該当するキーを含まない）は、従来どおり
   *    状態の一致のみでalreadyApplied:trueとする（判定材料が無い以上、状態の一致を
   *    信頼する以外にできることがないため）。
   * 6. **決済証跡の整合性検証**：toPaymentStatusごとに、PR-B/PR-Cが実際にその遷移で
   *    得るはずの識別子（REQUIRED_EVIDENCE_FOR_STATUS_）を定義し、`fields`とその時点の
   *    台帳の値を合わせても必須項目が揃わない場合は、遷移を許可された組（
   *    canTransitionPaymentStatus）であっても書き込みを行わず拒否する
   *    （PAYMENT_EVIDENCE_MISSING）。「PAIDと主張されているのにStripeの決済識別子が
   *    一つも無い」といった証跡の欠落した成功報告を無条件に信用しない。
   *    PR-A時点では実際にStripe APIを呼ばないため、ここでの「必須」はPR-B/PR-Cが
   *    その状態に遷移する際に実際に得られるはずの値をコード上の約束として先取りした
   *    ものであり、値そのものの真正性（Stripe側との実照合）はPR-C側の署名検証・
   *    verifyPaymentAgainstSnapshotの責務のまま変わらない。
   *
   * 3回目レビュー対応で追加した検証（「同一状態への再実行」経路の強化）:
   * 7. **「既に目的の状態」の経路でも証跡検証を回避できないようにする**。2回目対応時点
   *    では、currentPaymentStatus===toPaymentStatusの分岐がfindMissingPaymentEvidence_を
   *    一切経由しないままalreadyApplied:trueに到達できてしまっていた（台帳が既に'paid'を
   *    名乗っていても、必須の決済識別子が一つも記録されていない場合に、識別子を指定
   *    しない再実行が無条件に成功扱いになる抜け穴）。この分岐でも同じ
   *    findMissingPaymentEvidence_を先に通し、証跡が欠けていればPAYMENT_EVIDENCE_MISSING
   *    として拒否する。
   * 8. **資金移動を伴う状態（paid/refund_pending/refunded）は、識別子を主張しない
   *    呼び出しを無条件に同一処理とみなさない**（paymentIdentityConfirmed_）。
   *    paymentIdentityMatches_は「主張された値が食い違わないか」だけを見るため、呼び出し
   *    元が識別子を一つも主張しなければ素通りしてしまう。これらの状態への再確認では、
   *    その状態を裏付ける識別子（MONETARY_IDENTITY_CONFIRMATION_FIELDS_。
   *    REQUIRED_EVIDENCE_FOR_STATUSと同じ集合）を呼び出し元が実際に主張し、かつ台帳と
   *    一致して初めて「同一の決済・返金処理」と認める。確認できなければ
   *    PAYMENT_IDENTITY_UNCONFIRMEDで停止する。**このためPR-B/PR-Cは、paid/
   *    refund_pending/refundedへの呼び出し（初回・再送を問わず）で、対応する識別子を
   *    毎回必ずfieldsに含めること**（下記の契約表参照。省略すると再送のたびに拒否
   *    される）。
   *
   * 要復旧ゲート（PAYMENT_RECOVERY_REQUIRED）を立てるかどうかは検知内容ごとに分ける:
   * - PAYMENT_IDENTITY_MISMATCH／PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT／
   *   UNKNOWN_PAYMENT_STATUS／**「既に目的の状態」の経路で検知したPAYMENT_EVIDENCE_
   *   MISSING**は、台帳側の記録そのものが既に不整合（または不整合の疑いがある）状態の
   *   ため、恒久ゲートを立てて以後の自動呼び出しをすべて拒否し、管理者の確認を必須に
   *   する。
   * - **新規遷移時**に検知したPAYMENT_EVIDENCE_MISSINGと、PAYMENT_IDENTITY_UNCONFIRMEDは、
   *   この回の呼び出しを拒否した時点で台帳を一切変更しておらず（検証はBookingsへの
   *   書き込みより前に行う）、単に今回の呼び出しが証跡・識別子を渡し忘れただけの可能性が
   *   高いため、恒久ゲートは立てない。RecoveryRepositoryへは監査記録として残す
   *   （recordPaymentEvidenceAuditBestEffort_）が、正しい証跡を添えれば同じbookingIdへ
   *   即座に再試行できる。
   *
   * ## PR-B/PR-Cが守るべき契約（fieldsに含めるべき識別子）
   *
   * | toPaymentStatus | 初回遷移・再送のいずれでも毎回fieldsに含めること |
   * | --- | --- |
   * | checkout_pending | paymentAttemptId, stripeCheckoutSessionId |
   * | paid | stripePaymentIntentId, lastStripeEventId |
   * | refund_pending | stripeRefundId |
   * | refunded | stripeRefundId |
   * | failed | （必須項目なし。ただし判明していればpaymentAttemptId等を含めてよい） |
   *
   * paid/refund_pending/refundedは「既に到達済みの状態を裏付ける識別子」でもあるため、
   * Webhookの重複配信やリトライで同じ状態へ再度呼び出す場合も、これらの識別子を
   * 省略しないこと。省略すると（項目8のとおり）PAYMENT_IDENTITY_UNCONFIRMEDで拒否される。
   */
  function applyPaymentStateUpdate(bookingId, toPaymentStatus, fields, now, options) {
    if (!bookingId) {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    try {
      /* options.writeGuard: confirmBookingと同じ（writeGuardRejection_参照。レビュー対応・7回目）。 */
      var guardRejection = writeGuardRejection_(options);
      if (guardRejection) return guardRejection;
      return applyPaymentStateUpdateLocked_(bookingId, toPaymentStatus, fields, now);
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * applyPaymentStateUpdateの本体。呼び出し元が既にLockService.getScriptLock()を
   * 取得済みであることを前提とし、この関数自身はLockを取得・解放しない
   * （PR #354レビュー対応・4回目）。
   *
   * handleCheckoutCreateFailure_のSTRIPE_ERROR分岐（確定的失敗）は、「対象の
   * paymentAttemptIdが現在の決済試行と一致することの検証」「paymentAttemptResolvedAtの
   * 更新」「paymentStatusのFAILEDへの遷移」の3つを、他のリクエストのreservePaymentAttempt_
   * が割り込めない一続きの処理として実行する必要がある（failConfirmedCheckoutAttempt_
   * 参照）。3回目レビュー対応では、この3つ目（FAILEDへの遷移）を通常の
   * applyPaymentStateUpdate呼び出しに任せていたため、1〜2つ目のLock取得・解放と
   * 3つ目のLock取得・解放が別々になり、その間に別のリクエストが割り込める隙間が
   * 生じていた。この内部関数を切り出すことで、failConfirmedCheckoutAttempt_は自身が
   * 既に取得しているLockをそのまま使ってpaymentStatusの遷移まで完了させられる
   * （同じLockService.getScriptLock()を二重取得しない）。
   *
   * 通常の呼び出し元（PR-B/PR-Cの大半）は、この関数を直接呼ばず、必ず自分でLockを
   * 取得・解放する公開版のapplyPaymentStateUpdateを使うこと。
   */
  function applyPaymentStateUpdateLocked_(bookingId, toPaymentStatus, fields, now, lockedOptions) {
    var effectiveNow = isDateLike_(now) ? now : new Date();
    var safeFields = fields || {};
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
      }
      var record = found.record;

      /*
       * Issue #341 PR-D: lockedOptions.allowWhileRecoveryRequiredは、BookingRefund.gsが
       * 「Stripeで実際に確認した返金オブジェクト（stripeRefundId・status）」を台帳へ記録する
       * refund_pending/refundedへの遷移に限って指定する。返金の事実（Stripe側で既に起きた
       * 資金移動）は、要復旧ゲートが立っていても台帳へ記録できなければならない（記録
       * できないと「返金済みなのに台帳はpaid」のまま残り、二重返金の判断材料を失う）。
       * それ以外の遷移（paid・checkout_pending等）には使わない。
       */
      var bypassRecoveryGate = !!(lockedOptions && lockedOptions.allowWhileRecoveryRequired) &&
        (toPaymentStatus === Booking.PAYMENT_STATUS.REFUND_PENDING || toPaymentStatus === Booking.PAYMENT_STATUS.REFUNDED);

      if (record.paymentRecoveryRequiredAt && !bypassRecoveryGate) {
        return {
          success: false,
          error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約の決済状態は要復旧のため、自動処理を停止しています。管理者の確認が必要です。' }
        };
      }

      var currentPaymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
      if (currentPaymentStatus === null) {
        recordPaymentRecoveryBestEffort_(
          bookingId, record, 'UNKNOWN_PAYMENT_STATUS',
          'paymentStatus列に既知のいずれの値とも一致しない値が入っています（生値は診断のため' +
            'Loggerにのみ出力）。Bookingsを直接確認し、実際の決済状況（Stripe管理画面等）と' +
            '照合したうえで、正しいpaymentStatus値へ手動で修正し、この復旧フラグを解除して' +
            'ください。',
          effectiveNow
        );
        Logger.log('applyPaymentStateUpdate: 未知のpaymentStatus値を検出しました: ' + bookingId + ' rawValue=' + JSON.stringify(record.paymentStatus));
        return {
          success: false,
          error: { code: 'UNKNOWN_PAYMENT_STATUS', message: '決済状態が不明なため処理を停止しました。管理者の確認が必要です。' }
        };
      }

      if (currentPaymentStatus === toPaymentStatus) {
        /*
         * 3回目レビュー対応・項目1: 「既に目的の状態」というだけでalreadyApplied:trueに
         * せず、まずこの状態に必要な証跡が**台帳に保存済みの値だけで**揃っているかを
         * 確認する。台帳が既に'paid'等を名乗っていても、必須の決済識別子が一つも
         * 記録されていなければ、それ自体が台帳側の不整合（正しく記録されないまま状態
         * だけが進んだ疑い）であるため、恒久の要復旧ゲートを立てて停止する。
         *
         * 4回目レビュー対応: findMissingPaymentEvidence_（fieldsを台帳より優先して
         * マージする、新規遷移用の関数）をここでも流用していたため、この分岐では
         * 何もBookingsへ書き込まないにもかかわらず、今回の呼び出しがfieldsへ正しい値
         * （例: lastStripeEventId）を渡しさえすれば検証を通過し、台帳自体の証跡欠落を
         * 見逃したままalreadyApplied:trueに到達できてしまう抜け穴があった。「既に
         * 目的の状態」の経路は台帳を更新しないため、判定は必ず台帳に**現に保存されている
         * 値だけ**（findMissingPaymentEvidenceAtRest_。fieldsを一切見ない）で行う。
         * 新規遷移（このifブロックの外、これから書き込みを行う経路）では、書き込み後の
         * 状態を予測するfindMissingPaymentEvidence_（fields優先のマージ）を従来どおり使う。
         */
        var missingEvidenceAtRest = findMissingPaymentEvidenceAtRest_(record, toPaymentStatus);
        if (missingEvidenceAtRest.length > 0) {
          recordPaymentRecoveryBestEffort_(
            bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
            '決済状態は既に' + toPaymentStatus + 'ですが、必須の決済証跡（' + missingEvidenceAtRest.join('、') +
              '）が台帳に記録されていません。証跡の無いまま状態だけが進んだ疑いがあるため、' +
              '識別子を指定しない再実行であっても成功扱いにせず自動処理を停止しました。' +
              '実際のStripe側の記録を確認し、不足している識別子を台帳へ補ってから復旧して' +
              'ください。',
            effectiveNow
          );
          return {
            success: false,
            error: {
              code: 'PAYMENT_EVIDENCE_MISSING',
              message: '決済状態は既に' + toPaymentStatus + 'ですが、必須の決済証跡（' + missingEvidenceAtRest.join('、') + '）が記録されていません。'
            }
          };
        }

        if (!paymentIdentityMatches_(record, safeFields)) {
          recordPaymentRecoveryBestEffort_(
            bookingId, record, 'PAYMENT_IDENTITY_MISMATCH',
            '決済状態は既に' + toPaymentStatus + 'ですが、今回の呼び出しが主張する決済試行ID・' +
              'Stripe識別子が台帳の記録と一致しません。別の決済試行を同一予約の完了済み処理と' +
              '誤認しないよう自動処理を停止しました。実際のStripe側の記録（決済試行ごとの' +
              'PaymentIntent/Checkout Session）を確認し、二重決済や取り違えがないか調査した' +
              'うえで復旧してください。',
            effectiveNow
          );
          return {
            success: false,
            error: {
              code: 'PAYMENT_IDENTITY_MISMATCH',
              message: '決済状態は既に' + toPaymentStatus + 'ですが、決済試行の識別子が一致しないため処理を停止しました。管理者の確認が必要です。'
            }
          };
        }

        /*
         * 3回目レビュー対応・項目2: paid/refund_pending/refunded（資金移動を伴う状態。
         * MONETARY_IDENTITY_CONFIRMATION_FIELDS_）については、識別子を一つも主張しない
         * 呼び出しを「食い違いが無いから同一処理だろう」と安全側に丸めない。paymentIdentity
         * Matches_は「主張された値が食い違わないか」しか見ないため、何も主張しない呼び出しは
         * 素通りしてしまう。資金移動を伴う状態の再確認では、呼び出し元が該当する識別子を
         * 積極的に一致させて初めて「同一の決済・返金処理である」とみなす
         * （paymentIdentityConfirmed_）。確認できない場合はPAYMENT_IDENTITY_UNCONFIRMEDで
         * 停止する。証跡自体は揃っている（直前のfindMissingPaymentEvidence_を通過済み）ため
         * 台帳側の不整合ではなく、単に今回の呼び出しが同一性の証明を怠っただけの可能性が
         * 高く、恒久ゲートは立てない（PAYMENT_EVIDENCE_MISSINGの新規遷移時と同じ扱い。
         * recordPaymentEvidenceAuditBestEffort_で監査記録のみ行う）。
         */
        if (!paymentIdentityConfirmed_(record, safeFields, toPaymentStatus)) {
          recordPaymentEvidenceAuditBestEffort_(
            bookingId, record, 'PAYMENT_IDENTITY_UNCONFIRMED',
            '決済状態は既に' + toPaymentStatus + 'ですが、今回の呼び出しは同一の決済・返金処理で' +
              'あることを示す識別子（' + (MONETARY_IDENTITY_CONFIRMATION_FIELDS_[toPaymentStatus] || []).join('、') +
              '）を何も主張していません。資金移動を伴う状態の再確認は、識別子の一致を確認できない' +
              '限り自動的に同一処理とはみなしません（台帳は未変更）。正しい識別子を添えて再試行' +
              'してください。',
            effectiveNow
          );
          return {
            success: false,
            error: {
              code: 'PAYMENT_IDENTITY_UNCONFIRMED',
              message: '決済状態は既に' + toPaymentStatus + 'ですが、同一の決済・返金処理であることを識別子で確認できないため処理を停止しました。'
            }
          };
        }

        return { success: true, alreadyApplied: true };
      }

      if (!Booking.canTransitionPaymentStatus(currentPaymentStatus, toPaymentStatus)) {
        return {
          success: false,
          error: {
            code: 'INVALID_PAYMENT_TRANSITION',
            message: '決済状態を' + currentPaymentStatus + 'から' + toPaymentStatus + 'へ変更することはできません。'
          }
        };
      }

      var missingEvidence = findMissingPaymentEvidence_(record, safeFields, toPaymentStatus);
      if (missingEvidence.length > 0) {
        /*
         * ここでは何もBookingsへ書き込んでいない（このifブロックに到達した時点で台帳は
         * 未変更）ため、recordPaymentRecoveryBestEffort_（paymentRecoveryRequiredAtの
         * 恒久ゲートを立てる）ではなく、監査記録のみのrecordPaymentEvidenceAuditBestEffort_
         * を使う。証跡欠落は「呼び出し元がこの回の呼び出しで必要な情報を渡し忘れた」
         * だけの可能性が高く、正しい証跡を添えて再試行すれば足りるため、以後この
         * bookingIdへのすべての呼び出しを恒久的に禁止するのは過剰（PAYMENT_IDENTITY_
         * MISMATCH・PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMITとは異なり、台帳側は
         * 何も不整合を起こしていない）。それでも「証跡の無い決済成功・返金の報告」自体は
         * 監査に値するためRecoveryへは記録する。
         */
        recordPaymentEvidenceAuditBestEffort_(
          bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
          '決済状態を' + toPaymentStatus + 'へ進めるために必要な決済証跡（' + missingEvidence.join('、') +
            '）が揃っていないため、この回の呼び出しを拒否しました（台帳は未変更）。証跡の無い' +
            '決済成功・返金の報告を無条件に信用しないための検証です。正しい識別子を添えて' +
            '再試行してください。',
          effectiveNow
        );
        return {
          success: false,
          error: {
            code: 'PAYMENT_EVIDENCE_MISSING',
            message: '決済状態を' + toPaymentStatus + 'へ進めるために必要な決済証跡（' + missingEvidence.join('、') + '）が不足しています。'
          }
        };
      }

      if (Object.keys(safeFields).length > 0) {
        try {
          SpreadsheetRepository.updateBookingPaymentStateAtomic(bookingId, safeFields);
        } catch (detailError) {
          Logger.log('applyPaymentStateUpdate: 決済付随情報の書き込みに失敗しました: ' + bookingId + ' ' + detailError);
          return {
            success: false,
            error: { code: 'PAYMENT_DETAIL_WRITE_FAILED', message: '決済付随情報の保存に失敗しました。最初からやり直してください。' }
          };
        }
      }

      try {
        SpreadsheetRepository.updateBookingFields(bookingId, { paymentStatus: toPaymentStatus });
      } catch (statusError) {
        recordPaymentRecoveryBestEffort_(
          bookingId, record, 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT',
          '決済付随情報（paymentAttemptId等）の保存後、paymentStatus（目標値: ' + toPaymentStatus +
            '）の更新に失敗しました: ' + describeError_(statusError) + '。台帳の決済付随情報と' +
            '実際のStripe側の状況を確認し、paymentStatusを手動で正しい値へ修正してから' +
            'この復旧フラグを解除してください。',
          effectiveNow
        );
        return {
          success: false,
          error: {
            code: 'PAYMENT_STATUS_WRITE_FAILED_AFTER_DETAIL_COMMIT',
            message: '決済付随情報は保存されましたが、決済状態の更新に失敗しました。管理者の確認が必要です。'
          }
        };
      }

      return { success: true };
  }

  /*
   * paymentRecoveryRequiredAt/paymentRecoveryReasonの設定とRecoveryRepositoryへの記録を
   * best effortで行う（既存のRecovery記録と同じ方針：記録自体の失敗はLoggerにのみ残し、
   * 呼び出し元へは投げない）。この関数の呼び出し後、applyPaymentStateUpdateは以後この
   * bookingIdへのすべての呼び出しをPAYMENT_RECOVERY_REQUIREDとして拒否する。
   */
  function recordPaymentRecoveryBestEffort_(bookingId, record, failureType, reason, now) {
    try {
      SpreadsheetRepository.updateBookingFields(bookingId, {
        paymentRecoveryRequiredAt: now,
        paymentRecoveryReason: reason
      });
    } catch (e) {
      Logger.log('paymentRecoveryRequiredAtの記録に失敗しました: ' + bookingId + ' ' + e);
    }
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: failureType,
        occurredAt: now,
        calendarEventId: (record && record.calendarEventId) || '',
        status: (record && record.status) || '',
        errorMessage: reason,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (e) {
      Logger.log('Recovery記録に失敗しました: ' + bookingId + ' ' + failureType + ' ' + e);
    }
  }

  /*
   * PAYMENT_EVIDENCE_MISSING専用（2回目レビュー対応・項目2）：Bookingsへは何も書き込んで
   * いない（この回の呼び出しを拒否しただけ）ため、paymentRecoveryRequiredAtの恒久ゲートは
   * 立てず、RecoveryRepositoryへの監査記録のみをbest effortで行う。呼び出し元は正しい
   * 証跡を添えて同じbookingIdへ再試行できる。
   */
  function recordPaymentEvidenceAuditBestEffort_(bookingId, record, failureType, reason, now) {
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: failureType,
        occurredAt: now,
        calendarEventId: (record && record.calendarEventId) || '',
        status: (record && record.status) || '',
        errorMessage: reason,
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (e) {
      Logger.log('Recovery記録に失敗しました: ' + bookingId + ' ' + failureType + ' ' + e);
    }
  }

  /*
   * applyPaymentStateUpdateの冪等性判定（2回目レビュー対応・項目1）が参照する識別子。
   * 呼び出し元が`fields`でこれらのキーを明示的に主張した場合のみ、台帳の現在値と
   * 突き合わせる（主張していないキーは判定に使わない＝比較対象にしない）。
   *
   * 原則としてREQUIRED_EVIDENCE_FOR_STATUS_に登場する全フィールドの和集合にすること
   * （3回目レビュー対応で判明した不具合の修正：stripeRefundIdがここに含まれていなかった
   * ため、異なるstripeRefundIdを主張する呼び出しがpaymentIdentityMatches_のミスマッチ
   * 判定をすり抜け、paymentIdentityConfirmed_のPAYMENT_IDENTITY_UNCONFIRMED側に誤って
   * 落ちていた。「値を主張しているのに食い違う」場合は必ずこちらのPAYMENT_IDENTITY_
   * MISMATCHで検出できるよう、判定対象のフィールド集合をREQUIRED_EVIDENCE_FOR_STATUS_と
   * 同期させる）。
   *
   * **例外: lastStripeEventIdはここに含めない**（Issue #341 PR-Cレビュー対応・1回目）。
   * Stripeは同一の決済・返金について、異なるイベントID（例:
   * checkout.session.completedとcheckout.session.async_payment_succeeded、あるいは
   * Stripe側の重複配信）で複数回通知することがある。「決済・返金として同一かどうか」は
   * stripePaymentIntentId/stripeCheckoutSessionId/paymentAttemptId/stripeRefundIdという
   * **決済・返金そのものを表す識別子**で判定すべきであり、「どのイベント配信が最後に
   * 触れたか」を表すだけのlastStripeEventIdを同一性の判定材料に含めると、同一入金への
   * 異なるイベントIDでの正当な通知のたびにPAYMENT_IDENTITY_MISMATCH（恒久の要復旧ゲート）
   * を誤発生させてしまう。StripeWebhookHandler.gsは、同一イベントの重複配信自体は
   * 別途StripeEventRepository.gsのイベント台帳（eventId単位）で防いでいるため、
   * ここでlastStripeEventIdの一致まで要求する必要はない。
   */
  var IDENTITY_FIELDS_ = [
    'paymentAttemptId', 'stripeCheckoutSessionId', 'stripePaymentIntentId', 'stripeRefundId'
  ];

  /*
   * 現在のpaymentStatusが既にtoPaymentStatusと一致している場合に、今回の呼び出しが
   * 「本当に同じ決済試行の重複処理（冪等な再送）」か、「別の決済試行が同じ目標状態を
   * 主張している」かを判定する。
   *
   * safeFieldsがIDENTITY_FIELDS_のいずれのキーも含まない場合（呼び出し元が識別子を
   * 何も主張していない）は、判定材料が無いためtrue（同一とみなす）を返す。含む場合は、
   * 主張された値すべてが台帳の現在値と一致して初めてtrueを返す。1つでも食い違えば
   * false（別の決済試行の可能性あり）。
   */
  function paymentIdentityMatches_(record, safeFields) {
    return !IDENTITY_FIELDS_.some(function (key) {
      if (!Object.prototype.hasOwnProperty.call(safeFields, key)) return false;
      var claimed = safeFields[key];
      if (claimed === undefined || claimed === null || claimed === '') return false;
      return record[key] !== claimed;
    });
  }

  /*
   * toPaymentStatusへ遷移するために最低限揃っているべき決済証跡（2回目レビュー対応・
   * 項目2）。PR-A時点ではStripe APIを呼ばないため、ここでの「必須」はPR-B/PR-Cが
   * その状態へ実際に遷移する際に得られるはずの値をコード上の約束として先取りしたもの。
   * - CHECKOUT_PENDING: Checkout Session発行時にPR-Bが必ず持つはずの決済試行ID・
   *   Session id。
   * - PAID: Webhookが伝えるPaymentIntent id、および同一イベントの重複処理を防ぐ
   *   lastStripeEventId（Issue #341本文「イベントID・決済試行IDで重複処理を防ぐ」）。
   * - REFUND_PENDING / REFUNDED: Stripe返金APIの呼び出しで得られる返金id
   *   （Issue #341本文の運用フローでは、REFUND_PENDINGは返金APIを呼び出した直後に
   *   遷移する想定であり、その時点で既にStripeからidが返っているはず）。
   * - FAILED: 追加の必須証跡なし（Session期限切れ等、PaymentIntentが発行される前に
   *   失敗する経路もあるため）。
   */
  var REQUIRED_EVIDENCE_FOR_STATUS_ = {};
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.CHECKOUT_PENDING] = ['paymentAttemptId', 'stripeCheckoutSessionId'];
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.PAID] = ['stripePaymentIntentId', 'lastStripeEventId'];
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.REFUND_PENDING] = ['stripeRefundId'];
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.REFUNDED] = ['stripeRefundId'];
  REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.FAILED] = [];

  /*
   * **新規遷移専用**（currentPaymentStatus !== toPaymentStatusで、これから
   * updateBookingPaymentStateAtomicへの書き込みを行う経路のみで使うこと）。今回のfields
   * と台帳の現在値を合わせても、toPaymentStatusに必要な証跡（REQUIRED_EVIDENCE_FOR_
   * STATUS_）が揃わないキーの一覧を返す（空配列なら不足なし）。fieldsで指定された値を
   * 優先し、指定が無いキーは台帳の現在値を見る（前段のcheckout_pending遷移で記録済みの
   * 識別子を、後段のpaid遷移で再送させる必要はないため）。ここでの判定はこの直後に
   * fieldsを実際に書き込むことが前提であり、fieldsを書き込まない「既に目的の状態」の
   * 経路（currentPaymentStatus===toPaymentStatus）では絶対に使わないこと
   * （findMissingPaymentEvidenceAtRest_を使う。4回目レビュー対応で発覚した抜け穴の
   * 原因はまさにこの関数をその経路へ誤用していたことだった）。
   */
  function findMissingPaymentEvidence_(record, safeFields, toPaymentStatus) {
    var required = REQUIRED_EVIDENCE_FOR_STATUS_[toPaymentStatus] || [];
    return required.filter(function (key) {
      var merged = Object.prototype.hasOwnProperty.call(safeFields, key) ? safeFields[key] : record[key];
      return merged === undefined || merged === null || merged === '';
    });
  }

  /*
   * **「既に目的の状態」専用**（4回目レビュー対応で追加）。currentPaymentStatus===
   * toPaymentStatusの経路はBookingsへ一切書き込まないため、toPaymentStatusに必要な証跡
   * （REQUIRED_EVIDENCE_FOR_STATUS_）が揃っているかどうかは、**台帳に現に保存されている
   * 値だけ**で判定しなければならない。今回の呼び出しのfieldsに正しい値が含まれていても、
   * それは書き込まれない（＝台帳の状態は変わらない）ため判定材料にしない。
   * findMissingPaymentEvidence_（fieldsを台帳より優先してマージする、新規遷移専用）を
   * この経路で使うと、fieldsさえ渡せば台帳自体の証跡欠落を隠したままalreadyApplied:true
   * に到達できてしまう（4回目レビュー対応で修正した抜け穴）。
   */
  function findMissingPaymentEvidenceAtRest_(record, toPaymentStatus) {
    var required = REQUIRED_EVIDENCE_FOR_STATUS_[toPaymentStatus] || [];
    return required.filter(function (key) {
      var value = record[key];
      return value === undefined || value === null || value === '';
    });
  }

  /*
   * 3回目レビュー対応・項目2: 資金移動を伴う状態（paid/refund_pending/refunded）へ
   * 「既に到達済み」の予約を再確認する際、呼び出し元が同一の決済・返金処理であることを
   * 積極的に証明することを要求する状態の一覧。checkout_pending/failedは資金移動を
   * 伴わないためここには含めない（paymentIdentityMatches_の「主張された値が食い違わ
   * ないか」だけの判定のままでよい）。
   *
   * PAIDについてはREQUIRED_EVIDENCE_FOR_STATUS_[PAID]（stripePaymentIntentId・
   * lastStripeEventId）をそのまま流用せず、**stripePaymentIntentIdのみ**を使う
   * （Issue #341 PR-Cレビュー対応・1回目）。lastStripeEventIdは「どのイベント配信が
   * 最後に触れたか」を表すだけで、決済そのものの同一性を表さない。Stripeが同一の
   * 決済について異なるイベントID（例: checkout.session.completedと
   * checkout.session.async_payment_succeeded、あるいは重複配信）で複数回通知しても、
   * PaymentIntent IDが同じであれば同一の決済とみなし、二重確定・二重メール送信を
   * 起こさず安全にalreadyApplied:trueへ収束させる（同一イベントIDの重複配信自体は
   * StripeEventRepository.gsのイベント台帳で別途防ぐ）。REFUND_PENDING/REFUNDEDは
   * lastStripeEventIdを含まないREQUIRED_EVIDENCE_FOR_STATUS_のままなので、そのまま
   * 流用してよい。
   */
  var MONETARY_IDENTITY_CONFIRMATION_FIELDS_ = {};
  MONETARY_IDENTITY_CONFIRMATION_FIELDS_[Booking.PAYMENT_STATUS.PAID] = ['stripePaymentIntentId'];
  MONETARY_IDENTITY_CONFIRMATION_FIELDS_[Booking.PAYMENT_STATUS.REFUND_PENDING] = REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.REFUND_PENDING];
  MONETARY_IDENTITY_CONFIRMATION_FIELDS_[Booking.PAYMENT_STATUS.REFUNDED] = REQUIRED_EVIDENCE_FOR_STATUS_[Booking.PAYMENT_STATUS.REFUNDED];

  /*
   * 現在のpaymentStatusが既にtoPaymentStatusと一致している場合に、toPaymentStatusが
   * MONETARY_IDENTITY_CONFIRMATION_FIELDS_に該当する（資金移動を伴う）状態であれば、
   * 呼び出し元がその状態を裏付ける識別子のすべてを主張し、かつそれらが台帳の現在値と
   * 一致することを要求する。paymentIdentityMatches_が「主張された値が食い違わないか」
   * （主張が無ければ素通り）しか見ないのに対し、こちらは「主張そのものがあるか」まで
   * 要求する（識別子を一つも主張しない呼び出しを、証拠が無いことを理由に安全側へ
   * 丸めない）。対象外の状態（checkout_pending/failed）は常にtrueを返す（従来どおり
   * paymentIdentityMatches_のみで判定する）。
   */
  function paymentIdentityConfirmed_(record, safeFields, toPaymentStatus) {
    var confirmationFields = MONETARY_IDENTITY_CONFIRMATION_FIELDS_[toPaymentStatus];
    if (!confirmationFields) return true;
    return confirmationFields.every(function (key) {
      if (!Object.prototype.hasOwnProperty.call(safeFields, key)) return false;
      var claimed = safeFields[key];
      if (claimed === undefined || claimed === null || claimed === '') return false;
      return claimed === record[key];
    });
  }

  /*
   * ============================================================================
   * Issue #341 PR-B: Stripe Checkout Sessionの発行・仮押さえ（CardPayment.gs/
   * StripeGateway.gs/applyPaymentStateUpdateを組み合わせるオーケストレーション本体）
   * ============================================================================
   *
   * beginCardCheckout(bookingId, now)がBooking Web App（Code.gs）から呼ばれる唯一の
   * 公開入口。PR-B/C/DはSpreadsheetRepositoryの低レベル関数を直接呼ばず、決済状態・
   * 決済付随情報の更新には必ずapplyPaymentStateUpdateを、決済試行IDの発行には必ず
   * reservePaymentAttempt_（このファイル内）を経由すること。
   *
   * ## 二重決済防止の設計（Issue #341本文「4. 二重決済の防止」）
   *
   * 「StripeでSession生成に成功した後、GASへのSession ID保存に失敗した場合でも、
   * 新しいSessionを無条件に発行しない」を満たすため、Stripe呼び出しの**前**に必ず
   * paymentAttemptId（Stripeへ渡すIdempotency-Keyそのもの）を台帳へ永続化してから
   * Stripeを呼ぶ（reservePaymentAttempt_）。
   *
   * - reservePaymentAttempt_は短時間のLockのみを保持し、Stripeへのネットワーク呼び出しは
   *   Lockの外で行う（LockService.getScriptLock()はスクリプト全体で共有される単一の
   *   ミューテックスであり、低速な外部HTTP呼び出しの間保持すると無関係な他の予約の処理まで
   *   直列化してしまうため）。
   * - 同一bookingIdへの並行呼び出し（二重クリック等）は、reservePaymentAttempt_のLock内で
   *   同じpaymentAttemptId（1つ目の呼び出しが発行・永続化した値）へ収束させ、以後は両方が
   *   同じIdempotency-KeyでStripeを呼ぶ。Stripe側のIdempotency-Key保証により、実際に
   *   作成されるCheckout Sessionは1つだけになる（GAS側でネットワーク呼び出しをまたぐ長い
   *   Lockを取らずに済む、Stripe推奨のパターン）。
   * - Stripe呼び出し後にapplyPaymentStateUpdateでのCHECKOUT_PENDINGへの証跡コミットが
   *   失敗した場合（PAYMENT_DETAIL_WRITE_FAILED等）も、既にpaymentAttemptIdは台帳に
   *   永続化済みのため、呼び出し元（利用者のフォーム再送信）は同じpaymentAttemptIdを
   *   再利用してStripeを再度呼び出せる。Stripeは同一Idempotency-Key・同一パラメータの
   *   再試行に対して、最初に作成したSessionをそのまま返す（新しいSessionを作らない）。
   * - Stripe呼び出し自体がタイムアウト・5xx等で結果不明（AMBIGUOUS/NETWORK）な場合は、
   *   新しい決済試行IDを発行せず、同じpaymentAttemptIdでの再試行のみを許可する
   *   （呼び出し元にエラーを返し、フロントから同じbookingIdで再試行させる）。
   */

  var CHECKOUT_LOCK_TIMEOUT_MS_ = 10000;

  /* isFinitePositiveInteger_はCardPayment.gsの同名の非公開ヘルパーと同じ判定
     （このファイルのIIFEからは直接参照できないためここに複製する）。 */
  function isFinitePositiveInteger_(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && Math.round(value) === value;
  }

  function safeJsonParse_(text) {
    if (typeof text !== 'string' || !text) return null;
    try {
      return JSON.parse(text);
    } catch (parseError) {
      return null;
    }
  }

  /*
   * reservePaymentAttempt_が保存・復元するCheckout Session作成リクエストのスナップショット
   * （PR #354レビュー対応・2回目「Stripeへ送るリクエスト全体の固定」）が、Stripeへ安全に
   * 再送できる完全な内容かどうかを検証する。1つでも欠落・型不正・bookingId/
   * paymentAttemptIdの不一致があれば、この決済試行を安全に再照会できないとみなす
   * （呼び出し元はPAYMENT_EVIDENCE_MISSINGとして停止し、新しいSessionを発行しない）。
   */
  function isValidCheckoutRequestSnapshot_(params, bookingId, paymentAttemptId) {
    return !!params &&
      params.bookingId === bookingId &&
      params.paymentAttemptId === paymentAttemptId &&
      typeof params.brand === 'string' && !!params.brand &&
      isFinitePositiveInteger_(params.amountJpy) &&
      typeof params.currency === 'string' && !!params.currency &&
      isFinitePositiveInteger_(params.expiresAtSeconds) &&
      typeof params.successUrl === 'string' && !!params.successUrl &&
      typeof params.cancelUrl === 'string' && !!params.cancelUrl &&
      typeof params.lineItemName === 'string' && !!params.lineItemName &&
      typeof params.customerEmail === 'string';
  }

  /*
   * bookingIdの決済試行ID（Stripeへ渡すIdempotency-Key）と、Stripe Checkout Session作成
   * APIへ実際に送信するリクエスト内容一式（checkoutParams。金額・通貨・expires_at・
   * successUrl・cancelUrl・customerEmail・lineItemName等）を1回のRange.setValuesで
   * まとめて予約・永続化する（PR #354レビュー対応・2回目「Stripeへ送るリクエスト全体の
   * 固定」）。
   *
   * Stripeは同一Idempotency-Keyに対して異なるリクエスト内容が送られた場合、最初の
   * レスポンスを返さずidempotency_errorを返す。同じ決済試行IDの再試行が「初回呼び出し
   * 時点で確定した内容」と寸分違わず一致するようにするため、checkoutParams全体を
   * **この関数が呼ばれた最初の1回だけ**組み立ててJSON文字列のまま保存し、以後の再試行
   * （GAS保存失敗・APIタイムアウト・この間の料金修正やScript Properties変更等いずれの
   * 場合も）は必ずこの時点のスナップショットをそのまま復元して再利用する（呼び出し元の
   * startNewCheckoutAttempt_は独自にCardPayment.computeExpectedPaymentAmount等を
   * 呼び直さず、record.email・stripeConfig.successUrl/cancelUrlも再取得しない）。
   *
   * - 台帳に既にpaymentAttemptIdが記録されており、かつその決済試行が**まだ解決していない**
   *   （paymentAttemptResolvedAtが空。PR #354レビュー対応・3回目）場合は、currentPaymentStatus
   *   がNOT_STARTED・FAILEDのいずれであっても、その既存のスナップショット（checkoutParams
   *   全体）をそのまま再利用する（新しい値を発行・再計算しない）。**その間に管理者が料金を
   *   修正・Script Propertiesのsuccess/cancel URLを変更していても、この再試行では反映しない**
   *   （Stripeへは初回と同じ内容を送る必要があるため）。保存済みのスナップショットを安全に
   *   復元できない場合（JSON解析失敗・必須項目欠落・bookingId/paymentAttemptId不一致等）は、
   *   新しいSessionを発行せず要復旧として停止する。
   *
   *   3回目レビュー対応の要点: 以前はこの再利用判定をcurrentPaymentStatus===NOT_STARTED
   *   （+paymentAttemptId存在）に限定していた。しかしFAILEDから新しい試行を開始する処理
   *   （このファイルの後述のstartNewCheckoutAttempt_）は、Stripe呼び出しに成功して
   *   applyPaymentStateUpdateでCHECKOUT_PENDINGへコミットするまでの間、paymentStatusを
   *   FAILEDのまま変更しない。そのため、FAILEDの予約へ複数リクエストがほぼ同時に到達すると
   *   （1つ目がここで新しいpaymentAttemptId・スナップショットを予約してLockを解放した直後、
   *   まだStripeを呼んでいる／コミットが終わっていない間に2つ目がこの関数へ入る等）、
   *   旧判定ではcurrentPaymentStatusが依然FAILEDのままであるため2つ目も「新しい試行」の
   *   分岐へ入ってしまい、2つ目が1つ目の予約を上書きして**別のpaymentAttemptId・別の
   *   Idempotency-Keyで2回目のStripe呼び出し**を行ってしまう（二重のCheckout Session発行に
   *   つながる）。
   *
   *   paymentAttemptResolvedAtは、paymentStatusとは独立に「この決済試行が最終的な結果
   *   （failedへの確定、またはcheckout_pendingへの成功コミット）に到達したか」だけを表す
   *   フラグである。新しい決済試行を予約するたびに必ず空へ戻し（このLock内の1回の
   *   Range.setValuesでpaymentAttemptId等と同時に書く）、その決済試行のStripe呼び出しが
   *   確定的な結果に至った時点で初めてapplyPaymentStateUpdateの呼び出し元
   *   （handleCheckoutCreateFailure_のSTRIPE_ERROR分岐・startNewCheckoutAttempt_の成功時
   *   コミット）が現在時刻を書き込む。この結果、「新しく予約済みで未解決」（空のまま）と
   *   「以前の試行が確定的に終わった後の空き状態」（値が入っている）をpaymentStatusの値に
   *   関わらず区別できるようになり、Lockが本来意図するとおり「1つ目が予約を確定するまで
   *   2つ目は同じ予約を読む」という排他が正しく機能する。
   */
  function hasUnresolvedPaymentAttempt_(record) {
    return !!record.paymentAttemptId && !record.paymentAttemptResolvedAt;
  }

  function reservePaymentAttempt_(bookingId, stripeConfig, now) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CHECKOUT_LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!found) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
      }
      var record = found.record;
      if (record.paymentRecoveryRequiredAt) {
        return { success: false, error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約の決済状態は要復旧のため、自動処理を停止しています。' } };
      }
      /*
       * PR-Dレビュー対応・1回目: beginCardCheckout冒頭のstatus確認（Lock外）の後に管理者が
       * 予約を取り消していた場合に、取消済みの予約へ新しい決済試行（Checkout Session）を
       * 発行しないよう、Lock取得後の最新行でも確認する（Booking AdminとはLockを共有しない
       * ため競合の窓を完全には消せないが、その場合も遅延入金として記録・Recovery管理される）。
       */
      if (record.status !== Booking.STATUS.PENDING) {
        return { success: false, error: { code: 'BOOKING_NOT_PENDING', message: 'この予約は決済待ちの状態ではありません。' } };
      }
      if (hasUnresolvedPaymentAttempt_(record)) {
        var snapshot = safeJsonParse_(record.stripeCheckoutRequestSnapshot);
        if (!isValidCheckoutRequestSnapshot_(snapshot, bookingId, record.paymentAttemptId)) {
          /* 通常到達しない防御的分岐（このLock内で常にpaymentAttemptIdと同時に書くため）。
             スナップショットを安全に復元できないまま異なるリクエスト内容をStripeへ送って
             しまう事故を避け、要復旧として停止する（PR #354レビュー対応・2回目）。 */
          recordPaymentRecoveryBestEffort_(
            bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
            '決済試行の予約情報（Stripeへ送信するリクエスト内容一式のスナップショット）を' +
              '安全に復元できません。Bookingsを直接確認してください。',
            now
          );
          return { success: false, error: { code: 'PAYMENT_EVIDENCE_MISSING', message: '決済処理の準備状態が不整合のため停止しました。管理者の確認が必要です。' } };
        }
        return { success: true, reused: true, paymentAttemptId: record.paymentAttemptId, checkoutParams: snapshot };
      }

      var expected = CardPayment.computeExpectedPaymentAmount(record);
      if (!expected.valid) {
        return { success: false, error: expected.error };
      }
      var expiresAtSeconds = CardPayment.computeStripeSessionExpiresAtSeconds(now.getTime());
      var paymentAttemptId = CardPayment.generatePaymentAttemptId(bookingId, Utilities.getUuid());

      /*
       * このcheckoutParamsが、Stripeへ実際に送るリクエスト内容の唯一の正になる。
       * successUrl/cancelUrl（Script Properties由来）・customerEmail（record.email）を
       * ここで確定し、以後この決済試行が解決するまで一切再取得・再計算しない。
       */
      /* Issue #422: 戻り先URLのみブランド（record.brand）別に解決する。金額・有効期限等は不変。 */
      var returnUrls = Booking.resolveCheckoutReturnUrls(record.brand, stripeConfig);
      if (!returnUrls.ok) {
        /* mens / Studio Xの戻り先を確定できない場合、SNBへ戻さずCheckout生成前に停止する。 */
        return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: '決済機能が設定されていません。当店へお問い合わせください。' } };
      }
      var checkoutParams = {
        amountJpy: expected.amountJpy,
        currency: expected.currency,
        bookingId: bookingId,
        brand: record.brand,
        paymentAttemptId: paymentAttemptId,
        expiresAtSeconds: expiresAtSeconds,
        successUrl: returnUrls.successUrl,
        cancelUrl: returnUrls.cancelUrl,
        customerEmail: record.email || '',
        lineItemName: Booking.getBrandLabel(record.brand) + ' ご利用料金（' + bookingId + '）'
      };

      try {
        SpreadsheetRepository.updateBookingPaymentStateAtomic(bookingId, {
          paymentAttemptId: paymentAttemptId,
          /* 前の決済試行の終端状態を引き継がない。この新しい試行が確定的な結果に
             至るまでは必ず空のままにする（PR #354レビュー対応・3回目）。 */
          paymentAttemptResolvedAt: '',
          stripeAmount: expected.amountJpy,
          stripeCurrency: expected.currency,
          paymentHoldExpiresAt: new Date(expiresAtSeconds * 1000),
          stripeCheckoutRequestSnapshot: JSON.stringify(checkoutParams)
        });
      } catch (writeError) {
        Logger.log('reservePaymentAttempt_: 決済試行の予約情報の保存に失敗しました: ' + bookingId + ' ' + describeError_(writeError));
        return { success: false, error: { code: 'PAYMENT_DETAIL_WRITE_FAILED', message: '決済処理の準備に失敗しました。もう一度お試しください。' } };
      }
      return { success: true, reused: false, paymentAttemptId: paymentAttemptId, checkoutParams: checkoutParams };
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * Stripe Checkout Session作成呼び出し自体が失敗した場合の分岐（Issue #341本文
   * 「Stripe側で決済済みかどうか不明な場合は、新規発行を停止してRecoveryに記録」）。
   *
   * PR #354レビュー対応・2回目「Stripeの4xxエラー分類」: 4xxを一律に「確定的に失敗した」
   * とは扱わない。StripeGateway.classifyHttpError_が返すerrorTypeは3種類に分かれる:
   * - IDEMPOTENCY_CONFLICT: Stripeが「このIdempotency-Keyには既に異なるパラメータの
   *   リクエストが記録されている」と報告した。今回送った内容（保存済みスナップショット）
   *   がStripe側の記録と食い違っている＝台帳の保存内容自体が信頼できない可能性がある
   *   異常事態のため、自動再試行を続けても解決しない。**要復旧として恒久的に停止する**
   *   （新しいpaymentAttemptIdも発行しない。Stripe管理画面での確認が必須）。
   * - STRIPE_ERROR: Stripeが`invalid_request_error`/`authentication_error`/
   *   `permission_error`のいずれかを、明確な4xx（409を除く）で返した場合のみ。この回の
   *   リクエストがStripe側で一切処理されなかったと確信できるケースに限定する
   *   （StripeGateway.CONFIRMED_FAILURE_ERROR_TYPES_参照）。FAILEDへ進め、次回は新しい
   *   決済試行IDを発行させる。
   * - それ以外すべて（AMBIGUOUS/NETWORK/NOT_CONFIGURED。409・429・5xx・型が未知の4xx・
   *   応答解析不能を含む）: Stripe側で実際にSessionが作成された可能性を否定できない
   *   （あるいはそもそも呼び出せていない）。paymentStatusをFAILEDへ進めず、新しい決済
   *   試行IDも発行しない（＝次回もreservePaymentAttempt_が同じpaymentAttemptId・同じ
   *   スナップショットを再利用する）。監査記録のみ残して呼び出し元へ再試行を促す。
   *
   * paymentAttemptId: この呼び出しがStripeへ送った（＝reservePaymentAttempt_がこの回の
   *   呼び出しのために予約・返した）決済試行ID。PR #354レビュー対応・3回目: STRIPE_ERROR
   *   （確定的失敗）でpaymentStatusをFAILEDへ進める直前に、台帳の現在のpaymentAttemptId
   *   がまだこのIDのままかを確認したうえでpaymentAttemptResolvedAtへ現在時刻を書き込む。
   *   一致しない場合（この応答が発行された後に何らかの経路で既に新しい決済試行が予約
   *   されている等）は、ここでFAILEDへ進めると新しい試行の証跡を古い応答で上書きして
   *   しまう恐れがあるため、遷移を行わず要復旧として停止する（「以前の決済試行から遅れて
   *   届いた応答が、新しい試行の証跡を上書きしない」という設計要件）。
   *
   *   PR #354レビュー対応・4回目: 3回目の実装は、この確認・書き込みをsettlePaymentAttempt
   *   Resolved_（専用のLock取得→解放）で行った**後に**、paymentStatusのFAILEDへの遷移を
   *   applyPaymentStateUpdate（別のLock取得→解放）に任せていた。settlePaymentAttempt
   *   Resolved_がpaymentAttemptResolvedAtを書き込んだ時点で、reservePaymentAttempt_の
   *   再利用判定（hasUnresolvedPaymentAttempt_）はpaymentStatusを見ずこの列だけで
   *   判定するため、paymentStatusがまだfailedへ書き換わっていなくても「新しい決済試行を
   *   予約してよい」状態になってしまう。この2つのLock取得の間（前者のLockが解放されて
   *   から後者のLockが取得されるまで）に、他のリクエストがreservePaymentAttempt_で新しい
   *   決済試行を予約・Stripe呼び出し・コミットまで完了できてしまい、その後にこの古い
   *   呼び出しがpaymentStatusをFAILEDへ書き込むと、新しく予約された決済試行の状態を
   *   誤って巻き戻してしまう恐れがあった。failConfirmedCheckoutAttempt_で、この3つを
   *   1回のLock取得の中で完結させることでこの隙間を無くした。
   */
  /*
   * 「対象のpaymentAttemptIdが現在の決済試行と一致することの検証」「paymentAttempt
   * ResolvedAtの更新」「paymentStatusのFAILEDへの遷移」を、他のリクエストの
   * reservePaymentAttempt_による新しい決済試行の予約が割り込めない一続きの処理として
   * 実行する（PR #354レビュー対応・4回目）。LockService.getScriptLock()を1回だけ取得し、
   * その中で3つすべてを完了させてから解放する（applyPaymentStateUpdate自身のLock取得を
   * 経由せず、Lockを既に取得済みの状態で呼べるapplyPaymentStateUpdateLocked_を直接呼ぶ
   * ことで、同じLockを二重取得しない）。
   *
   * paymentAttemptResolvedAtの書き込みが失敗した場合は、成功したものとみなして
   * FAILEDへの遷移を続行せず、直ちにエラーを返す（Lockはこの関数の終了時にのみ解放する
   * ため、この間に他のリクエストが割り込むことはない）。
   *
   * 戻り値: { stale: true }（対象のpaymentAttemptIdが既に台帳の現在の決済試行ではない。
   * 台帳へは一切書き込んでいない） / { success: true }（FAILEDへの遷移まで完了） /
   * { success: false, error }（paymentAttemptResolvedAtの書き込み失敗、またはFAILEDへの
   * 遷移自体の失敗）。
   */
  function failConfirmedCheckoutAttempt_(bookingId, paymentAttemptId, now) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(CHECKOUT_LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    try {
      var latest = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!latest || latest.record.paymentAttemptId !== paymentAttemptId) {
        return { stale: true };
      }
      try {
        SpreadsheetRepository.updateBookingPaymentStateAtomic(bookingId, { paymentAttemptResolvedAt: now });
      } catch (writeError) {
        Logger.log('failConfirmedCheckoutAttempt_: paymentAttemptResolvedAtの書き込みに失敗しました: ' + bookingId + ' ' + describeError_(writeError));
        return { success: false, error: { code: 'PAYMENT_DETAIL_WRITE_FAILED', message: '決済処理の記録に失敗しました。もう一度お試しください。' } };
      }
      return applyPaymentStateUpdateLocked_(bookingId, Booking.PAYMENT_STATUS.FAILED, {}, now);
    } finally {
      lock.releaseLock();
    }
  }

  function recordStalePaymentAttemptResponse_(bookingId, record, paymentAttemptId, context, now) {
    recordPaymentRecoveryBestEffort_(
      bookingId, record, 'STALE_CHECKOUT_ATTEMPT_RESPONSE',
      context + '（決済試行ID: ' + (paymentAttemptId || '不明') + '）が届いた時点で、台帳の' +
        '現在の決済試行は既に別のIDへ進んでいました。この応答をそのまま適用すると、新しい' +
        '決済試行の証跡を古い応答で上書きしてしまう恐れがあるため、自動処理を停止しました。' +
        'Stripe管理画面でこの決済試行IDに対応するCheckout Sessionの有無・内容を確認し、' +
        '台帳の現在の決済試行と重複や取り違えがないか調査したうえで復旧してください。',
      now
    );
    return {
      success: false,
      error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約の決済状態は要復旧のため、自動処理を停止しています。' }
    };
  }

  function handleCheckoutCreateFailure_(bookingId, record, createResult, paymentAttemptId, now) {
    if (createResult.errorType === 'IDEMPOTENCY_CONFLICT') {
      recordPaymentRecoveryBestEffort_(
        bookingId, record, 'STRIPE_IDEMPOTENCY_CONFLICT',
        'Checkout Session作成リクエストが、Stripe側に既に記録済みの内容と一致しないと' +
          '報告されました（idempotency_error）。台帳に保存された決済試行の内容（金額・通貨・' +
          'successUrl等のスナップショット）が、実際に最初にStripeへ送られた内容と食い違って' +
          'いる可能性があります。Stripe管理画面でこの決済試行ID（' + (record.paymentAttemptId || '不明') +
          '）に対応するCheckout Sessionの有無・内容を確認し、必要な補正を行ってから復旧して' +
          'ください。',
        now
      );
      return {
        success: false,
        error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約の決済状態は要復旧のため、自動処理を停止しています。' }
      };
    }

    if (createResult.errorType === 'STRIPE_ERROR') {
      /*
       * Stripeが明確にリクエストを拒否した（invalid_request_error/authentication_error/
       * permission_errorのいずれか）。この回のリクエストは処理されていないことが確定して
       * いるため、FAILEDへ進めて次回は新しい決済試行IDを発行させる（Booking.gs「新しい
       * paymentAttemptIdでの再試行時のみCHECKOUT_PENDINGへ戻れる」）。
       *
       * 「対象のpaymentAttemptIdが現在の決済試行と一致することの検証」
       * 「paymentAttemptResolvedAtの更新」「paymentStatusのFAILEDへの遷移」を、
       * failConfirmedCheckoutAttempt_が1回のLock取得の中で一続きに実行する
       * （PR #354レビュー対応・4回目。3回目時点の実装は、この3つを2回の別々のLock取得に
       * 分けていたため、その間に他のリクエストの新しい決済試行の予約が割り込めた）。
       */
      var failAttemptResult = failConfirmedCheckoutAttempt_(bookingId, paymentAttemptId, now);
      if (failAttemptResult.stale) {
        return recordStalePaymentAttemptResponse_(
          bookingId, record, paymentAttemptId,
          'Stripeからの確定的な失敗応答（' + createResult.errorType + '）', now
        );
      }
      if (!failAttemptResult.success) {
        return { success: false, error: failAttemptResult.error };
      }
      return {
        success: false,
        error: { code: 'STRIPE_REQUEST_ERROR', message: '決済処理を開始できませんでした。時間をおいて再度お試しください。' }
      };
    }

    /*
     * NETWORK/AMBIGUOUS/NOT_CONFIGURED: Stripe側で実際にSessionが作成された可能性を
     * 否定できない（あるいはそもそも呼び出せていない）。paymentStatusをFAILEDへ進めず
     * （＝次回もreservePaymentAttempt_が同じpaymentAttemptIdを再利用する）、監査記録のみ
     * 残して呼び出し元へ再試行を促す。
     */
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'STRIPE_CHECKOUT_SESSION_CREATE_UNKNOWN',
        occurredAt: now,
        calendarEventId: record.calendarEventId || '',
        status: record.status || '',
        errorMessage: 'Checkout Session作成の結果が確認できませんでした（' + createResult.errorType + '）: ' + (createResult.message || ''),
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }
    return {
      success: false,
      error: { code: 'PAYMENT_STATUS_UNKNOWN', message: '決済処理の状況を確認できませんでした。しばらくしてから再度お試しください。' },
      retryable: true
    };
  }

  /*
   * NOT_STARTED/FAILEDから新しい決済試行を開始する（Checkout Session発行→証跡コミット）。
   *
   * PR #354レビュー対応: Stripeへ送るリクエスト内容（checkoutParams）はreservePaymentAttempt_
   * が呼び出し時点で1回だけ確定・永続化したスナップショットをそのまま使う。ここで
   * CardPayment.computeExpectedPaymentAmount・record.email・stripeConfig.successUrl/
   * cancelUrl等を独自に取得し直さない（取得し直すと、同じpaymentAttemptId＝同じ
   * Idempotency-Keyのまま、料金修正・Script Properties変更等でStripeへ送る内容が初回と
   * 食い違ってしまう。Stripeは差異を検知するとidempotency_errorを返す）。
   */
  /*
   * PR-Dレビュー対応・2回目: Booking Web AppとBooking AdminはScript Lockを共有しないため、
   * 利用者の決済開始（reservePaymentAttempt_でPENDINGを確認→Stripe→commit）の間に、管理者が
   * 予約を取り消すことがある。その場合に作られたCheckout Sessionは:
   * - 台帳には記録したまま（applyPaymentStateUpdateのcommit済み。管理者が追跡できるように）、
   * - 利用者へURLを返さず（決済できる入口を渡さない）、
   * - Stripe側での失効をbest effortで試み、
   * - Recovery（PAYMENT_CHECKOUT_AFTER_CANCEL。sessionId付き）へ記録し、checkoutCancelStateを
   *   UNKNOWNにして、管理者の「決済URLの失効を再確認」の対象にする（ここで失効を確認できても
   *   断定はせず、Booking Admin側の確認で閉じる）。
   * 予約の状態は変更しない（取消済みのまま）。要復旧ゲートも立てない（万一入金が成立した場合に
   * Webhook処理が入金を記録できるようにするため）。
   */
  function handleCheckoutSessionIssuedAfterCancel_(bookingId, record, sessionId, stripeConfig, now) {
    var expireResult = StripeGateway.expireCheckoutSession(stripeConfig, sessionId);
    var expiredReported = !!(expireResult.ok && expireResult.session && expireResult.session.status === 'expired');
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'PAYMENT_CHECKOUT_AFTER_CANCEL',
        occurredAt: now,
        calendarEventId: (record && record.calendarEventId) || '',
        status: (record && record.status) || '',
        errorMessage: '取消済みの予約に対して決済URL（sessionId=' + sessionId + '）が発行されました（決済開始と取消が交差）。' +
          '利用者へはURLを返していません。' + (expiredReported ? 'Stripeは失効を受け付けました。' : '失効を確認できていません。') +
          'Booking Adminの「決済URLの失効を再確認」で失効と入金の有無を確認してください。',
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }
    var lock = LockService.getScriptLock();
    if (lock.tryLock(CHECKOUT_LOCK_TIMEOUT_MS_)) {
      try {
        var latest = SpreadsheetRepository.findRowByBookingId(bookingId);
        if (latest && latest.record.checkoutCancelState !== 'PAYMENT_RECEIVED') {
          SpreadsheetRepository.updateBookingFields(bookingId, { checkoutCancelState: 'UNKNOWN', checkoutCancelCheckedAt: now });
        }
      } catch (writeError) {
        Logger.log('checkoutCancelStateの記録に失敗しました: ' + bookingId + ' ' + describeError_(writeError));
      } finally {
        lock.releaseLock();
      }
    }
    return { success: false, error: { code: 'BOOKING_NOT_PENDING', message: 'この予約は決済待ちの状態ではありません。' } };
  }

  function startNewCheckoutAttempt_(bookingId, stripeConfig, now) {
    var reserveResult = reservePaymentAttempt_(bookingId, stripeConfig, now);
    if (!reserveResult.success) return reserveResult;
    var paymentAttemptId = reserveResult.paymentAttemptId;
    var checkoutParams = reserveResult.checkoutParams;

    var latest = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!latest) {
      return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません: ' + bookingId } };
    }
    var record = latest.record;

    var createResult = StripeGateway.createCheckoutSession(stripeConfig, checkoutParams, paymentAttemptId);

    if (!createResult.ok) {
      return handleCheckoutCreateFailure_(bookingId, record, createResult, paymentAttemptId, now);
    }

    var session = createResult.session;
    /*
     * Issue #341本文「Session expires_atをこの仮押さえ期限と一致させる」を、Stripeの
     * レスポンスに含まれる実際のexpires_atをpaymentHoldExpiresAtへそのまま保存し直す
     * ことで実現する（CardPayment.gsファイル冒頭コメント・README「Issue #341」節参照。
     * 通常はcheckoutParams.expiresAtSecondsとStripeの応答は一致するはずだが、常に
     * Stripeの応答を正として保存する）。
     */
    var paymentHoldExpiresAt = new Date(session.expiresAtSeconds * 1000);

    /*
     * PR #354レビュー対応・3回目: Stripe呼び出しから結果が返るまでの間に、台帳の現在の
     * paymentAttemptIdが既に別の決済試行へ進んでいないかをcommit前に確認する（本来は
     * 起こらない想定だが、防御的に検知する）。確認せずCHECKOUT_PENDINGへコミットすると、
     * 新しい決済試行の証跡をこの古い応答（実際にはStripe側にSessionが作成済みで、
     * bookingId・paymentAttemptIdとしては孤立してしまう）で上書きしてしまう。stale
     * （既に別の決済試行IDへ進んでいる）の場合はコミットせず要復旧として停止する。
     */
    var latestBeforeCommit = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!latestBeforeCommit || latestBeforeCommit.record.paymentAttemptId !== paymentAttemptId) {
      return recordStalePaymentAttemptResponse_(
        bookingId, record, paymentAttemptId,
        'Checkout Session作成成功の応答（Stripe Session ID: ' + session.id + '）', now
      );
    }

    var commitResult = applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.CHECKOUT_PENDING, {
      paymentAttemptId: paymentAttemptId,
      /* この決済試行はcheckout_pendingへ進む結果に確定した。以後reservePaymentAttempt_が
         このIDを「未解決」として誤って再利用しないよう、コミットと同じ書き込みで確定させる
         （PR #354レビュー対応・3回目）。 */
      paymentAttemptResolvedAt: now,
      stripeCheckoutSessionId: session.id,
      paymentHoldExpiresAt: paymentHoldExpiresAt,
      stripeAmount: checkoutParams.amountJpy,
      stripeCurrency: checkoutParams.currency
    }, now);

    if (!commitResult.success) {
      /* paymentAttemptIdとスナップショット（checkoutParams全体）は既にreservePaymentAttempt_
         で永続化済みのため、呼び出し元の再試行は同じIdempotency-Key・同じリクエスト内容で
         Stripeへ到達し、同じSessionがそのまま返る（新しいSessionは作られない）。 */
      return { success: false, error: commitResult.error, retryable: true };
    }

    /* PR-Dレビュー対応・2回目: Session発行の間に管理者が予約を取り消していた場合、URLを返さない。 */
    var afterCommit = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!afterCommit || afterCommit.record.status !== Booking.STATUS.PENDING) {
      return handleCheckoutSessionIssuedAfterCancel_(bookingId, afterCommit ? afterCommit.record : record, session.id, stripeConfig, now);
    }

    return {
      success: true,
      bookingId: bookingId,
      checkoutUrl: session.url,
      paymentHoldExpiresAt: paymentHoldExpiresAt,
      amount: checkoutParams.amountJpy,
      currency: checkoutParams.currency
    };
  }

  /*
   * currentPaymentStatus===CHECKOUT_PENDING（既にCheckout Sessionを発行済み）の予約への
   * 再アクセス。Issue #341本文「既存のSessionが有効なら再利用し、失効が確認できた場合
   * だけ、安全な新規試行を許可」「Stripe側で決済済みかどうか不明な場合は、新規発行を
   * 停止してRecoveryに記録」を、Stripe側の実際のSession状態を確認してから分岐することで
   * 満たす。
   */
  function resumeExistingCheckout_(record, stripeConfig, now) {
    var bookingId = record.bookingId;
    if (!record.stripeCheckoutSessionId) {
      /* applyPaymentStateUpdateの証跡検証によりCHECKOUT_PENDINGはstripeCheckoutSessionId
         を必ず伴うはずであり、通常到達しない防御的分岐。台帳側の不整合として扱う。 */
      recordPaymentRecoveryBestEffort_(
        bookingId, record, 'PAYMENT_EVIDENCE_MISSING',
        '決済状態はcheckout_pendingですが、stripeCheckoutSessionIdが記録されていません。Bookingsを直接確認してください。',
        now
      );
      return { success: false, error: { code: 'PAYMENT_EVIDENCE_MISSING', message: '決済状態が不整合のため処理を停止しました。管理者の確認が必要です。' } };
    }

    var retrieveResult = StripeGateway.retrieveCheckoutSession(stripeConfig, record.stripeCheckoutSessionId);
    if (!retrieveResult.ok) {
      try {
        RecoveryRepository.recordFailure({
          bookingId: bookingId,
          failureType: 'STRIPE_SESSION_STATUS_UNKNOWN',
          occurredAt: now,
          calendarEventId: record.calendarEventId || '',
          status: record.status || '',
          errorMessage: 'Checkout Session状態の確認に失敗しました（' + retrieveResult.errorType + '）: ' + (retrieveResult.message || ''),
          recoveryState: 'OPEN',
          resolvedAt: ''
        });
      } catch (recoveryError) {
        Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
      }
      return {
        success: false,
        error: { code: 'PAYMENT_STATUS_UNKNOWN', message: '決済状況を確認できませんでした。しばらくしてから再度お試しください。' },
        retryable: true
      };
    }

    var session = retrieveResult.session;

    if (session.status === 'open') {
      /* PR-Dレビュー対応・2回目: Stripeへの照会の間に管理者が予約を取り消していれば、決済可能な
         URLを利用者へ返さない（このSessionは取消処理が失効させる。台帳に記録済みのため追跡される）。 */
      var beforeReturn = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (!beforeReturn || beforeReturn.record.status !== Booking.STATUS.PENDING) {
        return { success: false, error: { code: 'BOOKING_NOT_PENDING', message: 'この予約は決済待ちの状態ではありません。' } };
      }
      /* まだ決済可能なSessionが残っている。新しいSessionを発行せずこれを再利用する。 */
      return {
        success: true,
        bookingId: bookingId,
        checkoutUrl: session.url,
        paymentHoldExpiresAt: isDateLike_(record.paymentHoldExpiresAt) ? record.paymentHoldExpiresAt : new Date(session.expiresAtSeconds * 1000),
        reused: true
      };
    }

    if (session.status === 'complete' || session.paymentStatus === 'paid') {
      /*
       * 決済が完了している可能性がある。署名検証済みWebhookによる自動確定（PR-C）は
       * まだ存在しないため、ここで自動的に予約を確定させることはしない。新しいSessionも
       * 発行せず、恒久の要復旧ゲートを立てて管理者の確認を必須にする（Issue #341本文
       * 「決済が成立している可能性がある場合は、未払いと決めつけて枠を解放しない」の
       * 精神を、Session再利用の場面にも適用する）。
       */
      recordPaymentRecoveryBestEffort_(
        bookingId, record, 'CHECKOUT_SESSION_ALREADY_COMPLETED',
        'Stripe Checkout Session（' + record.stripeCheckoutSessionId + '）が既に完了/決済済みと報告されましたが、' +
          'Webhookによる自動確定（PR-C）が未実装のため自動処理を停止しました。Stripe管理画面で入金を確認し、' +
          '必要であれば手動で予約を確定してください。',
        now
      );
      return {
        success: false,
        error: { code: 'PAYMENT_POSSIBLY_COMPLETED', message: '決済が完了している可能性があります。しばらくしてからページを再読み込みいただくか、当店へお問い合わせください。' }
      };
    }

    if (session.status === 'expired' && session.paymentStatus === 'unpaid') {
      /*
       * Stripe側で確実に未払いのまま失効したことを確認できた。安全に新しい試行へ進める。
       *
       * PR #354レビュー対応・3回目（その1）: この失効したSessionのpaymentAttemptIdを、
       * failedへの遷移と同時にpaymentAttemptResolvedAtへ確定させる。これをしないと、
       * 直後に呼ぶstartNewCheckoutAttempt_（reservePaymentAttempt_）が、この古い
       * paymentAttemptIdを「まだ未解決」と誤認してそのまま再利用してしまう
       * （expirePendingBookings側の同種の失効遷移と同じ理由）。
       *
       * PR #354レビュー対応・3回目（その2）: 同一予約への2件のリクエストがほぼ同時に
       * ここへ到達し、両方がこの同じ古いSessionをStripeへ確認して両方とも「確実に
       * 未払いのまま失効」と判定するケースがある。retrieveCheckoutSessionの呼び出しから
       * 応答が返るまでの間に、もう一方が既にこの予約をfailedへ進めて新しい決済試行を
       * 開始・成功させている可能性があるため、failedへ遷移する直前に台帳の現在の
       * stripeCheckoutSessionId・paymentAttemptIdが、この応答の元になった値のまま
       * （＝まだ誰も先に進めていない）ことを確認する。既に変わっていた場合、ここで
       * failedへ進めると、もう一方が新しく開始した決済試行の証跡をこの古い確認結果で
       * 上書きしてしまう。何も書き込まずに呼び出し元へ再試行を促し、呼び出し元が最新の
       * 状態を読み直せば正しく分岐する（もう一方が開始した新しいSessionを再利用する等）。
       */
      var latestBeforeFail = SpreadsheetRepository.findRowByBookingId(bookingId);
      if (
        !latestBeforeFail ||
        latestBeforeFail.record.stripeCheckoutSessionId !== record.stripeCheckoutSessionId ||
        latestBeforeFail.record.paymentAttemptId !== record.paymentAttemptId
      ) {
        return {
          success: false,
          error: { code: 'PAYMENT_STATUS_UNKNOWN', message: '決済状況を確認できませんでした。しばらくしてから再度お試しください。' },
          retryable: true
        };
      }

      var failResult = applyPaymentStateUpdate(bookingId, Booking.PAYMENT_STATUS.FAILED, { paymentAttemptResolvedAt: now }, now);
      if (!failResult.success) {
        return { success: false, error: failResult.error };
      }
      return startNewCheckoutAttempt_(bookingId, stripeConfig, now);
    }

    /* 上記いずれにも該当しない（例: expiredだが決済状態が読み取れない）場合は安全側に倒し、
       新規発行を行わず監査記録のみ残す。 */
    try {
      RecoveryRepository.recordFailure({
        bookingId: bookingId,
        failureType: 'STRIPE_SESSION_STATUS_UNKNOWN',
        occurredAt: now,
        calendarEventId: record.calendarEventId || '',
        status: record.status || '',
        errorMessage: 'Checkout Sessionの状態を判定できませんでした（status=' + session.status + ', payment_status=' + session.paymentStatus + '）。',
        recoveryState: 'OPEN',
        resolvedAt: ''
      });
    } catch (recoveryError) {
      Logger.log('RecoveryRepository.recordFailure failed: ' + describeError_(recoveryError));
    }
    return {
      success: false,
      error: { code: 'PAYMENT_STATUS_UNKNOWN', message: '決済状況を確認できませんでした。しばらくしてから再度お試しください。' },
      retryable: true
    };
  }

  /*
   * bookingIdだけでCheckout Sessionを開始・再取得できてしまう脆弱性を修正するための
   * 定数時間比較（PR #354レビュー対応・項目1）。文字列長で早期リターンする前段の比較は
   * 長さの違いというわずかな情報しか漏らさない（bookingId自体は既にURLやメールで
   * やり取りされる非機密の識別子であり、真に守るべきはトークンの中身であるため許容する）。
   * 空文字同士は絶対に一致させない（現金・PayPay予約はcheckoutAccessTokenが常に空文字の
   * ため、空文字を送るだけの攻撃で「トークン不要」な予約を偽装できてしまう事故を防ぐ）。
   */
  function tokensMatch_(claimed, expected) {
    if (typeof claimed !== 'string' || typeof expected !== 'string') return false;
    if (claimed.length === 0 || expected.length === 0) return false;
    if (claimed.length !== expected.length) return false;
    var diff = 0;
    for (var i = 0; i < claimed.length; i++) {
      diff |= claimed.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
  }

  /*
   * beginCardCheckout(bookingId, checkoutAccessToken, now) — Booking Web App（Code.gs）
   * から呼ばれる、カード決済のCheckout Session発行の唯一の公開入口（Issue #341 PR-B）。
   *
   * 対象は既にcreateBookingでPENDING作成済みのカード決済予約のみ。フォーム送信自体
   * （PENDING作成）は既存のcreateBookingのまま変更しない（Issue #341本文の「既存予約との
   * 互換性確保」）。stripeConfig.checkoutEnabledが有効化されていない環境（既定＝本番）では
   * 常にCHECKOUT_DISABLEDを返し、呼び出し元（フロントエンド）は既存の「決済リンクを
   * 後日送付」フロー（Issue #334）へフォールバックする。
   *
   * checkoutAccessTokenはcreateBooking（カード決済のみ）が発行し、送信した本人のブラウザ
   * にのみ返す推測困難な値（PR #354レビュー対応・項目1）。bookingId・トークンのいずれかが
   * 一致しなければ、以降のいかなる予約情報（決済状態・金額等）も一切返さない。
   */
  /*
   * Issue #668: 大人数利用（5〜7名）の決済ゲート。承認前・不承認・支払期限後は決済を始められない。通常予約はnull（対象外）。
   * 戻り値: エラー応答オブジェクト | null。
   */
  function checkLargePartyPaymentGate_(record, now) {
    if (!Booking.isLargePartyRecord(record)) return null;
    if (Booking.largePartyApprovalStatus(record) !== Booking.LARGE_PARTY_APPROVAL.APPROVED) {
      return { success: false, error: { code: 'LARGE_PARTY_NOT_APPROVED', message: '5〜7名のご利用は、運営の承認後にお支払いいただけます。承認のご連絡をお待ちください。' } };
    }
    var dueMillis = isDateLike_(record.largePartyPaymentDueAt) ? record.largePartyPaymentDueAt.getTime() : NaN;
    if (isNaN(dueMillis) || now.getTime() >= dueMillis) {
      return { success: false, error: { code: 'LARGE_PARTY_PAYMENT_EXPIRED', message: 'お支払い期限（承認から24時間）を過ぎたため、このご予約は不成立となります。お手数ですが改めてお申し込みください。' } };
    }
    return null;
  }

  /*
   * 大人数利用（Issue #668）の運営承認。Booking Admin（認証済み管理者）専用。
   * 条件: status=PENDING・largeParty・承認待ち。承認時にも予約代表者の実会員資格を再確認する（確認できなければ承認しない）。
   * 承認で largePartyApprovalStatus=APPROVED・承認日時・支払期限（承認の24時間後）を保存し、確定料金・支払いページを案内するメールを送る。
   * メール失敗は承認自体の成否に影響させない。
   */
  function approveLargeParty(bookingId, now) {
    now = isDateLike_(now) ? now : new Date();
    if (!bookingId || typeof bookingId !== 'string') {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    var response;
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      var checked = checkLargePartyAwaitingApproval_(found);
      if (checked) {
        response = checked;
      } else if (found.record.brand !== 'mens' || !BookingPricing.isLargePartyPeople(found.record.people) ||
                 !(MembershipRules.verifyActualMembership(found.record.email, found.record.date).ok === true)) {
        response = { success: false, error: { code: 'LARGE_PARTY_MEMBER_ONLY', message: '予約代表者のSNB MEMBER資格（ご利用日）を確認できないため承認できません。' } };
      } else {
        var dueAt = new Date(Booking.computeLargePartyPaymentDueMillis(now.getTime()));
        SpreadsheetRepository.updateBookingFields(bookingId, {
          largePartyApprovalStatus: Booking.LARGE_PARTY_APPROVAL.APPROVED,
          largePartyApprovedAt: now,
          largePartyPaymentDueAt: dueAt,
          updatedAt: now
        });
        response = {
          success: true, bookingId: bookingId, approvalStatus: Booking.LARGE_PARTY_APPROVAL.APPROVED,
          approvedAt: now, paymentDueAt: dueAt, amount: Booking.getEffectivePriceAmount(found.record)
        };
      }
    } finally {
      lock.releaseLock();
    }
    if (response.success) {
      try {
        response.mail = BookingMailer.sendLargePartyApprovedMailForBooking(bookingId);
      } catch (mailError) {
        Logger.log('BookingRepository: 大人数利用の承認メール送信中に予期しない例外: ' + BookingMailer.sanitizeErrorMessage(describeError_(mailError)));
      }
    }
    return response;
  }

  /*
   * 大人数利用（Issue #668）の不承認。Booking Admin専用。承認待ちのみ対象。仮押さえを解除して不成立（CANCELLED）にする
   * （4名扱いへの自動変換・自動課金はしない）。Calendar削除・台帳更新・取消メールは既存のcancelBookingAdminに任せ、
   * 取消メールは largePartyApprovalStatus=REJECTED を見て不承認として案内する。
   */
  function rejectLargeParty(bookingId, now) {
    now = isDateLike_(now) ? now : new Date();
    if (!bookingId || typeof bookingId !== 'string') {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    var failure = null;
    try {
      var found = SpreadsheetRepository.findRowByBookingId(bookingId);
      failure = checkLargePartyAwaitingApproval_(found);
      if (!failure) {
        SpreadsheetRepository.updateBookingFields(bookingId, {
          largePartyApprovalStatus: Booking.LARGE_PARTY_APPROVAL.REJECTED,
          updatedAt: now
        });
      }
    } finally {
      lock.releaseLock();
    }
    if (failure) return failure;
    var cancelled = cancelBookingAdmin(bookingId);
    if (cancelled && cancelled.success) cancelled.approvalStatus = Booking.LARGE_PARTY_APPROVAL.REJECTED;
    return cancelled;
  }

  /*
   * SNB mensの予約人数の変更（Issue #668）。Booking Admin専用。予約人数（people列）を料金計算の正本として更新し、
   * 料金・大人数フラグ・承認状態を一貫して更新する。管理者が行う変更自体が運営の承認にあたる。
   * - 締切は既存のキャンセル無料期限と同じ**利用日の2日前まで**（JSTの暦日差が2日以上）。
   *   2日前まで: 増減員とも料金を再計算する。増員は8名以上不可・5〜7名への新規移行は会員資格（利用日）と承認条件を再確認し、差額を返す。
   *   前日・当日: 増員は不可。減員は人数のみ更新し、人数加算分を含め値下げ・返金しない（料金・大人数フラグは据え置き）。
   * - 4名以下への変更（2日前まで）は通常の1〜4名料金へ再計算し、大人数の承認条件（フラグ・加算・承認状態）を解除する。
   * - 決済処理中（checkout_pending / refund_pending）・管理者による金額修正済みの予約は、金額が食い違わないよう自動変更しない。
   * - 入金済みの場合は差額（追加請求額 additionalChargeDue / 返金候補額 refundDue）を返し、実際の請求・返金は管理者が既存の手順で行う。
   */
  function changeBookingPeople(bookingId, newPeople, now) {
    now = isDateLike_(now) ? now : new Date();
    if (!bookingId || typeof bookingId !== 'string') {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }
    var people = typeof newPeople === 'string' ? newPeople.trim() : '';
    if (!BookingPricing.isMensPartySizeAllowed(people)) {
      return { success: false, error: { code: 'PARTY_SIZE_EXCEEDED', message: 'SNB mensのご利用人数は1〜' + BookingPricing.LARGE_PARTY_MAX_PEOPLE + '名です。' } };
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return { success: false, error: { code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。もう一度お試しください。' } };
    }
    var response;
    try {
      response = changeBookingPeopleLocked_(bookingId, people, now);
    } finally {
      lock.releaseLock();
    }
    if (response.success) {
      try {
        response.mail = BookingMailer.sendPeopleChangedMailForBooking(bookingId, response.change);
      } catch (mailError) {
        Logger.log('BookingRepository: 人数変更メール送信中に予期しない例外: ' + BookingMailer.sanitizeErrorMessage(describeError_(mailError)));
      }
    }
    return response;
  }

  function changeBookingPeopleLocked_(bookingId, people, now) {
    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    if (!found) return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません。' } };
    var record = found.record;
    if (record.brand !== 'mens') {
      return { success: false, error: { code: 'NOT_MENS', message: '人数の変更はSNB mensの予約のみ対象です。' } };
    }
    if (record.status !== Booking.STATUS.PENDING && record.status !== Booking.STATUS.CONFIRMED) {
      return { success: false, error: { code: 'INVALID_STATUS', message: record.status + ' の予約は人数を変更できません。' } };
    }
    var oldPeople = String(record.people);
    var oldN = BookingPricing.parseHeadcount(oldPeople);
    var newN = BookingPricing.parseHeadcount(people);
    if (oldN === newN) return { success: false, error: { code: 'NO_CHANGE', message: '現在と同じ人数です。' } };
    var paymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    if (paymentStatus === null || paymentStatus === Booking.PAYMENT_STATUS.CHECKOUT_PENDING || paymentStatus === Booking.PAYMENT_STATUS.REFUND_PENDING) {
      return { success: false, error: { code: 'PAYMENT_IN_PROGRESS', message: '決済処理中のため人数を変更できません。決済の完了または失効を確認してから変更してください。' } };
    }
    if (record.priceOverrideAt !== '' && record.priceOverrideAt !== null && record.priceOverrideAt !== undefined) {
      return { success: false, error: { code: 'PRICE_OVERRIDDEN', message: '管理者が金額を修正済みの予約は、人数を自動では変更できません。' } };
    }

    var config = BookingConfig.getAvailabilityConfig();
    var today = BookingAvailability.formatDateInTimezone(now, config.timezone);
    var daysLeft = daysBetweenDates_(today, record.date);
    var beforeDeadline = daysLeft !== null && daysLeft >= 2;
    var wasLarge = Booking.isLargePartyRecord(record);
    var isIncrease = newN > oldN;
    var oldAmount = Booking.getEffectivePriceAmount(record);
    var fields = { people: people, updatedAt: now };
    var change = { bookingId: bookingId, oldPeople: oldPeople, newPeople: people, oldAmount: oldAmount, newAmount: oldAmount, beforeDeadline: beforeDeadline };

    if (!beforeDeadline) {
      /* 前日・当日: 増員不可。減員は人数のみ更新し、値下げ・返金しない（人数加算分を含む）。 */
      if (isIncrease) {
        return { success: false, error: { code: 'PEOPLE_CHANGE_DEADLINE_PASSED', message: '人数の変更は利用日の2日前までです。前日・当日の増員はお受けできません。' } };
      }
      change.noRefund = true;
      SpreadsheetRepository.updateBookingFields(bookingId, fields);
      return { success: true, change: change };
    }

    var durationMinutes = isDateLike_(record.startAt) && isDateLike_(record.endAt) ? Math.round((record.endAt.getTime() - record.startAt.getTime()) / 60000) : NaN;
    var willBeLarge = BookingPricing.isLargePartyPeople(people);
    if (willBeLarge && !wasLarge) {
      /* 4名以下から5〜7名への移行は、新規申込と同じ条件（枠が仮押さえ中の未払い予約・カード決済・会員資格）を再確認する。確定済みの予約は新規にお申し込みいただく。 */
      if (record.status !== Booking.STATUS.PENDING || paymentStatus === Booking.PAYMENT_STATUS.PAID) {
        return { success: false, error: { code: 'LARGE_PARTY_UPGRADE_NOT_SUPPORTED', message: '確定済み・お支払い済みの予約を5〜7名へ増やす場合は、新たにお申し込みください。' } };
      }
      if (!Booking.isCardPaymentMethod(record.paymentMethod)) {
        return { success: false, error: { code: 'LARGE_PARTY_CARD_REQUIRED', message: '5〜7名のご利用は、承認後のオンラインクレジットカード決済でのお支払いとなります。' } };
      }
      if (actualMembershipStatus_({ email: record.email, date: record.date }) !== 'ACTIVE') {
        return { success: false, error: { code: 'LARGE_PARTY_MEMBER_ONLY', message: '予約代表者のSNB MEMBER資格（ご利用日）を確認できないため、5〜7名へ変更できません。' } };
      }
    }
    var priced = BookingPricing.computeBookingPrice({
      brand: record.brand, date: record.date, durationMinutes: durationMinutes,
      isMember: record.priceIsMember === true || record.priceIsMember === 'TRUE',
      generation: BookingPricing.normalizeGeneration(record.priceGeneration),
      plan: record.planCode, people: people, startTime: undefined
    });
    if (!priced.valid) return { success: false, error: priced.error };

    fields.priceAmount = priced.price.amount;
    fields.priceComputedAt = now;
    if (willBeLarge) {
      fields.largeParty = true;
      fields.partySurcharge = priced.price.partySurcharge;
      if (!wasLarge) {
        fields.largePartyApprovalStatus = Booking.LARGE_PARTY_APPROVAL.PENDING_APPROVAL;
        fields.largePartyApprovedAt = '';
        fields.largePartyPaymentDueAt = '';
        fields.membershipStatus = 'ACTIVE';
      }
    } else if (wasLarge) {
      /* 4名以下へ: 通常の1〜4名料金へ再計算し、大人数の承認条件を解除する。 */
      fields.largeParty = '';
      fields.partySurcharge = '';
      fields.largePartyApprovalStatus = '';
      fields.largePartyApprovedAt = '';
      fields.largePartyPaymentDueAt = '';
    }
    SpreadsheetRepository.updateBookingFields(bookingId, fields);
    change.newAmount = priced.price.amount;
    change.partySurcharge = priced.price.partySurcharge;
    change.largeParty = willBeLarge;
    change.needsApproval = willBeLarge && !wasLarge;
    if (paymentStatus === Booking.PAYMENT_STATUS.PAID && oldAmount !== null) {
      var delta = priced.price.amount - oldAmount;
      if (delta > 0) change.additionalChargeDue = delta;
      if (delta < 0) change.refundDue = -delta;
    }
    return { success: true, change: change };
  }

  /* 'YYYY-MM-DD' 同士の暦日差（to - from）。解釈できなければnull（呼び出し側は最も保守的に扱う）。 */
  function daysBetweenDates_(from, to) {
    var a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(from));
    var b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(to));
    if (!a || !b) return null;
    return Math.round((Date.UTC(+b[1], +b[2] - 1, +b[3]) - Date.UTC(+a[1], +a[2] - 1, +a[3])) / 86400000);
  }

  function checkLargePartyAwaitingApproval_(found) {
    if (!found) return { success: false, error: { code: 'NOT_FOUND', message: 'bookingIdが見つかりません。' } };
    var record = found.record;
    if (!Booking.isLargePartyRecord(record)) {
      return { success: false, error: { code: 'NOT_LARGE_PARTY', message: '5〜7名の大人数利用の予約ではありません。' } };
    }
    if (record.status !== Booking.STATUS.PENDING) {
      return { success: false, error: { code: 'BOOKING_NOT_PENDING', message: 'この予約は承認待ちの状態ではありません（' + record.status + '）。' } };
    }
    if (Booking.largePartyApprovalStatus(record) !== Booking.LARGE_PARTY_APPROVAL.PENDING_APPROVAL) {
      return { success: false, error: { code: 'ALREADY_DECIDED', message: 'この予約は承認の判断済みです。' } };
    }
    return null;
  }

  /* 利用者向け: 予約ID＋登録メールで本人確認し、承認状態・確定料金・支払期限を返す（予約IDだけでは見えない）。 */
  function lookupLargePartyForCustomer_(bookingId, email) {
    var found = bookingId ? SpreadsheetRepository.findRowByBookingId(bookingId) : null;
    var forbidden = { success: false, error: { code: 'FORBIDDEN', message: '予約が見つからないか、操作の権限がありません。' } };
    if (!found || !Booking.isLargePartyRecord(found.record) || !email ||
        MembershipRules.normalizeEmail(found.record.email) !== MembershipRules.normalizeEmail(email)) {
      return { failure: forbidden };
    }
    return { record: found.record };
  }

  function getLargePartySummary(bookingId, email, now) {
    now = isDateLike_(now) ? now : new Date();
    var looked = lookupLargePartyForCustomer_(bookingId, email);
    if (looked.failure) return looked.failure;
    var r = looked.record;
    var gate = r.status === Booking.STATUS.PENDING ? checkLargePartyPaymentGate_(r, now) : null;
    return {
      success: true,
      booking: {
        bookingId: r.bookingId, status: r.status, date: r.date, people: r.people,
        approvalStatus: Booking.largePartyApprovalStatus(r),
        baseAmount: Booking.getEffectivePriceAmount(r) === null ? null : Booking.getEffectivePriceAmount(r) - (Number(r.partySurcharge) || 0),
        partySurcharge: Number(r.partySurcharge) || 0,
        amount: Booking.getEffectivePriceAmount(r),
        paymentDueAt: isDateLike_(r.largePartyPaymentDueAt) ? r.largePartyPaymentDueAt : null,
        paid: Booking.normalizePaymentStatus(r.paymentStatus) === Booking.PAYMENT_STATUS.PAID
      },
      payable: r.status === Booking.STATUS.PENDING && !gate,
      payableReason: gate ? gate.error.code : ''
    };
  }

  /* 利用者向け: 承認済み・期限内の大人数利用予約のCheckoutを開始する（決済開始トークンの代わりに予約ID＋登録メールで本人確認）。 */
  function startLargePartyCheckout(bookingId, email, now) {
    now = isDateLike_(now) ? now : new Date();
    var looked = lookupLargePartyForCustomer_(bookingId, email);
    if (looked.failure) return looked.failure;
    var result = beginCardCheckoutCore_(bookingId, '', now, true);
    if (result && result.success && result.checkoutUrl) {
      notifyCardCheckoutBestEffort_(bookingId, result);
    }
    return result;
  }

  function beginCardCheckout(bookingId, checkoutAccessToken, now) {
    var result = beginCardCheckoutCore_(bookingId, checkoutAccessToken, now);
    if (result && result.success && result.checkoutUrl) {
      notifyCardCheckoutBestEffort_(bookingId, result);
    }
    return result;
  }

  function beginCardCheckoutCore_(bookingId, checkoutAccessToken, now, tokenAlreadyVerified) {
    now = isDateLike_(now) ? now : new Date();

    if (!bookingId || typeof bookingId !== 'string') {
      return { success: false, error: { code: 'INVALID_BOOKING_ID', message: 'bookingIdを指定してください。' } };
    }

    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.checkoutEnabled) {
      return { success: false, error: { code: 'CHECKOUT_DISABLED', message: '現在オンライン決済でのお申し込みは受け付けていません。' } };
    }
    if (!stripeConfig.secretKey || !stripeConfig.successUrl || !stripeConfig.cancelUrl) {
      return { success: false, error: { code: 'STRIPE_NOT_CONFIGURED', message: '決済機能が設定されていません。当店へお問い合わせください。' } };
    }

    var found = SpreadsheetRepository.findRowByBookingId(bookingId);
    /*
     * bookingIdが見つからない場合と、決済開始トークンが一致しない場合を、呼び出し元へは
     * 同じFORBIDDENとして返す（区別しない）。区別すると「このbookingIdは実在する/しない」
     * を推測できるオラクルになってしまう。
     */
    if (!found || (tokenAlreadyVerified !== true && !tokensMatch_(checkoutAccessToken, found.record.checkoutAccessToken))) {
      return { success: false, error: { code: 'FORBIDDEN', message: '予約が見つからないか、操作の権限がありません。' } };
    }
    var record = found.record;

    if (!Booking.isCardPaymentMethod(record.paymentMethod)) {
      return { success: false, error: { code: 'NOT_CARD_PAYMENT', message: 'カード決済の予約ではありません。' } };
    }
    if (record.status !== Booking.STATUS.PENDING) {
      return { success: false, error: { code: 'BOOKING_NOT_PENDING', message: 'この予約は決済待ちの状態ではありません。' } };
    }
    /* Issue #667: 作品撮りサポートは運営の承認前は決済不可。承認後の支払い期限（24時間）を過ぎても決済不可（サーバー側の最終ガード）。 */
    var supportGate = Booking.photoSupportPaymentGate(record, now.getTime());
    if (supportGate) {
      return { success: false, error: supportGate };
    }
    if (record.paymentRecoveryRequiredAt) {
      return { success: false, error: { code: 'PAYMENT_RECOVERY_REQUIRED', message: 'この予約は要復旧のため、自動処理を停止しています。当店へお問い合わせください。' } };
    }
    var largePartyGate = checkLargePartyPaymentGate_(record, now);
    if (largePartyGate) return largePartyGate;

    var currentPaymentStatus = Booking.normalizePaymentStatus(record.paymentStatus);
    if (currentPaymentStatus === null) {
      recordPaymentRecoveryBestEffort_(
        bookingId, record, 'UNKNOWN_PAYMENT_STATUS',
        'paymentStatus列に既知のいずれの値とも一致しない値が入っています。Bookingsを直接確認してください。',
        now
      );
      return { success: false, error: { code: 'UNKNOWN_PAYMENT_STATUS', message: '決済状態が不明なため処理を停止しました。' } };
    }

    if (
      currentPaymentStatus === Booking.PAYMENT_STATUS.PAID ||
      currentPaymentStatus === Booking.PAYMENT_STATUS.REFUND_PENDING ||
      currentPaymentStatus === Booking.PAYMENT_STATUS.REFUNDED
    ) {
      return { success: false, error: { code: 'ALREADY_PAID', message: 'この予約は既に決済処理が完了しています。' } };
    }

    if (currentPaymentStatus === Booking.PAYMENT_STATUS.CHECKOUT_PENDING) {
      return resumeExistingCheckout_(record, stripeConfig, now);
    }

    /* NOT_STARTED または FAILED */
    return startNewCheckoutAttempt_(bookingId, stripeConfig, now);
  }

  return {
    createBooking: createBooking,
    confirmBooking: confirmBooking,
    approvePhotoSupport: approvePhotoSupport,
    expirePendingBookings: expirePendingBookings,
    reviveExpiredBooking: reviveExpiredBooking,
    cancelBookingAdmin: cancelBookingAdmin,
    updateBookingPrice: updateBookingPrice,
    applyPaymentStateUpdate: applyPaymentStateUpdate,
    beginCardCheckout: beginCardCheckout,
    approveLargeParty: approveLargeParty,
    rejectLargeParty: rejectLargeParty,
    changeBookingPeople: changeBookingPeople,
    getLargePartySummary: getLargePartySummary,
    startLargePartyCheckout: startLargePartyCheckout,
    /*
     * Issue #341 PR-D: BookingRefund.gs（Booking Admin専用。取消・返金のオーケストレーション）
     * だけが使う、Lock保持中専用の内部関数。呼び出し元が既にLockService.getScriptLock()を
     * 取得していることが前提で、これらの関数自身はLockを取得・解放しない。取消（Calendar
     * 削除・CANCELLED更新）と返金試行の予約を同じLock区間で行うために公開する。
     * 管理者操作以外（公開Web App・Webhook受信）から呼ばないこと。
     */
    lockedInternals: {
      cancelBookingAdminLocked: cancelBookingAdminLocked_,
      applyPaymentStateUpdateLocked: applyPaymentStateUpdateLocked_
    }
  };
})();

/* Issue #273の診断終了後に削除する一時関数。
   指定requestIdに対応する診断プロパティだけをLoggerへ出す。 */
function debugReadBookingDiagnostic(requestId) {
  var safeRequestId = String(requestId || '');
  if (!/^[A-Za-z0-9-]{1,64}$/.test(safeRequestId)) {
    throw new Error('有効なrequestIdを指定してください。');
  }
  var value = PropertiesService.getScriptProperties().getProperty('BOOKING_DIAG_' + safeRequestId);
  Logger.log(value || 'BOOKING_DIAGNOSTIC_NOT_FOUND');
}
