/*
 * SwitchBot 検証用 読み取り専用診断の統合入口（Issue #804 PR-E2）。GitHub Actions 手動実行用。
 *
 * 既存の個別診断スクリプトを許可リストで束ねるだけの薄い入口。診断ロジックは各スクリプトのまま（判定・出力は変えない）。
 *   device-id        -> switchbot-verify-device-id.js     GET /v1.1/devices（登録IDの完全一致確認）
 *   keylist          -> switchbot-verify-keylist.js       GET /v1.1/devices（keyList 取得可否・件数）
 *   webhook-url      -> switchbot-verify-webhook-raw.js   POST queryWebhook（action=queryUrl）
 *   webhook-details  -> switchbot-verify-webhook-details.js POST queryWebhook（action=queryDetails）
 *
 * 安全条件:
 *  - operation は許可リスト（自前プロパティ）のみ。未知値・prototype 名は API 呼び出し 0 回で拒否。
 *  - 各診断へ渡す環境変数は、その診断に必要なものだけ（他の Secret を持ち越さない）。
 *  - fetch を読み取り専用ガードで包む。GET /v1.1/devices と、action が queryUrl / queryDetails の
 *    POST queryWebhook 以外は、診断側にバグがあっても送信前に例外で止める（鍵・Webhook の変更 API へ到達不能）。
 *  - 出力は各診断の既存出力のみ。入口自身は operation 名と固定文言以外を出さない。
 *  - 変更系（鍵の発行/削除・Webhook 登録/削除・復旧）は switchbot-verify-key.yml 等の専用入口に残し、ここからは呼べない。
 */
'use strict';

var Core = require('../gas/switchbot-verify/SwitchBotVerifyCore.gs');

var OPERATIONS = {
  'device-id': {
    module: './switchbot-verify-device-id.js',
    env: ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'SWITCHBOT_DEVICE_ID', 'KEYPAD_LAST4'],
    needsLast4: true
  },
  'keylist': {
    module: './switchbot-verify-keylist.js',
    env: ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'SWITCHBOT_DEVICE_ID', 'KEYPAD_LAST4'],
    needsLast4: true
  },
  'webhook-url': {
    module: './switchbot-verify-webhook-raw.js',
    env: ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET'],
    needsLast4: false
  },
  'webhook-details': {
    module: './switchbot-verify-webhook-details.js',
    env: ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET', 'TARGET', 'VERIFY_RELAY_URL', 'VERIFY_WEBHOOK_TOKEN', 'VERIFY_OLD_WEBHOOK_URL'],
    needsLast4: false
  }
};

var ALLOWED_QUERY_ACTIONS = ['queryUrl', 'queryDetails'];

function operationNames() {
  return Object.keys(OPERATIONS);
}

/** 読み取り専用の API だけを通す fetch ラッパー。 */
function readOnlyFetch(fetchImpl) {
  return function (url, opts) {
    var method = String((opts && opts.method) || 'GET').toUpperCase();
    var allowed = false;
    if (method === 'GET' && url === Core.API_BASE + '/v1.1/devices') {
      allowed = true;
    } else if (method === 'POST' && url === Core.API_BASE + '/v1.1/webhook/queryWebhook') {
      try {
        var body = JSON.parse(opts && opts.body);
        allowed = !!body && ALLOWED_QUERY_ACTIONS.indexOf(body.action) !== -1;
      } catch (e) {
        allowed = false;
      }
    }
    if (!allowed) throw new Error('READ_ONLY_GUARD_BLOCKED');
    return fetchImpl(url, opts);
  };
}

/**
 * @param {object} env   process.env 相当（OPERATION と各診断の入力）
 * @param {Function} fetchImpl
 * @param {Function} log
 * @returns {Promise<number>} 終了コード（診断側の定義をそのまま返す。入口自身の拒否は 1）
 */
async function main(env, fetchImpl, log) {
  var name = env.OPERATION;
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(OPERATIONS, name)) {
    log('ERROR: operation が不正（' + operationNames().join(' / ') + ' のいずれか）。API は呼んでいません');
    return 1;
  }
  var op = OPERATIONS[name];
  if (op.needsLast4 && !/^[0-9A-Za-z]{4}$/.test(String(env.KEYPAD_LAST4 || '').trim())) {
    log('ERROR: 末尾4桁（英数字4文字）の入力が必要。API は呼んでいません');
    return 1;
  }
  var scoped = {};
  op.env.forEach(function (k) {
    if (env[k] !== undefined) scoped[k] = env[k];
  });
  var diag = require(op.module);
  log('operation=' + name + '（読み取り専用の診断）');
  return diag.main(scoped, readOnlyFetch(fetchImpl), log);
}

if (require.main === module) {
  main(process.env, fetch, function (m) { console.log(m); }).then(
    function (code) { process.exit(code); },
    function () { console.log('ERROR: 想定外の失敗（詳細は秘匿のため非表示）'); process.exit(1); });
}

module.exports = { main: main, readOnlyFetch: readOnlyFetch, OPERATIONS: OPERATIONS, operationNames: operationNames };
