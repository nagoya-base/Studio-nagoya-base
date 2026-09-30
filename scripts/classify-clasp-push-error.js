#!/usr/bin/env node
'use strict';

// This script intentionally emits fixed codes only. Never print raw clasp output:
// API errors can include account addresses, project IDs, and OAuth details.
const fs = require('node:fs');

function classify(output) {
  const value = String(output).slice(0, 1024 * 1024);
  if (/insufficient (?:authentication )?scopes?|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(value)) {
    return 'OAUTH_SCOPE_INSUFFICIENT';
  }
  if (/Apps Script API.*(?:disabled|not enabled|not been used)|SERVICE_DISABLED|script\.googleapis\.com.*(?:disabled|not been used)/i.test(value)) {
    return 'APPS_SCRIPT_API_DISABLED';
  }
  if (/invalid_grant|invalid credentials|unauthenticated|login required|token has been expired or revoked/i.test(value)) {
    return 'AUTHENTICATION_FAILED';
  }
  if (/permission denied|caller does not have permission|forbidden|PERMISSION_DENIED/i.test(value)) {
    return 'WRITE_PERMISSION_OR_SCOPE_DENIED';
  }
  if (/manifest|appsscript\.json/i.test(value) && /invalid|error|missing|required|parse|syntax/i.test(value)) {
    return 'MANIFEST_VALIDATION_FAILED';
  }
  if (/duplicate file|duplicate name|invalid file|script file|syntax error|parse error|invalid argument|INVALID_ARGUMENT/i.test(value)) {
    return 'PROJECT_CONTENT_VALIDATION_FAILED';
  }
  if (/quota|rate limit|RESOURCE_EXHAUSTED|too many requests|HTTP 429/i.test(value)) {
    return 'QUOTA_OR_RATE_LIMIT';
  }
  if (/timeout|timed out|ECONNRESET|ENOTFOUND|EAI_AGAIN|HTTP 5\d\d|internal server error|UNAVAILABLE/i.test(value)) {
    return 'TRANSIENT_API_OR_NETWORK_ERROR';
  }
  return 'UNCLASSIFIED';
}

if (require.main === module) {
  let output = '';
  try {
    output = fs.readFileSync(process.argv[2], 'utf8');
  } catch (_) {
    // Missing/unreadable output is itself unclassified; never echo file errors.
  }
  process.stderr.write('clasp push --force failed: ' + classify(output) + '\n');
}

module.exports = { classify };
