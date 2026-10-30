'use strict';

/*
 * Google Sheets API v4 の最小クライアント（Issue #671のBookings schema migration専用）。
 * 依存パッケージなし。サービスアカウントのJWTでアクセストークンを取得する。
 *
 * 触れるのはシートのメタデータ・1行目のヘッダーセル・（必要な場合のみ）列数だけ。
 * 例外は固定コードのMigrationErrorに丸め、APIの応答本文・URL・ID・トークンは決して含めない。
 */
var crypto = require('crypto');
var MigrationError = require('./bookings-migration').MigrationError;

var API_BASE = 'https://sheets.googleapis.com/v4/spreadsheets/';
var SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function parseServiceAccount(json) {
  var parsed;
  try {
    parsed = JSON.parse(json);
  } catch (_) {
    throw new MigrationError('CREDENTIAL_INVALID');
  }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.client_email !== 'string' ||
      typeof parsed.private_key !== 'string' || typeof parsed.token_uri !== 'string' ||
      !/^https:\/\/[a-z0-9.-]*googleapis\.com\//.test(parsed.token_uri)) {
    throw new MigrationError('CREDENTIAL_INVALID');
  }
  return parsed;
}

function columnLetters(zeroBasedIndex) {
  var n = zeroBasedIndex + 1;
  var letters = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function a1SheetName(sheetName) {
  return "'" + sheetName.replace(/'/g, "''") + "'";
}

function statusToCode(status) {
  if (status === 401) return 'AUTHENTICATION_FAILED';
  if (status === 403) return 'ACCESS_DENIED';
  if (status === 404) return 'SPREADSHEET_NOT_FOUND_OR_INACCESSIBLE';
  if (status === 429 || status >= 500) return 'TRANSIENT_API_OR_NETWORK_ERROR';
  return 'SHEETS_API_ERROR';
}

function createSheetsClient(options) {
  var serviceAccount = parseServiceAccount(options.serviceAccountJson);
  var spreadsheetId = options.spreadsheetId;
  if (typeof spreadsheetId !== 'string' || !/^[A-Za-z0-9_-]{10,}$/.test(spreadsheetId)) {
    throw new MigrationError('CREDENTIAL_INVALID');
  }
  var doFetch = options.fetchImpl || fetch;
  var now = options.now || function () { return Math.floor(Date.now() / 1000); };
  var accessToken = null;

  async function send(url, init, failureCode) {
    var response;
    try {
      response = await doFetch(url, init);
    } catch (_) {
      throw new MigrationError('TRANSIENT_API_OR_NETWORK_ERROR');
    }
    if (!response.ok) throw new MigrationError(failureCode || statusToCode(response.status));
    try {
      return await response.json();
    } catch (_) {
      throw new MigrationError('SHEETS_API_ERROR');
    }
  }

  async function getAccessToken() {
    if (accessToken) return accessToken;
    var issuedAt = now();
    var unsigned = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + base64url(JSON.stringify({
      iss: serviceAccount.client_email, scope: SCOPE, aud: serviceAccount.token_uri,
      iat: issuedAt, exp: issuedAt + 3600
    }));
    var signature;
    try {
      signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key);
    } catch (_) {
      throw new MigrationError('CREDENTIAL_INVALID');
    }
    var body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: unsigned + '.' + base64url(signature)
    }).toString();
    var token = await send(serviceAccount.token_uri, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
    }, 'AUTHENTICATION_FAILED');
    if (!token || typeof token.access_token !== 'string') throw new MigrationError('AUTHENTICATION_FAILED');
    accessToken = token.access_token;
    return accessToken;
  }

  async function api(path, init) {
    var token = await getAccessToken();
    var headers = Object.assign({ Authorization: 'Bearer ' + token }, init && init.headers);
    return send(API_BASE + encodeURIComponent(spreadsheetId) + path, Object.assign({}, init, { headers: headers }));
  }

  return {
    /* シート名からsheetIdと列数だけを取得する（セル値は取得しない）。 */
    async getSheetInfo(sheetName) {
      var meta = await api('?fields=' + encodeURIComponent('sheets.properties(sheetId,title,gridProperties.columnCount)'));
      var sheets = (meta && meta.sheets) || [];
      for (var i = 0; i < sheets.length; i++) {
        var props = sheets[i].properties || {};
        if (props.title === sheetName) {
          return { sheetId: props.sheetId, columnCount: (props.gridProperties || {}).columnCount || 0 };
        }
      }
      return null;
    },

    /* 1行目（ヘッダー行）だけを読む。予約行は読まない。 */
    async readHeaderRow(sheetName) {
      var range = a1SheetName(sheetName) + '!1:1';
      var result = await api('/values/' + encodeURIComponent(range) + '?valueRenderOption=UNFORMATTED_VALUE');
      return (result && result.values && result.values[0]) || [];
    },

    /* グリッドの列数を広げる（既存セルの値は変わらない）。 */
    async ensureColumnCount(sheetId, columnCount) {
      await api(':batchUpdate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [{ updateSheetProperties: {
          properties: { sheetId: sheetId, gridProperties: { columnCount: columnCount } },
          fields: 'gridProperties.columnCount'
        } }] })
      });
    },

    /* ヘッダー行のstartIndex以降のセルへ値を書く（RAW。1行目以外には書かない）。 */
    async writeHeaderCells(sheetName, startIndex, values) {
      var range = a1SheetName(sheetName) + '!' + columnLetters(startIndex) + '1:' +
        columnLetters(startIndex + values.length - 1) + '1';
      await api('/values/' + encodeURIComponent(range) + '?valueInputOption=RAW', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: range, majorDimension: 'ROWS', values: [values] })
      });
    }
  };
}

module.exports = { createSheetsClient: createSheetsClient, columnLetters: columnLetters, parseServiceAccount: parseServiceAccount };
