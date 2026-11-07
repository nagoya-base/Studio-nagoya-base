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
fs.appendFileSync(S+'/calls.log', cmd+'\\n');
const sumf=process.env.GITHUB_STEP_SUMMARY; const preflightDone=!!sumf&&fs.existsSync(sumf)&&fs.readFileSync(sumf,'utf8').includes('preflight');
if((cmd==='push'||cmd==='update-deployment')&&!preflightDone)fs.appendFileSync(S+'/calls.log','WRITE_BEFORE_PREFLIGHT\\n');
const fail=process.env.FAKE_FAIL||''; if(fail===cmd){console.error('boom '+process.env.FAKE_LEAK);process.exit(1);}
const s=st();
const cfg=JSON.parse(fs.readFileSync('.clasp.json','utf8')); const ext=(cfg.scriptExtensions&&cfg.scriptExtensions[0])||'js';
if(cmd==='pull'){for(const [n,c] of Object.entries(s.files))fs.writeFileSync(n.endsWith('.gs')?n.slice(0,-3)+'.'+ext:n,c);}
else if(cmd==='push'){s.files={};for(const n of fs.readdirSync('.'))if(n.endsWith('.gs')||n==='appsscript.json')s.files[n.endsWith('.gs')?n:n]=fs.readFileSync(n,'utf8'); if(fail==='push-nosave'){}else save(s);}
else if(cmd==='list-deployments'){console.log(JSON.stringify(s.deployments));}
else if(cmd==='list-versions'){console.log(JSON.stringify(s.versions));}
else if(cmd==='update-deployment'){
  const id=a[1]; const vi=a.indexOf('-V'); const di=a.indexOf('--description');
  if(fail==='update-silent'){process.exit(1);}
  let v; if(vi>=0)v=Number(a[vi+1]); else{v=Math.max(...s.versions.map(x=>x.versionNumber))+1;s.versions.push({versionNumber:v,description:a[di+1]});}
  const d=s.deployments.find(x=>x.deploymentId===id); d.versionNumber=v; d.description=a[di+1]+(process.env.FAKE_DESC_SUFFIX||'');
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
  const calls = () => (fs.existsSync(path.join(state, 'calls.log')) ? fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
  return { run, read, tmp, summary, calls };
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

test('write-config pins scriptExtensions to gs (clasp 3.x pulls .js by default)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbv-cfg-'));
  const r = spawnSync('node', [path.join(root, 'scripts/switchbot-verify-gas-deploy-lib.js'), 'write-config', path.join(dir, 'a.json'), dir, 'x'],
    { env: { ...process.env, SBV_CLASPRC_JSON: '{}', SBV_SCRIPT_ID: 'S' } });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.clasp.json'), 'utf8')).scriptExtensions, ['gs']);
});

// ---- Issue #804 PR-C3: 更新前の読取り確認（preflight）の境界・rollbackの対象照合・入力の早期検査・説明文の完全一致 ----
const SHA40 = 'a'.repeat(40);
const written = (t) => t.calls().some((c) => c === 'push' || c === 'update-deployment');

test('preflight boundary: no push/update-deployment runs before the preflight line (deploy and rollback)', () => {
  for (const [mode, env] of [['deploy', {}], ['rollback', { ROLLBACK_VERSION: '1' }]]) {
    const t = setup();
    const r = t.run(mode, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Preflight passed \(read-only checks complete; the first write follows\)/);
    assert.match(fs.readFileSync(t.summary, 'utf8'), /更新前の読取り確認（preflight）: 成功/);
    assert.ok(!t.calls().includes('WRITE_BEFORE_PREFLIGHT'), 'a write happened before the preflight boundary');
    assert.ok(written(t));
    noLeak(r);
  }
});

test('rollback now verifies the target project first: another project (Booking/Survey files) is refused with zero writes', () => {
  const t = setup({ files: { 'BookingApp.gs': '// not the verify GAS' } });
  const r = t.run('rollback', { ROLLBACK_VERSION: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Target project mismatch: TARGET_MISMATCH_OTHER_PROJECT/);
  assert.doesNotMatch(r.stdout, /Preflight passed/);
  assert.ok(!written(t));
  assert.ok(t.calls().includes('pull'), 'the target was checked read-only before any write');
});

test('rollback checks only the web app settings of the manifest; deploy still refuses a missing new OAuth scope', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'gas/switchbot-verify/appsscript.json'), 'utf8'));
  const noScope = JSON.stringify({ ...manifest, oauthScopes: [] });
  const dep = setup({ files: { 'appsscript.json': noScope } });
  const d = dep.run('deploy');
  assert.notEqual(d.status, 0);
  assert.match(d.stderr, /MANIFEST_NEW_OAUTH_SCOPE_REQUIRES_MANUAL_APPROVAL/);
  assert.ok(!written(dep));
  const rb = setup({ files: { 'appsscript.json': noScope } });
  const r = rb.run('rollback', { ROLLBACK_VERSION: '1' });
  assert.equal(r.status, 0, r.stderr);
  const bad = setup({ files: { 'appsscript.json': JSON.stringify({ ...manifest, webapp: { access: 'MYSELF', executeAs: 'USER_DEPLOYING' } }) } });
  const b = bad.run('rollback', { ROLLBACK_VERSION: '1' });
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /MANIFEST_WEBAPP_MISMATCH/);
  assert.ok(!written(bad));
});

test('every read-only failure before the boundary stops with zero writes and no preflight line', () => {
  const cases = [
    ['list-deployments fails', 'deploy', { FAKE_FAIL: 'list-deployments' }],
    ['list-versions fails', 'deploy', { FAKE_FAIL: 'list-versions' }],
    ['pull (target check) fails', 'deploy', { FAKE_FAIL: 'pull' }],
    ['rollback: pull fails', 'rollback', { ROLLBACK_VERSION: '1', FAKE_FAIL: 'pull' }],
    ['rollback: list fails', 'rollback', { ROLLBACK_VERSION: '1', FAKE_FAIL: 'list-deployments' }],
    ['rollback: unknown version', 'rollback', { ROLLBACK_VERSION: '99' }],
    ['rollback: already at that version', 'rollback', { ROLLBACK_VERSION: '2' }],
    ['unlisted deployment id', 'deploy', { SBV_DEPLOYMENT_ID: 'AKfycbxNOTLISTED000000' }],
    ['duplicate/HEAD deployment id', 'deploy', { SBV_DEPLOYMENT_ID: 'HEADID' }],
    ['credential has no default user', 'deploy', { SBV_CLASPRC_JSON: JSON.stringify({ tokens: { other: {} } }) }]
  ];
  for (const [name, mode, env] of cases) {
    const t = setup();
    const r = t.run(mode, env);
    assert.notEqual(r.status, 0, name);
    assert.doesNotMatch(r.stdout, /Preflight passed/, name);
    assert.ok(!written(t), name);
    assert.ok(!t.calls().includes('WRITE_BEFORE_PREFLIGHT'), name);
    noLeak(r);
  }
});

test('invalid rollback/SHA inputs stop before any clasp call or credential file (fail fast)', () => {
  for (const [mode, env] of [['rollback', { ROLLBACK_VERSION: 'abc' }], ['rollback', { ROLLBACK_VERSION: '0' }], ['rollback', { ROLLBACK_VERSION: '' }],
    ['deploy', { GITHUB_SHA: 'not-a-sha' }], ['deploy', { GITHUB_SHA: 'A'.repeat(40) }], ['deploy', { GITHUB_SHA: 'a'.repeat(39) }]]) {
    const t = setup();
    const before = JSON.stringify(t.read());
    const r = t.run(mode, env);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.deepEqual(t.calls(), [], 'clasp was not called');
    assert.equal(JSON.stringify(t.read()), before);
    assert.deepEqual(fs.readdirSync(t.tmp), [], 'no credential/work file was created');
  }
});

test('post-update description must match exactly: extra text is UNKNOWN_STATE, never success, and nothing is re-run', () => {
  for (const suffix of [' extra', '; previous main ' + 'c'.repeat(40)]) {
    const t = setup();
    const r = t.run('deploy', { FAKE_DESC_SUFFIX: suffix });
    assert.notEqual(r.status, 0, suffix);
    assert.match(r.stderr, /UNKNOWN_STATE/);
    assert.equal(t.calls().filter((c) => c === 'update-deployment').length, 1, 'no automatic re-update');
    assert.equal(t.calls().filter((c) => c === 'push').length, 1, 'no automatic re-push');
    noLeak(r);
  }
  assert.equal(setup().run('deploy').status, 0, 'the exact description still succeeds');
});

test('lib.descriptionMatches: exact only (surrounding whitespace tolerated), never a substring', () => {
  const d = 'main ' + SHA40;
  assert.equal(lib.descriptionMatches(d, d), true);
  assert.equal(lib.descriptionMatches('  ' + d + ' \n', d), true);
  for (const bad of [d + ' extra', 'previous ' + d, 'rollback of ' + d, 'main ' + 'b'.repeat(40) + ' ' + d, d + '0', '', 'main']) {
    assert.equal(lib.descriptionMatches(bad, d), false, bad);
  }
});

test('the verify deploy stays separate: no Access/Booking secrets, no deletion of the old entry, workflow unchanged in triggers and approvals', () => {
  assert.doesNotMatch(wf + scriptText, /SWITCHBOT_ACCESS|SBA_|SBAT_|BOOKING_|CLASPRC_JSON: \$\{\{ secrets\.CLASPRC/);
  assert.match(wf, /environment: switchbot-verify/);
  assert.match(wf, /concurrency:\n  group: switchbot-verify-gas-deploy\n  cancel-in-progress: false/);
  assert.match(wf, /on:\n  push:/);
  assert.ok(fs.existsSync(path.join(root, '.github/workflows/switchbot-verify-gas-deploy.yml')), 'the old entry is kept (removal is a separate decision)');
});
