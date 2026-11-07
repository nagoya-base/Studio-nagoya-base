'use strict';
/* Issue #804 PR-C1: Webhook / Survey の更新前preflight（読取りのみ・固定コード・秘密非出力）を、clasp偽物で検証する。実Googleには接続しない。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '..');
const script = path.join(workspace, 'scripts/preflight-gas-project.sh');
const read = (p) => fs.readFileSync(path.join(workspace, p), 'utf8');
const SENSITIVE = 'private@example.test token-dummy script-dummy deployment-dummy';

function run(role, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-preflight-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'clasp'), `#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_CALLS"
args=("$@"); i=0
[[ "\${args[0]}" == --auth ]] && i=2
[[ "\${args[$i]}" == --user ]] && i=$((i+2))
case "\${args[$i]}" in
  list-deployments)
    echo "$MOCK_SENSITIVE" >&2
    if [[ -n "$MOCK_LIST_ERROR" ]]; then echo "$MOCK_LIST_ERROR $MOCK_SENSITIVE" >&2; exit 1; fi
    printf '%s\\n' "$MOCK_LIST" ;;
  pull) [[ "$MOCK_NO_MANIFEST" == 1 ]] || printf '{"runtimeVersion":"V8","oauthScopes":[]}' > appsscript.json ;;
  *) exit 99 ;;
esac
`, { mode: 0o700 });
    const user = role === 'booking-webhook';
    const idPrefix = role;
    const env = {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: dir,
      CLASPRC_JSON_VALUE: JSON.stringify(user ? { tokens: { 'booking-owner': {} } } : { tokens: { default: {} } }),
      SCRIPT_ID: `${idPrefix}-script-dummy`, DEPLOYMENT_ID: `${idPrefix}-deployment-dummy`,
      PUBLIC_SCRIPT_ID: 'public-script-dummy', ADMIN_SCRIPT_ID: 'admin-script-dummy',
      MOCK_CALLS: path.join(dir, 'calls'), MOCK_SENSITIVE: SENSITIVE, MOCK_LIST_ERROR: '', MOCK_NO_MANIFEST: '0',
      MOCK_LIST: `- ${idPrefix}-deployment-dummy @3 - main abc`, ...overrides
    };
    const r = spawnSync('bash', [script, role], { cwd: dir, env, encoding: 'utf8' });
    const calls = fs.existsSync(env.MOCK_CALLS) ? fs.readFileSync(env.MOCK_CALLS, 'utf8').trim().split('\n') : [];
    const leftovers = fs.readdirSync(dir).filter((f) => f !== 'bin' && f !== 'calls');
    assert.doesNotMatch(r.stdout + r.stderr, /private@example|token-dummy|script-dummy|deployment-dummy/);
    return { ...r, calls, leftovers };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const verbs = (calls) => calls.map((c) => c.replace(/^--auth \S+ (--user \S+ )?/, '').split(' ')[0]);

for (const role of ['booking-webhook', 'survey-public', 'survey-admin']) {
  test(`${role}: preflight passes read-only (list + pull only), builds the distribution, and removes temp files`, () => {
    const r = run(role);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(verbs(r.calls), ['list-deployments', 'pull']);
    assert.match(r.stdout, new RegExp(`GAS preflight passed: role=${role}`));
    assert.deepEqual(r.leftovers, [], 'credential/list/build temp files are removed');
    // user boundary: Webhook always uses booking-owner; Survey uses the default user (no --user flag)
    for (const c of r.calls) assert.equal(c.includes('--user booking-owner'), role === 'booking-webhook', c);
  });

  test(`${role}: each failure stops with one fixed role/stage/code line and no write command`, () => {
    const id = `${role}-deployment-dummy`;
    const cases = [
      [{ SCRIPT_ID: '' }, /stage=SECRETS code=SECRET_MISSING/, []],
      [{ DEPLOYMENT_ID: '' }, /stage=SECRETS code=SECRET_MISSING/, []],
      [{ CLASPRC_JSON_VALUE: '{broken' }, /stage=CREDENTIAL code=CLASP_CREDENTIAL_OR_USER_MISMATCH/, []],
      [{ CLASPRC_JSON_VALUE: 'null' }, /stage=CREDENTIAL/, []],
      [{ MOCK_LIST_ERROR: 'invalid_grant' }, /stage=LIST code=AUTHENTICATION_FAILED/, ['list-deployments']],
      [{ MOCK_LIST_ERROR: 'HTTP 403 forbidden' }, /stage=LIST code=ACCESS_DENIED/, ['list-deployments']],
      [{ MOCK_LIST_ERROR: 'HTTP 503' }, /stage=LIST code=TRANSIENT_API_OR_NETWORK_ERROR/, ['list-deployments']],
      [{ MOCK_LIST_ERROR: 'strange' }, /stage=LIST code=UNCLASSIFIED/, ['list-deployments']],
      [{ MOCK_LIST: '- another-deployment @1 - x' }, /stage=DEPLOYMENT code=DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE/, ['list-deployments']],
      [{ MOCK_LIST: `- ${id}-suffix @1 - x` }, /stage=DEPLOYMENT/, ['list-deployments']],
      [{ MOCK_LIST: `- other @1 - ${id}` }, /stage=DEPLOYMENT/, ['list-deployments']],
      [{ MOCK_LIST: `- ${id} @1 - a\n- ${id} @2 - b` }, /stage=DEPLOYMENT/, ['list-deployments']],
      [{ MOCK_NO_MANIFEST: '1' }, /stage=PULL code=MANIFEST_MISSING/, ['list-deployments', 'pull']]
    ];
    if (role === 'booking-webhook') {
      cases.push([{ CLASPRC_JSON_VALUE: JSON.stringify({ tokens: { default: {} } }) }, /stage=CREDENTIAL/, []]);
      cases.push([{ SCRIPT_ID: 'public-script-dummy' }, /stage=PROJECT code=WEBHOOK_NOT_INDEPENDENT/, []]);
      cases.push([{ SCRIPT_ID: 'admin-script-dummy' }, /stage=PROJECT code=WEBHOOK_NOT_INDEPENDENT/, []]);
    }
    for (const [overrides, pattern, expectedVerbs] of cases) {
      const r = run(role, overrides);
      assert.equal(r.status, 1, JSON.stringify(overrides));
      assert.equal(r.stderr.trim().split('\n').length, 1, 'a single fixed line');
      assert.match(r.stderr, new RegExp(`^GAS preflight failed: role=${role} stage=`));
      assert.match(r.stderr, pattern);
      assert.match(r.stderr, /No deployment was updated\.\n$/);
      assert.deepEqual(verbs(r.calls), expectedVerbs);
      for (const write of ['push', 'update-deployment', 'show-file-status']) assert.equal(verbs(r.calls).includes(write), false);
      assert.deepEqual(r.leftovers, []);
    }
  });
}

test('unknown roles are refused without any clasp call', () => {
  for (const role of ['', 'booking-public', 'survey', '../x']) {
    const r = run(role);
    assert.equal(r.status, 1);
    assert.deepEqual(r.calls, []);
  }
});

test('Webhook/Survey workflows run the preflight after approval, before the update step, with only the selected target secrets', () => {
  const idx = (text, needle) => text.indexOf(needle);
  const webhook = read('.github/workflows/booking-gas-webhook-production.yml');
  const survey = read('.github/workflows/survey-gas-production.yml');
  for (const [wf, role] of [[webhook, 'booking-webhook'], [survey, '"$role"']]) {
    const pre = idx(wf, 'preflight-gas-project.sh');
    assert.ok(pre > idx(wf, '\n    environment:'), 'inside the approved Environment job');
    assert.ok(pre > idx(wf, 'Install pinned clasp') && pre < idx(wf, '- name: Update the existing deployment'), 'before the first write');
    assert.ok(wf.includes(role));
    assert.equal((wf.match(/^\s*environment:/gm) || []).length, 1, 'no extra approval job');
  }
  // survey: the target is passed through env, never interpolated into the preflight shell; only the selected pair is exported
  const surveyStep = survey.slice(survey.indexOf('- name: Preflight'), survey.indexOf('- name: Update the existing deployment'));
  assert.doesNotMatch(surveyStep.slice(surveyStep.indexOf('run:')), /\$\{\{/);
  assert.match(surveyStep, /public\) role=survey-public; SCRIPT_ID="\$PUBLIC_SCRIPT_ID_SECRET"; DEPLOYMENT_ID="\$PUBLIC_DEPLOYMENT_ID_SECRET"/);
  assert.match(surveyStep, /admin\) role=survey-admin; SCRIPT_ID="\$ADMIN_SCRIPT_ID_SECRET"; DEPLOYMENT_ID="\$ADMIN_DEPLOYMENT_ID_SECRET"/);
  // unchanged safety conditions
  assert.match(webhook, /concurrency:\n  group: booking-gas-webhook-production\n  cancel-in-progress: false/);
  assert.match(survey, /group: survey-gas-production-\$\{\{ inputs\.target \}\}\n  cancel-in-progress: false/);
  assert.match(webhook, /on:\n  workflow_dispatch:\n/);
  assert.match(webhook, /environment: booking-production/);
  assert.match(survey, /environment: survey-production/);
  assert.doesNotMatch(webhook + survey, /continue-on-error|secrets: inherit/);
});

test('the preflight script only calls read-only clasp commands and never prints raw output', () => {
  const src = read('scripts/preflight-gas-project.sh');
  assert.doesNotMatch(src, /clasp_cmd\s+(push|update-deployment|show-file-status|deploy|create|run)\b|\|\|\s*true|set \+e/);
  assert.match(src, /^set -euo pipefail$/m);
  assert.doesNotMatch(src, /echo[^\n]*(CLASPRC|credential|script_id|deployment_id)/);
  assert.match(src, /trap cleanup EXIT/);
});
