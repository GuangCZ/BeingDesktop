'use strict';
// Full Markdown, native activity, and a scrolled WebContentsView inside the
// desktop shell. No user profile, model requests, or remote resources are used.
const {app,BrowserWindow,WebContentsView}=require('electron');
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {applyLoomTheme}=require('../src/loom-theme.cjs');
const {prepareLoomSessions}=require('../src/loom-sessions.cjs');
const page=fs.readFileSync(path.join(__dirname,'../.local/loom-progress-current.html'),'utf8');
const marked=fs.readFileSync(path.join(__dirname,'../.local/canvas-marked.js'),'utf8');
app.setPath('userData',path.join(app.getPath('temp'),'being-canvas-'+randomUUID()));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('force-device-scale-factor','1');
let win,view;
const watchdog=setTimeout(()=>{console.error('Canvas fixture timed out');app.exit(1);},45000);
const server=http.createServer((req,res)=>{
  if(req.url.includes('/api/stream/active')){res.writeHead(204);res.end();return;}
  if(req.url.includes('/api/')){res.setHeader('Content-Type','application/json');res.end('{"messages":[]}');return;}
  if(req.url.includes('/health')){res.end('OK');return;}
  res.setHeader('Content-Type','text/html');res.end(page);
});
const run=code=>view.webContents.executeJavaScript(code);
const settle=()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
const screenshot=async name=>{
  const rect=await run("(()=>{const r=document.getElementById('messages').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()");
  const png=await view.webContents.capturePage(rect);
  fs.writeFileSync(path.join(__dirname,'../.local/canvas-'+name+'.png'),png.toPNG());
  return png.toBitmap();
};
app.whenReady().then(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  win=new BrowserWindow({width:1440,height:940,show:false,backgroundColor:'#191919'});
  await win.loadURL('data:text/html,<body style="background:%23191919">Desktop canvas fixture</body>');
  view=new WebContentsView({webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  view.setBackgroundColor('#191919');win.contentView.addChildView(view);
  view.setBounds({x:270,y:90,width:1170,height:810});
  view.webContents.session.webRequest.onBeforeRequest((req,cb)=>cb({cancel:!req.url.startsWith(origin+'/')&&!req.url.startsWith('data:')}));
  await prepareLoomSessions(view.webContents);
  console.log('Canvas fixture: session prepared');
  await view.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:marked});
  await view.webContents.loadURL(origin+'/fixture');
  console.log('Canvas fixture: page loaded');
  await applyLoomTheme(view.webContents);
  console.log('Canvas fixture: theme applied');
  // Child views need a visible native surface for compositor frame callbacks.
  win.showInactive();
  const bodies=Array.from({length:6},(_,i)=>`已制作好 **HTML 游戏 ${i+1}**。\n\n[打开游戏](http://127.0.0.1:18765)\n\n包含：\n- 方向键／WASD 控制，空格暂停。\n- 三档速度、计分与最高分。\n- 屏幕按钮和触屏滑动。\n\n文件：\`snake-game/index.html\`。\n\n已验证：JavaScript 语法检查通过，网页返回正常。\n\nEND_${i}`);
  await run(`document.getElementById('messages').replaceChildren();addMessage('user','制作一个简单的游戏');${JSON.stringify(bodies)}.forEach(text=>addMessage('being',text));scrollLock=true;document.getElementById('messages').scrollTop=0;`);
  await settle();
  assert.equal(await run('document.querySelectorAll(".message.being").length'),6);
  assert.equal(await run('document.querySelectorAll(".message.being ul").length'),6);
  assert.equal(await run('getComputedStyle(document.getElementById("app")).transform'),'none');
  const overlap=await run(`(()=>{const rows=[...document.querySelectorAll('#messages > .message')].map(e=>e.getBoundingClientRect());return rows.some((r,i)=>i && rows[i-1].bottom>r.top);})()`);
  assert.equal(overlap,false,'Long Markdown replies must not overlap');
  await run("document.getElementById('messages').scrollTop=0;");await settle();
  const before=await screenshot('before-scroll');
  for(const top of [800,1600,400,0]) {await run(`document.getElementById('messages').scrollTop=${top}`);await settle();}
  const after=await screenshot('after-scroll');
  assert.ok(before.equals(after),'Returning to the same scroll position must repaint identical text pixels');
  await run("isStreaming=true;tuiSet('thinking');document.getElementById('messages').scrollTop=0;");
  await settle();
  assert.equal(await run('getComputedStyle(document.getElementById("tui-wrapper")).display'),'flex');
  await run("document.querySelector('#tui-bar .tui-line').click();");await settle();
  assert.equal(await run('document.getElementById("tui-wrapper").dataset.expanded'),'true');
  await run("isStreaming=false;tuiClear();document.getElementById('messages').scrollTop=0;");await settle();
  assert.ok(before.equals(await screenshot('after-activity')),'Activity teardown must not leave text fragments on the canvas');
  view.setBounds({x:270,y:90,width:800,height:610});await settle();
  await screenshot('narrow');
  assert.equal(await run('document.documentElement.scrollWidth > innerWidth'),false);
  console.log('PASS: real Markdown in embedded desktop view; six long replies, identical pixels after scroll and activity teardown, no overlap, narrow layout, native activity disclosure.');
}).catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(watchdog);view?.webContents.close();win?.destroy();server.close();app.exit(process.exitCode||0);});
