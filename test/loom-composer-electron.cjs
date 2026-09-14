'use strict';

// Run with Electron. All sends are recorded in this local fixture only.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const {app, BrowserWindow} = require('electron');
const {applyLoomTheme} = require('../src/loom-theme.cjs');
const {applyLoomComposer, updateLoomComposerData, takeLoomComposerIntents, reportLoomComposerResult} = require('../src/loom-composer.cjs');

app.disableHardwareAcceleration();
const output = process.env.BEING_COMPOSER_REPORT || path.join(__dirname, '../.local/composer-electron/report.json');
app.setPath('userData', path.join(path.dirname(output), 'profile'));
const report = {checks:[],passed:false,externalRequests:0};
let win, server;
const data = {
  kits:[{installed:true,id:'image-kit',name:'image',description:'生成图片与插画'},{installed:true,id:'browser-kit',name:'browser',description:'读取网页和查找资料'}],
  members:[{id:'member-ada',name:'Ada',description:'一起编程与讨论设计'},{id:'member-bo',name:'Bo',description:'音乐与故事'}]
};
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>
html,body{height:100%;margin:0}#app{display:flex;flex-direction:column;height:100vh}#messages{flex:1}#input-area{flex:none}
</style><body><div id="app"><div id="header">Loom fixture</div><div id="messages"><div class="message being"><div class="meta">Being</div><div class="content">输入 / 选择 Kit，输入 @ 选择要通知的 Being。</div></div></div><div id="input-area"><div id="input-row"><textarea id="input"></textarea><button id="send-btn" type="button">↑</button></div></div></div><script>
window.fixtureSends=[];window.fixtureAccept=true;
function sendFixture(){const input=document.getElementById('input');if(window.fixtureAccept&&input.value.trim()){window.fixtureSends.push(input.value);input.value='';}}
document.getElementById('send-btn').addEventListener('click',sendFixture);
document.getElementById('input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendFixture();}});
</script></body></html>`;

async function check(name, action) { await action(); report.checks.push(name); }
async function draft(text) {
  await win.webContents.executeJavaScript(`(() => {const el=document.getElementById('input');el.value=${JSON.stringify(text)};el.focus();el.setSelectionRange(el.value.length,el.value.length);el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
}
async function key(keyCode, modifiers = []) {
  const keys = {Down:['ArrowDown',40],Return:['Enter',13],Tab:['Tab',9]};
  const [keyName, keyNumber] = keys[keyCode];
  const event = {key:keyName,code:keyName,windowsVirtualKeyCode:keyNumber,nativeVirtualKeyCode:keyNumber,modifiers:modifiers.includes('shift') ? 8 : 0};
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'rawKeyDown',...event});
  await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',...event});
  await win.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 0))');
  (report.keyTrace ||= []).push(await win.webContents.executeJavaScript(`({key:${JSON.stringify(keyName)},value:document.getElementById('input').value,focus:document.activeElement.id,hidden:document.getElementById('desktop-composer-menu').hidden,active:document.getElementById('input').getAttribute('aria-activedescendant')})`));
}
async function snapshot() {
  return win.webContents.executeJavaScript(`({value:document.getElementById('input').value,menuHidden:document.getElementById('desktop-composer-menu').hidden,notice:document.getElementById('desktop-composer-notice').textContent,sends:window.fixtureSends.slice(),requireType:typeof require,processType:typeof process,bridgeType:typeof beingDesktop,composerType:typeof __beingDesktopComposer})`);
}
async function waitForIntents() {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const intents = await takeLoomComposerIntents(win.webContents);
    if (intents.length) return intents;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return [];
}

app.whenReady().then(async () => {
  server = http.createServer((_request,response) => {response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);});
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({show:false,width:1100,height:800,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest((request, callback) => {
    const allowed = new URL(request.url).origin === origin || /^data:image\/(?:svg\+xml|png);base64,/.test(request.url);
    if (!allowed) report.externalRequests++;
    callback({cancel:!allowed});
  });
  await win.loadURL(origin);
  await applyLoomTheme(win.webContents);
  await win.webContents.executeJavaScriptInIsolatedWorld(1107,[{code:"globalThis.fixtureEvents=[];document.addEventListener('keydown',event=>{globalThis.fixtureEvents.push({key:event.key,trusted:event.isTrusted,focus:document.activeElement.id,hidden:document.getElementById('desktop-composer-menu')?.hidden,active:document.getElementById('input').getAttribute('aria-activedescendant')});},true)"}]);
  assert.equal(await applyLoomComposer(win.webContents,data),true);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
  await check('remote-page-has-no-native-or-composer-bridge',async () => {
    const state = await snapshot();
    for (const name of ['requireType','processType','bridgeType','composerType']) assert.equal(state[name],'undefined');
  });
  await check('trusted-keyboard-picks-without-sending',async () => {
    await draft('你好 @');
    await key('Down'); await key('Return');
    const state = await snapshot();
    assert.equal(state.value,'你好 @member-bo ');
    assert.equal(state.sends.length,0);
    assert.match(state.notice,/公开到篝火/);
    assert.equal((await takeLoomComposerIntents(win.webContents)).length,0);
  });
  await check('explicit-trusted-send-produces-exactly-one-mention-intent',async () => {
    await key('Return');
    report.afterSend = await snapshot();
    const intents = await waitForIntents();
    assert.equal(intents.length,1);
    assert.deepEqual(intents[0].memberIds,['member-bo']);
    assert.equal(intents[0].text,'你好 @member-bo ');
    assert.equal((await takeLoomComposerIntents(win.webContents)).length,0);
    await reportLoomComposerResult(win.webContents,{id:intents[0].id,status:'sent'});
  });
  await check('synthetic-click-cannot-create-an-intent',async () => {
    await draft('@member-ada synthetic');
    await win.webContents.executeJavaScript("document.getElementById('send-btn').click()");
    assert.equal((await takeLoomComposerIntents(win.webContents)).length,0);
  });
  await check('ime-enter-does-not-send',async () => {
    await draft('@member-ada composing');
    const before = (await snapshot()).sends.length;
    await win.webContents.executeJavaScript("document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}))");
    assert.equal((await snapshot()).sends.length,before);
  });
  await check('slash-selection-invokes-the-chosen-kit-on-send',async () => {
    await draft('/im'); await key('Tab');
    assert.equal((await snapshot()).value,'/image ');
    await key('Return');
    assert.match((await snapshot()).sends.at(-1),/Kit ID: image-kit/);
  });
  await check('unaccepted-send-preserves-draft-and-does-not-notify',async () => {
    await win.webContents.executeJavaScript('window.fixtureAccept=false');
    await draft('/image @member-ada rejected'); await key('Return');
    assert.equal((await snapshot()).value,'/image @member-ada rejected');
    assert.equal((await takeLoomComposerIntents(win.webContents)).length,0);
  });
  await draft('@');
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  report.finalComposer = await snapshot();
  report.optionStyles = await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.desktop-composer-option')).map(el => ({selected:el.getAttribute('aria-selected'),background:getComputedStyle(el).backgroundColor,appearance:getComputedStyle(el).appearance}))");
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(path.join(path.dirname(output),'composer.png'),(await win.webContents.capturePage()).toPNG());
  await check('built-in-search-and-browse-remain-available-without-grove',async () => {
    await win.webContents.executeJavaScript('window.fixtureAccept=true');
    await updateLoomComposerData(win.webContents,{kits:[],kitsError:'工具市场暂不可用'});
    await draft('/');
    assert.deepEqual(await win.webContents.executeJavaScript("Array.from(document.querySelectorAll('.desktop-composer-option strong'),el=>el.textContent)"),['/search','/browse']);
    await win.webContents.executeJavaScript("Promise.all(Array.from(document.querySelectorAll('.desktop-composer-icon img'),img=>img.decode()))");
    await fs.writeFile(path.join(path.dirname(output),'builtin-kits.png'),(await win.webContents.capturePage()).toPNG());
    const before = (await snapshot()).sends.length;
    await draft('/网页读取');
    await key('Tab');
    assert.equal((await snapshot()).value,'/browse ');
    assert.equal((await snapshot()).sends.length,before);
    await draft('/browse https://example.test/article');
    await key('Return');
    const after = await snapshot();
    assert.equal(after.sends.length,before+1);
    assert.match(after.sends.at(-1),/Being 的内置能力.*网页读取（Browse）/);
    assert.doesNotMatch(after.sends.at(-1),/Kit ID:|安装|登记/);
    assert.equal((await takeLoomComposerIntents(win.webContents)).length,0);
  });
  await check('bundled-kit-icons-load-and-align-without-external-requests',async () => {
    const kits = require('../design/grove-catalog-public.json').kits.map(kit => ({...kit,installed:true}));
    await updateLoomComposerData(win.webContents,{...data,kits});
    // Search each catalog item so icons beyond the first suggestion page are checked.
    for (const kit of kits) {
      await draft('/' + kit.id);
      const result = await win.webContents.executeJavaScript(`(async () => {
        const option=document.querySelector('.desktop-composer-option');
        const img=option.querySelector('.desktop-composer-icon img');
        await img.decode();
        return {source:img.src.startsWith('data:image/'),loaded:img.naturalWidth>0,hidden:option.querySelector('.desktop-composer-initial').hidden};
      })()`);
      assert.deepEqual(result,{source:true,loaded:true,hidden:true},kit.name);
    }
    report.loadedKitIcons=kits.length;
    for (const width of [1100,520]) {
      win.setSize(width,800);
      await draft('/');
      await win.webContents.executeJavaScript("Promise.all(Array.from(document.querySelectorAll('.desktop-composer-icon img'),img=>img.decode()))");
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const layout=await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.desktop-composer-option'),option=>{
        const icon=option.querySelector('.desktop-composer-icon').getBoundingClientRect();
        const text=option.querySelector('.desktop-composer-copy').getBoundingClientRect();
        const menu=document.getElementById('desktop-composer-menu');
        return {iconX:icon.x,textX:text.x,iconWidth:icon.width,gap:text.x-icon.right,overflow:menu.scrollWidth>menu.clientWidth};
      })`);
      assert.equal(new Set(layout.map(row=>row.iconX)).size,1);
      assert.equal(new Set(layout.map(row=>row.textX)).size,1);
      assert.ok(layout.every(row=>row.iconWidth===32&&row.gap>=10&&!row.overflow));
      await fs.writeFile(path.join(path.dirname(output),`kit-icons-${width}.png`),(await win.webContents.capturePage()).toPNG());
    }
    await updateLoomComposerData(win.webContents,{kits:[{installed:true,id:'unknown-kit',name:'Unknown',icon:'https://invalid.test/icon.png'}]});
    await draft('/Unknown');
    assert.deepEqual(await win.webContents.executeJavaScript("({images:document.querySelectorAll('.desktop-composer-icon img').length,fallback:document.querySelector('.desktop-composer-initial').textContent})"),{images:0,fallback:'U'});
  });
  assert.equal(report.externalRequests,0);
  report.passed = true;
}).catch(async error => { report.error = error.stack || String(error); if(win&&!win.isDestroyed())report.events=await win.webContents.executeJavaScriptInIsolatedWorld(1107,[{code:'globalThis.fixtureEvents'}]); }).finally(async () => {
  await fs.mkdir(path.dirname(output),{recursive:true});
  await fs.writeFile(output,JSON.stringify(report,null,2));
  if (win && !win.isDestroyed()) win.destroy();
  if (server) server.close();
  app.exit(report.passed ? 0 : 1);
});
