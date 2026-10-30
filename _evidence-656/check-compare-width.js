const {chromium}=require('playwright');const http=require('http'),fs=require('fs'),path=require('path');
const root=process.argv[2];
const srv=http.createServer((q,r)=>{let p=path.join(root,decodeURIComponent(q.url.split('?')[0]));if(fs.existsSync(p)&&fs.statSync(p).isDirectory())p+='/index.html';if(!fs.existsSync(p)){r.writeHead(404);return r.end();}
const t={'.html':'text/html','.css':'text/css','.js':'text/javascript','.webp':'image/webp','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'}[path.extname(p)]||'application/octet-stream';r.writeHead(200,{'content-type':t});fs.createReadStream(p).pipe(r);}).listen(8766,async()=>{
const b=await chromium.launch();
for(const variant of ['before','after']){for(const js of [true,false]){for(const w of [320,390,768,800,801,1280]){
const ctx=await b.newContext({viewport:{width:w,height:900},javaScriptEnabled:js});const pg=await ctx.newPage();
if(variant==='before')await pg.route('**/mens-preview-633.css*',r=>r.fulfill({path:process.argv[3],contentType:'text/css'}));
await pg.goto('http://localhost:8766/mens/preview-633.html');await pg.waitForTimeout(400);
const out=await pg.evaluate(async(js)=>{const c=document.querySelector('.pv-compare');c.scrollIntoView();
if(js){const tabs=[...c.querySelectorAll('.pv-compare-tab')];const ws=[];for(const t of tabs){t.click();await new Promise(r=>setTimeout(r,50));const cur=c.querySelector('.pv-compare-item.is-current');ws.push([t.textContent.trim(),Math.round(cur.getBoundingClientRect().width*10)/10,Math.round(cur.querySelector('.pv-photo').getBoundingClientRect().width*10)/10]);}return {enh:c.classList.contains('is-enhanced'),ws};}
return {enh:c.classList.contains('is-enhanced'),ws:[...c.querySelectorAll('.pv-compare-item')].map(i=>{const r=i.getBoundingClientRect();return [Math.round(r.width),Math.round(r.left)]}),hscroll:document.documentElement.scrollWidth>innerWidth};},js);
console.log(variant,js?'JS':'noJS',w,JSON.stringify(out));
if(variant==='after'&&js&&(w===320||w===390||w===800)){const t=await pg.$$('.pv-compare-tab');await t[4].click();await pg.waitForTimeout(100);await pg.locator('.pv-compare').screenshot({path:'/tmp/claude-0/-home-user-Studio-nagoya-base/28ae7405-2029-53dc-b055-e106bd89ae64/scratchpad/after-js-'+w+'-warm.png'});}
await ctx.close();}}}
await b.close();srv.close();});
