'use strict';
// #707: 特商法ページのモバイル表示で本文幅が極端に狭くならないこと
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'common.css'), 'utf8');

function mobileBlock() {
  const start = css.indexOf('スマートフォン幅（#707）');
  assert.ok(start >= 0, '#707 のモバイル向けルールがある');
  const media = css.indexOf('@media (max-width: 640px)', start);
  assert.ok(media >= 0, 'max-width: 640px のメディアクエリがある');
  const open = css.indexOf('{', media);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error('メディアクエリが閉じていない');
}

test('モバイルでは th/td を縦積みにし全幅で表示する', () => {
  const block = mobileBlock();
  assert.match(block, /\.legal-table th,[\s\S]*display:\s*block;[\s\S]*width:\s*100%/);
});

test('モバイルでは項目名の nowrap を解除する', () => {
  assert.match(mobileBlock(), /\.legal-table th\s*\{[^}]*white-space:\s*normal/);
});

test('PC向けの th 幅 40% は維持される', () => {
  assert.match(css, /\.legal-table th\s*\{[^}]*width:\s*40%[^}]*white-space:\s*nowrap/);
});
