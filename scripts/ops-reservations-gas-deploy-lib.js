#!/usr/bin/env node
'use strict';

/*
 * 運営アプリ専用GAS（gas/ops-reservations/、Issue #936）のclaspデプロイ補助ロジック。
 * 鍵管理GAS（switchbot-access-gas-deploy-lib.js）の構成を参考にした**別実装**（共有しない。向こうの変更が波及しない）。
 * シェル側（deploy-ops-reservations-gas.sh）から呼ばれ、判定結果は固定の短い語（または数値）だけを標準出力へ返す。
 * clasp生出力・Script/Deployment ID・認証情報は一切出力しない（エラー文面にも埋め込まない）。
 */
const fs = require('node:fs');
const path = require('node:path');

// 配布物（scripts/prepare-ops-reservations-gas-project.js の出力）。テストが prepare・gas/ops-reservations と一致を確認する。
const BUNDLE_FILES = [
  'OpsApi.gs', 'OpsAuth.gs', 'OpsContract.gs', 'OpsNormalizer.gs', 'OpsPage.html', 'OpsQuery.gs', 'OpsSource.gs', 'appsscript.json'
];
// 運営アプリだけが使う権限（読み取り専用）。これ以外のscope（書込み・Drive・メール等）は配布しない。
const APPROVED_SCOPES = [
  'https://www.googleapis.com/auth/script.external_request',
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];
const REQUIRED_REMOTE_FILES = ['OpsApi.gs', 'OpsAuth.gs'];
// 鮮度確認（古いrunのスキップ）が参照する対象パス。
const TARGET_PATHS = [
  'gas/ops-reservations',
  '_ops-app/frontend',
  'scripts/build-ops-gas-page.js',
  'scripts/prepare-ops-reservations-gas-project.js',
  'scripts/ops-reservations-gas-deploy-lib.js',
  'scripts/deploy-ops-reservations-gas.sh',
  '.github/workflows/ops-reservations-gas-deploy.yml'
];
// 空の新規プロジェクト（初回配置）として許す、GAS既定の空スタブ。
const PRISTINE_STUB = /^\s*function\s+myFunction\s*\(\s*\)\s*\{\s*\}\s*$/;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** clasp list-deployments --json の出力から、指定IDの行を完全一致で1件だけ取り出す。 */
function pickDeployment(listJson, deploymentId) {
  let rows;
  try { rows = JSON.parse(listJson); } catch (_) { return { error: 'LIST_PARSE_FAILED' }; }
  if (!Array.isArray(rows)) return { error: 'LIST_PARSE_FAILED' };
  const matches = rows.filter((r) => r && deploymentId && r.deploymentId === deploymentId);
  if (matches.length === 0) return { error: 'DEPLOYMENT_ID_NOT_FOUND' };
  if (matches.length > 1) return { error: 'DEPLOYMENT_ID_NOT_UNIQUE' };
  const row = matches[0];
  // @HEAD（versionNumber無し）は固定版ではないので更新対象にしない。
  if (!Number.isInteger(row.versionNumber) || row.versionNumber < 1) return { error: 'DEPLOYMENT_NOT_VERSIONED' };
  return { versionNumber: row.versionNumber, description: String(row.description || '') };
}

/** 説明文は自分たちが指定した `main <40桁SHA>` と完全一致（前後の空白のみ許容）。 */
const descriptionMatches = (actual, expected) => String(actual).trim() === String(expected).trim();

function parseVersions(listJson) {
  let rows;
  try { rows = JSON.parse(listJson); } catch (_) { return { error: 'VERSIONS_PARSE_FAILED' }; }
  if (!Array.isArray(rows)) return { error: 'VERSIONS_PARSE_FAILED' };
  const numbers = rows.map((r) => r && r.versionNumber).filter((n) => Number.isInteger(n));
  return { numbers, max: numbers.length ? Math.max(...numbers) : 0 };
}

/**
 * pull した既存プロジェクトが「運営アプリ専用GAS」であることを確認する（許可リスト方式）。
 *  - OK            : 運営アプリのファイルを持ち、ファイル集合が配布物の範囲内
 *  - OK_PRISTINE   : 初回配置。GAS既定の空スタブだけの新規プロジェクト（業務コードを持たない）
 *  それ以外（予約・決済・鍵・Survey等のファイルが1つでもある／運営アプリのファイルが無い）は停止。
 */
function checkRemoteTarget(remoteDir) {
  const names = fs.existsSync(remoteDir) ? fs.readdirSync(remoteDir).filter((n) => !n.startsWith('.')) : [];
  if (REQUIRED_REMOTE_FILES.every((f) => names.includes(f))) {
    return names.every((n) => BUNDLE_FILES.includes(n)) ? 'OK' : 'TARGET_MISMATCH_UNEXPECTED_FILES';
  }
  const code = names.filter((n) => n !== 'appsscript.json');
  if (code.length === 0) return 'TARGET_MISMATCH_EMPTY_REMOTE';
  if (code.length === 1 && code[0] === 'Code.gs'
    && PRISTINE_STUB.test(fs.readFileSync(path.join(remoteDir, 'Code.gs'), 'utf8'))) {
    return 'OK_PRISTINE';
  }
  return 'TARGET_MISMATCH_NOT_OPS_PROJECT';
}

/**
 * 許可する依存は「Google Sheets v4 拡張サービス」の正確な宣言1件のみ（Issue #955）。
 * 他の拡張サービス・ライブラリ・余分なキー/項目は許可しない。
 * 配布側(allowEmpty=false)は宣言が必須。リモート(allowEmpty=true)は初回の未宣言（空/無し）も許可。
 */
function isSheetsOnlyDependencies(dep, allowEmpty) {
  if (dep === undefined || dep === null) return allowEmpty;
  if (typeof dep !== 'object' || Array.isArray(dep)) return false;
  const keys = Object.keys(dep);
  if (keys.length === 0) return allowEmpty;
  if (keys.length !== 1 || keys[0] !== 'enabledAdvancedServices') return false;
  const list = dep.enabledAdvancedServices;
  if (!Array.isArray(list)) return false;
  if (list.length === 0) return allowEmpty;
  if (list.length !== 1) return false;
  const e = list[0];
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const k = Object.keys(e).sort();
  return JSON.stringify(k) === JSON.stringify(['serviceId', 'userSymbol', 'version'])
    && e.userSymbol === 'Sheets' && e.serviceId === 'sheets' && e.version === 'v4';
}

/**
 * 公開設定を黙って変えない。
 *  - 配布側manifest: oauthScopes は承認済み（読み取り専用）と過不足なく一致、依存は Google Sheets v4 拡張サービスの正確な宣言のみ（他サービス/ライブラリ/余分な項目は拒否）、
 *    webapp は 自分のみ(MYSELF)・実行者=デプロイ者(USER_DEPLOYING)
 *  - リモート: webapp が配布側と一致、承認済み外のscopeを持たない、依存は未宣言または上記Sheets v4のみ（持つなら別プロジェクトの疑いで停止）
 */
function checkManifest(remoteFile, bundleFile) {
  let remote; let bundle;
  try { remote = readJson(remoteFile); bundle = readJson(bundleFile); } catch (_) { return 'MANIFEST_UNREADABLE'; }
  const bw = bundle.webapp || {};
  if (bw.access !== 'MYSELF' || bw.executeAs !== 'USER_DEPLOYING') return 'BUNDLE_MANIFEST_NOT_OWNER_ONLY';
  const scopes = (bundle.oauthScopes || []).slice().sort();
  if (JSON.stringify(scopes) !== JSON.stringify(APPROVED_SCOPES.slice().sort())) return 'BUNDLE_MANIFEST_SCOPE_NOT_APPROVED';
  if (!isSheetsOnlyDependencies(bundle.dependencies, false)) return 'BUNDLE_MANIFEST_DEPENDENCY_NOT_APPROVED';
  const rw = remote.webapp || {};
  if (rw.access !== bw.access || rw.executeAs !== bw.executeAs) return 'MANIFEST_WEBAPP_MISMATCH';
  if ((remote.oauthScopes || []).some((s) => !APPROVED_SCOPES.includes(s))) return 'MANIFEST_REMOTE_UNAPPROVED_SCOPE';
  if (!isSheetsOnlyDependencies(remote.dependencies, true)) return 'MANIFEST_REMOTE_UNAPPROVED_DEPENDENCY';
  return 'OK';
}

/** 配布物の完全性・純度。ファイル名が BUNDLE_FILES と過不足なく一致し、中身が空でなく、manifestが所有者限定・読み取り専用。 */
function checkBundle(dir) {
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  if (JSON.stringify(names) !== JSON.stringify(BUNDLE_FILES.slice().sort())) return 'BUNDLE_FILE_SET_MISMATCH';
  for (const n of names) {
    if (n !== 'appsscript.json' && fs.readFileSync(path.join(dir, n), 'utf8').trim() === '') return 'BUNDLE_FILE_EMPTY';
  }
  const m = checkManifest(path.join(dir, 'appsscript.json'), path.join(dir, 'appsscript.json'));
  return m === 'OK' ? 'OK' : m;
}

/**
 * 手動起動ゲート。通常更新は入力なし。任意の rollback_version だけ受ける。
 * 戻り値は固定の短い語のみ（入力値そのものは返さない）。
 */
function checkDispatch(i) {
  const s = (v) => (typeof v === 'string' ? v : '');
  if (s(i.event) !== 'workflow_dispatch') return 'NOT_MANUAL_DISPATCH';
  if (s(i.ref) !== 'refs/heads/main') return 'BRANCH_NOT_MAIN';
  const v = s(i.rollbackVersion).trim();
  if (v !== '' && !/^[1-9][0-9]{0,5}$/.test(v)) return 'ROLLBACK_VERSION_INVALID';
  return 'OK';
}

/** 版の説明を非秘密の安全な文字だけに整形する（証跡用）。 */
function describeVersion(listJson, n) {
  if (parseVersions(listJson).error) return '-';
  const row = JSON.parse(listJson).find((x) => x && x.versionNumber === Number(n));
  return String((row && row.description) || '-').replace(/[^A-Za-z0-9 ._:@#-]/g, '').slice(0, 80) || '-';
}

const sortKeys = (v) => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
};

/** push後に pull し直した内容が、配布物と一致するか（ソース反映の確認）。 */
function compareSources(localDir, pulledDir) {
  const list = (d) => fs.readdirSync(d).filter((n) => n.endsWith('.gs') || n.endsWith('.html') || n === 'appsscript.json').sort();
  const local = list(localDir);
  if (JSON.stringify(local) !== JSON.stringify(list(pulledDir))) return 'SOURCE_FILE_SET_MISMATCH';
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
  const say = (s) => { process.stdout.write(s + '\n'); return s.startsWith('OK') ? 0 : 1; };
  switch (cmd) {
    case 'pick-deployment': {
      const r = pickDeployment(fs.readFileSync(a[0], 'utf8'), env.OPS_DEPLOYMENT_ID || '');
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      process.stdout.write(String(r.versionNumber) + '\n');
      return 0;
    }
    case 'deployment-matches': { // <list.json> <version|any> <description|-> -> exit 0 一致 / 1 不一致 / 2 ID消失・非一意
      const r = pickDeployment(fs.readFileSync(a[0], 'utf8'), env.OPS_DEPLOYMENT_ID || '');
      if (r.error) { process.stderr.write(r.error + '\n'); return 2; }
      if (a[1] !== 'any' && r.versionNumber !== Number(a[1])) return 1;
      if (a[2] && a[2] !== '-' && !descriptionMatches(r.description, a[2])) return 1;
      return 0;
    }
    case 'max-version': {
      const r = parseVersions(fs.readFileSync(a[0], 'utf8'));
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      process.stdout.write(String(r.max) + '\n');
      return 0;
    }
    case 'has-version': {
      const r = parseVersions(fs.readFileSync(a[0], 'utf8'));
      if (r.error) { process.stderr.write(r.error + '\n'); return 1; }
      return r.numbers.includes(Number(a[1])) ? 0 : 1;
    }
    case 'check-bundle': return say(checkBundle(a[0]));
    case 'check-remote': return say(checkRemoteTarget(a[0]));
    case 'check-manifest': return say(checkManifest(a[0], a[1]));
    case 'compare-sources': return say(compareSources(a[0], a[1]));
    case 'check-credential': return say(checkCredential(env.OPS_CLASPRC_JSON || ''));
    case 'dispatch-gate': // 入力は環境変数 DG_* から読む（コマンド行・シェル展開に値を載せない）
      return say(checkDispatch({ event: env.DG_EVENT, ref: env.DG_REF, rollbackVersion: env.DG_ROLLBACK_VERSION }));
    case 'target-paths': process.stdout.write(TARGET_PATHS.join('\n') + '\n'); return 0;
    case 'describe-version': process.stdout.write(describeVersion(fs.readFileSync(a[0], 'utf8'), a[1]) + '\n'); return 0;
    case 'write-config': { // 認証ファイル（0600）と .clasp.json を生成。clasp 3.xの既定は .js 優先のため .gs を明示
      const [authFile, projectDir] = a;
      fs.writeFileSync(authFile, env.OPS_CLASPRC_JSON || '', { mode: 0o600 });
      fs.writeFileSync(path.join(projectDir, '.clasp.json'),
        JSON.stringify({ scriptId: env.OPS_SCRIPT_ID || '', rootDir: '.', scriptExtensions: ['gs'] }), { mode: 0o600 });
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

module.exports = { APPROVED_SCOPES, BUNDLE_FILES, TARGET_PATHS, checkBundle, checkDispatch, checkManifest, checkRemoteTarget, checkCredential, compareSources, describeVersion, descriptionMatches, parseVersions, pickDeployment };
