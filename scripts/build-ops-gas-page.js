#!/usr/bin/env node
/*
 * build-ops-gas-page.js — _ops-app/frontend/ の本物のフロントから、GAS配信用の
 * gas/ops-reservations/OpsPage.html を生成する（Issue #936）。
 *
 * 画面ロジック（ops-client.js）と画面（index.html）の正本は _ops-app/frontend/ に一本化し、
 * GAS側は「生成物」。手で編集しない。test/ops-gas-page.test.js が生成物の同期を検証する。
 *   node scripts/build-ops-gas-page.js          # 書き出し
 *   node scripts/build-ops-gas-page.js --check  # 差分があれば終了コード1
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var FRONT = path.join(ROOT, '_ops-app', 'frontend');
var OUT = path.join(ROOT, 'gas', 'ops-reservations', 'OpsPage.html');

function between(text, tag) {
  var open = '<!--' + tag + '-->';
  var close = '<!--/' + tag + '-->';
  var a = text.indexOf(open);
  var b = text.indexOf(close);
  if (a === -1 || b === -1 || b < a) throw new Error('マーカーが見つかりません: ' + tag);
  return { start: a, end: b + close.length };
}

function build() {
  var index = fs.readFileSync(path.join(FRONT, 'index.html'), 'utf8');
  var client = fs.readFileSync(path.join(FRONT, 'ops-client.js'), 'utf8');
  var adapter = fs.readFileSync(path.join(FRONT, 'gas-adapter.js'), 'utf8');
  if (/<\/script/i.test(client + adapter)) throw new Error('スクリプト内に </script を含められません');

  var html = index;
  var head = between(html, 'OPS:HEAD');
  html = html.slice(0, head.start) +
    '<h1>予約確認（読み取り専用）</h1>\n    <p class="note">予約台帳の内容を表示します。閲覧のみで、予約の変更・決済・鍵の操作はできません。</p>' +
    html.slice(head.end);
  var scripts = between(html, 'OPS:SCRIPTS');
  html = html.slice(0, scripts.start) +
    '<script>\n' + client + '\n</script>\n  <script>\n' + adapter + '\n</script>\n  <script>\n' +
    '    OpsClient.mount(document, OpsGasAdapter.createGasApi(google.script.run));\n  </script>' +
    html.slice(scripts.end);
  html = html.replace('<title>予約確認（モック）</title>', '<title>予約確認</title>')
    .replace(/<!--[\s\S]*?-->\s*<html/, '<!--\n  OpsPage.html — 自動生成（scripts/build-ops-gas-page.js）。手で編集しない。\n  正本は _ops-app/frontend/（index.html / ops-client.js / gas-adapter.js）。Issue #936。\n  読み取り専用。google.script.run は gas-adapter.js のみ。応答はエスケープして描画する。\n-->\n<html');
  return html;
}

if (require.main === module) {
  var out = build();
  if (process.argv.indexOf('--check') !== -1) {
    var current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (current !== out) { console.error('OpsPage.html が正本と一致しません。node scripts/build-ops-gas-page.js を実行してください。'); process.exit(1); }
  } else {
    fs.writeFileSync(OUT, out);
  }
}
module.exports = { build: build, OUT: OUT };
