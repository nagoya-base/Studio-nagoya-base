#!/usr/bin/env node
'use strict';

/*
 * Issue #768: 鍵管理用・独立GAS（gas/switchbot-access/、#754）のclaspデプロイ補助ロジック。
 * #723（検証GAS）の補助ロジックを参考にした別実装（検証GAS側の変更が鍵管理側へ波及しないよう共有しない）。
 * シェル側（deploy-switchbot-access-gas.sh）から呼ばれ、判定結果は固定の短い語（または数値）だけを
 * 標準出力へ返す。clasp生出力・ID・認証情報は一切出力しない（エラー文面にも埋め込まない）。
 */
const fs = require('node:fs');
const path = require('node:path');

// 配布物（scripts/prepare-switchbot-access-gas-project.js の出力）。テストが prepare の FILES と一致を確認する。
const BUNDLE_FILES = [
  'AccessKeySnapshot.gs',
  'AccessLedgerReader.gs',
  'SwitchBotAccessApp.gs',
  'SwitchBotAccessCore.gs',
  'SwitchBotAccessInfra.gs',
  'appsscript.json'
];
// リモートが鍵管理GASであることを示す必須ファイル。
const REQUIRED_REMOTE_FILES = ['SwitchBotAccessApp.gs', 'SwitchBotAccessCore.gs'];
// 他プロジェクト（予約GAS・検証GAS・アンケートGAS）への誤接続を検出するための拒否プレフィックス。
// 共有の AccessKeySnapshot.gs は 'Booking' で始まらないため許容される。
const FORBIDDEN_REMOTE_PREFIXES = ['Booking', 'Survey', 'SwitchBotVerify'];
// デプロイ前の新鮮度確認（古いrunのスキップ）が参照する対象パス。
const TARGET_PATHS = [
  'gas/switchbot-access',
  'gas/booking/shared/AccessKeySnapshot.gs',
  'scripts/prepare-switchbot-access-gas-project.js',
  'scripts/deploy-switchbot-access-gas.sh',
  'scripts/switchbot-access-gas-deploy-lib.js',
  '.github/workflows/switchbot-access-gas-deploy.yml'
];

// Issue #780: 運営者が承認済みのAdvanced Google Services依存（Sheets API v4）。これ以外のサービス・ライブラリは
// 配布しない（新権限・意図しない依存を黙って混入させない）。コードはREST GETを使い、Advancedサービスを実行コードから呼ばない。
const APPROVED_ADVANCED_SERVICES = [{ userSymbol: 'Sheets', serviceId: 'sheets', version: 'v4' }];

const svcKey = (x) => (x && typeof x === 'object' ? [x.userSymbol, x.serviceId, x.version].join('|') : '?');
const approvedKeys = () => new Set(APPROVED_ADVANCED_SERVICES.map(svcKey));

/** dependencies を { services:Set, extra:boolean } に正規化する。enabledAdvancedServices 以外の依存（libraries等）は extra。 */
function readDependencies(manifest) {
  const d = (manifest && manifest.dependencies) || {};
  const services = Array.isArray(d.enabledAdvancedServices) ? d.enabledAdvancedServices : [];
  const extra = Object.keys(d).some((k) => k !== 'enabledAdvancedServices' && !(Array.isArray(d[k]) ? d[k].length === 0 : d[k] && typeof d[k] === 'object' ? Object.keys(d[k]).length === 0 : !d[k]));
  return { services: services.map(svcKey), extra, malformed: d.enabledAdvancedServices !== undefined && !Array.isArray(d.enabledAdvancedServices) };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** clasp list-deployments --json の出力から、指定IDの行を完全一致で1件だけ取り出す。 */
function pickDeployment(listJson, deploymentId) {
  let rows;
  try { rows = JSON.parse(listJson); } catch (_) { return { error: 'LIST_PARSE_FAILED' }; }
  if (!Array.isArray(rows)) return { error: 'LIST_PARSE_FAILED' };
  const matches = rows.filter((r) => r && r.deploymentId === deploymentId);
  if (matches.length === 0) return { error: 'DEPLOYMENT_ID_NOT_FOUND' };
  if (matches.length > 1) return { error: 'DEPLOYMENT_ID_NOT_UNIQUE' };
  const row = matches[0];
  // @HEAD（versionNumber無し）のDeploymentは「固定バージョン」ではないので更新対象にしない。
  if (!Number.isInteger(row.versionNumber) || row.versionNumber < 1) {
    return { error: 'DEPLOYMENT_NOT_VERSIONED' };
  }
  return { versionNumber: row.versionNumber, description: String(row.description || '') };
}

/** clasp list-versions --json の出力から、版番号の集合と最大値を返す。 */
/**
 * 更新後の説明文照合（Issue #804 PR-C2）。更新時に自分たちが指定した説明（例: `main <40桁SHA>`）と
 * **完全一致**する場合だけ成功にする。前置き・追記・別記載のSHAを含む部分一致は成功にしない
 * （許容は前後の空白のみ）。
 */
function descriptionMatches(actual, expected) {
  return String(actual).trim() === String(expected).trim();
}

function parseVersions(listJson) {
  let rows;
  try { rows = JSON.parse(listJson); } catch (_) { return { error: 'VERSIONS_PARSE_FAILED' }; }
  if (!Array.isArray(rows)) return { error: 'VERSIONS_PARSE_FAILED' };
  const numbers = rows.map((r) => r && r.versionNumber).filter((n) => Number.isInteger(n));
  return { numbers, max: numbers.length ? Math.max(...numbers) : 0 };
}

/** pull した既存プロジェクトが「鍵管理用・独立GAS」であることを確認する。 */
function checkRemoteTarget(remoteDir) {
  const names = fs.existsSync(remoteDir) ? fs.readdirSync(remoteDir) : [];
  if (!REQUIRED_REMOTE_FILES.every((f) => names.includes(f))) return 'TARGET_MISMATCH_NO_SWITCHBOT_ACCESS';
  if (names.some((n) => FORBIDDEN_REMOTE_PREFIXES.some((p) => n.startsWith(p)))) {
    return 'TARGET_MISMATCH_OTHER_PROJECT';
  }
  return 'OK';
}

/**
 * 手動で設定済みの公開設定を、デプロイで黙って変えない。
 * - webapp（実行ユーザー・アクセス権）がリモートとリポジトリで一致すること
 * - リポジトリのoauthScopesがリモートに全て含まれること（新scopeは再承認が要るため手動で先に行う）
 */
function checkManifest(remoteManifestFile, repoManifestFile, webappOnly) {
  let remote; let repo;
  try { remote = readJson(remoteManifestFile); repo = readJson(repoManifestFile); } catch (_) {
    return 'MANIFEST_UNREADABLE';
  }
  const rw = remote.webapp || {};
  const pw = repo.webapp || {};
  if (rw.access !== pw.access || rw.executeAs !== pw.executeAs) return 'MANIFEST_WEBAPP_MISMATCH';
  if (webappOnly) return 'OK';
  // 依存（Advanced Google Services）: 配布側は承認済みのみ。リモートにある依存が配布側に無い場合は
  // push --force で黙って除去され LEDGER_API_DISABLED に戻るため、配布せず停止する（#780）。
  const rd = readDependencies(remote);
  const pd = readDependencies(repo);
  if (rd.malformed || pd.malformed) return 'MANIFEST_DEPENDENCIES_UNREADABLE';
  const approved = approvedKeys();
  if (pd.extra || pd.services.some((k) => !approved.has(k))) return 'MANIFEST_UNAPPROVED_DEPENDENCY';
  if (rd.extra || rd.services.some((k) => !pd.services.includes(k))) return 'MANIFEST_REMOTE_DEPENDENCY_WOULD_BE_REMOVED';
  const remoteScopes = new Set(remote.oauthScopes || []);
  if ((repo.oauthScopes || []).some((s) => !remoteScopes.has(s))) return 'MANIFEST_NEW_OAUTH_SCOPE_REQUIRES_MANUAL_APPROVAL';
  return 'OK';
}

/**
 * 配布物の完全性・純度。ファイル名が BUNDLE_FILES と過不足なく一致し（Booking GAS本体・テスト・ログ・
 * 認証/環境ファイルが混入していない）、.gs が空でなく、manifest がWebアプリ設定を持つこと。
 */
function checkBundle(dir) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const expected = BUNDLE_FILES.slice().sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) return 'BUNDLE_FILE_SET_MISMATCH';
  for (const n of names) {
    if (n.endsWith('.gs') && fs.readFileSync(path.join(dir, n), 'utf8').trim() === '') return 'BUNDLE_FILE_EMPTY';
  }
  try {
    const m = readJson(path.join(dir, 'appsscript.json'));
    if (!m.webapp || m.webapp.executeAs !== 'USER_DEPLOYING') return 'BUNDLE_MANIFEST_INVALID';
    const dep = readDependencies(m);
    if (dep.malformed || dep.extra || dep.services.some((k) => !approvedKeys().has(k))) return 'BUNDLE_MANIFEST_INVALID';
    if (!approvedKeys().has(dep.services[0]) || dep.services.length !== APPROVED_ADVANCED_SERVICES.length) return 'BUNDLE_SHEETS_SERVICE_MISSING';
  } catch (_) { return 'BUNDLE_MANIFEST_INVALID'; }
  return 'OK';
}

/**
 * 手動起動ゲート（#778）。workflow_dispatch の入力を、UI表示に頼らずjobの先頭で検証する（fail closed）。
 * access_state は運営者の「宣言」でありGASプロパティの実測ではない。入力確認は実行者本人の自己申告で、
 * Environment の Required reviewers による独立承認とは別物（ON時は別途 approve_on ジョブで独立承認を要求）。
 * 戻り値は固定の短い語のみ（入力値そのものは返さない）。
 */
const ACCESS_STATES = ['OFF_CONFIRMED', 'ON_CHANGE_APPROVED'];
const ACTIONS = ['deploy', 'rollback'];
const APPROVAL_REF_PATTERN = /^[A-Za-z0-9#][A-Za-z0-9#._:\/-]{0,63}$/;

function checkDispatch(i) {
  const s = (v) => (typeof v === 'string' ? v : '');
  if (s(i.event) !== 'workflow_dispatch') return 'NOT_MANUAL_DISPATCH';
  if (s(i.ref) !== 'refs/heads/main') return 'BRANCH_NOT_MAIN';
  const action = s(i.action);
  if (action === '' || action === 'NOT_SELECTED') return 'ACTION_NOT_SELECTED';
  if (!ACTIONS.includes(action)) return 'INVALID_ACTION';
  if (s(i.safety) !== 'true') return 'SAFETY_NOT_CONFIRMED';
  const state = s(i.accessState);
  if (state === '' || state === 'NOT_SELECTED') return 'ACCESS_STATE_NOT_SELECTED';
  if (!ACCESS_STATES.includes(state)) return 'INVALID_ACCESS_STATE';
  if (s(i.executor) !== 'true') return 'EXECUTOR_NOT_CONFIRMED';
  if (state === 'ON_CHANGE_APPROVED') {
    const ref = s(i.approvalRef);
    if (ref.trim() === '') return 'APPROVAL_REFERENCE_REQUIRED';
    if (!APPROVAL_REF_PATTERN.test(ref)) return 'APPROVAL_REFERENCE_INVALID';
  }
  const version = s(i.rollbackVersion);
  const compat = s(i.rollbackCompat);
  if (action === 'deploy') {
    if (version !== '' || compat === 'true') return 'ROLLBACK_INPUT_WITH_DEPLOY';
    if (compat !== '' && compat !== 'false') return 'INVALID_ROLLBACK_COMPAT';
  } else {
    if (!/^[1-9][0-9]{0,5}$/.test(version)) return 'ROLLBACK_VERSION_REQUIRED';
    if (compat !== 'true') return 'ROLLBACK_COMPAT_NOT_CONFIRMED';
  }
  return 'OK';
}

/** 版の説明を非秘密の安全な文字だけに整形する（証跡用）。 */
function describeVersion(listJson, n) {
  const r = parseVersions(listJson);
  if (r.error) return '-';
  const row = JSON.parse(listJson).find((x) => x && x.versionNumber === Number(n));
  return String((row && row.description) || '-').replace(/[^A-Za-z0-9 ._:@#-]/g, '').slice(0, 80) || '-';
}

/** push後に pull し直した内容が、デプロイ対象のローカル内容と一致するか（ソース反映の確認）。 */
function compareSources(localDir, pulledDir) {
  const list = (d) => fs.readdirSync(d).filter((n) => n.endsWith('.gs') || n === 'appsscript.json').sort();
  const local = list(localDir);
  const pulled = list(pulledDir);
  if (JSON.stringify(local) !== JSON.stringify(pulled)) return 'SOURCE_FILE_SET_MISMATCH';
  for (const name of local) {
    const a = fs.readFileSync(path.join(localDir, name), 'utf8');
    const b = fs.readFileSync(path.join(pulledDir, name), 'utf8');
    if (name === 'appsscript.json') {
      try {
        if (JSON.stringify(sortKeys(JSON.parse(a))) !== JSON.stringify(sortKeys(JSON.parse(b)))) return 'SOURCE_CONTENT_MISMATCH';
      } catch (_) { return 'SOURCE_CONTENT_MISMATCH'; }
    } else if (a.replace(/\r\n/g, '\n').trimEnd() !== b.replace(/\r\n/g, '\n').trimEnd()) {
      return 'SOURCE_CONTENT_MISMATCH';
    }
  }
  return 'OK';
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** 認証JSONの検証（値は出力しない）。 */
function checkCredential(json) {
  let auth;
  try { auth = JSON.parse(json); } catch (_) { return 'CREDENTIAL_NOT_JSON'; }
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return 'CREDENTIAL_SHAPE_INVALID';
  if (!auth.tokens || typeof auth.tokens !== 'object' || !auth.tokens.default) return 'CREDENTIAL_USER_MISSING';
  return 'OK';
}

function main(argv, env) {
  const [cmd, ...a] = argv;
  switch (cmd) {
    case 'pick-deployment': { // <list.json> -> "<version>" | error code (exit 1)
      const r = pickDeployment(fs.readFileSync(a[0], 'utf8'), env.SBA_DEPLOYMENT_ID || '');
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      process.stdout.write(String(r.versionNumber) + '\n');
      return 0;
    }
    case 'deployment-matches': { // <list.json> <version|any> <description-substring|-> -> exit 0/1
      const r = pickDeployment(fs.readFileSync(a[0], 'utf8'), env.SBA_DEPLOYMENT_ID || '');
      if (r.error) { process.stderr.write(r.error + '\n'); return 2; }
      if (a[1] !== 'any' && r.versionNumber !== Number(a[1])) return 1;
      if (a[2] && a[2] !== '-' && !descriptionMatches(r.description, a[2])) return 1;
      return 0;
    }
    case 'max-version': { // <versions.json>
      const r = parseVersions(fs.readFileSync(a[0], 'utf8'));
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      process.stdout.write(String(r.max) + '\n');
      return 0;
    }
    case 'has-version': { // <versions.json> <n>
      const r = parseVersions(fs.readFileSync(a[0], 'utf8'));
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      return r.numbers.includes(Number(a[1])) ? 0 : 1;
    }
    case 'check-bundle': { const s = checkBundle(a[0]); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'dispatch-gate': { // 入力は環境変数 DG_* から読む（コマンド行・シェル展開に値を載せない）
      const s = checkDispatch({
        event: env.DG_EVENT, ref: env.DG_REF, action: env.DG_ACTION, safety: env.DG_SAFETY,
        accessState: env.DG_ACCESS_STATE, executor: env.DG_EXECUTOR, approvalRef: env.DG_APPROVAL_REF,
        rollbackVersion: env.DG_ROLLBACK_VERSION, rollbackCompat: env.DG_ROLLBACK_COMPAT
      });
      process.stdout.write(s + '\n');
      return s === 'OK' ? 0 : 1;
    }
    case 'target-paths': process.stdout.write(TARGET_PATHS.join('\n') + '\n'); return 0;
    case 'describe-version': { process.stdout.write(describeVersion(fs.readFileSync(a[0], 'utf8'), a[1]) + '\n'); return 0; }
    case 'check-remote': { const s = checkRemoteTarget(a[0]); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'check-manifest': { const s = checkManifest(a[0], a[1], a[2] === 'webapp-only'); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'compare-sources': { const s = compareSources(a[0], a[1]); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'check-credential': { const s = checkCredential(env.SBA_CLASPRC_JSON || ''); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'write-config': { // 認証ファイル（0600）と .clasp.json を生成。clasp 3.xの既定は .js 優先のため .gs を明示
      const [authFile, projectDir, scriptIdEnv] = a;
      void scriptIdEnv;
      fs.writeFileSync(authFile, env.SBA_CLASPRC_JSON || '', { mode: 0o600 });
      fs.writeFileSync(path.join(projectDir, '.clasp.json'), JSON.stringify({ scriptId: env.SBA_SCRIPT_ID || '', rootDir: '.', scriptExtensions: ['gs'] }), { mode: 0o600 });
      return 0;
    }
    default:
      process.stderr.write('unknown command\n');
      return 64;
  }
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2), process.env); } catch (_) {
    process.stderr.write('helper failed\n'); code = 70; // 例外メッセージ（パス・IDを含み得る）は出さない
  }
  process.exit(code);
}

module.exports = { APPROVED_ADVANCED_SERVICES, BUNDLE_FILES, TARGET_PATHS, ACCESS_STATES, checkBundle, checkDispatch, describeVersion, pickDeployment, descriptionMatches, parseVersions, checkRemoteTarget, checkManifest, compareSources, checkCredential };
