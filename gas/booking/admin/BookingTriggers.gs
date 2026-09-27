/*
 * BookingTriggers.gs — PENDING TTL失効・Stripe Webhookイベント処理の時間主導トリガー
 * （Issue #268、Issue #341 PR-C）。
 *
 * 【重要・デプロイ先について】このファイルはBookingAdmin.gsと同じBooking Admin
 * プロジェクト（`SPREADSHEET_ID`のSpreadsheetへコンテナバインド）へデプロイする。
 * Web App本体（スタンドアロン）へはデプロイしない。confirmBooking（BookingAdmin.gs）と
 * expirePendingBookings（このファイル）を同一プロジェクトに置くことで、両者が同じ
 * LockService.getScriptLock()を共有し、PENDING→CONFIRMEDとPENDING→EXPIREDの競合を
 * 排除している（3回目レビュー指摘対応。詳細はBookingRepository.gs・README参照）。
 *
 * 【レビュー対応・4回目で追加】processPendingStripeWebhookEvents（このファイル）も同じ
 * 理由で同一プロジェクトに置く。独立したBooking Webhookプロジェクトが永続化した
 * StripeEventsの未処理イベントを取り出し、決済照合・予約自動確定
 * （StripeWebhookProcessor.gs）まで行うため、expirePendingBookings/confirmBookingと
 * 同じLockService.getScriptLock()を共有し、予約単位の分散ロックを一切必要としない
 * （詳細はStripeWebhookProcessor.gs冒頭コメント・README「Webhookと失効処理の競合」節
 * 参照）。
 *
 * 本PRでは本番の時間主導トリガー作成そのものは必須にしない（README.mdに手動セットアップ
 * 手順を記載する）。createExpirePendingBookingsTrigger()・
 * createProcessPendingStripeWebhookEventsTrigger()は、Booking Adminプロジェクトの
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

/*
 * 正式関数: processPendingStripeWebhookEvents()（Issue #341 PR-Cレビュー対応・4回目で追加）。
 * 時間主導トリガーのハンドラ関数名としてそのまま指定する。独立したBooking Webhook
 * プロジェクトが永続化したStripeEventsの未処理イベントを取り出し、決済照合・予約自動確定
 * まで行う（StripeWebhookProcessor.gs参照）。now引数は省略可能（時間主導トリガーからは
 * 常に引数なしで呼ばれ、StripeWebhookProcessor側で現在時刻へフォールバックする。
 * テストコードから処理時刻を固定できるようそのまま受け渡す）。
 */
function processPendingStripeWebhookEvents(now) {
  try {
    var result = StripeWebhookProcessor.processPendingStripeWebhookEvents(now);
    Logger.log('processPendingStripeWebhookEvents: ' + JSON.stringify(result));
    return result;
  } catch (e) {
    Logger.log('processPendingStripeWebhookEvents failed: ' + (e && e.message));
    throw e;
  }
}

/*
 * GASエディタから手動で一度だけ実行するための補助関数（README.md参照）。
 * 1分おきにprocessPendingStripeWebhookEventsを実行するトリガーを作成する。Stripeの
 * Webhook配信からBookingsへの確定反映までの遅延を短く抑えるため、
 * expirePendingBookings（15分間隔）より短い間隔にする
 * （処理権の有効期限はStripeWebhookProcessor.gsのGAS_MAX_EXECUTION_MS_等を参照。
 * レビュー対応・7回目）。
 */
function createProcessPendingStripeWebhookEventsTrigger() {
  var FUNCTION_NAME = 'processPendingStripeWebhookEvents';
  var existing = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return trigger.getHandlerFunction() === FUNCTION_NAME;
  });
  if (existing.length > 0) {
    Logger.log('トリガーは既に存在します: ' + FUNCTION_NAME);
    return existing[0];
  }
  return ScriptApp.newTrigger(FUNCTION_NAME).timeBased().everyMinutes(1).create();
}
