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
  /* 公開側は Spreadsheet 以外の権限を要求しない */
  assert.deepStrictEqual(manifests.pub.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets']);
  assert.ok(Object.keys(prepare.TARGETS).length === 2);
});

test('setup: schemaから responses / events / questions / settings を作る（冪等）', function () {
  var project = loadSurveyProject('public');
  setup(project);
  setup(project);
  assert.deepStrictEqual(project.sheets.responses._rows[0], Core.responseColumns(schema));
  assert.deepStrictEqual(project.sheets.events._rows[0], ['timestamp', 'respondent_hash', 'step_id']);
  assert.ok(project.sheets.questions._rows.length > 30);
  assert.strictEqual(project.sheets.settings._rows[1][1], String(schema.version));
});

test('submit: 検証済みの行を保存し、定義外・条件外の値は保存しない', function () {
  var project = loadSurveyProject('public');
  var result = call(project, 'submit', body(A.nonuser({ evil: 'x', visit_count: 'once', reuse_intent: 'definitely' }), { survey_path: 'x_main' }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), { success: true, duplicate: false });
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

test('二重送信防止: 同じrespondent_hashは1行だけ', function () {
  var project = loadSurveyProject('public');
  assert.strictEqual(call(project, 'submit', body(A.user())).duplicate, false);
  var second = call(project, 'submit', body(A.user()));
  assert.strictEqual(second.success, true);
  assert.strictEqual(second.duplicate, true);
  assert.strictEqual(project.sheets.responses._rows.length, 2);
  var other = call(project, 'submit', JSON.stringify({ schema_version: schema.version, respondent_hash: '123e4567-e89b-42d3-a456-426614174999', answers: A.user() }));
  assert.strictEqual(other.duplicate, false);
  assert.strictEqual(project.sheets.responses._rows.length, 3);
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
  assert.deepStrictEqual(project.sheets.events._rows[1].slice(1), [HASH, 'privacy']);
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
  assert.deepStrictEqual(JSON.parse(post.text), { success: true, duplicate: false });
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

test('管理画面HTMLは自由記述をinnerHTMLへ入れずtextContentで出す', function () {
  var html = fs.readFileSync(path.join(__dirname, '..', 'gas/survey/admin/SurveyAdminPage.html'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|document\.write|eval\(/.test(html));
  assert.match(html, /textContent/);
  assert.match(html, /n &lt; <span id="mincell">/);
  assert.match(html, /td\.low/);
});
