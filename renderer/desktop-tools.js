'use strict';
window.beingTools=(()=>{
  const $=id=>document.getElementById(id);
  let bridge,callbacks,state={browser:{tabs:[],activeTabId:null},console:{jobs:[]},link:{status:'disconnected'},requests:[],workspace:''};
  let opened=false,mode='browser',full=false,linkBusy=false,lastViewport='',frame=null,resizing=false,lastRequestResult='';
  const labels={desktop_browser_tabs:'查看浏览器标签',desktop_browser_open:'打开网页',desktop_browser_read:'读取网页内容',desktop_browser_click:'点击网页元素',desktop_browser_fill:'填写网页内容',desktop_browser_screenshot:'截取网页',desktop_console_run:'运行本机命令',desktop_console_status:'读取命令输出',desktop_console_stop:'停止命令'};
  function element(tag,className,content) {const el=document.createElement(tag);if(className)el.className=className;if(content!==undefined)el.textContent=content;return el;}
  function fail(error) {$('tools-link-details').hidden=false;$('tools-connection').setAttribute('aria-expanded','true');$('tools-error').hidden=false;$('tools-error').textContent=String(error?.message || '操作未完成').replace(/^Error invoking remote method '[^']+': Error: /,'');layout();}
  function accept(next) {state=next;render();}
  async function action(name,value) {
    $('tools-error').hidden=true;
    try {accept(await bridge.desktopAction(name,value));return true;}catch(error){fail(error);return false;}
  }
  function show(nextMode='browser') {
    mode=nextMode;opened=true;callbacks?.onOpen?.();
    $('desktop-tools').hidden=false;$('content-grid').classList.add('tools-open');
    render();callbacks?.onLayout?.();
    if(mode==='browser'&&!state.browser.tabs.length)void action('browser.new');
    if(mode==='console')window.beingTerminal?.show();else {window.beingTerminal?.hide();$('browser-address').focus();}
  }
  function hide() {
    window.beingTerminal?.hide();
    opened=false;full=false;$('desktop-tools').hidden=true;$('content-grid').classList.remove('tools-open','tools-full');
    render();callbacks?.onLayout?.();
  }
  function render() {
    if(!bridge)return;
    $('desktop-tools').classList.toggle('console-mode',mode==='console');
    const controls=mode==='console'?$('terminal-host').querySelector('.terminal-toolbar-actions'):$('desktop-tools').querySelector('.tools-heading');
    if(controls)for(const id of ['tools-connection','tools-expand','tools-close'])controls.append($(id));
    $('tools-browser-pane').hidden=mode!=='browser';$('tools-console-pane').hidden=mode!=='console';
    $('tools-browser-mode').setAttribute('aria-selected',String(mode==='browser'));
    $('tools-console-mode').setAttribute('aria-selected',String(mode==='console'));
    for(const [id,tool] of [['open-browser','browser'],['open-console','console']]){$(id).classList.toggle('active',opened&&mode===tool);$(id).setAttribute('aria-pressed',String(opened&&mode===tool));}
    const link=state.link.status,connected=link==='connected',connecting=link==='connecting';
    $('tools-link-status').textContent=({connected:'Being 工具已连接',connecting:'正在连接 Being…',error:'Being 工具连接失败',disconnected:'Being 工具未连接'})[link] || 'Being 工具未连接';
    $('tools-connection').title=$('tools-link-status').textContent;$('tools-connection').dataset.state=link;
    $('tools-link-dot').style.background=connected?'#64a57d':link==='error'?'#d07b72':'#777';
    $('tools-link-toggle').textContent=connected||connecting?'断开':'连接 Being 工具';$('tools-link-toggle').disabled=linkBusy;
    const activeJobs=state.console.jobs.filter(job=>['starting','running','stopping'].includes(job.status)).length;
    $('tools-link-hint').textContent=(state.link.reconnect ? `调度工具已断线，${Math.ceil(state.link.reconnect.delayMs/1000)} 秒后自动重连。` : state.link.error) || (connected?`每次调用单独确认；断开连接${activeJobs?`后 ${activeJobs} 条本机命令仍会运行`:'不会停止已启动的命令'}。`:activeJobs?`Being 工具未连接；仍有 ${activeJobs} 条本机命令运行，可在控制台手动停止。`:'连接后，Being 的页面和命令调用会在这里等待你确认。');
    if(state.requestResult && state.requestResult.id!==lastRequestResult){lastRequestResult=state.requestResult.id;if(state.requestResult.status==='failed')fail({message:`上一次 Being 调用：${state.requestResult.message}`});}
    renderRequests();renderBrowser();renderConsole();layout();
  }
  function renderRequests() {
    const host=$('tools-requests'),active=document.activeElement,focusKey=active?.dataset?.requestAction;
    host.replaceChildren();
    for(const request of state.requests || []) {
      const card=element('article','tools-request');
      card.append(element('strong','',`Being 请求：${labels[request.name] || request.name}`));
      const summary=request.name==='desktop_console_run'?`新建独立命令会话 · 非交互命令\n${request.args.cwd || '未选择目录'}\n\n${request.args.command}`:
        ['desktop_console_status','desktop_console_stop'].includes(request.name)?`${request.name==='desktop_console_status'?'读取以下命令截至执行时保留的状态与输出（每条最多 256 KiB，保留尾部，含审批后同一任务新增的输出）':'停止以下命令及桌面管理的子进程'}\n${(request.reviewJobs||[]).map(job=>`${job.id}\nPS ${job.cwd}> ${job.command}`).join('\n\n') || '没有可读取的命令'}`:
        `${request.target || ''}\n${request.targetSummary?`${request.targetSummary}\n`:''}${JSON.stringify(request.args,null,2)}`;
      card.append(element('pre','',summary));
      const buttons=element('div','tools-request-actions');
      for(const [name,label] of [['deny','拒绝'],['allow',request.status==='running'?'正在执行…':'允许本次']]) {
        const button=element('button',`button ${name==='allow'?'primary':'secondary'} small-button`,label);
        button.dataset.requestAction=`${request.id}:${name}`;button.disabled=request.status!=='pending';
        button.onclick=()=>{button.disabled=true;void action(`request.${name}`,request.id);};buttons.append(button);
      }
      card.append(buttons);host.append(card);
    }
    if(focusKey)host.querySelectorAll('button').forEach(button=>{if(button.dataset.requestAction===focusKey)button.focus({preventScroll:true});});
    const count=(state.requests || []).length,activeJobs=state.console.jobs.filter(job=>['starting','running','stopping'].includes(job.status)).length;
    $('tools-pending-count').hidden=!(count||activeJobs);$('tools-pending-count').textContent=count?String(count):`${activeJobs} 运行`;
    $('open-console').title=count?`${count} 个 Being 调用待确认`:`本机命令控制台${activeJobs?` · ${activeJobs} 个命令运行中`:''}`;
  }
  function renderBrowser() {
    const browser=state.browser,active=browser.tabs.find(tab=>tab.id===browser.activeTabId),host=$('browser-tabs');
    const currentFocus=document.activeElement?.dataset?.tabAction,scrollLeft=host.scrollLeft;
    host.replaceChildren();
    for(const tab of browser.tabs) {
      const row=element('div',`browser-tab${tab.id===browser.activeTabId?' active':''}`);
      const select=element('button','',`${tab.isLoading?'◦ ':''}${tab.title || '新标签页'}`);select.setAttribute('role','tab');select.setAttribute('aria-selected',String(tab.id===browser.activeTabId));select.title=tab.title || '新标签页';select.dataset.tabAction=`select:${tab.id}`;select.onclick=()=>void action('browser.activate',tab.id);
      const close=element('button','browser-tab-close','×');close.setAttribute('aria-label',`关闭 ${tab.title || '新标签页'}`);close.dataset.tabAction=`close:${tab.id}`;close.onclick=()=>void action('browser.close',tab.id);row.append(select,close);host.append(row);
    }
    if(currentFocus)host.querySelectorAll('button').forEach(button=>{if(button.dataset.tabAction===currentFocus)button.focus({preventScroll:true});});
    host.scrollLeft=scrollLeft;
    if(document.activeElement!==$('browser-address'))$('browser-address').value=active?.url || '';
    $('browser-back').disabled=!active?.canGoBack;$('browser-forward').disabled=!active?.canGoForward;
    $('browser-reload').disabled=!active?.url;
    $('browser-reload').setAttribute('aria-label',active?.isLoading?'停止加载':'刷新网页');
    $('browser-reload').querySelector('use').setAttribute('href',active?.isLoading?'#i-close':'#i-refresh');
    $('browser-empty').hidden=Boolean(active?.url&&!active.error);
    $('browser-empty-title').textContent=active?.error?'网页未能打开':'从一个网址开始';
    $('browser-empty-detail').textContent=active?.error || '在这里浏览资料、打开项目预览，与 Being 并排工作。';
    $('browser-load-status').textContent=active?.error || active?.notice || (active?.isLoading?'正在加载…':active?.url || '新标签页');
    $('browser-load-status').title=active?.error || active?.notice || active?.url || '';
  }
  function renderConsole() {
    window.beingTerminal?.updateJobs(state.console.jobs || []);
  }
  function layout() {
    if(frame!==null)cancelAnimationFrame(frame);
    frame=requestAnimationFrame(()=>{
      frame=null;const rect=$('browser-host').getBoundingClientRect();
      const active=state.browser.tabs.find(tab=>tab.id===state.browser.activeTabId);
      const payload={visible:opened&&mode==='browser'&&!resizing&&!document.hidden&&!$('sidebar-search-dialog')?.open&&Boolean(active?.url&&!active.error),bounds:{x:Math.max(0,Math.round(rect.x)),y:Math.max(0,Math.round(rect.y)),width:Math.max(0,Math.round(rect.width)),height:Math.max(0,Math.round(rect.height))}};
      const key=JSON.stringify(payload);if(key===lastViewport)return;lastViewport=key;
      void bridge.setBrowserView(payload).catch(error=>{lastViewport='';fail(error);});
    });
  }
  function init(options) {
    bridge=options.bridge;callbacks=options;if(!bridge?.getDesktopTools)return;
    window.beingTerminal?.init({bridge,host:$('terminal-host'),onSelectWorkspace:()=>callbacks.onSelectWorkspace?.(),onError:fail});
    [['open-browser','browser'],['open-console','console'],['tools-browser-mode','browser'],['tools-console-mode','console']].forEach(([id,next])=>$(id).onclick=()=>opened&&mode===next&&id.startsWith('open-')?hide():show(next));
    $('tools-close').onclick=hide;
    $('tools-expand').onclick=()=>{full=!full;$('content-grid').classList.toggle('tools-full',full);$('tools-expand').setAttribute('aria-label',full?'与对话并排':'展开工具面板');layout();callbacks.onLayout?.();};
    $('browser-new').onclick=()=>void action('browser.new');
    $('browser-back').onclick=()=>void action('browser.back');$('browser-forward').onclick=()=>void action('browser.forward');
    $('browser-reload').onclick=()=>void action(state.browser.tabs.find(t=>t.id===state.browser.activeTabId)?.isLoading?'browser.stop':'browser.reload');
    $('browser-address-form').onsubmit=event=>{event.preventDefault();const url=$('browser-address').value.trim(),active=state.browser.tabs.find(t=>t.id===state.browser.activeTabId);$('browser-address').blur();if(active?.url===url)return;void action(active?'browser.navigate':'browser.new',{...(active?{id:active.id}:{}),url});};
    $('browser-address').onfocus=event=>event.target.select();
    $('tools-connection').onclick=()=>{const details=$('tools-link-details');details.hidden=!details.hidden;$('tools-connection').setAttribute('aria-expanded',String(!details.hidden));if(details.hidden)$('tools-error').hidden=true;layout();};
    const resizer=$('tools-resizer');
    const setWidth=width=>{const total=$('content-grid').getBoundingClientRect().width;const bounded=Math.max(380,Math.min(total-285,width));$('content-grid').style.setProperty('--tools-width',`${Math.min(100,bounded/total*100)}%`);layout();callbacks.onLayout?.();};
    resizer.onpointerdown=event=>{if(event.button!==0||full)return;resizing=true;resizer.setPointerCapture(event.pointerId);layout();};
    resizer.onpointermove=event=>{if(resizing)setWidth($('content-grid').getBoundingClientRect().right-event.clientX);};
    resizer.onpointerup=resizer.onpointercancel=()=>{resizing=false;layout();};
    resizer.onkeydown=event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();setWidth($('desktop-tools').getBoundingClientRect().width+(event.key==='ArrowLeft'?24:-24));}};
    $('tools-link-toggle').onclick=async()=>{if(linkBusy)return;linkBusy=true;render();await action(['connected','connecting'].includes(state.link.status)?'link.disconnect':'link.connect');linkBusy=false;render();};
    new ResizeObserver(layout).observe($('browser-host'));window.addEventListener('resize',layout);document.addEventListener('visibilitychange',layout);
    bridge.onToolsState(accept);void bridge.getDesktopTools().then(accept).catch(fail);
  }
  return {init,show,hide};
})();
