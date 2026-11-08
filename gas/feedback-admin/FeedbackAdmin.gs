/*
 * FeedbackAdmin.gs — 利用後アンケート管理画面（Issue #849 第2段階）。
 *
 * 公開Web App（gas/feedback/）とは別のGASプロジェクト。回答の閲覧・対応更新はこのプロジェクトだけが行う。
 * デプロイ設定: Execute as: User accessing the web app / Who has access: Only myself（既存 Survey Admin と同じ）。
 * さらに Script Properties の FEEDBACK_ADMIN_EMAILS（カンマ区切り）に含まれるアカウントだけを許可する。
 * 未設定・メールを取得できない場合はすべて拒否する（fail closed）。認可は API 呼び出しごとに毎回確認する。
 *
 * - getFeedbackDashboard(filter): 概要・問題分析・ご意見カードを返す（google.script.run から呼ぶ）。
 * - updateFeedbackStatus(update): response_id で特定した1行の status / memo 列だけを書き換える。
 *   回答本文・ブランド・その他の列は変更しない。ブランド不一致・該当なし・重複IDは更新しない。
 */
'use strict';

function feedbackAdminAllowedEmails_() {
  var raw = PropertiesService.getScriptProperties().getProperty('FEEDBACK_ADMIN_EMAILS') || '';
  return raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s; });
}

function isFeedbackAdmin_() {
  var allowed = feedbackAdminAllowedEmails_();
  if (!allowed.length) return false;
  var email = '';
  try {
    email = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  } catch (e) {
    return false;
  }
  return !!email && allowed.indexOf(email) !== -1;
}

function feedbackAdminError_(code) {
  return { success: false, error: { code: code } };
}

function doGet() {
  if (!isFeedbackAdmin_()) {
    return HtmlService.createHtmlOutput('アクセス権限がありません。').setTitle('利用後アンケート管理');
  }
  return HtmlService.createHtmlOutputFromFile('FeedbackAdminPage')
    .setTitle('利用後アンケート管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/* responses シート全体を読む。{ sheet, header, rows } / { error } */
function feedbackAdminReadSheet_() {
  var opened = FeedbackRepository.openResponses();
  if (opened.error) return opened;
  var sheet = opened.sheet;
  var columns = FeedbackCore.COLUMNS;
  var last = sheet.getLastRow();
  var rows = last >= 2 ? sheet.getRange(2, 1, last - 1, columns.length).getValues() : [];
  return { sheet: sheet, header: columns, rows: rows };
}

/* filter: { brand, period, scope, status, problem }（不正値は既定値に丸める） */
function getFeedbackDashboard(filter) {
  if (!isFeedbackAdmin_()) return feedbackAdminError_('FORBIDDEN');
  try {
    var read = feedbackAdminReadSheet_();
    if (read.error) {
      Logger.log('feedback admin storage unavailable: ' + read.error);
      return feedbackAdminError_('STORAGE_UNAVAILABLE');
    }
    var records = FeedbackAnalytics.parseRows(read.header, read.rows);
    var dashboard = FeedbackAnalytics.buildDashboard(records, filter, new Date());
    dashboard.success = true;
    dashboard.statusOptions = FeedbackAnalytics.STATUS_OPTIONS;
    dashboard.memoMaxChars = FeedbackAnalytics.MEMO_MAX_CHARS;
    dashboard.brands = Object.keys(FeedbackCore.BRANDS).map(function (id) { return { id: id, name: FeedbackCore.BRANDS[id].name }; });
    return dashboard;
  } catch (unexpected) {
    Logger.log('feedback admin dashboard failed: ' + String((unexpected && unexpected.name) || 'Error').slice(0, 40));
    return feedbackAdminError_('INTERNAL_ERROR');
  }
}

/* update: { responseId, brand, status, memo } → { success, card } / { success:false, error:{code} } */
function updateFeedbackStatus(update) {
  if (!isFeedbackAdmin_()) return feedbackAdminError_('FORBIDDEN');
  var validated = FeedbackAnalytics.validateStatusUpdate(update);
  if (!validated.ok) return feedbackAdminError_(validated.code);
  var value = validated.value;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return feedbackAdminError_('BUSY');
  try {
    var read = feedbackAdminReadSheet_();
    if (read.error) return feedbackAdminError_('STORAGE_UNAVAILABLE');
    var columns = read.header;
    var idIndex = columns.indexOf('response_id');
    var brandIndex = columns.indexOf('brand');
    var matches = [];
    read.rows.forEach(function (row, i) { if (row[idIndex] === value.responseId) matches.push(i); });
    if (matches.length === 0) return feedbackAdminError_('NOT_FOUND');
    if (matches.length > 1) return feedbackAdminError_('DUPLICATE_RESPONSE_ID');
    var index = matches[0];
    if (read.rows[index][brandIndex] !== value.brand) return feedbackAdminError_('BRAND_MISMATCH');

    var rowNumber = index + 2;
    var memoCell = /^[=+\-@\t\r]/.test(value.memo) ? "'" + value.memo : value.memo;
    read.sheet.getRange(rowNumber, columns.indexOf('status') + 1, 1, 1).setValues([[value.status]]);
    read.sheet.getRange(rowNumber, columns.indexOf('memo') + 1, 1, 1).setValues([[memoCell]]);

    var updatedRow = read.rows[index].slice();
    updatedRow[columns.indexOf('status')] = value.status;
    updatedRow[columns.indexOf('memo')] = memoCell;
    var record = FeedbackAnalytics.parseRows(columns, [updatedRow])[0];
    return { success: true, card: FeedbackAnalytics.toCard(record) };
  } catch (unexpected) {
    Logger.log('feedback admin update failed: ' + String((unexpected && unexpected.name) || 'Error').slice(0, 40));
    return feedbackAdminError_('INTERNAL_ERROR');
  } finally {
    lock.releaseLock();
  }
}
