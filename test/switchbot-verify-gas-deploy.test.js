'use strict';
/*
 * Issue #723: 独立SwitchBot検証GASの自動デプロイ。workflowの静的検査と、偽のclaspを使った
 * スクリプトの振る舞い検査（実GASへは一切接続しない）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('../scripts/switchbot-verify-gas-deploy-lib.js');

const root = path.resolve(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/switchbot-verify-gas-deploy.yml'), 'utf8');
const script = path.join(root, 'scripts/deploy-switchbot-verify-gas.sh');
const scriptText = fs.readFileSync(script, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('workflow: main push (target paths) + workflow_dispatch only; no PR/fork trigger', () => {
  const on = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\npermissions:'));
  assert.match(on, /push:\n\s+branches:\n\s+- main\n\s+paths:/);
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /pull_request|schedule:|pull_request_target/);
  assert.match(on, /gas\/switchbot-verify\/\*\*/);
});

test('workflow: deploy and rollback are main-only and use the switchbot-verify environment', () => {
  assert.equal((wf.match(/^\s+environment: switchbot-verify$/gm) || []).length, 2);
  assert.doesNotMatch(wf, /environment: (?!switchbot-verify)/);
  assert.doesNotMatch(wf, /booking-production|BOOKING_/);
  const ifs = wf.match(/^\s+if: github\.ref == 'refs\/heads\/main'.*$/gm) || [];
  assert.equal(ifs.length, 3, 'test, deploy and rollback jobs');
});

test('workflow: the secret-free test job has no environment or secrets', () => {
  const testJob = wf.slice(wf.indexOf('\n  test:'), wf.indexOf('\n  deploy:'));
  assert.doesNotMatch(testJob, /environment:|secrets\./);
  assert.match(wf, /\n    needs: test\n/);
});

test('workflow: serialized, never cancels an in-flight deployment', () => {
  assert.match(wf, /concurrency:\n  group: switchbot-verify-gas-deploy\n  cancel-in-progress: false\n/);
});

test('workflow: secrets only on the deploy/rollback steps, minimal permissions, pinned clasp', () => {
  assert.match(wf, /permissions:\n  contents: read\n/);
  assert.equal((wf.match(/secrets\./g) || []).length, 6);
  assert.doesNotMatch(wf, /^env:/m);
  assert.match(wf, /@google\/clasp@3\.4\.1/);
  assert.doesNotMatch(wf, /actions\/(upload-artifact|cache)|set -x|xtrace|ACTIONS_STEP_DEBUG/);
});

test('script: never creates/deletes deployments, never traces, never prints raw clasp output', () => {
  assert.doesNotMatch(scriptText, /create-deployment|delete-deployment|\bdeploy\b +-|set -x|set -o xtrace/);
  assert.match(scriptText, /trap cleanup EXIT/);
  assert.doesNotMatch(scriptText, /cat "\$out\/(list|versions|push|update|pull)[^"]*"\s*$/m);
  assert.doesNotMatch(scriptText, /createKey|deleteKey|setupWebhook|verifyCreate/);
});

// ---- lib ----
test('lib.pickDeployment: unique, versioned deployment only', () => {
  const rows = [{ deploymentId: 'A', versionNumber: 3, description: 'main x' }, { deploymentId: 'B' }];
  assert.deepEqual(lib.pickDeployment(JSON.stringify(rows), 'A'), { versionNumber: 3, description: 'main x' });
  assert.equal(lib.pickDeployment(JSON.stringify(rows), 'B').error, 'DEPLOYMENT_NOT_VERSIONED');
  assert.equal(lib.pickDeployment(JSON.stringify(rows), 'Z').error, 'DEPLOYMENT_ID_NOT_FOUND');
  assert.equal(lib.pickDeployment(JSON.stringify([rows[0], rows[0]]), 'A').error, 'DEPLOYMENT_ID_NOT_UNIQUE');
  assert.equal(lib.pickDeployment('not json', 'A').error, 'LIST_PARSE_FAILED');
});

test('lib.checkManifest: webapp must match; new scopes need manual approval', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbv-m-'));
  const w = (n, o) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  const base = { webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' }, oauthScopes: ['a'] };
  assert.equal(lib.checkManifest(w('r1', base), w('p1', base)), 'OK');
  assert.equal(lib.checkManifest(w('r2', { ...base, webapp: { access: 'MYSELF', executeAs: 'USER_DEPLOYING' } }), w('p2', base)), 'MANIFEST_WEBAPP_MISMATCH');
  assert.equal(lib.checkManifest(w('r3', base), w('p3', { ...base, oauthScopes: ['a', 'b'] })), 'MANIFEST_NEW_OAUTH_SCOPE_REQUIRES_MANUAL_APPROVAL');
});

test('lib.checkRemoteTarget / checkCredential', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbv-r-'));
  assert.equal(lib.checkRemoteTarget(dir), 'TARGET_MISMATCH_NO_SWITCHBOT_VERIFY');
  fs.writeFileSync(path.join(dir, 'SwitchBotVerify.gs'), '');
  assert.equal(lib.checkRemoteTarget(dir), 'OK');
  fs.writeFileSync(path.join(dir, 'BookingX.gs'), '');
  assert.equal(lib.checkRemoteTarget(dir), 'TARGET_MISMATCH_OTHER_PROJECT');
  assert.equal(lib.checkCredential('{'), 'CREDENTIAL_NOT_JSON');
  assert.equal(lib.checkCredential('{"tokens":{}}'), 'CREDENTIAL_USER_MISSING');
  assert.equal(lib.checkCredential('{"tokens":{"default":{}}}'), 'OK');
});

// ---- script with a fake clasp ----
const SECRET = 'SECRETSCRIPTID1234567890';
const DEPLOY = 'AKfycbxDEPLOYMENTSECRET99999';
const TOKEN = 'refresh-token-DONOTLEAK';

function fakeClasp(binDir, stateDir) {
  const js = `#!/usr/bin/env node
const fs=require('fs'),path=require('path');
const S=process.env.FAKE_STATE, a=process.argv.slice(2).filter((x,i,arr)=>!(x==='--auth'||arr[i-1]==='--auth'||x==='--user'||arr[i-1]==='--user'));
const cmd=a[0]; const st=()=>JSON.parse(fs.readFileSync(S+'/state.json','utf8')); const save=(s)=>fs.writeFileSync(S+'/state.json',JSON.stringify(s));
const fail=process.env.FAKE_FAIL||''; if(fail===cmd){console.error('boom '+process.env.FAKE_LEAK);process.exit(1);}
const s=st();
if(cmd==='pull'){for(const [n,c] of Object.entries(s.files))fs.writeFileSync(n,c);}
else if(cmd==='push'){s.files={};for(const n of fs.readdirSync('.'))if(n.endsWith('.gs')||n==='appsscript.json')s.files[n]=fs.readFileSync(n,'utf8'); if(fail==='push-nosave'){}else save(s);}
else if(cmd==='list-deployments'){console.log(JSON.stringify(s.deployments));}
else if(cmd==='list-versions'){console.log(JSON.stringify(s.versions));}
else if(cmd==='update-deployment'){
  const id=a[1]; const vi=a.indexOf('-V'); const di=a.indexOf('--description');
  if(fail==='update-silent'){process.exit(1);}
  let v; if(vi>=0)v=Number(a[vi+1]); else{v=Math.max(...s.versions.map(x=>x.versionNumber))+1;s.versions.push({versionNumber:v,description:a[di+1]});}
  const d=s.deployments.find(x=>x.deploymentId===id); d.versionNumber=v; d.description=a[di+1];
  save(s); if(fail==='update-apply-then-error'){process.exit(1);}
}`;
  fs.writeFileSync(path.join(binDir, 'clasp'), js, { mode: 0o755 });
}

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbv-e2e-'));
  const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const tmp = path.join(dir, 'tmp');
  [bin, state, tmp].forEach((d) => fs.mkdirSync(d));
  fakeClasp(bin, state);
  const manifest = fs.readFileSync(path.join(root, 'gas/switchbot-verify/appsscript.json'), 'utf8');
  fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({
    files: { 'SwitchBotVerify.gs': '// old', 'appsscript.json': manifest, ...(overrides.files || {}) },
    versions: [{ versionNumber: 1, description: 'one' }, { versionNumber: 2, description: 'two' }],
    deployments: [{ deploymentId: DEPLOY, versionNumber: 2, description: 'main old' }, { deploymentId: 'HEADID' }]
  }));
  const summary = path.join(dir, 'summary.md');
  const run = (mode, env = {}) => spawnSync('bash', [script, mode], {
    encoding: 'utf8',
    env: {
      PATH: bin + path.delimiter + process.env.PATH, HOME: dir, FAKE_STATE: state, FAKE_LEAK: SECRET,
      RUNNER_TEMP: tmp, GITHUB_WORKSPACE: root, GITHUB_SHA: 'a'.repeat(40), GITHUB_STEP_SUMMARY: summary,
      GITHUB_RUN_ID: '1', SBV_RETRY_DELAY_SECONDS: '0', SBV_CLASPRC_JSON: JSON.stringify({ tokens: { default: { refresh_token: TOKEN } } }),
      SBV_SCRIPT_ID: SECRET, SBV_DEPLOYMENT_ID: DEPLOY, ...env
    }
  });
  const read = () => JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
  return { run, read, tmp, summary };
}
const noLeak = (r) => {
  // `::add-mask::` はrunnerが消費する命令で、ログには表示されない。それ以外に値が出ていないことを確認する。
  const all = (r.stdout + r.stderr).replace(/^::add-mask::.*$/gm, '');
  for (const v of [SECRET, DEPLOY, TOKEN]) assert.ok(!all.includes(v), 'secret value leaked');
};

test('deploy: pushes, verifies source, updates the SAME deployment to a new version; cleans up auth', () => {
  const t = setup();
  const r = t.run('deploy');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = t.read();
  assert.equal(s.deployments.length, 2, 'no deployment created/deleted');
  const d = s.deployments.find((x) => x.deploymentId === DEPLOY);
  assert.equal(d.versionNumber, 3);
  assert.equal(d.description, 'main ' + 'a'.repeat(40));
  assert.equal(s.files['SwitchBotVerify.gs'], fs.readFileSync(path.join(root, 'gas/switchbot-verify/SwitchBotVerify.gs'), 'utf8'));
  noLeak(r);
  assert.deepEqual(fs.readdirSync(t.tmp), [], 'auth/work files removed');
  assert.match(fs.readFileSync(t.summary, 'utf8'), /@2.*@3/);
});

test('deploy: missing secrets fail before anything is touched', () => {
  const t = setup();
  const r = t.run('deploy', { SBV_DEPLOYMENT_ID: '' });
  assert.notEqual(r.status, 0);
  assert.equal(t.read().deployments[0].versionNumber, 2);
  noLeak(r);
});

test('deploy: unknown deployment id / wrong target project fail without changes', () => {
  let t = setup();
  let r = t.run('deploy', { SBV_DEPLOYMENT_ID: 'NOPE' });
  assert.notEqual(r.status, 0);
  assert.equal(t.read().files['SwitchBotVerify.gs'], '// old');
  t = setup({ files: { 'BookingFoo.gs': '' } });
  r = t.run('deploy');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TARGET_MISMATCH_OTHER_PROJECT/);
  assert.equal(t.read().deployments[0].versionNumber, 2);
  noLeak(r);
});

test('deploy: push failure leaves the published deployment unchanged and leaks nothing', () => {
  const t = setup();
  const r = t.run('deploy', { FAKE_FAIL: 'push' });
  assert.notEqual(r.status, 0);
  assert.equal(t.read().deployments[0].versionNumber, 2);
  noLeak(r);
});

test('deploy: update failure with no change is reported as NOT applied (not success), no retry of update', () => {
  const t = setup();
  const r = t.run('deploy', { FAKE_FAIL: 'update-silent' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NOT applied/);
  assert.equal(t.read().deployments[0].versionNumber, 2);
  noLeak(r);
});

test('deploy: update that applied but returned an error is reconciled by reads (success)', () => {
  const t = setup();
  const r = t.run('deploy', { FAKE_FAIL: 'update-apply-then-error' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.read().deployments[0].versionNumber, 3);
});

test('rollback: same deployment goes back to an existing version; invalid versions are refused', () => {
  const t = setup();
  assert.equal(t.run('deploy').status, 0);
  const r = t.run('rollback', { ROLLBACK_VERSION: '2' });
  assert.equal(r.status, 0, r.stderr);
  const s = t.read();
  assert.equal(s.deployments.length, 2);
  assert.equal(s.deployments.find((x) => x.deploymentId === DEPLOY).versionNumber, 2);
  assert.notEqual(t.run('rollback', { ROLLBACK_VERSION: '99' }).status, 0);
  assert.notEqual(t.run('rollback', { ROLLBACK_VERSION: 'abc' }).status, 0);
  assert.notEqual(t.run('rollback', { ROLLBACK_VERSION: '2' }).status, 0, 'already at that version');
});
