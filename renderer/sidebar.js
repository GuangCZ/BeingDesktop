'use strict';
window.beingSidebar = (() => {
  const $ = id => document.getElementById(id);
  const el = (tag, className, text) => {const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const icon = name => {const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('class','icon');svg.setAttribute('aria-hidden','true');const use=document.createElementNS(svg.namespaceURI,'use');use.setAttribute('href',`#i-${name}`);svg.append(use);return svg;};
  const basename = value => value?.split(/[\\/]/).filter(Boolean).at(-1) || value || '项目';
  const errorMessage = error => String(error?.message || '操作未完成，请重试。').replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
  let options, state={}, page='chat', townModule='', signature='', busy=false, menuAnchor, menuScope='', searchFilter='active', searchIndex=0, searchItems=[];
  const readPreference = (key, fallback) => {try{return JSON.parse(localStorage.getItem(`being-sidebar-v1:${key}`)) ?? fallback;}catch{return fallback;}};
  const savePreference = (key, value) => {try{localStorage.setItem(`being-sidebar-v1:${key}`,JSON.stringify(value));}catch{}};
  const foldKey = key => `${state.sidebar?.scope || 'local'}:${key}`;
  const folded = key => readPreference(foldKey(key),false);
  const metadata = id => state.sidebar?.tasks?.[id] || {};
  const timestamp = value => typeof value==='number' && Number.isFinite(value) ? value : Date.parse(value || '') || 0;
  const connected = () => state.connection?.status === 'connected';
  const tasks = () => state.connection?.configured ? state.chatSessions?.items || [] : [];
  const age = item => {
    const at = Math.max(metadata(item.id).touchedAt || 0, timestamp(item.updatedAt || item.createdAt));
    if(!at)return '';
    const minutes=Math.max(0,Math.floor((Date.now()-at)/60000));
    return minutes<1?'刚刚':minutes<60?`${minutes}分`:minutes<1440?`${Math.floor(minutes/60)}时`:`${Math.floor(minutes/1440)}天`;
  };
  const ordered = () => tasks().map((item,index)=>({item,index})).sort((a,b)=>{
    const time = item => Math.max(metadata(item.id).touchedAt || 0,timestamp(item.updatedAt || item.createdAt));
    return time(b.item)-time(a.item) || a.index-b.index;
  }).map(entry=>entry.item);
  function button(label, name, action, className='icon-button compact') {
    const node=el('button',className);node.type='button';node.title=label;node.setAttribute('aria-label',label);if(name)node.append(icon(name));else node.textContent=label;
    node.addEventListener('click',action);return node;
  }
  function toggleFold(key) {savePreference(foldKey(key),!folded(key));signature='';render();}
  function updateSection(key) {
    $(`sidebar-${key}-content`).hidden=folded(key);
    $(`sidebar-${key}-toggle`).setAttribute('aria-expanded',String(!folded(key)));
  }
  async function mutate(type,id,project) {
    if(busy)return false;
    busy=true;
    try {
      const result=await options.bridge.sidebarAction({scope:state.sidebar?.scope,type,id,project});
      options.acceptState(result);return true;
    } catch(error) {options.showToast(errorMessage(error),true);return false;}
    finally {busy=false;signature='';render();}
  }
  async function select(id,project='') {
    if(busy)return;
    busy=true;renderBusy();
    try {await options.selectSession(id,project);}
    finally {busy=false;renderBusy();signature='';render();}
  }
  function renderBusy() {
    for(const id of ['new-chat-session','sidebar-new-session'])$(id).disabled=busy || !connected();
    document.querySelectorAll('.project-new-task').forEach(node=>{node.disabled=busy || !connected();});
  }
  function taskRow(item,container) {
    const row=el('div','sidebar-task-row');row.dataset.taskId=item.id;
    const selectButton=button(item.title || '新会话',null,()=>void select(item.id),'session-shortcut');
    selectButton.replaceChildren();selectButton.dataset.sessionId=item.id;selectButton.dataset.sidebarKey=`task:${item.id}`;
    const active=page==='chat' && item.id===state.chatSessions?.activeId;
    selectButton.classList.toggle('active',active);if(active)selectButton.setAttribute('aria-current','page');
    const activity=state.chatSessionActivity?.[item.id];
    const dot=el('span',`session-activity-light ${activity==='talking'?'talking':activity==='waiting'?'waiting':'inactive'}`);
    dot.style.animationDelay=`-${(document.timeline.currentTime || 0)%2400}ms`;dot.setAttribute('aria-hidden','true');
    selectButton.append(dot,el('span','session-title',item.title || '新会话'),el('span','task-age',age(item)));
    const activityLabel=activity==='talking'?'进行中':activity==='waiting'?'等待回复':'';
    selectButton.setAttribute('aria-label',`${item.title || '新会话'}${activityLabel?`，${activityLabel}`:''}`);
    selectButton.title=[item.title,activityLabel,metadata(item.id).project].filter(Boolean).join('\n');
    selectButton.disabled=!connected();
    const more=button(`会话「${item.title}」的更多操作`,'more',()=>taskMenu(item,more),'icon-button compact task-more');more.dataset.sidebarKey=`menu:${item.id}`;more.setAttribute('aria-haspopup','menu');
    row.addEventListener('contextmenu',event=>{event.preventDefault();taskMenu(item,more);});
    row.append(selectButton,more);container.append(row);
    window.beingOrchestration?.appendSession(container,item.id);
  }
  function render() {
    if(!options)return;
    $('sidebar-profile-name').textContent=state.connection?.beingName || 'Being';
    $('sidebar-profile-status').textContent=connected()?'已连接':state.connection?.status==='connecting'?'连接中…':'未连接';
    $('sidebar-profile').title=`Being Desktop ${state.version || ''}`;
    let townShortcutSelected=false;
    document.querySelectorAll('.primary-nav [data-town-module]').forEach(button=>{
      const selected=page==='town-app' && button.dataset.townModule===townModule;
      button.classList.toggle('active',selected);
      if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
      townShortcutSelected ||= selected;
    });
    const appsSelected=page==='town' || (page==='town-app' && !townShortcutSelected);
    $('sidebar-apps').classList.toggle('active',appsSelected);
    if(appsSelected)$('sidebar-apps').setAttribute('aria-current','page');else $('sidebar-apps').removeAttribute('aria-current');
    renderBusy();
    if(document.querySelector('.session-editing'))return;
    const next=JSON.stringify([state.sidebar,state.chatSessions,state.chatSessionActivity,state.orchestration,state.workspace?.path,connected(),page]);
    if(signature===next)return;signature=next;
    const focusKey=document.activeElement?.dataset.sidebarKey, scroll=$('sidebar-scroll').scrollTop;
    for(const id of ['sidebar-pinned-content','sidebar-project-content','chat-session-list'])$(id).replaceChildren();
    for(const key of ['pinned','project','session'])updateSection(key);
    const visible=ordered().filter(item=>!metadata(item.id).archived);
    const pinned=visible.filter(item=>metadata(item.id).pinned);
    $('sidebar-pinned').hidden=!pinned.length;
    for(const item of pinned)taskRow(item,$('sidebar-pinned-content'));
    const projects=state.sidebar?.projects || (state.workspace?.path?[state.workspace.path]:[]);
    for(const [index,project] of projects.entries()) {
      const group=el('div','sidebar-project-group');group.dataset.projectPath=project;
      const heading=el('div','sidebar-project-row');
      const toggle=button(basename(project),null,()=>toggleFold(`folder:${project}`),'workspace-shortcut project-toggle');
      toggle.replaceChildren();toggle.dataset.sidebarKey=`project:${project}`;
      toggle.append(icon('chevron'),icon('folder'),el('span','project-title',basename(project)));
      toggle.setAttribute('aria-expanded',String(!folded(`folder:${project}`)));toggle.title=project;
      if(index===0)toggle.id='workspace-shortcut';
      const add=button(`在 ${basename(project)} 中新建会话`,'plus',()=>void select(null,project),'icon-button compact project-new-task');add.disabled=busy || !connected();add.dataset.sidebarKey=`new:${project}`;
      const more=button(`项目 ${basename(project)} 的更多操作`,'more',()=>projectMenu(project,more),'icon-button compact project-more');more.setAttribute('aria-haspopup','menu');more.dataset.sidebarKey=`project-menu:${project}`;
      heading.append(toggle,add,more);
      heading.addEventListener('contextmenu',event=>{event.preventDefault();projectMenu(project,more);});
      const list=el('div','project-task-list');list.id=`project-tasks-${index}`;list.hidden=folded(`folder:${project}`);toggle.setAttribute('aria-controls',list.id);
      const children=visible.filter(item=>!metadata(item.id).pinned && metadata(item.id).project===project);
      for(const item of children)taskRow(item,list);
      if(!children.length){const empty=button('新建会话', 'plus',()=>void select(null,project),'project-empty-task');empty.append(el('span','','新建会话'));empty.disabled=!connected()||busy;list.append(empty);}
      group.append(heading,list);$('sidebar-project-content').append(group);
    }
    if(!projects.length) $('sidebar-project-content').append(button('添加项目文件夹','folder',()=>$('sidebar-select-workspace').click(),'workspace-shortcut'));
    const standalone=visible.filter(item=>!metadata(item.id).pinned && !projects.includes(metadata(item.id).project));
    for(const item of standalone)taskRow(item,$('chat-session-list'));
    $('session-empty').hidden=Boolean(standalone.length) || (!tasks().length && state.connection?.configured);
    $('session-empty').textContent=state.connection?.configured?'暂无独立会话':'连接 Being 后，会话会显示在这里。';
    $('active-session').hidden=!state.connection?.configured || Boolean(tasks().length);
    $('sidebar-scroll').scrollTop=scroll;
    if(focusKey)document.querySelectorAll('[data-sidebar-key]').forEach(node=>{if(node.dataset.sidebarKey===focusKey)node.focus({preventScroll:true});});
    if(menuAnchor?.dataset.sidebarKey && !menuAnchor.isConnected){const key=menuAnchor.dataset.sidebarKey;menuAnchor=[...document.querySelectorAll('[data-sidebar-key]')].find(node=>node.dataset.sidebarKey===key);menuAnchor?.setAttribute('aria-expanded','true');}
    if($('sidebar-search-dialog').open)renderSearch();
  }
  function closeMenu(restore=true) {
    $('sidebar-menu').hidden=true;menuAnchor?.setAttribute('aria-expanded','false');
    if(restore && menuAnchor?.isConnected)menuAnchor.focus({preventScroll:true});
    menuAnchor=null;
  }
  function menu(anchor,entries) {
    closeMenu(false);menuAnchor=anchor;menuScope=state.sidebar?.scope || '';
    const host=$('sidebar-menu');host.replaceChildren();host.hidden=false;anchor.setAttribute('aria-expanded','true');
    for(const entry of entries) {
      if(!entry){host.append(el('div','sidebar-menu-separator'));continue;}
      const node=button(entry.label,null,()=>{
        const key=menuAnchor?.dataset.sidebarKey, previous=menuAnchor;closeMenu(false);
        void Promise.resolve().then(()=>entry.action()).catch(error=>options.showToast(errorMessage(error),true)).finally(()=>{
          if(document.activeElement!==document.body)return;
          const target=key?[...document.querySelectorAll('[data-sidebar-key]')].find(node=>node.dataset.sidebarKey===key):previous;
          if(target?.isConnected)target.focus({preventScroll:true});
        });
      },'sidebar-menu-item');
      node.setAttribute('role','menuitem');node.disabled=!!entry.disabled;host.append(node);
    }
    const rect=anchor.getBoundingClientRect();
    host.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-host.offsetWidth-8))}px`;
    host.style.top=`${Math.max(8,Math.min(rect.bottom+4,innerHeight-host.offsetHeight-8))}px`;
    host.querySelector('button:not(:disabled)')?.focus();
  }
  function taskMenu(item,anchor) {
    const value=metadata(item.id);
    menu(anchor,[
      {label:value.pinned?'取消置顶':'置顶',action:()=>mutate('pin',item.id)},
      {label:'重命名',disabled:!connected(),action:()=>{const target=document.querySelector(`.session-shortcut[data-session-id="${item.id}"]`);if(target)options.rename(item,target);}},
      null,
      ...(state.sidebar?.projects || []).filter(project=>project!==value.project).map(project=>({label:`移到 ${basename(project)}`,action:()=>mutate('move',item.id,project)})),
      ...(value.project?[{label:'移出项目',action:()=>mutate('move',item.id,'')}]:[]),
      null,{label:value.archived?'取消归档':'归档会话',action:async()=>{if(await mutate('archive',item.id))options.showToast(value.archived?'会话已恢复':'会话已归档，可从搜索中恢复。');}},
    ]);
  }
  function projectMenu(project,anchor) {
    menu(anchor,[
      {label:'新会话',disabled:!connected(),action:()=>select(null,project)},
      {label:'浏览文件',action:async()=>{try{options.acceptState(await options.bridge.selectSavedProject(project));options.changePage('workspace');}catch(error){options.showToast(errorMessage(error),true);}}},
      null,{label:'从侧栏移除项目',action:()=>mutate('remove-project',undefined,project)},
    ]);
  }
  function openSearch(filter='active') {
    closeMenu(false);searchFilter=filter;searchIndex=0;$('sidebar-search-input').value='';
    // Native content views are siblings above the renderer; suspend them while a modal is open.
    $('sidebar-search-dialog').showModal();window.dispatchEvent(new Event('resize'));renderSearch();$('sidebar-search-input').focus();
  }
  function closeSearch() {$('sidebar-search-dialog').close();window.dispatchEvent(new Event('resize'));$('sidebar-search').focus();}
  function renderSearch() {
    const query=$('sidebar-search-input').value.trim().toLocaleLowerCase();
    searchItems=ordered().filter(item=>Boolean(metadata(item.id).archived)===(searchFilter==='archived') && `${item.title} ${basename(metadata(item.id).project)}`.toLocaleLowerCase().includes(query));
    searchIndex=Math.min(searchIndex,Math.max(0,searchItems.length-1));
    document.querySelectorAll('[data-search-filter]').forEach(node=>node.setAttribute('aria-pressed',String(node.dataset.searchFilter===searchFilter)));
    const host=$('sidebar-search-results');host.replaceChildren();
    for(const [index,item] of searchItems.entries()) {
      const result=button(item.title,null,()=>void openSearchResult(item),'sidebar-search-result');result.replaceChildren();result.setAttribute('role','option');result.setAttribute('aria-selected',String(index===searchIndex));result.id=`sidebar-result-${index}`;
      result.append(icon('chat'),el('span','search-result-title',item.title),el('span','search-result-project',metadata(item.id).project?basename(metadata(item.id).project):'独立会话'));host.append(result);
    }
    if(!searchItems.length)host.append(el('p','sidebar-search-empty',query?'没有找到匹配的会话':searchFilter==='archived'?'没有已归档的会话':'暂无会话'));
    $('sidebar-search-input').setAttribute('aria-controls','sidebar-search-results');
    if(searchItems.length)$('sidebar-search-input').setAttribute('aria-activedescendant',`sidebar-result-${searchIndex}`);else $('sidebar-search-input').removeAttribute('aria-activedescendant');
  }
  async function openSearchResult(item) {
    if(metadata(item.id).archived && !await mutate('archive',item.id))return;
    closeSearch();await select(item.id);
  }
  function init(value) {
    options=value;
    const resizer=$('sidebar-resizer');
    const setWidth=(width,persist=true)=>{
      width=Math.round(Math.max(190,Math.min(380,innerWidth-480,width)));
      document.documentElement.style.setProperty('--sidebar-width',`${width}px`);resizer.setAttribute('aria-valuenow',String(width));
      if(persist)savePreference('width',width);window.dispatchEvent(new Event('resize'));
    };
    const savedWidth=readPreference('width',null);if(Number.isFinite(savedWidth))setWidth(savedWidth,false);
    let drag;
    resizer.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();drag={x:event.clientX,width:$('sidebar').getBoundingClientRect().width};resizer.setPointerCapture(event.pointerId);});
    resizer.addEventListener('pointermove',event=>{if(drag)setWidth(drag.width+event.clientX-drag.x);});
    resizer.addEventListener('pointerup',()=>{drag=null;});resizer.addEventListener('lostpointercapture',()=>{drag=null;});
    resizer.addEventListener('dblclick',()=>setWidth(innerWidth<=1100?224:252));
    resizer.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();event.stopPropagation();setWidth(event.key==='Home'?190:event.key==='End'?380:$('sidebar').getBoundingClientRect().width+(event.key==='ArrowRight'?12:-12));}});
    for(const key of ['pinned','project','session'])$(`sidebar-${key}-toggle`).addEventListener('click',()=>toggleFold(key));
    for(const id of ['new-chat-session','sidebar-new-session'])$(id).addEventListener('click',()=>void select(null));
    $('sidebar-apps').addEventListener('click',()=>options.changePage('town'));
    document.querySelectorAll('.primary-nav [data-town-module]').forEach(button=>button.addEventListener('click',()=>options.openTownModule(button.dataset.townModule)));
    $('sidebar-search').addEventListener('click',()=>openSearch());
    $('sidebar-search-close').addEventListener('click',closeSearch);
    $('sidebar-search-dialog').addEventListener('cancel',event=>{event.preventDefault();closeSearch();});
    $('sidebar-search-dialog').addEventListener('click',event=>{if(event.target===$('sidebar-search-dialog'))closeSearch();});
    $('sidebar-search-input').addEventListener('input',()=>{searchIndex=0;renderSearch();});
    $('sidebar-search-input').addEventListener('keydown',event=>{
      if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();searchIndex=(searchIndex+(event.key==='ArrowDown'?1:-1)+searchItems.length)%Math.max(1,searchItems.length);renderSearch();$(`sidebar-result-${searchIndex}`)?.scrollIntoView({block:'nearest'});}
      if(event.key==='Enter' && !event.isComposing && searchItems[searchIndex]){event.preventDefault();void openSearchResult(searchItems[searchIndex]);}
    });
    document.querySelectorAll('[data-search-filter]').forEach(node=>node.addEventListener('click',()=>{searchFilter=node.dataset.searchFilter;searchIndex=0;renderSearch();}));
    $('sidebar-task-options').addEventListener('click',()=>menu($('sidebar-task-options'),[{label:'搜索会话',action:()=>openSearch()},{label:'查看已归档会话',action:()=>openSearch('archived')}]));
    $('sidebar-profile').addEventListener('click',()=>menu($('sidebar-profile'),[
      {label:'设置',action:()=>options.changePage('settings')},
      {label:'工具与应用',action:()=>options.changePage('town')},
      {label:'功能任务记录',action:()=>options.changePage('tasks')},
      {label:'已归档会话',action:()=>openSearch('archived')},
    ]));
    $('sidebar-menu').addEventListener('keydown',event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu();}
      if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();const items=[...$('sidebar-menu').querySelectorAll('button:not(:disabled)')],index=items.indexOf(document.activeElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
    });
    document.addEventListener('pointerdown',event=>{if(!event.target.closest('#sidebar-menu') && event.target!==menuAnchor)closeMenu(false);});
    document.addEventListener('keydown',event=>{
      if(event.defaultPrevented || event.repeat || event.isComposing)return;
      const command=state.machine?.platform==='darwin'?event.metaKey:event.ctrlKey;
      if(!command)return;
      const key=event.key.toLowerCase();
      if($('sidebar-search-dialog').open || !$('sidebar-menu').hidden)return;
      if((key==='n'&&!event.altKey&&!event.shiftKey)||(key==='o'&&event.shiftKey&&!event.altKey)){event.preventDefault();if(connected())void select(null);return;}
      if(key==='k'&&!event.altKey&&!event.shiftKey && !event.target.closest('.xterm')){event.preventDefault();openSearch();return;}
      if(key==='o'&&!event.altKey&&!event.shiftKey){event.preventDefault();$('sidebar-select-workspace').click();return;}
      if(key==='a'&&event.shiftKey&&!event.altKey&&state.chatSessions?.activeId){event.preventDefault();void mutate('archive',state.chatSessions.activeId);return;}
      if(key==='p'&&event.altKey&&!event.shiftKey&&state.chatSessions?.activeId){event.preventDefault();void mutate('pin',state.chatSessions.activeId);return;}
      if(event.altKey || event.shiftKey)return;
      if(['[',']'].includes(key)){event.preventDefault();options.navigateHistory(key==='['?-1:1);}
      if(/^[1-9]$/.test(key)){event.preventDefault();const item=ordered().filter(item=>!metadata(item.id).archived)[Number(key)-1];if(item)void select(item.id);}
      if(key==='j'){event.preventDefault();$('open-console').click();}
      if(key==='t'){event.preventDefault();$('open-browser').click();}
    });
    $('sidebar-scroll').addEventListener('keydown',event=>{
      if(!event.defaultPrevented && ['ArrowLeft','ArrowRight'].includes(event.key)){
        const toggle=event.target.closest('.project-toggle,.sidebar-section-toggle');
        if(toggle){event.preventDefault();if(toggle.getAttribute('aria-expanded')!==String(event.key==='ArrowRight'))toggle.click();return;}
        if(event.key==='ArrowLeft'){const project=event.target.closest('.sidebar-project-group');if(project){event.preventDefault();project.querySelector('.project-toggle')?.focus();return;}}
      }
      if(event.defaultPrevented || event.target.closest('input') || !['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
      const items=[...$('sidebar-scroll').querySelectorAll('button:not(:disabled)')].filter(node=>node.getClientRects().length),at=items.indexOf(document.activeElement);
      if(at<0)return;event.preventDefault();const index=event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,at+(event.key==='ArrowDown'?1:-1)));items[index]?.focus();
    });
    render();
  }
  function setState(value) {
    if(menuScope && menuScope!==(value.sidebar?.scope || ''))closeMenu(false);
    if(state.sidebar?.scope!==value.sidebar?.scope && $('sidebar-search-dialog')?.open)closeSearch();
    state=value;
    document.querySelectorAll('[data-shortcut]').forEach(node=>{node.textContent=`${state.machine?.platform==='darwin'?'⌘':'Ctrl+'}${node.dataset.shortcut}`;});
    render();
  }
  function command(value) {
    if(value==='new-task'){if(connected())void select(null);return true;}
    if(value==='search-tasks'){openSearch();return true;}
    if(value==='toggle-console'){$('open-console').click();return true;}
    if(/^task-[1-9]$/.test(value)){const item=ordered().filter(item=>!metadata(item.id).archived)[Number(value.slice(5))-1];if(item)void select(item.id);return true;}
    return false;
  }
  return {init,setState,command,refresh:()=>{signature='';render();},setPage:(value,feature='')=>{page=value;townModule=feature;render();},saveVisibility:value=>savePreference('collapsed',!value),isCollapsed:()=>readPreference('collapsed',false)};
})();
