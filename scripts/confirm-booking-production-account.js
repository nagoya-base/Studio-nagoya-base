#!/usr/bin/env node
'use strict';

/*
 * Issue #804 PR-A: booking-production の既定clasp資格情報（Booking Admin用 `default` user）が、
 * 想定したGoogleアカウントのものかを確認する。公開リポジトリのActionsログに個人情報を出さないため、
 * 実メールアドレス・アカウント識別子・token・client id/secret・OAuth応答・生エラーは一切出力しない。
 * 出力は固定コードと固定メッセージのみ。想定アカウントは非公開のEnvironment secret
 * `BOOKING_EXPECTED_GOOGLE_ACCOUNT` と比較する（「任意のアカウントでログインできた」を成功扱いしない）。
 * 新しいOAuth scopeは追加しない。メール取得に必要なscopeが無ければ SCOPE_INSUFFICIENT で停止する。
 */

const RESULTS = {
  ACCOUNT_MATCH: [0, 'The Google account of the default clasp credential matches the expected account.'],
  CLASPRC_NOT_CONFIGURED: [1, 'CLASPRC_JSON is not configured in the booking-production environment.'],
  EXPECTED_ACCOUNT_NOT_CONFIGURED: [1, 'BOOKING_EXPECTED_GOOGLE_ACCOUNT is not configured in the booking-production environment; the account cannot be confirmed.'],
  CREDENTIAL_INVALID: [1, 'The default clasp credential is malformed or lacks required OAuth fields.'],
  AUTHENTICATION_FAILED: [1, 'OAuth token refresh failed; the credential may be expired or revoked. Register it again.'],
  SCOPE_INSUFFICIENT: [1, 'The credential does not permit reading the account email; the account cannot be confirmed.'],
  LOOKUP_FAILED: [1, 'The Google account lookup failed.'],
  ACCOUNT_MISMATCH: [1, 'The Google account of the default clasp credential does NOT match the expected account.'],
  UNEXPECTED_ERROR: [1, 'The account confirmation could not be completed.']
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalize = (value) => String(value).trim().toLowerCase();

// 想定外の例外・応答でも、返すのは RESULTS のキーだけ（呼出し側は文言を選ぶだけ）。
async function confirmAccount(env, fetchImpl) {
  try {
    if (!env.CLASPRC_JSON) return 'CLASPRC_NOT_CONFIGURED';
    if (!env.BOOKING_EXPECTED_GOOGLE_ACCOUNT || !EMAIL.test(env.BOOKING_EXPECTED_GOOGLE_ACCOUNT.trim())) {
      return 'EXPECTED_ACCOUNT_NOT_CONFIGURED';
    }
    let auth;
    try { auth = JSON.parse(env.CLASPRC_JSON); } catch (_) { return 'CREDENTIAL_INVALID'; }
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return 'CREDENTIAL_INVALID';
    // clasp 3.x は tokens.<user>。Adminは `default` userのみを対象にし、他userへは広げない。
    const token = auth.tokens && auth.tokens.default;
    if (!token || typeof token !== 'object') return 'CREDENTIAL_INVALID';
    const { refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret } = token;
    if (!refreshToken || !clientId || !clientSecret) return 'CREDENTIAL_INVALID';

    const refresh = await fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret
      })
    });
    if (!refresh.ok) return 'AUTHENTICATION_FAILED';
    const refreshed = await refresh.json();
    if (!refreshed || typeof refreshed.access_token !== 'string' || !refreshed.access_token) return 'AUTHENTICATION_FAILED';

    const response = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + refreshed.access_token }
    });
    if (response.status === 401) return 'AUTHENTICATION_FAILED';
    if (response.status === 403) return 'SCOPE_INSUFFICIENT';
    if (!response.ok) return 'LOOKUP_FAILED';
    const profile = await response.json();
    if (!profile || typeof profile.email !== 'string' || !EMAIL.test(profile.email) || profile.email_verified === false) {
      return 'SCOPE_INSUFFICIENT';
    }
    return normalize(profile.email) === normalize(env.BOOKING_EXPECTED_GOOGLE_ACCOUNT) ? 'ACCOUNT_MATCH' : 'ACCOUNT_MISMATCH';
  } catch (_) {
    return 'UNEXPECTED_ERROR';
  }
}

async function main() {
  const code = await confirmAccount(process.env, fetch);
  const [status, message] = RESULTS[code] || RESULTS.UNEXPECTED_ERROR;
  const line = 'Account confirmation: ' + code + ' - ' + message;
  (status === 0 ? process.stdout : process.stderr).write(line + '\n');
  process.exitCode = status;
}

if (require.main === module) main();

module.exports = { confirmAccount, RESULTS };
