'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

test('#933: required-gate runs on every PR (no paths filter) and stays secret-free', () => {
  const wf = read('.github/workflows/pr-required-gate.yml');
  const on = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\npermissions:'));
  assert.match(on, /\n  pull_request:\n/);
  assert.doesNotMatch(on, /paths|paths-ignore|branches|push:|pull_request_target|schedule|workflow_dispatch/);
  assert.match(wf, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(wf, /secrets\.|environment:|id-token|contents: write/);
  assert.match(wf, /\n  required-gate:\n    name: required-gate\n/);
  assert.match(wf, /run: npm test/);
});

test('#933: ruleset template targets main only and requires the always-generated check', () => {
  const rs = JSON.parse(read('.github/rulesets/main-protection.json'));
  assert.deepEqual(rs.conditions.ref_name.include, ['refs/heads/main']);
  const byType = Object.fromEntries(rs.rules.map((r) => [r.type, r]));
  assert.ok(byType.deletion && byType.non_fast_forward && byType.pull_request);
  assert.equal(byType.pull_request.parameters.required_approving_review_count, 0, 'sole operator must not be locked out');
  assert.deepEqual(byType.required_status_checks.parameters.required_status_checks, [{ context: 'required-gate' }]);
  for (const b of rs.bypass_actors) assert.equal(b.bypass_mode, 'pull_request', 'no direct-push bypass');
});
