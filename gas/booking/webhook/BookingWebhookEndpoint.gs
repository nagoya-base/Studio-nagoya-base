/*
 * BookingWebhookEndpoint.gs — Booking Webhookプロジェクトの唯一のWeb Appエントリポイント
 * （Issue #341 PR-C。レビュー対応・1回目で新設。4回目で受信専用へ再設計）。ファイル名を
 * `Code.gs`にしないのは、`gas/booking/public/Code.gs`（Booking Web Appのエントリポイント）
 * とこのリポジトリ内で同名になり、テストヘルパー（test/helpers/gas-sandbox.js）が
 * サブディレクトリを跨いでファイル名だけで解決する都合上、意図せず誤った方が読み込まれる
 * 事故を避けるため。
 *
 * 【このプロジェクトについて】Stripe Webhook中継基盤（cloud-run/stripe-webhook-relay/）
 * からの呼び出しだけを受け付ける、**独立した新しいApps Scriptプロジェクト**。
 * Booking Web App（利用者向け）・Booking Admin（管理者向け）のいずれとも別プロジェクトで
 * あり、`doGet`・管理者向けのサーバー関数（予約詳細取得・確定・取消・メール送信等）を
 * 一切持たない（このプロジェクトのコンパイル済みバンドルに含まれるファイルは
 * `test/helpers/booking-deployment-manifest.js`の`BOOKING_WEBHOOK_FILES`参照。
 * `BookingAdmin.gs`/`BookingAdminWeb.gs`/`BookingTriggers.gs`等は含めない）。
 *
 * これにより、このプロジェクトのWeb Appデプロイを「Execute as: Me / Who has access:
 * Anyone」で公開しても、公開されるのは`doPost`（このファイル）だけであり、管理者専用UI・
 * 予約の確定/取消・メール送信等は構造的に一切公開されない
 * （`test/booking-webhook-deployment.test.js`で検証）。
 *
 * 【レビュー対応・4回目: このプロジェクトは受信・永続化専用】1〜3回目までは、この
 * プロジェクトが決済照合・予約自動確定まで行い、Booking Adminプロジェクトの
 * `expirePendingBookings`との競合を独自の分散ロック（BookingLockRepository）で
 * 防ごうとしていたが、「ロック確認から実際の書き込みまでの間に競合が起こり得る
 * （TOCTOU）」という指摘を受け、アーキテクチャそのものを見直した。このプロジェクトは
 * 署名検証済みイベントを`StripeEventRepository`（`gas/booking/shared/`。Booking Adminと
 * 共有するSpreadsheet上の「StripeEvents」シート）へ**安全に永続化するだけ**に責務を
 * 縮小し、決済照合・予約自動確定・Calendar/Bookingsへの書き込みは一切行わない
 * （`SpreadsheetRepository`・`BookingRepository`・`CardPayment`・`StripeGateway`・
 * `RecoveryRepository`・`BookingMailer`等、Bookings/Calendarに触れるファイルを
 * このプロジェクトから完全に排除した）。実際の決済照合・予約自動確定は、Booking Admin
 * プロジェクトの時間主導トリガー`processPendingStripeWebhookEvents`
 * （`gas/booking/admin/StripeWebhookProcessor.gs`）が行う。これにより、Webhook由来の
 * 予約確定と既存の`expirePendingBookings`が同じBooking AdminプロジェクトのLockServiceを
 * 共有するようになり、GAS公式のLockServiceだけで確実な排他を実現できる（詳細はREADME
 * 「Webhookと失効処理の競合」節参照）。
 *
 * 【認証】GASの`doPost(e)`はStripeの`Stripe-Signature`ヘッダーを検証できない
 * （リクエストヘッダーを取得できないため）。この関数が信頼するのは、Stripeの署名検証を
 * 済ませた中継基盤からの呼び出しであることを示す、POST本文中のHMAC署名
 * （StripeWebhookAuth.verifyRelayRequest）のみ。この検証に失敗した場合、Stripeイベントの
 * 中身を一切解釈せずFORBIDDENを返す（中継基盤・Stripeの実装詳細を外部へ一切出さない）。
 *
 * 【リクエスト形式】中継基盤は次の形のJSONをPOST本文として送る:
 *   { "timestamp": <中継基盤が署名した時刻。Unix秒>,
 *     "signature": "<HMAC-SHA256(secret, timestamp + '.' + body)の16進文字列>",
 *     "body": "<Stripeから受信した生のWebhookイベント本文（JSON文字列そのもの）>" }
 * ヘッダーではなく本文中にsignature/timestampを含める理由はGASの制約のため
 * （StripeWebhookAuth.gs冒頭コメント参照）。
 *
 * 【レスポンス形式・Stripeへの成功応答の条件（レビュー対応・4回目で変更）】GAS Web Appの
 * `doPost`はHTTPステータスを呼び出し元が選べない（正常終了時は常に200を返す）。そのため、
 * 実際の成否はレスポンスJSONの`success`フィールドで中継基盤へ伝える。中継基盤は
 * `success:false`の場合、Stripeへ5xxを返して自動再送を促すこと（README・
 * cloud-run/stripe-webhook-relay/参照）。`success:true`は、イベントを`StripeEventRepository`
 * へ**生のイベント本文まで含めて安全に永続化できた場合にのみ**返る（決済照合・予約自動
 * 確定の成否は一切問わない。それらはBooking Admin側の処理台帳とRecoveryで別途管理する）。
 */
'use strict';

function doPost(e) {
  return jsonOutputForWebhook_(handleStripeWebhookPost_(e));
}

function handleStripeWebhookPost_(e) {
  var requestId = Utilities.getUuid();
  var envelope;
  try {
    envelope = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (parseError) {
    Logger.log('requestId=' + requestId + ' stripeWebhook=result error.code=INVALID_JSON');
    return { success: false, error: { code: 'INVALID_JSON', message: 'リクエストの形式が正しくありません。' }, requestId: requestId };
  }

  var timestamp = envelope && envelope.timestamp;
  var signature = envelope && typeof envelope.signature === 'string' ? envelope.signature : '';
  var body = envelope && typeof envelope.body === 'string' ? envelope.body : '';

  var webhookConfig = BookingConfig.getStripeWebhookConfig();
  var authResult = StripeWebhookAuth.verifyRelayRequest(webhookConfig, timestamp, body, signature, new Date().getTime());
  if (!authResult.valid) {
    /* 認証失敗の詳細（どの条件で弾かれたか）はLoggerにのみ残し、外部へは一律FORBIDDEN。
       署名不一致・タイムスタンプ不正等を外部に区別させない（オラクル化を避ける）。 */
    Logger.log('requestId=' + requestId + ' stripeWebhook=result error.code=FORBIDDEN reason=' + (authResult.error && authResult.error.code));
    return { success: false, error: { code: 'FORBIDDEN', message: '認証に失敗しました。' }, requestId: requestId };
  }

  try {
    var result = receiveStripeEvent_(body);
    Logger.log('requestId=' + requestId + ' stripeWebhook=result accepted=' + result.accepted + ' code=' + result.code);
    return { success: !!result.accepted, code: result.code, message: result.message, requestId: requestId };
  } catch (unexpectedError) {
    Logger.log('requestId=' + requestId + ' stripeWebhook=result error.code=INTERNAL_ERROR');
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Webhook処理中にエラーが発生しました。しばらくしてから再度お試しください。' },
      requestId: requestId
    };
  }
}

/*
 * 署名検証済みのイベント本文を、StripeEventRepositoryへ安全に永続化するだけの処理
 * （レビュー対応・4回目。決済照合・予約自動確定は一切行わない。Booking Admin側の
 * processPendingStripeWebhookEventsに委ねる）。
 *
 * 戻り値: { accepted: boolean, code, message }。accepted:trueの場合のみ、呼び出し元は
 *   中継基盤・Stripeへ成功を伝えてよい（＝rawBodyまで含めて永続化できたことが確定した
 *   場合のみ）。
 */
function receiveStripeEvent_(rawBody) {
  var parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch (parseError) {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return { accepted: false, code: 'INVALID_EVENT_JSON', message: 'イベント本文を解析できませんでした。' };
  }
  var eventId = typeof parsed.id === 'string' ? parsed.id : '';
  var eventType = typeof parsed.type === 'string' ? parsed.type : '';
  if (!eventId || !eventType) {
    return { accepted: false, code: 'INVALID_EVENT_SHAPE', message: 'イベントid/typeが指定されていません。' };
  }

  var claimResult = StripeEventRepository.claim(eventId, eventType, new Date());
  if (claimResult.outcome === 'LOCK_TIMEOUT') {
    return { accepted: false, code: 'LOCK_TIMEOUT', message: '一時的に混み合っています。再試行します。' };
  }
  if (claimResult.outcome === 'ALREADY_TERMINAL') {
    /* Booking Admin側が既に処理を完了済み。安全に永続化済みのため成功を返す。 */
    return { accepted: true, code: 'ALREADY_' + claimResult.record.processingState, message: 'このイベントは処理済みです。' };
  }
  if (claimResult.outcome === 'IN_PROGRESS') {
    /*
     * 同一イベントの並行受信、またはBooking Admin側が処理に着手した直後の可能性がある。
     * 既にrawBodyまで永続化済みであれば安全に成功を返してよい。rawBodyがまだ空の場合、
     * 先行するclaim側がstoreRawBody実行前にクラッシュした可能性を否定できないため、
     * 保守的に失敗を返しStripeの自動再送に委ねる（先行側の永続化が完了していれば、
     * その再送時にはrawBody有りのALREADY_TERMINAL/IN_PROGRESS（rawBody有り）として
     * 成功を返せる）。
     */
    if (claimResult.record.rawBody) {
      return { accepted: true, code: 'ALREADY_RECEIVED', message: 'このイベントは既に永続化済みです。' };
    }
    return { accepted: false, code: 'IN_PROGRESS_NOT_YET_STORED', message: '永続化処理が進行中です。再試行します。' };
  }

  /* claimResult.outcome === 'CLAIMED'（新規、または前回rawBody保存に失敗した行の再試行）。 */
  try {
    StripeEventRepository.storeRawBody(claimResult.rowNumber, rawBody, new Date());
  } catch (storeError) {
    Logger.log('BookingWebhookEndpoint: rawBodyの永続化に失敗しました: ' + eventId + ' ' + storeError);
    return { accepted: false, code: 'LEDGER_WRITE_FAILED', message: 'イベントの永続化に失敗しました。再試行します。' };
  }
  return {
    accepted: true,
    code: claimResult.isRetry ? 'RETRY_STORED' : 'RECEIVED',
    message: 'イベントを受け付けました。'
  };
}

function jsonOutputForWebhook_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
