/*
 * Issue #613: 英語トップをSNB本体のブランド軸（緊縛・縄の練習・創作／完全貸切・無人入室）へ再構成する。
 * トップは見出し＋短い説明＋導線、詳細は how-to/en.html に保持する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var childProcess = require('node:child_process');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function section(html, id) {
  var start = html.indexOf('id="' + id + '"');
  assert.ok(start !== -1, '#' + id);
  return html.slice(start, html.indexOf('</section>', start));
}
function textOf(html) { return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim(); }
var en = read('en.html');
var howTo = read('how-to/en.html');
var visible = en.replace(/<div class="reservation-legacy-rollback"[\s\S]*?<\/form>\s*<\/div>/, '').replace(/<script[\s\S]*?<\/script>/g, '');

test('#613: ヒーロー・title・descriptionがSNB本体の用途（縄の練習・貸切・無人入室）を表す', function () {
  var hero = section(en, 'main-content').slice(0, en.slice(en.indexOf('id="main-content"')).indexOf('</section>'));
  var h1 = en.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)[1];
  assert.ok(/shibari/i.test(h1) && /rope practice/i.test(h1) && /Nagoya/.test(h1));
  var sub = en.match(/<p class="hero-sub">([\s\S]*?)<\/p>/)[1];
  ['fully private', 'unmanned entry', 'rope practice', 'rehearsal', 'workshops', 'creative'].forEach(function (w) {
    assert.ok(sub.toLowerCase().indexOf(w) !== -1, 'hero-sub: ' + w);
  });
  var desc = en.match(/<meta name="description" content="([^"]*)"/)[1];
  assert.ok(/fully private/i.test(desc) && /shibari/i.test(desc) && /unmanned entry/i.test(desc));
  assert.ok(hero.length > 0);
});

test('#613: portraits / cosplay を主訴求にしていない（トップ全体・メタ・構造化データ）', function () {
  // #297 hidden rollbackフォームの選択肢（Portrait/Cosplay photography）は資産として保持するため対象外
  var shown = en.replace(/<div class="reservation-legacy-rollback"[\s\S]*?<\/form>\s*<\/div>/, '');
  assert.ok(!/portrait|cosplay/i.test(shown), 'トップに portraits/cosplay が残っている');
  assert.ok(!/Photography Studio/i.test(shown), '写真スタジオ寄りのタイトルが残っている');
  assert.ok(!/Studio X|studio-x/i.test(shown), 'Studio X への言及を持ち込まない');
});

test('#613: 用途セクションは見出し＋1行キャッチの4カードのみ', function () {
  var uses = section(en, 'uses');
  var cards = uses.match(/<article class="usage-card">[\s\S]*?<\/article>/g);
  assert.strictEqual(cards.length, 4);
  cards.forEach(function (c) {
    var ps = c.match(/<p>[\s\S]*?<\/p>/g);
    assert.strictEqual(ps.length, 1);
    assert.ok(textOf(ps[0]).length <= 60 && (textOf(ps[0]).match(/[.!?]/g) || []).length <= 1, textOf(ps[0]));
  });
  assert.ok(uses.indexOf('how-to/en.html#usage-scenes') !== -1);
});

test('#613: 初めての方ブロックは完全貸切・無人入室を示し、詳細へ誘導する', function () {
  var ft = section(en, 'first-time');
  assert.ok(/Fully Private/.test(ft) && /Unmanned/i.test(ft));
  assert.ok(ft.indexOf('how-to/en.html#flow') !== -1 && ft.indexOf('how-to/en.html#faq-full') !== -1);
});

test('#613: トップの常時表示段落は原則2文以内で、詳細説明を長文化していない', function () {
  var re = /<p\b[^>]*>([\s\S]*?)<\/p>/g, m, bad = [];
  var stripped = visible.replace(/<details[\s\S]*?<\/details>/g, '');
  while ((m = re.exec(stripped))) {
    var t = textOf(m[1]);
    if ((t.replace(/\s+/g, '').match(/[.!?。]/g) || []).length > 2) bad.push(t);
  }
  assert.deepStrictEqual(bad, []);
  assert.ok(!/<section id="info"/.test(en), '旧Key Informationの長いリストはトップに残さない');
});

test('#613: トップのFAQは3問で、構造化データと一致し、全件は詳細ページにある', function () {
  var faq = section(en, 'faq');
  assert.strictEqual((faq.match(/<details class="faq-item">/g) || []).length, 3);
  assert.ok(faq.indexOf('how-to/en.html#faq-full') !== -1);
  var ld = en.split('<script type="application/ld+json">').map(function (b) { return b.slice(0, b.indexOf('</script>')); })
    .filter(function (b) { return b.indexOf('"FAQPage"') !== -1; })[0];
  var names = JSON.parse(ld).mainEntity.map(function (q) { return q.name; });
  assert.strictEqual(names.length, 3);
  names.forEach(function (n) { assert.ok(faq.indexOf(n) !== -1, n); });
  var full = section(howTo, 'faq-full');
  ['first-time guest', 'smartphone', 'commercial use', 'payment methods', 'parking', 'rope practice and photography'].forEach(function (w) {
    assert.ok(full.toLowerCase().indexOf(w) !== -1, 'how-to/en: ' + w);
  });
  assert.ok(howTo.indexOf('id="faq-first-time"') !== -1);
});

test('#613: 移した利用シーン・設備の説明は how-to/en.html に保持され、トップから到達できる', function () {
  var scenes = section(howTo, 'usage-scenes');
  ['Regular practice', 'Show and act rehearsal', 'Small workshops', 'Creative rope shoots'].forEach(function (w) { assert.ok(scenes.indexOf(w) !== -1, w); });
  var eq = section(howTo, 'equipment');
  ['2,350 mm', '1,460 × 800 mm', 'Hemp rope', 'maximum 4 guests'].forEach(function (w) { assert.ok(eq.indexOf(w) !== -1, w); });
  assert.ok(section(en, 'equipment').indexOf('how-to/en.html#equipment') !== -1);
  assert.ok(!/portrait|cosplay/i.test(howTo));
});

test('#613: 日本語トップとブランド軸が一致（貸切・無人・吊り設備・ミラー・自主練/ショー練習/講習/作品）', function () {
  var ja = read('index.html');
  ['完全貸切', '無人', '吊り', 'ミラー', '自主練', 'ショー', '講習', '作品'].forEach(function (w) { assert.ok(ja.indexOf(w) !== -1, 'ja: ' + w); });
  var e = visible.toLowerCase();
  ['fully private', 'unmanned', 'rigging frame', 'mirror', 'practice', 'rehearsal', 'workshops', 'creative'].forEach(function (w) { assert.ok(e.indexOf(w) !== -1, 'en: ' + w); });
});

test('#613: 料金・予約導線・安全/法務導線・ヒーローCTAは維持', function () {
  assert.ok(en.indexOf('id="pricing"') !== -1 && en.indexOf('SNB MEMBER Rate (¥500 per month)') !== -1);
  assert.ok(/<a class="btn-primary" href="booking\/en\.html">Choose a Date &amp; Book<\/a>/.test(en));
  assert.ok(en.indexOf('how-to/en.html#rules-details') !== -1 && en.indexOf('legal/en.html#terms') !== -1);
  assert.ok(/Shower: SNB MEMBER-only option from Dec 1, 2026/.test(en));
});

test('#613: 内部リンクとアンカーが実在する', function () {
  var links = en.match(/href="(?:how-to\/en\.html|booking\/en\.html|legal\/en\.html|index\.html)(#[^"]*)?"/g) || [];
  links.forEach(function (l) {
    var m = l.match(/href="([^"#]+)(?:#([^"]*))?"/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', m[1])), m[1]);
    if (m[2]) assert.ok(read(m[1]).indexOf('id="' + m[2] + '"') !== -1, m[1] + '#' + m[2]);
  });
  (en.match(/href="#([^"]+)"/g) || []).forEach(function (l) {
    var id = l.slice(7, -1);
    assert.ok(en.indexOf('id="' + id + '"') !== -1, '#' + id);
  });
});

test('#613: #297 hidden rollback資産・予約ロジック・GAS・Stripeは変更されていない', function () {
  assert.ok(/<div class="reservation-legacy-rollback" hidden>/.test(en));
  ['https://formspree.io/f/maqreqjk', 'id="reservation-request-form"', 'id="calendar"', 'reservation-form-en.js'].forEach(function (w) { assert.ok(en.indexOf(w) !== -1, w); });
  var base = childProcess.spawnSync('git', ['merge-base', 'HEAD', 'origin/main'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
  if (base.status !== 0) return; // shallow / no origin: skip the diff-based guard
  var diff = childProcess.spawnSync('git', ['diff', '--name-only', base.stdout.trim()], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).stdout.split('\n');
  var forbidden = diff.filter(function (f) { return /^(gas\/|scripts\/reservation-form|cloud-run\/|studio-x\/|booking\/|_includes\/booking_app)/.test(f); });
  assert.deepStrictEqual(forbidden, []);
  var legacy = en.match(/<div class="reservation-legacy-rollback" hidden>[\s\S]*?<\/form>\s*<\/div>/)[0];
  assert.ok(legacy.length > 1000);
});
