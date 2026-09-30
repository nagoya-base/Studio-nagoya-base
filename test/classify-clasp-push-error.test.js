'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { classify } = require('../scripts/classify-clasp-push-error');

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
