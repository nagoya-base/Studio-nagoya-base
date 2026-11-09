/*
 * 利用後アンケートの回答リンク（署名トークン。scripts/feedback-token-core.js。Issue #834）の単体テスト。
 * 推測困難・改ざん検知・ブランド一致・14日期限・1予約1トークン・URLの形。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var crypto = require('crypto');
var Core = require('../scripts/feedback-token-core.js');
var FeedbackCore = require('../scripts/feedback-core.js');

var SECRET = 'test-secret-0123456789abcdefghijklmnopqrstuvwxyz';
var OTHER_SECRET = 'other-secret-0123456789abcdefghijklmnopqrstuvwxyz';
function hmacHex(key, message) { return crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex'); }

var END = Date.parse('2026-12-01T15:00:00+09:00');
var EXPIRES = Core.expiresAtForEnd(END);

function issue(bookingId, brand, secret) {
  return Core.issue({ secret: secret || SECRET, bookingId: bookingId, brand: brand, expiresAtMs: EXPIRES }, hmacHex);
}

test('発行: 英小文字・数字の66文字で、フォームのトークン形式に収まる。期限は利用終了＋14日', function () {
  var issued = issue('SX-20261201-0001', 'studio-x');
  assert.match(issued.token, /^f1x[0-9a-z]{7}[0-9a-f]{56}$/);
  assert.strictEqual(issued.token.length, 66);
  assert.ok(FeedbackCore.isValidTokenFormat(issued.token));
  assert.strictEqual(issued.expiresAtMs, END + 14 * 24 * 3600 * 1000);
  assert.ok(issued.token.indexOf('SX-20261201') === -1, '予約IDをトークンに含めない');
});

test('同じ予約からは同じトークン（1予約1回答）。別の予約・別の鍵では別の tokenId', function () {
  var a = issue('SNB-1', 'snb');
  assert.strictEqual(issue('SNB-1', 'snb').token, a.token);
  assert.notStrictEqual(issue('SNB-2', 'snb').tokenId, a.tokenId);
  assert.notStrictEqual(issue('SNB-1', 'snb', OTHER_SECRET).tokenId, a.tokenId);
});

test('検証: 有効なトークンは ok と tokenId・期限を返す', function () {
  var issued = issue('M-1', 'mens');
  var checked = Core.check(issued.token, 'mens', END + 2 * 3600 * 1000, SECRET, hmacHex);
  assert.deepStrictEqual(checked, { ok: true, brand: 'mens', tokenId: issued.tokenId, expiresAtMs: issued.expiresAtMs });
});

test('検証: 改ざん（ブランド・期限・ID・署名の1文字）と別の鍵は TOKEN_INVALID', function () {
  var token = issue('SNB-9', 'snb').token;
  function flip(t, i) { var c = t[i] === '0' ? '1' : '0'; return t.slice(0, i) + c + t.slice(i + 1); }
  [3, 9, 10, 33, 34, 65].forEach(function (i) {
    assert.strictEqual(Core.check(flip(token, i), 'snb', END, SECRET, hmacHex).code, 'TOKEN_INVALID', 'index ' + i);
  });
  /* ブランド文字を書き換えても署名で弾く（ブランド不一致より先に改ざんとして扱う） */
  assert.strictEqual(Core.check('f1m' + token.slice(3), 'mens', END, SECRET, hmacHex).code, 'TOKEN_INVALID');
  assert.strictEqual(Core.check(token, 'snb', END, OTHER_SECRET, hmacHex).code, 'TOKEN_INVALID');
  ['', 'tok_ABCDEFGHIJKLMNOP1234', token + '0', token.toUpperCase(), null, 123].forEach(function (bad) {
    assert.strictEqual(Core.check(bad, 'snb', END, SECRET, hmacHex).code, 'TOKEN_INVALID');
  });
});

test('検証: 別ブランドのフォームでは TOKEN_BRAND_MISMATCH', function () {
  var token = issue('SX-1', 'studio-x').token;
  assert.strictEqual(Core.check(token, 'snb', END, SECRET, hmacHex).code, 'TOKEN_BRAND_MISMATCH');
  assert.strictEqual(Core.check(token, 'mens', END, SECRET, hmacHex).code, 'TOKEN_BRAND_MISMATCH');
});

test('検証: 期限ちょうど以降は TOKEN_EXPIRED（1秒前までは有効）', function () {
  var issued = issue('SNB-3', 'snb');
  assert.strictEqual(Core.check(issued.token, 'snb', issued.expiresAtMs - 1000, SECRET, hmacHex).ok, true);
  assert.strictEqual(Core.check(issued.token, 'snb', issued.expiresAtMs, SECRET, hmacHex).code, 'TOKEN_EXPIRED');
});

test('秘密鍵が未設定・短い場合: 検証は TOKEN_NOT_CONNECTED、発行は例外（fail closed）', function () {
  var token = issue('SNB-4', 'snb').token;
  ['', 'short', null, undefined].forEach(function (secret) {
    assert.strictEqual(Core.check(token, 'snb', END, secret, hmacHex).code, 'TOKEN_NOT_CONNECTED');
    assert.throws(function () { Core.issue({ secret: secret, bookingId: 'SNB-4', brand: 'snb', expiresAtMs: EXPIRES }, hmacHex); });
  });
  assert.strictEqual(Core.verifiedTokenId(token, '', hmacHex), null);
});

test('URL: ブランド別フォームの #t= 以降にだけ置く（クエリに載せない・旧 /survey/ へ送らない）', function () {
  var token = issue('SNB-5', 'snb').token;
  assert.strictEqual(Core.formUrl('snb', token), 'https://nagoya-base.github.io/Studio-nagoya-base/feedback/snb/#t=' + token);
  assert.strictEqual(Core.formUrl('mens', token), 'https://nagoya-base.github.io/Studio-nagoya-base/feedback/mens/#t=' + token);
  assert.strictEqual(Core.formUrl('studio-x', token), 'https://nagoya-base.github.io/Studio-nagoya-base/feedback/studio-x/#t=' + token);
  ['snb', 'mens', 'studio-x'].forEach(function (brand) {
    var url = Core.formUrl(brand, token);
    assert.ok(url.indexOf('?') === -1 && url.indexOf('/survey/') === -1);
    var parsed = FeedbackCore.parseLocation(new URL(url).pathname, new URL(url).search, new URL(url).hash);
    assert.deepStrictEqual(parsed, { brand: brand, isTest: false, token: token }, 'フォームがURLからブランドとトークンを読める');
  });
  assert.throws(function () { Core.formUrl('studio_x', token); });
});

test('Booking台帳のブランドID → フォームのブランドID', function () {
  assert.strictEqual(Core.toFeedbackBrand('snb'), 'snb');
  assert.strictEqual(Core.toFeedbackBrand('mens'), 'mens');
  assert.strictEqual(Core.toFeedbackBrand('studio_x'), 'studio-x');
  assert.strictEqual(Core.toFeedbackBrand('studio-x'), null);
  assert.strictEqual(Core.toFeedbackBrand(''), null);
  assert.strictEqual(Core.toFeedbackBrand('toString'), null);
});

test('GASの byte[]（符号付き）も16進へ正しく変換する', function () {
  assert.strictEqual(Core.bytesToHex([0, 15, 16, 127, -128, -1]), '000f107f80ff');
});
