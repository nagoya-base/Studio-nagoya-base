/*
 * BookingWebhook.gs — Stripe Webhook中継基盤（cloud-run/stripe-webhook-relay/）からの
 * 呼び出しを受け付ける、Booking Adminプロジェクトの`doPost(e)`エントリポイント
 * （Issue #341 PR-C）。
 *
 * 【重要・デプロイ先とWeb Appデプロイ設定について】
 * このファイルはBookingAdmin.gs/BookingTriggers.gs/BookingAdminWeb.gsと同じBooking Admin
 * プロジェクトへデプロイする。Booking Web Appプロジェクト（Code.gs）には追加しない
 * （StripeWebhookHandler.gsのファイル冒頭コメントの理由と同じ。confirmBooking/
 * expirePendingBookingsとLockServiceを共有する必要があるため）。
 *
 * BookingAdminWeb.gsの`doGet()`（管理者本人用UI。Execute as: Me / Who has access:
 * Only myself）とこの`doPost(e)`は**同一プロジェクトの同一コード**として存在するが、
 * Web Appの「デプロイ」はGoogleが「1プロジェクトにつき複数デプロイ（別URL・別アクセス
 * 設定）」を許可しているため、この`doPost`を公開させたい場合は、既存の管理者専用
 * デプロイとは**別の新しいデプロイ**を作成し、そちらだけを「Execute as: Me / Who has
 * access: Anyone」にすること（README「Stripe Webhookエンドポイントのデプロイ」参照）。
 * 既存の管理者専用デプロイのアクセス設定は変更しない（doGetの挙動・セキュリティ境界を
 * 変えないため）。
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
 * 【レスポンス形式・Stripeへの成功応答の条件】GAS Web Appの`doPost`はHTTPステータスを
 * 呼び出し元が選べない（正常終了時は常に200を返す）。そのため、実際の成否は
 * レスポンスJSONの`success`フィールドで中継基盤へ伝える。中継基盤は`success:false`の
 * 場合、Stripeへ5xxを返して自動再送を促すこと（README・cloud-run/stripe-webhook-relay/
 * 参照）。`success:true`は、StripeWebhookHandler.processEventがイベント処理結果を
 * 永続化できた場合にのみ返る（StripeWebhookHandler.gs冒頭コメント参照）。
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
    var result = StripeWebhookHandler.processEvent(body);
    if (!result || typeof result !== 'object') {
      Logger.log('requestId=' + requestId + ' stripeWebhook=result error.code=INTERNAL_ERROR');
      return { success: false, error: { code: 'INTERNAL_ERROR', message: 'Webhook処理中にエラーが発生しました。' }, requestId: requestId };
    }
    Logger.log('requestId=' + requestId + ' stripeWebhook=result ackSuccess=' + result.ackSuccess + ' code=' + result.code);
    return { success: !!result.ackSuccess, code: result.code, message: result.message, requestId: requestId };
  } catch (unexpectedError) {
    Logger.log('requestId=' + requestId + ' stripeWebhook=result error.code=INTERNAL_ERROR');
    return {
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Webhook処理中にエラーが発生しました。しばらくしてから再度お試しください。' },
      requestId: requestId
    };
  }
}

function jsonOutputForWebhook_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
