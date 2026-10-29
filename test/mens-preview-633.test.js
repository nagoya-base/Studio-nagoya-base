'use strict';
/*
 * Issue #633: mens/preview-633.html（/mens/ 再構成案の比較用試作）の検証。
 * 現行 mens/index.html と試作をローカルJekyllビルドし、表示テキスト・リンク・計測属性・画像・メタ情報・
 * 構造化データを機械的に照合する。試作固有の例外は ALLOWED_PREVIEW_ONLY_TEXT だけに明示する。
 * Jekyll が使えない環境では照合系テストをスキップする（静的な検査は常に実行）。
 */
var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/* 試作固有の例外（フォーム付近の検証用注記）のみ許容する */
var ALLOWED_PREVIEW_ONLY_TEXT = [
  '【試作ページ】検証用のため、このフォームからは送信できません。',
  /* Issue #639: HEROの主役コピー・PRIVATE・ROPE/WOODスクロール演出で追加した文言（現行からの削除は無し） */
  '用途によって、空気が変わる。',
  '一つの部屋から、いくつもの表現へ。',
  '男性同士の緊縛・ユニフォーム・ポートレートに使える、名古屋・上前津の完全個室スタジオ。',
  '安心できる、大人の秘密基地。',
  'Private',
  '完全貸切。無人入室。',
  '誰にも気兼ねせず、自分たちのペースで。',
  '完全貸切', /* 現行にもHEROバッジとして存在するため、PRIVATE側の増分として許容 */
  '無人入室',
  '他の利用者と同席しない',
  '料金が事前に分かる',
  '利用方法・設備・ルールがWebで確認できる',
  '問い合わせ窓口がある',
  'WOOD FRAME', '木組みの吊り床', '高さ 2350mm／間口 2450mm／奥行 2000mm。部屋の骨格になる、木の枠組みです。',
  'BAMBOO', '竹吊り', '天井に渡した竹と木組みで、吊りの構成を組み立てられます。',
  'ROPE POINT', '麻縄・スリング・カラビナ', 'リギングプレートまで常設。床縄から空中緊縛まで対応します（空中緊縛は経験者のみ、縛り手・受け手を含む3名以上）。',
  'SPACE', '誰にも会わない、一室', '完全個室・無人入室。大型ミラー（1460mm × 800mm）と置き畳で、練習も撮影も自分たちのペースで。'
];
/* Issue #639: HEROから外した当日予約の説明は、予約セクションの既存 calendar-note と重複するため試作では削除する */
var ALLOWED_CURRENT_ONLY_TEXT = ['予約ページで日時を選び、そのまま仮予約を送信できます。空きがあれば当日のご予約も可能です（はじめての方はオンラインクレジットカード決済のみ）。'];

var built = null;
function tryBuild() {
  var dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snb-633-'));
  var attempts = [['bundle', ['exec', 'jekyll', 'build', '--destination', dest]]];
  try {
    var p = cp.execFileSync('bundle', ['info', 'jekyll', '--path'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    attempts.push(['bundle', ['exec', 'ruby', path.join(p, 'exe', 'jekyll'), 'build', '--destination', dest]]);
  } catch (e) { /* bundle なし */ }
  for (var i = 0; i < attempts.length; i++) {
    try {
      cp.execFileSync(attempts[i][0], attempts[i][1], { cwd: ROOT, stdio: 'ignore' });
      return { current: fs.readFileSync(path.join(dest, 'mens', 'index.html'), 'utf8'), preview: fs.readFileSync(path.join(dest, 'mens', 'preview-633.html'), 'utf8'), dest: dest };
    } catch (e) { /* 次へ */ }
  }
  return null;
}
built = tryBuild();
var skipBuilt = built ? false : 'Jekyll が利用できないためスキップ';

/* ---- ヘルパー ---- */
function norm(s) { return s.replace(/\s+/g, ' ').trim(); }
function bodyOf(html) {
  var m = html.match(/<body[\s\S]*<\/body>/);
  return m ? m[0] : html;
}
function visibleLeaves(html) {
  var s = bodyOf(html).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  return s.replace(/<[^>]+>/g, '\n').split('\n').map(norm).filter(Boolean);
}
function multiset(arr) {
  var m = {};
  arr.forEach(function (x) { m[x] = (m[x] || 0) + 1; });
  return m;
}
function diff(a, b) { /* a にあって b に足りない要素 */
  var ma = multiset(a), mb = multiset(b), out = [];
  Object.keys(ma).forEach(function (k) { if ((mb[k] || 0) < ma[k]) out.push(k); });
  return out;
}
function anchors(html) {
  var out = [];
  var re = /<a\b([^>]*)>([\s\S]*?)<\/a>/g, m;
  var body = bodyOf(html).replace(/<!--[\s\S]*?-->/g, '');
  while ((m = re.exec(body))) {
    var attrs = {};
    (m[1].match(/[\w:-]+="[^"]*"/g) || []).forEach(function (a) {
      var k = a.slice(0, a.indexOf('=')); attrs[k] = a.slice(a.indexOf('=') + 2, -1);
    });
    var keep = Object.keys(attrs).filter(function (k) { return k === 'href' || k === 'target' || k === 'rel' || k.indexOf('data-analytics-') === 0; }).sort();
    out.push(norm(m[2].replace(/<[^>]+>/g, ' ')) + ' | ' + keep.map(function (k) { return k + '=' + attrs[k]; }).join(' '));
  }
  return out;
}
function images(html) {
  var body = bodyOf(html).replace(/<!--[\s\S]*?-->/g, '');
  return (body.match(/<img\b[^>]*>/g) || []).map(function (t) {
    var g = function (k) { var r = t.match(new RegExp('\\b' + k + '="([^"]*)"')); return r ? r[1] : ''; };
    return g('src') + ' | ' + g('alt') + ' | ' + g('width') + 'x' + g('height');
  }).filter(function (x) { return x.indexOf('拡大画像') === -1; });
}
function metaContent(html, attr, key) {
  var r = html.match(new RegExp('<meta[^>]*' + attr + '="' + key + '"[^>]*content="([^"]*)"'));
  return r ? r[1] : null;
}
function jsonld(html) {
  return (html.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || []);
}

/* ---- 静的検査（Jekyll不要） ---- */
test('#633: 試作の source は noindex・canonical は現行 /mens/・GA4/計測JS/送信JS を読み込まない', function () {
  var src = read('mens/preview-633.html');
  assert.match(src, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(src, /<link rel="canonical" href="https:\/\/nagoya-base\.github\.io\/Studio-nagoya-base\/mens\/">/);
  assert.doesNotMatch(src, /googletagmanager|gtag\(|analytics\.js|reservation-form\.js/);
  assert.doesNotMatch(src, /booking_app_/ , '試作に booking_app_* の include を追加しない');
  assert.match(src, /<script src="\.\.\/scripts\/main\.js"><\/script>/);
  ['imageModal', 'modalImage', 'floatingBookingBtn'].forEach(function (id) {
    assert.ok(src.indexOf('id="' + id + '"') !== -1, id + ' を維持する');
  });
});

test('#633: 相談フォームは試作側の <fieldset disabled> で include 全体を囲む（先頭legend内に操作要素なし）', function () {
  var src = read('mens/preview-633.html');
  var m = src.match(/<fieldset class="pv-form-lock" disabled>([\s\S]*?)<\/fieldset>\s*<\/div>/);
  assert.ok(m, 'disabled fieldset が見つからない');
  assert.match(m[1], /\{% include reservation_form_ja\.html %\}/);
  assert.doesNotMatch(m[1].split('{% include')[0], /<legend/, 'include 前に legend を置かない');
  assert.ok(src.indexOf('【試作ページ】検証用のため、このフォームからは送信できません。') !== -1);
});

test('#633: 初期化の途中で例外が起きても reveal-ready を外し、成功フラグを立てない（全情報が表示される）', function () {
  var vm = require('vm');
  function run(ioImpl) {
    var classes = { 'reveal-ready': true };
    var sandbox = {
      document: {
        documentElement: { classList: { contains: function (c) { return !!classes[c]; }, remove: function (c) { delete classes[c]; } } },
        querySelectorAll: function () { return [{}, {}]; }
      },
      IntersectionObserver: ioImpl
    };
    sandbox.window = sandbox;
    vm.runInNewContext(read('scripts/mens-preview-633.js'), sandbox);
    return { classes: classes, ready: sandbox.__pv633Ready };
  }
  var ctorThrows = run(function () { throw new Error('boom'); });
  assert.strictEqual(ctorThrows.classes['reveal-ready'], undefined);
  assert.ok(!ctorThrows.ready);
  var observeThrows = run(function () { this.observe = function () { throw new Error('boom'); }; });
  assert.strictEqual(observeThrows.classes['reveal-ready'], undefined);
  assert.ok(!observeThrows.ready);
  var ok = run(function () { this.observe = function () {}; this.unobserve = function () {}; });
  assert.strictEqual(ok.classes['reveal-ready'], true);
  assert.strictEqual(ok.ready, true);
});

test('#633: sitemap.xml・他ページから試作への参照がない', function () {
  assert.ok(read('sitemap.xml').indexOf('preview-633') === -1);
  var hits = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '_site') return;
      var p = path.join(dir, e.name);
      if (e.isDirectory()) return walk(p);
      if (!/\.(html|xml|yml|json)$/.test(e.name)) return;
      if (p.endsWith(path.join('mens', 'preview-633.html'))) return;
      if (fs.readFileSync(p, 'utf8').indexOf('preview-633') !== -1) hits.push(path.relative(ROOT, p));
    });
  })(ROOT);
  assert.deepStrictEqual(hits, []);
});

/* Issue #641: 指定画像への差替えだけを正規化し、他の照合は維持する。 */
function normalizePreviewImages(html) {
  return html.replace(/mens-preview-ogp-1200x630\.jpg/g, 'ogp-mens-v2-1200x630.jpg');
}
test('#641: 指定ヒーロー・OGP画像が用途別に参照される', function () {
  var src = read('mens/preview-633.html');
  assert.match(src, /rel="preload" as="image" href="..\/images\/mens-preview-hero.webp"/);
  assert.match(src, /src="..\/images\/mens-preview-hero.webp"\s+width="1600"\s+height="841"/);
  assert.strictEqual((src.match(/https:\/\/nagoya-base\.github\.io\/Studio-nagoya-base\/images\/mens-preview-ogp-1200x630.jpg/g) || []).length, 3);
  ['images/mens-preview-hero.webp', 'images/mens-preview-ogp-1200x630.jpg'].forEach(function (p) { assert.ok(fs.statSync(path.join(ROOT, p)).size > 0); });
});

/* ---- ビルド後の照合 ---- */
test('#633: ビルド後の試作に googletagmanager / gtag( / analytics.js / reservation-form.js が含まれない', { skip: skipBuilt }, function () {
  assert.doesNotMatch(built.preview, /googletagmanager|gtag\(|analytics\.js|reservation-form\.js/);
  assert.match(built.preview, /<fieldset class="pv-form-lock" disabled>/);
  assert.match(built.preview, /<meta name="robots" content="noindex, nofollow">/);
});

test('#633: 表示テキスト（文／項目）が現行と一致する（順序・空白・装飾差は正規化、例外は注記のみ）', { skip: skipBuilt }, function () {
  var cur = visibleLeaves(built.current).filter(function (t) { return ALLOWED_CURRENT_ONLY_TEXT.indexOf(t) === -1; });
  var preAll = visibleLeaves(built.preview);
  var pre = preAll.filter(function (t) { return ALLOWED_PREVIEW_ONLY_TEXT.indexOf(t) === -1; });
  /* 許容リストに無い文言が試作で増えていないこと（許容語は現行側に同名があっても現行の出現数までは数える） */
  assert.deepStrictEqual(diff(cur, preAll), [], '試作で欠落・変更された現行テキスト');
  assert.deepStrictEqual(diff(pre, cur).filter(function (t) { return multiset(preAll)[t] > multiset(cur)[t]; }), [], '試作で追加・変更されたテキスト');
  assert.ok(cur.length > 200, '照合対象が空洞化していないこと');
});

test('#633: リンク先・CTA文言・data-analytics-* の対応が現行と一致する', { skip: skipBuilt }, function () {
  var cur = anchors(built.current), pre = anchors(built.preview);
  assert.deepStrictEqual(diff(cur, pre), []);
  assert.deepStrictEqual(diff(pre, cur), []);
  assert.ok(cur.length > 40);
});

test('#633: 現行トップの写真（src/alt/寸法）をすべて維持している', { skip: skipBuilt }, function () {
  var cur = images(built.current), pre = images(built.preview).map(function (img) {
    var replacement = '../images/mens-preview-hero.webp | 青と暖色の照明に包まれた畳のスタジオに座る男性。用途によって、空気が変わる。安心できる、大人の秘密基地。 | 1600x841';
    return img === replacement ? '../images/ogp-mens-v2-1200x630.jpg | 男性同士のフェティッシュ撮影に対応するStudio Nagoya Baseの男性向け案内 | 1200x630' : img;
  });
  assert.deepStrictEqual(diff(cur, pre), []);
  assert.deepStrictEqual(diff(pre, cur), []);
});

test('#633: title・description・OGP・Twitter・canonical・JSON-LD を維持している', { skip: skipBuilt }, function () {
  var t = function (h) { return (h.match(/<title>([\s\S]*?)<\/title>/) || [])[1]; };
  assert.strictEqual(t(built.preview), t(built.current));
  ['description'].forEach(function (k) { assert.strictEqual(metaContent(normalizePreviewImages(built.preview), 'name', k), metaContent(built.current, 'name', k)); });
  ['og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'og:locale', 'og:site_name'].forEach(function (k) {
    assert.strictEqual(metaContent(normalizePreviewImages(built.preview), 'property', k), metaContent(built.current, 'property', k), k);
  });
  ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].forEach(function (k) {
    assert.strictEqual(metaContent(normalizePreviewImages(built.preview), 'name', k), metaContent(built.current, 'name', k), k);
  });
  var canon = function (h) { return (h.match(/<link rel="canonical" href="([^"]*)"/) || [])[1]; };
  assert.strictEqual(canon(built.preview), canon(built.current));
  assert.deepStrictEqual(jsonld(normalizePreviewImages(built.preview)), jsonld(built.current));
});

test('#633: 現行トップにあるIDは試作にも存在し、試作内でIDが重複しない', { skip: skipBuilt }, function () {
  var ids = function (h) { return (bodyOf(h).match(/\bid="([^"]+)"/g) || []).map(function (x) { return x.slice(4, -1); }); };
  var cur = ids(built.current), pre = ids(built.preview);
  assert.deepStrictEqual(diff(cur, pre), [], '試作で消えたID（アンカー・参照元の退行）');
  assert.strictEqual(new Set(pre).size, pre.length, 'IDが重複している');
});

/* Issue #635: 相談窓口の名称は「相談フォーム」。日時選択・直接予約は「予約ページ」のまま */
['mens/index.html', 'mens/preview-633.html'].forEach(function (rel) {
  test('#635: ' + rel + ' は相談窓口を「予約フォーム」と呼ばず「相談フォーム」で統一している', function () {
    var html = read(rel);
    assert.strictEqual(html.indexOf('予約フォーム'), -1);
    assert.ok(html.indexOf('相談フォームで問い合わせる →') !== -1, 'CTA');
    assert.ok(html.indexOf('ご相談・お問い合わせは<a href="#reservation-form">相談フォーム</a>をご利用ください') !== -1, '補足');
    assert.ok(html.indexOf('お早めに<a href="#reservation-form">相談フォーム</a>にてご連絡ください') !== -1, 'FAQ本文');
    assert.ok(html.indexOf('お早めに相談フォームにてご連絡ください') !== -1, 'FAQPage JSON-LD');
    assert.ok(html.indexOf('>予約ページ</a>から行えます') !== -1, '予約ページの名称は維持');
  });
});

/* Issue #637: 試作ギャラリーは横長同士・縦長同士で固定2列に整理し、混在や3列＋1枚を避ける */
test('#637: 試作ギャラリーは横長グループ→縦長グループに分かれ、混在しない', function () {
  var html = read('mens/preview-633.html');
  var groups = html.match(/<div class="pv-masonry pv-masonry--(landscape|portrait)">[\s\S]*?<\/div>/g) || [];
  assert.strictEqual(groups.length, 4, 'landscape/portrait グループ数');
  groups.forEach(function (g) {
    var isLandscape = g.indexOf('pv-masonry--landscape') !== -1;
    var dims = g.match(/width="(\d+)" height="(\d+)"/g).map(function (d) { var m = d.match(/(\d+)" height="(\d+)/); return +m[1] > +m[2]; });
    assert.ok(dims.length === 2, '各グループは2枚');
    dims.forEach(function (wide) { assert.strictEqual(wide, isLandscape, '縦横がグループと一致する'); });
  });
  assert.ok(html.indexOf('<div class="pv-masonry">') === -1, 'auto-fit の汎用グリッドを残さない');
  assert.ok(html.indexOf('gallery_lighting02_1200') < html.indexOf('gallery_lighting05_1200') &&
    html.indexOf('gallery_lighting05_1200') < html.indexOf('gallery_white06_1200') &&
    html.indexOf('gallery_white06_1200') < html.indexOf('gallery_white01_1200'), '横長2枚→縦長2枚の順');
});

test('#637: CSSは横長・縦長グループを固定2列・上端揃えにし、狭幅では1列へ切り替える', function () {
  var css = read('styles/mens-preview-633.css');
  assert.match(css, /\.pv-masonry--landscape, \.pv-masonry--portrait \{[^}]*repeat\(2, minmax\(0, 1fr\)\)[^}]*align-items: start/);
  assert.match(css, /max-width: 520px\) \{[\s\S]*\.pv-masonry--landscape \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /max-width: 359px\) \{\s*\.pv-masonry--portrait \{ grid-template-columns: minmax\(0, 1fr\)/);
  assert.strictEqual(css.indexOf('.pv-masonry .pv-photo img { height: auto; }') === -1, false, '写真は自然な縦横比（height:auto）を維持');
});

/* Issue #639: HERO主役コピー／PRIVATE見出し／ROPE・WOODのスクロール連動 */
test('#639: HEROのH1は「用途によって、空気が変わる。」で、SEO文言と予約CTAを保持し、料金・当日予約説明はHEROに置かない', function () {
  var html = read('mens/preview-633.html');
  var hero = html.match(/<section class="pv-hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<h1 id="mens-hero-title" class="pv-hero-title">用途によって、空気が変わる。<\/h1>/);
  assert.ok(hero.indexOf('一つの部屋から、いくつもの表現へ。') > hero.indexOf('</h1>'));
  assert.ok(hero.indexOf('男性同士の緊縛・フェティッシュ撮影向けレンタルスペース') !== -1, 'SEO補助コピー');
  assert.ok(hero.indexOf('data-analytics-location="mens_hero" data-analytics-type="booking_app"') !== -1, '予約CTA');
  assert.ok(hero.indexOf('pv-hero-price') === -1 && hero.indexOf('hero-note') === -1 && hero.indexOf('当日') === -1);
  assert.strictEqual(html.split('当日のご予約も可能です').length - 1, 0, '当日予約の説明は既存の calendar-note に一本化（新規の重複文を置かない）');
  assert.ok(html.indexOf('<p class="pv-hero-price pv-price-lead">') !== -1, '料金は料金セクションへ移動');
});

test('#639: PRIVATEに「安心できる、大人の秘密基地。」と6つの安心材料がある', function () {
  var html = read('mens/preview-633.html');
  var sec = html.match(/<section id="about-page"[\s\S]*?<\/section>/)[0];
  assert.match(sec, /<h2 class="section-title pv-private-title">安心できる、大人の秘密基地。<\/h2>/);
  assert.strictEqual((sec.match(/<ul class="pv-assure"[\s\S]*?<\/ul>/)[0].match(/<li>/g) || []).length, 6);
  assert.ok(sec.indexOf('完全貸切。無人入室。') !== -1);
});

test('#639: ROPE/WOODは WOOD FRAME→BAMBOO→ROPE POINT→SPACE の順にスクロール連動し、JSなし・reduced motion時は通常表示', function () {
  var html = read('mens/preview-633.html');
  var order = ['WOOD FRAME', 'BAMBOO', 'ROPE POINT', 'SPACE'].map(function (k) { return html.indexOf('pv-step-label">' + k + '<'); });
  assert.ok(order.every(function (i) { return i > 0; }));
  assert.deepStrictEqual(order.slice().sort(function (a, b) { return a - b; }), order);
  var css = read('styles/mens-preview-633.css');
  assert.match(css, /\.pv-scroll\.is-active \.pv-scroll-stage \{[^}]*position: sticky/);
  assert.doesNotMatch(css, /^\.pv-scroll-stage \{[^}]*sticky/m, 'sticky は .is-active（JS成功時）限定');
  assert.match(css, /prefers-reduced-motion: reduce\) \{[\s\S]*\.pv-scroll \.pv-step \{ transition: none/);
  var js = read('scripts/mens-preview-639.js');
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /catch \(e\) \{\s*root\.classList\.remove\('is-active'\)/);
});

test('#639: スクロール演出JSは reduced motion と例外時に .is-active を付けない', function () {
  var vm = require('vm');
  function run(opts) {
    var added = [], style = {};
    var step = { classList: { add: function () {}, remove: function () {} }, getAttribute: function () { return '1'; } };
    var rootEl = {
      classList: { add: function (c) { added.push(c); }, remove: function (c) { added = added.filter(function (x) { return x !== c; }); } },
      setAttribute: function () {}, style: { setProperty: function (k, v) { style[k] = v; } },
      querySelectorAll: function () { return [step]; },
      querySelector: function () { return { getBoundingClientRect: function () { return { bottom: 0 }; } }; }
    };
    var sb = {
      document: { querySelector: function () { return rootEl; } },
      matchMedia: function (q) { return { matches: q.indexOf('reduce') !== -1 ? !!opts.reduced : false }; },
      addEventListener: function () {},
      requestAnimationFrame: function (f) { f(); },
      IntersectionObserver: opts.io
    };
    sb.window = sb;
    vm.runInNewContext(read('scripts/mens-preview-639.js'), sb);
    return added;
  }
  var okIo = function () { this.observe = function () {}; };
  assert.deepStrictEqual(run({ io: okIo }), ['is-active']);
  assert.deepStrictEqual(run({ io: okIo, reduced: true }), []);
  assert.deepStrictEqual(run({ io: function () { throw new Error('boom'); } }), []);
});

test('#639: スマホでは固定写真の下端より下にある最上段の説明を表示中にし、写真クリックは表示中の写真だけが受ける', function () {
  var js = read('scripts/mens-preview-639.js');
  assert.match(js, /max-width: 800px/);
  assert.match(js, /getBoundingClientRect\(\)\.top >= line/);
  var css = read('styles/mens-preview-633.css');
  assert.match(css, /\.pv-scroll\.is-active \.pv-stage-photo \{[^}]*visibility: hidden; pointer-events: none/);
  assert.match(css, /\.pv-stage-photo\[data-photo="rope"\] \{ opacity: 1; visibility: visible; pointer-events: auto/);
});
