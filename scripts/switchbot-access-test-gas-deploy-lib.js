#!/usr/bin/env node
'use strict';

/*
 * Issue #787: SwitchBot Access Test（検証専用・独立GAS）へのclaspコード反映の補助ロジック。
 * 本番用（#768/#778）の switchbot-access-gas-deploy-lib.js は「読み取り専用で再利用」するだけで、変更しない。
 * 本番側の純関数（配布物検査・Deployment照合・ソース照合・認証JSON形式）だけを共有し、
 * Secrets名・Environment・起動条件・ゲートは検証専用（SBAT_* / switchbot-access-test）で独立させる。
 * 判定結果は固定の短い語（または数値）だけを標準出力へ返す。ID・認証情報・clasp生出力は出さない。
 */
const fs = require('node:fs');
const path = require('node:path');
const prod = require('./switchbot-access-gas-deploy-lib.js');

// 検証GASを更新するかの判断に使う対象パス（本番の配布対象と同一コード＋検証専用の配布ファイル）。
const TARGET_PATHS = [
  'gas/switchbot-access',
  'gas/booking/shared/AccessKeySnapshot.gs',
  'scripts/prepare-switchbot-access-gas-project.js',
  'scripts/deploy-switchbot-access-test-gas.sh',
  'scripts/switchbot-access-test-gas-deploy-lib.js',
  '.github/workflows/switchbot-access-test-gas-deploy.yml'
];

const SCRIPT_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
const FORBIDDEN_REMOTE_PREFIXES = ['Booking', 'Survey', 'SwitchBotVerify'];
// 空の新規GASが持つ既定ファイル（Code.gs のみ・小さい）。これ以外の .gs を持つ未知のプロジェクトへは書かない。
const BLANK_REMOTE_GS = ['Code.gs'];
const BLANK_MAX_BYTES = 4096;

const s = (v) => (typeof v === 'string' ? v : '');

/** 秘密のID群（カンマ・空白・改行区切り）を配列へ。値は出力しない。 */
function parseIdList(raw) {
  return s(raw).split(/[\s,]+/).filter(Boolean);
}

/**
 * 検証用 Script ID / Deployment ID の正当性。更新前に必ず通す。
 * forbidden は本番・Booking・旧switchbot-verify のScript/Deployment IDを運営者がSecretsへ登録した拒否リスト。
 * 未登録は fail closed（誤接続を検出できないため停止）。
 */
function checkIds(i) {
  const script = s(i.scriptId).trim();
  const deployment = s(i.deploymentId).trim();
  if (script === '') return 'SCRIPT_ID_MISSING';
  if (!SCRIPT_ID_PATTERN.test(script)) return 'SCRIPT_ID_INVALID';
  const forbidden = parseIdList(i.forbiddenIds);
  if (forbidden.length === 0) return 'FORBIDDEN_IDS_NOT_CONFIGURED';
  if (forbidden.includes(script)) return 'SCRIPT_ID_MATCHES_OTHER_PROJECT';
  if (deployment !== '') {
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(deployment)) return 'DEPLOYMENT_ID_INVALID';
    if (deployment === script) return 'DEPLOYMENT_ID_EQUALS_SCRIPT_ID';
    if (forbidden.includes(deployment)) return 'DEPLOYMENT_ID_MATCHES_OTHER_PROJECT';
  }
  return 'OK';
}

/**
 * 実行時の起動・運営者宣言の検査（Environment変数を読むため、deploy/rollback job内で行う）。
 * kill switch（DEPLOY_ENABLED）がtrue以外なら停止。実行主体の一致は push では Environment変数、
 * workflow_dispatch では入力で、いずれも運営者の宣言（実測ではない）。
 */
function checkRun(i) {
  const event = s(i.event);
  if (event !== 'push' && event !== 'workflow_dispatch') return 'NOT_PUSH_OR_DISPATCH';
  if (s(i.ref) !== 'refs/heads/main') return 'BRANCH_NOT_MAIN';
  if (s(i.enabled) !== 'true') return 'DEPLOY_DISABLED';
  const executor = event === 'push' ? s(i.executorVar) : s(i.executorInput);
  if (executor !== 'true') return 'EXECUTOR_NOT_CONFIRMED';
  return 'OK';
}

/** 秘密を使わない入口gate（起動条件・操作の整合）。 */
function checkDispatch(i) {
  const event = s(i.event);
  if (event !== 'push' && event !== 'workflow_dispatch') return 'NOT_PUSH_OR_DISPATCH';
  if (s(i.ref) !== 'refs/heads/main') return 'BRANCH_NOT_MAIN';
  const action = event === 'push' ? 'deploy' : s(i.action);
  if (action === '' || action === 'NOT_SELECTED') return 'ACTION_NOT_SELECTED';
  if (action !== 'deploy' && action !== 'rollback') return 'INVALID_ACTION';
  const version = s(i.rollbackVersion);
  if (action === 'deploy') {
    if (version !== '') return 'ROLLBACK_INPUT_WITH_DEPLOY';
  } else if (!/^[1-9][0-9]{0,5}$/.test(version)) return 'ROLLBACK_VERSION_REQUIRED';
  return 'OK';
}

/** 空の新規GAS（または検証GAS）だけを許す。Booking/Survey/旧verify は拒否。 */
function checkRemoteTarget(remoteDir) {
  const names = fs.existsSync(remoteDir) ? fs.readdirSync(remoteDir) : [];
  if (names.some((n) => FORBIDDEN_REMOTE_PREFIXES.some((p) => n.startsWith(p)))) return 'TARGET_MISMATCH_OTHER_PROJECT';
  if (prod.checkRemoteTarget(remoteDir) === 'OK') return 'OK';
  const gs = names.filter((n) => n.endsWith('.gs') || n.endsWith('.js') || n.endsWith('.html'));
  const blank = gs.every((n) => BLANK_REMOTE_GS.includes(n) && fs.statSync(path.join(remoteDir, n)).size <= BLANK_MAX_BYTES);
  return blank ? 'OK_BLANK' : 'TARGET_MISMATCH_UNKNOWN_PROJECT';
}

/**
 * マニフェスト検査（検証専用）。リモートがwebapp設定を持つ場合は実行ユーザー・アクセス権が配布物と一致すること
 * （手動設定を黙って変えない）。リモートの依存が配布物に無い場合は停止。新scopeは初回承認前の空GASでは
 * 問題にならないため止めず、反映後に運営者が承認する（手順書）。
 */
function checkManifest(remoteFile, repoFile, rollback) {
  let remote; let repo;
  try { remote = JSON.parse(fs.readFileSync(remoteFile, 'utf8')); repo = JSON.parse(fs.readFileSync(repoFile, 'utf8')); } catch (_) {
    return 'MANIFEST_UNREADABLE';
  }
  if (remote.webapp) {
    if (!repo.webapp || remote.webapp.access !== repo.webapp.access || remote.webapp.executeAs !== repo.webapp.executeAs) return 'MANIFEST_WEBAPP_MISMATCH';
  }
  if (rollback) return 'OK';
  if (!repo.webapp || repo.webapp.executeAs !== 'USER_DEPLOYING') return 'MANIFEST_EXECUTOR_UNEXPECTED';
  const rem = (remote.dependencies && remote.dependencies.enabledAdvancedServices) || [];
  const rep = (repo.dependencies && repo.dependencies.enabledAdvancedServices) || [];
  const key = (x) => [x.userSymbol, x.serviceId, x.version].join('|');
  if (!Array.isArray(rem) || !Array.isArray(rep)) return 'MANIFEST_DEPENDENCIES_UNREADABLE';
  // enabledAdvancedServices 以外の依存（libraries等）がリモートにあれば、manifest置換で黙って消えるため停止。
  const empty = (v) => (Array.isArray(v) ? v.length === 0 : v && typeof v === 'object' ? Object.keys(v).length === 0 : !v);
  const remoteDeps = remote.dependencies || {};
  if (Object.keys(remoteDeps).some((k) => k !== 'enabledAdvancedServices' && !empty(remoteDeps[k]))) return 'MANIFEST_REMOTE_DEPENDENCY_WOULD_BE_REMOVED';
  if (rem.some((x) => !rep.map(key).includes(key(x)))) return 'MANIFEST_REMOTE_DEPENDENCY_WOULD_BE_REMOVED';
  return 'OK';
}

function main(argv, env) {
  const [cmd, ...a] = argv;
  const out = (v, ok) => { process.stdout.write(v + '\n'); return v === (ok || 'OK') ? 0 : 1; };
  switch (cmd) {
    case 'dispatch-gate':
      return out(checkDispatch({ event: env.DG_EVENT, ref: env.DG_REF, action: env.DG_ACTION, rollbackVersion: env.DG_ROLLBACK_VERSION }));
    case 'check-run':
      return out(checkRun({ event: env.DG_EVENT, ref: env.DG_REF, enabled: env.DG_ENABLED, executorVar: env.DG_EXECUTOR_VAR, executorInput: env.DG_EXECUTOR_INPUT }));
    case 'check-ids':
      return out(checkIds({ scriptId: env.SBAT_SCRIPT_ID, deploymentId: env.SBAT_DEPLOYMENT_ID, forbiddenIds: env.SBAT_FORBIDDEN_IDS }));
    case 'has-deployment-id': return s(env.SBAT_DEPLOYMENT_ID).trim() === '' ? 1 : 0;
    case 'target-paths': process.stdout.write(TARGET_PATHS.join('\n') + '\n'); return 0;
    case 'check-bundle': return out(prod.checkBundle(a[0]));
    case 'check-remote': { const r = checkRemoteTarget(a[0]); process.stdout.write(r + '\n'); return r.startsWith('OK') ? 0 : 1; }
    case 'check-manifest': return out(checkManifest(a[0], a[1], a[2] === 'rollback'));
    case 'compare-sources': return out(prod.compareSources(a[0], a[1]));
    case 'check-credential': return out(prod.checkCredential(env.SBAT_CLASPRC_JSON || ''));
    case 'pick-deployment': {
      const r = prod.pickDeployment(fs.readFileSync(a[0], 'utf8'), env.SBAT_DEPLOYMENT_ID || '');
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      process.stdout.write(String(r.versionNumber) + '\n'); return 0;
    }
    case 'deployment-matches': {
      const r = prod.pickDeployment(fs.readFileSync(a[0], 'utf8'), env.SBAT_DEPLOYMENT_ID || '');
      if (r.error) { process.stderr.write(r.error + '\n'); return 2; }
      if (a[1] !== 'any' && r.versionNumber !== Number(a[1])) return 1;
      if (a[2] && a[2] !== '-' && !r.description.includes(a[2])) return 1;
      return 0;
    }
    case 'max-version': {
      const r = prod.parseVersions(fs.readFileSync(a[0], 'utf8'));
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      process.stdout.write(String(r.max) + '\n'); return 0;
    }
    case 'has-version': {
      const r = prod.parseVersions(fs.readFileSync(a[0], 'utf8'));
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      return r.numbers.includes(Number(a[1])) ? 0 : 1;
    }
    case 'describe-version': process.stdout.write(prod.describeVersion(fs.readFileSync(a[0], 'utf8'), a[1]) + '\n'); return 0;
    case 'write-config': { // <authFile> <projectDir>
      fs.writeFileSync(a[0], env.SBAT_CLASPRC_JSON || '', { mode: 0o600 });
      fs.writeFileSync(path.join(a[1], '.clasp.json'), JSON.stringify({ scriptId: env.SBAT_SCRIPT_ID || '', rootDir: '.', scriptExtensions: ['gs'] }), { mode: 0o600 });
      return 0;
    }
    default: process.stderr.write('unknown command\n'); return 64;
  }
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2), process.env); } catch (_) {
    process.stderr.write('helper failed\n'); code = 70;
  }
  process.exit(code);
}

module.exports = { TARGET_PATHS, checkIds, checkRun, checkDispatch, checkRemoteTarget, checkManifest, parseIdList };
