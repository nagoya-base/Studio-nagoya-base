'use strict';
/*
 * Issue #787: 検証専用GAS「SwitchBot Access Test」への自動コード反映。workflowの静的検査と、
 * 偽のclaspを使ったスクリプトの振る舞い検査（実GAS・実API・実Spreadsheetへは一切接続しない）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const lib = require('../scripts/switchbot-access-test-gas-deploy-lib.js');
const prepare = require('../scripts/prepare-switchbot-access-gas-project.js');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const code = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const wf = read('.github/workflows/switchbot-access-test-gas-deploy.yml');
const wfCode = code(wf);
const script = path.join(root, 'scripts/deploy-switchbot-access-test-gas.sh');
const scriptText = code(fs.readFileSync(script, 'utf8'));
const libText = read('scripts/switchbot-access-test-gas-deploy-lib.js');
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, p))).digest('hex');

// ---- workflow 静的検査 ----
test('workflow: triggers are main push (target paths only) and workflow_dispatch; no PR/schedule/fork triggers', () => {
  const on = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\npermissions:'));
  assert.match(on, /\n  push:\n    branches:\n      - main\n    paths:\n/);
  assert.match(on, /\n  workflow_dispatch:\n/);
  assert.doesNotMatch(on, /\n  (pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|release):/);
  const paths = on.slice(on.indexOf('paths:'), on.indexOf('workflow_dispatch:')).match(/- '([^']+)'/g).map((x) => x.slice(3, -1));
  assert.deepEqual(paths.sort(), [
    '.github/workflows/switchbot-access-test-gas-deploy.yml', 'gas/booking/shared/AccessKeySnapshot.gs', 'gas/switchbot-access/**',
    'scripts/deploy-switchbot-access-test-gas.sh', 'scripts/prepare-switchbot-access-gas-project.js', 'scripts/switchbot-access-test-gas-deploy-lib.js'
  ].sort());
  // 他の対象外パス（予約GAS本体・サイト・検証GAS #723・本番デプロイ一式）では起動しない
  for (const p of paths) assert.doesNotMatch(p, /^gas\/booking\/\*\*|^gas\/switchbot-verify|switchbot-access-gas-deploy|deploy-switchbot-access-gas\.sh|^\*\*$/);
});

test('workflow: dispatch inputs default to safe values (NOT_SELECTED / false)', () => {
  const inputs = wf.slice(wf.indexOf('    inputs:\n'), wf.indexOf('\npermissions:'));
  assert.match(inputs, /deployment_action:[\s\S]*?required: true\n\s+type: choice\n\s+default: 'NOT_SELECTED'/);
  assert.match(inputs, /executor_confirmed:[\s\S]*?required: true\n\s+type: boolean\n\s+default: false/);
  assert.doesNotMatch(inputs, /default: true/);
});

test('workflow: independent Environment, Secrets and concurrency; never cancels (no parallel update of one Script)', () => {
  assert.match(wf, /concurrency:\n  group: switchbot-access-test-gas-deploy\n  cancel-in-progress: false\n/);
  assert.equal((wf.match(/^\s+environment: switchbot-access-test$/gm) || []).length, 2);
  assert.doesNotMatch(wfCode, /environment: (?!switchbot-access-test$)/m);
  const secrets = [...new Set(wf.match(/secrets\.[A-Z_]+/g))].sort();
  assert.deepEqual(secrets, ['secrets.SWITCHBOT_ACCESS_TEST_CLASPRC_JSON', 'secrets.SWITCHBOT_ACCESS_TEST_DEPLOYMENT_ID',
    'secrets.SWITCHBOT_ACCESS_TEST_FORBIDDEN_IDS', 'secrets.SWITCHBOT_ACCESS_TEST_SCRIPT_ID']);
  // 本番・Booking・旧verify・Survey の名前・変数を一切参照しない
  assert.doesNotMatch(wfCode, /SWITCHBOT_ACCESS_(CLASPRC|SCRIPT_ID|DEPLOYMENT_ID)|SWITCHBOT_VERIFY|SBV_|BOOKING_|SURVEY_|switchbot-access-production|switchbot-access-on-approval|switchbot-verify|group: switchbot-access-gas-deploy/);
});

test('workflow: gate/test have no secrets or environment; PR never reaches deploy; deploy needs gate+test success on main', () => {
  const gateTest = wf.slice(wf.indexOf('\n  gate:'), wf.indexOf('\n  deploy:'));
  assert.doesNotMatch(gateTest, /secrets\.|environment:|\bvars\./);
  const gate = wf.slice(wf.indexOf('\n  gate:'), wf.indexOf('\n  test:'));
  const run = gate.slice(gate.indexOf('run: |'));
  assert.doesNotMatch(run, /\$\{\{/, 'inputs are passed via env only');
  assert.match(run, /STALE_SHA_NOT_MAIN_HEAD/);
  assert.match(wf, /\n    needs: \[gate, test\]\n/);
  const dep = wf.slice(wf.indexOf('\n  deploy:'), wf.indexOf('\n  rollback:'));
  const cond = dep.slice(dep.indexOf('if:'), dep.indexOf('runs-on:'));
  for (const re of [/!cancelled\(\)/, /github\.ref == 'refs\/heads\/main'/, /needs\.gate\.outputs\.valid == 'true'/, /needs\.test\.result == 'success'/]) assert.match(cond, re);
  assert.doesNotMatch(wfCode, /github\.event_name == 'pull_request'|pull_request/);
  // PRではモック・静的テストのみ（booking-pr-tests.yml が対象パスを監視）
  const pr = read('.github/workflows/booking-pr-tests.yml');
  // workflow本体は `.github/workflows/**`（Issue #804 PR-B）で監視される。scriptは個別に列挙される。
  for (const p of ['.github/workflows/**', 'scripts/deploy-switchbot-access-test-gas.sh']) assert.ok(pr.includes("'" + p + "'"), p);
  assert.doesNotMatch(pr, /secrets\.|environment:/);
});

test('workflow: stale push runs skip via target-path diff covering the shared snapshot', () => {
  assert.match(wf, /git diff --quiet "\$GITHUB_SHA" FETCH_HEAD -- "\$\{target_paths\[@\]\}"/);
  const targets = lib.TARGET_PATHS;
  for (const p of ['gas/switchbot-access', 'gas/booking/shared/AccessKeySnapshot.gs', 'scripts/prepare-switchbot-access-gas-project.js',
    'scripts/deploy-switchbot-access-test-gas.sh', 'scripts/switchbot-access-test-gas-deploy-lib.js', '.github/workflows/switchbot-access-test-gas-deploy.yml']) assert.ok(targets.includes(p), p);
  assert.ok(!targets.some((p) => /switchbot-access-gas-deploy|deploy-switchbot-access-gas\.sh/.test(p)), 'production files are not target paths');
});

test('workflow: minimal permissions, pinned clasp, no artifacts/cache/debug; secrets only on the two deploy steps', () => {
  assert.match(wf, /permissions:\n  contents: read\n/);
  assert.doesNotMatch(wfCode, /^env:/m);
  assert.match(wf, /@google\/clasp@3\.4\.1/);
  assert.doesNotMatch(wf, /@google\/clasp@(?!3\.4\.1)/);
  assert.doesNotMatch(wfCode, /actions\/(upload-artifact|cache)|set -x|xtrace|ACTIONS_STEP_DEBUG|continue-on-error|retry|workflow_dispatch:\s*\n\s+secrets/);
  assert.equal((wf.match(/secrets\./g) || []).length, 8);
});

test('workflow/script/lib: never touch properties, triggers, webhooks, mail, the SwitchBot API or deployments creation', () => {
  for (const text of [wfCode, scriptText, code(libText)]) {
    assert.doesNotMatch(text, /create-deployment|delete-deployment|clasp[ \t]+run|clasp[ \t]+deploy|\bdeploy\b +-|set -x|set -o xtrace/);
    assert.doesNotMatch(text, /createKey|deleteKey|keyList|setupWebhook|accessInstallTriggers|accessRemoveTriggers|accessSyncJob|ACCESS_ENABLED\s*=|setProperty|MailApp|api\.switch-bot\.com|deliveryConfigured/);
  }
  assert.match(scriptText, /trap cleanup EXIT/);
});

// ---- 本番・他系統の不変性（#723 / #768・#778 / 予約GAS）----
test('immutability: production deploy workflow/script/lib remain exactly as designed and unaware of the test system', () => {
  const prodWf = read('.github/workflows/switchbot-access-gas-deploy.yml');
  assert.match(prodWf, /\non:\n  workflow_dispatch:/);
  assert.doesNotMatch(prodWf, /\n  (push|pull_request|schedule):/);
  assert.match(prodWf, /environment: switchbot-access-production/);
  assert.match(prodWf, /group: switchbot-access-gas-deploy\n/);
  for (const n of ['SWITCHBOT_ACCESS_CLASPRC_JSON', 'SWITCHBOT_ACCESS_SCRIPT_ID', 'SWITCHBOT_ACCESS_DEPLOYMENT_ID']) assert.ok(prodWf.includes('secrets.' + n));
  for (const f of ['.github/workflows/switchbot-access-gas-deploy.yml', 'scripts/deploy-switchbot-access-gas.sh', 'scripts/switchbot-access-gas-deploy-lib.js']) {
    assert.doesNotMatch(read(f), /switchbot-access-test|SWITCHBOT_ACCESS_TEST|SBAT_/, f);
  }
  const verifyWf = read('.github/workflows/switchbot-verify-gas-deploy.yml');
  assert.match(verifyWf, /environment: switchbot-verify/);
  assert.doesNotMatch(verifyWf, /switchbot-access-test|SWITCHBOT_ACCESS_TEST/);
  // 予約GASのworkflowも新systemのSecrets/Environmentを使わない
  for (const f of fs.readdirSync(path.join(root, '.github/workflows')).filter((n) => n !== 'switchbot-access-test-gas-deploy.yml')) {
    const t = read('.github/workflows/' + f);
    assert.doesNotMatch(t, /SWITCHBOT_ACCESS_TEST|environment: switchbot-access-test/, f);
  }
  // 新workflowも他系統の名前を使わない
  assert.doesNotMatch(read('scripts/deploy-switchbot-access-test-gas.sh').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n'), /SBA_|SBV_|SWITCHBOT_ACCESS_(CLASPRC|SCRIPT_ID|DEPLOYMENT_ID)/);
});

test('immutability: lib reuses production pure functions read-only and does not modify the production lib exports', () => {
  assert.match(libText, /require\('\.\/switchbot-access-gas-deploy-lib\.js'\)/);
  const prod = require('../scripts/switchbot-access-gas-deploy-lib.js');
  assert.ok(!prod.TARGET_PATHS.some((p) => /test/.test(p)));
  assert.ok(!lib.TARGET_PATHS.some((p) => /switchbot-access-gas-deploy|deploy-switchbot-access-gas\.sh/.test(p)));
});

test('bundle: the same managed code (gas/switchbot-access) is distributed; the real bundle passes the check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbat-bundle-'));
  prepare.prepareProject(dir);
  const prod = require('../scripts/switchbot-access-gas-deploy-lib.js');
  assert.equal(prod.checkBundle(dir), 'OK');
  assert.equal(spawnSync('node', [path.join(root, 'scripts/switchbot-access-test-gas-deploy-lib.js'), 'check-bundle', dir]).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'SwitchBotAccessInfra.gs'), 'utf8'), read('gas/switchbot-access/SwitchBotAccessInfra.gs'));
  assert.ok(sha256('gas/switchbot-access/appsscript.json'));
});

// ---- lib ----
test('lib.checkDispatch: push deploys; dispatch needs a chosen action; contradictions and other refs/events are refused', () => {
  const ok = { event: 'push', ref: 'refs/heads/main' };
  assert.equal(lib.checkDispatch(ok), 'OK');
  assert.equal(lib.checkDispatch({ event: 'workflow_dispatch', ref: 'refs/heads/main', action: 'deploy' }), 'OK');
  assert.equal(lib.checkDispatch({ event: 'workflow_dispatch', ref: 'refs/heads/main', action: 'rollback', rollbackVersion: '3' }), 'OK');
  assert.equal(lib.checkDispatch({ event: 'workflow_dispatch', ref: 'refs/heads/main', action: 'NOT_SELECTED' }), 'ACTION_NOT_SELECTED');
  assert.equal(lib.checkDispatch({ event: 'workflow_dispatch', ref: 'refs/heads/main', action: 'deploy', rollbackVersion: '2' }), 'ROLLBACK_INPUT_WITH_DEPLOY');
  assert.equal(lib.checkDispatch({ event: 'workflow_dispatch', ref: 'refs/heads/main', action: 'rollback', rollbackVersion: 'x' }), 'ROLLBACK_VERSION_REQUIRED');
  assert.equal(lib.checkDispatch({ event: 'workflow_dispatch', ref: 'refs/heads/main', action: 'bogus' }), 'INVALID_ACTION');
  for (const event of ['pull_request', 'pull_request_target', 'schedule', '', undefined]) assert.equal(lib.checkDispatch({ event, ref: 'refs/heads/main', action: 'deploy' }), 'NOT_PUSH_OR_DISPATCH');
  assert.equal(lib.checkDispatch({ event: 'push', ref: 'refs/heads/claude/x' }), 'BRANCH_NOT_MAIN');
});

test('lib.checkRun: kill switch and the executor declaration must both hold', () => {
  const base = { event: 'push', ref: 'refs/heads/main', enabled: 'true', executorVar: 'true' };
  assert.equal(lib.checkRun(base), 'OK');
  assert.equal(lib.checkRun({ ...base, enabled: '' }), 'DEPLOY_DISABLED');
  assert.equal(lib.checkRun({ ...base, enabled: 'false' }), 'DEPLOY_DISABLED');
  assert.equal(lib.checkRun({ ...base, executorVar: '' }), 'EXECUTOR_NOT_CONFIRMED');
  assert.equal(lib.checkRun({ ...base, event: 'workflow_dispatch', executorVar: 'true', executorInput: 'false' }), 'EXECUTOR_NOT_CONFIRMED');
  assert.equal(lib.checkRun({ ...base, event: 'workflow_dispatch', executorVar: '', executorInput: 'true' }), 'OK');
  assert.equal(lib.checkRun({ ...base, event: 'pull_request' }), 'NOT_PUSH_OR_DISPATCH');
  assert.equal(lib.checkRun({ ...base, ref: 'refs/heads/x' }), 'BRANCH_NOT_MAIN');
});

test('lib.checkIds: valid test IDs pass; missing, malformed, unconfigured deny-list and matches with other projects stop', () => {
  const S = 'TESTSCRIPTID_1234567890abcdef';
  const forbidden = 'PRODSCRIPTID_1234567890abcd,\nBOOKINGSCRIPT_1234567890abcde PRODDEPLOY_1234567890abcdefgh';
  assert.equal(lib.checkIds({ scriptId: S, forbiddenIds: forbidden }), 'OK');
  assert.equal(lib.checkIds({ scriptId: S, deploymentId: 'TESTDEPLOY_1234567890abcdefg', forbiddenIds: forbidden }), 'OK');
  assert.equal(lib.checkIds({ scriptId: '', forbiddenIds: forbidden }), 'SCRIPT_ID_MISSING');
  assert.equal(lib.checkIds({ scriptId: 'short', forbiddenIds: forbidden }), 'SCRIPT_ID_INVALID');
  assert.equal(lib.checkIds({ scriptId: 'has space and/slash 1234567890', forbiddenIds: forbidden }), 'SCRIPT_ID_INVALID');
  assert.equal(lib.checkIds({ scriptId: S, forbiddenIds: '' }), 'FORBIDDEN_IDS_NOT_CONFIGURED');
  assert.equal(lib.checkIds({ scriptId: 'PRODSCRIPTID_1234567890abcd', forbiddenIds: forbidden }), 'SCRIPT_ID_MATCHES_OTHER_PROJECT');
  assert.equal(lib.checkIds({ scriptId: S, deploymentId: 'PRODDEPLOY_1234567890abcdefgh', forbiddenIds: forbidden }), 'DEPLOYMENT_ID_MATCHES_OTHER_PROJECT');
  assert.equal(lib.checkIds({ scriptId: S, deploymentId: S, forbiddenIds: forbidden }), 'DEPLOYMENT_ID_EQUALS_SCRIPT_ID');
  assert.equal(lib.checkIds({ scriptId: S, deploymentId: 'bad id', forbiddenIds: forbidden }), 'DEPLOYMENT_ID_INVALID');
});

test('lib.checkRemoteTarget: blank new GAS and the access GAS pass; Booking/Survey/verify/unknown projects are refused', () => {
  const mk = (files) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sbat-r-')); for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c); return d; };
  assert.equal(lib.checkRemoteTarget(mk({ 'appsscript.json': '{}' })), 'OK_BLANK');
  assert.equal(lib.checkRemoteTarget(mk({ 'Code.gs': 'function myFunction() {}', 'appsscript.json': '{}' })), 'OK_BLANK');
  assert.equal(lib.checkRemoteTarget(mk({ 'SwitchBotAccessApp.gs': 'x', 'SwitchBotAccessCore.gs': 'x', 'appsscript.json': '{}' })), 'OK');
  assert.equal(lib.checkRemoteTarget(mk({ 'Code.gs': 'x'.repeat(5000) })), 'TARGET_MISMATCH_UNKNOWN_PROJECT');
  assert.equal(lib.checkRemoteTarget(mk({ 'Other.gs': 'x' })), 'TARGET_MISMATCH_UNKNOWN_PROJECT');
  for (const n of ['BookingCore.gs', 'SurveyApp.gs', 'SwitchBotVerify.gs']) {
    assert.equal(lib.checkRemoteTarget(mk({ [n]: 'x', 'SwitchBotAccessApp.gs': 'x', 'SwitchBotAccessCore.gs': 'x' })), 'TARGET_MISMATCH_OTHER_PROJECT', n);
    assert.equal(lib.checkRemoteTarget(mk({ [n]: 'x' })), 'TARGET_MISMATCH_OTHER_PROJECT', n);
  }
});

test('lib.checkManifest: existing web app settings must match; removal of remote dependencies is refused; blank manifest passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbat-m-'));
  const w = (n, o) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  const repo = JSON.parse(read('gas/switchbot-access/appsscript.json'));
  const repoF = w('repo', repo);
  assert.equal(lib.checkManifest(w('blank', { timeZone: 'Asia/Tokyo' }), repoF), 'OK');
  assert.equal(lib.checkManifest(w('same', repo), repoF), 'OK');
  assert.equal(lib.checkManifest(w('exec', { ...repo, webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_ACCESSING' } }), repoF), 'MANIFEST_WEBAPP_MISMATCH');
  assert.equal(lib.checkManifest(w('acc', { ...repo, webapp: { access: 'MYSELF', executeAs: 'USER_DEPLOYING' } }), repoF), 'MANIFEST_WEBAPP_MISMATCH');
  const extraDep = { enabledAdvancedServices: [{ userSymbol: 'Drive', serviceId: 'drive', version: 'v3' }] };
  assert.equal(lib.checkManifest(w('dep', { ...repo, dependencies: extraDep }), repoF), 'MANIFEST_REMOTE_DEPENDENCY_WOULD_BE_REMOVED');
  const lb = { libraries: [{ userSymbol: 'L', libraryId: 'x', version: '1' }] };
  assert.equal(lib.checkManifest(w('lib', { ...repo, dependencies: { ...repo.dependencies, ...lb } }), repoF), 'MANIFEST_REMOTE_DEPENDENCY_WOULD_BE_REMOVED');
  assert.equal(lib.checkManifest(w('lib0', { ...repo, dependencies: { ...repo.dependencies, libraries: [] } }), repoF), 'OK');
  assert.equal(lib.checkManifest(w('exe', { ...repo }), w('bad', { ...repo, webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_ACCESSING' } })), 'MANIFEST_WEBAPP_MISMATCH');
  assert.equal(lib.checkManifest(w('blank2', {}), w('bad2', { ...repo, webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_ACCESSING' } })), 'MANIFEST_EXECUTOR_UNEXPECTED');
  assert.equal(lib.checkManifest(path.join(dir, 'nope'), repoF), 'MANIFEST_UNREADABLE');
});

// ---- script with a fake clasp ----
const SCRIPT = 'TESTSCRIPTSECRET_1234567890ab';
const DEPLOY = 'TESTDEPLOYSECRET_1234567890ab';
const PROD_SCRIPT = 'PRODSCRIPTSECRET_1234567890ab';
const PROD_DEPLOY = 'PRODDEPLOYSECRET_1234567890ab';
const TOKEN = 'refresh-token-DONOTLEAK';
const SHA = 'c'.repeat(40);

function fakeClasp(binDir) {
  const js = `#!/usr/bin/env node
const fs=require('fs');
const S=process.env.FAKE_STATE, a=process.argv.slice(2).filter((x,i,arr)=>!(x==='--auth'||arr[i-1]==='--auth'||x==='--user'||arr[i-1]==='--user'));
const cmd=a[0]; const st=()=>JSON.parse(fs.readFileSync(S+'/state.json','utf8')); const save=(s)=>fs.writeFileSync(S+'/state.json',JSON.stringify(s));
const cfg=JSON.parse(fs.readFileSync('.clasp.json','utf8'));
fs.appendFileSync(S+'/calls.log', cmd+' '+cfg.scriptId+'\\n');
const sumf=process.env.GITHUB_STEP_SUMMARY; const preflightDone=!!sumf&&fs.existsSync(sumf)&&fs.readFileSync(sumf,'utf8').includes('preflight');
if((cmd==='push'||cmd==='update-deployment')&&!preflightDone)fs.appendFileSync(S+'/calls.log','WRITE_BEFORE_PREFLIGHT\\n');
const fail=process.env.FAKE_FAIL||''; if(fail===cmd){console.error('boom '+process.env.FAKE_LEAK);process.exit(1);}
const s=st(); const ext=(cfg.scriptExtensions&&cfg.scriptExtensions[0])||'js';
if(cmd==='pull'){for(const [n,c] of Object.entries(s.files))fs.writeFileSync(n.endsWith('.gs')?n.slice(0,-3)+'.'+ext:n,c);}
else if(cmd==='push'){ if(fail==='push-partial'){s.files={'Partial.gs':'x'};save(s);process.exit(1);} s.files={};for(const n of fs.readdirSync('.'))if(n.endsWith('.gs')||n==='appsscript.json')s.files[n]=fs.readFileSync(n,'utf8'); save(s);}
else if(cmd==='list-deployments'){console.log(JSON.stringify(s.deployments));}
else if(cmd==='list-versions'){console.log(JSON.stringify(s.versions));}
else if(cmd==='update-deployment'){
  const id=a[1]; const vi=a.indexOf('-V'); const di=a.indexOf('--description');
  if(fail==='update-silent'){process.exit(1);}
  if(fail==='update-moves-elsewhere'){const d0=s.deployments.find(x=>x.deploymentId===id); d0.versionNumber=1; save(s); process.exit(1);}
  let v; if(vi>=0)v=Number(a[vi+1]); else{v=Math.max(...s.versions.map(x=>x.versionNumber))+1;s.versions.push({versionNumber:v,description:a[di+1]});}
  const d=s.deployments.find(x=>x.deploymentId===id); d.versionNumber=v; d.description=a[di+1]+(process.env.FAKE_DESC_SUFFIX||'');
  save(s); if(fail==='update-apply-then-error'){process.exit(1);}
}`;
  fs.writeFileSync(path.join(binDir, 'clasp'), js, { mode: 0o755 });
}

const accessManifest = () => read('gas/switchbot-access/appsscript.json');
const blankFiles = () => ({ 'Code.gs': 'function myFunction() {}\n', 'appsscript.json': JSON.stringify({ timeZone: 'Asia/Tokyo', exceptionLogging: 'STACKDRIVER', runtimeVersion: 'V8' }) });
const oldFiles = () => {
  const files = {};
  for (const n of prepare.fileNames()) files[n] = '// old ' + n;
  files['appsscript.json'] = accessManifest();
  return files;
};

function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbat-e2e-'));
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
      PATH: bin + path.delimiter + process.env.PATH, HOME: dir, FAKE_STATE: state, FAKE_LEAK: SCRIPT,
      RUNNER_TEMP: tmp, GITHUB_WORKSPACE: root, GITHUB_SHA: SHA, GITHUB_STEP_SUMMARY: summary, GITHUB_RUN_ID: '1',
      SBAT_RETRY_DELAY_SECONDS: '0', SBAT_CLASPRC_JSON: JSON.stringify({ tokens: { default: { refresh_token: TOKEN } } }),
      SBAT_SCRIPT_ID: SCRIPT, SBAT_DEPLOYMENT_ID: '', SBAT_FORBIDDEN_IDS: PROD_SCRIPT + ',' + PROD_DEPLOY,
      DG_EVENT: 'push', DG_REF: 'refs/heads/main', DG_ENABLED: 'true', DG_EXECUTOR_VAR: 'true', DG_EXECUTOR_INPUT: '', ...env
    }
  });
  const read2 = () => JSON.parse(fs.readFileSync(path.join(state, 'state.json'), 'utf8'));
  const calls = () => (fs.existsSync(path.join(state, 'calls.log')) ? fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
  const cmds = () => calls().map((c) => c.split(' ')[0]);
  const sum = () => (fs.existsSync(summary) ? fs.readFileSync(summary, 'utf8') : '');
  return { run, read: read2, calls, cmds, sum, tmp, state };
}
const noLeak = (r, t) => {
  const all = (r.stdout + r.stderr + (t ? t.sum() : '')).replace(/^::add-mask::.*$/gm, '');
  for (const v of [SCRIPT, DEPLOY, TOKEN, PROD_SCRIPT, PROD_DEPLOY]) assert.ok(!all.includes(v), 'secret value leaked');
};
const dv = (t) => t.read().deployments.find((x) => x.deploymentId === DEPLOY).versionNumber;
const unchanged = (t, files) => assert.deepEqual(t.read().files, files);

test('first push to a blank GAS: source only, no deployment, only the test Script ID is touched, nothing leaks, work files removed', () => {
  const t = setup({ files: blankFiles() });
  const r = t.run('deploy');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(Object.keys(t.read().files).sort(), prepare.fileNames().slice().sort());
  assert.equal(t.read().files['SwitchBotAccessApp.gs'], read('gas/switchbot-access/SwitchBotAccessApp.gs'));
  assert.equal(t.read().deployments.length, 2);
  assert.equal(dv(t), 2, 'no deployment update without the fixed-deployment secret');
  assert.ok(t.cmds().every((c) => ['pull', 'push'].includes(c)), 'only pull/push: ' + t.cmds());
  assert.ok(t.calls().every((c) => c.endsWith(' ' + SCRIPT)), 'only the test script id is used');
  assert.deepEqual(fs.readdirSync(t.tmp), []);
  noLeak(r, t);
  assert.match(t.sum(), /ソース反映のみ/);
  assert.match(t.sum(), /OK_BLANK/);
});

test('update of an existing test GAS (push event): source updated, deployment untouched when no fixed-deployment secret', () => {
  const t = setup();
  const r = t.run('deploy');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.read().files['SwitchBotAccessCore.gs'], read('gas/switchbot-access/SwitchBotAccessCore.gs'));
  assert.equal(dv(t), 2);
  assert.ok(!t.cmds().includes('update-deployment'));
});

test('with an approved fixed deployment: updates the SAME deployment once (no creation); summary is non-secret', () => {
  const t = setup();
  const r = t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const s = t.read();
  assert.equal(s.deployments.length, 2);
  const d = s.deployments.find((x) => x.deploymentId === DEPLOY);
  assert.equal(d.versionNumber, 3);
  assert.equal(d.description, 'main ' + SHA);
  assert.equal(t.cmds().filter((c) => c === 'update-deployment').length, 1);
  assert.ok(t.cmds().every((c) => ['pull', 'push', 'list-deployments', 'list-versions', 'update-deployment'].includes(c)));
  noLeak(r, t);
  assert.match(t.sum(), /@2.*@3/);
  assert.deepEqual(fs.readdirSync(t.tmp), []);
});

test('unset secrets stop before any clasp call (script id, credentials, deny-list)', () => {
  for (const env of [{ SBAT_SCRIPT_ID: '' }, { SBAT_CLASPRC_JSON: '' }, { SBAT_FORBIDDEN_IDS: '' }]) {
    const t = setup({ files: blankFiles() });
    const r = t.run('deploy', env);
    assert.notEqual(r.status, 0);
    assert.deepEqual(t.calls(), [], JSON.stringify(Object.keys(env)));
    noLeak(r, t);
  }
});

test('a Script ID or Deployment ID that matches production/Booking/verify is refused before any clasp call', () => {
  let t = setup({ files: blankFiles() });
  let r = t.run('deploy', { SBAT_SCRIPT_ID: PROD_SCRIPT });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SCRIPT_ID_MATCHES_OTHER_PROJECT/);
  assert.deepEqual(t.calls(), []);
  noLeak(r, t);
  t = setup();
  r = t.run('deploy', { SBAT_DEPLOYMENT_ID: PROD_DEPLOY });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /DEPLOYMENT_ID_MATCHES_OTHER_PROJECT/);
  assert.deepEqual(t.calls(), []);
  noLeak(r, t);
});

test('kill switch: stopped state is a clean no-op (no clasp, no auth file); recovery works when re-enabled', () => {
  for (const enabled of ['', 'false', 'FALSE', '1']) {
    const t = setup();
    const before = JSON.stringify(t.read());
    const r = t.run('deploy', { DG_ENABLED: enabled });
    assert.equal(r.status, 0);
    assert.deepEqual(t.calls(), []);
    assert.equal(JSON.stringify(t.read()), before);
    assert.match(t.sum(), /停止中/);
  }
  const t = setup(); // recovery: same state, enabled again
  assert.equal(t.run('deploy').status, 0);
  assert.equal(t.read().files['SwitchBotAccessApp.gs'], read('gas/switchbot-access/SwitchBotAccessApp.gs'));
});

test('executor declaration: push needs the Environment variable, dispatch needs the input; otherwise safe stop', () => {
  let t = setup();
  let r = t.run('deploy', { DG_EXECUTOR_VAR: '' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(t.calls(), []);
  t = setup();
  r = t.run('deploy', { DG_EVENT: 'workflow_dispatch', DG_EXECUTOR_VAR: 'true', DG_EXECUTOR_INPUT: 'false' });
  assert.notEqual(r.status, 0);
  assert.deepEqual(t.calls(), []);
  t = setup();
  assert.equal(t.run('deploy', { DG_EVENT: 'workflow_dispatch', DG_EXECUTOR_VAR: '', DG_EXECUTOR_INPUT: 'true' }).status, 0);
});

test('pull_request / other branches / schedule are refused by the script too (no external communication on PR)', () => {
  for (const env of [{ DG_EVENT: 'pull_request' }, { DG_EVENT: 'schedule' }, { DG_REF: 'refs/heads/feature' }, { DG_REF: 'refs/pull/1/merge' }]) {
    const t = setup();
    const r = t.run('deploy', env);
    assert.notEqual(r.status, 0);
    assert.deepEqual(t.calls(), []);
  }
});

test('auth failure / permission shortage (pull fails) stop safely: nothing pushed, nothing leaked', () => {
  let t = setup({ files: blankFiles() });
  let r = t.run('deploy', { SBAT_CLASPRC_JSON: 'not-json-' + TOKEN });
  assert.notEqual(r.status, 0);
  assert.deepEqual(t.calls(), []);
  noLeak(r, t);
  t = setup({ files: blankFiles() });
  r = t.run('deploy', { FAKE_FAIL: 'pull' });
  assert.notEqual(r.status, 0);
  assert.ok(!t.cmds().includes('push'));
  unchanged(t, blankFiles());
  noLeak(r, t);
});

test('wrong target project (Booking/Survey/verify/unknown files) is refused before push', () => {
  for (const extra of [{ 'BookingFoo.gs': '' }, { 'SurveyApp.gs': '' }, { 'SwitchBotVerify.gs': '' }, { 'Mystery.gs': '// someone else' }]) {
    const files = { ...blankFiles(), ...extra };
    const t = setup({ files });
    const r = t.run('deploy');
    assert.notEqual(r.status, 0, Object.keys(extra)[0]);
    assert.ok(!t.cmds().includes('push'));
    unchanged(t, files);
    noLeak(r, t);
  }
});

test('manifest mismatch (web app execution settings differ) stops before push', () => {
  const m = JSON.parse(accessManifest()); m.webapp.executeAs = 'USER_ACCESSING';
  const files = { ...oldFiles(), 'appsscript.json': JSON.stringify(m) };
  const t = setup({ files });
  const r = t.run('deploy');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /MANIFEST_WEBAPP_MISMATCH/);
  assert.ok(!t.cmds().includes('push'));
  unchanged(t, files);
});

test('push failure: not a success, never retried, deployment not touched, no leak', () => {
  const t = setup({ files: blankFiles() });
  const r = t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY, FAKE_FAIL: 'push' });
  assert.notEqual(r.status, 0);
  assert.equal(t.cmds().filter((c) => c === 'push').length, 1);
  assert.ok(!t.cmds().includes('update-deployment'));
  assert.equal(dv(t), 2);
  noLeak(r, t);
});

test('push with an unexpected result (partial source) is UNKNOWN_STATE: no deployment update, no blind re-run', () => {
  const t = setup();
  const r = t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY, FAKE_FAIL: 'push-partial' });
  assert.notEqual(r.status, 0);
  assert.equal(t.cmds().filter((c) => c === 'push').length, 1);
  assert.ok(!t.cmds().includes('update-deployment'));
  assert.equal(dv(t), 2);
});

test('deployment update: failure with no change is NOT applied; unexpected movement is UNKNOWN_STATE; neither is retried', () => {
  let t = setup();
  let r = t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY, FAKE_FAIL: 'update-silent' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NOT applied/);
  assert.equal(t.cmds().filter((c) => c === 'update-deployment').length, 1);
  noLeak(r, t);
  t = setup();
  r = t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY, FAKE_FAIL: 'update-moves-elsewhere' });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /UNKNOWN_STATE/);
  assert.equal(t.cmds().filter((c) => c === 'update-deployment').length, 1);
  assert.equal(t.cmds().filter((c) => c === 'push').length, 1);
  noLeak(r, t);
});

test('deployment update that applied but returned an error is reconciled by reads (success)', () => {
  const t = setup();
  const r = t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY, FAKE_FAIL: 'update-apply-then-error' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(dv(t), 3);
});

test('unknown / @HEAD deployment id stops before push', () => {
  for (const id of ['NOPEDEPLOYMENT_1234567890abcd', 'HEADID_HEADID_HEADID_HEADID']) {
    const t = setup();
    const r = t.run('deploy', { SBAT_DEPLOYMENT_ID: id });
    assert.notEqual(r.status, 0);
    assert.ok(!t.cmds().includes('push'));
  }
});

test('double execution: two sequential runs each add exactly one version to the same test deployment', () => {
  const t = setup();
  assert.equal(t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY }).status, 0);
  assert.equal(t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY, GITHUB_SHA: 'd'.repeat(40) }).status, 0);
  assert.equal(dv(t), 4);
  assert.equal(t.read().deployments.length, 2);
});

test('rollback: needs the fixed deployment; goes back to an existing version on the SAME deployment; bad input refused', () => {
  let t = setup();
  let r = t.run('rollback', { DG_EVENT: 'workflow_dispatch', DG_EXECUTOR_INPUT: 'true', ROLLBACK_VERSION: '1' });
  assert.notEqual(r.status, 0, 'no deployment secret');
  assert.deepEqual(t.calls(), []);
  const env = { DG_EVENT: 'workflow_dispatch', DG_EXECUTOR_INPUT: 'true', SBAT_DEPLOYMENT_ID: DEPLOY };
  t = setup();
  r = t.run('rollback', { ...env, ROLLBACK_VERSION: '1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(dv(t), 1);
  assert.equal(t.read().deployments.length, 2);
  assert.ok(!t.cmds().includes('push'), 'rollback never pushes source');
  noLeak(r, t);
  for (const v of ['', 'abc', '0', '99', '2']) {
    t = setup();
    r = t.run('rollback', { ...env, ROLLBACK_VERSION: v });
    assert.notEqual(r.status, 0, 'version ' + v);
    assert.ok(!t.cmds().includes('update-deployment'));
  }
  t = setup({ files: { ...blankFiles(), 'BookingFoo.gs': '' } });
  r = t.run('rollback', { ...env, ROLLBACK_VERSION: '1' });
  assert.notEqual(r.status, 0);
  assert.ok(!t.cmds().includes('update-deployment'));
});

test('the dispatch-gate and ID commands work end to end through the CLI without echoing inputs', () => {
  const cli = (args, env) => spawnSync('node', [path.join(root, 'scripts/switchbot-access-test-gas-deploy-lib.js'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  let r = cli(['dispatch-gate'], { DG_EVENT: 'workflow_dispatch', DG_REF: 'refs/heads/main', DG_ACTION: 'NOT_SELECTED' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), 'ACTION_NOT_SELECTED');
  r = cli(['dispatch-gate'], { DG_EVENT: 'push', DG_REF: 'refs/heads/main' });
  assert.equal(r.stdout.trim(), 'OK');
  r = cli(['check-ids'], { SBAT_SCRIPT_ID: PROD_SCRIPT, SBAT_FORBIDDEN_IDS: PROD_SCRIPT });
  assert.equal(r.stdout.trim(), 'SCRIPT_ID_MATCHES_OTHER_PROJECT');
  assert.ok(!(r.stdout + r.stderr).includes(PROD_SCRIPT));
  assert.equal(cli(['bogus'], {}).status, 64);
});

test('docs: the runbook exists and states the gates (kill switch, separate deployment gate, diagnostics review, 1 step at a time)', () => {
  const doc = read('docs/switchbot-access-test-gas-deploy-787.md');
  for (const re of [/switchbot-access-test/, /SWITCHBOT_ACCESS_TEST_DEPLOY_ENABLED/, /SWITCHBOT_ACCESS_TEST_FORBIDDEN_IDS/, /accessReadOnlyDiagnostics/, /#756/, /ソース反映のみ/, /ロールバック/, /1ステップ/]) assert.match(doc, re);
  assert.doesNotMatch(doc, /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Z])[A-Za-z0-9_]{32,}\b/, 'no secret-like long tokens');
});

// ---- Issue #804 PR-C2: 更新前の読取り確認（preflight）の境界・kill switch・source-only・説明文の完全一致 ----
test('preflight boundary: no write precedes the preflight line (source-only, fixed deployment, rollback)', () => {
  for (const [mode, env] of [['deploy', {}], ['deploy', { SBAT_DEPLOYMENT_ID: DEPLOY }], ['rollback', { SBAT_DEPLOYMENT_ID: DEPLOY, ROLLBACK_VERSION: '1' }]]) {
    const t = setup();
    const r = t.run(mode, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Preflight passed \(read-only checks complete; the first write follows\)/);
    assert.match(t.sum(), /更新前の読取り確認（preflight）: 成功/);
    assert.ok(!t.calls().includes('WRITE_BEFORE_PREFLIGHT'), 'a write happened before the preflight boundary');
  }
});

test('kill switch OFF: no credential access, no clasp call, no preflight, zero writes (even with invalid inputs)', () => {
  for (const [mode, env] of [['deploy', {}], ['rollback', { ROLLBACK_VERSION: 'abc', SBAT_DEPLOYMENT_ID: DEPLOY }], ['deploy', { GITHUB_SHA: 'bad' }]]) {
    const t = setup();
    const r = t.run(mode, { DG_ENABLED: 'false', ...env });
    assert.equal(r.status, 0);
    assert.deepEqual(t.calls(), []);
    assert.doesNotMatch(r.stdout, /Preflight passed/);
    assert.deepEqual(fs.readdirSync(t.tmp), []);
  }
});

test('source-only exception is kept: no fixed deployment means checks, then source push only, and the summary never claims a published update', () => {
  const t = setup();
  const r = t.run('deploy');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.cmds().every((c) => ['pull', 'push'].includes(c)), t.cmds().join());
  assert.match(t.sum(), /Webアプリ公開・Deployment更新は行わない/);
  assert.match(t.sum(), /公開版（Deployment）の更新は行っておらず検証もしていません/);
  assert.doesNotMatch(t.sum(), /公開バージョン更新/);
  const rb = setup().run('rollback');
  assert.notEqual(rb.status, 0, 'rollback is refused in source-only state');
});

test('every read-only failure before the boundary stops with zero writes and no preflight line', () => {
  const dep = { SBAT_DEPLOYMENT_ID: DEPLOY };
  const cases = [
    ['pull fails', 'deploy', { FAKE_FAIL: 'pull' }],
    ['list-deployments fails', 'deploy', { ...dep, FAKE_FAIL: 'list-deployments' }],
    ['list-versions fails', 'deploy', { ...dep, FAKE_FAIL: 'list-versions' }],
    ['rollback: unknown version', 'rollback', { ...dep, ROLLBACK_VERSION: '99' }],
    ['rollback: already at that version', 'rollback', { ...dep, ROLLBACK_VERSION: '2' }],
    ['rollback: list fails', 'rollback', { ...dep, ROLLBACK_VERSION: '1', FAKE_FAIL: 'list-deployments' }],
    ['unlisted deployment id', 'deploy', { SBAT_DEPLOYMENT_ID: 'AKfycbxNOTLISTED000000' }]
  ];
  for (const [name, mode, env] of cases) {
    const t = setup();
    const r = t.run(mode, env);
    assert.notEqual(r.status, 0, name);
    assert.doesNotMatch(r.stdout, /Preflight passed/, name);
    assert.ok(!t.cmds().includes('push') && !t.cmds().includes('update-deployment'), name);
    assert.ok(!t.calls().includes('WRITE_BEFORE_PREFLIGHT'), name);
    noLeak(r, t);
  }
});

test('invalid rollback/SHA inputs stop before any clasp call or credential file', () => {
  for (const [mode, env] of [['rollback', { SBAT_DEPLOYMENT_ID: DEPLOY, ROLLBACK_VERSION: 'abc' }], ['rollback', { SBAT_DEPLOYMENT_ID: DEPLOY, ROLLBACK_VERSION: '0' }], ['deploy', { GITHUB_SHA: 'not-a-sha' }]]) {
    const t = setup();
    const before = JSON.stringify(t.read());
    const r = t.run(mode, env);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.deepEqual(t.calls(), []);
    assert.equal(JSON.stringify(t.read()), before);
    assert.deepEqual(fs.readdirSync(t.tmp), []);
  }
});

test('list errors are reported by the fixed classifier only (no raw output) and nothing is written', () => {
  const t = setup();
  const r = t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY, FAKE_FAIL: 'list-deployments', FAKE_LEAK: SCRIPT });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /clasp list-deployments failed \(before update\): [A-Z_]+/);
  assert.ok(!t.cmds().includes('push'));
  noLeak(r, t);
});

test('post-update description must match exactly: extra text is UNKNOWN_STATE, never success, and nothing is re-run', () => {
  for (const suffix of [' extra', '; previous main ' + 'c'.repeat(40)]) {
    const t = setup();
    const r = t.run('deploy', { SBAT_DEPLOYMENT_ID: DEPLOY, FAKE_DESC_SUFFIX: suffix });
    assert.notEqual(r.status, 0, suffix);
    assert.match(r.stderr, /UNKNOWN_STATE/);
    assert.equal(t.cmds().filter((c) => c === 'update-deployment').length, 1);
    assert.equal(t.cmds().filter((c) => c === 'push').length, 1);
    noLeak(r, t);
  }
});
