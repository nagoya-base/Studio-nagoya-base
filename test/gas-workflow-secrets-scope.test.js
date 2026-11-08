'use strict';
/*
 * Issue #804 PR-D2: Webhook / Survey の本番更新workflowでSecretsの受け渡しを最小化する。
 *  - job全体のenvにSecretsを置かない（checkout / setup-node / clasp導入へ渡さない）
 *  - Secretsは preflight / 更新 の2 stepだけに渡す
 *  - Surveyは選択した対象(public|admin)の分だけ渡し、選ばれなかった側のSecretは環境変数に載せない
 * 実Google・実Secretは使わない（clasp偽物と静的検査のみ）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(workspace, p), 'utf8');
const webhook = read('.github/workflows/booking-gas-webhook-production.yml');
const survey = read('.github/workflows/survey-gas-production.yml');
// ブラウザが送信するDeployment ID（scripts/survey-config.js の BASE_URL。公開情報）。public更新はこのIDの場合だけ進む（Issue #845）。
const BASE_URL_DEPLOYMENT_ID = /\/macros\/s\/([^/]+)\/exec/.exec(read('scripts/survey-config.js'))[1];

// deploy job を step 単位に分解する（`      - name:` 区切り）。
function deploySteps(wf) {
  const deploy = wf.slice(wf.indexOf('\n  deploy:'));
  const head = deploy.slice(0, deploy.indexOf('\n    steps:'));
  const parts = deploy.slice(deploy.indexOf('\n    steps:')).split(/\n(?=      - name: )/).slice(1);
  return { head, steps: parts.map((text) => ({ name: /- name: (.*)/.exec(text)[1], text })) };
}

for (const [label, wf] of [['webhook', webhook], ['survey', survey]]) {
  test(`${label}: deploy job has no job-level env and no secrets outside the preflight/update steps`, () => {
    const { head, steps } = deploySteps(wf);
    assert.doesNotMatch(head, /^    env:/m, 'no job-level env');
    assert.doesNotMatch(head, /secrets\./, 'no secrets in the job header');
    const allowed = new Set(['Update the existing deployment']);
    for (const s of steps) {
      if (/^Preflight/.test(s.name)) allowed.add(s.name);
    }
    for (const s of steps) {
      if (!allowed.has(s.name)) {
        assert.doesNotMatch(s.text, /secrets\./, `step "${s.name}" must not receive secrets`);
        assert.doesNotMatch(s.text, /^\s+env:/m, `step "${s.name}" needs no env`);
      }
    }
    const withSecrets = steps.filter((s) => /secrets\./.test(s.text)).map((s) => s.name);
    assert.equal(withSecrets.length, 2, 'exactly the preflight and update steps use secrets');
    assert.ok(withSecrets.some((n) => /^Preflight/.test(n)));
    assert.ok(withSecrets.includes('Update the existing deployment'));
    // clasp導入はSecretを渡すstepより前（認証ファイル生成前）
    const names = steps.map((s) => s.name);
    assert.ok(names.findIndex((n) => /Install pinned clasp/.test(n)) < names.findIndex((n) => /^Preflight/.test(n)));
  });

  test(`${label}: no secrets in run scripts, no secrets inherit, test job stays secret-free`, () => {
    const testJob = wf.slice(wf.indexOf('\n  test:'), wf.indexOf('\n  deploy:'));
    assert.doesNotMatch(testJob, /secrets\.|environment:/);
    assert.doesNotMatch(wf, /secrets: inherit/);
    // run: ブロック内に `${{ secrets.* }}` を直接展開しない（envでのみ受け取る）
    for (const block of wf.split(/\n\s+run: \|\n/).slice(1)) {
      const body = block.split(/\n      - name: /)[0];
      assert.doesNotMatch(body, /\$\{\{\s*secrets\./);
    }
  });
}

test('webhook: update step receives exactly the five names it uses; the other IDs are never credentials', () => {
  const { steps } = deploySteps(webhook);
  const update = steps.find((s) => s.name === 'Update the existing deployment').text;
  const names = [...update.matchAll(/^          ([A-Z_]+): \$\{\{ secrets\.([A-Z_]+) \}\}$/gm)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(names.sort(), [
    'ADMIN_SCRIPT_ID=BOOKING_ADMIN_SCRIPT_ID',
    'PUBLIC_SCRIPT_ID=BOOKING_PUBLIC_SCRIPT_ID',
    'WEBHOOK_CLASPRC_JSON=BOOKING_WEBHOOK_CLASPRC_JSON',
    'WEBHOOK_DEPLOYMENT_ID=BOOKING_WEBHOOK_DEPLOYMENT_ID',
    'WEBHOOK_SCRIPT_ID=BOOKING_WEBHOOK_SCRIPT_ID'
  ]);
  // Booking本体(Public/Admin)の資格情報JSONは渡さない
  assert.doesNotMatch(webhook, /BOOKING_PUBLIC_CLASPRC_JSON|secrets\.CLASPRC_JSON/);
});

test('survey: only the selected target secrets reach the steps; the other side is forced to an empty string', () => {
  const refs = [...survey.matchAll(/^\s+([A-Z_]+): \$\{\{ (.*secrets\.(SURVEY_[A-Z_]+).*) \}\}$/gm)];
  assert.equal(refs.length, 8, 'four target-specific secrets in each of the two steps');
  for (const [, , expr, secret] of refs) {
    const side = /^SURVEY_PUBLIC_/.test(secret) ? 'public' : 'admin';
    assert.equal(expr, `inputs.target == '${side}' && secrets.${secret} || ''`);
  }
  // 共通の資格情報JSONは preflight / 更新 の2 stepだけ
  assert.equal((survey.match(/secrets\.CLASPRC_JSON/g) || []).length, 2);
  // `inputs.target` をshell本文へ直接展開しない（envのSURVEY_TARGET経由）
  for (const block of survey.split(/\n\s+run: \|\n/).slice(1)) {
    assert.doesNotMatch(block.split(/\n      - name: /)[0], /\$\{\{/);
  }
});

// ---- Survey 更新stepの実行検査（clasp偽物。選択側以外の値が空でも、選択側のIDだけで動くこと） ----
function updateScript() {
  const { steps } = deploySteps(survey);
  const text = steps.find((s) => s.name === 'Update the existing deployment').text;
  const body = text.slice(text.indexOf('        run: |\n') + '        run: |\n'.length);
  return body.split('\n').map((l) => l.replace(/^          /, '')).join('\n');
}

function runSurveyUpdate(target, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survey-d2-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const calls = path.join(dir, 'calls');
    fs.writeFileSync(path.join(bin, 'clasp'), `#!/bin/bash
set -eu
[[ "$1" == --auth ]]
shift 2
printf '%s %s\\n' "$1" "$(grep -o '"scriptId":"[^"]*"' .clasp.json 2>/dev/null || true)" >> "$MOCK_CALLS"
case "$1" in
 list-deployments) echo "- $MOCK_LIST_ID @3 - main $GITHUB_SHA" ;;
 pull) printf '{"runtimeVersion":"V8"}' > appsscript.json ;;
 show-file-status|push) ;;
 update-deployment) printf 'update %s\\n' "$2" >> "$MOCK_CALLS" ;;
 *) exit 99 ;;
esac
`, { mode: 0o700 });
    const selected = target === 'public'
      ? { PUBLIC_SCRIPT_ID: 'pub-script-dummy', PUBLIC_DEPLOYMENT_ID: BASE_URL_DEPLOYMENT_ID, ADMIN_SCRIPT_ID: '', ADMIN_DEPLOYMENT_ID: '' }
      : { ADMIN_SCRIPT_ID: 'adm-script-dummy', ADMIN_DEPLOYMENT_ID: 'adm-deploy-dummy', PUBLIC_SCRIPT_ID: '', PUBLIC_DEPLOYMENT_ID: '' };
    const env = {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      GITHUB_WORKSPACE: workspace, RUNNER_TEMP: dir, GITHUB_SHA: 'dummy-commit',
      SURVEY_TARGET: target, CLASPRC_JSON: JSON.stringify({ tokens: { default: {} } }),
      ...selected, MOCK_CALLS: calls,
      MOCK_LIST_ID: target === 'public' ? BASE_URL_DEPLOYMENT_ID : 'adm-deploy-dummy', ...overrides
    };
    const result = spawnSync('bash', ['-c', updateScript()], { cwd: dir, env, encoding: 'utf8' });
    const log = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
    assert.doesNotMatch(result.stdout + result.stderr, /pub-script-dummy|adm-script-dummy|pub-deploy-dummy|adm-deploy-dummy/);
    assert.ok((result.stdout + result.stderr).indexOf(BASE_URL_DEPLOYMENT_ID) === -1, 'deployment ID is not logged');
    return { ...result, log };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

for (const target of ['public', 'admin']) {
  test(`survey update step (${target}) works with only the selected target secrets and uses only them`, () => {
    const r = runSurveyUpdate(target);
    assert.equal(r.status, 0, r.stderr);
    const prefix = target === 'public' ? 'pub' : 'adm';
    const other = target === 'public' ? 'adm' : 'pub';
    const deployId = target === 'public' ? BASE_URL_DEPLOYMENT_ID : 'adm-deploy-dummy';
    assert.ok(r.log.indexOf(`update ${deployId}`) !== -1, r.log);
    assert.match(r.log, new RegExp(`${prefix}-script-dummy`));
    assert.doesNotMatch(r.log, new RegExp(other + '-'));
  });

  test(`survey update step (${target}) stops before any write when the selected secrets are empty (no fallback to the other target)`, () => {
    const cleared = target === 'public'
      ? { PUBLIC_SCRIPT_ID: '', PUBLIC_DEPLOYMENT_ID: '' }
      : { ADMIN_SCRIPT_ID: '', ADMIN_DEPLOYMENT_ID: '' };
    const r = runSurveyUpdate(target, cleared);
    assert.notEqual(r.status, 0);
    assert.equal(r.log, '', 'no clasp command at all');
    assert.match(r.stderr, /Required survey-production secrets are not configured/);
  });
}

test('survey update step rejects an unsupported target before any clasp call', () => {
  const r = runSurveyUpdate('public', { SURVEY_TARGET: 'other' });
  assert.notEqual(r.status, 0);
  assert.equal(r.log, '');
});

test('survey update step (public) stops before any clasp call when BASE_URL does not point at the configured deployment (Issue #845)', () => {
  const r = runSurveyUpdate('public', { PUBLIC_DEPLOYMENT_ID: 'pub-deploy-dummy', MOCK_LIST_ID: 'pub-deploy-dummy' });
  assert.notEqual(r.status, 0);
  assert.equal(r.log, '', 'no clasp command at all');
  assert.match(r.stderr, /BASE_URL does not point at the configured public deployment/);
});

test('survey update step (admin) is not gated by the public BASE_URL', () => {
  const r = runSurveyUpdate('admin');
  assert.equal(r.status, 0, r.stderr);
});
