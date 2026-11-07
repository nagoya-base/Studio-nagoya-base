'use strict';
/* Issue #804 PR-A: 想定アカウント確認がメール・token等を出力せず、fail closedになることをモックで検証する（実Google API・本番Secret不使用）。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { confirmAccount, RESULTS } = require('../scripts/confirm-booking-production-account');

const workspace = path.resolve(__dirname, '..');
const script = path.join(workspace, 'scripts/confirm-booking-production-account.js');
const workflow = fs.readFileSync(path.join(workspace, '.github/workflows/confirm-booking-production-account.yml'), 'utf8');
const EXPECTED = 'owner-dummy@example.test';
const SENSITIVE = ['owner-dummy@example.test', 'other-dummy@example.test', 'refresh-dummy', 'client-id-dummy', 'client-secret-dummy', 'access-dummy'];
const clasprc = (token = {}) => JSON.stringify({ tokens: { default: { refresh_token: 'refresh-dummy', client_id: 'client-id-dummy', client_secret: 'client-secret-dummy', ...token } } });
const baseEnv = () => ({ CLASPRC_JSON: clasprc(), BOOKING_EXPECTED_GOOGLE_ACCOUNT: EXPECTED });
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function mockFetch({ refresh = json(200, { access_token: 'access-dummy' }), userinfo = json(200, { email: EXPECTED, email_verified: true }) } = {}) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = url.includes('oauth2.googleapis.com') ? refresh : userinfo;
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}

test('matching account succeeds with a fixed code; case/whitespace differences in the reference are tolerated', async () => {
  assert.equal(await confirmAccount(baseEnv(), mockFetch()), 'ACCOUNT_MATCH');
  assert.equal(await confirmAccount({ ...baseEnv(), BOOKING_EXPECTED_GOOGLE_ACCOUNT: ' OWNER-dummy@Example.test ' }, mockFetch()), 'ACCOUNT_MATCH');
});

test('a different account is NOT treated as success (login alone is not enough)', async () => {
  const f = mockFetch({ userinfo: json(200, { email: 'other-dummy@example.test', email_verified: true }) });
  assert.equal(await confirmAccount(baseEnv(), f), 'ACCOUNT_MISMATCH');
  assert.equal(RESULTS.ACCOUNT_MISMATCH[0], 1);
});

test('fails closed when the reference account or credential is unregistered/malformed, without any network call', async () => {
  const cases = [
    [{ CLASPRC_JSON: '' }, 'CLASPRC_NOT_CONFIGURED'],
    [{ BOOKING_EXPECTED_GOOGLE_ACCOUNT: '' }, 'EXPECTED_ACCOUNT_NOT_CONFIGURED'],
    [{ BOOKING_EXPECTED_GOOGLE_ACCOUNT: 'not-an-email' }, 'EXPECTED_ACCOUNT_NOT_CONFIGURED'],
    [{ CLASPRC_JSON: '{broken refresh-dummy' }, 'CREDENTIAL_INVALID'],
    [{ CLASPRC_JSON: 'null' }, 'CREDENTIAL_INVALID'],
    [{ CLASPRC_JSON: '[]' }, 'CREDENTIAL_INVALID'],
    [{ CLASPRC_JSON: JSON.stringify({ tokens: { 'booking-owner': { refresh_token: 'refresh-dummy', client_id: 'client-id-dummy', client_secret: 'client-secret-dummy' } } }) }, 'CREDENTIAL_INVALID'],
    [{ CLASPRC_JSON: clasprc({ refresh_token: '' }) }, 'CREDENTIAL_INVALID']
  ];
  for (const [override, code] of cases) {
    const f = mockFetch();
    assert.equal(await confirmAccount({ ...baseEnv(), ...override }, f), code);
    assert.deepEqual(f.calls, []);
  }
});

test('token refresh failure, API 401/403/other failures, missing email and thrown errors all fail closed with fixed codes', async () => {
  const cases = [
    [{ refresh: json(400, { error: 'invalid_grant' }) }, 'AUTHENTICATION_FAILED'],
    [{ refresh: json(200, {}) }, 'AUTHENTICATION_FAILED'],
    [{ userinfo: json(401, {}) }, 'AUTHENTICATION_FAILED'],
    [{ userinfo: json(403, {}) }, 'SCOPE_INSUFFICIENT'],
    [{ userinfo: json(500, {}) }, 'LOOKUP_FAILED'],
    [{ userinfo: json(200, { sub: '1234' }) }, 'SCOPE_INSUFFICIENT'],
    [{ userinfo: json(200, { email: EXPECTED, email_verified: false }) }, 'SCOPE_INSUFFICIENT'],
    [{ refresh: new Error('boom owner-dummy@example.test access-dummy') }, 'UNEXPECTED_ERROR'],
    [{ userinfo: new Error('boom client-secret-dummy') }, 'UNEXPECTED_ERROR']
  ];
  for (const [opts, code] of cases) assert.equal(await confirmAccount(baseEnv(), mockFetch(opts)), code, code);
});

test('CLI output never contains the email, identifiers, tokens or OAuth data, and exit codes are fail-closed', () => {
  const run = (env, preload) => spawnSync('node', ['-r', preload, script], { env: { ...process.env, ...env }, encoding: 'utf8' });
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'confirm-account-'));
  try {
    const preload = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
    const respond = (refreshBody, userinfoBody, userStatus = 200) => preload(`f-${Math.random()}.js`, `
      global.fetch = async (url) => url.includes('oauth2.googleapis.com')
        ? { ok: true, status: 200, json: async () => (${refreshBody}) }
        : { ok: ${userStatus} < 300, status: ${userStatus}, json: async () => (${userinfoBody}) };`);
    const scenarios = [
      [respond(`{access_token:'access-dummy'}`, `{email:'owner-dummy@example.test',email_verified:true}`), 0, 'ACCOUNT_MATCH'],
      [respond(`{access_token:'access-dummy'}`, `{email:'other-dummy@example.test',email_verified:true}`), 1, 'ACCOUNT_MISMATCH'],
      [respond(`{access_token:'access-dummy'}`, `{}`, 403), 1, 'SCOPE_INSUFFICIENT'],
      [preload('throw.js', `global.fetch = async () => { throw new Error('owner-dummy@example.test access-dummy'); };`), 1, 'UNEXPECTED_ERROR']
    ];
    for (const [pre, status, code] of scenarios) {
      const r = spawnSync('node', ['-r', pre, script], { env: { ...process.env, ...baseEnv() }, encoding: 'utf8' });
      assert.equal(r.status, status, r.stderr);
      assert.match(r.stdout + r.stderr, new RegExp('^Account confirmation: ' + code + ' - '));
      for (const secret of SENSITIVE) assert.equal((r.stdout + r.stderr).includes(secret), false, secret);
    }
    const missing = run({ CLASPRC_JSON: '' }, preload('noop.js', ''));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /CLASPRC_NOT_CONFIGURED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('workflow stays manual, approved via booking-production, least-privilege, and never prints identity data', () => {
  assert.match(workflow, /on:\n  workflow_dispatch:\n/);
  assert.doesNotMatch(workflow, /push:|pull_request|schedule:/);
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.match(workflow, /\n    environment: booking-production\n/);
  assert.equal((workflow.match(/^\s*environment:/gm) || []).length, 1);
  assert.doesNotMatch(workflow, /console\.log|echo |GITHUB_STEP_SUMMARY|upload-artifact|actions\/cache|profile\.email/);
  assert.match(workflow, /run: node scripts\/confirm-booking-production-account\.js\n/);
  const source = fs.readFileSync(script, 'utf8');
  assert.doesNotMatch(source, /console\./);
  assert.equal((source.match(/process\.(stdout|stderr)\.write|\.write\(/g) || []).length, 1, 'a single fixed-message output point');
  assert.doesNotMatch(source + workflow, /scope=|oauth2\/v2|auth\/userinfo\.email|scopes?:/i, 'no new OAuth scope is requested');
  // The expected account is read from a private Environment secret, never hard-coded.
  assert.match(workflow, /BOOKING_EXPECTED_GOOGLE_ACCOUNT: \$\{\{ secrets\.BOOKING_EXPECTED_GOOGLE_ACCOUNT \}\}/);
});

test('existing clasp credential shapes keep working: client id/secret in tokens.default, oauth2ClientSettings or the root (Issue #804 review)', async () => {
  const rt = { refresh_token: 'refresh-dummy' };
  const both = { client_id: 'client-id-dummy', client_secret: 'client-secret-dummy' };
  const shapes = {
    'inside token': { tokens: { default: { ...rt, ...both } } },
    'oauth2ClientSettings': { tokens: { default: rt }, oauth2ClientSettings: { clientId: 'client-id-dummy', clientSecret: 'client-secret-dummy' } },
    'root fields': { tokens: { default: rt }, ...both },
    'mixed (id in token, secret in settings)': { tokens: { default: { ...rt, client_id: 'client-id-dummy' } }, oauth2ClientSettings: { clientSecret: 'client-secret-dummy' } }
  };
  for (const [name, auth] of Object.entries(shapes)) {
    const f = mockFetch();
    assert.equal(await confirmAccount({ ...baseEnv(), CLASPRC_JSON: JSON.stringify(auth) }, f), 'ACCOUNT_MATCH', name);
    assert.equal(f.calls.length, 2, name);
    // a wrong account is still never a success, whichever shape was used
    const wrong = mockFetch({ userinfo: json(200, { email: 'other-dummy@example.test', email_verified: true }) });
    assert.equal(await confirmAccount({ ...baseEnv(), CLASPRC_JSON: JSON.stringify(auth) }, wrong), 'ACCOUNT_MISMATCH', name);
  }
});

test('missing client id/secret or refresh token still fails closed; other users tokens are never used as a fallback', async () => {
  const bad = [
    { tokens: { default: { refresh_token: 'refresh-dummy' } } },
    { tokens: { default: { refresh_token: 'refresh-dummy', client_id: 'client-id-dummy' } }, oauth2ClientSettings: {} },
    { tokens: { default: { refresh_token: 'refresh-dummy' } }, oauth2ClientSettings: { clientId: 1, clientSecret: null } },
    { tokens: { default: {}, 'booking-owner': { refresh_token: 'refresh-dummy', client_id: 'client-id-dummy', client_secret: 'client-secret-dummy' } } },
    { token: { refresh_token: 'refresh-dummy', client_id: 'client-id-dummy', client_secret: 'client-secret-dummy' } },
    { refresh_token: 'refresh-dummy', client_id: 'client-id-dummy', client_secret: 'client-secret-dummy' }
  ];
  for (const auth of bad) {
    const f = mockFetch();
    assert.equal(await confirmAccount({ ...baseEnv(), CLASPRC_JSON: JSON.stringify(auth) }, f), 'CREDENTIAL_INVALID');
    assert.deepEqual(f.calls, []);
  }
});
