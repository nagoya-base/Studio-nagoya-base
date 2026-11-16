/*
 * 運営アプリ段階1「予約一覧・詳細」（Issue #936 / 親 #935）のテスト。
 * 実際にGASへ貼り付ける gas/ops-reservations/ のファイルをvmで実行して検証する。
 * データはすべて架空（実在の予約・個人情報・認証情報を含まない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var DIR = path.join(__dirname, '..', 'gas', 'ops-reservations');
var FIXED_NOW = Date.UTC(2026, 11, 1, 2, 0, 0); /* 2026-12-01 11:00 JST */

function readFile(name) { return fs.readFileSync(path.join(DIR, name), 'utf8'); }

function loadSandbox(globals) {
  var RealDate = Date;
  function FixedDate() {
    if (arguments.length === 0) return new RealDate(FIXED_NOW);
    return new (Function.prototype.bind.apply(RealDate, [null].concat([].slice.call(arguments))))();
  }
  FixedDate.prototype = RealDate.prototype;
  FixedDate.now = function () { return FIXED_NOW; };
  FixedDate.UTC = RealDate.UTC;
  var sandbox = { Date: FixedDate, Logger: { log: function () { sandbox._logs.push([].slice.call(arguments).join(' ')); } }, _logs: [] };
  Object.keys(globals || {}).forEach(function (k) { sandbox[k] = globals[k]; });
  vm.createContext(sandbox);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(readFile(f), sandbox, { filename: f });
  });
  return sandbox;
}

var HEADER = ['bookingId', 'createdAt', 'date', 'startAt', 'endAt', 'brand', 'name', 'email', 'phone', 'people', 'purpose',
  'paymentMethod', 'status', 'note', 'checkoutAccessToken', 'stripePaymentIntentId', 'calendarEventId', 'lastMailErrorMessage',
  'paymentStatus', 'priceAmount', 'priceOverrideAmount', 'priceOverrideAt'];

function jst(y, m, d, hh, mm) { return new Date(Date.UTC(y, m - 1, d, hh - 9, mm)); }

function row(over) {
  var base = {
    bookingId: 'FAKE-001', createdAt: jst(2026, 11, 20, 10, 0), date: '2026-12-02', startAt: jst(2026, 12, 2, 10, 0), endAt: jst(2026, 12, 2, 12, 0),
    brand: 'snb', name: '架空 太郎', email: 'SECRET-EMAIL@example.invalid', phone: 'SECRET-PHONE', people: 2, purpose: '撮影', paymentMethod: 'cash',
    status: 'CONFIRMED', note: 'SECRET-NOTE', checkoutAccessToken: 'SECRET-TOKEN', stripePaymentIntentId: 'SECRET-PI', calendarEventId: 'SECRET-CAL',
    lastMailErrorMessage: 'SECRET-ERR', paymentStatus: 'not_started', priceAmount: 3000, priceOverrideAmount: '', priceOverrideAt: ''
  };
  Object.keys(over || {}).forEach(function (k) { base[k] = over[k]; });
  return HEADER.map(function (h) { return base[h]; });
}

function colIndex(letters) {
  var n = 0;
  for (var i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n - 1;
}

/* Sheets API v4 のGETだけを模した世界。日時はシリアル値（シートのタイムゾーン=JSTの壁時計）で返す。 */
function sheetWorld(rows, opts) {
  opts = opts || {};
  var header = opts.header || HEADER;
  var requests = [];
  function cell(v) {
    if (v && typeof v.getTime === 'function') return (v.getTime() + 9 * 3600 * 1000) / 86400000 + 25569;
    return v;
  }
  function respond(body, status) { return { getResponseCode: function () { return status || 200; }, getContentText: function () { return JSON.stringify(body); } }; }
  var fetch = function (url, options) {
    requests.push({ url: url, method: options && options.method, auth: options && options.headers && options.headers.Authorization });
    if (opts.fetchThrows) throw new Error('boom SECRET-ID fake-sheet-id');
    if (opts.httpStatus) return respond({ error: 'SECRET-BODY' }, opts.httpStatus);
    var decoded = decodeURIComponent(url);
    if (/\?fields=/.test(url)) {
      return respond({ properties: { timeZone: opts.timeZone || 'Asia/Tokyo' }, sheets: opts.noSheet ? [] : [{ properties: { title: 'Bookings' } }] });
    }
    if (/\/values\/'Bookings'!1:1\?/.test(decoded)) return respond({ values: [header] });
    if (/\/values:batchGet\?/.test(decoded)) {
      var ranges = decoded.split('?')[1].split('&').filter(function (x) { return /^ranges=/.test(x); });
      return respond({ valueRanges: ranges.map(function (r) {
        var letters = /'Bookings'!([A-Z]+)2:/.exec(r)[1];
        var col = colIndex(letters);
        var vals = rows.map(function (row) { var v = row[col]; return [v === undefined || v === null ? '' : cell(v)]; });
        while (vals.length && vals[vals.length - 1][0] === '') vals.pop();
        return { values: vals };
      }) });
    }
    return respond({}, 404);
  };
  return {
    requests: requests,
    UrlFetchApp: { fetch: fetch },
    ScriptApp: { getOAuthToken: function () { return 'FAKE-TOKEN'; } },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function (k) { return Object.prototype.hasOwnProperty.call(opts.props || {}, k) ? opts.props[k] : null; } }; } },
    Session: { getActiveUser: function () { return { getEmail: function () { return opts.email === undefined ? 'owner@example.invalid' : opts.email; } }; } }
  };
}

function plain(v) { return JSON.parse(JSON.stringify(v)); }

var OWNER_PROPS = { OPS_OWNER_EMAIL: 'Owner@example.invalid', OPS_SPREADSHEET_ID: 'fake-sheet-id' };

function api(rows, opts) {
  var world = sheetWorld(rows, Object.assign({ props: OWNER_PROPS }, opts || {}));
  var sb = loadSandbox(world);
  return { sb: sb, world: world };
}

/* ---- 契約・JST ---- */
test('契約: JST日付・暦日検証・サービス対応', function () {
  var sb = loadSandbox({});
  var C = sb.OpsContract;
  assert.strictEqual(C.formatJstDateTime(Date.UTC(2026, 11, 1, 15, 30)), '2026-12-02 00:30');
  assert.strictEqual(C.parseJstDate('2026-02-30'), null);
  assert.strictEqual(C.parseJstDate('2026-2-3'), null);
  assert.strictEqual(C.addDays('2026-12-01', 29), '2026-12-30');
  assert.strictEqual(C.serviceForBrand('mens').id, 'snb_mens');
  assert.strictEqual(C.serviceForBrand('studio_x').id, 'studio_x');
  assert.strictEqual(C.serviceForBrand('something_new').id, 'unclassified');
  assert.strictEqual(C.serviceForBrand('').id, 'unclassified');
});

/* ---- 正規化 ---- */
test('正規化: 許可列以外（メール・電話・備考・トークン・Stripe ID等）は結果のどこにも現れない', function () {
  var sb = loadSandbox({});
  var out = sb.OpsNormalizer.normalize([HEADER, row()]);
  var json = JSON.stringify(out);
  assert.ok(!/SECRET/.test(json), json);
  assert.strictEqual(out.records.length, 1);
});

test('正規化: 予約ID空欄・重複・不正日付・開始不正は除外して行番号と理由を返す', function () {
  var sb = loadSandbox({});
  var out = sb.OpsNormalizer.normalize([HEADER,
    row({ bookingId: '' }),
    row({ bookingId: 'A' }), row({ bookingId: 'A', date: '2026-12-03' }),
    row({ bookingId: 'B', date: '2026-02-30' }),
    row({ bookingId: 'C', date: '' }),
    row({ bookingId: 'D', startAt: '' }),
    row({ bookingId: 'OK' })
  ]);
  assert.deepStrictEqual(plain(out.records.map(function (r) { return r.bookingId; })), ['OK']);
  var byRow = {};
  out.issues.forEach(function (i) { byRow[i.row] = i.codes.join(','); });
  assert.strictEqual(byRow[2], 'missing_id');
  assert.strictEqual(byRow[3], 'duplicate_id');
  assert.strictEqual(byRow[4], 'duplicate_id');
  assert.strictEqual(byRow[5], 'invalid_date');
  assert.strictEqual(byRow[6], 'missing_date');
  assert.strictEqual(byRow[7], 'invalid_start');
});

test('正規化: 不正な行と同じIDの有効行も重複として除外する', function () {
  var sb = loadSandbox({});
  var out = sb.OpsNormalizer.normalize([HEADER,
    row({ bookingId: 'DUP', status: 'CONFIRMED' }),
    row({ bookingId: 'DUP', date: '2026-02-30', status: 'CANCELLED' })
  ]);
  assert.strictEqual(out.records.length, 0);
  assert.deepStrictEqual(plain(out.issues.map(function (i) { return i.codes.join(','); })), ['duplicate_id', 'duplicate_id,invalid_date']);
  var t = api([row({ bookingId: 'DUP' }), row({ bookingId: 'DUP', startAt: '' })], {});
  assert.strictEqual(t.sb.opsGetReservation('DUP').error.code, 'NOT_FOUND');
});

test('正規化: 0と空欄を区別し、不明なサービス・状態を既存値へ丸めない', function () {
  var sb = loadSandbox({});
  var out = sb.OpsNormalizer.normalize([HEADER,
    row({ bookingId: 'Z', people: 0, priceAmount: 0, brand: 'new_brand', status: 'WEIRD' }),
    row({ bookingId: 'E', people: '', priceAmount: '', name: '' })
  ]);
  var z = out.records[0], e = out.records[1];
  assert.strictEqual(z.people, 0);
  assert.strictEqual(z.effectivePriceAmount, 0);
  assert.strictEqual(z.service, 'unclassified');
  assert.strictEqual(z.brandRaw, 'new_brand');
  assert.strictEqual(z.status, null);
  assert.strictEqual(z.statusRaw, 'WEIRD');
  assert.strictEqual(z.statusLabel, '不明');
  assert.strictEqual(e.people, null);
  assert.strictEqual(e.effectivePriceAmount, null);
  assert.strictEqual(e.name, null);
});

test('正規化: 修正料金は修正済みのときだけ実効額になる', function () {
  var sb = loadSandbox({});
  var out = sb.OpsNormalizer.normalize([HEADER,
    row({ bookingId: 'P1', priceOverrideAmount: 2500, priceOverrideAt: jst(2026, 11, 21, 9, 0) }),
    row({ bookingId: 'P2', priceOverrideAmount: 2500, priceOverrideAt: '' })
  ]);
  assert.strictEqual(out.records[0].effectivePriceAmount, 2500);
  assert.strictEqual(out.records[0].priceOverridden, true);
  assert.strictEqual(out.records[1].effectivePriceAmount, 3000);
});

test('正規化: 日付はJST基準。UTC日付とずれる深夜帯・日またぎ・文字列時刻を扱う', function () {
  var sb = loadSandbox({});
  /* 2026-12-02 00:30 JST は UTC では 12-01 15:30。利用日が12-02ならずれ警告なし。 */
  var out = sb.OpsNormalizer.normalize([HEADER,
    row({ bookingId: 'N1', date: '2026-12-02', startAt: jst(2026, 12, 2, 0, 30), endAt: jst(2026, 12, 2, 2, 0) }),
    row({ bookingId: 'N2', date: '2026-12-01', startAt: jst(2026, 12, 2, 0, 30), endAt: jst(2026, 12, 2, 2, 0) }),
    row({ bookingId: 'N3', date: '2026-12-02', startAt: '22:00', endAt: '01:00' }),
    row({ bookingId: 'N5', date: '2026-12-02', startAt: '10:00', endAt: '09:00' }),
    row({ bookingId: 'N6', date: '2026-12-02', startAt: '10:00', endAt: '10:00' }),
    row({ bookingId: 'N7', date: '2026-12-02', startAt: jst(2026, 12, 2, 22, 0), endAt: jst(2026, 12, 3, 1, 0) }),
    row({ bookingId: 'N4', date: jst(2026, 12, 2, 0, 0), startAt: '09:00', endAt: '' })
  ]);
  var by = {};
  out.records.forEach(function (r) { by[r.bookingId] = r; });
  assert.strictEqual(by.N1.date, '2026-12-02');
  assert.strictEqual(by.N1.startAt, '2026-12-02 00:30');
  /* 時刻だけの文字列で終了<開始: 翌日へ補正せず、同日のまま警告する */
  assert.strictEqual(by.N3.endAt, '2026-12-02 01:00');
  assert.strictEqual(by.N5.endAt, '2026-12-02 09:00');
  assert.strictEqual(by.N6.endAt, '2026-12-02 10:00');
  /* 完全な日時で翌日終了が入っている場合は正式な日またぎとして扱う（警告なし） */
  assert.strictEqual(by.N7.endAt, '2026-12-03 01:00');
  assert.strictEqual(by.N4.date, '2026-12-02');
  assert.strictEqual(by.N4.endAt, null);
  var codes = {};
  out.issues.forEach(function (i) { codes[i.bookingId] = i.codes.join(','); });
  assert.strictEqual(codes.N1, undefined);
  assert.strictEqual(codes.N2, 'date_mismatch');
  assert.strictEqual(codes.N4, 'invalid_end');
  assert.strictEqual(codes.N3, 'end_before_start');
  assert.strictEqual(codes.N5, 'end_before_start');
  assert.strictEqual(codes.N6, 'end_equals_start');
  assert.strictEqual(codes.N7, undefined);
  assert.strictEqual(out.issues.filter(function (i) { return i.severity === 'error'; }).length, 0, '警告の行は一覧に残す');
});

test('正規化: 許可項目の列名が重複するヘッダーは優先順位を決めず停止する', function () {
  var sb = loadSandbox({});
  var out = sb.OpsNormalizer.normalize([HEADER.concat(['status']), row().concat(['CANCELLED'])]);
  assert.deepStrictEqual(plain(out.schemaError.duplicated), ['status']);
  assert.strictEqual(out.records.length, 0);
  /* 許可列以外の重複（例: 備考が2列）は読み取り対象外なので問題にしない */
  var ok = sb.OpsNormalizer.normalize([HEADER.concat(['note']), row().concat(['x'])]);
  assert.strictEqual(ok.schemaError, null);
});

test('取得: 元ヘッダーの重複列は固定エラーで停止し、列順変更でも正しく読める', function () {
  var dupHeader = HEADER.concat(['status']);
  var dupRows = [row().concat(['CANCELLED'])];
  var t = api(dupRows, { header: dupHeader });
  var res = t.sb.opsListReservations({});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'SCHEMA_DUPLICATE');
  assert.ok(/status/.test(res.error.message));
  assert.strictEqual(t.sb.opsGetReservation('FAKE-001').error.code, 'SCHEMA_DUPLICATE');
  /* 列順を入れ替えても、列名で対応づけて同じ結果になる */
  var reversed = HEADER.slice().reverse();
  var rows = [row({ bookingId: 'R1', status: 'CANCELLED', brand: 'studio_x' }).slice().reverse()];
  var ok = api(rows, { header: reversed }).sb.opsListReservations({ from: '2026-12-02', to: '2026-12-02' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.items[0].bookingId, 'R1');
  assert.strictEqual(ok.items[0].statusLabel, 'キャンセル');
  assert.strictEqual(ok.items[0].service, 'studio_x');
});

test('正規化: 必須列が無いシートはschemaErrorで、読み込みを続けない', function () {
  var sb = loadSandbox({});
  var out = sb.OpsNormalizer.normalize([['bookingId', 'date'], ['A', '2026-12-02']]);
  assert.deepStrictEqual(Array.from(out.schemaError.missing), ['startAt', 'brand', 'status']);
  assert.strictEqual(out.records.length, 0);
});

/* ---- 絞り込み・並び順 ---- */
function sampleRecords(sb) {
  return sb.OpsNormalizer.normalize([HEADER,
    row({ bookingId: 'T-B', date: '2026-12-01', startAt: jst(2026, 12, 1, 10, 0), endAt: jst(2026, 12, 1, 12, 0), brand: 'studio_x' }),
    row({ bookingId: 'T-A', date: '2026-12-01', startAt: jst(2026, 12, 1, 10, 0), endAt: jst(2026, 12, 1, 12, 0), brand: 'mens', status: 'CANCELLED' }),
    row({ bookingId: 'T-C', date: '2026-12-01', startAt: jst(2026, 12, 1, 10, 0), endAt: jst(2026, 12, 1, 11, 0) }),
    row({ bookingId: 'D29', date: '2026-12-30', startAt: jst(2026, 12, 30, 9, 0), endAt: jst(2026, 12, 30, 10, 0) }),
    row({ bookingId: 'D30', date: '2026-12-31', startAt: jst(2026, 12, 31, 9, 0), endAt: jst(2026, 12, 31, 10, 0) }),
    row({ bookingId: 'PAST1', date: '2026-11-30', startAt: jst(2026, 11, 30, 9, 0), endAt: jst(2026, 11, 30, 10, 0) }),
    row({ bookingId: 'PAST2', date: '2026-11-02', startAt: jst(2026, 11, 2, 9, 0), endAt: jst(2026, 11, 2, 10, 0) }),
    row({ bookingId: 'PAST31', date: '2026-11-01', startAt: jst(2026, 11, 1, 9, 0), endAt: jst(2026, 11, 1, 10, 0) })
  ]).records;
}

test('一覧: 既定は今日から30日間（今日を含み31日目は含まない）で、開始昇順・同時刻は終了→IDで安定', function () {
  var sb = loadSandbox({});
  var criteria = sb.OpsQuery.resolve({}, '2026-12-01').value;
  assert.strictEqual(criteria.from, '2026-12-01');
  assert.strictEqual(criteria.to, '2026-12-30');
  var ids = sb.OpsQuery.select(sampleRecords(sb), criteria).map(function (r) { return r.bookingId; });
  assert.deepStrictEqual(plain(ids), ['T-C', 'T-A', 'T-B', 'D29']);
});

test('一覧: 過去は直近30日を降順。取消も削除せずstatusで絞り込める', function () {
  var sb = loadSandbox({});
  var past = sb.OpsQuery.resolve({ scope: 'past' }, '2026-12-01').value;
  assert.strictEqual(past.to, '2026-11-30');
  assert.strictEqual(past.from, '2026-11-01');
  assert.deepStrictEqual(plain(sb.OpsQuery.select(sampleRecords(sb), past).map(function (r) { return r.bookingId; })), ['PAST1', 'PAST2', 'PAST31']);
  var cancelled = sb.OpsQuery.resolve({ status: 'CANCELLED' }, '2026-12-01').value;
  assert.deepStrictEqual(plain(sb.OpsQuery.select(sampleRecords(sb), cancelled).map(function (r) { return r.bookingId; })), ['T-A']);
  var mens = sb.OpsQuery.resolve({ service: 'snb_mens' }, '2026-12-01').value;
  assert.deepStrictEqual(plain(sb.OpsQuery.select(sampleRecords(sb), mens).map(function (r) { return r.bookingId; })), ['T-A']);
});

test('一覧: 不正な条件は黙って既定へ丸めずエラー', function () {
  var sb = loadSandbox({});
  ['service', 'status', 'from', 'to', 'scope'].forEach(function (k) {
    var p = {}; p[k] = 'bad';
    assert.strictEqual(sb.OpsQuery.resolve(p, '2026-12-01').error, k);
  });
  assert.strictEqual(sb.OpsQuery.resolve({ from: '2026-12-10', to: '2026-12-01' }, '2026-12-01').error, 'range');
});

/* ---- API・認可・取得状態 ---- */
test('認可: 所有者以外・未設定・メール取得不能は予約情報を一切返さない（一覧も詳細も）', function () {
  [{ email: 'other@example.invalid' }, { email: '' }, { props: { OPS_SPREADSHEET_ID: 'x' } }, { props: { OPS_OWNER_EMAIL: '', OPS_SPREADSHEET_ID: 'x' } }].forEach(function (o) {
    var t = api([row({ name: 'LEAK-CHECK' })], o);
    var list = t.sb.opsListReservations({});
    var detail = t.sb.opsGetReservation('FAKE-001');
    assert.strictEqual(list.ok, false);
    assert.strictEqual(list.error.code, 'FORBIDDEN');
    assert.strictEqual(detail.error.code, 'FORBIDDEN');
    assert.ok(!/LEAK-CHECK|FAKE-001/.test(JSON.stringify([list, detail])));
  });
});

test('認可: 所有者は大文字小文字を区別せず通り、doGetは非所有者へ画面を返さない', function () {
  var t = api([row()], {});
  assert.strictEqual(t.sb.opsListReservations({ from: '2026-12-02', to: '2026-12-02' }).ok, true);
  var denied = api([row()], { email: 'other@example.invalid' });
  var created = [];
  denied.sb.HtmlService = {
    createHtmlOutput: function (t2) { created.push('plain'); return { setTitle: function () { return t2; } }; },
    createHtmlOutputFromFile: function () { created.push('page'); return { setTitle: function () { return { addMetaTag: function () {} }; } }; }
  };
  denied.sb.doGet();
  assert.deepStrictEqual(created, ['plain']);
});

test('一覧API: 取得範囲・件数・最終取得時刻を返し、台帳全体を読み切ったことを示す。書き込みは発生しない', function () {
  var t = api([row({ bookingId: 'A1' }), row({ bookingId: 'A2', brand: 'studio_x' })], {});
  var res = t.sb.opsListReservations({ from: '2026-12-02', to: '2026-12-02' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.complete, true);
  assert.strictEqual(res.counts.sheetRows, 2);
  assert.strictEqual(res.counts.matched, 2);
  assert.strictEqual(res.fetchedAt, new Date(FIXED_NOW).toISOString());
  assert.strictEqual(res.fetchedAtJst, '2026-12-01 11:00 JST');
  assert.strictEqual(res.todayJst, '2026-12-01');
  assert.ok(!/SECRET/.test(JSON.stringify(res)));
  assert.ok(t.world.requests.length > 0);
  t.world.requests.forEach(function (r) {
    assert.strictEqual(r.method, 'get');
    assert.ok(r.url.indexOf('https://sheets.googleapis.com/v4/spreadsheets/') === 0);
    assert.strictEqual(r.auth, 'Bearer FAKE-TOKEN');
  });
  var community = res.serviceStates.filter(function (s) { return s.service === 'snb_community'; })[0];
  assert.strictEqual(community.state, 'not_connected');
});

test('一覧API: Community選択は「未接続」であり0件ではない／正常0件とも区別できる', function () {
  var t = api([row()], {});
  var c = t.sb.opsListReservations({ service: 'snb_community' });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.notConnectedSelected, true);
  var zero = t.sb.opsListReservations({ service: 'studio_x' });
  assert.strictEqual(zero.notConnectedSelected, false);
  assert.strictEqual(zero.counts.matched, 0);
  assert.strictEqual(zero.ok, true);
});

test('取得状態: 未接続・取得失敗・シート無し・列不足は成功/0件にならず、内部情報も出さない', function () {
  var noId = api([row()], { props: { OPS_OWNER_EMAIL: 'owner@example.invalid' } });
  assert.strictEqual(noId.sb.opsListReservations({}).error.code, 'NOT_CONNECTED');
  var throws = api([row()], { fetchThrows: true });
  var r = throws.sb.opsListReservations({});
  assert.strictEqual(r.error.code, 'FETCH_FAILED');
  assert.ok(!/SECRET-ID|fake-sheet-id/.test(JSON.stringify(r)));
  assert.ok(throws.sb._logs.every(function (l) { return !/SECRET-ID|fake-sheet-id/.test(l); }));
  assert.strictEqual(api([row()], { noSheet: true }).sb.opsListReservations({}).error.code, 'SHEET_NOT_FOUND');
  var http = api([row()], { httpStatus: 403 }).sb.opsListReservations({});
  assert.strictEqual(http.error.code, 'FETCH_FAILED');
  assert.ok(!/SECRET-BODY/.test(JSON.stringify(http)));
  assert.strictEqual(api([row()], { timeZone: 'America/New_York' }).sb.opsListReservations({}).error.code, 'TIMEZONE_UNSUPPORTED');
  assert.strictEqual(api([], { header: ['bookingId'] }).sb.opsListReservations({}).error.code, 'SCHEMA_MISMATCH');
  assert.strictEqual(api([row()], {}).sb.opsListReservations({ service: 'x' }).error.code, 'INVALID_PARAMS');
});

test('詳細API: 空欄・重複IDの行は別予約として表示せず、許可項目のみ返す', function () {
  var t = api([row({ bookingId: 'U1' }), row({ bookingId: 'DUP' }), row({ bookingId: 'DUP', name: '別人' }), row({ bookingId: '' })], {});
  var ok = t.sb.opsGetReservation('U1');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.reservation.bookingId, 'U1');
  assert.ok(!/SECRET/.test(JSON.stringify(ok)));
  assert.ok(!('startMs' in ok.reservation) && !('rowNumber' in ok.reservation));
  assert.strictEqual(t.sb.opsGetReservation('DUP').error.code, 'NOT_FOUND');
  assert.strictEqual(t.sb.opsGetReservation('').error.code, 'INVALID_PARAMS');
  assert.strictEqual(t.sb.opsGetReservation('nope').error.code, 'NOT_FOUND');
  var list = t.sb.opsListReservations({ from: '2026-12-02', to: '2026-12-02' });
  assert.deepStrictEqual(plain(list.items.map(function (i) { return i.bookingId; })), ['U1']);
  assert.strictEqual(list.issues.filter(function (i) { return i.severity === 'error'; }).length, 3);
});

/* ---- クライアント ---- */
function loadClient() {
  var html = readFile('OpsPage.html');
  var m = /<script>([\s\S]*?)<\/script>/.exec(html);
  var sb = {};
  vm.createContext(sb);
  vm.runInContext(m[1], sb);
  return sb.OpsClient;
}

function fakeApi() {
  var pending = { list: [], detail: [] };
  return {
    pending: pending,
    list: function (p, ok, ng) { pending.list.push({ p: p, ok: ok, ng: ng }); },
    detail: function (id, ok, ng) { pending.detail.push({ id: id, ok: ok, ng: ng }); }
  };
}

function okList(items, at) {
  return { ok: true, fetchedAt: at, applied: { from: '2026-12-01', to: '2026-12-30', order: 'asc' }, counts: { matched: items.length, sheetRows: items.length },
    serviceStates: [{ service: 'snb_community', label: 'SNB Community', state: 'not_connected' }], notConnectedSelected: false, items: items, issues: [] };
}

test('クライアント: 遅れて返った古い応答が最新結果を上書きしない', function () {
  var C = loadClient();
  var a = fakeApi();
  var ctl = C.createController(a);
  ctl.load({ service: 'snb' });
  ctl.load({ service: 'studio_x' });
  a.pending.list[1].ok(okList([{ bookingId: 'NEW', serviceLabel: 'Studio X', statusLabel: '確定', date: '2026-12-02' }], 'T2'));
  a.pending.list[0].ok(okList([{ bookingId: 'OLD', serviceLabel: 'SNB', statusLabel: '確定', date: '2026-12-02' }], 'T1'));
  assert.strictEqual(ctl.state.data.items[0].bookingId, 'NEW');
  assert.strictEqual(ctl.state.lastSuccessAt, 'T2');
  a.pending.list[0].ng();
  assert.strictEqual(ctl.state.phase, 'ready');
});

test('クライアント: 失敗は成功/0件にせず、前回データは「古いデータ」として最終成功日時つきで残す', function () {
  var C = loadClient();
  var a = fakeApi();
  var ctl = C.createController(a);
  ctl.load({});
  a.pending.list[0].ok(okList([{ bookingId: 'X', serviceLabel: 'SNB', statusLabel: '確定', date: '2026-12-02' }], '2026-12-01T02:00:00.000Z'));
  ctl.load({});
  a.pending.list[1].ng();
  assert.strictEqual(ctl.state.phase, 'error');
  assert.strictEqual(ctl.state.stale, true);
  var banner = C.renderBanner(ctl.state);
  assert.ok(/古いデータ/.test(banner) && /2026-12-01T02:00:00.000Z/.test(banner));
  /* 初回から失敗: 0件表示にならない */
  var b = fakeApi(), ctl2 = C.createController(b);
  ctl2.load({});
  b.pending.list[0].ok({ ok: false, error: { code: 'FETCH_FAILED', message: '取得に失敗' } });
  assert.strictEqual(ctl2.state.phase, 'error');
  assert.ok(!/0件/.test(C.renderView(ctl2.state)));
  var c = fakeApi(), ctl3 = C.createController(c);
  ctl3.load({});
  c.pending.list[0].ok({ ok: false, error: { code: 'NOT_CONNECTED', message: '未接続' } });
  assert.strictEqual(ctl3.state.phase, 'not_connected');
});

test('クライアント: 正常0件・未接続サービス選択・描画のエスケープ', function () {
  var C = loadClient();
  var a = fakeApi(), ctl = C.createController(a);
  ctl.load({});
  a.pending.list[0].ok(okList([], 'T'));
  assert.ok(/0件です（取得は正常に完了/.test(C.renderView(ctl.state)));
  var nc = okList([], 'T'); nc.notConnectedSelected = true;
  ctl.load({}); a.pending.list[1].ok(nc);
  var view = C.renderView(ctl.state);
  assert.ok(/未接続です。予約が0件という意味ではありません/.test(view));
  assert.ok(!/0件です/.test(view));
  var xss = okList([{ bookingId: '"><img src=x onerror=1>', serviceLabel: '<b>', statusLabel: 'x', date: '2026-12-02', startTime: '10:00', endTime: null, name: '<script>1</script>', people: 0 }], 'T');
  ctl.load({}); a.pending.list[2].ok(xss);
  var html = C.renderView(ctl.state);
  assert.ok(!/<script>|<img |<b>/.test(html), html);
  assert.ok(/0名/.test(html), '人数0は0として表示');
  assert.ok(/未入力/.test(html), '終了時刻nullは未入力');
});

test('クライアント: 詳細を開いたまま再取得すると詳細も取り直し、古い詳細を残さない', function () {
  var C = loadClient();
  var a = fakeApi(), ctl = C.createController(a);
  ctl.openDetail('A');
  a.pending.detail[0].ok({ ok: true, reservation: { bookingId: 'A', statusLabel: '確定', status: 'CONFIRMED', serviceLabel: 'SNB', service: 'snb' } });
  ctl.load({});
  assert.strictEqual(a.pending.detail.length, 2, '再取得で詳細も取得し直す');
  assert.strictEqual(a.pending.detail[1].id, 'A');
  assert.strictEqual(ctl.state.detail, null, '取得し直している間は古い詳細を表示しない');
  a.pending.detail[1].ok({ ok: true, reservation: { bookingId: 'A', statusLabel: 'キャンセル', status: 'CANCELLED', serviceLabel: 'SNB', service: 'snb' } });
  assert.strictEqual(ctl.state.detail.statusLabel, 'キャンセル');
  ctl.closeDetail();
  ctl.load({});
  assert.strictEqual(a.pending.detail.length, 2, '詳細を閉じた後の再取得では詳細を取得しない');
});

test('クライアント: 取得アダプターは差し替え可能（GAS用は google.script.run を呼ぶだけ）', function () {
  var C = loadClient();
  var calls = [];
  var fakeGoogle = { script: { run: {
    withSuccessHandler: function (ok) { this.ok = ok; return this; },
    withFailureHandler: function (ng) { this.ng = ng; return this; },
    opsListReservations: function (p) { calls.push(['list', p]); },
    opsGetReservation: function (id) { calls.push(['detail', id]); }
  } } };
  var gas = C.createGasApi(fakeGoogle);
  gas.list({ a: 1 }, function () {}, function () {});
  gas.detail('X', function () {}, function () {});
  assert.deepStrictEqual(plain(calls), [['list', { a: 1 }], ['detail', 'X']]);
});

test('クライアント: 詳細の遅延応答も最新のものだけ採用し、画面入力はAPI条件へ変換される', function () {
  var C = loadClient();
  var a = fakeApi(), ctl = C.createController(a);
  ctl.openDetail('A'); ctl.openDetail('B');
  a.pending.detail[1].ok({ ok: true, reservation: { bookingId: 'B', serviceLabel: 'SNB', statusLabel: '確定', status: 'CONFIRMED', service: 'snb', effectivePriceAmount: 0 } });
  a.pending.detail[0].ok({ ok: true, reservation: { bookingId: 'A' } });
  assert.strictEqual(ctl.state.detail.bookingId, 'B');
  assert.ok(/0円/.test(C.renderView(ctl.state)), '料金0は0円（未計算ではない）');
  ctl.closeDetail();
  assert.strictEqual(ctl.state.detailPhase, 'idle');
  assert.deepStrictEqual(Object.assign({}, C.paramsFromInputs({ service: 'all', status: 'all', scope: 'past', from: '2026-01-01', to: '' })), { service: 'all', status: 'all', scope: 'past' });
  assert.deepStrictEqual(Object.assign({}, C.paramsFromInputs({ service: 'snb', status: 'all', scope: 'custom', from: '2026-12-01', to: '2026-12-05' })), { service: 'snb', status: 'all', scope: 'upcoming', from: '2026-12-01', to: '2026-12-05' });
});

/* ---- 静的な境界（読み取り専用・非干渉） ---- */
test('境界: 読み取り専用スコープのみ・自分のみ公開・書き込み/送信APIを含まない', function () {
  var manifest = JSON.parse(readFile('appsscript.json'));
  assert.deepStrictEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/userinfo.email']);
  assert.strictEqual(manifest.webapp.access, 'MYSELF');
  var forbidden = /setValue|setValues|appendRow|insertSheet|deleteRow|\.clear\(|setProperty|MailApp|GmailApp|CalendarApp|SpreadsheetApp|LockService|DriveApp|SpreadsheetApp\.create|ANYONE/;
  fs.readdirSync(DIR).forEach(function (f) {
    var src = readFile(f);
    assert.ok(!forbidden.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), f + 'に書き込み・送信系のAPIが含まれる');
  });
});

test('境界: 既存の予約・デプロイ経路へ混在しない（workflow/manifest/既存GASから参照されない）', function () {
  var root = path.join(__dirname, '..');
  var wfDir = path.join(root, '.github', 'workflows');
  fs.readdirSync(wfDir).forEach(function (f) {
    assert.ok(!/ops-reservations/.test(fs.readFileSync(path.join(wfDir, f), 'utf8')), f + 'がops-reservationsを参照している');
  });
  var manifest = fs.readFileSync(path.join(__dirname, 'helpers', 'booking-deployment-manifest.js'), 'utf8');
  assert.ok(!/ops-reservations|Ops[A-Z]/.test(manifest));
  assert.ok(!/ops-reservations/.test(fs.readFileSync(path.join(root, 'gas', 'booking', 'README.md'), 'utf8')));
});

test('境界: 外部アクセスはSheets API v4のGETのみ。許可列以外は取得しない', function () {
  var src = readFile('OpsSource.gs').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(/method: 'get'/.test(src));
  assert.ok(!/method: '(post|put|patch|delete)'/i.test(src));
  assert.ok(!/:append|:batchUpdate|:clear|:copyTo/.test(src));
  assert.ok(/https:\/\/sheets\.googleapis\.com\/v4\/spreadsheets\//.test(src));
  var urlFetchUsers = fs.readdirSync(DIR).filter(function (f) { return /UrlFetchApp/.test(readFile(f).replace(/\/\*[\s\S]*?\*\//g, '')); });
  assert.deepStrictEqual(urlFetchUsers, ['OpsApi.gs']);
  var t = api([row()], {});
  t.sb.opsListReservations({ from: '2026-12-02', to: '2026-12-02' });
  var batch = decodeURIComponent(t.world.requests.filter(function (r) { return /batchGet/.test(r.url); })[0].url);
  var letters = {};
  HEADER.forEach(function (h, i) { letters[h] = String.fromCharCode(65 + i); });
  ['email', 'phone', 'note', 'checkoutAccessToken', 'stripePaymentIntentId', 'calendarEventId', 'lastMailErrorMessage'].forEach(function (h) {
    assert.ok(batch.indexOf("'Bookings'!" + letters[h] + '2:') === -1, h + '列を取得している');
  });
  assert.ok(batch.indexOf("'Bookings'!" + letters.bookingId + '2:') !== -1);
});

test('取得: 行数上限超過は黙って切り捨てず停止する／日時シリアルはJSTで復元される', function () {
  var sb = loadSandbox(sheetWorld([row({ bookingId: 'S1', date: jst(2026, 12, 2, 0, 0), startAt: jst(2026, 12, 2, 0, 30), endAt: jst(2026, 12, 2, 2, 0) })], { props: OWNER_PROPS }));
  var res = sb.opsListReservations({ from: '2026-12-02', to: '2026-12-02' });
  assert.strictEqual(res.items[0].date, '2026-12-02');
  assert.strictEqual(res.items[0].startTime, '00:30');
  assert.strictEqual(res.items[0].endTime, '02:00');
  var many = []; for (var i = 0; i < 20001; i++) many.push(row({ bookingId: 'M' + i }));
  assert.strictEqual(api(many, {}).sb.opsListReservations({}).error.code, 'TOO_LARGE');
});
