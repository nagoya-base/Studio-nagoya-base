/*
 * MembershipRecovery.gs — 処理済み初回Subscription決済の初回Period復旧（Issue #537）。
 *
 * 背景: Issue #535 / PR #536 より前に成功した入会決済は、checkout.session.completed が StripeEvents 上で
 * 処理済みのため、Webhookを再送しても再処理されず、初回Period（MemberPeriods）だけが欠落している。
 * 本ファイルは、管理者が対象を明示して実行する**復旧専用処理**で、欠落した初回Periodだけを冪等に記録する。
 *
 * 【やらないこと】
 * - StripeEvents の行を削除・書換えして「未処理」に戻さない（StripeEventRepository を一切呼ばない）。
 * - Webhook本体（StripeWebhookProcessor）に特例分岐を足さない。通常のinvoice.paid・更新・返金・旧mode=payment・
 *   プレスタート・MemberMonths・MEMBERSHIP_JOIN_PAUSED・STRIPE_CHECKOUT_ENABLEDには触れない。
 * - 会員行・返金台帳は書かない。書くのは MemberRepository.recordPeriod（MemberPeriods）だけ。
 *
 * 【検証】Stripeから Checkout Session / Subscription / 初回invoice を再取得し、PR #536 の正本ロジック
 * MembershipRules.resolveInitialPeriodOfSubscriptionJoin で（billing_reason=subscription_create・Subscription一致・
 * status=paid・500円JPY・期間・incomplete除外）を再検証する。1つでも満たさなければ何も書かない（fail-closed）。
 * 記録は通常処理と同じ source = (invoice, 初回invoice ID) なので、通常処理・本処理のどちらが先でも1行に収束する。
 * 全額返金済み（MemberRefunds に (invoice, ID)）は記録せず、資格を有効化しない。
 *
 * 【実行方法】dry-run（既定。書き込まない）→ 内容確認 → execute:true で実行。
 *   recoverInitialMembershipPeriod({ checkoutSessionId: 'cs_...' })                 // dry-run
 *   recoverInitialMembershipPeriod({ checkoutSessionId: 'cs_...', execute: true })  // 実行
 * Subscription ID指定は、そのSubscriptionの最新invoiceが初回invoiceのときだけ使える（更新済みの場合は
 * Checkout Session ID を指定する）。Booking Adminの管理者認証済み関数 adminRecoverInitialMembershipPeriod 経由、
 * またはGASエディタから実行する。
 *
 * 【ログ・戻り値】Secret・顧客メール・customer/subscription/invoiceの完全IDは出さない（末尾4文字のみのマスク表示）。
 */
'use strict';

var MembershipRecovery = (function () {
  var RECOVERY_EVENT_ID_ = 'RECOVERY:issue537';
  var LOCK_TIMEOUT_MS_ = 30 * 1000;

  /* 完全IDを出さないマスク表示。例: in_1Abc...XYZ9 → in_…XYZ9。 */
  function maskId_(value) {
    var text = String(value || '');
    if (!text) return '';
    var prefix = text.indexOf('_') > 0 ? text.slice(0, text.indexOf('_') + 1) : '';
    return prefix + '…' + text.slice(-4);
  }

  function result_(ok, code, message, extra) {
    return Object.assign({ success: ok, code: code, message: message, executed: false, recorded: false, alreadyRecorded: false }, extra || {});
  }

  function lookupFailure_(label, lookup) {
    Logger.log('MembershipRecovery: ' + label + 'の取得に失敗しました errorType=' + (lookup && lookup.errorType));
    var retryable = !lookup || lookup.errorType !== 'STRIPE_ERROR';
    return result_(false, retryable ? 'STRIPE_LOOKUP_FAILED' : 'STRIPE_OBJECT_NOT_FOUND',
      retryable ? 'Stripeへの照会に失敗しました。時間をおいて再実行してください。' : label + 'をStripeで確認できません。');
  }

  function parseTarget_(target) {
    var input = target || {};
    var sessionId = typeof input.checkoutSessionId === 'string' ? input.checkoutSessionId.trim() : '';
    var subscriptionId = typeof input.subscriptionId === 'string' ? input.subscriptionId.trim() : '';
    if ((sessionId ? 1 : 0) + (subscriptionId ? 1 : 0) !== 1) return null;
    if (sessionId && !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
    if (subscriptionId && !/^sub_[A-Za-z0-9_]+$/.test(subscriptionId)) return null;
    return { sessionId: sessionId, subscriptionId: subscriptionId };
  }

  /*
   * 復旧の可否を検証する（書き込まない）。成功時は { ok: true, plan } 、不可は { ok: false, result }。
   */
  function plan_(target, stripeConfig) {
    var subscriptionId = target.subscriptionId;
    var session = null;
    var memberIdHint = '';
    if (target.sessionId) {
      var sessionResult = StripeGateway.retrieveCheckoutSession(stripeConfig, target.sessionId);
      if (!sessionResult.ok) return { ok: false, result: lookupFailure_('Checkout Session', sessionResult) };
      session = sessionResult.session;
      if (session.mode !== 'subscription' || !session.metadata || session.metadata.orderType !== MembershipRules.METADATA_ORDER_TYPE) {
        return { ok: false, result: result_(false, 'NOT_MEMBERSHIP_SUBSCRIPTION_CHECKOUT', 'SNB MEMBERの入会Checkout（mode=subscription）ではありません。') };
      }
      if (session.paymentStatus !== 'paid') {
        return { ok: false, result: result_(false, 'CHECKOUT_NOT_PAID', '入会Checkoutが支払済みではありません。') };
      }
      if (session.amountTotal !== MembershipRules.MONTHLY_FEE_JPY || session.currency !== MembershipRules.CURRENCY) {
        return { ok: false, result: result_(false, 'CHECKOUT_AMOUNT_MISMATCH', '入会Checkoutの金額が会費と一致しません。') };
      }
      if (!session.subscriptionId) {
        return { ok: false, result: result_(false, 'NO_SUBSCRIPTION', '入会CheckoutにSubscriptionがありません。') };
      }
      subscriptionId = session.subscriptionId;
      memberIdHint = typeof session.metadata.memberId === 'string' ? session.metadata.memberId : '';
    }

    var subscriptionResult = StripeGateway.retrieveSubscription(stripeConfig, subscriptionId);
    if (!subscriptionResult.ok) return { ok: false, result: lookupFailure_('Subscription', subscriptionResult) };
    var subscription = subscriptionResult.subscription;
    var metadata = (subscription.raw && subscription.raw.metadata) || {};
    var memberId = typeof metadata.memberId === 'string' ? metadata.memberId : '';
    if (metadata.orderType !== MembershipRules.METADATA_ORDER_TYPE || !memberId || (memberIdHint && memberIdHint !== memberId)) {
      return { ok: false, result: result_(false, 'SUBSCRIPTION_MISMATCH', 'Subscriptionのmetadataが入会Checkoutと一致しません。') };
    }

    var invoiceId = (session && session.invoiceId) || latestInvoiceIdOf_(subscription.raw);
    if (!invoiceId) return { ok: false, result: result_(false, 'NO_INITIAL_INVOICE', '初回invoiceを特定できません。') };
    var invoiceResult = StripeGateway.retrieveInvoice(stripeConfig, invoiceId);
    if (!invoiceResult.ok) return { ok: false, result: lookupFailure_('初回invoice', invoiceResult) };
    var initial = MembershipRules.resolveInitialPeriodOfSubscriptionJoin(invoiceResult.invoice, subscription.raw);
    if (!initial.ok) {
      return { ok: false, result: result_(false, 'INITIAL_PERIOD_NOT_CONFIRMED', '初回invoiceの支払いを確認できません（' + initial.code + '）。', { reason: initial.code }) };
    }

    /* 会員行が存在し、同じSubscriptionに結び付いていること（会員行は作らない）。 */
    var member = MemberRepository.findMember({ memberId: memberId });
    if (!member) return { ok: false, result: result_(false, 'MEMBER_NOT_FOUND', '会員行が存在しません。通常の入会処理で会員行を作成してください。') };
    var recordedSubscriptionId = member.record.stripeSubscriptionId;
    /* 空欄も不一致として拒否する（fail-closed。同じSubscriptionに結び付いていると確認できた会員行だけを対象にする）。 */
    if (recordedSubscriptionId !== subscription.id) {
      return { ok: false, result: result_(false, 'MEMBER_SUBSCRIPTION_MISMATCH', '会員行のSubscriptionが対象と一致しません。') };
    }
    return { ok: true, plan: { memberId: memberId, email: member.record.email, subscriptionId: subscription.id, initial: initial } };
  }

  function latestInvoiceIdOf_(subscriptionRaw) {
    var raw = subscriptionRaw && subscriptionRaw.latest_invoice;
    if (typeof raw === 'string') return raw;
    return (raw && typeof raw.id === 'string') ? raw.id : '';
  }

  function secondsToDate_(seconds) {
    var value = Number(seconds);
    return Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
  }

  function describe_(plan) {
    var initial = plan.initial;
    return {
      memberId: maskId_(plan.memberId),
      invoice: maskId_(initial.invoiceId),
      periodStart: secondsToDate_(initial.periodStartSeconds).toISOString(),
      periodEnd: secondsToDate_(initial.periodEndSeconds).toISOString(),
      amountJpy: MembershipRules.MONTHLY_FEE_JPY
    };
  }

  /*
   * 初回Periodの復旧。target: { checkoutSessionId | subscriptionId (どちらか一方), execute?: boolean }。
   * execute が true でない限り何も書かない（dry-run）。
   * 戻り値: { success, code, message, executed, recorded, alreadyRecorded, eligibleNow?, plan? }。
   */
  function recoverInitialPeriod(target) {
    var parsed = parseTarget_(target);
    if (!parsed) {
      return result_(false, 'INVALID_TARGET', 'checkoutSessionId（cs_…）かsubscriptionId（sub_…）のどちらか一方を指定してください。');
    }
    var execute = !!(target && target.execute === true);
    var stripeConfig = BookingConfig.getStripeConfig();
    var planned = plan_(parsed, stripeConfig);
    if (!planned.ok) {
      Logger.log('MembershipRecovery: 復旧不可 code=' + planned.result.code);
      return planned.result;
    }
    var plan = planned.plan;
    var initial = plan.initial;
    var summary = describe_(plan);

    if (MemberRepository.isSourceRefunded('invoice', initial.invoiceId)) {
      return result_(true, 'REFUNDED_NO_CHANGE', '初回の支払いは全額返金済みのため、資格は有効化しません（Periodを記録しません）。', { plan: summary });
    }
    var already = MemberRepository.hasPeriodForSource('invoice', initial.invoiceId);
    if (already) {
      return result_(true, 'ALREADY_RECORDED', '初回Periodは記録済みです。変更しません。', { alreadyRecorded: true, plan: summary });
    }
    if (!execute) {
      return result_(true, 'DRY_RUN_RECOVERABLE', '復旧できます。execute:true で初回Periodを記録します（dry-runのため書き込んでいません）。', { plan: summary });
    }

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return result_(false, 'LOCK_TIMEOUT', '他の処理が実行中です。時間をおいて再実行してください。', { plan: summary });
    }
    var recorded = false;
    var refundedInLock = false;
    try {
      /* ロック内で返金・記録の状態を再確認する（通常Webhookとの同時実行でも1行）。 */
      refundedInLock = MemberRepository.isSourceRefunded('invoice', initial.invoiceId);
      if (!refundedInLock) {
        recorded = MemberRepository.recordPeriod({
          memberId: plan.memberId,
          subscriptionId: plan.subscriptionId,
          periodStartSeconds: initial.periodStartSeconds,
          periodEndSeconds: initial.periodEndSeconds,
          sourceType: 'invoice',
          sourceId: initial.invoiceId,
          amount: MembershipRules.MONTHLY_FEE_JPY,
          paidAt: secondsToDate_(initial.paidAtSeconds) || new Date(),
          eventId: RECOVERY_EVENT_ID_
        }, new Date()).recorded;
      }
    } finally {
      lock.releaseLock();
    }
    if (refundedInLock) {
      return result_(true, 'REFUNDED_NO_CHANGE', '初回の支払いは全額返金済みのため、資格は有効化しません（Periodを記録しません）。', { plan: summary });
    }
    Logger.log('MembershipRecovery: 初回Periodを復旧しました invoice=' + maskId_(initial.invoiceId) + ' recorded=' + recorded);
    var todayJst = MembershipRules.jstDateStringOfEpochSeconds(Math.floor(new Date().getTime() / 1000));
    return result_(true, recorded ? 'RECOVERED' : 'ALREADY_RECORDED',
      recorded ? '初回Periodを記録しました。' : '初回Periodは記録済みです。変更しません。',
      { executed: true, recorded: recorded, alreadyRecorded: !recorded, eligibleNow: MemberRepository.isMemberOnDate(plan.email, todayJst) === true, plan: summary });
  }

  return {
    recoverInitialPeriod: recoverInitialPeriod
  };
})();

/* GASエディタ・Booking Adminから呼ぶ入口（既定はdry-run。execute:true で記録）。 */
function recoverInitialMembershipPeriod(target) {
  return MembershipRecovery.recoverInitialPeriod(target);
}
