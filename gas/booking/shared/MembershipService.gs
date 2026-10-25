/*
 * MembershipService.gs — SNB MEMBER（Issue #471）の入会Checkout開始。Booking Web Appから呼ぶ。
 *
 * 入会は「入会月ぶん1,000円の満額決済（Checkout mode=payment）」から始まり、決済完了Webhookを
 * 受けてBooking Admin側（StripeWebhookProcessor.handleMembershipJoin_）が会員登録と、
 * 翌月1日からの月額subscriptionを作る（MembershipRules.gs冒頭コメント参照）。
 *
 * - 新しいCheckout導線は既存と同じキルスイッチ（STRIPE_CHECKOUT_ENABLED）に従う。未設定・
 *   'true'以外では入会Checkoutを発行しない（この変更でSTRIPE_CHECKOUT_ENABLEDは変更しない）。
 * - 金額はサーバー側の固定値（MembershipRules.MONTHLY_FEE_JPY）のみ。クライアントから金額は
 *   受け取らない。
 * - 既に会員かどうかの確認・応答は行わない（会員メールの存在を外部へ漏らさないため。二重加入の
 *   防止は案内・運用で行う。README参照）。
 * - メールアドレスは入力値をCheckoutへ固定する。予約メールとの照合は正規化した完全一致。
 */
'use strict';

var MembershipService = (function () {
  var PRODUCT_NAME_ = 'SNB MEMBER 月会費（入会月）';
  var RATE_LIMIT_PER_EMAIL_ = { windowMinutes: 10, maxCount: 3 };
  var RATE_LIMIT_GLOBAL_ = { windowMinutes: 1, maxCount: 20 };

  function fail_(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  /* input: { email }。戻り値: { success: true, checkoutUrl } または { success: false, error }。 */
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

    var memberId = 'MBR-' + Utilities.getUuid();
    var result = StripeGateway.createMembershipCheckoutSession(stripeConfig, {
      amountJpy: MembershipRules.MONTHLY_FEE_JPY,
      email: email,
      memberId: memberId,
      successUrl: stripeConfig.membershipSuccessUrl,
      cancelUrl: stripeConfig.membershipCancelUrl,
      productName: PRODUCT_NAME_
    }, memberId);
    if (!result.ok || !result.session || !result.session.url) {
      Logger.log('MembershipService: 入会Checkout Sessionを作成できませんでした errorType=' + (result.errorType || 'UNKNOWN'));
      return fail_('CHECKOUT_UNAVAILABLE', '入会の決済ページを開始できませんでした。しばらくしてから再度お試しください。');
    }
    return { success: true, checkoutUrl: result.session.url };
  }

  return { startCheckout: startCheckout };
})();
