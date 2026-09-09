'use strict';
window.beingOrchestration=(()=>{
  const $=id=>document.getElementById(id);
  const node=(tag,cls,text)=>{const el=document.createElement(tag);if(cls)el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const names={starting:'正在启动',queued:'排队中',running:'执行中',stopping:'正在停止',completed:'已完成',failed:'失败',cancelled:'已取消',interrupted:'已中断'};
  const reviews={pending:'待验收',processing:'Being 验收中',passed:'验收通过',failed:'验收未通过',needs_verification:'待补充验证',cancelled:'接续已停止'};
  const deliveries={pending:'待通知',sending:'正在通知',retrying:'通知重试中',accepted:'Heart 已接收',failed:'通知失败',suppressed:'通知已停止'};
  const active=worker=>['starting','running','queued','stopping'].includes(worker.status);
  let bridge,onOpen,onBack,onUpdate,snapshot={mode:{enabled:false,defaultAgent:'codex',paths:{}},agents:[],workers:[]},selected='',revision=0,busy=false,dirty=false,refreshTimer;
  const collapsed=new Set(),paths=new Map();
  const collapsedStorageKey='being.workerGroups.collapsed';
  try {
    const saved=JSON.parse(localStorage.getItem(collapsedStorageKey)||'[]');
    if(Array.isArray(saved))for(const id of saved)if(typeof id==='string')collapsed.add(id);
  } catch { /* Keep toggles usable when local storage is unavailable. */ }
  const say=(text,status='info')=>{$('orchestration-status').textContent=text;$('orchestration-status').dataset.status=status;};
  function controls() {
    const enabled=$('orchestration-enabled').checked;
    $('orchestration-settings').dataset.modeDisabled=String(!enabled);
    $('orchestration-enabled').disabled=busy;
    for(const id of ['orchestration-default','agent-kit-detect','worker-reconnect'])$(id).disabled=busy||!enabled;
    // Saving must remain possible when switching off a previously enabled mode.
    $('orchestration-save').disabled=busy||(!enabled&&!snapshot.mode.enabled);
    for(const input of paths.values())input.disabled=busy||!enabled;
  }
  async function perform(action) {
    if(busy)return;busy=true;controls();
    try{await action();}catch(error){say((error.message||'操作失败，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,''),'error');}
    finally{busy=false;controls();}
  }
  function draft(){return {enabled:$('orchestration-enabled').checked,defaultAgent:$('orchestration-default').value,paths:Object.fromEntries([...paths].map(([id,input])=>[id,input.value.trim()]))};}
  function renderAgents() {
    for(const [id] of paths) {
      const agent=snapshot.agents.find(item=>item.id===id),text=$('agent-state-'+id);
      text.textContent=agent?`${{ready:'可执行',missing:'未安装',needs_auth:'需要登录',incompatible:'接口不兼容',error:'检测失败'}[agent.status]||agent.status} · ${agent.detail}`:'尚未检测';
      text.dataset.status=agent?.status||'unknown';
      text.title=agent?.path||'';
    }
  }
  function setState(value) {
    if(!value?.mode)return;snapshot=value;
    if(!dirty&&paths.size) {
      $('orchestration-enabled').checked=value.mode.enabled;
      $('orchestration-default').value=value.mode.defaultAgent;
      for(const [id,input] of paths)input.value=value.mode.paths?.[id]||'';
      if(!busy)say(value.mode.enabled?'本机编排模式已开启，Being 通过本机工具桥调度 Worker。':'本机为直接模式。开启编排时会检测本机 Agent 与工具绑定。');
    }
    if(paths.size){renderAgents();controls();}
    if(value.enforcement?.detail && $('orchestration-policy-status'))$('orchestration-policy-status').textContent=value.enforcement.detail;
    if(selected&&!snapshot.workers.some(worker=>worker.id===selected)) {selected='';revision++;$('page-workers').replaceChildren(node('p','worker-empty','当前连接下没有此 worker。'));}
    if(selected&&!refreshTimer)refreshTimer=setTimeout(()=>{refreshTimer=null;void showWorker(selected,false);},120);
    onUpdate?.();
  }
  function appendSession(parent,sessionId) {
    const workers=(snapshot.workers||[]).filter(worker=>worker.sessionId===sessionId);
    if(!workers.length)return;
    const root=node('div','session-workers'),toggle=node('button','worker-group-toggle');
    const arrow=node('span','worker-group-arrow'),summary=node('span','worker-group-summary',`${workers.length} 个 Worker · ${workers.filter(active).length} 执行中`),action=node('span','worker-group-action');
    const list=node('div','worker-group-list');list.id=`session-workers-${sessionId}`;
    arrow.setAttribute('aria-hidden','true');toggle.type='button';toggle.setAttribute('aria-controls',list.id);
    toggle.append(arrow,summary,action);
    function updateExpanded() {
      const expanded=!collapsed.has(sessionId);
      list.hidden=!expanded;toggle.setAttribute('aria-expanded',String(expanded));
      arrow.textContent=expanded?'▾':'▸';action.textContent=expanded?'收起':'展开';
      toggle.title=expanded?'收起 Worker 列表':'展开 Worker 列表';
    }
    toggle.addEventListener('click',()=>{
      if(collapsed.has(sessionId))collapsed.delete(sessionId);else collapsed.add(sessionId);
      try {localStorage.setItem(collapsedStorageKey,JSON.stringify([...collapsed]));} catch { /* In-memory state still works without storage. */ }
      updateExpanded();
    });
    updateExpanded();root.append(toggle,list);
    for(const worker of workers) {
      const button=node('button','worker-shortcut');button.type='button';button.dataset.status=worker.status;
      const dot=node('span','worker-dot');dot.setAttribute('aria-hidden','true');
      const label=node('span','worker-shortcut-label');label.append(node('span','worker-title',worker.title),node('small','worker-caption',`${worker.agentId} · ${names[worker.status]||worker.status}${worker.review?' · '+(reviews[worker.review.status]||worker.review.status):''}`));
      button.append(dot,label);button.title=`${worker.title}\n${worker.detail}`;button.addEventListener('click',()=>{void showWorker(worker.id,true);});list.append(button);
    }
    parent.append(root);
  }
  async function showWorker(id,open) {
    if(!id)return;selected=id;const ticket=++revision;
    if(open)onOpen?.();
    try {
      const worker=await bridge.getWorker(id);if(ticket!==revision||selected!==id)return;
      const root=$('page-workers'),scroll=root.scrollTop;
      const header=node('header','worker-detail-header'),back=node('button','button secondary','返回会话');back.type='button';back.addEventListener('click',()=>{selected='';revision++;onBack?.();});
      header.append(back,node('span','worker-state',names[worker.status]||worker.status));
      if(active(worker)) {
        const stop=node('button','button secondary','停止 Worker');stop.type='button';stop.disabled=worker.status==='stopping';
        stop.addEventListener('click',async()=>{stop.disabled=true;try{await bridge.cancelWorker(id);await showWorker(id,false);}catch(error){root.append(node('p','worker-error',error.message));stop.disabled=false;}});header.append(stop);
      }
      if(worker.completion&&['pending','processing'].includes(worker.review?.status)&&!active(worker)) {
        const stop=node('button','button secondary','停止接续');stop.type='button';
        stop.addEventListener('click',async()=>{stop.disabled=true;try{await bridge.cancelWorker(id);await showWorker(id,false);}catch(error){root.append(node('p','worker-error',error.message));stop.disabled=false;}});header.append(stop);
      }
      if(worker.completion&&(['failed','retrying'].includes(worker.completion.state)||worker.completion.state==='accepted'&&worker.review?.status==='pending'&&['accepted','uncertain','failed'].includes(worker.completion.continuation?.state))) {
        const retry=node('button','button secondary',worker.completion.state==='accepted'?'重新接续':'重试通知');retry.type='button';retry.disabled=!snapshot.mode.enabled;
        retry.addEventListener('click',async()=>{retry.disabled=true;try{await bridge.retryWorkerCallback(id);await showWorker(id,false);}catch(error){root.append(node('p','worker-error',error.message));retry.disabled=false;}});header.append(retry);
      }
      const meta=node('p','worker-detail-meta',`${worker.agentId} · 会话 ${worker.sessionId}\n${worker.cwd}`);
      const result=node('pre','worker-result',worker.result||'尚无执行结果');
      const events=node('div','worker-events');
      for(const event of worker.events) {
        const row=node('details','worker-event');row.dataset.kind=event.kind;
        const label=event.kind==='tool'?`${event.name||'工具'} · ${event.status}`:event.kind==='message'?'Agent 输出':event.kind==='error'?'执行错误':event.kind==='result'?'执行结果':event.kind==='session'?'Agent 会话':event.kind==='log'?'运行日志':'执行状态';
        row.append(node('summary','',`${new Date(event.at).toLocaleTimeString('zh-CN')}  ${label}`),node('pre','', [event.text,event.output,event.sessionId].filter(Boolean).join('\n')||label));
        // Keep expanded events open across streamed updates.
        row.dataset.seq=String(event.seq);row.open=Boolean(root.querySelector(`details[data-seq="${event.seq}"]`)?.open);events.append(row);
      }
      root.replaceChildren(header,node('h2','worker-detail-title',worker.title),meta,node('p','worker-detail-note',worker.detail),node('h3','','执行结果'),result,node('h3','','工具调用与事件'),events);
      if(worker.completion) {
        const review=node('section','worker-review');
        review.append(node('h3','','结果通知与验收'),node('p','',`${deliveries[worker.completion.state]||worker.completion.state} · ${reviews[worker.review?.status]||'待验收'}`),node('p','field-help',worker.completion.detail));
        if(worker.completion.continuation)review.append(node('p','field-help',({sending:'正在唤醒 Being 接续验收。',accepted:'自动接续已提交。',retrying:'模型服务暂时出错，等待重试验收。',failed:'验收接续失败，可重新接续。',uncertain:'自动接续状态未确认，请检查原会话；不会重复执行 Worker。'})[worker.completion.continuation.state]||''));
        if(worker.review?.summary)review.append(node('pre','worker-result',worker.review.summary),node('p','field-help','验收依据'),node('pre','worker-result',worker.review.evidence));
        root.insertBefore(review,result.previousSibling);
      }
      if(worker.truncated)root.append(node('p','field-help','仅保留最近 300 条事件；早期事件已截断。'));
      if(!open)root.scrollTop=scroll;
    }catch(error){if(ticket===revision)$('page-workers').replaceChildren(node('p','worker-error',error.message));}
  }
  function init(options) {
    ({bridge,onOpen,onBack,onUpdate}=options);if(!bridge?.getOrchestration)return;
    for(const [id,name] of [['codex','Codex CLI'],['cursor','Cursor CLI'],['grok','Grok Build CLI']]) {
      const row=node('div','agent-kit-row'),label=node('label','',name),input=node('input');input.id='agent-path-'+id;input.placeholder='自动从 PATH 检测，或填写程序绝对路径';input.type='text';label.htmlFor=input.id;
      const status=node('p','field-help','尚未检测');status.id='agent-state-'+id;paths.set(id,input);input.addEventListener('input',()=>{dirty=true;});row.append(label,input,status);$('agent-kit-list').append(row);
    }
    $('orchestration-default').addEventListener('change',()=>{dirty=true;controls();say('默认 Agent 尚未保存。');});
    async function saveMode(toggle=false) {
      await perform(async()=>{
        say('正在检测本机 Agent 并确认 Desktop 工具绑定…');
        try{const result=await bridge.saveOrchestration(draft());dirty=false;setState(result);say(result.mode.enabled?'本机编排模式已开启，Being 通过本机工具桥调度 Worker。':'编排模式已关闭。');}
        catch(error){if(toggle)$('orchestration-enabled').checked=snapshot.mode.enabled;controls();throw error;}
      });
    }
    $('orchestration-enabled').addEventListener('change',()=>{dirty=true;void saveMode(true);});
    $('agent-kit-detect').addEventListener('click',()=>{void perform(async()=>{say('正在检测程序与执行接口…');snapshot.agents=await bridge.inspectAgents(draft().paths);renderAgents();say('检测完成。可执行不代表任务必定成功；登录和权限错误会显示在 worker 事件中。');});});
    $('orchestration-save').addEventListener('click',()=>{void saveMode();});
    $('worker-reconnect').addEventListener('click',()=>{void perform(async()=>{const result=await bridge.reconnectWorkers();say(result.status==='connected'?'调度工具已连接。':'调度工具未连接，请确认 Being 连接和编排模式。');});});
    bridge.onWorkers?.(setState);
    bridge.onToolsState?.(value=>{$('worker-link-status').textContent='调度连接：'+({connected:'已连接',connecting:'连接中',disconnected:'未连接',error:'连接失败'}[value.link?.status]||'未知');});
    controls();
    void bridge.getOrchestration().then(setState).catch(()=>{});
  }
  return {init,setState,appendSession};
})();
