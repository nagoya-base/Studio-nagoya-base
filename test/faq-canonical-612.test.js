/*
 * Issue #612: FAQの正本を legal から分離し、SNB / mens とも how-to の #faq-full に集約する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function textOf(html) { return html.replace(/<[^>]+>/g, ''); }
function ldFaq(html) {
  var out = [];
  html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, function (_, b) {
    var j = JSON.parse(b);
    if (j['@type'] === 'FAQPage') out = out.concat(j.mainEntity);
    return '';
  });
  return out;
}
function bodyFaq(html) {
  var out = [], re = /<summary>([\s\S]*?)<\/summary>\s*<div class="faq-answer">([\s\S]*?)<\/div>/g, m;
  var sec = html.slice(html.indexOf('id="faq-full"'), html.indexOf('id="legal-link"'));
  while ((m = re.exec(sec))) out.push({ name: textOf(m[1]), text: textOf(m[2]) });
  return out;
}
function bodyFaqAll(html) {
  var out = {}, re = /<summary>([\s\S]*?)<\/summary>\s*<div class="faq-answer">([\s\S]*?)<\/div>/g, m;
  while ((m = re.exec(html))) out[textOf(m[1])] = textOf(m[2]);
  return out;
}
function ids(html) { var o = []; html.replace(/\sid="([^"]+)"/g, function (_, i) { o.push(i); return ''; }); return o; }

var SETS = [
  { name: 'SNB', howTo: 'how-to/index.html', legal: 'legal/index.html', top: 'index.html', others: ['index.html', 'membership/index.html'], legalUrl: "'/legal/' | relative_url", howUrl: "'/how-to/' | relative_url" },
  { name: 'mens', howTo: 'mens/how-to/index.html', legal: 'mens/legal/index.html', top: 'mens/index.html', others: ['mens/index.html', 'mens/membership/index.html'], legalUrl: "'/mens/legal/' | relative_url", howUrl: "'/mens/how-to/' | relative_url" }
];

SETS.forEach(function (s) {
  var howTo = read(s.howTo), legal = read(s.legal), top = read(s.top);

  test('#612 ' + s.name + ': FAQ正本は how-to の #faq-full にあり、初回利用FAQ(SNB)・質問が欠けていない', function () {
    assert.ok(ids(howTo).indexOf('faq-full') !== -1);
    assert.ok(bodyFaq(howTo).length >= (s.name === 'SNB' ? 23 : 19), '移設前のFAQ件数を下回らない');
    if (s.name === 'SNB') assert.ok(ids(howTo).indexOf('faq-first-time') !== -1);
  });

  test('#612 ' + s.name + ': legal に FAQ本文・FAQPage JSON-LD・faq-id が残っていない', function () {
    assert.strictEqual(ids(legal).indexOf('faq-full'), -1);
    assert.strictEqual(ids(legal).indexOf('faq-first-time'), -1);
    assert.strictEqual(legal.indexOf('data-analytics-faq-id'), -1);
    assert.strictEqual(legal.indexOf('class="faq-item"'), -1);
    assert.strictEqual(ldFaq(legal).length, 0);
    assert.ok(legal.indexOf('how-to/#faq-full') !== -1, 'FAQへの導線');
    assert.ok(legal.indexOf("location.replace('../how-to/'") !== -1, '旧アンカー互換リダイレクト');
  });

  test('#612 ' + s.name + ': FAQ正本のJSON-LDは本文と一致し、他ページと質問が重複しない', function () {
    var body = bodyFaq(howTo);
    var ld = ldFaq(howTo);
    assert.ok(ld.length > 0);
    ld.forEach(function (e) {
      var b = body.filter(function (q) { return q.name === e.name; })[0];
      assert.ok(b, '本文にある: ' + e.name);
      assert.strictEqual(b.text, e.acceptedAnswer.text, e.name);
    });
    var seen = {};
    s.others.forEach(function (p) {
      ldFaq(read(p)).forEach(function (e) {
        assert.ok(!ld.some(function (x) { return x.name === e.name; }), '重複構造化なし: ' + e.name);
      });
    });
    ld.forEach(function (e) { assert.ok(!seen[e.name]); seen[e.name] = 1; });
    /* トップのFAQ JSON-LDも本文と一致 */
    var topBody = bodyFaqAll(top);
    ldFaq(top).forEach(function (e) {
      assert.ok(topBody[e.name] === e.acceptedAnswer.text, 'トップLDと本文の一致: ' + e.name);
    });
  });

  test('#612 ' + s.name + ': トップ／共通導線が新FAQ正本を指し、旧legal FAQリンクがない', function () {
    assert.ok(top.indexOf(s.howUrl + ' }}#faq-full') !== -1);
    [s.top, s.howTo, s.legal, '_includes/phase2_trust_ja.html', '_includes/legal_ja.html', '_includes/header_ja.html'].forEach(function (p) {
      assert.ok(!/legal\/'? ?(\| relative_url \}\})?#faq/.test(read(p)), p + ' に旧 legal/#faq リンク');
    });
    assert.ok(read('_includes/phase2_trust_ja.html').indexOf("'/how-to/' | relative_url }}#faq-first-time") !== -1);
  });
});

test('#612: 既存の data-analytics-faq-id が how-to に維持されている（SNB）', function () {
  var h = read('how-to/index.html');
  ['snb_member', 'snb_member_prestart', 'snb_member_billing', 'snb_member_benefits', 'first_time', 'bondage_allowed', 'gender', 'food_drink', 'alcohol', 'smartphone_photography', 'equipment_rental', 'cancellation', 'weather_cancellation', 'payment_method', 'instruction_service', 'same_day_extension', 'key_handover', 'reschedule', 'backdrop_paper', 'parking', 'commercial_use', 'shower', 'lost_item'].forEach(function (id) {
    assert.ok(h.indexOf('data-analytics-faq-id="' + id + '"') !== -1, id);
  });
  assert.ok(read('mens/how-to/index.html').indexOf('data-analytics-faq-id="mens_member_price"') !== -1);
});

test('#612: 内部リンク #cancel / #terms は legal 内に存在し、FAQ内のリンクが解決できる', function () {
  var legalIds = ids(read('legal/index.html') + read('_includes/legal_ja.html'));
  ['cancel', 'terms', 'privacy'].forEach(function (i) { assert.ok(legalIds.indexOf(i) !== -1, i); });
  ['how-to/index.html', 'mens/how-to/index.html'].forEach(function (p) {
    var h = read(p);
    assert.strictEqual(h.indexOf('href="#cancel"'), -1);
    assert.strictEqual(h.indexOf('href="#terms"'), -1);
  });
});
