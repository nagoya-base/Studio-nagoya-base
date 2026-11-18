/*
 * OpsQuery.gs — 一覧の絞り込み・並び順・表示項目の射影（Issue #936）。純粋関数のみ。
 *
 * 期間の既定: 今日以降30日間（JST。今日を含む30日）。scope='past' は直近過去30日（昨日まで）。
 * 並び順: 今後は利用開始日時の昇順、過去は降順。同時刻は終了日時→予約IDで安定化。
 * キャンセル・失効も削除せず、状態を明示して返す（絞り込みはstatusで行う）。
 */
'use strict';

var OpsQuery = (function () {
  var STATUS_FILTERS = ['all', 'PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED', 'UNKNOWN'];

  function fail_(message) { return { error: message }; }

  function isOneOf_(value, list) { return list.indexOf(value) !== -1; }

  /* params → 正規化済み条件。不正値は黙って既定値へ丸めずエラーにする。 */
  function resolve(params, todayJst) {
    var p = params || {};
    var scope = p.scope === undefined || p.scope === '' ? 'upcoming' : p.scope;
    if (!isOneOf_(scope, ['upcoming', 'past'])) return fail_('scope');
    var service = p.service === undefined || p.service === '' ? 'all' : p.service;
    if (service !== 'all' && !OpsContract.serviceById(service)) return fail_('service');
    var status = p.status === undefined || p.status === '' ? 'all' : p.status;
    if (!isOneOf_(status, STATUS_FILTERS)) return fail_('status');

    var from, to;
    var hasFrom = p.from !== undefined && p.from !== '';
    var hasTo = p.to !== undefined && p.to !== '';
    if (hasFrom && OpsContract.parseJstDate(p.from) === null) return fail_('from');
    if (hasTo && OpsContract.parseJstDate(p.to) === null) return fail_('to');
    var span = OpsContract.DEFAULT_RANGE_DAYS - 1;
    if (scope === 'past') {
      to = hasTo ? p.to : OpsContract.addDays(todayJst, -1);
      from = hasFrom ? p.from : OpsContract.addDays(to, -span);
    } else {
      from = hasFrom ? p.from : todayJst;
      to = hasTo ? p.to : OpsContract.addDays(from, span);
    }
    if (from > to) return fail_('range');
    return { value: { scope: scope, service: service, status: status, from: from, to: to, order: scope === 'past' ? 'desc' : 'asc' } };
  }

  /*
   * 期間の定義（JST）: 始端 = from の 0:00（含む）、終端 = to の翌日 0:00（含まない）。
   * 予約の時間帯 [開始, 終了) が期間と重なれば対象にする。したがって
   * - 日付またぎ（前日夜〜当日未明）の予約は、当日が期間に入っていれば表示される（前日側の期間にも表示される）。
   * - 当日に終了済みの予約・利用中の予約も、当日を含む期間では表示される（phaseで区別）。
   * - 終了が空欄・開始以前（不整合）の予約は、開始時刻の一点として判定する（終了を推測しない）。
   * - 終了がちょうど始端（0:00）の予約は、その日には含めない。
   */
  function rangeMs_(c) {
    return { start: OpsContract.parseJstDate(c.from), endExclusive: OpsContract.parseJstDate(c.to) + OpsContract.DAY_MS };
  }

  function overlaps_(rec, range) {
    if (rec.startMs >= range.endExclusive) return false;
    var hasSpan = rec.endMs !== null && rec.endMs > rec.startMs;
    return hasSpan ? rec.endMs > range.start : rec.startMs >= range.start;
  }

  /* 現在時刻に対する分類。終了が分からないものは推測せず 'unknown'（開始後）。 */
  function phaseOf(rec, nowMs) {
    if (nowMs < rec.startMs) return 'upcoming';
    if (rec.endMs === null || rec.endMs <= rec.startMs) return 'unknown';
    return nowMs < rec.endMs ? 'in_progress' : 'ended';
  }

  function matches_(rec, c, range) {
    if (c.service !== 'all' && rec.service !== c.service) return false;
    if (c.status !== 'all') {
      if (c.status === 'UNKNOWN' ? rec.status !== null : rec.status !== c.status) return false;
    }
    return overlaps_(rec, range);
  }

  function compare_(a, b) {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    var ae = a.endMs === null ? Infinity : a.endMs;
    var be = b.endMs === null ? Infinity : b.endMs;
    if (ae !== be) return ae < be ? -1 : 1;
    return a.bookingId < b.bookingId ? -1 : a.bookingId > b.bookingId ? 1 : 0;
  }

  function select(records, criteria) {
    var range = rangeMs_(criteria);
    var rows = records.filter(function (rec) { return matches_(rec, criteria, range); });
    rows.sort(function (a, b) { return criteria.order === 'desc' ? compare_(b, a) : compare_(a, b); });
    return rows;
  }

  /* 一覧カード用の最小項目。日時はタイムゾーン付きISO、利用日は日付のみ（別項目）。 */
  function toListItem(rec, nowMs) {
    return {
      bookingId: rec.bookingId,
      service: rec.service,
      serviceLabel: rec.serviceLabel,
      status: rec.status,
      statusLabel: rec.statusLabel,
      date: rec.date,
      startAt: rec.startAt,
      endAt: rec.endAt,
      phase: phaseOf(rec, nowMs),
      name: rec.name,
      people: rec.people
    };
  }

  /* 詳細用。ALLOWED_COLUMNS由来の項目のみ（内部の並び替えキー等は含めない）。 */
  function toDetail(rec, nowMs) {
    var item = toListItem(rec, nowMs);
    item.brandRaw = rec.brandRaw;
    item.statusRaw = rec.statusRaw;
    item.customerType = rec.customerType;
    item.purpose = rec.purpose;
    item.paymentMethod = rec.paymentMethod;
    item.paymentStatus = rec.paymentStatus;
    item.planCode = rec.planCode;
    item.effectivePriceAmount = rec.effectivePriceAmount;
    item.priceOverridden = rec.priceOverridden;
    item.largeParty = rec.largeParty;
    item.source = rec.source;
    item.createdAt = rec.createdAt;
    item.updatedAt = rec.updatedAt;
    item.confirmedAt = rec.confirmedAt;
    item.cancelledAt = rec.cancelledAt;
    item.expiredAt = rec.expiredAt;
    /* メール送信記録（#967）。状態と日時のみ。宛先・本文・エラー文は含めない。 */
    item.accessGuideMail = rec.accessGuideMail;
    item.confirmedMail = rec.confirmedMail;
    return item;
  }

  return { resolve: resolve, select: select, phaseOf: phaseOf, toListItem: toListItem, toDetail: toDetail, STATUS_FILTERS: STATUS_FILTERS };
})();
