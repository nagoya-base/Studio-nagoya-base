/*
 * MemberRepository.gs — SNB MEMBER（Issue #471）の会員台帳。Spreadsheet上の2シートを持つ。
 *
 * - Members: 会員1人（＝Stripe subscription 1本）につき1行。Stripeのsubscription状態の写し
 *   （情報表示・運用確認用）。**資格判定には使わない**。
 *     memberId / email（正規化済み）/ stripeCustomerId / stripeSubscriptionId / status /
 *     currentPeriodStart / currentPeriodEnd / canceledAt / cancelAtPeriodEnd /
 *     latestInvoiceId / latestEventId / latestEventCreated / createdAt / updatedAt
 *   status系の列は、Stripeイベントの発生時刻（latestEventCreated。Unix秒）がこの行の記録より
 *   古いイベントでは更新しない（イベント順序の逆転で新しい状態を巻き戻さない）。
 *   canceledは終端（解約済みsubscriptionは復活しない）のため、後から届いた別状態で上書きしない。
 *   ID類（customer/subscription）は事実なので、順序に関係なく空欄のときだけ埋める。
 * - MemberMonths: 「会員 × 利用月」が支払済みである事実を1行ずつ追記する。資格判定の唯一の
 *   根拠。(memberId, month)で冪等（同じ月を2回記録しない）。追記専用で、更新・削除しない。
 *     memberId / month（YYYYMMの整数・JST。例: 202612）/ sourceType / sourceId / amount / paidAt / eventId / recordedAt
 *
 * 【ロック】書き込み関数（upsertMember・recordPaidMonth）はロックを取らない。呼び出し側が
 * LockService.getScriptLock()を保持した状態で呼ぶこと（StripeWebhookProcessorのrunFenced_経由。
 * Stripe処理権の世代確認と同じロック内で書くため）。読み取り関数は不要（GASのSheets読み取りは
 * 1回の getValues が一貫した断面を返す）。
 *
 * 【会員の存在を外部へ漏らさない】このファイルの関数は内部用で、Web公開APIには直接つながない。
 * 見積りAPI（Code.gsのestimatePrice）はこのファイルを一切呼ばない。唯一の外部経路は予約作成
 * （BookingRepository.createBooking）による料金確定で、そこでも結果は「適用料金」として
 * 予約者本人の予約にのみ反映される（README「SNB MEMBER」節参照）。
 */
'use strict';

var MemberRepository = (function () {
  var MEMBERS_SHEET_ = 'Members';
  var MONTHS_SHEET_ = 'MemberMonths';

  var PENDING_SHEET_ = 'MemberCheckouts';
  var PENDING_HEADERS_ = ['memberId', 'email', 'checkoutSessionId', 'pendingUntil', 'state', 'createdAt', 'updatedAt'];
  var PENDING_STATE = { PENDING: 'PENDING', COMPLETED: 'COMPLETED', EXPIRED: 'EXPIRED' };

  var MEMBER_HEADERS_ = [
    'memberId', 'email', 'stripeCustomerId', 'stripeSubscriptionId', 'status',
    'currentPeriodStart', 'currentPeriodEnd', 'canceledAt', 'cancelAtPeriodEnd',
    'latestInvoiceId', 'latestEventId', 'latestEventCreated', 'createdAt', 'updatedAt'
  ];
  var MONTH_HEADERS_ = ['memberId', 'month', 'sourceType', 'sourceId', 'amount', 'paidAt', 'eventId', 'recordedAt'];

  /*
   * 利用月は'YYYY-MM'のままappendRowすると、Google Sheetsが日付（YYYY年MM月1日）へ自動変換して
   * しまい比較できなくなる。シートにはYYYYMMの整数（202612）で保存し、読み出し時に同じ形へ揃える。
   */
  function monthToCell_(month) {
    return parseInt(String(month).replace('-', ''), 10);
  }

  function getSpreadsheet_() {
    return SpreadsheetApp.openById(BookingConfig.getSpreadsheetId());
  }

  function ensureSheet_(name, headers) {
    var spreadsheet = getSpreadsheet_();
    var sheet = spreadsheet.getSheetByName(name);
    if (!sheet) sheet = spreadsheet.insertSheet(name);
    if (sheet.getLastRow() < 1) sheet.appendRow(headers);
    return sheet;
  }

  function rowToRecord_(headers, row) {
    var record = {};
    headers.forEach(function (header, index) { record[header] = row[index]; });
    return record;
  }

  function recordToRow_(headers, record) {
    return headers.map(function (header) {
      var value = record[header];
      return value === undefined || value === null ? '' : value;
    });
  }

  function readMembers_() {
    var sheet = ensureSheet_(MEMBERS_SHEET_, MEMBER_HEADERS_);
    var values = sheet.getDataRange().getValues();
    var members = [];
    for (var i = 1; i < values.length; i++) {
      members.push({ rowNumber: i + 1, record: rowToRecord_(MEMBER_HEADERS_, values[i]) });
    }
    return { sheet: sheet, members: members };
  }

  function findMember_(members, identity) {
    var keys = [
      ['memberId', identity.memberId],
      ['stripeSubscriptionId', identity.subscriptionId],
      ['stripeCustomerId', identity.customerId]
    ];
    for (var k = 0; k < keys.length; k++) {
      var field = keys[k][0];
      var value = keys[k][1];
      if (!value) continue;
      for (var i = 0; i < members.length; i++) {
        if (members[i].record[field] === value) return members[i];
      }
    }
    return null;
  }

  function findMember(identity) {
    return findMember_(readMembers_().members, identity || {});
  }

  function writeMemberRow_(sheet, rowNumber, record) {
    sheet.getRange(rowNumber, 1, 1, MEMBER_HEADERS_.length).setValues([recordToRow_(MEMBER_HEADERS_, record)]);
  }

  /*
   * 会員行を作成または更新する。ロック保持下で呼ぶこと。
   * identity: { memberId?, subscriptionId?, customerId? }（この順で既存行を探す）
   * fields:
   *   - email, customerId, subscriptionId: 事実。空欄のときだけ埋める（上書きしない）。
   *     ただしemailはcreate時のみ設定する（正規化済みで渡すこと）。
   *   - state: { status, currentPeriodStart, currentPeriodEnd, canceledAt, cancelAtPeriodEnd, invoiceId }
   *     （省略可）。eventCreated以上の新しさのときだけ反映（下記）。
   * event: { id, created }（Unix秒）。stateを反映する順序判定に使う。
   * options.create: trueなら該当行が無いとき新規作成する（false/省略は該当行が無ければ何もしない）。
   * 戻り値: { found, created, stateApplied, memberId, rowNumber }
   */
  function upsertMember(identity, fields, event, options, now) {
    var id = identity || {};
    var f = fields || {};
    var opts = options || {};
    var data = readMembers_();
    var existing = findMember_(data.members, id);
    var timestamp = now instanceof Date ? now : new Date();

    if (!existing) {
      if (!opts.create) return { found: false, created: false, stateApplied: false, memberId: '', rowNumber: 0 };
      var fresh = {
        memberId: id.memberId || f.memberId || '',
        email: f.email || '',
        stripeCustomerId: f.customerId || id.customerId || '',
        stripeSubscriptionId: f.subscriptionId || id.subscriptionId || '',
        status: MembershipRules.STATUS.INCOMPLETE,
        latestEventCreated: 0,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      if (!fresh.memberId) throw new Error('memberIdが必要です。');
      data.sheet.appendRow(recordToRow_(MEMBER_HEADERS_, fresh));
      existing = { rowNumber: data.sheet.getLastRow(), record: fresh };
      var createdResult = applyState_(data.sheet, existing, f.state, event, timestamp);
      return { found: true, created: true, stateApplied: createdResult, memberId: fresh.memberId, rowNumber: existing.rowNumber };
    }

    var record = existing.record;
    var changed = false;
    if (!record.stripeCustomerId && f.customerId) { record.stripeCustomerId = f.customerId; changed = true; }
    if (!record.stripeSubscriptionId && f.subscriptionId) { record.stripeSubscriptionId = f.subscriptionId; changed = true; }
    if (changed) {
      record.updatedAt = timestamp;
      writeMemberRow_(data.sheet, existing.rowNumber, record);
    }
    var applied = applyState_(data.sheet, existing, f.state, event, timestamp);
    return { found: true, created: false, stateApplied: applied, memberId: record.memberId, rowNumber: existing.rowNumber };
  }

  /* 順序判定つきでstate列を反映する。反映したらtrue。 */
  function applyState_(sheet, existing, state, event, now) {
    if (!state || !event) return false;
    var record = existing.record;
    var eventCreated = Number(event.created);
    if (!Number.isFinite(eventCreated)) return false;
    var storedCreated = Number(record.latestEventCreated) || 0;
    if (eventCreated < storedCreated) return false;
    if (record.status === MembershipRules.STATUS.CANCELED) return false;
    if (record.latestEventId && record.latestEventId === event.id) return false;

    record.status = state.status || record.status;
    if (state.currentPeriodStart !== undefined && state.currentPeriodStart !== null) record.currentPeriodStart = state.currentPeriodStart;
    if (state.currentPeriodEnd !== undefined && state.currentPeriodEnd !== null) record.currentPeriodEnd = state.currentPeriodEnd;
    if (state.canceledAt !== undefined) record.canceledAt = state.canceledAt === null ? '' : state.canceledAt;
    if (state.cancelAtPeriodEnd !== undefined) record.cancelAtPeriodEnd = state.cancelAtPeriodEnd ? 'TRUE' : '';
    if (state.invoiceId) record.latestInvoiceId = state.invoiceId;
    if (state.email && !record.email) record.email = state.email;
    record.latestEventId = event.id || record.latestEventId;
    record.latestEventCreated = eventCreated;
    record.updatedAt = now;
    writeMemberRow_(sheet, existing.rowNumber, record);
    return true;
  }

  /*
   * 「会員 × 利用月」の支払い事実を追記する。ロック保持下で呼ぶこと。
   * (memberId, month)が既にあれば何もしない（冪等。重複Webhook・イベント順序逆転・再処理でも1行）。
   * entry: { memberId, month('YYYY-MM'), sourceType, sourceId, amount, paidAt, eventId }
   * 戻り値: { recorded: boolean }
   */
  function recordPaidMonth(entry, now) {
    if (!entry || !entry.memberId || !/^\d{4}-\d{2}$/.test(entry.month || '')) {
      throw new Error('memberIdとmonth（YYYY-MM）が必要です。');
    }
    var sheet = ensureSheet_(MONTHS_SHEET_, MONTH_HEADERS_);
    var values = sheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === entry.memberId && Number(values[i][1]) === monthToCell_(entry.month)) return { recorded: false };
    }
    sheet.appendRow(recordToRow_(MONTH_HEADERS_, {
      memberId: entry.memberId,
      month: monthToCell_(entry.month),
      sourceType: entry.sourceType || '',
      sourceId: entry.sourceId || '',
      amount: entry.amount,
      paidAt: entry.paidAt || '',
      eventId: entry.eventId || '',
      recordedAt: now instanceof Date ? now : new Date()
    }));
    return { recorded: true };
  }

  /*
   * 指定メールアドレスが、指定の利用月（'YYYY-MM'）にSNB MEMBERの資格を持つか。
   * 支払い事実（MemberMonths）だけで判定する。メール・月が不正、シートが読めない等、
   * 判定できない場合はすべてfalse（fail-closed。一般料金側）。例外は握りつぶさず呼び出し側で捕捉する想定だが、
   * ここでも不正入力ではfalseを返す。
   */
  function isMemberForMonth(email, monthKey) {
    var normalized = MembershipRules.normalizeEmail(email);
    if (!normalized || !/^\d{4}-\d{2}$/.test(monthKey || '')) return false;

    /* 永久会員（Issue #480）: 対象年月・Stripe支払い有無に関係なく常に会員。台帳は読まない・書かない。 */
    if (MembershipRules.isPermanentMember(normalized)) return true;

    var memberIds = {};
    readMembers_().members.forEach(function (m) {
      if (m.record.email === normalized && m.record.memberId) memberIds[m.record.memberId] = true;
    });
    if (Object.keys(memberIds).length === 0) return false;

    var monthsSheet = ensureSheet_(MONTHS_SHEET_, MONTH_HEADERS_);
    var values = monthsSheet.getDataRange().getValues();
    for (var i = 1; i < values.length; i++) {
      if (memberIds[values[i][0]] && Number(values[i][1]) === monthToCell_(monthKey)) return true;
    }
    return false;
  }

  /*
   * 二重加入の防止用（Issue #471レビュー対応）。同じメールアドレスに、有効な会員が既にいるか。
   * 「有効」＝subscriptionが有効（status=active。解約予約中も期間末までは有効）、または指定の月
   * （'YYYY-MM'）の支払い事実がある会員。excludeMemberIdは、同じ入会の再送・再試行で自分自身を
   * 重複と誤判定しないために除外する会員ID。該当する会員の行を返す（無ければnull）。
   * メールが不正なときもnull（呼び出し側は新規扱い）。
   */
  function findLiveMemberByEmail(email, monthKey, excludeMemberId) {
    var normalized = MembershipRules.normalizeEmail(email);
    if (!normalized) return null;
    var matches = readMembers_().members.filter(function (m) {
      return m.record.email === normalized && m.record.memberId && m.record.memberId !== excludeMemberId;
    });
    if (matches.length === 0) return null;
    for (var i = 0; i < matches.length; i++) {
      if (matches[i].record.status === MembershipRules.STATUS.ACTIVE) return matches[i];
    }
    if (!/^\d{4}-\d{2}$/.test(monthKey || '')) return null;
    var values = ensureSheet_(MONTHS_SHEET_, MONTH_HEADERS_).getDataRange().getValues();
    for (var j = 1; j < values.length; j++) {
      if (Number(values[j][1]) !== monthToCell_(monthKey)) continue;
      for (var k = 0; k < matches.length; k++) {
        if (matches[k].record.memberId === values[j][0]) return matches[k];
      }
    }
    return null;
  }

  /*
   * 保留中の入会Checkout台帳（MemberCheckouts。二重課金防止の正本。CacheServiceは使わない）。
   * 1行＝発行した入会Checkout 1本: memberId / email（正規化済み）/ checkoutSessionId /
   * pendingUntil（Checkoutの失効時刻＋Webhook反映の猶予。この時刻まで同じメールへ新しいCheckoutを
   * 発行しない）/ state（PENDING・COMPLETED＝決済完了Webhookを処理済み・EXPIRED＝発行失敗で解放）。
   * 失効はpendingUntilの経過で判定する（行を書き換えなくてもよい）。ロック保持下で呼ぶこと。
   */
  function readPending_() {
    var sheet = ensureSheet_(PENDING_SHEET_, PENDING_HEADERS_);
    var values = sheet.getDataRange().getValues();
    var rows = [];
    for (var i = 1; i < values.length; i++) rows.push({ rowNumber: i + 1, record: rowToRecord_(PENDING_HEADERS_, values[i]) });
    return { sheet: sheet, rows: rows };
  }

  function toMillis_(value) {
    if (value && typeof value.getTime === 'function') return value.getTime();
    var parsed = new Date(value).getTime();
    return isNaN(parsed) ? NaN : parsed;
  }

  /* 有効な（state=PENDINGかつpendingUntil未経過の）保留中Checkoutがあれば、その行を返す。無ければnull。 */
  function findActivePending(email, now) {
    var normalized = MembershipRules.normalizeEmail(email);
    if (!normalized) return null;
    var nowMs = toMillis_(now);
    var rows = readPending_().rows;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].record;
      if (r.email === normalized && r.state === PENDING_STATE.PENDING && toMillis_(r.pendingUntil) > nowMs) return rows[i];
    }
    return null;
  }

  function addPending(entry, now) {
    var sheet = ensureSheet_(PENDING_SHEET_, PENDING_HEADERS_);
    sheet.appendRow(recordToRow_(PENDING_HEADERS_, {
      memberId: entry.memberId, email: MembershipRules.normalizeEmail(entry.email), checkoutSessionId: entry.checkoutSessionId || '',
      pendingUntil: entry.pendingUntil, state: PENDING_STATE.PENDING, createdAt: now, updatedAt: now
    }));
  }

  /* memberIdの行のstate（と、指定があればcheckoutSessionId）を更新する。無ければ何もしない（false）。 */
  function updatePending(memberId, fields, now) {
    var data = readPending_();
    for (var i = 0; i < data.rows.length; i++) {
      if (data.rows[i].record.memberId !== memberId) continue;
      var record = data.rows[i].record;
      if (fields.state) record.state = fields.state;
      if (fields.checkoutSessionId) record.checkoutSessionId = fields.checkoutSessionId;
      record.updatedAt = now;
      data.sheet.getRange(data.rows[i].rowNumber, 1, 1, PENDING_HEADERS_.length).setValues([recordToRow_(PENDING_HEADERS_, record)]);
      return true;
    }
    return false;
  }

  /*
   * 会員資格確認（Issue #490）用の事実。メール1件に対し、支払い事実のある利用月（'YYYY-MM'）と、
   * 自動更新が続く見込みか（statusがactiveでcancelAtPeriodEndでない会員行がある）を返す。
   * 内部ID・Stripe IDは返さない。台帳を読めない場合は例外（呼び出し側でfail-closed）。
   */
  function statusFactsForEmail(email) {
    var normalized = MembershipRules.normalizeEmail(email);
    var facts = { paidMonths: [], autoRenew: false };
    if (!normalized) return facts;
    var ids = {};
    readMembers_().members.forEach(function (m) {
      if (m.record.email !== normalized || !m.record.memberId) return;
      ids[m.record.memberId] = true;
      if (m.record.status === MembershipRules.STATUS.ACTIVE && !m.record.cancelAtPeriodEnd) facts.autoRenew = true;
    });
    if (Object.keys(ids).length === 0) return facts;
    var values = ensureSheet_(MONTHS_SHEET_, MONTH_HEADERS_).getDataRange().getValues();
    var seen = {};
    for (var i = 1; i < values.length; i++) {
      if (!ids[values[i][0]]) continue;
      var cell = String(values[i][1]);
      if (!/^\d{6}$/.test(cell)) continue;
      var key = cell.substring(0, 4) + '-' + cell.substring(4);
      if (!seen[key]) { seen[key] = true; facts.paidMonths.push(key); }
    }
    return facts;
  }

  /*
   * 会員資格確認のワンタイムトークン台帳（MemberStatusTokens）。トークン本体は保存せず、ハッシュのみ持つ。
   * 1行＝発行1本: tokenHash / email（正規化済み）/ expiresAt / usedAt / createdAt。ロック保持下で呼ぶこと。
   */
  var TOKEN_SHEET_ = 'MemberStatusTokens';
  var TOKEN_HEADERS_ = ['tokenHash', 'email', 'expiresAt', 'usedAt', 'createdAt'];

  function addStatusToken(entry, now) {
    var sheet = ensureSheet_(TOKEN_SHEET_, TOKEN_HEADERS_);
    sheet.appendRow(recordToRow_(TOKEN_HEADERS_, {
      tokenHash: entry.tokenHash, email: MembershipRules.normalizeEmail(entry.email),
      expiresAt: entry.expiresAt, usedAt: '', createdAt: now
    }));
  }

  /* 未使用・未失効のトークン行を返す（無ければnull）。{ rowNumber, email }。 */
  function findUsableStatusToken(tokenHash, now) {
    if (!tokenHash) return null;
    var sheet = ensureSheet_(TOKEN_SHEET_, TOKEN_HEADERS_);
    var values = sheet.getDataRange().getValues();
    var nowMs = toMillis_(now);
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(TOKEN_HEADERS_, values[i]);
      if (record.tokenHash !== tokenHash) continue;
      if (record.usedAt) return null;
      if (!(toMillis_(record.expiresAt) > nowMs)) return null;
      return { rowNumber: i + 1, email: record.email };
    }
    return null;
  }

  function markStatusTokenUsed(rowNumber, now) {
    var sheet = ensureSheet_(TOKEN_SHEET_, TOKEN_HEADERS_);
    sheet.getRange(rowNumber, TOKEN_HEADERS_.indexOf('usedAt') + 1, 1, 1).setValues([[now]]);
  }

  /*
   * 解約（Issue #506）の対象会員。メール1件に対し、subscriptionが有効（status=active）で、subscription IDを持つ
   * 会員行を返す（無ければnull）。**内部用**で、返す行（Stripe ID）を公開APIへ出さない。
   * 戻り値: { rowNumber, memberId, subscriptionId, cancelAtPeriodEnd }。台帳を読めない場合は例外。
   */
  function findCancelTargetForEmail(email) {
    var normalized = MembershipRules.normalizeEmail(email);
    if (!normalized) return null;
    var found = null;
    readMembers_().members.forEach(function (m) {
      var r = m.record;
      if (found || r.email !== normalized || !r.memberId || !r.stripeSubscriptionId) return;
      if (r.status !== MembershipRules.STATUS.ACTIVE) return;
      found = { rowNumber: m.rowNumber, memberId: r.memberId, subscriptionId: r.stripeSubscriptionId, cancelAtPeriodEnd: !!r.cancelAtPeriodEnd };
    });
    return found;
  }

  /*
   * 解約受付後、表示用のcancelAtPeriodEndだけを先に立てる。ロック保持下で呼ぶ。latestEventCreated等の
   * イベント順序列は変えない（後続の customer.subscription.updated Webhook が正本として上書きできる）。
   */
  function markCancelRequested(memberId, now) {
    var data = readMembers_();
    for (var i = 0; i < data.members.length; i++) {
      var record = data.members[i].record;
      if (record.memberId !== memberId) continue;
      if (record.status === MembershipRules.STATUS.CANCELED) return false;
      record.cancelAtPeriodEnd = 'TRUE';
      record.updatedAt = now instanceof Date ? now : new Date();
      writeMemberRow_(data.sheet, data.members[i].rowNumber, record);
      return true;
    }
    return false;
  }

  /* トークン行を使用済みかどうかにかかわらず返す（無ければnull）。{ rowNumber, email, used, expired }。 */
  function findStatusTokenAnyState(tokenHash, now) {
    if (!tokenHash) return null;
    var values = ensureSheet_(TOKEN_SHEET_, TOKEN_HEADERS_).getDataRange().getValues();
    var nowMs = toMillis_(now);
    for (var i = 1; i < values.length; i++) {
      var record = rowToRecord_(TOKEN_HEADERS_, values[i]);
      if (record.tokenHash !== tokenHash) continue;
      return { rowNumber: i + 1, email: record.email, used: !!record.usedAt, expired: !(toMillis_(record.expiresAt) > nowMs) };
    }
    return null;
  }

  return {
    findCancelTargetForEmail: findCancelTargetForEmail,
    markCancelRequested: markCancelRequested,
    findStatusTokenAnyState: findStatusTokenAnyState,
    statusFactsForEmail: statusFactsForEmail,
    addStatusToken: addStatusToken,
    findUsableStatusToken: findUsableStatusToken,
    markStatusTokenUsed: markStatusTokenUsed,
    TOKEN_HEADERS: TOKEN_HEADERS_,
    PENDING_STATE: PENDING_STATE,
    PENDING_HEADERS: PENDING_HEADERS_,
    findActivePending: findActivePending,
    addPending: addPending,
    updatePending: updatePending,
    findLiveMemberByEmail: findLiveMemberByEmail,
    MEMBER_HEADERS: MEMBER_HEADERS_,
    MONTH_HEADERS: MONTH_HEADERS_,
    findMember: findMember,
    upsertMember: upsertMember,
    recordPaidMonth: recordPaidMonth,
    isMemberForMonth: isMemberForMonth
  };
})();
