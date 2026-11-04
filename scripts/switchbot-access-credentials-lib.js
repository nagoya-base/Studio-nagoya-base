'use strict';

/*
 * 独立GAS（鍵管理基盤）の資格情報3件を、実行者本人の User Properties へ登録するローカル側ロジック（Issue #770）。
 * Apps Script Execution API（scripts.run）で GAS の accessSetupCredentialsApi を呼ぶ。
 *
 * 秘密の扱い（コードで固定）:
 *  - コマンドライン引数・環境変数では受け取らない（フラグのみ許可。未知の引数は即拒否）。TTYの非表示入力のみ。
 *  - 値はHTTPS本文にだけ載せる。標準出力・標準エラー・例外メッセージには出さない（固定コードと SET/MISSING のみ）。
 *  - ファイルへ書くのは、ローカル生成した Webhook共有トークンを --generate-webhook-token-to で指定した新規ファイル(0600)へ
 *    出す場合だけ。既存ファイルは上書きしない。
 *  - Script Properties・トリガー・Webhook登録・端末APIは呼ばない。
 */
var fs = require('fs');
var nodeCrypto = require('crypto');

var NAMES = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'WEBHOOK_SHARED_TOKEN'];
var CONFIRM_KEY = '__CONFIRM_REPLACE__';
var TOKEN_URL = 'https://oauth2.googleapis.com/token';
var RUN_URL = 'https://script.googleapis.com/v1/scripts/';

function fail(code) { var e = new Error(code); e.code = code; return e; }

/** 許可するのはフラグだけ。値っぽい引数や未知のフラグは理由を示さず拒否する（秘密を echo しない）。 */
function parseArgs(argv) {
  var opts = { mode: 'init', dryRun: false, generateWebhookTokenTo: null };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--replace') opts.mode = 'replace';
    else if (a === '--generate-webhook-token-to') {
      var next = argv[i + 1];
      if (!next || next.charAt(0) === '-') throw fail('BAD_ARGS');
      opts.generateWebhookTokenTo = next; i++;
    } else throw fail('BAD_ARGS');
  }
  return opts;
}

/** clasp 形式の .clasprc.json（clasp 3.x: tokens.<user> / 旧形式: token）から OAuth 情報を取り出す。 */
function readClasprc(text, user) {
  var j;
  try { j = JSON.parse(text); } catch (e) { throw fail('CLASPRC_INVALID'); }
  var t = j && j.tokens && j.tokens[user || 'default'];
  if (!t || typeof t !== 'object') t = j && j.token && !j.tokens ? j.token : null;
  var id = t && (t.client_id || (j && j.oauth2ClientSettings && j.oauth2ClientSettings.clientId));
  var secret = t && (t.client_secret || (j && j.oauth2ClientSettings && j.oauth2ClientSettings.clientSecret));
  if (!t || !t.refresh_token || !id || !secret) throw fail('CLASPRC_INVALID');
  return { clientId: id, clientSecret: secret, refreshToken: t.refresh_token };
}

function formBody(o) {
  return Object.keys(o).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&');
}

async function getAccessToken(creds, fetchFn) {
  var res;
  try {
    res = await fetchFn(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: creds.refreshToken, grant_type: 'refresh_token' })
    });
  } catch (e) { throw fail('NETWORK_ERROR'); }
  if (!res.ok) throw fail('API_AUTH_FAILED');
  var body;
  try { body = await res.json(); } catch (e) { throw fail('API_AUTH_FAILED'); }
  if (!body || typeof body.access_token !== 'string' || !body.access_token) throw fail('API_AUTH_FAILED');
  return body.access_token;
}

/** scripts.run 呼び出し。失敗はHTTP状態等から固定コードへ変換し、サーバーの本文・メッセージは返さない。 */
async function callSetup(fetchFn, accessToken, scriptId, request) {
  var res;
  try {
    res = await fetchFn(RUN_URL + encodeURIComponent(scriptId) + ':run', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
      // devMode=true: 最新の保存済みコード(HEAD)をオーナーとして実行する。API実行可能Deploymentは作らない。
      body: JSON.stringify({ function: 'accessSetupCredentialsApi', parameters: [request], devMode: true })
    });
  } catch (e) { throw fail('NETWORK_ERROR'); }
  if (res.status === 401 || res.status === 403) throw fail('API_AUTH_FAILED');
  if (res.status === 404) throw fail('API_NOT_FOUND');
  if (!res.ok) throw fail('API_ERROR');
  var body;
  try { body = await res.json(); } catch (e) { throw fail('API_ERROR'); }
  if (!body || body.error || !body.response) throw fail('SCRIPT_ERROR');
  var r = body.response.result;
  if (!r || typeof r.ok !== 'boolean' || typeof r.code !== 'string' || !/^[A-Z_]{2,40}$/.test(r.code)) throw fail('SCRIPT_ERROR');
  var status = {};
  NAMES.forEach(function (n) { status[n] = r.status && r.status[n] === 'SET' ? 'SET' : 'MISSING'; });
  return { ok: r.ok, code: r.code, status: status, changed: Array.isArray(r.changed) ? r.changed.filter(function (n) { return NAMES.indexOf(n) !== -1; }) : [], invalid: Array.isArray(r.invalid) ? r.invalid.filter(function (n) { return NAMES.indexOf(n) !== -1; }) : [] };
}

function printResult(out, r) {
  out('result: ' + r.code);
  NAMES.forEach(function (n) { out(n + ': ' + r.status[n]); });
  if (r.changed && r.changed.length) out('changed: ' + r.changed.join(', '));
  if (r.invalid && r.invalid.length) out('invalid: ' + r.invalid.join(', '));
}

/**
 * deps: argv, env, readFile(path), writeNewFile(path, content)（存在すれば例外・0600）, fetch, ask{ secret(label), visible(label) } (null=取消),
 *       isTTY, out(line), err(line), randomToken()
 * 戻り値: 終了コード（0 = 成功）。
 */
async function main(deps) {
  var out = deps.out, err = deps.err;
  try {
    if (!deps.isTTY) throw fail('NO_TTY'); // パイプ・リダイレクトからの秘密入力は受け付けない
    var opts = parseArgs(deps.argv);
    var scriptId = deps.env.SBA_SCRIPT_ID;
    if (typeof scriptId !== 'string' || !/^[A-Za-z0-9_-]{20,}$/.test(scriptId)) throw fail('SCRIPT_ID_MISSING');
    var rcPath = deps.env.CLASPRC_PATH || ((deps.env.HOME || '') + '/.clasprc.json');
    var rcText;
    try { rcText = deps.readFile(rcPath); } catch (e) { throw fail('CLASPRC_INVALID'); }
    var creds = readClasprc(rcText, 'default');
    var accessToken = await getAccessToken(creds, deps.fetch);

    // 状態確認（値なし・無保存）: 認可・実行者の整合・SET/MISSING を先に得る
    var probe = await callSetup(deps.fetch, accessToken, scriptId, { mode: opts.mode, dryRun: true, values: {} });
    if (probe.code !== 'CANCELLED') { printResult(out, probe); return 1; }

    var targets = opts.mode === 'init'
      ? NAMES.filter(function (n) { return probe.status[n] === 'MISSING'; })
      : NAMES.slice();
    var values = {};
    if (opts.mode === 'replace') {
      var c = await deps.ask.visible('既存の資格情報を差し替えます。続けるには REPLACE と入力');
      if (c === null) throw fail('CANCELLED');
      values[CONFIRM_KEY] = c;
    }
    // 共有トークンをローカル生成する場合は、入力前に出力先を確保（既存ファイルがあれば何も始めない）
    if (opts.generateWebhookTokenTo && targets.indexOf('WEBHOOK_SHARED_TOKEN') !== -1) {
      var gen = deps.randomToken();
      try { deps.writeNewFile(opts.generateWebhookTokenTo, gen + '\n'); } catch (e) { throw fail('TOKEN_FILE_EXISTS_OR_UNWRITABLE'); }
      values.WEBHOOK_SHARED_TOKEN = gen;
      err('Webhook共有トークンを指定ファイル(0600)に出力しました。パスワードマネージャへ移し、ファイルを削除してください');
    }
    for (var i = 0; i < targets.length; i++) {
      var n = targets[i];
      if (values[n] !== undefined) continue;
      var v = await deps.ask.secret(n + (opts.mode === 'replace' ? '（空のままEnterで据え置き）' : ''));
      if (v === null) throw fail('CANCELLED');
      values[n] = v;
    }
    var result = await callSetup(deps.fetch, accessToken, scriptId, { mode: opts.mode, dryRun: opts.dryRun, values: values });
    printResult(out, result);
    return result.ok ? 0 : 1;
  } catch (e) {
    err('error: ' + (e && typeof e.code === 'string' ? e.code : 'UNEXPECTED_ERROR')); // 例外メッセージは出さない
    return 1;
  }
}

/** 実TTY用: 非表示入力（貼り付けの複数文字にも対応）。Ctrl-C/Ctrl-D で null。 */
function createTtyPrompter(stdin, stdout) {
  function read(label, hidden) {
    return new Promise(function (resolve) {
      stdout.write(label + ': ');
      var buf = '';
      if (hidden) stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.resume();
      function done(v) {
        stdin.removeListener('data', onData);
        if (hidden) stdin.setRawMode(false);
        stdin.pause();
        stdout.write('\n');
        resolve(v);
      }
      function onData(chunk) {
        for (var k = 0; k < chunk.length; k++) {
          var ch = chunk[k];
          if (ch === '\r' || ch === '\n') return done(buf);
          if (ch === '\u0003' || ch === '\u0004') return done(null);
          if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
          else if (ch >= ' ') buf += ch;
        }
        if (!hidden) return;
      }
      stdin.on('data', onData);
    });
  }
  return { secret: function (l) { return read(l, true); }, visible: function (l) { return read(l, false); } };
}

function newFileWriter(path, content) {
  fs.writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
}

function randomToken() { return nodeCrypto.randomBytes(32).toString('base64url'); }

module.exports = {
  NAMES: NAMES, parseArgs: parseArgs, readClasprc: readClasprc, getAccessToken: getAccessToken, callSetup: callSetup,
  main: main, createTtyPrompter: createTtyPrompter, newFileWriter: newFileWriter, randomToken: randomToken
};
