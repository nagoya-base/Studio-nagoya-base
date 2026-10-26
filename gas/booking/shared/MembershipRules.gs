/*
 * MembershipRules.gs — SNB MEMBER（月額会員。Issue #471）の純粋ロジック。
 * GAS実行環境（Sheets・Stripe）に依存しない関数のみを置く（node --testでそのままvm実行できる）。
 *
 * 【Issue #532（現行）】新規加入は入会日基準の月額Subscription（Checkout mode=subscription。初回500円を入会日に請求し、
 * 入会日から1か月有効・以後入会日基準で毎月自動更新）。資格の正本は「支払済みPeriod」（MemberRepositoryの
 * MemberPeriods。invoice.paidのline item period.start〜period.endをJSTの有効日範囲へ変換）で、旧MemberMonths
 * （JSTの暦月まるごと）・永久会員と合算して判定する。MemberMonthsはデプロイ以降追記しない（凍結。既存行は過去分として有効）。
 * 以下の「毎月1日」「入会月」「プレスタート」の記述は、既存プレスタート会員（課金日を移行しない）と旧mode=payment
 * Checkoutの後処理のために残している旧仕様の説明。
 *
 * 【旧会員制度（Issue #469/#471）】
 * - 月額500円・自動更新・更新基準日は毎月1日。
 * - 入会月は日割りせず500円満額。入会日から当月末まで有効。
 * - 翌月1日の課金成功で翌月分を有効化。更新失敗は猶予期間なし（その月はinactive）。
 * - 解約しても支払済みの当月末まではactive。日割り返金なし。
 *
 * 【プレスタート（Issue #490）】2026/10/26 00:00 JST〜2026/11/30に入会した場合、初回500円で入会日から
 * 2026/11/30まで有効にし、11/1には課金しない（二重課金なし）。次回更新は2026/12/1（以降は毎月1日500円）。
 * 10月入会は「10月」と「11月」の2か月分の支払い事実を記録し、11月入会は通常どおり11月のみ。
 * subscriptionのアンカーはどちらも2026/12/1 00:00 UTC（＝通常の「入会月の翌月1日」と一致）。
 * 会員限定特典の開始（BENEFITS_START_MS_）はこの変更では動かさない。
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
 * 1. 入会: Checkout Session（mode=payment）で入会月ぶん500円を満額で決済し、決済手段を
 *    将来の請求用に保存する（setup_future_usage=off_session）。Checkoutのsubscriptionモードは
 *    使わない。理由: Checkoutでbilling_cycle_anchorを指定してproration_behavior=noneにすると
 *    入会時の課金が発生せず、かつその組み合わせでは単発（one-time）価格を同じSessionに
 *    含められないため、「入会月に満額500円を課金し、翌月1日に更新」を1回のCheckoutでは
 *    表現できない。
 * 2. 決済完了後、サーバー側でsubscriptionを作成する。billing_cycle_anchor＝翌月1日 00:00 UTC、
 *    proration_behavior=none。入会月は課金されず（既に満額を決済済み）、翌月1日から
 *    毎月500円が自動請求される。
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
  var MONTHLY_FEE_JPY = 500;
  var CURRENCY = 'JPY';
  var JST_OFFSET_MS_ = 9 * 60 * 60 * 1000;

  /* 当方が作るStripe subscription/checkoutの目印。Stripe側のmetadataに入れる。 */
  var METADATA_ORDER_TYPE = 'membership';

  /*
   * Issue #478: 会員限定特典（2名ペアパック・シャワー・Studio X有料オプション全般・SNB/mens既存有料機材）の
   * 適用開始。**2026/12/1 00:00 JST以降に新規作成された予約・OptionOrderから**適用する。それ以前に作成済みの
   * 予約・OptionOrder（AWAITING_PAYMENT / PENDING_APPROVAL等を含む）は旧ルールのまま処理する
   * （作成時刻 createdAt で判定。日程変更・承認・決済の時点では世代を切り替えない）。
   * BookingPricing.GENERATION_V2_START_MS_（料金世代V2）と同じ境界。
   */
  var PRESTART_START_MS_ = Date.parse('2026-10-26T00:00:00+09:00');
  var PRESTART_LAST_MONTH_ = '2026-11';

  var BENEFITS_START_MS_ = Date.parse('2026-12-01T00:00:00+09:00');

  /*
   * 会員特典の外部向け共通メッセージ。非会員／メール不一致／利用月不一致／台帳エラーを細かく出し分けず、
   * 任意のメールアドレスの会員有無を推測できないようにする（Issue #478）。内訳はLoggerにも出さない。
   */
  var MEMBER_BENEFIT_DENIED_CODE = 'MEMBER_BENEFIT_NOT_AVAILABLE';
  var MEMBER_BENEFIT_DENIED_MESSAGE = 'この特典は、ご利用日がお支払い済みの有効期間に入るSNB MEMBER会員資格を確認できた場合のみご利用いただけます。会員資格をご確認のうえ、改めてお申し込みください。';

  /*
   * V2予約（Issue #548。SNB / SNB mensの2026/12/1 0:00 JST以降に作成する直接予約）の会員機能に必要なメールOTP確認の外部向けエラー。
   * 確認済み証明が無い場合（VERIFICATION_REQUIRED）と、あったが期限切れ・不正・メール不一致の場合（REVERIFY_REQUIRED）を分ける。
   * どちらも会員台帳の内容（会員か否か）には一切触れない。会員利用中の予約を黙って一般料金へ降格しないための再確認要求。
   */
  var BOOKING_VERIFICATION_REQUIRED_CODE = 'MEMBER_VERIFICATION_REQUIRED';
  var BOOKING_VERIFICATION_REQUIRED_MESSAGE = '会員料金・会員特典・先行予約をご利用いただくには、メールアドレスの確認コードによる会員確認が必要です。確認コードを送信して確認してください。';
  var BOOKING_REVERIFY_REQUIRED_CODE = 'MEMBER_REVERIFY_REQUIRED';
  var BOOKING_REVERIFY_REQUIRED_MESSAGE = '会員確認の有効期限が切れました。会員料金・会員特典を利用する場合は、確認コードを再送してもう一度確認してください。';

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

  /* 実在する 'YYYY-MM-DD'（JSTの暦日）か。 */
  function isDateString(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && addDaysToDateString(value, 0) === value;
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


  /* Unix秒 → JSTの日付 'YYYY-MM-DD'。不正値は空文字。 */
  function jstDateStringOfEpochSeconds(seconds) {
    var value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    var shifted = new Date(value * 1000 + JST_OFFSET_MS_);
    return shifted.getUTCFullYear() + '-' + pad2_(shifted.getUTCMonth() + 1) + '-' + pad2_(shifted.getUTCDate());
  }

  /* 'YYYY-MM-DD' の n日後 'YYYY-MM-DD'（nは負も可）。形式不正は空文字。 */
  function addDaysToDateString(dateString, days) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateString || '');
    if (!m) return '';
    var ms = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)) + Number(days) * 86400000;
    var d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
  }

  /*
   * 支払済みPeriod（Stripeのperiod.start / period.end。Unix秒）→ 会員有効日の範囲（JSTの日付。両端を含む）。
   * 例: 10/26 22:40 JST 〜 11/26 22:40 JST → 10/26 〜 11/25（更新日の前日まで）。
   * 終了が開始と同じ日以前になる極端に短い期間でも、開始日1日は有効とする。判定不能は null。
   */
  function periodToValidDateRange(startSeconds, endSeconds) {
    var startDate = jstDateStringOfEpochSeconds(startSeconds);
    var endExclusive = jstDateStringOfEpochSeconds(endSeconds);
    if (!startDate || !endExclusive) return null;
    var endDate = addDaysToDateString(endExclusive, -1);
    if (endDate < startDate) endDate = startDate;
    return { startDate: startDate, endDate: endDate };
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
   * 入会時刻から求めた、次回請求（現在の請求期間の終了）の期待値。入会直後の処理なら入会時のアンカー
   * （プレスタートは12/1 00:00 UTC）。復旧が後日でアンカー経過後なら、その時点の次の月初 00:00 UTC。
   */
  function expectedRenewalEndSeconds(joinEpochSeconds, nowSeconds) {
    var anchor = renewalAnchorSecondsForJoin(joinEpochSeconds);
    if (anchor > nowSeconds) return anchor;
    var now = new Date(nowSeconds * 1000);
    return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) / 1000);
  }

  /*
   * 既存subscriptionをSNB MEMBERの自動更新として採用してよいかの検証（Issue #528）。
   * 採用すると呼び出し元は作成をスキップして入会完了にするため、12/1から毎月500円で更新できる
   * 状態であることを確認する。戻り値は不一致項目名の配列（空なら採用可。IDや個人情報は含めない）。
   */
  function existingSubscriptionProblems(subscription, productId, nowSeconds, joinEpochSeconds) {
    var problems = [];
    var sub = subscription && typeof subscription === 'object' ? subscription : {};
    if (['active', 'trialing'].indexOf(sub.status) === -1) problems.push('status');
    if (!sub.metadata || sub.metadata.orderType !== METADATA_ORDER_TYPE) problems.push('orderType');
    if (sub.cancel_at_period_end || sub.cancel_at) problems.push('cancel_scheduled');
    if (sub.pause_collection) problems.push('paused');
    var items = sub.items && Array.isArray(sub.items.data) ? sub.items.data : [];
    var item = items.length === 1 ? items[0] : null;
    if (!item) {
      problems.push('items');
    } else {
      var price = item.price || {};
      var recurring = price.recurring || {};
      var itemProduct = price.product && typeof price.product === 'object' ? price.product.id : price.product;
      if (Number(item.quantity === undefined ? 1 : item.quantity) !== 1) problems.push('quantity');
      if (Number(price.unit_amount) !== MONTHLY_FEE_JPY) problems.push('amount');
      if (String(price.currency || '').toUpperCase() !== CURRENCY) problems.push('currency');
      if (recurring.interval !== 'month' || Number(recurring.interval_count === undefined ? 1 : recurring.interval_count) !== 1) problems.push('interval');
      if (!productId || itemProduct !== productId) problems.push('product');
    }
    if (sub.collection_method !== 'charge_automatically') problems.push('collection_method');
    var end = readSubscriptionPeriod(sub).end;
    if (!end || end <= nowSeconds) {
      problems.push('next_billing');
    } else if (end !== expectedRenewalEndSeconds(joinEpochSeconds, nowSeconds)) {
      problems.push('billing_anchor');
    }
    return problems;
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
   * 会費invoice（billing_reason=subscription_create / subscription_cycle・500円・JPY・支払済み）から、
   * 支払われた「有効期間」（Issue #532）を決める。invoice自体のperiod_start/endは旧API versionでは
   * 「直前の期間」を指すため使わず、500円のline itemのperiod.start / period.endを使う。
   * - 他のbilling_reason、および旧方式（プレスタート会員）のsubscription作成時の$0 invoiceは ignorable
   *   （Periodを作らない。エラーにもしない）。
   * - 判定できない・想定外（金額・通貨・期間）はfail-closedに ok:false を返し、Periodを作らない。
   * 戻り値: { ok: true, billingReason, periodStartSeconds, periodEndSeconds, range: {startDate,endDate} } |
   *         { ok: false, code, ignorable? }
   */
  function resolvePaidPeriodOfInvoice(invoice) {
    if (!invoice || typeof invoice !== 'object') return { ok: false, code: 'INVALID_INVOICE' };
    var reason = invoice.billing_reason;
    if (reason !== 'subscription_create' && reason !== 'subscription_cycle') {
      return { ok: false, code: 'NOT_MEMBERSHIP_PERIOD', ignorable: true };
    }
    if (invoice.status !== 'paid') return { ok: false, code: 'NOT_PAID' };
    if (reason === 'subscription_create' && Number(invoice.amount_paid) === 0) {
      return { ok: false, code: 'ZERO_AMOUNT_CREATE', ignorable: true };
    }
    if (Number(invoice.amount_paid) !== MONTHLY_FEE_JPY || String(invoice.currency || '').toUpperCase() !== CURRENCY) {
      return { ok: false, code: 'UNEXPECTED_AMOUNT' };
    }
    var lines = (invoice.lines && invoice.lines.data) || [];
    var line = null;
    for (var i = 0; i < lines.length; i++) {
      var p = lines[i] && lines[i].period;
      if (Number(lines[i].amount) === MONTHLY_FEE_JPY && p && Number(p.start) > 0 && Number(p.end) > Number(p.start)) {
        line = lines[i];
        break;
      }
    }
    if (!line) return { ok: false, code: 'NO_MONTHLY_LINE' };
    var range = periodToValidDateRange(line.period.start, line.period.end);
    if (!range) return { ok: false, code: 'INVALID_PERIOD' };
    return {
      ok: true,
      billingReason: reason,
      periodStartSeconds: Number(line.period.start),
      periodEndSeconds: Number(line.period.end),
      range: range
    };
  }

  /*
   * 入会Checkout（mode=subscription）の完了時に、初回invoice（billing_reason=subscription_create）から
   * 初回の支払済み期間を確定する（Issue #535）。invoice.paidが届かない・処理されない場合でも、初回の資格を
   * Checkout完了の経路で記録するために使う。invoice.paidと同じ根拠（同じinvoice・同じline item期間）で判定し、
   * 記録時のsourceはどちらも(invoice, invoice ID)とするため、どちらが先に処理されても1行に収束する。
   * - 初回invoiceでない（subscription_cycle等）・別Subscriptionのinvoice・未払い（status!=paid）・
   *   金額/通貨/期間が想定外はすべて ok:false（Periodを作らない。fail-closed）。
   * - Subscriptionが incomplete / incomplete_expired の場合も作らない。
   * 戻り値: { ok: true, invoiceId, periodStartSeconds, periodEndSeconds, paidAtSeconds, range } | { ok: false, code }
   */
  function resolveInitialPeriodOfSubscriptionJoin(invoice, subscription) {
    if (!invoice || typeof invoice !== 'object' || typeof invoice.id !== 'string' || !invoice.id) {
      return { ok: false, code: 'INVALID_INVOICE' };
    }
    if (!subscription || typeof subscription !== 'object' || typeof subscription.id !== 'string' || !subscription.id) {
      return { ok: false, code: 'INVALID_SUBSCRIPTION' };
    }
    if (subscription.status === 'incomplete' || subscription.status === 'incomplete_expired') {
      return { ok: false, code: 'SUBSCRIPTION_INCOMPLETE' };
    }
    if (invoice.billing_reason !== 'subscription_create') return { ok: false, code: 'NOT_INITIAL_INVOICE' };
    if (readInvoiceSubscription(invoice).subscriptionId !== subscription.id) return { ok: false, code: 'SUBSCRIPTION_MISMATCH' };
    var paid = resolvePaidPeriodOfInvoice(invoice);
    if (!paid.ok) return { ok: false, code: paid.code };
    var paidAt = Number(invoice.status_transitions && invoice.status_transitions.paid_at);
    return {
      ok: true,
      invoiceId: invoice.id,
      periodStartSeconds: paid.periodStartSeconds,
      periodEndSeconds: paid.periodEndSeconds,
      paidAtSeconds: Number.isFinite(paidAt) && paidAt > 0 ? paidAt : null,
      range: paid.range
    };
  }

  /*
   * 入会（決済成功）時刻から、初回500円でカバーする利用月（支払い事実を作る月）を決める（Issue #490）。
   * プレスタート期間（2026/10/26 JST〜11/30）は入会月〜プレスタート最終月（2026-11）まで。それ以外は入会月のみ。
   * 戻り値: 'YYYY-MM'の配列（昇順）。判定不能は空配列。
   */
  function coveredMonthsForJoin(joinEpochSeconds) {
    var joinMonth = jstMonthKeyOfEpochSeconds(joinEpochSeconds);
    if (!joinMonth) return [];
    var months = [joinMonth];
    var joinMs = Number(joinEpochSeconds) * 1000;
    if (joinMs >= PRESTART_START_MS_) {
      var m = nextMonthKey(joinMonth);
      while (m && m <= PRESTART_LAST_MONTH_) {
        months.push(m);
        m = nextMonthKey(m);
      }
    }
    return months;
  }

  /* 入会（決済成功）時刻がプレスタート期間（2026/10/26 JST〜11/30）か。 */
  function isPrestartJoin(joinEpochSeconds) {
    var joinMonth = jstMonthKeyOfEpochSeconds(joinEpochSeconds);
    return !!joinMonth && Number(joinEpochSeconds) * 1000 >= PRESTART_START_MS_ && joinMonth <= PRESTART_LAST_MONTH_;
  }

  /* 初回500円で有効な最終月の翌月1日 00:00 UTC。subscriptionのbilling_cycle_anchor。 */
  function renewalAnchorSecondsForJoin(joinEpochSeconds) {
    var months = coveredMonthsForJoin(joinEpochSeconds);
    return months.length ? renewalAnchorSecondsAfterMonth(months[months.length - 1]) : 0;
  }

  /*
   * 会員資格確認UI（Issue #490）用の純粋ロジック。外部へ返す表示用の値だけを作る
   * （Stripe ID・台帳内部IDは一切含めない）。
   */

  /* メールアドレスのマスク表示。例: taro@example.com → t***@e***.com。不正値は空文字。 */
  function maskEmail(value) {
    var email = normalizeEmail(value);
    var at = email.lastIndexOf('@');
    if (at < 1 || at === email.length - 1) return '';
    var local = email.substring(0, at);
    var domain = email.substring(at + 1);
    var dot = domain.lastIndexOf('.');
    var host = dot > 0 ? domain.substring(0, dot) : domain;
    var tld = dot > 0 ? domain.substring(dot) : '';
    return local.charAt(0) + '***@' + host.charAt(0) + '***' + tld;
  }

  /* 'YYYY-MM'の末日 'YYYY-MM-DD'。不正値は空文字。 */
  function lastDateOfMonth(monthKey) {
    var m = /^(\d{4})-(\d{2})$/.exec(monthKey || '');
    if (!m) return '';
    var day = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10), 0)).getUTCDate();
    return monthKey + '-' + pad2_(day);
  }

  /* 利用者向けの特典表（表示順固定）。availableFromBenefitsStart=trueは2026/12/1開始の本特典。 */
  var STATUS_BENEFITS_ = [
    { key: 'advance_booking_90', label: '90日先行予約', fromBenefitsStart: false },
    { key: 'pair_pack', label: '2名ペアパック（SNB / SNB mens）', fromBenefitsStart: true },
    { key: 'shower', label: 'シャワー（SNB / SNB mens）', fromBenefitsStart: true },
    { key: 'studio_x_options', label: 'Studio X 会員限定の有料オプション', fromBenefitsStart: true }
  ];

  /*
   * 有効日範囲（両端を含む 'YYYY-MM-DD'）の集合から、基準日（JST）を含む連続した範囲の末日を返す。
   * 翌日から始まる範囲は連続とみなして延長する（更新が途切れず続いている場合の「有効期限」）。含まなければ空文字。
   */
  function validUntilOfRanges(ranges, today) {
    var list = (ranges || []).filter(function (r) { return r && r.startDate && r.endDate; })
      .slice().sort(function (a, b) { return a.startDate < b.startDate ? -1 : (a.startDate > b.startDate ? 1 : 0); });
    var end = '';
    for (var i = 0; i < list.length; i++) {
      if (!end) {
        if (list[i].startDate <= today && today <= list[i].endDate) end = list[i].endDate;
      } else if (list[i].startDate <= addDaysToDateString(end, 1) && list[i].endDate > end) {
        end = list[i].endDate;
      }
    }
    return end;
  }

  /*
   * 会員資格確認の表示内容（Issue #532で、支払済みPeriod＋旧暦月の合算へ変更）。
   * facts: { periods: [{ startDate, endDate }]（MemberPeriods由来。有効日範囲・両端を含むJST日付）,
   *          paidMonths: ['YYYY-MM', ...]（旧MemberMonths由来。暦月まるごと）, autoRenew: boolean }
   * options: { permanent: boolean, nowMs: number }
   * 永久会員は支払い事実が無くても通常の有効会員と同じ形で表示する（永久会員であること自体は返さない）。
   * - 有効期限: 基準日（JSTの今日）を含む連続範囲の末日。新方式は最新Periodのperiod.endの前日、旧方式のみなら月末日。
   * - 次回更新日: 自動更新が続く（subscription有効かつcancel_at_period_endでない）場合のみ、有効期限の翌日
   *   （＝新方式は最新Periodのperiod.endの日付、旧1日anchor会員は翌月1日）。解約予約済みはnull。
   * 戻り値は公開API用のプレーンなオブジェクト（IDを含まない）。
   */
  function describeMembershipStatus(email, facts, options) {
    var opts = options || {};
    var nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
    var nowSeconds = Math.floor(nowMs / 1000);
    var today = jstDateStringOfEpochSeconds(nowSeconds);
    var currentMonth = jstMonthKeyOfEpochSeconds(nowSeconds);
    var ranges = ((facts && facts.periods) || []).slice();
    ((facts && facts.paidMonths) || []).forEach(function (m) {
      if (/^\d{4}-\d{2}$/.test(m)) ranges.push({ startDate: m + '-01', endDate: lastDateOfMonth(m) });
    });
    var autoRenew = !!(facts && facts.autoRenew);
    if (opts.permanent && currentMonth) {
      ranges.push({ startDate: currentMonth + '-01', endDate: lastDateOfMonth(currentMonth) });
      autoRenew = true;
    }

    var validUntil = today ? validUntilOfRanges(ranges, today) : '';
    var active = !!validUntil;
    var result = {
      active: active,
      maskedEmail: maskEmail(email),
      monthlyFeeJpy: MONTHLY_FEE_JPY,
      validUntil: null,
      nextRenewalDate: null,
      autoRenew: false,
      benefits: []
    };
    if (!active) return result;

    result.validUntil = validUntil;
    result.autoRenew = autoRenew;
    result.nextRenewalDate = autoRenew ? addDaysToDateString(validUntil, 1) : null;

    var benefitsOpen = nowMs >= BENEFITS_START_MS_;
    result.benefits = STATUS_BENEFITS_.map(function (b) {
      var available = !b.fromBenefitsStart || benefitsOpen;
      return { key: b.key, label: b.label, available: available, startsOn: available ? null : '2026-12-01' };
    });
    return result;
  }

  /* 作成時刻（Date|ms）が会員特典の新ルール（2026/12/1 JST以降）の対象か。不正値は旧ルール側（grandfather）。 */
  function isBenefitsRuleActive(createdAt) {
    var ms = createdAt && typeof createdAt.getTime === 'function' ? createdAt.getTime() : Number(createdAt);
    return Number.isFinite(ms) && ms >= BENEFITS_START_MS_;
  }

  /*
   * 実会員資格（actual membership）の判定。正本は会員台帳（MemberRepository.isMemberOnDate＝指定日（JST）が
   * 支払済みPeriod（MemberPeriods）の有効日範囲、旧MemberMonthsの支払済み暦月、または永久会員に入るか。Issue #532）。
   * priceIsMember・mens経路・価格overrideは一切見ない。Subscriptionのstatus等は資格の直接の正本にしない。
   * メール・日付が不正、台帳を読めない（例外）場合はすべて資格なし（fail-closed）。
   * 戻り値: { ok: true } | { ok: false, reason: 'INVALID_INPUT'|'NOT_MEMBER'|'LEDGER_ERROR' }。
   * reasonは内部判定用。利用者・外部向けにはMEMBER_BENEFIT_DENIED_*だけを返す（列挙対策）。
   */
  function verifyActualMembership(email, dateString) {
    var normalized = normalizeEmail(email);
    if (!normalized || !isDateString(dateString)) return { ok: false, reason: 'INVALID_INPUT' };
    try {
      return MemberRepository.isMemberOnDate(normalized, dateString) === true ? { ok: true } : { ok: false, reason: 'NOT_MEMBER' };
    } catch (lookupError) {
      return { ok: false, reason: 'LEDGER_ERROR' };
    }
  }

  /*
   * 永久会員（Issue #480）か。判定の正本は BookingConfig.getPermanentMemberEmails（サーバー側のみ）。
   * 各機能へメールを直書きせず、MemberRepository.isMemberOnDate経由で全特典に効く。
   * 設定を読めない場合は永久会員扱いにしない（通常の台帳判定へ進む）。
   */
  function isPermanentMember(email) {
    var normalized = normalizeEmail(email);
    if (!normalized) return false;
    try {
      return BookingConfig.getPermanentMemberEmails().indexOf(normalized) !== -1;
    } catch (configError) {
      return false;
    }
  }

  /*
   * 90日先行予約の資格（Issue #480）。利用日の月ではなく、**予約作成時点（todayString＝JSTの暦日）の
   * 当月**のactual membershipで判定する（90日前には利用月の会費がまだ無いため）。
   * priceIsMember・mens料金優遇・自己申告isMemberは見ない。台帳を読めない場合はfail-closed。
   * 戻り値: { ok: true } | { ok: false, reason: 'INVALID_INPUT'|'NOT_MEMBER'|'LEDGER_ERROR' }。
   */
  function verifyAdvanceBookingMembership(email, todayString) {
    return verifyActualMembership(email, todayString);
  }

  return {
    BENEFITS_START_MS: BENEFITS_START_MS_,
    MEMBER_BENEFIT_DENIED_CODE: MEMBER_BENEFIT_DENIED_CODE,
    MEMBER_BENEFIT_DENIED_MESSAGE: MEMBER_BENEFIT_DENIED_MESSAGE,
    BOOKING_VERIFICATION_REQUIRED_CODE: BOOKING_VERIFICATION_REQUIRED_CODE,
    BOOKING_VERIFICATION_REQUIRED_MESSAGE: BOOKING_VERIFICATION_REQUIRED_MESSAGE,
    BOOKING_REVERIFY_REQUIRED_CODE: BOOKING_REVERIFY_REQUIRED_CODE,
    BOOKING_REVERIFY_REQUIRED_MESSAGE: BOOKING_REVERIFY_REQUIRED_MESSAGE,
    isBenefitsRuleActive: isBenefitsRuleActive,
    verifyActualMembership: verifyActualMembership,
    verifyAdvanceBookingMembership: verifyAdvanceBookingMembership,
    isPermanentMember: isPermanentMember,
    MONTHLY_FEE_JPY: MONTHLY_FEE_JPY,
    CURRENCY: CURRENCY,
    METADATA_ORDER_TYPE: METADATA_ORDER_TYPE,
    STATUS: STATUS,
    normalizeEmail: normalizeEmail,
    isValidEmail: isValidEmail,
    monthKeyOfDateString: monthKeyOfDateString,
    jstMonthKeyOfEpochSeconds: jstMonthKeyOfEpochSeconds,
    jstDayOfEpochSeconds: jstDayOfEpochSeconds,
    jstDateStringOfEpochSeconds: jstDateStringOfEpochSeconds,
    addDaysToDateString: addDaysToDateString,
    isDateString: isDateString,
    periodToValidDateRange: periodToValidDateRange,
    validUntilOfRanges: validUntilOfRanges,
    nextMonthKey: nextMonthKey,
    renewalAnchorSecondsAfterMonth: renewalAnchorSecondsAfterMonth,
    PRESTART_START_MS: PRESTART_START_MS_,
    isPrestartJoin: isPrestartJoin,
    maskEmail: maskEmail,
    lastDateOfMonth: lastDateOfMonth,
    describeMembershipStatus: describeMembershipStatus,
    coveredMonthsForJoin: coveredMonthsForJoin,
    renewalAnchorSecondsForJoin: renewalAnchorSecondsForJoin,
    mapSubscriptionStatus: mapSubscriptionStatus,
    readSubscriptionPeriod: readSubscriptionPeriod,
    existingSubscriptionProblems: existingSubscriptionProblems,
    readInvoiceSubscription: readInvoiceSubscription,
    resolvePaidPeriodOfInvoice: resolvePaidPeriodOfInvoice,
    resolveInitialPeriodOfSubscriptionJoin: resolveInitialPeriodOfSubscriptionJoin
  };
})();
