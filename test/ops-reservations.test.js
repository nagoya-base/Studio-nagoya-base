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
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsApi.gs'].forEach(function (f) {
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
    if (opts.override) {
      var o = opts.override(decodeURIComponent(url));
      if (o && o.throws) throw o.throws;
      if (o) return { getResponseCode: function () { return o.status; }, getContentText: function () { return o.text; } };
    }
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
    ScriptApp: { getOAuthToken: function () { if (opts.tokenThrows) throw new Error('SECRET-TOKEN-ERR'); return 'FAKE-TOKEN'; } },
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
  assert.strictEqual(t.sb.opsGetReservation('DUP').error.code, 'DUPLICATE_ID');
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
  assert.strictEqual(by.N1.startAt, '2026-12-02T00:30:00+09:00');
  /* 時刻だけの文字列で終了<開始: 翌日へ補正せず、同日のまま警告する */
  assert.strictEqual(by.N3.endAt, '2026-12-02T01:00:00+09:00');
  assert.strictEqual(by.N5.endAt, '2026-12-02T09:00:00+09:00');
  assert.strictEqual(by.N6.endAt, '2026-12-02T10:00:00+09:00');
  /* 完全な日時で翌日終了が入っている場合は正式な日またぎとして扱う（警告なし） */
  assert.strictEqual(by.N7.endAt, '2026-12-03T01:00:00+09:00');
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
test('認可: 所有者以外・未設定は FORBIDDEN、利用者を確認できない場合は UNAUTHENTICATED。予約情報は一切返さない', function () {
  var cases = [
    [{ email: 'other@example.invalid' }, 'FORBIDDEN'],
    [{ email: '' }, 'UNAUTHENTICATED'],
    [{ props: { OPS_SPREADSHEET_ID: 'x' } }, 'FORBIDDEN'],
    [{ props: { OPS_OWNER_EMAIL: '', OPS_SPREADSHEET_ID: 'x' } }, 'FORBIDDEN']
  ];
  cases.forEach(function (c) {
    var t = api([row({ name: 'LEAK-CHECK' })], c[0]);
    var list = t.sb.opsListReservations({});
    var detail = t.sb.opsGetReservation('FAKE-001');
    assert.strictEqual(list.ok, false);
    assert.strictEqual(list.error.code, c[1]);
    assert.strictEqual(detail.error.code, c[1]);
    assert.ok(!/LEAK-CHECK|FAKE-001/.test(JSON.stringify([list, detail])));
    assert.strictEqual(t.world.requests.length, 0, '認可に失敗した要求では台帳へ一切アクセスしない');
  });
  /* メール取得が例外になる場合も拒否（UNAUTHENTICATED） */
  var thrown = api([row()], {});
  thrown.sb.Session = { getActiveUser: function () { throw new Error('x'); } };
  assert.strictEqual(thrown.sb.opsListReservations({}).error.code, 'UNAUTHENTICATED');
});

test('認可: 判定材料は呼び出し側が渡す値ではない（paramsにメール等を入れても無視される）', function () {
  var t = api([row()], { email: 'other@example.invalid' });
  var res = t.sb.opsListReservations({ email: 'owner@example.invalid', owner: 'owner@example.invalid' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error.code, 'FORBIDDEN');
  assert.strictEqual(t.sb.opsGetReservation('FAKE-001').error.code, 'FORBIDDEN');
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
  assert.strictEqual(res.fetchedAt, '2026-12-01T11:00:00+09:00');
  assert.strictEqual(res.contractVersion, 1);
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
  assert.strictEqual(t.sb.opsGetReservation('DUP').error.code, 'DUPLICATE_ID');
  assert.strictEqual(t.sb.opsGetReservation('').error.code, 'INVALID_PARAMS');
  assert.strictEqual(t.sb.opsGetReservation('nope').error.code, 'NOT_FOUND');
  var list = t.sb.opsListReservations({ from: '2026-12-02', to: '2026-12-02' });
  assert.deepStrictEqual(plain(list.items.map(function (i) { return i.bookingId; })), ['U1']);
  assert.strictEqual(list.issues.filter(function (i) { return i.severity === 'error'; }).length, 3);
});

/* ---- 通信方式に依存しない入口・期間・フェーズ ---- */
test('入口: handle は GAS のグローバル無しでも、注入した認証器・台帳読み取りで動き、拒否時は台帳に触れない', function () {
  var sb = loadSandbox({});
  var reads = 0;
  var values = [HEADER, row({ bookingId: 'H1' })];
  var ctx = function (auth) { return { nowMs: FIXED_NOW, authenticate: function () { return auth; }, readLedger: function () { reads++; return { values: values }; } }; };
  var denied = sb.OpsApi.handle({ op: 'list', params: {} }, ctx({ ok: false, code: 'FORBIDDEN' }));
  assert.strictEqual(denied.error.code, 'FORBIDDEN');
  assert.strictEqual(sb.OpsApi.handle({ op: 'detail', id: 'H1' }, ctx({ ok: false, code: 'UNAUTHENTICATED' })).error.code, 'UNAUTHENTICATED');
  assert.strictEqual(sb.OpsApi.handle({ op: 'list' }, ctx(null)).error.code, 'UNAUTHENTICATED');
  assert.strictEqual(reads, 0);
  var ok = sb.OpsApi.handle({ op: 'list', params: { from: '2026-12-02', to: '2026-12-02' } }, ctx({ ok: true }));
  assert.strictEqual(ok.items[0].bookingId, 'H1');
  assert.strictEqual(sb.OpsApi.handle({ op: 'nope' }, ctx({ ok: true })).error.code, 'INVALID_PARAMS');
  assert.ok(sb.OpsContract.ERROR_CODES.indexOf('DUPLICATE_ID') !== -1);
});

test('認証器: 本人確認不能=UNAUTHENTICATED、不一致/所有者未設定=FORBIDDEN、大文字小文字は無視', function () {
  var sb = loadSandbox({});
  function auth(owner, active) {
    return sb.OpsAuth.createOwnerAuthenticator({ getOwnerEmail: function () { return owner; }, getActiveEmail: function () { if (active instanceof Error) throw active; return active; } })();
  }
  assert.strictEqual(auth('A@x.invalid', 'a@X.invalid').ok, true);
  assert.strictEqual(auth('a@x.invalid', 'b@x.invalid').code, 'FORBIDDEN');
  assert.strictEqual(auth(null, 'a@x.invalid').code, 'FORBIDDEN');
  assert.strictEqual(auth('a@x.invalid', '').code, 'UNAUTHENTICATED');
  assert.strictEqual(auth('a@x.invalid', null).code, 'UNAUTHENTICATED');
  assert.strictEqual(auth('a@x.invalid', new Error('x')).code, 'UNAUTHENTICATED');
});

test('期間: 始端=0:00(含む)・終端=翌0:00(含まない)の時間帯の重なりで判定し、日付またぎ・当日終了済み・利用中を落とさない', function () {
  var sb = loadSandbox({});
  var recs = sb.OpsNormalizer.normalize([HEADER,
    row({ bookingId: 'ENDED', date: '2026-12-01', startAt: jst(2026, 12, 1, 8, 0), endAt: jst(2026, 12, 1, 9, 0) }),
    row({ bookingId: 'LIVE', date: '2026-12-01', startAt: jst(2026, 12, 1, 10, 0), endAt: jst(2026, 12, 1, 12, 0) }),
    row({ bookingId: 'LATER', date: '2026-12-01', startAt: jst(2026, 12, 1, 15, 0), endAt: jst(2026, 12, 1, 16, 0) }),
    row({ bookingId: 'OVERNIGHT', date: '2026-11-30', startAt: jst(2026, 11, 30, 22, 0), endAt: jst(2026, 12, 1, 1, 0) }),
    row({ bookingId: 'ENDS_AT_MIDNIGHT', date: '2026-11-30', startAt: jst(2026, 11, 30, 22, 0), endAt: jst(2026, 12, 1, 0, 0) }),
    row({ bookingId: 'NO_END', date: '2026-12-01', startAt: jst(2026, 12, 1, 9, 30), endAt: '' }),
    row({ bookingId: 'LAST_EVENING', date: '2026-12-30', startAt: jst(2026, 12, 30, 23, 0), endAt: jst(2026, 12, 31, 2, 0) }),
    row({ bookingId: 'NEXT_DAY_START', date: '2026-12-31', startAt: jst(2026, 12, 31, 0, 0), endAt: jst(2026, 12, 31, 1, 0) })
  ]).records;
  var criteria = sb.OpsQuery.resolve({}, '2026-12-01').value;
  var rows = sb.OpsQuery.select(recs, criteria);
  assert.deepStrictEqual(plain(rows.map(function (r) { return r.bookingId; })), ['OVERNIGHT', 'ENDED', 'NO_END', 'LIVE', 'LATER', 'LAST_EVENING']);
  var phases = {};
  rows.forEach(function (r) { phases[r.bookingId] = sb.OpsQuery.phaseOf(r, FIXED_NOW); });
  assert.deepStrictEqual(plain(phases), { OVERNIGHT: 'ended', ENDED: 'ended', NO_END: 'unknown', LIVE: 'in_progress', LATER: 'upcoming', LAST_EVENING: 'upcoming' });
  /* 過去30日の範囲（〜昨日）には、前日から続く日またぎも入る（今日の範囲と重なるため両方に出る） */
  var past = sb.OpsQuery.resolve({ scope: 'past' }, '2026-12-01').value;
  var pastIds = sb.OpsQuery.select(recs, past).map(function (r) { return r.bookingId; });
  assert.ok(pastIds.indexOf('OVERNIGHT') !== -1 && pastIds.indexOf('ENDS_AT_MIDNIGHT') !== -1);
  assert.ok(pastIds.indexOf('LIVE') === -1);
});

/* ---- 静的な境界（読み取り専用・非干渉） ---- */
test('境界: 予約台帳は読み取り専用スコープ・自分のみ公開・書き込み/送信APIを含まない（#941: メモ専用のdrive.fileだけ追加）', function () {
  var manifest = JSON.parse(readFile('appsscript.json'));
  /* 予約台帳へ届くのは spreadsheets.readonly のみ。drive.file はこのアプリが作成したファイル（メモ専用）だけに届く。
     広い書込み権限（spreadsheets / drive 全体）・メール・カレンダー・トリガーは持たない。 */
  assert.deepStrictEqual(manifest.oauthScopes, ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/userinfo.email']);
  assert.strictEqual(manifest.webapp.access, 'MYSELF');
  var forbidden = /setValue|setValues|appendRow|insertSheet|deleteRow|\.clear\(|MailApp|GmailApp|CalendarApp|SpreadsheetApp|DriveApp|SpreadsheetApp\.create|ANYONE/;
  fs.readdirSync(DIR).forEach(function (f) {
    var code = readFile(f).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.ok(!forbidden.test(code), f + 'に書き込み・送信系のAPIが含まれる');
    /* 保存先IDの保存（setProperty）と排他（LockService）は、GAS専用の薄いアダプター OpsApi.gs のメモ用アダプターだけ。 */
    if (f !== 'OpsApi.gs') assert.ok(!/setProperty|LockService/.test(code), f + 'が setProperty/LockService を使っている');
  });
});

test('境界: 既存の予約・デプロイ経路へ混在しない（workflow/manifest/既存GASから参照されない）', function () {
  var root = path.join(__dirname, '..');
  var wfDir = path.join(root, '.github', 'workflows');
  // #936追加指示: 運営アプリ専用の手動デプロイworkflow 1本だけが ops-reservations を参照してよい。
  // それ以外の既存workflow（予約・決済・鍵・Webhook・Pages等）は参照しない。専用workflowの境界は
  // test/ops-reservations-gas-deploy.test.js が検査する。
  var DEDICATED = 'ops-reservations-gas-deploy.yml';
  fs.readdirSync(wfDir).forEach(function (f) {
    if (f === DEDICATED) return;
    assert.ok(!/ops-reservations/.test(fs.readFileSync(path.join(wfDir, f), 'utf8')), f + 'がops-reservationsを参照している');
  });
  assert.ok(fs.existsSync(path.join(wfDir, DEDICATED)));
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
  assert.strictEqual(res.items[0].startAt, '2026-12-02T00:30:00+09:00');
  assert.strictEqual(res.items[0].endAt, '2026-12-02T02:00:00+09:00');
  var many = []; for (var i = 0; i < 20001; i++) many.push(row({ bookingId: 'M' + i }));
  assert.strictEqual(api(many, {}).sb.opsListReservations({}).error.code, 'TOO_LARGE');
});

/* ---- 取得失敗の診断（Issue #953）。応答はすべて架空 ---- */
function googleError(status, httpCode, extra) {
  return JSON.stringify({ error: Object.assign({ code: httpCode, message: 'SECRET-GOOGLE-MESSAGE fake-sheet-id', status: status }, extra || {}) });
}
function errorInfo(reason) {
  return { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: reason, domain: 'googleapis.com', metadata: { consumer: 'projects/SECRET-PROJECT', service: 'sheets.googleapis.com' } }] };
}
function failAt(stage, spec) {
  var re = { META: /\?fields=/, HEADER: /\/values\/'Bookings'!1:1\?/, DATA: /\/values:batchGet\?/ }[stage];
  return function (url) { return re.test(url) ? spec : null; };
}
function diagOf(stage, spec, extra) {
  var t = api([row()], Object.assign({ override: failAt(stage, spec) }, extra || {}));
  var r = t.sb.opsListReservations({});
  return { res: r, t: t };
}

test('診断: HTTPエラーとGoogleの既知reason/statusを許可リストの固定コードへ分類する（API未有効化と一般の403を同一視しない）', function () {
  var cases = [
    [{ status: 403, text: googleError('PERMISSION_DENIED', 403, errorInfo('SERVICE_DISABLED')) }, 'META/API_DISABLED/403'],
    [{ status: 403, text: googleError('PERMISSION_DENIED', 403, { errors: [{ reason: 'accessNotConfigured', domain: 'usageLimits' }] }) }, 'META/API_DISABLED/403'],
    [{ status: 403, text: googleError('PERMISSION_DENIED', 403, errorInfo('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) }, 'META/SCOPE_INSUFFICIENT/403'],
    [{ status: 403, text: googleError('PERMISSION_DENIED', 403) }, 'META/PERMISSION_DENIED/403'],
    [{ status: 403, text: googleError('PERMISSION_DENIED', 403, { errors: [{ reason: 'insufficientPermissions' }] }) }, 'META/PERMISSION_DENIED/403'],
    [{ status: 403, text: googleError('PERMISSION_DENIED', 403, { errors: [{ reason: 'rateLimitExceeded' }] }) }, 'META/RATE_LIMITED/403'],
    [{ status: 403, text: '<html>SECRET-BODY</html>' }, 'META/HTTP_403_UNCLASSIFIED/403'],
    [{ status: 403, text: '{"error":"SECRET-BODY"}' }, 'META/HTTP_403_UNCLASSIFIED/403'],
    [{ status: 403, text: googleError('SECRET-STATUS', 403, errorInfo('SECRET-REASON')) }, 'META/HTTP_403_UNCLASSIFIED/403'],
    [{ status: 403, text: googleError('constructor', 403, errorInfo('__proto__')) }, 'META/HTTP_403_UNCLASSIFIED/403'],
    [{ status: 401, text: googleError('UNAUTHENTICATED', 401) }, 'META/AUTH_REJECTED/401'],
    [{ status: 401, text: '' }, 'META/AUTH_REJECTED/401'],
    [{ status: 404, text: googleError('NOT_FOUND', 404) }, 'META/TARGET_NOT_FOUND/404'],
    [{ status: 400, text: googleError('FAILED_PRECONDITION', 400) }, 'META/BAD_REQUEST/400'],
    [{ status: 429, text: googleError('RESOURCE_EXHAUSTED', 429) }, 'META/RATE_LIMITED/429'],
    [{ status: 503, text: googleError('UNAVAILABLE', 503) }, 'META/TRANSIENT/503'],
    [{ status: 500, text: 'SECRET-BODY' }, 'META/TRANSIENT/500'],
    [{ status: 418, text: 'SECRET-BODY' }, 'META/HTTP_OTHER'],
    [{ status: 200, text: '<<SECRET-BODY not json' }, 'META/PARSE_FAILED'],
    [{ throws: new Error('SECRET-EXC fake-sheet-id') }, 'META/NETWORK_EXCEPTION'],
    [{ throws: new Error('Authorization is required to perform that action.') }, 'META/EXCEPTION_AUTH_REQUIRED'],
    [{ throws: 'SECRET-STRING-THROW' }, 'META/NETWORK_EXCEPTION']
  ];
  cases.forEach(function (c) {
    var out = diagOf('META', c[0]);
    var json = JSON.stringify(out.res);
    assert.strictEqual(out.res.ok, false, c[1]);
    assert.strictEqual(out.res.error.code, 'FETCH_FAILED', c[1]);
    assert.strictEqual(out.res.error.diagnostic.code, c[1]);
    assert.ok(typeof out.res.error.diagnostic.advice === 'string' && out.res.error.diagnostic.advice.length > 20, c[1]);
    assert.ok(!/SECRET|fake-sheet-id|FAKE-TOKEN|<html>/.test(json), c[1] + ': ' + json);
    assert.ok(out.t.sb._logs.every(function (l) { return !/SECRET|fake-sheet-id|FAKE-TOKEN/.test(l); }), c[1]);
    assert.ok(out.t.sb._logs.some(function (l) { return l.indexOf(c[1]) !== -1; }), c[1] + ' がログの固定コードに残る');
  });
  var apiDisabled = diagOf('META', cases[0][0]).res.error.diagnostic;
  var plain403 = diagOf('META', cases[3][0]).res.error.diagnostic;
  assert.notStrictEqual(apiDisabled.reason, plain403.reason);
  assert.notStrictEqual(apiDisabled.advice, plain403.advice);
  assert.ok(!/有効化/.test(plain403.advice) || /とは限りません/.test(plain403.advice), '一般の403の案内でAPI未有効化と断定しない');
});

test('診断: 失敗した段階（メタ情報/ヘッダー/データ）と認証トークン取得失敗を区別する', function () {
  var denied = { status: 403, text: googleError('PERMISSION_DENIED', 403, errorInfo('SERVICE_DISABLED')) };
  assert.strictEqual(diagOf('META', denied).res.error.diagnostic.code, 'META/API_DISABLED/403');
  assert.strictEqual(diagOf('HEADER', denied).res.error.diagnostic.code, 'HEADER/API_DISABLED/403');
  assert.strictEqual(diagOf('DATA', denied).res.error.diagnostic.code, 'DATA/API_DISABLED/403');
  assert.strictEqual(diagOf('HEADER', { status: 200, text: 'x' }).res.error.diagnostic.stage, 'HEADER');
  assert.strictEqual(diagOf('DATA', { throws: new Error('x') }).res.error.diagnostic.code, 'DATA/NETWORK_EXCEPTION');
  var tok = api([row()], { tokenThrows: true }).sb.opsListReservations({});
  assert.strictEqual(tok.error.diagnostic.code, 'META/TOKEN_UNAVAILABLE');
  assert.ok(!/SECRET/.test(JSON.stringify(tok)));
});

test('診断: 詳細要求にも付き、想定外の例外は断定せずUNKNOWN。FETCH_FAILED以外の失敗には付けない', function () {
  var denied = { status: 403, text: googleError('PERMISSION_DENIED', 403, errorInfo('SERVICE_DISABLED')) };
  var t = api([row()], { override: failAt('META', denied) });
  var d = t.sb.opsGetReservation('FAKE-001');
  assert.strictEqual(d.error.code, 'FETCH_FAILED');
  assert.strictEqual(d.error.diagnostic.code, 'META/API_DISABLED/403');
  var sb = loadSandbox({ PropertiesService: { getScriptProperties: function () { return { getProperty: function () { return 'x'; } }; } } });
  var unknown = sb.OpsApi.handle({ op: 'list', params: {} }, { authenticate: function () { return { ok: true }; }, readLedger: function () { throw new Error('SECRET-UNEXPECTED'); } });
  assert.strictEqual(unknown.error.code, 'FETCH_FAILED');
  assert.strictEqual(unknown.error.diagnostic.code, 'UNKNOWN');
  assert.ok(!/SECRET/.test(JSON.stringify(unknown)));
  var forged = sb.OpsApi.handle({ op: 'list', params: {} }, { authenticate: function () { return { ok: true }; }, readLedger: function () { var e = new Error('x'); e.opsCode = 'FETCH_FAILED'; e.opsStage = 'SECRET-STAGE'; e.opsReason = 'SECRET-REASON'; e.opsHttp = 999; throw e; } });
  assert.strictEqual(forged.error.diagnostic.code, 'UNKNOWN');
  assert.ok(!/SECRET/.test(JSON.stringify(forged)));
  assert.strictEqual(api([row()], { noSheet: true }).sb.opsListReservations({}).error.diagnostic, undefined);
});

test('診断: 失敗は成功・0件として返さず、対応案は「時間をおく」だけで終わらない', function () {
  var cases = [{ status: 503, text: '' }, { throws: new Error('x') }, { status: 200, text: 'x' }, { status: 403, text: '' }];
  cases.forEach(function (spec) {
    var r = diagOf('DATA', spec).res;
    assert.strictEqual(r.ok, false);
    assert.ok(!('items' in r) && !('counts' in r));
    assert.ok(/診断コード/.test(r.error.diagnostic.advice), '診断コードの共有など次の行動を含む: ' + r.error.diagnostic.code);
  });
});

test('診断: 読み取り専用・許可リストの不変条件（既存のGET限定・scope維持）', function () {
  var manifest = JSON.parse(readFile('appsscript.json'));
  assert.deepStrictEqual(manifest.oauthScopes.filter(function (x) { return /spreadsheets/.test(x); }), ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  assert.strictEqual(manifest.webapp.access, 'MYSELF');
  var t = api([row()], { override: failAt('DATA', { status: 503, text: '' }) });
  t.sb.opsListReservations({});
  t.world.requests.forEach(function (r) { assert.strictEqual(r.method, 'get'); });
});
