/*
 * Issue #847: 共通アンケート通知メールの「回答日時」を日本時間（Asia/Tokyo, UTC+9）で表示する。
 * 表示だけの変更で、保存するtimestamp（ISO/UTC）・通知条件は従来どおりであることも確認する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var schema = require('../survey/survey-schema.json');
var A = require('./helpers/survey-answers');
var loadSurveyProject = require('./helpers/survey-env').loadSurveyProject;

var NOTIFY = { SURVEY_NOTIFICATION_EMAIL: 'admin@example.com' };
var HASH = '123e4567-e89b-42d3-a456-426614178470';

function fmt(project, iso) {
  project.sandbox.__d = new Date(iso);
  return project.run('surveyFormatJst_(__d)');
}
function submit(project, answers, iso) {
  project.sandbox.__body = JSON.stringify({ schema_version: schema.version, respondent_hash: HASH, answers: answers });
  project.sandbox.__now = new Date(iso);
  return project.run('handleSurveyRequest_("submit", __body, __now)');
}

test('#847 JST変換: 受け入れ条件の例・日付/月/年またぎ・ゼロ埋め', function () {
  var p = loadSurveyProject('public');
  assert.strictEqual(fmt(p, '2026-11-08T02:25:40.105Z'), '2026/11/08 11:25:40 JST');
  assert.strictEqual(fmt(p, '2026-11-08T16:30:00Z'), '2026/11/09 01:30:00 JST');
  assert.strictEqual(fmt(p, '2026-11-30T15:00:00Z'), '2026/12/01 00:00:00 JST');
  assert.strictEqual(fmt(p, '2026-12-31T15:00:00Z'), '2027/01/01 00:00:00 JST');
  assert.strictEqual(fmt(p, '2028-02-28T15:00:01Z'), '2028/02/29 00:00:01 JST');
  assert.strictEqual(fmt(p, '2026-01-01T00:05:09Z'), '2026/01/01 09:05:09 JST');
});

test('#847 JST変換: 実行環境のタイムゾーンに依存しない', function () {
  /* 変換はUTC基準の算術のみ（getHours等のローカル時刻APIを使わない）。 */
  var src = require('fs').readFileSync(require('path').join(__dirname, '..', 'gas/survey/public/SurveyWebApp.gs'), 'utf8');
  var fn = src.slice(src.indexOf('function surveyFormatJst_'), src.indexOf('function surveyBuildNotificationBody_'));
  assert.ok(!/\.get(FullYear|Month|Date|Hours|Minutes|Seconds)\(/.test(fn));
  assert.ok(!/Utilities\.formatDate|getScriptTimeZone|toLocale/.test(fn));
  var child = require('child_process').spawnSync(process.execPath, ['-e',
    'var p=require(' + JSON.stringify(require.resolve('./helpers/survey-env')) + ').loadSurveyProject("public");' +
    'p.sandbox.__d=new Date("2026-11-08T16:30:00Z");process.stdout.write(p.run("surveyFormatJst_(__d)"));'
  ], { env: Object.assign({}, process.env, { TZ: 'America/Los_Angeles' }), encoding: 'utf8' });
  assert.strictEqual(child.status, 0, child.stderr);
  assert.strictEqual(child.stdout, '2026/11/09 01:30:00 JST');
});

test('#847 本番通知: 自由記述ありの通知メールはJST表示、保存timestampはISO/UTCのまま', function () {
  var p = loadSurveyProject('public', { properties: NOTIFY });
  assert.strictEqual(submit(p, A.user({ free_feedback: '感想' }), '2026-11-08T16:30:00Z').success, true);
  assert.strictEqual(p.mails.length, 1);
  assert.ok(p.mails[0].body.indexOf('回答日時: 2026/11/09 01:30:00 JST\n') !== -1, p.mails[0].body);
  assert.strictEqual(p.mails[0].body.indexOf('2026-11-08T16:30:00'), -1);
  var rows = p.sheets.responses._rows;
  assert.strictEqual(rows[1][rows[0].indexOf('timestamp')], '2026-11-08T16:30:00.000Z');
});

test('#847 通知条件は不変: 自由記述なしは送らない', function () {
  var p = loadSurveyProject('public', { properties: NOTIFY });
  assert.strictEqual(submit(p, A.user(), '2026-11-08T16:30:00Z').success, true);
  assert.strictEqual(p.mails.length, 0);
});

test('#847 配信確認: surveyNotificationSelfTest のメールもJST表示', function () {
  var p = loadSurveyProject('public', { properties: NOTIFY });
  var before = Date.now();
  assert.strictEqual(p.run('surveyNotificationSelfTest()'), 'sent');
  var m = /回答日時: (\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) JST\n/.exec(p.mails[0].body);
  assert.ok(m, p.mails[0].body);
  var asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 9 * 3600 * 1000;
  assert.ok(Math.abs(asUtc - before) < 5000, 'JST表示は実行時刻+9時間');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(p.mails[0].body));
});
