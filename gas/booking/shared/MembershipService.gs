/*
 * MembershipService.gs — SNB MEMBER（Issue #471）の入会受付。Booking Web Appから呼ぶ。
 *
 * 入会はStripe Checkout mode=subscription（Issue #532）。入会日に初回500円を請求し、入会日から1か月有効・以後
 * 入会日基準で毎月自動更新する。会員登録はBooking Admin側（StripeWebhookProcessor.handleMembershipSubscriptionJoin_）、
 * 支払済み期間の記録はinvoice.paid（MemberPeriods）が担い、どちらが先に届いても同じ結果になる。
 * 旧mode=payment方式（二段階）は新規加入では使わない（発行済みの旧Checkoutの完了はWebhook側の旧経路が処理する）。
 *
 * 【二重加入・二重課金の防止（レビュー対応）】
 * - 受付時: 同じメールに有効な会員（subscription有効、または当月の支払い事実あり）が既にいる場合は
 *   Checkoutを発行しない。
 * - 会員の存在を外部へ漏らさないため、**応答は既存会員・新規・保留中のいずれでも同じ形・同じ文言**
 *   （`{ success: true, message }`）にし、結果はメールアドレス宛のメールでだけ伝える（新規は決済URL、
 *   既存会員はその旨）。他人のメールを入力しても、結果を見られるのはそのメールの持ち主だけ。
 * - 並行リクエスト: LockServiceで「確認〜発行〜保留中マークの記録」を直列化し、同じメールには有効な
 *   保留中入会（永続台帳MemberCheckouts。pendingUntil＝Checkout失効35分＋Webhook猶予10分）がある間、
 *   新しいCheckoutを発行しない。確認→保留中の永続化→Checkout発行→セッションID記録をロック内で行う。
 *   CacheServiceは正本にしない（消失し得るため使わない）。
 * - 最終防御: Webhook側（StripeWebhookProcessor.handleMembershipJoin_）が、同じメールの有効な別会員
 *   がいる場合は会員・subscriptionを作らず要復旧（返金確認）にする。
 *
 * - 新しいCheckout導線は既存と同じキルスイッチ（STRIPE_CHECKOUT_ENABLED）に従う。未設定・
 *   'true'以外では入会Checkoutを発行しない（この変更でSTRIPE_CHECKOUT_ENABLEDは変更しない）。
 * - 入会受付の一時停止（Issue #532）: Script Property MEMBERSHIP_JOIN_PAUSED='true' のときだけ新しい入会Checkoutを発行しない。
 *   STRIPE_CHECKOUT_ENABLEDとは独立で、部屋予約・オプションのカード決済・本人確認・解約・Webhook処理は止めない。
 * - 金額はサーバー側の固定値（MembershipRules.MONTHLY_FEE_JPY）のみ。クライアントから金額は
 *   受け取らない。メールアドレスは入力値をCheckoutへ固定する。予約メールとの照合は正規化した完全一致。
 */
'use strict';

var MembershipService = (function () {
  var RATE_LIMIT_PER_EMAIL_ = { windowMinutes: 10, maxCount: 3 };
  var RATE_LIMIT_GLOBAL_ = { windowMinutes: 1, maxCount: 20 };
  var CHECKOUT_TTL_SECONDS_ = 35 * 60;
  /* Checkout失効後、決済完了Webhookが反映されるまでの猶予。この間も同じメールへ再発行しない。 */
  var PENDING_GRACE_SECONDS_ = 10 * 60;
  var LOCK_TIMEOUT_MS_ = 10000;
  var MAIL_SUBJECT_ = '【Studio Nagoya Base】SNB MEMBER 入会のご案内';

  /* 既存会員・新規・保留中のどれでも同一の応答。 */
  var ACCEPTED_RESPONSE_MESSAGE_ = '入力されたメールアドレス宛に、入会のご案内をお送りしました。メールをご確認ください（届かない場合は迷惑メールフォルダもご確認ください）。';

  /* Stripe失敗ログ用の要約（Issue #524）。結果オブジェクトから必要な4項目だけを明示的に取り出す。
     オブジェクト全体やbodyはログへ出さない。messageはStripeが鍵の一部等を含めて返す恐れがあるため、
     鍵・Bearer・token・client_secret・Stripe object ID・URL様の文字列を伏せ、長さも制限する。例外は投げない。 */
  var LOG_VALUE_MAX_LENGTH_ = 200;

  function sanitizeLogValue_(value) {
    if (value === null || value === undefined) return '';
    var text = String(value)
      .replace(/Bearer\s+\S+/gi, '[REDACTED]')
      .replace(/\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_*]+/g, '[REDACTED]')
      .replace(/\b(?:cs|seti|pi)_[A-Za-z0-9]+_secret_[A-Za-z0-9_]+/g, '[REDACTED]')
      .replace(/(client_secret|access_token|refresh_token|api[_-]?key|token|secret)(["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi, '$1$2[REDACTED]')
      .replace(/\b(?:cus|sub|si|pi|pm|ch|re|in|cs|price|prod|evt|seti|txn)_[A-Za-z0-9]+/g, '[ID]')
      .replace(/https?:\/\/\S+/gi, '[URL]')
      .replace(/[\r\n]+/g, ' ');
    return text.length > LOG_VALUE_MAX_LENGTH_ ? text.substring(0, LOG_VALUE_MAX_LENGTH_) + '...' : text;
  }

  function describeStripeFailure_(result) {
    try {
      var r = result || {};
      return 'errorType=' + sanitizeLogValue_(r.errorType || 'UNKNOWN') +
        ' httpStatus=' + sanitizeLogValue_(r.httpStatus) +
        ' stripeErrorCode=' + sanitizeLogValue_(r.stripeErrorCode) +
        ' stripeErrorType=' + sanitizeLogValue_(r.stripeErrorType) +
        ' message=' + sanitizeLogValue_(r.message);
    } catch (e) {
      return 'errorType=UNKNOWN';
    }
  }

  function fail_(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  function accepted_() {
    return { success: true, message: ACCEPTED_RESPONSE_MESSAGE_ };
  }

  function sendMail_(email, body) {
    var mailConfig = BookingConfig.getMailConfig();
    var message = { to: email, subject: MAIL_SUBJECT_, body: body };
    if (mailConfig.displayName) message.name = mailConfig.displayName;
    if (mailConfig.replyTo) message.replyTo = mailConfig.replyTo;
    MailApp.sendEmail(message);
  }

  function todayDateString_() {
    return MembershipRules.jstDateStringOfEpochSeconds(Math.floor(new Date().getTime() / 1000));
  }

  /* 入会元ブランド（Issue #504）。未指定はSNB（後方互換）。許可コード以外は拒否し、任意文字列をURL解決へ渡さない。 */
  var JOIN_BRANDS_ = ['snb', 'mens', 'studio_x'];

  function normalizeJoinBrand_(value) {
    if (value === undefined || value === null || value === '') return 'snb';
    return typeof value === 'string' && JOIN_BRANDS_.indexOf(value) !== -1 ? value : '';
  }

  /* input: { email, brand? }。戻り値: { success: true, message } または { success: false, error }。 */
  function startCheckout(input) {
    var email = MembershipRules.normalizeEmail(input && input.email);
    if (!MembershipRules.isValidEmail(email)) {
      return fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    }

    var brand = normalizeJoinBrand_(input && input.brand);
    if (!brand) {
      return fail_('INVALID_BRAND', 'リクエストの形式が正しくありません。');
    }

    var stripeConfig = BookingConfig.getStripeConfig();
    if (stripeConfig.membershipJoinPaused === true) {
      return fail_('MEMBERSHIP_JOIN_PAUSED', '現在、入会受付を一時停止しています。しばらくしてから再度お試しください。');
    }
    if (!stripeConfig.checkoutEnabled) {
      return fail_('CHECKOUT_DISABLED', '現在オンラインでの入会受付は行っていません。');
    }
    var returnUrls = Booking.resolveMembershipReturnUrls(brand, stripeConfig);
    if (!stripeConfig.secretKey || !returnUrls.ok) {
      return fail_('STRIPE_NOT_CONFIGURED', '入会受付の設定が完了していません。');
    }

    var allowed = RateLimiter.limitByKey('member_join_all', RATE_LIMIT_GLOBAL_.windowMinutes, RATE_LIMIT_GLOBAL_.maxCount) &&
      RateLimiter.limitByKey('member_join_' + email, RATE_LIMIT_PER_EMAIL_.windowMinutes, RATE_LIMIT_PER_EMAIL_.maxCount);
    if (!allowed) {
      return fail_('RATE_LIMITED', '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。');
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return fail_('LOCK_TIMEOUT', '一時的に混み合っています。しばらくしてから再度お試しください。');
    }
    try {
      /* 既存会員の判定は支払済み期間（MemberPeriods＋旧MemberMonths＋永久会員。JSTの今日）またはsubscription有効（Issue #532）。 */
      var today = todayDateString_();
      var existing = MemberRepository.findLiveMemberByEmail(email, today, '') || MemberRepository.isMemberOnDate(email, today);
      if (existing) {
        sendMail_(email, 'このメールアドレスは既にSNB MEMBERとしてご登録済みです。新たにお手続きいただく必要はありません。\n' +
          '更新・解約などについてご不明な点は、お問い合わせください。');
        return accepted_();
      }

      var now = new Date();
      if (MemberRepository.findActivePending(email, now)) {
        /* 有効な保留中Checkoutが永続台帳（MemberCheckouts）にある。二重に発行せず、先に送ったメールを案内する。 */
        return accepted_();
      }

      /* 保留中を先に永続化してからStripeへ発行する（発行後・記録前のクラッシュで2本目が出るのを防ぐ。
         失敗時は解放する）。 */
      var memberId = 'MBR-' + Utilities.getUuid();
      var expiresAtSeconds = Math.floor(now.getTime() / 1000) + CHECKOUT_TTL_SECONDS_;
      MemberRepository.addPending({
        memberId: memberId, email: email,
        pendingUntil: new Date((expiresAtSeconds + PENDING_GRACE_SECONDS_) * 1000)
      }, now);
      var productResult = null;
      if (!stripeConfig.membershipPriceId) {
        /* 既存のPrice IDが無いときは、Product（運営指定または固定ID）に対する月額price_dataで発行する。 */
        var configuredProductId = stripeConfig.membershipProductId || '';
        productResult = StripeGateway.ensureMembershipProduct(stripeConfig,
          configuredProductId || MembershipRules.MEMBERSHIP_PRODUCT_ID, MembershipRules.MEMBERSHIP_PRODUCT_NAME, !configuredProductId);
      }
      var result = productResult && !productResult.ok ? productResult : StripeGateway.createMembershipCheckoutSession(stripeConfig, {
        amountJpy: MembershipRules.MONTHLY_FEE_JPY,
        email: email,
        memberId: memberId,
        successUrl: returnUrls.successUrl,
        cancelUrl: returnUrls.cancelUrl,
        priceId: stripeConfig.membershipPriceId || '',
        productId: productResult ? productResult.productId : '',
        expiresAtSeconds: expiresAtSeconds
      }, memberId);
      if (!result.ok || !result.session || !result.session.url) {
        /* 発行できたか不明なAMBIGUOUS/NETWORKでは解放しない（決済可能なSessionが残っている恐れがあるため
           pendingUntilまで再発行しない）。確定的な失敗のみ解放する。 */
        if (result.errorType === 'STRIPE_ERROR' || result.errorType === 'NOT_CONFIGURED' || result.errorType === 'INVALID_REQUEST') {
          MemberRepository.updatePending(memberId, { state: MemberRepository.PENDING_STATE.EXPIRED }, new Date());
        }
        Logger.log('MembershipService: 入会Checkout Sessionを作成できませんでした ' + describeStripeFailure_(result));
        return fail_('CHECKOUT_UNAVAILABLE', '入会の受付を開始できませんでした。しばらくしてから再度お試しください。');
      }
      MemberRepository.updatePending(memberId, { checkoutSessionId: result.session.id }, new Date());
      sendMail_(email, 'SNB MEMBER（月額500円）の入会手続きは、下記のお支払いページから行えます（35分間有効）。\n\n' +
        result.session.url + '\n\n' +
        '・入会日に初回500円をお支払いいただき、入会日から1か月有効です。\n' +
        '・以後、入会日を基準に毎月自動更新されます（例: 10月15日入会 → 11月15日に500円が自動更新）。\n' +
        '・解約しても、お支払い済みの期間の末日まではご利用いただけます（日割り返金はありません）。\n' +
        '・心当たりがない場合は、このメールを破棄してください。');
      return accepted_();
    } catch (error) {
      Logger.log('MembershipService: 入会受付中にエラーが発生しました');
      return fail_('CHECKOUT_UNAVAILABLE', '入会の受付を開始できませんでした。しばらくしてから再度お試しください。');
    } finally {
      lock.releaseLock();
    }
  }

  /*
   * 会員資格確認（Issue #490）。
   * requestStatusLink: メールアドレスを受け取り、**会員かどうかにかかわらず**同一の応答を返して、
   *   本人確認用のワンタイムリンク（URLのフラグメントにトークン。サーバーログ・Refererに残さない）を
   *   そのメール宛に送る。会員の有無は応答にも送信有無にも出さない。
   * verifyStatusLink: トークンを検証し、リンクを開いた本人（メール受信者）にだけ会員状態を返す。トークンは
   *   有効期限・1回利用・使用後無効化。トークン本体はログに出さず、台帳にはハッシュのみ保存する。
   *   台帳を読めないときはトークンを消費せず汎用エラー（fail-closed。内部詳細は出さない）。
   */
  var STATUS_MAIL_SUBJECT_ = '【Studio Nagoya Base】SNB MEMBER 会員資格の確認';
  var STATUS_TOKEN_TTL_MS_ = 30 * 60 * 1000;
  var STATUS_RATE_LIMIT_PER_EMAIL_ = { windowMinutes: 10, maxCount: 3 };
  var STATUS_RATE_LIMIT_GLOBAL_ = { windowMinutes: 1, maxCount: 20 };
  var STATUS_VERIFY_RATE_LIMIT_ = { windowMinutes: 1, maxCount: 60 };
  var STATUS_TOKEN_KEY_ = 'snb-member-status-token-v1';
  var STATUS_ACCEPTED_MESSAGE_ = '入力されたメールアドレス宛に、会員資格を確認するためのリンクをお送りしました（30分間有効・1回のみ使えます）。メールをご確認ください（届かない場合は迷惑メールフォルダもご確認ください）。';

  function hashStatusToken_(token) {
    var bytes = Utilities.computeHmacSha256Signature(token, STATUS_TOKEN_KEY_, Utilities.Charset.UTF_8);
    return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
  }

  function sendStatusMail_(email, link) {
    var mailConfig = BookingConfig.getMailConfig();
    var message = {
      to: email,
      subject: STATUS_MAIL_SUBJECT_,
      body: 'SNB MEMBERの会員資格を確認するリンクです（30分間有効・1回のみ使えます）。\n\n' + link + '\n\n' +
        '・このリンクを開いた方にだけ、このメールアドレスの会員状態を表示します。他の方に転送しないでください。\n' +
        '・心当たりがない場合は、このメールを破棄してください。'
    };
    if (mailConfig.displayName) message.name = mailConfig.displayName;
    if (mailConfig.replyTo) message.replyTo = mailConfig.replyTo;
    MailApp.sendEmail(message);
  }

  function requestStatusLink(input) {
    var email = MembershipRules.normalizeEmail(input && input.email);
    if (!MembershipRules.isValidEmail(email)) {
      return fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    }
    var allowed = RateLimiter.limitByKey('member_status_all', STATUS_RATE_LIMIT_GLOBAL_.windowMinutes, STATUS_RATE_LIMIT_GLOBAL_.maxCount) &&
      RateLimiter.limitByKey('member_status_' + email, STATUS_RATE_LIMIT_PER_EMAIL_.windowMinutes, STATUS_RATE_LIMIT_PER_EMAIL_.maxCount);
    if (!allowed) {
      return fail_('RATE_LIMITED', '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。');
    }
    var statusUrl = BookingConfig.getStripeConfig().membershipStatusUrl;
    if (!statusUrl) {
      return fail_('STATUS_UNAVAILABLE', '現在、会員資格の確認を受け付けていません。');
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return fail_('LOCK_TIMEOUT', '一時的に混み合っています。しばらくしてから再度お試しください。');
    }
    try {
      var now = new Date();
      var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/[^A-Za-z0-9]/g, '');
      MemberRepository.addStatusToken({ tokenHash: hashStatusToken_(token), email: email, expiresAt: new Date(now.getTime() + STATUS_TOKEN_TTL_MS_) }, now);
      sendStatusMail_(email, statusUrl.split('#')[0] + '#t=' + token);
    } catch (error) {
      Logger.log('MembershipService: 会員資格確認リンクを送信できませんでした');
      return fail_('STATUS_UNAVAILABLE', '現在、会員資格の確認を受け付けていません。しばらくしてから再度お試しください。');
    } finally {
      lock.releaseLock();
    }
    return { success: true, message: STATUS_ACCEPTED_MESSAGE_ };
  }

  /*
   * 解約（Issue #506）。本人確認（verifyStatusLink）に成功した応答にだけ、解約操作用の短命トークンを載せる。
   * - 解約を出すのは、現在の会員資格が有効で、Stripe subscriptionが有効な通常会員だけ（永久会員・非会員・
   *   subscriptionなしには出さない）。既に次回更新停止済みならトークンなしで state=SCHEDULED。
   * - 解約トークンは確認リンクとは別のHMAC鍵で保存し（取り違え防止）、10分・1回限り。画面のメモリにだけ置く。
   * - Stripe ID・会員IDは応答に含めない。
   */
  var CANCEL_TOKEN_KEY_ = 'snb-member-cancel-token-v1';
  var CANCEL_TOKEN_TTL_MS_ = 10 * 60 * 1000;
  var CANCEL_RATE_LIMIT_GLOBAL_ = { windowMinutes: 1, maxCount: 20 };
  var CANCEL_RATE_LIMIT_PER_EMAIL_ = { windowMinutes: 10, maxCount: 5 };
  var CANCEL_MAIL_SUBJECT_ = '【Studio Nagoya Base】SNB MEMBER 解約手続き完了のお知らせ';

  function hashCancelToken_(token) {
    var bytes = Utilities.computeHmacSha256Signature(token, CANCEL_TOKEN_KEY_, Utilities.Charset.UTF_8);
    return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
  }

  function issueCancelOffer_(email, status, now) {
    var unavailable = { state: 'UNAVAILABLE' };
    if (!status || status.active !== true || MembershipRules.isPermanentMember(email)) return unavailable;
    var target = MemberRepository.findCancelTargetForEmail(email);
    if (!target) return unavailable;
    if (target.cancelAtPeriodEnd) return { state: 'SCHEDULED' };
    var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/[^A-Za-z0-9]/g, '');
    MemberRepository.addStatusToken({ tokenHash: hashCancelToken_(token), email: email, expiresAt: new Date(now.getTime() + CANCEL_TOKEN_TTL_MS_) }, now);
    return { state: 'AVAILABLE', token: token };
  }

  function sendCancelMail_(email, validUntil) {
    var mailConfig = BookingConfig.getMailConfig();
    var message = {
      to: email,
      subject: CANCEL_MAIL_SUBJECT_,
      body: 'SNB MEMBERの解約手続きを受け付けました。次回以降の自動更新を停止しました。\n\n' +
        '・会員資格の有効最終日：' + validUntil + '\n' +
        '・現在のお支払い済み期間の末日までは、引き続きSNB MEMBERをご利用いただけます（即時に失効はしません）。\n' +
        '・お支払い済みの会費は、日割りを含め返金しません。\n' +
        '・心当たりがない場合は、お手数ですがお問い合わせください。'
    };
    if (mailConfig.displayName) message.name = mailConfig.displayName;
    if (mailConfig.replyTo) message.replyTo = mailConfig.replyTo;
    MailApp.sendEmail(message);
  }

  function cancelResult_(validUntil, alreadyScheduled) {
    return { success: true, cancel: { state: 'SCHEDULED', validUntil: validUntil, alreadyScheduled: alreadyScheduled } };
  }

  /* input: { cancelToken }。確認ステップ後の「解約を確定する」から呼ばれる。冪等（二重実行しても1回分の結果）。 */
  function cancelMembership(input) {
    var token = input && typeof input.cancelToken === 'string' ? input.cancelToken : '';
    var invalid = fail_('INVALID_TOKEN', '操作の有効期限が切れています。お手数ですが、もう一度メールアドレスを入力して確認用リンクを再発行してください。');
    if (!/^[A-Za-z0-9]{16,128}$/.test(token)) return invalid;
    if (!RateLimiter.limitByKey('member_cancel_all', CANCEL_RATE_LIMIT_GLOBAL_.windowMinutes, CANCEL_RATE_LIMIT_GLOBAL_.maxCount)) {
      return fail_('RATE_LIMITED', '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。');
    }
    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.secretKey) {
      return fail_('CANCEL_UNAVAILABLE', '現在、オンラインでの解約を受け付けていません。お手数ですが、お問い合わせフォームからご連絡ください。');
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return fail_('LOCK_TIMEOUT', '一時的に混み合っています。しばらくしてから再度お試しください。');
    }
    try {
      var now = new Date();
      var row = MemberRepository.findStatusTokenAnyState(hashCancelToken_(token), now);
      if (!row || row.expired) return invalid;
      if (!RateLimiter.limitByKey('member_cancel_' + row.email, CANCEL_RATE_LIMIT_PER_EMAIL_.windowMinutes, CANCEL_RATE_LIMIT_PER_EMAIL_.maxCount)) {
        return fail_('RATE_LIMITED', '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。');
      }

      var facts = MemberRepository.statusFactsForEmail(row.email);
      var status = MembershipRules.describeMembershipStatus(row.email, facts, { permanent: false, nowMs: now.getTime() });
      var target = MemberRepository.findCancelTargetForEmail(row.email);
      if (!status.active || !target || MembershipRules.isPermanentMember(row.email)) return invalid;
      var validUntil = status.validUntil;

      /* 既に次回更新停止済み（二重送信・再操作）。Stripeへは送らず、メールも重ねて送らない。 */
      if (target.cancelAtPeriodEnd) {
        if (!row.used) MemberRepository.markStatusTokenUsed(row.rowNumber, now);
        return cancelResult_(validUntil, true);
      }
      if (row.used) return invalid;

      var result = StripeGateway.setSubscriptionCancelAtPeriodEnd(stripeConfig, target.subscriptionId);
      if (!result.ok || !result.subscription || result.subscription.cancelAtPeriodEnd !== true) {
        Logger.log('MembershipService: 解約を受け付けられませんでした ' + describeStripeFailure_(result));
        return fail_('CANCEL_UNAVAILABLE', '解約を受け付けられませんでした。しばらくしてから再度お試しください。解決しない場合は、お問い合わせフォームからご連絡ください。');
      }
      MemberRepository.markCancelRequested(target.memberId, now);
      MemberRepository.markStatusTokenUsed(row.rowNumber, now);
      try {
        sendCancelMail_(row.email, validUntil);
      } catch (mailError) {
        Logger.log('MembershipService: 解約確認メールを送信できませんでした');
      }
      return cancelResult_(validUntil, false);
    } catch (error) {
      Logger.log('MembershipService: 解約処理中にエラーが発生しました');
      return fail_('CANCEL_UNAVAILABLE', '解約を受け付けられませんでした。しばらくしてから再度お試しください。解決しない場合は、お問い合わせフォームからご連絡ください。');
    } finally {
      lock.releaseLock();
    }
  }

  function verifyStatusLink(input) {
    var token = input && typeof input.token === 'string' ? input.token : '';
    var invalid = fail_('INVALID_TOKEN', 'リンクが無効か、有効期限が切れています。お手数ですが、もう一度メールアドレスを入力してリンクを再発行してください。');
    if (!/^[A-Za-z0-9]{16,128}$/.test(token)) return invalid;
    if (!RateLimiter.limitByKey('member_status_verify_all', STATUS_VERIFY_RATE_LIMIT_.windowMinutes, STATUS_VERIFY_RATE_LIMIT_.maxCount)) {
      return fail_('RATE_LIMITED', '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。');
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return fail_('LOCK_TIMEOUT', '一時的に混み合っています。しばらくしてから再度お試しください。');
    }
    try {
      var now = new Date();
      var row = MemberRepository.findUsableStatusToken(hashStatusToken_(token), now);
      if (!row) return invalid;
      var facts = MemberRepository.statusFactsForEmail(row.email);
      var status = MembershipRules.describeMembershipStatus(row.email, facts, {
        permanent: MembershipRules.isPermanentMember(row.email),
        nowMs: now.getTime()
      });
      var cancel = issueCancelOffer_(row.email, status, now);
      MemberRepository.markStatusTokenUsed(row.rowNumber, now);
      return { success: true, status: status, cancel: cancel };
    } catch (error) {
      Logger.log('MembershipService: 会員資格を確認できませんでした');
      return fail_('STATUS_UNAVAILABLE', '会員資格を確認できませんでした。しばらくしてから再度お試しください。');
    } finally {
      lock.releaseLock();
    }
  }

  return { startCheckout: startCheckout, requestStatusLink: requestStatusLink, verifyStatusLink: verifyStatusLink, cancelMembership: cancelMembership };
})();
