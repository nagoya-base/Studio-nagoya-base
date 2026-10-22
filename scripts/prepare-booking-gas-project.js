#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var manifest = require('../test/helpers/booking-deployment-manifest');

/* READMEの配布表は.gsだけを管理するため、GASで必要なHTMLはここで明示する。 */
var TARGET_ASSET_FILES = {
  public: [],
  admin: ['BookingAdminPage.html'],
  webhook: []
};

/*
 * Booking Adminの既存コンテナ固有manifestを維持する設計のため、通常のコードデプロイでは
 * manifestの不足scopeが補正されない。Admin（StripeGatewayがUrlFetchApp経由でStripe APIを
 * 呼ぶ）に必須のscopeはここを正本とし、不足していれば末尾へ追記する（既存scopeの
 * 削除・並べ替え・他項目の変更はしない。Issue #404）。
 */
var ADMIN_REQUIRED_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/script.external_request'
];

function usage() {
  throw new Error(
    'Usage: node scripts/prepare-booking-gas-project.js ' +
    '<public|admin|webhook> <output-directory> <appsscript.json>'
  );
}

function findSourceFile(repositoryRoot, target, fileName) {
  var candidates = [
    path.join(repositoryRoot, 'gas', 'booking', 'shared', fileName),
    path.join(repositoryRoot, 'gas', 'booking', target, fileName)
  ];
  var matches = candidates.filter(function (candidate) { return fs.existsSync(candidate); });

  if (matches.length !== 1) {
    throw new Error(
      fileName + ' must exist exactly once in shared/ or ' + target + '/ (found ' + matches.length + ')'
    );
  }
  return matches[0];
}

function ensureAdminOauthScopes(manifestPath) {
  var parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error('Admin Apps Script manifest is not valid JSON');
  }
  /* oauthScopesが無い場合はGASがscopeを自動検出している。ここで明示配列を新設すると
     自動検出分が失われ権限が縮小するため、推測で書き換えず明示的に失敗させる。 */
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.oauthScopes)) {
    throw new Error(
      'Admin Apps Script manifest has no oauthScopes array; add the required scopes ' +
      'manually (' + ADMIN_REQUIRED_OAUTH_SCOPES.join(', ') + ') before deploying'
    );
  }
  var added = ADMIN_REQUIRED_OAUTH_SCOPES.filter(function (scope) {
    return parsed.oauthScopes.indexOf(scope) === -1;
  });
  added.forEach(function (scope) { parsed.oauthScopes.push(scope); });
  return { manifest: parsed, added: added };
}

function prepareProject(target, outputDirectory, manifestPath) {
  if (target !== 'public' && target !== 'admin' && target !== 'webhook') usage();

  var repositoryRoot = path.resolve(__dirname, '..');
  var output = path.resolve(outputDirectory);
  var sourceManifest = path.resolve(manifestPath);
  var scriptFiles = target === 'public'
    ? manifest.BOOKING_WEB_APP_FILES
    : target === 'admin' ? manifest.BOOKING_ADMIN_FILES : manifest.BOOKING_WEBHOOK_FILES;
  var files = scriptFiles.concat(TARGET_ASSET_FILES[target]);

  if (!fs.existsSync(sourceManifest)) {
    throw new Error('Apps Script manifest not found: ' + sourceManifest);
  }

  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });

  files.forEach(function (fileName) {
    var source = findSourceFile(repositoryRoot, target, fileName);
    fs.copyFileSync(source, path.join(output, fileName));
  });
  if (target === 'admin') {
    var ensured = ensureAdminOauthScopes(sourceManifest);
    fs.writeFileSync(
      path.join(output, 'appsscript.json'),
      JSON.stringify(ensured.manifest, null, 2) + '\n'
    );
    if (ensured.added.length > 0) {
      process.stderr.write(
        'Added missing required oauthScopes to the Admin manifest: ' + ensured.added.join(', ') +
        '\n'
      );
    }
  } else {
    fs.copyFileSync(sourceManifest, path.join(output, 'appsscript.json'));
  }

  return files.concat(['appsscript.json']).sort();
}

if (require.main === module) {
  if (process.argv.length !== 5) usage();
  var copied = prepareProject(process.argv[2], process.argv[3], process.argv[4]);
  process.stdout.write(copied.join('\n') + '\n');
}

module.exports = {
  prepareProject: prepareProject,
  ADMIN_REQUIRED_OAUTH_SCOPES: ADMIN_REQUIRED_OAUTH_SCOPES
};
