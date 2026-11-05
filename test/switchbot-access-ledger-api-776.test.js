/*
 * Issue #776: 台帳読取を Sheets API v4 (REST, GET のみ) に切り替え、OAuth の spreadsheets.readonly を維持する回帰テスト。
 * 実GAS・実API・実Spreadsheetには接続しない（Sheets API は test/helpers/sheets-rest-fake.js）。値はすべてダミー。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var R = require('../gas/switchbot-access/AccessLedgerReader.gs');
var SheetsFake = require('./helpers/sheets-rest-fake');

var ROOT = path.resolve(__dirname, '..');
var GAS_DIR = path.join(ROOT, 'gas', 'switchbot-access');
var NOW = Date.parse('2030-01-10T13:00:00+09:00');
var HEADERS = R.REQUIRED_COLUMNS.concat(['name', 'email']);

function row(over) {
  return Object.assign({ bookingId: 'B-1', startAt: new Date('2030-01-10T10:00:00+09:00'), endAt: new Date('2030-01-10T12:00:00+09:00'),
    brand: 'snb', status: 'confirmed', paymentMethod: 'cash', paymentStatus: 'paid', revision: 3, name: 'PII-NAME', email: 'pii@example.test' }, over || {});
}
function open(state, extra) {
  var fake = SheetsFake.create(Object.assign({ headers: HEADERS, rows: [row()] }, state || {}));
  var sheet = R.openApiSheet(Object.assign({ spreadsheetId: 'sheet-DUMMY', fetch: fake.fetch, getToken: function () { return 'tok'; } }, extra || {}));
  return { fake: fake, sheet: sheet };
}
function catches(fn) { try { fn(); } catch (e) { return e; } return null; }

// ---------------------------------------------------------------- 静的回帰（スコープと API の不整合）

function stripComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1'); }

test('静的: 宣言スコープが spreadsheets.readonly のみなら、SpreadsheetApp / SpreadsheetApp 系サービスをコードから呼ばない', function () {
  var m = JSON.parse(fs.readFileSync(path.join(GAS_DIR, 'appsscript.json'), 'utf8'));
  var readonlyOnly = m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets.readonly') !== -1 &&
    m.oauthScopes.indexOf('https://www.googleapis.com/auth/spreadsheets') === -1;
  assert.ok(readonlyOnly, '読取専用スコープを維持する（広げない）');
  assert.ok(m.oauthScopes.indexOf('https://www.googleapis.com/auth/script.external_request') !== -1, 'REST 呼出に必要');
  fs.readdirSync(GAS_DIR).filter(function (f) { return /\.gs$/.test(f); }).forEach(function (f) {
    var src = stripComments(fs.readFileSync(path.join(GAS_DIR, f), 'utf8'));
    assert.ok(!/SpreadsheetApp|openById|openByUrl|getActiveSpreadsheet|DriveApp|Sheets\.Spreadsheets/.test(src), f + ': 読取専用スコープでは承認されないサービスを呼んでいる');
  });
});

test('静的: Sheets API の呼出は GET のみ。書込み系エンドポイント・メソッドを持たない', function () {
  var src = stripComments(fs.readFileSync(path.join(GAS_DIR, 'AccessLedgerReader.gs'), 'utf8'));
  assert.ok(!/method:\s*'(post|put|patch|delete)'/i.test(src));
  assert.ok(!/:append|:batchUpdate|:clear|values:update|:copyTo|setValue|appendRow/.test(src));
  assert.ok((src.match(/method:\s*'get'/g) || []).length === 1, 'fetch の呼出元は1か所（全経路で共有）');
  // 診断と本番照合は同じ入口 sba_openLedgerSheet_ を通る
  var app = stripComments(fs.readFileSync(path.join(GAS_DIR, 'SwitchBotAccessApp.gs'), 'utf8'));
  assert.strictEqual((app.match(/sba_openLedgerSheet_\(/g) || []).length, 5, '定義1 + 本番read + 診断 + 宛先解決(#752) + verify専用診断(#789)');
  assert.strictEqual((app.match(/openApiSheet\(/g) || []).length, 1);
});

// ---------------------------------------------------------------- 呼出経路とペイロード

test('呼出: 全リクエストは GET＋Bearer トークン、書式なし値＋シリアル日時を要求し、フィールドを絞る', function () {
  var o = open();
  var r = R.readFromSheet(o.sheet, NOW, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.records.length, 1);
  o.fake.state.calls.forEach(function (c) { assert.strictEqual(c.method, 'get'); assert.ok(c.auth); });
  assert.strictEqual(o.fake.state.writes, 0);
  assert.ok(/UNFORMATTED_VALUE/.test(o.fake.state.lastQuery) && /SERIAL_NUMBER/.test(o.fake.state.lastQuery));
  assert.ok(/fields=/.test(o.fake.state.calls[0].url) && !/Bookings/.test(o.fake.state.calls[0].url), '1回目はメタ情報のみ（タイムゾーンとシート名）');
  // 個人情報列は取得しない
  assert.ok(o.fake.state.readCols.length > 0);
  assert.ok(o.fake.state.readCols.every(function (c) { return R.REQUIRED_COLUMNS.indexOf(c) !== -1; }));
  assert.ok(!JSON.stringify(r).match(/PII|pii@/));
  // 呼出回数は行数に依らず固定（メタ・ヘッダー・ID列・バッチ1回）
  assert.strictEqual(o.fake.state.calls.length, 4);
});

test('呼出: シート名が無ければ null（SCHEMA_INVALID 扱い）。シート名・IDはURLエンコードされる', function () {
  var o = open({ noSheet: true });
  assert.strictEqual(o.sheet, null);
  var o2 = open({}, { spreadsheetId: 'a/b?c' });
  assert.ok(o2.fake.state.calls[0].url.indexOf('a%2Fb%3Fc') !== -1);
});

// ---------------------------------------------------------------- 値型・タイムゾーン

test('日時: シリアル値（スプレッドシートのTZ壁時計）を正しい時刻へ。ISO文字列はそのまま、非日時列の数値は変換しない', function () {
  var o = open({ rows: [row({ bookingId: 'B-1', paymentConfirmedAt: new Date('2030-01-09T23:59:30+09:00'), revision: 7 })] });
  var rec = R.readFromSheet(o.sheet, NOW, []).records[0];
  assert.ok(rec.startAt instanceof Date || typeof rec.startAt.getTime === 'function');
  assert.strictEqual(rec.startAt.getTime(), Date.parse('2030-01-10T10:00:00+09:00'));
  assert.strictEqual(rec.endAt.getTime(), Date.parse('2030-01-10T12:00:00+09:00'));
  assert.strictEqual(rec.paymentConfirmedAt.getTime(), Date.parse('2030-01-09T23:59:30+09:00'));
  assert.strictEqual(rec.revision, 7, '日時列でない数値は変換しない');
  assert.strictEqual(rec.confirmedAt, '', '空セルは空文字');
  // ISO 文字列（テキスト保存）
  var o2 = open({ rows: [row({ startAt: '2030-01-10T10:00:00+09:00' })] });
  assert.strictEqual(R.readFromSheet(o2.sheet, NOW, []).records[0].startAt, '2030-01-10T10:00:00+09:00');
  // 秒未満の浮動小数誤差は秒に丸める
  assert.strictEqual(R.serialToDate(25569 + 0.4166666667, 'Asia/Tokyo').getTime(), Date.parse('1970-01-01T10:00:00+09:00'));
});

test('日時: 日付境界(JST 0:00)の予約が当日/翌日の窓に正しく入る（UTC/JSTのずれで落ちない）', function () {
  var rows = [
    row({ bookingId: 'T0', startAt: new Date('2030-01-10T00:00:00+09:00') }),
    row({ bookingId: 'T1', startAt: new Date('2030-01-11T23:59:00+09:00') }),
    row({ bookingId: 'OUT', startAt: new Date('2030-01-12T00:00:00+09:00') }),
    row({ bookingId: 'PREV', startAt: new Date('2030-01-09T23:59:00+09:00') })
  ];
  var ids = R.readFromSheet(open({ rows: rows }).sheet, NOW, []).records.map(function (r) { return r.bookingId; });
  assert.deepStrictEqual(ids.sort(), ['T0', 'T1']);
});

test('日時: スプレッドシートのTZが未対応なら誤読せず LEDGER_TIMEZONE_UNSUPPORTED。注入された解決関数があれば対応する', function () {
  var o = open({ tz: 'America/New_York', tzOffsetMs: -5 * 3600000 });
  var r = R.readFromSheet(o.sheet, NOW, []);
  assert.deepStrictEqual([r.ok, r.error], [false, 'LEDGER_TIMEZONE_UNSUPPORTED']);
  var o2 = open({ tz: 'America/New_York', tzOffsetMs: -5 * 3600000, rows: [row({ startAt: new Date('2030-01-10T10:00:00+09:00') })] },
    { tzOffsetMs: function (tz) { return tz === 'America/New_York' ? -5 * 3600000 : null; } });
  var r2 = R.readFromSheet(o2.sheet, NOW, []);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.records[0].startAt.getTime(), Date.parse('2030-01-10T10:00:00+09:00'));
});

// ---------------------------------------------------------------- 台帳の形

test('台帳: 列順の入替・列追加があってもヘッダー名で解決する', function () {
  var shuffled = ['name'].concat(R.REQUIRED_COLUMNS.slice().reverse()).concat(['email', 'extra1']);
  var r = R.readFromSheet(open({ headers: shuffled }).sheet, NOW, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.records[0].bookingId, 'B-1');
  assert.strictEqual(r.records[0].revision, 3);
  assert.strictEqual(r.records[0].startAt.getTime(), Date.parse('2030-01-10T10:00:00+09:00'));
  // 27列目以降（AA…）の列名でも解決できる
  var wide = [];
  for (var i = 0; i < 30; i++) wide.push('pad' + i);
  var wideHeaders = wide.concat(R.REQUIRED_COLUMNS);
  var r2 = R.readFromSheet(open({ headers: wideHeaders }).sheet, NOW, []);
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.records[0].bookingId, 'B-1');
  assert.strictEqual(R.colLetter(27), 'AA');
  assert.strictEqual(R.colLetter(52), 'AZ');
  assert.strictEqual(R.colLetter(53), 'BA');
});

test('台帳: 空（ヘッダーのみ）・必須列不足・重複列・ヘッダー無しを区別する', function () {
  assert.deepStrictEqual(R.readFromSheet(open({ rows: [] }).sheet, NOW, []), { ok: true, records: [] });
  var miss = R.readFromSheet(open({ headers: HEADERS.filter(function (h) { return h !== 'revision'; }) }).sheet, NOW, []);
  assert.deepStrictEqual([miss.ok, miss.error], [false, 'LEDGER_SCHEMA_INVALID']);
  assert.strictEqual(R.inspectSheet(open({ headers: HEADERS.concat(['status']) }).sheet).headers, 'DUPLICATE');
  assert.strictEqual(R.inspectSheet(open({ headers: [], rows: [] }).sheet).headers, 'EMPTY');
  assert.strictEqual(R.inspectSheet(null).headers, 'SHEET_MISSING');
});

test('診断: 診断と本番照合が同じアダプターで読め、末尾200行のサンプルで日時形式を検査する', function () {
  var o = open({ rows: [row(), row({ bookingId: 'B-2', startAt: new Date('2030-01-11T10:00:00+09:00') })] });
  var ins = R.inspectSheet(o.sheet);
  assert.deepStrictEqual([ins.code, ins.headers, ins.columnFormat, ins.rows, ins.sampled], ['LEDGER_ACCESS_OK', 'COMPLETE', 'OK', 2, 2]);
  var bad = R.inspectSheet(open({ rows: [row(), row({ bookingId: 'B-2', startAt: 'not a date' })] }).sheet);
  assert.deepStrictEqual([bad.code, bad.columnFormat], ['LEDGER_SCHEMA_INVALID', 'INVALID']);
  // 文字列(ISO)保存の日時でも診断は OK
  assert.strictEqual(R.inspectSheet(open({ rows: [row({ startAt: '2030-01-10T10:00:00+09:00', endAt: '2030-01-10T12:00:00+09:00' })] }).sheet).code, 'LEDGER_ACCESS_OK');
});

// ---------------------------------------------------------------- 件数・ページング

test('件数: PAGE_ROWS を超える行はページ分割して取りこぼさず読む。MAX_ROWS 超は切り捨てず LEDGER_TOO_LARGE', function () {
  var n = R.PAGE_ROWS * 2 + 5, rows = [];
  for (var i = 0; i < n; i++) rows.push(row({ bookingId: 'B-' + i, startAt: new Date('2030-01-10T10:00:00+09:00') }));
  var o = open({ rows: rows });
  var r = R.readFromSheet(o.sheet, NOW, []);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.records.length, n);
  assert.strictEqual(r.records[n - 1].bookingId, 'B-' + (n - 1));
  assert.strictEqual(o.fake.state.calls.length, 3 + 3, 'メタ・ヘッダー・ID列 + 3ページ');

  var big = [];
  for (var k = 0; k < R.MAX_ROWS + 1; k++) big.push({ bookingId: 'X' + k });
  var o2 = open({ rows: big });
  var r2 = R.readFromSheet(o2.sheet, NOW, []);
  assert.deepStrictEqual([r2.ok, r2.error], [false, 'LEDGER_TOO_LARGE']);
  assert.strictEqual(R.inspectSheet(open({ rows: big }).sheet).code, 'LEDGER_TOO_LARGE');
});

// ---------------------------------------------------------------- 失敗の分類（本文は出さない）

test('分類: HTTP状態を固定コードへ。スコープ不一致・API無効・権限・未承認を区別し、本文は返さない', function () {
  var cases = [
    [401, 'x', 'LEDGER_AUTH_REQUIRED'], [403, '{"error":{"status":"PERMISSION_DENIED"}}', 'LEDGER_ACCESS_DENIED'],
    [403, 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'LEDGER_SCOPE_INCOMPATIBLE'], [403, 'Request had insufficient authentication scopes.', 'LEDGER_SCOPE_INCOMPATIBLE'],
    [403, 'SERVICE_DISABLED', 'LEDGER_API_DISABLED'], [403, 'Google Sheets API has not been used in project 123 before', 'LEDGER_API_DISABLED'],
    [404, '', 'LEDGER_NOT_FOUND'], [429, '', 'LEDGER_RATE_LIMITED'], [500, '', 'LEDGER_READ_FAILED'], [400, '', 'LEDGER_READ_FAILED']
  ];
  cases.forEach(function (c) { assert.strictEqual(R.classifyHttp(c[0], c[1]), c[2], c[0] + ' ' + c[1]); });
  cases.forEach(function (c) {
    var fake = SheetsFake.create({ headers: HEADERS, rows: [row()], http: { code: c[0], body: c[1] + ' SECRET-IN-BODY' } });
    // メタ呼出自体が失敗するため openApiSheet が例外。コードのみを持つ
    var e = catches(function () { R.openApiSheet({ spreadsheetId: 'sheet-DUMMY', fetch: fake.fetch, getToken: function () { return 't'; } }); });
    assert.ok(e); assert.strictEqual(R.classifyError(e), c[2]);
    assert.ok(String(e.message).indexOf('SECRET-IN-BODY') === -1 && String(e.stack).indexOf('SECRET-IN-BODY') === -1);
  });
});

test('分類: 例外メッセージ（SpreadsheetApp の Required permissions 等）も固定コード。機微値入りの例外は READ_FAILED で本文を残さない', function () {
  assert.strictEqual(R.classifyError(new Error('You do not have permission to call SpreadsheetApp.openById. Required permissions: https://www.googleapis.com/auth/spreadsheets')), 'LEDGER_SCOPE_INCOMPATIBLE');
  assert.strictEqual(R.classifyError(new Error('Authorization is required to perform that action.')), 'LEDGER_AUTH_REQUIRED');
  assert.strictEqual(R.classifyError(new Error('You do not have permission to access the requested document.')), 'LEDGER_ACCESS_DENIED');
  assert.strictEqual(R.classifyError(new Error('boom PII-NAME B-1 sheet-DUMMY')), 'LEDGER_READ_FAILED');
  assert.strictEqual(R.classifyError(null), 'LEDGER_READ_FAILED');
  var forged = new Error('x'); forged.ledgerCode = 'NOT_A_KNOWN_CODE SECRET';
  assert.strictEqual(R.classifyError(forged), 'LEDGER_READ_FAILED');
  // 読取中の例外は readFromSheet / inspectSheet が握り、戻り値は固定コードのみ
  var o = open({ rows: [row()] });
  o.fake.state.http = { code: 403, body: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT PII-NAME B-1' };
  var r = R.readFromSheet(o.sheet, NOW, []);
  assert.deepStrictEqual(r, { ok: false, error: 'LEDGER_SCOPE_INCOMPATIBLE' });
  var ins = R.inspectSheet(o.sheet);
  assert.strictEqual(ins.code, 'LEDGER_SCOPE_INCOMPATIBLE');
  assert.ok(!JSON.stringify([r, ins]).match(/PII|B-1|sheet-DUMMY/));
  // fetch の例外 / getToken の例外
  var t = catches(function () { R.openApiSheet({ spreadsheetId: 'x', fetch: function () { throw new Error('Authorization is required SECRET'); }, getToken: function () { return 't'; } }); });
  assert.strictEqual(R.classifyError(t), 'LEDGER_AUTH_REQUIRED');
  var g = catches(function () { R.openApiSheet({ spreadsheetId: 'x', fetch: function () { return null; }, getToken: function () { throw new Error('Required permissions: https://www.googleapis.com/auth/script.scriptapp'); } }); });
  assert.strictEqual(R.classifyError(g), 'LEDGER_SCOPE_INCOMPATIBLE');
});

test('固定コード: 診断の許可リスト(大文字英数字と_)に収まり、通知カタログと一致する', function () {
  var infra = fs.readFileSync(path.join(GAS_DIR, 'SwitchBotAccessInfra.gs'), 'utf8');
  R.KNOWN_ERROR_CODES.forEach(function (c) {
    assert.ok(/^[A-Z][A-Z0-9_]{1,47}$/.test(c), c);
    assert.ok(new RegExp("\\n\\s+" + c + ": c\\('SYSTEM'").test(infra), c + ' が通知カタログに無い');
  });
});
