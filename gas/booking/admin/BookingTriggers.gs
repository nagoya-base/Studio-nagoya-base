/*
 * BookingTriggers.gs — PENDING TTL失効の時間主導トリガー（Issue #268）。
 *
 * 【重要・デプロイ先について】このファイルはBookingAdmin.gsと同じBooking Admin
 * プロジェクト（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）へデプロイする。
 * Web App本体（スタンドアロン）へはデプロイしない。confirmBooking（BookingAdmin.gs）と
 * expirePendingBookings（このファイル）を同一プロジェクトに置くことで、両者が同じ
 * LockService.getScriptLock()を共有し、PENDING→CONFIRMEDとPENDING→EXPIREDの競合を
 * 排除している（3回目レビュー指摘対応。詳細はBookingRepository.gs・README参照）。
 *
 * 本PRでは本番の時間主導トリガー作成そのものは必須にしない（README.mdに手動セットアップ
 * 手順を記載する）。createExpirePendingBookingsTrigger()は、Booking Adminプロジェクトの
 * スクリプトエディタから一度だけ手動実行すればトリガーを作成できる補助関数。既に同名関数の
 * トリガーが存在する場合は重複作成しない。
 */
'use strict';

/* 正式関数: expirePendingBookings()（Issue #268本文どおりのグローバル関数名）。
   時間主導トリガーのハンドラ関数名としてそのまま指定する。
   now引数は省略可能（時間主導トリガーからは常に引数なしで呼ばれ、
   BookingRepository.expirePendingBookings側で現在時刻へフォールバックする）。
   テストコードから受付時刻を固定して当日判定・TTLを検証できるよう、そのまま
   BookingRepository.expirePendingBookingsへ受け渡す（Issue #270）。 */
function expirePendingBookings(now) {
  try {
    var result = BookingRepository.expirePendingBookings(now);
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
