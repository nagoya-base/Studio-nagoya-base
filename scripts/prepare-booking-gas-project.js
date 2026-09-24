#!/usr/bin/env node
'use strict';

var fs = require('fs');
var path = require('path');
var manifest = require('../test/helpers/booking-deployment-manifest');

/* READMEの配布表は.gsだけを管理するため、GASで必要なHTMLはここで明示する。 */
var TARGET_ASSET_FILES = {
  public: [],
  admin: ['BookingAdminPage.html']
};

function usage() {
  throw new Error(
    'Usage: node scripts/prepare-booking-gas-project.js ' +
    '<public|admin> <output-directory> <appsscript.json>'
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

function prepareProject(target, outputDirectory, manifestPath) {
  if (target !== 'public' && target !== 'admin') usage();

  var repositoryRoot = path.resolve(__dirname, '..');
  var output = path.resolve(outputDirectory);
  var sourceManifest = path.resolve(manifestPath);
  var scriptFiles = target === 'public'
    ? manifest.BOOKING_WEB_APP_FILES
    : manifest.BOOKING_ADMIN_FILES;
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
  fs.copyFileSync(sourceManifest, path.join(output, 'appsscript.json'));

  return files.concat(['appsscript.json']).sort();
}

if (require.main === module) {
  if (process.argv.length !== 5) usage();
  var copied = prepareProject(process.argv[2], process.argv[3], process.argv[4]);
  process.stdout.write(copied.join('\n') + '\n');
}

module.exports = { prepareProject: prepareProject };
