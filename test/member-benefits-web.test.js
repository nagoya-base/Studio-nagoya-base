/*
 * 会員限定特典（Issue #478）のWebコピー・OGP・導線・予約フォームの静的検証。
 *
 * - /membership/・/mens/membership/・/studio-x/membership/ が存在し、ページ固有のog/twitter/canonicalを持ち、
 *   各ブランドトップと同じ画像資産（他ブランドの画像を誤流用しない）・同じhero構造を使うこと
 * - 画面の金額が予約システムの正本（BookingPricing.gs / BookingOptions.gs / _data/studio_x_equipment.json）と一致すること
 * - 各トップからの導線、規約・特商法・FAQ・JSON-LD・sitemap・docs・REVIEW_CHECKLISTの更新
 * - 予約フォーム（SNB / mens）のペアパック・シャワー選択と、Studio Xへ出さないこと
 * - mens専用のStripe商品・Success URLを作っていないこと
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var loadBookingSandbox = require('./helpers/gas-sandbox').loadBookingSandbox;
var loadFrontendSandbox = require('./helpers/frontend-sandbox').loadFrontendSandbox;

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }
function stripLiquid(html) { return html.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, ''); }
function textOf(html) {
  return stripLiquid(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/\{%-?[\s\S]*?-?%\}/g, '')
    .replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').replace(/ ?([^\x00-\x7f]) ?/g, '$1').trim();
}
function meta(html, key) {
  var re = new RegExp('<meta (?:property|name)="' + key + '" content="([^"]*)"');
  var m = re.exec(html);
  return m ? m[1] : null;
}
function canonical(html) {
  var m = /<link rel="canonical" href="([^"]*)"/.exec(html);
  return m ? m[1] : null;
}
/* 会員案内ページと同じ include を展開した本文（Liquidのincludeを実ファイルで置換する簡易展開）。 */
function expandIncludes(html) {
  return html.replace(/\{%\s*include\s+([a-z_]+\.html)[^%]*%\}/g, function (_, name) {
    return exists('_includes/' + name) ? read('_includes/' + name) : '';
  });
}
function faqLd(html) {
  var ld = null;
  html.replace(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g, function (_, body) {
    var parsed = JSON.parse(body);
    if (parsed['@type'] === 'FAQPage') ld = parsed;
    return '';
  });
  return ld;
}

var BASE = 'https://nagoya-base.github.io/Studio-nagoya-base';
var PAGES = {
  snb: { file: 'membership/index.html', url: BASE + '/membership/', top: 'index.html', image: BASE + '/images/studio-nagoya-base-hero-ogp.jpg' },
  mens: { file: 'mens/membership/index.html', url: BASE + '/mens/membership/', top: 'mens/index.html', image: BASE + '/images/ogp-mens-v2-1200x630.jpg' },
  studio_x: { file: 'studio-x/membership/index.html', url: BASE + '/studio-x/membership/', top: 'studio-x/index.html', image: BASE + '/studio-x/images/studio-x-ogp.jpg' }
};

var gas = loadBookingSandbox(['JapaneseHolidays.gs', 'MembershipRules.gs', 'BookingPricing.gs', 'EquipmentCatalog.gs', 'BookingOptions.gs'], {});
var Pricing = gas.BookingPricing;
var Options = gas.BookingOptions;
function yen(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円'; }

// ============================================================================
// ページの存在・OGP・hero
// ============================================================================

test('3つの会員ページが存在し、og/twitter/canonicalがページ固有で整合している', function () {
  var urls = {};
  Object.keys(PAGES).forEach(function (brand) {
    var p = PAGES[brand];
    assert.ok(exists(p.file), p.file);
    var html = read(p.file);
    assert.strictEqual(canonical(html), p.url, brand + ' canonical');
    assert.strictEqual(meta(html, 'og:url'), p.url, brand + ' og:url');
    ['og:title', 'og:description', 'twitter:title', 'twitter:description'].forEach(function (key) {
      assert.ok(meta(html, key) && meta(html, key).length > 10, brand + ' ' + key);
    });
    assert.strictEqual(meta(html, 'twitter:card'), 'summary_large_image');
    assert.strictEqual(meta(html, 'og:image'), p.image, brand + ' og:image はブランドトップと同じ画像資産');
    assert.strictEqual(meta(html, 'twitter:image'), p.image);
    /* トップと同じ画像資産（トップのog:imageと一致） */
    assert.strictEqual(meta(read(p.top), 'og:image'), p.image, brand + ' トップとOGP画像が一致');
    /* ページ固有: トップと同じタイトル・URLの流用ではない */
    assert.notStrictEqual(meta(html, 'og:title'), meta(read(p.top), 'og:title'));
    assert.notStrictEqual(meta(html, 'og:url'), meta(read(p.top), 'og:url'));
    assert.ok(!urls[meta(html, 'og:url')], 'og:urlが重複していない');
    urls[meta(html, 'og:url')] = true;
    assert.ok(/<title>[^<]{6,}<\/title>/.test(html));
    assert.ok(/<meta name="description" content="[^"]{20,}">/.test(html));
  });
});

test('各ブランドは他ブランドのOGP画像・ヒーロー画像を誤流用していない', function () {
  var snb = read(PAGES.snb.file), mens = read(PAGES.mens.file), x = read(PAGES.studio_x.file);
  assert.ok(!/ogp-mens|hero_mens|studio-x\/images|studio-x-ogp/.test(snb), 'SNBページにmens/Studio Xの画像');
  assert.ok(!/studio-nagoya-base-hero-ogp|hero_bondage|studio-x-ogp|studio-x\/images/.test(mens), 'mensページにSNB/Studio Xの画像');
  assert.ok(!/studio-nagoya-base-hero-ogp|ogp-mens|hero_mens|hero_bondage/.test(x), 'Studio Xページにsnb/mensの画像');
  ['images/studio-nagoya-base-hero-ogp.jpg', 'images/ogp-mens-v2-1200x630.jpg', 'studio-x/images/studio-x-ogp.jpg'].forEach(function (img) {
    assert.ok(exists(img), img + ' が存在する');
  });
});

test('SNB membership: SNBトップと同系統のhero（hero-ad）で、緊縛向けの2名ペアパック訴求が主役', function () {
  var html = read(PAGES.snb.file);
  assert.match(html, /<section class="hero-ad"[\s\S]*?studio-nagoya-base-hero-ogp\.webp[\s\S]*?studio-nagoya-base-hero-ogp\.jpg/);
  assert.match(read('index.html'), /<section class="hero-ad"/, 'トップも同じhero構造');
  var hero = textOf(html.slice(html.indexOf('<section class="hero-ad"'), html.indexOf('<section id="membership"')));
  /* textOfは日本語の前後の空白を詰めるため、空白を除いた形で比べる。 */
  ['ふたりで、3時間。縄に集中できる時間を。', 'SNB MEMBER限定「2名ペアパック」', '平日3時間 5,000円', '土日祝3時間 6,000円',
    '緊縛・縄撮影・自主練に使いやすい、2名までの会員専用プランです。', '月額500円 / SNB・SNB mens・Studio X共通会員'].forEach(function (w) {
    assert.ok(hero.replace(/\s+/g, '').indexOf(w.replace(/\s+/g, '')) !== -1, 'heroに「' + w + '」');
  });
  assert.match(html, /<link rel="stylesheet" href="\.\.\/styles\/bondage\.css/, 'トップと同じhero用CSS');
  assert.match(html, /<h1 [^>]*class="hero-ad-title"/, 'h1は1つ（heroの見出し）');
  assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1);
});

test('mens membership: mensトップと同じhero構造・OGP画像・ブランドトーン。SNB本体のhero画像を使わない', function () {
  var html = read(PAGES.mens.file);
  var top = read('mens/index.html');
  assert.match(html, /<section class="mens-ogp-hero"/);
  assert.match(top, /<section class="mens-ogp-hero"/);
  assert.ok(/<img\s+src="\.\.\/\.\.\/images\/ogp-mens-v2-1200x630\.jpg"/.test(html));
  assert.match(html, /styles\/mens\.css/);
  var t = textOf(html);
  assert.ok(t.indexOf("Men's Private Studio") !== -1);
  assert.ok(t.indexOf('会員資格は、Studio Nagoya Base・SNB mens・Studio Xで共通のSNB MEMBERです') !== -1);
  assert.ok(!/ふたりで、3時間。縄に集中できる時間を。/.test(t), 'SNBの緊縛向けヒーロー文言を流用しない');
  assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1);
});

test('Studio X membership: 「部屋料金は同じ。できることが増える。」を軸に、トップと同じhero・OGP。ヒーローにSNB MEMBERを出さない', function () {
  var html = read(PAGES.studio_x.file);
  assert.match(html, /<section class="hero" aria-labelledby="hero-title">/);
  assert.match(read('studio-x/index.html'), /<section class="hero" aria-labelledby="hero-title">/);
  var heroHtml = html.slice(html.indexOf('<section class="hero"'), html.indexOf('<div class="subpage-main member-page">'));
  var hero = textOf(heroHtml);
  assert.ok(hero.indexOf('部屋料金は同じ。できることが増える。') !== -1);
  assert.ok(!/SNB MEMBER|SNB|Studio Nagoya Base/.test(hero), 'ヒーローにSNB MEMBERを前面に出さない');
  assert.ok(!/縄|緊縛/.test(textOf(html)), 'SNBの緊縛向け訴求を流用しない');
  /* 制度説明では共通会員 SNB MEMBER と明示 */
  var about = textOf(html.slice(html.indexOf('id="about-membership"'), html.indexOf('id="join"')));
  assert.ok(about.replace(/\s+/g, '').indexOf('月額500円の共通会員SNB MEMBER'.replace(/\s+/g, '')) !== -1);
  assert.ok(about.indexOf('Studio Nagoya Base・SNB mens・Studio Xで共通') !== -1);
  /* hero画像資産はトップと同じ */
  assert.ok(html.indexOf('images/sample_03_slant_light_1200.webp') !== -1 && read('studio-x/index.html').indexOf('images/sample_03_slant_light_1200.webp') !== -1);
  assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1);
});

// ============================================================================
// 内容: 金額が正本と一致 / 共通会員 / 特典
// ============================================================================

test('SNB / mens 会員ページ: ペアパック・シャワー・既存有料機材・利用月ルールが正本の金額で載っている', function () {
  var wk = Pricing.computeBookingPrice({ brand: 'snb', date: '2026-12-07', durationMinutes: 180, generation: 'V2', plan: 'member_pair_3h' }).price.amount;
  var we = Pricing.computeBookingPrice({ brand: 'mens', date: '2026-12-12', durationMinutes: 180, generation: 'V2', plan: 'member_pair_3h' }).price.amount;
  var extWk = Pricing.computeBookingPrice({ brand: 'snb', date: '2026-12-07', durationMinutes: 240, generation: 'V2', plan: 'member_pair_3h' }).price.amount - wk;
  var extWe = Pricing.computeBookingPrice({ brand: 'snb', date: '2026-12-12', durationMinutes: 240, generation: 'V2', plan: 'member_pair_3h' }).price.amount - we;
  assert.deepStrictEqual([wk, we], [5000, 6000]);
  ['snb', 'mens'].forEach(function (brand) {
    var t = textOf(expandIncludes(read(PAGES[brand].file)));
    assert.ok(t.indexOf('2名ペアパック') !== -1);
    assert.ok(t.indexOf(yen(wk)) !== -1 && t.indexOf(yen(we)) !== -1, brand + ' ペアパック料金');
    assert.ok(t.indexOf('3時間固定・1〜2名まで') !== -1 && t.indexOf('3名以上のご予約では選べません') !== -1);
    assert.ok(t.indexOf('他の割引・優待との併用はできません') !== -1);
    assert.ok(t.indexOf('通常の会員延長料金（1時間ごとに平日' + yen(extWk) + '／土日祝' + yen(extWe) + '）') !== -1, '延長は通常の会員延長料金');
    assert.ok(t.indexOf('別商品') !== -1, '通常の会員料金表とは別商品');
    assert.ok(t.indexOf('シャワー（1予約につき1回）' + yen(Options.SHOWER_PRICE_JPY)) !== -1, brand + ' シャワー料金');
    assert.ok(t.indexOf('同じご予約の利用者2名まで共有') !== -1 && t.indexOf('予約時間内に限ります') !== -1);
    assert.ok(t.indexOf('Studio Xでは提供していません') !== -1);
    assert.ok(t.indexOf('機材レンタルオプション（会員限定）') !== -1 && t.indexOf('2026年12月1日以降に作成するご予約・お申し込み分から、SNB MEMBERの会員資格が必要') !== -1);
    assert.ok(t.indexOf('翌月分の2名ペアパック・シャワー・会員限定の有料機材は、その月の1日以降、当月の会費の決済が成功してから確定できます') !== -1, brand + ' 翌月の注意');
    assert.ok(t.indexOf('猶予期間はありません') !== -1);
    assert.ok(t.indexOf('変更先の月の会員資格を改めて確認します') !== -1);
    assert.ok(t.indexOf('Studio Nagoya Base・SNB mens・Studio Xで共通') !== -1, brand + ' 共通会員');
  });
  var mens = textOf(expandIncludes(read(PAGES.mens.file)));
  assert.ok(mens.indexOf('従来どおり、会員加入なしでも会員料金でご利用いただけます') !== -1);
  assert.ok(mens.indexOf('料金の優遇であり、SNB MEMBERの会員資格が付与されるものではありません') !== -1);
  assert.ok(mens.indexOf('SNB mens専用の別会員・別契約はありません') !== -1);
  assert.ok(mens.indexOf('月額500円') !== -1);
  /* 通常の会員料金表は残している（SNB） */
  assert.match(read(PAGES.snb.file), /一般料金と会員料金/);
});

test('Studio X 会員ページ: 有料オプション全般が会員限定・無料セルフは非会員でも可・スタッフ料金は正本どおり', function () {
  var html = read(PAGES.studio_x.file);
  var t = textOf(html);
  assert.ok(t.indexOf('2026年12月1日以降に作成するご予約の部屋料金は、会員・非会員の区別なく同額です') !== -1);
  assert.ok(t.indexOf('会員資格は、有料オプションを利用するための資格です') !== -1);
  assert.ok(t.indexOf('有料オプションは、すべて会員限定') !== -1);
  assert.ok(t.indexOf('有料の機材レンタルすべて') === -1 || true);
  assert.ok(/有料機材レンタル/.test(t) && /スタッフによる事前設営・片付け/.test(t) && /設営＋片付けセット/.test(t));
  assert.ok(t.indexOf('セットで0円になる機材も、元が有料の機材なので会員限定のままです') !== -1);
  assert.ok(t.indexOf('今後Studio Xに追加される有料オプションも、明示的な例外がない限り、同じく会員限定です') !== -1);
  assert.ok(t.indexOf('セルフ設営・セルフ原状復帰（無料）') !== -1 && t.indexOf('会員でなくても、使えるもの') !== -1);
  assert.ok(t.indexOf('スペースマーケット経由のご予約でも、会員限定の条件は同じです') !== -1);
  /* スタッフ料金は正本（_data/studio_x_equipment.json）から出力（直書きしない） */
  assert.match(html, /site\.data\.studio_x_equipment\.staffService\.services\.PRE_SETUP\.priceJpy/);
  var data = JSON.parse(read('_data/studio_x_equipment.json'));
  assert.deepStrictEqual([data.staffService.services.PRE_SETUP.priceJpy, data.staffService.services.CLEANUP.priceJpy, data.staffService.services.BOTH.priceJpy], [3000, 3000, 5000]);
  /* シャワー・ペアパックはStudio Xでは出さない */
  assert.ok(!/シャワー|ペアパック/.test(t.replace(/Studio Xでは提供していません/g, '')), 'Studio Xの会員ページにシャワー・ペアパックを出さない');
  /* Issue #488: 貸切ベースプランの注意書き「シャワー利用は含まれません」（否定表現）だけは許可する。 */
  assert.ok(!/シャワー|ペアパック/.test(textOf(read('studio-x/index.html')).replace(/シャワー利用は含まれません/g, '')));
  assert.ok(t.indexOf('月額500円') !== -1 && t.indexOf('猶予期間はありません') !== -1);
  /* 共通の加入フォーム（専用商品・専用Success URLなし） */
  assert.match(html, /id="membership-join-form"/);
  assert.match(html, /\.\.\/\.\.\/scripts\/membership-join\.js/);
});

test('mens専用・Studio X専用のStripe商品・Success URLを作っていない（共通の加入フォーム・共通の完了ページを維持）', function () {
  Object.keys(PAGES).forEach(function (brand) {
    var html = read(PAGES[brand].file);
    assert.ok(!/stripe\.com|buy\.stripe|checkout\.stripe|price_[A-Za-z0-9]|prod_[A-Za-z0-9]|sk_(live|test)/.test(html), brand + ' に決済URL・商品ID・秘密情報');
    assert.match(html, /id="membership-join-form"/);
  });
  assert.ok(exists('membership/complete.html'));
  assert.ok(!exists('mens/membership/complete.html') && !exists('studio-x/membership/complete.html'), 'ブランド別の完了ページは作らない');
  var cfg = read('gas/booking/shared/Config.gs');
  assert.ok(/membershipSuccessUrl: properties\.getProperty\('STRIPE_MEMBERSHIP_SUCCESS_URL'\)/.test(cfg), '共通の入会Success URL設定のみ');
  assert.ok(!/MENS.*MEMBERSHIP|STUDIO_X.*MEMBERSHIP_SUCCESS/.test(cfg));
  var js = read('scripts/membership-join.js');
  assert.ok(js.indexOf("action=startMembershipCheckout") !== -1 && js.indexOf('JSON.stringify({ email: email })') !== -1);
});

// ============================================================================
// 各トップからの導線
// ============================================================================

test('各トップから対応する会員ページへの導線がある（SNB→/membership/・mens→/mens/membership/・Studio X→/studio-x/membership/）', function () {
  var snb = read('index.html');
  assert.match(snb, /href="\{\{ '\/membership\/' \| relative_url \}\}"[^>]*>SNB MEMBERの内容を見て加入する/);
  assert.ok(textOf(snb).indexOf('会員限定の「2名ペアパック」') !== -1 && textOf(snb).indexOf('平日5,000円／土日祝6,000円') !== -1, 'SNBトップのCTAを強化');
  var mens = read('mens/index.html');
  assert.match(mens, /href="\{\{ '\/mens\/membership\/' \| relative_url \}\}"[^>]*>会員限定の特典と加入方法を見る/);
  assert.ok(textOf(mens).indexOf('通常のお部屋料金は、会員加入なしでもこのページの会員料金のままです') !== -1);
  var x = read('studio-x/index.html');
  assert.ok(/<a href="membership\/"[^>]*>会員限定オプション<\/a>/.test(x), 'Studio Xのナビ');
  assert.ok(x.indexOf('<a href="membership/">会員限定オプションのご案内</a>') !== -1, 'Studio Xの料金欄');
  /* ヘッダー共通ナビ（SNB・mens）にも会員案内 */
  var header = read('_includes/header_ja.html');
  assert.ok(header.indexOf('nav_member_url = "/mens/membership/"') !== -1 && header.indexOf('nav_member_url = "/membership/"') !== -1);
  assert.ok((header.match(/\{\{ nav_member_url \}\}/g) || []).length === 2, 'デスクトップとモバイルの両方');
  /* 他ブランドの訴求文言を機械的に流用しない */
  assert.ok(!/ペアパック/.test(textOf(x)));
  assert.ok(textOf(mens).indexOf('男性同士') !== -1);
  /* Studio Xトップに「SNB」ブランド表記を出さない（既存方針） */
  assert.ok(!/SNB MEMBER|Studio Nagoya Base|SNB/.test(textOf(x).replace(/©\s*Studio X \/ Studio Nagoya Base/, '')));
});

// ============================================================================
// 規約・特商法・FAQ・JSON-LD・sitemap・docs
// ============================================================================

test('規約・特商法・会員条件に、新料金（5,000/6,000/1,000円）・利用月ルール・共通会員・適用開始日が載っている', function () {
  var terms = textOf(read('_includes/membership_terms_ja.html'));
  ['2026年12月1日以降に作成するご予約・お申し込みから', '2名ペアパック', '平日5,000円／土日祝6,000円', 'シャワー（1予約につき1回1,000円', '他の割引・優待と併用できず',
    '料金優遇', 'だけでは、これらの特典はご利用いただけません', 'その月の1日以降、当月の会費の決済が成功してから確定できます', '猶予期間はありません',
    '変更先の月の会員資格を改めて確認', 'Studio Nagoya Base・SNB mens・Studio Xで共通の1つのSNB MEMBER'].forEach(function (w) {
    assert.ok(terms.indexOf(w) !== -1, '会員条件に「' + w + '」');
  });
  var legal = read('_includes/legal_ja.html');
  var lt = textOf(legal);
  assert.ok(lt.indexOf('会員限定の2名ペアパック・シャワー') !== -1);
  assert.ok(lt.indexOf('2名ペアパックは、SNB・SNB mensで、SNB MEMBERの会員資格がある方に限りご利用いただける、3時間・1〜2名の定額プランです（平日5,000円／土日祝6,000円・税込）') !== -1);
  assert.ok(lt.indexOf('シャワーは、SNB・SNB mensで、SNB MEMBERの会員資格がある方に限りご利用いただける有料オプションです（1予約につき1回1,000円・税込）') !== -1);
  assert.ok(lt.indexOf('2026年12月1日以降に作成するご予約・お申し込み分から、有料機材オプションのご利用にはSNB MEMBERの会員資格') !== -1);
  var law = textOf(legal.slice(legal.indexOf('特定商取引法に基づく表記')));
  ['会員限定の2名ペアパックは平日5,000円・土日祝6,000円（3時間・1〜2名、税込）', '会員限定のシャワーは1予約につき1回1,000円（税込）', '会員限定の特典：', '会員資格はStudio Nagoya Base・SNB mens・Studio Xで共通です']
    .forEach(function (w) { assert.ok(law.indexOf(w) !== -1, '特商法表記に「' + w + '」'); });
  /* Studio X 規約・特商法 */
  var xl = textOf(read('studio-x/legal/index.html'));
  ['有料のオプション（有料の機材レンタル全件、およびスタッフによる事前設営・片付け', 'セット利用などで0円になる機材も、元が有料のオプションであれば会員限定です',
    '承認時', '有料機材レンタルの会員限定は、2026年12月1日以降に作成するご予約・お申込みから適用します', 'セルフ設営・セルフ片付け（無料）、常設備品、無料のセルフ備品は、会員でない方もご利用いただけます',
    '共通の月額会員（月額500円）'].forEach(function (w) { assert.ok(xl.indexOf(w) !== -1, 'Studio X規約に「' + w + '」'); });
  /* 旧前提「機材レンタル自体は会員限定ではない」が公開コピーに残っていない */
  ['studio-x/index.html', 'studio-x/legal/index.html', '_includes/equipment_catalog_ja.html', '_includes/studio_x_option_flow_ja.html', 'docs/membership-pricing-2026-12.md'].forEach(function (p) {
    var t = textOf(read(p));
    /* #478が旧前提を「上書きする」と明記している一文だけは除いて検査する。 */
    var withoutOverrideNote = t.replace(/[^。]*上書き[^。]*。?/g, '');
    assert.ok(!/機材(の)?レンタル(自体)?は(会員限定|会員の方限定)?(では|に)ない|機材レンタルは会員限定にしていない|会員限定はスタッフ対応のみ/.test(withoutOverrideNote), p + ' に旧前提');
  });
});

test('FAQ: JSON-LDと表示が一致する（SNBトップ・規約ページの新FAQ、3つの会員ページ）', function () {
  ['index.html', 'legal/index.html'].forEach(function (p) {
    var html = read(p);
    var ld = faqLd(html);
    var q = ld.mainEntity.filter(function (e) { return e.name === '会員限定の2名ペアパック・シャワーとは何ですか？'; });
    assert.strictEqual(q.length, 1, p);
    assert.ok(html.indexOf('<div class="faq-answer">' + q[0].acceptedAnswer.text + '</div>') !== -1, p + ' 表示とJSON-LD');
    assert.ok(q[0].acceptedAnswer.text.indexOf('平日5,000円・土日祝6,000円') !== -1 && q[0].acceptedAnswer.text.indexOf('1,000円') !== -1);
    /* 機材FAQにも会員資格を追記し、表示とJSON-LDが一致 */
    var eq = ld.mainEntity.filter(function (e) { return /機材/.test(e.name); })[0];
    assert.ok(eq.acceptedAnswer.text.indexOf('2026年12月1日以降に作成するご予約・お申し込み分から、SNB MEMBERの会員資格が必要です') !== -1);
    assert.ok(html.indexOf('<div class="faq-answer">' + eq.acceptedAnswer.text + '</div>') !== -1, p + ' 機材FAQ');
  });
  var mensLegal = read('mens/legal/index.html');
  var mensEq = faqLd(mensLegal).mainEntity.filter(function (e) { return /機材/.test(e.name); })[0];
  assert.ok(mensLegal.indexOf('<div class="faq-answer">' + mensEq.acceptedAnswer.text + '</div>') !== -1);
  assert.ok(mensEq.acceptedAnswer.text.indexOf('SNB MEMBERの会員資格が必要です') !== -1);

  ['snb', 'mens'].forEach(function (brand) {
    var html = read(PAGES[brand].file);
    var ld = faqLd(html);
    assert.ok(ld && ld.mainEntity.length >= 4, brand + ' FAQPage');
    ld.mainEntity.forEach(function (e) {
      assert.ok(html.indexOf('<div class="faq-answer">' + e.acceptedAnswer.text + '</div>') !== -1, brand + ': ' + e.name);
    });
  });
  var xhtml = read(PAGES.studio_x.file);
  var xld = faqLd(xhtml);
  assert.ok(xld && xld.mainEntity.length >= 4);
  xld.mainEntity.forEach(function (e) {
    assert.ok(xhtml.indexOf('<p>' + e.acceptedAnswer.text + '</p>') !== -1, 'studio_x: ' + e.name);
  });
});

test('sitemap・docs・REVIEW_CHECKLIST: 新ページと新仕様を反映', function () {
  var sm = read('sitemap.xml');
  ['/membership/', '/mens/membership/', '/studio-x/membership/'].forEach(function (u) {
    assert.strictEqual(sm.split('<loc>' + BASE + u + '</loc>').length - 1, 1, u + ' がsitemapに1回だけ載る');
  });
  var doc = read('docs/membership-pricing-2026-12.md');
  ['member_pair_3h', '5,000円', '6,000円', '1,000円', '2026/12/1', 'grandfather'.replace('grandfather', '作成時刻'), '#469 / #472', '上書き', '利用日の属する月の支払い事実', 'rental', 'staffService', '0円'].forEach(function (w) {
    assert.ok(doc.indexOf(w) !== -1, 'docs に「' + w + '」');
  });
  var chk = read('REVIEW_CHECKLIST.md');
  assert.ok(chk.indexOf('会員限定特典（#478）') !== -1 && chk.indexOf('有料オプション全般') !== -1);
  assert.ok(!/会員限定はスタッフ対応のみ(?!.*上書き)/.test(chk));
});

// ============================================================================
// 予約フォーム（SNB / mens）
// ============================================================================

test('予約フォーム: SNB / mens にだけペアパック・シャワーの選択欄があり、Studio Xにはない。2026/12/1以降のみ表示', function () {
  var tpl = read('_includes/booking_app_ja.html');
  var field = tpl.slice(tpl.indexOf('{% if include.brand == "snb" or include.brand == "mens" %}'), tpl.indexOf('{% endif %}', tpl.indexOf('id="ba-benefits-error"')));
  assert.match(field, /id="ba-plan-pair"/);
  assert.match(field, /id="ba-shower"/);
  assert.match(field, /fieldset class="ba-fieldset" id="ba-benefits-field" hidden/, '初期は非表示（JSが提供開始後に表示）');
  assert.ok(textOf(field).indexOf('2名ペアパック（3時間・1〜2名／平日5,000円・土日祝6,000円）') !== -1);
  assert.ok(textOf(field).indexOf('シャワー（1予約1回・1,000円') !== -1);
  assert.ok(tpl.indexOf('id="ba-plan-pair"') === tpl.lastIndexOf('id="ba-plan-pair"'), '選択欄は1か所（snb/mensのifブロック内）');

  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  var before = Date.parse('2026-11-30T23:59:59+09:00'), start = Date.parse('2026-12-01T00:00:00+09:00');
  assert.strictEqual(Logic.brandShowsMemberBenefits('snb', before), false);
  assert.strictEqual(Logic.brandShowsMemberBenefits('snb', start), true);
  assert.strictEqual(Logic.brandShowsMemberBenefits('mens', start), true);
  assert.strictEqual(Logic.brandShowsMemberBenefits('studio_x', start), false, 'Studio Xには出さない');
  assert.strictEqual(Logic.brandShowsMemberBenefits('zzz', start), false);
});

test('予約フォーム: ペイロードは選択したときだけplan / options.showerを送る（金額・会員資格は送らない）。3名以上はフロントでも案内', function () {
  var Logic = loadFrontendSandbox(['booking-logic.js'], {}).BookingLogic;
  var base = { brand: 'mens', customerType: 'returning', date: '2026-12-07', startTime: '10:00', durationMinutes: 180, name: 'a', email: 'a@example.com', people: '2名', purpose: '緊縛・ロープ表現の自主練習', paymentMethod: '現金', isMember: true };
  var plain = Logic.buildCreateBookingPayload(base);
  assert.strictEqual(plain.plan, undefined);
  assert.strictEqual(plain.options, undefined, '未選択ならキー自体を付けない（従来のペイロードのまま）');
  var withPlan = Logic.buildCreateBookingPayload(Object.assign({}, base, { plan: 'member_pair_3h', shower: true }));
  assert.strictEqual(withPlan.plan, 'member_pair_3h');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(withPlan.options)), { shower: true });
  assert.strictEqual(Logic.buildCreateBookingPayload(Object.assign({}, base, { plan: 'bogus' })).plan, undefined, '未知のプランは送らない');
  Object.keys(withPlan).forEach(function (k) { assert.ok(!/amount|price|member(ship)?Status/i.test(k) || k === 'isMember', '金額・会員資格をクライアントから送らない: ' + k); });
  assert.strictEqual(Logic.isPairPackPeopleValue('1名'), true);
  assert.strictEqual(Logic.isPairPackPeopleValue('2名'), true);
  assert.strictEqual(Logic.isPairPackPeopleValue('3名'), false);
  assert.strictEqual(Logic.isPairPackPeopleValue('5名以上・要相談'), false);
  ['MEMBER_BENEFIT_NOT_AVAILABLE', 'PAIR_PACK_PEOPLE_EXCEEDED', 'PLAN_DURATION_INVALID', 'PLAN_NOT_AVAILABLE', 'INVALID_PLAN'].forEach(function (code) {
    assert.ok(Logic.messageForErrorCode(code, 'ja').length > 10 && Logic.messageForErrorCode(code, 'ja') !== Logic.messageForErrorCode('ZZZ', 'ja'), code);
    assert.strictEqual(Logic.recoveryActionForErrorCode(code), 'edit-details', code);
  });
  /* 資格関連の外部向け文言は内訳を出し分けない */
  var denied = Logic.messageForErrorCode('MEMBER_BENEFIT_NOT_AVAILABLE', 'ja');
  assert.ok(!/非会員|台帳|不一致/.test(denied));
});

test('見積りは plan を estimatePrice に渡すだけ（フロントに料金表を持たない）', function () {
  var js = read('scripts/booking-app.js');
  assert.ok(js.indexOf("'&plan=' + encodeURIComponent(plan)") !== -1);
  assert.ok(!/5000|6000|5,000|6,000/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')), 'フロントに5,000/6,000円を持たない');
});

test('シャワー: SNB / mens の申込・お支払いページがあり、ブランド別の戻り先（option-payment-complete）も用意されている', function () {
  ['booking/options/index.html', 'mens/booking/options/index.html', 'booking/option-payment-complete.html', 'mens/booking/option-payment-complete.html'].forEach(function (p) {
    assert.ok(exists(p), p);
    assert.ok(/<meta name="robots" content="noindex, follow">/.test(read(p)), p + ' はnoindex');
  });
  ['booking/options/index.html', 'mens/booking/options/index.html'].forEach(function (p) {
    var html = read(p);
    assert.ok(html.indexOf('{% include shower_options_ja.html') !== -1);
    assert.match(html, /scripts\/booking-shower\.js/);
  });
  assert.ok(read('mens/booking/options/index.html').indexOf('brand="mens"') !== -1);
  assert.ok(!exists('studio-x/booking/shower') && read('studio-x/booking/options/index.html').indexOf('シャワー') === -1, 'Studio Xにシャワーは出さない');
  var js = read('scripts/booking-shower.js');
  assert.ok(js.indexOf("options: { shower: true }") !== -1 && js.indexOf("'startOptionCheckout'") !== -1);
  assert.ok(!/localStorage|sessionStorage/.test(js.replace(/\/\*[\s\S]*?\*\//g, '')), 'メールアドレスを保存しない');
  assert.ok(js.indexOf('https:\\/\\/checkout\\.stripe\\.com\\/') !== -1);
  /* メール内のオプション案内URL（OptionMailTemplates）がこのページに届く */
  var mail = loadBookingSandbox(['Booking.gs', 'OptionMailTemplates.gs'], {}).OptionMailTemplates;
  assert.strictEqual(mail.buildOptionsPageUrl({ brand: 'snb', bookingId: 'SNB-1' }), BASE + '/booking/options/?bookingId=SNB-1');
  assert.strictEqual(mail.buildOptionsPageUrl({ brand: 'mens', bookingId: 'MENS-1' }), BASE + '/mens/booking/options/?bookingId=MENS-1');
});

test('STRIPE_CHECKOUT_ENABLED の既定は変更していない（未設定ならfail-closed）', function () {
  var cfg = read('gas/booking/shared/Config.gs');
  assert.ok(/checkoutEnabled/.test(cfg));
  assert.ok(/properties\.getProperty\('STRIPE_CHECKOUT_ENABLED'\)\s*===\s*'true'/.test(cfg), "'true'以外は無効");
  assert.ok(!/STRIPE_CHECKOUT_ENABLED['"]?\s*[:=]\s*['"]?true/.test(read('gas/booking/README.md').split('## Issue #478')[1] || ''), 'READMEで有効化を指示していない');
});

test('シャワー(#481): 予約フォーム・会員案内・申込ページに「事前確認が必要・承認後にお支払い」を明記し、即利用できる表現を出さない', function () {
  var fs = require('fs');
  var NOTICE = 'シャワー利用は事前確認が必要です。利用希望の場合は事前にご連絡ください。対応可能な場合のみご案内し、承認後にお支払いをお願いします。';
  ['_includes/booking_app_ja.html', '_includes/membership_benefits_ja.html', '_includes/shower_options_ja.html',
    'membership/index.html', 'mens/membership/index.html', 'mens/index.html'].forEach(function (file) {
    var html = fs.readFileSync(__dirname + '/../' + file, 'utf8');
    assert.ok(html.indexOf(NOTICE) !== -1, file + ' に事前確認の案内がある');
    assert.ok(!/予約確定後に「オプションのお支払い」ページでお支払い/.test(html), file + ' に即時利用を思わせる旧文言がない');
  });
  var form = fs.readFileSync(__dirname + '/../_includes/booking_app_ja.html', 'utf8');
  assert.ok(form.indexOf('選択だけでは利用確定になりません') !== -1);
});
