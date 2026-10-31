#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

// Only fixed categories leave this process, including for unknown failures.
// Never interpolate any part of clasp output, filenames or exception messages.
function classify(output) {
  const value = String(output).slice(0, 2 * 1024 * 1024);
  if (/invalid_grant|invalid credentials|unauthenticated|login required|not logged in|please (?:log ?in|login)|token.*(?:expired|revoked)|invalid_token|HTTP 401/i.test(value)) {
    return 'AUTHENTICATION_FAILED';
  }
  if (/credentials?|\.clasprc|user.*(?:not found|does not exist|missing|unknown)|unknown user|no.*tokens?|Unexpected token.*JSON/i.test(value)) {
    return 'CLASP_CREDENTIAL_OR_USER_MISMATCH';
  }
  if (/permission|access denied|forbidden|HTTP 403/i.test(value)) {
    return 'ACCESS_DENIED';
  }
  if (/not found|NOT_FOUND|HTTP 404|invalid.*script\s*id|script\s*id.*invalid|requested entity|project.*(?:not exist|inaccessible)/i.test(value)) {
    return 'SCRIPT_NOT_FOUND_OR_INACCESSIBLE';
  }
  if (/timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|HTTP 5\d\d|internal server error|UNAVAILABLE|quota|rate limit|RESOURCE_EXHAUSTED|too many requests|HTTP 429/i.test(value)) {
    return 'TRANSIENT_API_OR_NETWORK_ERROR';
  }
  return 'UNCLASSIFIED';
}

function report(output, phase) {
  const context = phase === 'after' ? 'after update' : phase === 'verify' ? 'during verification' : 'before update';
  return 'clasp list-deployments failed (' + context + '): ' + classify(output);
}

if (require.main === module) {
  const outputs = process.argv.slice(2, 4).map(file => {
    try { return fs.readFileSync(file, 'utf8').slice(0, 1024 * 1024); }
    catch (_) { return ''; }
  });
  process.stderr.write(report(outputs.join('\n'), process.argv[4]) + '\n');
}

module.exports = { classify, report };
