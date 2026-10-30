'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { classify, report } = require('../scripts/classify-clasp-list-error');
const workspace = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(workspace, '.github/workflows/booking-gas-production.yml'), 'utf8');
// Issue #671: the clasp deploy shell lives in this script (run once per target by the workflow).
const deployScript = fs.readFileSync(path.join(workspace, 'scripts/deploy-booking-gas-target.sh'), 'utf8');
const sensitive = 'tiny-secret script-id deployment-id access-token refresh-token owner@example.test';

test('list failures return only fixed categories, even with short unknown credentials', () => {
  for (const [raw, expected] of [
    ['invalid_grant', 'AUTHENTICATION_FAILED'],
    ['Token has been expired or revoked.', 'AUTHENTICATION_FAILED'],
    ['Please log in.', 'AUTHENTICATION_FAILED'],
    ['The caller does not have permission', 'ACCESS_DENIED'],
    ['Access denied', 'ACCESS_DENIED'],
    ['Requested entity was not found.', 'SCRIPT_NOT_FOUND_OR_INACCESSIBLE'],
    ['Invalid script ID', 'SCRIPT_NOT_FOUND_OR_INACCESSIBLE'],
    ['User default not found', 'CLASP_CREDENTIAL_OR_USER_MISMATCH'],
    ['No credentials found', 'CLASP_CREDENTIAL_OR_USER_MISMATCH'],
    ['Unexpected token in JSON', 'CLASP_CREDENTIAL_OR_USER_MISMATCH'],
    ['HTTP 503', 'TRANSIENT_API_OR_NETWORK_ERROR'],
    ['ENOTFOUND', 'TRANSIENT_API_OR_NETWORK_ERROR'],
    ['HTTP 429', 'TRANSIENT_API_OR_NETWORK_ERROR'],
    ['unfamiliar failure', 'UNCLASSIFIED'],
    ['', 'UNCLASSIFIED']
  ]) {
    assert.equal(classify(raw), expected);
    assert.equal(report(raw + '\n' + sensitive, 'after'), 'clasp list-deployments failed (after update): ' + expected);
  }
});

for (const phase of ['before', 'after']) {
  for (const target of ['admin', 'public']) {
    test(`workflow ${target} ${phase}: captures both streams, fails closed, never leaks output`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clasp-list-test-'));
      try {
        const start = deployScript.indexOf(`echo "Running clasp list-deployments (${phase} update)"`);
        assert.ok(start >= 0);
        const idCheck = phase === 'before' ? 'if ! grep' : 'if ! deployment_has_unique_id';
        const checkStart = deployScript.indexOf(idCheck, start);
        const closing = deployScript.slice(checkStart).match(/\n[ \t]*fi/);
        const end = checkStart + closing.index + closing[0].length;
        const helpers = deployScript.slice(deployScript.indexOf('deployment_has_unique_id()'), deployScript.indexOf('\nif [[ "$mode" == "schema-guard"'));
        const block = helpers + '\n' + deployScript.slice(start, end);
        fs.writeFileSync(path.join(dir, 'clasp'), '#!/bin/bash\nprintf "%s\\n" "$MOCK_STDOUT"\nprintf "%s\\n" "$MOCK_STDERR" >&2\nexit "$MOCK_STATUS"\n', { mode: 0o700 });
        const env = { ...process.env, PATH: dir + ':' + process.env.PATH, GITHUB_WORKSPACE: workspace,
          auth_file: 'test-auth', clasp_user: target === 'admin' ? 'default' : 'booking-owner',
          deployment_id: 'test-deployment', list_stdout: path.join(dir, 'stdout'), list_stderr: path.join(dir, 'stderr') };
        for (const stream of ['STDOUT', 'STDERR']) {
          const result = spawnSync('bash', ['-c', 'set -euo pipefail\n' + block + '\necho UNREACHABLE'], {
            cwd: dir, encoding: 'utf8', env: { ...env, MOCK_STATUS: '1', MOCK_STDOUT: sensitive, MOCK_STDERR: sensitive, ['MOCK_' + stream]: 'invalid_grant ' + sensitive }
          });
          assert.equal(result.status, 1);
          assert.equal(result.stderr, `clasp list-deployments failed (${phase} update): AUTHENTICATION_FAILED\n`);
          assert.doesNotMatch(result.stdout, /UNREACHABLE|tiny-secret|deployment-id/);
        }
        const success = spawnSync('bash', ['-c', 'set -euo pipefail\n' + block], {
          cwd: dir, encoding: 'utf8', env: { ...env, MOCK_STATUS: '0', MOCK_STDOUT: '- test-deployment @5 - ' + sensitive, MOCK_STDERR: sensitive }
        });
        assert.equal(success.status, 0);
        assert.equal(success.stderr, '');
        assert.equal(success.stdout.includes(sensitive), false);
        const missing = spawnSync('bash', ['-c', 'set -euo pipefail\n' + block], {
          cwd: dir, encoding: 'utf8', env: { ...env, MOCK_STATUS: '0', MOCK_STDOUT: sensitive, MOCK_STDERR: sensitive }
        });
        assert.equal(missing.status, 1);
        assert.equal(missing.stderr.includes(sensitive), false);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
}

test('unreadable logs and untrusted phase never appear in CLI diagnostics', () => {
  const result = spawnSync('node', [path.join(workspace, 'scripts/classify-clasp-list-error.js'), sensitive, sensitive, sensitive], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'clasp list-deployments failed (before update): UNCLASSIFIED\n');
});

test('workflow preserves main-only deployment and removes sensitive temporary files on exit', () => {
  assert.match(workflow, /if: github.ref == 'refs\/heads\/main'/);
  assert.match(deployScript, /trap 'rm -f "\$list_stdout" "\$list_stderr" "\$push_log" "\$auth_file"' EXIT/);
  assert.ok(deployScript.indexOf('umask 077') < deployScript.indexOf('const authJson'));
  assert.equal((deployScript.match(/trap /g) || []).length, 1);
  assert.doesNotMatch(deployScript, /deployments_(?:before|after)=/);
});

test('malformed credential JSON cannot expose parser snippets', () => {
  const setup = deployScript.match(/node <<'NODE'\n([\s\S]*?)\nNODE/)[1];
  for (const value of ['{"refresh_token":"tiny-secret",oops}', 'null', '[]']) {
    const result = spawnSync('node', ['-e', setup], {
      encoding: 'utf8', env: { ...process.env, SELECTED_CLASPRC_JSON: value }
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'clasp credential setup failed: CLASP_CREDENTIAL_OR_USER_MISMATCH\n');
  }
});
