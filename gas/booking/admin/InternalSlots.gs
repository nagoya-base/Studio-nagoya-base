/*
 * InternalSlots.gs — 運営専用予約枠（Issue #999）。Booking Admin専用（Public・Webhookには配布しない）。
 *
 * SNBCイベント・設営/片付け・清掃/メンテナンス・その他の運営確保枠を、オーナーだけが確保する。
 * 新しい基盤は作らず、空き枠の正本である予約Calendarに「運営枠タグ付きイベント」を置くだけにする:
 * - 公開の空き枠判定（getBusyIntervalsForDate）と createBooking の競合判定は Calendar の全イベントを見るため、
 *   確保した瞬間に一般公開の空き枠から消え、一般予約と同じ時間は両方向で登録できない（コード変更なし）。
 * - Bookings台帳に行を作らない。よって決済・未収・顧客向けメール・SwitchBot個別暗証番号（鍵）・
 *   前日の顧客リマインド・Ops/売上KPI（台帳だけを読む）の対象に一切ならない。ダミーの予約者情報も作らない。
 * - SNB / mens / Studio X は同一室（Availability.gs）。対象場所は表示・通知用の記録で、衝突判定は場所で分岐しない。
 *
 * 認可: 公開関数（adminInternalSlot*）は毎回 isBookingAdminVerified_()（Session.getActiveUser × BOOKING_ADMIN_EMAILS）で
 * 検証し、不許可は何も読まず・書かず FORBIDDEN を返す。画面の表示制御には頼らない。
 * 排他: スクリプトロック内で再照会して重複を拒否し、作成・変更の直後にも再照会する（公開Web Appとはロックを共有できないため）。
 * 通知: 運営者宛のみ（ADMIN_NOTIFICATION_EMAIL）。前日リマインドは既存の sendNextDayReminders に相乗りし、
 * 送信済みはイベントのタグ（remindedAt）で重複を防ぐ。入室手順・キーボックス・暗証番号は載せない。
 */
'use strict';

var InternalSlots = (function () {
  var TAG_FLAG_ = 'internalSlot';
  var TAG_TYPE_ = 'slotType';
  var TAG_PLACE_ = 'slotPlace';
  var TAG_REMINDED_ = 'remindedAt';
  var LOCK_TIMEOUT_MS_ = 15000;
  var LIST_DAYS_ = 90;
  var DAY_MS_ = 24 * 3600000;
  var REMINDER_HOUR_ = 18;
  var TIME_PATTERN_ = /^([01]\d|2[0-3]):([0-5]\d)$/;
  var TITLE_MAX_ = 60;
  var MEMO_MAX_ = 500;

  var TYPES_ = {
    snbc_event: 'SNBCイベント',
    setup: '設営・片付け',
    cleaning: '清掃・メンテナンス',
    other: 'その他の運営確保枠'
  };

  function err_(code, message) { return { success: false, error: { code: code, message: message } }; }

  function config_() { return BookingConfig.getAvailabilityConfig(); }

  function hasOwn_(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function getCalendar_() {
    var calendar = CalendarApp.getCalendarById(BookingConfig.getCalendarId());
    if (!calendar) throw new Error('Calendarが見つかりません。');
    return calendar;
  }

  function toMinutes_(hhmm) {
    var p = hhmm.split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  /* 入力検証（サーバー側が正）。開始・終了は同日内の15分刻み（公開予約の開始刻みと同じ）。 */
  function validate_(input, timezone) {
    input = input || {};
    var type = String(input.type || '');
    if (!hasOwn_(TYPES_, type)) return err_('INVALID_TYPE', '種別を選んでください。');
    var place = String(input.place || '');
    if (Booking.ALLOWED_BOOKING_BRANDS && Booking.ALLOWED_BOOKING_BRANDS.indexOf(place) === -1) {
      return err_('INVALID_PLACE', '対象場所を選んでください。');
    }
    var title = String(input.title || '').trim();
    if (!title || title.length > TITLE_MAX_) return err_('INVALID_TITLE', '件名を' + TITLE_MAX_ + '文字以内で入力してください。');
    var memo = String(input.memo || '').trim();
    if (memo.length > MEMO_MAX_) return err_('INVALID_MEMO', 'メモは' + MEMO_MAX_ + '文字以内にしてください。');
    var date = String(input.date || '');
    if (!BookingAvailability.isValidDateString(date)) return err_('INVALID_DATE', '日付が正しくありません。');
    var startTime = String(input.startTime || '');
    var endTime = String(input.endTime || '');
    if (!TIME_PATTERN_.test(startTime) || !TIME_PATTERN_.test(endTime)) return err_('INVALID_TIME', '開始・終了時刻が正しくありません。');
    var s = toMinutes_(startTime);
    var e = toMinutes_(endTime);
    if (s % 15 !== 0 || e % 15 !== 0) return err_('INVALID_TIME', '時刻は15分刻みで指定してください。');
    if (e <= s) return err_('INVALID_TIME', '終了は開始より後にしてください。');
    return { success: true, value: { type: type, place: place, title: title, memo: memo, date: date, startTime: startTime, endTime: endTime } };
  }

  /* 他のイベント（終日を除く。公開の空き判定と同じ扱い）と1分でも重なれば衝突。 */
  function findConflict_(calendar, startAt, endAt, ownId) {
    return calendar.getEvents(startAt, endAt).some(function (event) {
      if (ownId && event.getId() === ownId) return false;
      if (event.isAllDayEvent()) return false;
      return event.getStartTime().getTime() < endAt.getTime() && event.getEndTime().getTime() > startAt.getTime();
    });
  }

  function isSlot_(event) { return !!event && event.getTag(TAG_FLAG_) === '1'; }

  function toSlot_(event, timezone) {
    var start = event.getStartTime();
    var end = event.getEndTime();
    var type = event.getTag(TAG_TYPE_);
    return {
      id: event.getId(),
      type: type,
      typeLabel: TYPES_[type] || type,
      place: event.getTag(TAG_PLACE_),
      placeLabel: Booking.getBrandLabel(event.getTag(TAG_PLACE_)),
      title: event.getTitle().replace(/^\[運営[^\]]*\]\s*/, ''),
      memo: event.getDescription() || '',
      date: BookingAvailability.formatDateInTimezone(start, timezone),
      startTime: BookingAvailability.formatTimeInTimezone(start, timezone),
      endTime: BookingAvailability.formatTimeInTimezone(end, timezone),
      reminded: !!event.getTag(TAG_REMINDED_)
    };
  }

  function eventTitle_(type, title) { return '[運営 ' + TYPES_[type] + '] ' + title; }

  function applyFields_(event, v) {
    event.setTitle(eventTitle_(v.type, v.title));
    event.setDescription(v.memo);
    event.setTag(TAG_TYPE_, v.type);
    event.setTag(TAG_PLACE_, v.place);
  }

  function withLock_(fn) {
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) return err_('LOCK_TIMEOUT', '一時的に混み合っています。もう一度お試しください。');
    try { return fn(); } finally { lock.releaseLock(); }
  }

  function slotLines_(slot) {
    var lines = [
      '種別: ' + slot.typeLabel,
      '件名: ' + slot.title,
      '日時: ' + (BookingAvailability.formatDateWithWeekday(slot.date) || slot.date) + ' ' + slot.startTime + '〜' + slot.endTime,
      '対象場所: ' + slot.placeLabel
    ];
    if (slot.memo) lines.push('メモ: ' + slot.memo);
    return lines;
  }

  function notify_(subject, slots, intro) {
    var lines = [intro, '（運営枠です。鍵の発行・決済・顧客向けメールはありません）', ''];
    slots.forEach(function (slot, i) {
      if (i > 0) lines.push('');
      lines = lines.concat(slotLines_(slot));
    });
    return BookingAdminAlerts.sendNotice(subject, lines).sent === true;
  }

  /* 前日18時の通常リマインドを過ぎている枠（当日分、または前日18時以降に登録した翌日分）か。 */
  function reminderWindowPassed_(date, now, timezone) {
    var today = BookingAvailability.formatDateInTimezone(now, timezone);
    var tomorrow = BookingAvailability.formatDateInTimezone(new Date(now.getTime() + DAY_MS_), timezone);
    if (date <= today) return true;
    if (date === tomorrow) return BookingAvailability.getCurrentMinutesInTimezone(now, timezone) >= REMINDER_HOUR_ * 60;
    return false;
  }

  function markReminded_(event, now) { event.setTag(TAG_REMINDED_, now.toISOString()); }

  /* 一覧（今日以降）。日付→開始の順。 */
  function list(now) {
    var timezone = config_().timezone;
    var today = BookingAvailability.formatDateInTimezone(now, timezone);
    var from = CalendarRepository.parseDateTime(today, '00:00', timezone);
    var to = new Date(from.getTime() + LIST_DAYS_ * DAY_MS_);
    var slots = getCalendar_().getEvents(from, to).filter(isSlot_).map(function (e) { return toSlot_(e, timezone); });
    slots.sort(function (a, b) { return (a.date + a.startTime).localeCompare(b.date + b.startTime); });
    return { success: true, slots: slots };
  }

  function create(input, now) {
    var timezone = config_().timezone;
    var checked = validate_(input, timezone);
    if (!checked.success) return checked;
    var v = checked.value;
    if (v.date < BookingAvailability.formatDateInTimezone(now, timezone)) return err_('INVALID_DATE', '過去の日付には登録できません。');
    return withLock_(function () {
      var calendar = getCalendar_();
      var startAt = CalendarRepository.parseDateTime(v.date, v.startTime, timezone);
      var endAt = CalendarRepository.parseDateTime(v.date, v.endTime, timezone);
      if (findConflict_(calendar, startAt, endAt, null)) return err_('SLOT_CONFLICT', 'その時間帯は予約済みか、すでに枠が入っています。');
      var event = calendar.createEvent(eventTitle_(v.type, v.title), startAt, endAt);
      event.setTag(TAG_FLAG_, '1');
      applyFields_(event, v);
      /* 作成直後に再照会（公開Web Appとはロックを共有できないため）。割り込まれていたら自分の枠を戻す。 */
      if (findConflict_(calendar, startAt, endAt, event.getId())) {
        event.deleteEvent();
        return err_('SLOT_CONFLICT', '登録の直前に別の予約が入りました。もう一度確認してください。');
      }
      var slot = toSlot_(event, timezone);
      var notified = false;
      if (reminderWindowPassed_(v.date, now, timezone)) {
        notified = notify_('【運営枠】登録しました（' + slot.date + '）', [slot], '運営枠を登録しました。直前のため、すぐにお知らせします。');
        if (notified) { markReminded_(event, now); slot.reminded = true; }
      }
      return { success: true, slot: slot, notified: notified };
    });
  }

  function update(id, input, now) {
    var timezone = config_().timezone;
    var checked = validate_(input, timezone);
    if (!checked.success) return checked;
    var v = checked.value;
    if (v.date < BookingAvailability.formatDateInTimezone(now, timezone)) return err_('INVALID_DATE', '過去の日付には変更できません。');
    return withLock_(function () {
      var calendar = getCalendar_();
      var event = calendar.getEventById(String(id || ''));
      if (!isSlot_(event)) return err_('NOT_FOUND', '運営枠が見つかりません。');
      var oldStart = event.getStartTime();
      var oldEnd = event.getEndTime();
      var startAt = CalendarRepository.parseDateTime(v.date, v.startTime, timezone);
      var endAt = CalendarRepository.parseDateTime(v.date, v.endTime, timezone);
      if (findConflict_(calendar, startAt, endAt, event.getId())) return err_('SLOT_CONFLICT', '変更先の時間帯は予約済みか、すでに枠が入っています。');
      var timeChanged = startAt.getTime() !== oldStart.getTime() || endAt.getTime() !== oldEnd.getTime();
      if (timeChanged) event.setTime(startAt, endAt);
      applyFields_(event, v);
      if (timeChanged && findConflict_(calendar, startAt, endAt, event.getId())) {
        event.setTime(oldStart, oldEnd);
        return err_('SLOT_CONFLICT', '変更の直前に別の予約が入りました。元の時間に戻しました。');
      }
      /* 日時が変わったら通知状態を戻し、最終の日時で改めて前日リマインドの対象にする。 */
      if (timeChanged) event.deleteTag(TAG_REMINDED_);
      var slot = toSlot_(event, timezone);
      var notified = notify_('【運営枠】変更しました（' + slot.date + '）', [slot], '運営枠を変更しました。');
      if (notified && reminderWindowPassed_(v.date, now, timezone)) { markReminded_(event, now); slot.reminded = true; }
      return { success: true, slot: slot, notified: notified };
    });
  }

  function cancel(id, now) {
    var timezone = config_().timezone;
    return withLock_(function () {
      var event = getCalendar_().getEventById(String(id || ''));
      if (!isSlot_(event)) return err_('NOT_FOUND', '運営枠が見つかりません。');
      var slot = toSlot_(event, timezone);
      event.deleteEvent();
      var notified = notify_('【運営枠】取り消しました（' + slot.date + '）', [slot], '運営枠を取り消しました。空き枠に戻っています。');
      return { success: true, notified: notified };
    });
  }

  /* 既存の前日リマインド（sendNextDayReminders）から呼ぶ。dateString の未通知枠を1通にまとめて送り、送れた枠だけ送信済みにする。 */
  function sendReminders(dateString, now) {
    var timezone = config_().timezone;
    var result = { sentCount: 0 };
    var lockResult = withLock_(function () {
      var from = CalendarRepository.parseDateTime(dateString, '00:00', timezone);
      var events = getCalendar_().getEvents(from, new Date(from.getTime() + DAY_MS_)).filter(function (e) {
        return isSlot_(e) && !e.getTag(TAG_REMINDED_);
      });
      if (events.length === 0) return { success: true };
      var slots = events.map(function (e) { return toSlot_(e, timezone); });
      if (!notify_('【運営枠】明日の運営枠（' + dateString + '）', slots, '明日の運営枠のお知らせです。')) return err_('MAIL_FAILED', '通知メールを送れませんでした。');
      events.forEach(function (e) { markReminded_(e, now); });
      result.sentCount = events.length;
      return { success: true };
    });
    result.success = lockResult.success === true;
    return result;
  }

  return {
    TYPES: TYPES_,
    list: list,
    create: create,
    update: update,
    cancel: cancel,
    sendReminders: sendReminders
  };
})();

function internalSlotGuard_(fn) {
  if (!isBookingAdminVerified_()) return { success: false, error: { code: 'FORBIDDEN', message: '管理者として認証できませんでした。' } };
  try {
    return fn(new Date());
  } catch (e) {
    Logger.log('InternalSlots: 予期しない例外');
    return { success: false, error: { code: 'INTERNAL_ERROR', message: '処理に失敗しました。' } };
  }
}

function adminInternalSlotList() { return internalSlotGuard_(function (now) { return InternalSlots.list(now); }); }
function adminInternalSlotCreate(input) { return internalSlotGuard_(function (now) { return InternalSlots.create(input, now); }); }
function adminInternalSlotUpdate(id, input) { return internalSlotGuard_(function (now) { return InternalSlots.update(id, input, now); }); }
function adminInternalSlotCancel(id) { return internalSlotGuard_(function (now) { return InternalSlots.cancel(id, now); }); }
