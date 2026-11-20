/*
 * OpsInternalSlots.gs — 運営枠の閲覧（Issue #1003。読み取り専用）。
 *
 * 運営枠（SNBCイベント・設営/片付け・清掃/メンテナンス・その他）の正本は、Booking Admin（#999）が予約Calendarに置く
 * 「internalSlot=1 タグ付きイベント」。ここはそのイベントを **読むだけ** で、作成・変更・取消・メール送信・
 * Calendarイベントの変更は一切しない（CalendarApp は getCalendarById / getEvents / getTag 系の読み取りだけ）。
 * Ops GAS は Booking Admin とは別スクリプト・別デプロイのため、adminInternalSlotList は呼ばない。
 *
 * - 読取先のCalendar IDはサーバー側のScript Property（OPS_INTERNAL_SLOTS_CALENDAR_ID。Booking Admin の CALENDAR_ID と同じ値）に固定。
 *   画面・要求からは受け取らない。IDはログ・戻り値へ出さない。
 * - 一般のCalendarイベント（タグなし）は返さない。返す項目は id（'internal:' 名前空間）・種類・場所・件名・日付・開始/終了・リマインド済みだけ
 *   （メモ欄・参加者・説明は返さない）。
 * - 範囲は今日（JST）から90日。Booking Admin の一覧と同じ。取消で削除されたイベントは取得されない。
 * - 取得できない理由は state で区別する。ready 以外で「運営枠0件」と表示させない（呼び出し側の責務）。
 *     ready: 取得成功（slots が0件なら「該当0件」）/ not_configured: 読取先ID未設定 / no_access: 見つからない・権限なし
 *     auth_required: Calendar読み取りの承認が未了 / read_failed: その他の読取失敗
 *   タグ不一致（internalSlot=1 だが種類・場所が不明）は表示せず、invalid に件数だけ返す（黙って捨てない）。
 */
'use strict';

var OpsInternalSlots = (function () {
  var TAG_FLAG = 'internalSlot';
  var TAG_TYPE = 'slotType';
  var TAG_PLACE = 'slotPlace';
  var TAG_REMINDED = 'remindedAt';
  var LIST_DAYS = 90;
  var ID_PREFIX = 'internal:';

  /* Booking Admin（InternalSlots.gs の TYPES_。#1005 の kinbaku_event を含む5種）と同じ種別。Booking Admin のコードは別デプロイのため参照できず、表示用に複製する。 */
  var TYPES = {
    snbc_event: 'SNBCイベント',
    kinbaku_event: '緊縛イベント',
    setup: '設営・片付け',
    cleaning: '清掃・メンテナンス',
    other: 'その他の運営確保枠'
  };

  function hasOwn_(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function placeService_(place) {
    var s = OpsContract.serviceForBrand(place);
    return s && s.sourceBrand ? s : null;
  }

  /* タグ付きイベント → 画面用の最小項目。種類・場所を読めないものは null（呼び出し側で invalid として数える）。 */
  function toSlot_(event) {
    var type = String(event.getTag(TAG_TYPE) || '');
    var service = placeService_(String(event.getTag(TAG_PLACE) || ''));
    if (!hasOwn_(TYPES, type) || !service) return null;
    var start = event.getStartTime();
    var end = event.getEndTime();
    if (!OpsContract.isDate(start) || !OpsContract.isDate(end)) return null;
    return {
      id: ID_PREFIX + event.getId(),
      type: type,
      typeLabel: TYPES[type],
      service: service.id,
      placeLabel: service.label,
      title: String(event.getTitle() || '').replace(/^\[運営[^\]]*\]\s*/, ''),
      date: OpsContract.formatJstDate(start.getTime()),
      startAt: OpsContract.toIso(start.getTime()),
      endAt: OpsContract.toIso(end.getTime()),
      reminded: !!event.getTag(TAG_REMINDED)
    };
  }

  function failureState_(e) {
    var text = e && typeof e.message === 'string' ? e.message : '';
    return /authoriz|permission|scope/i.test(text) ? 'auth_required' : 'read_failed';
  }

  function fail_(state) { return { state: state, slots: [], invalid: 0 }; }

  /*
   * deps: { getCalendarId(): string|null, getCalendar(id): calendar|null }（calendar は getEvents(from, to) を持つ）
   * 戻り値: { state, slots, invalid, from, to }。例外は投げない（運営枠の失敗で通常予約を巻き込まない）。
   */
  function read(deps, nowMs) {
    var calendarId = null;
    try { calendarId = deps.getCalendarId(); } catch (e) { return fail_('read_failed'); }
    if (typeof calendarId !== 'string' || !calendarId.trim()) return fail_('not_configured');
    var today = OpsContract.formatJstDate(nowMs);
    var fromMs = OpsContract.parseJstDate(today);
    var toMs = fromMs + LIST_DAYS * OpsContract.DAY_MS;
    var calendar;
    try { calendar = deps.getCalendar(calendarId.trim()); } catch (e2) { return fail_(failureState_(e2)); }
    if (!calendar) return fail_('no_access');
    var events;
    try { events = calendar.getEvents(new Date(fromMs), new Date(toMs)); } catch (e3) { return fail_(failureState_(e3)); }
    var slots = [];
    var invalid = 0;
    try {
      events.forEach(function (event) {
        /* 厳密判定: internalSlot タグが文字列 '1' のものだけ。一般のイベントは読み飛ばし、中身を返さない。 */
        if (event.getTag(TAG_FLAG) !== '1') return;
        var slot = toSlot_(event);
        if (slot) slots.push(slot); else invalid++;
      });
    } catch (e4) { return fail_(failureState_(e4)); }
    slots.sort(function (a, b) { return a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return { state: 'ready', slots: slots, invalid: invalid, from: today, to: OpsContract.formatJstDate(toMs - OpsContract.DAY_MS) };
  }

  return { read: read, TYPES: TYPES, ID_PREFIX: ID_PREFIX, LIST_DAYS: LIST_DAYS };
})();
