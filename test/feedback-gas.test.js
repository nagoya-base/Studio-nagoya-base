/*
 * 利用後アンケートGAS（gas/feedback/。Issue #835 第1段階）の検証。
 * prepare-feedback-gas-project.js の配布物をそのままvmで実行する。
 * 受入テスト3〜6（テスト回答の保存・通知0通・トークン非消費・不正拒否・テスト通知・本番回答の拒否）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var Core = require('../scripts/feedback-core.js');
var prepare = require('../scripts/prepare-feedback-gas-project');
var loadFeedbackProject = require('./helpers/feedback-env').loadFeedbackProject;

var TOKEN = 'tok_ABCDEFGHIJKLMNOP1234';
var NOTIFY_ON = { FEEDBACK_NOTIFY: 'on', FEEDBACK_NOTIFY_EMAIL: 'owner@example.com' };

function ready(options) {
  var project = loadFeedbackProject(options);
  project.run('setupFeedbackSpreadsheet()');
  return project;
}
function answers(extra) { return Object.assign({ q1: 4, q6: 'definitely' }, extra || {}); }
function testPayload(brand, extra) { return { brand: brand, test: 1, answers: answers(extra) }; }
function prodPayload(brand, extra) { return { brand: brand, token: TOKEN, answers: answers(extra) }; }

/* 第3段階の台帳を模したモック。呼び出しを記録する。 */
function installMockTokens(project, state) {
  var calls = [];
  project.sandbox.__mock = {
    verify: function (token, brand) { calls.push(['verify', token, brand]); return state.verify || { ok: true }; },
    consume: function (token, brand) { calls.push(['consume', token, brand]); return state.consume || { ok: true }; },
    release: function (token, brand) { calls.push(['release', token, brand]); }
  };
  project.run('FeedbackTokens = __mock');
  return calls;
}

test('配布物: コア＋トークン＋GAS 4ファイル。既存 survey の配布物・Booking と共有しない', function () {
  assert.deepStrictEqual(prepare.fileNames(), ['FeedbackCore.gs', 'FeedbackTokenCore.gs', 'FeedbackTokens.gs', 'FeedbackRepository.gs', 'FeedbackWebApp.gs', 'appsscript.json']);
  prepare.FILES.forEach(function (entry) { assert.ok(!/survey|booking/.test(entry[1]), entry[1]); });
  var manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gas/feedback/appsscript.json'), 'utf8'));
  assert.strictEqual(manifest.webapp.access, 'ANYONE_ANONYMOUS');
  assert.strictEqual(manifest.webapp.executeAs, 'USER_DEPLOYING');
  assert.deepStrictEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.send_mail'
  ], '月次削除は管理者プロジェクトへ移したので、公開側はトリガー作成権限を持たない（#849）');
  var gs = prepare.FILES.filter(function (e) { return /\.gs$/.test(e[0]); }).map(function (e) { return fs.readFileSync(path.join(__dirname, '..', e[1]), 'utf8'); }).join('\n');
  assert.ok(!/SURVEY_SPREADSHEET_ID|BOOKING_|SPREADSHEET_ID'\)/.test(gs.replace(/FEEDBACK_SPREADSHEET_ID/g, '')), '他システムの設定キーを参照しない');
});

test('受入3: ?test=1 の反復回答が3ブランドとも is_test=1 で同じ1つのSpreadsheetに保存され、通知は0通', function () {
  var project = ready({ properties: NOTIFY_ON });
  ['snb', 'mens', 'studio-x'].forEach(function (brand) {
    for (var i = 0; i < 2; i++) {
      assert.deepStrictEqual(project.call('submit', testPayload(brand, { q5: ['damage'], comment: 'テスト' + i })), { success: true });
    }
  });
  var rows = project.rows();
  assert.strictEqual(rows.length, 6);
  assert.deepStrictEqual(rows.map(function (r) { return r.brand; }), ['snb', 'snb', 'mens', 'mens', 'studio-x', 'studio-x']);
  rows.forEach(function (r) {
    assert.strictEqual(r.is_test, 1);
    assert.strictEqual(r.status, '未対応');
    assert.strictEqual(r.notify_failed, '');
    assert.match(r.response_id, /mock-uuid/);
    assert.strictEqual(r.received_at, '2026-11-08T03:00:00.000Z');
  });
  assert.strictEqual(project.mails.length, 0, 'テスト回答では通知メールを送らない');
  assert.deepStrictEqual(Object.keys(project.spreadsheets.books), ['ss-feedback']);
});

test('受入4: テスト経路では本番トークンを検証・消費しない（トークンが同時に送られても）', function () {
  var project = ready();
  var calls = installMockTokens(project, {});
  var payload = testPayload('snb');
  payload.token = TOKEN;
  assert.strictEqual(project.call('submit', payload).success, true);
  assert.strictEqual(project.call('verify', { brand: 'snb', test: 1, token: TOKEN }).success, true);
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(project.rows()[0].is_test, 1);
  assert.ok(JSON.stringify(project.sheet('responses')._rows).indexOf(TOKEN) === -1, 'トークンを保存しない');
});

test('is_test はサーバー確定: 厳密な 1 以外はテスト扱いしない（本番扱い→トークン無しで拒否）', function () {
  var project = ready();
  ['1', true, 2, 'yes'].forEach(function (value) {
    var result = project.call('submit', { brand: 'snb', test: value, answers: answers() });
    assert.strictEqual(result.error.code, 'TOKEN_MISSING', String(value));
  });
  assert.strictEqual(project.rows().length, 0);
});

test('受入6: 本番トークン未接続の間は、一般公開フォームから本番回答を保存できない', function () {
  var project = ready({ properties: NOTIFY_ON });
  assert.strictEqual(project.call('submit', prodPayload('snb')).error.code, 'TOKEN_NOT_CONNECTED');
  assert.strictEqual(project.call('verify', { brand: 'mens', token: TOKEN }).error.code, 'TOKEN_NOT_CONNECTED');
  assert.strictEqual(project.call('submit', { brand: 'snb', answers: answers() }).error.code, 'TOKEN_MISSING');
  assert.strictEqual(project.call('submit', { brand: 'snb', token: 'bad token!', answers: answers() }).error.code, 'TOKEN_INVALID');
  assert.strictEqual(project.rows().length, 0);
  assert.strictEqual(project.mails.length, 0);
});

test('受入4: 無効なブランド・不正データ・過大・未知アクションはサーバーで拒否し、入力値を反射しない', function () {
  var project = ready();
  assert.strictEqual(project.call('submit', testPayload('other')).error.code, 'INVALID_BRAND');
  assert.strictEqual(project.call('submit', testPayload('__proto__')).error.code, 'INVALID_BRAND');
  assert.strictEqual(project.call('submit', '{bad').error.code, 'INVALID_JSON');
  assert.strictEqual(project.call('submit', '[]').error.code, 'INVALID_PAYLOAD');
  assert.strictEqual(project.call('submit', 'x'.repeat(8001)).error.code, 'PAYLOAD_TOO_LARGE');
  assert.strictEqual(project.call('sendTestNotification', testPayload('snb')).error.code, 'UNKNOWN_ACTION');
  var bad = project.call('submit', testPayload('snb', { q6: 'zzz_secret', q4: 'no', q4_rating: 5, comment: 'あ'.repeat(501) }));
  assert.strictEqual(bad.error.code, 'VALIDATION_FAILED');
  assert.deepStrictEqual(bad.error.fields.map(function (f) { return f.field + ':' + f.code; }), ['q4_rating:HIDDEN_VALUE', 'q6:INVALID_OPTION', 'comment:TOO_LONG']);
  assert.strictEqual(JSON.stringify(bad).indexOf('zzz_secret'), -1);
  assert.strictEqual(project.rows().length, 0);
});

test('受入4: 過剰投稿は rate limit で拒否（テスト回答も同じ枠）', function () {
  var project = ready({ properties: { FEEDBACK_RATE_LIMIT_PER_MINUTE: '3' } });
  for (var i = 0; i < 3; i++) assert.strictEqual(project.call('submit', testPayload('snb')).success, true);
  assert.strictEqual(project.call('submit', testPayload('snb')).error.code, 'RATE_LIMITED');
  assert.strictEqual(project.call('submit', 'x'.repeat(10)).error.code, 'RATE_LIMITED', '不正JSONでも枠を消費済みなら拒否');
  assert.strictEqual(project.call('submit', testPayload('snb'), new Date('2026-11-08T03:01:00.000Z')).success, true, '次の1分は受け付ける');
  assert.strictEqual(project.rows().length, 4);
});

test('保存先: 未設定・未初期化（マーカー無し）・ヘッダ不一致のSpreadsheetには書かない（他へフォールバックしない）', function () {
  var none = loadFeedbackProject({ spreadsheetId: null });
  assert.strictEqual(none.call('submit', testPayload('snb')).error.code, 'STORAGE_UNAVAILABLE');
  assert.ok(none.logs.some(function (l) { return l === 'feedback storage unavailable: STORAGE_NOT_CONFIGURED'; }));

  var uninit = loadFeedbackProject();
  assert.strictEqual(uninit.call('submit', testPayload('snb')).error.code, 'STORAGE_UNAVAILABLE');
  assert.strictEqual(uninit.sheet('responses'), undefined, 'シートも作らない');

  var wrongId = loadFeedbackProject({ properties: { FEEDBACK_SPREADSHEET_ID: 'ss-missing' } });
  assert.strictEqual(wrongId.call('submit', testPayload('snb')).error.code, 'STORAGE_UNAVAILABLE');

  var mismatch = ready();
  mismatch.sheet('responses')._rows[0][2] = 'renamed';
  assert.strictEqual(mismatch.call('submit', testPayload('snb')).error.code, 'STORAGE_UNAVAILABLE');
  assert.strictEqual(mismatch.sheet('responses')._rows.length, 1);
});

test('setup: 冪等。Booking・既存survey等データ入りのSpreadsheetは初期化を拒否して何も書かない', function () {
  var project = ready();
  project.run('setupFeedbackSpreadsheet()');
  assert.deepStrictEqual(project.sheet('responses')._rows, [Core.COLUMNS]);
  assert.strictEqual(project.sheet('settings')._rows[1][1], 'studio-nagoya-base-post-use-feedback-v1');

  var foreign = loadFeedbackProject();
  foreign.spreadsheets.addSheet('ss-feedback', 'bookings', [['bookingId', 'email'], ['b1', 'x@example.com']]);
  assert.throws(function () { foreign.run('setupFeedbackSpreadsheet()'); }, /空ではない/);
  assert.strictEqual(foreign.sheet('responses'), undefined);

  var survey = loadFeedbackProject();
  survey.spreadsheets.addSheet('ss-feedback', 'settings', [['key', 'value'], ['schema_version', '3']]);
  assert.throws(function () { survey.run('setupFeedbackSpreadsheet()'); }, /空ではない/);

  var emptyDefault = loadFeedbackProject();
  emptyDefault.spreadsheets.addSheet('ss-feedback', 'シート1', []);
  assert.strictEqual(emptyDefault.run('setupFeedbackSpreadsheet()'), 'ok', '新規Spreadsheetの空シートは許可');
});

test('本番（モック台帳）: 検証→消費→保存。トークンもブランド一致もモックへ渡り、行にトークンを書かない', function () {
  var project = ready();
  var calls = installMockTokens(project, {});
  assert.deepStrictEqual(project.call('verify', { brand: 'studio-x', token: TOKEN }), { success: true });
  assert.deepStrictEqual(project.call('submit', prodPayload('studio-x')), { success: true });
  assert.deepStrictEqual(calls, [['verify', TOKEN, 'studio-x'], ['verify', TOKEN, 'studio-x'], ['consume', TOKEN, 'studio-x']]);
  var row = project.rows()[0];
  assert.strictEqual(row.is_test, 0);
  assert.strictEqual(row.status, '対応不要');
  assert.ok(JSON.stringify(project.sheet('responses')._rows).indexOf(TOKEN) === -1);
});

test('本番（モック台帳）: 不正・使用済み・期限切れ・ブランド不一致は保存せずコードを返す', function () {
  ['TOKEN_INVALID', 'TOKEN_USED', 'TOKEN_EXPIRED', 'TOKEN_BRAND_MISMATCH', 'WEIRD'].forEach(function (code) {
    var project = ready();
    var calls = installMockTokens(project, { verify: { ok: false, code: code } });
    var expected = code === 'WEIRD' ? 'TOKEN_INVALID' : code;
    assert.strictEqual(project.call('verify', { brand: 'snb', token: TOKEN }).error.code, expected);
    assert.strictEqual(project.call('submit', prodPayload('snb')).error.code, expected);
    assert.strictEqual(project.rows().length, 0);
    assert.ok(!calls.some(function (c) { return c[0] === 'consume'; }), '検証で落ちたら消費しない');
  });
  var raced = ready();
  installMockTokens(raced, { consume: { ok: false, code: 'TOKEN_USED' } });
  assert.strictEqual(raced.call('submit', prodPayload('snb')).error.code, 'TOKEN_USED');
  assert.strictEqual(raced.rows().length, 0);
});

test('本番（モック台帳）: 保存に失敗したら消費を取り消す（release）。保存先未設定ならトークンに触れない', function () {
  var project = ready();
  var calls = installMockTokens(project, {});
  project.sheet('responses')._failWrites = true;
  assert.strictEqual(project.call('submit', prodPayload('snb')).error.code, 'STORAGE_UNAVAILABLE');
  assert.deepStrictEqual(calls.map(function (c) { return c[0]; }), ['verify', 'consume', 'release']);

  var unconfigured = loadFeedbackProject({ spreadsheetId: null });
  var calls2 = installMockTokens(unconfigured, {});
  assert.strictEqual(unconfigured.call('submit', prodPayload('snb')).error.code, 'STORAGE_UNAVAILABLE');
  assert.deepStrictEqual(calls2, []);
});

test('rate limit のカウンタはスクリプトロック内で読み書きし、保存前に解放する。ロックを取れなければ受け付けない', function () {
  var project = ready();
  var cache = project.sandbox.CacheService.getScriptCache();
  var locks = project.sandbox.LockService;
  var heldDuringCounter = [];
  project.sandbox.CacheService = {
    getScriptCache: function () {
      return {
        get: function (k) { heldDuringCounter.push(locks._isHeld()); return cache.get(k); },
        put: function (k, v, t) { heldDuringCounter.push(locks._isHeld()); return cache.put(k, v, t); }
      };
    }
  };
  assert.strictEqual(project.call('submit', testPayload('snb')).success, true, 'カウンタ後にロックを解放しているので保存できる');
  assert.strictEqual(project.call('verify', { brand: 'snb', test: 1 }).success, true);
  assert.deepStrictEqual(heldDuringCounter, [true, true, true, true]);
  assert.strictEqual(locks._isHeld(), false);

  var busy = ready({ lockFails: true });
  assert.strictEqual(busy.call('submit', testPayload('snb')).error.code, 'RATE_LIMITED');
  assert.strictEqual(busy.call('verify', { brand: 'snb', test: 1 }).error.code, 'RATE_LIMITED');
  assert.strictEqual(busy.rows().length, 0);
});

test('通知: 本番有効回答で要確認なら1通。中立的な件名・プレーンテキストでトークン等を含めない', function () {
  var project = ready({ properties: NOTIFY_ON });
  installMockTokens(project, {});
  project.call('submit', prodPayload('studio-x', { q5: ['supplies', 'cleanliness'], q3: { lighting: 'trouble' }, comment: 'ゴミ袋が足りませんでした' }));
  assert.strictEqual(project.mails.length, 1);
  var mail = project.mails[0];
  assert.strictEqual(mail.to, 'owner@example.com');
  assert.strictEqual(mail.subject, '【利用後アンケート】確認が必要な回答があります（Studio X）');
  assert.match(mail.body, /ブランド: Studio X/);
  assert.match(mail.body, /受信日時: 2026\/11\/08 12:00 JST/);
  assert.match(mail.body, /気になる点: 消耗品不足、清掃・衛生面/);
  assert.match(mail.body, /照明の操作（困った）/);
  assert.match(mail.body, /ゴミ袋が足りませんでした/);
  assert.match(mail.body, new RegExp('回答ID: ' + project.rows()[0].response_id));
  [TOKEN, 'ss-feedback', 'owner@example.com', '<'].forEach(function (s) { assert.strictEqual(mail.body.indexOf(s), -1, s); });
  ['緊縛', 'フェチ'].forEach(function (w) { assert.strictEqual(mail.subject.indexOf(w) + mail.body.indexOf(w), -2, w); });
  assert.strictEqual(project.rows()[0].notify_failed, '');
});

test('通知: 自由記述だけでも1通、「特になし」のみ・要確認なしは0通、初期設定（OFF）は0通', function () {
  var project = ready({ properties: NOTIFY_ON });
  installMockTokens(project, {});
  project.call('submit', prodPayload('snb', { comment: 'また来ます' }));
  assert.strictEqual(project.mails.length, 1);
  project.call('submit', prodPayload('snb', { q5: ['none'] }));
  project.call('submit', prodPayload('snb', { q2: { booking: 'trouble' } }));
  assert.strictEqual(project.mails.length, 1);

  var off = ready({ properties: { FEEDBACK_NOTIFY_EMAIL: 'owner@example.com' } });
  installMockTokens(off, {});
  off.call('submit', prodPayload('mens', { q5: ['damage'] }));
  assert.strictEqual(off.mails.length, 0, 'FEEDBACK_NOTIFY が on でなければ送らない');
  assert.strictEqual(off.rows()[0].notify_failed, '', 'OFF は失敗扱いにしない');
});

test('通知失敗: 回答は維持し notify_failed=1 を記録。ログに宛先・本文を残さない', function () {
  var project = ready({ properties: NOTIFY_ON, mailFails: true });
  installMockTokens(project, {});
  assert.deepStrictEqual(project.call('submit', prodPayload('mens', { comment: '秘密の本文' })), { success: true });
  var rows = project.rows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].notify_failed, 1);
  assert.ok(project.logs.some(function (l) { return l === 'feedback notify failed: Error'; }));
  project.logs.forEach(function (l) { assert.ok(l.indexOf('owner@example.com') === -1 && l.indexOf('秘密の本文') === -1, l); });

  var noAddress = ready({ properties: { FEEDBACK_NOTIFY: 'on' } });
  installMockTokens(noAddress, {});
  noAddress.call('submit', prodPayload('snb', { q5: ['other'] }));
  assert.strictEqual(noAddress.rows()[0].notify_failed, 1, 'ON なのに宛先未設定は失敗として残す');
});

test('受入5: sendTestNotification(brand) で3ブランドの [TEST] 通知。Spreadsheetに触れず、OFFでも送れる', function () {
  var project = loadFeedbackProject({ spreadsheetId: null, properties: { FEEDBACK_NOTIFY_EMAIL: 'owner@example.com' } });
  assert.strictEqual(project.run('sendTestNotificationSnb()'), 'sent');
  assert.strictEqual(project.run('sendTestNotificationMens()'), 'sent');
  assert.strictEqual(project.run('sendTestNotificationStudioX()'), 'sent');
  assert.deepStrictEqual(project.mails.map(function (m) { return m.subject; }), [
    '[TEST] 【利用後アンケート】確認が必要な回答があります（Studio Nagoya Base）',
    '[TEST] 【利用後アンケート】確認が必要な回答があります（SNB mens）',
    '[TEST] 【利用後アンケート】確認が必要な回答があります（Studio X）'
  ]);
  project.mails.forEach(function (m) { assert.match(m.body, /^\[TEST\] これは sendTestNotification による確認用のダミー通知です/); });
  assert.strictEqual(project.run('sendTestNotification("other")'), 'skipped: invalid brand');
  assert.strictEqual(project.mails.length, 3);

  var unset = loadFeedbackProject({ spreadsheetId: null });
  assert.strictEqual(unset.run('sendTestNotification("snb")'), 'skipped: notification address not configured');
  var failing = loadFeedbackProject({ spreadsheetId: null, mailFails: true, properties: { FEEDBACK_NOTIFY_EMAIL: 'owner@example.com' } });
  assert.strictEqual(failing.run('sendTestNotification("snb")'), 'failed: Error');
});

test('doGet/doPost: doGet は死活確認だけ、doPost は submit 既定・JSON応答', function () {
  var project = ready();
  var get = JSON.parse(project.run('doGet()').text);
  assert.deepStrictEqual(get, { success: true, service: 'studio-nagoya-base-post-use-feedback' });
  project.sandbox.__e = { parameter: {}, postData: { contents: JSON.stringify(testPayload('mens')) } };
  assert.deepStrictEqual(JSON.parse(project.run('doPost(__e)').text), { success: true });
  project.sandbox.__e = { parameter: { action: 'sendTestNotificationSnb' }, postData: { contents: '{}' } };
  assert.strictEqual(JSON.parse(project.run('doPost(__e)').text).error.code, 'UNKNOWN_ACTION');
});

test('保持期間: 本番180日・テスト30日を過ぎた行だけを削除。月次トリガーは冪等に1つ（管理者プロジェクトで実行。#849）', function () {
  var project = ready();
  assert.strictEqual(project.run('typeof purgeExpiredFeedbackResponses'), 'undefined', '公開Web Appは行を削除しない（末尾追記のみ）');
  var admin = loadFeedbackProject({ target: 'admin', spreadsheets: project.spreadsheets });
  var sheet = project.sheet('responses');
  var now = new Date('2026-11-08T00:00:00.000Z');
  function daysAgo(d) { return new Date(now.getTime() - d * 86400000).toISOString(); }
  function row(id, isTest, at) {
    var r = Core.COLUMNS.map(function () { return ''; });
    r[Core.COLUMNS.indexOf('response_id')] = id;
    r[Core.COLUMNS.indexOf('is_test')] = isTest;
    r[Core.COLUMNS.indexOf('received_at')] = at;
    return r;
  }
  /* 境界: ちょうど180日／30日は「過ぎた」に当たらないため残す（判定は経過時間 > 保持日数）。 */
  [row('p-keep', 0, daysAgo(179)), row('p-edge', 0, daysAgo(180)), row('p-old', 0, daysAgo(181)),
    row('t-keep', 1, daysAgo(29)), row('t-edge', 1, daysAgo(30)), row('t-old', 1, daysAgo(31)), row('bad-date', 0, 'not a date')]
    .forEach(function (r) { sheet._rows.push(r); });
  project.sandbox.__now = now;
  admin.sandbox.__now = now;
  /*
   * vm の外で作った Date は sandbox 内の `instanceof Date` が false になり、関数が実時刻へフォールバックして
   * 実行日依存になる（#855）。固定日時は sandbox 内の Date として渡す。
   */
  assert.strictEqual(admin.run('__now instanceof Date'), false, '前提: vm 外の Date は sandbox の Date ではない');
  assert.strictEqual(admin.run('purgeExpiredFeedbackResponses(new Date(__now.getTime()))').deleted, 2);
  assert.deepStrictEqual(project.rows().map(function (r) { return r.response_id; }), ['p-keep', 'p-edge', 't-keep', 't-edge', 'bad-date']);

  admin.run('installFeedbackRetentionTrigger()');
  admin.run('installFeedbackRetentionTrigger()');
  assert.strictEqual(admin.triggers.length, 1);
  assert.deepStrictEqual(admin.triggers[0].spec, { handler: 'purgeExpiredFeedbackResponses', monthDay: 1, hour: 4 });
});
