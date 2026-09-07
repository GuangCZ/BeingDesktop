'use strict';
const {app, BrowserWindow, WebContentsView, ipcMain, protocol, net, session, safeStorage, dialog, shell, Menu, Tray, Notification, powerMonitor, clipboard} = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');
const {PortalService, safeListWorkspace, sanitizeText} = require('./services.cjs');
const {parseConnection, endpoint, protocolFile, sessionPartition, allowedNavigation} = require('./security.cjs');
const {emptyRuntime, readRuntime, updateRuntimeConfig} = require('./runtime.cjs');
const {ModelConfig} = require('./model-config.cjs');
const {applyLoomTheme,applyContentTypography,applyContentColors} = require('./loom-theme.cjs');
const {prepareLoomSessions,changeLoomSession} = require('./loom-sessions.cjs');
const {normalizeTypography,validateTypography} = require('./typography.cjs');
const {normalizeColors,saveColors} = require('./ui-theme.cjs');
const {restoreOnboarding,saveOnboardingStep,completeOnboardingAfterBonfire} = require('./onboarding.cjs');
const {normalizeAppMenuRequest,commandForInput,captureMenuEditingTarget,getDesktopWindowState,createDesktopMenuTemplate} = require('./desktop-menu.cjs');
const {getTownCatalog,townPageUrl,prepareTownFeature,prepareTownAssistance,prepareFiresideDraft,prepareLoomDraft} = require('./town.cjs');
const {PortalInstaller} = require('./portal-installer.cjs');
const {PortalUpdates} = require('./portal-updates.cjs');
const {inspectPortalPermissions,savePortalPermissions} = require('./portal-permissions.cjs');
const {normalizePortalPermissions} = require('./portal-config.cjs');
const {portalRequestAdapter} = require('./desktop-network.cjs');
const {TownController,requireTownIdentity} = require('./town-controller.cjs');
const {getGroveCatalog} = require('./grove.cjs');
const {GroveInstaller} = require('./grove-installer.cjs');
const {GroveActions} = require('./grove-actions.cjs');
const {inspectGrovePortal,enableGrovePortal,verifyGrovePortalLogs,grovePortalConfigText,recoverGrovePortalMetadata} = require('./grove-portal.cjs');
const {DesktopTools} = require('./desktop-tools.cjs');
const {createBrowserLinks} = require('./browser-links.cjs');
const {DesktopTerminal} = require('./desktop-terminal.cjs');
const {TownSession} = require('./town-session.cjs');
const {BeingTownReader} = require('./being-town-reader.cjs');
const {LocalTownResults} = require('./local-town-results.cjs');
const {SbsTownResults} = require('./sbs-town-results.cjs');
const {applyLoomTownSync,detachLoomTownSync} = require('./loom-town-sync.cjs');
const {ChannelBeing} = require('./channel-being.cjs');
const {TownBackground} = require('./town-background.cjs');
const {BonfireCache} = require('./bonfire-cache.cjs');
const {TownDataCache} = require('./town-data-cache.cjs');
const {TownCachedReads} = require('./town-cached-reads.cjs');
const {FeatureTaskHistory} = require('./feature-task-history.cjs');
const {FeatureTaskRunner} = require('./feature-task-runner.cjs');
const {discussFeatureTask} = require('./feature-task-discussion.cjs');
const {applyLoomComposer,updateLoomComposerData,takeLoomComposerIntents,reportLoomComposerResult,detachLoomComposer} = require('./loom-composer.cjs');

protocol.registerSchemesAsPrivileged([{scheme:'being', privileges:{standard:true, secure:true, supportFetchAPI:true, corsEnabled:true}}]);
if (process.env.BEING_DATA_DIR) app.setPath('userData', path.resolve(process.env.BEING_DATA_DIR));
app.setName('Being Desktop');
if (process.platform === 'win32') app.setAppUserModelId('town.beings.desktop');
const lock = app.requestSingleInstanceLock();
if (!lock) { app.quit(); } else { boot(); }

function boot() {
  let win, view, tray, desktopTools, desktopTerminal, refreshTimer, refreshPromise, exitStarted = false, quitCommitted = false;
  const chatViews = new Map(), liveChatViews = new Set(), chatViewStatus = new WeakMap();
  let connection = null, generation = 0, identityRevision = 0, portalIdentityRevision = null, viewRevision = 0, viewWanted = false, viewport = {x:224,y:88,width:800,height:600};
  let portalBeingName = '';
  let portalPermissionsBusy = false;
  let portalUpdateNotification = null;
  const portalUpdateChecksEnabled = process.env.BEING_SCENARIOS!=='1' && !process.env.BEING_SMOKE_REPORT;
  let mutationTail = Promise.resolve();
  let composerTimer=null;
  let messageQueueTimer=null;
  let menuEditingContents=null;
  let composerRevision=0;
  let modelConfigRevision=0;
  let townSuspended=false;
  let townSyncRecords=[];
  let featureHistory=null;
  const featureHistories=new WeakMap();
  const openFeatureHistories=new Set();
  const featureHistoryCache=new Map();
  const featureMethods=new Set(['getFeatureTasks','getFeatureTask','discussFeatureTask','endFeatureTaskTracking','requestTownRead','listScrolls','getScroll','getGroveCatalog','getGroveDetail','prepareGroveInstallation','deployPortal','startPortal','stopPortal','checkPortalUpdates','beginChannelConnection','checkChannelStatus']);
  for(const name of ['installGroveKit','installEligibleGroveKits'])featureMethods.add(name);
  const taskRunner=new FeatureTaskRunner({getLedger:()=>featureHistory.ledger});
  let townRoomCache={owned:[],joined:[],cached:false};
  const townMemberCache=new Map();
  const townMethods=new Set(['getBeingMembers','listScrolls','getScroll','listBeings','getBonfireMessages','getFiresides','getFiresideMessages','getFiresideMembers','getTownMessageSnapshot','refreshTownMessages','requestTownRead','sendBonfireMessage','beginChannelConnection','updateFeishuCredentials','checkChannelStatus']);
  const townErrorCodes=new Set(['AUTH_REQUIRED','INVALID_REQUEST','IDENTITY_MISMATCH','NOT_CONNECTED','SESSION_CHANGED','BUSY','REQUEST_ACCEPTED','RATE_LIMITED','RESULT_UNKNOWN','NETWORK_ERROR','SERVICE_ERROR','INVALID_RESPONSE','BACKGROUND_UNAVAILABLE','NOT_RUNNING','PAUSED','INCOMPLETE_RESULT','RESULT_SOURCE_UNAVAILABLE','WAITING_SBS','SBS_NOT_CONFIGURED','TASK_LIMIT_REACHED']);
  townErrorCodes.add('READINESS_UNKNOWN');townErrorCodes.add('RESULT_UNCONFIRMED');
  townMethods.add('getTownCachedData');
  const serialized = new Set(['connect','disconnect','reconnect','selectWorkspace','selectPortalExecutable','selectPortalConfig','startPortal','stopPortal','setCloseToTray','setTypography','setColors','saveModelConfig','setOnboardingStep','prepareTownFeature','prepareTownAssistance','prepareFiresideDraft','discussFeatureTask','deployPortal']);
  serialized.add('changeChatSession');
  serialized.add('savePortalPermissions');
  for(const name of ['installGroveKit','installEligibleGroveKits','prepareGroveAssistance'])serialized.add(name);
  let disk = {workspace:'', portalExecutable:'', portalConfig:'', closeToTray:true, credential:''};
  const state = {
    version: app.getVersion(),
    machine:{hostname:os.hostname(),user:os.userInfo().username},
    connection:{configured:false,displayUrl:'',beingName:'',status:'disconnected',error:'',updatedAt:null},
    onboarding:restoreOnboarding(),
    workspace:{path:'',files:[]},
    portal:{status:'not_configured',health:'unknown',executable:'',configPath:'',pid:null,owned:false,detail:''},
    runtime:emptyRuntime(),
    localProxy:{status:'unknown',baseUrl:'http://127.0.0.1:8317/v1'},
    activity:[],settings:{closeToTray:true,typography:normalizeTypography(),colors:normalizeColors()}
  };
  const portal = new PortalService({onEvent(event) {
    state.portal = portal.state;
    activity(event.level, event.title, event.detail);
  }});
  const installer = new PortalInstaller({userDataDir:app.getPath('userData'),requestImpl:portalRequestAdapter(net.request.bind(net))});
  const groveKitsDir=path.join(app.getPath('userData'),'grove-kits');
  const groveInstaller=new GroveInstaller({kitsDir:groveKitsDir,fetchImpl:(url,options)=>net.fetch(url,{...options,credentials:'omit',referrerPolicy:'no-referrer'})});
  const groveActions=new GroveActions({installer:groveInstaller,fetchImpl:(url,options)=>net.fetch(url,{...options,credentials:'omit',referrerPolicy:'no-referrer'}),inspectPortal:inspectCurrentGrovePortal,activate:activateGroveKits});
  const portalUpdates = new PortalUpdates({
    getExecutable:()=>typeof disk.portalExecutable==='string'?disk.portalExecutable:'',
    fetchImpl:(url,options)=>net.fetch(url,options),
    getNotifiedVersion:()=>disk.portalUpdateNotifiedVersion,
    onChange:()=>broadcast(),
    onAvailable:async update=>{
      const saved=mutationTail.then(async()=>{
        if(exitStarted || !portalUpdates.state().available || portalUpdates.state().latestVersion!==update.latestVersion)return false;
        const previous=disk.portalUpdateNotifiedVersion;
        disk.portalUpdateNotifiedVersion=update.latestVersion;
        try { await persist(); }
        catch(error) {
          if(previous===undefined)delete disk.portalUpdateNotifiedVersion;
          else disk.portalUpdateNotifiedVersion=previous;
          throw error;
        }
        return true;
      });
      mutationTail=saved.catch(()=>{});
      if(!await saved)return false;
      activity('info',`Portal ${update.latestVersion} 可更新`,`所选程序版本为 ${update.currentVersion}，可在 Portal 设置中查看更新。`);
      if(Notification.isSupported()) {
        portalUpdateNotification?.close();
        portalUpdateNotification=new Notification({title:'Portal 有新版本',body:`Portal ${update.latestVersion} 已发布。点击查看更新。`});
        portalUpdateNotification.on('click',()=>{showDesktopWindow();sendShellCommand('portal-updates');});
        portalUpdateNotification.show();
      }
    },
  });
  const town = new TownController({installer,portal,
    defaultWorkspace:path.join(app.getPath('userData'),'portal-workspace'),
    getContext:()=>({beingName:state.connection.beingName,configured:state.connection.configured,connected:state.connection.status==='connected',connectionId:generation,identityRevision,portalIdentityRevision,workspace:state.workspace.path,portalExecutable:disk.portalExecutable,portalConfig:disk.portalConfig,managedPortal:disk.managedPortal,exiting:exitStarted}),
    saveDeployment:async deployment=>{
      const files=await safeListWorkspace(deployment.workspace,'');
      const previous={workspace:disk.workspace,portalExecutable:disk.portalExecutable,portalConfig:disk.portalConfig,managedPortal:disk.managedPortal};
      portal.configure({executable:deployment.executable,configPath:deployment.configPath});
      Object.assign(disk,{workspace:deployment.workspace,portalExecutable:deployment.executable,portalConfig:deployment.configPath,managedPortal:deployment});
      try { await persist(); }
      catch {
        Object.assign(disk,previous);
        portal.configure({executable:previous.portalExecutable,configPath:previous.portalConfig});
        throw new Error('Portal 配置未能保存，程序未启动。');
      }
      state.workspace={path:deployment.workspace,files};
      desktopTools?.changed();
      if(portalUpdateChecksEnabled)void portalUpdates.changed();
    },startPortal:()=>startCurrentPortal(),onChange:()=>broadcast()});

  const modelConfig=new ModelConfig({getContext:()=>({connection,connectionId:generation,exiting:exitStarted}),fetchImpl:(url,options)=>net.fetch(url,options)});
  function publishModelConfig(snapshot) {
    if(!connection || snapshot.connectionId!==generation)throw new Error('Being 连接已变化，请重新读取模型配置。');
    modelConfigRevision++;
    state.runtime=updateRuntimeConfig(state.runtime,snapshot);
    broadcast();
    return snapshot;
  }
  const localTownResults=new LocalTownResults({
    getConfig:()=>{
      try { return disk.localTownResults?{baseUrl:disk.localTownResults.baseUrl,key:safeStorage.decryptString(Buffer.from(disk.localTownResults.credential,'base64'))}:null; }
      catch { return null; }
    },fetchImpl:(url,options)=>net.fetch(url,options),
  });
  const sbsTownResults=new SbsTownResults({
    getConnection:()=>!exitStarted&&state.connection.status==='connected'?connection:null,
    getRegistrations:async()=>{
      try {
        const value=await fs.readFile(path.join(app.getPath('userData'),'town-sbs.json'),'utf8');
        return value.length<=16384?JSON.parse(value):null;
      } catch { return null; }
    },results:localTownResults,
  });
  const beingTownReader=new BeingTownReader({
    getConnection:()=>!exitStarted&&state.connection.status==='connected'?connection:null,
    getRuntime:()=>({activeStream:{active:channelBeing.state().status==='working'}}),
    fetchImpl:(url,options)=>net.fetch(url,options),
    toolResults:localTownResults,
    onRequest:record=>registerFeatureRequest(record),
  });
  function resetTownReader() { beingTownReader.reset(); sbsTownResults.reset(); townRoomCache={owned:[],joined:[],cached:false};townMemberCache.clear(); }
  const townSession=new TownSession({
    getContext:()=>({configured:state.connection.configured,connected:state.connection.status==='connected',exiting:exitStarted,connectionId:generation,identityRevision,beingName:state.connection.beingName}),
    fetchImpl:(url,options)=>net.fetch(url,{...options,credentials:'omit',referrerPolicy:'no-referrer'}),
    readImpl:(route,options)=>{
      const owner=taskRunner.currentTask();
      return beingTownReader.read(route,{...options,onRequest:record=>registerFeatureRequest(record,owner),onProgress:progress=>{
        if(owner)owner.ledger.update(owner.task.id,{status:'running',detail:`Being 已接收请求，正在检查原请求的工具结果（第 ${progress.checks} 次）；不会重复发送。`});
      }});
    },
    onChange:()=>broadcast(),
  });
  const channelBeing=new ChannelBeing({
    getContext:()=>({connection,configured:state.connection.configured,connected:state.connection.status==='connected',exiting:exitStarted,connectionId:generation,identityRevision,beingName:state.connection.beingName}),
    fetchImpl:(url,options)=>net.fetch(url,{...options,credentials:'omit',referrerPolicy:'no-referrer'}),
    onChange:()=>broadcast(),
    onRequest:record=>registerFeatureRequest(record),
  });
  const bonfireCache=new BonfireCache({directory:path.join(app.getPath('userData'),'bonfire-cache'),safeStorage});
  const townDataCache=new TownDataCache({directory:path.join(app.getPath('userData'),'town-data-cache'),safeStorage});
  const townCachedReads=new TownCachedReads({cache:townDataCache,
    getContext:()=>({identityKey:connection?sessionPartition(connection):'',revision:generation,identityRevision,connected:!exitStarted&&state.connection.status==='connected'}),
  });
  const townBackground=new TownBackground({townSession,bonfireCache,
    getCacheKey:()=>connection?sessionPartition(connection):'',
    readCachedSnapshot:request=>sbsTownResults.readSnapshot(request),
    getIdentity:()=>connection ? {beingId:state.connection.beingName,connectionRevision:generation,identityRevision} : null,
    onStatus:()=>broadcast(),
    onUpdate:value=>{if(win&&!win.isDestroyed())win.webContents.send('being:town-messages',value);},
  });
  function syncTownLifecycle() {
    townBackground.lifecycle({enabled:!exitStarted&&!townSuspended&&Boolean(connection)&&state.connection.status==='connected'&&net.isOnline(),reason:townSuspended?'suspended':'offline'});
  }
  async function loadCachedFiresides() {
    if(townRoomCache.cached)return structuredClone(townRoomCache);
    const previous=townRoomCache;
    const result=await townCachedReads.snapshot({method:'getFiresides'});
    if(previous===townRoomCache&&result.cached){
      townRoomCache={...result.data,cached:true,lastSuccessAt:result.lastSuccessAt};
      townBackground.reconcileRooms(result.data);
    }
    return structuredClone(townRoomCache);
  }
  async function loadCachedFiresideMembers(value) {
    const revision=generation,identity=identityRevision;
    const current=()=>{if(revision!==generation||identity!==identityRevision)throw Object.assign(new Error('Being 连接已变化。'),{code:'SESSION_CHANGED'});};
    const rooms=await loadCachedFiresides();
    current();
    if(rooms.cached&&![...rooms.owned,...rooms.joined].some(room=>String(room.id)===value))return {members:[],cached:false};
    const previous=townMemberCache.get(value);
    const result=await townCachedReads.snapshot({method:'getFiresideMembers',value});
    current();
    if(!previous&&!townMemberCache.has(value)&&result.cached)townMemberCache.set(value,{...result.data,cached:true,lastSuccessAt:result.lastSuccessAt});
    return structuredClone(townMemberCache.get(value)||{members:[],cached:false});
  }
  async function loadFeatureHistory() {
    const identityKey=connection?sessionPartition(connection):'disconnected';
    if(featureHistory?.ledger.identityKey===identityKey)return;
    const expectedConnection=connection,expectedGeneration=generation;
    if(win&&!win.isDestroyed())win.webContents.send('being:feature-tasks',{tasks:[]});
    let history=featureHistoryCache.get(identityKey);
    if(!history) {
      history=new FeatureTaskHistory({identityKey,directory:path.join(app.getPath('userData'),'feature-tasks'),safeStorage,onChange:()=>{
        if(featureHistory!==history)return;
        publishFeatureTasks();
      }});
      featureHistoryCache.set(identityKey,history);
      openFeatureHistories.add(history);
    }
    await history.restore();
    if(connection!==expectedConnection||generation!==expectedGeneration)throw Object.assign(new Error('连接身份已变化，请重新读取功能任务。'),{code:'SESSION_CHANGED'});
    featureHistory=history;
    featureHistories.set(history.ledger,history);
    townSyncRecords=history.records;
    publishFeatureTasks();
  }
  function publishFeatureTasks() {
    if(win&&!win.isDestroyed()&&featureHistoryCurrent())win.webContents.send('being:feature-tasks',{tasks:featureHistory.ledger.list(),persistenceError:featureHistory.persistenceError});
  }
  function featureHistoryCurrent() {return featureHistory?.ledger.identityKey===(connection?sessionPartition(connection):'disconnected');}
  function registerFeatureRequest(record,owner=taskRunner.currentTask()) {
    const history=owner?featureHistories.get(owner.ledger):featureHistory;
    if(!history)return;
    if(owner)owner.ledger.update(owner.task.id,{requestId:record.requestId,detail:'Being 正在处理，结果将显示在功能页；聊天可能等待。'});
    history.register(record);
    if(history!==featureHistory)return;
    townSyncRecords=history.records;
    if(view&&!view.webContents.isDestroyed())void applyLoomTownSync(view.webContents,townSyncRecords).catch(()=>{});
  }
  function townState() {
    const result=town.state();
    const access=townSession.state();
    const channel=channelBeing.state();
    result.access={...result.access,bonfire:access.bonfire.status,channel:channel.status};
    result.bonfire=access.bonfire;
    result.channel=channel;
    result.access.firesideRead=access.fireside?.status || 'unknown';
    result.fireside=access.fireside || {status:'unknown',detail:''};
    result.access.scroll=access.scroll?.status || 'unknown';
    result.access.beings=access.beings?.status || 'unknown';
    result.scroll=access.scroll || {status:'unknown',detail:''};
    result.beings=access.beings || {status:'unknown',detail:''};
    result.sync=townBackground.metadata();
    return result;
  }
  function publicState() {
    const portalState=portal.state;
    return structuredClone({...state,portal:{...portalState,connectionBeingName:portalState.owned?portalBeingName:'',connectionCurrent:portalState.owned?portalIdentityRevision===identityRevision:null},portalUpdate:portalUpdates.state(),townApp:townState()});
  }
  function broadcast() {
    if (win && !win.isDestroyed()) win.webContents.send('being:state',publicState());
    updateTray();
  }
  function windowState() { return getDesktopWindowState(win); }
  function publishWindowState() {
    if (win && !win.isDestroyed()) win.webContents.send('being:window-state',windowState());
  }
  function sendShellCommand(command,focus=true) {
    if (!win || win.isDestroyed() || exitStarted) return;
    if (focus) win.webContents.focus();
    win.webContents.send('being:command',command);
  }
  function activity(level,title,detail='') {
    state.activity.unshift({id:crypto.randomUUID(),time:new Date().toISOString(),level,title:sanitizeText(String(title)),detail:sanitizeText(String(detail))});
    state.activity.splice(100);
    broadcast();
  }
  function browserLinks(isCurrent = () => true) {
    return createBrowserLinks({
      getBrowser:()=>desktopTools.browser,
      showBrowser:()=>{
        win.webContents.send('being:tools-state',desktopTools.snapshot());
        sendShellCommand('open-browser');
      },
      isCurrent:()=>!exitStarted&&Boolean(win)&&!win.isDestroyed()&&Boolean(desktopTools)&&isCurrent(),
      onError:error=>activity('warning','网页未能打开',error.message),
    });
  }
  function settingsPath() { return path.join(app.getPath('userData'),'settings.json'); }
  async function persist() {
    await fs.mkdir(app.getPath('userData'),{recursive:true});
    const tmp = `${settingsPath()}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp,JSON.stringify(disk,null,2),{mode:0o600});
    await fs.rename(tmp,settingsPath());
  }
  async function restore() {
    await fs.mkdir(groveKitsDir,{recursive:true});
    try { disk = {...disk,...JSON.parse(await fs.readFile(settingsPath(),'utf8'))}; }
    catch (error) { if (error.code !== 'ENOENT') activity('warning','设置读取失败','已保留原文件，请重新检查连接设置。'); }
    const groveRecovery=await recoverGrovePortalMetadata({settings:disk,kitsDir:groveKitsDir,verifyInstalledRoot:()=>groveInstaller.verifyInstalledRoot()});
    if(groveRecovery.changed) {
      const previousManaged=disk.managedPortal;
      disk.managedPortal=groveRecovery.managedPortal;
      try { await persist(); }
      catch { disk.managedPortal=previousManaged;activity('warning','Grove 安装记录未能恢复','已保留现有工具和 Portal 配置，可重新点击安装修复记录。'); }
    }
    disk.onboarding = restoreOnboarding(disk);
    state.onboarding = {...disk.onboarding};
    state.settings.closeToTray = disk.closeToTray !== false;
    state.settings.typography = normalizeTypography(disk.typography);
    state.settings.colors = normalizeColors(disk.colors);
    state.workspace.path = typeof disk.workspace === 'string' ? disk.workspace : '';
    if (state.workspace.path) {
      try { state.workspace.files = await safeListWorkspace(state.workspace.path,''); }
      catch { state.workspace.files=[]; activity('warning','工作区暂不可用','请重新选择工作区。'); }
    }
    try { portal.configure({executable:disk.portalExecutable || '',configPath:disk.portalConfig || ''}); }
    catch { activity('warning','Portal 配置需要检查','请重新选择可执行文件和配置文件。'); }
    if (disk.credential) {
      try {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('Credential protection unavailable');
        connection = parseConnection(safeStorage.decryptString(Buffer.from(disk.credential,'base64')));
      } catch { activity('error','连接凭据无法解锁','请重新输入 Loom 连接地址。'); }
    }
    if (process.env.BEING_LOOM_URL) {
      await storeConnection(process.env.BEING_LOOM_URL);
      delete process.env.BEING_LOOM_URL;
    }
    if (connection) publishConnection();
    await loadFeatureHistory();
    disk.onboarding = restoreOnboarding(disk,{configured:Boolean(connection)});
    state.onboarding = {...disk.onboarding};
  }
  function publishConnection() {
    state.chatSessions = {activeId:'',items:[]};
    state.connection={configured:true,displayUrl:connection.displayUrl,beingName:connection.beingName,status:'connecting',error:'',updatedAt:null};
  }
  async function storeConnection(input) {
    const parsed = parseConnection(input);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据保护暂不可用，连接信息未保存。');
    const encrypted = safeStorage.encryptString(parsed.url).toString('base64');
    const previous = disk.credential;
    disk.credential = encrypted;
    try { await persist(); } catch { disk.credential=previous; throw new Error('无法保存连接设置。'); }
    if (!connection || sessionPartition(connection)!==sessionPartition(parsed)) {identityRevision++;desktopTools?.disconnectLink();townSession.reset();}
    channelBeing.reset();resetTownReader();
    connection=parsed; generation++; state.runtime=emptyRuntime();
    publishConnection();
    syncTownLifecycle();
    await loadFeatureHistory();
  }
  function authSender(event) {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== 'being://app/index.html') throw new Error('Native bridge access denied');
  }
  function handle(name,fn) {
    ipcMain.handle(`being:${name}`,async(event,...args)=>{
      authSender(event);
      try {
        if(featureMethods.has(name)&&!featureHistoryCurrent())throw Object.assign(new Error('连接身份正在切换，请稍后重新选择功能。'),{code:'SESSION_CHANGED'});
        return await taskRunner.run(name,args,()=>{
          if (!serialized.has(name)) return fn(...args);
          const owner=taskRunner.currentTask();
          const operation = mutationTail.then(() => {
            if (exitStarted) throw new Error('桌面端正在退出。');
            if(owner&&owner.ledger!==featureHistory.ledger)throw Object.assign(new Error('连接身份已变化，请重新选择功能。'),{code:'SESSION_CHANGED'});
            return fn(...args);
          });
          mutationTail = operation.catch(() => {});
          return operation;
        });
      }
      catch(error) {
        const message=error?.code==='TASK_LIMIT_REACHED'?'功能任务记录已满，请到任务页结束不再跟踪的等待任务后重试。':sanitizeText(error?.message || '操作未完成');
        if(townMethods.has(name)) return {__townError:true,code:townErrorCodes.has(error?.code)?error.code:'TOWN_ERROR',message:townErrorCodes.has(error?.code)?message:'Town 操作未完成，请稍后重试。'};
        activity('error','操作未完成',message);throw new Error(message);
      }
    });
  }
  function mountView() {
    if (!view || !win || win.isDestroyed()) return;
    const [width,height]=win.getContentSize();
    const x=Math.max(0,Math.min(width,Math.round(viewport.x)));
    const y=Math.max(0,Math.min(height,Math.round(viewport.y)));
    const w=Math.max(0,Math.min(width-x,Math.round(viewport.width)));
    const h=Math.max(0,Math.min(height-y,Math.round(viewport.height)));
    view.setBounds({x,y,width:w,height:h});
    view.setVisible(Boolean(viewWanted && connection && w>0 && h>0));
  }
  function discardView() {
    clearInterval(messageQueueTimer);messageQueueTimer=null;state.messageQueue=null;
    clearInterval(composerTimer);composerTimer=null;composerRevision++;
    for (const item of liveChatViews) {
      if (!item.webContents.isDestroyed()) {
        void detachLoomComposer(item.webContents).catch(()=>{});
        void detachLoomTownSync(item.webContents).catch(()=>{});
      }
      if (win && !win.isDestroyed()) win.contentView.removeChildView(item);
      if (!item.webContents.isDestroyed()) item.webContents.close();
    }
    liveChatViews.clear();chatViews.clear();
    view=null;
  }
  function mountMessageQueue(contents, connectionEpoch) {
    clearInterval(messageQueueTimer);
    state.messageQueue=null;
    let polling=false;
    const current=()=>connectionEpoch===generation && view?.webContents===contents && !contents.isDestroyed() && !contents.isLoadingMainFrame() && state.connection.status==='connected' && !exitStarted;
    const poll=async()=>{
      if (polling || !current()) return;
      polling=true;
      try {
        const messageQueue=await contents.executeJavaScript('globalThis.__beingDesktopTaskQueue?.snapshot() || null');
        if (current() && JSON.stringify(state.messageQueue)!==JSON.stringify(messageQueue)) {
          state.messageQueue=messageQueue;
          broadcast();
        }
      } catch { if(current() && state.messageQueue) {state.messageQueue=null;broadcast();} }
      finally {polling=false;}
    };
    messageQueueTimer=setInterval(poll,750);
    messageQueueTimer.unref();
    void poll();
  }
  async function mountComposer(contents,connectionEpoch) {
    const revision=++composerRevision;
    clearInterval(composerTimer);composerTimer=null;
    const current=()=>revision===composerRevision && connectionEpoch===generation && view?.webContents===contents && !contents.isDestroyed() && !contents.isLoadingMainFrame() && state.connection.status==='connected' && !exitStarted;
    if (!current()) return;
    await applyLoomComposer(contents,{kits:[],members:[]});
    if (!current()) return;
    let polling=false;
    composerTimer=setInterval(async()=>{
      if (polling || !current()) return;
      polling=true;
      try {
        const intents=await takeLoomComposerIntents(contents);
        for (const intent of intents) {
          if (!current()) break;
          try {
            const result=await townSession.sendBonfireMessage({content:intent.text,mentions:intent.memberIds,connectionRevision:connectionEpoch});
            const detail=result.mentions?.length?'消息已发布到篝火，Town 已接受提及通知。':'消息已发布到篝火；Town 尚未确认提及通知。';
            if (current()) await reportLoomComposerResult(contents,{id:intent.id,status:'sent',detail});
          } catch {
            if (current()) await reportLoomComposerResult(contents,{id:intent.id,status:'error',detail:'篝火通知未确认送达。请打开篝火检查状态；不会自动重发。'});
          }
        }
      } catch { /* Navigation can dispose the isolated composer between checks. */ }
      finally {polling=false;}
    },400);
    composerTimer.unref();
    const data=await Promise.allSettled([
      getGroveCatalog({limit:100,offset:0},{fetchImpl:(url,options)=>net.fetch(url,{...options,credentials:'omit',referrerPolicy:'no-referrer'})}),
      townSession.getMembers(),
    ]);
    if (!current()) return;
    await updateLoomComposerData(contents,{
      kits:data[0].status==='fulfilled'?data[0].value.kits:[],
      members:data[1].status==='fulfilled'?data[1].value.members:[],
      kitsError:data[0].status==='rejected'?'工具目录暂时无法加载。':'',
      membersError:data[1].status==='rejected'?'Being 成员暂时无法加载。':'',
    });
  }
  function createLoom(sessionId = null, preserve = false) {
    state.messageQueue=null;
    if (!preserve) discardView();
    else {
      clearInterval(composerTimer);composerTimer=null;composerRevision++;
      view?.setVisible(false);
    }
    if (!connection || !win) return;
    const epoch=generation;
    const initial=connection;
    const loomSession=session.fromPartition(sessionPartition(initial));
    loomSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    loomSession.setPermissionCheckHandler(()=>false);
    view=new WebContentsView({webPreferences:{session:loomSession,backgroundThrottling:false,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,devTools:!app.isPackaged}});
    const ownedView=view;
    liveChatViews.add(ownedView);
    chatViewStatus.set(ownedView,{status:'connecting',error:''});
    if(sessionId)chatViews.set(sessionId,ownedView);
    const isCurrent=()=>epoch===generation && view===ownedView;
    const contents=view.webContents;
    let loadRevision = 0;
    contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) { loadRevision++; if(isCurrent())viewRevision++; } });
    contents.on('before-input-event', (event, input) => {
      const command = commandForInput(input);
      if (!command || !isCurrent() || !win || win.isDestroyed()) return;
      event.preventDefault();
      if (input.isAutoRepeat) return;
      sendShellCommand(command,['workspace','settings','navigate-back','navigate-forward'].includes(command));
    });
    const links=browserLinks(()=>epoch===generation&&state.connection.status==='connected');
    contents.setWindowOpenHandler(links.popup);
    const guardNavigation=(event,target)=>{
      if(allowedNavigation(initial,target))return;
      event.preventDefault();
      if(!isCurrent())return;
      if(state.connection.status==='connecting') {
        state.connection.status='error';state.connection.error='入口跳转到其他地址，请检查 Loom 连接地址后重试。';
      }
      activity('warning','已拦截外部页面导航','请通过已有 Loom 入口继续会话。');
    };
    contents.on('will-navigate',(event,target)=>{
      const url=typeof event.url==='string'?event.url:target;
      if(allowedNavigation(initial,url))return;
      if(epoch===generation&&state.connection.status==='connected') {
        event.preventDefault();
        links.tryOpen(url);
        return;
      }
      guardNavigation(event,url);
    });
    contents.on('will-redirect',guardNavigation);
    contents.on('did-finish-load',async()=>{
      if(contents.getURL()==='about:blank')return;
      if(epoch!==generation)return;
      const finishedRevision = loadRevision;
      try {
        await applyLoomTheme(contents,state.settings.colors);
        if(epoch===generation && finishedRevision===loadRevision && !contents.isDestroyed()) {
          await Promise.all([applyContentTypography(contents,state.settings.typography),applyContentColors(contents,state.settings.colors)]);
        }
      }
      catch { if(epoch===generation && finishedRevision===loadRevision)activity('warning','对话外观未应用','Loom 保持原有界面，可以继续使用或重新连接。'); }
      if(epoch!==generation || finishedRevision!==loadRevision || contents.isDestroyed())return;
      const sessions = await contents.executeJavaScript('globalThis.__beingDesktopSessions?.list() || {activeId:"",items:[]}');
      if(epoch!==generation || finishedRevision!==loadRevision || contents.isDestroyed())return;
      if(sessions.activeId)chatViews.set(sessions.activeId,ownedView);
      chatViewStatus.set(ownedView,{status:'connected',error:''});
      void applyLoomTownSync(contents,townSyncRecords).catch(()=>{});
      if(!isCurrent())return;
      state.chatSessions = sessions;
      state.connection.status='connected';state.connection.error='';state.connection.updatedAt=new Date().toISOString();activity('info','Loom 已加载','已连接现有会话；身份和历史由原运行时保存。');syncTownLifecycle();refresh();
      mountMessageQueue(contents,epoch);
      void mountComposer(contents,epoch).catch(()=>{if(epoch===generation)activity('warning','输入补全暂不可用','重新连接后可重试加载工具与成员。');});
    });
    contents.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{
      if(!isMainFrame || code===-3 || epoch!==generation)return;
      loadRevision++;
      chatViewStatus.set(ownedView,{status:'error',error:`页面加载失败 (${code})`});
      if(!isCurrent())return;
      viewRevision++;
      state.connection.status='error';state.connection.error=`页面加载失败 (${code})`;activity('error','Loom 加载失败','可检查网络后重新连接。不会自动重发聊天消息。');
      syncTownLifecycle();
    });
    contents.on('render-process-gone',()=>{loadRevision++;chatViewStatus.set(ownedView,{status:'error',error:'对话页面进程已退出，请重新连接。'});if(!isCurrent())return;viewRevision++;state.connection.status='error';state.connection.error='对话页面进程已退出，请重新连接。';activity('error','对话页面已退出',state.connection.error);syncTownLifecycle();});
    win.contentView.addChildView(view);mountView();
    prepareLoomSessions(contents,sessionId).then(()=>{
      if(epoch===generation && !contents.isDestroyed()) return contents.loadURL(initial.url);
    }).catch(()=>{
      chatViewStatus.set(ownedView,{status:'error',error:'会话隔离初始化失败，请重新连接。'});
      if(!isCurrent())return;
      state.connection.status='error';state.connection.error='会话隔离初始化失败，请重新连接。';broadcast();
    });
  }
  async function fetchJson(url,timeout=8000) {
    const response=await net.fetch(url,{redirect:'error',signal:AbortSignal.timeout(timeout),cache:'no-store'});
    if(response.status===204)return null;
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  async function doRefresh() {
    const epoch=generation;
    const configRevision=modelConfigRevision;
    const current=connection;
    const tasks=[portal.inspect().catch(()=>{}),fetchJson('http://127.0.0.1:8317/healthz',3500).then(data=>{state.localProxy.status=data?.status==='ok'?'connected':'error';}).catch(()=>{state.localProxy.status='unavailable';})];
    if(current) tasks.push((async()=>{
      const results=await Promise.allSettled(['/api/status','/api/llm/config','/api/stream/active'].map(route=>fetchJson(endpoint(current,route))));
      if(epoch!==generation)return;
      const previous=state.runtime.status;
      const nextRuntime=readRuntime(results,new Date().toISOString());
      // A read that began before an explicit model change cannot undo its snapshot.
      if(configRevision!==modelConfigRevision || modelConfig.busy) {
        for(const key of ['configStatus','configError','configCheckedAt','model','provider','baseUrl'])nextRuntime[key]=state.runtime[key];
        nextRuntime.sideBySide.configured=state.runtime.sideBySide.configured;
      }
      state.runtime=nextRuntime;
      if(previous!==state.runtime.status)activity(state.runtime.status==='connected'?'info':'warning',state.runtime.status==='connected'?'运行时已连接':'运行时暂不可达',state.runtime.error);
    })());
    await Promise.allSettled(tasks);syncTownLifecycle();broadcast();return publicState();
  }
  function refresh() {
    if (!refreshPromise) refreshPromise=doRefresh().finally(()=>{refreshPromise=null;});
    return refreshPromise;
  }
  async function chooseFile(title,extensions) {
    const result=await dialog.showOpenDialog(win,{title,properties:['openFile'],filters:[{name:title,extensions}]});
    return result.canceled?'':result.filePaths[0];
  }
  async function startCurrentPortal(permissionRestart = false) {
    if(portalPermissionsBusy && !permissionRestart)throw new Error('Portal 权限正在保存，请稍后重试。');
    if(!connection)throw new Error('请先连接 Being。');
    const managed=disk.managedPortal?.configPath===disk.portalConfig && disk.managedPortal?.executable===disk.portalExecutable;
    const alreadyOwned=portal.state.owned;
    const startedIdentity=identityRevision;
    const startedBeing=state.connection.beingName;
    const started=await portal.start({connectUrl:connection.url,portalName:'being-desktop',...(managed?{coworkToken:require('node:crypto').randomBytes(32).toString('hex')}:{})});
    if(!alreadyOwned && started.owned){portalIdentityRevision=startedIdentity;portalBeingName=startedBeing;}
    return started;
  }
  async function inspectCurrentGrovePortal() {
    const managed=disk.managedPortal?.configPath===disk.portalConfig && disk.managedPortal?.executable===disk.portalExecutable;
    if(!managed)return {ready:false,reason:'本机文件可安装；现有 Portal 需在电脑连接页配置后加载。'};
    return inspectGrovePortal({configPath:disk.portalConfig,kitsDir:groveKitsDir});
  }
  async function activateGroveKits(results) {
    if(portalPermissionsBusy)return {loaded:false,detail:'Portal 权限正在保存，请稍后重新加载工具包。'};
    const rootCheck=await groveInstaller.verifyInstalledRoot();
    if(!rootCheck.verified)return {loaded:false,detail:rootCheck.detail};
    const inspected=await inspectCurrentGrovePortal();
    if(!inspected.ready)return {loaded:false,detail:inspected.reason};
    if(!connection || state.connection.status!=='connected')return {loaded:false,detail:'请连接 Being 后重新点击安装，以加载已安装的 Kit。'};
    await portal.inspect();
    if(portal.state.status==='external')return {loaded:false,detail:'已有外部管理的 Portal，请由 Being 协助加载已安装的 Kit。'};
    if(portal.state.status==='error')return {loaded:false,detail:'Portal 状态无法确认，请到电脑连接页检查。'};
    const changed=await enableGrovePortal({configPath:disk.portalConfig,kitsDir:groveKitsDir});
    if(changed.ready===false)return {loaded:false,detail:changed.reason};
    const previousManaged=disk.managedPortal;
    disk.managedPortal={...disk.managedPortal,groveKitsDir};
    try { await persist(); }
    catch {
      disk.managedPortal=previousManaged;
      if(changed.changed && changed.backupPath) {
        const original=await fs.readFile(changed.backupPath,'utf8');
        const current=await fs.lstat(disk.portalConfig);
        if(current.isFile() && !current.isSymbolicLink() && await fs.readFile(disk.portalConfig,'utf8')===grovePortalConfigText(original,groveKitsDir)) {
          const temporary=`${disk.portalConfig}.grove-rollback-${crypto.randomUUID()}.tmp`;
          await fs.writeFile(temporary,original,{flag:'wx',mode:0o600});
          await fs.rename(temporary,disk.portalConfig);
        }
      }
      return {loaded:false,detail:'工具包已安装，Portal 加载设置未能保存，请检查磁盘权限后重试。'};
    }
    if(portal.state.owned)await portal.stop();
    const logStart=portal.logs.at(-1);
    const started=await startCurrentPortal();
    if(started.status!=='running')return {loaded:false,detail:started.detail || 'Portal 尚未启动。'};
    const names=results.map(result=>result.kit.name);
    const deadline=Date.now()+10000;
    do {
      const logs=portal.logs;
      const position=logStart ? logs.findIndex(item=>item.time===logStart.time && item.detail===logStart.detail) : -1;
      const verified=verifyGrovePortalLogs(position<0?logs:logs.slice(position+1),names);
      if(verified.verified)return {...verified,registeredKits:verified.loaded,loaded:true,backupPath:changed.backupPath,detail:'Portal 启动日志已确认新工具注册；业务任务尚未执行。'};
      if(portal.state.status!=='running')break;
      await new Promise(resolve=>setTimeout(resolve,100));
    } while(Date.now()<deadline);
    return {loaded:false,backupPath:changed.backupPath,detail:'本机安装已验证，尚未取得 Portal 工具注册日志；可在电脑连接页查看。'};
  }
  function registerIPC() {
    handle('getWindowState',windowState);
    handle('markShellEditingTarget',()=>{menuEditingContents=win.webContents;});
    handle('openAppMenu',async value=>{
      const [width,height]=win.getContentSize();
      const {menu:name,x,y}=normalizeAppMenuRequest(value,{width,height});
      const editTarget=captureMenuEditingTarget(win,menuEditingContents);
      const menu=Menu.buildFromTemplate(createDesktopMenuTemplate(name,{sendCommand:sendShellCommand,closeWindow:()=>win.close(),editTarget}));
      await new Promise(resolve=>menu.popup({window:win,x,y,callback:resolve}));
      return null;
    });
    handle('getTerminalState',()=>desktopTerminal.snapshot());
    handle('readTerminal',id=>desktopTerminal.read(id));
    handle('readNativeText',()=>clipboard.readText().slice(0,65536));
    handle('terminalAction',async(action,value)=>{
      if(exitStarted)throw new Error('桌面端正在退出。');
      switch(action) {
        case 'create':await desktopTerminal.create(value);break;
        case 'write':desktopTerminal.write(value);break;
        case 'resize':desktopTerminal.resize(value);break;
        case 'activate':desktopTerminal.activate(value);break;
        case 'close':await desktopTerminal.close(value);break;
        default:throw new Error('未知终端操作。');
      }
      return desktopTerminal.snapshot();
    });
    handle('getDesktopTools',()=>desktopTools.snapshot());
    handle('copyDesktopText',value=>{if(typeof value!=='string'||value.length>1024*1024)throw new Error('复制内容无效。');clipboard.writeText(value);return true;});
    handle('desktopAction',(action,value)=>{if(exitStarted)throw new Error('桌面端正在退出。');return desktopTools.perform(action,value);});
    handle('setBrowserView',value=>desktopTools.browser.setViewport(value));
    handle('getState',()=>publicState());handle('refresh',refresh);
    handle('changeChatSession',async(id)=>{
      if(id!==null && (typeof id!=='string' || !/^[0-9a-f-]{36}$/i.test(id)))throw new Error('会话标识无效。');
      if(!view || state.connection.status!=='connected')throw new Error('请先连接 Loom。');
      const contents = view.webContents;
      const result = await changeLoomSession(contents,id);
      if(!result.ok)return result;
      if(view?.webContents!==contents || contents.isDestroyed())return {ok:false,message:'会话页面已变化，请重试。'};
      viewRevision++;
      const next=chatViews.get(result.sessionId);
      if(next && !next.webContents.isDestroyed()) {
        view.setVisible(false);
        view=next;
        state.messageQueue=null;
        clearInterval(composerTimer);composerTimer=null;composerRevision++;
        Object.assign(state.connection,chatViewStatus.get(next));
        state.chatSessions=await next.webContents.executeJavaScript('globalThis.__beingDesktopSessions.list()');
        await Promise.all([applyContentTypography(next.webContents,state.settings.typography),applyContentColors(next.webContents,state.settings.colors)]);
        mountView();
        if(state.connection.status==='connected')void mountComposer(next.webContents,generation).catch(()=>{});
      } else {
        state.connection.status='connecting';state.connection.error='';
        createLoom(result.sessionId,true);
      }
      broadcast();
      return {ok:true};
    });
    handle('getModelConfig',async()=>publishModelConfig(await modelConfig.get()));
    handle('saveModelConfig',async value=>{
      modelConfigRevision++;
      const result=publishModelConfig(await modelConfig.save(value));
      activity('info','模型配置已保存','已重新读取 Being 配置并确认变更。');
      return result;
    });
    handle('getTownCatalog',()=>getTownCatalog());
    handle('getFeatureTasks',(options={})=>({tasks:featureHistory.ledger.list(options),persistenceError:featureHistory.persistenceError}));
    handle('getFeatureTask',id=>featureHistory.ledger.get(id));
    handle('endFeatureTaskTracking',id=>{
      if(typeof id!=='string'||id.length>128)throw new Error('请选择有效的功能任务。');
      const task=featureHistory.ledger.get(id);
      if(!task)throw new Error('任务不存在或身份已变化。');
      const reading=task.status==='running'&&task.requestId&&task.execution==='being'&&['bonfire','fireside','scroll'].includes(task.feature);
      if(!['waiting','needs_input'].includes(task.status)&&!reading)throw new Error('只能结束读取、等待中或待处理任务的本地跟踪。');
      const result=featureHistory.ledger.cancel(id,{detail:'本地跟踪已结束；这不会取消 Being 端的执行。'});
      beingTownReader.stopTracking(task.requestId);
      return result;
    });
    handle('discussFeatureTask',id=>discussFeatureTask(id,{getLedger:()=>featureHistory.ledger,getContext:()=>({connection,generation,revision:viewRevision,view,configured:state.connection.configured,status:state.connection.status,exiting:exitStarted})}));
    handle('openTownPage',id=>browserLinks().open(townPageUrl(id)));
    handle('prepareTownFeature',(id)=>prepareTownFeature(id,()=>({connection,generation,revision:viewRevision,view,configured:state.connection.configured,status:state.connection.status,exiting:exitStarted})));
    handle('prepareTownAssistance',(value)=>prepareTownAssistance(value,()=>({connection,generation,revision:viewRevision,view,configured:state.connection.configured,status:state.connection.status,exiting:exitStarted})));
    handle('prepareFiresideDraft',(value)=>prepareFiresideDraft(value,()=>({connection,generation,revision:viewRevision,view,configured:state.connection.configured,status:state.connection.status,exiting:exitStarted})));
    handle('getTownAppState',()=>townState());
    handle('refreshTownApp',async()=>{await town.refresh();return townState();});
    handle('getTownCachedData',value=>townCachedReads.snapshot(value));
    handle('getBeingMembers',()=>townCachedReads.read('getBeingMembers',undefined,()=>townSession.getMembers()));
    handle('listScrolls',value=>townCachedReads.read('listScrolls',value,query=>townSession.listScrolls(query)));
    handle('getScroll',value=>townCachedReads.read('getScroll',value,query=>townSession.getScroll(query)));
    handle('listBeings',value=>townCachedReads.read('listBeings',value,query=>townSession.listBeings(query)));
    handle('getBonfireMessages',value=>sbsTownResults.readSnapshot({kind:'bonfire',limit:value?.limit||10}));
    handle('getTownMessageSnapshot',async value=>{if(value?.kind==='fireside')await loadCachedFiresides();return townBackground.cachedSnapshot(value);});
    handle('refreshTownMessages',value=>townBackground.refresh(value));
    handle('requestTownRead',async value=>{
      if(!value||Object.getPrototypeOf(value)!==Object.prototype||!['bonfire','fireside'].includes(value.kind)||Object.keys(value).some(key=>!['kind','firesideId','selectionRevision','includeRooms'].includes(key)))throw Object.assign(new Error('请选择有效的消息来源。'),{code:'INVALID_REQUEST'});
      if(Object.hasOwn(value,'selectionRevision')&&(value.kind!=='fireside'||!Number.isSafeInteger(value.selectionRevision)||value.selectionRevision<0))throw Object.assign(new Error('请选择有效的消息来源。'),{code:'INVALID_REQUEST'});
      if(Object.hasOwn(value,'includeRooms')&&(value.kind!=='fireside'||typeof value.includeRooms!=='boolean'))throw Object.assign(new Error('请选择有效的消息来源。'),{code:'INVALID_REQUEST'});
      const revision=generation,identity=identityRevision;
      const current=()=>{if(revision!==generation||identity!==identityRevision)throw Object.assign(new Error('Being 连接已变化。'),{code:'SESSION_CHANGED'});};
      if(value.kind==='fireside'&&(!value.firesideId||value.includeRooms)){
        const rooms=await townCachedReads.read('getFiresides',undefined,()=>townSession.getFiresides());current();
        townRoomCache={...rooms,cached:true,lastSuccessAt:Date.now()};townBackground.reconcileRooms(rooms);
        if(!value.firesideId)return {rooms:structuredClone(townRoomCache)};
        if(![...rooms.owned,...rooms.joined].some(room=>String(room.id)===value.firesideId))return {rooms:structuredClone(townRoomCache),removed:true};
      }
      const request={...value};delete request.selectionRevision;delete request.includeRooms;
      const result=await townBackground.requestRead(request);current();
      if(value.kind==='fireside'){
        const members=await townCachedReads.read('getFiresideMembers',value.firesideId,id=>townSession.getFiresideMembers(id));current();
        townMemberCache.set(value.firesideId,{...members,cached:true,lastSuccessAt:Date.now()});
        return {...result,members:structuredClone(townMemberCache.get(value.firesideId))};
      }
      return result;
    });
    handle('sendBonfireMessage',async value=>{
      const expectedGeneration=generation,expectedOnboarding=disk.onboarding;
      const receipt=await townSession.sendBonfireMessage(value);
      if(expectedOnboarding?.step!=='bonfire')return receipt;
      const completion=mutationTail.then(async()=>{
        const result=await completeOnboardingAfterBonfire(receipt,{
          settings:disk,configured:state.connection.configured,persist,
          isCurrent:()=>generation===expectedGeneration&&disk.onboarding===expectedOnboarding
        });
        if(result.onboarding){
          state.onboarding={...result.onboarding};
          try{broadcast();}catch{/* The saved progress remains available through the next state read. */}
        }
        return result;
      });
      mutationTail=completion.catch(()=>{});
      return completion;
    });
    handle('beginChannelConnection',value=>channelBeing.beginChannelConnection(value));
    handle('updateFeishuCredentials',value=>channelBeing.updateFeishuCredentials(value));
    handle('checkChannelStatus',value=>channelBeing.getChannelStatus(value));
    const publicTownFetch=(url,options)=>net.fetch(url,{...options,credentials:'omit',referrerPolicy:'no-referrer'});
    handle('getGroveCatalog',options=>townCachedReads.read('getGroveCatalog',options,query=>getGroveCatalog(query,{fetchImpl:publicTownFetch})));
    handle('getGroveDetail',id=>townCachedReads.read('getGroveDetail',id,key=>groveActions.detail(key)));
    handle('prepareGroveInstallation',value=>groveActions.prepare(value));
    handle('installGroveKit',value=>groveActions.install(value));
    handle('installEligibleGroveKits',value=>groveActions.installEligible(value));
    handle('prepareGroveAssistance',async value=>{
      const prompt=await groveActions.assistance(value);
      return prepareLoomDraft(prompt,()=>({connection,generation,revision:viewRevision,view,configured:state.connection.configured,status:state.connection.status,exiting:exitStarted}));
    });
    handle('getFiresides',()=>loadCachedFiresides());
    handle('getFiresideMessages',value=>sbsTownResults.readSnapshot({kind:'fireside',firesideId:value?.firesideId,limit:value?.limit||10}));
    handle('getFiresideMembers',value=>loadCachedFiresideMembers(value));
    for(const name of ['sendFiresideMessage','createFireside','joinFireside']) handle(name,requireTownIdentity);
    handle('getPortalPermissions',async()=>{
      const result=await inspectPortalPermissions(disk);
      return {permissions:result.permissions,revision:result.revision,configPath:disk.portalConfig};
    });
    handle('savePortalPermissions',async request=>{
      if(portalPermissionsBusy || exitStarted || town._deploying)throw new Error('Portal 正忙，请稍后重试。');
      normalizePortalPermissions(request?.permissions);
      portalPermissionsBusy=true;
      const identity=identityRevision;
      const configPath=disk.portalConfig;
      try {
        const current=await inspectPortalPermissions(disk);
        if(request?.configPath!==configPath || request?.revision!==current.revision)throw new Error('Portal 配置已变化，请重新读取后保存。');
        await portal.inspect();
        if(portal.state.status==='external' || portal.state.status==='error')throw new Error('请先在原启动位置停止 Portal，再保存权限。');
        const restart=portal.state.owned;
        if(restart)await portal.stop();
        if(exitStarted || identity!==identityRevision || configPath!==disk.portalConfig)throw new Error('连接或配置已变化，Portal 已停止，请重新读取权限。');
        await savePortalPermissions({settings:disk,request,persist});
        let detail='权限已保存，下次启动 Portal 时生效。';
        if(restart) {
          try {
            if(exitStarted || identity!==identityRevision)throw new Error('Connection changed');
            const started=await startCurrentPortal(true);
            detail=started.status==='running'?'权限已保存，Portal 已重启，等待工具重新注册。':'权限已保存，Portal 尚未启动，请手动启动。';
          } catch {detail='权限已保存，但 Portal 重启失败，请手动启动。';}
        }
        activity('info','Portal 权限已保存',detail);
        broadcast();
        return {detail,state:publicState()};
      } finally {portalPermissionsBusy=false;}
    });
    handle('deployPortal',value=>{if(portalPermissionsBusy)throw new Error('Portal 权限正在保存，请稍后重试。');return town.deploy(value);});
    handle('checkPortalUpdates',async()=>{
      if(exitStarted)throw new Error('桌面端正在退出。');
      await portalUpdates.check({force:true});
      return publicState();
    });
    handle('openPortalUpdate',()=>{
      const url=portalUpdates.state().releaseUrl;
      if(!url || !/^https:\/\/github\.com\/d5z\/heart-portal\/releases\/tag\/v?\d+\.\d+\.\d+$/.test(url))throw new Error('请先检查 Portal 更新。');
      return browserLinks().open(url);
    });
    handle('connect',async(url)=>{await storeConnection(url);createLoom();activity('info','连接已保存','凭据已使用系统加密保存。');refresh();return publicState();});
    handle('disconnect',async()=>{
      const previous={credential:disk.credential,onboarding:disk.onboarding};
      disk.credential='';
      if(!state.onboarding.completed)disk.onboarding={step:'loom',completed:false};
      try{await persist();}catch(error){Object.assign(disk,previous);throw error;}
      state.onboarding={...disk.onboarding};
      desktopTools?.disconnectLink();channelBeing.reset();resetTownReader();generation++;identityRevision++;connection=null;discardView();await loadFeatureHistory();state.connection={configured:false,displayUrl:'',beingName:'',status:'disconnected',error:'',updatedAt:null};state.runtime=emptyRuntime();townSession.reset();syncTownLifecycle();activity('info','已断开桌面连接','Portal 与 Being 的后台运行状态未改变。');return publicState();
    });
    handle('reconnect',()=>{if(!connection)throw new Error('请先配置 Loom 连接。');channelBeing.reset();resetTownReader();generation++;state.connection.status='connecting';state.connection.error='';syncTownLifecycle();createLoom();broadcast();refresh();return publicState();});
    handle('selectWorkspace',async()=>{
      const result=await dialog.showOpenDialog(win,{title:'选择本地工作区',properties:['openDirectory']});
      if(result.canceled)return publicState();
      const selected=result.filePaths[0];
      const files=await safeListWorkspace(selected,'');
      disk.workspace=selected;await persist();state.workspace={path:selected,files};
      desktopTools?.changed();activity('info','工作区已选择','用于文件浏览与控制台起始目录；Portal 的实际权限仍以其配置为准。');return publicState();
    });
    handle('listWorkspace',async(relative='')=>{if(!state.workspace.path)return [];return safeListWorkspace(state.workspace.path,relative);});
    handle('openWorkspace',async()=>{if(!state.workspace.path)throw new Error('请先选择工作区。');const error=await shell.openPath(state.workspace.path);if(error)throw new Error('工作区无法打开。');return publicState();});
    handle('selectPortalExecutable',async()=>{if(portalPermissionsBusy)throw new Error('Portal 权限正在保存，请稍后重试。');const selected=await chooseFile('选择 heart-portal 可执行文件',process.platform==='win32'?['exe']:['*']);if(selected){portal.configure({executable:selected});disk.portalExecutable=selected;await persist();if(portalUpdateChecksEnabled)void portalUpdates.changed();activity('info','Portal 程序已选择','尚未启动或扩大工作区权限。');}return publicState();});
    handle('selectPortalConfig',async()=>{if(portalPermissionsBusy)throw new Error('Portal 权限正在保存，请稍后重试。');const selected=await chooseFile('选择已有 portal.toml 配置',['toml']);if(selected){portal.configure({configPath:selected});disk.portalConfig=selected;await persist();activity('info','Portal 配置已选择','启动时将使用该配置所定义的工作区和权限。');}return publicState();});
    handle('startPortal',async()=>{await startCurrentPortal();if(portalUpdateChecksEnabled)void portalUpdates.check({force:true});broadcast();return publicState();});
    handle('stopPortal',async()=>{if(portalPermissionsBusy)throw new Error('Portal 权限正在保存，请稍后重试。');await portal.stop();broadcast();return publicState();});
    handle('setView',({visible,bounds}={})=>{viewWanted=visible===true;if(bounds && ['x','y','width','height'].every(key=>Number.isFinite(bounds[key])))viewport={...bounds};mountView();});
    handle('minimize',()=>win.minimize());handle('maximize',()=>{if(win.isMaximized())win.unmaximize();else win.maximize();});handle('close',()=>win.close());
    handle('setCloseToTray',async(value)=>{if(typeof value!=='boolean')throw new Error('无效设置');disk.closeToTray=value;state.settings.closeToTray=value;await persist();broadcast();return publicState();});
    handle('setOnboardingStep',async(step)=>{
      state.onboarding=await saveOnboardingStep(step,{settings:disk,configured:state.connection.configured,persist});
      broadcast();return publicState();
    });
    handle('setTypography',async(value)=>{
      let typography;
      try { typography=validateTypography(value); } catch { throw new Error('请选择支持的阅读字号。'); }
      const previous=disk.typography;
      disk.typography=typography;
      try { await persist(); } catch { disk.typography=previous;throw new Error('字号设置未能保存，请重试。'); }
      state.settings.typography=typography;
      const targets=[win.webContents];
      if(view && !view.webContents.isDestroyed() && !view.webContents.isLoadingMainFrame()) targets.push(view.webContents);
      const applied=await Promise.allSettled(targets.map(contents=>applyContentTypography(contents,typography)));
      if(applied.some(result=>result.status==='rejected')) activity('warning','字号已保存','部分页面暂未应用字号，重新连接或打开桌面端后会恢复。');
      broadcast();return publicState();
    });
    handle('setColors',async(value)=>{
      const colors=await saveColors(value,{settings:disk,persist});
      state.settings.colors=colors;
      if(win && !win.isDestroyed()) win.setBackgroundColor(colors.background);
      if(view && !view.webContents.isDestroyed() && !view.webContents.isLoadingMainFrame()) {
        try { await applyContentColors(view.webContents,colors); }
        catch { activity('warning','配色已保存','对话页面暂未应用配色，重新连接后会恢复。'); }
      }
      broadcast();return publicState();
    });
    handle('exportDiagnostics',async()=>{
      const result=await dialog.showSaveDialog(win,{title:'导出脱敏诊断',defaultPath:'being-desktop-diagnostics.json',filters:[{name:'JSON',extensions:['json']}]});
      if(result.canceled)return null;
      await fs.writeFile(result.filePath,JSON.stringify(publicState(),null,2),'utf8');activity('info','诊断已导出','包含本机路径和连接状态，不含连接令牌或聊天内容。');return {exported:true};
    });
  }
  function trayIcon() {
    return path.join(__dirname, '../renderer/assets/being', process.platform === 'win32' ? 'being-icon.ico' : 'being-icon-32.png');
  }
  function showDesktopWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  function updateTray() {
    if(!tray)return;
    tray.setToolTip(`Being Desktop · ${state.runtime.model || '等待连接'}`);
    tray.setContextMenu(Menu.buildFromTemplate([{label:'打开 Being',click:showDesktopWindow},{type:'separator'},{label:'退出桌面端',click:()=>shutdown()}]));
  }
  async function shutdown() {
    if(exitStarted)return;exitStarted=true;
    channelBeing.reset();resetTownReader();
    townBackground.stop();
    clearInterval(refreshTimer);
    portalUpdates.stop();
    await mutationTail;
    try { await portal.dispose(); } catch {
      exitStarted=false;
      syncTownLifecycle();
      activity('error','Portal 尚未停止','桌面端保持打开，请检查 Portal 状态后重试停止。');
      showDesktopWindow();
      if(portalUpdateChecksEnabled)portalUpdates.start();
      refreshTimer=setInterval(refresh,15000);refreshTimer.unref();
      return;
    }
    try {
      desktopTools?.disconnectLink();
      const commandJobs=desktopTools?.console.snapshot().jobs || [];
      await Promise.all(commandJobs.filter(job=>['starting','running','stopping'].includes(job.status)).map(job=>desktopTools.console.stop(job.id)));
      await desktopTerminal?.dispose();await desktopTools?.dispose();
    } catch {exitStarted=false;syncTownLifecycle();activity('error','命令尚未停止','请在控制台停止运行中的命令后重试退出。');showDesktopWindow();if(portalUpdateChecksEnabled)portalUpdates.start();refreshTimer=setInterval(refresh,15000);refreshTimer.unref();return;}
    generation++;discardView();
    await Promise.all([bonfireCache.flush(),townDataCache.flush(),...[...openFeatureHistories].map(history=>history.flush())]);
    portalUpdateNotification?.close();
    if(tray)tray.destroy();
    quitCommitted=true;
    app.quit();
  }
  app.on('second-instance',showDesktopWindow);
  app.on('web-contents-created',(_event,contents)=>{
    contents.on('focus',()=>{
      if(win && !win.isDestroyed() && contents!==win.webContents
          && win.contentView.children.some(child=>child.webContents===contents && child.getVisible())) menuEditingContents=contents;
    });
  });
  app.on('before-quit',event=>{if(!quitCommitted){event.preventDefault();shutdown();}});
  app.on('window-all-closed',()=>{if(!exitStarted)shutdown();});
  app.whenReady().then(async()=>{
    const rendererRoot=path.resolve(__dirname,'../renderer');
    protocol.handle('being',request=>{
      try{return net.fetch(pathToFileURL(protocolFile(rendererRoot,request.url)).href);}catch{return new Response('Not found',{status:404});}
    });
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    await restore();
    win=new BrowserWindow({width:1440,height:940,minWidth:1000,minHeight:700,frame:false,backgroundColor:state.settings.colors.background,show:false,title:'Being Desktop',icon:path.join(__dirname,'../renderer/assets/being/being-icon.ico'),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
    win.removeMenu();
    desktopTools=new DesktopTools({WebContentsView,session,getWindow:()=>win,getConnection:()=>connection,getWorkspace:()=>state.workspace.path,
      onChange:toolsState=>{if(win && !win.isDestroyed())win.webContents.send('being:tools-state',toolsState);}});
    desktopTerminal=new DesktopTerminal({getWorkspace:()=>state.workspace.path,
      onChange:terminalState=>{if(win&&!win.isDestroyed())win.webContents.send('being:terminal-state',terminalState);},
      onData:chunk=>{if(win&&!win.isDestroyed())win.webContents.send('being:terminal-data',chunk);}});
    const shellLinks=browserLinks();
    win.webContents.setWindowOpenHandler(shellLinks.popup);
    win.webContents.on('will-navigate',(event,target)=>{
      event.preventDefault();
      shellLinks.tryOpen(typeof event.url==='string'?event.url:target);
    });
    win.on('resize',mountView);
    win.on('maximize',publishWindowState);
    win.on('unmaximize',publishWindowState);
    win.on('close',event=>{if(quitCommitted)return;event.preventDefault();if(exitStarted)return;if(state.settings.closeToTray && tray)win.hide();else shutdown();});
    registerIPC();
    tray=new Tray(trayIcon());tray.on('double-click',showDesktopWindow);updateTray();
    await win.loadURL('being://app/index.html');
    await applyContentTypography(win.webContents,state.settings.typography);
    if(connection)createLoom();
    win.show();refresh();refreshTimer=setInterval(refresh,15000);refreshTimer.unref();
    if(portalUpdateChecksEnabled)portalUpdates.start();
    powerMonitor.on('suspend',()=>{townSuspended=true;syncTownLifecycle();portalUpdates.stop();});
    powerMonitor.on('resume',()=>{townSuspended=false;syncTownLifecycle();if(portalUpdateChecksEnabled)portalUpdates.start();activity('info','电脑已唤醒','正在核对连接状态，不自动重发消息。');refresh();});
    if(!app.isPackaged && process.env.BEING_SCENARIOS==='1') {
      clearInterval(refreshTimer);
      const reportPath=path.join(app.getPath('userData'),'scenarios-report.json');
      let report;
      try {
        const {runDesktopScenarios}=require('../test/electron-scenarios.cjs');
        report=await runDesktopScenarios({app,win,getView:()=>view,getState:publicState,refresh});
      } catch(error) {
        report=error.scenarioReport || {passed:false,error:sanitizeText(error.message)};
      }
      await fs.mkdir(path.dirname(reportPath),{recursive:true});
      await fs.writeFile(reportPath+'.tmp',JSON.stringify(report,null,2));
      await fs.rename(reportPath+'.tmp',reportPath);
      await shutdown();
      return;
    }
    if(process.env.BEING_SMOKE_REPORT) await runSmoke();
  }).catch(error=>{
    const message=sanitizeText(error?.message || '启动失败');
    dialog.showErrorBox('Being Desktop 无法启动',message);shutdown();
  });
  async function runSmoke() {
    const reportPath=path.resolve(process.env.BEING_SMOKE_REPORT);
    // Keep diagnostic captures rendering when another application occludes them.
    // Normal application windows retain Electron's default background throttling.
    win.webContents.setBackgroundThrottling(false);
    if (view && !view.webContents.isDestroyed()) view.webContents.setBackgroundThrottling(false);
    if (win.isMinimized()) win.restore();
    win.showInactive();
    await fs.mkdir(path.dirname(reportPath),{recursive:true});
    await fs.writeFile(reportPath.replace(/\.json$/,'.checkpoint.json'),JSON.stringify({stage:'waiting-for-page'}));
    if(view && view.webContents.isLoading()) {
      await new Promise(resolve=>{
        const contents=view.webContents;
        const finish=()=>{clearTimeout(timer);contents.removeListener('did-stop-loading',finish);resolve();};
        const timer=setTimeout(finish,25000);
        contents.once('did-stop-loading',finish);
      });
    }
    const protectedCredential=connection?Boolean(disk.credential && safeStorage.decryptString(Buffer.from(disk.credential,'base64'))===connection.url && !disk.credential.includes(connection.url)):disk.credential==='';
    const report={runId:process.env.BEING_SMOKE_ID || crypto.randomUUID(),generatedAt:new Date().toISOString(),appVersion:app.getVersion(),shellLoaded:win.webContents.getURL()==='being://app/index.html',credentialsEncrypted:protectedCredential,isolatedLoom:view?{nodeIntegration:view.webContents.getLastWebPreferences().nodeIntegration,contextIsolation:view.webContents.getLastWebPreferences().contextIsolation,sandbox:view.webContents.getLastWebPreferences().sandbox,preload:view.webContents.getLastWebPreferences().preload || null}:null};
    await refresh();
    report.connection=state.connection;report.runtime=state.runtime;report.portal=portal.state;report.localProxy=state.localProxy;report.settingsTypography={...state.settings.typography};
    const rendererState=await win.webContents.executeJavaScript('window.beingDesktop.getState()');
    report.ipcStateMatches=rendererState.connection.displayUrl===state.connection.displayUrl && rendererState.runtime.model===state.runtime.model;
    report.desktopTools=await win.webContents.executeJavaScript(`(async()=>{
      const bridge=window.beingDesktop,tools=await bridge.getDesktopTools();
      return {bridgeAvailable:['desktopAction','setBrowserView','copyDesktopText'].every(name=>typeof bridge[name]==='function'),
        linkStatus:tools.link.status,tabCount:tools.browser.tabs.length,jobCount:tools.console.jobs.length,pendingCount:tools.requests.length};
    })()`);
    report.terminal=await win.webContents.executeJavaScript(`(async()=>{
      const bridge=window.beingDesktop,terminal=await bridge.getTerminalState();
      return {bridgeAvailable:['terminalAction','readTerminal','onTerminalData'].every(name=>typeof bridge[name]==='function'),sessionCount:terminal.sessions.length};
    })()`);
    report.shellTypography=await win.webContents.executeJavaScript(`(() => {
      const selectors=['body','.nav-button','.sidebar-brand-name','.town-feature-title','.town-feature-description','.sidebar-section-heading','button','input','code'];
      return selectors.map(selector=>{const el=document.querySelector(selector);if(!el)return {selector,present:false};const c=getComputedStyle(el);return {selector,present:true,fontFamily:c.fontFamily,fontSize:c.fontSize,lineHeight:c.lineHeight,fontWeight:c.fontWeight,letterSpacing:c.letterSpacing};});
    })()`);
    if (view && !view.webContents.isDestroyed()) {
      report.loomPresentation=await view.webContents.executeJavaScript(`(() => {
        const selectors=['#app','#messages','#input-area','#input-row','#input','#send-btn','#desktop-attach','.message.user .content','.message.being .content','.message .meta','.message .content table','.message .content th','.message .content td','.message .content pre','.message .content code','.field-input','.btn-sm','.toggle-group button'];
        return {theme:document.documentElement.dataset.beingDesktopTheme || '',forcedColors:matchMedia('(forced-colors: active)').matches,
          controls:selectors.map(selector=>{const el=document.querySelector(selector);if(!el)return {selector,present:false};const c=getComputedStyle(el);const r=el.getBoundingClientRect();return {selector,present:true,width:r.width,height:r.height,background:c.backgroundColor,color:c.color,border:c.border,outline:c.outline,borderRadius:c.borderRadius,display:c.display,fontFamily:c.fontFamily,fontSize:c.fontSize,lineHeight:c.lineHeight,fontWeight:c.fontWeight,letterSpacing:c.letterSpacing};}),
          messageCount:document.querySelectorAll('.message').length,documentOverflow:Math.max(0,document.documentElement.scrollWidth-innerWidth)};
      })()`);
    }
    await win.webContents.executeJavaScript('new Promise(resolve => { const timer=setTimeout(resolve,400); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); })); })');
    report.viewBounds=view?.getBounds() || null;
    report.viewVisible=view?.getVisible() || false;
    report.captureConditions={backgroundThrottlingDisabled:true,scope:'Diagnostic rendering only; not a background lifecycle guarantee.'};
    await fs.mkdir(path.dirname(reportPath),{recursive:true});
    await fs.writeFile(reportPath.replace(/\.json$/,'.checkpoint.json'),JSON.stringify({runId:report.runId,stage:'before-capture',windowVisible:win.isVisible(),viewVisible:report.viewVisible,viewBounds:report.viewBounds}));
    const capture = async (target, outputPath) => {
      let timer;
      try {
        const screenshot = await Promise.race([
          target.capturePage(undefined,{stayHidden:true,stayAwake:true}),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Capture did not complete')),5000);})
        ]);
        if (screenshot.isEmpty()) return false;
        await fs.writeFile(outputPath,screenshot.toPNG());
        return true;
      } catch { return false; }
      finally { clearTimeout(timer); }
    };
    report.shellCaptured=await capture(win,reportPath.replace(/\.json$/,'.png'));
    report.loomCaptured=false;
    if(view && !view.webContents.isDestroyed() && view.getVisible()) {
      report.loomCaptured=await capture(view.webContents,reportPath.replace(/\.json$/,'.loom.png'));
    }
    if (!app.isPackaged && process.env.BEING_UI_AUDIT === '1') {
      const {runUiAudit} = require('../test/ui-audit.cjs');
      report.uiAudit = await runUiAudit({win,getView:()=>view,reportDir:path.join(path.dirname(reportPath),'ui-audit')});
    }
    await fs.writeFile(reportPath+'.tmp',JSON.stringify(report,null,2));
    await fs.rename(reportPath+'.tmp',reportPath);
    if (!win.webContents.isDestroyed()) win.webContents.setBackgroundThrottling(true);
    if (view && !view.webContents.isDestroyed()) view.webContents.setBackgroundThrottling(true);
    if(process.env.BEING_SMOKE_EXIT==='1')await shutdown();
  }
}
