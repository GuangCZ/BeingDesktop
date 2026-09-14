'use strict';
const {contextBridge, ipcRenderer} = require('electron');
const api = {};
// Set before first paint, without exposing Node or another privileged API.
if (typeof window !== 'undefined') window.addEventListener('DOMContentLoaded',()=>{document.documentElement.dataset.platform=process.platform;});
api.showSessionMenu=id=>ipcRenderer.invoke('being:showSessionMenu',id);
api.renameChatSession=(id,title)=>ipcRenderer.invoke('being:renameChatSession',id,title);
for(const name of ['getOrchestration','inspectAgents','saveOrchestration','getWorker','cancelWorker','retryWorkerCallback','reconnectWorkers'])api[name]=(...args)=>ipcRenderer.invoke(`being:${name}`,...args);
api.onWorkers=callback=>{
  if(typeof callback!=='function')throw new TypeError('Expected callback');
  const listener=(_event,value)=>callback(value);ipcRenderer.on('being:workers',listener);
  return ()=>ipcRenderer.removeListener('being:workers',listener);
};
for(const name of ['sidebarAction','selectSavedProject'])api[name]=value=>ipcRenderer.invoke(`being:${name}`,value);
api.changeChatSession=async (id,project='')=>{
  const result=await ipcRenderer.invoke('being:changeChatSession',id,project);
  if(result?.ok===false)throw new Error(result.message);
  return result;
};
for(const name of ['installGroveKit','installEligibleGroveKits','prepareGroveAssistance'])api[name]=(...args)=>ipcRenderer.invoke(`being:${name}`,...args);
for(const name of ['getFeatureTasks','getFeatureTask','discussFeatureTask','endFeatureTaskTracking'])api[name]=(...args)=>ipcRenderer.invoke(`being:${name}`,...args);
for (const name of ['adoptPortal','checkPortalUpdates','openPortalUpdate','downloadPortalUpdate','cancelPortalDownload','applyPortalUpdate','recoverPortalUpdate']) api[name]=()=>ipcRenderer.invoke(`being:${name}`);
for(const name of ['checkDesktopUpdates','downloadDesktopUpdate','installDesktopUpdate','openDesktopRelease'])api[name]=()=>ipcRenderer.invoke(`being:${name}`);
api.setDesktopAutoUpdate=value=>ipcRenderer.invoke('being:setDesktopAutoUpdate',value);
api.setColors=colors=>ipcRenderer.invoke('being:setColors',colors);
api.setOnboardingStep=step=>ipcRenderer.invoke('being:setOnboardingStep',step);
for(const name of ['inspectOnboarding','cancelOnboardingInspection'])api[name]=()=>ipcRenderer.invoke(`being:${name}`);
for(const name of ['getModelConfig','saveModelConfig'])api[name]=(...args)=>ipcRenderer.invoke(`being:${name}`,...args);
for (const name of ['getDesktopTools','desktopAction','setBrowserView','copyDesktopText','getTerminalState','readTerminal','terminalAction','readNativeText']) api[name]=(...args)=>ipcRenderer.invoke(`being:${name}`,...args);
for(const [name,channel] of [['onChatDetailEvent','being:chat-detail-event'],['onChatEvent','being:chat-event'],['onFeatureTasks','being:feature-tasks'],['onTerminalState','being:terminal-state'],['onTerminalData','being:terminal-data'],['onTownMessages','being:town-messages'],['onWindowState','being:window-state']])api[name]=callback=>{
  if(typeof callback!=='function')throw new TypeError('Expected callback');
  const listener=(_event,value)=>callback(value);ipcRenderer.on(channel,listener);
  return ()=>ipcRenderer.removeListener(channel,listener);
};
api.onToolsState=callback=>{
  if(typeof callback!=='function')throw new TypeError('Expected callback');
  const listener=(_event,state)=>callback(state);
  ipcRenderer.on('being:tools-state',listener);
  return ()=>ipcRenderer.removeListener('being:tools-state',listener);
};
api.onTownMembersInvalidated=callback=>{
  if(typeof callback!=='function')throw new TypeError('Expected callback');
  const listener=(_event,value)=>callback(value);ipcRenderer.on('being:town-members-invalidated',listener);
  return ()=>ipcRenderer.removeListener('being:town-members-invalidated',listener);
};
for (const name of ['chatOpenWorkerResult','getChatComposerData','setChatMode','getPortalPermissions','savePortalPermissions','getState','refresh','getTownCatalog','openTownPage','prepareTownFeature','prepareTownAssistance','prepareFiresideDraft','getTownAppState','refreshTownApp','getGroveCatalog','getGroveDetail','prepareGroveInstallation','beginChannelConnection','updateFeishuCredentials','checkChannelStatus','inspectChannelStatus','getFiresides','getFiresideMessages','getFiresideMembers','sendFiresideMessage','createFireside','joinFireside','deployPortal','connect','disconnect','reconnect','selectWorkspace','selectPortalWorkspace','openWorkspace','listWorkspace','selectPortalExecutable','selectPortalConfig','startPortal','stopPortal','testPortalConnection','setView','minimize','maximize','close','setCloseToTray','setTypography','exportDiagnostics']) {
  api[name] = (...args) => ipcRenderer.invoke(`being:${name}`, ...args);
}
// Electron strips custom Error fields. Preserve only known Town error categories.
const townErrorCodes=new Set(['AUTH_REQUIRED','INVALID_REQUEST','IDENTITY_MISMATCH','NOT_CONNECTED','SESSION_CHANGED','BUSY','REQUEST_ACCEPTED','RATE_LIMITED','RESULT_UNKNOWN','NETWORK_ERROR','SERVICE_ERROR','INVALID_RESPONSE','BACKGROUND_UNAVAILABLE','NOT_RUNNING','PAUSED','INCOMPLETE_RESULT','RESULT_SOURCE_UNAVAILABLE','WAITING_SBS','SBS_NOT_CONFIGURED','TASK_LIMIT_REACHED']);
townErrorCodes.add('TOWN_TOOL_NOT_CALLED');
townErrorCodes.add('RESULT_SOURCE_NOT_CONFIGURED');
townErrorCodes.add('READINESS_UNKNOWN');townErrorCodes.add('RESULT_UNCONFIRMED');
townErrorCodes.add('NOT_SENT');
for(const name of ['notifyTownProfileChanged','chatDetailOpen','chatDetailView','chatDetailSend','chatDetailStop','chatDetailClose','chatView','chatSend','chatStop','chatReload','chatForgetSession','pairTownClient','forgetTownClient','prepareTownPairing','getTownCachedData','listScrolls','getScroll','listBeings','getBeingMembers','getBonfireMessages','getFiresides','getFiresideMessages','getFiresideMembers','getDirectMessages','sendDirectMessage','getTownMessageSnapshot','refreshTownMessages','loadOlderTownMessages','requestTownRead','sendBonfireMessage','sendFiresideMessage','beginChannelConnection','updateFeishuCredentials','checkChannelStatus']) {
  api[name]=async(...args)=>{
    const result=await ipcRenderer.invoke(`being:${name}`,...args);
    if(result?.__townError===true) {
      const known=townErrorCodes.has(result.code);
      const error=new Error(known && typeof result.message==='string'?result.message.slice(0,2000):'Town 操作未完成，请稍后重试。');
      error.code=known?result.code:'TOWN_ERROR';
      if(error.code==='NOT_SENT'&&Array.isArray(result.candidates)) {
        error.candidates=result.candidates.slice(0,100).filter(item=>typeof item?.town_id==='string'&&typeof item.display_name==='string').map(item=>({town_id:item.town_id,display_name:item.display_name}));
        if(typeof result.detail==='string')error.detail=result.detail.slice(0,500);
      }
      throw error;
    }
    return result;
  };
}
api.onState = (callback) => {
  if (typeof callback !== 'function') throw new TypeError('Expected callback');
  const handler = (_event, state) => callback(state);
  ipcRenderer.on('being:state', handler);
  return () => ipcRenderer.removeListener('being:state', handler);
};
api.onCommand = (callback) => {
  if (typeof callback !== 'function') throw new TypeError('Expected callback');
  const commands = new Set(['navigate-back', 'navigate-forward', 'toggle-sidebar', 'toggle-inspector', 'chat', 'workspace', 'settings', 'select-workspace', 'refresh', 'open-browser', 'open-console', 'about', 'desktop-updates', 'portal-updates','new-task','search-tasks','toggle-console',...Array.from({length:9},(_,i)=>`task-${i+1}`)]);
  const handler = (_event, command) => { if (commands.has(command)) callback(command); };
  ipcRenderer.on('being:command', handler);
  return () => ipcRenderer.removeListener('being:command', handler);
};
for (const name of ['openAppMenu', 'getWindowState', 'markShellEditingTarget']) api[name] = (...args) => ipcRenderer.invoke(`being:${name}`, ...args);
contextBridge.exposeInMainWorld('beingDesktop', Object.freeze(api));
