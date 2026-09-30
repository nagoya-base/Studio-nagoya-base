#!/usr/bin/env node
'use strict';

// Never print raw clasp output: API errors can include account addresses, project
// IDs, and OAuth details. Output is a fixed category plus, only when UNCLASSIFIED,
// a few allowlisted fields (HTTP status, error code/status/reason, short message)
// or, when there are none, the first meaningful line(s) of plain-text output,
// all sanitized and length-capped.
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

const REDACTED = '[REDACTED]';
const MAX_MESSAGE_LENGTH = 160;
const MAX_LINE_LENGTH = 200;
const MAX_LINES = 2;

// Replace anything that could identify an account, project, or credential.
function sanitize(text) {
  return String(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/https?:\/\/\S*/gi, REDACTED)
    .replace(/[^\s@<>"'()]+@[^\s@<>"'()]+/g, REDACTED)
    .replace(/\b(?:ya29|1\/\/|GOCSPX|AKfycb)[\w./~+=-]*/g, REDACTED)
    .replace(/[\w.-]*\.apps\.googleusercontent\.com\b/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, REDACTED)
    .replace(/\b[A-Z][A-Z0-9_]{2,}=\S*/g, REDACTED)
    .replace(/(?<![\w])(?:[A-Za-z]:[\\/]|~[\\/]|\.{0,2}[\\/])[^\s"'`<>|]+/g, '[REDACTED_PATH]')
    .replace(/(?<![\w.-])[\w.@-]+[\\/][\w.@\\/-]+/g, '[REDACTED_PATH]')
    .replace(/[A-Za-z0-9_\-./+=~]{16,}/g, REDACTED)
    .replace(/\b\d{6,}\b/g, REDACTED)
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(value, patterns) {
  for (const pattern of patterns) {
    const m = pattern.exec(value);
    if (m) return m[1];
  }
  return null;
}

// Extract only allowlisted Google API error fields. Never returns raw output.
function extractDiagnostics(output) {
  const value = String(output).slice(0, 1024 * 1024);
  const fields = [];
  const status = firstMatch(value, [
    /"code"\s*:\s*([1-5]\d\d)\b/,
    /\bHTTP(?:\/[\d.]+)?\s+([1-5]\d\d)\b/i,
    /\bstatus(?: code)?[:=\s]+([1-5]\d\d)\b/i
  ]);
  if (status) fields.push('http_status=' + status);
  const code = firstMatch(value, [/"status"\s*:\s*"([A-Z_]{3,40})"/, /\bcode[:=]\s*"?([A-Z][A-Z_]{2,39})\b/]);
  if (code) fields.push('code=' + sanitize(code));
  const reason = firstMatch(value, [/"reason"\s*:\s*"([A-Za-z_]{3,60})"/]);
  if (reason) fields.push('reason=' + sanitize(reason));
  const message = firstMatch(value, [/"message"\s*:\s*"((?:[^"\\]|\\.){1,500})"/]);
  if (message) {
    const clean = sanitize(message).slice(0, MAX_MESSAGE_LENGTH);
    if (clean) fields.push('message="' + clean + '"');
  }
  return fields;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

// First meaningful non-empty line(s) of plain-text output, sanitized and capped.
// Skips blank lines, punctuation/spinner-only lines and stack frames.
function extractSanitizedLine(output) {
  const lines = String(output).slice(0, 1024 * 1024).replace(ANSI, '').split(/\r?\n|\r/);
  const kept = [];
  for (const line of lines) {
    if (kept.length >= MAX_LINES) break;
    if (!/[A-Za-z]/.test(line) || /^\s*at\s/.test(line)) continue;
    const clean = sanitize(line);
    if (!/[A-Za-z]/.test(clean.replace(/\[REDACTED(?:_PATH)?\]/g, ''))) continue;
    kept.push(clean);
  }
  const joined = kept.join(' | ').slice(0, MAX_LINE_LENGTH).trim();
  if (!/[A-Za-z]/.test(joined.replace(/\[REDACTED(?:_PATH)?\]/g, ''))) return null;
  return joined;
}

function report(output) {
  const category = classify(output);
  if (category !== 'UNCLASSIFIED') return 'clasp push --force failed: ' + category;
  const fields = extractDiagnostics(output);
  let detail = fields.join(' ');
  if (!detail) {
    const line = extractSanitizedLine(output);
    detail = line ? 'sanitized_line="' + line + '"' : 'sanitized_line_unavailable';
  }
  return 'clasp push --force failed: UNCLASSIFIED (sanitized diagnostics: ' + detail + ')';
}

if (require.main === module) {
  let output = '';
  try {
    output = fs.readFileSync(process.argv[2], 'utf8');
  } catch (_) {
    // Missing/unreadable output is itself unclassified; never echo file errors.
  }
  process.stderr.write(report(output) + '\n');
}

module.exports = { classify, sanitize, extractDiagnostics, extractSanitizedLine, report };
