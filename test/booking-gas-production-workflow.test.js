'use strict';
/*
 * Issue #671: 本番Booking GASの連続デプロイworkflowの制御構造を、YAMLの静的検査で確認する
 * （実際に本番へデプロイするE2Eではない）。依存パッケージを増やさないため、このworkflowの
 * 形（トップレベルキー・jobs直下のjob・steps直下の `- name:`）に限定した最小のテキスト解析を使う。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '..');
const workflowDir = path.join(workspace, '.github/workflows');
const workflow = fs.readFileSync(path.join(workflowDir, 'booking-gas-production.yml'), 'utf8');
const deployScript = path.join(workspace, 'scripts/deploy-booking-gas-target.sh');

function jobBlocks(text) {
  const afterJobs = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const jobs = {};
  let current = null;
  for (const line of afterJobs.split('\n')) {
    const m = line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) { current = m[1]; jobs[current] = []; } else if (current) jobs[current].push(line);
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}
function steps(jobText) {
  const body = jobText.slice(jobText.indexOf('    steps:\n') + '    steps:\n'.length);
  return body.split(/\n(?=      - )/).map((s) => s.replace(/^      - /, ''));
}
const jobs = jobBlocks(workflow);
const deploy = jobs.deploy;
const deploySteps = steps(deploy);
const stepIndex = (needle) => deploySteps.findIndex((s) => s.includes(needle));

test('workflow is manual (workflow_dispatch) only, without a target selector', () => {
  const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /push:|pull_request|schedule:|inputs:|target/);
  assert.doesNotMatch(workflow, /inputs\.target/);
});

test('production job needs test, and both jobs are restricted to main', () => {
  assert.deepEqual(Object.keys(jobs), ['test', 'deploy']);
  assert.match(deploy, /\n    needs: test\n/);
  for (const job of Object.values(jobs)) assert.match(job, /\n    if: github\.ref == 'refs\/heads\/main'\n/);
});

test('exactly one job references the booking-production environment (single approval)', () => {
  assert.equal((workflow.match(/^\s*environment:/gm) || []).length, 1);
  assert.match(deploy, /\n    environment: booking-production\n/);
  assert.doesNotMatch(jobs.test, /environment:|secrets\./);
});

test('single concurrency group for the whole Booking GAS production, not cancelled mid-run', () => {
  assert.equal((workflow.match(/^\s*group:/gm) || []).length, 1);
  assert.match(workflow, /\nconcurrency:\n  group: booking-gas-production\n  cancel-in-progress: false\n/);
  assert.doesNotMatch(workflow, /\$\{\{[^}]*\}\}\s*\n\s*cancel-in-progress/);
});

test('production steps run in order: schema migration -> Admin -> Public -> post-check', () => {
  const migrate = stepIndex('migrate-bookings-schema.js migrate');
  const admin = stepIndex('Update the existing Booking Admin deployment');
  const publicStep = stepIndex('Update the existing Booking Web App deployment');
  const checks = [stepIndex('deploy-booking-gas-target.sh admin verify'), stepIndex('deploy-booking-gas-target.sh public verify'), stepIndex('migrate-bookings-schema.js verify')];
  assert.ok(migrate > 0 && admin > migrate && publicStep > admin, [migrate, admin, publicStep].join());
  assert.ok(checks[0] > publicStep && checks[1] > checks[0] && checks[2] > checks[1], checks.join());
  assert.equal(checks[2], deploySteps.length - 1);
  assert.ok(stepIndex('npm install --global @google/clasp@3.4.1') < migrate, 'tooling is set up first');
});

test('no step can be skipped past a failure: no continue-on-error, failure()/always() conditions or pipeline fallbacks', () => {
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.doesNotMatch(workflow, /\bif:.*(always|failure|cancelled|success)\(\)/);
  for (const s of deploySteps.filter((x) => x.includes('run: |'))) assert.match(s, /set -euo pipefail/);
  assert.doesNotMatch(workflow, /\|\|\s*true|set \+e/);
  assert.doesNotMatch(fs.readFileSync(deployScript, 'utf8'), /\|\|\s*true|set \+e/);
  assert.match(fs.readFileSync(deployScript, 'utf8'), /^set -euo pipefail$/m);
});

test('Admin failure never reaches Public: Public is a later step of the same fail-fast job', () => {
  assert.ok(stepIndex('Update the existing Booking Admin deployment') < stepIndex('Update the existing Booking Web App deployment'));
  const publicStep = deploySteps[stepIndex('Update the existing Booking Web App deployment')];
  assert.match(publicStep, /Booking Admin is updated to the current main commit\./);
  assert.match(publicStep, /exit 1/);
  assert.doesNotMatch(workflow, /NOT updated|was not updated/);
});

test('failure messages distinguish "update did not complete" from "applied but verification failed" via the marker file', () => {
  for (const target of ['admin', 'public']) {
    const step = deploySteps[stepIndex(target === 'admin' ? 'Update the existing Booking Admin deployment' : 'Update the existing Booking Web App deployment')];
    assert.match(step, new RegExp('-f "\\$RUNNER_TEMP/booking-gas-' + target + '-update-applied"'));
    assert.match(step, /was applied but its verification failed/);
    assert.match(step, /did not complete/);
  }
});

test('migration credentials are job-scoped GitHub Secrets and kept separate from clasp credentials', () => {
  const withSheets = deploySteps.filter((x) => /BOOKING_SHEETS_SERVICE_ACCOUNT_JSON: \$\{\{ secrets\.BOOKING_SHEETS_SERVICE_ACCOUNT_JSON \}\}/.test(x));
  assert.equal(withSheets.length, 2, 'only the migrate and schema-verify steps receive the Sheets credential');
  for (const x of withSheets) {
    assert.match(x, /BOOKING_SPREADSHEET_ID: \$\{\{ secrets\.BOOKING_SPREADSHEET_ID \}\}/);
    assert.match(x, /BOOKING_SPREADSHEET_ID_SHA256: \$\{\{ secrets\.BOOKING_SPREADSHEET_ID_SHA256 \}\}/);
    assert.doesNotMatch(x, /CLASPRC|SCRIPT_ID|DEPLOYMENT_ID/);
  }
  const script = fs.readFileSync(deployScript, 'utf8');
  assert.doesNotMatch(script, /BOOKING_SHEETS|BOOKING_SPREADSHEET/);
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{\{ *secrets|echo[^\n]*(SPREADSHEET_ID|SERVICE_ACCOUNT)/);
});

test('secrets are scoped per step, never job-wide, and the clasp install step receives none', () => {
  assert.doesNotMatch(deploy, /\n    env:/);
  assert.doesNotMatch(deploySteps[stepIndex('npm install --global')], /secrets\./);
  for (const x of deploySteps.filter((y) => /ADMIN_|[^_]CLASPRC_JSON/.test(y) && y.includes('secrets.'))) {
    assert.doesNotMatch(x, /BOOKING_SHEETS|BOOKING_SPREADSHEET|PUBLIC_/);
  }
  for (const x of deploySteps.filter((y) => /PUBLIC_/.test(y) && y.includes('secrets.'))) {
    assert.doesNotMatch(x, /BOOKING_SHEETS|BOOKING_SPREADSHEET|ADMIN_|[^_]CLASPRC_JSON/);
  }
});

test('only existing deployments are updated: no create-deployment, no new projects, no Stripe/Webhook changes', () => {
  const script = fs.readFileSync(deployScript, 'utf8');
  assert.match(script, /update-deployment "\$deployment_id"/);
  assert.doesNotMatch(script + workflow, /clasp[^\n]*(create-deployment|deploy |create-script|clone)/);
  assert.doesNotMatch(deploy, /STRIPE|webhook/i);
});

test('the production workflow is the only one that deploys Booking Admin/Public (no double-run path)', () => {
  const others = fs.readdirSync(workflowDir).filter((f) => f !== 'booking-gas-production.yml' && f !== 'booking-pr-tests.yml'); // pr-tests only lists trigger paths
  for (const file of others) {
    const text = fs.readFileSync(path.join(workflowDir, file), 'utf8');
    assert.doesNotMatch(text, /deploy-booking-gas-target|BOOKING_ADMIN_DEPLOYMENT_ID|BOOKING_PUBLIC_DEPLOYMENT_ID/, file);
  }
});

/* ---- deploy script behaviour with a stubbed clasp (never contacts Google) ---- */
function runDeploy(args, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-deploy-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'clasp'), `#!/bin/bash
set -eu
[[ "$1" == --auth && "$3" == --user ]]
user="$4"; shift 4
printf '%s\\n' "$1" >> "$MOCK_CALLS"
case "$1" in
 list-deployments) printf '%s\\n' "$MOCK_LIST" ;;
 pull) printf '{"runtimeVersion":"V8","oauthScopes":[]}' > appsscript.json ;;
 show-file-status) ;;
 push) if [[ "$MOCK_PUSH_FAIL" == 1 ]]; then echo 'The caller does not have permission. private@example.test token-dummy' >&2; exit 1; fi ;;
 update-deployment) [[ "$MOCK_UPDATE_FAIL" != 1 ]] ;;
 *) exit 99 ;;
esac
`, { mode: 0o700 });
    const sha = 'abc123def456';
    const env = {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: dir,
      GITHUB_SHA: sha,
      CLASPRC_JSON: JSON.stringify({ tokens: { default: {} } }),
      PUBLIC_CLASPRC_JSON: JSON.stringify({ tokens: { 'booking-owner': {} } }),
      PUBLIC_SCRIPT_ID: 'public-script-dummy', PUBLIC_DEPLOYMENT_ID: 'public-deployment-dummy',
      ADMIN_SCRIPT_ID: 'admin-script-dummy', ADMIN_DEPLOYMENT_ID: 'admin-deployment-dummy',
      MOCK_CALLS: calls, MOCK_PUSH_FAIL: '0', MOCK_UPDATE_FAIL: '0', ...overrides
    };
    env.MOCK_LIST = env.MOCK_LIST || `- ${args[0]}-deployment-dummy @5 - main ${sha}`;
    const result = spawnSync('bash', [deployScript, ...args], { cwd: dir, env, encoding: 'utf8' });
    const invoked = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
    assert.doesNotMatch(result.stdout + result.stderr, /private@example|token-dummy|script-dummy|deployment-dummy/);
    const markers = Object.fromEntries(['admin', 'public'].map((t) => [t, fs.existsSync(path.join(dir, `booking-gas-${t}-update-applied`))]));
    const marker = (target) => markers[target];
    return { ...result, invoked, marker };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('deploy script updates the existing deployment and confirms the current main SHA for each target', () => {
  for (const target of ['admin', 'public']) {
    const r = runDeploy([target]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.invoked, ['list-deployments', 'pull', 'show-file-status', 'push', 'update-deployment', 'list-deployments']);
    assert.equal(r.stdout.trim().split('\n').pop(), `Updated existing ${target} deployment to the current main commit`);
    assert.equal(r.marker(target), true);
  }
});

test('deploy script refuses unknown targets/modes, unknown deployments and a stale SHA after update', () => {
  assert.notEqual(runDeploy(['webhook']).status, 0);
  assert.notEqual(runDeploy(['admin', 'bogus']).status, 0);
  const unknown = runDeploy(['admin'], { MOCK_LIST: '- another-deployment @1 - main abc123def456' });
  assert.notEqual(unknown.status, 0);
  assert.deepEqual(unknown.invoked, ['list-deployments']);
  const stale = runDeploy(['public'], { MOCK_LIST: '- public-deployment-dummy @5 - main 000000' });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /after update/);
  assert.equal(stale.marker('public'), true, 'update was applied; only verification failed');
});

test('deploy script stops after a failed push without touching the deployment', () => {
  const r = runDeploy(['admin'], { MOCK_PUSH_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(r.invoked.includes('update-deployment'), false);
  assert.equal(r.marker('admin'), false);
  assert.match(r.stderr, /clasp push --force failed: WRITE_PERMISSION_OR_SCOPE_DENIED\n$/);
});

test('a failing update-deployment leaves no "applied" marker', () => {
  const r = runDeploy(['public'], { MOCK_UPDATE_FAIL: '1' });
  assert.notEqual(r.status, 0);
  assert.equal(r.marker('public'), false);
});

test('running admin then public in the same RUNNER_TEMP does not carry over the previous pull (remote_dir is reset)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-deploy-seq-'));
  try {
    fs.mkdirSync(path.join(dir, 'booking-gas-remote'));
    fs.writeFileSync(path.join(dir, 'booking-gas-remote', 'appsscript.json'), '{"leftover":"admin"}');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    // pull returns nothing for public: the manifest check must refuse to push.
    fs.writeFileSync(path.join(bin, 'clasp'), `#!/bin/bash
shift 4
printf '%s\\n' "$1" >> "$MOCK_CALLS"
case "$1" in list-deployments) echo "- public-deployment-dummy @1 - main x" ;; pull) ;; *) exit 0 ;; esac
`, { mode: 0o700 });
    const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: dir,
      GITHUB_SHA: 'x', PUBLIC_CLASPRC_JSON: JSON.stringify({ tokens: { 'booking-owner': {} } }),
      PUBLIC_SCRIPT_ID: 'public-script-dummy', PUBLIC_DEPLOYMENT_ID: 'public-deployment-dummy', MOCK_CALLS: path.join(dir, 'calls') };
    const r = spawnSync('bash', [deployScript, 'public'], { cwd: dir, env, encoding: 'utf8' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /did not return appsscript\.json; refusing to push/);
    assert.equal(fs.readFileSync(path.join(dir, 'calls'), 'utf8').includes('push'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('verify mode is read-only and checks the existing deployment shows the current main SHA', () => {
  const ok = runDeploy(['admin', 'verify']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.invoked, ['list-deployments']);
  assert.match(ok.stdout, /Verified existing admin deployment is at the current main commit/);
  const stale = runDeploy(['public', 'verify'], { MOCK_LIST: '- public-deployment-dummy @5 - main 000000' });
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /does not show the current main commit/);
  assert.deepEqual(stale.invoked, ['list-deployments']);
});
