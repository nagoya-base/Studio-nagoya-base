'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const top = fs.readFileSync(path.join(__dirname, '..', 'studio-x', 'index.html'), 'utf8');
const price = /<section class="price section-shell" id="price"[\s\S]*?<\/section>/.exec(top)[0];
const more = /<details class="price-more[\s\S]*?<\/details>/.exec(price)[0];

test('#607 料金詳細: スタッフ設営オプションの金額説明は1段落に一本化', function () {
  assert.strictEqual(top.split('事前設営3,000円').length - 1, 1, '事前設営3,000円はトップ全体で1回だけ');
  assert.strictEqual(top.split('セット5,000円').length - 1, 1, '設営＋片付けセット5,000円はトップ全体で1回だけ');
  const paragraphs = more.match(/<p>[\s\S]*?<\/p>/g).filter(function (p) { return p.indexOf('プレミアムオプション') !== -1; });
  assert.strictEqual(paragraphs.length, 1, 'プレミアムオプションの説明段落は1つ');
});

test('#607 料金詳細: 金額・会員限定条件・既存の2導線を維持', function () {
  ['事前設営3,000円', '片付け3,000円', '設営＋片付けセット5,000円', '会員限定', 'href="equipment/#staff-service"', 'href="membership/"'].forEach(function (w) {
    assert.ok(more.indexOf(w) !== -1, w);
  });
});
