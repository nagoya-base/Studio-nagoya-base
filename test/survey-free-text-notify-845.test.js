/*
 * Issue #845: SNB・SNB mens共通アンケートで、自由記述がある回答だけを本文付きでメール通知する。
 * SNB（/survey/）と SNB mens（/mens/survey/）は同じschema・同じsurvey-config.js・同じ公開Web Appを使うため、
 * 両入口の送信（survey_path 有無・?src= 違い）に同一ルールが適用されることを確認する。
 * 本番データは使わず、prepare-survey-gas-project.js の配布物をvm＋スタブで実行する。
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

var ROOT = path.join(__dirname, '..');
var NOW = new Date('2026-11-08T03:00:00.000Z');
var NOTIFY = { SURVEY_NOTIFICATION_EMAIL: 'admin@example.com', SURVEY_ADMIN_URL: 'https://example.com/admin' };
var SUBJECT = '【Studio Nagoya Base】アンケートに自由記述の回答がありました';
var seq = 0;

function nextHash() {
  seq += 1;
  return '123e4567-e89b-42d3-a456-' + String(500000000000 + seq);
}
function body(answers, extra) {
  return JSON.stringify(Object.assign({ schema_version: schema.version, respondent_hash: nextHash(), answers: answers }, extra || {}));
}
function call(project, bodyText) {
  project.sandbox.__body = bodyText;
  project.sandbox.__now = NOW;
  return project.run('handleSurveyRequest_("submit", __body, __now)');
}

/* SNB・SNB mens 両入口からの送信を表す（クライアントは同一payload形式。違いは ?src= による survey_path のみ）。 */
var ENTRIES = [
  { name: 'SNB /survey/', extra: {} },
  { name: 'SNB /survey/?src=x_snb', extra: { survey_path: 'x_snb' } },
  { name: 'SNB mens /mens/survey/', extra: { survey_path: '' } },
  { name: 'SNB mens /mens/survey/?src=x_mens', extra: { survey_path: 'x_mens' } }
];

test('#845 入口: SNBとSNB mensは同じschema・同じGAS設定・同じ送信スクリプトを使う', function () {
  var snb = fs.readFileSync(path.join(ROOT, 'survey/index.html'), 'utf8');
  var mens = fs.readFileSync(path.join(ROOT, 'mens/survey/index.html'), 'utf8');
  assert.match(snb, /data-schema-url="survey-schema\.json/);
  assert.match(mens, /data-schema-url="\.\.\/\.\.\/survey\/survey-schema\.json/);
  ['survey-core.js', 'survey-config.js', 'survey-app.js'].forEach(function (file) {
    assert.ok(snb.indexOf('../scripts/' + file) !== -1, 'SNB loads ' + file);
    assert.ok(mens.indexOf('../../scripts/' + file) !== -1, 'mens loads ' + file);
  });
  assert.ok(!/survey-config-mens|SurveyApiConfigMens/.test(mens), 'mens専用の送信先を持たない');
});

test('#845 判定: 自由記述欄はschemaの type:text と otherTexts を漏れなく列挙する', function () {
  var expected = [];
  schema.steps.forEach(function (step) {
    step.questions.forEach(function (q) {
      if (q.type === 'text') expected.push(q.id);
      (q.otherTexts || []).forEach(function (o) { expected.push(o.field); });
    });
  });
  var fields = Core.freeTextFields(schema);
  assert.deepStrictEqual(fields.map(function (f) { return f.field; }), expected);
  assert.ok(expected.indexOf('free_feedback') !== -1 && expected.indexOf('support_message') !== -1);
  assert.ok(expected.indexOf('kinbaku_role_other') !== -1 && expected.indexOf('gender_identity_other') !== -1);
  assert.ok(fields.length >= 20);
  fields.forEach(function (f) { assert.ok(f.label && typeof f.label === 'string'); });
  var other = fields.filter(function (f) { return f.field === 'usage_purpose_other'; })[0];
  assert.strictEqual(other.label, '利用目的（複数選択可） ／ その他の内容');
});

test('#845 判定: 空白のみ・非文字列は自由記述なし扱い、trim後の本文を返す', function () {
  assert.deepStrictEqual(Core.collectFreeTexts(schema, { free_feedback: '  \n ', support_message: '' }), []);
  assert.deepStrictEqual(Core.collectFreeTexts(schema, { free_feedback: ['x'] }), []);
  assert.deepStrictEqual(Core.collectFreeTexts(schema, null), []);
  var items = Core.collectFreeTexts(schema, { free_feedback: '  鏡が欲しい  ' });
  assert.strictEqual(items.length, 1);
  assert.strictEqual(items[0].text, '鏡が欲しい');
});

ENTRIES.forEach(function (entry) {
  test('#845 ' + entry.name + ': 選択式のみ・空白のみの回答は通知0通（保存は成功）', function () {
    var project = loadSurveyProject('public', { properties: NOTIFY });
    assert.strictEqual(call(project, body(A.user(), entry.extra)).success, true);
    assert.strictEqual(call(project, body(A.nonuser({ free_feedback: '   ', support_message: '\n\n' }), entry.extra)).success, true);
    assert.strictEqual(project.sheets.responses._rows.length, 3);
    assert.strictEqual(project.mails.length, 0);
  });

  test('#845 ' + entry.name + ': 自由記述1項目で設問名＋本文付き通知1通', function () {
    var project = loadSurveyProject('public', { properties: NOTIFY });
    var payload = body(A.user({ free_feedback: '  シャワーの水圧を上げてほしい  ' }), entry.extra);
    assert.strictEqual(call(project, payload).success, true);
    assert.strictEqual(project.mails.length, 1);
    var mail = project.mails[0];
    assert.strictEqual(mail.to, 'admin@example.com');
    assert.strictEqual(mail.subject, SUBJECT);
    var label = Core.findQuestion(schema, 'free_feedback').label;
    assert.ok(mail.body.indexOf('■ ' + label + '\nシャワーの水圧を上げてほしい\n') !== -1);
    assert.ok(mail.body.indexOf(NOW.toISOString()) !== -1);
    assert.ok(mail.body.indexOf('https://example.com/admin') !== -1);
  });
});

test('#845 複数項目（独立コメント欄＋「その他」追記欄）は1通にまとめ、schema順に並べる', function () {
  var project = loadSurveyProject('public', { properties: NOTIFY });
  var answers = A.user({
    usage_purpose: ['self_practice', 'other'], usage_purpose_other: '縄の撮影会',
    free_feedback: '鏡を増やしてほしい', support_message: 'いつも応援しています'
  });
  assert.strictEqual(call(project, body(answers)).success, true);
  assert.strictEqual(project.mails.length, 1);
  var text = project.mails[0].body;
  var a = text.indexOf('■ 利用目的（複数選択可） ／ その他の内容\n縄の撮影会');
  var b = text.indexOf('鏡を増やしてほしい');
  var c = text.indexOf('いつも応援しています');
  assert.ok(a !== -1 && b > a && c > b, text);
});

test('#845 メールに選択式回答・respondent_hash・survey_path・内部識別子を含めない', function () {
  var project = loadSurveyProject('public', { properties: NOTIFY });
  var payload = JSON.parse(body(A.user({ free_feedback: '感想です' }), { survey_path: 'x_secret_src' }));
  call(project, JSON.stringify(payload));
  var text = project.mails[0].body + project.mails[0].subject;
  assert.strictEqual(text.indexOf(payload.respondent_hash), -1);
  assert.strictEqual(text.indexOf('x_secret_src'), -1);
  ['usage_segment', 'male_male', 'definitely', 'aichi', 'nagoya', 'respondent', 'hash', 'is_test', 'SPREADSHEET'].forEach(function (needle) {
    assert.strictEqual(text.indexOf(needle), -1, needle);
  });
});

test('#845 テスト・重複・対象外・検証失敗・保存失敗は通知0通', function () {
  var project = loadSurveyProject('public', { properties: NOTIFY });
  var ft = { free_feedback: '自由記述あり' };
  call(project, body(A.user(ft), { is_test: 1 }));
  assert.strictEqual(project.mails.length, 0, 'テスト');
  var dup = body(A.user(ft));
  assert.strictEqual(call(project, dup).success, true);
  assert.strictEqual(call(project, dup).error.code, 'DUPLICATE_RESPONSE');
  assert.strictEqual(project.mails.length, 1, '重複は追加通知しない');
  assert.strictEqual(call(project, body(A.user(Object.assign({ age_screening: 'under_18' }, ft)))).success, false);
  assert.strictEqual(call(project, body(A.user(Object.assign({ usage_status: 'zzz' }, ft)))).success, false);
  assert.strictEqual(call(project, JSON.stringify({ schema_version: -1, respondent_hash: nextHash(), answers: A.user(ft) })).success, false);
  assert.strictEqual(project.mails.length, 1, '対象外・検証失敗');
  var busy = loadSurveyProject('public', { properties: NOTIFY, lockFails: true });
  assert.strictEqual(call(busy, body(A.user(ft))).error.code, 'BUSY');
  assert.strictEqual(busy.mails.length, 0, '保存失敗');
});

test('#845 非表示になった設問の自由記述は破棄され、通知対象にならない', function () {
  var project = loadSurveyProject('public', { properties: NOTIFY });
  /* nonuse_reasons は未利用者のみ表示。利用者回答に紛れ込んだ値は保存も通知もされない。 */
  call(project, body(A.user({ nonuse_reasons: ['other'], nonuse_reasons_other: '紛れ込み' })));
  assert.strictEqual(project.mails.length, 0);
});

test('#845 送信失敗・宛先未設定でも回答保存は成功し、ログに宛先・本文を残さない', function () {
  var ft = { free_feedback: 'ログに出してはいけない本文' };
  var failing = loadSurveyProject('public', { properties: NOTIFY, mailFails: true, mailErrorMessage: 'Invalid email: admin@example.com' });
  assert.strictEqual(call(failing, body(A.user(ft))).success, true);
  assert.strictEqual(failing.sheets.responses._rows.length, 2);
  assert.ok(failing.logs.some(function (l) { return /survey notify failed/.test(l); }));
  var unset = loadSurveyProject('public');
  assert.strictEqual(call(unset, body(A.user(ft))).success, true);
  assert.strictEqual(unset.sheets.responses._rows.length, 2);
  assert.strictEqual(unset.mails.length, 0);
  assert.ok(unset.logs.some(function (l) { return /survey notify skipped/.test(l); }));
  failing.logs.concat(unset.logs).forEach(function (l) {
    assert.strictEqual(String(l).indexOf('admin@example.com'), -1);
    assert.strictEqual(String(l).indexOf('ログに出してはいけない本文'), -1);
  });
});

test('#845 公開GASのみ変更し、予約GAS・管理者GASに通知処理を持ち込まない', function () {
  var admin = fs.readFileSync(path.join(ROOT, 'gas/survey/admin/SurveyAdmin.gs'), 'utf8');
  assert.ok(admin.indexOf('collectFreeTexts') === -1 && admin.indexOf('MailApp') === -1);
  var pub = JSON.parse(fs.readFileSync(path.join(ROOT, 'gas/survey/public/appsscript.json'), 'utf8'));
  assert.deepStrictEqual(pub.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/script.send_mail']);
});

test('#845 配信確認: surveyNotificationSelfTest は保存せずに確認メールを1通だけ送る', function () {
  var project = loadSurveyProject('public', { properties: NOTIFY });
  assert.strictEqual(project.run('surveyNotificationSelfTest()'), 'sent');
  assert.strictEqual(project.mails.length, 1);
  assert.strictEqual(project.mails[0].to, 'admin@example.com');
  assert.strictEqual(project.mails[0].subject, '[配信確認] ' + SUBJECT);
  assert.match(project.mails[0].body, /回答は保存されていません/);
  assert.ok(!project.sheets.responses || project.sheets.responses._rows.length <= 1, 'responsesへ書き込まない');
  assert.ok(!project.sheets.events || project.sheets.events._rows.length <= 1, 'eventsへ書き込まない');
  var unset = loadSurveyProject('public');
  assert.strictEqual(unset.run('surveyNotificationSelfTest()'), 'skipped: notification address not configured');
  assert.strictEqual(unset.mails.length, 0);
  var failing = loadSurveyProject('public', { properties: NOTIFY, mailFails: true, mailErrorMessage: 'Invalid email: admin@example.com' });
  assert.strictEqual(failing.run('surveyNotificationSelfTest()'), 'failed: Error');
  failing.logs.forEach(function (l) { assert.strictEqual(String(l).indexOf('admin@example.com'), -1); });
});

test('#845 配信確認: 確認用関数はWeb Appの入口から到達できない', function () {
  var src = fs.readFileSync(path.join(ROOT, 'gas/survey/public/SurveyWebApp.gs'), 'utf8');
  var handler = src.slice(src.indexOf('function handleSurveyRequest_'), src.indexOf('function handleSurveySubmit_'));
  assert.strictEqual(handler.indexOf('SelfTest'), -1);
  assert.strictEqual(src.slice(src.indexOf('function doPost'), src.indexOf('function surveyJsonOutput_')).indexOf('SelfTest'), -1);
});
