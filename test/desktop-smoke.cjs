'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');

async function runSmoke({app,win,getView,getState,refresh,shutdown,credentialsEncrypted}) {
    const view=getView();
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
    const protectedCredential=credentialsEncrypted();
    const report={runId:process.env.BEING_SMOKE_ID || crypto.randomUUID(),generatedAt:new Date().toISOString(),appVersion:app.getVersion(),shellLoaded:win.webContents.getURL()==='being://app/index.html',credentialsEncrypted:protectedCredential,isolatedLoom:view?{nodeIntegration:view.webContents.getLastWebPreferences().nodeIntegration,contextIsolation:view.webContents.getLastWebPreferences().contextIsolation,sandbox:view.webContents.getLastWebPreferences().sandbox,preload:view.webContents.getLastWebPreferences().preload || null}:null};
    await refresh();
    const state=getState();
    report.connection=state.connection;report.runtime=state.runtime;report.portal=state.portal;report.localProxy=state.localProxy;report.settingsTypography={...state.settings.typography};
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
      const {runUiAudit} = require('./ui-audit.cjs');
      report.uiAudit = await runUiAudit({win,getView:()=>view,reportDir:path.join(path.dirname(reportPath),'ui-audit')});
    }
    await fs.writeFile(reportPath+'.tmp',JSON.stringify(report,null,2));
    await fs.rename(reportPath+'.tmp',reportPath);
    if (!win.webContents.isDestroyed()) win.webContents.setBackgroundThrottling(true);
    if (view && !view.webContents.isDestroyed()) view.webContents.setBackgroundThrottling(true);
    if(process.env.BEING_SMOKE_EXIT==='1')await shutdown();
  }

module.exports={runSmoke};
