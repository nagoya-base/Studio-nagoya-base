#!/usr/bin/env node
'use strict';

/*
 * 本番GASのScript Property SPREADSHEET_IDの値から指紋（SHA-256）を求める初回設定用ツール。
 * IDは標準入力から読む（コマンド履歴・引数に残さない）。出力は指紋のみ。
 *   read -rs ID; printf %s "$ID" | node scripts/booking-spreadsheet-fingerprint.js
 */
var spreadsheetFingerprint = require('./lib/spreadsheet-fingerprint').spreadsheetFingerprint;

var chunks = [];
process.stdin.on('data', function (chunk) { chunks.push(chunk); });
process.stdin.on('end', function () {
  var id = Buffer.concat(chunks).toString('utf8').trim();
  if (!id) {
    process.stderr.write('No spreadsheet ID was provided on standard input\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(spreadsheetFingerprint(id) + '\n');
});
