#!/usr/bin/env node
/*
 * 画像アセット棚卸し（Issue #852 Phase 1）。読み取り専用で、ファイルの移動・削除は一切しない。
 *
 * 対象: `images/` と `studio-x/images/` 配下の Git 管理画像（`git ls-files`）。
 * 各画像について path / bytes / format / 寸法 / Git blob SHA を取り、Git 管理下の全テキストファイルから
 * 参照箇所を横断検索する。
 *
 * 参照の解決ルール（ファイル名だけの一致で別ディレクトリの画像と取り違えないため）:
 *   - トークン中に `studio-x/images/<名前>` があれば studio-x/images 側。
 *   - 先頭 `/`・`http(s)://`・Liquid（`}}` / `baseurl`）を含むものは、サイトルート起点で `/images/` 以降を解決。
 *   - HTML / CSS / Markdown 内の相対パスは、そのファイルのディレクトリ起点で解決（`../images/x` 等）。
 *     ただし `_includes/` 内は include 先ページが不定なため、ルート起点・studio-x 起点の両方に一致すれば両方に計上。
 *   - JS / JSON / YAML / GAS 等のデータ内 `images/x` はサイトルート起点として扱う。
 *   - ディレクトリ無しのファイル名だけの言及は「名前のみ」として、同名画像が1件だけなら計上する。
 *   - URL エンコード（`%2F` 等）・クエリ（`?v=`）・フラグメントは除去して比較する。
 *
 * 使い方:
 *   node scripts/image-inventory-852.js          # Markdown 表を標準出力
 *   node scripts/image-inventory-852.js --json   # JSON を標準出力
 */
'use strict';

var childProcess = require('node:child_process');
var fs = require('node:fs');
var path = require('node:path');

var ROOT = path.join(__dirname, '..');
var IMAGE_DIRS = ['images/', 'studio-x/images/'];
var IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg|ico|avif)$/i;
var TEXT_EXT = /\.(html?|md|markdown|css|scss|js|mjs|cjs|gs|json|ya?ml|xml|txt|liquid|sh|toml)$/i;
var TEXT_BASENAMES = { 'Gemfile': true, '.gitignore': true, 'robots.txt': true };

function git(args, input) {
  return childProcess.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', input: input, maxBuffer: 64 * 1024 * 1024 });
}

function listTrackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function listImages(files) {
  var paths = files.filter(function (f) {
    return IMAGE_EXT.test(f) && IMAGE_DIRS.some(function (d) { return f.indexOf(d) === 0; }) &&
      fs.existsSync(path.join(ROOT, f));
  }).sort();
  /* blob SHA・bytes は作業ツリーの内容から計算する（HEAD 未反映の追加・差し替え・リネームも同じスナップショットで扱う）。 */
  var shas = paths.length ? git(['hash-object', '--stdin-paths'], paths.join('\n') + '\n').trim().split('\n') : [];
  return paths.map(function (f, idx) {
    var buf = fs.readFileSync(path.join(ROOT, f));
    var dim = readDimensions(buf, f);
    return {
      path: f,
      dir: path.posix.dirname(f),
      name: path.posix.basename(f),
      bytes: buf.length,
      sha: shas[idx],
      format: dim.format,
      width: dim.width,
      height: dim.height,
      refs: []
    };
  });
}

/* 依存パッケージ無しで主要形式のヘッダから寸法を読む（デコード可否の簡易確認も兼ねる）。 */
function readDimensions(buf, file) {
  var ext = path.extname(file).slice(1).toLowerCase();
  try {
    if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      var i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        var marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        var len = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { format: 'jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
      return { format: 'jpeg', width: null, height: null };
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      var chunk = buf.toString('ascii', 12, 16);
      if (chunk === 'VP8X') {
        return { format: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      }
      if (chunk === 'VP8 ') {
        return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (chunk === 'VP8L') {
        var b = buf.readUInt32LE(21);
        return { format: 'webp', width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
      }
      return { format: 'webp', width: null, height: null };
    }
    if (ext === 'svg') {
      var s = buf.toString('utf8');
      var vb = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(s);
      var w = /<svg[^>]*\swidth="([\d.]+)/.exec(s);
      var h = /<svg[^>]*\sheight="([\d.]+)/.exec(s);
      return { format: 'svg', width: w ? Number(w[1]) : vb ? Number(vb[1]) : null, height: h ? Number(h[1]) : vb ? Number(vb[2]) : null };
    }
  } catch (e) { /* 寸法不明として扱う */ }
  return { format: ext + '(?)', width: null, height: null };
}

function isTextFile(f) {
  return TEXT_EXT.test(f) || TEXT_BASENAMES[path.posix.basename(f)] === true;
}

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* 参照元の用途区分（Phase 2 で書き換え対象を洗い出すための粗い分類）。 */
function classifySource(f) {
  if (/^test\//.test(f)) return 'test';
  if (/^gas\//.test(f)) return 'gas';
  if (/^\.github\//.test(f)) return 'ci';
  if (/^docs\//.test(f) || /(^|\/)README\.md$/.test(f) || /^[A-Z_]+\.md$/.test(f)) return 'doc';
  if (/^_data\//.test(f)) return 'data';
  if (/^scripts\/image-inventory-852\.js$/.test(f)) return 'self';
  if (/\.css$/.test(f)) return 'css';
  if (/\.(js|mjs|cjs)$/.test(f)) return 'js';
  if (/sitemap\.xml$/.test(f)) return 'sitemap';
  if (/\.(html?|md)$/.test(f)) return 'page';
  return 'other';
}

function resolveToken(token, sourceFile) {
  var t = token;
  try { t = decodeURIComponent(t); } catch (e) { /* そのまま */ }
  t = t.replace(/[?#].*$/, '');
  var sx = t.lastIndexOf('studio-x/images/');
  if (sx !== -1) return ['studio-x/images/' + t.slice(sx + 'studio-x/images/'.length)];
  var isRooted = /^\//.test(t) || /^https?:/.test(t) || /\}\}|baseurl/.test(t);
  var isMarkup = /\.(html?|css|md)$/.test(sourceFile);
  if (isRooted) {
    var at = t.lastIndexOf('/images/');
    /* `{{ include.image_path }}/x.webp` のように Liquid 変数で場所が渡る場合はファイル名のみとして扱う。 */
    return at === -1 ? null : [t.slice(at + 1)];
  }
  /* ファイル名のみ。HTML / CSS では同じディレクトリへの相対パスとして解決し、データ等では名前で照合する。 */
  if (!/\//.test(t)) return isMarkup && !/^_includes\//.test(sourceFile) ? [path.posix.join(path.posix.dirname(sourceFile), t)] : null;
  if (/^_includes\//.test(sourceFile)) {
    var root = path.posix.normalize(t.replace(/^(\.\.\/)+/, ''));
    return [root, path.posix.normalize('studio-x/' + root)];
  }
  if (isMarkup) {
    return [path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), t))];
  }
  var at2 = t.lastIndexOf('images/');
  return at2 === -1 ? [] : [t.slice(at2)];
}

/*
 * 画像パスらしいトークン（画像拡張子で終わる文字列）を、棚卸し対象の有無と無関係に抽出してから解決する。
 * 削除・リネームで一覧から消えた画像への参照も、解決できない参照として unresolved に残すため。
 */
var TOKEN_RE = /(?:^|[^A-Za-z0-9_.%-])([^\s"'`()<>,\\]*?[A-Za-z0-9_%-]\.(?:png|jpe?g|webp|gif|svg|ico|avif))(?![A-Za-z0-9_-])/gi;
var SITE_URL_RE = /^https?:\/\/nagoya-base\.github\.io\//i;

function isInImageDirs(p) {
  return IMAGE_DIRS.some(function (d) { return p.indexOf(d) === 0; });
}

function scanReferences(images, files) {
  var byPath = {};
  var byName = {};
  images.forEach(function (img) {
    byPath[img.path] = img;
    (byName[img.name] = byName[img.name] || []).push(img);
  });
  var tracked = {};
  files.forEach(function (f) { tracked[f] = true; });
  var unresolved = [];
  files.forEach(function (f) {
    if (!isTextFile(f) || IMAGE_EXT.test(f)) return;
    var text;
    try { text = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (e) { return; }
    /* HTML コメント内の説明文（例: 「専用OGP: x.jpg」）は参照ではないため、行番号を保ったまま空白にする。 */
    if (/\.html?$/.test(f)) text = text.replace(/<!--[\s\S]*?-->/g, function (c) { return c.replace(/[^\n]/g, ' '); });
    var lines = text.split('\n');
    lines.forEach(function (line, idx) {
      TOKEN_RE.lastIndex = 0;
      var m;
      while ((m = TOKEN_RE.exec(line)) !== null) {
        var token = m[1];
        /* 他サイトの画像URLは対象外（自サイトの絶対URLだけを解決する）。 */
        if (/^[a-z]+:\/\//i.test(token) && !SITE_URL_RE.test(token)) continue;
        var name = path.posix.basename(token.replace(/[?#].*$/, ''));
        try { name = decodeURIComponent(name); } catch (e) { /* そのまま */ }
        var targets = resolveToken(token, f);
        var hit = [];
        var fallback = false;
        var candidates = byName[name] || [];
        if (targets === null) {
          if (candidates.length === 1) hit = [candidates[0]];
          else unresolved.push({ file: f, line: idx + 1, token: token, reason: candidates.length ? 'ambiguous-name' : 'unknown-name' });
        } else if (targets.length === 0) {
          /* images/ 以外を指すパス（例: studio-x/touch-icon.svg）。実在すれば対象外として扱う。 */
          var other = /\.(html?|css|md)$/.test(f) ? path.posix.normalize(path.posix.join(path.posix.dirname(f), token.replace(/[?#].*$/, ''))) : null;
          if (!(other && tracked[other]) && !candidates.length) {
            unresolved.push({ file: f, line: idx + 1, token: token, reason: 'outside-image-dirs' });
          } else if (candidates.length === 1 && !other) {
            hit = [candidates[0]];
            fallback = true;
          }
        } else {
          hit = targets.map(function (p) { return byPath[p]; }).filter(Boolean);
          /* テスト・スクリプト内の `images/x` は部分文字列検査のことが多いため、同名が1件なら名前で計上する。 */
          if (!hit.length && !/\.(html?|css|md)$/.test(f) && candidates.length === 1) {
            hit = [candidates[0]];
            fallback = true;
          }
          if (!hit.length && !targets.some(function (p) { return tracked[p] && !isInImageDirs(p); })) {
            /* images/ 外の実在ファイル（例: studio-x/index.html の touch-icon.svg）は画像切れとしない。 */
            unresolved.push({ file: f, line: idx + 1, token: token, reason: 'no-such-path' });
          }
        }
        hit.forEach(function (img) {
          img.refs.push({ file: f, line: idx + 1, kind: classifySource(f), nameOnly: targets === null || fallback });
        });
      }
    });
  });
  return unresolved;
}

function summarize(images) {
  var bySha = {};
  images.forEach(function (img) { (bySha[img.sha] = bySha[img.sha] || []).push(img.path); });
  images.forEach(function (img) {
    var kinds = {};
    img.refs.forEach(function (r) { if (r.kind !== 'self') kinds[r.kind] = (kinds[r.kind] || 0) + 1; });
    img.refKinds = kinds;
    img.sameContentAs = bySha[img.sha].filter(function (p) { return p !== img.path; });
    var stem = img.path.replace(/\.[^.]+$/, '');
    img.otherFormats = images.filter(function (o) {
      return o !== img && o.path.replace(/\.[^.]+$/, '') === stem;
    }).map(function (o) { return o.path; });
    var live = ['page', 'css', 'js', 'data', 'gas', 'sitemap', 'other'].some(function (k) { return kinds[k]; });
    img.status = live ? 'referenced' : (kinds.test || kinds.doc || kinds.ci) ? 'test-or-doc-only' : 'unreferenced';
  });
}

function formatKinds(k) {
  return Object.keys(k).sort().map(function (n) { return n + ':' + k[n]; }).join(' ') || '—';
}

function toMarkdown(images, unresolved) {
  var head = git(['rev-parse', 'HEAD']).trim();
  var total = images.reduce(function (s, i) { return s + i.bytes; }, 0);
  var out = [];
  out.push('<!-- generated by scripts/image-inventory-852.js at ' + head + ' -->');
  out.push('');
  out.push('- 件数: ' + images.length + ' / 合計 ' + total.toLocaleString('en-US') + ' bytes');
  out.push('');
  out.push('| path | bytes | format | 寸法 | blob SHA（先頭10桁） | 参照（区分:件数） | 機械判定 |');
  out.push('|---|---:|---|---|---|---|---|');
  images.forEach(function (i) {
    out.push('| `' + i.path + '` | ' + i.bytes.toLocaleString('en-US') + ' | ' + i.format + ' | ' +
      (i.width ? i.width + '×' + i.height : '?') + ' | `' + (i.sha || '').slice(0, 10) + '` | ' +
      formatKinds(i.refKinds) + ' | ' + i.status + ' |');
  });
  if (unresolved.length) {
    out.push('');
    out.push('未解決トークン:');
    unresolved.forEach(function (u) { out.push('- `' + u.file + ':' + u.line + '` `' + u.token + '` (' + u.reason + ')'); });
  }
  return out.join('\n') + '\n';
}

function run() {
  var files = listTrackedFiles();
  var images = listImages(files);
  var unresolved = scanReferences(images, files);
  summarize(images);
  return { images: images, unresolved: unresolved };
}

module.exports = {
  run: run,
  listTrackedFiles: listTrackedFiles,
  listImages: listImages,
  scanReferences: scanReferences,
  readDimensions: readDimensions,
  resolveToken: resolveToken
};

if (require.main === module) {
  var result = run();
  if (process.argv.indexOf('--json') !== -1) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  else process.stdout.write(toMarkdown(result.images, result.unresolved));
}
