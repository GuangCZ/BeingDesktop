'use strict';

// Hidden, offline Electron fixture. It never loads a real Loom session or credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  const {spawn} = require('node:child_process');
  const environment = {...process.env};
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename], {cwd:root, env:environment, windowsHide:true, stdio:'inherit'});
  const watchdog = setTimeout(() => {child.kill(); process.stderr.write('Message navigator fixture exceeded 60 seconds.\n');}, 60000);
  child.on('error', error => {clearTimeout(watchdog); process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
  child.on('exit', code => {clearTimeout(watchdog); process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow} = require('electron');
  const {applyLoomTheme} = require('../src/loom-theme.cjs');
  const {applyLoomMessageNavigator} = require('../src/loom-message-navigator.cjs');
  const runRoot = path.join(root, '.local', `message-navigator-${randomUUID()}`);
  const fixture = path.join(runRoot, 'fixture.html');
  const fixtureUrl = pathToFileURL(fixture).href;
  const report = {scope:'Offline synthetic conversation using the production Loom adapter.', checks:[], screenshots:[], externalRequests:0, passed:false};
  let win;
  let mouse = {x:600,y:300};
  app.setPath('userData', path.join(runRoot, 'profile'));
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('force-device-scale-factor', '1');

  const execute = code => {
    assert.equal(win.webContents.getURL(), fixtureUrl);
    return win.webContents.executeJavaScript(code);
  };
  const settle = () => execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const state = () => execute(`(() => {
    const box=element=>{if(!element)return null;const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const rail=document.getElementById('desktop-message-rail');
    const preview=document.getElementById('desktop-message-preview');
    const outer=document.getElementById('desktop-message-navigator');
    const messages=document.getElementById('messages');
    const visible=element=>Boolean(element&&!element.hidden&&getComputedStyle(element).display!=='none'&&getComputedStyle(element).visibility!=='hidden');
    return {count:Number(rail?.getAttribute('aria-valuemax')),current:Number(rail?.getAttribute('aria-valuenow')),minimum:Number(rail?.getAttribute('aria-valuemin')),
      role:rail?.getAttribute('role'),tabIndex:rail?.tabIndex,rail:box(rail),outer:box(outer),preview:box(preview),messages:box(messages),
      shown:visible(outer),previewShown:visible(preview),title:document.getElementById('desktop-message-preview-title')?.textContent,
      body:document.getElementById('desktop-message-preview-body')?.textContent,scrollTop:messages.scrollTop,scrollHeight:messages.scrollHeight,clientHeight:messages.clientHeight,
      viewport:{width:innerWidth,height:innerHeight},bodyWidth:document.documentElement.scrollWidth,focused:document.activeElement.id,
      userTops:Array.from(messages.querySelectorAll('.message.user'),element=>Math.round(element.getBoundingClientRect().top-messages.getBoundingClientRect().top)),
      injectedContent:preview?.querySelectorAll('img,script,iframe').length,unsafeExecuted:window.fixtureUnsafeExecuted||false,
      nativeScrollLock:window.fixtureScrollLock,nativeFollowWrites:window.fixtureFollowWrites};
  })()`);
  async function waitUntil(predicate, description) {
    const deadline = Date.now() + 4000;
    let last;
    do {
      await settle();
      last = await state();
      if (predicate(last)) return last;
    } while (Date.now() < deadline);
    throw new Error(`${description}: ${JSON.stringify(last)}`);
  }
  async function check(name, action) {
    await action();
    report.checks.push(name);
  }
  async function move(x,y) {
    mouse = {x:Math.round(x),y:Math.round(y)};
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',...mouse});
    await settle();
  }
  async function hover(fraction) {
    const {rail} = await state();
    assert.ok(rail&&rail.width>0&&rail.height>0, 'Rail must have a pointer target.');
    await move(rail.x+rail.width/2,rail.y+rail.height*fraction);
    return state();
  }
  async function click() {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',...mouse,button:'left',clickCount:1});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',...mouse,button:'left',clickCount:1});
    await settle();
  }
  async function wheel(deltaY) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseWheel',...mouse,deltaX:0,deltaY});
    await settle();
  }
  async function key(name) {
    const codes = {ArrowDown:40,ArrowUp:38,Home:36,End:35,Enter:13,' ':32,Escape:27};
    const event = {key:name,code:name===' '?'Space':name,windowsVirtualKeyCode:codes[name],nativeVirtualKeyCode:codes[name]};
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'rawKeyDown',...event});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {type:'keyUp',...event});
    await settle();
  }
  async function capture(name, bounds) {
    await settle();
    const image = await win.webContents.capturePage(bounds);
    assert.ok(!image.isEmpty());
    const output = path.join(runRoot, `${name}.png`);
    await fs.writeFile(output, image.toPNG());
    report.screenshots.push(output);
  }
  async function scrollToTurn(index) {
    await execute(`(() => {const messages=document.getElementById('messages');const target=messages.querySelectorAll('.message.user')[${index}];messages.scrollTo({top:messages.scrollTop+target.getBoundingClientRect().top-messages.getBoundingClientRect().top-20,behavior:'instant'});})()`);
    return waitUntil(value=>value.current===index+1, `Scroll should track turn ${index+1}`);
  }
  async function assertJump(index) {
    return waitUntil(value=>value.userTops[index]>=-4&&value.userTops[index]<120, `Turn ${index+1} should be near the top after navigation`);
  }

  async function run() {
    await fs.mkdir(runRoot, {recursive:true});
    await fs.writeFile(fixture, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Message navigator fixture</title><style>
      *{box-sizing:border-box}html,body{height:100%;overflow:hidden}#app{display:flex;flex-direction:column}#messages{flex:1;overflow:auto;overflow-anchor:none}#input-area{flex:none}.message.being .content{min-height:150px}#file-input{display:none}
    </style></head><body><div id="app"><div id="header">离线消息定位验证</div><div id="messages"></div><div id="input-area"><div id="input-row"><textarea id="input" rows="1"></textarea><button id="send-btn" aria-label="发送">↑</button></div><input id="file-input" type="file"></div></div><script>
      window.fixtureUnsafeExecuted=false;
      window.fixtureMessage=(role,title,id)=>{const message=document.createElement('div');message.className='message '+role;if(id)message.id=id;const meta=document.createElement('div');meta.className='meta';meta.textContent=role==='user'?'你':'Being';const content=document.createElement('div');content.className='content';content.textContent=title;message.append(meta,content);return message;};
      window.fixtureTurn=index=>{const nodes=document.createDocumentFragment();nodes.append(fixtureMessage('user','第 '+index+' 轮：最终 SVG 校验与消息定位 <img src=x onerror="fixtureUnsafeExecuted=true">','turn-'+index));nodes.append(fixtureMessage('being','已完成第 '+index+' 轮的源文件核验、响应式布局和滚轮消息定位。这里是可以安全预览的纯文本摘要。','answer-'+index));return nodes;};
      for(let index=1;index<=18;index++)document.getElementById('messages').append(fixtureTurn(index));
      // Mirror Loom's observed scrollLock and already queued scrollToBottom callback.
      window.fixtureScrollLock=true;window.fixtureScrollRaf=null;window.fixtureFollowWrites=0;
      const fixtureMessages=document.getElementById('messages');
      window.fixtureScrollToBottom=()=>{if(!fixtureScrollLock||fixtureScrollRaf)return;fixtureScrollRaf=requestAnimationFrame(()=>{fixtureMessages.scrollTop=fixtureMessages.scrollHeight;fixtureFollowWrites++;fixtureScrollRaf=null;});};
      fixtureMessages.addEventListener('scroll',()=>{fixtureScrollLock=fixtureMessages.scrollHeight-fixtureMessages.scrollTop-fixtureMessages.clientHeight<80;});
      document.addEventListener('click',event=>{if(!window.getSelection().toString()&&!event.target.closest('.btn-icon,.pending-file,#settings-panel,#privacy-panel'))document.getElementById('input').focus();});
    </script></body></html>`);
    await app.whenReady();
    win = new BrowserWindow({show:false,frame:false,width:1100,height:800,useContentSize:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:true,partition:`navigator-${randomUUID()}`}});
    win.webContents.session.webRequest.onBeforeRequest((request,callback)=>{
      const allowed = request.url === fixtureUrl || /^data:image\//.test(request.url);
      if (!allowed) report.externalRequests++;
      callback({cancel:!allowed});
    });
    await win.loadFile(fixture);
    await applyLoomTheme(win.webContents);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', {enabled:true});
    await check('theme-installs-accessible-message-rail',async()=>{
      const value=await waitUntil(value=>value.shown&&value.count===18,'Navigator should appear for eighteen turns');
      assert.equal(value.role,'slider');
      assert.equal(value.tabIndex,0);
      assert.equal(value.minimum,1);
      assert.equal(value.previewShown,false);
      assert.ok(value.rail.x>=0&&value.rail.right<=value.viewport.width);
      assert.equal(await execute('typeof require'), 'undefined');
    });
    await check('reinjection-does-not-duplicate-navigation',async()=>{
      await applyLoomMessageNavigator(win.webContents);
      await settle();
      assert.equal(await execute("document.querySelectorAll('#desktop-message-navigator').length"),1);
    });
    await check('idle-navigator-does-not-continuously-rerender',async()=>{
      await settle();
      const mutations=await execute(`new Promise(resolve=>{
        let count=0,frames=0;
        const observer=new MutationObserver(records=>{count+=records.length;});
        const frame=()=>{frames++;if(frames===4)observer.observe(document.getElementById('desktop-message-navigator'),{attributes:true,childList:true,subtree:true,characterData:true});if(frames<12)requestAnimationFrame(frame);else{observer.disconnect();resolve(count);}};
        requestAnimationFrame(frame);
      })`);
      assert.equal(mutations,0,'Settled layout must not keep mutating the navigator on every frame.');
    });
    await check('ordinary-scroll-tracks-the-current-turn',async()=>{await scrollToTurn(4);});
    await check('hover-previews-safe-text-without-scrolling',async()=>{
      const before=await state();
      const value=await hover(0.43);
      assert.equal(value.previewShown,true);
      assert.equal(value.scrollTop,before.scrollTop);
      assert.match(value.title,new RegExp('第 '+value.current+' 轮'));
      assert.match(value.body,new RegExp('已完成第 '+value.current+' 轮'));
      assert.equal(value.injectedContent,0);
      assert.equal(value.unsafeExecuted,false);
      await capture('01-hover-preview');
    });
    await check('click-jumps-to-previewed-turn',async()=>{
      const value=await state();
      await click();
      await assertJump(value.current-1);
      assert.equal((await state()).focused,'desktop-message-rail','Native document click-to-focus must not steal navigation focus.');
    });
    await check('mouse-leave-dismisses-preview-after-clicking',async()=>{
      await move(650,300);
      assert.equal((await state()).previewShown,false);
      await hover(0.43);
    });
    await check('rail-wheel-advances-once-and-jumps',async()=>{
      const before=await state();
      await wheel(100);
      await waitUntil(value=>value.current===before.current+1,'Wheel should advance one turn');
      await assertJump(before.current);
      await wheel(-100);
      await waitUntil(value=>value.current===before.current,'Reverse wheel should go back one turn');
      await assertJump(before.current-1);
    });
    await check('dragging-the-rail-jumps-to-the-pointer-turn',async()=>{
      const before=await hover(0.25);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mousePressed',...mouse,button:'left',clickCount:1});
      mouse={x:Math.round(before.rail.x+before.rail.width/2),y:Math.round(before.rail.y+before.rail.height*0.62)};
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseMoved',...mouse,button:'left',buttons:1});
      await settle();
      const during=await state();
      assert.ok(during.current>before.current);
      await assertJump(during.current-1);
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent',{type:'mouseReleased',...mouse,button:'left',clickCount:1});
      await settle();
    });
    await check('keyboard-previews-before-enter-and-space-jump',async()=>{
      await move(650,300);
      await execute("document.getElementById('desktop-message-rail').focus()");
      const before=await state();
      await key('Home');
      let value=await state();
      assert.equal(value.current,1);
      assert.equal(value.scrollTop,before.scrollTop);
      await key('ArrowDown');
      assert.equal((await state()).current,2);
      await key('Enter');
      await assertJump(1);
      await key('ArrowUp');
      await key(' ');
      await assertJump(0);
      await key('End');
      value=await state();
      assert.equal(value.current,18);
      assert.equal(value.previewShown,true);
      await key('Escape');
      assert.equal((await state()).previewShown,false);
      await execute("document.getElementById('input').focus()");
    });
    await check('message-area-wheel-retains-normal-scrolling',async()=>{
      await scrollToTurn(4);
      const before=await state();
      await move(650,300);
      await wheel(75);
      const after=await waitUntil(value=>value.scrollTop>before.scrollTop,'Ordinary wheel should scroll the message area');
      assert.ok(after.scrollTop-before.scrollTop<180,'Ordinary wheel must not jump to another turn.');
      assert.equal(after.previewShown,false);
    });
    await check('jump-disables-native-stream-follow-before-next-chunk',async()=>{
      await execute("document.getElementById('messages').scrollTop=document.getElementById('messages').scrollHeight");
      await waitUntil(value=>value.nativeScrollLock,'Native history should follow while at bottom');
      const selected=await hover(0.33);
      await click();
      await assertJump(selected.current-1);
      const before=await state();
      assert.equal(before.nativeScrollLock,false);
      await execute("document.querySelector('#answer-18 .content').append(document.createTextNode(' 新的流式文本。'));fixtureScrollToBottom()");
      await settle();
      const after=await state();
      assert.equal(after.scrollTop,before.scrollTop);
      assert.equal(after.nativeFollowWrites,before.nativeFollowWrites);
    });
    await check('jump-survives-an-already-queued-native-follow',async()=>{
      await execute("document.getElementById('messages').scrollTop=document.getElementById('messages').scrollHeight");
      await waitUntil(value=>value.nativeScrollLock,'Native history should follow while at bottom');
      const selected=await hover(0.33);
      await execute("document.getElementById('desktop-message-rail').focus();document.getElementById('desktop-message-rail').addEventListener('keydown',()=>fixtureScrollToBottom(),{capture:true,once:true})");
      await key('Enter');
      const after=await assertJump(selected.current-1);
      assert.equal(after.nativeFollowWrites,selected.nativeFollowWrites+1,'The queued native callback must actually run to exercise the race.');
      assert.equal(after.nativeScrollLock,false);
    });
    await check('streaming-response-refreshes-open-preview',async()=>{
      const selected=await hover(0.5);
      await execute(`document.querySelectorAll('#messages .message.being .content')[${selected.current-1}].textContent='流式更新后的摘要：新内容已经到达。'`);
      const after=await waitUntil(value=>value.body.includes('流式更新后的摘要'),'Open preview should update for streamed content');
      assert.equal(after.current,selected.current);
    });
    await check('appended-and-prepended-history-refreshes-turn-count',async()=>{
      await move(650,300);
      await execute("document.getElementById('messages').append(fixtureTurn(19));document.getElementById('messages').prepend(fixtureTurn(0))");
      await waitUntil(value=>value.count===20,'History insertion should update the rail');
      const value=await hover(0.01);
      assert.equal(value.current,1);
      assert.match(value.title,/第 0 轮/);
      await click();
      await assertJump(0);
    });
    await check('narrow-and-resized-layout-keeps-preview-within-viewport',async()=>{
      for (const width of [420,780,1100]) {
        win.setContentSize(width,640);
        await settle();
        const value=await hover(0.48);
        assert.equal(value.previewShown,true);
        assert.ok(value.preview.x>=0&&value.preview.right<=value.viewport.width+1,JSON.stringify(value.preview));
        assert.ok(value.preview.y>=0&&value.preview.bottom<=value.viewport.height+1,JSON.stringify(value.preview));
        assert.ok(value.bodyWidth<=value.viewport.width);
        await capture(`02-preview-${width}`);
      }
    });
    await check('long-history-keeps-ticks-bounded-and-last-turn-reachable',async()=>{
      await move(650,300);
      await execute("(() => {const messages=document.getElementById('messages');messages.replaceChildren();for(let i=1;i<=240;i++)messages.append(fixtureTurn(i));})()");
      await waitUntil(value=>value.count===240,'Long history should index every turn');
      assert.ok(await execute("document.querySelectorAll('#desktop-message-ticks > *').length<=50"));
      await execute("document.getElementById('desktop-message-rail').focus()");
      await key('End');
      assert.equal((await state()).current,240);
      await key('ArrowDown');
      assert.equal((await state()).current,240);
      await key('Enter');
      await waitUntil(value=>value.scrollTop+value.clientHeight>=value.scrollHeight-2,'Last turn must remain reachable');
      await key('Home');
      await key('ArrowUp');
      assert.equal((await state()).current,1);
      await key('Enter');
      await assertJump(0);
      await execute("document.getElementById('input').focus()");
    });
    await check('message-container-replacement-refreshes-the-index',async()=>{
      await move(650,300);
      await execute("(() => {const messages=document.getElementById('messages');const replacement=messages.cloneNode(false);for(let i=1;i<=6;i++)replacement.append(fixtureTurn(i));messages.replaceWith(replacement);})()");
      await waitUntil(value=>value.count===6,'Replacement message container should be observed');
      const value=await hover(0.45);
      await click();
      await assertJump(value.current-1);
    });
    await check('assistant-only-history-has-navigable-fallback',async()=>{
      await execute("document.querySelectorAll('#messages .message.user').forEach(element=>element.remove())");
      await waitUntil(value=>value.count===6,'Assistant-only history should remain indexed');
      const value=await hover(0.5);
      assert.equal(value.previewShown,true);
      assert.match(value.title,/已完成第/);
    });
    await check('thinking-indicator-is-excluded-from-history',async()=>{
      await execute("(() => {const thinking=fixtureMessage('being thinking-indicator','正在思考…','thinking');document.getElementById('messages').append(thinking);})()");
      await settle();
      assert.equal((await state()).count,6);
    });
    await check('empty-and-short-conversations-hide-the-rail',async()=>{
      await execute("document.getElementById('messages').replaceChildren()");
      await waitUntil(value=>!value.shown,'Empty history should hide the navigator');
      await execute("document.getElementById('messages').append(fixtureTurn(1))");
      await waitUntil(value=>!value.shown,'A short conversation should hide the navigator');
    });
    await check('clean-reference-showcase-uses-production-presentation',async()=>{
      win.setContentSize(1100,800);
      await execute(`(() => {
        const messages=document.getElementById('messages');messages.replaceChildren();
        for(let index=1;index<=14;index++) {
          const turn=fixtureTurn(index);
          turn.querySelector('.user .content').textContent='查看设计更新：顶栏、图标与消息定位的交互细节';
          const answer=turn.querySelector('.being .content');
          answer.textContent='把鼠标移到左侧刻度即可预览消息。滚动滚轮逐条定位，点击刻度立即跳转；键盘方向键也可以选择。';
          answer.style.minHeight='460px';messages.append(turn);
        }
        messages.scrollTop=0;document.getElementById('input').focus();
      })()`);
      await waitUntil(value=>value.count===14,'Showcase should index fourteen turns');
      const value=await hover(0.5);
      assert.equal(value.previewShown,true);
      await capture('03-message-navigator-showcase',{x:0,y:Math.floor(value.rail.y-35),width:430,height:Math.ceil(value.rail.height+70)});
    });
    assert.equal(report.externalRequests,0);
    report.passed=true;
  }
  run().catch(async error=>{
    report.error=error.stack||String(error);
    if(win&&!win.isDestroyed()) {
      try {report.failureState=await state();await capture('failure');} catch {}
    }
  }).finally(async()=>{
    await fs.mkdir(runRoot,{recursive:true});
    const output=path.join(runRoot,'report.json');
    await fs.writeFile(output,JSON.stringify(report,null,2));
    process.stdout.write(JSON.stringify({passed:report.passed,checks:report.checks.length,report:output,screenshots:report.screenshots,error:report.error||null})+'\n');
    if(win&&!win.isDestroyed())win.destroy();
    app.exit(report.passed?0:1);
  });
}
