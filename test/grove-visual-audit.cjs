'use strict';

// This hidden Electron fixture uses bundled UI files and the saved public catalog.
// It has no credentials and rejects every request outside its local fixture assets.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL, fileURLToPath} = require('node:url');
const {randomUUID, createHash} = require('node:crypto');
const {app, BrowserWindow} = require('electron');
const project = path.resolve(__dirname, '..');
const renderer = path.join(project, 'renderer');
const runRoot = path.join(project, '.local', `grove-visual-${randomUUID()}`);
app.setPath('userData', path.join(runRoot, 'profile'));
app.commandLine.appendSwitch('force-device-scale-factor', '1');
const report = {version: 1, scope: 'Offline public-catalog UI fixture. Check results are controlled fixtures, never installations.', checks: [], screenshots: [], geometry: []};
let win;
let forbiddenRequests = 0;
let frameSequence = 0;
let latestPaint;
function check(name, actual, detail) { report.checks.push({name, passed: Boolean(actual), ...(detail === undefined ? {} : {detail})}); process.stdout.write(`${name}: ${actual?'passed':'failed'}\n`); }
function isPassiveSvg(svg) {
  return /<svg\b/.test(svg) && /\bviewBox\s*=/.test(svg)
    && !/<(?:script|foreignObject|image|iframe|audio|video|animate\w*|set)\b|\son\w+\s*=|<!ENTITY|<!DOCTYPE|@import/i.test(svg)
    && ![...svg.matchAll(/(?:\b(?:xlink:)?href\s*=\s*["'])([^"']*)/gi)].some(match => !match[1].startsWith('#'))
    && ![...svg.matchAll(/url\(\s*["']?([^\s)'";]+)/gi)].some(match => !match[1].startsWith('#'));
}
function isCurrentAsset(relative) {
  return /^assets\/(?:brands\/(?:[a-zA-Z0-9_-]+\.svg|codex\.png)|kit-symbols\/[a-zA-Z0-9_-]+\.svg)$/.test(relative || '');
}
function isPng(bytes) { return bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])); }

async function execute(script) {
  assert.equal(win.webContents.getURL(), pathToFileURL(path.join(runRoot, 'fixture.html')).href);
  let timeout;
  try {
    return await Promise.race([win.webContents.executeJavaScript(script), new Promise((_, reject) => {timeout=setTimeout(()=>reject(new Error('Fixture script timed out: '+script.slice(0,250))),15000);})]);
  } finally {clearTimeout(timeout);}
}
async function settle() { await execute('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'); }
async function waitFor(expression) {
  return execute(`new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Fixture condition did not settle: '+${JSON.stringify(expression)})),5000);function next(){if(${expression}){clearTimeout(timer);return resolve(true);}requestAnimationFrame(next);}next();})`);
}
async function capture(name) {
  await execute("Promise.all([...document.querySelectorAll('img')].filter(image=>image.getClientRects().length).map(image=>{image.loading='eager';return image.decode().catch(()=>{});}))");
  await settle();
  const expected=await execute(`(()=>{const root=document.getElementById('page-town-app').getBoundingClientRect();const action=document.getElementById('grove-install');const a=action?.getBoundingClientRect();return {width:innerWidth,height:innerHeight,action:a?{x:a.x,y:a.y,width:a.width,height:a.height,primary:action.classList.contains('ta-primary')}:null,images:[...document.querySelectorAll('#page-town-app img')].filter(el=>el.getClientRects().length).map(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};}).filter(r=>r.x>=root.x&&r.y>=root.y&&r.x+r.width<=root.right&&r.y+r.height<=root.bottom)};})()`);
  let image,ready=false,lastValidHash='';
  for(let attempt=0;attempt<80&&!ready;attempt++) {
    // A paint queued before invalidate may still be stale. Require contrast
    // inside each icon; official monochrome logos need no chromatic pixels.
    const previous=frameSequence;
    const painted=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{win.webContents.removeListener('paint',listener);reject(new Error(`Offscreen paint timed out: ${name}`));},3000);
      const listener=()=>{if(frameSequence>previous){clearTimeout(timer);win.webContents.removeListener('paint',listener);resolve(latestPaint);}};
      win.webContents.on('paint',listener);
    });
    win.webContents.invalidate();image=await painted;
    const size=image.getSize();
    if(size.width===expected.width&&size.height===expected.height) {
      const bitmap=image.toBitmap();
      const iconsReady=expected.images.every(rect=>{
        const levels=[];
        for(let y=Math.ceil(rect.y+2);y<Math.floor(rect.y+rect.height-2);y++)for(let x=Math.ceil(rect.x+2);x<Math.floor(rect.x+rect.width-2);x++){
          const offset=(y*size.width+x)*4;
          levels.push(.0722*bitmap[offset]+.7152*bitmap[offset+1]+.2126*bitmap[offset+2]);
        }
        if(!levels.length)return false;
        levels.sort((a,b)=>a-b);
        return levels[Math.floor((levels.length-1)*.99)]-levels[Math.floor((levels.length-1)*.01)]>25;
      });
      let actionReady=true;
      if(expected.action){let matching=0,total=0;const rect=expected.action;const target=rect.primary?232:24;for(let y=Math.ceil(rect.y+5);y<Math.floor(rect.y+rect.height-5);y++)for(let x=Math.ceil(rect.x+5);x<Math.floor(rect.x+rect.width-5);x++){const offset=(y*size.width+x)*4;total++;if([bitmap[offset],bitmap[offset+1],bitmap[offset+2]].every(value=>Math.abs(value-target)<6))matching++;}actionReady=total>0&&matching/total>.2;}
      const hash=createHash('sha256').update(bitmap).digest('hex');
      ready=iconsReady&&actionReady&&hash===lastValidHash;
      lastValidHash=iconsReady&&actionReady?hash:'';
    }
    if(!ready)await new Promise(resolve=>setTimeout(resolve,50));
  }
  check(`${name}-painted-visible-icons`,ready,{visibleImages:expected.images.length});
  assert(ready,`Visible icon painting did not settle: ${name}`);
  assert(!image.isEmpty(), name);
  const output = path.join(runRoot, `${name}.png`);
  await fs.writeFile(output, image.toPNG());
  report.screenshots.push(output);
}
const snapshot = `(() => {
  const visible=el=>Boolean(el&&!el.hidden&&el.getClientRects().length);
  const rect=el=>{const r=el?.getBoundingClientRect();return r?{x:r.x,y:r.y,width:r.width,height:r.height}:null;};
  const list=document.querySelector('.ta-kit-list'),browse=document.querySelector('.ta-grove-browse'),detail=document.querySelector('.ta-kit-detail');
  const rows=[...document.querySelectorAll('.ta-kit-row')];
  return {viewport:{width:innerWidth,height:innerHeight},root:rect(document.getElementById('page-town-app')),browse:rect(browse),
    contentWidth:browse.clientWidth-parseFloat(getComputedStyle(browse).paddingLeft)-parseFloat(getComputedStyle(browse).paddingRight),
    columns:getComputedStyle(list).gridTemplateColumns.split(' ').length,gapX:parseFloat(getComputedStyle(list).columnGap),gapY:parseFloat(getComputedStyle(list).rowGap),
    search:rect(document.querySelector('.ta-grove-search-field')),icons:rows.map(row=>({id:row.dataset.kitId,frame:rect(row.querySelector('.ta-kit-symbol')),source:row.querySelector('img')?.getAttribute('src')||'',loaded:Boolean(row.querySelector('img')?.complete&&row.querySelector('img')?.naturalWidth>0),fallbackVisible:visible(row.querySelector('.ta-kit-initial'))})),
    cards:rows.map(row=>({id:row.dataset.kitId,name:row.querySelector('.ta-kit-title').textContent,rect:rect(row),clamp:getComputedStyle(row.querySelector('.ta-kit-description')).webkitLineClamp})),
    browseVisible:visible(browse),detailVisible:visible(detail),detailIcon:rect(detail.querySelector('.ta-kit-symbol')),scrollTop:document.querySelector('.ta-grove').scrollTop,
    query:document.getElementById('grove-search').value,category:document.querySelector('.ta-grove-category[aria-pressed="true"]')?.dataset.category,
    focused:document.activeElement?.dataset.kitId||document.activeElement?.id||'',checks:document.getElementById('grove-checks')?.textContent||'',
    action:document.getElementById('grove-install')?{label:document.getElementById('grove-install').textContent,disabled:document.getElementById('grove-install').disabled,primary:document.getElementById('grove-install').classList.contains('ta-primary')}:null,
    empty:list.textContent.includes('没有匹配的工具包')};
})()`;
async function search(value) {
  await execute(`(()=>{const input=document.getElementById('grove-search');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await settle();
}
async function click(selector) { await execute(`document.querySelector(${JSON.stringify(selector)}).click()`); await settle(); }

async function run() {
  await fs.mkdir(runRoot, {recursive: true});
  const catalog = JSON.parse(await fs.readFile(path.join(project, 'design/grove-catalog-public.json'), 'utf8'));
  const source = await fs.readFile(path.join(renderer, 'index.html'), 'utf8');
  const html = source.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<head>', `<head><base href="${pathToFileURL(renderer + path.sep).href}">`)
    .replace(/<script src="app.js" defer><\/script>/, '');
  await fs.writeFile(path.join(runRoot, 'fixture.html'), html);
  await app.whenReady();
  win = new BrowserWindow({show: false, width: 1440, height: 960, useContentSize: true, frame: false,
    webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true, partition: `grove-${randomUUID()}`}});
  win.webContents.on('paint',(_event,_dirty,image)=>{frameSequence++;latestPaint=image;});
  win.webContents.setFrameRate(30);
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    if (details.url.startsWith('file:')) {
      const file = fileURLToPath(details.url);
      allowed = file === path.join(runRoot, 'fixture.html') || file.startsWith(renderer + path.sep);
    }
    if (!allowed) forbiddenRequests++;
    callback({cancel: !allowed});
  });
  await win.loadFile(path.join(runRoot, 'fixture.html'));
  await execute(`(async()=>{
    const catalog=${JSON.stringify(catalog)};
    window.fixture={catalog,calls:{catalog:0,catalogOffsets:[],detail:0,check:0,send:0,install:0,assist:0},checkResolve:null,checkResolvers:[],detailResolve:null,holdDetail:false};
    for(const el of document.querySelectorAll('.page'))el.hidden=el.id!=='page-town-app';
    document.getElementById('page-title').textContent='工具市场';document.getElementById('app-version').textContent=${JSON.stringify(JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8')).version)};
    document.getElementById('sidebar-town-status').textContent='本机界面审查 · 公开目录';
    const state={connection:{configured:false,status:'disconnected'},workspace:{path:''},portal:{status:'not_configured'},townApp:{identity:{identityRevision:1,connectionRevision:1},access:{}}};
    const bridge={getTownAppState:async()=>state.townApp,getGroveCatalog:async({offset=0})=>{fixture.calls.catalog++;fixture.calls.catalogOffsets.push(offset);const kits=catalog.kits.slice(offset,offset+10);return {kits,count:catalog.count,returned:kits.length};},
      getGroveDetail:async id=>{fixture.calls.detail++;const kit=catalog.kits.find(x=>x.id===id);const result={...kit,manifest:{name:kit.name,version:kit.version,tools:[],provision:{}}};if(fixture.holdDetail)return new Promise(resolve=>{fixture.detailResolve=()=>resolve(result);});return result;},
      prepareGroveInstallation:async()=>{fixture.calls.check++;return new Promise(resolve=>{fixture.checkResolve=resolve;fixture.checkResolvers.push(resolve);});},
      prepareTownAssistance:async()=>{fixture.calls.assist++;throw new Error('Assistance is outside this fixture.');}};
    window.beingTownApp.init({bridge});window.beingTownApp.setState(state);await window.beingTownApp.open('grove');
    for(const image of document.querySelectorAll('.ta-kit-symbol img'))image.loading='eager';
    await document.fonts.ready;
  })()`);
  await waitFor("[...document.querySelectorAll('.ta-kit-symbol img')].every(image=>image.complete)");
  let data = await execute(snapshot);
  report.geometry.push({phase: 'market-1440', ...data});
  check('public-catalog-all-21-cards', data.cards.length === 21);
  check('server-capped-pages-complete-10-10-1', await execute('JSON.stringify(fixture.calls.catalogOffsets)===JSON.stringify([0,10,20])'));
  check('every-kit-has-loaded-bundled-asset', data.icons.length === 21 && data.icons.every(x => x.loaded && !x.fallbackVisible), data.icons.filter(x => !x.loaded || x.fallbackVisible));
  const iconCatalog = await execute('JSON.parse(JSON.stringify(window.groveKitCatalog))');
  const publicIds = catalog.kits.map(kit => kit.id);
  check('current-catalog-has-no-old-generated-icon-references', publicIds.every(id => isCurrentAsset(iconCatalog[id]?.icon)) && data.icons.every(icon => !/assets\/kits\//i.test(icon.source)));
  const codexIds = ['OteJGwtOzLqL7jmyZ2PfM', '3m39hKPimCtOJ2MQhXLCB', 'L-pU4FHlquPPPOZyDiKek', 'TAYvq0_YCoEKQqV4PjzGp'];
  check('four-Codex-kits-share-one-brand-logo', new Set(codexIds.map(id => iconCatalog[id]?.icon)).size === 1 && codexIds.every(id => iconCatalog[id]?.iconStyle === 'brand'));
  check('ten-brand-kits-and-eleven-purpose-symbols', publicIds.filter(id => iconCatalog[id]?.iconStyle === 'brand').length === 10 && publicIds.filter(id => iconCatalog[id]?.iconStyle === 'symbol').length === 11);
  check('seven-brand-assets-and-eleven-distinct-symbols', new Set(publicIds.filter(id => iconCatalog[id]?.iconStyle === 'brand').map(id => iconCatalog[id].icon)).size === 7 && new Set(publicIds.filter(id => iconCatalog[id]?.iconStyle === 'symbol').map(id => iconCatalog[id].icon)).size === 11);
  const brandSources = [
    ...JSON.parse(await fs.readFile(path.join(project, 'design/brand-logo-sources.json'), 'utf8')).assets,
    ...JSON.parse(await fs.readFile(path.join(project, 'design/codex-logo-source.json'), 'utf8')).assets,
  ];
  const expectedBrands = Object.fromEntries([
    ...codexIds.map(id => [id, 'codex']),
    ['op993xqkvii9fyg1V2AQX', 'cursor'], ['W1nK_PzrkDTLj7UGvd741', 'opencode'],
    ['zdVdrI5rNEkaENW9nv5aH', 'jira'], ['7vWqrnJgSP9gx--45zV2b', 'feishu'],
    ['jM-oec68MUWwUdF8yLjO8', 'claude'], ['rOl4C7kM8Le_mTLhpFuj4', 'linear'],
  ]);
  check('ten-product-kits-use-their-existing-brand', Object.entries(expectedBrands).every(([id, brand]) => brandSources.some(source => source.path === `renderer/${iconCatalog[id]?.icon}` && source.brand === brand && source.kitIds.includes(id))));
  const brandIntegrity = [];
  for (const source of brandSources) {
    const safePath = /^renderer\/assets\/brands\/(?:[a-zA-Z0-9_-]+\.svg|codex\.png)$/.test(source.path || '');
    if (!safePath) {brandIntegrity.push({asset: source.path, valid: false});continue;}
    const bytes = await fs.readFile(path.join(project, source.path));
    const validContent = source.path.endsWith('.png') ? source.brand === 'codex' && isPng(bytes) : isPassiveSvg(bytes.toString('utf8'));
    brandIntegrity.push({asset: source.path, valid: createHash('sha256').update(bytes).digest('hex') === source.sha256 && validContent});
  }
  check('all-brand-originals-match-source-manifest-and-format', brandIntegrity.length >= 7 && brandIntegrity.every(item => item.valid), brandIntegrity.filter(item => !item.valid));
  const assetFindings = [];
  for (const relative of new Set(publicIds.map(id => iconCatalog[id]?.icon))) {
    if (!isCurrentAsset(relative)) {assetFindings.push({asset: relative, valid: false});continue;}
    const bytes = await fs.readFile(path.join(renderer, relative));
    assetFindings.push({asset: relative, format: relative.endsWith('.png') ? 'png' : 'svg', valid: relative.endsWith('.png') ? isPng(bytes) : isPassiveSvg(bytes.toString('utf8'))});
  }
  check('seventeen-passive-SVG-and-one-official-Codex-PNG', assetFindings.length === 18 && assetFindings.filter(item => item.format === 'svg').length === 17 && assetFindings.filter(item => item.format === 'png').length === 1 && assetFindings.every(item => item.valid), assetFindings.filter(item => !item.valid));
  check('Codex-market-content-max-768', data.browse.width === 768, data.browse);
  check('Codex-two-columns-wide', data.columns === 2 && data.contentWidth >= 581, {columns: data.columns, width: data.contentWidth});
  check('Codex-search-height-32', data.search.height === 32, data.search);
  check('Codex-grid-gaps-24-8', data.gapX === 24 && data.gapY === 8, {x: data.gapX, y: data.gapY});
  check('Codex-card-icons-40', data.icons.every(x => x.frame.width === 40 && x.frame.height === 40));
  check('Codex-description-one-line', data.cards.every(x => x.clamp === '1'));
  await capture('01-grove-market-1440');
  await search('飞书'); data = await execute(snapshot);
  check('Chinese-purpose-search', data.cards.length === 1 && data.cards[0].name === 'feishu-work', data.cards.map(x => x.name));
  await capture('02-grove-search');
  await search('codex'); data = await execute(snapshot);
  check('live-name-search-two-distinct-codex-kits', data.cards.filter(x => catalog.kits.find(kit => kit.id === x.id)?.name === 'codex').length === 2 && new Set(data.cards.map(x => x.id)).size === data.cards.length);
  check('ripple-Codex-title-identifies-publisher', data.cards.find(x => x.id === '3m39hKPimCtOJ2MQhXLCB')?.name === 'codex · @ripple');
  check('jiacheng-Codex-title-identifies-publisher', data.cards.find(x => x.id === 'L-pU4FHlquPPPOZyDiKek')?.name === 'codex · @jiacheng');
  await search(''); await click('[data-category="知识"]'); data = await execute(snapshot);
  check('purpose-category-filters', data.cards.length > 0 && data.cards.length < 21 && data.category === '知识');
  await search('zzzz-no-match-fixture'); data = await execute(snapshot);
  check('no-result-state', data.cards.length === 0 && data.empty);
  await search(''); await click('[data-category=""]');
  win.setContentSize(1000, 700); await settle(); data = await execute(snapshot);
  report.geometry.push({phase: 'market-1000', ...data});
  check('minimum-desktop-still-two-columns', data.columns === 2 && data.contentWidth >= 581, data.contentWidth);
  await execute("document.querySelector('.ta-grove').scrollTop=330"); await settle();
  const before = await execute(snapshot);
  const selected = before.cards[10].id;
  await click(`[data-kit-id="${selected}"]`); await waitFor("Boolean(document.getElementById('grove-install'))");
  data = await execute(snapshot);
  check('detail-is-separate-page', !data.browseVisible && data.detailVisible);
  check('Codex-detail-icon-60', data.detailIcon?.width === 60 && data.detailIcon?.height === 60, data.detailIcon);
  check('detail-back-has-keyboard-focus', data.focused === 'grove-back', data.focused);
  check('detail-first-action-check-only', data.action?.label === '检查安装条件' && data.action.primary);
  await capture('03-grove-detail');
  await click('#grove-install'); data = await execute(snapshot);
  check('checking-disables-repeat-action', data.action?.label === '正在检查…' && data.action.disabled);
  await click('#grove-install'); check('duplicate-check-does-not-call-bridge', await execute('fixture.calls.check===1'));
  await execute("fixture.checkResolve({status:'unknown',detail:'Fixture: local conditions cannot be confirmed.',assessment:{reasons:['本机依赖版本尚未确认。']}})");
  await waitFor("document.getElementById('grove-install')?.textContent==='重新检查'"); data = await execute(snapshot);
  check('check-result-inline-no-install-claim', data.checks.includes('尚未安装或运行任何脚本') && !data.action.primary && !data.action.disabled);
  check('unknown-check-is-explicit', /未知|待确认|无法确认|未完成|尚未确认/.test(data.checks), data.checks);
  await capture('04-grove-check-result');
  await click('#grove-back'); data = await execute(snapshot);
  check('back-restores-scroll', Math.abs(data.scrollTop - before.scrollTop) < 1, {before: before.scrollTop, after: data.scrollTop});
  check('back-restores-card-focus', data.focused === selected, data.focused);
  await click(`[data-kit-id="${selected}"]`); await waitFor("Boolean(document.getElementById('grove-install'))");
  await click('#grove-install'); check('recheck-requests-again', await execute('fixture.calls.check===2'));
  await click('#grove-back');
  const secondId=catalog.kits[0].id;
  await click(`[data-kit-id="${secondId}"]`); await waitFor("Boolean(document.getElementById('grove-install'))"); data=await execute(snapshot);
  check('another-kit-does-not-inherit-running-state', data.action?.label==='检查安装条件'&&!data.action.disabled);
  await click('#grove-install');
  await execute("fixture.checkResolvers[1]({status:'unknown',assessment:{reasons:['Obsolete A result']}})"); await settle(); data=await execute(snapshot);
  check('old-check-cannot-finish-new-kit-check', data.action?.label==='正在检查…'&&data.action.disabled&&!data.checks.includes('Obsolete A result'));
  await execute("fixture.checkResolvers[2]({status:'blocked',assessment:{reasons:['本机依赖未就绪。']}})"); await waitFor("document.getElementById('grove-install')?.textContent==='重新检查'");
  await click('#grove-back'); await click('#grove-refresh'); await waitFor("document.querySelectorAll('.ta-kit-row').length===21&&!document.getElementById('grove-refresh').disabled");
  await click(`[data-kit-id="${secondId}"]`); await waitFor("Boolean(document.getElementById('grove-install'))"); data=await execute(snapshot);
  check('catalog-refresh-invalidates-old-check', data.action?.label==='检查安装条件'&&!data.checks);
  await execute("document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))"); data=await execute(snapshot);
  check('Ctrl-F-returns-to-catalog-search', data.browseVisible&&!data.detailVisible&&data.focused==='grove-search');
  await execute("document.getElementById('grove-search').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}))"); data=await execute(snapshot);
  check('ArrowDown-selects-first-card', data.focused===catalog.kits[0].id);
  await execute("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}))"); data=await execute(snapshot);
  check('ArrowUp-wraps-to-last-card', data.focused===catalog.kits.at(-1).id);
  await search('codex'); await click('[data-category="开发"]');
  const filteredBefore = await execute(snapshot); await click(`[data-kit-id="${filteredBefore.cards[0].id}"]`);
  await waitFor("Boolean(document.getElementById('grove-install'))");
  await execute("document.querySelector('.ta-grove').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
  data = await execute(snapshot);
  check('escape-back-preserves-search-category', data.browseVisible && !data.detailVisible && data.query === 'codex' && data.category === '开发' && data.cards.length === filteredBefore.cards.length);
  await search(''); await click('[data-category=""]');
  await execute("fixture.holdDetail=true"); await click(`[data-kit-id="${selected}"]`);
  await click('#grove-back'); await execute('fixture.detailResolve();fixture.holdDetail=false'); await settle();
  data = await execute(snapshot); check('late-detail-cannot-reopen-closed-page', data.browseVisible && !data.detailVisible);
  for (const width of [581, 580]) {
    await execute(`(()=>{const grove=document.querySelector('.ta-grove');const gutter=grove.offsetWidth-grove.clientWidth;document.getElementById('page-town-app').style.width=(${width}+24+gutter)+'px';})()`); await settle(); data = await execute(snapshot);
    report.geometry.push({phase: `boundary-content-${width}`, ...data});
    // The 581 px threshold applies to the catalog container's content box.
    check(`responsive-boundary-${width}`, data.contentWidth === width && data.columns === (width >= 581 ? 2 : 1), {contentWidth: data.contentWidth, columns: data.columns});
  }
  win.setContentSize(820, 700); await execute("document.getElementById('page-town-app').style.width=''"); await settle(); data = await execute(snapshot);
  check('narrow-window-one-column', data.columns === 1 && data.contentWidth < 581, {columns: data.columns, width: data.contentWidth});
  await capture('05-grove-narrow');
  win.setContentSize(1440, 960);
  await execute("Promise.all([...document.querySelectorAll('.ta-kit-row img')].map(image=>{image.loading='eager';return image.decode();}))");
  await settle();
  await execute(`(()=>{
    const icons=new Map([...document.querySelectorAll('.ta-kit-row')].map(row=>[row.dataset.kitId,row.querySelector('.ta-kit-symbol').cloneNode(true)]));
    const root=document.getElementById('page-town-app');root.replaceChildren();root.style.overflow='auto';root.style.padding='20px';
    const title=document.createElement('h2');title.textContent='Official logos and Kit symbols · 24 / 32 / 40 / 60 px';root.append(title);
    const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px';root.append(grid);
    for(const kit of fixture.catalog.kits){const card=document.createElement('div');card.style.cssText='border:1px solid #414141;border-radius:8px;padding:10px';const name=document.createElement('p');name.textContent=kit.name+' / '+kit.being_id;card.append(name);
      for(const background of ['#181818','#f7f5f0']){const row=document.createElement('div');row.style.cssText='display:flex;align-items:center;gap:12px;padding:6px;margin-top:4px;background:'+background;for(const size of [24,32,40,60]){const icon=icons.get(kit.id).cloneNode(true);icon.classList.toggle('ta-kit-symbol-large',size===60);icon.style.width=size+'px';icon.style.height=size+'px';const image=icon.querySelector('img');image.loading='eager';image.width=size;image.height=size;if(background==='#f7f5f0')image.src=window.groveKitCatalog[kit.id].iconLight;row.append(icon);}card.append(row);}grid.append(card);}
  })()`);
  await waitFor("[...document.querySelectorAll('#page-town-app img')].every(image=>image.complete)");
  await capture('06-icons-size-preview-top');
  await execute("document.getElementById('page-town-app').scrollTop=600"); await capture('07-icons-size-preview-middle');
  await execute("document.getElementById('page-town-app').scrollTop=1200"); await capture('08-icons-size-preview-bottom');
  check('all-preview-assets-loaded', await execute("[...document.querySelectorAll('#page-town-app img')].length===168&&[...document.querySelectorAll('#page-town-app img')].every(image=>image.naturalWidth>0)"));
  check('fixture-made-no-external-requests', forbiddenRequests === 0, forbiddenRequests);
  check('fixture-never-sent-installed-or-assisted', await execute('fixture.calls.send===0&&fixture.calls.install===0&&fixture.calls.assist===0'));
  report.passed = report.checks.every(item => item.passed);
}
run().catch(error => {report.passed = false;report.error = error.stack;}).finally(async () => {
  await fs.mkdir(runRoot, {recursive: true});
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({passed: report.passed, checks: report.checks.length, failed: report.checks.filter(x => !x.passed).map(x => x.name), report: path.join(runRoot, 'report.json'), error: report.error || null}) + '\n');
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(report.passed ? 0 : 1);
});
