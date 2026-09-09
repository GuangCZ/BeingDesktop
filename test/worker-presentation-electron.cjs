'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
if(!process.versions.electron){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const child=require('node:child_process').spawn(require('electron'),[__filename],{env,windowsHide:true,stdio:'inherit'});
  child.on('error',error=>{console.error(error);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
}else{
  const {app,BrowserWindow,WebContentsView,session}=require('electron');
  const {DesktopBrowser}=require('../src/desktop-browser.cjs');
  const {WorkerPresentation}=require('../src/worker-presentation.cjs');
  app.setPath('userData',path.join(os.tmpdir(),'being-result-ui-'+require('node:crypto').randomUUID()));
  let win,browser,presentation,directory;
  const timer=setTimeout(()=>{console.error('Presentation UI fixture timed out');app.exit(1);},15000);
  app.whenReady().then(async()=>{
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'being-result-fixture-'));
    await fs.writeFile(path.join(directory,'index.html'),'<title>RESULT_FIXTURE</title><h1>Desktop result</h1><button id="test">Start</button><script type="module" src="app.js"></script>');
    await fs.writeFile(path.join(directory,'app.js'),'document.getElementById("test").onclick=()=>document.title="RESULT_INTERACTION_OK";');
    win=new BrowserWindow({show:false,width:900,height:700});
    browser=new DesktopBrowser({WebContentsView,session,getWindow:()=>win});
    presentation=new WorkerPresentation({browser,showBrowser:()=>browser.setViewport({visible:true,bounds:{x:0,y:0,width:900,height:700}})});
    const worker={id:'fixture',cwd:directory},value=await presentation.open(worker,{artifactPath:'index.html'});
    const contents=browser.tabs.get(value.tabId).view.webContents;
    if(contents.isLoading())await new Promise(resolve=>contents.once('did-stop-loading',resolve));
    assert.equal(contents.getTitle(),'RESULT_FIXTURE');assert.equal(presentation.describe(value).state,'loaded');assert.equal(presentation.describe(value).visible,true);
    await contents.executeJavaScript('document.getElementById("test").click()');
    assert.equal(await contents.executeJavaScript('document.title'),'RESULT_INTERACTION_OK');
    await presentation.open({...worker,presentation:value},{artifactPath:'index.html'});assert.equal(browser.snapshot().tabs.length,1);
    console.log('PASS: real DesktopBrowser loads and executes static result assets, displays its view, and reuses the result tab.');
  }).catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
    clearTimeout(timer);await presentation?.dispose();browser?.destroy();win?.destroy();
    if(directory)await fs.rm(directory,{recursive:true,force:true});app.exit(process.exitCode||0);
  });
}
