/*
 * SurveyAdmin.gs — アンケート管理者専用Web App（Issue #374）。
 *
 * 公開アンケートWeb App（gas/survey/public/）とは別プロジェクトで、アクセス制御を分離する。
 * デプロイ設定: Execute as: User accessing the web app / Who has access: Only myself。
 * さらに多層防御として、Script Propertiesの SURVEY_ADMIN_EMAILS（カンマ区切り）に含まれる
 * アカウントだけを許可する（未設定・メール取得不可はすべて拒否＝fail closed）。
 *
 * 画面へ返すのは SurveyAnalytics.buildDashboard の集計結果のみ。個別回答行・respondent_hash・
 * timestamp（日時）は返さない（自由記述にも日付単位の投稿日だけを付ける）。
 */
'use strict';

function surveyAdminAllowedEmails_() {
  var raw = PropertiesService.getScriptProperties().getProperty('SURVEY_ADMIN_EMAILS') || '';
  return raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s; });
}

function isSurveyAdmin_() {
  var allowed = surveyAdminAllowedEmails_();
  if (!allowed.length) return false;
  var email = '';
  try {
    email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (e) {
    return false;
  }
  return !!email && allowed.indexOf(email) !== -1;
}

function assertSurveyAdmin_() {
  if (!isSurveyAdmin_()) throw new Error('FORBIDDEN');
}

function doGet() {
  if (!isSurveyAdmin_()) {
    return HtmlService.createHtmlOutput('アクセス権限がありません。').setTitle('Survey Admin');
  }
  return HtmlService.createHtmlOutputFromFile('SurveyAdminPage')
    .setTitle('Survey Admin')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* google.script.runから呼ぶ。filter: { segment: 'all' | usage_segment値 } */
function getSurveyDashboard(filter) {
  assertSurveyAdmin_();
  var segment = filter && typeof filter.segment === 'string' ? filter.segment : 'all';
  return SurveyAnalytics.buildDashboard(
    SURVEY_SCHEMA,
    SurveyRepository.readResponses(),
    SurveyRepository.readEvents(),
    { segment: segment }
  );
}
