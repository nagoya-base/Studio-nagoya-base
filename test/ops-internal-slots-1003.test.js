/*
 * 運営枠の閲覧（Issue #1003。読み取り専用）の代表ケース。実際にGASへ貼る gas/ops-reservations/ をvmで実行する。
 * データはすべて架空（実在のCalendar ID・イベントID・個人情報を含まない）。
 * 代表4ケース: ①正しいタグだけ表示 ②所有者認可 ③通常予約/KPIから除外 ④読取失敗（0件と区別・予約は消えない）＋権限（読み取り専用）
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var DIR = path.join(ROOT, 'gas', 'ops-reservations');
var Client = require(path.join(ROOT, '_ops-app', 'frontend', 'ops-client.js'));

var NOW = Date.UTC(2026, 11, 1, 2, 0, 0); /* 2026-12-01 11:00 JST */

function backend() {
  var logs = [];
  var sandbox = { Logger: { log: function (m) { logs.push(String(m)); } }, _logs: logs };
  vm.createContext(sandbox);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsInternalSlots.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), sandbox, { filename: f });
  });
  return sandbox;
}

/* 読み取りしかできない架空イベント。説明（メモ）や変更系は持たない＝呼べば TypeError になり、読み取り専用を構造的に確かめる。 */
function ev(id, tags, startJst, endJst, title) {
  function at(t) { var m = /^(\d+)-(\d+)-(\d+) (\d+):(\d+)$/.exec(t); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5])); }
  return {
    getId: function () { return id; },
    getTag: function (k) { return Object.prototype.hasOwnProperty.call(tags, k) ? tags[k] : null; },
    getTitle: function () { return title; },
    getStartTime: function () { return at(startJst); },
    getEndTime: function () { return at(endJst); }
  };
}
function calendarOf(events) { return { getEvents: function () { return events; } }; }
function depsOf(calendar, id) {
  return { getCalendarId: function () { return id === undefined ? 'fake-calendar-id' : id; }, getCalendar: function () { return calendar; } };
}
var OK_TAGS = { internalSlot: '1', slotType: 'snbc_event', slotPlace: 'snb' };

test('運営枠①: internalSlot=1 の正しいタグだけを最小項目で返す。一般イベントは返さず、読めないタグは件数だけ数える', function () {
  var be = backend();
  var calendar = calendarOf([
    ev('late', { internalSlot: '1', slotType: 'cleaning', slotPlace: 'studio_x', remindedAt: '2026-12-02T09:00:00Z' }, '2026-12-03 15:00', '2026-12-03 17:00', '[運営 清掃・メンテナンス] 床清掃'),
    ev('early', OK_TAGS, '2026-12-02 18:00', '2026-12-02 21:00', '[運営 SNBCイベント] 交流会'),
    ev('general-1', {}, '2026-12-02 10:00', '2026-12-02 12:00', '一般のカレンダー予定（他人の予定）'),
    ev('kinbaku', { internalSlot: '1', slotType: 'kinbaku_event', slotPlace: 'snb' }, '2026-12-02 19:15', '2026-12-02 20:45', '[運営 緊縛イベント] 練習会'),
    ev('flag-off', { internalSlot: '0', slotType: 'snbc_event', slotPlace: 'snb' }, '2026-12-02 10:00', '2026-12-02 12:00', '対象外'),
    ev('bad-tag', { internalSlot: '1', slotType: 'unknown_type', slotPlace: 'snb' }, '2026-12-04 10:00', '2026-12-04 11:00', '種類が読めない')
  ]);
  var view = be.OpsInternalSlots.read(depsOf(calendar), NOW);
  assert.strictEqual(view.state, 'ready');
  assert.strictEqual(view.invalid, 1, 'タグ不一致は黙って捨てず件数で示す');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(view.slots.map(function (s) { return s.id; }))), ['internal:early', 'internal:kinbaku', 'internal:late'], '開始順・台帳の予約IDと衝突しない名前空間');
  var first = view.slots[0];
  assert.deepStrictEqual(JSON.parse(JSON.stringify(Object.keys(first).sort())), ['date', 'endAt', 'id', 'placeLabel', 'reminded', 'service', 'startAt', 'title', 'type', 'typeLabel']);
  assert.strictEqual(first.title, '交流会', '[運営 …] の接頭辞は外す');
  assert.strictEqual(first.date, '2026-12-02');
  assert.strictEqual(first.startAt, '2026-12-02T18:00:00+09:00');
  assert.strictEqual(first.typeLabel, 'SNBCイベント');
  assert.strictEqual(first.placeLabel, 'SNB');
  assert.strictEqual(first.reminded, false);
  assert.strictEqual(view.slots[2].reminded, true);
  assert.strictEqual(view.slots[1].typeLabel, '緊縛イベント', '#1005 で追加された種別も invalid にせず表示する');
  assert.ok(!/general-1|一般のカレンダー/.test(JSON.stringify(view)));
});

test('運営枠②: 所有者以外は読めない（Calendarに触れない）。読取先は要求ではなくサーバー設定だけで決まる', function () {
  var be = backend();
  var touched = 0;
  var denied = be.OpsApi.handle({ op: 'internal_slots', calendarId: 'attacker-chosen' }, {
    nowMs: NOW,
    authenticate: function () { return { ok: false, code: 'FORBIDDEN' }; },
    readInternalSlots: function () { touched++; return { state: 'ready', slots: [{ id: 'internal:x' }], invalid: 0 }; }
  });
  assert.strictEqual(denied.ok, false);
  assert.strictEqual(denied.error.code, 'FORBIDDEN');
  assert.strictEqual(touched, 0);
  assert.ok(!/internal:x/.test(JSON.stringify(denied)));
  var unauth = be.OpsApi.handle({ op: 'internal_slots' }, { nowMs: NOW, authenticate: function () { return { ok: false, code: 'UNAUTHENTICATED' }; }, readInternalSlots: function () { touched++; return {}; } });
  assert.strictEqual(unauth.error.code, 'UNAUTHENTICATED');
  assert.strictEqual(touched, 0);

  /* 所有者: 既定の読み取り（GAS）はScript Propertyのカレンダーだけを開く。要求の calendarId は無視される。 */
  var opened = [];
  be.PropertiesService = { getScriptProperties: function () { return { getProperty: function (k) { return k === 'OPS_INTERNAL_SLOTS_CALENDAR_ID' ? 'configured-id' : null; } }; } };
  be.CalendarApp = { getCalendarById: function (id) { opened.push(id); return calendarOf([ev('e1', OK_TAGS, '2026-12-02 18:00', '2026-12-02 21:00', '[運営 SNBCイベント] 交流会')]); } };
  be.OpsAuth.createGasSessionAuthenticator = function () { return function () { return { ok: true }; }; };
  var ok = be.OpsApi.handle({ op: 'internal_slots', calendarId: 'attacker-chosen', params: { calendarId: 'attacker-chosen' } }, { nowMs: NOW, authenticate: function () { return { ok: true }; } });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.internalSlots.state, 'ready');
  assert.deepStrictEqual(opened, ['configured-id']);
  assert.ok(!/configured-id|attacker-chosen|fake-calendar-id/.test(be._logs.join('\n') + JSON.stringify(ok)), 'Calendar IDをログ・応答へ出さない');
});

test('運営枠③: 通常予約の一覧・件数・売上KPIに混ざらない。画面では別枠のカードで、詳細・鍵・現地払いへ進めない', function () {
  var be = backend();
  var header = ['bookingId', 'date', 'startAt', 'endAt', 'brand', 'name', 'people', 'status'];
  var rows = [['FAKE-1', '2026-12-02', new Date(Date.UTC(2026, 11, 2, 1, 0)), new Date(Date.UTC(2026, 11, 2, 3, 0)), 'snb', '架空 花子', 2, 'CONFIRMED']];
  function run(slots) {
    return JSON.parse(JSON.stringify(be.OpsApi.handle({ op: 'list', params: { scope: 'upcoming' } }, {
      nowMs: NOW, authenticate: function () { return { ok: true }; },
      readLedger: function () { return { values: [header].concat(rows) }; },
      readInternalSlots: function () { return slots; }
    })));
  }
  var withSlots = run({ state: 'ready', slots: [{ id: 'internal:a' }], invalid: 0 });
  var withoutSlots = run({ state: 'read_failed', slots: [], invalid: 0 });
  assert.deepStrictEqual(withSlots, withoutSlots, '一覧の応答は運営枠の有無・成否に一切影響されない');
  assert.strictEqual(withSlots.counts.matched, 1);
  assert.ok(!/internal:/.test(JSON.stringify(withSlots)));
  /* 売上・集計・現地払い・鍵のコードは運営枠を参照しない（集計対象外・自動連携なし）。 */
  ['OpsRevenue.gs', 'OpsRevenueRecords.gs', 'OpsRevenueStore.gs', 'OpsQuery.gs', 'OpsNormalizer.gs', 'OpsKeyStatus.gs', 'OpsKeyFinal.gs', 'OpsTasks.gs'].forEach(function (f) {
    assert.ok(!/InternalSlots|internalSlot|CalendarApp/.test(fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')), f);
  });

  /* 画面: 運営枠は「運営枠」と明示した別カードで、予約件数は予約だけ。カードは詳細を開くボタン（data-id）にならない。 */
  var slotView = { state: 'ready', invalid: 0, slots: [{ id: 'internal:a', type: 'snbc_event', typeLabel: 'SNBCイベント', service: 'snb', placeLabel: 'SNB', title: '交流会', date: '2026-12-02', startAt: '2026-12-02T18:00:00+09:00', endAt: '2026-12-02T21:00:00+09:00', reminded: false }] };
  var api = {
    list: function (p, ok) { ok(Object.assign({}, withSlots, { applied: Object.assign({}, withSlots.applied, { status: 'all' }) })); },
    detail: function () {},
    internalSlots: function (ok) { ok({ ok: true, fetchedAt: '2026-12-01T11:00:00+09:00', internalSlots: slotView }); }
  };
  var ctl = Client.createController(api, function () {});
  ctl.load({ service: 'all', status: 'all', scope: 'upcoming' });
  var html = Client.renderView(ctl.state);
  assert.ok(/class="tag slot">運営枠</.test(html));
  assert.ok(/該当 1件/.test(html), '予約の件数は運営枠を含まない');
  assert.ok(/運営枠 1 件/.test(html) && /予約の件数と売上には含みません/.test(html));
  assert.strictEqual((html.match(/data-id="/g) || []).length, 1, '詳細へ進めるのは予約カードだけ');
  assert.ok(html.indexOf('FAKE-1') < html.indexOf('交流会'), '同じ日でも開始時刻順に並べて見比べられる（予約10:00・運営枠18:00）');
  ctl.setKind('slots');
  assert.ok(!/FAKE-1/.test(Client.renderView(ctl.state)) && /交流会/.test(Client.renderView(ctl.state)), '「運営枠のみ」の絞り込み');
});

test('運営枠④: 取得できない理由を区別し、失敗を「0件」と表示しない。運営枠の失敗で通常予約は消えない', function () {
  var be = backend();
  var base = { nowMs: NOW };
  assert.strictEqual(be.OpsInternalSlots.read(depsOf(null, ''), NOW).state, 'not_configured');
  assert.strictEqual(be.OpsInternalSlots.read(depsOf(null), NOW).state, 'no_access');
  assert.strictEqual(be.OpsInternalSlots.read({ getCalendarId: function () { return 'x'; }, getCalendar: function () { throw new Error('You do not have permission to call CalendarApp.getCalendarById. Required permissions: https://www.googleapis.com/auth/calendar.readonly'); } }, NOW).state, 'auth_required');
  assert.strictEqual(be.OpsInternalSlots.read(depsOf({ getEvents: function () { throw new Error('boom'); } }), NOW).state, 'read_failed');
  var emptyOk = be.OpsInternalSlots.read(depsOf(calendarOf([])), NOW);
  assert.strictEqual(emptyOk.state, 'ready');
  assert.strictEqual(emptyOk.slots.length, 0);
  /* 例外を投げる読み取りでも handle は ok:true で state を返す（予約の要求には波及しない）。 */
  var thrown = be.OpsApi.handle({ op: 'internal_slots' }, Object.assign({ authenticate: function () { return { ok: true }; }, readInternalSlots: function () { throw new Error('SECRET'); } }, base));
  assert.strictEqual(thrown.ok, true);
  assert.strictEqual(thrown.internalSlots.state, 'read_failed');
  assert.ok(!/SECRET/.test(JSON.stringify(thrown)));

  /* 画面: 予約は表示したまま、運営枠の失敗は理由つきで示し「0件」と書かない。成功して空のときだけ0件。 */
  function render(slotsResponse) {
    var api = {
      list: function (p, ok) { ok({ ok: true, fetchedAt: '2026-12-01T11:00:00+09:00', applied: { scope: 'upcoming', service: 'all', status: 'all', from: '2026-12-01', to: '2026-12-30', order: 'asc' }, counts: { sheetRows: 1, valid: 1, matched: 1, issues: 0 }, serviceStates: [], notConnectedSelected: false, issues: [],
        items: [{ bookingId: 'FAKE-1', service: 'snb', serviceLabel: 'SNB', status: 'CONFIRMED', statusLabel: '確定', date: '2026-12-02', startAt: '2026-12-02T10:00:00+09:00', endAt: '2026-12-02T12:00:00+09:00', phase: 'upcoming', name: '架空', people: 2 }] }); },
      detail: function () {},
      internalSlots: slotsResponse
    };
    var ctl = Client.createController(api, function () {});
    ctl.load({ service: 'all', status: 'all', scope: 'upcoming' });
    return Client.renderView(ctl.state);
  }
  ['not_configured', 'no_access', 'auth_required', 'read_failed'].forEach(function (state) {
    var html = render(function (ok) { ok({ ok: true, internalSlots: { state: state, slots: [], invalid: 0 } }); });
    assert.ok(/FAKE-1/.test(html), state + ': 通常予約は表示されたまま');
    assert.ok(/運営枠が0件という意味ではありません/.test(html), state);
    assert.ok(!/運営枠は0件です|該当する運営枠は0件/.test(html), state);
  });
  /* 台帳が失敗してカレンダーだけ成功しても、要求した期間・サービスで運営枠を絞る（Codex指摘）。 */
  var farSlots = { state: 'ready', invalid: 0, slots: [
    { id: 'internal:in', typeLabel: 'SNBCイベント', service: 'snb', placeLabel: 'SNB', title: '範囲内', date: '2026-12-02', startAt: '2026-12-02T18:00:00+09:00', endAt: '2026-12-02T21:00:00+09:00', reminded: false },
    { id: 'internal:far', typeLabel: 'SNBCイベント', service: 'snb', placeLabel: 'SNB', title: '範囲外', date: '2027-01-20', startAt: '2027-01-20T18:00:00+09:00', endAt: '2027-01-20T21:00:00+09:00', reminded: false },
    { id: 'internal:other', typeLabel: '清掃', service: 'studio_x', placeLabel: 'Studio X', title: '別サービス', date: '2026-12-02', startAt: '2026-12-02T10:00:00+09:00', endAt: '2026-12-02T11:00:00+09:00', reminded: false }] };
  var failedLedger = Client.createController({ list: function (p, ok) { ok({ ok: false, error: { code: 'FETCH_FAILED', message: '失敗' } }); }, detail: function () {}, internalSlots: function (ok) { ok({ ok: true, internalSlots: farSlots }); } }, function () {});
  failedLedger.load({ service: 'snb', status: 'all', scope: 'custom', from: '2026-12-01', to: '2026-12-05' });
  var onlySlots = Client.renderView(failedLedger.state);
  assert.ok(/範囲内/.test(onlySlots) && !/範囲外|別サービス/.test(onlySlots));
  /* 1回成功 → 条件変更 → 台帳だけ失敗・Calendar成功: 古い条件（成功時のすべて・12月）ではなく、最新の条件（SNB・1/19〜1/21）で絞る。 */
  var calls = 0;
  var changing = Client.createController({
    list: function (p, ok) {
      calls++;
      if (calls > 1) return ok({ ok: false, error: { code: 'FETCH_FAILED', message: '失敗' } });
      ok({ ok: true, fetchedAt: '2026-12-01T11:00:00+09:00', applied: { scope: 'upcoming', service: 'all', status: 'all', from: '2026-12-01', to: '2026-12-30', order: 'asc' }, counts: { sheetRows: 0, valid: 0, matched: 0, issues: 0 }, serviceStates: [], notConnectedSelected: false, issues: [], items: [] });
    },
    detail: function () {}, internalSlots: function (ok) { ok({ ok: true, internalSlots: farSlots }); }
  }, function () {});
  changing.load({ service: 'all', status: 'all', scope: 'custom', from: '2026-12-01', to: '2026-12-30' });
  changing.load({ service: 'snb', status: 'all', scope: 'custom', from: '2027-01-19', to: '2027-01-21' });
  assert.strictEqual(changing.state.phase, 'error');
  var latest = Client.renderView(changing.state);
  assert.ok(/範囲外/.test(latest) && !/範囲内|別サービス/.test(latest), '古い条件の運営枠は出さない');
  var rejected = render(function (ok, ng) { ng(new Error('net')); });
  assert.ok(/FAKE-1/.test(rejected) && /運営枠が0件という意味ではありません/.test(rejected));
  var empty = render(function (ok) { ok({ ok: true, internalSlots: { state: 'ready', slots: [], invalid: 0 } }); });
  assert.ok(/条件に該当する運営枠は0件です/.test(empty), '取得成功のときだけ0件と表示する');
});

test('運営枠の権限: calendar.readonly だけを追加（書込みのcalendarなし）。Calendarは読み取り関数だけで、承認リスト・配布物と一致する', function () {
  var lib = require(path.join(ROOT, 'scripts', 'ops-reservations-gas-deploy-lib.js'));
  var manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'appsscript.json'), 'utf8'));
  assert.ok(manifest.oauthScopes.indexOf('https://www.googleapis.com/auth/calendar.readonly') !== -1);
  assert.ok(!manifest.oauthScopes.some(function (s) { return /auth\/calendar(\.events)?$/.test(s); }), '書込み可能な calendar / calendar.events は持たない');
  assert.deepStrictEqual(manifest.oauthScopes.slice().sort(), lib.APPROVED_SCOPES.slice().sort());
  assert.ok(lib.BUNDLE_FILES.indexOf('OpsInternalSlots.gs') !== -1);
  var writes = /\.(createEvent|createAllDayEvent|createEventSeries|createEventFromDescription|deleteEvent|setTag|deleteTag|setDescription|setTime|setLocation|addGuest|removeGuest|setVisibility|setColor|createCalendar|subscribeToCalendar)\(|MailApp|GmailApp|Calendar\.Events\.(insert|update|patch|remove)|(event|slot|calendar|cal)\w*\.setTitle\(/; /* HtmlService の setTitle（画面タイトル）は対象外 */
  var calendarUsers = [];
  fs.readdirSync(DIR).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (f) {
    var code = fs.readFileSync(path.join(DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!writes.test(code), f + ' にCalendarの変更・メール送信系の呼び出しがある');
    if (/CalendarApp/.test(code)) calendarUsers.push(f);
  });
  assert.deepStrictEqual(calendarUsers, ['OpsApi.gs'], 'CalendarApp は既定の読み取りアダプター（getCalendarById）だけ');
  assert.ok(/CalendarApp\.getCalendarById\(id\)/.test(fs.readFileSync(path.join(DIR, 'OpsApi.gs'), 'utf8')));
});
