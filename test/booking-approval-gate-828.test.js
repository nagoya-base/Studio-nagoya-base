'use strict';
// Issue #828: booking-production の承認ゲートの扱い。workflowの保護が弱められていないこと、
// 設計文書が影響範囲・復旧・記録欄を持ち、秘密値を含まないことを静的に確認する。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const doc = read('docs/booking-production-approval-gate-828.md');
const wfDir = path.join(root, '.github/workflows');
const users = fs.readdirSync(wfDir)
  .filter((f) => /^\s*environment:\s*booking-production\s*$/m.test(read(`.github/workflows/${f}`)));

test('booking-production を使う workflow は想定の3本だけで、文書が全て挙げている', () => {
  assert.deepEqual(users.sort(), [
    'booking-gas-production.yml',
    'booking-gas-webhook-production.yml',
    'confirm-booking-production-account.yml',
  ]);
  for (const name of ['Deploy Booking GAS to production', 'Update Booking Webhook GAS', 'Confirm booking-production Google account']) {
    assert.ok(doc.includes(name), name);
  }
});

test('Booking本番 workflow は workflow_dispatch のみで起動し、main限定で、更新前に必ずテストを通す', () => {
  for (const f of ['booking-gas-production.yml', 'booking-gas-webhook-production.yml']) {
    const wf = read(`.github/workflows/${f}`);
    const on = wf.match(/\non:\n([\s\S]*?)\n\S/)[1];
    assert.match(on, /^  workflow_dispatch:/m, f);
    assert.doesNotMatch(on, /^  (push|pull_request|pull_request_target|schedule|workflow_run):/m, f);
    const jobs = wf.split(/\njobs:\n/)[1].split(/\n  (?=[a-z_-]+:\n)/);
    const deploy = jobs.find((j) => /^\s*deploy:/.test(j));
    if (f === 'booking-gas-production.yml') {
      // Issue #874: 承認をテスト前へ。Secretsなしの簡易検査job（main限定）→ Environment job内でテスト → 書込み。
      const validate = jobs.find((j) => /^\s*validate:/.test(j));
      assert.match(validate, /if: github\.ref == 'refs\/heads\/main'/, f);
      assert.match(deploy, /if: github\.ref == 'refs\/heads\/main'/, f);
      assert.match(deploy, /\n    needs: validate\n/, f);
      assert.ok(deploy.indexOf('npm test') > 0 && deploy.indexOf('npm test') < deploy.indexOf('secrets.'), 'tests before the first secret');
    } else {
      // testはmain限定。deployは needs: test により、testがskipされればskipされる（直接ifは必須にしない）。
      const test = jobs.find((j) => /^\s*test:/.test(j));
      assert.match(test, /if: github\.ref == 'refs\/heads\/main'/, f);
      assert.match(deploy, /\n    needs: test\n/, f);
    }
    assert.match(wf, /permissions:\n  contents: read/, f);
    assert.match(wf, /cancel-in-progress: false/, f);
  }
});

test('文書: 影響範囲・案比較・復旧・記録欄・未検証の明示', () => {
  for (const re of [/Webhook[^\n]*同じEnvironment|同じEnvironmentを共有/, /案比較|方式比較/, /## 7\. 復旧/, /## 8\. 設定変更記録/,
    /運営者の明示的GO|運営者GO/, /preflight／post-checkは承認の代替ではない/, /schema_migrated/, /未検証/, /次回の正規Booking更新|次回正規更新/]) {
    assert.match(doc, re);
  }
  assert.match(doc, /Settingsを変更しない/);
});

test('文書: 秘密値・完全ID・Webhook URLを含まない', () => {
  assert.doesNotMatch(doc, /https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(doc, /AKfycb[A-Za-z0-9_-]{10,}/);
  assert.doesNotMatch(doc, /"refresh_token"|client_secret|whsec_|sk_live_/);
});

test('手順書が「Bookingは必須」と断定せず、#828 を参照している', () => {
  const guide = read('docs/gas-operator-one-screen-817.md');
  assert.doesNotMatch(guide, /Bookingは必須/);
  assert.match(guide, /booking-production-approval-gate-828\.md/);
  assert.match(read('docs/booking-gas-production-deploy.md'), /booking-production-approval-gate-828\.md/);
});

test('現在の設定を断定せず、運営者の手動変更報告を事実と未確認に区別し、記録先は#804', () => {
  assert.match(doc, /運営者の報告（事実として記録）/);
  assert.match(doc, /Required reviewersの\*\*現在値\*\*[^\n]*未確認|現在値[^\n]*未確認/);
  assert.match(doc, /将来の再設計案/);
  assert.match(doc, /巻き戻す指示ではない/);
  assert.doesNotMatch(doc, /#817\s*へ/);
  assert.match(doc, /#804\s*へ/);
  const guide = read('docs/gas-operator-one-screen-817.md');
  assert.doesNotMatch(guide, /#804 \/ #817 に記録/);
  assert.doesNotMatch(guide, /現状設定済みの前提/);
});
