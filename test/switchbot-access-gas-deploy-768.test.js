'use strict';
/*
 * Issue #768: 鍵管理用・独立GASの自動デプロイ。workflowの静的検査と、偽のclaspを使ったスクリプトの
 * 振る舞い検査（実GAS・実API・実Spreadsheetへは一切接続しない）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('../scripts/switchbot-access-gas-deploy-lib.js');
const prepare = require('../scripts/prepare-switchbot-access-gas-project.js');

const root = path.resolve(__dirname, '..');
const wfPath = path.join(root, '.github/workflows/switchbot-access-gas-deploy.yml');
const wf = fs.readFileSync(wfPath, 'utf8');
const script = path.join(root, 'scripts/deploy-switchbot-access-gas.sh');
const scriptText = fs.readFileSync(script, 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const libText = fs.readFileSync(path.join(root, 'scripts/switchbot-access-gas-deploy-lib.js'), 'utf8');

// ---- workflow 静的検査 ----
test('workflow: main push (target paths) + workflow_dispatch only; no PR/fork/schedule trigger', () => {
  const on = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\npermissions:'));
  assert.match(on, /push:\n\s+branches:\n\s+- main\n\s+paths:/);
  assert.match(on, /workflow_dispatch:/);
  assert.doesNotMatch(on, /pull_request|schedule:|pull_request_target/);
});

test('workflow: push paths equal the lib TARGET_PATHS and cover the shared snapshot, prepare script and itself', () => {
  const on = wf.slice(wf.indexOf('\n    paths:\n'), wf.indexOf('\n  workflow_dispatch:'));
  const paths = [...on.matchAll(/^\s+- '([^']+)'$/gm)].map((m) => m[1]);
  const normalized = paths.map((p) => p.replace(/\/\*\*$/, ''));
  assert.deepEqual(normalized.sort(), lib.TARGET_PATHS.slice().sort());
  for (const must of ['gas/switchbot-access/**', 'gas/booking/shared/AccessKeySnapshot.gs',
    'scripts/prepare-switchbot-access-gas-project.js', '.github/workflows/switchbot-access-gas-deploy.yml']) {
    assert.ok(paths.includes(must), must);
  }
  assert.ok(!paths.some((p) => /docs|README|\.md$|test\//.test(p)), 'docs/README/tests alone must not deploy');
});

test('workflow: only the deploy/rollback jobs use the dedicated environment; test and gate have no environment/secrets', () => {
  assert.equal((wf.match(/^\s+environment: switchbot-access-production$/gm) || []).length, 2);
  assert.doesNotMatch(wf, /environment: (?!switchbot-access-production)/);
  const wfCode = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(wfCode, /switchbot-verify|SWITCHBOT_VERIFY|booking-production|BOOKING_|SBV_/);
  for (const [from, to] of [['\n  gate:', '\n  test:'], ['\n  test:', '\n  deploy:']]) {
    const job = wf.slice(wf.indexOf(from), wf.indexOf(to));
    assert.doesNotMatch(job, /environment:|secrets\./);
  }
  assert.match(wf, /\n    needs: \[gate, test\]\n/);
});

test('workflow: every job is main-only; deploy/rollback also require the explicit stage gate', () => {
  const ifs = wf.match(/^\s+if: github\.ref == 'refs\/heads\/main'.*$/gm) || [];
  assert.equal(ifs.length, 4, 'gate, test, deploy, rollback');
  assert.equal((wf.match(/needs\.gate\.outputs\.enabled == 'true'/g) || []).length, 2);
  assert.match(wf, /vars\.SWITCHBOT_ACCESS_AUTODEPLOY/);
  assert.match(wf, /vars\.SWITCHBOT_ACCESS_EXECUTOR_CONFIRMED/);
});

test('workflow: dedicated serialized concurrency group, never cancels', () => {
  assert.match(wf, /concurrency:\n  group: switchbot-access-gas-deploy\n  cancel-in-progress: false\n/);
});

test('workflow: secrets only on deploy/rollback steps, minimal permissions, pinned clasp, nothing leaks via artifacts', () => {
  assert.match(wf, /permissions:\n  contents: read\n/);
  assert.equal((wf.match(/secrets\./g) || []).length, 6);
  assert.doesNotMatch(wf, /^env:/m);
  assert.match(wf, /@google\/clasp@3\.4\.1/);
  assert.doesNotMatch(wf, /@google\/clasp@(?!3\.4\.1)/);
  assert.doesNotMatch(wf, /actions\/(upload-artifact|cache)|set -x|xtrace|ACTIONS_STEP_DEBUG/);
});

test('workflow: freshness check covers the shared snapshot via TARGET_PATHS; rollback needs a compatibility confirmation', () => {
  assert.match(wf, /target-paths/);
  assert.match(wf, /git diff --quiet "\$GITHUB_SHA" FETCH_HEAD -- "\$\{target_paths\[@\]\}"/);
  assert.match(wf, /rollback_compat_confirmed:/);
  assert.match(wf, /ROLLBACK_COMPAT_CONFIRMED: \$\{\{ inputs\.rollback_compat_confirmed \}\}/);
});

test('workflow/script: never touch properties, triggers, webhooks or the SwitchBot API; never create/delete deployments', () => {
  for (const text of [wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), scriptText, libText]) {
    assert.doesNotMatch(text, /create-deployment|delete-deployment|clasp[ \t]+run|clasp[ \t]+deploy|\bdeploy\b +-|set -x|set -o xtrace/);
    assert.doesNotMatch(text, /createKey|deleteKey|setupWebhook|accessInstallTriggers|accessRemoveTriggers|accessSyncJob|ACCESS_ENABLED\s*=|setProperty|api\.switch-bot\.com/);
  }
  assert.match(scriptText, /trap cleanup EXIT/);
  assert.doesNotMatch(scriptText, /cat "\$out\/(list|versions|push|update|pull)[^"]*"\s*$/m);
});

// ---- 配布対象の完全性 ----
test('bundle: lib BUNDLE_FILES equals prepare output and the real bundle passes the check', () => {
  assert.deepEqual(lib.BUNDLE_FILES.slice().sort(), prepare.fileNames().slice().sort());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-bundle-'));
  prepare.prepareProject(dir);
  assert.equal(lib.checkBundle(dir), 'OK');
  const names = fs.readdirSync(dir);
  for (const required of ['SwitchBotAccessCore.gs', 'SwitchBotAccessInfra.gs', 'SwitchBotAccessApp.gs', 'AccessLedgerReader.gs', 'AccessKeySnapshot.gs', 'appsscript.json']) {
    assert.ok(names.includes(required), required);
  }
  assert.ok(!names.some((n) => /^(Booking|Survey|SwitchBotVerify)|\.test\.|\.log$|\.env|clasp/i.test(n)), 'no Booking/test/log/secret files');
});

test('bundle: extra, missing, empty or mis-configured files are rejected', () => {
  const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-b2-')); prepare.prepareProject(d); return d; };
  let d = fresh(); fs.writeFileSync(path.join(d, 'BookingCore.gs'), 'x');
  assert.equal(lib.checkBundle(d), 'BUNDLE_FILE_SET_MISMATCH');
  d = fresh(); fs.writeFileSync(path.join(d, '.clasprc.json'), '{}');
  assert.equal(lib.checkBundle(d), 'BUNDLE_FILE_SET_MISMATCH');
  d = fresh(); fs.writeFileSync(path.join(d, 'x.test.js'), '');
  assert.equal(lib.checkBundle(d), 'BUNDLE_FILE_SET_MISMATCH');
  d = fresh(); fs.rmSync(path.join(d, 'AccessKeySnapshot.gs'));
  assert.equal(lib.checkBundle(d), 'BUNDLE_FILE_SET_MISMATCH');
  d = fresh(); fs.writeFileSync(path.join(d, 'AccessLedgerReader.gs'), '  \n');
  assert.equal(lib.checkBundle(d), 'BUNDLE_FILE_EMPTY');
  d = fresh(); fs.writeFileSync(path.join(d, 'appsscript.json'), JSON.stringify({ webapp: { executeAs: 'USER_ACCESSING' } }));
  assert.equal(lib.checkBundle(d), 'BUNDLE_MANIFEST_INVALID');
});

test('bundle: the manifest requests no write scope and keeps executeAs=USER_DEPLOYING', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'gas/switchbot-access/appsscript.json'), 'utf8'));
  assert.equal(m.webapp.executeAs, 'USER_DEPLOYING');
  assert.ok(!m.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets'));
});

// ---- lib ----
test('lib.checkGate: unset disables; invalid or unconfirmed executor stops safely; only explicit values enable', () => {
  assert.equal(lib.checkGate('', ''), 'DISABLED');
  assert.equal(lib.checkGate(undefined, 'true'), 'DISABLED');
  assert.equal(lib.checkGate('yes', 'true'), 'INVALID_GATE_VALUE');
  assert.equal(lib.checkGate('FLAG_OFF', ''), 'EXECUTOR_NOT_CONFIRMED');
  assert.equal(lib.checkGate('FLAG_OFF', 'false'), 'EXECUTOR_NOT_CONFIRMED');
  assert.equal(lib.checkGate('FLAG_OFF', 'true'), 'ENABLED');
  assert.equal(lib.checkGate('FLAG_ON_APPROVED', 'true'), 'ENABLED');
});

test('lib.checkRemoteTarget: needs the access GAS, rejects Booking/Survey/verify projects, accepts the shared snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-r-'));
  assert.equal(lib.checkRemoteTarget(dir), 'TARGET_MISMATCH_NO_SWITCHBOT_ACCESS');
  fs.writeFileSync(path.join(dir, 'SwitchBotAccessApp.gs'), '');
  assert.equal(lib.checkRemoteTarget(dir), 'TARGET_MISMATCH_NO_SWITCHBOT_ACCESS');
  fs.writeFileSync(path.join(dir, 'SwitchBotAccessCore.gs'), '');
  fs.writeFileSync(path.join(dir, 'AccessKeySnapshot.gs'), '');
  assert.equal(lib.checkRemoteTarget(dir), 'OK');
  fs.writeFileSync(path.join(dir, 'SwitchBotVerify.gs'), '');
  assert.equal(lib.checkRemoteTarget(dir), 'TARGET_MISMATCH_OTHER_PROJECT');
  fs.rmSync(path.join(dir, 'SwitchBotVerify.gs'));
  fs.writeFileSync(path.join(dir, 'BookingX.gs'), '');
  assert.equal(lib.checkRemoteTarget(dir), 'TARGET_MISMATCH_OTHER_PROJECT');
});

test('lib.pickDeployment / checkManifest / checkCredential / describeVersion', () => {
  const rows = [{ deploymentId: 'A', versionNumber: 3, description: 'main x' }, { deploymentId: 'B' }];
  assert.deepEqual(lib.pickDeployment(JSON.stringify(rows), 'A'), { versionNumber: 3, description: 'main x' });
  assert.equal(lib.pickDeployment(JSON.stringify(rows), 'B').error, 'DEPLOYMENT_NOT_VERSIONED');
  assert.equal(lib.pickDeployment(JSON.stringify(rows), 'Z').error, 'DEPLOYMENT_ID_NOT_FOUND');
  assert.equal(lib.pickDeployment(JSON.stringify([rows[0], rows[0]]), 'A').error, 'DEPLOYMENT_ID_NOT_UNIQUE');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-m-'));
  const w = (n, o) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  const base = { webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' }, oauthScopes: ['a'] };
  assert.equal(lib.checkManifest(w('r1', base), w('p1', base)), 'OK');
  assert.equal(lib.checkManifest(w('r2', { ...base, webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_ACCESSING' } }), w('p2', base)), 'MANIFEST_WEBAPP_MISMATCH');
  assert.equal(lib.checkManifest(w('r3', base), w('p3', { ...base, oauthScopes: ['a', 'b'] })), 'MANIFEST_NEW_OAUTH_SCOPE_REQUIRES_MANUAL_APPROVAL');
  assert.equal(lib.checkCredential('{'), 'CREDENTIAL_NOT_JSON');
  assert.equal(lib.checkCredential('{"tokens":{}}'), 'CREDENTIAL_USER_MISSING');
  assert.equal(lib.describeVersion(JSON.stringify([{ versionNumber: 2, description: 'main <abc> $(x)\n12' }]), 2), 'main abc x12');
  assert.equal(lib.describeVersion(JSON.stringify([]), 2), '-');
});

// ---- script with a fake clasp ----
const SECRET = 'SECRETSCRIPTID1234567890';
const DEPLOY = 'AKfycbxDEPLOYMENTSECRET99999';
const TOKEN = 'refresh-token-DONOTLEAK';
const SHA = 'a'.repeat(40);

function fakeClasp(binDir) {
  const js = `#!/usr/bin/env node
const fs=require('fs');
const S=process.env.FAKE_STATE, a=process.argv.slice(2).filter((x,i,arr)=>!(x==='--auth'||arr[i-1]==='--auth'||x==='--user'||arr[i-1]==='--user'));
const cmd=a[0]; const st=()=>JSON.parse(fs.readFileSync(S+'/state.json','utf8')); const save=(s)=>fs.writeFileSync(S+'/state.json',JSON.stringify(s));
fs.appendFileSync(S+'/calls.log', cmd+'\\n');
const fail=process.env.FAKE_FAIL||''; if(fail===cmd){console.error('boom '+process.env.FAKE_LEAK);process.exit(1);}
const s=st();
const cfg=JSON.parse(fs.readFileSync('.clasp.json','utf8')); const ext=(cfg.scriptExtensions&&cfg.scriptExtensions[0])||'js';
if(cmd==='pull'){for(const [n,c] of Object.entries(s.files))fs.writeFileSync(n.endsWith('.gs')?n.slice(0,-3)+'.'+ext:n,c);}
else if(cmd==='push'){s.files={};for(const n of fs.readdirSync('.'))if(n.endsWith('.gs')||n==='appsscript.json')s.files[n]=fs.readFileSync(n,'utf8'); save(s);}
else if(cmd==='list-deployments'){console.log(JSON.stringify(s.deployments));}
else if(cmd==='list-versions'){console.log(JSON.stringify(s.versions));}
else if(cmd==='update-deployment'){
  const id=a[1]; const vi=a.indexOf('-V'); const di=a.indexOf('--description');
  if(fail==='update-silent'){process.exit(1);}
  if(fail==='update-moves-elsewhere'){const d0=s.deployments.find(x=>x.deploymentId===id); d0.versionNumber=1; save(s); process.exit(1);}
  let v; if(vi>=0)v=Number(a[vi+1]); else{v=Math.max(...s.versions.map(x=>x.versionNumber))+1;s.versions.push({versionNumber:v,description:a[di+1]});}
  const d=s.deployments.find(x=>x.deploymentId===id); d.versionNumber=v; d.description=a[di+1];
  save(s); if(fail==='update-apply-then-error'){process.exit(1);}
}`;
  fs.writeFileSync(path.join(binDir, 'clasp'), js, { mode: 0o755 });
}

const oldFiles = () => {
  const files = {};
  for (const n of prepare.fileNames()) files[n] = '// old ' + n;
  files['appsscript.json'] = fs.readFileSync(path.join(root, 'gas/switchbot-access/appsscript.json'), 'utf8');
  return files;
};

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-e2e-'));
  const bin = path.join(dir, 'bin'); const state = path.join(dir, 'state'); const tmp = path.join(dir, 'tmp');
  [bin, state, tmp].forEach((d) => fs.mkdirSync(d));
  fakeClasp(bin);
  fs.writeFileSync(path.join(state, 'state.json'), JSON.stringify({
    files: overrides.files || oldFiles(),
    versions: [{ versionNumber: 1, description: 'one' }, { versionNumber: 2, description: 'main ' + 'b'.repeat(40) }],
    deployments: [{ deploymentId: DEPLOY, versionNumber: 2, description: 'main old' }, { deploymentId: 'HEADID' }]
  }));
  const summary = path.join(dir, 'summary.md');
  const run = (mode, env = {}) => spawnSync('bash', [script, mode], {
    encoding: 'utf8',
    env: {
      PATH: bin + path.delimiter + process.env.PATH, HOME: dir, FAKE_STATE: state, FAKE_LEAK: SECRET,
      RUNNER_TEMP: tmp, GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, GITHUB_STEP_SUMMARY: summary,
      GITHUB_RUN_ID: '1', SBA_RETRY_DELAY_SECONDS: '0', SBA_CLASPRC_JSON: JSON.stringify({ tokens: { default: { refresh_token: TOKEN } } }),
      SBA_SCRIPT_ID: SECRET, SBA_DEPLOYMENT_ID: DEPLOY, ROLLBACK_COMPAT_CONFIRMED: 'true', ...env
    }
  });
  const read = () => JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
  const calls = () => fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean);
  return { run, read, calls, tmp, summary, state };
}
const noLeak = (r) => {
  const all = (r.stdout + r.stderr).replace(/^::add-mask::.*$/gm, '');
  for (const v of [SECRET, DEPLOY, TOKEN]) assert.ok(!all.includes(v), 'secret value leaked');
};
const deployedVersion = (t) => t.read().deployments.find((x) => x.deploymentId === DEPLOY).versionNumber;

test('deploy: assembles the bundle, pushes, verifies source, updates the SAME deployment; cleans up; summary is non-secret', () => {
  const t = setup();
  const r = t.run('deploy');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = t.read();
  assert.equal(s.deployments.length, 2, 'no deployment created/deleted');
  const d = s.deployments.find((x) => x.deploymentId === DEPLOY);
  assert.equal(d.versionNumber, 3);
  assert.equal(d.description, 'main ' + SHA);
  assert.deepEqual(Object.keys(s.files).sort(), prepare.fileNames().slice().sort());
  assert.equal(s.files['AccessKeySnapshot.gs'], fs.readFileSync(path.join(root, 'gas/booking/shared/AccessKeySnapshot.gs'), 'utf8'));
  noLeak(r);
  assert.deepEqual(fs.readdirSync(t.tmp), [], 'auth/work files removed');
  const sum = fs.readFileSync(t.summary, 'utf8');
  assert.match(sum, /@2.*@3/);
  assert.match(sum, new RegExp(SHA));
  assert.match(sum, /デプロイ方式/);
  assert.match(sum, /ACCESS_ENABLED.*未操作/);
  for (const v of [SECRET, DEPLOY, TOKEN]) assert.ok(!sum.includes(v));
  assert.ok(!t.calls().some((c) => !['pull', 'push', 'list-deployments', 'list-versions', 'update-deployment'].includes(c)), 'only allowed clasp commands');
});

test('deploy: missing secrets or malformed SHA fail before anything is touched', () => {
  let t = setup();
  let r = t.run('deploy', { SBA_DEPLOYMENT_ID: '' });
  assert.notEqual(r.status, 0);
  assert.equal(deployedVersion(t), 2);
  noLeak(r);
  t = setup();
  r = t.run('deploy', { GITHUB_SHA: 'main' });
  assert.notEqual(r.status, 0);
  assert.equal(deployedVersion(t), 2);
});

test('deploy: authentication failure (bad credential JSON / clasp login failure) stops safely without leaking', () => {
  let t = setup();
  let r = t.run('deploy', { SBA_CLASPRC_JSON: 'not-json-' + TOKEN });
  assert.notEqual(r.status, 0);
  assert.equal(t.read().files['SwitchBotAccessApp.gs'], '// old SwitchBotAccessApp.gs');
  noLeak(r);
  t = setup();
  r = t.run('deploy', { FAKE_FAIL: 'list-deployments' });
  assert.notEqual(r.status, 0);
  assert.equal(deployedVersion(t), 2);
  assert.ok(!t.calls().includes('push') && !t.calls().includes('update-deployment'));
  noLeak(r);
});

test('deploy: unknown deployment id / @HEAD id / other project (Booking, verify GAS) fail without changes', () => {
  let t = setup();
  let r = t.run('deploy', { SBA_DEPLOYMENT_ID: 'NOPE' });
  assert.notEqual(r.status, 0);
  assert.ok(!t.calls().includes('push'));
  t = setup();
  r = t.run('deploy', { SBA_DEPLOYMENT_ID: 'HEADID' });
  assert.notEqual(r.status, 0);
  assert.ok(!t.calls().includes('push'));
  for (const extra of ['BookingFoo.gs', 'SwitchBotVerify.gs']) {
    t = setup({ files: { ...oldFiles(), [extra]: '' } });
    r = t.run('deploy');
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /TARGET_MISMATCH_OTHER_PROJECT/);
    assert.ok(!t.calls().includes('push'));
    assert.equal(deployedVersion(t), 2);
    noLeak(r);
  }
  const verifyOnly = { 'SwitchBotVerify.gs': '// verify', 'appsscript.json': oldFiles()['appsscript.json'] };
  t = setup({ files: verifyOnly });
  r = t.run('deploy');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /TARGET_MISMATCH_NO_SWITCHBOT_ACCESS/);
  assert.ok(!t.calls().includes('push'));
});

test('deploy: a manifest that differs in web app execution settings stops before push', () => {
  const files = oldFiles();
  const m = JSON.parse(files['appsscript.json']); m.webapp.executeAs = 'USER_ACCESSING';
  files['appsscript.json'] = JSON.stringify(m);
  const t = setup({ files });
  const r = t.run('deploy');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MANIFEST_WEBAPP_MISMATCH/);
  assert.ok(!t.calls().includes('push'));
});

test('deploy: push failure leaves the published deployment unchanged and leaks nothing', () => {
  const t = setup();
  const r = t.run('deploy', { FAKE_FAIL: 'push' });
  assert.notEqual(r.status, 0);
  assert.equal(deployedVersion(t), 2);
  assert.ok(!t.calls().includes('update-deployment'));
  noLeak(r);
});

test('deploy: update failure with no change is NOT applied (not success); update is never retried', () => {
  const t = setup();
  const r = t.run('deploy', { FAKE_FAIL: 'update-silent' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NOT applied/);
  assert.equal(deployedVersion(t), 2);
  assert.equal(t.calls().filter((c) => c === 'update-deployment').length, 1);
  noLeak(r);
});

test('deploy: unexpected mid-way state is UNKNOWN_STATE (failure, no blind re-run)', () => {
  const t = setup();
  const r = t.run('deploy', { FAKE_FAIL: 'update-moves-elsewhere' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /UNKNOWN_STATE/);
  assert.equal(t.calls().filter((c) => c === 'update-deployment').length, 1);
});

test('deploy: update that applied but returned an error is reconciled by reads (success)', () => {
  const t = setup();
  const r = t.run('deploy', { FAKE_FAIL: 'update-apply-then-error' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(deployedVersion(t), 3);
});

test('deploy: two sequential runs (double execution) each create exactly one new version on the same deployment', () => {
  const t = setup();
  assert.equal(t.run('deploy').status, 0);
  assert.equal(t.run('deploy', { GITHUB_SHA: 'c'.repeat(40) }).status, 0);
  const s = t.read();
  assert.equal(s.deployments.length, 2);
  assert.equal(deployedVersion(t), 4);
});

test('rollback: same deployment goes back to an existing version; invalid/unknown/duplicate/unconfirmed are refused', () => {
  const t = setup();
  assert.equal(t.run('deploy').status, 0);
  const before = JSON.stringify(t.read().files);
  const r = t.run('rollback', { ROLLBACK_VERSION: '2' });
  assert.equal(r.status, 0, r.stderr);
  const s = t.read();
  assert.equal(s.deployments.length, 2);
  assert.equal(deployedVersion(t), 2);
  assert.equal(JSON.stringify(s.files), before, 'rollback does not push or modify source');
  const sum = fs.readFileSync(t.summary, 'utf8');
  assert.match(sum, /ロールバック先.*@2/);
  assert.match(sum, /互換性確認/);
  noLeak(r);
  assert.notEqual(t.run('rollback', { ROLLBACK_VERSION: '99' }).status, 0, 'unknown version');
  assert.notEqual(t.run('rollback', { ROLLBACK_VERSION: 'abc' }).status, 0);
  assert.notEqual(t.run('rollback', { ROLLBACK_VERSION: '2' }).status, 0, 'already at that version');
  const t2 = setup();
  const r2 = t2.run('rollback', { ROLLBACK_VERSION: '1', ROLLBACK_COMPAT_CONFIRMED: 'false' });
  assert.notEqual(r2.status, 0);
  assert.equal(deployedVersion(t2), 2);
  assert.ok(!t2.calls().includes('update-deployment'));
});

test('rollback: verifies the target project first; Booking/verify/other projects are never updated', () => {
  const verifyOnly = { 'SwitchBotVerify.gs': '// verify', 'appsscript.json': oldFiles()['appsscript.json'] };
  for (const files of [verifyOnly, { ...oldFiles(), 'BookingFoo.gs': '' }, { ...oldFiles(), 'SwitchBotVerify.gs': '' }]) {
    const t = setup({ files });
    const r = t.run('rollback', { ROLLBACK_VERSION: '1' });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /TARGET_MISMATCH/);
    assert.ok(!t.calls().includes('update-deployment'));
    assert.equal(deployedVersion(t), 2);
    noLeak(r);
  }
});

test('rollback: a remote manifest with different web app settings is refused before any update', () => {
  const files = oldFiles();
  const m = JSON.parse(files['appsscript.json']); m.webapp.access = 'MYSELF';
  files['appsscript.json'] = JSON.stringify(m);
  const t = setup({ files });
  const r = t.run('rollback', { ROLLBACK_VERSION: '1' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MANIFEST_WEBAPP_MISMATCH/);
  assert.ok(!t.calls().includes('update-deployment'));
  const t2 = setup({ files: { 'SwitchBotAccessApp.gs': '', 'SwitchBotAccessCore.gs': '' } });
  const r2 = t2.run('rollback', { ROLLBACK_VERSION: '1' });
  assert.notEqual(r2.status, 0, 'missing manifest fails closed');
  assert.ok(!t2.calls().includes('update-deployment'));
});

test('rollback: a failed update that did not apply is reported as failure', () => {
  const t = setup();
  const r = t.run('rollback', { ROLLBACK_VERSION: '1', FAKE_FAIL: 'update-silent' });
  assert.notEqual(r.status, 0);
  assert.equal(deployedVersion(t), 2);
  noLeak(r);
});

test('write-config pins scriptExtensions to gs (clasp 3.x pulls .js by default) and gate command works end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-cfg-'));
  const libFile = path.join(root, 'scripts/switchbot-access-gas-deploy-lib.js');
  const r = spawnSync('node', [libFile, 'write-config', path.join(dir, 'a.json'), dir, 'x'],
    { env: { ...process.env, SBA_CLASPRC_JSON: '{}', SBA_SCRIPT_ID: 'S' } });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.clasp.json'), 'utf8')).scriptExtensions, ['gs']);
  assert.equal(spawnSync('node', [libFile, 'gate', '', '']).stdout.toString().trim(), 'DISABLED');
  assert.equal(spawnSync('node', [libFile, 'gate', 'FLAG_OFF', '']).status, 1);
  assert.equal(spawnSync('node', [libFile, 'gate', 'FLAG_OFF', 'true']).stdout.toString().trim(), 'ENABLED');
});
