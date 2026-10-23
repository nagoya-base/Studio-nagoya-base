/*
 * Issue #407: オンラインクレジットカード決済の一般向け案内は、Stripe Checkoutの決済ページでの
 * 即時決済を正とする。旧ルール（利用開始96時間前まで／4日前まで／申込から24時間以内に決済リンク／
 * 申込から72時間後まで）がWeb・規約・予約フォームの表示に残っていないことを保証する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const PUBLIC_FILES = [
  'index.html',
  'mens/index.html',
  'studio-x/index.html',
  'studio-x/booking/index.html',
  'studio-x/legal/index.html',
  '_includes/legal_ja.html',
  '_includes/booking_app_ja.html',
  '_includes/booking_app_en.html',
  '_includes/reservation_form_ja.html'
];

const FORBIDDEN = [
  /96時間/,
  /(?<![0-9])4日前/,
  /24時間以内に(お送り|決済リンク)/,
  /72時間後/,
  /決済リンク(は|を)(、)?(お申し込み|メール)/,
  /96 hours/i,
  /payment link within 24 hours/i
];

test('Web・規約・予約フォームの表示に、カード決済の旧一般向けルール（96時間/4日前/24時間以内の決済リンク/72時間後）が残っていない', function () {
  PUBLIC_FILES.forEach(function (file) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    FORBIDDEN.forEach(function (pattern) {
      assert.doesNotMatch(html, pattern, file + ' に旧ルール ' + pattern + ' が残っている');
    });
  });
});

test('規約・トップのカード決済案内は、決済ページでの支払いと「有効期限内の決済完了で確定／期限切れ・未完了は確定しない」を示す', function () {
  ['index.html', '_includes/legal_ja.html', 'studio-x/legal/index.html'].forEach(function (file) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(html, /予約申込後に表示される決済ページでお支払いください/, file);
    assert.match(html, /決済ページの有効期限内にお支払いが完了した場合に予約が確定します/, file);
    assert.match(html, /期限切れ・決済未完了の場合、予約は確定しません|期限切れ・決済未完了の場合は予約が確定しません/, file);
  });
});
