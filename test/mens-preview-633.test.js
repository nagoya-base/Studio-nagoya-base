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
  '一つの部屋から、いくつもの表現へ。',
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
  /* Issue #646: H1・HERO説明・撮影シーン・仲間との利用・ギャラリー見出し・会員説明の集約（現行からの変更は ALLOWED_CURRENT_ONLY_TEXT に対応） */
  '男性同士の緊縛・フェティッシュ撮影を、完全個室で。',
  'ユニフォーム撮影、男性ポートレート、緊縛まで。名古屋・上前津の完全個室スタジオです。緊縛をしない撮影にも利用できます。',
  '衣装と空間で、撮影シーンをつくる', 'Scenes',
  '好きな装いで、自分たちの一枚を。',
  'ユニフォームやコスチュームを持ち寄って、衣装と空間を活かした作品撮りに。畳や木組みの和室も背景にできます。',
  '作例に写る衣装・小道具は、当スタジオの貸出品ではありません。',
  'ユニフォームの床縄作品', 'ヒーロー衣装の作品撮り', 'ユニフォーム姿の2人によるシチュエーション作品',
  '学校机と黒板のある空間（人物なし）',
  '学校机と黒板で、撮影にひとつのシーンを。',
  '衣装やポーズを合わせて、自分たちの設定を楽しむ撮影にも。',
  '柄背景と竹の空間（人物なし）',
  '縛らない日も、自分たちらしく撮る。',
  '男性ポートレートや身体表現、セルフ撮影、ペアでの撮影にも。背景と照明を使って、撮りたい雰囲気をつくれます。',
  '好きが通じる仲間と、自分たちだけの時間を。',
  'ユニフォームを持ち寄って撮る。縄の練習をする。撮った写真を見ながら話す。',
  '同じ趣味の仲間と集まる、少人数のフェチ会・同好会にも。完全貸切・無人入室で、自分たちのペースで楽しめます。',
  '1〜4名。5名以上は事前にご相談ください（運営者の承認が必要です）。',
  '参加者募集を予定している会は、募集前にご相談ください。',
  '参加者全員が18歳以上であること（高校生は利用不可）を予約者が確認し、同伴者も含めて利用規約に従ってご利用ください。',
  '場所と設備の貸出です。会の主催や参加者・モデルの手配、指導は含まれません。宴会・飲み会目的ではご利用いただけません。',
  '吊りを伴う利用の条件は、', '安全ルール', 'と', '利用規約', 'をご確認ください。',
  '仲間との利用を相談する →',
  '撮影作例とスタジオの空間',
  '男性モデルの作例と、照明・背景・設備のサンプルをご覧いただけます。',
  '男性モデルの作例 / Model Sample',
  '同じ場所で、照明の色を変えると / Lighting Comparison',
  '同じ撮影場所で、照明の色を変えた5パターンです。構図が完全に一致する比較ではありません。',
  '通常色（白）の照明', '紫の照明', '赤の照明', '青の照明', '暖色の照明',
  '※ このページの予約ページからのご予約には会員料金が適用されます。適用条件と会員資格との違いは', '料金のご案内', 'をご確認ください。',
  'をご利用ください。このページの予約ページからのご予約には', 'が適用されます（例：平日 3時間 ¥5,500 / 4時間 ¥7,000）',
  'ユニフォーム・フェティッシュ衣装撮影は2時間から余裕を持ってご利用いただけます。緊縛・ロープ表現を含む撮影は3時間以上のご予約をおすすめします。会員料金は、SNB mensの予約ページから当サイトへ直接ご予約いただいた場合に適用されます（プラットフォーム経由のご予約には適用されません）。特典の詳細は',
  'SPACE', '誰にも会わない、一室', '完全個室・無人入室。大型ミラー（1460mm × 800mm）と置き畳で、練習も撮影も自分たちのペースで。'
];
/* Issue #639: HEROから外した当日予約の説明は、予約セクションの既存 calendar-note と重複するため試作では削除する */
var ALLOWED_CURRENT_ONLY_TEXT = [
  '予約ページで日時を選び、そのまま仮予約を送信できます。空きがあれば当日のご予約も可能です（はじめての方はオンラインクレジットカード決済のみ）。',
  /* Issue #646: 会員料金の適用と会員資格の違いは料金セクションへ集約し、他は短い要約とリンクにする（重要条件は料金セクションの member-banner に残る） */
  '※ このページ（SNB mens）の予約ページからのご予約は、SNB MEMBERへの加入有無にかかわらず会員料金が自動で適用されます。これは料金の優遇であり、会員資格の付与ではありません。',
  'をご利用ください。このページの予約ページからのご予約には、SNB MEMBERへの加入有無にかかわらず',
  'が適用されます（料金の優遇です。例：平日 3時間 ¥5,500 / 4時間 ¥7,000）',
  'ユニフォーム・フェティッシュ衣装撮影は2時間から余裕を持ってご利用いただけます。緊縛・ロープ表現を含む撮影は3時間以上のご予約をおすすめします。会員料金は、SNB mensの予約ページから当サイトへ直接ご予約いただいた場合に適用されます（プラットフォーム経由のご予約には適用されません）。会員限定のサービスなど、会員資格を前提とするサービスが自動で使えるようになるものでもありません。特典の詳細は',
  /* Issue #646: ギャラリー見出しを内容（男性モデルの作例＋設備サンプル）に合わせて変更 */
  '男性モデルによる撮影作例',
  '男性モデルによる緊縛、吊り撮影、ユニフォーム、コスチューム撮影の作例です。'
];

/* Issue #641: 利用者指定により、試作のヒーロー画像・OGP画像だけを差し替える（#633の画像維持ルールの明示的な例外）。他の画像・文言は照合を続ける */
var CUR_OGP = 'https://nagoya-base.github.io/Studio-nagoya-base/images/ogp-mens-v2-1200x630.jpg';
var PRE_OGP = 'https://nagoya-base.github.io/Studio-nagoya-base/images/mens-preview-ogp-1200x630.jpg';
var HERO_EXCEPTION_PRE = '../images/mens-preview-hero.webp | 薄暗い和室で畳に座り横を見つめる男性。「用途によって、空気が変わる。安心できる、大人の秘密基地。Studio Nagoya Base mens」 | 1600x841';
var HERO_EXCEPTION_CUR = '../images/ogp-mens-v2-1200x630.jpg | 男性同士のフェティッシュ撮影に対応するStudio Nagoya Baseの男性向け案内 | 1200x630';

/* Issue #646: 本Issueで追加するリンク・画像だけを明示的な例外にする（それ以外の照合は現行と完全一致を維持） */
var PREVIEW_ONLY_ANCHORS = [
  '仲間との利用を相談する → | data-analytics-destination=reservation_form data-analytics-event=cta_click data-analytics-location=mens_group data-analytics-type=consult href=#reservation-form',
  '安全ルール | href=#safety',
  '利用規約 | href=/Studio-nagoya-base/mens/legal/#terms',
  '料金のご案内 | href=#pricing'
];
var PREVIEW_ONLY_IMAGES = [
  '../images/gallery_man04_1200.webp | 柄背景の前でポーズをとるヒーロー衣装の人物の作品撮り | 800x1200',
  '../images/gallery_man05_1200.webp | 黒背景の前でユニフォーム姿の男性2人が撮影したシチュエーション作品（顔は加工しています） | 800x1200',
  '../images/interior-classroom_1200.webp | 学校机と黒板のある撮影スペース（人物なし） | 1200x675',
  '../images/backdrop-color-white_1200.webp | 通常の白色照明を当てた撮影スペースの白背景紙 | 1200x675',
  '../images/backdrop-color-purple_1200.webp | 紫の照明を当てた撮影スペースの背景紙 | 1200x675',
  '../images/backdrop-color-red_1200.webp | 赤の照明を当てた撮影スペースの背景紙 | 1200x675',
  '../images/backdrop-color-blue_1200.webp | 青の照明を当てた撮影スペースの背景紙 | 1200x675',
  '../images/backdrop-color-orange_1200.webp | 暖色の照明を当てた撮影スペースの背景紙 | 1200x675',
  '../images/backdrop-tiedye-gray_1200.webp | 竹の吊り設備が見える柄背景のスペース（人物なし） | 675x1200'
];

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
  assert.deepStrictEqual(diff(pre, cur).sort(), PREVIEW_ONLY_ANCHORS.slice().sort(), '#646: 追加を許すのは明示した4リンクだけ');
  assert.ok(cur.length > 40);
});

test('#633: 現行トップの写真（src/alt/寸法）をすべて維持している', { skip: skipBuilt }, function () {
  var cur = images(built.current), pre = images(built.preview);
  assert.ok(cur.indexOf(HERO_EXCEPTION_CUR) !== -1, '現行のヒーロー画像が想定どおり');
  assert.ok(pre.indexOf(HERO_EXCEPTION_PRE) !== -1, '試作のヒーロー画像が #641 の指定どおり');
  cur = cur.filter(function (x) { return x !== HERO_EXCEPTION_CUR; });
  pre = pre.filter(function (x) { return x !== HERO_EXCEPTION_PRE; });
  assert.deepStrictEqual(diff(cur, pre), []);
  assert.deepStrictEqual(diff(pre, cur).sort(), PREVIEW_ONLY_IMAGES.slice().sort(), '#646: 追加を許すのは既存WebP 9枚だけ');
});

test('#633: title・description・OGP・Twitter・canonical・JSON-LD を維持している', { skip: skipBuilt }, function () {
  var t = function (h) { return (h.match(/<title>([\s\S]*?)<\/title>/) || [])[1]; };
  assert.strictEqual(t(built.preview), t(built.current));
  ['description'].forEach(function (k) { assert.strictEqual(metaContent(built.preview, 'name', k), metaContent(built.current, 'name', k)); });
  assert.strictEqual(metaContent(built.current, 'property', 'og:image'), CUR_OGP);
  assert.strictEqual(metaContent(built.preview, 'property', 'og:image'), PRE_OGP, '#641: 試作のog:imageは専用OGP');
  assert.strictEqual(metaContent(built.preview, 'name', 'twitter:image'), PRE_OGP, '#641: 試作のtwitter:imageは専用OGP');
  ['og:title', 'og:description', 'og:type', 'og:url', 'og:locale', 'og:site_name'].forEach(function (k) {
    assert.strictEqual(metaContent(built.preview, 'property', k), metaContent(built.current, 'property', k), k);
  });
  ['twitter:card', 'twitter:title', 'twitter:description'].forEach(function (k) {
    assert.strictEqual(metaContent(built.preview, 'name', k), metaContent(built.current, 'name', k), k);
  });
  var canon = function (h) { return (h.match(/<link rel="canonical" href="([^"]*)"/) || [])[1]; };
  assert.strictEqual(canon(built.preview), canon(built.current));
  assert.deepStrictEqual(jsonld(built.preview), jsonld(built.current).map(function (j) { return j.split(CUR_OGP).join(PRE_OGP); }), '#641: JSON-LDはimageのみ専用OGPへ');
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
test('#639/#646: HEROのH1は具体的な用途と完全個室を示し、SEO文言と予約CTAを保持し、料金・当日予約説明はHEROに置かない', function () {
  var html = read('mens/preview-633.html');
  var hero = html.match(/<section class="pv-hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<h1 id="mens-hero-title" class="pv-hero-title">男性同士の緊縛・フェティッシュ撮影を、完全個室で。<\/h1>/);
  assert.strictEqual(hero.replace(/<img[\s\S]*?>/, '').indexOf('用途によって、空気が変わる。'), -1, '#646: ブランドコピーは画像内に任せ、テキストで近接して繰り返さない');
  assert.ok(hero.indexOf('緊縛をしない撮影にも利用できます') !== -1 && hero.indexOf('男性ポートレート') !== -1 && hero.indexOf('上前津') !== -1, '#646: 縛らない利用・ポートレート・所在地');
  assert.ok(hero.indexOf('data-analytics-type="consult" data-analytics-location="mens_hero"') !== -1, '#646: 相談CTAを上部に維持');
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

/* Issue #641: ヒーロー・OGP画像の差し替え（生成画像の実寸・参照の整合） */
function pngSize(buf) { return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }; }
function jpegSize(buf) {
  var i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    var m = buf[i + 1];
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
test('#641: OGP画像は1200x630、ヒーロー画像は元画像と同じ縦横比で幅1600以内（拡大なし）', function () {
  var ogp = jpegSize(fs.readFileSync(path.join(ROOT, 'images', 'mens-preview-ogp-1200x630.jpg')));
  assert.deepStrictEqual(ogp, { w: 1200, h: 630 });
  var src = pngSize(fs.readFileSync(path.join(ROOT, 'images', 'F035A90C-B055-4850-97DF-7EF808B832D9.png')));
  var webp = fs.readFileSync(path.join(ROOT, 'images', 'mens-preview-hero.webp'));
  assert.strictEqual(webp.slice(0, 4).toString(), 'RIFF');
  assert.strictEqual(webp.slice(8, 12).toString(), 'WEBP');
  assert.strictEqual(webp.slice(12, 16).toString(), 'VP8 ');
  var w = webp.readUInt16LE(26) & 0x3FFF, h = webp.readUInt16LE(28) & 0x3FFF;
  assert.ok(w <= 1600 && w <= src.w);
  assert.ok(Math.abs(w / h - src.w / src.h) < 0.005, '縦横比が元画像と一致');
  var html = read('mens/preview-633.html');
  assert.ok(html.indexOf('src="../images/mens-preview-hero.webp"\n        width="' + w + '"\n        height="' + h + '"') !== -1, 'width/heightが生成画像と一致');
  assert.ok(html.indexOf('<link rel="preload" as="image" href="../images/mens-preview-hero.webp"') !== -1);
  assert.strictEqual(html.indexOf('ogp-mens-v2'), -1, '試作は旧OGPを参照しない');
});
test('#641: 現行トップと元画像は変更しない（現行は従来のOGPを参照）', function () {
  assert.ok(fs.existsSync(path.join(ROOT, 'images', 'F035A90C-B055-4850-97DF-7EF808B832D9.png')));
  assert.ok(read('mens/index.html').indexOf('images/ogp-mens-v2-1200x630.jpg') !== -1);
});

/* Issue #646: 用途訴求の改善 */
var NEW_WEBP = ['gallery_man04', 'gallery_man05', 'interior-classroom', 'backdrop-color-purple', 'backdrop-color-red', 'backdrop-color-blue', 'backdrop-color-orange', 'backdrop-color-white', 'backdrop-tiedye-gray'];
function webpSize(buf) {
  assert.strictEqual(buf.slice(0, 4).toString(), 'RIFF');
  var fmt = buf.slice(12, 16).toString();
  if (fmt === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3FFF, h: buf.readUInt16LE(28) & 0x3FFF };
  if (fmt === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  if (fmt === 'VP8L') { var b = buf.readUInt32LE(21); return { w: (b & 0x3FFF) + 1, h: ((b >> 14) & 0x3FFF) + 1 }; }
  return null;
}
test('#646: 追加9枚は既存WebPを参照し、width/heightが実寸と一致し、元JPEG・メイド写真は参照しない', function () {
  var html = read('mens/preview-633.html');
  NEW_WEBP.forEach(function (n) {
    var m = html.match(new RegExp('src="\\.\\./images/' + n + '_1200\\.webp" width="(\\d+)" height="(\\d+)"'));
    assert.ok(m, n + ' が参照されている');
    var sz = webpSize(fs.readFileSync(path.join(ROOT, 'images', n + '_1200.webp')));
    assert.deepStrictEqual({ w: +m[1], h: +m[2] }, sz, n + ' の寸法');
    assert.strictEqual(html.split('images/' + n + '_1200.webp').length - 1, 1, n + ' は1回だけ配置（重複配置しない）');
  });
  assert.doesNotMatch(html, /IMG_\d+\.jpe?g|224A0007|sample_0\d|studio-x-event|studiox_classroom|\.\.\/studio-x\//, '元JPEG・Studio X素材は参照しない');
  var imgs = html.match(/<img\b[^>]*>/g).filter(function (t) { return NEW_WEBP.some(function (n) { return t.indexOf(n + '_1200.webp') !== -1; }); });
  assert.strictEqual(imgs.length, 9);
  imgs.forEach(function (t) { assert.match(t, /loading="lazy"/); assert.match(t, /alt="[^"]+"/); assert.match(t, /class="gallery-image cursor-pointer"/, '画像拡大を維持'); });
});
test('#646: 仲間との利用の枠はコピー・人数表記・CTA計測属性・既存リンク先が仕様どおり', function () {
  var html = read('mens/preview-633.html');
  var g = html.match(/<div class="pv-group" id="group-use">[\s\S]*?<\/ul>[\s\S]*?<\/div>\s*<\/div>/)[0];
  ['好きが通じる仲間と、自分たちだけの時間を。', 'ユニフォームを持ち寄って撮る。縄の練習をする。撮った写真を見ながら話す。', '同じ趣味の仲間と集まる、少人数のフェチ会・同好会にも。完全貸切・無人入室で、自分たちのペースで楽しめます。',
    '1〜4名。5名以上は事前にご相談ください（運営者の承認が必要です）。', '参加者募集を予定している会は、募集前にご相談ください。'].forEach(function (t) { assert.ok(g.indexOf(t) !== -1, t); });
  assert.match(g, /<a class="btn-secondary" href="#reservation-form" data-analytics-event="cta_click" data-analytics-type="consult" data-analytics-location="mens_group" data-analytics-destination="reservation_form">仲間との利用を相談する →<\/a>/);
  assert.ok(g.indexOf('href="#safety"') !== -1 && g.indexOf("/mens/legal/' | relative_url }}#terms") !== -1, '安全ルール・利用規約へ接続');
  assert.ok(g.indexOf('18歳以上') !== -1 && g.indexOf('高校生') !== -1 && g.indexOf('宴会・飲み会目的ではご利用いただけません') !== -1);
  assert.doesNotMatch(g, /予約フォーム|最大4名|5名以上可|知り合い限定|3名以上|熟練者|経験者/, '未確定方針・表記揺れ・人数の断定を置かない');
  assert.strictEqual(html.indexOf('id="reservation-form"') === -1, true, '相談フォームのIDは include 側（既存）');
  assert.ok(read('_includes/reservation_form_ja.html').indexOf('id="reservation-form"') !== -1, '#reservation-form が存在する');
});
test('#646: 照明5枚は1つの比較グループ（JSなしでも全表示）で、切替JSは例外時に元の表示へ戻し、自動切替しない', function () {
  var html = read('mens/preview-633.html');
  var cmp = html.match(/<div class="pv-compare" data-pv-compare>[\s\S]*?<\/ul>/)[0];
  assert.strictEqual((cmp.match(/<li class="pv-compare-item">/g) || []).length, 5);
  assert.strictEqual((cmp.match(/width="1200" height="675"/g) || []).length, 5, '5枚とも横長');
  var css = read('styles/mens-preview-633.css');
  assert.match(css, /\.pv-compare\.is-enhanced \.pv-compare-item \{ display: none/, '非表示は JS 成功時（.is-enhanced）限定');
  assert.doesNotMatch(css, /^\.pv-compare-item \{[^}]*display: none/m);
  var js = read('scripts/mens-preview-646.js');
  assert.doesNotMatch(js, /setInterval|setTimeout/, '自動切替しない');
  var vm = require('vm');
  function run(failing) {
    var classes = {}, appended = 0, removed = 0;
    var mk = function () { return { className: '', setAttribute: function () {}, classList: { add: function () {}, remove: function () {} }, appendChild: function () { appended++; }, addEventListener: function () {}, parentNode: null }; };
    var item = { classList: { add: function () {}, remove: function () {} }, querySelector: function () { return { getAttribute: function () { return '紫'; } }; } };
    var rootEl = {
      classList: { add: function (c) { classes[c] = true; }, remove: function (c) { delete classes[c]; } },
      querySelectorAll: function () { return [item, item]; },
      insertBefore: function () { if (failing) throw new Error('boom'); }, firstChild: null
    };
    var sb = { document: { querySelector: function () { return rootEl; }, createElement: mk }, Array: Array, String: String };
    vm.runInNewContext(js, sb);
    return classes;
  }
  assert.deepStrictEqual(run(false), { 'is-enhanced': true });
  assert.deepStrictEqual(run(true), {});
});
test('#646: 試作はnoindex・計測JS/送信JS無し・現行トップ(mens/index.html)に新コピーを入れない', function () {
  var src = read('mens/preview-633.html');
  assert.match(src, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(src, /googletagmanager|gtag\(|analytics\.js|reservation-form\.js/);
  var cur = read('mens/index.html');
  ['mens_group', '好きが通じる仲間と', 'interior-classroom', 'gallery_man04'].forEach(function (k) { assert.strictEqual(cur.indexOf(k), -1, k); });
});
