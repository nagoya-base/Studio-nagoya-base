/*
 * BookingTriggers.gs — PENDING TTL失効の時間主導トリガー（Issue #268）。
 *
 * 本PRでは本番の時間主導トリガー作成そのものは必須にしない（README.mdに手動セットアップ
 * 手順を記載する）。createExpirePendingBookingsTrigger()は、GASエディタから一度だけ
 * 手動実行すればトリガーを作成できる補助関数。既に同名関数のトリガーが存在する場合は
 * 重複作成しない。
 */
'use strict';

/* 正式関数: expirePendingBookings()（Issue #268本文どおりのグローバル関数名）。
   時間主導トリガーのハンドラ関数名としてそのまま指定する。 */
function expirePendingBookings() {
  try {
    var result = BookingRepository.expirePendingBookings();
    Logger.log('expirePendingBookings: ' + JSON.stringify(result));
    return result;
  } catch (e) {
    Logger.log('expirePendingBookings failed: ' + (e && e.message));
    throw e;
  }
}

/* GASエディタから手動で一度だけ実行するための補助関数（README.md参照）。
   15分おきに expirePendingBookings を実行するトリガーを作成する。 */
function createExpirePendingBookingsTrigger() {
  var FUNCTION_NAME = 'expirePendingBookings';
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === FUNCTION_NAME;
  });
  if (existing.length > 0) {
    Logger.log('トリガーは既に存在します: ' + FUNCTION_NAME);
    return existing[0];
  }
  return ScriptApp.newTrigger(FUNCTION_NAME).timeBased().everyMinutes(15).create();
}
