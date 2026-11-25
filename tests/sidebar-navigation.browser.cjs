/* Optional real-app regression: install Playwright, then run this script with
 * PASEO_UI_URL pointing to a daemon-served app and PASEO_UI_FIXTURE pointing to
 * a local JSON fixture. Use three visible Chats from one Bot and one from another:
 * {"botLabel":"Example Bot","chats":[{"botId":"example","agentId":"chat-a","title":"Chat A"},
 * {"botId":"example","agentId":"chat-b","title":"Chat B"},
 * {"botId":"example","agentId":"chat-c","title":"Chat C"}],
 * "crossChat":{"botId":"other","agentId":"chat-d","title":"Chat D"}}
 * Pick unique Chat titles and a list long enough to scroll 400px, with these rows
 * visible at that position. Keep fixture data and output outside the repository.
 * PASEO_UI_BUNDLE optionally previews a host-compiled candidate in this browser
 * only. No plugin/settings writes, prompts or daemon title mutations occur.
 */
const fs=require('node:fs'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const output=process.env.PASEO_UI_EVIDENCE;
if(output)fs.mkdirSync(output,{recursive:true});
const bundle=process.env.PASEO_UI_BUNDLE&&fs.readFileSync(process.env.PASEO_UI_BUNDLE,'utf8');
assert.ok(process.env.PASEO_UI_FIXTURE,'Set PASEO_UI_FIXTURE to a local fixture JSON file');
const fixture=JSON.parse(fs.readFileSync(process.env.PASEO_UI_FIXTURE,'utf8'));
assert.equal(fixture.chats?.length,3,'Provide three Chats from one Bot');
const [a,b,c]=fixture.chats.map(chat=>({...chat})),cross=fixture.crossChat;
for(const chat of [a,b,c,cross])for(const key of ['botId','agentId','title'])assert.ok(typeof chat?.[key]==='string'&&chat[key],`Missing ${key}`);
assert.ok(fixture.botLabel&&a.botId===b.botId&&a.botId===c.botId&&cross.botId!==a.botId,'Provide a botLabel and a different Bot for crossChat');
const crossTitle=cross.title,originalATitle=a.title;
const result={preview:!!bundle,viewport:{width:1708,height:1227},steps:[],bundleReplacements:0};
const cache=new Map(),overlays=new Map();let browser,clientSocket,page;const sockets=new Set();
(async()=>{
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN,args:['--no-sandbox']});
 page=await browser.newPage({viewport:result.viewport});page.setDefaultTimeout(15000);
 const trace=[];result.trace=trace;page.on('console',m=>{if(m.text().startsWith('SIDEBARTRACE ')){try{trace.push(JSON.parse(m.text().slice(13)))}catch{}}});if(process.env.PASEO_UI_TRACE_SCRIPT)await page.addInitScript({path:process.env.PASEO_UI_TRACE_SCRIPT});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket(/\/ws(?:[/?]|$)/,ws=>{
  clientSocket=ws;sockets.add(ws);const server=ws.connectToServer();ws.onClose(()=>{sockets.delete(ws);server.close()});server.onClose(()=>{sockets.delete(ws);ws.close()});
  server.onMessage(message=>{
   let body;try{body=JSON.parse(message.toString())}catch{ws.send(message);return}
   function visit(v){
    if(!v||typeof v!=='object')return;
    if(bundle&&v.id==='paseo-bots'&&'clientBundleHash'in v){v.clientBundle=bundle;v.clientBundleHash=crypto.createHash('sha256').update(bundle).digest('hex');result.bundleReplacements++}
    if(v.id&&v.provider&&v.cwd&&v.labels){cache.set(v.id,{...v});if(overlays.has(v.id)){v.title=overlays.get(v.id);result.overlayApplications=(result.overlayApplications||0)+1}}
    for(const child of Object.values(v))if(typeof child==='object')visit(child);
   }visit(body);ws.send(JSON.stringify(body));
  });ws.onMessage(message=>server.send(message));
 });
 await page.goto(process.env.PASEO_UI_URL||'http://localhost:6767/');
 await page.getByText('Bots',{exact:true}).first().click();
 const find=()=>page.getByPlaceholder('Find bots…').filter({visible:true});await find().waitFor();
 const surfaceURL=new URL(page.url());surfaceURL.pathname=surfaceURL.pathname.replace(/\/surface\/[^/]+$/,'/surface/bot-chat');
 const link=item=>{const url=new URL(surfaceURL);url.search=new URLSearchParams({'param.botId':item.botId,'param.chatId':item.agentId,'param.title':fixture.botLabel}).toString();return url.href};
 const visibleText=title=>page.getByText(title,{exact:true}).filter({visible:true});
 const row=title=>page.getByRole('button',{name:new RegExp('^'+title.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+',')}).filter({visible:true});
 async function selected(item){
  await page.waitForURL(url=>url.searchParams.get('param.chatId')===item.agentId);
  await visibleText(item.title).nth(1).waitFor();
  assert.equal(new URL(page.url()).searchParams.get('param.chatId'),item.agentId);
 }
 const scroll=()=>page.locator('[data-testid="bots-chat-list"]:visible').first();
 const metrics=async()=>scroll().evaluate(node=>{
  const top=node.getBoundingClientRect().top;
  const rows=Array.from(node.querySelectorAll('[data-testid^="bot-group-"],[data-testid^="bot-chat-"]')).filter(r=>r.getBoundingClientRect().bottom>top);
  const anchor=rows.filter(r=>r.getBoundingClientRect().top<=top+1).at(-1)||rows[0];
  return {offset:node.scrollTop,anchor:anchor?{id:anchor.getAttribute('data-testid'),inset:anchor.getBoundingClientRect().top-top}:null};
 });
 async function waitOffset(y){await page.waitForFunction(y=>{const n=Array.from(document.querySelectorAll('[data-testid="bots-chat-list"]')).find(n=>n.getBoundingClientRect().width>0&&n.getBoundingClientRect().height>0);return n&&Math.abs(n.scrollTop-y)<1},y,{timeout:10000})}
 async function snapshot(name,item){const state={name,url:page.url(),...(await metrics()),...(item?{selectedChat:item.agentId,selectedTitle:item.title}:{})};result.steps.push(state);if(output)await scroll().screenshot({path:output+'/'+name+'.png'});return state}
 async function click(item,offset=400){await row(item.title).click();await selected(item);await waitOffset(offset);return snapshot('switch-'+result.steps.length,item)}
 // Selecting B must update the current Chat address as well as the visible panel.
 await page.goto(link(a));await selected(a);await find().waitFor();await scroll().evaluate(n=>n.scrollTop=400);await waitOffset(400);
 const baseline=await snapshot('deep-link-A',a);
 await row(b.title).click();await visibleText(b.title).nth(1).waitFor();
 result.steps.push({name:'click-B-address',url:page.url(),expectedChat:b.agentId});
 assert.equal(new URL(page.url()).searchParams.get('param.chatId'),b.agentId,'Click B must update the current Chat address');
 await selected(b);await waitOffset(400);await snapshot('deep-link-A-to-B',b);
 await page.reload();await selected(b);await find().waitFor();await waitOffset(400);await snapshot('reload-still-B',b);
 // Direct links, browser history, and route-created lists use the same native navigation.
 await page.goto(link(a));await selected(a);await find().waitFor();await scroll().evaluate(n=>n.scrollTop=400);await waitOffset(400);
 await click(b);await page.goBack();await selected(a);await waitOffset(400);await snapshot('back-A',a);
 await page.goForward();await selected(b);await waitOffset(400);await snapshot('forward-B',b);
 await click(c);await click(a);await click(b);
 await row(crossTitle).click();await visibleText(crossTitle).nth(1).waitFor();
 assert.equal(new URL(page.url()).searchParams.get('param.botId'),cross.botId);await waitOffset(400);await snapshot('cross-Bot');
 await click(a);
 // Exercise background refresh with a fresh native SDK observation for the same current Chat.
 await page.reload();await selected(a);await find().waitFor();await waitOffset(400);await snapshot('background-observation-ready',a);
 // Deliver a real daemon agent snapshot with a title overlay to this browser only.
 // Its actual event consumer invalidates/refetches the list; refetch responses use the same overlay.
 assert.ok(cache.has(a.agentId),'Need the actual observed daemon snapshot for the background update');
 const updated=a.title+' (refresh test)';overlays.set(a.agentId,updated);
 result.socketsAtRefresh=sockets.size;for(const ws of sockets)ws.send(JSON.stringify({type:'session',message:{type:'agent_update',payload:{kind:'upsert',agent:{...cache.get(a.agentId),title:updated}}}}));
 await row(updated).waitFor();a.title=updated;assert.equal(new URL(page.url()).searchParams.get('param.chatId'),a.agentId);
 await waitOffset(400);const refreshed=await snapshot('background-title-refresh',a);
 assert.equal(refreshed.anchor.id,baseline.anchor.id);assert.ok(Math.abs(refreshed.anchor.inset-baseline.anchor.inset)<1);
 result.backgroundRefresh={mode:'browser-only title overlay on real agent_update + actual list refetch',daemonMutation:false};
 await find().fill(fixture.botLabel);await row(crossTitle).waitFor({state:'hidden'});await find().fill('');
 await page.emulateMedia({colorScheme:'dark'});await find().waitFor();await scroll().evaluate(n=>n.scrollTop=400);await waitOffset(400);await click(b);await snapshot('dark-chat-switch',b);
 // End the browser-only overlay before testing compact native navigation against unchanged daemon data.
 overlays.delete(a.agentId);a.title=originalATitle;
 await page.setViewportSize({width:390,height:844});
 // Returning through the browser history recovers the compact list without changing SDK navigation.
 const botsURL=new URL(surfaceURL);botsURL.pathname=botsURL.pathname.replace(/bot-chat$/,'bots');botsURL.search='';await page.goto(botsURL.href);await find().waitFor();
 await row(a.title).click();await page.waitForURL(url=>url.searchParams.get('param.chatId')===a.agentId);await find().waitFor({state:'hidden'});
 await visibleText(a.title).or(visibleText(updated)).first().waitFor(); // Wait for the selected Chat snapshot to populate the compact header.
 assert.equal(new URL(page.url()).searchParams.get('param.chatId'),a.agentId);
 result.compact={url:page.url(),listVisible:await find().isVisible()};if(output)await page.screenshot({path:output+'/compact.png'});
 result.errors=errors;assert.deepEqual(errors,[]);if(bundle)assert.ok(result.bundleReplacements>0);result.passed=true;
 console.log(JSON.stringify({passed:result.passed,steps:result.steps.map(s=>({name:s.name,offset:s.offset})),bundleReplacements:result.bundleReplacements,errors:result.errors,traceEvents:result.trace.length},null,2));
})().catch(async e=>{result.passed=false;result.error=String(e.stack);if(page){result.failure=await page.evaluate(()=>({url:location.href,lists:Array.from(document.querySelectorAll('[data-testid="bots-chat-list"]')).map(n=>({y:n.scrollTop,h:n.clientHeight,rect:n.getBoundingClientRect().toJSON(),ancestors:(()=>{let a=n,out=[];while(a){if(a.getAttribute('aria-hidden')||getComputedStyle(a).display==='none'||getComputedStyle(a).visibility==='hidden')out.push({hidden:a.getAttribute('aria-hidden'),display:getComputedStyle(a).display,visibility:getComputedStyle(a).visibility});a=a.parentElement}return out})()}))}));if(output)await page.screenshot({path:output+'/failure-viewport.png'})}console.error(result.error);process.exitCode=1})
.finally(async()=>{if(output)fs.writeFileSync(output+'/ui-result.json',JSON.stringify(result,null,2));if(browser)await browser.close()});
