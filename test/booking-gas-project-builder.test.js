'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var builder = require('../scripts/prepare-booking-gas-project');
var deploymentManifest = require('./helpers/booking-deployment-manifest');

function withTempDirectory(run) {
  var directory = fs.mkdtempSync(path.join(os.tmpdir(), 'booking-gas-build-'));
  try {
    run(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('public GAS bundle contains only the reviewed deployment manifest and Apps Script manifest', function () {
  withTempDirectory(function (directory) {
    var files = builder.prepareProject(
      'public',
      directory,
      path.join(__dirname, '..', 'gas', 'booking', 'public', 'appsscript.json')
    );

    assert.deepStrictEqual(
      files,
      deploymentManifest.BOOKING_WEB_APP_FILES.concat(['appsscript.json']).sort()
    );
    assert.deepStrictEqual(fs.readdirSync(directory).sort(), files);
  });
});

test('admin GAS bundle preserves the supplied existing-project manifest', function () {
  withTempDirectory(function (directory) {
    var remoteManifest = path.join(directory, 'remote-appsscript.json');
    var output = path.join(directory, 'output');
    var expectedManifest = { timeZone: 'Asia/Tokyo', webapp: { access: 'MYSELF' } };
    fs.writeFileSync(remoteManifest, JSON.stringify(expectedManifest));

    var files = builder.prepareProject('admin', output, remoteManifest);

    assert.deepStrictEqual(
      files,
      deploymentManifest.BOOKING_ADMIN_FILES
        .concat(['BookingAdminPage.html', 'appsscript.json'])
        .sort()
    );
    assert.ok(
      fs.readFileSync(path.join(output, 'BookingAdminPage.html'), 'utf8').includes('booking-admin.js'),
      'BookingAdminPage.htmlのローダーがAdmin配布物に含まれること'
    );
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(output, 'appsscript.json'), 'utf8')),
      expectedManifest
    );
  });
});
