/* #660 固定ヘッダー・予約バナー回避の確認（Jekyll通常ビルド）。使い方: node check-header.js <_site> <出力dir> */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2], out = process.argv[3];
const srv = http.createServer((q, r) => { let p = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p += '/index.html'; if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r); }).listen(8770, async () => {
  const b = await chromium.launch(); fs.mkdirSync(out, { recursive: true });
  for (const [w, h] of [[1280, 800], [1280, 900], [320, 568], [390, 844]]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: w < 800, hasTouch: w < 800 }); const pg = await ctx.newPage();
    await pg.goto('http://localhost:8770/mens/preview-633.html', { waitUntil: 'networkidle' });
    await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 30)); } scrollTo({ top: 0, behavior: 'instant' }); await new Promise(r => setTimeout(r, 400)); });
    const rows = [];
    for (let i = 0; i < 4; i++) {
      const r = await pg.evaluate(async i => {
        const root = document.querySelector('[data-pv-works]'), cap = root.querySelectorAll('[data-pv-work-caption]')[i], photo = root.querySelector('.pv-photo');
        const nav = document.querySelector('nav.site-nav'), ban = document.querySelector('.booking-fixed-banner');
        const fixedBottom = Math.max(...[nav, ban].filter(Boolean).map(e => { const s = getComputedStyle(e); return (s.position === 'fixed' || s.position === 'sticky') ? e.getBoundingClientRect().bottom : 0; }));
        const g = root.getBoundingClientRect().top + scrollY, ph = photo.getBoundingClientRect().height, top = parseFloat(getComputedStyle(photo).top);
        const y = g - top + i * innerHeight * 0.7 + innerHeight * 0.45; /* 作品i+1の区間の中ほど */
        scrollTo({ top: Math.max(y, g - top + 1), behavior: 'instant' }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
        const cur = [...root.querySelectorAll('[data-pv-work]')].findIndex(w => w.classList.contains('is-current'));
        const cp = cap.getBoundingClientRect(), pp = [...root.querySelectorAll('.pv-photo')][cur].getBoundingClientRect();
        return { work: cur + 1, fixedBottom: Math.round(fixedBottom), photoTop: Math.round(pp.top), photoBottom: Math.round(pp.bottom), capInView: cp.top >= 0 && cp.bottom <= innerHeight, capTop: Math.round(cp.top), photoClearOfHeader: pp.top >= fixedBottom, vh: innerHeight };
      }, i);
      rows.push(r); await pg.waitForTimeout(600); await pg.screenshot({ path: path.join(out, `${w}x${h}-work${i + 1}.png`) });
    }
    console.log(w + 'x' + h, JSON.stringify(rows));
    await ctx.close();
  }
  await b.close(); srv.close();
});
