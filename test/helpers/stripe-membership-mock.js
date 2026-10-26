/*
 * 会員Subscription作成まわりのStripeモック（Issue #528）。
 * GET /products/{id}・POST /products・GET /subscriptions?customer=... への応答を返す。
 * 該当しないリクエストは null を返す（呼び出し元の応答に任せる）。
 * state.existingSubscriptions: 照会で返す既存subscription（metadata.memberId付き）の配列
 * state.productMissing: trueなら最初のGETはresource_missing（作成後は存在する）
 */
'use strict';

function membershipLookupResponse(url, options, state) {
  var method = String((options && options.method) || 'get').toLowerCase();
  if (url.indexOf('/v1/products/') !== -1 && method === 'get') {
    if (state.productMissing && !state.productCreated) {
      return { responseCode: 404, body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such product' } } };
    }
    return { responseCode: 200, body: { id: decodeURIComponent(url.split('/v1/products/')[1].split('?')[0]), object: 'product' } };
  }
  if (/\/v1\/products$/.test(url) && method === 'post') {
    state.productCreated = true;
    return { responseCode: 200, body: { id: 'snb_member_monthly', object: 'product' } };
  }
  if (url.indexOf('/v1/subscriptions?') !== -1 && method === 'get') {
    return { responseCode: 200, body: { object: 'list', has_more: false, data: state.existingSubscriptions || [] } };
  }
  return null;
}

module.exports = { membershipLookupResponse: membershipLookupResponse };
