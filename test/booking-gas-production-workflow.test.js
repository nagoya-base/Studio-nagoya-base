'use strict';
/*
 * Issue #671 / #673: 本番Booking GASの連続デプロイworkflowの制御構造を、YAMLの静的検査で確認する
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

test('workflow is manual (workflow_dispatch) only, with scope=full|admin-only and schema_migrated inputs', () => {
  const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /push:|pull_request|schedule:|target/);
  assert.doesNotMatch(workflow, /inputs\.target/);
  assert.match(on, /scope:\n(?:.*\n)*?        type: choice\n        options:\n          - full\n          - admin-only\n        default: full\n/);
  assert.match(on, /schema_migrated:\n(?:.*\n)*?        type: boolean\n        default: false\n/);
  assert.equal((on.match(/^      [a-z_]+:$/gm) || []).length, 2, 'only scope and schema_migrated');
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

test('scope=full runs: tests -> (approval) -> schema guard -> Admin -> Public -> post-check, with no schema migration step', () => {
  const guard = stepIndex('deploy-booking-gas-target.sh public schema-guard');
  const admin = stepIndex('Update the existing Booking Admin deployment');
  const publicStep = stepIndex('Update the existing Booking Web App deployment');
  const checks = [stepIndex('deploy-booking-gas-target.sh admin verify'), stepIndex('deploy-booking-gas-target.sh public verify')];
  assert.ok(guard > 0 && admin > guard && publicStep > admin, [guard, admin, publicStep].join());
  assert.ok(checks[0] > publicStep && checks[1] > checks[0], checks.join());
  assert.ok(stepIndex('npm install --global @google/clasp@3.4.1') < guard, 'tooling is set up first');
  assert.match(deploy, /\n    needs: test\n/);
  assert.match(deploy, /\n    environment: booking-production\n/);
  assert.doesNotMatch(workflow, /migrate-bookings-schema|migrate_bookings|Migrate the Bookings sheet schema/);
});

test('schema guard runs in the approved deploy job (environment secrets), before any Admin update, only for scope=full', () => {
  const guardStep = deploySteps[stepIndex('deploy-booking-gas-target.sh public schema-guard')];
  assert.match(guardStep, /\n        if: inputs\.scope == 'full'\n/);
  assert.match(guardStep, /SCHEMA_MIGRATED: \$\{\{ inputs\.schema_migrated \}\}/);
  assert.match(guardStep, /PUBLIC_CLASPRC_JSON: \$\{\{ secrets\.BOOKING_PUBLIC_CLASPRC_JSON \}\}/);
  assert.doesNotMatch(guardStep, /ADMIN_|[^_]CLASPRC_JSON/);
  assert.equal(jobs.test.includes('schema-guard'), false, 'cannot run before approval: clasp credentials are Environment secrets');
  assert.ok(stepIndex('schema-guard') < stepIndex('Update the existing Booking Admin deployment'));
});

test('scope=admin-only updates and verifies Booking Admin only; Public steps are full-only', () => {
  for (const needle of ['Update the existing Booking Web App deployment', 'deploy-booking-gas-target.sh public verify', 'schema-guard']) {
    assert.match(deploySteps[stepIndex(needle)], /\n        if: inputs\.scope == 'full'\n/, needle);
  }
  for (const needle of ['Update the existing Booking Admin deployment', 'deploy-booking-gas-target.sh admin verify']) {
    assert.doesNotMatch(deploySteps[stepIndex(needle)], /\bif: /, needle + ' runs for both scopes');
  }
  const publicRefs = deploySteps.filter((x) => /PUBLIC_|Web App/.test(x.split(/\n\s+run:/)[0]) && !x.startsWith('name: Next step') && !x.startsWith('name: Validate scope'));
  assert.ok(publicRefs.length >= 3);
  for (const x of publicRefs) assert.match(x, /\n        if: inputs\.scope == 'full'\n/, x.split('\n')[0]);
  const next = deploySteps[stepIndex('Next step after admin-only')];
  assert.match(next, /if: inputs\.scope == 'admin-only'/);
  assert.match(deploySteps[stepIndex('Validate scope')], /scope must be full or admin-only/);
});

test('inputs are passed through env (never interpolated into shell) and the checkout has full history for the schema diff', () => {
  for (const x of deploySteps.filter((y) => y.includes('run:'))) {
    const runPart = x.slice(x.indexOf('run:'));
    assert.doesNotMatch(runPart, /\$\{\{/, x.split('\n')[0]);
  }
  const checkout = deploySteps[0];
  assert.match(checkout, /actions\/checkout@v4\n        with:\n          fetch-depth: 0/);
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

test('no Sheets API / service-account / Spreadsheet secrets or WIF/OIDC remain in the production workflow or deploy script', () => {
  const script = fs.readFileSync(deployScript, 'utf8');
  for (const text of [workflow, script]) {
    assert.doesNotMatch(text, /BOOKING_SHEETS_SERVICE_ACCOUNT_JSON|BOOKING_SPREADSHEET_ID|SERVICE_ACCOUNT|sheets\.googleapis|google-github-actions\/auth|workload_identity|id-token/i);
  }
  assert.match(workflow, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(workflow, /echo[^\n]*\$\{\{ *secrets/);
});

test('secrets are scoped per step, never job-wide, and the clasp install step receives none', () => {
  assert.doesNotMatch(deploy, /\n    env:/);
  assert.doesNotMatch(deploySteps[stepIndex('npm install --global')], /secrets\./);
  for (const x of deploySteps.filter((y) => /ADMIN_|[^_]CLASPRC_JSON/.test(y) && y.includes('secrets.'))) {
    assert.doesNotMatch(x, /PUBLIC_/);
  }
  for (const x of deploySteps.filter((y) => /PUBLIC_/.test(y) && y.includes('secrets.'))) {
    assert.doesNotMatch(x, /ADMIN_|[^_]CLASPRC_JSON/);
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
 list-deployments)
   echo 'private@example.test token-dummy' >&2
   echo 'private@example.test token-dummy'
   count=$(grep -c '^list-deployments$' "$MOCK_CALLS")
   if [[ "$count" -gt 1 && "$count" == "$MOCK_LIST_FAIL_AT" ]]; then
     echo 'invalid_grant private@example.test token-dummy' >&2
     echo 'script-dummy deployment-dummy' ; exit 1
   fi
   if [[ "$count" -gt 1 && "$MOCK_AFTER_LIST_SET" == 1 ]]; then
     if [[ "$count" -ge "$MOCK_CURRENT_AT" ]]; then
       printf '%s\\n' "$MOCK_LIST"
     else
       printf '%s\\n' "$MOCK_AFTER_LIST"
     fi
   else
     printf '%s\\n' "$MOCK_LIST"
   fi ;;
 pull) printf '{"runtimeVersion":"V8","oauthScopes":[]}' > appsscript.json ;;
 show-file-status) ;;
 push) if [[ "$MOCK_PUSH_FAIL" == 1 ]]; then echo 'The caller does not have permission. private@example.test token-dummy' >&2; exit 1; fi ;;
 update-deployment) [[ "$MOCK_UPDATE_FAIL" != 1 ]] ;;
 *) exit 99 ;;
esac
`, { mode: 0o700 });
    // Record waits without delaying the tests. Production uses the real sleep command.
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nprintf "%s\\n" "$1" >> "$MOCK_SLEEPS"\n', { mode: 0o700 });
    const sha = 'abc123def456';
    const env = {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: dir,
      GITHUB_SHA: sha,
      CLASPRC_JSON: JSON.stringify({ tokens: { default: {} } }),
      PUBLIC_CLASPRC_JSON: JSON.stringify({ tokens: { 'booking-owner': {} } }),
      PUBLIC_SCRIPT_ID: 'public-script-dummy', PUBLIC_DEPLOYMENT_ID: 'public-deployment-dummy',
      ADMIN_SCRIPT_ID: 'admin-script-dummy', ADMIN_DEPLOYMENT_ID: 'admin-deployment-dummy',
      MOCK_CALLS: calls, MOCK_SLEEPS: path.join(dir, 'sleeps'), MOCK_PUSH_FAIL: '0', MOCK_UPDATE_FAIL: '0',
      MOCK_AFTER_LIST_SET: '0', MOCK_CURRENT_AT: '99', MOCK_LIST_FAIL_AT: '0', ...overrides
    };
    env.MOCK_LIST = env.MOCK_LIST || `- ${args[0]}-deployment-dummy @5 - main ${sha}`;
    const result = spawnSync('bash', [deployScript, ...args], { cwd: dir, env, encoding: 'utf8' });
    const invoked = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
    assert.doesNotMatch(result.stdout + result.stderr, /private@example|token-dummy|script-dummy|deployment-dummy/);
    const markers = Object.fromEntries(['admin', 'public'].map((t) => [t, fs.existsSync(path.join(dir, `booking-gas-${t}-update-applied`))]));
    const marker = (target) => markers[target];
    const sleeps = fs.existsSync(env.MOCK_SLEEPS) ? fs.readFileSync(env.MOCK_SLEEPS, 'utf8').trim().split('\n') : [];
    return { ...result, invoked, marker, sleeps };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('deploy script updates the existing deployment and confirms the current main SHA for each target', () => {
  for (const target of ['admin', 'public']) {
    const r = runDeploy([target]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.invoked, ['list-deployments', 'pull', 'show-file-status', 'push', 'update-deployment', 'list-deployments']);
    assert.equal(r.stdout.trim().split('\n').pop(), `Updated existing ${target} deployment to the current main commit`);
    assert.equal(r.marker(target), true);
    assert.deepEqual(r.sleeps, []);
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
  assert.equal(stale.invoked.filter((c) => c === 'list-deployments').length, 6, 'one before + five after');
  assert.deepEqual(stale.sleeps, ['5', '5', '5', '5']);
});

test('description propagation can succeed on the second or final attempt without repeating any update', () => {
  for (const target of ['admin', 'public']) {
    for (const currentAt of [3, 6]) {
      const r = runDeploy([target], {
        MOCK_AFTER_LIST_SET: '1', MOCK_AFTER_LIST: `- ${target}-deployment-dummy @4 - main 000000`,
        MOCK_CURRENT_AT: String(currentAt)
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.invoked.filter((c) => c === 'list-deployments').length, currentAt);
      for (const command of ['pull', 'push', 'update-deployment']) {
        assert.equal(r.invoked.filter((c) => c === command).length, 1);
      }
      assert.deepEqual(r.sleeps, Array(currentAt - 2).fill('5'));
      assert.equal(r.marker(target), true);
    }
  }
});

test('missing, ambiguous, substring-only IDs and another deployment showing the SHA fail immediately after update', () => {
  const current = '- admin-deployment-dummy @5 - main abc123def456';
  for (const listing of [
    '', '- another-deployment @5 - main abc123def456',
    `${current}\n${current}`, `${current}\n- admin-deployment-dummy @4 - main 000000`,
    '- admin-deployment-dummy-suffix @5 - main abc123def456'
  ]) {
    const r = runDeploy(['admin'], { MOCK_AFTER_LIST_SET: '1', MOCK_AFTER_LIST: listing });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /could not be verified after update/);
    assert.equal(r.invoked.filter((c) => c === 'list-deployments').length, 2);
    assert.deepEqual(r.sleeps, []);
    assert.equal(r.marker('admin'), true);
  }
  const wrongLine = runDeploy(['admin'], { MOCK_AFTER_LIST_SET: '1',
    MOCK_AFTER_LIST: '- admin-deployment-dummy @4 - main 000000\n- another-deployment @5 - main abc123def456' });
  assert.equal(wrongLine.status, 1);
  assert.equal(wrongLine.sleeps.length, 4);
});

test('list API errors fail through the classifier immediately, including during retries', () => {
  for (const failAt of ['2', '3']) {
    const r = runDeploy(['admin'], { MOCK_AFTER_LIST_SET: '1',
      MOCK_AFTER_LIST: '- admin-deployment-dummy @4 - main 000000', MOCK_LIST_FAIL_AT: failAt });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /clasp list-deployments failed \(after update\): AUTHENTICATION_FAILED\n$/);
    assert.equal(r.invoked.filter((c) => c === 'list-deployments').length, Number(failAt));
    assert.equal(r.sleeps.length, Number(failAt) - 2);
    assert.equal(r.marker('admin'), true);
  }
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
  assert.deepEqual(stale.sleeps, []);
  assert.equal(stale.marker('public'), false);
  for (const listing of [
    '- admin-deployment-dummy @5 - main abc123def456\n- admin-deployment-dummy @4 - main 000000',
    '- admin-deployment-dummy-suffix @5 - main abc123def456',
    '- admin-deployment-dummy @5 - main abc123def4560'
  ]) {
    const r = runDeploy(['admin', 'verify'], { MOCK_LIST: listing });
    assert.equal(r.status, 1);
    assert.deepEqual(r.invoked, ['list-deployments']);
    assert.deepEqual(r.sleeps, []);
    assert.equal(r.marker('admin'), false);
  }
});

/* ---- schema diff guard (Issue #673): stubbed clasp + a real temporary git history ---- */
const SCHEMA_PATH = 'gas/booking/shared/BookingsSchema.gs';
function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, '-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function commit(dir, files, message) {
  for (const [file, content] of Object.entries(files)) {
    const full = path.join(dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (content === null) fs.rmSync(full, { force: true }); else fs.writeFileSync(full, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}
function runGuard({ setup, describe, schemaMigrated, deploymentLine }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-guard-'));
  try {
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(repo);
    git(repo, 'init', '-q');
    const shas = setup(repo);
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'clasp'), `#!/bin/bash
shift 4
printf '%s\\n' "$1" >> "$MOCK_CALLS"
case "$1" in list-deployments) printf '%s\\n' "$MOCK_LIST" ;; *) exit 99 ;; esac
`, { mode: 0o700 });
    const line = deploymentLine ? deploymentLine(shas) : `- public-deployment-dummy @5 - main ${shas.previous}`;
    const env = {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH, GITHUB_WORKSPACE: repo, RUNNER_TEMP: dir,
      GITHUB_SHA: shas.current,
      CLASPRC_JSON: JSON.stringify({ tokens: { default: {} } }),
      PUBLIC_CLASPRC_JSON: JSON.stringify({ tokens: { 'booking-owner': {} } }),
      PUBLIC_SCRIPT_ID: 'public-script-dummy', PUBLIC_DEPLOYMENT_ID: 'public-deployment-dummy',
      ADMIN_SCRIPT_ID: 'admin-script-dummy', ADMIN_DEPLOYMENT_ID: 'admin-deployment-dummy',
      MOCK_CALLS: calls, MOCK_LIST: line, SCHEMA_MIGRATED: schemaMigrated === undefined ? 'false' : schemaMigrated
    };
    const result = spawnSync('bash', [deployScript, 'public', 'schema-guard'], { cwd: dir, env, encoding: 'utf8' });
    const invoked = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
    assert.doesNotMatch(result.stdout + result.stderr, /script-dummy|deployment-dummy|token-dummy/);
    assert.equal(invoked.every((c) => c === 'list-deployments'), true, 'guard is read-only: no pull/push/update-deployment');
    return { ...result, invoked, shas };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const unchanged = (repo) => {
  const previous = commit(repo, { [SCHEMA_PATH]: 'schema v1\n', 'other.txt': 'a' }, 'prev');
  const current = commit(repo, { 'other.txt': 'b' }, 'cur');
  return { previous, current };
};
const changed = (repo) => {
  const previous = commit(repo, { [SCHEMA_PATH]: 'schema v1\n' }, 'prev');
  const current = commit(repo, { [SCHEMA_PATH]: 'schema v2\n' }, 'cur');
  return { previous, current };
};

test('schema guard: no BookingsSchema.gs diff since the previous Public SHA -> passes without schema_migrated', () => {
  const r = runGuard({ setup: unchanged });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.invoked, ['list-deployments']);
  assert.match(r.stdout, /schema is unchanged/);
});

test('schema guard: diff + schema_migrated != true stops before any Admin update; true lets it continue', () => {
  const stop = runGuard({ setup: changed, schemaMigrated: 'false' });
  assert.notEqual(stop.status, 0);
  assert.match(stop.stderr, /migrateBookingsSchema/);
  assert.match(stop.stderr, /schema_migrated=true/);
  const unset = runGuard({ setup: changed, schemaMigrated: '' });
  assert.notEqual(unset.status, 0);
  const ok = runGuard({ setup: changed, schemaMigrated: 'true' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /schema_migrated=true confirmed/);
});

test('schema guard: baseline is the Public deployment SHA even when the Admin deployment already shows the current SHA', () => {
  // admin-only has advanced Admin to the current SHA; only the Public line (previous full) is read.
  const r = runGuard({
    setup: changed,
    deploymentLine: ({ previous, current }) => `- public-deployment-dummy @5 - main ${previous}\n- admin-deployment-dummy @9 - main ${current}`,
    schemaMigrated: 'false'
  });
  assert.notEqual(r.status, 0, 'Public SHA differs -> migration required although Admin SHA equals the current SHA');
  const adminOnlyEquals = runGuard({
    setup: changed,
    deploymentLine: ({ current }) => `- admin-deployment-dummy @9 - main ${current}`
  });
  assert.notEqual(adminOnlyEquals.status, 0, 'no Public line -> fail closed, Admin SHA is never used as the baseline');
  const script = fs.readFileSync(deployScript, 'utf8');
  assert.match(script, /\$mode" == "schema-guard" && "\$target" != "public"/);
  assert.notEqual(spawnSync('bash', [deployScript, 'admin', 'schema-guard'], { env: { ...process.env, RUNNER_TEMP: os.tmpdir() }, encoding: 'utf8' }).status, 0);
});

test('schema guard: a previous SHA without BookingsSchema.gs (first bootstrap) counts as a schema diff', () => {
  const bootstrap = (repo) => {
    const previous = commit(repo, { 'README.md': 'before #671' }, 'prev');
    const current = commit(repo, { [SCHEMA_PATH]: 'schema v1\n' }, 'cur');
    return { previous, current };
  };
  const stop = runGuard({ setup: bootstrap, schemaMigrated: 'false' });
  assert.notEqual(stop.status, 0);
  assert.match(stop.stderr, /schema_migrated=true/);
  const ok = runGuard({ setup: bootstrap, schemaMigrated: 'true' });
  assert.equal(ok.status, 0, ok.stderr);
});

test('schema guard fails closed when the previous Public SHA cannot be identified safely', () => {
  const cases = {
    'no SHA in description': () => '- public-deployment-dummy @5 - manual deploy',
    'short SHA': () => '- public-deployment-dummy @5 - main abc123def456',
    'unknown deployment': ({ previous }) => `- another-deployment @5 - main ${previous}`,
    'two SHAs': ({ previous, current }) => `- public-deployment-dummy @5 - main ${previous} main ${current}`,
    'SHA not in checked-out history': () => `- public-deployment-dummy @5 - main ${'0'.repeat(40)}`
  };
  for (const [label, deploymentLine] of Object.entries(cases)) {
    const r = runGuard({ setup: unchanged, deploymentLine, schemaMigrated: 'true' });
    assert.notEqual(r.status, 0, label + ' must fail even with schema_migrated=true');
    assert.doesNotMatch(r.stderr, /[0-9a-f]{40}/, label);
  }
});
