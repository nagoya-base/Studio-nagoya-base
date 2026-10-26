'use strict';

/*
 * Issue #530: SNB MEMBERの既存Product指定はScript Property `STRIPE_MEMBER_PRODUCT_ID` を正とし、
 * 本番の具体的なProduct IDをリポジトリ（コード・ドキュメント）へ残さない。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('Config.gsはSTRIPE_MEMBER_PRODUCT_IDからmembershipProductIdを読む', () => {
  assert.match(read('gas/booking/shared/Config.gs'), /membershipProductId:\s*properties\.getProperty\('STRIPE_MEMBER_PRODUCT_ID'\)/);
});

test('コード・復旧手順書に誤ったProperty名STRIPE_MEMBERSHIP_PRODUCT_IDが残っていない', () => {
  ['gas/booking/admin/StripeWebhookProcessor.gs', 'gas/booking/shared/Config.gs', 'docs/membership-subscription-recovery.md']
    .forEach((rel) => assert.doesNotMatch(read(rel), /STRIPE_MEMBERSHIP_PRODUCT_ID/, rel));
});

test('復旧手順書・Stripe関連GASに具体的なStripe Product IDを記載しない', () => {
  ['docs/membership-subscription-recovery.md', 'gas/booking/admin/StripeWebhookProcessor.gs',
    'gas/booking/shared/StripeGateway.gs', 'gas/booking/shared/Config.gs']
    .forEach((rel) => assert.doesNotMatch(read(rel), /\bprod_[A-Za-z0-9]{6,}/, rel));
});
