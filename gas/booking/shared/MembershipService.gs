/*
 * MembershipService.gs — SNB MEMBER（Issue #471）の入会受付。Booking Web Appから呼ぶ。
 *
 * 入会は「入会月ぶん500円の満額決済（Checkout mode=payment）」から始まり、決済完了Webhookを
 * 受けてBooking Admin側（StripeWebhookProcessor.handleMembershipJoin_）が会員登録と、
 * 翌月1日からの月額subscriptionを作る（MembershipRules.gs冒頭コメント参照）。
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
 * - 金額はサーバー側の固定値（MembershipRules.MONTHLY_FEE_JPY）のみ。クライアントから金額は
 *   受け取らない。メールアドレスは入力値をCheckoutへ固定する。予約メールとの照合は正規化した完全一致。
 */
'use strict';

var MembershipService = (function () {
  var PRODUCT_NAME_ = 'SNB MEMBER 月会費（入会月）';
  var RATE_LIMIT_PER_EMAIL_ = { windowMinutes: 10, maxCount: 3 };
  var RATE_LIMIT_GLOBAL_ = { windowMinutes: 1, maxCount: 20 };
  var CHECKOUT_TTL_SECONDS_ = 35 * 60;
  /* Checkout失効後、決済完了Webhookが反映されるまでの猶予。この間も同じメールへ再発行しない。 */
  var PENDING_GRACE_SECONDS_ = 10 * 60;
  var LOCK_TIMEOUT_MS_ = 10000;
  var MAIL_SUBJECT_ = '【Studio Nagoya Base】SNB MEMBER 入会のご案内';

  /* 既存会員・新規・保留中のどれでも同一の応答。 */
  var ACCEPTED_RESPONSE_MESSAGE_ = '入力されたメールアドレス宛に、入会のご案内をお送りしました。メールをご確認ください（届かない場合は迷惑メールフォルダもご確認ください）。';

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

  function currentMonthKey_() {
    return MembershipRules.jstMonthKeyOfEpochSeconds(Math.floor(new Date().getTime() / 1000));
  }

  /* input: { email }。戻り値: { success: true, message } または { success: false, error }。 */
  function startCheckout(input) {
    var email = MembershipRules.normalizeEmail(input && input.email);
    if (!MembershipRules.isValidEmail(email)) {
      return fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    }

    var stripeConfig = BookingConfig.getStripeConfig();
    if (!stripeConfig.checkoutEnabled) {
      return fail_('CHECKOUT_DISABLED', '現在オンラインでの入会受付は行っていません。');
    }
    if (!stripeConfig.secretKey || !stripeConfig.membershipSuccessUrl || !stripeConfig.membershipCancelUrl) {
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
      var existing = MemberRepository.findLiveMemberByEmail(email, currentMonthKey_(), '');
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
      var result = StripeGateway.createMembershipCheckoutSession(stripeConfig, {
        amountJpy: MembershipRules.MONTHLY_FEE_JPY,
        email: email,
        memberId: memberId,
        successUrl: stripeConfig.membershipSuccessUrl,
        cancelUrl: stripeConfig.membershipCancelUrl,
        productName: PRODUCT_NAME_,
        expiresAtSeconds: expiresAtSeconds
      }, memberId);
      if (!result.ok || !result.session || !result.session.url) {
        /* 発行できたか不明なAMBIGUOUS/NETWORKでは解放しない（決済可能なSessionが残っている恐れがあるため
           pendingUntilまで再発行しない）。確定的な失敗のみ解放する。 */
        if (result.errorType === 'STRIPE_ERROR' || result.errorType === 'NOT_CONFIGURED' || result.errorType === 'INVALID_REQUEST') {
          MemberRepository.updatePending(memberId, { state: MemberRepository.PENDING_STATE.EXPIRED }, new Date());
        }
        Logger.log('MembershipService: 入会Checkout Sessionを作成できませんでした errorType=' + (result.errorType || 'UNKNOWN'));
        return fail_('CHECKOUT_UNAVAILABLE', '入会の受付を開始できませんでした。しばらくしてから再度お試しください。');
      }
      MemberRepository.updatePending(memberId, { checkoutSessionId: result.session.id }, new Date());
      sendMail_(email, 'SNB MEMBER（月額500円）の入会手続きは、下記のお支払いページから行えます（35分間有効）。\n\n' +
        result.session.url + '\n\n' +
        (MembershipRules.isPrestartJoin(Math.floor(now.getTime() / 1000))
          ? '・SNB MEMBERプレスタート中です。初回500円で2026年11月30日まで有効です（11月1日の追加課金はありません）。\n' +
            '・次回更新は2026年12月1日（500円）、以降は毎月1日に自動更新されます。\n' +
            '・2名ペアパック・シャワー・Studio Xの会員限定有料オプションなどの本特典は2026年12月1日から開始します。90日先行予約は決済完了後すぐご利用いただけます。\n'
          : '・入会月は日割りなしで500円、入会日から当月末まで有効です。\n' +
            '・翌月以降は毎月1日に500円が自動更新されます。\n') +
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
      MemberRepository.markStatusTokenUsed(row.rowNumber, now);
      return { success: true, status: status };
    } catch (error) {
      Logger.log('MembershipService: 会員資格を確認できませんでした');
      return fail_('STATUS_UNAVAILABLE', '会員資格を確認できませんでした。しばらくしてから再度お試しください。');
    } finally {
      lock.releaseLock();
    }
  }

  return { startCheckout: startCheckout, requestStatusLink: requestStatusLink, verifyStatusLink: verifyStatusLink };
})();
