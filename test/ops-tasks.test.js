/*
 * 運営アプリ「未対応メモと期限管理」（Issue #941）のテスト。
 * 実際にGASへ貼り付ける gas/ops-reservations/ のファイルをvmで実行し、Sheets API v4 を模した架空の世界
 * （メモリ上の専用スプレッドシート＋予約台帳）に対して、認可・検証・保存・再表示・競合・二重送信・失敗・保持・隔離を検証する。
 * データはすべて架空（実在の予約・個人情報・認証情報・IDを含まない）。実デプロイ・実台帳・実アカウントは使わない。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.join(__dirname, '..');
var DIR = path.join(ROOT, 'gas', 'ops-reservations');
var FRONT = path.join(ROOT, '_ops-app', 'frontend');
var contract = require('./helpers/ops-contract');
var T = require(path.join(FRONT, 'tasks-client.js'));
var Gas = require(path.join(FRONT, 'gas-adapter.js'));
var Mock = require(path.join(FRONT, 'mock-adapter.js'));

var NOW = Date.UTC(2026, 11, 1, 2, 0, 0); /* 2026-12-01 11:00 JST */
var DAY = 24 * 3600 * 1000;
var LEDGER_ID = 'FAKE-LEDGER-ID-0000000000AAAA';
var TASKS_ID = 'FAKE-TASKS-FILE-ID-00000000BBBB';
var OWNER = 'owner@example.invalid';

function readFile(name) { return fs.readFileSync(path.join(DIR, name), 'utf8'); }
function plain(v) { return JSON.parse(JSON.stringify(v)); }
/* 非同期の応答（保存→一覧の取り直し）が出揃うまで待つ。 */
function tick() { return new Promise(function (resolve) { setTimeout(resolve, 60); }); }
function code(name) { return readFile(name).replace(/\/\*[\s\S]*?\*\//g, ''); }

function loadSandbox(globals) {
  var sandbox = { Logger: { log: function () { sandbox._logs.push([].slice.call(arguments).join(' ')); } }, _logs: [] };
  Object.keys(globals || {}).forEach(function (k) { sandbox[k] = globals[k]; });
  vm.createContext(sandbox);
  ['OpsContract.gs', 'OpsNormalizer.gs', 'OpsQuery.gs', 'OpsSource.gs', 'OpsAuth.gs', 'OpsTasks.gs', 'OpsTasksStore.gs', 'OpsApi.gs'].forEach(function (f) {
    vm.runInContext(readFile(f), sandbox, { filename: f });
  });
  return sandbox;
}

/* ---- Sheets API v4 を模した架空の世界（予約台帳と、メモ専用ファイル） ---- */
function makeWorld(opts) {
  opts = opts || {};
  var files = {};
  files[LEDGER_ID] = { title: 'LEDGER', rows: [['bookingId', 'date', 'name'], ['FAKE-001', '2026-12-02', '架空 太郎']], sheetId: 11 };
  if (opts.preload) files[TASKS_ID] = { title: 'TASKS', rows: opts.preload, sheetId: 7 };
  var requests = [];
  var created = 0;
  function res(body, status) { return { getResponseCode: function () { return status || 200; }, getContentText: function () { return JSON.stringify(body); } }; }
  var world = { files: files, requests: requests, ledgerTouchedByWrite: false };
  function trim(rows) {
    var out = rows.map(function (r) { return r.slice(); });
    while (out.length && out[out.length - 1].every(function (c) { return c === ''; })) out.pop();
    return out;
  }
  world.fetch = function (url, options) {
    var method = String(options.method).toUpperCase();
    var u = decodeURIComponent(url);
    var body = options.payload ? JSON.parse(options.payload) : null;
    requests.push({ method: method, url: u, body: body, auth: options.headers && options.headers.Authorization, contentType: options.contentType });
    if (opts.fetchThrows) throw new Error('boom SECRET-ID ' + TASKS_ID);
    if (opts.failOn && opts.failOn(method, u)) return res(opts.failBody || { error: { message: 'SECRET-BODY' } }, opts.failStatus || 500);
    var base = 'https://sheets.googleapis.com/v4/spreadsheets';
    if (u.indexOf(base) !== 0) return res({}, 404);
    var rest = u.slice(base.length);
    if (rest === '' && method === 'POST') {
      created++;
      var id = 'FAKE-CREATED-FILE-ID-' + ('0000' + created).slice(-4) + 'CCCCCCCC';
      var header = body.sheets[0].data[0].rowData[0].values.map(function (c) { return c.userEnteredValue.stringValue; });
      files[id] = { title: body.properties.title, rows: [header], sheetId: 3, createBody: body };
      return res({ spreadsheetId: id });
    }
    var m = /^\/([^/:?]+)(.*)$/.exec(rest);
    var f = m && files[m[1]];
    if (m && m[1] === LEDGER_ID && method !== 'GET') world.ledgerTouchedByWrite = true;
    if (!f) return res({ error: { status: 'NOT_FOUND' } }, 404);
    var tail = m[2];
    if (method === 'GET' && /^\/values\/Tasks!A1:K\?/.test(tail)) return res({ values: trim(f.rows) });
    if (method === 'GET' && /^\?fields=/.test(tail)) return res({ sheets: [{ properties: { sheetId: f.sheetId, title: 'Tasks' } }] });
    if (method === 'POST' && /^\/values\/Tasks!A1:K:append\?valueInputOption=RAW&insertDataOption=INSERT_ROWS$/.test(tail)) {
      if (!opts.dropWrites) f.rows.push(body.values[0].slice());
      return res({ updates: { updatedRows: 1 } });
    }
    var upd = /^\/values\/Tasks!A(\d+):K(\d+)\?valueInputOption=RAW$/.exec(tail);
    if (method === 'PUT' && upd && upd[1] === upd[2]) {
      if (!opts.dropWrites) f.rows[Number(upd[1]) - 1] = body.values[0].slice();
      return res({ updatedRows: 1 });
    }
    if (method === 'POST' && tail === ':batchUpdate') {
      body.requests.forEach(function (r) {
        var rg = r.deleteDimension.range;
        if (rg.sheetId !== f.sheetId || rg.dimension !== 'ROWS' || rg.startIndex < 1) throw new Error('bad delete range');
        f.rows.splice(rg.startIndex, rg.endIndex - rg.startIndex);
      });
      return res({});
    }
    throw new Error('unexpected request: ' + method + ' ' + u);
  };
  return world;
}

function taskRow(over) {
  var t = Object.assign({ taskId: 'T-aaaaaaaa0001', title: '架空メモ', bookingId: '', service: '', status: 'todo', memo: '', dueDate: '', evidenceUrl: '',
    createdAt: '2026-11-20T10:00:00+09:00', updatedAt: '2026-11-20T10:00:00+09:00', revision: 1 }, over || {});
  return ['taskId', 'title', 'bookingId', 'service', 'status', 'memo', 'dueDate', 'evidenceUrl', 'createdAt', 'updatedAt', 'revision'].map(function (h) { return t[h]; });
}
var HEADER = ['taskId', 'title', 'bookingId', 'service', 'status', 'memo', 'dueDate', 'evidenceUrl', 'createdAt', 'updatedAt', 'revision'];

/* 実バックエンドの handle を、架空の世界・架空の認証で動かす。 */
function backend(world, o) {
  o = o || {};
  var props = Object.assign({ OPS_SPREADSHEET_ID: LEDGER_ID }, o.props || {});
  if (o.preload !== false && world.files[TASKS_ID] && !('OPS_TASKS_SPREADSHEET_ID' in props)) props.OPS_TASKS_SPREADSHEET_ID = TASKS_ID;
  var sb = loadSandbox();
  var locks = { held: 0, max: 0 };
  var tasks = {
    store: sb.OpsTasksStore.create({
      getSpreadsheetId: function () { return props.OPS_TASKS_SPREADSHEET_ID || null; },
      setSpreadsheetId: function (id) { if (o.propertyFails) throw new Error('prop'); props.OPS_TASKS_SPREADSHEET_ID = id; },
      getLedgerId: function () { return props.OPS_SPREADSHEET_ID || null; },
      fetch: world.fetch,
      getToken: function () { return 'FAKE-TOKEN'; }
    }),
    withLock: o.withLock || function (fn) { locks.held++; locks.max = Math.max(locks.max, locks.held); try { return fn(); } finally { locks.held--; } }
  };
  var auth = 'auth' in o ? o.auth : { ok: true };
  var nowMs = o.nowMs || NOW;
  return {
    sb: sb, props: props, locks: locks,
    call: function (request, at) {
      return plain(sb.OpsApi.handle(request, {
        nowMs: at || nowMs, authenticate: function () { return auth; },
        readLedger: function () { throw new Error('LEDGER READ MUST NOT HAPPEN IN TASK OPS'); }, tasks: tasks
      }));
    },
    list: function (at) { return this.call({ op: 'tasks_list' }, at); },
    save: function (input, expected, at) { return this.call({ op: 'task_save', input: input, expectedRevision: expected }, at); },
    remove: function (taskId, expected) { return this.call({ op: 'task_delete', taskId: taskId, expectedRevision: expected }); }
  };
}

function input(over) {
  return Object.assign({ taskId: 'T-newtask00001', title: '架空のDM返信', bookingId: '', service: '', status: 'todo', memo: '', dueDate: '', evidenceUrl: '' }, over || {});
}
function tasksRows(world) { return world.files[TASKS_ID] ? world.files[TASKS_ID].rows : null; }
function writes(world) { return world.requests.filter(function (r) { return r.method !== 'GET'; }); }

/* ===================== 認可 ===================== */
test('認可: 未認証・所有者以外は、一覧・保存・削除のどれも拒否し、保存先へ一切通信しない', function () {
  [{ ok: false, code: 'UNAUTHENTICATED' }, { ok: false, code: 'FORBIDDEN' }, null, {}].forEach(function (auth) {
    var world = makeWorld({ preload: [HEADER, taskRow({ title: 'LEAK-TITLE' })] });
    var b = backend(world, { auth: auth });
    [b.list(), b.save(input(), null), b.remove('T-aaaaaaaa0001', 1)].forEach(function (r) {
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.code === 'UNAUTHENTICATED' || r.error.code === 'FORBIDDEN', r.error.code);
      assert.deepStrictEqual(contract.validateError(r), []);
      assert.ok(!/LEAK/.test(JSON.stringify(r)));
    });
    assert.deepStrictEqual(world.requests, [], '認可前に保存先へ通信しない');
  });
});

test('認可(GAS入口): 所有者以外のメールでは opsListTasks/opsSaveTask/opsDeleteTask が拒否し、書き込まない', function () {
  var world = makeWorld({ preload: [HEADER, taskRow()] });
  var props = { OPS_OWNER_EMAIL: OWNER, OPS_SPREADSHEET_ID: LEDGER_ID, OPS_TASKS_SPREADSHEET_ID: TASKS_ID };
  function gas(email) {
    return loadSandbox({
      Session: { getActiveUser: function () { return { getEmail: function () { return email; } }; } },
      PropertiesService: { getScriptProperties: function () { return { getProperty: function (k) { return props[k] === undefined ? null : props[k]; }, setProperty: function (k, v) { props[k] = v; } }; } },
      LockService: { getScriptLock: function () { return { tryLock: function () { return true; }, releaseLock: function () {} }; } },
      UrlFetchApp: { fetch: world.fetch }, ScriptApp: { getOAuthToken: function () { return 'FAKE-TOKEN'; } }
    });
  }
  var other = gas('someone-else@example.invalid');
  assert.strictEqual(plain(other.opsListTasks()).error.code, 'FORBIDDEN');
  assert.strictEqual(plain(other.opsSaveTask({ input: input(), expectedRevision: null })).error.code, 'FORBIDDEN');
  assert.strictEqual(plain(other.opsDeleteTask({ taskId: 'T-aaaaaaaa0001', expectedRevision: 1 })).error.code, 'FORBIDDEN');
  assert.strictEqual(plain(gas('').opsListTasks()).error.code, 'UNAUTHENTICATED');
  assert.deepStrictEqual(world.requests, []);
  /* 所有者本人は、同じ入口で保存・再表示できる（トークンはBearerで渡るが応答には出ない）。 */
  var owner = gas(OWNER);
  var saved = plain(owner.opsSaveTask({ input: input({ title: '所有者の保存' }), expectedRevision: null }));
  assert.strictEqual(saved.ok, true, JSON.stringify(saved));
  assert.ok(!/FAKE-TOKEN/.test(JSON.stringify(saved)));
  assert.ok(world.requests.every(function (r) { return r.auth === 'Bearer FAKE-TOKEN'; }));
  assert.strictEqual(plain(owner.opsListTasks()).items.filter(function (t) { return t.title === '所有者の保存'; }).length, 1);
});

/* ===================== 保存先（手動用意の専用ファイル）・再表示（端末間） ===================== */
test('保存先未設定: 一覧は空で「未設定」を返し通信しない。保存は別ファイルを作らず、固定コードで失敗する', function () {
  var world = makeWorld();
  var b = backend(world);
  var l = b.list();
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.storeReady, false);
  assert.deepStrictEqual(l.items, []);
  var s = b.save(input({ title: '最初のメモ' }), null);
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.error.code, 'STORE_FAILED');
  assert.strictEqual(s.error.reason, 'NOT_CONFIGURED');
  assert.ok(/OPS_TASKS_SPREADSHEET_ID/.test(s.error.hint));
  assert.deepStrictEqual(contract.validateError(s), []);
  assert.deepStrictEqual(world.requests, [], '未設定では何も読まず・作らず・書かない');
  assert.strictEqual(b.props.OPS_TASKS_SPREADSHEET_ID, undefined, 'IDを勝手に設定しない');
  assert.strictEqual(Object.keys(world.files).length, 1, '台帳以外のファイルを作らない');
});

test('保存先が設定済み: 手動で用意した専用ファイルのTasks表（既存データあり）へ追記し、既存の行・他タブ相当を壊さない', function () {
  var world = makeWorld({ preload: [HEADER, taskRow({ title: '既存メモ' })] });
  var b = backend(world);
  var s = b.save(input({ title: '追加メモ' }), null);
  assert.strictEqual(s.ok, true, JSON.stringify(s));
  assert.strictEqual(tasksRows(world).length, 3);
  assert.strictEqual(tasksRows(world)[1][1], '既存メモ', '既存行は変更しない');
  assert.strictEqual(world.requests.filter(function (r) { return r.method === 'POST' && /\/v4\/spreadsheets$/.test(r.url); }).length, 0, '新規作成APIは呼ばない');
  assert.strictEqual(world.ledgerTouchedByWrite, false);
  assert.strictEqual(Object.keys(world.files).length, 2);
});

test('アクセス拒否・Tasksタブなし: 書かずに固定コード＋対応案で失敗し、IDや応答本文を出さない', function () {
  [['403', function (m, u) { return true; }, 403, /READ_HTTP\/403/, /権限|承認/],
   ['404', function () { return true; }, 404, /READ_HTTP\/404/, /見つけられません/],
   ['400(タブなし)', function () { return true; }, 400, /READ_HTTP\/400/, /Tasks/]].forEach(function (c) {
    var world = makeWorld({ preload: [HEADER], failOn: function (m, u) { return true; }, failStatus: c[2] });
    var b = backend(world);
    [b.list(), b.save(input(), null)].forEach(function (r) {
      assert.strictEqual(r.ok, false, c[0]);
      assert.strictEqual(r.error.code, 'STORE_FAILED', c[0]);
      assert.ok(c[3].test(r.error.reason), c[0] + ' ' + r.error.reason);
      assert.ok(c[4].test(r.error.hint), c[0] + ' ' + r.error.hint);
      assert.ok(!/断定した/.test(r.error.hint));
      assert.deepStrictEqual(contract.validateError(r), [], c[0]);
      assert.ok(!/SECRET|FAKE-TASKS|FAKE-TOKEN/.test(JSON.stringify(r) + b.sb._logs.join('\n')), c[0]);
    });
    assert.deepStrictEqual(writes(world), [], c[0] + ': 失敗時に書き込まない');
  });
});

test('スキーマ不正・空タブ: ヘッダーが無い/違う場合は書込み・初期化せず停止（データを壊さない）', function () {
  [['空のTasksタブ', []], ['別ヘッダー', [['a', 'b'], ['x', 'y']]], ['列が足りない', [HEADER.slice(0, 10), taskRow().slice(0, 10)]]].forEach(function (c) {
    var world = makeWorld({ preload: c[1] });
    var before = JSON.stringify(tasksRows(world));
    var r = backend(world).save(input(), null);
    assert.strictEqual(r.ok, false, c[0]);
    assert.strictEqual(r.error.reason, 'SCHEMA', c[0]);
    assert.ok(/ヘッダー/.test(r.error.hint));
    assert.deepStrictEqual(writes(world), [], c[0]);
    assert.strictEqual(JSON.stringify(tasksRows(world)), before, c[0]);
  });
});

test('再表示: 保存した内容を、別の端末（別のhandle呼び出し・再読込）で同じ内容として確認できる', function () {
  var world = makeWorld({ preload: [HEADER] });
  var phone = backend(world);
  var s = phone.save(input({ title: 'スマホで作成', memo: '一行目\n二行目', dueDate: '2026-12-05', bookingId: 'FAKE-001', service: 'snb', evidenceUrl: 'https://example.com/dm/1' }), null);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.task.revision, 1);
  assert.strictEqual(s.task.createdAt, '2026-12-01T11:00:00+09:00');
  assert.deepStrictEqual(contract.validateError({ ok: false, error: { code: 'CONFLICT', message: 'x' } }), []);
  var pc = backend(world); /* 別の端末 = 新しい実行 */
  var l = pc.list();
  assert.strictEqual(l.items.length, 1);
  var t = l.items[0];
  assert.strictEqual(t.title, 'スマホで作成');
  assert.strictEqual(t.memo, '一行目\n二行目');
  assert.strictEqual(t.dueDate, '2026-12-05');
  assert.strictEqual(t.bookingId, 'FAKE-001');
  assert.strictEqual(t.service, 'snb');
  assert.strictEqual(t.statusLabel, '未対応');
  assert.strictEqual(t.updatedAt, '2026-12-01T11:00:00+09:00');
  /* 状態変更・メモ保存も同様に再表示される。 */
  var u = phone.save(input({ taskId: t.taskId, title: 'スマホで作成', memo: '更新後メモ', status: 'doing', dueDate: '2026-12-05', bookingId: 'FAKE-001', service: 'snb', evidenceUrl: 'https://example.com/dm/1' }), t.revision, NOW + 60000);
  assert.strictEqual(u.ok, true);
  assert.strictEqual(u.task.revision, 2);
  var l2 = pc.list();
  assert.strictEqual(l2.items[0].status, 'doing');
  assert.strictEqual(l2.items[0].memo, '更新後メモ');
  assert.strictEqual(l2.items[0].createdAt, '2026-12-01T11:00:00+09:00', '作成日時は変わらない');
  assert.strictEqual(l2.items[0].updatedAt, '2026-12-01T11:01:00+09:00');
});

test('並び・集計: 期限超過が先、未完了は期限順（期限なしは後ろ）、完了は別枠。期限の当日は超過にしない', function () {
  var rows = [HEADER,
    taskRow({ taskId: 'T-aaaaaaaa0001', title: '期限なし', updatedAt: '2026-11-30T10:00:00+09:00' }),
    taskRow({ taskId: 'T-aaaaaaaa0002', title: '来週', dueDate: '2026-12-08' }),
    taskRow({ taskId: 'T-aaaaaaaa0003', title: '昨日が期限', dueDate: '2026-11-30' }),
    taskRow({ taskId: 'T-aaaaaaaa0004', title: '今日が期限', dueDate: '2026-12-01', status: 'doing' }),
    taskRow({ taskId: 'T-aaaaaaaa0005', title: '完了（期限切れでも超過にしない）', dueDate: '2026-11-01', status: 'done', updatedAt: '2026-11-30T09:00:00+09:00' }),
    taskRow({ taskId: 'T-aaaaaaaa0006', title: '先月が期限', dueDate: '2026-11-15' })];
  var l = backend(makeWorld({ preload: rows })).list();
  assert.deepStrictEqual(l.items.map(function (t) { return t.title; }), ['先月が期限', '昨日が期限', '今日が期限', '来週', '期限なし', '完了（期限切れでも超過にしない）']);
  assert.deepStrictEqual(l.items.map(function (t) { return t.overdue; }), [true, true, false, false, false, false]);
  assert.deepStrictEqual(l.counts, { open: 5, overdue: 2, done: 1, stale: 0 });
});

/* ===================== 入力検証（サーバー） ===================== */
test('検証: 件名・状態・期限・リンク・予約ID・サービス・文字数・制御文字・未知の項目を拒否し、何も書かない', function () {
  var bad = [
    ['件名なし', { title: '' }], ['件名が空白だけ', { title: '   ' }], ['件名81文字', { title: 'あ'.repeat(81) }], ['件名に制御文字', { title: 'a\u0000b' }], ['件名に改行', { title: 'a\nb' }],
    ['状態が不正', { status: 'archived' }], ['状態なし', { status: '' }],
    ['期限が実在しない日', { dueDate: '2026-02-30' }], ['期限の形式', { dueDate: '2026/12/05' }],
    ['リンクがhttp', { evidenceUrl: 'http://example.com/x' }], ['リンクがjavascript', { evidenceUrl: 'javascript:alert(1)' }], ['リンクに空白', { evidenceUrl: 'https://example.com/a b' }],
    ['リンクに認証情報', { evidenceUrl: 'https://user:pass@example.com/' }], ['リンクが301文字', { evidenceUrl: 'https://example.com/' + 'a'.repeat(290) }],
    ['予約IDに記号', { bookingId: 'A1; DROP' }], ['予約IDが65文字', { bookingId: 'A'.repeat(65) }],
    ['サービスが不正', { service: 'unknown_service' }],
    ['メモ501文字', { memo: 'あ'.repeat(501) }], ['メモに制御文字', { memo: 'a\u0007b' }],
    ['IDの形式', { taskId: 'bad id' }], ['IDなし', { taskId: '' }],
    ['保存先IDを渡す', { spreadsheetId: LEDGER_ID }], ['範囲を渡す', { range: 'Bookings!A1:Z' }], ['版番号を内容に混ぜる', { revision: 99 }], ['作成日時を渡す', { createdAt: '2000-01-01T00:00:00+09:00' }],
    ['文字列でない件名', { title: 123 }]
  ];
  bad.forEach(function (c) {
    var world = makeWorld({ preload: [HEADER] });
    var b = backend(world);
    var r = b.save(input(c[1]), null);
    assert.strictEqual(r.ok, false, c[0]);
    assert.strictEqual(r.error.code, 'INVALID_PARAMS', c[0]);
    assert.deepStrictEqual(contract.validateError(r), [], c[0]);
    assert.deepStrictEqual(world.requests, [], c[0] + ': 検証に通らない入力は保存先へ通信しない');
  });
  var w2 = makeWorld({ preload: [HEADER] });
  var b2 = backend(w2);
  ['x', 0, -1, 1.5, NaN, '1'].forEach(function (rev) {
    var r = b2.call({ op: 'task_save', input: input(), expectedRevision: rev });
    assert.strictEqual(r.error.code, 'INVALID_PARAMS', String(rev));
  });
  assert.strictEqual(b2.call({ op: 'task_save', input: 'oops', expectedRevision: null }).error.code, 'INVALID_PARAMS');
  assert.strictEqual(b2.call({ op: 'task_save', input: null, expectedRevision: null }).error.code, 'INVALID_PARAMS');
  assert.strictEqual(b2.call({ op: 'task_save', input: [input()], expectedRevision: null }).error.code, 'INVALID_PARAMS');
  assert.strictEqual(b2.remove('bad', 1).error.code, 'INVALID_PARAMS');
  assert.strictEqual(b2.remove('T-aaaaaaaa0001', 0).error.code, 'INVALID_PARAMS');
  assert.deepStrictEqual(w2.requests, []);
});

test('検証: 境界値（件名80文字・メモ500文字・予約IDなしのDM・サービス/期限/リンク任意）は保存できる', function () {
  var b = backend(makeWorld({ preload: [HEADER] }));
  assert.strictEqual(b.save(input({ title: 'あ'.repeat(80), memo: 'い'.repeat(500) }), null).ok, true);
  var dm = b.save(input({ taskId: 'T-newtask00002', title: 'DM: 利用可否の質問', evidenceUrl: 'https://example.com/dm/42' }), null);
  assert.strictEqual(dm.ok, true);
  assert.strictEqual(dm.task.bookingId, '');
  assert.strictEqual(dm.task.service, '');
  assert.strictEqual(dm.task.dueDate, '');
  assert.strictEqual(b.save(input({ taskId: 'T-newtask00003', title: ' 前後の空白は除く ' }), null).task.title, '前後の空白は除く');
});

test('保存: 式として評価されない（RAW書込み）。内容はそのまま保存・再表示される', function () {
  var world = makeWorld({ preload: [HEADER] });
  var b = backend(world);
  var evil = '=HYPERLINK("https://example.invalid","x")';
  assert.strictEqual(b.save(input({ title: evil, memo: '+SUM(1,1)\n@cmd' }), null).ok, true);
  writes(world).forEach(function (r) { assert.ok(/valueInputOption=RAW|:batchUpdate$|\/v4\/spreadsheets$/.test(r.url), r.url); });
  assert.strictEqual(b.list().items[0].title, evil);
  assert.strictEqual(tasksRows(world)[1][1], evil);
});

/* ===================== 二重送信・競合・失敗（失敗を成功にしない） ===================== */
test('二重送信(新規): 同じIDで同内容を再送しても1件だけ。別内容の再送は上書きせず競合', function () {
  var world = makeWorld({ preload: [HEADER] });
  var b = backend(world);
  var first = b.save(input({ title: '二重送信テスト' }), null);
  var again = b.save(input({ title: '二重送信テスト' }), null);
  assert.strictEqual(first.ok, true);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.replayed, true);
  assert.strictEqual(tasksRows(world).length, 2, '重複して追加しない');
  var other = b.save(input({ title: '別内容' }), null);
  assert.strictEqual(other.ok, false);
  assert.strictEqual(other.error.code, 'CONFLICT');
  assert.strictEqual(other.error.current.title, '二重送信テスト');
  assert.strictEqual(tasksRows(world)[1][1], '二重送信テスト', '黙って上書きしない');
});

test('競合(更新): 古い版での保存は上書きせず CONFLICT と最新内容を返す。反映済みの自分の再送は成功', function () {
  var world = makeWorld({ preload: [HEADER] });
  var phone = backend(world), pc = backend(world);
  var made = phone.save(input({ title: '元の内容' }), null).task;
  /* PCが先に更新（版2） */
  var pcSave = pc.save(input({ taskId: made.taskId, title: 'PCで更新', status: 'doing' }), made.revision, NOW + 1000);
  assert.strictEqual(pcSave.ok, true);
  /* スマホは古い版1のまま保存しようとする */
  var stale = phone.save(input({ taskId: made.taskId, title: 'スマホの古い編集' }), made.revision, NOW + 2000);
  assert.strictEqual(stale.ok, false);
  assert.strictEqual(stale.error.code, 'CONFLICT');
  assert.deepStrictEqual(contract.validateError({ ok: false, error: { code: stale.error.code, message: stale.error.message } }), []);
  assert.strictEqual(stale.error.current.title, 'PCで更新');
  assert.strictEqual(stale.error.current.revision, 2);
  assert.strictEqual(tasksRows(world)[1][1], 'PCで更新', '先の更新を消さない');
  /* PCの再送（通信が不安定で2回送った）: 版が進み内容が同じなら成功扱い */
  var replay = pc.save(input({ taskId: made.taskId, title: 'PCで更新', status: 'doing' }), made.revision, NOW + 3000);
  assert.strictEqual(replay.ok, true);
  assert.strictEqual(replay.replayed, true);
  assert.strictEqual(tasksRows(world)[1][10], 2, '版を重ねて進めない');
  /* スマホが最新版を見て、明示的に上書きするのは許される */
  var explicit = phone.save(input({ taskId: made.taskId, title: 'スマホの内容で上書き' }), 2, NOW + 4000);
  assert.strictEqual(explicit.ok, true);
  assert.strictEqual(explicit.task.revision, 3);
});

test('競合: 存在しない・削除済みの更新は NOT_FOUND（新規作成にすり替えない）', function () {
  var world = makeWorld({ preload: [HEADER] });
  var b = backend(world);
  var r = b.save(input({ taskId: 'T-ghost0000001' }), 1);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'NOT_FOUND');
  assert.strictEqual(tasksRows(world).length, 1);
});

test('保存失敗: 保存先がエラーを返したら成功にせず、何も保存されず、エラー本文・IDを返さない', function () {
  var cases = [
    ['append が500', { failOn: function (m, u) { return m === 'POST' && /:append/.test(u); } }],
    ['読み取りが500', { failOn: function (m) { return m === 'GET'; } }],
    ['通信例外', { fetchThrows: true }]
  ];
  cases.forEach(function (c) {
    var world = makeWorld(Object.assign({ preload: [HEADER] }, c[1]));
    var b = backend(world);
    var r = b.save(input(), null);
    assert.strictEqual(r.ok, false, c[0]);
    assert.strictEqual(r.error.code, 'STORE_FAILED', c[0]);
    assert.deepStrictEqual(contract.validateError(r), [], c[0]);
    assert.ok(/確認できていません/.test(r.error.message), c[0]);
    assert.ok(!/SECRET|FAKE-TASKS|FAKE-TOKEN|boom/.test(JSON.stringify(r) + b.sb._logs.join('\n')), c[0] + ': 本文・IDを出さない');
    assert.strictEqual(tasksRows(world).length, 1, c[0]);
  });
  var world = makeWorld({ preload: [HEADER], failOn: function (m, u) { return m === 'GET'; } });
  var l = backend(world).list();
  assert.strictEqual(l.ok, false, '一覧の取得失敗を0件・成功にしない');
  assert.strictEqual(l.error.code, 'STORE_FAILED');
});

test('保存失敗: 保存先が成功を返しても実際に保存されていなければ、読み直して検出し成功にしない', function () {
  var world = makeWorld({ preload: [HEADER], dropWrites: true });
  var b = backend(world);
  var r = b.save(input(), null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'STORE_FAILED');
  assert.strictEqual(r.error.reason, 'VERIFY');
  var w2 = makeWorld({ preload: [HEADER, taskRow()] });
  var b2 = backend(w2);
  w2.files[TASKS_ID].dropAfter = true;
  var w3 = makeWorld({ preload: [HEADER, taskRow()], dropWrites: true });
  var u = backend(w3).save(input({ taskId: 'T-aaaaaaaa0001', title: '更新' }), 1);
  assert.strictEqual(u.ok, false, '更新も照合する');
  assert.strictEqual(u.error.code, 'STORE_FAILED');
  assert.strictEqual(b2.list().items[0].title, '架空メモ');
});

test('排他: 他の保存が進行中なら BUSY（書かない）。ロック自体が使えなければ失敗扱いで書かない。保存は常に排他の中で行う', function () {
  var world = makeWorld({ preload: [HEADER] });
  var busy = backend(world, { withLock: function () { return { busy: true }; } });
  var r = busy.save(input(), null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error.code, 'BUSY');
  assert.deepStrictEqual(contract.validateError(r), []);
  assert.strictEqual(busy.remove('T-aaaaaaaa0001', 1).error.code, 'BUSY');
  var broken = backend(world, { withLock: function () { throw new Error('lock service unavailable SECRET'); } });
  var r2 = broken.save(input(), null);
  assert.strictEqual(r2.error.code, 'STORE_FAILED');
  assert.ok(!/SECRET/.test(JSON.stringify(r2)));
  assert.deepStrictEqual(writes(world), []);
  var ok = backend(world);
  ok.save(input(), null);
  assert.ok(ok.locks.max === 1 && ok.locks.held === 0, '保存はロック内（読み→書き→照合）で行い、必ず解放する');
});

test('削除: 版が一致する場合だけ削除。古い版は競合。二重削除は成功（重ねて消さない）。削除後は再表示されない', function () {
  var world = makeWorld({ preload: [HEADER, taskRow({ taskId: 'T-aaaaaaaa0001', title: 'A', revision: 2 }), taskRow({ taskId: 'T-aaaaaaaa0002', title: 'B' })] });
  var b = backend(world);
  var stale = b.remove('T-aaaaaaaa0001', 1);
  assert.strictEqual(stale.error.code, 'CONFLICT');
  assert.strictEqual(tasksRows(world).length, 3);
  var del = b.remove('T-aaaaaaaa0001', 2);
  assert.strictEqual(del.ok, true);
  assert.strictEqual(del.deleted, true);
  var again = b.remove('T-aaaaaaaa0001', 2);
  assert.strictEqual(again.ok, true);
  assert.strictEqual(again.alreadyDeleted, true);
  assert.deepStrictEqual(b.list().items.map(function (t) { return t.title; }), ['B']);
  var broken = backend(makeWorld({ preload: [HEADER, taskRow()], failOn: function (m, u) { return m === 'POST' && /batchUpdate/.test(u); } }));
  assert.strictEqual(broken.remove('T-aaaaaaaa0001', 1).error.code, 'STORE_FAILED');
});

/* ===================== 保持（180日）・個人情報の最小化 ===================== */
test('保持: 完了から180日を過ぎたメモは一覧取得時に削除し、件数を知らせる。179日・未完了は残す', function () {
  function iso(daysAgo) { return new Date(NOW - daysAgo * DAY + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00'; }
  var rows = [HEADER,
    taskRow({ taskId: 'T-aaaaaaaa0001', title: '完了181日前', status: 'done', updatedAt: iso(181) }),
    taskRow({ taskId: 'T-aaaaaaaa0002', title: '完了179日前', status: 'done', updatedAt: iso(179) }),
    taskRow({ taskId: 'T-aaaaaaaa0003', title: '完了ちょうど180日前', status: 'done', updatedAt: iso(180) }),
    taskRow({ taskId: 'T-aaaaaaaa0004', title: '未完了200日前', status: 'doing', updatedAt: iso(200) }),
    taskRow({ taskId: 'T-aaaaaaaa0005', title: '未対応1日前', updatedAt: iso(1) })];
  var world = makeWorld({ preload: rows });
  var l = backend(world).list();
  assert.strictEqual(l.ok, true);
  assert.deepStrictEqual(l.purge, { deleted: 2, failed: false });
  assert.deepStrictEqual(l.items.map(function (t) { return t.title; }).sort(), ['完了179日前', '未完了200日前', '未対応1日前'].sort());
  assert.strictEqual(tasksRows(world).length, 4, '保存先からも実際に消えている');
  var stale = l.items.filter(function (t) { return t.title === '未完了200日前'; })[0];
  assert.strictEqual(stale.stale, true, '未完了は削除せず「要見直し」');
  assert.strictEqual(l.counts.stale, 1);
  assert.strictEqual(l.retentionDays, 180);
  var l2 = backend(world).list();
  assert.deepStrictEqual(l2.purge, { deleted: 0, failed: false }, '再実行で重ねて削除しない');
});

test('保持: 期限切れの削除に失敗しても、一覧を隠さず失敗を知らせる（黙って成功にしない）', function () {
  var old = '2026-04-01T10:00:00+09:00';
  var world = makeWorld({ preload: [HEADER, taskRow({ title: '古い完了', status: 'done', updatedAt: old }), taskRow({ taskId: 'T-aaaaaaaa0002', title: '残る' })], failOn: function (m, u) { return m === 'POST' && /batchUpdate/.test(u); } });
  var l = backend(world).list();
  assert.strictEqual(l.ok, true);
  assert.deepStrictEqual(l.purge, { deleted: 0, failed: true });
  assert.strictEqual(l.items.length, 2);
  var busy = backend(world, { withLock: function () { return { busy: true }; } }).list();
  assert.strictEqual(busy.purge.failed, true);
});

test('保持: 保存する項目は必要最小限で、全文・氏名・連絡先の列を持たない。履歴表は作らない', function () {
  assert.deepStrictEqual(Array.from(loadSandbox().OpsTasks.HEADERS), HEADER);
  assert.ok(!HEADER.some(function (h) { return /name|email|phone|body|dm|message|history|audit/i.test(h); }));
  var world = makeWorld({ preload: [HEADER] });
  backend(world).save(input({ title: 'T' }), null);
  assert.deepStrictEqual(Object.keys(world.files), [LEDGER_ID, TASKS_ID], '専用ファイル1つだけ（履歴・監査用の別ファイルを作らない）');
  assert.strictEqual(world.files[TASKS_ID].rows[0].length, 11);
});

/* ===================== 予約台帳との隔離 ===================== */
test('隔離: メモ操作は予約台帳を読まず・書かず、台帳と同じIDが保存先に設定されていたら止まる', function () {
  var world = makeWorld({ preload: [HEADER, taskRow()] });
  var b = backend(world);
  b.list(); b.save(input(), null); b.remove('T-aaaaaaaa0001', 1);
  world.requests.forEach(function (r) { assert.ok(r.url.indexOf(LEDGER_ID) === -1, '台帳へ通信している: ' + r.url); });
  assert.strictEqual(world.ledgerTouchedByWrite, false);
  /* 設定ミス: 保存先IDが台帳IDと同じ */
  var w2 = makeWorld();
  var danger = backend(w2, { props: { OPS_TASKS_SPREADSHEET_ID: LEDGER_ID } });
  [danger.list(), danger.save(input(), null), danger.remove('T-aaaaaaaa0001', 1)].forEach(function (r) {
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'STORE_FAILED');
    assert.strictEqual(r.error.reason, 'TARGET_IS_LEDGER');
  });
  assert.deepStrictEqual(w2.requests, [], '台帳へ読み書きしない');
  /* 設定ミス: 形式が不正なID */
  var w3 = makeWorld();
  var bad = backend(w3, { props: { OPS_TASKS_SPREADSHEET_ID: '../../evil?x=1' } });
  assert.strictEqual(bad.save(input(), null).error.reason, 'TARGET_INVALID');
  assert.deepStrictEqual(w3.requests, []);
});

test('同期: 予約一覧の取得は手入力メモを変更・上書きせず、メモ側に書込みもしない', function () {
  var memo = taskRow({ title: '手入力メモ', memo: '予約FAKE-001の件で確認', bookingId: 'FAKE-001' });
  var world = makeWorld({ preload: [HEADER, memo] });
  var before = JSON.stringify(tasksRows(world));
  var sb = loadSandbox({
    Session: { getActiveUser: function () { return { getEmail: function () { return OWNER; } }; } },
    PropertiesService: { getScriptProperties: function () { return { getProperty: function (k) { return { OPS_OWNER_EMAIL: OWNER, OPS_SPREADSHEET_ID: LEDGER_ID, OPS_TASKS_SPREADSHEET_ID: TASKS_ID }[k] || null; } }; } },
    UrlFetchApp: { fetch: function (url, options) { world.requests.push({ method: String(options.method).toUpperCase(), url: decodeURIComponent(url) }); return { getResponseCode: function () { return 403; }, getContentText: function () { return '{}'; } }; } },
    ScriptApp: { getOAuthToken: function () { return 'FAKE-TOKEN'; } }
  });
  var r = plain(sb.opsListReservations({}));
  assert.strictEqual(r.ok, false); /* 架空の台帳取得は失敗でよい。ここで見るのはメモへ触れないこと */
  assert.ok(world.requests.every(function (q) { return q.method === 'GET' && q.url.indexOf(TASKS_ID) === -1; }), '予約取得はGETのみ・メモの保存先に触れない');
  assert.strictEqual(JSON.stringify(tasksRows(world)), before);
});

/* ===================== スキーマの異常（fail-closed） ===================== */
test('異常: 保存先のヘッダー不一致・ID重複・上限超過は、一部だけ表示・黙って上書きせず停止する', function () {
  var wrongHeader = backend(makeWorld({ preload: [['a', 'b'], ['x', 'y']] }));
  assert.strictEqual(wrongHeader.list().error.code, 'STORE_FAILED');
  assert.strictEqual(wrongHeader.save(input(), null).error.code, 'STORE_FAILED');
  var dup = makeWorld({ preload: [HEADER, taskRow(), taskRow({ title: '重複' })] });
  assert.strictEqual(backend(dup).list().error.code, 'STORE_FAILED');
  assert.strictEqual(backend(dup).save(input({ taskId: 'T-aaaaaaaa0001', title: '更新' }), 1).error.code, 'STORE_FAILED');
  var many = [HEADER];
  for (var i = 0; i < 1000; i++) many.push(taskRow({ taskId: 'T-m' + ('000000000' + i).slice(-9) }));
  var full = makeWorld({ preload: many });
  var r = backend(full).save(input(), null);
  assert.strictEqual(r.error.code, 'TOO_MANY');
  assert.deepStrictEqual(contract.validateError(r), []);
  assert.strictEqual(tasksRows(full).length, 1001);
  var broken = makeWorld({ preload: [HEADER, taskRow(), ['T-bad', 'x']] });
  var l = backend(broken).list();
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.skippedRows, 1, '壊れた行は件数で知らせる（黙って捨てない）');
});

/* ===================== 静的な境界 ===================== */
test('境界: 保存先アダプターは書込み先を設定IDに固定し、端末入力・台帳ID・他APIを使わない', function () {
  var store = code('OpsTasksStore.gs');
  assert.ok(!/UrlFetchApp|PropertiesService|ScriptApp|SpreadsheetApp|DriveApp|LockService|Session\./.test(store), '実行基盤APIはGAS専用アダプター(OpsApi.gs)から注入する');
  var urls = store.match(/https?:\/\/[^'"\s]+/g) || [];
  assert.deepStrictEqual(urls, ['https://sheets.googleapis.com/v4/spreadsheets']);
  assert.ok(!/OPS_SPREADSHEET_ID|OPS_TASKS_SPREADSHEET_ID/.test(store), 'IDの取得はdepsの関数だけ');
  assert.ok(!/\bparams\b|request\.|input\./.test(store), '端末の入力を保存先の指定に使わない');
  /* 書込み系の呼び出しは、すべて requireId_()（設定ID）経由。書込み用エンドポイントは valueInputOption=RAW / batchUpdate(deleteDimension)のみ。 */
  assert.ok(!/valueInputOption=USER_ENTERED|:clear|:copyTo|permissions|\/drive\//.test(store));
  ['append', 'updateRow', 'removeRows', 'readAll'].forEach(function (fn) {
    var m = new RegExp(fn + ': function[\\s\\S]*?var id = requireId_\\(\\)').exec(store);
    assert.ok(m, fn + ' が requireId_() で保存先を決めている');
  });
  var tasksSrc = code('OpsTasks.gs');
  assert.ok(!/OpsSource|readLedger|UrlFetchApp|PropertiesService|Session\./.test(tasksSrc), 'メモの業務ロジックは予約台帳・実行基盤に触れない');
  var apiSrc = code('OpsApi.gs');
  var tasksGas = /function tasksGas_\(\)[\s\S]*?\n  \}\n/.exec(apiSrc);
  assert.ok(tasksGas && /OPS_TASKS_SPREADSHEET_ID/.test(tasksGas[0]) && /getLedgerId[\s\S]*OPS_SPREADSHEET_ID/.test(tasksGas[0]));
  /* 台帳読み取り(OpsSource)は従来どおりGETのみで、書込みコードを持たない。 */
  var source = code('OpsSource.gs');
  assert.ok(/method: 'get'/.test(source) && !/method: '(post|put|patch|delete)'/i.test(source));
  /* UrlFetchApp を直接呼ぶのは OpsApi.gs の薄いアダプターだけ（既存の境界を維持）。 */
  var users = fs.readdirSync(DIR).filter(function (f) { return /UrlFetchApp/.test(code(f)); });
  assert.deepStrictEqual(users, ['OpsApi.gs']);
});

test('境界: 配布対象は運営アプリのファイルのみで、メモのファイルも同じ専用GAS・同じデプロイ検査の対象', function () {
  var lib = require(path.join(ROOT, 'scripts', 'ops-reservations-gas-deploy-lib.js'));
  assert.ok(lib.BUNDLE_FILES.indexOf('OpsTasks.gs') !== -1 && lib.BUNDLE_FILES.indexOf('OpsTasksStore.gs') !== -1);
  assert.deepStrictEqual(lib.APPROVED_SCOPES.slice().sort(), [
    'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/userinfo.email']);
  /* drive.file（作成ファイルのみ）は手動用意の保存先に届かないため外し、spreadsheets のみ。drive全体・readonly・旧scopeは承認リストに無い。 */
  ['drive', 'drive.file', 'spreadsheets.readonly'].forEach(function (n) { assert.ok(lib.APPROVED_SCOPES.indexOf('https://www.googleapis.com/auth/' + n) === -1, n); });
  var manifest = JSON.parse(readFile('appsscript.json'));
  assert.deepStrictEqual(manifest.oauthScopes.slice().sort(), lib.APPROVED_SCOPES.slice().sort(), 'manifestと承認リストは過不足なく一致');
  /* 書込みはメモ専用ファイルのTasks表に固定。台帳側コードは書込み・作成APIを持たない。 */
  var storeSrc = code('OpsTasksStore.gs');
  assert.ok(!/method: 'post'[^\n]*API_BASE, \{|sheets: \[\{|create: function/.test(storeSrc), '保存先を作成するコードを持たない');
});

/* ===================== 画面ロジック（フロントエンド） ===================== */
function fakeTasksApi() {
  var p = { list: [], save: [], remove: [] };
  return {
    kind: 'gas', pending: p,
    list: function (ok, ng) { p.list.push({ ok: ok, ng: ng }); },
    save: function (payload, ok, ng) { p.save.push({ payload: payload, ok: ok, ng: ng }); },
    remove: function (payload, ok, ng) { p.remove.push({ payload: payload, ok: ok, ng: ng }); }
  };
}
function listRes(items, extra) {
  var open = items.filter(function (t) { return t.status !== 'done'; });
  return Object.assign({ ok: true, contractVersion: 1, fetchedAt: '2026-12-01T11:00:00+09:00', todayJst: '2026-12-01', retentionDays: 180, storeReady: true, items: items,
    counts: { open: open.length, overdue: items.filter(function (t) { return t.overdue; }).length, done: items.length - open.length, stale: 0 }, purge: { deleted: 0, failed: false } }, extra || {});
}
function ti(over) {
  return Object.assign({ taskId: 'T-aaaaaaaa0001', title: 'メモ', bookingId: '', service: '', status: 'todo', statusLabel: '未対応', memo: '', dueDate: '', evidenceUrl: '',
    createdAt: '2026-11-20T10:00:00+09:00', updatedAt: '2026-11-20T10:00:00+09:00', revision: 1, overdue: false, stale: false }, over || {});
}

test('画面: 保存中は再送しない（二重送信防止）。成功した時だけ「保存しました」を表示し、一覧を取り直す', function () {
  var api = fakeTasksApi();
  var ctl = T.createController(api);
  var results = [];
  assert.strictEqual(ctl.save({ taskId: 'T-newtask00001', title: 'a' }, null, function (ok) { results.push(ok); }), true);
  assert.strictEqual(ctl.save({ taskId: 'T-newtask00001', title: 'a' }, null), false, '保存中の2回目は受け付けない');
  assert.strictEqual(api.pending.save.length, 1);
  assert.ok(/保存中/.test(T.renderBanner(ctl.state)));
  assert.ok(!/保存しました/.test(T.renderBanner(ctl.state)));
  api.pending.save[0].ok({ ok: true, task: ti(), fetchedAt: '2026-12-01T11:00:01+09:00' });
  assert.deepStrictEqual(results, [true]);
  assert.ok(/保存しました/.test(T.renderBanner(ctl.state)));
  assert.strictEqual(api.pending.list.length, 1, '成功後に最新の一覧を取り直す');
  assert.deepStrictEqual(api.pending.save[0].payload, { input: { taskId: 'T-newtask00001', title: 'a' }, expectedRevision: null });
  /* 同じ要求への遅れた2回目の応答は結果を二重に反映しない */
  api.pending.save[0].ok({ ok: true, task: ti() });
  assert.deepStrictEqual(results, [true]);
});

test('画面: 保存失敗・通信失敗は成功と表示せず、確認できていないことを示し、入力を閉じない（コールバックはfalse）', function () {
  var api = fakeTasksApi();
  var ctl = T.createController(api);
  var results = [];
  ctl.save({ taskId: 'T-newtask00001', title: 'a' }, null, function (ok) { results.push(ok); });
  api.pending.save[0].ok({ ok: false, error: { code: 'STORE_FAILED', message: 'メモの保存先との通信に失敗しました。保存できたか確認できていません。再読み込みして内容を確認してください。' } });
  var html = T.renderBanner(ctl.state);
  assert.strictEqual(ctl.state.save.phase, 'failed');
  assert.ok(/保存に失敗しました/.test(html) && !/保存しました/.test(html));
  assert.deepStrictEqual(results, [false]);
  /* 失敗後は同じIDで再送できる（保存中のままにならない） */
  ctl.save({ taskId: 'T-newtask00001', title: 'a' }, null, function (ok) { results.push(ok); });
  api.pending.save[1].ng(new Error('network'));
  assert.strictEqual(ctl.state.save.phase, 'failed');
  assert.ok(/確認できていません/.test(T.renderBanner(ctl.state)) && !/保存しました/.test(T.renderBanner(ctl.state)));
  assert.deepStrictEqual(results, [false, false]);
  assert.strictEqual(api.pending.save.length, 2);
  assert.strictEqual(api.pending.save[1].payload.input.taskId, 'T-newtask00001');
});

test('画面: 競合は上書きせず、最新内容を示し、一覧を取り直す。次の保存は明示的な再送', function () {
  var api = fakeTasksApi();
  var ctl = T.createController(api);
  ctl.save({ taskId: 'T-aaaaaaaa0001', title: '自分の編集' }, 1);
  api.pending.save[0].ok({ ok: false, error: { code: 'CONFLICT', message: '別の端末・操作で先に更新されています。上書きはしていません。', current: ti({ title: '先に保存された内容', revision: 2, statusLabel: '対応中', updatedAt: '2026-12-01T10:59:00+09:00' }) } });
  assert.strictEqual(ctl.state.save.phase, 'conflict');
  var html = T.renderBanner(ctl.state);
  assert.ok(/先に更新されています/.test(html) && /先に保存されている内容: 「先に保存された内容」/.test(html) && /もう一度「保存」/.test(html));
  assert.ok(!/保存しました/.test(html));
  assert.strictEqual(api.pending.list.length, 1);
  assert.strictEqual(ctl.save({ taskId: 'T-aaaaaaaa0001', title: '自分の編集' }, 2), true, '競合後は再び保存できる');
});

test('画面: 状態の切り替えは現在の版を付けて送る。削除も版つき', function () {
  var api = fakeTasksApi();
  var ctl = T.createController(api);
  ctl.load();
  api.pending.list[0].ok(listRes([ti({ memo: 'm', dueDate: '2026-12-03', revision: 4, bookingId: 'FAKE-1', service: 'snb', evidenceUrl: 'https://example.com/x' })]));
  var t = ctl.find('T-aaaaaaaa0001');
  ctl.setStatus(t, 'done');
  assert.deepStrictEqual(api.pending.save[0].payload, { input: { taskId: 'T-aaaaaaaa0001', title: 'メモ', bookingId: 'FAKE-1', service: 'snb', status: 'done', memo: 'm', dueDate: '2026-12-03', evidenceUrl: 'https://example.com/x' }, expectedRevision: 4 });
  api.pending.save[0].ok({ ok: true, task: ti({ status: 'done', revision: 5 }) });
  ctl.remove(t);
  assert.deepStrictEqual(api.pending.remove[0].payload, { taskId: 'T-aaaaaaaa0001', expectedRevision: 4 });
  Object.keys(api.pending.save[0].payload.input).forEach(function (k) { assert.ok(['taskId', 'title', 'bookingId', 'service', 'status', 'memo', 'dueDate', 'evidenceUrl'].indexOf(k) !== -1, '送る項目は許可リストだけ: ' + k); });
});

test('画面: 一覧は期限超過→未完了、完了は通常一覧から外れ、「完了を表示」で再確認できる。件数が分かる', function () {
  var api = fakeTasksApi();
  var ctl = T.createController(api);
  ctl.load();
  api.pending.list[0].ok(listRes([ti({ taskId: 'T-aaaaaaaa0001', title: '超過メモ', overdue: true, dueDate: '2026-11-30' }), ti({ taskId: 'T-aaaaaaaa0002', title: '通常メモ' }),
    ti({ taskId: 'T-aaaaaaaa0003', title: '完了メモ', status: 'done', statusLabel: '完了' })]));
  var html = T.renderList(ctl.state);
  assert.ok(html.indexOf('超過メモ') < html.indexOf('通常メモ'));
  assert.ok(/期限超過（1件）/.test(html) && /未対応・対応中（1件）/.test(html) && /完了（1件）/.test(html));
  assert.ok(!/完了メモ/.test(html), '完了は通常一覧に出さない');
  assert.ok(/未完了 2件/.test(T.renderSummary(ctl.state)) && /期限超過 1件/.test(T.renderSummary(ctl.state)));
  ctl.toggleDone();
  assert.ok(/完了メモ/.test(T.renderList(ctl.state)), '完了を表示すれば再確認できる');
  ctl.toggleDone();
  assert.ok(!/完了メモ/.test(T.renderList(ctl.state)));
});

test('画面: 取得失敗は空・成功にせず、古い内容は「最新ではない」と示す。認可失敗ではメモを消す', function () {
  var api = fakeTasksApi();
  var ctl = T.createController(api);
  ctl.load();
  api.pending.list[0].ok(listRes([ti({ title: 'SECRET-LEAK-CHECK' })]));
  ctl.load();
  api.pending.list[1].ok({ ok: false, error: { code: 'STORE_FAILED', message: 'メモの取得に失敗しました。' } });
  assert.strictEqual(ctl.state.phase, 'error');
  assert.ok(/最新ではありません/.test(T.renderBanner(ctl.state)));
  ctl.load();
  api.pending.list[2].ng();
  assert.ok(/通信エラー/.test(T.renderBanner(ctl.state)));
  ctl.load();
  api.pending.list[3].ok({ ok: false, error: { code: 'FORBIDDEN', message: '権限がありません。' } });
  assert.strictEqual(ctl.state.phase, 'denied');
  assert.ok(!/SECRET-LEAK-CHECK/.test(T.renderBanner(ctl.state) + T.renderList(ctl.state) + T.renderSummary(ctl.state)));
  /* 認可失敗の後に遅れて返った成功応答で表示を復活させない */
  var api2 = fakeTasksApi();
  var c2 = T.createController(api2);
  c2.load(); c2.load();
  api2.pending.list[1].ok({ ok: false, error: { code: 'UNAUTHENTICATED', message: '利用者を確認できません。' } });
  api2.pending.list[0].ok(listRes([ti({ title: 'SECRET-LEAK-CHECK' })]));
  assert.strictEqual(c2.state.phase, 'denied');
  assert.strictEqual(c2.state.data, null);
});

test('画面: 保存先が未設定のとき、その旨を表示する（0件の正常表示と区別）', function () {
  var api = fakeTasksApi();
  var ctl = T.createController(api);
  ctl.load();
  api.pending.list[0].ok(listRes([], { storeReady: false }));
  assert.ok(/保存先が未設定です/.test(T.renderBanner(ctl.state)));
});

test('画面: 描画はすべてエスケープし、証跡リンクはhttpsのみ（新しいタブ・opener遮断）。削除・保持の通知を表示する', function () {
  var evil = '<img src=x onerror=alert(1)>';
  var html = T.renderCard(ti({ title: evil, memo: evil, bookingId: evil, evidenceUrl: 'https://example.com/a?x=1&y=2' }));
  assert.ok(!/<img/.test(html) && /&lt;img/.test(html));
  assert.ok(/href="https:\/\/example\.com\/a\?x=1&amp;y=2"/.test(html) && /rel="noopener noreferrer"/.test(html) && /target="_blank"/.test(html));
  ['javascript:alert(1)', 'http://example.com', 'data:text/html,x', 'https://a b'].forEach(function (u) {
    assert.ok(!/<a /.test(T.renderCard(ti({ evidenceUrl: u }))), u);
  });
  var api = fakeTasksApi();
  var ctl = T.createController(api);
  ctl.load();
  api.pending.list[0].ok(listRes([], { purge: { deleted: 3, failed: false } }));
  assert.ok(/180日を過ぎたメモ 3件を削除しました/.test(T.renderBanner(ctl.state)));
  assert.ok(/完了から180日を過ぎたメモは自動で削除/.test(T.renderList(ctl.state)));
  assert.ok(!/<script/.test(T.renderBanner(Object.assign({}, ctl.state, { error: { message: '<script>' }, phase: 'error', stale: false }))));
});

test('画面: 新規メモのIDは形式を満たし、重複しない（サーバー検証と同じ形式）', function () {
  var seen = {};
  for (var i = 0; i < 200; i++) {
    var id = T.newTaskId();
    assert.ok(/^T-[0-9a-z]{8,32}$/.test(id), id);
    assert.ok(!seen[id]);
    seen[id] = true;
  }
});

/* ===================== アダプターとモック ===================== */
test('GASアダプター(メモ): 呼ぶのは3関数だけで、保存先ID・範囲は渡さない。通信失敗は ng', function () {
  var calls = [];
  function runner(handlers) {
    return {
      withSuccessHandler: function (ok) {
        return {
          withFailureHandler: function (ng) {
            return new Proxy({}, { get: function (_, name) { return function (arg) { calls.push([name, arg]); handlers[name](arg, ok, ng); }; } });
          }
        };
      }
    };
  }
  var api = Gas.createGasTasksApi(runner({
    opsListTasks: function (a, ok) { ok({ ok: true }); }, opsSaveTask: function (a, ok) { ok({ ok: true, echo: a }); }, opsDeleteTask: function (a, ok, ng) { ng(new Error('x')); }
  }));
  assert.strictEqual(api.kind, 'gas');
  var got = [];
  api.list(function (r) { got.push(r); }, function () { throw new Error('unexpected'); });
  api.save({ input: { title: 'a' }, expectedRevision: null }, function (r) { got.push(r); }, function () { throw new Error('unexpected'); });
  var failed = 0;
  api.remove({ taskId: 'T-aaaaaaaa0001', expectedRevision: 1 }, function () { throw new Error('unexpected'); }, function () { failed++; });
  assert.strictEqual(failed, 1);
  assert.deepStrictEqual(calls.map(function (c) { return c[0]; }), ['opsListTasks', 'opsSaveTask', 'opsDeleteTask']);
  assert.ok(!/spreadsheet|range|sheetId/i.test(JSON.stringify(calls)));
  var thrown = 0;
  Gas.createGasTasksApi({ withSuccessHandler: function () { throw new Error('x'); } }).save({}, function () {}, function () { thrown++; });
  assert.strictEqual(thrown, 1);
});

test('モック(メモ): 契約どおり（版による競合・冪等な新規・削除の冪等）で、画面に「モック」と表示される', async function () {
  var api = Mock.createMockTasksApi({ scenario: 'ok', nowMs: NOW, defer: function (fn) { fn(); } });
  function call(name, arg) { return new Promise(function (resolve) { if (arg === undefined) api[name](resolve); else api[name](arg, resolve); }); }
  var l = await call('list');
  assert.strictEqual(l.ok, true);
  assert.ok(l.items.length >= 3 && l.items[0].overdue, '期限超過が先頭');
  var created = await call('save', { input: { taskId: 'T-mockbbbb0001', title: '新規', status: 'todo' }, expectedRevision: null });
  assert.strictEqual(created.ok, true);
  assert.strictEqual((await call('save', { input: { taskId: 'T-mockbbbb0001', title: '新規', status: 'todo' }, expectedRevision: null })).replayed, true);
  assert.strictEqual((await call('save', { input: { taskId: 'T-mockbbbb0001', title: '別', status: 'todo' }, expectedRevision: null })).error.code, 'CONFLICT');
  assert.strictEqual((await call('save', { input: { taskId: 'T-mockbbbb0001', title: '更新', status: 'doing' }, expectedRevision: 9 })).error.code, 'CONFLICT');
  assert.strictEqual((await call('save', { input: { taskId: 'T-mockbbbb0001', title: '更新', status: 'doing' }, expectedRevision: 1 })).task.revision, 2);
  assert.strictEqual((await call('remove', { taskId: 'T-mockbbbb0001', expectedRevision: 2 })).deleted, true);
  assert.strictEqual((await call('remove', { taskId: 'T-mockbbbb0001', expectedRevision: 2 })).alreadyDeleted, true);
  var ctl = T.createController(api);
  assert.ok(/モックデータ（架空）/.test(T.renderBanner(ctl.state)));
  var failing = Mock.createMockTasksApi({ scenario: 'save_error', nowMs: NOW, defer: function (fn) { fn(); } });
  var f = await new Promise(function (resolve) { failing.save({ input: { taskId: 'T-mockbbbb0002', title: 'x', status: 'todo' }, expectedRevision: null }, resolve); });
  assert.strictEqual(f.ok, false);
  assert.deepStrictEqual(contract.validateError(f), []);
  var denied = await new Promise(function (resolve) { Mock.createMockTasksApi({ scenario: 'denied', defer: function (fn) { fn(); } }).list(resolve); });
  assert.deepStrictEqual(contract.validateError(denied), []);
});

/* ===================== 結合: 実バックエンド＋実画面ロジック（架空の保存先） ===================== */
test('結合(架空): スマホで作成→状態変更→メモ保存、別端末（PC）で同じ内容を確認。競合・保存失敗も画面に出る', async function () {
  var world = makeWorld({ preload: [HEADER] });
  var b = backend(world);
  function runnerFor(be) {
    function make(ok) {
      return new Proxy({}, { get: function (_, name) {
        return function (arg) {
          var res;
          if (name === 'opsListTasks') res = be.list();
          else if (name === 'opsSaveTask') res = be.call({ op: 'task_save', input: arg.input, expectedRevision: arg.expectedRevision });
          else if (name === 'opsDeleteTask') res = be.call({ op: 'task_delete', taskId: arg.taskId, expectedRevision: arg.expectedRevision });
          else throw new Error('unknown ' + name);
          setTimeout(function () { ok(res); }, 0);
        };
      } });
    }
    return { withSuccessHandler: function (ok) { return { withFailureHandler: function () { return make(ok); } }; } };
  }
  var phone = T.createController(Gas.createGasTasksApi(runnerFor(b)));
  var pc = T.createController(Gas.createGasTasksApi(runnerFor(backend(world))));
  var id = T.newTaskId();
  phone.save({ taskId: id, title: '統合テスト', status: 'todo', memo: '', dueDate: '2026-11-30', bookingId: '', service: '', evidenceUrl: '' }, null);
  await tick();
  assert.strictEqual(phone.state.save.phase, 'saved');
  assert.ok(/統合テスト/.test(T.renderList(phone.state)), '保存後に取り直した一覧に出る');
  assert.ok(/期限超過（1件）/.test(T.renderList(phone.state)), '期限が過ぎた未完了は超過として出る');
  pc.load(); await tick();
  assert.ok(/統合テスト/.test(T.renderList(pc.state)), '別端末でも同じ内容');
  /* PCが先に完了へ → スマホの古い版での保存は競合として表示される */
  var staleTask = phone.find(id);
  pc.setStatus(pc.find(id), 'done'); await tick();
  assert.strictEqual(pc.state.save.phase, 'saved');
  phone.setStatus(staleTask, 'doing'); await tick();
  assert.strictEqual(phone.state.save.phase, 'conflict');
  assert.ok(/先に更新されています/.test(T.renderBanner(phone.state)));
  assert.strictEqual(tasksRows(world)[1][4], 'done', '先の更新は消えていない');
  assert.ok(!/統合テスト/.test(T.renderList(phone.state)), '完了は通常一覧から外れる');
  phone.toggleDone();
  assert.ok(/統合テスト/.test(T.renderList(phone.state)), '完了も再確認できる');
  /* 保存先の障害: 成功と表示しない */
  var down = T.createController(Gas.createGasTasksApi(runnerFor(backend(makeWorld({ preload: [HEADER], failOn: function (m, u) { return m === 'POST'; } })))));
  down.save({ taskId: T.newTaskId(), title: '失敗する保存', status: 'todo', memo: '', dueDate: '', bookingId: '', service: '', evidenceUrl: '' }, null); await tick();
  assert.strictEqual(down.state.save.phase, 'failed');
  assert.ok(!/保存しました/.test(T.renderBanner(down.state)));
  /* 所有者以外: 何も表示されない */
  var intruder = T.createController(Gas.createGasTasksApi(runnerFor(backend(world, { auth: { ok: false, code: 'FORBIDDEN' } }))));
  intruder.load(); await tick();
  assert.strictEqual(intruder.state.phase, 'denied');
  assert.ok(!/統合テスト/.test(T.renderBanner(intruder.state) + T.renderList(intruder.state)));
});

test('文書: 保存先・保持/削除基準・退避/復旧・初回設定が記載されている', function () {
  var doc = fs.readFileSync(path.join(ROOT, 'docs', 'ops-tasks-941.md'), 'utf8');
  ['保存先', '180日', '削除', '退避', '復旧', '初回', 'spreadsheets', '競合', '二重送信', '未実施'].forEach(function (w) { assert.ok(doc.indexOf(w) !== -1, w); });
  assert.ok(!/AKfycb[0-9A-Za-z_-]{10,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|jp|net)\b/.test(doc), '実在のID・メールを書かない');
});

/* ===================== レビュー指摘(#957): 下書きの保護・読込不可行の警告 ===================== */
/* mount を実際に動かすための最小の疑似DOM（要素は id ごとに1つ。イベントは addEventListener したものを呼ぶ）。 */
function fakeDoc() {
  var els = {};
  function el(id) {
    if (!els[id]) {
      els[id] = { id: id, value: '', hidden: false, disabled: false, innerHTML: '', textContent: '', _l: {}, _attr: {},
        addEventListener: function (t, f) { (this._l[t] = this._l[t] || []).push(f); },
        setAttribute: function (k, v) { this._attr[k] = v; }, getAttribute: function (k) { return this._attr[k] === undefined ? null : this._attr[k]; },
        focus: function () {}, parentNode: null };
    }
    return els[id];
  }
  function fire(id, type, extra) { var ev = Object.assign({ preventDefault: function () {}, target: el(id) }, extra || {}); (el(id)._l[type] || []).forEach(function (f) { f(ev); }); }
  return { getElementById: el, el: el, fire: fire };
}
function button(attrs) { return { getAttribute: function (k) { return attrs[k] === undefined ? null : attrs[k]; }, parentNode: null }; }
function mounted(api) {
  var doc = fakeDoc();
  var ctl = T.mount(doc, api, { confirm: function () { return true; } });
  return { doc: doc, ctl: ctl };
}
function fillForm(doc, title) { doc.el('t-title').value = title; doc.el('t-status').value = 'todo'; }

test('回帰(P2): 保存中は下書きを切り替える操作（追加・編集・キャンセル・状態変更・入力）が止まり、入力欄は無効になる', function () {
  var api = fakeTasksApi();
  var m = mounted(api);
  m.doc.fire('tab-tasks', 'click');
  api.pending.list[0].ok(listRes([ti({ taskId: 'T-aaaaaaaa0001', title: '既存' })]));
  m.doc.fire('t-new', 'click');
  fillForm(m.doc, '下書きA');
  m.doc.fire('t-form', 'submit');
  assert.strictEqual(api.pending.save.length, 1);
  ['t-title', 't-memo', 't-due', 't-url', 't-service', 't-status', 't-booking', 't-cancel', 't-new', 't-submit'].forEach(function (id) { assert.strictEqual(m.doc.el(id).disabled, true, id + ' は保存中は無効'); });
  assert.ok(/data-act="edit"[^>]*disabled/.test(m.doc.el('tasks-view').innerHTML), 'カードの操作も無効');
  /* 無効でも届いた操作は無視する（保存中に新しい下書きを開かない・状態変更を送らない・二重送信しない） */
  m.doc.fire('t-new', 'click');
  m.doc.fire('t-form', 'submit');
  m.doc.fire('tasks-view', 'click', { target: button({ 'data-act': 'status', 'data-id': 'T-aaaaaaaa0001', 'data-status': 'done' }) });
  m.doc.fire('tasks-view', 'click', { target: button({ 'data-act': 'edit', 'data-id': 'T-aaaaaaaa0001' }) });
  assert.strictEqual(api.pending.save.length, 1);
  assert.strictEqual(m.doc.el('t-title').value, '下書きA', '保存中に別の下書きへ置き換わらない');
  api.pending.save[0].ok({ ok: true, task: ti({ title: '下書きA' }) });
  assert.strictEqual(m.doc.el('t-form').hidden, true, '同じ未変更の下書きは成功後に閉じる');
  ['t-title', 't-new', 't-cancel'].forEach(function (id) { assert.strictEqual(m.doc.el(id).disabled, false, id + ' は保存後に戻る'); });
});

test('回帰(P2): 下書きA→遅延応答→別の下書きB（または編集された入力）は、Aの成功でフォームを閉じず入力を消さない', function () {
  var api = fakeTasksApi();
  var m = mounted(api);
  m.doc.fire('tab-tasks', 'click');
  api.pending.list[0].ok(listRes([]));
  m.doc.fire('t-new', 'click');
  fillForm(m.doc, '下書きA');
  m.doc.fire('t-form', 'submit');
  /* 万一（無効化をすり抜けて）入力が変わっても、遅れて返ったAの成功は変更後の入力を閉じない */
  m.doc.el('t-title').value = '下書きA を保存中に編集した内容';
  api.pending.save[0].ok({ ok: true, task: ti({ title: '下書きA' }) });
  assert.strictEqual(m.doc.el('t-form').hidden, false, '送信後に変わった入力は閉じない');
  assert.strictEqual(m.doc.el('t-title').value, '下書きA を保存中に編集した内容');
  /* 別の下書きB（新しい下書きID）へ切り替わった後に、Aの遅延応答が来ても閉じない */
  var api2 = fakeTasksApi();
  var m2 = mounted(api2);
  m2.doc.fire('tab-tasks', 'click');
  api2.pending.list[0].ok(listRes([]));
  m2.doc.fire('t-new', 'click');
  fillForm(m2.doc, '下書きA');
  m2.doc.fire('t-form', 'submit');
  m2.ctl.state.save.phase = 'idle'; /* 状態の取り違え（保存中解除）を仮定しても、下書きの同一性で守る */
  m2.doc.fire('t-new', 'click');
  fillForm(m2.doc, '下書きB');
  api2.pending.save[0].ok({ ok: true, task: ti({ title: '下書きA' }) });
  assert.strictEqual(m2.doc.el('t-form').hidden, false, 'Bのフォームを閉じない');
  assert.strictEqual(m2.doc.el('t-title').value, '下書きB');
  assert.strictEqual(m2.doc.el('t-form-title').textContent, 'メモを追加');
});

test('回帰(P2): 保存失敗・競合でも下書きを閉じず、入力を残す。古い一覧応答で操作対象を失わない', function () {
  var api = fakeTasksApi();
  var m = mounted(api);
  m.doc.fire('tab-tasks', 'click');
  api.pending.list[0].ok(listRes([ti({ taskId: 'T-aaaaaaaa0001', title: '既存', revision: 1 })]));
  m.doc.fire('tasks-view', 'click', { target: button({ 'data-act': 'edit', 'data-id': 'T-aaaaaaaa0001' }) });
  m.doc.el('t-title').value = '編集中の件名';
  m.doc.fire('t-form', 'submit');
  api.pending.save[0].ok({ ok: false, error: { code: 'CONFLICT', message: '別の端末・操作で先に更新されています。上書きはしていません。', current: ti({ title: '先に保存', revision: 2 }) } });
  assert.strictEqual(m.doc.el('t-form').hidden, false);
  assert.strictEqual(m.doc.el('t-title').value, '編集中の件名');
  /* 競合後に取り直した一覧が返っても、編集対象（taskId）は同じで、次の保存は最新の版2に対する明示的な上書き */
  api.pending.list[1].ok(listRes([ti({ taskId: 'T-aaaaaaaa0001', title: '先に保存', revision: 2 })]));
  m.doc.fire('t-form', 'submit');
  assert.deepStrictEqual(api.pending.save[1].payload.expectedRevision, 2);
  assert.strictEqual(api.pending.save[1].payload.input.taskId, 'T-aaaaaaaa0001');
  assert.strictEqual(api.pending.save[1].payload.input.title, '編集中の件名');
  api.pending.save[1].ng(new Error('net'));
  assert.strictEqual(m.doc.el('t-form').hidden, false, '通信失敗でも閉じない');
  assert.strictEqual(m.doc.el('t-title').value, '編集中の件名');
  /* 失敗後の再送は同じ下書きIDで送れる */
  m.doc.fire('t-form', 'submit');
  assert.strictEqual(api.pending.save[2].payload.input.taskId, 'T-aaaaaaaa0001');
  /* 保存・削除中に遅れて返った古い一覧応答は破棄される（後から要求した一覧が正） */
  var api3 = fakeTasksApi();
  var c3 = T.createController(api3);
  c3.load(); c3.load();
  api3.pending.list[1].ok(listRes([ti({ title: '新しい一覧' })]));
  api3.pending.list[0].ok(listRes([ti({ title: '古い一覧' })]));
  assert.strictEqual(c3.state.data.items[0].title, '新しい一覧');
});

test('回帰(P2): 読み込めない保存行（skippedRows）は警告し、一覧・件数が不完全だと示す。全行不正でも「未対応なし・正常」としない', function () {
  function state(res) { var api = fakeTasksApi(); var c = T.createController(api); c.load(); api.pending.list[0].ok(res); return c.state; }
  /* 一部が不正 */
  var partial = state(listRes([ti({ title: '読めるメモ' })], { skippedRows: 2 }));
  var html = T.renderBanner(partial) + T.renderSummary(partial) + T.renderList(partial);
  assert.ok(/2 行を読み込めませんでした。一覧・件数は不完全/.test(html), html);
  assert.ok(/一覧は不完全（読込不可 2行）/.test(html));
  assert.ok(/読めるメモ/.test(html));
  /* 全行が不正（表示できる行が0） */
  var all = state(listRes([], { skippedRows: 3 }));
  var allHtml = T.renderBanner(all) + T.renderSummary(all) + T.renderList(all);
  assert.ok(/3 行を読み込めませんでした/.test(allHtml));
  assert.ok(!/未対応のメモはありません（取得は正常に完了しています）/.test(allHtml), '誤って正常表示にしない');
  assert.ok(/一覧は不完全/.test(allHtml));
  /* 正常（0行）は警告を出さず、従来どおり */
  var clean = state(listRes([], { skippedRows: 0 }));
  var cleanHtml = T.renderBanner(clean) + T.renderSummary(clean) + T.renderList(clean);
  assert.ok(!/読み込めませんでした|不完全/.test(cleanHtml));
  assert.ok(/未対応のメモはありません（取得は正常に完了しています）/.test(cleanHtml));
  /* 警告に行の中身を出さない（件数のみ）。ログにも行内容を出さない。 */
  var leaky = state(listRes([], { skippedRows: 1 }));
  assert.ok(!/T-bad|SECRET/.test(T.renderBanner(leaky)));
});

test('回帰(P2): バックエンドは壊れた行を件数で返し、行の内容を応答・ログに出さない', function () {
  var world = makeWorld({ preload: [HEADER, taskRow({ title: '読めるメモ' }), ['T-bad', 'SECRET-ROW-CONTENT'], ['', 'SECRET-ROW-2', '', '', 'not-a-status', '', '', '', '', '', 'x']] });
  var b = backend(world);
  var l = b.list();
  assert.strictEqual(l.ok, true);
  assert.strictEqual(l.skippedRows, 2);
  assert.strictEqual(l.items.length, 1);
  assert.ok(!/SECRET-ROW/.test(JSON.stringify(l) + b.sb._logs.join('\n')));
});

test('診断文言: 権限の説明は spreadsheets（表示・編集）に合っており、「読み取り専用の承認」「権限の拡大は不要」と案内しない', function () {
  var api = code('OpsApi.gs');
  var m = /SCOPE_INSUFFICIENT: '([^']*)'/.exec(readFile('OpsApi.gs'));
  var n = /EXCEPTION_AUTH_REQUIRED: '([^']*)'/.exec(readFile('OpsApi.gs'));
  assert.ok(m && n);
  assert.ok(/表示・編集/.test(m[1]) && /表示・編集/.test(n[1]));
  assert.ok(!/読み取り専用の承認|権限の拡大は不要|読み取り権限の承認/.test(m[1] + n[1]));
  assert.ok(/OAuthレベルの読み取り専用ではありません/.test(fs.readFileSync(path.join(ROOT, 'docs', 'ops-tasks-941.md'), 'utf8')));
  assert.ok(api.length > 0);
});

/* ===================== #941 実環境: 読み取り成功・追記だけ403 の原因分類 ===================== */
test('診断(APPEND 403): 読み取り成功・追記だけ403のとき、Googleの拒否分類を固定コードで識別し、本文・IDを出さず、1回しか追記しない', function () {
  var cases = [
    ['保護された範囲', { error: { code: 403, status: 'PERMISSION_DENIED', message: 'You are trying to edit a protected cell or object. SECRET-BODY' } }, 'APPEND_HTTP/403/PROTECTED_RANGE', /保護/],
    ['書込み権限なし(閲覧者)', { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission SECRET-BODY' } }, 'APPEND_HTTP/403/PERMISSION_DENIED', /編集者/],
    ['scope不足', { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }, 'APPEND_HTTP/403/SCOPE_INSUFFICIENT', /再承認/],
    ['API無効', { error: { code: 403, status: 'PERMISSION_DENIED', errors: [{ reason: 'accessNotConfigured' }] } }, 'APPEND_HTTP/403/API_DISABLED', /Sheets API/],
    ['分類不能', { error: { message: 'SECRET-BODY' } }, 'APPEND_HTTP/403', /断定できません/],
    ['本文がJSONでない', 'SECRET-BODY-NOT-JSON', 'APPEND_HTTP/403', /断定できません/]
  ];
  cases.forEach(function (c) {
    var world = makeWorld({ preload: [HEADER, taskRow()], failOn: function (m, u) { return m === 'POST' && /:append/.test(u); }, failStatus: 403, failBody: c[1] });
    var b = backend(world);
    var l = b.list();
    assert.strictEqual(l.ok, true, c[0] + ': 読み取りは成功');
    var r = b.save(input(), null);
    assert.strictEqual(r.ok, false, c[0]);
    assert.strictEqual(r.error.code, 'STORE_FAILED', c[0]);
    assert.strictEqual(r.error.reason, c[2], c[0]);
    assert.ok(c[3].test(r.error.hint), c[0] + ': ' + r.error.hint);
    assert.deepStrictEqual(contract.validateError(r), [], c[0]);
    assert.ok(!/SECRET|FAKE-TASKS|FAKE-TOKEN/.test(JSON.stringify(r) + JSON.stringify(l) + b.sb._logs.join('\n')), c[0] + ': 本文・IDを出さない');
    assert.strictEqual(world.requests.filter(function (q) { return /:append/.test(q.url); }).length, 1, c[0] + ': 追記を自動で繰り返さない');
    assert.strictEqual(tasksRows(world).length, 2, c[0] + ': 何も書かれていない');
    assert.strictEqual(world.ledgerTouchedByWrite, false);
  });
  /* 更新・削除の403も同じ分類で、末尾の語は固定の許可リスト形式だけ。 */
  var w2 = makeWorld({ preload: [HEADER, taskRow()], failOn: function (m) { return m === 'PUT'; }, failStatus: 403, failBody: { error: { status: 'PERMISSION_DENIED', message: 'protected cell or object' } } });
  assert.strictEqual(backend(w2).save(input({ taskId: 'T-aaaaaaaa0001', title: '更新' }), 1).error.reason, 'UPDATE_HTTP/403/PROTECTED_RANGE');
});
