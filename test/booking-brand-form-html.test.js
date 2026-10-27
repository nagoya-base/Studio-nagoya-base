/*
 * Issue #561: Studio X予約フォームにSNB専用のOTP案内・緊縛用途が混入しないことを、
 * Jekyllビルド後の生成HTMLで検証する（Liquid分岐は scripts/booking-app.js のテストでは見えないため）。
 *
 * - Studio X / SNB / mens の日本語フォームと SNB英語版を1回ビルドして検査する。
 * - Jekyll（bundle exec）が使えない環境ではスキップする。CI（CI=true）ではスキップせず失敗にする。
 */
'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('node:fs');
var os = require('node:os');
var path = require('node:path');
var childProcess = require('node:child_process');

var ROOT = path.join(__dirname, '..');
var STUDIO_X_PURPOSES = [
  'コスプレ撮影', 'ポートレート撮影', 'セルフ撮影', '作品撮り', '商品・物撮り',
  '動画撮影', '衣装テスト', '着替え・荷物置き等の拠点利用', 'その他'
];
var ROPE = '緊縛・ロープ表現の自主練習';
var WORKSHOP = '講習会・ワークショップ';
var SNB_PURPOSES = [ROPE, 'コスプレ撮影', 'ポートレート撮影', 'セルフ撮影', '作品撮り', '商品・物撮り', '動画撮影', WORKSHOP, 'その他'];

function jekyllCommand() {
  var r = childProcess.spawnSync('bundle', ['exec', 'jekyll', '--version'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) return ['bundle', ['exec', 'jekyll']];
  var p = childProcess.spawnSync('bundle', ['info', 'jekyll', '--path'], { cwd: ROOT, encoding: 'utf8' });
  if (p.status === 0) {
    var exe = path.join(p.stdout.trim(), 'exe', 'jekyll');
    if (fs.existsSync(exe)) return ['bundle', ['exec', 'ruby', exe]];
  }
  return null;
}

var cmd = jekyllCommand();
var skipReason = cmd ? false : 'Jekyll (bundle exec) が利用できないためスキップ';
if (!cmd && process.env.CI) {
  test('Jekyllが利用できる（CIでは必須）', function () { assert.fail('CIでJekyllが利用できません'); });
}

var dest = null;
function build() {
  if (dest) return dest;
  dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snb-site-'));
  var r = childProcess.spawnSync(cmd[0], cmd[1].concat(['build', '--destination', dest, '--quiet']), { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'jekyll build failed: ' + r.stderr + r.stdout);
  return dest;
}
test.after(function () {
  if (dest) fs.rmSync(dest, { recursive: true, force: true });
});

function html(rel) { return fs.readFileSync(path.join(build(), rel), 'utf8'); }
function section(src, startMarker, endMarker) {
  var s = src.indexOf(startMarker);
  assert.ok(s >= 0, startMarker + ' not found');
  var e = src.indexOf(endMarker, s);
  assert.ok(e > s, endMarker + ' not found');
  return src.slice(s, e);
}
function emailHelp(src) { return section(src, 'id="ba-email-field"', 'id="ba-email-error"'); }
function purposeValues(src) {
  var sel = section(src, 'id="ba-purpose"', '</select>');
  var out = [], re = /<option value="([^"]*)"/g, m;
  while ((m = re.exec(sel))) out.push(m[1]);
  return out;
}

test('Studio X: メール補足は一般案内のみ。会員確認（OTP）欄は初期非表示（サーバーがOTPフェーズを返すまで出ない）で、SNB MEMBERの文言が出ない', { skip: skipReason }, function () {
  var src = html('studio-x/booking/index.html');
  var help = emailHelp(src);
  assert.ok(help.indexOf('予約の確定連絡を受け取れるメールアドレスをご入力ください。') >= 0);
  ['2026年12月1日', 'SNB MEMBER', '確認コード', '6桁'].forEach(function (w) {
    assert.ok(help.indexOf(w) === -1, 'メール補足に「' + w + '」が含まれる');
  });
  /* Issue #563: Studio Xも共通OTP基盤の欄を持つ。既定は台帳照合なので hidden のまま。 */
  assert.ok(/<fieldset[^>]*id="ba-member-verify-field"[^>]*\shidden/.test(src), 'OTP欄は初期非表示');
  var verify = section(src, 'id="ba-member-verify-field"', '</fieldset>');
  assert.ok(verify.indexOf('SNB') === -1 && verify.indexOf('会員料金') === -1, 'Studio XのOTP欄にSNB MEMBER・会員料金を出さない');
  assert.ok(verify.indexOf('会員限定のオプション・31〜90日先の先行予約') >= 0);
  var legend = section(src, 'class="ba-calendar-legend"', '</ul>');
  assert.ok(legend.indexOf('SNB') === -1 && legend.indexOf('会員は90日先まで') >= 0, 'カレンダー凡例にSNB MEMBERを出さない');
  assert.ok(src.indexOf('id="ba-test-credential-intake"') >= 0, 'テスト資格の取り込み（Studio Xの認証フェーズTEST用）');
});

test('Studio X: 利用目的は確定9項目のみ（緊縛・講習会なし、値とラベルが一致）', { skip: skipReason }, function () {
  var src = html('studio-x/booking/index.html');
  assert.deepStrictEqual(purposeValues(src), [''].concat(STUDIO_X_PURPOSES));
  var sel = section(src, 'id="ba-purpose"', '</select>');
  STUDIO_X_PURPOSES.forEach(function (p) {
    assert.ok(sel.indexOf('<option value="' + p + '">' + p + '</option>') >= 0, p);
  });
  assert.ok(sel.indexOf('緊縛') === -1 && sel.indexOf(WORKSHOP) === -1);
  STUDIO_X_PURPOSES.forEach(function (p) { assert.ok(p.length <= 200); }); /* GASは200文字以内の非空文字列 */
});

['booking/index.html', 'mens/booking/index.html'].forEach(function (rel) {
  test(rel + ': 既存のメール案内・OTP UI・利用目的が維持される', { skip: skipReason }, function () {
    var src = html(rel);
    var help = emailHelp(src);
    ['2026年12月1日以降', 'SNB MEMBER', '確認コード（6桁）'].forEach(function (w) {
      assert.ok(help.indexOf(w) >= 0, '「' + w + '」が消えている');
    });
    assert.ok(src.indexOf('id="ba-member-verify-field"') >= 0);
    assert.ok(src.indexOf('id="ba-member-code"') >= 0);
    assert.deepStrictEqual(purposeValues(src), [''].concat(SNB_PURPOSES));
  });
});

test('SNB英語版: 利用目的の内部値が日本語版SNBと一致し、緊縛用途も従来どおり', { skip: skipReason }, function () {
  var src = html('booking/en.html');
  assert.deepStrictEqual(purposeValues(src), [''].concat(SNB_PURPOSES));
  assert.ok(src.indexOf('id="ba-member-verify-field"') >= 0);
});

/* Issue #567: OTP成功カードはブランドごとに実際に使える特典だけを出す。 */
test('Issue #567 Studio X: 成功カードは会員確認完了・会員限定オプション・先行予約のみで、SNB固有の文言を含まない', { skip: skipReason }, function () {
  var src = html('studio-x/booking/index.html');
  var card = section(src, 'id="ba-member-success"', 'id="ba-member-code-send-row"');
  ['会員確認が完了しました', 'いつもありがとうございます。会員特典をご利用いただけます。', '会員限定オプション', '31〜90日先の先行予約', '60分間有効'].forEach(function (w) {
    assert.ok(card.indexOf(w) >= 0, w);
  });
  ['SNB', 'MEMBER', '会員料金', 'ペアパック', 'シャワー'].forEach(function (w) {
    assert.ok(card.indexOf(w) === -1, 'Studio Xの成功カードに「' + w + '」が混入');
  });
  assert.ok(src.indexOf('id="ba-confirm-member-row"') >= 0);
  assert.ok(card.indexOf('id="ba-member-confirmed"') >= 0 && card.indexOf('メールアドレスの確認が完了しました') >= 0, '会員資格を確認できない場合の中立表示がある');
});

['booking/index.html', 'mens/booking/index.html'].forEach(function (rel) {
  test('Issue #567 ' + rel + ': 成功カードはSNB MEMBERの確認完了と会員料金・会員限定特典・先行予約を示す', { skip: skipReason }, function () {
    var card = section(html(rel), 'id="ba-member-success"', 'id="ba-member-code-send-row"');
    ['SNB MEMBERの確認が完了しました', 'いつもありがとうございます。会員料金・会員特典・先行予約をご利用いただけます。', '会員料金', '会員限定特典', '31〜90日先の先行予約', '60分間有効'].forEach(function (w) {
      assert.ok(card.indexOf(w) >= 0, w);
    });
  });
});
