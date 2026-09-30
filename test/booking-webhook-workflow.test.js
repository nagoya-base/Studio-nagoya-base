'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { prepareProject } = require('../scripts/prepare-booking-gas-project');
const manifest = require('./helpers/booking-deployment-manifest');
const workspace = path.resolve(__dirname, '..');
const workflow = fs.readFileSync(path.join(workspace, '.github/workflows/booking-gas-webhook-production.yml'), 'utf8');

test('prepareProject preserves public/admin sets and isolates the webhook payload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-package-'));
  try {
    for (const [target, files] of [
      ['public', manifest.BOOKING_WEB_APP_FILES],
      ['admin', manifest.BOOKING_ADMIN_FILES.concat('BookingAdminPage.html')],
      ['webhook', ['Config.gs', 'StripeWebhookAuth.gs', 'StripeEventRepository.gs', 'BookingWebhookEndpoint.gs']]
    ]) {
      const output = path.join(dir, target);
      const sourceManifest = path.join(workspace, 'gas/booking/webhook/appsscript.json');
      fs.mkdirSync(output);
      fs.writeFileSync(path.join(output, 'stale-admin.gs'), 'stale');
      prepareProject(target, output, sourceManifest);
      assert.deepEqual(fs.readdirSync(output).sort(), files.concat('appsscript.json').sort());
      assert.equal(fs.readFileSync(path.join(output, 'appsscript.json'), 'utf8'), fs.readFileSync(sourceManifest, 'utf8'));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function runWorkflow(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-workflow-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    // This stub never contacts Google; the real shell, Node preparation, and classifier run.
    fs.writeFileSync(path.join(bin, 'clasp'), `#!/bin/bash
set -eu
[[ "$1" == --auth && "$3" == --user && "$4" == booking-owner ]]
shift 4
printf '%s\\n' "$1" >> "$MOCK_CALLS"
case "$1" in
 list-deployments) echo "$MOCK_LIST_ID" ;;
 pull) printf '{"runtimeVersion":"V8"}' > appsscript.json ;;
 show-file-status) test -f BookingWebhookEndpoint.gs ;;
 push) if [[ "$MOCK_PUSH_FAIL" == 1 ]]; then echo 'The caller does not have permission. private@example.test token-dummy' >&2; exit 1; fi ;;
 update-deployment) [[ "$2" == "$WEBHOOK_DEPLOYMENT_ID" ]] ;;
 *) exit 99 ;;
esac
`, { mode: 0o700 });
    const command = workflow.slice(workflow.indexOf('        run: |\n') + '        run: |\n'.length)
      .split('\n').map(line => line.replace(/^          /, '')).join('\n');
    const env = {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      GITHUB_WORKSPACE: workspace, RUNNER_TEMP: dir, GITHUB_SHA: 'dummy-commit',
      WEBHOOK_CLASPRC_JSON: JSON.stringify({ tokens: { 'booking-owner': {} } }),
      WEBHOOK_SCRIPT_ID: 'webhook-script-dummy', WEBHOOK_DEPLOYMENT_ID: 'webhook-deployment-dummy',
      PUBLIC_SCRIPT_ID: 'public-script-dummy', ADMIN_SCRIPT_ID: 'admin-script-dummy',
      MOCK_CALLS: calls, MOCK_LIST_ID: 'webhook-deployment-dummy', MOCK_PUSH_FAIL: '0', ...overrides
    };
    const result = spawnSync('bash', ['-c', command], { cwd: dir, env, encoding: 'utf8' });
    const invoked = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
    const payloadDir = path.join(dir, 'booking-webhook-deploy');
    const payload = fs.existsSync(payloadDir) ? fs.readdirSync(payloadDir).sort() : [];
    assert.doesNotMatch(result.stdout + result.stderr, /private@example|token-dummy|webhook-script-dummy|webhook-deployment-dummy/);
    assert.equal(fs.existsSync(path.join(dir, 'clasp-push.log')), false);
    return { ...result, invoked, payload };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('webhook workflow updates only the existing deployment with its isolated payload', () => {
  const r = runWorkflow();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.invoked, ['list-deployments', 'pull', 'show-file-status', 'push', 'update-deployment', 'list-deployments']);
  assert.deepEqual(r.payload, ['.clasp.json', 'BookingWebhookEndpoint.gs', 'Config.gs', 'StripeEventRepository.gs', 'StripeWebhookAuth.gs', 'appsscript.json'].sort());
});

test('webhook workflow refuses missing credentials, wrong users, shared project IDs, and unknown deployments', () => {
  for (const overrides of [
    { WEBHOOK_CLASPRC_JSON: '' },
    { WEBHOOK_CLASPRC_JSON: 'private@example.test token-dummy' },
    { WEBHOOK_CLASPRC_JSON: JSON.stringify({ tokens: { default: {} } }) },
    { WEBHOOK_SCRIPT_ID: 'public-script-dummy' },
    { WEBHOOK_SCRIPT_ID: 'admin-script-dummy' },
    { WEBHOOK_DEPLOYMENT_ID: '' },
    { MOCK_LIST_ID: 'another-deployment' }
  ]) {
    const r = runWorkflow(overrides);
    assert.notEqual(r.status, 0);
    assert.equal(r.invoked.includes('push'), false);
    assert.equal(r.invoked.includes('update-deployment'), false);
  }
});

test('webhook push failure is classified from deploy_dir and stops deployment update', () => {
  const r = runWorkflow({ MOCK_PUSH_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(r.invoked.includes('update-deployment'), false);
  assert.equal(r.stderr, 'clasp push --force failed: WRITE_PERMISSION_OR_SCOPE_DENIED\n');
});
