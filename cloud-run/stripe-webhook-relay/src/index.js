/*
 * index.js — Cloud Run向けのHTTPエントリポイント（Issue #341 PR-C）。
 *
 * このファイル自体は本番のCloud Runサービスとしてデプロイ・起動されていない
 * （本Issueの範囲では「コードの提供のみ」。実際のデプロイはオーナーの明示承認後に
 * 別途行う。gas/booking/README.md「Stripe Webhookエンドポイントのデプロイ」参照）。
 *
 * 依存を最小限にするため、Express等のフレームワークは使わずNode標準の`http`モジュール
 * のみを使う。署名検証（`stripe`パッケージ）以外の外部依存を持たない。
 *
 * 必須環境変数:
 * - STRIPE_WEBHOOK_SECRET: StripeダッシュボードのWebhook Endpointに対応する署名シークレット
 *   （`whsec_...`）。GASには一切渡さない。
 * - GAS_WEBHOOK_RELAY_SECRET: GAS（Booking Adminプロジェクト）の
 *   `STRIPE_WEBHOOK_RELAY_SECRET`と同じ値。
 * - GAS_WEBHOOK_URL: Booking Adminプロジェクトの、Webhook受信専用デプロイのURL
 *   （`doGet`用の管理者専用デプロイとは別のデプロイURL。README参照）。
 * 任意環境変数:
 * - PORT（既定8080。Cloud Runの規約）。
 */
'use strict';

const http = require('http');
const Stripe = require('stripe');
const { handleWebhookRequest } = require('./handler');

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* GASへの転送。GAS Web Appは常にHTTP 200を返す仕様（ContentServiceの制約）のため、
   実際の成否はレスポンスJSONのsuccessフィールドで判定する
   （gas/booking/admin/BookingWebhook.gs参照）。 */
async function forwardToGas(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    throw new Error('GASからの応答を解析できませんでした。');
  }
  return parsed;
}

function buildConfig() {
  return {
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    relaySharedSecret: process.env.GAS_WEBHOOK_RELAY_SECRET || '',
    gasWebhookUrl: process.env.GAS_WEBHOOK_URL || ''
  };
}

/* 署名検証専用。実際のStripe API呼び出しは行わないため、APIキーはダミー値でよい
   （stripe.webhooks.constructEventはネットワークを使わないローカルHMAC演算のため）。 */
const stripeClient = Stripe(process.env.STRIPE_API_KEY || 'sk_not_used_for_webhook_verification');

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (readError) {
    res.writeHead(400).end();
    return;
  }

  const result = await handleWebhookRequest({
    rawBody,
    signatureHeader: req.headers['stripe-signature'],
    config: buildConfig(),
    stripeClient,
    forwardToGas
  });

  /* Stripe・運用者向けの詳細（reason/gasCode等）は監視ログにのみ出し、レスポンス本文には
     最小限のみ返す（Stripe自体はレスポンス本文を解釈しないため）。 */
  console.log(JSON.stringify({ event: 'stripe_webhook_relay', result }));
  res.writeHead(result.stripeStatus, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ reason: result.reason }));
});

/* require.main===moduleの場合のみ実際にlistenする（node --testやrequire()経由での
   読み込み時に意図せずポートを占有しないため）。 */
if (require.main === module) {
  const port = process.env.PORT || 8080;
  server.listen(port, () => {
    console.log(`stripe-webhook-relay listening on port ${port}`);
  });
}

module.exports = { server, forwardToGas, buildConfig };
