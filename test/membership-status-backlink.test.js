/*
 * Issue #555: 会員資格確認ページ（/membership/status/）の戻り先をSNB / mens / Studio X別に保つ。
 * 実際の scripts/membership-status-origin.js をvmで実行して、3ブランド・直接アクセス・不正値・ワンタイムリンク経由を検証する。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

var ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

var NOW = Date.parse('2026-10-27T03:00:00Z');
var HREFS = { snb: '/Studio-nagoya-base/', mens: '/Studio-nagoya-base/mens/', 'studio-x': '/Studio-nagoya-base/studio-x/' };
var LABELS = { snb: '← Studio Nagoya Baseトップへ戻る', mens: '← 男性ポートレートページへ戻る', 'studio-x': '← Studio Xトップへ戻る' };

function makeLink() {
  var attrs = {
    href: HREFS.snb,
    'data-href-snb': HREFS.snb, 'data-label-snb': LABELS.snb,
    'data-href-mens': HREFS.mens, 'data-label-mens': LABELS.mens,
    'data-href-studio-x': HREFS['studio-x'], 'data-label-studio-x': LABELS['studio-x']
  };
  return {
    textContent: LABELS.snb,
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    setAttribute: function (k, v) { attrs[k] = v; },
    get href() { return attrs.href; }
  };
}

function makeStorage(initial, broken) {
  var data = Object.assign({}, initial || {});
  return {
    data: data,
    getItem: function (k) { if (broken) throw new Error('blocked'); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
    setItem: function (k, v) { if (broken) throw new Error('blocked'); data[k] = String(v); },
    removeItem: function (k) { if (broken) throw new Error('blocked'); delete data[k]; }
  };
}

/* ページ読み込みを再現: search/hashとストレージを与えてスクリプトを実行し、戻りリンクの最終状態を返す。 */
function visit(search, hash, storage, nowMs) {
  var link = makeLink();
  var sandbox = {
    document: { getElementById: function (id) { return id === 'membership-status-backlink' ? link : null; } },
    location: { search: search, hash: hash },
    localStorage: storage,
    Date: { now: function () { return nowMs === undefined ? NOW : nowMs; } }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(read('scripts/membership-status-origin.js'), sandbox, { filename: 'membership-status-origin.js' });
  return { href: link.href, text: link.textContent, storage: storage };
}

test('3ブランド: ?from=mens / ?from=studio-x / 指定なしで、戻り先と文言がブランド別になる', function () {
  var snb = visit('', '', makeStorage());
  assert.strictEqual(snb.href, HREFS.snb);
  assert.strictEqual(snb.text, LABELS.snb);
  var mens = visit('?from=mens', '', makeStorage());
  assert.strictEqual(mens.href, HREFS.mens);
  assert.strictEqual(mens.text, LABELS.mens);
  var sx = visit('?from=studio-x', '', makeStorage());
  assert.strictEqual(sx.href, HREFS['studio-x']);
  assert.strictEqual(sx.text, LABELS['studio-x']);
});

test('直接アクセス: パラメータなしはSNBトップ（保存値があっても#t=経路でなければ使わない）', function () {
  var stored = makeStorage({ snb_membership_status_from: JSON.stringify({ mens: NOW - 1000 }) });
  var r = visit('', '', stored);
  assert.strictEqual(r.href, HREFS.snb);
  assert.strictEqual(r.text, LABELS.snb);
});

test('不正値: 未知のブランド・外部URL・スキーム・パス風・大小違い・二重指定はSNBへフォールバック（open redirect不可）', function () {
  var bad = [
    '?from=evil', '?from=', '?from=https://evil.example/', '?from=//evil.example', '?from=javascript:alert(1)',
    '?from=/mens/', '?from=..%2F..%2F', '?from=MENS', '?from=mens%00', '?from=%E0%A4%A', '?from=snb', '?from[]=mens', '?x=1&from=studio-xx'
  ];
  bad.forEach(function (search) {
    var r = visit(search, '', makeStorage());
    assert.strictEqual(r.href, HREFS.snb, search);
    assert.strictEqual(r.text, LABELS.snb, search);
  });
  /* 不正値のときは保存値も消し、前回のブランドを引きずらない。 */
  var stored = makeStorage({ snb_membership_status_from: JSON.stringify({ mens: NOW }) });
  visit('?from=evil', '', stored);
  assert.strictEqual(stored.data.snb_membership_status_from, undefined);
});

test('hrefはデータ属性（自サイトパス）だけから決まり、URLパラメータの値は使われない', function () {
  var js = read('scripts/membership-status-origin.js');
  assert.ok(js.indexOf("getAttribute('data-href-' + brand)") !== -1);
  assert.strictEqual(/innerHTML|location\.href\s*=|location\.assign|location\.replace|window\.open/.test(js), false);
  ['mens', 'studio-x'].forEach(function (brand) {
    var r = visit('?from=' + brand, '', makeStorage());
    assert.strictEqual(r.href.indexOf('/Studio-nagoya-base/'), 0);
    assert.strictEqual(/^[a-z]+:|^\/\//i.test(r.href), false);
  });
});

test('ワンタイムリンク経由: ?from付きで要求した同じブラウザで#t=を開くとブランドを引き継ぐ。保存は期限付き・ブランド名のみ', function () {
  var storage = makeStorage();
  visit('?from=studio-x', '', storage); /* 会員案内 → 確認ページ（メール送信前） */
  assert.deepStrictEqual(JSON.parse(storage.data.snb_membership_status_from), { 'studio-x': NOW });

  var token = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
  var back = visit('', '#t=' + token, storage, NOW + 10 * 60 * 1000); /* メールのリンク（?fromなし） */
  assert.strictEqual(back.href, HREFS['studio-x']);
  assert.strictEqual(back.text, LABELS['studio-x']);
  assert.strictEqual(JSON.stringify(storage.data).indexOf(token), -1, 'トークンを保存しない');

  var mens = makeStorage();
  visit('?from=mens', '', mens);
  assert.strictEqual(visit('', '#t=' + token, mens, NOW + 60 * 1000).href, HREFS.mens);
});

test('ワンタイムリンク経由のフォールバック: 保存なし・期限切れ・破損・不正ブランド・ストレージ不可はSNB', function () {
  var token = '#t=A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
  assert.strictEqual(visit('', token, makeStorage()).href, HREFS.snb);
  var expired = makeStorage({ snb_membership_status_from: JSON.stringify({ mens: NOW }) });
  assert.strictEqual(visit('', token, expired, NOW + 2 * 60 * 60 * 1000 + 1).href, HREFS.snb);
  var future = makeStorage({ snb_membership_status_from: JSON.stringify({ mens: NOW + 99999 }) });
  assert.strictEqual(visit('', token, future).href, HREFS.snb);
  ['{not json', '[]', '"mens"', JSON.stringify({ brand: 'mens', savedAt: NOW }), JSON.stringify({ 'https://evil.example/': NOW }), JSON.stringify({ mens: 'x' })].forEach(function (raw) {
    assert.strictEqual(visit('', token, makeStorage({ snb_membership_status_from: raw })).href, HREFS.snb, raw);
  });
  assert.strictEqual(visit('?from=mens', token, makeStorage(undefined, true)).href, HREFS.mens, 'ストレージ不可でも?fromは効く');
  assert.strictEqual(visit('', token, makeStorage(undefined, true)).href, HREFS.snb);
  assert.strictEqual(visit('', token, null).href, HREFS.snb);
});

test('複数ブランドで確認が重なったら誤誘導せずSNB（Studio X→mensの順で開始→最初のメールを開く）。期限切れの側は無視', function () {
  var token = '#t=A1b2C3d4E5f6G7h8I9j0K1l2M3n4';
  var storage = makeStorage();
  visit('?from=studio-x', '', storage, NOW);
  visit('?from=mens', '', storage, NOW + 5 * 60 * 1000);
  var r = visit('', token, storage, NOW + 10 * 60 * 1000);
  assert.strictEqual(r.href, HREFS.snb);
  assert.strictEqual(r.text, LABELS.snb);
  assert.strictEqual(storage.data.snb_membership_status_from, undefined, '#t=を使ったら保存を破棄');

  /* 片方が期限切れなら、有効な1つだけが残るので引き継ぐ。 */
  var s2 = makeStorage();
  visit('?from=studio-x', '', s2, NOW);
  visit('?from=mens', '', s2, NOW + 3 * 60 * 60 * 1000);
  assert.strictEqual(visit('', token, s2, NOW + 3 * 60 * 60 * 1000 + 1000).href, HREFS.mens);

  /* 同じブランドを続けて開始しても曖昧ではない。 */
  var s3 = makeStorage();
  visit('?from=mens', '', s3, NOW);
  visit('?from=mens', '', s3, NOW + 1000);
  assert.strictEqual(visit('', token, s3, NOW + 2000).href, HREFS.mens);
});

test('ページ配線: 専用includeを使い、共通のsubpage_backlink_ja.html・本人確認/解約スクリプトは変更しない', function () {
  var html = read('membership/status/index.html');
  assert.ok(html.indexOf('membership_status_backlink_ja.html') !== -1);
  assert.strictEqual(html.indexOf('subpage_backlink_ja.html'), -1);
  assert.ok(html.indexOf('membership-status-origin.js') !== -1);
  assert.ok(html.indexOf('membership-status-origin.js') < html.indexOf('membership-status.js'));
  var inc = read('_includes/membership_status_backlink_ja.html');
  assert.ok(inc.indexOf('id="membership-status-backlink"') !== -1);
  assert.ok(inc.indexOf("'/mens/' | relative_url") !== -1 && inc.indexOf("'/studio-x/' | relative_url") !== -1);
  /* 共通includeはmensのみ分岐の既存仕様のまま。 */
  var shared = read('_includes/subpage_backlink_ja.html');
  assert.ok(shared.indexOf('studio-x') === -1);
  /* 本人確認フローは遷移元を一切扱わず、フラグメントのトークン処理を維持する。 */
  var status = read('scripts/membership-status.js');
  assert.ok(status.indexOf('replaceState') !== -1 && status.indexOf("/(?:^#|&)t=") !== -1);
  assert.strictEqual(/localStorage|from=/.test(status), false);
});

test('導線: mens / Studio Xの会員ページ・完了ページは ?from= 付きで確認ページへ、SNBは付けない', function () {
  assert.ok(/membership\/status\/' \| relative_url \}\}\{% if include\.brand == 'mens' or include\.brand == 'studio-x' %\}\?from=\{\{ include\.brand \}\}/.test(read('_includes/membership_prestart_ja.html')));
  assert.ok(read('mens/membership/index.html').indexOf('membership_prestart_ja.html brand="mens"') !== -1);
  assert.ok(read('studio-x/membership/index.html').indexOf('membership_prestart_ja.html brand="studio-x"') !== -1);
  assert.ok(read('mens/membership/complete.html').indexOf("relative_url }}?from=mens") !== -1);
  assert.ok(read('studio-x/membership/complete.html').indexOf("relative_url }}?from=studio-x") !== -1);
  assert.strictEqual(read('membership/index.html').indexOf('from='), -1);
  assert.strictEqual(read('membership/complete.html').indexOf('?from='), -1);
});
