/*
 * V2予約の会員確認（Issue #548）のテスト用ヘルパー。実際の BookingMemberVerification.gs を通して
 * 確認コードを送信 → メール本文から6桁コードを取り出して検証 → 確認済み証明（memberProof）を得る。
 * 証明の偽造・直書きはせず、本番と同じ経路（OTPメール → verifyCode）だけで発行する。
 */
'use strict';

var assert = require('node:assert');

var CODE_PATTERN = /確認コード：(\d{6})/;
var MINUTE_MS = 60000;

/* sandbox: BookingMemberVerification.gs / RateLimiter.gs ほかを読み込んだvm。mailApp: createMailAppStubの戻り値。 */
function requestCode(sandbox, mailApp, email, now) {
  var before = mailApp._sentEmails.length;
  var result = JSON.parse(JSON.stringify(sandbox.BookingMemberVerification.requestCode({ email: email }, now)));
  var mail = mailApp._sentEmails.slice(before).filter(function (m) { return m.to === String(email).trim().toLowerCase(); })[0];
  var match = mail && CODE_PATTERN.exec(mail.body);
  return { result: result, code: match ? match[1] : '', mail: mail || null };
}

function verify(sandbox, email, code, now) {
  return JSON.parse(JSON.stringify(sandbox.BookingMemberVerification.verifyCode({ email: email, code: code }, now)));
}

/* 新しい確認済み証明を発行する（毎回、メール送信＋コード検証）。 */
function issueProof(sandbox, mailApp, email, now) {
  var requested = requestCode(sandbox, mailApp, email, now);
  assert.strictEqual(requested.result.success, true, '確認コードの送信に失敗: ' + JSON.stringify(requested.result));
  var verified = verify(sandbox, email, requested.code, now);
  assert.strictEqual(verified.success, true, '確認コードの検証に失敗: ' + JSON.stringify(verified));
  return verified.proof;
}

/*
 * メール単位で証明を使い回す（再送間隔・送信回数の制限に当たらないよう）。bookAtが発行時刻から50分を超えたら再発行する。
 * cache: テストごとに作るオブジェクト（{}）。
 */
function proofFor(cache, sandbox, mailApp, email, bookAt) {
  var key = String(email).trim().toLowerCase();
  var entry = cache[key];
  if (!entry || bookAt.getTime() - entry.issuedAt > 50 * MINUTE_MS) {
    entry = { proof: issueProof(sandbox, mailApp, email, bookAt), issuedAt: bookAt.getTime() };
    cache[key] = entry;
  }
  return entry.proof;
}

module.exports = { requestCode: requestCode, verify: verify, issueProof: issueProof, proofFor: proofFor };
