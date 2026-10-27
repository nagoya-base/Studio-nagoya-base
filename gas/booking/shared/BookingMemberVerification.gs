/*
 * BookingMemberVerification.gs — V2直接予約（SNB / SNB mens。2026/12/1 0:00 JST以降に作成）の会員確認（Issue #548）。
 *
 * 目的: 予約メールアドレスだけで会員料金・会員限定特典・31〜90日先行予約を開放すると、表示差そのものが第三者による
 * 会員性の確認手段になり、他人の会員メールアドレスを入力するだけで会員料金を使えてしまう。そのためV2では
 * 「メール所有確認（6桁OTP）が済んだ予約フロー」にだけ会員機能を開放する。
 *
 * 構成:
 * - requestCode: 有効な形式のメールアドレスなら、**会員台帳を一切参照せず**会員・非会員とも同じ処理・同じ応答で
 *   6桁OTPをメール送信する（会員の有無を送信有無・応答に出さない）。OTPは平文保存せずHMACのみ保存、有効期限60分。
 * - verifyCode: OTPを検証する。誤入力は試行回数を数え、上限で当該OTPを失効させる。成功したOTPは再利用不可。
 *   成功時だけ、メールアドレス・用途（booking_membership）に拘束された確認済み証明（60分）を発行して返す。
 * - checkProof: 会員で結果が変わる処理（先行予約・会員料金・ペアパック・シャワー等・createBooking）が必ず通す検証。
 *   クライアントのverified/isMember等は一切信用せず、サーバー台帳の証明だけを根拠にする。
 *   証明は「このメールのメール所有確認が済んだ」ことだけを示す。会員資格・料金・利用日資格は証明に固定しない
 *   （毎回 MembershipRules.verifyActualMembership / verifyAdvanceBookingMembership で再判定する）。
 *
 * 会員状態ページ（/membership/status/。MembershipService.requestStatusLink / verifyStatusLink）とは別シート・別HMAC鍵・
 * 別purposeで、相互に通用しない。OTP・証明・メール本文・メールアドレスはLogger等へ出さない。
 */
'use strict';

var BookingMemberVerification = (function () {
  var PURPOSE = 'booking_membership';
  var OTP_TTL_MS_ = 60 * 60 * 1000;
  var PROOF_TTL_MS_ = 60 * 60 * 1000;
  var OTP_KEY_ = 'snb-booking-member-otp-v1';
  var PROOF_KEY_ = 'snb-booking-member-proof-v1';
  var EMAIL_KEY_ = 'snb-booking-member-email-v1';
  var MAX_ATTEMPTS_ = 5;
  /* 本来のメール（予約確定・運営通知等）に残す1日の送信枠。残りがこれを下回ったら確認コードは送らない。 */
  var MAIL_QUOTA_RESERVE_ = 50;
  var LOCK_TIMEOUT_MS_ = 10000;
  var RESEND_LIMIT_ = { windowMinutes: 1, maxCount: 1 };
  var PER_EMAIL_LIMIT_ = { windowMinutes: 60, maxCount: 5 };
  var GLOBAL_LIMIT_ = { windowMinutes: 60, maxCount: 40 };
  var VERIFY_PER_EMAIL_LIMIT_ = { windowMinutes: 10, maxCount: 10 };
  var VERIFY_GLOBAL_LIMIT_ = { windowMinutes: 1, maxCount: 60 };
  var PROOF_LOOKUP_LIMIT_ = { windowMinutes: 1, maxCount: 120 };
  var MAIL_SUBJECT_ = '【Studio Nagoya Base】予約フォームの会員確認コード';
  var ACCEPTED_MESSAGE_ = '入力されたメールアドレス宛に、6桁の確認コードをお送りしました（60分間有効）。メールをご確認ください（届かない場合は迷惑メールフォルダもご確認ください）。';
  var INVALID_CODE_MESSAGE_ = '確認コードが正しくないか、有効期限が切れています。お手数ですが、確認コードを再送してもう一度お試しください。';
  var PROOF_PATTERN_ = /^[A-Za-z0-9]{32,128}$/;

  function fail_(code, message) {
    return { success: false, error: { code: code, message: message } };
  }

  function isDateLike_(value) {
    return !!value && typeof value.getTime === 'function' && !isNaN(value.getTime());
  }

  function toHex_(bytes) {
    return bytes.map(function (b) { var v = (b < 0 ? b + 256 : b).toString(16); return v.length < 2 ? '0' + v : v; }).join('');
  }

  function hmac_(value, key) {
    return toHex_(Utilities.computeHmacSha256Signature(String(value), key, Utilities.Charset.UTF_8));
  }

  /* OTPはメールアドレス・用途に拘束してHMACする（他メール・他用途のOTPハッシュと一致しない）。 */
  function hashOtp_(email, code) {
    return hmac_(PURPOSE + '\n' + email + '\n' + code, OTP_KEY_);
  }

  function hashProof_(token) {
    return hmac_(PURPOSE + '\n' + token, PROOF_KEY_);
  }

  /* レート制限のキー用。メールアドレスそのものをキャッシュキーに入れない。 */
  function emailKey_(email) {
    return hmac_(email, EMAIL_KEY_).substring(0, 32);
  }

  function randomHex_() {
    return Utilities.getUuid().replace(/[^0-9a-fA-F]/g, '');
  }

  /* 6桁（先頭0あり）。Utilities.getUuid()由来の48bitを1,000,000で剰余（偏りは無視できる範囲）。 */
  function generateOtp_() {
    var hex = (randomHex_() + randomHex_()).substring(0, 12);
    var digits = String(parseInt(hex, 16) % 1000000);
    while (digits.length < 6) digits = '0' + digits;
    return digits;
  }

  function generateProofToken_() {
    return (Utilities.getUuid() + Utilities.getUuid()).replace(/[^A-Za-z0-9]/g, '');
  }

  function safeEquals_(a, b) {
    var left = String(a);
    var right = String(b);
    if (left.length !== right.length) return false;
    var diff = 0;
    for (var i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    return diff === 0;
  }

  /* Studio X（Issue #563）の確認コードメール。「SNB MEMBER」を出さず、会員限定のオプション・先行予約として案内する。 */
  var STUDIO_X_MAIL_SUBJECT_ = '【Studio X】予約フォームの会員確認コード';
  var STUDIO_X_MAIL_LEAD_ = '予約フォームで、会員限定のオプション・先行予約（31〜90日先）を利用するための確認コードです（60分間有効）。';
  var SNB_MAIL_LEAD_ = '予約フォームで、SNB MEMBERの会員料金・会員特典・先行予約を利用するための確認コードです（60分間有効）。';

  function sendCodeMail_(email, code, brand) {
    var mailConfig = BookingConfig.getMailConfig();
    var studioX = brand === 'studio_x';
    var message = {
      to: email,
      subject: studioX ? STUDIO_X_MAIL_SUBJECT_ : MAIL_SUBJECT_,
      body: (studioX ? STUDIO_X_MAIL_LEAD_ : SNB_MAIL_LEAD_) + '\n\n' +
        '確認コード：' + code + '\n\n' +
        '・予約フォームの確認コード入力欄に、この6桁の数字を入力してください。他の方には教えないでください。\n' +
        '・心当たりがない場合は、このメールを破棄してください。'
    };
    if (mailConfig.displayName) message.name = mailConfig.displayName;
    if (mailConfig.replyTo) message.replyTo = mailConfig.replyTo;
    MailApp.sendEmail(message);
  }

  function mailQuotaAllows_() {
    try {
      return MailApp.getRemainingDailyQuota() > MAIL_QUOTA_RESERVE_;
    } catch (quotaError) {
      return false;
    }
  }

  function unavailable_() {
    return fail_('VERIFICATION_UNAVAILABLE', '現在、確認コードを送信できません。しばらくしてから再度お試しください。');
  }

  /*
   * 確認コードの送信。input: { email }。会員台帳は参照しない（会員・非会員で同一の処理・同一の応答）。
   * 戻り値: { success:true, message, ttlMinutes } | { success:false, error }。
   */
  function requestCode(input, now) {
    now = isDateLike_(now) ? now : new Date();
    var email = MembershipRules.normalizeEmail(input && input.email);
    if (!MembershipRules.isValidEmail(email)) {
      return fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    }
    var brand = input && input.brand === 'studio_x' ? 'studio_x' : '';
    var key = emailKey_(email);
    var allowed = RateLimiter.limitByKey('bmv_resend_' + key, RESEND_LIMIT_.windowMinutes, RESEND_LIMIT_.maxCount, now.getTime()) &&
      RateLimiter.limitByKey('bmv_email_' + key, PER_EMAIL_LIMIT_.windowMinutes, PER_EMAIL_LIMIT_.maxCount, now.getTime()) &&
      RateLimiter.limitByKey('bmv_all', GLOBAL_LIMIT_.windowMinutes, GLOBAL_LIMIT_.maxCount, now.getTime());
    if (!allowed) {
      return fail_('RATE_LIMITED', '確認コードの送信回数が多すぎます。しばらく時間を置いてから再度お試しください。');
    }
    if (!mailQuotaAllows_()) return unavailable_();

    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return fail_('LOCK_TIMEOUT', '一時的に混み合っています。しばらくしてから再度お試しください。');
    }
    try {
      var code = generateOtp_();
      MemberRepository.addBookingVerification({
        kind: 'otp', secretHash: hashOtp_(email, code), email: email, purpose: PURPOSE,
        expiresAt: new Date(now.getTime() + OTP_TTL_MS_)
      }, now);
      sendCodeMail_(email, code, brand);
    } catch (error) {
      Logger.log('BookingMemberVerification: 確認コードを送信できませんでした');
      return unavailable_();
    } finally {
      lock.releaseLock();
    }
    return { success: true, message: ACCEPTED_MESSAGE_, ttlMinutes: OTP_TTL_MS_ / 60000 };
  }

  /*
   * 確認コードの検証。input: { email, code }。成功時のみ確認済み証明を返す。
   * 戻り値: { success:true, proof, expiresInMinutes, advanceEligible } | { success:false, error }。
   * advanceEligibleは「今日（JST）がactual membership有効期間内か」＝90日先まで選べるか。確認コードを入力できた本人にだけ返す。
   */
  function verifyCode(input, now) {
    now = isDateLike_(now) ? now : new Date();
    var email = MembershipRules.normalizeEmail(input && input.email);
    var code = input && typeof input.code === 'string' ? input.code.trim() : '';
    var invalid = fail_('INVALID_CODE', INVALID_CODE_MESSAGE_);
    if (!MembershipRules.isValidEmail(email) || !/^\d{6}$/.test(code)) return invalid;
    var key = emailKey_(email);
    if (!RateLimiter.limitByKey('bmv_verify_all', VERIFY_GLOBAL_LIMIT_.windowMinutes, VERIFY_GLOBAL_LIMIT_.maxCount, now.getTime()) ||
        !RateLimiter.limitByKey('bmv_verify_' + key, VERIFY_PER_EMAIL_LIMIT_.windowMinutes, VERIFY_PER_EMAIL_LIMIT_.maxCount, now.getTime())) {
      return fail_('RATE_LIMITED', '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。');
    }
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(LOCK_TIMEOUT_MS_)) {
      return fail_('LOCK_TIMEOUT', '一時的に混み合っています。しばらくしてから再度お試しください。');
    }
    var proof;
    try {
      var row = MemberRepository.findLatestBookingOtp(email, PURPOSE, now);
      if (!row || row.used || row.expired || row.attempts >= MAX_ATTEMPTS_) return invalid;
      if (!safeEquals_(row.secretHash, hashOtp_(email, code))) {
        MemberRepository.setBookingVerificationAttempts(row.rowNumber, row.attempts + 1);
        return invalid;
      }
      MemberRepository.markBookingVerificationUsed(row.rowNumber, now);
      proof = generateProofToken_();
      MemberRepository.addBookingVerification({
        kind: 'proof', secretHash: hashProof_(proof), email: email, purpose: PURPOSE,
        expiresAt: new Date(now.getTime() + PROOF_TTL_MS_)
      }, now);
    } catch (error) {
      Logger.log('BookingMemberVerification: 確認コードを検証できませんでした');
      return unavailable_();
    } finally {
      lock.releaseLock();
    }
    return { success: true, proof: proof, expiresInMinutes: PROOF_TTL_MS_ / 60000, advanceEligible: advanceEligible_(email, now) };
  }

  /* 今日（JST）のactual membershipで先行予約資格を判定する（既存 verifyAdvanceBookingMembership が正本。台帳エラーはfalse）。 */
  function advanceEligible_(email, now) {
    var today = MembershipRules.jstDateStringOfEpochSeconds(Math.floor(now.getTime() / 1000));
    try {
      return MembershipRules.verifyAdvanceBookingMembership(email, today).ok === true;
    } catch (error) {
      return false;
    }
  }

  /*
   * 確認済み証明の検証。email: 予約メールアドレス、proof: クライアントが保持する証明トークン。
   * 戻り値: { ok:true } | { ok:false, reason:'MISSING'|'INVALID'|'EXPIRED' }。
   * - MISSING: 証明なし（未確認）。INVALID: 形式不正・未登録・メール不一致・用途不一致・台帳エラー（fail-closed）。EXPIRED: 期限切れ。
   * 失敗理由は呼び出し側が「確認が必要」「再確認が必要」の案内に使うだけで、会員か否かは含まない。
   */
  function checkProof(email, proof, now) {
    now = isDateLike_(now) ? now : new Date();
    if (typeof proof !== 'string' || proof === '') return { ok: false, reason: 'MISSING' };
    var normalized = MembershipRules.normalizeEmail(email);
    if (!normalized || !PROOF_PATTERN_.test(proof)) return { ok: false, reason: 'INVALID' };
    try {
      var row = MemberRepository.findBookingProof(hashProof_(proof), now);
      if (!row || row.purpose !== PURPOSE || row.email !== normalized) return { ok: false, reason: 'INVALID' };
      if (row.expired) return { ok: false, reason: 'EXPIRED' };
      return { ok: true };
    } catch (error) {
      Logger.log('BookingMemberVerification: 確認済み証明を検証できませんでした');
      return { ok: false, reason: 'INVALID' };
    }
  }

  /* checkProofの失敗を外部向けエラーへ。MISSINGは「確認が必要」、それ以外は「再確認が必要」。 */
  function proofError(reason, brand) {
    if (reason === 'MISSING') {
      return { code: MembershipRules.BOOKING_VERIFICATION_REQUIRED_CODE, message: MembershipRules.bookingVerificationRequiredMessage(brand) };
    }
    return { code: MembershipRules.BOOKING_REVERIFY_REQUIRED_CODE, message: MembershipRules.bookingReverifyRequiredMessage(brand) };
  }

  /*
   * 会員結果の再取得（V2。確認済み証明が有効な場合だけ会員情報を返す）。input: { email, proof, date? }。
   * 戻り値: { success:true, verified:true, advanceEligible, memberOnDate? } | { success:false, error }。
   * advanceEligible＝今日（JST）の会員資格（先行予約）、memberOnDate＝利用日の会員資格（会員料金・特典）。
   * 証明なし・期限切れ・メール不一致・改ざん時は会員情報を一切返さない。
   */
  function memberStatus(input, now) {
    now = isDateLike_(now) ? now : new Date();
    var brand = input && input.brand;
    var email = MembershipRules.normalizeEmail(input && input.email);
    if (!MembershipRules.isValidEmail(email)) return fail_('INVALID_EMAIL', 'メールアドレスの形式が正しくありません。');
    if (!RateLimiter.limitByKey('bmv_status_all', PROOF_LOOKUP_LIMIT_.windowMinutes, PROOF_LOOKUP_LIMIT_.maxCount, now.getTime())) {
      return fail_('RATE_LIMITED', '操作回数が多すぎます。しばらく時間を置いてから再度お試しください。');
    }
    var checked = checkProof(email, input && input.proof, now);
    if (!checked.ok) {
      var error = proofError(checked.reason, brand);
      return fail_(error.code, error.message);
    }
    var result = { success: true, verified: true, advanceEligible: advanceEligible_(email, now) };
    var date = input && input.date;
    if (MembershipRules.isDateString(date)) {
      result.memberOnDate = MembershipRules.verifyActualMembership(email, date).ok === true;
    }
    return result;
  }

  return {
    PURPOSE: PURPOSE,
    OTP_TTL_MS: OTP_TTL_MS_,
    PROOF_TTL_MS: PROOF_TTL_MS_,
    MAX_ATTEMPTS: MAX_ATTEMPTS_,
    MAIL_QUOTA_RESERVE: MAIL_QUOTA_RESERVE_,
    requestCode: requestCode,
    verifyCode: verifyCode,
    checkProof: checkProof,
    proofError: proofError,
    memberStatus: memberStatus
  };
})();
