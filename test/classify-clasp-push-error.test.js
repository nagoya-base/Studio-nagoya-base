'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classify, sanitize, extractDiagnostics, report } = require('../scripts/classify-clasp-push-error');

test('clasp push failures are classified without returning identifiers or raw errors', () => {
  const sensitive = ' account@example.test script-id-123 deployment-id-456 refresh-token-789';
  const cases = [
    ['Request had insufficient authentication scopes.', 'OAUTH_SCOPE_INSUFFICIENT'],
    ['Apps Script API has not been used in project or it is disabled.', 'APPS_SCRIPT_API_DISABLED'],
    ['The caller does not have permission.', 'WRITE_PERMISSION_OR_SCOPE_DENIED'],
    ['Invalid manifest: appsscript.json', 'MANIFEST_VALIDATION_FAILED'],
    ['Request contains an invalid argument.', 'PROJECT_CONTENT_VALIDATION_FAILED'],
    ['Quota exceeded', 'QUOTA_OR_RATE_LIMIT'],
    ['HTTP 503 service unavailable', 'TRANSIENT_API_OR_NETWORK_ERROR'],
    ['Unfamiliar error detail', 'UNCLASSIFIED']
  ];
  for (const [message, category] of cases) {
    const result = classify(message + sensitive);
    assert.equal(result, category);
    assert.doesNotMatch(result, /account|script-id|deployment-id|refresh-token/);
  }
});

test('workflow classifier runs outside the repository and prints only the fixed category', () => {
  const workspace = path.resolve(__dirname, '..');
  const workflow = fs.readFileSync(path.join(workspace, '.github/workflows/booking-gas-production.yml'), 'utf8');
  const command = workflow.split('\n').find(line => /^\s*node .*classify-clasp-push-error\.js/.test(line));
  assert.ok(command, 'Workflow must call the push error classifier');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-error-test-'));
  const log = path.join(dir, 'push.log');
  try {
    fs.writeFileSync(log, 'The caller does not have permission. account@example.test script-id-123 refresh-token-789');
    const result = spawnSync('bash', ['-c', command.trim()], {
      cwd: dir,
      env: { ...process.env, GITHUB_WORKSPACE: workspace, push_log: log },
      encoding: 'utf8'
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'clasp push --force failed: WRITE_PERMISSION_OR_SCOPE_DENIED\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SECRETS = [
  'owner@example.test',
  '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOpQrStUv',
  'AKfycbwExampleDeploymentId0123456789abcdefghijklmnop',
  'ya29.a0ExampleAccessToken_0123456789',
  '1//0gExampleRefreshToken-0123456789',
  '123456789012-abcdefghijklmnop.apps.googleusercontent.com',
  'GOCSPX-ExampleClientSecret0123',
  'https://script.googleapis.com/v1/projects/abc?key=zzz'
];

test('sanitize redacts emails, ids, OAuth tokens, client credentials and long identifiers', () => {
  for (const secret of SECRETS) {
    const out = sanitize('failure for ' + secret + ' end');
    assert.ok(out.includes('[REDACTED]'), out);
    assert.equal(out.includes(secret), false, out);
    for (const part of secret.split(/[\s@/?=]/).filter(p => p.length >= 12)) {
      assert.equal(out.includes(part), false, out);
    }
  }
  assert.equal(sanitize('Bearer abc.def'), '[REDACTED]');
  assert.equal(sanitize('project 123456789012 missing'), 'project [REDACTED] missing');
});

test('UNCLASSIFIED report shows only allowlisted, sanitized fields', () => {
  const raw = JSON.stringify({
    error: {
      code: 418,
      status: 'TEAPOT_ERROR',
      message: 'Odd failure for ' + SECRETS.join(' '),
      details: [{ reason: 'someReason', metadata: { user: SECRETS[0], token: SECRETS[3] } }]
    }
  }) + '\nstack: at ' + SECRETS[1];
  const out = report(raw);
  assert.match(out, /^clasp push --force failed: UNCLASSIFIED \(sanitized diagnostics: /);
  assert.match(out, /http_status=418/);
  assert.match(out, /code=TEAPOT_ERROR/);
  assert.match(out, /reason=someReason/);
  assert.match(out, /Odd failure/);
  assert.doesNotMatch(out, /stack:/);
  for (const secret of SECRETS) {
    assert.equal(out.includes(secret), false);
    for (const part of secret.split(/[\s@/?=]/).filter(p => p.length >= 8)) {
      assert.equal(out.includes(part), false, part);
    }
  }
  assert.ok(out.length < 400);
});

test('UNCLASSIFIED report without structured fields never echoes raw text', () => {
  const out = report('weird output ' + SECRETS.join(' '));
  assert.equal(out, 'clasp push --force failed: UNCLASSIFIED (sanitized diagnostics: no structured error fields found)');
  assert.deepEqual(extractDiagnostics(''), []);
});

test('classified failures do not include diagnostics', () => {
  assert.equal(report('The caller does not have permission. ' + SECRETS[0]), 'clasp push --force failed: WRITE_PERMISSION_OR_SCOPE_DENIED');
});

test('workflow CLI does not leak secrets for UNCLASSIFIED output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-error-test-'));
  const log = path.join(dir, 'push.log');
  try {
    fs.writeFileSync(log, '{"error":{"code":499,"message":"Odd ' + SECRETS.join(' ') + '"}}');
    const result = spawnSync('node', [path.resolve(__dirname, '../scripts/classify-clasp-push-error.js'), log], { encoding: 'utf8' });
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /UNCLASSIFIED/);
    for (const secret of SECRETS) assert.equal(result.stderr.includes(secret), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
