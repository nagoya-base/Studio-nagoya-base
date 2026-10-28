/*
 * Issue #600: SNBトップを広告として再整理する（詳細説明は詳細ページへ。情報は削除しない）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function textOf(html) { return html.replace(/<[^>]+>/g, ''); }

var trust = read('_includes/phase2_trust_ja.html');
var legal = read('legal/index.html');
var howTo = read('how-to/index.html');
var top = read('index.html');
var css = read('styles/reservation-form.css').replace(/\/\*[\s\S]*?\*\//g, '');

function rule(selector) {
  var re = /([^{}]+)\{([^{}]*)\}/g, m;
  while ((m = re.exec(css))) {
    if (m[1].split(',').map(function (s) { return s.trim(); }).indexOf(selector) !== -1) return m[2];
  }
  return null;
}

test('#600: 相談送信ボタンは深緑背景＋白文字で、hover/focus/disabledでも可読', function () {
  var base = rule('.reservation-submit');
  assert.match(base, /background:\s*var\(--accent-dark\)/);
  assert.match(base, /color:\s*#fff/);
  ['.reservation-submit:hover', '.reservation-submit:disabled'].forEach(function (s) {
    assert.match(rule(s), /color:\s*#fff/, s);
    assert.match(rule(s), /background:/, s);
  });
  assert.ok(rule('.reservation-submit:focus-visible'), 'focus-visible');
});

test('#600: 「初めての方へ」の常時表示は1〜2文で、詳細へ導線がある', function () {
  var intro = trust.match(/id="first-time-title"[\s\S]*?<p class="phase2-intro">([\s\S]*?)<\/p>/)[1];
  ['初めての方でも', '完全貸切', '無人入室', '予約確定後に入室方法'].forEach(function (w) { assert.ok(intro.indexOf(w) !== -1, w); });
  assert.ok((textOf(intro).match(/。/g) || []).length <= 2);
  assert.strictEqual(trust.slice(0, trust.indexOf('id="safety"')).split('phase2-intro').length - 1, 1, '説明段落は1つだけ');
  assert.ok(trust.indexOf('/legal/\' | relative_url }}#faq-first-time') !== -1);
  assert.ok(trust.indexOf('#flow') !== -1);
});

test('#600: トップから外した説明は詳細ページに保持されている', function () {
  var faq = legal.slice(legal.indexOf('id="faq-first-time"'), legal.indexOf('</details>', legal.indexOf('id="faq-first-time"')));
  ['初めての方でも', '完全貸切', '無人入室', '入室方法や設備の使い方を事前にご案内', '緊縛サービスを提供する場所ではありません', '利用者自身が練習・撮影・講習を行う', '男女、性的指向、性自認を問わず'].forEach(function (w) {
    assert.ok(faq.indexOf(w) !== -1, 'legal FAQ: ' + w);
  });
  var scenes = howTo.slice(howTo.indexOf('id="usage-scenes"'), howTo.indexOf('id="food"'));
  ['動画や写真を使った振り返り', '吊りから床へ移る流れの練習', '一眼レフならさらに高いクオリティ', '同性カップル・クィアな表現', '飲食しながらの雑談'].forEach(function (w) {
    assert.ok(scenes.indexOf(w) !== -1, 'how-to: ' + w);
  });
  assert.ok(top.indexOf('/how-to/\' | relative_url }}#usage-scenes') !== -1, 'トップから到達できる');
});

test('#600: 英語トップも要点のみで、移した説明はhow-to/en.htmlに保持され導線がある', function () {
  var en = read('en.html');
  var enHow = read('how-to/en.html');
  var sec = enHow.slice(enHow.indexOf('id="rules-details"'), enHow.indexOf('id="food"'));
  [
    'Suspension use requires at least three people.', 'Suspension from the neck is strictly prohibited.',
    'The studio does not provide rope instruction or technical lessons.', 'Users are responsible for their own safety and consent.',
    'Follow all instructions regarding equipment and studio use.', 'Eating and drinking are prohibited in the tatami area',
    'parties and drinking gatherings are not permitted', 'renews automatically by credit card', 'at 4 hours the difference equals the monthly fee',
    '¥1,000 per booking (not per person)', 'Apply at least 1 week before your visit', 'a booking of 3 hours or longer is recommended'
  ].forEach(function (w) { assert.ok(sec.indexOf(w) !== -1, 'how-to/en: ' + w); });
  var safety = en.slice(en.indexOf('id="safety"'), en.indexOf('id="access"'));
  assert.ok((safety.match(/<li>/g) || []).length <= 4, '安全ルールは要点のみ');
  assert.strictEqual(safety.indexOf('rules-subnote'), -1);
  assert.ok(safety.indexOf('how-to/en.html#rules-details') !== -1);
  assert.strictEqual(en.indexOf('renews automatically by credit card'), -1);
  assert.strictEqual(en.indexOf('Apply at least 1 week'), -1);
  assert.ok(en.split('how-to/en.html#rules-details').length - 1 >= 3, '各所から詳細へ到達できる');
});

/* ---- トップ全体の説明量を固定（広告としての情報密度。再増殖防止） ---- */
function sentences(t) { return (t.replace(/\s+/g, '').match(/[。.!?！？]/g) || []).length; }
function stripDetails(html) { return html.replace(/<details[\s\S]*?<\/details>/g, ''); }
function visibleParagraphs(html) {
  var out = [], re = /<p\b[^>]*>([\s\S]*?)<\/p>/g, m;
  stripDetails(html).replace(/<div class="reservation-legacy-rollback"[\s\S]*?<\/form>\s*<\/div>/, '').replace(re, function (_, inner) { out.push(textOf(inner)); return ''; });
  return out;
}

test('#600: 日本語トップの利用用途カードは見出し＋1行キャッチのみ', function () {
  var cards = top.match(/<article class="usage-card">[\s\S]*?<\/article>/g);
  assert.strictEqual(cards.length, 4);
  cards.forEach(function (c) {
    var ps = c.match(/<p>[\s\S]*?<\/p>/g);
    assert.strictEqual(ps.length, 1, '1行のみ');
    assert.ok(sentences(textOf(ps[0])) <= 1 && textOf(ps[0]).length <= 40, textOf(ps[0]));
  });
});

test('#600: 日本語トップ（index.html/phase2_trust）の常時表示の説明段落は原則1〜2文', function () {
  var html = top + read('_includes/phase2_trust_ja.html');
  var bad = visibleParagraphs(html).filter(function (t) { return sentences(t) > 2; });
  assert.deepStrictEqual(bad, [], '2文超の常時表示段落: ' + bad.join(' / ').slice(0, 300));
});

test('#600: 英語トップの常時表示の説明段落は原則1〜2文で、legacyフォームを除く', function () {
  var bad = visibleParagraphs(read('en.html')).filter(function (t) { return sentences(t) > 2; });
  assert.deepStrictEqual(bad, [], '2文超の常時表示段落: ' + bad.join(' / ').slice(0, 300));
});
