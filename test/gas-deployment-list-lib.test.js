'use strict';
// Issue #804 PR-E1: scripts/gas-deployment-list-lib.sh（preflight / post-update verify が共有する読取り部品）の単体検査。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lib = path.join(__dirname, '..', 'scripts/gas-deployment-list-lib.sh');
const sha = 'a'.repeat(40);

function run(body, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gas-list-lib-'));
  try {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return spawnSync('bash', ['-c', `set -euo pipefail\nsource "${lib}"\n${body}`], { cwd: dir, encoding: 'utf8' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const list = `Found 3 deployments.\n- AKfy-target @5 - main ${sha}\n- AKfy-other @4 - main ${sha} (AKfy-target)\n- @HEAD\n`;

test('id count matches the ID column exactly (no partial / description matches)', () => {
  assert.equal(run('gas_deployment_id_count AKfy-target list.txt', { 'list.txt': list }).stdout.trim(), '1');
  assert.equal(run('gas_deployment_id_count AKfy list.txt', { 'list.txt': list }).stdout.trim(), '0');
  assert.equal(run('gas_deployment_id_count AKfy-target list.txt', { 'list.txt': list + `- AKfy-target @6 - dup\n` }).stdout.trim(), '2');
});

test('description is the whole description of the exact-ID row, trimmed of trailing space/CR only', () => {
  const r = run('gas_deployment_description AKfy-target list.txt', { 'list.txt': `- AKfy-target @5 - main ${sha}  \r\n` });
  assert.equal(r.stdout, `main ${sha}\n`);
  assert.equal(run('gas_deployment_description AKfy-other list.txt', { 'list.txt': list }).stdout, `main ${sha} (AKfy-target)\n`);
  assert.equal(run('gas_deployment_description AKfy list.txt', { 'list.txt': list }).stdout, '');
});

test('list error code is a fixed upper-case code and never echoes raw output', () => {
  const r = run('gas_list_error_code out.txt err.txt', { 'out.txt': '', 'err.txt': 'invalid_grant secret-token-value' });
  assert.match(r.stdout, /^[A-Z_]+$/);
  assert.doesNotMatch(r.stdout + r.stderr, /secret-token-value/);
  assert.equal(run('gas_list_error_code missing1 missing2').stdout.match(/^[A-Z_]+$/) !== null, true);
});

test('the library is source-only and calls no write command', () => {
  const r = spawnSync('bash', [lib], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
  const src = fs.readFileSync(lib, 'utf8');
  assert.doesNotMatch(src.replace(/^\s*#.*$/gm, ''), /(^|[\s;|(])clasp\s|update-deployment|\bpush\b/);
});

test('preflight and verify scripts use the shared library instead of private copies', () => {
  for (const f of ['scripts/preflight-gas-project.sh', 'scripts/verify-gas-deployment-sha.sh']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.match(src, /gas-deployment-list-lib\.sh/, f);
    assert.doesNotMatch(src, /awk -v id=|classify\(read/, f);
  }
});
