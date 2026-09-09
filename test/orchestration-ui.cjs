'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const root=path.resolve(__dirname,'..');
if(!process.versions.electron) {
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=require('node:child_process').spawn(require('electron'),[__filename],{cwd:root,env,windowsHide:true,stdio:'inherit'});
  child.on('error',error=>{console.error(error);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
} else {
  const {app,BrowserWindow,ipcMain}=require('electron');
  const output=path.join(root,'.local','orchestration-ui-'+randomUUID());
  app.setPath('userData',path.join(output,'profile'));app.disableHardwareAcceleration();
  const sessionOne=randomUUID(),sessionTwo=randomUUID(),workerId=randomUUID();
  let win, rejectModeSave=false;
  const worker={id:workerId,sessionId:sessionOne,agentId:'codex',title:'实现登录表单并验证交互',status:'running',detail:'command_execution · running',cwd:'C:\\Fixture\\workspace',result:'',events:[{seq:1,at:new Date().toISOString(),kind:'tool',name:'command_execution',status:'running',text:'npm test'}]};
  let mode={mode:{enabled:false,defaultAgent:'codex',paths:{}},agents:[{id:'codex',name:'Codex CLI',status:'ready',detail:'执行接口与本机登录状态已确认。'},{id:'cursor',name:'Cursor CLI',status:'missing',detail:'未找到可执行程序。'},{id:'grok',name:'Grok Build CLI',status:'missing',detail:'未找到可执行程序。'}],workers:[worker]};
  const state={version:'fixture',machine:{hostname:'Preview',user:'Preview'},connection:{configured:true,status:'connected',beingName:'cz_being',displayUrl:'https://fixture.invalid'},workspace:{path:'C:\\Fixture\\workspace',files:[]},portal:{status:'not_configured'},runtime:{configStatus:'unknown',sideBySide:{}},settings:{closeToTray:true},chatSessions:{activeId:sessionOne,items:[{id:sessionOne,title:'会话 1'},{id:sessionTwo,title:'会话 2'}]},townApp:{access:{},identity:{identityRevision:1,connectionRevision:1},portalWorkspace:{path:'C:\\Fixture\\workspace'},portalInstall:{}},orchestration:mode};
  const tools={browser:{tabs:[],activeTabId:null},console:{jobs:[]},link:{status:'connected'},requests:[]};
  const handle=(name,fn)=>ipcMain.handle('being:'+name,(_event,...args)=>fn(...args));
  const execute=code=>win.webContents.executeJavaScript(code);
  async function waitFor(code){for(let count=0;count<100;count++){if(await execute(code))return;await new Promise(resolve=>setTimeout(resolve,20));}throw new Error('UI condition not reached: '+code);}
  async function capture(name){
    console.log(name,await execute('JSON.stringify({page:document.body.dataset.page,title:document.getElementById("page-title").textContent,settingsHidden:document.getElementById("page-settings").hidden})'));
    await new Promise(resolve=>setTimeout(resolve,250));
    for(let index=0;index<3;index++) {
      const paint=new Promise(resolve=>win.webContents.once('paint',(_event,_dirty,image)=>resolve(image)));
      win.webContents.invalidate();const image=await paint;
      if(index===2)await fs.writeFile(path.join(output,name+'.png'),image.toPNG());
    }
  }
  async function run() {
    await fs.mkdir(output,{recursive:true});await app.whenReady();
    handle('getState',()=>state);handle('refresh',()=>state);handle('getTownCatalog',()=>require('../src/town.cjs').getTownCatalog());handle('getTownAppState',()=>state.townApp);handle('getDesktopTools',()=>tools);handle('getTerminalState',()=>({sessions:[]}));handle('getFeatureTasks',()=>({tasks:[]}));handle('getWindowState',()=>({maximized:false}));
    for(const name of ['setView','setBrowserView','markShellEditingTarget'])handle(name,()=>({}));
    handle('showSessionMenu',id=>{assert.equal(id,sessionOne);return 'rename';});
    handle('renameChatSession',(id,title)=>{state.chatSessions.items.find(item=>item.id===id).title=title;win.webContents.send('being:state',state);return true;});
    handle('getOrchestration',()=>mode);handle('inspectAgents',()=>mode.agents);handle('getWorker',id=>{assert.equal(id,workerId);return worker;});
    handle('getModelConfig',()=>({config:{model:'fixture',provider:'openai',baseUrl:'https://fixture.invalid',hasApiKey:false},models:[],providers:[],connectionId:1}));
    handle('saveOrchestration',value=>{if(rejectModeSave)throw new Error('严格编排入口不可用');mode={...mode,mode:value};return mode;});
    handle('cancelWorker',id=>{assert.equal(id,workerId);worker.status='cancelled';worker.detail='Worker 已停止';win.webContents.send('being:workers',mode);return worker;});handle('reconnectWorkers',()=>({status:'connected'}));
    win=new BrowserWindow({show:false,width:1440,height:960,webPreferences:{preload:path.join(root,'src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false,offscreen:true}});
    win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
    await win.loadFile(path.join(root,'renderer/index.html'));
    await waitFor('document.querySelectorAll(".worker-shortcut").length===1');
    assert.equal(await execute('document.querySelector(".session-workers").previousElementSibling.querySelector(".session-title").textContent'),'cz_being · 会话 1');
    await capture('sessions');
    await execute('document.querySelector("#chat-session-list .session-shortcut").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
    await waitFor('Boolean(document.querySelector(".session-name-input"))');
    await capture('rename');
    await execute('document.querySelector(".session-name-input").value="登录流程修复";document.querySelector(".session-name-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    await waitFor('!document.querySelector(".session-name-input")');
    assert.equal(state.chatSessions.items[0].title,'登录流程修复');
    await execute('document.querySelector("#chat-session-list .session-shortcut").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))');
    await waitFor('Boolean(document.querySelector(".session-name-input"))');
    win.webContents.send('being:state',state);
    await execute('document.querySelector(".session-name-input").value="不要保存";document.querySelector(".session-name-input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await waitFor('!document.querySelector(".session-name-input")');
    assert.equal(state.chatSessions.items[0].title,'登录流程修复');
    assert.equal(await execute('document.querySelectorAll(".session-rename, .session-rename-dialog").length'),0);

    const originalSessions=state.chatSessions.items;
    state.chatSessions.items=[...Array.from({length:15},(_,index)=>({id:randomUUID(),title:'Earlier session '+index})),...originalSessions];
    win.webContents.send('being:state',state);
    await waitFor('document.querySelectorAll("#chat-session-list .session-shortcut").length===17');
    assert.equal(await execute('document.getElementById("sidebar-session-content").scrollHeight>document.getElementById("sidebar-session-content").clientHeight'),true);
    await execute('document.querySelector(".worker-shortcut").scrollIntoView({block:"nearest"})');
    assert.equal(await execute('(()=>{const w=document.querySelector(".worker-shortcut").getBoundingClientRect(),p=document.getElementById("sidebar-session-content").getBoundingClientRect(),b=document.querySelector(".sidebar-bottom").getBoundingClientRect();return w.top>=p.top&&w.bottom<=p.bottom+1&&w.bottom<b.top;})()'),true);
    await capture('worker-list-scroll');
    state.chatSessions.items=originalSessions;win.webContents.send('being:state',state);
    await waitFor('document.querySelectorAll("#chat-session-list .session-shortcut").length===2');


    await execute('document.querySelector(".worker-shortcut").click()');
    await waitFor('!document.getElementById("page-workers").hidden && document.querySelectorAll(".worker-event").length===1');
    await execute('document.querySelector(".worker-event").open=true');await capture('worker-details');
    await execute('document.querySelector(".worker-detail-header button:last-child").click()');
    await waitFor('document.querySelector(".worker-state").textContent==="已取消"');
    worker.status='completed';worker.completion={state:'accepted',detail:'Heart 已接收完成通知，等待 Being 验收。'};
    worker.review={status:'pending',summary:'',evidence:''};win.webContents.send('being:workers',mode);
    await waitFor('document.querySelector(".worker-review")?.textContent.includes("待验收")');
    assert.equal(await execute('document.querySelector(".worker-review").textContent.includes("验收通过")'),false);
    worker.review={status:'needs_verification',summary:'需要验证页面交互。',evidence:'当前只有测试输出，缺少页面证据。'};win.webContents.send('being:workers',mode);
    await waitFor('document.querySelector(".worker-review")?.textContent.includes("待补充验证")');await capture('worker-review');
    await execute('document.getElementById("header-settings").click();document.querySelector("[data-settings-section=orchestration]").click()');
    await waitFor('!document.getElementById("settings-panel-orchestration").hidden && !document.getElementById("page-settings").hidden');
    rejectModeSave=true;
    await execute('document.getElementById("orchestration-enabled").click()');
    await waitFor('document.getElementById("orchestration-status").textContent.includes("不可用")');
    assert.equal(await execute('document.getElementById("orchestration-enabled").checked'),false);
    assert.equal(await execute('document.getElementById("orchestration-default").disabled'),true);
    assert.equal(await execute('(()=>{const message=document.getElementById("orchestration-status"),toggle=document.querySelector("label[for=orchestration-enabled]"),r=message.getBoundingClientRect(),t=toggle.getBoundingClientRect();return message.dataset.status==="error"&&getComputedStyle(message).opacity==="1"&&r.top>=t.bottom&&r.bottom<innerHeight;})()'),true);
    await capture('mode-error');
    rejectModeSave=false;
    await execute('document.getElementById("orchestration-enabled").click()');
    await waitFor('document.getElementById("orchestration-status").textContent.includes("已开启")');
    assert.equal(mode.mode.enabled,true);await capture('settings');
    await execute('document.querySelector(".worker-shortcut").click()');
    await waitFor('!document.getElementById("page-workers").hidden');
    assert.equal(await execute('Boolean(document.getElementById("worker-result-entry"))'),false,'Final result entry belongs in the conversation, not Worker details');
    assert.equal(await execute('document.documentElement.scrollWidth<=innerWidth'),true);
    await fs.writeFile(path.join(output,'report.json'),JSON.stringify({passed:true,checks:['session ownership','worker detail navigation','tool event display','cancel worker','save mode','no horizontal overflow'],screenshots:['sessions.png','worker-details.png','settings.png']},null,2));
    console.log(output);win.destroy();app.quit();
  }
  run().catch(error=>{console.error(error);win?.destroy();app.exit(1);});
}
