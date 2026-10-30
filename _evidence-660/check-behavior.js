/* #660 高速スクロール・逆方向・resize・手動選択・静的fallbackの確認。使い方: node check-behavior.js <静的サイトroot> */
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = process.argv[2];
const srv = http.createServer((q, r) => { let p = path.join(root, q.url.split('?')[0]); if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'content-type': { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp' }[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r); }).listen(8769, async () => {
  const b = await chromium.launch();
  async function open(opts, w = 1280, h = 800) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, ...opts });
    const pg = await ctx.newPage();
    await pg.goto('http://localhost:8769/mens/preview-633.html', { waitUntil: 'networkidle' });
    await pg.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => setTimeout(r, 30)); } scrollTo({ top: 0, behavior: 'instant' }); await new Promise(r => setTimeout(r, 400)); });
    return pg;
  }
  const cur = pg => pg.evaluate(() => [...document.querySelectorAll('[data-pv-work]')].findIndex(w => w.classList.contains('is-current')));
  const geo = pg => pg.evaluate(() => { const r = document.querySelector('[data-pv-works]'); const top = r.getBoundingClientRect().top + scrollY; return { top, h: r.offsetHeight, ph: document.querySelector('.pv-photo').getBoundingClientRect().height }; });
  const jump = (pg, y) => pg.evaluate(async y => { scrollTo({ top: y, behavior: 'instant' }); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); }, y);
  let pg = await open({});
  const g = await geo(pg), st = g.top - 128, en = g.top + g.h - g.ph - 128;
  const res = {};
  /* 高速フリック：切替区間を飛び越える大ジャンプでも、その位置の作品に追いつく */
  for (const [n, y] of [['jump→作品3の区間', st + 1200], ['jump→作品1へ戻る', st + 100], ['jump→固定終了後', en + 300], ['jump→作品2へ逆方向', st + 800], ['jump→固定直前', st - 600]]) { await jump(pg, y); res[n] = await cur(pg) + 1; }
  /* resize：高さ変更後も位置に合う作品 */
  await jump(pg, st + 1200); await pg.setViewportSize({ width: 1280, height: 900 }); await pg.waitForTimeout(200);
  const g2 = await geo(pg); res['resize 800→900 後の作品(固定開始から+1200)'] = (await jump(pg, g2.top - 128 + 1200), await cur(pg) + 1);
  /* 手動選択：キャプション4をクリック→位置は作品1のまま→スクロール操作（wheel）で位置判定へ復帰 */
  await jump(pg, g2.top - 128 + 100);
  await pg.locator('[data-pv-work-caption]').nth(3).click(); await pg.waitForTimeout(100);
  res['手動選択4'] = await cur(pg) + 1;
  await jump(pg, g2.top - 128 + 100); res['位置が作品1付近へ戻っても手動選択を保持'] = await cur(pg) + 1;
  await pg.mouse.wheel(0, 40); await pg.waitForTimeout(300);
  res['wheel後は位置判定へ復帰'] = await cur(pg) + 1;
  console.log(JSON.stringify(res, null, 1));
  /* 静的fallback：reduced-motion／JS無効では .is-active なし、行高さ・sticky・非表示なし */
  for (const [name, opts] of [['reduced-motion', { reducedMotion: 'reduce' }], ['JS無効', { javaScriptEnabled: false }]]) {
    const p = await (async () => { const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, ...opts }); const p = await ctx.newPage(); await p.goto('http://localhost:8769/mens/preview-633.html', { waitUntil: 'networkidle' }); return p; })();
    console.log(name, JSON.stringify(await p.evaluate(() => { const r = document.querySelector('[data-pv-works]'); const ph = [...r.querySelectorAll('.pv-photo')].map(x => getComputedStyle(x)); return { active: r.classList.contains('is-active'), gridH: r.offsetHeight, pos: ph[0].position, vis: ph.map(x => x.visibility).join(), rows: getComputedStyle(r).gridTemplateRows }; })));
  }
  await b.close(); srv.close();
});
