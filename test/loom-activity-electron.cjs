'use strict';

// Hidden, offline fixture that mirrors Loom's native activity-node lifecycle.
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
  const watchdog = setTimeout(() => {child.kill(); process.stderr.write('Activity fixture exceeded 60 seconds.\n');}, 60000);
  child.on('error', error => {clearTimeout(watchdog); process.stderr.write(`${error.message}\n`); process.exitCode = 1;});
  child.on('exit', code => {clearTimeout(watchdog); process.exitCode = code ?? 1;});
} else {
  const {app, BrowserWindow} = require('electron');
  const {applyLoomTheme} = require('../src/loom-theme.cjs');
  const {applyLoomActivity, ACTIVITY_WORLD_ID} = require('../src/loom-activity.cjs');
  const runRoot = path.join(root, '.local', `loom-activity-${randomUUID()}`);
  const fixture = path.join(runRoot, 'fixture.html');
  const fixtureUrl = pathToFileURL(fixture).href;
  const report = {scope:'Offline native Loom activity lifecycle using the production desktop adapter.', checks:[], screenshots:[], externalRequests:0, passed:false};
  let win;
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
    const wrapper=document.getElementById('tui-wrapper'), messages=document.getElementById('messages');
    const host=wrapper?.closest('.message'), meta=host?.querySelector(':scope > .meta'), content=host?.querySelector(':scope > .content');
    const log=document.getElementById('activity-log'), bar=document.getElementById('tui-bar'), line=bar?.querySelector('.tui-line');
    const preview=log?.querySelector('.act-preview'), item=log?.querySelector('.act-item');
    return {connected:fixtureRefs.wrapper.isConnected,refs:wrapper===fixtureRefs.wrapper&&bar===fixtureRefs.bar&&log===fixtureRefs.log,
      host:host?.id||null,hostClass:host?.className||null,hostMeta:meta?.textContent||null,hosts:document.querySelectorAll('[data-desktop-activity-host]').length,
      placeholders:document.querySelectorAll('[data-desktop-activity-placeholder]').length,wrapperCount:document.querySelectorAll('#tui-wrapper').length,
      barActive:bar?.classList.contains('active'),wrapperDisplay:wrapper?getComputedStyle(wrapper).display:null,home:wrapper?.parentElement.id==='app',
      dotsDisplay:content?getComputedStyle(content).display:null,wrapper:box(wrapper),meta:box(meta),content:box(content),bar:box(bar),log:box(log),
      logOpacity:log?getComputedStyle(log).opacity:null,logPointer:log?getComputedStyle(log).pointerEvents:null,logPosition:log?getComputedStyle(log).position:null,
      logText:log?.textContent,logMaxHeight:log?getComputedStyle(log).maxHeight:null,logOverflow:log?getComputedStyle(log).overflowY:null,
      lineRole:line?.getAttribute('role'),lineTabIndex:line?.tabIndex,lineExpanded:line?.getAttribute('aria-expanded'),lineControls:line?.getAttribute('aria-controls'),lineFocused:document.activeElement===line,
      preview:box(preview),previewMaxHeight:preview?getComputedStyle(preview).maxHeight:null,previewWhiteSpace:preview?getComputedStyle(preview).whiteSpace:null,itemWhiteSpace:item?getComputedStyle(item).whiteSpace:null,
      input:box(document.getElementById('input-area')),messages:box(messages),scrollTop:messages.scrollTop,scrollHeight:messages.scrollHeight,
      bodyWidth:document.documentElement.scrollWidth,viewport:innerWidth,stopClicks:fixtureStopClicks,logClicks:fixtureLogClicks,
      nativeStopVisible:Boolean(bar?.querySelector('.tui-stop')?.getClientRects().length),desktopStopVisible:Boolean(document.getElementById('desktop-stop')?.getClientRects().length),sendVisible:Boolean(document.getElementById('send-btn')?.getClientRects().length),
      barText:bar?.textContent,followWrites:fixtureFollowWrites,requireType:typeof require,adapterType:typeof __beingDesktopActivity};
  })()`);
  async function check(name, action) {await action(); report.checks.push(name);}
  async function capture(name) {
    await settle();
    const output = path.join(runRoot, `${name}.png`);
    const shot = await win.webContents.capturePage();
    assert.ok(!shot.isEmpty());
    await fs.writeFile(output, shot.toPNG());
    report.screenshots.push(output);
  }
  async function move(x,y) {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseMoved',x:Math.round(x),y:Math.round(y)});
    await settle();
  }
  async function click(selector) {
    const point = await execute(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    await move(point.x,point.y);
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:1});
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',clickCount:1});
    await settle();
  }
  async function press(key) {
    const code=key===' '?'Space':key;
    const virtualKey=key===' '?32:13;
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey});
    await win.webContents.debugger.sendCommand('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtualKey,nativeVirtualKeyCode:virtualKey});
    await settle();
  }
  async function mutate(code) {await execute(code); await settle(); return state();}
  function assertPlacement(value, id) {
    assert.equal(value.host,id);
    assert.equal(value.refs,true);
    assert.equal(value.wrapperCount,1);
    assert.equal(value.hosts,1);
    assert.ok(value.wrapper.y>=value.meta.bottom, 'Activity must appear below the assistant metadata.');
    assert.ok(Math.abs(value.wrapper.x-value.meta.x)<1, 'Activity must align with the assistant text.');
    assert.ok(value.wrapper.bottom<=value.input.y, 'Activity must stay inside the conversation.');
  }

  async function run() {
    await fs.mkdir(runRoot,{recursive:true});
    await fs.writeFile(fixture, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Inline thinking fixture</title><style>
      :root{--purple:#ab8fd7;--green:#9ccdab;--text-ghost:#8b8494;--text-dim:#b6b3ba;--text-muted:#8e8a94;--border:#303030;--red:#eb9999}
      *{box-sizing:border-box}html,body{height:100%;overflow:hidden}#app{display:flex;flex-direction:column}#messages{flex:1;overflow:auto;overflow-anchor:none}#input-area{flex:none}#file-input{display:none}
      .message.thinking-indicator .content{display:flex;align-items:center;gap:4px}.thinking-dot{height:5px;width:5px;border-radius:50%;background:var(--purple)}
      #tui-wrapper{position:relative}#tui-bar{font-size:12px;padding:0 16px;max-height:0;overflow:hidden;opacity:0}#tui-bar.active{min-height:28px;max-height:120px;padding:6px 16px;opacity:1;border-top:1px solid var(--border);position:relative}
      #tui-bar .tui-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.6}.tui-thinking,.tui-cursor{color:var(--purple)}.tui-prompt{color:var(--text-ghost)}
      .tui-stop{position:absolute;right:0;top:50%;transform:translateY(-50%);width:28px;height:28px;padding:0;border:1px solid var(--red);border-radius:6px;background:none;color:var(--red);cursor:pointer}
      .tui-preview,.tui-hint{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-left:14px;font-size:11px;color:var(--text-ghost);line-height:1.4}
      #activity-log{position:absolute;bottom:100%;left:0;right:0;max-height:0;overflow-y:auto;opacity:0;padding:0 12px;pointer-events:none;z-index:5}
      #tui-wrapper:hover #activity-log.has-content,#activity-log.pinned{max-height:200px;opacity:1;padding:8px 12px;pointer-events:auto}.act-item{line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.act-preview{font-size:10px;line-height:1.4;max-height:1.4em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-ghost)}
      .fixture-log-button{border:0;padding:0;background:transparent;color:inherit;font:inherit;cursor:pointer}
    </style></head><body><div id="app"><div id="header">Loom fixture</div><div id="messages"></div><div id="reconnect-banner"></div><div id="tui-wrapper"><div id="activity-log"></div><div id="tui-bar"></div></div><div id="input-area"><div id="input-row"><textarea id="input" rows="1" placeholder="输入消息"></textarea><button id="send-btn" aria-label="发送">↑</button></div><input id="file-input" type="file"></div></div><script>
      window.fixtureRefs={wrapper:document.getElementById('tui-wrapper'),bar:document.getElementById('tui-bar'),log:document.getElementById('activity-log')};
      window.fixtureStopClicks=0;window.fixtureLogClicks=0;window.fixtureFollowWrites=0;window.fixtureThinking=null;
      window.fixtureMessage=(role,text,id)=>{const row=document.createElement('div');row.className='message '+role;row.id=id;const meta=document.createElement('div');meta.className='meta';meta.textContent=(role==='user'?'you':'being')+' · 16:30:19';const content=document.createElement('div');content.className='content';content.textContent=text;row.append(meta,content);return row;};
      window.fixtureClear=()=>{fixtureRefs.bar.classList.remove('active');fixtureRefs.bar.replaceChildren();fixtureRefs.log.classList.remove('has-content','pinned');fixtureRefs.log.replaceChildren();};
      window.fixtureSet=(label,preview='')=>{const bar=fixtureRefs.bar;bar.innerHTML='<div class="tui-line"><span class="tui-prompt">⟩</span> <span class="tui-thinking"></span> <span class="tui-cursor">▊</span></div><button class="tui-stop" title="停止" aria-label="停止">■</button>';bar.querySelector('.tui-thinking').textContent=label;bar.querySelector('.tui-stop').addEventListener('click',()=>fixtureStopClicks++);if(preview){const p=document.createElement('div');p.className='tui-preview';p.textContent=preview;bar.append(p);}bar.classList.add('active');};
      window.fixtureLog=()=>{fixtureRefs.log.innerHTML='<div class="act-item think">◉ 在思考<div class="act-preview">正在核对安装方式和浏览器扩展的加载步骤。</div></div><div class="act-item tool"><button class="fixture-log-button">● 查看工具过程</button></div>';fixtureRefs.log.querySelector('button').addEventListener('click',()=>fixtureLogClicks++);fixtureRefs.log.classList.add('has-content');};
      window.fixtureRemoveThinking=()=>{if(fixtureThinking){fixtureThinking.remove();fixtureThinking=null;}};
      window.fixtureShowThinking=id=>{fixtureRemoveThinking();const row=fixtureMessage('being thinking-indicator','',id);row.querySelector('.content').innerHTML='<span class="thinking-dot"></span><span class="thinking-dot"></span><span class="thinking-dot"></span>';fixtureThinking=row;document.getElementById('messages').append(row);};
      window.fixtureBegin=id=>{fixtureSet('在思考');fixtureShowThinking(id);};
      window.fixtureInitial=()=>{fixtureClear();fixtureRemoveThinking();const messages=document.getElementById('messages');messages.replaceChildren(fixtureMessage('being','可以把安装包接入 Portal，然后在浏览器确认加载。','previous-answer'),fixtureMessage('user','能不能浅包一下，然后让 Being 通过 Portal 给浏览器自动安装','user-1'));};
      document.addEventListener('click',event=>{if(!window.getSelection().toString()&&!event.target.closest('.btn-icon,.pending-file,#settings-panel,#privacy-panel'))document.getElementById('input').focus();});
      fixtureInitial();
    </script></body></html>`);
    await app.whenReady();
    win = new BrowserWindow({show:false,frame:false,width:1100,height:800,useContentSize:true,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false,offscreen:true,partition:`activity-${randomUUID()}`}});
    win.webContents.session.webRequest.onBeforeRequest((request,callback)=>{
      const allowed=request.url===fixtureUrl||/^data:image\//.test(request.url);
      if(!allowed)report.externalRequests++;
      callback({cancel:!allowed});
    });
    await win.loadFile(fixture);
    await applyLoomTheme(win.webContents);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled',{enabled:true});
    await move(1040,30);

    await check('idle-controls-stay-hidden-and-isolated',async()=>{
      const value=await state();
      assert.equal(value.home,true);assert.equal(value.wrapperDisplay,'none');assert.equal(value.refs,true);
      assert.equal(value.requireType,'undefined');assert.equal(value.adapterType,'undefined');
    });
    await check('thinking-replaces-dots-below-current-assistant-metadata',async()=>{
      const value=await mutate("fixtureBegin('thinking-1')");
      assertPlacement(value,'thinking-1');assert.equal(value.dotsDisplay,'none');assert.equal(value.placeholders,0);
      await capture('01-inline-thinking-desktop');
    });
    await check('reinjection-preserves-one-native-wrapper-and-control-listeners',async()=>{
      assert.equal(await applyLoomActivity(win.webContents),true);
      await settle();
      const controls=await state();assert.equal(controls.nativeStopVisible,false);assert.equal(controls.desktopStopVisible,true);assert.equal(controls.sendVisible,false);
      await click('#desktop-stop');
      const value=await state();assert.equal(value.stopClicks,1);assert.equal(value.wrapperCount,1);assert.equal(value.refs,true);assert.equal(value.lineExpanded,'false');assert.equal(value.log.height,0);
    });
    await check('empty-thinking-click-shows-waiting-until-native-details-arrive',async()=>{
      let value=await state();
      assert.equal(value.lineRole,'button');assert.equal(value.lineTabIndex,0);assert.equal(value.lineControls,'activity-log');assert.equal(value.lineExpanded,'false');
      await click('.tui-thinking');
      value=await state();assert.equal(value.lineExpanded,'true');assert.ok(value.log.height>20);assert.equal(value.logText,'...');
      assert.equal(value.lineFocused,true,'Opening details must preserve focus despite the native composer click handler.');
      await move(1040,30);assert.equal((await state()).lineExpanded,'true');
      value=await mutate('fixtureLog()');
      assert.equal(value.lineExpanded,'true');assert.match(value.logText,/正在核对安装方式/);assert.doesNotMatch(value.logText,/等待|尚未|暂未|还未/);
      await click('.tui-thinking');
      value=await state();assert.equal(value.lineExpanded,'false');assert.equal(value.log.height,0);
    });
    await check('thinking-click-expands-in-flow-and-stays-open-away-from-pointer',async()=>{
      await mutate("fixtureSet('在思考','正在梳理浏览器扩展的安装步骤。');fixtureLog();document.getElementById('input').focus()");
      await move(1040,30);
      let value=await state();assert.equal(value.log.height,0);
      await move(value.bar.x+20,value.bar.y+12);
      assert.equal((await state()).log.height,0,'Hover must not shift the clickable title before a click.');
      await click('.tui-thinking');
      value=await state();assert.equal(value.lineExpanded,'true');assert.ok(value.log.height>20);assert.ok(value.log.y>=value.bar.bottom);assert.equal(value.logPosition,'relative');
      await move(1040,30);
      value=await state();assert.ok(value.log.height>20);assert.equal(value.logPointer,'auto');assert.equal(value.lineExpanded,'true');
      await click('.fixture-log-button');
      value=await state();assert.equal(value.logClicks,1);assert.equal(value.lineExpanded,'true');assert.ok(value.log.height>20);
      await capture('02-expanded-process-desktop');
      await click('.tui-thinking');
      value=await state();assert.equal(value.lineExpanded,'false');assert.equal(value.log.height,0,'Explicit collapse must hold while the pointer remains over the status.');
    });
    await check('thinking-disclosure-supports-enter-and-space-without-hover-or-focus-open',async()=>{
      let value=await mutate("fixtureRefs.bar.querySelector('.tui-line').focus()");
      assert.equal(value.lineFocused,true);assert.equal(value.lineExpanded,'false');assert.equal(value.log.height,0);
      await press('Enter');
      value=await state();assert.equal(value.lineExpanded,'true');assert.ok(value.log.height>20);
      await press(' ');
      value=await state();assert.equal(value.lineExpanded,'false');assert.equal(value.log.height,0);assert.equal(value.lineFocused,true);
      await click('.tui-thinking');
    });
    await check('live-native-status-replacement-preserves-disclosure-and-detail-wrapping',async()=>{
      let value=await mutate("fixtureSet('在行动','正在核对工具结果。');fixtureRefs.log.querySelector('.act-preview').textContent='检查安装目录、浏览器扩展入口和加载步骤。'.repeat(20)");
      assert.equal(value.lineExpanded,'true');assert.equal(value.lineRole,'button');assert.equal(value.lineTabIndex,0);assert.equal(value.lineControls,'activity-log');
      assert.equal(value.previewMaxHeight,'none');assert.notEqual(value.previewWhiteSpace,'nowrap');assert.notEqual(value.itemWhiteSpace,'nowrap');
      assert.ok(value.preview.height>40,'Expanded details must show multiple lines of native preview text.');
      assert.equal(value.logMaxHeight,'240px');assert.equal(value.logOverflow,'auto');assert.ok(value.log.height<=241);
      await click('.tui-thinking');
      value=await state();assert.equal(value.lineExpanded,'false');assert.equal(value.log.height,0);
      await click('.tui-thinking');
    });
    await check('tool-use-recovers-original-controls-after-native-indicator-removal',async()=>{
      const value=await mutate("fixtureRemoveThinking();fixtureSet('正在读取网页','检查浏览器扩展的安装入口。')");
      assert.equal(value.connected,true);assert.equal(value.refs,true);assert.equal(value.placeholders,1);
      assert.equal(value.hostClass,'message being thinking-indicator');assert.equal(value.hostMeta,'being · 16:30:19');
      assert.equal(value.hosts,1);assert.match(value.barText,/正在读取网页/);
      assert.equal(value.lineExpanded,'true');assert.ok(value.log.height>20,'Removing the native thinking row must not close open tool details.');
      await click('#desktop-stop');
      const stopped=await state();assert.equal(stopped.stopClicks,2);assert.equal(stopped.lineExpanded,'true');
      await mutate("fixtureRefs.bar.classList.remove('active')");
      const cleared=await state();assert.equal(cleared.home,true);assert.equal(cleared.placeholders,0);assert.equal(cleared.hosts,0);assert.equal(cleared.wrapperDisplay,'none');assert.notEqual(cleared.lineExpanded,'true');
      assert.equal(cleared.desktopStopVisible,false);assert.equal(cleared.sendVisible,true);
    });
    await check('reply-clears-placeholder-and-later-thinking-mounts-before-answer-content',async()=>{
      let value=await mutate("fixtureClear();document.getElementById('messages').append(fixtureMessage('being','第一部分回复正在生成。','answer-1'))");
      assert.equal(value.home,true);assert.equal(value.placeholders,0);assert.equal(value.hosts,0);assert.equal(value.wrapperDisplay,'none');
      value=await mutate("fixtureSet('在思考','继续检查剩余步骤。')");
      assertPlacement(value,'answer-1');assert.equal(value.dotsDisplay,'block');assert.ok(value.wrapper.bottom<=value.content.y);
      assert.equal(value.lineExpanded,'false');assert.equal(value.log.height,0,'A later active phase starts collapsed after native clear.');
    });
    await check('second-turn-never-attaches-to-previous-answer',async()=>{
      let value=await mutate("document.getElementById('messages').append(fixtureMessage('user','继续第二个问题。','user-2'));fixtureBegin('thinking-2')");
      assertPlacement(value,'thinking-2');
      assert.equal(await execute("document.getElementById('answer-1').hasAttribute('data-desktop-activity-host')"),false);
      value=await mutate("fixtureRemoveThinking();fixtureSet('正在处理第二个问题')");
      assert.equal(value.placeholders,1);assert.equal(value.hosts,1);assert.equal(value.refs,true);
      assert.equal(await execute("document.getElementById('tui-wrapper').parentElement.previousElementSibling.id"),'user-2');
    });
    await check('spliced-user-recreates-existing-placeholder-after-newest-message',async()=>{
      const value=await mutate("window.fixtureOldPlaceholder=document.querySelector('[data-desktop-activity-placeholder]');document.getElementById('messages').append(fixtureMessage('user','追加一条信息，当前处理继续。','splice-user-placeholder'))");
      assert.equal(value.connected,true);assert.equal(value.refs,true);assert.equal(value.placeholders,1);assert.equal(value.hosts,1);
      assert.equal(await execute('fixtureOldPlaceholder.isConnected'),false);
      assert.equal(await execute("document.getElementById('tui-wrapper').parentElement.previousElementSibling.id"),'splice-user-placeholder');
      assert.equal(await execute("document.getElementById('tui-wrapper').parentElement===fixtureOldPlaceholder"),false);
    });
    await check('spliced-user-hides-old-native-dots-and-moves-active-process',async()=>{
      await mutate("fixtureShowThinking('spliced-native-thinking')");
      const value=await mutate("document.getElementById('messages').append(fixtureMessage('user','再补充一个要求，不中断处理。','splice-user-native'))");
      assert.equal(value.connected,true);assert.equal(value.refs,true);assert.equal(value.placeholders,1);assert.equal(value.hosts,1);
      assert.equal(await execute("getComputedStyle(document.getElementById('spliced-native-thinking')).display"),'none');
      assert.equal(await execute("document.getElementById('tui-wrapper').parentElement.previousElementSibling.id"),'splice-user-native');
      assert.equal(value.hostMeta,'being · 16:30:19');
    });
    await check('history-replacement-recovers-controls-and-clears-stale-metadata',async()=>{
      let value=await mutate("document.getElementById('messages').innerHTML='';document.getElementById('messages').append(fixtureMessage('user','新的会话内容。','replacement-user'))");
      assert.equal(value.connected,true);assert.equal(value.refs,true);assert.equal(value.placeholders,1);assert.equal(value.hostMeta,null);
      value=await mutate("fixtureShowThinking('replacement-thinking')");
      assertPlacement(value,'replacement-thinking');assert.equal(value.placeholders,0);
      value=await mutate("fixtureRemoveThinking();fixtureClear()");
      assert.equal(value.home,true);assert.equal(value.wrapperDisplay,'none');assert.equal(value.placeholders,0);
    });
    await check('message-container-replacement-remains-supported',async()=>{
      let value=await mutate("fixtureBegin('before-container-replacement')");
      assert.equal(value.connected,true);
      value=await mutate("(() => {const old=document.getElementById('messages');const next=old.cloneNode(false);next.append(fixtureMessage('user','重新加载对话。','reloaded-user'));old.replaceWith(next);fixtureThinking=null;fixtureShowThinking('reloaded-thinking');})()");
      assertPlacement(value,'reloaded-thinking');assert.equal(value.refs,true);
      await mutate('fixtureRemoveThinking();fixtureClear()');
    });
    await check('reader-scroll-position-survives-thinking-and-tool-updates',async()=>{
      await mutate("(() => {const messages=document.getElementById('messages');messages.replaceChildren();for(let i=0;i<25;i++){const user=fixtureMessage('user','历史问题 '+i,'history-user-'+i);const answer=fixtureMessage('being','历史回复 '+i,'history-answer-'+i);answer.querySelector('.content').style.minHeight='150px';messages.append(user,answer);}messages.append(fixtureMessage('user','当前问题','current-user'));messages.scrollTop=400;})()");
      const before=await state();
      await mutate("fixtureBegin('reader-thinking');fixtureSet('在思考','内容增量');fixtureLog()");
      await mutate("fixtureRemoveThinking();fixtureSet('正在调用工具')");
      const after=await state();assert.equal(after.scrollTop,before.scrollTop);assert.equal(after.followWrites,before.followWrites);
      await mutate('fixtureClear()');
    });
    await check('bottom-follow-keeps-growing-preview-and-hint-visible',async()=>{
      await mutate("fixtureBegin('bottom-thinking');fixtureSet('在思考','开始检查。');document.getElementById('messages').scrollTop=document.getElementById('messages').scrollHeight");
      const before=await state();
      assert.ok(Math.abs(before.scrollTop+before.messages.height-before.scrollHeight)<2);
      let value=await mutate("fixtureRefs.bar.querySelector('.tui-preview').firstChild.data='正在核对安装步骤与扩展入口。'.repeat(20)");
      assert.ok(value.scrollTop>before.scrollTop,'Growing progress must keep the bottom visible while following.');
      assert.ok(value.wrapper.bottom<=value.messages.bottom+1);assert.ok(value.bar.y>=value.messages.y);
      value=await mutate("(() => {const hint=document.createElement('div');hint.className='tui-hint';hint.textContent='仍在等待工具回应，正在检查连接状态。'.repeat(10);fixtureRefs.bar.append(hint);})()");
      assert.ok(value.wrapper.bottom<=value.messages.bottom+1);assert.ok(value.bar.y>=value.messages.y);
      assert.ok(Math.abs(value.scrollTop+value.messages.height-value.scrollHeight)<2);
      await capture('04-growing-process-follows-bottom');
      await mutate("document.getElementById('messages').scrollTop=400");
      const reading=await state();
      value=await mutate("fixtureRefs.bar.querySelector('.tui-preview').firstChild.data+='继续核对。'.repeat(20);fixtureRefs.bar.querySelector('.tui-hint').firstChild.data+='仍在处理中。'.repeat(10)");
      assert.equal(value.scrollTop,reading.scrollTop,'Growing progress must leave a reader away from the bottom in place.');
      await mutate('fixtureRemoveThinking();fixtureClear()');
    });
    await check('narrow-layout-keeps-process-and-controls-inside-conversation',async()=>{
      win.setContentSize(520,800);
      await mutate("fixtureInitial();fixtureBegin('narrow-thinking');fixtureSet('在思考','正在检查 '.repeat(30));fixtureLog()");
      await click('.tui-thinking');
      await move(500,10);
      const value=await state();assertPlacement(value,'narrow-thinking');assert.equal(value.bodyWidth,value.viewport);
      assert.ok(value.wrapper.x>=0&&value.wrapper.right<=value.viewport);assert.ok(value.log.right<=value.wrapper.right+1);
      assert.ok(value.log.y>=value.bar.bottom);assert.equal(value.placeholders,0);
      await capture('03-inline-thinking-narrow');
    });
    await check('adapter-detach-restores-native-home-and-thinking-dots',async()=>{
      await win.webContents.executeJavaScriptInIsolatedWorld(ACTIVITY_WORLD_ID,[{code:'globalThis.__beingDesktopActivity.destroy()'}]);
      await settle();
      const value=await state();assert.equal(value.home,true);assert.equal(value.hosts,0);assert.equal(value.refs,true);
      assert.equal(await execute("getComputedStyle(document.querySelector('#narrow-thinking > .content')).display"),'flex');
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
