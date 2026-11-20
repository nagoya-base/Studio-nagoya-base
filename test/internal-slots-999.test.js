/*
 * 運営専用予約枠（Issue #999）の重要な回帰だけを確認する:
 * オーナー以外の拒否 / 一般予約との重複防止（両方向の元になる空き判定への反映）/ 台帳・鍵・決済に触れない / リマインドの重複防止。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var stubs = require('./helpers/gas-stubs');
var futureJstDate = require('./helpers/future-date').futureJstDate;

var FILES = ['Config.gs', 'Availability.gs', 'Booking.gs', 'CalendarRepository.gs', 'BookingAdminAlerts.gs', 'InternalSlots.gs', 'BookingAdminWeb.gs'];
var OWNER = 'owner@example.com';

function makeEvent(calendar, title, start, end) {
  var tags = {}; var desc = ''; var deleted = false; var id = 'ev' + (calendar.seq = (calendar.seq || 0) + 1);
  var ev = {
    getId: function () { return id; }, getTitle: function () { return title; }, setTitle: function (t) { title = t; },
    getDescription: function () { return desc; }, setDescription: function (d) { desc = d; },
    getStartTime: function () { return start; }, getEndTime: function () { return end; },
    setTime: function (s, e) { start = s; end = e; },
    isAllDayEvent: function () { return false; },
    getTag: function (k) { return Object.prototype.hasOwnProperty.call(tags, k) ? tags[k] : null; },
    setTag: function (k, v) { tags[k] = v; }, deleteTag: function (k) { delete tags[k]; },
    deleteEvent: function () { deleted = true; }, isDeleted: function () { return deleted; }
  };
  calendar.events.push(ev);
  return ev;
}

function setup(activeEmail) {
  var calendar = { events: [] };
  var mail = stubs.createMailAppStub();
  var globals = {
    PropertiesService: stubs.createPropertiesServiceStub({ CALENDAR_ID: 'cal', ADMIN_NOTIFICATION_EMAIL: 'notify@example.com', BOOKING_ADMIN_EMAILS: OWNER }),
    CalendarApp: { getCalendarById: function () {
      return {
        getEvents: function (from, to) { return calendar.events.filter(function (e) { return !e.isDeleted() && e.getStartTime() < to && e.getEndTime() > from; }); },
        createEvent: function (t, s, e) { return makeEvent(calendar, t, s, e); },
        getEventById: function (id) { return calendar.events.filter(function (e) { return !e.isDeleted() && e.getId() === id; })[0] || null; }
      };
    } },
    LockService: stubs.createLockServiceStub(),
    MailApp: mail,
    Utilities: stubs.createUtilitiesStub(),
    Session: { getActiveUser: function () { return { getEmail: function () { return activeEmail; } }; } },
    Logger: stubs.createLoggerStub()
    /* SpreadsheetApp / UrlFetchApp は渡さない: 台帳・Stripe・鍵に触れたらReferenceErrorで落ちる */
  };
  return { s: loadBookingSandbox(FILES, globals), calendar: calendar, mail: mail };
}

var DATE = futureJstDate(10);
function input(extra) {
  return Object.assign({ type: 'snbc_event', place: 'snb', title: 'SNBC定例', date: DATE, startTime: '13:00', endTime: '15:00', memo: '機材搬入あり' }, extra || {});
}
function at(date, hhmm) { return new Date(date + 'T' + hhmm + ':00+09:00'); }

test('オーナー以外は一覧・作成・変更・取消のすべてを拒否し、何も作らない', function () {
  ['stranger@example.com', ''].forEach(function (email) {
    var t = setup(email);
    var ev = makeEvent(t.calendar, '[運営 清掃・メンテナンス] x', at(DATE, '09:00'), at(DATE, '10:00')); ev.setTag('internalSlot', '1');
    [t.s.adminInternalSlotList(), t.s.adminInternalSlotCreate(input()), t.s.adminInternalSlotUpdate(ev.getId(), input()), t.s.adminInternalSlotCancel(ev.getId())].forEach(function (r) {
      assert.strictEqual(r.success, false);
      assert.strictEqual(r.error.code, 'FORBIDDEN');
      assert.strictEqual(r.slots, undefined);
    });
    assert.strictEqual(t.calendar.events.length, 1);
    assert.strictEqual(t.calendar.events[0].isDeleted(), false);
    assert.strictEqual(t.mail._sentEmails.length, 0);
  });
});

test('一般予約と重なる時間は登録・変更できず、登録後は公開の空き判定に反映され、取消で解放される', function () {
  var t = setup(OWNER);
  makeEvent(t.calendar, '[SNB 確定] SNB-1', at(DATE, '14:00'), at(DATE, '16:00'));
  assert.strictEqual(t.s.adminInternalSlotCreate(input({ date: futureJstDate(120) })).error.code, 'INVALID_DATE', '一覧に出ない遠い日付は登録させない');
  var rejected = t.s.adminInternalSlotCreate(input());
  assert.strictEqual(rejected.error.code, 'SLOT_CONFLICT');
  assert.strictEqual(t.calendar.events.length, 1);

  var created = t.s.adminInternalSlotCreate(input({ startTime: '16:00', endTime: '18:00', place: 'studio_x' }));
  assert.strictEqual(created.success, true);
  var busy = t.s.CalendarRepository.getBusyIntervalsForDate('cal', DATE, 'Asia/Tokyo');
  assert.ok(busy.some(function (b) { return b.startMinutes === 16 * 60 && b.endMinutes === 18 * 60; }), '公開の空き判定が運営枠を占有として見る');

  var moved = t.s.adminInternalSlotUpdate(created.slot.id, input({ startTime: '15:00', endTime: '17:00' }));
  assert.strictEqual(moved.error.code, 'SLOT_CONFLICT');

  assert.strictEqual(t.s.adminInternalSlotCancel(created.slot.id).success, true);
  assert.strictEqual(t.s.CalendarRepository.getBusyIntervalsForDate('cal', DATE, 'Asia/Tokyo').length, 1);
});

test('前日リマインドは運営者宛に1回だけ。鍵・入室情報を含まず、日時を変えたら改めて通知する', function () {
  var t = setup(OWNER);
  var now = at(futureJstDate(8), '12:00');
  var created = t.s.InternalSlots.create(input(), now);
  assert.strictEqual(created.success, true);
  assert.strictEqual(t.mail._sentEmails.length, 0, '直前でなければ登録時は送らない');

  var r1 = t.s.InternalSlots.sendReminders(DATE, now);
  var r2 = t.s.InternalSlots.sendReminders(DATE, now);
  assert.strictEqual(r1.sentCount, 1);
  assert.strictEqual(r2.sentCount, 0);
  assert.strictEqual(t.mail._sentEmails.length, 1);
  var mail = t.mail._sentEmails[0];
  assert.strictEqual(mail.to, 'notify@example.com');
  assert.ok(/SNBC定例/.test(mail.body) && /13:00/.test(mail.body) && /15:00/.test(mail.body) && /機材搬入あり/.test(mail.body));
  assert.ok(!/暗証|キーボックス|解錠|入室/.test(mail.body));

  t.mail._sentEmails.length = 0;
  t.s.InternalSlots.update(created.slot.id, input({ startTime: '13:30', endTime: '15:30' }), now); /* 変更通知1通 */
  assert.strictEqual(t.s.InternalSlots.sendReminders(DATE, now).sentCount, 1, '日時変更後は最終の日時で再度対象になる');
});

test('前日18時以降に登録した翌日枠は登録直後に通知し、その後の定時リマインドで重複しない', function () {
  var t = setup(OWNER);
  var now = at(futureJstDate(0), '19:00');
  var tomorrow = futureJstDate(1);
  var r = t.s.InternalSlots.create(input({ date: tomorrow }), now);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.notified, true);
  assert.strictEqual(t.mail._sentEmails.length, 1);
  assert.strictEqual(t.s.InternalSlots.sendReminders(tomorrow, now).sentCount, 0);
  assert.strictEqual(t.mail._sentEmails.length, 1);
});

test('変更の直前に別の予約が割り込んだら、時間もメタデータも元に戻る', function () {
  var t = setup(OWNER);
  var created = t.s.adminInternalSlotCreate(input());
  var ev = t.calendar.events[0];
  var origSetTime = ev.setTime;
  ev.setTime = function (s, e) { origSetTime(s, e); makeEvent(t.calendar, '[SNB 確定] SNB-2', s, e); };
  var r = t.s.adminInternalSlotUpdate(created.slot.id, input({ startTime: '16:00', endTime: '17:00', title: '変更後' }));
  ev.setTime = function (s, e) { origSetTime(s, e); };
  assert.strictEqual(r.error.code, 'SLOT_CONFLICT');
  assert.strictEqual(ev.getTitle(), '[運営 SNBCイベント] SNBC定例');
  assert.strictEqual(ev.getStartTime().getTime(), at(DATE, '13:00').getTime());
});

test('通知メールが失敗しても保存・取消は成功し、notifyFailedで知らせる。作成途中のタグ付け失敗では占有イベントを残さない', function () {
  var t = setup(OWNER);
  var now = at(futureJstDate(0), '19:00');
  t.s.MailApp.sendEmail = function () { throw new Error('mail down'); };
  var r = t.s.InternalSlots.create(input({ date: futureJstDate(1) }), now);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.notifyFailed, true);
  assert.strictEqual(r.slot.reminded, false, '未送信のまま（定時リマインドの対象に残る）');
  var c = t.s.InternalSlots.cancel(r.slot.id, now);
  assert.strictEqual(c.success, true);
  assert.strictEqual(c.notifyFailed, true);

  var t2 = setup(OWNER);
  var realCreate = t2.s.CalendarApp.getCalendarById;
  t2.s.CalendarApp.getCalendarById = function (id) {
    var cal = realCreate(id);
    var create = cal.createEvent;
    cal.createEvent = function (a, b, c2) { var ev = create(a, b, c2); ev.setTag = function () { throw new Error('tag failed'); }; return ev; };
    return cal;
  };
  var failed = t2.s.InternalSlots.create(input(), now);
  assert.strictEqual(failed.error.code, 'SAVE_FAILED');
  assert.ok(t2.calendar.events.every(function (e) { return e.isDeleted(); }), 'タグのない占有イベントを残さない');
});

test('開始・終了は00/30分のみ許可し、15/45分はサーバーで拒否。緊縛イベント種別も登録できる（#1004）', function () {
  var t = setup(OWNER);
  var ok = t.s.adminInternalSlotCreate(input({ type: 'kinbaku_event', startTime: '13:30', endTime: '15:00' }));
  assert.strictEqual(ok.success, true);
  assert.strictEqual(ok.slot.typeLabel, '緊縛イベント');
  assert.ok(/緊縛イベント/.test(t.calendar.events[0].getTitle()));
  ['13:15', '13:45'].forEach(function (bad) {
    assert.strictEqual(t.s.adminInternalSlotCreate(input({ startTime: bad, endTime: '18:00' })).error.code, 'INVALID_TIME');
    assert.strictEqual(t.s.adminInternalSlotCreate(input({ startTime: '16:00', endTime: bad })).error.code, 'INVALID_TIME');
    assert.strictEqual(t.s.adminInternalSlotUpdate(ok.slot.id, input({ startTime: '13:00', endTime: bad })).error.code, 'INVALID_TIME');
  });
  assert.strictEqual(t.calendar.events.length, 1);
});

test('運営枠の開始・終了UIは00/30分だけの選択肢で、type=timeを使わない（#1004）', function () {
  var src = fs.readFileSync(path.join(__dirname, '..', 'admin', 'booking', 'booking-admin.js'), 'utf8');
  assert.ok(!/internal-slot-(start|end)" type="time"/.test(src));
  var m = src.match(/function internalSlotTimeOptions_\(\) \{[\s\S]*?\n\}\n/);
  assert.ok(m);
  var values = [];
  new Function('escapeHtml', m[0] + 'return internalSlotTimeOptions_();')(function (x) { return x; })
    .replace(/value="([^"]*)"/g, function (_, v) { values.push(v); return ''; });
  assert.strictEqual(values.length, 49);
  assert.ok(values.slice(1).every(function (v) { return /^\d\d:(00|30)$/.test(v); }));
});
