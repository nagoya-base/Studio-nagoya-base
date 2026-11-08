/*
 * FeedbackMaintenance.gs — 回答の保持期間による月次削除（Issue #835）。
 *
 * - 本番回答（is_test=0）は受信から180日、テスト回答（is_test=1）は30日を過ぎたら行ごと削除する。
 * - installFeedbackRetentionTrigger() をGASエディタから1回実行すると、毎月1日4時台に
 *   purgeExpiredFeedbackResponses が動くトリガーを作る（同名トリガーは作り直すので冪等）。
 * - 削除件数だけをログに残す（回答内容は記録しない）。
 */
'use strict';

var FEEDBACK_RETENTION_DAYS = 180;
var FEEDBACK_TEST_RETENTION_DAYS = 30;
var FEEDBACK_DAY_MS = 24 * 60 * 60 * 1000;

function purgeExpiredFeedbackResponses(nowArg) {
  /* 時間主導トリガーからはイベントオブジェクトが渡るため、Date 以外は現在時刻とみなす。 */
  var now = nowArg instanceof Date ? nowArg : new Date();
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log('feedback purge skipped: busy');
    return { deleted: 0, skipped: true };
  }
  try {
    var opened = FeedbackRepository.openResponses();
    if (opened.error) {
      Logger.log('feedback purge skipped: ' + opened.error);
      return { deleted: 0, skipped: true };
    }
    var sheet = opened.sheet;
    var last = sheet.getLastRow();
    if (last < 2) return { deleted: 0 };
    var columns = FeedbackCore.COLUMNS;
    var receivedCol = columns.indexOf('received_at');
    var testCol = columns.indexOf('is_test');
    var rows = sheet.getRange(2, 1, last - 1, columns.length).getValues();
    var deleted = 0;
    for (var i = rows.length - 1; i >= 0; i--) {
      var received = new Date(rows[i][receivedCol]);
      if (isNaN(received.getTime())) continue; /* 日時が読めない行は消さない（手で確認する） */
      var isTest = String(rows[i][testCol]) === '1';
      var days = isTest ? FEEDBACK_TEST_RETENTION_DAYS : FEEDBACK_RETENTION_DAYS;
      if (now.getTime() - received.getTime() > days * FEEDBACK_DAY_MS) {
        sheet.deleteRow(i + 2);
        deleted++;
      }
    }
    Logger.log('feedback purge: deleted ' + deleted + ' rows');
    return { deleted: deleted };
  } finally {
    lock.releaseLock();
  }
}

function installFeedbackRetentionTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'purgeExpiredFeedbackResponses') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('purgeExpiredFeedbackResponses').timeBased().onMonthDay(1).atHour(4).create();
  return 'installed';
}
