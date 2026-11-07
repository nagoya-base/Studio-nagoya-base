#!/usr/bin/env node
'use strict';

/*
 * Issue #723: 独立SwitchBot検証GAS（gas/switchbot-verify/）のclaspデプロイ補助ロジック。
 * シェル側（deploy-switchbot-verify-gas.sh）から呼ばれ、判定結果は固定の短い語（または数値）だけを
 * 標準出力へ返す。clasp生出力・ID・認証情報は一切出力しない（エラー文面にも埋め込まない）。
 */
const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_REMOTE_FILE = 'SwitchBotVerify.gs';
// 他プロジェクト（予約GAS等）への誤接続を検出するための拒否プレフィックス。
const FORBIDDEN_REMOTE_PREFIXES = ['Booking', 'Survey'];

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
 * 更新後の説明文照合（Issue #804 PR-C3）。更新時に指定した説明（例: `main <40桁SHA>`）と**完全一致**する場合だけ
 * 成功にする（前後の空白のみ許容）。前置き・追記・別記載のSHAを含む部分一致は成功にしない。
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

/** pull した既存プロジェクトが「独立SwitchBot検証GAS」であることを確認する。 */
function checkRemoteTarget(remoteDir) {
  const names = fs.existsSync(remoteDir) ? fs.readdirSync(remoteDir) : [];
  if (!names.includes(REQUIRED_REMOTE_FILE)) return 'TARGET_MISMATCH_NO_SWITCHBOT_VERIFY';
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
  if (webappOnly) return 'OK'; // rollback: 新scope検査は行わない（Webアプリの実行主体・アクセス権だけを照合）
  const remoteScopes = new Set(remote.oauthScopes || []);
  if ((repo.oauthScopes || []).some((s) => !remoteScopes.has(s))) return 'MANIFEST_NEW_OAUTH_SCOPE_REQUIRES_MANUAL_APPROVAL';
  return 'OK';
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
      const r = pickDeployment(fs.readFileSync(a[0], 'utf8'), env.SBV_DEPLOYMENT_ID || '');
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      process.stdout.write(String(r.versionNumber) + '\n');
      return 0;
    }
    case 'deployment-matches': { // <list.json> <version|any> <description-substring|-> -> exit 0/1
      const r = pickDeployment(fs.readFileSync(a[0], 'utf8'), env.SBV_DEPLOYMENT_ID || '');
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
    case 'check-remote': { const s = checkRemoteTarget(a[0]); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'check-manifest': { const s = checkManifest(a[0], a[1], a[2] === 'webapp-only'); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'compare-sources': { const s = compareSources(a[0], a[1]); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'check-credential': { const s = checkCredential(env.SBV_CLASPRC_JSON || ''); process.stdout.write(s + '\n'); return s === 'OK' ? 0 : 1; }
    case 'write-config': { // 認証ファイル（0600）と .clasp.json を生成。clasp 3.xの既定は .js 優先のため .gs を明示
      const [authFile, projectDir, scriptIdEnv] = a;
      void scriptIdEnv;
      fs.writeFileSync(authFile, env.SBV_CLASPRC_JSON || '', { mode: 0o600 });
      fs.writeFileSync(path.join(projectDir, '.clasp.json'), JSON.stringify({ scriptId: env.SBV_SCRIPT_ID || '', rootDir: '.', scriptExtensions: ['gs'] }), { mode: 0o600 });
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

module.exports = { pickDeployment, descriptionMatches, parseVersions, checkRemoteTarget, checkManifest, compareSources, checkCredential };
