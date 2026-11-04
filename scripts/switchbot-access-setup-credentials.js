#!/usr/bin/env node
'use strict';

/*
 * 鍵管理用・独立GAS の資格情報3件（SWITCHBOT_TOKEN / SWITCHBOT_SECRET / WEBHOOK_SHARED_TOKEN）を
 * 実行者本人の User Properties へ登録する（Issue #770）。手順: docs/switchbot-access-credentials-770.md
 *
 *   macOS/Linux: SBA_API_DEPLOYMENT_ID=<API実行可能DeploymentのID> node scripts/switchbot-access-setup-credentials.js [--dry-run] [--replace] [--generate-webhook-token-to <新規ファイル>]
 *   PowerShell : $env:SBA_API_DEPLOYMENT_ID = "<ID>"; node scripts/switchbot-access-setup-credentials.js [--dry-run] [--replace] [...]
 *
 * 値は引数・環境変数では受け取らず、TTYの非表示入力で聞く。出力は固定コードと SET/MISSING のみ。
 * --dry-run は認可・実行者の整合・SET/MISSING の確認のみ（値は聞かず、何も保存しない）。それ以外は User Properties を変更する。CIやテストからは実行しない。
 */
var fs = require('fs');
var os = require('os');
var lib = require('./switchbot-access-credentials-lib');

lib.main({
  argv: process.argv.slice(2),
  env: process.env,
  homedir: os.homedir(),
  isTTY: !!(process.stdin.isTTY && process.stdout.isTTY),
  readFile: function (p) { return fs.readFileSync(p, 'utf8'); },
  writeNewFile: lib.newFileWriter,
  fetch: fetch,
  ask: lib.createTtyPrompter(process.stdin, process.stdout),
  randomToken: lib.randomToken,
  out: function (l) { console.log(l); },
  err: function (l) { console.error(l); }
}).then(function (code) { process.exit(code); });
