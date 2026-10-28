/*
 * Issue #500: 6時間貸切ベースプランの特設ページ（/studio-x/base-plan/）と、
 * ?plan=osu_cosplay_base_6h によるプラン選択済み予約フォームへの直結。
 * ?plan= はUIの初期状態を作るヒントにすぎず、可否はサーバー側検証が正（booking-event-plan.test.js）。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var Logic = require('../scripts/booking-logic.js');

function read(rel) { return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8'); }
var PLAN = 'osu_cosplay_base_6h';

test('planFromSearch: studio_xの有効なplanだけを返し、なし・不正値・他ブランドは通常予約（空）', function () {
  assert.strictEqual(Logic.planFromSearch('?plan=' + PLAN, 'studio_x'), PLAN);
  assert.strictEqual(Logic.planFromSearch('?foo=1&plan=' + PLAN, 'studio_x'), PLAN);
  assert.strictEqual(Logic.planFromSearch('?plan=' + PLAN + '&foo=1', 'studio_x'), PLAN);
  assert.strictEqual(Logic.planFromSearch('', 'studio_x'), '');
  assert.strictEqual(Logic.planFromSearch(undefined, 'studio_x'), '');
  assert.strictEqual(Logic.planFromSearch('?plan=', 'studio_x'), '');
  ['unknown', 'member_pair_3h', PLAN + 'x', 'x' + PLAN, PLAN.toUpperCase(), '%E0%A4%A', '<script>', '../' + PLAN].forEach(function (v) {
    assert.strictEqual(Logic.planFromSearch('?plan=' + v, 'studio_x'), '', v);
  });
  /* SNB / SNB mens / ブランド不明には影響しない */
  ['snb', 'mens', '', undefined].forEach(function (b) {
    assert.strictEqual(Logic.planFromSearch('?plan=' + PLAN, b), '', String(b));
  });
  assert.strictEqual(Logic.planFromSearch('?xplan=' + PLAN, 'studio_x'), '');
  /* 複数指定は無効（どちらが有効か曖昧なため通常予約） */
  assert.strictEqual(Logic.planFromSearch('?plan=' + PLAN + '&plan=xxx', 'studio_x'), '');
  assert.strictEqual(Logic.planFromSearch('?plan=xxx&plan=' + PLAN, 'studio_x'), '');
  assert.strictEqual(Logic.planFromSearch('?plan=' + PLAN + '&plan=' + PLAN, 'studio_x'), '');
});

test('予約フォーム: URLの初期選択は初期化の最後に1回だけ。6時間固定・オプション畳み込みは既存の applyEventPlanState_ を通す', function () {
  var app = read('scripts/booking-app.js');
  var m = /if \(els\.planEvent && Logic\.planFromSearch\(window\.location && window\.location\.search, brand\) === Logic\.EVENT_BASE_PLAN_CODE\) \{\s*els\.planEvent\.checked = true;\s*applyEventPlanState_\(\);\s*\}\s*\}\)\(\);\s*$/.exec(app);
  assert.ok(m, '初期化の末尾で1回だけ適用する');
  assert.strictEqual(app.split('Logic.planFromSearch(').length - 1, 1, '他の箇所で再適用しない（解除後に勝手に再選択しない）');
  var fn = app.slice(app.indexOf('function applyEventPlanState_'), app.indexOf("if (els.planEvent) els.planEvent.addEventListener('change', applyEventPlanState_)"));
  assert.ok(fn.indexOf('els.duration.value = String(Logic.EVENT_BASE_PLAN_MIN_HOURS)') !== -1, '初期値は6時間（固定ではない）');
  assert.ok(fn.indexOf('optionsPanel.setSuspended(selected)') !== -1, 'オプション欄を畳む（#496）');
  assert.ok(fn.indexOf('els.planBanner.hidden = !selected') !== -1, 'プラン選択済みバナー');
  assert.ok(fn.indexOf('Logic.DEFAULT_DURATION_HOURS') !== -1, '解除時は3時間へ戻す（#494）');
});

test('プラン解除: バナーのボタンで通常予約へ戻り、URLのplanも外す', function () {
  var app = read('scripts/booking-app.js');
  assert.ok(/els\.planRelease\.addEventListener\('click'[\s\S]*?els\.planEvent\.checked = false;\s*applyEventPlanState_\(\);\s*clearPlanParam_\(\);/.test(app));
  assert.ok(app.indexOf('history.replaceState') !== -1);
  assert.ok(/els\.planEvent\.addEventListener\('change', function \(\) \{ if \(!els\.planEvent\.checked\) clearPlanParam_\(\); \}\)/.test(app), 'チェックボックスで解除してもURLから外す');
  var html = read('_includes/booking_app_ja.html');
  var block = /\{% if include\.brand == "studio_x" %\}[\s\S]*?\{% endif %\}/.exec(html.slice(html.indexOf('ba-plan-banner') - 400))[0];
  assert.ok(block.indexOf('id="ba-plan-banner"') !== -1 && block.indexOf('id="ba-plan-release"') !== -1, 'Studio X限定ブロック内');
  assert.ok(/id="ba-plan-banner"[^>]* hidden>/.test(html), '初期は非表示');
  assert.ok(read('mens/booking/index.html').indexOf('ba-plan-banner') === -1 && read('booking/index.html').indexOf('ba-plan-banner') === -1);
});

test('サーバー検証は維持: planはsubmit/見積りでチェックボックスの状態から作り、URLを直接payloadへ入れない', function () {
  var app = read('scripts/booking-app.js');
  assert.ok(/function selectedPlan_\(\) \{\s*if \(eventPlanSelected_\(\)\) return Logic\.EVENT_BASE_PLAN_CODE;/.test(app));
});

test('特設ページ(#507): X直リンク向けミニマム構成。ファーストビューの価格・人数・用途、誤認防止、オプション不可', function () {
  var html = read('studio-x/base-plan/index.html');
  var hero = html.slice(html.indexOf('<header class="subpage-hero'), html.indexOf('id="about"'));
  var heroText = hero.replace(/<[^>]+>/g, ' ');
  ['1時間', '1,000円', '最低6時間', '8:00〜21:00', '6時間 6,000円', '8時間 8,000円', '1室', '6名まで', '1人あたり1,000円相当', '着替え', '荷物置き', '休憩', '再入室', '上前津', '大須'].forEach(function (n) {
    assert.ok(heroText.indexOf(n) !== -1, 'ファーストビュー: ' + n);
  });
  assert.ok(hero.indexOf('このプランで予約する') !== -1, 'ファーストビューに予約CTA');
  /* ミニマム構成の対象は冒頭（POINT / NOTICE）。トップから移転した詳細（Issue #596）は #usecases 以降の「詳細・補足」ブロックに置く。 */
  assert.ok(html.indexOf('id="usecases"') > html.indexOf('id="excluded"'), '詳細・補足はミニマム部分の後ろ');
  var body = html.slice(html.indexOf('<main'), html.indexOf('id="usecases"'));
  var text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  ['これだけ知っておけばOK', '有人クロークではありません', '荷物・貴重品は室内で各自管理してください', 'スタッフ常駐なし', 'シャワーなし',
    '追加オプションは利用できません', '利用開始後の途中延長はできません', '常設', '外出・再入室OK', '簡易撮影', '通常のStudio X予約'].forEach(function (n) {
    assert.ok(text.indexOf(n) !== -1, n);
  });
  /* 長い比較表・FAQ・長文に依存しない */
  assert.ok(!/<table|<details|faq-list/.test(body), '比較表・FAQを置かない');
  assert.ok(text.length < 1100, '本文は短く保つ: ' + text.length);
  assert.ok(!/6時間固定|6,000円固定|固定6,000円|6時間\s*6,000円（1室）/.test(html), '固定額・固定時間と誤解させる表現を残さない');
  assert.ok(!/荷物を?お預かりします|預かりサービスです|クロークです|クロークをご利用/.test(text));
  assert.ok(text.replace(/有人クローク(ではありません|ではなく)/g, '').indexOf('クローク') === -1);
  assert.ok(!/20\d\d-\d\d-\d\d/.test(body), '日付をハードコードしない');
  /* 後からヒーロー画像を足せる構造 */
  assert.ok(html.indexOf('base-plan-hero-media') !== -1 && read('studio-x/pages.css').indexOf('.base-plan-hero-media') !== -1);
});

test('特設ページ: CTAは上部・下部ともプラン選択済み予約へ直結し、GA4は既存のcta_click規約を使う', function () {
  var html = read('studio-x/base-plan/index.html');
  /* /studio-x/base-plan/ から見て ../booking/（= /studio-x/booking/）へ解決されること。booking/ だけだと /studio-x/base-plan/booking/ になる。 */
  var ctas = html.match(/<a [^>]*href="\.\.\/booking\/\?plan=osu_cosplay_base_6h#booking-app-section"[^>]*>/g) || [];
  assert.strictEqual(ctas.length, 4, 'ヘッダー・モバイルメニュー・ファーストビュー・下部');
  var hrefs = html.match(/href="[^"]*booking\/[^"]*"/g) || [];
  hrefs.forEach(function (h) { assert.ok(h.indexOf('href="../booking/') === 0, '相対階層: ' + h); });
  assert.ok(html.indexOf('href="../booking/">通常のStudio X予約</a>') !== -1, '通常予約リンク');
  ctas.forEach(function (a) { assert.ok(/data-analytics-event="cta_click"/.test(a) && /data-analytics-location="[a-z_]+"/.test(a)); });
  assert.ok(html.indexOf('base_plan_hero') !== -1 && html.indexOf('base_plan_footer') !== -1);
  assert.ok(!/generate_lead|gtag\('event'/.test(html), '成果イベントを増やさない');
  var top = read('studio-x/index.html');
  assert.ok(top.indexOf('href="base-plan/"') !== -1 && top.indexOf('data-analytics-destination="base_plan_page"') !== -1, 'トップ→特設ページ');
  assert.ok(top.indexOf('href="booking/?plan=osu_cosplay_base_6h#booking-app-section"') !== -1, 'トップ→直結予約');
});

test('特設ページ: SEO / OGP / canonical / Offer構造化データ / sitemap', function () {
  var html = read('studio-x/base-plan/index.html');
  var URL = 'https://nagoya-base.github.io/Studio-nagoya-base/studio-x/base-plan/';
  assert.ok(html.indexOf('<title>Studio X｜6時間貸切ベースプラン') !== -1);
  assert.ok(/<meta name="description" content="[^"]*1時間1,000円[^"]*最低6時間[^"]*">/.test(html));
  assert.ok(html.indexOf('<link rel="canonical" href="' + URL + '">') !== -1);
  assert.ok(html.indexOf('<meta name="robots" content="index, follow">') !== -1);
  ['og:title', 'og:description', 'og:url', 'og:image'].forEach(function (p) { assert.ok(html.indexOf('property="' + p + '"') !== -1, p); });
  ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].forEach(function (p) { assert.ok(html.indexOf('name="' + p + '"') !== -1, p); });
  var data = JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.strictEqual(data['@type'], 'Offer');
  assert.strictEqual(data.price, '1000');
  assert.strictEqual(data.priceSpecification.unitCode, 'HUR');
  assert.strictEqual(data.priceSpecification.eligibleQuantity.minValue, 6);
  assert.strictEqual(data.url, URL);
  assert.ok(html.indexOf('FAQPage') === -1, 'FAQを削ったのでFAQPageも置かない');
  assert.ok(read('sitemap.xml').indexOf('<loc>' + URL + '</loc>') !== -1);
});

test('通常のStudio X予約URL・SNB・mensは従来どおり（planなしで自動選択しない）', function () {
  var booking = read('studio-x/booking/index.html');
  assert.ok(booking.indexOf('booking_app_ja.html') !== -1);
  assert.ok(/id="ba-plan-event" value="osu_cosplay_base_6h">/.test(read('_includes/booking_app_ja.html')), 'checkboxは未チェックが初期値');
  assert.ok(!/id="ba-plan-event"[^>]*checked/.test(read('_includes/booking_app_ja.html')));
});

test('ハンバーガーメニュー(#507): Studio X全ページのモバイルメニューに特設ページ導線があり、GA4は既存のcta_click規約', function () {
  var pages = { 'studio-x/index.html': '', 'studio-x/booking/index.html': '../', 'studio-x/equipment/index.html': '../', 'studio-x/how-to/index.html': '../',
    'studio-x/legal/index.html': '../', 'studio-x/membership/index.html': '../', 'studio-x/reservation/index.html': '../' };
  Object.keys(pages).forEach(function (f) {
    var html = read(f);
    var i = html.indexOf('id="mobile-menu"');
    var menu = html.slice(i, html.indexOf('</div>', i));
    var a = new RegExp('<a href="' + pages[f] + 'base-plan/"[^>]*>6時間貸切ベースプラン</a>').exec(menu);
    assert.ok(a, f);
    assert.ok(/data-analytics-event="cta_click"/.test(a[0]) && /data-analytics-location="header_mobile_menu"/.test(a[0]) && /data-analytics-destination="base_plan_page"/.test(a[0]), f);
  });
  assert.ok(/<a href="\.\/" aria-current="page">6時間貸切ベースプラン<\/a>/.test(read('studio-x/base-plan/index.html')), '特設ページ自身のメニューにも現在地として表示');
});

test('ハンバーガーメニュー(#510): 項目が多くても届くようスクロール可能で、特設ページ導線は長いメニューで上位に置く', function () {
  var css = read('studio-x/style.css');
  var rule = /\.mobile-menu \{[^}]*\}/.exec(css.slice(css.indexOf('@media (max-width: 1040px)') === -1 ? 0 : css.indexOf('@media (max-width: 1040px)')))[0];
  assert.ok(/overflow-y:\s*auto/.test(rule), 'メニューをスクロールできる');
  ['studio-x/index.html', 'studio-x/how-to/index.html', 'studio-x/membership/index.html'].forEach(function (f) {
    var html = read(f);
    var i = html.indexOf('id="mobile-menu"');
    var links = html.slice(i, html.indexOf('</div>', i)).match(/<a [^>]*>/g);
    var idx = links.findIndex(function (a) { return a.indexOf('base-plan/') !== -1; });
    assert.ok(idx !== -1 && idx <= 1, f + ': 先頭付近にある（' + idx + '）');
  });
});
