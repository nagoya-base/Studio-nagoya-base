/* #660 手動選択4→表示写真を押下（数フレーム待機）→離す：作品4のまま拡大されることの確認。使い方: node check-photo-press.js <_site> */
const { chromium } = require('playwright'); const http=require('http'),fs=require('fs'),path=require('path'); const root=process.argv[2];
const srv=http.createServer((q,r)=>{let p=path.join(root,q.url.split('?')[0]);if(fs.existsSync(p)&&fs.statSync(p).isDirectory())p+='/index.html';if(!fs.existsSync(p)){r.writeHead(404);return r.end();}r.writeHead(200,{'content-type':{'.html':'text/html','.css':'text/css','.js':'text/javascript','.webp':'image/webp'}[path.extname(p)]||'application/octet-stream'});fs.createReadStream(p).pipe(r);}).listen(8771,async()=>{
const b=await chromium.launch();const pg=await b.newPage({viewport:{width:1280,height:800}});
await pg.goto('http://localhost:8771/mens/preview-633.html',{waitUntil:'networkidle'});
await pg.evaluate(async()=>{for(let y=0;y<document.body.scrollHeight;y+=600){scrollTo({top:y,behavior:'instant'});await new Promise(r=>setTimeout(r,30));}scrollTo({top:0,behavior:'instant'});await new Promise(r=>setTimeout(r,400));});
const g=await pg.evaluate(()=>document.querySelector('[data-pv-works]').getBoundingClientRect().top+scrollY);
await pg.evaluate(y=>scrollTo({top:y,behavior:'instant'}),g-128+100);await pg.waitForTimeout(200);
await pg.locator('[data-pv-work-caption]').nth(3).focus();await pg.waitForTimeout(200);
await pg.evaluate(y=>scrollTo({top:y,behavior:'instant'}),g-128+100);await pg.waitForTimeout(200);
const box=await pg.locator('.pv-work.is-current .pv-photo img').boundingBox();
await pg.mouse.move(box.x+box.width/2,box.y+box.height/2);await pg.mouse.down();await pg.waitForTimeout(300);
const during=await pg.evaluate(()=>[...document.querySelectorAll('[data-pv-work]')].findIndex(w=>w.classList.contains('is-current'))+1);
await pg.mouse.up();await pg.waitForTimeout(300);
console.log(JSON.stringify({duringPress:during,modalSrc:await pg.evaluate(()=>{const m=document.querySelector('.image-modal img');return m&&m.src.split('/').pop()})}));
await b.close();srv.close();});
