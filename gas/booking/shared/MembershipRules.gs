/*
 * MembershipRules.gs — SNB MEMBER（月額会員。Issue #471）の純粋ロジック。
 * GAS実行環境（Sheets・Stripe）に依存しない関数のみを置く（node --testでそのままvm実行できる）。
 *
 * 【会員制度（Issue #469/#471で固定。Stripe都合で変えない）】
 * - 月額1,000円・自動更新・更新基準日は毎月1日。
 * - 入会月は日割りせず1,000円満額。入会日から当月末まで有効。
 * - 翌月1日の課金成功で翌月分を有効化。更新失敗は猶予期間なし（その月はinactive）。
 * - 解約しても支払済みの当月末まではactive。日割り返金なし。
 *
 * 【資格判定の考え方】資格は「利用日の属する暦月（JST）の分が支払済みか」だけで決まる。
 * 支払済みの月は「月ごとの支払い事実」（MemberRepositoryのMemberMonthsシート。1会員×1か月＝1行）
 * として永続化し、資格判定はその事実の有無だけを見る。
 * - 現在のStripe subscription状態（active等）からは未来月の資格を推測しない。
 * - 解約・更新失敗は「翌月の支払い事実が作られない」ことで自然にinactiveになる
 *   （猶予期間のロジックを別に持たない）。
 * - 支払い事実は追記専用・(会員, 月)で冪等のため、Webhookのイベント順序が前後しても
 *   結果が変わらない。
 *
 * 【Stripeの課金方式（Stripe公式仕様の確認結果。README「SNB MEMBER」節参照）】
 * 1. 入会: Checkout Session（mode=payment）で入会月ぶん1,000円を満額で決済し、決済手段を
 *    将来の請求用に保存する（setup_future_usage=off_session）。Checkoutのsubscriptionモードは
 *    使わない。理由: Checkoutでbilling_cycle_anchorを指定してproration_behavior=noneにすると
 *    入会時の課金が発生せず、かつその組み合わせでは単発（one-time）価格を同じSessionに
 *    含められないため、「入会月に満額1,000円を課金し、翌月1日に更新」を1回のCheckoutでは
 *    表現できない。
 * 2. 決済完了後、サーバー側でsubscriptionを作成する。billing_cycle_anchor＝翌月1日 00:00 UTC、
 *    proration_behavior=none。入会月は課金されず（既に満額を決済済み）、翌月1日から
 *    毎月1,000円が自動請求される。
 * 3. アンカーを00:00 UTCにする理由: Stripeの請求日は日付ではなくタイムスタンプで、月次の
 *    繰り返しはUTCの「日」を維持する。JSTの月初0:00（＝前日15:00 UTC）をアンカーにすると
 *    UTCの「30日/31日」基準になり、翌月以降の請求がJSTの月末に前倒しされたり月ごとに
 *    ずれる。00:00 UTC（＝JST 9:00）なら毎月UTCの1日＝JSTの1日になり、ずれない。
 *    このため更新の課金実行は毎月1日 09:00 JSTで、それまでの間（1日 0:00〜9:00 JST）は
 *    新しい月の支払い事実がまだ無く、その間に作られた当月利用の予約は一般料金になる
 *    （fail-closed）。
 */
'use strict';

var MembershipRules = (function () {
  var MONTHLY_FEE_JPY = 1000;
  var CURRENCY = 'JPY';
  var JST_OFFSET_MS_ = 9 * 60 * 60 * 1000;

  /* 当方が作るStripe subscription/checkoutの目印。Stripe側のmetadataに入れる。 */
  var METADATA_ORDER_TYPE = 'membership';

  var STATUS = { INCOMPLETE: 'incomplete', ACTIVE: 'active', PAST_DUE: 'past_due', CANCELED: 'canceled' };

  /*
   * メールアドレスの照合用正規化（前後空白除去・小文字化）。予約メールと会員登録メールを
   * この関数で正規化してから完全一致で照合する。空・文字列以外は空文字（＝照合不能。
   * 呼び出し側は必ず非会員として扱う）。
   */
  function normalizeEmail(value) {
    if (typeof value !== 'string') return '';
    return value.trim().toLowerCase();
  }

  function isValidEmail(value) {
    var email = normalizeEmail(value);
    return email.length > 0 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  /* 'YYYY-MM-DD'（利用日）→ 'YYYY-MM'。形式不正は空文字（＝判定不能。非会員扱い）。 */
  function monthKeyOfDateString(dateString) {
    if (typeof dateString !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(dateString)) return '';
    return dateString.substring(0, 7);
  }

  function pad2_(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /* Unix秒 → JSTの暦月 'YYYY-MM'。不正値は空文字。 */
  function jstMonthKeyOfEpochSeconds(seconds) {
    var value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    var shifted = new Date(value * 1000 + JST_OFFSET_MS_);
    return shifted.getUTCFullYear() + '-' + pad2_(shifted.getUTCMonth() + 1);
  }

  /* Unix秒 → JSTの日（1〜31）。不正値は0。 */
  function jstDayOfEpochSeconds(seconds) {
    var value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return 0;
    return new Date(value * 1000 + JST_OFFSET_MS_).getUTCDate();
  }

  function nextMonthKey(monthKey) {
    var m = /^(\d{4})-(\d{2})$/.exec(monthKey || '');
    if (!m) return '';
    var year = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    return month === 12 ? (year + 1) + '-01' : year + '-' + pad2_(month + 1);
  }

  /* 'YYYY-MM' の翌月1日 00:00 UTC（Unix秒）。subscriptionのbilling_cycle_anchorに使う。 */
  function renewalAnchorSecondsAfterMonth(monthKey) {
    var next = /^(\d{4})-(\d{2})$/.exec(nextMonthKey(monthKey));
    if (!next) return 0;
    return Date.UTC(parseInt(next[1], 10), parseInt(next[2], 10) - 1, 1, 0, 0, 0) / 1000;
  }

  /*
   * Stripeのsubscription.statusを当方のstatusへ写像する（情報表示用。資格判定には使わない）。
   * 未知の値はfail-closedにincomplete扱い。
   */
  function mapSubscriptionStatus(stripeStatus) {
    if (stripeStatus === 'active' || stripeStatus === 'trialing') return STATUS.ACTIVE;
    if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return STATUS.PAST_DUE;
    if (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') return STATUS.CANCELED;
    return STATUS.INCOMPLETE;
  }

  /*
   * subscriptionの現在の請求期間。API version 2025-03-31.basil以降はsubscription直下ではなく
   * items.data[]に移った（旧versionは直下）。どちらでも読めるようにする。見つからなければnull。
   */
  function readSubscriptionPeriod(subscription) {
    if (!subscription || typeof subscription !== 'object') return { start: null, end: null };
    var start = subscription.current_period_start;
    var end = subscription.current_period_end;
    var item = subscription.items && subscription.items.data && subscription.items.data[0];
    if ((start === undefined || start === null) && item) start = item.current_period_start;
    if ((end === undefined || end === null) && item) end = item.current_period_end;
    return {
      start: Number.isFinite(Number(start)) && start !== null ? Number(start) : null,
      end: Number.isFinite(Number(end)) && end !== null ? Number(end) : null
    };
  }

  /*
   * invoiceから所属subscriptionのIDとmetadataを取り出す。API version 2025-03-31.basil以降は
   * invoice.parent.subscription_details、旧versionは invoice.subscription / invoice.subscription_details。
   */
  function readInvoiceSubscription(invoice) {
    if (!invoice || typeof invoice !== 'object') return { subscriptionId: '', metadata: {} };
    var details = (invoice.parent && invoice.parent.subscription_details) || invoice.subscription_details || {};
    var raw = details.subscription !== undefined ? details.subscription : invoice.subscription;
    var subscriptionId = typeof raw === 'string' ? raw : ((raw && raw.id) || '');
    return { subscriptionId: subscriptionId, metadata: details.metadata || {} };
  }

  /*
   * 月次更新invoice（billing_reason=subscription_cycle・1,000円・JPY・支払済み）から、
   * 支払われた「利用月」を決める。invoice自体のperiod_start/endは旧API versionでは
   * 「直前の期間」を指すため使わず、1,000円のline itemのperiod.startを使う
   * （更新後の新しい期間の開始＝その月の1日）。判定できない・想定外（日が1日でない等）は
   * fail-closedに ok:false を返し、月の支払い事実を作らない。
   */
  function resolvePaidMonthOfRenewalInvoice(invoice) {
    if (!invoice || typeof invoice !== 'object') return { ok: false, code: 'INVALID_INVOICE' };
    if (invoice.billing_reason !== 'subscription_cycle') return { ok: false, code: 'NOT_RENEWAL', ignorable: true };
    if (invoice.status !== 'paid') return { ok: false, code: 'NOT_PAID' };
    if (Number(invoice.amount_paid) !== MONTHLY_FEE_JPY || String(invoice.currency || '').toUpperCase() !== CURRENCY) {
      return { ok: false, code: 'UNEXPECTED_AMOUNT' };
    }
    var lines = (invoice.lines && invoice.lines.data) || [];
    var line = null;
    for (var i = 0; i < lines.length; i++) {
      if (Number(lines[i].amount) === MONTHLY_FEE_JPY && lines[i].period && lines[i].period.start) {
        line = lines[i];
        break;
      }
    }
    if (!line) return { ok: false, code: 'NO_MONTHLY_LINE' };
    if (jstDayOfEpochSeconds(line.period.start) !== 1) return { ok: false, code: 'PERIOD_NOT_MONTH_START' };
    var month = jstMonthKeyOfEpochSeconds(line.period.start);
    return month ? { ok: true, month: month } : { ok: false, code: 'INVALID_PERIOD' };
  }

  return {
    MONTHLY_FEE_JPY: MONTHLY_FEE_JPY,
    CURRENCY: CURRENCY,
    METADATA_ORDER_TYPE: METADATA_ORDER_TYPE,
    STATUS: STATUS,
    normalizeEmail: normalizeEmail,
    isValidEmail: isValidEmail,
    monthKeyOfDateString: monthKeyOfDateString,
    jstMonthKeyOfEpochSeconds: jstMonthKeyOfEpochSeconds,
    jstDayOfEpochSeconds: jstDayOfEpochSeconds,
    nextMonthKey: nextMonthKey,
    renewalAnchorSecondsAfterMonth: renewalAnchorSecondsAfterMonth,
    mapSubscriptionStatus: mapSubscriptionStatus,
    readSubscriptionPeriod: readSubscriptionPeriod,
    readInvoiceSubscription: readInvoiceSubscription,
    resolvePaidMonthOfRenewalInvoice: resolvePaidMonthOfRenewalInvoice
  };
})();
