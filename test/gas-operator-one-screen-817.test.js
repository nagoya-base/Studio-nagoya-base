'use strict';
// Issue #817 段階2: 運営者向け一画面ガイドが、実在するworkflow・Environment・文書を指していることを確認する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const doc = fs.readFileSync(path.join(root, 'docs/gas-operator-one-screen-817.md'), 'utf8');
const wfDir = path.join(root, '.github/workflows');
const workflows = fs.readdirSync(wfDir).map((f) => fs.readFileSync(path.join(wfDir, f), 'utf8')).join('\n');

test('ガイドの workflow 名が実在する', () => {
  for (const name of [
    'Deploy Booking GAS to production',
    'Update Booking Webhook GAS',
    'Deploy Survey GAS to production',
    'Deploy SwitchBot access GAS',
    'Deploy SwitchBot verify GAS',
    'SwitchBot read-only diagnostics (manual)',
  ]) {
    assert.ok(doc.includes(name), `doc: ${name}`);
    assert.ok(workflows.includes(`name: ${name}`), `workflow: ${name}`);
  }
});

test('ガイドの Environment 名が workflow に実在する', () => {
  for (const env of ['booking-production', 'survey-production', 'switchbot-access-production', 'switchbot-access-on-approval', 'switchbot-verify']) {
    assert.ok(doc.includes(env), `doc: ${env}`);
    assert.ok(workflows.includes(`environment: ${env}`), `workflow: ${env}`);
  }
});

test('ガイドの preflight 固定コードがスクリプトに実在する', () => {
  const pre = fs.readFileSync(path.join(root, 'scripts/preflight-gas-project.sh'), 'utf8');
  for (const code of ['SECRET_MISSING', 'CLASP_CREDENTIAL_OR_USER_MISMATCH', 'WEBHOOK_NOT_INDEPENDENT', 'DEPLOYMENT_ID_MISSING_OR_NOT_UNIQUE']) {
    assert.ok(doc.includes(code), `doc: ${code}`);
    assert.ok(pre.includes(code), `script: ${code}`);
  }
});

test('ガイドが参照する文書が存在し、秘密値らしき文字列を含まない', () => {
  for (const m of doc.matchAll(/`((?:docs|gas)\/[^`\s]+\.md)`/g)) {
    assert.ok(fs.existsSync(path.join(root, m[1])), m[1]);
  }
  assert.ok(!/refresh_token|-----BEGIN|AKfy|https:\/\/script\.google\.com\/macros\/s\//.test(doc));
});
