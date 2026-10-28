'use strict';
/*
 * Issue #629: SNB / mensトップ料金欄の常時表示を広告レベルまで圧縮する。
 * 料金・制度内容は変えず、詳細は /membership/・規約・閉じたアコーディオンを正本にする。
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
function textOf(html) { return html.replace(/<[^>]+>/g, ''); }
function pricingOf(html, open) {
  var a = html.indexOf(open);
  return html.slice(a, html.indexOf('</section>', a));
}
function visibleOf(pricing) { return pricing.replace(/<details[\s\S]*?<\/details>/g, ''); }
function sentences(p) { return textOf(p.replace(/<a[\s\S]*?<\/a>/g, '')).split('。').filter(function (x) { return x.trim() !== ''; }).length; }

var snbTop = read('index.html');
var mensTop = read('mens/index.html');
var snb = pricingOf(snbTop, '<section id="pricing">');
var mens = pricingOf(mensTop, '<section id="pricing" class="bg-section">');
var BLOCKS = { snb: snb, mens: mens };

/* 表の「会員料金」を {時間: [土日祝, 平日]} に取り出す */
function memberTable(html, header) {
  var re = new RegExp('<div class="pricing-card-header">' + header + '[^<]*</div>\\s*<table>([\\s\\S]*?)</table>');
  var body = html.match(re)[1];
  var rows = {};
  (body.match(/<tr[\s\S]*?<\/tr>/g) || []).forEach(function (tr) {
    var cells = (tr.match(/<td>[\s\S]*?<\/td>/g) || []).map(function (c) { return textOf(c).replace(/[▼].*$/, '').replace(/(約20～25% OFF|会員料金)$/, '').trim(); });
    if (cells.length === 3) rows[cells[0].replace(/(約20～25% OFF|会員料金)$/, '')] = [cells[1], cells[2]];
  });
  return rows;
}

test('#629: SNB会員料金表とmens会員料金表の数値が一致する（共通事実の乖離検知）', function () {
  var a = memberTable(snb, 'SNB MEMBER料金');
  var b = memberTable(mens, '会員料金');
  assert.deepStrictEqual(Object.keys(a).length, 5);
  assert.deepStrictEqual(b, a);
  assert.deepStrictEqual(a['3時間'], ['7,000円', '5,500円']);
  assert.deepStrictEqual(a['4時間'], ['9,000円', '7,000円']);
});

test('#629: 通常料金と会員料金の差額・月額500円がSNBトップで正しく、mensと月額が一致する', function () {
  var normal = memberTable(snb, '通常価格');
  var member = memberTable(snb, 'SNB MEMBER料金');
  assert.deepStrictEqual(normal['3時間'], ['7,500円', '6,000円']);
  assert.deepStrictEqual(normal['1時間'], member['1時間']);
  assert.deepStrictEqual(normal['2時間'], member['2時間']);
  assert.ok(snb.indexOf('月額500円') !== -1 && mens.indexOf('月額500円') !== -1);
});

test('#629: 12/1の時制はSNBトップに一言だけ残り、作成日／利用日などの細部は常時表示に置かない', function () {
  var visible = textOf(visibleOf(snb));
  assert.ok(visible.indexOf('受付中') !== -1);
  assert.ok(visible.indexOf('会員料金は2026年12月1日以降のご予約から適用されます') !== -1);
  assert.strictEqual((visible.match(/2026年12月1日/g) || []).length, 1, '12/1の記述は1箇所のみ');
  ['作成', '利用日', '確認コード', '90日先行予約', 'ペアパック', 'シャワー', '差額', '月会費'].forEach(function (w) {
    assert.strictEqual(visible.indexOf(w), -1, 'SNB常時表示に「' + w + '」を置かない');
  });
});

test('#629: mensトップも細部を常時表示に置かず、12/1の時制は一言に留める', function () {
  var visible = textOf(visibleOf(mens));
  ['作成日', '確認コード', '1週間前', '承認後', '固定料金', '6,500円', 'ペアパック（', 'シャワー（'].forEach(function (w) {
    assert.strictEqual(visible.indexOf(w), -1, 'mens常時表示に「' + w + '」を置かない');
  });
  assert.ok(visible.indexOf('2026年12月1日以降') !== -1);
  assert.strictEqual((visible.match(/2026年12月1日/g) || []).length, 1);
});

test('#629: mens固有の主訴求（加入なしでも会員料金／会員資格は付与されない）は常時表示に残る', function () {
  var banner = mens.slice(mens.indexOf('member-banner-text'), mens.indexOf('mens-member-cta'));
  var t = textOf(banner);
  assert.ok(t.indexOf('SNB mensからのご予約は、会員料金でご利用いただけます') !== -1);
  assert.ok(t.indexOf('への加入有無にかかわらず') !== -1 && t.indexOf('料金の優遇') !== -1 && t.indexOf('会員資格が付与されるものではありません') !== -1);
  assert.ok(textOf(mens).indexOf('通常のお部屋料金は、会員加入なしでも会員料金のままです') !== -1);
});

test('#629: 料金欄の常時表示は各ブロック2文以内、※注記は2行以内', function () {
  Object.keys(BLOCKS).forEach(function (k) {
    var visible = visibleOf(BLOCKS[k]);
    var paras = visible.match(/<p[ >][\s\S]*?<\/p>/g) || [];
    paras.forEach(function (p) {
      if (/class="(section-subtitle|usage-duration-label)"/.test(p)) return;
      assert.ok(sentences(p) <= 2, k + ': 1ブロック2文以内: ' + textOf(p).slice(0, 40));
    });
    var banner = visible.match(/member-banner-text">([\s\S]*?)<\/div>/);
    if (banner) assert.ok(sentences('<p>' + banner[1].replace(/<strong>[\s\S]*?<\/strong>/, '') + '</p>') <= 2, k + ': バナー本文2文以内');
    var notes = visible.match(/<p class="pricing-note"[^>]*>※/g) || [];
    assert.ok(notes.length <= 2, k + ': ※注記は最大2行相当');
    notes.forEach(function () { /* 各注記は1文 */ });
    (visible.match(/<p class="pricing-note"[^>]*>※[\s\S]*?<\/p>/g) || []).forEach(function (p) {
      assert.ok(textOf(p).length <= 60, k + ': ※注記は1〜2行に収まる長さ');
    });
  });
});

test('#629: 規約確認注記と延長割引の重複説明をトップ常時表示から外し、規約への通常導線は残す', function () {
  Object.keys(BLOCKS).forEach(function (k) {
    var visible = textOf(visibleOf(BLOCKS[k]));
    assert.strictEqual(visible.indexOf('ご予約前に必ず'), -1, k);
    assert.strictEqual(visible.indexOf('❖'), -1, k + ': 延長割引の重複説明');
    assert.strictEqual(BLOCKS[k].indexOf('pricing-extension-note'), -1, k);
  });
  assert.ok(snbTop.indexOf("'/legal/' | relative_url") !== -1, 'SNBから規約への導線');
  assert.ok(mensTop.indexOf("'/mens/legal/' | relative_url") !== -1, 'mensから規約への導線');
  assert.ok(snb.indexOf("'/legal/' | relative_url") !== -1 && mens.indexOf("'/mens/legal/' | relative_url") !== -1, '料金欄のアコーディオンに規約リンク');
  /* 規約同意は予約フローで必須取得（#603） */
  var consent = read('_includes/booking_terms_consent_ja.html');
  assert.ok(/ba-confirm-terms/.test(consent) && /ba-confirm-safety/.test(consent));
});

test('#629: 省いた3時間以上推奨・プラットフォーム対象外などはアコーディオンへ、正本は詳細ページに保持', function () {
  var snbDetails = snb.slice(snb.indexOf('<details'));
  assert.ok(snbDetails.indexOf('緊縛・吊り床を使う撮影は3時間以上のご予約をおすすめします') !== -1);
  assert.ok(snbDetails.indexOf('プラットフォーム経由のご予約は対象外') !== -1);
  var mensDetails = mens.slice(mens.indexOf('<details'));
  ['ユニフォーム・フェティッシュ衣装撮影は2時間から', '緊縛・ロープ表現を含む撮影は3時間以上', 'プラットフォーム経由のご予約には適用されません', '会員資格を前提とするサービスが自動で使えるようになるものでもありません'].forEach(function (w) {
    assert.ok(mensDetails.indexOf(w) !== -1, w);
  });
  assert.strictEqual((snb.match(/<details/g) || []).length, 1, 'SNB料金欄のアコーディオンを増やさない');
  assert.strictEqual((mens.match(/<details/g) || []).length, 1, 'mens料金欄のアコーディオンは1つ');
  assert.strictEqual(snb.indexOf('<details open'), -1);
  /* 正本 */
  var benefits = textOf(read('_includes/membership_benefits_ja.html'));
  ['90日先行予約', '2名ペアパック', '5,000円', '6,000円', '1,000円', '6,500円', '1〜2名'].forEach(function (w) { assert.ok(benefits.indexOf(w) !== -1, '会員特典に' + w); });
  var terms = textOf(read('_includes/membership_terms_ja.html'));
  assert.ok(terms.indexOf('2026年12月1日以降に作成するご予約') !== -1 && terms.indexOf('ご利用日が2026年12月1日以降') !== -1);
  assert.ok(textOf(read('mens/membership/index.html')).indexOf('会員加入なしでも会員料金') !== -1);
});

test('#629: 詳細情報への導線がSNB / mensトップ料金欄にある', function () {
  assert.ok(snb.indexOf("'/membership/' | relative_url") !== -1);
  assert.ok(mens.indexOf("'/mens/membership/' | relative_url") !== -1);
  assert.ok(snb.indexOf('SNB MEMBERの内容を見て加入する') !== -1);
  assert.ok(mens.indexOf('会員限定の特典と加入方法を見る') !== -1);
});

test('#629: 固定Stripeリンクと予約CTAは維持され、料金欄でfont-sizeを下げて詰め込んでいない', function () {
  var link = 'https://buy.stripe.com/cNi3cwb5seVgc2Tgsw9k40a';
  assert.strictEqual(snbTop.split(link).length - 1, 1);
  assert.ok(snb.indexOf('予約確定済みの方：カードで支払う') !== -1);
  assert.ok(snb.indexOf('日時を選んで予約する') !== -1);
  Object.keys(BLOCKS).forEach(function (k) {
    assert.ok(!/font-size/.test(BLOCKS[k]), k + ': 料金欄にインラインfont-sizeを置かない');
  });
});
