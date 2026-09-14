'use strict';

// Run in an isolated Electron renderer with fixture data and a controllable refresh clock.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {pathToFileURL, fileURLToPath} = require('node:url');
const {app, BrowserWindow} = require('electron');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'renderer');
const output = path.join(project, '.local', `town-library-ui-${randomUUID()}`);
const report = {checks: [], screenshots: [], scope: 'Offline native Scroll and Beings UI; no live account or network calls.'};
let win;
let remoteRequests = 0;
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor', '1');

async function execute(script) {
  assert.equal(win.webContents.getURL(), pathToFileURL(path.join(output, 'fixture.html')).href);
  return win.webContents.executeJavaScript(script);
}
async function settle() { await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); }
async function check(name, script) {
  await settle();
  const passed = await execute(script);
  report.checks.push({name, passed: passed === true});
  assert.equal(passed, true, name);
  process.stdout.write(`${name}: passed\n`);
}
async function capture(name) {
  await settle();
  const target = path.join(output, `${name}.png`);
  await fs.writeFile(target, (await win.webContents.capturePage()).toPNG());
  report.screenshots.push(target);
}

async function run() {
  await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'fixture.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="${pathToFileURL(renderer + path.sep).href}"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="town-app.css"><link rel="stylesheet" href="town-library.css"><style>html,body{margin:0;width:100%;height:100%}#page-town-app{height:100vh;width:100vw}[hidden]{display:none!important}</style><script src="town-library.js" defer></script><script src="town-mentions.js" defer></script><script src="town-app.js" defer></script></head><body><main id="page-town-app"></main></body></html>`);
  await app.whenReady();
  win = new BrowserWindow({show: false, width: 1160, height: 850, useContentSize: true, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `library-${randomUUID()}`}});
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try { allowed = details.url.startsWith('file:') && fileURLToPath(details.url).startsWith(project + path.sep); } catch { /* Reject malformed URLs. */ }
    if (!allowed) remoteRequests++;
    callback({cancel: !allowed});
  });
  await win.loadFile(path.join(output, 'fixture.html'));
  await execute(String.raw`(async () => {
    window.fixture = {calls:{lists:[],reads:[],beings:0,cache:[]},cache:new Map(),timers:new Map(),clock:0,hidden:false};
    Object.defineProperty(document,'hidden',{get:()=>fixture.hidden,configurable:true});
    const nativeSet=window.setTimeout.bind(window),nativeClear=window.clearTimeout.bind(window);
    window.setTimeout=(fn,ms,...args)=>{if(ms!==60000)return nativeSet(fn,ms,...args);const id=++fixture.clock+100000;fixture.timers.set(id,fn);return id;};
    window.clearTimeout=id=>{if(fixture.timers.has(id))fixture.timers.delete(id);else nativeClear(id);};
    fixture.tick=()=>{const work=[...fixture.timers.values()];fixture.timers.clear();work.forEach(fn=>fn());};
    fixture.state={connection:{configured:true,status:'connected',beingName:'alice',displayUrl:'https://fixture.invalid/alice/'},townApp:{identity:{beingId:'alice',connectionRevision:1,identityRevision:1},access:{}}};
    fixture.scrolls=[{id:'doc1',title:'在 Town 留下一点光',beingId:'alice',beingName:'Alice',tags:['随笔'],visibility:'private',revision:1,updatedAt:'2026-09-07T09:00:00Z'},{id:'doc2',title:'旅途与笔记',beingId:'bob',beingName:'Bob',tags:['旅行'],visibility:'shared',revision:2},{id:'doc3',title:'第三个卷轴',beingId:'alice',beingName:'Alice',tags:[],visibility:'public',revision:1}];
    fixture.content='# 今天的记录\n\n晨光落在窗台上。🌱\n\n- 整理书架\n- 在 Town 看看朋友\n\n<img src=x onerror="window.injected=true">';
    fixture.content=Array.from(fixture.content+'\n\n'+'补充记录。\n'.repeat(2000)).slice(0,10000).join('');
    fixture.residents=[{id:'alice',name:'Alice',description:'在这里记录日常与灵感。',status:'online',human:{id:'lin',name:'小林'}},{id:'bob',name:'Bob',description:'喜欢阅读与探索。',human:null},{id:'charlie',name:'Charlie',human:{name:'阿澄'}}];
    fixture.bridge={getTownAppState:async()=>fixture.state.townApp,refreshTownApp:async()=>fixture.state.townApp,
      listScrolls:async value=>{fixture.calls.lists.push(value);return {scrolls:value.offset?fixture.scrolls.slice(2):fixture.scrolls.slice(0,2),total:3,offset:value.offset,limit:100,hasMore:value.offset===0};},
      getScroll:async value=>{fixture.calls.reads.push(value);const summary=fixture.scrolls.find(item=>item.id===value.id),tail='\n\n这是后续正文。',content=value.id==='doc1'?(value.offset?tail:fixture.content):'这里是 '+summary.title+' 的正文。';return {scroll:{...summary,content,offset:value.offset,limit:10000,nextOffset:value.offset+Array.from(content).length,totalLength:Array.from(value.id==='doc1'?fixture.content+tail:content).length,hasMore:value.id==='doc1'&&value.offset===0}};},
      listBeings:async()=>{fixture.calls.beings++;return {beings:fixture.residents,detail:'显示已公开的伙伴信息，缺失资料标为未公开。'};}};
    fixture.cacheKey=(method,value={})=>JSON.stringify([method==='listBeings'?'public':fixture.state.townApp.identity.beingId,method,value]);
    for(const method of ['listScrolls','getScroll','listBeings']){
      const live=fixture.bridge[method];
      fixture.bridge[method]=async(value={})=>{const key=fixture.cacheKey(method,value),data=await live(value);fixture.cache.set(key,{cached:true,data:structuredClone(data),lastSuccessAt:1700000000000});return data;};
    }
    fixture.bridge.getTownCachedData=async({method,value={}})=>{fixture.calls.cache.push({method,value});return structuredClone(fixture.cache.get(fixture.cacheKey(method,value))||{cached:false,data:null,lastSuccessAt:null});};
    fixture.liveLists=fixture.bridge.listScrolls;
    beingTownApp.init({bridge:fixture.bridge});beingTownApp.setState(fixture.state);await beingTownApp.open('scroll');
  })()`);
  await check('opening Scroll checks its cache and refreshes the list without reading documents', `document.getElementById('page-town-app').dataset.townModule==='scroll'&&fixture.calls.lists.length===1&&fixture.calls.reads.length===0&&fixture.calls.cache.some(item=>item.method==='listScrolls')&&fixture.timers.size===0&&!document.querySelector('.ta-library-scroll').hidden`);
  await execute(`(async()=>{await beingTownApp.open('scroll');fixture.state={...fixture.state,connection:{...fixture.state.connection,status:'disconnected'}};beingTownApp.setState(fixture.state);fixture.state={...fixture.state,connection:{...fixture.state.connection,status:'connected'},townApp:{...fixture.state.townApp,identity:{...fixture.state.townApp.identity,connectionRevision:2}}};beingTownApp.setState(fixture.state);await beingTownApp.open('scroll');})()`);
  await check('reopening and reconnecting Scroll refresh the cached list', `fixture.calls.lists.length===3&&fixture.calls.reads.length===0&&fixture.timers.size===0`);
  await execute(`document.getElementById('scroll-refresh').click()`);
  await check('explicit Scroll refresh reads only the searchable list', `document.querySelectorAll('[data-scroll-id]').length===2&&fixture.calls.lists.length===4&&fixture.calls.reads.length===0&&!document.getElementById('scroll-document').textContent.includes('晨光落在窗台上')`);
  await execute(`document.querySelector('[data-scroll-id="doc1"]').click()`);
  await check('selecting a Scroll explicitly reads its document', `fixture.calls.reads.length===1&&document.getElementById('scroll-document').textContent.includes('晨光落在窗台上')`);
  await check('document markup cannot execute or fetch remote resources', `!window.injected&&document.querySelector('.ta-library-document-body').textContent.includes('<img src=x')&&!document.querySelector('.ta-library-document-body img')&&document.querySelector('.ta-library-document-body h3').textContent==='今天的记录'`);
  await capture('scroll-desktop');
  await execute(`document.getElementById('scroll-content-more').click()`);
  await check('long documents continue at Unicode-aware offsets and retain the first page', `fixture.calls.reads.at(-1).offset===Array.from(fixture.content).length&&document.getElementById('scroll-document').textContent.includes('这是后续正文')&&document.getElementById('scroll-document').textContent.includes('晨光落在窗台上')&&!document.getElementById('scroll-content-more')`);
  await execute(`document.getElementById('scroll-load-more').click()`);
  await check('document listing loads subsequent pages', `fixture.calls.lists.at(-1).offset===2&&document.querySelectorAll('[data-scroll-id]').length===3&&document.getElementById('scroll-load-more').hidden`);
  await execute(`document.getElementById('scroll-refresh').click();document.querySelector('[data-scroll-id="doc1"]').click()`);
  await check('unchanged list and document refreshes retain loaded continuation pages', `document.querySelectorAll('[data-scroll-id]').length===3&&document.getElementById('scroll-load-more').hidden&&document.getElementById('scroll-document').textContent.includes('这是后续正文')&&!document.getElementById('scroll-content-more')`);
  await execute(`fixture.beforeSelectedReopen=fixture.calls.reads.length;fixture.beforeReopenRead=fixture.bridge.getScroll;fixture.bridge.getScroll=value=>new Promise(resolve=>{fixture.resolveReopenedDocument=async()=>resolve(await fixture.beforeReopenRead(value));});void beingTownApp.open('scroll')`);
  await check('reopening Scroll retains selected cached body while its body refresh is pending', `typeof fixture.resolveReopenedDocument==='function'&&document.getElementById('scroll-document').textContent.includes('这是后续正文')&&document.getElementById('scroll-document').getAttribute('aria-busy')==='true'`);
  await execute(`fixture.resolveReopenedDocument();fixture.bridge.getScroll=fixture.beforeReopenRead;void 0`);
  await check('reopening refreshes the selected body and retains unchanged continuation pages', `fixture.calls.reads.length===fixture.beforeSelectedReopen+1&&document.getElementById('scroll-document').textContent.includes('这是后续正文')&&!document.getElementById('scroll-content-more')&&document.getElementById('scroll-document').getAttribute('aria-busy')==='false'`);
  await execute(`fixture.originalRead=fixture.bridge.getScroll;fixture.bridge.getScroll=async()=>{throw new Error('正文网络中断');};document.querySelector('[data-scroll-id="doc1"]').click()`);
  await check('a failed document refresh preserves all previously loaded content', `document.getElementById('scroll-document').textContent.includes('这是后续正文')&&document.getElementById('scroll-document').textContent.includes('已保留上次读取的正文')`);
  await execute(`fixture.bridge.getScroll=fixture.originalRead;void 0`);
  await execute(`document.getElementById('scroll-search').value='旅行';document.getElementById('scroll-search').dispatchEvent(new Event('input'));document.querySelector('[data-scroll-id="doc2"]').click()`);
  await check('search by tag and select another document', `document.querySelectorAll('[data-scroll-id]').length===1&&document.getElementById('scroll-document').textContent.includes('旅途与笔记 的正文')&&document.getElementById('scroll-document').textContent.includes('共享')`);
  await execute(`document.getElementById('scroll-search').value='';document.getElementById('scroll-search').dispatchEvent(new Event('input'));fixture.savedRead=fixture.bridge.getScroll;fixture.bridge.getScroll=value=>new Promise(resolve=>{fixture.readResolvers??={};fixture.readResolvers[value.id]=resolve;});document.querySelector('[data-scroll-id="doc1"]').click()`);
  await check('reselecting a document restores all cached pages while its live refresh is pending', `document.getElementById('scroll-document').textContent.includes('晨光落在窗台上')&&document.getElementById('scroll-document').textContent.includes('这是后续正文')&&!document.getElementById('scroll-content-more')&&typeof fixture.readResolvers.doc1==='function'`);
  await execute(`document.querySelector('[data-scroll-id="doc2"]').click()`);
  await settle();
  await execute(`fixture.readResolvers.doc1({scroll:{...fixture.scrolls[0],content:'STALE DOCUMENT',offset:0,limit:10000,nextOffset:14,totalLength:14,hasMore:false}});fixture.readResolvers.doc2({scroll:{...fixture.scrolls[1],content:'LATEST DOCUMENT',offset:0,limit:10000,nextOffset:15,totalLength:15,hasMore:false}})`);
  await check('late document response cannot replace the selected document', `document.getElementById('scroll-document').textContent.includes('LATEST DOCUMENT')&&!document.getElementById('scroll-document').textContent.includes('STALE DOCUMENT')`);
  await execute(`fixture.bridge.getScroll=fixture.savedRead;beingTownApp.open('beings')`);
  await check('directory maps explicit human partners and marks missing ones', `document.querySelectorAll('article[data-being-id]').length===3&&document.querySelector('[data-being-id="alice"] .ta-library-human').textContent.includes('小林')&&document.querySelector('[data-being-id="bob"] .ta-library-human').textContent.includes('未公开')&&fixture.timers.size===1`);
  await capture('beings-desktop');
  await execute(`document.getElementById('beings-search').value='小林';document.getElementById('beings-search').dispatchEvent(new Event('input'))`);
  await check('directory is searchable by human partner', `document.querySelectorAll('article[data-being-id]').length===1&&document.querySelector('article[data-being-id]').dataset.beingId==='alice'`);
  await execute(`fixture.residents=[...fixture.residents,{id:'dora',name:'Dora',human:null}];fixture.beforeTick=fixture.calls.beings;fixture.tick()`);
  await check('60-second refresh updates the complete directory and preserves search', `fixture.calls.beings===fixture.beforeTick+1&&document.getElementById('beings-search').value==='小林'&&document.querySelector('.ta-library-beings .ta-library-count').textContent.includes('共 4 位')&&fixture.timers.size===1`);
  await execute(`fixture.savedBeings=fixture.bridge.listBeings;fixture.bridge.listBeings=async()=>{throw new Error('测试网络中断');};document.getElementById('beings-refresh').click()`);
  await check('failed refresh preserves prior residents and schedules retry', `document.querySelector('article[data-being-id="alice"]')!==null&&document.querySelector('.ta-library-beings').textContent.includes('已保留上次读取的名录')&&fixture.timers.size===1&&!document.getElementById('beings-refresh').disabled`);
  await execute(`fixture.bridge.listBeings=fixture.savedBeings;fixture.hidden=true;document.dispatchEvent(new Event('visibilitychange'))`);
  await check('automatic refresh pauses in a hidden document', `fixture.timers.size===0`);
  await execute(`fixture.hidden=false;document.dispatchEvent(new Event('visibilitychange'))`);
  await check('automatic refresh resumes when document becomes visible', `fixture.timers.size===1`);
  await execute(`document.getElementById('page-town-app').hidden=true`);
  await check('leaving Town module stops automatic refresh', `fixture.timers.size===0`);
  await execute(`(async()=>{document.getElementById('page-town-app').hidden=false;await beingTownApp.open('beings');fixture.bridge.listBeings=()=>new Promise(resolve=>{fixture.resolveOldBeing=resolve;});document.getElementById('beings-refresh').click();fixture.bridge.listBeings=fixture.savedBeings;fixture.state={...fixture.state,connection:{...fixture.state.connection,status:'disconnected'}};beingTownApp.setState(fixture.state);fixture.resolveOldBeing({beings:[{id:'private-old',name:'OLD PRIVATE RESIDENT'}]});})()`);
  await check('public directory works disconnected and rejects an old pending result', `document.querySelectorAll('article[data-being-id]').length===4&&!document.querySelector('.ta-library-beings').textContent.includes('OLD PRIVATE RESIDENT')&&fixture.timers.size===1&&!document.getElementById('beings-refresh').disabled`);
  await execute(`fixture.bridge.listBeings=fixture.savedBeings;fixture.state={...fixture.state,connection:{...fixture.state.connection,status:'connected'},townApp:{...fixture.state.townApp,identity:{beingId:'alice',connectionRevision:2,identityRevision:1}}};beingTownApp.setState(fixture.state)`);
  await check('reconnect loads the current directory and resumes refresh', `document.querySelectorAll('article[data-being-id]').length===4&&fixture.timers.size===1`);
  win.setSize(700, 740); await settle();
  await capture('beings-narrow');
  await check('directory remains within a narrow viewport', `(()=>{const el=document.querySelector('.ta-library-beings'),r=el.getBoundingClientRect();return r.right<=innerWidth&&el.scrollWidth<=el.clientWidth+1&&document.getElementById('beings-refresh').getBoundingClientRect().right<=innerWidth;})()`);
  await execute(`fixture.beforeScrollOpen={lists:fixture.calls.lists.length,reads:fixture.calls.reads.length};beingTownApp.open('scroll')`);
  await check('switching back to Scroll refreshes its list without reading documents', `fixture.calls.lists.length===fixture.beforeScrollOpen.lists+1&&fixture.calls.reads.length===fixture.beforeScrollOpen.reads&&fixture.timers.size===0`);
  await execute(`document.getElementById('scroll-refresh').click()`);
  await capture('scroll-narrow');
  await check('Scroll reading panes remain inside a narrow viewport', `(()=>{const page=document.querySelector('.ta-library-scroll'),doc=document.getElementById('scroll-document');return page.scrollWidth<=page.clientWidth+1&&doc.getBoundingClientRect().right<=innerWidth&&document.getElementById('scroll-search').getBoundingClientRect().width>80;})()`);
  await execute(`fixture.bridge.getScroll=async value=>{fixture.calls.reads.push(value);return {scroll:{...fixture.scrolls[0],content:value.offset?'终':'',offset:value.offset,limit:10000,nextOffset:value.offset?10001:10000,totalLength:10001,hasMore:value.offset===0}};};document.querySelector('[data-scroll-id="doc1"]').click()`);
  await check('a sanitized empty page retains its continuation control', `document.getElementById('scroll-content-more')!==null&&document.getElementById('scroll-document').textContent.includes('当前页没有可显示的正文')`);
  await execute(`document.getElementById('scroll-content-more').click()`);
  await check('continuation advances beyond stripped control characters', `fixture.calls.reads.at(-1).offset===10000&&document.querySelector('.ta-library-document-body').textContent==='终'&&!document.getElementById('scroll-content-more')`);
  await execute(`fixture.bridge.getScroll=()=>new Promise(resolve=>{fixture.resolvePrivateDocument=resolve;});document.querySelector('[data-scroll-id="doc2"]').click()`);
  await settle();
  await execute(`fixture.beforeNewIdentity=fixture.calls.lists.length;fixture.bridge.listScrolls=value=>{fixture.calls.lists.push(value);return new Promise(resolve=>{fixture.resolveNewList=resolve;});};fixture.state={...fixture.state,connection:{...fixture.state.connection,beingName:'newbeing',displayUrl:'https://fixture.invalid/newbeing/'},townApp:{...fixture.state.townApp,identity:{beingId:'newbeing',connectionRevision:3,identityRevision:2}}};beingTownApp.setState(fixture.state);fixture.resolvePrivateDocument({scroll:{...fixture.scrolls[1],content:'OLD PRIVATE DOCUMENT',offset:0,limit:10000,nextOffset:20,totalLength:20,hasMore:false}})`);
  await check('switching identity clears private Scroll data and rejects the prior result', `document.querySelectorAll('[data-scroll-id]').length===0&&!document.getElementById('scroll-document').textContent.includes('OLD PRIVATE DOCUMENT')&&!document.getElementById('scroll-document').textContent.includes('旅途与笔记')&&document.getElementById('scroll-search').value===''`);
  await check('changing identity refreshes only the current Being Scroll listing', `fixture.calls.lists.length===fixture.beforeNewIdentity+1&&typeof fixture.resolveNewList==='function'&&document.getElementById('scroll-refresh').disabled`);
  await execute(`fixture.resolveNewList({scrolls:[],total:0,offset:0,limit:100,hasMore:false})`);
  await check('new identity receives its own empty Scroll listing', `document.querySelector('.ta-library-scroll-list').textContent.includes('还没有卷轴')&&!document.getElementById('scroll-refresh').disabled`);
  await execute(`fixture.savedCache=fixture.bridge.getTownCachedData;fixture.bridge.getTownCachedData=request=>request.method==='listScrolls'&&request.value.offset===0?new Promise(resolve=>{fixture.resolveListCache=resolve;}):fixture.savedCache(request);fixture.beforeCachedOpen=fixture.calls.lists.length;fixture.state={...fixture.state,connection:{...fixture.state.connection,beingName:'alice',displayUrl:'https://fixture.invalid/alice/'},townApp:{...fixture.state.townApp,identity:{beingId:'alice',connectionRevision:4,identityRevision:3}}};fixture.cache.get(fixture.cacheKey('listScrolls',{offset:2,limit:100})).lastSuccessAt=1700000000001;beingTownApp.setState(fixture.state)`);
  await check('restoring Scroll after state reset waits for persisted cache before live requests', `fixture.calls.lists.length===fixture.beforeCachedOpen&&typeof fixture.resolveListCache==='function'&&document.querySelectorAll('[data-scroll-id]').length===0`);
  await execute(`fixture.resolveListCache(fixture.cache.get(fixture.cacheKey('listScrolls',{offset:0,limit:100})))`);
  await check('persisted list pages render before a held live refresh completes', `document.querySelectorAll('[data-scroll-id]').length===3&&document.getElementById('scroll-load-more').hidden&&fixture.calls.lists.length===fixture.beforeCachedOpen+1&&document.getElementById('scroll-refresh').disabled`);
  await execute(`fixture.bridge.getTownCachedData=fixture.savedCache;fixture.resolveNewList({scrolls:fixture.scrolls.slice(0,2),total:3,offset:0,limit:100,hasMore:true})`);
  await check('unchanged live response preserves restored list pages', `document.querySelectorAll('[data-scroll-id]').length===3&&document.getElementById('scroll-load-more').hidden&&!document.getElementById('scroll-refresh').disabled`);
  await execute(`fixture.bridge.listScrolls=async()=>{throw new Error('列表网络中断');};document.getElementById('scroll-refresh').click()`);
  await check('failed list refresh retains persisted content', `document.querySelectorAll('[data-scroll-id]').length===3&&document.querySelector('.ta-library-scroll').textContent.includes('已保留上次读取的列表')`);
  await execute(`fixture.bridge.getScroll=fixture.originalRead;const key=fixture.cacheKey('getScroll',{id:'doc1',offset:10000,limit:10000}),saved=fixture.cache.get(key);fixture.cache.set(key,{...saved,data:{scroll:{...saved.data.scroll,revision:99,content:'WRONG CACHED REVISION'}}});fixture.bridge.getScroll=()=>new Promise(resolve=>{fixture.resolveRevisionRead=resolve;});document.querySelector('[data-scroll-id="doc1"]').click()`);
  await check('cached document continuation from a different revision is excluded', `document.getElementById('scroll-document').textContent.includes('晨光落在窗台上')&&!document.getElementById('scroll-document').textContent.includes('WRONG CACHED REVISION')&&document.getElementById('scroll-content-more')!==null`);
  await execute(`fixture.resolveRevisionRead({scroll:{...fixture.scrolls[0],revision:2,content:'新版正文',offset:0,limit:10000,nextOffset:4,totalLength:4,hasMore:false}})`);
  await check('a changed live document revision replaces the old cached content', `document.querySelector('.ta-library-document-body').textContent==='新版正文'&&!document.getElementById('scroll-content-more')`);
  await execute(`fixture.beforeDirectoryCache=fixture.calls.beings;fixture.bridge.listBeings=()=>{fixture.calls.beings++;return new Promise(resolve=>{fixture.resolveCachedBeingRefresh=resolve;});};void beingTownApp.open('beings')`);
  await check('directory restores persisted residents before its held live refresh', `fixture.calls.beings===fixture.beforeDirectoryCache+1&&document.querySelectorAll('article[data-being-id]').length===4&&document.getElementById('beings-refresh').disabled&&document.querySelector('.ta-library-sync').textContent.includes('2023')`);
  await execute(`fixture.resolveCachedBeingRefresh({beings:[...fixture.residents,{id:'fresh',name:'Fresh resident'}]})`);
  await check('directory replaces restored residents with the refreshed result', `document.querySelectorAll('article[data-being-id]').length===5&&document.querySelector('[data-being-id="fresh"]')!==null&&fixture.timers.size===1`);
  await execute(`fixture.bridge.getTownCachedData=request=>request.method==='listScrolls'?new Promise(resolve=>{fixture.resolveOldListCache=resolve;}):fixture.savedCache(request);fixture.bridge.listScrolls=fixture.liveLists;beingTownLibrary.hide();fixture.state={...fixture.state,townApp:{...fixture.state.townApp,identity:{beingId:'old-cache',connectionRevision:5,identityRevision:4}}};beingTownApp.setState(fixture.state);void beingTownApp.open('scroll')`);
  await settle();
  await execute(`fixture.bridge.getTownCachedData=fixture.savedCache;fixture.state={...fixture.state,townApp:{...fixture.state.townApp,identity:{beingId:'new-cache',connectionRevision:6,identityRevision:5}}};beingTownApp.setState(fixture.state);fixture.resolveOldListCache({cached:true,data:{scrolls:[{id:'private-cache',title:'OLD PRIVATE CACHE'}],total:1,offset:0,limit:100,hasMore:false},lastSuccessAt:1})`);
  await check('late cached list data cannot cross an identity change', `!document.querySelector('.ta-library-scroll').textContent.includes('OLD PRIVATE CACHE')&&!document.querySelector('[data-scroll-id="private-cache"]')&&document.querySelectorAll('[data-scroll-id]').length===2`);
  await execute(`fixture.bridge.listScrolls=value=>new Promise(resolve=>{fixture.pendingTimestampList={value,resolve};});fixture.state={...fixture.state,townApp:{...fixture.state.townApp,identity:{beingId:'alice',connectionRevision:7,identityRevision:6}}};const headKey=fixture.cacheKey('listScrolls',{offset:0,limit:100}),tailKey=fixture.cacheKey('listScrolls',{offset:2,limit:100});fixture.cache.get(headKey).lastSuccessAt=200;fixture.cache.get(tailKey).lastSuccessAt=100;beingTownApp.setState(fixture.state)`);
  await check('cold restoration excludes cached list pages older than the first page', `document.querySelectorAll('[data-scroll-id]').length===2&&!document.querySelector('[data-scroll-id="doc3"]')&&!document.getElementById('scroll-load-more').hidden&&fixture.pendingTimestampList.value.offset===0`);
  await execute(`fixture.pendingTimestampList.resolve({scrolls:fixture.scrolls.slice(0,2),total:3,offset:0,limit:100,hasMore:true})`);
  await settle();
  await execute(`document.getElementById('scroll-load-more').click()`);
  await check('loading more rejects an older cached page while its live request is pending', `document.querySelectorAll('[data-scroll-id]').length===2&&!document.querySelector('[data-scroll-id="doc3"]')&&fixture.pendingTimestampList.value.offset===2&&document.getElementById('scroll-load-more').disabled`);
  await execute(`fixture.pendingTimestampList.resolve({scrolls:fixture.scrolls.slice(2),total:3,offset:2,limit:100,hasMore:false})`);
  await check('fresh continuation data replaces the skipped stale cached page', `document.querySelectorAll('[data-scroll-id]').length===3&&document.getElementById('scroll-load-more').hidden`);
  await execute(`fixture.cache.get(fixture.cacheKey('listScrolls',{offset:2,limit:100})).lastSuccessAt=200;fixture.state={...fixture.state,townApp:{...fixture.state.townApp,identity:{beingId:'alice',connectionRevision:8,identityRevision:6}}};beingTownApp.setState(fixture.state)`);
  await check('equal cache timestamps cannot combine an old continuation with a newer first page', `document.querySelectorAll('[data-scroll-id]').length===2&&!document.querySelector('[data-scroll-id="doc3"]')&&!document.getElementById('scroll-load-more').hidden&&fixture.pendingTimestampList.value.offset===0`);
  await execute(`fixture.pendingTimestampList.resolve({scrolls:fixture.scrolls.slice(0,2),total:3,offset:0,limit:100,hasMore:true})`);
  assert.equal(remoteRequests, 0, 'Fixture may not request external resources');
}

run().then(() => {report.passed = true;}, error => {report.passed = false; report.error = error.stack; process.stderr.write(`${error.stack}\n`);}).finally(async () => {
  await fs.mkdir(output, {recursive: true});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`Report: ${path.join(output, 'report.json')}\n`);
  win?.destroy();
  app.exit(report.passed ? 0 : 1);
});

