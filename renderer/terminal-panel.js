'use strict';
window.beingTerminal=(()=>{
  let bridge,host,callbacks,toolbar,tabs,stage,empty,menu,newButton,menuButton,stopButton;
  let state={sessions:[],activeSessionId:null},jobs=[],selected='',visible=false,initialized=false,started=false,creating=false,disposed=false;
  let ready=Promise.resolve(),resizeObserver,fitFrame=null,fontZoom=0;
  const entries=new Map(),closedJobs=new Set(),unsubscribers=[];
  const iconPaths={terminal:'m4 5 5 5-5 5m7 0h5',plus:'M10 4v12M4 10h12',chevron:'m6 8 4 4 4-4',close:'m6 6 8 8m0-8-8 8',stop:'M6 6h8v8H6z',folder:'M2.5 6.5h15v10h-15zm0 0v-3h5l2 3'};
  function element(tag,className,text) {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
  function icon(name) {
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 20 20');svg.setAttribute('aria-hidden','true');
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',iconPaths[name]);svg.append(path);return svg;
  }
  function button(label,name,onClick) {const node=element('button','terminal-icon-button');node.type='button';node.title=label;node.setAttribute('aria-label',label);node.append(icon(name));node.addEventListener('click',onClick);return node;}
  function fail(error) {if(!disposed)callbacks?.onError?.(error);}
  function keyFor(id) {return `shell:${id}`;}
  function busy(job) {return ['starting','running','stopping'].includes(job?.status);}
  function sessionFor(entry) {return state.sessions.find(item=>item.id===entry.id);}
  function typography() {const style=getComputedStyle(document.documentElement),size=parseFloat(style.getPropertyValue('--text-code'));return {fontFamily:style.getPropertyValue('--font-mono').trim()||'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',fontSize:Math.max(8,Math.min(32,([12,13,14].includes(size)?size:12)+fontZoom)),cursorBlink:!matchMedia('(prefers-reduced-motion: reduce)').matches};}
  function terminalTheme() {
    const style=getComputedStyle(document.documentElement),background=style.getPropertyValue('--background').trim()||'#181818',foreground=style.getPropertyValue('--text').trim()||'#dfdfdf';
    const selection=/^#[\da-f]{6}$/i.test(foreground)?`${foreground}33`:style.getPropertyValue('--line').trim()||'#ffffff1a';
    return {background,foreground,cursor:foreground,cursorAccent:background,selectionBackground:selection,selectionInactiveBackground:selection,black:'#181818',red:'#e2777a',green:'#9bbd91',yellow:'#d6bb85',blue:'#8aa9d6',magenta:'#ba9bd2',cyan:'#84b8bc',white:'#dfdfdf',brightBlack:'#777777',brightRed:'#ee9294',brightGreen:'#b3d2a9',brightYellow:'#e4d0a6',brightBlue:'#abc3e6',brightMagenta:'#d0b5e3',brightCyan:'#a2d0d3',brightWhite:'#f1f1f1'};
  }
  function refreshTheme() {if(disposed)return;const theme=terminalTheme();for(const entry of entries.values())entry.terminal.options.theme={...theme};}
  function activeEntry() {return entries.get(selected);}
  function setSelected(key,{focus=true}={}) {
    if(!entries.has(key))return;
    selected=key;renderTabs();renderStage();fit();
    const entry=entries.get(key);
    if(entry.kind==='shell'&&state.activeSessionId!==entry.id)void action('activate',entry.id);
    if(focus&&visible)entry.terminal.focus();
  }
  async function action(name,value) {
    try {const result=await bridge.terminalAction(name,value);if(result?.sessions)accept(result);return result;}catch(error){fail(error);return null;}
  }
  function terminalOptions(readonly=false) {
    return {...typography(),fontWeight:400,lineHeight:1.2,letterSpacing:0,cursorStyle:'bar',cursorWidth:1,scrollback:5000,allowProposedApi:false,allowTransparency:false,convertEol:readonly,disableStdin:readonly,drawBoldTextInBrightColors:false,minimumContrastRatio:1,theme:terminalTheme()};
  }
  function createEntry(id,kind) {
    const key=`${kind}:${id}`;
    if(entries.has(key))return entries.get(key);
    const surface=element('div','terminal-session');surface.hidden=true;surface.dataset.terminalId=id;surface.setAttribute('role','tabpanel');surface.setAttribute('aria-label',kind==='shell'?'PowerShell 终端':'Being 命令输出');
    const terminal=new window.Terminal(terminalOptions(kind==='job')),fitAddon=new window.FitAddon.FitAddon();
    const mount=element('div','terminal-mount');surface.append(mount);terminal.loadAddon(fitAddon);stage.append(surface);terminal.open(mount);
    const entry={key,id,kind,surface,terminal,fitAddon,sequence:0,replaying:false,pending:[],replayGeneration:0,writes:Promise.resolve(),lastSize:'',jobText:'',exitText:'',disposables:[]};
    entries.set(key,entry);
    terminal.attachCustomKeyEventHandler(event=>{
      if(event.type!=='keydown')return true;
      const modifier=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();
      if(modifier&&key==='c'&&(event.shiftKey||terminal.hasSelection())) {event.preventDefault();void copy(entry);return false;}
      if((modifier&&key==='v')||(event.shiftKey&&event.key==='Insert')) {event.preventDefault();if(kind==='shell')void paste(entry);return false;}
      if(modifier&&['+','=','-','0'].includes(key)){event.preventDefault();event.stopPropagation();fontZoom=key==='0'?0:Math.max(-6,Math.min(20,fontZoom+(key==='-'?-1:1)));fit();return false;}
      return true;
    });
    surface.addEventListener('contextmenu',event=>{event.preventDefault();if(terminal.hasSelection())void copy(entry);else if(kind==='shell')void paste(entry);});
    if(kind==='shell') {
      entry.disposables.push(terminal.onData(data=>write(entry,data)));
      entry.disposables.push(terminal.onResize(({cols,rows})=>resize(entry,cols,rows)));
      void replay(entry);
    }
    return entry;
  }
  function removeEntry(key) {const entry=entries.get(key);if(!entry)return;entry.replayGeneration++;entry.disposables.forEach(item=>item.dispose());entry.terminal.dispose();entry.surface.remove();entries.delete(key);}
  function write(entry,data) {
    if(disposed||entry.kind!=='shell'||!['running','starting'].includes(sessionFor(entry)?.status))return;
    entry.writes=entry.writes.then(()=>bridge.terminalAction('write',{id:entry.id,data})).catch(fail);
  }
  async function copy(entry) {const text=entry.terminal.getSelection();if(!text)return;try{await bridge.copyDesktopText(text);}catch(error){fail(error);}}
  async function paste(entry) {
    if(entry.kind!=='shell'||!['running','starting'].includes(sessionFor(entry)?.status))return;
    try {const text=await bridge.readNativeText();if(typeof text==='string'&&text&&entries.get(entry.key)===entry&&['running','starting'].includes(sessionFor(entry)?.status))entry.terminal.paste(text);}catch(error){fail(error);}
  }
  function resize(entry,cols,rows) {
    if(entry.kind!=='shell'||cols<2||rows<1||!['running','starting'].includes(sessionFor(entry)?.status))return;
    const size=`${cols}:${rows}`;if(entry.lastSize===size)return;entry.lastSize=size;
    void bridge.terminalAction('resize',{id:entry.id,cols,rows}).catch(error=>{entry.lastSize='';fail(error);});
  }
  async function replay(entry) {
    if(disposed||entries.get(entry.key)!==entry)return;
    const generation=++entry.replayGeneration;entry.replaying=true;
    try {
      const snapshot=await bridge.readTerminal(entry.id);
      if(disposed||entries.get(entry.key)!==entry||generation!==entry.replayGeneration)return;
      entry.terminal.reset();entry.sequence=Number(snapshot.sequence)||0;
      if(snapshot.truncated)entry.terminal.write('\x1b[90m[较早的终端输出已截断]\x1b[0m\r\n');
      if(snapshot.data)entry.terminal.write(snapshot.data);
      const pending=entry.pending;entry.pending=[];entry.replaying=false;
      for(const event of pending.sort((a,b)=>a.sequence-b.sequence))receive(event);
    }catch(error){if(entries.get(entry.key)===entry&&generation===entry.replayGeneration){entry.replaying=false;fail(error);}}
  }
  function receive(event) {
    if(disposed||!event||typeof event.data!=='string')return;
    const entry=entries.get(keyFor(event.id));if(!entry)return;
    if(entry.replaying){entry.pending.push(event);return;}
    if(event.sequence<=entry.sequence)return;
    if(event.sequence>entry.sequence+1){entry.pending.push(event);void replay(entry);return;}
    entry.sequence=event.sequence;entry.terminal.write(event.data);
  }
  function accept(next) {
    if(disposed||!next||!Array.isArray(next.sessions))return;
    state=next;
    const ids=new Set(state.sessions.map(item=>keyFor(item.id)));
    for(const [key,entry] of entries)if(entry.kind==='shell'&&!ids.has(key))removeEntry(key);
    for(const session of state.sessions){const entry=createEntry(session.id,'shell');entry.terminal.options.disableStdin=!['running','starting'].includes(session.status);entry.surface.setAttribute('aria-label',`${session.title||'PowerShell'} · ${session.cwd||''}`);}
    if(!entries.has(selected))selected=keyFor(state.activeSessionId);
    if(!entries.has(selected))selected=entries.keys().next().value||'';
    renderTabs();renderStage();fit();
  }
  function renderTabs() {
    if(!initialized)return;
    const focusKey=document.activeElement?.dataset?.terminalAction,scrollLeft=tabs.scrollLeft;
    tabs.replaceChildren();
    for(const entry of entries.values()) {
      const session=entry.kind==='shell'?sessionFor(entry):jobs.find(job=>job.id===entry.id);
      if(!session)continue;
      const active=selected===entry.key,readonly=entry.kind==='job',running=readonly?busy(session):session.status==='running';
      const row=element('div',`terminal-tab${active?' active':''}`),select=element('button','terminal-tab-select');select.type='button';select.setAttribute('role','tab');select.setAttribute('aria-selected',String(active));select.tabIndex=active?0:-1;select.dataset.terminalAction=`select:${entry.key}`;select.title=readonly?`Being · 独立非交互命令（只读）\n${session.command}\n${session.cwd}`:`${session.title||'PowerShell'}\n${session.cwd}${running?'':`\n已退出${session.exitCode===null||session.exitCode===undefined?'':` (${session.exitCode})`}`}`;
      select.append(icon('terminal'),element('span','terminal-tab-title',readonly?'Being · 命令':session.title||'PowerShell'));
      if(!running)select.append(element('span','terminal-tab-ended','已退出'));
      select.addEventListener('click',()=>setSelected(entry.key));
      select.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const keys=[...entries.keys()],at=keys.indexOf(entry.key),next=event.key==='Home'?0:event.key==='End'?keys.length-1:(at+(event.key==='ArrowLeft'?-1:1)+keys.length)%keys.length;setSelected(keys[next],{focus:false});tabs.querySelectorAll('.terminal-tab-select')[next]?.focus();});
      const close=button(readonly?'关闭 Being 命令输出':running?'关闭并结束 PowerShell 会话':'关闭 PowerShell 终端','close',()=>void closeEntry(entry));close.classList.add('terminal-tab-close');close.dataset.terminalAction=`close:${entry.key}`;
      row.append(select,close);tabs.append(row);
    }
    tabs.scrollLeft=scrollLeft;
    if(focusKey)tabs.querySelectorAll('button').forEach(node=>{if(node.dataset.terminalAction===focusKey)node.focus({preventScroll:true});});
    newButton.disabled=creating;newButton.title=creating?'正在启动 PowerShell…':'新建 PowerShell 终端';
    const active=activeEntry(),job=active?.kind==='job'?jobs.find(item=>item.id===active.id):null;
    stopButton.hidden=!busy(job);stopButton.disabled=job?.status==='stopping';
  }
  function renderStage() {if(!initialized)return;for(const entry of entries.values())entry.surface.hidden=entry.key!==selected;empty.hidden=Boolean(activeEntry());host.classList.toggle('terminal-panel-empty',!activeEntry());}
  async function create() {
    if(creating||disposed)return;creating=true;started=true;closeMenu();renderTabs();
    try {const result=await bridge.terminalAction('create',{});if(result?.sessionId)selected=keyFor(result.sessionId);accept(await bridge.getTerminalState());if(result?.sessionId)setSelected(keyFor(result.sessionId));}catch(error){fail(error);}finally{creating=false;renderTabs();}
  }
  async function closeEntry(entry) {
    if(entry.kind==='shell'){const result=await action('close',entry.id);if(!result)return;}
    else {closedJobs.add(entry.id);removeEntry(entry.key);if(selected===entry.key)selected=entries.keys().next().value||'';renderTabs();renderStage();fit();}
    activeEntry()?.terminal.focus();
  }
  function closeMenu() {if(menu){menu.hidden=true;menuButton?.setAttribute('aria-expanded','false');}}
  function menuItem(label,onClick,{disabled=false}={}) {const item=element('button','terminal-menu-item',label);item.type='button';item.disabled=disabled;item.addEventListener('click',()=>{closeMenu();onClick();});menu.append(item);return item;}
  function toggleMenu() {
    if(!menu.hidden){closeMenu();return;}
    menu.replaceChildren();menuItem('新建 PowerShell',()=>void create(),{disabled:creating});menuItem('选择工作目录…',()=>callbacks?.onSelectWorkspace?.());
    const active=activeEntry();menuItem('复制所选内容',()=>active&&void copy(active),{disabled:!active?.terminal.hasSelection()});menuItem('粘贴',()=>active&&void paste(active),{disabled:active?.kind!=='shell'||!['running','starting'].includes(sessionFor(active)?.status)});
    menuItem('清除终端显示',()=>active?.terminal.clear(),{disabled:!active});
    const hiddenJobs=jobs.filter(job=>closedJobs.has(job.id));
    if(hiddenJobs.length){menu.append(element('div','terminal-menu-separator'));menu.append(element('div','terminal-menu-caption','Being 独立命令（只读）'));for(const job of hiddenJobs)menuItem(job.command.replace(/\s+/g,' ').slice(0,90),()=>{closedJobs.delete(job.id);updateJobs(jobs);setSelected(`job:${job.id}`);});}
    menu.hidden=false;menuButton.setAttribute('aria-expanded','true');menu.querySelector('button')?.focus();
  }
  function updateJobs(nextJobs) {
    jobs=(nextJobs||[]).filter(job=>job.origin==='being');if(!initialized||disposed)return;
    const ids=new Set(jobs.map(job=>job.id));for(const [key,entry] of entries)if(entry.kind==='job'&&!ids.has(entry.id))removeEntry(key);
    for(const id of closedJobs)if(!ids.has(id))closedJobs.delete(id);
    for(const job of jobs) {
      if(closedJobs.has(job.id))continue;
      const entry=createEntry(job.id,'job'),output=(job.output||[]).map(chunk=>chunk.text||'').join('');
      const content=`PS ${job.cwd}> ${job.command}\r\n${job.truncated?'\x1b[90m[较早的输出已截断]\x1b[0m\r\n':''}${output}${job.error?`\r\n${job.error}`:''}`;
      const ending=busy(job)?'':`\r\n\x1b[90m[${job.status==='stopped'?'已停止':'进程已退出'}${job.exitCode===null||job.exitCode===undefined?'':`，退出代码 ${job.exitCode}`} · Being]\x1b[0m\r\n`;
      const next=content+ending;
      if(next!==entry.jobText){if(next.startsWith(entry.jobText))entry.terminal.write(next.slice(entry.jobText.length));else{entry.terminal.reset();entry.terminal.write(next);}entry.jobText=next;}
    }
    if(selected&&!entries.has(selected))selected=keyFor(state.activeSessionId);
    if(!entries.has(selected))selected=entries.keys().next().value||'';
    renderTabs();renderStage();fit();
  }
  function fit() {
    if(fitFrame!==null)cancelAnimationFrame(fitFrame);
    fitFrame=requestAnimationFrame(()=>{fitFrame=null;if(!visible||disposed)return;const entry=activeEntry();if(!entry||entry.surface.clientWidth<30||entry.surface.clientHeight<20)return;try{const settings=typography();for(const item of entries.values())for(const [key,value] of Object.entries(settings))if(item.terminal.options[key]!==value)item.terminal.options[key]=value;entry.fitAddon.fit();resize(entry,entry.terminal.cols,entry.terminal.rows);}catch(error){fail(error);}});
  }
  async function show() {visible=true;await ready;if(disposed||!visible)return;if(!started){started=true;if(!state.sessions.length)await create();}fit();requestAnimationFrame(()=>{if(visible)activeEntry()?.terminal.focus();});}
  async function reveal(id) {
    await ready;if(disposed)return false;
    accept(await bridge.getTerminalState());
    if(!entries.has(keyFor(id)))return false;
    setSelected(keyFor(id),{focus:false});await show();
    await new Promise(resolve=>requestAnimationFrame(resolve));
    return visible && selected===keyFor(id) && host.getBoundingClientRect().width>0 && host.getBoundingClientRect().height>0;
  }
  function hide() {visible=false;closeMenu();}
  function init(options) {
    if(initialized)return;
    bridge=options.bridge;host=options.host;callbacks=options;
    if(!host||!window.Terminal||!window.FitAddon?.FitAddon){fail(new Error('终端组件未能加载'));return;}
    initialized=true;host.classList.add('terminal-panel');
    toolbar=element('div','terminal-toolbar');tabs=element('div','terminal-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','终端');
    const actions=element('div','terminal-toolbar-actions');
    stopButton=button('停止 Being 命令','stop',()=>{const entry=activeEntry();if(entry?.kind==='job')void bridge.desktopAction('console.stop',entry.id).catch(fail);});stopButton.hidden=true;
    newButton=button('新建 PowerShell 终端','plus',()=>void create());menuButton=button('终端选项','chevron',toggleMenu);menuButton.setAttribute('aria-haspopup','menu');menuButton.setAttribute('aria-expanded','false');actions.append(stopButton,newButton,menuButton);toolbar.append(tabs,actions);
    stage=element('div','terminal-stage');empty=element('div','terminal-empty');const open=element('button','terminal-open-button','打开 PowerShell');open.type='button';open.prepend(icon('terminal'));open.addEventListener('click',()=>void create());empty.append(open);stage.append(empty);
    menu=element('div','terminal-menu');menu.hidden=true;menu.setAttribute('aria-label','终端选项');host.replaceChildren(toolbar,stage,menu);
    const outside=event=>{if(!menu.contains(event.target)&&!menuButton.contains(event.target))closeMenu();};document.addEventListener('pointerdown',outside);unsubscribers.push(()=>document.removeEventListener('pointerdown',outside));
    menu.addEventListener('keydown',event=>{if(event.key==='Escape'){closeMenu();menuButton.focus();event.preventDefault();}if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=[...menu.querySelectorAll('button:not(:disabled)')],at=items.indexOf(document.activeElement),index=event.key==='Home'?0:event.key==='End'?items.length-1:(at+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;items[index]?.focus();}});
    unsubscribers.push(bridge.onTerminalData(receive),bridge.onTerminalState(accept));
    if(bridge.onState)unsubscribers.push(bridge.onState(fit));
    const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');reducedMotion.addEventListener('change',fit);unsubscribers.push(()=>reducedMotion.removeEventListener('change',fit));
    window.addEventListener('being-theme-change',refreshTheme);unsubscribers.push(()=>window.removeEventListener('being-theme-change',refreshTheme));
    resizeObserver=new ResizeObserver(fit);resizeObserver.observe(stage);
    ready=bridge.getTerminalState().then(accept).catch(fail);updateJobs(jobs);renderTabs();renderStage();
  }
  function dispose() {disposed=true;visible=false;resizeObserver?.disconnect();if(fitFrame!==null)cancelAnimationFrame(fitFrame);unsubscribers.forEach(unsubscribe=>{if(typeof unsubscribe==='function')unsubscribe();});for(const key of entries.keys())removeEntry(key);host?.replaceChildren();}
  return {init,show,reveal,hide,fit,updateJobs,dispose};
})();
