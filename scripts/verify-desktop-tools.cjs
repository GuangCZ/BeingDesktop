'use strict';

// This never-shown fixture uses production UI and services, an isolated profile,
// a loopback-only page server, and an in-memory replacement for the Being relay.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const {pathToFileURL,fileURLToPath} = require('node:url');
const {randomUUID,createHash} = require('node:crypto');
const root = path.resolve(__dirname,'..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'),[__filename],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  child.on('error',error => {process.stderr.write(`${error.message}\n`);process.exitCode = 1;});
  child.on('exit',code => {process.exitCode = code ?? 1;});
} else {
  const {app,BrowserWindow,WebContentsView,session,ipcMain} = require('electron');
  const {DesktopTools} = require('../src/desktop-tools.cjs');
  const runRoot = path.join(root,'.local',`desktop-tools-ui-${randomUUID()}`);
  const renderer = path.join(root,'renderer');
  const fixture = path.join(runRoot,'fixture.html');
  const workspace = path.join(runRoot,'workspace');
  const report = {version:require('../package.json').version,scope:'Hidden offline UI integration: production renderer, DesktopTools, DesktopBrowser and DesktopConsole. In-memory ToolLink fixture only; no production Being connection, credentials, existing profile, or external network.',checks:[],screenshots:[],geometry:[],externalRequests:0,unexpectedIpc:0,productionConnections:0};
  app.setPath('userData',path.join(runRoot,'profile'));
  app.commandLine.appendSwitch('force-device-scale-factor','1');
  app.commandLine.appendSwitch('host-resolver-rules','MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1');
  app.on('window-all-closed',() => {});
  let win,tools,server,origin,selectedWorkspace = '',latestPaint,paintSequence = 0,workspaceSelections = 0,fixtureClipboard = '';
  const browserPaints = new Map(),browserViews = [],fixtureOutcomes = new Map();
  const deadline = setTimeout(() => {process.stderr.write('Desktop tools fixture timed out.\n');app.exit(1);},120000);
  const check = (name,passed,detail) => {report.checks.push({name,passed:Boolean(passed),...(detail === undefined ? {} : {detail})});assert(passed,name);};
  const execute = script => {assert.equal(win.webContents.getURL(),pathToFileURL(fixture).href);return win.webContents.executeJavaScript(script);};
  const waitFor = (predicate,label,maximum = 15000) => new Promise((resolve,reject) => {
    const limit = Date.now()+maximum;
    const next = async () => {try {if (await predicate()) return resolve();if (Date.now()>limit) return reject(new Error(`Fixture did not settle: ${label}`));setTimeout(next,30);} catch(error) {reject(error);}};
    void next();
  });
  const domWait = (expression,label = expression,maximum) => waitFor(() => execute(`Boolean(${expression})`),label,maximum);
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const click = id => execute(`document.getElementById(${JSON.stringify(id)}).click()`);
  const activeTab = () => tools.browser.snapshot().tabs.find(tab => tab.id === tools.browser.snapshot().activeTabId);
  const pageReady = suffix => waitFor(() => {const tab=activeTab(),native=tab&&tools.browser.tabs.get(tab.id);return tab&&!tab.isLoading&&!tab.error&&tab.url.endsWith(suffix)&&Boolean(native.documentToken);},`page ${suffix}`);
  const address = url => execute(`(()=>{const input=document.getElementById('browser-address');input.value=${JSON.stringify(url)};input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#browser-address-form button:last-child').click();})()`);
  const command = text => execute(`(()=>{const input=document.getElementById('console-command');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('console-run').click();})()`);
  const controls = () => execute(`(()=>{const rect=el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};const panel=document.getElementById('desktop-tools');return{width:innerWidth,height:innerHeight,bodyWidth:document.documentElement.scrollWidth,panel:rect(panel),panelWidth:panel.clientWidth,panelScrollWidth:panel.scrollWidth,host:rect(document.getElementById('browser-host')),mode:document.getElementById('tools-browser-mode').getAttribute('aria-selected')==='true'?'browser':'console',console:rect(document.getElementById('console-command')),actions:[...panel.querySelectorAll('button')].filter(el=>el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden').map(el=>({id:el.id,label:el.textContent,rect:rect(el)}))};})()`);

  class OfflineToolLink {
    constructor({onChange,invokeTool}) {this.onChange=onChange;this.invokeTool=invokeTool;this.status='disconnected';this.controllers=new Set();}
    snapshot() {return {status:this.status,error:'',pending:[],lastCall:null,calls:fixtureOutcomes.size};}
    async connect(connection) {assert.deepEqual(connection,{fixtureOnly:true});this.status='connected';this.onChange(this.snapshot());return this.snapshot();}
    disconnect() {this.status='disconnected';for(const controller of this.controllers)controller.abort();this.controllers.clear();this.onChange(this.snapshot());return this.snapshot();}
    dispose() {return this.disconnect();}
    inject(name,args) {
      assert.equal(this.status,'connected');const id=randomUUID(),controller=new AbortController();this.controllers.add(controller);
      const outcome={status:'pending'};fixtureOutcomes.set(id,outcome);
      Promise.resolve().then(()=>this.invokeTool(name,args,{signal:controller.signal,requestKey:id})).then(value=>{Object.assign(outcome,{status:'resolved',value});},error=>{Object.assign(outcome,{status:'rejected',error:String(error.message)});}).finally(()=>this.controllers.delete(controller));
      return id;
    }
  }

  function guard(event) {
    if(event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(fixture).href) {report.unexpectedIpc++;throw new Error('Only the isolated fixture main frame can call this test bridge.');}
  }
  async function request(name,args) {const id=tools.link.inject(name,args);await domWait(`document.querySelector('[data-request-action="${id}:allow"]')`,'visible approval request');return id;}
  async function decide(id,allow) {await execute(`document.querySelector('[data-request-action="${id}:${allow?'allow':'deny'}"]').click()`);await waitFor(()=>fixtureOutcomes.get(id).status!=='pending','tool approval outcome');return fixtureOutcomes.get(id);}

  async function capture(name) {
    await settle();const geometry=await controls();report.geometry.push({name,...geometry});
    let stable=false,previousHash='',image;const frames=[];
    for(let attempt=0;attempt<45&&!stable;attempt++) {
      const previous=paintSequence;
      win.webContents.invalidate();await waitFor(()=>paintSequence>previous,'shell offscreen paint',3000);image=latestPaint;
      const size=image.getSize(),hash=createHash('sha256').update(image.toBitmap()).digest('hex');
      stable=size.width===geometry.width&&size.height===geometry.height&&hash===previousHash;previousHash=hash;
      if(frames.length<5)frames.push({size,hash});
      if(!stable)await new Promise(resolve=>setTimeout(resolve,60));
    }
    check(`${name}-stable-offscreen-shell`,stable,frames);
    const output=path.join(runRoot,`${name}.png`);await fs.writeFile(output,image.toPNG());report.screenshots.push({path:output,kind:'shell',note:'Electron shell paint only; separate native WebContentsView paint is recorded when available.'});
    if(geometry.mode==='browser') {
      const tab=activeTab(),view=tab&&tools.browser.tabs.get(tab.id)?.view;
      const painted=view&&browserPaints.get(view.webContents.id);
      if(painted&&!painted.isEmpty()) {const pageOutput=path.join(runRoot,`${name}-browser-page.png`);await fs.writeFile(pageOutput,painted.toPNG());report.screenshots.push({path:pageOutput,kind:'native-browser-page',bounds:geometry.host,paintSize:painted.getSize(),note:'Separate offscreen page paint, not a composited desktop screenshot. Never-shown views may inherit the parent canvas dimensions.'});}
    }
    check(`${name}-no-horizontal-panel-overflow`,geometry.bodyWidth<=geometry.width&&geometry.panelScrollWidth<=geometry.panelWidth+1&&geometry.panel.right<=geometry.width&&geometry.panel.x>=0);
    const important=geometry.actions.filter(item=>['tools-close','tools-expand','tools-link-toggle','console-run','browser-new','browser-back','browser-forward'].includes(item.id));
    check(`${name}-primary-controls-contained`,important.every(item=>item.rect.x>=geometry.panel.x&&item.rect.right<=geometry.panel.right+1&&item.rect.y>=geometry.panel.y&&item.rect.bottom<=geometry.panel.bottom+1));
  }

  async function run() {
    await fs.mkdir(workspace,{recursive:true});
    const source=await fs.readFile(path.join(renderer,'index.html'),'utf8');
    const html=source.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace('<head>',`<head><base href="${pathToFileURL(renderer+path.sep).href}">`).replace(/<script\b[^>]*src="(?:app|town-app|kit-catalog)\.js"[^>]*>\s*<\/script>/g,'');
    await fs.writeFile(fixture,html);
    await app.whenReady();
    server=http.createServer((req,res)=>{
      assert.equal(req.socket.remoteAddress,'127.0.0.1');
      if(req.url==='/download') {res.writeHead(200,{'Content-Type':'text/plain','Content-Disposition':'attachment; filename="local-fixture.txt"'});res.end('LOCAL_FIXTURE_DOWNLOAD');return;}
      const route=req.url==='/b'?'/b':'/a';res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
      res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>本机项目预览 ${route}</title><style>body{font:16px/1.7 'Segoe UI',sans-serif;background:#f6f7fa;color:#21252c;padding:32px;margin:0}small{color:#707984;letter-spacing:2px}h1{font-size:28px;line-height:1.3}button,input{font:inherit;padding:9px 14px;border-radius:8px;border:1px solid #ccd2da;background:white}button{cursor:pointer;background:#242a34;color:white;margin-top:18px}input{width:80%;margin-top:14px}article{padding:24px;border:1px solid #e1e4e8;border-radius:16px;background:white}a{color:#506dab}p{color:#68727f}</style><small>LOCAL WORKSPACE</small><h1>与 Being 并排工作</h1><article><strong>本机项目预览 ${route}</strong><p>这个页面仅在隔离测试的回环地址运行。</p><label for="note">项目备注</label><input id="note" placeholder="记录下一步"><br><button id="apply" onclick="document.querySelector('#result').textContent='已应用一次'">应用备注</button><p id="result">等待操作</p><a id="next" href="${route==='/a'?'/b':'/a'}">打开${route==='/a'?'第二页':'第一页'}</a> · <a id="download" href="/download" download>测试下载提示</a></article></html>`);
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
    win=new BrowserWindow({show:false,frame:false,width:1440,height:940,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true,preload:path.join(__dirname,'desktop-tools-fixture-preload.cjs'),partition:`desktop-tools-shell-${randomUUID()}`}});
    win.webContents.on('paint',(_event,_dirty,image)=>{latestPaint=image;paintSequence++;});win.webContents.setFrameRate(30);
    const shellFailures=[];win.webContents.on('console-message',details=>{if(details?.level==='error'||details?.level===3)shellFailures.push(details.message);});
    win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{let allowed=false;if(details.url.startsWith('file:')){const target=fileURLToPath(details.url);allowed=target===fixture||target.startsWith(renderer+path.sep);}if(!allowed)report.externalRequests++;callback({cancel:!allowed});});
    function FixtureView(options) {const view=new WebContentsView({...options,webPreferences:{...options.webPreferences,offscreen:true,backgroundThrottling:false}});browserViews.push(view);view.webContents.on('paint',(_event,_dirty,image)=>browserPaints.set(view.webContents.id,image));view.webContents.setFrameRate(30);return view;}
    tools=new DesktopTools({WebContentsView:FixtureView,session,getWindow:()=>win,getConnection:()=>({fixtureOnly:true}),getWorkspace:()=>selectedWorkspace,onChange:state=>{if(!win.isDestroyed())win.webContents.send('tools-fixture:state',state);},ToolLink:OfflineToolLink});
    tools.browser.session.webRequest.onBeforeRequest((details,callback)=>{const allowed=details.url=== 'about:blank'||details.url.startsWith(origin+'/')||details.url.startsWith('data:');if(!allowed)report.externalRequests++;callback({cancel:!allowed});});
    ipcMain.handle('tools-fixture:get',event=>{guard(event);return tools.snapshot();});
    ipcMain.handle('tools-fixture:action',(event,name,value)=>{guard(event);return tools.perform(name,value);});
    ipcMain.handle('tools-fixture:viewport',(event,value)=>{guard(event);return tools.browser.setViewport(value);});
    ipcMain.handle('tools-fixture:workspace',event=>{guard(event);selectedWorkspace=workspace;workspaceSelections++;tools.changed();return tools.snapshot();});
    ipcMain.handle('tools-fixture:copy',(event,text)=>{guard(event);assert.equal(typeof text,'string');assert.ok(text.length<1024*1024);fixtureClipboard=text;return {copied:true};});
    await win.loadFile(fixture);
    await execute(`(()=>{for(const page of document.querySelectorAll('.page'))page.hidden=page.id!=='page-chat';document.getElementById('app-version').textContent=${JSON.stringify(report.version)};document.getElementById('sidebar-town-status').textContent='本机工具联调';window.beingTools.init({bridge:window.fixtureBridge,onSelectWorkspace:()=>window.fixtureBridge.selectWorkspace()});})()`);
    check('fixture-window-never-shown',!win.isVisible());check('relay-disconnected-by-default',tools.link.snapshot().status==='disconnected');
    await click('open-browser');await waitFor(()=>tools.browser.snapshot().tabs.length===1,'first blank tab');
    check('browser-toolbar-opens-real-tab',await execute("!document.getElementById('desktop-tools').hidden && !document.getElementById('tools-browser-pane').hidden"));
    await address(origin+'/a');await pageReady('/a');const firstId=activeTab().id;
    check('address-button-loads-local-page',activeTab().title.includes('本机项目预览 /a'));
    const page=await tools.browser.readPage(firstId);check('browser-visible-content-and-selectors',page.text.includes('与 Being 并排工作')&&page.elements.some(el=>el.selector==='#note'));
    const wc=tools.browser.tabs.get(firstId).view.webContents;
    check('browser-cannot-access-fixture-native-bridge',await wc.executeJavaScript("typeof fixtureBridge==='undefined' && typeof require==='undefined' && typeof process==='undefined'"));
    await wc.executeJavaScript("document.getElementById('download').click()");
    await waitFor(()=>Boolean(activeTab().notice),'download notice');
    await domWait("document.getElementById('browser-load-status').textContent.includes('下载')",'rendered download notice');
    await settle();
    const downloadState={tab:activeTab(),viewportVisible:tools.browser.visible,emptyHidden:await execute("document.getElementById('browser-empty').hidden")};
    check('blocked-download-keeps-existing-page-and-viewport-visible',downloadState.tab.error===''&&downloadState.tab.url===origin+'/a'&&downloadState.viewportVisible===true&&downloadState.emptyHidden,downloadState);
    check('blocked-download-page-remains-readable',(await tools.browser.readPage(firstId)).text.includes('与 Being 并排工作'));
    await capture('01-browser-1440');
    await address(origin+'/b');await pageReady('/b');await domWait("!document.getElementById('browser-back').disabled");await click('browser-back');await pageReady('/a');await domWait("!document.getElementById('browser-forward').disabled");await click('browser-forward');await pageReady('/b');
    check('history-buttons-return-and-advance-pages',activeTab().id===firstId&&activeTab().url.endsWith('/b'));
    await click('browser-new');await waitFor(()=>tools.browser.snapshot().tabs.length===2,'second tab');const secondId=activeTab().id,secondContents=browserViews.at(-1).webContents;
    await execute(`document.querySelector('[data-tab-action="close:${secondId}"]').click()`);await waitFor(()=>tools.browser.snapshot().tabs.length===1&&secondContents.isDestroyed(),'close second tab');check('close-button-destroys-view-and-restores-first-tab',activeTab().id===firstId&&secondContents.isDestroyed());
    await click('tools-console-mode');await domWait("!document.getElementById('tools-console-pane').hidden");await click('console-select-workspace');await domWait("!document.getElementById('console-cwd').textContent.includes('请先')");
    check('workspace-selector-callback-applies-isolated-directory',selectedWorkspace===workspace&&workspaceSelections===1);
    await command("Write-Output 'Being 控制台已就绪'; Write-Output '中文输出验证通过'");
    await waitFor(()=>tools.console.snapshot().jobs.some(job=>job.status==='completed'||job.status==='failed'),'console process completes',30000);
    await domWait("document.getElementById('console-output').textContent.includes('中文输出验证通过') && document.getElementById('console-job-status').textContent==='退出 0'",'rendered UTF-8 console result');
    const job=tools.console.snapshot().jobs.at(-1);check('real-console-command-runs-and-renders-chinese-exit-zero',job.exitCode===0&&job.output.map(chunk=>chunk.text).join('').includes('Being 控制台已就绪'));check('switch-to-console-hides-native-browser-view',tools.browser.visible===false);
    check('console-origin-identifies-human-command',await execute("document.getElementById('console-origin').textContent.startsWith('你 ·')"));
    await click('console-copy-command');await waitFor(()=>fixtureClipboard===job.command,'copy command');check('copy-command-button-calls-fixture-clipboard',fixtureClipboard===job.command);
    await click('console-copy-output');await waitFor(()=>fixtureClipboard.includes('中文输出验证通过'),'copy output');check('copy-output-button-calls-fixture-clipboard',fixtureClipboard===job.output.map(chunk=>chunk.text).join(''));
    await capture('02-console-1440');
    await click('tools-link-toggle');await waitFor(()=>tools.link.status==='connected','local fake tool connection');check('link-button-connects-only-in-memory-fixture',report.productionConnections===0);
    const denied=await request('desktop_console_run',{command:"Write-Output 'MUST_NOT_RUN'"});const deniedResult=await decide(denied,false);check('deny-button-prevents-command-execution',deniedResult.status==='rejected'&&tools.console.snapshot().jobs.length===1);
    await click('tools-browser-mode');await domWait("!document.getElementById('tools-browser-pane').hidden");
    const fresh=await tools.browser.readPage(firstId);const fill=await request('desktop_browser_fill',{tabId:firstId,selector:'#note',text:'已确认的本机编辑',expectedRevision:fresh.revision});
    await capture('03-browser-approval-1440');const fillResult=await decide(fill,true);check('allow-button-runs-approved-fill-on-selected-page',fillResult.status==='resolved'&&await wc.executeJavaScript("document.getElementById('note').value==='已确认的本机编辑'"));
    const stale=await request('desktop_browser_click',{tabId:firstId,selector:'#apply',expectedRevision:activeTab().revision});await address(origin+'/a');await pageReady('/a');const staleResult=await decide(stale,true);check('navigation-invalidates-pending-page-approval',staleResult.status==='rejected'&&await wc.executeJavaScript("document.getElementById('result').textContent==='等待操作'"));
    await domWait("!document.getElementById('tools-error').hidden && document.getElementById('tools-error').textContent.includes('已过期')",'visible expired approval error');check('expired-page-approval-error-is-visible-in-ui',true);
    const read=await request('desktop_browser_read',{tabId:firstId});const readResult=await decide(read,true);check('approved-read-returns-real-browser-text',readResult.status==='resolved'&&JSON.parse(readResult.value.content[0].text).text.includes('与 Being 并排工作'));
    const runningRequest=await request('desktop_console_run',{command:"Write-Output 'LOCAL_RUNNING_FIXTURE'; Start-Sleep -Seconds 30"});const runningResult=await decide(runningRequest,true);check('approved-console-run-starts-owned-job',runningResult.status==='resolved');
    const runningJobId=JSON.parse(runningResult.value.content[0].text).jobId;
    await waitFor(()=>tools.console.snapshot().jobs.find(item=>item.id===runningJobId)?.output.some(chunk=>chunk.text.includes('LOCAL_RUNNING_FIXTURE')),'running console marker',30000);
    const statusRequest=await request('desktop_console_status',{jobId:runningJobId});
    check('console-status-approval-displays-command-and-read-scope',await execute("document.getElementById('tools-requests').textContent.includes('LOCAL_RUNNING_FIXTURE') && document.getElementById('tools-requests').textContent.includes('256 KiB')"));
    const statusResult=await decide(statusRequest,true);check('approved-console-status-returns-only-reviewed-job',statusResult.status==='resolved'&&JSON.parse(statusResult.value.content[0].text).jobs.length===1&&JSON.parse(statusResult.value.content[0].text).jobs[0].id===runningJobId);
    const pending=await request('desktop_browser_read',{tabId:firstId});await click('tools-link-toggle');await waitFor(()=>fixtureOutcomes.get(pending).status==='rejected','disconnect cancels approval');check('disconnect-button-revokes-pending-approval',tools.requests.size===0&&tools.link.status==='disconnected');
    await domWait("document.getElementById('tools-link-hint').textContent.includes('仍有 1 条本机命令运行')",'disconnected running command count');check('disconnect-shows-running-job-count-without-silently-killing-job',tools.console.snapshot().jobs.find(item=>item.id===runningJobId).status==='running');
    win.setContentSize(1000,760);await settle();await capture('04-browser-1000');
    await click('tools-console-mode');await execute(`(()=>{const select=document.getElementById('console-jobs');select.value=${JSON.stringify(runningJobId)};select.dispatchEvent(new Event('change',{bubbles:true}));})()`);await domWait("document.getElementById('console-origin').textContent.startsWith('Being ·')",'Being console job origin');
    check('console-explains-noninteractive-independent-command-scope',await execute("document.getElementById('tools-console-pane').textContent.includes('非交互')"));await capture('05-console-1000');
    await click('console-stop');await waitFor(()=>tools.console.snapshot().jobs.find(item=>item.id===runningJobId).status==='stopped','stop the fixture-owned running command',15000);check('manual-stop-still-works-after-tool-link-disconnect',true);
    const beforeResize=await controls();await execute("document.getElementById('tools-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))");await settle();const afterResize=await controls();check('keyboard-resizer-adjusts-panel-within-window',afterResize.panel.width>=beforeResize.panel.width&&afterResize.panel.right<=afterResize.width+1);
    await click('tools-expand');await settle();const expanded=await controls();check('expand-button-uses-available-main-content',expanded.panel.width>600&&await execute("document.getElementById('content-grid').classList.contains('tools-full')"));
    await click('tools-close');await domWait("document.getElementById('desktop-tools').hidden");check('close-panel-detaches-browser-without-killing-command-history',tools.browser.visible===false&&tools.console.snapshot().jobs.length===2);
    check('all-fixture-windows-remain-hidden',BrowserWindow.getAllWindows().every(window=>!window.isVisible()));check('no-external-network-requests',report.externalRequests===0);check('no-untrusted-frame-ipc',report.unexpectedIpc===0);check('no-renderer-script-errors',shellFailures.length===0);
    report.consoleValidation={jobs:2,exitCode:job.exitCode,utf8:true,approvedJobStopped:true};report.nativeBrowserPaints=browserPaints.size;report.shellConsoleErrors=shellFailures;report.passed=report.checks.every(item=>item.passed);
  }

  run().catch(error=>{report.passed=false;report.error=error.message;}).finally(async()=>{
    clearTimeout(deadline);
    try{await tools?.dispose();}catch(error){report.cleanupError=error.message;report.passed=false;}
    if(win&&!win.isDestroyed())win.destroy();
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    await fs.mkdir(runRoot,{recursive:true});const reportPath=path.join(runRoot,'report.json');await fs.writeFile(reportPath,JSON.stringify(report,null,2));
    process.stdout.write(JSON.stringify({passed:report.passed,checks:report.checks.length,failed:report.checks.filter(item=>!item.passed).map(item=>item.name),report:reportPath,screenshots:report.screenshots,error:report.error||null})+'\n');
    app.exit(report.passed?0:1);
  });
}
