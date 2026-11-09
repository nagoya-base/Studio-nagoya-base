/*
 * feedback-token-core.js — 利用後アンケートの「予約単位の回答リンク」トークン（Issue #834 第3段階）。純粋ロジック。
 *
 * 2つのGASプロジェクトへ同じファイルを配る（どちらも FeedbackTokenCore.gs として）:
 *   - Booking Admin（gas/booking/admin/FeedbackInvites.gs）: 利用終了2時間後の案内メールでトークンを発行する。
 *   - 回答用 公開Web App（gas/feedback/FeedbackTokens.gs）: 回答の受付時にトークンを検証する。
 * 両者は Script Property `FEEDBACK_TOKEN_SECRET`（同じ値・32文字以上・Gitに書かない）だけを共有する。
 * 回答用GASは Booking の Spreadsheet を開かない（予約IDも受け取らない）。
 *
 * 形式（英小文字・数字だけの66文字。フォームの TOKEN_PATTERN [A-Za-z0-9_-]{16,128} に収まる）:
 *   'f1' + ブランド(1: s|m|x) + 有効期限(UNIX秒の36進・7桁) + tokenId(16進24桁) + 署名(16進32桁)
 *   - tokenId = HMAC-SHA256(secret, 'feedback-invite-id:v1:' + bookingId) の先頭96bit。
 *     同じ予約からは常に同じ tokenId になる（手動再送でも別回答にならない＝1予約1回答）。
 *     秘密鍵なしに予約IDから求めたり、tokenIdから予約IDを戻したりはできない。
 *   - 署名 = HMAC-SHA256(secret, 'feedback-invite-sig:v1:' + 先頭の本体) の先頭128bit。
 *     ブランド・期限・tokenId のどれを書き換えても TOKEN_INVALID になる（推測・改ざん不可）。
 *   - 有効期限 = 利用終了時刻 + 14日（フォームの文言「ご利用後14日間」と同じ）。
 * トークンはフォームURLの `#t=` 以降に置く（サーバーログ・リファラに載らない）。
 *
 * HMACの計算は実行環境ごとに注入する（hmacHex(key, message) → 64桁の16進）。GASでは
 * Utilities.computeHmacSha256Signature、Nodeのテストでは crypto を使う。
 */
'use strict';

var FeedbackTokenCore = (function () {
  var VERSION = 'f1';
  var VALID_DAYS = 14;
  var DAY_MS = 24 * 60 * 60 * 1000;
  var MIN_SECRET_LENGTH = 32;
  var MAX_SECRET_LENGTH = 256;
  var ID_HEX_LENGTH = 24;
  var SIG_HEX_LENGTH = 32;
  var EXP_LENGTH = 7;
  var TOKEN_PATTERN = /^f1([smx])([0-9a-z]{7})([0-9a-f]{24})([0-9a-f]{32})$/;

  /* フォーム側のブランドID（feedback-core.js と同じ）→ 1文字コード */
  var BRAND_CODES = { snb: 's', mens: 'm', 'studio-x': 'x' };
  var CODE_BRANDS = { s: 'snb', m: 'mens', x: 'studio-x' };
  /* Booking台帳の brand 列（snb / mens / studio_x）→ フォームのブランドID */
  var RESERVATION_BRANDS = { snb: 'snb', mens: 'mens', studio_x: 'studio-x' };

  var FORM_BASE_URL = 'https://nagoya-base.github.io/Studio-nagoya-base/feedback/';

  function isUsableSecret(secret) {
    return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH && secret.length <= MAX_SECRET_LENGTH;
  }

  /* GASの byte[]（-128〜127）や Node の Buffer を16進文字列へ。 */
  function bytesToHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
      out += (b < 16 ? '0' : '') + b.toString(16);
    }
    return out;
  }

  /* 長さが同じ文字列を、途中で打ち切らずに比較する。 */
  function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  function toFeedbackBrand(bookingBrand) {
    return Object.prototype.hasOwnProperty.call(RESERVATION_BRANDS, bookingBrand) ? RESERVATION_BRANDS[bookingBrand] : null;
  }

  function expiresAtForEnd(endMs) {
    return endMs + VALID_DAYS * DAY_MS;
  }

  function hmac_(hmacHex, secret, message) {
    var hex = String(hmacHex(secret, message) || '');
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('FeedbackTokenCore: hmacHex must return 64 hex chars');
    return hex;
  }

  function tokenIdFor(bookingId, secret, hmacHex) {
    return hmac_(hmacHex, secret, 'feedback-invite-id:v1:' + String(bookingId)).slice(0, ID_HEX_LENGTH);
  }

  function sign_(body, secret, hmacHex) {
    return hmac_(hmacHex, secret, 'feedback-invite-sig:v1:' + body).slice(0, SIG_HEX_LENGTH);
  }

  /*
   * 発行。params: { secret, bookingId, brand（フォームのブランドID）, expiresAtMs }
   * 戻り値: { token, tokenId, expiresAtMs（秒へ切り捨てた実際の期限） }
   */
  function issue(params, hmacHex) {
    var p = params || {};
    if (!isUsableSecret(p.secret)) throw new Error('FeedbackTokenCore: secret is not usable');
    if (!p.bookingId) throw new Error('FeedbackTokenCore: bookingId is required');
    var code = BRAND_CODES[p.brand];
    if (!code) throw new Error('FeedbackTokenCore: unknown brand');
    var seconds = Math.floor(Number(p.expiresAtMs) / 1000);
    if (!(seconds > 0)) throw new Error('FeedbackTokenCore: invalid expiry');
    var exp = seconds.toString(36);
    if (exp.length > EXP_LENGTH) throw new Error('FeedbackTokenCore: expiry out of range');
    while (exp.length < EXP_LENGTH) exp = '0' + exp;
    var tokenId = tokenIdFor(p.bookingId, p.secret, hmacHex);
    var body = VERSION + code + exp + tokenId;
    return { token: body + sign_(body, p.secret, hmacHex), tokenId: tokenId, expiresAtMs: seconds * 1000 };
  }

  /*
   * 検証（台帳は見ない）。判定順: 形式・署名 → ブランド一致 → 期限。
   * 戻り値: { ok:true, brand, tokenId, expiresAtMs } / { ok:false, code }
   *   code: TOKEN_NOT_CONNECTED（秘密鍵が未設定）/ TOKEN_INVALID / TOKEN_BRAND_MISMATCH / TOKEN_EXPIRED
   */
  function check(token, formBrand, nowMs, secret, hmacHex) {
    if (!isUsableSecret(secret)) return { ok: false, code: 'TOKEN_NOT_CONNECTED' };
    var match = typeof token === 'string' ? TOKEN_PATTERN.exec(token) : null;
    if (!match) return { ok: false, code: 'TOKEN_INVALID' };
    var body = token.slice(0, token.length - SIG_HEX_LENGTH);
    if (!constantTimeEqual(sign_(body, secret, hmacHex), match[4])) return { ok: false, code: 'TOKEN_INVALID' };
    var brand = CODE_BRANDS[match[1]];
    if (brand !== formBrand) return { ok: false, code: 'TOKEN_BRAND_MISMATCH' };
    var expiresAtMs = parseInt(match[2], 36) * 1000;
    if (!(typeof nowMs === 'number' && nowMs < expiresAtMs)) return { ok: false, code: 'TOKEN_EXPIRED' };
    return { ok: true, brand: brand, tokenId: match[3], expiresAtMs: expiresAtMs };
  }

  /* 署名だけを確かめて tokenId を取り出す（期限・ブランドは問わない。release 用）。不正は null。 */
  function verifiedTokenId(token, secret, hmacHex) {
    if (!isUsableSecret(secret)) return null;
    var match = typeof token === 'string' ? TOKEN_PATTERN.exec(token) : null;
    if (!match) return null;
    var body = token.slice(0, token.length - SIG_HEX_LENGTH);
    return constantTimeEqual(sign_(body, secret, hmacHex), match[4]) ? match[3] : null;
  }

  function formUrl(brand, token) {
    if (!BRAND_CODES[brand]) throw new Error('FeedbackTokenCore: unknown brand');
    return FORM_BASE_URL + brand + '/#t=' + token;
  }

  return {
    VERSION: VERSION,
    VALID_DAYS: VALID_DAYS,
    MIN_SECRET_LENGTH: MIN_SECRET_LENGTH,
    FORM_BASE_URL: FORM_BASE_URL,
    isUsableSecret: isUsableSecret,
    bytesToHex: bytesToHex,
    constantTimeEqual: constantTimeEqual,
    toFeedbackBrand: toFeedbackBrand,
    expiresAtForEnd: expiresAtForEnd,
    tokenIdFor: tokenIdFor,
    issue: issue,
    check: check,
    verifiedTokenId: verifiedTokenId,
    formUrl: formUrl
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FeedbackTokenCore;
