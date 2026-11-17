'use strict';
/*
 * Issue #936: 運営アプリ専用GASのActions手動デプロイ。workflowの静的検査と、偽のclaspを使ったスクリプトの
 * 振る舞い検査（実GAS・実API・実Spreadsheetへは一切接続しない。値はすべて架空）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('../scripts/ops-reservations-gas-deploy-lib.js');
const prepare = require('../scripts/prepare-ops-reservations-gas-project.js');

const root = path.resolve(__dirname, '..');
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const wf = fs.readFileSync(path.join(root, '.github/workflows/ops-reservations-gas-deploy.yml'), 'utf8');
const wfCode = stripComments(wf);
const script = path.join(root, 'scripts/deploy-ops-reservations-gas.sh');
const scriptText = stripComments(fs.readFileSync(script, 'utf8'));
const libText = fs.readFileSync(path.join(root, 'scripts/ops-reservations-gas-deploy-lib.js'), 'utf8');
const libFile = path.join(root, 'scripts/ops-reservations-gas-deploy-lib.js');

// ---- workflow 静的検査 ----
test('workflow: workflow_dispatch is the ONLY trigger; no push/PR/schedule; the only input is the optional rollback_version', () => {
  const on = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\npermissions:'));
  assert.match(on, /\non:\n  workflow_dispatch:/);
  assert.doesNotMatch(on, /\n  (push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|release):/);
  assert.doesNotMatch(on, /paths:|branches:/);
  const inputs = on.slice(on.indexOf('    inputs:\n'));
  assert.deepEqual([...inputs.matchAll(/^      (\w+):$/gm)].map((m) => m[1]), ['rollback_version']);
  assert.match(inputs, /rollback_version:[\s\S]*?required: false\n\s+type: string\n\s+default: ''/);
  assert.doesNotMatch(inputs, /required: true/, 'normal update must need no input');
});

test('workflow: gate is main-only, takes inputs via env, checks the main head and runs before any secret', () => {
  const gate = wf.slice(wf.indexOf('\n  verify:'), wf.indexOf('\n  deploy:'));
  assert.doesNotMatch(gate, /environment:|secrets\./);
  assert.match(gate, /ops-reservations-gas-deploy-lib\.js dispatch-gate/);
  for (const v of ['DG_EVENT', 'DG_REF', 'DG_ROLLBACK_VERSION']) assert.match(gate, new RegExp(v + ': \\$\\{\\{ (inputs|github)\\.'), v);
  const run = gate.slice(gate.indexOf('run: |'), gate.indexOf('- name: Frontend'));
  assert.doesNotMatch(run, /\$\{\{/, 'inputs must never be expanded inside the script body');
  assert.match(run, /STALE_SHA_NOT_MAIN_HEAD/);
  assert.match(run, /git rev-parse FETCH_HEAD\)" == "\$GITHUB_SHA"/);
  // フロント生成物の同期 → テスト → 配布物検査 は秘密なしのjobで、deploy前に行う
  assert.match(gate, /build-ops-gas-page\.js --check/);
  assert.match(gate, /node --test test\/ops-\*\.test\.js/);
  assert.match(gate, /check-bundle/);
});

test('workflow: deploy job needs verify, main only, one dedicated environment and exactly 3 dedicated secrets', () => {
  const dep = wf.slice(wf.indexOf('\n  deploy:'));
  assert.match(dep, /needs: verify\n/);
  assert.match(dep, /needs\.verify\.outputs\.valid == 'true' && github\.ref == 'refs\/heads\/main'/);
  assert.match(dep, /\n    environment: ops-reservations-production\n/);
  assert.equal((wf.match(/^\s+environment: /gm) || []).length, 1);
  const secrets = [...wf.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)].sort(), ['OPS_RESERVATIONS_CLASPRC_JSON', 'OPS_RESERVATIONS_DEPLOYMENT_ID', 'OPS_RESERVATIONS_SCRIPT_ID']);
  assert.equal(secrets.length, 6, 'only the deploy and rollback steps receive secrets');
  // 既存業務のworkflow・Secrets・Environmentを使わない
  assert.doesNotMatch(wfCode, /SWITCHBOT|BOOKING|SURVEY|SBA_|SBV_|switchbot-access|switchbot-verify|booking-production|\bvars\./i);
});

test('workflow: dedicated serialized concurrency, minimal permissions, pinned clasp, no artifacts, no debug', () => {
  assert.match(wf, /concurrency:\n  group: ops-reservations-gas-deploy\n  cancel-in-progress: false\n/);
  assert.match(wf, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(wf, /^env:/m);
  assert.match(wf, /@google\/clasp@3\.4\.1/);
  assert.doesNotMatch(wf, /@google\/clasp@(?!3\.4\.1)/);
  assert.doesNotMatch(wf, /actions\/(upload-artifact|cache)|set -x|xtrace|ACTIONS_STEP_DEBUG/);
  assert.match(wf, /target-paths/);
  assert.match(wf, /git diff --quiet "\$GITHUB_SHA" FETCH_HEAD -- "\$\{target_paths\[@\]\}"/);
});

test('workflow/script/lib: never create projects/deployments, run functions, touch properties or business/key APIs', () => {
  for (const text of [wfCode, scriptText, stripComments(libText)]) {
    assert.doesNotMatch(text, /create-deployment|delete-deployment|clasp[ \t]+(run|create|deploy|login)|\bcreate-script\b|\bdeploy\b +-|set -x|set -o xtrace/);
    assert.doesNotMatch(text, /createKey|deleteKey|setupWebhook|setProperty|SCRIPT_PROPERTIES|api\.switch-bot\.com|stripe|UrlFetchApp/i);
  }
  assert.match(scriptText, /trap cleanup EXIT/);
  assert.doesNotMatch(scriptText, /cat "\$out\/(list|versions|push|update|pull)[^"]*"\s*$/m);
});

// ---- 配布対象の完全性 ----
test('bundle: lib BUNDLE_FILES equals prepare output and gas/ops-reservations; the real bundle passes and the page is in sync', () => {
  assert.deepEqual(lib.BUNDLE_FILES.slice().sort(), prepare.fileNames().slice().sort());
  assert.deepEqual(fs.readdirSync(path.join(root, 'gas/ops-reservations')).sort(), lib.BUNDLE_FILES.slice().sort(),
    'a new file in gas/ops-reservations must be added to the bundle deliberately');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-bundle-'));
  prepare.prepareProject(dir);
  assert.equal(lib.checkBundle(dir), 'OK');
  assert.equal(fs.readFileSync(path.join(dir, 'OpsPage.html'), 'utf8'), fs.readFileSync(path.join(root, 'gas/ops-reservations/OpsPage.html'), 'utf8'));
  assert.ok(!fs.readdirSync(dir).some((n) => /^(Booking|Survey|SwitchBot|Access)|\.test\.|\.log$|\.env|clasp/i.test(n)));
});

test('bundle/manifest: owner-only, read-only scopes, no dependencies; extras, missing or empty files are rejected', () => {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'gas/ops-reservations/appsscript.json'), 'utf8'));
  assert.deepEqual(m.webapp, { access: 'MYSELF', executeAs: 'USER_DEPLOYING' });
  assert.deepEqual(m.oauthScopes.slice().sort(), lib.APPROVED_SCOPES.slice().sort());
  assert.ok(!m.oauthScopes.some((s) => /auth\/(spreadsheets|drive|drive\.file|gmail\.\w+|script\.scriptapp|script\.send_mail|script\.container\.ui)$/.test(s)), 'no write/mail/trigger scope');
  const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-b2-')); prepare.prepareProject(d); return d; };
  let d = fresh(); fs.writeFileSync(path.join(d, 'BookingCore.gs'), 'x');
  assert.equal(lib.checkBundle(d), 'BUNDLE_FILE_SET_MISMATCH');
  d = fresh(); fs.rmSync(path.join(d, 'OpsApi.gs'));
  assert.equal(lib.checkBundle(d), 'BUNDLE_FILE_SET_MISMATCH');
  d = fresh(); fs.writeFileSync(path.join(d, 'OpsQuery.gs'), '  \n');
  assert.equal(lib.checkBundle(d), 'BUNDLE_FILE_EMPTY');
  const mutate = (fn) => { const dd = fresh(); const f = path.join(dd, 'appsscript.json'); const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j)); return dd; };
  assert.equal(lib.checkBundle(mutate((j) => { j.webapp.access = 'ANYONE_ANONYMOUS'; })), 'BUNDLE_MANIFEST_NOT_OWNER_ONLY');
  assert.equal(lib.checkBundle(mutate((j) => { j.webapp.executeAs = 'USER_ACCESSING'; })), 'BUNDLE_MANIFEST_NOT_OWNER_ONLY');
  assert.equal(lib.checkBundle(mutate((j) => { j.oauthScopes.push('https://www.googleapis.com/auth/spreadsheets'); })), 'BUNDLE_MANIFEST_SCOPE_NOT_APPROVED');
  assert.equal(lib.checkBundle(mutate((j) => { j.oauthScopes.pop(); })), 'BUNDLE_MANIFEST_SCOPE_NOT_APPROVED');
  assert.equal(lib.checkBundle(mutate((j) => { j.dependencies = { enabledAdvancedServices: [{ userSymbol: 'Sheets', serviceId: 'sheets', version: 'v4' }] }; })), 'BUNDLE_MANIFEST_HAS_DEPENDENCY');
});

// ---- 起動ゲート ----
test('gate: normal update needs no input; only main + manual dispatch; rollback_version must be a positive integer', () => {
  const ok = { event: 'workflow_dispatch', ref: 'refs/heads/main', rollbackVersion: '' };
  assert.equal(lib.checkDispatch(ok), 'OK');
  assert.equal(lib.checkDispatch({ ...ok, rollbackVersion: '7' }), 'OK');
  assert.equal(lib.checkDispatch({ ...ok, ref: 'refs/heads/claude/some-pr' }), 'BRANCH_NOT_MAIN');
  assert.equal(lib.checkDispatch({ ...ok, ref: 'refs/pull/1/merge' }), 'BRANCH_NOT_MAIN');
  assert.equal(lib.checkDispatch({ ...ok, event: 'push' }), 'NOT_MANUAL_DISPATCH');
  assert.equal(lib.checkDispatch({ ...ok, event: 'schedule' }), 'NOT_MANUAL_DISPATCH');
  for (const bad of ['0', '-1', '1.5', 'abc', '1; rm', '1234567', '07']) assert.equal(lib.checkDispatch({ ...ok, rollbackVersion: bad }), 'ROLLBACK_VERSION_INVALID', bad);
  const cli = (env) => spawnSync('node', [libFile, 'dispatch-gate'], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  assert.equal(cli({ DG_EVENT: 'workflow_dispatch', DG_REF: 'refs/heads/main', DG_ROLLBACK_VERSION: '' }).status, 0);
  assert.equal(cli({ DG_EVENT: 'workflow_dispatch', DG_REF: 'refs/heads/x', DG_ROLLBACK_VERSION: '' }).status, 1);
});

// ---- 対象の取り違え防止 ----
test('remote target: only the ops project (or an empty fresh project) is accepted; business projects are refused', () => {
  const mk = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-remote-')); for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c); return d; };
  const opsFiles = Object.fromEntries(lib.BUNDLE_FILES.map((n) => [n, '// old']));
  assert.equal(lib.checkRemoteTarget(mk(opsFiles)), 'OK');
  assert.equal(lib.checkRemoteTarget(mk({ 'OpsApi.gs': 'x', 'OpsAuth.gs': 'x', 'appsscript.json': '{}' })), 'OK');
  assert.equal(lib.checkRemoteTarget(mk({ 'Code.gs': 'function myFunction() {\n  \n}\n', 'appsscript.json': '{}' })), 'OK_PRISTINE');
  for (const extra of ['BookingCore.gs', 'SwitchBotAccessApp.gs', 'AccessKeySnapshot.gs', 'SurveyApp.gs', 'Webhook.gs', 'Code.gs']) {
    assert.equal(lib.checkRemoteTarget(mk({ ...opsFiles, [extra]: 'x' })), 'TARGET_MISMATCH_UNEXPECTED_FILES', extra);
  }
  assert.match(lib.checkRemoteTarget(mk({ 'BookingCore.gs': 'x', 'Code.gs': 'x', 'appsscript.json': '{}' })), /^TARGET_MISMATCH/);
  assert.match(lib.checkRemoteTarget(mk({ 'SwitchBotAccessApp.gs': 'x', 'SwitchBotAccessCore.gs': 'x', 'appsscript.json': '{}' })), /^TARGET_MISMATCH/);
  assert.match(lib.checkRemoteTarget(mk({ 'Code.gs': 'function doPost(e) { return 1; }', 'appsscript.json': '{}' })), /^TARGET_MISMATCH/, 'a non-stub Code.gs is not a fresh project');
  assert.match(lib.checkRemoteTarget(mk({ 'appsscript.json': '{}' })), /^TARGET_MISMATCH/);
  assert.match(lib.checkRemoteTarget(mk({})), /^TARGET_MISMATCH/);
});

test('manifest: remote webapp settings must match; remote with unapproved scopes is refused', () => {
  const bundle = path.join(root, 'gas/ops-reservations/appsscript.json');
  const base = JSON.parse(fs.readFileSync(bundle, 'utf8'));
  const check = (fn) => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-m-')), 'a.json'); const j = JSON.parse(JSON.stringify(base)); fn(j); fs.writeFileSync(f, JSON.stringify(j)); return lib.checkManifest(f, bundle); };
  assert.equal(check(() => {}), 'OK');
  assert.equal(check((j) => { j.oauthScopes = []; }), 'OK', 'fresh project without scopes (scopes are approved on first open)');
  assert.equal(check((j) => { j.webapp.access = 'ANYONE'; }), 'MANIFEST_WEBAPP_MISMATCH');
  assert.equal(check((j) => { j.webapp.executeAs = 'USER_ACCESSING'; }), 'MANIFEST_WEBAPP_MISMATCH');
  assert.equal(check((j) => { delete j.webapp; }), 'MANIFEST_WEBAPP_MISMATCH');
  assert.equal(check((j) => { j.oauthScopes.push('https://www.googleapis.com/auth/spreadsheets'); }), 'MANIFEST_REMOTE_UNAPPROVED_SCOPE');
  assert.equal(check((j) => { j.oauthScopes.push('https://www.googleapis.com/auth/gmail.send'); }), 'MANIFEST_REMOTE_UNAPPROVED_SCOPE');
});

test('lib: deployment pick is exact, unique and versioned; description match is exact', () => {
  const list = JSON.stringify([{ deploymentId: 'A', versionNumber: 3, description: 'main x' }, { deploymentId: 'HEAD1' }, { deploymentId: 'B', versionNumber: 1 }, { deploymentId: 'B', versionNumber: 2 }]);
  assert.deepEqual(lib.pickDeployment(list, 'A'), { versionNumber: 3, description: 'main x' });
  assert.equal(lib.pickDeployment(list, 'HEAD1').error, 'DEPLOYMENT_NOT_VERSIONED');
  assert.equal(lib.pickDeployment(list, 'B').error, 'DEPLOYMENT_ID_NOT_UNIQUE');
  assert.equal(lib.pickDeployment(list, 'Z').error, 'DEPLOYMENT_ID_NOT_FOUND');
  assert.equal(lib.pickDeployment(list, '').error, 'DEPLOYMENT_ID_NOT_FOUND');
  assert.equal(lib.pickDeployment('nope', 'A').error, 'LIST_PARSE_FAILED');
  assert.ok(lib.descriptionMatches(' main abc ', 'main abc'));
  assert.ok(!lib.descriptionMatches('x main abc', 'main abc'));
});

// ---- 偽のclaspでスクリプトの振る舞いを検査 ----
const SECRET = 'SECRETSCRIPTID1234567890';
const DEPLOY = 'AKfycbxDEPLOYMENTSECRET99999';
const TOKEN = 'refresh-token-DONOTLEAK';
const LEAK = 'FAKELEAK-owner@example.invalid';
const SHA = 'a'.repeat(40);

function fakeClasp(binDir) {
  const js = `#!/usr/bin/env node
const fs=require('fs');
const S=process.env.FAKE_STATE, a=process.argv.slice(2).filter((x,i,arr)=>!(x==='--auth'||arr[i-1]==='--auth'||x==='--user'||arr[i-1]==='--user'));
const cmd=a[0]; const st=()=>JSON.parse(fs.readFileSync(S+'/state.json','utf8')); const save=(s)=>fs.writeFileSync(S+'/state.json',JSON.stringify(s));
fs.appendFileSync(S+'/calls.log', cmd+'\\n');
const sumf=process.env.GITHUB_STEP_SUMMARY; const preflightDone=!!sumf&&fs.existsSync(sumf)&&fs.readFileSync(sumf,'utf8').includes('preflight');
if((cmd==='push'||cmd==='update-deployment')&&!preflightDone)fs.appendFileSync(S+'/calls.log','WRITE_BEFORE_PREFLIGHT\\n');
const fail=process.env.FAKE_FAIL||''; if(fail===cmd){console.error('boom '+process.env.FAKE_LEAK);process.exit(1);}
const s=st();
if(cmd==='pull'){for(const [n,c] of Object.entries(s.files))fs.writeFileSync(n,c);}
else if(cmd==='push'){s.files={};for(const n of fs.readdirSync('.'))if(n.endsWith('.gs')||n.endsWith('.html')||n==='appsscript.json')s.files[n]=fs.readFileSync(n,'utf8'); save(s);}
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

const manifestText = fs.readFileSync(path.join(root, 'gas/ops-reservations/appsscript.json'), 'utf8');
const oldFiles = () => {
  const files = {};
  for (const n of lib.BUNDLE_FILES) files[n] = '// old ' + n;
  files['appsscript.json'] = manifestText;
  return files;
};

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-e2e-'));
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
      PATH: bin + path.delimiter + process.env.PATH, HOME: dir, FAKE_STATE: state, FAKE_LEAK: LEAK,
      RUNNER_TEMP: tmp, GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, GITHUB_STEP_SUMMARY: summary,
      GITHUB_RUN_ID: '1', OPS_RETRY_DELAY_SECONDS: '0', OPS_CLASPRC_JSON: JSON.stringify({ tokens: { default: { refresh_token: TOKEN } } }),
      OPS_SCRIPT_ID: SECRET, OPS_DEPLOYMENT_ID: DEPLOY, ...env
    }
  });
  const read = () => JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
  const calls = () => (fs.existsSync(path.join(state, 'calls.log'))
    ? fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
  const sum = () => (fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '');
  return { run, read, calls, tmp, sum };
}
const noLeak = (r, t) => {
  const all = (r.stdout + r.stderr + (t ? t.sum() : '')).replace(/^::add-mask::.*$/gm, '');
  for (const v of [SECRET, DEPLOY, TOKEN, LEAK]) assert.ok(!all.includes(v), 'secret value leaked');
};
const deployedVersion = (t) => t.read().deployments.find((x) => x.deploymentId === DEPLOY).versionNumber;
const WRITES = ['push', 'update-deployment'];
const untouched = (t) => { assert.ok(!t.calls().some((c) => WRITES.includes(c)), 'no write call'); assert.equal(deployedVersion(t), 2); };

test('deploy: assembles the bundle, pushes, verifies source, updates the SAME deployment; cleans up; summary shows result/SHA/versions/time but no IDs', () => {
  const t = setup();
  const r = t.run('deploy');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = t.read();
  assert.equal(s.deployments.length, 2, 'no deployment created/deleted');
  const d = s.deployments.find((x) => x.deploymentId === DEPLOY);
  assert.equal(d.versionNumber, 3);
  assert.equal(d.description, 'main ' + SHA);
  assert.deepEqual(Object.keys(s.files).sort(), lib.BUNDLE_FILES.slice().sort());
  assert.equal(s.files['OpsPage.html'], fs.readFileSync(path.join(root, 'gas/ops-reservations/OpsPage.html'), 'utf8').replace(/\r\n/g, '\n'));
  assert.equal(s.files['OpsApi.gs'], fs.readFileSync(path.join(root, 'gas/ops-reservations/OpsApi.gs'), 'utf8'));
  noLeak(r, t);
  assert.deepEqual(fs.readdirSync(t.tmp), [], 'auth/work files removed');
  const sum = t.sum();
  assert.match(sum, /@2.*@3/);
  assert.match(sum, new RegExp(SHA));
  assert.match(sum, /処理日時: \d{4}-\d\d-\d\d \d\d:\d\d:\d\d JST/);
  assert.match(sum, /一度ブックマークしたURLがそのまま使えます/);
  assert.match(sum, /画面の実利用確認.*別/);
  assert.match(sum, /Script Properties.*未操作/);
  assert.ok(!t.calls().some((c) => !['pull', 'push', 'list-deployments', 'list-versions', 'update-deployment'].includes(c)), 'only allowed clasp commands');
  assert.ok(!t.calls().includes('WRITE_BEFORE_PREFLIGHT'));
  assert.ok(!/https?:\/\//.test(sum), 'no URL in the public summary');
});

test('deploy: a second run is idempotent for the URL (same deployment id, version advances again)', () => {
  const t = setup();
  assert.equal(t.run('deploy').status, 0);
  assert.equal(t.run('deploy').status, 0);
  assert.equal(deployedVersion(t), 4);
  assert.equal(t.read().deployments.length, 2);
});

test('deploy: first-time placement into an empty fresh project succeeds and is labelled', () => {
  const t = setup({ files: { 'Code.gs': 'function myFunction() {\n  \n}\n', 'appsscript.json': manifestText } });
  const r = t.run('deploy');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(Object.keys(t.read().files).sort(), lib.BUNDLE_FILES.slice().sort(), 'the stub is replaced by the bundle');
  assert.match(t.sum(), /初回配置/);
  noLeak(r, t);
});

test('deploy: missing secrets stop BEFORE anything is touched, never create a project/deployment, and say how to set up', () => {
  for (const missing of ['OPS_CLASPRC_JSON', 'OPS_SCRIPT_ID', 'OPS_DEPLOYMENT_ID']) {
    const t = setup();
    const r = t.run('deploy', { [missing]: '' });
    assert.notEqual(r.status, 0, missing);
    assert.deepEqual(t.calls(), [], 'clasp was never called: ' + missing);
    assert.match(t.sum(), /初回設定が未完了/);
    noLeak(r, t);
  }
  const t = setup();
  const r = t.run('deploy', { GITHUB_SHA: 'main' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(t.calls(), []);
});

test('deploy: authentication failure (bad credential JSON / clasp login failure) stops safely without leaking', () => {
  let t = setup();
  let r = t.run('deploy', { OPS_CLASPRC_JSON: 'not-json-' + TOKEN });
  assert.notEqual(r.status, 0);
  assert.deepEqual(t.calls(), []);
  noLeak(r, t);
  t = setup();
  r = t.run('deploy', { FAKE_FAIL: 'list-deployments' });
  assert.notEqual(r.status, 0);
  untouched(t);
  noLeak(r, t);
  t = setup();
  r = t.run('deploy', { FAKE_FAIL: 'pull' });
  assert.notEqual(r.status, 0);
  untouched(t);
  noLeak(r, t);
});

test('deploy: unknown deployment id / @HEAD id fail without changes', () => {
  for (const id of ['NOPE', 'HEADID']) {
    const t = setup();
    const r = t.run('deploy', { OPS_DEPLOYMENT_ID: id });
    assert.notEqual(r.status, 0, id);
    untouched(t);
    noLeak(r, t);
  }
});

test('deploy: a wrong target (Booking / Access / Survey / webhook project, or a project whose scopes are unapproved) is refused before any write', () => {
  const cases = {
    booking: { 'BookingCore.gs': 'x', 'appsscript.json': manifestText },
    access: { 'SwitchBotAccessApp.gs': 'x', 'SwitchBotAccessCore.gs': 'x', 'appsscript.json': manifestText },
    opsPlusBooking: { ...oldFiles(), 'BookingFoo.gs': 'x' },
    nonStubCode: { 'Code.gs': 'function doPost(e) {}', 'appsscript.json': manifestText },
    empty: { 'appsscript.json': manifestText }
  };
  for (const [name, files] of Object.entries(cases)) {
    const t = setup({ files });
    const r = t.run('deploy');
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, /TARGET_MISMATCH/, name);
    untouched(t);
    noLeak(r, t);
  }
  const broad = JSON.parse(manifestText); broad.oauthScopes.push('https://www.googleapis.com/auth/spreadsheets');
  let t = setup({ files: { ...oldFiles(), 'appsscript.json': JSON.stringify(broad) } });
  let r = t.run('deploy');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MANIFEST_REMOTE_UNAPPROVED_SCOPE/);
  untouched(t);
  const open = JSON.parse(manifestText); open.webapp.access = 'ANYONE';
  t = setup({ files: { ...oldFiles(), 'appsscript.json': JSON.stringify(open) } });
  r = t.run('deploy');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MANIFEST_WEBAPP_MISMATCH/);
  untouched(t);
});

test('deploy: push failure leaves the published deployment unchanged; update outcome is judged by read-back, not API acceptance', () => {
  let t = setup();
  let r = t.run('deploy', { FAKE_FAIL: 'push' });
  assert.notEqual(r.status, 0);
  assert.equal(deployedVersion(t), 2);
  noLeak(r, t);
  // APIが失敗扱いでも、読取り照合で反映済みなら成功
  t = setup();
  r = t.run('deploy', { FAKE_FAIL: 'update-apply-then-error' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(deployedVersion(t), 3);
  // APIが失敗扱いで未反映なら失敗（成功と言わない）
  t = setup();
  r = t.run('deploy', { FAKE_FAIL: 'update-silent' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NOT applied/);
  assert.equal(deployedVersion(t), 2);
  assert.match(t.sum(), /失敗/);
  // 説明が一致しない（別SHAが付いている等）反映は成功にしない
  t = setup();
  r = t.run('deploy', { FAKE_DESC_SUFFIX: ' extra' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /UNKNOWN_STATE/);
  noLeak(r, t);
});

test('deploy: clasp error output (which may contain account/project details) is never echoed', () => {
  const t = setup();
  const r = t.run('deploy', { FAKE_FAIL: 'update-deployment' });
  assert.notEqual(r.status, 0);
  noLeak(r, t);
});

test('rollback: moves the SAME deployment to an existing version; no push; rejects missing/same/invalid versions', () => {
  let t = setup();
  let r = t.run('rollback', { ROLLBACK_VERSION: '1' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(deployedVersion(t), 1);
  assert.equal(t.read().deployments.length, 2);
  assert.ok(!t.calls().includes('push'), 'rollback never pushes source');
  assert.match(t.sum(), /@2.*@1/);
  noLeak(r, t);
  t = setup();
  r = t.run('rollback', { ROLLBACK_VERSION: ' 1 ' });
  assert.equal(r.status, 0, 'surrounding whitespace is tolerated');
  for (const [v, why] of [['9', 'missing version'], ['2', 'already there'], ['abc', 'invalid'], ['', 'empty']]) {
    t = setup();
    r = t.run('rollback', { ROLLBACK_VERSION: v });
    assert.notEqual(r.status, 0, why);
    untouched(t);
  }
  t = setup({ files: { 'BookingCore.gs': 'x', 'appsscript.json': manifestText } });
  r = t.run('rollback', { ROLLBACK_VERSION: '1' });
  assert.notEqual(r.status, 0, 'rollback also verifies the target project');
  untouched(t);
});

test('lib CLI: errors never echo input or paths; write-config makes 0600 files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-cfg-'));
  const r = spawnSync('node', [libFile, 'write-config', path.join(dir, 'a.json'), dir],
    { env: { PATH: process.env.PATH, OPS_CLASPRC_JSON: '{"tokens":{"default":{}}}', OPS_SCRIPT_ID: SECRET }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(fs.statSync(path.join(dir, 'a.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, '.clasp.json')).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.clasp.json'), 'utf8')).scriptExtensions, ['gs']);
  const bad = spawnSync('node', [libFile, 'pick-deployment', path.join(dir, 'missing.json')], { env: { PATH: process.env.PATH, OPS_DEPLOYMENT_ID: DEPLOY }, encoding: 'utf8' });
  assert.equal(bad.status, 70);
  assert.ok(!(bad.stdout + bad.stderr).includes(dir) && !(bad.stdout + bad.stderr).includes(DEPLOY));
});
