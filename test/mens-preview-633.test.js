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
  '学校机と黒板のある空間',
  '学校机と黒板で、撮影にひとつのシーンを。',
  '衣装やポーズを合わせて、自分たちの設定を楽しむ撮影にも。',
  '縛らない日も、自分たちらしく撮る。',
  '男性ポートレートや身体表現、セルフ撮影、ペアでの撮影にも。背景と照明を使って、撮りたい雰囲気をつくれます。',
  '好きが通じる仲間と、自分たちだけの時間を。',
  'ユニフォームを持ち寄って撮る。縄の練習をする。撮った写真を見ながら話す。',
  '同じ趣味の仲間と集まる、少人数のフェチ会・同好会にも。完全貸切・無人入室で、自分たちのペースで楽しめます。',
  '1〜4名。5名以上は事前にご相談ください（運営者の承認が必要です）。',
  '参加者募集を予定している会は、募集前にご相談ください。',
  '参加者全員が18歳以上であること（高校生は利用不可）を予約者が確認し、同伴者も含めて利用規約に従ってご利用ください。',
  '場所と設備の貸出です。会の主催や参加者・モデルの手配、指導は含まれません。宴会・飲み会目的ではご利用いただけません。',
  '吊りを伴う利用の条件は、',
  '仲間との利用を相談する →',
  /* Issue #651: HERO直下の用途ナビ・PRIVATEへの集約・作例と見出しの整理・法的事項の移動（現行からの変更は ALLOWED_CURRENT_ONLY_TEXT に対応） */
  '用途から探す',
  /* Issue #653: 用途カード4件（フェチ／コスプレ・ポートレート／教室セット）・人物撮影と設営サポートのコピー・作品紹介・背景一覧 */
  '緊縛・ロープ撮影', '男性同士の練習・床縄・吊りの作例',
  'フェチ', 'ユニフォームやシチュエーションを楽しむ撮影',
  'コスプレ・ポートレート', '好きな衣装での作品撮りや、人物・セルフ撮影に',
  '教室セット', '学校机と黒板で、撮影シーンをつくる',
  '人物・セルフ撮影の紹介を見る →',
  'ユニフォームで、自分らしい一枚を。', '黒背景と照明を使った、ユニフォーム撮影の作例です。', '本格的な照明機材も、設営をサポート。',
  '和柄背景（鶴・黒）', '和柄背景（麻の葉・藍）', 'グランジ背景',
  'ゲイ・バイ男性を含む、男性同士の撮影・練習を歓迎しています。性別・性的指向を問わずご利用いただけます。',
  '無人入室ですが、防犯カメラを設置しています（無人運営・安全確認用途）。',
  '利用条件・法的事項を確認する',
  'ヒーロー衣装の作例（白背景）',
  '背景・照明の例を見る →',
  '照明・背景とスタジオの空間',
  '照明・背景・設備のサンプルをご覧いただけます。男性モデルの作例は、用途別の紹介にあります。',
  '背景バリエーション / Backdrop Variations',
  '同じ場所で、照明の色を変えると / Lighting Comparison',
  '同じ撮影場所で、照明の色を変えた5パターンです。構図が完全に一致する比較ではありません。',
  '通常色（白）の照明', '紫の照明', '赤の照明', '青の照明', '暖色の照明',
  '※ このページの予約ページからのご予約には会員料金が適用されます。適用条件と会員資格との違いは', '料金のご案内',
  'をご利用ください。このページの予約ページからのご予約には', 'が適用されます（例：平日 3時間 ¥5,500 / 4時間 ¥7,000）',
  'SPACE', '誰にも会わない、一室', '完全個室・無人入室。大型ミラー（1460mm × 800mm）と置き畳で、練習も撮影も自分たちのペースで。'
];
/* Issue #639: HEROから外した当日予約の説明は、予約セクションの既存 calendar-note と重複するため試作では削除する */
/* 短い汎用断片は全体許容にせず、増えてよい出現数だけを明示する（#646の仲間枠・料金リンク） */
var ALLOWED_PREVIEW_EXTRA_COUNT = { '安全ルール': 1, 'と': 1, '利用規約': 1, 'をご確認ください。': 2 };
var ALLOWED_CURRENT_ONLY_TEXT = [
  '予約ページで日時を選び、そのまま仮予約を送信できます。空きがあれば当日のご予約も可能です（はじめての方はオンラインクレジットカード決済のみ）。',
  /* Issue #646: 会員料金の適用と会員資格の違いは料金セクションへ集約し、他は短い要約とリンクにする（重要条件は料金セクションの member-banner に残る） */
  '※ このページ（SNB mens）の予約ページからのご予約は、SNB MEMBERへの加入有無にかかわらず会員料金が自動で適用されます。これは料金の優遇であり、会員資格の付与ではありません。',
  'をご利用ください。このページの予約ページからのご予約には、SNB MEMBERへの加入有無にかかわらず',
  'が適用されます（料金の優遇です。例：平日 3時間 ¥5,500 / 4時間 ¥7,000）',
  /* Issue #646: ギャラリー見出しを内容（男性モデルの作例＋設備サンプル）に合わせて変更 */
  '男性モデルによる撮影作例',
  '男性モデルによる緊縛、吊り撮影、ユニフォーム、コスチューム撮影の作例です。',
  /* Issue #651: 歓迎説明はPRIVATEの1文へ、「人目を気にせず」は完全貸切・無人入室のPRIVATE表示へ集約。背景ラベルの内部向け表記を利用者向けに整理 */
  'ゲイ・バイ男性を含む男性ペアや男性グループでのご利用を歓迎しています。性別や性的指向を問わずご利用いただけます。',
  '男性同士で使える',
  '男性ペアや男性グループでの緊縛練習・撮影を歓迎しています。ゲイ・バイ男性を含め、性別や性的指向を問わずご利用いただけます。',
  '人目を気にせず使える',
  '完全個室・無人入室。他の利用者やスタッフと対面することなく、衣装やロープ表現に集中できます。',
  '背景バリエーション（追加候補） / Additional Backdrops',
  /* Issue #653: 設備写真（木組み・竹）は設備紹介の静止画へ移し、ギャラリーの同じ写真の重複グループは置かない */
  'スタジオ全景・吊り設備 / Studio &amp; Rigging'
];
/* 削除した特徴カード2枚のアイコン（◈）は個数で許容する */
var ALLOWED_CURRENT_ONLY_COUNT = { '◈': 2 };

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
  '料金のご案内 | href=#pricing',
  /* Issue #651/#653: 用途カード4件・PRIVATEの法的事項リンク・衣装→人物撮影、人物撮影→背景・照明のリンク（JSなしで使える通常のアンカー） */
  '緊縛・ロープ撮影 男性同士の練習・床縄・吊りの作例 | href=#usage',
  'フェチ ユニフォームやシチュエーションを楽しむ撮影 | href=#scenes',
  'コスプレ・ポートレート 好きな衣装での作品撮りや、人物・セルフ撮影に | href=#costume-portrait-use',
  '教室セット 学校机と黒板で、撮影シーンをつくる | href=#classroom-use',
  '利用条件・法的事項を確認する | href=#legal',
  '人物・セルフ撮影の紹介を見る → | href=#portrait-use',
  '背景・照明の例を見る → | href=#gallery'
];
var PREVIEW_ONLY_IMAGES = [
  '../images/gallery_man04_1200.webp | 柄背景の前でポーズをとるヒーロー衣装の人物の作品撮り | 800x1200',
  '../images/gallery_man05_1200.webp | 黒背景の前でユニフォーム姿の男性2人が撮影したシチュエーション作品（顔は加工しています） | 800x1200',
  '../images/interior-classroom_1200.webp | 学校机と黒板のある撮影スペース | 1200x675',
  '../images/backdrop-color-white_1200.webp | 通常の白色照明を当てた撮影スペースの白背景紙 | 1200x675',
  '../images/backdrop-color-purple_1200.webp | 紫の照明を当てた撮影スペースの背景紙 | 1200x675',
  '../images/backdrop-color-red_1200.webp | 赤の照明を当てた撮影スペースの背景紙 | 1200x675',
  '../images/backdrop-color-blue_1200.webp | 青の照明を当てた撮影スペースの背景紙 | 1200x675',
  '../images/backdrop-color-orange_1200.webp | 暖色の照明を当てた撮影スペースの背景紙 | 1200x675',
  '../images/backdrop-tiedye-gray_1200.webp | グレーの濃淡とムラのあるグランジ背景 | 675x1200'
];
/* Issue #653: 実画像の内容に合わせて alt を直す現行トップの3枚（src・寸法は同じ。現行側は照合から外し、試作の新 alt を明示する） */
var CUR_ALT_REPLACED = [
  '../images/gallery_man03_1200.webp | 木組みの吊り床と撮影機材が分かるスタジオ内観（男性モデル） | 1200x800',
  '../images/interior-rigging-frame_1200.jpeg | スタジオ内観（通常照明・木組みフレームと置き畳） | 1200x675',
  '../images/gallery_lighting01_1200.webp | 木組みの吊り設備を照らすフルカラー照明サンプル 1 | 1200x675'
];
var PRE_ALT_REPLACED = [
  '../images/gallery_man03_1200.webp | 黒背景と左右のソフトボックスの前に立つ野球ユニフォーム姿の男性（顔は加工しています） | 1200x800',
  '../images/interior-rigging-frame_1200.jpeg | 木組み・畳・大型ミラーが見える、通常照明のスタジオ内観 | 1200x675',
  '../images/gallery_lighting01_1200.webp | 暖色の照明に照らされた竹と木組みの吊り設備 | 1200x675'
];
/* Issue #651: 用途ナビの装飾サムネイル（リンク文言が説明するため alt は空）。既存WebPの再利用のみ */
var NAV_THUMBS = [
  '../images/gallery_man02_1200.webp |  | 800x1200',
  '../images/gallery_man05_1200.webp |  | 800x1200',
  '../images/gallery_man04_1200.webp |  | 800x1200',
  '../images/interior-classroom_1200.webp |  | 1200x675'
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
  var curLeft = JSON.parse(JSON.stringify(ALLOWED_CURRENT_ONLY_COUNT));
  var cur = visibleLeaves(built.current).filter(function (t) { return ALLOWED_CURRENT_ONLY_TEXT.indexOf(t) === -1; }).filter(function (t) {
    if (curLeft[t] > 0) { curLeft[t]--; return false; }
    return true;
  });
  assert.deepStrictEqual(Object.keys(curLeft).filter(function (k) { return curLeft[k] !== 0; }), [], '個数指定の現行限定テキストは指定数ぴったり消えていること');
  var preAll = visibleLeaves(built.preview);
  var pre = preAll.filter(function (t) { return ALLOWED_PREVIEW_ONLY_TEXT.indexOf(t) === -1 && !(t in ALLOWED_PREVIEW_EXTRA_COUNT); });
  Object.keys(ALLOWED_PREVIEW_EXTRA_COUNT).forEach(function (k) {
    assert.ok((multiset(preAll)[k] || 0) - (multiset(cur)[k] || 0) <= ALLOWED_PREVIEW_EXTRA_COUNT[k], '増やしてよい出現数を超えた断片: ' + k);
  });
  /* 許容リストに無い文言が試作で増えていないこと（許容語は現行側に同名があっても現行の出現数までは数える） */
  assert.deepStrictEqual(diff(cur, preAll), [], '試作で欠落・変更された現行テキスト');
  assert.deepStrictEqual(diff(pre, cur).filter(function (t) { return multiset(preAll)[t] > multiset(cur)[t]; }), [], '試作で追加・変更されたテキスト');
  assert.ok(cur.length > 200, '照合対象が空洞化していないこと');
});

test('#633: リンク先・CTA文言・data-analytics-* の対応が現行と一致する', { skip: skipBuilt }, function () {
  var cur = anchors(built.current), pre = anchors(built.preview);
  assert.deepStrictEqual(diff(cur, pre), []);
  assert.deepStrictEqual(diff(pre, cur).sort(), PREVIEW_ONLY_ANCHORS.slice().sort(), '#646/#651: 追加を許すのは明示したリンクだけ');
  assert.ok(cur.length > 40);
});

test('#633: 現行トップの写真（src/alt/寸法）をすべて維持している', { skip: skipBuilt }, function () {
  var cur = images(built.current), pre = images(built.preview);
  assert.ok(cur.indexOf(HERO_EXCEPTION_CUR) !== -1, '現行のヒーロー画像が想定どおり');
  assert.ok(pre.indexOf(HERO_EXCEPTION_PRE) !== -1, '試作のヒーロー画像が #641 の指定どおり');
  cur = cur.filter(function (x) { return x !== HERO_EXCEPTION_CUR && CUR_ALT_REPLACED.indexOf(x) === -1; });
  pre = pre.filter(function (x) { return x !== HERO_EXCEPTION_PRE; });
  assert.deepStrictEqual(diff(cur, pre), []);
  assert.deepStrictEqual(diff(pre, cur).sort(), PREVIEW_ONLY_IMAGES.concat(NAV_THUMBS, PRE_ALT_REPLACED).sort(), '#646/#651/#653: 追加を許すのは既存WebP 9枚・用途カードのサムネイル4件・alt を実画像へ合わせた3枚だけ');
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
  assert.strictEqual(groups.length, 2, 'landscape/portrait グループ数（#653: 設備写真と背景は別の静的一覧へ移動）');
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

/* Issue #653: 設備は静止画で通常スクロール。写真切替は衣装ブロックの4作品へ移す */
test('#653: 設備紹介（木組み・竹・空間・ROPE POINT）は対応する静止画と説明で、固定ステージ・切替・ズーム・演出用余白を持たない', function () {
  var html = read('mens/preview-633.html');
  var sec = html.match(/<section id="usage">[\s\S]*?<\/section>/)[0];
  var order = ['WOOD FRAME', 'SPACE', 'BAMBOO', 'ROPE POINT'].map(function (k) { return sec.indexOf('pv-step-label">' + k + '<'); });
  assert.ok(order.every(function (i) { return i > 0; }));
  assert.deepStrictEqual(order.slice().sort(function (a, b) { return a - b; }), order);
  ['高さ 2350mm／間口 2450mm／奥行 2000mm', '大型ミラー（1460mm × 800mm）と置き畳', '天井に渡した竹と木組み', '空中緊縛は経験者のみ、縛り手・受け手を含む3名以上'].forEach(function (t) { assert.ok(sec.indexOf(t) !== -1, t); });
  var items = sec.match(/<div class="pv-facility-item[^"]*">[\s\S]*?<\/figure>/g);
  assert.strictEqual(items.length, 3);
  assert.ok(items[0].indexOf('interior-rigging-frame_1200.webp') !== -1 && items[0].indexOf('interior-rigging-frame_1200.jpeg" width="1200" height="675"') !== -1, 'WOOD FRAME／SPACE: 通常照明の内観（同名JPEG fallback）');
  assert.ok(items[1].indexOf('gallery_lighting01_1200.webp" width="1200" height="675"') !== -1, 'BAMBOO: 暖色照明の竹');
  assert.ok(items[2].indexOf('gallery_man02_1200.webp" width="800" height="1200"') !== -1, 'ROPE POINT: 既存の関連作例');
  assert.strictEqual(sec.indexOf('gallery_man03'), -1, '設備説明中にユニフォーム人物（man03）を表示しない');
  assert.doesNotMatch(sec, /data-pv-scroll|data-pv-step|data-zoom/);
  assert.strictEqual(html.indexOf('mens-preview-639.js'), -1, '設備の切替・ズーム用JSを読み込まない');
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'scripts', 'mens-preview-639.js')), false);
  var css = read('styles/mens-preview-633.css');
  assert.doesNotMatch(css, /pv-scroll|pv-stage-photo|--pv-zoom|min-height: 62vh/, '設備の固定ステージ・ズーム・演出用余白のCSSを残さない');
  var gallery = html.match(/<section id="gallery">[\s\S]*?<\/section>/)[0];
  assert.strictEqual(gallery.indexOf('interior-rigging-frame'), -1, 'スタジオ全景・吊り設備との重複をなくす');
  assert.strictEqual(gallery.indexOf('gallery_lighting01'), -1);
  ['interior-rigging-frame_1200.webp', 'gallery_lighting01_1200.webp', 'gallery_man02_1200.webp'].forEach(function (f) {
    var sz = webpSize(fs.readFileSync(path.join(ROOT, 'images', f)));
    assert.ok(html.indexOf('images/' + f + '" width="' + sz.w + '" height="' + sz.h + '"') !== -1 || f === 'interior-rigging-frame_1200.webp', f + ' の寸法');
  });
  assert.deepStrictEqual(jpegSize(fs.readFileSync(path.join(ROOT, 'images', 'interior-rigging-frame_1200.jpeg'))), { w: 1200, h: 675 });
});

test('#653: 衣装ブロックは指定4作品を順に紹介し、JSなし・reduced motion・初期化失敗では4作品とキャプションを静的に並べる', function () {
  var html = read('mens/preview-633.html');
  var blk = html.match(/<div class="pv-scene pv-scene--costume" id="costume-portrait-use">[\s\S]*?<\/ul>/)[0];
  var works = blk.match(/<li class="pv-work" data-pv-work>[\s\S]*?<\/li>/g);
  assert.strictEqual(works.length, 4);
  ['gallery_man01_1200.webp', 'gallery_man04_1200.webp', 'gallery_man05_1200.webp', 'hero_mens_1200.webp'].forEach(function (f, i) {
    assert.ok(works[i].indexOf('images/' + f) !== -1, '順番' + (i + 1) + ': ' + f);
    assert.match(works[i], /class="gallery-image cursor-pointer"/, '拡大対象は写真そのもの');
    assert.match(works[i], /<figcaption data-pv-work-caption>[^<]+<\/figcaption>/, '各作品にキャプション');
  });
  assert.strictEqual(html.split('gallery_man01_1200.webp').length - 1, 1, '同じ作品の大判グリッドを二重に置かない');
  assert.strictEqual(html.split('hero_mens_1200.webp').length - 1, 1);
  assert.doesNotMatch(blk, /ビフォー|アフター|変化/, '異なる作品を同一撮影の変化として説明しない');
  var css = read('styles/mens-preview-633.css');
  assert.doesNotMatch(css.replace(/\.pv-works\.is-active[^{]*\{[^}]*\}/g, ''), /pv-work[^{]*\{[^}]*(visibility: hidden|opacity: 0)/, '非表示は JS 成功時（.is-active）限定');
  assert.match(css, /\.pv-works\.is-active \.pv-photo \{[^}]*position: sticky[^}]*opacity: 0; visibility: hidden; pointer-events: none/, '非表示レイヤーはクリック・フォーカスを受けない');
  assert.match(css, /\.pv-works\.is-active \.pv-work\.is-current \.pv-photo \{ opacity: 1; visibility: visible; pointer-events: auto/);
  assert.doesNotMatch(css, /pv-works[^{]*\{[^}]*transform: scale/, '作品を演出用ズームで切らない');
  assert.match(css, /prefers-reduced-motion: reduce\) \{[\s\S]*\.pv-works \.pv-photo, \.pv-works figcaption \{ transition: none/);
  var js = read('scripts/mens-preview-653.js');
  assert.doesNotMatch(js, /setInterval|setTimeout|scrollTo|scrollIntoView/, '自動再生・スクロールの強制移動をしない');
  assert.match(js, /prefers-reduced-motion: reduce/);
  assert.match(js, /catch \(e\) \{\s*root\.classList\.remove\('is-active'\)/);
  assert.ok(html.indexOf('mens-preview-653.js') !== -1);
});

test('#653: 作品切替JSは reduced motion・非対応・例外時に .is-active を付けず、キャプションが帯に入った作品を表示中にする', function () {
  var vm = require('vm');
  function run(opts) {
    var added = [], ios = [], listeners = {}, clicks = 0;
    var works = [0, 1, 2, 3].map(function (i) {
      var cls = {};
      return { i: i, cls: cls, contains: function () { return false; }, querySelector: function () { return { click: function () { clicks++; }, focus: function () {} }; }, classList: { add: function (c) { cls[c] = true; }, remove: function (c) { delete cls[c]; } } };
    });
    var caps = works.map(function (w) {
      var attrs = {}, ev = {};
      return { attrs: attrs, ev: ev, textContent: '作品' + w.i, closest: function () { return w; }, setAttribute: function (k, v) { attrs[k] = v; }, removeAttribute: function (k) { delete attrs[k]; }, addEventListener: function (t, f) { ev[t] = f; } };
    });
    var rootEl = {
      classList: { add: function (c) { added.push(c); }, remove: function (c) { added = added.filter(function (x) { return x !== c; }); } },
      querySelectorAll: function (q) { return q.indexOf('caption') !== -1 ? caps : works; }
    };
    var sb = {
      document: { querySelector: function () { return rootEl; }, activeElement: null },
      innerHeight: opts.h || 720,
      matchMedia: function (q) { return { matches: q.indexOf('reduce') !== -1 ? !!opts.reduced : false }; },
      addEventListener: function (t, f) { listeners[t] = f; },
      requestAnimationFrame: function (f) { f(); },
      Array: Array,
      IntersectionObserver: opts.io === undefined ? function (cb, o) { ios.push({ cb: cb, o: o }); this.observe = function () {}; this.disconnect = function () {}; } : opts.io
    };
    sb.window = sb;
    if (opts.noIo) delete sb.IntersectionObserver;
    vm.runInNewContext(read('scripts/mens-preview-653.js'), sb);
    return { added: added, works: works, ios: ios, caps: caps, listeners: listeners, sb: sb, clicks: function () { return clicks; } };
  }
  var ok = run({ h: 720 });
  assert.deepStrictEqual(ok.added, ['is-active']);
  assert.ok(ok.works[0].cls['is-current'], '初期は1作品目');
  assert.strictEqual(ok.ios[0].o.rootMargin, '-324px 0px -324px 0px', '帯は viewport の高さ（720px）の中央10%：%ではなくpxで指定する（横長画面でも成立）');
  ok.ios[0].cb([{ isIntersecting: true, target: ok.caps[2] }]);
  assert.ok(ok.works[2].cls['is-current'] && !ok.works[0].cls['is-current'], 'キャプション3が帯に入ると3作品目だけが表示中');
  ok.ios[0].cb([{ isIntersecting: false, target: ok.caps[1] }]);
  assert.ok(ok.works[2].cls['is-current'], '帯から出ただけでは切り替えない');
  ok.sb.innerHeight = 900;
  ok.listeners.resize();
  assert.strictEqual(ok.ios[ok.ios.length - 1].o.rootMargin, '-405px 0px -405px 0px', 'resizeで帯を更新する');
  /* キーボード：全キャプションが Tab 対象で、フォーカス・Enter・Space でその作品を選び、Enter・Space で拡大できる */
  ok.caps.forEach(function (c) { assert.strictEqual(c.attrs.tabindex, '0'); assert.strictEqual(c.attrs.role, 'button'); });
  ok.caps[3].ev.focus();
  assert.ok(ok.works[3].cls['is-current'] && !ok.works[2].cls['is-current'], 'フォーカスで4作品目へ');
  var prevented = 0;
  ok.caps[1].ev.keydown({ key: 'Enter', preventDefault: function () { prevented++; } });
  assert.ok(ok.works[1].cls['is-current'] && ok.clicks() === 1 && prevented === 1, 'Enterで選択して拡大');
  ok.caps[0].ev.keydown({ key: ' ', preventDefault: function () { prevented++; } });
  assert.strictEqual(ok.clicks(), 2);
  ok.caps[0].ev.keydown({ key: 'a', preventDefault: function () { prevented++; } });
  assert.strictEqual(ok.clicks(), 2, '他のキーでは拡大しない');
  assert.deepStrictEqual(run({ reduced: true }).added, []);
  assert.deepStrictEqual(run({ noIo: true }).added, []);
  var fail = run({ io: function () { throw new Error('boom'); } });
  assert.deepStrictEqual(fail.added, []);
  fail.caps.forEach(function (c) { assert.deepStrictEqual(c.attrs, {}, '失敗時は操作属性を残さない'); });
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
    var navUse = ['gallery_man04', 'interior-classroom', 'gallery_man05'].indexOf(n) !== -1 ? 1 : 0; /* #651/#653: 用途カードでの小さな再利用のみ可 */
    assert.strictEqual(html.split('images/' + n + '_1200.webp').length - 1, 1 + navUse, n + ' は本文では1回だけ配置（用途ナビのサムネイルを除き重複配置しない）');
  });
  assert.doesNotMatch(html, /IMG_\d+\.jpe?g|224A0007|sample_0\d|studio-x-event|studiox_classroom|\.\.\/studio-x\//, '元JPEG・Studio X素材は参照しない');
  var imgs = html.replace(/<nav class="pv-usenav"[\s\S]*?<\/nav>/, '').match(/<img\b[^>]*>/g).filter(function (t) { return NEW_WEBP.some(function (n) { return t.indexOf(n + '_1200.webp') !== -1; }); });
  assert.strictEqual(imgs.length, 9);
  imgs.forEach(function (t) { assert.match(t, /loading="lazy"/); assert.match(t, /alt="[^"]+"/); assert.match(t, /class="gallery-image cursor-pointer"/, '画像拡大を維持'); });
});
test('#646: 仲間との利用の枠はコピー・人数表記・CTA計測属性・既存リンク先が仕様どおり', function () {
  var html = read('mens/preview-633.html');
  var g = html.match(/<div class="pv-group" id="group-use">[\s\S]*?<\/section>/)[0];
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

/* Issue #651: 用途導線の前倒し・作例と見出しの整理・法的事項の移動・歓迎説明の集約 */
test('#651/#653: HERO直下に4用途のカードがあり、通常アンカーで #usage/#scenes/#costume-portrait-use/#classroom-use へ移動できる', function () {
  var html = read('mens/preview-633.html');
  var heroEnd = html.indexOf('<!-- 安心・PRIVATE（白） -->');
  var nav = html.match(/<nav class="pv-usenav" aria-label="用途から探す">[\s\S]*?<\/nav>/);
  assert.ok(nav, '用途ナビが存在する');
  assert.ok(html.indexOf(nav[0]) > html.indexOf('</section>', html.indexOf('class="pv-hero"')) && html.indexOf(nav[0]) < heroEnd, 'HEROの直後、PRIVATEより前');
  var hrefs = (nav[0].match(/<a class="pv-usenav-link" href="(#[^"]+)"/g) || []).map(function (a) { return a.match(/href="([^"]+)"/)[1]; });
  assert.deepStrictEqual(hrefs, ['#usage', '#scenes', '#costume-portrait-use', '#classroom-use']);
  hrefs.concat(['#portrait-use', '#group-use']).forEach(function (h) { assert.strictEqual(html.split('id="' + h.slice(1) + '"').length - 1, 1, h + ' が1つだけ存在する'); });
  var labels = (nav[0].match(/<span class="pv-usenav-label">[^<]+/g) || []).map(function (x) { return x.replace(/<[^>]+>/, ''); });
  assert.deepStrictEqual(labels, ['緊縛・ロープ撮影', 'フェチ', 'コスプレ・ポートレート', '教室セット']);
  var imgs = (nav[0].match(/<img [^>]*>/g) || []).map(function (t) { return t.match(/src="\.\.\/images\/([^"]+)"/)[1]; });
  assert.deepStrictEqual(imgs, ['gallery_man02_1200.webp', 'gallery_man05_1200.webp', 'gallery_man04_1200.webp', 'interior-classroom_1200.webp']);
  assert.ok(nav[0].indexOf('男性同士の練習・床縄・吊りの作例') !== -1 && nav[0].indexOf('ユニフォームやシチュエーションを楽しむ撮影') !== -1 && nav[0].indexOf('好きな衣装での作品撮りや、人物・セルフ撮影に') !== -1 && nav[0].indexOf('学校机と黒板で、撮影シーンをつくる') !== -1, '説明文');
  assert.doesNotMatch(nav[0], /data-analytics|onclick|button/, '用途ナビは計測属性・JS依存を持たない');
  assert.strictEqual(html.indexOf('空間写真'), -1, '素材分類のバッジ・注記を置かない');
  assert.strictEqual((nav[0].match(/alt=""/g) || []).length, 4, '装飾サムネイルは空alt（リンク文言が説明する）');
  assert.match(nav[0], /pv-usenav-photo--head"><img src="\.\.\/images\/gallery_man04_1200\.webp"/, '仮面ライダーは頭部・衣装が分かるトリミング');
  var css = read('styles/mens-preview-633.css');
  assert.match(css, /\.pv-usenav-photo--head img \{ object-position: 50% 6%; \}/);
  assert.match(css, /\.pv-usenav-list \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/, 'PCは4列');
  assert.match(css, /max-width: 800px\) \{[\s\S]*\.pv-usenav-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, 'SPは2列×2行');
  assert.match(css, /\.pv-usenav-label \{[^}]*overflow-wrap: anywhere/, '320pxでも文字がはみ出さない');
  assert.ok(html.indexOf('data-analytics-location="mens_hero"') !== -1 && html.indexOf('data-analytics-location="mens_hero" data-analytics-type="booking_app"') !== -1, 'HEROの予約・相談CTAを維持');
  var cp = html.match(/<div class="pv-scene pv-scene--costume" id="costume-portrait-use">[\s\S]*?<div class="pv-scene pv-scene--landscape" id="classroom-use">/)[0];
  assert.ok(cp.indexOf('href="#portrait-use"') !== -1, '衣装紹介から人物・セルフ撮影の紹介へ');
  assert.ok(html.indexOf('class="pv-scene pv-scene--landscape" id="classroom-use"') !== -1 && html.indexOf('学校机と黒板のある空間') !== -1);
  assert.doesNotMatch(nav[0], /href="#group-use"/, '教室カードは #group-use へ飛ばさない');
});
test('#653: 人物撮影の紹介は gallery_man03 の全身・照明機材の写真と指定コピーで、撮影代行などを示さない', function () {
  var html = read('mens/preview-633.html');
  var pu = html.match(/<div class="pv-scene pv-scene--portrait" id="portrait-use">[\s\S]*?<div class="pv-group"/)[0];
  assert.ok(pu.indexOf('縛らない日も、自分たちらしく撮る。') !== -1 && pu.indexOf('href="#gallery"') !== -1, '説明と背景・照明への導線');
  assert.ok(pu.indexOf('gallery_man03_1200.webp" width="1200" height="800"') !== -1 && pu.indexOf('is-landscape') !== -1, '全身と左右のソフトボックスが見える横長のまま表示');
  ['ユニフォームで、自分らしい一枚を。', '黒背景と照明を使った、ユニフォーム撮影の作例です。', '本格的な照明機材も、設営をサポート。'].forEach(function (t) { assert.ok(pu.indexOf(t) !== -1, t); });
  assert.strictEqual(html.split('gallery_man03_1200.webp').length - 1, 1, '同じ写真の大きな重複掲載をしない');
  assert.ok(pu.indexOf('身体表現・筋肉撮影') !== -1);
  assert.doesNotMatch(pu, /人物の作例は現在掲載|利用できる用途の説明です|撮影代行|カメラ操作|撮影指導|無料|常駐|予約不要|私服|カップル|レザー/, '素材事情の注記・未確認条件を置かない');
  assert.doesNotMatch(pu, /緊縛・フェチ/, 'ユニフォームだけで緊縛・フェチ撮影と決めつけない');
  assert.match(read('styles/mens-preview-633.css'), /\.pv-scene--portrait \{ grid-template-columns: minmax\(0, 1\.2fr\) minmax\(0, 1fr\); \}/);
});
test('#653: 背景バリエーションはグランジ背景と和柄2枚の静的な3枚一覧で、Scenesに単独掲載せず、切替対象にしない', function () {
  var html = read('mens/preview-633.html');
  var m = html.match(/<ul class="pv-backdrops">[\s\S]*?<\/ul>/)[0];
  assert.deepStrictEqual((m.match(/images\/([^"]+)"/g) || []).map(function (x) { return x.slice(7, -1); }), ['pattern-tsuru-black_1200.webp', 'pattern-asanoha-indigo_1200.webp', 'backdrop-tiedye-gray_1200.webp']);
  assert.ok((m.match(/width="675" height="1200"/g) || []).length === 3 && (m.match(/pv-photo is-portrait/g) || []).length === 3, '3枚とも同じ写真枠');
  assert.ok(m.indexOf('<figcaption>グランジ背景</figcaption>') !== -1 && m.indexOf('alt="グレーの濃淡とムラのあるグランジ背景"') !== -1);
  assert.strictEqual((m.match(/class="gallery-image cursor-pointer"/g) || []).length, 3, '写真拡大を維持');
  assert.ok(html.indexOf('背景バリエーション / Backdrop Variations') < html.indexOf('<ul class="pv-backdrops">'));
  assert.strictEqual(html.split('backdrop-tiedye-gray_1200.webp').length - 1, 1, 'Scenes／ポートレート紹介に単独掲載しない');
  assert.doesNotMatch(m, /data-pv-/, '背景一覧は写真切替の対象にしない');
  var css = read('styles/mens-preview-633.css');
  assert.match(css, /\.pv-backdrops \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
});
test('#651: 固定ヘッダー対策は main.js の scrollPaddingTop 同期に任せ、試作CSSで二重の余白を作らない', function () {
  assert.match(read('scripts/main.js'), /scrollPaddingTop/);
  var css = read('styles/mens-preview-633.css');
  var margins = css.match(/scroll-margin-top/g) || [];
  assert.strictEqual(margins.length, 2, 'fallbackのscroll-margin-topはPC・SPの各1行だけ');
  assert.ok(css.indexOf(':is(#usage, #scenes, #costume-portrait-use, #classroom-use, #portrait-use, #group-use') !== -1, '#653: 新設アンカーにもJS無効時のfallback');
  (css.match(/^.*scroll-margin-top.*$/gm) || []).forEach(function (l) { assert.ok(l.indexOf('html:not([style*="scroll-padding-top"])') !== -1, 'main.jsの同期が効いているときは加算しない: ' + l); });
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, '').split('[style*="scroll-padding-top"]').join(''), /scroll-padding/, 'scroll-padding-top を試作CSSで設定しない');
});
test('#651: 法的事項は 料金 → 安全ガイド → 法的事項 の順で、PRIVATEに防犯カメラ告知と #legal リンクを残す', function () {
  var html = read('mens/preview-633.html');
  var i = ['id="pricing"', 'id="safety"', 'id="legal"'].map(function (k) { return html.indexOf(k); });
  assert.ok(i[0] > 0 && i[0] < i[1] && i[1] < i[2], '案Bの順序');
  assert.ok(i[2] > html.indexOf('id="gallery"'), '緊縛設備・作例より上部に置かない');
  var sec = html.match(/<section id="legal">[\s\S]*?<\/section>/)[0];
  ['18歳以上（高校生不可）', 'キャンセル：前日50% ／ 当日100%', '飲酒後の緊縛・吊り・撮影・パフォーマンスは禁止', '性的行為および性的行為を伴う撮影は禁止', '防犯カメラ設置（無人運営・安全確認用途）', '/mens/legal/'].forEach(function (t) { assert.ok(sec.indexOf(t) !== -1, t); });
  var about = html.match(/<section id="about-page"[\s\S]*?<\/section>/)[0];
  assert.ok(about.indexOf('防犯カメラを設置しています') !== -1 && about.indexOf('href="#legal"') !== -1 && about.indexOf('場所と設備を貸し出すレンタルスペースです') !== -1, 'PRIVATEの短い告知');
  assert.strictEqual(html.indexOf('id="legal" class'), -1);
});
test('#651: 歓迎説明はPRIVATEの1か所に集約し、特徴欄に重複させず、限定的な表現にしない', function () {
  var html = read('mens/preview-633.html');
  assert.strictEqual(html.split('ゲイ・バイ男性を含む、男性同士の撮影・練習を歓迎しています。').length - 1, 1);
  assert.strictEqual(html.split('ゲイ・バイ').length - 1, 1, '他の箇所にゲイ・バイの歓迎文を繰り返さない');
  var about = html.match(/<section id="about-page"[\s\S]*?<\/section>/)[0];
  assert.ok(about.indexOf('性別・性的指向を問わずご利用いただけます。') !== -1, '既存の利用方針を保持');
  assert.doesNotMatch(html, /ゲイ限定|男性専用/);
  var feat = html.match(/<section id="features">[\s\S]*?<\/section>/)[0];
  assert.strictEqual((feat.match(/<div class="feature-card">/g) || []).length, 4);
  assert.doesNotMatch(feat, /歓迎|完全個室・無人入室/);
});
test('#651/#653: ヒーロー衣装写真は衣装の作例として Scenes に置き、素材事情の注記・「人物なし」等の分類表記を本文に残さない', function () {
  var html = read('mens/preview-633.html');
  var scenes = html.match(/<section class="pv-uniform" id="scenes">[\s\S]*?<\/section>/)[0];
  var gallery = html.match(/<section id="gallery">[\s\S]*?<\/section>/)[0];
  assert.ok(scenes.indexOf('hero_mens_1200.webp') !== -1 && scenes.indexOf('ヒーロー衣装の作例（白背景）') !== -1);
  assert.strictEqual(gallery.indexOf('hero_mens_1200.webp'), -1);
  assert.strictEqual(gallery.indexOf('筋肉'), -1, '筋肉撮影の見出しをギャラリーの作例見出しにしない');
  assert.ok(scenes.indexOf('身体表現・筋肉撮影') !== -1, '用途自体は削除しない');
  var body = html.replace(/<script[\s\S]*?<\/script>/g, '');
  ['人物なし', '空間写真', '人物の作例は現在掲載', '利用できる用途の説明です', '現在は作例を掲載していません'].forEach(function (t) { assert.strictEqual(body.indexOf(t), -1, '注記を残さない: ' + t); });
  assert.ok(scenes.indexOf('スポーツウェア撮影') !== -1 && scenes.indexOf('フェティッシュ衣装の作品撮り') !== -1, '用途の見出しは維持');
  assert.strictEqual(html.indexOf('追加候補'), -1, '内部向けラベルを表示しない');
  assert.ok(html.indexOf('背景バリエーション / Backdrop Variations') !== -1);
  assert.ok(html.indexOf('alt="白背景で撮影した男性モデルのヒーローコスチューム作例"') !== -1, '既存altを推測で書き換えない');
  assert.ok(html.indexOf('alt="学校机と黒板のある撮影スペース"') !== -1 && html.indexOf('<figcaption>学校机と黒板のある空間</figcaption>') !== -1);
});
test('#651: 少人数利用は 見出し→楽しみ方→人数→相談CTA→利用条件 の順で、必要な告知を保持する', function () {
  var html = read('mens/preview-633.html');
  var g = html.match(/<div class="pv-group" id="group-use">[\s\S]*?<\/section>/)[0];
  var order = ['pv-group-title', 'pv-group-lead', '1〜4名。5名以上', 'mens_group', '18歳以上であること', '宴会・飲み会目的ではご利用いただけません', 'href="#safety"'].map(function (k) { return g.indexOf(k); });
  assert.ok(order.every(function (x) { return x > 0; }));
  assert.deepStrictEqual(order.slice().sort(function (a, b) { return a - b; }), order);
});
test('#651: 現行トップ・共通資産を変更せず、用途ナビの文言を現行トップへ入れない', function () {
  var cur = read('mens/index.html');
  ['pv-usenav', 'portrait-use', '用途から探す', '空間写真'].forEach(function (k) { assert.strictEqual(cur.indexOf(k), -1, k); });
});
