/* #660 作品切替のscrollY計測。使い方: node measure-scroll.js <静的サイトroot> [画像出力dir]
   各ビューポートで 1pxずつ近い刻みでスクロールし、固定開始／各作品の切替／固定終了のscrollYと滞在距離を出す */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2], outDir = process.argv[3];
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); }
  const t = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[path.extname(p)] || 'application/octet-stream';
  r.writeHead(200, { 'content-type': t }); fs.createReadStream(p).pipe(r); }).listen(8767, async () => {
  const b = await chromium.launch();
  const vps = [[1280, 800], [1280, 900], [320, 568], [390, 844]];
  for (const [w, h] of vps) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: w < 800, hasTouch: w < 800 });
    const pg = await ctx.newPage();
    await pg.goto('http://localhost:8767/mens/preview-633.html', { waitUntil: 'networkidle' });
    /* 遅延読込・演出でレイアウトが動き終わるまで、ページ全体を一度なめて待つ */
    await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 30)); } scrollTo({ top: 0, behavior: 'instant' }); await new Promise(r => setTimeout(r, 500)); });
    const r = await pg.evaluate(async () => {
      const root = document.querySelector('[data-pv-works]');
      const photo = root.querySelector('.pv-photo');
      const works = [...root.querySelectorAll('[data-pv-work]')];
      const doc = el => el.getBoundingClientRect().top + scrollY;
      const nap = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const top = parseFloat(getComputedStyle(photo).top);
      const gridTop = doc(root), gridBottom = gridTop + root.offsetHeight;
      const ph = photo.getBoundingClientRect().height;
      const stickStart = gridTop - top, stickEnd = gridBottom - ph - top;
      const sw = {}; let last = -1;
      for (let y = Math.max(0, Math.floor(stickStart - 400)); y <= stickEnd + 400; y += 4) {
        scrollTo({ top: y, behavior: 'instant' }); await nap();
        const i = works.findIndex(w => w.classList.contains('is-current'));
        if (i !== last) { sw[i] = sw[i] === undefined ? y : sw[i]; last = i; }
      }
      return { H: innerHeight, svh: (() => { const d = document.createElement('div'); d.style.cssText = 'position:fixed;height:100svh'; document.body.appendChild(d); const v = d.offsetHeight; d.remove(); return v; })(), top, photoH: Math.round(ph), gridH: root.offsetHeight, stickStart: Math.round(stickStart), switches: sw, stickEnd: Math.round(stickEnd), hscroll: document.documentElement.scrollWidth > innerWidth };
    });
    const s = r.switches, ys = [r.stickStart, s[1], s[2], s[3], r.stickEnd];
    console.log(JSON.stringify({ vp: w + 'x' + h, ...r, dwell: { first: ys[1] - ys[0], second: ys[2] - ys[1], third: ys[3] - ys[2], fourth: ys[4] - ys[3] } }));
    if (outDir) {
      fs.mkdirSync(outDir, { recursive: true });
      const marks = [['0start', r.stickStart], ['1work1', r.stickStart + 40], ['2work2', s[1] + 40], ['3work3', s[2] + 40], ['4work4', s[3] + 40], ['5end', r.stickEnd], ['6after', r.stickEnd + 200]];
      for (const [n, y] of marks) { await pg.evaluate(y => scrollTo({ top: y, behavior: 'instant' }), y); await pg.waitForTimeout(700); await pg.screenshot({ path: path.join(outDir, `${w}x${h}-${n}.png`) }); }
    }
    await ctx.close();
  }
  await b.close(); srv.close();
});
