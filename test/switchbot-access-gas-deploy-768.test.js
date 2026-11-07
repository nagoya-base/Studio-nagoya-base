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
test('workflow (#778): workflow_dispatch is the ONLY trigger; push/PR/schedule/fork triggers are absent', () => {
  const on = wf.slice(wf.indexOf('\non:\n'), wf.indexOf('\npermissions:'));
  assert.match(on, /\non:\n  workflow_dispatch:/);
  assert.doesNotMatch(on, /\n  (push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch|release):/);
  assert.doesNotMatch(on, /paths:|branches:/);
  // 旧リポジトリ変数に一切依存しない（残っていてもpushで本番に到達しない）
  const code = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(code, /SWITCHBOT_ACCESS_AUTODEPLOY|SWITCHBOT_ACCESS_EXECUTOR_CONFIRMED|\bvars\./);
  assert.doesNotMatch(code, /github\.event_name == 'push'/);
});

test('workflow (#778): required inputs, safe defaults (NOT_SELECTED / false) and no OFF default', () => {
  const inputs = wf.slice(wf.indexOf('    inputs:\n'), wf.indexOf('\npermissions:'));
  for (const name of ['deployment_action', 'safety_confirmed', 'access_state', 'executor_confirmed',
    'change_approval_reference', 'rollback_version', 'rollback_compat_confirmed']) {
    assert.match(inputs, new RegExp('\\n      ' + name + ':\\n'), name);
  }
  assert.match(inputs, /deployment_action:[\s\S]*?required: true\n\s+type: choice\n\s+default: 'NOT_SELECTED'\n\s+options:\n\s+- 'NOT_SELECTED'\n\s+- 'deploy'\n\s+- 'rollback'/);
  assert.match(inputs, /access_state:[\s\S]*?required: true\n\s+type: choice\n\s+default: 'NOT_SELECTED'\n\s+options:\n\s+- 'NOT_SELECTED'\n\s+- 'OFF_CONFIRMED'\n\s+- 'ON_CHANGE_APPROVED'/);
  assert.match(inputs, /safety_confirmed:[\s\S]*?required: true\n\s+type: boolean\n\s+default: false/);
  assert.match(inputs, /executor_confirmed:[\s\S]*?required: true\n\s+type: boolean\n\s+default: false/);
  assert.match(inputs, /rollback_compat_confirmed:[\s\S]*?type: boolean\n\s+default: false/);
  assert.doesNotMatch(inputs, /default: 'OFF_CONFIRMED'|default: 'ON_CHANGE_APPROVED'|default: true/);
});

test('workflow (#778): the gate validates all inputs via env (no direct ${{ }} in run), fails closed and checks the main head', () => {
  const gate = wf.slice(wf.indexOf('\n  gate:'), wf.indexOf('\n  test:'));
  assert.doesNotMatch(gate, /environment:|secrets\./);
  assert.match(gate, /node scripts\/switchbot-access-gas-deploy-lib\.js dispatch-gate/);
  for (const v of ['DG_EVENT', 'DG_REF', 'DG_ACTION', 'DG_SAFETY', 'DG_ACCESS_STATE', 'DG_EXECUTOR', 'DG_APPROVAL_REF', 'DG_ROLLBACK_VERSION', 'DG_ROLLBACK_COMPAT']) {
    assert.match(gate, new RegExp(v + ': \\$\\{\\{ (inputs|github)\\.'), v);
  }
  const run = gate.slice(gate.indexOf('run: |'));
  assert.doesNotMatch(run, /\$\{\{/, 'inputs must never be expanded inside the script body');
  assert.match(run, /STALE_SHA_NOT_MAIN_HEAD/);
  assert.match(run, /git rev-parse FETCH_HEAD\)" == "\$GITHUB_SHA"/);
  assert.match(run, /exit 1/);
});

test('workflow (#778): test/approve_on have no secrets; only deploy/rollback use the production environment', () => {
  assert.equal((wf.match(/^\s+environment: switchbot-access-production$/gm) || []).length, 2);
  assert.equal((wf.match(/^\s+environment: switchbot-access-on-approval$/gm) || []).length, 1);
  assert.doesNotMatch(wf, /environment: (?!switchbot-access-production$|switchbot-access-on-approval$)/m);
  const wfCode = wf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(wfCode, /switchbot-verify|SWITCHBOT_VERIFY|booking-production|BOOKING_|SBV_/);
  for (const [from, to] of [['\n  gate:', '\n  test:'], ['\n  test:', '\n  approve_on:'], ['\n  approve_on:', '\n  deploy:']]) {
    const job = wf.slice(wf.indexOf(from), wf.indexOf(to));
    assert.doesNotMatch(job, /secrets\./);
  }
  assert.doesNotMatch(wf.slice(wf.indexOf('\n  gate:'), wf.indexOf('\n  approve_on:')), /environment:/);
  assert.match(wf, /\n    needs: \[gate, test, approve_on\]\n/);
  assert.match(wf, /\n    needs: \[gate, approve_on\]\n/);
});

test('workflow (#778): deploy/rollback never run unless the gate succeeded; ON requires the independent approval job', () => {
  for (const job of ['deploy', 'rollback']) {
    const text = wf.slice(wf.indexOf('\n  ' + job + ':'));
    const cond = text.slice(text.indexOf('if: >-'), text.indexOf('runs-on:'));
    assert.match(cond, /!cancelled\(\)/);
    assert.match(cond, /github\.ref == 'refs\/heads\/main'/);
    assert.match(cond, /needs\.gate\.result == 'success'/);
    assert.match(cond, /needs\.gate\.outputs\.valid == 'true'/);
    assert.match(cond, new RegExp("needs\\.gate\\.outputs\\.mode == '" + job + "'"));
    assert.match(cond, /OFF_CONFIRMED'\s+\|\| \(needs\.gate\.outputs\.access_state == 'ON_CHANGE_APPROVED' && needs\.approve_on\.result == 'success'\)/);
  }
  const deployCond = wf.slice(wf.indexOf('\n  deploy:'));
  assert.match(deployCond.slice(0, deployCond.indexOf('runs-on:')), /needs\.test\.result == 'success'/);
  const approve = wf.slice(wf.indexOf('\n  approve_on:'), wf.indexOf('\n  deploy:'));
  assert.match(approve, /access_state == 'ON_CHANGE_APPROVED'/);
  assert.match(approve, /needs\.gate\.outputs\.valid == 'true'/);
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
const okIn = () => ({ event: 'workflow_dispatch', ref: 'refs/heads/main', action: 'deploy', safety: 'true', accessState: 'OFF_CONFIRMED',
  executor: 'true', approvalRef: '', rollbackVersion: '', rollbackCompat: 'false' });
const gateOf = (o) => lib.checkDispatch({ ...okIn(), ...o });

test('lib.checkDispatch (#778): OFF deploy, ON deploy with approval reference and rollback with compat pass', () => {
  assert.equal(gateOf({}), 'OK');
  assert.equal(gateOf({ accessState: 'ON_CHANGE_APPROVED', approvalRef: '#999' }), 'OK');
  assert.equal(gateOf({ accessState: 'ON_CHANGE_APPROVED', approvalRef: 'REC-2026-11/05' }), 'OK');
  assert.equal(gateOf({ action: 'rollback', rollbackVersion: '12', rollbackCompat: 'true' }), 'OK');
  assert.equal(gateOf({ rollbackCompat: '' }), 'OK');
});

test('lib.checkDispatch (#778): push/PR/schedule, other branches, empty and unselected inputs are all refused', () => {
  for (const event of ['push', 'pull_request', 'schedule', 'workflow_run', '', undefined]) assert.equal(gateOf({ event }), 'NOT_MANUAL_DISPATCH');
  for (const ref of ['refs/heads/feature', 'refs/pull/1/merge', 'refs/tags/v1', 'main', '', undefined]) assert.equal(gateOf({ ref }), 'BRANCH_NOT_MAIN');
  assert.equal(lib.checkDispatch({}), 'NOT_MANUAL_DISPATCH', 'no input at all');
  for (const action of ['', 'NOT_SELECTED', undefined]) assert.equal(gateOf({ action }), 'ACTION_NOT_SELECTED');
  for (const action of ['Deploy', 'run', 'deploy ', 'true']) assert.equal(gateOf({ action }), 'INVALID_ACTION');
  for (const safety of ['', 'false', 'True', '1', 'yes', undefined, true]) assert.equal(gateOf({ safety }), 'SAFETY_NOT_CONFIRMED');
  for (const accessState of ['', 'NOT_SELECTED', undefined]) assert.equal(gateOf({ accessState }), 'ACCESS_STATE_NOT_SELECTED');
  for (const accessState of ['OFF', 'FLAG_OFF', 'FLAG_ON_APPROVED', 'off_confirmed', 'ON']) assert.equal(gateOf({ accessState }), 'INVALID_ACCESS_STATE');
  for (const executor of ['', 'false', 'True', undefined]) assert.equal(gateOf({ executor }), 'EXECUTOR_NOT_CONFIRMED');
});

test('lib.checkDispatch (#778): ON needs a non-empty, non-secret-shaped approval reference', () => {
  const on = { accessState: 'ON_CHANGE_APPROVED' };
  for (const approvalRef of ['', '   ', undefined]) assert.equal(gateOf({ ...on, approvalRef }), 'APPROVAL_REFERENCE_REQUIRED');
  for (const approvalRef of ['has space', 'a;b', '$(x)', 'x\ny', 'https://x.example/?token=1', '-lead', 'a'.repeat(65)]) {
    assert.equal(gateOf({ ...on, approvalRef }), 'APPROVAL_REFERENCE_INVALID', approvalRef);
  }
});

test('lib.checkDispatch (#778): contradictory deploy/rollback inputs fail closed', () => {
  assert.equal(gateOf({ rollbackVersion: '3' }), 'ROLLBACK_INPUT_WITH_DEPLOY');
  assert.equal(gateOf({ rollbackCompat: 'true' }), 'ROLLBACK_INPUT_WITH_DEPLOY');
  assert.equal(gateOf({ rollbackCompat: 'maybe' }), 'INVALID_ROLLBACK_COMPAT');
  const rb = { action: 'rollback', rollbackVersion: '3', rollbackCompat: 'true' };
  for (const rollbackVersion of ['', '0', '-1', 'abc', '1.5', '01', '1234567', '3; rm', undefined]) assert.equal(gateOf({ ...rb, rollbackVersion }), 'ROLLBACK_VERSION_REQUIRED');
  for (const rollbackCompat of ['', 'false', 'True', undefined]) assert.equal(gateOf({ ...rb, rollbackCompat }), 'ROLLBACK_COMPAT_NOT_CONFIRMED');
  // rollbackでもON時は承認参照が要る
  assert.equal(gateOf({ ...rb, accessState: 'ON_CHANGE_APPROVED' }), 'APPROVAL_REFERENCE_REQUIRED');
  assert.equal(gateOf({ ...rb, accessState: 'ON_CHANGE_APPROVED', approvalRef: '#1' }), 'OK');
});

test('lib: the legacy repository-variable gate is gone', () => {
  assert.equal(lib.checkGate, undefined);
  assert.equal(lib.GATE_VALUES, undefined);
  assert.doesNotMatch(libText, /FLAG_OFF|FLAG_ON_APPROVED|AUTODEPLOY/);
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

test('Issue #780: Sheets API v4 依存の宣言・同期・予期しない依存/除去の安全停止', () => {
  const repoManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', 'appsscript.json'), 'utf8'));
  // 配布manifestに承認済みSheets v4のみ。scope/webapp維持、新規API権限なし。
  assert.deepEqual(repoManifest.dependencies, { enabledAdvancedServices: [{ userSymbol: 'Sheets', serviceId: 'sheets', version: 'v4' }] });
  assert.ok(repoManifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets.readonly'));
  assert.ok(!repoManifest.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets'));
  assert.deepEqual(repoManifest.webapp, { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' });
  // 実行コードはAdvancedサービス(Sheets.)を呼ばない（REST GETのみ）
  const src = fs.readFileSync(path.join(__dirname, '..', 'gas', 'switchbot-access', 'AccessLedgerReader.gs'), 'utf8');
  assert.ok(!/\bSheets\.Spreadsheets/.test(src));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-d-'));
  const w = (n, o) => { const f = path.join(dir, n); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  const sheets = { userSymbol: 'Sheets', serviceId: 'sheets', version: 'v4' };
  const base = { webapp: { access: 'ANYONE_ANONYMOUS', executeAs: 'USER_DEPLOYING' }, oauthScopes: ['a'] };
  const withDeps = (d) => ({ ...base, dependencies: d });
  const okDeps = { enabledAdvancedServices: [sheets] };
  // リモートに既にある／無い場合とも承認済みSheetsは同期できる
  assert.equal(lib.checkManifest(w('a1', withDeps(okDeps)), w('b1', withDeps(okDeps))), 'OK');
  assert.equal(lib.checkManifest(w('a2', withDeps({})), w('b2', withDeps(okDeps))), 'OK');
  // 配布側の未承認サービス・ライブラリは停止
  const drive = { userSymbol: 'Drive', serviceId: 'drive', version: 'v3' };
  assert.equal(lib.checkManifest(w('a3', withDeps(okDeps)), w('b3', withDeps({ enabledAdvancedServices: [sheets, drive] }))), 'MANIFEST_UNAPPROVED_DEPENDENCY');
  assert.equal(lib.checkManifest(w('a4', withDeps(okDeps)), w('b4', withDeps({ ...okDeps, libraries: [{ userSymbol: 'L', libraryId: 'x', version: '1' }] }))), 'MANIFEST_UNAPPROVED_DEPENDENCY');
  assert.equal(lib.checkManifest(w('a5', withDeps(okDeps)), w('b5', withDeps({ enabledAdvancedServices: [{ ...sheets, version: 'v3' }] }))), 'MANIFEST_UNAPPROVED_DEPENDENCY');
  // リモートの依存が配布側に無い＝push --force で除去される → 停止
  assert.equal(lib.checkManifest(w('a6', withDeps(okDeps)), w('b6', withDeps({}))), 'MANIFEST_REMOTE_DEPENDENCY_WOULD_BE_REMOVED');
  assert.equal(lib.checkManifest(w('a7', withDeps({ enabledAdvancedServices: [sheets, drive] })), w('b7', withDeps(okDeps))), 'MANIFEST_REMOTE_DEPENDENCY_WOULD_BE_REMOVED');
  assert.equal(lib.checkManifest(w('a8', withDeps({ enabledAdvancedServices: 'x' })), w('b8', withDeps(okDeps))), 'MANIFEST_DEPENDENCIES_UNREADABLE');
  // webapp変更は従来どおり停止、rollback(webapp-only)は依存を見ない
  assert.equal(lib.checkManifest(w('a9', withDeps({})), w('b9', withDeps(okDeps)), 'webapp-only'), 'OK');
  // 配布物にSheetsが無ければ配布しない
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-b-'));
  require('../scripts/prepare-switchbot-access-gas-project.js').prepareProject(bundle);
  assert.equal(lib.checkBundle(bundle), 'OK');
  fs.writeFileSync(path.join(bundle, 'appsscript.json'), JSON.stringify({ ...repoManifest, dependencies: {} }));
  assert.equal(lib.checkBundle(bundle), 'BUNDLE_SHEETS_SERVICE_MISSING');
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
const sumf=process.env.GITHUB_STEP_SUMMARY; const preflightDone=!!sumf&&fs.existsSync(sumf)&&fs.readFileSync(sumf,'utf8').includes('preflight');
if((cmd==='push'||cmd==='update-deployment')&&!preflightDone)fs.appendFileSync(S+'/calls.log','WRITE_BEFORE_PREFLIGHT\\n');
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
  const d=s.deployments.find(x=>x.deploymentId===id); d.versionNumber=v; d.description=a[di+1]+(process.env.FAKE_DESC_SUFFIX||'');
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
  // clasp が一度も呼ばれない（入力検査でGoogleに触れる前に停止した）場合は記録ファイルが無い＝0回。
  const calls = () => (fs.existsSync(path.join(state, 'calls.log'))
    ? fs.readFileSync(path.join(state, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
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

test('write-config pins scriptExtensions to gs (clasp 3.x pulls .js by default) and the dispatch-gate command works end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sba-cfg-'));
  const libFile = path.join(root, 'scripts/switchbot-access-gas-deploy-lib.js');
  const r = spawnSync('node', [libFile, 'write-config', path.join(dir, 'a.json'), dir, 'x'],
    { env: { ...process.env, SBA_CLASPRC_JSON: '{}', SBA_SCRIPT_ID: 'S' } });
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.clasp.json'), 'utf8')).scriptExtensions, ['gs']);
  const cli = (env) => spawnSync('node', [libFile, 'dispatch-gate'], { env: { PATH: process.env.PATH, ...env } });
  const good = { DG_EVENT: 'workflow_dispatch', DG_REF: 'refs/heads/main', DG_ACTION: 'deploy', DG_SAFETY: 'true',
    DG_ACCESS_STATE: 'OFF_CONFIRMED', DG_EXECUTOR: 'true', DG_APPROVAL_REF: '', DG_ROLLBACK_VERSION: '', DG_ROLLBACK_COMPAT: 'false' };
  assert.equal(cli(good).stdout.toString().trim(), 'OK');
  assert.equal(cli(good).status, 0);
  const none = cli({});
  assert.equal(none.status, 1);
  assert.equal(none.stdout.toString().trim(), 'NOT_MANUAL_DISPATCH');
  assert.equal(cli({ ...good, DG_EVENT: 'push' }).status, 1);
  assert.equal(cli({ ...good, DG_ACCESS_STATE: 'NOT_SELECTED' }).stdout.toString().trim(), 'ACCESS_STATE_NOT_SELECTED');
  assert.equal(cli({ ...good, DG_ACCESS_STATE: 'ON_CHANGE_APPROVED' }).stdout.toString().trim(), 'APPROVAL_REFERENCE_REQUIRED');
});

// ---- Issue #804 PR-C2: 更新前の読取り確認（preflight）の境界・入力の早期検査・説明文の完全一致 ----
test('preflight boundary: no push/update-deployment runs before the preflight line (deploy and rollback)', () => {
  for (const [mode, env] of [['deploy', {}], ['rollback', { ROLLBACK_VERSION: '1' }]]) {
    const t = setup();
    const r = t.run(mode, env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Preflight passed \(read-only checks complete; the first write follows\)/);
    assert.match(fs.readFileSync(t.summary, 'utf8'), /更新前の読取り確認（preflight）: 成功/);
    assert.ok(!t.calls().includes('WRITE_BEFORE_PREFLIGHT'), 'a write happened before the preflight boundary');
    assert.ok(t.calls().includes(mode === 'deploy' ? 'push' : 'update-deployment'));
  }
});

test('every read-only failure before the boundary stops with zero writes and no preflight line', () => {
  const cases = [
    ['list-deployments fails', 'deploy', { FAKE_FAIL: 'list-deployments' }],
    ['list-versions fails', 'deploy', { FAKE_FAIL: 'list-versions' }],
    ['pull (target check) fails', 'deploy', { FAKE_FAIL: 'pull' }],
    ['rollback: list-deployments fails', 'rollback', { FAKE_FAIL: 'list-deployments', ROLLBACK_VERSION: '1' }],
    ['rollback: unknown version', 'rollback', { ROLLBACK_VERSION: '99' }],
    ['rollback: already at that version', 'rollback', { ROLLBACK_VERSION: '2' }],
    ['unconfigured deployment ID', 'deploy', { SBA_DEPLOYMENT_ID: 'AKfycbxNOTLISTED000000' }],
    ['credential has no default user', 'deploy', { SBA_CLASPRC_JSON: JSON.stringify({ tokens: { other: {} } }) }]
  ];
  for (const [name, mode, env] of cases) {
    const t = setup();
    const r = t.run(mode, env);
    assert.notEqual(r.status, 0, name);
    assert.doesNotMatch(r.stdout, /Preflight passed/, name);
    assert.ok(!t.calls().includes('push') && !t.calls().includes('update-deployment'), name);
    assert.ok(!t.calls().includes('WRITE_BEFORE_PREFLIGHT'), name);
    noLeak(r);
  }
});

test('invalid rollback/SHA inputs stop before any clasp call or credential file (fail fast, nothing touched)', () => {
  const cases = [
    ['rollback', { ROLLBACK_VERSION: 'abc' }], ['rollback', { ROLLBACK_VERSION: '0' }], ['rollback', { ROLLBACK_VERSION: '' }],
    ['rollback', { ROLLBACK_VERSION: '2', ROLLBACK_COMPAT_CONFIRMED: 'false' }],
    ['deploy', { GITHUB_SHA: 'not-a-sha' }], ['deploy', { GITHUB_SHA: 'A'.repeat(40) }]
  ];
  for (const [mode, env] of cases) {
    const t = setup();
    const before = JSON.stringify(t.read());
    const r = t.run(mode, env);
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.deepEqual(t.calls(), [], 'clasp was not called');
    assert.equal(JSON.stringify(t.read()), before);
    assert.deepEqual(fs.readdirSync(t.tmp), [], 'no credential/work file was created');
  }
});

test('post-update description must match exactly: extra text after the SHA is UNKNOWN_STATE, never success, and nothing is re-run', () => {
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
  const m = lib.descriptionMatches;
  const d = 'main ' + SHA;
  assert.equal(m(d, d), true);
  assert.equal(m('  ' + d + ' \n', d), true);
  for (const bad of [d + ' extra', 'previous ' + d, 'rollback of ' + d, 'main ' + 'b'.repeat(40) + ' ' + d, d + '0', '', 'main']) {
    assert.equal(m(bad, d), false, bad);
  }
});
