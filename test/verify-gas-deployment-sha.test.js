'use strict';
/* Issue #804 PR-C1 (review): 更新後の照合は「ID欄の完全一致・一意」かつ「同じ行に今回のSHA」でなければ成功にしない。clasp偽物のみ使用。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspace = path.resolve(__dirname, '..');
const script = path.join(workspace, 'scripts/verify-gas-deployment-sha.sh');
const read = (p) => fs.readFileSync(path.join(workspace, p), 'utf8');
const SHA = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const SENSITIVE = 'private@example.test token-dummy script-dummy deployment-dummy';

// lists: 呼出し順に返す一覧。最後の要素を以降も返す。{error: 'text'} はlist失敗。
function run(role, lists, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-verify-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(dir, 'lists.json'), JSON.stringify(lists));
    fs.writeFileSync(path.join(bin, 'clasp'), `#!/bin/bash
printf '%s\\n' "$*" >> "$MOCK_CALLS"
args=("$@"); i=0
[[ "\${args[0]}" == --auth ]] && i=2
[[ "\${args[$i]}" == --user ]] && i=$((i+2))
[[ "\${args[$i]}" == list-deployments ]] || exit 99
n=$(grep -c 'list-deployments' "$MOCK_CALLS")
node -e '
  const lists = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const item = lists[Math.min(Number(process.argv[2]), lists.length) - 1];
  if (item && typeof item === "object") { console.error(item.error + " " + process.env.MOCK_SENSITIVE); console.log(process.env.MOCK_SENSITIVE); process.exit(1); }
  console.error(process.env.MOCK_SENSITIVE);
  console.log(item);
' "$MOCK_LISTS" "$n"
`, { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'sleep'), '#!/bin/bash\nprintf "%s\\n" "$1" >> "$MOCK_SLEEPS"\n', { mode: 0o700 });
    const e = {
      ...process.env, PATH: bin + path.delimiter + process.env.PATH, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: dir,
      GITHUB_SHA: SHA, AUTH_FILE: path.join(dir, 'auth.json'), DEPLOYMENT_ID: 'target-deployment-dummy',
      MOCK_CALLS: path.join(dir, 'calls'), MOCK_SLEEPS: path.join(dir, 'sleeps'), MOCK_LISTS: path.join(dir, 'lists.json'),
      MOCK_SENSITIVE: SENSITIVE, ...env
    };
    const r = spawnSync('bash', [script, role], { cwd: dir, env: e, encoding: 'utf8' });
    const calls = fs.existsSync(e.MOCK_CALLS) ? fs.readFileSync(e.MOCK_CALLS, 'utf8').trim().split('\n') : [];
    const sleeps = fs.existsSync(e.MOCK_SLEEPS) ? fs.readFileSync(e.MOCK_SLEEPS, 'utf8').trim().split('\n') : [];
    assert.doesNotMatch(r.stdout + r.stderr, /private@example|token-dummy|script-dummy|deployment-dummy/);
    assert.equal(fs.readdirSync(dir).some((f) => f.startsWith('gas-verify-list')), false, 'temp list files removed');
    return { ...r, calls, sleeps };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const good = `- target-deployment-dummy @4 - main ${SHA}`;
test('exact description tolerates only trailing whitespace/CR, and @HEAD style versions', () => {
  for (const line of [`${good}   `, `${good}\r`, `- target-deployment-dummy @HEAD - main ${SHA}`]) {
    const r = run('survey-public', [line]);
    assert.equal(r.status, 0, JSON.stringify(line) + r.stderr);
  }
});
const lines = (...l) => l.join('\n');

for (const role of ['booking-webhook', 'survey-public', 'survey-admin']) {
  test(`${role}: correct ID + current SHA succeeds with a single read and no wait; user boundary respected`, () => {
    const r = run(role, [good]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.sleeps, []);
    assert.equal(r.calls[0].includes('--user booking-owner'), role === 'booking-webhook');
    assert.match(r.stdout, new RegExp(`Verified role=${role}`));
  });
}

test('only exact-ID + same-row current SHA succeeds; every near miss fails closed as an incomplete confirmation', () => {
  const cases = [
    ['old SHA on the target row', lines(`- target-deployment-dummy @4 - main ${OLD}`), 'SHA_MISMATCH'],
    ['SHA only on another deployment row', lines(`- target-deployment-dummy @4 - main ${OLD}`, `- other-deployment @5 - main ${SHA}`), 'SHA_MISMATCH'],
    ['ID is only a prefix of another ID', lines(`- target-deployment-dummy-suffix @4 - main ${SHA}`), 'DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE'],
    ['ID appears only in a description', lines(`- other-deployment @4 - target-deployment-dummy main ${SHA}`), 'DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE'],
    ['duplicate ID rows', lines(good, `- target-deployment-dummy @3 - main ${OLD}`), 'DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE'],
    ['empty list', '', 'DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE'],
    ['previous main = current SHA while the current main is an old SHA', lines(`- target-deployment-dummy @4 - previous main ${SHA}; current main ${OLD}`), 'SHA_MISMATCH'],
    ['current SHA followed by extra text', lines(`- target-deployment-dummy @4 - main ${SHA} extra`), 'SHA_MISMATCH'],
    ['text before the main SHA', lines(`- target-deployment-dummy @4 - rollback of main ${SHA}`), 'SHA_MISMATCH'],
    ['SHA only after a different main SHA', lines(`- target-deployment-dummy @4 - main ${OLD} main ${SHA}`), 'SHA_MISMATCH'],
    ['no description', lines('- target-deployment-dummy @4 -'), 'SHA_MISMATCH'],
    ['SHA extended by more hex digits', lines(`- target-deployment-dummy @4 - main ${SHA}0`), 'SHA_MISMATCH']
  ];
  for (const [name, list, code] of cases) {
    const r = run('booking-webhook', [list]);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, new RegExp(`^GAS post-update verification failed: role=booking-webhook stage=VERIFY code=${code}\\.`), name);
    assert.match(r.stderr, /update was applied but is NOT confirmed.*do not assume a rollback or re-push\.\n$/s, name);
    for (const write of ['push', 'update-deployment']) assert.equal(r.calls.some((c) => c.includes(write)), false);
    assert.ok(r.calls.every((c) => c.includes('list-deployments')), 'read-only commands only');
  }
});

test('a stale SHA is retried read-only (max 5 reads, 5s waits) and never re-pushes; propagation on a later read succeeds', () => {
  const stale = `- target-deployment-dummy @3 - main ${OLD}`;
  const never = run('survey-public', [stale]);
  assert.equal(never.status, 1);
  assert.equal(never.calls.length, 5);
  assert.deepEqual(never.sleeps, ['5', '5', '5', '5']);
  assert.match(never.stderr, /code=SHA_MISMATCH/);
  const late = run('survey-admin', [stale, stale, good]);
  assert.equal(late.status, 0, late.stderr);
  assert.equal(late.calls.length, 3);
  assert.deepEqual(late.sleeps, ['5', '5']);
});

test('ID loss or a list error during retries stops immediately with a classified fixed code', () => {
  const stale = `- target-deployment-dummy @3 - main ${OLD}`;
  const gone = run('booking-webhook', [stale, '- another @1 - x']);
  assert.equal(gone.status, 1);
  assert.equal(gone.calls.length, 2);
  assert.match(gone.stderr, /code=DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE/);
  for (const [text, code] of [['invalid_grant', 'AUTHENTICATION_FAILED'], ['HTTP 403 forbidden', 'ACCESS_DENIED'], ['HTTP 503', 'TRANSIENT_API_OR_NETWORK_ERROR'], ['strange', 'UNCLASSIFIED']]) {
    const first = run('booking-webhook', [{ error: text }]);
    assert.equal(first.status, 1);
    assert.equal(first.calls.length, 1);
    assert.match(first.stderr, new RegExp(`stage=VERIFY code=${code}\\.`));
    const later = run('survey-public', [stale, { error: text }]);
    assert.equal(later.calls.length, 2);
    assert.match(later.stderr, new RegExp(`code=${code}\\.`));
  }
});

test('unknown roles are refused; the workflows call the helper after update-deployment instead of an ID-only grep', () => {
  assert.equal(run('survey', [good]).status, 1);
  for (const [file, role] of [['.github/workflows/booking-gas-webhook-production.yml', 'booking-webhook'], ['.github/workflows/survey-gas-production.yml', '"$verify_role"']]) {
    const wf = read(file);
    const update = wf.indexOf('Running clasp update-deployment');
    const verify = wf.indexOf('verify-gas-deployment-sha.sh');
    assert.ok(update > 0 && verify > update, file);
    assert.ok(wf.slice(verify).includes(role));
    assert.doesNotMatch(wf.slice(update), /grep -Fq|list-deployments \(after update\)/, 'no ID-only post-update check remains');
    assert.equal((wf.match(/clasp --auth "\$auth_file"[^\n]*update-deployment "\$deployment_id"/g) || []).length, 1, 'exactly one update invocation');
    assert.doesNotMatch(wf.slice(verify), /update-deployment|push --force/, 'the update/push is not re-run after verification');
  }
  const src = read('scripts/verify-gas-deployment-sha.sh');
  assert.doesNotMatch(src, /\bclasp[^\n]*(push|update-deployment|deploy |create)|\|\|\s*true|set \+e/);
  assert.match(src, /^set -euo pipefail$/m);
});
